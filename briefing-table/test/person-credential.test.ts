/**
 * WHO COUNTS AS A PERSON (server/person.ts) and the ticket -> identity session path. An agent that holds the shared bearer can compute the legacy cookie; where identity exists
 * that cookie is not a person. An engine-opened window (a redeemed ticket) gets an identity session and so still is one. In-process, no engine, no ports.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'wb-person-'));
const TOKEN = 'agent-readable-shared-bearer';
process.env.HARBOR_WB_TOKEN = TOKEN;
process.env.HARBOR_WB_IDENTITY = 'both';
process.env.HARBOR_WB_IDENTITY_DB = join(dir, 'identity.db');
delete process.env.HARBOR_WB_WINDOW_USER;

const auth = await import('../src/server/auth.ts');
const idAuth = await import('../src/identity/auth.ts');
const store = await import('../src/identity/store.ts');
const { humanCredential } = await import('../src/server/person.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };
const req = (headers: Record<string, string>): any => ({ headers });
// what ANY agent that reads the bearer can compute
const forged = `wb_auth=${createHash('sha256').update(`wb-cookie:${TOKEN}`).digest('hex')}`;

console.log('\n[the forged legacy cookie, identity on (mode both)]');
ok(auth.authorized(req({ cookie: forged })), 'sanity: the engine accepts the forged cookie as a credential (it must still open ordinary routes)');
ok(!humanCredential(req({ cookie: forged }), null), 'but it is NOT a person');
ok(!humanCredential(req({ cookie: forged, authorization: `Bearer ${TOKEN}` }), null), 'with the bearer header too: not a person');

const acct = store.createAccount({ username: 'owner', passwordHash: await idAuth.hashPassword('Vt7#mqz-Pk-long'), mustChange: false, passwordExpiresAt: null, isAdmin: true });
const sess = (via: 'session' | 'device' | 'api_token'): any => ({ userId: acct.id, username: 'owner', via, isAdmin: true, mustChangePassword: false, sessionId: null, credentialCreatedAt: 1, credentialName: null, credentialId: null, evidence: null });
ok(humanCredential(req({ cookie: 'homelab_session=x' }), sess('session')), 'an identity session is a person');
ok(humanCredential(req({ cookie: 'homelab_device=x' }), sess('device')), 'a remembered device is a person');
ok(!humanCredential(req({}), sess('api_token')), 'a personal API token is not');
ok(!humanCredential(req({ authorization: 'Bearer x', cookie: 'homelab_session=x' }), sess('session')), 'an Authorization header disqualifies even a session cookie');

console.log('\n[identity off: the legacy cookie is the only credential, unchanged]');
process.env.HARBOR_WB_IDENTITY = 'legacy';
ok(humanCredential(req({ cookie: forged }), null), 'mode legacy (and local mode): the legacy cookie still counts');
ok(!humanCredential(req({ cookie: 'wb_auth=wrong' }), null), '...a wrong cookie does not');
process.env.HARBOR_WB_IDENTITY = 'both';

console.log('\n[a launch ticket becomes an identity session ONLY when it was minted FOR A PERSON]');
const t1 = auth.mintTicket(); // a bearer, a service or the engine itself: no account
const r1 = auth.redeemTicket(t1);
ok(r1.ok && r1.userId === null, 'a ticket with no person redeems once');
ok(!auth.redeemTicket(t1).ok, '...and only once');
ok(idAuth.sessionCookieForTicket(r1.userId, false) === null, 'NO account on the ticket: no identity session (the legacy cookie path), even with exactly one enabled account');
process.env.HARBOR_WB_WINDOW_USER = 'owner';
ok(idAuth.sessionCookieForTicket(null, false) === null, 'HARBOR_WB_WINDOW_USER is gone: naming an owner does not turn a person-less ticket into a session');
delete process.env.HARBOR_WB_WINDOW_USER;
ok(typeof (idAuth as any).windowOwner === 'undefined', 'and there is no windowOwner() fallback any more');
const t2 = auth.mintTicket(acct.id); // minted for a signed-in person
const r2 = auth.redeemTicket(t2);
ok(r2.ok && r2.userId === acct.id, 'a ticket minted for a person carries that account');
const c1 = idAuth.sessionCookieForTicket(r2.userId, false);
ok(!!c1 && c1.startsWith('homelab_session='), 'and redeems to an identity session cookie');
const token1 = c1!.split(';')[0].split('=')[1];
const principal = idAuth.resolveIdentity(req({ cookie: `homelab_session=${token1}` }));
ok(!!principal && principal.via === 'session' && principal.username === 'owner', 'which resolves to that person');
ok(humanCredential(req({ cookie: `homelab_session=${token1}` }), principal), '...and IS a person');
const acct2 = store.createAccount({ username: 'guest', passwordHash: await idAuth.hashPassword('Vt7#mqz-Pk-long2'), mustChange: false, passwordExpiresAt: null, isAdmin: false });
ok(!!idAuth.sessionCookieForTicket(acct2.id, true)?.includes('Secure'), 'an explicit account on https gets a Secure cookie');
const mc = store.createAccount({ username: 'newbie', passwordHash: await idAuth.hashPassword('Vt7#mqz-Pk-long3'), mustChange: true, passwordExpiresAt: null, isAdmin: false });
ok(idAuth.sessionCookieForTicket(mc.id, false) === null, 'an account that must change its password gets no ticket session');
process.env.HARBOR_WB_IDENTITY = 'legacy';
ok(idAuth.sessionCookieForTicket(acct.id, false) === null, 'identity off: no session (the legacy cookie path)');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
