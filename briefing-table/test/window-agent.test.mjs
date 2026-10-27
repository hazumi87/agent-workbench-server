/**
 * window-agent.test — the PULL seam, end to end against a REAL engine.
 *
 * Phase 2 of the migration plan; contract §5b (D3 = PULL, Owner
 * 2026-09-15). A window agent on a desktop dials IN, registers, and executes
 * `window.open|focus|close` on the engine's behalf. This file plays the agent.
 *
 * WHY A SEPARATE FILE AND A SEPARATE ENGINE: `HARBOR_WB_DESKTOP` is read once,
 * at boot, and engine.test.mjs's whole placement block asserts the LOOPBACK
 * behaviour against a fake :8200. Two modes cannot share one process, and the
 * loopback assertions are the ones that must not move.
 *
 * SAFETY: scratch port, scratch db in a temp dir, no broker, no window host,
 * `HARBOR_WB_DESKTOP=agent` so nothing local is ever spawned. Never touches the
 * live engine (:7420), the brokers, or the real :8200.
 */
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(3); // scratch engine — port table in test/_scratch.mjs
/* Told to the engine as its broker; NOTHING may listen there (no PTY is
 * spawned in this file), so assertFree checks it too. */
const DEAD_BROKER_PORT = P(12);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TEST_TOKEN = 'test-token-do-not-ship';
const WA_TOKEN = 'test-window-agent-credential';
/** The address the AGENT would open — deliberately NOT the engine's own origin,
 *  so a url built from the engine's loopback instead of the agent's base fails
 *  loudly rather than looking right on a machine where both happen to match. */
