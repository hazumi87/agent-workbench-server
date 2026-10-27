/**
 * Held lines and the two ways out added on 2026-10-11 (Owner, room lines [ref]
 * and [ref]), through a real scratch engine, a real scratch broker and a STUB
 * `claude` (seat-reload.test.mjs's rig).
 *
 * What happened live: an F5 meant for the page reached a seat's pty. The draft
 * guard read a function key as "effect unknown", so every line the person
 * typed to that seat was held behind an empty input box until someone pressed
 * Deliver in the seat's own window.
 *
 *   1. A function key on a claude-code pane no longer holds anything
 *      (activity.ts fnKey + the vendor resolver wired in server/index.ts).
 *      A key that was NOT probed (F13) still holds: the guard itself is intact.
 *   2. `/deliver @handle` in the room releases a held queue. The user only:
 *      a seat (bearer + from) is refused.
 *   3. A draft the engine COUNTED (typed text never sent): `/deliver` asks
 *      first (the confirm step /remove uses, or a typed `confirm`), then sends
 *      the line stuck to that text, as its prompt says.
 *
 * SAFETY: scratch engine P(533), LIVE scratch broker P(534) (stub `claude`
 * panes); the fabric and NATS are off (childEnv); temp table; never
 * :7420/:7430/:8200/:8201/:8204. The temp dir is removed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

if (process.platform !== 'linux') {
  console.log('room-deliver.test: Linux only (POSIX stub claude) - skipped');
  process.exit(0);
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(533);
const BROKER_PORT = P(534);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'room-deliver-test-token';
const SENTINEL = 'ROOM-DELIVER-STUB-CLAUDE';
const LF = String.fromCharCode(10);
const ESC = String.fromCharCode(27);
const F5 = `${ESC}[15~`;
const F13 = `${ESC}[25~`; // not probed on a real claude: still "effect unknown"
const TARGETS = JSON.stringify({ targets: [{ id: 'local', label: 'Local', kind: 'local', shell: '/bin/bash' }] });

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg, got) {
  if (cond) {
    passed++;
    console.log(`  + ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  X ${msg}${got === undefined ? '' : ` (got ${JSON.stringify(got)})`}`);
  }
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg, a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 150) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(step);
  }
}

let cookie = '';
async function call(path, { json, as = 'bearer', method } = {}) {
  const headers = as === 'person' ? { cookie } : { authorization: `Bearer ${TOKEN}` };
  const init = { method: method ?? (json === undefined ? 'GET' : 'POST'), headers };
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  const res = await fetch(BASE + path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}

/* a raw /pty client: the window on the seat's pane (seat-reload.test.mjs's client()) */
function client() {
  const ws = new WebSocket(`ws://${HOST}:${PORT}/pty`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const log = [];
  const waiters = [];
  ws.on('error', () => {});
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    log.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) waiters.splice(i, 1)[0].resolve(msg);
    }
  });
  return {
    open: () => new Promise((resolve) => {
      ws.once('open', () => resolve(true));
      ws.once('error', () => resolve(false));
    }),
    send: (cmd) => ws.send(JSON.stringify(cmd)),
    wait: (pred, timeoutMs = 12000) =>
      new Promise((resolve) => {
        const hit = log.find(pred);
        if (hit) return resolve(hit);
        const t = setTimeout(() => resolve(null), timeoutMs);
        waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
      }),
    close: () => ws.close(),
  };
}

