/* THE RESIZABLE LEFT COLUMN (the design system room-rail-resize-v1, Owner 2026-09-28).
 *
 *   node test/room-rail.probe.mjs
 *
 * What only a browser can prove (COMPUTED widths, real pointer input):
 *   - the handle: a 12px strip centred on the column's 1px edge, a 4x36 grip,
 *     role=separator with aria-orientation / aria-controls / aria-value*
 *   - a drag widens the column and narrows the line; while dragging the page
 *     is user-select:none and EVERY iframe is pointer-events:none, the grip is
 *     teal and a mono readout ("392px") shows; released, all of it is undone
 *   - snap to the default within 8px; NO fixed max (rooms/rail-max) — never
 *     more than leaves the line 480 (window narrowing) or 480 + 370 (the
 *     preview column open), clamped at render and NOT written back (the
 *     saved width re-applies when there is room, up to what the window allows)
 *   - keyboard: ← → 16px, Shift 64px, Home default, End max, Enter reset; the
 *     readout on keyboard focus; a double-click resets
 *   - remembered per device across rooms and reloads (localStorage), applied
 *     before the first paint; a storage that throws is survived
 *   - the seats cell keeps its anatomy (row height; badges / "+" right-aligned)
 *   - phone (390px): no grip, nothing changes, no sideways scroll
 *   - SHOWN ONLY WHEN WANTED (Owner 2026-09-30 [ticket]): opacity 0 at rest,
 *     above 0 on hover, 1 while dragging, back to 0 by 2.5s after leaving
 *   - THE PREVIEW COLUMN [ticket]: a TASK item's long description takes the
 *     column's width (COMPUTED, >=80%) — it once shared a class with the 32px
 *     Expand button; the same splitter on the preview's left edge: a drag to
 *     the left widens it, remembered (hwb.room.previewWidth), max 720 / the
 *     line's 480, double-click and Enter reset to 370, ← widens by keyboard;
 *     the grip exists only while the column is open, and never on a phone
 *
 * PROBE_SHOTS=<dir> puts the 1280 / 390 screenshots there (default: OS temp).
 *
 * App panels are stubbed in the browser (room-round3's pattern) so real
 * iframes sit in the column. A PROBE, not in `npm test`. OWN scratch engine on
 * P(162), DEAD broker P(163), temp table: never Owner's data.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(162);
const DEAD_BROKER_PORT = P(163);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-rail-token';
const KEY = 'hwb.room.railWidth';

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

try {
  const stale = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
  if (stale.ok) {
    console.log(` FAIL  :${PORT} is already serving something — a leaked engine from an aborted run?`);
    process.exit(1);
  }
} catch { /* nothing there */ }
for (const p of [PORT, DEAD_BROKER_PORT]) {
  await assertFree(p, 'room-rail.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-rail-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null;
let browser = null;
let engineLog = '';
const seed = async (plan) => {
  const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
  return JSON.parse(r.out.trim().split('\n').pop());
};
const SHOTS = process.env.PROBE_SHOTS || tmpdir();
/* a Tasks-app-shaped item (Owner's report, 2026-09-30): meta rows, then a long description */
const LONG_DESC = 'Owner 2026-09-30 (room line [ref]). Auriga designs; the room-tasks app builds. - The panel opens showing TOPICS only, not tasks. An accordion like the CLI Manager\'s rooms list: each row is the topic name with a count, and opening one shows its tasks underneath. '.repeat(3);
const TASK = { key: 'ticket', type: 'Task', title: 'Tasks app: Topics — accordion of topics', status: 'In progress',
  meta: [['Task', 'ticket'], ['Pinned', 'in this room'], ['Working on it', 'nobody yet'], ['Flagged by', '@user'], ['Created', '2026-09-30'], ['Updated', '2026-09-30']],
  excerpt: LONG_DESC, actions: [{ label: 'Open in Vikunja ↗', open: 'https://example.com/tasks/1924' }] };
const APP = (id) => `<!doctype html><body style="margin:0;font:12px sans-serif;color:#ccc;background:#161b22;height:140px">${id}<script>window.task = () => parent.postMessage({ panel: 'preview', item: ${JSON.stringify(TASK)} }, '*');<\/script></body>`;

try {
  await seed({ recipes: [
    { id: 'rec-a', name: 'Awake', projectDir: '/srv/x/awake', vendor: 'claude-code', agent: 'awake', color: '#0dab49' },
    { id: 'rec-b', name: 'Bravo', projectDir: '/srv/x/bravo', vendor: 'claude-code', agent: 'bravo-with-a-long-handle-name', color: '#1f5fbf' },
  ] });
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

  const post = await seed({ rooms: [{ name: 'Rail Probe', seats: [{ handle: 'awake', recipe_id: 'rec-a' }, { handle: 'bravo-with-a-long-handle-name', recipe_id: 'rec-b' }] }] });
  const R = post.rooms[0].id;
  const F = (id) => `/api/rooms/${R}/panels/${id}/frame/t/tok-${id}/`;
  const PANELS = [
    { id: 'p-assets', room_id: R, kind: 'app', title: 'Assets', icon: 'assets', order: 1, seat_handle: null, scripts: true, url: 'http://127.0.0.1:9/never', frameUrl: F('p-assets') },
    { id: 'p-tasks', room_id: R, kind: 'app', title: 'Tasks', icon: 'tasks', order: 2, seat_handle: 'awake', scripts: true, url: 'http://127.0.0.1:9/never', frameUrl: F('p-tasks') },
  ];
  const FRAME_RE = /\/panels\/(p-[a-z]+)\/frame\/t\/[^/]+\/(.*)$/;
  const wire = async (ctx) => {
    await ctx.route(new RegExp(`/api/rooms/${R}(\\?.*)?$`), async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.panels = PANELS;
      await route.fulfill({ response: res, json: body });
    });
    /* a pushed room.state carries the ENGINE's panels (none): wear the stubbed
       ones there too, or the cells vanish whenever a push lands (this made the
       iframe checks below flaky) */
    await ctx.routeWebSocket(/\/pty/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => {
        if (typeof m === 'string' && m.includes('"room.state"')) {
          try {
            const d = JSON.parse(m);
            if (d.type === 'room.state' && Array.isArray(d.panels)) {
              d.panels = PANELS;
              ws.send(JSON.stringify(d));
              return;
            }
          } catch { /* not ours */ }
        }
        ws.send(m);
      });
    });
    await ctx.route(FRAME_RE, async (route) => {
      const [, id] = route.request().url().match(FRAME_RE);
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: APP(id) });
    });
  };

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await wire(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  const ROOM_URL = `${BASE}/room.html?room=${R}`;
  await page.goto(ROOM_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.rr-grip.is-rail');
  await page.waitForFunction(() => document.querySelectorAll('.rm-roster iframe').length >= 2);
  await sleep(1200);

  const geo = (pg = page) => pg.evaluate((key) => {
    const main = document.getElementById('main');
    const rail = document.querySelector('.rm-roster');
    const line = document.getElementById('roomLine');
    const g = document.querySelector('.rr-grip.is-rail');
    const rr = rail.getBoundingClientRect();
    const gr = g.getBoundingClientRect();
    const gb = getComputedStyle(g, '::before');
    let saved = null;
    try { saved = localStorage.getItem(key); } catch { /* none */ }
    return {
      main: Math.round(main.getBoundingClientRect().width), rail: Math.round(rr.width), railRight: Math.round(rr.right), line: Math.round(line.getBoundingClientRect().width),
      gripW: Math.round(gr.width), gripMid: Math.round((gr.left + gr.right) / 2), gripDisplay: getComputedStyle(g).display, op: Number(getComputedStyle(g).opacity),
      pillW: gb.width, pillH: gb.height, pillBg: gb.backgroundColor, edge: `${getComputedStyle(rail).borderRightWidth} ${getComputedStyle(rail).borderRightColor}`,
      now: g.getAttribute('aria-valuenow'), min: g.getAttribute('aria-valuemin'), max: g.getAttribute('aria-valuemax'),
      role: g.getAttribute('role'), orient: g.getAttribute('aria-orientation'), controls: g.getAttribute('aria-controls'), railId: rail.id,
      tip: getComputedStyle(g.querySelector('.rr-tip')).display, tipText: g.querySelector('.rr-tip').textContent,
      saved, pv: main.classList.contains('has-pv'), title: g.title,
      frames: [...document.querySelectorAll('iframe')].map((f) => getComputedStyle(f).pointerEvents),
      select: getComputedStyle(document.body).userSelect, bodyResizing: document.body.classList.contains('rr-resizing'),
    };
  }, KEY);
  const tok = (name) => page.evaluate((n) => { const d = document.createElement('div'); d.style.color = `var(${n})`; document.body.append(d); const v = getComputedStyle(d).color; d.remove(); return v; }, name);
  const [border2, teal, dim, borderTok] = [await tok('--border2'), await tok('--teal'), await tok('--dim'), await tok('--border')];

  /* 1. at rest */
  let g = await geo();
  ok(g.rail === 272 && g.line === g.main - 272, 'the column opens at the default 272 (fresh device)', g);
  ok(g.role === 'separator' && g.orient === 'vertical' && g.controls === g.railId && !!g.railId, 'the handle is role=separator, vertical, aria-controls the column', g);
  ok(g.min === '272' && Number(g.max) === g.main - 480 && g.now === '272', '...aria-valuemin/now in px (272 / 272); aria-valuemax is NOT pinned at 560 any more — it is whatever leaves the line 480', [g.min, g.max, g.now]);
  ok(g.gripW === 12 && Math.abs(g.gripMid - g.railRight) <= 1, '...a 12px strip centred on the column\'s edge', g);
  ok(g.pillW === '4px' && g.pillH === '36px' && g.pillBg === border2, '...a 4x36 grip in --border2 at rest', [g.pillW, g.pillH, g.pillBg]);
  ok(g.edge === `1px ${borderTok}`, '...the edge itself stays the plain 1px --border', g.edge);
  ok(g.title === 'Drag to resize · double-click to reset' && g.tip === 'none', '...tooltip says how; no readout at rest', g.title);
  ok(g.op === 0, '...and the grip is INVISIBLE at rest (opacity 0; the 12px hit strip stays)', g.op);
  const seat0 = await page.evaluate(() => { const s = document.querySelector('#roster .seat[data-handle]'); return Math.round(s.getBoundingClientRect().height); });

  /* 2. hover */
  const gb = await page.locator('.rr-grip.is-rail').boundingBox();
  const gx = gb.x + gb.width / 2;
  const gy = gb.y + gb.height / 2;
  await page.mouse.move(gx, gy);
  await sleep(200);
  const hov = await page.evaluate(() => { const g = document.querySelector('.rr-grip.is-rail'); const b = getComputedStyle(g, '::before'); return { cur: getComputedStyle(g).cursor, h: b.height, bg: b.backgroundColor }; });
  ok(hov.cur === 'col-resize' && hov.h === '48px' && hov.bg !== dim && hov.bg !== 'rgba(0, 0, 0, 0)', 'hover: col-resize; the grip goes a SOFTENED --dim (mixed with --border2, auriga 2026-09-30) and 48px', hov);
  const hovOp = await page.evaluate(() => Number(getComputedStyle(document.querySelector('.rr-grip.is-rail')).opacity));
  ok(hovOp > 0, '...hover shows the grip (opacity > 0, faded in within 200ms)', hovOp);

  /* 3. drag: +120 */
  await page.mouse.down();
  await page.mouse.move(gx + 60, gy, { steps: 4 });
  await page.mouse.move(gx + 120, gy, { steps: 4 });
  await sleep(150);
  g = await geo();
  const dragPill = await page.evaluate(() => getComputedStyle(document.querySelector('.rr-grip.is-rail'), '::before').backgroundColor);
  ok(g.rail === 392 && g.line === g.main - 392, 'a drag widens the column (computed 392) and the line gives way', [g.rail, g.line, g.main]);
  await page.screenshot({ path: join(tmpdir(), 'room-rail-drag.png') });
  ok(g.bodyResizing && g.select === 'none' && g.frames.length >= 2 && g.frames.every((p) => p === 'none'), '...while dragging: user-select none, EVERY iframe pointer-events none', { select: g.select, frames: g.frames });
  ok(dragPill === teal && g.tip === 'block' && g.tipText === '392px', '...the grip is teal and the readout says "392px"', { dragPill, tip: g.tip, text: g.tipText });
  ok(g.op === 1, '...and fully visible while dragging', g.op);
  ok(g.saved === null, '...nothing is saved mid-drag', g.saved);
  await page.mouse.up();
  await sleep(150);
  g = await geo();
  ok(!g.bodyResizing && g.frames.every((p) => p !== 'none') && g.select !== 'none' && g.tip === 'none', 'released: the frames take the pointer again, selection back, readout gone', { frames: g.frames, select: g.select, tip: g.tip });
  ok(g.saved === '392' && g.now === '392', '...the width is remembered (392) and aria-valuenow follows', [g.saved, g.now]);
  const seat1 = await page.evaluate(() => {
    const rail = document.querySelector('.rm-roster').getBoundingClientRect();
    const s = document.querySelector('#roster .seat[data-handle]');
    const add = document.getElementById('addBtn').getBoundingClientRect();
    const hd = document.querySelector('.cell[data-cell="seats"] .cell-hw').getBoundingClientRect();
    const h = s.querySelector('.seat-handle');
    return { h: Math.round(s.getBoundingClientRect().height), addGap: Math.round(rail.right - add.right), hdW: Math.round(hd.width), railW: Math.round(rail.width), ellipsed: h.scrollWidth > h.clientWidth };
  });
  ok(seat1.h === seat0 && seat1.hdW >= seat1.railW - 2 && seat1.addGap <= 10, 'the seats cell keeps its two-line rows; its header and "+" follow the edge', { seat0, ...seat1 });

  /* 4. snap home within 8px */
  const gb2 = await page.locator('.rr-grip.is-rail').boundingBox();
  await page.mouse.move(gb2.x + 6, gb2.y + gb2.height / 2);
  await page.mouse.down();
  await page.mouse.move(gb2.x + 6 - 115, gb2.y + gb2.height / 2, { steps: 6 });
  await page.mouse.up();
  await sleep(150);
  g = await geo();
  ok(g.rail === 272 && g.saved === '272', 'a drag that lands within 8px of the default snaps to 272', [g.rail, g.saved]);

  /* 5. no fixed max (rooms/rail-max, Owner 2026-09-28): a 1600px window lets
     the column grow far past the old 560 ceiling — the only limit left is
     "never more than leaves the line 480" (measured live, so the drag target
     is chosen far past ANY plausible cap rather than a hardcoded pixel count —
     scrollbar area and browser chrome are whatever g.main measures them as) */
  await page.setViewportSize({ width: 1600, height: 900 });
  await sleep(300);
  const gb3 = await page.locator('.rr-grip.is-rail').boundingBox();
  await page.mouse.move(gb3.x + 6, gb3.y + 40);
  await page.mouse.down();
  await page.mouse.move(gb3.x + 2000, gb3.y + 40, { steps: 8 });
  await page.mouse.up();
  await sleep(150);
  g = await geo();
  const cap1600 = g.main - 480;
  ok(cap1600 > 560, 'sanity: this window actually exceeds the old 560 cap', { main: g.main, cap1600 });
  ok(g.rail === cap1600 && g.line === 480 && Number(g.max) === cap1600, 'a 1600px window: the drag is not capped at 560 — it grows to whatever leaves the line 480', { rail: g.rail, line: g.line, main: g.main, max: g.max });
  ok(g.saved === String(cap1600), '...and a width well over 560 is saved (persistence of >560)', g.saved);

  /* the preview column, opened at the same wide window: still keeps the line
     >=480 + its own 370 — uncapped otherwise, exactly as it was at 560 */
  await page.click('#gearBtn');
  await sleep(400);
  g = await geo();
  const capPv1600 = g.main - 850;
  let pvW = await page.evaluate(() => Math.round(document.getElementById('preview').getBoundingClientRect().width));
  ok(g.pv && g.rail === g.main - 480 && g.line === 480 && pvW === 370 && Number(g.max) === g.main - 480, 'preview open at 1600 with the rail widened to its limit: the preview is a DRAWER (rail 1120 + 480 + 320 > 1600), so it takes nothing from the rail, the line keeps 480 [pv drawer]', { rail: g.rail, line: g.line, pvW, max: g.max });
  await page.click('#gearBtn');
  await sleep(400);
  g = await geo();
  ok(!g.pv && g.rail === cap1600, 'preview closed: back to the line-only cap', g.rail);

  /* 6. the window narrows: the line keeps 480, the column gives way, nothing
     written back — even from a saved width well over the old 560 */
  await page.setViewportSize({ width: 1000, height: 900 });
  await sleep(300);
  g = await geo();
  const cap1000 = g.main - 480;
  ok(g.rail === cap1000 && g.line === 480 && g.saved === String(cap1600) && Number(g.max) === cap1000, 'window 1000: the column gives back so the line keeps 480; the wide saved width is still saved', { rail: g.rail, line: g.line, saved: g.saved, max: g.max, cap1000 });
  await page.setViewportSize({ width: 700, height: 900 });
  await sleep(300);
  g = await geo();
  ok(g.rail === 272 && g.saved === String(cap1600), 'window 700: never below the 272 minimum (the line takes what is left)', { rail: g.rail, line: g.line, saved: g.saved });
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(300);
  g = await geo();
  const cap1440 = g.main - 480;
  const expect1440 = Math.min(cap1600, cap1440);
  ok(g.rail === expect1440, 'wide again (1440): the saved width re-applies up to whatever this narrower window can give the line', { rail: g.rail, cap1600, cap1440 });

  /* 7. the preview column opens at a narrower window: the column clamps well
     under the saved (wide) width, and nothing about that shrink is written back */
  await page.setViewportSize({ width: 1200, height: 900 });
  await sleep(200);
  await page.click('#gearBtn');
  await sleep(400);
  g = await geo();
  const cap1200pv = g.main - 850;
  pvW = await page.evaluate(() => Math.round(document.getElementById('preview').getBoundingClientRect().width));
  ok(g.pv && g.rail === g.main - 480 && g.line === 480 && pvW === 370 && g.saved === String(cap1600) && Number(g.max) === g.main - 480, 'preview open at 1200: the wide rail is held to main-480, the preview is a drawer over the chat, the wide width still saved [pv drawer]', { rail: g.rail, line: g.line, pvW, saved: g.saved, max: g.max });
  await page.click('#gearBtn');
  await sleep(400);
  g = await geo();
  const cap1200 = g.main - 480;
  ok(!g.pv && g.rail === Math.min(cap1600, cap1200), 'preview closed: back to whatever this window can give', g.rail);
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(200);

  /* 8. keyboard */
  await page.focus('.rr-grip.is-rail');
  await page.keyboard.press('Home');
  g = await geo();
  ok(g.rail === 272 && g.saved === '272' && g.tip === 'block' && g.tipText === '272px', 'Home = the default; keyboard focus shows the readout', { rail: g.rail, tip: g.tip, text: g.tipText });
  await sleep(250); // the grip's colour transitions (.12s)
  const focusPill = await page.evaluate(() => { const b = getComputedStyle(document.querySelector('.rr-grip.is-rail'), '::before'); return { bg: b.backgroundColor, ring: b.boxShadow }; });
  ok(focusPill.bg === teal && focusPill.ring !== 'none', '...focus-visible: a teal grip with a soft ring', focusPill);
  await page.keyboard.press('ArrowRight');
  const k1 = (await geo()).rail;
  await page.keyboard.press('Shift+ArrowRight');
  const k2 = (await geo()).rail;
  await page.keyboard.press('ArrowLeft');
  const k3 = (await geo()).rail;
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  const k4 = (await geo()).rail;
  ok(k1 === 288 && k2 === 352 && k3 === 336 && k4 === 272, '→ +16, Shift+→ +64, ← -16; never under the minimum', [k1, k2, k3, k4]);
  await page.keyboard.press('End');
  const k5 = await geo();
  const capEnd = k5.main - 480;
  ok(k5.rail === capEnd && Number(k5.now) === capEnd && Number(k5.saved) === capEnd && capEnd > 560, 'End = the effective max (no longer pinned at 560)', [k5.rail, k5.saved, capEnd]);
  await page.keyboard.press('Enter');
  const k6 = await geo();
  ok(k6.rail === 272 && k6.saved === '272', 'Enter resets', [k6.rail, k6.saved]);

  /* 9. double-click resets */
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  ok((await geo()).rail === 400, 'setup: 400 by keyboard');
  const gb4 = await page.locator('.rr-grip.is-rail').boundingBox();
  await page.mouse.dblclick(gb4.x + 6, gb4.y + 60);
  await sleep(150);
  g = await geo();
  ok(g.rail === 272 && g.saved === '272', 'a double-click on the handle resets to 272', [g.rail, g.saved]);

  /* 10. remembered across reloads and rooms, before the first paint */
  await page.focus('.rr-grip.is-rail');
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+ArrowLeft');
  const setupWidth = capEnd - 64; // one Shift+ArrowLeft back from the effective max (also > 560: the head script's own cap is gone too)
  ok(setupWidth > 560, 'sanity: the reload-persistence width is also well over the old 560', setupWidth);
  ok((await geo()).saved === String(setupWidth), `setup: ${setupWidth} saved`, (await geo()).saved);
  /* the <head> script alone applies it: with room.js (and so room-rail.mjs) never loaded */
  const noJs = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: await context.storageState() });
  await wire(noJs);
  await noJs.route(/\/room\.js(\?|$)/, (route) => route.abort());
  const nj = await noJs.newPage();
  await nj.goto(ROOM_URL, { waitUntil: 'load' });
  const early = await nj.evaluate(() => ({ pref: document.documentElement.style.getPropertyValue('--rail-pref'), rail: Math.round(document.querySelector('.rm-roster').getBoundingClientRect().width), grip: !!document.querySelector('.rr-grip.is-rail') }));
  ok(early.pref === `${setupWidth}px` && early.rail === setupWidth && !early.grip, `the saved ${setupWidth} (not capped by the head script any more) is applied before any module runs (room.js blocked here)`, early);
  await noJs.close();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.rr-grip.is-rail');
  await sleep(600);
  g = await geo();
  ok(g.rail === setupWidth && Number(g.now) === setupWidth, '...and it holds once the page is up', [g.rail, g.now]);
  const other = await seed({ rooms: [{ name: 'Another Room', seats: [{ handle: 'awake', recipe_id: 'rec-a' }] }] });
  await page.goto(`${BASE}/room.html?room=${other.rooms[0].id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.rr-grip.is-rail');
  await sleep(600);
  ok((await geo()).rail === setupWidth, `one width per device: another room opens at ${setupWidth} too`);
  ok(errors.length === 0, 'no page errors (desktop)', errors.slice(0, 3));

  /* 11. storage that throws: the page still works at the default */
  const blocked = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: await context.storageState() });
  await wire(blocked);
  await blocked.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage blocked'); } });
  });
  const bp = await blocked.newPage();
  const berr = [];
  bp.on('pageerror', (e) => berr.push(String(e)));
  await bp.goto(ROOM_URL, { waitUntil: 'domcontentloaded' });
  await bp.waitForSelector('.rr-grip.is-rail');
  await sleep(800);
  const bg0 = (await geo(bp)).rail;
  await bp.focus('.rr-grip.is-rail');
  await bp.keyboard.press('ArrowRight');
  const bg1 = (await geo(bp)).rail;
  ok(bg0 === 272 && bg1 === 288 && berr.length === 0, 'storage that throws: the default, resizing still works, no page errors', { bg0, bg1, berr: berr.slice(0, 2) });
  await blocked.close();

  /* 12. phone: nothing changes */
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: await context.storageState() });
  await wire(phone);
  const pp = await phone.newPage();
  const perr = [];
  pp.on('pageerror', (e) => perr.push(String(e)));
  await pp.goto(ROOM_URL, { waitUntil: 'domcontentloaded' });
  await pp.waitForSelector('.rr-grip.is-rail', { state: 'attached' });
  await sleep(1200);
  const ph = await pp.evaluate(() => ({
    grip: getComputedStyle(document.querySelector('.rr-grip.is-rail')).display, roster: getComputedStyle(document.querySelector('.rm-roster')).display,
    line: Math.round(document.getElementById('roomLine').getBoundingClientRect().width), sw: document.documentElement.scrollWidth, iw: innerWidth,
    saved: localStorage.getItem('hwb.room.railWidth'),
  }));
  ok(ph.saved === String(setupWidth) && ph.grip === 'none' && ph.roster === 'none' && ph.line === 390, `phone: no grip, no column, the line is the full width (the saved ${setupWidth} is ignored)`, ph);
  ok(ph.sw <= ph.iw, 'phone: no sideways scroll at 390', [ph.sw, ph.iw]);
  ok(perr.length === 0, 'no page errors (phone)', perr.slice(0, 3));

  /* 13. THE PREVIEW COLUMN [ticket]: a task's description, and the splitter */
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => { try { localStorage.removeItem('hwb.room.previewWidth'); } catch { /* none */ } });
  await page.goto(ROOM_URL, { waitUntil: 'domcontentloaded' }); // back to the stubbed room (section 10 left us in another)
  await page.waitForFunction(() => document.querySelectorAll('.rm-roster iframe').length >= 2);
  await sleep(1200);
  const pvGripAbsent = await page.evaluate(() => getComputedStyle(document.querySelector('.rr-grip.is-pv')).display);
  ok(pvGripAbsent === 'none', 'the preview grip is not drawn while the column is closed', pvGripAbsent);
  await page.evaluate(() => document.documentElement.style.setProperty('--rail-pref', '272px')); // back to the default rail: the grip tests are about the COLUMN
  const tasksFrame = () => page.frames().find((f) => f.url().includes('/panels/p-tasks/frame/'));
  await tasksFrame().evaluate(() => window.task());
  await page.waitForFunction(() => !document.getElementById('preview').hidden);
  await sleep(300);
  await page.mouse.move(700, 450); // off every grip
  const pvGeo = () => page.evaluate(() => {
    const pv = document.getElementById('preview');
    const r = pv.getBoundingClientRect();
    const g = document.querySelector('.rr-grip.is-pv');
    const gr = g.getBoundingClientRect();
    const ex = pv.querySelector('.pv-excerpt');
    const meta = pv.querySelector('.pv-meta');
    let saved = null;
    try { saved = localStorage.getItem('hwb.room.previewWidth'); } catch { /* none */ }
    return {
      w: Math.round(r.width), left: Math.round(r.left), line: Math.round(document.getElementById('roomLine').getBoundingClientRect().width),
      main: Math.round(document.getElementById('main').getBoundingClientRect().width), rail: Math.round(document.querySelector('.rm-roster').getBoundingClientRect().width),
      exW: ex ? Math.round(ex.getBoundingClientRect().width) : 0, exH: ex ? Math.round(ex.getBoundingClientRect().height) : 0, exDisplay: ex ? getComputedStyle(ex).display : null,
      exInMeta: !!ex?.closest('.pv-meta'), metaW: meta ? Math.round(meta.getBoundingClientRect().width) : 0,
      gripW: Math.round(gr.width), gripMid: Math.round((gr.left + gr.right) / 2), gripDisplay: getComputedStyle(g).display, op: Number(getComputedStyle(g).opacity),
      role: g.getAttribute('role'), controls: g.getAttribute('aria-controls'), now: g.getAttribute('aria-valuenow'), max: g.getAttribute('aria-valuemax'),
      tip: getComputedStyle(g.querySelector('.rr-tip')).display, tipText: g.querySelector('.rr-tip').textContent, saved,
      pill: getComputedStyle(g, '::before').backgroundColor,
    };
  });
  let pg = await pvGeo();
  ok(pg.w === 370, 'a TASK item opens the column at the default 370', pg.w);
  ok(!pg.exInMeta && pg.exDisplay === 'block' && pg.exW >= 0.8 * pg.w, `the long description takes the column's width (computed ${pg.exW}px of ${pg.w}, >= 80%), outside the meta grid`, { exW: pg.exW, w: pg.w, display: pg.exDisplay, inMeta: pg.exInMeta });
  ok(pg.exH < 900, '...and wraps on words (a normal paragraph, not one syllable per line)', pg.exH);
  await page.screenshot({ path: join(SHOTS, 'room-preview-1280.png') });
  ok(pg.gripDisplay === 'block' && pg.gripW === 12 && Math.abs(pg.gripMid - pg.left) <= 1 && pg.role === 'separator' && pg.controls === 'preview', 'the preview grip: a 12px separator centred on the column\'s left edge, controlling #preview', pg);
  ok(pg.pill === border2, '...the same grip pill as the rail\'s (--border2)', pg.pill);
  ok(pg.op === 0, '...invisible at rest (opacity 0)', pg.op);
  const pb = await page.locator('.rr-grip.is-pv').boundingBox();
  const px = pb.x + pb.width / 2;
  const py = pb.y + pb.height / 2;
  await page.mouse.move(px, py);
  await sleep(200);
  pg = await pvGeo();
  ok(pg.op > 0, 'hover shows it (opacity > 0)', pg.op);
  await page.mouse.down();
  await page.mouse.move(px - 50, py, { steps: 4 });
  await page.mouse.move(px - 100, py, { steps: 4 });
  await sleep(150);
  pg = await pvGeo();
  ok(pg.w === 470 && pg.op === 1 && pg.tip === 'block' && pg.tipText === '470px' && pg.pill === teal, 'a drag LEFT by 100 widens the column from its 370 default to 470: fully visible, teal, readout "470px"', { w: pg.w, op: pg.op, tip: pg.tipText, pill: pg.pill });
  ok(pg.saved === null, '...nothing saved mid-drag', pg.saved);
  await page.mouse.up();
  await page.mouse.move(700, 450);
  await sleep(600);
  pg = await pvGeo();
  ok(pg.saved === '470' && pg.now === '470' && pg.op > 0, 'released: 470 remembered; the grip is still showing 0.6s after the pointer left', { saved: pg.saved, now: pg.now, op: pg.op });
  ok(pg.exW >= 0.8 * pg.w, '...and the description follows the wider column', [pg.exW, pg.w]);
  await sleep(1900);
  pg = await pvGeo();
  ok(pg.op === 0, '...and has faded out 2.5s after leaving (opacity 0)', pg.op);
  /* the rail's grip fades the same way */
  const rb = await page.locator('.rr-grip.is-rail').boundingBox();
  await page.mouse.move(rb.x + 6, rb.y + 80);
  await sleep(200);
  const railOn = await page.evaluate(() => Number(getComputedStyle(document.querySelector('.rr-grip.is-rail')).opacity));
  await page.mouse.move(700, 450);
  await sleep(2500);
  const railOff = await page.evaluate(() => Number(getComputedStyle(document.querySelector('.rr-grip.is-rail')).opacity));
  ok(railOn > 0 && railOff === 0, 'the rail\'s grip: shown on hover, gone 2.5s after leaving', [railOn, railOff]);
  /* max: never past 720, never less than the line 480 beside the rail's 272 */
  const pb2 = await page.locator('.rr-grip.is-pv').boundingBox();
  await page.mouse.move(pb2.x + 6, pb2.y + 40);
  await page.mouse.down();
  await page.mouse.move(pb2.x - 2000, pb2.y + 40, { steps: 8 });
  await page.mouse.up();
  await sleep(150);
  pg = await pvGeo();
  const pvCap = Math.min(720, pg.main - 480 - 272);
  ok(pg.w === pvCap && pg.line >= 480 && pg.rail === 272 && Number(pg.max) === pvCap, `a drag far left stops at min(720, main - 752) = ${pvCap}; the line keeps 480, the rail its 272`, { w: pg.w, line: pg.line, rail: pg.rail, max: pg.max });
  await page.mouse.move(700, 450);
  /* double-click resets */
  const pb3 = await page.locator('.rr-grip.is-pv').boundingBox();
  await page.mouse.dblclick(pb3.x + 6, pb3.y + 60);
  await sleep(150);
  pg = await pvGeo();
  ok(pg.w === 370 && pg.saved === '370', 'a double-click resets the preview to 370', [pg.w, pg.saved]);
  /* keyboard: focus shows it; ← moves the edge left = wider */
  await page.mouse.move(700, 450);
  await page.focus('.rr-grip.is-pv');
  await page.keyboard.press('ArrowLeft');
  await sleep(250);
  pg = await pvGeo();
  ok(pg.w === 386 && pg.op === 1 && pg.tip === 'block', 'keyboard focus shows the grip and its readout; ← widens by 16 (370 → 386)', { w: pg.w, op: pg.op, tip: pg.tip });
  await page.keyboard.press('Shift+ArrowRight');
  const kr = (await pvGeo()).w;
  await page.keyboard.press('Enter');
  const ke = await pvGeo();
  ok(kr === 322 && ke.w === 370 && ke.saved === '370', 'Shift+→ narrows by 64 (386 → 322, never under 280); Enter resets to 370', [kr, ke.w, ke.saved]);
  /* reload with a saved width: the column opens at it */
  await page.keyboard.press('Shift+ArrowLeft');
  await page.evaluate(() => { try { localStorage.setItem('hwb.room.railWidth', '272'); } catch { /* none */ } }); // the default rail: a widened one would tip the preview into the drawer
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.rm-roster iframe').length >= 2);
  await sleep(1200);
  await tasksFrame().evaluate(() => window.task());
  await page.waitForFunction(() => !document.getElementById('preview').hidden);
  await sleep(300);
  ok((await pvGeo()).w === 434, 'remembered per device: after a reload the preview opens at the saved 434 (370 + Shift+← 64)');
  ok(errors.length === 0, 'no page errors (preview)', errors.slice(0, 3));

  /* the phone: the preview is a full-screen layer — the description takes it, no grip */
  const pp2 = await phone.newPage();
  await pp2.goto(ROOM_URL, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  /* a panel's frame loads when its layer opens (room-round3's phone path) */
  await pp2.click('#phLine'); // the phone's one menu [phone menu]: the app is a row in its sheet
  await pp2.click('#phStrip .ph-chip:has-text("Tasks")');
  await sleep(1500);
  const pf = pp2.frames().find((f) => f.url().includes('/panels/p-tasks/frame/'));
  ok(!!pf, 'phone: the Tasks panel frame is loaded');
  if (pf) {
    await pf.evaluate(() => window.task());
    await pp2.waitForFunction(() => !document.getElementById('preview').hidden);
    await sleep(400);
    const ph2 = await pp2.evaluate(() => {
      const pv = document.getElementById('preview');
      const ex = pv.querySelector('.pv-excerpt');
      return { w: Math.round(pv.getBoundingClientRect().width), exW: Math.round(ex.getBoundingClientRect().width), exDisplay: getComputedStyle(ex).display,
        grip: getComputedStyle(document.querySelector('.rr-grip.is-pv')).display, sw: document.documentElement.scrollWidth, iw: innerWidth };
    });
    ok(ph2.w === 390 && ph2.exDisplay === 'block' && ph2.exW >= 0.8 * ph2.w, 'phone: the preview is full width and the description is shown across it (it used to be display:none there)', ph2);
    ok(ph2.grip === 'none' && ph2.sw <= ph2.iw, 'phone: no preview grip, no sideways scroll', ph2);
    await pp2.screenshot({ path: join(SHOTS, 'room-preview-390.png') });
  }
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
