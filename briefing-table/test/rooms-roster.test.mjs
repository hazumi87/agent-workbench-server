/**
 * ROSTER VERBS through a real scratch engine (2026-09-25) [ticket]:
 * `seat.actions`, `occupant.url` / `started_at` / `channel`, and
 * POST /api/rooms/:id/seats/:seatId/start. Same pattern as
 * rooms-routes.test.mjs: our own engine on P() ports, a temp db seeded through
 * the store (test/rooms-routes.seed.ts), NO broker and NO pty — a start is
 * placed as a BROWSER tab (`target:'tab', surface:'browser'`), which answers
 * the paneid and path without opening anything, and no viewer ever attaches,
 * so a started seat stays `starting` exactly as it would until a real attach.
 *
 * Channels are ON and the fabric url points at a STUB that answers only
 * /presence, so `occupant.channel` can show all three outcomes.
 *
 * SAFETY: never touches :7420/:7430/:8200/:8201/:8204, the real data dir, or a
 * broker. Every child env comes from childEnv(). The temp dir is removed.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv, windowCookie, roomUserWrite } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(64);
const DEAD_BROKER_PORT = P(65);
const FABRIC_PORT = P(66);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'rooms-roster-test-token';

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
  ok(a === b, a === b ? msg : `${msg}\n      got      ${a}\n      expected ${b}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let userCookie = ''; // the window cookie: a room write with no `from` is the USER's (roomUserWrite)
async function call(path, opts = {}) {
  const m = opts.method ?? (opts.json !== undefined ? 'POST' : 'GET');
  const headers = userCookie && !opts.bearer && roomUserWrite(path, m, opts.json) ? { cookie: userCookie } : { authorization: `Bearer ${TOKEN}` };
  const init = { method: opts.method ?? 'GET', headers };
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

/* The stub fabric: /presence only. boss's pane holds a channel, mem's does
   not; anything else is a 503 (the fabric answered, but not with an answer). */
const LB = 'recipe:rec-b#L';
const LM = 'recipe:rec-d#M';
function startFabric() {
  const srv = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/presence') {
      const p = u.searchParams.get('paneid');
      if (p === LB || p === LM) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ paneid: p, channel: p === LB }));
        return;
      }
      res.writeHead(503);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => srv.listen(FABRIC_PORT, HOST, () => resolve(srv)));
}

