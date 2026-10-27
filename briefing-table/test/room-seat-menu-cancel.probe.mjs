/* THE PHONE SEAT MENU HAS A WAY OUT  node test/room-seat-menu-cancel.probe.mjs
 * Owner, iPhone: a seat's ⋯ menu (the bottom sheet) had "no way to exit that menu without pushing the back button".
 * At 390x844 (touch, mobile; Chromium AND WebKit when installed), the real room page against a scratch engine:
 *   - the ⋯ on a row of the Agents sheet (#phSheet) and a long press both open the sheet menu
 *   - it ends in a visible Cancel row (>= 44px, after a .rsm-msep, dim text; not an .rsm-mi)
 *   - tapping Cancel closes the menu, and the Agents sheet under it stays up
 *   - tapping the dimmed area above the sheet (several points) closes it
 *   - the panel menu is the same host, so it gets the same row (asserted on the shared host here)
 *   - desktop width: no Cancel row
 * A PROBE, not in `npm test`. OWN scratch engine :7491, DEAD broker :7492, temp table: never Owner's data. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(61); // 7491
const DEAD_BROKER_PORT = P(62); // 7492
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-seat-menu-cancel-token';

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function runTsx(args, env) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('exit', (code) => resolve({ code, out, err }));
  });
}

await assertFree(PORT, 'room-seat-menu-cancel.probe.mjs');
await assertFree(DEAD_BROKER_PORT, 'room-seat-menu-cancel.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-seat-menu-cancel-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null;
const browsers = [];
let engineLog = '';
const seed = async (plan) => {
  const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
  return JSON.parse(r.out.trim().split('\n').pop());
};

try {
  const recipe = (id, name, agent) => ({ id, name, projectDir: `/srv/x/${agent}`, vendor: 'claude-code', agent, color: '#1f5fbf' });
  await seed({ recipes: [recipe('rec-lead', 'Leader', 'leader'), recipe('rec-buddy', 'Buddy', 'buddy')] });
  const live = (paneid, rid, agent) => ({ paneid, recipe_id: rid, vendor: 'claude-code', agent, state: 'live' });
  const post = await seed({
    sessions: [live('recipe:rec-lead', 'rec-lead', 'leader'), live('recipe:rec-buddy', 'rec-buddy', 'buddy')],
    rooms: [{ name: 'Cancel Probe', seats: [
      { handle: 'leader', recipe_id: 'rec-lead', occupant: 'recipe:rec-lead' },
      { handle: 'buddy', recipe_id: 'rec-buddy', occupant: 'recipe:rec-buddy' },
    ] }],
  });
  const R = post.rooms[0].id;
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: dbPath, HARBOR_WB_TOKEN: TOKEN,
      HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'), HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT), HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'), HARBOR_WB_NODE: 'testnode',
    }),
  });
  engine.stdout.on('data', (d) => (engineLog += d));
  engine.stderr.on('data', (d) => (engineLog += d));
  let up = false;
  for (let i = 0; i < 120 && !up; i += 1) {
    await sleep(250);
    try { up = (await fetch(`${BASE}/health`)).ok; } catch { /* not yet */ }
  }
  ok(up, `scratch engine is serving on ${PORT}`, up ? undefined : engineLog.slice(-400));
  if (!up) { throw new Error('engine never came up'); }

  const login = async (ctx) => {
    const pg = await ctx.newPage();
    await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
    await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);
    return pg;
  };
  const menuState = (pg) => pg.evaluate(() => {
    const m = document.querySelector('.rsm-menu');
    if (!m) { return null; }
    const c = m.querySelector('.rsm-cancel');
    const r = c?.getBoundingClientRect();
    const prev = c?.previousElementSibling;
    return {
      sheet: m.classList.contains('is-sheet'), top: Math.round(m.getBoundingClientRect().top), cancel: !!c, h: r ? Math.round(r.height) : 0, label: c?.textContent,
      lastChild: m.lastElementChild === c, sep: !!prev?.classList.contains('rsm-msep'), asItem: !!c?.classList.contains('rsm-mi'),
      color: c ? getComputedStyle(c).color : null, text: getComputedStyle(document.body).color, bottom: r ? Math.round(r.bottom) : 0, vh: innerHeight,
    };
  });
  const sheetUp = (pg) => pg.evaluate(() => !document.getElementById('phSheet').hidden);

  for (const [name, type] of [['chromium', chromium], ['webkit', webkit]]) {
    let br;
    try { br = await type.launch({ headless: true }); } catch (e) { console.log(`  --    ${name} not installed (${String(e).slice(0, 60)})`); continue; }
    browsers.push(br);
    console.log(`\n[${name}] phone 390x844`);
    const state = await (await login(await br.newContext({ viewport: { width: 1440, height: 900 } }))).context().storageState();
    const phone = await br.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: state });
    const pp = await phone.newPage();
    const perr = [];
    pp.on('pageerror', (e) => perr.push(String(e)));
    await pp.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    const more = '#phSheet .seat[data-handle="buddy"] .rsm-more';
    const openMenu = async () => {
      if (!(await sheetUp(pp))) { await pp.tap('#phAgents'); await sleep(500); }
      await pp.tap(more);
      await sleep(300);
    };

    await openMenu();
    let st = await menuState(pp);
    ok(st?.sheet, 'the ⋯ on an Agents-sheet row opens the bottom-sheet menu', st);
    ok(st?.cancel && st.label === 'Cancel' && st.h >= 44 && st.lastChild && st.sep && !st.asItem, 'it ends in a Cancel row (>= 44px) after a separator, not an item', st);
    ok(st && st.bottom <= st.vh && st.color !== st.text, '...inside the screen, in dim text', { bottom: st?.bottom, color: st?.color, text: st?.text });
    await pp.tap('.rsm-cancel');
    await sleep(300);
    ok((await menuState(pp)) === null, 'tapping Cancel closes the menu');
    ok(await sheetUp(pp), '...and the Agents sheet under it stays up');
    ok((await pp.$('.rsm-scrim')) === null, '...scrim gone');

    /* the dimmed area: several points above the sheet */
    for (const [x, y] of [[195, 20], [195, 120], [20, 300], [370, 60]]) {
      await openMenu();
      st = await menuState(pp);
      if (y >= (st?.top ?? 0)) { console.log(`  --    skip (${x},${y}): inside the sheet (top ${st?.top})`); await pp.tap('.rsm-cancel'); continue; }
      await pp.touchscreen.tap(x, y);
      await sleep(400);
      const closed = (await menuState(pp)) === null;
      ok(closed, `a tap on the dimmed area at (${x},${y}) closes the menu`, { agentsSheetStillUp: await sheetUp(pp) });
      if (!closed) { await pp.tap('.rsm-cancel'); }
    }

    /* A LONG MENU (Owner [ref], IMG_7874): ten rows on a short phone screen filled the whole screen, so there was no dimmed
       strip to tap and a bottom Cancel row would have been below the fold. The sheet keeps a strip at the top, scrolls
       inside, and its Cancel stays pinned in view. */
    await pp.setViewportSize({ width: 390, height: 640 });
    await sleep(300);
    await openMenu();
    await pp.evaluate(() => {
      const m = document.querySelector('.rsm-menu.is-sheet');
      const item = m.querySelector('.rsm-mi');
      const anchor = m.querySelector('.rsm-msep:last-of-type') || m.querySelector('.rsm-cancel');
      for (let i = 0; i < 9; i += 1) {
        m.insertBefore(item.cloneNode(true), m.querySelector('.rsm-cancel').previousElementSibling || anchor);
      }
    });
    await sleep(200);
    const longSt = await pp.evaluate(() => {
      const m = document.querySelector('.rsm-menu.is-sheet');
      const r = m.getBoundingClientRect();
      const c = m.querySelector('.rsm-cancel').getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight, scrolls: m.scrollHeight > m.clientHeight, cTop: Math.round(c.top), cBottom: Math.round(c.bottom) };
    });
    ok(longSt.top >= 80, 'a long menu leaves a dimmed strip above it (>= 80px)', longSt);
    ok(longSt.scrolls, '...and scrolls inside itself', longSt);
    ok(longSt.cTop >= longSt.top && longSt.cBottom <= longSt.vh, '...with Cancel pinned in view without scrolling', longSt);
    await pp.tap('.rsm-cancel');
    await sleep(300);
    ok((await menuState(pp)) === null, '...and tapping that Cancel closes it');
    await pp.setViewportSize({ width: 390, height: 844 });
    await sleep(300);

    /* long press on a row opens it too, and Cancel closes it */
    await pp.evaluate(() => {
      const li = document.querySelector('#phSheet .seat[data-handle="buddy"] .seat-meta');
      const r = li.getBoundingClientRect();
      li.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: r.x + 10, clientY: r.y + 4, isPrimary: true }));
    });
    await sleep(700);
    st = await menuState(pp);
    ok(st?.sheet && st.cancel, 'a long press opens the sheet menu with its Cancel row', st);
    await pp.tap('.rsm-cancel');
    await sleep(300);
    ok((await menuState(pp)) === null, '...and Cancel closes it');
    ok(perr.length === 0, 'no page errors (phone)', perr.slice(0, 3));
    await phone.close();

    const desk = await br.newContext({ viewport: { width: 1440, height: 900 }, storageState: state });
    const dp = await desk.newPage();
    await dp.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
    await dp.waitForSelector('#roster .seat[data-handle="buddy"]');
    await sleep(800);
    await dp.click('#roster .seat[data-handle="buddy"] .seat-handle', { button: 'right' });
    st = await menuState(dp);
    ok(st && !st.sheet && !st.cancel, 'desktop: the menu opens with no Cancel row', st);
    await desk.close();
  }
} catch (e) {
  ok(false, `probe threw: ${e?.stack ?? e}`);
} finally {
  for (const b of browsers) { await b.close().catch(() => {}); }
  engine?.kill('SIGKILL');
  await sleep(300);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
