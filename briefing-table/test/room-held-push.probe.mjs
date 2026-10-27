/* THE SEAT ROW MOVES THE MOMENT THE HELD QUEUE DOES (Owner 2026-09-28: "N held"
 * and the badge lagged behind a held line clearing).
 *
 *   node test/room-held-push.probe.mjs
 *
 * A REAL held line on a REAL pane: a LIVE scratch broker holds a bash pane,
 * its session row is filed as claude-code (so room-typer queues for it
 * rather than badging), and guard 9 holds the line ("claude not running":
 * a bash owns the terminal). Then the pane ENDS and the queue clears.
 *
 * With every roster GET stalled (answered only after 8 s) and every
 * `room.state` frame stripped from the page's socket, the seat row must still
 * show "1 held · …" + the badge within 1 s of the post, and lose both within
 * 1 s of the pane ending: only the engine's `room.held` / `room.waiting`
 * pushes can have done it.
 *
 * (The draft case — a draft holding the line, then the draft clearing — is
 * the engine's half, proven in test/room-reply.test.ts with the real activity
 * machine; on this host guard 9 names no-claude ahead of a draft for a bash.)
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(183), LIVE scratch
 * broker P(184), temp dir: never Owner's data, childEnv() scrubbed, fabric +
 * NATS off. Children are killed by PID.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { P, assertFree, childEnv, scratchShell, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOADER = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(183);
const BROKER_PORT = P(184);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-held-push-token';

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function up(url) {
  for (let i = 0; i < 120; i += 1) {
    await sleep(250);
    try { if ((await fetch(url)).ok) { return true; } } catch { /* not yet */ }
  }
  return false;
}

