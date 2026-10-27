/**
 * LOCAL MODE: A SEAT SURVIVES THE ENGINE'S RESTART (lead order 15713 step 5): the broker holds the pane, so an engine that exits - by the
 * memory cap (75) or by a hard kill - comes back, adopts the session, and the room keeps working.
 *
 *   1. local engine #1 + a LIVE scratch broker + a stub `claude` pane bound as @agent in a room; a line to @agent is typed into the pane;
 *   2. engine #1 trips the MEMORY CAP (exit 75); engine #2 starts on the same data folder (the lock is released) and the seat is still live:
 *      the session row is `live`, and a new line to @agent is typed into the SAME pane;
 *   3. engine #2 is killed HARD (SIGKILL: a stale lock is left behind); engine #3 takes the lock over and the seat is still live again.
 *
 * SAFETY: Linux only (a POSIX stub claude); LIVE scratch broker P(553); engines on port 0; temp folders; fabric and NATS off; never
 * :7420/:7430/:8200/:8201/:8204. Everything is removed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

if (process.platform !== 'linux') {
  console.log('local-mode-restart.test: Linux only (POSIX stub claude) - skipped');
  process.exit(0);
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BROKER_PORT = P(553);
const HOST = '127.0.0.1';
const TOKEN = 'local-restart-test-token';
const BROKER_TOKEN = 'broker-secret-for-the-test';
const LF = String.fromCharCode(10);
const TARGETS = JSON.stringify({ targets: [{ id: 'local', label: 'Local', kind: 'local', shell: '/bin/bash' }] });

let passed = 0;
let failed = 0;
function ok(c, m, got) {
  if (c) {
    passed++;
    console.log(`  + ${m}`);
  } else {
    failed++;
    console.log(`  X ${m}${got === undefined ? '' : ` (got ${JSON.stringify(got)})`}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 150) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(step);
  }
}

async function run() {
  await assertFree(BROKER_PORT, 'local-mode-restart.test.mjs');
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-local-restart-'));
  const binDir = join(tmpDir, 'bin');
  const typed = join(tmpDir, 'typed');
  const dataDir = join(tmpDir, 'data');
  const filesDir = join(tmpDir, 'files');
  mkdirSync(binDir);
  mkdirSync(typed);
  const stubPath = join(binDir, 'claude');
  writeFileSync(
    stubPath,
    [
      '#!/bin/sh',
      'echo LOCAL-RESTART-STUB-CLAUDE',
      `env | grep -c -F -e '${BROKER_TOKEN}' -e '${TOKEN}' > "${tmpDir}/pane-env-values"`,
      `printf 'PTY_BROKER_TOKEN=%s|HARBOR_WB_TOKEN=%s|HARBOR_WB_BROKER_TOKEN=%s' "${'${PTY_BROKER_TOKEN:-unset}'}" "${'${HARBOR_WB_TOKEN:-unset}'}" "${'${HARBOR_WB_BROKER_TOKEN:-unset}'}" > "${tmpDir}/pane-env"`,
      `pid=$(printf '%s' "${'${HARBOR_WB_PANEID:-unknown}'}" | tr -c "A-Za-z0-9" "_")`,
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
  const brokerEnv = childEnv({ PATH: `${binDir}${delimiter}${process.env.PATH || ''}`, PTY_BROKER_PORT: String(BROKER_PORT), PTY_BROKER_TOKEN: BROKER_TOKEN });
  const probe = spawnSync('/bin/bash', ['-ic', 'command -v claude'], { env: brokerEnv, encoding: 'utf8', cwd: tmpDir });
  if (String(probe.stdout || '').trim().split(LF).pop() !== stubPath) {
    console.log('X PREFLIGHT: the pane shell does not resolve claude to the stub. Refusing to run.');
    process.exit(2);
  }
  const typedLines = (paneid) => {
    const f = join(typed, paneid.replace(/[^A-Za-z0-9]/g, '_'));
    return existsSync(f) ? readFileSync(f, 'utf8').split(LF).filter(Boolean) : [];
  };
  const wasTyped = (paneid, needle, ms = 12000) => until(() => typedLines(paneid).some((l) => l.includes(needle)), ms);

  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  let broker = null;
  const engines = [];

  function startEngine(extra = {}) {
    const proc = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_MODE: 'local',
        HARBOR_WB_TOKEN: TOKEN,
        HARBOR_WB_DATA_DIR: dataDir,
        HARBOR_WB_FILES_DIR: filesDir,
        HARBOR_WB_MEMORY_CEILING_MB: '0',
        HARBOR_WB_SEAT_WELCOME: '0',
        HARBOR_WB_NO_WINDOW: '1',
        HARBOR_WB_DESKTOP: 'none',
        HARBOR_WB_BROKER_PORT: String(BROKER_PORT),
        HARBOR_WB_BROKER_TOKEN: BROKER_TOKEN, // in memory, per launch: never a file
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_NODE: 'testnode',
        HARBOR_WB_TARGETS: TARGETS,
        HARBOR_WB_ROOM_TYPE_SETTLE_MS: '150',
        HARBOR_WB_PROC_ROOT: join(tmpDir, 'noproc'),
        ...extra,
      }),
    });
    const rec = { proc, out: '', err: '', exit: null, port: 0 };
    proc.stdout.on('data', (d) => (rec.out += d));
    proc.stderr.on('data', (d) => (rec.err += d));
    proc.on('exit', (code, sig) => (rec.exit = code ?? `signal ${sig}`));
    engines.push(rec);
    return rec;
  }
  async function ready(rec) {
    for (let t = 0; t < 60000 && !rec.port && rec.exit === null; t += 200) {
      await sleep(200);
      try {
        rec.port = JSON.parse(rec.out.split(LF)[0]).port;
      } catch {
        /* not yet */
      }
    }
    return rec.port;
  }
  const api = (rec) => async (path, { json, as = 'bearer', method, cookie } = {}) => {
    const headers = as === 'person' ? { cookie } : { authorization: `Bearer ${TOKEN}` };
    const init = { method: method ?? (json === undefined ? 'GET' : 'POST'), headers };
    if (json !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(json);
    }
    const res = await fetch(`http://${HOST}:${rec.port}${path}`, init);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const exited = async (rec, ms = 30000) => {
    for (let t = 0; t < ms && rec.exit === null; t += 100) await sleep(100);
    return rec.exit;
  };

  try {
    broker = spawn(process.execPath, ['--import', loaderArg, 'node_modules/pty-broker/src/main.ts'], { cwd: REPO_ROOT, env: brokerEnv });
    let blog = '';
    broker.stdout.on('data', (d) => (blog += d));
    broker.stderr.on('data', (d) => (blog += d));
    ok(await until(() => fetch(`http://${HOST}:${BROKER_PORT}/health`).then((r) => r.status < 500).catch(() => false), 30000), 'a LIVE scratch broker is up');

    const noTokenWs = await new Promise((resolve) => {
      const w = new WebSocket(`ws://${HOST}:${BROKER_PORT}/broker`);
      w.on('unexpected-response', (_req, res) => (res.resume(), resolve(res.statusCode))); // refused at the HTTP upgrade (401): no socket is ever opened
      w.on('open', () => resolve('open'));
      w.on('error', () => {});
      setTimeout(() => resolve('timeout'), 4000);
    });
    ok(noTokenWs === 401, `the broker refuses a client without its token (${noTokenWs})`);

    /* ---- engine #1: a seat on a live stub claude pane ---- */
    const e1 = startEngine({ HARBOR_WB_MEMORY_CEILING_MB: '0' });
    ok((await ready(e1)) > 0, 'local engine #1 is up (ready line)');
    let call = api(e1);
    const cookie1 = await windowCookie(`http://${HOST}:${e1.port}`, TOKEN);
    const rid = 'rec-local-1';
    const rec = await call('/api/recipes', { json: { id: rid, name: 'Local one', target: 'local', projectDir: tmpDir, vendor: 'claude-code', agent: 'local-one', runClaude: 1 } });
    ok(rec.status === 200 && rec.body?.recipe?.id === rid, 'a claude-code recipe', rec.body);
    const paneid = `recipe:${rid}`;
    const ws = new WebSocket(`ws://${HOST}:${e1.port}/pty`, { headers: { authorization: `Bearer ${TOKEN}` } });
    ws.on('error', () => {});
    const seen = [];
    ws.on('message', (raw) => { try { seen.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'attach', paneid, recipe: rid }));
    ok(await until(() => seen.some((m) => m.type === 'pane.ready' && m.paneid === paneid), 20000), 'the pane spawns a real pty in the broker');
    const room = (await call('/api/rooms', { json: { name: 'Survive' }, as: 'person', cookie: cookie1 })).body;
    const seat = await call(`/api/rooms/${room.id}/seats`, { json: { recipe_id: rid, handle: 'agent', policy: 'persistent', occupant: paneid }, as: 'person', cookie: cookie1 });
    ok(seat.status === 200, '@agent is seated on the pane', seat.status);
    await sleep(1500);
    const say = async (rec2, cookie, text) => api(rec2)(`/api/rooms/${room.id}/line`, { json: { text }, as: 'person', cookie });
    await say(e1, cookie1, '@agent line before any restart');
    ok(await wasTyped(paneid, 'line before any restart'), 'a line to @agent is typed into the pane');
    ws.close();
    ok(existsSync(join(tmpDir, 'pane-env')) && readFileSync(join(tmpDir, 'pane-env'), 'utf8') === 'PTY_BROKER_TOKEN=unset|HARBOR_WB_TOKEN=unset|HARBOR_WB_BROKER_TOKEN=unset', `the agent shell sees none of the three tokens (${existsSync(join(tmpDir, 'pane-env')) ? readFileSync(join(tmpDir, 'pane-env'), 'utf8') : 'no file'})`);

    ok(readFileSync(join(tmpDir, 'pane-env-values'), 'utf8').trim() === '0', 'and no variable in the agent shell carries either token VALUE, under any name');

    /* ---- the memory cap restarts the engine (exit 75); the seat survives ---- */
    // engine #1 cannot be told to trip the cap after the fact, so stop it and start #2 with a 1 MB ceiling: it trips on its first check
    e1.proc.kill('SIGTERM');
    ok((await exited(e1)) === 0, 'engine #1 stops cleanly (SIGTERM)');
    ok(!existsSync(join(dataDir, 'engine.lock')), '...and releases its lock');
    const e2 = startEngine({ HARBOR_WB_MEMORY_CEILING_MB: '1', HARBOR_WB_MEMORY_CHECK_MS: '500' });
    ok((await exited(e2, 60000)) === 75, 'engine #2 trips the memory cap and exits 75');
    const e3 = startEngine({ HARBOR_WB_MEMORY_CEILING_MB: '0' });
    ok((await ready(e3)) > 0, 'engine #3 starts on the same data folder after the cap exit');
    call = api(e3);
    const cookie3 = await windowCookie(`http://${HOST}:${e3.port}`, TOKEN);
    const tab = (await call('/api/table')).body;
    const rows = Array.isArray(tab) ? tab : (tab?.rows ?? tab?.sessions ?? []);
    const row = rows.find((r) => r.paneid === paneid);
    ok(row?.state === 'live', `the session is still live after the cap restart (${row?.state})`);
    await say(e3, cookie3, '@agent line after the memory-cap restart');
    ok(await wasTyped(paneid, 'line after the memory-cap restart'), 'a new line to @agent is typed into the SAME pane (the broker kept it)');

    /* ---- a hard kill leaves a stale lock; the next engine takes it over ---- */
    e3.proc.kill('SIGKILL');
    await exited(e3);
    ok(existsSync(join(dataDir, 'engine.lock')), 'a hard kill leaves the lock behind');
    const e4 = startEngine({});
    ok((await ready(e4)) > 0, 'engine #4 takes the stale lock over and starts');
    call = api(e4);
    const cookie4 = await windowCookie(`http://${HOST}:${e4.port}`, TOKEN);
    const row4 = (() => null)();
    const tab4 = (await call('/api/table')).body;
    const rows4 = Array.isArray(tab4) ? tab4 : (tab4?.rows ?? tab4?.sessions ?? []);
    ok(rows4.find((r) => r.paneid === paneid)?.state === 'live' && row4 === null, 'the session is still live after the hard kill');
    await say(e4, cookie4, '@agent line after the hard kill');
    ok(await wasTyped(paneid, 'line after the hard kill'), 'and a new line is typed into the same pane again');
    e4.proc.kill('SIGTERM');
    await exited(e4);
  } catch (e) {
    failed++;
    console.log(`  X harness: ${e?.stack ?? e}`);
  } finally {
    for (const e of engines) {
      if (e.exit === null) e.proc.kill('SIGKILL');
    }
    if (broker && broker.exitCode === null) {
      broker.kill('SIGTERM');
      await sleep(500);
      if (broker.exitCode === null) broker.kill('SIGKILL');
    }
    await sleep(300);
    rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log(`\nPASS ${passed} FAIL ${failed}`);
  process.exit(failed ? 1 : 0);
}
run();
