/* ASSEMBLE ROOM — the Seat modal, S1 (the design notes §3); since
 * the design system room-add-sheet-v1 the room's + SHEET in NEW-room mode (the room's
 * name above the Agents | Apps tabs; one "Add N" / "Create room · add N").
 *
 *   node test/assemble-modal.probe.mjs
 *
 * The engine half (§4.1 readiness, §4.2 assemble) is nuc1's S0 and is not on
 * this branch yet, so those two routes are STUBBED in flight with the spec's
 * exact shapes; everything else (pages, rooms, login, the shell) is the real
 * scratch engine. When S0 lands, the stubs go and this probe runs against the
 * engine.
 *
 * What it proves:
 *   - entry points: Manager (standalone and in a shell frame, pre-checking
 *     THIS window's tabs), the shell status menu, Room › Add member (room
 *     fixed; the A2 form is CUT)
 *   - rows: eligible list sorted window-tabs first; limit text; the
 *     `N can't join ▸` footer with the spec's reason words
 *   - dry-run on change: engine-derived handles, `name me` on an
 *     auto-numbered one; Add disabled while in flight
 *   - lead (Options ▸) default + B5 on that row's glyph; opening message prefill
 *   - Add: one key per open reused across a 409 skip-retry ("also: skips
 *     1"); close → the room opens
 *   - Esc closes; a backdrop click does NOT
 *   - hwbOpenTab focuses an already-open session instead of framing it twice
 *   - phone: full-screen sheet, 44px targets, no sideways scroll
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(88), DEAD broker P(89),
 * temp table; childEnv() scrubbed, fabric + NATS off; never Owner's data.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(88);
const DEAD_BROKER_PORT = P(89);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-assemble-token';

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hdr = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
/* a room write as the USER takes a person: the window cookie, no bearer [ticket] */
let cookieP = null;
const userHdr = async () => ({ cookie: await (cookieP ??= windowCookie(BASE, TOKEN)), 'content-type': 'application/json' });

