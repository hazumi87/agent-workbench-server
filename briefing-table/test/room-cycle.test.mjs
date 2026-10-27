/**
 * Room disconnect / reconnect through a real scratch engine + broker
 * [ticket] (assemble-room F1/F2). Two bash panes (a claude-code recipe would
 * launch the REAL claude); pane A's row is re-labelled vendor claude-code in
 * the scratch table so it is "resumable", pane B stays a shell.
 *   - disconnect: bearer 403; person -> A ended 'cycle' -> dehydrated, B
 *     untouched, room/seats intact, one fact on the line, orphan checked;
 *   - room.actions follow (disconnect while live, reconnect once dehydrated);
 *   - reconnect: bearer 403; person -> A 'restoring' via the seat start path
 *     (browser tab placement: nothing opens, no attach), B not-restorable.
 *   - reconnect notice (Owner 2026-09-27): once the restored pane is attached
 *     and live, the stub fabric gets exactly ONE /send for it, signed as the
 *     room (`room-<id8>`), to the pane's checked-in slug, kind 'notice'. None
 *     while seating, on disconnect, before the restored pane is live, or for
 *     a plain seat start (a third seat @spare, started and attached after).
 * The engine talks to a STUB fabric (P(112)) so check-in and the notice are
 * real calls; it answers just enough of fabric-service (/checkin, /bind,
 * /send, /threads, /presence, /ack, WS /subscribe) and records every request.
 * SAFETY: scratch engine P(92) + scratch broker P(93) + stub fabric P(112),
 * temp table, childEnv(); never :7420/:7430/:8200/:8201/:8204. The temp dir is
 * removed.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import Database from 'better-sqlite3';
import { P, assertFree, childEnv, scratchShell } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(92);
const BROKER_PORT = P(93);
const FABRIC_PORT = P(112); // the stub fabric — NOT 8204 (the real one)
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'room-cycle-test-token';
const TARGETS = JSON.stringify({ targets: [{ id: 'local', label: 'Local', kind: 'local', shell: scratchShell() }] });

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

let cookie = '';
async function call(path, { json, as } = {}) {
  const headers = as === 'person' ? { cookie } : { authorization: `Bearer ${TOKEN}` };
  const init = { method: json === undefined ? 'GET' : 'POST', headers };
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  const res = await fetch(BASE + path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}

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
      if (waiters[i].pred(msg)) {
        waiters.splice(i, 1)[0].resolve(msg);
      }
    }
  });
  return {
    log,
    open: () => new Promise((resolve) => {
      ws.once('open', () => resolve(true));
      ws.once('error', () => resolve(false));
    }),
    send: (cmd) => ws.send(JSON.stringify(cmd)),
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

/* THE STUB FABRIC (after test/fabric-checkin.test.mjs). /checkin mints
   <project>-<8 hex> (or re-binds a remembered slug of the same project), /send
   records the envelope and answers 202, /threads opens one, /presence says no
   channel (so room delivery stays the typed path), /ack is accepted, and WS
   /subscribe answers ready + subscribed. Anything else is a recorded 404. */
