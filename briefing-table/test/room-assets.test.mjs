/**
 * Room ASSETS through a real scratch engine (room thin app #2) [ticket]:
 * the room -> agent-share folder mapping (stored, stable across a rename),
 * who may add (a human credential, or a member via from_paneid), the 25 MB
 * cap (413 with both numbers), agent-share's never-overwrite collision
 * (name-1) passed through, the newest-first listing (engine records merged
 * with files agents dropped directly), the Room fact, and the raw route.
 *
 * The rooms-routes pattern: our own engine on P() ports, a temp mapping db,
 * NO broker and NO pty. agent-share is a STUB on P(106) that speaks today's
 * API (multipart /api/upload?dir=, GET /api/list?dir= JSON, /raw/<ref>) —
 * including "target dir missing" for a folder that does not exist, since
 * the stub (unlike the real, patched share) still refuses mkdir=1.
 *
 * SAFETY: scratch engine P(104), dead broker P(105), stub share P(106), temp
 * table, childEnv(); never :7420/:7430/:8200/:8201/:8204 and never the real
 * share. The temp dir is removed.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(104);
const DEAD_BROKER_PORT = P(105);
const SHARE_PORT = P(106);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const SHARE = `http://${HOST}:${SHARE_PORT}`;
const TOKEN = 'room-assets-test-token';

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
function authHeaders(as) {
  return as === 'person' ? { cookie } : { authorization: `Bearer ${TOKEN}` };
}
async function call(path, { method, json, as = 'agent' } = {}) {
  const headers = authHeaders(as);
  const init = { method: method ?? (json === undefined ? 'GET' : 'POST'), headers };
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  const res = await fetch(BASE + path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}
/** Upload raw bytes the way a host drop/paste does. */
async function put(path, name, bytes, { as = 'person', type = 'application/octet-stream', query = '' } = {}) {
  const headers = { ...authHeaders(as), 'content-type': type };
  if (name !== null) {
    headers['x-filename'] = encodeURIComponent(name);
  }
  const res = await fetch(`${BASE}${path}${query}`, { method: 'POST', headers, body: bytes });
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
/* folder -> [{name, bytes, mtime}] ; a folder exists only once added. */
const shareFs = new Map();
const uploads = []; // the query strings the engine sent
let clock = 1_000;
function kindOf(name) {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
  if (['png', 'jpg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (['txt', 'md', 'json', 'html'].includes(ext)) return 'text';
  return 'file';
}
function addFile(folder, name, bytes) {
  const files = shareFs.get(folder);
  let final = name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 1; files.some((f) => f.name === final); i++) {
    final = `${stem}-${i}${ext}`;
  }
  files.push({ name: final, bytes, mtime: clock++ });
  return `${folder}/${final}`;
}
const q = (p) => p.split('/').map(encodeURIComponent).join('/');
/** The JSON `/api/list` body agent-share now answers with, newest first. A
 *  synthetic `sub` DIR entry rides along — the real API can return one, and
 *  it must be skipped (never a file). */
function listApi(folder) {
  const files = [...shareFs.get(folder)].sort((a, b) => b.mtime - a.mtime);
  const entries = files.map((f) => ({
    name: f.name,
    path: `${folder}/${f.name}`,
    type: 'file',
    size: f.bytes.length,
    mtime: f.mtime,
    url: `${SHARE}/raw/${q(`${folder}/${f.name}`)}`,
  }));
  entries.push({ name: 'sub', path: `${folder}/sub`, type: 'dir', size: null, mtime: 0, url: null });
  return { dir: folder, sig: 'stub-sig', entries };
}
const stub = createServer((req, res) => {
  const u = new URL(req.url ?? '/', SHARE);
  if (req.method === 'GET' && u.pathname === '/api/list') {
    const dir = u.searchParams.get('dir') ?? '';
    if (!shareFs.has(dir)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'no such dir' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(listApi(dir)));
  }
  if (req.method === 'POST' && u.pathname === '/api/upload') {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      uploads.push(u.search);
      const dir = u.searchParams.get('dir') ?? '';
      if (!shareFs.has(dir)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'target dir missing' }));
      }
      const body = Buffer.concat(chunks);
      const boundary = /boundary=([^;]+)/.exec(req.headers['content-type'] ?? '')?.[1];
      const headEnd = body.indexOf('\r\n\r\n');
      const head = body.subarray(0, headEnd).toString('utf8');
      const filename = /filename="([^"]*)"/.exec(head)?.[1];
      const end = body.lastIndexOf(Buffer.from(`\r\n--${boundary}--`));
      const saved = addFile(dir, filename, body.subarray(headEnd + 4, end));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, saved: [saved] }));
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
    res.writeHead(200, {
      'content-type': kindOf(f.name) === 'image' ? 'image/png' : 'application/octet-stream',
      'content-length': String(f.bytes.length),
      'content-disposition': `inline; filename="${encodeURIComponent(f.name)}"`,
      'content-security-policy': 'default-src *',
    });
    return res.end(req.method === 'HEAD' ? undefined : f.bytes);
  }
  res.writeHead(404);
  res.end('Not found');
});

