/**
 * SETTINGS → APPS through a real scratch engine [ticket, ticket, ticket]:
 *
 *   - GET /api/apps: every known app with `state` (registered | needs-approval
 *     | unregistered-candidate) and `actions`; for a PERSON also `candidates`
 *     and a held app's `pending` change; a bearer gets {apps} only;
 *   - POST /api/apps/:slug/register | /approve | /unregister are HUMAN-ONLY:
 *     a bearer 403 (field credential), no credential 401, an unknown bearer
 *     (what an unminted / revoked pane token is) 401;
 *   - unregister blocks actions (409 not-registered) but KEEPS room_apps and
 *     the panels; adding it to a room is 409 not-registered; approve refuses;
 *     register again restores (unchanged file) or holds (a changed one);
 *   - panels carry `app_status` (enabled | held | unregistered);
 *   - THE ROOM NOTICE: one fact per change in every OPEN room holding the
 *     app (held, unregistered, approved, registered again), never repeated
 *     while the state persists, none in an archived room; app add/remove
 *     facts name the app.
 *
 * The fake app is a CHILD PROCESS with cwd = its tool root, writing its own
 * pid + port into status/app.json (the engine verifies who listens). Linux
 * only (verifyEndpoint reads /proc).
 *
 * SAFETY: scratch engine P(280), dead broker P(281) (nothing may listen);
 * the fake apps take ephemeral ports. childEnv() scrubs PTY_BROKER_ and
 * HARBOR_WB_ keys; fabric + NATS off. Temp dirs removed, children killed.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(280);
const DEAD_BROKER_PORT = P(281);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'room-apps-settings-test-token';

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
/** as: 'person' (window cookie, the default here) | 'agent' (bearer) | 'stranger' (an unknown bearer) | 'none'. */
async function call(path, { method, json, as = 'person', headers = {} } = {}) {
  const h = { ...(as === 'person' ? { cookie } : as === 'agent' ? { authorization: `Bearer ${TOKEN}` } : as === 'stranger' ? { authorization: 'Bearer wbp_not-a-real-pane-token' } : {}), ...headers };
  const init = { method: method ?? (json === undefined ? 'GET' : 'POST'), headers: h };
  if (json !== undefined) {
    h['content-type'] ??= 'application/json';
    init.body = typeof json === 'string' ? json : JSON.stringify(json);
  }
  const res = await fetch(BASE + path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}

/* A fake app: records every request that is not /health or /__* (method,
   url, the headers that matter, the body). `.../fail` answers 409, `.../deny`
   401; anything else 200 with an echo. No regex here: this is a template
   string, and a backslash in it is a trap. */
const STUB_SRC = `
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
const calls = [];
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const srv = createServer((req, res) => {
  const u = req.url ?? '';
  if (u.startsWith('/health')) return json(res, 200, { ok: true });
  if (u === '/__calls') return json(res, 200, calls);
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    calls.push({ method: req.method, url: u, cookie: req.headers.cookie ?? null, authorization: req.headers.authorization ?? null,
      origin: req.headers.origin ?? null, contentType: req.headers['content-type'] ?? null, body: raw });
    if (u.endsWith('/fail')) return json(res, 409, { ok: false, error: 'nope' });
    if (u.endsWith('/deny')) return json(res, 401, { ok: false, error: 'who are you' });
    return json(res, 200, { ok: true, echo: req.method + ' ' + u });
  });
});
srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port;
  mkdirSync('status', { recursive: true });
  writeFileSync('status/app.json', JSON.stringify({ pid: process.pid, port }));
  console.log('READY ' + port);
});
`;

const children = [];
function startApp(stubPath, root) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [stubPath], { cwd: root, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
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
        resolve({ proc, port: Number(m[1]) });
      }
    });
    proc.stderr.on('data', (d) => (out += d));
    proc.on('exit', () => !done && reject(new Error(`stub in ${root} exited: ${out}`)));
  });
}
const callsOf = (app) => fetch(`http://127.0.0.1:${app.port}/__calls`).then((r) => r.json());

const verb = (name, http, x = {}) => ({ name, class: x.class ?? 'mutate', call: { http }, panel: true });
const tool = (slug, name, extra = {}) => ({
  contract: 'tool/draft-0',
  name,
  slug,
  version: '0.1.0',
  description: `${name}.`,
  access: 'shared',
  endpoint: { bind: '127.0.0.1', discover: 'status/app.json#port' },
  verbs: [verb('pin', 'POST /rooms/:roomId/items/:id/pin')],
  panels: [{ title: name, icon: 'tasks', view: 'GET /rooms/:roomId/view', scripts: true }],
  ...extra,
});
const shaOf = (root) => createHash('sha256').update(readFileSync(join(root, 'tool.json'))).digest('hex');

