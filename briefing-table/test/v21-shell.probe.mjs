/* v21 SHELL WIRING — bar-wash vars, --pc, and the bundle's tab events.
 *
 * test/shell-tabs.test.mjs proves the RULES (washVars, paneidFromTabUrl,
 * routeBundleEvent) under node. Only a browser proves the WIRING: that the
 * shell measures the real selected chip, re-measures on resize and on select,
 * paints --pc, and that synthetic `hwb:*` CustomEvents (the v21 bundle is not
 * here yet) reach the existing close / end / reload paths.
 *
 * A PROBE, not part of `npm test`. Spins its OWN engine on scratch port P(7)
 * with a temp table, like shell-tabs.probe.mjs; never touches :7420, the real
 * broker, or a live pane. Session pages are STUBBED with page.route, and
 * the End POST is intercepted, so no pty is ever created or killed.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/* Scratch ports — the port table is in test/_scratch.mjs. */
const PORT = P(7);
const DEAD_BROKER_PORT = P(13); // told to the engine; nothing may listen there
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-v21-shell-token';

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${detail})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TABS = ['/solo.html?recipe=aaa', '/solo.html?recipe=bbb', '/solo.html?recipe=ccc&pane=ccc-2'];
const shellUrl = (tabs) => `${BASE}/app/shell.html?kind=manager&debug=1&tabs=${tabs.map(encodeURIComponent).join(',')}`;

try {
  const stale = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
  if (stale.ok) {
    console.log(` FAIL  :${PORT} is already serving something — a leaked engine from an aborted run?`);
    process.exit(1);
  }
} catch { /* nothing there: what we want */ }
for (const p of [PORT, DEAD_BROKER_PORT]) {
  await assertFree(p, 'v21-shell.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-v21-probe-'));
let engine = null;
let browser = null;

