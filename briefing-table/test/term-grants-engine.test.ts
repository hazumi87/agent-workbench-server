/**
 * W3b terminal grants through a real scratch engine + broker (identity `both`):
 * POST /api/terminal-grants and WS /term (src/server/term.ts). The refusal
 * matrix of spec §8, the control room lines, the close-on-change hooks, /pty
 * still upgrading beside /term, and logs that never carry a grant or input.
 * The store, the entitlement rule, expiry and the idle / absolute limits are
 * unit-tested on a fake clock in test/term-grants.test.ts.
 *
 * The engine boots twice on one table: once with HARBOR_WB_TERM_GRANTS unset
 * (the route is 404, /term refuses), then with it on. Bash panes
 * (cli-manager recipes: nothing real is launched). The mint rate is 10 per
 * person per minute, so `mint` paces itself and the run takes a few minutes.
 * SAFETY: scratch engine P(544) + LIVE scratch broker P(545), temp table and
 * identity db, childEnv(), fabric + NATS off; never :7420/:7430/:8200/:8201/
 * :8204. The temp dir is removed.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { P, assertFree, childEnv, scratchShell } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(544);
const BROKER_PORT = P(545);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'term-grants-test-token';
const WB = 'app://workbench';
const TARGETS = JSON.stringify({ targets: [{ id: 'local', label: 'Local', kind: 'local', shell: scratchShell() }] });

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-term-grants-'));
const dbPath = join(tmpDir, 'mapping.db');
const identityDb = join(tmpDir, 'identity.db');
process.env.HARBOR_WB_IDENTITY_DB = identityDb;
process.env.HARBOR_WB_IDENTITY = 'both';
const idStore = await import('../src/identity/store.ts');

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

/* ---- people: one account, two sign-ins, an api token ---- */
const owner = idStore.createAccount({ username: 'owner', passwordHash: 'unused', mustChange: false, passwordExpiresAt: null, isAdmin: true });
const S1 = idStore.mintToken();
const S2 = idStore.mintToken();
idStore.createSession(owner.id, S1, 'laptop');
idStore.createSession(owner.id, S2, 'phone');
const API = idStore.mintToken();
idStore.createApiToken(owner.id, API, 'laptop-cli');
const COOKIE = `homelab_session=${S1}`;
const COOKIE2 = `homelab_session=${S2}`;

