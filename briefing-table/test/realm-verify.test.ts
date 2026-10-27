/**
 * R6a: the realm JWT verifier (src/identity/realm.ts), in-process, no network:
 * discovery + JWKS come from an injected fetchJson, the clock is fake.
 * ID-token rules, engine-ticket rules, JWKS refresh on an unknown kid, and the
 * cached-JWKS outage path. The engine half is test/realm-engine.test.ts.
 */
import { generateKeyPairSync, createHmac, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { createVerifier, TICKET_MARKER, config } from '../src/identity/realm.ts';

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

const ISS = 'https://realm.test';
const AUD = 'engine-client';
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

function mkKey(kind: 'rsa' | 'ec', kid: string) {
  const { privateKey, publicKey } =
    kind === 'rsa' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig' } };
}

function signJwt(header: Record<string, unknown>, claims: Record<string, unknown>, key: KeyObject): string {
  const data = `${b64(header)}.${b64(claims)}`;
  const alg = String(header.alg);
  const sig = alg.startsWith('ES')
    ? cryptoSign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' })
    : cryptoSign('sha256', Buffer.from(data), key);
  return `${data}.${sig.toString('base64url')}`;
}

let clock = Date.parse('2026-10-20T12:00:00Z');
const nowS = () => Math.floor(clock / 1000);
const rsa = mkKey('rsa', 'k-rsa');
const ec = mkKey('ec', 'k-ec');
let served = [rsa.jwk];
let reachable = true;
let jwksFetches = 0;
const fetchJson = async (url: string) => {
  if (!reachable) throw new Error('ECONNREFUSED');
  if (url === `${ISS}/.well-known/openid-configuration`) {
    return { issuer: ISS, authorization_endpoint: `${ISS}/oidc/auth`, token_endpoint: `${ISS}/oidc/token`, jwks_uri: `${ISS}/oidc/jwks` };
  }
  if (url === `${ISS}/oidc/jwks`) {
    jwksFetches++;
    return { keys: served };
  }
  throw new Error('404');
};
const mk = () => createVerifier({ issuer: ISS, fetchJson, now: () => clock, minRefreshMs: 0 });

const idClaims = (extra: Record<string, unknown> = {}) => ({
  iss: ISS, aud: AUD, sub: 'user-1', iat: nowS(), exp: nowS() + 3600, nonce: 'n1', ...extra,
});
const tkClaims = (extra: Record<string, unknown> = {}) => ({
  iss: ISS, aud: AUD, sub: 'user-1', iat: nowS(), exp: nowS() + 60, jti: `j-${Math.random()}`, purpose: TICKET_MARKER.purpose, device_id: 'dev-1', ...extra,
});
const RS = { alg: 'RS256', kid: 'k-rsa', typ: 'JWT' };

async function run(): Promise<void> {
  const v = mk();
  const idt = (claims = idClaims(), header: Record<string, unknown> = RS, key = rsa.privateKey) =>
    v.verify(signJwt(header, claims, key), { audience: AUD, nonce: 'n1' });

  console.log('[id token]');
  let r = await idt();
  ok(r.ok, 'a good RS256 ID token verifies');
  r = await idt(idClaims({ iss: 'https://evil.test' }));
  ok(!r.ok && r.reason === 'iss', 'wrong iss refused');
  r = await idt(idClaims({ aud: 'workbench' }));
  ok(!r.ok && r.reason === 'aud', 'wrong aud refused');
  r = await idt(idClaims({ aud: [AUD, 'other'] }));
  ok(!r.ok && r.reason === 'azp', 'multi-aud without azp refused');
  r = await idt(idClaims({ exp: nowS() - 61 }));
  ok(!r.ok && r.reason === 'expired', 'expired beyond 60 s skew refused');
  r = await idt(idClaims({ exp: nowS() - 30 }));
  ok(r.ok, 'expired within 60 s skew accepted');
  r = await idt(idClaims({ nbf: nowS() + 120 }));
  ok(!r.ok && r.reason === 'nbf', 'nbf in the future beyond skew refused');
  r = await idt(idClaims({ iat: nowS() + 120 }));
  ok(!r.ok && r.reason === 'iat', 'iat in the future beyond skew refused');
  r = await idt(idClaims({ nonce: 'other' }));
  ok(!r.ok && r.reason === 'nonce', 'wrong nonce refused');
  r = await idt(idClaims({ sub: '' }));
  ok(!r.ok && r.reason === 'sub', 'empty sub refused');

  const none = `${b64({ alg: 'none', kid: 'k-rsa' })}.${b64(idClaims())}.`;
  r = await v.verify(none, { audience: AUD, nonce: 'n1' });
  ok(!r.ok && r.reason === 'alg', 'alg none refused');
  const hsData = `${b64({ alg: 'HS256', kid: 'k-rsa' })}.${b64(idClaims())}`;
  const hs = `${hsData}.${createHmac('sha256', 'secret').update(hsData).digest('base64url')}`;
  r = await v.verify(hs, { audience: AUD, nonce: 'n1' });
  ok(!r.ok && r.reason === 'alg', 'HS256 refused');
  const tampered = (await Promise.resolve(signJwt(RS, idClaims(), rsa.privateKey))).split('.');
  tampered[1] = b64(idClaims({ sub: 'someone-else' }));
  r = await v.verify(tampered.join('.'), { audience: AUD, nonce: 'n1' });
  ok(!r.ok && r.reason === 'signature', 'tampered payload refused (signature)');
  r = await idt(idClaims(), { alg: 'RS256', kid: 'k-rsa' }, mkKey('rsa', 'x').privateKey);
  ok(!r.ok && r.reason === 'signature', 'signed by a foreign key refused');
  r = await idt(idClaims(), { alg: 'ES256', kid: 'k-rsa' });
  ok(!r.ok && r.reason === 'alg-key-mismatch', 'ES256 header on an RSA key refused');
  r = await idt(idClaims(), { alg: 'RS256', kid: 'k-rsa', crit: ['exp'] });
  ok(!r.ok && r.reason === 'crit', 'crit header refused');
  r = await idt(idClaims({ purpose: TICKET_MARKER.purpose }));
  ok(!r.ok && r.reason === 'ticket-as-id-token', 'a ticket-marked token is not accepted as an ID token');

  console.log('\n[jwks]');
  served = [rsa.jwk, ec.jwk];
  const before = jwksFetches;
  r = await idt(idClaims(), { alg: 'ES256', kid: 'k-ec' }, ec.privateKey);
  ok(r.ok && jwksFetches === before + 1, 'unknown kid -> one JWKS refresh -> ES256 verifies');
  r = await idt(idClaims(), { alg: 'RS256', kid: 'k-none' });
  ok(!r.ok && r.reason === 'unknown-kid', 'a kid the realm does not publish is refused');
  {
    /* platform [ref]: a stream of unknown kids must not become a fetch storm.
       Default gate (60 s), on a verifier whose cache is fresh and one whose
       cache has gone stale. */
    const gated = createVerifier({ issuer: ISS, fetchJson, now: () => clock });
    const sign = (kid: string) => signJwt({ alg: 'RS256', kid, typ: 'JWT' }, idClaims(), rsa.privateKey);
    await gated.verify(sign('k-rsa'), { audience: AUD, nonce: 'n1' });
    const f0 = jwksFetches;
    for (let i = 0; i < 20; i++) await gated.verify(sign(`k-bogus-${i}`), { audience: AUD, nonce: 'n1' });
    ok(jwksFetches - f0 <= 1, `20 unknown kids within a minute -> at most one JWKS fetch (${jwksFetches - f0})`);
    clock += 2 * 60 * 60 * 1000; // the cache is now stale
    const f1 = jwksFetches;
    for (let i = 0; i < 20; i++) await gated.verify(sign(`k-stale-${i}`), { audience: AUD, nonce: 'n1' });
    ok(jwksFetches - f1 <= 1, `a stale cache does not lift the gate: 20 unknown kids -> at most one fetch (${jwksFetches - f1})`);
    clock -= 2 * 60 * 60 * 1000;
  }
  reachable = false;
  r = await idt();
  ok(r.ok, 'realm unreachable, cached JWKS: still verifies');
  clock += 2 * 60 * 60 * 1000; // past fresh, within grace
  r = await idt();
  ok(r.ok, 'realm unreachable, stale cache within grace: still verifies');
  r = await idt(idClaims(), { alg: 'RS256', kid: 'k-new' });
  ok(!r.ok && r.reason === 'realm-unreachable' && r.unreachable, 'unreachable + unknown kid: clear realm-unreachable failure');
  clock += 2 * 24 * 60 * 60 * 1000; // past grace
  r = await idt();
  ok(!r.ok && r.reason === 'realm-unreachable', 'cache past its grace: refused as unreachable');
  const cold = mk();
  r = await cold.verify(signJwt(RS, idClaims(), rsa.privateKey), { audience: AUD, nonce: 'n1' });
  ok(!r.ok && r.reason === 'realm-unreachable' && r.unreachable, 'no cache and no realm: clear realm-unreachable failure');
  reachable = true;

  console.log('\n[engine ticket]');
  const t = mk();
  const TK = { ...RS, typ: TICKET_MARKER.typ };
  const tk = (claims = tkClaims(), header: Record<string, unknown> = TK, key = rsa.privateKey) =>
    t.verify(signJwt(header, claims, key), { audience: AUD, ticket: true });
  r = await tk();
  ok(r.ok, `a ticket with BOTH markers (typ ${TICKET_MARKER.typ} + purpose ${TICKET_MARKER.purpose}) verifies`);
  r = await tk(tkClaims({ device_id: 'dev-123' }));
  ok(r.ok && r.claims.device_id === 'dev-123', 'device_id is carried through');
  r = await tk(tkClaims({ device_id: undefined }));
  ok(!r.ok && r.reason === 'device-id', 'a ticket with no device_id refused (required, platform [ref])');
  r = await tk(tkClaims({ device_id: 'bad id\n' }));
  ok(!r.ok && r.reason === 'device-id', 'a device_id outside the safe charset refused');
  r = await tk(tkClaims(), RS);
  ok(!r.ok && r.reason === 'not-a-ticket', 'purpose claim without the typ header refused');
  r = await tk(tkClaims({ purpose: undefined }));
  ok(!r.ok && r.reason === 'not-a-ticket', 'typ header without the purpose claim refused');
  r = await tk(tkClaims({ purpose: undefined }), RS);
  ok(!r.ok && r.reason === 'not-a-ticket', 'no marker refused');
  r = await tk(tkClaims(), { ...TK, alg: 'ES256', kid: 'k-ec' }, ec.privateKey);
  ok(!r.ok && r.reason === 'alg', 'an ES256 ticket refused (RS256 only)');
  r = await tk(tkClaims({ iat: nowS() + 31, exp: nowS() + 60 }));
  ok(!r.ok && r.reason === 'iat', 'ticket iat 31 s in the future refused (30 s skew)');
  r = await tk(tkClaims({ iat: nowS() - 100, exp: nowS() - 31 }));
  ok(!r.ok && r.reason === 'expired', 'ticket expired 31 s ago refused (30 s skew)');
  r = await tk(tkClaims({ exp: nowS() + 90 }));
  ok(r.ok, 'exp - iat = 90 s accepted');
  r = await t.verify('opaque-access-token-abcdef', { audience: AUD, ticket: true });
  ok(!r.ok && r.reason === 'malformed', 'an opaque access token offered as a ticket refused');
  r = await tk({ iss: ISS, aud: AUD, sub: 'user-1', iat: nowS(), exp: nowS() + 60, jti: 'c-1', scope: 'openid console' }, RS);
  ok(!r.ok && r.reason === 'not-a-ticket', 'a console-scoped JWT without markers offered as a ticket refused');
  r = await tk(tkClaims({ nonce: 'n1' }));
  ok(!r.ok && r.reason === 'ticket-has-nonce', 'a ticket carrying a nonce refused');
  r = await t.verify(signJwt(RS, idClaims(), rsa.privateKey), { audience: AUD, ticket: true });
  ok(!r.ok && r.reason === 'not-a-ticket', 'an ID token replayed as a ticket refused');
  r = await tk(tkClaims({ exp: nowS() + 91 }));
  ok(!r.ok && r.reason === 'lifetime', 'exp - iat > 90 s refused');
  r = await tk(tkClaims({ jti: undefined }));
  ok(!r.ok && r.reason === 'jti', 'no jti refused');
  const once = signJwt(TK, tkClaims({ jti: 'only-once' }), rsa.privateKey);
  r = await t.verify(once, { audience: AUD, ticket: true });
  const again = await t.verify(once, { audience: AUD, ticket: true });
  ok(r.ok && !again.ok && again.reason === 'replay', 'a jti is single use');
  r = await tk(tkClaims({ aud: 'workbench' }));
  ok(!r.ok && r.reason === 'aud', 'a ticket for another audience refused');

  console.log('\n[config]');
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('HARBOR_WB_REALM_')) delete process.env[k];
  ok(config() === null, 'issuer unset: the feature is off');
  process.env.HARBOR_WB_REALM_ISSUER = 'https://realms.example/';
  const half = config();
  ok(!!half && half.cfg === null && /HARBOR_WB_REALM_CLIENT_ID/.test(half.problem), 'issuer alone: a problem naming the missing setting');
  process.env.HARBOR_WB_REALM_CLIENT_ID = 'engine';
  process.env.HARBOR_WB_REALM_CLIENT_SECRET_FILE = '/nonexistent';
  process.env.HARBOR_WB_REALM_REDIRECT_URI = 'https://engine.example/elsewhere';
  const bad = config();
  ok(!!bad && bad.cfg === null && /redirect URI/.test(bad.problem), 'a redirect URI not ending in /auth/realm/callback is refused');
  process.env.HARBOR_WB_REALM_REDIRECT_URI = 'https://engine.example/auth/realm/callback';
  const good = config();
  ok(!!good?.cfg && good.cfg.issuer === 'https://realms.example' && good.cfg.exchange === false, 'complete config; trailing slash trimmed; exchange off by default');
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];

  console.log(`\nPASS ${passed} FAIL ${failed}`);
  if (failed) {
    console.log(failures.map((f) => ` - ${f}`).join('\n'));
    process.exit(1);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
