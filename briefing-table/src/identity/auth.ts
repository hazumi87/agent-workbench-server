/**
 * Who is this request? (E13, contract §0.)
 *
 * The engine's existing `src/server/auth.ts` answers a yes/no question about
 * ONE shared secret. This answers "which user", which is the thing the rest of
 * the installation has to be able to ask — a token belongs to a USER, never to a
 * machine, so "a dev agent holding Owner's token sees exactly what Owner sees".
 *
 * THE SWITCH IS THE WHOLE SAFETY STORY. `HARBOR_WB_IDENTITY`:
 *   legacy (default) — identity never runs. No db file is opened, no route is
 *                      added, no check changes. Today's behaviour, byte for
 *                      byte, which is what lets this land on main mid-week.
 *   both             — accept an identity OR the shared token. The transition
 *                      state: Owner logs in as himself while every script, hook
 *                      and window that still holds the bearer keeps working.
 *   strict           — identity only. The shared token is dead.
 * Nothing flips the default; Owner does, in the service env, when he is ready.
 *
 * ARGON2 IS IMPORTED LAZILY, deliberately. It is a native module, and a static
 * import would mean a broken prebuild takes the whole engine down at boot on a
 * host that is not even using identity — the engine moves to the server this
 * month (the migration plan), so "it built here" is not a
 * guarantee about where it runs next.
 */
import type { IncomingMessage } from 'node:http';
import * as store from './store.ts';
import { evidenceFor, checkDevice, type EvidenceKind } from './tailnet-evidence.ts';

export const SESSION_COOKIE = 'homelab_session';
export const DEVICE_COOKIE = 'homelab_device';

export type Mode = 'legacy' | 'both' | 'strict';

export function mode(): Mode {
  const raw = (process.env.HARBOR_WB_IDENTITY ?? 'legacy').trim().toLowerCase();
  if (raw === 'both' || raw === 'strict') {
    return raw;
  }
  return 'legacy';
}

/** Is the identity layer live at all? Every entry point checks this FIRST, so
 *  legacy mode never touches the store and never creates the db file. */
export function enabled(): boolean {
  return mode() !== 'legacy';
}

/* --- password hashing ------------------------------------------------------ */

type Argon2 = {
  hash(plain: string): Promise<string>;
  verify(hash: string, plain: string): Promise<boolean>;
};
let argon: Argon2 | null = null;

async function argon2(): Promise<Argon2> {
  if (!argon) {
    const mod = await import('argon2');
    argon = (mod.default ?? mod) as unknown as Argon2;
  }
  return argon;
}

export async function hashPassword(plain: string): Promise<string> {
  return (await argon2()).hash(plain);
}

export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await (await argon2()).verify(storedHash, plain);
  } catch {
    // A malformed hash in the column must read as "wrong password", never as an
    // exception a caller might mistake for an infrastructure fault and retry.
    return false;
  }
}

/** A real argon2id hash of a value nobody holds, verified against when the
 *  username is unknown so the response time does not answer "does this account
 *  exist" — which is the whole of user enumeration on a login form. Computed
 *  once, lazily, so legacy mode never pays for it. */
let dummyHash: string | null = null;
async function burnTime(password: string): Promise<void> {
  if (!dummyHash) {
    dummyHash = await hashPassword(`no-such-account:${Math.random()}`);
  }
  await verifyPassword(dummyHash, password);
}

/* --- principals ------------------------------------------------------------ */

export type Via = 'api_token' | 'session' | 'device';

