/**
 * Seat menu "Reload from project defaults" (ticket) through a real scratch
 * engine, a real scratch broker and a STUB `claude` (after fabric-restore's
 * pattern) + a stub fabric (after room-cycle's pattern).
 *
 * The standard path is REMOVE + RE-ADD through the room's own existing verbs
 * (never a rebind-in-place): a reload ends the old live session as `cycle`
 * (dehydrated), removes the old seat, launches ONE fresh pane from the
 * recipe, and re-adds a seat of the SAME handle/policy per room the old pane
 * held a seat in — so every assertion below checks for a NEW seat id, not
 * the old one kept in place.
 *
 * Covers: auth (bearer refused, human cookie allowed), single-room reload
 * (new seat id, same handle, lead restored, old row dehydrated, a room
 * fact, a welcome line delivered + typed into the fresh pane), multi-room
 * (both seats rebound to the one fresh pane, a fact in each room), mid-turn
 * refusal without `force` (and success with it), a held line moved onto the
 * fresh pane, and launch failure leaving the room on the OLD (dehydrated,
 * restorable) seat (HARBOR_WB_FAIL_LAUNCH_RECIPE, the test-only hook
 * src/server/index.ts wires for exactly this — a fresh/headless launch has
 * no other realistic way to fail before it ever touches the pty).
 *
 * SAFETY: scratch engine P(316), LIVE scratch broker P(317) (stub `claude`
 * panes), stub fabric P(318); temp table, childEnv(); never
 * :7420/:7430/:8200/:8201/:8204. The temp dir is removed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

if (process.platform !== 'linux') {
  console.log('seat-reload.test: Linux only (POSIX stub claude) - skipped');
  process.exit(0);
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(316);
const BROKER_PORT = P(317);
const FABRIC_PORT = P(318);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'seat-reload-test-token';
const SENTINEL = 'SEAT-RELOAD-STUB-CLAUDE';
const LF = String.fromCharCode(10);
const FAIL_RECIPE = 'rec-failme';
const TARGETS = JSON.stringify({ targets: [{ id: 'local', label: 'Local', kind: 'local', shell: '/bin/bash' }] });

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg, got) {
  if (cond) {
    passed++;
    console.log(`  + ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  X ${msg}${got === undefined ? '' : ` (got ${JSON.stringify(got)})`}`);
  }
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg, a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 150) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(step);
  }
}

let cookie = '';
async function call(path, { json, as = 'bearer', method } = {}) {
  const headers = as === 'person' ? { cookie } : { authorization: `Bearer ${TOKEN}` };
  const init = { method: method ?? (json === undefined ? 'GET' : 'POST'), headers };
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  const res = await fetch(BASE + path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}

/* a raw /pty client, to stand in for the window that holds the OLD session
 * before a reload (room-cycle.test.mjs's client()) */
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
      if (waiters[i].pred(msg)) waiters.splice(i, 1)[0].resolve(msg);
    }
  });
  return {
    log,
    open: () => new Promise((resolve) => {
      ws.once('open', () => resolve(true));
      ws.once('error', () => resolve(false));
    }),
    send: (cmd) => ws.send(JSON.stringify(cmd)),
    wait: (pred, timeoutMs = 12000) =>
      new Promise((resolve) => {
        const hit = log.find(pred);
        if (hit) return resolve(hit);
        const t = setTimeout(() => resolve(null), timeoutMs);
        waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
      }),
    close: () => ws.close(),
  };
}

/* the stub fabric, after room-cycle.test.mjs's: /checkin mints a slug,
 * /send records, /threads opens one, /presence says no channel (room
 * delivery stays the typed path), /ack is accepted, WS /subscribe answers
 * ready + subscribed. */
