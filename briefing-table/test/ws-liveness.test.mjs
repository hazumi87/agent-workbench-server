/**
 * ENGINE-SIDE socket liveness (workrooms T5) [ticket]: the engine pings every
 * /pty client, and a peer that misses two pings in a row is terminated and
 * cleaned up exactly as a clean close is — detached, its control lease
 * released, its room subscriptions dropped — while the pty stays resident
 * (detach ≠ kill). The window half (web/transport.mjs) is unit-tested in
 * transport-liveness.test.mjs; this is the engine half, through a real engine
 * and a real pty-broker.
 *
 * A "dead" client is a real `ws` client with `autoPong: false` that sends
 * nothing after its attach: from the engine's side that is exactly a window
 * whose flow was blackholed. A live client keeps ws's default auto-pong, which
 * is what every browser does. HARBOR_WB_WS_PING_MS is set small in the child
 * env so the whole thing runs in seconds.
 *
 * Also asserts the room rule from the other side: a MEMBER pane's socket gets
 * the delivery (fabric.message) but never a room.line (wr §2.5 context tax).
 *
 * Target shell is scratchShell() (test/_scratch.mjs) — bash on POSIX,
 * powershell.exe on win32. SAFETY: scratch engine + scratch broker on P()
 * ports, temp table, childEnv(); never :7420/:7430/:8200/:8201/:8204. The
 * temp dir is removed.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { P, assertFree, childEnv, scratchShell, windowCookie, roomUserWrite } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(42); // scratch engine — port table in test/_scratch.mjs
const BROKER_PORT = P(43); // LIVE scratch broker
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const WS_URL = `ws://${HOST}:${PORT}/pty`;
const TOKEN = 'ws-liveness-test-token';
const PING_MS = 300;
const TARGETS = JSON.stringify({ targets: [{ id: 'local', label: 'Local', kind: 'local', shell: scratchShell() }] });

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)})`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let userCookie = ''; // the window cookie: a room write with no `from` is the USER's (roomUserWrite)
async function call(path, { method = 'GET', json } = {}) {
  const m = json !== undefined && method === 'GET' ? 'POST' : method;
  const headers = userCookie && roomUserWrite(path, m, json) ? { cookie: userCookie } : { authorization: `Bearer ${TOKEN}` };
  const init = { method, headers };
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
    init.method = m;
  }
  const res = await fetch(BASE + path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}
const rowOf = async (paneid) => (await call('/api/table')).body?.sessions?.find((s) => s.paneid === paneid);
const subscribers = async () => (await call('/api/diag/rooms')).body?.subscribers;

function client({ autoPong = true } = {}) {
  const ws = new WebSocket(WS_URL, { headers: { authorization: `Bearer ${TOKEN}` }, autoPong });
  const log = [];
  const waiters = [];
  let closedAt = null;
  ws.on('error', () => {});
  ws.on('close', () => {
    closedAt = Date.now();
  });
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
    get closedAt() {
      return closedAt;
    },
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
    waitClosed: async (timeoutMs) => {
      const end = Date.now() + timeoutMs;
      while (closedAt === null && Date.now() < end) {
        await sleep(25);
      }
      return closedAt;
    },
    close: () => new Promise((resolve) => {
      if (closedAt !== null) {
        return resolve();
      }
      ws.once('close', resolve);
      ws.close();
    }),
  };
}

async function run() {
  for (const p of [PORT, BROKER_PORT]) {
    await assertFree(p, 'ws-liveness.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-ws-liveness-'));
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  let log = '';
  let broker = null;
  let engine = null;
  const sockets = [];
  const mk = (opts) => {
    const c = client(opts);
    sockets.push(c);
    return c;
  };
  const up = async (url) => {
    for (let i = 0; i < 120; i++) {
      if (await fetch(url).then((r) => r.ok).catch(() => false)) {
        return true;
      }
      await sleep(250);
    }
    return false;
  };
  let pane = null;
  let keeper = null;
  try {
    /* --import the tsx LOADER, never the tsx CLI (it re-spawns node, and a kill
       would orphan the child on its port). */
    broker = spawn(process.execPath, ['--import', loaderArg, 'node_modules/pty-broker/src/main.ts'], {
      cwd: REPO_ROOT,
      env: childEnv({ PTY_BROKER_PORT: String(BROKER_PORT) }),
    });
    broker.stdout.on('data', (d) => (log += d));
    broker.stderr.on('data', (d) => (log += d));
    if (!(await up(`http://${HOST}:${BROKER_PORT}/health`))) {
      throw new Error(`broker did not come up\n${log}`);
    }
    console.log(`scratch engine :${PORT}, scratch broker :${BROKER_PORT}, ping every ${PING_MS}ms`);
    engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_PORT: String(PORT),
        HARBOR_WB_HOST: HOST,
        HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'),
        HARBOR_WB_TOKEN: TOKEN,
        HARBOR_WB_IDENTITY: 'legacy',
        HARBOR_WB_NO_WINDOW: '1',
        HARBOR_WB_NATS_URL: '',
        HARBOR_WB_FABRIC_URL: '',
        HARBOR_WB_BROKER_AUTOSTART: '0',
        HARBOR_WB_BROKER_PORT: String(BROKER_PORT),
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_NODE: 'testnode',
        HARBOR_WB_TARGETS: TARGETS,
        HARBOR_WB_WS_PING_MS: String(PING_MS),
      }),
    });
    engine.stdout.on('data', (d) => (log += d));
    engine.stderr.on('data', (d) => (log += d));
    if (!(await up(`${BASE}/health`))) {
      throw new Error(`engine did not come up\n${log}`);
    }
    userCookie = await windowCookie(BASE, TOKEN);

    const recipe = (await call('/api/recipes', { json: { name: 'Liveness Shell', target: 'local', projectDir: tmpDir, vendor: 'cli-manager' } }))
      .body?.recipe;
    ok(!!recipe?.id, 'a bash recipe');
    pane = `recipe:${recipe.id}`;
    const room = (await call('/api/rooms', { json: { name: 'Liveness Room' } })).body;

    /* ------------------------------------------------ a dead window ---- */
    console.log('\n[a peer that stops answering pings is terminated, and cleaned up like a close]');
    const dead = mk({ autoPong: false });
    ok(await dead.open(), 'the soon-dead client opens /pty');
    dead.send({ type: 'room.subscribe', rooms: [room.id] });
    ok(!!(await dead.wait((m) => m.type === 'room.subscribed')), 'it follows a room');
    dead.send({ type: 'attach', paneid: pane, recipe: recipe.id });
    const ready = await dead.wait((m) => m.type === 'pane.ready' && m.paneid === pane, 12000);
    const lastSent = Date.now(); // it sends nothing after this
    ok(!!ready, 'it attaches and spawns a real pty (pane.ready)');
    ok(!!ready && 'held' in ready && ready.held === null, 'pane.ready carries `held` (null: nothing waits) — the solo head\'s initial hold');
    const before = await rowOf(pane);
    eq(before?.attached, true, 'the table says attached');
    ok(!!before?.controller, `the table names a controller (${before?.controller})`);
    eq(await subscribers(), 1, 'diag: 1 room subscriber');

    const closedAt = await dead.waitClosed(PING_MS * 3 + 3000);
    ok(closedAt !== null, 'the engine closed the silent socket');
    const took = closedAt === null ? null : closedAt - lastSent;
    ok(took !== null && took <= PING_MS * 3 + 1500, `within ~2-3 ping intervals of its last frame (${took}ms, interval ${PING_MS}ms)`);
    await sleep(150);
    const after = await rowOf(pane);
    eq(after?.attached, false, 'the table now says attached:false (no ghost window)');
    eq(after?.controller, null, 'the control lease is released (controller null)');
    eq(after?.state, 'live', 'the pty stays resident: detach, never kill');
    eq(await subscribers(), 0, 'diag: the dead socket\'s room set is gone');
    ok(/missed 2 pings/.test(log), 'the engine logged why it terminated');

    /* --------------------------------------------- a live window stays ---- */
    console.log('\n[a peer that answers pings stays; the freed lease can be reclaimed]');
    keeper = mk();
    ok(await keeper.open(), 'a well-behaved client opens /pty');
    keeper.send({ type: 'attach', paneid: pane, recipe: recipe.id, intent: 'reclaim' });
    const reReady = await keeper.wait((m) => (m.type === 'pane.reattached' || m.type === 'pane.ready') && m.paneid === pane);
    ok(!!reReady, 'it reattaches the SAME resident pane');
    ok(reReady?.type !== 'pane.ready' || ('held' in reReady && reReady.held === null), 'a reattach\'s pane.ready carries `held` too');
    const ctl = await keeper.wait((m) => m.type === 'pane.control' && m.paneid === pane && m.controlling === true);
    ok(!!ctl, 'a reclaim takes the lease: nobody is holding it any more');
    await sleep(PING_MS * 8);
    eq(keeper.closedAt, null, `still open after ${PING_MS * 8}ms (8 intervals) of ws-level pings and nothing else`);
    const kept = await rowOf(pane);
    eq(kept?.attached, true, 'the table says attached');
    ok(!!kept?.controller, 'and names the controller');

    /* --------------------------------- member pane: delivery, no line ---- */
    console.log('\n[a member pane gets its delivery, never the room line]');
    const seat = await call(`/api/rooms/${room.id}/seats`, { json: { recipe_id: recipe.id, handle: 'shell', occupant: pane } });
    eq(seat.status, 200, 'the live pane is seated as @shell');
    const posted = await call(`/api/rooms/${room.id}/line`, { json: { text: '@shell hello from the room' } });
    eq(posted.body?.status, 'delivered', 'an @shell post is delivered');
    ok(!!(await keeper.wait((m) => m.type === 'fabric.message' && m.paneid === pane)), 'the member pane socket gets the fabric.message');
    await sleep(300);
    eq(keeper.log.filter((m) => m.type === 'room.line' || m.type === 'room.state').length, 0, 'and NO room.line / room.state (it never subscribed)');
  } catch (e) {
    failed++;
    failures.push(`threw: ${e?.stack ?? e}`);
    console.log(`  ✗ threw: ${e?.stack ?? e}`);
    console.log(`--- engine/broker log tail ---\n${log.slice(-2500)}`);
  } finally {
    if (keeper && pane && keeper.closedAt === null) {
      keeper.send({ type: 'kill', paneid: pane });
      await keeper.wait((m) => m.type === 'pane.exit' && m.paneid === pane, 4000);
    }
    for (const c of sockets) {
      await Promise.race([c.close(), sleep(500)]);
    }
    for (const proc of [engine, broker]) {
      if (proc && proc.exitCode === null) {
        const gone = new Promise((r) => proc.once('exit', r));
        proc.kill();
        await Promise.race([gone, sleep(3000)]);
      }
    }
    rmSync(tmpDir, { recursive: true, force: true });
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
