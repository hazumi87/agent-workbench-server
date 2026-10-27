/**
 * The polled routes' wire shape [perf/poll-traffic] through a real scratch
 * engine over a table shaped like Owner's (test/traffic.seed.ts: 144 rows, 17
 * logo sets at ~18 KB, 3 rooms with art):
 *
 *   - GET /api/table rows carry `logo` WITHOUT its svg plus `logoKey`;
 *     `?logo=full` answers the old shape.
 *   - GET /api/rooms and /api/rooms/:id with `?art=ref` carry art_render
 *     {key, name, style, hash} and no svg; without it, the svg as before.
 *   - GET /api/art/:key: the art by key, ETag'd, immutable for its own hash.
 *
 * SAFETY: scratch engine P(250), dead broker P(251), temp table, childEnv();
 * never :7420/:7430/:8200/:8201/:8204. The temp dir is removed.
 */
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(250);
const DEAD_BROKER_PORT = P(251);
const HOST = '127.0.0.1';
const TOKEN = 'poll-traffic-test-token';

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

/** A raw GET: the bytes as they crossed the wire (no transparent gunzip). */
function raw(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: HOST, port: PORT, path, method: 'GET', headers: { authorization: `Bearer ${TOKEN}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = res.headers['content-encoding'] === 'gzip' ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
        let body = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode, headers: res.headers, bytes: buf.length, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
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

async function run() {
  for (const p of [PORT, DEAD_BROKER_PORT]) {
    await assertFree(p, 'poll-traffic.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-poll-traffic-'));
  const dbPath = join(tmpDir, 'mapping.db');
  let engine = null;
  let engineLog = '';
  const seed = async (phase) => {
    const r = await runTsx([join('test', 'traffic.seed.ts'), phase], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) {
      throw new Error(`seed ${phase} failed: ${r.err}`);
    }
    return JSON.parse(r.out.trim().split('\n').pop());
  };
  try {
    await seed('pre');
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
      }),
    });
    engine.stdout.on('data', (d) => (engineLog += d));
    engine.stderr.on('data', (d) => (engineLog += d));
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      await sleep(250);
      try {
        up = (await fetch(`http://${HOST}:${PORT}/health`)).ok;
      } catch {
        /* not yet */
      }
    }
    ok(up, `scratch engine is serving on :${PORT}`);
    if (!up) {
      throw new Error('engine never came up');
    }
    const post = await seed('post');
    const R = post.rooms[0].id;

    console.log('\n[/api/table: the logo by key]');
    let t = await raw('/api/table');
    eq(t.status, 200, '/api/table: 200');
    eq(t.body.sessions.length, 144, '144 rows');
    const withLogo = t.body.sessions.filter((r) => r.logo);
    ok(withLogo.length > 30, `rows with a logo pref (${withLogo.length})`);
    ok(withLogo.every((r) => !('svg' in JSON.parse(r.logo))), 'no row logo carries its svg');
    ok(withLogo.every((r) => /^lib:\d+$/.test(r.logoKey) && JSON.parse(r.logo).key === r.logoKey), 'logoKey = the logo\'s key');
    ok(withLogo.every((r) => { const o = JSON.parse(r.logo); return o.scale === 60 && o.opacity === 12 && o.mono === 'white'; }), 'the rest of the pref rides along (scale, opacity, mono)');
    ok(t.body.sessions.filter((r) => !r.logo).every((r) => r.logoKey === null), 'no logo: logoKey null');
    const full = await raw('/api/table?logo=full');
    ok(full.body.sessions.filter((r) => r.logo).every((r) => /^<svg/.test(JSON.parse(r.logo).svg)), '?logo=full: the old shape, svg included');
    const slimText = JSON.stringify(t.body);
    ok(slimText.length < JSON.stringify(full.body).length / 4, `the slim table is a fraction of the full one (${slimText.length} vs ${JSON.stringify(full.body).length} chars)`);

    console.log('\n[/api/rooms ?art=ref: the art by reference]');
    const listFull = await raw('/api/rooms');
    const artFull = listFull.body.find((v) => v.room.id === R).room.art_render;
    ok(/^<svg/.test(artFull?.svg ?? '') && /^[0-9a-f]{16}$/.test(artFull?.hash ?? ''), 'no opt-in: art_render carries the svg (and now its hash)');
    const listRef = await raw('/api/rooms?art=ref');
    const artRef = listRef.body.find((v) => v.room.id === R).room.art_render;
    eq(artRef && Object.keys(artRef).sort(), ['hash', 'key', 'name', 'style'], '?art=ref: {key, name, style, hash}, no svg');
    eq(artRef?.hash, artFull?.hash, '...the same hash');
    const one = await raw(`/api/rooms/${R}?art=ref`);
    ok(one.status === 200 && one.body.room.art_render && !('svg' in one.body.room.art_render), 'GET /api/rooms/:id?art=ref: no svg');
    ok(Array.isArray(one.body.seats) && one.body.seats.length === 4, '...the rest of the view unchanged (4 seats)');
    const oneFull = await raw(`/api/rooms/${R}`);
    ok(/^<svg/.test(oneFull.body.room.art_render?.svg ?? ''), 'GET /api/rooms/:id without it: svg as before');

    console.log('\n[GET /api/art/:key]');
    const key = encodeURIComponent(artRef.key);
    const a = await raw(`/api/art/${key}?h=${artRef.hash}`);
    eq(a.status, 200, 'the art by key: 200');
    eq(a.body?.svg, artFull.svg, '...the svg as authored');
    eq(a.body?.hash, artRef.hash, '...and its hash');
    ok(/immutable/.test(a.headers['cache-control'] ?? '') && /max-age=31536000/.test(a.headers['cache-control'] ?? ''), `the current hash: cached a year, immutable (${a.headers['cache-control']})`);
    ok(typeof a.headers.etag === 'string' && a.headers.etag.includes(artRef.hash), `an ETag naming the hash (${a.headers.etag})`);
    const a304 = await raw(`/api/art/${key}?h=${artRef.hash}`, { 'if-none-match': a.headers.etag });
    eq([a304.status, a304.bytes], [304, 0], 'If-None-Match: 304, no body');
    const stale = await raw(`/api/art/${key}?h=0000000000000000`);
    ok(stale.status === 200 && /no-cache/.test(stale.headers['cache-control'] ?? ''), 'a stale hash: the current art, revalidated (no-cache)');
    eq((await raw('/api/art/lib%3A999999')).status, 404, 'a key that names nothing: 404');
    eq((await raw('/api/art/speech')).status, 200, 'an design-system preset key: 200');
    const unauth = await fetch(`http://${HOST}:${PORT}/api/art/${key}`);
    ok(unauth.status === 401 || unauth.status === 302, `below the auth gate (${unauth.status})`);

    console.log('\n[ETag + 304 + gzip on the polled JSON]');
    t = await raw('/api/table', { 'accept-encoding': 'gzip, deflate, br' });
    eq(t.headers['content-encoding'], 'gzip', '/api/table: gzip when the client takes it');
    const plain = await raw('/api/table', { 'accept-encoding': 'identity' });
    ok(!plain.headers['content-encoding'], '...plain when it does not');
    ok(t.bytes < plain.bytes / 3, `...gzip is a fraction on the wire (${t.bytes} vs ${plain.bytes} bytes)`);
    ok(!(await raw('/api/table', { 'accept-encoding': 'gzip;q=0' })).headers['content-encoding'], '...and gzip;q=0 is honoured (plain)');
    eq(plain.body.sessions.length, t.body.sessions.length, '...the same body either way');
    ok(/^W\/"[0-9a-f]{20}"$/.test(t.headers.etag ?? ''), `an ETag (${t.headers.etag})`);
    eq(t.headers.etag, plain.headers.etag, '...one tag for both encodings (weak)');
    eq(t.headers['cache-control'], 'private, no-cache', 'cache-control: private, no-cache (revalidate every poll)');
    ok(/accept-encoding/i.test(t.headers.vary ?? ''), 'Vary: accept-encoding');
    let r304 = await raw('/api/table', { 'if-none-match': t.headers.etag, 'accept-encoding': 'gzip' });
    eq([r304.status, r304.bytes], [304, 0], 'an unchanged table: 304, no body');
    eq(r304.headers.etag, t.headers.etag, '...naming the same tag');
    await seed('bump');
    const bumped = await raw('/api/table', { 'if-none-match': t.headers.etag });
    ok(bumped.status === 200 && bumped.headers.etag !== t.headers.etag && bumped.body.sessions.length === 145, 'a changed table: 200, a new tag, the new row');
    for (const path of ['/api/rooms?art=ref', `/api/rooms/${R}?art=ref`, `/api/rooms/${R}/line?limit=50`, '/api/recipes']) {
      const first = await raw(path, { 'accept-encoding': 'gzip' });
      const again = await raw(path, { 'if-none-match': first.headers.etag, 'accept-encoding': 'gzip' });
      ok(first.status === 200 && typeof first.headers.etag === 'string' && again.status === 304 && again.bytes === 0, `${path}: ETag, then 304 (${first.bytes} B, then ${again.bytes})`);
    }
    const bigRooms = await raw('/api/rooms', { 'accept-encoding': 'gzip' });
    eq(bigRooms.headers['content-encoding'], 'gzip', '/api/rooms: gzip');
    const missing = await raw('/api/rooms/no-such-room', { 'if-none-match': '*' });
    eq(missing.status, 404, 'an error is never a 304 (If-None-Match: * on a 404)');
  } catch (e) {
    failed++;
    failures.push(String(e?.stack ?? e));
    console.log(`  X threw: ${e?.stack ?? e}`);
  } finally {
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
