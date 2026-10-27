/**
 * Access control for the engine (Phase B, the design notes).
 *
 * WHY THIS EXISTS AT ALL: this engine spawns shells on two machines. It is
 * remote code execution by design, so reaching it must not be the same as being
 * allowed to drive it. Tailscale decides which devices can reach the port; this
 * decides who may use it. Both are required — a tailnet is a network boundary,
 * not an identity one.
 *
 * ONE SECRET, TWO PRESENTATIONS:
 *   · machine clients (scripts, harbor, the future laptop exe) → `Authorization: Bearer <token>`
 *   · browsers → POST the token once at /login, get an HttpOnly cookie
 * The split is forced, not stylistic: a browser cannot attach an Authorization
 * header to a plain navigation, and the browser WebSocket API cannot set headers
 * AT ALL — which is the connection that matters most here. Cookies ride the WS
 * handshake on same-origin, so they are the only mechanism that covers both.
 *
 * NO LOOPBACK EXEMPTION — deliberate, and the subtle part. The engine binds
 * 127.0.0.1 and Tailscale Serve fronts it, which means every REMOTE request
 * also arrives from 127.0.0.1. "Trust loopback" would therefore not be a
 * convenience, it would be an open door wearing a local address. Local desktop
 * windows log in once like everything else and keep the cookie.
 *
 * The cookie stores a DERIVED value, not the token, so the raw secret never
 * sits in a browser jar.
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { instancePath } from '../engine/data-dir.ts';

const TOKEN_FILE = process.env.HARBOR_WB_TOKEN_FILE ?? instancePath('secrets', 'engine.token');

export const COOKIE = 'wb_auth';

/** Routes that answer without a token. `/health` stays open because harbor
 *  polls it and it carries no secrets; `/login` obviously must.
 *
 * `/vendor/aurora-logo-presets.js` is a FILE OF LOGO DRAWINGS, and it is public
 * because the shell in another process has to read it and cannot hold a
 * credential conveniently (2026-09-03). It was ALWAYS meant to be readable from
 * there — the static handler already stamps it `access-control-allow-origin: *`
 * with a comment saying so — and auth landing later broke that intent silently:
 * the toolkit's proxy fetched it with no header, got 401, swallowed the error
 * and served an empty module, so every tab has been wearing a hash-assigned
 * stock mark ever since. Same invisible-401 class as the claude hook.
 *
 * WHY THIS IS SAFE, precisely: it is READ-ONLY and returns nothing but SVG
 * artwork and the names the user gave it. It exposes no session, no transcript,
 * no table row, no path on disk, and reaches no shell — auth still guards every
 * one of those, unchanged. Scoped to this ONE asset; `/vendor/` as a whole is
 * NOT public. */
const PUBLIC = new Set([
  '/health',
  '/api/health',
  '/login',
  '/favicon.ico',
  '/favicon.svg',
  '/vendor/aurora-logo-presets.js',
]);

function loadOrCreateToken(): string {
  const fromEnv = process.env.HARBOR_WB_TOKEN?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  /* LOCAL MODE never mints a token or writes a token file: the supervisor's per-launch token is the only credential. */
  if ((process.env.HARBOR_WB_MODE ?? '').trim().toLowerCase() === 'local') {
    console.error('local mode cannot start: HARBOR_WB_TOKEN is not set (the per-launch token); local mode does not mint or store one');
    process.exit(78); // a configuration problem: the supervisor must not retry it
  }
  try {
    const existing = readFileSync(TOKEN_FILE, 'utf8').trim();
    if (existing) {
      return existing;
    }
  } catch {
    /* not created yet */
  }
  // First boot: mint one rather than shipping a default. A default token is a
  // published token.
  const minted = randomBytes(24).toString('base64url');
  try {
    mkdirSync(dirname(TOKEN_FILE), { recursive: true });
    writeFileSync(TOKEN_FILE, `${minted}\n`, { mode: 0o600 });
  } catch {
    /* read-only fs: the token still works for this run */
  }
  return minted;
}

const TOKEN = loadOrCreateToken();

/* THE WINDOW AGENT'S OWN CREDENTIAL (M9). A window agent (the desktop host that opens, focuses and closes windows, and READS transcripts) used to register with the shared engine
 * bearer, which every agent on the host can read: any of them could register as the window agent, replace the real one, and receive the one-time tickets the engine mints for
 * windows. It now presents its OWN token, accepted on /window-agent ONLY (never on any other route), minted on first boot into secrets/window-agent.token (mode 600) and handed
 * to the desktop host by whoever installs it. HARBOR_WB_WINDOW_AGENT_TOKEN overrides; local mode has no window agent and mints nothing. */