function stubFabric() {
  const s = { checkins: [], sends: [], threads: [], instances: new Map() };
  const hex = () => randomBytes(4).toString('hex');
  const reply = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const http = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let b = {};
      try {
        b = raw ? JSON.parse(raw) : {};
      } catch {
        /* recorded as {} */
      }
      const inst = req.headers['x-fabric-instance'] ?? null;
      const path = req.url.split('?')[0];
      if (req.method === 'POST' && path === '/checkin') {
        const hinted = b.instance_hint && s.instances.get(b.instance_hint);
        const instance = hinted && hinted.project === b.project ? b.instance_hint : `i-${hex()}`;
        const reclaim = typeof b.remembered_slug === 'string' && b.remembered_slug.startsWith(`${b.project}-`);
        const slug = reclaim ? b.remembered_slug : `${b.project}-${hex()}`;
        s.instances.set(instance, { project: b.project, slug });
        const answer = { ok: true, instance, status: reclaim ? 'bound' : 'minted', slug };
        s.checkins.push({ body: b, answer });
        return reply(res, 200, answer);
      }
      if (req.method === 'POST' && path === '/bind') {
        return reply(res, 200, { ok: true, instance: b.instance, slug: b.slug, status: 'bound' });
      }
      if (req.method === 'POST' && path === '/send') {
        s.sends.push({ env: b, instance: inst, at: Date.now() });
        const from = inst && s.instances.has(inst) ? s.instances.get(inst).slug : b.from;
        return reply(res, 202, { ok: true, envelope: { ...b, id: `m-${s.sends.length}`, from, ack: 'none' } });
      }
      if (req.method === 'POST' && path === '/threads') {
        const thread = `th${hex()}`;
        s.threads.push({ body: b, thread });
        return reply(res, 200, { ok: true, thread, topic: b.topic ?? null, pinned: Boolean(b.pinned), opened_by: b.by, state: 'open' });
      }
      const m = /^\/threads\/([^/]+)\/acks$/.exec(path);
      if (req.method === 'GET' && m) {
        return reply(res, 200, { ok: true, thread: m[1], state: 'open', acks: [] });
      }
      if (req.method === 'GET' && path === '/presence') {
        return reply(res, 200, { ok: true, channel: false });
      }
      if (req.method === 'POST' && path === '/ack') {
        return reply(res, 200, { ok: true });
      }
      reply(res, 404, { ok: false, error: `no route for ${req.method} ${path}` });
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set();
  http.on('upgrade', (req, socket, head) => {
    if (req.url.split('?')[0] !== '/subscribe') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      ws.on('message', (raw) => {
        let f = {};
        try {
          f = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (f.type === 'subscribe') ws.send(JSON.stringify({ type: 'subscribed', slugs: f.slugs }));
      });
      ws.send(JSON.stringify({ type: 'ready' }));
    });
  });
  return {
    s,
    listen: () => new Promise((resolve, reject) => {
      http.once('error', reject);
      http.listen(FABRIC_PORT, HOST, resolve);
    }),
    stop: () => new Promise((r) => {
      for (const ws of sockets) ws.terminate();
      http.closeAllConnections?.();
      http.close(() => r());
    }),
  };
}

