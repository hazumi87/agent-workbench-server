/* PTY-broker tests (Phase 1) — boots a scratch broker on a test port
 * and proves the continuity contract WITHOUT any engine involvement:
 * sessions survive losing their client (the whole point), replay rebuilds the
 * screen, bad spawns don't kill the broker, tombstones report exits. */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const PORT = 7439; // scratch — never the real 7430
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/broker`;
const TOKEN = 'test-token-0123456789abcdef'; // scratch; the broker refuses to start without one

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}
function eq(a, b, label) {
  ok(a === b, `${label}${a === b ? '' : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The suite was authored on the VRPC and hardcoded powershell.exe, so it hung
 * on Linux: node-pty returns a pid for a binary that isn't there, the "spawned
 * with a real pid" assertion passes, and the run then times out waiting for
 * output that can never arrive. Pick the host's shell instead. Windows keeps
 * its exact previous invocation. */
const IS_WIN = process.platform === 'win32';
const SHELL = IS_WIN ? 'powershell.exe' : 'bash';
const SHELL_ARGS = IS_WIN ? ['-NoLogo'] : ['--norc', '--noprofile'];
const TOMBSTONE_MS = 1500; // test-only; production is 10 minutes

/* A real broker's PTY_BROKER_* settings can be inherited from the shell that
 * runs the suite (the server's are: its live broker's host, port and token). The
 * scratch brokers must never see them, so rebuild the env with only our own. */
function scratchEnv(port) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('PTY_BROKER_') || k.startsWith('HARBOR_WB_')) {
      delete env[k];
    }
  }
  return { ...env, PTY_BROKER_HOST: '127.0.0.1', PTY_BROKER_PORT: String(port) };
}

function client(url = WS_URL, opts = { headers: { authorization: `Bearer ${TOKEN}` } }) {
  const ws = new WebSocket(url, opts);
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
        waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
      }),
    close: () => ws.close(),
    raw: ws,
    log,
  };
}

/* Startup posture: a broker without a token must not come up. Boots scratch
 * brokers on their own ports and watches whether they stay alive. */
