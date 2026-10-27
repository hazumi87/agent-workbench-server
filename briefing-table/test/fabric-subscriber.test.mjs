/**
 * ENGINE AS FABRIC SUBSCRIBER — the engine dials the message fabric, subscribes
 * for every slug it hosts, and delivers what arrives into the pane.
 *
 * Boots a REAL engine and a REAL pty-broker on scratch ports with a scratch db,
 * exactly like fabric-inbound.test.mjs, and never touches :7420, :8201, the real
 * broker or data/mapping.db. The FABRIC is a stub: node http + ws speaking the
 * protocol platform froze on 2026-09-17, because the service does not exist yet
 * (it will be systemd `fabric-service` on 127.0.0.1:8204) and a test that needed
 * it installed would be a test that never runs.
 *
 * The stub is also the only place the REPLAY case is reachable: "reconnect and
 * the mailbox is re-sent" is the fabric's durability guarantee working, and the
 * duplicate it produces is the thing the engine has to swallow.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(6); // scratch engine — port table in test/_scratch.mjs
const BROKER_PORT = P(13); // scratch broker — never the real one
const FABRIC_PORT = P(14); // the STUB fabric — NOT 8204 (the real one, once it exists)
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const WS_URL = `ws://${HOST}:${PORT}/pty`;
const TEST_TOKEN = 'test-token-do-not-ship';
const TEST_NODE = 'testnode';
const TEST_TARGETS = JSON.stringify({
  targets: [{ id: 'local', label: 'Local', kind: 'local', shell: 'powershell.exe' }],
});

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const headers = new Headers(init.headers || {});
  if (String(input).startsWith(BASE) && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${TEST_TOKEN}`);
  }
  return realFetch(input, { ...init, headers });
};

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
const fetchJson = (path) => fetch(BASE + path).then((r) => r.json());

/** Poll until `pred(value)` or the budget runs out. Everything here is
 *  eventually-consistent across two processes, so a fixed sleep is either slow
 *  or flaky; this is neither. */
async function until(fn, pred, ms = 8000, step = 100) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (pred(last)) {
        return last;
      }
    } catch {
      /* not yet */
    }
    await sleep(step);
  }
  return last;
}

/* ---------------------------------------------------------------------------
 * THE STUB FABRIC — the frozen /subscribe + /ack protocol, and nothing else.
 * ------------------------------------------------------------------------- */
function stubFabric({ rejectSlugs = [] } = {}) {
  const state = {
    /** every Authorization header seen on an upgrade */
    upgradeAuth: [],
    /** every `subscribe` frame's slug list, in order */
    subscribes: [],
    /** every ack the engine POSTed: {id, level, auth} */
    acks: [],
    /** live subscriber sockets */
    sockets: new Set(),
    connections: 0,
  };

  const http = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/ack' && req.method === 'POST') {
        let parsed = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          /* recorded as-is below */
        }
        state.acks.push({ ...parsed, auth: req.headers.authorization ?? null });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: parsed.id, ack: parsed.level }));
        return;
      }
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', protocolVersion: 1 }));
        return;
      }
      res.writeHead(404).end();
    });
  });

  /* noServer + one upgrade router, per the 2026-09-15 finding: a second
     WebSocketServer constructed with {server} destroys the first one's
     handshakes. One stub, one path, but the habit is the point. */
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== '/subscribe') {
      socket.destroy();
      return;
    }
    state.upgradeAuth.push(req.headers.authorization ?? null);
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    state.connections++;
    state.sockets.add(ws);
    ws.on('close', () => state.sockets.delete(ws));
    ws.on('message', (raw) => {
      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m.type === 'subscribe') {
        state.subscribes.push(m.slugs);
        const accepted = (m.slugs ?? []).filter((s) => !rejectSlugs.includes(s));
        const rejected = (m.slugs ?? [])
          .filter((s) => rejectSlugs.includes(s))
          .map((slug) => ({ slug, error: 'unknown slug' }));
        ws.send(JSON.stringify({ type: 'subscribed', slugs: accepted, rejected }));
      }
    });
    ws.send(JSON.stringify({ type: 'ready' }));
  });

  return {
    state,
    listen: () => new Promise((r) => http.listen(FABRIC_PORT, HOST, r)),
    /** Push one envelope to every subscriber, exactly as the fabric would. */
    push: (envelope) => {
      for (const ws of state.sockets) {
        ws.send(JSON.stringify({ type: 'message', envelope }));
      }
    },
    /** Yank the service out from under the engine (the outage case). */
    stop: () =>
      new Promise((r) => {
        for (const ws of state.sockets) {
          ws.terminate();
        }
        wss.close();
        http.close(r);
        http.closeAllConnections?.();
      }),
  };
}

