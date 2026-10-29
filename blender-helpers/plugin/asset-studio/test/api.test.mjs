/*
 * API test — no dependencies. Run: npm test
 *
 * Works on a COPY of the tool in a temp dir (never this folder's status/ or work/),
 * against a STUB image-gen on loopback: nothing here calls the real image-gen, the
 * real GPU engine or the briefing-table engine. The env is scrubbed of HARBOR_WB_* /
 * ASSET_STUDIO_* / FABRIC_* so a run from inside a pane cannot reach real services.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'asset-studio-test-')));
const MEMINFO = path.join(ROOT, 'meminfo');   // review_look reads free memory from here, so a test can starve it
const memory = (mb) => fs.writeFileSync(MEMINFO, `MemTotal: 33554432 kB\nMemAvailable: ${mb * 1024} kB\n`);
const BINDING_FILE = path.join(ROOT, 'state', 'binding.json');   // out of the tool tree, as in production
const ROOM = '3f2a9c10-aaaa-bbbb-cccc-000000000001';
const OTHER = '9e8d7c6b-aaaa-bbbb-cccc-000000000002';
const WG = '5a5a5a5a-aaaa-bbbb-cccc-000000000003'; // a workgroup of ROOM (the room family)
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(HARBOR_WB_|ASSET_STUDIO_|FABRIC_)/.test(k)));

/* ---------------------------------------------------------- stub image-gen -- */

const ig = { offline: false, generated: [], jobs: new Map(), next: 1, cancelled: [], polls: 0 };
// the briefing-table engine (room Assets + lines) and the Library, on the same stub server
const eng = { assets: [], lines: [], posts: [], uploads: [], failPosts: false, failLines: false, token: null };
// file-share (the room's files) + the Library's bin/promote, on the same stub server
const share = { files: new Map(), moves: [], canMove: false, blobs: new Map(), gz: new Set(), gzIfAsked: new Set(), ae: new Map() }; // blobs: path -> Buffer (served with its length, as a download source)
const libx = { trashed: new Set(), promoted: [], purged: new Set() };
let PNG = Buffer.from('89504e470d0a1a0a-stub', 'utf8'); // replaced by a real PNG in before() (color_match decodes it)
const indexed = []; // Library POST /assets bodies (color_match)
const MODELS = [
  { model_type: 'krea2_turbo', name: 'Krea 2 Turbo', refs: true, defaults: { num_inference_steps: 8 } },
  { model_type: 'krea2_t2i', name: 'Krea 2 (text only)', refs: false, defaults: {} },
];
function stubImageGen() {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const out = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      // ---- file-share
      if (u.pathname === '/share/api/upload' && req.method === 'POST') {
        const dir = u.searchParams.get('dir');
        const name = /filename="([^"]+)"/.exec(raw)[1];
        let p = `${dir}/${name}`;
        for (let k = 1; share.files.has(p); k++) p = `${dir}/${name.replace(/(\.\w+)$/, `-${k}$1`)}`;
        share.files.set(p, { mkdir: u.searchParams.get('mkdir') });
        return out(200, { ok: true, saved: [p] });
      }
      if (u.pathname === '/share/api/move' && req.method === 'POST') {
        if (!share.canMove) return out(404, { error: 'Not found' });
        const b = JSON.parse(raw);
        if (!share.files.has(b.from)) return out(404, { error: 'no such file' });
        const to = `${b.to_dir}/${b.from.split('/').pop()}`;
        share.files.set(to, share.files.get(b.from));
        share.files.delete(b.from);
        share.moves.push([b.from, to]);
        return out(200, { ok: true, path: to });
      }
      if (u.pathname.startsWith('/share/raw/')) {
        const p = decodeURIComponent(u.pathname.slice('/share/raw/'.length));
        if (share.blobs.has(p)) {
          const b = share.blobs.get(p);
          share.ae.set(p, req.headers['accept-encoding'] ?? null); // what the app asked for
          // gz: a source that compresses whatever the client says (a misbehaving one); gzIfAsked: one that honors accept-encoding
          const gz = share.gz.has(p) || (share.gzIfAsked.has(p) && /gzip/.test(req.headers['accept-encoding'] ?? ''));
          const body = gz ? zlib.gzipSync(b) : b;
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length, ...(gz && { 'content-encoding': 'gzip' }) });
          return res.end(body);
        }
        if (!share.files.has(p)) return out(404, { error: 'nf' });
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(PNG);
      }
      // ---- Library
      let m = u.pathname.match(/^\/lib\/clip\/([^/]+)\/(trash|revive)$/);
      if (m) {
        if (libx.purged.has(m[1])) return out(404, { error: 'not found' });
        if (m[2] === 'trash') libx.trashed.add(m[1]); else libx.trashed.delete(m[1]);
        return out(200, { ok: true });
      }
      if (u.pathname === '/lib/assets' && req.method === 'POST') {
        const b = JSON.parse(raw);
        indexed.push({ ...b, existed: fs.existsSync(b.srcPath), bytes: fs.existsSync(b.srcPath) ? fs.statSync(b.srcPath).size : 0 });
        return out(200, { ok: true, asset: { id: `lib-cm-${indexed.length}` } });
      }
      m = u.pathname.match(/^\/lib\/assets\/([^/]+)$/);
      if (m && req.method === 'GET' && m[1].startsWith('lib-missing')) return out(404, { error: 'not found' });
      if (m && req.method === 'GET' && m[1].startsWith('lib-mesh')) return out(200, { id: m[1], category: 'mesh', format: 'glb', bytes: 4096, label: `${m[1]}.glb` });
      if (m && req.method === 'GET') return out(m[1] === 'lib-audio-1' ? 200 : 200, { id: m[1], category: m[1].startsWith('lib-audio') ? 'audio' : 'image' });
      if (m && req.method === 'PATCH') {
        libx.promoted.push([m[1], JSON.parse(raw).promote]);
        return out(200, { ok: true, asset: { id: m[1] } });
      }
      m = u.pathname.match(/^\/lib\/assets\/([^/]+)\/(file|thumb)$/);
      if (m) {
        if (libx.purged.has(m[1])) return out(404, { error: 'not found' });
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(PNG);
      }
      if (u.pathname === '/lib/assets/upload' && req.method === 'POST') {
        eng.uploads.push({ dedupe: u.searchParams.get('dedupe'), size: raw.length, hasPhoto: raw.includes('PHOTO-BYTES') });
        return out(200, { ok: true, asset: { id: `lib-import-${eng.uploads.length}` } });
      }
      // ---- engine (bearer required)
      if (u.pathname === '/api/icon-lab/import' && req.method === 'POST') {
        if (req.headers.authorization !== `Bearer ${eng.token}`) return out(403, { error: 'bearer' });
        const b = JSON.parse(raw);
        eng.art = { name: b.name, pngHead: Buffer.from(b.png, 'base64').subarray(1, 4).toString() };
        return out(200, { ok: true, logo: { id: 'L1', name: b.name }, paths: 3, bytes: 1234 });
      }
      if (u.pathname === '/api/rooms') {
        if (req.headers.authorization !== `Bearer ${eng.token}`) return out(403, { error: 'bearer' });
        return out(200, [
          { room: { id: ROOM, name: 'Test Room', state: 'open' }, seats: [{ id: 'seat-1', handle: 'asset-studio', occupant_kind: 'pane', occupant: 'pane-1' }] },
          { room: { id: OTHER, name: 'Elsewhere', state: 'open' }, seats: [{ id: 'seat-9', occupant_kind: 'pane', occupant: 'pane-9' }] },
        ]);
      }
      // a room's own view: the family (a workgroup of the bound room, WG; OTHER is a separate root)
      m = u.pathname.match(/^\/api\/rooms\/([^/]+)$/);
      if (m && req.method === 'GET') {
        if (req.headers.authorization !== `Bearer ${eng.token}`) return out(403, { error: 'bearer' });
        if (m[1] === WG) return out(200, { room: { id: WG, name: 'Asset Studio', parent_id: ROOM } });
        if (m[1] === OTHER) return out(200, { room: { id: OTHER, name: 'Elsewhere', parent_id: null } });
        return out(404, { error: 'not found' });
      }
      m = u.pathname.match(/^\/api\/rooms\/([^/]+)\/(assets|line)(?:\/raw\/(.+)|\/(folder))?$/);
      if (m) {
        if (req.headers.authorization !== `Bearer ${eng.token}`) return out(403, { error: 'bearer' });
        if (m[4] === 'folder') return out(200, { folder: 'rooms/test-room-3f2a9c10', shareUrl: 'x' });
        if (m[2] === 'line') {
          if (eng.failLines) return out(500, { error: 'engine down' });
          eng.lines.push(JSON.parse(raw));
          return out(200, { status: 'posted' });
        }
        if (m[3]) {
          const a = eng.assets.find((x) => x.name === decodeURIComponent(m[3]));
          if (!a) return out(404, { error: 'no such asset' });
          res.writeHead(200, { 'content-type': a.type });
          return res.end(a.bytes);
        }
        if (req.method === 'POST') {
          if (eng.failPosts) return out(502, { error: 'file-share down' });
          const name = decodeURIComponent(req.headers['x-filename']);
          eng.posts.push({ name, from: u.searchParams.get('from_paneid'), type: req.headers['content-type'] });
          eng.assets.unshift({ name, type: req.headers['content-type'], bytes: Buffer.from(raw) });
          return out(200, { name });
        }
        return out(200, { assets: eng.assets.map((a) => ({ name: a.name, type: a.type, size: a.bytes.length, raw: `/api/rooms/${m[1]}/assets/raw/${encodeURIComponent(a.name)}`, addedBy: 'user', addedAt: a.addedAt ?? 1 })) });
      }
      // ---- image-gen
      if (!u.pathname.startsWith('/ig/api')) return out(404, { error: 'stub: unknown' });
      const p = u.pathname.replace(/^\/ig\/api/, '');
      if (p === '/health') return out(200, { ok: true, engine: { ok: !ig.offline, state: ig.offline ? 'offline' : 'not-loaded' } });
      if (ig.offline) return out(503, { ok: false, error: 'engine offline: stub' });
      if (p === '/release' && req.method === 'POST') return ig.releaseBusy ? out(409, { ok: false, error: 'busy' }) : out(200, { ok: true, freed_mib: 1234, free_vram_mb: 9000 });
      if (p === '/models') return out(200, { ok: true, models: MODELS });
      if (p === '/generate' && req.method === 'POST') {
        const b = JSON.parse(raw);
        ig.generated.push(b);
        const jobId = `job-${ig.next++}`;
        ig.jobs.set(jobId, { body: b, polls: 0, state: 'running' });
        return out(202, { ok: true, jobId, batch_id: jobId, params: { seed: 1234, width: 1024, height: 1024 } });
      }
      m = p.match(/^\/jobs\/([^/]+)$/);
      if (m) {
        const j = ig.jobs.get(m[1]);
        if (!j) return out(404, { ok: false, error: 'unknown job' });
        // running on the first poll, done on the second: n assets, one per image
        if (j.state === 'running' && ++j.polls >= 2) j.state = 'done';
        const assets = j.state === 'done'
          ? Array.from({ length: j.body.count }, (_, i) => ({ id: `${m[1]}-a${i}`, meta: { seed: 1234 + i, width: 1024, height: 1024 } }))
          : [];
        return out(200, { ok: true, job: { id: m[1], state: j.state, assets, current: j.state === 'running' ? { index: 0, state: 'generating' } : null } });
      }
      m = p.match(/^\/jobs\/([^/]+)\/cancel$/);
      if (m) {
        ig.cancelled.push(m[1]);
        const j = ig.jobs.get(m[1]);
        if (j) j.state = 'cancelled';
        return out(200, { ok: true });
      }
      m = p.match(/^\/recipe\/([^/]+)$/);
      if (m) {
        return out(200, { ok: true, kind: 'reload', recipe: { model_type: 'krea2_turbo', prompt: 'a red fox', negative_prompt: 'blur', width: 832, height: 1216, seed: 77, num_inference_steps: 8, guidance_scale: 0, refs: [] } });
      }
      out(404, { ok: false, error: `stub: no ${req.method} ${p}` });
    });
  });
}

/* --------------------------------------------------------------- harness -- */

let stub, app, base, LIB;
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

