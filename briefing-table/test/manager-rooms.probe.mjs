/* THE MANAGER'S ROOMS: rooms as groups of their agents, Live Tabs, and hide /
 * unhide (the design system cli-manager-rooms-v1, Owner's round 2026-09-28).
 *
 *   node test/manager-rooms.probe.mjs
 *
 * GET/PATCH /api/rooms/me (the per-person hidden set) is the lead's engine
 * route; until it is live it is answered here, in memory, in the engine's
 * announced shape {hiddenRooms:[ids]}, and a second context proves that with
 * NO route the page offers no Hide at all.
 *
 * Also: a Live sessions row still blocked after its alarm was seen shows the quiet
 * "needs you: <reason>" chip [ticket] (`blocked` injected into /api/table).
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(32), DEAD broker P(33).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv, windowCookie, roomUserWrite } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(32);
const DEAD_BROKER_PORT = P(33);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-mgr-rooms-token';

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookieP = null;
const userCookie = () => (cookieP ??= windowCookie(BASE, TOKEN));

async function call(path, opts = {}) {
  const method = opts.method ?? (opts.json !== undefined ? 'POST' : 'GET');
  /* a room write as the USER takes a person's credential: the window cookie,
     no bearer (rooms.ts authorFor, [ticket]); everything else is the agent */
  const headers = roomUserWrite(path, method, opts.json) ? { cookie: await userCookie() } : { authorization: `Bearer ${TOKEN}` };
  const init = { method, headers };
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.json);
  }
  const res = await fetch(BASE + path, init);
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
}

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

try {
  const stale = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
  if (stale.ok) {
    console.log(` FAIL  :${PORT} is already serving something — a leaked engine from an aborted run?`);
    process.exit(1);
  }
} catch { /* nothing there */ }
for (const p of [PORT, DEAD_BROKER_PORT]) {
  await assertFree(p, 'manager-rooms.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-mgr-rooms-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null;
let browser = null;
let engineLog = '';
const seed = async (plan) => {
  const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], {
    HARBOR_WB_TABLE: dbPath,
    HARBOR_WB_IDENTITY: 'legacy',
  });
  if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
  return JSON.parse(r.out.trim().split('\n').pop());
};

