/**
 * ENGINE CHECKS IN PER PANE (contract §1.3) + F4 ROOMS ON FABRIC THREADS
 * (the design notes §6, the design notes §2.8) — through a real
 * scratch engine and a stub fabric.
 *
 * The fabric-send.test.mjs pattern: no real pty, no real broker (a DEAD broker
 * port, assertFree'd), rows written straight through the store via
 * test/rooms-routes.seed.ts — not-live rows BEFORE boot, live rows AFTER (boot
 * reconcile only sweeps `live`). Seeding a live row is the "spawn-equivalent":
 * the check-in sweep finds it exactly as it finds a pane no hook announced.
 *
 * The STUB FABRIC implements just enough of fabric-service's verbs
 * (/checkin, /bind, /send, POST /threads, GET /threads/:id/acks) to answer
 * the way src/routes.js + src/identity.js do, and records every request so
 * the assertions are about what the ENGINE sent.
 *
 * SAFETY: never touches :7420/:7430/:8200/:8201/:8204, the real data dir, or a
 * broker. Every child env comes from childEnv(). Temp dirs are removed.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { P, assertFree, childEnv, windowCookie, roomUserWrite } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(74); // main engine — port table in test/_scratch.mjs
const DEAD_BROKER_PORT = P(75); // nothing may listen: no pty is ever opened; shared by both engines
const FABRIC_PORT = P(76); // the stub fabric — NOT 8204 (the real one)
const OFF_PORT = P(77); // second engine, HARBOR_WB_ROOM_FABRIC=0
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const OFF_BASE = `http://${HOST}:${OFF_PORT}`;
const TOKEN = 'fabric-checkin-test-token';

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
function same(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, a === b ? msg : `${msg}\n      got      ${a}\n      expected ${b}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) {
      return v;
    }
    await sleep(step);
  }
}

/* A room write with no `from` is the USER's, which takes a window cookie, not
   the bearer (roomUserWrite). One cookie per engine, fetched on first use. */
const userCookies = new Map();
async function call(base, path, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  if (opts.auth !== false && roomUserWrite(path, opts.method ?? (opts.json !== undefined ? 'POST' : 'GET'), opts.json)) {
    if (!userCookies.has(base)) {
      userCookies.set(base, await windowCookie(base, TOKEN));
    }
    headers.cookie = userCookies.get(base);
  } else if (opts.auth !== false) {
    headers.authorization = `Bearer ${TOKEN}`;
  }
  const init = { method: opts.method ?? 'GET', headers };
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.json);
    init.method = opts.method ?? 'POST';
  }
  const res = await fetch(base + path, init);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not json */
  }
  return { status: res.status, body };
}
const send = (base, json) => call(base, '/api/fabric/send', { json });
const diag = async (base = BASE) => (await call(base, '/api/diag/fabric')).body;

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

/* ---------------------------------------------------------------------------
 * THE STUB FABRIC. Answers the way fabric-service does for the cases tested:
 *   /checkin  project 'not-a-node' → 404 (not a registry node); a remembered
 *             slug in `held` → conflict; a remembered slug of this project →
 *             bound (reclaim); nothing remembered → minted <project>-<8 hex>.
 *             A live instance_hint of the same project is reused.
 *   /send     with X-Fabric-Instance: an instance it does not know → 409
 *             instance-expired; otherwise `from` is STAMPED from the instance.
 *   /threads  POST opens one; GET /threads/:id/acks serves `acks[thread]`.
 * ------------------------------------------------------------------------- */
