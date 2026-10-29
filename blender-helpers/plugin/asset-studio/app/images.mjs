/*
 * Asset Studio's model: one room's generation state, and the verbs that change it.
 * The GPU work is asset-platform's image-gen (the design notes); this is a thin,
 * room-scoped layer over its HTTP API. Every output is registered in the Library by
 * image-gen itself, with its full recipe plus `origin` (the room + agent, task).
 *
 * Room scoping (S4, briefing-table-mcp.md §4.4): every verb acts on the ONE bound room
 * (access: exclusive — the app enforces it, the engine does not yet), and every id a
 * verb takes must belong to that room: a ref or a recipe is an asset this room made or
 * brought in; a job is one this room started.
 *
 * Budget: the user's image budget is enforced HERE, in generate, so every caller — the
 * resident today, app_call later — inherits it. Setting it is a `control` verb.
 *
 * Room share (task; folders): every output is uploaded to the room's share
 * folder under `asset-studio/renders/`, named `<label>_g<gen>-<n>_<id8>.png` — NOT into the
 * room's top level, so hundreds of drafts never clutter the room's Assets view. Each image
 * lives in one of three folders — renders | favorites | recycle — and move_image moves it
 * (the share file, when file-share can move; the Library tier always): favorites are
 * promoted into the curated Library, recycle goes to the Library's bin (48 h), and the room
 * share keeps every file, so a recycled image can always come back. A photo the user drops into
 * the room becomes a reference through import_ref: its bytes go into the Library
 * (deduped), and the new id joins this room's images.
 *
 * State persists to work/state.json so a restart keeps settings, budget and history.
 * Zero dependencies (node >= 20).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { colorMatchFiles } from './colormatch.mjs';
import { execFileSync } from 'node:child_process';
import { readBinding, readConfig, readEngine, WORK_DIR } from './config.mjs';
import { AppError, ROOM_ID, ASSET_ID, RASTER, libUrl, initiator, str, num, lib, postLine, engine, assetsPath, listRoomAssets, familyKey } from './shared.mjs';

export { AppError };


const STATE_FILE = path.join(WORK_DIR, 'images.json');
// History is the room's record of every image it made — never truncated (a 30-cap once dropped a
// favorite,). It's small JSON; the PANEL limits how many earlier batches it draws.
const PER_CALL_MAX = 4;   // images per generate call; the budget caps the total
const MAX_REFS = 2;       // image-gen: up to 2, main subject first

/* ------------------------------------------------------------- image-gen -- */

