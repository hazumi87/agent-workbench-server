/**
 * LEAD RESTART OF A SEAT through a real scratch engine (design [ref], Owner [ref]/[ref]). The pure rules are
 * test/seat-restart.test.ts; this proves the doors: `/seat restart @x`, `/seat restart all`, `/seat restart stop`, the
 * setting, and the guards, with the room lead (a seat) and the person asking.
 *
 * SAFETY: scratch engine P(346), dead broker P(347); childEnv(); temp dir removed. Nothing can launch here (dead broker),
 * so a restart ends as a fact, never a crash; the memory guard reads a file this test writes (HARBOR_WB_MEMINFO).
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(346);
const DEAD_BROKER_PORT = P(347);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'seat-restart-test-token';

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
    await assertFree(p, 'seat-restart-routes.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-seat-restart-'));
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
      recipes: [recipe('boss', 'Boss', 'claude-code'), recipe('worker', 'Worker', 'claude-code'), recipe('side', 'Side', 'claude-code'), recipe('mem', 'Mem', 'claude-code'), recipe('plain', 'Plain', 'claude-code')],
      sessions: [sess(1, 'boss', 'dehydrated'), sess(1, 'worker', 'killed'), sess(1, 'side', 'dehydrated'), sess(1, 'mem', 'dehydrated'), sess(1, 'plain', 'killed')],
      rooms: [
        {
          name: 'Restart',
          seats: [
            { handle: 'boss', recipe_id: 'boss', occupant: 'recipe:boss#1' }, // the first seat leads
            { handle: 'worker', recipe_id: 'worker', occupant: 'recipe:worker#1' },
            { handle: 'side', recipe_id: 'side', occupant: 'recipe:side#1' },
            { handle: 'mem', recipe_id: 'mem', occupant: 'recipe:mem#1' },
            { handle: 'plain', recipe_id: 'plain', occupant: 'recipe:plain#1' },
          ],
        },
      ],
    });
    const room = pre.rooms[0];
    const meminfo = (availKb, swapFreeKb = 6000000) => writeFileSync(join(tmpDir, 'meminfo'), `MemTotal: 32000000 kB\nMemAvailable: ${availKb} kB\nSwapTotal: 8000000 kB\nSwapFree: ${swapFreeKb} kB\n`);
    meminfo(20000000);
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
        HARBOR_WB_MEMINFO: join(tmpDir, 'meminfo'),
        HARBOR_WB_RESTART_ALL_GAP_MS: '1500',
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
    /* live rows seeded before boot are reconciled away at boot; the lead and one member are live from here on */
    await seed({ sessions: [sess(1, 'boss', 'live'), sess(1, 'mem', 'live')] });

    const say = (text) => call(`/api/rooms/${room.id}/line`, { json: { text } });
    const asBoss = (text) => call(`/api/rooms/${room.id}/line`, { json: { text, from: { paneid: 'recipe:boss#1' } }, as: 'agent' });
    const asMem = (text) => call(`/api/rooms/${room.id}/line`, { json: { text, from: { paneid: 'recipe:mem#1' } }, as: 'agent' });
    const facts = async () => ((await call(`/api/rooms/${room.id}/line?limit=200`)).body?.entries ?? []).filter((e) => e.kind === 'fact').map((e) => e.body);
    const refusedWith = (r, re) => r.body?.status === 'refused' && re.test(r.body?.refused?.error ?? '');

    console.log('\n[/set store: the file store address, set by the person]');
    if (process.env.WB_TEST_LOCAL_MODE === '1') {
      /* local mode: the store is the person's files folder, so an address is refused (not saved and silently ignored) */
      const fs0 = (await call('/api/rooms/file-store', { as: 'agent' })).body;
      ok(fs0?.configured === true && fs0?.source === 'folder', 'local mode: the file store is the files folder');
      ok(refusedWith(await say('/set store http://127.0.0.1:9'), /files folder/), 'local mode: /set store is refused with a plain reason');
      ok(refusedWith(await say('/set store default'), /files folder/), 'local mode: so is /set store default (nothing to clear)');
    } else {
      eq((await call('/api/rooms/file-store', { as: 'agent' })).body, { configured: false, source: 'none', base: null }, 'nothing set: not configured');
      ok(refusedWith(await asBoss('/set store http://127.0.0.1:9'), /room commands come from the user/), 'a seat (even the lead) may not set it');
      ok(refusedWith(await say('/set store ftp://files.example'), /must start with http/), 'a non-http address is refused');
      const st = await say('/set store http://127.0.0.1:9///');
      eq(st.body?.status, 'applied', 'the person sets it');
      ok(st.body?.entries?.some((e) => e.body === 'the room file store is now http://127.0.0.1:9'), 'a fact says so, trailing slashes trimmed');
      eq((await call('/api/rooms/file-store', { as: 'agent' })).body, { configured: true, source: 'setting', base: 'http://127.0.0.1:9' }, 'status reads it back, source setting');
      const att = await call(`/api/rooms/${room.id}/assets`, { as: 'agent' });
      ok(att.status !== 404 && !/not set up/.test(JSON.stringify(att.body ?? '')), `the assets route no longer answers "not set up" (got ${att.status} ${JSON.stringify(att.body).slice(0, 90)})`);
      const cl = await say('/set store default');
      ok(cl.body?.entries?.some((e) => /address was cleared/.test(e.body)), 'default clears it');
      eq((await call('/api/rooms/file-store', { as: 'agent' })).body?.configured, false, 'and the status says not configured again');

    }

    console.log('\n[help lists it]');
    const cmds = (await call('/api/rooms/commands', { as: 'agent' })).body?.commands ?? [];
    ok(['/seat restart @<handle>', '/seat restart all', '/seat restart stop', '/floor take', '/floor skip @<handle>', '/set turn <minutes|default>'].every((u) => cmds.some((c) => c.usage === u && c.class === 'executed')), '/help (GET /api/rooms/commands) lists /seat restart, /floor and /set turn');

    console.log('\n[the setting]');
    eq((await call('/api/rooms/seat-restart', { as: 'agent' })).body, { leadsRestartMembers: true }, 'default ON, any credential reads it');
    eq((await call('/api/rooms/seat-restart', { as: 'none' })).status, 401, 'no credential: 401');
    eq((await call('/api/rooms/seat-restart', { method: 'PATCH', json: { leadsRestartMembers: false }, as: 'agent' })).status, 403, 'PATCH by a bearer: 403 (a person decides)');
    eq((await call('/api/rooms/seat-restart', { method: 'PATCH', json: { leadsRestartMembers: 'no' } })).status, 400, 'a non-boolean: 400');
    eq((await call('/api/rooms/seat-restart', { method: 'PATCH', json: { nope: 1 } })).status, 400, 'an unknown key: 400');

    console.log('\n[who may, and which seats]');
    ok(refusedWith(await asMem('/seat restart @worker'), /room commands come from the user/), 'a plain member may not');
    ok(refusedWith(await asBoss('/seat restart @mem'), /@mem is live; end it first/), 'the lead: a live seat is refused with "end it first"');
    ok(refusedWith(await say('/seat restart @mem'), /is live/), 'the person: a live seat is refused too');
    ok(refusedWith(await say('/seat restart @nobody'), /./), 'an unknown handle is refused');
    const r1 = await asBoss('/seat restart @worker');
    eq(r1.body?.status, 'applied', 'the lead restarts a killed member');
    let fs = await facts();
    ok(fs.some((b) => /^@worker is restarting \(asked by @boss; (a fresh start|resuming its conversation)/.test(b)), `a fact says who asked and how: ${fs.filter((b) => /@worker/.test(b)).join(' | ')}`);
    for (let i = 0; i < 40 && !(await facts()).some((b) => /@worker (could not be woken|was woken)/.test(b)); i++) {
      await sleep(250);
    }
    ok((await facts()).some((b) => /@worker (could not be woken|was woken)/.test(b)), 'no broker here: the restart ends as a fact, the engine stays up');
    ok(refusedWith(await asBoss('/seat restart @worker'), /min ago; one restart per seat per 10 min/), 'the lead: a second restart of the same seat is refused with the wait');
    eq((await say('/seat restart @worker')).body?.status, 'applied', 'the person is not rate limited');
    const rs = await asBoss('/seat restart @side');
    eq(rs.body?.status, 'applied', 'the lead restarts a dehydrated (resting) member');
    ok((await facts()).some((b) => /^@side is restarting \(asked by @boss; resuming its conversation/.test(b)), 'a resting seat comes back with its conversation');
    ok(refusedWith(await asBoss('/seat restart @boss'), /is live|only the user restarts the room lead/), 'the lead cannot restart itself');

    console.log('\n[the memory guard]');
    if (process.env.WB_TEST_LOCAL_MODE === '1') {
      /* LOCAL MODE: the app supervisor measures and POSTs; the engine decides at 85% (and ignores /proc/meminfo, which says nothing on Windows) */
      const MB = 1024 * 1024;
      const report = (usedMb, freeMb, capMb) => call('/api/local/memory', { json: { usedBytes: usedMb * MB, freeBytes: freeMb * MB, jobCapBytes: capMb === null ? null : capMb * MB } });
      eq((await call('/api/local/memory')).body?.level, 'unknown', 'nothing reported yet: the engine says so (unknown), it does not guess');
      eq((await report(1024, 8000, 2048)).body?.level, 'ok', '50% of the job cap: ok');
      eq((await report(1800, 8000, 2048)).body?.level, 'refuse', '88% of the job cap: refuse');
      const refusedMem = await asBoss('/seat restart @plain');
      ok(refusedWith(refusedMem, /too much memory to start another: 1800 MB of 2048 MB in use \(88%\)/), `a restart is refused with the numbers (${refusedMem.body?.refused?.error ?? JSON.stringify(refusedMem.body).slice(0, 120)})`);
      eq((await call('/api/local/memory', { json: { usedBytes: 'x' } })).status, 400, 'a malformed report is a 400');
      eq((await report(100, 8000, 2048)).body?.level, 'ok', 'room again: ok');
      meminfo(1500000);
      ok(!refusedWith(await say('/seat restart @worker'), /short of memory|too much memory/), 'and a restart is not refused for memory, with /proc/meminfo saying 1.4 GB (it is not consulted in local mode)');
      meminfo(20000000);
    } else {
    meminfo(1500000);
    ok(refusedWith(await asBoss('/seat restart @plain'), /short of memory \(1464 MB available/), 'low memory: refused, with the number');
    meminfo(20000000, 600000);
    ok(refusedWith(await asBoss('/seat restart @plain'), /swapping heavily \(93%/), 'heavy swap: refused, with the percentage');
    meminfo(20000000);
    }

    console.log('\n[the setting off]');
    eq((await call('/api/rooms/seat-restart', { method: 'PATCH', json: { leadsRestartMembers: false } })).body, { leadsRestartMembers: false }, 'the person turns it off');
    ok(refusedWith(await asBoss('/seat restart @plain'), /"Leads can restart members" is off/), 'the lead is refused and the refusal names the setting');
    eq((await call('/api/rooms/seat-restart', { as: 'agent' })).body, { leadsRestartMembers: false }, 'it persists');
    await call('/api/rooms/seat-restart', { method: 'PATCH', json: { leadsRestartMembers: true } });

    console.log('\n[restart all, one at a time, and stop]');
    ok(refusedWith(await say('/seat restart stop'), /no \/seat restart all is running/), 'stop with nothing running: refused');
    const all = await say('/seat restart all');
    eq(all.body?.status, 'applied', 'the person: restart all');
    ok(all.body?.entries?.some((e) => /^restarting 3 seats one at a time, 2 s apart \(asked by the user\): @worker, @side, @plain\. \/seat restart stop ends it$/.test(e.body)), `the plan is a fact: ${all.body?.entries?.map((e) => e.body).join(' | ')}`);
    ok(refusedWith(await say('/seat restart all'), /already running/), 'a second all while one runs: refused');
    await sleep(600);
    const stop = await say('/seat restart stop');
    eq(stop.body?.status, 'applied', 'stop ends it');
    await sleep(3500);
    fs = await facts();
    ok(fs.some((b) => /^@worker is restarting \(asked by the user/.test(b)), 'the first seat was restarted');
    ok(!fs.some((b) => /^@plain is restarting \(asked by the user/.test(b)), 'and stop kept the last one from starting');
    ok(fs.some((b) => /seat restart queue was stopped/.test(b)), 'a fact says the queue was stopped');
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
