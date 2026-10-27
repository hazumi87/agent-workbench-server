/**
 * WebAuthn passkeys (E15) — the Windows Hello / Face ID sign-in.
 *
 * WHY THIS IS MORE SECURE AND NOT MERELY QUICKER, because that is the reason
 * it exists rather than a slogan: the private key is generated inside the
 * machine's TPM (or an iPhone's Secure Enclave), never leaves it, and cannot be
 * exported even by the person who owns the laptop. The browser will only ever
 * sign a challenge for the ORIGIN that created the credential, so there is no
 * phishing surface — a lookalike page cannot ask for it and the user cannot
 * hand it over by mistake. What this store holds is a PUBLIC key; a stolen
 * `identity.db` yields nothing that can sign in. A password is the weaker
 * credential here, and it stays only as the fallback and the enrolment proof.
 *
 * THE LIBRARY IS IMPORTED LAZILY, exactly like argon2 in ./auth.ts and for one
 * more reason on top of that one: `@simplewebauthn/server` pulls the whole
 * `@peculiar` ASN.1/X.509 tree and took 3.9s to import on this machine, which
 * is a boot cost a host that does not use identity must not pay. (It is pure
 * JS — no native module, no prebuild to go missing — so the argon2 fragility
 * worry does not apply; the cost here is time, not breakage.)
 *
 * RP ID AND ORIGIN ARE DERIVED FROM THE REQUEST, never configured by default.
 * A passkey is bound to the hostname it was made on, so the engine must call
 * itself whatever the browser called it: `localhost` in tests,
 * `server.example.ts.net` behind Tailscale Serve. The scheme comes
 * from `x-forwarded-proto` the same way `auth.isSecureRequest` reads it,
 * because the hop behind Serve is plain http and a derived `http://` origin
 * would not match the `https://` the browser actually signed. Both are
 * env-overridable (`HARBOR_WB_WEBAUTHN_RPID`, `HARBOR_WB_WEBAUTHN_ORIGIN`) for
 * one specific reason: a mismatch here is TOTALLY OPAQUE at the browser — the
 * prompt simply never appears, or the assertion is refused with no hint which
 * of the two strings was wrong — so there has to be a lever that is not a code
 * change. `HARBOR_WB_WEBAUTHN_ORIGIN` takes a comma-separated list because one
 * engine is legitimately reached as more than one origin.
 */
