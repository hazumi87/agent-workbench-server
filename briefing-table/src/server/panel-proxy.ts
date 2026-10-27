/* ============================================================================
 * PANEL VIEW PROXY (the design notes §2.6) [ticket].
 *
 *   GET|HEAD|OPTIONS /api/rooms/:id/panels/:pid/frame[/<tail>][?query]
 *
 * OPTIONS is forwarded upstream unanswered (2026-09-29 fix, "the Assets panel
 * keeps flipping to red"): a sandboxed opaque-origin frame's fetch() is
 * cross-origin to this proxy, so any request with a non-simple header (e.g.
 * If-None-Match — room-assets perf/thumbs) makes the browser preflight with
 * OPTIONS before the real GET. A GET/HEAD-only gate here answered that
 * preflight itself with a bare 405 and no CORS headers, which fails the
 * preflight outright — the browser never attempts the real GET, and the
 * app's own OPTIONS handler (room-assets already had one) never sees the
 * request. Still read-only: OPTIONS carries no body upstream and every
 * other method still 405s.
 *
 * WHY. The room page reaches the viewer over Tailscale Serve https. A panel's
 * registered url (e.g. http://127.0.0.1:<port>/ for an app on the server) would
 * resolve on the VIEWER's machine, and any http:// tailnet url is mixed
 * content. So the room page frames `frameUrl` (this route), and the ENGINE
 * fetches the app from where the engine runs.
 *
 * MAPPING. `/frame` and `/frame/` fetch the registered url itself (the
 * request's query replaces its query when one is given). `/frame/<tail>`
 * fetches <tail> relative to the registered url's DIRECTORY, and can never
 * leave it: a tail resolving outside that directory (`..`, `%2e%2e`, `//host`)
 * is a 400. THE BODY IS NEVER REWRITTEN, so a panel app must use RELATIVE
 * links (`app.js`, `api/items`, never `/app.js` or an absolute URL); a
 * same-directory `Location` on a redirect is the one thing mapped back.
 *
 * FRAME TOKEN (`/frame/t/<token>/…`, the form `frameUrl` carries). A sandboxed
 * opaque-origin frame's own requests (its assets, its fetches, a
 * <meta http-equiv=refresh>) may not carry the SameSite=Lax cookie, so the
 * frame URL carries its own credential: HMAC(key, roomId|pid|expiry) + the
 * expiry, minted each time a projection is built for an AUTHENTICATED reader
 * (never stored). It grants GET/HEAD on that ONE panel's frame and nothing
 * else — it is checked by `frameByToken` (rooms.ts) ahead of the auth gate,
 * which answers only frame paths; every other route still needs the normal
 * credential. Expiry is QUANTISED to 6 h buckets (valid 6-12 h) so a
 * room.state push inside one bucket re-mints the SAME frameUrl and an open
 * panel is not reloaded on every seat change. Expired or forged -> 401 with a
 * tiny HTML page ("reload the room"); the room page's next projection carries
 * a fresh one. The HMAC key is random PER ENGINE PROCESS (in memory, never on
 * disk, not derived from the bearer — auth.bearerToken is for outbound installation
 * calls only): a restart invalidates every token, and the room.subscribe
 * snapshot a reconnecting room page receives carries fresh ones. Tokens are
 * never logged.
 *
 * SAFETY.
 *   - Reached below the auth gate (the same credential that reads the room)
 *     or with a valid frame token.
 *   - The caller's cookie / Authorization are NEVER forwarded; only a short
 *     list of content-negotiation and caching headers is.
 *   - The target is re-checked against the panel allow-list on EVERY request
 *     (config.json can change after registration) — refused = 403 field url.
 *   - Upstream Set-Cookie is dropped, as are its own CSP / X-Frame-Options /
 *     Referrer-Policy / HSTS; the response carries OURS:
 *       Content-Security-Policy: sandbox allow-forms allow-popups
 *         allow-popups-to-escape-sandbox [allow-scripts — only when the panel
 *         was registered with scripts:true]
 *       X-Frame-Options: SAMEORIGIN, Referrer-Policy: no-referrer.
 *     NEVER allow-same-origin: this response is same-origin with the room
 *     page, so a same-origin frame with scripts could act as the room page
 *     (with Owner's cookie). The CSP sandbox applies even if someone opens the
 *     frame URL top-level, which an iframe `sandbox` attribute cannot.
 *   - 10 s of upstream silence -> 502 {error}; a declared body over 20 MB ->
 *     502 before anything is sent; an undeclared body that grows past 20 MB
 *     mid-stream is cut off (the headers are already out, so a 502 is no
 *     longer possible).
 * ========================================================================== */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { checkPanelUrl } from '../engine/panel-url.ts';
import { sendJson } from './http-util.ts';

export const PROXY_TIMEOUT_MS = Number(process.env.HARBOR_WB_PANEL_PROXY_TIMEOUT_MS) || 10_000;
export const PROXY_BODY_MAX = 20 * 1024 * 1024;
/** A glTF binary (a 3D model the panel's viewer loads) may be larger: 96 MiB = 100,663,296 bytes. Matched in asset-studio's GLB_MAX.
 *  Only a response whose Content-Type is model/gltf-binary gets it; every other body keeps PROXY_BODY_MAX. */
