/**
 * Room COMPOSER ATTACHMENTS through a real scratch engine [ticket]:
 *   - the scratchpad is a PERSON's: a bearer (with or without from) can
 *     neither add, list, read nor remove (403); a file is found only under its
 *     own room (404 elsewhere); nothing reaches agent-share while drafting;
 *   - caps: 25 MB a file and N files a draft, both ANSWERING 413 with both
 *     numbers (the connection is not cut);
 *   - X (DELETE) removes the row and the bytes on disk;
 *   - SEND moves the files into the room's assets (a STUB agent-share) and
 *     writes ONE `attachment` line whose meta carries the files for the human
 *     bubble; the agent-facing text is the words plus one reference line per
 *     file (the Copy-reference URL); the scratchpad and the text draft are
 *     emptied; the assets are recorded (no "added" fact beside the message);
 *   - a room with no Assets panel gets one with the first send, and only once;
 *   - attachments-only messages go to the lead; with no lead they are refused
 *     and nothing moves; a /command with files is refused and nothing moves;
 *   - a share failure part-way sends NOTHING and keeps the draft; the retry
 *     does not upload the file that already moved a second time.
 *
 * SAFETY: scratch engine P(140), dead broker P(141), stub share P(142), the
 * Assets panel URL points at P(143) where nothing listens (the suite never
 * loads the frame). Temp table + temp scratch dir, childEnv(). Never
 * :7420/:7430/:8200/:8201/:8204/:8205/:8206 and never the real share.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync, mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(140);
const DEAD_BROKER_PORT = P(141);
const SHARE_PORT = P(142);
const DEAD_ASSETS_PORT = P(143);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const SHARE = `http://${HOST}:${SHARE_PORT}`;
const TOKEN = 'room-attach-test-token';
const MAX_COUNT = 3;

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
const authHeaders = (as) => (as === 'person' ? { cookie } : { authorization: `Bearer ${TOKEN}` });
async function call(path, { method, json, as = 'person' } = {}) {
  const headers = authHeaders(as);
  const init = { method: method ?? (json === undefined ? 'GET' : 'POST'), headers };
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  const res = await fetch(BASE + path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function attach(roomPath, name, bytes, { as = 'person', type = 'application/octet-stream', query = '', key = null, pos = null } = {}) {
  const headers = {
    ...authHeaders(as),
    'content-type': type,
    'x-filename': encodeURIComponent(name),
    ...(key ? { 'x-upload-key': key } : {}),
    ...(pos !== null ? { 'x-upload-pos': String(pos) } : {}),
  };
  const res = await fetch(`${BASE}${roomPath}/scratch${query}`, { method: 'POST', headers, body: bytes });
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

/* ------------------------------------------------------ stub agent-share ---- */
/* Today's API: multipart /api/upload?dir=&mkdir=1 (never overwrites: name-1),
   GET /api/list?dir= JSON newest first, /raw/<ref>. `failUploads` > 0 makes
   the next uploads answer 500. */
const shareFs = new Map();
let failUploads = 0;
let uploadCount = 0;
let clock = 1_000;
const q = (p) => p.split('/').map(encodeURIComponent).join('/');
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
      .map((f) => ({ name: f.name, path: `${dir}/${f.name}`, type: 'file', size: f.bytes.length, mtime: f.mtime, url: `${SHARE}/raw/${q(`${dir}/${f.name}`)}` }));
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ dir, sig: 's', entries }));
  }
  if (req.method === 'POST' && u.pathname === '/api/upload') {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      if (failUploads > 0) {
        failUploads--;
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'disk full' }));
      }
      uploadCount++;
      const dir = u.searchParams.get('dir') ?? '';
      if (!shareFs.has(dir) && u.searchParams.get('mkdir') === '1') {
        shareFs.set(dir, []);
      }
      const body = Buffer.concat(chunks);
      const boundary = /boundary=([^;]+)/.exec(req.headers['content-type'] ?? '')?.[1];
      const headEnd = body.indexOf('\r\n\r\n');
      const filename = /filename="([^"]*)"/.exec(body.subarray(0, headEnd).toString('utf8'))?.[1];
      const end = body.lastIndexOf(Buffer.from(`\r\n--${boundary}--`));
      const files = shareFs.get(dir);
      let final = filename;
      const dot = filename.lastIndexOf('.');
      for (let i = 1; files.some((f) => f.name === final); i++) {
        final = dot > 0 ? `${filename.slice(0, dot)}-${i}${filename.slice(dot)}` : `${filename}-${i}`;
      }
      files.push({ name: final, bytes: body.subarray(headEnd + 4, end), mtime: clock++ });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, saved: [`${dir}/${final}`] }));
    });
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

