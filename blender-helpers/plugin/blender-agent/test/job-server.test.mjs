// Job server (Model Studio backend) against a stub Library/share and a stub Blender. POSIX.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUB = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const a = JSON.parse(fs.readFileSync(process.argv[process.argv.length - 1], 'utf8'));
const mode = a.params.mode || 'ok';
if (mode === 'hang') { require('child_process').spawn('sleep', ['60']); setInterval(() => {}, 1000); return; }
if (a.params.write_out) fs.writeFileSync(path.join(a.out_dir, a.params.write_out), 'glb');
fs.writeFileSync(a.output, 'blend');
fs.writeFileSync(a.report, JSON.stringify({ ok: true, saved: true, summary: { params: a.params } }));
`;
const MESH = '00000000-0000-4000-8000-000000000001';
const uploads = [];

// stub Library + file share in one server
const lib = http.createServer((req, res) => {
  const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url === `/lib/api/assets/${MESH}`) return send({ id: MESH, category: 'mesh', filename: 'm.glb', label: 'Test Man', meta: {} });
  if (req.url === `/lib/api/assets/${MESH}/file`) { res.end('glbbytes'); return; }
  if (req.url.startsWith('/lib/api/assets/') && req.method === 'GET') return send({ id: 'x', category: 'image', meta: {} });
  if (req.url === '/lib/api/assets/upload') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { uploads.push(body); send({ ok: true, asset: { id: `asset-${uploads.length}` } }); });
    return;
  }
  if (req.url.startsWith('/share/api/upload')) return send({ ok: true, saved: ['x/y.glb'] });
  if (req.method === 'PATCH' && req.url.startsWith('/lib/api/assets/')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { uploads.push(`PATCH ${body}`); send({ ok: true }); });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => lib.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${lib.address().port}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-srv-'));
fs.cpSync(path.join(SRC, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(dir, 'recipes'));
fs.copyFileSync(path.join(SRC, 'config.example.json'), path.join(dir, 'config.example.json'));
const shaFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ba-sha-')), 'bearer.sha256'); // outside the tool tree
fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify({ libraryUrl: `${base}/lib`, shareUrl: `${base}/share`, tokenHashFile: shaFile }));
fs.writeFileSync(path.join(dir, 'scripts', 'steps', 'fake.py'), '');
fs.writeFileSync(path.join(dir, 'blender-stub'), STUB, { mode: 0o755 });
const tpl = (id, steps, params = {}) => fs.writeFileSync(path.join(dir, 'recipes', `${id}.json`),
  JSON.stringify({ id, title: id, template: true, op: 'mesh-rig', est_seconds: 5, input: { kind: 'mesh' }, params, steps }));
tpl('quick', [{ step: 'fake', params: { mode: 'ok', n: 1 } }, { step: 'fake', params: { mode: 'ok', write_out: '{name}.glb' } }],
  { tris: { type: 'integer', minimum: 10, maximum: 100, default: 50, title: 'Tris', bind: [['fake', 'n']] } });
tpl('slow', [{ step: 'fake', params: { mode: 'hang', timeout_s: 30 } }]);
fs.writeFileSync(path.join(dir, 'recipes', 'concrete.json'), JSON.stringify({ steps: [] })); // not a template: hidden

const srv = spawn(process.execPath, [path.join(dir, 'scripts', 'job-server.mjs')],
  { env: { ...process.env, BLENDER_AGENT_BLENDER: path.join(dir, 'blender-stub'), MODEL_STUDIO_PORT: '0', BLENDER_DEV_NOAUTH: '1' } });
const port = await new Promise((r) => srv.stdout.once('data', (d) => r(JSON.parse(d).listening.split(':')[1])));
const api = async (p, opts = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { ...opts, headers: { 'content-type': 'application/json' } });
  return { status: res.status, body: await res.json() };
};
const until = async (id, states) => {
  for (let i = 0; i < 100; i++) {
    const { body } = await api(`/jobs/${id}`);
    if (states.includes(body.state)) return body;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timeout');
};
after(() => { srv.kill(); lib.close(); });

test('manifest lists templates as operations with a JSON Schema', async () => {
  const { body } = await api('/manifest');
  assert.equal(body.id, 'blender');
  assert.equal(body.runtime.gpu.need_mb, 0);
  assert.deepEqual(body.operations.map((o) => o.id).sort(), ['quick', 'slow']);
  const q = body.operations.find((o) => o.id === 'quick');
  assert.equal(q.op, 'mesh-rig');
  assert.deepEqual(q.params.properties.tris, { type: 'integer', minimum: 10, maximum: 100, default: 50, title: 'Tris' });
});

test('run validates operation, inputs and params', async () => {
  assert.equal((await api('/run', { method: 'POST', body: JSON.stringify({ id: 'nope', inputs: { mesh: MESH } }) })).status, 400);
  assert.equal((await api('/run', { method: 'POST', body: JSON.stringify({ id: 'quick', inputs: { mesh: '../etc/passwd' } }) })).status, 400);
  assert.equal((await api('/run', { method: 'POST', body: JSON.stringify({ id: 'quick', inputs: { mesh: MESH, extra: MESH } }) })).status, 400);
  assert.equal((await api('/run', { method: 'POST', body: JSON.stringify({ id: 'quick', inputs: { mesh: MESH }, params: { tris: 5 } }) })).status, 400);
  assert.equal((await api('/run', { method: 'POST', body: JSON.stringify({ id: 'quick', inputs: { mesh: MESH }, params: { src: 'x' } }) })).status, 400);
});

test('a job runs, binds params, publishes, and reports asset ids', async () => {
  const r = await api('/run', { method: 'POST', body: JSON.stringify({ id: 'quick', inputs: { mesh: MESH }, params: { tris: 42 }, origin: { room: 'r1', agent: 'a1' } }) });
  assert.equal(r.status, 202);
  const job = await until(r.body.jobId, ['done', 'error']);
  assert.equal(job.state, 'done', JSON.stringify(job));
  assert.equal(job.pct, 100);
  assert.deepEqual(job.result.assetIds, ['asset-1']);
  const recipe = JSON.parse(fs.readFileSync(path.join(dir, 'work', r.body.jobId, 'recipe.json'), 'utf8'));
  assert.equal(recipe.steps[0].params.n, 42);
  assert.equal(recipe.steps[1].params.write_out, 'test_man.glb');
  assert.match(uploads[0], /"provider":"blender"/);
  assert.match(uploads[0], /"room":"r1"/);
  assert.match(uploads.find((u) => u.startsWith('PATCH')), /Model Studio · Blender/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/jobs/${r.body.jobId}/files/test_man.glb`)).status, 200);
});