export const PROXY_GLB_MAX = 96 * 1024 * 1024;
export const bodyMaxFor = (contentType: unknown): number => (typeof contentType === 'string' && /^model\/gltf-binary\b/i.test(contentType) ? PROXY_GLB_MAX : PROXY_BODY_MAX);

const FORWARD_REQUEST = [
  'accept',
  'accept-language',
  'accept-encoding',
  'if-none-match',
  'if-modified-since',
  'range',
  'cache-control',
  'user-agent',
  // A CORS preflight (OPTIONS) from a sandboxed opaque-origin frame carries
  // these instead of a real request's headers — forwarded so an upstream
  // that reflects them (room-assets' OPTIONS handler ignores them and
  // answers a fixed set; a future app might not) gets to see the real ask.
  'origin',
  'access-control-request-method',
  'access-control-request-headers',
];
const DROP_RESPONSE = new Set([
  'set-cookie',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'referrer-policy',
  'strict-transport-security',
  'alt-svc',
]);

/* ----------------------------------------------------------- frame token ---- */

const TOKEN_BUCKET_MS = 6 * 60 * 60 * 1000;
/* Per process, in memory: see the header. */
const frameKey: Buffer = randomBytes(32);

function sign(roomId: string, panelId: string, exp: number): string {
  return createHmac('sha256', frameKey).update(`${roomId}|${panelId}|${exp}`).digest('base64url');
}

/** `<expiry base36>.<hmac base64url>` for one panel, valid 6-12 h. */
export function mintFrameToken(roomId: string, panelId: string, now = Date.now()): string {
  const exp = (Math.floor(now / TOKEN_BUCKET_MS) + 2) * TOKEN_BUCKET_MS;
  return `${exp.toString(36)}.${sign(roomId, panelId, exp)}`;
}

export type TokenCheck = 'ok' | 'expired' | 'bad';
/** Signature first (constant time), THEN expiry: a forged token is 'bad'
 *  whatever expiry it claims. */
export function checkFrameToken(token: string, roomId: string, panelId: string, now = Date.now()): TokenCheck {
  const m = /^([0-9a-z]{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) {
    return 'bad';
  }
  const exp = parseInt(m[1], 36);
  const want = Buffer.from(sign(roomId, panelId, exp));
  const got = Buffer.from(m[2]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) {
    return 'bad';
  }
  return exp > now ? 'ok' : 'expired';
}

/** A frame path, split: room, panel (decoded), token (or null), and the RAW
 *  tail after the frame prefix. Null when `route` is not a frame path. */
export function parseFramePath(route: string): { roomId: string; panelId: string; token: string | null; prefix: string; tail: string } | null {
  const m = /^\/api\/rooms\/([^/]+)\/panels\/([^/]+)\/frame(?:\/t\/([^/]+))?(?:\/(.*))?$/.exec(route);
  if (!m) {
    return null;
  }
  const dec = (v: string): string => {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };
  const prefix = `/api/rooms/${m[1]}/panels/${m[2]}/frame/${m[3] ? `t/${m[3]}/` : ''}`;
  return { roomId: dec(m[1]), panelId: dec(m[2]), token: m[3] ?? null, prefix, tail: m[4] ?? '' };
}

/** What a room page frames for this panel, token included (trailing slash, so
 *  the app's relative links resolve under it). Minted per projection. */
export function frameUrlFor(roomId: string, panelId: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}/panels/${encodeURIComponent(panelId)}/frame/t/${mintFrameToken(roomId, panelId)}/`;
}

/** 401 for a token that is expired or not ours: a tiny page, since it lands
 *  inside a panel cell, telling the human the one thing that fixes it. */
export function tokenRefused(res: ServerResponse, why: 'expired' | 'bad'): void {
  res.writeHead(401, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': cspFor(false),
    'x-frame-options': 'SAMEORIGIN',
    'referrer-policy': 'no-referrer',
  });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>Panel</title><p style="font:14px sans-serif;opacity:.7">` +
      `${why === 'expired' ? 'This panel link has expired' : 'This panel link is not valid'} — reload the room.</p>`,
  );
}

export function cspFor(scripts: boolean): string {
  return `sandbox allow-forms allow-popups allow-popups-to-escape-sandbox${scripts ? ' allow-scripts' : ''}`;
}

/** The upstream URL for a raw (still percent-encoded) tail, or null when the
 *  tail would leave the registered url's directory. */
export function upstreamFor(registered: string, tail: string, search: string): URL | null {
  const base = new URL(registered);
  if (!tail) {
    const u = new URL(base.href);
    if (search) {
      u.search = search;
    }
    u.hash = '';
    return u;
  }
  const dir = new URL('./', base);
  let target: URL;
  try {
    target = new URL(dir.href + tail.replace(/^\/+/, ''));
  } catch {
    return null;
  }
  if (target.origin !== dir.origin || !target.pathname.startsWith(dir.pathname)) {
    return null;
  }
  target.search = search;
  target.hash = '';
  return target;
}

