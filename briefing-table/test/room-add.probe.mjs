/* ADD A MEMBER + THE QUIET DELIVERY NOTE — room front-end order item 2
 * (2026-09-25, workrooms.md §2.10 handover to cli-manager).
 *
 *   node test/room-add.probe.mjs
 *
 * The roster's STATUS rendering is room-roster.probe.mjs's (97 checks). This
 * probe covers what item 2 added (the add half now runs through the room's
 * + sheet, the design system room-add-sheet-v1; the A2 form and add-without-start are
 * cut):
 *   - the + lists every live session (LIVE TABS) and every saved project
 *   - a live session is bound (nothing launched), several of one project are
 *     each their own row; a project is added AND started
 *   - the first PERSISTENT seat becomes lead (a fresh one does not), and the
 *     roster's lead badge follows
 *   - a taken handle is refused on its row; the sheet stays open
 *   - after a send, one dim line says what happened to each recipient's copy
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(56), DEAD broker P(57),
 * temp table seeded through the store (test/rooms-routes.seed.ts): no pty, no
 * broker, never Owner's data, childEnv() scrubbed, fabric + NATS off.
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
const PORT = P(56);
const DEAD_BROKER_PORT = P(57);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-add-token';

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

/** The roster as RENDERED. */
const readRoster = (p) => p.evaluate(() => [...document.querySelectorAll('#roster .seat:not(.is-room)')].map((li) => ({
  handle: li.dataset.handle,
  status: li.querySelector('.seat-status')?.textContent,
  lead: !!li.querySelector('.seat-lead') && getComputedStyle(li.querySelector('.seat-lead')).display !== 'none',
})));

