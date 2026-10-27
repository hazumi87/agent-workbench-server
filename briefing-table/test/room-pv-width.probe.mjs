/* THE PREVIEW COLUMN'S WIDTH, THE DRAWER AND THE ASSETS GRID [pv drawer]  node test/room-pv-width.probe.mjs   Owner 2026-10-07, the design system numbers
 * The real room page against a scratch engine (dead broker, temp table, never a live pane), at 1280 / 1024 / 900 and with a wide rail:
 *   chat minimum 480; preview column minimum 320, preferred 370; while rail + 480 + 320 does not fit (1072 at the default rail) the preview is a
 *   DRAWER over the chat (370 or the window less 56), anchored right, with the room's scrim: ✕, Esc and the scrim close it; the rail stays usable;
 *   a resize between column and drawer does not close it or lose its place in the list.
 *   Assets grid: three columns at a column of 344+ (about 109px tiles at 370), two below (142px at 320), never a tile under 100; FOUR rows counted
 *   across the list (12 tiles at three columns, 8 at two), "New" never cut, "Show N more" reveals the rest in one go, a change of column count
 *   re-counts (no half-empty last row). */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(424);
const DEAD = P(425);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-pv-width-token';
let failures = 0;
const ok = (c, m, d) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${d !== undefined ? `  (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); if (!c) { failures += 1; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.SHOTS_DIR || ''; // SHOTS_DIR=<dir> saves the screenshots the design system reviews against the hub
const runTsx = (args, env) => new Promise((resolve) => {
  const pr = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
  let out = ''; let err = '';
  pr.stdout.on('data', (d) => (out += d)); pr.stderr.on('data', (d) => (err += d));
  pr.on('exit', (code) => resolve({ code, out, err }));
});
/* a visualViewport whose height the probe can shrink (the soft keyboard) */
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
await assertFree(PORT, 'room-pv-width.probe.mjs');
await assertFree(DEAD, 'room-pv-width.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-pv-width-'));
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
  const R = (await seed({ rooms: [{ name: 'Wide Room', seats: [{ handle: 'awake', recipe_id: 'rec-a' }] }] })).rooms[0].id;
  browser = await chromium.launch({ headless: true });
  const ASSETS = Array.from({ length: 31 }, (_, i) => ({ name: `shot-${i + 1}.png`, path: `/x/shot-${i + 1}.png`, url: '', raw: `/api/rooms/${R}/assets/raw/shot-${i + 1}.png`, kind: 'image', size: 1000, type: 'image/png', addedAt: Date.now() - (31 - i) * 60000, addedBy: 'awake' }));
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.route(new RegExp(`/api/rooms/${R}/assets$`), async (route) => { await route.fulfill({ json: { folder: '', shareUrl: '', assets: ASSETS } }); });
  await ctx.route(new RegExp(`/api/rooms/${R}/scratchpad/counts$`), async (route) => { await route.fulfill({ json: { assets: { new: 0, total: 31 }, notes: { new: 0, total: 0 } } }); });
  await ctx.route(new RegExp(`/api/rooms/${R}/notes(\\?.*)?$`), async (route) => { await route.fulfill({ json: { notes: [] } }); });
  await ctx.route(/\/assets\/raw\//, async (route) => { await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#2dd4bf"/></svg>' }); });
  const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
  await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);
  const geo = () => pg.evaluate(() => {
    const r = (sel) => { const e = document.querySelector(sel); if (!e) { return null; } const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width) }; };
    const pv = document.getElementById('preview');
    const scrim = document.querySelector('.pv-scrim');
    return { win: innerWidth, drawer: document.getElementById('main').classList.contains('pv-drawer'), open: !pv.hidden, pos: getComputedStyle(pv).position, pv: r('#preview'), rail: r('.rm-roster'), chat: r('#roomLine'), scrim: scrim && !scrim.hidden && getComputedStyle(scrim).display !== 'none' };
  });
  const open = async () => { await pg.click('#padAssets'); await sleep(1200); };
  await pg.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
  await sleep(3500);

  /* ---- 1280: a column at 370, the chat has 638 ---- */
  await open();
  let g = await geo();
  ok(g.open && !g.drawer && g.pos !== 'absolute' && g.pv.w === 370 && g.chat.w >= 480 && g.chat.w === 1280 - 272 - 370, '1280: a COLUMN at 370; the chat keeps 638 (1280 - 272 - 370)', g);
  const cols = () => pg.evaluate(() => { const grid = document.querySelector('#preview .sp-grid'); const tiles = [...document.querySelectorAll('#preview .sp-tile')]; return { cols: getComputedStyle(grid).gridTemplateColumns.split(' ').length, tiles: tiles.length, tileW: Math.round(tiles[0].querySelector('.sp-th').getBoundingClientRect().width), heads: [...document.querySelectorAll('#preview .sp-gh')].map((h) => h.textContent), more: document.querySelector('#preview .sp-more')?.textContent ?? null, square: (() => { const b = tiles[0].querySelector('.sp-th').getBoundingClientRect(); return Math.abs(b.width - b.height) < 1; })() }; });
  if (SHOTS) { await pg.screenshot({ path: join(SHOTS, 'pv-1280-column-3cols.png') }); }
  let c = await cols();
  ok(c.cols === 3 && c.tiles === 12 && c.more === 'Show 19 more' && c.tileW >= 100 && c.tileW <= 112 && c.square, 'a 370 column: THREE columns, 12 tiles (four rows), about 109px, square, "Show 19 more"', c);

  /* ---- a narrower column (320): TWO columns, 8 tiles, 142px, re-counted live, no half row ---- */
  await pg.evaluate(() => document.documentElement.style.setProperty('--pv-pref', '320px'));
  await sleep(500);
  g = await geo();
  c = await cols();
  if (SHOTS) { await pg.screenshot({ path: join(SHOTS, 'pv-1280-column-320-2cols.png') }); }
  ok(g.pv.w === 320 && c.cols === 2 && c.tiles === 8 && c.tileW >= 130 && c.tileW <= 150 && c.tiles % c.cols === 0 && c.more === 'Show 23 more', 'a 320 column: TWO columns, re-counted live to 8 tiles (four rows), about 142px, no half-empty row, "Show 23 more"', { g: g.pv, c });
  await pg.evaluate(() => document.documentElement.style.setProperty('--pv-pref', '370px'));
  await sleep(500);
  c = await cols();
  ok(c.cols === 3 && c.tiles === 12, 'back to 370: three columns, 12 tiles again', c);
  await pg.click('#preview .sp-more');
  await sleep(300);
  c = await cols();
  ok(c.tiles === 31 && c.more === null, '"Show N more" reveals the rest in one go', c);

  /* ---- 1072 = 272 + 480 + 320: still a column; one less: the drawer ---- */
  await pg.setViewportSize({ width: 1072, height: 800 });
  await sleep(700);
  g = await geo();
  ok(g.open && !g.drawer && g.pv.w >= 320 && g.chat.w >= 480, '1072 (rail + 480 + 320): still a column; the preview shrinks toward 320 before the chat gives up anything under 480', g);
  await pg.setViewportSize({ width: 1071, height: 800 });
  await sleep(700);
  g = await geo();
  ok(g.open && g.drawer && g.pos === 'absolute' && g.scrim, '1071: the DRAWER (it is still open, with the scrim)', g);

  /* ---- 1024 and 900: a drawer, anchored right, 370 wide, the rail beside it ---- */
  for (const w of [1024, 900]) {
    await pg.setViewportSize({ width: w, height: 800 });
    await sleep(700);
    g = await geo();
    if (SHOTS) { await pg.screenshot({ path: join(SHOTS, `pv-${w}-drawer.png`) }); }
    ok(g.open && g.drawer && g.pos === 'absolute' && g.pv.w === Math.min(370, w - 56) && g.pv.r === w && g.rail.l === 0 && g.rail.w === 272 && g.pv.l >= g.rail.r && g.scrim, `${w}: a DRAWER anchored right, ${Math.min(370, w - 56)} wide, the rail visible and clear of it, the scrim up`, g);
  }
  /* the rail stays usable beside the drawer: a click on a rail row works with the drawer open */
  const railUsable = await pg.evaluate(() => { const row = document.querySelector('.rm-roster .seat'); const b = row.getBoundingClientRect(); const top = document.elementFromPoint(b.left + 20, b.top + 10); return !!top && (row.contains(top) || top === row); });
  ok(railUsable, '...and a rail row is hit-testable under the open drawer (the scrim does not cover the rail)', railUsable);
  /* resize between column and drawer: not closed, same list, same scroll */
  await pg.setViewportSize({ width: 1280, height: 800 });
  await sleep(600);
  await pg.evaluate(() => { const b = document.querySelector('#preview .pv-b'); b.scrollTop = 140; document.querySelector('#preview .sp').dataset.mark = 'kept'; window.__st = b.scrollTop; });
  await pg.setViewportSize({ width: 960, height: 800 });
  await sleep(700);
  const keep = await pg.evaluate(() => ({ open: !document.getElementById('preview').hidden, drawer: document.getElementById('main').classList.contains('pv-drawer'), mark: document.querySelector('#preview .sp')?.dataset.mark, st: document.querySelector('#preview .pv-b').scrollTop }));
  ok(keep.open && keep.drawer && keep.mark === 'kept' && Math.abs(keep.st - 140) <= 2, 'column to drawer on a resize: not closed, the same list node, the same scroll place', keep);
  await pg.setViewportSize({ width: 1280, height: 800 });
  await sleep(700);
  const back = await pg.evaluate(() => ({ open: !document.getElementById('preview').hidden, drawer: document.getElementById('main').classList.contains('pv-drawer'), mark: document.querySelector('#preview .sp')?.dataset.mark }));
  ok(back.open && !back.drawer && back.mark === 'kept', '...and back to a column on widening: still the same list', back);

  /* ---- closing the drawer: the scrim, Esc, ✕ ---- */
  await pg.setViewportSize({ width: 900, height: 800 });
  await sleep(600);
  await pg.mouse.click(60, 700); // inside the rail? no: the scrim covers the chat part only; click the chat side
  await pg.mouse.click(300, 400);
  await sleep(400);
  ok(await pg.evaluate(() => document.getElementById('preview').hidden), 'a click on the scrim closes the drawer', await geo());
  await open();
  await pg.keyboard.press('Escape');
  await sleep(300);
  ok(await pg.evaluate(() => document.getElementById('preview').hidden), 'Esc closes it');
  await open();
  await pg.click('#preview .pv-x');
  await sleep(300);
  ok(await pg.evaluate(() => document.getElementById('preview').hidden && document.querySelector('.pv-scrim').hidden), '✕ closes it, and the scrim goes with it');

  /* ---- a widened rail tips into the drawer sooner ---- */
  await pg.setViewportSize({ width: 1280, height: 800 });
  await pg.evaluate(() => document.documentElement.style.setProperty('--rail-pref', '440px'));
  await sleep(500);
  await open();
  g = await geo();
  ok(!g.drawer && g.chat.w >= 480 && g.pv.w >= 320 && g.rail.w >= 272, 'a rail widened to 440 in a 1280 window (440 + 480 + 320 = 1240 fits): still a column, the chat keeps its 480', g);
  await pg.evaluate(() => document.documentElement.style.setProperty('--rail-pref', '500px'));
  await sleep(500);
  g = await geo();
  ok(g.drawer, 'a rail widened to 500 (500 + 480 + 320 = 1300 > 1280): the drawer, because the rail\'s REAL width is in the sum', g);
  ok(errs.length === 0, 'no page errors', errs.slice(0, 3));
  await ctx.close();
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
