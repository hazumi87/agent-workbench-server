/**
 * EFFORT + PER-LAUNCH OVERRIDES through a real scratch engine (2026-09-28):
 * POST /api/recipes stores / validates / preserves `effort`; POST
 * /api/recipes/:id/launch and POST /api/rooms/:id/seats/:seatId/start accept
 * {model?, effort?} overrides (a 400 for an unknown effort, never a silent
 * fallback) and carry them on the solo path the window attaches with; a seat
 * start with `resumeSessionId` goes through the launch route's picker-resume
 * door. The command line itself is effort.test.ts (pure).
 *
 * Same pattern as rooms-roster.test.mjs: our own engine on P(190), a DEAD
 * broker P(191), a temp db seeded through the store, NO pty — every launch is
 * placed as a BROWSER tab, which answers the paneid and path without opening
 * anything. childEnv() scrubbed; fabric + NATS off; the temp dir is removed.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv, windowCookie, roomUserWrite } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(190);
const DEAD_BROKER_PORT = P(191);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'recipe-effort-routes-test-token';
const UUID = '0f1ce196-c180-4547-9e7b-4c5f1f4714a3';

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
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, `${msg} (got ${a}${a === b ? '' : `, wanted ${b}`})`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let userCookie = '';
async function call(path, opts = {}) {
  const m = opts.method ?? (opts.json !== undefined ? 'POST' : 'GET');
  const headers = userCookie && roomUserWrite(path, m, opts.json) ? { cookie: userCookie } : { authorization: `Bearer ${TOKEN}` };
  const init = { method: m, headers };
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.json);
  }
  const res = await fetch(BASE + path, init);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not json */
  }
  return { status: res.status, body };
}
const post = (path, json) => call(path, { json });

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
    await assertFree(p, 'recipe-effort-routes.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-recipe-effort-'));
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
    const pre = await seed({
      recipes: [
        { id: 'rec-e', name: 'Echo', projectDir: '/srv/x/echo', vendor: 'claude-code', agent: 'echo', model: 'sonnet', effort: 'low' },
        { id: 'rec-g', name: 'Golf', projectDir: '/srv/x/golf', vendor: 'claude-code', agent: 'golf' },
      ],
      rooms: [{ name: 'Effort', seats: [{ handle: 'e1', recipe_id: 'rec-e' }, { handle: 'e2', recipe_id: 'rec-e' }, { handle: 'e3', recipe_id: 'rec-e' }, { handle: 'e4', recipe_id: 'rec-g' }] }],
    });
    const room = pre.rooms[0];
    const S = room.seats;

    console.log(`booting scratch engine :${PORT} (dead broker :${DEAD_BROKER_PORT})`);
    const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
    engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: HOST, HARBOR_WB_TABLE: dbPath, HARBOR_WB_TOKEN: TOKEN,
        HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'), HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_NO_WINDOW: '1',
        HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_ROOM_FABRIC: '0', HARBOR_WB_BROKER_AUTOSTART: '0',
        HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT), HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
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
    userCookie = await windowCookie(BASE, TOKEN);
    const recipeOf = async (id) => (await call('/api/recipes')).body.recipes.find((r) => r.id === id);

    console.log('\n[POST /api/recipes: effort]');
    eq((await recipeOf('rec-e'))?.effort, 'low', 'a seeded effort reads back on GET /api/recipes');
    eq((await recipeOf('rec-g'))?.effort, null, 'no effort = null (Default)');
    const base = { id: 'rec-g', name: 'Golf', target: 'local', projectDir: '/srv/x/golf', vendor: 'claude-code', agent: 'golf' };
    let r = await post('/api/recipes', { ...base, effort: 'xhigh' });
    eq([r.status, r.body?.recipe?.effort], [200, 'xhigh'], 'save effort xhigh');
    r = await post('/api/recipes', { ...base, effort: 'ultracode' });
    eq([r.status, r.body?.recipe?.effort], [200, 'ultracode'], 'ultracode is accepted');
    r = await post('/api/recipes', { ...base, effort: 'extreme' });
    eq([r.status, r.body?.field], [400, 'effort'], 'an unknown effort: 400 naming field effort');
    eq(r.body?.allowed, ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'], '...and the allowed list');
    eq((await recipeOf('rec-g'))?.effort, 'ultracode', 'a refused save changed nothing');
    r = await post('/api/recipes', { ...base, model: 'opus' });
    eq([r.status, r.body?.recipe?.effort, r.body?.recipe?.model], [200, 'ultracode', 'opus'], 'effort ABSENT from the body keeps the stored value (an older client cannot wipe it)');
    r = await post('/api/recipes', { ...base, effort: null });
    eq(r.body?.recipe?.effort, null, 'effort null clears it (Default)');
    r = await post('/api/recipes', { ...base, effort: 'max' });
    r = await post('/api/recipes', { ...base, effort: '' });
    eq(r.body?.recipe?.effort, null, "effort '' clears it too");
    r = await post('/api/recipes', { ...base, resume: false, resumeName: '' });
    eq([r.body?.recipe?.resume, r.body?.recipe?.resumeName], [0, null], "the form's legacy-resume Clear (resume false, resumeName '') clears both");

    console.log('\n[POST /api/recipes/:id/launch: overrides]');
    const tab = { target: 'tab', surface: 'browser' };
    const l1 = await post('/api/recipes/rec-e/launch', { ...tab, fresh: true, model: 'opus', effort: 'max' });
    eq(l1.status, 200, 'fresh + model + effort: 200');
    eq(l1.body?.path, `/solo.html?recipe=rec-e&pane=${encodeURIComponent(l1.body?.paneid)}&model=opus&effort=max`, 'the solo path carries BOTH overrides (the attach sends them back)');
    const l2 = await post('/api/recipes/rec-e/launch', { ...tab, fresh: true, effort: 'high' });
    eq(l2.body?.path, `/solo.html?recipe=rec-e&pane=${encodeURIComponent(l2.body?.paneid)}&effort=high`, 'effort alone');
    const l3 = await post('/api/recipes/rec-e/launch', { ...tab, fresh: true, effort: 'bogus' });
    eq([l3.status, l3.body?.field], [400, 'effort'], 'an unknown effort override: 400, not a plain launch');
    const l4 = await post('/api/recipes/rec-e/launch', { ...tab, fresh: true, effort: '' });
    eq([l4.status, /effort=/.test(l4.body?.path ?? '')], [200, false], "effort '' = the recipe default (no override on the path)");
    eq((await recipeOf('rec-e'))?.effort, 'low', 'overrides are NEVER written back to the recipe (effort)');
    eq((await recipeOf('rec-e'))?.model, 'sonnet', '...nor the model');
    const pk = await post('/api/recipes/rec-e/launch', { ...tab, resumeSessionId: UUID, effort: 'medium' });
    eq(pk.status, 200, 'the picker door with an effort override: 200');
    eq(pk.body?.path, '/solo.html?recipe=rec-e&effort=medium', 'a picker resume carries the override too (the primary pane: no &pane=)');

    console.log('\n[POST /api/rooms/:id/seats/:seatId/start: overrides + resume]');
    const s1 = await post(`/api/rooms/${room.id}/seats/${S.e1}/start`, { ...tab, model: 'opus', effort: 'high' });
    eq(s1.status, 200, 'seat start with {model, effort}: 200');
    ok(/^recipe:rec-e#[0-9a-f]{8}$/.test(s1.body?.paneid ?? ''), 'a FRESH pane, as a plain start');
    eq(s1.body?.path, `/solo.html?recipe=rec-e&pane=${encodeURIComponent(s1.body?.paneid)}&model=opus&effort=high`, 'the answer path carries both overrides');
    eq(JSON.parse(s1.body?.entries?.[0]?.meta ?? '{}').mode, 'fresh', 'fact meta.mode fresh');
    const s2bad = await post(`/api/rooms/${room.id}/seats/${S.e2}/start`, { ...tab, effort: 'huge' });
    eq([s2bad.status, s2bad.body?.field], [400, 'effort'], 'an unknown effort: 400 naming field effort');
    const s2m = await post(`/api/rooms/${room.id}/seats/${S.e2}/start`, { ...tab, model: 'op us' });
    eq([s2m.status, s2m.body?.field], [400, 'model'], 'a malformed model: 400 naming field model');
    const s2id = await post(`/api/rooms/${room.id}/seats/${S.e2}/start`, { ...tab, resumeSessionId: 'not-a-uuid' });
    eq([s2id.status, s2id.body?.field], [400, 'resumeSessionId'], 'a malformed resumeSessionId: 400');
    const s2both = await post(`/api/rooms/${room.id}/seats/${S.e2}/start`, { ...tab, resumeSessionId: UUID, fresh: true });
    eq([s2both.status, s2both.body?.field], [400, 'fresh'], 'fresh + resumeSessionId: 400 (a resume is not a new session)');
    const occ = (await call(`/api/rooms/${room.id}`)).body.seats.find((x) => x.handle === 'e2')?.occupant;
    ok(!occ?.id, 'every refusal left the seat never-started');
    const s2 = await post(`/api/rooms/${room.id}/seats/${S.e2}/start`, { ...tab, resumeSessionId: UUID, effort: 'max' });
    eq(s2.status, 200, 'seat start resuming a picked session: 200');
    eq(s2.body?.paneid, 'recipe:rec-e', 'the picker door: the transcript has no pane yet and the primary is not live, so the primary (as the manager picker does)');
    eq(s2.body?.path, '/solo.html?recipe=rec-e&effort=max', '...its path, with the effort override');
    eq(JSON.parse(s2.body?.entries?.[0]?.meta ?? '{}').mode, 'rehydrate', 'fact meta.mode rehydrate');
    const rows = await seed({ read: ['recipe:rec-e'] });
    eq([rows.rows?.[0]?.session_id, rows.rows?.[0]?.state], [UUID, 'dehydrated'], 'the pane banks the picked uuid, dehydrated: the attach runs --resume <uuid>');
    ok(engineLog.includes(`@e2 started (resume ${UUID.slice(0, 8)})`), 'the engine logs a resume start');
    ok(engineLog.includes(`launch: "Echo" — picker resume of ${UUID}`), 'through the launch route\'s picker-resume door');
    const s3 = await post(`/api/rooms/${room.id}/seats/${S.e3}/start`, { ...tab, resumeSessionId: UUID });
    eq([s3.status, s3.body?.field], [409, 'seat'], 'a second seat asking for the SAME transcript: the picker door resolves to the pane that banks it, which @e2 holds -> 409 (never a second pane on one file)');
    ok(/already holds @e2/.test(s3.body?.error ?? ''), '...saying which seat holds it');
    const s4 = await post(`/api/rooms/${room.id}/seats/${S.e4}/start`, tab);
    eq(s4.body?.path, `/solo.html?recipe=rec-g&pane=${encodeURIComponent(s4.body?.paneid)}`, 'no overrides: the plain path, unchanged');

    console.log('\n[PATCH /api/sessions/:paneid/profile]');
    await seed({ sessions: [{ paneid: 'recipe:rec-e#p1', recipe_id: 'rec-e', vendor: 'claude-code', state: 'dehydrated' }, { paneid: 'recipe:rec-e#p2', recipe_id: 'rec-e', vendor: 'claude-code', state: 'dehydrated', profile: { model: 'opus', effort: 'high' } }] });
    const patch = (pane, json, cookie = userCookie) =>
      fetch(`${BASE}/api/sessions/${encodeURIComponent(pane)}/profile`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : { authorization: `Bearer ${TOKEN}` }) }, body: JSON.stringify(json) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) }));
    r = await patch('recipe:rec-e#p1', { effort: 'max' }, '');
    eq([r.status, r.body?.field], [403, 'credential'], 'a bearer (an agent) is refused: person cookie only');
    r = await patch('recipe:nope', { effort: 'max' });
    eq(r.status, 404, 'an unknown pane: 404');
    r = await patch('recipe:rec-e#p1', { effort: 'extreme' });
    eq([r.status, r.body?.field], [400, 'effort'], 'an unknown effort: 400 naming the field');
    r = await patch('recipe:rec-e#p1', { model: 'op us' });
    eq([r.status, r.body?.field], [400, 'model'], 'a malformed model: 400');
    r = await patch('recipe:rec-e#p1', { effort: 'max' });
    eq([r.status, r.body?.profile], [200, { model: 'sonnet', effort: 'max' }], 'a row with no profile fills the other half from the recipe default (sonnet)');
    r = await patch('recipe:rec-e#p1', { model: 'fable' });
    eq(r.body?.profile, { model: 'fable', effort: 'max' }, 'an absent key keeps its stored value');
    r = await patch('recipe:rec-e#p1', { model: '', effort: '' });
    eq(r.body?.profile, { model: null, effort: null }, "'' clears both to default");
    const tbl = (await call('/api/table')).body;
    const rowsOf = Array.isArray(tbl) ? tbl : (tbl?.rows ?? tbl?.sessions ?? []);
    eq(rowsOf.find((x) => x.paneid === 'recipe:rec-e#p2')?.profile, { model: 'opus', effort: 'high' }, '/api/table rows carry profile');
    const occ2 = (await call(`/api/rooms/${room.id}`)).body.seats.find((x) => x.handle === 'e2')?.occupant;
    ok(occ2 === undefined || occ2 === null || 'profile' in occ2, 'a seat occupant carries profile');

    console.log('\n[codex-cli: per-vendor effort, vendorArgs, the agent hook sink] (Owner 2026-10-03)');
    const cbase = { id: 'rec-cx', name: 'Codexy', target: 'local', projectDir: '/srv/x/codexy', vendor: 'codex-cli', agent: 'codexy' };
    r = await post('/api/recipes', { ...cbase, model: 'gpt-6-astra', effort: 'xhigh' });
    eq([r.status, r.body?.recipe?.effort, r.body?.recipe?.vendorArgs], [200, 'xhigh', null], 'a codex recipe takes a codex effort word; no vendorArgs = null');
    r = await post('/api/recipes', { ...cbase, effort: 'ultracode' });
    eq([r.status, r.body?.field], [400, 'effort'], "claude's ultracode is refused on a codex recipe");
    ok(!r.body?.allowed?.includes('minimal') && !r.body?.allowed?.includes('ultracode') && r.body?.allowed?.includes('max'), '...with the CODEX allowed list (low..max, Owner 2026-10-05)');
    r = await post('/api/recipes', { ...cbase, effort: 'minimal' });
    eq([r.status, r.body?.field], [400, 'effort'], "...and minimal is refused on a codex recipe (the GPT-6 models refuse it)");
    r = await post('/api/recipes', { ...cbase, vendorArgs: ['-c', 'sandbox_workspace_write.network_access=true'] });
    eq([r.status, r.body?.recipe?.vendorArgs], [200, ['-c', 'sandbox_workspace_write.network_access=true']], 'vendorArgs saved as a list');
    eq((await recipeOf('rec-cx'))?.vendorArgs, ['-c', 'sandbox_workspace_write.network_access=true'], '...and read back on GET');
    r = await post('/api/recipes', { ...cbase, model: 'gpt-5.5' });
    eq(r.body?.recipe?.vendorArgs, ['-c', 'sandbox_workspace_write.network_access=true'], 'vendorArgs ABSENT keeps the stored value');
    r = await post('/api/recipes', { ...cbase, vendorArgs: 'a=1\n\nb=2' });
    eq(r.body?.recipe?.vendorArgs, ['a=1', 'b=2'], 'a string is one argument per line (the form)');
    r = await post('/api/recipes', { ...cbase, vendorArgs: ['ok', 'two\nlines'] });
    eq([r.status, r.body?.field], [400, 'vendorArgs'], 'a newline inside an argument: 400 naming vendorArgs');
    r = await post('/api/recipes', { ...cbase, vendorArgs: [1] });
    eq([r.status, r.body?.field], [400, 'vendorArgs'], 'non-strings: 400');
    eq((await recipeOf('rec-cx'))?.vendorArgs, ['a=1', 'b=2'], 'a refused save changed nothing');
    r = await post('/api/recipes', { ...cbase, vendorArgs: null });
    eq(r.body?.recipe?.vendorArgs, null, 'null clears it');
    const cl = await post('/api/recipes/rec-cx/launch', { ...tab, fresh: true, effort: 'xhigh' });
    eq(cl.status, 200, 'a codex launch override with a codex word: 200');
    const cl2 = await post('/api/recipes/rec-cx/launch', { ...tab, fresh: true, effort: 'ultracode' });
    eq([cl2.status, cl2.body?.field], [400, 'effort'], "...and claude's word: 400");
    const hook = (qs, headers = {}) => fetch(`${BASE}/api/agent-hook${qs}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ session_id: UUID, hook_event_name: 'Stop' }) });
    let hr = await hook('?vendor=codex-cli&paneid=recipe:nope');
    eq([hr.status, (await hr.json()).matched], [200, null], 'agent-hook, loopback with NO credential: 200, no match (exempt like claude-hook)');
    hr = await hook('?vendor=codex-cli&paneid=recipe:nope', { 'x-forwarded-for': '100.64.0.9' });
    eq(hr.status, 401, 'agent-hook behind Serve (x-forwarded-for): 401, not exempt');
    hr = await fetch(`${BASE}/api/agent-hook?vendor=codex-cli&paneid=x`);
    ok(hr.status === 401 || hr.status === 404, `agent-hook GET: not a free read (${hr.status})`);
  } catch (e) {
    failed++;
    failures.push(String(e?.stack ?? e));
    console.log(`  ✗ threw: ${e?.stack ?? e}`);
  } finally {
    if (engine) {
      engine.kill('SIGKILL');
      await sleep(200);
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* Windows EPERM on a just-killed engine's db: leave the temp dir */
    }
  }
  if (failed) {
    console.log('\nengine log (tail):\n' + engineLog.split('\n').slice(-40).join('\n'));
    console.log('\nFAILURES:\n' + failures.map((f) => ' - ' + f).join('\n'));
  }
  console.log(`\nPASS ${passed}  FAIL ${failed}`);
  process.exit(failed ? 1 : 0);
}

run();
