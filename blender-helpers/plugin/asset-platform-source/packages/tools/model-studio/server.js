// model-studio — the Model Studio CORE: one orchestrator over pluggable 3D backends.
//
// Contract: the design notes (+ both addenda), extending the tool-manifest decision
// the design notes (§3 manifest, §4 JSON Schema profile v1, §7 job protocol).
//   - Backends (Blender, mesh-studio image-to-mesh, decimators …) are SEPARATE HTTP processes.
//     The core never imports them, so a broken backend shows as "offline" instead of taking
//     the gateway down.
//   - The backend list is a HUMAN-EDITED config file, never discovered (addendum 2 §1):
//     [{ id, url, bearer_file?, enabled }]. Missing/empty file = no backends.
//   - Each backend serves GET /manifest (cached 30 s), GET /health, POST /run → 202 {jobId},
//     GET /jobs/:id, POST /jobs/:id/cancel. The core validates strictly before forwarding
//     (unknown params rejected, addendum 1 §4) and hands out '<provider>:<backendJobId>'.
//   - The Library full-page app and the briefing-table room tool both call THIS; the core has
//     no notion of a room (room scoping lives in the room tool, addendum 2 §2).
//
//   GET  ${BASE}/api/backends             → { ok, backends:[{id,url,enabled,online,version,error}] }
//   GET  ${BASE}/api/ops[?category=mesh]  → { ok, ops:[flattened operations + availability] }
//   POST ${BASE}/api/run                  → 202 { ok, jobId }  ·  400 invalid · 409 waiting-gpu
//   GET  ${BASE}/api/jobs/:jobId          → { ok, job }   (proxied to the backend)
//   POST ${BASE}/api/jobs/:jobId/cancel   → proxied
//   GET  ${BASE}/api/jobs?provider=&limit= → { ok, jobs } — the core's own log, newest first
//
// The gateway loads this into ONE process shared with every tool — a bad import here 404s ALL
// tools. So: node built-ins + express only, and nothing at import or register time reads the
// config, the network or the state dir.
import express from 'express';
import { appendFile, mkdir, readFile } from 'fs/promises';
import path from 'path';

const ROOT = process.env.ASSET_PLATFORM_ROOT || (process.env.HOME || '.') + '/asset-management';
export const BASE = '/asset-management/tools/model-studio';
const CONFIG = process.env.MODEL_STUDIO_CONFIG || path.join(ROOT, 'model-studio-config', 'backends.json');
const STATE = process.env.MODEL_STUDIO_STATE || path.join(ROOT, 'model-studio-state');
const JOB_LOG = path.join(STATE, 'jobs.jsonl');
const LIBRARY = (process.env.MODEL_STUDIO_LIBRARY_URL || 'http://127.0.0.1:8260/asset-management/library').replace(/\/$/, '');
const PROBE_MS = 4000;          // manifest + health
const MANIFEST_TTL_MS = 30_000;
const FORWARD_MS = 8000;        // POST {url}/run
const RUN_BUDGET_MS = 9500;     // run answers 202 within 10 s (addendum 1 §6), whatever the probes cost
const PROVIDER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;   // no ':' — it separates provider from backend job id

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const bad = (msg) => new HttpError(400, msg);

