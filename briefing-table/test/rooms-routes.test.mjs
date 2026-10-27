/**
 * Workroom ROUTES through a real scratch engine (the design notes §2,
 * §6 rows: routes, author, delivery, auth, diag) [ticket].
 *
 * The identity-engine pattern: our own engine on P() ports, a temp mapping db,
 * a temp identity db, NO broker and NO pty (the broker port is a dead P() port,
 * assertFree'd, so nothing can be adopted from it). Session rows cannot be made
 * over HTTP, so test/rooms-routes.seed.ts writes them through the store:
 * dehydrated / killed rows and a pre-seated room BEFORE boot (reconcile sweeps
 * only `live`), live rows AFTER boot (the engine reads the table per request).
 *
 * Identity mode is `both`: the bearer drives every call, and one bootstrapped
 * user with an unchanged temp code proves the forced-change gate covers the
 * rooms routes (trap 12).
 *
 * SAFETY: never touches :7420/:7430/:8200/:8201/:8204, the real data dir, or a
 * broker. Every child env comes from childEnv(). The temp dir is removed.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv, roomUserWrite } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(30); // scratch engine — port table in test/_scratch.mjs
const DEAD_BROKER_PORT = P(31); // nothing may listen: no pty is ever opened here
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'rooms-routes-test-token';

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

/* THE USER IS A PERSON (Q5 closed, [ticket]): a room mutation with no `from`
   acts as the user, which takes a HUMAN credential (a window cookie, no
   bearer). So once `userCookie` is set, a /api/rooms* mutation that names no
   `from` goes out on the cookie, exactly as a window sends it; everything else
   (reads, every `from` post, every non-room route) stays on the agent's bearer.
   `bearer: true` forces the bearer — the "agent omits from" cases. */
let userCookie = '';
function actsAsUser(path, opts) {
  const method = opts.method ?? (opts.json !== undefined ? 'POST' : 'GET');
  return !!userCookie && !opts.bearer && roomUserWrite(path, method, opts.json);
}