try {
  engine = spawn(process.execPath, ['--import', 'tsx', join(REPO_ROOT, 'src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT),
      HARBOR_WB_HOST: '127.0.0.1',
      HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'),
      HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_NATS_URL: '',
      HARBOR_WB_FABRIC_URL: '',
      HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT),
      HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
      HARBOR_WB_TOKEN: TOKEN,
      HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'),
    }),
  });
  let engineLog = '';
  engine.stdout.on('data', (d) => { engineLog += d; });
  engine.stderr.on('data', (d) => { engineLog += d; });
  let up = false;
  for (let i = 0; i < 80; i += 1) {
    await sleep(250);
    try { if ((await fetch(`${BASE}/health`)).ok) { up = true; break; } } catch { /* not yet */ }
  }
  ok(up, `scratch engine is serving on ${PORT}`, up ? undefined : engineLog.slice(-400));
  if (!up) { throw new Error('engine never came up'); }

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();

  /* Stub every session page: a real solo.html would try to attach a pane. */
  let loads = 0;
  await context.route('**/solo.html*', (route) => {
    loads += 1;
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>stub</title><body>stub</body>' });
  });
  const ended = [];
  await context.route('**/api/sessions/*/end', (route) => {
    ended.push(decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3]));
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    const f = document.querySelector('form');
    (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
  }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  ok(!page.url().includes('/login'), 'signed in to the scratch engine');

  await page.goto(shellUrl(TABS), { waitUntil: 'domcontentloaded' });
  await sleep(1200);

  const read = () => page.evaluate(() => {
    const win = document.getElementById('win');
    const chip = win.querySelector('.hwb-tabs .hwb-tab.is-active');
    const wr = win.getBoundingClientRect();
    const cr = chip ? chip.getBoundingClientRect() : null;
    return {
      washX: win.style.getPropertyValue('--bar-wash-x'),
      washCore: win.style.getPropertyValue('--bar-wash-core'),
      expectX: cr ? cr.left - wr.left + cr.width / 2 : null,
      expectCore: cr ? cr.width / 2 : null,
      chipBases: [...win.querySelectorAll('.hwb-tabs .hwb-tab[data-tab]')].map((c) => c.style.getPropertyValue('--base')),
      activeTab: chip ? chip.dataset.tab : null,
      tabIds: [...win.querySelectorAll('.hwb-tabs .hwb-tab[data-tab]')].map((c) => c.dataset.tab),
      frames: document.querySelectorAll('#stage iframe').length,
    };
  });

  let s = await read();
  ok(s.frames === 3, 'three session tabs open', s.frames);
  /* v21.1: the BUNDLE measures the wash (hwbPositionBarWash). The shell's
     clear-it branch is for an untabbed window, which "always tabbed" retired. */
  const near = (v, e) => !!v && e !== null && Math.abs(parseFloat(v) - e) <= 1;
  ok(near(s.washX, s.expectX), '--bar-wash-x = selected chip centre vs the WINDOW (bundle-measured)', `${s.washX} vs ${s.expectX}`);
  ok(near(s.washCore, s.expectCore), '--bar-wash-core = half the chip width', `${s.washCore} vs ${s.expectCore}`);
  ok(s.chipBases.length === 3 && s.chipBases.every(Boolean), 'every chip carries its own --base (its project colour)', s.chipBases.join(' | '));

  /* select another tab -> the wash follows */
  const first = s.tabIds[s.tabIds.length - 1]; // not the initially-active one
  await page.click(`.hwb-tabs .hwb-tab[data-tab="${first}"]`);
  await sleep(300);
  s = await read();
  ok(s.activeTab === first && near(s.washX, s.expectX), 'selecting a tab moves the wash onto it', `${s.washX} vs ${s.expectX}`);

  /* resize -> re-measured */
  const beforeResize = s.washX;
  await page.setViewportSize({ width: 800, height: 800 });
  await sleep(400);
  s = await read();
  ok(near(s.washX, s.expectX), 'a window resize re-measures', `${beforeResize} -> ${s.washX} (expect ${s.expectX})`);

  /* hwb:refresh -> that tab reloads, the shell stands */
  const loadsBefore = loads;
  const target = s.tabIds[1];
  await page.evaluate((id) => {
    document.getElementById('win').dispatchEvent(new CustomEvent('hwb:refresh', { detail: { id }, bubbles: true }));
  }, target);
  await sleep(600);
  s = await read();
  ok(loads === loadsBefore + 1, 'hwb:refresh reloaded exactly one tab page', `${loads - loadsBefore} loads`);
  ok(s.frames === 3, 'and no tab was lost', s.frames);

  /* hwb:end-session -> the Manager's End path for that pane, then the tab goes */
  const endId = s.tabIds[2];
  await page.evaluate((id) => {
    document.getElementById('win').dispatchEvent(new CustomEvent('hwb:end-session', { detail: { id }, bubbles: true }));
  }, endId);
  await sleep(600);
  s = await read();
  ok(ended.join(',') === 'ccc-2', 'hwb:end-session POSTed /api/sessions/<paneid>/end for THAT tab', ended.join(','));
  ok(s.frames === 2 && !s.tabIds.includes(endId), 'and the ended tab is gone', s.tabIds.join(','));

  /* hwb:close-view -> tab closes, nothing ended */
  const closeId = s.tabIds[0];
  await page.evaluate((id) => {
    document.dispatchEvent(new CustomEvent('hwb:close-view', { detail: { id, reason: 'probe' } }));
  }, closeId);
  /* close-view goes through closeTab (the page is asked, parks, answers); a
     STUBBED page never answers, so the 1.5s ack guard closes it locally */
  await sleep(2000);
  s = await read();
  ok(s.frames === 1, 'hwb:close-view closed the tab', s.frames);
  ok(ended.length === 1, 'and ended nothing (the session stays in the broker)', ended.length);
  /* ALWAYS TABBED (Owner, 2026-09-21, bb9785d): the strip carries the hub chip,
     the only way back to the Manager, so a one-tab window keeps it. The old
     "no strip clears the wash vars" branch can no longer be reached; what is
     true now is that the wash sits on the one remaining chip. */
  ok(s.tabIds.length === 1 && near(s.washX, s.expectX),
    'a one-tab window keeps its strip (always tabbed) and the wash sits on that chip',
    `${s.tabIds.length} tab(s), ${s.washX || '(unset)'} vs ${s.expectX}`);
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* sqlite holds it on Windows */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
