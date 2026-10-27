/** Pre-send image markup: real scratch engine, private temp DB/scratch directory,
 * dead broker and owned stub file-store only. No production routes or PTYs.
 * Reuses room-attach's allocated slots and launcher; run these suites serially.
 * Strong ETags, own-room binding, conditional write, folded counts and renamed
 * companion movement are asserted through HTTP, never a fake page bridge.
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
async function attach(roomPath, name, bytes, { as = 'person', type = 'application/octet-stream', query = '', key = null, pos = null, companionOf = null } = {}) {
  const headers = {
    ...authHeaders(as),
    'content-type': type,
    'x-filename': encodeURIComponent(name),
    ...(key ? { 'x-upload-key': key } : {}),
    ...(companionOf ? { 'x-companion-of': companionOf } : {}),
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


    const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>');
    const png=Buffer.from([0x89,0x50,0x4e,0x47,9,9]);
    const picture=(await attach(R,'photo.png',png,{type:'image/png'})).body.file;
    const create=()=>attach(R,'photo.png.annotations.svg',svg,{type:'image/svg+xml',companionOf:picture.id});
    let r=await create();eq(r.status,200,'create companion');const companion=r.body?.file||{};
    eq(companion.companionOf,picture.id,'binding names picture id');ok(/^"[a-f0-9]{64}"$/.test(companion.etag),'create has strong ETag');
    eq((await create()).status,409,'duplicate companion refuses');
    eq((await attach(R,'wrong.svg',svg,{type:'image/svg+xml',companionOf:picture.id})).status,400,'wrong name refuses');
    eq((await attach(R2,'photo.png.annotations.svg',svg,{type:'image/svg+xml',companionOf:picture.id})).status,400,'picture not owned in this room refuses');
    const raw=await fetch(BASE+`${R}/scratch/${companion.id}`,{headers:authHeaders('person')});
    eq(raw.status,200,'companion read');eq(raw.headers.get('etag'),companion.etag,'GET ETag matches bytes');
    ok((raw.headers.get('content-disposition')||'').startsWith('attachment'),'SVG forced attachment');
    ok(raw.headers.get('content-type')!=='image/svg+xml','SVG never inline');await raw.arrayBuffer();
    const replace=async(id,bytes,tag,as='person')=>{const res=await fetch(BASE+`${R}/scratch/${id}`,{method:'PUT',headers:{...authHeaders(as),'content-type':'image/svg+xml',...(tag?{'if-match':tag}:{})},body:bytes});return{status:res.status,body:await res.json().catch(()=>null)};};
    r=await replace(companion.id,Buffer.from('<svg>second</svg>'),null);eq(r.status,428,'If-Match required');
    r=await replace(companion.id,Buffer.from('<svg>second</svg>'),companion.etag);eq(r.status,200,'fresh replace');
    let second=r.body?.file?.etag;ok(second!==companion.etag,'replace ETag changes');
    eq((await replace(companion.id,svg,companion.etag)).status,412,'stale replace refuses');
    const race=await Promise.all([replace(companion.id,Buffer.from('<svg>race-a</svg>'),second),replace(companion.id,Buffer.from('<svg>race-b</svg>'),second)]);
    eq(race.map(x=>x.status).sort(),[200,412],'two writers with one revision cannot both win');second=race.find(x=>x.status===200)?.body?.file?.etag;
    eq((await replace(picture.id,svg,picture.etag)).status,404,'picture cannot be replaced');
    eq((await replace(companion.id,svg,second,'agent')).status,403,'bearer cannot replace');
    r=await replace(companion.id,Buffer.from([0xff,0x00]),second);eq(r.status,400,'binary refuses');
    r=await replace(companion.id,Buffer.alloc(256*1024+1,65),second);eq(r.status,400,'oversize companion refuses before save');
    const listed=(await call(`${R}/scratch`)).body;
    eq(listed.count,1,'count excludes companion');eq(listed.files.filter(f=>!f.companionOf).length,1,'tray pictures exclude companion');
    const more1=(await attach(R,'other.png',png,{type:'image/png'})).body?.file;
    const more2=(await attach(R,'third.png',png,{type:'image/png'})).body?.file;
    ok(more1&&more2,'companion does not consume MAX_COUNT');
    await call(`${R}/scratch/${more1.id}`,{method:'DELETE'});await call(`${R}/scratch/${more2.id}`,{method:'DELETE'});
    // Force a picture-name collision in the room's assets before sending.
    shareFs.set(folder,[{name:'photo.png',bytes:png,mtime:clock++}]);
    r=await call(`${R}/line`,{json:{text:'@a marked picture',attachments:[picture.id]}});
    eq(r.status,200,'send picture with implicit companion');
    const entry=r.body?.entries?.find(e=>e.kind==='attachment');
    const meta=typeof entry?.meta==='string'?JSON.parse(entry.meta):entry?.meta;const sent=meta?.attachments||[];
    eq(sent.length,1,'one tile, no companion in meta.attachments');
    eq(sent[0]?.name,'photo-1.png','picture collision uses final name');
    eq(sent[0]?.annotations,true,'the sent picture carries annotations:true (the page draws the pencil)');
    ok(shareFs.get(folder)?.some(f=>f.name==='photo-1.png.annotations.svg'),'companion follows renamed picture');
    eq((await call(`${R}/scratch`)).body?.files,[],'send cleans picture and companion rows');
    const assets=(await call(`${R}/assets`)).body?.assets||[];ok(!assets.some(f=>f.name.endsWith('.annotations.svg')),'companion is folded out of asset tiles/count');
    const p2=(await attach(R,'delete.png',png,{type:'image/png'})).body.file;
    const c2=(await attach(R,'delete.png.annotations.svg',svg,{type:'image/svg+xml',companionOf:p2.id})).body.file;
    await call(`${R}/scratch/${p2.id}`,{method:'DELETE'});
    eq((await call(`${R}/scratch/${c2.id}`)).status,404,'picture removal cascades companion');
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