/** A complete contract-§2 envelope. */
function envelope(to, over = {}) {
  return {
    id: `env-${Math.random().toString(16).slice(2, 10)}`,
    ts: new Date().toISOString(),
    from: 'platform',
    to,
    kind: 'msg',
    class: 'coordination',
    attention: 'notice',
    thread: 't:deadbeef',
    body: 'pushed over the subscription',
    ack: 'none',
    ...over,
  };
}

function client() {
  const ws = new WebSocket(WS_URL, { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
  ws.on('error', () => {});
  const waiters = [];
  const log = [];
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
    open: () => new Promise((r) => ws.once('open', r)),
    send: (cmd) => ws.send(JSON.stringify(cmd)),
    await: (pred, timeoutMs = 8000) =>
      new Promise((resolve, reject) => {
        const hit = log.find(pred);
        if (hit) {
          return resolve(hit);
        }
        const t = setTimeout(() => reject(new Error('timeout waiting for event')), timeoutMs);
        waiters.push({
          pred,
          resolve: (m) => {
            clearTimeout(t);
            resolve(m);
          },
        });
      }),
    close: () => ws.close(),
    log,
  };
}

async function run() {
  for (const [name, port] of [
    ['engine', PORT],
    ['fabric stub', FABRIC_PORT],
  ]) {
    const stale = await fetch(`http://${HOST}:${port}/health`)
      .then((r) => r.text())
      .catch(() => null);
    if (stale) {
      console.log(`\n✗ port ${port} is already serving (${name}, stale/orphan). Kill it first.`);
      process.exit(2);
    }
  }
  for (const p of [PORT, BROKER_PORT, FABRIC_PORT]) {
    await assertFree(p, 'fabric-subscriber.test.mjs');
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-fabsub-'));
  const dbPath = join(tmpDir, 'mapping.db');
  let engineLog = '';

  const tsxLoader = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');
  const loaderArg = `file://${tsxLoader.replace(/\\/g, '/')}`;

  function bootEngine(extraEnv = {}) {
    const proc = spawn(process.execPath, ['--import', loaderArg, 'src/server/index.ts'], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_PORT: String(PORT),
        HARBOR_WB_HOST: HOST,
        HARBOR_WB_TABLE: dbPath,
        HARBOR_WB_NODE: TEST_NODE,
        HARBOR_WB_TOKEN: TEST_TOKEN,
        HARBOR_WB_IDENTITY: 'legacy',
        HARBOR_WB_NO_WINDOW: '1',
        HARBOR_WB_NATS_URL: '',
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_BROKER_PORT: String(BROKER_PORT),
        HARBOR_WB_BROKER_AUTOSTART: '0',
        HARBOR_WB_TARGETS: TEST_TARGETS,
        HARBOR_WB_FABRIC_URL: `http://${HOST}:${FABRIC_PORT}`,
        /* The sweep is the BACKSTOP for a missed nudge, and this test asserts
           the nudge. Pushed past the run so a pass can never be the sweep
           covering for wiring that does not work. */
        HARBOR_WB_FABRIC_SWEEP_MS: '600000',
        HARBOR_WB_FABRIC_DEBOUNCE_MS: '100',
        ...extraEnv,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d) => (engineLog += d));
    proc.stderr.on('data', (d) => (engineLog += d));
    return proc;
  }
  function bootBroker() {
    const proc = spawn(
      process.execPath,
      ['--import', loaderArg, 'node_modules/pty-broker/src/main.ts'],
      {
        cwd: REPO_ROOT,
        env: childEnv({ PTY_BROKER_PORT: String(BROKER_PORT) }),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    proc.stdout.on('data', (d) => (engineLog += d));
    proc.stderr.on('data', (d) => (engineLog += d));
    return proc;
  }
  async function waitForEngine() {
    for (let i = 0; i < 60; i++) {
      try {
        if ((await (await fetch(BASE + '/health')).json()).status === 'ok') {
          return true;
        }
      } catch {
        /* not yet */
      }
      await sleep(250);
    }
    return false;
  }

  console.log(`booting stub fabric :${FABRIC_PORT}, broker :${BROKER_PORT}, engine :${PORT}`);
  const fab = stubFabric({ rejectSlugs: ['rejected-cli'] });
  await fab.listen();
  const broker = bootBroker();
  await until(
    () => fetch(`http://${HOST}:${BROKER_PORT}/health`).then((r) => r.json()),
    () => true,
    10000,
  );
  let engine = bootEngine();

  try {
    if (!(await waitForEngine())) {
      throw new Error(`engine did not come up.\n--- log ---\n${engineLog}`);
    }

    const mk = async (body) =>
      (
        await fetch(BASE + '/api/recipes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json();

    /* ------------------------------------------------------------ connect */
    console.log('\n[connects to the fabric and presents the engine bearer]');
    await until(() => Promise.resolve(fab.state.connections), (n) => n >= 1, 8000);
    ok(fab.state.connections >= 1, 'the engine dialled /subscribe unprompted');
    eq(
      fab.state.upgradeAuth[0],
      `Bearer ${TEST_TOKEN}`,
      'the upgrade carried the engine bearer (no third credential)',
    );
    const d0 = await until(() => fetchJson('/api/diag/fabric'), (d) => d.state === 'subscribed');
    eq(d0.enabled, true, '/api/diag/fabric says enabled');
    eq(d0.url, `http://${HOST}:${FABRIC_PORT}`, '...and names the URL it is using');
    eq(d0.state, 'subscribed', '...and reaches `subscribed` with no panes at all');
    eq(d0.subscribedSlugs.length, 0, 'the empty engine subscribes to nothing, and says so');

    /* ---------------------------------------------------- the subscribe set */
    console.log('\n[the subscribe set is the LIVE slugs, re-sent when a row goes live]');
    const beforeCount = fab.state.subscribes.length;
    const rec = (
      await mk({
        name: 'Subscriber Pane',
        target: 'local',
        projectDir: tmpDir,
        runClaude: false,
        agent: 'subscriber-cli',
      })
    ).recipe;
    eq(rec.agent, 'subscriber-cli', 'the recipe carries the slug');
    ok(
      fab.state.subscribes.length === beforeCount,
      'a RECIPE alone does not change the set — a recipe is not a session',
    );

    const pane = `recipe:${rec.id}`;
    const c = client();
    await c.open();
    c.send({ type: 'attach', paneid: pane, recipe: rec.id });
    await c.await((m) => m.type === 'pane.ready' && m.paneid === pane, 15000);

    const d1 = await until(
      () => fetchJson('/api/diag/fabric'),
      (d) => d.subscribedSlugs.includes('subscriber-cli'),
    );
    ok(d1.subscribedSlugs.includes('subscriber-cli'), 'a new LIVE row re-sent `subscribe`');
    ok(
      fab.state.subscribes.length > beforeCount,
      `...and the fabric saw the frame (${fab.state.subscribes.length} total)`,
    );
    const lastSub = fab.state.subscribes[fab.state.subscribes.length - 1];
    eq(lastSub.length, 1, 'the frame carries the WHOLE hosted set, not a delta');

    console.log('\n[de-duped: an unchanged set is not re-sent]');
    const stable = fab.state.subscribes.length;
    /* Typing produces activity-state changes, which nudge the refresh — the
       de-dupe is the only thing standing between that and a frame per burst. */
    c.send({ type: 'input', paneid: pane, data: 'echo hello\r' });
    await sleep(1200);
    eq(fab.state.subscribes.length, stable, 'no redundant subscribe frame for an unchanged set');

    /* ----------------------------------------------------------- delivery */
    console.log('\n[a pushed envelope lands in the pane and is acked `delivered`]');
    const env1 = envelope('subscriber-cli', { body: 'SUBSCRIBER_CODEWORD_ALPHA', kind: 'ask' });
    fab.push(env1);
    const ev = await c.await((m) => m.type === 'fabric.message' && m.paneid === pane, 8000);
    ok(
      ev.messages.some((m) => m.id === env1.id),
      'the window got it as `fabric.message` — the SAME event the push door uses',
    );
    eq(
      ev.messages.find((m) => m.id === env1.id).body,
      'SUBSCRIBER_CODEWORD_ALPHA',
      'body arrived intact',
    );
    await until(() => Promise.resolve(fab.state.acks), (a) => a.some((x) => x.id === env1.id));
    const ack1 = fab.state.acks.filter((a) => a.id === env1.id);
    eq(ack1.length, 1, 'exactly one ack was POSTed for it');
    eq(ack1[0].level, 'delivered', '...at level `delivered`');
    eq(ack1[0].auth, `Bearer ${TEST_TOKEN}`, '...carrying the same bearer');

    /* -------------------------------------------------------- idempotency */
    console.log('\n[a mailbox replay of the same id is neither delivered nor acked twice]');
    const beforeDup = (await fetchJson('/api/diag/fabric')).duplicates;
    fab.push(env1); // the fabric replaying its mailbox — the durability guarantee
    const dupDiag = await until(
      () => fetchJson('/api/diag/fabric'),
      (d) => d.duplicates > beforeDup,
    );
    ok(dupDiag.duplicates > beforeDup, 'the duplicate was recognised and counted');
    eq(
      fab.state.acks.filter((a) => a.id === env1.id).length,
      1,
      'still exactly ONE ack — a duplicate is never re-acked',
    );
    eq(
      c.log.filter((m) => m.type === 'fabric.message' && m.messages.some((x) => x.id === env1.id))
        .length,
      1,
      'and the pane was told about it exactly once',
    );

    /* -------------------------------------------------------- the seen ack */
    console.log('\n[human input acks `seen` — once per envelope, not once per keystroke]');
    const env2 = envelope('subscriber-cli', { body: 'SUBSCRIBER_CODEWORD_BRAVO' });
    fab.push(env2);
    await until(() => Promise.resolve(fab.state.acks), (a) => a.some((x) => x.id === env2.id));
    eq(
      fab.state.acks.filter((a) => a.level === 'seen').length,
      0,
      'nothing is `seen` before a human touches the pane',
    );
    for (const ch of ['a', 'b', 'c', 'd', 'e']) {
      c.send({ type: 'input', paneid: pane, data: ch });
      await sleep(60);
    }
    const seenAcks = await until(
      () => Promise.resolve(fab.state.acks.filter((a) => a.level === 'seen')),
      (a) => a.length >= 2,
    );
    eq(seenAcks.length, 2, 'FIVE keystrokes produced TWO seen acks — one per delivered envelope');
    ok(
      seenAcks.some((a) => a.id === env1.id) && seenAcks.some((a) => a.id === env2.id),
      '...naming both envelopes the pane had been shown',
    );
    const d2 = await until(() => fetchJson('/api/diag/fabric'), (d) => d.acked.seen >= 2);
    eq(d2.acked.seen, 2, 'the diag counts them');
    eq(d2.awaitingSeenAck, 0, '...and nothing is left owing');
    ok(
      !fab.state.acks.some((a) => a.level === 'answered' || a.level === 'resolved'),
      'never `answered` or `resolved` — those are not a glance (asks decay in loudness, not existence)',
    );

    /* ------------------------------------------------------ rejected slugs */
    console.log('\n[a rejected slug is reported and does NOT drop the socket]');
    const conns = fab.state.connections;
    const rejRec = (
      await mk({
        name: 'Rejected Pane',
        target: 'local',
        projectDir: tmpDir,
        runClaude: false,
        agent: 'rejected-cli',
      })
    ).recipe;
    const rejPane = `recipe:${rejRec.id}`;
    const c2 = client();
    await c2.open();
    c2.send({ type: 'attach', paneid: rejPane, recipe: rejRec.id });
    await c2.await((m) => m.type === 'pane.ready' && m.paneid === rejPane, 15000);
    const d3 = await until(
      () => fetchJson('/api/diag/fabric'),
      (d) => d.rejected.some((r) => r.slug === 'rejected-cli'),
    );
    ok(d3.rejected.some((r) => r.slug === 'rejected-cli'), 'the rejection is visible in the diag');
    ok(
      d3.rejected.some((r) => r.slug === 'rejected-cli' && r.error === 'unknown slug'),
      'the ERROR STRING rides along too — {slug, error}, not a bare slug list',
    );
    ok(d3.subscribedSlugs.includes('subscriber-cli'), '...while the good slug stays subscribed');
    eq(fab.state.connections, conns, 'the socket was NOT dropped by the rejection');

    /* the push door still works, unchanged — it is the fallback and both doors
       are the same function underneath */
    console.log('\n[the push door (/api/fabric/inbound) still works, unchanged]');
    const env3 = envelope('subscriber-cli', { body: 'SUBSCRIBER_CODEWORD_CHARLIE' });
    const pushRes = await fetch(`${BASE}/api/fabric/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(env3),
    });
    const pushBody = await pushRes.json();
    eq(pushRes.status, 200, 'accepted');
    eq(pushBody.delivered, true, 'reported delivered');
    eq(pushBody.paneid, pane, 'resolved the slug to the same pane');
    const bad = await fetch(`${BASE}/api/fabric/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope('@all')),
    });
    eq(bad.status, 404, '@all is still a 404 — the engine is not the router');

    /* ------------------------------------------------------------ outage */
    console.log('\n[fabric outage: the engine reconnects, re-subscribes, and keeps serving]');
    const reconnectsBefore = (await fetchJson('/api/diag/fabric')).reconnects;
    await fab.stop();
    const health = await fetchJson('/health');
    eq(health.status, 'ok', 'the engine keeps serving /health with the fabric gone');
    const dDown = await until(
      () => fetchJson('/api/diag/fabric'),
      (d) => d.reconnects > reconnectsBefore,
      10000,
    );
    ok(dDown.reconnects > reconnectsBefore, 'it noticed and started reconnecting');
    ok(
      ['reconnecting', 'connecting'].includes(dDown.state),
      `...and says so (${dDown.state}) rather than claiming subscribed`,
    );
    /* the pane is untouched by any of it */
    c.send({ type: 'input', paneid: pane, data: '\r' });
    const stillAlive = await fetchJson('/api/table');
    ok(
      stillAlive.sessions.some((s) => s.paneid === pane && s.state === 'live'),
      'the session is untouched — a fabric outage is not an engine outage',
    );

    const fab2 = stubFabric({ rejectSlugs: ['rejected-cli'] });
    await fab2.listen();
    const dUp = await until(
      () => fetchJson('/api/diag/fabric'),
      (d) => d.state === 'subscribed',
      40000,
    );
    eq(dUp.state, 'subscribed', 'the fabric came back and the engine re-subscribed');
    ok(
      dUp.subscribedSlugs.includes('subscriber-cli'),
      '...re-sending the WHOLE hosted set on the new socket',
    );
    const env4 = envelope('subscriber-cli', { body: 'SUBSCRIBER_CODEWORD_DELTA' });
    fab2.push(env4);
    const afterOutage = await c.await(
      (m) => m.type === 'fabric.message' && m.messages.some((x) => x.id === env4.id),
      8000,
    );
    ok(!!afterOutage, 'delivery resumed on the new socket');

    console.log('\n[the body is never logged — counts only]');
    for (const word of ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA']) {
      ok(
        !engineLog.includes(`SUBSCRIBER_CODEWORD_${word}`),
        `envelope body ${word} stayed out of the log`,
      );
    }
    ok(/\[engine-fabric\]/.test(engineLog), '...while the subscriber narrates its state changes');

    /* ------------------------------------------------- ended session, then off */
    console.log('\n[a session ending takes its slug out of the set]');
    c2.send({ type: 'kill', paneid: rejPane });
    await c2.await((m) => m.type === 'pane.exit' && m.paneid === rejPane, 10000);
    const dEnd = await until(
      () => fetchJson('/api/diag/fabric'),
      (d) => !d.requestedSlugs.includes('rejected-cli'),
    );
    ok(!dEnd.requestedSlugs.includes('rejected-cli'), 'the dead slug is no longer requested');
    ok(dEnd.requestedSlugs.includes('subscriber-cli'), '...and the live one still is');
    c.close();
    c2.close();
    await fab2.stop();

    console.log('\n[HARBOR_WB_FABRIC_URL=off: nothing dials, and the diag says disabled]');
    engine.kill();
    await sleep(600);
    const fab3 = stubFabric();
    await fab3.listen();
    engine = bootEngine({ HARBOR_WB_FABRIC_URL: 'off' });
    if (!(await waitForEngine())) {
      throw new Error(`engine did not come back up.\n--- log ---\n${engineLog}`);
    }
    await sleep(1500);
    const dOff = await fetchJson('/api/diag/fabric');
    eq(dOff.enabled, false, 'disabled is reported, not faked');
    eq(dOff.state, 'disabled', '...as a state, not as "connecting forever"');
    eq(dOff.url, '', '...with no URL to mislead anyone');
    eq(fab3.state.connections, 0, 'and NOTHING dialled the fabric');
    await fab3.stop();
  } catch (err) {
    failed++;
    failures.push(`EXCEPTION: ${err.message}`);
    console.log(`\n✗ EXCEPTION: ${err.message}`);
    console.log(`--- engine/broker log tail ---\n${engineLog.slice(-3000)}`);
  } finally {
    engine.kill();
    broker.kill();
    await sleep(300);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* the db file may linger if the engine has not released it; harmless in tmp */
    }
  }

  console.log(`\n${'='.repeat(40)}`);
  console.log(`PASS ${passed}  FAIL ${failed}`);
  if (failed > 0) {
    console.log('failures:');
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
    process.exit(1);
  }
  console.log('all green');
  process.exit(0);
}

run();