const WINDOW_AGENT_TOKEN_FILE = process.env.HARBOR_WB_WINDOW_AGENT_TOKEN_FILE ?? instancePath('secrets', 'window-agent.token');
function loadOrCreateWindowAgentToken(): string | null {
  const fromEnv = process.env.HARBOR_WB_WINDOW_AGENT_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if ((process.env.HARBOR_WB_MODE ?? '').trim().toLowerCase() === 'local') return null;
  try {
    const existing = readFileSync(WINDOW_AGENT_TOKEN_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* not created yet */
  }
  const minted = randomBytes(24).toString('base64url');
  try {
    mkdirSync(dirname(WINDOW_AGENT_TOKEN_FILE), { recursive: true });
    writeFileSync(WINDOW_AGENT_TOKEN_FILE, `${minted}\n`, { mode: 0o600 });
  } catch {
    /* read-only fs: the token still works for this run */
  }
  return minted;
}
const WINDOW_AGENT_TOKEN = loadOrCreateWindowAgentToken();

/** Does this request present the window agent's own credential (an Authorization: Bearer header, constant-time compare)? */
export function isWindowAgentCredential(req: IncomingMessage): boolean {
  if (!WINDOW_AGENT_TOKEN) return false;
  const h = String(req.headers.authorization ?? '');
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return !!m && safeEqual(m[1].trim(), WINDOW_AGENT_TOKEN);
}
/** A desktop host that still presents the SHARED bearer may register, as an UNCREDENTIALED agent: it never receives a person's ticket and can never replace a credentialed one. That is
 *  the default, so existing desktop hosts keep working through the move to the dedicated credential. HARBOR_WB_WINDOW_AGENT_STRICT=1 refuses the shared bearer there altogether. */
export function windowAgentSharedBearerAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.HARBOR_WB_WINDOW_AGENT_STRICT ?? '').trim() !== '1' && !hostedProfile(env);
}
/** The hosted (web-first, one person per server) profile has NO desktop host: /window-agent is refused outright, whatever credential is presented. */
export function hostedProfile(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.HARBOR_WB_HOSTED ?? '').trim() === '1';
}
export function windowAgentTokenFilePath(): string {
  return WINDOW_AGENT_TOKEN_FILE;
}
/** What the cookie actually carries — a hash, so the raw token is never stored
 *  in the browser. Knowing it is equivalent to knowing the token, so it is
 *  compared in constant time exactly like the token itself. */
const COOKIE_VALUE = createHash('sha256').update(`wb-cookie:${TOKEN}`).digest('hex');

/** The engine's own bearer, for the engine's own OUTBOUND calls.
 *
 * ONE SECRET, and this is the third presentation of it: the fabric subscriber
 * dials out and must present a credential the fabric can validate, which it
 * does through `GET <engine>/identity/introspect` (contract §0/§2) — the SAME
 * token this module accepts on the way in. "Do not invent a third credential"
 * (fabric brief §3) is only obeyable if the second one is reachable from inside
 * the process, so it is exported here rather than re-read from the file by
 * every caller that wants it.
 *
 * NOT a general accessor for anything that fancies a secret: only outbound
 * installation calls that the contract says take this bearer. */
export function bearerToken(): string {
  return TOKEN;
}

export function tokenFilePath(): string {
  return TOKEN_FILE;
}
export function tokenWasProvisioned(): boolean {
  return existsSync(TOKEN_FILE) || !!process.env.HARBOR_WB_TOKEN;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function cookiesOf(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
  }
  return out;
}

/** Is this request allowed to act? Covers both presentations. */
export function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Bearer ') && safeEqual(header.slice(7).trim(), TOKEN)) {
    return true;
  }
  const jar = cookiesOf(req);
  return !!jar[COOKIE] && safeEqual(jar[COOKIE], COOKIE_VALUE);
}

export function isPublicPath(pathname: string): boolean {
  return PUBLIC.has(pathname);
}

