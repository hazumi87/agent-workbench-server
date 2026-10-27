/**
 * R6a: sign in to the engine with the REALM account (room application [ref]/[ref],
 * platform [ref], toolkit [ref]).
 *
 * THE PRINCIPLE: a realm sign-in only MINTS AN ORDINARY ENGINE SESSION for the
 * engine account the realm identity is LINKED to. Nothing downstream changes:
 * the cookie, `humanCredential`, rooms, terminal grants, devices all see a
 * plain `via:'session'` principal. A realm token is never a bearer on a route.
 *
 * This file is the half that decides whether a realm JWT is genuine: one
 * PINNED issuer from config, its keys from its own JWKS (via discovery), RS/PS/
 * ES algorithms only (never `none`, never HS*), iss/aud/exp/nbf/iat with at
 * most 60 s of skew. It verifies with node:crypto — no JOSE dependency.
 *
 * Off unless HARBOR_WB_REALM_ISSUER is set (and identity is `both`/`strict`,
 * which ./routes.ts enforces by never being reached in legacy).
 *
 * Realm facts (platform [ref]), for whoever sets the env: issuer
 * `https://realm.example.com`, JWKS `https://realm.example.com/oidc/jwks`,
 * RS256, discovery at `<issuer>/.well-known/openid-configuration`, scopes
 * `openid email profile`. The engine is a CONFIDENTIAL client (secret read
 * from a FILE, never env, never logged) and still uses PKCE (S256).
 *
 * NEVER LOGS A TOKEN, a code, a secret or a ticket — reasons are fixed words.
 */
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify, constants, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Clock skew tolerated on exp / nbf / iat (platform item 1: <= 60 s). */
export const SKEW_S = 60;
/** Realm-born sessions live 8 h, absolute, never extended (platform item 6). */
export const REALM_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
/** Engine tickets (platform [ref]): at most 90 s of life, at most 30 s of
 *  skew, RS256 only. */
export const TICKET_MAX_LIFETIME_S = 90;
export const TICKET_SKEW_S = 30;
export const TICKET_ALG = 'RS256';
/**
 * THE ENGINE-TICKET MARKER — the one place it is defined. A ticket carries the
 * same `aud` (our client id) as an ID token, so without a marker an ID token
 * could be replayed at /auth/realm/exchange. BOTH are required ([ref]): the
 * JWT header `typ` AND the claim `purpose`. A token carrying a `nonce` (every
 * ID token from the code flow does) is refused as a ticket regardless, and a
 * token carrying EITHER marker is refused as an ID token.
 */
export const TICKET_MARKER = { typ: 'engine-ticket+jwt', purpose: 'engine-ticket' } as const;
/** The ticket claim naming the app's device (name not pinned yet, [ref]).
 *  Recorded on the minted session's label; never a trusted `device` row. */
export const TICKET_DEVICE_CLAIM = 'device_id';
/** The engine's callback route; the registered redirect URI ends in it. */
export const CALLBACK_PATH = '/auth/realm/callback';
/** Scopes the web login asks for. */
export const SCOPES = 'openid email profile';

/** How long fetched JWKS / discovery are used without asking again. */
const FRESH_MS = 60 * 60 * 1000;
/** How long a cached JWKS keeps verifying while the realm is unreachable
 *  (platform item 5: existing keys keep working through an outage). */
const GRACE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

const ALGS: Record<string, { kty: 'RSA' | 'EC'; hash: string; pss?: true; crv?: string }> = {
  RS256: { kty: 'RSA', hash: 'sha256' },
  RS384: { kty: 'RSA', hash: 'sha384' },
  RS512: { kty: 'RSA', hash: 'sha512' },
  PS256: { kty: 'RSA', hash: 'sha256', pss: true },
  PS384: { kty: 'RSA', hash: 'sha384', pss: true },
  PS512: { kty: 'RSA', hash: 'sha512', pss: true },
  ES256: { kty: 'EC', hash: 'sha256', crv: 'P-256' },
  ES384: { kty: 'EC', hash: 'sha384', crv: 'P-384' },
  ES512: { kty: 'EC', hash: 'sha512', crv: 'P-521' },
};

