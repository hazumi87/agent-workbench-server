/* ONE NAME PER LEVEL + THE PHONE'S ONE MENU [layers]  node test/room-layers.probe.mjs   Owner 2026-10-07, the design system handoff 1.P and 1.O
 * The real room and agent pages against a scratch engine (dead broker, temp table, never a live pane).
 *   1.P  the Room cell's first row says "Room chat" (never the room's name), carries no (i) (the bar has it); its second line is only what
 *        the badge does not say: "3 new in workgroups" / "3 new" / "main room"; in a workgroup the same row reads "main room" / "main room · 3
 *        new"; the Seats bar is just "Seats" (no "· name", no plate).
 *   1.O  [phone rail, Owner 2026-10-08] the four-square button toggles the jump strip (Workbench, the other rooms, the apps, the seats); the
 *        people button opens the sheet (Scratchpad, Rooms, Seats); no "‹ Workbench ✕" bar; an agent's own page keeps the small menu. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(422);
const DEAD = P(423);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-layers-token';
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
await assertFree(PORT, 'room-layers.probe.mjs');
await assertFree(DEAD, 'room-layers.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-layers-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null; let browser = null; let log = '';
try {
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
    return JSON.parse(r.out.trim().split('\n').pop());
  };
  await seed({ recipes: [{ id: 'rec-a', name: 'Awake', projectDir: '/srv/x/awake', vendor: 'claude-code', agent: 'awake', color: '#0dab49' }, { id: 'rec-b', name: 'Other', projectDir: '/srv/x/other', vendor: 'claude-code', agent: 'other', color: '#1f5fbf' }] });
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
  const seeded = (await seed({ rooms: [{ name: 'Layers Main', seats: [{ handle: 'awake', recipe_id: 'rec-a', occupant: 'recipe:rec-a' }, { handle: 'other', recipe_id: 'rec-b' }] }] })).rooms[0];
  const main = seeded.id;
  const { windowCookie } = await import('./_scratch.mjs');
  const cookie = await windowCookie(BASE, TOKEN);
  const call = async (path, method, json) => {
    const res = await fetch(BASE + path, { method, headers: { cookie, 'content-type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json) });
    let b = null; try { b = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: b };
  };
  const wgr = await call(`/api/rooms/${main}/workgroups`, 'POST', { name: 'Layers Sub', alias: 'sub', move: [seeded.seats.other ?? Object.values(seeded.seats)[1]], lead: { move: seeded.seats.other ?? Object.values(seeded.seats)[1] } });
  const WG = wgr.body?.room?.id ?? wgr.body?.workgroup?.id ?? wgr.body?.id;
  ok(!!WG, 'a main room and a workgroup exist', wgr.status);
  browser = await chromium.launch({ headless: true });
  const F = (id, room) => `/api/rooms/${room}/panels/${id}/frame/t/tok-${id}/`;
  let wgUnread = 3; // the workgroup's unread, as the engine reports it per person
  let roomUnread = 0;
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  for (const room of [main, WG]) {
    await ctx.route(new RegExp(`/api/rooms/${room}(\\?.*)?$`), async (route) => {
      const res = await route.fetch();
      const b = await res.json();
      b.panels = [{ id: 'p-tasks', room_id: room, kind: 'view', title: 'Tasks', icon: 'tasks', order: 1, seat_handle: null, scripts: true, url: 'http://127.0.0.1:9/never', frameUrl: F('p-tasks', room) }];
      if (room === main) { b.unread = roomUnread; if (b.family) { b.family.workgroups = (b.family.workgroups ?? []).map((w) => ({ ...w, unread: wgUnread })); } }
      else if (b.family?.parent) { b.family.parent = { ...b.family.parent, unread: roomUnread }; }
      await route.fulfill({ response: res, json: b });
    });
  }
  await ctx.route(/\/panels\/p-tasks\/frame\/t\/[^/]+\//, async (route) => { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><body style="margin:0">tasks<script>parent.postMessage({panel:"height", px:120}, "*")</script></body>' }); });
  await ctx.route(new RegExp('/assets$'), async (route) => { await route.fulfill({ json: { folder: '', shareUrl: '', assets: [] } }); });
  const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
  await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);

  const rowOf = (page) => page.evaluate(() => {
    const r = document.querySelector('#roomList .seat.is-room');
    return r ? { title: r.querySelector('.seat-handle')?.textContent, meta: r.querySelector('.seat-meta')?.textContent, brief: !!r.querySelector('.brief-btn, .rb-btn, button[aria-label^="Brief"]'), badge: r.querySelector('.seat-count')?.textContent ?? null, aria: r.getAttribute('aria-label') } : null;
  });
  /* ---- 1.P, PC, the main room ---- */
  await pg.goto(`${BASE}/room.html?room=${main}`, { waitUntil: 'domcontentloaded' });
  await sleep(3500);
  let r1 = await rowOf(pg);
  ok(r1?.title === 'Room chat' && !r1.brief && /Layers Main/.test(r1.aria), 'main room: the Room cell\'s first row says "Room chat" (its accessible name still names the room), with no (i) on it', r1);
  ok(r1?.meta === '3 new in workgroups', '...second line "3 new in workgroups" when a workgroup has news', r1);
  wgUnread = 0;
  await pg.goto(`${BASE}/room.html?room=${main}`, { waitUntil: 'domcontentloaded' });
  await sleep(3500);
  r1 = await rowOf(pg);
  ok(r1?.meta === 'main room' && r1.badge === null, '...with nothing new at all: "main room"', r1);
  const bar = await pg.evaluate(() => ({ crumb: document.getElementById('roomName')?.textContent.replace(/\s+/g, ' ').trim(), briefOnBar: !!document.querySelector('#roomName button, #roomName .brief-btn'), seats: document.getElementById('seatsTt')?.textContent, plate: !!document.querySelector('#seatsTt .sub-plate'), count: document.getElementById('seatCount')?.textContent, tip: document.getElementById('seatsTt')?.title }));
  ok(/^Main room · 1 seat · lead @awakeⓘ?$/.test(bar.crumb.replace(/\s+/g, ' ')) && bar.briefOnBar, 'the room bar says where you are: "Main room · 1 seat · lead @awake", then the (i) (the tab names the project)', bar);
  ok(bar.seats === 'Seats' && !bar.plate && bar.count === '1', 'the Seats bar is just "Seats" and the count (no "· name", no plate)', bar);

  /* ---- 1.P, PC, a workgroup ---- */
  roomUnread = 3;
  await pg.goto(`${BASE}/room.html?room=${WG}`, { waitUntil: 'domcontentloaded' });
  await sleep(3500);
  const hd = await pg.evaluate(() => {
    const r = document.querySelector('#roomList .seat.is-room');
    return { title: r?.querySelector('.seat-handle')?.textContent, meta: r?.querySelector('.seat-meta')?.textContent, brief: !!r?.querySelector('button[aria-label^="Brief"]'), plate: !!r?.querySelector('.sub-plate'), badge: r?.querySelector('.seat-count')?.textContent ?? null, seats: document.getElementById('seatsTt')?.textContent, seatsPlate: !!document.querySelector('#seatsTt .sub-plate'), subRow: document.querySelector('#roomList .seat.is-sub .seat-handle')?.textContent, crumbBrief: !!document.querySelector('#roomName button') };
  });
  ok(hd.title === 'Room chat' && hd.meta === 'main room · 3 new' && hd.plate && !hd.brief && hd.badge === '3', 'workgroup: the same row reads "Room chat" / "main room · 3 new", with the square plate and no (i)', hd);
  ok(hd.seats === 'Seats' && !hd.seatsPlate && hd.subRow === 'Layers Sub' && hd.crumbBrief, '...the Seats bar is "Seats" with no plate, the workgroup row keeps its name, the bar keeps the (i)', hd);
  const wbar = await pg.evaluate(() => ({ text: document.getElementById('roomName').textContent.replace(/\s+/g, ' ').trim(), plate: !!document.querySelector('#roomName .sub-plate'), title: document.title, i: document.querySelectorAll('#roomName button').length }));
  ok(/^Layers Sub ?@sub · workgroup · lead @other · 1 seatⓘ?$/.test(wbar.text) && wbar.plate && wbar.i === 1, 'workgroup: the bar is its plate, "Layers Sub @sub · workgroup · lead @other · 1 seat", then ONE (i)', wbar);
  ok(wbar.title === 'Layers Main · Workroom', 'the browser tab of a workgroup page names the project (the main room), not the workgroup', wbar.title);
  /* the shell's tab: the project's name, also with a workgroup open */
  await pg.goto(`${BASE}/shell.html?tabs=${encodeURIComponent(`/room.html?room=${WG}`)}`, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  const tab = await pg.evaluate(() => [...document.querySelectorAll('.hwb-tab:not(.is-hub)')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()));
  ok(tab.length >= 1 && tab.every((t) => /^Layers Main/.test(t)) && !tab.some((t) => /Layers Sub/.test(t)), 'the shell tab of a workgroup says the project\'s name ("Layers Main"), never the workgroup\'s', tab);
  roomUnread = 0;

  /* ---- 1.O, the phone ---- */
  const ph = await ctx.newPage();
  const perrs = []; ph.on('pageerror', (e) => perrs.push(String(e)));
  await ph.setViewportSize({ width: 390, height: 780 });
  await ph.goto(`${BASE}/room.html?room=${main}&from=wb`, { waitUntil: 'domcontentloaded' });
  await sleep(3500);
  const H = await ph.evaluate(() => ({ menu: document.getElementById('phLine')?.getAttribute('aria-label'), icons: [...document.querySelectorAll('.ph-hdr .ph-ib')].map((b) => b.id), agents: !!document.getElementById('phAgents'), strip: !!document.getElementById('phStrip'), backBar: !!document.getElementById('pbar'), name: document.getElementById('phName')?.textContent, firstIcon: Math.round(document.getElementById('phLine').getBoundingClientRect().left) }));
  ok(H.agents && H.strip && !H.backBar, 'phone: the four-square button (rail) AND the people button (sheet) are both there; still no "‹ Workbench ✕" bar', H);
  ok(H.icons.join() === 'phLine,phAgents,phSearch,phFilter,phGear' && H.name === 'Layers Main', '...the header is rail, people, search, filter, settings; the room title is the first thing', H);
  await ph.click('#phLine');
  await sleep(600);
  const R = await ph.evaluate(() => ({ shown: !document.getElementById('phStrip').hidden, first: document.querySelector('#phStrip > .ph-chip')?.textContent.trim(), chips: [...document.querySelectorAll('#phStrip > .ph-chip')].map((c) => c.textContent.trim()) }));
  ok(R.shown && R.first === 'Workbench' && !R.chips.some((c) => /Layers Sub|sub/.test(c)), 'phone: the four-square button toggles the rail; Workbench is its first chip and NO room (or workgroup) is on it', R);
  await ph.click('#phLine');
  await ph.click('#phAgents');
  await sleep(600);
  const S = await ph.evaluate(() => {
    const body = document.getElementById('phSheetBody');
    return {
      label: document.getElementById('phSheet').getAttribute('aria-label'), wb: !!document.getElementById('phWorkbench'),
      heads: [...body.querySelectorAll('h3')].map((h) => h.textContent.replace(/[+\s]+$/, '')), roomRow: body.querySelector('.seat.is-room .seat-handle')?.textContent,
    };
  });
  ok(!S.wb && S.heads.join() === 'Scratchpad,Rooms,Seats' && S.roomRow === 'Room chat', '...the people button\'s sheet: Scratchpad, Rooms (first row "Room chat"), "Seats" (no "· name"); no Workbench row, no Apps (they are on the rail)', S);
  await ph.evaluate(() => document.getElementById('phScrim').click());
  await ph.click('#phLine');
  await ph.click('#phStrip .ph-places');
  await ph.waitForSelector('#phSheet:not([hidden]) .pl-full', { timeout: 6000 }).catch(() => {});
  await ph.waitForFunction(() => document.querySelectorAll('#phSheet h3').length >= 2, null, { timeout: 8000 }).catch(() => {}); // the headings land after the rows on a slower machine
  const WS = await ph.evaluate(() => ({ label: document.getElementById('phSheet').getAttribute('aria-label'), first: document.querySelector('#phSheetBody .pl-row')?.textContent.replace(/\s+/g, ' ').trim(), heads: [...document.querySelectorAll('#phSheet h3')].map((h) => h.textContent) }));
  ok(WS.label === 'Workbench' && /^Full Workbench/.test(WS.first ?? '') && WS.heads[0] === 'Rooms', '...a tap on the Workbench chip opens the Workbench sheet: "Full Workbench" on top, then Rooms', WS);
  if (SHOTS) { await sleep(600); await ph.screenshot({ path: join(SHOTS, 'phone-workbench-sheet.png') }); }
  await Promise.all([ph.waitForURL(/\/manager\.html/, { timeout: 5000 }).catch(() => {}), ph.click('#phSheet .pl-full')]);
  ok(new URL(ph.url()).pathname === '/manager.html', '...and "Full Workbench" goes to the Workbench page', ph.url());
  ok(perrs.length === 0, 'no page errors (phone room)', perrs.slice(0, 3));

  /* ---- the phone's title: the project's name lives here (no tab on a phone) ---- */
  {
    const wp = await ctx.newPage();
    await wp.setViewportSize({ width: 390, height: 780 });
    await wp.goto(`${BASE}/room.html?room=${WG}`, { waitUntil: 'domcontentloaded' });
    await sleep(3500);
    const T = await wp.evaluate(() => { const n = document.getElementById('phName'); const proj = n.querySelector('.pn-proj'); const wg = n.querySelector('.pn-wg'); return { text: n.textContent, proj: proj?.textContent, wg: wg?.textContent, projColor: proj && getComputedStyle(proj).color, wgColor: wg && getComputedStyle(wg).color, tip: n.title }; });
    ok(T.proj === 'Layers Main' && T.wg === 'Layers Sub' && /›/.test(T.text) && T.projColor !== T.wgColor, 'phone, in a workgroup: the title is "Layers Main › Layers Sub": the project dimmer, the workgroup strong', T);
    await wp.evaluate(() => { const n = document.getElementById('phName'); n.querySelector('.pn-proj').textContent = 'A very long project name that cannot possibly fit beside the workgroup name'; });
    const fit = await wp.evaluate(() => { const n = document.getElementById('phName'); const proj = n.querySelector('.pn-proj').getBoundingClientRect(); const wg = n.querySelector('.pn-wg'); return { wgClipped: wg.scrollWidth > wg.clientWidth + 1, projShrunk: proj.width < 230, projEllipsis: getComputedStyle(n.querySelector('.pn-proj')).textOverflow === 'ellipsis', overflow: n.scrollWidth > n.clientWidth + 1 }; });
    ok(fit.projShrunk && fit.projEllipsis && !fit.wgClipped && !fit.overflow, '...when it does not fit, the PROJECT shortens first (ellipsis) and the workgroup keeps its name', fit);
    await wp.goto(`${BASE}/room.html?room=${main}`, { waitUntil: 'domcontentloaded' });
    await sleep(3500);
    ok((await wp.evaluate(() => document.getElementById('phName').textContent)) === 'Layers Main', 'phone, in the main room: just the room\'s name');
    await wp.click('#phAgents');
    await sleep(500);
    const E = await wp.evaluate(() => ({ chev: !!document.querySelector('#phWorkbench .pc'), rows: [...document.querySelectorAll('.ph-padrow')].map((r) => [r.querySelector('.pn').textContent, r.dataset.new, getComputedStyle(r.querySelector('.pn')).color]), rail: [...document.querySelectorAll('.pad-line .pn')].map((x) => x.textContent) }));
    ok(!E.chev, 'the Workbench row has no chevron (it goes back, not in)', E);
    ok(E.rows.length === 2 && E.rows.every((r) => r[0] === 'none yet' && r[1] === '0'), 'an empty Scratchpad says "none yet" (not "0 new of 0") in the menu', E.rows);
    await wp.close();
  }

  /* ---- 1.O, an agent's own page ---- */
  await ph.goto(`${BASE}/solo.html?recipe=rec-a`, { waitUntil: 'domcontentloaded' });
  await sleep(3500);
  await ph.click('.sb-places');
  await sleep(900);
  const A = await ph.evaluate(() => { const body = document.getElementById('phSheetBody'); return { first: body.firstElementChild?.id, wbH: Math.round(document.getElementById('phWorkbench')?.getBoundingClientRect().height ?? 0), roomRow: document.getElementById('phRoomRow')?.textContent.replace(/\s+/g, ' ').trim(), heads: [...body.querySelectorAll('h3')].map((h) => h.textContent), label: document.querySelector('.sb-places')?.getAttribute('aria-label'), wbChev: !!document.querySelector('#phWorkbench .pc'), roomChev: !!document.querySelector('#phRoomRow .pc') }; });
  ok(A.label === 'Menu' && A.first === 'phWorkbench' && A.wbChev === false && A.roomChev === true && A.wbH >= 56 && /^Layers Main\s*the room this agent sits in/.test(A.roomRow ?? '') && A.heads.join() === 'Room', 'an agent\'s page: the same button; its menu is Workbench, then the room it sits in', A);
  await ph.click('#phRoomRow');
  await ph.waitForURL(/\/room\.html\?room=/, { timeout: 5000 }).catch(() => {});
  ok(new URL(ph.url()).searchParams.get('room') === main, '...a tap on the room opens it', ph.url());
  /* ---- a mode flip repaints the wash at once, not on the next 2.5 s poll ---- */
  {
    const fl = await ctx.newPage();
    await fl.setViewportSize({ width: 1400, height: 900 });
    await fl.goto(`${BASE}/room.html?room=${main}`, { waitUntil: 'domcontentloaded' });
    await sleep(3500);
    const wsd = () => fl.evaluate(() => (document.querySelector('.wm-pane') || document.documentElement).style.getPropertyValue('--wm-wash'));
    await fl.evaluate(() => { const l = document.querySelector('.rm-line') || document.body; l.classList.add('wm-pane'); });
    const before = await wsd();
    await fl.evaluate(async () => { const mod = await import('/palette.mjs'); mod.applyPref(document, { key: 'aurora', mode: 'light' }); });
    await sleep(300);
    const after = await wsd();
    ok(before === '' && after !== '', 'the wash repaints within 300 ms of a mode flip', { before, after });
    await fl.close();
  }
  /* ---- screenshots for the review (SHOTS_DIR): PC main room + workgroup, the phone menu in both, the agent page's menu; dark and light ---- */
  if (SHOTS) {
    const setMode = async (page, mode) => { await page.evaluate(async (m) => { const mod = await import('/palette.mjs'); mod.applyPref(document, { key: 'aurora', mode: m }); }, mode); await sleep(600); };
    const snap = (page, name) => page.screenshot({ path: join(SHOTS, name) });
    for (const mode of ['dark', 'light']) {
      const pc = await ctx.newPage();
      await pc.setViewportSize({ width: 1400, height: 900 });
      for (const [tag, id] of [['main', main], ['workgroup', WG]]) {
        await pc.goto(`${BASE}/room.html?room=${id}`, { waitUntil: 'domcontentloaded' });
        await sleep(3500);
        await setMode(pc, mode);
        await snap(pc, `pc-${mode}-${tag}.png`);
      }
      await pc.close();
      const ph2 = await ctx.newPage();
      await ph2.setViewportSize({ width: 390, height: 780 });
      for (const [tag, id] of [['main', main], ['workgroup', WG]]) {
        await ph2.goto(`${BASE}/room.html?room=${id}`, { waitUntil: 'domcontentloaded' });
        await sleep(3500);
        await setMode(ph2, mode);
        await snap(ph2, `phone-${mode}-${tag}-room.png`);
        await ph2.click('#phLine');
        await sleep(900);
        await snap(ph2, `phone-${mode}-${tag}-rail.png`);
        await ph2.click('#phLine');
        await ph2.click('#phAgents');
        await sleep(600);
        await snap(ph2, `phone-${mode}-${tag}-menu.png`);
      }
      await ph2.goto(`${BASE}/solo.html?recipe=rec-a`, { waitUntil: 'domcontentloaded' });
      await sleep(3500);
      await setMode(ph2, mode);
      await ph2.click('.sb-places');
      await sleep(900);
      await snap(ph2, `phone-${mode}-agent-menu.png`);
      await ph2.close();
    }
  }

  ok(errs.length === 0, 'no page errors', errs.slice(0, 3));
  await ctx.close();
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