async function run() {
  for (const p of [PORT, BROKER_PORT, FABRIC_PORT]) {
    await assertFree(p, 'seat-reload.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-seat-reload-'));
  const binDir = join(tmpDir, 'bin');
  const typed = join(tmpDir, 'typed'); // <safe-paneid> -> every line the stub read
  mkdirSync(binDir);
  mkdirSync(typed);

  /* STUB CLAUDE: ALWAYS a working REPL (a reload is always a FRESH launch —
   * no --resume is ever sent), identified by its own HARBOR_WB_PANEID (R11:
   * every spawned CLI's env carries it), so the suite can read back what was
   * typed into a specific (randomly-handled) fresh pane without knowing its
   * session id in advance. */
  const safe = 'tr -c "A-Za-z0-9" "_"';
  const stubPath = join(binDir, 'claude');
  writeFileSync(
    stubPath,
    [
      '#!/bin/sh',
      `echo ${SENTINEL}`,
      `pid=$(printf '%s' "${'${HARBOR_WB_PANEID:-unknown}'}" | ${safe})`,
      `tf="${typed}/$pid"`,
      'echo "Claude Code v9.9.9"',
      'echo "? for shortcuts"',
      'while IFS= read -r line; do',
      `  printf '%s${LF}' "$line" >> "$tf"`,
      `  printf '%0900d${LF}' 0`,
      '  echo "? for shortcuts"',
      'done',
      '',
    ].join(LF),
  );
  chmodSync(stubPath, 0o755);
  const brokerEnv = childEnv({ PATH: `${binDir}${delimiter}${process.env.PATH || ''}`, PTY_BROKER_PORT: String(BROKER_PORT) });

  /* PREFLIGHT, as fabric-restore.test.mjs's: refuse to run if this shell
   * would not actually resolve the stub. */
  const probe = spawnSync('/bin/bash', ['-ic', 'command -v claude'], { env: brokerEnv, encoding: 'utf8', cwd: tmpDir });
  const resolved = String(probe.stdout || '').trim().split(LF).pop();
  if (resolved !== stubPath) {
    console.log(`X PREFLIGHT: the pane's shell resolves claude to ${JSON.stringify(resolved)}, not the stub ${stubPath}. Refusing to run.`);
    process.exit(2);
  }
  ok(true, 'preflight: the pane shell resolves claude to the stub');

  const typedLines = (paneid) => {
    const f = join(typed, paneid.replace(/[^A-Za-z0-9]/g, '_'));
    return existsSync(f) ? readFileSync(f, 'utf8').split(LF).filter(Boolean) : [];
  };

  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  let log = '';
  let broker = null;
  let engine = null;
  const fabric = stubFabric();
  const up = async (url) => {
    for (let i = 0; i < 120; i++) {
      if (await fetch(url).then((r) => r.status < 500).catch(() => false)) return true;
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
  const recipeId = (n) => `rec-reload-${n}`;
  let nextRecipe = 0;

  /* A recipe + a live attached pane, bound as the sole seat of a fresh room
   * (named `label`). Returns {recipe, room, seat, paneid, c} (c = the raw
   * /pty client holding the "old" window — closed by the caller when done). */
  async function seatedRoom(label, agent) {
    const id = recipeId(++nextRecipe);
    const r = await call('/api/recipes', { json: { id, name: `Reload ${label}`, target: 'local', projectDir: tmpDir, vendor: 'claude-code', agent } });
    ok(r.status === 200 && r.body?.recipe?.id, `recipe ${label} created`, r.body);
    const paneid = `recipe:${id}`;
    const c = client();
    ok(await c.open(), `${label}: /pty opens`);
    c.send({ type: 'attach', paneid, recipe: id });
    ok(!!(await c.wait((m) => m.type === 'pane.ready' && m.paneid === paneid)), `${label}: the old pane spawns a real pty`);
    const room = (await call('/api/rooms', { json: { name: `Room ${label}` }, as: 'person' })).body;
    ok(!!room?.id, `${label}: a room`);
    const seatR = await call(`/api/rooms/${room.id}/seats`, { json: { recipe_id: id, handle: 'agent', policy: 'persistent', occupant: paneid }, as: 'person' });
    eq(seatR.status, 200, `${label}: seat @agent bound to the old pane`);
    const roomView = (await call(`/api/rooms/${room.id}`)).body;
    eq(roomView?.room?.lead_seat, seatR.body?.seat?.id, `${label}: the first seat is lead`);
    return { recipe: r.body.recipe, room, seat: seatR.body.seat, paneid, c };
  }

  const bootEngine = (extraEnv = {}) => {
    const e = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_PORT: String(PORT),
        HARBOR_WB_HOST: HOST,
        HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'),
        HARBOR_WB_SEAT_WELCOME: '0', // the room welcome would sit in the typer queue these counts read (room welcome, Owner 2026-10-05)
        HARBOR_WB_TOKEN: TOKEN,
        HARBOR_WB_IDENTITY: 'legacy',
        HARBOR_WB_NO_WINDOW: '1',
        HARBOR_WB_DESKTOP: 'none',
        HARBOR_WB_NATS_URL: '',
        HARBOR_WB_FABRIC_URL: `http://${HOST}:${FABRIC_PORT}`,
        HARBOR_WB_FABRIC_CHECKIN_SWEEP_MS: '300',
        HARBOR_WB_FABRIC_CHECKIN_RETRY_MS: '400',
        HARBOR_WB_FABRIC_CHECKIN_TIMEOUT_MS: '1500',
        HARBOR_WB_BROKER_AUTOSTART: '0',
        HARBOR_WB_BROKER_PORT: String(BROKER_PORT),
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_TITLE_TTL_MS: '300', // the /clear detection reads the title clock's listings
        HARBOR_WB_TITLE_POLL_MS: '700',
        HARBOR_WB_NODE: 'testnode',
        HARBOR_WB_TARGETS: TARGETS,
        HARBOR_WB_SEAT_RELOAD_WAIT_MS: '15000',
        HARBOR_WB_ROOM_TYPE_SETTLE_MS: '150',
        HARBOR_WB_FAIL_LAUNCH_RECIPE: FAIL_RECIPE,
        /* A nonexistent /proc root: guard g (room-typer's "claude owns the
         * terminal" check) then reads "could not tell" and DELIVERS anyway
         * (fabric-restore.test.mjs's own noProc) — real /proc introspection
         * of a shell-script stub named `claude` is not something to depend on. */
        HARBOR_WB_PROC_ROOT: join(tmpDir, 'noproc'),
        ...extraEnv,
      }),
    });
    e.stdout.on('data', (d) => (log += d));
    e.stderr.on('data', (d) => (log += d));
    return e;
  };

  try {
    await fabric.listen();
    broker = spawn(process.execPath, ['--import', loaderArg, 'node_modules/pty-broker/src/main.ts'], { cwd: REPO_ROOT, env: brokerEnv });
    broker.stdout.on('data', (d) => (log += d));
    broker.stderr.on('data', (d) => (log += d));
    if (!(await up(`http://${HOST}:${BROKER_PORT}/health`))) throw new Error(`broker did not come up\n${log}`);
    engine = bootEngine();
    if (!(await up(`${BASE}/health`))) throw new Error(`engine did not come up\n${log}`);
    cookie = await windowCookie(BASE, TOKEN);

    console.log('\n[auth: bearer refused, the window cookie allowed]');
    const { room: rA, seat: seatA, paneid: paneA, c: cA } = await seatedRoom('A', 'reload-a');
    let r = await call(`/api/rooms/${rA.id}/seats/${seatA.id}/reload`, { json: { wait: true } });
    eq(r.status, 403, 'a bearer (no human) is refused (human-only, like disconnect/close-window)');

    console.log('\n[single-room reload: new seat id, same handle, lead restored, old pane dehydrated]');
    r = await call(`/api/rooms/${rA.id}/seats/${seatA.id}/reload`, { json: { wait: true }, as: 'person' });
    eq(r.status, 200, 'the reload runs');
    eq(r.body?.ok, true, 'ok:true');
    const newPaneA = r.body?.newPaneid;
    ok(!!newPaneA && newPaneA !== paneA, `a fresh pane (${newPaneA})`, r.body);
    eq(r.body?.oldPaneid, paneA, 'oldPaneid is the pane that was ended');
    eq(r.body?.rooms?.length, 1, 'one room result');
    const resA = r.body?.rooms?.[0];
    eq(resA?.result, 'reloaded', 'that room: reloaded');
    ok(!!resA?.newSeatId && resA.newSeatId !== seatA.id, `a NEW seat id (old ${seatA.id}, new ${resA?.newSeatId})`);
    eq(resA?.handle, 'agent', 'same handle');
    eq(resA?.lead, true, 'the old seat was recorded as lead');
    const viewA = (await call(`/api/rooms/${rA.id}`)).body;
    eq(viewA?.seats?.length, 1, 'still exactly one seat (removed + re-added, not a second one)');
    eq(viewA?.seats?.[0]?.id, resA.newSeatId, 'the room now shows the NEW seat');
    eq(viewA?.seats?.[0]?.handle, 'agent', 'with the same handle');
    eq(viewA?.room?.lead_seat, resA.newSeatId, 'the lead followed to the new seat');
    eq(viewA?.seats?.[0]?.occupant?.id, newPaneA, 'bound to the fresh pane');
    const oldRowA = (await call('/api/table')).body?.sessions?.find((s) => s.paneid === paneA);
    eq(oldRowA?.state, 'dehydrated', 'the old session is dehydrated (resumable), not killed');
    ok(await until(async () => (await call('/api/table')).body?.sessions?.find((s) => s.paneid === newPaneA)?.state === 'live', 8000), 'the fresh pane is live');
    const factsA = (await call(`/api/rooms/${rA.id}/line?kind=fact`)).body?.entries ?? [];
    ok(factsA.some((e) => /@agent re-added from project defaults/.test(e.body ?? '')), 'a room fact: "@agent re-added from project defaults"', factsA.map((e) => e.body));
    /* Owner 2026-10-03: the engine never speaks as
     * the user. Room A's only seat is the lead being reloaded, so no lead can send it:
     * the default is no welcome, and NO chat line exists at all. */
    eq(r.body?.welcome, 'none', 'lead-self (no other live lead): the default welcome is none');
    const chatsA = (await call(`/api/rooms/${rA.id}/line?kind=chat`)).body?.entries ?? [];
    eq(chatsA.length, 0, 'the reload posted NO user-authored chat line', chatsA.map((e) => e.body));
    await sleep(600);
    ok(!typedLines(newPaneA).some((l) => l.includes('reloaded in a fresh session')), 'nothing was typed into the fresh pane', typedLines(newPaneA));
    cA.close();

    console.log('\n[multi-room: the same fresh pane rebinds a seat in EACH open room]');
    const { room: rB, seat: seatB, paneid: paneB, c: cB } = await seatedRoom('B', 'reload-b');
    const rC = (await call('/api/rooms', { json: { name: 'Room B second' }, as: 'person' })).body;
    const seatC = (await call(`/api/rooms/${rC.id}/seats`, { json: { recipe_id: seatB.recipe_id, handle: 'buddy', policy: 'persistent', occupant: paneB }, as: 'person' }, )).body?.seat;
    ok(!!seatC?.id, 'a second room seats the SAME live pane under a different handle');
    r = await call(`/api/rooms/${rB.id}/seats/${seatB.id}/reload`, { json: { wait: true }, as: 'person' });
    eq(r.status, 200, 'the reload runs');
    eq(r.body?.rooms?.length, 2, 'two room results');
    const byRoom = Object.fromEntries((r.body?.rooms ?? []).map((x) => [x.roomId, x]));
    eq(byRoom[rB.id]?.result, 'reloaded', 'room B: reloaded');
    eq(byRoom[rC.id]?.result, 'reloaded', 'room C: reloaded');
    eq(byRoom[rB.id]?.handle, 'agent', 'room B keeps its handle');
    eq(byRoom[rC.id]?.handle, 'buddy', 'room C keeps its OWN handle');
    const newPaneB = r.body?.newPaneid;
    const vB = (await call(`/api/rooms/${rB.id}`)).body;
    const vC = (await call(`/api/rooms/${rC.id}`)).body;
    eq(vB?.seats?.[0]?.occupant?.id, newPaneB, 'room B now bound to the fresh pane');
    eq(vC?.seats?.[0]?.occupant?.id, newPaneB, 'room C bound to the SAME fresh pane');
    ok(vB?.seats?.[0]?.id !== seatB.id, 'room B: a new seat id');
    ok(vC?.seats?.[0]?.id !== seatC.id, 'room C: a new seat id');
    const factsC = (await call(`/api/rooms/${rC.id}/line?kind=fact`)).body?.entries ?? [];
    ok(factsC.some((e) => /@buddy re-added from project defaults/.test(e.body ?? '')), 'a fact in room C too');
    cB.close();

    console.log('\n[answer early (no wait): 200 right after the seat swap, the fact lands later] Owner 2026-10-06');
    {
      const { room: rX, seat: seatX, c: cX } = await seatedRoom('X', 'reload-x');
      const t0 = Date.now();
      const rx = await call(`/api/rooms/${rX.id}/seats/${seatX.id}/reload`, { json: {}, as: 'person' });
      eq(rx.status, 200, 'the reload answers');
      eq(rx.body?.pending, true, '...early, marked pending');
      eq(rx.body?.welcome, 'pending', '...the welcome is still to come');
      ok(!!rx.body?.newPaneid, '...and already names the new pane');
      const vX = (await call(`/api/rooms/${rX.id}`)).body;
      eq(vX?.seats?.[0]?.occupant?.id, rx.body?.newPaneid, 'the seat is already on the new pane when the answer arrives');
      ok(
        await until(async () => ((await call(`/api/rooms/${rX.id}/line?kind=fact`)).body?.entries ?? []).some((e) => /re-added from project defaults/.test(e.body ?? '')), 30000),
        `the "re-added" fact lands in the background (answer took ${Date.now() - t0} ms)`,
      );
      const again = await call(`/api/rooms/${rX.id}/seats/${vX?.seats?.[0]?.id}/reload`, { json: { wait: true }, as: 'person' });
      ok(again.status === 200 || again.status === 409, 'a second reload after the background finish is accepted (the in-progress mark was released)');
      cX.close();
    }

    console.log('\n[mid-turn: refused without force, runs with it]');
    const { room: rD, seat: seatD, paneid: paneD, c: cD } = await seatedRoom('D', 'reload-d');
    const rowD = (await call('/api/table')).body?.sessions?.find((s) => s.paneid === paneD);
    await call('/api/claude-hook', { json: { session_id: rowD?.session_id, hook_event_name: 'UserPromptSubmit' } });
    ok(await until(async () => (await call(`/api/rooms/${rD.id}`)).body?.seats?.[0]?.occupant?.activity === 'streaming', 4000), 'the old pane now reads busy (UserPromptSubmit)');
    r = await call(`/api/rooms/${rD.id}/seats/${seatD.id}/reload`, { json: { wait: true }, as: 'person' });
    eq(r.status, 409, 'mid-turn, no force: refused');
    eq(r.body?.field, 'force', 'the refusal names the force field');
    const stillD = (await call('/api/table')).body?.sessions?.find((s) => s.paneid === paneD);
    eq(stillD?.state, 'live', 'the refusal ended nothing');
    r = await call(`/api/rooms/${rD.id}/seats/${seatD.id}/reload`, { json: { wait: true, force: true }, as: 'person' });
    eq(r.status, 200, 'with force: true, it runs');
    eq(r.body?.ok, true, 'ok:true');
    cD.close();

    console.log('\n[a held line moves onto the fresh pane]');
    const { room: rE, seat: seatE, paneid: paneE, c: cE } = await seatedRoom('E', 'reload-e');
    /* room-typer's own "typeable" guard treats a streaming REPLY as typeable
     * on purpose (Owner 2026-09-27: "a running reply is typeable") — what
     * actually HOLDS a delivery is an unsent DRAFT in the pane's own input
     * box (guard c, never seize it). Simulate one with a raw (no \r) input
     * frame on the OLD pane's own socket, once startup's OWN hold (every
     * fresh pane's first moment) has cleared on its own. */
    await sleep(1200); // the stub's banner clears startup almost at once; this outlives it
    cE.send({ type: 'input', paneid: paneE, data: 'draft: not sent yet' });
    await sleep(300); // let the draft classification land before anything is queued to report it
    const held = await call(`/api/rooms/${rE.id}/line`, { json: { text: '@agent remember the deploy key is in vault/prod' }, as: 'person' });
    eq(held.status, 200, 'the line posts while the pane holds a draft');
    const beforeView = (await call(`/api/rooms/${rE.id}`)).body;
    eq(beforeView?.seats?.[0]?.occupant?.held?.reason, 'draft', 'the seat shows the line held (reason: draft) before the reload');
    r = await call(`/api/rooms/${rE.id}/seats/${seatE.id}/reload`, { json: { wait: true }, as: 'person' });
    eq(r.status, 200, 'the reload runs (a draft is not "mid-turn" — no force needed)');
    const newPaneE = r.body?.newPaneid;
    ok(await until(() => typedLines(newPaneE).some((l) => l.includes('remember the deploy key')), 10000), 'the held line was eventually typed into the fresh pane', typedLines(newPaneE));
    cE.close();

    console.log('\n[welcome modes: me (edited text) / lead notice / none]');
    {
      const { room: rH, seat: seatH, paneid: paneH, c: cH } = await seatedRoom('H', 'reload-h');
      r = await call(`/api/rooms/${rH.id}/seats/${seatH.id}/reload`, { json: { wait: true, welcome: { mode: 'me', text: 'Hi @agent, EDITED welcome from Owner.' } }, as: 'person' });
      eq(r.status, 200, 'H: reload with welcome.mode=me');
      eq(r.body?.welcome, 'sent', 'H: welcome sent');
      const chatsH = (await call(`/api/rooms/${rH.id}/line?kind=chat`)).body?.entries ?? [];
      const mine = chatsH.find((e) => /EDITED welcome/.test(e.body ?? ''));
      ok(!!mine, 'H: the edited text was posted', chatsH.map((e) => e.body));
      eq(mine?.author, 'user', 'H: posted as the user (he typed/approved it)');
      ok(await until(() => typedLines(r.body.newPaneid).some((l) => l.includes('EDITED welcome')), 8000), 'H: the edited text reached the fresh pane');
      cH.close();

      const bad = await call(`/api/rooms/${rH.id}/seats/${seatH.id}/reload`, { json: { wait: true, welcome: { mode: 'shout' } }, as: 'person' });
      eq(bad.status, 400, 'an unknown welcome mode is refused');

      /* lead + worker in one room: reloading the worker offers (and defaults to) the lead */
      const { room: rI, seat: seatLead, c: cI } = await seatedRoom('I', 'reload-i');
      const wr = await call('/api/recipes', { json: { id: recipeId(++nextRecipe), name: 'Reload Worker', target: 'local', projectDir: tmpDir, vendor: 'claude-code', agent: 'reload-w' } });
      const wid = wr.body?.recipe?.id;
      const paneW = `recipe:${wid}`;
      const cW = client();
      await cW.open();
      cW.send({ type: 'attach', paneid: paneW, recipe: wid });
      await cW.wait((m) => m.type === 'pane.ready' && m.paneid === paneW);
      const seatW = (await call(`/api/rooms/${rI.id}/seats`, { json: { recipe_id: wid, handle: 'worker', policy: 'persistent', occupant: paneW }, as: 'person' })).body?.seat;
      ok(!!seatW?.id, 'I: a worker seat beside the lead');
      const prev = (await call(`/api/rooms/${rI.id}/seats/${seatW.id}/reload`, { as: 'person' })).body;
      eq(prev?.welcome?.lead?.handle, 'agent', 'preview: the lead is on offer');
      ok(/You are @worker/.test(prev?.welcome?.text ?? ''), 'preview: carries the default welcome text', prev?.welcome);
      const sendsBefore = fabric.s.sends.length;
      r = await call(`/api/rooms/${rI.id}/seats/${seatW.id}/reload`, { json: { wait: true }, as: 'person' });
      eq(r.status, 200, 'I: reload with the default welcome');
      eq(r.body?.welcome, 'sent', 'I: default = lead sends it');
      const chatsI = (await call(`/api/rooms/${rI.id}/line?kind=chat`)).body?.entries ?? [];
      eq(chatsI.length, 0, 'I: no user-authored chat line', chatsI.map((e) => e.body));
      const notice = fabric.s.sends.slice(sendsBefore).find((x) => x.env?.kind === 'notice' && /welcome @worker/.test(x.env?.body ?? ''));
      ok(!!notice, 'I: the lead got a fabric notice asking it to welcome @worker', fabric.s.sends.slice(sendsBefore).map((x) => x.env));
      ok(/^room-/.test(notice?.env?.from ?? ''), 'I: signed as the room, never the user', notice?.env?.from);
      // reloading the LEAD itself in that room: lead-self, nobody to ask
      const prevL = (await call(`/api/rooms/${rI.id}/seats/${seatLead.id}/reload`, { as: 'person' })).body;
      eq(prevL?.welcome?.lead, null, 'lead-self: "Lead sends it" is not on offer');
      // none
      const sends2 = fabric.s.sends.length;
      r = await call(`/api/rooms/${rI.id}/seats/${seatW.id}/reload`, { json: { wait: true, welcome: { mode: 'none' } }, as: 'person' });
      ok(r.status === 200 || r.status === 409, 'I: second reload answers', r.status);
      if (r.status === 200) {
        eq(r.body?.welcome, 'none', 'mode none: no welcome');
        ok(!fabric.s.sends.slice(sends2).some((x) => /welcome @worker/.test(x.env?.body ?? '')), 'mode none: no lead notice');
      }
      cI.close();
      cW.close();
    }

    console.log('\n[cleared in its CLI: detected from a /clear transcript, on the payload, dismissible]');
    {
      /* Owner 2026-10-03. The seat's pane banks transcript S;
       * a NEW transcript T opening with the /clear command appears, written while the pane is
       * producing output. The engine flags the row; the seat occupant and /api/table carry
       * cleared_at; a person dismisses it; a reload mints a fresh row with no flag. */
      const { room: rJ, seat: seatJ, paneid: paneJ, c: cJ } = await seatedRoom('J', 'reload-j');
      const rowJ = (await call('/api/table')).body?.sessions?.find((s) => s.paneid === paneJ);
      ok(!!rowJ?.session_id, 'J: the pane banks a session id', rowJ);
      eq(rowJ?.cleared_at ?? null, null, 'J: not cleared at the start');
      const projDir = join(tmpDir, 'claude-projects', tmpDir.replace(/[^A-Za-z0-9]/g, '-'));
      mkdirSync(projDir, { recursive: true });
      const NEWID = '9c1e5a44-0b7d-4f43-9a66-1d2c3b4a5f60';
      writeFileSync(join(projDir, `${rowJ.session_id}.jsonl`), JSON.stringify({ type: 'user', sessionId: rowJ.session_id, message: { role: 'user', content: 'hello' } }) + LF);
      await sleep(1200); // the pane's own output, later than S
      cJ.send({ type: 'input', paneid: paneJ, data: 'x' + String.fromCharCode(13) }); // the stub echoes: output NOW
      await sleep(400);
      writeFileSync(
        join(projDir, `${NEWID}.jsonl`),
        JSON.stringify({ type: 'user', sessionId: NEWID, message: { role: 'user', content: '<command-name>/clear</command-name>' } }) + LF,
      );
      const flagged = await until(async () => (await call('/api/table')).body?.sessions?.find((s) => s.paneid === paneJ)?.cleared_at, 12000, 400);
      ok(typeof flagged === 'number', 'J: /api/table row carries cleared_at once the /clear transcript is seen', flagged);
      const occ = (await call(`/api/rooms/${rJ.id}`)).body?.seats?.[0]?.occupant;
      ok(typeof occ?.cleared_at === 'number', 'J: the seat occupant payload carries cleared_at', occ?.cleared_at);
      const stillBanked = (await call('/api/table')).body?.sessions?.find((s) => s.paneid === paneJ)?.session_id;
      eq(stillBanked, rowJ.session_id, 'J: the banked session id is NOT moved by the flag');
      let d = await call(`/api/sessions/${encodeURIComponent(paneJ)}/cleared/dismiss`, { json: {} });
      eq(d.status, 403, 'dismiss: a bearer (no human) is refused');
      d = await call(`/api/sessions/${encodeURIComponent(paneJ)}/cleared/dismiss`, { json: {}, as: 'person' });
      eq(d.status, 200, 'dismiss: the person cookie is accepted');
      await sleep(2500); // several sweeps: the same /clear must not come back
      const after = (await call('/api/table')).body?.sessions?.find((s) => s.paneid === paneJ);
      eq(after?.cleared_at ?? null, null, 'J: dismissed, and the same /clear is not flagged again');
      d = await call('/api/sessions/recipe:nope/cleared/dismiss', { json: {}, as: 'person' });
      eq(d.status, 404, 'dismiss: an unknown session is a 404');
      cJ.close();
    }

    console.log('\n[launch failure: the room stays on the OLD (dehydrated, restorable) seat]');
    await kill(engine);
    engine = bootEngine({ HARBOR_WB_FAIL_LAUNCH_RECIPE: FAIL_RECIPE });
    if (!(await up(`${BASE}/health`))) throw new Error(`engine (fail-recipe) did not come up\n${log}`);
    cookie = await windowCookie(BASE, TOKEN);
    const failRecipe = await call('/api/recipes', { json: { id: FAIL_RECIPE, name: 'Reload Failer', target: 'local', projectDir: tmpDir, vendor: 'claude-code', agent: 'reload-failer' } });
    ok(failRecipe.status === 200, 'the fail-recipe is created', failRecipe.body);
    const paneF = `recipe:${FAIL_RECIPE}`;
    const cF = client();
    ok(await cF.open(), 'F: /pty opens');
    cF.send({ type: 'attach', paneid: paneF, recipe: FAIL_RECIPE });
    ok(!!(await cF.wait((m) => m.type === 'pane.ready' && m.paneid === paneF)), 'F: the old pane spawns');
    const rF = (await call('/api/rooms', { json: { name: 'Room F' }, as: 'person' })).body;
    const seatFR = await call(`/api/rooms/${rF.id}/seats`, { json: { recipe_id: FAIL_RECIPE, handle: 'agent', policy: 'persistent', occupant: paneF }, as: 'person' });
    const seatF = seatFR.body?.seat;
    r = await call(`/api/rooms/${rF.id}/seats/${seatF.id}/reload`, { json: { wait: true }, as: 'person' });
    eq(r.status, 200, 'the route answers (not a 5xx)');
    eq(r.body?.ok, false, 'ok:false — the launch failed');
    eq(r.body?.reason, 'launch-failed', 'reason: launch-failed');
    const resF = r.body?.rooms?.[0];
    eq(resF?.result, 'rolled-back', 'room F: rolled-back');
    ok(!!resF?.newSeatId, 'the roll-back re-added a seat (a new id, bound to the OLD pane)');
    const viewF = (await call(`/api/rooms/${rF.id}`)).body;
    eq(viewF?.seats?.[0]?.handle, 'agent', 'still @agent');
    eq(viewF?.seats?.[0]?.occupant?.id, paneF, 'back on the OLD pane');
    eq(viewF?.room?.lead_seat, resF.newSeatId, 'the lead is restored onto the rolled-back seat');
    const rowF = (await call('/api/table')).body?.sessions?.find((s) => s.paneid === paneF);
    eq(rowF?.state, 'dehydrated', 'the old session stayed dehydrated — restorable, never killed');
    const actsF = (await call(`/api/rooms/${rF.id}`)).body?.seats?.[0]?.actions ?? [];
    ok(actsF.includes('rehydrate'), 'the room offers Restore on it', actsF);
    cF.close();

    console.log('\n[concurrency: one reload per pane at a time]');
    const { room: rG, seat: seatG, paneid: paneG, c: cG } = await seatedRoom('G', 'reload-g');
    const [g1, g2] = await Promise.all([
      call(`/api/rooms/${rG.id}/seats/${seatG.id}/reload`, { json: { wait: true }, as: 'person' }),
      call(`/api/rooms/${rG.id}/seats/${seatG.id}/reload`, { json: { wait: true }, as: 'person' }),
    ]);
    const statuses = [g1.status, g2.status].sort();
    ok((statuses[0] === 200 && statuses[1] === 409) || (statuses[0] === 200 && statuses[1] === 200 && (g1.body?.newPaneid === g2.body?.newPaneid)), `a concurrent reload on the same pane is refused or collapses to one (${JSON.stringify(statuses)})`);
    cG.close();
  } catch (e) {
    failed++;
    failures.push(`threw: ${e?.stack ?? e}`);
    console.log(`  X threw: ${e?.stack ?? e}`);
    console.log(`--- log tail ---\n${log.slice(-4000)}`);
  } finally {
    await kill(engine);
    await kill(broker);
    await fabric.stop().catch(() => {});
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
