/*
 * Asset Studio's MODEL domain (from Model Studio): one room's 3D jobs, its asset set and its budget,
 * and the verbs that change them (reviews: app/reviews.mjs). The orchestration is the Model Studio CORE (the
 * asset-platform gateway tool, the design notes): it holds the backend registry, validates
 * params against each backend's schema, gates GPU ops and relays jobs. This is the thin,
 * room-scoped adapter over its HTTP API — the core has no notion of a room (addendum 2 §2), so
 * ALL room scoping lives here:
 *
 *   - the room's ASSET SET = Library ids this room imported (`import`) + every output of this
 *     room's finished jobs. `run.inputs` takes only ids in the set; review items too.
 *   - job_status / cancel / history see only this room's jobs; review numbers are per room.
 *   - access: exclusive — every verb acts on the ONE bound room (config.mjs BINDING).
 *
 * Budget (addendum 2 §4): counted PER JOB, plus an optional time cap, enforced HERE in run, so
 * every caller inherits it. Setting it is a `control` verb (the user's). A job that ends
 * (error / cancelled / lost) without producing anything is refunded, as in Image Studio.
 *
 * GPU: the core answers 409 `waiting-gpu` for a GPU op until the traffic cop's lease API is
 * live; run passes that through (nothing debited). Nothing here ever starts a GPU host service.
 *
 * The panel serves meshes through the frame proxy (a GLB ≤ 96 MiB, anything else ≤ 20 MiB; 10 s of silence): each mesh
 * asset records what the panel may show — its meshopt child (the Blender backend publishes one), else
 * itself when it is a GLB ≤ 96 MiB, else only its thumbnail + "Open in Library".
 *
 * State persists to work/state.json. Zero dependencies (node >= 20).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readBinding, readConfig, readEngine, WORK_DIR } from './config.mjs';

import { AppError, postLine, familyKey } from './shared.mjs';

export { AppError };

const STATE_FILE = path.join(WORK_DIR, 'models.json');
const ROOM_ID = /^[0-9a-f][0-9a-f-]{7,63}$/i;
const ASSET_ID = /^[A-Za-z0-9_-]{1,80}$/;
export const PROXY_MAX = 20 * 1024 * 1024;   // briefing-table's panel proxy cuts a body over 20 MiB (20,971,520 bytes) — every panel body but a GLB
/* A GLB the viewer loads may be larger: 96 MiB = 100,663,296 bytes, matched by briefing-table's PROXY_GLB_MAX (model/gltf-binary
   bodies only). Anything else, and every image/thumbnail, stays at PROXY_MAX. */
export const GLB_MAX = 96 * 1024 * 1024;
const RUN_TIMEOUT_MS = 9500;                 // run answers within 10 s (addendum 1 §6)
const MAX_INPUT_IDS = 16;
export const TERMINAL = ['done', 'error', 'cancelled', 'lost'];

/* ------------------------------------------------------------------ core -- */

