/* THE SEAT CONTEXT MENU (the design system room-seat-menu-v1, Owner 2026-09-28).
 *
 *   node test/room-seat-menu.probe.mjs
 *
 * What only a browser can prove:
 *   - the menu opens by right-click, the row's ⋯ and Shift+F10; a title row
 *     (@handle + the state in words); the items in their FIXED order, always
 *     present, disabled (aria-disabled, focusable, the reason as a tooltip)
 *     rather than hidden; Esc closes and the focus goes back to the row
 *   - Remove is disabled on the LEAD ("Make another seat lead first")
 *   - Disconnect calls POST .../seats/:id/disconnect; the row flips to the
 *     RESTORABLE ring with "disconnected · <time>" (whole, at the default
 *     rail width; "by you" in the tooltip) and its Restore; a
 *     toast "Disconnected @x · Restore" whose Restore calls the start verb
 *   - Rename is inline: the field, Enter saves (PATCH), a taken handle shows
 *     the engine's refusal in coral, the 2.5 s poll does not tear the field out
 *   - the Remove dialog: the engine's truth in "What happens", Cancel has the
 *     default focus, Esc cancels, Remove removes the seat and the session
 *     KEEPS running
 *   - phone (390px): ⋯ always shown, a 48px bottom sheet, a long press opens
 *     it, no sideways scroll
 *
 * DISCONNECT IS STUBBED. The scratch engine has a DEAD broker, so a seeded
 * `live` row has no pty behind it and the real route answers 200
 * {ok:false, result:'failed'} (endForCycle: nothing resident to end). The probe
 * asserts exactly that from the real engine first, then routes the page's
 * request to a stub that files the row dehydrated in the table (what a real
 * 'cycle' end does) and answers the success shape.
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(150), DEAD broker P(151),
 * temp table seeded through the store (test/rooms-routes.seed.ts): never Owner's
 * data, childEnv() scrubbed, fabric + NATS off.
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
const PORT = P(150);
const DEAD_BROKER_PORT = P(151);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-seat-menu-token';

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* the focused element: a menu item? does it draw the focus ring? */
const ringOf = (pg) => pg.evaluate(() => {
  const a = document.activeElement;
  return { mi: !!a?.classList?.contains('rsm-mi'), label: a?.textContent?.slice(0, 20), fv: !!a?.matches?.(':focus-visible'), outline: a ? getComputedStyle(a).outlineStyle : null, quiet: !!a?.hasAttribute?.('data-quiet-focus') };
});

let cookieP = null;
const userCookie = () => (cookieP ??= windowCookie(BASE, TOKEN));

