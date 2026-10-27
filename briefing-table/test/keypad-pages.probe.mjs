/**
 * The touch keypad's PAGE BUTTON WRAPS — ticket-adjacent, Owner-reported from
 * his phone (2026-09-23): 1/3 -> 2/3 -> 3/3 and then stuck, never back to 1/3.
 *
 * The bug was a value guessed instead of read. `layoutPages()` is the only
 * thing that knows `perPage`, and it computed the real page count locally; the
 * nav handler re-derived it from the number of VISIBLE keys, which on the LAST
 * page is the remainder (1 of 9 at perPage 4 -> pages = 9). So `page` jumped to
 * 3 and `layoutPages()` clamped it straight back with `Math.min(page,
 * pages - 1)`. The clamp made a wrong answer look like a stuck button.
 *
 * WHY THIS ASSERTS ON THE RENDERED NAV TEXT, not on a variable: the clamp is
 * what hid the defect, and a unit check of the handler would have been written
 * against the same wrong page count. The only trustworthy statement is what the
 * button says after a real tap.
 *
 * WebKit + a phone viewport, because the keypad is gated on `(pointer: coarse)`
 * and 320px is what makes it page at all — at desktop width every key fits, the
 * nav is hidden, and the test would pass vacuously. `?keys=1` pins the gate so
 * a future media-query change cannot silently skip this.
 *
 * Scratch engine :7457 + scratch broker :7458, temp db, scrubbed env. Touches
 * nothing of Owner's. Not in `npm test` (needs a browser), like the other
 * *.probe.mjs.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { scratchShell } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 7457;
const BROKER_PORT = 7458;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-keypad-token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-keypad-'));
const SHELL = scratchShell();
const TARGETS = JSON.stringify({ targets: [{ id: 'local', label: 'Local', kind: 'local', shell: SHELL }] });
const tsxLoader = `file://${join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')}`;
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PTY_BROKER_|HARBOR_WB_)/i.test(k)));

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${msg}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}
const api = (path, init = {}) =>
  fetch(BASE + path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) } });

let log = '';
const procs = [];
function boot(args, env) {
  const p = spawn(process.execPath, ['--import', tsxLoader, ...args], {
    cwd: REPO_ROOT, env: { ...BASE_ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => { log += d; });
  p.stderr.on('data', (d) => { log += d; });
  procs.push(p);
  return p;
}
async function waitUp(url) {
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(url)).ok) { return true; } } catch { /* not yet */ }
    await sleep(250);
  }
  return false;
}

/** What the nav button says, and whether it is on screen at all. */
const readNav = (page) => page.evaluate(() => {
  const nav = document.querySelector('.keypad .kp-nav')
    || [...document.querySelectorAll('.keypad button, .keypad div')].find((e) => /^\d+\/\d+$/.test((e.textContent || '').trim()));
  if (!nav) {
    /* Say what WAS there. "not found" with no context is the failure mode that
       wastes a round trip: a missing keypad, a redirect back to /login and a
       script that threw all look identical from one boolean. */
    return {
      found: false,
      href: location.href,
      keypad: !!document.querySelector('.keypad'),
      coarse: window.matchMedia?.('(pointer: coarse)')?.matches ?? null,
      keysParam: new URLSearchParams(location.search).get('keys'),
      bodyKids: document.body?.children.length ?? null,
      hasTerm: !!document.querySelector('#term'),
    };
  }
  const keys = [...document.querySelectorAll('.keypad .keypad-keys > *')];
  return {
    found: true,
    hidden: nav.hidden,
    text: (nav.textContent || '').trim(),
    visibleKeys: keys.filter((k) => !k.hidden).length,
    totalKeys: keys.length,
  };
});