import type { IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import * as store from './store.ts';
import { isSecureRequest } from './auth.ts';

type WebAuthnModule = typeof import('@simplewebauthn/server');
let lib: WebAuthnModule | null = null;

async function webauthn(): Promise<WebAuthnModule> {
  if (!lib) {
    lib = await import('@simplewebauthn/server');
  }
  return lib;
}

/** User-visible name in the Windows Hello / Face ID prompt. Not an identifier —
 *  the RP ID is. Kept generic because this identity outgrows this engine
 *  (contract §0 / E14 moves it to a shared service). */
export const RP_NAME = 'Homelab';

/** How long a challenge is good for. Long enough to find a fingerprint reader,
 *  short enough that a captured options response is not a standing invitation. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/* --- rp id and origin ------------------------------------------------------ */

function hostOf(req: IncomingMessage): string | null {
  /* `Host` FIRST and `x-forwarded-host` only as a fallback: Tailscale Serve
   * preserves the original Host, and Host is the value the browser's own
   * origin was built from. Neither is exploitable — a forged value can only
   * make verification FAIL, because a browser refuses to mint or assert a
   * credential for an RP ID that is not the page's own domain — but preferring
   * the one the client actually sent removes the question. */
  const host = String(req.headers.host ?? '').trim();
  if (host) {
    return host;
  }
  const fwd = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim();
  return fwd || null;
}

/** The domain a credential is bound to: hostname only, no port, no scheme.
 *  Null when the request carried no host at all — the one case where there is
 *  nothing to bind to and the route must refuse rather than guess. */
export function rpIdFor(req: IncomingMessage): string | null {
  const override = (process.env.HARBOR_WB_WEBAUTHN_RPID ?? '').trim();
  if (override) {
    return override;
  }
  const host = hostOf(req);
  if (!host) {
    return null;
  }
  return host
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
}

/** Every origin this request may legitimately have been signed at. An ARRAY
 *  because the library accepts one and the override may name several. */
export function originsFor(req: IncomingMessage): string[] {
  const override = (process.env.HARBOR_WB_WEBAUTHN_ORIGIN ?? '').trim();
  if (override) {
    return override
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  }
  const host = hostOf(req);
  if (!host) {
    return [];
  }
  return [`${isSecureRequest(req) ? 'https' : 'http'}://${host}`];
}

/* --- pending challenges ---------------------------------------------------- */

interface Pending {
  challenge: string;
  /** Set for ENROLMENT (the account that asked), null for SIGN-IN (nobody is
   *  signed in yet — the credential id in the assertion names the account). */
  userId: string | null;
  rpId: string;
  origins: string[];
  expiresAt: number;
}

/* IN MEMORY, not in the db, and the trade is deliberate: an engine restart
 * between "press the button" and "touch the sensor" costs one retry, where a
 * table would cost a write on every prompt plus a row that outlives its
 * meaning. Single-use — `take` deletes before it validates — so a captured
 * ticket cannot be replayed even inside the TTL. */
const pending = new Map<string, Pending>();

function sweep(): void {
  const now = Date.now();
  for (const [ticket, row] of pending) {
    if (row.expiresAt <= now) {
      pending.delete(ticket);
    }
  }
}

function keep(row: Omit<Pending, 'expiresAt'>): string {
  sweep();
  const ticket = randomBytes(18).toString('base64url');
  pending.set(ticket, { ...row, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return ticket;
}

function take(ticket: unknown): Pending | null {
  if (typeof ticket !== 'string' || !ticket) {
    return null;
  }
  const row = pending.get(ticket);
  pending.delete(ticket);
  if (!row || row.expiresAt <= Date.now()) {
    return null;
  }
  return row;
}

/** Tests only: how many challenges are outstanding. */
export function pendingCount(): number {
  sweep();
  return pending.size;
}

/* --- enrolment ------------------------------------------------------------- */

export interface Options {
  ok: true;
  ticket: string;
  options: unknown;
}
export interface Refused {
  ok: false;
  reason: string;
}

/**
 * Registration options for `navigator.credentials.create`.
 *
 * `authenticatorAttachment: 'platform'` is what makes this Windows Hello rather
 * than a USB key — the credential must live in THIS machine. `residentKey:
 * 'preferred'` asks for a discoverable credential so sign-in can start with no
 * username typed; 'required' would refuse an authenticator that cannot store
 * one, and preferring it costs nothing because the device-cookie path supplies
 * `allowCredentials` anyway. `userVerification: 'required'` is the PIN or the
 * fingerprint — without it the credential proves possession of the laptop and
 * nothing about who is sitting at it, which is the entire ask.
 */
export async function registrationOptions(
  req: IncomingMessage,
  account: store.Account,
): Promise<Options | Refused> {
  const rpId = rpIdFor(req);
  const origins = originsFor(req);
  if (!rpId || origins.length === 0) {
    return { ok: false, reason: 'This request carried no host, so there is nothing to bind a passkey to.' };
  }
  const { generateRegistrationOptions } = await webauthn();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpId,
    userName: account.username,
    userDisplayName: account.username,
    /* The account id, NOT a fresh random one. The user handle is what a
     * discoverable credential carries back, and re-minting it per enrolment
     * would make two passkeys on one account look like two accounts in the
     * browser's own passkey list. */
    userID: new TextEncoder().encode(account.id),
    attestationType: 'none',
    /* So the browser says "you already have one of these here" instead of
     * silently minting a second credential on the same authenticator. */
    excludeCredentials: store
      .listPasskeys(account.id)
      .filter((p) => p.revoked_at === null)
      .map((p) => ({ id: p.credential_id, transports: parseTransports(p.transports) ?? undefined })),
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'preferred',
      userVerification: 'required',
    },
  });
  return {
    ok: true,
    ticket: keep({ challenge: options.challenge, userId: account.id, rpId, origins }),
    options,
  };
}

export interface Registered {
  ok: true;
  passkey: store.PasskeyRow;
}

/* No `req` parameter, deliberately: the RP ID and origin this response must be
 * checked against are the ones the CHALLENGE was minted with, carried on the
 * pending row — not whatever the verifying request happens to claim. Reading
 * them from `req` again would let a second request with a different Host
 * decide what the first one was bound to. */
export async function register(
  account: store.Account,
  ticket: unknown,
  response: unknown,
  opts: { deviceId: string | null; label: string | null },
): Promise<Registered | Refused> {
  const p = take(ticket);
  if (!p) {
    return { ok: false, reason: 'That enrolment expired. Start again.' };
  }
  /* Bound to the account that ASKED. A ticket is single-use and unguessable,
   * so this is belt and braces — but the failure it prevents (one account's
   * challenge completing into another account's credential) is not one to
   * leave to the quality of a random string. */
  if (p.userId !== account.id) {
    return { ok: false, reason: 'That enrolment belongs to a different sign-in.' };
  }
  const { verifyRegistrationResponse } = await webauthn();
  let verified;
  try {
    verified = await verifyRegistrationResponse({
      response: response as never,
      expectedChallenge: p.challenge,
      expectedOrigin: p.origins,
      expectedRPID: p.rpId,
      requireUserVerification: true,
    });
  } catch (err) {
    /* The library THROWS on every malformed or mismatched response rather than
     * returning verified:false, so both shapes have to be handled or a bad
     * enrolment takes the request handler out (the 2026-07-07 handleAttach
     * lesson: anything that can fail on user input is caught locally). */
    return { ok: false, reason: `That passkey was not accepted (${(err as Error).message}).` };
  }
  if (!verified.verified || !verified.registrationInfo) {
    return { ok: false, reason: 'That passkey was not accepted.' };
  }
  const info = verified.registrationInfo;
  if (store.passkeyByCredentialId(info.credential.id)) {
    return { ok: false, reason: 'That passkey is already enrolled.' };
  }
  return {
    ok: true,
    passkey: store.createPasskey({
      userId: account.id,
      deviceId: opts.deviceId,
      credentialId: info.credential.id,
      publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
      counter: info.credential.counter,
      transports: info.credential.transports ?? null,
      aaguid: info.aaguid || null,
      label: opts.label,
    }),
  };
}