try {
  const recipe = (id, name, agent) => ({ id, name, projectDir: `/srv/x/${agent}`, vendor: 'claude-code', agent });
  const DEH = 'recipe:rec-deh';
  await seed({
    recipes: [{ ...recipe('rec-a', 'Alpha Project', 'alpha'), color: '#ba08b4' }, recipe('rec-b', 'Bravo Project', 'bravo'), recipe('rec-c', 'Charlie Project', 'charlie')],
  });

  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT),
      HARBOR_WB_HOST: '127.0.0.1',
      HARBOR_WB_TABLE: dbPath,
      HARBOR_WB_TOKEN: TOKEN,
      HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'),
      HARBOR_WB_IDENTITY: 'legacy',
      HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_NATS_URL: '',
      HARBOR_WB_FABRIC_URL: '',
      HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT),
      HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
      HARBOR_WB_NODE: 'testnode',
    }),
  });
  engine.stdout.on('data', (d) => (engineLog += d));
  engine.stderr.on('data', (d) => (engineLog += d));
  let up = false;
  for (let i = 0; i < 120; i += 1) {
    await sleep(250);
    try { if ((await fetch(`${BASE}/health`)).ok) { up = true; break; } } catch { /* not yet */ }
  }
  ok(up, `scratch engine is serving on ${PORT}`, up ? undefined : engineLog.slice(-400));
  if (!up) { throw new Error('engine never came up'); }

  const LIVE = 'recipe:rec-live';
  const post = await seed({
    sessions: [
      { paneid: 'recipe:rec-a', recipe_id: 'rec-a', vendor: 'claude-code', agent: 'alpha', state: 'live' },
      { paneid: 'recipe:rec-b', recipe_id: 'rec-b', vendor: 'claude-code', agent: 'bravo', state: 'live' },
    ],
    rooms: [
      { name: 'Alpha Room', seats: [{ handle: 'alpha', recipe_id: 'rec-a', occupant: 'recipe:rec-a' }, { handle: 'charlie', recipe_id: 'rec-c' }] },
      { name: 'Beta Room', seats: [] },
    ],
  });
  const R = post.rooms[0].id;
  const RB = post.rooms[1].id;
  const SEAT = post.rooms[0].seats;

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  let hidden = [];
  const patches = [];
  const me = async (route) => {
    const q = route.request();
    if (q.method() === 'PATCH') {
      const b = q.postDataJSON();
      patches.push({ body: b, auth: q.headers().authorization ?? null });
      hidden = b.hiddenRooms;
    }
    await route.fulfill({ json: { hiddenRooms: hidden } });
  };
  await context.route(/\/api\/rooms\/me$/, me);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    const f = document.querySelector('form');
    (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
  }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  await page.goto(`${BASE}/manager.html`, { waitUntil: 'domcontentloaded' });
  await sleep(3500);
  const state = () => page.evaluate(() => ({
    liveHead: document.querySelector('#liveWrap .mgr-col-head')?.textContent,
    live: [...document.querySelectorAll('#liveList .live-row .live-name')].map((e) => e.textContent),
    rooms: [...document.querySelectorAll('#roomList .rcard')].map((r) => ({
      id: r.dataset.room, name: r.querySelector('.rc-nm').childNodes[0].textContent, meta: r.querySelector('.rc-sub').textContent,
      hid: r.classList.contains('is-hidden'),
      hidTag: getComputedStyle(r.querySelector('.rr-hid')).display !== 'none',
      op: getComputedStyle(r).opacity,
      seats: [...r.querySelectorAll('.rc-seat')].map((k) => k.title),
      open: r.querySelector('[data-act="open-room"]')?.textContent,
    })),
    toggle: (() => { const t = document.getElementById('roomsShowHidden'); return { shown: !t.hidden, text: t.textContent, pressed: t.getAttribute('aria-pressed') }; })(),
    menu: [...document.querySelectorAll('.rr-menu .rr-mi')].map((b) => b.textContent),
    note: document.querySelector('.rr-menu .rr-mnote')?.textContent ?? null,
  }));
  let s = await state();
  ok(s.liveHead === 'Live sessions', 'the live list is "Live sessions"', s.liveHead);
  ok(s.live.includes('Bravo Project') && !s.live.includes('Alpha Project'), 'Live sessions: only sessions NOT seated in a room (Owner 2026-10-07; the seated one is on its room card)', s.live);
  const chips = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#liveList .live-row')].map((r) => [r.querySelector('.live-name').textContent, r.querySelector('.live-roomchip')?.textContent])));
  ok(chips['Alpha Project'] === undefined && chips['Bravo Project'] === 'not in a room', 'an unseated live row says "not in a room"', chips);
  const alpha = s.rooms.find((r) => r.name === 'Alpha Room');
  ok(alpha && alpha.meta === '2 seats · lead @alpha' && s.rooms.find((r) => r.name === 'Beta Room')?.meta === '0 seats · no lead', 'a room row: "N seats · lead @x"', s.rooms.map((r) => r.meta));
  const rowSel = `.rcard[data-room="${R}"]`;
  ok(alpha.seats.length === 2 && /^@alpha/.test(alpha.seats[0]) && /^@charlie.*not started/.test(alpha.seats[1]), 'the seats are a row of rings: lead first, a never-started seat says so', alpha.seats);
  ok(alpha.open === 'Open room', 'the card says "Open room" (never Restore: opening a room does not wake its agents)', alpha.open);
  const lay = await page.evaluate(() => { const l = document.getElementById('roomList'); return { grid: getComputedStyle(l).display, chev: document.querySelectorAll('.rr-dis, .rr-kids').length, wash: getComputedStyle(document.querySelector('.rc-hd')).backgroundImage.includes('gradient') }; });
  ok(lay.grid === 'grid' && lay.chev === 0 && lay.wash, 'rooms are cards in a grid with a wash header; no expand chevrons', lay);

  /* the menu: right click */
  await page.click(rowSel, { button: 'right', position: { x: 200, y: 20 } });
  await sleep(200);
  s = await state();
  ok(s.menu.join('|') === 'Open|Room settings|Hide from my list' && /Only your list/.test(s.note ?? ''), 'right-click: Open · Room settings · Hide from my list, with the note', { menu: s.menu, note: s.note });
  await page.keyboard.press('ArrowDown');
  const foc = await page.evaluate(() => document.activeElement?.textContent);
  ok(foc === 'Room settings', '...arrows move through it', foc);
  await page.keyboard.press('Escape');
  await sleep(150);
  ok((await state()).menu.length === 0 && await page.evaluate((sel) => document.activeElement === document.querySelector(sel), rowSel), '...Esc closes it and the focus goes back to the card');
  /* keyboard: Shift+F10 */
  await page.focus(rowSel);
  await page.keyboard.press('Shift+F10');
  await sleep(150);
  ok((await state()).menu.length === 3, 'Shift+F10 opens it from the keyboard');
  await page.keyboard.press('Escape');

  /* "Room settings" in the menu opens the room with its settings panel up; the flag is spent at once */
  {
    const popupP = context.waitForEvent('page', { timeout: 4000 }).catch(() => null);
    await page.click(`${rowSel} .rr-more`);
    await sleep(150);
    await page.click('.rr-menu .rr-mi:has-text("Room settings")');
    const pop = await popupP;
    ok(pop && /\/room\.html\?room=.*&settings=1/.test(pop.url()), 'Room settings opens the room page with settings=1', pop?.url());
    if (pop) {
      await pop.waitForLoadState('domcontentloaded');
      await sleep(3500);
      const rs = await pop.evaluate(() => ({ url: location.search, panel: !document.getElementById('preview').hidden && /Room settings/.test(document.querySelector('#preview .pv-name')?.textContent ?? '') }));
      ok(!/settings=/.test(rs.url) && rs.panel, '...the panel is open and the flag is cleaned from the address', rs);
      await pop.close();
    }
  }

  /* hide → gone, toast, toggle; show hidden → dimmed in place; Unhide */
  await page.click(`${rowSel} .rr-more`);
  await sleep(150);
  await page.click('.rr-menu .rr-mi:has-text("Hide from my list")');
  await sleep(500);
  s = await state();
  const toast = await page.evaluate(() => document.querySelector('.rr-toast')?.textContent);
  ok(!s.rooms.some((r) => r.id === R) && patches.at(-1)?.body.hiddenRooms.join() === R && patches.at(-1)?.auth === null, 'Hide: the room leaves the list at once; PATCH /api/rooms/me {hiddenRooms} with the cookie', { rooms: s.rooms.map((r) => r.name), patch: patches.at(-1) });
  ok(/Hidden “Alpha Room”/.test(toast ?? '') && /Undo/.test(toast ?? ''), '...a toast with Undo', toast);
  ok(s.toggle.shown && s.toggle.text === '1 hidden · View' && s.toggle.pressed === 'false', '"1 hidden · View" appears in the Rooms header', s.toggle);
  ok(s.live.includes('Bravo Project') && !s.live.includes('Alpha Project'), '...hiding a room does not move its seated session into Live sessions', s.live);
  await page.click('#roomsShowHidden');
  await sleep(300);
  s = await state();
  const hid = s.rooms.find((r) => r.id === R);
  ok(s.toggle.pressed === 'true' && hid?.hid && hid.hidTag && Number(hid.op) < 0.6, 'Show hidden: the room is back in place, dimmed, tagged "hidden"', { toggle: s.toggle, hid });
  ok(s.toggle.text === 'showing 1 hidden · Hide them', '...and the bar reads "showing 1 hidden · Hide them"', s.toggle.text);
  const lifted = await page.evaluate(() => { const cs = getComputedStyle(document.getElementById('roomsShowHidden')); return { bg: cs.backgroundColor, edge: cs.borderTopColor }; });
  ok(lifted.bg !== 'rgba(0, 0, 0, 0)', '...the toggle\'s on state is lifted', lifted);
  await page.click(`${rowSel} .rr-more`);
  await sleep(150);
  s = await state();
  ok(s.menu.includes('Unhide') && s.menu.includes('Room settings'), '...its menu says Unhide', s.menu);
  await page.keyboard.press('Escape');
  await sleep(150);
  const unh = await page.evaluate((sel) => { const b = document.querySelector(`${sel} .rr-unhide`); return b ? { text: b.textContent, h: b.getBoundingClientRect().height } : null; }, rowSel);
  ok(unh?.text === 'Unhide', 'a dimmed room carries its own Unhide button', unh);
  ok(!(await page.evaluate(() => document.querySelector('.rcard:not(.is-hidden) .rr-unhide'))), '...and a room that is not hidden does not', null);
  await page.click(`${rowSel} .rr-unhide`);
  await sleep(500);
  s = await state();
  ok(patches.at(-1)?.body.hiddenRooms.length === 0 && !s.toggle.shown && !s.rooms.find((r) => r.id === R)?.hid, 'Unhide: PATCH clears it; the toggle goes (N = 0)', { patch: patches.at(-1), toggle: s.toggle });
  /* Undo */
  await page.click(`.rcard[data-room="${RB}"] .rr-more`);
  await sleep(150);
  await page.click('.rr-menu .rr-mi:has-text("Hide from my list")');
  await sleep(400);
  await page.click('.rr-toast button');
  await sleep(500);
  s = await state();
  ok(s.rooms.some((r) => r.id === RB) && patches.at(-1)?.body.hiddenRooms.length === 0, 'Undo puts it back', { patch: patches.at(-1) });
  ok(errors.length === 0, 'no page errors', errors.slice(0, 3));

  /* /api/rooms/me WITHOUT hiddenRooms (the picture-only shape): no Hide at all */
  const bare = await browser.newContext({ viewport: { width: 1500, height: 1000 }, storageState: await context.storageState() });
  /* the route as it was before hiddenRooms (picture only): the engine now
     carries hiddenRooms, so the old shape is answered here */
  await bare.route(/\/api\/rooms\/me$/, (route) => route.fulfill({ json: { name: 'user', picture: null } }));
  const pb = await bare.newPage();
  await pb.goto(`${BASE}/manager.html`, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  await pb.click(`${rowSel} .rr-more`);
  await sleep(200);
  const bm = await pb.evaluate(() => ({ menu: [...document.querySelectorAll('.rr-menu .rr-mi')].map((b) => b.textContent), toggle: !document.getElementById('roomsShowHidden').hidden }));
  ok(bm.menu.join('|') === 'Open|Room settings' && !bm.toggle, '/api/rooms/me without hiddenRooms (today\'s picture-only route): no Hide, no toggle', bm);
  await bare.close();

  /* NEEDS YOU survives the ack [ticket]: a Live sessions row whose pane is still
     blocked after its alarm was seen (activity `waiting-seen` since
     window-chrome v33, `blocked` kept) carries a quiet "needs you: <reason>"
     chip, and its ring is the STILL coral double ring (`attention-seen`).
     `blocked` is the engine's in-memory prompt-block answer, so it is
     injected into /api/table here. */
  {
    const nctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, storageState: await context.storageState() });
    await nctx.route(/\/api\/rooms\/me$/, me);
    await nctx.route(/\/api\/table$/, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      for (const r of body.sessions || []) {
        if (r.paneid === 'recipe:rec-b') {
          r.activity = 'waiting-seen';
          r.blocked = { reason: 'question', since: Date.now() };
        }
      }
      await route.fulfill({ response: res, json: body });
    });
    const np = await nctx.newPage();
    const nerr = [];
    np.on('pageerror', (e) => nerr.push(String(e)));
    await np.goto(`${BASE}/manager.html`, { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    const nv = await np.evaluate(() => [...document.querySelectorAll('#liveList .live-row')].map((row) => {
      const chip = row.querySelector('.live-needs');
      const cs = chip ? getComputedStyle(chip) : null;
      const ring = row.querySelector('.ring');
      const halo = ring?.querySelector('.rg-halo');
      const track = ring?.querySelector('.rg-track');
      return {
        ring: ring ? { state: ring.dataset.state, label: ring.title, halo: getComputedStyle(halo).animationName, haloOpacity: Number(getComputedStyle(halo).opacity), track: getComputedStyle(track).animationName } : null,
        name: row.querySelector('.live-name')?.textContent,
        chip: chip?.textContent ?? null,
        needy: row.classList.contains('is-needy'),
        anim: cs?.animationName ?? null,
        bg: cs?.backgroundColor ?? null,
        tip: row.title,
      };
    }));
    const bravo = nv.find((r) => r.name === 'Bravo Project');
    ok(bravo && bravo.chip === 'needs you: question', 'a blocked, acknowledged live row shows "needs you: question"', bravo);
    ok(bravo?.needy === true, 'a waiting session\'s row wears the needs-you tint class', bravo?.needy);
    ok(bravo && (bravo.anim === 'none' || !bravo.anim) && /rgba\(0, 0, 0, 0\)|transparent/.test(bravo.bg || ''), '...quiet: no motion, no fill', bravo && { anim: bravo.anim, bg: bravo.bg });
    ok(bravo && /Needs:\s+question/.test(bravo.tip), '...and the tooltip names it', bravo?.tip);
    ok(bravo?.ring?.state === 'attention-seen', 'its ring: attention-seen (hwbRingFromChrome(\'waiting-seen\'), v33)', bravo?.ring);
    ok(bravo?.ring && bravo.ring.halo === 'none' && bravo.ring.track === 'none' && bravo.ring.haloOpacity > 0, '...still: a drawn halo, nothing animating', bravo?.ring);
    ok(/needs you, seen/.test(bravo?.ring?.label ?? ''), '...labelled "needs you, seen"', bravo?.ring?.label);
    const plain = await page.evaluate(() => document.querySelectorAll('#liveList .live-needs').length);
    ok(plain === 0, 'an unblocked row has no needs-you chip', plain);
    ok(nerr.length === 0, 'no page errors (needs-you)', nerr.slice(0, 3));
    await np.screenshot({ path: join(tmpdir(), 'manager-needs-you.png'), clip: { x: 0, y: 0, width: 900, height: 700 } });
    await nctx.close();
  }

  /* "+ NEW ROOM" ends the grid; its sheet has the two paths on top [workbench home] */
  {
    const nc = await page.evaluate(() => { const l = document.getElementById('roomList'); const c = document.getElementById('roomNewCard'); return { last: l.lastElementChild === c, dashed: getComputedStyle(c).borderTopStyle, text: c.textContent, sheet: document.getElementById('roomNewSheet').hidden }; });
    ok(nc.last && nc.dashed === 'dashed' && /New room/.test(nc.text) && nc.sheet, 'a dashed "+ New room" card ends the rooms grid; the sheet is closed', nc);
    await page.click('#roomNewCard');
    await sleep(150);
    const sh = await page.evaluate(() => ({ open: !document.getElementById('roomNewSheet').hidden, paths: [...document.querySelectorAll('.rn-path')].map((b) => b.textContent), on: document.querySelector('.rn-path.is-on')?.textContent, focus: document.activeElement?.id, form: !!document.querySelector('#roomNewSheet #roomNewForm') }));
    ok(sh.open && sh.paths.join('|') === 'New room|Assemble from agents…' && sh.on === 'New room' && sh.focus === 'roomNewName' && sh.form, 'the sheet opens with "New room | Assemble from agents…" on top and the name field focused', sh);
    await page.keyboard.press('Escape');
    await sleep(100);
    ok(await page.evaluate(() => document.getElementById('roomNewSheet').hidden && document.activeElement?.id === 'roomNewCard'), '...Esc closes it and the focus returns to the card');
    await page.click('#roomNewCard');
    await page.click('#roomNewScrim', { position: { x: 5, y: 5 } });
    await sleep(100);
    ok(await page.evaluate(() => document.getElementById('roomNewSheet').hidden), '...a click on the scrim closes it');
    await page.fill('#mgrFind', 'zzzz');
    await sleep(150);
    ok(await page.evaluate(() => document.getElementById('roomNewCard').offsetParent !== null), 'find never hides the "+ New room" card');
    await page.fill('#mgrFind', '');
    await sleep(100);
  }

  /* "+ NEW AGENT SESSION" ends the live list and opens a picker of the recipes [workbench home] */
  {
    const nsc = await page.evaluate(() => { const l = document.getElementById('liveList'); const c = document.getElementById('newSessionCard'); return { wrap: !document.getElementById('liveWrap').hidden, last: l.lastElementChild === c, dashed: getComputedStyle(c).borderTopStyle, text: c.textContent, picker: document.getElementById('sessionPicker').hidden, header: !!document.getElementById('newBtn') && document.getElementById('newBtn').offsetParent === null }; });
    ok(nsc.wrap && nsc.last && nsc.dashed === 'dashed' && /New agent session/.test(nsc.text) && nsc.picker, 'a dashed "+ New agent session" card ends the live list (the list shows even with nothing live)', nsc);
    const launches = [];
    await page.route(/\/api\/recipes\/[^/]+\/launch$/, async (route) => { launches.push({ url: route.request().url(), body: route.request().postData() }); await route.fulfill({ status: 200, json: { ok: true } }); });
    await page.click('#newSessionCard');
    await sleep(150);
    const sp = await page.evaluate(() => ({ open: !document.getElementById('sessionPicker').hidden, heads: [...document.querySelectorAll('#sessionPickerBody .sp-h')].map((h) => h.textContent), picks: [...document.querySelectorAll('#sessionPickerBody .sp-pick b')].map((b) => b.textContent), all: !!document.querySelector('#sessionPickerBody .sp-all'), focus: document.activeElement?.className }));
    ok(sp.open && sp.heads[0] === 'Agents' && sp.picks.length >= 3 && sp.all && /sp-pick/.test(sp.focus), 'the picker lists the agent recipes (then shells), "All recipes ›", and focuses the first', sp);
    await page.keyboard.press('Escape');
    await sleep(100);
    ok(await page.evaluate(() => document.getElementById('sessionPicker').hidden && document.activeElement?.id === 'newSessionCard'), '...Esc closes it and the focus returns to the card');
    await page.click('#newSessionCard');
    await sleep(100);
    await page.click('#sessionPickerBody .sp-pick');
    await sleep(300);
    ok(launches.length === 1 && /\/api\/recipes\/[^/]+\/launch$/.test(launches[0].url) && await page.evaluate(() => document.getElementById('sessionPicker').hidden), 'choosing a recipe starts a session from it and closes the picker', launches);
    await page.unroute(/\/api\/recipes\/[^/]+\/launch$/);
    await page.click('#newSessionCard');
    await page.click('#sessionPickerBody .sp-all');
    await sleep(200);
    ok(await page.evaluate(() => document.body.dataset.screen === 'recipes' && document.getElementById('sessionPicker').hidden), '"All recipes ›" goes to the Recipes screen');
    await page.click('#wbBackBtn');
    await sleep(150);
  }

  /* SCREENS [workbench home]: home | Recipes | History, each (but home) with "‹ Workbench" */
  {
    const vis = (sel) => page.evaluate((q) => { const n = document.querySelector(q); return !!n && n.offsetParent !== null; }, sel);
    ok(await vis('#roomsWrap') && !(await vis('#agentList')) && !(await vis('#recent')) && !(await vis('#wbBar')), 'home: rooms and live show; recipes, history and the back bar do not');
    const dp = await page.evaluate(() => { const e = new MouseEvent('click', { bubbles: true, cancelable: true }); document.querySelector('.mgr-col-head').dispatchEvent(e); return e.defaultPrevented; });
    ok(dp === false, 'a click elsewhere on the page is NOT swallowed by the screen switch (body carries data-screen: a form still submits, a link still follows)', dp);
    await page.click('#mgrMore');
    await sleep(120);
    const mg = await page.evaluate(() => [...document.querySelectorAll('#mgrMoreMenu .mgr-mi')].filter((a) => !a.hidden).map((a) => a.textContent));
    ok(/^Recipes\d+\|History\d*\|Art\|Account\|Showcase\|Global settings$/.test(mg.join('|')), 'the ⋯ menu leads with Screens: Recipes and History, with counts, then Art · Account · Showcase · Global settings', mg);
    await page.click('#mgrScreenRecipes');
    await sleep(200);
    const rc = await page.evaluate(() => ({ screen: document.body.dataset.screen, hash: location.hash, title: document.getElementById('wbBarTitle').textContent, back: Math.round(document.getElementById('wbBackBtn').getBoundingClientRect().height), backText: document.getElementById('wbBackBtn').textContent, rooms: document.getElementById('roomsWrap').offsetParent !== null, other: document.getElementById('otherList').offsetParent !== null, agents: document.querySelectorAll('#agentList .sess').length, doc: document.title }));
    ok(rc.screen === 'recipes' && rc.hash === '#recipes' && rc.title === 'Recipes' && rc.backText === '‹ Workbench' && rc.back >= 44 && !rc.rooms && rc.other && rc.agents >= 3, 'Recipes: the recipe cards show under "‹ Workbench" (44px); rooms are gone; the address says #recipes', rc);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    ok(await page.evaluate(() => document.body.dataset.screen) === 'recipes', '...a reload lands on the same screen');
    await page.click('#wbBackBtn');
    await sleep(200);
    ok(await page.evaluate(() => document.body.dataset.screen === 'home' && !location.hash && document.getElementById('roomsWrap').offsetParent !== null), '‹ Workbench goes home');
    await page.goBack();
    await sleep(200);
    ok(await page.evaluate(() => document.body.dataset.screen) === 'recipes', '...and the browser back returns to the screen');
    await page.evaluate(() => { location.hash = '#history'; });
    await sleep(200);
    const hs = await page.evaluate(() => ({ screen: document.body.dataset.screen, title: document.getElementById('wbBarTitle').textContent, recent: document.getElementById('recent').offsetParent !== null, rooms: document.getElementById('roomsWrap').offsetParent !== null }));
    ok(hs.screen === 'history' && hs.title === 'History' && hs.recent && !hs.rooms, 'History: recently closed shows under "‹ Workbench" (with its empty line when nothing is there)', hs);
    await page.click('#wbBackBtn');
    await sleep(150);
  }

  /* THE TITLE BAR [workbench home]: the name, a find box, one ⋯ menu */
  {
    const bar = await page.evaluate(() => ({
      brand: document.querySelector('.mgr-brand')?.textContent,
      loose: [...document.querySelectorAll('.mgr-top > a.btn')].length,
      find: !!document.getElementById('mgrFind'),
    }));
    ok(bar.brand === 'Workbench' && bar.loose === 0 && bar.find, 'title bar: "Workbench", a find box, no loose Art/Account/Showcase buttons', bar);
    await page.click('#mgrMore');
    await sleep(150);
    const mn = await page.evaluate(() => {
      const m = document.getElementById('mgrMoreMenu');
      const r = m.getBoundingClientRect();
      return { open: !m.hidden, items: [...m.querySelectorAll('.mgr-mi')].filter((a) => !a.hidden).map((a) => a.textContent), top: Math.round(r.top), right: Math.round(innerWidth - r.right), exp: document.getElementById('mgrMore').getAttribute('aria-expanded') };
    });
    ok(mn.open && mn.exp === 'true' && /^Recipes\d*\|History\d*\|Art\|Account\|Showcase\|Global settings$/.test(mn.items.join('|')), 'the ⋯ menu: Screens, then Art · Account · Showcase · Global settings', mn);
    ok(mn.top > 30 && mn.top < 70 && mn.right >= 0 && mn.right < 120, '...a popover under the button', mn);
    await page.keyboard.press('Escape');
    await sleep(100);
    ok(await page.evaluate(() => document.getElementById('mgrMoreMenu').hidden && document.activeElement.id === 'mgrMore'), '...Esc closes it and the focus returns to the button');
    await page.click('#mgrMore');
    await page.mouse.click(400, 500);
    await sleep(100);
    ok(await page.evaluate(() => document.getElementById('mgrMoreMenu').hidden), '...a click outside closes it');
    const aux = await page.evaluate(() => ['artBtn', 'accountBtn', 'showcaseBtn', 'settingsBtn'].map((id) => { const a = document.getElementById(id); return [a?.dataset.aux, a?.getAttribute('target')]; }));
    ok(aux.every(([t, tg]) => t && tg === '_blank'), '...the items keep opening beside the manager (data-aux)', aux);

    const vis = (sel) => page.evaluate((q) => [...document.querySelectorAll(q)].filter((n) => n.offsetParent !== null).map((n) => n.textContent.slice(0, 40)), sel);
    await page.fill('#mgrFind', 'bravo');
    await sleep(200);
    const f1 = await page.evaluate(() => ({ rooms: [...document.querySelectorAll('#roomList > .rcard')].filter((n) => n.offsetParent !== null).map((n) => n.dataset.room), live: [...document.querySelectorAll('#liveList .live-row')].filter((n) => n.offsetParent !== null).length, none: !document.getElementById('mgrFindNone').hidden }));
    ok(f1.rooms.length === 0 && f1.live === 1 && !f1.none, 'find "bravo": the live session stays, rooms that do not hold it go', f1);
    await page.fill('#mgrFind', 'alpha');
    await sleep(200);
    const f2 = await page.evaluate(() => ({ rooms: [...document.querySelectorAll('#roomList > .rcard')].filter((n) => n.offsetParent !== null).map((n) => n.querySelector('.rc-nm').childNodes[0].textContent), live: [...document.querySelectorAll('#liveList .live-row')].filter((n) => n.offsetParent !== null).length }));
    ok(f2.rooms.join() === 'Alpha Room' && f2.live === 0, 'find "alpha": the room stays; its seated session is on the room card, not in Live sessions, and the other live row goes', f2);
    await page.fill('#mgrFind', 'zzzz');
    await sleep(200);
    const f3 = await page.evaluate(() => ({ none: !document.getElementById('mgrFindNone').hidden, text: document.getElementById('mgrFindNone').textContent }));
    ok(f3.none && /zzzz/.test(f3.text), 'find with no match says so', f3);
    await page.focus('#mgrFind');
    await page.keyboard.press('Escape');
    await sleep(200);
    const f4 = await page.evaluate(() => ({ v: document.getElementById('mgrFind').value, hid: document.querySelectorAll('[data-found-hide]').length, none: !document.getElementById('mgrFindNone').hidden }));
    ok(f4.v === '' && f4.hid === 0 && !f4.none, 'Esc clears the find and everything is back', f4);
    void vis;
  }

  /* the room's last line shows when the room list carries it (v.last {author, text, ts}) and updates when it changes; the room's own art
     tile is a ghosted layer behind the header, and a room with no tile has none [workbench home] */
  {
    const lctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, storageState: await context.storageState() });
    await lctx.route(/\/api\/rooms\/me$/, me);
    let lastText = 'Phase 2 plan posted for review';
    let lastTs = 1;
    await lctx.route(/\/api\/rooms\?art=ref$/, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      if (Array.isArray(body) && body[0]) {
        body[0].last = { author: 'alpha', text: lastText, ts: lastTs };
        body[0].room.art_tile = { id: 'geometric-iso-cubes-quiet-tint', blend: 'color', level: 50, strength: 50, zoom: 100 };
      }
      await route.fulfill({ response: res, json: body });
    });
    const lp = await lctx.newPage();
    await lp.goto(`${BASE}/manager.html`, { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    const ll = await lp.evaluate(() => [...document.querySelectorAll('.rcard')].map((c) => c.querySelector('.rc-last')?.textContent ?? null));
    ok(ll.filter(Boolean).length === 1 && /^@alpha Phase 2 plan posted for review$/.test(ll.find(Boolean)), 'a card shows "@author text" when the room list carries a last line, and none when it does not', ll);
    lastText = 'Merged and live'; lastTs = 2;
    await sleep(3500);
    const l2 = await lp.evaluate(() => [...document.querySelectorAll('.rcard')].map((c) => c.querySelector('.rc-last')?.textContent ?? null).filter(Boolean));
    ok(l2.length === 1 && /^@alpha Merged and live$/.test(l2[0]), '...and the line follows the room: a new last line repaints the card', l2);
    const art = await lp.evaluate(() => [...document.querySelectorAll('.rcard')].map((c) => {
      const a = c.querySelector('.rc-hd > .rc-art');
      if (!a) { return null; }
      const cs = getComputedStyle(a);
      const hd = c.querySelector('.rc-hd').getBoundingClientRect();
      const r = a.getBoundingClientRect();
      return { bg: cs.backgroundImage, size: cs.backgroundSize, op: cs.opacity, blend: cs.mixBlendMode, pos: cs.position, covers: Math.abs(r.width - hd.width) < 1 && Math.abs(r.height - hd.height) < 1, pe: cs.pointerEvents,
        nameAbove: getComputedStyle(c.querySelector('.rc-tx')).position === 'relative' };
    }));
    const withArt = art.filter(Boolean);
    ok(withArt.length === 1 && /geometric-iso-cubes-quiet-tint-512\.webp/.test(withArt[0].bg) && withArt[0].size === '180px' && withArt[0].op === '0.16' && withArt[0].blend === 'luminosity' && withArt[0].pos === 'absolute' && withArt[0].covers && withArt[0].pe === 'none' && withArt[0].nameAbove, 'the room card header wears its own art tile (180px, .16, luminosity, covering the header, the text above it); a room with no tile has no layer', art);
    const tileOk = await lp.evaluate(async () => (await fetch('/assets/tiles/geometric-iso-cubes-quiet-tint-512.webp')).status);
    ok(tileOk === 200, '...and the tile file is served', tileOk);
    const lt = await lp.evaluate(async () => {
      const m = await import('/palette.mjs');
      m.applyPref(document, { key: 'aurora', mode: 'light' });
      await new Promise((r) => setTimeout(r, 200));
      const cs = getComputedStyle(document.querySelector('.rc-art'));
      const out = { blend: cs.mixBlendMode, op: cs.opacity };
      m.applyPref(document, { key: 'aurora', mode: 'dark' });
      return out;
    });
    ok(lt.blend === 'multiply' && lt.op === '0.1', 'light mode: the art is multiply at .10', lt);
    await lp.screenshot({ path: join(tmpdir(), 'manager-cards-art.png'), clip: { x: 0, y: 0, width: 900, height: 420 } });
    await lctx.close();
  }

  /* LIGHT MODE (Owner 2026-10-06: review in light): the card's wash is light and its text keeps contrast */
  {
    const lm = await page.evaluate(async () => {
      const m = await import('/palette.mjs');
      m.applyPref(document, { key: 'aurora', mode: 'light' });
      await new Promise((r) => setTimeout(r, 200));
      const card = document.querySelector('.rcard');
      const px = (css) => { const cv = document.createElement('canvas'); cv.width = cv.height = 1; const x = cv.getContext('2d'); x.fillStyle = css; x.fillRect(0, 0, 1, 1); return [...x.getImageData(0, 0, 1, 1).data].slice(0, 3); };
      const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const cr = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;background:var(--rw)';
      card.append(probe);
      const wash = px(getComputedStyle(probe).backgroundColor);
      probe.remove();
      const ink = px(getComputedStyle(card.querySelector('.rc-nm')).color);
      const sub = px(getComputedStyle(card.querySelector('.rc-sub')).color);
      const out = { wash, nameContrast: +cr(wash, ink).toFixed(2), subContrast: +cr(wash, sub).toFixed(2), washLum: +lum(wash).toFixed(2) };
      m.applyPref(document, { key: 'aurora', mode: 'dark' });
      return out;
    });
    ok(lm.washLum > 0.5 && lm.nameContrast >= 4.5 && lm.subContrast >= 3.5, 'light mode: the room card wash is light and its name/sub keep contrast', lm);
  }

  /* PHONE: the ⋯ opens a bottom sheet, 48px items */
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: await context.storageState() });
  await phone.route(/\/api\/rooms\/me$/, me);
  const pp = await phone.newPage();
  await pp.goto(`${BASE}/manager.html`, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  await pp.click(`${rowSel} .rr-more`);
  await sleep(250);
  const sh = await pp.evaluate(() => {
    const m = document.querySelector('.rr-menu');
    const r = m?.getBoundingClientRect();
    return m ? { sheet: m.classList.contains('is-sheet'), bottom: Math.round(innerHeight - r.bottom), items: [...m.querySelectorAll('.rr-mi')].map((b) => Math.round(b.getBoundingClientRect().height)), title: m.querySelector('.rr-mt')?.textContent } : null;
  });
  ok(sh && sh.sheet && sh.bottom === 0 && sh.items.every((h) => h >= 48) && sh.title === 'Alpha Room', 'phone: the menu is a bottom sheet titled with the room, 48px items', sh);
  const hb = await pp.evaluate(() => [...document.querySelectorAll('.rcard .rr-more')].map((b) => Math.round(b.getBoundingClientRect().height)));
  ok(hb.every((h) => h >= 40), 'phone: ⋯ is a 40px target', hb);
  await pp.keyboard.press('Escape'); // the room menu from the check above
  await sleep(200);
  {
    const hh = await pp.evaluate(() => ({ newRoom: Math.round(document.getElementById('roomNewCard').getBoundingClientRect().height), newSes: Math.round(document.getElementById('newSessionCard').getBoundingClientRect().height), back: null }));
    ok(hh.newRoom >= 84 && hh.newSes >= 84, 'phone: the + cards are 84px rows', hh);
    await sleep(400);
    await pp.tap('#newSessionCard');
    await sleep(250);
    const sp = await pp.evaluate(() => { const p = document.querySelector('.sp-panel'); const r = p.getBoundingClientRect(); return { bottom: Math.round(innerHeight - r.bottom), w: Math.round(r.width), vw: innerWidth, rows: [...p.querySelectorAll('.sp-pick')].map((b) => Math.round(b.getBoundingClientRect().height)) }; });
    ok(sp.bottom === 0 && sp.w === sp.vw && sp.rows.length >= 3 && sp.rows.every((h) => h >= 48), 'phone: the recipe picker is a bottom sheet with 48px rows', sp);
    await sleep(400);
    await pp.tap('#sessionPickerX');
    await sleep(200);
  }
  {
    await sleep(400); // past the double-tap guard
    await pp.tap('#roomNewCard');
    await sleep(200);
    const ps = await pp.evaluate(() => { const p = document.querySelector('.rn-panel'); const r = p.getBoundingClientRect(); return { bottom: Math.round(innerHeight - r.bottom), w: Math.round(r.width), vw: innerWidth, grab: getComputedStyle(p.querySelector('.grab')).display, path: Math.round(document.querySelector('.rn-path').getBoundingClientRect().height), input: Math.round(document.getElementById('roomNewName').getBoundingClientRect().height), font: getComputedStyle(document.getElementById('roomNewName')).fontSize, focus: document.activeElement?.id !== 'roomNewName' }; });
    ok(ps.bottom === 0 && ps.w === ps.vw && ps.grab === 'block' && ps.path >= 44 && ps.input >= 44 && ps.font === '16px' && ps.focus, 'phone: the New room sheet is a bottom sheet, 44px paths and field (16px), nothing focused', ps);
    await sleep(400); // past the page's double-tap-zoom guard (300 ms), which swallows a click that follows a tap too closely
    await pp.tap('#roomNewX');
    await sleep(200);
    ok(await pp.evaluate(() => document.getElementById('roomNewSheet').hidden), '...its ✕ closes it');
  }
  {
    const hd = await pp.evaluate(() => {
      const f = document.getElementById('mgrFind').getBoundingClientRect();
      const m = document.getElementById('mgrMore').getBoundingClientRect();
      const b = document.querySelector('.mgr-brand').getBoundingClientRect();
      return { findW: Math.round(f.width), findH: Math.round(f.height), findFont: getComputedStyle(document.getElementById('mgrFind')).fontSize, moreW: Math.round(m.width), moreH: Math.round(m.height), findBelow: f.top >= Math.max(m.bottom, b.bottom) - 1, vw: innerWidth, over: document.documentElement.scrollWidth > innerWidth };
    });
    ok(hd.findW > hd.vw - 40 && hd.findH >= 40 && hd.findFont === '16px' && hd.findBelow && hd.moreW >= 44 && hd.moreH >= 44 && !hd.over, 'phone header: find on its own full-width 40px row (16px), ⋯ 44x44, no sideways scroll', hd);
    await sleep(400); // the page's double-tap-zoom guard swallows a click that follows a tap within 300 ms
    await pp.tap('#mgrMore');
    await sleep(200);
    const sg = await pp.evaluate(() => { const m = document.getElementById('mgrMoreMenu'); const r = m.getBoundingClientRect(); return { bottom: Math.round(innerHeight - r.bottom), w: Math.round(r.width), vw: innerWidth, items: [...m.querySelectorAll('.mgr-mi')].filter((a) => !a.hidden).map((a) => Math.round(a.getBoundingClientRect().height)), grab: getComputedStyle(m.querySelector('.grab')).display, focus: document.activeElement === document.body || document.activeElement?.tagName !== 'A' }; });
    ok(sg.bottom === 0 && sg.w === sg.vw && sg.items.every((h) => h >= 48) && sg.grab === 'block' && sg.focus, 'phone: the ⋯ menu is a bottom sheet with a grab bar, 48px rows, nothing focused', sg);
    await sleep(400);
    await pp.tap('#mgrMoreScrim');
    await sleep(100);
  }
  await pp.screenshot({ path: join(tmpdir(), 'manager-rooms-phone.png') });
  await page.screenshot({ path: join(tmpdir(), 'manager-rooms-desk.png'), clip: { x: 0, y: 0, width: 760, height: 600 } });
  await phone.close();
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