export interface Principal {
  userId: string;
  username: string;
  isAdmin: boolean;
  /** Carried on the principal so no route can be written that forgets to ask
   *  (kiosk's rule; see the forced-change gate in ./routes.ts). */
  mustChangePassword: boolean;
  via: Via;
  /** Present for `via === 'session'` — what a password change re-issues and
   *  what logout revokes. */
  sessionId: string | null;
  /** What the device presentation could prove. 'peer', 'serve-xff', or 'none'. */
  evidence: EvidenceKind | null;
  /** When the CREDENTIAL being presented right now (the token/session/device
   *  row, not the account) was created — epoch ms. Added for /identity/
   *  introspect's `since` field (the fabric wants to know how long a bearer
   *  has stood, not how old the account is). Null only if a future `via`
   *  forgets to pass it through `principalOf`. */
  credentialCreatedAt: number | null;
  /** The id of that same credential row (api token / session / device). The
   *  terminal grant binds to it (W3b, src/engine/term-grants.ts): a grant
   *  minted under one sign-in is refused on a socket opened under another.
   *  Optional so hand-built principals in tests need not name one. */
  credentialId?: string | null;
  /** The api token's own name (its `label`), for `via === 'api_token'` only;
   *  null otherwise. What the voice-actor scope keys on (room-voice §6.1). */
  credentialName: string | null;
}

export function cookiesOf(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
  }
  return out;
}

function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) {
    return null;
  }
  return header.slice(7).trim() || null;
}

/** Log sink — set by the server so refusals appear in the engine log with the
 *  same timestamp shape as everything else. Defaults to silence for the CLI and
 *  the unit tests. */
let logLine: (msg: string) => void = () => {};
export function setLogger(fn: (msg: string) => void): void {
  logLine = fn;
}

/**
 * RESOLUTION ORDER (contract §0 / E13 item 6), and the order is load-bearing:
 *   1. api_token bearer — a machine client said explicitly who it is.
 *   2. session cookie   — a human proved a password recently.
 *   3. device cookie    — a human proved a password ONCE, on this machine.
 *   4. anonymous.
 * The legacy shared secret is NOT resolved here, because it maps to no user;
 * it is a separate yes/no answered by `allowed()`.
 *
 * Strongest first matters: a laptop holding both a session and a device cookie
 * must resolve as the session, or a password change would not take effect
 * until the device cookie happened to expire.
 */
export function resolveIdentity(req: IncomingMessage): Principal | null {
  if (!enabled()) {
    return null;
  }

  const bearer = bearerOf(req);
  if (bearer) {
    const row = store.apiTokenByToken(bearer);
    if (row && row.revoked_at === null) {
      const account = store.accountById(row.user_id);
      if (account && account.disabled_at === null) {
        store.touchApiToken(row);
        return principalOf(account, 'api_token', null, null, row.created_at, row.label, row.id);
      }
    }
  }

  const jar = cookiesOf(req);

  const sessionToken = jar[SESSION_COOKIE];
  if (sessionToken) {
    const row = store.sessionByToken(sessionToken);
    if (row) {
      const account = store.accountById(row.user_id);
      /* FOUR independent reasons a session is dead, all checked here rather
       * than at call sites — a call site that forgets one is a hole:
       *   revoked · expired · account disabled · created BEFORE
       *   password_changed_at (the invalidation epoch). */
      const alive =
        !!account &&
        account.disabled_at === null &&
        row.revoked_at === null &&
        row.expires_at > Date.now() &&
        row.created_at >= account.password_changed_at;
      if (alive) {
        store.touchSession(row.id);
        return principalOf(account!, 'session', row.id, null, row.created_at, null, row.id);
      }
    }
  }

  const deviceToken = jar[DEVICE_COOKIE];
  if (deviceToken) {
    const row = store.deviceByToken(deviceToken);
    if (row && row.revoked_at === null) {
      const account = store.accountById(row.user_id);
      if (account && account.disabled_at === null) {
        const verdict = checkDevice(row, evidenceFor(req));
        if (!verdict.ok) {
          // One line, names only. This is the refusal Owner would need to
          // understand a locked-out laptop, and it is the only place it exists.
          logLine(`device REFUSED for ${account.username}: ${verdict.reason}`);
          return null;
        }
        store.touchDevice(row.id, verdict.evidence);
        return principalOf(account, 'device', null, verdict.evidence, row.created_at, null, row.id);
      }
    }
  }

  return null;
}