async function call(path, { json, method, headers = {} } = {}) {
  const init = { method: method ?? (json === undefined ? 'GET' : 'POST'), headers: { ...headers } };
  if (json !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  const res = await fetch(BASE + path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}
const asPerson = (cookie = COOKIE, origin = WB) => ({ cookie, ...(origin ? { origin } : {}) });
const asBearer = () => ({ authorization: `Bearer ${TOKEN}` });

/* The mint rate is 10/person/minute and counts every attempt that gets past
   the credential and Origin checks; pace them so the matrix never trips it
   by accident (the rate case trips it on purpose, with `raw`). */
const mintTimes = [];
async function mint(body, headers = asPerson(), { raw = false } = {}) {
  while (!raw) {
    while (mintTimes.length && Date.now() - mintTimes[0] > 61_000) mintTimes.shift();
    if (mintTimes.length < 9) break;
    const wait = 61_500 - (Date.now() - mintTimes[0]);
    console.log(`  (pacing the mint rate: ${Math.round(wait / 1000)} s)`);
    await sleep(wait);
  }
  mintTimes.push(Date.now());
  return call('/api/terminal-grants', { json: body, headers });
}

/** A WS client. `path` /pty or /term; `headers` for the handshake. */
function client(path, headers) {
  const ws = new WebSocket(`ws://${HOST}:${PORT}${path}`, { headers });
  const log = [];
  const waiters = [];
  let closed = null;
  let refused = null;
  const opened = new Promise((resolve) => {
    ws.once('open', () => resolve(true));
    ws.once('unexpected-response', (_req, res) => {
      refused = res.statusCode;
      resolve(false);
    });
    ws.once('error', () => resolve(false));
  });
  const closedP = new Promise((resolve) => ws.once('close', (code, reason) => {
    closed = { code, reason: reason.toString() };
    resolve(closed);
  }));
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
    ws,
    log,
    open: () => opened,
    refused: () => refused,
    send: (cmd) => ws.send(typeof cmd === 'string' ? cmd : JSON.stringify(cmd)),
    wait: (pred, timeoutMs = 8000) =>
      new Promise((resolve) => {
        const hit = log.find(pred);
        if (hit) return resolve(hit);
        const t = setTimeout(() => resolve(null), timeoutMs);
        waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
      }),
    closed: (timeoutMs = 8000) => Promise.race([closedP, sleep(timeoutMs).then(() => closed)]),
    close: () => ws.close(),
  };
}
const termHeaders = (cookie = COOKIE, extra = {}) => ({ cookie, origin: WB, 'x-forwarded-proto': 'https', ...extra });
/** Open /term and present a grant; resolves once pane.ready (or the close) arrives. */
async function term(grant, headers = termHeaders()) {
  const c = client('/term', headers);
  if (!(await c.open())) return c;
  c.send({ type: 'grant', grant });
  await Promise.race([c.wait((m) => m.type === 'pane.ready', 8000), c.closed(8000)]);
  return c;
}

async function run() {
  for (const p of [PORT, BROKER_PORT]) {
    await assertFree(p, 'term-grants-engine.test.mjs');
  }
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  let log = '';
  let broker = null;
  let engine = null;
  const panes = [];
  const clients = [];
  const keep = (c) => (clients.push(c), c);
  const up = async (url) => {
    for (let i = 0; i < 120; i++) {
      if (await fetch(url).then((r) => r.ok).catch(() => false)) return true;
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
  const boot = async (grants) => {
    engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_PORT: String(PORT),
        HARBOR_WB_HOST: HOST,
        HARBOR_WB_TABLE: dbPath,
        HARBOR_WB_TOKEN: TOKEN,
        HARBOR_WB_IDENTITY: 'both',
        HARBOR_WB_IDENTITY_DB: identityDb,
        HARBOR_WB_PANE_TOKENS: '1',
        HARBOR_WB_TERM_GRANTS: grants ? '1' : undefined,
        HARBOR_WB_NO_WINDOW: '1',
        HARBOR_WB_DESKTOP: 'none',
        HARBOR_WB_BROKER_AUTOSTART: '0',
        HARBOR_WB_BROKER_PORT: String(BROKER_PORT),
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_NODE: 'testnode',
        HARBOR_WB_TARGETS: TARGETS,
      }),
    });
    engine.stdout.on('data', (d) => (log += d));
    engine.stderr.on('data', (d) => (log += d));
    if (!(await up(`${BASE}/health`))) throw new Error(`engine did not come up\n${log}`);
  };
  const grants = [];
  const grantOf = (r) => {
    if (r.body?.grant) grants.push(r.body.grant);
    return r.body?.grant;
  };
  try {
    broker = spawn(process.execPath, ['--import', loaderArg, 'node_modules/pty-broker/src/main.ts'], {
      cwd: REPO_ROOT,
      env: childEnv({ PTY_BROKER_PORT: String(BROKER_PORT) }),
    });
    broker.stdout.on('data', (d) => (log += d));
    broker.stderr.on('data', (d) => (log += d));
    if (!(await up(`http://${HOST}:${BROKER_PORT}/health`))) throw new Error(`broker did not come up\n${log}`);

    console.log('\n[setting off (the default)]');
    await boot(false);
    let r = await mint({ paneid: 'x', intent: 'view', room: 'r', seat: 's' });
    eq(r.status, 404, 'POST /api/terminal-grants is 404 while HARBOR_WB_TERM_GRANTS is unset');
    let t = client('/term', termHeaders());
    ok(!(await t.open()) && t.refused() === 404, `/term refuses the upgrade while off (${t.refused()})`);
    await kill(engine);

    console.log('\n[setting on: panes, a room, seats]');
    await boot(true);
    const pty = keep(client('/pty', asBearer()));
    ok(await pty.open(), '/pty still upgrades with /term on the router');
    const recipes = [];
    for (const [name, agent] of [['Term Agent', 'term-agent'], ['Term Bridge', 'term-bridge'], ['Term Other', 'term-other']]) {
      const recipe = (await call('/api/recipes', { json: { name, target: 'local', projectDir: tmpDir, vendor: 'cli-manager', agent }, headers: asBearer() })).body?.recipe;
      recipes.push(recipe);
      panes.push(`recipe:${recipe?.id}`);
    }
    const [A, B, C] = panes;
    for (let i = 0; i < 3; i++) {
      pty.send({ type: 'attach', paneid: panes[i], recipe: recipes[i].id, intent: 'view' });
      ok(!!(await pty.wait((m) => m.type === 'pane.ready' && m.paneid === panes[i], 12000)), `pane ${'ABC'[i]} spawns a real pty`);
    }
    const room = (await call('/api/rooms', { json: { name: 'Term Room' }, headers: asPerson() })).body;
    ok(!!room?.id, 'a room');
    r = await call(`/api/rooms/${room.id}/seats`, { json: { recipe_id: recipes[0].id, handle: 'agent', policy: 'persistent', occupant: A }, headers: asPerson() });
    eq(r.status, 200, 'seat @agent holds pane A (B, the "command bridge", holds no seat)');
    const seatA = r.body?.seat?.id;
    r = await call(`/api/rooms/${room.id}/seats`, { json: { recipe_id: recipes[2].id, handle: 'other', policy: 'persistent', occupant: C }, headers: asPerson() });
    const seatC = r.body?.seat?.id;
    ok(!!seatC, 'seat @other holds pane C');
    const view = { paneid: A, intent: 'view', room: room.id, seat: seatA };

    console.log('\n[mint: credential and Origin]');
    r = await mint(view, { ...asBearer(), origin: WB });
    eq([r.status, r.body?.field], [403, 'credential'], 'the shared bearer is refused');
    r = await mint(view, { authorization: `Bearer ${API}`, origin: WB });
    eq([r.status, r.body?.field], [403, 'credential'], 'an api token is refused');
    r = await mint(view, { ...asPerson(), authorization: `Bearer ${API}` });
    eq([r.status, r.body?.field], [403, 'credential'], 'a cookie WITH an Authorization header is refused');
    const tokenFile = readdirSync(join(tmpDir, 'mcp')).find((f) => f.startsWith(A.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60)) && f.endsWith('.token'));
    const paneToken = tokenFile ? readFileSync(join(tmpDir, 'mcp', tokenFile), 'utf8') : null;
    ok(!!paneToken, "pane A's own pane token is on disk");
    r = await mint(view, { authorization: `Bearer ${paneToken}`, origin: WB });
    eq(r.status, 403, `a pane token is refused (${r.body?.error ?? r.body?.code})`);
    r = await mint(view, asPerson(COOKIE, null));
    eq([r.status, r.body?.field], [403, 'origin'], 'a person with NO Origin is refused');
    r = await mint(view, asPerson(COOKIE, 'https://evil.example'));
    eq([r.status, r.body?.field], [403, 'origin'], 'a person with a foreign Origin is refused');

    console.log('\n[mint: body and entitlement]');
    r = await mint({ ...view, intent: 'drive' });
    eq([r.status, r.body?.field], [400, 'intent'], 'a bad intent is 400');
    r = await mint({ intent: 'view', room: room.id, seat: seatA });
    eq([r.status, r.body?.field], [400, 'paneid'], 'a missing paneid is 400');
    r = await mint({ ...view, paneid: B });
    eq([r.status, r.body?.field], [403, 'paneid'], 'an unseated pane (B) is refused, even named with a real seat');
    r = await mint({ ...view, room: 'no-such-room' });
    eq([r.status, r.body?.field], [404, 'room'], 'an unknown room is 404');

    console.log('\n[mint: allowed]');
    r = await mint(view);
    eq(r.status, 200, 'app://workbench passes with the default allow-list');
    eq([r.body?.expires_in, r.body?.socket, r.body?.paneid, r.body?.intent], [30, '/term', A, 'view'], 'the answer: {grant, expires_in 30, socket /term, paneid, intent}');
    ok(/^[A-Za-z0-9_-]{43}$/.test(grantOf(r) ?? ''), 'the grant is 32 bytes base64url');
    const ownOrigin = await mint(view, asPerson(COOKIE, BASE));
    eq(ownOrigin.status, 200, "the engine's own origin passes (its own pages)");
    grantOf(ownOrigin);

    console.log('\n[the /term upgrade]');
    const tryUp = async (headers, want, msg) => {
      const c = client('/term', headers);
      const opened = await c.open();
      ok(!opened && c.refused() === want, `${msg} (${opened ? 'opened' : c.refused()})`);
    };
    await tryUp({ origin: WB, 'x-forwarded-proto': 'https' }, 401, 'no cookie: refused');
    await tryUp({ ...termHeaders(), authorization: `Bearer ${TOKEN}` }, 401, 'a bearer beside the cookie: refused');
    await tryUp({ authorization: `Bearer ${paneToken}`, origin: WB, 'x-forwarded-proto': 'https' }, 401, 'a pane token: refused');
    await tryUp({ cookie: COOKIE, 'x-forwarded-proto': 'https' }, 403, 'no Origin: refused');
    await tryUp(termHeaders(COOKIE, { origin: 'https://evil.example' }), 403, 'a foreign Origin: refused');
    await tryUp({ cookie: COOKIE, origin: WB }, 403, 'plain ws (no x-forwarded-proto: https): refused');

    console.log('\n[redeem]');
    t = keep(client('/term', termHeaders()));
    ok(await t.open(), 'a person opens /term');
    let closed = await t.closed(7000);
    eq(closed?.code, 4401, 'no grant frame within 5 s: 4401');
    t = keep(client('/term', termHeaders()));
    await t.open();
    t.send({ type: 'input', paneid: A, data: 'x' });
    eq((await t.closed())?.code, 4401, 'a first frame that is not a grant: 4401');
    t = keep(await term('not-a-grant'));
    eq((await t.closed())?.code, 4401, 'an unknown grant: 4401');

    let g = grantOf(await mint(view));
    t = keep(await term(g, termHeaders(COOKIE2)));
    eq((await t.closed())?.code, 4403, 'the same person under ANOTHER sign-in: 4403');
    ok(/term-grant refused person=\S+ pane=\S+ room=\S+ seat=agent intent=view reason=wrong-person/.test(log), '...and it is logged');
    t = keep(await term(g));
    eq((await t.closed())?.code, 4401, '...and the grant is gone (deleted on that redemption): 4401');

    g = grantOf(await mint(view));
    const pair = [keep(client('/term', termHeaders())), keep(client('/term', termHeaders()))];
    await Promise.all(pair.map((c) => c.open()));
    pair.forEach((c) => c.send({ type: 'grant', grant: g }));
    await sleep(1500);
    const outcomes = pair.map((c) => (c.log.some((m) => m.type === 'pane.ready') ? 'ready' : c.ws.readyState === WebSocket.OPEN ? 'open' : 'closed'));
    eq(outcomes.sort(), ['closed', 'ready'], 'concurrent redeem of one grant: exactly one wins');
    const winner = pair.find((c) => c.log.some((m) => m.type === 'pane.ready'));
    const loser = pair.find((c) => c !== winner);
    eq(loser?.log.length === 0 ? (await loser.closed())?.code : 'got events', 4401, 'the loser closes 4401 and saw nothing');
    t = keep(await term(g));
    eq((await t.closed())?.code, 4401, 'reusing a redeemed grant: 4401');

    console.log('\n[a view socket]');
    const v = winner;
    const ready = v.log.find((m) => m.type === 'pane.ready');
    eq([ready?.paneid, ready?.reattached], [A, true], 'pane.ready for the bound pane (a reattach)');
    ok(v.log.some((m) => m.type === 'pane.data' && m.paneid === A), 'the replay arrives as pane.data');
    ok(!!(await v.wait((m) => m.type === 'pane.control' && m.controlling === false)), 'pane.control: not controlling');
    ok(v.log.every((m) => m.paneid === A || m.type === 'pong'), 'only the bound pane\'s events reach it');
    v.send({ type: 'ping' });
    ok(!!(await v.wait((m) => m.type === 'pong')), 'ping -> pong');
    const MARK = `secretmark${Date.now()}`;
    v.send({ type: 'input', paneid: A, data: `echo ${MARK}\r` });
    ok(!!(await v.wait((m) => m.type === 'pane.control-denied' && m.command === 'input')), 'input on a view socket is refused (pane.control-denied)');
    await sleep(500);
    ok(/reason=input-without-control/.test(log), '...and logged');
    ok(!v.log.some((m) => m.type === 'pane.data' && String(m.data).includes(MARK)), '...and never reached the pty');

    console.log('\n[take control, type, release]');
    v.send({ type: 'takeControl', paneid: A, label: 'ignored' });
    ok(!!(await v.wait((m) => m.type === 'pane.control' && m.controlling === true)), 'takeControl: pane.control controlling');
    const facts = async () => ((await call(`/api/rooms/${room.id}/line`, { headers: asPerson() })).body?.entries ?? []).filter((e) => e.kind === 'fact').map((e) => e.body);
    await sleep(300);
    ok((await facts()).includes("owner took control of @agent's terminal."), 'a room fact line: "owner took control of @agent\'s terminal." (a full stop, like the stop line)');
    ok(/term-grant control-taken person=\S+ pane=\S+ .*seat=agent/.test(log), '...and the control-taken log line');
    v.send({ type: 'input', paneid: A, data: `echo ${MARK}\r` });
    ok(!!(await v.wait((m) => m.type === 'pane.data' && String(m.data).includes(MARK))), 'input now reaches the pty');
    const mark = v.log.length;
    v.send({ type: 'releaseControl', paneid: A });
    await sleep(500);
    ok(v.log.slice(mark).some((m) => m.type === 'pane.control' && m.controlling === false) && v.ws.readyState === WebSocket.OPEN, 'releaseControl: not controlling, socket still open');
    await sleep(300);
    ok((await facts()).includes("owner stopped controlling @agent's terminal."), 'a room fact line: "owner stopped controlling @agent\'s terminal."');
    const n0 = v.log.filter((m) => m.type === 'pane.control-denied').length;
    v.send({ type: 'input', paneid: A, data: 'x' });
    await sleep(500);
    eq(v.log.filter((m) => m.type === 'pane.control-denied').length, n0 + 1, 'after release, input is refused again');
    v.send({ type: 'releaseControl', paneid: A });
    await sleep(300);
    eq((await facts()).filter((f) => f.includes('stopped controlling')).length, 1, 'a release without the lease is ignored (no second line)');
    ok(v.ws.readyState === WebSocket.OPEN, '...and does not close the socket');

    console.log('\n[intent control = reclaim]');
    const c1 = keep(await term(grantOf(await mint({ ...view, intent: 'control' }))));
    ok(!!(await c1.wait((m) => m.type === 'pane.control' && m.controlling === true)), 'a control grant takes the free lease (its last driver was this person)');
    r = await mint({ ...view, intent: 'control' });
    eq([r.status, r.body?.field], [429, 'paneid'], 'a second control grant while a /term socket holds the lease: 429');
    v.send({ type: 'takeControl', paneid: A });
    ok(!!(await v.wait((m) => m.type === 'pane.control-denied' && m.command === 'takeControl')), 'a second /term socket cannot take it either (one control socket per pane)');

    console.log('\n[frames that close the socket]');
    c1.send({ type: 'input', paneid: B, data: 'x' });
    eq((await c1.closed())?.code, 4400, 'a frame naming another pane: 4400');
    const v2 = keep(await term(grantOf(await mint(view))));
    v2.send({ type: 'kill', paneid: A });
    eq((await v2.closed())?.code, 4400, 'a kill frame: 4400');
    ok(/reason=frame-kill/.test(log), '...logged');
    const v3 = keep(await term(grantOf(await mint(view))));
    v3.send({ type: 'room.subscribe', rooms: [room.id] });
    eq((await v3.closed())?.code, 4400, 'room.subscribe: 4400');
    const v4 = keep(await term(grantOf(await mint(view))));
    v4.send(JSON.stringify({ type: 'input', paneid: A, data: 'y'.repeat(70 * 1024) }));
    eq((await v4.closed())?.code, 4429, 'a frame over 64 KB: 4429');
    const v5 = keep(await term(grantOf(await mint(view))));
    v5.send({ type: 'takeControl', paneid: A });
    await v5.wait((m) => m.type === 'pane.control' && m.controlling === true);
    for (let i = 0; i < 60; i++) v5.send({ type: 'input', paneid: A, data: '' });
    eq((await v5.closed())?.code, 4429, 'more than 50 input frames in a second: 4429');
    ok(pty.ws.readyState === WebSocket.OPEN && engine.exitCode === null, 'the engine and /pty are unharmed');

    console.log('\n[four sockets per person]');
    const four = [v];
    for (let i = 0; i < 3; i++) four.push(keep(await term(grantOf(await mint(view)))));
    ok(four.every((c) => c.ws.readyState === WebSocket.OPEN), 'four /term sockets open');
    r = await mint(view);
    eq([r.status, r.body?.field], [429, 'sockets'], 'a fifth grant: 429');
    for (const c of four.slice(1)) c.close();
    await sleep(300);

    console.log('\n[the seat changes under an open socket]');
    const oc = keep(await term(grantOf(await mint({ paneid: C, intent: 'view', room: room.id, seat: seatC }))));
    ok(oc.log.some((m) => m.type === 'pane.ready' && m.paneid === C), 'a socket on @other (pane C)');
    r = await call(`/api/rooms/${room.id}/seats/${seatC}`, { method: 'DELETE', json: {}, headers: asPerson() });
    eq(r.status, 200, 'the seat is removed');
    eq((await oc.closed())?.code, 4403, 'the socket closes 4403 (seat changed)');
    ok(/term-grant closed person=\S+ pane=\S+ .*reason=seat-changed bytes_in=0/.test(log), '...logged with bytes_in');

    console.log('\n[the pane exits]');
    const xc = keep(await term(grantOf(await mint(view))));
    ok(xc.log.some((m) => m.type === 'pane.ready'), 'a socket on @agent');
    pty.send({ type: 'takeControl', paneid: A });
    await pty.wait((m) => m.type === 'pane.control' && m.paneid === A && m.controlling === true);
    pty.send({ type: 'kill', paneid: A });
    ok(!!(await xc.wait((m) => m.type === 'pane.exit')), 'pane.exit reaches it');
    eq((await xc.closed())?.code, 1000, '...then it closes');
    r = await mint(view);
    eq([r.status, r.body?.field], [409, 'paneid'], 'a grant for the ended pane: 409');

    console.log('\n[the mint rate]');
    await sleep(61_000);
    let last = null;
    for (let i = 0; i < 11; i++) last = await mint({ ...view, paneid: B }, asPerson(), { raw: true });
    eq([last.status, last.body?.field], [429, 'rate'], 'the 11th grant attempt in a minute: 429');

    console.log('\n[a client-chosen frame type never reaches the log raw; a second account closes what is open]');
    for (const c of clients) c.close(); // earlier sockets must not count against the 4-per-person cap
    await sleep(61_500); // out of the rate window the previous section filled on purpose
    r = await call(`/api/rooms/${room.id}/seats`, { json: { recipe_id: recipes[1].id, handle: 'bee', policy: 'persistent', occupant: B }, headers: asPerson() });
    const seatB = r.body?.seat?.id;
    ok(!!seatB, 'seat @bee holds pane B');
    const viewB = { paneid: B, intent: 'view', room: room.id, seat: seatB };
    const inj = keep(await term(grantOf(await mint(viewB))));
    ok(inj.log.some((m) => m.type === 'pane.ready'), 'a socket on @bee');
    inj.send({ type: 'evil' + String.fromCharCode(10) + 'INJECTED line', paneid: B });
    eq((await inj.closed())?.code, 4400, 'a frame type with a newline: 4400');
    ok(!log.includes(String.fromCharCode(10) + 'INJECTED'), '...and its newline never reaches the engine log (no forged log line)');
    const injLines = log.split(String.fromCharCode(10)).filter((l) => l.includes('INJECTED'));
    ok(injLines.length > 0 && injLines.every((l) => l.includes('evil?INJECTED?line')), `...and every line carrying it is the sanitised form (${injLines.length})`);
    ok(/reason=frame-evil\?INJECTED\?line/.test(log), '...the log carries the sanitised type');
    const open = keep(await term(grantOf(await mint(viewB))));
    ok(open.log.some((m) => m.type === 'pane.ready'), 'a socket open before the second account');
    const unredeemed = grantOf(await mint(viewB));
    idStore.createAccount({ username: 'guest', passwordHash: 'unused', mustChange: false, passwordExpiresAt: null, isAdmin: false });
    const late = await term(unredeemed);
    const lateClose = await late.closed();
    eq([lateClose?.code, lateClose?.reason], [4403, 'accounts'], 'a grant minted before the second account: refused at redeem, 4403 accounts');
    const openClose = await open.closed(40_000);
    eq([openClose?.code, openClose?.reason], [4403, 'accounts'], 'the socket already open: closed on the next tick, 4403 accounts');
    r = await mint(viewB, asPerson(), { raw: true });
    eq([r.status, r.body?.field], [403, 'accounts'], 'more than one person account: 403 accounts');

    console.log('\n[logs]');
    ok(grants.length > 5 && grants.every((gr) => !log.includes(gr)), `no grant value appears in the engine log (${grants.length} checked)`);
    ok(!log.includes(MARK), 'no input content appears in the engine log');
    ok(/term-grant minted person=\S+ pane=\S+ room=[0-9a-f-]{1,8} seat=agent intent=view/.test(log), 'mint lines name person, pane, room id8, seat and intent');
    ok(/term-grant redeemed person=/.test(log), 'redeem lines');
  } catch (e) {
    failed++;
    failures.push(`threw: ${e?.stack ?? e}`);
    console.log(`  X threw: ${e?.stack ?? e}`);
    console.log(`--- log tail ---\n${log.slice(-3000)}`);
  } finally {
    for (const c of clients) c.close();
    const k = client('/pty', asBearer());
    if (await k.open()) {
      for (const pane of panes) k.send({ type: 'kill', paneid: pane });
      await sleep(500);
    }
    k.close();
    await kill(engine);
    await kill(broker);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* the killed engine can still hold the dir */ }
  }
  console.log(`\nPASS ${passed} FAIL ${failed}`);
  if (failed) {
    console.log(failures.map((f) => ` - ${f}`).join('\n'));
    process.exit(1);
  }
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