test('a running job can be cancelled', async () => {
  const r = await api('/run', { method: 'POST', body: JSON.stringify({ id: 'slow', inputs: { mesh: MESH } }) });
  await until(r.body.jobId, ['running']);
  await new Promise((res) => setTimeout(res, 300));
  const c = await api(`/jobs/${r.body.jobId}/cancel`, { method: 'POST' });
  assert.equal(c.body.state, 'cancelled');
  const { body } = await api('/health');
  for (let i = 0; i < 50 && body.busy; i++) await new Promise((res) => setTimeout(res, 100));
  assert.equal((await api('/jobs')).body.jobs[0].state, 'cancelled');
});

test('auth: sha256 from the per-host file outside the repo, read per request, fail-closed; dev no-auth only on loopback', async () => {
  const crypto = await import('node:crypto');
  const s2 = spawn(process.execPath, [path.join(dir, 'scripts', 'job-server.mjs')],
    { env: { ...process.env, BLENDER_AGENT_BLENDER: path.join(dir, 'blender-stub'), MODEL_STUDIO_PORT: '0' } });
  const p2 = await new Promise((r) => s2.stdout.once('data', (d) => r(JSON.parse(d).listening.split(':')[1])));
  const get = (h) => fetch(`http://127.0.0.1:${p2}/manifest`, { headers: h }).then((r) => r.status);
  assert.equal(await get({ authorization: 'Bearer s3cret' }), 401); // file missing: closed
  fs.writeFileSync(shaFile, crypto.createHash('sha256').update('s3cret').digest('hex'));
  assert.equal(await get({}), 401);
  assert.equal(await get({ authorization: 'Bearer wrong' }), 401);
  assert.equal(await get({ authorization: 'Bearer s3cret' }), 200);
  assert.equal((await fetch(`http://127.0.0.1:${p2}/health`)).status, 200);
  s2.kill();
  fs.rmSync(shaFile);
  // the dev flag does nothing off loopback: still closed
  const s3 = spawn(process.execPath, [path.join(dir, 'scripts', 'job-server.mjs')],
    { env: { ...process.env, MODEL_STUDIO_PORT: '0', MODEL_STUDIO_HOST: '0.0.0.0', BLENDER_DEV_NOAUTH: '1' } });
  const p3 = await new Promise((r) => s3.stdout.once('data', (d) => r(JSON.parse(d).listening.split(':')[1])));
  assert.equal((await fetch(`http://127.0.0.1:${p3}/manifest`)).status, 401);
  s3.kill();
});