function principalOf(
  account: store.Account,
  via: Via,
  sessionId: string | null,
  evidence: EvidenceKind | null,
  credentialCreatedAt: number | null = null,
  credentialName: string | null = null,
  credentialId: string | null = null,
): Principal {
  return {
    userId: account.id,
    username: account.username,
    isAdmin: account.is_admin === 1,
    mustChangePassword: account.must_change_password === 1,
    via,
    sessionId,
    credentialCreatedAt,
    credentialName,
    credentialId,
    evidence,
  };
}

/**
 * THE VOICE ACTOR (the design notes §6.1, §6.3): the voice service presents a named api
 * token of Owner's account ("voice-svc", HARBOR_WB_VOICE_TOKEN_NAME). It
 * is Owner's token, so on its own it could do anything he can; the scope is
 * enforced HERE, by the credential, never by a prompt: it reaches
 * `/api/voice/*` and `/health` and nothing else (voiceScopeAllows, applied
 * once in the request path and on every WS upgrade).
 */
export function isVoiceActor(p: Principal | null): boolean {
  return !!p && p.via === 'api_token' && p.credentialName === voiceTokenName();
}

/** The voice actor's api token name (its `label`). */
export function voiceTokenName(): string {
  return (process.env.HARBOR_WB_VOICE_TOKEN_NAME ?? '').trim() || 'voice-svc';
}

export const VOICE_SCOPE_REFUSAL = 'voice credential is limited to /api/voice/*';

/** May the voice actor reach this path? A dot-dot segment (raw or
 *  percent-encoded) is refused outright rather than reasoned about. */
export function voiceScopeAllows(pathname: string): boolean {
  if (pathname === '/health') {
    return true;
  }
  return pathname.startsWith('/api/voice/') && !pathname.includes('..') && !/%2e/i.test(pathname);
}

/**
 * May this request act at all? The one place the mode decides.
 *
 * `legacyOk` is the existing `auth.authorized(req)` result, passed in rather
 * than imported so this module has no dependency on the shared-secret half —
 * which is the half that goes away.
 */
export function allowed(principal: Principal | null, legacyOk: boolean): boolean {
  switch (mode()) {
    case 'legacy':
      return legacyOk;
    case 'both':
      return principal !== null || legacyOk;
    case 'strict':
      return principal !== null;
  }
}

/* --- login ----------------------------------------------------------------- */

export interface LoginResult {
  ok: boolean;
  principal?: Principal;
  /** Shown to the browser once, as a cookie. Never stored. */
  sessionToken?: string;
  deviceToken?: string;
}

/**
 * Verify a username and password and open a session.
 *
 * An EXPIRED temporary credential is DEAD, not merely nagging: the expiry is
 * the entire reason a 39-bit code was allowed to be typeable at all. It is
 * refused with the same silence as a wrong password, because "that code has
 * expired" confirms it existed and names an account with one outstanding.
 */
export async function login(
  username: string,
  password: string,
  opts: { label: string | null; remember: boolean; req: IncomingMessage },
): Promise<LoginResult> {
  const account = store.accountByUsername(username ?? '');
  if (!account) {
    await burnTime(password ?? '');
    return { ok: false };
  }
  const good = await verifyPassword(account.password_hash, password ?? '');
  const expired = account.password_expires_at !== null && account.password_expires_at <= Date.now();
  if (!good || account.disabled_at !== null || expired) {
    return { ok: false };
  }

  return openSession(account, opts);
}

/**
 * Open a session for an account that has JUST PROVED ITSELF, and optionally
 * remember the device.
 *
 * Shared by the password form and the passkey assertion, which is the whole
 * point: a passkey sign-in is a full password-proof equivalent, so it must
 * mint the SAME session and be allowed to mint a remembered device on the
 * same terms. Two copies of this would be two chances for them to drift into
 * meaning different things, and the one that drifted would be the one nobody
 * looked at again.
 *
 * IT VERIFIES NOTHING. Every caller must have established WHO this is before
 * it gets here — that is stated loudly because a function that hands out a
 * session cookie and takes an account is one careless call away from being an
 * authentication bypass.
 */