/* --- sign-in --------------------------------------------------------------- */

/**
 * Authentication options for `navigator.credentials.get`.
 *
 * `allow` narrows the prompt to the passkeys enrolled on THIS remembered
 * device when the browser arrives carrying a device cookie — the
 * first-sign-in-after-a-reboot case this feature was asked for, and it turns a
 * "pick an account" chooser into a straight Hello prompt. With no device
 * cookie it is left undefined, which is the discoverable flow: the browser
 * offers whatever it holds for this RP ID and the assertion names the account.
 */
export async function authenticationOptions(
  req: IncomingMessage,
  allow: store.PasskeyRow[],
): Promise<Options | Refused> {
  const rpId = rpIdFor(req);
  const origins = originsFor(req);
  if (!rpId || origins.length === 0) {
    return { ok: false, reason: 'This request carried no host, so there is no passkey domain to ask for.' };
  }
  const { generateAuthenticationOptions } = await webauthn();
  const options = await generateAuthenticationOptions({
    rpID: rpId,
    userVerification: 'required',
    allowCredentials:
      allow.length > 0
        ? allow.map((p) => ({ id: p.credential_id, transports: parseTransports(p.transports) ?? undefined }))
        : undefined,
  });
  return { ok: true, ticket: keep({ challenge: options.challenge, userId: null, rpId, origins }), options };
}

export interface Asserted {
  ok: true;
  account: store.Account;
  passkey: store.PasskeyRow;
}

/**
 * Verify an assertion and say WHICH account signed it.
 *
 * Every refusal returns the same sentence, for the same reason the password
 * form does: distinguishing "no such credential" from "revoked" from "bad
 * signature" tells a caller which passkeys this engine holds.
 */
export async function assert(ticket: unknown, response: unknown): Promise<Asserted | Refused> {
  const NO = { ok: false as const, reason: 'That passkey was not accepted.' };
  const p = take(ticket);
  if (!p) {
    return { ok: false, reason: 'That sign-in expired. Try again.' };
  }
  const credentialId = (response as { id?: unknown } | null)?.id;
  if (typeof credentialId !== 'string' || !credentialId) {
    return NO;
  }
  const row = store.passkeyByCredentialId(credentialId);
  if (!row || row.revoked_at !== null) {
    return NO;
  }
  const account = store.accountById(row.user_id);
  if (!account || account.disabled_at !== null) {
    return NO;
  }
  const { verifyAuthenticationResponse } = await webauthn();
  let verified;
  try {
    verified = await verifyAuthenticationResponse({
      response: response as never,
      expectedChallenge: p.challenge,
      expectedOrigin: p.origins,
      expectedRPID: p.rpId,
      requireUserVerification: true,
      credential: {
        id: row.credential_id,
        publicKey: new Uint8Array(Buffer.from(row.public_key, 'base64url')),
        counter: row.counter,
        transports: parseTransports(row.transports) ?? undefined,
      },
    });
  } catch {
    /* Includes the CLONE CHECK: the library throws when the authenticator's
     * own use counter did not advance past the one we banked, which is the
     * signature of a copied credential being replayed. Not a special case
     * here — a refusal is a refusal. */
    return NO;
  }
  if (!verified.verified) {
    return NO;
  }
  store.touchPasskey(row.id, verified.authenticationInfo.newCounter);
  return { ok: true, account, passkey: row };
}

/* --- shared ---------------------------------------------------------------- */

/** The transports column is an opaque JSON string (see store.ts). Anything
 *  that does not parse as an array of strings is treated as ABSENT rather than
 *  thrown: a transport hint is a UI nicety and must never be the thing that
 *  stops a sign-in. */
export function parseTransports(raw: string | null): string[] | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((t) => typeof t === 'string')) {
      return parsed;
    }
  } catch {
    /* fall through — an unreadable hint is no hint */
  }
  return null;
}
