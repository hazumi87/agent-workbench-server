/**
 * Identity, end to end through a REAL engine in strict mode (E13).
 *
 * The unit suite proves the pieces; this proves the wiring, which is where the
 * bugs of this shape actually live — a gate that reads the wrong function, a
 * cookie that never reaches the browser, a 403 that fires on the page it sends
 * you to. The whole journey Owner will make on the laptop, in order:
 *
 *   bootstrap -> sign in with the temp code -> every route 403s -> set a real
 *   password -> routes open -> sign in again with "remember this device" ->
 *   a request carrying ONLY the device cookie works -> forget the device ->
 *   that same cookie is refused.
 *
 * SAFETY: its own port, its own mapping db, its own identity db, all under the
 * OS temp dir. Never touches :7420, the real data/, or a broker. No broker is
 * spawned at all — nothing here opens a pty.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoftwareAuthenticator } from './webauthn-authenticator.mjs';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(3); // scratch engine — port table in test/_scratch.mjs
/* The broker port the engine is told about. NOTHING may listen there (no pty
 * is opened in this file); assertFree checks it, because a live broker on it
 * would be adopted, not refused. */
const DEAD_BROKER_PORT = P(12);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
/* The shared secret still exists in strict mode; the point of several
 * assertions below is that it no longer opens anything. */
