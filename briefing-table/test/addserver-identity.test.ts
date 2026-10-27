/**
 * ADD A SERVER, engine side, part 1 (the design notes sections 10, 12): a remembered device binds to the node KEY, not a hostname or an address; a temp-code
 * account is never given a remembered device. A scratch identity db and a made-up tailnet.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';

const tmp = mkdtempSync(join(tmpdir(), 'wb-addsrv-id-'));
process.env.HARBOR_WB_IDENTITY_DB = join(tmp, 'identity.db');
process.env.HARBOR_WB_IDENTITY = 'both';
process.env.HARBOR_WB_BEHIND_SERVE = '1';

const store = await import('../src/identity/store.ts');
const identity = await import('../src/identity/auth.ts');
const ev = await import('../src/identity/tailnet-evidence.ts');
const tailnet = await import('../src/engine/tailnet.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };

const peers = [
  { hostName: 'laptop', os: 'windows', nodeKey: 'nodekey:AAAA', tailscaleIP: '100.64.0.10', tags: [], sharedIn: false },
  { hostName: 'localhost', os: 'iOS', nodeKey: 'nodekey:PHONE1', tailscaleIP: '100.64.0.11', tags: [], sharedIn: false },
  { hostName: 'localhost', os: 'iOS', nodeKey: 'nodekey:PHONE2', tailscaleIP: '100.64.0.12', tags: [], sharedIn: false },
  { hostName: 'router', os: 'linux', nodeKey: 'nodekey:ROUTER', tailscaleIP: '100.64.0.13', tags: ['tag:routers'], sharedIn: false },
  { hostName: 'friends-pc', os: 'windows', nodeKey: 'nodekey:SHARED', tailscaleIP: '100.64.0.14', tags: [], sharedIn: true },
];
tailnet._setPeersForTest(peers, null);

const viaServe = (ip: string): IncomingMessage => ({ headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
const direct = (ip: string): IncomingMessage => ({ headers: {}, socket: { remoteAddress: ip } }) as unknown as IncomingMessage;

console.log('\n[evidence carries the node key for BOTH sources]');
const a = ev.evidenceFor(viaServe('100.64.0.10'));
const b = ev.evidenceFor(direct('100.64.0.10'));
ok(a.kind === 'serve-xff' && a.key === 'nodekey:AAAA', 'behind Serve: key = the node key');
ok(b.kind === 'peer' && b.key === 'nodekey:AAAA' && b.node === 'laptop', 'direct: the same key, and `node` is still the hostname');
ok(ev.evidenceFor(viaServe('100.64.0.13')).tags.includes('tag:routers') && ev.evidenceFor(viaServe('100.64.0.14')).sharedIn === true, 'tags and shared-in ride along (for the owner\'s optional refusal)');
ok(ev.evidenceFor(viaServe('100.64.0.99')).key === null && ev.evidenceFor(viaServe('100.64.0.99')).sharedIn === null, 'an address we cannot place: key null, sharedIn null (could not tell)');

console.log('\n[checkDevice: key to key]');
const row = (o: object): any => ({ tailnet_node: null, tailnet_ip: null, tailnet_key: null, ...o });
ok(ev.checkDevice(row({ tailnet_key: 'nodekey:AAAA', tailnet_node: 'nodekey:AAAA' }), b).ok, 'minted behind Serve, presented on a direct connection: accepted (same key)');
ok(ev.checkDevice(row({ tailnet_key: 'nodekey:AAAA', tailnet_node: 'laptop' }), a).ok, 'minted direct (hostname recorded), presented behind Serve: accepted');
ok(!ev.checkDevice(row({ tailnet_key: 'nodekey:AAAA' }), ev.evidenceFor(viaServe('100.64.0.11'))).ok, 'a different device\'s key is refused');
const p1 = ev.evidenceFor(viaServe('100.64.0.11'));
const p2 = ev.evidenceFor(viaServe('100.64.0.12'));
ok(p1.node !== p2.node && ev.checkDevice(row({ tailnet_key: p1.key }), p2).ok === false, 'two phones that both call themselves "localhost" bind to their own keys');
ok(ev.checkDevice(row({ tailnet_node: 'laptop' }), b).ok && !ev.checkDevice(row({ tailnet_node: 'laptop' }), ev.evidenceFor(direct('100.64.0.13'))).ok, 'a legacy row (no key) keeps today\'s hostname behaviour');
ok(ev.checkDevice(row({ tailnet_key: 'nodekey:AAAA' }), ev.evidenceFor(viaServe('100.64.0.99'))).ok, 'evidence we cannot place is not a mismatch (three outcomes)');
ok(ev.checkDevice(row({ tailnet_key: 'nodekey:AAAA' }), ev.evidenceFor({ headers: {}, socket: { remoteAddress: '127.0.0.1' } } as any)).ok, 'no evidence at all: the token stands on its own strength');

console.log('\n[a remembered device records the key]');
const hash = await identity.hashPassword('Vt7#mqz-Pk');
const acct = store.createAccount({ username: 'owner', passwordHash: hash, mustChange: false, passwordExpiresAt: null, isAdmin: true });
const withReq = (r: IncomingMessage): IncomingMessage => r;
const settled = await identity.login('owner', 'Vt7#mqz-Pk', { label: 'laptop', remember: true, req: withReq(viaServe('100.64.0.10')) });
ok(!!settled.deviceToken, 'a settled account gets a device with remember');
const dev = store.deviceByToken(settled.deviceToken!);
ok(dev?.tailnet_key === 'nodekey:AAAA', 'the device row records the node key');

console.log('\n[a temp-code account never gets a remembered device]');
store.setPassword(acct.id, hash, { mustChange: true, passwordExpiresAt: Date.now() + 60_000 });
const temp = await identity.login('owner', 'Vt7#mqz-Pk', { label: 'laptop', remember: true, req: withReq(viaServe('100.64.0.10')) });
ok(temp.ok && !!temp.sessionToken && !temp.deviceToken, 'remember:true on a must-change account: a session (so the change page works) but NO device');
const pk = identity.loginWithPasskey(store.accountById(acct.id)!, { label: 'x', remember: true, req: withReq(viaServe('100.64.0.10')) });
ok(pk.ok && !pk.deviceToken, 'the passkey door follows the same rule');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
