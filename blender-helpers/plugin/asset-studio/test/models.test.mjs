/*
 * Model-domain API test (from Model Studio's test/api.test.mjs) — no dependencies. Run: npm test
 *
 * Works on a COPY of the tool in a temp dir (never this folder's status/ or work/), against a FAKE
 * 3D core, a FAKE Library, a FAKE briefing-table engine and a minimal FAKE image-gen (the image
 * domain's heartbeat) on one loopback stub: nothing here calls the real core, the gateway, a GPU host
 * backend, the share or the engine. Every URL the config names is pointed at the stub. The env is
 * scrubbed of HARBOR_WB_* / ASSET_STUDIO_* / FABRIC_* so a run from inside a pane cannot reach real
 * services. Ephemeral ports only. The review queue (meshes included) is test/api.test.mjs's.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'asset-studio-models-')));
const BINDING_FILE = path.join(ROOT, 'state', 'binding.json');
const ROOM = '3f2a9c10-aaaa-bbbb-cccc-000000000001';
const OTHER = '9e8d7c6b-aaaa-bbbb-cccc-000000000002';
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(HARBOR_WB_|ASSET_STUDIO_|FABRIC_)/.test(k)));
const MB = 1024 * 1024;

/* ------------------------------------------------------------------- stubs -- */

// The Library: id -> row; children by parent_id. Outputs of fake jobs are added as they finish.
const LIB = new Map([
  ['mesh-in', { category: 'mesh', format: 'glb', bytes: 5 * MB, label: 'character (rigged + idle)', filename: 'character.glb', parent_id: null }],
  ['mesh-in-opt', { category: 'mesh', format: 'glb', bytes: 600000, label: 'character (three.js, meshopt)', filename: 'ogre_meshopt.glb', parent_id: 'mesh-in' }],
  ['mesh-in-fbx', { category: 'mesh', format: 'fbx', bytes: 2 * MB, label: 'character FBX (Unity)', filename: 'character.fbx', parent_id: 'mesh-in' }],
  ['big-fbx', { category: 'mesh', format: 'fbx', bytes: 30 * MB, label: 'huge fbx', filename: 'huge.fbx', parent_id: null }],
  ['mid-glb', { category: 'mesh', format: 'glb', bytes: 67 * MB, label: 'the 67 MB source', filename: 'source.glb', parent_id: null }],
  ['huge-glb', { category: 'mesh', format: 'glb', bytes: 120 * MB, label: 'over 96 MiB', filename: 'huge.glb', parent_id: null }],
  ['small-glb', { category: 'mesh', format: 'glb', bytes: 1 * MB, label: 'small glb', filename: 'small.glb', parent_id: null }],
  ['img-1', { category: 'image', format: 'png', bytes: 1000, label: 'front view', filename: 'front.png', parent_id: null }],
]);
let THUMB = Buffer.from('stub'); // a real JPEG, made in before()
const lines = [];
const core = { runs: [], opsQueries: [], jobs: new Map(), n: 0, cancels: [], backendsOnline: true };
let engineToken = null;

