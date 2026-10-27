/**
 * ADD A SERVER, engine side part 2: /api/node, the PKCE hand-back, exchange, revoke (the design notes sections 5, 12-14).
 * Driven through identity/routes.handle with stub deps (so the wiring is covered); a scratch identity db and a made-up tailnet. Nothing listens.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const tmp = mkdtempSync(join(tmpdir(), 'wb-addsrv-hb-'));
process.env.HARBOR_WB_IDENTITY_DB = join(tmp, 'identity.db');
process.env.HARBOR_WB_IDENTITY = 'both';
process.env.HARBOR_WB_BEHIND_SERVE = '1';
process.env.HARBOR_WB_NODE = 'homebase';
delete process.env.HARBOR_WB_REALM_ISSUER;

const store = await import('../src/identity/store.ts');
const identity = await import('../src/identity/auth.ts');
const routes = await import('../src/identity/routes.ts');
const tailnet = await import('../src/engine/tailnet.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };

tailnet._setPeersForTest([
  { hostName: 'laptop', os: 'windows', nodeKey: 'nodekey:LAPTOP', tailscaleIP: '100.64.0.10', tags: [], sharedIn: false },
  { hostName: 'phone', os: 'iOS', nodeKey: 'nodekey:PHONE', tailscaleIP: '100.64.0.11', tags: [], sharedIn: false },
  { hostName: 'box', os: 'linux', nodeKey: 'nodekey:BOX', tailscaleIP: '100.64.0.13', tags: ['tag:home'], sharedIn: false },
  { hostName: 'friend', os: 'windows', nodeKey: 'nodekey:FRIEND', tailscaleIP: '100.64.0.14', tags: [], sharedIn: true },
]);

const failures = new Map<string, number>();
const deps: any = {
  readBody: async (req: any) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; },
  sendJson: (res: any, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); },
  log: () => {},
  legacyLoginCookie: () => null,
  legacyAuthorized: () => false,
  throttled: (k: string) => (failures.get(k) ?? 0) >= 10,
  recordFailure: (k: string) => failures.set(k, (failures.get(k) ?? 0) + 1),
  clearFailures: (k: string) => failures.delete(k),
  safeNext: (n: string | null | undefined) => (!n || !n.startsWith('/') || n.startsWith('//') ? '/' : n),
  webRoot: tmp,
  exchangeOrigins: () => [],
};

interface Out { status: number; headers: Record<string, any>; text: string; json: any }
async function call(method: string, url: string, o: { ip?: string; cookie?: string; body?: unknown; form?: Record<string, string>; host?: string; proto?: string; principal?: any } = {}): Promise<Out> {
  const raw = o.form ? new URLSearchParams(o.form).toString() : o.body !== undefined ? JSON.stringify(o.body) : '';
  const q = Readable.from(raw ? [Buffer.from(raw)] : []) as any;
  q.method = method; q.url = url;
  q.headers = { host: o.host ?? 'host.example.ts.net:8444', 'x-forwarded-for': o.ip ?? '100.64.0.10', 'x-forwarded-proto': o.proto ?? 'https',
    'content-type': o.form ? 'application/x-www-form-urlencoded' : 'application/json', ...(o.cookie ? { cookie: o.cookie } : {}) };
  q.socket = { remoteAddress: '127.0.0.1' };
  const out: Out = { status: 0, headers: {}, text: '', json: null };
  const res = { writeHead(s: number, h?: any) { out.status = s; Object.assign(out.headers, h ?? {}); }, setHeader() {}, end(x?: unknown) { out.text = String(x ?? ''); try { out.json = JSON.parse(out.text); } catch { out.json = null; } } } as unknown as ServerResponse;
  const pr = o.principal !== undefined ? o.principal : identity.resolveIdentity(q as IncomingMessage);
  const handled = await routes.handle(q as IncomingMessage, res, url.split('?')[0], '127.0.0.1', pr, deps);
  if (!handled) out.status = -1;
  return out;
}
const r0txt = (o: { text: string }): string => o.text;
const pkce = (): { verifier: string; challenge: string } => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

const hash = await identity.hashPassword('Vt7#mqz-Pk');
const acct = store.createAccount({ username: 'owner', passwordHash: hash, mustChange: false, passwordExpiresAt: null, isAdmin: true });
const login = await identity.login('owner', 'Vt7#mqz-Pk', { label: 'laptop', remember: false, req: { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as any });
const sessionCookie = `${identity.SESSION_COOKIE}=${login.sessionToken}`;
const LOOP = 'http://127.0.0.1:51789/handback';
const OWN = 'https://host.example.ts.net:8444/handback/done';
const startUrl = (p: { redirect_uri?: string; state?: string; code_challenge?: string; method?: string }): string =>
  `/handback/start?${new URLSearchParams({ redirect_uri: p.redirect_uri ?? LOOP, state: p.state ?? 'st4te', code_challenge: p.code_challenge ?? pkce().challenge, code_challenge_method: p.method ?? 'S256' })}`;

console.log('\n[GET /api/node: unauthenticated and tiny]');
let r = await call('GET', '/api/node', { principal: null });
ok(r.status === 200 && r.json.node === 'homebase' && r.json.protocolVersion === 1 && r.json.mode === 'server' && r.json.authTypes.includes('password') && r.json.authTypes.includes('tailscale'), 'answers {node, engineVersion, protocolVersion, mode, authTypes} with no credential');
ok(Object.keys(r.json).sort().join() === 'authTypes,engineVersion,mode,node,protocolVersion', '...and nothing else (no flags, no brokers, no counts)');
process.env.HARBOR_WB_IDENTITY = 'legacy';
r = await call('GET', '/api/node', { principal: null });
ok(r.status === 200 && r.json.authTypes.length === 0, 'in legacy mode it still answers, and lists no auth type (tailscale needs identity)');
process.env.HARBOR_WB_IDENTITY = 'both';

console.log('\n[start: only a full session, via the server\'s own login]');
r = await call('GET', startUrl({}), { principal: null });
ok(r.status === 302 && String(r.headers.location).startsWith('/login?next=') && decodeURIComponent(String(r.headers.location)).includes('/handback/start?'), 'no session: through /login and back (next = the start URL)');
const dev = await identity.login('owner', 'Vt7#mqz-Pk', { label: 'laptop', remember: true, req: { headers: { 'x-forwarded-for': '100.64.0.10' }, socket: { remoteAddress: '127.0.0.1' } } as any });
const deviceCookie = `${identity.DEVICE_COOKIE}=${dev.deviceToken}`;
r = await call('GET', startUrl({}), { cookie: deviceCookie });
ok(r.status === 302 && String(r.headers.location).startsWith('/login?next='), 'a DEVICE token is not enough: it goes to the login page (a stolen device token cannot mint another)');
r = await call('GET', startUrl({}), { cookie: sessionCookie });
const own = await call('GET', startUrl({ redirect_uri: OWN }), { cookie: sessionCookie });
ok(/local port 51789/.test(r0txt(await call('GET', startUrl({}), { cookie: sessionCookie }))) && /this window/.test(own.text), 'the confirm page says WHERE the code will go: "local port N" for the loopback form, "this window" for the embedded one');
ok(r.status === 200 && r.text.includes('action="/handback/approve"') && r.text.includes('owner') && !/code=/.test(r.text.replace(/code_challenge/g, '')), 'a full session sees a confirm page naming the account; no code yet');
r = await call('POST', '/handback/approve', { cookie: deviceCookie, form: { redirect_uri: LOOP, state: 's', code_challenge: pkce().challenge, code_challenge_method: 'S256' } });
ok(r.status === 403, 'approve with only a device token: 403');
r = await call('POST', '/handback/approve', { form: { redirect_uri: LOOP, state: 's', code_challenge: pkce().challenge, code_challenge_method: 'S256' }, principal: null });
ok(r.status === 403, 'approve with nothing: 403');

console.log('\n[redirect_uri: exactly two forms]');
const bad = ['http://localhost:51789/handback', 'http://[::1]:51789/handback', 'http://127.0.0.1:51789/other', 'http://user@127.0.0.1:51789/handback', 'https://evil.example/handback',
  'http://127.0.0.1:51789/handback#frag', 'http://127.0.0.1:51789/handback?x=1', 'https://host.example.ts.net:8444/handback/done?x=1', 'http://host.example.ts.net:8444/handback/done', 'https://host.example.ts.net/handback/done', 'http://127.0.0.1:0/handback', 'http://127.0.0.1:99999/handback', ''];
for (const u of bad) {
  const x = await call('GET', startUrl({ redirect_uri: u }), { cookie: sessionCookie });
  ok(x.status === 400, `refused: ${u || '(empty)'}`);
}
for (const u of [LOOP, OWN]) {
  ok((await call('GET', startUrl({ redirect_uri: u }), { cookie: sessionCookie })).status === 200, `accepted: ${u}`);
}
ok((await call('GET', startUrl({ method: 'plain' }), { cookie: sessionCookie })).status === 400, 'a plain (non-S256) challenge is refused');
ok((await call('GET', startUrl({ code_challenge: 'short' }), { cookie: sessionCookie })).status === 400, 'a malformed challenge is refused');
ok((await call('GET', startUrl({ state: '' }), { cookie: sessionCookie })).status === 400, 'a missing state is refused');

console.log('\n[approve -> code in the QUERY -> exchange sets the device cookie]');
async function approve(redirect = LOOP, ip = '100.64.0.10', ch = pkce()): Promise<{ code: string; state: string; verifier: string; out: Out }> {
  const out = await call('POST', '/handback/approve', { cookie: sessionCookie, ip, form: { redirect_uri: redirect, state: 'S-1', code_challenge: ch.challenge, code_challenge_method: 'S256' } });
  const loc = String(out.headers.location ?? '');
  const u = new URL(loc, 'https://x');
  return { code: u.searchParams.get('code') ?? '', state: u.searchParams.get('state') ?? '', verifier: ch.verifier, out };
}
let a = await approve();
ok(a.out.status === 303 && a.out.headers.location.startsWith(`${LOOP}?code=`) && a.state === 'S-1' && a.code.length === 43, 'approve: 303 to redirect_uri?code=&state= (query)');
ok(!a.out.headers.location.includes('#'), '...never a fragment');
r = await call('POST', '/api/device/exchange', { principal: null, body: { code: a.code, code_verifier: a.verifier } });
ok(r.status === 200 && r.json.ok === true && !r.text.includes(a.code), 'exchange: 200 {ok:true}, and no token in the body');
const setCookie = String(r.headers['set-cookie'] ?? '');
ok(setCookie.startsWith(`${identity.DEVICE_COOKIE}=`) && /HttpOnly/.test(setCookie) && /Secure/.test(setCookie), 'the device cookie (homelab_device, HttpOnly, Secure behind Serve) is SET');
const token = setCookie.split(';')[0].split('=')[1];
const pr = identity.resolveIdentity({ headers: { cookie: `${identity.DEVICE_COOKIE}=${token}`, 'x-forwarded-for': '100.64.0.10' }, socket: { remoteAddress: '127.0.0.1' } } as any);
ok(pr?.via === 'device' && pr.username === 'owner', 'that cookie is a device principal for the account');
const row = store.deviceByToken(token);
ok(row?.tailnet_key === 'nodekey:LAPTOP' && !!row.label, 'the device row is bound to the node KEY of the machine that approved');
r = await call('POST', '/api/device/exchange', { principal: null, body: { code: a.code, code_verifier: a.verifier } });
ok(r.status === 400 && r.json.error === 'invalid_grant', 'the same code a second time: refused');

console.log('\n[a code gets ONE try]');
a = await approve();
r = await call('POST', '/api/device/exchange', { principal: null, body: { code: a.code, code_verifier: pkce().verifier } });
ok(r.status === 400, 'wrong verifier: refused');
r = await call('POST', '/api/device/exchange', { principal: null, body: { code: a.code, code_verifier: a.verifier } });
ok(r.status === 400, '...and the code is burned: the RIGHT verifier afterwards is refused too');
a = await approve();
r = await call('POST', '/api/device/exchange', { principal: null, ip: '100.64.0.11', body: { code: a.code, code_verifier: a.verifier } });
ok(r.status === 400, 'a different device\'s evidence (another node key): refused');
a = await approve();
r = await call('POST', '/api/device/exchange', { principal: null, ip: '100.64.0.99', body: { code: a.code, code_verifier: a.verifier } });
ok(r.status === 200, 'evidence we cannot place is not a mismatch: accepted (three outcomes)');
process.env.HARBOR_WB_HANDBACK_TTL_MS = '30';
a = await approve();
await new Promise((res) => setTimeout(res, 80));
r = await call('POST', '/api/device/exchange', { principal: null, body: { code: a.code, code_verifier: a.verifier } });
ok(r.status === 400, 'an expired code: refused');
delete process.env.HARBOR_WB_HANDBACK_TTL_MS;
for (const bodyBad of [{}, { code: 'x', code_verifier: 'y' }, { code: 5, code_verifier: 5 }, { code: a.code }]) {
  ok((await call('POST', '/api/device/exchange', { principal: null, body: bodyBad })).status === 400, `malformed body refused: ${JSON.stringify(bodyBad).slice(0, 40)}`);
}
ok(!store.deviceByToken('anything'), 'no device was minted by any refusal');

console.log('\n[the embedded-window form]');
a = await approve(OWN);
ok(a.out.headers.location.startsWith(`${OWN}?code=`), 'redirect to this server\'s own /handback/done');
r = await call('GET', '/handback/done', { principal: null });
ok(r.status === 200 && !/code/i.test(r.text), '/handback/done is a plain page that carries no code');

console.log('\n[an account that must change its password gets nothing]');
store.setPassword(acct.id, hash, { mustChange: true, passwordExpiresAt: Date.now() + 60_000 });
const temp = await identity.login('owner', 'Vt7#mqz-Pk', { label: 'x', remember: false, req: { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as any });
const tempCookie = `${identity.SESSION_COOKIE}=${temp.sessionToken}`;
r = await call('GET', startUrl({}), { cookie: tempCookie });
ok(r.status === 403 && /Change your temporary password/.test(r.text), 'start: refused with a plain page');
r = await call('POST', '/handback/approve', { cookie: tempCookie, form: { redirect_uri: LOOP, state: 's', code_challenge: pkce().challenge, code_challenge_method: 'S256' } });
ok(r.status === 403, 'approve: refused');
store.setPassword(acct.id, hash, { mustChange: false, passwordExpiresAt: null });
await new Promise((res) => setTimeout(res, 5));
const login2 = await identity.login('owner', 'Vt7#mqz-Pk', { label: 'laptop', remember: false, req: { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as any });
const cookie2 = `${identity.SESSION_COOKIE}=${login2.sessionToken}`;
a = await (async () => { const ch = pkce(); const out = await call('POST', '/handback/approve', { cookie: cookie2, form: { redirect_uri: LOOP, state: 'q', code_challenge: ch.challenge, code_challenge_method: 'S256' } }); return { code: new URL(String(out.headers.location)).searchParams.get('code') ?? '', verifier: ch.verifier, state: '', out }; })();
store.setPassword(acct.id, hash, { mustChange: true, passwordExpiresAt: Date.now() + 60_000 });
r = await call('POST', '/api/device/exchange', { principal: null, body: { code: a.code, code_verifier: a.verifier } });
ok(r.status === 400, 'a code issued before the account was put back on a temp password cannot be exchanged');
store.setPassword(acct.id, hash, { mustChange: false, passwordExpiresAt: null });
await new Promise((res) => setTimeout(res, 5));
const login3 = await identity.login('owner', 'Vt7#mqz-Pk', { label: 'laptop', remember: false, req: { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as any });
const cookie3 = `${identity.SESSION_COOKIE}=${login3.sessionToken}`;

console.log('\n[the owner\'s optional refusal of tagged and shared-in devices]');
const startFrom = (ip: string): Promise<Out> => call('GET', startUrl({}), { cookie: cookie3, ip });
ok((await startFrom('100.64.0.13')).status === 200 && (await startFrom('100.64.0.14')).status === 200, 'default: tagged and shared-in devices ARE allowed (Tailscale is reach control)');
process.env.HARBOR_WB_DEVICE_REFUSE_SHARED = '1';
ok((await startFrom('100.64.0.13')).status === 403 && (await startFrom('100.64.0.14')).status === 403, 'owner setting on: both refused');
ok((await startFrom('100.64.0.10')).status === 200 && (await startFrom('100.64.0.99')).status === 200, '...an ordinary device and an unplaceable one are not');
delete process.env.HARBOR_WB_DEVICE_REFUSE_SHARED;

console.log('\n[revoke: the device revokes itself]');
a = await (async () => { const ch = pkce(); const out = await call('POST', '/handback/approve', { cookie: cookie3, form: { redirect_uri: LOOP, state: 'q', code_challenge: ch.challenge, code_challenge_method: 'S256' } }); return { code: new URL(String(out.headers.location)).searchParams.get('code') ?? '', verifier: ch.verifier, state: '', out }; })();
r = await call('POST', '/api/device/exchange', { principal: null, body: { code: a.code, code_verifier: a.verifier } });
const tok2 = String(r.headers['set-cookie']).split(';')[0].split('=')[1];
const probe = (): any => identity.resolveIdentity({ headers: { cookie: `${identity.DEVICE_COOKIE}=${tok2}`, 'x-forwarded-for': '100.64.0.10' }, socket: { remoteAddress: '127.0.0.1' } } as any);
ok(probe()?.via === 'device', 'the new device works');
ok((await call('GET', '/api/node', { principal: probe() })).status === 200, '(and a device principal may still read /api/node)');
const rv = await call('POST', '/api/device/revoke', { cookie: `${identity.DEVICE_COOKIE}=${tok2}`, principal: null });
ok(rv.status === 200 && rv.json.ok === true && /Max-Age=0/.test(String(rv.headers['set-cookie'])), 'revoke: 200, and the cookie is cleared');
ok(probe() === null, 'the revoked device is refused on its next call');
ok((await call('POST', '/api/device/revoke', { cookie: `${identity.DEVICE_COOKIE}=${tok2}`, principal: null })).status === 401, 'revoking again: 401');
ok((await call('POST', '/api/device/revoke', { principal: null })).status === 401, 'revoke with no cookie: 401');
const lu = store.listDevices(acct.id).find((d) => d.token_hash === store.hashToken(tok2));
ok(!!lu && lu.last_used_at !== null && lu.revoked_at !== null, 'the device row keeps "last used" and the revoke time (the owner\'s device list shows them)');

console.log('\n[exchange has its own limit]');
failures.clear();
let blocked = 0;
for (let i = 0; i < 14; i++) {
  const x = await call('POST', '/api/device/exchange', { principal: null, body: { code: randomBytes(32).toString('base64url'), code_verifier: pkce().verifier }, ip: '100.64.0.11' });
  if (x.status === 429) blocked++;
}
ok(blocked >= 3, `after 10 failures from one device the rest are 429 (${blocked} blocked)`);
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
