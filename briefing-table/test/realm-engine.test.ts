/**
 * R6a realm sign-in through a real scratch engine (identity `both`) against a
 * LOCAL fake OIDC issuer started here (discovery, JWKS, /oidc/auth, /oidc/token,
 * RS256). Never the real realm.
 *
 * Boot 1: no HARBOR_WB_REALM_ISSUER — every /auth/realm/* route 404s, /login
 * offers no button. Boot 2: issuer + client + secret file + redirect URI +
 * HARBOR_WB_REALM_EXCHANGE=1 + W3b grants on. Covered: code+PKCE login for a
 * linked sub; unlinked sub refused (no account made); link needs an engine
 * person sign-in and the same sign-in at the callback; unlink; the engine
 * ticket exchange and its refusals; no device rows; 8 h absolute life; the
 * password login; the forced-change gate; the realm going away mid-flow; logs
 * free of every token, code, ticket and the client secret.
 *
 * SAFETY: engine P(549), dead broker P(550), fake issuer P(551), temp table +
 * identity db, childEnv(), fabric + NATS off. The temp dir is removed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { P, assertFree, childEnv, scratchShell } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(549);
const BROKER_PORT = P(550);
const ISSUER_PORT = P(551);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const ISS = `http://${HOST}:${ISSUER_PORT}`;
const CLIENT_ID = 'engine-test';
const CLIENT_SECRET = randomBytes(24).toString('base64url');
const REDIRECT = `${BASE}/auth/realm/callback`;
const TOKEN = 'realm-test-shared-token';
const WB = 'app://workbench';
const TARGETS = JSON.stringify({ targets: [{ id: 'local', label: 'Local', kind: 'local', shell: scratchShell() }] });

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-realm-'));
const dbPath = join(tmpDir, 'mapping.db');
const identityDb = join(tmpDir, 'identity.db');
const secretFile = join(tmpDir, 'realm-client-secret');
writeFileSync(secretFile, `${CLIENT_SECRET}\n`, { mode: 0o600 });
process.env.HARBOR_WB_IDENTITY_DB = identityDb;
process.env.HARBOR_WB_IDENTITY = 'both';
const idStore = await import('../src/identity/store.ts');
const idAuth = await import('../src/identity/auth.ts');

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  + ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  X ${msg}`);
  }
}
const eq = (a: unknown, b: unknown, msg: string): void => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  ok(x === y, x === y ? msg : `${msg} (got ${x}, want ${y})`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const secrets: string[] = [CLIENT_SECRET]; // every value that must never reach the log

/* ---- the fake issuer ---- */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'fake-kid-1';
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid: KID, typ: 'JWT' }): string {
  const data = `${b64(header)}.${b64(claims)}`;
  const t = `${data}.${cryptoSign('sha256', Buffer.from(data), privateKey).toString('base64url')}`;
  secrets.push(t);
  return t;
}
const nowS = () => Math.floor(Date.now() / 1000);
/** Who is "signed in at the realm" for the next /oidc/auth. */
let realmSub = 'sub-owner';
const codes = new Map<string, { sub: string; nonce: string; challenge: string; redirect: string }>();
let tokenCalls: { auth: string; body: URLSearchParams }[] = [];
function startIssuer(): Promise<Server> {
  const srv = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', ISS);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (u.pathname === '/.well-known/openid-configuration') {
      return json(200, { issuer: ISS, authorization_endpoint: `${ISS}/oidc/auth`, token_endpoint: `${ISS}/oidc/token`, jwks_uri: `${ISS}/oidc/jwks` });
    }
    if (u.pathname === '/oidc/jwks') return json(200, { keys: [JWK] });
    if (u.pathname === '/oidc/auth') {
      const q = u.searchParams;
      const fine =
        q.get('response_type') === 'code' && q.get('client_id') === CLIENT_ID && q.get('redirect_uri') === REDIRECT &&
        q.get('code_challenge_method') === 'S256' && !!q.get('code_challenge') && !!q.get('nonce') && !!q.get('state') &&
        q.get('scope') === 'openid email profile';
      if (!fine) return json(400, { error: 'invalid_request' });
      const code = randomBytes(16).toString('base64url');
      secrets.push(code);
      codes.set(code, { sub: realmSub, nonce: q.get('nonce')!, challenge: q.get('code_challenge')!, redirect: q.get('redirect_uri')! });
      res.writeHead(302, { location: `${REDIRECT}?code=${code}&state=${encodeURIComponent(q.get('state')!)}` });
      return res.end();
    }
    if (u.pathname === '/oidc/token' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      const body = new URLSearchParams(raw);
      tokenCalls.push({ auth: String(req.headers.authorization ?? ''), body });
      const want = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
      const c = codes.get(body.get('code') ?? '');
      codes.delete(body.get('code') ?? '');
      const pkce = c && createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url') === c.challenge;
      if (req.headers.authorization !== want || !c || !pkce || body.get('redirect_uri') !== c.redirect || body.get('grant_type') !== 'authorization_code') {
        return json(400, { error: 'invalid_grant' });
      }
      const access = randomBytes(24).toString('base64url');
      secrets.push(access);
      return json(200, {
        access_token: access,
        token_type: 'Bearer',
        id_token: jwt({ iss: ISS, aud: CLIENT_ID, sub: c.sub, nonce: c.nonce, iat: nowS(), exp: nowS() + 3600, email: 'noreply@example.com' }),
      });
    }
    json(404, { error: 'not found' });
  });
  return new Promise((r) => srv.listen(ISSUER_PORT, HOST, () => r(srv)));
}