async function startupChecks() {
  const tsxLoader = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');
  const boot = (extraEnv, port) =>
    new Promise((resolve) => {
      const env = { ...scratchEnv(port), ...extraEnv };
      const p = spawn(process.execPath, ['--import', `file://${tsxLoader.replace(/\\/g, '/')}`, 'src/main.ts'], {
        cwd: REPO_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      const t = setTimeout(() => (p.kill(), resolve({ exited: false, out })), 4000);
      p.on('exit', (code) => (clearTimeout(t), resolve({ exited: true, code, out })));
    });
  console.log('\n[startup: token required]');
  const none = await boot({}, PORT + 1);
  ok(none.exited && none.code === 1, 'no token: broker exits 1');
  ok(none.out.includes('PTY_BROKER_TOKEN is not set'), 'no token: says why');
  const short = await boot({ PTY_BROKER_TOKEN: 'short' }, PORT + 1);
  ok(short.exited && short.code === 1, 'short token: broker exits 1');
  const optout = await boot({ PTY_BROKER_ALLOW_NO_AUTH: '1' }, PORT + 1);
  ok(!optout.exited && optout.out.includes('WITHOUT authentication'), 'explicit opt-out on loopback: starts, warns loudly');
  const optoutPublic = await boot({ PTY_BROKER_ALLOW_NO_AUTH: '1', PTY_BROKER_HOST: '0.0.0.0' }, PORT + 1);
  ok(optoutPublic.exited && optoutPublic.code === 1, 'opt-out off loopback: broker exits 1');
}

async function main() {
  const tsxLoader = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');
  const broker = spawn(
    process.execPath,
    ['--import', `file://${tsxLoader.replace(/\\/g, '/')}`, 'src/main.ts'],
    {
      cwd: REPO_ROOT,
      env: { ...scratchEnv(PORT), PTY_BROKER_TOMBSTONE_MS: String(TOMBSTONE_MS), PTY_BROKER_TOKEN: TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let brokerLog = '';
  broker.stdout.on('data', (d) => (brokerLog += d));
  broker.stderr.on('data', (d) => (brokerLog += d));

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      up = r.ok;
    } catch {
      await sleep(250);
    }
  }
  if (!up) {
    console.log(`broker did not come up.\n${brokerLog}`);
    process.exit(1);
  }

  try {
    console.log('\n[health + empty list]');
    const h = await (await fetch(`${BASE}/health`)).json();
    eq(h.role, 'pty-broker', 'health identifies the broker');
    eq(h.sessions, 0, 'no sessions at boot');


    console.log('\n[auth: the gate in front of every shell]');
    // Each case opens a raw socket and reports the HTTP status of the upgrade (or 'open').
    const probe = (url, opts) =>
      new Promise((resolve) => {
        const ws = new WebSocket(url, opts);
        ws.on('unexpected-response', (_req, res) => (res.resume(), resolve(res.statusCode)));
        ws.on('open', () => (ws.close(), resolve('open')));
        ws.on('error', () => {});
      });
    eq(await probe(WS_URL, {}), 401, 'no Authorization header is refused (401)');
    eq(await probe(WS_URL, { headers: { authorization: 'Bearer wrong-token-0123456789' } }), 401, 'wrong token is refused (401)');
    eq(await probe(WS_URL, { headers: { authorization: TOKEN } }), 401, 'token without the Bearer scheme is refused (401)');
    eq(await probe(`${WS_URL}?token=${TOKEN}`, {}), 401, '?token= in the URL is no longer accepted (401)');
    eq(
      await probe(WS_URL, { headers: { authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' } }),
      403,
      'a browser Origin is refused even with the right token (403)',
    );
    eq(await probe(WS_URL, { headers: { authorization: `Bearer ${TOKEN}` } }), 'open', 'right token, no Origin: accepted');
    const hh = await (await fetch(`${BASE}/health`)).json();
    eq(hh.role, 'pty-broker', '/health stays open without a token');

    console.log('\n[auth: oversize message closes that socket, not the broker]');
    const big = client();
    await big.open();
    const closed = new Promise((r) => big.raw.once('close', (code) => r(code)));
    big.raw.send('x'.repeat(2 * 1024 * 1024));
    eq(await closed, 1009, 'a 2 MiB message closes the socket with 1009 (message too big)');
    const hBig = await (await fetch(`${BASE}/health`)).json();
    eq(hBig.status, 'ok', 'broker still up after the oversize message');

    console.log('\n[spawn a real shell, stream, input]');
    const c1 = client();
    await c1.open();
    c1.send({ type: 'spawn', sid: 's1', binary: SHELL, args: SHELL_ARGS, cols: 100, rows: 30 });
    const sp = await c1.await((m) => m.type === 'spawned' && m.sid === 's1');
    ok(sp.pid > 0, 'spawned with a real pid');
    c1.send({ type: 'input', sid: 's1', data: "echo BROKER_TEST_$(2+2)\r" });
    await c1.await((m) => m.type === 'data' && m.sid === 's1' && m.data.includes('BROKER_TEST_'));
    ok(true, 'pty output streams to the client');

    console.log('\n[the point: session survives client death, replay rebuilds]');
    c1.close(); // the "engine" dies
    await sleep(400);
    const h2 = await (await fetch(`${BASE}/health`)).json();
    eq(h2.live, 1, 'session still alive with no client attached');
    const c2 = client(); // a "restarted engine" comes back
    await c2.open();
    c2.send({ type: 'attach', sid: 's1' });
    const at = await c2.await((m) => m.type === 'attached' && m.sid === 's1');
    eq(at.alive, true, 'reattached to the LIVE session');
    ok(at.replay.includes('BROKER_TEST_'), 'replay contains pre-death output');
    c2.send({ type: 'input', sid: 's1', data: "echo AFTER_REATTACH_OK\r" });
    await c2.await((m) => m.type === 'data' && m.sid === 's1' && m.data.includes('AFTER_REATTACH_OK'));
    ok(true, 'session fully interactive after reattach');

    console.log('\n[resize + duplicate-sid guard]');
    c2.send({ type: 'resize', sid: 's1', cols: 120, rows: 40 });
    c2.send({ type: 'spawn', sid: 's1', binary: SHELL, cols: 80, rows: 24 });
    const dup = await c2.await((m) => m.type === 'error' && m.sid === 's1');
    ok(dup.message.includes('already live'), 'spawning a live sid errors instead of clobbering');

    console.log('\n[bad spawn never kills the broker]');
    c2.send({ type: 'spawn', sid: 'bad1', binary: 'definitely-not-a-real-binary', cols: 80, rows: 24 });
    /* runtime difference, NOT a broker bug (src/ is frozen — do not "fix" it there).
     * Windows: node-pty throws synchronously, so main.ts's catch emits
     *   { type:'error', message:'spawn failed: …' }.
     * Linux:   node-pty forks successfully and the exec fails in the child, so the
     *   failure arrives as the onExit tombstone { type:'exit', code!==0 }.
     * The contract under test is the SAFETY property — the broker reports the bad
     * spawn and stays alive — so accept whichever signal the host produces. */
    const bad = await c2.await(
      (m) => (m.type === 'error' || m.type === 'exit') && m.sid === 'bad1',
    );
    ok(
      bad.type === 'error'
        ? bad.message.includes('spawn failed')
        : typeof bad.code === 'number' && bad.code !== 0,
      `bad binary reported (${bad.type} event on ${process.platform})`,
    );
    const h3 = await (await fetch(`${BASE}/health`)).json();
    eq(h3.status, 'ok', 'broker alive after bad spawn');

    console.log('\n[kill → exit event + tombstone on reattach]');
    c2.send({ type: 'kill', sid: 's1' });
    const ex = await c2.await((m) => m.type === 'exit' && m.sid === 's1');
    ok(typeof ex.code === 'number', 'exit event carries a code');
    const c3 = client();
    await c3.open();
    c3.send({ type: 'attach', sid: 's1' });
    const tomb = await c3.await((m) => m.type === 'attached' && m.sid === 's1');
    eq(tomb.alive, false, 'tombstone reattach reports dead');
    ok(typeof tomb.exitCode === 'number', 'tombstone carries the exit code');
    c3.send({ type: 'list' });
    const li = await c3.await((m) => m.type === 'list');
    eq(li.sessions.filter((s) => s.alive).length, 0, 'list shows zero live after kill');
    c2.close();
    c3.close();

    // Regression: tombstone timers are keyed by sid, and sids are stable across
    // relaunches (engine uses paneid = `recipe:<id>`). Without disarming the
    // previous incarnation's timer, a respawned sid gets a landmine: the dead
    // run's timer fires later and deletes the LIVE entry from `held`, leaving
    // an orphan pty that is alive but unroutable (no input, no output, no
    // reattach). Do not remove or "simplify" this test — it exercises the exact
    // failure mode where a stale timer deletes a live replacement session.
    console.log('\n[stale tombstone never deletes a respawned sid]');
    const c5 = client();
    await c5.open();
    c5.send({ type: 'spawn', sid: 'reborn', binary: SHELL, args: SHELL_ARGS, cols: 80, rows: 24 });
    await c5.await((m) => m.type === 'spawned' && m.sid === 'reborn');
    c5.send({ type: 'kill', sid: 'reborn' });
    await c5.await((m) => m.type === 'exit' && m.sid === 'reborn');
    c5.send({ type: 'spawn', sid: 'reborn', binary: SHELL, args: SHELL_ARGS, cols: 80, rows: 24 });
    await c5.await((m) => m.type === 'spawned' && m.sid === 'reborn');
    await sleep(TOMBSTONE_MS * 2); // sail past the original deadline
    c5.send({ type: 'list' });
    const after = await c5.await((m) => m.type === 'list');
    const reborn = after.sessions.find((s) => s.sid === 'reborn');
    ok(reborn !== undefined, 'respawned sid survives the dead run\'s tombstone deadline');
    ok(reborn?.alive === true, 'respawned session is still alive after the deadline');
    c5.send({ type: 'input', sid: 'reborn', data: 'echo REBORN_ROUTABLE\r' });
    const echo = await c5.await(
      (m) => m.type === 'data' && m.sid === 'reborn' && m.data.includes('REBORN_ROUTABLE'),
    );
    ok(!!echo, 'respawned session still routes input (not an orphan)');
    c5.send({ type: 'kill', sid: 'reborn' });
    await c5.await((m) => m.type === 'exit' && m.sid === 'reborn');
    c5.close();

    console.log('\n[unknown sid → error, not crash]');
    const c4 = client();
    await c4.open();
    c4.send({ type: 'attach', sid: 'never-existed' });
    const unk = await c4.await((m) => m.type === 'error');
    ok(unk.message.includes('unknown sid'), 'unknown sid errors cleanly');
    c4.close();
  } catch (err) {
    failed++;
    failures.push(`EXCEPTION: ${err.message}`);
    console.log(`\n✗ EXCEPTION: ${err.message}`);
  } finally {
    broker.kill();
  }

  await startupChecks();

  console.log('\n========================================');
  console.log(`PASS ${passed}  FAIL ${failed}`);
  if (failed) {
    console.log(failures.map((f) => `  - ${f}`).join('\n'));
    process.exit(1);
  }
  console.log('all green');
}

main();