const AGENT_BASE = 'http://host.example.ts.net:7420';
const AGENT_TIMEOUT_MS = 800; // short, so the timeout path costs under a second

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

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const headers = new Headers(init.headers || {});
  if (String(input).startsWith(BASE) && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${TEST_TOKEN}`);
  }
  return realFetch(input, { ...init, headers });
};
async function api(path, body, method = 'POST') {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

/** The window agent: connects, registers, and answers (or deliberately does
 *  not) the engine's `window.*` requests. */
function windowAgent({ autoAnswer = true } = {}) {
  const ws = new WebSocket(`ws://${HOST}:${PORT}/window-agent`, {
    headers: { authorization: `Bearer ${WA_TOKEN}` },
  });
  ws.on('error', () => {});
  const log = [];
  const waiters = [];
  let answer = { ok: true };
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
    if (autoAnswer && typeof msg.req === 'string' && String(msg.type).startsWith('window.')) {
      ws.send(JSON.stringify({ type: 'window.result', req: msg.req, ...answer }));
    }
  });
  return {
    open: () => new Promise((r) => ws.once('open', r)),
    send: (m) => ws.send(JSON.stringify(m)),
    setAnswer: (a) => {
      answer = a;
    },
    await: (pred, timeoutMs = 4000) =>
      new Promise((resolve, reject) => {
        const hit = log.find(pred);
        if (hit) {
          return resolve(hit);
        }
        const t = setTimeout(() => reject(new Error('timeout waiting for a window.* event')), timeoutMs);
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
  try {
    const stale = await fetch(BASE + '/health').then((r) => r.json()).catch(() => null);
    if (stale) {
      console.log(`\n✗ port ${PORT} is already serving an engine (stale/orphan). Kill it first.\n`);
      process.exit(2);
    }
  } catch {
    /* connection refused = port free = good */
  }
  for (const p of [PORT, DEAD_BROKER_PORT]) {
    await assertFree(p, 'window-agent.test.mjs');
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-wa-'));
  let engineLog = '';
  const tsxLoader = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');
  const engine = spawn(
    process.execPath,
    ['--import', `file://${tsxLoader.replace(/\\/g, '/')}`, 'src/server/index.ts'],
    {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_PORT: String(PORT),
        HARBOR_WB_HOST: HOST,
        HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'),
        HARBOR_WB_TOKEN: TEST_TOKEN,
        HARBOR_WB_WINDOW_AGENT_TOKEN: WA_TOKEN,
        HARBOR_WB_WINDOW_AGENT_STRICT: '1',
        HARBOR_WB_DESKTOP: 'agent', // the whole point of this file
        HARBOR_WB_AGENT_TIMEOUT_MS: String(AGENT_TIMEOUT_MS),
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_NATS_URL: '', // telemetry off — tests never touch the network
        /* The fabric subscriber must never dial from a test: 8204 is the real
        server service's port and a test engine has no business on it. '' is the
        documented off switch, same posture as HARBOR_WB_NATS_URL above. */
        HARBOR_WB_FABRIC_URL: '',
        HARBOR_WB_BROKER_AUTOSTART: '0', // never touch the real scheduled task
        HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT), // scratch, and nothing is listening: no PTY is spawned here
        HARBOR_WB_BROKERS: '{}',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  engine.stdout.on('data', (d) => (engineLog += d));
  engine.stderr.on('data', (d) => (engineLog += d));

  let agent = null;
  let silent = null;
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try {
        up = (await (await fetch(BASE + '/health')).json()).status === 'ok';
      } catch {
        /* not yet */
      }
      if (!up) {
        await sleep(250);
      }
    }
    if (!up) {
      throw new Error(`engine did not come up.\n--- engine log ---\n${engineLog}`);
    }

    const recipe = (
      await api('/api/recipes', { name: 'Window Agent Probe', target: 'local', runClaude: false })
    ).recipe;
    ok(!!recipe?.id, 'probe recipe created');
    const primaryPane = `recipe:${recipe.id}`;

    console.log('\n[no agent registered: a launch is a BROWSER launch, never an error]');
    const before = await api(`/api/recipes/${recipe.id}/launch`, {});
    ok(before.ok === true, 'launch accepted with no desktop connected');
    eq(before.placement, 'browser', 'and answers browser — exactly the phone case');
    ok(before.path?.startsWith('/solo.html'), `the relative path is still handed back (got ${before.path})`);
    ok(typeof before.url === 'string' && before.url.includes('solo.html'), 'as is an absolute url');

    console.log('\n[register: one agent per host, listed in /api/diag/desktop]');
    agent = windowAgent();
    await agent.open();
    agent.send({
      type: 'register',
      host: 'vrpc',
      agent: 'ui-toolkit',
      capabilities: ['tab', 'window', 'app-mode', 'focus'],
      version: '0.1.0',
      base: AGENT_BASE,
    });
    await agent.await((m) => m.type === 'registered');
    ok(true, 'engine acknowledged the registration');
    const diag = await (await fetch(`${BASE}/api/diag/desktop`)).json();
    eq(diag.mode, 'agent', 'diag reports the mode');
    eq(diag.agents.length, 1, 'one agent listed');
    eq(diag.agents[0].host, 'vrpc', 'by host');
    eq(diag.agents[0].agent, 'ui-toolkit', 'with its brand');
    ok(diag.agents[0].capabilities.includes('app-mode'), 'and its capabilities');

    console.log('\n[window.open: the engine asks, the agent does it, the caller is told]');
    const openSeen = agent.await((m) => m.type === 'window.open');
    const launched = await api(`/api/recipes/${recipe.id}/launch`, {});
    const openMsg = await openSeen;
    eq(openMsg.paneid, primaryPane, 'window.open names the pane');
    eq(openMsg.placement, 'window', 'and the placement the engine decided');
    eq(openMsg.title, 'Window Agent Probe', 'and the project name as the title');
    ok(typeof openMsg.req === 'string' && openMsg.req.length > 0, 'and carries a req id to answer on');
    /* THE URL IS BUILT FROM THE AGENT'S BASE, not the engine's loopback. Once
       the engine is on the server, its own 127.0.0.1 is not where the window opens
       — that is the entire reason `base` is in the registration. */
    ok(openMsg.url.startsWith(`${AGENT_BASE}/solo.html?recipe=${recipe.id}`),
      `url built from the agent's registered base (got ${openMsg.url})`);
    ok(openMsg.url.includes('ticket='),
      'and carries a one-time ticket — a fresh WebView has no cookie');
    ok(launched.ok === true, 'launch accepted');
    eq(launched.placement, 'window', 'and reports what the agent actually did');
    eq(launched.url.split('?ticket=')[0].split('&ticket=')[0], `${AGENT_BASE}/solo.html?recipe=${recipe.id}`,
      'the reply url is the agent-facing form too');

    console.log('\n[the agent may report a DIFFERENT placement, and it wins]');
    agent.setAnswer({ ok: true, placement: 'tab' });
    const asTab = await api(`/api/recipes/${recipe.id}/launch`, {});
    eq(asTab.placement, 'tab', 'the desktop decided a tab; the engine reports a tab');
    agent.setAnswer({ ok: true });

    console.log('\n[inventory + focus: dedupe runs on the PANEID, not on url text]');
    /* A loopback desktop can only identify a window by parsing its url. An
       agent publishes paneids directly, so ONE WINDOW PER PTY is enforced on
       identity with nothing to parse — which is also why a second session of
       the same project (whose url CONTAINS the first's) cannot be confused. */
    agent.send({
      type: 'window.inventory',
      windows: [{ id: 'w1', tabs: [{ paneid: primaryPane, title: 'Window Agent Probe', state: 'live' }] }],
    });
    await sleep(150);
    const focusSeen = agent.await((m) => m.type === 'window.focus');
    const focused = await api(`/api/recipes/${recipe.id}/launch`, { target: 'tab' });
    const focusMsg = await focusSeen;
    eq(focusMsg.paneid, primaryPane, 'window.focus names the pane and nothing else');
    eq(focused.placement, 'focused', 'already on screen → focused, no second view');
    const diag2 = await (await fetch(`${BASE}/api/diag/desktop`)).json();
    eq(diag2.agents[0].windows.length, 1, 'diag shows the reported inventory');
    ok(!!diag2.agents[0].lastInventoryAt, 'and when it last landed');

    console.log('\n[a pane the desktop does NOT hold is placeable, not focused]');
    const fresh = await api(`/api/recipes/${recipe.id}/launch`, { target: 'tab', fresh: true });
    eq(fresh.placement, 'tab', 'a second session of the same project gets its own view');
    ok(fresh.paneid !== primaryPane, `and its own pane (got ${fresh.paneid})`);

    console.log('\n[presence is recorded, not acted on (Crawl scope)]');
    agent.send({ type: 'presence', focused: primaryPane, input_ts: 1234567890 });
    await sleep(150);
    const diag3 = await (await fetch(`${BASE}/api/diag/desktop`)).json();
    eq(diag3.agents[0].presence?.focused, primaryPane, 'presence stored per agent');
    ok(!!diag3.agents[0].lastPresenceAt, 'with a timestamp');

    console.log('\n[a silent desktop times out — it must never hang a launch]');
    agent.close();
    await sleep(200);
    silent = windowAgent({ autoAnswer: false });
    await silent.open();
    silent.send({ type: 'register', host: 'vrpc', agent: 'silent', capabilities: [], version: '0' });
    await silent.await((m) => m.type === 'registered');
    const t0 = Date.now();
    const timedOut = await api(`/api/recipes/${recipe.id}/launch`, {});
    const elapsed = Date.now() - t0;
    ok(timedOut.ok === true, 'the launch still succeeds — the session exists either way');
    eq(timedOut.placement, 'browser', 'and degrades to browser rather than failing');
    ok(elapsed >= AGENT_TIMEOUT_MS && elapsed < AGENT_TIMEOUT_MS + 3000,
      `it waited the agent timeout and no longer (${elapsed}ms)`);
    const diag4 = await (await fetch(`${BASE}/api/diag/desktop`)).json();
    ok(diag4.lastActions.some((a) => a.error === 'agent-timeout'),
      'and the action ring says WHY, so nobody has to guess');

    console.log('\n[a re-register replaces the socket — no dead twin to wait on]');
    const replacement = windowAgent();
    await replacement.open();
    replacement.send({ type: 'register', host: 'vrpc', agent: 'ui-toolkit', capabilities: [], version: '1' });
    await replacement.await((m) => m.type === 'registered');
    await sleep(200);
    const diag5 = await (await fetch(`${BASE}/api/diag/desktop`)).json();
    eq(diag5.agents.length, 1, 'still exactly one agent for the host');
    eq(diag5.agents[0].version, '1', 'and it is the new one');
    const replaced = await api(`/api/recipes/${recipe.id}/launch`, {});
    eq(replaced.placement, 'window', 'which answers immediately');
    replacement.close();

    console.log('\n[the channel is authenticated, like /pty]');
    const anon = new WebSocket(`ws://${HOST}:${PORT}/window-agent`);
    const refused = await new Promise((r) => {
      anon.on('error', () => r(true));
      anon.on('open', () => {
        anon.close();
        r(false);
      });
    });
    ok(refused, 'an unauthenticated window agent is refused at the upgrade');
    const shared = new WebSocket(`ws://${HOST}:${PORT}/window-agent`, { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
    const sharedRefused = await new Promise((r) => {
      shared.on('error', () => r(true));
      shared.on('open', () => {
        shared.close();
        r(false);
      });
    });
    ok(sharedRefused, 'M9: the SHARED engine bearer is refused on /window-agent (only the window agent\'s own credential opens it)');

    console.log('\n[/pty still upgrades — the router did not eat the other channel]');
    const pty = new WebSocket(`ws://${HOST}:${PORT}/pty`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    const ptyUp = await new Promise((r) => {
      pty.on('error', () => r(false));
      pty.on('open', () => {
        pty.close();
        r(true);
      });
    });
    ok(ptyUp, 'the pty channel is unaffected by the second WS path');
  } catch (e) {
    failed++;
    failures.push(String(e?.stack || e));
    console.log(`\n✗ ${e?.message || e}`);
  } finally {
    try {
      agent?.close();
      silent?.close();
    } catch {
      /* already gone */
    }
    engine.kill();
    await sleep(400);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* Windows may still hold the db handle briefly — a temp dir, not ours to fight */
    }
  }

  console.log('\n========================================');
  console.log(`PASS ${passed}  FAIL ${failed}`);
  if (failed > 0) {
    console.log('\nfailures:');
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
    console.log(`\n--- engine log ---\n${engineLog}`);
    process.exit(1);
  }
  console.log('all green');
}

run();
