// model-studio core tests — node --test (from packages/tools/model-studio: `node --test test/`).
// FAKE backends (express: /manifest /health /run /jobs) and a FAKE Library (GET /api/assets/:id)
// run in-process; the core is registered on a bare express app. Config, state and Library URL
// point at temp paths via env BEFORE server.js is imported (it reads them at load).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

const tmp = mkdtempSync(path.join(tmpdir(), 'model-studio-test-'));
const CONFIG = path.join(tmp, 'config', 'backends.json');
const STATE = path.join(tmp, 'state');
const TOKEN = 'tok-s3cret-DO-NOT-LEAK';
const listen = (app) => new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const servers = [];
let URL_, deadPort;

const LIB = new Map([['m1', 'mesh'], ['m2', 'mesh'], ['i1', 'image'], ['i2', 'image'], ['a1', 'audio']]);

const blenderManifest = {
  id: 'blender', label: 'Blender', version: '2026.09.29', profileVersion: 1,
  runtime: { host: 'gpu-host', health: 'GET /health', gpu: { need_mb: 0 } }, license: null,
  operations: [
    { op: 'mesh-decimate', id: 'decimate', label: 'Decimate',
      inputs: [{ kind: 'asset', category: 'mesh', name: 'mesh', required: true }],
      outputs: [{ kind: 'asset', category: 'mesh', arity: '1' }],
      params: { type: 'object', required: ['ratio'], properties: {
        ratio: { type: 'number', minimum: 0.01, maximum: 1 },
        mode: { type: 'string', enum: ['collapse', 'planar'], default: 'collapse' },
        iterations: { type: 'integer', minimum: 1, maximum: 10, multipleOf: 1, default: 2 },
        name: { type: 'string', maxLength: 8, pattern: '^[a-z]+$' },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
        keep_uv: { type: 'boolean', default: true },
      } }, est: { seconds: 20 }, gpu: null },
    { op: 'mesh-cleanup', id: 'merge', label: 'Merge meshes',
      inputs: [{ kind: 'asset', category: 'mesh', name: 'meshes', arity: '2..3' }],
      outputs: [{ kind: 'asset', category: 'mesh', arity: '1' }], params: { type: 'object', properties: {} } },
    // nested object: outside profile v1 → flagged, never dropped, still runnable
    { op: 'recipe', id: 'weird', label: 'Weird schema',
      inputs: [{ kind: 'asset', category: 'mesh', name: 'mesh' }], outputs: [],
      params: { type: 'object', properties: { opts: { type: 'object', properties: { a: { type: 'integer' } } } } } },
    // per-op gpu override beats runtime.gpu
    { op: 'mesh-texture-project', id: 'bake-gpu', label: 'GPU bake',
      inputs: [{ kind: 'asset', category: 'mesh', name: 'mesh' }], outputs: [], params: null, gpu: { need_mb: 6000 } },
  ],
};
const meshManifest = {
  id: 'mesh-studio', version: '1', profileVersion: 1, runtime: { gpu: { need_mb: 8000 } },
  license: { outputs: 'evaluation_only' },
  operations: [
    { op: 'image-to-mesh', id: 'hunyuan', label: 'Hunyuan', gpu: null,
      inputs: ['front', 'back'].map(n => ({ kind: 'asset', category: 'image', name: n, required: n === 'front' })),
      outputs: [{ kind: 'asset', category: 'mesh', arity: '1' }], params: { type: 'object', properties: {} } },
    { op: 'image-to-mesh', id: 'cpu-preview', label: 'CPU preview', gpu: { need_mb: 0 },
      inputs: [{ kind: 'asset', category: 'image', name: 'front' }], outputs: [], params: { type: 'object', properties: {} } },
  ],
};

