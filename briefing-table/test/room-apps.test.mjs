/**
 * Room APPS through a real scratch engine (the design notes §4.4,
 * S4 engine half) [rooms/apps-engine]: the tool registry (candidates,
 * register, approve, hold-on-hash-mismatch), the catalog's live status, and
 * room membership (add, idempotent re-add, exclusive conflict + move + the
 * bind handshake, remove, panel dedupe/adoption, the panel-DELETE-drops-the-
 * last-panel's-membership-row rule).
 *
 * The rooms-routes pattern: our own engine on P() ports, a temp mapping db,
 * NO broker and NO pty (the broker port is a dead P() port, assertFree'd).
 *
 * [rooms/apps-sec] The fake apps are CHILD PROCESSES run with cwd = their
 * tool root, each writing its OWN pid + port into status/app.json: the engine
 * now verifies the endpoint (same uid, the listener held by app.json#pid,
 * that pid's cwd inside the tool root) before it sends its bearer or builds a
 * panel, so an in-process stub would (correctly) be refused. widget-a
 * (shared, no bind), widget-b (exclusive, an HTTP bind we steer through
 * /__ctl), widget-c (exclusive, no bind declared, started late on an
 * ephemeral port). Also covered: verifyEndpoint + the path helpers as UNIT
 * tests (tsImport; a real listener in this process; a fake /proc for the uid
 * branch; path.win32 for the separator rules), readPinned (the TOCTOU on add
 * + the reconcile hash check), fill-only reconcile, scoped backfill,
 * expected_sha256, symlinked roots and the bounded bind body.
 *
 * SAFETY: scratch engine P(170), dead broker P(171), stub app 1 P(172), stub
 * app 2 P(173); widget-c and the unit-test listeners use ephemeral ports (0);
 * never :7420/:7430/:8200/:8201/:8204. childEnv() scrubs PTY_BROKER_ and
 * HARBOR_WB_ keys; fabric + NATS off. Temp dirs removed, children killed.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, renameSync, unlinkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(170); // scratch engine — port table in test/_scratch.mjs
const DEAD_BROKER_PORT = P(171); // nothing may listen
const STUB1_PORT = P(172); // widget-a (shared, health only)
const STUB2_PORT = P(173); // widget-b (exclusive, health + /bind)
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'room-apps-test-token';

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  + ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  X ${msg}`);
  }
}
const eq = (a, b, msg) => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  ok(x === y, x === y ? msg : `${msg} (got ${x}, want ${y})`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
/** as: 'person' (window cookie) | 'agent' (bearer, the default). */
async function call(path, { method, json, as = 'agent' } = {}) {
  const headers = as === 'person' ? { cookie } : { authorization: `Bearer ${TOKEN}` };
  const init = { method: method ?? (json === undefined ? 'GET' : 'POST'), headers };
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  const res = await fetch(BASE + path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function createRoom(name) {
  const r = await call('/api/rooms', { as: 'person', json: { name } });
  if (r.status !== 200) {
    throw new Error(`createRoom(${name}) failed: ${JSON.stringify(r)}`);
  }
  return r.body;
}

function writeTool(toolsDir, slug, parsed) {
  const root = join(toolsDir, slug);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'tool.json'), JSON.stringify(parsed, null, 2));
  return root;
}

const baseTool = (slug, extra = {}) => ({
  contract: 'tool/draft-0',
  name: extra.name ?? slug,
  slug,
  version: '0.1.0',
  description: extra.description ?? `${slug} description`,
  access: extra.access ?? 'shared',
  endpoint: { bind: '127.0.0.1', discover: 'status/app.json#port' },
  panels: extra.panels ?? [{ title: extra.name ?? slug, icon: 'list', view: 'GET /rooms/:roomId/view' }],
  ...(extra.lifecycle ? { lifecycle: extra.lifecycle } : {}),
});

const shaOf = (buf) => createHash('sha256').update(buf).digest('hex');
const toolSha = (root) => shaOf(readFileSync(join(root, 'tool.json')));

/* A fake tool app: its OWN process, cwd = the tool root, writes status/app.json
   with its real pid + port once listening. /__ctl steers it, /__calls reports
   every bind call it received (with the Authorization header). */
const STUB_SRC = `
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
const state = { jobRunning: false, noSeat: false, bigBody: false, bindDelayMs: 0, boundRoom: null, calls: [] };
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readJson = (req) => new Promise((r) => { let raw = ''; req.on('data', (d) => (raw += d)); req.on('end', () => { try { r(JSON.parse(raw || '{}')); } catch { r({}); } }); });
const srv = createServer(async (req, res) => {
  const u = req.url ?? '';
  if (u.startsWith('/health')) return json(res, 200, { ok: true });
  if (u === '/__calls') return json(res, 200, state.calls);
  if (u === '/__ctl' && req.method === 'POST') { Object.assign(state, await readJson(req)); return json(res, 200, { ok: true }); }
  if (u === '/bind' && req.method === 'POST') {
    const body = await readJson(req);
    state.calls.push({ authorization: req.headers.authorization ?? null, body });
    if (state.bindDelayMs) await new Promise((r) => setTimeout(r, state.bindDelayMs));
    if (state.bigBody) {
      res.writeHead(200, { 'content-type': 'application/json' });
      const chunk = 'x'.repeat(65536);
      const t = setInterval(() => res.write(chunk), 5);
      res.on('close', () => clearInterval(t));
      return;
    }
    if (state.noSeat) return json(res, 409, { reason: 'no-seat' });
    if (state.jobRunning && !body.force) return json(res, 409, { reason: 'job-running', jobs: [{ room_id: state.boundRoom, job_id: 'job-1' }] });
    const released = state.boundRoom !== null && state.boundRoom !== body.room_id;
    state.boundRoom = body.room_id;
    return json(res, 200, { ok: true, bound: true, released });
  }
  res.writeHead(404); res.end();
});
srv.listen(Number(process.argv[2] || 0), '127.0.0.1', () => {
  const port = srv.address().port;
  mkdirSync('status', { recursive: true });
  writeFileSync('status/app.json', JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));
  console.log('READY ' + port);
});
`;

