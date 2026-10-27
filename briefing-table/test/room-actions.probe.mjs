/* ROOM NAV v3 + SEAT ACTIONS (Owner 2026-09-26, the design system room-nav-v3; engine
 * half workrooms-build §2.9). Supersedes the item-6 "Open mounts a shell tab"
 * probe: a seat NEVER adds a window tab now.
 *
 *   node test/room-actions.probe.mjs
 *
 * What only a browser can prove:
 *   - the left column: the ROOM row first and selected on entry, then every
 *     seat (lead first); each seat draws only the life-changing action the
 *     ENGINE lists (Restore / Start), never Open
 *   - selecting a seat swaps the RIGHT column to that seat's solo page, framed
 *     in the room with `inroom=1` (its own session bar showing), and the
 *     shell's tab count does not change; selecting the room brings the line back
 *   - Start POSTs the seat start verb and frames the answer's FRESH pane
 *   - ↑/↓ + Enter select; the phone's switcher opens the sheet and a pick closes it
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(67), DEAD broker P(68),
 * temp table seeded through the store (test/rooms-routes.seed.ts): no real
 * pty (the dead broker means an attach cannot spawn one), never Owner's data,
 * childEnv() scrubbed, fabric + NATS off.
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
const PORT = P(67);
const DEAD_BROKER_PORT = P(68);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-actions-token';

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* the line filter is the room bar's menu now (the design system room-filter-v1): pick a
   seat choice / toggle a kind through it, then close it */
