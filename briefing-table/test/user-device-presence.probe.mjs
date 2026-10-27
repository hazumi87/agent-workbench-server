/* USER DEVICE PRESENCE in real browsers [room [ref]]. A PROBE (not in npm test): spins its OWN scratch engine on P() ports with a temp
 * table, no broker, no pty. Chromium always; WebKit when installed. Proves the wiring the unit tests cannot: a phone-shaped context
 * (390x844, touch, mobile) reports class 'phone', a 1280x800 mouse context 'desktop', a page inside the shell frame 'shell-tab';
 * GET /api/presence/user lists them with the right primary; a page that goes hidden is no longer active. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(542);
const DEAD_BROKER_PORT = P(543);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-device-presence-token';
let failures = 0;
const ok = (c, m, d) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${d !== undefined ? `  (${d})` : ''}`); if (!c) failures += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async () => (await fetch(`${BASE}/api/presence/user`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
async function until(fn, ms = 8000) { const t = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t > ms) return null; await sleep(250); } }

await assertFree(PORT, 'user-device-presence.probe.mjs');
await assertFree(DEAD_BROKER_PORT, 'user-device-presence.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-devpresence-probe-'));
let engine = null;
const browsers = [];
try {
  engine = spawn(process.execPath, ['--import', 'tsx', join(REPO_ROOT, 'src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'), HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT),
      HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'), HARBOR_WB_TOKEN: TOKEN, HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'),
    }),
  });
  let log = '';
  engine.stdout.on('data', (d) => { log += d; });
  engine.stderr.on('data', (d) => { log += d; });
  const up = await until(async () => (await fetch(`${BASE}/health`)).ok, 20000);
  ok(!!up, `scratch engine serving on ${PORT}`, up ? undefined : log.slice(-300));
  if (!up) throw new Error('engine never came up');

  async function signedIn(browser, opts) {
    const ctx = await browser.newContext(opts);
    const p = await ctx.newPage();
    await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await p.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
    await Promise.all([p.waitForNavigation().catch(() => {}), p.click('form button:visible')]);
    return p;
  }
  const hide = (p) => p.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  for (const [name, engineType, phoneUA] of [
    ['chromium', chromium, { isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }],
    ['webkit', webkit, { isMobile: true, hasTouch: true, deviceScaleFactor: 3 }],
  ]) {
    console.log(`\n=== ${name} ===`);
    let browser;
    try { browser = await engineType.launch({ headless: true }); } catch (e) { console.log(`  skip ${name}: not installed (${String(e.message).split('\n')[0]})`); continue; }
    browsers.push(browser);
    await fetch(`${BASE}/api/presence/user`, { headers: { authorization: `Bearer ${TOKEN}` } }); // warm

    const idOf = (p) => until(() => p.evaluate(() => localStorage.getItem('hwb.device.id')), 15000);
    const rowOf = async (id) => { const r = await get(); return { r, row: [...r.active, ...r.recent].find((d) => d.device === id) }; };
    const waitRow = (id, pred) => until(async () => { const x = await rowOf(id); return x.row && pred(x.row, x.r) ? x : null; });

    const desk = await signedIn(browser, { viewport: { width: 1280, height: 800 } });
    await desk.goto(`${BASE}/manager.html`, { waitUntil: 'domcontentloaded' });
    await sleep(500);
    const deskId = await idOf(desk);
    let x = await waitRow(deskId, (d) => d.class === 'desktop' && d.surface === 'browser');
    ok(!!x, `${name}: a 1280x800 mouse page reports class 'desktop', surface 'browser'`, x ? `${x.row.browser}/${x.row.os}` : deskId);

    const shell = await signedIn(browser, { viewport: { width: 1280, height: 800 } });
    await shell.goto(`${BASE}/shell.html`, { waitUntil: 'domcontentloaded' });
    await sleep(800);
    const shellId = await idOf(shell);
    x = await waitRow(shellId, (d) => d.surface === 'shell-tab');
    ok(!!x, `${name}: a page inside the shell frame reports surface 'shell-tab'`, x ? x.row.page : shellId);

    const phone = await signedIn(browser, { viewport: { width: 390, height: 844 }, ...phoneUA });
    await phone.goto(`${BASE}/manager.html`, { waitUntil: 'domcontentloaded' });
    await sleep(500);
    const phoneId = await idOf(phone);
    x = await waitRow(phoneId, (d) => d.class === 'phone');
    ok(!!x, `${name}: a 390x844 touch/mobile page reports class 'phone'`, x ? x.r.summary : phoneId);
    ok(x?.row.viewport.w === 390 && x?.row.viewport.h === 844, 'the phone row carries its viewport', x && JSON.stringify(x.row.viewport));
    ok(x?.r.primary?.device === phoneId, 'primary = the most recently reporting visible device (the phone)', x?.r.primary?.class);
    ok([deskId, shellId, phoneId].every((id) => x?.r.active.some((d) => d.device === id)), 'all three devices are listed as active');

    await hide(phone);
    x = await waitRow(phoneId, (d, r) => !r.active.some((a) => a.device === phoneId));
    ok(!!x, `${name}: the phone page goes hidden -> no longer active`, x ? x.r.summary : 'still active');
    ok(x?.r.recent.some((d) => d.device === phoneId), 'and it is listed as recent');
    ok(x?.r.primary?.device !== phoneId, 'and it is no longer primary');
    await browser.close();
  }
} catch (e) {
  failures += 1;
  console.log(` FAIL ${e.stack || e.message}`);
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  if (engine) engine.kill('SIGKILL');
  rmSync(tmpDir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED` : '\nall ok');
process.exit(failures ? 1 : 0);
