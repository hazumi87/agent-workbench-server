/**
 * STARTER ROOMS THROUGH A REAL LOCAL ENGINE (row 7): POST /api/local/seed builds the template in one transaction, answers the ids, is
 * repeat-safe, refuses with a machine code, and starts NOTHING; and the memory guard's refusal of a start, exactly as the app will see it.
 * SAFETY: Linux only; the engine on port 0 with a DEAD broker port; temp folders; never :7420/:7430/:8200/:8201/:8204.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

if (process.platform !== 'linux') {
  console.log('starter-seed-route.test: Linux only - skipped');
  process.exit(0);
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEAD_BROKER_PORT = P(558);
const HOST = '127.0.0.1';
const TOKEN = 'starter-seed-route-token';
const LF = String.fromCharCode(10);
const MB = 1024 * 1024;
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

async function run() {
  await assertFree(DEAD_BROKER_PORT, 'starter-seed-route.test.mjs');
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-starter-route-'));
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  let engine = null;
  let port = 0;
  let out = '';
  try {
    engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      /* a machine with NO agent program installed: a bare PATH and an empty home (so no install place has `claude`) */
      env: { ...childEnv({
        HARBOR_WB_MODE: 'local',
        HARBOR_WB_TOKEN: TOKEN,
        HARBOR_WB_DATA_DIR: join(tmpDir, 'data'),
        HARBOR_WB_FILES_DIR: join(tmpDir, 'files'),
        HARBOR_WB_MEMORY_CEILING_MB: '0',
        HARBOR_WB_SEAT_WELCOME: '0',
        HARBOR_WB_BROKER_AUTOSTART: '0',
        HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT),
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_NODE: 'testnode',
        HARBOR_WB_TARGETS: TARGETS,
        HARBOR_WB_PROC_ROOT: join(tmpDir, 'noproc'),
      }), PATH: '/usr/bin:/bin', HOME: join(tmpDir, 'home'), USERPROFILE: join(tmpDir, 'home') },
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
    const auth = { authorization: `Bearer ${TOKEN}` };
    const http = async (path, { json, headers = auth, method } = {}) => {
      const init = { method: method ?? (json === undefined ? 'GET' : 'POST'), headers: { ...headers } };
      if (json !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(json);
      }
      const res = await fetch(base + path, init);
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    console.log('\n[refusals carry a machine code and write nothing]');
    const bad1 = await http('/api/local/seed', { json: { template: 'nope', version: 1 } });
    ok(bad1.status === 400 && bad1.body?.code === 'unknown_template' && typeof bad1.body?.error === 'string', 'an unknown template: 400 unknown_template', bad1);
    const bad2 = await http('/api/local/seed', { json: { template: 'my-project', version: 'x' } });
    ok(bad2.status === 400 && bad2.body?.code === 'invalid', 'a bad version: 400 invalid', bad2);
    ok((await http('/api/local/seed', { json: { template: 'my-project', version: 3 }, headers: {} })).status === 401, 'no credential: 401');

    console.log('\n[the first call builds My project]');
    const a = await http('/api/local/seed', { json: { template: 'my-project', version: 3 } });
    ok(a.status === 201 && a.body?.status === 'created' && !!a.body?.room_id, 'created: 201 with the room id', a);
    ok(Object.keys(a.body?.seats ?? {}).length === 11 && Object.keys(a.body?.groups ?? {}).sort().join() === 'build,design,plan,test', 'the answer carries 11 seat ids and 4 group ids');
    const rooms = (await http('/api/rooms')).body;
    const list = Array.isArray(rooms) ? rooms : (rooms?.rooms ?? []);
    ok(list.filter((r) => (r.room ?? r).name === 'My project').length === 1, 'one My project room', list.map((r) => (r.room ?? r).name));

    console.log('\n[a repeat is `already`, with the same ids]');
    const b = await http('/api/local/seed', { json: { template: 'my-project', version: 3 } });
    ok(b.status === 200 && b.body?.status === 'already' && b.body?.room_id === a.body.room_id && JSON.stringify(b.body.seats) === JSON.stringify(a.body.seats), 'repeat: 200 already, same ids', b);
    const [x, y] = await Promise.all([http('/api/local/seed', { json: { template: 'my-first-room', version: 1 } }), http('/api/local/seed', { json: { template: 'my-first-room', version: 1 } })]);
    ok([x, y].map((r) => r.body?.status).sort().join() === 'already,created' && x.body?.room_id === y.body?.room_id, 'two windows at once: one created, one already, one room', [x.body?.status, y.body?.status]);

    ok(!!a.body?.seats?.planner && !!x.body?.seats?.planner && a.body.seats.planner !== x.body.seats.planner && a.body.room_id !== x.body.room_id, 'both templates are in ONE engine, each with its own `planner` (two families): two different seat ids, two room ids');

    console.log('\n[nothing was started]');
    const t = await http('/api/table');
    const rows = Array.isArray(t.body) ? t.body : (t.body?.sessions ?? t.body?.rows ?? []);
    ok(rows.filter((r) => r.state === 'live').length === 0, 'no live session exists after seeding');

    console.log('\n[the room code folder through the real engine (step C)]');
    const gitInfo = await http('/api/git');
    ok(gitInfo.status === 200 && gitInfo.body?.found === true && /^git version/.test(gitInfo.body?.version ?? ''), 'GET /api/git tells the app whether git is there', gitInfo.body);
    ok((await http('/api/git', { headers: {} })).status === 401, '...and needs a credential');
    const codeRoot = join(tmpDir, 'code');
    mkdirSync(join(codeRoot, 'mine'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main', join(codeRoot, 'mine')], { stdio: 'ignore' });
    execFileSync('git', ['-C', join(codeRoot, 'mine'), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'first'], { stdio: 'ignore' });
    const listLen = async () => { const r = await http('/api/rooms'); return (Array.isArray(r.body) ? r.body : []).length; };
    const before = await listLen();
    const badRoom = await http('/api/rooms', { json: { name: 'Bad folder', code_folder: { mode: 'existing', path: join(codeRoot, 'not-there') } }, headers: { cookie } });
    ok(badRoom.status === 400 && badRoom.body?.field === 'path' && (await listLen()) === before, 'creating a room with a folder that does not exist is a 400 naming `path`, and NO room is left behind', badRoom.body);
    const goodRoom = await http('/api/rooms', { json: { name: 'Code room', code_folder: { mode: 'existing', path: join(codeRoot, 'mine') } }, headers: { cookie } });
    ok(goodRoom.status === 200 && !!goodRoom.body?.id, 'creating a room with an existing git folder works', goodRoom.body);
    const det = await http(`/api/rooms/${goodRoom.body.id}`, { headers: { cookie } });
    ok(det.body?.code_folder?.path === join(codeRoot, 'mine') && det.body.code_folder.mode === 'existing' && det.body.code_folder.git === 'repo', 'the room detail carries code_folder {mode, path, git}', det.body?.code_folder);
    const plainRoom = await http('/api/rooms', { json: { name: 'No folder' }, headers: { cookie } });
    const det2 = await http(`/api/rooms/${plainRoom.body.id}`, { headers: { cookie } });
    ok(det2.body?.code_folder === null, 'a room made without one says code_folder null');
    const newRoom = await http('/api/rooms', { json: { name: 'Fresh', code_folder: { mode: 'new', path: join(codeRoot, 'fresh-project') } }, headers: { cookie } });
    ok(newRoom.status === 200 && existsSync(join(codeRoot, 'fresh-project', '.git')), '"new" makes the folder and a git project in it');
    mkdirSync(join(codeRoot, 'plain-files'));
    writeFileSync(join(codeRoot, 'plain-files', 'a.txt'), 'x');
    const put = await http(`/api/rooms/${plainRoom.body.id}/code-folder`, { method: 'PUT', json: { mode: 'existing', path: join(codeRoot, 'plain-files') }, headers: { cookie } });
    ok(put.status === 200 && put.body?.codeFolder?.git === 'not-repo', 'PUT sets it on an existing room; a non-git folder is accepted and reported "not-repo"', put.body);
    ok((await http(`/api/rooms/${plainRoom.body.id}/code-folder`, { method: 'PUT', json: { mode: 'none' } })).status === 403, 'PUT with the shared bearer (not a person) is refused');
    const init = await http(`/api/rooms/${plainRoom.body.id}/code-folder/init`, { json: {}, headers: { cookie } });
    ok(init.status === 200 && init.body?.codeFolder?.git === 'repo' && existsSync(join(codeRoot, 'plain-files', '.git')), 'POST .../init makes the non-git folder a project (the person\'s one-click "make it a project")', init.body);
    ok(existsSync(join(codeRoot, 'plain-files', 'a.txt')), '...and its files are untouched');
    const got = await http(`/api/rooms/${plainRoom.body.id}/code-folder`, { headers: { cookie } });
    ok(got.status === 200 && got.body?.codeFolder?.mode === 'existing', 'GET reads it back');
    ok((await http(`/api/rooms/${plainRoom.body.id}/code-folder`, { method: 'PUT', json: { mode: 'none' }, headers: { cookie } })).body?.codeFolder === null, 'and none clears it');

    console.log('\n[Tasks through the real engine: the person\'s door is a window credential]');
    const rid = a.body.room_id;
    const tk = await http(`/api/rooms/${rid}/tasks`, { json: { title: 'First task', group: 'plan' }, headers: { cookie } });
    ok(tk.status === 200 && tk.body?.task?.group?.alias === 'plan', 'the person adds a task to the Plan group of My project', tk);
    const sum = await http(`/api/rooms/${rid}/tasks/summary`, { headers: { cookie } });
    ok(sum.body?.room?.totalGroups === 5 && sum.body.groups.some((g) => g.alias === 'plan' && g.open === 1), 'the summary covers all five groups and counts the open task', sum.body?.room);
    ok((await http(`/api/rooms/${rid}/tasks`, { json: { title: 'x' } })).status === 403, 'the shared bearer is not a person: refused');
    ok((await http(`/api/rooms/${rid}/tasks`, { headers: {} })).status === 401, 'no credential: 401');

    console.log('\n[a starter seat whose program is not installed is REFUSED, not started as a shell (fb30s)]');
    const lead = a.body.seats['project-lead'];
    const miss = await http(`/api/rooms/${a.body.room_id}/seats/${lead}/start`, { json: {}, headers: { cookie } });
    ok(miss.status === 409 && miss.body?.code === 'vendor-missing' && miss.body?.vendor === 'claude-code' && miss.body?.error === "Claude Code isn't installed" && miss.body?.field === 'vendor', "409 {code:'vendor-missing', vendor, error:\"Claude Code isn't installed\"}", miss);
    const t2 = await http('/api/table');
    ok((Array.isArray(t2.body) ? t2.body : (t2.body?.sessions ?? t2.body?.rows ?? [])).filter((r) => r.state === 'live').length === 0, 'and nothing was started: no live pane');
    const seatAfter = (await http(`/api/rooms/${a.body.room_id}`, { headers: { cookie } })).body?.seats?.find((x) => x.id === lead);
    ok(!!seatAfter && !seatAfter.left_at, '...the seat is still there, startable');

    console.log('\n[the causes feed: the refusal above, as one fixed code]');
    const cz = await http('/api/local/causes?since=0');
    const ev = cz.body?.events?.find((e) => e.kind === 'seat-start' && e.code === 'vendor-missing');
    ok(cz.status === 200 && !!ev && ev.vendor === 'claude-code' && ev.handle === 'project-lead' && typeof cz.body.next === 'number' && cz.body.gap === false, 'GET /api/local/causes shows seat-start / vendor-missing with the vendor and handle', cz.body);
    ok(!JSON.stringify(cz.body).match(/claude --|session-id|[A-Za-z]:|\/home\//), 'and carries no command line, no path');
    ok((await http(`/api/local/causes?since=${cz.body.next}`)).body?.events?.length === 0, 'since=next: nothing new');
    ok((await http('/api/local/causes', { headers: {} })).status === 401, 'unauthenticated: 401');

    console.log('\n[a start the memory guard declines, exactly as the app sees it]');
    const seatId = Object.values(a.body.seats)[0];
    const roomOfSeat = a.body.room_id;
    const report = (usedMb, freeMb, capMb) => http('/api/local/memory', { json: { usedBytes: usedMb * MB, residentBytes: usedMb * MB, freeBytes: freeMb * MB, jobCapBytes: capMb * MB } });
    ok((await report(1800, 8000, 2048)).body?.level === 'refuse', 'the supervisor reports 88%: refuse');
    const s = await http(`/api/rooms/${roomOfSeat}/seats/${seatId}/start`, { json: {}, headers: { cookie } });
    ok(s.status === 409 && s.body?.field === 'memory' && s.body?.error === 'agents are using too much memory to start another: 1800 MB of 2048 MB in use (88%), the limit is 85%. Sleep or end an agent, then try again.', `a refused start: HTTP 409 {error, field:"memory"}: ${s.body?.error}`, s);
    ok((await http('/api/local/memory')).body?.numbers === '1800 MB of 2048 MB in use (88%)', 'GET /api/local/memory carries the numbers alone');
  } catch (e) {
    failed++;
    console.log(`  X harness: ${e?.stack ?? e}`);
  } finally {
    if (engine && engine.exitCode === null) engine.kill('SIGKILL');
    await sleep(300);
    rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log(`\nPASS ${passed} FAIL ${failed}`);
  process.exit(failed ? 1 : 0);
}
run();
