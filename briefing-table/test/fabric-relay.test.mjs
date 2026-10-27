/**
 * ENGINE RELAY FOR VRPC CHANNEL PANES — `WS /api/fabric/relay?paneid=<id>`
 * (engine/fabric-relay.ts; contract v1, briefing-table--platform relay
 * 2026-09-25T13:57:33Z) through a real scratch engine and a stub fabric.
 *
 * Asserts, against the frames fabric-mcp 4da0a3e (relay mode) speaks:
 *   - bad/missing bearer → HTTP 401 at the upgrade (no socket, no exemption);
 *   - a paneid that is not a LIVE row → close 4404 'no-pane';
 *   - hello{caps:[channel]} → the pane re-checks in WITH caps ['channel'],
 *     ONE fabric /subscribe?instance=<pane instance> socket for this relay,
 *     subscribing [work slug, project]; `ready` reaches the client + {slug,
 *     instance};
 *   - fabric message frames forwarded verbatim;
 *   - client ack → POST /ack with X-Fabric-Instance: <pane instance>;
 *   - an unknown frame → {type:'error', error:'unknown frame'}, socket stays;
 *   - /api/diag/fabric counts relay sockets per pane;
 *   - relay close → the fabric socket closes; fabric close → relay 1011;
 *   - /pty still upgrades alongside (the one-upgrade-router regression guard,
 *     CLAUDE.md "A SECOND WebSocketServer ... KILLS THE FIRST").
 *
 * Pattern: fabric-checkin.test.mjs (dead broker, rows seeded via the store —
 * live rows AFTER boot). SAFETY: never touches :7420/:7430/:8200/:8201/:8204;
 * every child env comes from childEnv(); the temp dir is removed (guarded).
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(78); // engine — port table in test/_scratch.mjs
const DEAD_BROKER_PORT = P(79); // nothing may listen
const FABRIC_PORT = P(80); // the stub fabric — NOT 8204
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const WS_BASE = `ws://${HOST}:${PORT}`;
const TOKEN = 'fabric-relay-test-token';

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
async function until(fn, ms = 6000, step = 50) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) {
      return v;
    }
    await sleep(step);
  }
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

/* ---------------------------------------------------------------------------
 * STUB FABRIC: /checkin (mints, records caps + paneid), /ack (records body +
 * X-Fabric-Instance), WS /subscribe (records ?instance=, answers ready and
 * subscribed). `pushTo(instance, env)` sends a message frame to that
 * instance's sockets only; `dropInstance(instance)` terminates them.
 * ------------------------------------------------------------------------- */
function stubFabric() {
  const s = { checkins: [], acks: [], subscribes: [], sockets: [] };
  const instances = new Map(); // instance -> {project, slug}
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
        /* {} */
      }
      const path = req.url.split('?')[0];
      if (req.method === 'POST' && path === '/checkin') {
        s.checkins.push({ body: b, auth: req.headers.authorization ?? null });
        const hinted = b.instance_hint && instances.get(b.instance_hint);
        if (hinted && hinted.project === b.project) {
          return reply(res, 200, { ok: true, instance: b.instance_hint, status: 'bound', slug: hinted.slug });
        }
        const instance = `i-${hex()}`;
        const slug = `${b.project}-${hex()}`;
        instances.set(instance, { project: b.project, slug });
        return reply(res, 200, { ok: true, instance, status: 'minted', slug });
      }
      if (req.method === 'POST' && path === '/ack') {
        s.acks.push({ body: b, instance: req.headers['x-fabric-instance'] ?? null, auth: req.headers.authorization ?? null });
        return reply(res, 200, { ok: true });
      }
      reply(res, 404, { ok: false, error: `no route for ${req.method} ${path}` });
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://fabric.local');
    if (u.pathname !== '/subscribe') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const entry = { ws, instance: u.searchParams.get('instance'), auth: req.headers.authorization ?? null, open: true };
      s.sockets.push(entry);
      ws.on('close', () => (entry.open = false));
      ws.on('message', (raw) => {
        const f = JSON.parse(String(raw));
        if (f.type === 'subscribe') {
          s.subscribes.push({ instance: entry.instance, slugs: f.slugs });
          ws.send(JSON.stringify({ type: 'subscribed', slugs: f.slugs }));
        }
      });
      ws.send(JSON.stringify({ type: 'ready', protocolVersion: 1, slugs: [] }));
    });
  });
  const of = (instance) => s.sockets.filter((e) => e.instance === instance && e.open);
  return {
    s,
    of,
    pushTo: (instance, envelope) => {
      for (const e of of(instance)) e.ws.send(JSON.stringify({ type: 'message', envelope }));
    },
    dropInstance: (instance) => {
      for (const e of of(instance)) e.ws.terminate();
    },
    listen: () =>
      new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(FABRIC_PORT, HOST, resolve);
      }),
    stop: () =>
      new Promise((r) => {
        for (const e of s.sockets) e.ws.terminate();
        http.closeAllConnections?.();
        http.close(() => r());
      }),
  };
}

