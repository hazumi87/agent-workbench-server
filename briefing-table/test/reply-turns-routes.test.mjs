/**
 * Reply turns through a real scratch engine (the design notes checks
 * 1, 15 and 17 at the HTTP doors; the rules themselves are reply-turns.test.ts).
 *
 * Two boots on P() ports, each with a temp mapping db, NO broker and NO pty
 * (the broker port is a dead P() port). Session rows are seeded through the
 * store (test/rooms-routes.seed.ts) AFTER boot as `live`, exactly as
 * rooms-routes.test.mjs does. The person posts on the window cookie; seats post
 * on the bearer + from:{paneid} door (the fabric MCP's room_post door).
 *
 * SAFETY: never touches :7420/:7430/:8200/:8201/:8204, the real data dir, or a
 * broker. Every child env comes from childEnv(). Temp dirs are removed.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const HOST = '127.0.0.1';
const TOKEN = 'reply-turns-routes-token';

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

/** Boot one scratch engine; returns {base, call, seed, stop}. */
async function boot(port, deadBroker, extraEnv) {
  for (const p of [port, deadBroker]) {
    await assertFree(p, 'reply-turns-routes.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-reply-turns-'));
  const dbPath = join(tmpDir, 'mapping.db');
  const base = `http://${HOST}:${port}`;
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) {
      throw new Error(`seed failed: ${r.err}`);
    }
    return JSON.parse(r.out.trim().split('\n').pop());
  };
  await seed({
    recipes: ['a', 'b', 'c', 'z'].map((k) => ({ id: `rec-${k}`, name: `R${k}`, projectDir: `/srv/x/${k}`, vendor: 'claude-code', agent: `agent-${k}` })),
  });
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  let log = '';
  const engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(port),
      HARBOR_WB_HOST: HOST,
      HARBOR_WB_TABLE: dbPath,
      HARBOR_WB_TOKEN: TOKEN,
      HARBOR_WB_IDENTITY: 'legacy',
      HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_NATS_URL: '',
      HARBOR_WB_FABRIC_URL: '',
      HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(deadBroker),
      HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
      HARBOR_WB_NODE: 'testnode',
      HARBOR_WB_TURN_SWEEP_MS: '200',
      ...extraEnv,
    }),
  });
  engine.stdout.on('data', (d) => (log += d));
  engine.stderr.on('data', (d) => (log += d));
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    await sleep(250);
    up = await fetch(`${base}/health`).then((r) => r.ok).catch(() => false);
  }
  if (!up) {
    engine.kill('SIGKILL');
    throw new Error(`engine did not come up\n${log}`);
  }
  await seed({
    sessions: ['a', 'b', 'c', 'z'].map((k) => ({ paneid: `recipe:rec-${k}#1`, recipe_id: `rec-${k}`, vendor: 'claude-code', agent: `agent-${k}`, session_id: `s-${k}`, state: 'live' })),
  });
  /* legacy identity: the window login is a form post of the shared token */
  const login = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(TOKEN)}`, redirect: 'manual' });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  /* who: 'user' = the window cookie; otherwise the bearer (a seat names its pane in the body) */
  const call = async (path, { json, method, who = 'bearer' } = {}) => {
    const headers = who === 'user' ? { cookie } : { authorization: `Bearer ${TOKEN}` };
    const init = { method: method ?? (json !== undefined ? 'POST' : 'GET'), headers, redirect: 'manual' };
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
  const stop = async () => {
    engine.kill('SIGKILL');
    await sleep(200);
    rmSync(tmpDir, { recursive: true, force: true });
  };
  return { call, stop, log: () => log };
}

const pane = (k) => `recipe:rec-${k}#1`;
const meta = (e) => {
  try {
    return e?.meta ? JSON.parse(e.meta) : {};
  } catch {
    return {};
  }
};

async function makeRoom(e, name) {
  const room = await e.call('/api/rooms', { json: { name }, who: 'user' });
  if (room.status !== 200) {
    throw new Error(`room: ${room.status} ${JSON.stringify(room.body)}`);
  }
  for (const k of ['a', 'b', 'c']) {
    const s = await e.call(`/api/rooms/${room.body.id}/seats`, { json: { recipe_id: `rec-${k}`, occupant: pane(k), handle: k }, who: 'user' });
    if (s.status !== 200) {
      throw new Error(`seat ${k}: ${s.status} ${JSON.stringify(s.body)}`);
    }
  }
  return room.body.id;
}

