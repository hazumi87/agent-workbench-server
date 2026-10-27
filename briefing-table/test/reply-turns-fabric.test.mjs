/**
 * The reply-turn "your turn" line goes out on the FABRIC, signed as the room
 * (room-fabric.ts turnLine; Owner 2026-10-11, room lines [ref] / [ref]).
 *
 * Why this suite exists. With reply turns on, a seat whose post is refused
 * ("NOT POSTED ... wait for your turn line") waits for one line from the engine.
 * That line was handed to the room door only, which does not type into a pane
 * that has a live channel, and no fabric copy was sent: on the server, 2026-10-11,
 * three floors timed out with both seats idle. The envelope asserted here is the
 * exact one measured waking an idle seat that day (from room-<id8>, kind ask,
 * the room's thread, ref room:<id>/line:<fact>, engine bearer, no instance).
 *
 * One scratch engine on P() ports with a temp mapping db, NO broker and NO pty
 * (the broker port is a dead P() port), and a stub fabric that records /threads
 * and /send. Session rows are seeded `live` through the store after boot, as
 * reply-turns-routes.test.mjs does.
 *
 * SAFETY: never touches :7420/:7430/:8200/:8201/:8204, the real data dir, a
 * broker, or the real fabric. Every child env comes from childEnv().
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const HOST = '127.0.0.1';
const TOKEN = 'reply-turns-fabric-token';
const PORT = P(530);
const DEAD_BROKER_PORT = P(531);
const FABRIC_PORT = P(532); // the stub fabric — NOT 8204 (the real one)
const WINDOW_MS = 1500;

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ok ${msg}`);
  } else {
    failed++;
    console.log(`  FAIL ${msg}`);
  }
}
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)})`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = f();
    if (v) return v;
    await sleep(50);
  }
  return f();
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

const pane = (k) => `recipe:rec-${k}#1`;
const meta = (e) => {
  try {
    return e?.meta ? JSON.parse(e.meta) : {};
  } catch {
    return {};
  }
};

async function run() {
  for (const p of [PORT, DEAD_BROKER_PORT, FABRIC_PORT]) {
    await assertFree(p, 'reply-turns-fabric.test.mjs');
  }

  /* The stub fabric: the room's thread opens, every /send is recorded with the
     headers it arrived with. `refuse` makes /send answer like a fabric that
     requires check-in and has none for the sender. */
  const sends = [];
  const threads = [];
  let refuse = false;
  const fabricStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const json = (code, body) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        /* not json */
      }
      const path = (req.url ?? '').split('?')[0];
      if (path === '/threads' && req.method === 'POST') {
        threads.push(body);
        return json(200, { thread: 't-turns' });
      }
      if (path === '/send' && req.method === 'POST') {
        sends.push({ env: body ?? {}, auth: req.headers.authorization ?? null, instance: req.headers['x-fabric-instance'] ?? null, refused: refuse });
        return refuse ? json(409, { error: 'not-checked-in' }) : json(202, { envelope: { id: `env-${sends.length}`, ...(body ?? {}) } });
      }
      return json(404, { error: 'not-here' });
    });
  });
  await new Promise((r) => fabricStub.listen(FABRIC_PORT, HOST, r));

  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-reply-turns-fabric-'));
  const dbPath = join(tmpDir, 'mapping.db');
  const base = `http://${HOST}:${PORT}`;
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) {
      throw new Error(`seed failed: ${r.err}`);
    }
  };
  await seed({
    recipes: ['a', 'b', 'c'].map((k) => ({ id: `rec-${k}`, name: `R${k}`, projectDir: `/srv/x/${k}`, vendor: 'claude-code', agent: `agent-${k}` })),
  });
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  let log = '';
  const engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT),
      HARBOR_WB_HOST: HOST,
      HARBOR_WB_TABLE: dbPath,
      HARBOR_WB_TOKEN: TOKEN,
      HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'),
      HARBOR_WB_IDENTITY: 'legacy',
      HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_NATS_URL: '',
      HARBOR_WB_FABRIC_URL: `http://${HOST}:${FABRIC_PORT}`,
      HARBOR_WB_ROOM_FABRIC: '1',
      HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT),
      HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
      HARBOR_WB_NODE: 'testnode',
      HARBOR_WB_REPLY_TURNS: 'enforce',
      HARBOR_WB_TURN_SWEEP_MS: '200',
      HARBOR_WB_TURN_WINDOW_MS: String(WINDOW_MS),
    }),
  });
  engine.stdout.on('data', (d) => (log += d));
  engine.stderr.on('data', (d) => (log += d));

  try {
    let up = false;
    for (let i = 0; i < 160 && !up; i++) {
      await sleep(250);
      up = await fetch(`${base}/health`).then((r) => r.ok).catch(() => false);
    }
    if (!up) {
      throw new Error(`engine did not come up\n${log}`);
    }
    await seed({
      sessions: ['a', 'b', 'c'].map((k) => ({ paneid: pane(k), recipe_id: `rec-${k}`, vendor: 'claude-code', agent: `agent-${k}`, session_id: `s-${k}`, state: 'live' })),
    });
    const login = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(TOKEN)}`, redirect: 'manual' });
    const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    /* who: 'user' = the window cookie; otherwise the bearer (a seat names its pane in the body) */
    const call = async (path, { json, who = 'bearer' } = {}) => {
      const headers = who === 'user' ? { cookie } : { authorization: `Bearer ${TOKEN}` };
      const init = { method: json !== undefined ? 'POST' : 'GET', headers, redirect: 'manual' };
      if (json !== undefined) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(json);
      }
      const res = await fetch(base + path, init);
      let body = null;
      try {
        body = await res.json();
      } catch {
        /* not json */
      }
      return { status: res.status, body };
    };

    const made = await call('/api/rooms', { json: { name: 'Turns on the fabric' }, who: 'user' });
    if (made.status !== 200) {
      throw new Error(`room: ${made.status} ${JSON.stringify(made.body)}`);
    }
    const room = made.body.id;
    for (const k of ['a', 'b', 'c']) {
      const s = await call(`/api/rooms/${room}/seats`, { json: { recipe_id: `rec-${k}`, occupant: pane(k), handle: k }, who: 'user' });
      if (s.status !== 200) {
        throw new Error(`seat ${k}: ${s.status} ${JSON.stringify(s.body)}`);
      }
    }
    const SENDER = `room-${room.slice(0, 8).toLowerCase()}`;
    const lines = async () => (await call(`/api/rooms/${room}/line`)).body.entries;
    const ask = async (text) => (await call(`/api/rooms/${room}/line`, { json: { text }, who: 'user' })).body.entries[0].id;
    const say = (k, text, extra = {}) => call(`/api/rooms/${room}/line`, { json: { text, from: { paneid: pane(k) }, ...extra } });
    const claim = (k, line, extra = {}) => call(`/api/rooms/${room}/lines/${line}/claim`, { json: { from: { paneid: pane(k) }, ...extra } });
    const turnSends = () => sends.filter((s) => /^Your turn in thread #/.test(String(s.env.body ?? '')));
    const floorFact = async (lineId, handle) => (await lines()).find((l) => l.kind === 'fact' && meta(l).turn?.kind === 'floor' && meta(l).turn.lines?.includes(lineId) && new RegExp(`^@${handle} has the floor`).test(l.body ?? ''));
    const grantOf = (s) => (/ grant: (\S+)$/.exec(String(s.env.body)) ?? [])[1];
    const grants = [];

    /* LOCAL MODE (E6): a local engine never calls the fabric, so the same first scenario runs with the stub fabric pointed at and the
       assertion is turned around: the room rules still work (the floor passes, the fact is written), and the stub sees NOTHING. */
    if (process.env.WB_TEST_LOCAL_MODE === '1') {
      console.log('\n[local mode: the floor passes, and nothing reaches the fabric]');
      const lq = await ask('@a @b which approach would you take?');
      eq((await say('b', 'my take first', { reply_to: lq })).body?.status, 'held', '@b answers before @a: held, as on the server engine');
      eq((await say('a', 'I would go with the queue', { reply_to: lq })).status, 200, '@a answers');
      ok(!!(await until(() => floorFact(lq, 'b'))), 'the room fact says @b has the floor (the rules ran)');
      await sleep(1500);
      eq(sends.length, 0, 'the engine sent the stub fabric NOTHING');
      eq(threads.length, 0, "and opened no fabric thread for the room");
      return;
    }

    /* ------------------------------------------------ after an answer ---- */
    console.log('\n[the floor passes after an answer: the turn line reaches the fabric]');
    const q1 = await ask('@a @b which approach would you take?');
    const early = await say('b', 'my take first', { reply_to: q1 });
    eq(early.body?.status, 'held', '@b answers before @a: NOT POSTED, told to wait for its turn line');
    eq(turnSends().length, 0, 'no turn line yet');
    const a1 = await say('a', 'I would go with the queue', { reply_to: q1 });
    eq(a1.status, 200, '@a answers');
    const t1 = await until(() => turnSends()[0]);
    ok(!!t1, 'the engine sends @b its turn line through the fabric');
    const fact1 = await floorFact(q1, 'b');
    ok(!!fact1, 'and the room fact says @b has the floor');
    if (t1 && fact1) {
      eq(t1.env.from, SENDER, 'signed as the room (never the user: a seat channel drops user mail)');
      eq(t1.env.to, 'agent-b', "to @b's slug");
      eq(t1.env.kind, 'ask', 'as an ask');
      eq(t1.env.class, 'coordination', 'class coordination');
      eq(t1.env.thread, 't-turns', "on the room's fabric thread");
      eq(t1.env.ref, `room:${room}/line:${fact1.id}`, 'with the room ref of the floor fact (a room copy: never typed twice)');
      ok(new RegExp(`^Your turn in thread #${q1}: you are answering #${q1}\\.`).test(t1.env.body), 'the body is the turn line: the thread and what it answers');
      ok(/room_read since=/.test(t1.env.body) && /room_claim with pass/.test(t1.env.body), 'with where to read and how to pass');
      eq(t1.auth, `Bearer ${TOKEN}`, 'sent on the engine bearer');
      eq(t1.instance, null, 'with no instance header (the engine stamp, not a pane)');
      const g = grantOf(t1);
      grants.push(g);
      ok(!!g && !String(fact1.body).includes(g) && !JSON.stringify(meta(fact1)).includes(g), 'the grant rides the turn line, never the room fact');
      const ack = await claim('b', q1, { grant: g });
      ok(ack.status === 200 && ack.body?.acknowledged === true, 'the grant from the fabric copy acknowledges the turn');
    }
    await sleep(500);
    eq(turnSends().length, 1, 'exactly one turn line for one floor');
    ok(!sends.some((s) => s.env.to === 'agent-a' && /^Your turn/.test(String(s.env.body))), "@a got none: its own post was its turn");
    ok(/turn line #\d+ \S+ @b \(agent-b\) sent on fabric thread t-turns/.test(log), 'the journal names the send');
    eq((await say('b', 'and I would add a timeout', { reply_to: q1 })).status, 200, '@b posts on its turn');

    /* ------------------------------------------------------ a lapse ---- */
    console.log('\n[the floor passes when the seat ahead stays silent: the sweep path]');
    const q2 = await ask('@a @b a second question');
    const n2 = turnSends().length;
    eq((await say('b', 'me again', { reply_to: q2 })).body?.status, 'held', '@b is held behind a silent @a');
    await sleep(Math.floor(WINDOW_MS / 3));
    eq(turnSends().length, n2, "nothing is sent while @a's window is open");
    const t2 = await until(() => turnSends()[n2], WINDOW_MS + 5000);
    const fact2 = await floorFact(q2, 'b');
    ok(!!t2 && !!fact2, "when @a's window lapses the sweep gives @b the floor and sends its turn line");
    if (t2 && fact2) {
      eq(t2.env.from, SENDER, 'signed as the room');
      eq(t2.env.to, 'agent-b', "to @b's slug");
      eq(t2.env.ref, `room:${room}/line:${fact2.id}`, 'with the ref of this floor fact');
      grants.push(grantOf(t2));
    }
    eq((await say('b', 'my second answer', { reply_to: q2 })).status, 200, '@b posts');

    /* ----------------------------------------- a claim that gets the floor ---- */
    console.log('\n[a claim that gets the floor at once is answered in the response: no turn line]');
    const q3 = await ask('@a @b a third question');
    const n3 = turnSends().length;
    const ca = await claim('a', q3);
    ok(ca.status === 200 && ca.body?.state === 'floor' && typeof ca.body.grant === 'string', '@a claims and holds the floor');
    grants.push(ca.body?.grant);
    await sleep(700);
    eq(turnSends().length, n3, 'no turn line is sent to the claimant');
    eq((await claim('b', q3)).body?.state, 'queued', '@b queues behind @a');
    eq((await claim('a', q3, { pass: true })).body?.passed, true, '@a passes');
    const t3 = await until(() => turnSends()[n3]);
    ok(!!t3 && t3.env.to === 'agent-b' && t3.env.from === SENDER, 'the pass hands @b the floor, and its turn line goes out');
    grants.push(t3 ? grantOf(t3) : undefined);
    eq((await say('b', 'my third answer', { reply_to: q3 })).status, 200, '@b posts');

    /* ------------------------------------------------- a fabric refusal ---- */
    console.log('\n[a fabric that refuses the send: the room carries on, and the journal says so]');
    const q4 = await ask('@a @b a fourth question');
    eq((await say('b', 'early again', { reply_to: q4 })).body?.status, 'held', '@b is held');
    refuse = true;
    const n4 = turnSends().length;
    eq((await say('a', 'my answer', { reply_to: q4 })).status, 200, "@a's answer is still written");
    const t4 = await until(() => turnSends()[n4]);
    ok(!!t4 && t4.refused === true, 'the engine tried the send');
    ok(!!(await floorFact(q4, 'b')), 'the room fact is still written');
    ok(!!(await until(() => /turn line #\d+ \S+ @b \(agent-b\) fabric refused HTTP 409 not-checked-in/.test(log))), 'the journal names the refusal and its reason');
    grants.push(t4 ? grantOf(t4) : undefined);
    refuse = false;
    eq((await say('b', 'my fourth answer', { reply_to: q4 })).status, 200, '@b can still post (it holds the floor)');

    /* -------------------------------------------------------- never logged ---- */
    console.log('\n[a grant is never logged]');
    const real = grants.filter((g) => typeof g === 'string' && g.length > 0);
    ok(real.length >= 4, `the suite saw ${real.length} grants`);
    ok(!real.some((g) => log.includes(g)), 'none of them is in the engine log');
    ok(!sends.some((s) => s.env.from === 'user' && /^Your turn/.test(String(s.env.body))), 'no turn line was ever signed as the user');
    eq(threads.length, 1, "the room's fabric thread was opened once");
  } finally {
    engine.kill('SIGKILL');
    await sleep(200);
    fabricStub.closeAllConnections?.();
    await new Promise((r) => fabricStub.close(r));
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

run()
  .catch((err) => {
    failed++;
    console.log(`  FAIL run aborted: ${err?.stack ?? err}`);
  })
  .finally(() => {
    console.log(`PASS ${passed} FAIL ${failed}`);
    process.exit(failed ? 1 : 0);
  });
