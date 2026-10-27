/**
 * LOCAL MODE: TERMINAL GRANTS FOR THE ONE LOCAL PERSON (lead ruling 15973). Local mode has no accounts, so the valid window cookie
 * (`wb_auth`, from POST /login with the launch token), with no Authorization header and Origin app://workbench, is the one person. The
 * page then holds only a 30-second single-use grant, never the cookie. Everything else stays shut:
 *   - mint: needs the cookie AND an allowed Origin; a bearer, a bearer + cookie, a missing or foreign Origin, a wrong pane are refused;
 *   - /term: the cookie and the allowed Origin; a foreign Origin, a bearer, or no cookie never upgrade; plain http is fine (loopback);
 *   - a grant redeems ONCE (a second socket with the same grant is closed 4401); it opens the pane (pane.* events arrive).
 *
 * SAFETY: Linux only (POSIX stub claude); LIVE scratch broker P(555); the engine on port 0; temp folders; never :7420/:7430/:8200/:8201/:8204.
 */
import { spawn, spawnSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

if (process.platform !== 'linux') {
  console.log('local-mode-term.test: Linux only (POSIX stub claude) - skipped');
  process.exit(0);
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BROKER_PORT = P(555);
const HOST = '127.0.0.1';
const TOKEN = 'local-term-test-token';
const APP_ORIGIN = 'app://workbench';
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
  await assertFree(BROKER_PORT, 'local-mode-term.test.mjs');
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-local-term-'));
  const binDir = join(tmpDir, 'bin');
  mkdirSync(binDir);
  const stubPath = join(binDir, 'claude');
  writeFileSync(stubPath, ['#!/bin/sh', 'echo LOCAL-TERM-STUB-CLAUDE', 'echo "Claude Code v9.9.9"', 'echo "? for shortcuts"', 'while IFS= read -r line; do', '  echo "? for shortcuts"', 'done', ''].join(LF));
  chmodSync(stubPath, 0o755);
  const brokerEnv = childEnv({ PATH: `${binDir}${delimiter}${process.env.PATH || ''}`, PTY_BROKER_PORT: String(BROKER_PORT) });
  const probe = spawnSync('/bin/bash', ['-ic', 'command -v claude'], { env: brokerEnv, encoding: 'utf8', cwd: tmpDir });
  if (String(probe.stdout || '').trim().split(LF).pop() !== stubPath) {
    console.log('X PREFLIGHT: the pane shell does not resolve claude to the stub. Refusing to run.');
    process.exit(2);
  }
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  let broker = null;
  let engine = null;
  let port = 0;
  let out = '';

  try {
    broker = spawn(process.execPath, ['--import', loaderArg, 'node_modules/pty-broker/src/main.ts'], { cwd: REPO_ROOT, env: brokerEnv });
    broker.stdout.on('data', () => {});
    broker.stderr.on('data', () => {});
    ok(await until(() => fetch(`http://${HOST}:${BROKER_PORT}/health`).then((r) => r.status < 500).catch(() => false), 30000), 'a LIVE scratch broker is up');

    /* NOTE: HARBOR_WB_TERM_GRANTS is deliberately NOT set: local mode turns grants on by itself */
    engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_MODE: 'local',
        HARBOR_WB_TOKEN: TOKEN,
        HARBOR_WB_DATA_DIR: join(tmpDir, 'data'),
        HARBOR_WB_FILES_DIR: join(tmpDir, 'files'),
        HARBOR_WB_MEMORY_CEILING_MB: '0',
        HARBOR_WB_SEAT_WELCOME: '0',
        HARBOR_WB_NO_WINDOW: '1',
        HARBOR_WB_DESKTOP: 'none',
        HARBOR_WB_BROKER_PORT: String(BROKER_PORT),
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_NODE: 'testnode',
        HARBOR_WB_TARGETS: TARGETS,
        HARBOR_WB_PROC_ROOT: join(tmpDir, 'noproc'),
      }),
    });
    engine.stdout.on('data', (d) => (out += d));
    engine.stderr.on('data', () => {});
    for (let t = 0; t < 60000 && !port; t += 200) {
      await sleep(200);
      try {
        port = JSON.parse(out.split(LF)[0]).port;
      } catch {
        /* not yet */
      }
    }
    ok(port > 0, 'the local engine is up');
    const base = `http://${HOST}:${port}`;
    const cookie = await windowCookie(base, TOKEN);
    const http = async (path, { json, headers = {}, method } = {}) => {
      const init = { method: method ?? (json === undefined ? 'GET' : 'POST'), headers: { ...headers } };
      if (json !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(json);
      }
      const res = await fetch(base + path, init);
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const asWindow = { cookie, origin: APP_ORIGIN };

    /* a live stub pane bound as @agent */
    const rid = 'rec-term-1';
    await http('/api/recipes', { json: { id: rid, name: 'Term one', target: 'local', projectDir: tmpDir, vendor: 'claude-code', agent: 'term-one', runClaude: 1 }, headers: { authorization: `Bearer ${TOKEN}` } });
    const paneid = `recipe:${rid}`;
    const ws0 = new WebSocket(`ws://${HOST}:${port}/pty`, { headers: { authorization: `Bearer ${TOKEN}` } });
    ws0.on('error', () => {});
    const seen0 = [];
    ws0.on('message', (raw) => { try { seen0.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
    await new Promise((r) => ws0.once('open', r));
    ws0.send(JSON.stringify({ type: 'attach', paneid, recipe: rid }));
    ok(await until(() => seen0.some((m) => m.type === 'pane.ready' && m.paneid === paneid), 20000), 'a pane spawns in the broker');
    const room = (await http('/api/rooms', { json: { name: 'Terminals' }, headers: { cookie } })).body;
    const seat = await http(`/api/rooms/${room.id}/seats`, { json: { recipe_id: rid, handle: 'agent', policy: 'persistent', occupant: paneid }, headers: { cookie } });
    ok(seat.status === 200, '@agent is seated on the pane', seat.status);
    const mintBody = { paneid, room: room.id, seat: 'agent', intent: 'view' };

    /* ---- mint ---- */
    const good = await http('/api/terminal-grants', { json: mintBody, headers: asWindow });
    ok(good.status === 200 && typeof good.body?.grant === 'string' && good.body?.socket === '/term' && good.body?.expires_in === 30, 'the local person (cookie + app origin) mints a grant: 30 s, socket /term, and no URL', good);
    const noOrigin = await http('/api/terminal-grants', { json: mintBody, headers: { cookie } });
    ok(noOrigin.status === 403 && noOrigin.body?.field === 'origin', 'no Origin: refused (field origin)', noOrigin);
    const evil = await http('/api/terminal-grants', { json: mintBody, headers: { cookie, origin: 'http://evil.example' } });
    ok(evil.status === 403, 'a foreign Origin: refused', evil.status);
    const bearerOnly = await http('/api/terminal-grants', { json: mintBody, headers: { authorization: `Bearer ${TOKEN}`, origin: APP_ORIGIN } });
    ok(bearerOnly.status === 403 && bearerOnly.body?.field === 'credential', 'the bearer alone is not a person', bearerOnly);
    const both = await http('/api/terminal-grants', { json: mintBody, headers: { ...asWindow, authorization: `Bearer ${TOKEN}` } });
    ok(both.status === 403 && both.body?.field === 'credential', 'a cookie PLUS a bearer is not a person either (an agent\'s request is never a human\'s)', both);
    const noCred = await http('/api/terminal-grants', { json: mintBody, headers: { origin: APP_ORIGIN } });
    ok(noCred.status === 401 || noCred.status === 403, 'no credential at all: refused', noCred.status);
    const badPane = await http('/api/terminal-grants', { json: { ...mintBody, paneid: 'recipe:nobody' }, headers: asWindow });
    ok(badPane.status >= 400 && badPane.status < 500, `a pane that is not the seat's: refused (${badPane.status} ${badPane.body?.reason ?? badPane.body?.error ?? ''})`);
    const badIntent = await http('/api/terminal-grants', { json: { ...mintBody, intent: 'root' }, headers: asWindow });
    ok(badIntent.status === 400, 'a bad intent: 400', badIntent.status);

    /* ---- /term ---- */
    const open = (headers) =>
      new Promise((resolve) => {
        const w = new WebSocket(`ws://${HOST}:${port}/term`, { headers });
        const frames = [];
        w.on('message', (raw) => { try { frames.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
        w.on('open', () => resolve({ w, frames, status: 101 }));
        w.on('unexpected-response', (_q, res) => resolve({ w, frames, status: res.statusCode }));
        w.on('error', () => resolve({ w, frames, status: 0 }));
        setTimeout(() => resolve({ w, frames, status: 'timeout' }), 6000);
      });
    const closeCode = (c) => new Promise((resolve) => { c.w.on('close', (code) => resolve(code)); setTimeout(() => resolve('none'), 6000); });

    const evilWs = await open({ cookie, origin: 'http://evil.example' });
    ok(evilWs.status === 403, '/term from a foreign Origin never upgrades (403)', evilWs.status);
    const noCookieWs = await open({ origin: APP_ORIGIN, authorization: `Bearer ${TOKEN}` });
    ok(noCookieWs.status === 401 || noCookieWs.status === 403, '/term with only a bearer never upgrades', noCookieWs.status);
    const noOriginWs = await open({ cookie });
    ok(noOriginWs.status === 403, '/term with the cookie but no Origin never upgrades (403)', noOriginWs.status);

    const c1 = await open(asWindow);
    ok(c1.status === 101, '/term with the cookie and app://workbench upgrades over plain loopback http', c1.status);
    c1.w.send(JSON.stringify({ type: 'grant', grant: good.body.grant }));
    ok(await until(() => c1.frames.some((m) => typeof m.type === 'string' && m.type.startsWith('pane.') && m.paneid === paneid), 15000), 'the grant opens the pane: pane.* events for that pane arrive');
    ok(!c1.frames.some((m) => m.paneid && m.paneid !== paneid), 'and nothing from any other pane');

    const c2 = await open(asWindow);
    c2.w.send(JSON.stringify({ type: 'grant', grant: good.body.grant }));
    ok((await closeCode(c2)) === 4401, 'the SAME grant on a second socket is closed 4401 (single use)');

    const fresh = await http('/api/terminal-grants', { json: mintBody, headers: asWindow });
    const c3 = await open({ cookie, origin: 'http://evil.example' });
    ok(c3.status === 403, 'a fresh grant cannot be redeemed from a foreign origin (the upgrade is refused)', c3.status);
    const c4 = await open(asWindow);
    c4.w.send(JSON.stringify({ type: 'grant', grant: fresh.body?.grant }));
    ok(await until(() => c4.frames.some((m) => m.paneid === paneid), 15000), 'and that grant is still good for the real window (the refused upgrade did not use it up)');
    const c5 = await open(asWindow);
    c5.w.send(JSON.stringify({ type: 'not-a-grant' }));
    ok((await closeCode(c5)) === 4401, 'a first frame that is not a grant closes 4401');
    const c6 = await open(asWindow);
    c6.w.send(JSON.stringify({ type: 'grant', grant: 'x'.repeat(40) }));
    ok((await closeCode(c6)) === 4401, 'an unknown grant closes 4401');

    for (const c of [c1, c4]) c.w.close();
    ws0.close();
  } catch (e) {
    failed++;
    console.log(`  X harness: ${e?.stack ?? e}`);
  } finally {
    if (engine && engine.exitCode === null) engine.kill('SIGKILL');
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
