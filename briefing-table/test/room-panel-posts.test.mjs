/**
 * PANEL ACTIONS POST TO THE ROOM through a real scratch engine [ticket]
 * (the design notes §4.4, amendment "panel actions post to the
 * room"; Owner 2026-09-30: "the user clicked, entered the info and hit submit —
 * that is the consent; they shouldn't have to hit send").
 *
 *   - registration: `postsToRoom` on a non-panel verb, on a GET panel verb, or
 *     not a boolean is a problem (400);
 *   - a verb declared `"postsToRoom": true` whose call succeeds and whose app
 *     answers `roomLine` posts exactly ONE chat line, author `user`, meta
 *     {via_app, via_app_name, action, links?}, to the lead; never parsed (a
 *     leading `/archive` is text, not a command);
 *   - an undeclared verb's roomLine is ignored; a failed call posts nothing;
 *     no roomLine = nothing, no warning;
 *   - text over 1000 characters, an empty text, or a bad link: NOTHING posted,
 *     the action still 200 ok:true with a `warning`; controls are stripped;
 *   - a bearer never gets there (403); a held app (tool.json gained
 *     postsToRoom) never runs the action (409) and the Approve diff names the
 *     new permission; an unregistered app never runs it either;
 *   - a room with no lead: the line is still the person's record, to_user.
 *
 * TO THE REQUESTER, WITH DATA [ticket] (a second app, "asker"):
 *   - `postsToRoom` as an object {to: lead|requester, data?}: an unknown key,
 *     another `to`, a non-boolean data, {} are 400; so is the object on a GET
 *     or a non-panel verb; the Approve diff carries posts.how / posts.changed
 *     and Settings → Apps words them (web/app-status.mjs diffLines, the
 *     shipped code);
 *   - roomLine.to accepted for a live member seat this app posted a tool line
 *     FOR here within 14 days: addressed to it, delivered to it alone (read
 *     records, the fabric copy — a stub fabric records /send), the lead not
 *     told; refused (fallback + warning) for no evidence, evidence 15 days
 *     old (the row's ts moved back in the table), evidence from ANOTHER app,
 *     a seat not live, another room's seat (by handle and by id), a list;
 *     ignored when the pinned `to` is not "requester";
 *   - roomLine.data: kept in meta.app_data, never in the body (room.js never
 *     names it), carried by the fabric copy as the labeled json fence, a
 *     backtick inside it escaped; refused when over 4096 bytes, not an
 *     object, or undeclared.
 *
 * The fake app is a CHILD PROCESS with cwd = its tool root, writing its own
 * pid + port into status/app.json (the room-panel-actions.test pattern).
 * Linux only (verifyEndpoint reads /proc).
 *
 * SAFETY: scratch engine P(284), dead broker P(285) (nothing may listen),
 * stub fabric P(312) (stands in for :8204: /threads + /send recorded,
 * everything else 404); the fake apps take ephemeral ports. childEnv() scrubs
 * PTY_BROKER_ and HARBOR_WB_ keys; NATS off. Live session rows are seeded
 * through the store (test/rooms-routes.seed.ts) after boot. Temp dirs
 * removed, children killed.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import Database from 'better-sqlite3';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(284);
const DEAD_BROKER_PORT = P(285);
const FABRIC_PORT = P(312); // the stub fabric — NOT 8204 (the real one)
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'room-panel-posts-test-token';

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
async function call(path, { method, json, as = 'person', headers = {} } = {}) {
  const h = { ...(as === 'person' ? { cookie } : as === 'agent' ? { authorization: `Bearer ${TOKEN}` } : {}), ...headers };
  const init = { method: method ?? (json === undefined ? 'GET' : 'POST'), headers: h };
  if (json !== undefined) {
    h['content-type'] ??= 'application/json';
    init.body = JSON.stringify(json);
  }
  const res = await fetch(BASE + path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}

/* The fake app answers every action 200 with `roomLine` = JSON.parse(input
   `line`) when the test sent one; `.../fail` answers 409 (with a roomLine,
   which must be ignored). A roomLine.data of {fill: {code, n}} is expanded
   HERE to {d: <n copies of that character>}, so a payload bigger than the
   action's own input cap can be answered. No regex, no backslash: a
   template string. */
