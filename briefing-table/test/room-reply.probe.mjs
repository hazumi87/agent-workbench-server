/* REPLY TO A LINE (the design system room-reply-v1) + the seat badge, the page's half.
 *
 *   node test/room-reply.probe.mjs
 *
 * What only a browser can prove (desktop 1280x800, then phone 390x844):
 *   - the hover pill on the line's top OUTER corner (right for an agent's
 *     line, left for yours), shown on hover and on focus-within; the ⋯ and a
 *     right-click open the seat-menu component (title @author + time; Reply R ·
 *     Copy text · Copy line link #id); Esc closes and the focus returns;
 *   - Reply puts the quote chip FIRST in the tray, focus in the input: 260x64,
 *     --surface3, a hairline all round, "Replying to @buddy", the excerpt with
 *     its list numbers, the ✕ in the tiles' corner spot; sticky-left while
 *     files scroll past; one at a time; Esc drops it (not while the @-list is
 *     open); the chip's route says "· to @lead" for your own line;
 *   - ↑ from an empty composer steps into the line, ↑ moves, R replies;
 *   - the reply target survives a reload (the server draft);
 *   - Send carries reply_to; the sent line's quote header sits INSIDE the
 *     bubble above the body: full width, 1px --border2 all round (no bar), r6;
 *   - the header jumps: the original centred and flashed with the lift, the
 *     "↓ Back to latest" pill until back down; not loaded: older pages load
 *     (a spinner in the header) until it arrives; gone: "Original not
 *     available", dim italic, not clickable;
 *   - the seat badge is the engine's `waiting` count;
 *   - phone: swipe right reveals the ↩ disc, teal at 56px, release replies (a
 *     swipe from the screen edge does not); a long press opens the menu as a
 *     bottom sheet (48px items, title row); no sideways scroll.
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(181), DEAD broker P(182),
 * temp table seeded through the store: never Owner's data, childEnv() scrubbed,
 * fabric + NATS off.
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
const PORT = P(181);
const DEAD_BROKER_PORT = P(182);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-reply-token';
const DOT = String.fromCharCode(0xb7);

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

let cookieP = null;
const userCookie = () => (cookieP ??= windowCookie(BASE, TOKEN));
async function call(path, opts = {}) {
  const method = opts.method ?? (opts.json !== undefined ? 'POST' : 'GET');
  const headers = roomUserWrite(path, method, opts.json) || opts.user ? { cookie: await userCookie() } : { authorization: `Bearer ${TOKEN}` };
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
  await assertFree(p, 'room-reply.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-reply-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null;
let browser = null;
let engineLog = '';
const seed = async (plan) => {
  const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
  return JSON.parse(r.out.trim().split('\n').pop());
};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const img = (name) => ({ name, mimeType: 'image/png', buffer: PNG });
const doc = (name) => ({ name, mimeType: 'application/pdf', buffer: Buffer.alloc(512, 37) });

try {
  const recipe = (id, name, agent, color) => ({ id, name, projectDir: `/srv/x/${agent}`, vendor: 'claude-code', agent, color });
  await seed({ recipes: [recipe('rec-lead', 'Leader', 'leader', '#1f5fbf'), recipe('rec-buddy', 'Buddy', 'buddy', '#ba08b4')] });
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
      HARBOR_WB_ROOM_SCRATCH_DIR: join(tmpDir, 'scratch'),
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
  const live = (paneid, rid, agent) => ({ paneid, recipe_id: rid, vendor: 'claude-code', agent, state: 'live' });
  const post = await seed({
    sessions: [live(LEAD, 'rec-lead', 'leader'), live(BUDDY, 'rec-buddy', 'buddy')],
    rooms: [{ name: 'Reply Probe', seats: [{ handle: 'leader', recipe_id: 'rec-lead', occupant: LEAD }, { handle: 'buddy', recipe_id: 'rec-buddy', occupant: BUDDY }] }],
  });
  const R = post.rooms[0].id;
  const LINE = `/api/rooms/${R}/line`;

  /* THE LINE: a far original (the list), 60 lines of filler, a reply to it,
     a near original + your own line, then the newest lines */
  const LIST = 'And for the rail itself:\n1. 272 fixed\n2. resizable\n3. collapsible';
  const WANT = `And for the rail itself: 1. 272 fixed ${DOT} 2. resizable ${DOT} 3. collapsible`;
  const far = (await call(LINE, { json: { text: LIST, from: { paneid: BUDDY } } })).body.entries[0];
  for (let i = 0; i < 60; i += 1) {
    await call(LINE, { json: { text: `filler ${i}`, from: { paneid: LEAD } } });
  }
  const farReply = await call(LINE, { json: { text: 'late answer: go with 2)', reply_to: far.id } });
  ok(farReply.status === 200 && farReply.body.entries?.[0]?.target_seat === post.rooms[0].seats.buddy,
    'engine: a reply to @buddy\'s far line routes to @buddy', farReply.body?.entries?.[0]?.target_seat);
  const nearOrig = (await call(LINE, { json: { text: 'Three ways to do the nav:\n1. tabs\n2. a rail\n3. a sheet', from: { paneid: BUDDY } } })).body.entries[0];
  const mine = (await call(LINE, { json: { text: '@buddy thinking about it' } })).body.entries[0];
  for (let i = 0; i < 14; i += 1) {
    await call(LINE, { json: { text: `recent ${i}`, from: { paneid: LEAD } } });
  }
  const facts = (await call(`${LINE}?kind=fact&limit=5`)).body.entries;
  ok(facts.length > 0, 'setup: the room has a fact', facts.length);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const lineBodies = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith(LINE)) {
      try { lineBodies.push(JSON.parse(r.postData() ?? 'null')); } catch { /* not json */ }
    }
  });
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    const f = document.querySelector('form');
    (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
  }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  const ROOM_URL = `${BASE}/room.html?room=${R}`;
  await page.goto(ROOM_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`#line li[data-id="${nearOrig.id}"]`);
  await sleep(600);
  const li = (id) => `#line li[data-id="${id}"]`;

  /* ---- 0. the badge is the engine's `waiting` ---- */
  const room0 = (await call(`/api/rooms/${R}`)).body;
  const badge = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#roster .seat[data-handle]')].map((s) => [s.dataset.handle, s.querySelector('.seat-side .rm-count, .seat-side [class*="count"]')?.textContent ?? ''])));
  const want = Object.fromEntries(room0.seats.map((s) => [s.handle, s.waiting?.count ? String(s.waiting.count) : '']));
  ok(room0.seats.every((s) => s.waiting && Number.isInteger(s.waiting.count) && Array.isArray(s.waiting.ids)), 'engine: every seat carries waiting {count, ids}', room0.seats.map((s) => s.waiting));
  ok(JSON.stringify(badge) === JSON.stringify(want), 'the seat badges show the engine\'s waiting count', { badge, want });

  /* ---- 1. the hover pill ---- */
  await page.hover(`${li(nearOrig.id)} .entry-body`);
  const pill = await page.evaluate((s) => {
    const l = document.querySelector(s);
    const a = l.querySelector('.rp-acts');
    const b = l.querySelector('.entry-bubble').getBoundingClientRect();
    const r = a.getBoundingClientRect();
    const cs = getComputedStyle(a);
    return { display: cs.display, bg: cs.backgroundColor, border: cs.borderTopWidth + ' ' + cs.borderTopStyle, radius: cs.borderTopLeftRadius,
      right: r.right, bRight: b.right, midY: r.top + r.height / 2, bTop: b.top, btn: [...a.querySelectorAll('button')].map((x) => [x.dataset.a, Math.round(x.getBoundingClientRect().width), Math.round(x.getBoundingClientRect().height)]) };
  }, li(nearOrig.id));
  ok(pill.display === 'flex', 'hovering an agent line shows the pill', pill.display);
  ok(near(pill.right, pill.bRight + 6, 0.5) && near(pill.midY, pill.bTop, 0.5), '...on its top RIGHT outer corner (6px out, centred on the top edge)', pill);
  ok(pill.bg === 'rgb(34, 42, 52)' && pill.border === '1px solid' && pill.radius === '8px', '...on the menu surface (--surface3, 1px hairline, r8)', pill);
  ok(JSON.stringify(pill.btn) === JSON.stringify([['reply', 28, 28], ['more', 28, 28]]), '...two 28px buttons: Reply and ⋯', pill.btn);
  await page.hover(`${li(mine.id)} .entry-body`);
  const pillMine = await page.evaluate((s) => {
    const l = document.querySelector(s);
    const r = l.querySelector('.rp-acts').getBoundingClientRect();
    return { left: r.left, bLeft: l.querySelector('.entry-bubble').getBoundingClientRect().left, d: getComputedStyle(l.querySelector('.rp-acts')).display };
  }, li(mine.id));
  ok(pillMine.d === 'flex' && near(pillMine.left, pillMine.bLeft - 6, 0.5), 'on YOUR line the pill sits on the top LEFT corner', pillMine);
  const other = await page.evaluate((s) => getComputedStyle(document.querySelector(s + ' .rp-acts')).display, li(nearOrig.id));
  ok(other === 'none', '...and is gone from a line not hovered or focused', other);
  await page.mouse.move(5, 5);

  /* ---- 2. the ⋯ opens the seat-menu component ---- */
  await page.hover(`${li(nearOrig.id)} .entry-body`);
  await page.click(`${li(nearOrig.id)} .rp-act[data-a="more"]`);
  const menu = () => page.evaluate(() => {
    const m = document.querySelector('.rsm-menu');
    if (!m) { return null; }
    return {
      kind: m.dataset.menu, title: m.querySelector('.rsm-mt')?.firstChild?.textContent, sub: m.querySelector('.rsm-mst')?.textContent,
      ink: getComputedStyle(m.querySelector('.rsm-mt')).color, text: getComputedStyle(document.body).color, sheet: m.classList.contains('is-sheet'),
      items: [...m.querySelectorAll('.rsm-mi')].map((b) => ({ a: b.dataset.a, label: [...b.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(''),
        k: b.querySelector('.rsm-k')?.textContent ?? null, h: Math.round(b.getBoundingClientRect().height), svg: (b.querySelector('svg')?.innerHTML ?? '').includes('<path') || (b.querySelector('svg')?.innerHTML ?? '').includes('<rect') })),
      focus: document.activeElement?.dataset?.a ?? null,
    };
  });
  let m = await menu();
  ok(m && m.kind === 'line' && m.title === '@buddy' && /\d/.test(m.sub ?? ''), '⋯ opens the line menu: title @buddy + the time', m && { t: m.title, s: m.sub });
  ok(m && m.ink !== m.text && /oklch|rgb/.test(m.ink), '...the handle in its ink (not the plain text colour)', m && [m.ink, m.text]);
  ok(m && m.items.map((i) => `${i.label}|${i.k ?? ''}`).join(',') === `Reply|R,Copy text|,Copy line link|#${nearOrig.id}`, '...Reply (R) · Copy text · Copy line link (#id)', m?.items);
  ok(m && m.items.every((i) => i.svg), '...every item has its icon', m?.items.map((i) => i.svg));
  ok(m?.focus === 'reply', '...the focus lands on Reply', m?.focus);
  await page.keyboard.press('Escape');
  const back1 = await page.evaluate(() => ({ menu: !!document.querySelector('.rsm-menu'), focus: document.activeElement?.dataset?.a ?? document.activeElement?.dataset?.id ?? null }));
  ok(!back1.menu && back1.focus === 'more', 'Esc closes it; the focus goes back to the ⋯ it came from', back1);

  /* ---- 3. right-click -> Reply: the chip first in the tray ---- */
  await page.click(`${li(nearOrig.id)} .entry-body`, { button: 'right' });
  m = await menu();
  ok(m?.title === '@buddy', 'right-click opens the same menu', m?.title);
  await page.click('.rsm-menu .rsm-mi[data-a="reply"]');
  const chipGeo = () => page.evaluate(() => {
    const c = document.querySelector('#attTray > .rp-chip');
    if (!c) { return null; }
    const r = c.getBoundingClientRect();
    const t = document.querySelector('#attTray').getBoundingClientRect();
    const x = c.querySelector('.rp-x').getBoundingClientRect();
    const cs = getComputedStyle(c);
    return { w: r.width, h: r.height, left: r.left, trayLeft: t.left, first: document.querySelector('#attTray').firstElementChild === c,
      bg: cs.backgroundColor, border: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth, cs.borderLeftStyle].join(' '), sticky: cs.position,
      l1: c.querySelector('.rp-l1').textContent, l2: c.querySelector('.rp-l2').textContent, who: c.querySelector('.rp-who') ? getComputedStyle(c.querySelector('.rp-who')).color : null,
      x: { top: x.top - r.top, right: r.right - x.right, w: x.width }, focus: document.activeElement?.id, id: c.dataset.id, hidden: document.querySelector('#attTray').hidden };
  });
  let chip = await chipGeo();
  ok(chip && chip.first && !chip.hidden, 'Reply puts the quote chip FIRST in the tray', chip);
  ok(chip && chip.w === 260 && chip.h === 64, '...260x64', chip && [chip.w, chip.h]);
  ok(chip && chip.bg === 'rgb(34, 42, 52)' && chip.border === '1px 1px 1px 1px solid', '...on --surface3 with a hairline ALL round (no bar)', chip && [chip.bg, chip.border]);
  ok(chip && chip.l1 === 'Replying to @buddy' && chip.l2 === `Three ways to do the nav: 1. tabs ${DOT} 2. a rail ${DOT} 3. a sheet`, '...line 1 "Replying to @buddy", line 2 the excerpt with its list numbers', chip && [chip.l1, chip.l2]);
  ok(chip && near(chip.x.top, 4, 1.5) && near(chip.x.right, 4, 1.5) && chip.x.w === 22, '...the ✕ in the tiles\' corner spot (4px, 22px)', chip?.x);
  ok(chip?.focus === 'input', '...and the focus goes to the input', chip?.focus);

  /* sticky-left while files scroll past */
  await page.setInputFiles('#attFile', [...['a', 'b', 'c'].map((n) => img(`shot-${n}.png`)), ...['d', 'e', 'f', 'g', 'h'].map((n) => doc(`brief-${n}.pdf`))]);
  await page.waitForFunction(() => document.querySelectorAll('#attTray .att-tile:not(.up)').length === 8, null, { timeout: 8000 }).catch(() => {});
  const before = await chipGeo();
  await page.evaluate(() => { const t = document.querySelector('#attTray'); t.scrollLeft = t.scrollWidth; });
  await sleep(100);
  const after = await chipGeo();
  const tray = await page.evaluate(() => { const t = document.querySelector('#attTray'); return { sl: t.scrollLeft, sw: t.scrollWidth, cw: t.clientWidth, first: t.firstElementChild?.className }; });
  ok(tray.sw > tray.cw && tray.sl > 0 && tray.first === 'rp-chip', 'setup: eight files make the tray scroll sideways, the chip still first', tray);
  ok(before && after && near(after.left, before.left, 1), 'the chip is STICKY-LEFT: it stays put while the tiles scroll past', before && after && [before.left, after.left]);
  const tileUnder = await page.evaluate(() => {
    const c = document.querySelector('#attTray > .rp-chip').getBoundingClientRect();
    const hit = document.elementFromPoint(c.left + 20, c.top + 20);
    return hit?.closest('.rp-chip') ? 'chip' : hit?.className ?? null;
  });
  ok(tileUnder === 'chip', '...drawn above the tiles that pass under it', tileUnder);
  for (let i = 0; i < 8; i += 1) {
    await page.click('#attTray .att-tile .att-x', { force: true });
    await sleep(60);
  }
  await page.waitForFunction(() => !document.querySelector('#attTray .att-tile'), null, { timeout: 4000 }).catch(() => {});

  /* one at a time: replying to another line replaces the chip */
  await page.hover(`${li(mine.id)} .entry-body`);
  await page.click(`${li(mine.id)} .rp-act[data-a="reply"]`);
  chip = await chipGeo();
  const chips = await page.evaluate(() => document.querySelectorAll('.rp-chip').length);
  ok(chips === 1 && chip?.id === String(mine.id), 'one at a time: a new reply REPLACES the chip', { chips, id: chip?.id });
  ok(chip?.l1 === `Replying to your line ${DOT} to @leader`, 'a reply to your own line says where normal routing sends it: "· to @leader"', chip?.l1);
  await page.keyboard.type('@bud');
  await sleep(150);
  const compOpen = await page.evaluate(() => !document.querySelector('#complete').hidden);
  await page.keyboard.press('Escape');
  const afterEsc1 = await page.evaluate(() => ({ chip: !!document.querySelector('.rp-chip'), comp: !document.querySelector('#complete').hidden, l1: document.querySelector('.rp-chip .rp-l1')?.textContent }));
  ok(compOpen && afterEsc1.chip && !afterEsc1.comp, 'Esc with the @-list open closes only the list; the chip stays', { compOpen, ...afterEsc1 });
  ok(afterEsc1.l1 === `Replying to your line ${DOT} to @bud`, '...and the chip follows a typed @address ("· to @bud")', afterEsc1.l1);
  await page.keyboard.press('Escape');
  ok(!(await page.$('.rp-chip')) && (await page.evaluate(() => document.querySelector('#attTray').hidden)), 'Esc in the input drops the chip (and the empty tray hides)');
  await page.fill('#input', '');

  /* the ✕ drops it too */
  await page.hover(`${li(nearOrig.id)} .entry-body`);
  await page.click(`${li(nearOrig.id)} .rp-act[data-a="reply"]`);
  await page.click('.rp-chip .rp-x');
  ok(!(await page.$('.rp-chip')), 'the chip\'s ✕ drops it');

  /* ---- 4. the keyboard: ↑ from an empty composer, ↑, R ---- */
  await page.focus('#input');
  await page.keyboard.press('ArrowUp');
  const k1 = await page.evaluate(() => ({ id: document.activeElement?.dataset?.id ?? null, last: [...document.querySelectorAll('#line li.rp-line')].filter((l) => l.style.display !== 'none').pop()?.dataset.id,
    pill: getComputedStyle(document.activeElement.querySelector('.rp-acts') ?? document.body).display }));
  ok(k1.id && k1.id === k1.last, '↑ from an empty composer steps into the line (the last line)', k1);
  ok(k1.pill === 'flex', '...and the focused line shows its pill (focus-within)', k1.pill);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  const k2 = await page.evaluate(() => document.activeElement?.dataset?.id ?? null);
  await page.keyboard.press('r');
  chip = await chipGeo();
  ok(chip && chip.id === k2 && chip.focus === 'input', '↑ moves up the line; R replies to the focused line and returns to the input', { k2, chip: chip?.id, focus: chip?.focus });
  await page.keyboard.press('Escape');

  /* ---- 5. the draft keeps the reply target across a reload ---- */
  await page.hover(`${li(nearOrig.id)} .entry-body`);
  await page.click(`${li(nearOrig.id)} .rp-act[data-a="reply"]`);
  await page.keyboard.type('go with 2)'); // after the "@buddy " the reply prefilled (Owner 2026-09-28)
  await sleep(900); // the 400 ms debounce, then the PUT
  const dr = (await call(`/api/rooms/${R}/draft`, { user: true })).body;
  ok(dr?.reply_to === nearOrig.id && dr?.text === '@buddy go with 2)', 'the server draft holds the text AND reply_to', dr);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#attTray > .rp-chip', { timeout: 8000 }).catch(() => {});
  chip = await chipGeo();
  const inputAfter = await page.inputValue('#input');
  ok(chip?.id === String(nearOrig.id) && chip?.l1 === 'Replying to @buddy' && inputAfter === '@buddy go with 2)', 'after a reload the chip and the text are back', { id: chip?.id, l1: chip?.l1, inputAfter });

  /* ---- 6. send: reply_to goes, the quote header lands inside the bubble ---- */
  await page.focus('#input');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.rp-chip'), null, { timeout: 5000 }).catch(() => {});
  const sent = lineBodies[lineBodies.length - 1];
  ok(sent?.reply_to === nearOrig.id && sent?.text === '@buddy go with 2)', 'Send posts reply_to with the text', sent);
  await page.waitForFunction(() => [...document.querySelectorAll('#line li.by-user .rp-qh')].length >= 1, null, { timeout: 5000 }).catch(() => {});
  const newest = await page.evaluate(() => [...document.querySelectorAll('#line li')].pop()?.dataset.id);
  const hdr = await page.evaluate((s) => {
    const l = document.querySelector(s);
    const q = l.querySelector('.entry-bubble > .rp-qh');
    if (!q) { return null; }
    const b = l.querySelector('.entry-bubble');
    const body = l.querySelector('.entry-bubble > .entry-body');
    const cs = getComputedStyle(q);
    const bcs = getComputedStyle(b);
    const r = q.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return {
      order: [...b.children].map((c) => c.className.split(' ')[0]), aboveBody: r.bottom <= body.getBoundingClientRect().top + 0.5,
      width: r.width, inner: br.width - parseFloat(bcs.paddingLeft) - parseFloat(bcs.paddingRight) - parseFloat(bcs.borderLeftWidth) - parseFloat(bcs.borderRightWidth),
      borders: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].join(' '), borderColor: cs.borderLeftColor, topColor: cs.borderTopColor,
      radius: cs.borderTopLeftRadius, tag: q.tagName, who: q.querySelector('.rp-qa')?.textContent, text: q.querySelector('.rp-qt')?.textContent,
      whoInk: getComputedStyle(q.querySelector('.rp-qa')).color, plain: getComputedStyle(document.body).color, clamp: getComputedStyle(q.querySelector('.rp-qt')).textOverflow,
    };
  }, li(newest));
  ok(hdr && hdr.tag === 'BUTTON' && hdr.aboveBody && hdr.order.indexOf('rp-qh') < hdr.order.indexOf('entry-body'), 'the sent line carries a quote header INSIDE the bubble, above the body (a button)', hdr?.order);
  ok(hdr && near(hdr.width, hdr.inner, 1), '...full width', hdr && [hdr.width, hdr.inner]);
  ok(hdr && hdr.borders === '1px 1px 1px 1px' && hdr.borderColor === hdr.topColor && hdr.radius === '6px', '...a 1px hairline all round, the same colour on every side (NO left bar), r6', hdr);
  ok(hdr && hdr.who === '@buddy' && hdr.text === `Three ways to do the nav: 1. tabs ${DOT} 2. a rail ${DOT} 3. a sheet` && hdr.clamp === 'ellipsis', '...↩ @buddy and one clamped line of the original', hdr && [hdr.who, hdr.text]);
  ok(hdr && hdr.whoInk !== hdr.plain, '...the handle in its ink', hdr && [hdr.whoInk, hdr.plain]);
  const dr2 = (await call(`/api/rooms/${R}/draft`, { user: true })).body;
  ok(dr2?.reply_to === null && dr2?.text === '', 'the send cleared the draft\'s text and reply target', dr2);

  /* ---- 7. click the header: jump + flash + back to latest ---- */
  const flashNow = await page.evaluate(({ reply, orig }) => {
    document.querySelector(`#line li[data-id="${reply}"] .rp-qh`).click();
    const l = document.querySelector(`#line li[data-id="${orig}"]`);
    const cs = getComputedStyle(l.querySelector('.entry-bubble'));
    return { cls: l.classList.contains('rp-flash'), bg: cs.backgroundColor, border: cs.borderTopColor };
  }, { reply: newest, orig: nearOrig.id });
  ok(flashNow.cls && flashNow.bg === 'rgb(34, 42, 52)' && flashNow.border === 'rgb(90, 102, 114)', 'click: the original flashes with THE LIFT (--surface3 + a --dim2 hairline)', flashNow);
  await sleep(1300);
  const landed = await page.evaluate((orig) => {
    const s = document.querySelector('#lineScroll').getBoundingClientRect();
    const r = document.querySelector(`#line li[data-id="${orig}"]`).getBoundingClientRect();
    const p = document.querySelector('.rp-latest');
    const l = document.querySelector(`#line li[data-id="${orig}"]`);
    return { mid: r.top + r.height / 2, sMid: s.top + s.height / 2, pill: p && !p.hidden, pillText: p?.textContent, flashGone: !l.classList.contains('rp-flash'),
      bg: getComputedStyle(l.querySelector('.entry-bubble')).backgroundColor, sTop: document.querySelector('#lineScroll').scrollTop };
  }, nearOrig.id);
  ok(near(landed.mid, landed.sMid, 60) || landed.sTop === 0, '...scrolled to the middle of the view', landed);
  ok(landed.flashGone && landed.bg !== 'rgb(34, 42, 52)', '...and the lift fades back', landed.bg);
  ok(landed.pill && /Back to latest/.test(landed.pillText ?? ''), 'a "↓ Back to latest" pill floats until you are back down', landed);
  await page.click('.rp-latest');
  await sleep(900);
  const down = await page.evaluate(() => { const s = document.querySelector('#lineScroll'); return { gap: s.scrollHeight - s.scrollTop - s.clientHeight, pill: !document.querySelector('.rp-latest').hidden }; });
  ok(down.gap < 40 && !down.pill, '...pressing it goes back down and it hides', down);

  /* ---- 8. not loaded: older pages load until the original arrives ---- */
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`${li(farReply.body.entries[0].id)} .rp-qh`);
  await sleep(400);
  ok(!(await page.$(li(far.id))), 'setup: the far original is above the loaded window', far.id);
  await page.evaluate(() => {
    window.__rpLoading = false;
    new MutationObserver((ms) => { for (const x of ms) { if (x.target.classList?.contains('is-loading')) { window.__rpLoading = true; } } })
      .observe(document.querySelector('#line'), { subtree: true, attributes: true, attributeFilter: ['class'] });
  });
  await page.click(`${li(farReply.body.entries[0].id)} .rp-qh`);
  await page.waitForSelector(li(far.id), { timeout: 8000 }).catch(() => {});
  await sleep(200);
  const farDone = await page.evaluate((id) => {
    const l = document.querySelector(`#line li[data-id="${id}"]`);
    return { there: !!l, loading: window.__rpLoading, headerIdle: ![...document.querySelectorAll('.rp-qh.is-loading')].length, bubble: l ? getComputedStyle(l.querySelector('.entry-bubble')).backgroundColor : null,
      flashed: !!l && (l.classList.contains('rp-flash') || getComputedStyle(l.querySelector('.entry-bubble')).transitionDuration.includes('0.9')) };
  }, far.id);
  ok(farDone.there && farDone.loading && farDone.headerIdle, 'not loaded: the header spins while older pages load, until the original arrives', farDone);
  await sleep(1200);
  const farMid = await page.evaluate((id) => {
    const s = document.querySelector('#lineScroll').getBoundingClientRect();
    const r = document.querySelector(`#line li[data-id="${id}"]`).getBoundingClientRect();
    return { mid: r.top + r.height / 2, sMid: s.top + s.height / 2, sTop: document.querySelector('#lineScroll').scrollTop, visible: r.top >= s.top && r.bottom <= s.bottom };
  }, far.id);
  ok(farMid.visible && (near(farMid.mid, farMid.sMid, 60) || farMid.sTop === 0), '...then it jumps there (centred, or as far as the start of the line allows)', farMid);

  /* ---- 9. gone: the original is not on the line any more ---- */
  const gonePage = await context.newPage();
  gonePage.on('pageerror', (e) => errors.push(String(e)));
  await gonePage.route(`**/api/rooms/${R}/line?*`, async (route) => {
    const res = await route.fetch();
    const j = await res.json();
    j.entries = (j.entries ?? []).filter((e) => e.id !== far.id); // "pruned"
    await route.fulfill({ response: res, json: j });
  });
  await gonePage.goto(ROOM_URL, { waitUntil: 'domcontentloaded' });
  await gonePage.waitForSelector(`${li(farReply.body.entries[0].id)} .rp-qh`);
  await sleep(300);
  await gonePage.click(`${li(farReply.body.entries[0].id)} .rp-qh`);
  await gonePage.waitForSelector(`${li(farReply.body.entries[0].id)} .rp-qh.gone`, { timeout: 10000 }).catch(() => {});
  const gone = await gonePage.evaluate((id) => {
    const q = document.querySelector(`#line li[data-id="${id}"] .rp-qh`);
    const cs = getComputedStyle(q);
    return { gone: q.classList.contains('gone'), disabled: q.disabled, italic: cs.fontStyle, color: cs.color, text: q.querySelector('.rp-qt').textContent };
  }, farReply.body.entries[0].id);
  ok(gone.gone && gone.disabled && gone.italic === 'italic' && gone.color === 'rgb(90, 102, 114)' && gone.text.startsWith('Original not available'),
    'gone: "Original not available", dim italic, not clickable (the captured words stay)', gone);
  await gonePage.close();

  /* ---- 10. a fact: right-click opens the menu titled "fact" ---- */
  await page.bringToFront();
  const factId = facts[facts.length - 1].id;
  if (await page.$(li(factId))) {
    await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center' }), li(factId));
    await page.click(`${li(factId)} .entry-body`, { button: 'right' });
    m = await menu();
    ok(m?.title === 'fact', 'a fact: right-click opens the menu titled "fact"', m?.title);
    await page.click('.rsm-menu .rsm-mi[data-a="reply"]');
    chip = await chipGeo();
    ok(chip?.l1 === `Replying to a fact ${DOT} to @leader`, '...Reply: "Replying to a fact · to @leader"', chip?.l1);
    await page.focus('#input');
    await page.keyboard.press('Escape');
  } else {
    ok(false, 'the fact is on the loaded line', factId);
  }
  ok(errors.length === 0, 'no page errors (desktop)', errors.slice(0, 3));

  /* ---- 11. PHONE 390: swipe to reply, the long-press sheet ---- */
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await pctx.newPage();
  const perr = [];
  pp.on('pageerror', (e) => perr.push(String(e)));
  await pp.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await pp.evaluate((t) => {
    const f = document.querySelector('form');
    (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
  }, TOKEN);
  await Promise.all([pp.waitForNavigation().catch(() => {}), pp.click('form button:visible')]);
  await pp.goto(ROOM_URL, { waitUntil: 'domcontentloaded' });
  await pp.waitForSelector(li(nearOrig.id));
  await sleep(600);
  await pp.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center' }), li(nearOrig.id));
  await sleep(200);
  const swipe = (sel, x0, steps) => pp.evaluate(async ({ sel: s, x0: x, steps: st }) => {
    const l = document.querySelector(s);
    const b = l.querySelector('.entry-body').getBoundingClientRect();
    const y = b.top + b.height / 2;
    const fire = (type, cx) => l.querySelector('.entry-body').dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'touch', pointerId: 7, clientX: cx, clientY: y, isPrimary: true }));
    fire('pointerdown', x);
    const seen = [];
    for (const dx of st) {
      fire('pointermove', x + dx);
      const d = l.querySelector('.rp-disc');
      seen.push({ dx, t: l.style.transform, disc: !!d, on: d?.classList.contains('on') ?? false, color: d ? getComputedStyle(d).borderTopColor : null });
    }
    fire('pointerup', x + st[st.length - 1]);
    return seen;
  }, { sel, x0, steps });
  const edge = await swipe(li(nearOrig.id), 12, [20, 40, 70]);
  ok(edge.every((s) => !s.disc && !s.t) && !(await pp.$('.rp-chip')), 'phone: a swipe starting at the screen EDGE (<24px) is left to the OS', edge);
  const sw = await swipe(li(nearOrig.id), 60, [20, 40, 70]);
  ok(sw[1].disc && !sw[1].on && sw[1].t === 'translateX(40px)', 'phone: swiping right slides the line and reveals the ↩ disc', sw[1]);
  ok(sw[2].on && sw[2].color === 'rgb(45, 212, 191)', '...the disc turns teal past 56px', sw[2]);
  await sleep(100);
  const pchip = await pp.evaluate(() => {
    const c = document.querySelector('#attTray > .rp-chip');
    const r = c?.getBoundingClientRect();
    return c ? { w: r.width, h: r.height, id: c.dataset.id, l1: c.querySelector('.rp-l1').textContent } : null;
  });
  ok(pchip && pchip.id === String(nearOrig.id) && pchip.w === 230 && pchip.h === 56, '...release replies: the chip, 230x56 on a phone', pchip);
  const short = await swipe(li(mine.id), 60, [20, 40]);
  const pchip2 = await pp.evaluate(() => document.querySelector('#attTray > .rp-chip')?.dataset.id);
  ok(!short[1].on && pchip2 === String(nearOrig.id), '...a swipe released before 56px does nothing', { short, pchip2 });
  const reset = await pp.evaluate((s) => document.querySelector(s).style.transform, li(mine.id));
  ok(reset === '', '...and the line slides back', reset);
  /* the long press: a touch pointerdown held past 500 ms (after a key press:
     the menu must go by the LAST input, the touch, not an earlier key) */
  await pp.keyboard.press('Shift');
  await pp.evaluate((s) => {
    const l = document.querySelector(s);
    const r = l.querySelector('.entry-body').getBoundingClientRect();
    l.querySelector('.entry-body').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', pointerId: 9, clientX: r.x + 30, clientY: r.y + 6, isPrimary: true }));
  }, li(mine.id));
  await sleep(700);
  const sheet = await pp.evaluate(() => {
    const m = document.querySelector('.rsm-menu');
    if (!m) { return null; }
    const r = m.getBoundingClientRect();
    return { sheet: m.classList.contains('is-sheet'), kind: m.dataset.menu, scrim: !!document.querySelector('.rsm-scrim'), title: m.querySelector('.rsm-mt')?.firstChild?.textContent,
      bottom: Math.round(r.bottom), w: Math.round(r.width), items: [...m.querySelectorAll('.rsm-mi')].map((b) => Math.round(b.getBoundingClientRect().height)), k: m.querySelector('.rsm-mi[data-a="reply"] .rsm-k')?.textContent ?? null };
  });
  ok(sheet && sheet.sheet && sheet.kind === 'line' && sheet.scrim && sheet.title === 'you', 'phone: a long press opens the line menu as a bottom sheet over a scrim, with the title row', sheet);
  ok(sheet && sheet.bottom === 844 && sheet.w === 390 && sheet.items.every((h) => h === 48), '...full width at the bottom, 48px items', sheet);
  const ring = await pp.evaluate(() => {
    const a = document.activeElement;
    return { a: a?.dataset?.a ?? null, fv: !!a?.matches?.(':focus-visible'), outline: a ? getComputedStyle(a).outlineStyle : null, quiet: !!a?.hasAttribute?.('data-quiet-focus') };
  });
  ok(ring.a === 'reply' && !ring.fv && ring.outline === 'none' && ring.quiet, '...focus is on Reply with NO ring: a long press is not a keyboard (web/focus-intent.mjs)', ring);
  await pp.click('.rsm-menu .rsm-mi[data-a="reply"]');
  const pchip3 = await pp.evaluate(() => document.querySelector('#attTray > .rp-chip')?.dataset.id);
  ok(pchip3 === String(mine.id), '...its Reply replaces the chip', pchip3);
  const psw = await pp.evaluate(() => [document.documentElement.scrollWidth, innerWidth, document.querySelector('#lineScroll').scrollWidth - document.querySelector('#lineScroll').clientWidth]);
  ok(psw[0] <= psw[1] && psw[2] <= 0, 'phone: no sideways scroll', psw);
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
