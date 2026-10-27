/* ADD A SERVER, the engine's half (the design notes sections 5, 12-14): how the desktop app gets a REMEMBERED-DEVICE credential from this server after the
 * person has signed in on the server's OWN page, without the credential ever appearing in a URL.
 *
 *   GET  /api/node               unauthenticated, tiny: what a client needs to decide whether it can talk to this server (probe).
 *   GET  /handback/start         PKCE (S256) + state, OAuth's names. No full session yet -> through /login and back. With one -> a confirm page.
 *   POST /handback/approve       the person's click. Mints a ONE-TIME code (hashed, ~60 s, bound to the challenge, the account and the tailnet evidence) and
 *                                redirects to redirect_uri?code=&state= (QUERY, never the fragment).
 *   GET  /handback/done          the page the embedded window lands on (the main process catches the navigation); it shows nothing secret.
 *   POST /api/device/exchange    unauthenticated except for the code: {code, code_verifier}; answers by SETTING the device cookie, body {ok:true}.
 *   POST /api/device/revoke      the device revokes ITSELF (its cookie is the proof); the existing "forget this device" on /account stays.
 *
 * WHAT IS REFUSED, and why each is a line of code rather than a comment:
 *   - only a FULL credential session may start or approve (principal.via === 'session'): never a device token, an API token or the shared bearer, so a stolen
 *     device token cannot mint another;
 *   - an account that must change its password gets nothing (the 2026-09-15 hole: a temp code must not buy a permanent credential);
 *   - redirect_uri is exactly TWO forms: this server's own /handback/done, or http://127.0.0.1:<port>/handback (RFC 8252). localhost, [::1], another path, a userinfo
 *     part, a fragment: refused;
 *   - a code is burned on its FIRST presentation (right or wrong verifier): a guessed or stolen code gets one try;
 *   - the owner's optional setting HARBOR_WB_DEVICE_REFUSE_SHARED=1 refuses tagged and shared-in devices (default off: Tailscale is reach control, the password is the
 *     credential, design review [ref]).
 * Three outcomes on the evidence, never two: a key mismatch refuses; an unknown (no evidence) is not a mismatch. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as identity from './auth.ts';
import * as store from './store.ts';
import { evidenceFor } from './tailnet-evidence.ts';
import * as realmRoutes from './realm-routes.ts';

export const PROTOCOL_VERSION = 1;
export const HANDBACK_TTL_MS = (): number => (Number(process.env.HARBOR_WB_HANDBACK_TTL_MS) > 0 ? Number(process.env.HARBOR_WB_HANDBACK_TTL_MS) : 60_000);

export interface HandbackDeps {
  readBody(req: IncomingMessage): Promise<any>;
  sendJson(res: ServerResponse, status: number, body: unknown): void;
  log(...args: unknown[]): void;
  throttled(key: string): boolean;
  recordFailure(key: string): void;
  clearFailures(key: string): void;
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const sha256b64url = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64url');
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function page(res: ServerResponse, status: number, title: string, bodyHtml: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
    `<body style="font:16px system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem">${bodyHtml}</body>`);
}

function engineVersion(): string {
  return (process.env.HARBOR_WB_VERSION ?? '').trim() || '0.0.0';
}

/** GET /api/node: unauthenticated and tiny (the one named exception besides exchange). Nothing else: no flags, no brokers, no counts. */
function nodeInfo(): Record<string, unknown> {
  const authTypes: string[] = [];
  if (identity.enabled()) {
    authTypes.push('password', 'tailscale');
    if (realmRoutes.signInOffered()) authTypes.push('realm');
  }
  return {
    node: (process.env.HARBOR_WB_NODE ?? '').trim() || 'homebase',
    engineVersion: engineVersion(),
    protocolVersion: PROTOCOL_VERSION,
    mode: (process.env.HARBOR_WB_MODE ?? '').trim() === 'local' ? 'local' : 'server',
    authTypes,
  };
}

/** The request's own origin, as the browser sees it (Serve's forwarded scheme decides). */
function selfOrigin(req: IncomingMessage): string | null {
  const host = req.headers.host;
  if (!host) return null;
  return `${identity.isSecureRequest(req) ? 'https' : 'http'}://${host}`;
}