async function call(method, p, body, headers = {}) {
  const r = await fetch(base + p, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
    ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const room = (p) => `/rooms/${ROOM}${p}`;
const waitFor = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

before(async () => {
  for (const d of ['app', 'scripts', 'test']) fs.cpSync(path.join(SRC, d), path.join(ROOT, d), { recursive: true });
  for (const f of ['tool.json', 'config.example.json']) fs.copyFileSync(path.join(SRC, f), path.join(ROOT, f));
  fs.mkdirSync(path.join(ROOT, 'status'), { recursive: true });
  const igPort = await listen((stub = stubImageGen()));
  // a real 48x16 PNG: dark (hair), skin-coloured and grey (cloth) bands on white
  const png = path.join(ROOT, 'bands.png');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x1a2b3c:s=16x16', '-f', 'lavfi', '-i', 'color=c=0xe8c0a8:s=16x16',
    '-f', 'lavfi', '-i', 'color=c=0x9aa0a6:s=16x16', '-filter_complex', 'hstack=3', '-frames:v', '1', png]);
  PNG = fs.readFileSync(png);
  eng.token = 'stub-engine-token';
  fs.writeFileSync(path.join(ROOT, 'engine.token'), eng.token + '\n');
  fs.writeFileSync(path.join(ROOT, 'config.local.json'), JSON.stringify({
    imageGenUrl: `http://127.0.0.1:${igPort}/ig/api`, libraryUrl: `http://127.0.0.1:${igPort}/lib`, port: 0, defaultBudget: 12,
    engineUrl: `http://127.0.0.1:${igPort}`, engineTokenFile: path.join(ROOT, 'engine.token'), shareUrl: `http://127.0.0.1:${igPort}/share`,
    libraryStaging: path.join(ROOT, 'staging'),
    // the model domain's endpoints at the stub too (unanswered = offline): no test reaches a live service
    coreUrl: `http://127.0.0.1:${igPort}/core`, watchBase: `http://127.0.0.1:${igPort}/watch`,
  }));
  fs.mkdirSync(path.dirname(BINDING_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(BINDING_FILE, JSON.stringify({
    room_id: ROOM, room_name: 'Test Room', agent: 'asset-studio', seat_id: 'seat-1', paneid: 'pane-1', at: '2026-09-28T00:00:00Z',
  }), { mode: 0o600 });
  LIB = `http://127.0.0.1:${igPort}/lib`;
  memory(8192);
  app = spawn(process.execPath, [path.join(ROOT, 'app', 'server.mjs')], {
    cwd: ROOT, env: { ...BASE_ENV, ASSET_STUDIO_MEMINFO: MEMINFO, ASSET_STUDIO_TRACK_MS: '50', HARBOR_WB_PANEID: 'pane-1', ASSET_STUDIO_BINDING: BINDING_FILE }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const appJson = path.join(ROOT, 'status', 'app.json');
  const port = await waitFor(() => { try { return JSON.parse(fs.readFileSync(appJson, 'utf8')).port; } catch { return 0; } });
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  app?.kill('SIGTERM');
  stub?.close();
});

/* ----------------------------------------------------------------- tests -- */

test('health: up, bound room, no bytes', async () => {
  const r = await call('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.bound, { room_id: ROOM, room_name: 'Test Room' });
});

test('exclusive: another room is refused; a bad room id is 400', async () => {
  const r = await call('GET', `/rooms/${OTHER}/state`);
  assert.equal(r.status, 409);
  assert.equal(r.json.reason, 'other-room');
  assert.match(r.json.error, /Test Room/);
  assert.equal((await call('GET', '/rooms/..%2Fx/state')).status, 400);
  assert.equal((await call('POST', `/rooms/${OTHER}/generate`, {})).status, 409);
});

test('writes need content-type application/json', async () => {
  const r = await call('POST', room('/prompt'), '{"prompt":"x"}', { 'content-type': 'text/plain' });
  assert.equal(r.status, 415);
});

test('set_prompt / set_params land in get_state; aspect W:H becomes a ratio', async () => {
  let r = await call('POST', room('/prompt'), { prompt: '  a lighthouse at dusk  ', negative_prompt: 'text' });
  assert.equal(r.status, 200);
  r = await call('POST', room('/params'), { aspect: '16:9', seed: 42, draft: false, count: 2 });
  assert.equal(r.status, 200);
  const s = (await call('GET', room('/state'))).json;
  assert.equal(s.settings.prompt, 'a lighthouse at dusk');
  assert.equal(s.settings.negative_prompt, 'text');
  assert.equal(Number(s.settings.aspect).toFixed(3), (16 / 9).toFixed(3));
  assert.equal(s.settings.seed, 42);
  assert.equal(s.settings.draft, false);
  assert.equal(s.settings.count, 2);
  assert.equal((await call('POST', room('/params'), { count: 9 })).status, 400);
  assert.equal((await call('POST', room('/params'), { aspect: 'wide' })).status, 400);
  assert.equal((await call('POST', room('/params'), { draft: 'yes' })).status, 400);
});

test('set_model: must be a real model; list_models passes the catalogue through', async () => {
  const m = await call('GET', room('/models'));
  assert.deepEqual(m.json.models.map((x) => x.model_type), ['krea2_turbo', 'krea2_t2i']);
  assert.equal((await call('POST', room('/model'), { model_type: 'nope' })).status, 400);
  assert.equal((await call('POST', room('/model'), { model_type: 'krea2_turbo' })).status, 200);
});

test('set_ref only takes this room\'s images', async () => {
  const r = await call('POST', room('/refs'), { asset_id: 'someone-elses-asset' });
  assert.equal(r.status, 404);
  assert.match(r.json.error, /not one of this room's images/);
});

test('generate: answers at once, carries origin + generated_by, tracker records the outputs', async () => {
  await call('POST', room('/params'), { seed: null, count: 1, draft: true });
  const g = await call('POST', room('/generate'), { count: 2 });
  assert.equal(g.status, 202);
  assert.equal(g.json.job.state, 'running');
  const sent = ig.generated.at(-1);
  assert.equal(sent.prompt, 'a lighthouse at dusk');
  assert.equal(sent.count, 2);
  assert.equal(sent.draft, true);
  assert.equal(sent.model_type, 'krea2_turbo');
  assert.equal(sent.generated_by, 'asset-studio');
  assert.equal(sent.transient, true, 'renders go to the Library working tier');
  assert.deepEqual(sent.origin, { app: 'asset-studio', room_id: ROOM, room_name: 'Test Room', agent: 'asset-studio', seat_id: 'seat-1' });
  assert.equal('seed' in sent, false, 'seed null = let image-gen pick');
  const id = g.json.job.job_id;
  const done = await waitFor(async () => {
    const j = (await call('GET', room(`/jobs/${id}`))).json.job;
    return j.state === 'done' && j;
  });
  assert.equal(done.assets.length, 2);
  assert.equal(done.assets[0].file_url, `${LIB}/assets/${id}-a0/file`);
  assert.equal(done.assets[0].seed, 1234);
  // an output of this room is now a valid reference
  const ref = await call('POST', room('/refs'), { asset_id: `${id}-a0` });
  assert.equal(ref.status, 200);
  assert.deepEqual(ref.json.refs.map((x) => x.id), [`${id}-a0`]);
  const g2 = await call('POST', room('/generate'), {});
  assert.deepEqual(ig.generated.at(-1).refs, [`${id}-a0`]);
  await call('POST', room(`/jobs/${g2.json.job.job_id}/cancel`), {});
  await call('POST', room('/refs/clear'), {});
  assert.deepEqual((await call('GET', room('/state'))).json.refs, []);
});

test('job_status / cancel: only this room\'s jobs', async () => {
  assert.equal((await call('GET', room('/jobs/job-999'))).status, 404);
  assert.equal((await call('POST', room('/jobs/job-999/cancel'), {})).status, 404);
});

test('budget: enforced inside generate; raising keeps the count, reset zeroes it; every change is announced', async () => {
  let r = await call('POST', room('/budget'), { max_images: 2, reset: true });
  assert.deepEqual([r.json.budget.max_images, r.json.budget.used], [2, 0]);
  assert.equal((await call('POST', room('/generate'), { count: 2 })).status, 202);
  r = await call('POST', room('/generate'), { count: 1 });
  assert.equal(r.status, 429);
  assert.equal(r.json.reason, 'budget');
  assert.equal((await call('GET', room('/state'))).json.budget.left, 0);
  // re-sending the same max does NOT buy more images (the old reset-on-set hole)
  r = await call('POST', room('/budget'), { max_images: 2 });
  assert.equal(r.json.budget.used, 2);
  assert.equal((await call('POST', room('/generate'), { count: 1 })).status, 429);
  assert.ok(eng.lines.some((l) => /budget set to 2 images \(count reset\)/.test(l.text) && l.from.paneid === 'pane-1'));
  assert.ok(eng.lines.filter((l) => /budget set/.test(l.text)).every((l) => l.tool.for === 'user'), 'a budget line is for the user');
  assert.ok(eng.lines.some((l) => /budget set to 2 images — 2 used/.test(l.text)));
  assert.equal((await call('POST', room('/budget'), { max_images: 12, reset: 'yes' })).status, 400);
  // the time budget: a deadline from now; past it, generate refuses; null clears it
  r = await call('POST', room('/budget'), { max_images: 12, reset: true, minutes: 30 });
  assert.ok(Date.parse(r.json.budget.until) > Date.now() + 29 * 60000);
  const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'work', 'images.json'), 'utf8'));
  assert.ok(st.rooms[ROOM].budget.until);
  r = await call('POST', room('/budget'), { max_images: 12, minutes: null });
  assert.equal(r.json.budget.until, null);
  assert.equal((await call('POST', room('/budget'), { max_images: 12, minutes: 0 })).status, 400);
  await call('POST', room('/budget'), { max_images: 12, reset: true });
});

test('reload_recipe: loads an output\'s settings; refuses a foreign asset', async () => {
  const own = (await call('GET', room('/history'))).json.history.find((h) => h.assets.length).assets[0].id;
  assert.equal((await call('POST', room('/recipe'), { asset_id: 'foreign' })).status, 404);
  const r = await call('POST', room('/recipe'), { asset_id: own });
  assert.equal(r.status, 200);
  assert.equal(r.json.settings.prompt, 'a red fox');
  assert.equal(r.json.settings.seed, 77);
});

test('a job image-gen forgot (gateway restart) becomes lost, not stuck — and its images are refunded', async () => {
  const before = (await call('GET', room('/state'))).json.budget.used;
  const g = await call('POST', room('/generate'), { count: 3 });
  assert.equal(g.json.budget.used, before + 3);
  ig.jobs.delete(g.json.job.job_id);
  const j = await waitFor(async () => {
    const x = (await call('GET', room(`/jobs/${g.json.job.job_id}`))).json.job;
    return x.state === 'lost' && x;
  });
  assert.match(j.error, /lost/);
  assert.equal((await call('GET', room('/state'))).json.budget.used, before);
});

test('a cancelled job refunds what it never made', async () => {
  const before = (await call('GET', room('/state'))).json.budget.used;
  const g = await call('POST', room('/generate'), { count: 2 });
  await call('POST', room(`/jobs/${g.json.job.job_id}/cancel`), {});
  await waitFor(async () => (await call('GET', room(`/jobs/${g.json.job.job_id}`))).json.job.state === 'cancelled');
  assert.equal((await call('GET', room('/state'))).json.budget.used, before);
});

test('outputs land in the room share under asset-studio/renders/ (not the room top level), then ONE line', async () => {
  const done = (await call('GET', room('/history'))).json.history.find((h) => h.state === 'done' && h.assets.length === 2);
  const paths = await waitFor(async () => {
    const imgs = (await call('GET', room('/images'))).json.images.filter((i) => done.assets.some((a) => a.id === i.id));
    return imgs.every((i) => i.share_path) && imgs.map((i) => i.share_path);
  });
  for (const p of paths) assert.match(p, /^rooms\/test-room-3f2a9c10\/asset-studio\/renders\/img_g\d+-\d_[0-9a-z-]{8}\.png$/);
  assert.equal(eng.posts.length, 0, 'nothing is posted to the room top level');
  const line = await waitFor(() => eng.lines.find((l) => /gen \d+ — 2 new images \(draft 1024×1024\) in asset-studio\/renders\//.test(l.text)));
  assert.equal(line.from.paneid, 'pane-1');
  assert.deepEqual(line.tool, { slug: 'asset-studio', for: 'asset-studio' }, 'autonomous by default: FOR the agent, not the user');
});

test('room_images + import_ref: a dropped photo becomes a reference; our own output maps to its id', async () => {
  eng.assets.unshift({ name: 'holiday.jpg', type: 'image/jpeg', bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('PHOTO-BYTES')]) });
  eng.assets.unshift({ name: 'notes.pdf', type: 'application/pdf', bytes: Buffer.from('%PDF') });
  eng.assets.unshift({ name: 'logo.svg', type: 'image/svg+xml', bytes: Buffer.from('<svg/>') });
  eng.assets.unshift({ name: 'fake.png', type: 'image/png', bytes: Buffer.from('<html>not a png</html>') });
  const imgs = (await call('GET', room('/room-images'))).json.images;
  assert.equal(imgs.some((i) => i.name === 'notes.pdf' || i.name === 'logo.svg'), false, 'raster only');
  assert.equal(imgs.find((i) => i.name === 'holiday.jpg').asset_id, null);

  let r = await call('POST', room('/refs/import'), { name: 'holiday.jpg', slot: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.json.refs[0].id, 'lib-import-1');
  assert.deepEqual(eng.uploads.at(-1), { dedupe: '1', size: eng.uploads.at(-1).size, hasPhoto: true });
  // importing again reuses the id — no second upload
  await call('POST', room('/refs/import'), { name: 'holiday.jpg' });
  assert.equal(eng.uploads.length, 1);
  assert.equal((await call('POST', room('/refs/import'), { name: 'notes.pdf' })).status, 400);
  assert.equal((await call('POST', room('/refs/import'), { name: 'logo.svg' })).status, 400);
  const fake = await call('POST', room('/refs/import'), { name: 'fake.png' });
  assert.equal(fake.status, 400);
  assert.match(fake.json.error, /not really/);
  assert.equal(eng.uploads.length, 1, 'a fake never reaches the Library');
  assert.equal((await call('POST', room('/refs/import'), { name: 'nope.png' })).status, 404);
  await call('POST', room('/refs/clear'), {});
});

test('reload_recipe on a DRAFT keeps its shape, not its half size', async () => {
  const draft = (await call('GET', room('/history'))).json.history.find((h) => h.draft && h.assets.length).assets[0].id;
  const r = await call('POST', room('/recipe'), { asset_id: draft });
  assert.deepEqual([r.json.settings.width, r.json.settings.height], [null, null]);
  assert.equal(Number(r.json.settings.aspect).toFixed(4), (832 / 1216).toFixed(4));
});

test('engine offline: 503 with reason, nothing auto-started', async () => {
  ig.offline = true;
  try {
    const m = await call('GET', room('/models'));
    assert.equal(m.status, 503);
    assert.equal(m.json.reason, 'engine-offline');
    const g = await call('POST', room('/generate'), {});
    assert.equal(g.status, 503);
  } finally {
    ig.offline = false;
  }
});

test('state persists to work/images.json (what a restart reloads)', () => {
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'work', 'images.json'), 'utf8'));
  assert.equal(s.rooms[ROOM].settings.prompt, 'a red fox');
  assert.ok(s.rooms[ROOM].history.length >= 3);
});

test('tool.json: every verb has a class and a JSON http call, and matches the scripts\' table', () => {
  const tool = JSON.parse(fs.readFileSync(path.join(SRC, 'tool.json'), 'utf8'));
  assert.equal(tool.contract, 'tool/draft-0');
  assert.match(tool.slug, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  for (const v of tool.verbs) {
    assert.ok(['read', 'mutate', 'control'].includes(v.class), `${v.name} class`);
    assert.match(v.call.http, /^(GET|POST) \/rooms\/:roomId\//, `${v.name} http`);
  }
  const src = fs.readFileSync(path.join(SRC, 'scripts', 'lib', 'tool.mjs'), 'utf8');
  for (const v of tool.verbs.filter((x) => x.agentCallable !== false)) { // review_feedback / review_submit are the user's: not in the resident's scripts
    const [meth, p] = v.call.http.split(' ');
    const rest = p.replace('/rooms/:roomId', '').replace(':jobId', ':id');
    assert.ok(src.includes(`${v.name}: ['${meth}', '${rest}'`), `scripts/lib/tool.mjs VERBS lacks ${v.name} ${meth} ${rest}`);
  }
  const usage = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lib', 'tool.mjs'), 'call'], { env: BASE_ENV, encoding: 'utf8' });
  assert.equal(usage.status, 64);
  // briefing-table's panel-action rules (addendum 3): mutate, <METHOD> /path with :roomId, no actor/room input keys
  const ACTOR = ['from', 'by', 'flaggedby', 'author', 'authorname', 'actor', 'handle', 'seat', 'roomid', 'user', 'sender'];
  const panel = tool.verbs.filter((v) => v.panel !== undefined);
  assert.deepEqual(panel.map((v) => v.name), ['review_feedback', 'review_mark', 'review_ref', 'review_note', 'review_send', 'review_submit']);
  assert.deepEqual(panel.filter((v) => v.agentCallable !== false).map((v) => v.name), ['review_ref'], 'an agent may add a reference too; the rest are the user\'s');
  for (const v of panel) {
    assert.equal(v.panel, true);
    assert.equal(v.class, 'mutate', `${v.name}: a non-GET panel verb is mutate`);
    assert.match(v.call.http, /^POST \/\S*:roomId/);
    const segs = v.call.http.split(' ')[1].split('/').slice(1);
    assert.ok(segs.every((x) => /^:[A-Za-z][A-Za-z0-9_]{0,31}$/.test(x) || /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/.test(x)), `${v.name} path segments`);
    for (const k of Object.keys(v.input ?? {})) assert.ok(!ACTOR.includes(k.toLowerCase().replace(/[_-]/g, '')), k);
    if (v.agentCallable === false) assert.ok(!src.includes(`${v.name}:`), `${v.name} is not in the resident's scripts table`);
  }
  const [fbv, , , , , sub] = panel;
  assert.equal(fbv.call.http, 'POST /rooms/:roomId/reviews/:n/feedback');
  assert.deepEqual(Object.keys(fbv.input), ['verdict', 'comment', 'image', 'pick', 'scope', 'decision']); // image: a plain key, not actor-ish; a pick and a scope decision answer about the whole submission
  // task: one submit per requester — :requester is a PATH param (the actor-key rule is for input keys only)
  assert.equal(sub.call.http, 'POST /rooms/:roomId/reviews/submit/:requester');
  assert.deepEqual(Object.keys(sub.input), ['note'], 'review_submit takes the optional note only (); without one the engine sends no body');
  assert.deepEqual(sub.postsToRoom, { to: 'requester', data: true });
  // the engine's postsToRoom rule (apps.ts postsToRoomOf): only on a panel mutate verb; true/false or {to: lead|requester, data?: bool}, no other keys
  for (const v of tool.verbs.filter((x) => x.postsToRoom !== undefined && x.postsToRoom !== false)) {
    assert.equal(v.panel, true, `${v.name}: postsToRoom needs panel`);
    assert.ok(v.postsToRoom === true || (Object.keys(v.postsToRoom).every((k) => ['to', 'data'].includes(k))
      && ['lead', 'requester'].includes(v.postsToRoom.to) && [undefined, true, false].includes(v.postsToRoom.data)), `${v.name} postsToRoom shape`);
  }
  assert.match(tool.verbs.find((v) => v.name === 'review_add').input.for, /agent that ASKED/);
});

test('panel: view is a relative-only shell with a CSP; other rooms get a message, never state', async () => {
  const r = await fetch(base + room('/view'));
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'.*img-src 'self'/);
  assert.match(html, /<link rel="stylesheet" href="tokens.css">/);
  assert.match(html, /<script src="view.js"><\/script>/);
  assert.doesNotMatch(html, /(src|href)="(\/|https?:)/, 'every link is relative');
  const other = await (await fetch(`${base}/rooms/${OTHER}/view`)).text();
  assert.match(other, /another room/);
  assert.doesNotMatch(other, /view\.js/);
  const pj = await (await fetch(`${base}/rooms/${OTHER}/panel.json`)).json();
  assert.equal(pj.ok, false);
  assert.equal((await fetch(base + room('/view'), { method: 'POST' })).status, 405);
  for (const a of ['tokens.css', 'view.js']) assert.equal((await fetch(base + room(`/${a}`))).status, 200);
  // every font tokens.css @font-faces for the panel's type, CORS-open for the opaque-origin frame
  const css = await (await fetch(base + room('/tokens.css'))).text();
  for (const f of ['inter', 'spacegrotesk', 'jetbrainsmono']) {
    assert.match(css, new RegExp(`url\\("fonts/${f}\\.woff2"\\)`));
    const r = await fetch(base + room(`/fonts/${f}.woff2`));
    assert.equal(r.status, 200, f);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  }
  assert.doesNotMatch(await (await fetch(base + room('/view.js'))).text(), /innerHTML/, 'textContent only');
});

test('panel.json: generations newest first with gen numbers, budget, engine, model names', async () => {
  const r = await fetch(base + room('/panel.json'));
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.engine.ok, true);
  assert.ok(j.generations.length >= 3);
  assert.ok(j.generations[0].gen > j.generations[1].gen);
  assert.equal(typeof j.budget.left, 'number');
  assert.equal(j.model_name, 'Krea 2 Turbo');
  const g = j.generations.find((x) => x.assets.length);
  assert.deepEqual(Object.keys(g.assets[0]).sort(), ['bin', 'height', 'id', 'lib', 'seed', 'width']);
});

test('panel.json: per-tab slices, server-side folder counts, ETag → 304 when unchanged', async () => {
  const r = await fetch(base + room('/panel.json'));
  const j = await r.json();
  assert.equal(j.tab, 'studio');
  assert.equal(j.n_generations >= j.generations.length, true);
  assert.equal(typeof j.generations_more, 'number');
  assert.deepEqual(Object.keys(j.counts).sort(), ['favorites', 'images', 'queued', 'recycle']);
  const rv = await (await fetch(base + room('/panel.json?tab=review'))).json();
  assert.equal(rv.tab, 'review');
  assert.ok(rv.generations.every((g) => g.state === 'running'));
  const rc = await (await fetch(base + room('/panel.json?tab=recycle'))).json();
  assert.ok(rc.generations.every((g) => g.state === 'running' || g.assets.some((a) => a.bin === 'recycle')));
  assert.equal((await (await fetch(base + room('/panel.json?tab=bogus'))).json()).tab, 'studio');
  const etag = r.headers.get('etag');
  assert.ok(etag);
  const again = await fetch(base + room('/panel.json'), { headers: { 'if-none-match': etag } });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get('access-control-allow-origin'), '*');
  assert.equal((await fetch(base + room('/panel.json?tab=review'), { headers: { 'if-none-match': etag } })).status, 200);
});

test('panel thumb/file: only this room\'s images', async () => {
  const id = (await (await fetch(base + room('/panel.json'))).json()).generations.find((x) => x.assets.length).assets[0].id;
  const t = await fetch(base + room(`/thumb/${id}`));
  assert.equal(t.status, 200);
  assert.equal(t.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(base + room('/file/not-ours'))).status, 404);
});

test('label: set_params names the batch — in file names, the announce line and list_images', async () => {
  await call('POST', room('/params'), { label: 'Man Side-Left!' });
  assert.equal((await call('GET', room('/state'))).json.settings.label, 'man-side-left');
  const g = await call('POST', room('/generate'), { count: 1 });
  const img = await waitFor(async () => (await call('GET', room('/images'))).json.images.find((i) => i.id === `${g.json.job.job_id}-a0` && i.share_path));
  assert.equal(img.label, 'man-side-left');
  assert.match(img.share_path, /\/renders\/man-side-left_g\d+-1_/);
  await waitFor(() => eng.lines.find((l) => /"man-side-left" — 1 new image/.test(l.text)));
  await call('POST', room('/params'), { label: '' });
});

test('move_image: favorites promote + copy (share cannot move yet); recycle trashes; back again; list by bin', async () => {
  const all = (await call('GET', room('/images'))).json.images.filter((i) => i.share_path);
  const [a, b] = all;
  let r = await call('POST', room('/images/move'), { asset_id: a.id, to: 'favorites' });
  assert.equal(r.status, 200);
  assert.equal(r.json.moved[0].bin, 'favorites');
  assert.deepEqual(libx.promoted.at(-1), [a.id, { subdir: libx.promoted.at(-1)[1].subdir, subtype: 'generation' }]);
  assert.match(libx.promoted.at(-1)[1].subdir, /^images\/generated\/\d{4}\/\d{2}$/);
  assert.ok([...share.files.keys()].some((p) => p.includes('/asset-studio/favorites/')), 'a copy lands in favorites/');
  r = await call('POST', room('/images/move'), { asset_ids: [b.id], to: 'recycle' });
  assert.ok(libx.trashed.has(b.id), 'trashed under its real Library id');
  assert.equal([...libx.trashed].some((x) => x === 'undefined'), false);
  assert.deepEqual((await call('GET', room('/images?bin=recycle'))).json.images.map((i) => i.id), [b.id]);
  assert.deepEqual((await call('GET', room('/images?bin=favorites'))).json.images.map((i) => i.id), [a.id]);
  // the user likes a recycled one after all: straight to favorites
  r = await call('POST', room('/images/move'), { asset_id: b.id, to: 'favorites' });
  assert.equal(libx.trashed.has(b.id), false, 'revived');
  assert.equal(libx.promoted.at(-1)[0], b.id);
  assert.equal((await call('POST', room('/images/move'), { asset_id: 'not-ours', to: 'recycle' })).status, 404);
  assert.equal((await call('POST', room('/images/move'), { asset_id: a.id, to: 'trash' })).status, 400);
  assert.equal((await call('GET', room('/images?bin=nope'))).status, 400);
});

test('move_image: real moves once file-share can move; a purged image comes back from the room copy', async () => {
  share.canMove = true;
  const img = (await call('GET', room('/images?bin=renders'))).json.images.find((i) => i.share_path && i.share_path.includes('/renders/'));
  let r = await call('POST', room('/images/move'), { asset_id: img.id, to: 'recycle' });
  assert.match(r.json.moved[0].share_path, /\/asset-studio\/recycle\//);
  // the reconcile pass may move an earlier favorite concurrently, so ours needn't be the LAST move
  assert.ok(share.moves.some((m) => m[0] === img.share_path && m[1] === r.json.moved[0].share_path), JSON.stringify(share.moves));
  // 48 h later the Library purged it; restoring re-imports the room copy under a new Library id
  libx.purged.add(img.id);
  const before = eng.uploads.length;
  r = await call('POST', room('/images/move'), { asset_id: img.id, to: 'renders' });
  assert.equal(r.status, 200);
  assert.equal(eng.uploads.length, before + 1, 're-imported');
  assert.match(r.json.moved[0].file_url, /lib-import-\d+\/file$/);
  assert.match(r.json.moved[0].share_path, /\/asset-studio\/renders\//);
  // the panel still shows it (thumb resolves through the new Library id)
  assert.equal((await fetch(base + room(`/thumb/${img.id}`))).status, 200);
  // reconcile: favorites made while the share could NOT move still have their file in renders/ —
  // the tracker moves them into favorites/ by itself once it can
  const fav = await waitFor(async () => {
    const f = (await call('GET', room('/images?bin=favorites'))).json.images;
    return f.length && f.every((i) => !i.share_path || i.share_path.includes('/asset-studio/favorites/')) && f;
  });
  assert.ok(fav.length >= 1);
  share.canMove = false;
});

test('for: generate carries its initiator to the batch line; bad values refused', async () => {
  const g = await call('POST', room('/generate'), { count: 1, for: 'user' });
  assert.equal(g.json.job.for, 'user');
  const line = await waitFor(() => eng.lines.find((l) => l.tool?.for === 'user' && /new image/.test(l.text) && l.text.includes(`gen ${g.json.job.gen} `)));
  assert.equal(line.tool.slug, 'asset-studio');
  assert.equal((await call('POST', room('/generate'), { for: 'Not A Handle' })).status, 400);
  assert.equal((await call('POST', room('/generate'), { for: 'briefing-table' })).status, 202);
});

test('color_match: a new room image, indexed with lineage + origin; staging cleaned; room-scoped', async () => {
  const imgs = (await call('GET', room('/images'))).json.images;
  const [tgt, ref] = imgs;
  const before = (await call('GET', room('/state'))).json.budget.used;
  const r = await call('POST', room('/images/colormatch'), { asset_id: tgt.id, ref_id: ref.id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.image.label, /-cm$/);
  assert.equal(r.json.image.bin, 'renders');
  const ix = indexed.at(-1);
  assert.equal(ix.existed, true, 'the staged file existed when the Library indexed it');
  assert.ok(ix.bytes > 0);
  assert.equal(ix.transient, true);
  assert.equal(ix.derived_op.op, 'colormatch');
  assert.match(ix.filename, /-cm\.png$/, 'a real .png filename, so the Library files it as an image');
  assert.equal(ix.derived_op.target, tgt.id);
  assert.equal(ix.derived_op.origin.room_id, ROOM);
  assert.equal(fs.readdirSync(path.join(ROOT, 'staging')).length, 0, 'staging cleaned');
  assert.equal((await call('GET', room('/state'))).json.budget.used, before, 'no GPU, no budget');
  // it is a first-class room image: listed, movable, lands in the room share
  await waitFor(async () => (await call('GET', room('/images'))).json.images.find((i) => i.id === r.json.image.id && i.share_path));
  assert.equal((await call('POST', room('/images/colormatch'), { asset_id: 'nope', ref_id: ref.id })).status, 404);
  assert.equal((await call('POST', room('/images/colormatch'), { asset_id: tgt.id, ref_id: 'nope' })).status, 404);
});

test('colormatch module: classes move toward the reference; white stays white', async () => {
  const { match } = await import(path.join(ROOT, 'app', 'colormatch.mjs'));
  // each class needs enough pixels to count (the module ignores a class with < 50 weight)
  const px = (arr) => { const rep = []; for (let i = 0; i < arr.length; i += 3) for (let k = 0; k < 100; k++) rep.push(arr[i], arr[i + 1], arr[i + 2]); return { w: rep.length / 3, h: 1, px: Buffer.from(rep) }; };
  const ref = px([80, 76, 71, 224, 179, 151, 150, 144, 135, 255, 255, 255]);
  const tgt = px([20, 40, 60, 232, 202, 178, 170, 170, 172, 255, 255, 255]);
  const out = match(ref, tgt).img.px;
  const at = (cls) => [...out.subarray(cls * 300, cls * 300 + 3)];
  assert.ok(at(0)[0] > 40 && at(0)[2] < 75, `dark pulled warm/lighter: ${at(0)}`);
  assert.ok(at(1)[1] < 202, `skin warmer (less green): ${at(1)}`);
  assert.deepEqual(at(3), [255, 255, 255], 'background untouched');
});

test('crop_region + paste_region: new images with lineage; bounds checked; no budget', async () => {
  const [base] = (await call('GET', room('/images'))).json.images;
  const before = (await call('GET', room('/state'))).json.budget.used;
  // the stub Library's image is 48x16 (three 16px bands)
  let r = await call('POST', room('/images/crop'), { asset_id: base.id, x: 16, y: 0, w: 16, h: 16, long_edge: 256 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const crop = r.json.image;
  assert.match(crop.label, /-crop$/);
  assert.deepEqual([crop.width, crop.height], [256, 256], 'upscaled to long_edge');
  let ix = indexed.at(-1);
  assert.equal(ix.derived_op.op, 'crop');
  assert.deepEqual(ix.derived_op.region, { x: 16, y: 0, w: 16, h: 16 });
  assert.equal(ix.derived_op.source, base.id);
  r = await call('POST', room('/images/paste'), { base_id: base.id, patch_id: crop.id, x: 16, y: 0, w: 16, h: 16, feather: 4, feather_edges: 'left,right,bottom' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.image.label, /-fix$/);
  assert.deepEqual([r.json.image.width, r.json.image.height], [48, 16], 'the base size is kept');
  ix = indexed.at(-1);
  assert.equal(ix.derived_op.op, 'paste');
  assert.match(ix.filename, /-fix\.png$/);
  assert.deepEqual(ix.derived_op.feather_edges, ['left', 'right', 'bottom']);
  assert.equal(ix.existed, true);
  assert.equal(fs.readdirSync(path.join(ROOT, 'staging')).length, 0, 'staging cleaned');
  assert.equal((await call('GET', room('/state'))).json.budget.used, before, 'no GPU, no budget');
  // canvas: a sheet view scaled to a height and centred on a matching canvas
  r = await call('POST', room('/images/crop'), { asset_id: base.id, x: 0, y: 0, w: 16, h: 16, canvas: { w: 120, h: 80, fit_h: 64, bg: 'black' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.image.width, r.json.image.height], [120, 80]);
  assert.equal((await call('POST', room('/images/crop'), { asset_id: base.id, x: 0, y: 0, w: 48, h: 16, canvas: { w: 60, h: 80, fit_h: 64 } })).status, 400, 'too wide for the canvas');
  assert.equal((await call('POST', room('/images/crop'), { asset_id: base.id, x: 0, y: 0, w: 16, h: 16, canvas: { w: 60, h: 80, bg: 'red;rm' } })).status, 400);
  // bounds + validation
  assert.equal((await call('POST', room('/images/crop'), { asset_id: base.id, x: 40, y: 0, w: 16, h: 16 })).status, 400, 'region past the edge');
  assert.equal((await call('POST', room('/images/paste'), { base_id: base.id, patch_id: crop.id, x: 0, y: 0, w: 16, h: 16, feather_edges: 'diagonal' })).status, 400);
  assert.equal((await call('POST', room('/images/paste'), { base_id: 'nope', patch_id: crop.id, x: 0, y: 0, w: 16, h: 16 })).status, 404);
});

test('POST /bind: engine bearer only; same room is a no-op; no seat is 409 and changes nothing', async () => {
  const bind = (body, auth = true) => fetch(`${base}/bind`, { method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(auth && { authorization: `Bearer ${eng.token}` }) } })
    .then(async (r) => ({ status: r.status, json: await r.json() }));
  assert.equal((await bind({ room_id: OTHER }, false)).status, 401);
  const same = await bind({ room_id: ROOM });
  assert.equal(same.status, 200);
  assert.equal(same.json.unchanged, true);
  const other = await bind({ room_id: OTHER });
  assert.equal(other.status, 409);
  assert.equal(other.json.reason, 'no-seat');
  assert.equal((await call('GET', '/health')).json.bound.room_id, ROOM);
});

test('binding: a binding others can write reads as unbound (fail closed)', async () => {
  fs.chmodSync(BINDING_FILE, 0o660);
  try {
    assert.equal((await call('GET', '/health')).json.bound, null);
    assert.equal((await call('GET', `/rooms/${ROOM}/state`)).json.reason, 'unbound');
  } finally {
    fs.chmodSync(BINDING_FILE, 0o600);
  }
  assert.equal((await call('GET', '/health')).json.bound.room_id, ROOM);
});

test('to_art: a Library image goes to briefing-table\'s icon-lab with the engine bearer; non-images refused', async () => {
  const r = await call('POST', `/rooms/${ROOM}/images/art`, { asset_id: 'lib-icon-1', name: 'Mic always-on' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.key, 'lib:L1');
  assert.deepEqual(eng.art, { name: 'Mic always-on', pngHead: 'PNG' });
  assert.equal((await call('POST', `/rooms/${ROOM}/images/art`, { asset_id: 'lib-audio-1', name: 'x' })).status, 400);
  assert.equal((await call('POST', `/rooms/${ROOM}/images/art`, { asset_id: 'lib-icon-1' })).status, 400);
});

/* ---------------------------------------------------------------- review -- */

test('review_add: numbered per room, any Library image; validation 400s', async () => {
  let r = await call('POST', room('/reviews'), { title: 'the Example Character', note: 'full figure, front', images: ['lib-rv-a', 'lib-rv-b'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.n, 1);
  assert.equal(r.json.item.status, 'waiting');
  assert.equal(r.json.item.agent, 'asset-studio');
  assert.deepEqual(r.json.item.versions.map((v) => [v.v, v.images]), [[1, ['lib-rv-a', 'lib-rv-b']]]);
  // the evidence tool line: FOR the requester (default the bound agent), linked to review/<n>
  assert.equal(r.json.announced, true);
  assert.deepEqual(eng.lines.at(-1), { text: 'Review #1 ready: the Example Character (2 images)', from: { paneid: 'pane-1' },
    tool: { slug: 'asset-studio', for: 'asset-studio' }, links: [{ tool: 'asset-studio', ref: 'review/1', label: '#1' }] });
  r = await call('POST', room('/reviews'), { title: 'her shoes', images: ['lib-rv-c'] });
  assert.equal(r.json.n, 2);
  for (const [body, re] of [
    [{ title: '', images: ['lib-rv-a'] }, /title is empty/],
    [{ title: 'x'.repeat(81), images: ['lib-rv-a'] }, /title is over 80/],
    [{ title: 'x', note: 'y'.repeat(2001), images: ['lib-rv-a'] }, /note is over 2000/],
    [{ title: 'x', images: [] }, /images must be 1–12/],
    [{ title: 'x', images: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm'] }, /images must be 1–12/],
    [{ title: 'x', images: ['lib-rv-a', 'lib-rv-a'] }, /same id twice/],
    [{ title: 'x', images: ['../etc'] }, /bad image id/],
    [{ title: 'x', images: ['lib-missing-1'] }, /not found/],
    [{ title: 'x', images: ['lib-audio-1'] }, /not an image/],
    [{ title: 'x', images: ['lib-rv-a'], for: 'user' }, /the agent that asked for the review/],
    [{ title: 'x', images: ['lib-rv-a'], for: 'Not A Handle' }, /for must be/],
  ]) {
    const x = await call('POST', room('/reviews'), body);
    assert.equal(x.status, 400, JSON.stringify(body));
    assert.match(x.json.error, re);
  }
  assert.equal((await call('POST', `/rooms/${OTHER}/reviews`, { title: 'x', images: ['lib-rv-a'] })).status, 409);
});

test('review_update: new images/note = a new version (history kept, waiting again); title in place', async () => {
  await call('POST', room('/reviews/status'), { n: 1, status: 'replied' });
  let r = await call('POST', room('/reviews/update'), { n: 1, images: ['lib-rv-d'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.new_version, true);
  assert.equal(r.json.item.status, 'waiting');
  assert.deepEqual(r.json.item.versions.map((v) => [v.v, v.images, v.note]), [[1, ['lib-rv-a', 'lib-rv-b'], 'full figure, front'], [2, ['lib-rv-d'], 'full figure, front']]);
  assert.equal(r.json.announced, true);
  assert.deepEqual([eng.lines.at(-1).text, eng.lines.at(-1).tool.for], ['Review #1 v2 ready: the Example Character (1 image)', 'asset-studio'], 'a new version is announced for the requester');
  const lines = eng.lines.length;
  r = await call('POST', room('/reviews/update'), { n: 1, title: 'the Example Character (armour)' });
  assert.equal(r.json.new_version, false);
  assert.equal(r.json.announced, undefined);
  assert.equal(eng.lines.length, lines, 'a rename is not announced');
  assert.equal(r.json.item.title, 'the Example Character (armour)');
  assert.equal(r.json.item.versions.length, 2);
  r = await call('POST', room('/reviews/update'), { n: 1, images: ['lib-rv-d'] }); // same as the latest: nothing new
  assert.equal(r.json.new_version, false);
  assert.equal((await call('POST', room('/reviews/update'), { n: 1 })).status, 400);
  assert.equal((await call('POST', room('/reviews/update'), { n: 99, note: 'x' })).status, 404);
  assert.equal((await call('POST', room('/reviews/update'), { n: 'one', note: 'x' })).status, 400);
  assert.equal((await call('POST', room('/reviews/update'), { n: 1, images: ['lib-missing-2'] })).status, 400);
});

test('review_status + the waiting count; review_list newest first', async () => {
  assert.equal((await call('POST', room('/reviews/status'), { n: 2, status: 'done' })).status, 400);
  assert.equal((await call('POST', room('/reviews/status'), { n: 42, status: 'resolved' })).status, 404);
  const r = await call('POST', room('/reviews/status'), { n: 2, status: 'resolved' });
  assert.equal(r.json.item.status, 'resolved');
  const list = (await call('GET', room('/reviews'))).json.items;
  assert.deepEqual(list.map((x) => [x.n, x.status, x.versions, x.latest.v]), [[2, 'resolved', 1, 1], [1, 'waiting', 2, 2]]);
  const pj = await (await fetch(base + room('/panel.json'))).json();
  assert.equal(pj.reviews.filter((x) => x.status === 'waiting').length, 1);
});

test('review_look: bad options are 400, an unknown review 404, no browser configured is a plain 503, a picture that is not kept is 404 (the browser run itself is checked by hand)', async () => {
  for (const b of [{ widths: [10] }, { widths: [370, 900, 500] }, { mode: 'x' }, { views: ['y'] }, { image: 99 }, { pin_at: '3,3' }, { pin_at: 'a' }]) assert.equal((await call('POST', room('/reviews/1/look'), b)).status, 400, JSON.stringify(b));
  assert.equal((await call('POST', room('/reviews/99/look'), {})).status, 404);
  const r = await call('POST', room('/reviews/1/look'), { pin_at: '0.5,0.5' });
  assert.equal(r.status, 503);
  assert.equal(r.json.reason, 'no-browser');
  // memory: too little free = 503 before any browser starts; unreadable = refused too
  memory(1500);
  const low = await call('POST', room('/reviews/1/look'), {});
  assert.equal(low.status, 503);
  assert.equal(low.json.reason, 'low-memory');
  assert.match(low.json.error, /not enough free memory for a browser right now: 1\.5 GB available, 2\.5 GB needed/);
  memory(8192);
  assert.equal((await call('POST', room('/reviews/1/look'), {})).json.reason, 'no-browser');
  assert.equal((await fetch(base + room('/look/abc/370-list.png'))).status, 404);
  assert.equal((await fetch(base + room('/look/abc/..%2fx.png'))).status, 404);
});

test('review_look memory plan: a big model skips its 3D view unless asked, and then needs more free memory; the reading is injectable', async () => {
  const { plan, limits, memAvailableMb } = await import(path.join(SRC, 'app', 'look.mjs'));
  const lim = limits({});
  assert.deepEqual([lim.minMb, lim.bigModelMb, lim.bigMinMb, lim.killMb], [2560, 10, 6144, 1024]);
  const MBYTES = 1048576;
  let p = plan({}, null, 3000, lim);
  assert.deepEqual([p.no3d, p.notes.length, p.floorMb], [false, 0, 2560]);
  p = plan({}, 5 * MBYTES, 3000, lim);
  assert.equal(p.no3d, false);
  p = plan({}, 30 * MBYTES, 3000, lim);
  assert.equal(p.no3d, true);
  assert.match(p.notes[0], /30 MB, over the 10 MB limit.*big_model: true.*6\.0 GB/);
  assert.throws(() => plan({ big_model: true }, 30 * MBYTES, 3000, lim), (e) => e.status === 503 && /2\.9 GB available, 6\.0 GB needed/.test(e.message));
  p = plan({ big_model: true }, 30 * MBYTES, 7000, lim);
  assert.deepEqual([p.no3d, p.floorMb, p.notes.length], [false, 6144, 0]);
  assert.throws(() => plan({}, null, 2000, lim), (e) => e.status === 503);
  assert.throws(() => plan({}, null, null, lim), (e) => e.status === 503 && /cannot read/.test(e.message));
  const f = path.join(ROOT, 'meminfo-unit');
  fs.writeFileSync(f, 'MemTotal: 1 kB\nMemAvailable: 3145728 kB\n');
  process.env.ASSET_STUDIO_MEMINFO = f;
  assert.equal(memAvailableMb(), 3072);
  process.env.ASSET_STUDIO_MEMINFO = path.join(ROOT, 'nope');
  assert.equal(memAvailableMb(), null);
  delete process.env.ASSET_STUDIO_MEMINFO;
});

test('review_remove: the others keep their numbers; n is never reused', async () => {
  assert.equal((await call('POST', room('/reviews/remove'), { n: 7 })).status, 404);
  const r = await call('POST', room('/reviews/remove'), { n: 2 });
  assert.deepEqual(r.json, { ok: true, removed: 2 });
  const a = await call('POST', room('/reviews'), { title: 'her ring', note: 'close-up', images: ['lib-rv-e', 'lib-rv-f', 'lib-rv-g'] });
  assert.equal(a.json.n, 3);
  assert.deepEqual((await call('GET', room('/reviews'))).json.items.map((x) => x.n), [3, 1]);
  const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'work', 'reviews.json'), 'utf8')).rooms[ROOM];
  assert.equal(st.review_seq, 3);
});

test('GET review/:n: the item large — latest by default, ?v= an older version, 404 page for unknown n', async () => {
  let r = await fetch(base + room('/review/1?plain=1'));
  let html = await r.text();
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(html, /the Example Character \(armour\)/);
  assert.match(html, /src="\.\.\/file\/lib-rv-d"/);
  assert.doesNotMatch(html, /lib-rv-a/);
  assert.match(html, /<code id="curid">lib-rv-d<\/code><button class="cp" id="cpid" type="button" aria-label="Copy the image id"/, 'the id under the picture, with its copy button');
  assert.match(html, /v2 of 2/);
  assert.match(html, /href="\.\.\/tokens\.css"/);
  assert.match(html, /<script src="\.\.\/review\.js"><\/script>/);
  assert.doesNotMatch(html, /(src|href)="(\/|https?:)/, 'every link is relative');
  r = await fetch(base + room('/review/1?plain=1&v=1'));
  html = await r.text();
  for (const id of ['lib-rv-a', 'lib-rv-b']) assert.match(html, new RegExp(`<img src="\\.\\./(thumb|file)/${id}"`));
  assert.match(html, /superseded by v2/);
  assert.match(html, /v1 of 2/);
  assert.match(html, /full figure, front/);
  html = await (await fetch(base + room('/review/3?plain=1'))).text();
  for (const id of ['lib-rv-e', 'lib-rv-f', 'lib-rv-g']) assert.match(html, new RegExp(`<img src="\\.\\./(thumb|file)/${id}"`));
  r = await fetch(base + room('/review/2'));
  assert.equal(r.status, 404);
  assert.match(await r.text(), /Review #2 isn't here any more/);
  assert.equal((await fetch(base + room('/review/abc'))).status, 404);
  assert.equal((await fetch(base + room('/review/1'), { method: 'POST' })).status, 405);
  assert.match(await (await fetch(`${base}/rooms/${OTHER}/review/1`)).text(), /another room/);
  // a review image is served to the panel even though this room didn't make it
  assert.equal((await fetch(base + room('/thumb/lib-rv-e'))).status, 200);
  assert.equal((await fetch(base + room('/file/lib-rv-a'))).status, 200);
  assert.equal((await fetch(base + room('/review.js'))).status, 200);
  // without ?plain=1: the panel itself, one level up, opened on the item (the link target gets the rating form)
  html = await (await fetch(base + room('/review/1?v=1'))).text();
  assert.match(html, /<html lang="en" data-tiers="[^"]+" data-base="\.\.\/" data-open="review\/1\/v1">/);
  assert.match(html, /href="\.\.\/tokens\.css"/);
  assert.match(html, /<script src="\.\.\/view\.js"><\/script>/);
});

test('GET review/:n/thumb: a small JPEG of the latest first image; 404 unknown n', async () => {
  const r = await fetch(base + room('/review/1/thumb'));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  const b = Buffer.from(await r.arrayBuffer());
  assert.ok(b.length > 0 && b.length <= 64 * 1024, `${b.length} bytes`);
  assert.deepEqual([...b.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  const f = path.join(ROOT, 'rv-thumb.jpg');
  fs.writeFileSync(f, b);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f], { encoding: 'utf8' });
  assert.equal(probe.stdout.trim(), '96,96');
  assert.equal((await fetch(base + room('/review/2/thumb'))).status, 404);
});

test('GET links: link-chip facts in the refs\' order; unknown refs stale; ≤8 refs', async () => {
  const r = await fetch(base + room('/links?refs=review/3,review/2,review/1/v1,review/1,nope'));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  const { items } = await r.json();
  assert.deepEqual(items, [
    { ref: 'review/3', label: '#3 her ring', state: 'waiting', thumb: 'review/3/thumb' },
    { ref: 'review/2', stale: true, note: 'Review #2 was removed' },
    { ref: 'review/1/v1', label: '#1 the Example Character (armour)', state: 'waiting', thumb: 'review/1/thumb', note: 'superseded by v2' },
    { ref: 'review/1', label: '#1 the Example Character (armour)', state: 'waiting', thumb: 'review/1/thumb' },
    { ref: 'nope', stale: true, note: 'not a link this tool knows' },
  ]);
  const nine = Array.from({ length: 9 }, (_, i) => `review/${i + 1}`).join(',');
  assert.equal((await fetch(base + room(`/links?refs=${nine}`))).status, 400);
  assert.equal((await fetch(base + room('/links'))).status, 400);
  assert.equal((await (await fetch(`${base}/rooms/${OTHER}/links?refs=review/1`)).json()).ok, false);
});

test('panel: the Review tab (waiting count, empty state, the large view IN-FRAME) and width tiers', async () => {
  const html = await (await fetch(base + room('/view'))).text();
  assert.match(html, /data-tiers="m:360 l:640 xl:1000"/);
  assert.doesNotMatch(html, /\d\s*vh\b/, 'never vh');
  const js = await (await fetch(base + room('/view.js'))).text();
  assert.match(js, /\[w \+ ' open', w \? 'go' : ''\]/); // v3: Review's status chip counts the items waiting on the user
  assert.match(js, /if \(surface !== 'preview'\) \{\s*var sw = el\('div', 'partsw'\)/, 'the part switcher only where no rail is beside the panel');
  assert.match(js, /No review items yet — an agent adds them with review_add\./);
  // the panel frame never navigates or reloads itself (the host's action port is handed over once);
  // the link-target page's script follows its own links instead of assigning location.href
  assert.doesNotMatch(js, /location\.(href\s*=[^=]|assign|replace|reload)|location\s*=[^=]/);
  assert.doesNotMatch(await (await fetch(base + room('/review.js'))).text(), /location\.href\s*=[^=]|location\s*=[^=]/);
  assert.match(js, /e\.data\.host === 'port'/);
  // ratings go out on the port only, never window.postMessage; results are read off the port
  assert.match(js, /var msg = \{ panel: 'action', name: name, params: params \};[\s\S]{0,80}port\.postMessage\(msg\)/);
  assert.match(js, /sendAction\('review_feedback', \{ n: String\(job\.n\) \}, input,/);
  // v3 (Aurora 13f29fb): Submit is per review, on its summary (review_send); the overall note saves as you type (review_note)
  assert.match(js, /sendAction\('review_send', \{ n: String\(n\) \}, input,/);
  assert.match(js, /sendAction\('review_note', \{ n: String\(job\.n\) \}, \{ note: job\.text \},/);
  assert.doesNotMatch(js, /review_submit/, 'no bulk send from the panel any more');
  assert.doesNotMatch(js, /Reply in chat/, 'one way to answer a review: rate, note, Send ()');
  assert.doesNotMatch(js, /parent\.postMessage\(\{ panel: 'action'/);
  assert.match(js, /m\.data\.host === 'action-result'\) actResult\(m\.data\)/);
  assert.match(js, /nr \+ ' rating' \+ \(nr > 1 \? 's' : ''\)/);
  assert.match(js, /started \? 'Edit review' : it\.purpose === 'status' \? 'Look through' : 'Begin review'/);
  assert.match(js, /'\\u2713 Sent to @' \+ \(who \|\| 'the agent'\)/);
  assert.match(js, /reviewHead\('data-back', 'Review List', it, ver\)/);
  assert.match(js, /reviewHead\('data-unfocus', 'Summary', it, ver\)/);
  assert.match(js, /el\('button', 'back', '(\\u2039|‹) Focus'\)/);
  // the host's app-status: held / unregistered = one note + Open Settings (on the port, click-only); errors map to it
  assert.match(js, /m\.data\.host === 'app-status' && \['enabled', 'held', 'unregistered'\]/);
  assert.match(js, /Approval needed to use this · /);
  assert.match(js, /port\.postMessage\(\{ panel: 'open-settings' \}\)/);
  assert.doesNotMatch(js, /parent\.postMessage\(\{ panel: 'open-settings'/);
  assert.match(js, /r\.error === 'needs-approval' \|\| r\.error === 'not-registered'/);
  assert.match(js, /Open in the room to send feedback/);
  // per-image ratings : the form says which image it rates, sends that image (1-based, a scalar),
  // follows the image in view (never carrying a comment across), strip marks + card tally; the rest is Playwright's
  assert.match(js, /var scope = isMesh \? 'Rate this model' : focus \? 'Rate image #' \+ num : 'Rate this image' \+ \(nImg > 1 \? ' \(' \+ \(idx \+ 1\) \+ ' of ' \+ nImg \+ '\)' : ''\);/);
  assert.match(js, /var input = \{ image: String\(job\.i \+ 1\) \};/);
  assert.match(js, /fbSync\(it, ver, idx\);/);
  assert.match(js, /var row = el\('button', 'irow-open'\);/, 'the summary: one row per image, opening its focus page');
  assert.match(js, /if \(qv\) return quickVote\(/, 'a quick thumbs up / down on a summary row ()');
  // the thumbs-down is the thumb turned over ON THE PATH about its centre: a transform on the outer <svg> does nothing on iOS 
  assert.match(js, /if \(v === 'down'\) path\.setAttribute\('transform', 'rotate\(180 12 12\)'\);/);
  assert.doesNotMatch(js, /svg\.setAttribute\('transform'/);
  // an older version: the banner with the way to the latest; after Send review: back to the list
  assert.match(js, /You\\u2019re viewing v' \+ ver\.v \+ ' \\u2014 v' \+ latestV \+ ' is the latest \\u00b7 '/);
  assert.match(js, /el\('button', 'vban-go', 'Go to v' \+ latestV\)/);
  assert.match(html, /\.vban\{[^}]*var\(--amber\)/);
  assert.match(html, /\.vban-go\{[^}]*color:var\(--teal\)/);
  // the in-frame large view's data: every version of every item (review tab only)
  const rv = await (await fetch(base + room('/panel.json?tab=review'))).json();
  assert.deepEqual(rv.review_items.find((x) => x.n === 1).versions.map((v) => v.v), [1, 2]);
  assert.equal((await (await fetch(base + room('/panel.json'))).json()).review_items, undefined);
  // the user's rules carried over to the in-frame view: a reserved image box (300 px stacked), side by side from 520, 64 px card thumbs
  assert.match(html, /\.rv \.cur\{[^}]*aspect-ratio:var\(--ar,1\);max-height:300px/, 'the image box is reserved before it loads ()');
  assert.match(html, /@media \(max-width:519\.98px\)\{[^\n]*\.rv \.side\{display:contents\}/, 'stacked: the rating form right under the image');
  assert.match(html, /@media \(min-width:520px\)\{\.rv-b\{flex-direction:row/);
  assert.match(html, /\.c3 img\{flex:0 1 64px/);
  const tool = JSON.parse(fs.readFileSync(path.join(SRC, 'tool.json'), 'utf8'));
  assert.deepEqual(tool.links, { 'review/:n': { label: 'Review item', view: 'GET /rooms/:roomId/review/:n' }, 'watch/:job': { label: 'Watch', view: 'GET /rooms/:roomId/watch/:job' }, '@meta': 'GET /rooms/:roomId/links' });
  for (const v of ['review_add', 'review_update', 'review_list', 'review_status', 'review_remove']) assert.ok(tool.verbs.some((x) => x.name === v), v);
});

test('review_feedback: PER IMAGE — validated (image required, 1-based, in range); saves that image\'s draft (no line, no status flip); re-rating replaces only that image; comment-only ok; neither discards that image', async () => {
  const n = (await call('POST', room('/reviews'), { title: 'feedback', images: ['lib-rv-a'] })).json.n;
  await call('POST', room('/reviews/update'), { n, note: 'second take', images: ['lib-rv-a', 'lib-rv-b', 'lib-rv-c'] });
  const url = room(`/reviews/${n}/feedback`);
  for (const [body, code, re] of [[{ verdict: 'up' }, 400, /image must be 1–3/], [{ verdict: 'up', image: 0 }, 400, /image must be 1–3/],
    [{ verdict: 'up', image: 4 }, 400, /image must be 1–3/], [{ verdict: 'up', image: '4' }, 400, /image must be 1–3/],
    [{ verdict: 'up', image: 1.5 }, 400, /image must/], [{ verdict: 'up', image: 'two' }, 400, /image must/], [{ verdict: 'up', image: [1] }, 400, /image must/],
    [{ verdict: 'meh', image: 1 }, 400, /verdict/], [{ verdict: 'up', comment: 5, image: 1 }, 400, /comment/], [{ verdict: 'up', by: 'user', image: 1 }, 400, /unknown field 'by'/],
    [{ verdict: 'up', comment: 'x'.repeat(2001), image: 1 }, 413, /over 2000/]]) {
    const x = await call('POST', url, body);
    assert.equal(x.status, code, JSON.stringify(body).slice(0, 60));
    assert.match(x.json.error, re);
  }
  assert.equal((await call('POST', room('/reviews/999/feedback'), { verdict: 'up', image: 1 })).status, 404);
  assert.equal((await call('POST', `/rooms/${OTHER}/reviews/${n}/feedback`, { verdict: 'up', image: 1 })).status, 409);
  const before = eng.lines.length;
  // the user's example: 👍 img 1, 👍 img 2 with a note, 👎 img 3 — image as a number or a numeric string (panel inputs are scalars)
  const r1 = await call('POST', url, { verdict: 'up', image: 1 });
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  assert.deepEqual([r1.json.image, r1.json.draft.image, r1.json.draft.image_id, r1.json.draft.verdict, r1.json.unsent_count], [1, 1, 'lib-rv-a', 'up', 1]);
  const r2 = await call('POST', url, { verdict: 'up', comment: '  I prefer this one:\n the pose  ', image: '2' });
  assert.deepEqual([r2.json.draft.image, r2.json.draft.comment, r2.json.unsent_count], [2, 'I prefer this one:\n the pose', 2]);
  const r3 = await call('POST', url, { verdict: 'down', image: 3 });
  assert.equal(r3.json.unsent_count, 3);
  assert.deepEqual(r3.json.item.unsent.images, {
    0: { verdict: 'up', comment: '', at: r3.json.item.unsent.images[0].at },
    1: { verdict: 'up', comment: 'I prefer this one:\n the pose', at: r3.json.item.unsent.images[1].at },
    2: { verdict: 'down', comment: '', at: r3.json.item.unsent.images[2].at },
  }, 'stored 0-based per image');
  assert.equal(r3.json.item.unsent.v, 2);
  assert.equal(r3.json.item.status, 'waiting', 'a saved rating does not flip the status');
  assert.equal(r3.json.item.versions[1].feedback, undefined, 'nothing sent yet');
  assert.equal(eng.lines.length, before, 'no room line for a saved rating');
  // re-rating image 3 replaces ONLY image 3's draft; a comment alone is a rating
  const r4 = await call('POST', url, { comment: 'the hands look off', image: 3 });
  assert.deepEqual([r4.json.draft.verdict, r4.json.draft.comment, r4.json.unsent_count], [null, 'the hands look off', 3]);
  assert.deepEqual(r4.json.unsent.ratings.map((d) => [d.image, d.verdict, d.comment]), [[1, 'up', ''], [2, 'up', 'I prefer this one:\n the pose'], [3, null, 'the hands look off']]);
  // review_list / get_state / panel.json carry it: agents see image 1-based + the comment text
  const lst = (await call('GET', room('/reviews'))).json;
  assert.deepEqual(lst.unsent_ratings.filter((u) => u.n === n).map((u) => [u.v, u.image, u.image_id, u.verdict, u.comment]),
    [[2, 1, 'lib-rv-a', 'up', ''], [2, 2, 'lib-rv-b', 'up', 'I prefer this one:\n the pose'], [2, 3, 'lib-rv-c', null, 'the hands look off']]);
  assert.equal(lst.items.find((x) => x.n === n).unsent.ratings.length, 3);
  const st = (await call('GET', room('/state'))).json;
  assert.equal(st.unsent_ratings.filter((u) => u.n === n).length, 3);
  assert.equal(st.feedback.some((f) => f.n === n), false, 'get_state feedback = SENT ratings only');
  const pj = await (await fetch(base + room('/panel.json?tab=review'))).json();
  assert.equal(pj.review_items.find((x) => x.n === n).unsent.images[2].comment, 'the hands look off', 'the panel reads 0-based raw drafts');
  // neither a verdict nor a comment = discard THAT image's draft only (idempotent)
  const d = await call('POST', url, { image: 3 });
  assert.deepEqual([d.status, d.json.discarded, d.json.draft, d.json.unsent_count], [200, true, null, 2]);
  const d2 = await call('POST', url, { verdict: null, comment: '   ', image: 3 });
  assert.deepEqual([d2.status, d2.json.discarded, d2.json.unsent_count], [200, false, 2]);
  await call('POST', url, { image: 1 });
  const d3 = await call('POST', url, { image: 2 });
  assert.deepEqual([d3.json.unsent, d3.json.unsent_count], [null, 0], 'the last draft gone = no unsent at all');
  assert.equal(eng.lines.length, before, 'still no room line');
});

test('review_submit: ONE roomLine with the per-image text (one item / several), ≤8 links (👎 / commented first), flips Replied, clears the drafts; empty → 400', async () => {
  const sub = room('/reviews/submit');
  assert.equal((await call('POST', sub)).status, 400, 'nothing to send');
  assert.match((await call('POST', sub)).json.error, /nothing to send/);
  const rate = (n, image, body) => call('POST', room(`/reviews/${n}/feedback`), { image, ...body });
  // one item, three images — the user's example
  const one = (await call('POST', room('/reviews'), { title: 'three shoes', images: ['lib-rv-a', 'lib-rv-b', 'lib-rv-c'] })).json.n;
  await rate(one, 1, { verdict: 'up' });
  await rate(one, 2, { verdict: 'up', comment: 'I prefer this: the laces' });
  await rate(one, 3, { verdict: 'down', comment: 'too shiny' });
  const before = eng.lines.length;
  // the engine forwards a no-input panel action with NO body and no content-type; a browser page (Origin) is refused
  assert.equal((await fetch(base + sub, { method: 'POST', headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await fetch(base + sub, { method: 'POST', body: 'x=1' })).status, 415);
  assert.equal((await call('POST', sub, { extra: 1 })).status, 400, 'takes only note');
  assert.equal((await call('POST', sub, { note: 5 })).status, 400, 'note is a string');
  assert.equal((await call('POST', sub, { note: 'x'.repeat(1501) })).status, 400, 'note ≤ 1500');
  let r = await fetch(base + sub, { method: 'POST' });
  let j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.summary, `reviewed #${one} — img 1 👍, img 2 👍, img 3 👎 (comments on img 2, img 3)`);
  assert.deepEqual([j.submitted, j.items], [3, 1]);
  assert.equal(j.roomLine.text, j.summary);
  assert.deepEqual(j.roomLine.links, [{ label: `#${one}`, path: `review/${one}` }]);
  // task: one requester (the bound agent) — the bare route still works, addressed to it, with the ratings as data
  assert.equal(j.requester, 'asset-studio');
  assert.equal(j.roomLine.to, 'asset-studio');
  assert.deepEqual(j.roomLine.data, { app: 'asset-studio', reviews: [{ n: one, v: 1, title: 'three shoes', ratings: [
    { image: 1, num: 1, verdict: 'up' }, { image: 2, num: 2, verdict: 'up', comment: 'I prefer this: the laces' }, { image: 3, num: 3, verdict: 'down', comment: 'too shiny' }],
  images: { 1: 'lib-rv-a', 2: 'lib-rv-b', 3: 'lib-rv-c' } }] });
  assert.equal(eng.lines.length, before, 'the app posts no line (task: the engine does)');
  let it = (await call('GET', room('/reviews'))).json.items.find((x) => x.n === one);
  assert.deepEqual([it.status, it.unsent], ['replied', null]);
  assert.deepEqual(it.latest.feedback.map((f) => [f.image, f.image_id, f.verdict, f.comment, typeof f.sent_at]),
    [[1, 'lib-rv-a', 'up', '', 'string'], [2, 'lib-rv-b', 'up', 'I prefer this: the laces', 'string'], [3, 'lib-rv-c', 'down', 'too shiny', 'string']]);
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'work', 'reviews.json'), 'utf8')).rooms[ROOM].reviews.find((x) => x.n === one);
  assert.deepEqual(raw.versions[0].feedback.map((f) => f.image), [0, 1, 2], 'stored 0-based');
  assert.equal((await call('POST', sub)).status, 400, 'nothing left to send');
  // several items: 10 items, a couple with several images
  const ns = [];
  for (let i = 0; i < 10; i++) ns.push((await call('POST', room('/reviews'), { title: `batch ${i}`, images: ['lib-rv-a', 'lib-rv-b'] })).json.n);
  for (const n of ns) await rate(n, 1, { verdict: 'up' });
  await rate(ns[2], 2, { verdict: 'up', comment: 'nice hands' });
  await rate(ns[6], 1, { verdict: 'down', comment: 'too dark' });
  await rate(ns[8], 2, { verdict: 'down' });
  await rate(ns[9], 2, { comment: 'can we see the back?' }); // comment-only
  r = await fetch(base + sub, { method: 'POST' });
  j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.summary, `reviewed 10 items, 13 images — 10 👍, 2 👎, 1 comment-only (comments on #${ns[2]}·img2, #${ns[6]}·img1, #${ns[9]}·img2)`);
  assert.deepEqual([j.submitted, j.items], [13, 10]);
  assert.equal(j.roomLine.links.length, 8, 'the engine caps links at 8');
  assert.deepEqual(j.roomLine.links.slice(0, 4).map((l) => l.path), [ns[2], ns[6], ns[8], ns[9]].map((n) => `review/${n}`), '👎 / commented first');
  const lst = (await call('GET', room('/reviews'))).json;
  assert.deepEqual(lst.unsent_ratings, [], 'drafts cleared');
  for (const n of ns) assert.equal(lst.items.find((x) => x.n === n).status, 'replied', `#${n} replied`);
  // re-rating one image of a sent item: a new draft; the sent history per image stays; get_state = each image's latest
  await rate(ns[6], 1, { verdict: 'up', comment: 'better now' });
  it = (await call('GET', room('/reviews'))).json.items.find((x) => x.n === ns[6]);
  assert.deepEqual([it.unsent.ratings.map((d) => [d.image, d.verdict]), it.latest.feedback.map((f) => [f.image, f.verdict])], [[[1, 'up']], [[1, 'down']]]);
  j = (await call('POST', sub)).json;
  assert.equal(j.summary, `reviewed #${ns[6]} — img 1 👍 (comment on img 1)`);
  const st = (await call('GET', room('/state'))).json.feedback.filter((f) => f.n === ns[6]);
  assert.deepEqual(st.map((f) => [f.image, f.verdict, f.comment]), [[1, 'up', 'better now']], 'one row per image: its latest');
  assert.deepEqual((await call('GET', room('/reviews'))).json.items.find((x) => x.n === ns[6]).latest.feedback.map((f) => f.verdict), ['down', 'up'], 'history kept');
  // the line stays ≤ 1000 characters: the comment list is capped
  const many = [];
  for (let i = 0; i < 12; i++) many.push((await call('POST', room('/reviews'), { title: `cap ${i}`, images: ['lib-rv-a', 'lib-rv-b', 'lib-rv-c', 'lib-rv-d'] })).json.n);
  for (const n of many) for (const k of [1, 2, 3, 4]) await rate(n, k, { verdict: k % 2 ? 'up' : 'down', comment: 'c' });
  j = (await call('POST', sub)).json;
  assert.ok(j.roomLine.text.length <= 1000, j.roomLine.text.length);
  assert.match(j.summary, /^reviewed 12 items, 48 images — 24 👍, 24 👎 \(comments on .*, \+28 more\)$/);
});

test('review_submit per REQUESTER: grouped by who asked; the bare route 409s with several; only that group is sent; roomLine.to + data ≤ 4096 bytes', async () => {
  const sub = room('/reviews/submit');
  const rate = (n, image, body) => call('POST', room(`/reviews/${n}/feedback`), { image, ...body });
  // two review items asked for by two different agents (the resident's own + another seat's, via `for`)
  const mine = (await call('POST', room('/reviews'), { title: 'the cape', images: ['lib-rv-a', 'lib-rv-b'] })).json.n;
  const add = await call('POST', room('/reviews'), { title: 'the boots', images: ['lib-rv-c'], for: 'blender-agent' });
  const theirs = add.json.n;
  assert.deepEqual([add.json.item.agent, add.json.announced], ['blender-agent', true]);
  assert.deepEqual([eng.lines.at(-1).tool, eng.lines.at(-1).text], [{ slug: 'asset-studio', for: 'blender-agent' }, `Review #${theirs} ready: the boots (1 image)`], 'the evidence line is FOR the requester');
  await rate(mine, 1, { verdict: 'up' });
  await rate(mine, 2, { verdict: 'down', comment: 'too long' });
  await rate(theirs, 1, { verdict: 'up', comment: 'great soles' });
  // the panel groups by requester
  const pj = await (await fetch(base + room('/panel.json?tab=review'))).json();
  assert.deepEqual(pj.review_items.filter((x) => x.unsent).map((x) => [x.n, x.requester]), [[mine, 'asset-studio'], [theirs, 'blender-agent']]);
  // the bare route: several requesters → 409, nothing sent
  let x = await fetch(base + sub, { method: 'POST' });
  let j = await x.json();
  assert.equal(x.status, 409);
  assert.match(j.error, /several requesters — send per requester/);
  assert.deepEqual(j.requesters.sort(), ['asset-studio', 'blender-agent']);
  // bad / unknown requester
  assert.equal((await fetch(`${base}${sub}/a.b`, { method: 'POST' })).status, 400);
  assert.equal((await fetch(`${base}${sub}/${'x'.repeat(65)}`, { method: 'POST' })).status, 400);
  x = await fetch(`${base}${sub}/nobody`, { method: 'POST' });
  assert.equal(x.status, 400);
  assert.match((await x.json()).error, /nothing to send for @nobody/);
  assert.equal((await fetch(`${base}${sub}/blender-agent`, { method: 'POST', headers: { origin: 'http://evil.example' } })).status, 403);
  // blender-agent's group only
  const before = eng.lines.length;
  x = await fetch(`${base}${sub}/blender-agent`, { method: 'POST' });
  j = await x.json();
  assert.equal(x.status, 200, JSON.stringify(j));
  assert.deepEqual([j.requester, j.submitted, j.items, j.summary], ['blender-agent', 1, 1, `reviewed #${theirs} — img 1 👍 (comment on img 1)`]);
  assert.deepEqual(j.roomLine, { text: j.summary, links: [{ label: `#${theirs}`, path: `review/${theirs}` }], to: 'blender-agent',
    data: { app: 'asset-studio', reviews: [{ n: theirs, v: 1, title: 'the boots', ratings: [{ image: 1, num: 1, verdict: 'up', comment: 'great soles' }], images: { 1: 'lib-rv-c' } }] } });
  assert.equal(eng.lines.length, before, 'the engine posts it, not the app');
  let lst = (await call('GET', room('/reviews'))).json;
  assert.deepEqual(lst.unsent_ratings.map((u) => [u.n, u.image]), [[mine, 1], [mine, 2]], 'the other requester\'s ratings stay unsent');
  assert.deepEqual([lst.items.find((i) => i.n === theirs).status, lst.items.find((i) => i.n === mine).status], ['replied', 'waiting']);
  // one requester left: the bare route works again, and goes to it
  j = (await call('POST', sub)).json;
  assert.deepEqual([j.requester, j.roomLine.to, j.submitted], ['asset-studio', 'asset-studio', 2]);
  // the size cap: long comments are cut (truncated:true), the data stays ≤ 4096 bytes; the text line is unchanged in shape
  const big = [];
  for (let i = 0; i < 4; i++) big.push((await call('POST', room('/reviews'), { title: `long ${i}`, images: ['lib-rv-a', 'lib-rv-b', 'lib-rv-c', 'lib-rv-d'], for: 'blender-agent' })).json.n);
  for (const n of big) for (const k of [1, 2, 3, 4]) await rate(n, k, { verdict: 'up', comment: `${k} `.repeat(900) });
  j = (await (await fetch(`${base}${sub}/blender-agent`, { method: 'POST' })).json());
  const bytes = Buffer.byteLength(JSON.stringify(j.roomLine.data));
  assert.ok(bytes <= 4096, `${bytes} bytes`);
  assert.equal(j.roomLine.data.truncated, true);
  assert.deepEqual(j.roomLine.data.reviews.map((r) => r.n), big, 'every item still there');
  assert.ok(j.roomLine.data.reviews.every((r) => r.ratings.length === 4 && r.ratings.every((d) => !d.comment || d.comment.endsWith('…'))));
  assert.match(j.summary, /^reviewed 4 items, 16 images — 16 👍/);
  // the evidence line is best-effort: engine down → the item is still made, announced:false
  eng.failLines = true;
  try {
    const a = await call('POST', room('/reviews'), { title: 'offline', images: ['lib-rv-a'] });
    assert.deepEqual([a.status, a.json.announced], [200, false]);
  } finally {
    eng.failLines = false;
  }
});

test('migration: item-level (pre per-image) ratings still render and don\'t break submit', async () => {
  // a second app on a copy of the state, with an old-shape item: a SENT whole-item rating and an UNSENT one
  const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'work', 'reviews.json'), 'utf8'));
  const rm = st.rooms[ROOM];
  rm.reviews = [{ n: 1, title: 'old', note: '', status: 'waiting', agent: 'asset-studio', at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z',
    versions: [{ v: 1, images: ['lib-rv-a', 'lib-rv-b'], note: '', at: '2026-09-29T00:00:00Z', feedback: [{ verdict: 'down', comment: 'meh', at: 'a', sent_at: 'b' }] }],
    unsent: { v: 1, verdict: 'up', comment: 'better', at: '2026-09-30T00:00:00Z' } }];
  rm.review_seq = 1;
  const W = path.join(ROOT, 'legacy'); // its own tool folder (one instance per folder)
  fs.cpSync(path.join(ROOT, 'app'), path.join(W, 'app'), { recursive: true });
  for (const f of ['tool.json', 'config.example.json', 'config.local.json']) fs.copyFileSync(path.join(ROOT, f), path.join(W, f));
  fs.mkdirSync(path.join(W, 'work'), { recursive: true });
  delete st.schema; // a file from before the unified review: no schema marker
  const legacyJson = JSON.stringify(st);
  fs.writeFileSync(path.join(W, 'work', 'reviews.json'), legacyJson);
  // an image from Image Studio's days: its room-share file sits in image-studio/renders/ ( incident)
  const ims = JSON.parse(fs.readFileSync(path.join(ROOT, 'work', 'images.json'), 'utf8'));
  const ir = ims.rooms[ROOM];
  const legacyPath = `${ir.share_folder}/image-studio/renders/legacy_g1-1.png`;
  ir.history.find((h) => h.assets.length).assets.push({ id: 'lib-legacy', lib: 'lib-legacy', bin: 'renders', share_path: legacyPath });
  share.files.set(legacyPath, Buffer.from('legacy'));
  fs.writeFileSync(path.join(W, 'work', 'images.json'), JSON.stringify(ims));
  const app2 = spawn(process.execPath, [path.join(W, 'app', 'server.mjs')], {
    cwd: W, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...BASE_ENV, ASSET_STUDIO_TRACK_MS: '50', HARBOR_WB_PANEID: 'pane-1', ASSET_STUDIO_BINDING: BINDING_FILE },
  });
  let err = '';
  app2.stderr.on('data', (c) => (err += c));
  try {
    const port = await waitFor(() => { try { return JSON.parse(fs.readFileSync(path.join(W, 'status', 'app.json'), 'utf8')).port; } catch { return 0; } });
    const b2 = `http://127.0.0.1:${port}/rooms/${ROOM}`;
    const get = async (p) => (await fetch(b2 + p)).json();
    const lst = await get('/reviews');
    // unified review: the first read of a file from before it keeps a copy exactly as it was; an item with no package
    // fields reads as a request for feedback, still waiting = needs your response
    assert.equal(fs.readFileSync(path.join(W, 'work', 'reviews.json.pre-unified'), 'utf8'), legacyJson, 'the backup is the old file, byte for byte');
    assert.deepEqual([lst.items[0].purpose, lst.items[0].needs, lst.items[0].latest.files], ['feedback', true, undefined]);
    assert.deepEqual(lst.unsent_ratings, [{ n: 1, v: 1, verdict: 'up', comment: 'better', at: '2026-09-30T00:00:00Z' }], 'an old unsent rating: no image = the whole item');
    assert.deepEqual(lst.items[0].latest.feedback, [{ verdict: 'down', comment: 'meh', at: 'a', sent_at: 'b' }], 'old sent history as it was');
    assert.deepEqual((await get('/state')).feedback.map((f) => [f.image, f.verdict]), [[undefined, 'down']]);
    const pj = await get('/panel.json?tab=review');
    assert.deepEqual(pj.review_items[0].unsent, { v: 1, images: {}, item: { verdict: 'up', comment: 'better', at: '2026-09-30T00:00:00Z' } });
    assert.equal((await fetch(`${b2}/view.js`)).status, 200);
    // a new per-image rating on the same version sits beside it; submit sends both, in one line
    const fr = await (await fetch(`${b2}/reviews/1/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verdict: 'up', image: 2 }) })).json();
    assert.equal(fr.unsent_count, 2);
    const j = await (await fetch(`${b2}/reviews/submit`, { method: 'POST' })).json();
    assert.equal(j.summary, 'reviewed #1 — whole item 👍, img 2 👍 (comment on whole item)');
    const it = (await get('/reviews')).items[0];
    assert.deepEqual([it.status, it.unsent, it.latest.feedback.map((f) => [f.image, f.verdict])], ['replied', null, [[undefined, 'down'], [undefined, 'up'], [2, 'up']]]);
    assert.equal(fs.readFileSync(path.join(W, 'work', 'reviews.json.pre-unified'), 'utf8'), legacyJson, 'a later save never touches the backup');
    assert.equal(JSON.parse(fs.readFileSync(path.join(W, 'work', 'reviews.json'), 'utf8')).schema, 2, 'and the file now says which shape it is');
    // the reconcile never moves a file outside asset-studio/ (Image Studio's stay put, even when the share can move)
    assert.ok(ir.share_folder, 'the room has a share folder');
    share.canMove = true;
    await new Promise((res) => setTimeout(res, 400)); // ≥ 8 tracker ticks
    share.canMove = false;
    assert.ok(!share.moves.some((m) => m[0] === legacyPath), JSON.stringify(share.moves.filter((m) => m[0].includes('image-studio'))));
  } catch (e) {
    e.message += `\n${err}`;
    throw e;
  } finally {
    app2.kill('SIGTERM');
  }
});

test('release_gpu: unloads the engine when idle; busy (409) is an answer, not an error', async () => {
  const r = await call('POST', room('/gpu/release'), {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.released, r.json.freed_mib], [true, 1234]);
  ig.releaseBusy = true;
  try {
    const b = await call('POST', room('/gpu/release'), {});
    assert.equal(b.status, 200);
    assert.deepEqual([b.json.released, b.json.busy], [false, true]);
  } finally { ig.releaseBusy = false; }
});

test('package (): purpose, summary, ask, limits and files on a version; a file is checked and downloadable; a status never needs a response', async () => {
  const blob = Buffer.alloc(3000, 7);
  share.blobs.set('rooms/test-room/room-color-v1.blend', blob);
  const add = await call('POST', room('/reviews'), {
    title: 'room colour pass', images: ['lib-rv-a', 'lib-rv-b'], purpose: 'vote', summary: 'Cabinets are warmer.', ask: 'Pick the layout you like.', limits: 'Colours are estimates.',
    files: [{ role: 'blend', share: 'rooms/test-room/room-color-v1.blend', label: 'Editable Blender source' }, { role: 'model', library: 'lib-mesh-1' }],
  });
  assert.equal(add.status, 200, JSON.stringify(add.json));
  const n = add.json.n;
  const v1 = add.json.item.versions[0];
  assert.deepEqual([v1.purpose, v1.summary, v1.ask, v1.limits], ['vote', 'Cabinets are warmer.', 'Pick the layout you like.', 'Colours are estimates.']);
  assert.deepEqual(v1.files.map((f) => [f.id, f.role, f.name, f.size, f.href]), [['f1', 'blend', 'room-color-v1.blend', 3000, `download/${n}/1/f1`], ['f2', 'model', 'lib-mesh-1.glb', 4096, `download/${n}/1/f2`]], 'recorded when published');
  assert.equal(v1.files[0].src, undefined, 'the source never leaves the app');
  assert.match(eng.lines.at(-1).text, new RegExp(`^Vote #${n}: room colour pass \\(2 views, 2 downloads\\)`), 'the tool line says which kind of answer is asked for');
  // the list and the panel say the purpose and whether it needs the user
  const row = (await call('GET', room('/reviews'))).json.items.find((x) => x.n === n);
  assert.deepEqual([row.purpose, row.needs, row.latest.files.length], ['vote', true, 2]);
  const pj = await (await fetch(base + room('/panel.json?tab=review'))).json();
  const it = pj.review_items.find((x) => x.n === n);
  assert.deepEqual([it.purpose, it.needs, it.versions[0].files[0].href], ['vote', true, `download/${n}/1/f1`]);
  // the download: streamed, an attachment, the declared file's bytes
  const dl = await fetch(base + room(`/download/${n}/1/f1`));
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /^attachment; filename="room-color-v1\.blend"/);
  assert.equal(dl.headers.get('content-length'), '3000');
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(blob), 'the bytes of the file on the share');
  assert.equal((await fetch(base + room(`/download/${n}/1/f2`))).status, 200, 'a Library file too');
  assert.equal((await fetch(base + room(`/download/${n}/1/f9`))).status, 404, 'only a declared file');
  assert.equal((await fetch(base + room(`/download/${n}/7/f1`))).status, 404);
  assert.equal((await fetch(base + room(`/download/99999/1/f1`))).status, 404);
  // a status is never "waiting on you"; a default is a request for feedback
  const st = await call('POST', room('/reviews'), { title: 'a report', images: ['lib-rv-a'], purpose: 'status', summary: 'All done.' });
  assert.deepEqual([st.json.item.status, (await call('GET', room('/reviews'))).json.items.find((x) => x.n === st.json.n).needs], ['waiting', false]);
  assert.match(eng.lines.at(-1).text, new RegExp(`^Status #${st.json.n}: a report \\(1 view\\)`));
  const plain = await call('POST', room('/reviews'), { title: 'plain', images: ['lib-rv-a'] });
  const prow = (await call('GET', room('/reviews'))).json.items.find((x) => x.n === plain.json.n);
  assert.deepEqual([prow.purpose, prow.needs, prow.latest.purpose], ['feedback', true, undefined], 'nothing given = feedback, and the version stays as it always was');
  assert.match(eng.lines.at(-1).text, /^Review #\d+ ready: plain \(1 image\)$/, 'the line it always had');
  // refusals name the file
  const bad = async (b) => (await call('POST', room('/reviews'), { title: 'x', images: ['lib-rv-a'], ...b }));
  for (const [what, b, re] of [
    ['purpose', { purpose: 'maybe' }, /purpose must be one of status, feedback, vote/],
    ['a missing share file', { files: [{ share: 'rooms/test-room/nope.blend' }] }, /files\[0\]: rooms\/test-room\/nope\.blend is not on the file share/],
    ['a missing Library file', { files: [{ library: 'lib-missing-1' }] }, /files\[0\]: Library asset lib-missing-1 not found/],
    ['both sources', { files: [{ library: 'lib-mesh-1', share: 'a/b.glb' }] }, /exactly one of library/],
    ['neither', { files: [{ role: 'blend' }] }, /exactly one of library/],
    ['a path up', { files: [{ share: '../etc/passwd' }] }, /plain path/],
    ['a hidden file', { files: [{ share: 'rooms/.secret' }] }, /plain path/],
    ['a role', { files: [{ share: 'rooms/test-room/room-color-v1.blend', role: 'script' }] }, /role must be one of/],
    ['an unknown field', { files: [{ share: 'rooms/test-room/room-color-v1.blend', url: 'http://x' }] }, /unknown field 'url'/],
    ['too many', { files: Array.from({ length: 13 }, () => ({ library: 'lib-mesh-1' })) }, /at most 12 files/],
    ['summary', { summary: 'x'.repeat(601) }, /summary is over 600/],
  ]) {
    const r = await bad(b);
    assert.equal(r.status >= 400 && r.status < 500, true, `${what}: ${JSON.stringify(r.json)}`);
    assert.match(r.json.error, re, what);
  }
  // an update: the same package changes nothing; any package change is a new version that keeps what it doesn't touch
  const same = await call('POST', room('/reviews/update'), { n, files: [{ role: 'blend', share: 'rooms/test-room/room-color-v1.blend', label: 'Editable Blender source' }, { role: 'model', library: 'lib-mesh-1' }] });
  assert.equal(same.json.new_version, false, 'the same files again');
  const sum = await call('POST', room('/reviews/update'), { n, summary: 'Cabinets are cooler now.' });
  assert.deepEqual([sum.json.new_version, sum.json.item.versions.length], [true, 2]);
  const v2 = sum.json.item.versions[1];
  assert.deepEqual([v2.purpose, v2.ask, v2.limits, v2.files.length, v2.summary], ['vote', 'Pick the layout you like.', 'Colours are estimates.', 2, 'Cabinets are cooler now.'], 'purpose, ask, limits and files carry over');
  assert.equal((await fetch(base + room(`/download/${n}/1/f1`))).status, 200, 'the old version keeps its files');
  const none = await call('POST', room('/reviews/update'), { n, files: [] });
  assert.deepEqual([none.json.new_version, none.json.item.versions[2].files], [true, undefined], 'files: [] removes them in a new version');
  const swap = await call('POST', room('/reviews/update'), { n, purpose: 'status' });
  assert.deepEqual([swap.json.new_version, (await call('GET', room('/reviews'))).json.items.find((x) => x.n === n).needs], [true, false], 'turned into a report: nothing is asked of the user any more');
  assert.equal((await call('POST', room('/reviews/update'), { n })).status, 400, 'nothing to change');
});

test('structure (unified review P2): 8+ named views, alternatives, a pick, scope decisions; sent as ONE response, readable by the agent', async () => {
  const ids = Array.from({ length: 9 }, (_, k) => (k % 2 ? 'lib-rv-a' : 'lib-rv-b') + (k < 2 ? '' : `-${k}`)); // 9 distinct stub image ids
  const imgs = ids.map((x, k) => (k < 2 ? x : `lib-rv-extra-${k}`));
  const add = await call('POST', room('/reviews'), {
    title: 'cabinet layouts', purpose: 'vote', ask: 'Pick the layout you like.', images: imgs,
    captions: { [imgs[0]]: 'Overview', [imgs[1]]: 'Doors', [imgs[4]]: 'Cabinets' },
    alternatives: [{ label: 'Warm', images: imgs.slice(0, 3) }, { label: 'Cool', images: imgs.slice(3, 6) }],
    scopes: ['layout', 'color'],
  });
  assert.equal(add.status, 200, JSON.stringify(add.json));
  const n = add.json.n;
  const v1 = add.json.item.versions[0];
  assert.equal(v1.images.length, 9, 'more than four views');
  assert.deepEqual(v1.alternatives.map((a) => [a.id, a.label, a.images.length]), [['a', 'Warm', 3], ['b', 'Cool', 3]]);
  assert.deepEqual([v1.captions[imgs[0]], Object.keys(v1.captions).length, v1.scopes], ['Overview', 3, ['layout', 'color']]);
  // refusals say which field
  const bad = async (b) => call('POST', room('/reviews'), { title: 'x', images: imgs.slice(0, 4), ...b });
  for (const [what, b, re] of [
    ['an alternative with no label', { alternatives: [{ images: [imgs[0]] }] }, /alternatives\[0\]\.label must be a string/],
    ['an image outside the version', { alternatives: [{ label: 'A', images: ['lib-rv-nope'] }] }, /not one of the version's images/],
    ['an image in two', { alternatives: [{ label: 'A', images: [imgs[0]] }, { label: 'B', images: [imgs[0]] }] }, /in two alternatives/],
    ['an empty alternative', { alternatives: [{ label: 'A', images: [] }] }, /at least one/],
    ['seven alternatives', { alternatives: Array.from({ length: 7 }, (_, k) => ({ label: `L${k}`, images: [imgs[0]] })) }, /at most 6/],
    ['a caption for a stranger', { captions: { 'lib-rv-nope': 'x' } }, /not one of the version's images/],
    ['a long caption', { captions: { [imgs[0]]: 'x'.repeat(81) } }, /over 80/],
    ['a scope', { scopes: ['mood'] }, /scopes must be a list/],
    ['a repeated scope', { scopes: ['layout', 'layout'] }, /scopes must be a list/],
  ]) {
    const r = await bad(b);
    assert.equal(r.status >= 400 && r.status < 500, true, `${what}: ${JSON.stringify(r.json)}`);
    assert.match(r.json.error, re, what);
  }
  // the user's answers: a pick, a scope decision, a per-image comment; each saved unsent, none of them sent yet
  const feedback = (b) => call('POST', room(`/reviews/${n}/feedback`), b);
  assert.equal((await feedback({ pick: 'c' })).status, 400, 'a pick must be an alternative');
  assert.equal((await feedback({ pick: 'a', image: 1 })).status, 400, 'a pick takes no image');
  assert.equal((await feedback({ pick: 'a', scope: 'layout', decision: 'approve' })).status, 400, 'one answer per call');
  assert.equal((await feedback({ scope: 'geometry', decision: 'approve' })).status, 400, 'a scope the version does not declare');
  assert.equal((await feedback({ scope: 'layout' })).status, 400, 'a scope needs its decision');
  assert.equal((await feedback({ scope: 'layout', decision: 'maybe' })).status, 400);
  const pk = await feedback({ pick: 'b', comment: 'cooler reads better' });
  assert.equal(pk.status, 200, JSON.stringify(pk.json));
  assert.deepEqual(pk.json.unsent.ratings.map((d) => [d.pick, d.comment]), [['b', 'cooler reads better']]);
  await feedback({ scope: 'layout', decision: 'approve' });
  await feedback({ scope: 'color', decision: 'changes' });
  await feedback({ image: 5, comment: 'the handles look off' });
  const st = (await call('GET', room('/state'))).json;
  assert.equal(st.unsent_ratings.filter((d) => d.n === n).length, 4, 'the agent sees four unsent answers, marked as not for it to act on');
  // taking one back
  assert.equal((await feedback({ scope: 'color', decision: null })).json.unsent.ratings.length, 3);
  await feedback({ scope: 'color', decision: 'changes' });
  // the one response
  const sent = await call('POST', room(`/reviews/${n}/send`));
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.match(sent.json.summary, /^reviewed #\d+ — picked B · Cool, layout ✓, color ✗, img 5 💬 \(comments on pick, img 5\)$/, sent.json.summary);
  const rd = sent.json.roomLine.data.reviews.find((x) => x.n === n);
  assert.deepEqual(rd.ratings.map((d) => [d.pick, d.alternative, d.scope, d.decision, d.verdict]), [['b', 'Cool', undefined, undefined, undefined], [undefined, undefined, 'layout', 'approve', undefined], [undefined, undefined, 'color', 'changes', undefined], [undefined, undefined, undefined, undefined, null]]);
  // what the agent reads afterwards: each answer once, the latest per kind
  const fb = (await call('GET', room('/state'))).json.feedback.filter((f) => f.n === n);
  assert.deepEqual(fb.map((f) => f.pick ?? f.scope ?? `img ${f.image}`).sort(), ['color', 'img 5', 'b', 'layout'].sort());
  assert.equal(fb.find((f) => f.scope === 'color').decision, 'changes');
  // "none" is an answer; a pick on a version without alternatives is refused
  const v2 = await call('POST', room('/reviews/update'), { n, note: 'round two' });
  assert.deepEqual([v2.json.new_version, v2.json.item.versions[1].alternatives.length, v2.json.item.versions[1].scopes], [true, 2, ['layout', 'color']], 'alternatives and scopes carry over to the next round');
  assert.equal((await feedback({ pick: 'none' })).status, 200);
  assert.equal((await feedback({ pick: null })).json.unsent_count >= 0, true, 'null takes a pick back'); // and leaves nothing unsent for the tests after this one
  const plain = await call('POST', room('/reviews'), { title: 'plain', images: [imgs[0]] });
  assert.equal((await call('POST', room(`/reviews/${plain.json.n}/feedback`), { pick: 'a' })).status, 400, 'no alternatives to pick between');
  // the images change, the alternatives name images that are gone: refused until sent again
  const gone = await call('POST', room('/reviews/update'), { n, images: [imgs[0], imgs[1]] });
  assert.equal(gone.status, 400, JSON.stringify(gone.json));
  assert.match(gone.json.error, /alternatives name images that are gone/);
  const fix = await call('POST', room('/reviews/update'), { n, images: [imgs[0], imgs[1]], alternatives: [{ label: 'Warm', images: [imgs[0]] }, { label: 'Cool', images: [imgs[1]] }] });
  assert.equal(fix.status, 200, JSON.stringify(fix.json));
  assert.deepEqual(Object.keys(fix.json.item.versions[2].captions ?? {}).sort(), [imgs[0], imgs[1]].sort(), 'captions follow the images that remain');
  const keep = await call('POST', room('/reviews/update'), { n, alternatives: [] });
  assert.deepEqual([keep.json.new_version, keep.json.item.versions[3].alternatives], [true, undefined], '[] drops them in a new version');
});

test('pins (unified review P3): a mark on a model\'s surface, kept in the model\'s own space; a summary in the one response, the whole list readable by the agent', async () => {
  const add = await call('POST', room('/reviews'), { title: 'kitchen model', images: ['lib-mesh-1', 'lib-rv-a'], purpose: 'feedback' });
  assert.equal(add.status, 200, JSON.stringify(add.json));
  const n = add.json.n;
  const pin = { mesh: 'lib-mesh-1', point: '0.5,1.2,-0.3', local: '0.1,0.2,0.3', normal: '0,1,0', node: 'counter_top', path: 'kitchen|counter_top', triangle: '12', bary: '0.2,0.3,0.5', cam: '0,1,4,0,0.5,0,35', hidden: 'ceiling|wall_n', comment: 'the handle is off' };
  const marks = (b) => call('POST', room(`/reviews/${n}/marks`), b);
  const a = await marks(pin);
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.label, 'A');
  const m = a.json.marks[0];
  assert.deepEqual([m.kind, m.mesh_id, m.mesh, m.point, m.local, m.normal, m.node, m.path, m.triangle, m.barycentric, m.camera, m.hidden, m.comment], ['3d', 'lib-mesh-1', 1, [0.5, 1.2, -0.3], [0.1, 0.2, 0.3], [0, 1, 0], 'counter_top', ['kitchen', 'counter_top'], 12, [0.2, 0.3, 0.5], { position: [0, 1, 4], target: [0, 0.5, 0], fov: 35 }, ['ceiling', 'wall_n'], 'the handle is off']);
  assert.deepEqual([m.blender, m.frame], [null, 'glb-scene (glTF: Y up, metres)'], 'a Blender coordinate is never claimed without the export map');
  assert.match(m.blender_note, /mapping missing/);
  // the same label sequence as image marks: B for the next pin, C for a mark on a picture
  assert.equal((await marks({ ...pin, point: '0.6,1.2,-0.3', comment: undefined })).json.label, 'B');
  assert.equal((await marks({ image: 'lib-rv-a', x: 0.5, y: 0.5 })).json.marks.at(-1).label, 'C');
  // refusals
  for (const [what, b, re] of [
    ['a model not in the version', { ...pin, mesh: 'lib-mesh-2' }, /not one of #\d+ v1's images/],
    ['a picture is not a model', { ...pin, mesh: 'lib-rv-a' }, /is not a model/],
    ['no point', { ...pin, point: undefined }, /point must be 3 numbers/],
    ['a bad point', { ...pin, point: '1,2' }, /point must be 3 finite numbers/],
    ['NaN', { ...pin, point: '1,x,3' }, /finite numbers/],
    ['a far point', { ...pin, point: '1e9,0,0' }, /finite numbers/],
    ['a long normal', { ...pin, normal: '5,5,5' }, /normal must be 3 finite numbers/],
    ['no camera', { ...pin, cam: undefined }, /cam must be 7 numbers/],
    ['a field of view', { ...pin, cam: '0,1,4,0,0.5,0,200' }, /field of view/],
    ['a triangle', { ...pin, triangle: '-3' }, /triangle must be a non-negative integer/],
    ['an unknown field', { ...pin, colour: 'red' }, /unknown field 'colour'/],
    ['a long comment', { ...pin, comment: 'x'.repeat(501) }, /over 500/],
    ['a hidden list', { ...pin, hidden: Array.from({ length: 70 }, (_, k) => `p${k}`).join('|') }, /at most 64 names/],
  ]) {
    const r = await marks(Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)));
    assert.equal(r.status >= 400 && r.status < 500, true, `${what}: ${JSON.stringify(r.json)}`);
    assert.match(r.json.error, re, what);
  }
  // a comment on a pin, edited and cleared; a move keeps what it is not sent
  assert.equal((await marks({ label: 'B', comment: 'wrong side' })).json.marks.find((x) => x.label === 'B').comment, 'wrong side');
  assert.equal((await marks({ label: 'B', comment: '' })).json.marks.find((x) => x.label === 'B').comment, undefined);
  const mv = await marks({ label: 'A', point: '1,1,1', local: '1,1,1', normal: '0,0,1', cam: '2,1,4,0,0.5,0,40' });
  const ma = mv.json.marks.find((x) => x.label === 'A');
  assert.deepEqual([ma.point, ma.normal, ma.camera.fov, ma.node, ma.comment, ma.hidden], [[1, 1, 1], [0, 0, 1], 40, 'counter_top', 'the handle is off', ['ceiling', 'wall_n']]);
  // the agent's read: every field, image marks too
  const rd = await call('GET', room(`/reviews/${n}/marks`));
  assert.equal(rd.status, 200, JSON.stringify(rd.json));
  assert.deepEqual(rd.json.marks.map((x) => [x.label, x.kind ?? 'image']), [['A', '3d'], ['B', '3d'], ['C', 'image']]);
  assert.match(rd.json.note, /GLB scene frame/);
  // the one response: a rating, and the pins as a summary (the whole list is the read above)
  await call('POST', room(`/reviews/${n}/feedback`), { image: 2, verdict: 'up' });
  const sent = await call('POST', room(`/reviews/${n}/send`));
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.match(sent.json.summary, /· 3 marks$/);
  const rdata = sent.json.roomLine.data.reviews.find((x) => x.n === n);
  assert.deepEqual(rdata.pins.map((x) => [x.label, x.mesh, x.node]), [['A', 1, 'counter_top'], ['B', 1, 'counter_top']]);
  assert.deepEqual(rdata.pins[0].point, [1, 1, 1]);
  assert.deepEqual(rdata.marks.map((x) => x.label), ['C'], 'the picture mark as ever');
  // many pins: the line stays under its cap; the pins shrink to a summary (and say so); the read still has all of them
  const big = await call('POST', room('/reviews'), { title: 'many pins', images: ['lib-mesh-1'] });
  for (let k = 0; k < 40; k++) await call('POST', room(`/reviews/${big.json.n}/marks`), { ...pin, point: `${k},0,0`, comment: 'c'.repeat(480) });
  await call('POST', room(`/reviews/${big.json.n}/feedback`), { image: 1, verdict: 'down', comment: 'see the pins' });
  const sent2 = await call('POST', room(`/reviews/${big.json.n}/send`));
  const d2 = sent2.json.roomLine.data;
  assert.ok(Buffer.byteLength(JSON.stringify(d2)) <= 4096, 'the cap holds');
  assert.equal(d2.truncated, true);
  const r2 = d2.reviews.find((x) => x.n === big.json.n);
  assert.ok(r2 && (r2.pins_count === 40 || (r2.pins && r2.pins.length === 40)), JSON.stringify(r2).slice(0, 200));
  assert.equal((await call('GET', room(`/reviews/${big.json.n}/marks`))).json.marks.length, 40, 'the whole list is the read');
  // removing one
  assert.equal((await marks({ label: 'B', remove: true })).json.marks.length, 2);
});

test('marks are an answer (, #23): pins alone are unsent, can be sent (a Status too), reach the agent with their labels, stamp sent; a later change or removal makes the item unsent again; an old picture review with no marks is unchanged', async () => {
  await call('POST', room('/reviews/submit/asset-studio'), {}); // whatever earlier tests left unsent goes first
  const pin = { mesh: 'lib-mesh-1', point: '0.5,1.2,-0.3', normal: '0,1,0', cam: '0,1,4,0,0.5,0,35' };
  const st = await call('POST', room('/reviews'), { title: 'a status with a model', images: ['lib-mesh-1'], purpose: 'status', summary: 'done' });
  const n = st.json.n, marks = (b) => call('POST', room(`/reviews/${n}/marks`), b);
  const item = async () => (await (await fetch(base + room('/panel.json?tab=review'))).json()).review_items.find((x) => x.n === n);
  const row = async () => (await call('GET', room('/reviews'))).json.items.find((x) => x.n === n);
  assert.equal((await call('POST', room(`/reviews/${n}/send`))).status, 400, 'nothing yet');
  assert.equal((await row()).unsent_marks, undefined);
  await marks({ ...pin, comment: 'add handles' });
  await marks({ ...pin, point: '0.6,1.2,-0.3', comment: 'add a rug' });
  assert.deepEqual((await item()).marks_unsent, ['A', 'B']);
  assert.equal((await row()).unsent_marks, 2);
  assert.equal((await item()).sent, null);
  const sent = await call('POST', room(`/reviews/${n}/send`));
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.equal(sent.json.roomLine.text, `reviewed #${n} — pins A, B`);
  const rd = sent.json.roomLine.data.reviews.find((x) => x.n === n);
  assert.deepEqual(rd.ratings, []);
  assert.deepEqual(rd.marks_new, ['A', 'B']);
  assert.deepEqual(rd.pins.map((x) => [x.label, x.comment]), [['A', 'add handles'], ['B', 'add a rug']]);
  assert.deepEqual([(await item()).marks_unsent, (await item()).sent.to], [[], 'asset-studio']);
  assert.equal((await row()).unsent_marks, undefined);
  assert.equal((await call('POST', room(`/reviews/${n}/send`))).status, 400, 'sent: nothing to send again');
  // a change to a sent pin: unsent again, and only that pin is new
  await marks({ label: 'A', comment: 'handles on both doors' });
  assert.deepEqual((await item()).marks_unsent, ['A']);
  // removing a sent pin is an answer too; removing an unsent one is not
  await marks({ label: 'B', remove: true });
  assert.deepEqual([(await item()).marks_unsent, (await item()).marks_gone], [['A'], ['B']]);
  const s2 = await call('POST', room(`/reviews/${n}/send`));
  assert.equal(s2.json.roomLine.text, `reviewed #${n} — pin A; removed B`);
  const r2 = s2.json.roomLine.data.reviews.find((x) => x.n === n);
  assert.deepEqual([r2.marks_new, r2.marks_removed], [['A'], ['B']]);
  assert.deepEqual([(await item()).marks_unsent, (await item()).marks_gone], [[], []]);
  const fresh = await marks({ ...pin, point: '0.7,1.2,-0.3' }); // new, then taken away before any send: no trace
  await marks({ label: fresh.json.label, remove: true });
  assert.deepEqual([(await item()).marks_unsent, (await item()).marks_gone], [[], []]);
  assert.equal((await call('POST', room(`/reviews/${n}/send`))).status, 400);
  // the bare submit takes an item whose only answer is a mark
  await marks({ label: 'A', comment: 'once more' });
  const sub = await call('POST', room('/reviews/submit/asset-studio'), {});
  assert.equal(sub.status, 200, JSON.stringify(sub.json));
  assert.match(sub.json.summary, new RegExp(`#${n} — pin A`));
  // picture marks have the same rule; a review with no marks has no new fields
  const pic = await call('POST', room('/reviews'), { title: 'plain', images: ['lib-rv-a', 'lib-rv-b'] });
  const pn = pic.json.n;
  const pi = async () => (await (await fetch(base + room('/panel.json?tab=review'))).json()).review_items.find((x) => x.n === pn);
  assert.deepEqual([(await pi()).marks_unsent, (await pi()).marks_gone], [[], []]);
  assert.equal((await call('POST', room(`/reviews/${pn}/send`))).status, 400);
  await call('POST', room(`/reviews/${pn}/marks`), { image: 'lib-rv-a', x: 0.2, y: 0.3 });
  assert.deepEqual((await pi()).marks_unsent, ['A']);
  const ps = await call('POST', room(`/reviews/${pn}/send`));
  assert.equal(ps.json.roomLine.text, `reviewed #${pn} — mark A`);
  assert.deepEqual((await pi()).marks_unsent, []);
});

test('package: "What changed" belongs to ONE version and never carries over; the bytes asked for are the file\'s own, never a compressed copy', async () => {
  share.blobs.set('rooms/test-room/notes.txt', Buffer.from('plain text '.repeat(400)));
  const a = await call('POST', room('/reviews'), { title: 'carry', images: ['lib-rv-a'], purpose: 'feedback', ask: 'Is it better?', limits: 'estimate', summary: 'Round one: warmer cabinets.' });
  const n = a.json.n;
  assert.equal(a.json.item.versions[0].summary, 'Round one: warmer cabinets.');
  // new images alone: a new version with NO summary; purpose, ask and limits carry over
  const b = await call('POST', room('/reviews/update'), { n, images: ['lib-rv-b'] });
  const v2 = b.json.item.versions[1];
  assert.deepEqual([b.json.new_version, v2.summary, v2.purpose, v2.ask, v2.limits], [true, undefined, 'feedback', 'Is it better?', 'estimate'], 'a summary does not carry over');
  // sending nothing new is still no new version, and leaving the summary out is not "clear it"
  const same = await call('POST', room('/reviews/update'), { n, images: ['lib-rv-b'], ask: 'Is it better?' });
  assert.equal(same.json.new_version, false);
  // giving one makes it that version's; a later round without one has none again
  const c = await call('POST', room('/reviews/update'), { n, summary: 'Round three: doors repainted.' });
  assert.deepEqual([c.json.new_version, c.json.item.versions[2].summary], [true, 'Round three: doors repainted.']);
  const d = await call('POST', room('/reviews/update'), { n, note: 'a longer note' });
  assert.deepEqual([d.json.new_version, d.json.item.versions[3].summary], [true, undefined]);
  // the bytes: the app asks for identity; a source that compresses anyway gets no recorded size and no content-length passed on
  share.gz.add('rooms/test-room/notes.txt');
  const g = await call('POST', room('/reviews'), { title: 'gz', images: ['lib-rv-a'], files: [{ role: 'other', share: 'rooms/test-room/notes.txt' }] });
  assert.equal(g.status, 200, JSON.stringify(g.json));
  assert.equal(share.ae.get('rooms/test-room/notes.txt'), 'identity', 'asks for the file as it is');
  assert.equal(g.json.item.versions[0].files[0].size, null, 'a compressed length is not the file\'s size');
  const dl = await fetch(base + room(`/download/${g.json.n}/1/f1`));
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-length'), null, 'no length of the compressed body on the decoded one');
  assert.equal((await dl.text()), 'plain text '.repeat(400), 'the whole, decoded file');
  // a source that honors accept-encoding is simply sent identity: the real size and length
  share.gz.delete('rooms/test-room/notes.txt');
  share.gzIfAsked.add('rooms/test-room/notes.txt');
  const h = await call('POST', room('/reviews'), { title: 'honest', images: ['lib-rv-a'], files: [{ role: 'other', share: 'rooms/test-room/notes.txt' }] });
  assert.equal(h.json.item.versions[0].files[0].size, 4400);
  const dh = await fetch(base + room(`/download/${h.json.n}/1/f1`));
  assert.equal(dh.headers.get('content-length'), '4400');
  assert.equal(share.ae.get('rooms/test-room/notes.txt'), 'identity');
});

test('review_submit with a note (): one line — the ratings, then "— note: “…”"; the whole note in data.note', async () => {
  await call('POST', room('/reviews/submit/asset-studio'), {}); // marks an earlier test left unsent are an answer too: send them first, so this line is only this item's
  const n = (await call('POST', room('/reviews'), { title: 'note test', images: ['lib-rv-a', 'lib-rv-b'] })).json.n;
  await call('POST', room(`/reviews/${n}/feedback`), { image: 1, verdict: 'down' });
  const j = (await call('POST', room('/reviews/submit/asset-studio'), { note: '  make the shirt longer  ' })).json;
  assert.equal(j.roomLine.text, `reviewed #${n} — img 1 👎 — note: “make the shirt longer”`);
  assert.equal(j.note, 'make the shirt longer');
  assert.equal(j.roomLine.data.note, 'make the shirt longer');
  assert.equal(j.roomLine.data.reviews[0].n, n);
});

test('rail = a click list (): tab/<name> serves the panel one level up on that tab; the rail posts {panel:preview, view}', async () => {
  const html = await (await fetch(base + room('/tab/review'))).text();
  assert.match(html, /data-base="\.\.\/" data-open="tab\/review">/);
  assert.equal((await fetch(base + room('/tab/nope'))).status, 404);
  const js = await (await fetch(base + room('/view.js'))).text();
  assert.match(js, /m\.data\.host === 'surface'/);
  assert.match(js, /post\(\{ panel: 'preview', view: \{ path: 'tab\/' \+ t, title: 'Asset Studio · ' \+ label \} \}\)/);
});

test('review compare (): the Original on the item — set on add, served to the panel, changed or removed on update without a new version', async () => {
  const a = await call('POST', room('/reviews'), { title: 'restore', images: ['lib-rv-b', 'lib-rv-c'], compare: 'lib-rv-a' });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  const n = a.json.n;
  assert.equal(a.json.item.compare, 'lib-rv-a');
  const pj = (await call('GET', room('/panel.json?tab=review'))).json;
  assert.equal(pj.review_items.find((x) => x.n === n).compare, 'lib-rv-a');
  assert.equal((await fetch(base + room('/file/lib-rv-a'))).status, 200);
  let u = await call('POST', room('/reviews/update'), { n, compare: 'lib-rv-d' });
  assert.equal(u.json.item.compare, 'lib-rv-d');
  assert.equal(u.json.new_version, false);
  u = await call('POST', room('/reviews/update'), { n, compare: null });
  assert.equal(u.json.item.compare, undefined);
  assert.equal((await call('POST', room('/reviews'), { title: 'x', images: ['lib-rv-b'], compare: 'not an id' })).status, 400);
});

test('review numbers + marks + your references (task, ): every image numbered for good; marks A…Z, AA across the item; sent with the review', async () => {
  const n = (await call('POST', room('/reviews'), { title: 'cassette', images: ['lib-rv-a', 'lib-rv-b'], compare: 'lib-rv-c' })).json.n;
  let it = (await call('GET', room('/panel.json?tab=review'))).json.review_items.find((x) => x.n === n);
  assert.deepEqual(it.nums, { 'lib-rv-a': 1, 'lib-rv-b': 2, 'lib-rv-c': 3 }, 'images, then the Original');
  // a new version: its new image gets the next number, the old keep theirs
  await call('POST', room('/reviews/update'), { n, images: ['lib-rv-d', 'lib-rv-a'] });
  it = (await call('GET', room('/panel.json?tab=review'))).json.review_items.find((x) => x.n === n);
  assert.equal(it.nums['lib-rv-d'], 4);
  assert.equal(it.nums['lib-rv-a'], 1);
  // marks
  const mk = (b) => call('POST', room(`/reviews/${n}/marks`), b);
  let r = await mk({ image: 'lib-rv-a', x: 0.25, y: 0.5 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.marks, [{ label: 'A', image: 1, image_id: 'lib-rv-a', x: 0.25, y: 0.5 }]);
  r = await mk({ image: 'lib-rv-c', x: 0.123456, y: 1 });
  assert.deepEqual(r.json.marks.map((m) => [m.label, m.image, m.x]), [['A', 1, 0.25], ['B', 3, 0.1235]], 'a mark on the Original too');
  assert.equal((await mk({ image: 'lib-nope', x: 0, y: 0 })).status, 400, 'only a numbered image');
  assert.equal((await mk({ image: 'lib-rv-a', x: 1.5, y: 0 })).status, 400);
  assert.equal((await mk({ image: 'lib-rv-a', x: 0, y: 0, z: 1 })).status, 400);
  r = await mk({ label: 'A', x: 0.5, y: 0.5 });
  assert.deepEqual([r.json.marks[0].x, r.json.marks[0].y], [0.5, 0.5], 'moved');
  r = await mk({ label: 'B', remove: true });
  assert.deepEqual(r.json.marks.map((m) => m.label), ['A']);
  assert.equal((await mk({ label: 'Q', remove: true })).status, 404);
  for (let k = 0; k < 26; k++) r = await mk({ image: 'lib-rv-b', x: 0.1, y: 0.1 });
  assert.deepEqual(r.json.marks.slice(-2).map((m) => m.label), ['Z', 'AA'], 'B … Z, then AA');
  // your reference: the newest room image (the panel pasted it into the room), numbered next
  eng.assets.unshift({ name: 'Pasted image.png', type: 'image/png', bytes: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('PASTE')]) });
  eng.assets[0].addedAt = Date.now(); // the stub lists addedAt: 1 (long ago) unless set
  r = await call('POST', room(`/reviews/${n}/refs`), {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ref.num, 5);
  it = (await call('GET', room('/panel.json?tab=review'))).json.review_items.find((x) => x.n === n);
  assert.deepEqual(it.user_refs, [r.json.ref.id]);
  assert.equal((await fetch(base + room(`/thumb/${r.json.ref.id}`))).status, 200, 'served to the panel');
  assert.equal((await call('POST', room(`/reviews/${n}/refs`), { image: 'lib-rv-d' })).json.ref.num, 4, 'already numbered: keeps it');
  r = await call('POST', room(`/reviews/${n}/refs`), { remove: 'lib-rv-d' });
  assert.deepEqual(r.json.user_refs.map((u) => u.id), [it.user_refs[0]]);
  // sent with the review: numbers → ids, marks, each rating's number
  await call('POST', room(`/reviews/${n}/feedback`), { image: 2, comment: 'make A transparent, like #5' });
  const j = (await call('POST', room('/reviews/submit/asset-studio'), {})).json;
  assert.match(j.roomLine.text, / · 27 marks$/);
  const d = j.roomLine.data.reviews[0];
  assert.deepEqual(d.ratings, [{ image: 2, num: 1, verdict: null, comment: 'make A transparent, like #5' }]);
  assert.equal(d.images[5], it.user_refs[0]);
  assert.deepEqual(d.marks[0], { label: 'A', image: 1, x: 0.5, y: 0.5 });
});

test('one queue for images AND meshes (Asset Studio): a mesh joins the room model set quietly, the panel knows it is a mesh, its thumb and file are served; the Original stays an image', async () => {
  const lines = eng.lines.length;
  const r = await call('POST', room('/reviews'), { title: 'the character mesh', images: ['lib-mesh-1', 'lib-rv-a'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const n = r.json.n;
  assert.equal(eng.lines.length, lines + 1, 'ONE line: the review is ready (the mesh joined the model set without one)');
  const st = (await call('GET', room('/models/state'))).json;
  assert.ok(st.assets.some((a) => a.id === 'lib-mesh-1' && a.via === 'review'), JSON.stringify(st.assets));
  const it = (await call('GET', room('/panel.json?tab=review'))).json.review_items.find((x) => x.n === n);
  assert.deepEqual(it.meshes, { 'lib-mesh-1': 'glb' });
  assert.deepEqual(it.nums, { 'lib-mesh-1': 1, 'lib-rv-a': 2 }, 'meshes are numbered like pictures');
  assert.equal((await fetch(base + room('/file/lib-mesh-1'))).headers.get('content-type'), 'model/gltf-binary');
  assert.equal((await fetch(base + room('/thumb/lib-mesh-1'))).status, 200);
  assert.equal((await fetch(base + room(`/review/${n}/thumb`))).status, 200);
  assert.equal((await call('POST', room('/reviews'), { title: 'x', images: ['lib-rv-a'], compare: 'lib-mesh-2' })).status, 400, 'the Original is a picture');
  assert.equal((await call('POST', room('/reviews'), { title: 'x', images: ['lib-audio-1'] })).status, 400, 'not an image or a mesh');
});

test('light / dark + the palette: the panel takes {host:theme} on the port (known keys, CSS colours only), ?mode=light paints light first, art surfaces are neutral', async () => {
  const js = await (await fetch(base + room('/view.js'))).text();
  assert.match(js, /m\.data\.host === 'theme'\) applyTheme\(m\.data\)/);
  assert.match(js, /var THEME_KEYS = \/\^\(ink\|surface/);
  assert.match(js, /html\.style\.setProperty\('--' \+ k, v\.trim\(\)\)/);
  assert.match(await (await fetch(base + room('/view?mode=light'))).text(), /<html lang="en" data-tiers="[^"]+" data-mode="light">/);
  assert.doesNotMatch(await (await fetch(base + room('/view?mode=x" onload="'))).text(), /onload/);
  const html = await (await fetch(base + room('/view'))).text();
  assert.match(html, /html\[data-mode=light\]\{color-scheme:light;--stage:oklch\(\.94 0 0\)/);
  assert.match(html, /\.rv \.cur\{position:relative;[^}]*background:var\(--stage\)/);
  assert.match(await (await fetch(base + room('/tokens.css'))).text(), /tokens\.css\?v=33/);
});

test('theme messages are the WHOLE palette: going back to dark with tokens:{} clears what light set; art surfaces stay', async () => {
  const js = await (await fetch(base + room('/view.js'))).text();
  const src = js.slice(js.indexOf('var THEME_KEYS'), js.indexOf("window.addEventListener('message'", js.indexOf('function applyTheme')));
  const props = new Map();
  const html = {
    dataset: {},
    style: {
      colorScheme: '',
      get length() { return props.size; },
      item: (i) => [...props.keys()][i],
      setProperty: (k, v) => props.set(k, v),
      removeProperty: (k) => props.delete(k),
    },
  };
  const applyTheme = new Function('html', `${src}\nreturn applyTheme;`)(html);
  props.set('--stage', 'oklch(.94 0 0)'); // ours, not themed: must survive every message
  applyTheme({ host: 'theme', mode: 'light', tokens: { ink: 'oklch(.985 0 0)', surface: '#fff', 'id-teal': 'oklch(.6 .1 200)' } });
  assert.equal(props.get('--ink'), 'oklch(.985 0 0)');
  applyTheme({ host: 'theme', mode: 'dark', tokens: {} });
  assert.equal(html.dataset.mode, 'dark');
  assert.deepEqual([...props.keys()], ['--stage'], 'back to the defaults: every themed token is gone, --stage stays');
  applyTheme({ host: 'theme', mode: 'light', tokens: { ink: '#111', teal: '#0aa' } });
  applyTheme({ host: 'theme', mode: 'dark', tokens: { ink: '#222' } });
  assert.equal(props.get('--ink'), '#222');
  assert.equal(props.has('--teal'), false, 'a token the previous palette set and this one does not is cleared');
  applyTheme({ host: 'theme', mode: 'dark', tokens: { surface: 'url(x)', 'not-a-key': '#fff' } });
  assert.deepEqual([...props.keys()].sort(), ['--stage'], 'bad values and unknown keys are still refused');
  applyTheme({ host: 'theme', mode: 'sepia', tokens: {} });
  assert.equal(props.has('--stage'), true, 'a message with a bad mode is ignored whole');
});

test('the host asset picker (briefing-table 741689f): tool.json declares host_capabilities pick; the panel asks for Room then Library from a click and adds the pick with review_ref', async () => {
  const tool = JSON.parse(fs.readFileSync(path.join(SRC, 'tool.json'), 'utf8'));
  assert.deepEqual(tool.host_capabilities, ['pick']);
  const js = await (await fetch(base + room('/view.js'))).text();
  assert.match(js, /port\.postMessage\(\{ panel: 'pick', kind: 'image', sources: \['room', 'library'\]/);
  assert.match(js, /m\.data\.host === 'picked'\) onPicked\(m\.data\)/);
  assert.match(js, /it\.source === 'library' && typeof it\.library_id === 'string' \? \{ image: it\.library_id \}/);
  // review_ref takes both answers: a room name (imported once) and a Library id
  const n = (await call('POST', room('/reviews'), { title: 'pick', images: ['lib-rv-a'] })).json.n;
  assert.equal((await call('POST', room(`/reviews/${n}/refs`), { image: 'lib-rv-b' })).status, 200);
});

test('v3 review Submit (Aurora 13f29fb): review_note saves the overall note per review; review_send sends ONE review (its ratings + that note) to its requester, other reviews untouched', async () => {
  const a = (await call('POST', room('/reviews'), { title: 'send one', images: ['lib-rv-a', 'lib-rv-b'] })).json.n;
  const b = (await call('POST', room('/reviews'), { title: 'leave me', images: ['lib-rv-c'] })).json.n;
  await call('POST', room(`/reviews/${a}/feedback`), { image: 1, verdict: 'up' });
  await call('POST', room(`/reviews/${b}/feedback`), { image: 1, verdict: 'down' });
  let r = await call('POST', room(`/reviews/${a}/note`), { note: '  keep the palette  ' });
  assert.deepEqual(r.json, { ok: true, n: a, note_draft: 'keep the palette', note_sent: null });
  let it = (await call('GET', room('/panel.json?tab=review'))).json.review_items.find((x) => x.n === a);
  assert.equal(it.note_draft, 'keep the palette');
  r = await call('POST', room(`/reviews/${a}/send`));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.roomLine.text, `reviewed #${a} — img 1 👍 — note: “keep the palette”`);
  assert.deepEqual(r.json.roomLine.data.reviews.map((x) => x.n), [a], 'only this review');
  assert.equal(r.json.roomLine.data.note, 'keep the palette');
  const items = (await call('GET', room('/panel.json?tab=review'))).json.review_items;
  it = items.find((x) => x.n === a);
  assert.deepEqual([it.status, it.unsent, it.note_draft, it.note_sent, it.sent.to], ['replied', null, null, 'keep the palette', 'asset-studio']);
  assert.ok(items.find((x) => x.n === b).unsent, 'the other review keeps its unsent rating');
  assert.equal((await call('POST', room(`/reviews/${a}/send`))).status, 400, 'nothing new to send');
  // a note alone is a send; the same note again is not
  await call('POST', room(`/reviews/${a}/note`), { note: 'one more thing' });
  r = await call('POST', room(`/reviews/${a}/send`));
  assert.equal(r.json.roomLine.text, `reviewed #${a} — note: “one more thing”`);
  assert.equal((await call('POST', room(`/reviews/${a}/note`), { note: 'one more thing' })).json.note_draft, null, 'the sent note is not a draft');
  assert.equal((await call('POST', room(`/reviews/${a}/note`), { x: 1 })).status, 400);
  await call('POST', room(`/reviews/${b}/feedback`), { image: 1 }); // discard b's draft for later tests
});

test('a drag on the 3D viewer is the viewer\'s: the swipe-to-step handlers leave a touch that starts inside .mv alone (, phone)', async () => {
  const js = await (await fetch(base + room('/view.js'))).text();
  assert.match(js, /addEventListener\('touchstart', function \(e\) \{\n\s+if \(e\.target\.closest && e\.target\.closest\('\.mv'\)\)/);
  assert.match(js, /addEventListener\('touchmove', function \(e\) \{\n\s+if \(e\.target\.closest && e\.target\.closest\('\.mv'\)\) return;/);
});

test('placement stays out of the viewer\'s way (): the armed overlay takes no pointer events and nothing stops a press reaching the viewer; Escape closes a menu, then an armed placement, before leaving the focus page', async () => {
  const js = await (await fetch(base + room('/view.js'))).text();
  assert.doesNotMatch(js, /data-pinarmzone'\)\) \|\| \(e\.button/, 'the zone no longer takes the press');
  assert.doesNotMatch(js, /armDown/);
  assert.match(js, /if \(pinMenu\) \{ pinMenu = null; lastSig = ''; render\(\); \}[^\n]*\n\s+else if \(pinArm\) \{ pinArm = null;[^\n]*\n\s+else if \(large\.fimg\)/);
  assert.match(js, /Date\.now\(\) - t\.t > 400/);
  const html = await (await fetch(base + room('/view'))).text();
  assert.match(html, /\.mv-arm\{[^}]*pointer-events:none/);
});

test('the panel script declares every function once (two apps merged into one closure: a duplicate silently replaces the first)', async () => {
  const js = await (await fetch(base + room('/view.js'))).text();
  const names = [...js.matchAll(/^ {2}function ([A-Za-z0-9_$]+)\(/gm)].map((m) => m[1]);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(dup, []);
});

test('the room family: a workgroup of the bound room is accepted and shares its state (one Asset Studio per family); its lines post in the workgroup; another root is still refused', async () => {
  const wg = (p) => `/rooms/${WG}${p}`;
  const a = (await call('GET', room('/reviews'))).json.items.length;
  const r = await call('GET', wg('/reviews'));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.items.length, a, 'the same queue');
  const lines = eng.lines.length;
  const add = await call('POST', wg('/reviews'), { title: 'from the workgroup', images: ['lib-rv-a'] });
  assert.equal(add.status, 200, JSON.stringify(add.json));
  assert.ok((await call('GET', room('/reviews'))).json.items.some((x) => x.n === add.json.n), 'visible from the root');
  assert.equal(eng.lines.length, lines + 1);
  assert.equal((await call('GET', wg('/models/state'))).status, 200);
  assert.equal((await call('GET', wg('/state'))).status, 200);
  assert.equal((await call('GET', `/rooms/${OTHER}/reviews`)).status, 409, 'another family');
});