async function ig(p, { method = 'GET', body, timeout = 8000 } = {}) {
  const base = readConfig().imageGenUrl;
  let r;
  try {
    r = await fetch(base + p, {
      method,
      signal: AbortSignal.timeout(timeout),
      ...(body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch (e) {
    throw new AppError(503, `image-gen unreachable (${e.cause?.code || e.name})`, { reason: 'image-gen-down' });
  }
  const json = await r.json().catch(() => null);
  if (r.status === 503) throw new AppError(503, json?.error || 'engine offline', { reason: 'engine-offline' });
  if (!r.ok) throw new AppError(r.status >= 500 ? 502 : r.status, json?.error || `image-gen ${p} → HTTP ${r.status}`);
  return json;
}

/* release_gpu : unload Krea now instead of waiting for the GPU cop's 60 s idle reclaim.
   An idle Krea keeps only its ~0.3 GB CUDA context; during a job image-gen answers 409 = busy, not an error. */
export async function releaseGpu(r) {
  if (r.history.some((h) => h.state === 'running')) return { released: false, busy: true, reason: 'an image is being generated — the queue is running' };
  try {
    const j = await ig('/release', { method: 'POST', timeout: 20000 });
    return { released: true, freed_mib: j?.freed_mib ?? null, free_vram_mb: j?.free_vram_mb ?? null };
  } catch (e) {
    if (e.status === 409) return { released: false, busy: true, reason: 'busy — the queue is running' };
    throw e;
  }
}

export async function engineHealth() {
  try {
    const h = await ig('/health', { timeout: 4000 });
    return { ok: !!h?.engine?.ok, state: h?.engine?.state ?? null };
  } catch (e) {
    return { ok: false, state: e.extra?.reason || 'unknown' };
  }
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
  settings: {
    model_type: null, prompt: '', negative_prompt: '', aspect: '1', width: null, height: null,
    seed: null, num_inference_steps: null, guidance_scale: null, draft: true, count: 1, label: '',
  },
  refs: [],
  budget: { max_images: readConfig().defaultBudget, used: 0, since: new Date().toISOString() },
  history: [],
  assets: [],   // library ids this room made or brought in — what set_ref / reload_recipe accept
  imports: {},  // room asset name -> library id, for photos brought in with import_ref
});

/* Jobs still running in ANY room (a rebind lets them finish where they started). */
export function runningJobs() {
  return Object.entries(load().rooms).flatMap(([room_id, r]) =>
    r.history.filter((h) => h.state === 'running').map((h) => ({ room_id, job_id: h.job_id })));
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
  const r = s.rooms[roomId];
  r.imports ??= {};
  // images from before folders existed: their Library id is their key; they live in renders
  for (const h of r.history) for (const a of h.assets) { a.lib ??= a.id; a.bin ??= 'renders'; }
  // generations made before gen numbers existed: number them oldest-first, once
  if (r.history.some((h) => h.gen === undefined)) {
    r.history.forEach((h, i) => { h.gen ??= r.history.length - i; });
    r.gen_seq = Math.max(r.gen_seq ?? 0, ...r.history.map((h) => h.gen));
  }
  return r;
}


/* Every image this room made: {rec, h (its generation), i (index)} by its key (the id it was
   born with). rec.lib is its CURRENT Library id (it changes only if a purged image is re-imported). */
function images(r) {
  const out = new Map();
  for (const h of r.history) h.assets.forEach((rec, i) => out.set(rec.id, { rec, h, i }));
  return out;
}
const libOf = (r, id) => images(r).get(id)?.rec.lib ?? id;

export function view(r) {
  return {
    settings: r.settings,
    refs: r.refs.map((id) => ({ id, file_url: libUrl(libOf(r, id), 'file') })),
    budget: { ...r.budget, left: Math.max(0, r.budget.max_images - r.budget.used) },
    running: r.history.filter((h) => h.state === 'running').map((h) => h.job_id),
    latest: r.history.find((h) => h.assets.length) ?? null,
  };
}

/* ------------------------------------------------------------------ verbs -- */

let modelNames = null;   // model_type -> name, for the panel (filled by any list_models call)
export async function listModels() {
  const { models } = await ig('/models');
  modelNames = Object.fromEntries(models.map((m) => [m.model_type, m.name]));
  return models.map((m) => ({ model_type: m.model_type, name: m.name, refs: !!m.refs, defaults: m.defaults || {} }));
}

export async function setModel(r, b) {
  const t = str(b.model_type, 80, 'model_type');
  const m = (await listModels()).find((x) => x.model_type === t);
  if (!m) throw new AppError(400, `unknown model "${t}" — list_models shows the choices`);
  if (r.refs.length && !m.refs) throw new AppError(400, `${m.name} does not take reference images — clear_ref first`);
  r.settings.model_type = t;
  save();
  return view(r);
}

export function setPrompt(r, b) {
  r.settings.prompt = str(b.prompt, 4000, 'prompt').trim();
  if (b.negative_prompt !== undefined) r.settings.negative_prompt = str(b.negative_prompt, 2000, 'negative_prompt').trim();
  save();
  return view(r);
}

/* aspect: 'auto' (match the main ref), a ratio number, or "W:H". width+height override it. */
export function setParams(r, b) {
  const s = { ...r.settings };
  if (b.aspect !== undefined) {
    if (b.aspect === 'auto') s.aspect = 'auto';
    else {
      const m = String(b.aspect).match(/^(\d+(?:\.\d+)?)(?::(\d+(?:\.\d+)?))?$/);
      const ratio = m ? Number(m[1]) / Number(m[2] ?? 1) : NaN;
      s.aspect = String(num(ratio, 0.25, 4, 'aspect'));
    }
    s.width = s.height = null;
  }
  if (b.width !== undefined || b.height !== undefined) {
    if (b.width === null && b.height === null) s.width = s.height = null;
    else { s.width = num(b.width, 256, 2048, 'width', true); s.height = num(b.height, 256, 2048, 'height', true); }
  }
  if (b.seed !== undefined) s.seed = b.seed === null ? null : num(b.seed, 0, 2 ** 31 - 1, 'seed', true);
  if (b.num_inference_steps !== undefined) s.num_inference_steps = b.num_inference_steps === null ? null : num(b.num_inference_steps, 1, 100, 'num_inference_steps', true);
  if (b.guidance_scale !== undefined) s.guidance_scale = b.guidance_scale === null ? null : num(b.guidance_scale, 0, 20, 'guidance_scale');
  if (b.draft !== undefined) {
    if (typeof b.draft !== 'boolean') throw new AppError(400, 'draft must be true or false');
    s.draft = b.draft;
  }
  if (b.count !== undefined) s.count = num(b.count, 1, PER_CALL_MAX, 'count', true);
  if (b.label !== undefined) {
    // a short name for what this batch is ("man-left"): in file names and the panel's headers
    s.label = str(b.label, 40, 'label').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  r.settings = s;
  save();
  return view(r);
}

/* slot 0 = the main subject (drives 'auto' aspect), 1 = the second reference. */
export function setRef(r, b) {
  const id = str(b.asset_id, 80, 'asset_id');
  if (!ASSET_ID.test(id)) throw new AppError(400, 'bad asset_id');
  if (!r.assets.includes(id)) throw new AppError(404, `asset ${id} is not one of this room's images — generate it here, or drop the photo into the room`);
  const slot = b.slot === undefined ? Math.min(r.refs.length, MAX_REFS - 1) : num(b.slot, 0, MAX_REFS - 1, 'slot', true);
  const refs = r.refs.filter((x) => x !== id);
  refs.splice(Math.min(slot, refs.length), 0, id);
  r.refs = refs.slice(0, MAX_REFS);
  save();
  return view(r);
}

export function clearRef(r, b) {
  if (b.slot === undefined) r.refs = [];
  else r.refs.splice(num(b.slot, 0, MAX_REFS - 1, 'slot', true), 1);
  save();
  return view(r);
}

/* Starts a batch and answers at once (S4: 10 s timeout) — poll job_status. */
export async function generate(r, roomId, b) {
  const s = r.settings;
  if (!s.prompt) throw new AppError(400, 'no prompt — set_prompt first');
  const count = b.count === undefined ? s.count : num(b.count, 1, PER_CALL_MAX, 'count', true);
  const draft = b.draft === undefined ? s.draft : !!b.draft;
  const forWho = initiator(b);
  if (r.budget.until && Date.now() > Date.parse(r.budget.until)) {
    throw new AppError(429, `budget time is up (${r.budget.until}) — ask the user for more time`, { reason: 'budget-time', budget: r.budget });
  }
  const left = r.budget.max_images - r.budget.used;
  if (count > left) {
    throw new AppError(429, `budget spent: ${r.budget.used} of ${r.budget.max_images} images used${left ? `, ${left} left` : ''} — ask the user to raise it`, { reason: 'budget', budget: r.budget });
  }
  const bind = readBinding();
  const body = {
    prompt: s.prompt, negative_prompt: s.negative_prompt, count, draft, refs: r.refs.map((id) => libOf(r, id)),
    transient: true,   // the Library's working tier; favorites get promoted (move_image)
    ...(s.model_type && { model_type: s.model_type }),
    ...(s.width && s.height ? { width: s.width, height: s.height } : { aspect: s.aspect === 'auto' ? 'auto' : Number(s.aspect) }),
    ...(s.seed !== null && { seed: s.seed }),
    ...(s.num_inference_steps !== null && { num_inference_steps: s.num_inference_steps }),
    ...(s.guidance_scale !== null && { guidance_scale: s.guidance_scale }),
    generated_by: bind.agent || 'asset-studio',
    origin: { app: 'asset-studio', room_id: roomId, room_name: bind.room_name, agent: bind.agent, seat_id: bind.seat_id },
  };
  const out = await ig('/generate', { method: 'POST', body });
  r.budget.used += count;
  r.gen_seq = (r.gen_seq ?? r.history.length) + 1;
  const entry = {
    gen: r.gen_seq, job_id: out.jobId, batch_id: out.batch_id, at: new Date().toISOString(), state: 'running', error: null,
    settings: { ...s, count, draft, ...(out.params && {
      seed: out.params.seed, width: out.params.width, height: out.params.height,
      num_inference_steps: out.params.num_inference_steps ?? s.num_inference_steps, guidance_scale: out.params.guidance_scale ?? s.guidance_scale,
    }) },
    refs: [...r.refs], count, draft, progress: null, assets: [], for: forWho,
  };
  r.history.unshift(entry);
  save();
  return { job: entry, budget: view(r).budget };
}

function findJob(r, jobId) {
  const h = r.history.find((x) => x.job_id === jobId);
  if (!h) throw new AppError(404, `job ${jobId} is not one of this room's`);
  return h;
}

export const jobStatus = (r, jobId) => findJob(r, jobId);

export async function cancel(r, jobId) {
  const h = findJob(r, jobId);
  if (h.state === 'running') await ig(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
  return h;
}

/* Load an output's settings back into the room (its refs too, when they're still this room's). */
export async function reloadRecipe(r, b) {
  const id = str(b.asset_id, 80, 'asset_id');
  if (!r.assets.includes(id)) throw new AppError(404, `asset ${id} is not one of this room's images`);
  const { recipe } = await ig(`/recipe/${encodeURIComponent(libOf(r, id))}`);
  const s = r.settings;
  Object.assign(s, {
    model_type: recipe.model_type ?? s.model_type, prompt: recipe.prompt ?? '', negative_prompt: recipe.negative_prompt ?? '',
    seed: recipe.seed ?? null, num_inference_steps: recipe.num_inference_steps ?? null, guidance_scale: recipe.guidance_scale ?? null,
  });
  // Size: exact for a full-size output. A draft was rendered at half size, so keep only its
  // shape (aspect) — with draft off, the next render is full size, same framing.
  const ratio = recipe.width && recipe.height ? Math.min(4, Math.max(0.25, recipe.width / recipe.height)) : null;
  const wasDraft = !!images(r).get(id)?.h.draft;
  if (images(r).get(id)?.h.settings.label !== undefined) s.label = images(r).get(id).h.settings.label;
  s.aspect = ratio ? String(ratio) : '1';
  if (ratio && !wasDraft) Object.assign(s, { width: recipe.width, height: recipe.height });
  else s.width = s.height = null;
  r.refs = (recipe.refs || []).filter((x) => r.assets.includes(x)).slice(0, MAX_REFS);
  save();
  return view(r);
}

export const history = (r) => r.history;

/* What the panel shows (GET /rooms/:roomId/panel.json): the view-only picture of the room.
   Asset ids only — the panel fetches thumbs/files through this app's own relative routes. */
/* Only what the tab renders (briefing-table traffic ask, all 67 batches were ~104 KB
   every 10 s): studio = the latest 1 + EARLIER_MAX shown batches (+ how many older), favorites /
   recycle = that folder's batches, review = none. Running batches ride along on every tab (progress,
   poll speed). Folder counts are computed here so the tabs don't need every batch. */
export const EARLIER_MAX = 12;
export async function panelData(r, engine, tab = 'studio') {
  if (!modelNames) await listModels().catch(() => {});
  if (!['studio', 'favorites', 'recycle', 'review'].includes(tab)) tab = 'studio';
  const n = r.history.length;
  const inTab = (a) => (tab === 'studio' ? (a.bin || 'renders') !== 'recycle' : (a.bin || 'renders') === tab);
  const keep = r.history.map((h, i) => [h, i]).filter(([h]) => h.state === 'running'
    || (tab !== 'review' && (h.assets.some(inTab) || (tab === 'studio' && !h.assets.length))));
  const cut = tab === 'studio' ? 1 + EARLIER_MAX : Infinity;
  const counts = { favorites: 0, recycle: 0 };
  for (const h of r.history) for (const a of h.assets) if (a.bin in counts) counts[a.bin]++;
  // the rail's line : rendering or idle · images queued · images produced
  counts.images = r.history.reduce((k, h) => k + h.assets.length, 0);
  counts.queued = r.history.filter((h) => h.state === 'running').reduce((k, h) => k + Math.max(0, (h.count ?? 0) - h.assets.length), 0);
  const gens = keep.slice(0, cut).map(([h, i]) => ({
    gen: h.gen ?? n - i, job_id: h.job_id, at: h.at, state: h.state, error: h.error, draft: h.draft, count: h.count,
    progress: h.progress, settings: h.settings, refs: h.refs,
    model_name: modelNames?.[h.settings.model_type ?? 'krea2_turbo'] ?? h.settings.model_type,
    label: h.settings.label || '',
    assets: h.assets.map((a) => ({ id: a.id, lib: a.lib ?? a.id, width: a.width, height: a.height, seed: a.seed, bin: a.bin || 'renders' })),
  }));
  return {
    engine, settings: r.settings, refs: r.refs, library_web: readConfig().libraryWebUrl || null,
    model_name: modelNames?.[r.settings.model_type ?? 'krea2_turbo'] ?? r.settings.model_type ?? 'default',
    budget: view(r).budget, tab, generations: gens, n_generations: n, generations_more: Math.max(0, keep.length - cut),
    counts,
  };
}

/* The focus page's Info and References: for each image of an item that this room generated, its
   generation — model, settings and prompt, seed, size, the references it was made from and the other
   images of the batch. Images from elsewhere in the Library have no entry. */
export function generationInfo(roomId, ids) {
  const r = room(roomId);
  const all = images(r), out = {};
  for (const id of ids) {
    const x = all.get(id);
    if (!x) continue;
    const { h, rec, i } = x;
    const s = h.settings || {};
    out[id] = {
      gen: h.gen ?? null, i, count: h.count, draft: !!h.draft, label: s.label || '',
      model_name: modelNames?.[s.model_type ?? 'krea2_turbo'] ?? s.model_type ?? 'default',
      prompt: s.prompt || '', negative_prompt: s.negative_prompt || '', steps: s.num_inference_steps ?? null,
      seed: rec.seed ?? s.seed ?? null, width: rec.width ?? null, height: rec.height ?? null, bin: rec.bin || 'renders', lib: rec.lib ?? rec.id,
      refs: h.refs || [], siblings: h.assets.map((a) => a.id).filter((a) => a !== id),
    };
  }
  return out;
}


/* The panel's image bytes: only this room's images, from the Library. */
/* allowed: another domain vouches for the id (a review's image) */
export async function libraryBytes(r, id, what, allowed = false) {
  if (!allowed && !r.assets.includes(id)) throw new AppError(404, 'not one of this room\'s images');
  const rec = images(r).get(id)?.rec;
  const f = await fetch(libUrl(rec?.lib ?? id, what), { signal: AbortSignal.timeout(20000) });
  if (f.ok) return { type: f.headers.get('content-type') || 'image/png', bytes: Buffer.from(await f.arrayBuffer()) };
  // purged from the Library's bin (48 h): the room share still has it
  const sp = rec?.share_path;
  if (f.status === 404 && sp) {
    const g = await fetch(`${shareBase()}/raw/${sp.split('/').map(encodeURIComponent).join('/')}`, { signal: AbortSignal.timeout(20000) });
    if (g.ok) return { type: g.headers.get('content-type') || 'image/png', bytes: Buffer.from(await g.arrayBuffer()) };
  }
  throw new AppError(f.status === 404 ? 404 : 502, `Library ${what} → HTTP ${f.status}`);
}

/* control — the user's budget, not the agent's. The resident's settings put this verb behind
   a human approval (.claude/settings.json `ask`), and every change is announced in the room.
   Count: raising the max keeps the count; only `reset: true` zeroes it. Time (the brief's
   "count or time"): `minutes` sets a deadline from now, `minutes: null` clears it. */
export async function setBudget(r, roomId, b) {
  const max = num(b.max_images, 1, 5000, 'max_images', true);
  if (b.reset !== undefined && typeof b.reset !== 'boolean') throw new AppError(400, 'reset must be true or false');
  const forWho = initiator(b, 'user');   // a budget is the user's word
  const until = b.minutes === undefined ? r.budget.until ?? null
    : b.minutes === null ? null : new Date(Date.now() + num(b.minutes, 1, 24 * 60, 'minutes', true) * 60000).toISOString();
  r.budget = b.reset ? { max_images: max, used: 0, since: new Date().toISOString(), until } : { ...r.budget, max_images: max, until };
  save();
  const t = until ? `, until ${new Date(until).toISOString().slice(11, 16)} UTC` : '';
  await postLine(roomId, `Asset Studio budget set to ${max} images${t}${b.reset ? ' (count reset)' : ''} — ${r.budget.used} used so far.`, forWho).catch(() => {});
  return view(r).budget;
}

/* Give back the images a job never produced (error, cancel, lost), unless the budget was
   reset since the job started. */
function refund(r, h) {
  const back = Math.max(0, h.count - h.assets.length);
  if (back && !h.refunded && h.at >= r.budget.since) r.budget.used = Math.max(0, r.budget.used - back);
  h.refunded = back;
}

/* ---------------------------------------------------------------- tracker -- */

/* Follow every running job of every room to a terminal state, whether or not anyone
   polls job_status: outputs must be recorded in the room even if the agent walks away. */
export async function track() {
  const s = load();
  let changed = false;
  for (const r of Object.values(s.rooms)) {
    for (const h of r.history.filter((x) => x.state === 'running')) {
      let j;
      try {
        j = (await ig(`/jobs/${encodeURIComponent(h.job_id)}`, { timeout: 4000 })).job;
      } catch (e) {
        if (e.status === 404) {
          Object.assign(h, { state: 'lost', error: 'image-gen lost this job (gateway restart?) — generate again', progress: null });
          refund(r, h);
          changed = true;
        }
        continue;   // engine/gateway hiccup: try again next tick
      }
      const assets = (j.assets || []).map((a) => {
        const m = typeof a.meta === 'string' ? JSON.parse(a.meta || '{}') : a.meta || {};
        return { id: a.id, file_url: libUrl(a.id, 'file'), thumb_url: libUrl(a.id, 'thumb'), seed: m.seed ?? null, width: m.width ?? null, height: m.height ?? null };
      });
      if (assets.length !== h.assets.length) {
        const had = new Map(h.assets.map((a) => [a.id, a]));
        h.assets = assets.map((a) => ({ bin: 'renders', lib: a.id, ...a, ...had.get(a.id) }));
        for (const a of assets) if (!r.assets.includes(a.id)) r.assets.push(a.id);
        changed = true;
      }
      const progress = j.current ? { index: j.current.index, state: j.current.state, progress: j.current.progress ?? null } : null;
      if (JSON.stringify(progress) !== JSON.stringify(h.progress)) { h.progress = progress; changed = true; }
      if (j.state !== 'running') {
        Object.assign(h, { state: j.state, error: j.error ?? null, progress: null });
        refund(r, h);
        if (h.assets.length) h.announce = true;
        changed = true;
      }
    }
  }
  for (const [roomId, r] of Object.entries(s.rooms)) {
    for (const h of r.history) {
      for (const [i, a] of h.assets.entries()) {
        if (a.room_asset || a.share_path || (a.push_tries ?? 0) >= 3) continue;
        a.push_tries = (a.push_tries ?? 0) + 1;
        try {
          a.share_path = await uploadRender(r, roomId, h, i, a);
          delete a.push_error;
        } catch (e) {
          a.push_error = e.message;
        }
        changed = true;
      }
    }
    // Reconcile the room share with the folders: an image whose file sits outside its folder's
    // directory (left over from before file-share could move, or a failed move) is moved there.
    // A few per tick; skipped entirely while the share can't move (shareMove → null).
    let budget = RECONCILE_PER_TICK;
    for (const a of r.history.flatMap((h) => h.assets)) {
      if (!budget || !a.share_path || a.reconcile_failed) continue;
      const want = binDir(r.share_folder || '', a.bin || 'renders');
      if (!r.share_folder || a.share_path.startsWith(want + '/')) continue;
      // only files in this app's own tree: Image Studio's (image-studio/…) stay where they are — a preview
      // run once moved 24 of them under the live Image Studio; moving them is a switch-over call
      if (!a.share_path.startsWith(`${r.share_folder}/asset-studio/`)) continue;
      budget--;
      try {
        const p = await shareMove(a.share_path, want);
        if (p === null) break;                     // this file-share can't move yet
        a.share_path = p;
        delete a.share_copy;
      } catch (e) {
        a.reconcile_failed = e.message;            // don't retry forever; list_images shows it
      }
      changed = true;
    }
    // Announce a finished job once its outputs are in Assets (or given up on) — from here,
    // not the agent, so the room hears about them even if the resident walked away.
    for (const h of r.history.filter((x) => x.announce && x.assets.every((a) => a.room_asset || a.share_path || (a.push_tries ?? 0) >= 3))) {
      delete h.announce;
      const put = h.assets.filter((a) => a.share_path);
      const size = h.assets[0]?.width ? ` ${h.assets[0].width}×${h.assets[0].height}` : '';
      const label = h.settings.label ? ` "${h.settings.label}"` : '';
      await postLine(roomId, `Asset Studio: gen ${h.gen ?? '?'}${label} — ${h.assets.length} new image${h.assets.length > 1 ? 's' : ''} (${h.draft ? 'draft' : 'full'}${size})${
        put.length ? ` in asset-studio/renders/` : ''}${put.length < h.assets.length ? ` · ${h.assets.length - put.length} could not be saved to the room share` : ''}`, h.for).catch(() => {});
      changed = true;
    }
  }
  if (changed) save();
  return changed;
}

/* ------------------------------------------------------------ room assets -- */

const OUT_PREFIX = 'asset-studio-';
const IMAGE_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

/* ------------------------------------------------------------ room share -- */

const BINS = ['renders', 'favorites', 'recycle'];
const RECONCILE_PER_TICK = 8;
const shareBase = () => (readConfig().shareUrl || '').replace(/\/+$/, '');

/* The room's folder on file-share (the engine derives it; cached per room). */
async function roomFolder(r, roomId) {
  if (r.share_folder) return r.share_folder;
  const e = engine();
  const f = await fetch(`${e.url}${assetsPath(roomId)}/folder`, { headers: e.headers, signal: AbortSignal.timeout(8000) });
  const j = await f.json().catch(() => null);
  if (!f.ok || !j?.folder) throw new Error(`room folder → HTTP ${f.status}`);
  r.share_folder = j.folder;
  return j.folder;
}
const binDir = (folder, bin) => `${folder}/asset-studio/${bin}`;

async function shareUpload(dir, name, type, bytes) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), name);
  const r = await fetch(`${shareBase()}/api/upload?dir=${encodeURIComponent(dir)}&mkdir=1`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.saved?.[0]) throw new Error(`file-share upload → HTTP ${r.status}${j?.error ? `: ${j.error}` : ''}`);
  return j.saved[0];
}

/* file-share's move (asked of briefing-table). null = the share can't move yet. */
async function shareMove(from, toDir) {
  const r = await fetch(`${shareBase()}/api/move`, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from, to_dir: toDir, mkdir: true }),
  });
  if (r.status === 404 || r.status === 405 || r.status === 501) return null;
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.path) throw new Error(`file-share move → HTTP ${r.status}${j?.error ? `: ${j.error}` : ''}`);
  return j.path;
}