// A fake backend: counts hits, records auth + bodies, answers the job protocol.
async function fakeBackend(manifest) {
  const b = { hits: { manifest: 0, health: 0 }, healthy: true, auth: [], runs: [], cancels: [], runStatus: 202, jobs: new Map(), n: 0 };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { b.auth.push(req.headers.authorization || null); next(); });
  app.get('/manifest', (req, res) => { b.hits.manifest++; res.json(manifest); });
  app.get('/health', (req, res) => { b.hits.health++; b.healthy ? res.json({ ok: true, busy: false, version: manifest.version }) : res.status(503).json({ ok: false }); });
  app.post('/run', (req, res) => {
    b.runs.push(req.body);
    if (b.runStatus !== 202) return res.status(b.runStatus).json({ error: 'backend says no' });
    const jobId = `j${++b.n}`;
    b.jobs.set(jobId, { jobId, state: 'running', phase: 'decimate', pct: 40, error: null, result: null });
    res.status(202).json({ jobId });
  });
  app.get('/jobs/:id', (req, res) => { const j = b.jobs.get(req.params.id); j ? res.json(j) : res.status(404).json({ error: 'unknown job' }); });
  app.post('/jobs/:id/cancel', (req, res) => {
    const j = b.jobs.get(req.params.id);
    if (!j) return res.status(404).json({ error: 'unknown job' });
    b.cancels.push(req.params.id); j.state = 'cancelled'; res.json({ ok: true, state: 'cancelled' });
  });
  const s = await listen(app); servers.push(s);
  b.url = `http://127.0.0.1:${s.address().port}`;
  return b;
}

let blender, mesh, disabled;
const writeConfig = (list) => writeFileSync(CONFIG, typeof list === 'string' ? list : JSON.stringify(list));
const fullConfig = () => writeConfig([
  { id: 'blender', url: blender.url, bearer_file: 'blender.bearer', enabled: true },
  { id: 'mesh-studio', url: mesh.url, enabled: true },
  { id: 'off', url: `http://127.0.0.1:${deadPort}`, enabled: true },
  { id: 'dis', url: disabled.url, enabled: false },
]);

before(async () => {
  blender = await fakeBackend(blenderManifest);
  mesh = await fakeBackend(meshManifest);
  disabled = await fakeBackend(blenderManifest);
  const dead = await listen(express()); deadPort = dead.address().port; dead.close();

  const lib = express();
  lib.get('/asset-management/library/api/assets/:id', (req, res) => {
    const c = LIB.get(req.params.id);
    c ? res.json({ id: req.params.id, category: c }) : res.status(404).json({ error: 'not found' });
  });
  const ls = await listen(lib); servers.push(ls);

  process.env.MODEL_STUDIO_CONFIG = CONFIG;
  process.env.MODEL_STUDIO_STATE = STATE;
  process.env.MODEL_STUDIO_LIBRARY_URL = `http://127.0.0.1:${ls.address().port}/asset-management/library`;
  const mod = await import('../server.js');
  const app = express();
  await mod.register(app);          // no config file exists yet: the gateway-boot case
  const s = await listen(app); servers.push(s);
  URL_ = `http://127.0.0.1:${s.address().port}${mod.BASE}/api`;
});

after(() => { servers.forEach(s => s.close()); rmSync(tmp, { recursive: true, force: true }); });

const get = async (p) => { const r = await fetch(URL_ + p); return { status: r.status, body: await r.json() }; };
const post = async (p, body) => {
  const r = await fetch(URL_ + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const run = (body) => post('/run', { provider: 'blender', id: 'decimate', inputs: { mesh: 'm1' }, params: { ratio: 0.5 }, ...body });
async function rejects(body, status, re) {
  const r = await run(body);
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, re);
  return r;
}

test('config absent, then empty = no backends, no ops (not an error)', async () => {
  assert.deepEqual((await get('/backends')).body, { ok: true, backends: [] });
  assert.deepEqual((await get('/ops')).body, { ok: true, ops: [] });
  const { mkdirSync } = await import('node:fs');
  mkdirSync(path.dirname(CONFIG), { recursive: true });
  writeConfig('  \n');
  assert.deepEqual((await get('/backends')).body, { ok: true, backends: [] });
  writeConfig('{not json');
  const r = await get('/backends');
  assert.equal(r.status, 500);
  assert.match(r.body.error, /not valid JSON/);
  writeFileSync(path.join(path.dirname(CONFIG), 'blender.bearer'), `${TOKEN}\n`);
  fullConfig();
});

test('backends: online / offline / disabled; bearer never returned; disabled never contacted', async () => {
  const r = await get('/backends');
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.body).includes(TOKEN));
  const by = Object.fromEntries(r.body.backends.map(b => [b.id, b]));
  assert.deepEqual(Object.keys(by[`blender`]).sort(), ['enabled', 'error', 'id', 'online', 'url', 'version']);
  assert.equal(by.blender.online, true);
  assert.equal(by.blender.version, '2026.09.29');
  assert.equal(by.blender.error, null);
  assert.equal(by.off.online, false);
  assert.match(by.off.error, /engine offline/);
  assert.equal(by.dis.enabled, false);
  assert.equal(by.dis.online, false);
  assert.equal(by.dis.error, 'disabled');
  assert.equal(disabled.hits.manifest + disabled.hits.health, 0);
  assert.ok(blender.auth.every(a => a === `Bearer ${TOKEN}`), 'bearer read from bearer_file (trimmed) on every call');
});

