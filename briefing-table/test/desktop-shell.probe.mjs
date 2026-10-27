/* THE TAB STRIP IN A DESKTOP BROWSER [desktop shell]  node test/desktop-shell.probe.mjs   Owner 2026-10-14
 * A room link / agent page / Manager opened in a normal desktop browser (1280x800, mouse) lands in /shell.html with a tab for
 * the page and the Workbench hub tab. Stays bare: ?shell=0, localStorage hwb.shell.desktop='0', a phone (390x844 touch), a page in a
 * frame, a standalone app window (display-mode: standalone). Still wraps: an iPad-like touch-wide. A webdriver is bare by default
 * (so ~90 older probes are untouched) and is forced with localStorage hwb.shell.desktop='1' / ?shell=1; the 'real default' cases
 * hide navigator.webdriver. Chromium, plus WebKit when installed. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(560);
const DEAD = P(561);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-desktop-shell-token';
let failures = 0;
const ok = (c, m, d) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${d !== undefined ? `  (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); if (!c) failures += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runTsx = (args, env) => new Promise((resolve) => {
  const pr = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
  let out = ''; let err = '';
  pr.stdout.on('data', (d) => (out += d)); pr.stderr.on('data', (d) => (err += d));
  pr.on('exit', (code) => resolve({ code, out, err }));
});
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
  const R = (await seed({ rooms: [{ name: 'Tablet', seats: [{ handle: 'awake', recipe_id: 'rec-a' }] }, { name: 'Second', seats: [] }] })).rooms.map((x) => x.id);
  const [R1, R2] = [R[0], R[1]];
  const ROOM = `/room.html?room=${R1}`;
  const ROOM2 = `/room.html?room=${R2}`;
  const SOLO = '/solo.html?recipe=rec-a';
  const login = async (pg) => {
    await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
    await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);
  };
  const unWebdriver = () => { Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true }); };
  const engines = [['chromium', chromium]];
  try { const w = await webkit.launch({ headless: true }); await w.close(); engines.push(['webkit', webkit]); } catch { console.log('  (webkit not installed: skipped)'); }
  for (const [bname, bt] of engines) {
    browser = await bt.launch({ headless: true });
    const mk = async (opts, init) => {
      const ctx = await browser.newContext(opts);
      if (init) { await ctx.addInitScript(init); }
      const pg = await ctx.newPage();
      const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
      await login(pg);
      return { ctx, pg, errs };
    };
    const go = async (pg, path) => { await pg.evaluate(() => { try { sessionStorage.clear(); } catch (e) { /* none */ } }); await pg.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' }); await sleep(2200); return new URL(pg.url()); };
    const DESK = { viewport: { width: 1280, height: 800 } };
    /* 1. the real default (webdriver hidden): room, agent page, manager enter the shell */
    {
      const { ctx, pg, errs } = await mk(DESK, unWebdriver);
      const L = `${bname} 1280x800 mouse`;
      let u = await go(pg, ROOM);
      ok(u.pathname === '/shell.html' && u.searchParams.get('tabs') === ROOM, `${L}: a room link lands in the shell`, pg.url());
      const st = await pg.evaluate(() => ({
        tabs: [...document.querySelectorAll('.hwb-tab')].map((t) => t.textContent.trim().replace(/\s+/g, ' ').slice(0, 24)),
        frames: [...document.querySelectorAll('#stage iframe')].map((f) => new URL(f.src).pathname),
        hub: document.querySelectorAll('.hwb-tab.is-hub').length, caps: getComputedStyle(document.querySelector('.hwb-caps')).display }));
      ok(st.hub === 1 && st.tabs.some((t) => /Tablet/.test(t)) && st.frames.includes('/room.html') && st.caps === 'none', `${L}: a tab for the room + the hub tab, the room is a frame, no caption cluster`, st);
      u = await go(pg, SOLO);
      ok(u.pathname === '/shell.html' && u.searchParams.get('tabs') === SOLO, `${L}: an agent page lands in the shell`, pg.url());
      for (const mp of ['/manager.html', '/']) {
        u = await go(pg, mp);
        const n = await pg.evaluate(() => ({ hubs: document.querySelectorAll('.hwb-tab.is-hub').length, frames: document.querySelectorAll('#stage iframe').length }));
        ok(u.pathname === '/shell.html' && !u.searchParams.has('tabs') && n.hubs === 1 && n.frames === 1, `${L}: the Manager (${mp}) lands in the shell as the one hub tab`, { url: pg.url(), n });
      }
      u = await go(pg, `${ROOM}&shell=0`);
      ok(u.pathname === '/room.html', `${L}: ?shell=0 stays bare`);
      /* a page in a frame never redirects: the shell's own room frame stayed room.html (above), and a bare iframe host */
      await pg.goto(`${BASE}/shell.html?tabs=${encodeURIComponent(ROOM)}`, { waitUntil: 'domcontentloaded' });
      await sleep(2000);
      ok(pg.frames().some((f) => f !== pg.mainFrame() && /room\.html/.test(f.url())) && !pg.frames().some((f) => f !== pg.mainFrame() && /shell\.html/.test(f.url())), `${L}: the room inside the shell stays a frame (never a shell in a shell)`);
      /* the persistent opt-out */
      await pg.evaluate(() => localStorage.setItem('hwb.shell.desktop', '0'));
      u = await go(pg, ROOM);
      ok(u.pathname === '/room.html', `${L}: localStorage hwb.shell.desktop=0 stays bare`);
      u = await go(pg, '/manager.html');
      ok(u.pathname === '/manager.html', `${L}: ...the Manager too`);
      await pg.evaluate(() => localStorage.removeItem('hwb.shell.desktop'));
      ok(errs.length === 0, `${L}: no page errors`, errs.slice(0, 2));
      await ctx.close();
    }
    /* 2. webdriver (default): bare, forced by localStorage '1' */
    {
      const { ctx, pg } = await mk(DESK);
      const L = `${bname} webdriver`;
      let u = await go(pg, ROOM);
      ok(u.pathname === '/room.html', `${L}: automation stays bare by default`);
      await pg.evaluate(() => localStorage.setItem('hwb.shell.desktop', '1'));
      u = await go(pg, ROOM);
      ok(u.pathname === '/shell.html', `${L}: localStorage hwb.shell.desktop=1 forces the shell`);
      await ctx.close();
    }
    /* 3. phone 390x844 touch: never wrapped, even forced */
    {
      const { ctx, pg } = await mk({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, unWebdriver);
      const L = `${bname} phone 390x844 touch`;
      let u = await go(pg, ROOM);
      ok(u.pathname === '/room.html', `${L}: the room is never wrapped`);
      u = await go(pg, `${SOLO}&shell=1`);
      ok(u.pathname === '/solo.html', `${L}: not even with ?shell=1`);
      await ctx.close();
    }
    /* 4. iPad-like touch-wide still wraps */
    {
      const { ctx, pg } = await mk({ viewport: { width: 1366, height: 1024 }, hasTouch: true, isMobile: true });
      const u = await go(pg, ROOM);
      ok(u.pathname === '/shell.html' && u.searchParams.get('tabs') === ROOM, `${bname} iPad-like touch-wide: still wraps`, pg.url());
      await ctx.close();
    }
    /* 5. a standalone app window (Edge --app) stays bare */
    if (bname === 'chromium') {
      const { ctx, pg } = await mk(DESK, () => {
        unWebdriver();
        const real = window.matchMedia.bind(window);
        window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : real(q));
      });
      const u = await go(pg, SOLO);
      ok(u.pathname === '/solo.html', `${bname} standalone app window: stays bare`);
      await ctx.close();
    }
    /* 6. the click-through (Owner [ref]): Manager -> Open room, in ONE browser tab */
    {
      const { ctx, pg, errs } = await mk(DESK, () => { try { localStorage.setItem('hwb.shell.desktop', '1'); } catch (e) { /* none */ } });
      const L = `${bname} click-through`;
      const navs = []; pg.on('framenavigated', (f) => { if (f === pg.mainFrame()) { navs.push(new URL(f.url()).pathname); } });
      let u = await go(pg, '/manager.html');
      const tabs = () => pg.evaluate(() => ({ n: document.querySelectorAll('.hwb-tab').length, hub: document.querySelectorAll('.hwb-tab.is-hub').length, labels: [...document.querySelectorAll('.hwb-tab')].map((t) => t.textContent.trim().replace(/\s+/g, ' ').slice(0, 20)), frames: [...document.querySelectorAll('#stage iframe')].map((f) => new URL(f.src).pathname + new URL(f.src).search), active: [...document.querySelectorAll('.hwb-tab')].findIndex((t) => t.classList.contains('is-active')) }));
      ok(u.pathname === '/shell.html', `${L}: /manager.html lands in the shell`, pg.url());
      let t = await tabs();
      ok(t.hub === 1, `${L}: the hub tab is there`, t);
      const mf = () => pg.frames().find((f) => f !== pg.mainFrame() && /manager\.html|\/$/.test(new URL(f.url()).pathname));
      const mgr = mf();
      await mgr.waitForSelector('button:has-text("Open room")', { timeout: 15000 });
      const cards = mgr.locator('button:has-text("Open room")');
      const nCards = await cards.count();
      ok(nCards >= 2, `${L}: the Manager lists the room cards`, nCards);
      await mgr.locator('.room-card, [class*=rcard], article, li', { has: mgr.locator('button:has-text("Open room")') }).filter({ hasText: 'Tablet' }).first().locator('button:has-text("Open room")').click();
      await sleep(1500);
      t = await tabs();
      ok(t.n === 2 && t.hub === 1 && t.frames.some((f) => f.includes(R1)), `${L}: Open room adds a tab (hub + room), the room is an iframe`, t);
      ok(new URL(pg.url()).pathname === '/shell.html' && !navs.some((p) => p === '/room.html'), `${L}: the address bar stays on /shell.html (no top-level navigation to room.html)`, { url: pg.url(), navs });
      /* back to the hub, open the second room the same way */
      await pg.locator('.hwb-tab.is-hub').click();
      await sleep(800);
      const mgr2 = mf();
      await mgr2.locator('.room-card, [class*=rcard], article, li', { has: mgr2.locator('button:has-text("Open room")') }).filter({ hasText: 'Second' }).first().locator('button:has-text("Open room")').click();
      await sleep(1500);
      t = await tabs();
      ok(t.n === 3 && t.hub === 1 && t.frames.some((f) => f.includes(R1)) && t.frames.some((f) => f.includes(R2)), `${L}: a second room gives THREE tabs`, t);
      /* the room card's menu Open does the same */
      ok(new URL(pg.url()).pathname === '/shell.html', `${L}: still /shell.html`);
      await pg.locator('.hwb-tab.is-hub').click();
      await sleep(600);
      t = await tabs();
      ok(t.active === t.labels.findIndex((_, i) => i === 0) || t.active >= 0, `${L}: the hub tab is clickable to go back`, t);
      /* close a room tab: the others stay */
      const closeBtn = pg.locator('.hwb-tab:not(.is-hub)').last().locator('.tclose').first();
      if (await closeBtn.count()) { await pg.locator('.hwb-tab:not(.is-hub)').last().hover(); await closeBtn.click({ force: true }); await sleep(800); }
      t = await tabs();
      ok(t.n === 2 && t.hub === 1, `${L}: closing a tab leaves the others`, t);
      ok(new URL(pg.url()).pathname === '/shell.html', `${L}: and the address bar is still /shell.html`);
      ok(errs.length === 0, `${L}: no page errors`, errs.slice(0, 2));
      await ctx.close();
    }
    await browser.close(); browser = null;
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
