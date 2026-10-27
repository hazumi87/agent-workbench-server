/**
 * AGENT CHAT routes through a real scratch engine [agent chat] (Owner
 * 2026-10-05): the credential gate, the transcript read through the REAL
 * target polarity (a self-hosted `local` target reads the engine's own disk,
 * HARBOR_WB_CLAUDE_PROJECTS), the live tail picking up an appended line, the
 * Codex hook sink feeding the chat log, supported:false in words, and the
 * Scratchpad (list / upload / raw) against a STUB agent-share.
 *
 * The rooms-routes pattern: our own engine on P() ports, a temp mapping db, no
 * broker and no pty (the seeded rows are live in the TABLE only, so a send is
 * refused "not running" - the typer path itself is covered in-process by
 * agent-chat.test.ts with a stub typer).
 *
 * SAFETY: scratch engine P(380), dead broker P(381), stub share P(382), temp
 * table, childEnv(); never :7420/:7430/:8200/:8201/:8204 or the real share.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(380);
const DEAD_BROKER_PORT = P(381);
const SHARE_PORT = P(382);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const SHARE = `http://${HOST}:${SHARE_PORT}`;
const TOKEN = 'agent-chat-test-token';
const NODE = 'testnode';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  + ${msg}`);
  } else {
    failed++;
    console.log(`  X ${msg}`);
  }
}
const eq = (a, b, msg) => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  ok(x === y, x === y ? msg : `${msg} (got ${x}, want ${y})`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, { method, json, bytes, headers = {}, auth = true } = {}) {
  const h = { ...headers };
  if (auth) {
    h.authorization = `Bearer ${TOKEN}`;
  }
  const init = { method: method ?? (json !== undefined || bytes !== undefined ? 'POST' : 'GET'), headers: h };
  if (json !== undefined) {
    h['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  if (bytes !== undefined) {
    init.body = bytes;
  }
  const res = await fetch(BASE + path, init);
  const raw = Buffer.from(await res.arrayBuffer());
  let body = null;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    /* not json */
  }
  return { status: res.status, body, raw, res };
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

/* ------------------------------------------------------ stub agent-share ---- */
const shareFs = new Map(); // folder -> [{name, bytes, mtime}]
let clock = 1_000;
const stub = createServer((req, res) => {
  const u = new URL(req.url ?? '/', SHARE);
  if (req.method === 'GET' && u.pathname === '/api/list') {
    const dir = u.searchParams.get('dir') ?? '';
    if (!shareFs.has(dir)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'no such dir' }));
    }
    const entries = [...shareFs.get(dir)]
      .sort((a, b) => b.mtime - a.mtime)
      .map((f) => ({ name: f.name, path: `${dir}/${f.name}`, type: 'file', size: f.bytes.length, mtime: f.mtime, url: null }));
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ dir, entries }));
  }
  if (req.method === 'POST' && u.pathname === '/api/upload') {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const dir = u.searchParams.get('dir') ?? '';
      if (!shareFs.has(dir)) {
        shareFs.set(dir, []); // the real, patched share makes the folder on first upload
      }
      const body = Buffer.concat(chunks);
      const boundary = /boundary=([^;]+)/.exec(req.headers['content-type'] ?? '')?.[1];
      const headEnd = body.indexOf('\r\n\r\n');
      const filename = /filename="([^"]*)"/.exec(body.subarray(0, headEnd).toString('utf8'))?.[1];
      const end = body.lastIndexOf(Buffer.from(`\r\n--${boundary}--`));
      shareFs.get(dir).push({ name: filename, bytes: body.subarray(headEnd + 4, end), mtime: clock++ });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, saved: [`${dir}/${filename}`] }));
    });
    return;
  }
  const path = decodeURIComponent(u.pathname);
  if (path.startsWith('/raw/')) {
    const ref = path.slice(5);
    const i = ref.lastIndexOf('/');
    const f = shareFs.get(ref.slice(0, i))?.find((x) => x.name === ref.slice(i + 1));
    if (!f) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(f.bytes.length) });
    return res.end(f.bytes);
  }
  res.writeHead(404);
  res.end('Not found');
});

const line = (o) => `${JSON.stringify(o)}\n`;