/* ---- tiny HTTP client with set-cookie capture ---- */
interface Resp { status: number; location: string; cookies: Record<string, string>; setCookie: string[]; body: any; text: string }
async function call(path: string, o: { method?: string; json?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {}): Promise<Resp> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  let body: string | undefined;
  if (o.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(o.json);
  } else if (o.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(o.form).toString();
  }
  const url = path.startsWith('http') ? path : BASE + path;
  const res = await fetch(url, { method: o.method ?? (body === undefined ? 'GET' : 'POST'), headers, body, redirect: 'manual' });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const cookies: Record<string, string> = {};
  for (const c of setCookie) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    cookies[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* html or empty */ }
  return { status: res.status, location: res.headers.get('location') ?? '', cookies, setCookie, body: parsed, text };
}
const jar = (c: Record<string, string>) => Object.entries(c).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');

/** Drive one realm round trip. `startPath` is a GET (login) or a form POST
 *  (link). Returns the callback's response. */
async function realmFlow(o: { as: string; startPath?: string; session?: string; flowCookieOverride?: string | null; callbackSession?: string | null }) {
  realmSub = o.as;
  const sess = o.session ? { homelab_session: o.session } : {};
  const start = o.startPath === '/account/realm/link'
    ? await call('/account/realm/link', { method: 'POST', form: {}, headers: { cookie: jar(sess), origin: BASE } })
    : await call(o.startPath ?? '/auth/realm/start?next=/rooms.html', { headers: { cookie: jar(sess) } });
  if (start.status !== 303 || !start.location.startsWith(`${ISS}/oidc/auth`)) return { start, cb: null as Resp | null };
  const flow = start.cookies.wb_realm_flow;
  secrets.push(flow);
  const atRealm = await call(start.location);
  if (atRealm.status !== 302) return { start, cb: null };
  const cbSess = o.callbackSession === undefined ? sess : o.callbackSession ? { homelab_session: o.callbackSession } : {};
  const flowCookie = o.flowCookieOverride === undefined ? { wb_realm_flow: flow } : o.flowCookieOverride ? { wb_realm_flow: o.flowCookieOverride } : {};
  const cb = await call(atRealm.location, { headers: { cookie: jar({ ...cbSess, ...flowCookie }) } });
  if (cb.cookies.homelab_session) secrets.push(cb.cookies.homelab_session);
  return { start, cb };
}

const ticket = (o: { sub?: string; aud?: string; life?: number; marker?: 'both' | 'claim' | 'typ' | 'none'; nonce?: string; jti?: string; device?: string } = {}) => {
  const iat = nowS();
  const claims: Record<string, unknown> = {
    iss: ISS, aud: o.aud ?? CLIENT_ID, sub: o.sub ?? 'sub-owner', iat, exp: iat + (o.life ?? 60), jti: o.jti ?? randomBytes(9).toString('base64url'),
  };
  const header: Record<string, unknown> = { alg: 'RS256', kid: KID, typ: 'JWT' };
  const m = o.marker ?? 'both';
  if (m === 'both' || m === 'claim') claims.purpose = 'engine-ticket';
  if (m === 'both' || m === 'typ') header.typ = 'engine-ticket+jwt';
  claims.device_id = o.device === undefined ? 'app-device-1' : o.device;
  if (claims.device_id === '') delete claims.device_id;
  if (o.nonce) claims.nonce = o.nonce;
  return jwt(claims, header);
};
const exchange = (t: string, headers: Record<string, string> = { origin: WB }, path = '/auth/realm/exchange') => call(path, { json: { ticket: t }, headers });