/* One render → the room share's renders/ folder, with a name a person can scan. */
async function uploadRender(r, roomId, h, i, a) {
  const f = await fetch(libUrl(a.lib ?? a.id, 'file'), { signal: AbortSignal.timeout(20000) });
  if (!f.ok) throw new Error(`Library file ${a.id} → HTTP ${f.status}`);
  const type = f.headers.get('content-type')?.split(';')[0] || 'image/png';
  const name = `${h.settings.label || 'img'}_g${h.gen ?? 0}-${i + 1}_${a.id.slice(0, 8)}${IMAGE_EXT[type] || '.png'}`;
  return shareUpload(binDir(await roomFolder(r, roomId), a.bin || 'renders'), name, type, Buffer.from(await f.arrayBuffer()));
}

/* to_art — a Library image becomes Art-library art (a single-colour, currentColor SVG) through
   briefing-table's icon-lab import: the "trace @512 + SVGO" pipeline the Art page uses. Called, not copied, so there is one pipeline to tune. Bold, high-contrast
   marks on white or transparent trace best; fine texture and hairlines vanish at tab size. */
export async function toArt(r, roomId, b) {
  const id = str(b.asset_id, 80, 'asset_id');
  const name = str(b.name, 80, 'name');
  const meta = await lib(`/assets/${encodeURIComponent(id)}`);
  if (meta.status !== 200) throw new AppError(404, `Library asset ${id} not found`);
  if (meta.json?.category !== 'image') throw new AppError(400, `asset ${id} is not an image`);
  const f = await fetch(libUrl(id, 'file'), { signal: AbortSignal.timeout(30000) });
  if (!f.ok) throw new AppError(502, `Library file ${id} → HTTP ${f.status}`);
  // ≤1024 px on the long side as PNG: the pipeline traces at 512, and the import caps the JSON body
  // at 2 MB (base64 adds ~33%), so more pixels buy nothing (briefing-table,).
  let png;
  try {
    png = execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-vf', "scale='min(1024,iw)':'min(1024,ih)':force_original_aspect_ratio=decrease",
      '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], { input: Buffer.from(await f.arrayBuffer()), maxBuffer: 64 << 20 });
  } catch (err) {
    throw new AppError(422, `could not read ${id} as an image: ${String(err.stderr || err.message).split('\n')[0]}`);
  }
  if (png.length > 1.4e6) throw new AppError(413, `image is ${(png.length / 1e6).toFixed(1)} MB after downscaling; the Art import takes about 1.4 MB`);
  const e = readEngine();
  if (e.error) throw new AppError(503, e.error);
  const res = await fetch(`${e.url}/api/icon-lab/import`, {
    method: 'POST', signal: AbortSignal.timeout(60000),
    headers: { ...e.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ name, png: png.toString('base64') }),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j?.ok) throw new AppError(502, `icon-lab import → HTTP ${res.status}: ${j?.error || 'no detail'}`);
  // logo.name is the name the Art library kept (a clash becomes "name (2)") — report that one.
  return { logo: j.logo, name: j.logo.name, key: `lib:${j.logo.id}`, paths: j.paths, bytes: j.bytes, from: id };
}