function stub() {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const out = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      // ---- engine
      let m = u.pathname.match(/^\/api\/rooms\/([^/]+)\/line$/);
      if (m) {
        if (req.headers.authorization !== `Bearer ${engineToken}`) return out(403, { error: 'bearer' });
        lines.push({ room: m[1], ...JSON.parse(raw) });
        return out(200, { status: 'posted' });
      }
      // ---- image-gen (the image domain's heartbeat only)
      if (u.pathname === '/ig/api/health') return out(200, { ok: true, engine: { ok: true, state: 'not-loaded' } });
      if (u.pathname === '/ig/api/models') return out(200, { ok: true, models: [] });
      // ---- Library
      if (u.pathname === '/lib/assets') {
        const p = u.searchParams.get('parent_id');
        const cat = u.searchParams.get('category');
        const assets = [...LIB].filter(([, a]) => a.parent_id === p && (!cat || a.category === cat)).map(([id, a]) => ({ id, ...a }));
        return out(200, { assets, total: assets.length });
      }
      m = u.pathname.match(/^\/lib\/assets\/([^/]+)(?:\/(file|thumb))?$/);
      if (m) {
        const a = LIB.get(m[1]);
        if (!a) return out(404, { error: 'not found' });
        if (!m[2]) return out(200, { id: m[1], ...a });
        if (m[2] === 'thumb') {
          res.writeHead(200, { 'content-type': 'image/jpeg' });
          return res.end(THUMB);
        }
        const body = Buffer.from(`FILE:${m[1]}`);
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
        return res.end(body);
      }
      // ---- the 3D core
      if (!u.pathname.startsWith('/core/api')) return out(404, { error: 'stub: unknown' });
      const p = u.pathname.slice('/core/api'.length);
      if (p === '/backends') return out(200, { ok: true, backends: [{ id: 'blender', online: core.backendsOnline }, { id: 'mesh-studio', online: false }] });
      if (p === '/ops') {
        core.opsQueries.push(u.searchParams.get('category'));
        return out(200, { ok: true, ops: [{ provider: 'blender', op: 'mesh-rig', id: 'rig', label: 'Rig (Rigify)', inputs: [{ kind: 'asset', category: 'mesh', name: 'mesh' }], availability: 'ready' }] });
      }
      if (p === '/run' && req.method === 'POST') {
        const b = JSON.parse(raw);
        core.runs.push(b);
        const extra = Object.keys(b).find((k) => !['provider', 'id', 'inputs', 'params', 'origin'].includes(k));
        if (extra) return out(400, { ok: false, error: `unknown field '${extra}'` });
        if (b.id === 'gpu-op') return out(409, { ok: false, error: 'needs 8000 MB of GPU — waiting on GPU scheduling', availability: 'waiting-gpu' });
        if (b.id === 'bad') return out(400, { ok: false, error: "unknown param 'x'" });
        const jobId = `${b.provider}:j${++core.n}`;
        core.jobs.set(jobId, { id: b.id, polls: 0, state: 'queued' });
        return out(202, { ok: true, jobId });
      }
      m = p.match(/^\/jobs\/([^/]+)(\/cancel)?$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const j = core.jobs.get(id);
        if (!j) return out(404, { ok: false, error: `unknown job ${id}` });
        if (m[2]) {
          core.cancels.push(id);
          j.state = 'cancelled';
          return out(200, { ok: true, job: { ok: true, state: 'cancelled', jobId: id } });
        }
        // queued → running (phase rig, 40 %) → done / error, one step per poll; 'slow' stays running
        if (j.state === 'queued') j.state = 'running';
        else if (j.state === 'running' && j.id !== 'slow' && ++j.polls >= 1) {
          if (j.id === 'fail') j.state = 'error';
          else {
            j.state = 'done';
            const n = id.split(':j')[1];
            LIB.set(`out-glb-${n}`, { category: 'mesh', format: 'glb', bytes: 8 * MB, label: `rig-${n} (rigged + idle)`, filename: `r${n}.glb`, parent_id: 'mesh-in' });
            LIB.set(`out-opt-${n}`, { category: 'mesh', format: 'glb', bytes: 400000, label: `rig-${n} (three.js, meshopt)`, filename: `r${n}_meshopt.glb`, parent_id: `out-glb-${n}` });
            j.result = { assetIds: [`out-glb-${n}`, `out-opt-${n}`] };
          }
        }
        return out(200, { ok: true, job: { jobId: id, state: j.state, phase: j.state === 'running' ? 'rig' : null, pct: j.state === 'running' ? 40 : null,
          error: j.state === 'error' ? 'blender exited 1' : null, result: j.result ?? null } });
      }
      out(404, { ok: false, error: `stub: no ${req.method} ${p}` });
    });
  });
}

/* --------------------------------------------------------------- harness -- */

let srv, app, base;
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
async function call(method, p, body, headers = {}) {
  const r = await fetch(base + p, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
    ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const room = (p) => `/rooms/${ROOM}${p}`;
const mroom = (p) => room(`/models${p}`);
const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 40));
  }
};
const jobDone = (jobId, states = ['done', 'error', 'cancelled', 'lost']) =>
  waitFor(async () => { const j = (await call('GET', mroom(`/jobs/${encodeURIComponent(jobId)}`))).json.job; return states.includes(j.state) && j; });