/* ---- the stubbed engine half: readiness (§4.1) + assemble (§4.2) ---- */
const pane = (paneid, title, extra = {}) => ({
  paneid, recipe_id: paneid.replace(/^recipe:/, '').replace(/#.*/, ''), title, project: title, vendor: 'claude-code',
  host: 'homebase', state: 'live', attached: true, delivery: 'typed', draft: 'clean', claudeRunning: true,
  activity: 'idle', seats: [], seat: { eligible: true }, ...extra,
});
const PANES = [
  pane('recipe:rec-alpha', 'Alpha'),
  pane('recipe:rec-alpha#b2', 'Alpha', { attached: false }),
  pane('recipe:rec-codex', 'Codex helper', { vendor: 'codex-cli', delivery: 'badge' }),
  pane('recipe:rec-draft', 'Blind spot', { draft: 'unobserved' }),
  pane('recipe:rec-noclaude', 'Bashy', { claudeRunning: false, seats: [{ roomId: 'r-other', roomName: 'Other room', seatId: 's1', handle: 'bashy' }] }),
  pane('recipe:rec-refuse', 'Refuse Me'),
  pane('pty:shell-1', 'bash', { vendor: 'cli-manager', seat: { eligible: false, reason: 'shell' } }),
  pane('adopted:x', 'adopted', { seat: { eligible: false, reason: 'no-recipe' } }),
  pane('recipe:rec-old', 'Old one', { state: 'dehydrated', seat: { eligible: false, reason: 'restorable-later' } }),
];
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const calls = [];
async function stubAssemble(route) {
  const b = JSON.parse(route.request().postData() || '{}');
  calls.push(b);
  const used = new Set();
  const results = b.seats.map((s) => {
    const p = PANES.find((x) => x.paneid === s.occupant);
    let h = s.handle || slug(p.title);
    let autoSuffixed = false;
    if (!s.handle && used.has(h)) { let n = 2; while (used.has(`${h}${n}`)) { n++; } h = `${h}${n}`; autoSuffixed = true; }
    if (s.handle === 'taken') { return { paneid: s.occupant, outcome: 'refused', reason: 'handle-taken', handle: h }; }
    used.add(h);
    if (!b.dryRun && s.occupant === 'recipe:rec-refuse') { return { paneid: s.occupant, outcome: 'refused', reason: 'session-open-elsewhere', handle: h }; }
    return { paneid: s.occupant, outcome: b.dryRun ? 'would-seat' : 'seated', seatId: `seat-${h}`, handle: h, autoSuffixed };
  });
  const refused = results.filter((r) => r.outcome === 'refused');
  if (refused.length) {
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'refused', field: 'seats', results }) });
  }
  if (b.dryRun) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ room: {}, seats: [], entries: [], results, replayed: false }) });
  }
  /* the real call: make a REAL room so the page can open it */
  let room;
  if (b.room.name) {
    room = await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: await userHdr(), body: JSON.stringify({ name: b.room.name }) })).json();
    room = room?.room?.id ? room.room : room;
  } else {
    room = (await (await fetch(`${BASE}/api/rooms/${b.room.id}`, { headers: hdr })).json()).room;
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ room, seats: [], entries: [], results, replayed: false }) });
}
async function stubAll(ctx) {
  await ctx.route('**/api/sessions/readiness*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ generatedAt: Date.now(), panes: PANES }) }));
  await ctx.route('**/api/rooms/assemble', stubAssemble);
}

try {
  const stale = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
  if (stale.ok) {
    console.log(` FAIL  :${PORT} is already serving something — a leaked engine from an aborted run?`);
    process.exit(1);
  }
} catch { /* nothing there */ }
for (const p of [PORT, DEAD_BROKER_PORT]) {
  await assertFree(p, 'assemble-modal.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-assemble-'));
let engine = null;
let browser = null;
let engineLog = '';

try {
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'),
      HARBOR_WB_TOKEN: TOKEN, HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'), HARBOR_WB_IDENTITY: 'legacy',
      HARBOR_WB_NO_WINDOW: '1', HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT), HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
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

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  /* WINDOW_CHROME_DIR=/srv/code/auriga/dist/window-chrome proves a newer
     chrome before the pin moves (v31: .hwb-lift): its files are served in
     place of the pinned /aurora/window-chrome/*. */
  const CHROME = process.env.WINDOW_CHROME_DIR;
  if (CHROME) {
    await context.route(/\/aurora\/window-chrome\/([^?]+)/, (route) => {
      const f = join(CHROME, new URL(route.request().url()).pathname.split('/window-chrome/')[1]);
      return existsSync(f)
        ? route.fulfill({ status: 200, contentType: f.endsWith('.css') ? 'text/css' : 'text/javascript', body: readFileSync(f) })
        : route.continue();
    });
  }
  await stubAll(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    const f = document.querySelector('form');
    (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
  }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);

  /* (since the design system room-add-sheet-v1 the Assemble modal IS the room's + sheet in
     NEW-room mode: the rows are LIVE TABS checklist rows, the action is "Add N") */
  const rows = (fr) => fr.evaluate(() => [...document.querySelectorAll('.ras-pane')].map((r) => ({
    paneid: r.dataset.paneid, on: r.getAttribute('aria-checked') === 'true', name: r.querySelector('.nm .a')?.textContent,
    h: r.querySelector('.ras-hdl')?.textContent || '', meta: r.querySelector('.nm .c')?.textContent || '',
    primary: !!r.querySelector('.ras-glyph.is-primary, .ras-glyph .is-primary') || r.querySelector('.ras-glyph')?.classList.contains('is-primary'),
    plateOnly: r.querySelector('.ras-glyph')?.dataset.state === 'none', height: Math.round(r.getBoundingClientRect().height),
    hdl: r.querySelector('.ras-hdl')?.textContent || '',
  })));
  const seatBtn = (fr) => fr.evaluate(() => { const b = document.querySelector('.ras-go'); return { text: b?.textContent, disabled: b?.disabled }; });
  const alsoOf = (fr) => fr.evaluate(() => { const a = document.querySelector('.ras-also'); return a && !a.hidden ? a.textContent : ''; });

  /* ============ 1. MANAGER, standalone ============ */
  console.log('\n--- Manager (standalone) ---');
  await page.goto(`${BASE}/manager.html`, { waitUntil: 'domcontentloaded' });
  await sleep(900);
  await page.click('#roomNewCard'); // Assemble is the New-room sheet's second path
  await page.click('#assembleBtn');
  await page.waitForSelector('.ras-pane', { timeout: 5000 });
  let r = await rows(page);
  ok(r.length === 6 && r.every((x) => !x.on), 'eligible rows listed, none pre-checked standalone', r.map((x) => x.paneid));
  const head = await page.evaluate(() => ({ t: document.querySelector('.ras-sh .t')?.textContent, name: !!document.querySelector('.ras-room .ras-name input'), liveN: document.querySelector('.ras-sec .c')?.textContent }));
  ok(head.t === 'New room' && head.name && head.liveN === '6', 'a NEW room: the same sheet with the room\'s name above the tabs; LIVE TABS 6', head);
  const metaOf = (id) => r.find((x) => x.paneid === id)?.meta || '';
  ok(metaOf('recipe:rec-codex').includes('gets a badge only'), 'limit text: a non-claude brand "gets a badge only"', metaOf('recipe:rec-codex'));
  ok(metaOf('recipe:rec-draft').includes("can't see its input box"), 'limit text: "can\'t see its input box"', metaOf('recipe:rec-draft'));
  ok(metaOf('recipe:rec-noclaude').includes("claude isn't running in it") && metaOf('recipe:rec-noclaude').includes('in Other room'),
    'limit text: "claude isn\'t running in it" + "in Other room"', metaOf('recipe:rec-noclaude'));
  const cj = await page.textContent('.ras-cant > button');
  ok(cj.trim() === "Can't join (3) ▸", 'ineligible rows collapse into "Can\'t join (3) ▸"', cj);
  await page.click('.ras-cant > button');
  const cjl = await page.$$eval('.ras-cant li', (ls) => ls.map((l) => l.textContent));
  ok(cjl.some((t) => t.endsWith('terminal · not addressable')) && cjl.some((t) => t.endsWith("not a saved project: can't join yet"))
    && cjl.some((t) => t.endsWith('restorable: Restore it first, then seat it')), '...expanding lists each with the spec\'s reason words', cjl);

  /* FAIL-1: handles derive BEFORE the room is named; Add says why it waits */
  await page.click('.ras-pane[data-paneid="recipe:rec-noclaude"] .nm');
  await sleep(900);
  const unnamed = await page.evaluate(() => ({
    h: document.querySelector('.ras-pane[aria-checked="true"] .ras-hdl')?.textContent,
    why: document.querySelector('.ras-why')?.textContent, whyShown: !document.querySelector('.ras-why')?.hidden,
    seat: document.querySelector('.ras-go')?.disabled,
  }));
  ok(unnamed.h === '@bashy' && unnamed.seat && unnamed.whyShown && unnamed.why === 'name the room',
    'an unnamed room still dry-runs (handle shown); Add is disabled and says "name the room"', unnamed);
  const plate = await page.$eval('.ras-pane[data-paneid="recipe:rec-noclaude"] .ras-glyph', (g) => g.dataset.state);
  ok(plate === 'none', 'a row whose claude is not running is plate-only (NOTE-1)', plate);
  await page.click('.ras-pane[data-paneid="recipe:rec-noclaude"] .nm');

  /* select two Alphas → dry-run derives @alpha + @alpha2 (auto-suffixed) */
  await page.fill('.ras-room .ras-name input', 'Probe Room');
  await page.click('.ras-pane[data-paneid="recipe:rec-alpha"] .nm');
  await page.click('.ras-pane[data-paneid="recipe:rec-alpha#b2"] .nm');
  const busyNow = await seatBtn(page);
  ok(busyNow.disabled === true, 'Add is disabled while the dry-run is in flight', busyNow);
  await sleep(900);
  r = await rows(page);
  const a1 = r.find((x) => x.paneid === 'recipe:rec-alpha');
  const a2 = r.find((x) => x.paneid === 'recipe:rec-alpha#b2');
  ok(a1.hdl === '@alpha' && a2.hdl === '@alpha2', 'the dry-run\'s derived handles show on the ticked rows', [a1.hdl, a2.hdl]);
  ok(await page.$('.ras-pane[data-paneid="recipe:rec-alpha#b2"] .seat-nudge') && !(await page.$('.ras-pane[data-paneid="recipe:rec-alpha"] .seat-nudge')), 'the auto-numbered one offers "name me"');
  const lastDry = calls.filter((c) => c.dryRun).pop();
  ok(lastDry && lastDry.room.name === 'Probe Room' && lastDry.seats.length === 2 && !lastDry.seats[0].handle, 'the dry-run sends the room + seats, no handle until one is typed', lastDry);
  ok(a1.primary && !a2.primary, 'the default lead (first checked persistent row) wears B5 on its glyph', { a1: a1.primary, a2: a2.primary });
  const look = await page.$eval('.ras-pane[data-paneid="recipe:rec-alpha"]', (r) => {
    const cs = getComputedStyle(r);
    const off = document.querySelector('.ras-pane:not(.is-sel)');
    return { left: cs.borderLeftWidth, top: cs.borderTopWidth, right: cs.borderRightWidth, edge: cs.borderTopColor, bg: cs.backgroundColor,
      offBg: off ? getComputedStyle(off).backgroundColor : null, radius: cs.borderTopLeftRadius, outline: cs.outlineStyle, cls: r.className, aria: r.getAttribute('aria-checked') };
  });
  ok(/\bhwb-lift\b/.test(look.cls) && /\bis-sel\b/.test(look.cls) && look.aria === 'true', 'a ticked row is .hwb-lift.is-sel, aria-checked', look);
  ok(look.left === '1px' && look.top === '1px' && look.right === '1px' && look.bg !== look.offBg && !/0\)$/.test(look.bg),
    '...LIFTED: a 1px hairline all round, its own ground; no 3px spine', look);
  ok(look.outline === 'none', '...and a MOUSE click draws no focus ring (keyboard only)', look.outline);
  let sb = await seatBtn(page);
  ok(sb.text === 'Create room · add 2' && !sb.disabled, '"Create room · add 2", enabled once the dry-run answers', sb);

  /* opening message (Options ▸) */
  await page.click('.ras-opt');
  await page.click('[data-fid="msgtoggle"]');
  const msg = await page.inputValue('.ras-msg textarea');
  ok(msg.startsWith('You\'re in room "Probe Room" with @alpha, @alpha2. @alpha leads'), 'opening message pre-fills room, handles and lead', msg.slice(0, 80));
  ok(/an opening message/.test(await alsoOf(page)), 'the footer says the message goes too', await alsoOf(page));

  /* a refused row on the REAL call: 409 → skip → retry with the SAME key */
  await page.click('.ras-pane[data-paneid="recipe:rec-refuse"] .nm');
  await sleep(900);
  await page.click('.ras-go');
  await sleep(900);
  sb = await seatBtn(page);
  ok(sb.text === 'Create room · add 2' && /skips 1/.test(await alsoOf(page)), 'a 409 marks the refused row: "Create room · add 2", also: skips 1', { sb, also: await alsoOf(page) });
  const refMeta = (await rows(page)).find((x) => x.paneid === 'recipe:rec-refuse')?.meta || '';
  ok(refMeta.includes('same conversation is open in another pane'), '...with the reason on the row', refMeta);
  const errText = await page.evaluate(() => { const e = document.querySelector('.ras-ft .ras-err'); return { t: e.textContent, c: getComputedStyle(e).color, body: getComputedStyle(document.body).color }; });
  ok(errText.t === "Refuse Me can't be seated: same conversation is open in another pane. Add 2 skips it.", 'the 409 is said plainly (NOTE-4)', errText.t);
  const [popup] = await Promise.all([
    page.context().waitForEvent('page', { timeout: 6000 }).catch(() => null),
    page.click('.ras-go'),
  ]);
  const reals = calls.filter((c) => !c.dryRun);
  ok(reals.length === 2 && reals[0].key === reals[1].key && reals[0].key.length <= 64, 'both real calls reuse the sheet\'s ONE key (≤64)', reals.map((c) => c.key));
  ok(reals[1].seats.map((s) => s.occupant).join(',') === 'recipe:rec-alpha,recipe:rec-alpha#b2', '...and the retry skips the refused row', reals[1].seats.map((s) => s.occupant));
  ok(/^@room You're in room "Probe Room"/.test(reals[1].conventions || ''), 'a NEW room\'s opening message addresses @room', (reals[1].conventions || '').slice(0, 40));
  ok(!(await page.$('.ras-scrim')), 'a committed Add closes the sheet');
  ok(!!popup && /\/room\.html\?room=/.test(popup.url()), '...and opens the room', popup?.url());
  if (popup) { await popup.close(); }

  /* Esc closes; a backdrop click does not */
  await page.click('#roomNewCard'); // Assemble is the New-room sheet's second path
  await page.click('#assembleBtn');
  await page.waitForSelector('.ras-pane');
  await page.mouse.click(8, 8); // the scrim, outside the box
  await sleep(200);
  ok(!!(await page.$('.ras-scrim')), 'a backdrop click does NOT close it (a stray tap keeps the selection)');
  await page.keyboard.press('Escape');
  await sleep(200);
  ok(!(await page.$('.ras-scrim')), 'Esc closes it');

  /* ============ 2. IN THE SHELL: this window's tabs pre-checked ============ */
  console.log('\n--- Manager in a shell frame + status menu ---');
  const TA = '/solo.html?recipe=rec-alpha';
  const TB = '/solo.html?recipe=rec-draft';
  await page.goto(`${BASE}/app/shell.html?kind=manager&debug=1&tabs=${['/manager.html', TA, TB].map(encodeURIComponent).join(',')}`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  await page.evaluate(() => document.querySelector('.hwb-tab.is-hub')?.click());
  await sleep(500);
  let mf = page.frames().find((f) => /\/manager\.html/.test(f.url()));
  await mf.click('#roomNewCard'); // Assemble is the New-room sheet's second path
  await mf.click('#assembleBtn');
  await mf.waitForSelector('.ras-pane', { timeout: 5000 });
  await sleep(900);
  r = await rows(mf);
  ok(r.filter((x) => x.on).map((x) => x.paneid).sort().join(',') === 'recipe:rec-alpha,recipe:rec-draft', 'in a shell frame, THIS window\'s session tabs are pre-checked', r.filter((x) => x.on).map((x) => x.paneid));
  ok(r[0].paneid === 'recipe:rec-alpha' || r[0].paneid === 'recipe:rec-draft', '...and sort first', r.slice(0, 2).map((x) => x.paneid));
  const sh = await mf.textContent('[data-fid="wintabs"]');
  ok(/this window's tabs ✓/.test(sh), 'LIVE TABS offers "this window\'s tabs ✓"', sh);
  await page.keyboard.press('Escape');
  await sleep(300);

  /* status menu → the hub's sheet, pre-checked */
  await page.evaluate(() => document.querySelector('.hwb-act')?.click());
  await sleep(300);
  const items = await page.$$eval('.hwb-actmenu-item', (bs) => bs.map((b) => b.textContent));
  ok(items.includes("Assemble room from this window's tabs…"), 'the status menu offers "Assemble room from this window\'s tabs…"', items);
  await page.evaluate(() => [...document.querySelectorAll('.hwb-actmenu-item')].find((b) => /^Assemble room/.test(b.textContent))?.click());
  mf = page.frames().find((f) => /\/manager\.html/.test(f.url()));
  await mf.waitForSelector('.ras-pane', { timeout: 5000 });
  await sleep(600);
  r = await rows(mf);
  ok(r.filter((x) => x.on).length === 2, '...which opens the hub\'s sheet with this window\'s tabs checked', r.filter((x) => x.on).map((x) => x.paneid));
  await page.keyboard.press('Escape');

  /* hwbOpenTab for a session already open here → focus, not a second frame */
  const before = await page.evaluate(() => document.querySelectorAll('#stage iframe').length);
  await mf.evaluate((u) => window.parent.postMessage({ hwbOpenTab: { url: u } }, '*'), TA);
  await sleep(700);
  const after = await page.evaluate(() => ({
    n: document.querySelectorAll('#stage iframe').length,
    shown: [...document.querySelectorAll('#stage iframe')].filter((f) => getComputedStyle(f).display !== 'none').map((f) => f.getAttribute('src')),
  }));
  ok(after.n === before && after.shown.length === 1 && after.shown[0].includes('recipe=rec-alpha'), 'opening a session already open here FOCUSES that tab (matched by its pane), no second frame', { before, after });

  /* ============ 3. ROOM › +: room fixed; the A2 form is cut ============ */
  console.log('\n--- Room › + ---');
  const rm = await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: await userHdr(), body: JSON.stringify({ name: 'Fixed Room' }) })).json();
  const RID = rm?.room?.id || rm.id;
  await page.goto(`${BASE}/room.html?room=${RID}`, { waitUntil: 'domcontentloaded' });
  await sleep(1200);
  await page.click('#addBtn');
  await page.waitForSelector('.ras-pane', { timeout: 5000 });
  const title = await page.textContent('.ras-sh .t');
  ok(title === 'Add to Fixed Room', 'the + opens the sheet with THIS room fixed', title);
  ok(!(await page.$('.ras-room')), '...no room chooser');
  await page.click('.ras-pane[data-paneid="recipe:rec-alpha"] .nm');
  await sleep(900);
  await page.click('.ras-opt');
  const lead = await page.$eval('.ras-lead select', (s) => [...s.options].map((o) => o.textContent));
  ok(lead[0].startsWith('keep'), 'an existing room\'s lead defaults to "keep …"', lead);
  const fixedDry = calls.filter((c) => c.dryRun).pop();
  ok(fixedDry.room.id === RID && !('lead' in fixedDry), '...and "keep" sends no lead', fixedDry);
  ok(!(await page.evaluate(() => [...document.querySelectorAll('.ras-sheet button')].some((b) => /isn't running/.test(b.textContent)))) && !(await page.$('#addForm')),
    'CUT: no "A project that isn\'t running ▸" link and no A2 form (a project is a START FROM A PROJECT row)');

  ok(errors.length === 0, 'no page errors', errors.slice(0, 3));

  /* ============ 4. PHONE ============ */
  console.log('\n--- phone ---');
  const ph = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await context.storageState() });
  await stubAll(ph);
  const pp = await ph.newPage();
  await pp.goto(`${BASE}/manager.html`, { waitUntil: 'domcontentloaded' });
  await sleep(900);
  await pp.click('#roomNewCard'); // Assemble is the New-room sheet's second path
  await pp.click('#assembleBtn');
  await pp.waitForSelector('.ras-pane');
  await pp.fill('.ras-room .ras-name input', 'Phone Room');
  await pp.click('.ras-pane[data-paneid="recipe:rec-alpha"] .nm');
  await pp.click('.ras-pane[data-paneid="recipe:rec-alpha#b2"] .nm');
  await sleep(900);
  const m = await pp.evaluate(() => {
    const b = document.querySelector('.ras-sheet').getBoundingClientRect();
    return {
      box: [Math.round(b.width), Math.round(b.height)], vw: innerWidth, vh: innerHeight, sw: document.documentElement.scrollWidth,
      rowsH: [...document.querySelectorAll('.ras-pane')].map((r) => Math.round(r.getBoundingClientRect().height)),
      inputs: [...document.querySelectorAll('.ras-pane .ras-fld input')].length,
      nudge: !!document.querySelector('.seat-nudge'),
      seatH: Math.round(document.querySelector('.ras-go').getBoundingClientRect().height),
    };
  });
  ok(m.box[0] === m.vw && m.box[1] === m.vh && m.sw <= m.vw, 'phone: a full-screen sheet with no sideways scroll', m);
  const fit = await pp.evaluate(() => [...document.querySelectorAll('.ras-pane')].every((r) => {
    const b = r.getBoundingClientRect().bottom + 0.5;
    return [...r.querySelectorAll('*')].every((k) => k.getBoundingClientRect().bottom <= b);
  }));
  ok(fit, 'phone: every row\'s content sits inside its card (FAIL-2)');
  const scrollers = await pp.evaluate(() => ({ body: getComputedStyle(document.querySelector('.ras-body')).overflowY, sheet: getComputedStyle(document.querySelector('.ras-sheet')).overflowY }));
  ok(scrollers.body === 'auto' && scrollers.sheet === 'hidden', 'ONE scroller: the sheet\'s body (NOTE-3)', scrollers);
  const segs = await pp.$$eval('.ras-mode button', (bs) => bs.map((b) => [b.textContent, b.getAttribute('aria-pressed'), Math.round(b.getBoundingClientRect().height)]));
  ok(segs.length === 2 && segs[0][0] === 'New room' && segs[0][1] === 'true' && segs[1][0] === 'Existing room' && segs.every((x) => x[2] >= 44) && !(await pp.$('input[type=radio]')),
    'the room choice is a segmented [New room | Existing room] (44px on a phone), no native radios (FAIL-4)', segs);
  ok(m.rowsH.every((h) => h >= 44) && m.seatH >= 44, 'phone: rows and Add are ≥44px targets', { rows: m.rowsH, seat: m.seatH });
  ok(m.inputs === 0 && m.nudge, 'phone: handles read as text; "name me" is the edit affordance', m);
  await pp.click('.seat-nudge');
  ok(await pp.$eval('.ras-pane .ras-fld input', (i) => document.activeElement === i), '...tapping it opens that handle for editing');
  await ph.close();
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
