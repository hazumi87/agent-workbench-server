/**
 * ASSEMBLE ROOM, S0 engine half (the design notes §4.1, §4.2, §5.3, §8)
 * through a real scratch engine [ticket]:
 *
 *   - GET /api/sessions/readiness: fast fields, the candidate list (paneids
 *     omitted = every live + dehydrated row), `unknown`, every seat reason,
 *     `claudeRunning` from a FAKE /proc root, `queued`, `channel`;
 *   - POST /api/rooms/assemble: atomic create + bind + lead; one refused row →
 *     nothing written; dry-run handles == real handles (auto-suffix included);
 *     the key rules; lead rules; authority (omitted `from` needs a person, a
 *     lead via `from`); dehydrated rows (`needs-you`, `restorable-later`,
 *     seated with the switch on); requireSeatablePane (§4.3: persistent seat
 *     policy, a recipe pane of its own recipe, resumable, no other live row,
 *     a person, the switch); `handle-taken`; `already`; conventions;
 *   - one vocabulary: readiness `seat.reason` == assemble's refusal reason;
 *   - GET /health `flags`, read live from a temp config.json.
 *
 * Same pattern as rooms-routes.test.mjs: our own engine on P() ports, a temp
 * db seeded through the store (test/rooms-routes.seed.ts), NO broker, NO pty.
 * Identity is legacy: the bearer is the agent's credential, the /login cookie
 * the person's.
 *
 * SAFETY: never touches :7420/:7430/:8200/:8201/:8204, the real data dir,
 * real processes, or a broker. Every child env comes from childEnv().
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, utimesSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(94);
const DEAD_BROKER_PORT = P(95);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'assemble-test-token';

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

let cookie = '';
async function call(path, opts = {}) {
  const headers = {};
  if (opts.as === 'person') {
    headers.cookie = cookie;
  } else if (opts.as !== 'nobody') {
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
const person = (json) => call('/api/rooms/assemble', { json, as: 'person' });
const agent = (json) => call('/api/rooms/assemble', { json });
const ready = (qs = '', as = 'person') => call(`/api/sessions/readiness${qs}`, { as });

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

/** A fake /proc root: A1 runs an interactive claude that owns its tty; B1's
 *  claude is stopped with bash in the foreground (guard 9: no). */
function procRoot(dir, rows) {
  mkdirSync(dir);
  for (const p of rows) {
    const d = join(dir, String(p.pid));
    mkdirSync(d);
    writeFileSync(join(d, 'comm'), `${p.comm}\n`);
    writeFileSync(join(d, 'cmdline'), [p.comm, ...(p.args ?? [])].join('\0') + '\0');
    writeFileSync(join(d, 'environ'), `HARBOR_WB_PANEID=${p.pane}\0`);
    const f = [p.state ?? 'S', p.ppid ?? 1, p.pgrp ?? p.pid, p.pgrp ?? p.pid, 34816, p.tpgid ?? p.pgrp ?? p.pid, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 1, 0, p.pid * 10, 0, 0];
    writeFileSync(join(d, 'stat'), `${p.pid} (${p.comm}) ${f.join(' ')}\n`);
    if (process.platform === 'linux') {
      // stdin and stdout on the pane's pty (tty_nr 34816). Linux only: the
      // classifier answers null elsewhere, and win32 symlinks need privilege.
      mkdirSync(join(d, 'fd'));
      symlinkSync('/dev/pts/0', join(d, 'fd', '0'));
      symlinkSync('/dev/pts/0', join(d, 'fd', '1'));
    }
  }
}