/* The Library side of a move. favorites: back from the bin if needed, then promoted into the
   curated Library. recycle: into the Library's bin (it purges after 48 h — the room share keeps
   the file). renders: back from the bin. A purged image is re-imported from the share copy. */
async function libraryMove(r, rec, to) {
  rec.lib ??= rec.id;
  if (to === 'recycle') {
    const t = await lib(`/clip/${encodeURIComponent(rec.lib)}/trash`, { method: 'POST', body: {} });
    if (t.status !== 200 && t.status !== 404) throw new AppError(502, `Library trash → HTTP ${t.status}`);
    return;
  }
  const rv = await lib(`/clip/${encodeURIComponent(rec.lib)}/revive`, { method: 'POST', body: {} });
  if (rv.status === 404) {
    if (!rec.share_path) throw new AppError(409, `image ${rec.id} is gone from the Library and has no room copy`);
    const raw = await fetch(`${shareBase()}/raw/${rec.share_path.split('/').map(encodeURIComponent).join('/')}`, { signal: AbortSignal.timeout(30000) });
    if (!raw.ok) throw new AppError(502, `room copy → HTTP ${raw.status}`);
    const form = new FormData();
    form.append('file', new Blob([await raw.arrayBuffer()], { type: 'image/png' }), rec.share_path.split('/').pop());
    const up = await fetch(`${readConfig().libraryUrl}/assets/upload?dedupe=1`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
    const j = await up.json().catch(() => null);
    if (!up.ok || !j?.asset?.id) throw new AppError(502, `Library re-import → HTTP ${up.status}`);
    rec.lib = j.asset.id;
  } else if (rv.status !== 200) throw new AppError(502, `Library revive → HTTP ${rv.status}`);
  if (to === 'favorites') {
    const month = new Date().toISOString().slice(0, 7).replace('-', '/');
    const p = await lib(`/assets/${encodeURIComponent(rec.lib)}`, { method: 'PATCH', body: { promote: { subdir: `images/generated/${month}`, subtype: 'generation' } } });
    if (p.status !== 200) throw new AppError(502, `Library promote → HTTP ${p.status}`);
  }
}

/* move_image — one or several of this room's images into renders | favorites | recycle. */
export async function moveImage(r, roomId, b) {
  const to = str(b.to, 20, 'to');
  if (!BINS.includes(to)) throw new AppError(400, `to must be one of ${BINS.join(', ')}`);
  const ids = b.asset_ids !== undefined ? b.asset_ids : [b.asset_id];
  if (!Array.isArray(ids) || !ids.length || ids.length > 50) throw new AppError(400, 'asset_id, or asset_ids (1–50)');
  const all = images(r);
  const hits = ids.map((id) => {
    const x = all.get(str(id, 80, 'asset_id'));
    if (!x) throw new AppError(404, `asset ${id} is not one of this room's generated images`);
    return x;
  });
  const moved = [];
  for (const { rec, h, i } of hits) {
    if (rec.bin === to) { moved.push(imageOut(rec, h, i)); continue; }
    await libraryMove(r, rec, to);
    if (rec.share_path) {
      const p = await shareMove(rec.share_path, binDir(await roomFolder(r, roomId), to)).catch((e) => { rec.share_error = e.message; return undefined; });
      if (p) { rec.share_path = p; delete rec.share_copy; }
      else if (p === null && to === 'favorites' && !rec.share_copy) {
        // no move on the share yet: at least put a copy where the user will look for keepers
        rec.share_copy = await uploadRender(r, roomId, h, i, { ...rec, bin: 'favorites' }).catch(() => null);
      }
    }
    rec.bin = to;
    moved.push(imageOut(rec, h, i));
  }
  save();
  return { moved };
}

const imageOut = (rec, h, i) => ({
  id: rec.id, gen: h.gen ?? null, index: i + 1, of: h.count, label: h.settings.label || '', bin: rec.bin || 'renders',
  draft: h.draft, seed: rec.seed, width: rec.width, height: rec.height, share_path: rec.share_path || rec.room_asset || null,
  file_url: libUrl(rec.lib ?? rec.id, 'file'),
});

/* color_match — pull one of this room's images onto a reference image's colours (hair, skin and
   clothing classes matched separately; optional dark-pixel lift). No GPU, no budget. The result
   is a NEW room image: its own generation entry (label "<label>-cm"), a Library asset whose
   derived_op records {op:'colormatch', target, ref} + the room origin, and a file in renders/. */
export async function colorMatch(r, roomId, b) {
  const all = images(r);
  const tgtId = str(b.asset_id, 80, 'asset_id');
  const refId = str(b.ref_id, 80, 'ref_id');
  const tgt = all.get(tgtId);
  if (!tgt) throw new AppError(404, `asset ${tgtId} is not one of this room's generated images`);
  if (!r.assets.includes(refId)) throw new AppError(404, `ref ${refId} is not one of this room's images`);
  const lift = b.lift_dark === undefined ? true : b.lift_dark === true;
  const forWho = initiator(b);
  const staging = readConfig().libraryStaging;
  if (!staging) throw new AppError(503, 'libraryStaging is not configured');
  fs.mkdirSync(staging, { recursive: true });
  const tag = randomUUID();
  const files = { ref: path.join(staging, `${tag}-ref.png`), tgt: path.join(staging, `${tag}-tgt.png`), out: path.join(staging, `${tag}-cm.png`) };
  try {
    for (const [k, id] of [['ref', libOf(r, refId)], ['tgt', tgt.rec.lib ?? tgtId]]) {
      const f = await fetch(libUrl(id, 'file'), { signal: AbortSignal.timeout(30000) });
      if (!f.ok) throw new AppError(502, `Library file ${id} → HTTP ${f.status}`);
      fs.writeFileSync(files[k], Buffer.from(await f.arrayBuffer()));
    }
    let res;
    try {
      res = colorMatchFiles(files.ref, files.tgt, files.out, { lift });
    } catch (e) {
      throw new AppError(422, `color match failed: ${String(e.message).split('\n')[0]}`);
    }
    const bind = readBinding();
    const origin = { kind: 'room', app: 'asset-studio', room_id: roomId, room_name: bind.room_name, agent: bind.agent, seat_id: bind.seat_id };
    const label = `${(tgt.h.settings.label || 'img').replace(/(-(crop|fix|cm))+$/, '')}-cm`;
    const up = await lib('/assets', { method: 'POST', body: {
      srcPath: files.out, filename: `${label}.png`, label: `${label} (color-matched)`, source: 'asset-studio', subtype: 'generation', transient: true,
      parent_id: tgt.rec.lib ?? tgtId,
      derived_op: { tool: 'asset-studio', op: 'colormatch', target: tgt.rec.lib ?? tgtId, ref: libOf(r, refId), lift_dark: lift, origin, generated_by: bind.agent },
      meta: { prompt: tgt.h.settings.prompt, origin, generated_by: bind.agent, colormatch: { target: tgtId, ref: refId, lift_dark: lift } },
    } });
    if (up.status !== 200 || !up.json?.asset?.id) throw new AppError(502, `Library index → HTTP ${up.status}${up.json?.error ? `: ${up.json.error}` : ''}`);
    const id = up.json.asset.id;
    r.gen_seq = (r.gen_seq ?? r.history.length) + 1;
    const entry = {
      gen: r.gen_seq, job_id: `cm-${tag}`, batch_id: `cm-${tag}`, at: new Date().toISOString(), state: 'done', error: null,
      settings: { ...tgt.h.settings, label, count: 1 }, refs: [refId], count: 1, draft: tgt.h.draft, progress: null, for: forWho,
      op: 'colormatch', source: tgtId, announce: true,
      assets: [{ id, lib: id, bin: 'renders', file_url: libUrl(id, 'file'), thumb_url: libUrl(id, 'thumb'), seed: tgt.rec.seed ?? null, width: res.w, height: res.h }],
    };
    r.history.unshift(entry);
      r.assets.push(id);
    save();
    return { image: imageOut(entry.assets[0], entry, 0) };
  } finally {
    for (const f of Object.values(files)) fs.rmSync(f, { force: true });
  }
}

/* ---------------------------------------------------------------- region edits -- */
/* The fix for LOCAL problems (eyes, hands, a stud) that whole-image prompts can't reach: crop
   the region, upscale it so it fills the frame (the edit model then has pixels to work with),
   edit that crop with generate, and paste the chosen edit back with a feathered edge. crop and
   paste are pixel ops (ffmpeg) — no GPU, no budget; each makes a NEW room image with lineage. */

const intIn = (v, lo, hi, name) => num(v, lo, hi, name, true);
/* "character-tpose-fix-crop" -> "character-tpose": one suffix per derived image, never a chain. */
const baseLabel = (l) => (l || 'img').replace(/(-(crop|fix|cm))+$/, '');

async function fetchTo(file, id) {
  const f = await fetch(libUrl(id, 'file'), { signal: AbortSignal.timeout(30000) });
  if (!f.ok) throw new AppError(502, `Library file ${id} → HTTP ${f.status}`);
  fs.writeFileSync(file, Buffer.from(await f.arrayBuffer()));
}
function dims(file) {
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim().split(',').map(Number);
  return { w, h };
}
function ffmpeg(args) {
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    throw new AppError(422, `image op failed: ${String(e.stderr || e.message).split('\n')[0]}`);
  }
}