/* ---- config --------------------------------------------------------------- */

export interface RealmConfig {
  issuer: string;
  clientId: string;
  /** Path to the client secret file. Read on use, never cached in a log. */
  clientSecretFile: string;
  /** The ONE redirect URI, registered at the realm, matched exactly. */
  redirectUri: string;
  /** POST /auth/realm/exchange is on (HARBOR_WB_REALM_EXCHANGE=1). */
  exchange: boolean;
}

/** null when the feature is off (no issuer). Otherwise the config, or a
 *  `problem` naming the missing setting — a half-configured realm answers 503
 *  with that sentence rather than guessing. */
export function config(): { cfg: RealmConfig; problem: null } | { cfg: null; problem: string } | null {
  const issuer = (process.env.HARBOR_WB_REALM_ISSUER ?? '').trim().replace(/\/+$/, '');
  if (!issuer) {
    return null;
  }
  const clientId = (process.env.HARBOR_WB_REALM_CLIENT_ID ?? '').trim();
  const clientSecretFile = (process.env.HARBOR_WB_REALM_CLIENT_SECRET_FILE ?? '').trim();
  const redirectUri = (process.env.HARBOR_WB_REALM_REDIRECT_URI ?? '').trim();
  const missing = [
    !clientId && 'HARBOR_WB_REALM_CLIENT_ID',
    !clientSecretFile && 'HARBOR_WB_REALM_CLIENT_SECRET_FILE',
    !redirectUri && 'HARBOR_WB_REALM_REDIRECT_URI',
  ].filter(Boolean);
  if (missing.length) {
    return { cfg: null, problem: `realm sign-in is not fully configured (missing ${missing.join(', ')})` };
  }
  try {
    const u = new URL(issuer);
    const r = new URL(redirectUri);
    if (!/^https?:$/.test(u.protocol) || !/^https?:$/.test(r.protocol)) {
      throw new Error('scheme');
    }
    if (r.pathname !== CALLBACK_PATH || r.search || r.hash) {
      return { cfg: null, problem: `realm sign-in is misconfigured (the redirect URI must end in ${CALLBACK_PATH})` };
    }
  } catch {
    return { cfg: null, problem: 'realm sign-in is misconfigured (issuer or redirect URI is not an http(s) URL)' };
  }
  return {
    cfg: { issuer, clientId, clientSecretFile, redirectUri, exchange: process.env.HARBOR_WB_REALM_EXCHANGE === '1' },
    problem: null,
  };
}

export function clientSecret(cfg: RealmConfig): string {
  return readFileSync(cfg.clientSecretFile, 'utf8').trim();
}

/* ---- helpers -------------------------------------------------------------- */

export const b64u = (buf: Buffer): string => buf.toString('base64url');
export const randomToken = (): string => b64u(randomBytes(32));
export const pkceChallenge = (verifier: string): string => b64u(createHash('sha256').update(verifier).digest());

/** Fetch JSON with a timeout. Throws on network failure or a non-2xx. */
export type FetchJson = (url: string, init?: RequestInit) => Promise<any>;
export const fetchJson: FetchJson = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    throw Object.assign(new Error(`http ${res.status}`), { status: res.status });
  }
  return res.json();
};

const sameOrigin = (a: string, b: string): boolean => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

/* ---- the verifier --------------------------------------------------------- */

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface Key {
  kid: string;
  kty: string;
  crv?: string;
  alg?: string;
  key: KeyObject;
}

export type Verdict =
  | { ok: true; header: Record<string, unknown>; claims: Record<string, unknown> }
  | { ok: false; reason: string; unreachable?: true };

export interface VerifyOpts {
  audience: string;
  /** ID token: the nonce this flow sent. Required to match exactly. */
  nonce?: string;
  /** Engine ticket rules (marker, no nonce, jti, short life, single use). */
  ticket?: boolean;
}