async function run() {
  for (const p of [PORT, DEAD_BROKER_PORT, SHARE_PORT, DEAD_ASSETS_PORT]) {
    await assertFree(p, 'room-attach.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-attach-'));
  const dbPath = join(tmpDir, 'mapping.db');
  const scratchDir = join(tmpDir, 'room-scratch');
  let engine = null;
  let engineLog = '';
  await new Promise((r) => stub.listen(SHARE_PORT, HOST, r));
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) {
      throw new Error(`seed failed: ${r.err}`);
    }
    return JSON.parse(r.out.trim().split('\n').pop());
  };
  const onDisk = () => (existsSync(scratchDir) ? readdirSync(scratchDir) : []);

  try {
    const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
    engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_PORT: String(PORT),
        HARBOR_WB_HOST: HOST,
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
        HARBOR_WB_CONFIG: join(tmpDir, 'config.json'),
        HARBOR_WB_AGENT_SHARE_URL: SHARE,
        HARBOR_WB_ROOM_ASSETS_URL: `http://${HOST}:${DEAD_ASSETS_PORT}`,
        HARBOR_WB_ROOM_SCRATCH_DIR: scratchDir,
        HARBOR_WB_ROOM_ATTACH_MAX: String(MAX_COUNT),
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

    const A = 'recipe:rec-a#1';
    const B = 'recipe:rec-b#1';
    const C = 'recipe:rec-b#2';
    const seeded = await seed({
      recipes: [
        { id: 'rec-a', name: 'Alpha', projectDir: '/srv/x/alpha', vendor: 'cli-manager', agent: 'alpha' },
        { id: 'rec-b', name: 'Beta', projectDir: '/srv/x/beta', vendor: 'cli-manager', agent: 'beta' },
      ],
      sessions: [
        { paneid: A, recipe_id: 'rec-a', vendor: 'cli-manager', agent: 'alpha', state: 'live' },
        { paneid: B, recipe_id: 'rec-b', vendor: 'cli-manager', agent: 'beta', state: 'live' },
        { paneid: C, recipe_id: 'rec-b', vendor: 'cli-manager', agent: 'beta', state: 'live' },
      ],
      rooms: [
        { name: 'Attach Room', seats: [{ handle: 'a', recipe_id: 'rec-a', occupant: A }, { handle: 'b', recipe_id: 'rec-b', occupant: B }] },
        { name: 'Elsewhere', seats: [] },
        { name: 'Has Assets', seats: [{ handle: 'c', recipe_id: 'rec-b', occupant: C }] },
      ],
    });
    const room = seeded.rooms[0];
    const R = `/api/rooms/${room.id}`;
    const R2 = `/api/rooms/${seeded.rooms[1].id}`;
    const room3 = seeded.rooms[2];
    const R3 = `/api/rooms/${room3.id}`;
    const folder = (await call(`${R}/assets/folder`)).body?.folder;

    console.log('\n[an empty scratchpad]');
    let r = await call(`${R}/scratch`);
    eq(
      [r.status, r.body?.files, r.body?.max, r.body?.assetsPanel],
      [200, [], { bytes: 25 * 1024 * 1024, count: MAX_COUNT }, false],
      'GET: no files, the caps (25 MB, N per message), and no Assets panel yet',
    );

    console.log('\n[a person attaches]');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);
    r = await attach(R, 'hero ref.png', png, { type: 'image/png' });
    eq(r.status, 200, 'cookie: 200');
    const f1 = r.body?.file ?? {};
    eq(
      [f1.name, f1.type, f1.size, f1.raw, typeof f1.id, typeof f1.addedAt, r.body?.count],
      ['hero ref.png', 'image/png', 7, `${R}/scratch/${f1.id}`, 'string', 'number', 1],
      '{id, name, type, size, addedAt, raw}',
    );
    r = await attach(R, 'brief.pdf', Buffer.from('%PDF-1 brief'));
    const f2 = r.body?.file ?? {};
    eq([r.status, f2.type], [200, 'application/pdf'], 'a second file; type from the extension when the browser gives none');
    eq(shareFs.size + uploadCount, 0, 'nothing has reached agent-share while drafting');
    eq(onDisk().sort(), [f1.id, f2.id].sort(), 'the bytes are on the server under the scratch dir, named by id');
    ok(!engineLog.includes('hero ref.png') && !engineLog.includes('brief'), 'the engine log names neither file (only sizes)');
    r = await call(`${R}/scratch`);
    eq(r.body?.files?.map((f) => f.id), [f1.id, f2.id], 'listed in the order attached (a reload restores the tray)');
    let fr = await fetch(`${BASE}${f1.raw}`, { headers: { cookie } });
    eq([fr.status, fr.headers.get('content-security-policy'), fr.headers.get('x-content-type-options'), fr.headers.get('cache-control')], [200, 'sandbox', 'nosniff', 'private, no-store'], 'the bytes for the thumbnail: sandboxed, nosniff, not cached');
    ok(Buffer.from(await fr.arrayBuffer()).equals(png), '...exactly as attached');

    console.log('\n[private until sent]');
    r = await call(`${R}/scratch`, { as: 'agent' });
    eq([r.status, r.body?.field], [403, 'credential'], 'a bearer cannot LIST it (403)');
    fr = await fetch(`${BASE}${f1.raw}`, { headers: authHeaders('agent') });
    eq(fr.status, 403, 'a bearer cannot READ a file (403)');
    r = await attach(R, 'x.txt', Buffer.from('x'), { as: 'agent' });
    eq([r.status, r.body?.field], [403, 'credential'], 'a bearer cannot ADD (403, and the answer is delivered)');
    r = await attach(R, 'x.txt', Buffer.from('x'), { as: 'agent', query: `?from_paneid=${encodeURIComponent(A)}` });
    eq(r.status, 403, 'not even as a seated member (from_paneid)');
    r = await call(`${R}/scratch/${f1.id}`, { method: 'DELETE', as: 'agent' });
    eq(r.status, 403, 'a bearer cannot REMOVE (403)');
    r = await call(`${R}/line`, { json: { text: 'x', attachments: [f1.id] }, as: 'agent' });
    eq(r.status, 403, 'a bearer cannot SEND someone\'s attachments (403)');
    fr = await fetch(`${BASE}${R2}/scratch/${f1.id}`, { headers: { cookie } });
    eq(fr.status, 404, 'a file id under another room: 404');
    fr = await fetch(`${BASE}${f1.raw}`);
    eq(fr.status, 401, 'no credential: 401');
    eq((await call(`${R}/scratch`)).body?.files?.length, 2, 'the draft is untouched by all of that');

    console.log('\n[a ✕ while the upload is in flight: it never comes back]');
    r = await attach(R, 'landed.txt', Buffer.from('l'), { key: 'upkey-landed-0001' });
    eq([r.status, typeof r.body?.file?.id, r.body?.file?.key], [200, 'string', 'upkey-landed-0001'], 'an upload names itself with x-upload-key');
    const landed = r.body?.file?.id;
    r = await call(`${R}/scratch?key=upkey-landed-0001`, { method: 'DELETE', as: 'agent' });
    eq(r.status, 403, 'a bearer cannot delete by key (403)');
    r = await call(`${R}/scratch?key=upkey-landed-0001`, { method: 'DELETE' });
    eq([r.status, r.body?.removed], [200, landed], 'it landed before the ✕: DELETE ?key= removes that row');
    ok(!onDisk().includes(landed), '...and its bytes');
    r = await call(`${R}/scratch?key=upkey-onwire-0002`, { method: 'DELETE' });
    eq([r.status, r.body?.removed], [200, null], 'still on the wire: DELETE ?key= finds nothing yet (and tombstones the key)');
    r = await attach(R, 'late.txt', Buffer.from('late bytes'), { key: 'upkey-onwire-0002' });
    eq([r.status, r.body?.field], [409, 'x-upload-key'], 'the upload that arrives after its ✕ is discarded (409)');
    eq((await call(`${R}/scratch`)).body?.files?.map((f) => f.name), ['hero ref.png', 'brief.pdf'], 'the draft holds neither: they never come back');
    eq(onDisk().length, 2, 'and nothing of them is on disk');
    r = await call(`${R}/scratch?key=../x`, { method: 'DELETE' });
    eq([r.status, r.body?.field], [400, 'key'], 'a malformed key: 400');

    console.log('\n[caps]');
    const big = Buffer.alloc(25 * 1024 * 1024 + 1, 1);
    r = await attach(R, 'big.bin', big);
    eq([r.status, r.body?.field], [413, 'body'], 'over 25 MB: 413 (answered, not cut)');
    ok((r.body?.error ?? '').includes(String(big.length)) && (r.body?.error ?? '').includes(String(25 * 1024 * 1024)), '...with both numbers');
    r = await attach(R, 'third.txt', Buffer.from('3'));
    eq(r.status, 200, `a third file: 200 (cap ${MAX_COUNT})`);
    const f3 = r.body?.file ?? {};
    r = await attach(R, 'fourth.txt', Buffer.from('4'));
    eq([r.status, r.body?.field], [413, 'count'], 'past the per-message count: 413');
    ok(/holds 3 files/.test(r.body?.error ?? '') && /limit is 3/.test(r.body?.error ?? ''), '...with both numbers');

    console.log('\n[X removes]');
    r = await call(`${R}/scratch/${f3.id}`, { method: 'DELETE' });
    eq([r.status, r.body?.removed, r.body?.count], [200, f3.id, 2], 'DELETE: 200, count back to 2');
    ok(!onDisk().includes(f3.id), '...and its bytes are gone from disk');
    eq((await call(`${R}/scratch/${f3.id}`, { method: 'DELETE' })).status, 404, 'removing it again: 404');

    console.log('\n[refusals move nothing]');
    r = await call(`${R}/line`, { json: { text: '/archive', attachments: [f1.id] } });
    eq([r.status, r.body?.status], [200, 'refused'], 'a /command with files: refused');
    const lone = (await attach(R2, 'lone.png', Buffer.from('lone'), { type: 'image/png' })).body?.file ?? {};
    r = await call(`${R2}/line`, { json: { attachments: [lone.id] } });
    eq([r.status, r.body?.status], [200, 'refused'], 'attachments only, in a room with no lead: refused');
    ok(/no lead/.test(r.body?.refused?.error ?? ''), '...saying so');
    eq((await call(`${R2}/scratch`)).body?.files?.map((f) => f.id), [lone.id], '...and the file stays in that draft');
    const t0 = Date.now();
    await attach(R2, 'picked-second.txt', Buffer.from('2'), { pos: t0 + 2000 });
    await attach(R2, 'picked-first.txt', Buffer.from('1'), { pos: t0 + 1000 });
    eq(
      (await call(`${R2}/scratch`)).body?.files?.map((f) => f.name),
      ['lone.png', 'picked-first.txt', 'picked-second.txt'],
      'the tray order is the x-upload-pos the page sent, not the order uploads landed in',
    );
    /* DRAG TO REORDER (Owner 2026-10-04, room): PUT .../scratch/order sets the tray order that is sent */
    {
      const ids0 = (await call(`${R2}/scratch`)).body?.files?.map((f) => f.id) ?? [];
      const want = [ids0[2], ids0[0], ids0[1]];
      r = await call(`${R2}/scratch/order`, { method: 'PUT', json: { ids: want } });
      eq([r.status, r.body?.order], [200, want], 'PUT scratch/order: the new order comes back');
      eq((await call(`${R2}/scratch`)).body?.files?.map((f) => f.id), want, '...and the listing (what is sent) follows it');
      r = await call(`${R2}/scratch/order`, { method: 'PUT', json: { ids: want } });
      eq(r.body?.order, want, 'the same order again: a no-op');
      r = await call(`${R2}/scratch/order`, { method: 'PUT', json: { ids: [want[1], 'f'.repeat(32), want[0]] } });
      eq(r.body?.order, [want[1], want[0], want[2]], 'a partial list reorders only the files it names (unknown ids ignored)');
      eq((await call(`${R2}/scratch/order`, { method: 'PUT', json: { ids: 'x' } })).status, 400, 'ids not an array: 400');
      eq((await call(`${R2}/scratch/order`, { method: 'PUT', json: { ids: want }, as: 'bearer' })).status, 403, 'a bearer cannot reorder a person\'s draft');
    }
    r = await call(`${R}/line`, { json: { text: 'hi', attachments: ['0'.repeat(32)] } });
    eq([r.status, r.body?.field], [409, 'attachments'], 'an id not in the draft: 409');
    eq(uploadCount, 0, 'nothing reached agent-share');
    eq((await call(`${R}/scratch`)).body?.files?.length, 2, 'and the draft still holds both');

    console.log('\n[a share failure part-way sends NOTHING]');
    await call(`${R}/draft`, { method: 'PUT', json: { text: '@a here are the refs' } });
    const lineBefore = (await call(`${R}/line`)).body?.entries?.length;
    failUploads = 0;
    // the first file moves, the second upload fails
    let firstMoved = false;
    const origEmit = stub.listeners('request')[0];
    stub.removeAllListeners('request');
    stub.on('request', (req, res) => {
      if (req.url?.startsWith('/api/upload') && firstMoved) {
        failUploads = 1;
      }
      if (req.url?.startsWith('/api/upload')) {
        firstMoved = true;
      }
      origEmit(req, res);
    });
    r = await call(`${R}/line`, { json: { text: '@a here are the refs', attachments: [f1.id, f2.id] } });
    eq([r.status, r.body?.field], [502, 'attachments'], 'the second upload fails: 502');
    ok(/nothing was sent/.test(r.body?.error ?? ''), '...saying nothing was sent');
    eq((await call(`${R}/line`)).body?.entries?.length, lineBefore, 'no line was written');
    eq((await call(`${R}/scratch`)).body?.files?.length, 2, 'both files are still in the draft');
    eq((await call(`${R}/draft`)).body?.text, '@a here are the refs', 'and so is the text');
    stub.removeAllListeners('request');
    stub.on('request', origEmit);

    console.log('\n[SEND]');
    r = await call(`${R}/line`, { json: { text: '@a here are the refs', attachments: [f1.id, f2.id] } });
    eq(r.status, 200, 'the retry: 200');
    eq(shareFs.get(folder)?.map((f) => f.name).sort(), ['brief.pdf', 'hero ref.png'], 'both files are in the room\'s assets folder, the first NOT uploaded twice');
    const e = r.body?.entries?.[0] ?? {};
    eq([e.kind, e.author, e.body, e.target, e.target_seat], ['attachment', 'user', '@a here are the refs', 'a', room.seats.a], 'ONE line: kind attachment, the person\'s words, addressed as typed');
    const meta = typeof e.meta === 'string' ? JSON.parse(e.meta) : e.meta;
    const sent = meta?.attachments ?? [];
    eq(
      sent.map((s) => [s.name, s.type, s.size, s.raw, s.path, s.url]),
      [
        ['hero ref.png', 'image/png', 7, `${R}/assets/raw/hero%20ref.png`, `${folder}/hero ref.png`, `${SHARE}/raw/${folder}/hero%20ref.png`],
        ['brief.pdf', 'application/pdf', 12, `${R}/assets/raw/brief.pdf`, `${folder}/brief.pdf`, `${SHARE}/raw/${folder}/brief.pdf`],
      ],
      'the human bubble data: each file\'s name, type, size and the engine\'s raw route (+ the ref for agents reading the line)',
    );
    eq(r.body?.deliveries?.map((d) => d.handle), ['a'], 'delivered to @a only');
    const agentLines = (r.body?.agentText ?? '').split('\n');
    eq(agentLines[0], '@a here are the refs', 'the agents get the words first');
    eq(agentLines[1], 'attachments (2, in room assets):', 'then the reference block');
    eq(agentLines.length, 4, '...with one line per file');
    ok(agentLines[2].includes(`${SHARE}/raw/${folder}/hero%20ref.png`) && agentLines[2].startsWith('[1] hero ref.png · image/png · 7 B'), 'each line (numbered [n], ticket): name · type · size · the Copy-reference URL');
    const assetList = (await call(`${R}/assets`, { as: 'agent' })).body?.assets ?? [];
    ok(assetList.some((a) => a.name === 'hero ref.png' && a.url === sent[0].url && a.addedBy === 'user'), 'the Copy reference an Assets listing gives is the same URL, added by the user');
    eq((await call(`${R}/scratch`)).body?.files, [], 'the scratchpad is empty');
    ok(!onDisk().includes(f1.id) && !onDisk().includes(f2.id), '...and the sent files are gone from the scratch dir');
    eq((await call(`${R}/draft`)).body?.text, '', 'the text draft is cleared');
    const facts = ((await call(`${R}/line?kind=fact`)).body?.entries ?? []).map((x) => x.body);
    ok(!facts.some((b) => /added (hero|brief)/.test(b)), 'no "user added" fact beside the message (the message is the record)');
    ok(facts.some((b) => /panel "Assets" was added/.test(b)), 'the panel fact says the Assets panel was added');
    eq([r.body?.assetsPanel?.added, typeof r.body?.assetsPanel?.id], [true, 'string'], 'a room with no Assets panel got one with the first send');
    const panels = (await call(`${R}/panels`)).body?.panels ?? [];
    const ap = panels.find((p) => p.id === r.body?.assetsPanel?.id);
    eq([ap?.title, ap?.icon, ap?.url, ap?.scripts, ap?.uploads, ap?.seat_id ?? null], ['Assets', 'assets', `http://${HOST}:${DEAD_ASSETS_PORT}/rooms/${room.id}/view`, true, true, null], 'the room-assets view, registered as the user (no seat)');
    eq((await call(`${R}/scratch`)).body?.assetsPanel, true, 'the scratchpad now says the room has one');
    const line = (await call(`${R}/line?kind=attachment`)).body?.entries ?? [];
    eq(line.map((x) => x.id), [e.id], 'the line\'s `attachment` filter kind finds the message');

    console.log('\n[attachments only, and a second send]');
    await call(R, { method: 'PATCH', json: { lead_seat: room.seats.b } });
    r = await attach(R, 'only.png', Buffer.from('only'), { type: 'image/png' });
    const f4 = r.body?.file ?? {};
    r = await call(`${R}/line`, { json: { text: '   ', attachments: [f4.id] } });
    const e2 = r.body?.entries?.[0] ?? {};
    eq([r.status, e2.kind, e2.body, e2.target, e2.target_seat], [200, 'attachment', null, null, room.seats.b], 'no words: allowed, to the lead');
    eq((r.body?.agentText ?? '').split('\n')[0], 'attachments (1, in room assets):', 'the agent gets the block alone');
    eq([r.body?.assetsPanel?.added, r.body?.assetsPanel?.id], [false, ap?.id], 'the Assets panel is not added twice');
    eq((await call(`${R}/panels`)).body?.panels?.filter((p) => p.icon === 'assets').length, 1, 'one Assets panel');
    r = await attach(R, 'only.png', Buffer.from('again'), { type: 'image/png' });
    r = await call(`${R}/line`, { json: { text: 'again', attachments: [r.body?.file?.id] } });
    eq(JSON.parse(r.body?.entries?.[0]?.meta ?? '{}').attachments?.[0]?.name, 'only-1.png', 'a same-named file lands as agent-share stored it (only-1.png)');

    console.log('\n[a room that already has an Assets panel, on any seat]');
    r = await call(`${R3}/panels`, { json: { title: 'Files', url: `http://${HOST}:${DEAD_ASSETS_PORT}/rooms/${room3.id}/view`, from: { paneid: C } }, as: 'agent' });
    eq(r.status, 200, 'a member registers room-assets\' view of this room on its own seat, titled "Files"');
    const theirs = r.body?.panel?.id;
    r = await call(`${R3}/panels`, { json: { title: 'Tasks', url: `http://${HOST}:${DEAD_BROKER_PORT}/rooms/${room3.id}/view`, from: { paneid: C } }, as: 'agent' });
    eq(r.status, 200, 'and a sibling app on another port with the same /rooms/<id>/view path');
    eq((await call(`${R3}/scratch`)).body?.assetsPanel, true, 'the scratchpad says the room has an Assets panel (the view URL counts, whatever the title)');
    r = await attach(R3, 'x.png', Buffer.from('x'), { type: 'image/png' });
    r = await call(`${R3}/line`, { json: { text: 'here', attachments: [r.body?.file?.id] } });
    eq([r.status, r.body?.assetsPanel?.added, r.body?.assetsPanel?.id], [200, false, theirs], 'the send does not add a second one: it names the seat\'s');
    eq((await call(`${R3}/panels`)).body?.panels?.length, 2, 'still two panels (theirs + the sibling)');

    console.log('\n[a note sent as an attachment is a NOTE on the line]');
    ok(sent.every((x) => x.kind === undefined && x.title === undefined), 'a plain file carries no kind or title (old entry shape)');
    r = await call(`${R}/notes`, { json: { text: '  Buy   oat milk\n and then call   the plumber at the leaky tap in the upstairs bathroom ' } });
    const nid = r.body?.note?.id;
    r = await call(`${R}/notes/${nid}/attach`, { json: {} });
    eq([r.status, r.body?.attachment?.title, r.body?.attachment?.words], [200, 'Buy oat milk and then call the plumber a', 16], 'attach: the title (first 40, whitespace collapsed) and the word count');
    const nf = r.body?.attachment?.file ?? {};
    /* a note stays in the database: with agent-share DOWN (every upload 500s) a notes-only send still works */
    failUploads = 99;
    const upBefore = uploadCount;
    r = await call(`${R}/line`, { json: { text: '', attachments: [nf.id] } });
    eq(r.status, 200, 'the note sends even with agent-share failing');
    eq(uploadCount, upBefore, 'no upload was attempted for it (the failing stub was never asked)');
    eq(failUploads, 99, '...not even a rejected one');
    const ne = JSON.parse(r.body?.entries?.[0]?.meta ?? '{}').attachments?.[0] ?? {};
    eq([ne.kind, ne.title, ne.words, ne.type, ne.size, ne.name], ['note', 'Buy oat milk and then call the plumber a', 16, 'text/plain', Buffer.byteLength('  Buy   oat milk\n and then call   the plumber at the leaky tap in the upstairs bathroom '), `note-${ne.sent_id}.txt`], 'the line attachment carries kind note, title, words, size and the sent id');
    eq([ne.url, ne.path, ne.raw], [undefined, undefined, `${R}/notes/sent/${ne.sent_id}/raw`], 'no agent-share url or path; raw is the engine route');
    eq((r.body?.agentText ?? '').split('\n')[0], 'attachments (1):', 'a notes-only block does not say "in room assets"');
    const nl = (r.body?.agentText ?? '').split('\n')[1] ?? '';
    eq(nl, `- note: "Buy oat milk and then call the plumber a" · 16 words · read: fabric room_note id=${ne.sent_id}, or scripts/room-note.sh ${room.id} ${ne.sent_id} (briefing-table), or GET ${R}/notes/sent/${ne.sent_id}`, 'agents get the read hint, not a file reference');
    ok(nl.length < 300, 'the line is under 300 characters');
    eq(r.body?.assetsPanel, undefined, 'a notes-only send leaves the Assets panel alone');
    eq((await call(`${R}/scratch`)).body?.files, [], 'the draft attachment is gone');
    const sentNote = await call(`${R}/notes/sent/${ne.sent_id}`, { as: 'agent' });
    eq([sentNote.status, sentNote.body?.title, sentNote.body?.words, typeof sentNote.body?.createdAt], [200, 'Buy oat milk and then call the plumber a', 16, 'number'], 'GET sent: any authenticated caller (an agent bearer)');
    const noteText = '  Buy   oat milk\n and then call   the plumber at the leaky tap in the upstairs bathroom ';
    eq(sentNote.body?.text, noteText, '...with the exact text');
    await call(`${R}/notes/${nid}`, { method: 'PUT', json: { text: 'edited later' } });
    eq((await call(`${R}/notes/sent/${ne.sent_id}`)).body?.text, noteText, 'a later edit of the note never changes what the message said');
    const rawRes = await fetch(`${BASE}${ne.raw}`, { headers: authHeaders('agent') });
    eq([rawRes.status, rawRes.headers.get('content-type'), rawRes.headers.get('x-content-type-options'), rawRes.headers.get('content-security-policy'), rawRes.headers.get('referrer-policy')], [200, 'text/plain; charset=utf-8', 'nosniff', 'sandbox', 'no-referrer'], 'raw: text/plain with the assets-raw hardening headers');
    eq(await rawRes.text(), noteText, '...and the text');
    eq((await call(`${R2}/notes/sent/${ne.sent_id}`)).status, 404, 'another room does not find it');
    eq((await call(`${R}/notes/sent/aaaaaaaaaaaa`)).status, 404, 'an unknown id is a 404');
    eq((await call(`${R}/notes/sent/${ne.sent_id}/nope`)).status, 404, 'so is another sub-path');
    eq((await call(`${R}/notes/sent/${ne.sent_id}`, { json: {} })).status, 404, 'and a write (it is immutable)');
    ok(!(await call(`${R}/assets`)).body?.assets?.some((x) => /^note-/.test(x.name)), 'the Assets listing never sees it');

    console.log('\n[a file beside a note still needs agent-share]');
    r = await call(`${R}/notes/${nid}/attach`, { json: {} });
    const nf2 = r.body?.attachment?.file ?? {};
    r = await attach(R, 'beside.png', Buffer.from('beside'), { type: 'image/png' });
    const bf = r.body?.file ?? {};
    r = await call(`${R}/line`, { json: { text: '', attachments: [nf2.id, bf.id] } });
    eq([r.status, r.body?.field], [502, 'attachments'], 'a real file still reports the upload failure');
    eq((await call(`${R}/scratch`)).body?.files?.length, 2, '...and both stay in the draft');
    failUploads = 0;
    r = await call(`${R}/line`, { json: { text: '', attachments: [nf2.id, bf.id] } });
    const mixed = JSON.parse(r.body?.entries?.[0]?.meta ?? '{}').attachments ?? [];
    eq([r.status, mixed.map((x) => x.kind ?? 'file'), mixed.map((x) => !!x.url)], [200, ['note', 'file'], [false, true]], 'retried: the note is a snapshot, the file went to assets, in the draft order');
    eq((r.body?.agentText ?? '').split('\n')[0], 'attachments (2, in room assets):', 'a mixed block keeps the old header');
    eq((await call(`${R}/notes/sent/${mixed[0].sent_id}`)).body?.text, 'edited later', 'the second send snapshots the note as it was then');

    console.log('\n[a note made from the message box gives the room its Assets panel at once]');
    eq((await call(`${R2}/panels`)).body?.panels?.length, 0, 'the room has no panels');
    r = await call(`${R2}/notes`, { json: {} });
    eq([r.status, r.body?.assetsPanel?.added, typeof r.body?.note?.id], [200, true, 'string'], 'POST /notes: created, and the panel was added');
    eq((await call(`${R2}/panels`)).body?.panels?.filter((p) => p.icon === 'assets').length, 1, 'the room has one Assets panel');
    r = await call(`${R2}/notes`, { json: {} });
    eq([r.status, r.body?.assetsPanel?.added], [200, false], 'a second note leaves it alone');
    eq((await call(`${R2}/panels`)).body?.panels?.length, 1, 'still one panel');

    console.log('\n[archived]');
    r = await attach(R, 'late.png', Buffer.from('late'), { type: 'image/png' });
    const late = r.body?.file ?? {};
    await call(`${R}/archive`, { json: {} });
    r = await attach(R, 'later.png', Buffer.from('x'), { type: 'image/png' });
    eq([r.status, r.body?.field], [409, 'state'], 'an archived room takes no new attachments');
    r = await call(`${R}/line`, { json: { text: 'late', attachments: [late.id] } });
    eq([r.status, r.body?.field], [409, 'state'], 'and sends none');
    eq((await call(`${R}/scratch`)).body?.files?.map((f) => f.id), [late.id], 'the draft is still listable (and removable)');
  } catch (e) {
    failed++;
    failures.push(String(e?.stack ?? e));
    console.log(`  X threw: ${e?.stack ?? e}`);
  } finally {
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