async function run() {
  for (const p of [PORT, DEAD_BROKER_PORT, SHARE_PORT]) {
    await assertFree(p, 'room-assets.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-assets-'));
  const dbPath = join(tmpDir, 'mapping.db');
  let engine = null;
  let engineLog = '';
  await new Promise((r) => stub.listen(SHARE_PORT, HOST, r));
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
        HARBOR_WB_CONFIG: join(tmpDir, 'config.json'),
        HARBOR_WB_AGENT_SHARE_URL: SHARE,
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
    const FREE = 'recipe:rec-a#2';
    const seeded = await seed({
      recipes: [{ id: 'rec-a', name: 'Alpha', projectDir: '/srv/x/alpha', vendor: 'cli-manager', agent: 'alpha' }],
      sessions: [
        { paneid: A, recipe_id: 'rec-a', vendor: 'cli-manager', agent: 'alpha', state: 'live' },
        { paneid: FREE, recipe_id: 'rec-a', vendor: 'cli-manager', agent: 'alpha', state: 'live' },
      ],
      rooms: [
        { name: 'Asset Room!', seats: [{ handle: 'a', recipe_id: 'rec-a', occupant: A }] },
        { name: 'Asset Room!', seats: [] },
      ],
    });
    const room = seeded.rooms[0];
    const twin = seeded.rooms[1];
    const R = `/api/rooms/${room.id}`;
    const want = `rooms/asset-room-${room.id.replace(/-/g, '').slice(0, 8)}`;

    console.log('\n[folder mapping]');
    let fr0;
    let r = await call(`${R}/assets/folder`);
    eq(r.body, { folder: want, shareUrl: `${SHARE}/${want}/` }, 'rooms/<slug(name)>-<first 8 of id>, + the share page');
    const twinFolder = (await call(`/api/rooms/${twin.id}/assets/folder`)).body?.folder;
    ok(twinFolder && twinFolder !== want && twinFolder.startsWith('rooms/asset-room-'), 'a same-named room gets its own folder');
    r = await call(R, { method: 'PATCH', json: { name: 'Renamed Entirely' }, as: 'person' });
    eq(r.status, 200, 'rename the room');
    eq((await call(`${R}/assets/folder`)).body?.folder, want, 'the folder survives the rename (stored, not re-derived)');
    eq((await call(R)).body?.room?.asset_folder, want, 'and rides the room row');

    console.log('\n[the folder does not exist on the share yet]');
    eq((await call(`${R}/assets`)).body, { folder: want, shareUrl: `${SHARE}/${want}/`, assets: [] }, 'listing a missing folder: []');
    r = await put(`${R}/assets`, 'pic.png', Buffer.from('PNG1'), { type: 'image/png' });
    eq([r.status, r.body?.field], [502, 'folder'], 'upload into a missing folder: 502 field folder (the share cannot mkdir)');
    ok(/no folder/.test(r.body?.error ?? ''), 'saying so');
    ok(uploads.at(-1)?.includes('mkdir=1'), 'the engine asked for mkdir=1 (ignored by today\'s share)');
    shareFs.set(want, []);

    console.log('\n[who may add]');
    r = await put(`${R}/assets`, 'x.txt', Buffer.from('x'), { as: 'agent' });
    eq([r.status, r.body?.field], [403, 'credential'], 'a bearer with no from: 403 credential');
    r = await put(`${R}/assets`, 'x.txt', Buffer.from('x'), { as: 'agent', query: `?from_paneid=${encodeURIComponent(FREE)}` });
    eq([r.status, r.body?.field], [403, 'from'], 'from a live pane with no seat here: 403 from');
    eq(shareFs.get(want).length, 0, 'nothing reached the share');

    console.log('\n[a person adds]');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    r = await put(`${R}/assets`, 'pic.png', png, { type: 'image/png' });
    eq(r.status, 200, 'cookie: 200');
    const b = r.body ?? {};
    eq(
      [b.name, b.path, b.url, b.raw, b.size, b.type, b.addedBy, typeof b.at],
      ['pic.png', `${want}/pic.png`, `${SHARE}/raw/${want}/pic.png`, `${R}/assets/raw/pic.png`, 7, 'image/png', 'user', 'number'],
      '{name, path, url, raw, size, type, addedBy, at}',
    );
    eq(b.entries?.map((e) => [e.kind, e.author, e.body]), [['fact', 'room', 'user added pic.png']], 'one Room fact');
    const meta = typeof b.entries?.[0]?.meta === 'string' ? JSON.parse(b.entries[0].meta) : b.entries?.[0]?.meta;
    eq([meta?.asset, meta?.by], [`${want}/pic.png`, 'user'], 'the fact carries the ref and the adder');
    r = await put(`${R}/assets`, 'pic.png', Buffer.from('second'), { type: 'image/png' });
    eq([r.status, r.body?.name, r.body?.path], [200, 'pic-1.png', `${want}/pic-1.png`], 'a collision comes back as agent-share stored it: name-1');
    eq(r.body?.entries?.[0]?.body, 'user added pic-1.png', 'and the fact names the stored name');

    console.log('\n[a member adds via from]');
    r = await put(`${R}/assets`, 'notes.txt', Buffer.from('hello'), { as: 'agent', type: 'text/plain', query: `?from_paneid=${encodeURIComponent(A)}` });
    eq([r.status, r.body?.addedBy, r.body?.type], [200, 'a', 'text/plain'], 'from its own live pane: 200, addedBy the handle');
    eq(r.body?.entries?.[0]?.body, '@a added notes.txt', 'the fact names the member');
    eq(r.body?.entries?.[0]?.target_seat, room.seats.a, 'about its seat');

    console.log('\n[names and caps]');
    r = await put(`${R}/assets`, null, Buffer.from('x'));
    eq([r.status, r.body?.field], [400, 'x-filename'], 'no x-filename: 400');
    r = await put(`${R}/assets`, '..', Buffer.from('x'));
    eq([r.status, r.body?.field], [400, 'x-filename'], '"..": 400');
    r = await put(`${R}/assets`, 'x.txt', Buffer.alloc(0));
    eq([r.status, r.body?.field], [400, 'body'], 'an empty body: 400');
    r = await put(`${R}/assets`, '../../etc/pass"wd', Buffer.from('p'));
    eq([r.status, r.body?.name], [200, 'pass_wd'], 'a path is reduced to its sanitised basename');
    const accented = 'caf' + String.fromCharCode(0xe9) + '.md';
    r = await put(`${R}/assets`, accented, Buffer.from('# menu'));
    eq([r.status, r.body?.name, r.body?.type], [200, accented, 'text/markdown'], 'a non-ASCII name survives (percent-encoded header); type from the extension');
    const odd = 'a b%2F+&#.png'; // spaces, a literal %2F, + & # : all must survive encodeURIComponent -> decode
    r = await put(`${R}/assets`, odd, Buffer.from('o'), { type: 'image/png' });
    eq([r.status, r.body?.name], [200, 'a b%2F+&#.png'], 'x-filename is decodeURIComponent-ed exactly once (cli-manager sends encodeURIComponent(name))');
    fr0 = await fetch(`${BASE}${r.body?.raw}`, { headers: authHeaders('agent') });
    eq([fr0.status, await fr0.text()], [200, 'o'], 'and its raw path round-trips');
    const big = Buffer.alloc(25 * 1024 * 1024 + 1, 1);
    r = await put(`${R}/assets`, 'big.bin', big);
    eq([r.status, r.body?.field], [413, 'body'], 'over 25 MB: 413');
    ok((r.body?.error ?? '').includes(String(big.length)) && (r.body?.error ?? '').includes(String(25 * 1024 * 1024)), 'with both numbers');

    console.log('\n[listing: newest first, records merged with agent drops]');
    addFile(want, 'dropped.bin', Buffer.alloc(3000)); // an agent wrote straight to the share
    const droppedMtime = shareFs.get(want).find((f) => f.name === 'dropped.bin').mtime;
    r = await call(`${R}/assets`);
    const names = r.body?.assets?.map((a) => a.name);
    eq(names, ['dropped.bin', 'a b%2F+&#.png', accented, 'pass_wd', 'notes.txt', 'pic-1.png', 'pic.png'], 'newest first; the sub-folder is not an asset');
    const byName = Object.fromEntries((r.body?.assets ?? []).map((a) => [a.name, a]));
    eq(
      [byName['dropped.bin']?.addedBy, byName['dropped.bin']?.addedAt, byName['dropped.bin']?.type, byName['dropped.bin']?.kind],
      [null, droppedMtime * 1000, 'application/octet-stream', 'file'],
      'a direct drop: addedBy null, addedAt falls back to the share mtime, type by extension',
    );
    eq(byName['dropped.bin']?.size, 3000, 'its size from the listing (exact bytes)');
    eq(
      [byName['notes.txt']?.addedBy, byName['notes.txt']?.size, byName['notes.txt']?.type, typeof byName['notes.txt']?.addedAt],
      ['a', 5, 'text/plain', 'number'],
      'an engine upload: exact size, type, adder, time',
    );
    eq(byName['pic.png']?.url, `${SHARE}/raw/${want}/pic.png`, 'url = the agent-share reference');

    console.log('\n[raw]');
    let fr = await fetch(`${BASE}${R}/assets/raw/pic.png`, { headers: authHeaders('agent') });
    eq(fr.status, 200, 'any room reader: 200');
    ok(Buffer.from(await fr.arrayBuffer()).equals(png), 'the bytes');
    eq(
      [fr.headers.get('content-type'), fr.headers.get('content-security-policy'), fr.headers.get('x-content-type-options')],
      ['image/png', 'sandbox', 'nosniff'],
      'type passed through; OUR CSP sandbox + nosniff (the share\'s CSP is not)',
    );
    fr = await fetch(`${BASE}${R}/assets/raw/${encodeURIComponent(accented)}`, { method: 'HEAD', headers: { cookie } });
    eq([fr.status, fr.headers.get('content-length')], [200, '6'], 'HEAD with a cookie, non-ASCII name');
    fr = await fetch(`${BASE}${R}/assets/raw/nope.png`, { headers: authHeaders('agent') });
    eq(fr.status, 404, 'a missing asset: 404');
    fr = await fetch(`${BASE}${R}/assets/raw/pic.png`, { headers: authHeaders('agent') });
    eq(fr.headers.get('content-disposition'), "inline; filename*=UTF-8''pic.png", 'our own disposition (RFC 5987 name)');
    fr = await fetch(`${BASE}${R}/assets/raw/pic.png`);
    eq(fr.status, 401, 'no credential: 401');

    console.log('\n[the line]');
    const line = (await call(`${R}/line?kind=fact`)).body?.entries?.map((e) => e.body) ?? [];
    for (const f of ['user added pic.png', 'user added pic-1.png', '@a added notes.txt']) {
      ok(line.includes(f), `fact on the line: ${f}`);
    }

    console.log('\n[archived]');
    await call(`${R}/archive`, { json: {}, as: 'person' });
    r = await put(`${R}/assets`, 'late.txt', Buffer.from('x'));
    eq([r.status, r.body?.field], [409, 'state'], 'an archived room takes no assets');
    eq((await call(`${R}/assets`)).status, 200, 'but still lists them');
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
