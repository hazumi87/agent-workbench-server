/**
 * PANEL ACTIONS through a real scratch engine [ticket]
 * (the design notes §4.4, amendment "panel actions"):
 * POST /api/rooms/:id/panels/:pid/action {name, params?, body?}.
 *
 *   - registration: a verb marked `"panel": true` that does not qualify is a
 *     problem (400 at register), never silently dropped;
 *   - the allow-list is the PINNED tool.json: an undeclared verb is 403, and a
 *     tool.json edit that adds an action holds the app (409 held) until a
 *     person approves it, whose diff names the action;
 *   - params: :roomId is always the room's own; every other :param matches
 *     [A-Za-z0-9_-]{1,64} (traversal shapes 400) and is percent-encoded;
 *   - who: a person (cookie) only — a bearer 403s, no credential 401s, an
 *     Origin: null / non-JSON POST 403s; the panel must be this room's and an
 *     app's;
 *   - forwarding: exactly one upstream call, NO cookie / authorization /
 *     origin reaches the app; `input` becomes the body only for a verb that
 *     declares it — undeclared keys and actor fields dropped, scalars only, a
 *     string over 2000 chars or a body over 8 KB is 413 (never truncated);
 *     an app 4xx passes through, its 401 becomes 502, a stopped app 503; one
 *     engine log line per action.
 *
 * The fake app is a CHILD PROCESS with cwd = its tool root, writing its own
 * pid + port into status/app.json (the engine verifies who listens — the
 * room-apps.test pattern). Linux only (verifyEndpoint reads /proc).
 *
 * SAFETY: scratch engine P(252), dead broker P(253) (nothing may listen);
 * the fake apps take ephemeral ports. childEnv() scrubs PTY_BROKER_ and
 * HARBOR_WB_ keys; fabric + NATS off. Temp dirs removed, children killed.
 */
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(252);
const DEAD_BROKER_PORT = P(253);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'room-panel-actions-test-token';

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
/** as: 'person' (window cookie, the default here) | 'agent' (bearer) | 'none'. */
async function call(path, { method, json, as = 'person', headers = {} } = {}) {
  const h = { ...(as === 'person' ? { cookie } : as === 'agent' ? { authorization: `Bearer ${TOKEN}` } : {}), ...headers };
  const init = { method: method ?? (json === undefined ? 'GET' : 'POST'), headers: h };
  if (json !== undefined) {
    h['content-type'] ??= 'application/json';
    init.body = typeof json === 'string' ? json : JSON.stringify(json);
  }
  const res = await fetch(BASE + path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}

/* A fake app: records every request that is not /health or /__* (method,
   url, the headers that matter, the body). `.../fail` answers 409, `.../deny`
   401; anything else 200 with an echo. No regex here: this is a template
   string, and a backslash in it is a trap. */
const STUB_SRC = `
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
const calls = [];
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const srv = createServer((req, res) => {
  const u = req.url ?? '';
  if (u.startsWith('/health')) return json(res, 200, { ok: true });
  if (u === '/__calls') return json(res, 200, calls);
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    calls.push({ method: req.method, url: u, cookie: req.headers.cookie ?? null, authorization: req.headers.authorization ?? null,
      origin: req.headers.origin ?? null, contentType: req.headers['content-type'] ?? null, body: raw });
    if (u.endsWith('/fail')) return json(res, 409, { ok: false, error: 'nope' });
    if (u.endsWith('/deny')) return json(res, 401, { ok: false, error: 'who are you' });
    return json(res, 200, { ok: true, echo: req.method + ' ' + u });
  });
});
srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port;
  mkdirSync('status', { recursive: true });
  writeFileSync('status/app.json', JSON.stringify({ pid: process.pid, port }));
  console.log('READY ' + port);
});
`;

const children = [];
function startApp(stubPath, root) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [stubPath], { cwd: root, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(proc);
    let out = '';
    let done = false;
    const t = setTimeout(() => !done && reject(new Error(`stub in ${root} did not start: ${out}`)), 10_000);
    proc.stdout.on('data', (d) => {
      out += d;
      const m = /READY ([0-9]+)/.exec(out);
      if (m && !done) {
        done = true;
        clearTimeout(t);
        resolve({ proc, port: Number(m[1]) });
      }
    });
    proc.stderr.on('data', (d) => (out += d));
    proc.on('exit', () => !done && reject(new Error(`stub in ${root} exited: ${out}`)));
  });
}
const callsOf = (app) => fetch(`http://127.0.0.1:${app.port}/__calls`).then((r) => r.json());

