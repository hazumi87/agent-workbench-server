/**
 * The asset picker's LIBRARY PROXY through a real scratch engine [asset picker,
 * Owner 2026-10-05]: GET /api/library/images?offset=N and /api/library/thumb/:id.
 * What it must hold: auth required; paging is the engine's (9 at a time,
 * whatever the caller asks); the id is validated BEFORE anything goes
 * upstream; only the two upstream paths are ever requested; an upstream
 * failure or silence is a 502 with words, never an empty list.
 *
 * SAFETY: scratch engine P(361), dead broker P(362), stub library P(363),
 * temp table, childEnv(); HARBOR_WB_LIBRARY_URL points at the stub, never at
 * the real gateway on :8260.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(361);
const DEAD_BROKER_PORT = P(362);
const LIB_PORT = P(363);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'library-proxy-test-token';
const TOTAL = 25;

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

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
let mode = 'ok'; // ok | fail | hang | junk
const hits = []; // every upstream request line
const stub = createServer((req, res) => {
  hits.push(req.url);
  const u = new URL(req.url ?? '/', `http://${HOST}`);
  const pre = '/asset-management/library/api/assets';
  if (mode === 'hang') {
    return; // never answers
  }
  if (mode === 'fail') {
    res.writeHead(500, { 'content-type': 'text/plain' });
    return res.end('boom');
  }
  if (u.pathname === pre) {
    if (mode === 'junk') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"nope":1}');
    }
    const limit = Number(u.searchParams.get('limit'));
    const offset = Number(u.searchParams.get('offset'));
    const assets = [];
    for (let i = offset; i < Math.min(offset + limit, TOTAL); i++) {
      assets.push({ id: `img-${i}`, label: `Image ${i}`, created_at: 1000 - i, category: 'image', secret_path: '/srv/x' });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ assets, total: TOTAL, limit, offset }));
  }
  const m = /^\/asset-management\/library\/api\/assets\/([^/]+)\/thumb$/.exec(u.pathname);
  if (m) {
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    return res.end(JPEG);
  }
  res.writeHead(404);
  res.end('no');
});

let cookie = '';
async function get(path, { as = 'person' } = {}) {
  const headers = as === 'person' ? { cookie } : as === 'agent' ? { authorization: `Bearer ${TOKEN}` } : {};
  const res = await fetch(BASE + path, { headers });
  const buf = Buffer.from(await res.arrayBuffer());
  let body = null;
  try {
    body = JSON.parse(buf.toString('utf8'));
  } catch {
    /* bytes */
  }
  return { status: res.status, body, buf, type: res.headers.get('content-type') };
}

async function run() {
  for (const p of [PORT, DEAD_BROKER_PORT, LIB_PORT]) {
    await assertFree(p, 'library-proxy.test.mjs');
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-library-proxy-'));
  let engine = null;
  let engineLog = '';
  await new Promise((r) => stub.listen(LIB_PORT, HOST, r));
  try {
    const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
    engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_PORT: String(PORT),
        HARBOR_WB_HOST: HOST,
        HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'),
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
        HARBOR_WB_LIBRARY_URL: `http://${HOST}:${LIB_PORT}/asset-management/library`,
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

    console.log('\n[auth]');
    let r = await get('/api/library/images', { as: 'none' });
    ok(r.status === 401 || r.status === 302 || r.status === 403, `no credential: refused (${r.status})`);
    r = await get('/api/library/thumb/img-1', { as: 'none' });
    ok(r.status === 401 || r.status === 302 || r.status === 403, `no credential, thumb: refused (${r.status})`);
    eq(hits.length, 0, 'and nothing went upstream');

    console.log('\n[paging]');
    r = await get('/api/library/images');
    eq([r.status, r.body?.assets?.length, r.body?.total, r.body?.limit, r.body?.offset], [200, 9, TOTAL, 9, 0], 'first page: 9 of 25, offset 0');
    eq(r.body?.assets?.[0], { id: 'img-0', label: 'Image 0', created_at: 1000, category: 'image' }, 'only the fields the picker draws (no upstream extras)');
    r = await get('/api/library/images?offset=9');
    eq([r.body?.assets?.[0]?.id, r.body?.assets?.length, r.body?.offset], ['img-9', 9, 9], 'offset 9: the second page');
    r = await get('/api/library/images?offset=18&limit=500');
    eq([r.body?.assets?.length, r.body?.limit], [7, 9], 'the last page is short; a caller limit is ignored (the engine pages)');
    ok(hits.every((h) => /limit=9/.test(h) || /\/thumb$/.test(h)), 'upstream was only ever asked for 9');
    r = await get('/api/library/images?offset=-1');
    eq([r.status, r.body?.field], [400, 'offset'], 'a negative offset: 400');
    r = await get('/api/library/images?offset=abc');
    eq([r.status, r.body?.field], [400, 'offset'], 'a non-number offset: 400');
    r = await get('/api/library/images', { as: 'agent' });
    eq(r.status, 200, 'the bearer reads too');

    console.log('\n[thumb + id validation]');
    const before = hits.length;
    r = await get('/api/library/thumb/img-3');
    eq([r.status, r.type, [...r.buf.subarray(0, 2)]], [200, 'image/jpeg', [0xff, 0xd8]], 'a thumb: the JPEG bytes');
    for (const bad of ['a.b', '..', '%2e%2e', 'a%2Fb', 'x'.repeat(65), 'a%20b', '%00']) {
      r = await get(`/api/library/thumb/${bad}`);
      ok(r.status === 400 || r.status === 404, `id ${JSON.stringify(bad.slice(0, 12))}: refused (${r.status})`);
    }
    eq(hits.length, before + 1, 'no bad id went upstream');
    r = await get('/api/library/anything-else');
    eq(r.status, 404, 'any other /api/library path: 404 (not a generic proxy)');
    r = await get('/api/library/thumb/img-3/extra');
    eq(r.status, 404, 'a longer thumb path: 404');
    const post = await fetch(`${BASE}/api/library/images`, { method: 'POST', headers: { cookie } });
    eq(post.status, 405, 'POST: 405');
    ok(hits.every((h) => h.startsWith('/asset-management/library/api/assets')), 'every upstream call was one of the two read paths');

    console.log('\n[upstream trouble]');
    mode = 'fail';
    r = await get('/api/library/images');
    ok(r.status === 502 && /asset library/.test(r.body?.error ?? ''), `upstream 500: 502 with words (${r.body?.error})`);
    r = await get('/api/library/thumb/img-3');
    eq(r.status, 502, 'thumb, upstream 500: 502');
    mode = 'junk';
    r = await get('/api/library/images');
    ok(r.status === 502 && /not a list/.test(r.body?.error ?? ''), 'upstream nonsense: 502, not an empty list');
    mode = 'hang';
    const t0 = Date.now();
    r = await get('/api/library/images');
    const took = Date.now() - t0;
    ok(r.status === 502 && /did not answer/.test(r.body?.error ?? ''), `upstream silence: 502 with words (${r.body?.error})`);
    ok(took >= 4500 && took < 9000, `after the 5 s timeout (${took} ms)`);
    mode = 'ok';
    stub.closeAllConnections?.();
    stub.close();
    await sleep(200);
    r = await get('/api/library/images');
    ok(r.status === 502 && /not reachable/.test(r.body?.error ?? ''), `upstream down: 502 with words (${r.body?.error})`);
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
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* Windows: the engine's sqlite file may still be held open (EPERM); the temp dir is left behind */
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