let browser = null;
const pageErrors = [];
try {
  boot(['node_modules/pty-broker/src/main.ts'], { PTY_BROKER_PORT: String(BROKER_PORT) });
  ok(await waitUp(`http://127.0.0.1:${BROKER_PORT}/health`), `scratch broker on :${BROKER_PORT}`);
  boot(['src/server/index.ts'], {
    HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1',
    HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'),
    HARBOR_WB_TOKEN: TOKEN, HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'),
    HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_NO_WINDOW: '1',
    HARBOR_WB_WINDOW_HOST: 'http://127.0.0.1:9',
    HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '',
    HARBOR_WB_BROKER_PORT: String(BROKER_PORT), HARBOR_WB_BROKER_AUTOSTART: '0',
    HARBOR_WB_TARGETS: TARGETS, HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
  });
  const up = await waitUp(`${BASE}/health`);
  ok(up, `scratch engine on :${PORT}`, up ? undefined : log.slice(-600));
  if (!up) {
    throw new Error('engine down');
  }

  const recipe = (await (await api('/api/recipes', {
    method: 'POST',
    body: JSON.stringify({ name: 'Keypad Probe', target: 'local', vendor: 'cli-manager', projectDir: tmpDir }),
  })).json()).recipe;

  /* PROBE_BROWSER=chromium where WebKit cannot launch (the server). */
  browser = await (process.env.PROBE_BROWSER === 'chromium' ? chromium : webkit).launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 320, height: 522 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  });
  /* THE SOFT KEYBOARD IS UP (2026-09-29, web/solo-keybar-auto): the bar now
     exists only while it is, so the page sees a visualViewport 268px short of
     the layout one (no harness can raise a real keyboard) and opens the bar
     by itself. */
  await ctx.addInitScript(() => {
    const real = window.visualViewport;
    const fake = new EventTarget();
    for (const k of ['width', 'scale', 'offsetTop', 'offsetLeft', 'pageTop', 'pageLeft']) {
      Object.defineProperty(fake, k, { get: () => real[k] });
    }
    Object.defineProperty(fake, 'height', { get: () => real.height - 268 });
    real.addEventListener('resize', () => fake.dispatchEvent(new Event('resize')));
    Object.defineProperty(window, 'visualViewport', { get: () => fake, configurable: true });
  });
  /* Only the page under test counts. The post-login landing page (the manager
     at /) is still fetching /api/targets, /api/recipes and /api/rooms when we
     navigate to solo.html, and WebKit reports those cut-off fetches as page
     errors "due to access control checks" — a race in this probe, not a
     defect in either page (1 run in 3 once the manager gained a Rooms fetch). */
  ctx.on('page', (p) => p.on('pageerror', (e) => {
    if (new URL(p.url()).pathname === '/solo.html') {
      pageErrors.push(`${p.url()}: ${e.message}`);
    }
  }));
  const page = await ctx.newPage();

  /* Log in and WAIT FOR THE COOKIE TO LAND. Submitting and calling
     waitForLoadState races the navigation in WebKit: the engine logs
     "login ok" and the next goto still bounces to /login?next=…, which then
     presents as "the keypad is missing". Assert the login instead of assuming
     it, so an auth change fails HERE and names itself. */
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    const f = document.querySelector('form');
    (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
    f.submit();
  }, TOKEN);
  await page.waitForURL((u) => !new URL(u).pathname.startsWith('/login'), { timeout: 15000 }).catch(() => {});
  ok(!new URL(page.url()).pathname.startsWith('/login'), 'logged in (left /login)', page.url());

  await page.goto(`${BASE}/solo.html?recipe=${recipe.id}&keys=1`, { waitUntil: 'domcontentloaded' });
  ok(!new URL(page.url()).pathname.startsWith('/login'), 'solo.html served, not bounced to /login', page.url());
  await sleep(1200); // the bar and the first fit land a frame or two in

  /* IT MUST BE OPEN. `.keypad-grid` ships `hidden`, and `layoutPages()` returns
     immediately while it is — so a probe that reads the nav with the bar shut
     sees "all 12 keys fit, no paging" and passes vacuously. With the keyboard
     up (the init script above) the bar opens by itself; a tap on its toggle now
     COLLAPSES it. */
  console.log('\n[the keypad opens with the keyboard]');
  await sleep(500); // it lays out, then re-lays out on the next rAF
  const opened = await page.evaluate(() => ({
    expanded: document.querySelector('.keypad .keypad-toggle')?.getAttribute('aria-expanded'),
    gridHidden: document.querySelector('.keypad .keypad-grid')?.hidden ?? null,
  }));
  ok(opened.expanded === 'true' && opened.gridHidden === false, 'the keypad grid is open', opened);

  console.log('\n[the keypad pages at phone width at all]');
  const first = await readNav(page);
  ok(first.found, 'a page/nav button exists', first);
  ok(first.found && !first.hidden, 'and it is VISIBLE — the keys do not all fit at 320px', first);
  const m = /^(\d+)\/(\d+)$/.exec(first.text || '');
  ok(!!m, `it reads N/M (got ${JSON.stringify(first.text)})`);
  if (!m) {
    throw new Error('no page indicator to cycle');
  }
  const pages = Number(m[2]);
  ok(pages > 1, `more than one page (got ${pages})`, first);
  ok(first.text === `1/${pages}`, `starts on page 1 (got ${JSON.stringify(first.text)})`);
  ok(first.visibleKeys < first.totalKeys, 'only some keys are shown per page', first);

  console.log('\n[tapping through every page and back to the first — the bug was the LAST hop]');
  const seen = [first.text];
  for (let i = 0; i < pages; i += 1) {
    await page.tap('.keypad .kp-nav').catch(async () => {
      /* fall back to a synthetic pointerdown: the handler listens on
         pointerdown, not click, so a tap that misses is worth knowing about. */
      await page.dispatchEvent('.keypad .kp-nav', 'pointerdown');
    });
    await sleep(220);
    seen.push((await readNav(page)).text);
  }
  console.log(`    sequence: ${seen.join(' -> ')}`);
  for (let i = 1; i < pages; i += 1) {
    ok(seen[i] === `${i + 1}/${pages}`, `tap ${i} advances to ${i + 1}/${pages} (got ${JSON.stringify(seen[i])})`);
  }
  ok(seen[pages] === `1/${pages}`,
    `THE FIX: the tap on ${pages}/${pages} WRAPS to 1/${pages} (got ${JSON.stringify(seen[pages])})`,
    seen);

  console.log('\n[a second full cycle — the count is not consumed by the first]');
  const again = [];
  for (let i = 0; i < pages; i += 1) {
    await page.tap('.keypad .kp-nav').catch(() => {});
    await sleep(220);
    again.push((await readNav(page)).text);
  }
  ok(again[pages - 1] === `1/${pages}`, `and again after a full second cycle (got ${JSON.stringify(again[pages - 1])})`, again);

  ok(pageErrors.length === 0, 'no page errors on solo.html', pageErrors.slice(0, 3));
} catch (e) {
  failed += 1;
  console.log(`\n✗ EXCEPTION: ${e && e.stack ? e.stack : e}`);
  console.log(`--- engine/broker log tail ---\n${log.slice(-900)}`);
} finally {
  if (browser) {
    await browser.close().catch(() => {});
  }
  for (const p of procs) {
    p.kill('SIGKILL');
  }
  await sleep(300);
  rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${'='.repeat(40)}\nPASS ${passed}  FAIL ${failed}`);
process.exit(failed ? 1 : 0);
