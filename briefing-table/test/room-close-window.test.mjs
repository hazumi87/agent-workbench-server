/**
 * The seat menu's Close window (Owner 2026-09-28: "even within the room I can
 * close the user's window if I want") through a real scratch engine + broker:
 * POST /api/rooms/:id/seats/:seatId/close-window.
 *   - a bearer (no human) is 403, and nothing is told or parked;
 *   - a seat with no live occupant is 404 (no window to close);
 *   - a ROOM FRAME (attach roomFrame:true, a room page's own view of the
 *     seat) is not a window: occupant.windows counts only the real ones, the
 *     push skips it; the session is parked all the same, so when the frame
 *     later detaches (the room navigates away) the pane is still not armed
 *     for the reaper and is still live after the reap window;
 *   - a person: 200 {closed:{browser:<windows told>, native:false}}; every
 *     WINDOW socket gets {type:'pane.close-window', paneid};
 *   - with no room frame attached the session is PARKED: once the window
 *     goes, the pane is never armed for the close-grace reaper and stays live,
 *     while a control pane closed the ordinary way (no park) is armed and
 *     reaped (HARBOR_WB_REAP_MS=1500).
 * Two bash panes (cli-manager recipes: nothing real is launched).
 * SAFETY: scratch engine P(196) + scratch broker P(197), temp table,
 * childEnv(), fabric + NATS off; never :7420/:7430/:8200/:8201/:8204. The temp
 * dir is removed.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { P, assertFree, childEnv, scratchShell } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(196);
const BROKER_PORT = P(197);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'room-close-window-test-token';
const TARGETS = JSON.stringify({ targets: [{ id: 'local', label: 'Local', kind: 'local', shell: scratchShell() }] });

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  + ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  X ${msg}`);
  }
}
const eq = (a, b, msg) => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  ok(x === y, x === y ? msg : `${msg} (got ${x}, want ${y})`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
async function call(path, { json, as } = {}) {
  const headers = as === 'person' ? { cookie } : { authorization: `Bearer ${TOKEN}` };
  const init = { method: json === undefined ? 'GET' : 'POST', headers };
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  const res = await fetch(BASE + path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}

function client() {
  const ws = new WebSocket(`ws://${HOST}:${PORT}/pty`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const log = [];
  const waiters = [];
  ws.on('error', () => {});
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    log.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        waiters.splice(i, 1)[0].resolve(msg);
      }
    }
  });
  return {
    log,
    open: () => new Promise((resolve) => {
      ws.once('open', () => resolve(true));
      ws.once('error', () => resolve(false));
    }),
    send: (cmd) => ws.send(JSON.stringify(cmd)),
    wait: (pred, timeoutMs = 8000) =>
      new Promise((resolve) => {
        const hit = log.find(pred);
        if (hit) {
          return resolve(hit);
        }
        const t = setTimeout(() => resolve(null), timeoutMs);
        waiters.push({
          pred,
          resolve: (m) => {
            clearTimeout(t);
            resolve(m);
          },
        });
      }),
    close: () => ws.close(),
  };
}

async function until(fn, ms, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(step);
  }
}

async function run() {
  for (const p of [PORT, BROKER_PORT]) {
    await assertFree(p, 'room-close-window.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-closewin-'));
  const dbPath = join(tmpDir, 'mapping.db');
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  let log = '';
  let broker = null;
  let engine = null;
  const panes = [];
  let c1 = null;
  let c2 = null;
  let c3 = null;
  let c4 = null;
  let c5 = null;
  const up = async (url) => {
    for (let i = 0; i < 120; i++) {
      if (await fetch(url).then((r) => r.ok).catch(() => false)) return true;
      await sleep(250);
    }
    return false;
  };
  const kill = async (proc) => {
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      const gone = new Promise((r) => proc.once('exit', r));
      proc.kill('SIGTERM');
      await Promise.race([gone, sleep(3000)]);
    }
  };
  try {
    broker = spawn(process.execPath, ['--import', loaderArg, 'node_modules/pty-broker/src/main.ts'], {
      cwd: REPO_ROOT,
      env: childEnv({ PTY_BROKER_PORT: String(BROKER_PORT) }),
    });
    broker.stdout.on('data', (d) => (log += d));
    broker.stderr.on('data', (d) => (log += d));
    if (!(await up(`http://${HOST}:${BROKER_PORT}/health`))) throw new Error(`broker did not come up\n${log}`);
    engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_PORT: String(PORT),
        HARBOR_WB_HOST: HOST,
        HARBOR_WB_TABLE: dbPath,
        HARBOR_WB_TOKEN: TOKEN,
        HARBOR_WB_IDENTITY: 'legacy',
        HARBOR_WB_NO_WINDOW: '1',
        HARBOR_WB_DESKTOP: 'none',
        HARBOR_WB_REAP_MS: '1500',
        HARBOR_WB_BROKER_AUTOSTART: '0',
        HARBOR_WB_BROKER_PORT: String(BROKER_PORT),
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_NODE: 'testnode',
        HARBOR_WB_TARGETS: TARGETS,
      }),
    });
    engine.stdout.on('data', (d) => (log += d));
    engine.stderr.on('data', (d) => (log += d));
    if (!(await up(`${BASE}/health`))) throw new Error(`engine did not come up\n${log}`);
    const login = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(TOKEN)}`,
      redirect: 'manual',
    });
    cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    ok(/wb_auth=/.test(cookie), 'a person cookie');

    console.log('\n[a live pane with two windows, a control pane with one, an empty seat]');
    c1 = client();
    c2 = client();
    c3 = client();
    c4 = client();
    ok((await c1.open()) && (await c2.open()) && (await c3.open()) && (await c4.open()), 'three windows and a room frame open /pty');
    const recipes = [];
    for (const [name, agent] of [['Closewin Agent', 'closewin-agent'], ['Closewin Control', 'closewin-control']]) {
      const recipe = (await call('/api/recipes', { json: { name, target: 'local', projectDir: tmpDir, vendor: 'cli-manager', agent } })).body?.recipe;
      ok(!!recipe?.id, `recipe ${name}`);
      recipes.push(recipe);
      panes.push(`recipe:${recipe?.id}`);
    }
    const [A, B] = panes;
    c1.send({ type: 'attach', paneid: A, recipe: recipes[0].id });
    ok(!!(await c1.wait((m) => m.type === 'pane.ready' && m.paneid === A, 12000)), 'pane A spawns a real pty (window 1)');
    c2.send({ type: 'attach', paneid: A, recipe: recipes[0].id, intent: 'reclaim' });
    ok(!!(await c2.wait((m) => m.type === 'pane.ready' && m.paneid === A, 12000)), 'pane A has a second window (window 2)');
    c3.send({ type: 'attach', paneid: B, recipe: recipes[1].id });
    ok(!!(await c3.wait((m) => m.type === 'pane.ready' && m.paneid === B, 12000)), 'control pane B spawns (window 3)');
    c4.send({ type: 'attach', paneid: A, recipe: recipes[0].id, intent: 'reclaim', roomFrame: true });
    ok(!!(await c4.wait((m) => m.type === 'pane.ready' && m.paneid === A, 12000)), 'a room page frames pane A (roomFrame)');
    const room = (await call('/api/rooms', { json: { name: 'Closewin Room' }, as: 'person' })).body;
    ok(!!room?.id, 'a room');
    let r = await call(`/api/rooms/${room.id}/seats`, { json: { recipe_id: recipes[0].id, handle: 'agent', policy: 'persistent', occupant: A }, as: 'person' });
    eq(r.status, 200, 'seat @agent bound to pane A');
    const agentSeat = r.body?.seat?.id;
    r = await call(`/api/rooms/${room.id}/seats`, { json: { recipe_id: recipes[1].id, handle: 'idle', policy: 'persistent' }, as: 'person' });
    eq(r.status, 200, 'an empty seat @idle');
    const idleSeat = r.body?.seat?.id;
    let view = (await call(`/api/rooms/${room.id}`)).body;
    const seatA = view?.seats?.find((s) => s.id === agentSeat);
    eq([seatA?.status, seatA?.occupant?.state, seatA?.occupant?.attached, seatA?.occupant?.windows], ['live', 'live', true, 2], '@agent reads live, attached, windows 2 (the room frame is not counted)');
    eq(seatA?.occupant?.frames, 1, 'the seat occupant carries frames 1 (the room frame)');
    const tblRow = ((await call('/api/table')).body?.sessions ?? []).find((s) => s.paneid === A);
    eq([tblRow?.windows, tblRow?.frames], [2, 1], '/api/table carries the same windows and frames counts');

    const closePushes = () => [c1, c2, c3, c4].map((c) => c.log.filter((m) => m.type === 'pane.close-window').length);

    console.log('\n[human-only]');
    r = await call(`/api/rooms/${room.id}/seats/${agentSeat}/close-window`, { json: {} });
    eq(r.status, 403, 'a bearer (no human) is refused');
    eq(r.body?.field, 'credential', '...naming the credential');
    await sleep(300);
    eq(closePushes(), [0, 0, 0, 0], 'the refusal told no window');
    ok(!/close-window from a room/.test(log), 'the refusal parked nothing');

    console.log('\n[no live occupant]');
    r = await call(`/api/rooms/${room.id}/seats/${idleSeat}/close-window`, { json: {}, as: 'person' });
    eq(r.status, 404, 'an empty seat: 404');
    ok(/no live session/.test(r.body?.error ?? ''), `...and it says why (${r.body?.error})`);
    r = await call(`/api/rooms/${room.id}/seats/no-such-seat/close-window`, { json: {}, as: 'person' });
    eq(r.status, 404, 'an unknown seat: 404');

    console.log('\n[a person closes @agent\'s windows while a room frames it]');
    r = await call(`/api/rooms/${room.id}/seats/${agentSeat}/close-window`, { json: {}, as: 'person' });
    eq(r.status, 200, 'a person closes the window');
    eq(r.body?.closed, { browser: 2, native: false }, 'two windows told, no native window (no desktop)');
    eq([r.body?.ok, r.body?.paneid], [true, A], 'the answer names the pane');
    ok(!!(await c1.wait((m) => m.type === 'pane.close-window' && m.paneid === A, 3000)), 'window 1 got pane.close-window for A');
    ok(!!(await c2.wait((m) => m.type === 'pane.close-window' && m.paneid === A, 3000)), 'window 2 got pane.close-window for A');
    eq([closePushes()[2], closePushes()[3]], [0, 0], 'neither the control pane\'s window nor the ROOM FRAME got pane.close-window');
    ok(!!(await c4.wait((m) => m.type === 'pane.frame-closed' && m.paneid === A, 3000)), 'the ROOM FRAME got pane.frame-closed for A (Owner 2026-10-03)');
    eq([c1, c2, c3].map((c) => c.log.filter((m) => m.type === 'pane.frame-closed').length), [0, 0, 0], 'no window got pane.frame-closed');
    ok(/park paneid=recipe:\S+ \(close-window from a room, session pinned; 1 room frame\(s\) stay attached\)/.test(log), 'parked even though the room frame stays attached');
    c1.close();
    c2.close();
    c1 = c2 = null;
    const onlyFrame = await until(async () => {
      const s = ((await call(`/api/rooms/${room.id}`)).body?.seats ?? []).find((x) => x.id === agentSeat);
      return s?.occupant?.windows === 0 ? s : null;
    }, 3000);
    eq([onlyFrame?.status, onlyFrame?.occupant?.state, onlyFrame?.occupant?.attached, onlyFrame?.occupant?.windows], ['live', 'live', true, 0],
      'the windows went; the room frame still views it: live, attached, windows 0 (the menu item is disabled)');

    const armedFor = async () => ((await call('/api/diag/activity')).body?.reaper?.armed ?? []).map((a) => a.paneid);

    console.log('\n[the room frame detaches (the room navigates away): still pinned]');
    c4.close();
    c4 = null;
    ok(!!(await until(async () => ((await call(`/api/rooms/${room.id}`)).body?.seats ?? []).find((x) => x.id === agentSeat)?.occupant?.attached === false, 3000)), 'the seat reads unattached (no viewer at all)');
    ok(!(await armedFor()).includes(A), 'pane A is NOT armed for the reaper after its last viewer (the frame) left');
    await sleep(3000); // past the 1.5 s reap
    eq(((await call('/api/table')).body?.sessions ?? []).find((s) => s.paneid === A)?.state, 'live', 'pane A is still live after the reap window');

    console.log('\n[no room frame: the session is parked]');
    c5 = client();
    ok(await c5.open(), 'a new window opens /pty');
    c5.send({ type: 'attach', paneid: A, recipe: recipes[0].id, intent: 'reclaim' });
    ok(!!(await c5.wait((m) => m.type === 'pane.ready' && m.paneid === A, 12000)), '...and attaches pane A (a reattach restores the normal grace)');
    ok(!!(await until(async () => ((await call(`/api/rooms/${room.id}`)).body?.seats ?? []).find((x) => x.id === agentSeat)?.occupant?.windows === 1, 3000)), 'the seat reads windows 1');
    r = await call(`/api/rooms/${room.id}/seats/${agentSeat}/close-window`, { json: {}, as: 'person' });
    eq(r.body?.closed, { browser: 1, native: false }, 'one window told');
    ok(!!(await c5.wait((m) => m.type === 'pane.close-window' && m.paneid === A, 3000)), 'the window got pane.close-window for A');
    ok(/park paneid=recipe:\S+ \(close-window from a room, session pinned\)/.test(log), 'the engine parked the session (no room frame)');

    console.log('\n[the windows go; the session stays]');
    c5.close();
    c3.close(); // the control: closed the ordinary way, no park
    c3 = c5 = null;
    ok(!!(await until(async () => (await armedFor()).includes(B), 3000)), 'the control pane is armed for the reaper');
    ok(!(await armedFor()).includes(A), 'the closed-window pane is NOT armed (parked)');
    view = (await call(`/api/rooms/${room.id}`)).body;
    const seatA2 = view?.seats?.find((s) => s.id === agentSeat);
    eq([seatA2?.status, seatA2?.occupant?.state, seatA2?.occupant?.attached], ['parked', 'live', false], '@agent reads parked: live, no window');
    await sleep(3500); // past the 1.5 s reap
    const tbl = (await call('/api/table')).body?.sessions ?? [];
    eq(tbl.find((s) => s.paneid === A)?.state, 'live', 'pane A is still live after the reap window');
    ok(tbl.find((s) => s.paneid === B)?.state !== 'live', `the control pane was reaped (${tbl.find((s) => s.paneid === B)?.state})`);
  } catch (e) {
    failed++;
    failures.push(`threw: ${e?.stack ?? e}`);
    console.log(`  X threw: ${e?.stack ?? e}`);
    console.log(`--- log tail ---\n${log.slice(-2500)}`);
  } finally {
    const k = client();
    if (await k.open()) {
      for (const pane of panes) {
        k.send({ type: 'kill', paneid: pane });
      }
      await sleep(500);
    }
    k.close();
    for (const c of [c1, c2, c3, c4, c5]) {
      c?.close();
    }
    await kill(engine);
    await kill(broker);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows EPERM: the killed engine can still hold the dir */ }
  }
  console.log(`\nPASS ${passed} FAIL ${failed}`);
  if (failed) {
    console.log(failures.map((f) => ` - ${f}`).join('\n'));
    process.exit(1);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
