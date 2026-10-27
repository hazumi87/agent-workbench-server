/* THE TAB STRIP ON A TOUCH TABLET [ipad tabs]  node test/room-ipad-tabs.probe.mjs   Owner 2026-10-05
 * The real room / agent pages and the shell against a scratch engine (dead broker, temp table, never a live pane).
 *   iPad 1366x1024 + 1024x1366 (touch): a room or an agent page opened at the top level hands itself to the SHELL
 *   (/shell.html?tabs=...): the tab strip is in the page (hub chip + one tab per page), the page is a frame in it, the
 *   window caption cluster is hidden (no host), tapping a tab switches pages; with a SIMULATED soft keyboard the shell
 *   shrinks to what the keys leave and the room frame follows it (composer in view).
 *   390 phone, 1280 mouse, a tablet without touch, and ?shell=0: the page stays bare, as before. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(398);
const DEAD = P(399);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-ipad-tabs-token';
const SHOTS = process.env.IPAD_SHOTS || tmpdir();
let failures = 0;
const ok = (c, m, d) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${d !== undefined ? `  (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); if (!c) failures += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runTsx = (args, env) => new Promise((resolve) => {
  const pr = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
  let out = ''; let err = '';
  pr.stdout.on('data', (d) => (out += d)); pr.stderr.on('data', (d) => (err += d));
  pr.on('exit', (code) => resolve({ code, out, err }));
});
/* before any page script: a visualViewport whose height the probe can shrink (the soft keyboard) */
const INIT = () => {
  const real = window.visualViewport;
  const fake = new EventTarget();
  let kb = 0;
  Object.defineProperties(fake, {
    width: { get: () => (real ? real.width : window.innerWidth) },
    height: { get: () => (real ? real.height : window.innerHeight) - kb },
    scale: { get: () => (real ? real.scale : 1) },
    offsetTop: { get: () => (real ? real.offsetTop : 0) },
    offsetLeft: { get: () => (real ? real.offsetLeft : 0) },
    pageTop: { get: () => (real ? real.pageTop : 0) },
    pageLeft: { get: () => (real ? real.pageLeft : 0) },
  });
  real?.addEventListener('resize', () => fake.dispatchEvent(new Event('resize')));
  Object.defineProperty(window, 'visualViewport', { get: () => fake, configurable: true });
  window.__kb = (px) => { kb = px; fake.dispatchEvent(new Event('resize')); };
};
await assertFree(PORT, 'room-ipad-tabs.probe.mjs');
await assertFree(DEAD, 'room-ipad-tabs.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-ipad-tabs-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null; let browser = null; let log = '';
try {
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
    return JSON.parse(r.out.trim().split('\n').pop());
  };
  await seed({ recipes: [{ id: 'rec-a', name: 'Awake', projectDir: '/srv/x/awake', vendor: 'claude-code', agent: 'awake', color: '#0dab49' }] });
  const loader = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loader, join('src', 'server', 'index.ts')], { cwd: REPO_ROOT, env: childEnv({
    HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: dbPath, HARBOR_WB_TOKEN: TOKEN,
    HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'), HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_NO_WINDOW: '1',
    HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(DEAD),
    HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'cp'), HARBOR_WB_NODE: 'testnode' }) });
  engine.stdout.on('data', (d) => (log += d)); engine.stderr.on('data', (d) => (log += d));
  let up = false;
  for (let i = 0; i < 120 && !up; i += 1) { await sleep(250); try { up = (await fetch(`${BASE}/health`)).ok; } catch { /* not yet */ } }
  ok(up, 'scratch engine up', up ? undefined : log.slice(-300));
  if (!up) { throw new Error('no engine'); }
  const R = (await seed({ rooms: [{ name: 'Tablet', seats: [{ handle: 'awake', recipe_id: 'rec-a' }] }] })).rooms[0].id;
  const ROOM = `/room.html?room=${R}`;
  const SOLO = '/solo.html?recipe=rec-a';
  browser = await chromium.launch({ headless: true });
  const CASES = [
    { name: 'iPad landscape 1366x1024', w: 1366, h: 1024, touch: true, shell: true },
    { name: 'iPad portrait 1024x1366', w: 1024, h: 1366, touch: true, shell: true },
    { name: 'phone 390', w: 390, h: 780, touch: true, shell: false },
    { name: 'desktop 1280 (mouse)', w: 1280, h: 860, touch: false, shell: false },
    { name: 'tablet 1366x1024 with a trackpad (fine pointer)', w: 1366, h: 1024, touch: false, shell: false },
  ];
  for (const c of CASES) {
    const ctx = await browser.newContext({ viewport: { width: c.w, height: c.h }, hasTouch: c.touch, isMobile: c.touch });
    await ctx.addInitScript(INIT);
    const pg = await ctx.newPage();
    const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
    await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
    await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);
    const label = c.name;
    for (const [mpath, mlabel] of [['/manager.html', 'manager.html'], ['/', 'the root']]) {
      await pg.evaluate(() => { try { sessionStorage.clear(); } catch (e) { /* none */ } });
      await pg.goto(`${BASE}${mpath}`, { waitUntil: 'domcontentloaded' });
      await sleep(2200);
      const mp = new URL(pg.url());
      if (c.shell) {
        ok(mp.pathname === '/shell.html' && !mp.searchParams.has('tabs'), `${label}: the CLI Manager opened bare (${mlabel}) lands in the shell`, pg.url());
        const hub = await pg.evaluate(() => ({ chips: [...document.querySelectorAll('.hwb-tab')].map((t) => t.textContent.trim().replace(/\s+/g, ' ').slice(0, 20)), frames: [...document.querySelectorAll('#stage iframe')].map((f) => new URL(f.src).pathname), absent: document.querySelectorAll('.hwb-tab.is-absent').length }));
        ok(hub.chips.filter((t) => /CLI Manager|Workbench|Manager/.test(t)).length === 1 && hub.absent === 0 && hub.frames.length === 1, `${label}: ...with ONE "CLI Manager" chip (the hub, present), one frame (${mlabel})`, hub);
      } else {
        ok(mp.pathname === mpath, `${label}: the CLI Manager stays bare (${mlabel})`);
      }
    }
    await pg.evaluate(() => { try { sessionStorage.clear(); } catch (e) { /* none */ } }); // the shell keeps its tab set per browsing context: start the room case clean
    await pg.goto(`${BASE}${ROOM}`, { waitUntil: 'domcontentloaded' });
    await sleep(2200);
    const at = new URL(pg.url());
    if (!c.shell) {
      ok(at.pathname === '/room.html', `${label}: the room page stays bare`, at.pathname);
      await pg.goto(`${BASE}${SOLO}`, { waitUntil: 'domcontentloaded' });
      await sleep(1200);
      ok(new URL(pg.url()).pathname === '/solo.html', `${label}: the agent page stays bare`);
    } else {
      ok(at.pathname === '/shell.html' && at.searchParams.get('tabs') === ROOM, `${label}: the room hands itself to the shell`, pg.url());
      const st = await pg.evaluate(() => ({
        tabs: [...document.querySelectorAll('.hwb-tab')].map((t) => t.textContent.trim().replace(/\s+/g, ' ').slice(0, 24)),
        frames: [...document.querySelectorAll('#stage iframe')].map((f) => new URL(f.src).pathname),
        caps: getComputedStyle(document.querySelector('.hwb-caps')).display,
        tw: document.documentElement.classList.contains('touch-wide'),
      }));
      ok(st.tw && st.tabs.length >= 2 && st.frames.includes('/room.html') && st.caps === 'none', `${label}: the tab strip is in the page (hub + the room), the room is a frame, no caption cluster`, st);
      /* two pages: the room + an agent page, then tap between them */
      await pg.goto(`${BASE}/shell.html?tabs=${encodeURIComponent(ROOM)},${encodeURIComponent(SOLO)}`, { waitUntil: 'domcontentloaded' });
      await sleep(2500);
      const two = await pg.evaluate(() => ({ n: document.querySelectorAll('.hwb-tab:not(.is-hub)').length, frames: [...document.querySelectorAll('#stage iframe')].map((f) => new URL(f.src).pathname), active: [...document.querySelectorAll('.hwb-tab')].findIndex((t) => t.classList.contains('is-active')) }));
      ok(two.n === 2 && two.frames.includes('/room.html') && two.frames.includes('/solo.html'), `${label}: a tab per page (room + agent)`, two);
      const first = two.active;
      await pg.locator('.hwb-tab:not(.is-hub)').nth(first <= 1 ? 1 : 0).tap();
      await sleep(500);
      const sw = await pg.evaluate(() => [...document.querySelectorAll('.hwb-tab')].findIndex((t) => t.classList.contains('is-active')));
      ok(sw !== first, `${label}: tapping the other tab switches to it`, { first, sw });
      await pg.screenshot({ path: join(SHOTS, `ipad-${c.w}-tabs.png`) });
      /* the room tab alone, with the soft keyboard */
      await pg.goto(`${BASE}/shell.html?tabs=${encodeURIComponent(ROOM)}`, { waitUntil: 'domcontentloaded' });
      await sleep(2500);
      await pg.locator('.hwb-tab', { hasText: 'Tablet' }).first().tap(); // the room tab, whatever the stored set had selected
      await sleep(600);
      const frameH = await pg.evaluate(() => Math.round([...document.querySelectorAll('#stage iframe')].find((f) => /room\.html/.test(f.src)).getBoundingClientRect().height));
      ok(frameH > 300, `${label}: the room tab is the one showing (frame ${frameH}px)`);
      const KB = Math.round(c.h * 0.42);
      await pg.evaluate((k) => { window.__kb(k); }, KB);
      await sleep(500);
      const fr = pg.frames().find((f) => f !== pg.mainFrame() && /room\.html/.test(f.url()));
      await fr.evaluate(() => { document.getElementById('input').focus(); });
      await sleep(300);
      const kb = await pg.evaluate(() => ({ up: document.documentElement.classList.contains('kb-up'), bodyH: Math.round(document.body.getBoundingClientRect().height), vvh: Math.round(window.visualViewport.height), frameBottom: Math.round([...document.querySelectorAll('#stage iframe')].find((f) => /room\.html/.test(f.src)).getBoundingClientRect().bottom) }));
      const inF = await fr.evaluate(() => ({ up: document.documentElement.classList.contains('kb-up'), ih: innerHeight, vvh: document.documentElement.style.getPropertyValue('--vvh'), bodyH: Math.round(document.body.getBoundingClientRect().height), cBottom: Math.round(document.getElementById('compose').getBoundingClientRect().bottom) }));
      ok(kb.up && Math.abs(kb.bodyH - kb.vvh) <= 1 && kb.frameBottom > 200 && kb.frameBottom <= kb.vvh + 1, `${label}: keyboard up: the shell shrinks to what the keys leave (${kb.bodyH} of ${kb.vvh}), the frame ends above them`, kb);
      ok(inF.up && inF.ih > 200 && inF.bodyH <= inF.ih + 1 && inF.cBottom > 100 && inF.cBottom <= inF.ih + 1, `${label}: the room frame follows (kb-up, its composer inside the visible frame)`, inF);
      await pg.evaluate(() => { window.__kb(0); });
      await sleep(400);
      const down = await pg.evaluate(() => ({ up: document.documentElement.classList.contains('kb-up'), bodyH: Math.round(document.body.getBoundingClientRect().height), ih: innerHeight }));
      const downF = await fr.evaluate(() => document.documentElement.classList.contains('kb-up'));
      ok(!down.up && Math.abs(down.bodyH - down.ih) <= 1 && !downF, `${label}: keyboard down: the shell and the frame are back to full`, { down, downF });
      /* an agent tab: the CLI keypad shows while the keyboard is up (the shell tells the frame) */
      await pg.goto(`${BASE}/shell.html?tabs=${encodeURIComponent(SOLO)}`, { waitUntil: 'domcontentloaded' });
      await sleep(2500);
      await pg.locator('.hwb-tab', { hasText: 'Awake' }).first().tap(); // the agent tab (the shell keeps its stored set of tabs)
      await sleep(600);
      await pg.evaluate((k) => { window.__kb(k); }, KB);
      await sleep(600);
      const sf = pg.frames().find((f) => f !== pg.mainFrame() && /solo\.html/.test(f.url()));
      const pad = await sf.evaluate(() => { const p = document.querySelector('.keypad'); const r = p?.getBoundingClientRect(); return { built: !!p, shown: !!r && r.height > 0, kbUp: document.documentElement.classList.contains('kb-up'), bottom: r ? Math.round(r.bottom) : null, ih: innerHeight }; });
      ok(pad.built && pad.shown && pad.kbUp && pad.bottom <= pad.ih + 1, `${label}: an agent tab shows the CLI keypad above the keys`, pad);
      await pg.evaluate(() => { window.__kb(0); });
      await sleep(300);
      await pg.goto(`${BASE}${ROOM}&shell=0`, { waitUntil: 'domcontentloaded' });
      await sleep(1200);
      ok(new URL(pg.url()).pathname === '/room.html', `${label}: ?shell=0 keeps the page bare`);
    }
    ok(errs.length === 0, `${label}: no page errors`, errs.slice(0, 2));
    await ctx.close();
  }
} catch (e) {
  failures += 1; console.log(` FAIL ${e?.stack ?? e}`);
} finally {
  await browser?.close();
  engine?.kill('SIGKILL');
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* EPERM on Windows */ }
}
console.log(failures ? `FAIL ${failures}` : 'PASS');
process.exit(failures ? 1 : 0);
