/**
 * Room PANELS through a real scratch engine (the design notes §2.6)
 * [ticket]: the registry (store, Seam C2), the four routes, the room
 * projection's `panels`, the room.state push, the URL allow-list, and who may
 * register / change a panel (a human credential, or the member itself via
 * `from`, limited to its own seat's panels).
 *
 * The rooms-routes pattern: our own engine on P() ports, a temp mapping db,
 * NO broker and NO pty (the broker port is a dead P() port, assertFree'd).
 * Live session rows are seeded through the store AFTER boot.
 *
 * Plus the ENGINE PROXY (GET .../panels/:pid/frame/*) against a stub app on
 * P(102): tail + query, no credential forwarded, Set-Cookie stripped, our
 * CSP/XFO/Referrer-Policy, redirect mapping, path confinement, 405/401/404,
 * upstream down / silent / oversized -> 502, allow-list re-checked per request.
 *
 * SAFETY: scratch engine P(100), dead broker P(101), stub app P(102), dead
 * upstream P(103), temp table + temp
 * config.json, childEnv(); never :7420/:7430/:8200/:8201/:8204. The temp dir
 * is removed.
 */
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(100); // scratch engine — port table in test/_scratch.mjs
const DEAD_BROKER_PORT = P(101); // nothing may listen
const STUB_PORT = P(102); // stub panel app (the proxy's upstream)
const DEAD_UPSTREAM_PORT = P(103); // a panel upstream nothing listens on
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'room-panels-test-token';

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
/** as: 'person' (window cookie) | 'agent' (bearer, the default). */
async function call(path, { method, json, as = 'agent' } = {}) {
  const headers = as === 'person' ? { cookie } : { authorization: `Bearer ${TOKEN}` };
  const init = { method: method ?? (json === undefined ? 'GET' : 'POST'), headers };
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  const res = await fetch(BASE + path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
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

function wsClient() {
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
    open: () =>
      new Promise((resolve) => {
        ws.once('open', () => resolve(true));
        ws.once('error', () => resolve(false));
      }),
    send: (cmd) => ws.send(JSON.stringify(cmd)),
    /** The first message matching pred that arrives at index >= from. */
    wait: (pred, from = 0, timeoutMs = 5000) =>
      new Promise((resolve) => {
        const hit = log.slice(from).find(pred);
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
  for (const p of [PORT, DEAD_BROKER_PORT, STUB_PORT, DEAD_UPSTREAM_PORT]) {
    await assertFree(p, 'room-panels.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-panels-'));
  const dbPath = join(tmpDir, 'mapping.db');
  const configPath = join(tmpDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ panelHosts: ['assets.example.test:8443'] }));
  let engine = null;
  let engineLog = '';
  let ws = null;
  const stub = createServer((req, res) => {
    const u = req.url ?? '';
    if (req.method === 'OPTIONS') {
      /* A real app's own CORS preflight answer (room-assets server.mjs,
         answered globally there too) — the proxy must forward OPTIONS
         upstream for THIS to ever run, and must forward Origin /
         Access-Control-Request-* so an app that reflects them (unlike
         room-assets' fixed answer) sees the real ask. */
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, HEAD',
        'access-control-allow-headers': 'if-none-match',
        'x-seen-origin': String(req.headers.origin ?? ''),
        'x-seen-acrh': String(req.headers['access-control-request-headers'] ?? ''),
      });
      res.end();
      return;
    }
    if (u === '/app/' || u.startsWith('/app/?')) {
      res.writeHead(200, {
        'content-type': 'text/html',
        'set-cookie': 'upstream=1; Path=/',
        'content-security-policy': 'default-src *',
        'x-frame-options': 'DENY',
        'x-stub': 'yes',
      });
      res.end('INDEX');
    } else if (u.startsWith('/app/echo')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: u, headers: req.headers }));
    } else if (u.startsWith('/app/cached')) {
      /* a revalidating upstream (Image Studio's panel.json, room-assets'
         items.json [perf/poll-traffic]): ETag + Last-Modified, 304 on a match */
      const tag = '"v1"';
      const lm = 'Tue, 29 Sep 2026 10:00:00 GMT';
      const base = { etag: tag, 'last-modified': lm, 'cache-control': 'private, no-cache', 'x-seen-inm': String(req.headers['if-none-match'] ?? ''), 'x-seen-ims': String(req.headers['if-modified-since'] ?? '') };
      if (req.headers['if-none-match'] === tag || req.headers['if-modified-since'] === lm) {
        res.writeHead(304, base);
        res.end();
      } else {
        res.writeHead(200, { ...base, 'content-type': 'application/json' });
        res.end(JSON.stringify({ items: [1, 2, 3] }));
      }
    } else if (u === '/app/redir') {
      res.writeHead(302, { location: '/app/echo?r=1' });
      res.end();
    } else if (u === '/app/big') {
      res.writeHead(200, { 'content-length': String(21 * 1024 * 1024) });
      res.write('x');
    } else if (u === '/app/glb67' || u === '/app/glb120' || u === '/app/bin30') {
      /* a GLB the viewer loads may pass up to 96 MiB; the same bytes as any other type may not pass 20 MiB */
      const n = u === '/app/glb67' ? 67117320 : u === '/app/glb120' ? 120 * 1024 * 1024 : 30 * 1024 * 1024;
      res.writeHead(200, { 'content-type': u === '/app/bin30' ? 'application/octet-stream' : 'model/gltf-binary', 'content-length': String(n) });
      if (u === '/app/glb120') { res.write('x'); } else { const chunk = Buffer.alloc(1024 * 1024, 7); let left = n; (function pump() { while (left > 0) { const k = Math.min(left, chunk.length); left -= k; if (!res.write(k === chunk.length ? chunk : chunk.subarray(0, k))) { res.once('drain', pump); return; } } res.end(); })(); }
    } else if (u === '/app/slow') {
      /* never answers */
    } else {
      res.writeHead(404);
      res.end('stub 404');
    }
  });
  await new Promise((r) => stub.listen(STUB_PORT, HOST, r));
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
        HARBOR_WB_FABRIC_URL: '',
        HARBOR_WB_BROKER_AUTOSTART: '0',
        HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT),
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_NODE: 'testnode',
        HARBOR_WB_CONFIG: configPath,
        HARBOR_WB_PANEL_HOSTS: 'env.example.test,server.example.ts.net,100.64.0.1:8215',
        HARBOR_WB_PANEL_PROXY_TIMEOUT_MS: '800',
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
    const login = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(TOKEN)}`,
      redirect: 'manual',
    });
    cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    ok(/wb_auth=/.test(cookie), 'a person cookie');

    // LIVE rows + rooms, after boot (reconcile would have swept live rows).
    const A = 'recipe:rec-a#1';
    const B = 'recipe:rec-b#1';
    const FREE = 'recipe:rec-a#2'; // live, seated nowhere
    const seeded = await seed({
      recipes: [
        { id: 'rec-a', name: 'Alpha', projectDir: '/srv/x/alpha', vendor: 'cli-manager', agent: 'alpha' },
        { id: 'rec-b', name: 'Beta', projectDir: '/srv/x/beta', vendor: 'cli-manager', agent: 'beta' },
      ],
      sessions: [
        { paneid: A, recipe_id: 'rec-a', vendor: 'cli-manager', agent: 'alpha', state: 'live' },
        { paneid: B, recipe_id: 'rec-b', vendor: 'cli-manager', agent: 'beta', state: 'live' },
        { paneid: FREE, recipe_id: 'rec-a', vendor: 'cli-manager', agent: 'alpha', state: 'live' },
      ],
      rooms: [
        { name: 'Panels', seats: [{ handle: 'a', recipe_id: 'rec-a', occupant: A }, { handle: 'b', recipe_id: 'rec-b', occupant: B }] },
        { name: 'Cap', seats: [] },
      ],
    });
    const room = seeded.rooms[0];
    const capRoom = seeded.rooms[1];
    const R = `/api/rooms/${room.id}`;

    console.log('\n[projection: panels on every room view]');
    let view = (await call(R)).body;
    eq(view?.panels, [], 'GET /api/rooms/:id carries panels: [] before any');
    eq((await call(`${R}/panels`)).body, { panels: [] }, 'GET .../panels: {panels: []}');

    console.log('\n[who may register]');
    let r = await call(`${R}/panels`, { json: { title: 'Tasks', url: 'http://127.0.0.1:9999/tasks' } });
    eq(r.status, 403, 'a bearer with no `from`: 403 (a panel is not the line — no-from is not enough)');
    eq(r.body?.field, 'credential', 'naming the credential');
    r = await call(`${R}/panels`, { json: { title: 'Tasks', url: 'http://127.0.0.1:9999/tasks', from: { paneid: FREE } } });
    eq(r.status, 403, 'from a live pane that holds no seat here: 403');
    eq(r.body?.field, 'from', 'naming from');

    console.log('\n[a person registers]');
    r = await call(`${R}/panels`, { as: 'person', json: { title: '  Tasks ', url: 'http://127.0.0.1:9999/tasks', icon: 'list' } });
    eq(r.status, 200, 'cookie: 200');
    const tasks = r.body?.panel;
    eq(
      tasks && { kind: tasks.kind, title: tasks.title, url: tasks.url, seat_id: tasks.seat_id, seat_handle: tasks.seat_handle, icon: tasks.icon, order: tasks.order, created_by: tasks.created_by },
      { kind: 'app', title: 'Tasks', url: 'http://127.0.0.1:9999/tasks', seat_id: null, seat_handle: null, icon: 'list', order: 0, created_by: 'user' },
      'the stored panel (title trimmed, kind defaults to app, appended at order 0)',
    );
    eq(r.body?.entries?.map((e) => [e.kind, e.body]), [['fact', 'panel "Tasks" was added']], 'one Room fact on the line');
    r = await call(`${R}/panels`, { as: 'person', json: { title: 'Share', url: 'http://100.64.0.1:8215/rooms/panels-x/', seat_id: room.seats.b } });
    eq(r.status, 200, 'a person may hang a panel off any active seat');
    const share = r.body?.panel;
    eq([share?.seat_id, share?.seat_handle, share?.order], [room.seats.b, 'b', 1], 'seat_id + derived seat_handle, next order');
    eq(r.body?.entries?.[0]?.target, 'b', 'the fact is about that seat');
    r = await call(`${R}/panels`, { as: 'person', json: { title: 'X', url: 'http://127.0.0.1/', seat_id: 'no-such-seat' } });
    eq([r.status, r.body?.field], [404, 'seat_id'], 'an unknown seat_id: 404 seat_id');

    console.log('\n[URL allow-list]');
    const tryUrl = async (url) => (await call(`${R}/panels`, { as: 'person', json: { title: 'U', url } })).body;
    const refused = [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'ftp://127.0.0.1/x',
      'file:///etc/passwd',
      'http://evil.example.com/',
      'http://user:pw@127.0.0.1/',
      'http://100.64.0.1:8216/',
      'http://100.64.0.1/',
      'https://assets.example.test:8444/',
      'not a url',
      '',
    ];
    for (const url of refused) {
      const b = await tryUrl(url);
      eq(b?.field, 'url', `refused: ${JSON.stringify(url)}`);
    }
    const allowed = [
      'http://localhost:3000/',
      'http://[::1]:8080/',
      'https://server.example.ts.net:8444/x',
      'https://assets.example.test:8443/a', // config.json panelHosts (host:port)
      'https://env.example.test:1234/b', // HARBOR_WB_PANEL_HOSTS (host, any port)
    ];
    const allowedIds = [];
    for (const url of allowed) {
      const b = await tryUrl(url);
      ok(!!b?.panel?.id, `allowed: ${url}`);
      if (b?.panel?.id) allowedIds.push(b.panel.id);
    }
    for (const id of allowedIds) {
      await call(`${R}/panels/${id}`, { method: 'DELETE', as: 'person' });
    }

    console.log('\n[other refusals]');
    r = await call(`${R}/panels`, { as: 'person', json: { title: '', url: 'http://127.0.0.1/' } });
    eq([r.status, r.body?.field], [400, 'title'], 'empty title: 400 title');
    r = await call(`${R}/panels`, { as: 'person', json: { title: 'I', url: 'http://127.0.0.1/', icon: 'https://x/y.png' } });
    eq([r.status, r.body?.field], [400, 'icon'], 'an icon URL: 400 icon (an icon is a key)');
    r = await call(`${R}/panels`, { as: 'person', json: { title: 'K', url: 'http://127.0.0.1/', kind: 'widget' } });
    eq([r.status, r.body?.field], [400, 'kind'], 'an unknown kind: 400 kind');

    console.log('\n[a member registers on its own seat]');
    r = await call(`${R}/panels`, { json: { title: 'Alpha view', url: 'http://127.0.0.1:7777/', from: { paneid: A } } });
    eq(r.status, 200, 'from its own live pane: 200 (bearer)');
    const alpha = r.body?.panel;
    eq([alpha?.seat_id, alpha?.seat_handle, alpha?.created_by], [room.seats.a, 'a', room.seats.a], 'seat_id forced to the actor seat');
    r = await call(`${R}/panels`, { json: { title: 'Nope', url: 'http://127.0.0.1:7777/', seat_id: room.seats.b, from: { paneid: A } } });
    eq([r.status, r.body?.field], [403, 'seat_id'], 'a member cannot hang a panel off another seat');

    console.log('\n[PATCH]');
    r = await call(`${R}/panels/${alpha.id}`, { method: 'PATCH', json: { title: 'Alpha board', from: { paneid: A } } });
    eq(r.status, 200, 'member retitles its own panel');
    eq(r.body?.entries?.map((e) => e.body), ['panel "Alpha view" was renamed "Alpha board"'], 'a retitle is a fact');
    r = await call(`${R}/panels/${tasks.id}`, { method: 'PATCH', json: { title: 'Mine', from: { paneid: A } } });
    eq([r.status, r.body?.field], [403, 'from'], "member cannot touch the user's panel");
    r = await call(`${R}/panels/${share.id}`, { method: 'DELETE', json: { from: { paneid: A } } });
    eq([r.status, r.body?.field], [403, 'from'], "member cannot remove another seat's panel");
    r = await call(`${R}/panels/${tasks.id}`, { method: 'PATCH', json: { title: 'Mine' } });
    eq([r.status, r.body?.field], [403, 'credential'], 'bearer with no from: 403 credential');
    r = await call(`${R}/panels/${tasks.id}`, { method: 'PATCH', as: 'person', json: { url: 'http://127.0.0.1:1/' } });
    eq([r.status, r.body?.field], [400, 'url'], 'url cannot be patched');
    r = await call(`${R}/panels/${tasks.id}`, { method: 'PATCH', as: 'person', json: {} });
    eq([r.status, r.body?.field], [400, 'body'], 'an empty PATCH: 400 body');
    r = await call(`${R}/panels/${tasks.id}`, { method: 'PATCH', as: 'person', json: { order: 1.5 } });
    eq([r.status, r.body?.field], [400, 'order'], 'a non-integer order: 400 order');
    r = await call(`${R}/panels/${tasks.id}`, { method: 'PATCH', as: 'person', json: { order: 10 } });
    eq([r.status, r.body?.entries?.length, r.body?.panel?.order], [200, 0, 10], 'a reorder: 200, no fact');
    r = await call(`${R}/panels/nope`, { method: 'PATCH', as: 'person', json: { order: 1 } });
    eq([r.status, r.body?.field], [404, 'panel'], 'an unknown panel: 404 panel');
    view = (await call(R)).body;
    eq(view?.panels?.map((p) => p.title), ['Share', 'Alpha board', 'Tasks'], 'GET room: panels in order (Tasks moved last)');
    const listed = (await call('/api/rooms')).body?.find((x) => x.room.id === room.id);
    eq(listed?.panels?.length, 3, 'GET /api/rooms carries panels too');

    console.log('\n[room.state push carries panels]');
    ws = wsClient();
    ok(await ws.open(), 'a window opens /pty');
    ws.send({ type: 'room.subscribe', rooms: [room.id] });
    ok(!!(await ws.wait((m) => m.type === 'room.subscribed')), 'room.subscribed');
    const mark = ws.log.length;
    r = await call(`${R}/panels`, { as: 'person', json: { title: 'Pushed', url: 'http://127.0.0.1:5555/' } });
    eq(r.status, 200, 'another panel');
    const push = await ws.wait((m) => m.type === 'room.state' && m.roomId === room.id && m.panels?.some((p) => p.title === 'Pushed'), mark);
    ok(!!push, 'room.state pushed with the new panel in panels');
    const fact = await ws.wait((m) => m.type === 'room.line' && m.entry?.body === 'panel "Pushed" was added', mark);
    ok(!!fact, 'room.line pushed with the fact');
    const mark2 = ws.log.length;
    r = await call(`${R}/panels/${r.body.panel.id}`, { method: 'DELETE', as: 'person' });
    eq([r.status, r.body?.entries?.[0]?.body], [200, 'panel "Pushed" was removed'], 'DELETE: 200 + fact');
    ok(
      !!(await ws.wait((m) => m.type === 'room.state' && m.roomId === room.id && !m.panels?.some((p) => p.title === 'Pushed'), mark2)),
      'room.state pushed without it',
    );

    console.log('\n[a seat that leaves]');
    r = await call(`${R}/seats/${room.seats.b}`, { method: 'DELETE', as: 'person' });
    eq(r.status, 200, '@b leaves');
    view = (await call(R)).body;
    const sh = view?.panels?.find((p) => p.id === share.id);
    eq([sh?.seat_id, sh?.seat_handle], [room.seats.b, null], 'its panel stays, seat_handle null (the renderer shows it room-level or hides it)');

    console.log('\n[member deletes its own]');
    r = await call(`${R}/panels/${alpha.id}`, { method: 'DELETE', json: { from: { paneid: A } } });
    eq(r.status, 200, 'member removes its own panel');

    console.log('\n[archived room]');
    eq((await call(`${R}/archive`, { json: {}, as: 'person' })).status, 200, 'archive the room');
    r = await call(`${R}/panels`, { as: 'person', json: { title: 'Late', url: 'http://127.0.0.1/' } });
    eq([r.status, r.body?.field], [409, 'state'], 'no panel is added to an archived room');
    r = await call(`${R}/panels/${tasks.id}`, { method: 'PATCH', as: 'person', json: { title: 'Late' } });
    eq(r.status, 409, 'nor retitled');
    r = await call(`${R}/panels/${tasks.id}`, { method: 'DELETE', as: 'person' });
    eq(r.status, 200, 'but one can always be REMOVED (a bad URL is never stuck behind /reopen)');

    console.log('\n[the per-room cap]');
    const C = `/api/rooms/${capRoom.id}/panels`;
    let okCount = 0;
    for (let i = 0; i < 24; i++) {
      if ((await call(C, { as: 'person', json: { title: `P${i}`, url: `http://127.0.0.1:${9000 + i}/` } })).status === 200) okCount++;
    }
    eq(okCount, 24, '24 panels register');
    r = await call(C, { as: 'person', json: { title: 'P24', url: 'http://127.0.0.1:9100/' } });
    eq([r.status, r.body?.field], [409, 'panel'], 'the 25th: 409');

    console.log('\n[the line keeps the record]');
    const facts = (await call(`${R}/line?kind=fact`)).body?.entries?.map((e) => e.body) ?? [];
    ok(facts.includes('panel "Tasks" was added') && facts.includes('panel "Tasks" was removed'), 'add + remove facts are on the line');

    console.log('\n[engine proxy: GET .../panels/:pid/frame/*]');
    const px = (await call('/api/rooms', { json: { name: 'Proxy' }, as: 'person' })).body;
    const PX = `/api/rooms/${px.id}/panels`;
    r = await call(PX, { as: 'person', json: { title: 'Stub', url: `http://127.0.0.1:${STUB_PORT}/app/` } });
    const stubPanel = r.body?.panel;
    const U = `/api/rooms/${px.id}/panels/${stubPanel?.id}/frame/`; // the untokened form
    ok(
      typeof stubPanel?.frameUrl === 'string' && stubPanel.frameUrl.startsWith(`${U}t/`) && /^[0-9a-z]+\.[A-Za-z0-9_-]{43}\/$/.test(stubPanel.frameUrl.slice(U.length + 2)),
      `frameUrl is the proxied path + t/<token>/ (got ${stubPanel?.frameUrl})`,
    );
    const TOK = stubPanel.frameUrl.slice(U.length + 2, -1);
    eq(stubPanel?.scripts, false, 'scripts defaults to false');
    eq(stubPanel?.uploads, false, 'uploads defaults to false');
    eq((await call(PX)).body?.panels?.[0]?.frameUrl, stubPanel?.frameUrl, 'GET .../panels carries frameUrl (same bucket, same token)');
    eq((await call(`/api/rooms/${px.id}`)).body?.panels?.[0]?.frameUrl, stubPanel?.frameUrl, 'room view carries frameUrl');
    const frame = (path, init = {}) =>
      fetch(BASE + path, { redirect: 'manual', ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
    const F = stubPanel.frameUrl;
    const CSP = 'sandbox allow-forms allow-popups allow-popups-to-escape-sandbox';

    let fr = await frame(F);
    eq([fr.status, await fr.text()], [200, 'INDEX'], 'frame/ -> the registered url');
    eq(fr.headers.get('set-cookie'), null, 'upstream Set-Cookie stripped');
    eq(fr.headers.get('content-security-policy'), CSP, 'our CSP sandbox (no allow-scripts, no allow-same-origin), upstream CSP replaced');
    eq(fr.headers.get('x-frame-options'), 'SAMEORIGIN', 'X-Frame-Options: SAMEORIGIN (upstream DENY replaced)');
    eq(fr.headers.get('referrer-policy'), 'no-referrer', 'Referrer-Policy: no-referrer');
    eq(fr.headers.get('x-stub'), 'yes', 'other upstream headers pass through');
    fr = await frame(F.slice(0, -1));
    eq([fr.status, await fr.text()], [200, 'INDEX'], 'the bare /frame too');
    fr = await fetch(BASE + F, { headers: { cookie } });
    eq([fr.status, await fr.text()], [200, 'INDEX'], 'a window cookie reads it too');

    fr = await frame(`${F}echo?x=1&y=two`);
    let echo = await fr.json().catch(() => null);
    eq(echo?.url, '/app/echo?x=1&y=two', 'tail path + query reach the upstream under the registered dir');
    eq(echo?.headers?.authorization, undefined, 'the caller\'s Authorization is not forwarded');
    fr = await fetch(`${BASE}${F}echo`, { headers: { cookie, accept: 'application/json' } });
    echo = await fr.json().catch(() => null);
    eq([echo?.headers?.cookie, echo?.headers?.accept], [undefined, 'application/json'], 'the caller\'s cookie is not forwarded; accept is');

    fr = await frame(`${F}redir`);
    eq([fr.status, fr.headers.get('location')], [302, `${F}echo?r=1`], 'a same-directory redirect maps back onto the frame path');

    /* CONDITIONAL REQUESTS PASS THROUGH [perf/poll-traffic]: the proxy forwards
       If-None-Match / If-Modified-Since and hands back ETag, Last-Modified,
       Cache-Control and a bodiless 304 unchanged, so an upstream that
       revalidates is not turned back into a full re-download by the engine. */
    fr = await frame(`${F}cached`);
    eq([fr.status, fr.headers.get('etag'), fr.headers.get('last-modified'), fr.headers.get('cache-control')],
      [200, '"v1"', 'Tue, 29 Sep 2026 10:00:00 GMT', 'private, no-cache'], 'proxy: ETag, Last-Modified and Cache-Control come back unchanged');
    const cond = (hdrs) => new Promise((resolve) => {
      const rq = httpRequest({ host: HOST, port: PORT, path: `${F}cached`, headers: { authorization: `Bearer ${TOKEN}`, ...hdrs } }, (rs) => {
        let n = 0;
        rs.on('data', (d) => (n += d.length));
        rs.on('end', () => resolve({ status: rs.statusCode, bytes: n, h: rs.headers }));
      });
      rq.on('error', () => resolve({ status: 0 }));
      rq.end();
    });
    let c = await cond({ 'if-none-match': '"v1"' });
    eq([c.status, c.bytes, c.h['x-seen-inm'], c.h.etag, c.h['cache-control']], [304, 0, '"v1"', '"v1"', 'private, no-cache'], 'proxy: If-None-Match reaches the upstream and its 304 comes back with no body');
    c = await cond({ 'if-modified-since': 'Tue, 29 Sep 2026 10:00:00 GMT' });
    eq([c.status, c.bytes, c.h['x-seen-ims'], c.h['last-modified']], [304, 0, 'Tue, 29 Sep 2026 10:00:00 GMT', 'Tue, 29 Sep 2026 10:00:00 GMT'], 'proxy: If-Modified-Since reaches the upstream and its 304 comes back');
    c = await cond({ 'if-none-match': '"v0"' });
    eq([c.status, c.bytes > 0], [200, true], 'proxy: a stale tag gets the full body');
    /* fetch() normalises %2e%2e itself, so a hostile path is sent RAW. */
    const raw = (path) =>
      new Promise((resolve) => {
        const rq = httpRequest({ host: HOST, port: PORT, path, headers: { authorization: `Bearer ${TOKEN}` } }, (rs) => {
          let b = '';
          rs.on('data', (d) => (b += d));
          rs.on('end', () => resolve({ status: rs.statusCode, body: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
        });
        rq.on('error', () => resolve({ status: 0 }));
        rq.end();
      });
    for (const bad of ['%2e%2e/secret', '../secret', 'echo/../../secret']) {
      const rr = await raw(`${F}${bad}`);
      eq([rr.status, rr.body?.field], [400, 'path'], `a tail leaving the registered directory (${bad}): 400`);
    }
    const hostTry = await raw(`${F}//evil.example.com/../echo?z=1`);
    eq([hostTry.status, hostTry.body?.url], [200, '/app/echo?z=1'], 'a //host tail cannot change the host (stays under the registered dir)');
    fr = await frame(F, { method: 'HEAD' });
    eq([fr.status, fr.headers.get('content-security-policy')], [200, CSP], 'HEAD: 200 with the CSP');
    /* CORS PREFLIGHT REACHES THE UPSTREAM APP [the "Assets panel keeps
       flipping to red" bug]: a sandboxed opaque-origin frame's fetch() with a
       non-simple header (e.g. room-assets' If-None-Match poll) is cross-
       origin to this proxy, so the browser sends OPTIONS first. Before the
       fix this proxy's own GET/HEAD-only gate 405'd the preflight itself
       (with no CORS headers), which fails it outright and the app's own
       OPTIONS handler never runs. Origin and Access-Control-Request-Headers
       must reach the stub too, for an app that reflects them. */
    fr = await frame(F, {
      method: 'OPTIONS',
      headers: { origin: 'null', 'access-control-request-method': 'GET', 'access-control-request-headers': 'if-none-match' },
    });
    eq(
      [fr.status, fr.headers.get('access-control-allow-origin'), fr.headers.get('access-control-allow-methods'), fr.headers.get('x-seen-origin'), fr.headers.get('x-seen-acrh')],
      [204, '*', 'GET, HEAD', 'null', 'if-none-match'],
      'OPTIONS: forwarded upstream, the app answers its own preflight (Origin + Access-Control-Request-Headers reach it)',
    );
    fr = await frame(F, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    eq([fr.status, fr.headers.get('allow')], [405, 'GET, HEAD, OPTIONS'], 'POST: 405 (OPTIONS is now in Allow too)');
    fr = await fetch(BASE + U, { redirect: 'manual' });
    eq(fr.status, 401, 'the untokened frame path with no credential: 401');
    fr = await frame(U);
    eq([fr.status, await fr.text()], [200, 'INDEX'], 'the untokened frame path with a bearer: 200');

    console.log('\n[frame token: no cookie, no bearer]');
    const bare = (path, init = {}) => fetch(BASE + path, { redirect: 'manual', ...init });
    for (const n of [1, 2]) {
      fr = await bare(F);
      eq([fr.status, await fr.text()], [200, 'INDEX'], `load ${n} with only the token (a meta-refresh reload): 200`);
    }
    eq(fr.headers.get('content-security-policy'), CSP, 'same CSP on the token path');
    fr = await bare(`${F}echo?q=1`);
    echo = await fr.json().catch(() => null);
    eq(echo?.url, '/app/echo?q=1', 'a relative asset / fetch under the token path: token stripped, tail + query upstream');
    fr = await bare(`${F}redir`);
    eq(fr.headers.get('location'), `${F}echo?r=1`, 'a redirect keeps the token it came in on');
    fr = await bare(F, { method: 'HEAD' });
    eq(fr.status, 200, 'HEAD with the token: 200');
    /* The real shape of the bug: a room's panel frame carries ONLY the frame
       token (no cookie, no bearer — it's opaque-origin), so this is the path
       Owner's browser actually took. */
    fr = await bare(F, {
      method: 'OPTIONS',
      headers: { origin: 'null', 'access-control-request-method': 'GET', 'access-control-request-headers': 'if-none-match' },
    });
    eq(
      [fr.status, fr.headers.get('access-control-allow-origin'), fr.headers.get('x-seen-acrh')],
      [204, '*', 'if-none-match'],
      'OPTIONS with only the token: 204, forwarded upstream — this is the request that was silently 405ing and blanking the panel',
    );
    fr = await bare(F, { method: 'POST' });
    eq(fr.status, 405, 'POST with the token: 405 (the token grants GET/HEAD/OPTIONS only)');
    const rawNoAuth = (path) =>
      new Promise((resolve) => {
        const rq = httpRequest({ host: HOST, port: PORT, path }, (rs) => {
          rs.resume();
          rs.on('end', () => resolve(rs.statusCode));
        });
        rq.on('error', () => resolve(0));
        rq.end();
      });
    eq(await rawNoAuth(`${F}%2e%2e/%2e%2e/%2e%2e/%2e%2e`), 400, 'the token path keeps the containment rule (400, never another route)');

    console.log('\n[frame token: refusals]');
    const other = (await call(PX, { as: 'person', json: { title: 'Other', url: `http://127.0.0.1:${STUB_PORT}/app/?p=other` } })).body.panel;
    fr = await bare(`/api/rooms/${px.id}/panels/${other.id}/frame/t/${TOK}/`);
    const refusedHtml = await fr.text();
    eq([fr.status, /reload the room/.test(refusedHtml), fr.headers.get('content-type')?.startsWith('text/html')], [401, true, true], "another panel's token: 401 + a 'reload the room' page");
    fr = await bare(`/api/rooms/${room.id}/panels/${stubPanel.id}/frame/t/${TOK}/`);
    eq(fr.status, 401, 'the right panel under another room id: 401');
    const [texp, tsig] = TOK.split('.');
    fr = await bare(`${U}t/${(parseInt(texp, 36) + 86400000).toString(36)}.${tsig}/`);
    eq(fr.status, 401, 'a forged (moved) expiry: 401');
    fr = await bare(`${U}t/${texp}.${'A'.repeat(43)}/`);
    eq(fr.status, 401, 'a forged signature: 401');
    fr = await bare(`${U}t/not-a-token/`);
    eq(fr.status, 401, 'garbage: 401');
    eq(engineLog.includes(TOK), false, 'the token is never in the engine log');

    console.log('\n[the token opens nothing else]');
    for (const [path, method] of [
      [`/api/rooms/${px.id}`, 'GET'],
      [`/api/rooms/${px.id}/panels`, 'GET'],
      [`/api/rooms/${px.id}/panels/${stubPanel.id}?t=${TOK}`, 'DELETE'],
      [`/api/rooms/${px.id}/panels/t/${TOK}/`, 'GET'],
      [`/api/rooms/${px.id}/line/t/${TOK}/`, 'GET'],
      [`/api/table?t=${TOK}`, 'GET'],
    ]) {
      fr = await bare(path, { method });
      eq(fr.status, 401, `${method} ${path.replace(TOK, '<token>')}: 401`);
    }
    fr = await frame(`${PX}/nope/frame/`);
    eq(fr.status, 404, 'an unknown panel: 404');

    r = await call(PX, { as: 'person', json: { title: 'Scripted', url: `http://127.0.0.1:${STUB_PORT}/app/?p=scripted`, scripts: true } });
    eq(r.body?.panel?.scripts, true, 'scripts:true is stored');
    fr = await frame(r.body.panel.frameUrl);
    eq(fr.headers.get('content-security-policy'), `${CSP} allow-scripts`, 'scripts:true -> CSP adds allow-scripts (still no allow-same-origin)');
    r = await call(`${PX}/${r.body.panel.id}`, { method: 'PATCH', as: 'person', json: { scripts: false } });
    eq([r.status, r.body?.field], [400, 'scripts'], 'scripts cannot be patched');
    r = await call(PX, { as: 'person', json: { title: 'S', url: 'http://127.0.0.1/', scripts: 'yes' } });
    eq([r.status, r.body?.field], [400, 'scripts'], 'scripts must be a boolean');

    console.log('\n[uploads capability (ticket)]');
    r = await call(PX, { as: 'person', json: { title: 'Assets', url: `http://127.0.0.1:${STUB_PORT}/app/?p=assets`, scripts: true, uploads: true } });
    eq([r.status, r.body?.panel?.uploads, r.body?.panel?.scripts], [200, true, true], 'uploads:true is stored at registration');
    const upId = r.body?.panel?.id;
    eq(r.body?.entries?.[0]?.meta && JSON.parse(r.body.entries[0].meta).uploads, true, 'the add fact records it');
    eq((await call(PX)).body?.panels?.find((p) => p.id === upId)?.uploads, true, 'GET .../panels projects it');
    eq((await call(PX.replace(/\/panels$/, ''))).body?.panels?.find((p) => p.id === upId)?.uploads, true, 'the room view projects it');
    r = await call(`${PX}/${upId}`, { method: 'PATCH', as: 'person', json: { uploads: false } });
    eq([r.status, r.body?.field], [400, 'uploads'], 'uploads cannot be patched');
    r = await call(PX, { as: 'person', json: { title: 'U2', url: 'http://127.0.0.1/', uploads: 1 } });
    eq([r.status, r.body?.field], [400, 'uploads'], 'uploads must be a boolean');

    r = await call(PX, { as: 'person', json: { title: 'Down', url: `http://127.0.0.1:${DEAD_UPSTREAM_PORT}/` } });
    fr = await frame(r.body.panel.frameUrl);
    eq(fr.status, 502, 'upstream down: 502');
    ok(typeof (await fr.json().catch(() => null))?.error === 'string', 'with {error}');
    const t0 = Date.now();
    fr = await frame(`${F}slow`);
    eq(fr.status, 502, 'upstream silent past the timeout: 502');
    ok(Date.now() - t0 < 5000, 'within the (test-shortened) timeout');
    fr = await frame(`${F}big`);
    eq(fr.status, 502, 'a declared body over 20 MB: 502');
    fr = await frame(`${F}bin30`);
    eq(fr.status, 502, 'a 30 MB non-GLB body is still over the 20 MiB cap');
    fr = await frame(`${F}glb67`);
    eq(fr.status, 200, 'a 67,117,320-byte model/gltf-binary body passes (cap 96 MiB)');
    eq((await fr.arrayBuffer()).byteLength, 67117320, 'every byte of it arrives');
    fr = await frame(`${F}glb120`);
    eq(fr.status, 502, 'a model/gltf-binary body declared over 96 MiB: 502');

    r = await call(PX, { as: 'person', json: { title: 'Cfg', url: 'https://assets.example.test:8443/app/' } });
    ok(!!r.body?.panel?.id, 'a panel on a config.json host');
    writeFileSync(configPath, JSON.stringify({ panelHosts: [] }));
    fr = await frame(r.body.panel.frameUrl);
    eq([fr.status, (await fr.json().catch(() => null))?.field], [403, 'url'], 'host dropped from config: the proxy refuses (re-checked per request)');
  } catch (e) {
    failed++;
    failures.push(String(e?.stack ?? e));
    console.log(`  X threw: ${e?.stack ?? e}`);
  } finally {
    ws?.close();
    stub.closeAllConnections?.();
    stub.close();
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
