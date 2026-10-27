/**
 * `POST /api/fabric/send` (F1, interim, contract §2, engine-proxied) — a pane
 * ASKS the engine to send an envelope out; the engine resolves `from` to ITS
 * OWN live session row, stamps `envelope.from = row.agent`, and proxies to the
 * real fabric's `/send` with its own bearer. Never the caller's word for who
 * they are.
 *
 * The rooms-routes.test.mjs pattern, not fabric-inbound.test.mjs's: no real
 * pty, no real broker (a DEAD broker port, assertFree'd, shared by both
 * engines this suite boots — nothing may ever listen there), live/killed rows
 * written straight through the store via test/rooms-routes.seed.ts (dehydrated
 * / killed BEFORE boot, live AFTER — reconcile only sweeps `live` at boot).
 * That is what makes this suite Linux-portable and NOT WIN32_ONLY, unlike
 * fabric-inbound.test.mjs / fabric-subscriber.test.mjs, which both need a real
 * pty to prove delivery into a window.
 *
 * The FABRIC is a tiny stub http server with one route (`POST /send`) —
 * platform's service does not exist yet, same reasoning as
 * fabric-subscriber.test.mjs's stub, but this suite only needs the HTTP half.
 *
 * SAFETY: never touches :7420/:7430/:8200/:8201/:8204, the real data dir, or a
 * broker. Every child env comes from childEnv(). Temp dirs are removed.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv } from './_scratch.mjs';
import Database from 'better-sqlite3';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(70); // main engine — port table in test/_scratch.mjs
const DEAD_BROKER_PORT = P(71); // nothing may listen: no pty is ever opened; shared by both engines
const FABRIC_PORT = P(72); // the stub fabric — NOT 8204 (the real one)
const DISABLED_PORT = P(73); // second engine, HARBOR_WB_FABRIC_URL=''
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const DISABLED_BASE = `http://${HOST}:${DISABLED_PORT}`;
const TOKEN = 'fabric-send-test-token';

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(base, path, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  if (opts.auth !== false) {
    headers.authorization = `Bearer ${TOKEN}`;
  }
  const init = { method: opts.method ?? 'GET', headers };
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.json);
    init.method = opts.method ?? 'POST';
  } else if (opts.raw !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = opts.raw;
    init.method = opts.method ?? 'POST';
  }
  const res = await fetch(base + path, init);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not json */
  }
  return { status: res.status, body };
}
const send = (base, json, extra = {}) => call(base, '/api/fabric/send', { json, ...extra });

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

/* ---------------------------------------------------------------------------
 * THE STUB FABRIC — one route, `POST /send`. `to: 'bad-target'` answers 400
 * (proves status+body passthrough); anything else answers 200. Every request
 * is recorded (envelope + Authorization header) so the test can assert what
 * the engine actually sent, never what the caller asked it to send.
 * ------------------------------------------------------------------------- */
function stubFabric() {
  const state = { requests: [] };
  const http = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/send' && req.method === 'POST') {
        let env = null;
        try {
          env = JSON.parse(body);
        } catch {
          /* recorded as null below */
        }
        state.requests.push({ env, auth: req.headers.authorization ?? null });
        if (env && env.to === 'bad-target') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'refused: bad target', field: 'to' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'mock-env-1', ack: 'none', queued: false }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  return {
    state,
    listen: () => new Promise((resolve, reject) => {
      http.once('error', reject);
      http.listen(FABRIC_PORT, HOST, resolve);
    }),
    stop: () => new Promise((r) => { http.closeAllConnections?.(); http.close(r); }),
  };
}

