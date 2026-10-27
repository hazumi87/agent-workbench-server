/* POLL TRAFFIC — what the CLI Manager window pulls over the wire at rest
 * [perf/poll-traffic] (traffic report 2026-09-29: the manager's GET /api/table
 * every 2.5 s was 712 KB, 606 KB of it logo SVG copied into every row).
 *
 *   node test/traffic.probe.mjs                 60 s window, prints a table
 *   TRAFFIC_SECS=20 node test/traffic.probe.mjs  a shorter window
 *   TRAFFIC_OUT=/path.json node test/traffic.probe.mjs   also write the numbers
 *   TRAFFIC_MAX_BPS=20000 ...                   FAIL when steady state exceeds it
 *
 * A real Chromium opens the shell with three tabs: the CLI Manager (VISIBLE)
 * and two workrooms (BACKGROUND), over a table shaped like Owner's (17 logo
 * sets at ~18 KB, 144 rows: 117 killed, 6 dehydrated, 21 live; 3 rooms with
 * art). CDP counts every response's encoded bytes (headers + body, as the
 * network sees them) and every websocket frame, per endpoint, for the window.
 * Then one FOCUS of the manager is measured on its own (the focus storm).
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(248), DEAD broker
 * P(249), temp table seeded through the store (test/traffic.seed.ts): no pty,
 * no broker, never Owner's data, childEnv() scrubbed, fabric + NATS off.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(248);
const DEAD_BROKER_PORT = P(249);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-traffic-token';
const SECS = Number(process.env.TRAFFIC_SECS) || 60;
const MAX_BPS = Number(process.env.TRAFFIC_MAX_BPS) || 0;

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

/** An endpoint's bucket name: the path with ids folded, so every room's
 *  GET /api/rooms/:id lands in one row. */
function bucket(url) {
  let p;
  try { p = new URL(url).pathname; } catch { return url; }
  return p
    .replace(/^\/api\/rooms\/[^/]+/, '/api/rooms/:id')
    .replace(/^\/api\/art\/[^/]+/, '/api/art/:key')
    .replace(/^\/api\/rooms\/:id\/line$/, '/api/rooms/:id/line');
}