async function run() {
  if (process.platform !== 'linux') {
    console.log('room-apps-settings.test: needs /proc (linux) — the engine refuses every tool endpoint elsewhere');
    process.exit(1);
  }
  for (const p of [PORT, DEAD_BROKER_PORT]) {
    await assertFree(p, 'room-apps-settings.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-apps-settings-'));
  const toolsDir = join(tmpDir, 'tools');
  const dbPath = join(tmpDir, 'mapping.db');
  const stubPath = join(tmpDir, 'fake-app.mjs');
  writeFileSync(stubPath, STUB_SRC);
  const writeTool = (slug, t) => {
    const root = join(toolsDir, slug);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'tool.json'), JSON.stringify(t, null, 2));
    return root;
  };
  const rootActs = writeTool('acts', tool('acts', 'Acts'));
  const rootSecond = writeTool('second', tool('second', 'Second'));
  writeTool('cand', tool('cand', 'Candidate'));
  writeTool('broken', { contract: 'nope', slug: 'broken' });

  let engine = null;
  let engineLog = '';
  try {
    const acts = await startApp(stubPath, rootActs);
    await startApp(stubPath, rootSecond);
    const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
    engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_PORT: String(PORT),
        HARBOR_WB_HOST: '127.0.0.1',
        HARBOR_WB_TABLE: dbPath,
        HARBOR_WB_TOKEN: TOKEN,
        HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'),
        HARBOR_WB_IDENTITY: 'legacy',
        HARBOR_WB_NO_WINDOW: '1',
        HARBOR_WB_NATS_URL: '',
        HARBOR_WB_FABRIC_URL: '',
        HARBOR_WB_BROKER_AUTOSTART: '0',
        HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT),
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_NODE: 'testnode',
        HARBOR_WB_TOOLS_DIR: toolsDir,
        HARBOR_WB_PANE_TOKENS: '1',
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
    cookie = await windowCookie(BASE, TOKEN);

    const facts = async (roomId) => ((await call(`/api/rooms/${roomId}/line?limit=1000`)).body?.entries ?? []).filter((e) => e.kind === 'fact').map((e) => e.body);
    const count = (list, re) => list.filter((b) => re.test(b)).length;
    const appOf = async (slug) => (await call('/api/apps')).body.apps.find((a) => a.slug === slug);

    console.log('\n[GET /api/apps: every known app]');
    let r = await call('/api/apps');
    eq(r.status, 200, 'a person reads the list');
    eq(r.body.apps, [], 'nothing registered yet');
    eq(r.body.candidates.map((c) => [c.slug, c.state, c.ok]).sort(), [['acts', 'unregistered-candidate', true], ['broken', 'unregistered-candidate', false], ['cand', 'unregistered-candidate', true], ['second', 'unregistered-candidate', true]],
      'candidates: every tool folder, state unregistered-candidate (an invalid one listed with ok:false)');
    r = await call('/api/apps', { as: 'agent' });
    ok(r.status === 200 && Array.isArray(r.body.apps) && !('candidates' in r.body), 'a bearer reads {apps} only: no candidates (browsing the tools folder is human-only)');

    console.log('\n[register / approve / unregister are human-only]');
    for (const verbName of ['register', 'approve', 'unregister']) {
      r = await call(`/api/apps/acts/${verbName}`, { as: 'agent', json: {} });
      eq([r.status, r.body?.field], [403, 'credential'], `${verbName} with the bearer: 403`);
      r = await call(`/api/apps/acts/${verbName}`, { as: 'none', json: {} });
      eq(r.status, 401, `${verbName} with no credential: 401`);
      r = await call(`/api/apps/acts/${verbName}`, { as: 'stranger', json: {} });
      eq(r.status, 401, `${verbName} with an unknown bearer (an unminted pane token): 401`);
    }
    r = await call('/api/apps/acts/register', { method: 'GET' });
    eq(r.status, 405, 'GET on register: 405');
    r = await call('/api/apps/nope/register', { json: {} });
    eq(r.status, 404, 'register a slug with no folder: 404');
    r = await call('/api/apps/broken/register', { json: {} });
    ok(r.status === 400 && /invalid/.test(r.body?.error ?? ''), `register an invalid tool.json: 400 (${r.body?.error})`);
    r = await call('/api/apps/acts/register', { json: { expected_sha256: '0'.repeat(64) } });
    eq([r.status, r.body?.error], [409, 'changed'], 'register with a sha that is not the file on disk: 409 changed');
    r = await call('/api/apps/acts/register', { json: { expected_sha256: shaOf(rootActs) } });
    ok(r.status === 200 && r.body.app?.state === 'registered' && r.body.app?.actions === 'enabled', `a person registers acts by slug: 200, state registered (${JSON.stringify(r.body?.app?.state)})`);
    r = await call('/api/apps/acts/register', { json: {} });
    eq(r.status, 409, 'registering it twice: 409');
    r = await call('/api/apps/second/register', { json: {} });
    eq(r.status, 200, 'second registered');
    r = await call('/api/apps');
    ok(!r.body.candidates.some((c) => c.slug === 'acts'), 'a registered app is no longer a candidate');

    const room = (await call('/api/rooms', { json: { name: 'Settings Room' } })).body;
    const room2 = (await call('/api/rooms', { json: { name: 'Other Room' } })).body;
    const boxed = (await call('/api/rooms', { json: { name: 'Boxed Room' } })).body;
    for (const [rid, slug] of [[room.id, 'acts'], [room2.id, 'acts'], [room.id, 'second'], [boxed.id, 'acts']]) {
      r = await call(`/api/rooms/${rid}/apps`, { json: { slug } });
      eq(r.status, 200, `${slug} added to a room`);
    }
    r = await call(`/api/rooms/${boxed.id}/archive`, { json: {} });
    ok(r.status === 200, `the Boxed room is archived (${r.status})`);
    ok(count(await facts(room.id), /^Acts was added to the room$/) === 1, 'the add fact names the app: "Acts was added to the room"');
    let panels = (await call(`/api/rooms/${room.id}/panels`)).body.panels;
    const pActs = panels.find((p) => p.app_slug === 'acts');
    eq(pActs?.app_status, 'enabled', 'a registered app\'s panel: app_status enabled');
    const A = () => `/api/rooms/${room.id}/panels/${pActs.id}/action`;
    r = await call(A(), { json: { name: 'pin', params: { id: '1' } } });
    eq(r.status, 200, 'its action runs');

    console.log('\n[held: the pinned tool.json changed]');
    const orig = readFileSync(join(rootActs, 'tool.json'), 'utf8');
    writeFileSync(join(rootActs, 'tool.json'), JSON.stringify(tool('acts', 'Acts', { description: 'Changed.', verbs: [verb('pin', 'POST /rooms/:roomId/items/:id/pin'), verb('wipe', 'POST /rooms/:roomId/wipe')] }), null, 2));
    let a = await appOf('acts');
    eq([a.state, a.actions, a.status], ['needs-approval', 'held', 'held'], 'the next read holds it: state needs-approval, actions held');
    eq(a.pending?.diff?.actions?.added, ['wipe'], 'a person\'s read carries the pending change (the new panel action)');
    ok(typeof a.pending?.sha256 === 'string' && a.pending.sha256 === shaOf(rootActs), 'pending.sha256 = the file approve would pin');
    await call('/api/apps');
    await call('/api/apps');
    r = await call(A(), { json: { name: 'pin', params: { id: '1' } } });
    eq([r.status, r.body?.error, r.body?.app_status], [409, 'held', 'held'], 'an action on the held app: 409 held (app_status held)');
    for (const rid of [room.id, room2.id]) {
      eq(count(await facts(rid), /^Acts is waiting for your approval · Settings → Apps$/), 1, 'ONE "Acts is waiting for your approval · Settings → Apps" in each room with it, however often it is re-read');
    }
    eq(count(await facts(boxed.id), /waiting for your approval/), 0, 'none in an archived room (stasis)');
    eq(count(await facts(room.id), /^Second (is |was (approved|registered))/), 0, 'nothing about an app that did not change');
    panels = (await call(`/api/rooms/${room.id}/panels`)).body.panels;
    eq(panels.find((p) => p.id === pActs.id)?.app_status, 'held', 'the panel says app_status held');
    r = await call('/api/apps/acts/approve', { json: { expected_sha256: shaOf(rootActs) } });
    ok(r.status === 200 && r.body.app?.state === 'registered', 'a person approves: registered');
    eq(count(await facts(room.id), /^Acts was approved; its actions now work$/), 1, 'ONE "Acts was approved; its actions now work"');
    r = await call('/api/apps/acts/approve', { json: { expected_sha256: shaOf(rootActs) } });
    eq(r.status, 200, 'approving an app that is not held: 200 (a re-pin)');
    eq(count(await facts(room.id), /was approved/), 1, 'and no second "approved" line (nothing changed)');
    r = await call(A(), { json: { name: 'wipe' } });
    eq(r.status, 200, 'the approved action runs');

    console.log('\n[unregister]');
    r = await call('/api/apps/acts/unregister', { json: {} });
    ok(r.status === 200 && r.body.app?.state === 'unregistered-candidate' && r.body.app?.actions === 'unregistered', `a person unregisters: state unregistered-candidate, actions unregistered (${r.body?.app?.state})`);
    r = await call('/api/apps/acts/unregister', { method: 'POST' });
    eq(r.status, 200, 'unregister again (no body): 200, idempotent');
    eq(count(await facts(room.id), /^Acts is not registered · Settings → Apps$/), 1, 'ONE "Acts is not registered · Settings → Apps"');
    eq(count(await facts(room2.id), /is not registered/), 1, '...in every open room with it');
    eq((await call(`/api/rooms/${room.id}/apps`)).body.apps.map((x) => x.slug).sort(), ['acts', 'second'], 'room_apps keeps it (it stays in the rail)');
    panels = (await call(`/api/rooms/${room.id}/panels`)).body.panels;
    eq(panels.find((p) => p.id === pActs.id)?.app_status, 'unregistered', 'its panel stays, app_status unregistered');
    const n0 = (await callsOf(acts)).length;
    r = await call(A(), { json: { name: 'pin', params: { id: '1' } } });
    eq([r.status, r.body?.error, r.body?.app_status], [409, 'not-registered', 'unregistered'], 'an action on it: 409 not-registered');
    eq((await callsOf(acts)).length, n0, 'nothing reached the app');
    const room3 = (await call('/api/rooms', { json: { name: 'Third' } })).body;
    r = await call(`/api/rooms/${room3.id}/apps`, { json: { slug: 'acts' } });
    eq([r.status, r.body?.error], [409, 'not-registered'], 'adding it to a room: 409 not-registered');
    r = await call('/api/apps/acts/approve', { json: {} });
    eq(r.status, 409, 'approving an unregistered app: 409 (register it first)');
    r = await call('/api/apps');
    ok(r.body.apps.some((x) => x.slug === 'acts' && x.state === 'unregistered-candidate' && x.rooms.length === 3) && !r.body.candidates.some((c) => c.slug === 'acts'),
      'GET /api/apps lists it once, in apps, unregistered-candidate, with its rooms');
    r = await call('/api/apps/acts/register', { as: 'agent', json: {} });
    eq(r.status, 403, 'an agent cannot register it again');

    console.log('\n[register again]');
    r = await call('/api/apps/acts/register', { json: {} });
    ok(r.status === 200 && r.body.app?.state === 'registered', 'register again, file unchanged since its pin: registered');
    eq(count(await facts(room.id), /^Acts was registered; its actions now work$/), 1, 'ONE "Acts was registered; its actions now work"');
    r = await call(A(), { json: { name: 'pin', params: { id: '1' } } });
    eq(r.status, 200, 'its actions work again');
    await call('/api/apps/acts/unregister', { json: {} });
    writeFileSync(join(rootActs, 'tool.json'), orig);
    r = await call('/api/apps/acts/register', { json: {} });
    ok(r.status === 200 && r.body.app?.state === 'needs-approval', `register again after a change: needs approval, never a silent re-pin (${r.body?.app?.state})`);
    let fs1 = await facts(room.id);
    eq(count(fs1, /^Acts was registered and is waiting for your approval · Settings → Apps$/), 1, 'ONE "was registered and is waiting for your approval" line');
    eq(count(fs1, /^Acts is waiting for your approval/), 1, 'and no second "waiting" line for the same change');
    r = await call('/api/apps/acts/approve', { json: { expected_sha256: shaOf(rootActs) } });
    eq(r.status, 200, 'approve: registered again');
    r = await call(A(), { json: { name: 'pin', params: { id: '1' } } });
    eq(r.status, 200, 'actions restored');

    console.log('\n[app add / remove facts]');
    r = await call(`/api/rooms/${room.id}/apps/second`, { method: 'DELETE', json: {} });
    eq(r.status, 200, 'second removed from the room');
    eq(count(await facts(room.id), /^Second was removed from the room$/), 1, 'the remove fact names the app');
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