export interface VerifierOpts {
  issuer: string;
  fetchJson?: FetchJson;
  now?: () => number;
  /** Least time between two JWKS refreshes caused by an unknown kid. */
  minRefreshMs?: number;
}

export function createVerifier(o: VerifierOpts) {
  const get = o.fetchJson ?? fetchJson;
  const now = o.now ?? Date.now;
  const minRefreshMs = o.minRefreshMs ?? 60_000;
  let disc: { doc: Discovery; at: number } | null = null;
  let jwks: { keys: Map<string, Key>; at: number } | null = null;
  let lastRefreshTry = -Infinity;
  /** Ticket jti -> exp (ms). Single use, kept until it could no longer verify. */
  const usedJti = new Map<string, number>();

  async function discovery(): Promise<Discovery> {
    if (disc && now() - disc.at < FRESH_MS) {
      return disc.doc;
    }
    try {
      const doc = (await get(`${o.issuer}/.well-known/openid-configuration`)) as Discovery;
      /* The pinned issuer must be the one the document names, and every
       * endpoint must live on the issuer's own origin: discovery is not
       * allowed to send us somewhere else for keys or codes. */
      if (
        !doc ||
        String(doc.issuer).replace(/\/+$/, '') !== o.issuer ||
        ![doc.authorization_endpoint, doc.token_endpoint, doc.jwks_uri].every(
          (u) => typeof u === 'string' && sameOrigin(u, o.issuer),
        )
      ) {
        throw new Error('discovery document does not match the pinned issuer');
      }
      disc = { doc, at: now() };
    } catch (e) {
      if (disc && now() - disc.at < GRACE_MS) {
        return disc.doc;
      }
      throw e;
    }
    return disc.doc;
  }

  async function loadKeys(): Promise<Map<string, Key>> {
    const d = await discovery();
    const body = await get(d.jwks_uri);
    const keys = new Map<string, Key>();
    for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
      if (!jwk || typeof jwk.kid !== 'string' || (jwk.use !== undefined && jwk.use !== 'sig')) {
        continue;
      }
      if (jwk.kty !== 'RSA' && jwk.kty !== 'EC') {
        continue; // never an `oct` (HMAC) key
      }
      try {
        const key = createPublicKey({ key: jwk, format: 'jwk' });
        keys.set(jwk.kid, { kid: jwk.kid, kty: jwk.kty, crv: jwk.crv, alg: jwk.alg, key });
      } catch {
        /* a key node cannot read is a key nobody can verify with */
      }
    }
    jwks = { keys, at: now() };
    return keys;
  }

  /** The key for `kid`: from cache when fresh; refreshed when stale or the kid
   *  is unknown; the stale cache keeps answering through an outage (grace). */
  async function keyFor(kid: string): Promise<{ key: Key | null; unreachable: boolean }> {
    const fresh = jwks && now() - jwks.at < FRESH_MS;
    if (fresh && jwks!.keys.has(kid)) {
      return { key: jwks!.keys.get(kid)!, unreachable: false };
    }
    /* Every refetch is gated, stale cache or not (platform [ref]): a stream of
       unknown kids, or a realm that is down, costs at most one fetch a minute. */
    const mayRefresh = now() - lastRefreshTry >= minRefreshMs;
    if (mayRefresh) {
      lastRefreshTry = now();
      try {
        const keys = await loadKeys();
        return { key: keys.get(kid) ?? null, unreachable: false };
      } catch {
        if (jwks && now() - jwks.at < GRACE_MS) {
          return { key: jwks.keys.get(kid) ?? null, unreachable: !jwks.keys.has(kid) };
        }
        return { key: null, unreachable: true };
      }
    }
    return { key: jwks?.keys.get(kid) ?? null, unreachable: false };
  }

  function sweepJti(): void {
    const t = now();
    for (const [jti, exp] of usedJti) {
      if (exp + TICKET_SKEW_S * 1000 < t) {
        usedJti.delete(jti);
      }
    }
  }

  async function verify(jwt: unknown, v: VerifyOpts): Promise<Verdict> {
    const no = (reason: string): Verdict => ({ ok: false, reason });
    if (typeof jwt !== 'string' || jwt.length > 16384) {
      return no('malformed');
    }
    const parts = jwt.split('.');
    if (parts.length !== 3) {
      return no('malformed');
    }
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      return no('malformed');
    }
    if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object' || Array.isArray(claims)) {
      return no('malformed');
    }
    const alg = typeof header.alg === 'string' ? ALGS[header.alg] : undefined;
    if (!alg || !Object.prototype.hasOwnProperty.call(ALGS, String(header.alg))) {
      return no('alg'); // `none`, HS*, EdDSA, anything unlisted
    }
    if (v.ticket && header.alg !== TICKET_ALG) {
      return no('alg');
    }
    if (header.crit !== undefined) {
      return no('crit');
    }
    if (typeof header.kid !== 'string' || !header.kid) {
      return no('kid');
    }
    const { key, unreachable } = await keyFor(header.kid);
    if (!key) {
      return unreachable ? { ok: false, reason: 'realm-unreachable', unreachable: true } : no('unknown-kid');
    }
    if (key.kty !== alg.kty || (alg.crv && key.crv !== alg.crv) || (key.alg && key.alg !== header.alg)) {
      return no('alg-key-mismatch');
    }
    const data = Buffer.from(`${parts[0]}.${parts[1]}`);
    const sig = Buffer.from(parts[2], 'base64url');
    let good = false;
    try {
      good = cryptoVerify(
        alg.hash,
        data,
        alg.kty === 'EC'
          ? { key: key.key, dsaEncoding: 'ieee-p1363' }
          : alg.pss
            ? { key: key.key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }
            : key.key,
        sig,
      );
    } catch {
      good = false;
    }
    if (!good) {
      return no('signature');
    }

    /* ---- claims ---- */
    if (claims.iss !== o.issuer) {
      return no('iss');
    }
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(v.audience)) {
      return no('aud');
    }
    if (aud.length > 1 && claims.azp !== v.audience) {
      return no('azp');
    }
    if (typeof claims.sub !== 'string' || !claims.sub) {
      return no('sub');
    }
    const t = now() / 1000;
    const skew = v.ticket ? TICKET_SKEW_S : SKEW_S;
    if (typeof claims.exp !== 'number' || t > claims.exp + skew) {
      return no('expired');
    }
    if (typeof claims.iat !== 'number' || claims.iat > t + skew) {
      return no('iat');
    }
    if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > t + skew)) {
      return no('nbf');
    }

    if (v.ticket) {
      if (header.typ !== TICKET_MARKER.typ || claims.purpose !== TICKET_MARKER.purpose) {
        return no('not-a-ticket');
      }
      if (claims.nonce !== undefined) {
        return no('ticket-has-nonce');
      }
      if (typeof claims.jti !== 'string' || !claims.jti || claims.jti.length > 256) {
        return no('jti');
      }
      if (claims.exp - claims.iat > TICKET_MAX_LIFETIME_S) {
        return no('lifetime');
      }
      const dev = claims[TICKET_DEVICE_CLAIM];
      /* Required (platform [ref]): a ticket is only minted behind the device
         proof, so one with no device id skipped it. */
      if (typeof dev !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(dev)) {
        return no('device-id');
      }
      /* Check-and-set with no await between them: atomic on one event loop.
       * Kept until exp + skew, after which the ticket could not verify anyway. */
      sweepJti();
      if (usedJti.has(claims.jti)) {
        return no('replay');
      }
      usedJti.set(claims.jti, claims.exp * 1000);
    } else {
      if (header.typ === TICKET_MARKER.typ || claims.purpose === TICKET_MARKER.purpose) {
        return no('ticket-as-id-token');
      }
      if (v.nonce !== undefined && claims.nonce !== v.nonce) {
        return no('nonce');
      }
    }
    return { ok: true, header, claims };
  }

  return { discovery, verify };
}

export type Verifier = ReturnType<typeof createVerifier>;