async function core(p, { method = 'GET', body, timeout = 8000 } = {}) {
  const base = readConfig().coreUrl;
  let r;
  try {
    r = await fetch(base + p, {
      method,
      signal: AbortSignal.timeout(timeout),
      ...(body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch (e) {
    const slow = e.name === 'TimeoutError';
    throw new AppError(slow ? 504 : 503, slow ? `the 3D core did not answer within ${timeout / 1000} s` : `the 3D core is unreachable (${e.cause?.code || e.name})`, { reason: slow ? 'core-slow' : 'core-down' });
  }
  const json = await r.json().catch(() => null);
  if (!r.ok) {
    const extra = json?.availability === 'waiting-gpu' ? { reason: 'waiting-gpu', availability: 'waiting-gpu' } : {};
    throw new AppError(r.status >= 500 ? 502 : r.status, json?.error || `core ${p} → HTTP ${r.status}`, extra);
  }
  return json;
}

/* {ok, state, online, total}: the core answers and at least one backend is online. */
export async function coreHealth() {
  try {
    const { backends = [] } = await core('/backends', { timeout: 6000 });
    const online = backends.filter((b) => b.online).length;
    return { ok: online > 0, state: online ? 'ready' : backends.length ? 'backends-offline' : 'no-backends', online, total: backends.length };
  } catch (e) {
    return { ok: false, state: e.extra?.reason || 'unknown', online: 0, total: 0 };
  }
}

let opLabels = {};   // "<provider>/<id>" -> label, filled by any list_ops call (for the panel)
export async function listOps(category) {
  if (category !== undefined && category !== null && category !== '' && !/^[a-z0-9_-]{1,40}$/.test(category)) throw new AppError(400, 'bad category');
  const { ops } = await core(`/ops${category ? `?category=${encodeURIComponent(category)}` : ''}`);
  for (const o of ops) opLabels[`${o.provider}/${o.id}`] = o.label;
  return ops;
}

/* --------------------------------------------------------------- Library -- */

const libUrl = (id, what) => `${readConfig().libraryUrl}/assets/${encodeURIComponent(id)}${what ? `/${what}` : ''}`;

async function libJson(url) {
  let r;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch (e) {
    throw new AppError(503, `Library unreachable (${e.cause?.code || e.name})`);
  }
  if (r.status === 404) return null;
  if (!r.ok) throw new AppError(502, `Library → HTTP ${r.status}`);
  return r.json();
}

const isMeshopt = (a) => a && String(a.format).toLowerCase() === 'glb' && /meshopt/i.test(`${a.label ?? ''} ${a.filename ?? ''}`);

/* What the room knows about one Library asset, including what the panel may show of it:
   view 'image' (a picture), 'glb' (the 3D viewer, from `serve` — the meshopt child or itself),
   'thumb' (too big / not a GLB: thumbnail + "Open in Library"). null = not in the Library. */
async function describe(id) {
  const a = await libJson(libUrl(id));
  if (!a) return null;
  const out = { id, label: a.label || a.filename || id, category: a.category ?? null, format: a.format ?? null, bytes: a.bytes ?? null, view: 'thumb', serve: null };
  if (a.category === 'image') {
    out.view = 'image';
    out.serve = id;
  } else if (a.category === 'mesh') {
    const kids = isMeshopt(a) ? null : await libJson(`${readConfig().libraryUrl}/assets?parent_id=${encodeURIComponent(id)}&category=mesh&limit=50`);
    const opt = (kids?.assets || []).filter((k) => isMeshopt(k) && (k.bytes ?? 0) <= GLB_MAX).sort((x, y) => (x.bytes ?? 0) - (y.bytes ?? 0))[0];
    if (opt) Object.assign(out, { view: 'glb', serve: opt.id, serve_bytes: opt.bytes ?? null });
    else if (String(a.format).toLowerCase() === 'glb' && (a.bytes ?? Infinity) <= GLB_MAX) Object.assign(out, { view: 'glb', serve: id, serve_bytes: a.bytes });
  }
  out.described = true;
  return out;
}

/* ----------------------------------------------------------------- state -- */

let store = null;
function load() {
  if (!store) {
    try {
      store = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
      store = { rooms: {} };
    }
  }
  return store;
}
function save() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1));
  fs.renameSync(tmp, STATE_FILE);
}

const fresh = () => ({
  budget: { max_jobs: readConfig().defaultModelBudget, used: 0, since: new Date().toISOString(), until: null },
  assets: [],    // the room's set, oldest first: {id, via: import|output, job_id?, at, label, category, format, bytes, view, serve}
  jobs: [],      // newest first
});

/* Jobs still running in ANY room (a rebind lets them finish where they started). */
export function runningJobs() {
  return Object.entries(load().rooms).flatMap(([room_id, r]) =>
    r.jobs.filter((j) => !TERMINAL.includes(j.state)).map((j) => ({ room_id, job_id: j.job_id })));
}

/* The bound room's state; refuses any other room. */
export function room(roomId) {
  if (typeof roomId !== 'string' || !ROOM_ID.test(roomId)) throw new AppError(400, 'bad room id');
  const b = readBinding();
  if (!b) throw new AppError(409, 'Asset Studio is not bound to a room — the resident runs scripts/bind.sh <room>', { reason: 'unbound' });
  roomId = familyKey(roomId); // a workgroup works on its family's state (the root's)
  if (b.room_id !== roomId) {
    throw new AppError(409, `Asset Studio is working in another room family ("${b.room_name || b.room_id.slice(0, 8)}") — one family at a time`, { reason: 'other-room' });
  }
  const s = load();
  s.rooms[roomId] ??= fresh();
  return s.rooms[roomId];
}

const assetOf = (r, id) => r.assets.find((a) => a.id === id) ?? null;
const slim = (a) => a && { id: a.id, label: a.label, category: a.category, format: a.format, view: a.view, via: a.via, job_id: a.job_id ?? null };
const budgetOut = (r) => ({ ...r.budget, left: Math.max(0, r.budget.max_jobs - r.budget.used) });

/* The newest finished job's main output: the first GLB-viewable output that is not the meshopt
   copy of another output (that copy is what the panel serves FOR it), else the first output. */
function latestOutput(r) {
  const j = r.jobs.find((x) => x.state === 'done' && x.outputs.length);
  if (!j) return null;
  const outs = j.outputs.map((id) => assetOf(r, id)).filter(Boolean);
  const served = new Set(outs.filter((a) => a.serve && a.serve !== a.id).map((a) => a.serve));
  const main = outs.find((a) => a.view === 'glb' && !served.has(a.id)) ?? outs[0] ?? null;
  return main && { job_id: j.job_id, label: j.label, at: j.ended_at ?? j.at, asset: slim(main) };
}

export function view(r) {
  return {
    budget: budgetOut(r),
    assets: r.assets.map(slim),
    running: r.jobs.filter((j) => !TERMINAL.includes(j.state)).map((j) => j.job_id),
    latest: latestOutput(r),
  };
}

/* ------------------------------------------------------------------ verbs -- */

/* Who a room line is FOR (briefing-table tool-residents §2.8): "user" = the user asked for it
   directly; a handle = the agent that asked. Default: the bound agent. */
const HANDLE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
function initiator(b, dflt) {
  const f = b.for === undefined ? dflt ?? readBinding()?.agent ?? 'user' : b.for;
  if (typeof f !== 'string' || !(f === 'user' || (f.length <= 64 && HANDLE.test(f)))) throw new AppError(400, 'for must be "user" or an agent handle');
  return f;
}
const str = (v, max, name) => {
  if (typeof v !== 'string') throw new AppError(400, `${name} must be a string`);
  if (v.length > max) throw new AppError(400, `${name} is over ${max} characters`);
  return v;
};
const num = (v, lo, hi, name, int = false) => {
  const n = Number(v);
  if (typeof v === 'boolean' || v === null || !Number.isFinite(n) || n < lo || n > hi || (int && !Number.isInteger(n))) throw new AppError(400, `${name} must be ${int ? 'an integer' : 'a number'} ${lo}–${hi}`);
  return n;
};
const onlyKeys = (b, keys, verb) => {
  const extra = Object.keys(b).find((k) => !keys.includes(k));
  if (extra) throw new AppError(400, `unknown field '${extra}' — ${verb} takes ${keys.join(', ')}`);
};

/* import {asset_id, for?} — a Library asset joins this room's set (announced). Idempotent. */
export async function importAsset(r, roomId, b) {
  onlyKeys(b, ['asset_id', 'for'], 'import');
  const id = str(b.asset_id, 80, 'asset_id');
  if (!ASSET_ID.test(id)) throw new AppError(400, 'bad asset_id');
  const forWho = initiator(b);
  const had = assetOf(r, id);
  if (had) return { asset: slim(had), already: true };
  const d = await describe(id);
  if (!d) throw new AppError(404, `Library asset ${id} not found`);
  const a = { ...d, via: 'import', at: new Date().toISOString() };
  r.assets.push(a);
  save();
  await postLine(roomId, `Asset Studio: imported "${a.label}" (${a.category ?? 'asset'}, ${id}) into this room.`, forWho).catch(() => {});
  return { asset: slim(a) };
}

/* run {provider, id, inputs, params?, for?} → 202 {job, budget}. Answers within 10 s; the app
   follows the job itself (track). The budget slot is taken BEFORE the core is called (two
   concurrent runs can't both pass the last slot) and given back if the core refuses. */
export async function run(r, roomId, b) {
  onlyKeys(b, ['provider', 'id', 'inputs', 'params', 'for'], 'run');
  const provider = str(b.provider, 64, 'provider');
  const opId = str(b.id, 128, 'id');
  if (!b.inputs || typeof b.inputs !== 'object' || Array.isArray(b.inputs)) throw new AppError(400, 'inputs must be an object {name: asset id | [ids]}');
  for (const [name, v] of Object.entries(b.inputs)) {
    const ids = Array.isArray(v) ? v : [v];
    if (!ids.length || ids.length > MAX_INPUT_IDS) throw new AppError(400, `input '${name}' takes 1–${MAX_INPUT_IDS} asset ids`);
    for (const id of ids) {
      if (typeof id !== 'string' || !ASSET_ID.test(id)) throw new AppError(400, `input '${name}': bad asset id ${JSON.stringify(id)}`);
      if (!assetOf(r, id)) throw new AppError(400, `input '${name}': asset ${id} is not in this room's set — import it first`, { reason: 'not-in-room' });
    }
  }
  if (b.params !== undefined && (b.params === null || typeof b.params !== 'object' || Array.isArray(b.params))) throw new AppError(400, 'params must be an object');
  const forWho = initiator(b);
  if (r.budget.until && Date.now() > Date.parse(r.budget.until)) {
    throw new AppError(429, `budget time is up (${r.budget.until}) — ask the user for more time`, { reason: 'budget-time', budget: budgetOut(r) });
  }
  if (r.budget.used >= r.budget.max_jobs) {
    throw new AppError(429, `budget spent: ${r.budget.used} of ${r.budget.max_jobs} jobs used — ask the user to raise it`, { reason: 'budget', budget: budgetOut(r) });
  }
  const since = r.budget.since;
  r.budget.used += 1;
  save();
  const bind = readBinding();
  let out;
  try {
    out = await core('/run', {
      method: 'POST', timeout: RUN_TIMEOUT_MS,
      body: {
        provider, id: opId, inputs: b.inputs, ...(b.params !== undefined && { params: b.params }),
        origin: { app: 'asset-studio', room_id: roomId, room_name: bind.room_name, agent: bind.agent, seat_id: bind.seat_id },
      },
    });
  } catch (e) {
    if (r.budget.since === since) r.budget.used = Math.max(0, r.budget.used - 1);
    save();
    throw e;
  }
  const job = {
    job_id: out.jobId, provider, id: opId, label: opLabels[`${provider}/${opId}`] || opId, inputs: b.inputs, params: b.params ?? {},
    at: new Date().toISOString(), state: 'queued', phase: null, pct: null, error: null, outputs: [], for: forWho,
  };
  r.jobs.unshift(job);
  save();
  return { job, budget: budgetOut(r) };
}

function findJob(r, jobId) {
  const j = r.jobs.find((x) => x.job_id === jobId);
  if (!j) throw new AppError(404, `job ${jobId} is not one of this room's`);
  return j;
}
export const jobStatus = (r, jobId) => findJob(r, jobId);
export const history = (r) => r.jobs;

export async function cancel(r, jobId) {
  const j = findJob(r, jobId);
  if (TERMINAL.includes(j.state)) return j;
  const out = await core(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
  if (out.job?.state === 'cancelled') {
    Object.assign(j, { state: 'cancelled', ended_at: new Date().toISOString() });
    refund(r, j);
    save();
  }
  return j;
}

/* control — the user's budget, not the agent's. The resident's settings put this verb behind a
   human approval (.claude/settings.json `ask`), and every change is announced in the room.
   Raising the max keeps the count; only `reset: true` zeroes it. `minutes` sets a deadline from
   now, `minutes: null` clears it, omitted keeps it. */
/* release_gpu (the same verb as Image Studio, so agents learn one). Model Studio's
   backends hold NO GPU between jobs — a Mesh job is a child process that exits, Blender is CPU — so
   there is nothing to unload; while one of this room's jobs runs, the answer is busy. */
export function releaseGpu(r) {
  const live = (r.jobs || []).filter((j) => !TERMINAL.includes(j.state));
  if (live.length) return { released: false, busy: true, reason: `${live.length} job(s) running — the GPU is in use by design` };
  return { released: false, held_mib: 0, note: 'nothing to release: the model jobs hold no GPU between jobs' };
}

export async function setBudget(r, roomId, b) {
  onlyKeys(b, ['max_jobs', 'minutes', 'reset', 'for'], 'set_budget');
  const max = num(b.max_jobs, 1, 1000, 'max_jobs', true);
  if (b.reset !== undefined && typeof b.reset !== 'boolean') throw new AppError(400, 'reset must be true or false');
  const forWho = initiator(b, 'user');
  const until = b.minutes === undefined ? r.budget.until ?? null
    : b.minutes === null ? null : new Date(Date.now() + num(b.minutes, 1, 24 * 60, 'minutes', true) * 60000).toISOString();
  r.budget = b.reset ? { max_jobs: max, used: 0, since: new Date().toISOString(), until } : { ...r.budget, max_jobs: max, until };
  save();
  const t = until ? `, until ${new Date(until).toISOString().slice(11, 16)} UTC` : '';
  await postLine(roomId, `Asset Studio model budget set to ${max} jobs${t}${b.reset ? ' (count reset)' : ''} — ${r.budget.used} used so far.`, forWho).catch(() => {});
  return budgetOut(r);
}

/* A job that ended without producing anything gives its slot back — unless the budget was
   reset since it started. */
function refund(r, j) {
  if (!j.outputs.length && !j.refunded && j.at >= r.budget.since) {
    r.budget.used = Math.max(0, r.budget.used - 1);
    j.refunded = true;
  }
}

/* ---------------------------------------------------------------- tracker -- */

/* Follow every open job of every room to a terminal state, whether or not anyone polls
   job_status: outputs must join the room's set even if the agent walks away. */
export async function track() {
  const s = load();
  let changed = false;
  for (const [roomId, r] of Object.entries(s.rooms)) {
    for (const j of r.jobs.filter((x) => !TERMINAL.includes(x.state))) {
      let live;
      try {
        live = (await core(`/jobs/${encodeURIComponent(j.job_id)}`, { timeout: 4000 })).job;
      } catch (e) {
        if (e.status === 404) {
          Object.assign(j, { state: 'lost', error: 'the core lost this job (backend restart?) — run it again', ended_at: new Date().toISOString() });
          refund(r, j);
          j.announce = true;
          changed = true;
        }
        continue;   // core/backend hiccup: try again next tick
      }
      const next = { state: live.state || j.state, phase: live.phase ?? null, pct: Number.isFinite(live.pct) ? live.pct : null, error: live.error ?? null };
      if (JSON.stringify(next) !== JSON.stringify({ state: j.state, phase: j.phase, pct: j.pct, error: j.error })) {
        Object.assign(j, next);
        changed = true;
      }
      if (!TERMINAL.includes(j.state)) continue;
      j.ended_at = new Date().toISOString();
      if (j.state === 'done') {
        const ids = (live.result?.assetIds || []).filter((id) => typeof id === 'string' && ASSET_ID.test(id));
        j.outputs = ids;
        for (const id of ids) {
          if (assetOf(r, id)) continue;
          const d = await describe(id).catch(() => null);
          r.assets.push({ ...(d ?? { id, label: id, category: null, format: null, bytes: null, view: 'thumb', serve: null, described: false }), via: 'output', job_id: j.job_id, at: j.ended_at });
        }
      }
      refund(r, j);
      if (j.state !== 'cancelled') j.announce = true;
    }
    // outputs the Library could not describe on the first try (a hiccup): a few more tries
    for (const a of r.assets.filter((x) => x.described === false && (x.tries ?? 0) < 3)) {
      a.tries = (a.tries ?? 0) + 1;
      const d = await describe(a.id).catch(() => null);
      if (d) Object.assign(a, d);
      changed = true;
    }
    // ONE line per finished job, for whoever asked for it
    for (const j of r.jobs.filter((x) => x.announce)) {
      delete j.announce;
      changed = true;
      const text = j.state === 'done'
        ? `Asset Studio: ${j.label} done — ${j.outputs.length} output${j.outputs.length === 1 ? '' : 's'}${j.outputs.length ? ` (${j.outputs.join(', ')})` : ''}, in this room's set.`
        : `Asset Studio: ${j.label} ${j.state === 'lost' ? 'was lost' : 'failed'}${j.error ? ` — ${String(j.error).slice(0, 300)}` : ''}${j.refunded ? ' (not charged)' : ''}.`;
      await postLine(roomId, text, j.for).catch(() => {});
    }
  }
  if (changed) save();
  return changed;
}

/* ----------------------------------------------------------------- panel -- */

/* What the panel shows (GET /rooms/:roomId/panel.json) — only what the tab renders.
   studio: the running job, the latest output, the job list (JOBS_MAX), the room's set (ASSETS_MAX);
   review: every item with all its versions + what each referenced asset is (the in-frame large
   view). Both carry the core state, the budget and the review list (the waiting count). */
const JOBS_MAX = 12;
const ASSETS_MAX = 24;
const slimJob = (j) => ({ job_id: j.job_id, provider: j.provider, id: j.id, label: j.label, state: j.state, phase: j.phase, pct: j.pct, error: j.error, at: j.at, outputs: j.outputs.length });
export function panelData(r, coreState, tab = 'studio') {
  if (!['studio', 'watch'].includes(tab)) tab = 'studio';
  const running = r.jobs.find((j) => !TERMINAL.includes(j.state));
  const base = { tab, core: coreState, library_web: readConfig().libraryWebUrl || null, budget: budgetOut(r), running: running ? slimJob(running) : null };
  return {
    ...base, latest: latestOutput(r),
    // the rail's line: working or idle · jobs queued · models produced (outputs of this room's jobs)
    n_queued: r.jobs.filter((j) => j.state === 'queued').length, n_outputs: r.assets.filter((x) => x.via === 'output').length,
    jobs: r.jobs.slice(0, JOBS_MAX).map(slimJob), n_jobs: r.jobs.length,
    assets: [...r.assets].reverse().slice(0, ASSETS_MAX).map(slim), n_assets: r.assets.length,
  };
}

/* The panel's bytes: only this room's assets. file = what the viewer may load (the meshopt /
   preview GLB ≤ 96 MiB, or the image ≤ 20 MiB); thumb = the Library thumbnail (mesh thumbs are JPEG). */
export async function libraryBytes(r, id, what) {
  const a = assetOf(r, id);
  if (!a) throw new AppError(404, 'not one of this room\'s assets');
  let src = id;
  if (what === 'file') {
    if (!a.serve) throw new AppError(413, 'no preview small enough for the panel — open it in the Library', { reason: 'too-large' });
    src = a.serve;
  }
  let f;
  try {
    f = await fetch(libUrl(src, what), { signal: AbortSignal.timeout(20000) });
    if (!f.ok && what === 'thumb' && a.serve && a.serve !== id) f = await fetch(libUrl(a.serve, 'thumb'), { signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new AppError(503, `Library unreachable (${e.cause?.code || e.name})`);
  }
  if (!f.ok) throw new AppError(f.status === 404 ? 404 : 502, `Library ${what} → HTTP ${f.status}`);
  const cap = a.view === 'glb' && what === 'file' ? GLB_MAX : PROXY_MAX;
  const capWord = cap === GLB_MAX ? '96 MiB' : '20 MiB';
  if (Number(f.headers.get('content-length')) > cap) throw new AppError(413, `over the panel's ${capWord}`, { reason: 'too-large' });
  const bytes = Buffer.from(await f.arrayBuffer());
  if (bytes.length > cap) throw new AppError(413, `over the panel's ${capWord}`, { reason: 'too-large' });
  const type = a.view === 'glb' && what === 'file' ? 'model/gltf-binary' : f.headers.get('content-type') || 'application/octet-stream';
  return { type, bytes };
}

/* what a room asset is (a review's mesh: format, view, serve) */
export const meshOf = (r, id) => slim(assetOf(r, id));
/* The size of what the 3D viewer would load for a model (its meshopt copy, else itself); null = not a model it opens. */
export const viewerBytes = (r, id) => { const a = assetOf(r, id); return a && a.category === 'mesh' && a.view === 'glb' ? a.serve_bytes ?? a.bytes ?? 0 : null; };
/* A mesh put up for review joins the room's set quietly (via 'review', no room line): the panel then
   serves its viewer copy like any room model. Returns what it is, or null when not in the Library. */
export async function adopt(roomId, id) {
  const r = room(roomId);
  const had = assetOf(r, id);
  if (had) return slim(had);
  const d = await describe(id);
  if (!d) return null;
  r.assets.push({ ...d, via: 'review', at: new Date().toISOString() });
  save();
  return slim(assetOf(r, id));
}
export const assetInfo = (r, id) => slim(assetOf(r, id));

/* GET /rooms/:roomId/review/:n/thumb — the latest version's first asset as a 96 px square
   (cover crop) JPEG, for briefing-table's chat link rows. */
const reviewThumbs = new Map(); // library id -> jpeg bytes
export function _reset() {
  store = null;
}