const pickWho = (f, who) => f.evaluate((w) => {
  document.getElementById('filterBtn').click();
  document.querySelector(`#filterMenu [data-who="${CSS.escape(w)}"]`).click();
  document.getElementById('filterBtn').click();
}, who);
const toggleKind = (f, k) => f.evaluate((kind) => {
  document.getElementById('filterBtn').click();
  document.querySelector(`#filterMenu [data-kind="${kind}"]`).click();
  document.getElementById('filterBtn').click();
}, k);

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
  await assertFree(p, 'room-actions.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-actions-'));
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
    recipes: [recipe('rec-new', 'Newbie', 'newbie'), recipe('rec-deh', 'Sleeper', 'sleeper'), recipe('rec-live', 'Awake', 'awake')],
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

  const LIVE = 'recipe:rec-live';
  const post = await seed({
    sessions: [{ paneid: LIVE, recipe_id: 'rec-live', vendor: 'claude-code', agent: 'awake', state: 'live' }],
    rooms: [{
      name: 'Actions Probe',
      seats: [
        { handle: 'awake', recipe_id: 'rec-live', occupant: LIVE },
        { handle: 'sleeper', recipe_id: 'rec-deh', occupant: DEH },
        { handle: 'newbie', recipe_id: 'rec-new' },
      ],
    }],
  });
  const R = post.rooms[0].id;
  const SEAT = post.rooms[0].seats;

  /* the engine's own answer, for comparison */
  const eng = (await call(`/api/rooms/${R}`)).body;
  const engActs = Object.fromEntries(eng.seats.map((s) => [s.handle, s.actions]));
  ok(JSON.stringify(engActs) === JSON.stringify({ awake: ['open'], sleeper: ['rehydrate'], newbie: ['start'] }),
    'engine: seat.actions are open / rehydrate / start', engActs);

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
  await page.goto(`${BASE}/app/shell.html?kind=manager&debug=1&tabs=${encodeURIComponent(ROOM_URL)}`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  const rf = () => page.frames().find((f) => f.url().includes('/room.html'));
  const shellTabs = () => page.evaluate(() => document.querySelectorAll('#stage iframe').length);
  const tabs0 = await shellTabs();
  const rows = () => rf().evaluate(() => [...document.querySelectorAll('#roomList .seat.is-room, #roster .seat')].map((li) => ({ /* the rail split: the Room row is in #roomList, the seats in #roster */
    id: li.dataset.seatId, handle: li.dataset.handle || null, sel: li.classList.contains('sel'),
    act: li.querySelector('.seat-act')?.dataset.act || null, label: li.querySelector('.seat-act')?.textContent || null,
  })));
  let r = await rows();
  ok(r[0]?.id === 'room' && r[0].sel, 'the ROOM row is first and selected on entry', r[0]);
  ok(r.slice(1).map((x) => x.handle).join(',') === 'awake,sleeper,newbie', '...then every seat, in roster order', r.map((x) => x.handle));
  const acts = Object.fromEntries(r.slice(1).map((x) => [x.handle, x.act]));
  ok(JSON.stringify(acts) === JSON.stringify({ awake: null, sleeper: 'rehydrate', newbie: 'start' }), 'no Open: a live seat has no button; Restore / Start stay on the row', acts);
  ok(r.slice(1).filter((x) => x.label).map((x) => x.label).join(',') === 'Restore,Start', '...labelled Restore / Start', r.map((x) => x.label));
  const vis = () => rf().evaluate(() => ({
    line: !document.getElementById('roomLine').hidden, seat: !document.getElementById('seatView').hidden,
    frames: [...document.querySelectorAll('#seatView iframe')].map((f) => ({ src: f.getAttribute('src'), shown: !f.hidden })),
  }));
  let v = await vis();
  ok(v.line && !v.seat && v.frames.length === 0, 'the right column is the room line on entry', v);

  /* SELECT a live seat: its solo page in the right column, no new window tab */
  await rf().click('#roster .seat[data-handle="awake"] .seat-handle');
  await sleep(2500);
  v = await vis();
  const awakeF = v.frames.find((f) => f.shown);
  ok(!v.line && v.seat && awakeF && /\/solo\.html\?recipe=rec-live/.test(awakeF.src) && /inroom=1/.test(awakeF.src),
    'selecting @awake frames its solo page (inroom=1) in the right column', v);
  ok((await shellTabs()) === tabs0, '...and adds NO window tab', { before: tabs0, after: await shellTabs() });
  r = await rows();
  ok(r.find((x) => x.handle === 'awake')?.sel && !r[0].sel, '...the row takes the selection', r.map((x) => `${x.handle ?? x.id}:${x.sel}`));
  const sf = page.frames().find((f) => f.url().includes('/solo.html?recipe=rec-live'));
  const bar = sf ? await sf.evaluate(() => {
    const b = document.getElementById('sbar');
    return { hidden: b.hidden, h: b.getBoundingClientRect().height, embeddedClass: document.documentElement.classList.contains('is-embedded') };
  }) : null;
  ok(bar && !bar.hidden && bar.h > 0 && !bar.embeddedClass, '...drawing its OWN session bar (not a shell tab, so nobody else draws it)', bar);

  /* back to the room */
  await rf().click('#roomList .seat.is-room');
  await sleep(500);
  v = await vis();
  ok(v.line && !v.seat && v.frames.length === 1, 'selecting the room brings the line back (the seat view hides; its frame is kept, not reattached)', v);

  /* keyboard: ↓ from the room row, Enter selects */
  await rf().focus('#roster .seat[data-handle="awake"]'); // the Seats list is its own listbox since the rail split
  await page.keyboard.press('ArrowDown');
  const focused = await rf().evaluate(() => document.activeElement?.dataset?.handle);
  ok(focused === 'sleeper', '↓ moves the focus from the first seat to the second', focused);
  await page.keyboard.press('Enter');
  await sleep(1500);
  v = await vis();
  const panel = await rf().evaluate(() => { const n = document.getElementById('seatNone'); return { shown: !n.hidden, text: n.textContent, act: n.querySelector('.seat-act')?.textContent }; });
  ok(v.seat && !v.frames.some((f) => /recipe=rec-deh/.test(f.src)), 'Enter selects it: the restorable seat is NOT framed (an attach would restore it: auriga FAIL-1)', v);
  ok(panel.shown && /restorable/.test(panel.text) && panel.act === 'Restore', '...it shows the not-running panel with Restore', panel);
  const eng2 = (await call(`/api/rooms/${R}`)).body.seats.find((s) => s.handle === 'sleeper');
  ok(eng2.occupant?.state === 'dehydrated', '...and the engine row is still dehydrated (nothing spawned)', eng2.occupant?.state);

  /* START: frames a FRESH pane, no window tab */
  await rf().click('#roster .seat[data-handle="newbie"] .seat-handle');
  await sleep(500);
  const none = await rf().evaluate(() => { const n = document.getElementById('seatNone'); return { shown: !n.hidden, text: n.textContent }; });
  ok(none.shown && /no session yet/.test(none.text), 'a never-started seat says so, with its Start', none);
  await rf().click('#roster .seat[data-handle="newbie"] .seat-act');
  await sleep(2500);
  v = await vis();
  const nbF = v.frames.find((f) => f.shown);
  ok(nbF && /recipe=rec-new/.test(nbF.src) && /pane=recipe%3Arec-new%23[0-9a-f]{8}/.test(nbF.src), 'Start frames a FRESH pane of the seat\'s recipe', v);
  ok((await shellTabs()) === tabs0, '...still no window tab', await shellTabs());
  const room1 = (await call(`/api/rooms/${R}`)).body;
  const nb = room1.seats.find((s) => s.handle === 'newbie');
  ok(nb.occupant?.id && nbF?.src.includes(encodeURIComponent(nb.occupant.id)), '...the pane the seat is now bound to', { seat: nb.occupant?.id, src: nbF?.src });
  const facts = (await call(`/api/rooms/${R}/line?kind=fact`)).body.entries.map((e) => e.body);
  ok(facts.some((b) => /newbie/.test(b) && /start/i.test(b)), '...and the line records the start as a fact', facts.slice(-2));
  /* desktop: Enter sends, Shift+Enter is a new line */
  await rf().click('#roomList .seat.is-room');
  await rf().fill('#input', 'desk line');
  await rf().press('#input', 'Shift+Enter');
  const shifted = await rf().inputValue('#input');
  ok(shifted === 'desk line\n', 'desktop: Shift+Enter is a new line', shifted);
  /* Ctrl+Enter is a new line too (Owner 2026-09-27: the CLI habit), inserted
     at the caret, and it does not send */
  await rf().fill('#input', 'ab');
  await rf().evaluate(() => { const el = document.getElementById('input'); el.setSelectionRange(1, 1); });
  await rf().press('#input', 'Control+Enter');
  await sleep(300);
  const ctrl = await rf().inputValue('#input');
  const ctrlSent = (await call(`/api/rooms/${R}/line?kind=chat`)).body.entries.some((e) => e.body === 'ab' || e.body === 'a\nb');
  ok(ctrl === 'a\nb' && !ctrlSent, 'desktop: Ctrl+Enter is a new line at the caret and does not send', { ctrl, ctrlSent });
  await rf().fill('#input', 'desk line');
  await rf().press('#input', 'Enter');
  await sleep(1200);
  const sent = (await call(`/api/rooms/${R}/line?kind=chat`)).body.entries.map((e) => e.body);
  ok(sent.includes('desk line') && (await rf().inputValue('#input')) === '', 'desktop: Enter sends the line', sent.slice(-2));
  /* THE SEND BAR (Owner 2026-09-27): the box sits evenly in the bar, → sits on
     the box's bottom edge with room beside it, and the delivery note clears
     the bar's top border */
  const sbar = await rf().evaluate(() => {
    const r = (el) => el.getBoundingClientRect();
    const c = r(document.getElementById('compose'));
    const t = r(document.getElementById('input'));
    const b = r(document.getElementById('sendBtn'));
    const n = document.getElementById('delivery');
    const nr = n.hidden ? null : r(n);
    return { top: t.top - c.top, bottom: c.bottom - t.bottom, sendBottom: b.bottom - t.bottom, gap: b.left - t.right, w: b.width, h: b.height,
      label: document.getElementById('sendBtn').getAttribute('aria-label'), note: nr ? c.top - nr.bottom : null };
  });
  ok(sbar.top === sbar.bottom, 'desktop: the input sits evenly between the bar\'s top and bottom', sbar);
  ok(Math.abs(sbar.sendBottom) <= 1 && sbar.gap >= 12, '...→ sits on the input\'s bottom edge, at least 12px beside it', sbar);
  ok(sbar.w === 40 && sbar.h === 40 && sbar.label === 'Send', '...a 40px square → button named "Send"', sbar);
  ok(sbar.note === null || sbar.note >= 6, '...and the delivery note clears the bar\'s top border', sbar);
  /* WHO the line shows: everyone / to me / between agents / a seat */
  const lead1 = await call(`/api/rooms/${R}/line`, { json: { text: 'lead to you', from: { paneid: LIVE } } }); // the lead, no @
  const a2a = await call(`/api/rooms/${R}/line`, { json: { text: '@sleeper agents only', from: { paneid: LIVE } } });
  ok(lead1.status === 200 && a2a.status === 200, 'setup: the lead posts one line with no @ and one to @sleeper', [lead1.status, a2a.status, lead1.body?.error, a2a.body?.error]);
  await sleep(1500);
  const shown = () => rf().evaluate(() => [...document.querySelectorAll('#line .entry')].filter((li) => getComputedStyle(li).display !== 'none').map((li) => li.querySelector('.entry-body').textContent));
  const opts = await rf().evaluate(() => [...document.querySelectorAll('#filterMenu [role=menuitemradio]')].map((o) => o.textContent.replace('✓', '')));
  ok(opts.slice(0, 3).join(',') === 'Everyone,To me,Between agents' && opts.includes('@awake'), 'desktop: the Show filter offers everyone / to me / between agents / each seat', opts);
  await pickWho(rf(), 'me');
  let v2 = await shown();
  ok(v2.includes('desk line') && v2.includes('lead to you') && !v2.includes('@sleeper agents only') && v2.some((b) => /was added/.test(b)), '"to me": what I wrote, the lead\'s unaddressed line and room facts (Owner 2026-09-30); not agent-to-agent', v2);
  await pickWho(rf(), 'agents');
  v2 = await shown();
  ok(v2.length === 1 && v2[0] === '@sleeper agents only', '"between agents": only a seat writing to another seat', v2);
  await pickWho(rf(), '');
  ok(errors.length === 0, 'no page errors in the shell', errors.slice(0, 3));

  /* PHONE: the switcher and its sheet (standalone room page) */
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: await context.storageState() });
  const pp = await phone.newPage();
  const perr = [];
  pp.on('pageerror', (e) => perr.push(String(e)));
  await pp.goto(`${BASE}${ROOM_URL}`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  /* ROOM ON PHONE v1 (the design system room-phone-v1): the line is home; an agent is a
     layer over it; lists are bottom sheets */
  const ph = () => pp.evaluate(() => {
    const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().width > 0;
    const layer = document.getElementById('layer');
    return {
      home: vis(document.getElementById('phHome')), line: vis(document.getElementById('roomLine')),
      name: document.getElementById('phName').textContent, meta: document.getElementById('phMeta').textContent,
      column: vis(document.querySelector('.rm-roster')),
      chips: [...document.querySelectorAll('#phStrip .ph-chip')].map((c) => c.textContent),
      inLayer: document.getElementById('main').classList.contains('in-layer'),
      layerX: Math.round(layer.getBoundingClientRect().left), layerW: Math.round(layer.getBoundingClientRect().width),
      layerVis: getComputedStyle(layer).visibility,
      title: document.getElementById('lyTitle').textContent,
      seatFrame: [...document.querySelectorAll('#seatView iframe')].filter((f) => !f.hidden).map((f) => f.getAttribute('src')),
      sheet: !document.getElementById('phSheet').hidden,
      overflow: document.documentElement.scrollWidth > innerWidth,
      /* the tap target: the box plus its invisible ::before extension [web/room-phone-7b] */
      btns: [...document.querySelectorAll('.ph-hdr .ph-ib')].map((b) => { const be = getComputedStyle(b, '::before'); return Math.round(b.getBoundingClientRect().height - (parseFloat(be.top) || 0) - (parseFloat(be.bottom) || 0)); }),
    };
  });
  let p = await ph();
  ok(p.home && p.line && !p.column && !p.inLayer, 'phone: home is the line with its header; no column', p);
  ok(p.name === 'Actions Probe' && p.meta === '3 agents', 'phone: the header names the room and counts agents (no zero-apps line) [web/room-phone-7]', p.meta);
  ok(p.btns.every((h) => h >= 44), 'phone: the line toggle / Agents are 44px buttons', p.btns);
  /* the phone's one menu [phone menu]: no strip any more; the four-square button opens Workbench, the Scratchpad, Rooms, Seats */
  ok(p.chips.length === 0 && (await pp.evaluate(() => document.getElementById('phAgents').getAttribute('aria-label'))) === 'Agents', 'phone: the people button, strip hidden by default', p.chips);
  ok(p.layerVis === 'hidden' && p.layerX >= 389, 'phone: no layer on screen at home', p);
  /* PHONE (Owner 2026-09-27): Enter is a new line; only Send sends */
  await pp.fill('#input', 'phone line');
  await pp.press('#input', 'Enter');
  await sleep(800);
  const val = await pp.inputValue('#input');
  const chats0 = (await call(`/api/rooms/${R}/line?kind=chat`)).body.entries.filter((e) => e.body.startsWith('phone line')).length;
  ok(val === 'phone line\n' && chats0 === 0, 'phone: Enter inserts a new line and sends nothing', { val, chats0 });
  await pp.type('#input', 'second');
  await pp.click('#sendBtn');
  await sleep(1200);
  const chats1 = (await call(`/api/rooms/${R}/line?kind=chat`)).body.entries.map((e) => e.body);
  ok(chats1.includes('phone line\nsecond'), 'phone: the Send button sends both lines as one message', chats1.slice(-2));
  /* the line's filter on the phone: header button → sheet → a dot (no bar, Owner 2026-09-28) */
  await pp.click('#phFilter');
  await sleep(300);
  const frows = await pp.evaluate(() => [...document.querySelectorAll('#phSheet .ph-frow')].map((b) => ({ t: b.textContent, h: Math.round(b.getBoundingClientRect().height) })));
  ok(frows.slice(0, 3).map((r) => r.t).join(',') === 'Everyone,To me,Between agents' && frows.every((r) => r.h >= 56), 'phone: Filter opens a sheet: Everyone / To me / Between agents / each seat, 56px rows', frows);
  await pp.click('#phSheet .ph-frow[data-who="me"]');
  await sleep(400);
  const fb = await pp.evaluate(() => ({ bar: !!document.getElementById('phFilterBar'), dot: !document.getElementById('phFilterDot').hidden, sheet: !document.getElementById('phSheet').hidden,
    shown: [...document.querySelectorAll('#line .entry')].filter((li) => getComputedStyle(li).display !== 'none').map((li) => li.querySelector('.entry-body').textContent) }));
  ok(!fb.sheet && !fb.bar && fb.dot && fb.shown.includes('lead to you') && !fb.shown.includes('@sleeper agents only'), 'phone: "To me" filters the line and dots the button, with no bar over the line', fb);
  await pp.click('#phFilter');
  await sleep(300);
  await pp.click('#phSheet .ph-frow[data-who=""]');
  await sleep(300);
  ok(await pp.evaluate(() => document.getElementById('phFilterDot').hidden), 'phone: Everyone clears it');
  /* Agents sheet → pick → layer */
  await pp.click('#phAgents');
  await sleep(300);
  p = await ph();
  const sheetRows = await pp.evaluate(() => [...document.querySelectorAll('#phSheet .seat')].map((li) => ({ h: Math.round(li.getBoundingClientRect().height), id: li.dataset.handle })));
  ok(p.sheet && sheetRows.filter((r) => r.id).length === 3 && sheetRows.every((r) => r.h >= 56), 'phone: Agents opens a sheet of the seats (plus the Room row on top), 56px rows', sheetRows);
  const addPlus = await pp.evaluate(() => { const b = document.querySelector('#phSheet h3 .cell-hadd'); const r = b?.getBoundingClientRect(); return b && { name: b.getAttribute('aria-label'), w: Math.round(r.width), h: Math.round(r.height), row: !!document.querySelector('#phSheet .rm-add') }; });
  ok(addPlus && /^Add (member|a workgroup or an app)$/.test(addPlus.name) && addPlus.w >= 44 && addPlus.h >= 44 && !addPlus.row, '...with a compact "+" (Add member, 44px) in its title, no full-width row (Owner, room line [ref])', addPlus);
  await pp.click('#phSheet .seat[data-handle="awake"] .seat-handle');
  await sleep(1500);
  p = await ph();
  ok(!p.sheet && p.inLayer && p.layerX === 0 && p.layerW === 390 && p.title === '@awake', 'phone: a pick closes the sheet and slides @awake in full screen', p);
  const lg = await pp.evaluate(() => { const r = document.querySelector('#lyGlyph .seat-ring')?.getBoundingClientRect(); return r ? Math.round(r.width) : 0; });
  ok(lg === 28, '...its header wears the agent\'s glyph (28px), as the row did', lg);
  const rc = await pp.evaluate(() => { const b = document.getElementById('reconnectBtn'); const r = b.getBoundingClientRect(); const c = document.getElementById('compose').getBoundingClientRect(); return { shown: !b.hidden, h: Math.round(r.height), w: Math.round(r.width), clear: r.bottom <= c.top }; });
  ok(!rc.shown || rc.clear, 'phone: Reconnect (when offered) is clear of the composer; it lives in the Agents sheet', rc);
  ok(p.seatFrame.length === 1 && /inroom=1/.test(p.seatFrame[0]), '...its solo page as-is', p.seatFrame);
  ok(!p.overflow, '...no sideways scroll at 390', p.overflow);
  /* ‹ Line */
  await pp.click('#lyBack');
  await sleep(400);
  p = await ph();
  ok(!p.inLayer && p.layerVis === 'hidden', 'phone: ‹ Line goes home', p);
  /* the menu: one tap to an agent */
  await pp.click('#phAgents');
  await pp.click('#phSheetBody li.seat:has-text("@sleeper")');
  await sleep(600);
  p = await ph();
  ok(p.inLayer && p.title === '@sleeper' && p.seatFrame.length === 0, 'phone: a chip opens that agent; a restorable one shows its panel (no auto-launch)', p);
  /* ⇄ Switch: Line, Apps, Agents in one sheet */
  await pp.click('#lySwitch');
  await sleep(300);
  const sw = await pp.evaluate(() => [...document.querySelectorAll('#phSheet h3')].map((h) => h.textContent));
  ok(sw.join(',') === 'Switch to,Apps,Agents,Filter the chat' && await pp.evaluate(() => document.querySelector('#phSheet .seat.sel')?.dataset.handle === 'sleeper'), '⇄ Switch lists the line, the apps, the agents (the current one selected) and ends with the filter (auriga)', sw);
  await pp.click('#phSheet .seat[data-handle="awake"] .seat-handle');
  await sleep(600);
  p = await ph();
  ok(p.inLayer && p.title === '@awake', '...and goes straight to another agent (two taps)', p.title);
  /* swipe from the left edge = back */
  await pp.evaluate(() => {
    const e = document.getElementById('lyEdge');
    const t = (x) => new Touch({ identifier: 1, target: e, clientX: x, clientY: 400 });
    e.dispatchEvent(new TouchEvent('touchstart', { touches: [t(4)], bubbles: true }));
    e.dispatchEvent(new TouchEvent('touchmove', { touches: [t(120)], bubbles: true }));
    e.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }));
  });
  await sleep(400);
  ok(!(await ph()).inLayer, 'phone: a swipe from the left edge goes back to the line');
  await pp.screenshot({ path: join(tmpdir(), 'room-phone-home.png') });
  ok(perr.length === 0, 'no page errors on the phone', perr.slice(0, 3));
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
