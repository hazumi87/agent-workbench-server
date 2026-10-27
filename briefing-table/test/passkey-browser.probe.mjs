/* THE BROWSER HALF OF PASSKEYS, in a real browser (E15).
 *
 * `identity-engine.test.mjs` proves the protocol with a software authenticator
 * talking straight to the engine — it never loads a page, so it cannot see the
 * ~20 lines of hand-rolled base64url in login.html and account.html, which is
 * exactly the code most likely to be wrong and least likely to fail loudly (a
 * mangled challenge just makes the prompt refuse, with no server-side trace).
 * This drives the actual pages with Chrome's VIRTUAL AUTHENTICATOR over CDP,
 * which is as close to Windows Hello as a test can get.
 *
 * A PROBE, not part of `npm test` (it needs a browser), but unlike the other
 * probes it SPINS ITS OWN ENGINE on a scratch port with its own temp databases
 * — it never touches :7420, the real data/, or a broker, and there is nothing
 * to clean up in Owner's manager afterwards.
 *
 * It runs against `localhost`, not `127.0.0.1`, and that is load-bearing: an
 * IP address is not a valid WebAuthn RP ID, so a real browser refuses the whole
 * ceremony on `http://127.0.0.1:PORT` even though our server would verify it
 * happily. `localhost` is both a valid RP ID and a secure context over plain
 * http, which is what makes this testable without TLS.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(4); // scratch engine — port table in test/_scratch.mjs
const DEAD_BROKER_PORT = P(13); // told to the engine; nothing may listen there
const BASE = `http://localhost:${PORT}`;
const PASSWORD = 'Zq4%wnb-Rd';

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${detail})` : ''}`);
  if (!cond) {
    failures += 1;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runCli(args, identityDb) {
  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      ['--import', 'tsx', join(REPO_ROOT, 'scripts', 'identity.ts'), ...args],
      { cwd: REPO_ROOT, env: childEnv({ HARBOR_WB_IDENTITY_DB: identityDb }) },
    );
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d;
    });
    proc.on('exit', (code) => resolve({ code, out }));
  });
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-passkey-probe-'));
const identityDb = join(tmpDir, 'identity.db');
let engine = null;
let browser = null;

try {
  for (const p of [PORT, DEAD_BROKER_PORT]) {
    await assertFree(p, 'passkey-browser.probe.mjs');
  }
  const boot = await runCli(['bootstrap', '--username', 'probe'], identityDb);
  const tempCode = /password\s+([a-z2-9]{4}-[a-z2-9]{4})/.exec(boot.out)?.[1];
  ok(!!tempCode, 'bootstrap minted a temp code', tempCode);

  engine = spawn(process.execPath, ['--import', 'tsx', join(REPO_ROOT, 'src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT),
      HARBOR_WB_HOST: '127.0.0.1',
      HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'),
      HARBOR_WB_IDENTITY: 'strict',
      HARBOR_WB_IDENTITY_DB: identityDb,
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
  let engineLog = '';
  engine.stdout.on('data', (d) => {
    engineLog += d;
  });
  engine.stderr.on('data', (d) => {
    engineLog += d;
  });
  for (let i = 0; i < 80; i += 1) {
    await sleep(250);
    try {
      if ((await fetch(`${BASE}/health`)).ok) {
        break;
      }
    } catch {
      /* not up yet */
    }
  }

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  /* A platform authenticator that always verifies the user: the virtual stand-in
   * for a fingerprint reader that always says yes. `hasResidentKey` is what lets
   * the sign-in page start with no username, which is the flow we ship. */
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  console.log('\n-- sign in with the temp code and set a real password --');
  await page.goto(`${BASE}/login`);
  ok(await page.isVisible('#row-passkey'), 'the passkey button is on the sign-in page');
  await page.fill('#username', 'probe');
  await page.fill('#password', tempCode);
  await page.check('#remember');
  await Promise.all([page.waitForURL('**/account.html?change=1'), page.click('button[type=submit]')]);
  ok(page.url().includes('/account.html?change=1'), 'the temp code lands on the change form');

  await page.fill('#current', tempCode);
  await page.fill('#next', PASSWORD);
  await page.click('#save');
  await page.waitForFunction(() => document.getElementById('forced').hidden, null, { timeout: 10000 });
  ok(true, 'a real password is set and the forced-change banner clears');

  console.log('\n-- enrol a passkey through the account page --');
  await page.click('#addpasskey');
  await page.waitForFunction(
    () => document.querySelectorAll('#passkeys li button').length === 1,
    null,
    { timeout: 20000 },
  );
  ok(true, 'the passkey is enrolled and listed');
  const label = await page.textContent('#passkeys li .name');
  ok(!!label && label !== 'Unlabeled passkey', 'it carries a device label', label);

  console.log('\n-- sign out, then sign back in with the passkey alone --');
  await page.click('#signout');
  await page.waitForURL('**/login**');
  const cookiesNow = await context.cookies();
  ok(
    !cookiesNow.some((c) => c.name === 'homelab_session'),
    'the session cookie is gone — nothing but the passkey is left',
  );
  await page.click('#passkey');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20000 });
  ok(!page.url().includes('/login'), 'THE WHOLE POINT: the passkey signed in from the page', page.url());

  const whoami = await page.evaluate(async () => (await fetch('/account')).json());
  ok(whoami.username === 'probe', 'and the engine agrees who it is', whoami.username);
  ok(whoami.via === 'session', 'holding the same session cookie the password path issues', whoami.via);
  ok(
    /login ok probe via passkey from /.test(engineLog),
    'the engine log names the method',
  );
} catch (err) {
  failures += 1;
  console.log(`\n FAIL  EXCEPTION: ${err.stack}`);
} finally {
  await browser?.close();
  engine?.kill();
  await sleep(400);
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* WAL sidecars may linger on Windows; harmless in tmp */
  }
}

console.log(failures === 0 ? '\nall green' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