/** Open a relay client; collect frames; resolve on open or on refusal. */
function relayClient(paneid, headers = { authorization: `Bearer ${TOKEN}` }) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}/api/fabric/relay?paneid=${encodeURIComponent(paneid)}`, { headers });
    const c = { ws, frames: [], closed: null, status: null };
    ws.on('message', (raw) => c.frames.push(JSON.parse(String(raw))));
    ws.on('close', (code, reason) => (c.closed = { code, reason: String(reason) }));
    ws.on('unexpected-response', (_req, res) => {
      c.status = res.statusCode;
      resolve(c);
    });
    ws.on('error', () => resolve(c));
    ws.on('open', () => resolve(c));
  });
}
const frame = (c, pred) => c.frames.find(pred);

async function run() {
  for (const p of [PORT, DEAD_BROKER_PORT, FABRIC_PORT]) {
    await assertFree(p, 'fabric-relay.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-fabric-relay-'));
  const dbPath = join(tmpDir, 'mapping.db');
  const fabric = stubFabric();
  let engine = null;
  let engineLog = '';
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) {
      throw new Error(`seed failed: ${r.err}`);
    }
  };
  const diag = async () => (await (await fetch(`${BASE}/api/diag/fabric`, { headers: { authorization: `Bearer ${TOKEN}` } })).json());

  try {
    await fabric.listen();
    await seed({ recipes: [{ id: 'rec-v', name: 'Vega', target: 'local', projectDir: tmpDir, vendor: 'claude-code', agent: 'vega' }] });
    const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
    console.log(`booting scratch engine :${PORT} (dead broker :${DEAD_BROKER_PORT}, stub fabric :${FABRIC_PORT})`);
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
        HARBOR_WB_BROKER_AUTOSTART: '0',
        HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT),
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_NODE: 'testnode',
        HARBOR_WB_FABRIC_CHECKIN_SWEEP_MS: '300',
        HARBOR_WB_FABRIC_CHECKIN_RETRY_MS: '400',
        HARBOR_WB_FABRIC_CHECKIN_TIMEOUT_MS: '1500',
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
    await seed({ sessions: [{ paneid: 'p-v', recipe_id: 'rec-v', vendor: 'claude-code', agent: 'vega', session_id: 's-v', state: 'live' }] });
    const checked = await until(async () => ((await diag()).checkin?.panes?.['p-v']?.outcome === 'checked-in' ? (await diag()).checkin.panes['p-v'] : null));
    ok(checked, 'the seeded live pane checked in (the sweep)');

    console.log('\n[auth: bearer at the upgrade, no loopback exemption]');
    const noAuth = await relayClient('p-v', {});
    eq(noAuth.status, 401, 'no bearer → HTTP 401 before upgrade (loopback is NOT exempt)');
    const badAuth = await relayClient('p-v', { authorization: 'Bearer nope' });
    eq(badAuth.status, 401, 'wrong bearer → 401');

    console.log('\n[4404: not a live pane of this engine]');
    const ghost = await relayClient('p-ghost');
    await until(() => ghost.closed, 3000);
    eq(ghost.closed?.code, 4404, 'unknown paneid → close 4404');
    eq(ghost.closed?.reason, 'no-pane', "reason 'no-pane'");

    console.log('\n[hello → caps re-check-in, ONE per-relay fabric socket, ready + {slug, instance}]');
    const ciBefore = fabric.s.checkins.length;
    const c = await relayClient('p-v');
    ok(c.ws.readyState === WebSocket.OPEN, 'authorised relay for a live pane opens');
    c.ws.send(JSON.stringify({ type: 'hello', caps: ['channel'], ack: 'emit' }));
    const ready = await until(() => frame(c, (f) => f.type === 'ready'), 4000);
    ok(ready, 'client receives the fabric ready');
    eq(ready?.slug, checked?.slug, 'ready carries the pane\'s work slug');
    eq(ready?.instance, checked?.instance, 'and its instance');
    eq(ready?.protocolVersion, 1, 'the fabric\'s own ready fields pass through');
    const capsCi = fabric.s.checkins.slice(ciBefore).find((x) => Array.isArray(x.body.caps));
    same(capsCi?.body.caps, ['channel'], 're-check-in carries caps ["channel"]');
    eq(capsCi?.body.paneid, 'p-v', '...and the paneid');
    eq(capsCi?.body.instance_hint, checked?.instance, '...as the same instance (hint)');
    const sub = await until(() => fabric.s.subscribes.find((x) => x.instance === checked?.instance), 3000);
    ok(sub, 'the fabric got a /subscribe?instance=<pane instance> socket');
    same(sub?.slugs, [checked?.slug, 'vega'], 'subscribing [work slug, project]');
    eq(fabric.of(checked?.instance).length, 1, 'exactly ONE fabric socket for this relay');
    eq(fabric.of(checked?.instance)[0]?.auth, `Bearer ${TOKEN}`, 'dialled with the engine bearer');

    console.log('\n[fabric → client: forwarded verbatim]');
    const env = { id: 'm-1', from: 'other-agent', to: checked?.slug, kind: 'msg', class: 'notice', thread: 't1', body: 'hello pane', ack: 'none' };
    fabric.pushTo(checked?.instance, env);
    const msg = await until(() => frame(c, (f) => f.type === 'message'), 3000);
    same(msg, { type: 'message', envelope: env }, 'message frame arrives byte-for-byte');
    ok(frame(c, (f) => f.type === 'subscribed'), 'the fabric\'s subscribed frame is forwarded too');

    console.log('\n[unknown frame → error, never a close]');
    c.ws.send(JSON.stringify({ type: 'bogus' }));
    c.ws.send('not json');
    const errs = await until(() => (c.frames.filter((f) => f.type === 'error' && f.error === 'unknown frame').length >= 2 ? true : null), 3000);
    ok(errs, "both answered {type:'error', error:'unknown frame'}");
    await sleep(150);
    eq(c.ws.readyState, WebSocket.OPEN, 'and the relay is still open');

    console.log('\n[client ack → POST /ack with X-Fabric-Instance]');
    c.ws.send(JSON.stringify({ type: 'ack', id: 'm-1', level: 'delivered' }));
    const ack = await until(() => fabric.s.acks.find((a) => a.body.id === 'm-1'), 3000);
    same(ack?.body, { id: 'm-1', level: 'delivered' }, 'body {id, level}');
    eq(ack?.instance, checked?.instance, 'X-Fabric-Instance is the pane instance');
    eq(ack?.auth, `Bearer ${TOKEN}`, 'with the engine bearer');
    c.ws.send(JSON.stringify({ type: 'ack', id: 'm-1', level: 'sideways' }));
    ok(await until(() => frame(c, (f) => f.type === 'error' && /ack needs/.test(f.error)), 2000), 'a bad level is an error frame, not a forward');

    console.log('\n[diag: relay sockets per pane]');
    const d1 = await diag();
    eq(d1.relay?.panes?.['p-v']?.sockets, 1, '/api/diag/fabric relay.panes[p-v].sockets = 1');
    eq(d1.relay?.panes?.['p-v']?.relays?.[0]?.upstreamOpen, true, 'upstreamOpen true');
    eq(d1.relay?.panes?.['p-v']?.relays?.[0]?.ack, 'emit', 'ack mode recorded from hello');
    same(d1.checkin?.panes?.['p-v']?.caps, ['channel'], 'check-in diag shows caps ["channel"]');

    console.log('\n[/pty still upgrades alongside (one upgrade router)]');
    const pty = await new Promise((resolve) => {
      const ws = new WebSocket(`${WS_BASE}/pty`, { headers: { authorization: `Bearer ${TOKEN}` } });
      ws.on('open', () => {
        ws.close();
        resolve('open');
      });
      ws.on('unexpected-response', (_q, res) => resolve(`http ${res.statusCode}`));
      ws.on('error', (e) => resolve(`error ${e.message}`));
    });
    eq(pty, 'open', '/pty upgrades while a relay is open');
    const other = await new Promise((resolve) => {
      const ws = new WebSocket(`${WS_BASE}/nope`, { headers: { authorization: `Bearer ${TOKEN}` } });
      ws.on('open', () => resolve('open'));
      ws.on('error', () => resolve('refused'));
      ws.on('unexpected-response', () => resolve('refused'));
    });
    eq(other, 'refused', 'an unrouted path is still destroyed');

    console.log('\n[relay close → the fabric socket closes]');
    c.ws.close();
    ok(await until(() => fabric.of(checked?.instance).length === 0, 3000), 'the per-relay fabric socket is gone');
    ok(await until(async () => ((await diag()).relay?.sockets === 0 ? true : null), 3000), 'diag: 0 relay sockets');

    console.log('\n[fabric close → relay closes 1011 (the client reconnects)]');
    const c2 = await relayClient('p-v');
    c2.ws.send(JSON.stringify({ type: 'hello', caps: ['channel'], ack: 'emit' }));
    ok(await until(() => frame(c2, (f) => f.type === 'ready'), 4000), 'a second relay gets ready');
    fabric.dropInstance(checked?.instance);
    await until(() => c2.closed, 3000);
    eq(c2.closed?.code, 1011, 'relay closed 1011 when the fabric socket dropped');
    const h = await fetch(`${BASE}/health`).then((r) => r.status);
    eq(h, 200, 'engine healthy throughout');
  } catch (e) {
    failed++;
    failures.push(String(e?.stack ?? e));
    console.log(`  ✗ threw: ${e?.stack ?? e}`);
  } finally {
    engine?.kill('SIGKILL');
    await fabric.stop().catch(() => {});
    await sleep(200);
    /* Guarded: only ever the mkdtemp dir this suite made. */
    if (tmpDir.startsWith(tmpdir() + sep) && tmpDir.includes('wb-fabric-relay-')) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* a leftover temp dir is not a failure */
      }
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
