/**
 * R6a HTTP surface: the realm web login (authorization code + PKCE), the link
 * page's start/unlink, and the app's engine-ticket exchange. Verification is
 * ./realm.ts; this file decides what a VERIFIED realm identity is allowed to
 * become, which is exactly one thing: an ordinary 8 h engine session for the
 * engine account it is LINKED to (store.realm_link). Never an account, never
 * a device, never admin by virtue of the realm.
 *
 * Reached only through ./routes.ts, i.e. only in identity `both`/`strict`.
 * Every route here 404s while HARBOR_WB_REALM_ISSUER is unset.
 *
 * LOGIN CSRF / LINK HIJACK. A `state` alone is not enough: an attacker could
 * start a flow, sign in at the realm as THEMSELVES, and hand the victim the
 * callback URL — logging the victim in as the attacker, or (link intent)
 * linking the victim's engine account to the attacker's realm identity. So
 * every flow is also bound to THIS browser by an HttpOnly cookie whose hash
 * the pending entry holds, and a link flow to the exact engine sign-in
 * (user + credential row) that started it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import * as identity from './auth.ts';
import * as store from './store.ts';
import * as realm from './realm.ts';

export interface RealmDeps {
  sendJson(res: ServerResponse, status: number, body: unknown): void;
  readBody(req: IncomingMessage): Promise<any>;
  log(msg: string): void;
  safeNext(next: string | null | undefined): string;
  /** Session label for the account page ("GPU-HOST · windows"). */
  labelFor(req: IncomingMessage): string;
  /** Exact Origins the exchange accepts (the W3b allow-list, app://workbench). */
  exchangeOrigins(): string[];
}

const FLOW_COOKIE = 'wb_realm_flow';
const FLOW_PATH = '/auth/realm';
const FLOW_TTL_MS = 10 * 60 * 1000;
const FLOW_CAP = 200;

interface Pending {
  issuer: string;
  nonce: string;
  verifier: string;
  bindHash: string;
  intent: 'login' | 'link';
  next: string;
  /** link only: the engine sign-in that asked. */
  userId: string | null;
  credentialId: string | null;
  at: number;
}
const pending = new Map<string, Pending>();

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

let verifier: realm.Verifier | null = null;
let verifierIssuer = '';
function verifierFor(cfg: realm.RealmConfig): realm.Verifier {
  if (!verifier || verifierIssuer !== cfg.issuer) {
    verifier = realm.createVerifier({ issuer: cfg.issuer });
    verifierIssuer = cfg.issuer;
  }
  return verifier;
}

/** Is the realm button to be offered on /login? */
export function signInOffered(): boolean {
  return realm.config()?.cfg != null;
}

/** For GET /account: is the realm on, and this user's link (no secrets). */
export function accountView(userId: string): { configured: boolean; link: { issuer: string; sub: string; linkedAt: number } | null } {
  const c = realm.config();
  if (!c?.cfg) {
    return { configured: false, link: null };
  }
  const row = store.realmLinkForUser(userId);
  return { configured: true, link: row ? { issuer: row.issuer, sub: row.sub, linkedAt: row.linked_at } : null };
}

/** A sub made safe for one log line. A sub is an identifier, not a secret,
 *  but it is attacker-chosen text in a refused token. */
const logSub = (s: unknown): string => String(s).replace(/[^A-Za-z0-9._:@-]/g, '?').slice(0, 64);

function prune(): void {
  const t = Date.now();
  for (const [k, p] of pending) {
    if (t - p.at > FLOW_TTL_MS) {
      pending.delete(k);
    }
  }
  while (pending.size >= FLOW_CAP) {
    pending.delete(pending.keys().next().value as string);
  }
}

function redirect(res: ServerResponse, location: string, cookies: string[] = []): true {
  res.writeHead(303, cookies.length ? { location, 'set-cookie': cookies } : { location });
  res.end();
  return true;
}

/** Begin an authorization-code + PKCE flow; answers the 303 to the realm. */
async function start(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: realm.RealmConfig,
  intent: Pending['intent'],
  next: string,
  who: identity.Principal | null,
  deps: RealmDeps,
): Promise<true> {
  const back = intent === 'link' ? '/account.html?realm=' : '/login?realm=';
  let auth: string;
  try {
    auth = (await verifierFor(cfg).discovery()).authorization_endpoint;
  } catch {
    deps.log(`realm ${intent} start REFUSED: realm unreachable`);
    return redirect(res, `${back}unreachable`);
  }
  prune();
  const state = realm.randomToken();
  const bind = realm.randomToken();
  const p: Pending = {
    issuer: cfg.issuer,
    nonce: realm.randomToken(),
    verifier: realm.randomToken(),
    bindHash: sha(bind),
    intent,
    next,
    userId: who?.userId ?? null,
    credentialId: who?.credentialId ?? null,
    at: Date.now(),
  };
  pending.set(state, p);
  const u = new URL(auth);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('scope', realm.SCOPES);
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', p.nonce);
  u.searchParams.set('code_challenge', realm.pkceChallenge(p.verifier));
  u.searchParams.set('code_challenge_method', 'S256');
  const secure = identity.isSecureRequest(req);
  return redirect(res, u.toString(), [identity.cookie(FLOW_COOKIE, bind, FLOW_TTL_MS, secure, FLOW_PATH)]);
}