const LEGACY_TOKEN = 'legacy-token-do-not-ship';
const GOOD_PASSWORD = 'Zq4%wnb-Rd';

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)})`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Cookies are the whole mechanism here, so the client keeps its own jar rather
 *  than relying on fetch (node's fetch does not persist Set-Cookie). */
function jar() {
  const store = new Map();
  return {
    take(res) {
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const i = pair.indexOf('=');
        const name = pair.slice(0, i).trim();
        const value = pair.slice(i + 1).trim();
        if (value === '' || /max-age=0/i.test(raw)) {
          store.delete(name);
        } else {
          store.set(name, value);
        }
      }
    },
    header() {
      return [...store].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    has(name) {
      return store.has(name);
    },
    only(name) {
      return store.has(name) ? `${name}=${store.get(name)}` : '';
    },
    drop(name) {
      store.delete(name);
    },
  };
}

async function call(path, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  if (opts.cookie) {
    headers.cookie = opts.cookie;
  }
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(opts.json);
    opts.method = opts.method ?? 'POST';
  }
  const res = await fetch(BASE + path, { ...opts, headers, redirect: 'manual' });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* html or empty — the status is what most assertions read */
  }
  return { status: res.status, body, res };
}

/** Run the admin CLI against the scratch db and hand back its stdout. */
function runCli(args, identityDb) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', join(REPO_ROOT, 'scripts', 'identity.ts'), ...args], {
      cwd: REPO_ROOT,
      env: childEnv({ HARBOR_WB_IDENTITY_DB: identityDb }),
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => {
      out += d;
    });
    proc.stderr.on('data', (d) => {
      err += d;
    });
    proc.on('exit', (code) => resolve({ code, out, err }));
  });
}

async function run() {
  for (const p of [PORT, DEAD_BROKER_PORT]) {
    await assertFree(p, 'identity-engine.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-identity-engine-'));
  const identityDb = join(tmpDir, 'identity.db');
  let engine = null;
  let engineLog = '';

  try {
    console.log('\n-- bootstrap (the CLI, before the engine exists) --');
    const boot = await runCli(['bootstrap', '--username', 'probe'], identityDb);
    eq(boot.code, 0, 'bootstrap exits 0');
    const code = /password\s+([a-z2-9]{4}-[a-z2-9]{4})/.exec(boot.out)?.[1] ?? null;
    ok(!!code, `prints one temp code in the bkrt-9fqm shape (${code})`);
    ok(/expires/.test(boot.out), 'prints the expiry — the whole safety argument for a short code');

    const second = await runCli(['bootstrap', '--username', 'other'], identityDb);
    ok(second.code !== 0, 'a SECOND bootstrap is refused — this mints the first account only');
    ok(/already exist/.test(second.err), 'and says why');

    console.log('\n-- boot the engine in strict mode --');
    engine = spawn(process.execPath, ['--import', 'tsx', join(REPO_ROOT, 'src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_PORT: String(PORT),
        HARBOR_WB_HOST: HOST,
        HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'),
        HARBOR_WB_IDENTITY: 'strict',
        HARBOR_WB_IDENTITY_DB: identityDb,
        HARBOR_WB_TOKEN: LEGACY_TOKEN,
        /* On, throughout this whole run — safe because nothing below sends
         * x-forwarded-for except the one section that means to. Every other
         * call keeps its today's-behaviour "none" evidence, unaffected. */
        HARBOR_WB_BEHIND_SERVE: '1',
        HARBOR_WB_NO_WINDOW: '1',
        HARBOR_WB_NATS_URL: '',
        /* The fabric subscriber must never dial from a test: 8204 is the real
           server service's port and a test engine has no business on it. '' is the
           documented off switch, same posture as HARBOR_WB_NATS_URL above. */
        HARBOR_WB_FABRIC_URL: '',
        HARBOR_WB_BROKER_AUTOSTART: '0', // never touch the real scheduled task
        HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT), // nothing listens there; no pty is opened
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
      }),
    });
    engine.stdout.on('data', (d) => {
      engineLog += d;
    });
    engine.stderr.on('data', (d) => {
      engineLog += d;
    });

    for (let i = 0; i < 80; i += 1) {
      await sleep(250);
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) {
          break;
        }
      } catch {
        /* not up yet */
      }
    }
    eq((await call('/health')).status, 200, '/health is public and answers');

    console.log('\n-- strict mode closes the old doors --');
    eq((await call('/api/table')).status, 401, 'no credential: 401');
    eq(
      (await call('/api/table', { headers: { authorization: `Bearer ${LEGACY_TOKEN}` } })).status,
      401,
      'the shared engine.token is DEAD in strict mode',
    );
    const page = await fetch(`${BASE}/login`);
    const html = await page.text();
    ok(html.includes("const MODE = 'strict'"), 'the login page is served with the mode substituted');
    ok(!html.includes('__IDENTITY_MODE__'), 'the placeholder is gone');

    console.log('\n-- sign in with the temp code --');
    const cookies = jar();
    const wrong = await call('/login', { json: { username: 'probe', password: 'not-it' } });
    eq(wrong.status, 401, 'a wrong password is refused');
    const ghost = await call('/login', { json: { username: 'nobody', password: 'x' } });
    eq(ghost.status, 401, 'an unknown username is refused the same way');

    const first = await call('/login', { json: { username: 'probe', password: code } });
    eq(first.status, 200, 'the temp code signs in');
    cookies.take(first.res);
    ok(cookies.has('homelab_session'), 'a homelab_session cookie is set');
    ok(!cookies.has('homelab_device'), 'no device cookie without "remember this device"');
    eq(first.body.mustChangePassword, true, 'the response says a change is forced');
    eq(first.body.next, '/account.html?change=1', 'and sends the browser to the change form');

    console.log('\n-- the forced-change gate --');
    const gated = await call('/api/table', { cookie: cookies.header() });
    eq(gated.status, 403, 'a normal API route 403s while the temp code stands');
    eq(gated.body.mustChangePassword, true, 'and says why, in a shape a client can branch on');
    eq(
      (await call('/manager.html', { cookie: cookies.header() })).status,
      403,
      'so does the manager — not just the API',
    );
    /* `/account/*` is handled BEFORE index.ts's gate runs, so until 2026-09-15
     * these two answered normally while a temp code stood — a code that
     * "cannot be lived with" could mint a permanent bearer, or a passkey that
     * outlives it by years. Both are now refused by the gate inside the
     * identity routes themselves. */
    eq(
      (await call('/account/token', { cookie: cookies.header(), json: { label: 'nope' } })).status,
      403,
      'a temp code cannot mint an api token',
    );
    eq(
      (await call('/account/passkey/options', { cookie: cookies.header(), json: {} })).status,
      403,
      'a temp code cannot enrol a passkey',
    );

    const whoami = await call('/account', { cookie: cookies.header() });
    eq(whoami.status, 200, '/account still answers (it is the way out)');
    eq(whoami.body.username, 'probe', 'and knows who we are');
    eq(whoami.body.via, 'session', 'via: session');
    eq(
      (await fetch(`${BASE}/account.html`, { headers: { cookie: cookies.header() } })).status,
      200,
      'the change PAGE is reachable — a gate must not block the form it redirects to',
    );

    console.log('\n-- set a real password --');
    const weak = await call('/account/password', {
      cookie: cookies.header(),
      json: { current: code, next: 'password1!' },
    });
    eq(weak.status, 400, 'the new password goes through the policy');
    const noCurrent = await call('/account/password', {
      cookie: cookies.header(),
      json: { current: 'guess', next: GOOD_PASSWORD },
    });
    eq(noCurrent.status, 400, 'the CURRENT password is required even with a valid cookie');

    const changed = await call('/account/password', {
      cookie: cookies.header(),
      json: { current: code, next: GOOD_PASSWORD },
    });
    eq(changed.status, 200, 'the change succeeds');
    const before = cookies.header();
    cookies.take(changed.res);
    ok(cookies.header() !== before, 'the session cookie is RE-ISSUED in the same response');
    eq(
      (await call('/api/table', { cookie: before })).status,
      401,
      'the pre-change cookie is dead (password_changed_at is the invalidation epoch)',
    );
    eq(
      (await call('/api/table', { cookie: cookies.header() })).status,
      200,
      'the re-issued cookie opens the API — the gate is gone',
    );

    console.log('\n-- remember this device --');
    const device = jar();
    const again = await call('/login', {
      json: { username: 'probe', password: GOOD_PASSWORD, remember: true },
    });
    eq(again.status, 200, 'the new password signs in');
    eq(again.body.mustChangePassword, false, 'and is not forced to change anything');
    device.take(again.res);
    ok(device.has('homelab_session'), 'session cookie issued');
    ok(device.has('homelab_device'), 'device cookie issued alongside it');

    /* THE POINT OF THE WHOLE FEATURE: drop the session and keep only the
     * remembered device. This is the laptop coming back next week. */
    const deviceOnly = device.only('homelab_device');
    eq(
      (await call('/api/table', { cookie: deviceOnly })).status,
      200,
      'a request carrying ONLY the device cookie is authenticated',
    );
    const asDevice = await call('/account', { cookie: deviceOnly });
    eq(asDevice.body.via, 'device', '/account reports via: device');
    eq(
      asDevice.body.evidence,
      'none',
      'evidence is "none" on loopback — it proves nothing about WHICH device, and says so',
    );
    eq(asDevice.body.devices.length, 1, 'the device is listed on the account page');
    const deviceId = asDevice.body.devices[0].id;

    console.log('\n-- revoke --');
    eq(
      (await call(`/account/device/${deviceId}/revoke`, { method: 'POST', cookie: deviceOnly })).status,
      200,
      'forget this device',
    );
    eq(
      (await call('/api/table', { cookie: deviceOnly })).status,
      401,
      'the same device cookie is now refused',
    );

    console.log('\n-- device evidence behind Serve (HARBOR_WB_BEHIND_SERVE) --');
    /* Every call above reached this engine as a bare loopback request — no
     * x-forwarded-for — so it always resolved to evidence:'none', same as
     * before this feature existed. This section is the one place that sends
     * the header Tailscale Serve would have added, proving the gate the unit
     * suite can only fake a socket for. */
    const xffDevice = jar();
    const xffLogin = await call('/login', {
      json: { username: 'probe', password: GOOD_PASSWORD, remember: true },
      headers: { 'x-forwarded-for': '100.64.0.42' },
    });
    eq(xffLogin.status, 200, 'login succeeds with a forwarded tailnet address riding along');
    xffDevice.take(xffLogin.res);
    const xffDeviceOnly = xffDevice.only('homelab_device');

    const xffAccount = await call('/account', {
      cookie: xffDeviceOnly,
      headers: { 'x-forwarded-for': '100.64.0.42' },
    });
    eq(
      xffAccount.body.evidence,
      'serve-xff',
      'a loopback request carrying x-forwarded-for now reports serve-xff, not none',
    );
    const xffRow = xffAccount.body.devices.find((d) => !d.revokedAt);
    ok(!!xffRow, 'the device row minted behind Serve is listed');
    eq(xffRow.tailnetIp, '100.64.0.42', 'the device row RECORDS the forwarded tailnet address');

    eq(
      (
        await call('/api/table', {
          cookie: xffDeviceOnly,
          headers: { 'x-forwarded-for': '100.64.0.99' },
        })
      ).status,
      401,
      'the same device cookie replayed behind a DIFFERENT forwarded address is refused',
    );
    eq(
      (
        await call('/api/table', {
          cookie: xffDeviceOnly,
          headers: { 'x-forwarded-for': '100.64.0.42' },
        })
      ).status,
      200,
      'and still works from the address it was minted on',
    );
    eq(
      (await call('/api/table', { cookie: xffDeviceOnly })).status,
      200,
      'with no x-forwarded-for at all it falls back to evidence:none, which is never a mismatch',
    );

    console.log('\n-- api tokens: the machine half --');
    const minted = await call('/account/token', {
      cookie: device.header(),
      json: { label: 'probe token' },
    });
    eq(minted.status, 200, 'a token is minted');
    ok(!!minted.body.token, 'and shown once, in the response');
    const bearer = { authorization: `Bearer ${minted.body.token}` };
    eq((await call('/api/table', { headers: bearer })).status, 200, 'the token works as a bearer');
    const asToken = await call('/account', { headers: bearer });
    eq(asToken.body.via, 'api_token', '/account reports via: api_token');
    eq(asToken.body.username, 'probe', 'a token belongs to a USER — it reports that user');
    /* deliver-held asserts a PERSON looked at a pane's composer: a session /
       device cookie qualifies, the same user's api token (a bearer) never does. */
    const dhPath = `/api/panes/${encodeURIComponent('recipe:nope#1')}/deliver-held`;
    eq((await call(dhPath, { method: 'POST', cookie: device.header() })).status, 404, 'deliver-held: an identity cookie passes the human-only check (unknown pane → 404)');
    eq((await call(dhPath, { method: 'POST', headers: bearer })).status, 403, 'deliver-held: the same user\'s api token (via api_token) is refused 403');
    eq(
      (await call(`/account/token/${minted.body.id}/revoke`, { method: 'POST', cookie: device.header() }))
        .status,
      200,
      'revoke the token',
    );
    eq((await call('/api/table', { headers: bearer })).status, 401, 'the revoked token is refused');

    console.log('\n-- logout --');
    const out = await call('/logout', { method: 'POST', cookie: device.header(), json: {} });
    eq(out.status, 200, 'logout answers');
    device.take(out.res);
    ok(!device.has('homelab_session'), 'the session cookie is cleared');
    ok(!device.has('homelab_device'), 'the device cookie is cleared');

    console.log('\n-- cross-site --');
    eq(
      (
        await call('/login', {
          json: { username: 'probe', password: GOOD_PASSWORD },
          headers: { origin: 'https://evil.example' },
        })
      ).status,
      403,
      'a POST from another origin is refused (second layer behind SameSite=Lax)',
    );
    /* ------------------------------------------------------------------
     * PASSKEYS (E15). Last, because the final steps re-issue a temp code and
     * leave the account in the forced-change state on purpose — proving that
     * a password reset does NOT kill a passkey is the point, and there is
     * nothing after it to disturb.
     *
     * The authenticator is a real P-256 key building real attestations and
     * assertions (test/webauthn-authenticator.mjs); everything it hands over
     * is byte-for-byte what Edge would POST. Origin and RP ID come out of the
     * request's own Host, so they are `http://127.0.0.1:<PORT>` and `127.0.0.1`
     * here — the same derivation that yields the Serve hostname in real life.
     * ------------------------------------------------------------------ */
    console.log('\n-- passkeys: enrolment --');
    const RP_ID = '127.0.0.1';
    const hello = new SoftwareAuthenticator();
    const pk = jar();
    const pkLogin = await call('/login', {
      json: { username: 'probe', password: GOOD_PASSWORD, remember: true },
    });
    eq(pkLogin.status, 200, 'sign in with the password first — it is the enrolment prerequisite');
    pk.take(pkLogin.res);

    const offer = await call('/account/passkey/options', { cookie: pk.header(), json: {} });
    eq(offer.status, 200, 'registration options are issued');
    ok(!!offer.body.ticket, 'with a server-side ticket, so the challenge never round-trips as state');
    eq(offer.body.options.rp.id, RP_ID, 'RP ID is the request hostname, no port');
    eq(offer.body.options.rp.name, 'Homelab', 'RP name is what the Hello prompt shows');
    eq(offer.body.options.user.name, 'probe', 'the account is named in the options');
    eq(
      offer.body.options.authenticatorSelection.authenticatorAttachment,
      'platform',
      'platform attachment — Windows Hello, not a USB key',
    );
    eq(
      offer.body.options.authenticatorSelection.userVerification,
      'required',
      'user verification REQUIRED — the PIN or the fingerprint is the whole ask',
    );
    eq(offer.body.options.excludeCredentials.length, 0, 'nothing enrolled yet, so nothing excluded');

    const attestation = hello.create(offer.body.options, { origin: BASE });
    const enrolled = await call('/account/passkey/register', {
      cookie: pk.header(),
      json: { ticket: offer.body.ticket, response: attestation },
    });
    eq(enrolled.status, 200, 'the attestation is accepted and the passkey is stored');
    ok(!!enrolled.body.id, 'the row has an id to revoke by');
    ok(!('credentialId' in enrolled.body), 'the credential id is NOT published to the page');

    const afterEnrol = await call('/account', { cookie: pk.header() });
    eq(afterEnrol.body.passkeys.length, 1, 'the passkey is listed on the account');
    const passkeyId = afterEnrol.body.passkeys[0].id;
    const liveDevice = afterEnrol.body.devices.find((d) => !d.revokedAt);
    eq(
      afterEnrol.body.passkeys[0].deviceId,
      liveDevice.id,
      'it records the remembered device it was enrolled from',
    );

    eq(
      (
        await call('/account/passkey/register', {
          cookie: pk.header(),
          json: { ticket: offer.body.ticket, response: attestation },
        })
      ).status,
      400,
      'the SAME ticket cannot be used twice — a challenge is single-use',
    );

    console.log('\n-- passkeys: sign in --');
    /* A browser with NO cookies at all: the reboot case, and the discoverable
     * flow — nothing here says which account is signing in except the
     * credential id inside the assertion. */
    const clean = jar();
    const ask = await call('/login/passkey/options', { json: {} });
    eq(ask.status, 200, 'authentication options are issued to an anonymous caller');
    eq(
      ask.body.options.allowCredentials,
      undefined,
      'with no device cookie the list is open — the browser offers what it holds',
    );
    eq(ask.body.options.userVerification, 'required', 'and still demands user verification');

    const signedIn = await call('/login/passkey', {
      json: {
        ticket: ask.body.ticket,
        remember: true,
        response: hello.get(ask.body.options, { origin: BASE }),
      },
    });
    eq(signedIn.status, 200, 'THE WHOLE POINT: a passkey assertion signs in');
    eq(signedIn.body.mustChangePassword, false, 'and is not forced anywhere');
    clean.take(signedIn.res);
    ok(clean.has('homelab_session'), 'it mints the SAME session cookie the password path mints');
    ok(
      clean.has('homelab_device'),
      'and honours "remember this device" — a passkey is a full password-proof equivalent',
    );
    eq(
      (await call('/api/table', { cookie: clean.only('homelab_session') })).status,
      200,
      'that session opens the API',
    );
    const asPasskey = await call('/account', { cookie: clean.only('homelab_session') });
    eq(asPasskey.body.username, 'probe', 'and it is the right account');
    ok(!!asPasskey.body.passkeys[0].lastUsedAt, 'the passkey records that it was used');
    ok(/login ok probe via passkey from /.test(engineLog), 'the engine log names the method');

    console.log('\n-- passkeys: the device cookie narrows the prompt --');
    const narrowed = await call('/login/passkey/options', {
      json: {},
      cookie: pk.only('homelab_device'),
    });
    eq(narrowed.status, 200, 'options are issued to a remembered device');
    eq(
      narrowed.body.options.allowCredentials.length,
      1,
      'allowCredentials is narrowed to the passkeys enrolled on THIS device',
    );

    console.log('\n-- passkeys: what is refused --');
    async function assertRefused(opts, msg) {
      const started = await call('/login/passkey/options', { json: {} });
      const res = await call('/login/passkey', {
        json: { ticket: started.body.ticket, response: hello.get(started.body.options, opts) },
      });
      eq(res.status, 401, msg);
    }
    await assertRefused(
      { origin: BASE, counter: 0 },
      'a counter that did not advance is refused — that is the clone check',
    );
    await assertRefused(
      { origin: 'https://evil.example' },
      'an assertion signed for another ORIGIN is refused — this is the anti-phishing property',
    );
    await assertRefused(
      { origin: BASE, userVerified: false },
      'an assertion with no user verification is refused — possession alone is not the ask',
    );
    /* Same credential id, same user handle, a DIFFERENT private key — and a
     * counter well clear of the banked one, so the refusal below can only come
     * from the signature check and not from the clone check standing in for
     * it. A test that passes for the wrong reason is worse than none. */
    const stolen = SoftwareAuthenticator.withKeyOf(new SoftwareAuthenticator());
    stolen.credentialId = hello.credentialId;
    stolen.userHandle = hello.userHandle;
    stolen.counter = hello.counter + 10;
    const forgeOpts = await call('/login/passkey/options', { json: {} });
    eq(
      (
        await call('/login/passkey', {
          json: {
            ticket: forgeOpts.body.ticket,
            response: stolen.get(forgeOpts.body.options, { origin: BASE }),
          },
        })
      ).status,
      401,
      'the right credential id signed by the WRONG key is refused',
    );
    const staleTicket = await call('/login/passkey/options', { json: {} });
    await call('/login/passkey', {
      json: {
        ticket: staleTicket.body.ticket,
        response: hello.get(staleTicket.body.options, { origin: BASE }),
      },
    });
    eq(
      (
        await call('/login/passkey', {
          json: {
            ticket: staleTicket.body.ticket,
            response: hello.get(staleTicket.body.options, { origin: BASE }),
          },
        })
      ).status,
      401,
      'a sign-in ticket is single-use too — a replayed challenge is dead',
    );

    console.log('\n-- passkeys: a password reset does NOT kill them --');
    /* `password_changed_at` is the SESSION invalidation epoch. A passkey is not
     * a session and not a password, so it survives — which is exactly what
     * makes it the way back in when a password has been reset. */
    const reset = await runCli(['temp-password', '--username', 'probe'], identityDb);
    eq(reset.code, 0, 'the CLI re-issues a temp code (and revokes every session)');
    eq(
      (await call('/api/table', { cookie: clean.only('homelab_session') })).status,
      401,
      'the passkey-minted session died with the epoch, like any other',
    );
    const afterReset = await call('/login/passkey/options', { json: {} });
    const gatedIn = await call('/login/passkey', {
      json: {
        ticket: afterReset.body.ticket,
        response: hello.get(afterReset.body.options, { origin: BASE }),
      },
    });
    eq(gatedIn.status, 200, 'the passkey STILL signs in after the password was reset');
    eq(gatedIn.body.mustChangePassword, true, 'but it does not escape the forced-change gate');
    eq(gatedIn.body.next, '/account.html?change=1', 'and lands on the change form');
    const gatedJar = jar();
    gatedJar.take(gatedIn.res);
    eq(
      (await call('/api/table', { cookie: gatedJar.header() })).status,
      403,
      'every other route is still 403 — a passkey is not a way around a temp code',
    );

    console.log('\n-- passkeys: revoke --');
    /* Set a real password again so the gate is gone, then remove the passkey. */
    const restored = await call('/account/password', {
      cookie: gatedJar.header(),
      json: {
        current: /password\s+([a-z2-9]{4}-[a-z2-9]{4})/.exec(reset.out)[1],
        next: GOOD_PASSWORD,
      },
    });
    eq(restored.status, 200, 'set a real password again');
    const settled = jar();
    settled.take(restored.res);
    eq(
      (
        await call(`/account/passkey/${passkeyId}/revoke`, {
          method: 'POST',
          cookie: settled.header(),
        })
      ).status,
      200,
      'remove the passkey',
    );
    const goneOpts = await call('/login/passkey/options', { json: {} });
    eq(
      (
        await call('/login/passkey', {
          json: {
            ticket: goneOpts.body.ticket,
            response: hello.get(goneOpts.body.options, { origin: BASE }),
          },
        })
      ).status,
      401,
      'the revoked passkey no longer signs in',
    );
    eq(
      (await call('/account', { cookie: settled.header() })).body.passkeys.filter(
        (p) => !p.revokedAt,
      ).length,
      0,
      'and it is gone from the account page',
    );

  } catch (err) {
    failed++;
    failures.push(`EXCEPTION: ${err.message}`);
    console.log(`\n✗ EXCEPTION: ${err.stack}`);
    console.log(`--- engine log tail ---\n${engineLog.slice(-2500)}`);
  } finally {
    engine?.kill();
    await sleep(400);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
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
  process.exit(0);
}

run();