test('ops: flattened, manifest cached 30 s, health live, disabled/offline-never-seen omitted', async () => {
  const m0 = blender.hits.manifest, h0 = blender.hits.health;
  const { body } = await get('/ops');
  await get('/ops');
  assert.equal(blender.hits.manifest, m0, 'manifest served from cache');
  assert.equal(blender.hits.health, h0 + 2, 'health checked every time');
  const ids = body.ops.map(o => `${o.provider}/${o.id}`);
  assert.deepEqual(ids, ['blender/decimate', 'blender/merge', 'blender/weird', 'blender/bake-gpu', 'mesh-studio/hunyuan', 'mesh-studio/cpu-preview']);
  const dec = body.ops[0];
  assert.deepEqual(Object.keys(dec).sort(), ['availability', 'est', 'gpu_need_mb', 'id', 'inputs', 'label', 'license', 'op', 'outputs', 'params', 'provider'].sort());
  assert.equal(dec.availability, 'ready');
  assert.equal(dec.gpu_need_mb, 0);
  const hy = body.ops.find(o => o.id === 'hunyuan');
  assert.equal(hy.gpu_need_mb, 8000, 'gpu:null falls back to runtime.gpu');
  assert.equal(hy.availability, 'waiting-gpu');
  assert.deepEqual(hy.license, { outputs: 'evaluation_only' });
  assert.equal(body.ops.find(o => o.id === 'cpu-preview').availability, 'ready', 'per-op gpu overrides runtime.gpu');
  assert.equal(body.ops.find(o => o.id === 'bake-gpu').gpu_need_mb, 6000);
});

test('ops: ?category filters by input asset category', async () => {
  const mesh_ = (await get('/ops?category=mesh')).body.ops.map(o => o.id);
  const image = (await get('/ops?category=image')).body.ops.map(o => o.id);
  assert.deepEqual(mesh_, ['decimate', 'merge', 'weird', 'bake-gpu']);
  assert.deepEqual(image, ['hunyuan', 'cpu-preview']);
  assert.deepEqual((await get('/ops?category=audio')).body.ops, []);
});

test('profile v1: a bad schema is flagged, never dropped', async () => {
  const { ops } = (await get('/ops')).body;
  const weird = ops.find(o => o.id === 'weird');
  assert.equal(weird.params_unrenderable, true);
  assert.match(weird.params_problem, /opts/);
  for (const id of ['decimate', 'merge', 'bake-gpu', 'hunyuan']) assert.equal(ops.find(o => o.id === id).params_unrenderable, undefined, id);
  const { profileProblem } = await import('../server.js');
  assert.equal(profileProblem({ type: 'object', properties: { a: { type: 'string', format: 'multiline', optionsFrom: '/api/options/a' } } }), null);
  assert.match(profileProblem({ type: 'object', properties: { a: { oneOf: [] } } }), /type/);
  assert.match(profileProblem({ type: 'object', properties: { a: { type: 'string', $ref: '#/x' } } }), /\$ref/);
  assert.match(profileProblem({ type: 'object', properties: { a: { type: 'array', items: { type: 'string' } } } }), /maxItems/);
  assert.match(profileProblem({ type: 'object', properties: { a: { type: 'array', maxItems: 2, items: { type: 'object' } } } }), /items/);
  assert.match(profileProblem({ type: 'object', properties: { a: { type: 'string', format: 'email' } } }), /format/);
  assert.match(profileProblem({ type: 'object', additionalProperties: { type: 'string' }, properties: {} }), /additionalProperties/);
  assert.match(profileProblem({ type: 'object', properties: {}, if: {} }), /'if'/);
  // the flagged op still runs; its params are still checked for unknown keys
  assert.equal((await post('/run', { provider: 'blender', id: 'weird', inputs: { mesh: 'm1' }, params: { opts: { a: 1 } } })).status, 202);
  assert.equal((await post('/run', { provider: 'blender', id: 'weird', inputs: { mesh: 'm1' }, params: { nope: 1 } })).status, 400);
});