const children = [];
/** Start a fake app in `root` on `port` (0 = ephemeral). Resolves {proc, pid, port}. */
function startApp(stubPath, root, port) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [stubPath, String(port)], { cwd: root, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(proc);
    let out = '';
    let done = false;
    const t = setTimeout(() => !done && reject(new Error(`stub in ${root} did not start: ${out}`)), 10_000);
    proc.stdout.on('data', (d) => {
      out += d;
      const m = /READY ([0-9]+)/.exec(out);
      if (m && !done) {
        done = true;
        clearTimeout(t);
        resolve({ proc, pid: proc.pid, port: Number(m[1]) });
      }
    });
    proc.stderr.on('data', (d) => (out += d));
    proc.on('exit', () => !done && reject(new Error(`stub in ${root} exited: ${out}`)));
  });
}
function stopApp(app) {
  return new Promise((resolve) => {
    if (!app || app.proc.exitCode !== null || app.proc.signalCode !== null) {
      resolve();
      return;
    }
    app.proc.once('exit', () => resolve());
    app.proc.kill('SIGKILL');
  });
}
const ctl = (port, body) =>
  fetch(`http://127.0.0.1:${port}/__ctl`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const bindCalls = (port) => fetch(`http://127.0.0.1:${port}/__calls`).then((r) => r.json());
const writeAppJson = (root, obj) => writeFileSync(join(root, 'status', 'app.json'), JSON.stringify(obj));
const listen = (host) =>
  new Promise((resolve, reject) => {
    const srv = createServer((req, res) => res.end('ok'));
    srv.once('error', reject);
    srv.listen(0, host, () => resolve(srv));
  });
const closeSrv = (srv) => new Promise((r) => srv.close(() => r()));

/* ---------------------------------------------------------------- unit ---- */

/** verifyEndpoint + isInside/isDirectChild, in THIS process (app-endpoint.ts
 *  imports only node builtins, so importing it mints nothing). */
async function unitTests(tmpDir) {
  const ep = await tsImport('../src/engine/app-endpoint.ts', import.meta.url);
  const w = path.win32;
  const BS = String.fromCharCode(92); // a backslash, never typed (CLAUDE.md byte trap)
  const win = (...parts) => parts.join(BS);

  console.log('\n[unit: path helpers — resolved + path.relative, never raw strings; fail closed]');
  eq(ep.isDirectChild(win('C:', 'tools'), win('C:', 'tools', 'widget-a'), w), true, 'win32: C:\\tools\\widget-a is a direct child');
  eq(ep.isDirectChild(win('C:', 'tools'), 'C:/tools/widget-a', w), true, 'win32: forward slashes name the same folder');
  eq(ep.isDirectChild(win('C:', 'tools', ''), win('c:', 'tools', 'widget-a', ''), w), true, 'win32: trailing separators and drive-letter case do not decide it');
  eq(ep.isDirectChild(win('C:', 'tools'), win('C:', 'tools'), w), false, 'win32: the dir itself is not a child');
  eq(ep.isDirectChild(win('C:', 'tools'), win('C:', 'tools', 'a', 'b'), w), false, 'win32: a grandchild is not a direct child');
  eq(ep.isDirectChild(win('C:', 'tools'), win('C:', 'toolsx', 'a'), w), false, 'win32: a sibling with a shared prefix is refused');
  eq(ep.isDirectChild(win('C:', 'tools'), win('D:', 'tools', 'a'), w), false, 'win32: another drive is refused');
  eq(ep.isDirectChild(win('C:', 'tools'), win('C:', 'tools', '..', 'etc'), w), false, 'win32: .. is resolved away, then refused');
  eq(ep.isInside(win('C:', 'tools', 'a'), win('C:', 'tools', 'a', 'sub'), w), true, 'win32: isInside a subfolder');
  eq(ep.isInside(win('C:', 'tools', 'a'), win('C:', 'tools', 'ab'), w), false, 'win32: isInside refuses a prefix sibling');
  eq(ep.isInside(win('C:', 'tools', 'a'), win('D:', 'tools', 'a'), w), false, 'win32: isInside refuses another drive');
  eq(ep.isInside('/t/a', '/t/a/'), true, 'posix: a trailing slash is the same folder');
  eq(ep.isInside('/t/a', '/t/ab'), false, 'posix: a prefix sibling is refused');
  eq(ep.isDirectChild('/t', '/t/a/'), true, 'posix: a direct child with a trailing slash');

  console.log('\n[unit: verifyEndpoint — a real listener in this process]');
  const root = process.cwd();
  eq(ep.verifyEndpoint(root, { port: 5000, pid: process.pid }, { platform: 'win32' }), { ok: false, reason: 'platform' }, 'not linux: refused (platform) — the bearer goes nowhere');
  if (process.platform !== 'linux') {
    return;
  }
  const srv = await listen('127.0.0.1');
  const port = srv.address().port;
  eq(ep.verifyEndpoint(root, { port, pid: process.pid }), { ok: true, port }, 'same uid, held by app.json#pid, cwd inside the root: ok');
  let r = ep.verifyEndpoint(root, { port, pid: process.ppid });
  ok(!r.ok && /not held by pid|no valid pid|fds/.test(r.reason), `wrong pid: refused (${r.reason})`);
  r = ep.verifyEndpoint(root, { port, pid: process.pid }, { enginePort: port });
  ok(!r.ok && /reserved/.test(r.reason), `the engine's own port: refused (${r.reason})`);
  for (const bad of [8201, 8204, 7430, 80, 70000, 1.5, '8000', null]) {
    r = ep.verifyEndpoint(root, { port: bad, pid: process.pid });
    ok(!r.ok, `port ${JSON.stringify(bad)}: refused (${r.reason})`);
  }
  r = ep.verifyEndpoint(root, { port, pid: 'x' });
  ok(!r.ok && /pid/.test(r.reason), `no numeric pid: refused (${r.reason})`);
  r = ep.verifyEndpoint(tmpDir, { port, pid: process.pid });
  ok(!r.ok && /tool root/.test(r.reason), `the pid's cwd outside the tool root: refused (${r.reason})`);
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
  const foreignUid = {
    ...ep.realProc,
    readFile: (p) => {
      const text = ep.realProc.readFile(p);
      if (!p.startsWith('/proc/net/tcp')) {
        return text;
      }
      return text
        .split('\n')
        .map((line) => {
          const f = line.trim().split(/ +/);
          if (f.length >= 10 && f[1].endsWith(`:${hexPort}`)) {
            f[7] = String(process.getuid() + 1);
            return f.join(' ');
          }
          return line;
        })
        .join('\n');
    },
  };
  r = ep.verifyEndpoint(root, { port, pid: process.pid }, { proc: foreignUid });
  ok(!r.ok && /uid/.test(r.reason), `a listener owned by another uid (fake /proc): refused (${r.reason})`);
  await closeSrv(srv);
  eq(ep.verifyEndpoint(root, { port, pid: process.pid }), { ok: false, reason: 'no-listener' }, 'nothing listening: refused (no-listener)');
  const any4 = await listen('0.0.0.0');
  eq(ep.verifyEndpoint(root, { port: any4.address().port, pid: process.pid }).ok, true, 'a 0.0.0.0 listener of ours: ok');
  await closeSrv(any4);
  let any6 = null;
  try {
    any6 = await listen('::');
  } catch {
    /* no IPv6 on this host */
  }
  if (any6) {
    eq(ep.verifyEndpoint(root, { port: any6.address().port, pid: process.pid }).ok, true, 'a :: (dual-stack) listener of ours: ok');
    await closeSrv(any6);
  }
}

/* ------------------------------------------------------------ integration ---- */

async function run() {
  for (const p of [PORT, DEAD_BROKER_PORT, STUB1_PORT, STUB2_PORT]) {
    await assertFree(p, 'room-apps.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-apps-'));
  const dbPath = join(tmpDir, 'mapping.db');
  const toolsDir = join(tmpDir, 'tools');
  mkdirSync(toolsDir, { recursive: true });
  const stubPath = join(tmpDir, 'stub-app.mjs');
  writeFileSync(stubPath, STUB_SRC);

  let engine = null;
  let engineLog = '';
  let appA = null;
  let appB = null;
  let appC = null;
  const rootA = join(toolsDir, 'widget-a');
  const rootB = join(toolsDir, 'widget-b');
  const rootC = join(toolsDir, 'widget-c');

  try {
    await unitTests(tmpDir);
    if (process.platform !== 'linux') {
      throw new Error('the integration half needs /proc (linux) — the engine refuses every endpoint elsewhere');
    }

    writeTool(toolsDir, 'widget-a', baseTool('widget-a', { name: 'Widget A', access: 'shared' }));
    writeTool(toolsDir, 'widget-b', baseTool('widget-b', { name: 'Widget B', access: 'exclusive', lifecycle: { bind: { http: 'POST /bind' } } }));
    writeTool(toolsDir, 'widget-c', baseTool('widget-c', { name: 'Widget C', access: 'exclusive' }));
    // broken-tool: slug mismatch — a candidate, never registerable.
    writeTool(toolsDir, 'broken-tool', baseTool('not-broken-tool', { name: 'Broken' }));
    // linked-tool: a SYMLINK in the tools dir to a valid tool folder elsewhere.
    writeTool(join(tmpDir, 'outside'), 'linked-tool', baseTool('linked-tool'));
    symlinkSync(join(tmpDir, 'outside', 'linked-tool'), join(toolsDir, 'linked-tool'));
    appA = await startApp(stubPath, rootA, STUB1_PORT);
    appB = await startApp(stubPath, rootB, STUB2_PORT);

    const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
    engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_PORT: String(PORT),
        HARBOR_WB_HOST: HOST,
        HARBOR_WB_TABLE: dbPath,
        HARBOR_WB_TOKEN: TOKEN,
        HARBOR_WB_IDENTITY: 'legacy',
        HARBOR_WB_NO_WINDOW: '1',
        HARBOR_WB_NATS_URL: '',
        HARBOR_WB_FABRIC_URL: '',
        HARBOR_WB_BROKER_AUTOSTART: '0',
        HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT),
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_NODE: 'testnode',
        HARBOR_WB_TOOLS_DIR: toolsDir,
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
    const login = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(TOKEN)}`,
      redirect: 'manual',
    });
    cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    ok(/wb_auth=/.test(cookie), 'a person cookie');

    console.log('\n[candidates: a pick list, not a scan]');
    let r = await call('/api/apps/candidates');
    eq(r.status, 403, 'candidates is human-only: a bearer 403s');
    r = await call('/api/apps/candidates', { as: 'person' });
    eq(r.status, 200, 'a person: 200');
    let names = (r.body?.candidates ?? []).map((c) => c.slug).sort();
    eq(names, ['broken-tool', 'widget-a', 'widget-b', 'widget-c'], 'every un-registered REAL folder with a tool.json is a candidate (the symlink is not)');
    const broken = r.body.candidates.find((c) => c.slug === 'broken-tool');
    eq(broken.ok, false, 'broken-tool: ok=false');
    ok((broken.problems ?? []).some((p) => /slug/.test(p)), 'its problems name the slug mismatch');
    const widgetA = r.body.candidates.find((c) => c.slug === 'widget-a');
    eq(widgetA.ok, true, 'widget-a: a valid candidate');
    eq(widgetA.sha256, toolSha(rootA), 'a candidate carries the sha256 of its tool.json bytes [P2]');
    ok(await call('/api/apps').then((x) => x.status === 200), 'GET /api/apps (the catalog) is NOT human-only');
    eq((await call('/api/apps')).body.apps, [], 'nothing registered yet: an empty catalog');

    console.log('\n[backfill at registration: scoped to the panel\'s own room, never later panels (P1-d)]');
    const bf1 = await createRoom('Backfill 1');
    const bf2 = await createRoom('Backfill 2');
    const ownUrl = `http://127.0.0.1:${STUB1_PORT}/rooms/${bf1.id}/view`;
    r = await call(`/api/rooms/${bf1.id}/panels`, { as: 'person', json: { title: 'Pre-apps A', url: ownUrl } });
    eq(r.status, 200, "a pre-apps panel in Backfill 1 showing Backfill 1's own view");
    const bf1Panel = r.body.panel.id;
    r = await call(`/api/rooms/${bf2.id}/panels`, { as: 'person', json: { title: 'Cross-room', url: ownUrl } });
    eq(r.status, 200, "a panel in Backfill 2 showing Backfill 1's view (cross-room)");
    const bf2Panel = r.body.panel.id;

    console.log('\n[registration is human-only, and a scan registers nothing]');
    r = await call('/api/apps', { json: { root: rootA } });
    eq(r.status, 403, 'a bearer: 403 — registering is human-only');
    r = await call('/api/apps', { as: 'person', json: { root: join(toolsDir, 'broken-tool') } });
    eq(r.status, 400, 'an invalid tool.json is refused at registration (400)');
    r = await call('/api/apps', { as: 'person', json: { root: '/etc' } });
    eq(r.status, 400, 'a root outside HARBOR_WB_TOOLS_DIR is refused');
    r = await call('/api/apps', { as: 'person', json: { root: join(toolsDir, 'widget-a', '..', '..', 'outside', 'linked-tool') } });
    eq(r.status, 400, 'a root that .. -walks out of HARBOR_WB_TOOLS_DIR is refused');
    r = await call('/api/apps', { as: 'person', json: { root: join(toolsDir, 'linked-tool') } });
    eq([r.status, r.body?.field], [400, 'root'], 'a SYMLINKED root is refused (lstat) [P2]');
    r = await call('/api/apps', { as: 'person', json: { root: rootA, expected_sha256: 'nothex' } });
    eq([r.status, r.body?.field], [400, 'expected_sha256'], 'a malformed expected_sha256: 400');
    r = await call('/api/apps', { as: 'person', json: { root: rootA, expected_sha256: '0'.repeat(64) } });
    eq(r.status, 409, 'expected_sha256 that is not the file on disk: 409 [P2]');
    eq(r.body, { error: 'changed', sha256: toolSha(rootA) }, '{error:changed, sha256: the real hash}');
    eq((await call('/api/apps')).body.apps, [], 'and nothing was registered');
    r = await call('/api/apps', { as: 'person', json: { root: rootA + '/', expected_sha256: toolSha(rootA) } });
    eq(r.status, 200, 'registering widget-a with the hash it was shown (trailing slash on the root): 200');
    eq(r.body.app?.slug, 'widget-a', 'the response carries the catalog entry (looked up by the stored slug, not a re-split path)');
    eq(r.body.app?.sha256, toolSha(rootA), 'the catalog entry carries sha256 [P2]');
    eq(r.body.app?.reason, null, 'a verified running app: reason null');
    r = await call('/api/apps', { as: 'person', json: { root: rootA } });
    eq(r.status, 409, 're-registering the same slug: 409');
    r = await call('/api/apps', { as: 'person', json: { root: rootB } });
    eq(r.status, 200, 'registering widget-b (no expected_sha256 — it is optional): 200');
    r = await call('/api/apps', { as: 'person', json: { root: rootC } });
    eq(r.status, 200, 'registering widget-c: 200');

    let panels = (await call(`/api/rooms/${bf1.id}/panels`)).body.panels;
    eq(panels.find((p) => p.id === bf1Panel)?.app_slug, 'widget-a', 'Backfill 1: its own-room panel was adopted at registration');
    eq(panels.find((p) => p.id === bf1Panel)?.title, 'Widget A', "adoption overwrote the panel's title from the pinned spec");
    eq((await call(`/api/rooms/${bf1.id}/apps`)).body.apps.map((a) => a.slug), ['widget-a'], 'Backfill 1: a member now');
    // 2026-09-30: a resident re-registering its view after adoption must not add a second panel
    r = await call(`/api/rooms/${bf1.id}/panels`, { as: 'person', json: { title: 'Pre-apps A again', url: ownUrl } });
    eq([r.status, r.body?.field, (r.body?.message ?? r.body?.error ?? '').includes(bf1Panel)], [409, 'url', true], 'the same view url again: 409 naming the adopted app panel');
    eq((await call(`/api/rooms/${bf1.id}/panels`)).body.panels.filter((p) => p.url === ownUrl).length, 1, 'still one panel for that view');
    panels = (await call(`/api/rooms/${bf2.id}/panels`)).body.panels;
    eq(panels.find((p) => p.id === bf2Panel)?.app_slug, null, "Backfill 2: the cross-room panel is NOT adopted (its :roomId is another room's)");
    eq((await call(`/api/rooms/${bf2.id}/apps`)).body.apps, [], 'Backfill 2: no membership');

    const bf3 = await createRoom('Backfill 3');
    r = await call(`/api/rooms/${bf3.id}/panels`, {
      as: 'person',
      json: { title: 'After registration', url: `http://127.0.0.1:${STUB1_PORT}/rooms/${bf3.id}/view` },
    });
    eq(r.status, 200, "a matching panel registered AFTER the app (e.g. by the app's own script)");
    await call('/api/apps'); // runs reconcile — which must not backfill
    eq((await call(`/api/rooms/${bf3.id}/apps`)).body.apps, [], 'the reconcile pass does NOT turn it into membership (a panel does not make an app a member)');
    eq((await call(`/api/rooms/${bf3.id}/panels`)).body.panels[0]?.app_slug, null, 'and the panel stays unowned');

    console.log('\n[the catalog: status, access, icon]');
    r = await call('/api/apps');
    let bySlug = Object.fromEntries(r.body.apps.map((a) => [a.slug, a]));
    eq(bySlug['widget-a'].status, 'running', 'widget-a answers /health: running');
    eq(bySlug['widget-a'].access, 'shared', 'widget-a: shared');
    eq(bySlug['widget-a'].icon, 'list', "icon = panels[0]'s icon");
    eq(bySlug['widget-b'].status, 'running', 'widget-b answers /health: running');
    eq(bySlug['widget-b'].access, 'exclusive', 'widget-b: exclusive');
    eq(bySlug['widget-c'].status, 'down', 'widget-c has no status/app.json: down, never "unknown"');
    eq(bySlug['widget-c'].port, null, 'widget-c: no port');
    eq(bySlug['widget-a'].rooms, [{ id: bf1.id, name: 'Backfill 1', ids: [bf1.id] }], 'widget-a: only the room backfill adopted (ids: its family [family apps])');
    eq(bySlug['widget-b'].rooms, [], 'widget-b: not in any room yet');

    console.log('\n[held: a hash mismatch, cleared only by approve]');
    const original = readFileSync(join(rootA, 'tool.json'), 'utf8');
    writeFileSync(join(rootA, 'tool.json'), original + '\n'); // same JSON, different bytes -> different hash
    r = await call('/api/apps');
    bySlug = Object.fromEntries(r.body.apps.map((a) => [a.slug, a]));
    eq(bySlug['widget-a'].status, 'held', 'a tool.json byte change is caught on the next catalog read');
    eq(bySlug['widget-a'].sha256, toolSha(rootA), 'a held app shows the sha of the file approve would pin');
    let roomHeld = await createRoom('Held');
    r = await call(`/api/rooms/${roomHeld.id}/apps`, { as: 'person', json: { slug: 'widget-a' } });
    eq([r.status, r.body?.error], [409, 'held'], 'a held app cannot be added (409 held)');
    r = await call('/api/apps/widget-a/approve', { json: {} });
    eq(r.status, 403, 'approving is human-only');
    r = await call('/api/apps/widget-a/approve', { as: 'person', json: { expected_sha256: shaOf(Buffer.from(original)) } });
    eq(r.status, 409, 'approving with a stale expected_sha256: 409 [P2]');
    eq(r.body, { error: 'changed', sha256: toolSha(rootA) }, '{error:changed, sha256: what is on disk now}');
    r = await call('/api/apps/widget-a/approve', { as: 'person', json: { expected_sha256: toolSha(rootA) } });
    eq(r.status, 200, 'a person approves the file they were shown: 200');
    eq(r.body.app?.status, 'running', 'approved: re-pinned, held clears, status resumes');
    r = await call('/api/apps');
    bySlug = Object.fromEntries(r.body.apps.map((a) => [a.slug, a]));
    eq(bySlug['widget-a'].status, 'running', 'and it STAYS clear on the next read (not re-flagged every time)');

    console.log('\n[diff: what Approve would pin, in plain terms] (auriga: Approve is not blind)');
    eq(bySlug['widget-a'].jobs, false, 'jobs: false when tool.json does not declare "jobs": true');
    eq(bySlug['widget-a'].move_notes, [], 'move_notes: [] when tool.json declares none');
    r = await call('/api/apps/widget-a/diff');
    eq(r.status, 403, 'the diff is human-only');
    r = await call('/api/apps/widget-a/diff', { as: 'person' });
    eq([r.status, r.body?.diff?.verbs?.added, r.body?.diff?.other], [200, [], []], 'nothing changed since the approval: an empty diff');
    const changed = JSON.parse(original);
    changed.access = 'exclusive';
    changed.jobs = true;
    changed.version = '0.2.0';
    changed.verbs = [{ name: 'wipe', class: 'mutate' }];
    changed.needs = { gpu: true };
    changed.panels = [...changed.panels, { title: 'Extra', view: 'GET /rooms/:roomId/extra' }];
    changed.move_notes = ['Keeps its history.', 42, '', 'x'.repeat(141), 'Line\nbreak', 'Two.', 'Three.', 'Four.', 'Five.'];
    writeFileSync(join(rootA, 'tool.json'), JSON.stringify(changed, null, 2));
    r = await call('/api/apps');
    bySlug = Object.fromEntries(r.body.apps.map((a) => [a.slug, a]));
    eq([bySlug['widget-a'].status, bySlug['widget-a'].jobs], ['held', true], 'held again; the catalog passes "jobs": true through');
    eq(bySlug['widget-a'].move_notes, ['Keeps its history.', 'Two.', 'Three.', 'Four.'], 'move_notes: bad entries (not text, empty, over 140, a line break) ignored; at most 4 kept');
    r = await call('/api/apps/widget-a/diff', { as: 'person' });
    const d = r.body?.diff;
    eq(d?.verbs?.added, [{ name: 'wipe', class: 'mutate' }], 'diff: a verb added, with its class (mutate)');
    eq(d?.panels, { added: ['Extra'], removed: [] }, 'diff: a panel added');
    eq(d?.access, { from: 'shared', to: 'exclusive' }, 'diff: access shared -> exclusive');
    eq(d?.jobs, { from: false, to: true }, 'diff: jobs false -> true');
    eq(d?.needs, [{ key: 'gpu', from: null, to: true }], 'diff: needs.gpu added');
    eq(d?.other, ['version', 'move_notes'], 'diff: anything else by key name only');
    ok(typeof r.body?.pinned_at === 'number' && r.body.held === true, 'diff: carries pinned_at and held');
    eq(r.body?.sha256, toolSha(rootA), 'diff: carries the sha256 of the file it describes (Approve sends it back as expected_sha256)');
    writeFileSync(join(rootA, 'tool.json'), original);
    r = await call('/api/apps/widget-a/approve', { as: 'person', json: {} });
    eq(r.status, 200, 'approved back to the original');
    r = await call('/api/apps/nope/diff', { as: 'person' });
    eq(r.status, 404, 'an unregistered slug: 404');

    console.log('\n[shared app membership: add, idempotent, remove]');
    const roomA = await createRoom('Room A');
    r = await call(`/api/rooms/${roomA.id}/apps`, { json: { slug: 'widget-a' } });
    eq(r.status, 403, "a bearer can't add an app — membership is human-only, unlike a panel");
    r = await call(`/api/rooms/${roomA.id}/apps`, { as: 'person', json: { slug: 'widget-a' } });
    eq(r.status, 200, 'a person adds widget-a: 200');
    eq(r.body.moved_from, null, 'not moved from anywhere');
    eq(r.body.bind, null, "a shared app: bind doesn't apply (null)");
    eq(r.body.app.panel_ids.length, 1, 'one panel was created (the app is running)');
    const panelId = r.body.app.panel_ids[0];
    panels = (await call(`/api/rooms/${roomA.id}/panels`)).body.panels;
    eq(panels.length, 1, 'the room now shows one panel');
    eq(panels[0].app_slug, 'widget-a', "the panel carries the app's slug");
    eq(panels[0].url, `http://127.0.0.1:${STUB1_PORT}/rooms/${roomA.id}/view`, "the URL: the app's port + its view, :roomId filled in");
    r = await call(`/api/rooms/${roomA.id}/apps`, { as: 'person', json: { slug: 'widget-a' } });
    eq(r.status, 200, 're-adding the same app: 200 (idempotent)');
    eq(r.body.app.panel_ids, [panelId], 'the SAME panel, not a second one');
    eq((await call(`/api/rooms/${roomA.id}/apps`)).body.apps.map((a) => a.slug), ['widget-a'], 'GET .../apps lists it');

    r = await call(`/api/rooms/${roomA.id}/apps/widget-a`, { method: 'DELETE' });
    eq(r.status, 403, 'removing is human-only too');
    r = await call(`/api/rooms/${roomA.id}/apps/widget-a`, { method: 'DELETE', as: 'person' });
    eq(r.status, 200, 'a person removes it: 200');
    eq(r.body.removed, { slug: 'widget-a', panel_ids: [panelId] }, 'names what was removed, for Undo');
    eq((await call(`/api/rooms/${roomA.id}/apps`)).body.apps, [], 'membership gone');
    eq((await call(`/api/rooms/${roomA.id}/panels`)).body.panels, [], 'and its panel with it');
    r = await call(`/api/rooms/${roomA.id}/apps/widget-a`, { method: 'DELETE', as: 'person' });
    eq(r.status, 200, 'removing again (not a member): still 200, a no-op — a retried Undo cannot 404');
    eq(r.body.removed.panel_ids, [], 'nothing to remove');

    console.log('\n[the panel-DELETE route drops the app membership row too]');
    r = await call(`/api/rooms/${roomA.id}/apps`, { as: 'person', json: { slug: 'widget-a' } });
    const panelId2 = r.body.app.panel_ids[0];
    r = await call(`/api/rooms/${roomA.id}/panels/${panelId2}`, { method: 'DELETE', as: 'person', json: {} });
    eq(r.status, 200, 'deleting the panel directly: 200');
    eq((await call(`/api/rooms/${roomA.id}/apps`)).body.apps, [], "the app's last panel is gone -> the room_apps row goes too");

    console.log('\n[an unverified endpoint: membership yes, panel NO — at add and at reconcile (P0 / P1-c)]');
    const decoy = await listen('127.0.0.1'); // THIS process's listener, not widget-a's
    writeAppJson(rootA, { pid: appA.pid, port: decoy.address().port });
    const roomU = await createRoom('Unverified');
    r = await call(`/api/rooms/${roomU.id}/apps`, { as: 'person', json: { slug: 'widget-a' } });
    eq(r.status, 200, "app.json names a port widget-a's pid does not hold: the add still succeeds (shared, no bind)");
    eq(r.body.app.panel_ids, [], 'but no panel is built on that port');
    r = await call('/api/apps'); // reconcile
    bySlug = Object.fromEntries(r.body.apps.map((a) => [a.slug, a]));
    eq(bySlug['widget-a'].status, 'unknown', 'the catalog: unknown, never probed');
    ok(/unverified/.test(bySlug['widget-a'].reason ?? '') && /not held by pid/.test(bySlug['widget-a'].reason ?? ''), `with a reason (${bySlug['widget-a'].reason})`);
    eq((await call(`/api/rooms/${roomU.id}/panels`)).body.panels, [], 'reconcile did not fill a panel from the unverified port either');
    await closeSrv(decoy);
    writeAppJson(rootA, { pid: appA.pid, port: appA.port });
    await call('/api/apps'); // reconcile, now verified
    panels = (await call(`/api/rooms/${roomU.id}/panels`)).body.panels;
    eq(panels.map((p) => p.url), [`http://127.0.0.1:${STUB1_PORT}/rooms/${roomU.id}/view`], 'once app.json names its real listener, reconcile fills the panel');

    console.log('\n[reconcile is FILL-ONLY: it never re-creates a membership a human removed (P1-d)]');
    r = await call(`/api/rooms/${roomU.id}/apps/widget-a`, { method: 'DELETE', as: 'person' });
    eq(r.status, 200, 'the human removes widget-a from Unverified');
    await call('/api/apps');
    eq((await call(`/api/rooms/${roomU.id}/apps`)).body.apps, [], 'after a reconcile pass it is still gone');

    console.log('\n[a down app can still be added: no panel yet, no bind attempted]');
    const roomDown = await createRoom('Down');
    r = await call(`/api/rooms/${roomDown.id}/apps`, { as: 'person', json: { slug: 'widget-c' } });
    eq(r.status, 200, 'widget-c (exclusive, no bind, down): still 200');
    eq(r.body.bind, 'not-supported', 'no lifecycle.bind declared: not-supported, never a network attempt');
    eq(r.body.app.panel_ids, [], 'no panel yet — the port is unknown');
    eq((await call(`/api/rooms/${roomDown.id}/apps`)).body.apps.map((a) => a.slug), ['widget-c'], 'but it IS a member');

    console.log('\n[panel dedupe: adopt a pre-existing same-URL panel, never duplicate]');
    const roomX = await createRoom('Room X');
    const preUrl = `http://127.0.0.1:${STUB2_PORT}/rooms/${roomX.id}/view`;
    r = await call(`/api/rooms/${roomX.id}/panels`, { as: 'person', json: { title: 'Pre-registered', url: preUrl, scripts: true, uploads: true } });
    eq(r.status, 200, 'a panel is registered directly first (e.g. the app self-registering on bind)');
    const preId = r.body.panel.id;
    r = await call(`/api/rooms/${roomX.id}/apps`, { as: 'person', json: { slug: 'widget-b' } });
    eq(r.status, 200, 'now the app is added');
    eq(r.body.bind, 'called', "widget-b's bind was called");
    eq(r.body.app.panel_ids, [preId], 'the SAME panel is adopted — never a duplicate');
    panels = (await call(`/api/rooms/${roomX.id}/panels`)).body.panels;
    eq(panels.length, 1, 'still exactly one panel in the room');
    eq(panels[0].app_slug, 'widget-b', 'now carrying the app_slug');
    eq(panels[0].title, 'Widget B', 'adopting takes the panel over: title from the pinned spec');
    eq([panels[0].scripts, panels[0].uploads, panels[0].seat_id], [false, false, null], 'and scripts/uploads from the spec, seat_id cleared — a pre-registration cannot set the app panel\'s flags');
    let seen = await bindCalls(appB.port);
    ok(seen.length === 1 && seen[0].authorization === `Bearer ${TOKEN}`, "the bind call carried the engine's own bearer — to the VERIFIED listener");
    eq(seen[seen.length - 1].body.room_id, roomX.id, 'and the target room_id');

    console.log('\n[exclusive: a second room without move is refused]');
    const roomY = await createRoom('Room Y');
    r = await call(`/api/rooms/${roomY.id}/apps`, { as: 'person', json: { slug: 'widget-b' } });
    eq(r.status, 409, 'widget-b is exclusive and already in Room X: 409');
    eq(r.body.error, 'exclusive', 'error: exclusive');
    eq(r.body.heldBy, { id: roomX.id, name: 'Room X' }, 'names the room holding it');
    eq((await call(`/api/rooms/${roomY.id}/apps`)).body.apps, [], 'nothing was added to Room Y');

    console.log('\n[exclusive: move:true binds first, then moves membership + panels]');
    r = await call(`/api/rooms/${roomY.id}/apps`, { as: 'person', json: { slug: 'widget-b', move: true } });
    eq(r.status, 200, 'move:true: 200');
    eq(r.body.moved_from, { id: roomX.id, name: 'Room X' }, 'moved_from names the old room');
    eq(r.body.bind, 'called', 'bind was called before the move');
    eq((await call(`/api/rooms/${roomX.id}/apps`)).body.apps, [], "Room X's membership is gone");
    eq((await call(`/api/rooms/${roomX.id}/panels`)).body.panels, [], "and Room X's app panel with it — 'either way the engine removes the old room's app panels on move'");
    eq((await call(`/api/rooms/${roomY.id}/apps`)).body.apps.map((a) => a.slug), ['widget-b'], 'Room Y now holds it');
    panels = (await call(`/api/rooms/${roomY.id}/panels`)).body.panels;
    eq(panels.length, 1, 'a fresh panel in Room Y (no pre-existing URL there)');
    eq(panels[0].url, `http://127.0.0.1:${STUB2_PORT}/rooms/${roomY.id}/view`, 'built from the view + the NEW room id');

    console.log('\n[bind refusals: job-running (force overrides), no-seat (force does NOT)]');
    await ctl(appB.port, { jobRunning: true });
    r = await call(`/api/rooms/${roomX.id}/apps`, { as: 'person', json: { slug: 'widget-b', move: true } });
    eq(r.status, 409, 'job-running: 409');
    eq(r.body, { error: 'bind-refused', reason: 'job-running', jobs: [{ room_id: roomY.id, job_id: 'job-1' }] }, 'names the jobs array');
    eq((await call(`/api/rooms/${roomY.id}/apps`)).body.apps.map((a) => a.slug), ['widget-b'], 'nothing moved — Room Y still holds it');
    r = await call(`/api/rooms/${roomX.id}/apps`, { as: 'person', json: { slug: 'widget-b', move: true, force: true } });
    eq(r.status, 200, 'force:true overrides job-running: 200');
    eq((await call(`/api/rooms/${roomX.id}/apps`)).body.apps.map((a) => a.slug), ['widget-b'], 'moved to Room X');
    await ctl(appB.port, { jobRunning: false, noSeat: true });
    r = await call(`/api/rooms/${roomY.id}/apps`, { as: 'person', json: { slug: 'widget-b', move: true } });
    eq([r.status, r.body?.reason], [409, 'no-seat'], 'no-seat: 409');
    r = await call(`/api/rooms/${roomY.id}/apps`, { as: 'person', json: { slug: 'widget-b', move: true, force: true } });
    eq([r.status, r.body?.reason], [409, 'no-seat'], 'force does NOT override no-seat (only job-running)');
    eq((await call(`/api/rooms/${roomX.id}/apps`)).body.apps.map((a) => a.slug), ['widget-b'], 'still in Room X — nothing moved');
    await ctl(appB.port, { noSeat: false });

    console.log('\n[the bearer never goes to an unverified endpoint (P0)]');
    const callsBefore = (await bindCalls(appB.port)).length;
    writeAppJson(rootB, { pid: process.pid, port: appB.port }); // the right port, the WRONG pid
    r = await call(`/api/rooms/${roomY.id}/apps`, { as: 'person', json: { slug: 'widget-b', move: true } });
    eq([r.status, r.body?.error, r.body?.reason], [502, 'bind-failed', 'endpoint-unverified'], 'a listener not held by app.json#pid: 502 bind-failed, endpoint-unverified');
    ok(/not held by pid/.test(r.body?.detail ?? ''), `with the detail (${r.body?.detail})`);
    eq((await bindCalls(appB.port)).length, callsBefore, 'and the app received NO bind call — no bearer was sent');
    r = await call('/api/apps');
    bySlug = Object.fromEntries(r.body.apps.map((a) => [a.slug, a]));
    eq(bySlug['widget-b'].status, 'unknown', "the catalog: widget-b 'unknown' while unverified");
    writeAppJson(rootB, { pid: appB.pid, port: PORT }); // the engine's OWN port
    r = await call(`/api/rooms/${roomY.id}/apps`, { as: 'person', json: { slug: 'widget-b', move: true } });
    eq([r.status, r.body?.reason], [502, 'endpoint-unverified'], "app.json naming the ENGINE's own port: refused, never a confused deputy");
    ok(/reserved/.test(r.body?.detail ?? ''), `(${r.body?.detail})`);
    writeAppJson(rootB, { pid: appB.pid, port: 8204 });
    r = await call(`/api/rooms/${roomY.id}/apps`, { as: 'person', json: { slug: 'widget-b', move: true } });
    eq([r.status, r.body?.reason], [502, 'endpoint-unverified'], 'a known service port (the fabric, 8204): refused');
    eq((await bindCalls(appB.port)).length, callsBefore, 'still no bind call reached the app');
    eq((await call(`/api/rooms/${roomX.id}/apps`)).body.apps.map((a) => a.slug), ['widget-b'], 'and nothing moved');
    writeAppJson(rootB, { pid: appB.pid, port: appB.port });

    console.log('\n[a single read of tool.json per add: an edit holds, nothing binds (P1-a)]');
    const originalB = readFileSync(join(rootB, 'tool.json'));
    const editedB = baseTool('widget-b', { name: 'Widget B', access: 'exclusive', lifecycle: { bind: { http: 'POST /evil' } } });
    writeFileSync(join(rootB, 'tool.json'), JSON.stringify(editedB, null, 2));
    r = await call(`/api/rooms/${roomY.id}/apps`, { as: 'person', json: { slug: 'widget-b', move: true } });
    eq([r.status, r.body?.error], [409, 'held'], 'tool.json edited since approval (bind path changed): 409 held on the add itself');
    eq((await bindCalls(appB.port)).length, callsBefore, 'the edited bind was never called');
    writeFileSync(join(rootB, 'tool.json'), originalB);
    r = await call(`/api/rooms/${roomY.id}/apps`, { as: 'person', json: { slug: 'widget-b', move: true } });
    eq([r.status, r.body?.error], [409, 'held'], 'held is sticky even after the bytes come back');
    r = await call('/api/apps/widget-b/approve', { as: 'person', json: { expected_sha256: shaOf(originalB) } });
    eq(r.status, 200, 'a human approves the original bytes again');

    console.log('\n[the bind answer is read at most 64 KB (P2)]');
    await ctl(appB.port, { bigBody: true });
    let t0 = Date.now();
    r = await call(`/api/rooms/${roomY.id}/apps`, { as: 'person', json: { slug: 'widget-b', move: true } });
    const took = Date.now() - t0;
    eq(r.status, 200, 'an app that streams an endless bind body: the add still completes');
    ok(took < 8000, `well inside the 10s bind timeout — the engine stopped reading (${took} ms)`);
    await ctl(appB.port, { bigBody: false });
    eq((await call(`/api/rooms/${roomY.id}/apps`)).body.apps.map((a) => a.slug), ['widget-b'], 'moved to Room Y');

    console.log('\n[bind to a stopped app: 502, nothing moves]');
    await stopApp(appB);
    r = await call(`/api/rooms/${roomX.id}/apps`, { as: 'person', json: { slug: 'widget-b', move: true } });
    eq(r.status, 502, 'the app is not listening: 502');
    eq([r.body?.error, r.body?.reason, r.body?.detail], ['bind-failed', 'endpoint-unverified', 'no-listener'], 'bind-failed, endpoint-unverified (no-listener)');
    eq((await call(`/api/rooms/${roomY.id}/apps`)).body.apps.map((a) => a.slug), ['widget-b'], 'still in Room Y — nothing moved');
    r = await call('/api/apps');
    bySlug = Object.fromEntries(r.body.apps.map((a) => [a.slug, a]));
    eq(bySlug['widget-b'].status, 'down', "a stale app.json with nothing listening reads 'down', not 'unknown'");
    appB = await startApp(stubPath, rootB, STUB2_PORT);

    console.log('\n[the panel cap is checked BEFORE the bind call; a failed placement moves nothing]');
    const roomFull = await createRoom('Full');
    for (let i = 0; i < 24; i++) {
      r = await call(`/api/rooms/${roomFull.id}/panels`, { as: 'person', json: { title: `Filler ${i}`, url: `http://127.0.0.1:${STUB1_PORT}/filler/${i}` } });
      if (r.status !== 200) {
        throw new Error(`filler panel ${i}: ${JSON.stringify(r)}`);
      }
    }
    r = await call(`/api/rooms/${roomFull.id}/apps`, { as: 'person', json: { slug: 'widget-b', move: true } });
    eq([r.status, r.body?.field], [409, 'panel'], 'moving widget-b into a room at the panel cap: 409 (field panel)');
    eq((await bindCalls(appB.port)).length, 0, 'refused BEFORE the bind call — the app was never told to move');
    eq((await call(`/api/rooms/${roomY.id}/apps`)).body.apps.map((a) => a.slug), ['widget-b'], 'and Room Y still holds it');
    eq((await call(`/api/rooms/${roomFull.id}/apps`)).body.apps, [], 'the full room holds nothing new');

    console.log('\n[two concurrent adds of an exclusive app: exactly one wins]');
    r = await call(`/api/rooms/${roomY.id}/apps/widget-b`, { method: 'DELETE', as: 'person' });
    eq(r.status, 200, 'widget-b taken out of every room');
    await ctl(appB.port, { bindDelayMs: 400 });
    const roomP = await createRoom('Race P');
    const roomQ = await createRoom('Race Q');
    const [rp, rq] = await Promise.all([
      call(`/api/rooms/${roomP.id}/apps`, { as: 'person', json: { slug: 'widget-b' } }),
      call(`/api/rooms/${roomQ.id}/apps`, { as: 'person', json: { slug: 'widget-b' } }),
    ]);
    await ctl(appB.port, { bindDelayMs: 0 });
    eq([rp.status, rq.status].sort(), [200, 409], 'both passed the first check and both bound, but only one is placed');
    const [winner, loser, loserRes] = rp.status === 200 ? [roomP, roomQ, rq] : [roomQ, roomP, rp];
    eq(loserRes.body, { error: 'exclusive', heldBy: { id: winner.id, name: winner.name } }, 'the loser gets 409 exclusive naming the winner');
    eq((await call(`/api/rooms/${winner.id}/apps`)).body.apps.map((a) => a.slug), ['widget-b'], 'the winner holds it');
    eq((await call(`/api/rooms/${loser.id}/apps`)).body.apps, [], 'the loser holds nothing');
    eq((await call(`/api/rooms/${loser.id}/panels`)).body.panels, [], 'and has no panel');
    eq((await bindCalls(appB.port)).length, 2, 'both binds were called (the race is after the check)');
    ok(/lost the placement race/.test(engineLog), 'the losing bind is logged');

    console.log('\n[reconcile hash-checks before it builds a panel (P1-b)]');
    // widget-c is exclusive and already in roomDown — move it here (bind
    // not-supported) so its "no panel yet" state carries over.
    const roomC = await createRoom('Room C');
    r = await call(`/api/rooms/${roomC.id}/apps`, { as: 'person', json: { slug: 'widget-c', move: true } });
    eq(r.status, 200, 'moving widget-c (still down): 200 — not-supported never gates on reachability');
    eq(r.body.app.panel_ids, [], 'still down: no panel');
    eq((await call(`/api/rooms/${roomDown.id}/apps`)).body.apps, [], 'and Room Down no longer holds it');
    const originalC = readFileSync(join(rootC, 'tool.json'));
    writeFileSync(
      join(rootC, 'tool.json'),
      JSON.stringify(baseTool('widget-c', { name: 'Widget C', access: 'exclusive', panels: [{ title: 'Evil', view: 'GET /evil/:roomId', scripts: true }] }), null, 2),
    );
    appC = await startApp(stubPath, rootC, 0);
    r = await call('/api/apps'); // reconcile FIRST, then the catalog
    bySlug = Object.fromEntries(r.body.apps.map((a) => [a.slug, a]));
    eq(bySlug['widget-c'].status, 'held', 'the edited tool.json is held');
    eq((await call(`/api/rooms/${roomC.id}/panels`)).body.panels, [], 'and reconcile built NO panel from the unapproved view');
    writeFileSync(join(rootC, 'tool.json'), originalC);
    r = await call('/api/apps/widget-c/approve', { as: 'person', json: { expected_sha256: shaOf(originalC) } });
    eq(r.status, 200, 'the original bytes, approved');

    console.log('\n[GET /api/apps reconciles: a fresh panel for a now-running app]');
    r = await call('/api/apps'); // triggers reconcile()
    bySlug = Object.fromEntries(r.body.apps.map((a) => [a.slug, a]));
    eq(bySlug['widget-c'].status, 'running', 'widget-c is now running (its own process, an ephemeral port)');
    panels = (await call(`/api/rooms/${roomC.id}/panels`)).body.panels;
    eq(panels.length, 1, 'reconcile filled in the panel it was missing');
    eq(panels[0].app_slug, 'widget-c', 'carrying the right app_slug');
    eq(panels[0].url, `http://127.0.0.1:${appC.port}/rooms/${roomC.id}/view`, 'from the APPROVED view on the verified port');

    console.log('\n[the root\'s realpath is pinned: a swapped parent dir holds the tool]');
    const realTools = toolsDir + '.real';
    const evil = join(tmpDir, 'evil-tools');
    cpSync(toolsDir, evil, { recursive: true, filter: (src) => !src.includes(`${join(toolsDir, 'linked-tool')}`) });
    renameSync(toolsDir, realTools);
    symlinkSync(evil, toolsDir); // same root strings, same tool.json bytes, different tree
    eq(toolSha(rootA), toolSha(join(realTools, 'widget-a')), 'the swapped tree has byte-identical tool.json');
    r = await call('/api/apps');
    bySlug = Object.fromEntries(r.body.apps.map((a) => [a.slug, a]));
    eq(bySlug['widget-a'].status, 'held', 'widget-a: held — its root now resolves somewhere else');
    ok(/resolves to/.test(engineLog), 'and the log says why');
    r = await call(`/api/rooms/${roomA.id}/apps`, { as: 'person', json: { slug: 'widget-a' } });
    eq([r.status, r.body?.error], [409, 'held'], 'a held app cannot be added');
    unlinkSync(toolsDir);
    renameSync(realTools, toolsDir);
    r = await call('/api/apps/widget-a/approve', { as: 'person', json: { expected_sha256: toolSha(rootA) } });
    eq([r.status, r.body?.app?.status], [200, 'running'], 'back in place and approved: running again');

    console.log('\n[unknown slug]');
    const roomZ = await createRoom('Room Z');
    r = await call(`/api/rooms/${roomZ.id}/apps`, { as: 'person', json: { slug: 'no-such-app' } });
    eq(r.status, 404, 'an unregistered slug: 404');

    ok(!/unhandled|UnhandledPromiseRejection/i.test(engineLog), 'the engine logged no unhandled rejection');
    ok(engine.exitCode === null, 'and it is still running');
  } catch (e) {
    failed++;
    failures.push(String(e?.stack ?? e));
    console.log(`  X threw: ${e?.stack ?? e}`);
  } finally {
    if (engine) {
      engine.kill('SIGKILL');
      await sleep(200);
    }
    for (const c of children) {
      if (c.exitCode === null && c.signalCode === null) {
        c.kill('SIGKILL');
      }
    }
    await sleep(100);
    rmSync(tmpDir, { recursive: true, force: true });
  }

  if (failed) {
    console.log('\nengine log (tail):\n' + engineLog.split('\n').slice(-40).join('\n'));
    console.log('\nFAILURES:\n' + failures.map((f) => ' - ' + f).join('\n'));
  }
  console.log(`\nPASS ${passed}  FAIL ${failed}`);
  process.exit(failed ? 1 : 0);
}

run();