export type RedirectCheck = { ok: true; uri: string } | { ok: false };
/** EXACTLY two forms: this server's own /handback/done, or http://127.0.0.1:<port>/handback. Everything else is refused. */
export function checkRedirect(raw: unknown, req: IncomingMessage): RedirectCheck {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 300) return { ok: false };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false };
  }
  if (u.username || u.password || u.hash || u.search) return { ok: false };
  const own = selfOrigin(req);
  if (own && u.origin === own && u.pathname === '/handback/done') return { ok: true, uri: `${own}/handback/done` };
  if (u.protocol === 'http:' && u.hostname === '127.0.0.1' && /^[1-9]\d{0,4}$/.test(u.port) && Number(u.port) <= 65535 && u.pathname === '/handback' && raw === `http://127.0.0.1:${u.port}/handback`) {
    return { ok: true, uri: raw };
  }
  return { ok: false };
}

/** Where the code will go, in words a person can recognise a request they did not start by (design review [ref]). */
export function destinationWords(redirectUri: string): string {
  try {
    const u = new URL(redirectUri);
    if (u.hostname === '127.0.0.1') return `this computer's Workbench app (local port ${u.port})`;
  } catch {
    /* fall through */
  }
  return 'this window';
}

interface StartParams {
  redirectUri: string;
  state: string;
  challenge: string;
}
function startParams(get: (k: string) => string | null, req: IncomingMessage): StartParams | string {
  const redirect = checkRedirect(get('redirect_uri'), req);
  if (!redirect.ok) return 'redirect_uri is not one this server will send a sign-in to';
  const state = get('state') ?? '';
  if (!state || state.length > 128 || !/^[\x21-\x7e]+$/.test(state)) return 'state is missing or not plain text';
  const challenge = get('code_challenge') ?? '';
  if (get('code_challenge_method') !== 'S256' || challenge.length !== 43 || !B64URL.test(challenge)) return 'code_challenge must be an S256 challenge';
  return { redirectUri: redirect.uri, state, challenge };
}

