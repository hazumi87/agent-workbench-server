/**
 * PROJECT CHANNEL routes through a real scratch engine (the design notes):
 * GET /api/projects/:slug/activity and POST/DELETE /api/projects/:slug/lock.
 *
 * The rooms-routes pattern: our own engine on P() ports, a temp mapping db, NO
 * broker and NO pty (the broker port is a dead P() port). Rows are written
 * through test/rooms-routes.seed.ts: recipes, a room and dehydrated rows before
 * boot, the same rows LIVE after it. The project's checkout and its origin are
 * temp repos (no network); the engine's mirror dir is in the temp dir.
 *
 * SAFETY: never touches :7420/:7430/:8200/:8201/:8204, the real data dir, or a
 * broker. Every child env comes from childEnv(). The temp dir is removed.
 */
import { spawn, execFileSync } from 'node:child_process';
import { rmSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(122); // scratch engine — port table in test/_scratch.mjs
const DEAD_BROKER_PORT = P(123); // nothing may listen: no pty is ever opened here
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'project-routes-test-token';
const NL = String.fromCharCode(10);

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
  ok(a === b, a === b ? msg : `${msg}${NL}      got      ${a}${NL}      expected ${b}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, opts = {}) {
  const headers = {};
  if (opts.cookie) {
    headers.cookie = opts.cookie;
  } else if (opts.auth !== false) {
    headers.authorization = `Bearer ${TOKEN}`;
  }
  const init = { method: opts.method ?? 'GET', headers, redirect: 'manual' };
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.json);
    init.method = opts.method ?? 'POST';
  }
  const res = await fetch(BASE + path, init);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not json */
  }
  return { status: res.status, body, res };
}
const lock = (slug, json, extra = {}) => call(`/api/projects/${slug}/lock`, { json, ...extra });
const unlock = (slug, json, extra = {}) => call(`/api/projects/${slug}/lock`, { json, method: 'DELETE', ...extra });
const activity = (slug, q = '') => call(`/api/projects/${slug}/activity${q}`);

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

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@x', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@x',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
};
const g = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function run() {
  for (const p of [PORT, DEAD_BROKER_PORT]) {
    await assertFree(p, 'project-routes.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-project-routes-'));
  const dbPath = join(tmpDir, 'mapping.db');
  let engine = null;
  let engineLog = '';
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], {
      HARBOR_WB_TABLE: dbPath,
      HARBOR_WB_IDENTITY: 'legacy',
    });
    if (r.code !== 0) {
      throw new Error(`seed failed: ${r.err}`);
    }
    return JSON.parse(r.out.trim().split(NL).pop());
  };

  try {
    /* ---------------------------------------------------- repos ---- */
    const origin = join(tmpDir, 'origin.git');
    g(tmpDir, 'init', '--quiet', '--bare', '-b', 'main', origin);
    const checkout = join(tmpDir, 'demo-proj');
    g(tmpDir, 'clone', '--quiet', origin, checkout);
    writeFileSync(join(checkout, 'a.txt'), `a${NL}`);
    g(checkout, 'add', 'a.txt');
    g(checkout, 'commit', '--quiet', '-m', `add a${NL}${NL}Session: vrpc1`);
    g(checkout, 'push', '--quiet', 'origin', 'HEAD:main');

    /* ----------------------------------------------------- seed ---- */
    const recipe = (id, name, dir, agent) => ({ id, name, projectDir: dir, vendor: 'claude-code', agent, target: 'local' });
    const sessions = (state) => [
      { paneid: 'recipe:rec-demo#1', recipe_id: 'rec-demo', vendor: 'claude-code', agent: 'demo-proj', state },
      { paneid: 'recipe:rec-demo2#1', recipe_id: 'rec-demo2', vendor: 'claude-code', agent: 'demo-proj', state },
      { paneid: 'recipe:rec-other#1', recipe_id: 'rec-other', vendor: 'claude-code', agent: 'other', state },
    ];
    await seed({
      recipes: [
        recipe('rec-demo', 'Demo', checkout, 'demo-proj'),
        recipe('rec-demo2', 'Demo two', checkout, 'demo-proj'),
        recipe('rec-other', 'Other', join(tmpDir, 'other'), 'other'),
        recipe('rec-dead', 'Dead', checkout, 'demo-proj'),
      ],
      sessions: [
        ...sessions('dehydrated'),
        { paneid: 'recipe:rec-dead#1', recipe_id: 'rec-dead', vendor: 'claude-code', agent: 'demo-proj', state: 'killed' },
      ],
      rooms: [{ name: 'Merge room', seats: [{ handle: 'demo', recipe_id: 'rec-demo', occupant: 'recipe:rec-demo#1' }] }],
    });

    console.log(`booting scratch engine :${PORT} (dead broker :${DEAD_BROKER_PORT}, db ${dbPath})`);
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
        HARBOR_WB_TARGETS: JSON.stringify({ targets: [{ id: 'local', label: 'This host', kind: 'local' }] }),
        HARBOR_WB_MIRRORS: join(tmpDir, 'mirrors'),
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
      throw new Error(`engine did not come up${NL}${engineLog}`);
    }
    await seed({ sessions: sessions('live') });

    /* ------------------------------------------------- activity ---- */
    console.log('activity');
    eq((await call('/api/projects/demo-proj/activity', { auth: false })).status, 401, 'no credential: 401 (no loopback exemption)');
    const a = await activity('demo-proj');
    eq(a.status, 200, 'bearer: 200');
    same(a.body.live.map((s) => s.paneid).sort(), ['recipe:rec-demo#1', 'recipe:rec-demo2#1'], 'the live sessions of THIS project only');
    const d1 = a.body.live.find((s) => s.paneid === 'recipe:rec-demo#1');
    same(d1.seats.map((s) => [s.room, s.handle]), [['Merge room', 'demo']], 'the seat and its room');
    same([d1.branch, d1.branch_status, d1.node, d1.vendor], ['main', 'known', 'testnode', 'claude-code'], 'branch (local dir), node, vendor');
    same(a.body.repo, { dir: checkout, origin }, 'the repo is the checkout and its origin');
    same([a.body.origin.status, a.body.origin.default_branch], ['ok', 'main'], 'origin read through the mirror');
    same(a.body.origin.commits.map((c) => [c.subject, c.session]), [['add a', 'vrpc1']], 'origin commits with the Session trailer');
    ok(existsSync(join(tmpDir, 'mirrors', 'demo-proj.git')), 'the mirror is in the engine-owned mirrors dir');
    same(a.body.locks, [], 'no locks yet');
    const other = await activity('other');
    same([other.body.live.length, other.body.origin.status], [1, 'unavailable'], 'a project with no checkout here: live yes, origin unavailable');
    ok(typeof other.body.origin.reason === 'string' && other.body.origin.reason.length > 0, `  ...with a reason (${other.body.origin.reason})`);
    eq((await activity('Not_A_Slug')).status, 400, 'a non-slug is 400');
    eq((await activity('demo-proj', '?hours=999')).status, 400, 'hours over the max is 400');
    eq((await activity('demo-proj', '?wait_ms=0')).status, 200, 'wait_ms=0 serves what the mirror holds');

    /* ----------------------------------------------------- locks ---- */
    console.log('locks');
    const D1 = { paneid: 'recipe:rec-demo#1' };
    const D2 = { paneid: 'recipe:rec-demo2#1' };
    const noFrom = await lock('demo-proj', { branch: 'main' });
    same([noFrom.status, noFrom.body.field], [403, 'from'], 'bearer without from: 403 field from');
    const dead = await lock('demo-proj', { from: { paneid: 'recipe:rec-dead#1' } });
    same([dead.status, dead.body.field], [403, 'from'], 'from a pane that is not live: 403');
    eq((await lock('demo-proj', { from: D1, ttl_sec: 0 })).status, 400, 'ttl_sec 0: 400');
    /* vrpc1 asked for 600 as `ttl` and got the default with no word why. */
    const c1 = await lock('demo-proj', { from: D1, ttl_sec: 3600 });
    same([c1.status, c1.body.ttl_sec, c1.body.clamped_from, c1.body.lock?.ttl_sec], [200, 900, 3600, 900], 'ttl_sec 3600: clamped to 900 and the answer says so');
    ok(/clamped to the maximum 900/.test(c1.body.message ?? ''), `  ...with a message (${c1.body.message})`);
    const c2 = await lock('demo-proj', { from: D1, ttl: 600 });
    same([c2.status, c2.body.ttl_sec, c2.body.clamped_from, c2.body.lock?.ttl_sec], [200, 600, undefined, 600], '`ttl` is accepted as the field: 600 granted');
    const c3 = await lock('demo-proj', { from: D1 });
    same([c3.body.ttl_sec, c3.body.ttl_default], [300, true], 'no ttl: the default, and the answer says it was the default');
    eq((await unlock('demo-proj', { from: D1 })).status, 200, '  (released)');
    const t1 = await lock('demo-proj', { from: D1, branch: 'main', note: 'MERGE-LOCK', ttl_sec: 600 });
    same([t1.status, t1.body.lock?.holder?.paneid, t1.body.lock?.holder?.slug], [200, D1.paneid, 'demo-proj'], 'from {paneid}: taken, holder is that pane');
    same([t1.body.ttl_sec, t1.body.clamped_from, t1.body.ttl_default], [600, undefined, undefined], '  ttl_sec 600 granted as asked, nothing to explain');
    const t2 = await lock('demo-proj', { from: D2, branch: 'feat' });
    eq(t2.status, 409, 'a second holder: 409');
    ok(t2.body.message.includes(D1.paneid) && t2.body.lock.holder.paneid === D1.paneid, `409 names the holder (${t2.body.message})`);
    const listed = (await activity('demo-proj')).body.locks;
    same(listed.map((l) => [l.holder.paneid, l.branch, l.note]), [[D1.paneid, 'main', 'MERGE-LOCK']], 'activity lists the lock');
    eq((await unlock('demo-proj', { from: D2 })).status, 403, 'only the holder may delete (403)');
    same((await unlock('demo-proj', {})).body.field, 'from', 'delete: bearer without from is 403 field from');
    eq((await unlock('demo-proj', { from: D1 })).status, 200, 'the holder deletes');
    eq((await unlock('demo-proj', { from: D1 })).status, 404, 'nothing to delete: 404');

    console.log('TTL');
    eq((await lock('demo-proj', { from: D1, ttl_sec: 1 })).status, 200, 'a 1 s lock');
    eq((await lock('demo-proj', { from: D2 })).status, 409, '  held against another pane');
    await sleep(1200);
    eq((await lock('demo-proj', { from: D2 })).status, 200, '  expired: another pane takes it');
    eq((await unlock('demo-proj', { from: D2 })).status, 200, '  and releases it');

    console.log('a person (window cookie)');
    const form = new URLSearchParams({ token: TOKEN }).toString();
    const login = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      redirect: 'manual',
    });
    const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    ok(!!cookie, 'logged in as a window');
    const h = await lock('other', { note: 'human hold' }, { cookie });
    same([h.status, h.body.lock?.holder?.kind], [200, 'user'], 'no from on a human credential: the person holds it');
    const hp = await lock('other', { from: { paneid: 'recipe:rec-other#1' } });
    ok(hp.status === 409 && /the user/.test(hp.body.message), `a pane against the person's lock: 409 (${hp.body.message})`);
    eq((await unlock('other', {}, { cookie })).status, 200, 'the person releases it');
    ok(engineLog.includes('project lock demo-proj: taken by demo-proj (recipe:rec-demo#1)'), 'the engine logs lock events');
  } finally {
    if (engine) {
      engine.kill('SIGKILL');
      await sleep(200);
    }
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

try {
  await run();
} catch (err) {
  failed++;
  failures.push(String(err?.stack ?? err));
  console.log(`  ✗ threw: ${err?.stack ?? err}`);
}
console.log(`${NL}${'='.repeat(40)}`);
if (failures.length) {
  console.log(`failures:${NL}  - ${failures.join(`${NL}  - `)}`);
}
console.log(`PASS ${passed}  FAIL ${failed}`);
process.exit(failed ? 1 : 0);