/** Redeem the code at the realm's token endpoint (confidential client,
 *  client_secret_basic, PKCE verifier) and return the ID token. */
async function redeem(cfg: realm.RealmConfig, code: string, p: Pending): Promise<string> {
  const d = await verifierFor(cfg).discovery();
  const secret = realm.clientSecret(cfg);
  const basic = Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(secret)}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: p.verifier,
  });
  const out = await realm.fetchJson(d.token_endpoint, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  });
  if (!out || typeof out.id_token !== 'string') {
    throw new Error('no id_token');
  }
  return out.id_token;
}

async function callback(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: realm.RealmConfig,
  principal: identity.Principal | null,
  deps: RealmDeps,
): Promise<true> {
  const q = new URL(req.url ?? '/', 'http://x').searchParams;
  const state = q.get('state') ?? '';
  const p = pending.get(state);
  pending.delete(state); // one use, whatever happens next
  const secure = identity.isSecureRequest(req);
  const clearFlow = identity.cookie(FLOW_COOKIE, '', 0, secure, FLOW_PATH);
  const bind = identity.cookiesOf(req)[FLOW_COOKIE] ?? '';
  if (!p || Date.now() - p.at > FLOW_TTL_MS || p.issuer !== cfg.issuer || !bind || sha(bind) !== p.bindHash) {
    deps.log('realm callback REFUSED: unknown, expired or foreign flow');
    return redirect(res, '/login?realm=expired', [clearFlow]);
  }
  const back = p.intent === 'link' ? '/account.html?realm=' : '/login?realm=';
  const fail = (word: string, why: string): true => {
    deps.log(`realm ${p.intent} REFUSED: ${why}`);
    return redirect(res, `${back}${word}`, [clearFlow]);
  };
  const code = q.get('code');
  if (q.get('error') || !code) {
    return fail('cancelled', 'the realm returned no code');
  }

  let idToken: string;
  try {
    idToken = await redeem(cfg, code, p);
  } catch {
    return fail('unreachable', 'code redemption failed (realm unreachable or refused)');
  }
  const v = await verifierFor(cfg).verify(idToken, { audience: cfg.clientId, nonce: p.nonce });
  if (!v.ok) {
    return fail(v.unreachable ? 'unreachable' : 'refused', `id token ${v.reason}`);
  }
  const sub = String(v.claims.sub);

  if (p.intent === 'link') {
    /* BOTH IDENTITIES IN ONE SITTING: the engine sign-in that started this
     * flow must still be the one presenting itself now — same user, same
     * credential row, a person cookie, not under a forced password change. */
    const person =
      principal &&
      !req.headers.authorization &&
      (principal.via === 'session' || principal.via === 'device') &&
      principal.userId === p.userId &&
      principal.credentialId === p.credentialId;
    if (!person) {
      return fail('signin', 'link callback not from the engine sign-in that started it');
    }
    if (principal!.mustChangePassword) {
      return fail('refused', `link for ${principal!.username}: password change pending`);
    }
    const existing = store.realmLinkBySub(cfg.issuer, sub);
    if (existing && existing.user_id !== principal!.userId) {
      return fail('taken', `link for ${principal!.username}: realm sub=${logSub(sub)} already linked to another engine account`);
    }
    if (!existing && !store.createRealmLink(cfg.issuer, sub, principal!.userId)) {
      return fail('already', `link for ${principal!.username}: this engine account already has a realm link`);
    }
    deps.log(`realm LINK ${principal!.username} <- realm sub=${logSub(sub)} (issuer ${cfg.issuer})`);
    return redirect(res, '/account.html?realm=linked', [clearFlow]);
  }

  const link = store.realmLinkBySub(cfg.issuer, sub);
  const account = link ? store.accountById(link.user_id) : null;
  if (!account) {
    /* No auto-create, no match by username or email (platform item 4). */
    return fail('unlinked', `login: realm sub=${logSub(sub)} is not linked to an engine account`);
  }
  const result = identity.loginWithRealm(account, { label: `${deps.labelFor(req)} · realm`, req, ttlMs: realm.REALM_SESSION_TTL_MS });
  if (!result.ok || !result.principal || !result.sessionToken) {
    return fail('refused', `login: engine account ${account.username} is disabled`);
  }
  deps.log(`realm login ok ${account.username} (realm sub=${logSub(sub)}, 8 h session)`);
  const next = result.principal.mustChangePassword ? '/account.html?change=1' : p.next;
  return redirect(res, next, [identity.sessionCookie(result.sessionToken, secure, realm.REALM_SESSION_TTL_MS), clearFlow]);
}