function stubFabric() {
  const s = { checkins: [], sends: [], threads: [], other: [], instances: new Map(), channelLive: new Set() };
  const hex = () => randomBytes(4).toString('hex');
  const reply = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const http = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let b = {};
      try {
        b = raw ? JSON.parse(raw) : {};
      } catch {
        /* recorded as {} */
      }
      const inst = req.headers['x-fabric-instance'] ?? null;
      const path = req.url.split('?')[0];
      if (req.method === 'POST' && path === '/checkin') {
        const hinted = b.instance_hint && s.instances.get(b.instance_hint);
        const instance = hinted && hinted.project === b.project ? b.instance_hint : `i-${hex()}`;
        const reclaim = typeof b.remembered_slug === 'string' && b.remembered_slug.startsWith(`${b.project}-`);
        const slug = reclaim ? b.remembered_slug : `${b.project}-${hex()}`;
        s.instances.set(instance, { project: b.project, slug });
        const answer = { ok: true, instance, status: reclaim ? 'bound' : 'minted', slug };
        s.checkins.push({ body: b, answer });
        return reply(res, 200, answer);
      }
      if (req.method === 'POST' && path === '/bind') {
        return reply(res, 200, { ok: true, instance: b.instance, slug: b.slug, status: 'bound' });
      }
      if (req.method === 'POST' && path === '/send') {
        s.sends.push({ env: b, instance: inst, at: Date.now() });
        const from = inst && s.instances.has(inst) ? s.instances.get(inst).slug : b.from;
        return reply(res, 202, { ok: true, envelope: { ...b, id: `m-${s.sends.length}`, from, ack: 'none' } });
      }
      if (req.method === 'POST' && path === '/threads') {
        const thread = `th${hex()}`;
        s.threads.push({ body: b, thread });
        return reply(res, 200, { ok: true, thread, topic: b.topic ?? null, pinned: Boolean(b.pinned), opened_by: b.by, state: 'open' });
      }
      const m = /^\/threads\/([^/]+)\/acks$/.exec(path);
      if (req.method === 'GET' && m) {
        return reply(res, 200, { ok: true, thread: m[1], state: 'open', acks: [] });
      }
      if (req.method === 'GET' && path === '/presence') {
        const pid = new URL(req.url, 'http://x').searchParams.get('paneid');
        return reply(res, 200, { ok: true, channel: s.channelLive.has(pid) });
      }
      if (req.method === 'POST' && path === '/ack') {
        return reply(res, 200, { ok: true });
      }
      s.other.push(`${req.method} ${path}`);
      reply(res, 404, { ok: false, error: `no route for ${req.method} ${path}` });
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set();
  http.on('upgrade', (req, socket, head) => {
    if (req.url.split('?')[0] !== '/subscribe') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      ws.on('message', (raw) => {
        let f = {};
        try {
          f = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (f.type === 'subscribe') {
          ws.send(JSON.stringify({ type: 'subscribed', slugs: f.slugs }));
        }
      });
      ws.send(JSON.stringify({ type: 'ready' }));
    });
  });
  return {
    s,
    listen: () =>
      new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(FABRIC_PORT, HOST, resolve);
      }),
    stop: () =>
      new Promise((r) => {
        for (const ws of sockets) ws.terminate();
        http.closeAllConnections?.();
        http.close(() => r());
      }),
  };
}
const NOTICE_TEXT = 'The room was offline, and now you are back';
async function until(fn, ms, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(step);
  }
}

