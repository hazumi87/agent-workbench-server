/**
 * Identity unit tests (E13): store, policy, temp-code alphabet, resolution
 * order, forced-change allow-list, device evidence.
 *
 * SAFETY: opens a scratch db under the OS temp dir via HARBOR_WB_IDENTITY_DB,
 * set BEFORE the modules are imported — `store.ts` reads the path at module
 * load, exactly like `table/store.ts`. It never touches data/identity.db and
 * never reaches the live engine.
 *
 * No framework (Crawl): a tiny assert and a counter, matching the other suites.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';

const tmp = mkdtempSync(join(tmpdir(), 'wb-identity-'));
process.env.HARBOR_WB_IDENTITY_DB = join(tmp, 'identity.db');
process.env.HARBOR_WB_IDENTITY = 'strict';

const store = await import('../src/identity/store.ts');
const identity = await import('../src/identity/auth.ts');
const policy = await import('../src/identity/password-policy.ts');
const routes = await import('../src/identity/routes.ts');
const evidence = await import('../src/identity/tailnet-evidence.ts');
const passkey = await import('../src/identity/passkey.ts');

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, msg: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)})`);
}

/** A request object with just the surface resolveIdentity reads. */
function req(opts: {
  cookies?: Record<string, string>;
  bearer?: string;
  ip?: string;
  forwarded?: boolean;
}): IncomingMessage {
  const headers: Record<string, string> = {};
  if (opts.cookies) {
    headers.cookie = Object.entries(opts.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  if (opts.bearer) {
    headers.authorization = `Bearer ${opts.bearer}`;
  }
  if (opts.forwarded) {
    headers['x-forwarded-for'] = '100.64.0.9';
  }
  return {
    headers,
    socket: { remoteAddress: opts.ip ?? '127.0.0.1' },
  } as unknown as IncomingMessage;
}

async function run(): Promise<void> {
  console.log('\n-- password policy --');
  eq(policy.validatePassword('short1!').ok, false, 'refuses under 8 characters');
  eq(policy.validatePassword('abcdefghij').ok, false, 'refuses letters only (no digit)');
  eq(policy.validatePassword('abcdefg1h').ok, false, 'refuses without a symbol');
  eq(policy.validatePassword('P@ssw0rd!').ok, false, 'refuses P@ssw0rd! via the leet fold');
  /* The fold collapses doubled letters, so `password` itself folds to
     `pasword`. That is fine and deliberate: the blocklist is folded the SAME
     way, so the comparison is consistent — which is the only property that
     matters. Asserting the literal word here is the mistake. */
  eq(
    policy.foldToWord('P@ssw0rd!'),
    policy.foldToWord('password'),
    'P@ssw0rd! and password fold to the SAME token',
  );
  eq(policy.foldToWord('H@rb0r123'), 'harbor', 'folds H@rb0r123 to harbor');
  eq(policy.validatePassword('Harbor99#').ok, false, 'refuses this installation: harbor');
  eq(policy.validatePassword('Briefing7!').ok, false, 'refuses this installation: briefing');
  eq(policy.validatePassword('Claude42$').ok, false, 'refuses this installation: claude');
  eq(policy.validatePassword('Tailscale1!').ok, false, 'refuses this installation: tailscale');
  eq(policy.validatePassword('homeserver9!').ok, false, 'refuses this installation: homeserver');
  eq(policy.validatePassword('qwerty12!x').ok, false, 'refuses a keyboard run');
  eq(policy.validatePassword('mabcde45!').ok, false, 'refuses a sequential run');
  eq(policy.validatePassword('erictest9!', { username: 'owner' }).ok, false, 'refuses the username');
  eq(policy.validatePassword('Vt7#mqz-Pk').ok, true, 'accepts a real password');

  console.log('\n-- temp code alphabet --');
  ok(!/[ilo01]/.test(policy.TEMP_ALPHABET), 'alphabet omits the confusable glyphs i l o 0 1');
  let shapeOk = true;
  let confusable = false;
  for (let i = 0; i < 400; i += 1) {
    const code = policy.generateTempPassword();
    if (!/^[a-z2-9]{4}-[a-z2-9]{4}$/.test(code)) {
      shapeOk = false;
    }
    if (/[ilo01]/.test(code)) {
      confusable = true;
    }
  }
  ok(shapeOk, '400 codes all match the bkrt-9fqm shape (2 groups of 4)');
  ok(!confusable, '400 codes contain no confusable glyph');

  console.log('\n-- store --');
  eq(store.countAccounts(), 0, 'a fresh db has no accounts');
  const hash = await identity.hashPassword('Vt7#mqz-Pk');
  ok(hash.startsWith('$argon2id$'), 'passwords hash with argon2id');
  const account = store.createAccount({
    username: 'Owner', // deliberately mixed case
    passwordHash: hash,
    mustChange: true,
    passwordExpiresAt: Date.now() + 60_000,
    isAdmin: true,
  });
  eq(account.username, 'owner', 'username is normalised to lowercase');
  eq(store.countAccounts(), 1, 'account persisted');
  ok(store.accountByUsername('OWNER') !== null, 'lookup is case-insensitive');
  ok(await identity.verifyPassword(hash, 'Vt7#mqz-Pk'), 'argon2 verifies the right password');
  ok(!(await identity.verifyPassword(hash, 'Vt7#mqz-Pl')), 'argon2 rejects the wrong one');
  ok(!(await identity.verifyPassword('not-a-hash', 'x')), 'a malformed hash reads as wrong, not throw');

  console.log('\n-- login and the expiry --');
  const bad = await identity.login('owner', 'wrong', { label: null, remember: false, req: req({}) });
  eq(bad.ok, false, 'wrong password refused');
  const ghost = await identity.login('nobody', 'x', { label: null, remember: false, req: req({}) });
  eq(ghost.ok, false, 'unknown username refused');
  store.setPassword(account.id, hash, { mustChange: true, passwordExpiresAt: Date.now() - 1 });
  const stale = await identity.login('owner', 'Vt7#mqz-Pk', {
    label: null,
    remember: false,
    req: req({}),
  });
  eq(stale.ok, false, 'an EXPIRED temp code is dead, not merely nagging');
  store.setPassword(account.id, hash, {
    mustChange: true,
    passwordExpiresAt: Date.now() + 60_000,
  });
  const good = await identity.login('owner', 'Vt7#mqz-Pk', {
    label: 'Windows',
    remember: true,
    req: req({ ip: '100.64.0.5' }),
  });
  eq(good.ok, true, 'correct password opens a session');
  ok(!!good.sessionToken, 'a session token is issued');
  ok(!good.deviceToken, 'remember:true mints NO device token while the account must change its password (a temp code cannot buy a permanent credential)');
  eq(good.principal?.mustChangePassword, true, 'principal carries mustChangePassword');
  /* ...and once the password is real, remember:true does mint one (the rest of this file leans on that device) */
  store.setPassword(account.id, hash, { mustChange: false, passwordExpiresAt: null });
  const settled = await identity.login('owner', 'Vt7#mqz-Pk', { label: 'Windows', remember: true, req: req({ ip: '100.64.0.5' }) });
  ok(!!settled.deviceToken, 'remember:true also mints a device token for a settled account');
  store.setPassword(account.id, hash, { mustChange: true, passwordExpiresAt: Date.now() + 60_000 });
  await new Promise((r) => setTimeout(r, 5)); // the epoch moved: a session must be created AFTER it
  const good2 = await identity.login('owner', 'Vt7#mqz-Pk', { label: 'Windows', remember: false, req: req({ ip: '100.64.0.5' }) });

  console.log('\n-- resolution order --');
  const sessionToken = good2.sessionToken!;
  const deviceToken = settled.deviceToken!;
  const apiToken = store.mintToken();
  store.createApiToken(account.id, apiToken, 'test');

  eq(identity.resolveIdentity(req({}))?.via, undefined, 'no credential resolves to anonymous');
  eq(identity.resolveIdentity(req({ bearer: apiToken }))?.via, 'api_token', 'bearer resolves first');
  eq(
    identity.resolveIdentity(req({ cookies: { homelab_session: sessionToken } }))?.via,
    'session',
    'session cookie resolves',
  );
  eq(
    identity.resolveIdentity(req({ cookies: { homelab_device: deviceToken } }))?.via,
    'device',
    'device cookie resolves on its own',
  );
  eq(
    identity.resolveIdentity(
      req({ cookies: { homelab_session: sessionToken, homelab_device: deviceToken } }),
    )?.via,
    'session',
    'session BEATS device when both are present',
  );
  eq(
    identity.resolveIdentity(
      req({ bearer: apiToken, cookies: { homelab_session: sessionToken } }),
    )?.via,
    'api_token',
    'bearer BEATS both cookies',
  );
  eq(identity.resolveIdentity(req({ bearer: 'not-a-token' })), null, 'an unknown bearer is nobody');

  console.log('\n-- mode switch --');
  const savedMode = process.env.HARBOR_WB_IDENTITY;
  process.env.HARBOR_WB_IDENTITY = 'legacy';
  eq(identity.enabled(), false, 'legacy mode reports disabled');
  eq(identity.resolveIdentity(req({ bearer: apiToken })), null, 'legacy mode resolves nobody');
  eq(identity.allowed(null, true), true, 'legacy: the shared token still authorises');
  eq(identity.allowed(null, false), false, 'legacy: no token, no entry');
  process.env.HARBOR_WB_IDENTITY = 'both';
  eq(identity.allowed(null, true), true, 'both: the shared token still authorises');
  eq(
    identity.allowed(identity.resolveIdentity(req({ bearer: apiToken })), false),
    true,
    'both: an api token authorises with no shared secret',
  );
  process.env.HARBOR_WB_IDENTITY = 'strict';
  eq(identity.allowed(null, true), false, 'strict: the shared token is DEAD');
  eq(
    identity.allowed(identity.resolveIdentity(req({ bearer: apiToken })), false),
    true,
    'strict: an api token authorises',
  );
  process.env.HARBOR_WB_IDENTITY = savedMode;

  console.log('\n-- forced change allow-list --');
  ok(routes.changeAllowed('/account/password'), 'the change form itself is allowed');
  ok(routes.changeAllowed('/account.html'), 'the page the redirect lands on is allowed');
  ok(routes.changeAllowed('/logout'), 'logout is allowed');
  ok(!routes.changeAllowed('/api/table'), 'the API is NOT allowed');
  ok(!routes.changeAllowed('/manager.html'), 'the manager is NOT allowed');

  console.log('\n-- device evidence --');
  eq(evidence.evidenceFor(req({ ip: '127.0.0.1' })).kind, 'none', 'loopback proves nothing');
  eq(
    evidence.evidenceFor(req({ ip: '100.64.0.5', forwarded: true })).kind,
    'none',
    'a proxy hop proves nothing — the address is only in a forgeable header',
  );
  eq(evidence.evidenceFor(req({ ip: '100.64.0.5' })).kind, 'peer', 'a direct peer address proves something');
  eq(
    evidence.checkDevice(
      { tailnet_node: 'haz-001', tailnet_ip: null },
      { kind: 'none', node: null, ip: null, label: null, userLogin: null },
    ).ok,
    true,
    'unknown is not a mismatch — a bound device still works behind Serve',
  );
  eq(
    evidence.checkDevice(
      { tailnet_node: 'haz-001', tailnet_ip: null },
      { kind: 'peer', node: 'haz-001', ip: '100.64.0.5', label: null, userLogin: null },
    ).ok,
    true,
    'the same node passes',
  );
  eq(
    evidence.checkDevice(
      { tailnet_node: 'haz-001', tailnet_ip: null },
      { kind: 'peer', node: 'GPU-HOST', ip: '100.64.0.9', label: null, userLogin: null },
    ).ok,
    false,
    'a DIFFERENT node is refused',
  );
  eq(
    evidence.checkDevice(
      { tailnet_node: null, tailnet_ip: '100.64.0.5' },
      { kind: 'peer', node: null, ip: '100.64.0.9', label: null, userLogin: null },
    ).ok,
    false,
    'falls back to the IP when neither side has a name',
  );
  eq(
    evidence.checkDevice(
      { tailnet_node: 'nodekey:abc', tailnet_ip: null },
      { kind: 'serve-xff', node: 'nodekey:xyz', ip: '100.64.0.9', label: 'iPhone · ios (100.64.0.9)', userLogin: null },
    ).ok,
    false,
    'serve-xff evidence refuses a different node just like a direct peer',
  );

  console.log('\n-- CGNAT range check (100.64.0.0/10) --');
  ok(evidence.looksLikeTailscaleAddress('100.64.0.1'), '100.64.0.1 is the bottom of the range');
  ok(evidence.looksLikeTailscaleAddress('100.64.0.9'), '100.64.0.9 is the top of the range');
  ok(!evidence.looksLikeTailscaleAddress('100.63.255.255'), '100.63.x sits just below the range');
  ok(!evidence.looksLikeTailscaleAddress('100.128.0.0'), '100.128.x sits just above the range');
  ok(!evidence.looksLikeTailscaleAddress('8.8.8.8'), 'a public address is not in range');
  ok(!evidence.looksLikeTailscaleAddress('not-an-ip'), 'garbage is not in range');

  console.log('\n-- label derivation --');
  eq(
    evidence.deriveLabel({ hostName: 'GPU-HOST', os: 'windows', nodeKey: 'nodekey:abc', tailscaleIP: '100.64.0.1' }, '100.64.0.1'),
    'GPU-HOST · windows',
    'a real hostname plus OS',
  );
  eq(
    evidence.deriveLabel({ hostName: 'localhost', os: 'iOS', nodeKey: 'nodekey:def', tailscaleIP: '100.64.0.9' }, '100.64.0.9'),
    'iPhone · ios (100.64.0.9)',
    'a generic hostname (every iOS peer reports "localhost") falls back to a friendly OS name plus the address',
  );
  eq(evidence.deriveLabel(null, '100.64.0.9'), null, 'an unresolved peer has no label');

  console.log('\n-- serve-xff evidence (HARBOR_WB_BEHIND_SERVE) --');
  function reqXff(ip: string, xff: string | undefined, extra: Record<string, string> = {}): IncomingMessage {
    const headers: Record<string, string> = { ...extra };
    if (xff !== undefined) {
      headers['x-forwarded-for'] = xff;
    }
    return { headers, socket: { remoteAddress: ip } } as unknown as IncomingMessage;
  }
  const savedBehindServe = process.env.HARBOR_WB_BEHIND_SERVE;

  process.env.HARBOR_WB_BEHIND_SERVE = '1';
  eq(
    evidence.evidenceFor(reqXff('127.0.0.1', '100.64.0.9')).kind,
    'serve-xff',
    'switch on + loopback peer + XFF resolves as serve-xff',
  );
  eq(
    evidence.evidenceFor(reqXff('127.0.0.1', '100.64.0.9, 10.0.0.1')).ip,
    '100.64.0.9',
    'only the FIRST address in a comma-joined XFF is trusted',
  );
  eq(
    evidence.evidenceFor(reqXff('127.0.0.1', '8.8.8.8')).kind,
    'none',
    'an address outside the tailnet CGNAT range is never treated as evidence',
  );
  eq(
    evidence.evidenceFor(reqXff('127.0.0.1', undefined)).kind,
    'none',
    'loopback with no XFF at all: nothing to resolve',
  );
  eq(
    evidence.evidenceFor(reqXff('127.0.0.1', '100.64.0.9', { 'tailscale-user-login': 'noreply@example.com' }))
      .userLogin,
    'noreply@example.com',
    'Tailscale-User-Login rides along when Serve identified an authenticated user',
  );

  process.env.HARBOR_WB_BEHIND_SERVE = '0';
  eq(
    evidence.evidenceFor(reqXff('127.0.0.1', '100.64.0.9')).kind,
    'none',
    'switch OFF: XFF is never trusted, even from loopback',
  );

  process.env.HARBOR_WB_BEHIND_SERVE = '1';
  eq(
    evidence.evidenceFor(reqXff('100.64.0.5', '100.64.0.9')).kind,
    'none',
    'switch ON but the socket peer itself is not loopback: XFF is still ignored',
  );
  process.env.HARBOR_WB_BEHIND_SERVE = savedBehindServe;

  /* End to end through resolveIdentity: the device row above was minted from
   * 100.64.0.5 with no tailnet name available (no tailscale in the test
   * process), so it recorded the IP. Replaying it from another address must be
   * refused, and from the same address must pass. */
  eq(
    identity.resolveIdentity(req({ cookies: { homelab_device: deviceToken }, ip: '100.64.0.5' }))?.via,
    'device',
    'the device token works from the address it was minted on',
  );
  eq(
    identity.resolveIdentity(req({ cookies: { homelab_device: deviceToken }, ip: '100.64.0.9' })),
    null,
    'REPLAYED from another tailnet address: refused',
  );

  console.log('\n-- revocation and the invalidation epoch --');
  const devices = store.listDevices(account.id);
  eq(devices.length, 1, 'one remembered device is listed');
  ok(store.revokeDevice(devices[0].id, account.id), 'revoke reports success');
  eq(
    identity.resolveIdentity(req({ cookies: { homelab_device: deviceToken }, ip: '100.64.0.5' })),
    null,
    'a revoked device is refused',
  );
  ok(!store.revokeDevice(devices[0].id, account.id), 'a second revoke is a no-op');
  ok(!store.revokeDevice(devices[0].id, 'someone-else'), 'another user cannot revoke it');

  ok(
    identity.resolveIdentity(req({ cookies: { homelab_session: sessionToken } })) !== null,
    'the session still resolves before the change',
  );
  const principal = identity.resolveIdentity(req({ cookies: { homelab_session: sessionToken } }))!;
  const wrongCurrent = await identity.changePassword(principal, 'nope', 'Vt7#mqz-Qz', null);
  eq(wrongCurrent.ok, false, 'a password change REQUIRES the current password');
  const weakNext = await identity.changePassword(principal, 'Vt7#mqz-Pk', 'password1!', null);
  eq(weakNext.ok, false, 'the new password goes through the policy');
  const changed = await identity.changePassword(principal, 'Vt7#mqz-Pk', 'Zq4%wnb-Rd', null);
  eq(changed.ok, true, 'the change succeeds with the current password and a good new one');
  ok(!!changed.sessionToken, 'a fresh session is issued in the same breath');
  eq(
    identity.resolveIdentity(req({ cookies: { homelab_session: sessionToken } })),
    null,
    'the OLD session is dead — password_changed_at is the invalidation epoch',
  );
  eq(
    identity.resolveIdentity(req({ cookies: { homelab_session: changed.sessionToken! } }))?.username,
    'owner',
    'the re-issued session works',
  );
  eq(
    identity.resolveIdentity(req({ cookies: { homelab_session: changed.sessionToken! } }))
      ?.mustChangePassword,
    false,
    'the forced-change flag is cleared',
  );
  const after = await identity.login('owner', 'Zq4%wnb-Rd', {
    label: null,
    remember: false,
    req: req({}),
  });
  eq(after.ok, true, 'the new password logs in');
  ok(
    after.principal?.mustChangePassword === false,
    'and the temp expiry is gone with it (a real password does not expire)',
  );

  console.log('\n-- passkeys: rp id and origin derivation --');
  /* The two strings a passkey is bound to. Getting either wrong is invisible
     at the browser — the prompt simply never appears — so they are pinned
     here rather than discovered in front of a Hello dialog. */
  function hostReq(host: string | undefined, extra: Record<string, string> = {}): IncomingMessage {
    const headers: Record<string, string> = { ...extra };
    if (host !== undefined) {
      headers.host = host;
    }
    return { headers, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage;
  }
  eq(passkey.rpIdFor(hostReq('localhost:7420')), 'localhost', 'the port is stripped from the RP ID');
  eq(
    passkey.rpIdFor(hostReq('server.example.ts.net')),
    'server.example.ts.net',
    'the Serve hostname is the RP ID behind Serve',
  );
  eq(passkey.rpIdFor(hostReq('host.example.ts.net')), 'host.example.ts.net', 'lowercased');
  eq(passkey.rpIdFor(hostReq('[::1]:7420')), '::1', 'IPv6 brackets come off with the port');
  eq(passkey.rpIdFor(hostReq(undefined)), null, 'no host at all: nothing to bind to, and it says so');
  eq(
    passkey.rpIdFor(hostReq(undefined, { 'x-forwarded-host': 'proxied.example' })),
    'proxied.example',
    'x-forwarded-host is the FALLBACK when there is no Host header',
  );
  eq(
    passkey.rpIdFor(hostReq('real.example', { 'x-forwarded-host': 'proxied.example' })),
    'real.example',
    'but Host WINS when both are present — Serve preserves the original',
  );
  eq(
    passkey.originsFor(hostReq('localhost:7420'))[0],
    'http://localhost:7420',
    'origin keeps the port and defaults to http',
  );
  eq(
    passkey.originsFor(hostReq('host.example.ts.net', { 'x-forwarded-proto': 'https' }))[0],
    'https://host.example.ts.net',
    'the forwarded scheme decides https — the hop behind Serve is plain http',
  );
  eq(passkey.originsFor(hostReq(undefined)).length, 0, 'no host, no origin');

  const savedRpId = process.env.HARBOR_WB_WEBAUTHN_RPID;
  const savedOrigin = process.env.HARBOR_WB_WEBAUTHN_ORIGIN;
  process.env.HARBOR_WB_WEBAUTHN_RPID = 'pinned.example';
  process.env.HARBOR_WB_WEBAUTHN_ORIGIN = 'https://a.example, https://b.example';
  eq(passkey.rpIdFor(hostReq('localhost:7420')), 'pinned.example', 'the env override wins for the RP ID');
  eq(
    passkey.originsFor(hostReq('localhost:7420')).join('|'),
    'https://a.example|https://b.example',
    'and the origin override takes a comma-separated LIST — one engine, several origins',
  );
  /* RESTORE BY DELETE WHEN THERE WAS NOTHING THERE. `process.env.X =
     undefined` stores the literal STRING "undefined", which is truthy — so a
     naive restore leaves the override switched ON, pinned to a nonsense
     hostname, and every assertion after it reads `rp.id: "undefined"`. Cost an
     hour the first time; the same latent trap sits in the BEHIND_SERVE restore
     above, where it happens not to bite because only '1' means anything. */
  if (savedRpId === undefined) {
    delete process.env.HARBOR_WB_WEBAUTHN_RPID;
  } else {
    process.env.HARBOR_WB_WEBAUTHN_RPID = savedRpId;
  }
  if (savedOrigin === undefined) {
    delete process.env.HARBOR_WB_WEBAUTHN_ORIGIN;
  } else {
    process.env.HARBOR_WB_WEBAUTHN_ORIGIN = savedOrigin;
  }

  console.log('\n-- passkeys: transports column --');
  eq(passkey.parseTransports(null), null, 'an absent hint is null');
  eq(JSON.stringify(passkey.parseTransports('["internal","hybrid"]')), '["internal","hybrid"]', 'a list parses');
  eq(passkey.parseTransports('not json'), null, 'garbage is treated as ABSENT, never thrown');
  eq(passkey.parseTransports('{"a":1}'), null, 'so is a shape that is not a list of strings');

  console.log('\n-- passkeys: registration options --');
  const beforeOptions = passkey.pendingCount();
  const offered = await passkey.registrationOptions(hostReq('localhost:7420'), account);
  ok(offered.ok, 'options are produced');
  if (offered.ok) {
    const shape = offered.options as {
      rp: { id: string; name: string };
      user: { name: string };
      challenge: string;
      authenticatorSelection: Record<string, unknown>;
    };
    eq(shape.rp.id, 'localhost', 'rp.id is the derived hostname');
    eq(shape.rp.name, passkey.RP_NAME, 'rp.name is what the Hello prompt shows');
    eq(shape.user.name, 'owner', 'the account is named');
    ok(shape.challenge.length >= 22, 'a challenge is included');
    eq(shape.authenticatorSelection.authenticatorAttachment, 'platform', 'platform authenticator only');
    eq(shape.authenticatorSelection.userVerification, 'required', 'user verification is REQUIRED');
    eq(passkey.pendingCount(), beforeOptions + 1, 'the challenge is held SERVER-SIDE, not round-tripped');

    const wrongAccount = await passkey.register(
      { ...account, id: 'someone-else' },
      offered.ticket,
      {},
      { deviceId: null, label: null },
    );
    eq(wrongAccount.ok, false, 'a ticket minted for one account cannot complete into another');
    eq(passkey.pendingCount(), beforeOptions, 'and the ticket is consumed either way — single use');
    const replayed = await passkey.register(account, offered.ticket, {}, { deviceId: null, label: null });
    eq(replayed.ok, false, 'so a second attempt with it is dead');
  }
  eq(
    (await passkey.registrationOptions(hostReq(undefined), account)).ok,
    false,
    'a request with no host is REFUSED rather than bound to a guess',
  );

  console.log('\n-- passkeys: the store --');
  const pkDevice = store.createDevice({
    userId: account.id,
    token: store.mintToken(),
    label: 'laptop',
    tailnetNode: null,
    tailnetIp: null,
  });
  const row = store.createPasskey({
    userId: account.id,
    deviceId: pkDevice.id,
    credentialId: 'Y3JlZC1vbmU',
    publicKey: 'cHVibGljLWtleQ',
    counter: 3,
    transports: ['internal'],
    aaguid: '00000000-0000-0000-0000-000000000000',
    label: 'GPU-HOST · windows',
  });
  eq(store.listPasskeys(account.id).length, 1, 'the passkey is listed for its account');
  eq(store.passkeyByCredentialId('Y3JlZC1vbmU')?.id, row.id, 'and found by credential id — the sign-in lookup');
  eq(store.passkeyByCredentialId('nope'), null, 'an unknown credential id is nobody');
  eq(row.transports, '["internal"]', 'transports are stored as one opaque JSON string');
  eq(store.passkeysForDevice(pkDevice.id).length, 1, 'and it is reachable from the device it was enrolled on');
  store.touchPasskey(row.id, 9);
  eq(store.passkeyByCredentialId('Y3JlZC1vbmU')?.counter, 9, 'the clone-detection counter advances');
  ok(!!store.passkeyByCredentialId('Y3JlZC1vbmU')?.last_used_at, 'and the use is stamped');
  ok(store.revokePasskey(row.id, account.id), 'revoke reports success');
  ok(!store.revokePasskey(row.id, account.id), 'a second revoke is a no-op');
  ok(!store.revokePasskey(row.id, 'someone-else'), 'another user cannot revoke it');
  eq(store.passkeysForDevice(pkDevice.id).length, 0, 'a revoked passkey no longer narrows a prompt');
  /* Contract §0: a device and a passkey are SEPARATE credentials. Forgetting
     the laptop must not silently delete the key that lives in its TPM. */
  store.revokeDevice(pkDevice.id, account.id);
  eq(
    store.listPasskeys(account.id).length,
    1,
    'revoking the DEVICE does not delete the passkey row — they are separate credentials',
  );

  console.log('\n-- api tokens --');
  const tokens = store.listApiTokens(account.id);
  eq(tokens.length, 1, 'one token listed');
  ok(store.revokeApiToken(tokens[0].id, account.id), 'token revoke reports success');
  eq(identity.resolveIdentity(req({ bearer: apiToken })), null, 'a revoked token is nobody');
}

try {
  await run();
} catch (err) {
  failed += 1;
  failures.push(`EXCEPTION: ${(err as Error).message}`);
  console.log(`\n✗ EXCEPTION: ${(err as Error).stack}`);
} finally {
  store.closeForTests();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* WAL sidecars may linger on Windows; harmless in tmp */
  }
}

console.log(`\n${'='.repeat(40)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
if (failed > 0) {
  console.log('failures:');
  for (const f of failures) {
    console.log(`  - ${f}`);
  }
  process.exit(1);
}
console.log('all green');