async function call(path, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  if (opts.auth !== false && !opts.cookie && actsAsUser(path, opts)) {
    opts = { ...opts, cookie: userCookie };
  }
  if (opts.auth !== false && !opts.cookie) {
    headers.authorization = `Bearer ${TOKEN}`;
  }
  if (opts.cookie) {
    headers.cookie = opts.cookie;
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
const post = (path, json, extra = {}) => call(path, { json, ...extra });
const line = (roomId, json) => post(`/api/rooms/${roomId}/line`, json);

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
    await assertFree(p, 'rooms-routes.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-rooms-routes-'));
  const dbPath = join(tmpDir, 'mapping.db');
  const identityDb = join(tmpDir, 'identity.db');
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
    return JSON.parse(r.out.trim().split('\n').pop());
  };

  try {
    /* ---------------------------------------------------------- seed ---- */
    const recipe = (id, name, dir, vendor, agent) => ({ id, name, projectDir: dir, vendor, agent });
    const pre = await seed({
      recipes: [
        recipe('rec-auriga', 'Auriga', '/srv/x/auriga', 'claude-code', 'auriga'),
        recipe('rec-barn', 'Kiosk', '/srv/x/kiosk', 'cli-manager', 'kiosk'),
        recipe('rec-ha', 'Home Operations', '/srv/x/home-ops', 'claude-code', 'home-ops'),
        recipe('rec-solo', 'Solo', '/srv/x/solo', 'cli-manager', 'solo'),
        recipe('rec-tmp', 'Temp', '/srv/x/temp', 'cli-manager', 'temp'),
        recipe('rec-lock', 'Lock', '/srv/x/lock', 'cli-manager', 'lock'),
      ],
      sessions: [
        { paneid: 'recipe:rec-ha#1', recipe_id: 'rec-ha', vendor: 'claude-code', agent: 'home-ops', state: 'dehydrated' },
        { paneid: 'recipe:rec-barn#9', recipe_id: 'rec-barn', vendor: 'cli-manager', agent: 'kiosk', state: 'killed' },
        { paneid: 'recipe:rec-barn#8', recipe_id: 'rec-barn', vendor: 'cli-manager', agent: 'kiosk', state: 'killed' },
      ],
      rooms: [
        {
          name: 'Seeded',
          seats: [
            { handle: 'ha', recipe_id: 'rec-ha', occupant: 'recipe:rec-ha#1' }, // lead, dehydrated
            { handle: 'ghost', recipe_id: 'rec-auriga' }, // never-started, vendor from recipe
            { handle: 'gone', recipe_id: 'rec-barn', occupant: 'recipe:rec-barn#8', thenEmpty: true }, // empty
            { handle: 'dead', recipe_id: 'rec-barn', occupant: 'recipe:rec-barn#9' }, // ended
          ],
        },
      ],
    });
    const seeded = pre.rooms[0];

    const bootCli = await runTsx(
      [join('scripts', 'identity.ts'), 'bootstrap', '--username', 'probe'],
      { HARBOR_WB_IDENTITY_DB: identityDb },
    );
    const tempCode = /password\s+([a-z2-9]{4}-[a-z2-9]{4})/.exec(bootCli.out)?.[1] ?? null;

    console.log(`booting scratch engine :${PORT} (dead broker :${DEAD_BROKER_PORT}, db ${dbPath})`);
    /* --import the tsx LOADER, not the tsx CLI: the CLI re-spawns node, so
       killing it would orphan the engine on the port (found the hard way). */
    const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
    engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_PORT: String(PORT),
        HARBOR_WB_HOST: HOST,
        HARBOR_WB_TABLE: dbPath,
        HARBOR_WB_TOKEN: TOKEN,
        HARBOR_WB_IDENTITY: 'both',
        HARBOR_WB_IDENTITY_DB: identityDb,
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

    // LIVE rows, after boot (reconcile would have swept them).
    await seed({
      sessions: [
        { paneid: 'recipe:rec-auriga#1', recipe_id: 'rec-auriga', vendor: 'claude-code', agent: 'auriga', session_id: 'sess-a1', state: 'live' },
        { paneid: 'recipe:rec-auriga#2', recipe_id: 'rec-auriga', vendor: 'claude-code', agent: 'auriga', session_id: 'sess-a2', state: 'live' },
        { paneid: 'recipe:rec-barn#1', recipe_id: 'rec-barn', vendor: 'cli-manager', agent: 'kiosk', state: 'live' },
        { paneid: 'recipe:rec-solo#1', recipe_id: 'rec-solo', vendor: 'cli-manager', agent: 'solo', state: 'live' },
        { paneid: 'recipe:rec-barn#5', recipe_id: 'rec-barn', vendor: 'cli-manager', agent: 'kiosk', state: 'live' },
      ],
    });
    const A1 = 'recipe:rec-auriga#1';
    const A2 = 'recipe:rec-auriga#2';
    const B1 = 'recipe:rec-barn#1';
    const FREE = 'recipe:rec-barn#5'; // live, seated nowhere

    /* ---------------------------------------------------------- auth ---- */
    console.log('\n[auth: bearer, no loopback exemption, forced-change gate]');
    eq((await call('/api/rooms', { auth: false })).status, 401, 'unauthenticated loopback GET /api/rooms (no XFF): 401');
    eq((await call('/api/diag/rooms', { auth: false })).status, 401, 'unauthenticated GET /api/diag/rooms: 401');
    eq((await post('/api/rooms', { name: 'x' }, { auth: false })).status, 401, 'unauthenticated POST /api/rooms: 401');
    const fwdHdr = { 'x-forwarded-for': '100.64.0.9', 'x-forwarded-host': 'host.example.ts.net' };
    eq((await call('/api/rooms', { auth: false, headers: fwdHdr })).status, 401, 'unauthenticated FORWARDED GET /api/rooms: 401');
    eq((await post(`/api/rooms/${seeded.id}/line`, { text: 'hi' }, { auth: false, headers: fwdHdr })).status, 401, 'unauthenticated forwarded POST .../line: 401');
    ok(!!tempCode, 'bootstrapped a user with a temp code');
    const login = await post('/login', { username: 'probe', password: tempCode }, { auth: false });
    const cookie = (login.res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    eq(login.body?.mustChangePassword, true, 'the temp code signs in with mustChangePassword');
    const gated = await call('/api/rooms', { cookie });
    eq(gated.status, 403, 'a mustChangePassword principal gets 403 on GET /api/rooms');
    eq(gated.body?.mustChangePassword, true, 'and the 403 is the forced-change gate');
    eq((await call('/api/rooms', {})).status, 200, 'the bearer gets 200');
    /* The "user" below is a PERSON: an identity session. In mode `both` the shared-token window cookie is derivable from the bearer, so it is not one (server/person.ts). The
       probe account changes its temp code for a real password and keeps the re-issued session cookie. */
    const changed = await post('/account/password', { current: tempCode, next: 'Vt7#mqz-Pk-long-enough' }, { cookie });
    eq(changed.status, 200, 'the probe account changes its temp code');
    userCookie = (changed.res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    ok(/homelab_session=/.test(userCookie), 'the re-issued identity session is the user\'s credential below');
    const forgedHuman = await call('/api/rooms', { json: { name: 'forged' }, method: 'POST', cookie: `wb_auth=${createHash('sha256').update(`wb-cookie:${TOKEN}`).digest('hex')}` });
    ok(forgedHuman.status === 403 || forgedHuman.status === 401, 'the legacy cookie computed from the bearer cannot create a room (not a person in mode both)');

    /* -------------------------------------------------- derived fields ---- */
    console.log('\n[GET /api/rooms/:id — derived per-seat status, occupant, vendor]');
    const sv = await call(`/api/rooms/${seeded.id}`);
    eq(sv.status, 200, 'GET seeded room: 200');
    const byH = Object.fromEntries(sv.body.seats.map((s) => [s.handle, s]));
    eq(byH.ha.status, 'dehydrated', 'dehydrated occupant -> status dehydrated');
    eq(byH.ha.occupant?.id, 'recipe:rec-ha#1', 'occupant object carries the paneid as id');
    eq(byH.ha.occupant?.state, 'dehydrated', 'occupant.state');
    eq(byH.ha.occupant?.activity, 'disconnected', 'occupant.activity is the /api/table projection (dehydrated -> disconnected)');
    eq(byH.ha.occupant?.attached, false, 'occupant.attached');
    eq(byH.ha.vendor, 'claude-code', 'vendor from the occupant row');
    eq(byH.ghost.status, 'never-started', 'no occupant, no history -> never-started');
    eq(byH.ghost.occupant, null, 'never-started occupant is null');
    eq(byH.ghost.vendor, 'claude-code', 'no occupant: vendor resolved from the recipe');
    eq(byH.gone.status, 'empty', 'no occupant, has history -> empty');
    eq(byH.dead.status, 'ended', 'killed occupant -> ended');
    eq(sv.body.lead?.handle, 'ha', 'lead is the first persistent seat');
    eq(sv.body.seats[0].handle, 'ha', 'lead first');

    /* ------------------------------------------------ build a live room ---- */
    console.log('\n[create + seats over HTTP]');
    const created = await post('/api/rooms', { name: 'Alpha' });
    eq(created.status, 200, 'POST /api/rooms: 200');
    eq(created.body.created_by, 'user', 'no from -> created_by user');
    const alpha = created.body.id;
    eq((await post('/api/rooms', {})).body.field, 'name', 'no name -> 400 names field name');
    const sA1 = await post(`/api/rooms/${alpha}/seats`, { recipe_id: 'rec-auriga', occupant: A1 });
    eq(sA1.status, 200, 'add seat bound to a live pane');
    eq(sA1.body.seat.handle, 'auriga', 'handle derived from the recipe project');
    const sA2 = await post(`/api/rooms/${alpha}/seats`, { recipe_id: 'rec-auriga', occupant: A2 });
    eq(sA2.body.seat.handle, 'auriga2', 'a second auriga seat takes the placeholder');
    eq(sA2.body.seat.handle_named, 0, 'and is marked unnamed');
    const sB = await post(`/api/rooms/${alpha}/seats`, { project: 'kiosk', occupant: B1 });
    eq(sB.body.seat.recipe_id, 'rec-barn', 'recipe_id rewritten from the paneid');
    const sHA = await post(`/api/rooms/${alpha}/seats`, { recipe_id: 'rec-ha', handle: 'ha' });
    eq(sHA.status, 200, 'add a seat with no occupant');
    const bad = await post(`/api/rooms/${alpha}/seats`, { recipe_id: 'rec-ha', occupant: 'recipe:rec-ha#1' });
    eq(bad.status, 400, 'binding a NOT-live pane over HTTP is refused');
    eq(bad.body.field, 'occupant', 'and names field occupant');
    const reserved = await post(`/api/rooms/${alpha}/seats`, { project: 'x', handle: 'room' });
    eq(reserved.body.field, 'handle', 'a reserved typed handle names field handle');
    const seatA1 = sA1.body.seat.id;
    const seatA2 = sA2.body.seat.id;
    const seatB = sB.body.seat.id;
    const seatHA = sHA.body.seat.id;
    const rename2 = await call(`/api/rooms/${alpha}/seats/${seatA2}`, { method: 'PATCH', json: { handle: 'auriga-two' } });
    eq(rename2.body.seat.handle, 'auriga-two', 'PATCH seat handle');
    const mixed = await call(`/api/rooms/${alpha}/seats/${seatA2}`, { method: 'PATCH', json: { handle: 'x', occupant: null } });
    eq(mixed.status, 400, 'occupant + handle in one PATCH is refused (two verbs, two transactions)');
    eq(mixed.body.field, 'occupant', 'naming field occupant');

    const alphaView = await call(`/api/rooms/${alpha}`);
    const av = Object.fromEntries(alphaView.body.seats.map((s) => [s.handle, s]));
    eq(av.auriga.status, 'parked', 'a live pane with no window -> parked');
    eq(av.auriga.occupant?.vendor, 'claude-code', 'occupant.vendor');
    eq(av.ha.status, 'never-started', 'the unfilled seat');
    eq(alphaView.body.lead?.id, seatA1, 'first persistent seat became lead');

    /* ------------------------------------------------------ delivery ---- */
    console.log('\n[delivery by paneid: two seats, one agent slug]');
    const logBefore = engineLog.length;
    const m1 = await line(alpha, { text: '@auriga hello-one' });
    eq(m1.body.status, 'delivered', '@auriga: delivered');
    same(m1.body.deliveries.map((d) => d.paneid), [A1], '@auriga reached ONLY pane A1');
    const m2 = await line(alpha, { text: '@auriga-two hello-two' });
    same(m2.body.deliveries.map((d) => d.paneid), [A2], '@auriga-two reached ONLY pane A2 (same slug "auriga")');
    /* W3-interim: a live claude-code occupant also gets a TYPED copy queued. No
       resident pty exists in this engine, so it is held (never typed) — and
       the diag says why, in counts only. */
    eq(m1.body.deliveries[0].typed, 'queued', 'W3-interim: the typed copy is queued for A1');
    await sleep(150);
    const slice = engineLog.slice(logBefore);
    const toA1 = slice.split('\n').filter((l) => l.includes('room → ') && l.includes(`(${A1})`));
    const toA2 = slice.split('\n').filter((l) => l.includes('room → ') && l.includes(`(${A2})`));
    eq(toA1.length, 1, 'the engine log shows exactly one delivery into A1');
    eq(toA2.length, 1, 'and exactly one into A2');
    const mBoth = await line(alpha, { text: '@auriga-two @auriga both of you' });
    same(mBoth.body.deliveries.map((d) => d.paneid).sort(), [A1, A2].sort(), 'two leading @ reach BOTH panes (Owner 2026-09-27)');
    ok(toA2[0]?.includes('(pending 1)'), 'A2 holds ONE pending message — A1\'s did not leak into it');
    eq(m1.body.entries[0].target_seat, seatA1, 'the chat entry targets the A1 seat');
    const m0 = await line(alpha, { text: 'no address goes to the lead' });
    eq(m0.body.entries[0].target_seat, seatA1, 'un-addressed chat targets the lead seat');
    eq(m0.body.entries[0].target, null, 'and stores no typed target');
    same(m0.body.deliveries.map((d) => d.paneid), [A1], 'and is delivered to the lead pane');
    const mHA = await line(alpha, { text: '@ha are you there' });
    eq(mHA.body.status, 'posted', 'chat to an unfilled seat: posted, not delivered');
    same(mHA.body.entries.map((e) => e.kind), ['chat', 'delivery'], 'the chat plus a delivery entry');
    ok(/not-delivered: @ha is disconnected \(no session to restore\)/.test(mHA.body.entries[1].body), 'the delivery entry says "not-delivered: @ha is disconnected" (the person\'s line, nothing to restore) [wake deliver]');
    eq(JSON.parse(mHA.body.entries[1].meta).cause, mHA.body.entries[0].id, 'delivery meta.cause = the chat id');
    eq(mHA.body.entries[1].author, 'room', 'the delivery report is the Room\'s');

    console.log('\n[carried command]');
    const car = await line(alpha, { text: '/session-summary @kiosk @ha' });
    eq(car.body.status, 'delivered', 'carried to a live and a not-live seat: delivered');
    same(car.body.entries.map((e) => e.kind), ['command', 'delivery', 'delivery'], 'command + one delivery entry per recipient');
    eq(car.body.entries[0].author, 'user', 'the command is the user\'s');
    ok(car.body.entries.slice(1).every((e) => JSON.parse(e.meta).cause === car.body.entries[0].id), 'each delivery cites the command');
    ok(/not.delivered/.test(car.body.entries.find((e) => e.target_seat === seatHA)?.body ?? ''), 'the @ha delivery says not delivered');
    await sleep(100);
    ok(engineLog.includes(`room → @kiosk (${B1}): msg/coordination`), 'the kiosk pane got the carried message by paneid');

    /* ------------------------------------------- read state (gate G 2) ---- */
    console.log('\n[read state: three outcomes, additive `reads` on line entries]');
    same(m1.body.entries[0].reads, { auriga: 'not-yet' }, 'claude-code occupant, typed copy held (no pty here): not-yet');
    same(mHA.body.entries[0].reads, { ha: 'unknown' }, 'occupant not live: unknown (could not tell)');
    eq(mHA.body.entries[1].reads, undefined, 'a delivery report carries no reads (field absent)');
    same(car.body.entries[0].reads, { kiosk: 'unknown', ha: 'unknown' }, 'carried to a badge-only vendor + a not-live seat: unknown, unknown');
    const gotLine = (await call(`/api/rooms/${alpha}/line?limit=1000`)).body.entries;
    const byId = Object.fromEntries(gotLine.map((e) => [e.id, e]));
    same(byId[m1.body.entries[0].id].reads, { auriga: 'not-yet' }, 'GET .../line serves the same reads');
    same(byId[m2.body.entries[0].id].reads, { 'auriga-two': 'not-yet' }, 'per seat, keyed by handle');
    ok(gotLine.filter((e) => e.kind === 'fact').every((e) => e.reads === undefined), 'Room facts carry no reads');
    /* The carried command's kiosk read flips to seen once kiosk POSTS
       after it (the author section below does exactly that). */
    const carId = car.body.entries[0].id;

    /* -------------------------------------------------------- author ---- */
    console.log('\n[author is derived, never supplied]');
    const fromB = await line(alpha, { text: 'status from kiosk', from: { paneid: B1 } });
    eq(fromB.status, 200, 'from:{paneid} of a seated live pane: 200');
    eq(fromB.body.entries[0].author, 'kiosk', 'authored as its seat handle');
    eq(fromB.body.entries[0].author_seat, seatB, 'author_seat = the seat id');
    const afterPost = (await call(`/api/rooms/${alpha}/line?since=${carId - 1}&limit=1`)).body.entries[0];
    eq(afterPost.id, carId, '(the carried command, re-read)');
    same(afterPost.reads, { kiosk: 'seen', ha: 'unknown' }, 'kiosk posted after it: seen; ha still could-not-tell');
    same(fromB.body.entries[0].reads, { auriga: 'not-yet' }, 'kiosk\'s own post reaches the lead, never itself');
    const fromSid = await line(alpha, { text: '@kiosk ping', from: { session_id: 'sess-a1' } });
    eq(fromSid.body.entries[0].author, 'auriga', 'from:{session_id} resolves through the live row to its seat');
    const unseated = await line(alpha, { text: 'hi', from: { paneid: FREE } });
    eq(unseated.status, 403, 'a from pane seated nowhere here: 403');
    eq(unseated.body.field, 'from', 'naming field from');
    eq((await line(alpha, { text: 'hi', from: { paneid: 'nope#1' } })).status, 403, 'an unknown paneid: 403');
    eq((await line(alpha, { text: 'hi', from: { paneid: 'recipe:rec-ha#1' } })).status, 403, 'a NOT-live pane: 403');
    const otherRoom = (await post('/api/rooms', { name: 'Elsewhere' })).body.id;
    const elseSeat = (await post(`/api/rooms/${otherRoom}/seats`, { project: 'kiosk', handle: 'else', occupant: FREE })).body.seat.id;
    const elsewhere = await line(alpha, { text: 'hi', from: { paneid: FREE } });
    eq(elsewhere.status, 403, 'a from pane seated in ANOTHER room: 403 here');
    eq(elsewhere.body.field, 'from', 'naming field from');
    // Un-seat it again: later steps rely on FREE being seated nowhere.
    eq((await call(`/api/rooms/${otherRoom}/seats/${elseSeat}`, { method: 'PATCH', json: { occupant: null } })).status, 200, 'and the other room lets it go');
    eq((await line(alpha, { text: 'hi', from: 'auriga' })).body.field, 'from', 'a malformed from: 400 field from');
    const spoof = await line(alpha, { text: 'hi', from: { paneid: B1 }, author: 'user' });
    eq(spoof.body.entries[0].author, 'kiosk', 'a caller-supplied author is ignored');
    const all = (await call(`/api/rooms/${alpha}/line?limit=1000`)).body.entries;
    const fromPosts = all.filter((e) => e.author_seat !== null);
    ok(fromPosts.length >= 3 && fromPosts.every((e) => e.author !== 'user'), 'no from post ever produced author=user');
    ok(
      all.filter((e) => e.author === 'user').every((e) => e.author_seat === null),
      'every author=user entry has author_seat NULL (what approval citation checks)',
    );
    const memberCmd = await line(alpha, { text: '/rename room Hijack', from: { paneid: B1 } });
    eq(memberCmd.body.status, 'refused', 'a member cannot run a room command');
    const handover = await line(alpha, { text: '/set lead @kiosk', from: { paneid: A1 } });
    eq(handover.body.status, 'applied', 'the current lead may hand the lead over');
    eq(handover.body.entries[0].author, 'auriga', 'and the command is authored as the lead seat');
    eq((await line(alpha, { text: '/set lead @auriga' })).body.status, 'applied', 'the user takes it back');

    console.log('\n[no `from` = the user ONLY on a human credential (Q5 closed)]');
    const NO_SEAT = 'from: an agent must say which seat it speaks for';
    const asAgent = (path, json, extra = {}) => call(path, { json, bearer: true, ...extra });
    const bLine = await asAgent(`/api/rooms/${alpha}/line`, { text: 'I am the user, honest' });
    eq(bLine.status, 403, 'bearer + no from on the line: 403');
    same([bLine.body?.error, bLine.body?.field], [NO_SEAT, 'from'], 'naming field from, saying why');
    const bCmd = await asAgent(`/api/rooms/${alpha}/line`, { text: '/rename room Hijacked' });
    eq(bCmd.status, 403, 'bearer + no from carrying a room command (/rename): 403');
    eq(bCmd.body?.field, 'from', 'naming field from');
    eq((await call(`/api/rooms/${alpha}`)).body.room.name, 'Alpha', 'and the room was NOT renamed');
    const bothCreds = await asAgent(`/api/rooms/${alpha}/line`, { text: 'hi' }, { headers: { cookie: userCookie } });
    eq(bothCreds.status, 403, 'cookie AND a bearer on one request, no from: still 403 (an agent can carry a cookie too)');
    const bSeated = await asAgent(`/api/rooms/${alpha}/line`, { text: 'bearer, from a seat', from: { paneid: B1 } });
    eq(bSeated.status, 200, 'bearer + from of a seated pane: 200');
    eq(bSeated.body.entries[0].author, 'kiosk', 'as that seat');
    const cLine = await line(alpha, { text: 'a person, from a window' });
    eq(cLine.status, 200, 'cookie + no from: 200');
    eq(cLine.body.entries[0].author, 'user', 'as the user');
    eq(cLine.body.entries[0].author_seat, null, 'author_seat NULL');
    const cCmd = await line(alpha, { text: '/rename room Alpha' });
    eq(cCmd.body.status, 'applied', 'cookie + no from: a room command (/rename) applies, as the user');
    eq((await asAgent('/api/rooms', { name: 'Agent-made' })).status, 403, 'bearer + no from on POST /api/rooms: 403');
    eq((await asAgent(`/api/rooms/${alpha}`, { name: 'Hijacked' }, { method: 'PATCH' })).body?.field, 'from', 'bearer + no from on PATCH room: 403 field from');
    eq((await asAgent(`/api/rooms/${alpha}/seats`, { project: 'kiosk', handle: 'sneak' })).status, 403, 'bearer + no from on POST seats: 403');
    eq((await asAgent(`/api/rooms/${alpha}/archive`, {})).status, 403, 'bearer + no from on archive: 403');
    eq((await call(`/api/rooms/${alpha}`)).body.room.state, 'open', 'and the room is still open');

    console.log('\n[POST /api/rooms {from}]');
    const byB = await post('/api/rooms', { name: 'Beta', from: { paneid: B1 } });
    eq(byB.body.created_by, seatB, 'a pane with ONE open seat: created_by = that seat id');
    eq((await post('/api/rooms', { name: 'Gamma', from: { paneid: FREE } })).status, 403, 'a pane seated nowhere: 403');

    /* ------------------------------------------- W4: the lead may invite ---- */
    console.log('\n[W4: the lead may /add and /replace; members may not; HTTP records the real actor]');
    const w4 = (await post('/api/rooms', { name: 'W4' })).body.id;
    const w4Lead = (await post(`/api/rooms/${w4}/seats`, { recipe_id: 'rec-auriga', handle: 'boss', occupant: A2 })).body.seat.id;
    const w4Mem = (await post(`/api/rooms/${w4}/seats`, { project: 'kiosk', handle: 'mem', occupant: B1 })).body.seat.id;
    eq((await call(`/api/rooms/${w4}`)).body.room.lead_seat, w4Lead, 'the first persistent seat leads W4');
    const leadAdd = await line(w4, { text: '/add home-ops as @tmpx', from: { paneid: A2 } });
    eq(leadAdd.body.status, 'applied', 'the lead may /add (typed door)');
    eq(leadAdd.body.entries[0].author, 'boss', 'and the command is authored as the lead handle');
    eq(leadAdd.body.entries[0].author_seat, w4Lead, 'with author_seat = the lead seat');
    const tmpx = (await call(`/api/rooms/${w4}`)).body.seats.find((s) => s.handle === 'tmpx');
    eq(tmpx?.added_by, w4Lead, 'added_by records the lead seat id (never "user")');
    eq(tmpx?.status, 'never-started', 'bind-only: nothing was spawned');
    eq((await line(w4, { text: '/add home-ops as @tmpy', from: { paneid: B1 } })).body.status, 'refused', 'a non-lead member may not /add');
    const leadRep = await line(w4, { text: '/replace @tmpx with recipe:rec-solo#1', from: { paneid: A2 } });
    eq(leadRep.body.status, 'applied', 'the lead may /replace (bind-only)');
    eq((await line(w4, { text: '/replace @tmpx', from: { paneid: B1 } })).body.status, 'refused', 'a non-lead member may not /replace');
    eq((await line(w4, { text: '/rename room Mine', from: { paneid: A2 } })).body.status, 'refused', 'the lead still may not rename the room');
    eq((await line(w4, { text: '/remove @tmpx confirm', from: { paneid: A2 } })).body.status, 'refused', 'nor remove a seat');
    eq((await line(w4, { text: '/archive confirm', from: { paneid: A2 } })).body.status, 'refused', 'nor archive the room (only the user closes a room)');

    const httpAdd = await post(`/api/rooms/${w4}/seats`, { project: 'home-ops', handle: 'tmpz', from: { paneid: A2 } });
    eq(httpAdd.status, 200, 'HTTP seat POST with from = the lead: 200');
    eq(httpAdd.body.seat.added_by, w4Lead, 'and added_by is the lead seat, not "user"');
    ok(/via HTTP by @boss/.test(engineLog), 'the engine log names the acting handle');
    const memAdd = await post(`/api/rooms/${w4}/seats`, { project: 'home-ops', handle: 'tmpw', from: { paneid: B1 } });
    eq(memAdd.status, 403, 'HTTP seat POST from a non-lead member: 403');
    eq(memAdd.body.field, 'from', 'naming field from');
    eq((await post(`/api/rooms/${w4}/seats`, { project: 'home-ops', from: { paneid: FREE } })).status, 403, 'from a pane with no seat in THIS room: 403');
    eq((await post(`/api/rooms/${w4}/seats`, { project: 'home-ops', from: 'boss' })).status, 400, 'a malformed from: 400');
    const tmpz = httpAdd.body.seat.id;
    eq((await call(`/api/rooms/${w4}/seats/${tmpz}`, { method: 'PATCH', json: { occupant: FREE, from: { paneid: B1 } } })).status, 403, 'HTTP occupant PATCH from a member: 403');
    eq((await call(`/api/rooms/${w4}/seats/${tmpz}`, { method: 'PATCH', json: { occupant: A1, from: { paneid: A2 } } })).status, 200, 'HTTP occupant PATCH (replace) from the lead: 200');
    eq((await call(`/api/rooms/${w4}/seats/${tmpz}`, { method: 'PATCH', json: { policy: 'fresh', from: { paneid: A2 } } })).status, 403, 'HTTP policy PATCH from the lead: 403 (user-only)');
    eq((await call(`/api/rooms/${w4}/seats/${tmpz}`, { method: 'DELETE', json: { from: { paneid: A2 } } })).status, 403, 'HTTP seat DELETE from the lead: 403');
    eq((await call(`/api/rooms/${w4}`, { method: 'PATCH', json: { name: 'Mine', from: { paneid: A2 } } })).status, 403, 'HTTP room rename from the lead: 403');
    eq((await post(`/api/rooms/${w4}/archive`, { from: { paneid: A2 } })).status, 403, 'HTTP archive from the lead: 403');
    eq((await post(`/api/rooms/${w4}/reopen`, { from: { paneid: A2 } })).status, 403, 'HTTP reopen from the lead: 403');
    eq((await call(`/api/rooms/${w4}`, { method: 'PATCH', json: { lead_seat: w4Mem, from: { paneid: B1 } } })).status, 403, 'HTTP lead PATCH from a non-lead: 403');
    const w4Hand = await call(`/api/rooms/${w4}`, { method: 'PATCH', json: { lead_seat: w4Mem, from: { paneid: A2 } } });
    eq(w4Hand.status, 200, 'HTTP lead PATCH from the current lead: 200 (handover)');
    eq(w4Hand.body.room.lead_seat, w4Mem, 'the lead moved');
    eq((await post(`/api/rooms/${w4}/seats`, { project: 'home-ops', handle: 'tmpv', from: { paneid: A2 } })).status, 403, 'the FORMER lead no longer may add');
    eq((await call(`/api/rooms/${w4}`, { method: 'PATCH', json: { name: 'W4 renamed' } })).status, 200, 'no from = the user, as before');
    eq((await call(`/api/rooms/${w4}/archive`, { method: 'POST' })).status, 200, 'a bodiless archive is still the user\'s already-confirmed form');

    /* ---------------------------------------------- command vs HTTP door ---- */
    console.log('\n[command door and HTTP door give identical facts]');
    const mk = async (name) => {
      const id = (await post('/api/rooms', { name })).body.id;
      const s = {};
      for (const h of ['lead1', 'mem1', 'mem2']) {
        s[h] = (await post(`/api/rooms/${id}/seats`, { project: h, handle: h })).body.seat.id;
      }
      return { id, s };
    };
    const R1 = await mk('Doors');
    const R2 = await mk('Doors');
    const cmds = [
      ['/set lead @mem1', () => call(`/api/rooms/${R2.id}`, { method: 'PATCH', json: { lead_seat: R2.s.mem1 } })],
      ['/set policy @mem2 fresh', () => call(`/api/rooms/${R2.id}/seats/${R2.s.mem2}`, { method: 'PATCH', json: { policy: 'fresh' } })],
      ['/rename @lead1 to @first', () => call(`/api/rooms/${R2.id}/seats/${R2.s.lead1}`, { method: 'PATCH', json: { handle: 'first' } })],
      ['/rename room Doors Renamed', () => call(`/api/rooms/${R2.id}`, { method: 'PATCH', json: { name: 'Doors Renamed' } })],
      ['/mode autonomous', () => call(`/api/rooms/${R2.id}`, { method: 'PATCH', json: { mode: 'autonomous' } })],
      ['/remove @mem2 confirm', () => call(`/api/rooms/${R2.id}/seats/${R2.s.mem2}`, { method: 'DELETE' })],
      ['/archive confirm', () => post(`/api/rooms/${R2.id}/archive`, {})],
      ['/reopen', () => post(`/api/rooms/${R2.id}/reopen`, {})],
    ];
    for (const [text, http] of cmds) {
      const a = await line(R1.id, { text });
      const b = await http();
      eq(a.body.status, 'applied', `${text}: applied through the line`);
      eq(b.status, 200, `${text}: 200 through HTTP`);
    }
    const idMap = (r) => Object.fromEntries(Object.entries(r.s).map(([h, id]) => [id, h]));
    const norm = (r) => (e) => {
      const meta = e.meta ? JSON.parse(e.meta) : {};
      delete meta.cause;
      let m = JSON.stringify(meta);
      for (const [id, h] of Object.entries(idMap(r))) {
        m = m.split(id).join(`<${h}>`);
      }
      return { kind: e.kind, author: e.author, target: e.target, body: e.body, meta: m };
    };
    const f1 = (await call(`/api/rooms/${R1.id}/line?kind=fact&limit=1000`)).body.entries.map(norm(R1));
    const f2 = (await call(`/api/rooms/${R2.id}/line?kind=fact&limit=1000`)).body.entries.map(norm(R2));
    ok(f1.length > 8, `the command door wrote ${f1.length} facts`);
    same(f1, f2, 'the facts are identical, entry for entry');
    const c1 = (await call(`/api/rooms/${R1.id}/line?kind=command`)).body.entries;
    eq(c1.length, cmds.length, 'the command door also stored each command verbatim');
    eq((await call(`/api/rooms/${R2.id}/line?kind=command`)).body.entries.length, 0, 'the HTTP door stores no command entries');
    ok(
      (await call(`/api/rooms/${R1.id}/line?kind=fact&limit=1000`)).body.entries
        .filter((e) => JSON.parse(e.meta ?? '{}').cause !== undefined)
        .every((e) => c1.some((c) => c.id === JSON.parse(e.meta).cause)),
      'every command-caused fact cites a stored command id',
    );

    /* ------------------------------------------------------- confirm ---- */
    console.log('\n[confirm round trip, both forms]');
    const count = async (id) => (await call(`/api/rooms/${id}/line?limit=1000`)).body.entries.length;
    const n0 = await count(alpha);
    const ask = await line(alpha, { text: '/remove @ha' });
    eq(ask.body.status, 'confirm', '/remove answers confirm');
    ok(typeof ask.body.confirm?.token === 'string' && /ha/.test(ask.body.confirm?.prompt ?? ''), 'with a token and a prompt naming the seat');
    eq(await count(alpha), n0, 'and writes NOTHING');
    eq((await call('/api/diag/rooms')).body.pendingConfirms >= 1, true, 'the diag counts the pending confirm');
    const wrongText = await line(alpha, { text: '/remove @auriga-two', confirm: ask.body.confirm.token });
    eq(wrongText.status, 400, 'the token does not confirm a different command');
    eq(wrongText.body.field, 'confirm', 'naming field confirm');
    const yes = await line(alpha, { text: '/remove @ha', confirm: ask.body.confirm.token });
    eq(yes.body.status, 'applied', 're-POST with the token: applied');
    same(yes.body.entries.map((e) => e.kind), ['command', 'fact'], 'command + fact');
    ok((await call(`/api/rooms/${alpha}`)).body.seats.every((s) => s.id !== seatHA), 'the seat is gone from the roster');
    const typed = await line(alpha, { text: '/remove @auriga-two confirm' });
    eq(typed.body.status, 'applied', 'the typed "confirm" form applies directly');
    const leadRemove = await line(alpha, { text: '/remove @auriga' });
    eq(leadRemove.body.status, 'refused', 'removing the lead is refused before any confirm');
    const arch = await line(seeded.id, { text: '/archive' });
    eq(arch.body.status, 'confirm', '/archive confirms too');
    eq((await line(seeded.id, { text: '/archive', confirm: arch.body.confirm.token })).body.status, 'applied', 'and applies with the token');
    eq((await call(`/api/rooms/${seeded.id}`)).body.room.state, 'archived', 'the room is archived');
    eq((await line(seeded.id, { text: '/reopen' })).body.status, 'applied', '/reopen needs no confirm');
    const spent = await line(seeded.id, { text: '/archive', confirm: arch.body.confirm.token });
    eq(spent.status, 400, 'a SPENT token is refused (tokens are single-use)');
    eq((await call(`/api/rooms/${seeded.id}`)).body.room.state, 'open', 'and the room stays open');

    /* -------------------------------------------- refusals + commands ---- */
    console.log('\n[refusals write nothing; not-in-build; help]');
    const n1 = await count(alpha);
    const unk = await line(alpha, { text: '/frobnicate' });
    eq(unk.status, 200, 'an unknown command is a 200');
    eq(unk.body.status, 'refused', 'status refused');
    ok(!!unk.body.refused?.suggestion, 'with a suggestion');
    const seam = await line(alpha, { text: '/seam' });
    eq(seam.body.refused?.error, 'not in this build', '/seam: not in this build');
    eq((await line(alpha, { text: '/voice on' })).body.refused?.error, 'not in this build', '/voice: not in this build');
    eq((await line(alpha, { text: '@all hello' })).body.status, 'refused', '@all refused');
    eq(await count(alpha), n1, 'none of them wrote anything');
    const help = await line(alpha, { text: '/help' });
    eq(help.body.client?.action, 'help', '/help returns client:{action:help}');
    ok(Array.isArray(help.body.client?.data) && help.body.client.data.some((c) => c.word === 'remove'), 'with the verb table');
    const cmdsTable = await call('/api/rooms/commands');
    ok(cmdsTable.body.commands.some((c) => c.usage.startsWith('/set lead')), 'GET /api/rooms/commands serves the verb table');

    console.log('\n[400 names the field]');
    eq((await line(alpha, {})).body.field, 'text', 'missing text: field text');
    const long = await line(alpha, { text: 'x'.repeat(4001) });
    eq(long.status, 400, 'over the cap: 400 (refused, never truncated)');
    eq(long.body.field, 'text', 'field text');
    eq((await line(alpha, { text: 'hi', confirm: 7 })).body.field, 'confirm', 'a non-string confirm: field confirm');
    const rawPost = async (path, raw) => {
      const r = await fetch(BASE + path, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: raw });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    for (const [path, raw] of [[`/api/rooms/${alpha}/line`, '{not json'], ['/api/rooms', 'null'], [`/api/rooms/${alpha}/seats`, '[1]']]) {
      const r = await rawPost(path, raw);
      ok(r.status === 400 && r.body?.field === 'body', `${raw} to ${path.replace(alpha, ':id')}: 400 field body (got ${r.status} ${JSON.stringify(r.body)})`);
    }
    eq((await call('/api/rooms/nope')).status, 404, 'unknown room: 404');
    eq((await call(`/api/rooms/${alpha}/line?limit=0`)).body.field, 'limit', 'bad limit: field limit');

    /* ------------------------------------------- line read + history ---- */
    console.log('\n[line paging, seat filter, history]');
    const tail = (await call(`/api/rooms/${alpha}/line?limit=3`)).body.entries;
    eq(tail.length, 3, 'tail of 3');
    const fwd = (await call(`/api/rooms/${alpha}/line?since=${tail[0].id}`)).body.entries;
    same(fwd.map((e) => e.id), tail.slice(1).map((e) => e.id), 'since pages forward from an id');
    const seatLine = (await call(`/api/rooms/${alpha}/line?seat=${seatB}&limit=1000`)).body.entries;
    ok(seatLine.length > 0 && seatLine.every((e) => e.author_seat === seatB || e.target_seat === seatB), 'seat= matches author OR target');
    const rep = await line(alpha, { text: `/replace @kiosk with ${FREE}` });
    eq(rep.body.status, 'applied', '/replace binds a named live pane');
    const hist = await call(`/api/rooms/${alpha}/seats/${seatB}/history`);
    eq(hist.status, 200, 'GET .../history: 200');
    eq(hist.body.history.length, 1, 'one former occupant');
    eq(hist.body.history[0].occupant, B1, 'the former occupant is retained');
    eq(hist.body.history[0].reason, 'replaced', 'reason replaced');
    ok(hist.body.history[0].from_ts !== null && hist.body.history[0].to_ts >= hist.body.history[0].from_ts, 'from_ts / to_ts');
    eq((await line(alpha, { text: '/replace @kiosk with recipe:rec-ha#1' })).body.status, 'refused', '/replace with a NOT-live pane is refused');
    const addBind = await line(alpha, { text: '/add solo' });
    eq(addBind.body.status, 'applied', '/add binds a project\'s single live pane');
    const solo = (await call(`/api/rooms/${alpha}`)).body.seats.find((s) => s.handle === 'solo');
    eq(solo?.occupant?.id, 'recipe:rec-solo#1', 'bound to that pane (never spawned)');
    const addNone = await line(alpha, { text: '/add home-ops as @hax' });
    const hax = (await call(`/api/rooms/${alpha}`)).body.seats.find((s) => s.handle === 'hax');
    eq(addNone.body.status, 'applied', '/add of a project with no live pane still seats it');
    eq(hax?.status, 'never-started', 'as never-started');

    /* -------------------------------------------------- recipe delete ---- */
    console.log('\n[recipe DELETE while a seat fills from it]');
    const tmpSeat = await post(`/api/rooms/${alpha}/seats`, { recipe_id: 'rec-tmp' });
    const del = await call('/api/recipes/rec-tmp', { method: 'DELETE' });
    eq(del.status, 409, 'DELETE /api/recipes/:id with an active seat: 409');
    eq(del.body.field, 'id', 'naming field id');
    await call(`/api/rooms/${alpha}/seats/${tmpSeat.body.seat.id}`, { method: 'DELETE' });
    eq((await call('/api/recipes/rec-tmp', { method: 'DELETE' })).status, 200, 'once the seat is given up, the delete goes through');

    console.log('\n[recipe DELETE: an ARCHIVED room whose only seat is its lead no longer pins the recipe]');
    const probeRoom = (await post('/api/rooms', { name: 'Probe room' })).body.id;
    const lockSeat = (await post(`/api/rooms/${probeRoom}/seats`, { recipe_id: 'rec-lock' })).body.seat;
    eq((await call(`/api/rooms/${probeRoom}`)).body.lead?.id, lockSeat.id, 'its only seat is the lead');
    eq((await call(`/api/rooms/${probeRoom}/seats/${lockSeat.id}`, { method: 'DELETE' })).status, 409, 'the lead seat cannot be removed (nobody to hand the lead to)');
    eq((await call('/api/recipes/rec-lock', { method: 'DELETE' })).status, 409, 'open room: the recipe delete is still refused');
    eq((await call(`/api/rooms/${probeRoom}/archive`, { method: 'POST' })).status, 200, 'the room is archived');
    eq((await call(`/api/rooms/${probeRoom}/seats/${lockSeat.id}`, { method: 'DELETE' })).status, 409, 'an archived box still cannot be edited');
    eq((await call('/api/recipes/rec-lock', { method: 'DELETE' })).status, 200, 'archived: the recipe delete goes through (the lock is gone)');
    const probeView = await call(`/api/rooms/${probeRoom}`);
    const kept = probeView.body.seats.find((s) => s.id === lockSeat.id);
    eq(probeView.body.room.state, 'archived', 'the room is still archived');
    eq(kept?.recipe_id, 'rec-lock', 'the archived seat keeps its (now dangling) recipe_id');
    eq(kept?.occupant_kind, 'none', 'occupant_kind unchanged');
    eq(kept?.left_at, null, 'still a member (history intact)');
    same(kept?.actions, [], 'and offers nothing');
    eq((await post(`/api/rooms/${probeRoom}/reopen`, {})).status, 200, 'reopened');
    const reopened = (await call(`/api/rooms/${probeRoom}`)).body.seats.find((s) => s.id === lockSeat.id);
    same(reopened?.actions, [], 'reopened: a seat whose recipe is gone offers no Start');
    eq(reopened?.vendor, 'unknown', 'reopened: its vendor reads unknown, not a guess');

    /* ---------------------------------------------------------- diag ---- */
    console.log('\n[room settings (round 3): colour + default feed, a person only]');
    {
      const S = `/api/rooms/${alpha}/settings`;
      const fresh = (await call(`/api/rooms/${alpha}`)).body.room;
      eq(fresh.color, null, 'GET: color is null until set');
      eq(fresh.feed_default, null, 'GET: feed_default is null until set');
      const bearer = await call(S, { method: 'PATCH', json: { color: '#123456' }, bearer: true });
      eq(bearer.status, 403, 'bearer alone: 403');
      eq(bearer.body?.field, 'credential', '...naming the credential');
      const both = await call(S, { method: 'PATCH', json: { color: '#123456' }, cookie: userCookie, headers: { authorization: `Bearer ${TOKEN}` } });
      eq(both.status, 403, 'cookie AND a bearer: still 403');
      eq((await call(`/api/rooms/${alpha}`)).body.room.color, null, '...and nothing was written');
      const seatId = (await call(`/api/rooms/${alpha}`)).body.seats[0].id;
      const set = await call(S, { method: 'PATCH', json: { color: '#1F8FA6', feed_default: { kinds: ['command', 'chat'], who: seatId } } });
      eq(set.status, 200, 'cookie: 200');
      eq(set.body?.room?.color, '#1f8fa6', 'color stored lower-case');
      same(set.body?.room?.feed_default, { kinds: ['chat', 'command'], who: seatId }, 'feed_default normalised to the line-kind order');
      const got = (await call(`/api/rooms/${alpha}`)).body.room;
      eq(got.color, '#1f8fa6', 'GET /api/rooms/:id exposes color');
      same(got.feed_default, { kinds: ['chat', 'command'], who: seatId }, 'GET /api/rooms/:id exposes feed_default');
      const partial = await call(S, { method: 'PATCH', json: { feed_default: { kinds: ['chat'], who: 'me' } } });
      eq(partial.body?.room?.color, '#1f8fa6', 'an absent field is left alone');
      for (const [body, field, what] of [
        [{ color: 'teal' }, 'color', 'a colour name'],
        [{ color: '#12345' }, 'color', 'a short hex'],
        [{ color: 'oklch(.5 .1 200)' }, 'color', 'a css function'],
        [{ feed_default: { kinds: ['chat', 'gossip'], who: '' } }, 'feed_default', 'an unknown kind'],
        [{ feed_default: { kinds: [], who: 'nobody' } }, 'feed_default', 'a seat not in the room'],
        [{ feed_default: { kinds: [], who: '', extra: 1 } }, 'feed_default', 'an unknown key'],
        [{ feed_default: ['chat'] }, 'feed_default', 'not an object'],
        [{}, 'body', 'neither field'],
      ]) {
        const r = await call(S, { method: 'PATCH', json: body });
        ok(r.status >= 400 && r.status < 500 && r.body?.field === field, `refused: ${what} (${r.status} field ${r.body?.field})`);
      }
      const cleared = await call(S, { method: 'PATCH', json: { color: null, feed_default: null } });
      eq(cleared.status, 200, 'null clears both');
      eq(cleared.body?.room?.color, null, '...color is unset');
      eq(cleared.body?.room?.feed_default, null, '...feed_default is unset');
      const facts = (await call(`/api/rooms/${alpha}/line?limit=5`)).body.entries.filter((e) => /colou?r|feed/.test(e.body));
      eq(facts.length, 0, 'a view preference writes no line fact');
    }

    console.log('\n[room character v1.1 [rooms/character]: the art key, a person only; style is the ART\'s, drawn as a pane draws it]');
    {
      const S = `/api/rooms/${alpha}/settings`;
      const fresh = (await call(`/api/rooms/${alpha}`)).body.room;
      eq(fresh.art, null, 'GET: art is null until set');
      ok(!('art_colors' in fresh), 'no art_colors on the room (final ruling: the art renders exactly as a pane does)');
      eq(fresh.art_render, null, 'GET: art_render is null with no art');
      ok(!('art_style' in fresh), 'no art_style on the room (v1.1: style belongs to the art)');
      /* a library set, with its own treatment (applies as stored) */
      const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="#ff0000" d="M0 0h10v10H0z"/></svg>';
      const made = await post('/api/logos', { name: 'Room Char Test', svg: SVG });
      const libId = made.body?.logo?.id;
      ok(Number.isInteger(libId), `a library set to wear (id ${libId})`);
      const styled = await call(`/api/logos/${libId}`, { method: 'PATCH', json: { style: { line: 'hatch', washFrom: 'ur', backlit: false, scale: 60, opacity: 22 } } });
      eq(styled.status, 200, "the set gets its own treatment (Icons page)");
      const bearer = await call(S, { method: 'PATCH', json: { art: 'speech' }, bearer: true });
      eq(bearer.status, 403, "bearer alone: 403 (a person's setting)");
      eq(bearer.body?.field, 'credential', '...naming the credential');
      eq((await call(`/api/rooms/${alpha}`)).body.room.art, null, '...and nothing was written');
      const pre = await call(S, { method: 'PATCH', json: { art: 'speech' } });
      eq(pre.status, 200, 'a preset key: 200');
      eq(pre.body?.room?.art, 'speech', '...stored as the key');
      eq(pre.body?.room?.art_render?.name, 'speech', '...art_render names it');
      ok(/^<svg/.test(pre.body?.room?.art_render?.svg ?? ''), '...and carries the SVG the page draws');
      eq(pre.body?.room?.art_render?.style, null, '...a preset has no stored style (the page defaults apply)');
      const lib = await call(S, { method: 'PATCH', json: { art: `lib:${libId}` } });
      eq(lib.status, 200, 'a library key: 200');
      eq(lib.body?.room?.art, `lib:${libId}`, '...art stored');
      eq(lib.body?.room?.art_render?.svg, SVG, '...art_render.svg is the art AS AUTHORED (its colours intact)');
      const st = JSON.parse(lib.body?.room?.art_render?.style ?? 'null');
      same(st && { line: st.line, washFrom: st.washFrom, backlit: st.backlit, scale: st.scale, opacity: st.opacity },
        { line: 'hatch', washFrom: 'ur', backlit: false, scale: 60, opacity: 22 }, "...art_render.style is the art's own, as stored");
      const view = (await call(`/api/rooms/${alpha}`)).body.room;
      eq(view.art, `lib:${libId}`, 'GET /api/rooms/:id carries art');
      eq(view.art_render?.name, 'Room Char Test', '...and art_render');
      const listed = (await call('/api/rooms')).body.find?.((v) => v.room?.id === alpha)?.room;
      eq(listed?.art, `lib:${libId}`, 'GET /api/rooms (the list) carries art');
      eq(listed?.art_render?.name, 'Room Char Test', '...and art_render');
      const partial = await call(S, { method: 'PATCH', json: { color: '#b83b5e' } });
      eq(partial.body?.room?.art, `lib:${libId}`, 'an absent art field is left alone');
      for (const [body, field, what] of [
        [{ art: 'nope-not-a-preset' }, 'art', 'a key that names no art'],
        [{ art: 'lib:999999' }, 'art', 'a library id that does not exist'],
        [{ art: '<svg/>' }, 'art', 'raw SVG instead of a key'],
        [{ art: 42 }, 'art', 'not a string'],
        [{ art_colors: true }, 'body', 'art_colors is not a room setting (final ruling)'],
        [{ art_style: { line: 'hatch' } }, 'body', 'art_style is not a room setting (v1.1)'],
      ]) {
        const r = await call(S, { method: 'PATCH', json: body });
        ok(r.status === 400 && r.body?.field === field, `refused: ${what} (${r.status} field ${r.body?.field})`);
      }
      eq((await call(`/api/rooms/${alpha}`)).body.room.art, `lib:${libId}`, 'a refused PATCH wrote nothing');
      ok((await call(`/api/logos/${libId}`, { method: 'DELETE' })).status < 300, 'the set is deleted from the library');
      const gone = (await call(`/api/rooms/${alpha}`)).body.room;
      eq(gone.art, `lib:${libId}`, 'a deleted set: the key stays (reversible)');
      eq(gone.art_render, null, '...but art_render is null (nothing to draw, no hole)');
      const cleared = await call(S, { method: 'PATCH', json: { art: null, color: null } });
      eq(cleared.status, 200, 'null clears');
      eq(cleared.body?.room?.art, null, '...art unset');
      eq(cleared.body?.room?.art_render, null, '...art_render null');
      const facts = (await call(`/api/rooms/${alpha}/line?limit=5`)).body.entries.filter((e) => /\bart\b/.test(e.body));
      eq(facts.length, 0, 'a view preference writes no line fact');
    }

    console.log('\n[your picture (room authorship v2): per user, a person only, a checked data: URL]');
    {
      const PIC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const none = await call('/api/rooms/me');
      eq(none.status, 200, 'GET /api/rooms/me: 200');
      eq(none.body?.picture, null, '...no picture until one is set');
      const bearer = await call('/api/rooms/me', { method: 'PATCH', json: { picture: PIC }, bearer: true });
      eq(bearer.status, 403, 'bearer alone: 403');
      eq(bearer.body?.field, 'credential', '...naming the credential');
      const both = await call('/api/rooms/me', { method: 'PATCH', json: { picture: PIC }, cookie: userCookie, headers: { authorization: `Bearer ${TOKEN}` } });
      eq(both.status, 403, 'cookie AND a bearer: still 403');
      eq((await call('/api/rooms/me')).body?.picture, null, '...and nothing was written');
      const set = await call('/api/rooms/me', { method: 'PATCH', json: { picture: PIC }, cookie: userCookie });
      eq(set.status, 200, 'cookie: 200');
      eq(set.body?.picture, PIC, '...the picture comes back');
      eq((await call('/api/rooms/me', { cookie: userCookie })).body?.picture, PIC, 'GET reads it back');
      for (const [picture, status, what] of [
        ['https://example.com/me.png', 400, 'a URL'],
        ['data:image/svg+xml;base64,PHN2Zy8+', 400, 'an SVG'],
        [PIC.replace('image/png', 'image/webp'), 400, 'bytes that are not the declared type'],
        [`data:image/png;base64,${'A'.repeat(400_000)}`, 413, 'over the stored cap'],
      ]) {
        const r = await call('/api/rooms/me', { method: 'PATCH', json: { picture }, cookie: userCookie });
        ok(r.status === status && r.body?.field === 'picture', `refused: ${what} (${r.status} field ${r.body?.field})`);
      }
      const noField = await call('/api/rooms/me', { method: 'PATCH', json: {}, cookie: userCookie });
      ok(noField.status === 400 && noField.body?.field === 'picture', `refused: no picture field (${noField.status})`);
      eq((await call('/api/rooms/me', { method: 'DELETE', cookie: userCookie })).status, 405, 'DELETE: 405 (null clears)');
      const cleared = await call('/api/rooms/me', { method: 'PATCH', json: { picture: null }, cookie: userCookie });
      eq(cleared.body?.picture, null, 'null clears it');
    }

    console.log('\n[global color palette + app title-bar tones (hub V2): per person, validated]');
    {
      const me0 = (await call('/api/rooms/me')).body;
      same(me0?.palette, { key: 'aurora', mode: 'dark' }, 'GET /api/rooms/me: palette defaults to Auriga dark');
      same(me0?.tones, {}, '...tones {} (every app on its own default)');
      const bearer = await call('/api/rooms/me', { method: 'PATCH', json: { palette: { key: 'ocean', mode: 'light' } }, bearer: true });
      eq(bearer.status, 403, 'a bearer cannot write a palette: 403');
      const custom = { ink: '#101010', surface: '#202020', text: '#EEEEEE', accent: '#22CCAA', neutral: '#888888', cobalt: '#3355ff', green: '#33aa55', orchid: '#cc55cc', violet: '#7755ee', orange: '#ee8833' };
      const set = await call('/api/rooms/me', { method: 'PATCH', json: { palette: { key: 'ocean', mode: 'light', custom } }, cookie: userCookie });
      ok(set.status === 200 && set.body?.palette?.key === 'ocean' && set.body?.palette?.mode === 'light', `a person sets a palette (${set.status})`);
      eq(set.body?.palette?.custom?.text, '#eeeeee', '...hex normalised to lowercase');
      const keep = await call('/api/rooms/me', { method: 'PATCH', json: { palette: { key: 'forest', mode: 'dark' } }, cookie: userCookie });
      eq(keep.body?.palette?.custom?.accent, '#22ccaa', 'switching palette keeps the stored custom set');
      const toCustom = await call('/api/rooms/me', { method: 'PATCH', json: { palette: { key: 'custom', mode: 'dark' } }, cookie: userCookie });
      eq(toCustom.body?.palette?.key, 'custom', '...and key custom reuses it');
      for (const [palette, field, what] of [
        [{ key: 'neon', mode: 'dark' }, 'palette.key', 'an unknown palette key'],
        [{ key: 'ocean', mode: 'sepia' }, 'palette.mode', 'a mode that is not dark|light'],
        [{ key: 'ocean' }, 'palette.mode', 'no mode'],
        ['ocean', 'palette', 'not an object'],
        [{ key: 'ocean', mode: 'dark', custom: { ...custom, ink: 'red' } }, 'palette.custom.ink', 'a custom color that is not #rrggbb'],
        [{ key: 'ocean', mode: 'dark', custom: { ...custom, extra: '#000000' } }, 'palette.custom.extra', 'a custom key that is not a palette color'],
        [{ key: 'ocean', mode: 'dark', custom: { ink: '#000000' } }, 'palette.custom.surface', 'a custom set missing colors'],
      ]) {
        const r = await call('/api/rooms/me', { method: 'PATCH', json: { palette }, cookie: userCookie });
        ok(r.status === 400 && r.body?.field === field, `refused: ${what} (${r.status} field ${r.body?.field})`);
      }
      eq((await call('/api/rooms/me', { cookie: userCookie })).body?.palette?.key, 'custom', '...none of them was written');
      const reset = await call('/api/rooms/me', { method: 'PATCH', json: { palette: null }, cookie: userCookie });
      same(reset.body?.palette, { key: 'aurora', mode: 'dark' }, 'palette:null resets to Auriga dark');
      const t1 = await call('/api/rooms/me', { method: 'PATCH', json: { tones: { tasks: 'violet', assets: 'orange' } }, cookie: userCookie });
      same(t1.body?.tones, { tasks: 'violet', assets: 'orange' }, 'tones set per app');
      const t2 = await call('/api/rooms/me', { method: 'PATCH', json: { tones: { tasks: null, voice: 'green' } }, cookie: userCookie });
      same(t2.body?.tones, { assets: 'orange', voice: 'green' }, 'tones merge per key; null clears one app');
      for (const [tones, field, what] of [
        [{ tasks: 'teal' }, 'tones.tasks', 'a tone that is not one of the five'],
        [{ tasks: 7 }, 'tones.tasks', 'a non-string tone'],
        [{ 'Bad Key': 'green' }, 'tones.Bad Key', 'an app key off the grammar'],
        [['cobalt'], 'tones', 'not an object'],
      ]) {
        const r = await call('/api/rooms/me', { method: 'PATCH', json: { tones }, cookie: userCookie });
        ok(r.status === 400 && r.body?.field === field, `refused: ${what} (${r.status} field ${r.body?.field})`);
      }
      const mixedBad = await call('/api/rooms/me', { method: 'PATCH', json: { palette: { key: 'rose', mode: 'dark' }, tones: { tasks: 'teal' } }, cookie: userCookie });
      eq(mixedBad.status, 400, 'a good palette + bad tones: 400');
      same((await call('/api/rooms/me', { cookie: userCookie })).body?.palette, { key: 'aurora', mode: 'dark' }, '...all-or-nothing: the palette was not written');
      await call('/api/rooms/me', { method: 'PATCH', json: { tones: { assets: null, voice: null } }, cookie: userCookie });
    }

    console.log('\n[hidden rooms (CLI Manager): per person, a person only, existing room ids]');
    {
      const me0 = await call('/api/rooms/me');
      same(me0.body?.hiddenRooms, [], 'GET /api/rooms/me: hiddenRooms [] until set');
      const bearer = await call('/api/rooms/me', { method: 'PATCH', json: { hiddenRooms: [alpha] }, bearer: true });
      eq(bearer.status, 403, 'bearer alone: 403');
      eq(bearer.body?.field, 'credential', '...naming the credential');
      const set = await call('/api/rooms/me', { method: 'PATCH', json: { hiddenRooms: [alpha, alpha] }, cookie: userCookie });
      eq(set.status, 200, 'cookie: 200');
      same(set.body?.hiddenRooms, [alpha], '...deduped');
      eq(set.body?.picture, null, '...and the picture is untouched (and reported)');
      same((await call('/api/rooms/me')).body?.hiddenRooms, [alpha], 'GET reads it back');
      ok((await call('/api/rooms')).body.some((r) => r.room?.id === alpha), 'GET /api/rooms still lists the hidden room');
      for (const [hiddenRooms, status, what] of [
        ['x', 400, 'not an array'],
        [['no-such-room'], 400, 'an unknown room id'],
        [Array.from({ length: 501 }, (_, i) => `r${i}`), 413, 'over the cap'],
      ]) {
        const r = await call('/api/rooms/me', { method: 'PATCH', json: { hiddenRooms }, cookie: userCookie });
        ok(r.status === status && r.body?.field === 'hiddenRooms', `refused: ${what} (${r.status} field ${r.body?.field})`);
      }
      const PIC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const mixedBad = await call('/api/rooms/me', { method: 'PATCH', json: { picture: PIC, hiddenRooms: ['nope'] }, cookie: userCookie });
      eq(mixedBad.status, 400, 'picture + a bad hiddenRooms: 400');
      eq((await call('/api/rooms/me')).body?.picture, null, '...all-or-nothing: the picture was not written');
      const both = await call('/api/rooms/me', { method: 'PATCH', json: { picture: PIC, hiddenRooms: [alpha, seeded.id] }, cookie: userCookie });
      ok(both.status === 200 && both.body?.picture === PIC && JSON.stringify(both.body?.hiddenRooms) === JSON.stringify([alpha, seeded.id]), 'one PATCH may carry both');
      const unhide = await call('/api/rooms/me', { method: 'PATCH', json: { hiddenRooms: [], picture: null }, cookie: userCookie });
      ok(unhide.status === 200 && unhide.body?.hiddenRooms?.length === 0 && unhide.body?.picture === null, '[] unhides, null clears');
    }

    console.log('\n[your @name: per person, app-wide, a person only; the line reads it as the user]');
    {
      const PIC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const me0 = await call('/api/rooms/me');
      eq(me0.body?.handle, 'probe', 'GET /api/rooms/me: handle defaults to the account name (the single admin)');
      const bearer = await call('/api/rooms/me', { method: 'PATCH', json: { handle: 'owner' }, bearer: true });
      eq(bearer.status, 403, 'bearer PATCH {handle}: 403');
      eq(bearer.body?.field, 'credential', '...naming the credential');
      eq((await call('/api/rooms/me')).body?.handle, 'probe', '...and nothing was written');
      const set = await call('/api/rooms/me', { method: 'PATCH', json: { handle: '@Owner' }, cookie: userCookie });
      eq(set.status, 200, 'cookie PATCH {handle: "@Owner"}: 200');
      eq(set.body?.handle, 'owner', '...one leading @ and case normalised');
      eq(set.body?.picture, null, '...and the picture is untouched (and reported)');
      eq((await call('/api/rooms/me')).body?.handle, 'owner', 'GET reads it back');
      for (const [handle, status, what] of [
        ['Two Words', 400, 'off the grammar (a space)'],
        ['a--b', 400, 'a double hyphen'],
        ['x'.repeat(65), 400, 'over 64'],
        [7, 400, 'not a string'],
        ['lead', 400, 'reserved @lead'],
        ['room', 400, 'reserved @room'],
        ['all', 400, 'reserved @all'],
        ['user', 400, 'reserved @user'],
        ['kiosk', 409, 'an active seat handle (this room)'],
        ['ghost', 409, 'an active seat handle in another room (Seeded)'],
      ]) {
        const r = await call('/api/rooms/me', { method: 'PATCH', json: { handle }, cookie: userCookie });
        ok(r.status === status && r.body?.field === 'handle', `refused: ${what} (${r.status} field ${r.body?.field}: ${r.body?.error})`);
      }
      eq((await call('/api/rooms/me')).body?.handle, 'owner', '...none of them was written');
      const mixedBad = await call('/api/rooms/me', { method: 'PATCH', json: { picture: PIC, handle: 'lead' }, cookie: userCookie });
      eq(mixedBad.status, 400, 'picture + a bad handle: 400');
      eq((await call('/api/rooms/me')).body?.picture, null, '...all-or-nothing: the picture was not written');

      console.log('  [the line: "@owner ..." is to the user]');
      const agentHi = await line(alpha, { text: '@owner hi, the build is green', from: { paneid: A1 } });
      eq(agentHi.status, 200, 'an agent (bearer + from) posts "@owner hi": 200');
      ok(agentHi.body?.status !== 'refused', `...not refused (${agentHi.body?.status}: ${agentHi.body?.error ?? ''})`);
      const e0 = agentHi.body?.entries?.[0];
      ok(e0?.kind === 'chat' && e0?.target === 'owner' && e0?.target_seat === null, `...stored as a chat to @owner with no seat (target ${e0?.target}, seat ${e0?.target_seat})`);
      eq(JSON.parse(e0?.meta ?? '{}').to_user, true, '...with meta.to_user (the page reads it, never infers)');
      eq(agentHi.body?.deliveries?.length ?? 0, 0, '...delivered to no seat (the lead is not the default)');
      eq(agentHi.body?.entries?.length, 1, '...and no delivery report entries');
      const agentBoth = await line(alpha, { text: '@owner @kiosk please both look', from: { paneid: A1 } });
      if (!agentBoth.body?.deliveries) console.log(JSON.stringify(agentBoth.body), JSON.stringify((await call(`/api/rooms/${alpha}`)).body.seats.map((x) => x.handle)));
      const eb = agentBoth.body?.entries?.[0];
      ok(
        eb?.target === 'kiosk' && !!eb?.target_seat && JSON.parse(eb?.meta ?? '{}').to_user === true && agentBoth.body?.deliveries?.length === 1 && agentBoth.body.deliveries[0].handle === 'kiosk',
        `"@owner @kiosk ...": to the seat @kiosk AND to the user (meta.to_user) (${eb?.target}/${eb?.target_seat}, ${JSON.stringify(agentBoth.body?.deliveries?.map((d) => d.handle))})`,
      );
      console.log('  [the line: "@user ..." is to the user too, for every author (2026-09-28)]');
      const agentUser = await line(alpha, { text: '@user the build is green', from: { paneid: A1 } });
      const eu = agentUser.body?.entries?.[0];
      ok(
        agentUser.body?.status !== 'refused' && eu?.target === 'owner' && eu?.target_seat === null && JSON.parse(eu?.meta ?? '{}').to_user === true,
        `an agent (bearer + from) "@user ...": stored target = the handle (normalised), no seat, meta.to_user (${agentUser.body?.status} ${eu?.target}/${eu?.target_seat} ${eu?.meta})`,
      );
      eq(agentUser.body?.deliveries?.length ?? 0, 0, '...typed into nobody (the user is not a seat)');
      const agentUserMid = await line(alpha, { text: 'done, over to @user for the call', from: { paneid: A1 } });
      const eum = agentUserMid.body?.entries?.[0];
      /* [address only] 2026-10-07: naming the user anywhere IS an address, so the lead is no longer added */
      ok(eum?.target_seat === null && eum?.target === null && JSON.parse(eum?.meta ?? '{}').to_user === true, `"... @user" mid-text: to the user, no seat (no lead copy), meta.to_user (${eum?.target_seat} ${eum?.meta})`);
      const humanUser = await line(alpha, { text: '@user note to self' });
      const ehu = humanUser.body?.entries?.[0];
      ok(ehu?.author === 'user' && ehu?.target === 'owner' && ehu?.target_seat === null, `the person's own "@user ...": the same shape (${ehu?.target}/${ehu?.target_seat})`);
      const plain = await line(alpha, { text: 'just a status line', from: { paneid: A1 } });
      eq(JSON.parse(plain.body?.entries?.[0]?.meta ?? '{}').to_user, true, 'an agent line that names nobody is to the person: meta.to_user (Owner [ref])');
      const unknownStill = await line(alpha, { text: '@erik hi', from: { paneid: A1 } });
      eq(unknownStill.body?.status, 'refused', 'an unknown @word leading the line is still refused');
      const mention = await line(alpha, { text: 'tell @owner when it lands' });
      const em = mention.body?.entries?.[0];
      ok(em?.target === null && em?.target_seat === null && JSON.parse(em?.meta ?? '{}').to_user === true, "the user's @name mid-text: to the user, no seat (no lead copy since 2026-10-07 [address only]), meta.to_user");
      const reset = await call('/api/rooms/me', { method: 'PATCH', json: { handle: null }, cookie: userCookie });
      eq(reset.body?.handle, 'probe', 'null returns to the default');
      eq((await line(alpha, { text: '@owner hi', from: { paneid: A1 } })).body?.status, 'refused', '...and @owner is no longer the user');
      const aliasStill = (await line(alpha, { text: '@user hi', from: { paneid: A1 } })).body?.entries?.[0];
      eq(aliasStill?.target, 'probe', '...while @user still is, normalised to the handle in force');
      eq((await call('/api/rooms/me', { method: 'PATCH', json: { handle: 'owner' }, cookie: userCookie })).body?.handle, 'owner', 'set back to owner');
    }

    console.log('\n[room draft: per person per room, a person only (read AND write), cleared by their post]');
    {
      const D = `/api/rooms/${alpha}/draft`;
      const SECRET = 'draft-marker-7f3a unsent words';
      eq((await call(D, { auth: false })).status, 401, 'no credential: 401');
      const bGet = await call(D, { bearer: true });
      eq(bGet.status, 403, 'bearer GET: 403 (an agent never reads the unsent words)');
      eq(bGet.body?.field, 'credential', '...naming the credential');
      eq((await call(D, { method: 'PUT', json: { text: 'x' }, bearer: true })).status, 403, 'bearer PUT: 403');
      eq((await call(D, { cookie: userCookie, headers: { authorization: `Bearer ${TOKEN}` } })).status, 403, 'cookie AND a bearer: 403');
      const fresh = (await post('/api/rooms', { name: 'Draftless' })).body.id;
      const none = await call(`/api/rooms/${fresh}/draft`, { cookie: userCookie });
      eq(none.status, 200, 'cookie GET: 200');
      same(none.body, { text: '', updatedAt: null, reply_to: null, reply: null }, '...no draft (and no reply target) until one is written');
      const earlier = (await call(D, { cookie: userCookie })).body;
      ok(earlier?.text === '' && typeof earlier?.updatedAt === 'number', "the person's earlier lines in this room already left a cleared draft (with a time)");
      const put = await call(D, { method: 'PUT', json: { text: SECRET }, cookie: userCookie });
      ok(put.status === 200 && put.body?.text === SECRET && typeof put.body?.updatedAt === 'number', 'cookie PUT: 200, text + updatedAt');
      eq((await call(D, { cookie: userCookie })).body?.text, SECRET, 'GET reads it back');
      eq((await call(`/api/rooms/${fresh}/draft`, { cookie: userCookie })).body?.text, '', 'per room: another room has none');
      /* ticket: a draft SURVIVES past the line's own send cap (4000) — its
         own cap is DRAFT_BODY_MAX (16000), higher on purpose (a long message
         being typed must not lose itself before it is even over the limit
         that blocks SENDING it). Over 16000 is still refused, naming both
         numbers. */
      const big = await call(D, { method: 'PUT', json: { text: 'y'.repeat(4001) }, cookie: userCookie });
      ok(big.status === 200 && big.body?.text === 'y'.repeat(4001), 'a draft OVER the 4000 send limit still saves (200)');
      const restored = await call(D, { method: 'PUT', json: { text: SECRET }, cookie: userCookie });
      ok(restored.status === 200, '...back to the marker (setup)');
      const tooBig = await call(D, { method: 'PUT', json: { text: 'y'.repeat(16001) }, cookie: userCookie });
      ok(tooBig.status === 413 && tooBig.body?.field === 'text' && /16001/.test(tooBig.body?.error) && /16000/.test(tooBig.body?.error), `over the draft limit (16000): 413 with both numbers (${tooBig.body?.error})`);
      eq((await call(D, { cookie: userCookie })).body?.text, SECRET, '...and nothing was written');
      eq((await call(D, { method: 'PUT', json: { text: 7 }, cookie: userCookie })).status, 400, 'a non-string: 400');
      eq((await call(D, { method: 'DELETE', cookie: userCookie })).status, 405, "DELETE: 405 ('' clears)");
      eq((await call('/api/rooms/no-such-room/draft', { cookie: userCookie })).status, 404, 'an unknown room: 404');
      const refused = await line(alpha, { text: '/frobnicate' });
      eq(refused.body?.status, 'refused', 'a refused line (setup)');
      eq((await call(D, { cookie: userCookie })).body?.text, SECRET, '...keeps the draft (the composer still holds it)');
      const seatPost = await line(alpha, { text: 'a seat speaks', from: { paneid: A1 } });
      eq(seatPost.status, 200, 'a seat posts (setup)');
      eq((await call(D, { cookie: userCookie })).body?.text, SECRET, "...a seat's line does not clear the user's draft");
      const sent = await line(alpha, { text: 'the words, sent' });
      eq(sent.status, 200, 'the person posts a line');
      const after = (await call(D, { cookie: userCookie })).body;
      ok(after?.text === '' && typeof after?.updatedAt === 'number', 'their post CLEARED the draft (with a time)');
      await call(D, { method: 'PUT', json: { text: SECRET }, cookie: userCookie });
      const cleared = await call(D, { method: 'PUT', json: { text: '' }, cookie: userCookie });
      eq(cleared.body?.text, '', "'' clears it");
      eq(engineLog.includes('draft-marker-7f3a'), false, 'the draft text is never in the engine log');
    }

    console.log('\n[GET /api/diag/rooms — the §2.6 shape, key by key]');
    const d = (await call('/api/diag/rooms')).body;
    same(Object.keys(d), ['rooms', 'refusedCommands', 'pendingConfirms', 'subscribers', 'typing', 'reads'], 'top-level keys');
    ok(d.reads.entries >= 1 && d.reads.byState.seen >= 1 && d.reads.byState['not-yet'] >= 1 && d.reads.byState.unknown >= 1, 'reads: counts by state, all three seen in this run');
    eq(JSON.stringify(d.reads).includes('hello-one'), false, 'reads diag carries no message content');
    eq(d.typing.enabled, true, 'typing: on by default');
    eq(d.typing.panes[A1]?.lastResult, 'held:not-live', 'typing: A1 held — no resident pty in this engine');
    ok(d.typing.panes[A1]?.depth >= 1, 'typing: A1 queue depth counted');
    eq(JSON.stringify(d.typing).includes('hello-one'), false, 'typing diag carries no message content');
    const dr = d.rooms.find((r) => r.id === alpha);
    same(Object.keys(dr), ['id', 'state', 'lead_seat', 'idle_ms', 'seats', 'lineCounts'], 'room keys');
    eq(typeof dr.idle_ms, 'number', 'idle_ms is a number');
    same(Object.keys(dr.seats[0]), ['id', 'handle', 'policy', 'occupant_kind', 'occupant', 'status', 'sessionState', 'held'], 'seat keys');
    same(Object.keys(dr.lineCounts), ['chat', 'fact', 'delivery', 'attachment', 'command', 'voice'], 'lineCounts keys');
    ok(dr.lineCounts.chat > 0 && dr.lineCounts.delivery > 0 && dr.lineCounts.command > 0, 'lineCounts count');
    const drSeeded = d.rooms.find((r) => r.id === seeded.id);
    eq(drSeeded.seats.find((s) => s.handle === 'ha')?.sessionState, 'dehydrated', 'sessionState is the occupant row state');
    eq(drSeeded.seats.find((s) => s.handle === 'ghost')?.sessionState, null, 'null with no occupant');
    ok(d.refusedCommands.length > 0, 'refused commands are recorded');
    same(Object.keys(d.refusedCommands[0]), ['ts', 'roomId', 'input', 'suggestion'], 'refused record keys');
    ok(d.refusedCommands.some((r) => r.input === '/frobnicate'), 'including the unknown command');
    eq(typeof d.pendingConfirms, 'number', 'pendingConfirms is a count');
    eq(d.subscribers, 0, 'subscribers is a count (0: no socket subscribed)');

    console.log('\n[held: the typed queue a seat is holding, on the seat and in the diag]');
    const tpA1 = d.typing.panes[A1];
    eq(tpA1?.held?.reason, 'not-live', 'typing diag: A1 held — reason not-live');
    eq(tpA1?.held?.depth, tpA1?.depth, 'typing diag: held.depth is the queue depth');
    eq(typeof tpA1?.held?.since, 'number', 'typing diag: held.since is a time');
    const diagSeatA1 = dr.seats.find((s) => s.occupant === A1);
    eq(diagSeatA1?.held?.reason, 'not-live', 'diag seat carries the same held object');
    const alphaSeats = (await call(`/api/rooms/${alpha}`)).body.seats;
    const heldSeat = alphaSeats.find((s) => s.occupant?.id === A1);
    eq(heldSeat?.occupant?.held?.reason, 'not-live', 'GET room: occupant.held.reason');
    ok(heldSeat?.occupant?.held?.depth >= 1, 'GET room: occupant.held.depth');
    const seatQuiet = alphaSeats.find((s) => s.occupant && s.occupant.id !== A1 && !s.occupant.held);
    ok(!!seatQuiet, 'a seat with nothing waiting has NO held field (absent, not null)');
    eq(JSON.stringify(alphaSeats).includes('hello-one'), false, 'held never carries message content');

    console.log('\n[POST /api/panes/:id/deliver-held — a HUMAN credential only]');
    const dh = (p, extra) => call(`/api/panes/${encodeURIComponent(p)}/deliver-held`, { method: 'POST', ...extra });
    const byBearer = await dh(A1);
    eq(byBearer.status, 403, 'bearer (an agent\'s credential): 403');
    eq(byBearer.body?.field, 'credential', 'naming the credential');
    eq((await dh(A1, { auth: false })).status, 401, 'no credential: 401');
    const legacy = await post('/login', { token: TOKEN }, { auth: false });
    const legacyCookie = (legacy.res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    ok(/wb_auth=/.test(legacyCookie), 'the shared-token browser login issues the window cookie');
    eq((await dh(A1, { cookie: legacyCookie })).status, 403, 'in mode both the shared-token window cookie is NOT a person: 403 (derivable from the bearer)');
    const both = await dh(A1, { cookie: userCookie, headers: { authorization: `Bearer ${TOKEN}` } });
    eq(both.status, 403, 'cookie AND a bearer on one request: still 403 (an agent can carry a cookie too)');
    eq((await dh('recipe:nope#1', { cookie: userCookie })).status, 404, 'cookie + an unknown pane: 404');
    const notLive = await dh(A1, { cookie: userCookie });
    eq(notLive.status, 404, 'cookie + a live ROW with no resident pty: 404 (nothing to type into)');
    eq(notLive.body?.field, 'paneid', 'naming the pane');
    const malformed = await call('/api/panes/%E0%A4%A/deliver-held', { method: 'POST', cookie: userCookie });
    eq(malformed.status, 400, 'a malformed pane encoding: 400, never a throw');

    console.log('\n[/api/table still answers through projectRow]');
    const tbl = await call('/api/table');
    eq(tbl.status, 200, '/api/table: 200');
    eq(tbl.body.sessions.find((r) => r.paneid === 'recipe:rec-ha#1')?.activity, 'disconnected', 'same decoration as before');

    /* ---------------------------------------------- GET .../line?to=me ---- */
    console.log('\n[GET .../line?to=me: the page is cut AFTER the To-me rule (web/to-me.mjs)]');
    const tm = (await post('/api/rooms', { name: 'ToMe' })).body.id;
    const tmSeat = await post(`/api/rooms/${tm}/seats`, { recipe_id: 'rec-barn', occupant: FREE });
    await post(`/api/rooms/${tm}/seats`, { recipe_id: 'rec-ha', handle: 'helper' });
    ok(tmSeat.status === 200, 'a fresh room with a live seat and a second seat', tmSeat.body);
    const lastBefore = (await call(`/api/rooms/${tm}/line?limit=1`)).body.entries[0]?.id ?? 0;
    const mine = [];
    for (let i = 1; i <= 5; i++) {
      const r = await line(tm, { text: `@user please look at item ${i}`, from: { paneid: FREE } });
      mine.push(r.body?.entries?.[0]?.id);
    }
    ok(mine.length === 5 && mine.every((id) => typeof id === 'number'), 'five agent lines naming the person (to_user)');
    let chatter = 0;
    for (let i = 1; i <= 310; i++) {
      const r = await line(tm, { text: `@helper seat to seat ${i}`, from: { paneid: FREE } });
      chatter += r.status === 200 ? 1 : 0;
    }
    eq(chatter, 310, 'then 310 agent-to-agent lines (not to the person)');
    const meNew = await call(`/api/rooms/${tm}/line?to=me&limit=50&since=${lastBefore}`);
    eq(meNew.status, 200, 'to=me answers 200');
    same(meNew.body.entries.map((e) => e.id), mine, 'all five lines to the person come back, past 310 lines between agents (since)');
    const meNewest = await call(`/api/rooms/${tm}/line?to=me&limit=5`);
    same(meNewest.body.entries.map((e) => e.id), mine, 'the newest page of 5 (no cursor) is those five, not the 5 newest lines');
    const meBefore = await call(`/api/rooms/${tm}/line?to=me&limit=2&before=${mine[4]}`);
    same(meBefore.body.entries.map((e) => e.id), [mine[2], mine[3]], 'before pages OLDER lines to the person only');
    const everyone = await call(`/api/rooms/${tm}/line?limit=100`);
    eq(everyone.body.entries.length, 100, 'Everyone is unchanged: a full page of whatever came last');
    ok(everyone.body.entries.some((e) => /seat to seat/.test(e.body ?? '')), '...including the agent-to-agent lines');
    eq((await call(`/api/rooms/${tm}/line?to=bogus`)).status, 400, 'an unknown to= is a 400, never silently everything');
  } catch (e) {
    failed++;
    failures.push(String(e?.stack ?? e));
    console.log(`  ✗ threw: ${e?.stack ?? e}`);
  } finally {
    if (engine) {
      engine.kill('SIGKILL');
      await sleep(200);
    }
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