/* Index a staged file in the Library and add it to the room as its own one-image generation. */
async function addDerived(r, roomId, { file, label, parentLib, from, op, extra, forWho }) {
  const bind = readBinding();
  const origin = { kind: 'room', app: 'asset-studio', room_id: roomId, room_name: bind.room_name, agent: bind.agent, seat_id: bind.seat_id };
  const up = await lib('/assets', { method: 'POST', body: {
    srcPath: file, filename: `${label.split(' ')[0]}.png`, label, source: 'asset-studio', subtype: 'generation', transient: true, parent_id: parentLib,
    derived_op: { tool: 'asset-studio', op, ...extra, origin, generated_by: bind.agent },
    meta: { prompt: from.h.settings.prompt, origin, generated_by: bind.agent, [op]: extra },
  } });
  if (up.status !== 200 || !up.json?.asset?.id) throw new AppError(502, `Library index → HTTP ${up.status}${up.json?.error ? `: ${up.json.error}` : ''}`);
  const id = up.json.asset.id;
  const { w, h } = dims(file);
  r.gen_seq = (r.gen_seq ?? r.history.length) + 1;
  const entry = {
    gen: r.gen_seq, job_id: `${op}-${randomUUID()}`, at: new Date().toISOString(), state: 'done', error: null,
    settings: { ...from.h.settings, label: label.split(' ')[0], count: 1 }, refs: [], count: 1, draft: from.h.draft, progress: null,
    for: forWho, op, source: from.rec.id, announce: true,
    assets: [{ id, lib: id, bin: 'renders', file_url: libUrl(id, 'file'), thumb_url: libUrl(id, 'thumb'), seed: from.rec.seed ?? null, width: w, height: h }],
  };
  r.history.unshift(entry);
  r.assets.push(id);
  save();
  return imageOut(entry.assets[0], entry, 0);
}