const STUB_SRC = `
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const srv = createServer((req, res) => {
  const u = req.url ?? '';
  if (u.startsWith('/health')) return json(res, 200, { ok: true });
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    let b = {};
    try { b = JSON.parse(raw || '{}'); } catch {}
    const out = { ok: true, did: req.method + ' ' + u };
    if (typeof b.line === 'string') out.roomLine = JSON.parse(b.line);
    const f = out.roomLine && out.roomLine.data && out.roomLine.data.fill;
    if (f && typeof f === 'object') out.roomLine.data = { d: String.fromCharCode(f.code).repeat(f.n) };
    if (u.endsWith('/fail')) return json(res, 409, { ok: false, error: 'nope', roomLine: out.roomLine });
    return json(res, 200, out);
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

const LINE_INPUT = { line: 'string' };
const verb = (name, http, x = {}) => ({
  name,
  class: x.class ?? 'mutate',
  call: { http },
  ...(x.panel === false ? {} : { panel: true }),
  ...(x.posts !== undefined ? { postsToRoom: x.posts } : {}),
  ...(x.input === null ? {} : { input: x.input ?? LINE_INPUT }),
});
const tool = (slug, name, verbs) => ({
  contract: 'tool/draft-0',
  name,
  slug,
  version: '0.1.0',
  description: `${slug}.`,
  access: 'shared',
  endpoint: { bind: '127.0.0.1', discover: 'status/app.json#port' },
  verbs,
  panels: [{ title: name, icon: 'image', view: 'GET /rooms/:roomId/view', scripts: true }],
  links: { 'review/:n': { label: 'Review', view: 'GET /rooms/:roomId/review/:n' } },
});
const POSTER_VERBS = [
  verb('submit', 'POST /rooms/:roomId/submit', { posts: true }),
  verb('quiet', 'POST /rooms/:roomId/quiet'),
  verb('submitfail', 'POST /rooms/:roomId/fail', { posts: true }),
];

/* [ticket] the second app: every combination of the object form */
const ASKER_VERBS = [
  verb('ask', 'POST /rooms/:roomId/ask', { posts: { to: 'requester', data: true } }),
  verb('askplain', 'POST /rooms/:roomId/askplain', { posts: { to: 'requester' } }),
  verb('leadonly', 'POST /rooms/:roomId/leadonly', { posts: true }),
  verb('leaddata', 'POST /rooms/:roomId/leaddata', { posts: { to: 'lead', data: true } }),
];

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

const metaOf = (e) => (typeof e?.meta === 'string' ? JSON.parse(e.meta) : e?.meta ?? null);

async function run() {
  if (process.platform !== 'linux') {
    console.log('room-panel-posts.test: needs /proc (linux) — the engine refuses every tool endpoint elsewhere');
    process.exit(1);
  }
  for (const p of [PORT, DEAD_BROKER_PORT, FABRIC_PORT]) {
    await assertFree(p, 'room-panel-posts.test.mjs');
  }
  /* The stub fabric: a room's thread opens, every /send is recorded (the
     fabric channel copy of a room line, ref room:<id>/line:<n>). */
  const sends = [];
  const fabricStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const json = (code, body) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const path = (req.url ?? '').split('?')[0];
      if (path === '/threads' && req.method === 'POST') return json(200, { thread: 't-posts' });
      if (path === '/send' && req.method === 'POST') {
        try {
          sends.push(JSON.parse(raw));
        } catch {
          /* not json */
        }
        return json(200, { id: `env-${sends.length}` });
      }
      return json(404, { error: 'not-here' });
    });
  });
  await new Promise((r) => fabricStub.listen(FABRIC_PORT, '127.0.0.1', r));
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-panel-posts-'));
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
  const rootPoster = writeTool('poster', tool('poster', 'Poster', POSTER_VERBS));
  const rootBad1 = writeTool('bad-nopanel', tool('bad-nopanel', 'B1', [verb('go', 'POST /rooms/:roomId/go', { panel: false, posts: true })]));
  const rootBad2 = writeTool('bad-get', tool('bad-get', 'B2', [verb('go', 'GET /rooms/:roomId/go', { class: 'read', posts: true, input: null })]));
  const rootBad3 = writeTool('bad-flag', tool('bad-flag', 'B3', [verb('go', 'POST /rooms/:roomId/go', { posts: 'yes' })]));
  const rootAsker = writeTool('asker', tool('asker', 'Asker', ASKER_VERBS));
  const badObj = [
    [{ to: 'requester', who: 'bee' }, 'an unknown key', /only "to" and "data"/],
    [{ to: 'everyone' }, 'another `to`', /"postsToRoom".to is "lead" or "requester"/],
    [{ to: 'requester', data: 'yes' }, 'a non-boolean data', /"postsToRoom".data is true or false/],
    [{}, 'an empty object', /"postsToRoom".to is/],
    [['requester'], 'a list', /"postsToRoom" is true, false, or/],
  ].map(([posts, why, re], i) => [writeTool(`bad-obj-${i}`, tool(`bad-obj-${i}`, `BO${i}`, [verb('go', 'POST /rooms/:roomId/go', { posts })])), why, re]);
  const rootBadGetObj = writeTool('bad-get-obj', tool('bad-get-obj', 'BG', [verb('go', 'GET /rooms/:roomId/go', { class: 'read', posts: { to: 'requester' }, input: null })]));
  const rootBadNoPanelObj = writeTool('bad-nopanel-obj', tool('bad-nopanel-obj', 'BN', [verb('go', 'POST /rooms/:roomId/go', { panel: false, posts: { to: 'lead' } })]));

  let engine = null;
  let engineLog = '';
  try {
    await startApp(stubPath, rootPoster);
    await startApp(stubPath, rootAsker);
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
        HARBOR_WB_FABRIC_URL: `http://127.0.0.1:${FABRIC_PORT}`,
        HARBOR_WB_ROOM_FABRIC: '1',
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

    console.log('\n[registration: postsToRoom only on a qualifying panel verb]');
    for (const [root, why] of [
      [rootBad1, 'postsToRoom on a verb that is not a panel verb'],
      [rootBad2, 'postsToRoom on a GET panel verb'],
      [rootBad3, 'postsToRoom not a boolean'],
    ]) {
      const r = await call('/api/apps', { json: { root } });
      ok(r.status === 400 && /postsToRoom/.test(r.body?.error ?? ''), `${why}: 400, naming postsToRoom (${r.body?.error})`);
    }
    let r = await call('/api/apps', { json: { root: rootPoster } });
    eq(r.status, 200, 'poster (submit + submitfail postsToRoom, quiet not): registered');

    const room = (await call('/api/rooms', { json: { name: 'Posts' } })).body;
    const lonely = (await call('/api/rooms', { json: { name: 'No lead' } })).body;
    eq((await call(`/api/rooms/${room.id}/seats`, { json: { project: 'auriga' } })).status, 200, 'the room has a seat');
    const full = (await call(`/api/rooms/${room.id}`)).body;
    const leadSeat = full?.room?.lead_seat ?? null;
    ok(!!leadSeat, `the first seat is the lead (${leadSeat})`);
    for (const rm of [room, lonely]) {
      eq((await call(`/api/rooms/${rm.id}/apps`, { json: { slug: 'poster' } })).status, 200, `poster added to ${rm.name}`);
    }
    const pid = async (rm) => (await call(`/api/rooms/${rm.id}/panels`)).body.panels.find((p) => p.app_slug === 'poster').id;
    const pRoom = await pid(room);
    const pLonely = await pid(lonely);
    const A = (rm = room, p = pRoom) => `/api/rooms/${rm.id}/panels/${p}/action`;
    const chats = async (rm = room) => (await call(`/api/rooms/${rm.id}/line`)).body.entries.filter((e) => e.kind === 'chat');
    const line = (obj) => ({ line: JSON.stringify(obj) });

    console.log('\n[a declared verb: exactly one line, as the person, via the app]');
    let n0 = (await chats()).length;
    r = await call(A(), { json: { name: 'submit', input: line({ text: '3 rated: 2 up, 1 down', links: [{ label: '#2 shoes', path: 'review/2' }] }) } });
    eq([r.status, r.body?.ok, r.body?.status], [200, true, 200], 'submit: 200 {ok:true}');
    ok(typeof r.body?.line?.id === 'number' && Array.isArray(r.body?.entries), `the answer carries line.id (${r.body?.line?.id}) and the written entries`);
    ok(r.body?.warning === undefined, 'no warning');
    let cs = await chats();
    eq(cs.length, n0 + 1, 'exactly one new chat line');
    let e = cs[cs.length - 1];
    let m = metaOf(e);
    eq([e.id, e.author, e.author_seat ?? null, e.body], [r.body?.line?.id, 'user', null, '3 rated: 2 up, 1 down'], "author = the user (a human line's author), the app's text");
    eq([m?.via_app, m?.via_app_name, m?.action], ['poster', 'Poster', 'submit'], 'meta {via_app, via_app_name, action}');
    eq([m?.links?.length, m?.links?.[0]?.tool, m?.links?.[0]?.ref, m?.links?.[0]?.label, m?.links?.[0]?.view_path], [1, 'poster', 'review/2', '#2 shoes', 'review/2'], "the link resolved like a tool line's (this app's own pattern)");
    eq([e.target ?? null, e.target_seat], [null, leadSeat], 'un-addressed: it goes to the lead, like a human line');
    ok(m?.tool === undefined, 'not a tool line (no meta.tool): "To me" counts it as the user\'s');
    ok(new RegExp(`panel action: \\S+ room ${room.id} app poster panel ${pRoom} action submit params - -> 200 \\(app 200\\) line #${e.id}`).test(engineLog), 'the action log line names the posted line');

    console.log('\n[never parsed: the app cannot issue a room command or pick recipients]');
    r = await call(A(), { json: { name: 'submit', input: line({ text: '/archive' }) } });
    cs = await chats();
    e = cs[cs.length - 1];
    eq([r.status, e.body, e.kind, e.target_seat], [200, '/archive', 'chat', leadSeat], '"/archive" is posted as chat text, to the lead');
    eq((await call(`/api/rooms/${room.id}`)).body?.room?.state, 'open', 'and the room is NOT archived');
    r = await call(A(), { json: { name: 'submit', input: line({ text: '@room hi everyone' }) } });
    cs = await chats();
    eq([cs[cs.length - 1].target ?? null, cs[cs.length - 1].target_seat], [null, leadSeat], '"@room …" does not widen it: still to the lead only');

    console.log('\n[plain text]');
    const ESC = String.fromCharCode(27);
    r = await call(A(), { json: { name: 'submit', input: line({ text: `  a${ESC}[31mb\r\nc${String.fromCharCode(7)}  ` }) } });
    cs = await chats();
    eq([r.status, cs[cs.length - 1].body], [200, 'a[31mb\nc'], 'controls (ESC, BEL) dropped, CRLF -> LF, trimmed');
    n0 = cs.length;
    r = await call(A(), { json: { name: 'submit', input: line({ text: 'x'.repeat(1000) }) } });
    cs = await chats();
    eq([r.status, cs.length, cs[cs.length - 1].body.length], [200, n0 + 1, 1000], 'exactly 1000 characters: posted, whole');

    console.log('\n[never a failure: a bad roomLine posts nothing, the action still ok]');
    n0 = (await chats()).length;
    for (const [rl, why, re] of [
      [{ text: 'x'.repeat(1001) }, 'text of 1001 characters', /1001 characters/],
      [{ text: `  ${ESC}  ` }, 'a text that is empty once plain', /empty/],
      [{ text: 42 }, 'text not a string', /string/],
      ['just a string', 'roomLine not an object', /roomLine is/],
      [{ text: 'ok', links: [{ path: 'nope/1' }] }, 'a link matching none of its patterns', /links\[0\]/],
      [{ text: 'ok', links: [{ path: 'review/2', label: 'x'.repeat(81) }] }, 'a link label over 80', /label/],
      [{ text: 'ok', links: Array.from({ length: 9 }, () => ({ path: 'review/1' })) }, 'nine links', /at most 8/],
    ]) {
      r = await call(A(), { json: { name: 'submit', input: line(rl) } });
      ok(r.status === 200 && r.body?.ok === true && re.test(r.body?.warning ?? '') && r.body?.line === undefined, `${why}: 200 ok:true, warning (${r.body?.warning})`);
    }
    eq((await chats()).length, n0, 'none of those posted a line');
    ok(/action submit params - -> 200 \(app 200\) line not posted/.test(engineLog), 'logged as "line not posted"');
    r = await call(A(), { json: { name: 'submit' } });
    eq([r.status, r.body?.ok, r.body?.warning, r.body?.line], [200, true, undefined, undefined], 'no roomLine at all: nothing posted, no warning');
    r = await call(A(), { json: { name: 'quiet', input: line({ text: 'sneaky' }) } });
    eq([r.status, r.body?.line, r.body?.warning], [200, undefined, undefined], 'an undeclared verb answering roomLine: ignored, silently');
    r = await call(A(), { json: { name: 'submitfail', input: line({ text: 'on failure' }) } });
    eq([r.status, r.body?.ok, r.body?.line], [409, false, undefined], 'a declared verb whose app FAILED (409): nothing posted');
    eq((await chats()).length, n0, 'still no new line');

    console.log('\n[who: a bearer never reaches it]');
    r = await call(A(), { as: 'agent', json: { name: 'submit', input: line({ text: 'from a bearer' }) } });
    eq([r.status, r.body?.field], [403, 'credential'], 'a bearer: 403');
    eq((await chats()).length, n0, 'no line');

    console.log('\n[a room with no lead: still the person\'s record]');
    r = await call(A(lonely, pLonely), { json: { name: 'submit', input: line({ text: 'nobody to tell' }) } });
    const lc = await chats(lonely);
    e = lc[lc.length - 1];
    m = metaOf(e);
    eq([r.status, lc.length, e?.author, e?.body, e?.target_seat ?? null, m?.to_user, m?.via_app], [200, 1, 'user', 'nobody to tell', null, true, 'poster'], 'posted, addressed to the person, no seat');

    console.log('\n[a held app: adding postsToRoom is a permission change]');
    const t2 = tool('poster', 'Poster', [...POSTER_VERBS.filter((v) => v.name !== 'quiet'), verb('quiet', 'POST /rooms/:roomId/quiet', { posts: true })]);
    writeFileSync(join(rootPoster, 'tool.json'), JSON.stringify(t2, null, 2));
    n0 = (await chats()).length;
    r = await call(A(), { json: { name: 'submit', input: line({ text: 'while held' }) } });
    eq([r.status, r.body?.error], [409, 'held'], 'tool.json now lets quiet post: the app is HELD, submit does not run');
    eq((await chats()).length, n0, 'nothing posted while held');
    r = await call('/api/apps/poster/diff');
    eq(r.body?.diff?.posts, { added: ['quiet'], removed: [], how: { quiet: { to: 'lead', data: false } }, changed: [] }, 'the Approve diff names the new permission (posts.added; how = the plain form)');
    eq(r.body?.diff?.actions, { added: [], removed: [], changed: [] }, 'and it is not reported as a changed method/path');
    const sha = createHash('sha256').update(readFileSync(join(rootPoster, 'tool.json'))).digest('hex');
    eq((await call('/api/apps/poster/approve', { json: { expected_sha256: sha } })).status, 200, 'a person approves');
    r = await call(A(), { json: { name: 'quiet', input: line({ text: 'now allowed' }) } });
    cs = await chats();
    eq([r.status, cs.length, cs[cs.length - 1].body, metaOf(cs[cs.length - 1])?.action], [200, n0 + 1, 'now allowed', 'quiet'], 'now quiet posts its line');

    console.log('\n[an unregistered app: the action never runs]');
    eq((await call('/api/apps/poster/unregister', { json: {} })).status, 200, 'a person unregisters it');
    n0 = (await chats()).length;
    r = await call(A(), { json: { name: 'submit', input: line({ text: 'after unregister' }) } });
    eq([r.status, r.body?.error], [409, 'not-registered'], '409 not-registered');
    eq((await chats()).length, n0, 'no line');

    /* ============================ [ticket] to the requester, with data ==== */
    console.log('\n[ticket registration: postsToRoom as an object]');
    for (const [root, why, re] of badObj) {
      const rb = await call('/api/apps', { json: { root } });
      ok(rb.status === 400 && re.test(rb.body?.error ?? ''), `${why}: 400, naming it (${rb.body?.error})`);
    }
    r = await call('/api/apps', { json: { root: rootBadGetObj } });
    ok(r.status === 400 && /postsToRoom needs a mutate verb/.test(r.body?.error ?? ''), `the object form on a GET verb: 400 (${r.body?.error})`);
    r = await call('/api/apps', { json: { root: rootBadNoPanelObj } });
    ok(r.status === 400 && /only a "panel": true verb/.test(r.body?.error ?? ''), `the object form on a verb that is not a panel verb: 400 (${r.body?.error})`);
    r = await call('/api/apps', { json: { root: rootAsker } });
    eq(r.status, 200, 'asker (requester+data, requester, true, lead+data): registered');

    console.log('\n[setup: live seats, and the evidence (tool lines)]');
    const seed = async (plan) => {
      const out = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
      if (out.code !== 0) {
        throw new Error(`seed failed: ${out.err}`);
      }
      return JSON.parse(out.out.trim().split('\n').pop());
    };
    const AG = ['leader', 'bee', 'old', 'gone', 'none', 'far'];
    const pane = (a) => `recipe:rec-${a}`;
    const seeded = await seed({
      recipes: AG.map((a) => ({ id: `rec-${a}`, name: a, projectDir: `/srv/x/${a}`, vendor: 'claude-code', agent: a })),
      sessions: AG.map((a) => ({ paneid: pane(a), recipe_id: `rec-${a}`, vendor: 'claude-code', agent: a, state: 'live' })),
      rooms: [
        { name: 'Requests', seats: ['leader', 'bee', 'old', 'gone', 'none'].map((a) => ({ handle: a, recipe_id: `rec-${a}`, occupant: pane(a) })) },
        { name: 'Far away', seats: [{ handle: 'far', recipe_id: 'rec-far', occupant: pane('far') }] },
      ],
    });
    const [RQ, FAR] = seeded.rooms;
    const S = RQ.seats;
    eq((await call(`/api/rooms/${RQ.id}`)).body?.room?.lead_seat, S.leader, 'setup: @leader leads Requests');
    for (const rm of [RQ, FAR]) {
      eq((await call(`/api/rooms/${rm.id}/apps`, { json: { slug: 'asker' } })).status, 200, `setup: asker added to ${rm.name}`);
    }
    const pAsk = (await call(`/api/rooms/${RQ.id}/panels`)).body.panels.find((p) => p.app_slug === 'asker').id;
    const act = (name, rl) => call(`/api/rooms/${RQ.id}/panels/${pAsk}/action`, { json: { name, input: line(rl) } });
    const toolLine = (roomId, fromPane, slug, forWho) =>
      call(`/api/rooms/${roomId}/line`, { as: 'agent', json: { text: 'on it', from: { paneid: fromPane }, tool: { slug, for: forWho } } });
    const tl = {};
    for (const h of ['bee', 'old', 'gone']) {
      tl[h] = await toolLine(RQ.id, pane('leader'), 'asker', `@${h}`);
      eq([tl[h].status, metaOf(tl[h].body?.entries?.[0])?.tool, metaOf(tl[h].body?.entries?.[0])?.for], [200, 'asker', S[h]], `evidence: asker's tool line FOR @${h}`);
    }
    eq((await toolLine(RQ.id, pane('leader'), 'other-app', '@none')).status, 200, 'a tool line for @none, from ANOTHER app');
    eq((await toolLine(FAR.id, pane('far'), 'asker', '@far')).status, 200, "asker's tool line for @far, in the OTHER room");
    const db = new Database(dbPath);
    db.pragma('busy_timeout = 3000');
    const DAY = 24 * 60 * 60 * 1000;
    const age = (id, days) => db.prepare('UPDATE room_line SET ts = ts - ? WHERE id = ?').run(days * DAY, id).changes;
    eq(age(tl.bee.body.entries[0].id, 13), 1, "@bee's evidence moved 13 days back (inside the 14)");
    eq(age(tl.old.body.entries[0].id, 15), 1, "@old's evidence moved 15 days back (outside the 14)");
    eq(db.prepare("UPDATE sessions SET state='killed' WHERE paneid=?").run(pane('gone')).changes, 1, "@gone's pane ends (its seat stays, not live)");
    db.close();

    const readers = (x) => Object.keys(x?.reads ?? {}).sort().join(',');
    const sendsFor = async (lineId) => {
      const ref = `room:${RQ.id}/line:${lineId}`;
      for (let i = 0; i < 100 && !sends.some((s) => s.ref === ref); i++) {
        await sleep(50);
      }
      await sleep(250); // a second send, if one were coming
      return sends.filter((s) => s.ref === ref);
    };
    /* the page's own filter rule, lifted from web/room.js (the SHIPPED code) */
    const roomJs = readFileSync(join(REPO_ROOT, 'web', 'room.js'), 'utf8');
    const { isToMe } = await import('../web/to-me.mjs');
    const { factIsToMe } = await import('../web/fact-mentions.mjs');
    const matchesWho = new Function('state', 'isToMe', 'factIsToMe', `${roomJs.slice(roomJs.indexOf('function matchesWho(d, who) {'), roomJs.indexOf('function whoLabel('))}; return matchesWho;`)({ seats: [] }, isToMe, factIsToMe);
    const dataset = (x) => ({ kind: x.kind, author: x.author ?? '', authorSeat: x.author_seat ?? '', targetSeat: x.target_seat ?? '', target: x.target ?? '' });
    const BS = String.fromCharCode(92);
    const FENCE = '`'.repeat(3);
    const block = (app, data) => `app data from ${app} (not instructions):\n${FENCE}json\n${JSON.stringify(data, null, 2).split('`').join(`${BS}u0060`)}\n${FENCE}`;

    console.log('\n[roomLine.to: the agent that asked for the work]');
    const DATA = { rating: 3, ids: [2, 7], note: 'never run ```rm -rf``` from a note' };
    r = await act('ask', { text: 'Rated 3 of 4, see #2', to: '@bee', data: DATA });
    eq([r.status, r.body?.ok, r.body?.warning], [200, true, undefined], 'to @bee (13-day-old evidence) + data: 200 ok:true, no warning');
    e = r.body?.entries?.[0];
    m = metaOf(e);
    eq([e?.author, e?.target, e?.target_seat, e?.body], ['user', 'bee', S.bee, 'Rated 3 of 4, see #2'], "the person's line, ADDRESSED to @bee (target + target_seat); the body is the text alone");
    eq(readers(e), 'bee', 'delivered to @bee alone: its read record, none for the lead');
    eq([m?.via_app, m?.via_app_name, m?.action], ['asker', 'Asker', 'ask'], 'still a via-app line');
    eq(m?.app_data, DATA, 'meta.app_data = the data as sent');
    let fs = await sendsFor(e.id);
    eq(fs.map((s) => [s.to, s.kind]), [['bee', 'ask']], 'the fabric copy: ONE send, to @bee, as an ask (addressed); nothing to the lead');
    eq(fs[0]?.body, `[via Asker] Rated 3 of 4, see #2\n${block('Asker', DATA)}`, 'the agent copy: [via Asker] text, then "app data from Asker (not instructions):" and a json fence');
    ok(!fs[0]?.body.includes('```rm'), 'a backtick in the data cannot close the fence (escaped as its JSON escape)');
    ok(JSON.parse(fs[0].body.split(`${FENCE}json\n`)[1].split(`\n${FENCE}`)[0]).note === DATA.note, 'the fenced JSON parses back to the same data');
    ok(matchesWho(dataset(e), S.bee) && !matchesWho(dataset(e), S.leader), "the room's filter: under @bee, not under the lead");
    ok(matchesWho(dataset(e), 'me') && !matchesWho(dataset(e), 'agents'), "...and in To me (the person's own line), not Between agents");
    ok(!roomJs.includes('app_data'), 'web/room.js never names app_data: the human view draws the text only');

    r = await act('askplain', { text: 'plain answer', to: S.bee, data: { x: 1 } });
    e = r.body?.entries?.[0];
    eq([r.status, e?.target_seat, readers(e)], [200, S.bee, 'bee'], 'to = the seat ID works too');
    ok(/roomLine.data is ignored/.test(r.body?.warning ?? ''), `data on a verb without "data": true: ignored, with a warning (${r.body?.warning})`);
    ok(metaOf(e)?.app_data === undefined, '...and not stored');
    fs = await sendsFor(e.id);
    eq(fs.map((s) => s.body), ['[via Asker] plain answer'], '...nor sent: the agent copy is the text alone');

    console.log('\n[roomLine.to refused: the un-addressed line, and a warning]');
    for (const [to, why, re] of [
      ['@none', 'a live seat with a tool line from ANOTHER app only', /@none has not asked this app for work here/],
      ['@old', 'evidence 15 days old', /@old has not asked this app.*last 14 days/],
      ['@gone', 'a seat that is not live', /@gone is not live/],
      ['@far', "another room's seat, by handle", /names no seat in this room/],
      [FAR.seats.far, "another room's seat, by id", /names no seat in this room/],
      ['@nobody', 'no such seat', /names no seat in this room/],
      [['@bee'], 'a list (even of one good seat)', /is ONE seat .* not a list/],
      [42, 'not a string', /is a seat handle or a seat id/],
    ]) {
      r = await act('ask', { text: `fallback: ${why}`, to });
      e = r.body?.entries?.[0];
      ok(r.status === 200 && r.body?.ok === true && re.test(r.body?.warning ?? '') && /went un-addressed/.test(r.body?.warning ?? ''), `${why}: 200 ok:true, warning (${r.body?.warning})`);
      eq([e?.body, e?.target ?? null, e?.target_seat, readers(e)], [`fallback: ${why}`, null, S.leader, 'leader'], `${why}: posted un-addressed, to the lead`);
    }

    console.log('\n[roomLine.to ignored: the pinned `to` is not "requester"]');
    for (const v of ['leadonly', 'leaddata']) {
      r = await act(v, { text: `${v} names bee`, to: '@bee' });
      e = r.body?.entries?.[0];
      ok(r.status === 200 && /roomLine.to is ignored/.test(r.body?.warning ?? ''), `${v}: ok, warning (${r.body?.warning})`);
      eq([e?.target ?? null, e?.target_seat, readers(e)], [null, S.leader, 'leader'], `${v}: un-addressed, to the lead`);
    }

    console.log('\n[roomLine.data]');
    r = await act('leaddata', { text: 'to the lead, with data', data: { k: 'v' } });
    e = r.body?.entries?.[0];
    eq([r.status, r.body?.warning, e?.target_seat, metaOf(e)?.app_data], [200, undefined, S.leader, { k: 'v' }], '"to": "lead" + data: to the lead, data kept');
    fs = await sendsFor(e.id);
    eq(fs.map((s) => [s.to, s.body]), [['leader', `[via Asker] to the lead, with data\n${block('Asker', { k: 'v' })}`]], "...and the lead's copy carries the block");
    r = await act('leaddata', { text: 'exactly 4096', data: { fill: { code: 120, n: 4096 - 8 } } }); // {"d":"xx…"} = 8 + n bytes
    eq([r.status, r.body?.warning, metaOf(r.body?.entries?.[0])?.app_data?.d?.length], [200, undefined, 4088], 'exactly 4096 bytes as JSON: kept');
    for (const [data, why, re] of [
      [{ fill: { code: 120, n: 4089 } }, '4097 bytes', /4097 bytes as JSON .max 4096./],
      [{ fill: { code: 233, n: 2100 } }, '2108 characters but 4208 bytes', /4208 bytes/],
      [[1, 2], 'a list', /roomLine.data is a JSON object/],
      ['a string', 'a string', /roomLine.data is a JSON object/],
      [5, 'a number', /roomLine.data is a JSON object/],
    ]) {
      r = await act('leaddata', { text: `data: ${why}`, data });
      e = r.body?.entries?.[0];
      ok(r.status === 200 && r.body?.ok === true && re.test(r.body?.warning ?? '') && /posted without it/.test(r.body?.warning ?? ''), `${why}: ok, warning (${r.body?.warning})`);
      eq([e?.body, metaOf(e)?.app_data], [`data: ${why}`, undefined], `${why}: the line posted, without the data`);
    }
    r = await act('leadonly', { text: 'true, with data', data: { k: 1 } });
    ok(/roomLine.data is ignored/.test(r.body?.warning ?? '') && metaOf(r.body?.entries?.[0])?.app_data === undefined, `"postsToRoom": true + data: ignored, warned (${r.body?.warning})`);
    r = await act('ask', { text: 'both wrong', to: '@nobody', data: [1] });
    ok(/names no seat/.test(r.body?.warning ?? '') && /is a JSON object/.test(r.body?.warning ?? '') && r.body?.warning.includes('; '), `two problems: both named, joined with "; " (${r.body?.warning})`);

    console.log('\n[a changed object form holds the app; the diff says it in words]');
    const asker2 = tool('asker', 'Asker', [
      ...ASKER_VERBS.filter((v) => v.name !== 'askplain'),
      verb('askplain', 'POST /rooms/:roomId/askplain', { posts: { to: 'requester', data: true } }),
      verb('late', 'POST /rooms/:roomId/late', { posts: { to: 'requester', data: true } }),
    ]);
    writeFileSync(join(rootAsker, 'tool.json'), JSON.stringify(asker2, null, 2));
    r = await act('ask', { text: 'while held', to: '@bee' });
    eq([r.status, r.body?.error], [409, 'held'], 'held: the action does not run');
    r = await call('/api/apps/asker/diff');
    eq(
      r.body?.diff?.posts,
      {
        added: ['late'],
        removed: [],
        how: { late: { to: 'requester', data: true } },
        changed: [{ name: 'askplain', from: { to: 'requester', data: false }, to: { to: 'requester', data: true } }],
      },
      'the diff: posts.added + how, posts.changed (from -> to)',
    );
    const { diffLines } = await import(pathToFileURL(join(REPO_ROOT, 'web', 'app-status.mjs')).href);
    const words = diffLines(r.body.diff).filter((l) => l.cls === 'warn').map((l) => l.text);
    ok(words.includes('Panel action "late" may post lines to rooms on your submit, addressed to the agent that requested the work, with a data payload for agents'), 'Settings → Apps words the added one', words);
    ok(
      words.includes('Panel action "askplain" now posts lines to rooms on your submit, addressed to the agent that requested the work, with a data payload for agents (was: addressed to the agent that requested the work, with no data payload)'),
      'and the changed one, with what it was',
      words,
    );
    const sha2 = createHash('sha256').update(readFileSync(join(rootAsker, 'tool.json'))).digest('hex');
    eq((await call('/api/apps/asker/approve', { json: { expected_sha256: sha2 } })).status, 200, 'a person approves');
    r = await act('askplain', { text: 'now with data', to: '@bee', data: { ok: true } });
    eq([r.status, r.body?.warning, r.body?.entries?.[0]?.target_seat, metaOf(r.body?.entries?.[0])?.app_data], [200, undefined, S.bee, { ok: true }], 'askplain now carries data, to @bee');
    ok(engine.exitCode === null, 'the engine is still running');
  } catch (err) {
    failed++;
    failures.push(String(err?.stack ?? err));
    console.log(`  X threw: ${err?.stack ?? err}`);
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
    fabricStub.closeAllConnections?.();
    await new Promise((r) => fabricStub.close(r));
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
