/**
 * Stage 2/3 end to end: a slug on a recipe, presence on the pulse plane, and an
 * envelope addressed to that slug arriving in the pane's window.
 *
 * Boots a REAL engine and a REAL pty-broker on scratch ports with a scratch db,
 * exactly like engine.test.mjs, and never touches :7420, the real broker, or
 * data/mapping.db. A separate file rather than another section of
 * engine.test.mjs because it needs neither the fake window host nor the second
 * "remote" broker, and because the last thing engine.test.mjs does is kill that
 * remote broker — a section appended after it would be testing a half-torn-down
 * fixture.
 */
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(5); // scratch engine — port table in test/_scratch.mjs
const BROKER_PORT = P(12); // scratch broker — never the real one
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const WS_URL = `ws://${HOST}:${PORT}/pty`;
const TEST_TOKEN = 'test-token-do-not-ship';
/* The engine's own node slug, pinned so the presence assertion is about the
   engine reading HARBOR_WB_NODE and not about which host happens to run this. */
const TEST_NODE = 'testnode';
const TEST_TARGETS = JSON.stringify({
  targets: [
    { id: 'local', label: 'Local', kind: 'local', shell: 'powershell.exe' },
    /* An ssh target with `node` PINNED — the rung of nodeOfTarget that exists
       so a registry slug which matches no hostname can be set without code. */
    { id: 'pinned', label: 'Pinned node', kind: 'ssh', sshAlias: 'unused', node: 'faraway' },
  ],
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

/** A complete contract-§2 envelope, with `to` supplied per call. */
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
    body: 'hello from the other side',
    ack: 'none',
    ...over,
  };
}
const postEnvelope = async (env) => {
  const res = await fetch(`${BASE}/api/fabric/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(env),
  });
  return { status: res.status, body: await res.json() };
};

async function run() {
  try {
    const stale = await fetch(BASE + '/health').then((r) => r.json()).catch(() => null);
    if (stale) {
      console.log(`\n✗ port ${PORT} is already serving an engine (stale/orphan). Kill it first.`);
      process.exit(2);
    }
  } catch {
    /* refused = free = good */
  }
  for (const p of [PORT, BROKER_PORT]) {
    await assertFree(p, 'fabric-inbound.test.mjs');
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-fabric-'));
  const dbPath = join(tmpDir, 'mapping.db');
  let engineLog = '';

  const tsxLoader = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');
  const loaderArg = `file://${tsxLoader.replace(/\\/g, '/')}`;

  function bootEngine() {
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
        HARBOR_WB_NATS_URL: '', // presence must be silent-and-harmless with no NATS
        /* The fabric subscriber must never dial from a test: 8204 is the real
        server service's port and a test engine has no business on it. '' is the
        documented off switch, same posture as HARBOR_WB_NATS_URL above. */
        HARBOR_WB_FABRIC_URL: '',
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_BROKER_PORT: String(BROKER_PORT),
        HARBOR_WB_BROKER_AUTOSTART: '0', // never touch the real scheduled task
        HARBOR_WB_TARGETS: TEST_TARGETS,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d) => (engineLog += d));
    proc.stderr.on('data', (d) => (engineLog += d));
    return proc;
  }
  function bootBroker() {
    const proc = spawn(process.execPath, ['--import', loaderArg, 'node_modules/pty-broker/src/main.ts'], {
      cwd: REPO_ROOT,
      env: childEnv({ PTY_BROKER_PORT: String(BROKER_PORT) }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d) => (engineLog += d));
    proc.stderr.on('data', (d) => (engineLog += d));
    return proc;
  }
  async function waitFor(url, test) {
    for (let i = 0; i < 40; i++) {
      try {
        if (test(await (await fetch(url)).json())) {
          return true;
        }
      } catch {
        /* not yet */
      }
      await sleep(250);
    }
    return false;
  }

  console.log(`booting scratch broker :${BROKER_PORT} + engine :${PORT} (db ${dbPath})`);
  const broker = bootBroker();
  if (!(await waitFor(`http://127.0.0.1:${BROKER_PORT}/health`, () => true))) {
    console.log(`broker did not come up.\n${engineLog}`);
    process.exit(1);
  }
  const engine = bootEngine();

  try {
    if (!(await waitFor(BASE + '/health', (h) => h.status === 'ok'))) {
      throw new Error(`engine did not come up.\n--- log ---\n${engineLog}`);
    }

    /* ---------------------------------------------------------------- Stage 2 */
    console.log('\n[recipe identity: vendor is stored, runClaude still answered]');
    const mk = async (body) =>
      (
        await fetch(BASE + '/api/recipes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json();

    /* wr §2.9 (T1, ruled 2026-09-24): a bare shell derives NO slug; a typed
       slug is the escape hatch for a non-brand that needs addressing. So the
       shell used for presence below carries a typed slug. */
    const bare = (await mk({ name: 'Bare Shell', target: 'local', projectDir: tmpDir, runClaude: false })).recipe;
    eq(bare.agent ?? null, null, 'a bare shell (non-brand, untyped) derives no slug (wr §2.9)');
    await fetch(`${BASE}/api/recipes/${bare.id}`, { method: 'DELETE' });
    const shell = (
      await mk({ name: 'Fabric Shell', target: 'local', projectDir: tmpDir, runClaude: false, agent: 'fabric-shell' })
    ).recipe;
    eq(shell.vendor, 'cli-manager', 'runClaude:false → vendor cli-manager');
    eq(shell.runClaude, 0, 'runClaude still answered for old clients');
    const agentRec = (await mk({ name: 'Fabric Agent', target: 'local', projectDir: tmpDir, vendor: 'claude-code' }))
      .recipe;
    eq(agentRec.vendor, 'claude-code', 'vendor accepted on write');
    eq(agentRec.runClaude, 1, '...and runClaude is DERIVED from it, not sent');
    const agentDerived = agentRec.agent;
    await fetch(`${BASE}/api/recipes/${agentRec.id}`, { method: 'DELETE' });

    console.log('\n[agent slug: derived when empty, normalised when typed]');
    /* mkdtemp gives a name like `wb-fabric-AbC123`; the derived slug is that,
       lowercased, with NO role suffix (SUPERSEDES `-cli`, 2026-09-17 — the
       registry's node ids are the bare project name). Asserting against the
       folder rather than a literal keeps this honest about where the default
       comes from. */
    const expectDerived = tmpDir.split(/[\\/]/).pop().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    eq(agentDerived, expectDerived, 'a brand recipe with an empty slug derives <project folder>, no role suffix');
    eq(shell.agent, 'fabric-shell', 'a typed slug on a shell is kept');
    const typed = (
      await mk({ name: 'Typed Slug', target: 'local', projectDir: tmpDir, runClaude: false, agent: 'Briefing Table' })
    ).recipe;
    eq(typed.agent, 'briefing-table', 'a typed slug is normalised, not rejected');
    await fetch(`${BASE}/api/recipes/${typed.id}`, { method: 'DELETE' });

    console.log('\n[the empty `agent` column finally carries the stable identity]');
    const pane = `recipe:${shell.id}`;
    const c = client();
    await c.open();
    c.send({ type: 'attach', paneid: pane, recipe: shell.id });
    await c.await((m) => m.type === 'pane.ready' && m.paneid === pane, 12000);
    const row = (await fetchJson('/api/table')).sessions.find((s) => s.paneid === pane);
    eq(row.agent, shell.agent, 'sessions.agent = recipe.agent on spawn');
    eq(row.vendor, 'cli-manager', 'sessions.vendor follows the recipe');

    console.log('\n[session presence: published for any vendor with a slug]');
    const diag = await fetchJson('/api/diag/presence');
    eq(diag.node, TEST_NODE, 'the engine reports its own node (HARBOR_WB_NODE)');
    eq(diag.subject, 'agent.<slug>.state', 'the subject shape is stated');
    const p = diag.agents.find((a) => a.slug === shell.agent);
    ok(!!p, 'the attached pane appears under its slug');
    eq(p.vendor, 'cli-manager', 'presence carries the vendor');
    eq(p.node, TEST_NODE, 'a LOCAL target resolves to the engine node');
    eq(p.paneid, pane, 'presence carries the paneid as lineage');
    eq(p.attached, true, 'attached while a window is bound');
    ok(['idle', 'streaming', 'waiting'].includes(p.state), `state is contract vocabulary (${p.state})`);
    eq(p.project, tmpDir, 'presence carries the project dir');
    eq(diag.nats, false, 'NATS off is reported, not faked');

    console.log('\n[inbound: a recipe whose slug exists but has no LIVE session]');
    /* Deliberately not spawned — an ssh target needs a real host. The point is
       that a KNOWN slug with no running pane is still a 404: "we know who you
       mean and nobody is there" and "we have never heard of them" are the same
       answer to a sender, and the alternative — a silent 200 — is exactly how
       offer-url went unnoticed for weeks (2026-09-04). */
    const pinned = (
      await mk({ name: 'Pinned', target: 'pinned', projectDir: tmpDir, runClaude: false, agent: 'pinned-cli' })
    ).recipe;
    const noSession = await postEnvelope(envelope('pinned-cli'));
    eq(noSession.status, 404, 'a slug with no LIVE session is a 404, never a silent 200');
    ok(/no live session/.test(noSession.body.error), 'and the 404 says why');
    await fetch(`${BASE}/api/recipes/${pinned.id}`, { method: 'DELETE' });

    /* ---------------------------------------------------------------- Stage 3 */
    console.log('\n[inbound envelope: validation names the field]');
    const missing = await postEnvelope({ ...envelope(shell.agent), thread: undefined });
    eq(missing.status, 400, 'a missing required field is a 400');
    eq(missing.body.field, 'thread', '...naming the field');
    const badKind = await postEnvelope(envelope(shell.agent, { kind: 'message' }));
    eq(badKind.status, 400, 'an off-contract enum is a 400');
    eq(badKind.body.field, 'kind', '...naming the field');

    console.log('\n[inbound envelope: unknown slug → 404]');
    const unknown = await postEnvelope(envelope('nobody-here-cli'));
    eq(unknown.status, 404, 'unknown slug is 404');
    ok(typeof unknown.body.error === 'string', 'with an error string');
    const grouped = await postEnvelope(envelope('@all'));
    eq(grouped.status, 404, '@all is 404 here — the fabric routes groups, not the engine');

    console.log('\n[inbound envelope: delivered to the attached window]');
    const env1 = envelope(shell.agent, { body: 'FABRIC_CODEWORD_ALPHA', attention: 'ask', kind: 'ask' });
    const del = await postEnvelope(env1);
    eq(del.status, 200, 'accepted');
    eq(del.body.delivered, true, 'reported delivered (a viewer is attached)');
    eq(del.body.queued, false, '...and therefore not queued');
    eq(del.body.paneid, pane, 'resolved the slug to the pane');
    const ev = await c.await((m) => m.type === 'fabric.message' && m.paneid === pane, 8000);
    eq(ev.messages.length, 1, 'the window received one message');
    eq(ev.messages[0].body, 'FABRIC_CODEWORD_ALPHA', 'body arrived intact');
    eq(ev.messages[0].from, 'platform', 'from arrived');
    eq(ev.messages[0].attention, 'ask', 'attention arrived as the router set it');

    console.log('\n[inbound envelope: queue while nobody is attached, flush on attach]');
    c.close();
    await sleep(500); // the socket close has to reach the engine
    const q = await postEnvelope(envelope(shell.agent, { body: 'FABRIC_CODEWORD_BRAVO' }));
    eq(q.status, 200, 'accepted with no window');
    eq(q.body.delivered, false, 'not delivered — nobody is watching');
    eq(q.body.queued, true, 'queued instead');
    const c2 = client();
    await c2.open();
    c2.send({ type: 'attach', paneid: pane, recipe: shell.id });
    await c2.await((m) => m.type === 'pane.ready' && m.paneid === pane, 12000);
    const flushed = await c2.await((m) => m.type === 'fabric.message' && m.paneid === pane, 8000);
    eq(flushed.messages.length, 2, 'the reattach flushed BOTH (nothing was lost while parked)');
    ok(
      flushed.messages.some((m) => m.body === 'FABRIC_CODEWORD_BRAVO'),
      'including the one that arrived while parked',
    );

    console.log('\n[fabric-dismiss: by id, then all]');
    c2.send({ type: 'fabric-dismiss', paneid: pane, id: env1.id });
    const afterOne = await c2.await(
      (m) => m.type === 'fabric.message' && m.paneid === pane && m.messages.length === 1,
      8000,
    );
    eq(afterOne.messages[0].body, 'FABRIC_CODEWORD_BRAVO', 'dismiss by id removed exactly the one named');
    c2.send({ type: 'fabric-dismiss', paneid: pane });
    await c2.await((m) => m.type === 'fabric.message' && m.paneid === pane && m.messages.length === 0, 8000);
    ok(true, 'dismiss-all clears the badge');

    console.log('\n[the body is never logged — counts only]');
    ok(!engineLog.includes('FABRIC_CODEWORD_ALPHA'), 'envelope bodies stay out of the log');
    ok(/fabric →/.test(engineLog), '...while the routing facts are logged');

    console.log('\n[presence: ended when the session ends]');
    c2.send({ type: 'kill', paneid: pane });
    await c2.await((m) => m.type === 'pane.exit' && m.paneid === pane, 8000);
    await sleep(300);
    const diag2 = await fetchJson('/api/diag/presence');
    const p2 = diag2.agents.find((a) => a.slug === shell.agent);
    eq(p2.state, 'ended', 'the last presence for a dead session is ended');
    eq(p2.attached, false, '...and not attached');
    c2.close();
    await fetch(`${BASE}/api/recipes/${shell.id}`, { method: 'DELETE' });
  } catch (err) {
    failed++;
    failures.push(`EXCEPTION: ${err.message}`);
    console.log(`\n✗ EXCEPTION: ${err.message}`);
    console.log(`--- engine/broker log tail ---\n${engineLog.slice(-2500)}`);
  } finally {
    engine.kill();
    broker.kill();
    await sleep(300);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* db file may linger if the engine has not released it; harmless in tmp */
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