const verb = (name, http, x = {}) => ({ name, class: x.class ?? 'mutate', call: { http }, ...('panel' in x ? (x.panel === undefined ? {} : { panel: x.panel }) : { panel: true }), ...(x.input ? { input: x.input } : {}) });
const tool = (slug, verbs) => ({
  contract: 'tool/draft-0',
  name: slug === 'acts' ? 'Acts' : slug,
  slug,
  version: '0.1.0',
  description: `${slug}.`,
  access: 'shared',
  endpoint: { bind: '127.0.0.1', discover: 'status/app.json#port' },
  verbs,
  panels: [{ title: slug, icon: 'tasks', view: 'GET /rooms/:roomId/view', scripts: true }],
});
const ACTS_VERBS = [
  verb('pin', 'POST /rooms/:roomId/items/:id/pin'),
  verb('unpin', 'DELETE /rooms/:roomId/items/:id/pin'),
  verb('note', 'POST /rooms/:roomId/items/:id/note', { input: { text: 'string', rating: 'up|down', urgent: 'boolean?' } }),
  verb('fail', 'POST /rooms/:roomId/fail'),
  verb('deny', 'POST /rooms/:roomId/deny'),
  verb('wipe', 'POST /rooms/:roomId/wipe', { panel: false }),
  verb('list', 'GET /rooms/:roomId/items', { class: 'read', panel: undefined }),
];

