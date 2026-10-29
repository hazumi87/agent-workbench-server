#!/usr/bin/env node
/*
 * Model Studio — Blender backend, per the backend contract (Model Studio backend contract, see the package docs).
 * Zero dependencies (node >= 20). A persistent server: run it as a long-running service
 * (autostart off), bound to the tailnet IP, never 0.0.0.0. Blender itself stays
 * one process per step (scripts/run-recipe.mjs).
 *
 *   GET  /health                -> {ok, busy, version}
 *   GET  /manifest              -> provider manifest; one operation per recipe TEMPLATE
 *   POST /run {id, inputs:{mesh:<Library id>}, params, origin?, label?}  -> 202 {jobId}
 *   GET  /jobs/:id              -> {state: queued|running|done|error|cancelled, phase, pct, error,
 *                                   result:{assetIds}, log_tail}
 *   POST /jobs/:id/cancel
 *   GET  /jobs?limit=           -> newest first
 *   GET  /jobs/:id/files/:name  -> an output file (preview PNG, GLB) for panels
 *
 * Recipes are DATA: a template names steps from the fixed step library in this repo
 * plus params; requests may only set the params a template declares (validated, unknown
 * keys rejected) and give Library ids as inputs — never paths, never code.
 * On success the job's outputs are published to the Library (publish.mjs) with
 * derived_op {op, provider, id, version, params, inputs} and the request's origin.
 * Auth (asset-platform's pattern for all backends): the plaintext bearer lives only on
 * the server (the core's bearer_file); this host holds only its sha256, in a per-host file
 * outside the repo (config tokenHashFile, default <install-dir>/bearer.sha256; never in
 * the service manifest), read per request, fail-closed.
 * Everything but /health needs "Bearer <token>" whose sha256 matches.
 * BLENDER_DEV_NOAUTH=1 disables auth only when bound to loopback (tests, local dev).
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT, WORK_DIR, config, killTree, readJson, writeJson } from './lib/common.mjs';
import { VERSION, checkParams, download, err, instantiate, publishJob, schemaOf, template, templates } from './lib/ops.mjs';

const cfg = config();

const INDEX = path.join(WORK_DIR, 'jobs.json');
// Same pattern as the mesh sidecar: the bearer's sha256 lives in a fixed
// per-host file OUTSIDE any git checkout and outside the manifest (config tokenHashFile,
// default <install-dir>/bearer.sha256), read on every request (rotation needs no
// restart); missing/unreadable = closed. BLENDER_DEV_NOAUTH=1 lifts auth on a loopback
// bind only (tests).
const TOKEN_FILE = path.resolve(cfg.tokenHashFile || path.join(ROOT, 'bearer.sha256'));
if (TOKEN_FILE.startsWith(ROOT + path.sep)) {
  console.error(JSON.stringify({ error: `tokenHashFile must be outside the repo: ${TOKEN_FILE}` }));
  process.exit(2);
}
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];
let devNoAuth = false;

function authorized(header) {
  if (devNoAuth) return true;
  let want;
  try {
    want = Buffer.from(fs.readFileSync(TOKEN_FILE, 'utf8').trim().toLowerCase(), 'hex');
  } catch {
    return false;
  }
  const m = /^Bearer (.+)$/.exec(header || '');
  if (!m || want.length !== 32) return false;
  const got = crypto.createHash('sha256').update(m[1]).digest();
  return crypto.timingSafeEqual(got, want);
}
const ID_RE = /^[0-9a-f-]{8,64}$/;

fs.mkdirSync(WORK_DIR, { recursive: true });
const jobs = readJson(INDEX, {});
for (const j of Object.values(jobs)) {
  if (j.state === 'running' || j.state === 'queued') Object.assign(j, { state: 'error', error: 'interrupted by a server restart' });
}
const save = () => writeJson(INDEX, jobs);
save();
let running = null; // {id, child}

function manifest() {
  return {
    id: 'blender', label: 'Blender', version: VERSION, profileVersion: 1,
    runtime: { host: 'gpu-host', health: 'GET /health', gpu: { need_mb: 0 } },
    license: null,
    operations: templates().map((t) => ({
      op: t.op, id: t.id, label: t.title, about: t.about,
      inputs: [{ kind: 'asset', category: 'mesh', name: 'mesh', required: true, ...(t.input?.requires && { requires: t.input.requires }) }],
      outputs: [{ kind: 'asset', category: 'mesh', arity: '1..3' }, { kind: 'asset', category: 'image', arity: '0..1' }],
      params: schemaOf(t), est: { seconds: t.est_seconds || 60 }, gpu: null,
    })),
  };
}

function view(job) {
  const st = readJson(path.join(WORK_DIR, job.id, 'job.json'), { steps: [] });
  const recipe = readJson(path.join(WORK_DIR, job.id, 'recipe.json'), { steps: [] });
  const done = st.steps.filter((s) => s.ok).length;
  const last = st.steps[st.steps.length - 1];
  const logFile = path.join(WORK_DIR, `${job.id}.log`);
  const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-3) : [];
  return {
    ...job,
    phase: job.state === 'running' ? (recipe.steps[st.steps.length]?.step ?? 'publish') : last?.step ?? null,
    pct: recipe.steps.length ? Math.round((100 * done) / recipe.steps.length) : 0,
    steps: st.steps.map(({ n, step, ok, secs, error }) => ({ n, step, ok, secs, ...(error && { error }) })),
    log_tail: tail,
  };
}

function runNext() {
  if (running) return;
  const next = Object.values(jobs).filter((j) => j.state === 'queued').sort((a, b) => a.created.localeCompare(b.created))[0];
  if (!next) return;
  Object.assign(next, { state: 'running', started: new Date().toISOString() });
  save();
  const log = fs.openSync(path.join(WORK_DIR, `${next.id}.log`), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-recipe.mjs'), next.id, path.join(WORK_DIR, next.id, 'recipe.json')],
    { cwd: ROOT, stdio: ['ignore', log, log], windowsHide: true, detached: process.platform !== 'win32' });
  running = { id: next.id, child };
  child.on('exit', async (code) => {
    fs.closeSync(log);
    if (next.state === 'running' && code === 0) {
      const pub = await publishJob(next, template(next.id_recipe) || {});
      if (pub.ok === false || !pub.library) Object.assign(next, { state: 'error', error: pub.error || 'publish failed' });
      else Object.assign(next, { state: 'done', result: { assetIds: Object.values(pub.library), library: pub.library, share: pub.share } });
    } else if (next.state === 'running') {
      const st = readJson(path.join(WORK_DIR, next.id, 'job.json'), { steps: [] });
      const bad = st.steps.find((s) => !s.ok);
      Object.assign(next, { state: 'error', error: bad ? `${bad.step}: ${bad.error}` : `exit ${code}` });
    }
    next.finished = new Date().toISOString();
    const out = path.join(WORK_DIR, next.id, 'out');
    next.files = fs.existsSync(out) ? fs.readdirSync(out) : [];
    running = null;
    save();
    runNext();
  });
}

async function run(body) {
  const t = template(String(body.id || ''));
  if (!t) throw err(400, `no operation ${body.id}`);
  const inputs = body.inputs || {};
  const extraInputs = Object.keys(inputs).filter((k) => k !== 'mesh');
  if (extraInputs.length) throw err(400, `unknown inputs ${extraInputs.join(', ')}`);
  if (!ID_RE.test(String(inputs.mesh || ''))) throw err(400, 'inputs.mesh must be a Library asset id');
  const params = checkParams(t, body.params);
  const inp = await download(inputs.mesh);
  const id = `${t.id}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
  const name = String(inp.label || t.id).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'model';
  fs.mkdirSync(path.join(WORK_DIR, id), { recursive: true });
  writeJson(path.join(WORK_DIR, id, 'recipe.json'), instantiate(t, inputs.mesh, inp.path, name, params));
  const label = typeof body.label === 'string' ? body.label.slice(0, 80) : null;
  jobs[id] = { id, id_recipe: t.id, op: t.op, inputs: { mesh: inputs.mesh }, params, label,
    origin: body.origin && typeof body.origin === 'object' ? body.origin : null, state: 'queued', created: new Date().toISOString() };
  save();
  runNext();
  return id;
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw err(400, 'body must be JSON');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (url.pathname === '/health') return send(res, 200, { ok: true, busy: !!running, version: VERSION });
    if (!authorized(req.headers.authorization)) return send(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET' && url.pathname === '/manifest') return send(res, 200, manifest());
    if (req.method === 'POST' && url.pathname === '/run') return send(res, 202, { jobId: await run(await readBody(req)) });
    if (req.method === 'GET' && url.pathname === '/jobs') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 500);
      return send(res, 200, { jobs: Object.values(jobs).sort((a, b) => b.created.localeCompare(a.created)).slice(0, limit) });
    }
    const job = parts[0] === 'jobs' ? jobs[parts[1]] : null;
    if (parts[0] === 'jobs' && !job) return send(res, 404, { error: 'no such job' });
    if (job && req.method === 'GET' && parts.length === 2) return send(res, 200, view(job));
    if (job && req.method === 'POST' && parts[2] === 'cancel') {
      if (job.state === 'queued') job.state = 'cancelled';
      else if (job.state === 'running' && running?.id === job.id) {
        job.state = 'cancelled';
        killTree(running.child.pid);
      } else return send(res, 409, { error: `job is ${job.state}` });
      save();
      return send(res, 200, view(job));
    }
    if (job && req.method === 'GET' && parts[2] === 'files' && parts[3]) {
      const name = path.basename(decodeURIComponent(parts[3]));
      const file = path.join(WORK_DIR, job.id, 'out', name);
      if (!fs.existsSync(file)) return send(res, 404, { error: 'no such file' });
      const type = { '.png': 'image/png', '.glb': 'model/gltf-binary' }[path.extname(name)] || 'application/octet-stream';
      return send(res, 200, fs.readFileSync(file), type);
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, e.status || 500, { error: e.message });
  }
});

const port = Number(process.env.MODEL_STUDIO_PORT ?? cfg.apiPort ?? 0);
const host = process.env.MODEL_STUDIO_HOST || cfg.apiHost || '127.0.0.1';
devNoAuth = process.env.BLENDER_DEV_NOAUTH === '1' && LOOPBACK.includes(host);
server.listen(port, host, () => {
  fs.mkdirSync(path.join(ROOT, 'status'), { recursive: true });
  writeJson(path.join(ROOT, 'status', 'app.json'), { pid: process.pid, host, port: server.address().port, startedAt: new Date().toISOString() });
  console.log(JSON.stringify({ listening: `${host}:${server.address().port}`, auth: !devNoAuth, version: VERSION }));
  runNext();
});