try {
  const stale = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
  if (stale.ok) {
    console.log(` FAIL  :${PORT} is already serving something — a leaked engine from an aborted run?`);
    process.exit(1);
  }
} catch { /* nothing there */ }
for (const p of [PORT, DEAD_BROKER_PORT]) {
  await assertFree(p, 'traffic.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-traffic-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null;
let browser = null;
let engineLog = '';
const seed = async (phase) => {
  const r = await runTsx([join('test', 'traffic.seed.ts'), phase], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (r.code !== 0) { throw new Error(`seed ${phase} failed: ${r.err}`); }
  return JSON.parse(r.out.trim().split('\n').pop());
};

try {
  await seed('pre');
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
  const post = await seed('post');
  const [R1, R2] = post.rooms.map((r) => r.id);
  const table = await (await fetch(`${BASE}/api/table`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  ok(table.sessions.length === 144, 'the table holds 144 rows', table.sessions.length);

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

  /* CDP: encoded bytes per request (headers + body as transferred) and
     websocket frames. Same-origin iframes share this target. */
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const urls = new Map();
  let counting = false;
  let stats = new Map();
  const add = (key, bytes) => {
    if (!counting) { return; }
    const s = stats.get(key) || { n: 0, bytes: 0, s304: 0 };
    s.n += 1;
    s.bytes += bytes;
    stats.set(key, s);
    return s;
  };
  const status = new Map();
  cdp.on('Network.requestWillBeSent', (e) => urls.set(e.requestId, e.request.url));
  cdp.on('Network.responseReceived', (e) => { if (!status.has(e.requestId)) { status.set(e.requestId, e.response.status); } });
  /* the WIRE status: a revalidated 304 reaches the page as its cached 200 */
  cdp.on('Network.responseReceivedExtraInfo', (e) => status.set(e.requestId, e.statusCode));
  cdp.on('Network.loadingFinished', (e) => {
    const u = urls.get(e.requestId);
    if (!u) { return; }
    const s = add(bucket(u), e.encodedDataLength);
    if (s && status.get(e.requestId) === 304) { s.s304 += 1; }
  });
  cdp.on('Network.webSocketFrameReceived', (e) => add('ws (received)', (e.response?.payloadData || '').length));
  cdp.on('Network.webSocketFrameSent', (e) => add('ws (sent)', (e.response?.payloadData || '').length));

  const tabs = ['/manager.html', `/room.html?room=${R1}`, `/room.html?room=${R2}`];
  await page.goto(`${BASE}/app/shell.html?kind=manager&tabs=${tabs.map(encodeURIComponent).join(',')}`, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  /* the manager is the visible tab */
  await page.evaluate(() => document.querySelector('.hwb-tab.is-hub')?.click());
  await sleep(4000);
  const shown = await page.evaluate(() => [...document.querySelectorAll('#stage iframe')].map((f) => ({ src: f.getAttribute('src'), shown: getComputedStyle(f).display !== 'none' })));
  const visible = shown.filter((f) => f.shown);
  ok(shown.length === 3 && visible.length === 1 && /manager\.html/.test(visible[0].src), 'three tabs, the manager visible, two rooms in the background', shown);

  counting = true;
  stats = new Map();
  const t0 = Date.now();
  await sleep(SECS * 1000);
  const secs = (Date.now() - t0) / 1000;
  counting = false;
  const steady = stats;

  const rowsOf = (m, s) => [...m.entries()].sort((a, b) => b[1].bytes - a[1].bytes).map(([k, v]) => ({ endpoint: k, requests: v.n, n304: v.s304, bytes: v.bytes, bps: Math.round(v.bytes / s) }));
  const steadyRows = rowsOf(steady, secs);
  const total = steadyRows.reduce((a, r) => a + r.bytes, 0);
  console.log(`\n  steady state, ${secs.toFixed(0)} s (1 visible manager + 2 background rooms):`);
  console.log(`  ${'endpoint'.padEnd(30)} ${'reqs'.padStart(5)} ${'304'.padStart(4)} ${'bytes'.padStart(11)} ${'B/s'.padStart(9)}`);
  for (const r of steadyRows) {
    console.log(`  ${r.endpoint.padEnd(30)} ${String(r.requests).padStart(5)} ${String(r.n304).padStart(4)} ${String(r.bytes).padStart(11)} ${String(r.bps).padStart(9)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(30)} ${''.padStart(5)} ${''.padStart(4)} ${String(total).padStart(11)} ${String(Math.round(total / secs)).padStart(9)}`);

  /* ONE FOCUS of the manager (alt-tab / click into the window) */
  counting = true;
  stats = new Map();
  await page.evaluate(() => {
    const f = [...document.querySelectorAll('#stage iframe')].find((x) => /manager\.html/.test(x.getAttribute('src') || ''));
    f.contentWindow.dispatchEvent(new Event('focus'));
    f.contentWindow.dispatchEvent(new Event('pageshow'));
    f.contentDocument.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(2000);
  counting = false;
  const focusRows = rowsOf(stats, 1);
  const focusTotal = focusRows.reduce((a, r) => a + r.bytes, 0);
  console.log(`\n  one manager focus (focus + pageshow + visibilitychange), 2 s: ${focusTotal} bytes`);
  for (const r of focusRows) {
    console.log(`    ${r.endpoint.padEnd(28)} ${String(r.requests).padStart(4)} req ${String(r.bytes).padStart(10)} B`);
  }

  /* SHOW A ROOM: it polls at once; the manager, now hidden, stops [perf/poll-traffic] */
  if (process.env.TRAFFIC_SWITCH !== '0') {
    counting = true;
    stats = new Map();
    const clicked = await page.evaluate(() => {
      const chip = [...document.querySelectorAll('.hwb-tab[data-tab]')].find((el) => /Traffic Room 0/.test(el.textContent || ''));
      chip?.click();
      return !!chip;
    });
    await sleep(1200);
    const onShow = stats.get('/api/rooms/:id')?.n ?? 0;
    stats = new Map();
    await sleep(6000);
    counting = false;
    console.log(`\n  after showing a room: ${onShow} room poll(s) in 1.2 s; then 6 s: ${JSON.stringify(Object.fromEntries([...stats].map(([k, v]) => [k, v.n])))}`);
    ok(clicked, 'the room tab is selected');
    ok(onShow >= 1, 'the shown room polls at once', onShow);
    ok(!stats.has('/api/table'), 'the hidden manager does not poll /api/table', stats.get('/api/table'));
    ok((stats.get('/api/rooms/:id')?.n ?? 0) <= 4, 'only the visible room polls (2.5 s)', stats.get('/api/rooms/:id')?.n);

    /* SEAT FRAMES: click through the room's four live seats; at most the shown
       one plus the two most recently shown stay attached */
    const roomFrame = page.frames().find((f) => { const u = new URL(f.url()); return u.pathname === '/room.html' && u.searchParams.get('room') === R1; });
    const counts = [];
    for (const h of ['p0', 'p1', 'p2', 'p3']) {
      await roomFrame.click(`#roster .seat[data-handle="${h}"] .seat-handle`);
      await sleep(700);
      counts.push(await roomFrame.evaluate(() => document.querySelectorAll('#seatView iframe').length));
    }
    await roomFrame.click('#roster .is-room');
    await sleep(500);
    const afterLine = await roomFrame.evaluate(() => ({ frames: document.querySelectorAll('#seatView iframe').length, line: !document.getElementById('roomLine').hidden }));
    console.log(`  seat frames while clicking through 4 seats: ${counts.join(', ')}; back on the line: ${JSON.stringify(afterLine)}`);
    ok(counts.join() === '1,2,3,3', 'seat frames are capped: the shown one + the 2 most recent hidden', counts);
    ok(afterLine.line && afterLine.frames === 2, 'back on the room line: the 2 most recent frames stay, hidden', afterLine);
  }

  ok(errors.length === 0, 'no page errors', errors.slice(0, 3));
  if (MAX_BPS) {
    ok(total / secs <= MAX_BPS, `steady state at or under ${MAX_BPS} B/s`, Math.round(total / secs));
  }
  if (process.env.TRAFFIC_OUT) {
    writeFileSync(process.env.TRAFFIC_OUT, JSON.stringify({ secs, steady: steadyRows, total, bps: Math.round(total / secs), focus: focusRows, focusTotal }, null, 2));
  }
} catch (e) {
  failures += 1;
  console.log(` FAIL  ${e?.stack || e}`);
  if (engineLog) { console.log(engineLog.slice(-1500)); }
} finally {
  await browser?.close().catch(() => {});
  if (engine) {
    engine.kill('SIGKILL');
  }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows EPERM: the killed engine can still hold the db */ }
}
console.log(failures === 0 ? '\nPASS' : `\nFAIL ${failures}`);
process.exit(failures === 0 ? 0 : 1);