// ── Config (read per request, so a human edit needs no gateway restart) ─────────────────────
async function loadConfig() {
  let text;
  try { text = await readFile(CONFIG, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw new HttpError(500, `model-studio config unreadable: ${e.message}`); }
  if (!text.trim()) return [];
  let list;
  try { list = JSON.parse(text); } catch (e) { throw new HttpError(500, `model-studio config ${CONFIG} is not valid JSON: ${e.message}`); }
  if (!Array.isArray(list)) throw new HttpError(500, `model-studio config ${CONFIG} must be a JSON array of backends`);
  return list.map((b, i) => {
    if (!b || !PROVIDER_RE.test(b.id)) throw new HttpError(500, `model-studio config entry ${i}: id must match ${PROVIDER_RE}`);
    if (typeof b.url !== 'string' || !/^https?:\/\//.test(b.url)) throw new HttpError(500, `model-studio config entry '${b.id}': url must be http(s)`);
    return { id: b.id, url: b.url.replace(/\/$/, ''), enabled: b.enabled !== false,
      bearer_file: b.bearer_file ? path.resolve(path.dirname(CONFIG), b.bearer_file) : null };
  });
}

async function getBackend(provider) {
  const b = (await loadConfig()).find(x => x.id === provider);
  if (!b) throw bad(`unknown provider '${provider}' — see GET ${BASE}/api/backends`);
  if (!b.enabled) throw bad(`provider '${provider}' is disabled in the model-studio config`);
  return b;
}

// ── Backend HTTP (the bearer is read at call time and never logged or returned) ─────────────
async function backendFetch(b, p, { method = 'GET', body, timeout = PROBE_MS } = {}) {
  const headers = {};
  if (b.bearer_file) {
    try { headers.Authorization = `Bearer ${(await readFile(b.bearer_file, 'utf8')).trim()}`; }
    catch (e) { throw new HttpError(502, `provider '${b.id}': bearer file unreadable (${e.code || 'error'})`); }
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let r;
  try {
    r = await fetch(b.url + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    const timedOut = e.name === 'TimeoutError';
    throw new HttpError(timedOut ? 504 : 502, `provider '${b.id}' ${timedOut ? `did not answer within ${timeout / 1000}s` : `unreachable (${e.cause?.code || e.message})`}`);
  }
  return { status: r.status, ok: r.ok, body: await r.json().catch(() => null) };
}

// Last good manifest per backend id+url: refetched after 30 s, kept on failure so an offline
// backend's ops stay listed as 'offline' instead of vanishing from the catalogue.
const MANIFESTS = new Map();
async function manifestOf(b) {
  const key = `${b.id} ${b.url}`, hit = MANIFESTS.get(key);
  if (hit && Date.now() - hit.at < MANIFEST_TTL_MS) return hit.manifest;
  try {
    const r = await backendFetch(b, '/manifest');
    if (!r.ok || !r.body || !Array.isArray(r.body.operations)) throw new Error(`GET /manifest → ${r.status}${r.ok ? ' (no operations array)' : ''}`);
    MANIFESTS.set(key, { at: Date.now(), manifest: r.body });
    return r.body;
  } catch (e) {
    if (hit) return hit.manifest;
    throw e;
  }
}

// { backend, manifest|null, online, version, error } — disabled backends are never contacted.
async function probe(b) {
  if (!b.enabled) return { backend: b, manifest: null, online: false, version: null, error: 'disabled' };
  const [m, h] = await Promise.allSettled([manifestOf(b), backendFetch(b, '/health')]);
  const manifest = m.status === 'fulfilled' ? m.value : null;
  const health = h.status === 'fulfilled' ? h.value : null;
  const online = !!(health?.ok && health.body?.ok !== false && manifest);
  const error = online ? null
    : h.status === 'rejected' ? `engine offline: ${h.reason.message}`
    : !health.ok ? `engine offline: GET /health → ${health.status}`
    : health.body?.ok === false ? 'engine offline: health reports not ok'
    : `manifest unavailable: ${m.reason.message}`;
  return { backend: b, manifest, online, version: health?.body?.version || manifest?.version || null, error };
}

// ── GPU gate ──────────────────────────────────────────────────────────────────────────────
const gpuNeedMb = (manifest, op) => Number((op.gpu ?? manifest.runtime?.gpu)?.need_mb) || 0;

// TODO(GPU traffic cop, the design notes): once harbor's lease API is live, ask it for a
// lease of `needMb` here (initiator + room from origin, like krea-sidecar's gpu-cop/2 client) and
// return 'ready' when granted. Until then every GPU op waits (contract §5). The core NEVER starts
// a GPU host service.
function gpuAvailability(needMb) {
  return needMb > 0 ? 'waiting-gpu' : 'ready';
}

// ── JSON Schema profile v1 the design notes §4) ───────────────────────────────────────────
const SCALARS = ['string', 'integer', 'number', 'boolean'];
const SCALAR_KEYS = ['type', 'title', 'description', 'default', 'enum', 'minimum', 'maximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'format', 'optionsFrom'];
const ROOT_KEYS = ['type', 'properties', 'required', 'title', 'description', 'additionalProperties', '$schema', 'ui'];

// Why a params schema falls outside profile v1 (null = renderable). Unrenderable ops stay listed
// and runnable, flagged params_unrenderable (the form falls back to a raw JSON editor).
export function profileProblem(schema) {
  if (schema === undefined || schema === null) return null;                       // no params
  if (typeof schema !== 'object' || schema.type !== 'object') return "root must be {type:'object'}";
  const extra = Object.keys(schema).find(k => !ROOT_KEYS.includes(k));
  if (extra) return `root keyword '${extra}' is outside profile v1`;
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) return 'additionalProperties may only be false';
  const props = schema.properties ?? {};
  if (typeof props !== 'object' || Array.isArray(props)) return 'properties must be an object';
  if (schema.required !== undefined && !(Array.isArray(schema.required) && schema.required.every(k => k in props))) return 'required must list declared properties';
  for (const [k, s] of Object.entries(props)) {
    const why = s?.type === 'array' ? arrayProblem(s) : scalarProblem(s);
    if (why) return `${k}: ${why}`;
  }
  return null;
}

function arrayProblem(s) {
  const extra = Object.keys(s).find(k => !['type', 'title', 'description', 'default', 'items', 'maxItems', 'optionsFrom'].includes(k));
  if (extra) return `keyword '${extra}' is outside profile v1`;
  if (!Number.isInteger(s.maxItems) || s.maxItems < 0) return 'arrays need an integer maxItems';
  if (!s.items || typeof s.items !== 'object') return 'arrays need items';
  const why = scalarProblem(s.items);
  return why && `items: ${why}`;
}

function scalarProblem(s) {
  if (!s || typeof s !== 'object' || !SCALARS.includes(s.type)) return `type must be one of ${SCALARS.join(', ')}, array`;
  const extra = Object.keys(s).find(k => !SCALAR_KEYS.includes(k));
  if (extra) return `keyword '${extra}' is outside profile v1`;
  if (s.format !== undefined && (s.type !== 'string' || !['multiline', 'uri'].includes(s.format))) return 'format may only be multiline|uri on a string';
  if (s.enum !== undefined && !(Array.isArray(s.enum) && s.enum.length && s.enum.every(v => SCALARS.includes(typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v)))) return 'enum must be a non-empty array of scalars';
  for (const k of ['minimum', 'maximum', 'multipleOf']) if (s[k] !== undefined && typeof s[k] !== 'number') return `${k} must be a number`;
  for (const k of ['minLength', 'maxLength']) if (s[k] !== undefined && !(Number.isInteger(s[k]) && s[k] >= 0)) return `${k} must be a non-negative integer`;
  if (s.pattern !== undefined) { try { new RegExp(s.pattern, 'u'); } catch { return 'pattern is not a valid regular expression'; } }
  if (s.optionsFrom !== undefined && typeof s.optionsFrom !== 'string') return 'optionsFrom must be a string';
  return null;
}

// ── Param validation (strict: unknown keys rejected, defaults applied) ──────────────────────
// Checks every profile-v1 keyword it finds. Keywords outside the profile (an unrenderable schema)
// are left for the backend to enforce; optionsFrom values can't be checked here (dynamic enum).
function checkScalar(name, s, v) {
  const t = s.type;
  if (t === 'string' && typeof v !== 'string') throw bad(`param '${name}' must be a string`);
  if (t === 'integer' && !Number.isInteger(v)) throw bad(`param '${name}' must be an integer`);
  if (t === 'number' && !(typeof v === 'number' && Number.isFinite(v))) throw bad(`param '${name}' must be a number`);
  if (t === 'boolean' && typeof v !== 'boolean') throw bad(`param '${name}' must be true or false`);
  if (Array.isArray(s.enum) && !s.enum.includes(v)) throw bad(`param '${name}' must be one of ${s.enum.map(e => JSON.stringify(e)).join(', ')}`);
  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && v < s.minimum) throw bad(`param '${name}' must be ≥ ${s.minimum} (got ${v})`);
    if (typeof s.maximum === 'number' && v > s.maximum) throw bad(`param '${name}' must be ≤ ${s.maximum} (got ${v})`);
    if (typeof s.multipleOf === 'number' && s.multipleOf > 0 && Math.abs(v / s.multipleOf - Math.round(v / s.multipleOf)) > 1e-9) throw bad(`param '${name}' must be a multiple of ${s.multipleOf}`);
  }
  if (typeof v === 'string') {
    const len = [...v].length;
    if (Number.isInteger(s.minLength) && len < s.minLength) throw bad(`param '${name}' must be at least ${s.minLength} characters`);
    if (Number.isInteger(s.maxLength) && len > s.maxLength) throw bad(`param '${name}' must be at most ${s.maxLength} characters`);
    let re = null;
    try { if (typeof s.pattern === 'string') re = new RegExp(s.pattern, 'u'); } catch { /* flagged by profileProblem; the backend enforces it */ }
    if (re && !re.test(v)) throw bad(`param '${name}' must match /${s.pattern}/`);
    if (s.format === 'uri') { try { new URL(v); } catch { throw bad(`param '${name}' must be a URI`); } }
  }
  return v;
}

export function validateParams(schema, input) {
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) throw bad('params must be an object');
  const props = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const given = input || {};
  for (const k of Object.keys(given)) {
    if (!Object.hasOwn(props, k)) throw bad(`unknown param '${k}' — allowed: ${Object.keys(props).join(', ') || '(none)'}`);
  }
  const out = {};
  for (const [k, s] of Object.entries(props)) {
    const v = given[k];
    if (v === undefined || v === null) {
      if (required.includes(k)) throw bad(`param '${k}' is required`);
      if (s?.default !== undefined) out[k] = s.default;
      continue;
    }
    if (s?.type === 'array') {
      if (!Array.isArray(v)) throw bad(`param '${k}' must be an array`);
      if (Number.isInteger(s.maxItems) && v.length > s.maxItems) throw bad(`param '${k}' takes at most ${s.maxItems} items`);
      out[k] = s.items ? v.map((x, i) => checkScalar(`${k}[${i}]`, s.items, x)) : v;
    } else out[k] = s && typeof s === 'object' ? checkScalar(k, s, v) : v;
  }
  return out;
}

// ── Inputs: named Library assets, arity respected, category checked in the Library ────────────
function arityOf(decl) {
  const m = String(decl.arity ?? '1').match(/^(\d+)(?:\.\.(\d+|n))?$/);
  if (!m) return [1, 1];
  return [Number(m[1]), m[2] === undefined ? Number(m[1]) : m[2] === 'n' ? Infinity : Number(m[2])];
}

async function libraryAsset(id, deadline) {
  let r;
  try { r = await fetch(`${LIBRARY}/api/assets/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(Math.max(1, Math.min(PROBE_MS, deadline - Date.now()))) }); }
  catch (e) { throw new HttpError(502, `library unreachable: ${e.cause?.code || e.message}`); }
  if (r.status === 404) return null;
  if (!r.ok) throw new HttpError(502, `library GET asset → ${r.status}`);
  return r.json();
}

async function validateInputs(op, input, deadline) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('inputs must be an object {name: libraryId | [ids]}');
  const decls = new Map((op.inputs || []).map(d => [d.name ?? d.category, d]));
  for (const k of Object.keys(input)) {
    if (!decls.has(k)) throw bad(`unknown input '${k}' — ${op.id} takes: ${[...decls.keys()].join(', ') || '(none)'}`);
  }
  const out = {}, checks = [];
  for (const [name, d] of decls) {
    const v = input[name];
    if (v === undefined || v === null) {
      if (d.required !== false) throw bad(`input '${name}' is required`);
      continue;
    }
    if (d.kind !== 'asset') {                  // text/url inputs ride along as strings
      if (typeof v !== 'string' || v.length > 10_000) throw bad(`input '${name}' must be a string (≤ 10000 chars)`);
      out[name] = v;
      continue;
    }
    const ids = Array.isArray(v) ? v : [v];
    const [min, max] = arityOf(d);
    if (ids.length < Math.max(min, 1) || ids.length > max) throw bad(`input '${name}' takes ${min === max ? min : `${min}..${max === Infinity ? 'n' : max}`} asset id(s), got ${ids.length}`);
    for (const id of ids) {
      if (typeof id !== 'string' || !id || id.length > 200) throw bad(`input '${name}' must be Library asset id string(s)`);
      checks.push(libraryAsset(id, deadline).then(row => {
        if (!row) throw bad(`input '${name}': asset ${id} is not in the Library`);
        if (d.category && row.category !== d.category) throw bad(`input '${name}': asset ${id} is ${row.category || 'uncategorised'}, needs ${d.category}`);
      }));
    }
    out[name] = max === 1 ? ids[0] : ids;
  }
  await Promise.all(checks);
  return out;
}

// Same origin shape image-gen / image-ops record (the Library UI reads meta.origin).
const ORIGIN_KEYS = ['app', 'room_id', 'room_name', 'agent', 'seat_id'];
function cleanOrigin(o) {
  if (!o || typeof o !== 'object' || !o.room_id) return null;
  const out = { kind: 'room' };
  for (const k of ORIGIN_KEYS) if (typeof o[k] === 'string' && o[k].trim()) out[k] = o[k].trim().slice(0, 200);
  return out.room_id ? out : null;
}

// ── Catalogue ─────────────────────────────────────────────────────────────────────────────
function flatten({ backend, manifest, online }) {
  return (manifest?.operations || []).filter(op => op && typeof op.id === 'string').map(op => {
    const need = gpuNeedMb(manifest, op);
    const problem = profileProblem(op.params);
    return {
      provider: backend.id, op: op.op, id: op.id, label: op.label || op.id,
      inputs: op.inputs || [], outputs: op.outputs || [], params: op.params ?? null, est: op.est ?? null,
      gpu_need_mb: need, license: op.license ?? manifest.license ?? null,
      availability: online ? gpuAvailability(need) : 'offline',
      ...(problem && { params_unrenderable: true, params_problem: problem }),
    };
  });
}

// ── Job log (the core's own record of what it started; JSONL, append-only) ───────────────────
async function logJob(entry) {
  try {
    await mkdir(STATE, { recursive: true });
    await appendFile(JOB_LOG, JSON.stringify(entry) + '\n');
  } catch (e) { console.error(`[model-studio] job log append failed (job ${entry.jobId} still started):`, e.message); }
}

async function readJobLog() {
  let text;
  try { text = await readFile(JOB_LOG, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return text.split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
}

function splitJobId(jobId) {
  const i = jobId.indexOf(':');
  if (i < 1 || i === jobId.length - 1) throw bad(`job id must be '<provider>:<backend job id>' (got '${jobId}')`);
  return [jobId.slice(0, i), jobId.slice(i + 1)];
}

// ── Routes ────────────────────────────────────────────────────────────────────────────────
export async function register(app) {
  app.use(BASE, (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  const route = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) {
      if (!e.status) console.error(`[model-studio] ${req.method} ${req.path}:`, e);
      res.status(e.status || 500).json({ ok: false, error: e.message, ...e.extra });
    }
  };

  app.get(`${BASE}/api/backends`, route(async (req, res) => {
    const probes = await Promise.all((await loadConfig()).map(probe));
    res.json({ ok: true, backends: probes.map(p => ({ id: p.backend.id, url: p.backend.url, enabled: p.backend.enabled,
      online: p.online, version: p.version, error: p.error })) });
  }));

  // ?category= filters by the category of an operation's asset INPUTS (mesh → mesh ops,
  // image → Import: image-to-mesh). Ops of disabled backends are not listed.
  app.get(`${BASE}/api/ops`, route(async (req, res) => {
    const cat = typeof req.query.category === 'string' ? req.query.category : null;
    const probes = await Promise.all((await loadConfig()).filter(b => b.enabled).map(probe));
    let ops = probes.flatMap(flatten);
    if (cat) ops = ops.filter(o => o.inputs.some(i => i.kind === 'asset' && i.category === cat));
    res.json({ ok: true, ops });
  }));

  // POST /api/run { provider, id, inputs:{name: libraryId|[ids]}, params?, origin? } → 202 { jobId }
  app.post(`${BASE}/api/run`, express.json({ limit: '256kb' }), route(async (req, res) => {
    const deadline = Date.now() + RUN_BUDGET_MS;
    const { provider, id, inputs, params, origin, ...rest } = req.body || {};
    const extra = Object.keys(rest)[0];
    if (extra) throw bad(`unknown field '${extra}' — run takes provider, id, inputs, params, origin`);
    if (typeof provider !== 'string' || typeof id !== 'string') throw bad('provider and id (strings) are required');
    const p = await probe(await getBackend(provider));
    if (!p.online) throw bad(`provider '${provider}' is offline (${p.error}) — start it in harbor; the core never starts it`);
    const op = p.manifest.operations.find(o => o?.id === id);
    if (!op) throw bad(`provider '${provider}' has no operation '${id}' — see GET ${BASE}/api/ops`);
    const cleanParams = validateParams(op.params, params);
    const cleanInputs = await validateInputs(op, inputs, deadline);
    const need = gpuNeedMb(p.manifest, op);
    if (gpuAvailability(need) !== 'ready') {
      throw new HttpError(409, `'${id}' needs ${need} MB of GPU — waiting on GPU scheduling (the traffic cop's lease API is not live yet)`, { availability: 'waiting-gpu' });
    }
    const o = cleanOrigin(origin);
    const timeout = Math.min(FORWARD_MS, deadline - Date.now());
    if (timeout < 500) throw new HttpError(504, 'ran out of time before forwarding the job (provider or Library slow)');
    const r = await backendFetch(p.backend, '/run', { method: 'POST', timeout,
      body: { id, inputs: cleanInputs, params: cleanParams, ...(o && { origin: o }) } });
    if (!r.ok || typeof r.body?.jobId !== 'string') {
      const why = r.body?.error || (r.ok ? 'no jobId in reply' : `POST /run → ${r.status}`);
      throw new HttpError(r.status >= 400 && r.status < 500 ? r.status : 502, `provider '${provider}' refused the job: ${why}`);
    }
    const jobId = `${provider}:${r.body.jobId}`;
    await logJob({ jobId, provider, id, inputs: cleanInputs, params: cleanParams, origin: o, at: new Date().toISOString() });
    res.status(202).json({ ok: true, jobId });
  }));

  // The core's own log, newest first, each entry with the backend's live state (best-effort).
  app.get(`${BASE}/api/jobs`, route(async (req, res) => {
    const provider = typeof req.query.provider === 'string' && req.query.provider ? req.query.provider : null;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 200);
    const entries = (await readJobLog()).filter(e => !provider || e.provider === provider).reverse().slice(0, limit);
    const backends = new Map((await loadConfig()).map(b => [b.id, b]));
    const jobs = await Promise.all(entries.map(async e => {
      const b = backends.get(e.provider);
      if (!b?.enabled) return { ...e, live: null, live_error: b ? 'provider disabled' : 'provider no longer configured' };
      try {
        const r = await backendFetch(b, `/jobs/${encodeURIComponent(splitJobId(e.jobId)[1])}`);
        return r.ok ? { ...e, live: r.body } : { ...e, live: null, live_error: r.body?.error || `GET /jobs → ${r.status}` };
      } catch (err) { return { ...e, live: null, live_error: err.message }; }
    }));
    res.json({ ok: true, jobs });
  }));

  const proxyJob = (suffix, method) => route(async (req, res) => {
    const [provider, backendId] = splitJobId(req.params.jobId);
    const r = await backendFetch(await getBackend(provider), `/jobs/${encodeURIComponent(backendId)}${suffix}`, { method, timeout: FORWARD_MS });
    if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 502, r.status === 404 ? `unknown job ${req.params.jobId}` : `provider '${provider}': ${r.body?.error || `${method} /jobs → ${r.status}`}`);
    res.json({ ok: true, job: { ...r.body, jobId: req.params.jobId } });
  });
  app.get(`${BASE}/api/jobs/:jobId`, proxyJob('', 'GET'));
  app.post(`${BASE}/api/jobs/:jobId/cancel`, proxyJob('/cancel', 'POST'));
}