async function run() {
  for (const p of [PORT, BROKER_PORT, FABRIC_PORT]) {
    await assertFree(p, 'room-cycle.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-cycle-'));
  const dbPath = join(tmpDir, 'mapping.db');
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  let log = '';
  let broker = null;
  let engine = null;
  const panes = [];
  let c1 = null;
  const fabric = stubFabric();
  const notices = () => fabric.s.sends.filter((x) => x.env?.kind === 'notice' && String(x.env?.body ?? '').includes(NOTICE_TEXT));
  const slugOf = (pane) => [...fabric.s.checkins].reverse().find((c) => c.body?.paneid === pane)?.answer?.slug ?? null;
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
  try {
    await fabric.listen();
    broker = spawn(process.execPath, ['--import', loaderArg, 'node_modules/pty-broker/src/main.ts'], {
      cwd: REPO_ROOT,
      env: childEnv({ PTY_BROKER_PORT: String(BROKER_PORT) }),
    });
    broker.stdout.on('data', (d) => (log += d));
    broker.stderr.on('data', (d) => (log += d));
    if (!(await up(`http://${HOST}:${BROKER_PORT}/health`))) throw new Error(`broker did not come up\n${log}`);
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
        HARBOR_WB_FABRIC_CHECKIN_SWEEP_MS: '300',
        HARBOR_WB_FABRIC_CHECKIN_RETRY_MS: '400',
        HARBOR_WB_FABRIC_CHECKIN_TIMEOUT_MS: '1500',
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
    const login = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(TOKEN)}`,
      redirect: 'manual',
    });
    cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    ok(/wb_auth=/.test(cookie), 'a person cookie');

    console.log('\n[two live panes seated in one room]');
    c1 = client();
    ok(await c1.open(), 'a window opens /pty');
    const recipes = [];
    /* An explicit agent slug each: a cli-manager recipe derives none (wr §2.9),
       and a pane with no slug is never checked in, so it could not be sent to. */
    for (const [name, agent] of [['Cycle Agent', 'cycle-agent'], ['Cycle Shell', 'cycle-shell']]) {
      const recipe = (await call('/api/recipes', { json: { name, target: 'local', projectDir: tmpDir, vendor: 'cli-manager', agent } })).body?.recipe;
      ok(!!recipe?.id, `recipe ${name}`);
      recipes.push(recipe);
      const pane = `recipe:${recipe.id}`;
      panes.push(pane);
      c1.send({ type: 'attach', paneid: pane, recipe: recipe.id });
      ok(!!(await c1.wait((m) => m.type === 'pane.ready' && m.paneid === pane, 12000)), `${name} spawns a real pty`);
    }
    const [A, B] = panes;
    const db = new Database(dbPath);
    db.pragma('busy_timeout = 3000');
    db.prepare("UPDATE sessions SET vendor='claude-code', session_id='cyc-sess-a' WHERE paneid=?").run(A);
    db.close();
    const room = (await call('/api/rooms', { json: { name: 'Cycle Room' }, as: 'person' })).body;
    ok(!!room?.id, 'a room');
    for (const [i, handle] of ['agent', 'shell'].entries()) {
      const r = await call(`/api/rooms/${room.id}/seats`, { json: { recipe_id: recipes[i].id, handle, policy: 'persistent', occupant: panes[i] }, as: 'person' });
      eq(r.status, 200, `seat @${handle} bound to its pane`);
    }
    let view = (await call(`/api/rooms/${room.id}`)).body;
    eq(view?.actions, ['disconnect'], 'room.actions offers disconnect while a resumable seat is live');
    ok(!!(await until(() => slugOf(A) && slugOf(B), 8000)), `both live panes check in with the stub fabric (A=${slugOf(A)}, B=${slugOf(B)})`);
    eq(fabric.s.sends.length, 0, 'seating live panes sends nothing to the fabric');

    console.log('\n[disconnect]');
    let r = await call(`/api/rooms/${room.id}/disconnect`, { json: {} });
    eq(r.status, 403, 'a bearer (no human) is refused');
    view = (await call(`/api/rooms/${room.id}`)).body;
    eq(view?.seats?.map((s) => s.occupant?.state), ['live', 'live'], 'the refusal ended nothing');
    r = await call(`/api/rooms/${room.id}/disconnect`, { json: {}, as: 'person' });
    eq(r.status, 200, 'a person disconnects');
    eq(r.body?.ended, 1, 'one seat ended');
    const sa = r.body?.seats?.find((s) => s.handle === 'agent');
    const sb = r.body?.seats?.find((s) => s.handle === 'shell');
    eq([sa?.result, sa?.state], ['disconnected', 'dehydrated'], 'the claude-code seat is filed dehydrated');
    ok(sa?.orphan === 'none' || sa?.orphan === null || typeof sa?.orphan === 'object', `orphan check answered (${JSON.stringify(sa?.orphan)})`);
    eq([sb?.result, sb?.reason], ['untouched', 'not-resumable'], 'the shell seat is untouched and reported');
    view = (await call(`/api/rooms/${room.id}`)).body;
    eq(view?.room?.state, 'open', 'the room stays open');
    eq(view?.seats?.map((s) => [s.handle, s.occupant?.id, s.occupant?.state]), [['agent', A, 'dehydrated'], ['shell', B, 'live']], 'seats keep their occupants');
    eq(view?.actions, ['reconnect'], 'room.actions now offers reconnect');
    const line = (await call(`/api/rooms/${room.id}/line?kind=fact`)).body?.entries ?? [];
    ok(line.some((e) => /agents disconnected by the user/.test(e.body ?? '')), 'one room fact on the line');
    const tbl = (await call('/api/table')).body?.sessions ?? [];
    eq(tbl.find((s) => s.paneid === A)?.state, 'dehydrated', '/api/table agrees');
    await sleep(1500); // past several check-in sweeps: anything disconnect sent would be here
    eq(fabric.s.sends.length, 0, 'disconnect sends nothing to the fabric (no reconnect notice)');

    console.log('\n[a disconnected session is not restored by a view re-attaching (Owner 2026-10-01)]');
    {
      const readyN = c1.log.filter((m) => m.type === 'pane.ready' && m.paneid === A).length;
      c1.send({ type: 'attach', paneid: A, recipe: recipes[0].id });
      const refused = await c1.wait((m) => m.type === 'pane.needs-launch' && m.paneid === A, 8000);
      ok(!!refused, 'a passive attach to the disconnected pane answers pane.needs-launch');
      ok(/disconnected/.test(refused?.message ?? ''), `...and says it was disconnected (${refused?.message})`);
      await sleep(1500);
      eq(c1.log.filter((m) => m.type === 'pane.ready' && m.paneid === A).length, readyN, 'no session came back');
      eq(((await call('/api/table')).body?.sessions ?? []).find((x) => x.paneid === A)?.state, 'dehydrated', 'the row is still dehydrated');
    }

    console.log('\n[reconnect]');
    r = await call(`/api/rooms/${room.id}/reconnect`, { json: { target: 'tab', surface: 'browser' } });
    eq(r.status, 403, 'a bearer (no human) is refused');
    r = await call(`/api/rooms/${room.id}/reconnect`, { json: { target: 'tab', surface: 'browser' }, as: 'person' });
    eq(r.status, 200, 'a person reconnects');
    eq(r.body?.restoring, 1, 'one seat restoring');
    const ra = r.body?.seats?.find((s) => s.handle === 'agent');
    const rb = r.body?.seats?.find((s) => s.handle === 'shell');
    eq([ra?.result, ra?.paneid], ['restoring', A], 'the dehydrated seat restores into the SAME pane');
    eq(rb?.result, 'already-live', 'the live shell seat is reported already-live');
    view = (await call(`/api/rooms/${room.id}`)).body;
    eq(view?.seats?.find((s) => s.handle === 'agent')?.status, 'starting', 'the seat is starting (restore requested; the attach resumes it)');
    ok(/@agent started \(rehydrate\)/.test(log), 'the seat start ran the rehydrate path');

    console.log('\n[reconnect notice]');
    await sleep(1000);
    eq(notices().length, 0, 'no notice while the restored pane is not live yet (browser placement: nothing attached)');
    /* Stand in for the window the reconnect would open: attach the pane. Its
       banked session_id is cleared first so the attach relaunches the recipe's
       shell instead of TYPING a real `claude --resume` into it (the server has
       claude on PATH, and its hooks post to the live engine on :8201). */
    const db2 = new Database(dbPath);
    db2.pragma('busy_timeout = 3000');
    db2.prepare('UPDATE sessions SET session_id=NULL WHERE paneid=?').run(A);
    db2.close();
    const readyBefore = c1.log.filter((m) => m.type === 'pane.ready' && m.paneid === A).length;
    c1.send({ type: 'attach', paneid: A, recipe: recipes[0].id });
    ok(!!(await until(() => c1.log.filter((m) => m.type === 'pane.ready' && m.paneid === A).length > readyBefore, 12000)), 'the restored pane attaches and goes live');
    /* vrpc1 2026-09-27: a notice sent before the pane's channel is up is lost
       on a relay (VRPC) pane, so it waits for presence to say channel:true */
    await sleep(4000);
    eq(notices().length, 0, 'no notice while the pane is live but its channel is not up yet');
    fabric.s.channelLive.add(A);
    ok(!!(await until(() => notices().length > 0, 15000)), 'once its channel is up, a reconnect notice reaches the stub fabric within 15 s');
    await sleep(4000); // longer than one retry interval (3 s): a second send would land here
    const sent = notices();
    eq(sent.length, r.body?.restoring, 'exactly one notice per restored seat');
    const n = sent[0]?.env ?? {};
    eq(n.from, 'room-' + room.id.slice(0, 8), 'signed as the room (room-<first 8 of the room id>)');
    ok(!!slugOf(A) && n.to === slugOf(A), `addressed to the restored pane's checked-in slug (to=${n.to}, slug=${slugOf(A)})`);
    eq([n.kind, n.class], ['notice', 'coordination'], "kind 'notice', class 'coordination'");
    ok(String(n.body ?? '').includes(NOTICE_TEXT), 'the body is the reconnect notice');
    eq(sent[0]?.instance, null, 'sent with no pane instance (the room, not an agent, is the sender)');
    ok(!sent.some((x) => x.env?.to === slugOf(B)), 'the already-live seat gets no notice');
    eq(fabric.s.sends.length, sent.length, 'nothing else was sent to the fabric');
    ok(/reconnect notice → @agent .* sent/.test(log), 'the engine logged the notice as sent');

    console.log('\n[plain seat start sends no notice]');
    const spare = await call(`/api/rooms/${room.id}/seats`, { json: { recipe_id: recipes[1].id, handle: 'spare', policy: 'persistent' }, as: 'person' });
    eq(spare.status, 200, 'an empty seat @spare');
    const spareId = spare.body?.seat?.id ?? spare.body?.id;
    const st = await call(`/api/rooms/${room.id}/seats/${spareId}/start`, { json: { target: 'tab', surface: 'browser' }, as: 'person' });
    eq(st.status, 200, 'the seat starts (fresh)');
    const P3 = st.body?.paneid;
    ok(!!P3 && !panes.includes(P3), `a new pane (${P3})`);
    if (P3) {
      panes.push(P3);
      c1.send({ type: 'attach', paneid: P3, recipe: recipes[1].id });
      ok(!!(await c1.wait((m) => m.type === 'pane.ready' && m.paneid === P3, 12000)), 'the started pane attaches and goes live');
      ok(!!(await until(() => slugOf(P3), 8000)), `it checks in (${slugOf(P3)})`);
      await sleep(4000); // longer than one notice retry interval
      eq(notices().length, 1, 'still exactly one notice: a plain seat start sends none');
      eq(fabric.s.sends.length, 1, 'and nothing else reached the fabric');
    }

    console.log('\n[per-seat disconnect (Owner 2026-09-28)]');
    /* The ending itself (disconnectOne: a live resumable pane -> 'cycle' ->
       dehydrated) is the SAME function the room disconnect above ran on
       @agent. Here: the seat route's own rules. After the reconnect above the
       relaunched @agent row is a shell recipe's (not resumable) in this
       harness, so it is the "nothing to disconnect" case. */
    const seatsNow = (await call(`/api/rooms/${room.id}`)).body?.seats ?? [];
    const agentSeat = seatsNow.find((x) => x.handle === 'agent');
    ok(!!agentSeat, 'the @agent seat is there');
    let sd = await call(`/api/rooms/${room.id}/seats/${agentSeat?.id}/disconnect`, { json: {} });
    eq(sd.status, 403, 'a bearer cannot disconnect a seat (human-only)');
    sd = await call(`/api/rooms/${room.id}/seats/${agentSeat?.id}/disconnect`, { json: {}, as: 'person' });
    eq(sd.status, 409, 'a seat with nothing resumable to end: 409');
    ok(/nothing to disconnect \((not-resumable|not-live|no-pane)/.test(sd.body?.error ?? ''), `...and it says why (${sd.body?.error})`);
    const stillLive = ((await call(`/api/rooms/${room.id}`)).body?.seats ?? []).filter((x) => x.occupant?.state === 'live').length;
    ok(stillLive >= 1, 'nothing was ended by the refusal');
    sd = await call(`/api/rooms/${room.id}/seats/no-such-seat/disconnect`, { json: {}, as: 'person' });
    eq(sd.status, 404, 'an unknown seat: 404');
  } catch (e) {
    failed++;
    failures.push(`threw: ${e?.stack ?? e}`);
    console.log(`  X threw: ${e?.stack ?? e}`);
    console.log(`--- log tail ---\n${log.slice(-2500)}`);
  } finally {
    if (c1) {
      for (const pane of panes) {
        c1.send({ type: 'kill', paneid: pane });
      }
      await sleep(500);
      c1.close();
    }
    await kill(engine);
    await kill(broker);
    await fabric.stop();
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
