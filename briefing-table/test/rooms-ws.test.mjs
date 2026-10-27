/**
 * Room PUSH over the existing /pty socket (the design notes §2.3, §6
 * "Pushes" row; workrooms T5) [ticket].
 *
 * A scratch engine on P() ports, a temp table, NO broker and NO pty (the broker
 * port is a dead P() port, assertFree'd, so nothing can be adopted from it).
 * Rooms are made and written through the real HTTP routes, so every push this
 * suite sees came off the room bus exactly as a user's post would produce it.
 *
 * Asserts: a socket subscribed to room A hears A's room.line / room.state and
 * NOTHING of room B (and B likewise); a socket that never subscribed hears
 * neither; subscribe is a full-set REPLACE (a room left out stops arriving);
 * a subscription dies with its socket and a fresh socket can resubscribe; the
 * diag's `subscribers` is the real count; /pty still upgrades, and nothing
 * unauthenticated does (trap 3, trap 14).
 *
 * SAFETY: never touches :7420/:7430/:8200/:8201/:8204 or the real data dir.
 * Every child env comes from childEnv(). The temp dir is removed.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { P, assertFree, childEnv, windowCookie, roomUserWrite } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(40); // scratch engine — port table in test/_scratch.mjs
const DEAD_BROKER_PORT = P(41); // nothing may listen: no pty is ever opened here
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const WS_URL = `ws://${HOST}:${PORT}/pty`;
const TOKEN = 'rooms-ws-test-token';

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
async function call(path, { method = 'GET', json, auth = true } = {}) {
  const headers = {};
  const m = json !== undefined && method === 'GET' ? 'POST' : method;
  if (auth && userCookie && roomUserWrite(path, m, json)) {
    headers.cookie = userCookie;
  } else if (auth) {
    headers.authorization = `Bearer ${TOKEN}`;
  }
  const init = { method, headers };
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
    init.method = m;
  }
  const res = await fetch(BASE + path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** A /pty client that records every frame. */