/** POST /auth/realm/exchange — the app's engine ticket for an 8 h cookie. */
async function exchange(req: IncomingMessage, res: ServerResponse, cfg: realm.RealmConfig, deps: RealmDeps): Promise<true> {
  const refuse = (status: number, field: string, error: string, why: string): true => {
    deps.log(`realm exchange REFUSED: ${why}`);
    deps.sendJson(res, status, { error, field });
    return true;
  };
  if (req.method !== 'POST') {
    deps.sendJson(res, 405, { error: 'method not allowed' });
    return true;
  }
  /* The ticket is the ONLY credential: an engine bearer, api token or pane
   * token riding along is refused rather than reasoned about. */
  /* Body only: a ticket in a URL ends up in access logs and history. The query
   * is refused whole and never echoed. */
  if ((req.url ?? '').includes('?')) {
    return refuse(400, 'query', 'send the ticket in the JSON body, never in the URL', 'query string present');
  }
  if (req.headers.authorization) {
    return refuse(403, 'credential', 'send the engine ticket in the body, with no Authorization header', 'authorization header present');
  }
  const origin = req.headers.origin;
  if (!origin || !deps.exchangeOrigins().includes(origin)) {
    return refuse(403, 'origin', 'the Origin header is missing or not allowed', 'origin');
  }
  let b: Record<string, unknown>;
  try {
    const body = await deps.readBody(req);
    b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  } catch {
    return refuse(400, 'body', 'a JSON body {"ticket": "<engine ticket>"} is required', 'body');
  }
  if (typeof b.ticket !== 'string' || !b.ticket) {
    return refuse(400, 'ticket', 'ticket is required', 'no ticket');
  }
  const v = await verifierFor(cfg).verify(b.ticket, { audience: cfg.clientId, ticket: true });
  if (!v.ok) {
    return v.unreachable
      ? refuse(503, 'realm', 'the realm cannot be reached to verify this ticket; sign in with your engine password', 'realm unreachable')
      : refuse(401, 'ticket', 'that ticket was not accepted', `ticket ${v.reason}`);
  }
  const sub = String(v.claims.sub);
  const link = store.realmLinkBySub(cfg.issuer, sub);
  const account = link ? store.accountById(link.user_id) : null;
  if (!account) {
    return refuse(
      403,
      'link',
      'this realm account is not linked to an engine account; sign in to the engine and link it from the account page',
      `realm sub=${logSub(sub)} not linked`,
    );
  }
  /* The app's device id (validated charset in realm.ts) is RECORDED on the
   * session label only: provenance for the account page, never a trust edge. */
  const device = typeof v.claims[realm.TICKET_DEVICE_CLAIM] === 'string' ? String(v.claims[realm.TICKET_DEVICE_CLAIM]) : null;
  const label = `${deps.labelFor(req)} · realm app${device ? ` · device ${device}` : ''}`;
  const result = identity.loginWithRealm(account, { label, req, ttlMs: realm.REALM_SESSION_TTL_MS });
  if (!result.ok || !result.sessionToken) {
    return refuse(403, 'account', 'that engine account is disabled', `engine account ${account.username} disabled`);
  }
  deps.log(`realm exchange ok ${account.username} (realm sub=${logSub(sub)}, device=${device ?? '-'}, 8 h session)`);
  res.writeHead(200, {
    'content-type': 'application/json',
    'set-cookie': identity.sessionCookie(result.sessionToken, identity.isSecureRequest(req), realm.REALM_SESSION_TTL_MS),
  });
  res.end(
    JSON.stringify({
      ok: true,
      username: account.username,
      expiresAt: Date.now() + realm.REALM_SESSION_TTL_MS,
      mustChangePassword: account.must_change_password === 1,
    }),
  );
  return true;
}

/**
 * The unauthenticated half: /auth/realm/start, /auth/realm/callback,
 * /auth/realm/exchange. Returns true when consumed. Never throws: any fault
 * answers 500 and is logged as a word, never as a token.
 */
/* A RATE limit, not a failure lockout (platform [ref]): each of these routes
 * does unauthenticated work (a signature check, maybe a realm fetch), so a
 * flood is cut off, while a person retrying a few times never notices.
 * Per address: behind Serve every socket is loopback, so the forwarded client
 * address is the one that tells two callers apart. */