const panel = async (tab) => (await fetch(base + room(`/panel.json${tab ? `?tab=${tab}` : ''}`))).json();

before(async () => {
  for (const d of ['app', 'scripts', 'test']) fs.cpSync(path.join(SRC, d), path.join(ROOT, d), { recursive: true });
  for (const f of ['tool.json', 'config.example.json']) fs.copyFileSync(path.join(SRC, f), path.join(ROOT, f));
  fs.mkdirSync(path.join(ROOT, 'status'), { recursive: true });
  const port = await listen((srv = stub()));
  const jpg = path.join(ROOT, 'thumb.jpg');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x445566:s=64x64', '-frames:v', '1', jpg]);
  THUMB = fs.readFileSync(jpg);
  engineToken = 'stub-engine-token';
  fs.writeFileSync(path.join(ROOT, 'engine.token'), engineToken + '\n');
  const S = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(ROOT, 'config.local.json'), JSON.stringify({
    coreUrl: `${S}/core/api`, imageGenUrl: `${S}/ig/api`, libraryUrl: `${S}/lib`, libraryWebUrl: 'http://lib.example/asset-management/library',
    shareUrl: `${S}/share`, watchBase: `${S}/watch-share`, libraryStaging: path.join(ROOT, 'staging'),
    port: 0, defaultBudget: 12, defaultModelBudget: 3, engineUrl: S, engineTokenFile: path.join(ROOT, 'engine.token'),
  }));
  fs.mkdirSync(path.dirname(BINDING_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(BINDING_FILE, JSON.stringify({
    room_id: ROOM, room_name: 'Test Room', agent: 'asset-platform', seat_id: 'seat-1', paneid: 'pane-1', at: '2026-09-29T00:00:00Z',
  }), { mode: 0o600 });
  app = spawn(process.execPath, [path.join(ROOT, 'app', 'server.mjs')], {
    cwd: ROOT, env: { ...BASE_ENV, ASSET_STUDIO_TRACK_MS: '40', ASSET_STUDIO_HEARTBEAT_MS: '100', ASSET_STUDIO_BINDING: BINDING_FILE }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const appJson = path.join(ROOT, 'status', 'app.json');
  const p = await waitFor(() => { try { return JSON.parse(fs.readFileSync(appJson, 'utf8')).port; } catch { return 0; } });
  base = `http://127.0.0.1:${p}`;
});

after(() => {
  app?.kill('SIGTERM');
  srv?.close();
});

/* ----------------------------------------------------------------- tests -- */

test('health: up, bound room; the 3D core\'s state reaches panel.json (model.core)', async () => {
  const r = await call('GET', '/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.bound, { room_id: ROOM, room_name: 'Test Room' });
  await waitFor(async () => (await panel('models')).model.core.ok);
  assert.deepEqual((await panel('models')).model.core, { ok: true, state: 'ready', online: 1, total: 2 });
});

test('core offline: no backend online shows as backends-offline; it recovers on the next beat', async () => {
  core.backendsOnline = false;
  try {
    const c = await waitFor(async () => { const x = (await panel('models')).model.core; return !x.ok && x; });
    assert.deepEqual(c, { ok: false, state: 'backends-offline', online: 0, total: 2 });
  } finally {
    core.backendsOnline = true;
  }
  await waitFor(async () => (await panel('models')).model.core.ok);
});

test('exclusive: another room is refused; a bad room id is 400; writes need JSON', async () => {
  const r = await call('GET', `/rooms/${OTHER}/models/state`);
  assert.equal(r.status, 409);
  assert.equal(r.json.reason, 'other-room');
  assert.equal((await call('POST', `/rooms/${OTHER}/models/run`, {})).status, 409);
  assert.equal((await call('GET', '/rooms/..%2Fx/models/state')).status, 400);
  assert.equal((await call('POST', mroom('/import'), '{"asset_id":"img-1"}', { 'content-type': 'text/plain' })).status, 415);
});

test('model_ops: the core catalogue, category passed through', async () => {
  const r = await call('GET', mroom('/ops?category=mesh'));
  assert.equal(r.status, 200);
  assert.equal(r.json.ops[0].id, 'rig');
  assert.equal(core.opsQueries.at(-1), 'mesh');
  assert.equal((await call('GET', mroom('/ops?category=../x'))).status, 400);
});

test('model_import: a Library id joins the set (announced, idempotent); preview = its meshopt child', async () => {
  assert.equal((await call('POST', mroom('/import'), { asset_id: 'nope' })).status, 404);
  assert.equal((await call('POST', mroom('/import'), { asset_id: 'mesh-in', extra: 1 })).status, 400);
  const r = await call('POST', mroom('/import'), { asset_id: 'mesh-in' });
  assert.equal(r.status, 200);
  assert.deepEqual({ id: r.json.asset.id, view: r.json.asset.view, via: r.json.asset.via, category: r.json.asset.category }, { id: 'mesh-in', view: 'glb', via: 'import', category: 'mesh' });
  const line = lines.at(-1);
  assert.match(line.text, /imported "character \(rigged \+ idle\)"/);
  assert.deepEqual(line.tool, { slug: 'asset-studio', for: 'asset-platform' });
  assert.deepEqual(line.from, { paneid: 'pane-1' });
  const again = await call('POST', mroom('/import'), { asset_id: 'mesh-in' });
  assert.equal(again.json.already, true);
  for (const id of ['img-1', 'big-fbx', 'small-glb']) assert.equal((await call('POST', mroom('/import'), { asset_id: id })).status, 200);
  const st = (await call('GET', mroom('/state'))).json;
  assert.deepEqual(st.assets.map((a) => [a.id, a.view]), [['mesh-in', 'glb'], ['img-1', 'image'], ['big-fbx', 'thumb'], ['small-glb', 'glb']]);
});

test('model_run: an input outside the room\'s set is 400 — nothing debited, the core never called', async () => {
  const before = (await call('GET', mroom('/state'))).json.budget.used;
  const n = core.runs.length;
  const r = await call('POST', mroom('/run'), { provider: 'blender', id: 'rig', inputs: { mesh: 'mesh-in-fbx' } });
  assert.equal(r.status, 400);
  assert.equal(r.json.reason, 'not-in-room');
  assert.equal((await call('POST', mroom('/run'), { provider: 'blender', id: 'rig', inputs: { mesh: ['mesh-in', 'x-not-ours'] } })).status, 400);
  assert.equal((await call('POST', mroom('/run'), { provider: 'blender', id: 'rig', inputs: { mesh: 'mesh-in' }, colour: 'red' })).status, 400, 'unknown field');
  assert.equal((await call('POST', mroom('/run'), { provider: 'blender', id: 'rig', inputs: 'mesh-in' })).status, 400);
  assert.equal(core.runs.length, n);
  assert.equal((await call('GET', mroom('/state'))).json.budget.used, before);
});

test('model_run: 202 at once, origin passed, budget debited; the finished job\'s outputs join the set, one line', async () => {
  const t0 = Date.now();
  const r = await call('POST', mroom('/run'), { provider: 'blender', id: 'rig', inputs: { mesh: 'mesh-in' }, params: { fingers: true }, for: 'user' });
  assert.equal(r.status, 202);
  assert.ok(Date.now() - t0 < 10000);
  assert.equal(r.json.budget.used, 1);
  assert.equal(r.json.job.label, 'Rig (Rigify)', 'label from the model_ops cache');
  const sent = core.runs.at(-1);
  assert.deepEqual(sent.inputs, { mesh: 'mesh-in' });
  assert.deepEqual(sent.params, { fingers: true });
  assert.equal(sent.origin.room_id, ROOM);
  assert.equal(sent.origin.room_name, 'Test Room');
  assert.equal(sent.origin.agent, 'asset-platform');
  assert.equal(sent.origin.app, 'asset-studio');
  const j = await jobDone(r.json.job.job_id);
  assert.equal(j.state, 'done');
  const [glb, opt] = j.outputs;
  // outputs join the room's set on the tracker's tick, just after the job reports done: wait for both
  let st;
  for (let i = 0; i < 40; i++) {
    st = (await call('GET', mroom('/state'))).json;
    if (st.assets.some((a) => a.id === glb) && st.assets.some((a) => a.id === opt)) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  const out = st.assets.find((a) => a.id === glb);
  assert.deepEqual({ via: out.via, job_id: out.job_id, view: out.view }, { via: 'output', job_id: j.job_id, view: 'glb' });
  assert.ok(st.assets.some((a) => a.id === opt));
  assert.equal(st.latest.asset.id, glb, 'the main GLB, not its meshopt copy');
  assert.equal(st.budget.used, 1, 'a job that produced outputs is not refunded');
  const line = await waitFor(() => lines.find((l) => l.text.includes(`${glb}`)));
  assert.match(line.text, /Rig \(Rigify\) done — 2 outputs/);
  assert.equal(line.tool.for, 'user');
  // an output is a valid input for the next run
  const next = await call('POST', mroom('/run'), { provider: 'blender', id: 'slow', inputs: { mesh: glb } });
  assert.equal(next.status, 202);
  const running = await jobDone(next.json.job.job_id, ['running']);
  assert.deepEqual([running.phase, running.pct], ['rig', 40]);
  // model_cancel: refunds what it never made
  const c = await call('POST', mroom(`/jobs/${encodeURIComponent(next.json.job.job_id)}/cancel`), {});
  assert.equal(c.json.job.state, 'cancelled');
  assert.ok(core.cancels.includes(next.json.job.job_id));
  assert.equal((await call('GET', mroom('/state'))).json.budget.used, 1);
});

test('model_job_status / model_cancel / model_history: only this room\'s jobs; the image verbs don\'t see them', async () => {
  core.jobs.set('blender:elsewhere', { id: 'rig', state: 'running', polls: 0 });   // the core knows it; this room didn't start it
  assert.equal((await call('GET', mroom('/jobs/blender%3Aelsewhere'))).status, 404);
  assert.equal((await call('POST', mroom('/jobs/blender%3Aelsewhere/cancel'), {})).status, 404);
  assert.ok(!core.cancels.includes('blender:elsewhere'));
  const h = (await call('GET', mroom('/history'))).json.history;
  assert.ok(h.length >= 2 && h.every((j) => j.job_id !== 'blender:elsewhere'));
  assert.ok(Date.parse(h[0].at) >= Date.parse(h[1].at), 'newest first');
  assert.equal((await call('GET', room(`/jobs/${encodeURIComponent(h[0].job_id)}`))).status, 404, 'job_status is the image domain\'s');
});

test('model budget: an error refunds; a lost job refunds; GPU waiting is 409 with nothing debited; exhaustion is 429', async () => {
  const used = () => call('GET', mroom('/state')).then((r) => r.json.budget.used);
  const u0 = await used();
  const f = await call('POST', mroom('/run'), { provider: 'blender', id: 'fail', inputs: { mesh: 'mesh-in' } });
  assert.equal(f.status, 202);
  const fj = await jobDone(f.json.job.job_id);
  assert.equal(fj.state, 'error');
  assert.equal(fj.refunded, true);
  assert.equal(await used(), u0);
  await waitFor(() => lines.find((l) => /failed — blender exited 1 \(not charged\)/.test(l.text)));
  const g = await call('POST', mroom('/run'), { provider: 'mesh-studio', id: 'gpu-op', inputs: { mesh: 'mesh-in' } });
  assert.equal(g.status, 409);
  assert.equal(g.json.reason, 'waiting-gpu');
  const bad = await call('POST', mroom('/run'), { provider: 'blender', id: 'bad', inputs: { mesh: 'mesh-in' }, params: { x: 1 } });
  assert.equal(bad.status, 400);
  assert.equal(await used(), u0, 'refused runs give their slot back');
  // lost: the core forgets a running job (backend restart)
  const l = await call('POST', mroom('/run'), { provider: 'blender', id: 'slow', inputs: { mesh: 'mesh-in' } });
  await jobDone(l.json.job.job_id, ['running']);
  core.jobs.delete(l.json.job.job_id);
  assert.equal((await jobDone(l.json.job.job_id)).state, 'lost');
  assert.equal(await used(), u0);
  // exhaustion (defaultModelBudget 3; 1 used by the done job)
  const a = await call('POST', mroom('/run'), { provider: 'blender', id: 'slow', inputs: { mesh: 'mesh-in' } });
  const b = await call('POST', mroom('/run'), { provider: 'blender', id: 'slow', inputs: { mesh: 'mesh-in' } });
  assert.deepEqual([a.status, b.status], [202, 202]);
  const over = await call('POST', mroom('/run'), { provider: 'blender', id: 'rig', inputs: { mesh: 'mesh-in' } });
  assert.equal(over.status, 429);
  assert.equal(over.json.reason, 'budget');
  for (const x of [a, b]) await call('POST', mroom(`/jobs/${encodeURIComponent(x.json.job.job_id)}/cancel`), {});
});

test('model_set_budget: control; raising keeps the count, reset zeroes it, minutes sets a deadline; announced; the image budget is its own', async () => {
  const imageBudget = (await call('GET', room('/state'))).json.budget;
  const bad = await call('POST', mroom('/budget'), { max_jobs: 0 });
  assert.equal(bad.status, 400);
  const r = await call('POST', mroom('/budget'), { max_jobs: 10, minutes: 30 });
  assert.equal(r.json.budget.max_jobs, 10);
  assert.equal(r.json.budget.used, 1);
  assert.ok(Date.parse(r.json.budget.until) > Date.now());
  assert.match(lines.at(-1).text, /model budget set to 10 jobs, until \d\d:\d\d UTC — 1 used/);
  assert.equal(lines.at(-1).tool.for, 'user');
  const z = await call('POST', mroom('/budget'), { max_jobs: 4, reset: true, minutes: null });
  assert.deepEqual([z.json.budget.used, z.json.budget.until, z.json.budget.left], [0, null, 4]);
  assert.deepEqual((await call('GET', room('/state'))).json.budget, imageBudget, 'set_budget (images) untouched');
  const tj = JSON.parse(fs.readFileSync(path.join(SRC, 'tool.json'), 'utf8'));
  assert.equal(tj.verbs.find((v) => v.name === 'model_set_budget').class, 'control');
});

test('panel file/thumb: this room\'s model assets, CORS-open; a mesh serves its meshopt copy; > 20 MB is 413', async () => {
  const f = await fetch(base + room('/file/mesh-in'));
  assert.equal(f.status, 200);
  assert.equal(f.headers.get('content-type'), 'model/gltf-binary');
  assert.equal(f.headers.get('access-control-allow-origin'), '*');
  assert.equal(await f.text(), 'FILE:mesh-in-opt', 'the meshopt child, never the full GLB');
  assert.equal(await (await fetch(base + room('/file/small-glb'))).text(), 'FILE:small-glb', 'a small GLB serves itself');
  assert.equal((await fetch(base + room('/file/big-fbx'))).status, 413);
  assert.equal((await fetch(base + room('/file/mesh-in-fbx'))).status, 404, 'in the Library, not in this room');
  assert.equal((await fetch(base + room('/thumb/mesh-in-fbx'))).status, 404);
  const t = await fetch(base + room('/thumb/big-fbx'));
  assert.equal(t.status, 200);
  assert.equal(t.headers.get('content-type'), 'image/jpeg');
  assert.equal((await fetch(base + room('/file/mesh-in'), { method: 'POST' })).status, 405, 'GET-only');
  assert.equal((await (await fetch(`${base}/rooms/${OTHER}/file/mesh-in`)).json()).ok, false);
});

test('panel file: a GLB up to 96 MiB serves itself (the 67 MB character source), over 96 MiB is 413; a non-GLB stays at 20 MiB', async () => {
  for (const id of ['mid-glb', 'huge-glb']) assert.equal((await call('POST', mroom('/import'), { asset_id: id })).status, 200);
  const mid = await fetch(base + room('/file/mid-glb'));
  assert.equal(mid.status, 200);
  assert.equal(mid.headers.get('content-type'), 'model/gltf-binary');
  assert.equal(await mid.text(), 'FILE:mid-glb');
  const huge = await fetch(base + room('/file/huge-glb'));
  assert.equal(huge.status, 413);
  assert.match((await huge.json()).error, /96 MiB|no preview small enough/);
  assert.equal((await fetch(base + room('/file/big-fbx'))).status, 413, 'a 30 MB non-GLB is still over the 20 MiB panel cap');
});

test('panel: shell is relative-only with a CSP the viewer needs; viewer + vendored three.js are CORS-open modules', async () => {
  const v = await fetch(base + room('/view'));
  const h = await v.text();
  assert.match(v.headers.get('content-security-policy'), /script-src 'self' 'wasm-unsafe-eval'/);
  assert.doesNotMatch(h, /(src|href)="\//, 'no absolute paths');
  assert.match(await (await fetch(`${base}/rooms/${OTHER}/view`)).text(), /another room/);
  for (const f of ['viewer.js', 'vendor/three.module.min.js', 'vendor/three.core.min.js', 'vendor/GLTFLoader.js',
    'vendor/OrbitControls.js', 'vendor/BufferGeometryUtils.js', 'vendor/meshopt_decoder.module.js', 'vendor/LICENSE']) {
    const r = await fetch(base + room(`/${f}`));
    assert.equal(r.status, 200, f);
    assert.equal(r.headers.get('access-control-allow-origin'), '*', f);
  }
  const gl = await (await fetch(base + room('/vendor/GLTFLoader.js'))).text();
  assert.doesNotMatch(gl, /from\s*'three'/);
  assert.match(gl, /from '\.\/three\.module\.min\.js'/);
  assert.match(gl, /from '\.\/BufferGeometryUtils\.js'/);
  assert.equal((await fetch(base + room('/vendor/..'))).status, 404);
  assert.doesNotMatch(await (await fetch(base + room('/viewer.js'))).text(), /innerHTML|\d\s*vh\b/);
});

test('viewer animations (): a picker of every clip in the GLB + Play / Stop; rest pose until Play, Stop restores it; no autoplay; the Watch tab gets its own row, not the corner', async () => {
  const js = await (await fetch(base + room('/viewer.js'))).text();
  assert.match(js, /export function animRow\(h, el\)/, 'the row is a function the caller can place');
  assert.match(js, /sel\.className = 'mv-clip'/, 'the picker');
  assert.match(js, /p\.className = 'mv-play'/);
  assert.match(js, /x\.className = 'mv-stop'/, 'Stop');
  assert.match(js, /cs\.forEach\(function \(c, i\) \{\s*var o = document\.createElement\('option'\)/, 'one option per clip');
  assert.match(js, /rest\.push\(\{ o: o, p: o\.position\.clone\(\), q: o\.quaternion\.clone\(\), s: o\.scale\.clone\(\) \}\)/, 'the rest pose is recorded at load');
  assert.match(js, /mixer\.stopAllAction\(\);\s*rest\.forEach\(function \(r\) \{\s*r\.o\.position\.copy\(r\.p\)/, 'Stop puts every node back');
  assert.doesNotMatch(js, /action\.play\(\);\s*playButton\(\)|\.clipAction\(g\.animations\[0\]\)/, 'the first clip no longer autoplays on load');
  assert.match(js, /if \(opts\.anim !== false\) el\.appendChild\(\(overlay = animRow\(handle, el\)\)\)/, 'over the canvas unless the caller says no');
  assert.match(js, /mixer\.uncacheRoot\(current\);[\s\S]*?overlay\.parentNode\.removeChild\(overlay\)/, 'dispose clears the mixer and takes its row off');
  const view = await (await fetch(base + room('/view.js'))).text();
  assert.match(view, /m\.mount\(box, mine\.url, \{ anim: false \}\)/, 'Watch: no row in the stage corner (parts, cameras and the foot are there)');
  assert.match(view, /mine\.anim\.appendChild\(m\.animRow\(mine\.handle, box\)\)/);
  assert.match(view, /add\(sec, stage, wt\.mv\.anim, ui\.mcap\)/, 'Watch list layout: a line below the stage');
  assert.match(view, /add\(bot, lookStrip\(ui\), m && m\.file \? wt\.mv\.anim : null, ctl, ui\.warn\)/, 'Watch page layout: above the scrubber');
  const css = await (await fetch(base + room('/panel.json?tab=models'))).text() + await (await fetch(base + room('/view?tab=models'))).text();
  assert.match(css, /\.mv>\.mv-anim\{position:absolute;left:10px;top:10px/, 'over a plain viewer: top left');
  assert.match(css, /\.mv-stop:disabled\{opacity:\.4/);
});

test('panel.json: the model part on every tab (Models = studio, Watch = watch); ETag → 304 when unchanged; another room gets a message', async () => {
  const r = await fetch(base + room('/panel.json?tab=models'));
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  const j = await r.json();
  assert.deepEqual([j.ok, j.tab], [true, 'models']);
  const m = j.model;
  assert.equal(m.tab, 'studio');
  assert.ok(m.latest.asset.id.startsWith('out-glb-'));
  assert.ok(m.jobs.length && m.assets.length && typeof m.n_jobs === 'number' && typeof m.n_assets === 'number');
  assert.equal(m.core.ok, true);
  assert.equal(m.budget.max_jobs, 4);
  assert.equal(m.library_web, 'http://lib.example/asset-management/library');
  assert.equal((await panel('watch')).model.tab, 'watch');
  for (const tab of ['studio', 'review', undefined]) assert.equal((await panel(tab)).model.tab, 'studio', `tab ${tab}`);
  const etag = r.headers.get('etag');
  const again = await fetch(base + room('/panel.json?tab=models'), { headers: { 'if-none-match': etag } });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get('access-control-allow-origin'), '*');
  assert.equal((await fetch(base + room('/panel.json?tab=watch'), { headers: { 'if-none-match': etag } })).status, 200);
  assert.equal((await (await fetch(`${base}/rooms/${OTHER}/panel.json`)).json()).ok, false);
});

test('rail + links: tab/models and tab/watch serve the panel one level up on that tab; watch/<job> opens the panel on that job', async () => {
  for (const t of ['models', 'watch']) assert.match(await (await fetch(base + room(`/tab/${t}`))).text(), new RegExp(`data-base="\\.\\./" data-open="tab/${t}">`));
  assert.notEqual((await fetch(base + room('/tab/nope'))).status, 200);
  assert.match(await (await fetch(base + room('/watch/character-kit-v4'))).text(), /data-base="\.\.\/" data-open="watch\/character-kit-v4">/);
});

test('state persists to work/models.json (its own file: images.json never holds the model domain)', () => {
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'work', 'models.json'), 'utf8'));
  assert.ok(s.rooms[ROOM].assets.length >= 4);
  assert.ok(s.rooms[ROOM].jobs.length >= 2);
  const imgFile = path.join(ROOT, 'work', 'images.json');
  if (fs.existsSync(imgFile)) assert.equal(fs.readFileSync(imgFile, 'utf8').includes('mesh-in'), false);
});

test('tool.json: every model_* verb has a class and a JSON http call under /models matching the scripts\' table', () => {
  const tj = JSON.parse(fs.readFileSync(path.join(SRC, 'tool.json'), 'utf8'));
  const mjs = fs.readFileSync(path.join(SRC, 'scripts', 'lib', 'tool.mjs'), 'utf8');
  const table = Object.fromEntries([...mjs.matchAll(/(\w+): \['(GET|POST)', '([^']+)'/g)].map((m) => [m[1], `${m[2]} /rooms/:roomId${m[3].replace(':id', ':jobId')}`]));
  const mv = tj.verbs.filter((v) => v.name.startsWith('model_'));
  assert.deepEqual(mv.map((v) => v.name).sort(), ['model_cancel', 'model_history', 'model_import', 'model_job_status', 'model_ops', 'model_run', 'model_set_budget', 'model_state']);
  for (const v of mv) {
    assert.ok(['read', 'mutate', 'control'].includes(v.class), v.name);
    assert.equal(v.call.http, table[v.name], v.name);
    assert.match(v.call.http, /^(GET|POST) \/rooms\/:roomId\/models\//, v.name);
  }
});

test('links: a watch/<job> chip (the live Watch view of a run) next to review chips', async () => {
  const j = await (await fetch(`${base}/rooms/${ROOM}/links?refs=watch/character-kit-v4,review/999`)).json();
  assert.deepEqual(j.items[0], { ref: 'watch/character-kit-v4', label: 'Watch · character-kit-v4' });
  assert.equal(j.items[1].stale, true);
});