async function run() {
  if (process.platform !== 'linux') {
    console.log('room-panel-actions.test: needs /proc (linux) — the engine refuses every tool endpoint elsewhere');
    process.exit(1);
  }
  for (const p of [PORT, DEAD_BROKER_PORT]) {
    await assertFree(p, 'room-panel-actions.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-panel-actions-'));
  const toolsDir = join(tmpDir, 'tools');
  const dbPath = join(tmpDir, 'mapping.db');
  const stubPath = join(tmpDir, 'fake-app.mjs');
  writeFileSync(stubPath, STUB_SRC);
  const writeTool = (slug, t) => {
    const root = join(toolsDir, slug);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'tool.json'), JSON.stringify(t, null, 2));
    return root;
  };
  const rootActs = writeTool('acts', tool('acts', ACTS_VERBS));
  const rootOther = writeTool('other', tool('other', [verb('poke', 'POST /rooms/:roomId/poke')]));
  const rootBad1 = writeTool('bad-noroom', tool('bad-noroom', [verb('go', 'POST /items/:id/go')]));
  const rootBad2 = writeTool('bad-class', tool('bad-class', [verb('go', 'POST /rooms/:roomId/go', { class: 'dangerous' })]));
  const rootBad3 = writeTool('bad-seg', tool('bad-seg', [verb('go', 'POST /rooms/:roomId/../go')]));
  const rootBad4 = writeTool('bad-flag', tool('bad-flag', [verb('go', 'POST /rooms/:roomId/go', { panel: 'yes' })]));
  const rootBad5 = writeTool('bad-readpost', tool('bad-readpost', [verb('go', 'POST /rooms/:roomId/go', { class: 'read' })]));
  const rootBad6 = writeTool('bad-readdel', tool('bad-readdel', [verb('go', 'DELETE /rooms/:roomId/go', { class: 'read' })]));
  const rootBad7 = writeTool('bad-getinput', tool('bad-getinput', [verb('go', 'GET /rooms/:roomId/go', { class: 'read', input: { q: 'string' } })]));
  const rootBad8 = writeTool('bad-actor1', tool('bad-actor1', [verb('go', 'POST /rooms/:roomId/go', { input: { text: 'string', Flagged_By: 'handle' } })]));
  const rootBad9 = writeTool('bad-actor2', tool('bad-actor2', [verb('go', 'POST /rooms/:roomId/go', { input: { 'room-id': 'string' } })]));
  const rootBad10 = writeTool('bad-actor3', tool('bad-actor3', [verb('go', 'POST /rooms/:roomId/go', { input: { USER: 'string' } })]));
  const rootBad11 = writeTool('bad-actor4', tool('bad-actor4', [verb('go', 'POST /rooms/:roomId/go', { input: { author_name: 'string' } })]));
  const rootBad12 = writeTool('bad-actor5', tool('bad-actor5', [verb('go', 'POST /rooms/:roomId/go', { input: { sender: 'string' } })]));
  const rootGetOk = writeTool('ok-getread', tool('ok-getread', [verb('look', 'GET /rooms/:roomId/look', { class: 'read' })]));

  let engine = null;
  let engineLog = '';
  try {
    const acts = await startApp(stubPath, rootActs);
    const other = await startApp(stubPath, rootOther);
    const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
    engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_PORT: String(PORT),
        HARBOR_WB_HOST: '127.0.0.1',
        HARBOR_WB_TABLE: dbPath,
        HARBOR_WB_TOKEN: TOKEN,
        HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'),
        HARBOR_WB_IDENTITY: 'legacy',
        HARBOR_WB_NO_WINDOW: '1',
        HARBOR_WB_NATS_URL: '',
        HARBOR_WB_FABRIC_URL: '',
        HARBOR_WB_BROKER_AUTOSTART: '0',
        HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT),
        HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
        HARBOR_WB_NODE: 'testnode',
        HARBOR_WB_TOOLS_DIR: toolsDir,
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
    cookie = await windowCookie(BASE, TOKEN);

    console.log('\n[registration: a panel verb that does not qualify is a problem]');
    for (const [root, why] of [
      [rootBad1, 'no :roomId in the path'],
      [rootBad2, 'class dangerous'],
      [rootBad3, 'a .. segment'],
      [rootBad4, 'panel is not a boolean'],
      [rootBad5, 'class read with POST (a non-GET verb must be mutate)'],
      [rootBad6, 'class read with DELETE'],
      [rootBad7, 'a GET verb declaring input'],
      [rootBad8, 'input declaring Flagged_By (normalised: flaggedby)'],
      [rootBad9, 'input declaring room-id (normalised: roomid)'],
      [rootBad10, 'input declaring USER'],
      [rootBad11, 'input declaring author_name (normalised: authorname)'],
      [rootBad12, 'input declaring sender'],
    ]) {
      const r = await call('/api/apps', { json: { root } });
      ok(r.status === 400 && /marked panel/.test(r.body?.error ?? ''), `${why}: 400, naming the panel verb (${r.body?.error})`);
    }
    let r = await call('/api/apps', { json: { root: rootGetOk } });
    eq(r.status, 200, 'a read GET panel verb with no input: registers');
    r = await call('/api/apps', { json: { root: rootActs } });
    eq(r.status, 200, 'acts (pin/unpin/note/fail/deny panel verbs; wipe panel:false; list unmarked): registered');
    r = await call('/api/apps', { json: { root: rootOther } });
    eq(r.status, 200, 'other: registered');

    const room = (await call('/api/rooms', { json: { name: 'Actions' } })).body;
    const room2 = (await call('/api/rooms', { json: { name: 'Elsewhere' } })).body;
    for (const slug of ['acts', 'other']) {
      r = await call(`/api/rooms/${room.id}/apps`, { json: { slug } });
      eq(r.status, 200, `${slug} added to the room`);
    }
    const panels = (await call(`/api/rooms/${room.id}/panels`)).body.panels;
    const pActs = panels.find((p) => p.app_slug === 'acts');
    const pOther = panels.find((p) => p.app_slug === 'other');
    ok(!!pActs && !!pOther, 'each app has its panel in the room');
    r = await call(`/api/rooms/${room.id}/panels`, { json: { title: 'Plain', url: `http://127.0.0.1:${acts.port}/rooms/${room2.id}/view` } });
    const pPlain = r.body?.panel;
    ok(r.status === 200 && pPlain && !pPlain.app_slug, "a plain panel (another room's view: never adopted, no app_slug)");
    const A = (pid = pActs.id, rid = room.id) => `/api/rooms/${rid}/panels/${pid}/action`;
    const upstream = async () => (await callsOf(acts)).length;

    console.log('\n[who may ask]');
    let n0 = await upstream();
    r = await call(A(), { as: 'none', json: { name: 'pin', params: { id: '1' } } });
    eq(r.status, 401, 'no credential: 401');
    r = await call(A(), { as: 'agent', json: { name: 'pin', params: { id: '1' } } });
    eq([r.status, r.body?.field], [403, 'credential'], 'a bearer: 403 (a person only)');
    r = await call(A(), { json: { name: 'pin', params: { id: '1' } }, headers: { origin: 'null' } });
    eq([r.status, r.body?.field], [403, 'origin'], 'Origin: null (a sandboxed frame posting directly): 403');
    r = await call(A(), { json: { name: 'pin', params: { id: '1' } }, headers: { origin: 'https://evil.example' } });
    eq([r.status, r.body?.field], [403, 'origin'], 'a foreign Origin: 403');
    r = await call(A(), { json: { name: 'pin', params: { id: '1' } }, headers: { origin: 'http://127.0.0.1:1' } });
    eq([r.status, r.body?.field], [403, 'origin'], 'same host, a DIFFERENT port: 403');
    r = await call(A(), { json: { name: 'pin', params: { id: '1' } }, headers: { origin: `https://127.0.0.1:${PORT}` } });
    eq([r.status, r.body?.field], [403, 'origin'], 'same host and port, a different SCHEME: 403');
    r = await call(A(), { json: JSON.stringify({ name: 'pin', params: { id: '1' } }), headers: { 'content-type': 'text/plain' } });
    eq([r.status, r.body?.field], [403, 'origin'], 'a text/plain body (a no-preflight cross-origin shape): 403');
    r = await call(A(), { method: 'GET' });
    eq(r.status, 405, 'GET: 405');
    r = await call(A(pActs.id, room2.id), { json: { name: 'pin', params: { id: '1' } } });
    eq([r.status, r.body?.field], [404, 'panel'], "the panel through ANOTHER room's path: 404");
    r = await call(A(pPlain.id), { json: { name: 'pin', params: { id: '1' } } });
    eq([r.status, r.body?.field], [403, 'panel'], 'a non-app panel: 403');
    eq(await upstream(), n0, 'none of that reached the app');

    console.log('\n[the allow-list is the app\'s own, from the pinned tool.json]');
    n0 = await upstream();
    r = await call(A(), { json: { name: 'wipe' } });
    eq([r.status, r.body?.field], [403, 'name'], 'a verb with panel:false: 403');
    r = await call(A(), { json: { name: 'list' } });
    eq([r.status, r.body?.field], [403, 'name'], 'a verb not marked panel: 403');
    r = await call(A(), { json: { name: 'zzz' } });
    eq([r.status, r.body?.field], [403, 'name'], 'an unknown action: 403');
    r = await call(A(pOther.id), { json: { name: 'pin', params: { id: '1' } } });
    eq([r.status, r.body?.field], [403, 'name'], "another app's panel asking for acts' pin: 403 (per app)");
    r = await call(A(), { json: { name: '../pin' } });
    eq([r.status, r.body?.field], [400, 'name'], 'a malformed name: 400');
    eq(await upstream(), n0, 'none of that reached the app');

    console.log('\n[params]');
    n0 = await upstream();
    for (const [bad, what] of [
      ['../x', '../x'],
      ['1/../../admin', '1/../../admin'],
      ['%2e%2e', 'a percent-encoded ..'],
      ['a b', 'a space'],
      ['x'.repeat(65), '65 characters'],
      ['', 'empty'],
      [-1, 'a negative number'],
      [1.5, 'a fraction'],
      [{ a: 1 }, 'an object'],
    ]) {
      r = await call(A(), { json: { name: 'pin', params: { id: bad } } });
      eq([r.status, r.body?.field], [400, 'params.id'], `params.id ${what}: 400`);
    }
    r = await call(A(), { json: { name: 'pin', params: { id: '1', roomId: room2.id } } });
    eq([r.status, r.body?.field], [400, 'params.roomId'], ':roomId cannot be overridden: params.roomId is 400');
    r = await call(A(), { json: { name: 'pin', params: { id: '1', extra: 'x' } } });
    eq([r.status, r.body?.field], [400, 'params.extra'], 'an unknown param: 400');
    r = await call(A(), { json: { name: 'pin' } });
    eq([r.status, r.body?.field], [400, 'params.id'], 'a missing param: 400');
    r = await call(A(), { json: { name: 'pin', params: ['1'] } });
    eq([r.status, r.body?.field], [400, 'params'], 'params as an array: 400');
    r = await call(A(), { json: { name: 'pin', params: { id: '1' }, input: { x: 1 } } });
    eq([r.status, r.body?.field], [400, 'input'], 'input to a verb that declares none: 400');
    eq(await upstream(), n0, 'none of that reached the app');

    console.log('\n[the origin check under Tailscale Serve: https on the Serve host + port]');
    /* node's fetch will not send a custom Host, so these go through http.request */
    const raw = (headers) =>
      new Promise((resolve, reject) => {
        const body = JSON.stringify({ name: 'pin', params: { id: '3' } });
        const rq = httpRequest(
          { host: '127.0.0.1', port: PORT, method: 'POST', path: A(), headers: { cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } },
          (res) => {
            let t = '';
            res.on('data', (d) => (t += d));
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(t || 'null') }));
          },
        );
        rq.on('error', reject);
        rq.end(body);
      });
    const SERVE = 'host.example.ts.net';
    r = await raw({ host: `${SERVE}:8444`, 'x-forwarded-proto': 'https', 'x-forwarded-for': '100.64.0.9', origin: `https://${SERVE}:8444` });
    eq(r.status, 200, 'behind Serve: Origin https://<serve host>:8444 = the request\'s own origin: 200');
    r = await raw({ host: SERVE, 'x-forwarded-proto': 'https', 'x-forwarded-for': '100.64.0.9', origin: `https://${SERVE}:443` });
    eq(r.status, 200, 'behind Serve on 443: a ported Origin and a port-less Host are the same origin: 200');
    r = await raw({ host: `${SERVE}:8444`, 'x-forwarded-proto': 'https', 'x-forwarded-for': '100.64.0.9', origin: `https://${SERVE}:8445` });
    eq([r.status, r.body?.field], [403, 'origin'], 'behind Serve: another port on the same host: 403');
    r = await raw({ host: `${SERVE}:8444`, 'x-forwarded-for': '100.64.0.9', origin: `https://${SERVE}:8444` });
    eq([r.status, r.body?.field], [403, 'origin'], 'an https Origin on a request that did not come over https: 403');

    console.log('\n[forwarding]');
    n0 = await upstream();
    r = await call(A(), { json: { name: 'pin', params: { id: '42' } } });
    eq([r.status, r.body?.ok, r.body?.status], [200, true, 200], 'pin #42: 200 {ok:true, status:200}');
    eq(r.body?.result?.echo, `POST /rooms/${room.id}/items/42/pin`, "the app's own JSON comes back as result");
    let calls = await callsOf(acts);
    eq(calls.length, n0 + 1, 'exactly one upstream call');
    let last = calls[calls.length - 1];
    eq([last.method, last.url], ['POST', `/rooms/${room.id}/items/42/pin`], 'POST /rooms/<THIS room>/items/42/pin');
    eq([last.cookie, last.authorization, last.origin], [null, null, null], 'no cookie, no authorization, no origin reached the app');
    eq([last.contentType, last.body], [null, ''], 'no body, no content-type (the verb declares no input)');
    r = await call(A(), { json: { name: 'unpin', params: { id: 7 } } });
    calls = await callsOf(acts);
    last = calls[calls.length - 1];
    eq([r.status, last.method, last.url], [200, 'DELETE', `/rooms/${room.id}/items/7/pin`], 'unpin with an integer id: DELETE .../items/7/pin');
    r = await call(A(), {
      json: { name: 'note', params: { id: 'ticket' }, input: { text: 'hi', rating: 'up', urgent: true, secret: 'x', by: 'eve', flaggedBy: 'mallory', roomId: room2.id } },
    });
    calls = await callsOf(acts);
    last = calls[calls.length - 1];
    eq(r.status, 200, 'note (a verb with declared input): 200');
    eq(
      [last.contentType, JSON.parse(last.body || 'null')],
      ['application/json', { text: 'hi', rating: 'up', urgent: true }],
      'its JSON body carries ONLY the declared keys: undeclared ones (secret, and the actor/room fields) dropped',
    );
    r = await call(A(), { json: { name: 'note', params: { id: '2' } } });
    calls = await callsOf(acts);
    last = calls[calls.length - 1];
    eq([r.status, last.body], [200, '{}'], 'declared input, none sent: an empty JSON object');
    n0 = await upstream();
    r = await call(A(), { json: { name: 'note', params: { id: '1' }, input: { text: 'x'.repeat(2001) } } });
    eq([r.status, r.body?.field], [413, 'input.text'], 'an oversized comment (2001 characters): 413, never truncated');
    r = await call(A(), { json: { name: 'note', params: { id: '1' }, input: { text: 'x'.repeat(2000) } } });
    eq(r.status, 200, 'exactly 2000 characters: 200');
    n0 += 1;
    r = await call(A(), { json: { name: 'note', params: { id: '1' }, input: { text: '\u20ac'.repeat(2000), rating: '\u20ac'.repeat(2000), urgent: false } } });
    eq([r.status, r.body?.field], [413, 'input'], 'a body over 8 KB (two 2000-char strings of 3-byte characters, each under the per-string cap): 413');
    r = await call(A(), { json: { name: 'note', params: { id: '1' }, input: { text: { nested: 1 } } } });
    eq([r.status, r.body?.field], [400, 'input.text'], 'a non-scalar value: 400');
    r = await call(A(), { json: { name: 'note', params: { id: '1' }, input: ['hi'] } });
    eq([r.status, r.body?.field], [400, 'input'], 'input as an array: 400');
    eq(await upstream(), n0, 'none of the refused ones reached the app');

    console.log('\n[the app\'s answer]');
    r = await call(A(), { json: { name: 'fail' } });
    eq([r.status, r.body?.ok, r.body?.status, r.body?.error], [409, false, 409, 'nope'], "an app 409 passes through with the app's own error");
    r = await call(A(), { json: { name: 'deny' } });
    eq([r.status, r.body?.status], [502, 401], "an app 401 is 502 (never read as the room page's login lapsing), status says 401");

    console.log('\n[logged]');
    await sleep(100);
    ok(new RegExp(`panel action: \\S+ room ${room.id} app acts panel ${pActs.id} action pin params \\{"id":"42"\\} -> 200 \\(app 200\\)`).test(engineLog), 'one log line: user, room, app, panel, action, params, status, app status');
    ok(/panel action: .* app acts .* action wipe .* -> 403/.test(engineLog), 'a refused action is logged too');

    console.log('\n[frozen at registration: an added action holds the app until approved]');
    const t2 = tool('acts', [...ACTS_VERBS.filter((v) => v.name !== 'wipe'), verb('wipe', 'POST /rooms/:roomId/wipe')]);
    writeFileSync(join(rootActs, 'tool.json'), JSON.stringify(t2, null, 2));
    n0 = await upstream();
    r = await call(A(), { json: { name: 'wipe' } });
    eq([r.status, r.body?.error], [409, 'held'], 'tool.json now marks wipe panel: the app is HELD (409), wipe is not allowed');
    r = await call(A(), { json: { name: 'pin', params: { id: '1' } } });
    eq([r.status, r.body?.error], [409, 'held'], 'and while held NO action runs, not even pin');
    eq(await upstream(), n0, 'nothing reached the app');
    r = await call('/api/apps/acts/diff');
    eq(r.body?.diff?.actions, { added: ['wipe'], removed: [], changed: [] }, 'the Approve diff names the new panel action');
    const sha = createHash('sha256').update(readFileSync(join(rootActs, 'tool.json'))).digest('hex');
    r = await call('/api/apps/acts/approve', { json: { expected_sha256: sha } });
    eq(r.status, 200, 'a person approves');
    r = await call(A(), { json: { name: 'wipe' } });
    eq(r.status, 200, 'now wipe runs');

    console.log('\n[a stopped app]');
    children[0].kill('SIGKILL');
    await sleep(300);
    r = await call(A(), { json: { name: 'pin', params: { id: '1' } } });
    ok(r.status === 503 || r.status === 502, `the app is gone: ${r.status} (503 not running / 502 unverified), answered, never thrown`);
    ok(engine.exitCode === null, 'the engine is still running');
    void other;
  } catch (e) {
    failed++;
    failures.push(String(e?.stack ?? e));
    console.log(`  X threw: ${e?.stack ?? e}`);
  } finally {
    if (engine) {
      engine.kill('SIGKILL');
      await sleep(200);
    }
    for (const c of children) {
      if (c.exitCode === null && c.signalCode === null) {
        c.kill('SIGKILL');
      }
    }
    await sleep(100);
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