export interface FramePanel {
  id: string;
  room_id: string;
  url: string;
  scripts: boolean;
}

/** Answer one frame request. `tail` is the raw path after `/frame`. */
export function proxyFrame(
  req: IncomingMessage,
  res: ServerResponse,
  panel: FramePanel,
  tail: string,
  log: (l: string) => void,
  /** The frame prefix THIS request came in on (token included), for redirects. */
  prefix: string,
): void {
  const method = req.method ?? 'GET';
  /* OPTIONS is proxied upstream exactly like GET/HEAD — never answered here
   * directly — because it is the app's own call what to say: a sandboxed
   * opaque-origin frame's fetch() (e.g. room-assets' If-None-Match poll,
   * perf/thumbs) is cross-origin to this proxy and a non-simple request
   * header forces the browser to preflight with OPTIONS first. Before this,
   * that preflight met this proxy's own GET/HEAD-only gate and got a bare
   * 405 with no CORS headers — which fails the preflight outright, so the
   * browser never even attempts the real GET, and the app's own OPTIONS
   * handler (added for exactly this) was never reached to answer it. OPTIONS
   * is read-only by HTTP semantics and the target is already allow-listed,
   * so forwarding it costs nothing the GET path doesn't already risk; it
   * does NOT widen what a frame can do (still no POST/PUT/DELETE/etc, still
   * GET/HEAD only once a body is actually wanted). */
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    res.setHeader('allow', 'GET, HEAD, OPTIONS');
    sendJson(res, 405, { error: 'a panel frame is read-only (GET, HEAD, OPTIONS)', field: 'method' });
    return;
  }
  const qi = (req.url ?? '').indexOf('?');
  const search = qi >= 0 ? (req.url ?? '').slice(qi) : '';
  const target = upstreamFor(panel.url, tail, search);
  if (!target) {
    sendJson(res, 400, { error: "that path leaves the panel's directory", field: 'path' });
    return;
  }
  const allowed = checkPanelUrl(target.href);
  if (!allowed.ok) {
    sendJson(res, 403, { error: allowed.error, field: 'url' });
    return;
  }

  const headers: Record<string, string> = {};
  for (const h of FORWARD_REQUEST) {
    const v = req.headers[h];
    if (typeof v === 'string') {
      headers[h] = v;
    }
  }
  const fail = (status: number, error: string): void => {
    if (!res.headersSent) {
      sendJson(res, status, { error });
    } else {
      res.destroy();
    }
  };
  const doRequest = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const up = doRequest(target, { method, headers });
  up.setTimeout(PROXY_TIMEOUT_MS, () => up.destroy(Object.assign(new Error(`upstream silent for ${PROXY_TIMEOUT_MS} ms`), { code: 'TIMEOUT' })));
  up.on('error', (e) => {
    log(`panel ${panel.id} frame: upstream ${target.origin} failed: ${(e as Error).message}`);
    fail(502, `panel upstream failed: ${(e as Error).message}`);
  });
  // The VIEWER went away (res, not req: a GET's req 'close' fires once its empty body is read).
  res.on('close', () => {
    if (!res.writableFinished) {
      up.destroy();
    }
  });
  up.on('response', (upRes) => {
    const declared = Number(upRes.headers['content-length']);
    const bodyMax = bodyMaxFor(upRes.headers['content-type']);
    if (Number.isFinite(declared) && declared > bodyMax) {
      upRes.destroy();
      up.destroy();
      fail(502, `panel upstream body is ${declared} bytes (max ${bodyMax})`);
      return;
    }
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (v !== undefined && !DROP_RESPONSE.has(k)) {
        out[k] = v;
      }
    }
    if (typeof upRes.headers.location === 'string') {
      out.location = mapLocation(upRes.headers.location, target, panel, prefix);
    }
    out['content-security-policy'] = cspFor(panel.scripts);
    out['x-frame-options'] = 'SAMEORIGIN';
    out['referrer-policy'] = 'no-referrer';
    res.writeHead(upRes.statusCode ?? 502, out);
    let total = 0;
    upRes.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > bodyMax) {
        log(`panel ${panel.id} frame: body passed ${bodyMax} bytes mid-stream — cut off`);
        upRes.destroy();
        res.destroy();
        return;
      }
      if (!res.write(chunk)) {
        upRes.pause();
        res.once('drain', () => upRes.resume());
      }
    });
    upRes.on('end', () => res.end());
    upRes.on('error', () => res.destroy());
  });
  up.end();
}

/** A redirect inside the panel's directory maps back onto the frame path;
 *  anything else is passed through untouched. */
function mapLocation(location: string, target: URL, panel: FramePanel, prefix: string): string {
  try {
    const loc = new URL(location, target);
    const dir = new URL('./', new URL(panel.url));
    if (loc.origin === dir.origin && loc.pathname.startsWith(dir.pathname)) {
      return prefix + loc.pathname.slice(dir.pathname.length) + loc.search;
    }
  } catch {
    /* unparseable: pass through */
  }
  return location;
}
