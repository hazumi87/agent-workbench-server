/**
 * PTY SCREEN MODEL, P0 shadow — the ENGINE wiring (src/server/index.ts), through
 * a real engine and a real pty-broker (the design notes §9 "Engine
 * tests"). The model itself is unit-tested in vscreen.test.ts; this proves the
 * seams it is fed through:
 *   - a record is created on SPAWN at the spawned size (80x24), host kind from
 *     the broker link, and served on GET /api/diag/vscreen;
 *   - a controller's resize is mirrored;
 *   - the size is PERSISTED: after a SIGKILL restart (the standard one) the new
 *     engine ADOPTS the broker-held pane at the last size, not a default;
 *   - the diag carries no screen text (the shell's prompt holds the host name
 *     and the temp path; neither may appear);
 *   - with the flag unset (default off) the engine reports mode off.
 * A bash recipe (vendor cli-manager -> the generic signature, no terminal) is
 * used on purpose: a claude-code recipe would launch the REAL claude on this
 * host. The terminal path is covered by vscreen.test.ts on captured bytes.
 *
 * SAFETY: scratch engine + scratch broker on P() ports, temp table,
 * childEnv(); never :7420/:7430/:8200/:8201/:8204. The temp dir is removed.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { P, assertFree, childEnv, scratchShell } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(84);
const BROKER_PORT = P(85);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'vscreen-engine-test-token';
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
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)})`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, { json } = {}) {
  const headers = { authorization: `Bearer ${TOKEN}` };
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

async function run() {
  for (const p of [PORT, BROKER_PORT]) {
    await assertFree(p, 'vscreen-engine.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-vscreen-engine-'));
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  let log = '';
  let broker = null;
  let engine = null;
  const up = async (url) => {
    for (let i = 0; i < 120; i++) {
      if (await fetch(url).then((r) => r.ok).catch(() => false)) {
        return true;
      }
      await sleep(250);
    }
    return false;
  };
  const bootEngine = async (vscreenMode) => {
    const extra = {
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
      HARBOR_WB_VSCREEN: vscreenMode,
    };
    const e = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], { cwd: REPO_ROOT, env: childEnv(extra) });
    e.stdout.on('data', (d) => (log += d));
    e.stderr.on('data', (d) => (log += d));
    if (!(await up(`${BASE}/health`))) {
      throw new Error(`engine did not come up\n${log}`);
    }
    return e;
  };
  const kill = async (proc, signal = 'SIGTERM') => {
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      const gone = new Promise((r) => proc.once('exit', r));
      proc.kill(signal);
      await Promise.race([gone, sleep(3000)]);
    }
  };
  const paneOf = async (pane) => (await call(`/api/diag/vscreen?paneid=${encodeURIComponent(pane)}`)).body?.panes?.[pane];
  let pane = null;
  try {
    broker = spawn(process.execPath, ['--import', loaderArg, 'node_modules/pty-broker/src/main.ts'], {
      cwd: REPO_ROOT,
      env: childEnv({ PTY_BROKER_PORT: String(BROKER_PORT) }),
    });
    broker.stdout.on('data', (d) => (log += d));
    broker.stderr.on('data', (d) => (log += d));
    if (!(await up(`http://${HOST}:${BROKER_PORT}/health`))) {
      throw new Error(`broker did not come up\n${log}`);
    }
    console.log(`scratch engine :${PORT}, scratch broker :${BROKER_PORT}`);

    console.log('\n[spawn: a record at the spawned size, served by the diag]');
    engine = await bootEngine('shadow');
    const recipe = (await call('/api/recipes', { json: { name: 'Screen Shell', target: 'local', projectDir: tmpDir, vendor: 'cli-manager' } })).body?.recipe;
    ok(!!recipe?.id, 'a bash recipe');
    pane = `recipe:${recipe.id}`;
    const c1 = client();
    ok(await c1.open(), 'a window opens /pty');
    c1.send({ type: 'attach', paneid: pane, recipe: recipe.id });
    ok(!!(await c1.wait((m) => m.type === 'pane.ready' && m.paneid === pane, 12000)), 'it spawns a real pty (pane.ready)');
    const d0 = (await call('/api/diag/vscreen')).body;
    eq(d0?.mode, 'shadow', 'GET /api/diag/vscreen answers, mode shadow');
    let p = await paneOf(pane);
    eq(`${p?.cols}x${p?.rows}`, '80x24', 'the spawn created a record at 80x24');
    eq(p?.hostKind, process.platform === 'win32' ? 'conpty' : 'pty', 'host kind from the broker link (local link: pty on linux, conpty on win32)');
    eq(p?.link, 'local', 'the link it runs on');
    eq(p?.reading?.evidence, 'generic', 'a cli-manager pane reads generic (unknown)');

    console.log('\n[resize: mirrored, then persisted]');
    c1.send({ type: 'input', paneid: pane, data: 'echo screen-model-marker\r' });
    c1.send({ type: 'resize', paneid: pane, cols: 123, rows: 41 });
    await sleep(300);
    p = await paneOf(pane);
    eq(`${p?.cols}x${p?.rows}`, '123x41', "the controller's resize is mirrored");
    await sleep(1200); // past the trailing edge

    console.log('\n[restart (SIGKILL, as production does): the new engine adopts at the persisted size]');
    c1.close();
    await kill(engine, 'SIGKILL');
    engine = await bootEngine('shadow');
    for (let i = 0; i < 40 && !(await paneOf(pane)); i++) {
      await sleep(250);
    }
    p = await paneOf(pane);
    ok(!!p, 'the adopted pane has a record');
    eq(`${p?.cols}x${p?.rows} sizeKnown=${p?.sizeKnown}`, '123x41 sizeKnown=true', 'at the size persisted before the restart');
    const blob = JSON.stringify((await call('/api/diag/vscreen')).body);
    ok(!blob.includes('screen-model-marker'), 'no typed text in the diag');
    ok(!blob.includes(tmpDir) && !blob.includes(hostname()), 'no screen text (prompt path / host name) in the diag');
    ok(!/vscreen: .*(screen-model-marker|wb-vscreen-engine)/.test(log), 'no screen text in the engine log lines');

    console.log('\n[flag unset: default off]');
    await kill(engine, 'SIGKILL');
    engine = await bootEngine(undefined);
    const d2 = (await call('/api/diag/vscreen')).body;
    eq(d2?.mode, 'off', 'no HARBOR_WB_VSCREEN and no config: off');
    eq(d2?.budget?.terminals, 0, 'no terminals in off');
  } catch (e) {
    failed++;
    failures.push(`threw: ${e?.stack ?? e}`);
    console.log(`  ✗ threw: ${e?.stack ?? e}`);
    console.log(`--- engine/broker log tail ---\n${log.slice(-2500)}`);
  } finally {
    if (engine && pane) {
      const c = client();
      if (await c.open()) {
        c.send({ type: 'attach', paneid: pane, intent: 'reclaim' });
        await c.wait((m) => m.type === 'pane.control' && m.controlling === true, 4000);
        c.send({ type: 'kill', paneid: pane });
        await c.wait((m) => m.type === 'pane.exit' && m.paneid === pane, 4000);
        c.close();
      }
    }
    await kill(engine);
    await kill(broker);
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
