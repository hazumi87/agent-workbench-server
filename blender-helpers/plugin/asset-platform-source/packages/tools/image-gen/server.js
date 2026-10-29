// image-gen — generate images from the library with Krea 2 (WanGP, on the GPU host GPU).
//
// Architecture (the design notes · north star the design notes · task):
//   - The GPU host sidecar `asset-platform-krea` is DUMB: it runs one WanGP task (settings dict +
//     up to 2 reference images) and serves back the output + WanGP's .meta.json task dict.
//   - This Node tool holds the smarts: model catalogue, batches, seeds, draft sizing, and
//     registering every output in the library with a COMPLETE, replayable recipe.
//   - API-first: the UI and an agent (briefing-table workrooms) call the same endpoints.
//
// Recipe = the asset's derived_op:
//   { tool:'image-gen', engine:'wangp', model_type, params:{prompt, negative_prompt, width,
//     height, num_inference_steps, guidance_scale, seed}, refs:[library asset ids],
//     batch_id, batch_index, batch_size, draft, generated_by, engine_task:{…WanGP meta} }
// "Reload parameters" reads it back (GET /api/recipe/:id). Imported images (Midjourney)
// get a best-effort recipe from their prompt (--ar → dimensions, MJ-only flags dropped).
//
// The gateway loads this into ONE process shared with every tool — a bad import here
// 404s ALL tools. The library is resolved lazily in register.
import express from 'express';
import { randomUUID } from 'crypto';
import { mkdir, rm, writeFile, readFile } from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = process.env.ASSET_PLATFORM_ROOT || (process.env.HOME || '.') + '/asset-management';
export const BASE = '/asset-management/tools/image-gen';
const SIDECAR = process.env.IMAGE_GEN_SIDECAR || 'http://127.0.0.1:8290';
// Staging on the library's own drive (shared by the gateway's `service` user and agents), so
// registering an output is a rename, not a copy.
const WORK_BASE = process.env.IMAGE_GEN_WORK || (process.env.HOME || '.') + '/asset-library-data/scratch/.image-gen';
const MAX_COUNT = 16;
const MAX_REFS = 2;          // WanGP krea2 edit models: "up to 2 reference images", order is semantic
const DIM_STEP = 16;         // width/height must be divisible by compression × patch
const POLL_MS = 1500;
// A sidecar restart (deploy, GPU-cop reservation) drops its in-memory tasks; the image is
// resubmitted with the same seed instead of failing the batch, for up to this long.
const RESTART_WAIT_MS = Number(process.env.IMAGE_GEN_RESTART_WAIT_MS || 10 * 60 * 1000);
const JOB_TTL_MS = 6 * 60 * 60 * 1000;

let addAsset, getAsset, assetAbsPath;

const JOBS = new Map();      // batch job id -> state the UI/agent polls
function setJob(id, patch) { JOBS.set(id, { ...JOBS.get(id), ...patch }); }
function reap() {
  const now = Date.now();
  for (const [id, j] of JOBS) if (j.finishedAt && now - j.finishedAt > JOB_TTL_MS) JOBS.delete(id);
}

// err.gone = the sidecar is down or has forgotten the task (restarted), as opposed to an engine error.
async function sidecar(p, opts = {}) {
  let r;
  try { r = await fetch(SIDECAR + p, { signal: AbortSignal.timeout(opts.timeout || 15000), ...opts }); }
  catch (e) { throw Object.assign(new Error(`engine unreachable: ${e.message}`), { gone: true }); }
  const body = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  if (!r.ok) throw Object.assign(new Error(body?.error || `sidecar ${p} → ${r.status}`), { gone: r.status === 404 && p.startsWith('/jobs/') });
  return body;
}

const snap = (n) => Math.max(DIM_STEP, Math.round(n / DIM_STEP) * DIM_STEP);

// Width/height for an aspect ratio at ~1 megapixel (Krea 2's native scale).
export function dimsForAspect(ratio, megapixels = 1) {
  const area = megapixels * 1024 * 1024;
  return { width: snap(Math.sqrt(area * ratio)), height: snap(Math.sqrt(area / ratio)) };
}

// Where a generation came from when an agent made it in a briefing-table room (the user,
// Library images must show they were built by an agent in a room). Only known
// keys, short strings; anything else is dropped. null = no origin (the Library UI).
const ORIGIN_KEYS = ['app', 'room_id', 'room_name', 'agent', 'seat_id'];
export function cleanOrigin(o) {
  if (!o || typeof o !== 'object' || !o.room_id) return null;
  const out = { kind: 'room' };
  for (const k of ORIGIN_KEYS) if (typeof o[k] === 'string' && o[k].trim()) out[k] = o[k].trim().slice(0, 200);
  return out.room_id ? out : null;
}