test('run validation: provider, op, body', async () => {
  await rejects({ provider: 'nope' }, 400, /unknown provider 'nope'/);
  await rejects({ provider: 'dis' }, 400, /disabled/);
  await rejects({ provider: 'off' }, 400, /offline/);
  await rejects({ id: 'nope' }, 400, /no operation 'nope'/);
  await rejects({ provider: 1 }, 400, /provider and id/);
  await rejects({ extra: 1 }, 400, /unknown field 'extra'/);
});

test('run validation: inputs (names, required, arity, Library existence + category)', async () => {
  await rejects({ inputs: { mesh: 'm1', other: 'm2' } }, 400, /unknown input 'other'.*takes: mesh/);
  await rejects({ inputs: {} }, 400, /input 'mesh' is required/);
  await rejects({ inputs: { mesh: ['m1', 'm2'] } }, 400, /takes 1 asset id/);
  await rejects({ inputs: { mesh: 'i1' } }, 400, /asset i1 is image, needs mesh/);
  await rejects({ inputs: { mesh: 'ghost' } }, 400, /ghost is not in the Library/);
  await rejects({ inputs: 'm1' }, 400, /inputs must be an object/);
  await rejects({ id: 'merge', params: {}, inputs: { meshes: ['m1'] } }, 400, /takes 2\.\.3/);
  await rejects({ id: 'merge', params: {}, inputs: { meshes: ['m1', 'm2', 'm1', 'm2'] } }, 400, /takes 2\.\.3/);
  const ok = await run({ id: 'merge', params: {}, inputs: { meshes: ['m1', 'm2'] } });
  assert.equal(ok.status, 202);
  assert.deepEqual(blender.runs.at(-1).inputs, { meshes: ['m1', 'm2'] });
  // optional named input may be omitted; single-arity input given as [id] is normalised to id
  const r = await post('/run', { provider: 'mesh-studio', id: 'cpu-preview', inputs: { front: ['i1'] } });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.deepEqual(mesh.runs.at(-1).inputs, { front: 'i1' });
});

test('run validation: params (unknown, type, required, enum, bounds, multipleOf, length, pattern, arrays)', async () => {
  await rejects({ params: { ratio: 0.5, bogus: 1 } }, 400, /unknown param 'bogus'.*allowed: ratio, mode/);
  await rejects({ params: {} }, 400, /param 'ratio' is required/);
  await rejects({ params: { ratio: '0.5' } }, 400, /'ratio' must be a number/);
  await rejects({ params: { ratio: 2 } }, 400, /'ratio' must be ≤ 1/);
  await rejects({ params: { ratio: 0 } }, 400, /'ratio' must be ≥ 0.01/);
  await rejects({ params: { ratio: 0.5, mode: 'smash' } }, 400, /'mode' must be one of "collapse", "planar"/);
  await rejects({ params: { ratio: 0.5, iterations: 1.5 } }, 400, /'iterations' must be an integer/);
  await rejects({ params: { ratio: 0.5, keep_uv: 'yes' } }, 400, /'keep_uv' must be true or false/);
  await rejects({ params: { ratio: 0.5, name: 'waytoolongname' } }, 400, /at most 8 characters/);
  await rejects({ params: { ratio: 0.5, name: 'ABC' } }, 400, /must match/);
  await rejects({ params: { ratio: 0.5, tags: ['a', 'b', 'c'] } }, 400, /at most 2 items/);
  await rejects({ params: { ratio: 0.5, tags: [1] } }, 400, /'tags\[0\]' must be a string/);
  await rejects({ params: [] }, 400, /params must be an object/);
  const { validateParams } = await import('../server.js');
  assert.throws(() => validateParams({ type: 'object', properties: { s: { type: 'number', multipleOf: 0.25 } } }, { s: 0.3 }), /multiple of 0.25/);
  assert.deepEqual(validateParams({ type: 'object', properties: { s: { type: 'number', multipleOf: 0.1 } } }, { s: 0.3 }), { s: 0.3 });
});

