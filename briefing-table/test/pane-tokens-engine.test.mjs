/**
 * PANE TOKENS, S1, through a real engine and a real pty-broker
 * (the design notes §7 "Engine suite"):
 *   - flag OFF (the default): nothing is minted, the pane has no token
 *     variable, and a token string is just an unknown bearer — unchanged;
 *   - flag ON: a spawn mints a token delivered as a FILE whose path is in the
 *     pane's env (never the token itself);
 *   - pane A cannot read, post to or roster room B, and GET /api/rooms is
 *     filtered; a missing room and an unseated room answer the same bytes;
 *   - A's token on /api/table, /launch, /pty and /account is 403 under ALL
 *     THREE identity modes; /identity/introspect answers it as a pane;
 *   - a relaunch with the same paneid gets a new generation and the old
 *     token is refused;
 *   - after an engine restart the adopted pane's token still works;
 *   - the fabric send door forces `from` and refuses a `room:*` ref and a
 *     non-string thread; introspect does not check origin (review P1-B).
 * A bash recipe (vendor cli-manager WITH a slug — seatable, not a plain
 * shell) is used on purpose: a claude-code recipe would launch the REAL
 * claude on this host.
 *
 * SAFETY: scratch engine + scratch broker on P() ports, temp table and temp
 * identity db, childEnv(); NATS and the fabric pinned to ''. Never
 * :7420/:7430/:8200/:8201/:8204. The temp dir is removed.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { P, assertFree, childEnv, scratchShell, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(120);
const BROKER_PORT = P(121);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'pane-tokens-engine-test-token';
const TARGETS = JSON.stringify({ targets: [{ id: 'local', label: 'Local', kind: 'local', shell: scratchShell() }] });
const WIN = process.platform === 'win32';

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
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)})`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One HTTP call. `auth`: a bearer string, or {cookie}. */
async function call(path, { method, json, auth = TOKEN, headers = {} } = {}) {
  const h = { ...headers };
  if (typeof auth === 'string') {
    h.authorization = `Bearer ${auth}`;
  } else if (auth?.cookie) {
    h.cookie = auth.cookie;
  }
  const init = { method: method ?? (json === undefined ? 'GET' : 'POST'), headers: h };
  if (json !== undefined) {
    h['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  const res = await fetch(BASE + path, init);
  const raw = await res.text();
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    /* not json */
  }
  return { status: res.status, body, raw };
}

/** The status a /pty upgrade answers with this bearer (101 = opened). */
function wsStatus(bearer) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${HOST}:${PORT}/pty`, { headers: { authorization: `Bearer ${bearer}` } });
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode);
      res.resume();
    });
    ws.on('error', () => resolve(0));
  });
}

function client() {
  const ws = new WebSocket(`ws://${HOST}:${PORT}/pty`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const log = [];
  const waiters = [];
  let data = '';
  ws.on('error', () => {});
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    log.push(msg);
    if (msg.type === 'pane.data') {
      data += msg.data;
    }
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        waiters.splice(i, 1)[0].resolve(msg);
      }
    }
  });
  return {
    open: () =>
      new Promise((resolve) => {
        ws.once('open', () => resolve(true));
        ws.once('error', () => resolve(false));
      }),
    send: (cmd) => ws.send(JSON.stringify(cmd)),
    data: () => data,
    wait: (pred, timeoutMs = 8000) =>
      new Promise((resolve) => {
        const hit = log.find(pred);
        if (hit) {
          return resolve(hit);
        }
        const t = setTimeout(() => resolve(null), timeoutMs);
        waiters.push({
          pred,
          resolve: (m) => {
            clearTimeout(t);
            resolve(m);
          },
        });
      }),
    close: () => ws.close(),
  };
}