async function run() {
  /* ------------------------------------------------------------ enforce ---- */
  console.log('\n[enforce: holds, facts, claim route, my_turns]');
  let e = await boot(P(510), P(511), { HARBOR_WB_REPLY_TURNS: 'enforce' });
  try {
    const room = await makeRoom(e, 'Turns');
    const lines = async () => (await e.call(`/api/rooms/${room}/line`)).body.entries;
    const say = (k, text, extra = {}) => e.call(`/api/rooms/${room}/line`, { json: { text, from: { paneid: pane(k) }, ...extra } });

    const q = await e.call(`/api/rooms/${room}/line`, { json: { text: '@a @b which approach would you take?' }, who: 'user' });
    eq(q.status, 200, 'the person writes to @a @b');
    const qid = q.body.entries[0].id;
    ok(meta(q.body.entries[0]).thread === undefined, 'the opening line carries no meta.thread (its thread is its own id)');

    const before = (await lines()).length;
    const early = await say('b', 'my take first', { reply_to: qid });
    eq(early.status, 409, '@b answering before @a (inside the window) is refused 409');
    eq(early.body?.status, 'held', 'with status:"held"');
    eq(early.body?.behind, '@a', 'naming who it waits behind');
    ok(/NOT POSTED/.test(early.body?.message ?? ''), 'and the NOT POSTED message the fabric client already understands');
    eq((await lines()).length, before, 'nothing was written to the room');

    const mt = await e.call(`/api/rooms/${room}?for_pane=${encodeURIComponent(pane('b'))}`);
    const t = (mt.body?.my_turns ?? [])[0];
    ok(!!t && t.thread === qid && t.state === 'queued' && t.behind === '@a', 'GET room ?for_pane= answers my_turns: queued behind @a');

    const ans = await say('a', 'I would go with the queue', { reply_to: qid });
    eq(ans.status, 200, '@a answers');
    eq(meta(ans.body.entries[0]).thread, qid, "@a's line carries meta.thread = the opening line");
    await sleep(100);
    const fact = (await lines()).find((l) => l.kind === 'fact' && meta(l).turn?.seat);
    ok(!!fact && /^@b has the floor on #\d+ \(after @a\)$/.test(fact.body), 'a room fact says @b has the floor, after @a');
    ok(!!fact && !/grant/i.test(fact.body) && !JSON.stringify(meta(fact)).includes('grant'), 'the fact carries no grant');

    const bAns = await say('b', 'and I would add a timeout', { reply_to: qid });
    eq(bAns.status, 200, '@b may post now');

    /* claim / pass through the route */
    const q2 = await e.call(`/api/rooms/${room}/line`, { json: { text: '@a @b next question' }, who: 'user' });
    const q2id = q2.body.entries[0].id;
    const ca = await e.call(`/api/rooms/${room}/lines/${q2id}/claim`, { json: { from: { paneid: pane('a') } } });
    ok(ca.status === 200 && ca.body.state === 'floor' && typeof ca.body.grant === 'string', 'a claim answers state floor with a grant');
    const cb = await e.call(`/api/rooms/${room}/lines/${q2id}/claim`, { json: { from: { paneid: pane('b') } } });
    ok(cb.status === 200 && cb.body.state === 'queued' && cb.body.behind === '@a', 'a second claim answers queued behind @a');
    const ack = await e.call(`/api/rooms/${room}/lines/${q2id}/claim`, { json: { from: { paneid: pane('a') }, grant: ca.body.grant } });
    ok(ack.status === 200 && ack.body.acknowledged === true, 'the grant acknowledges the turn');
    const pass = await e.call(`/api/rooms/${room}/lines/${q2id}/claim`, { json: { from: { paneid: pane('a') }, pass: true } });
    ok(pass.status === 200 && pass.body.passed === true, '@a passes');
    await sleep(100);
    ok((await lines()).some((l) => l.kind === 'fact' && /^@b has the floor on #/.test(l.body ?? '') && meta(l).turn?.lines?.includes(q2id)), '@b gets the floor at once, with a fact');

    /* floor-fix 3: the person's floor controls, through the line door */
    const qf = await e.call(`/api/rooms/${room}/line`, { json: { text: '@a @b @c floor commands' }, who: 'user' });
    const qfid = qf.body.entries[0].id;
    await e.call(`/api/rooms/${room}/lines/${qfid}/claim`, { json: { from: { paneid: pane('a') } } });
    await e.call(`/api/rooms/${room}/lines/${qfid}/claim`, { json: { from: { paneid: pane('b') } } });
    const seatTake = await say('b', '/floor take');
    ok(seatTake.status !== 200 || seatTake.body?.status === 'refused', 'a seat cannot use /floor take (the user only)');
    const skipA = await e.call(`/api/rooms/${room}/line`, { json: { text: '/floor skip @a' }, who: 'user' });
    ok(skipA.status === 200 && skipA.body.status === 'applied', '/floor skip @a: applied');
    await sleep(100);
    const afterSkip = await lines();
    ok(afterSkip.some((l) => l.kind === 'fact' && /^@a was skipped by the user on #\d+$/.test(l.body ?? '')), 'a room fact says @a was skipped by the user');
    ok(afterSkip.some((l) => l.kind === 'fact' && /^@b has the floor on #/.test(l.body ?? '') && meta(l).turn?.lines?.includes(qfid)), 'and @b has the floor');
    const take = await e.call(`/api/rooms/${room}/line`, { json: { text: '/floor take' }, who: 'user' });
    ok(take.status === 200 && take.body.status === 'applied', '/floor take: applied while @b holds');
    await sleep(100);
    ok((await lines()).some((l) => l.kind === 'fact' && /^@b was skipped by the user on #/.test(l.body ?? '')), 'and @b was skipped by the user');
    const again = await e.call(`/api/rooms/${room}/line`, { json: { text: '/floor take' }, who: 'user' });
    ok(again.status === 200 && again.body.status === 'refused', '/floor take with nobody holding: refused, not an error');
    const turn = await e.call(`/api/rooms/${room}/line`, { json: { text: '/set turn 3' }, who: 'user' });
    ok(turn.status === 200 && turn.body.status === 'applied' && (turn.body.entries ?? []).some((l) => l.body === 'turn time for this room: 3 min'), '/set turn 3: applied, with a room fact');
    const badTurn = await e.call(`/api/rooms/${room}/line`, { json: { text: '/set turn soon' }, who: 'user' });
    ok(badTurn.body?.status === 'refused', '/set turn soon: refused');

    /* 17: errors answer with a reason, never a 500 */
    const unknown = await e.call(`/api/rooms/${room}/lines/999999/claim`, { json: { from: { paneid: pane('a') } } });
    ok(unknown.status === 409 && unknown.body?.error === 'no_turns', 'an unknown line: 409 no_turns');
    const bad = await e.call(`/api/rooms/${room}/lines/${q2id}/claim`, { json: { from: { paneid: pane('b') }, grant: 'made-up' } });
    ok(bad.status === 409 && bad.body?.error === 'wrong_grant', 'a wrong grant: 409 wrong_grant');
    const notSeated = await e.call(`/api/rooms/${room}/lines/${q2id}/claim`, { json: { from: { paneid: pane('z') } } });
    eq(notSeated.status, 403, 'a pane with no seat here: 403');
    const noFrom = await e.call(`/api/rooms/${room}/lines/${q2id}/claim`, { json: {} });
    ok(noFrom.status === 403 || noFrom.status === 409, `the bearer with no from: refused (${noFrom.status}), never a 500`);
    const word = await e.call(`/api/rooms/${room}/lines/abc/claim`, { json: { from: { paneid: pane('a') } } });
    ok(word.status === 409 && word.body?.error === 'no_turns', 'a line id that is not a number: 409 no_turns');

    /* the person is never held; a single seat line still flows */
    const solo = await e.call(`/api/rooms/${room}/line`, { json: { text: '@c can you look too?' }, who: 'user' });
    eq(solo.status, 200, 'the person is never held');
    const cAns = await say('c', 'looking now', { reply_to: solo.body.entries[0].id });
    eq(cAns.status, 200, 'a seat answering a line that named only it posts at once');

    /* read before post (2026-10-12, [ref]): both were typed the line, @a answered, @b was never handed that answer */
    const room3 = await makeRoom(e, 'ReadBeforePost'); // its own room: a follow-up to a and b would join the pending thread above
    const lines3 = async () => (await e.call(`/api/rooms/${room3}/line`)).body.entries;
    const say3 = (k, text, extra = {}) => e.call(`/api/rooms/${room3}/line`, { json: { text, from: { paneid: pane(k) }, ...extra } });
    const q3 = await e.call(`/api/rooms/${room3}/line`, { json: { text: '@a @b one more thing' }, who: 'user' });
    const q3id = q3.body.entries[0].id;
    const a3 = await say3('a', 'first answer', { reply_to: q3id });
    eq(a3.status, 200, '@a answers the two-seat line first');
    const n3 = (await lines3()).length;
    const b3 = await say3('b', 'me too', { reply_to: q3id });
    eq(b3.status, 409, '@b posting without having been handed @a\'s answer is stopped');
    eq(b3.body?.status, 'held', 'with the held status the fabric client already understands');
    ok(/newer lines landed in this thread/.test(b3.body?.message ?? '') && /Do not retry/.test(b3.body?.message ?? ''), 'and a message that says why and not to retry');
    eq((await lines3()).length - n3, 1, 'nothing of @b was written; only the floor fact for its turn');
    const f3 = (await lines3()).find((l) => l.kind === 'fact' && meta(l).turn?.seat && meta(l).turn.lines?.includes(q3id));
    ok(!!f3 && /^@b has the floor on #\d+ \(after @a\)$/.test(f3.body), 'the fact says @b has the floor, after @a');
    const b3b = await say3('b', 'having read it: one addition', { reply_to: q3id });
    eq(b3b.status, 200, 'with the floor and the answer handed over, @b posts');
    /* CLOSED (toolkit [ref]): the last answer empties the queue; one hidden fact says so */
    await sleep(100);
    const closed3 = (await lines3()).filter((l) => l.kind === 'fact' && meta(l).turn?.kind === 'closed');
    ok(closed3.length === 1 && meta(closed3[0]).turn.thread === q3id && meta(closed3[0]).hidden === true, 'the emptied thread gets ONE closed fact {thread, kind:"closed"}, marked hidden');
    ok(closed3[0]?.body === `the floor on #${q3id} is closed` && !meta(closed3[0]).turn.seat, '...with plain words and no seat');
  } finally {
    await e.stop();
  }

  /* --------------------------------------------------------------- off ---- */
  console.log('\n[off (the default): exactly today]');
  e = await boot(P(512), P(513), {});
  try {
    const room = await makeRoom(e, 'Off');
    const q = await e.call(`/api/rooms/${room}/line`, { json: { text: '@a @b which approach?' }, who: 'user' });
    const qid = q.body.entries[0].id;
    const b = await e.call(`/api/rooms/${room}/line`, { json: { text: 'b first', from: { paneid: pane('b') }, reply_to: qid } });
    eq(b.status, 200, 'no hold: @b posts before @a');
    ok(meta(b.body.entries[0]).thread === undefined, 'no meta.thread is written');
    const c = await e.call(`/api/rooms/${room}/lines/${qid}/claim`, { json: { from: { paneid: pane('a') } } });
    ok(c.status === 409 && c.body?.error === 'no_turns', 'the claim route answers 409 no_turns');
    const mt = await e.call(`/api/rooms/${room}?for_pane=${encodeURIComponent(pane('b'))}`);
    ok(mt.status === 200 && !('my_turns' in (mt.body ?? {})), 'my_turns is absent');
    const lines = (await e.call(`/api/rooms/${room}/line`)).body.entries;
    ok(!lines.some((l) => meta(l).turn), 'no turn facts');
  } finally {
    await e.stop();
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