export const RATE_PER_MIN = 60;
const hits = new Map<string, number[]>();
function clientAddress(req: IncomingMessage): string {
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return xff || (req.socket.remoteAddress ?? '').replace('::ffff:', '') || '-';
}
function allowRate(addr: string, now = Date.now()): boolean {
  const recent = (hits.get(addr) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= RATE_PER_MIN) {
    hits.set(addr, recent);
    return false;
  }
  recent.push(now);
  hits.set(addr, recent);
  if (hits.size > 10_000) {
    for (const [k, ts] of hits) if (!ts.some((t) => now - t < 60_000)) hits.delete(k);
  }
  return true;
}

export async function handleAuth(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  principal: identity.Principal | null,
  deps: RealmDeps,
): Promise<boolean> {
  if (!pathname.startsWith('/auth/realm/')) {
    return false;
  }
  const c = realm.config();
  const exists =
    pathname === '/auth/realm/start' || pathname === '/auth/realm/callback' || (pathname === '/auth/realm/exchange' && !!c?.cfg?.exchange);
  if (!c || !exists) {
    deps.sendJson(res, 404, { error: 'not found' });
    return true;
  }
  if (!c.cfg) {
    deps.log(`realm route ${pathname} unavailable: ${c.problem}`);
    deps.sendJson(res, 503, { error: c.problem });
    return true;
  }
  const addr = clientAddress(req);
  if (!allowRate(addr)) {
    deps.log(`realm route ${pathname} refused: rate (${RATE_PER_MIN}/min per address)`);
    deps.sendJson(res, 429, { error: 'too many sign-in requests; wait a minute', field: 'rate' });
    return true;
  }
  try {
    const method = req.method ?? 'GET';
    if (pathname === '/auth/realm/start' && method === 'GET') {
      const next = deps.safeNext(new URL(req.url ?? '/', 'http://x').searchParams.get('next'));
      return await start(req, res, c.cfg, 'login', next, null, deps);
    }
    if (pathname === '/auth/realm/callback' && method === 'GET') {
      return await callback(req, res, c.cfg, principal, deps);
    }
    if (pathname === '/auth/realm/exchange') {
      return await exchange(req, res, c.cfg, deps);
    }
    deps.sendJson(res, 405, { error: 'method not allowed' });
    return true;
  } catch (e) {
    deps.log(`realm route ${pathname} failed: ${(e as Error)?.name ?? 'error'}`);
    if (!res.headersSent) {
      deps.sendJson(res, 500, { error: 'realm sign-in failed' });
    }
    return true;
  }
}

/**
 * The signed-in half, under /account/realm/* — called by ./routes.ts AFTER its
 * principal check, the forced-change gate and the origin check, so all three
 * apply here exactly as they do to every other /account route.
 */
export async function handleAccount(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  principal: identity.Principal,
  deps: RealmDeps,
): Promise<boolean> {
  if (pathname !== '/account/realm/link' && pathname !== '/account/realm/unlink') {
    return false;
  }
  const c = realm.config();
  if (!c) {
    deps.sendJson(res, 404, { error: 'not found' });
    return true;
  }
  if (!c.cfg) {
    deps.sendJson(res, 503, { error: c.problem });
    return true;
  }
  if (req.method !== 'POST') {
    deps.sendJson(res, 405, { error: 'method not allowed' });
    return true;
  }
  /* A PERSON, in a browser: a session or device cookie and no bearer. An api
   * token cannot link a realm identity to the account it belongs to. */
  if (req.headers.authorization || (principal.via !== 'session' && principal.via !== 'device') || !principal.credentialId) {
    deps.log(`realm link REFUSED for ${principal.username}: not a person cookie`);
    deps.sendJson(res, 403, { error: 'linking needs you signed in to the engine in a browser (no bearer or api token)' });
    return true;
  }
  try {
    if (pathname === '/account/realm/unlink') {
      const ok = store.deleteRealmLink(principal.userId);
      deps.log(`realm UNLINK ${ok ? 'ok' : 'MISS'} for ${principal.username}`);
      if (String(req.headers['content-type'] ?? '').includes('application/json')) {
        deps.sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'no realm account is linked' });
        return true;
      }
      return redirect(res, `/account.html?realm=${ok ? 'unlinked-ok' : 'none'}`);
    }
    if (store.realmLinkForUser(principal.userId)) {
      return redirect(res, '/account.html?realm=already');
    }
    return await start(req, res, c.cfg, 'link', '/account.html', principal, deps);
  } catch (e) {
    deps.log(`realm account route failed: ${(e as Error)?.name ?? 'error'}`);
    if (!res.headersSent) {
      deps.sendJson(res, 500, { error: 'realm link failed' });
    }
    return true;
  }
}

/** Tests only. */
export function resetForTests(): void {
  pending.clear();
  verifier = null;
  verifierIssuer = '';
}
