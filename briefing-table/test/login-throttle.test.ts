/**
 * THE LOGIN THROTTLE behind Serve (identity/login-throttle.ts): per client NODE KEY (else address), per account name, and a global cap; wired into the password and
 * passkey doors. Behind Serve every remote caller is 127.0.0.1, so the old per-address bucket was ONE bucket for everyone.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

const tmp = mkdtempSync(join(tmpdir(), 'wb-throttle-'));
process.env.HARBOR_WB_IDENTITY_DB = join(tmp, 'identity.db');
process.env.HARBOR_WB_IDENTITY = 'both';
process.env.HARBOR_WB_BEHIND_SERVE = '1';

const store = await import('../src/identity/store.ts');
const identity = await import('../src/identity/auth.ts');
const routes = await import('../src/identity/routes.ts');
const th = await import('../src/identity/login-throttle.ts');
const tailnet = await import('../src/engine/tailnet.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };

tailnet._setPeersForTest([
  { hostName: 'laptop', os: 'windows', nodeKey: 'nodekey:LAPTOP', tailscaleIP: '100.64.0.10' },
  { hostName: 'phone', os: 'iOS', nodeKey: 'nodekey:PHONE', tailscaleIP: '100.64.0.11' },
  ...Array.from({ length: 12 }, (_, i) => ({ hostName: `pc${i}`, os: 'linux', nodeKey: `nodekey:PC${i}`, tailscaleIP: `100.64.1.${i + 1}` })),
]);
const deps: any = {
  readBody: async (req: any) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; },
  sendJson: (res: any, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); },
  log: () => {}, legacyLoginCookie: () => null, legacyAuthorized: () => false,
  throttled: () => false, recordFailure: () => {}, clearFailures: () => {},
  safeNext: (n: any) => (n && String(n).startsWith('/') ? n : '/'), webRoot: tmp, exchangeOrigins: () => [],
};
async function post(ip: string, username: string, password: string): Promise<{ status: number; text: string; headers: any }> {
  const q = Readable.from([Buffer.from(JSON.stringify({ username, password }))]) as any;
  q.method = 'POST'; q.url = '/login';
  q.headers = { host: 'homebase.example', 'x-forwarded-for': ip, 'content-type': 'application/json', accept: 'application/json' };
  q.socket = { remoteAddress: '127.0.0.1' };
  const out = { status: 0, text: '', headers: {} as any };
  const res = { writeHead(s: number, h?: any) { out.status = s; Object.assign(out.headers, h ?? {}); }, setHeader() {}, end(x?: unknown) { out.text = String(x ?? ''); } } as unknown as ServerResponse;
  await routes.handle(q as IncomingMessage, res, '/login', '127.0.0.1', null, deps);
  return out;
}
const hash = await identity.hashPassword('Vt7#mqz-Pk');
store.createAccount({ username: 'owner', passwordHash: hash, mustChange: false, passwordExpiresAt: null, isAdmin: true });
const slow = (o: { status: number; text: string }): boolean => /Too many attempts/.test(o.text) || o.status === 429;

console.log('\n[one guesser does not lock the others out (the Serve bug)]');
th._reset();
for (let i = 0; i < 10; i++) await post('100.64.0.10', 'owner', 'wrong');
ok(slow(await post('100.64.0.10', 'owner', 'wrong')), 'the 11th attempt from the same device (same node key) is throttled');
ok(slow(await post('100.64.0.10', 'owner', 'Vt7#mqz-Pk')), '...even with the right password (the throttle fires first)');
const other = await post('100.64.0.11', 'owner', 'Vt7#mqz-Pk');
ok(!slow(other) && (other.status === 200 || other.status === 303), 'a DIFFERENT device behind the same Serve (127.0.0.1) can still sign in');

console.log('\n[a guesser who rotates devices hits the account bucket]');
th._reset();
let blockedAt = 0;
for (let i = 0; i < 25; i++) {
  const r = await post(`100.64.1.${(i % 12) + 1}`, 'owner', 'wrong');
  if (slow(r) && !blockedAt) blockedAt = i + 1;
}
ok(blockedAt === 21, `20 wrong guesses at the account from 12 rotating devices, the 21st is throttled (blocked at ${blockedAt})`);
ok(slow(await post('100.64.0.11', 'owner', 'Vt7#mqz-Pk')), '...for every device, until the window passes');

console.log('\n[an unknown name is counted the same way]');
th._reset();
for (let i = 0; i < 20; i++) await post(`100.64.1.${(i % 12) + 1}`, 'nobody', 'x');
ok(slow(await post('100.64.0.10', 'nobody', 'x')), 'a name that does not exist is throttled like one that does (no account-existence signal)');

console.log('\n[the global cap]');
th._reset();
process.env.HARBOR_WB_LOGIN_MAX_ACCOUNT = '1000';
process.env.HARBOR_WB_LOGIN_MAX_CLIENT = '1000';
for (let i = 0; i < 60; i++) await post(`100.64.1.${(i % 12) + 1}`, `user${i}`, 'x');
ok(slow(await post('100.64.0.10', 'owner', 'Vt7#mqz-Pk')), '60 failures across everyone throttle everyone (the last resort)');
delete process.env.HARBOR_WB_LOGIN_MAX_ACCOUNT;
delete process.env.HARBOR_WB_LOGIN_MAX_CLIENT;

console.log('\n[success clears the client and the account, not the global count]');
th._reset();
for (let i = 0; i < 9; i++) await post('100.64.0.10', 'owner', 'wrong');
const good = await post('100.64.0.10', 'owner', 'Vt7#mqz-Pk');
ok(good.status === 200 || good.status === 303, 'under the limit, the right password signs in');
for (let i = 0; i < 9; i++) await post('100.64.0.10', 'owner', 'wrong');
ok(!slow(await post('100.64.0.10', 'owner', 'wrong')), 'and the counters restarted: 9 more wrong guesses are still under the limit');

console.log('\n[the window passes]');
th._reset();
process.env.HARBOR_WB_LOGIN_WINDOW_MS = '4000';
for (let i = 0; i < 10; i++) await post('100.64.0.10', 'owner', 'wrong');
ok(slow(await post('100.64.0.10', 'owner', 'wrong')), 'throttled inside the window');
await new Promise((r) => setTimeout(r, 4200));
const after = await post('100.64.0.10', 'owner', 'Vt7#mqz-Pk');
ok(!slow(after), 'and free again after it');
delete process.env.HARBOR_WB_LOGIN_WINDOW_MS;

console.log('\n[no evidence: the socket address is the key]');
th._reset();
const noEv = (): IncomingMessage => ({ headers: {}, socket: { remoteAddress: '203.0.113.9' } }) as unknown as IncomingMessage;
ok(th.clientKey(noEv()) === 'addr:203.0.113.9', 'a request with no evidence is keyed by its address');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