function stubFabric() {
  const s = {
    checkins: [],
    binds: [],
    sends: [],
    threads: [],
    ackReads: 0,
    instances: new Map(), // instance -> {project, slug}
    held: new Set(),
    acks: new Map(), // thread -> [{message, to, ref, ack}]
    n: 0,
  };
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
        s.checkins.push({ body: b, auth: req.headers.authorization ?? null });
        if (b.project === 'not-a-node') {
          return reply(res, 404, { ok: false, error: '"not-a-node" is not a registry node id', field: 'project' });
        }
        const hinted = b.instance_hint && s.instances.get(b.instance_hint);
        const instance = hinted && hinted.project === b.project ? b.instance_hint : `i-${hex()}`;
        if (!hinted || hinted.project !== b.project) {
          s.instances.set(instance, { project: b.project, slug: null });
        }
        const rec = s.instances.get(instance);
        if (b.remembered_slug) {
          if (s.held.has(b.remembered_slug)) {
            return reply(res, 200, { ok: true, instance, status: 'conflict', holder: { instance: 'i-holder00', last_active: new Date().toISOString() } });
          }
          if (b.remembered_slug.startsWith(`${b.project}-`)) {
            rec.slug = b.remembered_slug;
            return reply(res, 200, { ok: true, instance, status: 'bound', slug: rec.slug });
          }
        }
        rec.slug = `${b.project}-${hex()}`;
        return reply(res, 200, { ok: true, instance, status: 'minted', slug: rec.slug });
      }
      if (req.method === 'POST' && path === '/bind') {
        s.binds.push(b);
        return reply(res, 200, { ok: true, instance: b.instance, slug: b.slug, status: 'bound' });
      }
      if (req.method === 'POST' && path === '/send') {
        s.sends.push({ env: b, instance: inst, auth: req.headers.authorization ?? null });
        if (inst && !s.instances.has(inst)) {
          return reply(res, 409, { ok: false, error: 'instance-expired', instance: inst });
        }
        const id = `m-${++s.n}`;
        const from = inst ? s.instances.get(inst).slug : b.from;
        return reply(res, 202, { ok: true, envelope: { ...b, id, from, ack: 'none' } });
      }
      if (req.method === 'POST' && path === '/threads') {
        const thread = `th${hex()}`;
        s.threads.push({ body: b, instance: inst, thread });
        return reply(res, 200, { ok: true, thread, topic: b.topic ?? null, pinned: Boolean(b.pinned), opened_by: b.by, state: 'open' });
      }
      const m = /^\/threads\/([^/]+)\/acks$/.exec(path);
      if (req.method === 'GET' && m) {
        s.ackReads++;
        return reply(res, 200, { ok: true, thread: m[1], state: 'open', acks: s.acks.get(m[1]) ?? [] });
      }
      reply(res, 404, { ok: false, error: `no route for ${req.method} ${path}` });
    });
  });
  /* WS /subscribe — ready, then record each subscribe frame and confirm it.
     noServer + one upgrade router (the 2026-09-15 finding). `push(env)` sends
     a message frame to every open socket. */
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
        const f = JSON.parse(String(raw));
        if (f.type === 'subscribe') {
          s.subscribes.push(f.slugs);
          ws.send(JSON.stringify({ type: 'subscribed', slugs: f.slugs }));
        }
      });
      ws.send(JSON.stringify({ type: 'ready' }));
    });
  });
  s.subscribes = [];
  return {
    s,
    push: (envelope) => {
      for (const ws of sockets) {
        ws.send(JSON.stringify({ type: 'message', envelope }));
      }
    },
    listen: () =>
      new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(FABRIC_PORT, HOST, resolve);
      }),
    stop: () =>
      new Promise((r) => {
        for (const ws of sockets) {
          ws.terminate();
        }
        http.closeAllConnections?.();
        http.close(() => r());
      }),
  };
}