/** Why this principal may not hand a credential back, or null. */
function refusalFor(principal: identity.Principal | null, req: IncomingMessage): string | null {
  if (!principal || principal.via !== 'session') return 'Sign in with your password or passkey here first.';
  if (principal.mustChangePassword) return 'Change your temporary password first, then connect the app.';
  if ((process.env.HARBOR_WB_DEVICE_REFUSE_SHARED ?? '').trim() === '1') {
    const seen = evidenceFor(req);
    if (seen.sharedIn === true || seen.tags.length > 0) return 'This server does not accept tagged or shared devices.';
  }
  return null;
}

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  principal: identity.Principal | null,
  deps: HandbackDeps,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const peer = (req.socket.remoteAddress ?? '').replace('::ffff:', '');

  if (pathname === '/api/node' && method === 'GET') {
    deps.sendJson(res, 200, nodeInfo());
    return true;
  }

  if (!identity.enabled()) return false;

  if (pathname === '/handback/done' && method === 'GET') {
    page(res, 200, 'Connected', '<h1>Connected</h1><p>You can close this window.</p>');
    return true;
  }

  if (pathname === '/handback/start' && method === 'GET') {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    const p = startParams((k) => q.get(k), req);
    if (typeof p === 'string') {
      page(res, 400, 'Cannot connect', `<h1>Cannot connect the app</h1><p>${esc(p)}.</p>`);
      return true;
    }
    if (!principal || principal.via !== 'session') {
      /* through the server's own sign-in page and back (the `next` the login already has) */
      res.writeHead(302, { location: `/login?next=${encodeURIComponent(req.url ?? '/handback/start')}` });
      res.end();
      return true;
    }
    const why = refusalFor(principal, req);
    if (why) {
      page(res, 403, 'Cannot connect', `<h1>Cannot connect the app</h1><p>${esc(why)}</p>`);
      return true;
    }
    page(
      res,
      200,
      'Connect the app',
      `<h1>Connect the app</h1><p>Sign the Workbench app on this computer in to this server as <b>${esc(principal.username)}</b>?</p>` +
        `<p>The sign-in will go to <b>${esc(destinationWords(p.redirectUri))}</b>. If you did not just start this from the Workbench app, close this page.</p>` +
        `<form method="post" action="/handback/approve">` +
        `<input type="hidden" name="redirect_uri" value="${esc(p.redirectUri)}"><input type="hidden" name="state" value="${esc(p.state)}">` +
        `<input type="hidden" name="code_challenge" value="${esc(p.challenge)}"><input type="hidden" name="code_challenge_method" value="S256">` +
        `<button type="submit" style="font-size:1rem;padding:.6rem 1.2rem">Connect</button></form>` +
        `<p><a href="${esc(p.redirectUri)}?error=access_denied&amp;state=${encodeURIComponent(p.state)}">Cancel</a></p>`,
    );
    return true;
  }

  if (pathname === '/handback/approve' && method === 'POST') {
    const origin = req.headers.origin;
    if (origin) {
      let same = false;
      try {
        same = new URL(String(origin)).hostname.toLowerCase() === String(req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
      } catch {
        same = false;
      }
      if (!same) {
        deps.sendJson(res, 403, { error: 'cross-site request refused' });
        return true;
      }
    }
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 4096) break;
    }
    const form = new URLSearchParams(raw);
    const p = startParams((k) => form.get(k), req);
    if (typeof p === 'string') {
      page(res, 400, 'Cannot connect', `<h1>Cannot connect the app</h1><p>${esc(p)}.</p>`);
      return true;
    }
    const why = refusalFor(principal, req);
    if (why || !principal) {
      page(res, 403, 'Cannot connect', `<h1>Cannot connect the app</h1><p>${esc(why ?? 'Sign in first.')}</p>`);
      return true;
    }
    const seen = evidenceFor(req);
    const code = randomBytes(32).toString('base64url');
    store.createHandbackCode({
      code,
      userId: principal.userId,
      challenge: p.challenge,
      node: seen.node,
      nodeKey: seen.key,
      nodeIp: seen.ip,
      label: seen.label,
      ttlMs: HANDBACK_TTL_MS(),
    });
    deps.log(`handback: code issued for ${principal.username} (${seen.kind})`);
    res.writeHead(303, { location: `${p.redirectUri}?code=${code}&state=${encodeURIComponent(p.state)}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end();
    return true;
  }

  if (pathname === '/api/device/exchange' && method === 'POST') {
    const seen = evidenceFor(req);
    const key = `exchange:${seen.key ?? peer}`;
    if (deps.throttled(key)) {
      deps.sendJson(res, 429, { error: 'too many attempts; wait a few minutes' });
      return true;
    }
    let b: any = null;
    try {
      b = await deps.readBody(req);
    } catch {
      b = null;
    }
    const code = typeof b?.code === 'string' ? b.code : '';
    const verifier = typeof b?.code_verifier === 'string' ? b.code_verifier : '';
    const fail = (why: string): true => {
      deps.recordFailure(key);
      deps.log(`handback: exchange refused (${why})`);
      deps.sendJson(res, 400, { error: 'invalid_grant' }); // one answer for every reason: nothing to learn from it
      return true;
    };
    if (!B64URL.test(code) || code.length !== 43 || !B64URL.test(verifier) || verifier.length < 43 || verifier.length > 128) return fail('shape');
    const row = store.takeHandbackCode(code); // burned here, right or wrong from now on
    if (!row) return fail('unknown, used or expired');
    const want = Buffer.from(row.challenge);
    const got = Buffer.from(sha256b64url(verifier));
    if (want.length !== got.length || !timingSafeEqual(want, got)) return fail('verifier');
    if (row.node_key && seen.key && row.node_key !== seen.key) return fail('evidence mismatch');
    const account = store.accountById(row.user_id);
    if (!account || account.disabled_at !== null || account.must_change_password === 1) return fail('account');
    const token = store.mintToken();
    store.createDevice({
      userId: account.id,
      token,
      label: row.label ?? seen.label,
      tailnetNode: row.node ?? seen.node,
      tailnetIp: row.node_ip ?? seen.ip,
      tailnetKey: row.node_key ?? seen.key,
    });
    deps.clearFailures(key);
    deps.log(`handback: device minted for ${account.username}`);
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'set-cookie': identity.deviceCookie(token, identity.isSecureRequest(req)),
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (pathname === '/api/device/revoke' && method === 'POST') {
    const token = identity.cookiesOf(req)[identity.DEVICE_COOKIE];
    const row = token ? store.deviceByToken(token) : null;
    if (!row || row.revoked_at !== null) {
      deps.sendJson(res, 401, { error: 'unauthenticated' });
      return true;
    }
    store.revokeDevice(row.id, row.user_id);
    deps.log(`handback: device revoked by itself (${row.label ?? row.id})`);
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': identity.clearCookie(identity.DEVICE_COOKIE, identity.isSecureRequest(req)) });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  return false;
}