async function run() {
  for (const p of [PORT, DEAD_BROKER_PORT]) {
    await assertFree(p, 'assemble.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-assemble-'));
  const dbPath = join(tmpDir, 'mapping.db');
  const config = join(tmpDir, 'config.json');
  const proc = join(tmpDir, 'proc');
  let engine = null;
  let engineLog = '';
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) {
      throw new Error(`seed failed: ${r.err}`);
    }
    return JSON.parse(r.out.trim().split('\n').pop());
  };
  let tick = 1_700_000_000;
  const setConfig = (obj) => {
    writeFileSync(config, JSON.stringify(obj));
    tick += 10;
    utimesSync(config, tick, tick); // two writes in one ms would share an mtime
  };

  const A1 = 'recipe:rec-a#1';
  const A2 = 'recipe:rec-a#2';
  const B1 = 'recipe:rec-b#1';
  const SH = 'recipe:rec-sh#1';
  const NR = 'adopted:1';
  const C1 = 'recipe:rec-c#1';
  const D1 = 'recipe:rec-d#1';
  const D2 = 'recipe:rec-d#2';
  const K1 = 'recipe:rec-k#1';
  const K2 = 'recipe:rec-k#2';
  const E1 = 'recipe:rec-e#1';
  const E2 = 'recipe:rec-e#2';
  const E3 = 'recipe:rec-e#3';
  const F1 = 'recipe:rec-f#1';
  /* §4.3: dehydrated claude-code rows that are NOT a recipe pane of their own
     recipe (a picker handle; a paneid naming a different recipe). */
  const G1 = 'picker:rec-g-1';
  const G2 = 'recipe:rec-gx#1';
  const H1 = 'recipe:rec-h#1';

  try {
    const recipe = (id, name, vendor, agent) => ({ id, name, projectDir: `/srv/x/${name.toLowerCase()}`, vendor, agent });
    await seed({
      recipes: [
        recipe('rec-a', 'Alpha', 'claude-code', 'alpha'),
        recipe('rec-b', 'Bravo', 'claude-code', 'bravo'),
        recipe('rec-sh', 'Shell', 'cli-manager', null),
        recipe('rec-c', 'Charlie', 'claude-code', 'charlie'),
        recipe('rec-d', 'Delta', 'claude-code', 'delta'),
        recipe('rec-k', 'Kilo', 'cli-manager', 'kilo'),
        recipe('rec-e', 'Echo', 'claude-code', 'echo'),
        recipe('rec-f', 'Foxtrot', 'claude-code', 'foxtrot'),
        recipe('rec-g', 'Golf', 'claude-code', 'golf'),
        recipe('rec-h', 'Hotel', 'claude-code', 'hotel'),
      ],
      sessions: [
        { paneid: C1, recipe_id: 'rec-c', vendor: 'claude-code', agent: 'charlie', session_id: 'sess-c1', state: 'dehydrated' },
        { paneid: D1, recipe_id: 'rec-d', vendor: 'claude-code', agent: 'delta', session_id: 'sess-shared', state: 'dehydrated' },
        { paneid: K1, recipe_id: 'rec-k', vendor: 'cli-manager', agent: 'kilo', state: 'killed' },
        { paneid: K2, recipe_id: 'rec-k', vendor: 'cli-manager', agent: 'kilo', state: 'dehydrated' },
        { paneid: G1, recipe_id: 'rec-g', vendor: 'claude-code', agent: 'golf', session_id: 'sess-g1', state: 'dehydrated' },
        { paneid: G2, recipe_id: 'rec-g', vendor: 'claude-code', agent: 'golf', session_id: 'sess-g2', state: 'dehydrated' },
        { paneid: H1, recipe_id: 'rec-h', vendor: 'claude-code', agent: 'hotel', session_id: 'sess-h1', state: 'dehydrated' },
      ],
    });
    procRoot(proc, [
      { pid: 100, comm: 'bash', pane: A1, pgrp: 100, tpgid: 101 },
      { pid: 101, comm: 'claude', args: ['--session-id', 'sess-a1'], pane: A1, ppid: 100, pgrp: 101, tpgid: 101 },
      { pid: 200, comm: 'bash', pane: B1, pgrp: 200, tpgid: 200 },
      { pid: 201, comm: 'claude', pane: B1, ppid: 200, pgrp: 201, tpgid: 200, state: 'T' },
    ]);

    console.log(`booting scratch engine :${PORT} (dead broker :${DEAD_BROKER_PORT}, db ${dbPath})`);
    const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
    engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_PORT: String(PORT),
        HARBOR_WB_HOST: HOST,
        HARBOR_WB_TABLE: dbPath,
        HARBOR_WB_SEAT_WELCOME: '0', // the room welcome would sit in the typer queue these counts read (room welcome, Owner 2026-10-05)
        HARBOR_WB_TOKEN: TOKEN,
        HARBOR_WB_IDENTITY: 'legacy',
        HARBOR_WB_NO_WINDOW: '1',
        HARBOR_WB_NATS_URL: '',
        HARBOR_WB_FABRIC_URL: '',
        HARBOR_WB_BROKER_AUTOSTART: '0',
        HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT),
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_NODE: 'testnode',
        HARBOR_WB_CONFIG: config,
        HARBOR_WB_PROC_ROOT: proc,
        /* One target whose pty runs on THIS host, so claudeRunning is asked. */
        HARBOR_WB_TARGETS: JSON.stringify({ targets: [{ id: 'local', label: 'here', kind: 'local', broker: 'local' }] }),
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
    await seed({
      sessions: [
        { paneid: A1, recipe_id: 'rec-a', vendor: 'claude-code', agent: 'alpha', session_id: 'sess-a1', state: 'live' },
        { paneid: A2, recipe_id: 'rec-a', vendor: 'claude-code', agent: 'alpha', session_id: 'sess-a2', state: 'live' },
        { paneid: B1, recipe_id: 'rec-b', vendor: 'claude-code', agent: 'bravo', session_id: 'sess-b1', state: 'live' },
        { paneid: SH, recipe_id: 'rec-sh', vendor: 'cli-manager', agent: null, state: 'live' },
        { paneid: NR, recipe_id: null, vendor: 'claude-code', agent: null, state: 'live' },
        { paneid: D2, recipe_id: 'rec-d', vendor: 'claude-code', agent: 'delta', session_id: 'sess-shared', state: 'live' },
        { paneid: E1, recipe_id: 'rec-e', vendor: 'claude-code', agent: 'echo', session_id: 'sess-e1', state: 'live' },
        { paneid: E2, recipe_id: 'rec-e', vendor: 'claude-code', agent: 'echo', session_id: 'sess-e2', state: 'live' },
        { paneid: E3, recipe_id: 'rec-e', vendor: 'claude-code', agent: 'echo', session_id: 'sess-e3', state: 'live' },
        { paneid: F1, recipe_id: 'rec-f', vendor: 'claude-code', agent: 'foxtrot', session_id: 'sess-f1', state: 'live' },
      ],
    });
    const login = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(TOKEN)}`,
      redirect: 'manual',
    });
    cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    ok(/wb_auth=/.test(cookie), 'the shared-token browser login issues the person\'s cookie');
    const roomCount = async () => (await call('/api/rooms')).body.length;

    /* ------------------------------------------------------ /health flags ---- */
    console.log('\n[/health flags — read live from config.json]');
    same((await call('/health', { as: 'nobody' })).body.flags, { seatRestorable: false, upgrade: false, collisionGuard: 'enforce' }, 'no config.json: every switch at its safe default');
    setConfig({ upgrade: true });
    eq((await call('/health', { as: 'nobody' })).body.flags.upgrade, true, 'a flip shows on the next /health, no restart');
    setConfig({});
    eq((await call('/health', { as: 'nobody' })).body.flags.upgrade, false, '...and back');
    ok(/switch upgrade: false → true/.test(engineLog) && /switch upgrade: true → false/.test(engineLog), 'each transition logged by the engine');

    /* ---------------------------------------------------------- readiness ---- */
    console.log('\n[readiness — the candidate list (paneids omitted = live + dehydrated)]');
    const all = await ready();
    eq(all.status, 200, '200');
    const ids = all.body.panes.map((p) => p.paneid);
    ok([A1, A2, B1, SH, NR, D2, C1, D1, K2].every((p) => ids.includes(p)), 'every live and dehydrated row is a candidate');
    eq(ids.includes(K1), false, 'a killed row is not');
    eq(typeof all.body.generatedAt, 'number', 'generatedAt');
    eq((await ready('', 'nobody')).status, 401, 'no credential: 401, like every /api route');

    console.log('\n[readiness — fast fields]');
    const r1 = (await ready(`?paneids=${encodeURIComponent(A1)},${encodeURIComponent(B1)},${encodeURIComponent(C1)},nope`)).body;
    same(r1.panes.map((p) => p.paneid), [A1, B1, C1], 'paneids given: those rows, in request order');
    same(r1.unknown, ['nope'], 'an unknown paneid is named in `unknown`');
    const a = r1.panes[0];
    eq(a.recipe_id, 'rec-a', 'recipe_id');
    eq(a.project, 'Alpha', 'project');
    eq(a.vendor, 'claude-code', 'vendor');
    eq(a.host, 'testnode', 'host (the target\'s node)');
    eq(a.state, 'live', 'state');
    eq(a.attached, false, 'attached (no window)');
    eq(a.delivery, 'typed', 'delivery: a claude pane without a channel is typed');
    eq(a.draft, 'unobserved', 'draft');
    /* /proc is linux-only: on any other host the classifier answers null (could not tell) by design. */
    const onLinux = process.platform === 'linux';
    eq(a.claudeRunning, onLinux ? true : null, 'claudeRunning: an interactive claude with exactly this paneid owns the tty (fake /proc; null off linux)');
    eq(r1.panes[1].claudeRunning, onLinux ? false : null, 'claudeRunning false: B1\'s claude is stopped, bash has the tty (null off linux)');
    eq(r1.panes[2].claudeRunning, null, 'claudeRunning null for a dehydrated row');
    same(a.seats, [], 'seats: none yet');
    same(a.seat, { eligible: true, reason: null }, 'seat: a live claude pane is eligible');
    eq(a.dialogUp, false, 'dialogUp');
    same(a.queued, { typed: 0, fabric: 0 }, 'queued: nothing waiting');
    same(a.channel, { now: null, possible: false, reason: 'channels-off' }, 'channel: channels off → now could-not-tell, not possible');
    eq(r1.panes[2].delivery, null, 'delivery null when not live');
    eq(r1.panes[2].channel.now, false, 'a dehydrated pane has no channel now');

    console.log('\n[readiness — every seat reason]');
    const reasonOf = async (paneid, qs = '', as = 'person') =>
      (await ready(`?paneids=${encodeURIComponent(paneid)}${qs}`, as)).body.panes[0]?.seat;
    eq((await reasonOf(SH)).reason, 'shell', 'a plain shell (cli-manager, no agent): shell');
    eq((await reasonOf(NR)).reason, 'no-recipe', 'a pane with no saved project: no-recipe');
    eq((await reasonOf(K1)).reason, 'not-restorable', 'a killed row: not-restorable');
    eq((await reasonOf(K2)).reason, 'not-restorable', 'dehydrated but not a resumable vendor: not-restorable');
    const d1 = await reasonOf(D1);
    eq(d1.reason, 'session-open-elsewhere', 'another live row banks the same session: session-open-elsewhere');
    eq(d1.openIn, D2, '...naming that pane');
    eq((await reasonOf(C1, '', 'agent')).reason, 'needs-you', 'dehydrated, an agent asking: needs-you');
    eq((await reasonOf(C1)).reason, 'restorable-later', 'dehydrated, a person asking, switch off: restorable-later');
    setConfig({ seatRestorable: true });
    same(await reasonOf(C1), { eligible: true, reason: null }, 'switch on, a person asking: eligible');
    setConfig({});
    eq((await ready('?room=nope')).status, 404, 'an unknown room: 404');
    eq((await ready('?room=nope')).body.field, 'room', '...naming room');

    /* ----------------------------------------------------------- assemble ---- */
    console.log('\n[assemble — authority: an omitted `from` needs a person]');
    const two = { room: { name: 'Push' }, key: 'k-auth', seats: [{ occupant: A1 }, { occupant: A2 }] };
    const byAgent = await agent(two);
    eq(byAgent.status, 403, 'a bearer with no `from`: 403');
    eq(byAgent.body?.field, 'from', '...naming from');
    eq(await roomCount(), 0, 'nothing written');

    console.log('\n[assemble — dry run == real call, then atomic]');
    const dry = await person({ ...two, key: 'k1', dryRun: true });
    eq(dry.status, 200, 'dry run: 200');
    eq(dry.body.dryRun, true, 'says dryRun');
    same(dry.body.results.map((r) => [r.outcome, r.handle, r.autoSuffixed]), [['would-seat', 'alpha', false], ['would-seat', 'alpha2', true]], 'derived handles, auto-suffix marked');
    eq(dry.body.room.id, null, 'a dry run\'s new room has no real id');
    same(dry.body.entries, [], '...and carries no line entries (nothing was written)');
    eq(await roomCount(), 0, 'a dry run writes nothing');
    const real = await person({ ...two, key: 'k1' });
    eq(real.status, 200, 'the real call with the dry run\'s key: 200 (a dry run never touches the key map)');
    same(real.body.results.map((r) => [r.outcome, r.handle, r.autoSuffixed]), [['seated', 'alpha', false], ['seated', 'alpha2', true]], 'the SAME handles as the dry run');
    eq(real.body.replayed, false, 'replayed:false');
    const room1 = real.body.room.id;
    ok(typeof room1 === 'string' && room1.length > 0, 'the room was created');
    eq(real.body.lead?.paneid, A1, 'no lead given: the first persistent seat leads');
    eq(real.body.seats.length, 2, 'two seats');
    ok(real.body.entries.some((e) => e.kind === 'fact' && /created/.test(e.body)), 'the entries carry the room facts');
    eq(await roomCount(), 1, 'one room');

    console.log('\n[assemble — a dry run before a name is typed leaves NO trace; the real call needs a name]');
    const lineTotal = async () =>
      (await call('/api/diag/rooms')).body.rooms.reduce((n, r) => n + Object.values(r.lineCounts).reduce((a, b) => a + b, 0), 0);
    const roomsBefore = await roomCount();
    const linesBefore = await lineTotal();
    const logBefore = engineLog.length;
    const unnamed = { room: { name: 'Unnamed room' }, dryRun: true, seats: [{ occupant: B1 }, { occupant: E1 }], conventions: 'hello' };
    const u1 = await person(unnamed);
    const u2 = await person(unnamed);
    eq(u1.status, 200, 'dry run named "Unnamed room": 200');
    eq(u2.status, 200, 'the same name again: 200 (names are not unique)');
    eq((await person({ ...unnamed, room: { name: '   ' } })).status, 200, 'a dry run with a blank name: 200 (a dry run never refuses on a name)');
    eq(await roomCount(), roomsBefore, 'no room row');
    eq(await lineTotal(), linesBefore, 'no line entry anywhere (the room facts rolled back; conventions are never posted by a dry run)');
    const newLog = engineLog.slice(logBefore);
    eq(/room|assembl/i.test(newLog), false, 'no engine log line');
    const blank = await person({ room: { name: '  ' }, key: 'k-blank', seats: [{ occupant: B1 }] });
    eq(blank.status, 400, 'the REAL call with a whitespace name: 400');
    eq(blank.body?.field, 'room', '...field room');
    eq((await person({ room: { name: '' }, key: 'k-blank', seats: [{ occupant: B1 }] })).body?.field, 'room', 'an empty name: 400 field room');
    eq(await roomCount(), roomsBefore, 'still no room');

    console.log('\n[assemble — idempotency key]');
    const replay = await person({ ...two, key: 'k1' });
    eq(replay.status, 200, 'the same key and body again: 200');
    eq(replay.body.replayed, true, 'replayed:true');
    eq(replay.body.room.id, room1, 'the stored result, verbatim (same room)');
    eq(await roomCount(), 1, 'no second room');
    const reused = await person({ ...two, key: 'k1', seats: [{ occupant: B1 }] });
    eq(reused.status, 409, 'the same key with a different body after a committed 200: 409');
    eq(reused.body.results?.[0]?.reason, 'key-reused', 'key-reused');

    console.log('\n[assemble — one refused row → nothing written, 409 per row; the key is not used up]');
    const mixed = await person({ room: { name: 'Mixed' }, key: 'k2', seats: [{ occupant: E1 }, { occupant: SH }, { occupant: NR }] });
    eq(mixed.status, 409, '409');
    eq(mixed.body.field, 'seats', 'field seats');
    same(mixed.body.results.map((r) => r.outcome === 'refused' ? r.reason : r.outcome), ['would-seat', 'shell', 'no-recipe'], 'a result per row: the good row would seat, the others say why');
    eq(await roomCount(), 1, 'nothing written');
    eq('entries' in mixed.body || 'seats' in mixed.body, false, 'a 409 carries results (and lead), never entries or seats it did not write');
    const retry = await person({ room: { name: 'Mixed' }, key: 'k2', seats: [{ occupant: E1 }] });
    eq(retry.status, 200, 'the smaller retry with the SAME key: 200 (a 409 does not use the key up)');
    const room2 = retry.body.room.id;

    console.log('\n[a retry racing its original: one room]');
    const before = await roomCount();
    const race = { room: { name: 'Race' }, key: 'k-race', seats: [{ occupant: F1 }] };
    const [ra, rb] = await Promise.all([person(race), person(race)]);
    eq(ra.status === 200 && rb.status === 200, true, 'both answer 200');
    eq(ra.body.room.id, rb.body.room.id, 'the same room');
    eq([ra.body.replayed, rb.body.replayed].filter(Boolean).length, 1, 'one of them is the replay');
    eq(await roomCount(), before + 1, 'exactly one room was created');

    console.log('\n[one vocabulary: readiness says what assemble refuses]');
    for (const p of [SH, NR, K2, D1]) {
      const rr = (await reasonOf(p)).reason;
      const aa = (await person({ room: { name: 'Vocab' }, dryRun: true, seats: [{ occupant: p }] })).body.results[0].reason;
      eq(aa, rr, `${p}: readiness "${rr}" == assemble "${aa}"`);
    }

    console.log('\n[assemble — lead rules]');
    const leadNew = await person({ room: { name: 'Led' }, key: 'k3', seats: [{ occupant: E2 }, { occupant: E3 }], lead: E3 });
    eq(leadNew.status, 200, 'a new room with an explicit lead: 200');
    eq(leadNew.body.lead?.paneid, E3, 'the named lead leads');
    eq(leadNew.body.entries.filter((e) => /is now the lead/.test(e.body ?? '')).length, 1, 'with ONE lead fact, not two');
    eq((await person({ room: { name: 'X' }, dryRun: true, seats: [{ occupant: B1 }], lead: A1 })).body.field, 'lead', 'a lead not in this call: 400 lead');
    eq((await person({ room: { name: 'X' }, dryRun: true, seats: [{ occupant: B1, policy: 'fresh' }], lead: B1 })).status, 400, 'a fresh-policy lead: 400');
    const keep = await person({ room: { id: room1 }, key: 'k4', seats: [{ occupant: B1 }] });
    eq(keep.status, 200, 'adding to an existing room, no lead: 200');
    eq(keep.body.lead?.paneid, A1, 'the current lead is kept');
    const hand = await person({ room: { id: room1 }, key: 'k5', seats: [{ occupant: A2 }], lead: A2 });
    eq(hand.status, 200, 'an existing room, a new lead from an already-seated row: 200');
    eq(hand.body.results[0].outcome, 'already', 'the pane already in the room is `already`, not refused');
    eq(hand.body.lead?.paneid, A2, 'the lead is handed over');
    ok(hand.body.entries.some((e) => /is now the lead \(was @alpha\)/.test(e.body ?? '')), 'with the handover fact');

    console.log('\n[assemble — a typed handle beats one derived in the same call (review #6)]');
    const clash = { room: { name: 'Handles' }, seats: [{ occupant: E1 }, { occupant: F1, handle: 'echo' }], lead: E1 };
    const clashDry = await person({ ...clash, dryRun: true });
    eq(clashDry.status, 200, 'dry run: 200 (was a 409 handle-taken on the row the user named)');
    same(clashDry.body.results.map((r) => [r.paneid, r.handle, r.autoSuffixed]), [[E1, 'echo2', true], [F1, 'echo', false]], 'the typed row keeps its name; the derived one takes the placeholder');
    const clashReal = await person({ ...clash, key: 'k-clash' });
    eq(clashReal.status, 200, 'real call: 200');
    same(clashReal.body.results.map((r) => r.handle), clashDry.body.results.map((r) => r.handle), 'the SAME handles as the dry run');
    eq(clashReal.body.lead?.paneid, E1, 'the named lead leads (a derived row, bound after the typed one)');
    eq(clashReal.body.entries.filter((e) => /is now the lead/.test(e.body ?? '')).length, 1, 'ONE lead fact (the bind order never picks a lead)');
    /* Review 2 f6: TAB ORDER follows the request — a typed row does not jump
       ahead of derived rows (the typed name still wins the handle). */
    const tab = await person({ room: { name: 'Tabs' }, key: 'k-tabs', seats: [{ occupant: E1 }, { occupant: A1 }, { occupant: F1, handle: 'ff' }] });
    eq(tab.status, 200, 'mixed typed/derived: 200');
    same(
      tab.body.seats.slice().sort((a, b) => a.position - b.position).map((s) => s.handle),
      ['echo', 'alpha', 'ff'],
      'seat positions follow the request order (echo, alpha, ff), not typed-first',
    );
    const noLead = await person({ room: { name: 'Handles 2' }, key: 'k-clash2', seats: [{ occupant: E1 }, { occupant: F1, handle: 'echo' }] });
    eq(noLead.body.lead?.paneid, E1, 'no lead given: the first persistent row in REQUEST order leads, not the first one bound');
    eq(noLead.body.entries.filter((e) => /is now the lead/.test(e.body ?? '')).length, 1, '...with one lead fact');

    console.log('\n[assemble — a lead via `from`]');
    const byLead = await agent({ room: { id: room1 }, key: 'k6', from: A2, seats: [{ occupant: F1 }] });
    eq(byLead.status, 200, 'the current lead (bearer + from) seats a live pane: 200');
    eq(byLead.body.results[0].outcome, 'seated', 'seated');
    const notLead = await agent({ room: { id: room1 }, key: 'k7', from: A1, seats: [{ occupant: D2 }] });
    eq(notLead.status, 403, 'a member that is not the lead: 403');
    eq(notLead.body.field, 'from', '...naming from');
    eq((await agent({ room: { name: 'Mine' }, key: 'k8', from: A2, seats: [{ occupant: D2 }] })).status, 403, 'a lead cannot assemble a NEW room via from: 403');
    const leadDehy = await agent({ room: { id: room1 }, key: 'k9', from: A2, seats: [{ occupant: C1 }] });
    eq(leadDehy.status, 409, 'a lead seating a dehydrated pane: 409');
    eq(leadDehy.body.results[0].reason, 'needs-you', 'needs-you');

    console.log('\n[assemble — dehydrated occupants need a person AND the switch]');
    const off = await person({ room: { id: room1 }, key: 'k10', seats: [{ occupant: C1 }] });
    eq(off.body.results?.[0]?.reason, 'restorable-later', 'switch off: restorable-later');
    setConfig({ seatRestorable: true });
    const on = await person({ room: { id: room1 }, key: 'k10', seats: [{ occupant: C1 }] });
    eq(on.status, 200, 'switch on, a person: 200 (same key: the 409 did not use it)');
    eq(on.body.results[0].outcome, 'seated', 'the dehydrated pane is seated');
    const cSeat = on.body.seats.find((s) => s.occupant?.id === C1);
    same(cSeat?.actions, ['rehydrate'], 'its seat derives Restore (rehydrate)');

    console.log('\n[requireSeatablePane (§4.3) — every condition, switch on, a person]');
    const dry43 = async (seat) => (await person({ room: { id: room1 }, dryRun: true, seats: [seat] })).body.results?.[0];
    eq((await dry43({ occupant: H1, policy: 'fresh' })).reason, 'not-restorable', 'a FRESH seat for a dehydrated pane: not-restorable (a fresh seat would start blank)');
    eq((await dry43({ occupant: H1 })).outcome, 'would-seat', 'the same pane on a persistent seat: would seat');
    eq((await dry43({ occupant: G1 })).reason, 'not-restorable', 'not a recipe:<rid> pane (a picker handle): not-restorable');
    eq((await dry43({ occupant: G2 })).reason, 'not-restorable', 'a recipe pane of ANOTHER recipe than its seat\'s: not-restorable');
    eq((await dry43({ occupant: K2 })).reason, 'not-restorable', 'not a resumable vendor: not-restorable');
    eq((await dry43({ occupant: D1 })).reason, 'session-open-elsewhere', 'another live row banks its session_id: session-open-elsewhere');
    eq((await agent({ room: { id: room1 }, dryRun: true, from: A2, seats: [{ occupant: H1 }] })).body.results?.[0]?.reason, 'needs-you', 'not a human credential: needs-you');
    eq((await ready(`?paneids=${encodeURIComponent(G1)}`)).body.panes[0]?.seat?.reason, 'not-restorable', 'readiness says so too (the recipe-pane rule is seat-independent): the modal never offers it');
    same((await ready(`?paneids=${encodeURIComponent(H1)}`)).body.panes[0]?.seat, { eligible: true, reason: null }, 'readiness has no seat: the fresh-policy rule is assemble\'s alone');
    const liveFresh = await dry43({ occupant: E2, policy: 'fresh' });
    eq(liveFresh.outcome, 'would-seat', 'a LIVE pane on a fresh seat: unchanged (would seat)');
    setConfig({});
    eq((await dry43({ occupant: H1 })).reason, 'restorable-later', 'switch off: restorable-later, whatever the seat');
    const carried = await call(`/api/rooms/${room1}/seats`, { json: { handle: 'hotel', recipe_id: 'rec-h', occupant: H1 }, as: 'person' });
    eq(carried.status, 400, 'requireLivePane callers unchanged: POST seats with a dehydrated occupant → 400');

    console.log('\n[assemble — handles]');
    const taken = await person({ room: { id: room2 }, key: 'k11', seats: [{ occupant: D2, handle: 'echo' }] });
    eq(taken.status, 409, 'a typed handle already taken in the room: 409');
    eq(taken.body.results[0].reason, 'handle-taken', 'handle-taken');
    eq((await person({ room: { id: room2 }, dryRun: true, seats: [{ occupant: D2, handle: 'room' }] })).body.results[0].reason, 'handle-taken', 'a reserved handle reads as taken');
    const named = await person({ room: { id: room2 }, key: 'k11', seats: [{ occupant: D2, handle: 'Delta Force!' }] });
    eq(named.body.results?.[0]?.handle, 'delta-force', 'bad characters are normalised without a prompt');

    console.log('\n[assemble — the opening message (conventions)]');
    const conv = await person({ room: { name: 'Hello' }, key: 'k12', seats: [{ occupant: B1 }, { occupant: E1 }], conventions: 'You are in room Hello. No reply needed.' });
    eq(conv.status, 200, '200');
    const chat = conv.body.entries.find((e) => e.kind === 'chat');
    eq(chat?.body, 'You are in room Hello. No reply needed.', 'posted verbatim, after the commit');
    eq(chat?.target, 'room', 'a new room: addressed to @room');
    eq(chat?.author, 'user', 'written as the user');
    const line = (await call(`/api/rooms/${conv.body.room.id}/line`)).body.entries;
    ok(line.some((e) => e.kind === 'chat' && e.body === 'You are in room Hello. No reply needed.'), 'and it is on the room line');
    /* B1's row is live but has no pty here, so its typed copy waits in the
       queue (held not-live) while the badge went to its inbox. */
    const q = (await ready(`?paneids=${encodeURIComponent(B1)}`)).body.panes[0].queued;
    same(q, { typed: 1, fabric: 0 }, 'readiness queued: the waiting typed line counts; the badge inbox does not');
    const conv2 = await person({ room: { id: room2 }, key: 'k13', seats: [{ occupant: A1 }], conventions: 'welcome' });
    eq(conv2.body.entries.find((e) => e.kind === 'chat')?.target, conv2.body.results[0].handle, 'an existing room: only the new seat is addressed');
    eq((await person({ room: { name: 'Y' }, dryRun: true, seats: [{ occupant: B1 }], conventions: 'x'.repeat(4001) })).body.field, 'conventions', 'over 4000 chars: 400 conventions');

    console.log('\n[assemble — archived rooms and bad bodies]');
    await call(`/api/rooms/${room2}/archive`, { json: {}, as: 'person' });
    const arch = await person({ room: { id: room2 }, key: 'k14', seats: [{ occupant: F1 }] });
    eq(arch.body.results?.[0]?.reason, 'room-archived', 'an archived room: room-archived');
    eq((await ready(`?paneids=${encodeURIComponent(F1)}&room=${room2}`)).body.panes[0].seat.reason, 'room-archived', 'readiness says the same');
    eq((await person({ room: { id: 'nope' }, key: 'k15', seats: [{ occupant: F1 }] })).status, 404, 'an unknown room: 404');
    eq((await person({ room: { name: 'Z' }, seats: [{ occupant: F1 }] })).body.field, 'key', 'a real call needs a key');
    eq((await person({ room: { name: 'Z' }, key: 'k16', seats: [] })).body.field, 'seats', 'no seats: 400 seats');
    eq((await person({ room: { name: 'Z' }, key: 'k16', seats: [{ occupant: F1 }, { occupant: F1 }] })).body.field, 'seats', 'a pane named twice: 400 seats');
    eq((await person({ room: {}, key: 'k16', seats: [{ occupant: F1 }] })).body.field, 'room', 'room neither id nor name: 400 room');
    eq((await call('/api/rooms/assemble', { as: 'person' })).status, 405, 'GET: 405');
    const inRoom = (await ready(`?paneids=${encodeURIComponent(A1)}&room=${room1}`)).body.panes[0];
    eq(inRoom.seat.reason, 'in-room', 'readiness in a room it already holds a seat in: in-room');
    ok(inRoom.seats.some((s) => s.roomId === room1 && s.handle === 'alpha'), 'seats lists the room and handle');
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