/* --- the doorbell exemption ------------------------------------------------
 *
 * `/api/claude-hook` is how a CLI says "I am blocked on the user" — the signal
 * behind the coral ring. It is delivered by a hook claude runs on our behalf,
 * and that hook has no way to hold a credential: it is a curl line in a global
 * settings file shared by every project and every host. So since auth landed it
 * has been 401ing on every single call, and because the hook ends in
 * `|| true` the failure was invisible at BOTH ends — the "come get me" light
 * has never once worked (found 2026-09-01).
 *
 * WHY THIS IS SAFE TO EXEMPT, precisely:
 *   - It is WRITE-ONLY and returns nothing about the installation, and it carries no
 *     content of its own into any pane.
 *   - It cannot start, stop, read, or reach a shell. Auth still guards every
 *     one of those, unchanged.
 *   - It already answers 200 to anything it cannot match, so it leaks no
 *     information about which sessions exist.
 * CORRECTED 2026-09-25 (assemble-room §4.4): it no longer only moves a dot.
 * A matched Stop ends a turn, and that RELEASES the pane's held typed delivery
 * (room-typer types queued room lines and fabric envelopes on the idle it
 * causes); a matched UserPromptSubmit or Stop also DISARMS the pane's startup
 * gate for its life. So the worst a bad LOCAL caller achieves is typing
 * already-queued lines into a pane sooner than its guards would — past a
 * startup prompt it has disarmed. The other guards (idle, draft, settle,
 * no-claude) still apply. Weigh that before widening anything here.
 * AND (ticket, engine/mcp-calls.ts): a matched MCP tool hook paints a chip
 * in the pane's title bar, and a live session_id is readable by ANY local
 * user (claude's argv in /proc). So any local process can paint short made-up
 * words there: a server key <= 48 and a tool <= 64 chars of [A-Za-z0-9_-], a
 * sub-agent name <= 32 of [A-Za-z0-9_:-]. Escaped text, never markup or a
 * link, but it CAN read as words (`Your_login_expired`); rate-limited per
 * pane, for at most 30 min. Authenticating MCP hook events is the follow-up
 * recorded in engine/mcp-calls.ts.
 *
 * TWO CONDITIONS, and the second is the load-bearing one. Behind Tailscale
 * Serve EVERY remote client arrives on 127.0.0.1 (recorded in tailnet.ts), so
 * a loopback check alone would quietly open this to the whole tailnet. Serve
 * sets `x-forwarded-for`; a request that is loopback AND carries no forwarding
 * header came from a process on this machine. That header can only be omitted
 * by something already on loopback, which is exactly what we are permitting —
 * so there is nothing here to forge your way past.
 *
 * NOT a general "loopback is trusted" rule, and it must never grow into one:
 * anything that can reach this port could use it. It is one endpoint, and its
 * blast radius is the release of held delivery described above.
 */
export function isLocalHookDelivery(req: IncomingMessage, pathname: string): boolean {
  /* `/api/agent-hook` (2026-10-03, Codex vendor) is the SECOND write-only hook
     sink and joins on the same two conditions: it is keyed by pane id, matched
     only to a LIVE pane of the vendor it names, moves that pane's activity
     state and may bank its session_id, and reads/logs no content
     (engine/agent-hook.ts). It is NOT a precedent for any route that delivers
     content or reads state — see the warning below. */
  if ((pathname !== '/api/claude-hook' && pathname !== '/api/agent-hook') || req.method !== 'POST') {
    return false;
  }
  if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host']) {
    return false;
  }
  /* LOCAL MODE: a browser page can POST to 127.0.0.1:<port>; the hook's curl never sends these headers, a browser always does. */
  if ((process.env.HARBOR_WB_MODE ?? '').trim().toLowerCase() === 'local' && (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined)) {
    return false;
  }
  const ip = (req.socket.remoteAddress ?? '').replace('::ffff:', '');
  return ip === '127.0.0.1' || ip === '::1';
}

/* --- login throttle -------------------------------------------------------
 * A shared secret with an unlimited guess rate is a weak secret. Small, in
 * memory, per-source: enough to make online brute force pointless without
 * pretending to be a real rate limiter. */
const attempts = new Map<string, { n: number; until: number }>();
const MAX_TRIES = 10;
const WINDOW_MS = 5 * 60 * 1000;

export function throttled(ip: string): boolean {
  const rec = attempts.get(ip);
  return !!rec && rec.n >= MAX_TRIES && Date.now() < rec.until;
}

export function recordFailure(ip: string): void {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now >= rec.until) {
    attempts.set(ip, { n: 1, until: now + WINDOW_MS });
    return;
  }
  rec.n += 1;
}

export function clearFailures(ip: string): void {
  attempts.delete(ip);
}

/** Verify a submitted token and, on success, hand back the Set-Cookie value. */
export function loginCookie(submitted: string, secure: boolean): string | null {
  if (!safeEqual(submitted.trim(), TOKEN)) {
    return null;
  }
  const bits = [
    `${COOKIE}=${COOKIE_VALUE}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${60 * 60 * 24 * 365}`, // log in once per device, not once per day
  ];
  if (secure) {
    bits.push('Secure');
  }
  return bits.join('; ');
}

/** Behind Tailscale Serve the hop to the engine is plain http, so trust the
 *  forwarded scheme for the Secure flag — otherwise an https login would set a
 *  non-Secure cookie. */