function client({ auth = true } = {}) {
  const ws = new WebSocket(WS_URL, auth ? { headers: { authorization: `Bearer ${TOKEN}` } } : {});
  const log = [];
  const waiters = [];
  let closed = false;
  ws.on('error', () => {});
  ws.on('close', () => {
    closed = true;
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
    get closed() {
      return closed;
    },
    open: () =>
      new Promise((resolve) => {
        ws.once('open', () => resolve(true));
        ws.once('error', () => resolve(false));
        ws.once('unexpected-response', () => resolve(false));
      }),
    send: (cmd) => ws.send(JSON.stringify(cmd)),
    wait: (pred, timeoutMs = 4000) =>
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
    close: () =>
      new Promise((resolve) => {
        if (closed) {
          return resolve();
        }
        ws.once('close', resolve);
        ws.close();
      }),
  };
}

const ROOM_FRAMES = new Set(['room.line', 'room.state', 'room.read']);
const roomFrames = (c, roomId) => c.log.filter((m) => ROOM_FRAMES.has(m.type) && m.roomId === roomId);
const anyRoomFrame = (c) => c.log.filter((m) => ROOM_FRAMES.has(m.type));
const subscribe = async (c, rooms) => {
  const before = c.log.length;
  c.send({ type: 'room.subscribe', rooms });
  return c.wait((m) => m.type === 'room.subscribed' && c.log.indexOf(m) >= before);
};
const diagSubscribers = async () => (await call('/api/diag/rooms')).body?.subscribers;

async function run() {
  for (const p of [PORT, DEAD_BROKER_PORT]) {
    await assertFree(p, 'rooms-ws.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-rooms-ws-'));
  let engine = null;
  let engineLog = '';
  const sockets = [];
  const mk = (opts) => {
    const c = client(opts);
    sockets.push(c);
    return c;
  };
  try {
    console.log(`booting scratch engine :${PORT} (dead broker :${DEAD_BROKER_PORT})`);
    /* --import the tsx LOADER, not the tsx CLI: the CLI re-spawns node, so
       killing it would orphan the engine on the port. */
    const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
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
        HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT),
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_NODE: 'testnode',
      }),
    });
    engine.stdout.on('data', (d) => (engineLog += d));
    engine.stderr.on('data', (d) => (engineLog += d));
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      await sleep(250);
      up = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false);
    }
    if (!up) {
      throw new Error(`engine did not come up\n${engineLog}`);
    }
    userCookie = await windowCookie(BASE, TOKEN);

    const roomA = (await call('/api/rooms', { json: { name: 'Room A' } })).body;
    const roomB = (await call('/api/rooms', { json: { name: 'Room B' } })).body;
    ok(!!roomA?.id && !!roomB?.id, 'two rooms created through the real route');
    eq((await call(`/api/rooms/${roomA.id}/seats`, { json: { project: 'auriga' } })).status, 200, 'room A has a seat');

    /* ------------------------------------------------ transport + auth ---- */
    console.log('\n[/pty still upgrades; an unauthenticated upgrade does not]');
    const anon = mk({ auth: false });
    eq(await anon.open(), false, 'an unauthenticated /pty upgrade is refused (no loopback exemption)');
    const sa = mk();
    const sb = mk();
    const sp = mk();
    ok((await sa.open()) && (await sb.open()) && (await sp.open()), 'the pty channel is unaffected: three authenticated /pty sockets open');
    eq(await diagSubscribers(), 0, 'diag: 0 subscribers before any room.subscribe');

    /* -------------------------------------------------------- subscribe ---- */
    console.log('\n[room.subscribe: echo + one snapshot per newly followed room]');
    const subA = await subscribe(sa, [roomA.id, 'no-such-room']);
    ok(!!subA, 'socket A: room.subscribed');
    eq(JSON.stringify(subA?.rooms), JSON.stringify([roomA.id]), 'the echo lists the rooms kept (an unknown id is dropped)');
    const snapA = await sa.wait((m) => m.type === 'room.state' && m.roomId === roomA.id);
    ok(!!snapA, 'socket A: a room.state snapshot for room A');
    eq(snapA?.room?.id, roomA.id, 'snapshot carries the room');
    eq(snapA?.seats?.length, 1, 'snapshot carries the seats');
    eq(snapA?.seats?.[0]?.status, 'never-started', 'seats carry the DERIVED status (the GET shape)');
    eq(snapA?.seats?.[0]?.vendor, 'unknown', 'seats carry the derived vendor (never blank)');
    const get = (await call(`/api/rooms/${roomA.id}`)).body;
    eq(JSON.stringify(snapA?.seats), JSON.stringify(get?.seats), 'the pushed seats equal GET /api/rooms/:id seats, byte for byte');
    ok(!!(await subscribe(sb, [roomB.id])), 'socket B: room.subscribed to room B');
    ok(!!(await sb.wait((m) => m.type === 'room.state' && m.roomId === roomB.id)), 'socket B: snapshot for room B');
    sp.send({ type: 'ping' });
    ok(!!(await sp.wait((m) => m.type === 'pong')), 'the pane-only socket is open and answered (it just never subscribed)');
    eq(await diagSubscribers(), 2, 'diag: 2 subscribed sockets');

    const aBefore = sa.log.length;
    const again = await subscribe(sa, [roomA.id]);
    ok(!!again, 'the same set again is accepted');
    await sleep(300);
    eq(sa.log.slice(aBefore).filter((m) => m.type === 'room.state').length, 0, 'idempotent: re-sending the same set sends NO second snapshot');

    /* ----------------------------------------------------------- pushes ---- */
    console.log('\n[pushes go only to sockets subscribed to that room]');
    const postA = await call(`/api/rooms/${roomA.id}/line`, { json: { text: '@room hello A' } });
    eq(postA.status, 200, 'a chat post in room A');
    const lineA = await sa.wait((m) => m.type === 'room.line' && m.roomId === roomA.id && m.entry?.body === '@room hello A');
    ok(!!lineA, 'socket A: room.line for room A');
    eq(lineA?.entry?.id, postA.body?.entries?.[0]?.id, 'the pushed entry is the entry the POST wrote (same id)');
    /* Gate G item 2: the seat is unfilled, so its read state is `unknown`, pushed
       once as room.read and served on the entry as `reads`. */
    const readA = await sa.wait((m) => m.type === 'room.read' && m.roomId === roomA.id && m.entryId === lineA?.entry?.id);
    eq(JSON.stringify(readA && { handle: readA.handle, state: readA.state }), JSON.stringify({ handle: 'auriga', state: 'unknown' }), 'socket A: room.read {roomId, entryId, handle, state}');
    eq(JSON.stringify(postA.body?.entries?.[0]?.reads), JSON.stringify({ auriga: 'unknown' }), 'the POST answer carries reads on the entry');
    eq(sa.log.filter((m) => m.type === 'room.read' && m.entryId === lineA?.entry?.id).length, 1, 'a not-live seat is ONE push, not not-yet then unknown');
    const postB = await call(`/api/rooms/${roomB.id}/line`, { json: { text: '@room hello B' } });
    eq(postB.status, 200, 'a chat post in room B');
    ok(!!(await sb.wait((m) => m.type === 'room.line' && m.roomId === roomB.id)), 'socket B: room.line for room B');
    eq((await call(`/api/rooms/${roomB.id}/seats`, { json: { project: 'kiosk' } })).status, 200, 'a seat added to room B');
    const stateB = await sb.wait((m) => m.type === 'room.state' && m.roomId === roomB.id && m.seats?.length === 1);
    ok(!!stateB, 'socket B: room.state pushed on a seat change');
    await sleep(400);
    eq(roomFrames(sa, roomB.id).length, 0, 'socket A heard NOTHING of room B');
    eq(roomFrames(sb, roomA.id).length, 0, 'socket B heard NOTHING of room A');
    eq(anyRoomFrame(sp).length, 0, 'the socket that never subscribed heard neither room');
    eq(anyRoomFrame(anon).length, 0, 'the refused socket heard nothing');

    /* ------------------------------------------------- full-set replace ---- */
    console.log('\n[full-set REPLACE: a room left out stops arriving]');
    const bBefore = sb.log.length;
    const both = await subscribe(sb, [roomB.id, roomA.id]);
    eq(both?.rooms?.length, 2, 'socket B now follows A and B');
    const bSnaps = () => sb.log.slice(bBefore).filter((m) => m.type === 'room.state');
    ok(!!(await sb.wait((m) => m.type === 'room.state' && m.roomId === roomA.id)), 'the NEWLY followed room A gets a snapshot');
    await sleep(200);
    eq(bSnaps().filter((m) => m.roomId === roomB.id).length, 0, 'the already-followed room B does not');
    const onlyA = await subscribe(sb, [roomA.id]);
    eq(JSON.stringify(onlyA?.rooms), JSON.stringify([roomA.id]), 'replace with [A]');
    const cut = sb.log.length;
    await call(`/api/rooms/${roomB.id}/line`, { json: { text: '@room after the replace' } });
    await call(`/api/rooms/${roomA.id}/line`, { json: { text: '@room still A' } });
    ok(!!(await sb.wait((m) => m.type === 'room.line' && m.entry?.body === '@room still A')), 'socket B still hears room A');
    await sleep(300);
    eq(sb.log.slice(cut).filter((m) => m.roomId === roomB.id).length, 0, 'socket B no longer hears room B');
    const none = await subscribe(sb, []);
    eq(none?.rooms?.length, 0, 'an empty set unsubscribes everything');
    eq(await diagSubscribers(), 1, 'diag: an empty set is not a subscriber (1 left: socket A)');

    /* ------------------------------------------- close + resubscribe ---- */
    console.log('\n[a subscription dies with its socket; a fresh one can resubscribe]');
    await sa.close();
    await sleep(200);
    eq(await diagSubscribers(), 0, 'diag: 0 after socket A closed (its set was cleared)');
    const sa2 = mk();
    ok(await sa2.open(), 'a new socket opens');
    ok(!!(await subscribe(sa2, [roomA.id])), 'and resubscribes to room A');
    ok(!!(await sa2.wait((m) => m.type === 'room.state' && m.roomId === roomA.id)), 'a fresh socket is a new follower: it gets the snapshot');
    await call(`/api/rooms/${roomA.id}/line`, { json: { text: '@room after the reconnect' } });
    ok(!!(await sa2.wait((m) => m.type === 'room.line' && m.entry?.body === '@room after the reconnect')), 'the new socket hears room A');
    eq(await diagSubscribers(), 1, 'diag: 1 subscriber');
    await sleep(200);
    eq(sa.log.filter((m) => m.entry?.body === '@room after the reconnect').length, 0, 'the closed socket received nothing more');
    ok(!engineLog.includes('room.state push failed'), 'no push failures in the engine log');
  } catch (e) {
    failed++;
    failures.push(`threw: ${e?.stack ?? e}`);
    console.log(`  ✗ threw: ${e?.stack ?? e}`);
    console.log(`--- engine log tail ---\n${engineLog.slice(-2500)}`);
  } finally {
    for (const c of sockets) {
      await Promise.race([c.close(), sleep(500)]);
    }
    if (engine && engine.exitCode === null) {
      const gone = new Promise((r) => engine.once('exit', r));
      engine.kill();
      await Promise.race([gone, sleep(3000)]);
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