function staged(tag, names) {
  const dir = readConfig().libraryStaging;
  if (!dir) throw new AppError(503, 'libraryStaging is not configured');
  fs.mkdirSync(dir, { recursive: true });
  return Object.fromEntries(names.map((n) => [n, path.join(dir, `${tag}-${n}.png`)]));
}

/* crop_region {asset_id, x, y, w, h, long_edge? | canvas?} — the region as a new image: upscaled
   so its long edge is long_edge px (default 1024) to set_ref and edit; OR, with canvas {w, h,
   fit_h?, bg?}, scaled to fit_h px tall and centred on a w x h canvas — how a view is cut out
   of a turnaround sheet to match the other views' canvas and scale. */
export async function cropRegion(r, roomId, b) {
  const src = images(r).get(str(b.asset_id, 80, 'asset_id'));
  if (!src) throw new AppError(404, `asset ${b.asset_id} is not one of this room's generated images`);
  const forWho = initiator(b);
  const f = staged(randomUUID(), ['src', 'out']);
  try {
    await fetchTo(f.src, src.rec.lib ?? src.rec.id);
    const d = dims(f.src);
    const x = intIn(b.x, 0, d.w - 16, 'x'), y = intIn(b.y, 0, d.h - 16, 'y');
    const w = intIn(b.w, 16, d.w - x, 'w'), h = intIn(b.h, 16, d.h - y, 'h');
    let vf;
    if (b.canvas !== undefined) {
      // cut a view out of a turnaround sheet onto a canvas that matches the other views: the
      // region scaled so it is fit_h px tall (default: fills the canvas height), centred on a
      // canvas_w x canvas_h background
      const c = b.canvas || {};
      const cw = intIn(c.w, 64, 2048, 'canvas.w'), ch = intIn(c.h, 64, 2048, 'canvas.h');
      const fh = c.fit_h === undefined ? ch : intIn(c.fit_h, 16, ch, 'canvas.fit_h');
      const bg = c.bg === undefined ? 'black' : String(c.bg);
      if (!/^(black|white|0x[0-9a-fA-F]{6})$/.test(bg)) throw new AppError(400, 'canvas.bg: black, white or 0xRRGGBB');
      const sw = Math.round((w * fh) / h / 2) * 2, sh = Math.round(fh / 2) * 2;
      if (sw > cw) throw new AppError(400, `the region scaled to ${fh} px tall is ${sw} px wide — wider than the ${cw} px canvas`);
      vf = `crop=${w}:${h}:${x}:${y},scale=${sw}:${sh}:flags=lanczos,pad=${cw}:${ch}:(ow-iw)/2:(oh-ih)/2:${bg}`;
    } else {
      const L = b.long_edge === undefined ? 1024 : intIn(b.long_edge, 256, 2048, 'long_edge');
      const [ow, oh] = w >= h ? [L, Math.round((L * h) / w / 2) * 2] : [Math.round((L * w) / h / 2) * 2, L];
      vf = `crop=${w}:${h}:${x}:${y},scale=${ow}:${oh}:flags=lanczos`;
    }
    ffmpeg(['-i', f.src, '-vf', vf, '-frames:v', '1', f.out]);
    const label = `${baseLabel(src.h.settings.label)}-crop`;
    return { image: await addDerived(r, roomId, { file: f.out, label, parentLib: src.rec.lib ?? src.rec.id, from: src, op: 'crop', extra: { source: src.rec.id, region: { x, y, w, h } }, forWho }) };
  } finally {
    for (const p of Object.values(f)) fs.rmSync(p, { force: true });
  }
}