test('GPU gate: a GPU op is refused with 409 waiting-gpu and never forwarded', async () => {
  const before_ = mesh.runs.length;
  const r = await post('/run', { provider: 'mesh-studio', id: 'hunyuan', inputs: { front: 'i1' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.availability, 'waiting-gpu');
  assert.match(r.body.error, /8000 MB/);
  assert.equal((await run({ id: 'bake-gpu', params: {} })).body.availability, 'waiting-gpu');
  assert.equal(mesh.runs.length, before_);
});

test('run: 202 with a prefixed job id, bearer sent, defaults applied, origin cleaned, logged', async () => {
  const t0 = Date.now();
  const r = await run({ params: { ratio: 0.25, tags: ['x'] }, origin: { room_id: 'r1', agent: 'asset-platform', junk: 'drop' } });
  assert.ok(Date.now() - t0 < 10_000);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.match(r.body.jobId, /^blender:j\d+$/);
  assert.equal(blender.auth.at(-1), `Bearer ${TOKEN}`);
  assert.deepEqual(blender.runs.at(-1), {
    id: 'decimate', inputs: { mesh: 'm1' },
    params: { ratio: 0.25, mode: 'collapse', iterations: 2, tags: ['x'], keep_uv: true },
    origin: { kind: 'room', room_id: 'r1', agent: 'asset-platform' },
  });
  const log = readFileSync(path.join(STATE, 'jobs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const e = log.at(-1);
  assert.equal(e.jobId, r.body.jobId);
  assert.deepEqual(Object.keys(e).sort(), ['at', 'id', 'inputs', 'jobId', 'origin', 'params', 'provider']);
  assert.ok(!readFileSync(path.join(STATE, 'jobs.jsonl'), 'utf8').includes(TOKEN));
});

test('run: a backend refusal is relayed, not reported as started', async () => {
  blender.runStatus = 400;
  await rejects({}, 400, /refused the job: backend says no/);
  blender.runStatus = 500;
  await rejects({}, 502, /refused the job/);
  blender.runStatus = 202;
});

test('jobs: status + cancel proxied; bad and unknown ids', async () => {
  const { jobId } = (await run({})).body;
  const s = await get(`/jobs/${jobId}`);
  assert.equal(s.status, 200);
  assert.equal(s.body.job.jobId, jobId);
  assert.equal(s.body.job.state, 'running');
  const c = await post(`/jobs/${jobId}/cancel`, {});
  assert.equal(c.status, 200);
  assert.equal(blender.cancels.at(-1), jobId.split(':')[1]);
  assert.equal((await get(`/jobs/${jobId}`)).body.job.state, 'cancelled');
  assert.equal((await get('/jobs/blender:nope')).status, 404);
  assert.equal((await get('/jobs/no-colon')).status, 400);
  assert.equal((await get('/jobs/ghost:j1')).status, 400);
});

test('jobs history: newest first, live state best-effort, provider filter, limit', async () => {
  const all = (await get('/jobs?limit=200')).body.jobs;
  const logged = readFileSync(path.join(STATE, 'jobs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).jobId);
  assert.deepEqual(all.map(j => j.jobId), logged.reverse());
  assert.ok(all.every(j => j.live?.jobId), 'live state attached');
  assert.equal((await get('/jobs?limit=2')).body.jobs.length, 2);
  const onlyMesh = (await get('/jobs?provider=mesh-studio')).body.jobs;
  assert.ok(onlyMesh.length >= 1 && onlyMesh.every(j => j.provider === 'mesh-studio'));
  // backend goes away: history still answers, with live:null + a reason
  writeConfig([{ id: 'blender', url: `http://127.0.0.1:${deadPort}`, enabled: true }]);
  const gone = (await get('/jobs?limit=3')).body.jobs;
  assert.ok(gone.every(j => j.live === null && j.live_error));
  fullConfig();
});

test('offline after a good manifest: ops stay listed as offline', async () => {
  blender.healthy = false;
  const { ops } = (await get('/ops')).body;
  assert.ok(ops.filter(o => o.provider === 'blender').length === 4);
  assert.ok(ops.filter(o => o.provider === 'blender').every(o => o.availability === 'offline'));
  await rejects({}, 400, /offline/);
  blender.healthy = true;
  assert.equal((await get('/ops')).body.ops[0].availability, 'ready');
  assert.ok(existsSync(STATE));
});