export function isSecureRequest(req: IncomingMessage): boolean {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  return proto === 'https';
}

/* --- one-time tickets: authenticating a window the ENGINE itself opens -------
 *
 * The engine hands a URL to a window host, which loads it in a WebView2 that has
 * no cookie yet — so an engine-launched window would land on the login page
 * (observed live 2026-08-22: every local window showed /login after the auth
 * gate shipped). The engine already knows the secret; the window it is opening
 * is one it chose to open. A ticket carries that trust across the handoff.
 *
 * THIS IS NOT THE "TOKEN IN A QUERY STRING" WE RULED OUT, and the distinction is
 * the lifetime, not the mechanism. What we rejected was a LONG-LIVED token
 * living in a bookmarked, history-logged, cloud-synced URL. This is single-use,
 * expires in a minute, is exchanged for the cookie on first request, and is
 * stripped from the address bar by the redirect — the OAuth authorization-code
 * shape. Nothing durable ever sits in a URL.
 */
const TICKET_MS = 60 * 1000;
const tickets = new Map<string, { exp: number; userId: string | null }>();

/** `userId`: the identity account the window is for (the person who opened it, or the instance's window owner). The redeem hands it back so the engine can open an
 *  IDENTITY session instead of the legacy cookie (a person an agent cannot forge). */
export function mintTicket(userId: string | null = null): string {
  const t = randomBytes(18).toString('base64url');
  tickets.set(t, { exp: Date.now() + TICKET_MS, userId });
  // opportunistic sweep — this map only grows by one per window we open
  for (const [k, v] of tickets) {
    if (v.exp < Date.now()) {
      tickets.delete(k);
    }
  }
  return t;
}

/** Redeem: valid exactly once, and only inside its window. */
export function redeemTicket(t: string): { ok: boolean; userId: string | null } {
  const v = tickets.get(t);
  if (v === undefined) {
    return { ok: false, userId: null };
  }
  tickets.delete(t); // single use, redeemed or not
  return Date.now() < v.exp ? { ok: true, userId: v.userId } : { ok: false, userId: null };
}

/** The Set-Cookie a redeemed ticket grants — same cookie the login form issues. */
export function ticketCookie(secure: boolean): string {
  const bits = [
    `${COOKIE}=${COOKIE_VALUE}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${60 * 60 * 24 * 365}`,
  ];
  if (secure) {
    bits.push('Secure');
  }
  return bits.join('; ');
}

/** The `ticket` value from a raw url, without round-tripping the whole query. */
export function ticketIn(url: string): string | null {
  const m = /[?&]ticket=([^&]*)/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Remove ONLY the ticket parameter, leaving every other byte untouched.
 *  Deliberately not `new URL(...).searchParams.delete()`: that re-encodes the
 *  whole query, and encodeURIComponent (what our callers use) and
 *  URLSearchParams do not agree on !'()*-._~ or on space, so a round trip can
 *  corrupt a nested `?tabs=<encoded url>` or an id containing those bytes. */
export function stripTicket(url: string): string {
  const out = url.replace(/([?&])ticket=[^&]*(&|$)/, (_m, lead: string, tail: string) =>
    lead === '?' && tail === '&' ? '?' : lead === '?' ? '' : tail === '&' ? '&' : '',
  );
  return out.endsWith('?') ? out.slice(0, -1) : out;
}

/** Where to send a browser after login. Only ever a path on THIS origin — an
 *  attacker-supplied `next` must not become an open redirect, and a
 *  protocol-relative `//evil.example` is a URL, not a path. */
export function safeNext(next: string | null | undefined): string {
  /* only a path on THIS origin: not protocol-relative, and no backslash anywhere (a browser reads `/\\evil.com` as `//evil.com`) */
  if (!next || !/^\/[^/\\]/.test(next) || next.includes('\\')) {
    return hostedProfile() ? '/app/' : '/'; // the hosted pilot's home is the web app
  }
  return next;
}

export function denyHttp(req: IncomingMessage, res: ServerResponse): void {
  // A browser navigation gets the login page; anything else gets a clean 401
  // (a script should not have to parse HTML to discover it is unauthenticated).
  const wantsHtml = String(req.headers.accept ?? '').includes('text/html');
  if (wantsHtml) {
    const next = encodeURIComponent(stripTicket(req.url ?? '/'));
    res.writeHead(302, { location: `/login?next=${next}` });
    res.end();
    return;
  }
  res.writeHead(401, {
    'content-type': 'application/json; charset=utf-8',
    'www-authenticate': 'Bearer',
  });
  res.end(JSON.stringify({ error: 'unauthorized' }));
}