/* paste_region {base_id, patch_id, x, y, w, h, feather?, feather_edges?} — the patch (e.g. an
   edited crop) scaled into the base's region and blended through a feathered mask. feather =
   px (default 16); feather_edges = which sides fade (default all four; a region touching the
   image edge should not fade on that side, e.g. "left,right,bottom" for a face at the top). */
export async function pasteRegion(r, roomId, b) {
  const all = images(r);
  const base = all.get(str(b.base_id, 80, 'base_id'));
  const patch = all.get(str(b.patch_id, 80, 'patch_id'));
  if (!base) throw new AppError(404, `base ${b.base_id} is not one of this room's generated images`);
  if (!patch) throw new AppError(404, `patch ${b.patch_id} is not one of this room's generated images`);
  const forWho = initiator(b);
  const f = staged(randomUUID(), ['base', 'patch', 'out']);
  try {
    await fetchTo(f.base, base.rec.lib ?? base.rec.id);
    await fetchTo(f.patch, patch.rec.lib ?? patch.rec.id);
    const d = dims(f.base);
    const x = intIn(b.x, 0, d.w - 16, 'x'), y = intIn(b.y, 0, d.h - 16, 'y');
    const w = intIn(b.w, 16, d.w - x, 'w'), h = intIn(b.h, 16, d.h - y, 'h');
    const fe = b.feather === undefined ? 16 : intIn(b.feather, 0, Math.floor(Math.min(w, h) / 3), 'feather');
    const edges = new Set(String(b.feather_edges ?? 'left,right,top,bottom').split(',').map((s) => s.trim()));
    for (const e of edges) if (!['left', 'right', 'top', 'bottom'].includes(e)) throw new AppError(400, 'feather_edges: left,right,top,bottom');
    // mask: white box inset by the feather on the fading sides, blurred by the feather
    const l = edges.has('left') ? fe : 0, t = edges.has('top') ? fe : 0;
    const bw = w - l - (edges.has('right') ? fe : 0), bh = h - t - (edges.has('bottom') ? fe : 0);
    const blur = fe ? `,boxblur=${Math.max(1, Math.round(fe / 2))}:1` : '';
    ffmpeg(['-i', f.base, '-i', f.patch, '-f', 'lavfi', '-i', `color=black:s=${w}x${h},format=gray,drawbox=x=${l}:y=${t}:w=${bw}:h=${bh}:color=white:t=fill${blur}`,
      '-filter_complex', `[1]scale=${w}:${h}:flags=lanczos,format=rgba[p];[2]format=gray[m];[p][m]alphamerge[pm];[0][pm]overlay=${x}:${y}:format=auto`, '-frames:v', '1', f.out]);
    const label = `${baseLabel(base.h.settings.label)}-fix`;
    return { image: await addDerived(r, roomId, { file: f.out, label, parentLib: base.rec.lib ?? base.rec.id, from: base, op: 'paste', extra: { base: base.rec.id, patch: patch.rec.id, region: { x, y, w, h }, feather: fe, feather_edges: [...edges] }, forWho }) };
  } finally {
    for (const p of Object.values(f)) fs.rmSync(p, { force: true });
  }
}

