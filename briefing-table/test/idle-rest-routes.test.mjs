/**
 * IDLE REST through a real scratch engine (Owner 2026-10-04,
 * item 6). The pure policy is test/idle-rest.test.ts; this proves the doors:
 *
 *   - GET /api/rooms/idle-rest: defaults (all off), any signed-in credential;
 *   - PATCH: a PERSON's window only (bearer 403, none 401), validated (400 names
 *     the field), merged per key, and it persists;
 *   - the OFFLINE NOTICE rides the delivery report of a line to a resting seat:
 *     member with a live lead -> "contact the room lead @boss"; lead resting too
 *     -> "contact your lead or the user"; a resting lead -> "ask the user";
 *   - `/wake @x`: refused for a seat while "Leads can wake members" is off,
 *     refused for a non-lead even when on, refused when the target is not
 *     resting; the user may; the lead may once the toggle is on. A wake that
 *     cannot launch (no broker here) ends as a fact, never a crash.
 *
 * SAFETY: scratch engine P(340), dead broker P(341); childEnv(); temp dir removed.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(340);
const DEAD_BROKER_PORT = P(341);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'idle-rest-test-token';

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
async function call(path, { method, json, as = 'person' } = {}) {
  const h = as === 'person' ? { cookie } : as === 'agent' ? { authorization: `Bearer ${TOKEN}` } : {};
  const init = { method: method ?? (json === undefined ? 'GET' : 'POST'), headers: h };
  if (json !== undefined) {
    h['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  const res = await fetch(BASE + path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}

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

async function run() {
  for (const p of [PORT, DEAD_BROKER_PORT]) {
    await assertFree(p, 'idle-rest-routes.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-idle-rest-'));
  const dbPath = join(tmpDir, 'mapping.db');
  let engine = null;
  let engineLog = '';
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) {
      throw new Error(`seed failed: ${r.err}`);
    }
    return JSON.parse(r.out.trim().split('\n').pop());
  };
  try {
    const recipe = (id, name, vendor) => ({ id, name, projectDir: `/srv/x/${id}`, vendor, agent: id });
    const sess = (n, rec, state) => ({ paneid: `recipe:${rec}#${n}`, recipe_id: rec, vendor: 'claude-code', agent: rec, state });
    const pre = await seed({
      recipes: [recipe('boss', 'Boss', 'claude-code'), recipe('worker', 'Worker', 'claude-code'), recipe('side', 'Side', 'claude-code')],
      sessions: [sess(1, 'boss', 'dehydrated'), sess(1, 'worker', 'dehydrated'), sess(1, 'side', 'dehydrated')],
      rooms: [
        {
          name: 'Rest',
          seats: [
            { handle: 'boss', recipe_id: 'boss', occupant: 'recipe:boss#1' }, // the first seat leads
            { handle: 'worker', recipe_id: 'worker', occupant: 'recipe:worker#1' },
            { handle: 'side', recipe_id: 'side', occupant: 'recipe:side#1' },
          ],
        },
      ],
    });
    const room = pre.rooms[0];
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

    console.log('\n[settings: defaults, credentials, validation, persistence]');
    const g0 = await call('/api/rooms/idle-rest', { as: 'agent' });
    eq(g0.body, { restEnabled: false, restMinutes: 15, memberHours: null, leadHours: null, leadsWakeMembers: false, roomsWakeLeads: false, backgroundGuard: false }, 'GET (a bearer reads): everything off by default');
    eq((await call('/api/rooms/idle-rest', { as: 'none' })).status, 401, 'GET with no credential: 401');
    eq((await call('/api/rooms/idle-rest', { method: 'PATCH', json: { memberHours: 24 }, as: 'agent' })).status, 403, 'PATCH by a bearer: 403 (a person decides)');
    eq((await call('/api/rooms/idle-rest', { method: 'PATCH', json: { memberHours: 24 }, as: 'none' })).status, 401, 'PATCH with no credential: 401');
    const bad = await call('/api/rooms/idle-rest', { method: 'PATCH', json: { memberHours: 0 } });
    ok(bad.status === 400 && bad.body?.field === 'memberHours', 'memberHours 0: 400 naming the field');
    eq((await call('/api/rooms/idle-rest', { method: 'PATCH', json: { leadHours: 'soon' } })).status, 400, 'a non-number period: 400');
    eq((await call('/api/rooms/idle-rest', { method: 'PATCH', json: { roomsWakeLeads: 'yes' } })).status, 400, 'a non-boolean toggle: 400');
    eq((await call('/api/rooms/idle-rest', { method: 'PATCH', json: { nope: 1 } })).status, 400, 'an unknown key: 400');
    eq((await call('/api/rooms/idle-rest', { method: 'PATCH', json: {} })).status, 400, 'an empty patch: 400');
    const p1 = await call('/api/rooms/idle-rest', { method: 'PATCH', json: { memberHours: 24, leadHours: 168 } });
    eq(p1.body, { restEnabled: false, restMinutes: 15, memberHours: 24, leadHours: 168, leadsWakeMembers: false, roomsWakeLeads: false, backgroundGuard: false }, 'PATCH by the person: merged');
    const p2 = await call('/api/rooms/idle-rest', { method: 'PATCH', json: { leadsWakeMembers: true } });
    eq(p2.body, { restEnabled: false, restMinutes: 15, memberHours: 24, leadHours: 168, leadsWakeMembers: true, roomsWakeLeads: false, backgroundGuard: false }, 'a later PATCH keeps the other keys');
    eq((await call('/api/rooms/idle-rest', { as: 'agent' })).body, p2.body, 'GET reads what was stored');
    await call('/api/rooms/idle-rest', { method: 'PATCH', json: { memberHours: null, leadHours: null, leadsWakeMembers: false } });
    eq((await call('/api/rooms/idle-rest', { as: 'agent' })).body.memberHours, null, 'null turns a period back off');

    console.log('\n[the offline notice, on the delivery report]');
    /* [wake deliver] the person's line now WAKES a resting seat by default (personWakes);
       this section tests the level-2 notices, so the person turns that off first */
    eq((await call('/api/agent-comms', { method: 'PATCH', json: { personWakes: false } })).status, 200, 'personWakes off (a person)');
    const say = (text, extra = {}) => call(`/api/rooms/${room.id}/line`, { json: { text, ...extra } });
    const note = (r, handle) => r.body?.entries?.find((e) => e.kind === 'delivery' && e.target === handle)?.body ?? '';
    const w1 = await say('@worker are you there?');
    ok(/not delivered/.test(note(w1, 'worker')) && /@worker and the room lead @boss are offline — contact your lead or the user/.test(note(w1, 'worker')), `member + lead both resting: "${note(w1, 'worker')}"`);
    const b1 = await say('@boss are you there?');
    ok(/@boss is offline — ask the user to bring it back/.test(note(b1, 'boss')), `a resting lead: "${note(b1, 'boss')}"`);
    await seed({ sessions: [sess(1, 'boss', 'live')] }); // the lead is live from here on
    const w2 = await say('@worker still there?');
    ok(/@worker is offline — contact the room lead @boss/.test(note(w2, 'worker')), `member resting, lead live: "${note(w2, 'worker')}"`);
    ok(/not delivered — occupant not live \(@worker\)/.test(note(w2, 'worker')), 'the plain "not delivered" wording is kept');

    console.log('\n[a seat the person disconnected is not woken by an agent]');
    /* the lead may wake members here, so only the person's mark can be what stops it */
    await call('/api/rooms/idle-rest', { method: 'PATCH', json: { leadsWakeMembers: true } });
    await seed({ settings: { 'seatDisconnect.byUser': { 'recipe:worker#1': Date.now() } } });
    const asBossLine = (text) => call(`/api/rooms/${room.id}/line`, { json: { text, from: { paneid: 'recipe:boss#1' } }, as: 'agent' });
    const dn = await asBossLine('@worker status?');
    const dnNote = dn.body?.entries?.find((e) => e.kind === 'delivery' && e.target === 'worker')?.body ?? '';
    ok(/@worker was disconnected by the user, so it was not woken/.test(dnNote) && /Ask the user/.test(dnNote), `an agent's line to it says so: "${dnNote}"`);
    ok(!/waking/.test(dnNote), 'and does not wake it');
    /* the person's own line: scope 'auto' leaves a seat the person disconnected down, and says so */
    await call('/api/agent-comms', { method: 'PATCH', json: { personWakes: true, personWakeScope: 'auto' } });
    const pn = await say('@worker are you there?');
    const pnNote = pn.body?.entries?.find((e) => e.kind === 'delivery' && e.target === 'worker')?.body ?? '';
    ok(/disconnected by you, so it was not woken/.test(pnNote) && /Wake button/.test(pnNote) && !/waking it/.test(pnNote), `the person's line, scope auto: "${pnNote}"`);
    await call('/api/agent-comms', { method: 'PATCH', json: { personWakes: false, personWakeScope: 'all' } });
    await call('/api/rooms/idle-rest', { method: 'PATCH', json: { leadsWakeMembers: false } });
    await seed({ settings: { 'seatDisconnect.byUser': {} } });

    console.log('\n[/wake]');
    const asBoss = (text) => call(`/api/rooms/${room.id}/line`, { json: { text, from: { paneid: 'recipe:boss#1' } }, as: 'agent' });
    const wk0 = await asBoss('/wake @worker');
    eq(wk0.body?.status, 'refused', 'the lead, toggle off: refused');
    ok(/Leads can wake members/.test(wk0.body?.refused?.error ?? ''), 'the refusal names the setting');
    await call('/api/rooms/idle-rest', { method: 'PATCH', json: { leadsWakeMembers: true } });
    eq((await say('/wake @boss')).body?.status, 'refused', 'the user: a live seat is not resting');
    const wk1 = await asBoss('/wake @worker');
    eq(wk1.body?.status, 'applied', 'the lead, toggle on: applied');
    ok(wk1.body?.entries?.some((e) => e.kind === 'fact' && /@worker is waking \(asked by @boss\)/.test(e.body)), 'a fact says who asked');
    const wk2 = await say('/wake @side');
    eq(wk2.body?.status, 'applied', 'the user may wake a resting seat');
    ok(wk2.body?.entries?.some((e) => /@side is waking \(asked by the user\)/.test(e.body)), 'a fact says the user asked');
    /* nothing can launch here (dead broker, no pty): the failure is a FACT, the engine stays up */
    let facts = [];
    for (let i = 0; i < 40 && !facts.some((b) => /@side (could not be woken|was woken)/.test(b)); i++) {
      await sleep(250);
      const d = await call(`/api/rooms/${room.id}`);
      const lines = (await call(`/api/rooms/${room.id}/line`)).body;
      facts = (lines?.entries ?? d.body?.entries ?? []).filter((e) => e.kind === 'fact').map((e) => e.body);
    }
    ok(facts.some((b) => /@side (could not be woken|was woken)/.test(b)), `a wake that cannot launch ends as a fact: ${facts.filter((b) => /@side/.test(b)).join(' | ')}`);
    ok(await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false), 'the engine is still up');
  } catch (e) {
    failed++;
    failures.push(String(e?.stack ?? e));
    console.log(`  X threw: ${e?.stack ?? e}`);
  } finally {
    if (engine) {
      engine.kill('SIGKILL');
      await sleep(200);
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows: the killed engine may still hold the db (EPERM) */ }
  }
  if (failed) {
    console.log('\nengine log (tail):\n' + engineLog.split('\n').slice(-40).join('\n'));
    console.log('\nFAILURES:\n' + failures.map((f) => ' - ' + f).join('\n'));
  }
  console.log(`\nPASS ${passed}  FAIL ${failed}`);
  process.exit(failed ? 1 : 0);
}
run();