async function run() {
  for (const p of [PORT, DEAD_BROKER_PORT, SHARE_PORT]) {
    await assertFree(p, 'agent-chat-routes.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-agent-chat-'));
  const dbPath = join(tmpDir, 'mapping.db');
  const projects = join(tmpDir, 'claude-projects');
  let engine = null;
  let engineLog = '';
  await new Promise((r) => stub.listen(SHARE_PORT, HOST, r));
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) {
      throw new Error(`seed failed: ${r.err}`);
    }
  };

  try {
    /* a self-hosted `local` target: pinned to the engine's own node, so the transcript is read from THIS disk */
    const targets = JSON.stringify({ targets: [{ id: 't-self', label: 'self', kind: 'local', broker: 'local', node: NODE }] });
    const PROJECT_DIR = '/srv/x/chatproj';
    const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
    const encodeProjectDir = (d) => d.replace(/[^A-Za-z0-9]/g, '-'); // claude's own rule (contract 5b-fs)
    const tdir = join(projects, encodeProjectDir(PROJECT_DIR));
    mkdirSync(tdir, { recursive: true });
    const tfile = join(tdir, `${SID}.jsonl`);
    writeFileSync(
      tfile,
      line({ type: 'user', uuid: 'u1', timestamp: '2026-10-05T10:00:00Z', message: { content: '<system-reminder>r</system-reminder>hello' } }) +
        line({ type: 'assistant', uuid: 'a1', timestamp: '2026-10-05T10:00:05Z', message: { content: [{ type: 'text', text: 'hi there' }] } }),
    );

    await seed({
      recipes: [
        { id: 'rec-c', name: 'Chat', projectDir: PROJECT_DIR, vendor: 'claude-code', agent: 'chatproj', target: 't-self' },
        { id: 'rec-g', name: 'Gem', projectDir: '/srv/x/gem', vendor: 'gemini-cli', agent: 'gem', target: 't-self' },
        { id: 'rec-s', name: 'Shell', projectDir: '/srv/x/sh', vendor: 'cli-manager', agent: 'sh', target: 't-self' },
        { id: 'rec-x', name: 'Codex', projectDir: '/srv/x/cdx', vendor: 'codex-cli', agent: 'cdx', target: 't-self' },
      ],
    });
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
        HARBOR_WB_CLAUDE_PROJECTS: projects,
        HARBOR_WB_TARGETS: targets,
        HARBOR_WB_AGENT_SHARE_URL: SHARE,
        HARBOR_WB_NODE: NODE,
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
    // live rows AFTER boot (reconcile would sweep them before)
    await seed({
      sessions: [
        { paneid: 'recipe:rec-c#1', recipe_id: 'rec-c', vendor: 'claude-code', agent: 'chatproj', session_id: SID, state: 'live' },
        { paneid: 'recipe:rec-g#1', recipe_id: 'rec-g', vendor: 'gemini-cli', agent: 'gem', state: 'live' },
        { paneid: 'recipe:rec-s#1', recipe_id: 'rec-s', vendor: 'cli-manager', agent: 'sh', state: 'live' },
        { paneid: 'recipe:rec-x#1', recipe_id: 'rec-x', vendor: 'codex-cli', agent: 'cdx', state: 'live' },
      ],
    });
    const C = encodeURIComponent('recipe:rec-c#1');
    const G = encodeURIComponent('recipe:rec-g#1');
    const S = encodeURIComponent('recipe:rec-s#1');
    const X = encodeURIComponent('recipe:rec-x#1');

    console.log('\n[auth]');
    for (const [m, path] of [
      ['GET', `/api/sessions/${C}/chat`],
      ['POST', `/api/sessions/${C}/chat`],
      ['GET', `/api/sessions/${C}/scratchpad`],
      ['POST', `/api/sessions/${C}/scratchpad`],
      ['GET', `/api/sessions/${C}/scratchpad/raw/x.txt`],
    ]) {
      eq((await call(path, { method: m, auth: false, ...(m === 'POST' ? { json: { text: 'x' } } : {}) })).status, 401, `unauthenticated ${m} ${path.replace(C, ':pane')}: 401`);
    }
    eq((await call(`/api/sessions/${C}/chat`, { auth: false, headers: { 'x-forwarded-for': '100.64.0.9' } })).status, 401, 'unauthenticated FORWARDED chat read: 401');

    console.log('\n[GET chat: claude transcript through the self-hosted target]');
    let r = await call(`/api/sessions/${C}/chat`);
    eq([r.status, r.body.supported, r.body.vendor], [200, true, 'claude-code'], 'claude pane: supported');
    eq(r.body.items.map((i) => [i.role, i.text]), [['user', 'hello'], ['agent', 'hi there']], 'the conversation, reminders stripped, oldest first');
    eq(r.body.items[1].ts, Date.parse('2026-10-05T10:00:05Z'), 'ts is epoch ms');
    const latest = r.body.latest;
    r = await call(`/api/sessions/${C}/chat?after=${encodeURIComponent(latest)}`);
    eq(r.body.items, [], '?after= latest: nothing new');
    appendFileSync(tfile, line({ type: 'assistant', uuid: 'a2', timestamp: '2026-10-05T10:01:00Z', message: { content: [{ type: 'text', text: 'one more' }] } }));
    r = await call(`/api/sessions/${C}/chat?after=${encodeURIComponent(latest)}`);
    eq(r.body.items.map((i) => i.text), ['one more'], 'an appended line arrives on the next poll');
    r = await call(`/api/sessions/${C}/chat?limit=1`);
    eq([r.body.items.map((i) => i.text), !!r.body.before], [['one more'], true], '?limit=1 gives the newest and a before cursor');
    r = await call(`/api/sessions/${C}/chat?limit=1&before=${encodeURIComponent(r.body.before)}`);
    eq(r.body.items.map((i) => i.text), ['hi there'], '?before= pages backwards');
    eq((await call('/api/sessions/nope/chat')).status, 404, 'unknown pane: 404');

    console.log('\n[GET chat: other vendors]');
    r = await call(`/api/sessions/${G}/chat`);
    eq([r.body.supported, /Gemini/.test(r.body.reason)], [false, true], 'gemini: supported:false with words');
    r = await call(`/api/sessions/${S}/chat`);
    eq([r.body.supported, r.body.reason], [false, 'not an agent CLI'], 'shell: not an agent CLI');

    console.log('\n[codex: the hook sink feeds the chat log]');
    const hook = (b) => call(`/api/agent-hook?vendor=codex-cli&paneid=${X}`, { json: b, auth: false });
    eq((await hook({ hook_event_name: 'UserPromptSubmit', session_id: 'cccccccc-0001', prompt: '[chat · @user] run the tests' })).status, 200, 'loopback hook delivery is accepted without a credential (unchanged)');
    await hook({ hook_event_name: 'Stop', session_id: 'cccccccc-0001', last_assistant_message: 'All 12 pass.' });
    r = await call(`/api/sessions/${X}/chat`);
    eq(r.body.items.map((i) => [i.role, i.text]), [['user', 'run the tests'], ['agent', 'All 12 pass.']], 'codex: the prompt and the last message');
    eq((await call(`/api/sessions/${X}/chat`, { auth: false })).status, 401, '... and reading that log needs a credential');

    console.log('\n[POST chat]');
    r = await call(`/api/sessions/${C}/chat`, { json: { text: 'hello' } });
    eq([r.status, /not running/.test(r.body.error)], [409, true], 'a pane the engine is not running: 409 in words');
    eq((await call(`/api/sessions/${C}/chat`, { json: {} })).status, 409, 'not-running outranks body checks');

    console.log('\n[Scratchpad]');
    r = await call(`/api/sessions/${C}/scratchpad`);
    eq([r.status, r.body.folder, r.body.files], [200, 'sessions/chatproj', []], 'empty Scratchpad (folder not on the share yet)');
    r = await call(`/api/sessions/${C}/scratchpad`, { bytes: Buffer.from('notes body'), headers: { 'x-filename': encodeURIComponent('my notes.txt'), 'content-type': 'text/plain' } });
    eq([r.status, r.body.name, r.body.path], [200, 'my notes.txt', 'sessions/chatproj/my notes.txt'], 'upload lands in sessions/<slug>/');
    eq(r.body.raw, `/api/sessions/${C}/scratchpad/raw/my%20notes.txt`, 'and names the engine raw route');
    r = await call(`/api/sessions/${C}/scratchpad`);
    eq(r.body.files.map((f) => f.name), ['my notes.txt'], 'listed');
    const raw = await call(`/api/sessions/${C}/scratchpad/raw/${encodeURIComponent('my notes.txt')}`);
    eq([raw.status, raw.raw.toString('utf8'), raw.res.headers.get('content-security-policy')], [200, 'notes body', 'sandbox'], 'raw bytes are served sandboxed');
    eq((await call(`/api/sessions/${C}/scratchpad/raw/missing.txt`)).status, 404, 'a missing file: 404');
    eq((await call(`/api/sessions/${C}/scratchpad`, { bytes: Buffer.from('x') })).status, 400, 'no x-filename: 400');
    eq((await call(`/api/sessions/${S}/scratchpad`)).status, 200, 'a session with an agent slug has one');
    eq((await call('/api/sessions/nope/scratchpad')).status, 404, 'unknown pane: 404');
  } finally {
    engine?.kill();
    await new Promise((r) => stub.close(r));
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows: the store still holds the db (EPERM) */ }
  }
}

try {
  await run();
} catch (e) {
  failed++;
  console.log(`  X suite crashed: ${e?.stack ?? e}`);
}
console.log(`\n${'='.repeat(40)}\nPASS ${passed}  FAIL ${failed}`);
process.exit(failed ? 1 : 0);