/* list_images — this room's generated images, newest first; optionally one folder. */
export function listImages(r, bin) {
  if (bin !== undefined && bin !== null && bin !== '' && !BINS.includes(bin)) throw new AppError(400, `bin must be one of ${BINS.join(', ')}`);
  const out = [];
  for (const [, { rec, h, i }] of images(r)) if (!bin || (rec.bin || 'renders') === bin) out.push(imageOut(rec, h, i));
  return out;
}

/* Our own output's Library id, from its room asset name. */
const outputId = (r, name) => {
  // Image Studio named its room-asset copies image-studio-<id>.png: those are ours too (the cut-over,)
  const pre = [OUT_PREFIX, 'image-studio-'].find((p) => name.startsWith(p));
  const m = pre && name.slice(pre.length).replace(/\.[a-z]+$/, '');
  return m && r.assets.includes(m) ? m : null;
};

/* Raster only: image-gen can't use an SVG (or anything else claiming image/*) as a reference.
   The listed type is whatever the uploader claimed, so import_ref checks the bytes too. */
const magicOk = (b) =>
  (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) ||                        // PNG
  (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||                                          // JPEG
  (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP');
// A room can hold different files under one name over time: key an import on name + size.
const importKey = (a) => `${a.name}|${a.size ?? ''}`;

/* The room's images, and which Library id each is (if it's one of ours or already imported). */
export async function roomImages(r, roomId) {
  const list = (await listRoomAssets(roomId)).filter((a) => RASTER.test(a.type || ''));
  return list.map((a) => ({
    name: a.name, type: a.type, size: a.size, added_by: a.addedBy, added_at: a.addedAt,
    asset_id: outputId(r, a.name) ?? r.imports[importKey(a)] ?? null,
  }));
}

/* A room image -> this room's reference. Our own outputs map straight to their id; anything
   else (a photo the user dropped) goes into the Library first (deduped by content). */
/* a room image's Library id for another domain (review_ref) */
export const importRoomImageFor = (roomId, name, hit) => importRoomImage(room(roomId), roomId, name, hit);

export async function importRef(r, roomId, b) {
  const id = await importRoomImage(r, roomId, str(b.name, 255, 'name'));
  return setRef(r, { asset_id: id, ...(b.slot !== undefined && { slot: b.slot }) });
}
/* a room image's Library id, importing it once; `hit` = its room asset row when already listed */
async function importRoomImage(r, roomId, name, hit) {
  hit ??= (await listRoomAssets(roomId)).find((a) => a.name === name);
  if (!hit) throw new AppError(404, `no asset "${name}" in this room`);
  if (!RASTER.test(hit.type || '')) throw new AppError(400, `"${name}" is not a PNG, JPEG or WebP image (${hit.type})`);
  let id = outputId(r, name) ?? r.imports[importKey(hit)];
  if (!id) {
    const e = engine();
    const raw = await fetch(e.url + hit.raw, { headers: e.headers, signal: AbortSignal.timeout(30000) });
    if (!raw.ok) throw new AppError(502, `room asset bytes → HTTP ${raw.status}`);
    const bytes = Buffer.from(await raw.arrayBuffer());
    if (!magicOk(bytes)) throw new AppError(400, `"${name}" is not really a PNG, JPEG or WebP image`);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: hit.type }), name);
    const up = await fetch(`${readConfig().libraryUrl}/assets/upload?dedupe=1`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
    const j = await up.json().catch(() => null);
    if (!up.ok || !j?.asset?.id) throw new AppError(502, `Library upload → HTTP ${up.status}${j?.error ? `: ${j.error}` : ''}`);
    id = j.asset.id;
    r.imports[importKey(hit)] = id;
    if (!r.assets.includes(id)) r.assets.push(id);
  }
  return id;
}

export function _reset() {
  store = null;
}