function openSession(
  account: store.Account,
  opts: { label: string | null; remember: boolean; req: IncomingMessage; ttlMs?: number },
): LoginResult {
  const sessionToken = store.mintToken();
  const session = store.createSession(account.id, sessionToken, opts.label, opts.ttlMs);

  let deviceToken: string | undefined;
  /* NO REMEMBERED DEVICE FOR AN ACCOUNT THAT MUST CHANGE ITS PASSWORD (Add a server, design review [ref] condition 3; the same hole as the 2026-09-15 temp code that could
     mint a permanent api token). The session still opens, so the forced-change page is reachable; the permanent credential waits for a real password. */
  if (opts.remember && account.must_change_password !== 1) {
    /* A device token is minted ONLY here — immediately after a credential
     * proof, on the machine that gave it. That is what makes it a REMEMBERED
     * device rather than a second, longer-lived password: there is no path
     * that hands one out to a caller who has not just proved they are the
     * account. */
    const seen = evidenceFor(opts.req);
    deviceToken = store.mintToken();
    store.createDevice({
      userId: account.id,
      token: deviceToken,
      label: opts.label,
      tailnetNode: seen.node,
      tailnetIp: seen.ip,
      tailnetKey: seen.key,
    });
  }

  return {
    ok: true,
    principal: principalOf(account, 'session', session.id, null, session.created_at, null, session.id),
    sessionToken,
    deviceToken,
  };
}

/**
 * Sign in an account whose WebAuthn assertion has already been verified
 * (see ./passkey.ts — it is the module that decides an assertion is genuine
 * and which account signed it; this one only issues).
 *
 * NO PASSWORD EXPIRY CHECK, unlike the password path, and the asymmetry is
 * deliberate: `password_expires_at` is the TEMP CODE's expiry, and a lapsed
 * temp code is the reason the password path refuses. A passkey is a different
 * credential and does not go stale with it. In practice the case cannot arise
 * — enrolment is refused while `must_change_password` stands, so no account
 * can hold both a passkey and a live temp code — but the reasoning is written
 * down because the next person will ask why the two functions differ.
 */
export function loginWithPasskey(
  account: store.Account,
  opts: { label: string | null; remember: boolean; req: IncomingMessage },
): LoginResult {
  if (account.disabled_at !== null) {
    return { ok: false };
  }
  return openSession(account, opts);
}

/**
 * Sign in the engine account a VERIFIED realm identity is linked to (R6a; see
 * ./realm.ts for the verification, ./routes.ts for the link lookup). A plain
 * `session` principal with an 8 h ABSOLUTE life, and NEVER a remembered
 * device: a realm token alone does not make a machine trusted (platform item
 * 7). Engine roles stay the engine account's own.
 */
export function loginWithRealm(
  account: store.Account,
  opts: { label: string | null; req: IncomingMessage; ttlMs: number },
): LoginResult {
  if (account.disabled_at !== null) {
    return { ok: false };
  }
  return openSession(account, { label: opts.label, remember: false, req: opts.req, ttlMs: opts.ttlMs });
}

/* --- cookies --------------------------------------------------------------- */

/** Behind Tailscale Serve the hop to the engine is plain http, so the forwarded
 *  scheme decides the Secure flag — otherwise an https login sets a non-Secure
 *  cookie. Same rule as `server/auth.ts.isSecureRequest`, duplicated rather
 *  than imported so this module stays liftable into an identity service. */

/** A ticket redeemed in the browser becomes an IDENTITY session ONLY when it was minted FOR A PERSON: the requester was an identity session or device and its account id is stored in
 *  the ticket. A ticket minted for a bearer, a service or the engine itself carries no account and gets the legacy cookie (NOT a person): there is no "the one account" fallback,
 *  because anything holding the shared bearer can ask the engine to open a window and would otherwise receive that account's session (design review, 2026-10-26).
 *  An account that must change its password gets none. No remembered device is minted: a ticket is one window's session. */