async function run() {
  for (const p of [PORT, DEAD_BROKER_PORT, FABRIC_PORT]) {
    await assertFree(p, 'rooms-roster.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-rooms-roster-'));
  const dbPath = join(tmpDir, 'mapping.db');
  let engine = null;
  let fabricSrv = null;
  let engineLog = '';
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], {
      HARBOR_WB_TABLE: dbPath,
      HARBOR_WB_IDENTITY: 'legacy',
    });
    if (r.code !== 0) {
      throw new Error(`seed failed: ${r.err}`);
    }
    return JSON.parse(r.out.trim().split('\n').pop());
  };

  try {
    const recipe = (id, name, vendor) => ({ id, name, projectDir: `/srv/x/${id}`, vendor, agent: id });
    const pre = await seed({
      recipes: [
        recipe('rec-a', 'Alpha', 'claude-code'),
        recipe('rec-b', 'Bravo', 'cli-manager'),
        recipe('rec-d', 'Delta', 'cli-manager'),
        recipe('rec-f', 'Foxtrot', 'claude-code'),
      ],
      sessions: [
        { paneid: 'recipe:rec-a#dh', recipe_id: 'rec-a', vendor: 'claude-code', agent: 'rec-a', session_id: 's-dh', state: 'dehydrated' },
        { paneid: 'recipe:rec-a#dh2', recipe_id: 'rec-a', vendor: 'claude-code', agent: 'rec-a', session_id: 's-dh2', state: 'dehydrated' },
        { paneid: 'recipe:rec-f#dh', recipe_id: 'rec-f', vendor: 'claude-code', agent: 'rec-f', session_id: 's-f', state: 'dehydrated' },
        { paneid: 'recipe:rec-b#k', recipe_id: 'rec-b', vendor: 'cli-manager', agent: 'rec-b', state: 'killed' },
        { paneid: 'recipe:rec-b#k2', recipe_id: 'rec-b', vendor: 'cli-manager', agent: 'rec-b', state: 'killed' },
      ],
      rooms: [
        {
          name: 'Roster',
          seats: [
            { handle: 'boss', recipe_id: 'rec-b', occupant: LB }, // lead; live after boot
            { handle: 'rh', recipe_id: 'rec-a', occupant: 'recipe:rec-a#dh' }, // persistent + dehydrated
            { handle: 'rh2', recipe_id: 'rec-a', occupant: 'recipe:rec-a#dh2' }, // the same, started fresh:true
            { handle: 'fr', recipe_id: 'rec-f', occupant: 'recipe:rec-f#dh', policy: 'fresh' },
            { handle: 'ns', recipe_id: 'rec-a' }, // never-started
            { handle: 'em', recipe_id: 'rec-b', occupant: 'recipe:rec-b#k', thenEmpty: true }, // empty
            { handle: 'en', recipe_id: 'rec-b', occupant: 'recipe:rec-b#k2' }, // ended
            { handle: 'dp', recipe_id: 'rec-a', policy: 'dispatched' },
            { handle: 'nr', project: 'norecipe' },
            { handle: 'mem', recipe_id: 'rec-d', occupant: LM }, // a non-lead member; live after boot
          ],
        },
      ],
    });
    const room = pre.rooms[0];
    const S = room.seats;

    fabricSrv = await startFabric();
    console.log(`booting scratch engine :${PORT} (dead broker :${DEAD_BROKER_PORT}, stub fabric :${FABRIC_PORT})`);
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
        HARBOR_WB_FABRIC_URL: `http://${HOST}:${FABRIC_PORT}`,
        HARBOR_WB_CHANNELS: '1',
        HARBOR_WB_ROOM_FABRIC: '0',
        HARBOR_WB_BROKER_AUTOSTART: '0',
        HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT),
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_CHANNELS_DIR: join(tmpDir, 'mcp'),
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
    await seed({
      sessions: [
        { paneid: LB, recipe_id: 'rec-b', vendor: 'cli-manager', agent: 'rec-b', state: 'live' },
        { paneid: LM, recipe_id: 'rec-d', vendor: 'cli-manager', agent: 'rec-d', state: 'live' },
      ],
    });

    /* ------------------------------------------------------- actions ---- */
    console.log('\n[seat.actions — the table, derived by the engine]');
    const v1 = await call(`/api/rooms/${room.id}`);
    eq(v1.status, 200, 'GET room: 200');
    const by1 = Object.fromEntries(v1.body.seats.map((s) => [s.handle, s]));
    same(by1.boss.actions, ['open'], 'live pane -> [open]');
    same(by1.mem.actions, ['open'], 'live pane (non-lead) -> [open]');
    same(by1.rh.actions, ['rehydrate'], 'persistent + dehydrated occupant -> [rehydrate]');
    same(by1.fr.actions, ['start'], "policy 'fresh' + dehydrated occupant -> [start] (never rehydrate)");
    same(by1.ns.actions, ['start'], 'never-started + recipe -> [start]');
    same(by1.em.actions, ['start'], 'empty + recipe -> [start]');
    same(by1.en.actions, ['start'], 'ended + recipe -> [start]');
    same(by1.dp.actions, [], "policy 'dispatched' -> [] (dispatch not built)");
    same(by1.nr.actions, [], 'no recipe -> []');
    eq(by1.ns.status, 'never-started', 'ns is never-started');
    eq(by1.em.status, 'empty', 'em is empty');
    eq(by1.en.status, 'ended', 'en is ended');
    eq(by1.rh.status, 'dehydrated', 'rh is dehydrated');

    console.log('\n[occupant.url / started_at / channel]');
    eq(by1.boss.occupant.url, `/solo.html?recipe=rec-b&pane=${encodeURIComponent(LB)}`, 'live occupant.url = the launch route\'s solo path');
    eq(by1.mem.occupant.url, `/solo.html?recipe=rec-d&pane=${encodeURIComponent(LM)}`, 'and for the member');
    ok(!('url' in by1.rh.occupant), 'no url on a dehydrated occupant');
    ok(!('url' in by1.en.occupant), 'no url on an ended occupant');
    eq(typeof by1.boss.occupant.started_at, 'number', 'occupant.started_at is ms (a number) for a spawned row');
    ok(Math.abs(by1.boss.occupant.started_at - Date.now()) < 60_000, 'and it is recent (the seed\'s spawn)');
    eq(typeof by1.rh.occupant.started_at, 'number', 'a dehydrated row keeps the started_at of its last spawn');
    eq(by1.boss.occupant.channel, null, 'first read: channel null (not asked yet — never blocks on the fabric)');
    ok(!('channel' in by1.rh.occupant), 'no channel field on a non-live occupant');
    await sleep(300);
    const by2 = Object.fromEntries((await call(`/api/rooms/${room.id}`)).body.seats.map((s) => [s.handle, s]));
    eq(by2.boss.occupant.channel, true, 'after the refresh: the fabric says boss holds a channel');
    eq(by2.mem.occupant.channel, false, 'and mem does not');
    /* A channel works with no window attached: a PARKED seat (live row, no
       viewer) must carry occupant.channel too (nuc1, 2026-09-25). */
    eq(by2.boss.status, 'parked', 'boss is PARKED (live row, no window attached)');
    ok('channel' in by2.boss.occupant, 'a parked occupant still carries occupant.channel');

    /* ---------------------------------------------------------- start ---- */
    console.log('\n[POST seats/:id/start — authority]');
    const tab = { target: 'tab', surface: 'browser' };
    const byMem = await post(`/api/rooms/${room.id}/seats/${S.ns}/start`, { ...tab, from: { paneid: LM } });
    eq(byMem.status, 403, 'a non-lead member: 403');
    eq(byMem.body?.field, 'from', 'naming field from');
    const badTarget = await post(`/api/rooms/${room.id}/seats/${S.ns}/start`, { target: 'sideways' });
    eq(badTarget.status, 400, 'a bad target: 400');
    eq(badTarget.body?.field, 'target', 'naming field target');

    console.log('\n[start a never-started seat, as the lead]');
    const st = await post(`/api/rooms/${room.id}/seats/${S.ns}/start`, { ...tab, from: { paneid: LB } });
    eq(st.status, 200, 'the lead may start a seat: 200');
    ok(st.body?.ok === true, 'answer.ok');
    ok(/^recipe:rec-a#[0-9a-f]{8}$/.test(st.body?.paneid ?? ''), 'a FRESH pane of the seat\'s recipe');
    eq(st.body?.placement, 'tab', 'placement from the launch route (browser tab)');
    eq(st.body?.path, `/solo.html?recipe=rec-a&pane=${encodeURIComponent(st.body?.paneid)}`, 'path = the solo path');
    eq(typeof st.body?.url, 'string', 'url present');
    same(Object.keys(st.body ?? {}), ['ok', 'paneid', 'url', 'path', 'placement', 'seat', 'entries'], 'answer keys: launch answer + {seat, entries}');
    eq(st.body?.seat?.status, 'starting', 'bound, no viewer yet -> status starting');
    eq(st.body?.seat?.occupant?.id, st.body?.paneid, 'the seat is bound to the minted pane');
    eq(st.body?.seat?.occupant?.url, st.body?.path, 'occupant.url while starting = the answer path');
    same(st.body?.seat?.actions, ['open'], 'starting -> [open]');
    eq(st.body?.entries?.length, 1, 'one line entry');
    eq(st.body?.entries?.[0]?.kind, 'fact', 'a Room fact');
    eq(st.body?.entries?.[0]?.body, '@ns started by @boss', 'fact "@<handle> started by <actor>"');
    const nsHist = await call(`/api/rooms/${room.id}/seats/${S.ns}/history`);
    same(nsHist.body.history, [], 'a first fill writes no history');
    const again = await post(`/api/rooms/${room.id}/seats/${S.ns}/start`, tab);
    eq(again.status, 409, 'starting again while a start is pending: 409');
    eq(again.body?.field, 'seat', 'naming field seat');
    const launchLine = engineLog.split('\n').find((l) => l.includes(`@ns started (fresh) → ${st.body?.paneid}`));
    ok(!!launchLine, 'the engine logs the start');
    ok(engineLog.includes('launch: "Alpha" → tab in the asking BROWSER'), 'through the SAME launch path as the recipe route');

    console.log('\n[start replaces an ended occupant (history replaced), as the user]');
    const en = await post(`/api/rooms/${room.id}/seats/${S.en}/start`, tab);
    eq(en.status, 200, 'start an ended seat: 200');
    eq(en.body?.entries?.[0]?.body, '@en started by user', 'no from = the user');
    const enMeta = JSON.parse(en.body?.entries?.[0]?.meta ?? '{}');
    eq(enMeta.reason, 'replaced', 'fact meta.reason replaced');
    eq(enMeta.mode, 'fresh', 'fact meta.mode fresh');
    const enHist = (await call(`/api/rooms/${room.id}/seats/${S.en}/history`)).body.history;
    eq(enHist.length, 1, 'one history row');
    eq(enHist[0]?.reason, 'replaced', 'reason replaced');
    eq(enHist[0]?.occupant, 'recipe:rec-b#k2', 'the former occupant is kept');
    const em = await post(`/api/rooms/${room.id}/seats/${S.em}/start`, tab);
    eq(em.status, 200, 'start an empty seat: 200');
    eq((await call(`/api/rooms/${room.id}/seats/${S.em}/history`)).body.history.length, 1, 'filling an empty seat adds no history row');

    console.log('\n[persistent + dehydrated: rehydrate the SAME pane]');
    const rh = await post(`/api/rooms/${room.id}/seats/${S.rh}/start`, tab);
    eq(rh.status, 200, 'rehydrate: 200');
    eq(rh.body?.paneid, 'recipe:rec-a#dh', 'the occupant pane itself');
    eq(rh.body?.path, `/solo.html?recipe=rec-a&pane=${encodeURIComponent('recipe:rec-a#dh')}`, 'its solo path');
    eq(JSON.parse(rh.body?.entries?.[0]?.meta ?? '{}').mode, 'rehydrate', 'fact meta.mode rehydrate');
    eq(rh.body?.seat?.status, 'starting', 'dehydrated + pending start -> starting');
    same(rh.body?.seat?.actions, ['open'], 'starting -> [open]');
    same((await call(`/api/rooms/${room.id}/seats/${S.rh}/history`)).body.history, [], 'no history: nothing was replaced');
    eq((await post(`/api/rooms/${room.id}/seats/${S.rh}/start`, tab)).status, 409, 'a second rehydrate while pending: 409');

    console.log('\n[fresh:true on a persistent dehydrated seat, and policy fresh]');
    const rh2 = await post(`/api/rooms/${room.id}/seats/${S.rh2}/start`, { ...tab, fresh: true });
    ok(rh2.body?.paneid !== 'recipe:rec-a#dh2' && /^recipe:rec-a#/.test(rh2.body?.paneid ?? ''), 'fresh:true -> a new pane, not the dehydrated one');
    eq((await call(`/api/rooms/${room.id}/seats/${S.rh2}/history`)).body.history[0]?.reason, 'replaced', 'the dehydrated occupant retired as replaced');
    const fr = await post(`/api/rooms/${room.id}/seats/${S.fr}/start`, tab);
    ok(fr.body?.paneid !== 'recipe:rec-f#dh' && /^recipe:rec-f#/.test(fr.body?.paneid ?? ''), "policy 'fresh' -> always a new pane");
    eq(JSON.parse(fr.body?.entries?.[0]?.meta ?? '{}').mode, 'fresh', 'mode fresh');

    console.log('\n[refusals]');
    const live = await post(`/api/rooms/${room.id}/seats/${S.boss}/start`, tab);
    eq(live.status, 409, 'a seat with a LIVE occupant: 409');
    eq(live.body?.field, 'seat', 'naming field seat');
    const dp = await post(`/api/rooms/${room.id}/seats/${S.dp}/start`, tab);
    eq(dp.status, 409, 'a dispatched seat: 409');
    eq(dp.body?.field, 'policy', 'naming field policy');
    const nr = await post(`/api/rooms/${room.id}/seats/${S.nr}/start`, tab);
    eq(nr.status, 409, 'a seat with no recipe: 409');
    eq(nr.body?.field, 'recipe_id', 'naming field recipe_id');
    eq((await post(`/api/rooms/${room.id}/seats/nope/start`, tab)).status, 404, 'an unknown seat: 404');

    console.log('\n[the pty spawns on attach: row goes live -> seat goes live]');
    await seed({ sessions: [{ paneid: st.body.paneid, recipe_id: 'rec-a', vendor: 'claude-code', agent: 'rec-a', state: 'live' }] });
    const nsLive = (await call(`/api/rooms/${room.id}`)).body.seats.find((s) => s.handle === 'ns');
    eq(nsLive.status, 'parked', 'a live row with no window: parked');
    same(nsLive.actions, ['open'], '[open]');
    eq(nsLive.occupant.url, st.body.path, 'url unchanged');
    eq(typeof nsLive.occupant.started_at, 'number', 'started_at stamped by the spawn');
    eq((await post(`/api/rooms/${room.id}/seats/${S.ns}/start`, tab)).status, 409, 'now live: 409');

    console.log('\n[archived room: stasis]');
    const boxed = (await post('/api/rooms', { name: 'Boxed' })).body.id;
    const bs = (await post(`/api/rooms/${boxed}/seats`, { recipe_id: 'rec-d', handle: 'solo' })).body.seat.id;
    await post(`/api/rooms/${boxed}/archive`, {});
    const bv = (await call(`/api/rooms/${boxed}`)).body.seats[0];
    same(bv.actions, [], 'an archived room offers no start');
    const bst = await post(`/api/rooms/${boxed}/seats/${bs}/start`, tab);
    eq(bst.status, 409, 'start in an archived room: 409');
    eq(bst.body?.field, 'state', 'naming field state');

    console.log('\n[the recipe launch route is unchanged]');
    const rl = await post('/api/recipes/rec-d/launch', tab);
    eq(rl.status, 200, 'POST /api/recipes/:id/launch: 200');
    same(Object.keys(rl.body ?? {}), ['ok', 'paneid', 'url', 'path', 'placement'], 'same answer keys');
    eq(rl.body?.paneid, 'recipe:rec-d', 'a plain launch is the primary pane');
    eq(rl.body?.path, '/solo.html?recipe=rec-d', 'primary pane path has no &pane=');
    const rlf = await post('/api/recipes/rec-d/launch', { ...tab, fresh: true, model: 'opus' });
    eq(rlf.body?.path, `/solo.html?recipe=rec-d&pane=${encodeURIComponent(rlf.body?.paneid)}&model=opus`, 'fresh + model path');
    const rlNoBody = await call('/api/recipes/rec-d/launch', { method: 'POST' });
    eq(rlNoBody.status, 200, 'no body = plain launch, still 200');
  } catch (e) {
    failed++;
    failures.push(String(e?.stack ?? e));
    console.log(`  ✗ threw: ${e?.stack ?? e}`);
  } finally {
    if (engine) {
      engine.kill('SIGKILL');
      await sleep(200);
    }
    if (fabricSrv) {
      fabricSrv.close();
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
