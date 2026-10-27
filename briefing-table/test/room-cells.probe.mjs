/* ROOM CELLS — the left column as collapsible cells: seats, then one per
 * room PANEL (the design system room-cells-v1, ticket; engine: engine/room-panels).
 *
 *   node test/room-cells.probe.mjs
 *
 * The panels and their app frames are stubbed in the browser, in the engine's
 * shape ({id,title,icon,order,seat_handle,scripts,url,frameUrl}); the engine's
 * own proxy/token behaviour is test/room-panels.test.mjs. Proves:
 *   - order: seats first, then panels by order; the owner line
 *   - the iframe: src = frameUrl (never url), sandbox with allow-scripts only
 *     for scripts:true and NEVER allow-same-origin, referrerpolicy=no-referrer
 *   - src never changes across polls while frameUrl is unchanged
 *   - THE RAIL HEIGHT BUDGET [ticket]: {panel:height, px, glance?} is what a
 *     frame WANTS; the open cells share the rail's visible height (glance
 *     first, then the clipped cells grow, smallest need first, a cell never past its px, no blank
 *     rail below a clipped cell). {panel:count}; {panel:open}
 *     → the host lightbox, Esc closes
 *   - an app that does not answer: "<title> isn't answering · retry"
 *   - collapse kept per room per cell across a reload; phone: apps folded
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(46), DEAD broker P(47).
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
const PORT = P(46);
const DEAD_BROKER_PORT = P(47);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-cells-token';
const SHOTS = process.env.PROBE_SHOTS || tmpdir(); // PROBE_SHOTS=<dir>: the budget screenshot [ticket]

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
  await assertFree(p, 'room-cells.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-cells-'));
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
      name: 'Cells Probe',
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
  const F = (id) => `/api/rooms/${R}/panels/${id}/frame/t/tok-${id}/`;
  const PANELS = [
    { id: 'p-assets', room_id: R, kind: 'view', title: 'Assets', icon: 'assets', order: 2, seat_handle: null, scripts: false, url: 'http://127.0.0.1:9/never', frameUrl: F('p-assets') },
    { id: 'p-tasks', room_id: R, kind: 'view', title: 'Tasks', icon: 'tasks', order: 1, seat_handle: 'awake', scripts: true, url: 'http://127.0.0.1:9/never', frameUrl: F('p-tasks') },
    { id: 'p-files', room_id: R, kind: 'app', title: 'Files', icon: 'assets', order: 4, seat_handle: null, scripts: true, uploads: true, url: 'http://127.0.0.1:9/never', frameUrl: F('p-files') },
    { id: 'p-down', room_id: R, kind: 'view', title: 'Broken', icon: '<img src=x onerror=alert(1)>', order: 3, seat_handle: null, scripts: true, url: 'http://127.0.0.1:9/never', frameUrl: F('p-down') },
  ].sort((a, b) => a.order - b.order);
  await context.route(new RegExp(`/api/rooms/${R}(\\?.*)?$`), async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.panels = PANELS;
    await route.fulfill({ response: res, json: body });
  });
  const hits = { 'p-tasks': 0, 'p-assets': 0, 'p-down': 0, 'p-files': 0 };
  const uploads = [];
  await context.route(new RegExp(`/api/rooms/${R}/assets$`), async (route) => {
    const q = route.request();
    uploads.push({ method: q.method(), name: q.headers()['x-filename'], type: q.headers()['content-type'], auth: q.headers().authorization ?? null, body: q.postData() });
    await route.fulfill({ json: { ok: true } });
  });
  const frameStub = async (route) => {
    const m = route.request().url().match(/\/panels\/(p-[a-z]+)\/frame\/t\/[^/]+\/(.*)$/);
    const id = m[1];
    if (route.request().method() === 'GET' && m[2] === '') { hits[id]++; }
    if (id === 'p-down') { await route.fulfill({ status: 502, body: 'bad gateway' }); return; }
    const html = id === 'p-files'
      ? `<!doctype html><body style="margin:0">files<script>
          window.__got = [];
          addEventListener('message', (e) => { if (e.source === parent) window.__got.push(e.data); });
          window.doCopy = () => parent.postMessage({panel:'copy', text:'http://100.64.0.1:8215/raw/rooms/x/a.png'}, '*');
          window.doDrop = () => parent.postMessage({panel:'drop', files:[new File(['hello'], 'ünï note.txt', {type:'text/plain'})]}, '*');
          window.doFlood = () => parent.postMessage({panel:'paste', files:Array.from({length:11}, (_, i) => new File(['x'], 'f' + i + '.txt'))}, '*');
          window.doOver = () => parent.postMessage({panel:'dragover'}, '*');
        </script></body>`
      : id === 'p-tasks'
      ? `<!doctype html><body style="margin:0;background:#123">tasks<script>
          parent.postMessage({panel:'height', px:1000}, '*');
          parent.postMessage({panel:'count', n:4}, '*');
          document.body.addEventListener('click', () => parent.postMessage({panel:'open', url:'shots/a.png', title:'Shot A'}, '*'));
          window.forge = () => parent.postMessage({panel:'drop', files:[new File(['evil'], 'forged.txt')]}, '*');
        </script></body>`
      : '<!doctype html><body style="margin:0">assets (no script)</body>';
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
  };
  const FRAME_RE = /\/panels\/(p-[a-z]+)\/frame\/t\/[^/]+\/(.*)$/;
  await context.route(FRAME_RE, frameStub);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => { errors.push(`dialog: ${d.message()}`); void d.dismiss(); });
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    const f = document.querySelector('form');
    (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
  }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  const ROOM_URL = `${BASE}/room.html?room=${R}`;
  await page.goto(ROOM_URL, { waitUntil: 'domcontentloaded' });
  await sleep(3500);

  const look = () => page.evaluate(() => [...document.querySelectorAll('.rm-roster .cell')].map((c) => {
    const f = c.querySelector('iframe');
    return {
      cell: c.dataset.cell, title: c.querySelector('.tt')?.textContent, n: c.querySelector('.n')?.textContent ?? '',
      collapsed: c.classList.contains('collapsed'),
      own: c.querySelector('.cell-own') && !c.querySelector('.cell-own').hidden ? c.querySelector('.cell-own').textContent : null,
      src: f?.getAttribute('src') ?? null, sandbox: f?.getAttribute('sandbox') ?? null, ref: f?.getAttribute('referrerpolicy') ?? null,
      h: f ? Math.round(f.getBoundingClientRect().height) : null,
      err: c.querySelector('.cell-err')?.textContent ?? null, icons: c.querySelectorAll('.cell-h svg.ic').length,
    };
  }));
  let L = await look();
  ok(L.map((x) => x.cell).join(',') === 'seats,p-tasks,p-assets,p-down,p-files', 'cells: seats first, then panels by order', L.map((x) => x.cell));
  L = L.filter((x) => x.cell !== 'p-files'); // the protocol panel is checked on its own below
  const [, tasks, assets, down] = L;
  ok(tasks.src === F('p-tasks') && assets.src === F('p-assets'), 'each frame is the panel\'s frameUrl, never its url', [tasks.src, assets.src]);
  ok(/allow-scripts/.test(tasks.sandbox) && !/allow-scripts/.test(assets.sandbox), 'allow-scripts only for scripts:true', [tasks.sandbox, assets.sandbox]);
  ok(L.every((x) => !x.sandbox || (!/allow-same-origin/.test(x.sandbox) && !/allow-top-navigation/.test(x.sandbox) && !/allow-modals/.test(x.sandbox))), 'NEVER allow-same-origin / top-navigation / modals', L.map((x) => x.sandbox));
  ok(tasks.ref === 'no-referrer' && assets.ref === 'no-referrer', 'referrerpolicy=no-referrer', [tasks.ref, assets.ref]);
  const gap0 = await page.evaluate(() => { const r = document.querySelector('.rm-roster'); return { client: r.clientHeight, scroll: r.scrollHeight }; });
  ok(tasks.h >= assets.h && tasks.h <= 1000 && assets.h >= 96 && assets.h <= 180, 'height (the budget): the app that asked 1000 gets at least what one that never asked gets (180 or its share), never past its ask; none under 96', [tasks.h, assets.h]);
  ok(tasks.h === 1000 || gap0.scroll <= gap0.client, '...and while it is clipped, the rail does not scroll', { tasks: tasks.h, ...gap0 });
  ok(tasks.n === '4', 'the app\'s count lands in its header', tasks.n);
  ok(tasks.own === 'via @awake' && assets.own === null, 'owner line "via @awake"; none without a seat', [tasks.own, assets.own]);
  ok(/Broken isn't answering · retry/.test(down.err ?? '') && down.src === null, 'an app that does not answer: "Broken isn\'t answering · retry", no blank frame', down.err);
  ok(down.icons === 1 && !errors.some((e) => /dialog/.test(e)), 'an icon KEY that is HTML draws the generic glyph, never the markup', down.icons);

  /* THE RAIL HEIGHT BUDGET [ticket] (Owner 2026-09-30: Tasks cut off at
     "+ New topic" while half the rail under Assets was blank). Two stub app
     cells in a 1280x900 window: TALL asks 900 with a 400 glance, SHORT asks
     200. Own context, only those two panels. Asserted on COMPUTED heights. */
  const bud = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const BPANELS = [
    { id: 'p-tall', room_id: R, kind: 'view', title: 'Tasks', icon: 'tasks', order: 1, seat_handle: null, scripts: true, url: 'http://127.0.0.1:9/never', frameUrl: F('p-tall') },
    { id: 'p-short', room_id: R, kind: 'view', title: 'Assets', icon: 'assets', order: 2, seat_handle: null, scripts: true, url: 'http://127.0.0.1:9/never', frameUrl: F('p-short') },
  ];
  await bud.route(new RegExp(`/api/rooms/${R}(\\?.*)?$`), async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.panels = BPANELS;
    await route.fulfill({ response: res, json: body });
  });
  /* a pushed room.state carries the ENGINE's panels (none): wear the stubbed
     ones there too, or the cells vanish whenever a push lands (room-rail's
     pattern) */
  await bud.routeWebSocket(/\/pty/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m === 'string' && m.includes('"room.state"')) {
        try {
          const d = JSON.parse(m);
          if (d.type === 'room.state' && Array.isArray(d.panels)) {
            d.panels = BPANELS;
            ws.send(JSON.stringify(d));
            return;
          }
        } catch { /* not ours */ }
      }
      ws.send(m);
    });
  });
  await bud.route(FRAME_RE, async (route) => {
    const id = route.request().url().match(FRAME_RE)[1];
    const first = id === 'p-tall' ? '{panel:"height", px:900, glance:400}' : '{panel:"height", px:200}';
    const rows = Array.from({ length: id === 'p-tall' ? 30 : 5 }, (_, i) => `<div style="height:30px;border-bottom:1px solid #333">${id} row ${i + 1}</div>`).join('');
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><body style="margin:0;font:12px sans-serif;color:#ccc;background:#161b22">${rows}<script>
      parent.postMessage(${first}, '*');
      window.say = (m) => parent.postMessage(m, '*');
    </script></body>` });
  });
  const bp = await bud.newPage();
  await bp.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await bp.evaluate((t) => {
    const f = document.querySelector('form');
    (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
  }, TOKEN);
  await Promise.all([bp.waitForNavigation().catch(() => {}), bp.click('form button:visible')]);
  await bp.goto(ROOM_URL, { waitUntil: 'domcontentloaded' });
  await bp.waitForFunction(() => document.querySelectorAll('.rm-roster iframe:not([hidden])').length === 2);
  await sleep(1200);
  /* the geometry, all computed: each frame's height, the rail's visible
     height, its content height, and what is NOT a frame (the budget's input) */
  const geo = () => bp.evaluate(() => {
    const rail = document.querySelector('.rm-roster');
    const fh = (id) => Math.round(document.querySelector(`.cell[data-cell="${id}"] iframe`).getBoundingClientRect().height);
    const content = [...rail.children].reduce((s, k) => s + k.getBoundingClientRect().height, 0);
    const tall = fh('p-tall');
    const short = fh('p-short');
    return { tall, short, client: rail.clientHeight, scroll: rail.scrollHeight, content: Math.round(content), other: Math.round(content - tall - short), gap: Math.round(rail.clientHeight - content) };
  });
  const bframe = async (id) => (await bp.waitForSelector(`.cell[data-cell="${id}"] iframe`)).contentFrame();
  let g = await geo();
  ok(g.tall + g.short <= g.client - g.other + 1 && g.tall > g.short && g.short >= 96 && Math.abs(g.gap) <= 1,
    'seats open, the rail is tight (less than 400 + 180 left): both scale down in proportion, none under 96, no gap', { avail: g.client - g.other, ...g });
  await bp.screenshot({ path: join(SHOTS, 'room-budget-1280x900-seats-open.png') });
  /* fold the SEATS cell: the rail it frees goes to the app cells (the seats
     section changing height is a budget trigger) */
  await bp.click('.cell[data-cell="seats"] .cell-h');
  await sleep(400);
  g = await geo();
  const availF = g.client - g.other;
  ok(availF > 600 && availF < 1100, 'setup: seats folded, at 1280x900 the rail holds both glances (400 + 200) but not both asks (900 + 200)', { availF, ...g });
  ok(g.tall > 400 && g.tall < 900, 'TALL grows past its 400 glance into the freed rail, still short of its 900 ask', g);
  ok(g.short === 200, 'SHORT (no glance) shows WHOLE at its 200 ask: its 20px need is filled before the tall one\'s 500 (water-filling), never past it', g);
  ok(Math.abs(g.gap) <= 1 && g.scroll <= g.client, 'no blank rail below the last cell while a cell is clipped, and no scroll', g);
  await (await bframe('p-short')).evaluate(() => window.say({ panel: 'height', px: 200, glance: 200 }));
  await sleep(300);
  g = await geo();
  ok(g.short === 200 && g.tall > 400 && Math.abs(g.gap) <= 1, 'SHORT reporting glance = its whole ask (200) stays exactly 200; TALL takes the rest, no gap', g);
  await bp.screenshot({ path: join(SHOTS, 'room-budget-1280x900.png') });
  /* shrink the window: TALL keeps >= its glance while the rail can hold both glances */
  await bp.setViewportSize({ width: 1280, height: 760 });
  await sleep(400);
  g = await geo();
  ok(g.client - g.other >= 600, 'setup: at 760 tall the rail still holds 400 + 200', { avail: g.client - g.other });
  ok(g.tall >= 400 && g.short === 200 && Math.abs(g.gap) <= 1, '...TALL stays >= its 400 glance, SHORT stays 200, no gap', g);
  await bp.setViewportSize({ width: 1280, height: 520 });
  await sleep(400);
  g = await geo();
  ok(g.tall >= 96 && g.short >= 96 && g.tall + g.short <= g.client - g.other + 1 && g.tall / g.short > 1.5, 'very tight: both scale down in proportion to their glances (400 : 200), none under 96', g);
  /* a bad glance is never trusted: over px, negative, a string = no glance at all */
  await (await bframe('p-tall')).evaluate(() => window.say({ panel: 'height', px: 900 }));
  await sleep(300);
  const gNone = await geo();
  for (const bad of [5000, -1, '400']) {
    await (await bframe('p-tall')).evaluate(() => window.say({ panel: 'height', px: 900, glance: 400 }));
    await sleep(250);
    await (await bframe('p-tall')).evaluate((x) => window.say({ panel: 'height', px: 900, glance: x }), bad);
    await sleep(300);
    const gb = await geo();
    ok(gb.tall === gNone.tall && gb.short === gNone.short, `a bad glance (${JSON.stringify(bad)}) is ignored: the same heights as a post with none`, { gb, gNone });
  }
  await (await bframe('p-tall')).evaluate(() => window.say({ panel: 'height', px: 900, glance: 400 }));
  await sleep(300);
  /* grow it again: back to the full answer, from the last posts alone */
  await bp.setViewportSize({ width: 1280, height: 1400 });
  await sleep(400);
  g = await geo();
  ok(g.tall === 900 && g.short === 200, 'tall enough for both asks: TALL 900, SHORT 200 — never past either', g);
  /* unfold the seats again: the budget gives the rail back to them */
  await bp.setViewportSize({ width: 1280, height: 900 });
  await sleep(400);
  const beforeSeats = await geo();
  await bp.click('.cell[data-cell="seats"] .cell-h');
  await sleep(400);
  g = await geo();
  ok(g.tall < beforeSeats.tall && g.tall + g.short <= g.client - g.other + 1 && Math.abs(g.gap) <= 1, 'seats unfolded: the app cells give it back (re-allocated, no scroll, no gap)', { beforeSeats, g });
  await bp.click('.cell[data-cell="seats"] .cell-h');
  await sleep(400);
  /* fold TALL: SHORT stays short (the freed rail is left blank, it is not clipped) */
  await bp.click('.cell[data-cell="p-tall"] .cell-h');
  await sleep(400);
  const fold = await bp.evaluate(() => Math.round(document.querySelector('.cell[data-cell="p-short"] iframe').getBoundingClientRect().height));
  ok(fold === 200, 'TALL folded: SHORT keeps 200, a short cell stays short', fold);
  await bp.click('.cell[data-cell="p-tall"] .cell-h');
  await sleep(400);
  g = await geo();
  ok(g.tall > 400 && g.short === 200 && Math.abs(g.gap) <= 1, 'TALL unfolded: the budget re-applies', g);
  /* the layout settles: no allocation loop (heights hold still over time) */
  const t0 = await geo();
  await sleep(1000);
  const t1 = await geo();
  ok(t0.tall === t1.tall && t0.short === t1.short, 'no layout loop: heights hold still', { t0, t1 });
  await bud.close();

  /* stable src across polls */
  const before = { ...hits };
  await sleep(6000);
  ok(hits['p-tasks'] === before['p-tasks'] && hits['p-assets'] === before['p-assets'], 'no reload across polls while frameUrl is unchanged', { before, after: hits });
  ok(hits['p-down'] === before['p-down'], '...and a down app is not retried on every poll', hits);

  /* the lightbox */
  const tf = page.frames().find((f) => f.url().includes('p-tasks'));
  await tf.click('body');
  await sleep(500);
  const lb = await page.evaluate(() => ({ shown: !document.getElementById('lightbox').hidden, img: document.querySelector('#lbBody img')?.getAttribute('src'), cap: document.getElementById('lbCap').textContent }));
  ok(lb.shown && lb.img?.endsWith('/panels/p-tasks/frame/t/tok-p-tasks/shots/a.png') && /Shot A/.test(lb.cap), '{panel:open} → the host lightbox, the image resolved against the frame', lb);
  await page.keyboard.press('Escape');
  ok(await page.evaluate(() => document.getElementById('lightbox').hidden), 'Esc closes it');

  /* ADD FILE: a host control over a real file input, on upload panels only */
  const addc = await page.evaluate(() => {
    const plus = document.querySelector('.cell[data-cell="p-files"] .cell-hw .cell-hadd:not([hidden])');
    const inp = document.querySelector('.cell[data-cell="p-files"] input[type=file]');
    return { files: plus?.getAttribute('aria-label') ?? null, tasks: !!document.querySelector('.cell[data-cell="p-tasks"] .cell-hadd:not([hidden])'),
      bar: !!document.querySelector('.cell-addfile, .cell-add'), accept: inp?.accept, multiple: inp?.multiple };
  });
  ok(addc.files === 'Add file' && !addc.tasks && !addc.bar && addc.accept === '*/*' && addc.multiple, 'a "+" (Add file) in the upload panel\'s header only, no bar; a file input accepting anything, multiple (Owner, room line [ref])', addc);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null), page.click('.cell[data-cell="p-files"] .cell-hadd')]);
  ok(!!chooser && chooser.isMultiple(), '...the "+" opens the file picker', !!chooser);
  await chooser.setFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('jpegbytes') });
  await sleep(1200);
  const addTo = await page.evaluate(() => document.querySelector('.cell[data-cell="p-files"] .cell-toast')?.textContent);
  ok(uploads.length === 1 && uploads[0].name === 'photo.jpg' && uploads[0].type === 'image/jpeg' && uploads[0].body === 'jpegbytes' && /Added photo\.jpg/.test(addTo ?? ''), '...a picked file uploads through the same route and the cell says so', { uploads, addTo });
  uploads.length = 0;

  /* a panel WITHOUT uploads:true cannot get the host to upload */
  await page.frames().find((f) => f.url().includes('p-tasks')).evaluate(() => window.forge());
  await sleep(800);
  ok(uploads.length === 0, 'a forged drop from a panel without uploads:true is ignored (no POST)', uploads);

  /* the room-assets protocol: copy, dragover echo, drop → upload → added */
  const ff = page.frames().find((f) => f.url().includes('p-files'));
  await ff.evaluate(() => window.doOver());
  await sleep(300);
  await ff.evaluate(() => window.doCopy());
  await sleep(400);
  const toast1 = await page.evaluate(() => document.querySelector('.cell[data-cell="p-files"] .cell-toast')?.textContent);
  ok(/Reference copied|Could not copy/.test(toast1 ?? ''), '{panel:copy} → the host copies and shows its toast', toast1);
  await ff.evaluate(() => window.doDrop());
  await sleep(1200);
  const got = await ff.evaluate(() => window.__got.map((m) => m.panel));
  ok(uploads.length === 1 && uploads[0].method === 'POST' && uploads[0].name === encodeURIComponent('ünï note.txt') && uploads[0].type === 'text/plain' && uploads[0].body === 'hello' && uploads[0].auth === null,
    '{panel:drop} → POST /api/rooms/:id/assets, raw body, x-filename URI-encoded, cookie only', uploads);
  ok(got.includes('dragover') && got[got.length - 1] === 'added', '...the app hears the dragover echo, then {panel:added}', got);
  const toast2 = await page.evaluate(() => document.querySelector('.cell[data-cell="p-files"] .cell-toast')?.textContent);
  ok(/Added ünï note\.txt to the room/.test(toast2 ?? ''), '...and the cell says what was added', toast2);
  await ff.evaluate(() => window.doFlood());
  await sleep(500);
  const toast3 = await page.evaluate(() => document.querySelector('.cell[data-cell="p-files"] .cell-toast')?.textContent);
  ok(uploads.length === 1 && /at most 10/.test(toast3 ?? ''), 'a panel cannot push more than 10 files at once (capped, said)', { uploads: uploads.length, toast3 });

  /* retry: the app comes back */
  await page.click('.cell[data-cell="p-down"] .cell-retry');
  await sleep(800);
  ok((await look()).find((x) => x.cell === 'p-down').err !== null, 'retry asks again (still down: still says so)', (await look()).find((x) => x.cell === 'p-down').err);

  /* collapse kept per room per cell */
  await page.click('.cell[data-cell="p-assets"] .cell-h');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(3000);
  L = await look();
  ok(L.find((x) => x.cell === 'p-assets').collapsed && !L.find((x) => x.cell === 'p-tasks').collapsed, 'a folded cell stays folded across a reload (per room, per cell)', L.map((x) => `${x.cell}:${x.collapsed}`));

  /* phone: apps folded by default */
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await context.storageState() });
  await phone.route(new RegExp(`/api/rooms/${R}(\\?.*)?$`), async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.panels = PANELS;
    await route.fulfill({ response: res, json: body });
  });
  await phone.route(FRAME_RE, frameStub);
  const pp = await phone.newPage();
  await pp.goto(ROOM_URL, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  /* ROOM ON PHONE v1: every app is a full-screen LAYER, reached from the
     jump strip or the Apps sheet; its own frame, same sandbox */
  const phv = () => pp.evaluate(() => ({
    chips: [...document.querySelectorAll('#phStrip .ph-chip')].map((c) => c.textContent),
    appsN: [...document.getElementById('phMeta').children].map((x) => x.textContent).join(' / '),
    inLayer: document.getElementById('main').classList.contains('in-layer'),
    title: document.getElementById('lyTitle').textContent, sub: document.getElementById('lySub').textContent,
    frames: [...document.querySelectorAll('#appView .ly-app')].filter((b) => !b.hidden).map((b) => {
      const f = b.querySelector('iframe');
      const r = f?.getBoundingClientRect();
      return { panel: b.dataset.panel, src: f?.getAttribute('src'), sandbox: f?.getAttribute('sandbox'), w: r && Math.round(r.width), h: r && Math.round(r.height) };
    }),
    cellFrames: document.querySelectorAll('.rm-roster iframe').length,
  }));
  let q = await phv();
  ok(/ \/ 4 apps$/.test(q.appsN) && ['Tasks', 'Assets', 'Files', 'Broken'].every((t) => q.chips.includes(t)), 'phone: the header counts the apps; the strip has a chip per app', q);
  await pp.click('#phLine'); // the strip is hidden by default [web/room-phone-7]
  ok(q.cellFrames === 0, 'phone: the desktop cells do not load their frames on a phone', q.cellFrames);
  await pp.click('#phStrip .ph-chip:has-text("Tasks")');
  await sleep(1500);
  q = await phv();
  const tl = q.frames[0];
  ok(q.inLayer && q.title === 'Tasks' && q.sub === 'via @awake', 'phone: the Tasks chip slides Tasks in, "via @awake"', q);
  ok(q.frames.length === 1 && tl.src === F('p-tasks') && /allow-scripts/.test(tl.sandbox) && !/allow-same-origin/.test(tl.sandbox), '...its own frame of frameUrl, the same sandbox (never same-origin)', tl);
  ok(tl.w === 390 && tl.h > 600, '...full width and height, not a 96–320 cell', tl);
  await pp.click('#lySwitch');
  await sleep(300);
  await pp.click('#phSheet .seat-app:has-text("Assets")');
  await sleep(1200);
  q = await phv();
  ok(q.title === 'Assets' && q.frames.length === 1 && q.frames[0].panel === 'p-assets', 'phone: ⇄ Switch → Assets swaps the layer (app → app, two taps)', q.frames);
  const reused = await pp.evaluate(() => document.querySelectorAll('#appView .ly-app').length);
  ok(reused === 2, '...Tasks is kept, hidden (switching back does not reload it)', reused);
  ok(await pp.evaluate(() => document.getElementById('lyAdd').hidden), 'phone: no "+" in the layer bar for an app without uploads');
  await pp.click('#lySwitch');
  await sleep(300);
  await pp.click('#phSheet .seat-app:has-text("Files")');
  await sleep(1200);
  const lyAdd = await pp.evaluate(() => { const b = document.getElementById('lyAdd'); const r = b.getBoundingClientRect(); return { hidden: b.hidden, name: b.getAttribute('aria-label'), w: Math.round(r.width), h: Math.round(r.height) }; });
  ok(!lyAdd.hidden && lyAdd.name === 'Add file' && lyAdd.w >= 44 && lyAdd.h >= 44, 'phone: an upload app gets a "+" (Add file, 44px) in its layer bar', lyAdd);
  const [pchooser] = await Promise.all([pp.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null), pp.click('#lyAdd')]);
  ok(!!pchooser && pchooser.isMultiple(), '...which opens the file picker', !!pchooser);
  await pp.click('#lyBack');
  await sleep(300);
  await pp.evaluate(() => document.getElementById('lySwitch').click()); // the Apps list lives in ⇄ Switch now [web/room-phone-7]
  await sleep(300);
  const sheet = await pp.evaluate(() => [...document.querySelectorAll('#phSheet .seat-app')].map((li) => ({ t: li.querySelector('.seat-handle')?.textContent, via: li.querySelector('.seat-meta')?.textContent, h: Math.round(li.getBoundingClientRect().height) })));
  const lay = await pp.evaluate(() => ({ bars: document.querySelectorAll('.ly-addbar, .cell-addfile').length }));
  ok(lay.bars === 0, 'phone: no Add file BAR on any app layer (Owner, room line [ref])', lay);
  ok(sheet.length === 4 && sheet[0].t === 'Tasks' && sheet[0].via === 'via @awake' && sheet.every((r) => r.h >= 56), 'phone: the Apps sheet lists every app (title, via @seat), 56px rows', sheet);
  await page.screenshot({ path: join(tmpdir(), 'room-cells-desk.png') });
  ok(errors.length === 0, 'no page errors', errors.slice(0, 3));
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