async function call(path, opts = {}) {
  const method = opts.method ?? (opts.json !== undefined ? 'POST' : 'GET');
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
  await assertFree(p, 'room-seat-menu.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-seat-menu-'));
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
  const recipe = (id, name, agent) => ({ id, name, projectDir: `/srv/x/${agent}`, vendor: 'claude-code', agent, color: '#1f5fbf' });
  const DEH = 'recipe:rec-deh';
  await seed({
    recipes: [recipe('rec-lead', 'Leader', 'leader'), recipe('rec-buddy', 'Buddy', 'buddy'), recipe('rec-deh', 'Sleeper', 'sleeper'),
      recipe('rec-new', 'Newbie', 'newbie'), recipe('rec-extra', 'Extra', 'extra')],
    sessions: [{ paneid: DEH, recipe_id: 'rec-deh', vendor: 'claude-code', agent: 'sleeper', state: 'dehydrated' }],
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

  const LEAD = 'recipe:rec-lead';
  const BUDDY = 'recipe:rec-buddy';
  const EXTRA = 'recipe:rec-extra';
  const live = (paneid, rid, agent) => ({ paneid, recipe_id: rid, vendor: 'claude-code', agent, state: 'live' });
  const post = await seed({
    sessions: [live(LEAD, 'rec-lead', 'leader'), live(BUDDY, 'rec-buddy', 'buddy'), live(EXTRA, 'rec-extra', 'extra')],
    rooms: [{
      name: 'Seat Menu Probe',
      seats: [
        { handle: 'leader', recipe_id: 'rec-lead', occupant: LEAD },
        { handle: 'buddy', recipe_id: 'rec-buddy', occupant: BUDDY },
        { handle: 'sleeper', recipe_id: 'rec-deh', occupant: DEH },
        { handle: 'newbie', recipe_id: 'rec-new' },
        { handle: 'extra', recipe_id: 'rec-extra', occupant: EXTRA },
      ],
    }],
  });
  const R = post.rooms[0].id;
  const SEAT = post.rooms[0].seats;
  const eng = (await call(`/api/rooms/${R}`)).body;
  ok(eng.room.lead_seat === SEAT.leader, 'setup: @leader is the lead', eng.room.lead_seat);

  /* THE REAL ROUTE on this engine: a seeded live row has no pty to end */
  const real = await call(`/api/rooms/${R}/seats/${SEAT.buddy}/disconnect`, { json: {} });
  ok(real.status === 200 && real.body?.ok === false && real.body?.result === 'failed',
    'engine: the real disconnect answers ok:false/failed here (no resident pty behind a seeded row), so the page\'s disconnect is stubbed below', real);
  const realNew = await call(`/api/rooms/${R}/seats/${SEAT.newbie}/disconnect`, { json: {} });
  ok(realNew.status === 409 && /nothing to disconnect/.test(realNew.body?.error ?? ''), 'engine: a seat with no pane is a 409 with the reason', realNew);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    const f = document.querySelector('form');
    (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
  }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  const ROOM_URL = `/room.html?room=${R}`;
  await page.goto(`${BASE}${ROOM_URL}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#roster .seat[data-handle="buddy"]');
  await sleep(800);

  const row = (h) => `#roster .seat[data-handle="${h}"]`;
  const menu = () => page.evaluate(() => {
    const m = document.querySelector('.rsm-menu');
    if (!m) { return null; }
    const r = m.getBoundingClientRect();
    return {
      title: m.querySelector('.rsm-mt')?.firstChild?.textContent, state: m.querySelector('.rsm-mst')?.textContent,
      seps: m.querySelectorAll('.rsm-msep').length, sheet: m.classList.contains('is-sheet'),
      box: { x: r.x, w: r.width, bottom: r.bottom },
      items: [...m.querySelectorAll('.rsm-mi')].map((b) => ({
        a: b.dataset.a, label: [...b.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(''),
        off: b.getAttribute('aria-disabled') === 'true', why: b.title || null, sub: b.querySelector('.rsm-sub')?.textContent ?? null,
        h: Math.round(b.getBoundingClientRect().height), cls: b.className,
      })),
      focus: document.activeElement?.dataset?.a ?? null,
    };
  });

  /* 1. RIGHT-CLICK a live seat */
  await page.click(`${row('buddy')} .seat-handle`, { button: 'right' });
  let m = await menu();
  ok(m && m.title === '@buddy' && m.state === 'live', 'right-click opens the menu with a title row: @buddy · live', m && { t: m.title, s: m.state });
  ok(m && m.items.map((i) => i.label).join('|') === 'Open window|Close window|Restore|Disconnect|Reload from project defaults…|Model & effort…|Move to workgroup…|Rename @buddy…|Make lead|Remove from room…' && m.seps === 2,
    '...items in the fixed order, two separators', m?.items.map((i) => i.label));
  const it = (a) => m.items.find((i) => i.a === a);
  ok(!it('open').off && it('go').off && it('go').why === 'Already running' && !it('disc').off && it('disc').sub === 'restorable' && !it('ren').off && !it('rem').off,
    '...on a live seat: Open, Disconnect ("restorable"), Rename, Remove enabled; Restore DISABLED ("Already running")', m.items);
  ok(!it('reload').off && it('reload').sub === 'new model/effort', '...Reload from project defaults enabled on a live seat with a project', it('reload'));
  ok(it('closew').off && it('closew').why === 'No window open', '...Close window DISABLED on a live seat nobody is viewing ("No window open"; the enabled case is room-close-window.probe)', it('closew'));
  ok(/go/.test(it('go').cls) && /danger/.test(it('rem').cls), '...Restore/Start is the teal "go" item, Remove the coral one', m.items.map((i) => i.cls));
  ok(m.items.every((i) => i.h === 34), '...34px items', m.items.map((i) => i.h));
  ok(m.focus === 'open', '...the focus lands on the first enabled item', m.focus);
  await page.keyboard.press('ArrowDown');
  const f2 = await page.evaluate(() => ({ a: document.activeElement?.dataset?.a, dis: document.activeElement?.getAttribute('aria-disabled') }));
  ok(f2.a === 'closew' && f2.dis === 'true', 'ArrowDown moves to the next item, a DISABLED one stays focusable', f2);
  await page.keyboard.press('Enter'); // a disabled item does nothing
  ok((await menu()) !== null, '...Enter on a disabled item does nothing (the menu stays)');
  await page.keyboard.press('Escape');
  const back = await page.evaluate(() => ({ menu: !!document.querySelector('.rsm-menu'), focus: document.activeElement?.dataset?.handle ?? null }));
  ok(!back.menu && back.focus === 'buddy', 'Esc closes it and the focus goes back to the row', back);

  /* 2. the ⋯ on a restorable seat */
  await page.hover(row('sleeper'));
  const moreVis = await page.evaluate((s) => getComputedStyle(document.querySelector(`${s} .rsm-more`)).opacity, row('sleeper'));
  ok(moreVis === '1', 'the row\'s ⋯ shows on hover', moreVis);
  const idleMore = await page.evaluate((s) => getComputedStyle(document.querySelector(`${s} .rsm-more`)).opacity, row('newbie'));
  ok(idleMore === '0', '...and is hidden on a row that is not hovered or focused (desktop)', idleMore);
  await page.click(`${row('sleeper')} .rsm-more`);
  m = await menu();
  ok(m && m.state === 'restorable' && !it('go').off && it('go').label === 'Restore', '⋯ opens it: a restorable seat offers Restore', m && { s: m.state, go: it('go') });
  ok(it('open').off && it('open').why === 'No live session to open' && it('disc').off && it('disc').why === 'Only a live session can be disconnected' && it('disc').sub === null,
    '...Open window and Disconnect disabled, with their reasons as tooltips', m.items);
  const expanded = await page.evaluate((s) => document.querySelector(`${s} .rsm-more`).getAttribute('aria-expanded'), row('sleeper'));
  ok(expanded === 'true', '...its ⋯ says aria-expanded', expanded);
  const away = await page.evaluate(() => { const r = document.querySelector('.rm-top').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.click(away.x, away.y); // click-away
  ok((await menu()) === null, 'a click away closes it');

  /* 3. Shift+F10 on a never-started seat */
  await page.focus(row('newbie'));
  await page.keyboard.press('Shift+F10');
  m = await menu();
  ok(m && m.state === 'never started' && it('go').label === 'Start' && !it('go').off, 'Shift+F10 opens it: a never-started seat offers Start', m && { s: m.state, go: it('go') });
  const kbRing = await ringOf(page);
  ok(kbRing.mi && kbRing.fv && kbRing.outline !== 'none' && !kbRing.quiet, 'opened by KEYBOARD: focus is on the first item WITH the ring (web/focus-intent.mjs)', kbRing);
  await page.keyboard.press('Escape');

  /* 4. the LEAD: Remove is disabled with the reason */
  await page.click(`${row('leader')} .seat-handle`, { button: 'right' });
  m = await menu();
  ok(it('rem').off && it('rem').why === 'Make another seat lead first', 'on the lead, Remove is disabled: "Make another seat lead first"', it('rem'));
  await page.click('.rsm-mi[data-a="rem"]', { force: true }); // aria-disabled: Playwright's own check would refuse
  ok(!(await page.$('.rsm-dscrim')), '...and clicking it opens nothing');
  await page.keyboard.press('Escape');

  /* 5. DISCONNECT (stubbed success; see the header) */
  let discReq = null;
  await page.route(`**/api/rooms/${R}/seats/${SEAT.buddy}/disconnect`, async (route) => {
    discReq = { method: route.request().method(), body: route.request().postData() };
    await seed({ sessions: [{ paneid: BUDDY, recipe_id: 'rec-buddy', vendor: 'claude-code', agent: 'buddy', state: 'dehydrated' }] });
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, seat: SEAT.buddy, handle: 'buddy', paneid: BUDDY, result: 'disconnected', state: 'dehydrated', entries: [] }) });
  });
  let startReq = null;
  await page.route(`**/api/rooms/${R}/seats/${SEAT.buddy}/start`, async (route) => {
    startReq = { method: route.request().method(), body: route.request().postData() };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, entries: [] }) });
  });
  await page.click(`${row('buddy')} .seat-handle`, { button: 'right' });
  await page.click('.rsm-mi[data-a="disc"]');
  await page.waitForSelector('.rm-toast');
  await sleep(600);
  const toast = await page.evaluate(() => ({ text: document.querySelector('.rm-toast .tx')?.textContent, btn: document.querySelector('.rm-toast .act')?.textContent }));
  ok(discReq?.method === 'POST', 'Disconnect POSTs .../seats/:id/disconnect (no confirm)', discReq);
  ok(toast.text === 'Disconnected @buddy' && toast.btn === 'Restore', '...a toast "Disconnected @buddy · Restore"', toast);
  const flipped = await page.evaluate((s) => {
    const li = document.querySelector(s);
    const st = li.querySelector('.seat-status');
    const meta = li.querySelector('.seat-meta');
    return { status: st?.textContent, tip: st?.title, rowTip: li.title, ring: li.querySelector('.seat-ring')?.dataset.state, act: li.querySelector('.seat-act')?.textContent,
      rail: Math.round(document.getElementById('roster').closest('aside, .rm-rail, #rail')?.getBoundingClientRect().width ?? document.getElementById('roster').getBoundingClientRect().width),
      metaSW: meta?.scrollWidth, metaCW: meta?.clientWidth, stRight: Math.round(st?.getBoundingClientRect().right ?? 0), metaRight: Math.round(meta?.getBoundingClientRect().right ?? 0) };
  }, row('buddy'));
  ok(/^disconnected · \d{1,2}:\d{2}\s?[AP]M$/.test(flipped.status ?? '') && !/by you/.test(flipped.status ?? ''), '...the row says "disconnected · <time>" (no "by you" on the row)', flipped.status);
  ok(/^disconnected by you · \d{1,2}:\d{2}\s?[AP]M$/.test(flipped.tip ?? '') && /disconnected by you · \d{1,2}:\d{2}/.test(flipped.rowTip ?? ''), '...and "by you" is in the tooltip (the status\'s and the row\'s)', { tip: flipped.tip, rowTip: flipped.rowTip });
  ok(flipped.rail === 272 && flipped.metaSW <= flipped.metaCW && flipped.stRight <= flipped.metaRight, '...whole at the default 272px rail: the time is not truncated', flipped);
  ok(flipped.ring === 'restorable', '...on the RESTORABLE ring (not the coral alert)', flipped.ring);
  ok(flipped.act === 'Restore', '...with its own teal Restore on the row', flipped.act);
  await page.click('.rm-toast .act');
  await sleep(500);
  ok(startReq?.method === 'POST', 'the toast\'s Restore calls the seat start verb (rehydrate)', startReq);
  await page.click(`${row('buddy')} .seat-handle`, { button: 'right' });
  m = await menu();
  ok(m && m.state === 'disconnected' && !it('go').off && it('disc').off, 'the menu on the disconnected seat: state "disconnected", Restore on, Disconnect off', m && { s: m.state });
  await page.keyboard.press('Escape');
  await page.unroute(`**/api/rooms/${R}/seats/${SEAT.buddy}/start`);

  /* 6. RENAME, inline */
  await page.click(`${row('newbie')} .seat-handle`, { button: 'right' });
  await page.click('.rsm-mi[data-a="ren"]');
  const ren = await page.evaluate(() => {
    const i = document.querySelector('.rsm-ren input');
    return i ? { focus: document.activeElement === i, value: i.value, sel: [i.selectionStart, i.selectionEnd], at: document.querySelector('.rsm-ren .at')?.textContent,
      hint: document.querySelector('.rsm-renhint')?.textContent, edge: getComputedStyle(document.querySelector('.rsm-ren')).borderTopColor } : null;
  });
  ok(ren && ren.focus && ren.value === 'newbie' && ren.sel[0] === 0 && ren.sel[1] === 6 && ren.at === '@', 'Rename: the handle becomes a field, @ fixed, text selected', ren);
  const EN = String.fromCharCode(8211);
  ok(ren && ren.hint === `a${EN}z, 0${EN}9, - · unique here`, '...with the dim hint under it ("a–z, 0–9, - · unique here")', ren?.hint);
  const hintBox = await page.evaluate(() => {
    const h = document.querySelector('.rsm-renhint');
    const rg = document.createRange();
    rg.selectNodeContents(h);
    const lines = new Set([...rg.getClientRects()].map((r) => Math.round(r.top))).size;
    const cs = getComputedStyle(h);
    const one = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
    const rail = document.getElementById('roster').closest('aside, .rm-rail, #rail') ?? document.getElementById('roster');
    return { lines, h: h.getBoundingClientRect().height, lineH: cs.lineHeight, one, rail: Math.round(rail.getBoundingClientRect().width), ws: cs.whiteSpace };
  });
  ok(hintBox.rail === 272 && hintBox.lines === 1 && hintBox.h <= hintBox.one + 1, '...ONE line at the 272px rail (the height of one line box)', hintBox);
  await sleep(3000); // longer than the 2.5 s poll: the row must not be redrawn under the field
  const survived = await page.evaluate(() => document.activeElement?.closest?.('.rsm-ren') !== null && !!document.activeElement?.closest?.('.rsm-ren'));
  ok(survived, '...and the roster poll does not tear the field out');
  await page.keyboard.type('sleeper');
  await page.keyboard.press('Enter');
  await sleep(700);
  const bad = await page.evaluate(() => ({ err: document.querySelector('.rsm-renerr')?.textContent, bad: !!document.querySelector('.rsm-ren.bad'), focus: document.activeElement?.tagName }));
  ok(bad.bad && /already taken/.test(bad.err ?? '') && bad.focus === 'INPUT', 'a taken handle: the engine\'s refusal in coral, the field stays', bad);
  await page.keyboard.press('Escape');
  await sleep(300);
  let h = await page.evaluate(() => [...document.querySelectorAll('#roster .seat')].map((li) => li.dataset.handle).filter(Boolean));
  ok(h.includes('newbie') && !(await page.$('.rsm-ren')), 'Esc cancels: the row is back as @newbie', h);
  await page.click(`${row('newbie')} .seat-handle`, { button: 'right' });
  await page.click('.rsm-mi[data-a="ren"]');
  await page.keyboard.type('fresh');
  await page.keyboard.press('Enter');
  await sleep(1200);
  h = await page.evaluate(() => [...document.querySelectorAll('#roster .seat')].map((li) => li.dataset.handle).filter(Boolean));
  const facts = (await call(`/api/rooms/${R}/line?kind=fact`)).body.entries.map((e) => e.body);
  ok(h.includes('fresh') && !h.includes('newbie'), 'Enter saves (PATCH): the row is @fresh', h);
  ok(facts.includes('@newbie is now @fresh'), '...and the engine wrote the fact', facts.slice(-2));

  /* 7. REMOVE: the dialog */
  const dialog = () => page.evaluate(() => {
    const c = document.querySelector('.rsm-card');
    return c ? { role: c.getAttribute('role'), modal: c.getAttribute('aria-modal'), title: c.querySelector('.hd')?.textContent,
      facts: [...c.querySelectorAll('li')].map((l) => l.textContent), focus: document.activeElement?.dataset?.a ?? null,
      order: [...c.querySelectorAll('.ft button')].map((b) => b.textContent) } : null;
  });
  await page.click(`${row('extra')} .seat-handle`, { button: 'right' });
  await page.click('.rsm-mi[data-a="rem"]');
  let d = await dialog();
  ok(d && d.role === 'alertdialog' && d.modal === 'true' && d.title === 'Remove @extra from Seat Menu Probe?', 'Remove opens an alertdialog: "Remove @extra from Seat Menu Probe?"', d && { t: d.title, r: d.role });
  ok(d && /keeps running/.test(d.facts[0]) && /Live Tabs/.test(d.facts[0]) && /no longer be addressed here/.test(d.facts[1]) && /room (line|chat)/.test(d.facts[2]) && /seat it again/.test(d.facts[3]),
    '...its "What happens" says the engine\'s truth for a live seat', d?.facts);
  ok(d && d.focus === 'cancel' && d.order.join(',') === 'Cancel,Remove', '...Cancel has the default focus, Remove sits right', d && { f: d.focus, o: d.order });
  await page.keyboard.press('Escape');
  const back2 = await page.evaluate(() => ({ dialog: !!document.querySelector('.rsm-card'), focus: document.activeElement?.dataset?.handle ?? null }));
  ok(!back2.dialog && back2.focus === 'extra', 'Esc cancels and the focus goes back to the row', back2);
  await page.click(`${row('sleeper')} .seat-handle`, { button: 'right' });
  await page.click('.rsm-mi[data-a="rem"]');
  d = await dialog();
  ok(d && /Nothing is ended/.test(d.facts[0]), '...a restorable seat: "Nothing is ended"', d?.facts[0]);
  await page.mouse.click(5, 5); // the scrim
  ok(!(await dialog()), 'a click on the scrim cancels');
  await page.click(`${row('fresh')} .seat-handle`, { button: 'right' });
  await page.click('.rsm-mi[data-a="rem"]');
  d = await dialog();
  ok(d && /no running session/.test(d.facts[0]), '...a never-started seat: nothing ends', d?.facts[0]);
  await page.keyboard.press('Escape');
  await page.click(`${row('extra')} .seat-handle`, { button: 'right' });
  await page.click('.rsm-mi[data-a="rem"]');
  await page.click('.rsm-card button[data-a="remove"]');
  await sleep(1200);
  h = await page.evaluate(() => [...document.querySelectorAll('#roster .seat')].map((li) => li.dataset.handle).filter(Boolean));
  const after = (await call(`/api/rooms/${R}`)).body;
  const rowsNow = (await seed({ read: [EXTRA] })).rows;
  ok(!h.includes('extra') && !after.seats.some((s) => s.handle === 'extra'), 'Remove removes the seat (DELETE)', h);
  ok(rowsNow[0]?.state === 'live', '...and its session KEEPS running (the table row is still live)', rowsNow[0]?.state);

  ok(errors.length === 0, 'no page errors (desktop)', errors.slice(0, 3));

  /* 8. PHONE */
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: await context.storageState() });
  const pp = await phone.newPage();
  const perr = [];
  pp.on('pageerror', (e) => perr.push(String(e)));
  await pp.goto(`${BASE}${ROOM_URL}`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  await pp.click('#phAgents');
  await sleep(500);
  const prow = (hh) => `.ph-sheet .seat[data-handle="${hh}"]`;
  const pmore = await pp.evaluate((s) => {
    const b = document.querySelector(`${s} .rsm-more`);
    const r = b.getBoundingClientRect();
    return { op: getComputedStyle(b).opacity, w: r.width, h: r.height };
  }, prow('buddy'));
  ok(pmore.op === '1' && pmore.w === 44 && pmore.h === 44, 'phone: the ⋯ is always shown, 44px', pmore);
  await pp.tap(`${prow('buddy')} .rsm-more`);
  await sleep(300);
  const pm = await pp.evaluate(() => {
    const m = document.querySelector('.rsm-menu');
    if (!m) { return null; }
    const r = m.getBoundingClientRect();
    return { sheet: m.classList.contains('is-sheet'), x: r.x, w: r.width, bottom: Math.round(r.bottom), vh: innerHeight,
      hs: [...m.querySelectorAll('.rsm-mi')].map((b) => Math.round(b.getBoundingClientRect().height)),
      scrim: !!document.querySelector('.rsm-scrim'), sw: document.documentElement.scrollWidth, iw: innerWidth };
  });
  ok(pm && pm.sheet && pm.x === 0 && pm.w === 390 && pm.bottom === pm.vh && pm.scrim, 'phone: ⋯ opens a bottom sheet, full width, on a scrim', pm);
  ok(pm && pm.hs.length === 10 && pm.hs.every((x) => x === 48), '...ten 48px items (Model & effort, Move to workgroup and Make lead joined the list)', pm?.hs);
  ok(pm && pm.sw <= pm.iw, '...and no sideways scroll', pm && { sw: pm.sw, iw: pm.iw });
  const tapRing = await ringOf(pp);
  ok(tapRing.mi && !tapRing.fv && tapRing.outline === 'none' && tapRing.quiet, 'opened by a TAP: focus is in the menu but NO ring (keyboard users only)', tapRing);
  await pp.tap('.rsm-scrim', { position: { x: 10, y: 10 } }); // the top-left corner: the taller sheet covers the scrim's centre
  await sleep(300);
  ok(!(await pp.$('.rsm-menu')), '...a tap on the scrim closes it');
  /* a long press: a touch pointerdown held past 500 ms. A key was pressed
     first (a hardware keyboard on a tablet, or text typed before): Chromium
     then still thinks "keyboard" and would ring the programmatic focus;
     the menu must go by the LAST input, which was a touch. */
  await pp.keyboard.press('Shift');
  await pp.evaluate((s) => {
    const li = document.querySelector(`${s} .seat-meta`);
    const r = li.getBoundingClientRect();
    li.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: r.x + 10, clientY: r.y + 4, isPrimary: true }));
  }, prow('sleeper'));
  await sleep(700);
  const lp = await pp.evaluate(() => ({ sheet: !!document.querySelector('.rsm-menu.is-sheet'), title: document.querySelector('.rsm-mt')?.firstChild?.textContent }));
  ok(lp.sheet && lp.title === '@sleeper', 'phone: a long press opens the sheet for that seat', lp);
  const lpRing = await ringOf(pp);
  ok(lpRing.mi && !lpRing.fv && lpRing.outline === 'none' && lpRing.quiet, '...focus on its first item, no ring', lpRing);
  const sw = await pp.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  ok(sw[0] <= sw[1], 'phone: no sideways scroll with the sheet up', sw);
  ok(perr.length === 0, 'no page errors (phone)', perr.slice(0, 3));
} catch (e) {
  ok(false, `probe threw: ${e?.stack ?? e}`);
} finally {
  await browser?.close().catch(() => {});
  engine?.kill('SIGKILL');
  await sleep(300);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
