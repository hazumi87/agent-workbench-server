/* THE ORIGIN GUARD (security review H5): a page on any other origin must not be able to make this engine act, either by a state-changing request or by opening a socket. One guard,
 * run before routing on every POST/PUT/PATCH/DELETE and on every WebSocket upgrade.
 *
 *  - An Origin that is neither the SAME origin (its host equals the request's Host) nor listed in HARBOR_WB_ALLOWED_ORIGINS (comma list of exact origins, for a proxy that rewrites Host)
 *    is refused, in EVERY mode. A browser always sends Origin on these; `Origin: null` is refused.
 *  - No Origin and `Sec-Fetch-Site: cross-site` is refused.
 *  - HOSTED (HARBOR_WB_HOSTED=1) adds two things for a COOKIE-authenticated request (a browser: no Authorization header): a missing Origin is refused, and a mutating request must be
 *    Content-Type application/json (so a text/plain "simple" form post cannot reach a JSON route), except the named UPLOAD routes below, which keep the Origin check.
 *  - A bearer-authenticated call (an agent, a script) is not a browser: it needs no Origin and no content type here.
 * Origin-match + SameSite=Lax cookies + JSON-only is the CSRF control; no separate token (see the design note to the design review, 2026-10-26). */
import type { IncomingMessage } from 'node:http';

/** Routes whose body is not JSON (raw bytes or multipart). They KEEP the Origin check. */
export const UPLOAD_ROUTES: readonly RegExp[] = [
  /^\/api\/rooms\/[^/]+\/(assets|scratch|files)(\/|$)/,
  /\/chat\/scratchpad(\/|$)/,
  /^\/api\/modules\/plugins(\/|$)/,
  /^\/login$/, // the sign-in form posts urlencoded and carries no session yet
];

/** Routes that enforce their OWN exact-Origin list (the desktop app's origin is legitimately cross-origin there), so the generic same-origin rule must not pre-empt them. */
export const OWN_ORIGIN_POLICY: readonly RegExp[] = [/^\/auth\/realm\/exchange$/, /^\/api\/terminal-grants$/, /^\/term$/];

export function isUploadRoute(pathname: string): boolean {
  return UPLOAD_ROUTES.some((re) => re.test(pathname));
}

export interface GuardResult {
  ok: boolean;
  status?: number;
  error?: string;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** HOSTED: the Host headers this engine answers to (DNS rebinding: a rebound name arrives with a matching Origin AND Host, so equality is not enough). From
 *  HARBOR_WB_ALLOWED_HOSTS (host or host:port, comma list), the hosts of HARBOR_WB_ALLOWED_ORIGINS and HARBOR_WB_WEBAUTHN_ORIGIN, and the loopback names on the bound port. */
export function allowedHosts(env: NodeJS.ProcessEnv = process.env, boundPort?: number): string[] {
  const out = new Set<string>();
  const add = (h: string): void => {
    const v = h.trim().toLowerCase();
    if (v) out.add(v);
  };
  (env.HARBOR_WB_ALLOWED_HOSTS ?? '').split(',').forEach(add);
  for (const o of [...allowedOrigins(env), ...(env.HARBOR_WB_WEBAUTHN_ORIGIN ?? '').split(',')]) {
    try {
      add(new URL(o.trim()).host);
    } catch {
      /* not a URL */
    }
  }
  if (boundPort) for (const n of ['localhost', '127.0.0.1', '[::1]']) add(`${n}:${boundPort}`);
  return [...out];
}
function hostListed(host: string | undefined, list: string[]): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  const bare = h.replace(/:\d+$/, '');
  return list.some((e) => e === h || (!/:\d+$/.test(e) && e === bare));
}

export function allowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.HARBOR_WB_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/\/+$/, ''))
    .filter(Boolean);
}