// Width/height ratio of an image asset from its recorded pixel size (indexAsset stores it for images).
function refAspect(a) {
  if (!a) return null;
  let m = a.meta; if (typeof m === 'string') { try { m = JSON.parse(m); } catch { m = null; } }
  const w = Number(m?.width), h = Number(m?.height);
  return w > 0 && h > 0 ? Math.min(4, Math.max(0.25, w / h)) : null;
}

// Midjourney prompt → a runnable recipe: prompt words kept, --ar mapped to dimensions,
// MJ-only flags (--v, --q, --s, --chaos, --tile, --style, --raw, …) dropped. --no becomes
// the negative prompt. Leading image-prompt URLs are dropped (the image can be attached
// as a reference instead).
export function recipeFromMidjourney(prompt) {
  const cut = prompt.search(/\s--\w/);
  const words = (cut >= 0 ? prompt.slice(0, cut) : prompt).replace(/^(\s*<?https?:\/\/\S+>?\s*)+/, '').trim();
  const flags = cut >= 0 ? prompt.slice(cut) : '';
  const ar = flags.match(/--(?:ar|aspect)\s+(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/);
  const no = flags.match(/--no\s+([^-][^]*?)(?=\s--\w|$)/);
  return {
    prompt: words,
    negative_prompt: no ? no[1].trim() : '',
    ...dimsForAspect(ar ? Number(ar[1]) / Number(ar[2]) : 1),
    dropped_flags: flags.trim(),
  };
}

// Poll one sidecar task to a terminal state, mirroring progress into the batch job.
async function awaitTask(jobId, taskId, index) {
  for (;;) {
    await new Promise(r => setTimeout(r, POLL_MS));
    if (JOBS.get(jobId)?.cancelRequested) {
      await sidecar(`/jobs/${taskId}/cancel`, { method: 'POST' }).catch(() => {});
      throw new Error('cancelled');
    }
    const t = await sidecar(`/jobs/${taskId}`);
    setJob(jobId, { current: { index, state: t.state, progress: t.progress || null, detail: t.detail || null, since: t.phase_since || null } });
    if (t.state === 'done') return t;
    if (t.state === 'error' || t.state === 'cancelled') throw new Error(t.error || t.state);
  }
}

async function runBatch(jobId, req) {
  const work = path.join(WORK_BASE, jobId);
  const { model, params, refs, count, draft, generated_by, batch_id, origin, transient } = req;
  const now = new Date().toISOString().slice(0, 7).replace('-', '/');   // YYYY/MM
  try {
    // Everything that can fail sits inside the try: a failure must become a visible job
    // error, never a job stuck at "running".
    await mkdir(work, { recursive: true });
    const refRows = refs.map(id => getAsset(id));
    const refFiles = await Promise.all(refRows.map(r => readFile(assetAbsPath(r))));
    for (let i = 0; i < count; i++) {
      if (JOBS.get(jobId)?.cancelRequested) throw new Error('cancelled');
      const seed = params.seed + i;
      const task = {
        prompt: params.prompt, negative_prompt: params.negative_prompt,
        model_type: model.model_type, resolution: `${params.width}x${params.height}`,
        num_inference_steps: params.num_inference_steps, guidance_scale: params.guidance_scale,
        seed, image_mode: 1, video_length: 1, repeat_generation: 1,
        // reference images: "KI" = refs enabled + canvas fit (engine contract §4)
        video_prompt_type: refRows.length ? 'KI' : '',
      };
      const form = new FormData();
      form.append('task', JSON.stringify(task));
      refRows.forEach((r, k) => form.append(`ref${k}`, new Blob([refFiles[k]]), r.filename || `ref${k}.png`));
      // who asked, for the GPU cop's priority (user before agent) and its "blocked by" wording
      form.append('who', JSON.stringify({ initiator: generated_by === 'user' ? 'user' : `agent:${generated_by}`,
        room: origin ? { id: origin.room_id, name: origin.room_name || null } : null }));
      let taskId, t;
      for (const deadline = Date.now() + RESTART_WAIT_MS; ;) {
        try {
          setJob(jobId, { current: { index: i, state: 'submitting' } });
          ({ job_id: taskId } = await sidecar('/jobs', { method: 'POST', body: form, timeout: 60000 }));
          t = await awaitTask(jobId, taskId, i);
          break;
        } catch (e) {
          if (!e.gone || Date.now() > deadline) throw e;
          const cur = JOBS.get(jobId).current;
          setJob(jobId, { current: { index: i, state: 'waiting-for-gpu', since: cur?.state === 'waiting-for-gpu' ? cur.since : Date.now() / 1000,
            detail: 'waiting for GPU: asset-platform-krea restarting, resumes automatically' } });
          await new Promise(r => setTimeout(r, 5000));
          if (JOBS.get(jobId)?.cancelRequested) throw new Error('cancelled');
        }
      }

      for (const out of t.outputs || []) {
        const r = await fetch(`${SIDECAR}/jobs/${taskId}/files/${encodeURIComponent(out.file)}`);
        if (!r.ok) throw new Error(`fetch output ${out.file} → ${r.status}`);
        const local = path.join(work, out.file);
        await writeFile(local, Buffer.from(await r.arrayBuffer()));
        const recipe = {
          tool: 'image-gen', engine: 'wangp', model_type: model.model_type, model_name: model.name,
          params: { ...params, seed }, refs, batch_id, batch_index: i, batch_size: count,
          draft: !!draft, generated_by, ...(origin && { origin }), engine_task: out.meta || task,
        };
        const asset = await addAsset({
          srcAbsPath: local, moveFrom: true, filename: `${model.model_type}_${batch_id.slice(0, 8)}_${i}${path.extname(out.file) || '.png'}`,
          label: params.prompt.slice(0, 120) || model.name,
          category: 'image', subtype: 'generation', source: model.family || 'krea2',
          // transient (Image Studio,): the Library's working tier; the app promotes
          // the ones the user keeps (favorites) into images/generated/ itself.
          transient: !!transient, curatedSubdir: `images/generated/${now}`,
          parent_id: refs[0] || null, derived_op: recipe,
          meta: { prompt: params.prompt, negative_prompt: params.negative_prompt || '', seed,
            model_type: model.model_type, batch_id, refs, generated_by, draft: !!draft, ...(origin && { origin }) },
        });
        setJob(jobId, { assets: [...(JOBS.get(jobId).assets || []), asset] });
      }
      await sidecar(`/jobs/${taskId}`, { method: 'DELETE' }).catch(() => {});   // GPU host copy no longer needed
    }
    setJob(jobId, { state: 'done', finishedAt: Date.now(), current: null });
  } catch (e) {
    const cancelled = e.message === 'cancelled';
    setJob(jobId, { state: cancelled ? 'cancelled' : 'error', error: cancelled ? null : e.message, finishedAt: Date.now() });
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

let modelCache = null;
async function models() {
  if (!modelCache) {
    const { models } = await sidecar('/models');
    modelCache = models.map(m => ({ ...m, family: m.model_type.split('_')[0] }));
  }
  return modelCache;
}

export async function register(app) {
  ({ addAsset, getAsset, assetAbsPath } =
    await import(pathToFileURL(path.join(ROOT, 'asset-library', 'server.js')).href));
  await mkdir(WORK_BASE, { recursive: true }).catch(() => {});

  app.use(BASE, (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // Engine availability — the UI shows "engine offline" rather than ever starting it.
  app.get(`${BASE}/api/health`, async (req, res) => {
    try { res.json({ ok: true, engine: await sidecar('/health', { timeout: 4000 }) }); }
    catch (e) { res.json({ ok: false, error: `engine offline (${e.message}) — start asset-platform-krea in harbor` }); }
  });

  // Unload the model and free its VRAM (the gauges panel's power button).
  app.post(`${BASE}/api/release`, async (req, res) => {
    try { res.json(await sidecar('/release', { method: 'POST', timeout: 60000 })); }
    catch (e) { res.status(409).json({ ok: false, error: e.message }); }
  });

  app.get(`${BASE}/api/models`, async (req, res) => {
    try { res.json({ ok: true, models: await models() }); }
    catch (e) { modelCache = null; res.status(503).json({ ok: false, error: `engine offline: ${e.message}` }); }
  });

  // POST /api/generate
  // { model_type, prompt, negative_prompt?, width?, height?, aspect?, seed?, count?, draft?,
  //   num_inference_steps?, guidance_scale?, refs?: [assetId ≤2, order = main subject first],
  //   generated_by?: 'user' | '<agent name>', batch_id?,
  //   origin?: { room_id, room_name?, agent?, seat_id?, app? }, transient? }  →  202 { jobId, batch_id }
  // origin (an agent in a briefing-table room) is recorded on every output's derived_op + meta.
  app.post(`${BASE}/api/generate`, express.json(), async (req, res) => {
    reap();
    try {
      const b = req.body || {};
      if (!b.prompt || typeof b.prompt !== 'string') return res.status(400).json({ ok: false, error: 'prompt required' });
      const all = await models();
      const model = all.find(m => m.model_type === b.model_type) || all.find(m => m.model_type === 'krea2_turbo') || all[0];
      if (!model) return res.status(503).json({ ok: false, error: 'no models available' });
      const refs = (b.refs || []).slice(0, MAX_REFS);
      for (const id of refs) {
        const r = getAsset(id);
        if (!r || r.category !== 'image') return res.status(400).json({ ok: false, error: `ref ${id} is not an image asset` });
      }
      if (refs.length && !model.refs) return res.status(400).json({ ok: false, error: `${model.name} does not take reference images` });
      const count = Math.min(Math.max(parseInt(b.count) || 1, 1), MAX_COUNT);
      // aspect 'auto': match the MAIN reference image's shape , at the usual ~1 MP.
      let ratio = Number(b.aspect) || 1;
      if (b.aspect === 'auto' && !(b.width && b.height)) {
        const main = refs.length ? refAspect(getAsset(refs[0])) : null;
        if (!main) return res.status(400).json({ ok: false, error: refs.length ? "Auto aspect: the main reference image has no recorded size — pick an aspect" : 'Auto aspect needs a main reference image' });
        ratio = main;
      }
      let { width, height } = b.width && b.height ? { width: +b.width, height: +b.height } : dimsForAspect(ratio);
      if (b.draft) { width /= 2; height /= 2; }
      const d = model.defaults || {};
      const params = {
        prompt: b.prompt, negative_prompt: b.negative_prompt || '',
        width: snap(width), height: snap(height),
        num_inference_steps: +b.num_inference_steps || d.num_inference_steps || 8,
        guidance_scale: b.guidance_scale != null ? +b.guidance_scale : (d.guidance_scale ?? 0),
        seed: Number.isInteger(parseInt(b.seed)) ? parseInt(b.seed) : Math.floor(Math.random() * 2 ** 31),
      };
      const jobId = randomUUID();
      const batch_id = b.batch_id || jobId;
      setJob(jobId, { state: 'running', createdAt: Date.now(), count, model_type: model.model_type, model_name: model.name, batch_id, params, assets: [] });
      runBatch(jobId, { model, params, refs, count, draft: !!b.draft, generated_by: b.generated_by || 'user', batch_id, origin: cleanOrigin(b.origin), transient: b.transient === true });
      res.status(202).json({ ok: true, jobId, batch_id, params });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Jobs to show in the queue after a page reload (or in another tab): unfinished ones plus
  // failures the user hasn't dismissed. Newest first. Jobs live in this process's memory, so a
  // gateway restart drops them -- the UI marks a vanished job as lost rather than spinning.
  app.get(`${BASE}/api/jobs`, (req, res) => {
    reap();
    const jobs = [...JOBS].filter(([, j]) => j.state === 'running' || j.state === 'error')
      .map(([id, j]) => ({ id, ...j })).sort((a, b) => b.createdAt - a.createdAt);
    res.json({ ok: true, jobs });
  });

  // Dismiss a finished job (e.g. an error card) so it doesn't come back on reload.
  app.delete(`${BASE}/api/jobs/:id`, (req, res) => {
    const j = JOBS.get(req.params.id);
    if (!j) return res.json({ ok: true });
    if (j.state === 'running') return res.status(409).json({ ok: false, error: 'job still running -- cancel it first' });
    JOBS.delete(req.params.id);
    res.json({ ok: true });
  });

  app.get(`${BASE}/api/jobs/:id`, (req, res) => {
    const j = JOBS.get(req.params.id);
    if (!j) return res.status(404).json({ ok: false, error: 'unknown job' });
    res.json({ ok: true, job: { id: req.params.id, ...j } });
  });

  app.post(`${BASE}/api/jobs/:id/cancel`, (req, res) => {
    if (!JOBS.get(req.params.id)) return res.status(404).json({ ok: false, error: 'unknown job' });
    setJob(req.params.id, { cancelRequested: true });
    res.json({ ok: true });
  });

  // The recipe to load back into the tool: exact for our own generations, best-effort for
  // imports with a prompt (Midjourney), 404 for assets with no prompt at all.
  app.get(`${BASE}/api/recipe/:assetId`, (req, res) => {
    const a = getAsset(req.params.assetId);
    if (!a) return res.status(404).json({ ok: false, error: 'not found' });
    const op = a.derived_op && typeof a.derived_op === 'object' ? a.derived_op : null;
    if (op?.tool === 'image-gen') {
      // origin rides beside the recipe, not in it: reloading parameters is not re-making it in that room.
      return res.json({ ok: true, kind: 'reload', recipe: { model_type: op.model_type, ...op.params, refs: op.refs || [] },
        generated_by: op.generated_by || null, origin: op.origin || null });
    }
    const prompt = a.meta?.prompt;
    if (!prompt) return res.status(404).json({ ok: false, error: 'this asset has no prompt to re-use' });
    const r = a.source === 'midjourney' ? recipeFromMidjourney(prompt) : { prompt, ...dimsForAspect(1) };
    res.json({ ok: true, kind: 'reuse', from: a.source, recipe: { ...r, refs: [] }, source_asset: a.id });
  });
}
