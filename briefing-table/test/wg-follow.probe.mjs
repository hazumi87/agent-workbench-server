/* FOLLOW THE ROOM [wg follow]  node test/wg-follow.probe.mjs   Owner 2026-10-07 (room interface/5569)
 * The real room page against a scratch engine (dead broker, temp table, never a live pane), a main room and a WORKGROUP of it:
 *   a "Follow the room" switch tops the workgroup's Art & color settings (never a main room's). ON (the default): the workgroup's own
 *   art, line wash, glass and palette controls and the per-field "From the main room" rows are hidden, a line says it uses the main
 *   room's art and palette in the workgroup's color, and Room color stays editable. OFF: today's controls. The switch PATCHes
 *   design_follow and the page follows the engine's answer; on a phone the row keeps a 44px target. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(416);
const DEAD = P(417);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-wg-follow-token';
let failures = 0;
const ok = (c, m, d) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${d !== undefined ? `  (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); if (!c) { failures += 1; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
await assertFree(PORT, 'wg-follow.probe.mjs');
await assertFree(DEAD, 'wg-follow.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-wg-follow-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null; let browser = null; let log = '';
try {
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
    return JSON.parse(r.out.trim().split('\n').pop());
  };
  await seed({ recipes: [{ id: 'rec-a', name: 'Awake', projectDir: '/srv/x/awake', vendor: 'claude-code', agent: 'awake', color: '#0dab49' }, { id: 'rec-b', name: 'Beta', projectDir: '/srv/x/beta', vendor: 'claude-code', agent: 'beta', color: '#1f5fbf' }] });
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
  const cookie = await windowCookie(BASE, TOKEN);
  const call = async (path, method, json) => {
    const res = await fetch(BASE + path, { method, headers: { cookie, 'content-type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json) });
    let b = null;
    try { b = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: b };
  };
  const seeded = (await seed({ rooms: [{ name: 'Main', seats: [{ handle: 'awake', recipe_id: 'rec-a' }, { handle: 'beta', recipe_id: 'rec-b' }] }] })).rooms[0];
  const main = seeded.id;
  const seat0 = Array.isArray(seeded.seats) ? (seeded.seats[1]?.id ?? seeded.seats[1]) : Object.values(seeded.seats ?? {})[1];
  const set = await call(`/api/rooms/${main}/settings`, 'PATCH', { art_tile: { id: 'geometric-iso-cubes-quiet-tint', blend: 'color', level: 50, strength: 50, zoom: 100 } });
  ok(set.status === 200, 'the main room has an art tile', set.status);
  const wgr = await call(`/api/rooms/${main}/workgroups`, 'POST', { name: 'Sub', move: [seat0], lead: { move: seat0 } });
  const WG = wgr.body?.room?.id ?? wgr.body?.workgroup?.id ?? wgr.body?.id;
  ok(wgr.status < 300 && !!WG, 'a workgroup of it exists', { status: wgr.status, err: wgr.body?.error, seat0 });
  const view = async (id) => (await call(`/api/rooms/${id}`, 'GET')).body;
  /* the workgroup's OWN tile, saved while it follows: kept, unused */
  const own = await call(`/api/rooms/${WG}/settings`, 'PATCH', { art_tile: { id: 'moods-calm-clouds-quiet-tint', blend: 'color', level: 90, strength: 50, zoom: 100 } });
  ok(own.status === 200, 'the workgroup saves a tile of its own (level 90) while following', own.status);
  const v0 = await view(WG);
  ok(v0?.room?.design_follow === true && v0.room.art_tile?.id === 'geometric-iso-cubes-quiet-tint', 'the engine: a new workgroup follows, wearing the main room\'s tile', { follow: v0?.room?.design_follow, tile: v0?.room?.art_tile?.id });
  browser = await chromium.launch({ headless: true });

  const open = async (w, h, touch) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch });
    const pg = await ctx.newPage();
    const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
    await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
    await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);
    return { ctx, pg, errs };
  };
  const shown = (pg, sel) => pg.evaluate((q) => { const n = document.querySelector(q); return !!n && n.offsetParent !== null; }, sel);
  const heads = (pg) => pg.evaluate(() => [...document.querySelectorAll('.pv-set h4')].filter((h) => h.offsetParent !== null).map((h) => h.textContent));

  /* ---- PC: the workgroup's settings ---- */
  {
    const { ctx, pg, errs } = await open(1400, 900, false);
    await pg.goto(`${BASE}/room.html?room=${WG}&settings=1`, { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    const sw = await pg.evaluate(() => { const s = document.getElementById('designFollow'); return s ? { on: s.getAttribute('aria-checked'), note: document.getElementById('designFollowNote').textContent, order: [...document.querySelectorAll('.pv-set > .pv-grp')].findIndex((g) => g.contains(s)) } : null; });
    ok(sw && sw.on === 'true' && /^Uses Main\u2019s art and palette, in this workgroup\u2019s color\.$/.test(sw.note), 'workgroup: "Follow the room" is on, and says it uses Main\u2019s art and palette in this workgroup\u2019s color', sw);
    const h1 = await heads(pg);
    ok(h1.includes('Follow the room') && h1.includes('Room color') && !h1.includes('Art') && !h1.includes('Palette') && !h1.includes('From the main room'), 'ON: Art, Palette and "From the main room" are hidden; Room color stays', h1);
    const lvl = () => pg.evaluate(() => document.querySelector('#roomLine > .rc-tile')?.style.opacity ?? null);
    ok(await lvl() === '0.5', 'ON: the line wears the MAIN room\'s tile (level 50), not the workgroup\'s own', await lvl());
    /* turn it off */
    await pg.click('#designFollow');
    await sleep(1500);
    ok(await lvl() === '0.9', 'OFF: the line repaints at once with the workgroup\'s own tile (level 90)', await lvl());
    const off = await pg.evaluate(() => ({ on: document.getElementById('designFollow').getAttribute('aria-checked'), note: document.getElementById('designFollowNote').textContent, msg: document.querySelector('.pv-follow .pv-msg').textContent }));
    const h2 = await heads(pg);
    ok(off.on === 'false' && /own art and palette/.test(off.note) && h2.includes('Art') && h2.includes('Palette') && h2.includes('From the main room') && h2.includes('Room color'), 'OFF: today\'s controls are back (Art, Palette, From the main room, Room color)', { off, h2 });
    const v1 = await view(WG);
    ok(v1?.room?.design_follow === false, 'the engine has design_follow = false', v1?.room?.design_follow);
    /* and back on */
    await pg.click('#designFollow');
    await sleep(1500);
    ok(await lvl() === '0.5', 'ON again: back to the main room\'s tile at once', await lvl());
    const h3 = await heads(pg);
    ok((await pg.evaluate(() => document.getElementById('designFollow').getAttribute('aria-checked'))) === 'true' && !h3.includes('Art') && !h3.includes('Palette'), 'ON again: the design controls are hidden again', h3);
    ok((await view(WG))?.room?.design_follow === true, '...and the engine follows again');
    ok(errs.length === 0, 'no page errors (workgroup)', errs.slice(0, 3));
    await ctx.close();
  }

  /* ---- the rail's workgroup rows line up with or without an unread count [rail align] (the design system: .seat.has-more:has(> .seat-side) gave a
          row with a count a 28px glyph column, 8px right of its siblings) ---- */
  {
    const { ctx, pg } = await open(1400, 900, false);
    await pg.goto(`${BASE}/room.html?room=${main}`, { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    const cols = await pg.evaluate(() => {
      const ol = document.getElementById('roomList');
      const mkRow = (side) => {
        const li = document.createElement('li');
        li.className = 'seat is-sub has-more';
        li.innerHTML = '<span class="seat-glyph"></span><div class="seat-top"><span class="seat-handle">Sub</span></div>' + (side ? '<div class="seat-side"><span class="seat-count">3</span></div>' : '') + '<button class="rr-more cell-hmore">⋯</button>';
        ol.append(li);
        const cs = getComputedStyle(li);
        const out = { cols: cs.gridTemplateColumns, glyphLeft: Math.round(li.querySelector('.seat-glyph').getBoundingClientRect().left - li.getBoundingClientRect().left) };
        li.remove();
        return out;
      };
      return { without: mkRow(false), withCount: mkRow(true) };
    });
    const first = (c) => c.split(' ')[0];
    ok(first(cols.without.cols) === '20px' && first(cols.withCount.cols) === '20px' && cols.without.glyphLeft === cols.withCount.glyphLeft, 'a workgroup row with an unread count keeps its 20px glyph column: its glyph sits where its siblings\' do', cols);
    await ctx.close();
  }

  /* ---- a main room has no switch ---- */
  {
    const { ctx, pg } = await open(1400, 900, false);
    await pg.goto(`${BASE}/room.html?room=${main}&settings=1`, { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    const h = await heads(pg);
    ok(!(await shown(pg, '#designFollow')) && h.includes('Art') && h.includes('Palette') && !h.includes('Follow the room'), 'a MAIN room has no "Follow the room" switch, and keeps its Art and Palette', h);
    await ctx.close();
  }

  /* ---- phone: the row keeps a thumb-sized target ---- */
  {
    const { ctx, pg } = await open(390, 780, true);
    await pg.goto(`${BASE}/room.html?room=${WG}&settings=1`, { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    const t = await pg.evaluate(() => { const s = document.getElementById('designFollow'); const r = s.getBoundingClientRect(); const row = s.closest('.pv-vhd').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), rowH: Math.round(row.height), vis: r.width > 0, sideways: document.documentElement.scrollWidth > innerWidth }; });
    ok(t.vis && t.rowH >= 44 && !t.sideways, 'phone: the switch row is at least 44px tall, nothing sideways', t);
    await ctx.close();
  }
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