async function run() {
  for (const p of [PORT, DEAD_BROKER_PORT, FABRIC_PORT, DISABLED_PORT]) {
    await assertFree(p, 'fabric-send.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-fabric-send-'));
  const dbPath = join(tmpDir, 'mapping.db');
  const disabledDbPath = join(tmpDir, 'mapping-disabled.db');
  let engine = null;
  let disabledEngine = null;
  let engineLog = '';
  let disabledLog = '';
  const fabric = stubFabric();

  const seed = async (plan, table = dbPath) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], {
      HARBOR_WB_TABLE: table,
      HARBOR_WB_IDENTITY: 'legacy',
    });
    if (r.code !== 0) {
      throw new Error(`seed failed: ${r.err}`);
    }
    return JSON.parse(r.out.trim().split('\n').pop());
  };

  try {
    /* ---------------------------------------------------------------- seed */
    await seed({
      recipes: [
        { id: 'rec-sender', name: 'Sender', target: 'local', projectDir: tmpDir, vendor: 'claude-code', agent: 'sender-one' },
        { id: 'rec-noslug', name: 'NoSlug', target: 'local', projectDir: tmpDir, vendor: 'cli-manager', agent: null },
      ],
      // BEFORE boot: not-live rows, exactly as rooms-routes.test.mjs seeds them.
      sessions: [
        { paneid: 'p-dead', recipe_id: 'rec-sender', vendor: 'claude-code', agent: 'sender-one', session_id: 'sess-2', state: 'killed' },
      ],
    });

    console.log(`booting scratch engine :${PORT} (dead broker :${DEAD_BROKER_PORT}, fabric :${FABRIC_PORT}, db ${dbPath})`);
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
        // Points at the stub fabric's port BEFORE it is listening — this is
        // what lets the very first assertion (502 unreachable) run with no
        // extra machinery: nothing answers there yet.
        HARBOR_WB_FABRIC_URL: `http://${HOST}:${FABRIC_PORT}`,
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

    // LIVE rows, after boot (reconcile would otherwise sweep them at boot).
    await seed({
      sessions: [
        { paneid: 'p-live', recipe_id: 'rec-sender', vendor: 'claude-code', agent: 'sender-one', session_id: 'sess-1', state: 'live' },
        { paneid: 'p-noslug', recipe_id: 'rec-noslug', vendor: 'cli-manager', agent: null, state: 'live' },
      ],
    });

    /* -------------------------------------------------------------- auth */
    console.log('\n[auth: bearer required, no loopback exemption]');
    const noAuth = await send(BASE, { from: { paneid: 'p-live' }, to: 'peer', kind: 'msg', thread: 't1', body: 'hi' }, { auth: false });
    eq(noAuth.status, 401, 'no bearer: 401');

    /* --------------------------------------------------------- from-unbound */
    console.log('\n[from: resolved to a LIVE row with a non-empty slug, or 403 from-unbound]');
    const badField = await send(BASE, { from: 'sender-one', to: 'peer', kind: 'msg', thread: 't1', body: 'hi' });
    eq(badField.status, 403, 'a caller-supplied STRING from (not {paneid}/{session_id}): 403');
    eq(badField.body.error, 'from-unbound', 'error is from-unbound');
    eq(badField.body.field, 'from', 'and names field from');

    const unknownPane = await send(BASE, { from: { paneid: 'nope#1' }, to: 'peer', kind: 'msg', thread: 't1', body: 'hi' });
    eq(unknownPane.status, 403, 'unknown paneid: 403');
    eq(unknownPane.body.error, 'from-unbound', 'from-unbound');

    const notLive = await send(BASE, { from: { paneid: 'p-dead' }, to: 'peer', kind: 'msg', thread: 't1', body: 'hi' });
    eq(notLive.status, 403, 'a NOT-live pane: 403');
    ok(/not live/.test(notLive.body.reason ?? ''), 'reason names it not live');

    const notLiveBySid = await send(BASE, { from: { session_id: 'sess-2' }, to: 'peer', kind: 'msg', thread: 't1', body: 'hi' });
    eq(notLiveBySid.status, 403, 'session_id of a not-live row: 403 (the lookup itself only matches live rows)');

    const noSlug = await send(BASE, { from: { paneid: 'p-noslug' }, to: 'peer', kind: 'msg', thread: 't1', body: 'hi' });
    eq(noSlug.status, 403, 'a live pane with NO agent slug: 403');
    ok(/slug/.test(noSlug.body.reason ?? ''), 'reason names the missing slug');

    /* ------------------------------------------------------------ 502 -- */
    console.log('\n[fabric unreachable: 502, before the stub is even listening]');
    const unreachable = await send(BASE, { from: { paneid: 'p-live' }, to: 'peer-1', kind: 'msg', thread: 't1', body: 'hi' });
    eq(unreachable.status, 502, 'nothing listening on the fabric port: 502');
    eq(unreachable.body.error, 'fabric-unreachable', 'error is fabric-unreachable');

    /* ------------------------------------------------- start the stub ---- */
    await fabric.listen();
    console.log(`stub fabric listening on :${FABRIC_PORT}`);

    /* --------------------------------------------------- stamped from ---- */
    console.log('\n[stamped from: the ENGINE names the sender, never the caller]');
    const before = fabric.state.requests.length;
    const okSend = await send(BASE, { from: { paneid: 'p-live' }, to: 'peer-1', kind: 'msg', class: 'coordination', thread: 't1', body: 'hello' });
    eq(okSend.status, 200, 'accepted, passthrough 200');
    same(okSend.body, { id: 'mock-env-1', ack: 'none', queued: false }, 'the fabric\'s own body, unchanged');
    eq(fabric.state.requests.length, before + 1, 'exactly one request reached the stub');
    const r1 = fabric.state.requests[before];
    eq(r1.env.from, 'sender-one', 'envelope.from is the ROW\'s agent slug');
    eq(r1.env.to, 'peer-1', 'to copied verbatim');
    eq(r1.env.kind, 'msg', 'kind copied verbatim');
    eq(r1.env.class, 'coordination', 'class copied verbatim');
    eq(r1.env.thread, 't1', 'thread copied verbatim');
    eq(r1.env.body, 'hello', 'body copied verbatim');
    eq(r1.env.id, undefined, 'no id — the fabric mints it');
    eq(r1.env.ts, undefined, 'no ts — the fabric mints it');
    eq(r1.env.ack, undefined, 'no ack — not the inbound envelope shape');
    eq(r1.env.attention, undefined, 'no attention — assigned by the router, never the sender');
    eq(r1.auth, `Bearer ${TOKEN}`, 'the ENGINE\'s own bearer went out, not a caller-supplied one');

    console.log('\n[stamped from: even a duplicate-key "from" string cannot leak through]');
    // Raw JSON text with `from` written TWICE: a string first, the real
    // resolution object second. JSON.parse keeps the LAST occurrence of a
    // duplicate key, so this is what a naive smuggling attempt looks like on
    // the wire — and the assertion is that the engine only ever reads the
    // parsed value (the object) and only ever stamps the resolved slug.
    const dup = `{"from":"impostor-slug","to":"peer-1","kind":"msg","thread":"t1","body":"hi","from":{"paneid":"p-live"}}`;
    const before2 = fabric.state.requests.length;
    const dupRes = await call(BASE, '/api/fabric/send', { raw: dup });
    eq(dupRes.status, 200, 'resolves fine (the object won the duplicate key)');
    const r2 = fabric.state.requests[before2];
    eq(r2.env.from, 'sender-one', 'stamped from the row, never "impostor-slug"');

    console.log('\n[from: {session_id}]');
    const before3 = fabric.state.requests.length;
    const bySid = await send(BASE, { from: { session_id: 'sess-1' }, to: 'peer-1', kind: 'msg', thread: 't1', body: 'hi' });
    eq(bySid.status, 200, 'resolves through session_id');
    eq(fabric.state.requests[before3].env.from, 'sender-one', 'same slug, resolved by session_id');

    console.log('\n[omitted fields never appear]');
    const before4 = fabric.state.requests.length;
    await send(BASE, { from: { paneid: 'p-live' }, to: 'peer-1', kind: 'msg', thread: 't1', body: 'hi' });
    const r4 = fabric.state.requests[before4];
    ok(!('ref' in r4.env), 'ref omitted when not sent');
    ok(!('ttl' in r4.env), 'ttl omitted when not sent');
    ok(!('consequence' in r4.env), 'consequence omitted when not sent');
    ok(!('deadline' in r4.env), 'deadline omitted when not sent');

    /* ------------------------------------------------- status passthrough */
    console.log('\n[status passthrough: the fabric\'s 400 reaches the caller unchanged]');
    const bad = await send(BASE, { from: { paneid: 'p-live' }, to: 'bad-target', kind: 'msg', thread: 't1', body: 'nope' });
    eq(bad.status, 400, 'the fabric\'s 400 is returned as-is');
    same(bad.body, { error: 'refused: bad target', field: 'to' }, 'and the fabric\'s body, unchanged');

    /* ------------------------------------------- dm budget + repeat [chatter p2] -- */
    /* [agent comms] the rules default to 'watch'; this phase-2 section tests ENFORCEMENT,
       so the person's setting is written where PATCH /api/agent-comms writes it. */
    const setComms = (v) => {
      const db = new Database(dbPath);
      db.prepare(`INSERT INTO engine_settings (key, value, updated_at) VALUES ('agentComms', ?, 0)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(v));
      db.close();
    };
    setComms({ dmBudget: 'enforce', dmRepeat: 'enforce' });
    console.log('\n[dm budget [chatter p2]: 6 DMs to one recipient per rolling hour, then 429]');
    const beforeB = fabric.state.requests.length;
    for (let i = 1; i <= 6; i++) {
      const s = await send(BASE, { from: { paneid: 'p-live' }, to: 'peer-2', kind: 'msg', thread: 't2', body: `note ${i}` });
      eq(s.status, 200, `DM ${i} of 6 to peer-2: sent`);
    }
    const over = await send(BASE, { from: { paneid: 'p-live' }, to: 'peer-2', kind: 'msg', thread: 't2', body: 'note 7' });
    eq(over.status, 429, 'the 7th in the hour: 429');
    eq(over.body.error, 'dm_budget', 'error is dm_budget');
    eq(over.body.message, '6 messages to peer-2 this hour (limit 6); combine what is left into one message later', 'and the sender hears the count and what to do');
    eq(fabric.state.requests.length, beforeB + 6, 'the refused one never reached the fabric');
    const otherTo = await send(BASE, { from: { paneid: 'p-live' }, to: 'peer-3', kind: 'msg', thread: 't3', body: 'please rebuild the hand mesh with the new cuff settings tonight' });
    eq(otherTo.status, 200, 'the budget is per recipient: peer-3 still gets one');

    console.log('\n[dm repeat [chatter p2]: a near-identical DM to the same recipient within the hour: 409]');
    const rep = await send(BASE, { from: { paneid: 'p-live' }, to: 'peer-3', kind: 'msg', thread: 't3', body: 'Please rebuild the hand mesh with the new cuff settings, tonight!' });
    eq(rep.status, 409, 'a repeat: 409');
    eq(rep.body.error, 'dm_repeat', 'error is dm_repeat');
    ok(/^repeats your message mock-env-1 of 20[0-9][0-9]-/.test(rep.body.message ?? ''), 'naming the earlier message id and its time');
    const fresh = await send(BASE, { from: { paneid: 'p-live' }, to: 'peer-3', kind: 'msg', thread: 't3', body: 'the kilt strips need a second pass on the buckles first' });
    eq(fresh.status, 200, 'a different message passes');
    const rep2 = await call(BASE, '/api/chatter?hours=1');
    same(rep2.body.refused?.dm_budget, { 'sender-one': 1 }, 'report: the budget refusal, by sender');
    same(rep2.body.refused?.dm_repeat, { 'sender-one': 1 }, 'report: the repeat refusal, by sender');

    console.log('\n[agent comms: watch = the DM goes out, the rule is recorded]');
    setComms({ dmBudget: 'watch', dmRepeat: 'watch' });
    const beforeW = fabric.state.requests.length;
    const wBudget = await send(BASE, { from: { paneid: 'p-live' }, to: 'peer-2', kind: 'msg', thread: 't2', body: 'note 8' });
    eq(wBudget.status, 200, 'watch: over the budget, still sent');
    const wRepeat = await send(BASE, { from: { paneid: 'p-live' }, to: 'peer-3', kind: 'msg', thread: 't3', body: 'Please rebuild the hand mesh with the new cuff settings, tonight!' });
    eq(wRepeat.status, 200, 'watch: a repeat, still sent');
    eq(fabric.state.requests.length, beforeW + 2, 'both reached the fabric');
    const repW = await call(BASE, '/api/chatter?hours=1');
    same(repW.body.watched?.dm_budget, { 'sender-one': 1 }, 'report: watched budget, by sender');
    same(repW.body.watched?.dm_repeat, { 'sender-one': 1 }, 'report: watched repeat, by sender');
    same(repW.body.refused?.dm_budget, { 'sender-one': 1 }, 'enforced refusals counted apart, unchanged');
    setComms({ dmBudget: 'off', dmRepeat: 'off' });
    eq((await send(BASE, { from: { paneid: 'p-live' }, to: 'peer-2', kind: 'msg', thread: 't2', body: 'note 9' })).status, 200, 'off: sent');
    same((await call(BASE, '/api/chatter?hours=1')).body.watched?.dm_budget, { 'sender-one': 1 }, 'off: nothing more recorded');
    const ac = await call(BASE, '/api/agent-comms');
    eq(ac.status, 200, 'GET /api/agent-comms answers a bearer');
    eq(ac.body.dmBudget, 'off', '...with the stored setting');
    const acPatch = await call(BASE, '/api/agent-comms', { method: 'PATCH', json: { dmBudget: 'enforce' } });
    eq(acPatch.status, 403, 'a bearer cannot change agent comms (a person only)');

    /* ----------------------------------------------------------- quiet -- */
    console.log('\n[quiet [chatter]: a DM to an agent the person holds is refused at the send door]');
    const putQuiet = await call(BASE, '/api/chatter/quiet', { method: 'PUT', json: { slug: 'peer-1', quiet: true } });
    eq(putQuiet.status, 403, 'a bearer cannot mark an agent quiet (a person only)');
    {
      // The person's switch, written where PUT /api/chatter/quiet writes it.
      const db = new Database(dbPath);
      db.prepare(`INSERT INTO engine_settings (key, value, updated_at) VALUES ('chatter.quiet', '["peer-1"]', 0)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
      db.close();
    }
    const beforeQ = fabric.state.requests.length;
    const quiet = await send(BASE, { from: { paneid: 'p-live' }, to: 'peer-1', kind: 'msg', thread: 't1', body: 'hi' });
    eq(quiet.status, 403, 'a DM to a quiet agent: 403');
    eq(quiet.body.error, 'recipient_quiet', 'error is recipient_quiet');
    eq(quiet.body.message, 'peer-1 is quiet; the person holds it', 'and the sender hears why');
    eq(fabric.state.requests.length, beforeQ, 'nothing reached the fabric');
    const onAuthority = await send(BASE, { from: { paneid: 'p-live' }, to: 'peer-1', kind: 'msg', thread: 't1', body: 'hi', authorised_by: 'user' });
    eq(onAuthority.status, 403, 'authorised_by: user claimed by the sender does NOT pass a quiet switch');
    eq(fabric.state.requests.length, beforeQ, '...still nothing reached the fabric');
    const report = await call(BASE, '/api/chatter?hours=1');
    eq(report.status, 200, 'GET /api/chatter answers a bearer');
    eq(report.body.refusals?.['peer-1'], 2, 'both refusals are counted in the report');
    setComms({ quietEnabled: false });
    const qOff = await send(BASE, { from: { paneid: 'p-live' }, to: 'peer-1', kind: 'msg', thread: 't1', body: 'hi' });
    eq(qOff.status, 200, '[agent comms] quietEnabled off: the quiet mark is kept but ignored, the DM goes out');
    setComms({});

    /* --------------------------------------------------------- logging -- */
    console.log('\n[one log line per send; the body is NEVER logged]');
    await sleep(150);
    ok(engineLog.includes('fabric send p-live sender-one → peer-1 (msg): 200'), 'a success line names paneid, slug, to, kind, status');
    ok(engineLog.includes('fabric send p-live sender-one → bad-target (msg): 400'), 'a passthrough failure line too');
    ok(engineLog.includes('fabric send p-live sender-one → peer-1 (msg): fabric-unreachable') || engineLog.includes(': unreachable'), 'the unreachable case is logged too');
    ok(!engineLog.includes('hello'), 'body text never reaches the log');
    ok(!engineLog.includes('nope'), 'not even a failed body');

    /* -------------------------------------------------------- 503 disabled */
    console.log(`\nbooting a second scratch engine :${DISABLED_PORT} (fabric DISABLED)`);
    disabledEngine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_PORT: String(DISABLED_PORT),
        HARBOR_WB_HOST: HOST,
        HARBOR_WB_TABLE: disabledDbPath,
        HARBOR_WB_TOKEN: TOKEN,
        HARBOR_WB_IDENTITY: 'legacy',
        HARBOR_WB_NO_WINDOW: '1',
        HARBOR_WB_NATS_URL: '',
        HARBOR_WB_FABRIC_URL: '', // the documented off switch
        HARBOR_WB_BROKER_AUTOSTART: '0',
        HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT),
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects-disabled'),
        HARBOR_WB_NODE: 'testnode',
      }),
    });
    disabledEngine.stdout.on('data', (d) => (disabledLog += d));
    disabledEngine.stderr.on('data', (d) => (disabledLog += d));
    let up2 = false;
    for (let i = 0; i < 120 && !up2; i++) {
      await sleep(250);
      up2 = await fetch(`${DISABLED_BASE}/health`).then((r) => r.ok).catch(() => false);
    }
    if (!up2) {
      throw new Error(`disabled-fabric engine did not come up\n${disabledLog}`);
    }
    await seed(
      {
        recipes: [{ id: 'rec-sender', name: 'Sender', target: 'local', projectDir: tmpDir, vendor: 'claude-code', agent: 'sender-one' }],
        sessions: [{ paneid: 'p-live', recipe_id: 'rec-sender', vendor: 'claude-code', agent: 'sender-one', session_id: 'sess-1', state: 'live' }],
      },
      disabledDbPath,
    );
    const disabled = await send(DISABLED_BASE, { from: { paneid: 'p-live' }, to: 'peer-1', kind: 'msg', thread: 't1', body: 'hi' });
    eq(disabled.status, 503, 'HARBOR_WB_FABRIC_URL=\'\': 503');
    eq(disabled.body.error, 'fabric-disabled', 'error is fabric-disabled');
  } catch (e) {
    failed++;
    failures.push(String(e?.stack ?? e));
    console.log(`  ✗ threw: ${e?.stack ?? e}`);
  } finally {
    if (engine) {
      engine.kill('SIGKILL');
    }
    if (disabledEngine) {
      disabledEngine.kill('SIGKILL');
    }
    await fabric.stop().catch(() => {});
    await sleep(200);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* Windows: the killed engine may still hold the db open (EPERM); the temp dir is left behind */
    }
  }

  if (failed) {
    console.log('\nengine log (tail):\n' + engineLog.split('\n').slice(-40).join('\n'));
    console.log('\ndisabled-engine log (tail):\n' + disabledLog.split('\n').slice(-20).join('\n'));
    console.log('\nFAILURES:\n' + failures.map((f) => ' - ' + f).join('\n'));
  }
  console.log(`\nPASS ${passed}  FAIL ${failed}`);
  process.exit(failed ? 1 : 0);
}

function same(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, a === b ? msg : `${msg}\n      got      ${a}\n      expected ${b}`);
}

run();