function originAllowed(origin: string, host: string | undefined, env: NodeJS.ProcessEnv, hostedList?: string[], fwdProto?: unknown): boolean {
  if (origin === 'null') return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  const norm = origin.toLowerCase().replace(/\/+$/, '');
  /* SCHEME IS PART OF THE ORIGIN: a configured origin for a host fixes the scheme for that host, so http://x configured does not admit https://x (and the reverse) */
  const configured = [...allowedOrigins(env), ...(env.HARBOR_WB_WEBAUTHN_ORIGIN ?? '').split(',').map((s) => s.trim().toLowerCase().replace(/\/+$/, '')).filter(Boolean)];
  const sameHost = configured.filter((c) => {
    try {
      return new URL(c).host === u.host.toLowerCase();
    } catch {
      return false;
    }
  });
  if (sameHost.length) return sameHost.includes(norm);
  if (allowedOrigins(env).includes(norm)) return true;
  const proto = String(fwdProto ?? '').split(',')[0].trim().toLowerCase();
  if (proto && `${proto}:` !== u.protocol) return false;
  /* hosted: same-origin means the origin's own host is one of the configured public hosts (scheme + host + port), not merely equal to whatever Host arrived */
  if (hostedList) return hostListed(u.host, hostedList) && !!host && u.host.toLowerCase() === host.toLowerCase();
  return !!host && u.host.toLowerCase() === host.toLowerCase();
}

export function checkOrigin(
  req: Pick<IncomingMessage, 'method' | 'headers' | 'url'>,
  opts: { upgrade?: boolean; hosted?: boolean; env?: NodeJS.ProcessEnv; boundPort?: number; extraOrigins?: readonly string[] } = {},
): GuardResult {
  const env = opts.env ?? process.env;
  const method = (req.method ?? 'GET').toUpperCase();
  const h = req.headers;
  const hostedList = opts.hosted ? allowedHosts(env, opts.boundPort) : undefined;
  /* HOSTED: a Host that is not one of ours is refused 421 on EVERY method and upgrade, before anything else (DNS rebinding) */
  if (hostedList && !hostListed(typeof h.host === 'string' ? h.host : undefined, hostedList)) {
    return { ok: false, status: 421, error: 'host-not-allowed' };
  }
  if (!opts.upgrade && !MUTATING.has(method)) return { ok: true };
  const origin = typeof h.origin === 'string' ? h.origin : undefined;
  if (!opts.hosted && OWN_ORIGIN_POLICY.some((re) => re.test((req.url ?? '/').split('?')[0]))) return { ok: true }; // the route checks its own exact Origin list
  const cookieOnly = !h.authorization && !!h.cookie;
  /* NOT hosted: a request that carries an Authorization header is not a CSRF vector (a page on another site cannot attach one without a preflight the engine never allows), and a desktop app calls a server engine with its own
     app:// origin and a bearer: it passes on its credential, as it did before this guard. (A websocket upgrade cannot carry the header from a browser, so it stays checked.) Hosted keeps checking the Origin of every call. */
  if (!opts.hosted && !opts.upgrade && h.authorization) return { ok: true };
  if (String(h['sec-fetch-site'] ?? '') === 'cross-site') {
    return { ok: false, status: 403, error: 'origin-not-allowed' }; // the browser says so itself, whatever Origin claims
  }
  if (origin !== undefined) {
    /* origins the supervisor named for this path (local mode: the desktop app's own origin on terminal grants and /term) */
    const named = (opts.extraOrigins ?? []).includes(origin);
    if (!named && !originAllowed(origin, typeof h.host === 'string' ? h.host : undefined, env, hostedList, h['x-forwarded-proto'])) {
      return { ok: false, status: 403, error: 'origin-not-allowed' };
    }
  } else if (opts.hosted && cookieOnly) {
    return { ok: false, status: 403, error: 'origin-required' };
  }
  if (opts.hosted && !opts.upgrade && cookieOnly) {
    const pathname = (req.url ?? '/').split('?')[0];
    const hasBody = Number(h['content-length'] ?? 0) > 0 || h['transfer-encoding'] !== undefined;
    const type = String(h['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (hasBody && !isUploadRoute(pathname) && type !== 'application/json') {
      return { ok: false, status: 415, error: 'json-required' };
    }
  }
  return { ok: true };
}