function bootEngine(port, dbPath, tmpDir, extra, sink) {
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  const proc = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(port),
      HARBOR_WB_HOST: HOST,
      HARBOR_WB_TABLE: dbPath,
      HARBOR_WB_TOKEN: TOKEN,
      HARBOR_WB_IDENTITY: 'legacy',
      HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_NATS_URL: '',
      HARBOR_WB_FABRIC_URL: `http://${HOST}:${FABRIC_PORT}`,
      HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT),
      HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, `claude-projects-${port}`),
      HARBOR_WB_NODE: 'testnode',
      HARBOR_WB_FABRIC_CHECKIN_SWEEP_MS: '300',
      HARBOR_WB_FABRIC_CHECKIN_RETRY_MS: '400',
      HARBOR_WB_FABRIC_KEEPALIVE_MS: '2500',
      HARBOR_WB_FABRIC_CHECKIN_TIMEOUT_MS: '1500',
      ...extra,
    }),
  });
  proc.stdout.on('data', (d) => sink(String(d)));
  proc.stderr.on('data', (d) => sink(String(d)));
  return proc;
}
async function waitUp(base, logFn) {
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    if (await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)) {
      return;
    }
  }
  throw new Error(`engine ${base} did not come up\n${logFn()}`);
}

async function run() {
  for (const p of [PORT, DEAD_BROKER_PORT, FABRIC_PORT, OFF_PORT]) {
    await assertFree(p, 'fabric-checkin.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-fabric-checkin-'));
  const dbPath = join(tmpDir, 'mapping.db');
  const offDbPath = join(tmpDir, 'mapping-off.db');
  let engine = null;
  let offEngine = null;
  let engineLog = '';
  let offLog = '';
  const fabric = stubFabric();
  const seed = async (plan, table = dbPath) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], {
      HARBOR_WB_TABLE: table,
      HARBOR_WB_IDENTITY: 'legacy',
    });
    if (r.code !== 0) {
      throw new Error(`seed failed: ${r.err}`);
    }
    return JSON.parse(r.out.trim().split('\n').pop());
  };
  const recipe = (id, name, agent, vendor = 'claude-code') => ({ id, name, target: 'local', projectDir: tmpDir, vendor, agent });
  const RECIPES = [
    recipe('rec-a', 'Alpha', 'alpha'),
    recipe('rec-b', 'Beta', 'beta', 'cli-manager'),
    recipe('rec-c', 'Gamma', 'gamma'),
    recipe('rec-bad', 'NotNode', 'not-a-node'),
    recipe('rec-d', 'Delta', 'delta'),
    recipe('rec-noslug', 'NoSlug', null, 'cli-manager'),
  ];

  try {
    await fabric.listen();
    fabric.s.held.add('gamma-held0001');
    await seed({ recipes: RECIPES });

    console.log(`booting scratch engine :${PORT} (dead broker :${DEAD_BROKER_PORT}, stub fabric :${FABRIC_PORT})`);
    engine = bootEngine(PORT, dbPath, tmpDir, {}, (d) => (engineLog += d));
    await waitUp(BASE, () => engineLog);

    // LIVE rows after boot — the spawn-equivalent. p-a carries a previous
    // engine's hint (the restart case); p-c's remembered slug is HELD.
    await seed({
      sessions: [
        { paneid: 'p-a', recipe_id: 'rec-a', vendor: 'claude-code', agent: 'alpha', session_id: 'sess-a', state: 'live', fabric_slug: 'alpha-0000aaaa', fabric_instance: 'i-stale001' },
        { paneid: 'p-b', recipe_id: 'rec-b', vendor: 'cli-manager', agent: 'beta', state: 'live' },
        { paneid: 'p-c', recipe_id: 'rec-c', vendor: 'claude-code', agent: 'gamma', state: 'live', fabric_slug: 'gamma-held0001' },
        { paneid: 'p-bad', recipe_id: 'rec-bad', vendor: 'claude-code', agent: 'not-a-node', state: 'live' },
        { paneid: 'p-noslug', recipe_id: 'rec-noslug', vendor: 'cli-manager', agent: null, state: 'live' },
      ],
    });

    /* ------------------------------------------------------------ check-in */
    console.log('\n[check-in at spawn: every live pane with a slug, three outcomes]');
    const settled = await until(async () => {
      const p = (await diag()).checkin?.panes ?? {};
      return p['p-a']?.outcome === 'checked-in' && p['p-b']?.outcome === 'checked-in' && p['p-c']?.outcome === 'checked-in' && p['p-bad']?.outcome === 'refused' ? p : null;
    });
    ok(settled, 'p-a, p-b, p-c checked-in and p-bad refused, within the sweep');
    const panes = settled ?? (await diag()).checkin.panes;
    ok(!('p-noslug' in panes), 'a pane with no agent slug never checks in');

    const ciA = fabric.s.checkins.find((c) => c.body.project === 'alpha');
    ok(ciA, 'the engine POSTed /checkin for alpha');
    eq(ciA?.body.remembered_slug, 'alpha-0000aaaa', 'restart case: the row\'s remembered slug is OFFERED');
    eq(ciA?.body.instance_hint, 'i-stale001', 'and its last instance as the hint');
    eq(ciA?.body.vendor, 'claude-code', 'vendor is the row\'s');
    ok(typeof ciA?.body.paneid === 'string' && ciA.body.paneid.length > 0, 'paneid is sent so a pane-mode fabric-mcp JOINS this instance (fabric 5cf83e3)');
    ok(typeof ciA?.body.node === 'string' && ciA.body.node.length > 0, `node is derived from the target (${ciA?.body.node})`);
    eq(ciA?.body.name, 'Alpha', 'name is the recipe name');
    eq(ciA?.auth, `Bearer ${TOKEN}`, 'with the engine\'s own bearer');
    eq(panes['p-a'].slug, 'alpha-0000aaaa', 'p-a RECLAIMED its remembered slug (bound)');
    eq(panes['p-a'].status, 'bound', 'status is the fabric\'s own word: bound');
    ok(/^i-[0-9a-f]{8}$/.test(panes['p-a'].instance ?? ''), 'p-a holds a fresh instance (the stale hint was not live)');

    const ciB = fabric.s.checkins.find((c) => c.body.project === 'beta');
    ok(ciB && !('remembered_slug' in ciB.body), 'p-b had nothing to remember: no remembered_slug');
    ok(/^beta-[0-9a-f]{8}$/.test(panes['p-b'].slug ?? ''), 'p-b was MINTED a work slug');
    eq(panes['p-b'].status, 'minted', 'status minted');

    console.log('\n[conflict: the copied-memory rule — mint fresh, never merge]');
    const ciC = fabric.s.checkins.filter((c) => c.body.project === 'gamma');
    ok(ciC.length >= 2, 'gamma checked in twice');
    eq(ciC[0]?.body.remembered_slug, 'gamma-held0001', 'first with the remembered (held) slug');
    ok(ciC[1] && !('remembered_slug' in ciC[1].body), 'then WITHOUT it');
    ok(ciC[1]?.body.instance_hint, 'reusing the instance the conflict answer issued');
    ok(panes['p-c'].slug && panes['p-c'].slug !== 'gamma-held0001', 'p-c holds a NEW slug, never the held one');

    console.log('\n[refused: named, retried rarely, never fatal]');
    ok(/404/.test(panes['p-bad'].lastError ?? ''), 'p-bad lastError names the 404');
    ok(panes['p-bad'].instance === null, 'a refused pane holds no instance');
    const health = await call(BASE, '/health');
    eq(health.status, 200, 'the engine is healthy through a refusal');

    console.log('\n[persist: the row keeps the hint for the NEXT engine]');
    const rows = (await seed({ read: ['p-a', 'p-b'] })).rows;
    eq(rows[0]?.fabric_slug, 'alpha-0000aaaa', 'p-a row: fabric_slug');
    eq(rows[0]?.fabric_instance, panes['p-a'].instance, 'p-a row: fabric_instance is the live one');
    eq(rows[1]?.fabric_slug, panes['p-b'].slug, 'p-b row: the minted slug');

    console.log('\n[subscribe set: minted slugs are listened on too]');
    const req = await until(() => fabric.s.subscribes.find((sl) => sl.includes(panes['p-b'].slug) && sl.includes('alpha-0000aaaa')), 3000);
    ok(req && req.includes('beta') && req.includes('alpha'), 'the subscribe frame carries the bare slugs AND the work slugs');

    /* --------------------------------------------------------------- send */
    console.log('\n[send: X-Fabric-Instance from the pane\'s instance; the fabric stamps from]');
    let before = fabric.s.sends.length;
    const s1 = await send(BASE, { from: { paneid: 'p-a' }, to: 'beta', kind: 'msg', thread: 't1', body: 'hi' });
    eq(s1.status, 202, 'passthrough of the fabric\'s 202');
    eq(fabric.s.sends[before]?.instance, panes['p-a'].instance, 'the header carries p-a\'s instance');
    eq(s1.body?.envelope?.from, 'alpha-0000aaaa', 'and the fabric stamped from the WORK slug');
    eq(fabric.s.sends[before]?.env.from, 'alpha', 'the body still carries the engine stamp (ignored by the fabric)');

    console.log('\n[send: no instance → stamped-from fallback, and logged]');
    before = fabric.s.sends.length;
    const s2 = await send(BASE, { from: { paneid: 'p-bad' }, to: 'beta', kind: 'msg', thread: 't1', body: 'hi' });
    eq(s2.status, 202, 'still sends');
    eq(fabric.s.sends[before]?.instance, null, 'no X-Fabric-Instance');
    eq(fabric.s.sends[before]?.env.from, 'not-a-node', 'from is the engine stamp (row.agent)');
    await sleep(100);
    ok(engineLog.includes('fabric send p-bad not-a-node → beta (msg): 202 (no instance: stamped-from fallback)'), 'the fallback is logged');

    console.log('\n[send: an expired instance re-checks in and retries ONCE]');
    const oldB = panes['p-b'].instance;
    fabric.s.instances.delete(oldB); // the fabric forgot it (idle past the TTL)
    before = fabric.s.sends.length;
    const ciBefore = fabric.s.checkins.length;
    const s3 = await send(BASE, { from: { paneid: 'p-b' }, to: 'alpha', kind: 'msg', thread: 't1', body: 'hi' });
    eq(s3.status, 202, 'the retry succeeded');
    eq(fabric.s.sends.length - before, 2, 'two /send requests: the 409 and the retry');
    eq(fabric.s.sends[before]?.instance, oldB, 'first with the expired instance');
    const reCi = fabric.s.checkins.slice(ciBefore).find((c) => c.body.project === 'beta');
    eq(reCi?.body.remembered_slug, panes['p-b'].slug, 're-check-in offers the slug it held');
    const afterB = (await diag()).checkin.panes['p-b'];
    eq(afterB.slug, panes['p-b'].slug, 'and reclaims it (same work slug)');
    ok(afterB.instance && afterB.instance !== oldB, 'under a new instance');
    eq(fabric.s.sends[before + 1]?.instance, afterB.instance, 'the retry carries the new instance');

    console.log('\n[keepalive: a re-check-in with instance_hint well inside the TTL]');
    const kaFrom = fabric.s.checkins.length;
    const ka = await until(() => fabric.s.checkins.slice(kaFrom).find((c) => c.body.project === 'alpha'), 6000);
    ok(ka, 'alpha re-checked in on its own (keepalive)');
    eq(ka?.body.instance_hint, panes['p-a'].instance, 'hinting its live instance');
    eq(ka?.body.remembered_slug, 'alpha-0000aaaa', 'and its slug');
    eq((await diag()).checkin.panes['p-a'].instance, panes['p-a'].instance, 'the instance did not rotate');

    /* ============================================ F4: rooms on fabric threads */
    const slugOf = async (p) => (await diag()).checkin.panes[p].slug;
    const betaSlug = await slugOf('p-b');
    const gammaSlug = await slugOf('p-c');
    const { rooms } = await seed({
      rooms: [
        {
          name: 'Work',
          seats: [
            { handle: 'alpha', recipe_id: 'rec-a', occupant: 'p-a' }, // lead
            { handle: 'beta', recipe_id: 'rec-b', occupant: 'p-b' },
            { handle: 'gamma', recipe_id: 'rec-c', occupant: 'p-c' },
            { handle: 'ghost', recipe_id: 'rec-d' }, // no occupant: never a fabric copy
          ],
        },
      ],
    });
    const room = rooms[0];
    const roomSends = () => fabric.s.sends.filter((x) => String(x.env.ref ?? '').startsWith(`room:${room.id}/`));
    const line = (json) => call(BASE, `/api/rooms/${room.id}/line`, { json });

    console.log('\n[F4: the first delivery opens ONE pinned thread and stores it]');
    const l1 = await line({ text: '@beta hello there' });
    eq(l1.status, 200, 'a user line to @beta: 200');
    const e1 = l1.body.entries[0];
    await until(() => roomSends().length >= 1, 4000);
    eq(fabric.s.threads.length, 1, 'exactly one POST /threads');
    const th = fabric.s.threads[0];
    eq(th?.body.topic, 'Work', 'topic is the room name');
    eq(th?.body.pinned, true, 'pinned');
    eq(th?.body.by, 'user', 'opened by the user (a user-authored line)');
    const got = await call(BASE, `/api/rooms/${room.id}`);
    eq(got.body?.room?.thread, th?.thread, 'rooms.thread is stored');

    console.log('\n[F4: fan-out envelope shape — addressed seat gets an ask]');
    const c1 = roomSends();
    eq(c1.length, 1, 'one copy: only @beta was addressed');
    eq(c1[0]?.env.to, betaSlug, 'to = the seat pane\'s WORK slug (checked in)');
    eq(c1[0]?.env.thread, th?.thread, 'on the room thread');
    eq(c1[0]?.env.kind, 'ask', 'kind ask: the line named that seat');
    eq(c1[0]?.env.class, 'coordination', 'class coordination');
    eq(c1[0]?.env.body, '@beta hello there', 'body = the entry body, verbatim');
    eq(c1[0]?.env.ref, `room:${room.id}/line:${e1.id}`, 'ref = room:<id>/line:<n>');
    eq(c1[0]?.env.from, 'user', 'from = user (no author pane)');
    eq(c1[0]?.instance, null, 'no instance header for a user-authored line');

    console.log('\n[F4: a member\'s @room line — every OTHER agent seat, as the author\'s instance]');
    const aInst = (await diag()).checkin.panes['p-a'].instance;
    const l2 = await line({ text: '@room status update', from: { paneid: 'p-a' } });
    eq(l2.status, 200, 'alpha posts to @room');
    const e2 = l2.body.entries[0];
    await until(() => roomSends().length >= 3, 4000);
    const c2 = roomSends().filter((x) => x.env.ref === `room:${room.id}/line:${e2.id}`);
    eq(c2.length, 2, 'two copies: beta and gamma (not the author, not the empty seat)');
    same(c2.map((x) => x.env.to).sort(), [betaSlug, gammaSlug].sort(), 'to beta and gamma work slugs');
    ok(c2.every((x) => x.env.kind === 'notice'), 'kind notice (@room is not a named seat)');
    ok(c2.every((x) => x.instance === aInst), 'sent WITH the author pane\'s instance');
    eq(fabric.s.threads.length, 1, 'no second thread');

    console.log('\n[F4: no double typing — the room copy arriving back is neither typed nor badged]');
    await until(() => fabric.s.subscribes.some((sl) => sl.includes(betaSlug)), 3000);
    const logMark = engineLog.length;
    fabric.push({
      id: 'env-room-copy-1', ts: new Date().toISOString(), from: 'user', to: betaSlug, thread: th?.thread,
      kind: 'ask', class: 'coordination', attention: 'notice', body: '@beta hello there',
      ref: `room:${room.id}/line:${e1.id}`, ack: 'none',
    });
    fabric.push({
      id: 'env-plain-1', ts: new Date().toISOString(), from: 'gamma', to: betaSlug, thread: 't-plain',
      kind: 'msg', class: 'info', attention: 'notice', body: 'a plain message', ack: 'none',
    });
    await until(() => engineLog.slice(logMark).includes('a plain') || /fabric → .*from gamma/.test(engineLog.slice(logMark)), 3000);
    const tail = engineLog.slice(logMark);
    ok(tail.includes(`room copy room:${room.id}/line:${e1.id}`) && tail.includes('not typed, not re-badged'), 'the room copy is recognised and skipped');
    ok(/fabric → [^\n]*from gamma[^\n]*typed=/.test(tail), 'a plain envelope still takes the typing path');
    ok(!/fabric → [^\n]*from user[^\n]*typed=/.test(tail), 'the room copy never reached the typer');

    console.log('\n[F4: read state — the ack ladder UPGRADES to seen, never downgrades]');
    const readsOf = async (id) => (await call(BASE, `/api/rooms/${room.id}/line`)).body.entries.find((e) => e.id === id)?.reads ?? {};
    fabric.s.acks.set(th.thread, [
      { message: 'm-1', to: betaSlug, ref: `room:${room.id}/line:${e1.id}`, ack: 'delivered' },
    ]);
    const r0 = await readsOf(e1.id);
    ok(r0.beta && r0.beta !== 'seen', `delivered is not seen (beta: ${r0.beta})`);
    const readsBefore = fabric.s.ackReads;
    await readsOf(e1.id);
    eq(fabric.s.ackReads, readsBefore, 'a second GET inside 5 s is served from the cache');
    fabric.s.acks.set(th.thread, [
      { message: 'm-1', to: betaSlug, ref: `room:${room.id}/line:${e1.id}`, ack: 'seen' },
      { message: 'm-3', to: gammaSlug, ref: `room:${room.id}/line:${e2.id}`, ack: 'answered' },
      { message: 'm-2', to: betaSlug, ref: `room:${room.id}/line:${e2.id}`, ack: 'none' },
    ]);
    await sleep(5200);
    const r1 = await readsOf(e1.id);
    eq(r1.beta, 'seen', 'ack seen → beta seen');
    const r2 = await readsOf(e2.id);
    eq(r2.gamma, 'seen', 'ack answered (>= seen) → gamma seen');
    ok(r2.beta !== 'seen', `ack none leaves beta as it was (${r2.beta})`);
    ok(!('alpha' in r2), 'never the author\'s own seat');

    /* ------------------------------------------- F4 flag off: old behaviour */
    console.log(`\nbooting a second scratch engine :${OFF_PORT} (HARBOR_WB_ROOM_FABRIC=0)`);
    await seed({ recipes: RECIPES }, offDbPath);
    offEngine = bootEngine(OFF_PORT, offDbPath, tmpDir, { HARBOR_WB_ROOM_FABRIC: '0' }, (d) => (offLog += d));
    await waitUp(OFF_BASE, () => offLog);
    const off = await seed(
      {
        sessions: [
          { paneid: 'q-a', recipe_id: 'rec-a', vendor: 'claude-code', agent: 'alpha', state: 'live' },
          { paneid: 'q-b', recipe_id: 'rec-b', vendor: 'cli-manager', agent: 'beta', state: 'live' },
        ],
        rooms: [{ name: 'Off', seats: [{ handle: 'alpha', recipe_id: 'rec-a', occupant: 'q-a' }, { handle: 'beta', recipe_id: 'rec-b', occupant: 'q-b' }] }],
      },
      offDbPath,
    );
    const threadsBefore = fabric.s.threads.length;
    const offSendsBefore = fabric.s.sends.filter((x) => String(x.env.ref ?? '').startsWith('room:')).length;
    const lo = await call(OFF_BASE, `/api/rooms/${off.rooms[0].id}/line`, { json: { text: '@beta hi' } });
    eq(lo.status, 200, 'flag off: the line posts');
    eq(lo.body.status, 'delivered', 'and is delivered by the room door as before');
    await sleep(1500);
    eq(fabric.s.threads.length, threadsBefore, 'flag off: no thread opened');
    eq(fabric.s.sends.filter((x) => String(x.env.ref ?? '').startsWith('room:')).length, offSendsBefore, 'flag off: no fabric copy');
    eq((await call(OFF_BASE, `/api/rooms/${off.rooms[0].id}`)).body?.room?.thread, null, 'flag off: rooms.thread stays NULL');

    /* ------------------------------------------------------- fabric down */
    console.log('\n[fabric down: could-not-tell, never a broken engine]');
    await fabric.stop();
    await seed({ sessions: [{ paneid: 'p-d', recipe_id: 'rec-d', vendor: 'claude-code', agent: 'delta', state: 'live' }] });
    const pd = await until(async () => {
      const p = (await diag()).checkin.panes['p-d'];
      return p && p.outcome !== 'pending' ? p : null;
    });
    eq(pd?.outcome, 'could-not-tell', 'a pane that appears while the fabric is down: could-not-tell');
    ok(pd?.lastError, 'with the reason recorded');
    const s4 = await send(BASE, { from: { paneid: 'p-a' }, to: 'beta', kind: 'msg', thread: 't1', body: 'hi' });
    eq(s4.status, 502, 'a send while down: 502 fabric-unreachable');
    eq((await call(BASE, '/health')).status, 200, 'the engine is healthy');

    console.log('\n[F4 with the fabric down: rooms work exactly as before, logged once]');
    const t0 = Date.now();
    const d1 = await call(BASE, `/api/rooms/${room.id}/line`, { json: { text: '@beta are you there' } });
    const d2 = await call(BASE, `/api/rooms/${room.id}/line`, { json: { text: '@gamma and you' } });
    eq(d1.status, 200, 'a line posts');
    eq(d1.body?.status, 'delivered', 'and the room door delivers it');
    eq(d2.body?.status, 'delivered', 'so does the next');
    ok(Date.now() - t0 < 2000, 'without waiting on the fabric');
    const dl = await call(BASE, `/api/rooms/${room.id}/line`);
    eq(dl.status, 200, 'GET line still answers (acks unavailable, reads as they were)');
    await until(() => engineLog.includes('room fabric: unreachable'), 3000);
    eq(engineLog.split('room fabric: unreachable').length - 1, 1, 'the outage is logged ONCE');
  } catch (e) {
    failed++;
    failures.push(String(e?.stack ?? e));
    console.log(`  ✗ threw: ${e?.stack ?? e}`);
  } finally {
    engine?.kill('SIGKILL');
    offEngine?.kill('SIGKILL');
    await fabric.stop().catch(() => {});
    await sleep(200);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* Windows EPERM on a db a dying engine still holds — a leftover temp dir is not a failure */
    }
  }

  if (failed) {
    console.log('\nengine log (tail):\n' + engineLog.split('\n').slice(-50).join('\n'));
    if (offLog) {
      console.log('\noff-engine log (tail):\n' + offLog.split('\n').slice(-20).join('\n'));
    }
    console.log('\nFAILURES:\n' + failures.map((f) => ' - ' + f).join('\n'));
  }
  console.log(`\nPASS ${passed}  FAIL ${failed}`);
  process.exit(failed ? 1 : 0);
}

run();
