/**
 * LOCAL MODE START (lead ruling 16286). No desktop window exists to be the viewer that spawns a started seat's pane, and /term is
 * reattach-only, so the engine spawns the pane itself when a seat is started:
 *   - Start on the seeded seat, with NO pre-attached pane, creates exactly one live pane (and the answer's url carries the real port);
 *   - a second Start does not (409 "already has a live occupant");
 *   - the app's /term grant then joins that pane (pane.* events);
 *   - a seat with no recipe, and a broker that is down, fail with a plain reason (never a 200 with no pane);
 *   - the seat's Disconnect ends the pane;
 *   - an engine started with HARBOR_WB_DESKTOP=loopback and no HARBOR_WB_NO_WINDOW still opens nothing (placement 'browser').
 *
 * SAFETY: Linux only; LIVE scratch broker P(557); the engine on port 0; temp folders; never :7420/:7430/:8200/:8201/:8204.
 */
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

if (process.platform !== 'linux') {
  console.log('local-mode-start.test: Linux only - skipped');
  process.exit(0);
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BROKER_PORT = P(557);
const HOST = '127.0.0.1';
const TOKEN = 'local-start-test-token';
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
  await assertFree(BROKER_PORT, 'local-mode-start.test.mjs');
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-local-start-'));
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  let broker = null;
  let engine = null;
  let port = 0;
  let out = '';
  const startBroker = async () => {
    broker = spawn(process.execPath, ['--import', loaderArg, 'node_modules/pty-broker/src/main.ts'], { cwd: REPO_ROOT, env: childEnv({ PTY_BROKER_PORT: String(BROKER_PORT) }) });
    broker.stdout.on('data', () => {});
    broker.stderr.on('data', () => {});
    return until(() => fetch(`http://${HOST}:${BROKER_PORT}/health`).then((r) => r.status < 500).catch(() => false), 30000);
  };

  try {
    ok(await startBroker(), 'a LIVE scratch broker is up');
    /* HARBOR_WB_DESKTOP=loopback is DELIBERATE and HARBOR_WB_NO_WINDOW is NOT set: local mode must force the desktop off by itself */
    engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_MODE: 'local',
        HARBOR_WB_TOKEN: TOKEN,
        HARBOR_WB_DATA_DIR: join(tmpDir, 'data'),
        HARBOR_WB_FILES_DIR: join(tmpDir, 'files'),
        HARBOR_WB_MEMORY_CEILING_MB: '0',
        HARBOR_WB_SEAT_WELCOME: '0',
        HARBOR_WB_DESKTOP: 'loopback',
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
    const liveRows = async () => {
      const t = await http('/api/table', { headers: { authorization: `Bearer ${TOKEN}` } });
      const rows = Array.isArray(t.body) ? t.body : (t.body?.sessions ?? t.body?.rows ?? []);
      return rows.filter((r) => r.state === 'live');
    };

    const recipes = (await http('/api/recipes', { headers: { authorization: `Bearer ${TOKEN}` } })).body?.recipes ?? [];
    ok(recipes.length === 1 && recipes[0].id === 'seed-shell', 'the seeded recipe is there', recipes.map((r) => r.id));
    const room = (await http('/api/rooms', { json: { name: 'Start' }, headers: { cookie } })).body;
    const seat = (await http(`/api/rooms/${room.id}/seats`, { json: { recipe_id: 'seed-shell', handle: 'shell', policy: 'persistent' }, headers: { cookie } })).body;
    const seatId = seat?.seat?.id ?? seat?.id;
    ok(!!seatId, 'a seat on the seeded recipe, no pane yet', seat);
    ok((await liveRows()).length === 0, 'no pane exists before Start');

    /* ---- Start (an EMPTY body: what the page sends, no target and no surface) ---- */
    const s1 = await http(`/api/rooms/${room.id}/seats/${seatId}/start`, { json: {}, headers: { cookie } });
    ok(s1.status === 200 && typeof s1.body?.paneid === 'string', `Start on the seeded seat answers 200 with a paneid (${s1.status} ${(s1.body?.message ?? s1.body?.error) ?? ''})`, s1.status);
    ok(s1.body?.placement === 'browser', 'and opened NO window although HARBOR_WB_DESKTOP=loopback was set (placement browser)', s1.body?.placement);
    ok(String(s1.body?.url ?? '').startsWith(`http://${HOST}:${port}/`), 'the url the engine hands out carries the REAL bound port, not 7420 or 0', s1.body?.url);
    const live1 = await until(async () => ((await liveRows()).length === 1 ? await liveRows() : null), 15000);
    ok(live1 && live1.length === 1 && live1[0].paneid === s1.body.paneid, 'exactly ONE live pane exists, with no viewer attached', live1?.map((r) => r.paneid));

    const s2 = await http(`/api/rooms/${room.id}/seats/${seatId}/start`, { json: {}, headers: { cookie } });
    ok(s2.status === 409, `a second Start does not start another (${s2.status}: ${(s2.body?.message ?? s2.body?.error) ?? ''})`, s2.status);
    ok((await liveRows()).length === 1, '...still exactly one live pane');

    /* ---- the app's /term grant joins the spawned pane ---- */
    const grant = await http('/api/terminal-grants', { json: { paneid: s1.body.paneid, room: room.id, seat: 'shell', intent: 'view' }, headers: asWindow });
    ok(grant.status === 200 && typeof grant.body?.grant === 'string', `the page mints a terminal grant for the started pane (${grant.status})`, grant.body);
    const frames = [];
    const w = new WebSocket(`ws://${HOST}:${port}/term`, { headers: asWindow });
    w.on('message', (raw) => { try { frames.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
    w.on('error', () => {});
    await new Promise((r) => w.once('open', r));
    w.send(JSON.stringify({ type: 'grant', grant: grant.body?.grant }));
    ok(await until(() => frames.some((m) => typeof m.type === 'string' && m.type.startsWith('pane.') && m.paneid === s1.body.paneid), 15000), '/term (reattach-only) joins the pane the engine spawned: pane.* events arrive');
    w.close();

    /* ---- stop: a plain shell is not resumable, so Disconnect has nothing to do (409, plain words); End ends the pane ---- */
    const dis = await http(`/api/rooms/${room.id}/seats/${seatId}/disconnect`, { json: {}, headers: { cookie } });
    ok(dis.status === 409 && /nothing to disconnect/.test(String(dis.body?.message ?? dis.body?.error ?? '')), `Disconnect on a plain shell says so in plain words (${dis.status}: ${dis.body?.message ?? dis.body?.error})`);
    ok((await liveRows()).length === 1, '...and leaves the pane alone');
    /* the page's Stop for a shell seat: the window cookie, NO Origin, exactly like Start */
    const ended = await http(`/api/sessions/${encodeURIComponent(s1.body.paneid)}/end`, { json: {}, headers: { cookie } });
    ok(ended.status === 200, `End on the pane with the window cookie (no Origin) answers 200 (${ended.status} ${JSON.stringify(ended.body)})`, ended.status);
    ok(await until(async () => (await liveRows()).length === 0, 15000), 'and the pane is no longer live');
    const after = await http(`/api/rooms/${room.id}`, { headers: { cookie } });
    const seatAfter = (after.body?.seats ?? after.body?.room?.seats ?? []).find((x) => x.id === seatId || x.handle === 'shell');
    console.log('  seat after End:', JSON.stringify({ status: seatAfter?.status, state: seatAfter?.state, action: seatAfter?.action, occupant: seatAfter?.occupant, actions: seatAfter?.actions, left: seatAfter?.left_at }));
    ok(!!seatAfter && !seatAfter.left_at, 'the seat is still in the room after End');
    const again = await http(`/api/rooms/${room.id}/seats/${seatId}/start`, { json: {}, headers: { cookie } });
    ok(again.status === 200 && again.body?.paneid !== s1.body.paneid, `Start again runs it fresh: a new pane (${again.status})`, again.status);
    ok(await until(async () => (await liveRows()).length === 1, 15000), '...one live pane again');
    await http(`/api/sessions/${encodeURIComponent(again.body?.paneid ?? 'x')}/end`, { json: {}, headers: { cookie } });
    ok(await until(async () => (await liveRows()).length === 0, 15000), '...and it ends again');

    /* ---- plain failures ---- */
    const bare = (await http(`/api/rooms/${room.id}/seats`, { json: { handle: 'empty', policy: 'persistent' }, headers: { cookie } })).body;
    const bareId = bare?.seat?.id ?? bare?.id;
    if (bareId) {
      const nr = await http(`/api/rooms/${room.id}/seats/${bareId}/start`, { json: {}, headers: { cookie } });
      ok(nr.status === 409 && /no project/.test(String((nr.body?.message ?? nr.body?.error) ?? '')), `a seat with no recipe fails with a plain reason (${nr.status}: ${(nr.body?.message ?? nr.body?.error) ?? ''})`);
    } else {
      ok(true, 'a seat with no recipe cannot be added at all (nothing to start)');
    }
    broker.kill('SIGKILL');
    await sleep(800);
    const s3 = await http(`/api/rooms/${room.id}/seats/${seatId}/start`, { json: {}, headers: { cookie } });
    ok(s3.status >= 400 && typeof (s3.body?.message ?? s3.body?.error) === 'string' && String(s3.body?.message ?? s3.body?.error ?? "").length > 0, `with the broker down Start fails with a plain reason, never a 200 with no pane (${s3.status}: ${(s3.body?.message ?? s3.body?.error) ?? ''})`, s3.status);
    ok((await liveRows()).length === 0, '...and no pane is left live');
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