export function sessionCookieForTicket(userId: string | null, secure: boolean): string | null {
  if (!enabled() || !userId) return null;
  const account = store.accountById(userId);
  if (!account || account.disabled_at !== null || account.must_change_password === 1) return null;
  const token = store.mintToken();
  store.createSession(account.id, token, 'engine-opened window');
  return sessionCookie(token, secure);
}

/** The person this request ALREADY is by a session or device COOKIE (never a bearer), or null. A ticket redeemed in a window that is already signed in keeps that sign-in
 *  instead of replacing it with a new one: one sign-in per browser profile, not one per window. */
export function personByCookie(req: IncomingMessage): Principal | null {
  if (!enabled()) return null;
  const p = resolveIdentity({ ...req, headers: { ...req.headers, authorization: undefined } } as IncomingMessage);
  return p && (p.via === 'session' || p.via === 'device') ? p : null;
}

export function isSecureRequest(req: IncomingMessage): boolean {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  return proto === 'https';
}

export function cookie(name: string, value: string, maxAgeMs: number, secure: boolean, path = '/'): string {
  const bits = [
    `${name}=${value}`,
    `Path=${path}`,
    'HttpOnly',
    'SameSite=Lax', // a cross-site POST never carries it; originOk is the second layer
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) {
    bits.push('Secure');
  }
  return bits.join('; ');
}

export function sessionCookie(token: string, secure: boolean, ttlMs: number = store.SESSION_TTL_MS): string {
  return cookie(SESSION_COOKIE, token, ttlMs, secure);
}

export function deviceCookie(token: string, secure: boolean): string {
  return cookie(DEVICE_COOKIE, token, store.DEVICE_TTL_MS, secure);
}

export function clearCookie(name: string, secure: boolean): string {
  return cookie(name, '', 0, secure);
}

/* --- password change ------------------------------------------------------- */

export interface ChangeResult {
  ok: boolean;
  reason?: string;
  sessionToken?: string;
}

/**
 * Change a password.
 *
 * REQUIRES THE CURRENT ONE even with a valid cookie (contract §0). A cookie
 * proves the browser was logged in at some point, not that the person at the
 * keyboard is the account holder — an unlocked laptop is the exact case this
 * rule exists for.
 *
 * Every OTHER session is revoked and the epoch bumped, then THIS browser is
 * re-issued in the same response. Without the re-issue, changing your password
 * logs you out of the page you changed it on, which reads as a failure.
 */
export async function changePassword(
  principal: Principal,
  current: string,
  next: string,
  label: string | null,
): Promise<ChangeResult> {
  const account = store.accountById(principal.userId);
  if (!account) {
    return { ok: false, reason: 'No such account.' };
  }
  if (!(await verifyPassword(account.password_hash, current ?? ''))) {
    return { ok: false, reason: 'That is not your current password.' };
  }
  const { validatePassword } = await import('./password-policy.ts');
  const verdict = validatePassword(next ?? '', { username: account.username });
  if (!verdict.ok) {
    return { ok: false, reason: verdict.reason };
  }
  if (next === current) {
    return { ok: false, reason: 'Pick a password you have not just used.' };
  }

  store.setPassword(account.id, await hashPassword(next), {
    mustChange: false,
    passwordExpiresAt: null, // a real password does not carry the temp expiry
  });
  store.revokeOtherSessions(account.id, principal.sessionId);
  /* The epoch just moved past every existing session, including this one if it
   * came from a device cookie or a bearer. Mint a fresh session so the caller
   * leaves this request holding a credential that is valid AFTER the change. */
  const token = store.mintToken();
  store.createSession(account.id, token, label);
  return { ok: true, sessionToken: token };
}