async function run(): Promise<void> {
  for (const p of [PORT, BROKER_PORT, ISSUER_PORT]) await assertFree(p, 'realm-engine.test.ts');
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  let log = '';
  let engine: ChildProcess | null = null;
  let issuer: Server | null = null;
  const up = async (url: string) => {
    for (let i = 0; i < 120; i++) {
      if (await fetch(url).then((r) => r.ok).catch(() => false)) return true;
      await sleep(250);
    }
    return false;
  };
  const kill = async (proc: ChildProcess | null) => {
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      const gone = new Promise((r) => proc.once('exit', r));
      proc.kill('SIGTERM');
      await Promise.race([gone, sleep(3000)]);
    }
  };
  const boot = async (realmOn: boolean) => {
    engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_PORT: String(PORT),
        HARBOR_WB_HOST: HOST,
        HARBOR_WB_TABLE: dbPath,
        HARBOR_WB_TOKEN: TOKEN,
        HARBOR_WB_IDENTITY: 'both',
        HARBOR_WB_IDENTITY_DB: identityDb,
        HARBOR_WB_TERM_GRANTS: '1',
        HARBOR_WB_REALM_ISSUER: realmOn ? ISS : undefined,
        HARBOR_WB_REALM_CLIENT_ID: realmOn ? CLIENT_ID : undefined,
        HARBOR_WB_REALM_CLIENT_SECRET_FILE: realmOn ? secretFile : undefined,
        HARBOR_WB_REALM_REDIRECT_URI: realmOn ? REDIRECT : undefined,
        HARBOR_WB_REALM_EXCHANGE: realmOn ? '1' : undefined,
        HARBOR_WB_NO_WINDOW: '1',
        HARBOR_WB_DESKTOP: 'none',
        HARBOR_WB_BROKER_AUTOSTART: '0',
        HARBOR_WB_BROKER_PORT: String(BROKER_PORT),
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_NODE: 'testnode',
        HARBOR_WB_TARGETS: TARGETS,
      }),
    });
    engine.stdout!.on('data', (d) => (log += d));
    engine.stderr!.on('data', (d) => (log += d));
    if (!(await up(`${BASE}/health`))) throw new Error(`engine did not come up\n${log}`);
  };

  /* ---- people ---- */
  const PW = 'correct horse battery staple 42';
  const owner = idStore.createAccount({ username: 'owner', passwordHash: await idAuth.hashPassword(PW), mustChange: false, passwordExpiresAt: null, isAdmin: false });
  const S1 = idStore.mintToken();
  const S2 = idStore.mintToken();
  idStore.createSession(owner.id, S1, 'laptop');
  idStore.createSession(owner.id, S2, 'phone');
  const API = idStore.mintToken();
  idStore.createApiToken(owner.id, API, 'cli');
  secrets.push(S1, S2, API, PW);
  const sql = new Database(identityDb);
  const count = (t: string) => (sql.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

  try {
    console.log('[realm off (no issuer)]');
    await boot(false);
    for (const p of ['/auth/realm/start', '/auth/realm/callback?code=x&state=y']) {
      eq((await call(p)).status, 404, `GET ${p.split('?')[0]} is 404`);
    }
    eq((await exchange(ticket())).status, 404, 'POST /auth/realm/exchange is 404');
    let r = await call('/login');
    ok(r.status === 200 && r.text.includes("const REALM = 'off' === 'on'"), '/login offers no realm button');
    r = await call('/account', { headers: { cookie: `homelab_session=${S1}` } });
    eq(r.body?.realm, { configured: false, link: null }, 'GET /account: realm not configured');
    eq((await call('/account/realm/link', { method: 'POST', form: {}, headers: { cookie: `homelab_session=${S1}`, origin: BASE } })).status, 404, 'POST /account/realm/link is 404');
    await kill(engine);

    console.log('\n[realm on]');
    issuer = await startIssuer();
    await boot(true);
    r = await call('/login');
    ok(r.text.includes("const REALM = 'on' === 'on'"), '/login offers the realm button');

    console.log('\n[unlinked sub]');
    const accountsBefore = count('user_account');
    let f = await realmFlow({ as: 'sub-owner' });
    eq([f.cb?.status, f.cb?.location], [303, '/login?realm=unlinked'], 'an unlinked realm sub is sent back to /login?realm=unlinked');
    ok(!f.cb?.cookies.homelab_session, 'no session cookie for an unlinked sub');
    eq(count('user_account'), accountsBefore, 'no engine account was created');
    const tc = tokenCalls.at(-1);
    ok(tc && tc.auth.startsWith('Basic ') && !!tc.body.get('code_verifier') && !tc.body.get('client_secret'), 'code redeemed with client_secret_basic + PKCE verifier');

    console.log('\n[link]');
    r = await call('/account/realm/link', { method: 'POST', form: {}, headers: { origin: BASE } });
    eq(r.status, 401, 'link without an engine sign-in: 401');
    r = await call('/account/realm/link', { method: 'POST', form: {}, headers: { authorization: `Bearer ${API}`, origin: BASE } });
    eq(r.status, 403, 'link with an api token (bearer): 403');
    f = await realmFlow({ as: 'sub-owner', startPath: '/account/realm/link', session: S1, callbackSession: S2 });
    eq(f.cb?.location, '/account.html?realm=signin', 'callback under a DIFFERENT engine sign-in: refused');
    f = await realmFlow({ as: 'sub-owner', startPath: '/account/realm/link', session: S1, flowCookieOverride: null });
    eq(f.cb?.location, '/login?realm=expired', 'callback without the flow cookie (another browser): refused');
    eq(idStore.realmLinkForUser(owner.id), null, 'no link written by the refused attempts');
    f = await realmFlow({ as: 'sub-owner', startPath: '/account/realm/link', session: S1 });
    eq(f.cb?.location, '/account.html?realm=linked', 'link flow completes for the signed-in person');
    const link = idStore.realmLinkForUser(owner.id);
    ok(link && link.issuer === ISS && link.sub === 'sub-owner', 'realm_link row: (issuer, sub) -> owner');
    r = await call('/account', { headers: { cookie: `homelab_session=${S1}` } });
    ok(r.body?.realm?.configured && r.body.realm.link?.sub === 'sub-owner', 'GET /account shows the link');
    r = await call('/account/realm/link', { method: 'POST', form: {}, headers: { cookie: `homelab_session=${S1}`, origin: BASE } });
    eq(r.location, '/account.html?realm=already', 'a second link while linked: told to unlink first');

    console.log('\n[login]');
    f = await realmFlow({ as: 'sub-owner' });
    eq([f.cb?.status, f.cb?.location], [303, '/rooms.html'], 'linked sub: 303 to the requested next');
    const RS = f.cb?.cookies.homelab_session ?? '';
    ok(!!RS && !f.cb?.cookies.homelab_device, 'a session cookie and no device cookie');
    ok(f.cb?.setCookie.some((c) => c.startsWith('homelab_session=') && /Max-Age=28800\b/.test(c) && /HttpOnly/.test(c) && !/Domain=/i.test(c)), 'session cookie: Max-Age 8 h, HttpOnly, host-only');
    r = await call('/account', { headers: { cookie: `homelab_session=${RS}` } });
    eq([r.status, r.body?.username, r.body?.via, r.body?.isAdmin], [200, 'owner', 'session', false], 'the realm session is an ordinary person session for owner (engine roles)');
    eq((await call('/api/rooms', { headers: { cookie: `homelab_session=${RS}` } })).status, 200, 'GET /api/rooms on the realm session');
    r = await call('/api/terminal-grants', { json: { paneid: 'nope', intent: 'view', room: 'r', seat: 's' }, headers: { cookie: `homelab_session=${RS}`, origin: WB } });
    /* No room/seat/pane exists here (that needs a live broker; term-grants-engine
       covers a real mint), so a person gets past the credential + Origin checks
       to the room lookup, while a bearer is stopped at the credential check. */
    eq([r.status, r.body?.field], [404, 'room'], 'W3b grant mint: the realm session passes as a person (reaches the room lookup)');
    r = await call('/api/terminal-grants', { json: { paneid: 'nope', intent: 'view', room: 'r', seat: 's' }, headers: { authorization: `Bearer ${API}`, origin: WB } });
    eq(r.body?.field, 'credential', '(contrast) the same mint on an api token: refused at the credential check');
    const row = sql.prepare('SELECT created_at, expires_at FROM session WHERE token_hash = ?').get(idStore.hashToken(RS)) as { created_at: number; expires_at: number };
    eq(row.expires_at - row.created_at, 8 * 3600 * 1000, 'the session row lives exactly 8 h');
    eq(count('device'), 0, 'no device row');

    console.log('\n[exchange]');
    let e = await exchange(ticket({ device: 'app-device-7' }));
    const XS = e.cookies.homelab_session ?? '';
    secrets.push(XS);
    eq([e.status, e.body?.username], [200, 'owner'], 'a good ticket with Origin app://workbench: 200 for owner');
    ok(e.setCookie.some((c) => /Max-Age=28800\b/.test(c)), 'exchange cookie: 8 h');
    eq((await call('/api/rooms', { headers: { cookie: `homelab_session=${XS}` } })).status, 200, 'GET /api/rooms on the exchange cookie');
    r = await call('/api/terminal-grants', { json: { paneid: 'nope', intent: 'view', room: 'r', seat: 's' }, headers: { cookie: `homelab_session=${XS}`, origin: WB } });
    eq([r.status, r.body?.field], [404, 'room'], 'W3b grant mint: the exchange cookie passes as a person (reaches the room lookup)');
    const lbl = sql.prepare('SELECT label FROM session WHERE token_hash = ?').get(idStore.hashToken(XS)) as { label: string };
    ok(/realm app · device app-device-7$/.test(lbl?.label ?? ''), `the ticket's device_id is recorded on the session label (${lbl?.label})`);
    eq((await exchange(ticket({ marker: 'typ' }))).status, 401, 'typ header without the purpose claim: 401');
    eq((await exchange(ticket({ marker: 'claim' }))).status, 401, 'purpose claim without the typ header: 401');
    const q = ticket();
    eq((await exchange(q, { origin: WB }, `/auth/realm/exchange?ticket=${q}`)).body?.field, 'query', 'a query string on the exchange: refused');
    eq((await exchange(ticket(), {})).body?.field, 'origin', 'no Origin: refused');
    eq((await exchange(ticket(), { origin: 'https://evil.example' })).body?.field, 'origin', 'foreign Origin: refused');
    eq((await exchange(ticket(), { origin: BASE })).body?.field, 'origin', "the engine's own origin is not on the exchange list");
    eq((await exchange(ticket({ aud: 'workbench' }))).status, 401, 'wrong audience: 401');
    eq((await exchange(ticket({ life: 91 }))).status, 401, 'lifetime over 90 s: 401');
    eq((await exchange(ticket({ marker: 'none' }))).status, 401, 'no ticket marker: 401');
    eq((await exchange(ticket({ nonce: 'n' }))).status, 401, 'a nonce present: 401');
    const idTok = jwt({ iss: ISS, aud: CLIENT_ID, sub: 'sub-owner', nonce: 'abc', iat: nowS(), exp: nowS() + 60, jti: 'id-1' });
    eq((await exchange(idTok)).status, 401, 'an ID token replayed as a ticket: 401');
    const once = ticket({ jti: 'jti-once' });
    eq((await exchange(once)).status, 200, 'first use of a jti: 200');
    eq((await exchange(once)).status, 401, 'reuse of a jti: 401');
    eq((await exchange(ticket({ sub: 'sub-stranger' }))).body?.field, 'link', 'unlinked sub: 403 link');
    eq((await exchange(ticket(), { origin: WB, authorization: `Bearer ${TOKEN}` })).body?.field, 'credential', 'the shared bearer riding along: refused');
    eq((await exchange(ticket(), { origin: WB, authorization: `Bearer ${API}` })).body?.field, 'credential', 'an api token riding along: refused');
    eq(count('device'), 0, 'still no device row after every realm path');

    console.log('\n[8 h absolute]');
    sql.prepare('UPDATE session SET expires_at = ? WHERE token_hash = ?').run(Date.now() - 1, idStore.hashToken(RS));
    eq((await call('/api/rooms', { headers: { cookie: `homelab_session=${RS}` } })).status, 401, 'past its 8 h the realm session is refused');

    console.log('\n[password login (break-glass)]');
    r = await call('/login', { json: { username: 'owner', password: PW } });
    ok(r.status === 200 && !!r.cookies.homelab_session, 'the engine password login still works');
    secrets.push(r.cookies.homelab_session ?? '');

    console.log('\n[forced password change]');
    const alice = idStore.createAccount({ username: 'alice', passwordHash: 'unused', mustChange: true, passwordExpiresAt: null, isAdmin: false });
    idStore.createRealmLink(ISS, 'sub-alice', alice.id);
    f = await realmFlow({ as: 'sub-alice' });
    eq(f.cb?.location, '/account.html?change=1', 'a linked account under a forced change lands on the change page');
    const AS = f.cb?.cookies.homelab_session ?? '';
    eq((await call('/api/rooms', { headers: { cookie: `homelab_session=${AS}` } })).body?.mustChangePassword, true, 'the gate still refuses the API');
    r = await call('/account/realm/unlink', { json: {}, headers: { cookie: `homelab_session=${AS}`, origin: BASE } });
    eq([r.status, r.body?.mustChangePassword], [403, true], 'the gate applies to /account/realm/*');

    console.log('\n[unlink]');
    r = await call('/account/realm/unlink', { json: {}, headers: { cookie: `homelab_session=${S1}`, origin: BASE } });
    eq(r.status, 200, 'unlink: 200');
    eq(idStore.realmLinkForUser(owner.id), null, 'the link row is gone');
    f = await realmFlow({ as: 'sub-owner' });
    eq(f.cb?.location, '/login?realm=unlinked', 'after unlink the realm sign-in is refused');
    eq((await exchange(ticket())).body?.field, 'link', 'and so is the exchange');
    idStore.createRealmLink(ISS, 'sub-owner', owner.id);

    console.log('\n[realm unreachable]');
    realmSub = 'sub-owner';
    const st = await call('/auth/realm/start');
    const flow = st.cookies.wb_realm_flow;
    const atRealm = await call(st.location);
    issuer!.closeAllConnections();
    await new Promise((res) => issuer!.close(res));
    issuer = null;
    r = await call(atRealm.location, { headers: { cookie: `wb_realm_flow=${flow}` } });
    eq(r.location, '/login?realm=unreachable', 'realm gone mid-flow: /login?realm=unreachable');
    eq((await call('/api/rooms', { headers: { cookie: `homelab_session=${XS}` } })).status, 200, 'an existing realm-born session keeps working');
    eq((await exchange(ticket())).status, 200, 'a ticket still verifies from the cached JWKS');
    r = await call('/login', { json: { username: 'owner', password: PW } });
    eq(r.status, 200, 'the password login still works with the realm down');
    secrets.push(r.cookies.homelab_session ?? '');

    console.log('\n[rate limit: 60/min per address]');
    const flood = { origin: WB, 'x-forwarded-for': '203.0.113.9' };
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await exchange('not-a-ticket', flood)).status);
    ok(statuses.slice(0, 60).every((s) => s === 401), 'the first 60 bad tickets from one address: 401 each (no lockout)');
    eq(statuses[60], 429, 'the 61st within a minute: 429');
    eq((await call('/auth/realm/callback?state=x&code=y', { headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 429, 'the callback shares the same per-address limit');
    ok((await exchange('not-a-ticket', { origin: WB, 'x-forwarded-for': '203.0.113.10' })).status === 401, 'another address is unaffected');
    ok(/realm route \/auth\/realm\/exchange refused: rate/.test(log), 'audit: rate refusals are logged');

    console.log('\n[logs]');
    const leaked = secrets.filter((s) => s && log.includes(s));
    ok(secrets.length > 20 && leaked.length === 0, `no token, code, ticket, cookie or the client secret in the engine log (${secrets.length} checked, ${leaked.length} leaked)`);
    ok(/realm login ok owner \(realm sub=sub-owner, 8 h session\)/.test(log), 'audit: realm login');
    ok(/realm LINK owner <- realm sub=sub-owner/.test(log), 'audit: link');
    ok(/realm UNLINK ok for owner/.test(log), 'audit: unlink');
    ok(/realm login REFUSED: login: realm sub=sub-owner is not linked/.test(log), 'audit: unlinked refusal');
    ok(/realm exchange REFUSED: ticket replay/.test(log) && /realm exchange REFUSED: origin/.test(log), 'audit: exchange refusals');
  } catch (err) {
    failed++;
    failures.push(`threw: ${(err as Error)?.stack ?? err}`);
    console.log(`  X threw: ${(err as Error)?.stack ?? err}`);
    console.log(`--- log tail ---\n${log.slice(-3000)}`);
  } finally {
    sql.close();
    await kill(engine);
    if (issuer) {
      issuer.closeAllConnections();
      await new Promise((res) => issuer!.close(res));
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* the killed engine can still hold the dir */ }
  }
  console.log(`\nPASS ${passed} FAIL ${failed}`);
  if (failed) {
    console.log(failures.map((x) => ` - ${x}`).join('\n'));
    process.exit(1);
  }
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