async function run() {
  for (const p of [PORT, BROKER_PORT]) {
    await assertFree(p, 'room-deliver.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-deliver-'));
  const binDir = join(tmpDir, 'bin');
  const typed = join(tmpDir, 'typed'); // <safe-paneid> -> every line the stub read
  mkdirSync(binDir);
  mkdirSync(typed);

  /* STUB CLAUDE (seat-reload.test.mjs's): a REPL that appends each line it
   * reads to a file named by its own HARBOR_WB_PANEID. */
  const safe = 'tr -c "A-Za-z0-9" "_"';
  const stubPath = join(binDir, 'claude');
  writeFileSync(
    stubPath,
    [
      '#!/bin/sh',
      `echo ${SENTINEL}`,
      `pid=$(printf '%s' "${'${HARBOR_WB_PANEID:-unknown}'}" | ${safe})`,
      `tf="${typed}/$pid"`,
      'echo "Claude Code v9.9.9"',
      'echo "? for shortcuts"',
      'while IFS= read -r line; do',
      `  printf '%s${LF}' "$line" >> "$tf"`,
      `  printf '%0900d${LF}' 0`,
      '  echo "? for shortcuts"',
      'done',
      '',
    ].join(LF),
  );
  chmodSync(stubPath, 0o755);
  const brokerEnv = childEnv({ PATH: `${binDir}${delimiter}${process.env.PATH || ''}`, PTY_BROKER_PORT: String(BROKER_PORT) });

  const probe = spawnSync('/bin/bash', ['-ic', 'command -v claude'], { env: brokerEnv, encoding: 'utf8', cwd: tmpDir });
  const resolved = String(probe.stdout || '').trim().split(LF).pop();
  if (resolved !== stubPath) {
    console.log(`X PREFLIGHT: the pane's shell resolves claude to ${JSON.stringify(resolved)}, not the stub ${stubPath}. Refusing to run.`);
    process.exit(2);
  }
  ok(true, 'preflight: the pane shell resolves claude to the stub');

  const typedLines = (paneid) => {
    const f = join(typed, paneid.replace(/[^A-Za-z0-9]/g, '_'));
    return existsSync(f) ? readFileSync(f, 'utf8').split(LF).filter(Boolean) : [];
  };
  const wasTyped = (paneid, needle, ms = 10000) => until(() => typedLines(paneid).some((l) => l.includes(needle)), ms);

  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  let log = '';
  let broker = null;
  let engine = null;
  const up = async (url) => {
    for (let i = 0; i < 120; i++) {
      if (await fetch(url).then((r) => r.status < 500).catch(() => false)) return true;
      await sleep(250);
    }
    return false;
  };
  const kill = async (proc) => {
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      const gone = new Promise((r) => proc.once('exit', r));
      proc.kill('SIGTERM');
      await Promise.race([gone, sleep(3000)]);
    }
  };
  let nextRecipe = 0;

  /* A claude-code recipe + a live attached pane, bound as the sole seat
   * (@agent, lead) of a fresh room. */
  async function seatedRoom(label) {
    const id = `rec-deliver-${++nextRecipe}`;
    const r = await call('/api/recipes', { json: { id, name: `Deliver ${label}`, target: 'local', projectDir: tmpDir, vendor: 'claude-code', agent: `deliver-${label.toLowerCase()}` } });
    ok(r.status === 200 && r.body?.recipe?.id, `${label}: recipe created`, r.body);
    const paneid = `recipe:${id}`;
    const c = client();
    ok(await c.open(), `${label}: /pty opens`);
    c.send({ type: 'attach', paneid, recipe: id });
    ok(!!(await c.wait((m) => m.type === 'pane.ready' && m.paneid === paneid)), `${label}: the pane spawns a real pty`);
    const room = (await call('/api/rooms', { json: { name: `Room ${label}` }, as: 'person' })).body;
    ok(!!room?.id, `${label}: a room`);
    const seatR = await call(`/api/rooms/${room.id}/seats`, { json: { recipe_id: id, handle: 'agent', policy: 'persistent', occupant: paneid }, as: 'person' });
    eq(seatR.status, 200, `${label}: seat @agent bound to the pane`);
    await sleep(1200); // the stub's banner clears the startup hold almost at once; this outlives it
    return { room, seat: seatR.body.seat, paneid, c };
  }
  const heldOf = async (roomId) => (await call(`/api/rooms/${roomId}`)).body?.seats?.[0]?.occupant?.held ?? null;
  const say = (roomId, text, as = 'person', from) => call(`/api/rooms/${roomId}/line`, { json: { text, ...(from ? { from } : {}) }, as });

  try {
    broker = spawn(process.execPath, ['--import', loaderArg, 'node_modules/pty-broker/src/main.ts'], { cwd: REPO_ROOT, env: brokerEnv });
    broker.stdout.on('data', (d) => (log += d));
    broker.stderr.on('data', (d) => (log += d));
    if (!(await up(`http://${HOST}:${BROKER_PORT}/health`))) throw new Error(`broker did not come up${LF}${log}`);
    engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_PORT: String(PORT),
        HARBOR_WB_HOST: HOST,
        HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'),
        HARBOR_WB_SEAT_WELCOME: '0', // the room welcome would sit in the typer queue these counts read
        HARBOR_WB_TOKEN: TOKEN,
        HARBOR_WB_IDENTITY: 'legacy',
        HARBOR_WB_NO_WINDOW: '1',
        HARBOR_WB_DESKTOP: 'none',
        HARBOR_WB_NATS_URL: '',
        HARBOR_WB_FABRIC_URL: '',
        HARBOR_WB_BROKER_AUTOSTART: '0',
        HARBOR_WB_BROKER_PORT: String(BROKER_PORT),
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_NODE: 'testnode',
        HARBOR_WB_TARGETS: TARGETS,
        HARBOR_WB_ROOM_TYPE_SETTLE_MS: '150',
        /* a nonexistent /proc root: the "claude owns the terminal" read answers
         * "could not tell" and delivers (seat-reload.test.mjs's own note) */
        HARBOR_WB_PROC_ROOT: join(tmpDir, 'noproc'),
      }),
    });
    engine.stdout.on('data', (d) => (log += d));
    engine.stderr.on('data', (d) => (log += d));
    if (!(await up(`${BASE}/health`))) throw new Error(`engine did not come up${LF}${log}`);
    cookie = await windowCookie(BASE, TOKEN);

    console.log(`${LF}[1. a function key on a claude pane holds nothing]`);
    const A = await seatedRoom('A');
    A.c.send({ type: 'input', paneid: A.paneid, data: F5 });
    await sleep(300); // let the classification land
    let r = await say(A.room.id, '@agent line one after F5');
    eq(r.status, 200, 'the person posts a line after an F5 reached the pane');
    ok(await wasTyped(A.paneid, 'line one after F5'), 'it is typed into the pane (the F5 did not make the box a draft)', { held: await heldOf(A.room.id), typed: typedLines(A.paneid) });
    eq(await heldOf(A.room.id), null, 'nothing is held on the seat');

    console.log(`${LF}[the guard is intact: a key that was not probed (F13) still holds]`);
    A.c.send({ type: 'input', paneid: A.paneid, data: F13 });
    await sleep(300);
    r = await say(A.room.id, '@agent line two behind F13');
    eq(r.status, 200, 'the line posts');
    /* line one was just typed, so the head first waits for it to land
     * (awaiting-idle); what must remain once that passes is the draft hold */
    ok(await until(async () => (await heldOf(A.room.id))?.reason === 'draft', 10000), 'the seat shows it held (reason: draft)', await heldOf(A.room.id));
    eq((await heldOf(A.room.id))?.depth, 1, 'one line held');
    ok(!typedLines(A.paneid).some((l) => l.includes('line two behind F13')), 'it was not typed');

    r = await say(A.room.id, '@agent line three behind the same draft');
    eq(r.status, 200, 'a second line is held behind the same draft');
    ok(await until(async () => (await heldOf(A.room.id))?.depth === 2, 5000), 'two lines held', await heldOf(A.room.id));

    console.log(`${LF}[2. /deliver: the user only]`);
    r = await say(A.room.id, '/deliver @agent', 'bearer', { paneid: A.paneid });
    eq(r.status, 200, 'a seat (bearer + from) gets an answer, not an error');
    eq(r.body?.status, 'refused', 'and it is refused');
    ok(String(r.body?.refused?.error ?? '').includes("is the user's"), "the refusal says delivering is the user's", r.body?.refused);
    await sleep(500);
    eq((await heldOf(A.room.id))?.depth, 2, 'both lines are still held after the seat tried');
    ok(!typedLines(A.paneid).some((l) => l.includes('line two behind F13')), 'and still not typed');

    r = await say(A.room.id, '/deliver @nobody');
    eq(r.body?.status, 'refused', '/deliver @nobody is refused (no such seat)');

    console.log(`${LF}[/deliver @agent from the person types the held line]`);
    r = await say(A.room.id, '/deliver @agent');
    eq(r.status, 200, 'the person runs /deliver @agent');
    eq(r.body?.status, 'applied', 'applied');
    eq(r.body?.entries?.[0]?.kind, 'fact', 'it writes a room fact');
    ok(String(r.body?.entries?.[0]?.body ?? '').includes("the user said @agent's input box is empty"), 'the fact says whose word it was', r.body?.entries?.[0]?.body);
    ok(await wasTyped(A.paneid, 'line two behind F13'), 'the held line is typed into the pane', typedLines(A.paneid));
    ok(await until(async () => (await heldOf(A.room.id)) === null, 5000), 'nothing is held any more');
    ok(log.includes('/deliver @agent by the user'), 'the engine log names the delivery');

    ok(await wasTyped(A.paneid, 'line three behind the same draft'), 'and so is the second held line', typedLines(A.paneid));
    r = await say(A.room.id, '/deliver @agent');
    eq(r.body?.status, 'refused', 'a /deliver with nothing held is refused');
    ok(String(r.body?.refused?.error ?? '').includes('has nothing held'), 'because nothing is held', r.body?.refused);

    r = await say(A.room.id, '/help');
    ok((r.body?.client?.data ?? []).some((c) => c.word === 'deliver' && c.usage === '/deliver @<handle>'), '/help lists /deliver @<handle>', (r.body?.client?.data ?? []).map((c) => c.word));
    A.c.close();

    console.log(`${LF}[3. a draft the engine COUNTED: /deliver asks first, then sends on the person's word]`);
    const B = await seatedRoom('B');
    B.c.send({ type: 'input', paneid: B.paneid, data: 'half a thought' }); // typed, never sent
    await sleep(300);
    r = await say(B.room.id, '@agent line behind real text');
    eq(r.status, 200, 'the line posts');
    await sleep(800);
    eq((await heldOf(B.room.id))?.reason, 'draft', 'held (reason: draft)');
    r = await say(B.room.id, '/deliver @agent');
    eq(r.body?.status, 'confirm', '/deliver asks for a confirm');
    ok(String(r.body?.confirm?.prompt ?? '').includes('typed text that was never sent'), 'the prompt names the typed text', r.body?.confirm);
    ok(String(r.body?.confirm?.prompt ?? '').includes('Send anyway?'), 'and asks "Send anyway?"', r.body?.confirm);
    const token = r.body?.confirm?.token;
    ok(typeof token === 'string' && token.length > 0, 'with a confirm token');
    await sleep(600);
    eq((await heldOf(B.room.id))?.depth, 1, 'nothing was typed before the confirm');
    ok(!typedLines(B.paneid).some((l) => l.includes('line behind real text')), 'the line is not in the pane yet');
    r = await call(`/api/rooms/${B.room.id}/line`, { json: { text: '/deliver @agent', confirm: token }, as: 'person' });
    eq(r.body?.status, 'applied', 'confirmed: applied');
    ok(await wasTyped(B.paneid, 'line behind real text'), 'the held line is typed', typedLines(B.paneid));
    ok(typedLines(B.paneid).some((l) => l.includes('half a thought') && l.includes('line behind real text')), 'stuck to the typed text, as the prompt said', typedLines(B.paneid));
    ok(await until(async () => (await heldOf(B.room.id)) === null, 5000), 'nothing is held');

    console.log(`${LF}[keep_draft: a command a page control issued leaves the person's composer draft alone]`);
    const draftOf = async () => (await call(`/api/rooms/${B.room.id}/draft`, { as: 'person' })).body?.text ?? null;
    r = await call(`/api/rooms/${B.room.id}/draft`, { json: { text: 'what I was typing' }, as: 'person', method: 'PUT' });
    eq(r.status, 200, 'the person has a draft in the composer');
    B.c.send({ type: 'input', paneid: B.paneid, data: F13 });
    await sleep(300);
    r = await call(`/api/rooms/${B.room.id}/line`, { json: { text: '@agent line for the keep_draft case', keep_draft: true }, as: 'person' });
    eq(await draftOf(), 'what I was typing', 'a line posted with keep_draft leaves the draft');
    ok(await until(async () => (await heldOf(B.room.id))?.reason === 'draft', 10000), 'that line is held (reason: draft)', await heldOf(B.room.id));
    r = await call(`/api/rooms/${B.room.id}/line`, { json: { text: '/deliver @agent', keep_draft: true }, as: 'person' });
    eq(r.body?.status, 'applied', '/deliver from a control applies');
    eq(await draftOf(), 'what I was typing', 'and the draft is still there');
    ok(await wasTyped(B.paneid, 'line for the keep_draft case'), 'the held line is typed');
    r = await say(B.room.id, '@agent a normal typed message');
    eq(await draftOf(), '', 'a normal post still clears the draft, as before');
    ok(await wasTyped(B.paneid, 'a normal typed message'), 'and is typed');

    console.log(`${LF}[the typed form: /deliver @agent confirm]`);
    B.c.send({ type: 'input', paneid: B.paneid, data: 'more text' });
    await sleep(300);
    r = await say(B.room.id, '@agent second line behind real text');
    ok(await until(async () => (await heldOf(B.room.id))?.reason === 'draft', 10000), 'held again (reason: draft)', await heldOf(B.room.id));
    r = await say(B.room.id, '/deliver @agent confirm');
    eq(r.body?.status, 'applied', 'the typed confirm applies at once');
    ok(await wasTyped(B.paneid, 'second line behind real text'), 'and the line is typed');
    B.c.close();
  } catch (e) {
    failed++;
    failures.push(`threw: ${e?.stack ?? e}`);
    console.log(`  X threw: ${e?.stack ?? e}`);
    console.log(`--- log tail ---${LF}${log.slice(-4000)}`);
  } finally {
    await kill(engine);
    await kill(broker);
    rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log(`${LF}PASS ${passed} FAIL ${failed}`);
  if (failed) {
    console.log(failures.map((f) => ` - ${f}`).join(LF));
    process.exit(1);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