async function run() {
  for (const p of [PORT, BROKER_PORT]) {
    await assertFree(p, 'pane-tokens-engine.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-pane-tokens-engine-'));
  const mcpDir = join(tmpDir, 'mcp');
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  let log = '';
  let broker = null;
  let engine = null;
  const up = async (url) => {
    for (let i = 0; i < 120; i++) {
      if (await fetch(url).then((r) => r.ok).catch(() => false)) {
        return true;
      }
      await sleep(250);
    }
    return false;
  };
  const bootEngine = async (extraEnv) => {
    const extra = {
      HARBOR_WB_PORT: String(PORT),
      HARBOR_WB_HOST: HOST,
      HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'),
      HARBOR_WB_IDENTITY_DB: join(tmpDir, 'identity.db'),
      HARBOR_WB_TOKEN: TOKEN,
      HARBOR_WB_IDENTITY: 'legacy',
      HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_NATS_URL: '',
      HARBOR_WB_FABRIC_URL: '',
      HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(BROKER_PORT),
      HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
      HARBOR_WB_NODE: 'testnode',
      HARBOR_WB_TARGETS: TARGETS,
      ...extraEnv,
    };
    const e = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], { cwd: REPO_ROOT, env: childEnv(extra) });
    e.stdout.on('data', (d) => (log += d));
    e.stderr.on('data', (d) => (log += d));
    if (!(await up(`${BASE}/health`))) {
      throw new Error(`engine did not come up\n${log}`);
    }
    return e;
  };
  const kill = async (proc, signal = 'SIGTERM') => {
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      const gone = new Promise((r) => proc.once('exit', r));
      proc.kill(signal);
      await Promise.race([gone, sleep(3000)]);
    }
  };
  const tokenFiles = () => {
    try {
      return readdirSync(mcpDir).filter((f) => f.endsWith('.token'));
    } catch {
      return [];
    }
  };
  const tokenOf = (paneid) => {
    const base = paneid.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60);
    const f = tokenFiles().find((x) => x.startsWith(`${base}-`));
    return f ? readFileSync(join(mcpDir, f), 'utf8') : null;
  };
  const rowOf = async (paneid) => {
    const b = (await call('/api/table')).body;
    const rows = Array.isArray(b) ? b : (b?.rows ?? b?.sessions ?? []);
    return rows.find((r) => r.paneid === paneid);
  };
  /** Open the pane (spawn or reattach) and print what its env says. */
  const envProbe = async (paneid, recipeId) => {
    const c = client();
    await c.open();
    c.send({ type: 'attach', paneid, recipe: recipeId, intent: 'reclaim' });
    const ready = await c.wait((m) => m.type === 'pane.ready' && m.paneid === paneid, 12000);
    await c.wait((m) => m.type === 'pane.control' && m.paneid === paneid && m.controlling === true, 4000);
    const cmd = WIN
      ? 'echo "F=$env:HARBOR_WB_PANE_TOKEN_FILE T=[$env:HARBOR_WB_PANE_TOKEN]"'
      : 'echo "F=$HARBOR_WB_PANE_TOKEN_FILE T=[${HARBOR_WB_PANE_TOKEN}]"';
    await sleep(400);
    c.send({ type: 'input', paneid, data: `${cmd}\r` });
    let m = null;
    for (let i = 0; i < 40 && !m; i++) {
      await sleep(150);
      m = /F=(\S*) T=\[([^\]]*)\]/.exec(c.data().split(cmd).join(''));
    }
    c.close();
    return { ready: !!ready, file: m?.[1] ?? null, env: m?.[2] ?? null };
  };
  const end = async (paneid) => {
    const c = client();
    await c.open();
    c.send({ type: 'attach', paneid, intent: 'reclaim' });
    await c.wait((m) => m.type === 'pane.control' && m.paneid === paneid && m.controlling === true, 4000);
    c.send({ type: 'kill', paneid });
    const exit = await c.wait((m) => m.type === 'pane.exit' && m.paneid === paneid, 8000);
    c.close();
    return !!exit;
  };
  const relaunch = async (recipeId) => {
    const r = await call(`/api/recipes/${encodeURIComponent(recipeId)}/launch`, { json: {} });
    return r.body?.paneid ?? null;
  };
  /** The four doors a pane token must never open, whatever the mode. */
  const humanDoors = async (tok, mode) => {
    const t = await call('/api/table', { auth: tok });
    eq(t.status, 403, `[${mode}] /api/table on A's token: 403`);
    eq(t.body?.error, 'not_for_pane_token', `[${mode}] ...not_for_pane_token`);
    eq((await call(`/api/recipes/${encodeURIComponent(recA)}/launch`, { auth: tok, json: {} })).status, 403, `[${mode}] POST /api/recipes/:id/launch: 403`);
    eq((await call('/account', { auth: tok })).status, 403, `[${mode}] /account: 403`);
    eq((await call('/account/tokens', { auth: tok })).status, 403, `[${mode}] /account/tokens: 403`);
    eq(await wsStatus(tok), 403, `[${mode}] /pty upgrade: 403`);
    eq((await call('/api/diag/rooms', { auth: tok })).status, 403, `[${mode}] /api/diag/rooms: 403`);
  };

  let recA = null;
  const panes = [];
  try {
    broker = spawn(process.execPath, ['--import', loaderArg, 'node_modules/pty-broker/src/main.ts'], {
      cwd: REPO_ROOT,
      env: childEnv({ PTY_BROKER_PORT: String(BROKER_PORT) }),
    });
    broker.stdout.on('data', (d) => (log += d));
    broker.stderr.on('data', (d) => (log += d));
    if (!(await up(`http://${HOST}:${BROKER_PORT}/health`))) {
      throw new Error(`broker did not come up\n${log}`);
    }
    console.log(`scratch engine :${PORT}, scratch broker :${BROKER_PORT}`);

    console.log('\n[flag OFF (default): nothing minted, nothing changes]');
    engine = await bootEngine({});
    const mk = async (name) => {
      const dirp = join(tmpDir, name);
      mkdirSync(dirp, { recursive: true });
      return (await call('/api/recipes', { json: { name, target: 'local', projectDir: dirp, vendor: 'cli-manager', agent: `${name}-bot` } })).body?.recipe;
    };
    const A = await mk('alpha');
    const B = await mk('beta');
    recA = A?.id;
    ok(!!A?.id && !!B?.id && !!A.agent, `two bash recipes, with slugs (${A?.agent}, ${B?.agent})`);
    const paneA = `recipe:${A.id}`;
    const paneB = `recipe:${B.id}`;
    panes.push(paneA, paneB);
    const offA = await envProbe(paneA, A.id);
    ok(offA.ready, 'pane A spawns');
    eq(offA.file, '', 'no HARBOR_WB_PANE_TOKEN_FILE in the pane');
    eq(offA.env, '', 'no HARBOR_WB_PANE_TOKEN in the pane');
    ok((await envProbe(paneB, B.id)).ready, 'pane B spawns');
    eq(tokenFiles().length, 0, 'no token file written');
    const cookie = await windowCookie(BASE, TOKEN);
    const roomA = (await call('/api/rooms', { auth: { cookie }, json: { name: 'Room A' } })).body;
    const roomB = (await call('/api/rooms', { auth: { cookie }, json: { name: 'Room B' } })).body;
    const sA = await call(`/api/rooms/${roomA.id}/seats`, { auth: { cookie }, json: { recipe_id: A.id, occupant: paneA } });
    const sB = await call(`/api/rooms/${roomB.id}/seats`, { auth: { cookie }, json: { recipe_id: B.id, occupant: paneB } });
    ok(sA.status === 200 && sB.status === 200, 'room A seats pane A, room B seats pane B (the user, from a window)');
    eq((await rowOf(paneA))?.generation, 1, 'the spawn wrote generation 1 (the column moves with the flag off too)');
    eq((await call('/api/rooms', { auth: 'x'.repeat(43) })).status, 401, 'a token-shaped string is just an unknown bearer: 401');

    console.log('\n[flag ON, legacy: restart adopts the panes; a relaunch mints]');
    await kill(engine, 'SIGKILL');
    const ON = { HARBOR_WB_PANE_TOKENS: '1' };
    engine = await bootEngine(ON);
    eq(tokenFiles().length, 0, 'an adopted pane spawned before the flag has no token (nothing is minted on adoption)');
    ok(await end(paneA), 'pane A ended');
    eq(await relaunch(A.id), paneA, 'relaunch A: the same paneid');
    const onA = await envProbe(paneA, A.id);
    ok(onA.ready, 'pane A spawns again');
    ok(!!onA.file && onA.file.endsWith('.token') && onA.file.startsWith(mcpDir), `the pane's env names its token FILE (${onA.file})`);
    eq(onA.env, '', 'and holds no HARBOR_WB_PANE_TOKEN itself');
    const tok1 = tokenOf(paneA);
    ok(!!tok1 && tok1.length === 43, 'a 43-char token in the file');
    ok(!onA.file?.includes(tok1 ?? '@@'), 'the path does not carry the token');
    eq((await rowOf(paneA))?.generation, 2, 'generation 2');

    console.log('\n[scope: pane A cannot reach room B]');
    const list = await call('/api/rooms', { auth: tok1 });
    eq(list.status, 200, 'GET /api/rooms on the token: 200');
    eq(JSON.stringify((list.body ?? []).map((r) => r.room?.id)), JSON.stringify([roomA.id]), '...filtered to room A');
    eq((await call('/api/rooms')).body?.length, 2, 'the shared bearer still lists both (unchanged)');
    eq((await call(`/api/panes/${encodeURIComponent(paneA)}/sign-in-link`, { auth: tok1 })).status, 403, 'a REAL minted pane token cannot read a sign-in link (person-only): 403');
    const nsB = await call(`/api/rooms/${roomB.id}`, { auth: tok1 });
    const nsX = await call('/api/rooms/does-not-exist', { auth: tok1 });
    eq(nsB.status, 403, 'roster room B: 403');
    eq(nsB.body?.error, 'not_seated', '...not_seated');
    ok(nsX.status === nsB.status && nsX.raw === nsB.raw, 'a room that does not exist: byte-identical');
    eq((await call(`/api/rooms/${roomB.id}/line`, { auth: tok1 })).raw, nsB.raw, 'read room B: the same not_seated');
    eq((await call(`/api/rooms/${roomB.id}/line`, { auth: tok1, json: { text: 'hi B' } })).raw, nsB.raw, 'post to room B: the same not_seated');
    const mine = await call(`/api/rooms/${roomA.id}/line`, { auth: tok1, json: { text: 'hello from A' } });
    eq(mine.status, 200, 'post to room A: 200');
    eq(mine.body?.entries?.[0]?.author, sA.body?.seat?.handle, '...as its seat');
    const meHandle = (await call('/api/rooms/me', { auth: { cookie } })).body?.handle;
    const toUser = await call(`/api/rooms/${roomA.id}/line`, { auth: tok1, json: { text: '@user the build is green' } });
    const tu = toUser.body?.entries?.[0];
    ok(
      toUser.status === 200 && !!meHandle && tu?.target === meHandle && tu?.target_seat === null && JSON.parse(tu?.meta ?? '{}').to_user === true,
      `a pane-token "@user ...": to the user (target @${tu?.target} = the handle @${meHandle}, no seat, meta ${tu?.meta})`,
    );
    eq((await call(`/api/rooms/${roomA.id}/line`, { auth: tok1, json: { text: 'as B', from: { paneid: paneB } } })).body?.error, 'from_mismatch', 'a body from naming pane B: from_mismatch');
    const add = await call(`/api/rooms/${roomA.id}/line`, { auth: tok1, json: { text: `/add ${B.agent}` } });
    ok(String(add.body?.refused?.error ?? '').startsWith('human_only'), `the lead's /add on its token: human_only (got ${add.body?.refused?.error})`);
    eq((await call(`/api/rooms/${roomA.id}`, { auth: tok1 })).status, 200, 'roster room A: 200');
    eq((await call(`/api/rooms/${roomA.id}`, { auth: tok1, headers: { 'x-forwarded-for': '100.64.0.9' } })).body?.error, 'origin_mismatch', 'a local token through Serve (x-forwarded-for): 401 origin_mismatch');

    console.log('\n[introspect and the fabric door]');
    const intro = await call('/identity/introspect', { auth: tok1 });
    eq(intro.status, 200, 'introspect: 200');
    eq(intro.body?.principal?.kind, 'pane', 'kind pane');
    eq(intro.body?.principal?.paneid, paneA, 'its paneid');
    eq(JSON.stringify(intro.body?.principal?.projects), JSON.stringify([A.agent]), "projects: [the pane's project]");
    ok(typeof intro.body?.principal?.user === 'string', 'a user');
    /* P1-B: the fabric presents the token itself; origin is not checked here. */
    const introFwd = await call('/identity/introspect', { auth: tok1, headers: { 'x-forwarded-for': '100.64.0.9' } });
    eq(introFwd.status, 200, 'introspect with a mismatched origin (x-forwarded-for on a local token): 200 — the caller is the fabric, not the pane');
    eq((await call(`/api/rooms/${roomA.id}`, { auth: tok1, headers: { 'x-forwarded-for': '100.64.0.9' } })).body?.error, 'origin_mismatch', '...while every other route still checks origin');
    const numThread = await call('/api/fabric/send', { auth: tok1, json: { to: 'x', kind: 'notice', body: 'hi', thread: 7 } });
    eq(numThread.status, 400, 'P2-1: fabric send with a numeric thread: 400');
    eq(numThread.body?.error, 'thread_invalid', '...thread_invalid');
    eq((await call('/api/fabric/send', { auth: tok1, json: { to: 'x', kind: 'notice', body: 'hi', from: { paneid: paneB } } })).body?.error, 'from_mismatch', 'fabric send naming pane B: from_mismatch');
    eq((await call('/api/fabric/send', { auth: tok1, json: { to: 'x', kind: 'notice', body: 'hi', ref: `room:${roomB.id}/line:1` } })).body?.error, 'room_ref_refused', 'fabric send with ref room:*: room_ref_refused');
    const clean = await call('/api/fabric/send', { auth: tok1, json: { to: 'x', kind: 'notice', body: 'hi' } });
    eq(clean.status, 503, 'a clean send passes the door and meets the (disabled) fabric: 503');
    await humanDoors(tok1, 'legacy');

    console.log('\n[project channel on a pane token (the design notes)]');
    const act = await call(`/api/projects/${A.agent}/activity`, { auth: tok1 });
    eq(act.status, 200, 'GET activity on the token: 200');
    ok((act.body?.live ?? []).some((s) => s.paneid === paneA), '...lists pane A as live');
    const pl = await call(`/api/projects/${A.agent}/lock`, { auth: tok1, json: { note: 'on my token', ttl_sec: 60 } });
    eq(pl.body?.lock?.holder?.paneid, paneA, 'lock with no from: the holder is the token\'s own pane');
    eq((await call(`/api/projects/${A.agent}/lock`, { auth: tok1, json: { from: { paneid: paneB } } })).status, 403, 'lock naming pane B on A\'s token: 403');
    eq((await call(`/api/projects/${A.agent}/lock`, { auth: tok1, method: 'DELETE', json: {} })).status, 200, 'the token releases its own lock');

    console.log('\n[relaunch: a new generation, the old token refused]');
    ok(await end(paneA), 'pane A ended');
    eq((await call('/api/rooms', { auth: tok1 })).body?.error, 'token_revoked', 'the ended pane\'s token: token_revoked');
    eq(tokenOf(paneA), null, 'and its file is gone');
    eq(await relaunch(A.id), paneA, 'relaunch A: the same paneid');
    ok((await envProbe(paneA, A.id)).ready, 'pane A spawns again');
    const tok2 = tokenOf(paneA);
    ok(!!tok2 && tok2 !== tok1, 'a new token');
    eq((await rowOf(paneA))?.generation, 3, 'generation 3');
    eq((await call('/api/rooms', { auth: tok1 })).status, 401, 'the old token: 401');
    eq((await call('/api/rooms', { auth: tok2 })).status, 200, 'the new one: 200');

    for (const mode of ['both', 'strict']) {
      console.log(`\n[restart, identity ${mode}: the adopted pane's token still works; the doors stay shut]`);
      await kill(engine, 'SIGKILL');
      engine = await bootEngine({ ...ON, HARBOR_WB_IDENTITY: mode });
      if (mode === 'both') {
        eq((await rowOf(paneA))?.generation, 3, `[${mode}] still generation 3 (adoption does not bump)`);
      }
      const again = await call('/api/rooms', { auth: tok2 });
      eq(again.status, 200, `[${mode}] the adopted pane's token: 200`);
      eq(JSON.stringify((again.body ?? []).map((r) => r.room?.id)), JSON.stringify([roomA.id]), `[${mode}] ...still filtered`);
      eq((await call('/identity/introspect', { auth: tok2 })).body?.principal?.kind, 'pane', `[${mode}] introspect: kind pane`);
      await humanDoors(tok2, mode);
    }
    console.log('\n[account split (HARBOR_WB_PANE_TOKEN_DELIVERY=env): the env token works over loopback, not through a proxy]');
    await kill(engine, 'SIGKILL');
    engine = await bootEngine({ ...ON, HARBOR_WB_PANE_TOKEN_DELIVERY: 'env' });
    ok(await end(paneA), 'pane A ended');
    eq(await relaunch(A.id), paneA, 'relaunch A under env delivery');
    const sp = await envProbe(paneA, A.id);
    ok(sp.ready && sp.env && sp.env.length === 43 && !sp.file, 'the pane env holds the token and names no token file');
    eq(tokenOf(paneA), null, 'and no token file exists');
    eq((await call('/api/rooms', { auth: sp.env })).status, 200, 'the env token over plain loopback: GET /api/rooms 200');
    eq((await call('/api/rooms', { auth: sp.env, headers: { 'x-forwarded-for': '100.1.2.3' } })).status, 401, 'the same token arriving WITH x-forwarded-for (through the proxy): 401');
    eq((await call('/api/rooms', { auth: sp.env.slice(0, -1) + (sp.env.endsWith('A') ? 'B' : 'A') })).status, 401, 'a wrong token: 401');
    ok(!log.includes(tok1) && !log.includes(tok2) && !log.includes(sp.env), 'no token ever reached the engine or broker log');
  } catch (e) {
    failed++;
    failures.push(`threw: ${e?.stack ?? e}`);
    console.log(`  ✗ threw: ${e?.stack ?? e}`);
    console.log(`--- engine/broker log tail ---\n${log.slice(-3000)}`);
  } finally {
    await kill(engine, 'SIGKILL');
    /* A legacy engine to end the panes the broker still holds. */
    try {
      engine = await bootEngine({});
      for (const p of panes) {
        await end(p).catch(() => {});
      }
    } catch {
      /* the broker dies next anyway */
    }
    await kill(engine);
    await kill(broker);
    rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log(`\nPASS ${passed} FAIL ${failed}`);
  if (failed) {
    console.log(failures.map((f) => ` - ${f}`).join('\n'));
    process.exit(1);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
