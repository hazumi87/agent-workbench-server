/**
 * ROOM FILES (web-first pilot): the per-room folder on the server, against a REAL engine. Sign-in only, person writes, conditional PUT (428/412), uploads that never overwrite,
 * names that cannot leave the folder, a 50 MB limit that names both numbers, files served with nosniff + sandbox and attachment for anything that is not text/image/pdf.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { rmSync, mkdtempSync, mkdirSync, symlinkSync, existsSync, statSync, writeFileSync, utimesSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(574);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'room-files-test-token';
let passed = 0;
let failed = 0;
const ok = (c, m, d) => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}${d !== undefined ? ` (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await assertFree(PORT, 'room-files.test.mjs');
await assertFree(P(575), 'room-files.test.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'wb-rfiles-'));
const filesDir = join(tmp, 'files');
const outside = join(tmp, 'outside');
mkdirSync(outside, { recursive: true });
let log = '';
const engine = spawn(process.execPath, ['--import', join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs'), 'src/server/index.ts'], {
  cwd: REPO_ROOT,
  env: childEnv({
    HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: join(tmp, 'mapping.db'), HARBOR_WB_TOKEN: TOKEN, HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_FILES_DIR: filesDir,
    HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(P(575)), HARBOR_WB_BROKERS: '{}', HARBOR_WB_NO_WINDOW: '1',
    HARBOR_WB_CLAUDE_PROJECTS: join(tmp, 'claude-projects'),
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
engine.stdout.on('data', (d) => (log += d));
engine.stderr.on('data', (d) => (log += d));
try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    up = await fetch(`${BASE}/health`).then((r) => r.ok, () => false);
    if (!up) await sleep(250);
  }
  if (!up) throw new Error(`engine did not come up\n${log}`);
  const cookie = await windowCookie(BASE, TOKEN);
  const person = { cookie };
  const agent = { authorization: `Bearer ${TOKEN}` };
  const mkRoom = await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { ...person, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Files Room' }) });
  const room = (await mkRoom.json()).id;
  ok(!!room, 'setup: a room exists', room);
  const url = (p = '') => `${BASE}/api/rooms/${room}/files${p}`;

  console.log('\n[list, create, read]');
  let r = await fetch(url('?dir=files'), { headers: person });
  ok(r.status === 200 && (await r.json()).entries.length === 0, 'an empty room folder lists nothing');
  ok((await fetch(url('?dir=secrets'), { headers: person })).status === 400, 'an unknown folder: 400');
  const put1 = await fetch(url('/notes/plan.md'), { method: 'PUT', headers: { ...person, 'if-none-match': '*' }, body: 'v1' });
  const j1 = await put1.json();
  ok(put1.status === 200 && j1.size === 2 && typeof j1.mtime === 'number' && typeof j1.etag === 'string', 'a person creates a note (If-None-Match: *); the answer has size, mtime (epoch ms) and etag', j1);
  const filePath = join(filesDir, 'rooms', room, 'notes', 'plan.md');
  ok(existsSync(filePath) && (statSync(filePath).mode & 0o777) === 0o640, 'it is on disk under <FILES_DIR>/rooms/<room>/notes/, mode 0640');
  const get1 = await fetch(url('/notes/plan.md'), { headers: person });
  ok(get1.status === 200 && (await get1.text()) === 'v1' && get1.headers.get('etag') === j1.etag, 'GET returns the bytes and the same ETag');
  ok(get1.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(get1.headers.get('content-security-policy') ?? ''), 'served with nosniff and a sandbox CSP');
  r = await fetch(url('?dir=notes'), { headers: person });
  const l1 = (await r.json()).entries;
  ok(l1.length === 1 && l1[0].name === 'plan.md' && l1[0].kind === 'file' && l1[0].etag === j1.etag, 'the listing shows it with the same etag');
  ok((await fetch(url('/notes/plan.md'))).status === 401, 'unauthenticated: 401');

  console.log('\n[conditional write: tabs cannot overwrite newer text]');
  const noHdr = await fetch(url('/notes/plan.md'), { method: 'PUT', headers: person, body: 'v2' });
  ok(noHdr.status === 428, 'overwrite without If-Match: 428 precondition-required', noHdr.status);
  const stale = await fetch(url('/notes/plan.md'), { method: 'PUT', headers: { ...person, 'if-match': '"1-1"' }, body: 'v2' });
  const sj = await stale.json();
  ok(stale.status === 412 && sj.error === 'changed' && sj.etag === j1.etag, 'a stale If-Match: 412 changed, with the current etag', sj);
  const createAgain = await fetch(url('/notes/plan.md'), { method: 'PUT', headers: { ...person, 'if-none-match': '*' }, body: 'x' });
  ok(createAgain.status === 412, 'create (If-None-Match: *) of an existing file: 412');
  const good = await fetch(url('/notes/plan.md'), { method: 'PUT', headers: { ...person, 'if-match': j1.etag }, body: 'version two' });
  const gj = await good.json();
  ok(good.status === 200 && gj.size === 11 && gj.etag !== j1.etag, 'the matching If-Match writes and returns a new etag', gj);
  {
    const cur = (await (await fetch(url('?dir=notes'), { headers: person })).json()).entries[0].etag;
  /* two held requests with ONE etag: the body is streamed slowly, so both pass the early check; only one may write */
  const slowPut = (text) => new Promise((resolve, reject) => {
    const u = new URL(url('/notes/plan.md'));
    const rq = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'PUT', headers: { ...person, 'if-match': cur, 'content-type': 'text/plain', 'content-length': String(text.length) } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    rq.on('error', reject);
    rq.write(text.slice(0, 1));
    setTimeout(() => rq.end(text.slice(1)), 400);
  });
  const raced = await Promise.all([slowPut('AAAA'), slowPut('BBBB')]);
  ok(raced.slice().sort().join() === '200,412', 'two slow PUTs with the same If-Match: exactly one wins, the other gets 412', raced);
  const afterRace = await (await fetch(url('/notes/plan.md'), { headers: person })).text();
  ok(afterRace === 'AAAA' || afterRace === 'BBBB', 'and the file holds exactly one of them', afterRace);
  {
    /* a same-size rewrite must still change the etag, and a held editor must not recreate a deleted file */
    const e0 = (await (await fetch(url('?dir=notes'), { headers: person })).json()).entries[0].etag;
    ok(/^"[0-9a-f]{64}"$/.test(e0), 'the etag is a quoted SHA-256', e0);
    const same = await fetch(url('/notes/plan.md'), { method: 'PUT', headers: { ...person, 'if-match': e0 }, body: afterRace === 'AAAA' ? 'BBBB' : 'AAAA' });
    const sj2 = await same.json();
    ok(same.status === 200 && sj2.etag !== e0, 'a same-length rewrite changes the etag', sj2);
    await fetch(url('/notes/plan.md'), { method: 'DELETE', headers: { ...person, 'if-match': sj2.etag } });
    const ghost = await fetch(url('/notes/plan.md'), { method: 'PUT', headers: { ...person, 'if-match': sj2.etag }, body: 'back from the dead' });
    ok(ghost.status === 412, 'If-Match on a file that was deleted meanwhile: 412, not a recreate', ghost.status);
    /* a native edit that keeps the size AND restores the mtime must still change the authoritative etag (no metadata-only reuse) */
    const target = join(filesDir, 'rooms', room, 'notes', 'native.txt');
    writeFileSync(target, 'AAAA');
    const before = statSync(target);
    const g1 = await fetch(url('/notes/native.txt'), { headers: person });
    const e1 = g1.headers.get('etag');
    await g1.arrayBuffer();
    await fetch(url('?dir=notes'), { headers: person }); // a listing caches (path,size,mtime)
    writeFileSync(target, 'BBBB');
    utimesSync(target, before.atime, before.mtime);
    const g2 = await fetch(url('/notes/native.txt'), { headers: person });
    ok(e1 && g2.headers.get('etag') !== e1, 'same size + restored mtime: the GET etag still changes', [e1, g2.headers.get('etag')]);
    await g2.arrayBuffer();
    const fresh = await fetch(url('/notes/plan.md'), { method: 'PUT', headers: { ...person, 'if-none-match': '*' }, body: 'new' });
    ok(fresh.status === 200, 'a create with If-None-Match: * still works', fresh.status);
  }
  }

  console.log('\n[person only]');
  ok((await fetch(url('/notes/a.md'), { method: 'PUT', headers: agent, body: 'x' })).status === 403, 'an agent (bearer) cannot write: 403');
  ok((await fetch(url('/notes/plan.md'), { method: 'DELETE', headers: agent })).status === 403, '...or delete: 403');
  ok((await fetch(url('/notes/plan.md'), { headers: agent })).status === 200, 'but a signed-in reader (bearer) can read');

  console.log('\n[uploads never overwrite]');
  const up1 = await fetch(url('/files'), { method: 'POST', headers: { ...person, 'x-filename': 'pic.png' }, body: 'PNGDATA' });
  const up2 = await fetch(url('/files'), { method: 'POST', headers: { ...person, 'x-filename': 'pic.png' }, body: 'PNGDATA2' });
  ok((await up1.json()).name === 'pic.png' && (await up2.json()).name === 'pic-1.png', 'the second upload of pic.png is pic-1.png');
  const svg = await fetch(url('/files'), { method: 'POST', headers: { ...person, 'x-filename': 'logo.svg' }, body: '<svg onload=alert(1)/>' });
  ok(svg.status === 200, 'an svg uploads');
  const gsvg = await fetch(url('/files/logo.svg'), { headers: person });
  ok(/attachment/.test(gsvg.headers.get('content-disposition') ?? '') && gsvg.headers.get('content-type') === 'application/octet-stream', 'an svg (not in the inline list) is served as an attachment, never rendered');
  const gpng = await fetch(url('/files/pic.png'), { headers: person });
  ok(gpng.headers.get('content-type') === 'image/png' && !gpng.headers.get('content-disposition'), 'a png is served inline');

  console.log('\n[names cannot leave the folder]');
  for (const bad of ['..%2fx', 'a%5cb', '.hidden']) {
    const rb = await fetch(url(`/notes/${bad}`), { method: 'PUT', headers: person, body: 'x' });
    ok(rb.status === 400, `PUT ${bad}: 400`, rb.status);
  }
  const hx = await fetch(url('/files'), { method: 'POST', headers: { ...person, 'x-filename': '../evil.txt' }, body: 'x' });
  ok(hx.status === 400, 'an upload name with ..: 400');
  mkdirSync(join(filesDir, 'rooms', room, 'files'), { recursive: true });
  symlinkSync(outside, join(filesDir, 'rooms', room, 'files', 'link'));
  ok((await fetch(url('/files/link/x.txt'), { method: 'PUT', headers: person, body: 'x' })).status === 403, 'writing through a symlink that leaves the room folder: 403');
  ok(!existsSync(join(outside, 'x.txt')), '...and nothing was written outside');

  console.log('\n[adversarial regressions (builder-three-2, d39f904): 1 nested name, 2 a refusal leaves nothing, 3 the room root cannot be swapped for a link]');
  const nested = await fetch(url('/files'), { method: 'POST', headers: { ...person, 'x-filename': 'a%2Fchild.txt' }, body: 'upload' });
  ok(nested.status === 400 && !existsSync(join(filesDir, 'rooms', room, 'files', 'a')), '1: a nested x-filename is refused (400) and nothing is created');
  const deep = await fetch(url('/files/link/created-by-attack/new.txt'), { method: 'PUT', headers: person, body: 'attack' });
  ok(deep.status === 403 && !existsSync(join(outside, 'created-by-attack')), '2: a PUT through a symlink to outside answers 403 and creates NO directory outside', deep.status);
  const roomDir = join(filesDir, 'rooms', room);
  const aside = `${roomDir}-aside`;
  const outsideRoot = join(tmp, 'outside-root');
  mkdirSync(join(outsideRoot, 'files'), { recursive: true });
  writeFileSync(join(outsideRoot, 'files', 'secret.txt'), 'outside-sentinel');
  renameSync(roomDir, aside);
  symlinkSync(outsideRoot, roomDir);
  const swapped = await fetch(url('/files/secret.txt'), { headers: person });
  ok(swapped.status !== 200 && !(await swapped.text()).includes('outside-sentinel'), '3: a room folder replaced by a symlink to elsewhere serves nothing from there', swapped.status);
  const swappedPut = await fetch(url('/files/new-through-root.txt'), { method: 'PUT', headers: person, body: 'x' });
  ok(swappedPut.status === 403 && !existsSync(join(outsideRoot, 'files', 'new-through-root.txt')), '3: and a write through the swapped root is refused and lands nowhere outside');
  rmSync(roomDir);
  renameSync(aside, roomDir);

  console.log('\n[size limit names both numbers; delete]');
  const big = await fetch(url('/files/big.bin'), { method: 'PUT', headers: { ...person, 'content-type': 'application/octet-stream' }, body: Buffer.alloc(51 * 1024 * 1024) });
  const bj = await big.json();
  ok(big.status === 413 && /52428800/.test(bj.error) && bj.max === 50 * 1024 * 1024, '51 MB: 413 naming the size and the 50 MB limit', bj);
  const del = await fetch(url('/notes/plan.md'), { method: 'DELETE', headers: person });
  ok(del.status === 200 && !existsSync(filePath), 'a person deletes a file');
  ok((await fetch(url('/notes/plan.md'), { headers: person })).status === 404, '...and it is gone: 404');
  ok((await fetch(`${BASE}/api/rooms/nope/files?dir=files`, { headers: person })).status === 404, 'an unknown room: 404');
} catch (e) {
  failed++;
  console.log(`  X  threw: ${e?.stack ?? e}`);
} finally {
  engine.kill('SIGKILL');
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