try {
  const stale = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
  if (stale.ok) {
    console.log(` FAIL  :${PORT} is already serving something — a leaked engine from an aborted run?`);
    process.exit(1);
  }
} catch { /* nothing there */ }
for (const p of [PORT, DEAD_BROKER_PORT]) {
  await assertFree(p, 'room-add.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-add-'));
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
  const recipe = (id, name, dir, vendor, agent) => ({ id, name, projectDir: dir, vendor, agent });
  const pre = await seed({
    recipes: [
      recipe('rec-auriga', 'Auriga', '/srv/x/auriga', 'claude-code', 'auriga'),
      recipe('rec-barn', 'Kiosk', '/srv/x/kiosk', 'claude-code', 'kiosk'),
      recipe('rec-scout', 'Scout', '/srv/x/scout', 'claude-code', 'scout'),
    ],
    rooms: [{ name: 'Add Probe', seats: [] }],
  });
  const R = pre.rooms[0].id;

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

  /* LIVE rows after boot (boot reconcile sweeps `live`): the design system x1, Kiosk x2, Scout none. */
  const A1 = 'recipe:rec-auriga#1';
  const B1 = 'recipe:rec-barn#1';
  const B2 = 'recipe:rec-barn#2';
  await seed({
    sessions: [
      { paneid: A1, recipe_id: 'rec-auriga', vendor: 'claude-code', agent: 'auriga', state: 'live' },
      { paneid: B1, recipe_id: 'rec-barn', vendor: 'claude-code', agent: 'kiosk', state: 'live' },
      { paneid: B2, recipe_id: 'rec-barn', vendor: 'claude-code', agent: 'kiosk', state: 'live' },
    ],
  });

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    const f = document.querySelector('form');
    (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
  }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  await page.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
  await sleep(1200);

  /* ADD, since the design system room-add-sheet-v1: the A2 form is CUT. A project that
     isn't running is a START FROM A PROJECT row (added AND started); a live
     session is a LIVE TABS row (seated, bound: nothing launched); a pane of a
     project with several live ones is simply its own row. */
  const openSheet = async (p = page) => {
    await p.click('#addBtn');
    await p.waitForSelector('.ras-sheet [role="tab"]', { timeout: 5000 });
    await sleep(250);
  };
  const goBtn = (p = page) => p.evaluate(() => { const b = document.querySelector('.ras-go'); return b && { text: b.textContent, disabled: b.disabled }; });

  /* 1. the sheet and its two lists */
  ok(await page.isVisible('#addBtn'), 'an empty room shows "Add member" (+)');
  await openSheet();
  const lists = await page.evaluate(() => ({
    panes: [...document.querySelectorAll('.ras-pane')].map((r) => r.dataset.paneid).sort(),
    recs: [...document.querySelectorAll('.ras-proj')].map((r) => r.dataset.recipe),
  }));
  ok(JSON.stringify(lists.panes) === JSON.stringify([A1, B1, B2].sort()), 'LIVE TABS lists every live session (both Kiosk panes on their own rows)', lists.panes);
  ok(lists.recs.join() === 'rec-auriga,rec-barn,rec-scout', 'START FROM A PROJECT lists every saved project', lists.recs);

  /* 2. A PROJECT, fresh: added AND started; a FRESH seat does not become lead */
  await page.click('.ras-proj[data-recipe="rec-scout"] .nm');
  await page.fill('.ras-proj[data-recipe="rec-scout"] .ras-fld input', '@scout');
  await page.check('.ras-proj[data-recipe="rec-scout"] .ras-fresh input'); // "forget between runs (fresh)" (the design system 2026-09-28: the keeps-context select is gone)
  ok(await page.$eval('.ras-proj[data-recipe="rec-scout"] .ras-fld input', (e) => e.value) === 'scout', 'a typed leading @ is dropped as you type');
  await page.click('.ras-go');
  await sleep(1800);
  let roster = await readRoster(page);
  let room = (await call(`/api/rooms/${R}`)).body;
  const sc = room.seats.find((s) => s.handle === 'scout');
  ok(roster.length === 1 && roster[0].handle === 'scout' && sc?.policy === 'fresh' && sc?.occupant?.id?.startsWith('recipe:rec-scout#'),
    'Scout is seated as @scout (fresh) and STARTED on a fresh pane', { roster, occ: sc?.occupant?.id, policy: sc?.policy });
  ok(!roster[0]?.lead && await page.isVisible('#noLead'), 'a fresh seat is not made lead; the header still says "no lead"');
  ok(!(await page.$('.ras-scrim')) && await page.isVisible('#addBtn'), 'the sheet closes after a successful add');

  /* 3. A LIVE TAB -> bound (nothing launched); the first PERSISTENT seat is lead */
  await openSheet();
  ok(await page.$eval('.ras-proj[data-recipe="rec-scout"]', (r) => r.getAttribute('aria-checked')) === 'false', 're-opened, nothing is ticked (the last add does not linger)');
  await page.click(`.ras-pane[data-paneid="${A1}"] .nm`);
  await sleep(900);
  await page.click('.ras-go');
  await sleep(1200);
  room = (await call(`/api/rooms/${R}`)).body;
  const aur = room.seats.find((s) => s.recipe_id === 'rec-auriga');
  ok(aur && JSON.stringify(aur).includes(A1), 'the live Auriga session is bound to the seat', aur && { handle: aur.handle, occupant: aur.occupant, status: aur.status });
  ok(room.room?.lead_seat === aur?.id, 'engine-side: the first persistent seat is the room lead', { lead_seat: room.room?.lead_seat, auriga: aur?.id, policy: aur?.policy });
  roster = await readRoster(page);
  ok(roster[0]?.handle === aur?.handle && roster[0]?.lead, 'the first persistent seat is lead, listed first, with the badge', roster);
  ok(!(await page.isVisible('#noLead')), '"no lead" is gone');

  /* 4. TWO LIVE of one project: tick the one you mean; a typed handle */
  await openSheet();
  await page.click(`.ras-pane[data-paneid="${B2}"] .nm`);
  await sleep(900);
  await page.click(`.ras-pane[data-paneid="${B2}"] .ras-hdl`);
  await page.fill(`.ras-pane[data-paneid="${B2}"] .ras-fld input`, 'barn');
  await sleep(900);
  await page.click('.ras-go');
  await sleep(1200);
  room = (await call(`/api/rooms/${R}`)).body;
  const barn = room.seats.find((s) => s.handle === 'barn');
  ok(barn && JSON.stringify(barn).includes(B2) && !JSON.stringify(barn).includes(B1), 'the TICKED session (#2) is the one bound, as @barn', barn && barn.occupant);

  /* 5. A TAKEN HANDLE is refused on its row; the sheet stays open */
  await openSheet();
  await page.click(`.ras-pane[data-paneid="${B1}"] .nm`);
  await sleep(900);
  await page.click(`.ras-pane[data-paneid="${B1}"] .ras-hdl`);
  await page.fill(`.ras-pane[data-paneid="${B1}"] .ras-fld input`, 'scout');
  await sleep(1000);
  const dry = await page.evaluate((id) => document.querySelector(`.ras-pane[data-paneid="${id}"] .c .bad`)?.textContent || '', B1);
  ok(dry === 'taken', "the dry-run's refusal lands on the row before Add", dry);
  await page.click('.ras-go');
  await sleep(900);
  const err = await page.evaluate(() => { const e = document.querySelector('.ras-ft .ras-err'); return e && { t: e.textContent, c: getComputedStyle(e).color, body: getComputedStyle(document.body).color }; });
  ok(err && /can't be seated: taken/.test(err.t) && !!(await page.$('.ras-scrim')), "Add: the engine's refusal is said in the footer; the sheet stays open to fix it", err);
  ok(err && err.c !== err.body, 'the refusal is coloured, not body text (computed)', err);
  ok(/skip/.test((await goBtn())?.text || '') || /skips 1/.test(await page.evaluate(() => document.querySelector('.ras-also')?.textContent || '')), '...and Add now says it skips that row', await page.evaluate(() => document.querySelector('.ras-also')?.textContent));
  await page.click('[data-fid="cancel"]');
  roster = await readRoster(page);
  ok(roster.length === 3, 'Cancel adds nothing', roster.map((s) => s.handle));

  /* 6. The line recorded each add as a fact */
  const facts = await page.$$eval('#line [data-kind="fact"]', (els) => els.length).catch(() => -1);
  const factsApi = (await call(`/api/rooms/${R}/line?kind=fact`)).body;
  const nFacts = Array.isArray(factsApi?.entries) ? factsApi.entries.length : Array.isArray(factsApi) ? factsApi.length : -1;
  ok(nFacts >= 3, 'the line holds a fact per add (engine-side)', nFacts);
  ok(facts === -1 || facts >= 3, '...and the page drew them', facts);

  /* 7. THE QUIET DELIVERY NOTE */
  ok(!(await page.isVisible('#delivery')), 'no delivery note before anything is sent');
  /* fill the line past its box, so "pinned at the bottom" means something */
  for (let i = 1; i <= 30; i++) {
    await call(`/api/rooms/${R}/line`, { json: { text: `@scout filler ${i}` } });
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1500);
  const over = await page.evaluate(() => {
    const sc = document.getElementById('lineScroll');
    return { scrolls: sc.scrollHeight > sc.clientHeight + 50, atBottom: sc.scrollHeight - sc.scrollTop - sc.clientHeight < 2 };
  });
  ok(over.scrolls && over.atBottom, 'setup: the line overflows its box and the page opens at the bottom', over);
  await page.fill('#input', 'hello lead');
  await page.click('#sendBtn');
  await sleep(900);
  /* [ticket] the desktop takes the phone's presentation: the text report is
     still WRITTEN (its sentence is each chip's tooltip, and the char-limit note
     shares the element) but no longer SHOWN; the addressed seat's live chip is */
  const note1 = await page.textContent('#delivery');
  const chips1 = await page.evaluate(() => {
    const box = document.getElementById('deliveryChips');
    const h = box.querySelector('.rm-dchip .h');
    return {
      shown: !box.hidden && getComputedStyle(box).display === 'flex',
      text: getComputedStyle(document.getElementById('delivery')).display,
      hs: [...box.querySelectorAll('.rm-dchip .h')].map((x) => x.textContent),
      title: box.querySelector('.rm-dchip')?.title ?? '',
      /* the chip's @handle wears the SAME ink as that seat's handle in the rail
         (its project ink when it has a colour, the text colour when it has none) */
      ink: h ? [getComputedStyle(h).color, (() => {
        const seatId = box.querySelector('.rm-dchip')?.dataset.seat;
        const rh = seatId && document.querySelector(`.seat[data-seat-id="${seatId}"] .seat-handle`);
        return rh ? getComputedStyle(rh).color : null;
      })()] : null,
    };
  });
  ok(note1.startsWith(`→ @${aur?.handle} `) && chips1.shown && chips1.text === 'none' && chips1.hs.includes(`@${aur?.handle}`),
    "un-addressed chat: no text notice on the desktop; the lead's live chip shows instead [ticket]", { note1, chips1 });
  ok(chips1.title.startsWith(`@${aur?.handle}: `), '...with what happened in its tooltip', chips1.title);
  ok(!!chips1.ink && !!chips1.ink[1] && chips1.ink[0] === chips1.ink[1], "...its @handle in the seat's own ink, the same as its rail handle (computed)", chips1.ink);
  await page.fill('#input', '@scout are you there');
  await page.click('#sendBtn');
  await sleep(900);
  const note2 = await page.textContent('#delivery');
  /* item 5 (c): the note takes height from the line; a reader at the bottom
     stays at the bottom, so the newest entry is WHOLE, not cut in half */
  const pin = await page.evaluate(() => {
    const sc = document.getElementById('lineScroll').getBoundingClientRect();
    const last = [...document.querySelectorAll('#line li')].pop().getBoundingClientRect();
    return { lastBottom: Math.round(last.bottom), boxBottom: Math.round(sc.bottom) };
  });
  if (process.env.PIN_DEBUG) {
    console.log('      [dbg] ' + JSON.stringify(await page.evaluate(() => {
      const sc = document.getElementById('lineScroll');
      const cs = getComputedStyle(sc);
      return { top: sc.scrollTop, h: sc.scrollHeight, ch: sc.clientHeight, rectH: Math.round(sc.getBoundingClientRect().height), overflowY: cs.overflowY, minH: cs.minHeight, flex: cs.flex,
        line: Math.round(document.querySelector('.rm-line').getBoundingClientRect().height), main: Math.round(document.getElementById('main').getBoundingClientRect().height), vh: innerHeight };
    })));
  }
  /* and the converse: a reader who scrolled UP is left where they are */
  await page.evaluate(() => { const sc = document.getElementById('lineScroll'); sc.scrollTop = sc.scrollHeight - sc.clientHeight - 400; });
  await sleep(300);
  const upBefore = await page.evaluate(() => document.getElementById('lineScroll').scrollTop);
  await page.fill('#input', '@scout still there?');
  await page.click('#sendBtn');
  await sleep(1500);
  const upAfter = await page.evaluate(() => { const sc = document.getElementById('lineScroll'); return { top: sc.scrollTop, fromBottom: sc.scrollHeight - sc.scrollTop - sc.clientHeight }; });
  ok(Math.abs(upAfter.top - upBefore) <= 2 && upAfter.fromBottom > 300, 'a reader scrolled up is NOT pulled to the bottom by a send', { upBefore, upAfter });
  ok(pin.lastBottom <= pin.boxBottom + 1 && pin.lastBottom > pin.boxBottom - 120,
    'with the delivery note showing, the newest entry is fully in view AT THE BOTTOM (re-pinned)', pin);
  ok(note2 === '→ @scout not live', 'a never-started seat: the note says "not live", replacing the last one', note2);

  ok(pageErrors.length === 0, 'no page errors', pageErrors.slice(0, 3));

  /* 8. PHONE: the sheet fits */
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await context.storageState() });
  const pp = await phone.newPage();
  await pp.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
  await sleep(1000);
  const ph = await pp.evaluate(() => getComputedStyle(document.getElementById('input'), '::placeholder').whiteSpace);
  ok(ph === 'nowrap', 'phone: the input hint stays on one line (not cut through, auriga)', ph);
  await pp.click('#phAgents'); // room-phone v1: Add member ends the Agents sheet
  ok(await pp.evaluate(() => !!document.querySelector('#phSheet:not([hidden]) h3 .cell-hadd[aria-label="Add or move a seat"]')), 'phone: the Agents sheet title carries the "+" (Add or move a seat)');
  await pp.click('#phSheet h3 .cell-hadd[aria-label="Add or move a seat"]');
  await pp.waitForSelector('.ras-proj', { timeout: 5000 });
  await pp.click('.ras-proj[data-recipe="rec-barn"] .nm');
  await sleep(300);
  const m = await pp.evaluate(() => {
    const row = document.querySelector('.ras-proj[data-recipe="rec-barn"]');
    const r = (el) => el.getBoundingClientRect();
    const ctl = [row.querySelector('.ras-fld'), row.querySelector('select'), document.querySelector('.ras-go'), document.querySelector('[data-fid="cancel"]')];
    return {
      scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
      right: Math.max(...ctl.map((c) => r(c).right)),
      h: Math.min(...ctl.map((c) => r(c).height)),
    };
  });
  ok(m.scrollW <= m.innerW && m.right <= m.innerW, 'the open sheet fits 390px with no sideways scroll', m);
  ok(m.h >= 44, 'its controls keep the 44px touch floor', m.h);
  await phone.close();
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