for (const p of [PORT, BROKER_PORT]) {
  await assertFree(p, 'room-held-push.probe.mjs');
}
const dir = mkdtempSync(join(tmpdir(), 'wb-room-held-push-'));
const children = [];
let log = '';
function run(args, env) {
  const c = spawn(process.execPath, ['--import', LOADER, ...args], { cwd: REPO_ROOT, env });
  c.stdout.on('data', (d) => (log += d));
  c.stderr.on('data', (d) => (log += d));
  children.push(c);
  return c;
}
let browser = null;
let ws = null;
try {
  run(['node_modules/pty-broker/src/main.ts'], childEnv({ PTY_BROKER_PORT: String(BROKER_PORT) }));
  ok(await up(`http://127.0.0.1:${BROKER_PORT}/health`), `scratch broker on ${BROKER_PORT}`);
  run([join('src', 'server', 'index.ts')], childEnv({
    HARBOR_WB_PORT: String(PORT),
    HARBOR_WB_HOST: '127.0.0.1',
    HARBOR_WB_TABLE: join(dir, 'mapping.db'),
    HARBOR_WB_TOKEN: TOKEN,
    HARBOR_WB_TOKEN_FILE: join(dir, 'engine.token'),
    HARBOR_WB_IDENTITY: 'legacy',
    HARBOR_WB_NO_WINDOW: '1',
    HARBOR_WB_BROKER_AUTOSTART: '0',
    HARBOR_WB_BROKER_PORT: String(BROKER_PORT),
    HARBOR_WB_CLAUDE_PROJECTS: join(dir, 'claude-projects'),
    HARBOR_WB_NODE: 'testnode',
    HARBOR_WB_TARGETS: JSON.stringify({ targets: [{ id: 'local', label: 'Local', kind: 'local', shell: scratchShell() }] }),
  }));
  const engineUp = await up(`${BASE}/health`);
  ok(engineUp, `scratch engine on ${PORT}`, engineUp ? undefined : log.slice(-600));
  if (!engineUp) { throw new Error('engine never came up'); }
  const cookie = await windowCookie(BASE, TOKEN);
  const call = async (path, method = 'GET', body, human = false) => {
    const headers = { 'content-type': 'application/json', ...(human ? { cookie } : { authorization: `Bearer ${TOKEN}` }) };
    const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  /* ---- a live bash pane, filed as claude-code, seated as the lead ---- */
  const recipe = (await call('/api/recipes', 'POST', { name: 'Held Push', target: 'local', projectDir: dir, vendor: 'cli-manager', agent: 'heldpush' })).body?.recipe;
  const pane = `recipe:${recipe.id}`;
  ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/pty`, { headers: { authorization: `Bearer ${TOKEN}` } });
  ws.on('error', () => {});
  const msgs = [];
  ws.on('message', (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* not json */ } });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  ws.send(JSON.stringify({ type: 'attach', paneid: pane, recipe: recipe.id }));
  for (let i = 0; i < 80 && !msgs.some((m) => m.type === 'pane.ready' && m.paneid === pane); i += 1) { await sleep(150); }
  ok(msgs.some((m) => m.type === 'pane.ready' && m.paneid === pane), 'setup: a live bash pane in the scratch broker');
  const flip = await new Promise((resolve) => {
    const c = spawn(process.execPath, [TSX_CLI, join('test', 'rooms-routes.seed.ts'), JSON.stringify({
      sessions: [{ paneid: pane, recipe_id: recipe.id, vendor: 'claude-code', agent: 'heldpush', state: 'live' }],
    })], { cwd: REPO_ROOT, env: childEnv({ HARBOR_WB_TABLE: join(dir, 'mapping.db'), HARBOR_WB_IDENTITY: 'legacy' }) });
    c.on('exit', (code) => resolve(code));
  });
  ok(flip === 0, 'setup: its session row is filed as claude-code (room-typer queues for it)', flip);
  const room = (await call('/api/rooms', 'POST', { name: 'Held push room' }, true)).body;
  const seat = await call(`/api/rooms/${room.id}/seats`, 'POST', { recipe_id: recipe.id, handle: 'boss', occupant: pane }, true);
  ok(seat.status === 200, 'setup: the pane holds the lead seat', seat.status);

  /* ---- the page, with the roster GET stalled and room.state stripped ---- */
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  let stall = false;
  let stalledGets = 0;
  let strippedStates = 0;
  await context.route((u) => u.pathname === `/api/rooms/${room.id}`, async (route) => {
    if (stall && route.request().method() === 'GET') {
      stalledGets += 1;
      await sleep(8000); // the poll's answer comes far too late to be what moved the row
    }
    await route.continue().catch(() => {});
  });
  await context.routeWebSocket(/\/pty/, (sock) => {
    const server = sock.connectToServer();
    sock.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (stall && typeof m === 'string' && m.includes('"type":"room.state"')) {
        strippedStates += 1;
        return;
      }
      sock.send(m);
    });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    const f = document.querySelector('form');
    (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
  }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  await page.goto(`${BASE}/room.html?room=${room.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#roster .seat[data-handle="boss"]');
  await page.waitForFunction(() => document.body.dataset.push === 'live', null, { timeout: 8000 }).catch(() => {});
  ok(await page.evaluate(() => document.body.dataset.push === 'live'), 'setup: the page holds a live room push');
  const row = () => page.evaluate(() => {
    const li = document.querySelector('#roster .seat[data-handle="boss"]');
    return { held: li?.querySelector('.seat-held')?.textContent ?? null, badge: li?.querySelector('.seat-count')?.textContent ?? null };
  });
  ok((await row()).held === null && (await row()).badge === null, 'setup: nothing held, no badge', await row());

  /* ---- 1. a line to the lead is HELD: the row says so within 1 s ---- */
  stall = true;
  const t0 = Date.now();
  const sent = await call(`/api/rooms/${room.id}/line`, 'POST', { text: 'hold this one' }, true);
  ok(sent.body?.deliveries?.[0]?.typed === 'queued', 'the engine holds the line (a bash owns the terminal: guard 9)', sent.body?.deliveries?.[0]);
  await page.waitForFunction(() => /^1 held/.test(document.querySelector('#roster .seat[data-handle="boss"] .seat-held')?.textContent ?? '')
    && document.querySelector('#roster .seat[data-handle="boss"] .seat-count')?.textContent === '1', null, { timeout: 3000, polling: 25 }).catch(() => {});
  const dt1 = Date.now() - t0;
  const r1 = await row();
  ok(/^1 held · /.test(r1.held ?? '') && r1.badge === '1', 'the row reads "1 held · …" and the badge 1', r1);
  ok(dt1 <= 1000, `...within 1 s of the post (${dt1} ms)`, dt1);
  const api1 = (await call(`/api/rooms/${room.id}`)).body?.seats?.[0];
  ok(api1?.occupant?.held?.depth === 1 && api1?.waiting?.count === 1, '...matching the engine (held depth 1, waiting 1)', { held: api1?.occupant?.held, waiting: api1?.waiting });

  /* ---- 2. the pane ends: the held line is dropped, the row clears within 1 s ---- */
  const t1 = Date.now();
  const end = await call(`/api/sessions/${encodeURIComponent(pane)}/end`, 'POST', {});
  ok(end.status === 200, 'the pane is ended (the queue can never be typed)', end.status);
  await page.waitForFunction(() => {
    const li = document.querySelector('#roster .seat[data-handle="boss"]');
    return !li?.querySelector('.seat-held') && !li?.querySelector('.seat-count');
  }, null, { timeout: 3000, polling: 25 }).catch(() => {});
  const dt2 = Date.now() - t1;
  const r2 = await row();
  ok(r2.held === null && r2.badge === null, 'the row loses "held" and the badge', r2);
  ok(dt2 <= 1000, `...within 1 s of the pane ending (${dt2} ms)`, dt2);
  console.log(`  info  only the pushes can have done it: ${stalledGets} roster GET(s) stalled 8 s, ${strippedStates} room.state frame(s) stripped`);
  ok(errors.length === 0, 'no page errors', errors.slice(0, 3));
} catch (e) {
  ok(false, `probe threw: ${e?.stack ?? e}`);
} finally {
  await browser?.close().catch(() => {});
  try { ws?.terminate(); } catch { /* gone */ }
  for (const c of children.reverse()) {
    if (c.pid && c.exitCode === null) {
      const gone = new Promise((r) => c.once('exit', r));
      try { process.kill(c.pid, 'SIGKILL'); } catch { /* already gone */ }
      await Promise.race([gone, sleep(3000)]);
    }
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
