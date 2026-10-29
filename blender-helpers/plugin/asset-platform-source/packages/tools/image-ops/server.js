// image-ops — the shared "image ops" kit: deterministic edits over Library images.
//
//   POST ${BASE}/api/<op>  { asset_id, ...params, label?, origin? }
//     → a NEW transient Library image (the source is never modified), parent_id = asset_id,
//       derived_op = { tool:'image-ops', op, params } with params = the EFFECTIVE params
//       (defaults filled in), so any output can be replayed exactly.
//     ← { ok, asset, op, params }  ·  400 bad params / non-image · 404 unknown asset
//   GET  ${BASE}/api/ops   → the machine-readable catalogue agents read (built from OPS below,
//                            so it cannot drift from what the validator enforces).
//
// Raster ops run in sharp/libvips (async, off the event loop). Per-pixel maths (levels, edges,
// height/normal/AO, seamless …) and tracing (potrace + a k-means quantiser) are CPU-bound pure
// JS → pixel_worker.js / trace_worker.js in worker_threads; vtracer and rembg are Python →
// vtracer_svg.py / remove_bg.py in child processes. All sit behind small concurrency limits +
// timeouts.
//
// The gateway loads this into ONE process shared with every tool — a bad import here 404s ALL
// tools. So: only node built-ins + express at top level; sharp and svgo load lazily.
import express from 'express';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { access, mkdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';

export const BASE = '/asset-management/tools/image-ops';
const LIBRARY = (process.env.IMAGE_OPS_LIBRARY_URL || 'http://127.0.0.1:8260/asset-management/library/api').replace(/\/$/, '');
// Staging on the library's own drive; the Library copies the file in on POST /assets.
const WORK_BASE = process.env.IMAGE_OPS_WORK || (process.env.HOME || '.') + '/asset-library-data/scratch/.image-ops';
const PYTHON = process.env.IMAGE_OPS_PYTHON || 'python3';
const VTRACER_SCRIPT = fileURLToPath(new URL('./vtracer_svg.py', import.meta.url));
const REMOVE_BG_SCRIPT = fileURLToPath(new URL('./remove_bg.py', import.meta.url));
const TRACE_WORKER = new URL('./trace_worker.js', import.meta.url);
const PIXEL_WORKER = new URL('./pixel_worker.js', import.meta.url);
// rembg models (onnx) — rembg reads U2NET_HOME; files land at models/<name>/<name>.onnx.
const MODEL_DIR = process.env.IMAGE_OPS_MODEL_DIR || (process.env.HOME || '.') + '/asset-management/image-ops-models';
const MODELS = ['birefnet-general', 'birefnet-general-lite', 'isnet-general-use', 'u2net'];
const SEGMENT_TIMEOUT_MS = Number(process.env.IMAGE_OPS_SEGMENT_TIMEOUT_MS) || 300_000;
const MAX_SVG_BYTES = Number(process.env.IMAGE_OPS_MAX_SVG_BYTES) || 2 * 1024 * 1024;
const MAX_DIM = 8192;                          // largest output side a raster op may produce
const MAX_INPUT_PIXELS = 8192 * 8192;
const FACE_SCRIPT = fileURLToPath(new URL('./face_match.py', import.meta.url));
const FACE_MODEL = 'buffalo_l';                // InsightFace SCRFD (det_10g) + ArcFace (w600k_r50) — weights are NON-COMMERCIAL research only
const FACE_FILES = ['det_10g.onnx', 'w600k_r50.onnx'];
const FACE_TIMEOUT_MS = Number(process.env.IMAGE_OPS_FACE_TIMEOUT_MS) || 120_000;
const MAX_FACE_CANDIDATES = 16;
// cosine similarity of two ArcFace embeddings: the usual "same person" threshold is ~0.3 (InsightFace quotes 0.28–0.35 for this model)
const FACE_THRESHOLDS = { same_person: 0.30, strong_match: 0.50, uncertain_from: 0.20 };
const TRACE_TIMEOUT_MS = Number(process.env.IMAGE_OPS_TRACE_TIMEOUT_MS) || 120_000;
const MAX_CONCURRENT_TRACES = 2;               // the server has 8 threads and a gateway to keep alive
const MAX_CONCURRENT_SEGMENTS = 1;             // rembg is multi-threaded itself (IMAGE_OPS_ORT_THREADS, default 4) and ~2-4 GB RSS
const VTRACER_HINT = `create the venv: python3 -m venv <venv> && `
  + `<venv>/bin/pip install -r ${path.join(path.dirname(VTRACER_SCRIPT), 'requirements.txt')} `
  + `(or set IMAGE_OPS_PYTHON). methods 'mono' and 'layers' need no Python.`;
const fetchCmd = (models) => `U2NET_HOME=${MODEL_DIR} ${PYTHON} ${REMOVE_BG_SCRIPT} --fetch ${models.join(' ')}`;
const faceFetchCmd = () => `IMAGE_OPS_MODEL_DIR=${MODEL_DIR} ${PYTHON} ${FACE_SCRIPT} --fetch`;
const REMBG_HINT = `install into the image-ops venv: ${PYTHON.replace(/python3?$/, 'pip')} install -r `
  + `${path.join(path.dirname(REMOVE_BG_SCRIPT), 'requirements.txt')}, then pre-download the models: ${fetchCmd(MODELS)}`;

let sharpMod;
const getSharp = async () => (sharpMod ??= (await import('sharp')).default);

class HttpError extends Error {
  constructor(status, message, hint) { super(message); this.status = status; this.hint = hint; }
}
const bad = (msg, hint) => new HttpError(400, msg, hint);

// ── Param specs: ONE source for validation and the catalogue ────────────────────────────
const int = (min, max, o = {}) => ({ type: 'integer', min, max, ...o });
const num = (min, max, o = {}) => ({ type: 'number', min, max, ...o });
const bool = (o = {}) => ({ type: 'boolean', ...o });
const oneOf = (values, o = {}) => ({ type: 'string', enum: values, ...o });
const color = (o = {}) => ({ type: 'color', ...o });   // '#rgb' '#rrggbb' '#rrggbbaa' (+ 'transparent'/'currentColor' when allowed)
const obj = (fields, o = {}) => ({ type: 'object', fields, ...o });
const steps = (ops, o = {}) => ({ type: 'steps', ops, max: 8, ...o });   // ordered [{ op, ...that op's params }]
const POINT = obj({ x: num(0, 1, { required: true }), y: num(0, 1, { required: true }) }, { required: true });
const points = (o = {}) => ({ type: 'points', max: 64, ...o });   // [{x,y}] normalized 0..1 of the image
const COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const BG = (doc = 'fill for uncovered canvas') => color({ default: 'transparent', transparent: true, doc });
const REGION = (doc) => obj({ x: int(0, 65535, { required: true }), y: int(0, 65535, { required: true }),
  w: int(1, 65535, { required: true }), h: int(1, 65535, { required: true }) }, { doc });

function checkValue(name, s, v) {
  if (v === undefined || v === null) {
    if (s.required) throw bad(`${name} is required`);
    return s.default;
  }
  const range = () => {
    if ((s.min != null && v < s.min) || (s.max != null && v > s.max)) throw bad(`${name} must be in ${s.min}..${s.max} (got ${v})`);
  };
  switch (s.type) {
    case 'integer': if (!Number.isInteger(v)) throw bad(`${name} must be an integer`); range(); return v;
    case 'number': if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`${name} must be a number`); range(); return v;
    case 'boolean': if (typeof v !== 'boolean') throw bad(`${name} must be true or false`); return v;
    case 'string': if (!s.enum.includes(v)) throw bad(`${name} must be one of ${s.enum.map(e => `'${e}'`).join(', ')}`); return v;
    case 'color':
      if (typeof v === 'string' && (COLOR_RE.test(v) || (s.transparent && v === 'transparent') || (s.currentColor && v === 'currentColor'))) return v;
      throw bad(`${name} must be a hex colour like '#ffffff'${s.transparent ? " or 'transparent'" : ''}${s.currentColor ? " or 'currentColor'" : ''}`);
    case 'object':
      if (typeof v !== 'object' || Array.isArray(v)) throw bad(`${name} must be an object {${Object.keys(s.fields).join(',')}}`);
      return validate(s.fields, v, `${name}.`);
    case 'steps':
      if (!Array.isArray(v) || v.length > s.max) throw bad(`${name} must be an array of at most ${s.max} steps { op, ...params }`);
      return v.map((st, i) => {
        if (!st || typeof st !== 'object' || !s.ops.includes(st.op)) throw bad(`${name}[${i}].op must be one of ${s.ops.map(e => `'${e}'`).join(', ')}`);
        const { op, ...rest } = st;
        return { op, ...opParams(op, rest, `${name}[${i}].`) };
      });
    case 'points':
      if (!Array.isArray(v) || !v.length || v.length > s.max) throw bad(`${name} must be an array of 1..${s.max} points {x,y} (0..1)`);
      return v.map((pt, i) => checkValue(`${name}[${i}]`, POINT, pt));
  }
}

// An op's params: validated against its spec, then its resolve() hook (cross-field defaults/checks).
function opParams(name, input, prefix = '') {
  const p = validate(OPS[name].params, input, prefix);
  OPS[name].resolve?.(p, prefix);
  return p;
}

function validate(fields, input, prefix = '') {
  for (const k of Object.keys(input)) {
    if (!(k in fields)) throw bad(`unknown param '${prefix}${k}' — allowed: ${Object.keys(fields).map(f => prefix + f).join(', ') || '(none)'}`);
  }
  const out = {};
  for (const [k, s] of Object.entries(fields)) {
    const v = checkValue(prefix + k, s, input[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function catalogueParams(fields) {
  return Object.fromEntries(Object.entries(fields).map(([k, s]) => {
    const { fields: sub, transparent, currentColor, ...rest } = s;
    const c = { ...rest };
    if (s.type === 'color') c.format = ['#rrggbb', transparent && 'transparent', currentColor && 'currentColor'].filter(Boolean).join(' | ');
    if (s.type === 'steps') Object.assign(c, { type: 'array', items: '{ op, ...params } — each op validated with its own params (see that op)' });
    if (s.type === 'points') Object.assign(c, { type: 'array', items: '{ x, y } normalized 0..1 of the image (0,0 = top-left)' });
    if (sub) c.fields = catalogueParams(sub);
    return [k, c];
  }));
}

// ── Raster helpers ────────────────────────────────────────────────────────────────────
// Every op works on the source decoded ONCE to upright RGBA (EXIF orientation applied), so pixel
// coordinates are the ones a user sees.
async function decode(buf) {
  const sharp = await getSharp();
  try {
    const { data, info } = await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS }).autoOrient()
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, info: { width: info.width, height: info.height, channels: 4 } };
  } catch (e) { throw bad(`source image could not be decoded: ${e.message}`); }
}
const raw = async (img) => (await getSharp())(img.data, { raw: img.info });
const rawOf = async (data, width, height, channels = 4) => (await getSharp())(data, { raw: { width, height, channels } });
const paint = (c) => (c === 'transparent' ? { r: 0, g: 0, b: 0, alpha: 0 } : c);
function rgba(c) {       // hex / 'transparent' → [r,g,b,a] 0..255
  if (c === 'transparent') return [0, 0, 0, 0];
  let h = c.slice(1);
  if (h.length <= 4) h = [...h].map(x => x + x).join('');
  if (h.length === 6) h += 'ff';
  return [0, 2, 4, 6].map(i => parseInt(h.slice(i, i + 2), 16));
}
const png = async (s) => ({ bytes: await s.png().toBuffer(), ext: 'png' });
// 1-channel mask: 255 where alpha ≥ 128. sharp gotchas: ops run in a FIXED order (threshold
// before extractChannel), not call order — hence two pipelines; and a 1-channel raw pipeline
// comes out as 3-band sRGB unless it ends in extractChannel(0).
async function opaqueMask(img) {
  const { width: W, height: H } = img.info;
  const a = await (await raw(img)).extractChannel(3).raw().toBuffer();
  return (await rawOf(a, W, H, 1)).threshold(128, { grayscale: false }).extractChannel(0).raw().toBuffer();
}
// Fraction of pixels that are mostly transparent (alpha < 128). ≥ 1% = "meaningful alpha".
// (stats() reads the pipeline INPUT, so the mask is materialised first.)
async function transparentFraction(img) {
  const s = await (await rawOf(await opaqueMask(img), img.info.width, img.info.height, 1)).stats();
  return 1 - s.channels[0].mean / 255;
}
function inBounds(r, img, what) {
  const { width: W, height: H } = img.info;
  if (r.x + r.w > W || r.y + r.h > H) throw bad(`${what} {x:${r.x},y:${r.y},w:${r.w},h:${r.h}} exceeds the ${W}×${H} image`);
}
// img → img ops (the prep/texture ops) return the same { data, info } shape decode() does.
async function fromSharp(s) {
  const { data, info } = await s.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, info: { width: info.width, height: info.height, channels: 4 } };
}
// A sharp step on the RGB only, alpha re-attached untouched (clahe/sharpen would treat it as colour).
async function rgbOnly(img, fn) {
  const { width: W, height: H } = img.info;
  const rgb = await (await raw(img)).removeAlpha().raw().toBuffer();
  const out = await fn(await rawOf(rgb, W, H, 3)).toColourspace('srgb').removeAlpha().raw().toBuffer();
  const a = await (await raw(img)).extractChannel(3).raw().toBuffer();
  return { data: await (await rawOf(out, W, H, 3)).joinChannel(a, { raw: { width: W, height: H, channels: 1 } }).raw().toBuffer(), info: img.info };
}
async function encode(r, grey) {       // img → PNG result; grey = 1-channel (height/AO/edge maps)
  let s = await raw(r);
  if (grey) s = s.removeAlpha().toColourspace('b-w');
  return { bytes: await s.png().toBuffer(), ext: 'png', ...(r.meta && { meta: r.meta }) };
}

// ── SVG helpers ───────────────────────────────────────────────────────────────────────
function limiter(max) {
  let active = 0;
  const waiting = [];
  return async (fn) => {
    while (active >= max) await new Promise(r => waiting.push(r));
    active++;
    try { return await fn(); } finally { active--; waiting.shift()?.(); }
  };
}
const limited = limiter(MAX_CONCURRENT_TRACES);       // traces + pixel workers (never nested)
const segmentLimited = limiter(MAX_CONCURRENT_SEGMENTS);
const faceLimited = limiter(1);                       // two onnx sessions, a few seconds; its own slot so it never waits behind a 50 s remove_bg

function inWorker(url, workerData, what, hint, transfer) {
  return limited(() => new Promise((resolve, reject) => {
    const w = new Worker(url, { workerData, transferList: transfer, resourceLimits: { maxOldGenerationSizeMb: 768 } });
    const t = setTimeout(() => {
      w.terminate();
      reject(new HttpError(504, `${what} timed out after ${TRACE_TIMEOUT_MS / 1000}s`, hint));
    }, TRACE_TIMEOUT_MS);
    w.once('message', (m) => { clearTimeout(t); resolve(m); });
    w.once('error', (e) => { clearTimeout(t); reject(new Error(`${what} failed: ${e.message}`)); });
    w.once('exit', (code) => { clearTimeout(t); if (code) reject(new Error(`${what} worker exited ${code}`)); });
  }));
}
const traceInWorker = (workerData) => inWorker(TRACE_WORKER, workerData, 'trace', 'lower traceSize or colors');

// Per-pixel op in pixel_worker.js → { data, info, meta? } (RGBA, like decode()).
async function pixels(fn, img, params) {
  const data = new Uint8Array(img.data);               // own buffer → transferable, source untouched
  const m = await inWorker(PIXEL_WORKER, { fn, data, width: img.info.width, height: img.info.height, params },
    fn, 'resize the image down first', [data.buffer]);
  return { data: Buffer.from(m.data.buffer, m.data.byteOffset, m.data.byteLength),
    info: { width: m.width, height: m.height, channels: 4 }, meta: m.meta };
}

async function pythonAvailable() {
  try { await access(PYTHON); return true; } catch { return false; }
}

async function runVtracer(inPng, outSvg, p) {
  if (!(await pythonAvailable())) throw new HttpError(503, 'vtracer not installed', VTRACER_HINT);
  const keys = ['colormode', 'hierarchical', 'mode', 'filter_speckle', 'color_precision', 'layer_difference',
    'corner_threshold', 'length_threshold', 'max_iterations', 'splice_threshold', 'path_precision'];
  const args = JSON.stringify(Object.fromEntries(keys.map(k => [k, p[k]])));
  await limited(() => new Promise((resolve, reject) => {
    execFile(PYTHON, [VTRACER_SCRIPT, inPng, outSvg, args], { timeout: TRACE_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, _out, stderr) => {
      if (!err) return resolve();
      if (err.code === 3) return reject(new HttpError(503, 'vtracer not installed', VTRACER_HINT));
      if (err.killed) return reject(new HttpError(504, `vtracer timed out after ${TRACE_TIMEOUT_MS / 1000}s`, 'lower traceSize or raise filter_speckle'));
      reject(new Error(`vtracer failed: ${String(stderr).trim().slice(-400) || err.message}`));
    });
  }));
  return readFile(outSvg, 'utf8');
}

// ── Background removal (rembg in a child process) ─────────────────────────────────────
const modelFiles = (m) => [path.join(MODEL_DIR, 'models', m, `${m}.onnx`), path.join(MODEL_DIR, `${m}.onnx`)];
async function modelsDownloaded() {
  const has = (f) => access(f).then(() => true, () => false);
  return Object.fromEntries(await Promise.all(MODELS.map(async m => [m, (await Promise.all(modelFiles(m).map(has))).some(Boolean)])));
}

async function removeBg(img, p) {
  if (!(await pythonAvailable())) throw new HttpError(503, 'rembg not installed', REMBG_HINT);
  await mkdir(WORK_BASE, { recursive: true });
  const id = randomUUID();
  const inPng = path.join(WORK_BASE, `${id}.bg-in.png`), outPng = path.join(WORK_BASE, `${id}.bg-out.png`);
  try {
    await (await raw(img)).png({ compressionLevel: 1 }).toFile(inPng);
    const stdout = await segmentLimited(() => new Promise((resolve, reject) => {
      execFile(PYTHON, [REMOVE_BG_SCRIPT, inPng, outPng, JSON.stringify(p)],
        { timeout: SEGMENT_TIMEOUT_MS, maxBuffer: 1 << 20, env: { ...process.env, U2NET_HOME: MODEL_DIR } }, (err, out, stderr) => {
          if (!err) return resolve(out);
          if (err.code === 3) return reject(new HttpError(503, 'rembg not installed', REMBG_HINT));
          if (err.code === 4) return reject(new HttpError(503, `model '${p.model}' not downloaded`, `pre-download it: ${fetchCmd([p.model])}`));
          if (err.killed) return reject(new HttpError(504, `remove_bg timed out after ${SEGMENT_TIMEOUT_MS / 1000}s`, "try model 'birefnet-general-lite' or a lower max_side"));
          reject(new Error(`remove_bg failed: ${String(stderr).trim().slice(-400) || err.message}`));
        });
    }));
    let stats = {};
    try { stats = JSON.parse(stdout.trim().split('\n').pop()); } catch { /* stats are informational */ }
    return { bytes: await readFile(outPng), ext: 'png', meta: { model: p.model, ...stats } };
  } finally { await Promise.all([rm(inPng, { force: true }), rm(outPng, { force: true })]); }
}


// ── Face match (analysis only: scores, no new image) ─────────────────────────────────────
const faceModelsPresent = () => Promise.all(FACE_FILES.map(f => access(path.join(MODEL_DIR, 'insightface', FACE_MODEL, f)).then(() => true, () => false)))
  .then(a => a.every(Boolean));

export const verdictOf = (score) => (score == null ? 'no face'
  : score >= FACE_THRESHOLDS.strong_match ? 'strong match'
  : score >= FACE_THRESHOLDS.same_person ? 'same person'
  : score >= FACE_THRESHOLDS.uncertain_from ? 'uncertain' : 'different person');

const FACE_PARAMS = {
  candidates: { type: 'array', required: true, items: 'Library image ids, 1..16 — the images to score against the source', doc: `1–${MAX_FACE_CANDIDATES} candidate image ids` },
  face_index: int(0, 63, { default: 0, doc: 'which face of the SOURCE to use when it shows several: faces are numbered largest first, 0 = the biggest' }),
  det_size: int(320, 1280, { default: 640, doc: 'face detector input size (px): raise to 960–1280 to find small faces in a big group shot (slower)' }),
  det_thresh: num(0.2, 0.9, { default: 0.5, doc: 'face detection confidence cut-off' }),
  record: bool({ default: true, doc: "write each result to the candidate's meta.identity {source_id, score, verdict, model, at, face_index, box, det_score}" }),
};

function faceParams(input) {
  const { candidates, ...rest } = input;
  if (!Array.isArray(candidates) || !candidates.length || candidates.length > MAX_FACE_CANDIDATES
    || candidates.some(c => typeof c !== 'string' || !c)) {
    throw bad(`candidates must be an array of 1..${MAX_FACE_CANDIDATES} Library image ids`);
  }
  const { candidates: _c, ...fields } = FACE_PARAMS;
  return { candidates: [...new Set(candidates)], ...validate(fields, rest) };
}

async function faceMatch(asset_id, p) {
  // off until the op runs under a memory cap (a model call can use enough memory to starve other services)
  if (process.env.IMAGE_OPS_FACE_MATCH !== '1') throw new HttpError(503, 'face_match is switched off until it runs under a memory cap', 'set IMAGE_OPS_FACE_MATCH=1 to enable it');
  if (!(await pythonAvailable())) throw new HttpError(503, 'face_match needs the image-ops python venv', REMBG_HINT);
  if (!(await faceModelsPresent())) {
    throw new HttpError(503, `face models '${FACE_MODEL}' not downloaded`, `pre-download them (about 290 MB): ${faceFetchCmd()}`);
  }
  await mkdir(WORK_BASE, { recursive: true });
  const id = randomUUID();
  const files = [];
  const stage = async (aid, tag) => {   // the Library file → an upright, size-capped PNG (EXIF orientation applied)
    const { buf } = await getSource(aid);
    const sharp = await getSharp();
    const f = path.join(WORK_BASE, `${id}.face-${tag}.png`);
    files.push(f);
    await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().resize(4096, 4096, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).png({ compressionLevel: 1 }).toFile(f);
    return f;
  };
  try {
    const source = await stage(asset_id, 'src');
    const cands = [];
    for (const [i, cid] of p.candidates.entries()) cands.push({ id: cid, path: await stage(cid, `c${i}`) });
    const req = { source, candidates: cands, face_index: p.face_index, det_size: p.det_size, det_thresh: p.det_thresh };
    const stdout = await faceLimited(() => new Promise((resolve, reject) => {
      execFile(PYTHON, [FACE_SCRIPT, JSON.stringify(req)],
        { timeout: FACE_TIMEOUT_MS, maxBuffer: 4 << 20, env: { ...process.env, IMAGE_OPS_MODEL_DIR: MODEL_DIR } }, (err, out, stderr) => {
          if (!err) return resolve(out);
          if (err.code === 3) return reject(new HttpError(503, 'face_match python dependencies missing (numpy, onnxruntime, pillow)', REMBG_HINT));
          if (err.code === 4) return reject(new HttpError(503, `face models '${FACE_MODEL}' not downloaded`, `pre-download them: ${faceFetchCmd()}`));
          if (err.killed) return reject(new HttpError(504, `face_match timed out after ${FACE_TIMEOUT_MS / 1000}s`, 'fewer candidates or a lower det_size'));
          reject(new Error(`face_match failed: ${String(stderr).trim().slice(-400) || err.message}`));
        });
    }));
    const r = JSON.parse(stdout.trim().split('\n').pop());
    if (r.source.error) throw new HttpError(422, r.source.error, 'pass another face_index, or a source image whose face is clear and large enough');
    const at = new Date().toISOString();
    const results = r.candidates.map(c => ({ ...c, verdict: verdictOf(c.score) }));
    if (p.record) {
      await Promise.all(results.map(async (c) => {
        const identity = { source_id: asset_id, score: c.score, verdict: c.verdict, model: FACE_MODEL, at,
          ...(c.score != null && { face_index: c.face_index, box: c.box, det_score: c.det_score }) };
        try {
          const pr = await libFetch(`/assets/${encodeURIComponent(c.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meta: { identity } }) });
          c.recorded = pr.ok;
        } catch { c.recorded = false; }
      }));
    }
    const ranked = results.filter(c => c.score != null).sort((a, b) => b.score - a.score);
    return { source: { id: asset_id, ...r.source }, model: FACE_MODEL, thresholds: FACE_THRESHOLDS, results, best: ranked[0]?.id ?? null,
      ranking: ranked.map(c => c.id), timing: r.timing };
  } finally { await Promise.all(files.map(f => rm(f, { force: true }))); }
}

const FACE_OP = {
  name: 'face_match',
  purpose: 'ANALYSIS, no new image: score how much the face in each candidate looks like the face in the source (ArcFace cosine similarity, InsightFace buffalo_l on the server CPU). '
    + 'Use it to rank generated images against a source photo (generate ~5, take the highest). 0.30+ is the usual same-person threshold, 0.50+ a strong match, under 0.20 a different person. '
    + "Each result is also written to the candidate's meta.identity. "
    + 'LICENCE: the InsightFace pretrained weights are NON-COMMERCIAL research use only — fine for personal use; do not ship them in a commercial product (facenet-pytorch / VGGFace2 is the MIT alternative).',
  request: `POST ${BASE}/api/face_match  JSON { asset_id (the source), candidates: [ids], face_index?, det_size?, det_thresh?, record? }`,
  returns: '{ ok, source:{id, faces, face_index, box}, model, thresholds, results:[{id, score, verdict, faces, face_index, box, det_score, all_scores, recorded}], best, ranking }  — score null + verdict "no face" when no face is found; with several faces in a candidate the best-matching one counts',
  analysis: true,
  params: catalogueParams(FACE_PARAMS),
};

function potraceSvg(w, h, layers, p) {
  const paths = layers.map(l => (p.style === 'outline'
    ? `<path d="${l.d}" fill="none" stroke="${l.color}" stroke-width="${p.strokeWidth}" stroke-linejoin="round"/>`
    : `<path d="${l.d}" fill="${l.color}" fill-rule="evenodd"/>`));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${paths.join('')}</svg>`;
}

// SVGO (keeps viewBox, drops width/height) then normalise: xmlns + viewBox guaranteed,
// optionally every paint → currentColor so the icon takes the CSS text colour.
async function finishSvg(svg, p) {
  const { optimize } = await import('svgo');
  let out = optimize(svg, { multipass: true, floatPrecision: p.floatPrecision,
    plugins: ['preset-default', 'removeDimensions'] }).data;
  if (!/<svg[^>]*\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(out)) out = out.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  const vb = /<svg[^>]*\sviewBox="([^"]+)"/.exec(out);
  if (!vb) throw new Error('traced SVG has no viewBox');
  if (p.currentColor) {
    out = out.replace(/\b(fill|stroke)="(?!none")[^"]*"/g, '$1="currentColor"')
      .replace(/\b(fill|stroke):(?!none\b)[^;"]+/g, '$1:currentColor');
  }
  const bytes = Buffer.byteLength(out);
  if (bytes > MAX_SVG_BYTES) {
    throw new HttpError(422, `SVG too large (${(bytes / 1048576).toFixed(1)} MB > ${(MAX_SVG_BYTES / 1048576).toFixed(1)} MB)`,
      'raise turdSize / filter_speckle, lower colors / color_precision / traceSize, or lower floatPrecision');
  }
  const [, , vw, vh] = vb[1].split(/[\s,]+/).map(Number);
  return { svg: out, width: Math.round(vw), height: Math.round(vh), bytes };
}

// ── The ops ───────────────────────────────────────────────────────────────────────────
const HEIGHT_SOURCE = oneOf(['image', 'height'], { default: 'image', doc: "'image' = derive height first (luminance, blur 1, auto contrast); 'height' = the input already is a height map (luminance as is)" });
const WRAP = bool({ default: false, doc: 'sample across the edges as if tiled — use on seamless textures so the output tiles too' });
const POTRACE = {
  turdSize: int(0, 1000, { default: 2, doc: 'suppress speckles up to this many pixels (at traceSize)' }),
  alphaMax: num(0, 1.34, { default: 1, doc: 'corner threshold: 0 = all corners (polygonal), 1.34 = no corners (smooth)' }),
  optCurve: bool({ default: true, doc: 'join adjacent Bézier segments' }),
  optTolerance: num(0, 5, { default: 0.2, doc: 'curve-joining tolerance (higher = fewer, looser curves)' }),
  style: oneOf(['fill', 'outline'], { default: 'fill', doc: "'outline' = the same paths with fill none and a stroke" }),
  strokeWidth: num(0.1, 50, { default: 2, doc: "stroke width for style 'outline', in viewBox (traceSize) units" }),
};
// Raster ops that can run in memory before a trace (to_svg `prep`), in the order given.
const PREP_OPS = ['remove_bg', 'levels', 'local_contrast', 'sharpen', 'edges', 'posterize', 'blur'];
const SVG_COMMON = {
  floatPrecision: int(0, 6, { default: 2, doc: 'SVGO decimal places for coordinates' }),
  prep: steps(PREP_OPS, { doc: "raster steps applied in order (full size, in memory) before tracing — each { op, ...that op's params }, "
    + "e.g. [{op:'remove_bg'},{op:'local_contrast',strength:3},{op:'sharpen'}]; recorded with defaults filled" }),
};
const SVG_METHODS = {
  mono: {
    purpose: 'one-colour trace with potrace — icons, logos, line art',
    params: {
      traceSize: int(64, 2048, { default: 512, doc: 'long side the image is scaled to before tracing' }),
      threshold: int(0, 255, { default: 128, doc: 'luminance: pixels darker than this are traced; alpha channel: pixels with alpha ≥ this' }),
      invert: bool({ default: false, doc: 'trace the light pixels instead of the dark ones' }),
      channel: oneOf(['auto', 'luminance', 'alpha'], { default: 'auto', doc: "what to threshold: 'auto' = alpha when ≥1% of pixels are transparent, else luminance (composited on white)" }),
      color: color({ default: 'currentColor', currentColor: true, doc: 'path fill (or stroke in outline style)' }),
      ...POTRACE,
      ...SVG_COMMON,
      currentColor: bool({ doc: 'rewrite every paint to currentColor (default true; false when an explicit color is given)' }),
    },
  },
  layers: {
    purpose: 'multicolour trace in pure JS — quantise to N colours (k-means), potrace each colour, stack bottom→top',
    params: {
      traceSize: int(64, 2048, { default: 512, doc: 'long side the image is scaled to before tracing' }),
      colors: int(2, 16, { default: 4, doc: 'number of colours to quantise to (including the background)' }),
      dropBackground: bool({ default: true, doc: 'omit the background colour (what the border mostly is) — transparent pixels are always omitted' }),
      ...POTRACE,
      ...SVG_COMMON,
      currentColor: bool({ default: false, doc: 'rewrite every paint to currentColor' }),
    },
  },
  vtracer: {
    purpose: 'multicolour trace with vtracer (Python, higher quality) — photos, painted art, gradients',
    params: {
      traceSize: int(64, 4096, { default: 1024, doc: 'long side the image is scaled to before tracing' }),
      colormode: oneOf(['color', 'binary'], { default: 'color' }),
      hierarchical: oneOf(['stacked', 'cutout'], { default: 'stacked', doc: 'stacked = shapes overlap; cutout = shapes are disjoint' }),
      mode: oneOf(['spline', 'polygon', 'none'], { default: 'spline', doc: 'curve fitting' }),
      filter_speckle: int(0, 128, { default: 4, doc: 'discard patches smaller than this (px)' }),
      color_precision: int(1, 8, { default: 6, doc: 'significant bits per RGB channel' }),
      layer_difference: int(0, 255, { default: 16, doc: 'colour difference between gradient layers' }),
      corner_threshold: int(0, 180, { default: 60, doc: 'minimum angle (degrees) to count as a corner' }),
      length_threshold: num(3.5, 10, { default: 4.0, doc: 'segment length for subdivision' }),
      max_iterations: int(1, 50, { default: 10 }),
      splice_threshold: int(0, 180, { default: 45, doc: 'minimum angle displacement (degrees) to splice a spline' }),
      path_precision: int(0, 8, { default: 3, doc: 'decimal places in vtracer path output' }),
      ...SVG_COMMON,
      currentColor: bool({ default: false, doc: 'rewrite every paint to currentColor' }),
    },
  },
};

async function runPrep(img, list) {
  for (const { op, ...q } of list) img = await OPS[op].apply(img, q);
  return img;
}

async function traceRaster(img, traceSize) {
  const { data, info } = await (await raw(img))
    .resize({ width: traceSize, height: traceSize, fit: 'inside' })
    .raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const OPS = {
  crop: {
    purpose: 'cut out a rectangle given in source pixels',
    params: { x: int(0, 65535, { required: true, doc: 'left edge (px)' }), y: int(0, 65535, { required: true, doc: 'top edge (px)' }),
      w: int(1, 65535, { required: true, doc: 'width (px)' }), h: int(1, 65535, { required: true, doc: 'height (px)' }) },
    async run(img, p) {
      inBounds(p, img, 'crop box');
      return png((await raw(img)).extract({ left: p.x, top: p.y, width: p.w, height: p.h }));
    },
  },
  trim: {
    purpose: "cut away a uniform border (the top-left pixel's colour, e.g. white or transparent), then optionally pad back",
    params: { threshold: int(0, 255, { default: 10, doc: 'how different from the border colour a pixel must be to count as content' }),
      pad: int(0, 4096, { default: 0, doc: 'px of the border colour to add back on every side' }) },
    async run(img, p) {
      let t;
      try { t = await (await raw(img)).trim({ threshold: p.threshold }).raw().toBuffer({ resolveWithObject: true }); }
      catch (e) { throw bad(`nothing to trim: ${e.message}`); }
      const border = [...img.data.subarray(0, 4)];
      return png((await rawOf(t.data, t.info.width, t.info.height, t.info.channels))
        .extend({ top: p.pad, bottom: p.pad, left: p.pad, right: p.pad,
          background: { r: border[0], g: border[1], b: border[2], alpha: border[3] / 255 } }));
    },
  },
  flip: {
    purpose: 'mirror the whole image, or only a region (flipped in place)',
    params: { axis: oneOf(['h', 'v'], { required: true, doc: "'h' = left↔right mirror, 'v' = top↔bottom" }),
      region: REGION('optional {x,y,w,h} in source pixels; omit to flip the whole image') },
    async run(img, p) {
      const mirror = (s) => (p.axis === 'h' ? s.flop() : s.flip());
      if (!p.region) return png(mirror(await raw(img)));
      const r = p.region;
      inBounds(r, img, 'region');
      const part = await mirror((await raw(img)).extract({ left: r.x, top: r.y, width: r.w, height: r.h })).png().toBuffer();
      // punch the region out (dest-out), then lay the flipped pixels into the hole — exact, alpha included
      const hole = { create: { width: r.w, height: r.h, channels: 4, background: '#000000' } };
      return png((await raw(img)).composite([{ input: hole, left: r.x, top: r.y, blend: 'dest-out' },
        { input: part, left: r.x, top: r.y }]));
    },
  },
  rotate: {
    purpose: 'rotate clockwise; non-right angles grow the canvas to fit',
    params: { deg: num(-360, 360, { required: true, doc: 'degrees clockwise (90/180/270 are lossless)' }),
      background: BG('fill for the corners exposed by a non-right angle') },
    async run(img, p) {
      return png((await raw(img)).rotate(p.deg, { background: paint(p.background) }));
    },
  },
  resize: {
    purpose: 'scale to a width and/or height',
    params: { width: int(1, MAX_DIM, { doc: 'target width (px); omit to follow the aspect ratio' }),
      height: int(1, MAX_DIM, { doc: 'target height (px); omit to follow the aspect ratio' }),
      fit: oneOf(['inside', 'contain', 'cover'], { default: 'inside', doc: "inside = fit within the box, keep aspect; contain = exactly the box, letterboxed with background; cover = exactly the box, cropped" }),
      background: BG('letterbox fill for fit contain') },
    async run(img, p) {
      if (!p.width && !p.height) throw bad('resize needs width and/or height');
      return png((await raw(img)).resize({ width: p.width, height: p.height, fit: p.fit, background: paint(p.background) }));
    },
  },
  pad: {
    purpose: 'grow the canvas around the centred image — to a square, or to width×height',
    params: { square: bool({ default: false, doc: 'pad the short side up to the long side' }),
      width: int(1, MAX_DIM, { doc: 'target canvas width (px, ≥ current); omit = current' }),
      height: int(1, MAX_DIM, { doc: 'target canvas height (px, ≥ current); omit = current' }),
      background: BG('canvas fill') },
    async run(img, p) {
      const { width: W, height: H } = img.info;
      if (p.square && (p.width || p.height)) throw bad('pad takes square:true OR width/height, not both');
      if (!p.square && !p.width && !p.height) throw bad('pad needs square:true or a width/height');
      const s = Math.max(W, H);
      const W2 = p.square ? s : (p.width ?? W), H2 = p.square ? s : (p.height ?? H);
      if (W2 < W || H2 < H) throw bad(`pad target ${W2}×${H2} is smaller than the ${W}×${H} image — use crop or resize to shrink`);
      if (W2 > MAX_DIM || H2 > MAX_DIM) throw bad(`pad target exceeds ${MAX_DIM}px`);
      const left = Math.floor((W2 - W) / 2), top = Math.floor((H2 - H) / 2);
      return png((await raw(img)).extend({ left, right: W2 - W - left, top, bottom: H2 - H - top, background: paint(p.background) }));
    },
  },
  threshold: {
    purpose: 'two-colour icon prep: dark pixels → fg, light → bg (flattened on white; transparent pixels stay transparent when the image has meaningful alpha)',
    params: { level: int(0, 255, { default: 128, doc: 'luminance cut: below = fg, at or above = bg' }),
      colors: obj({ fg: color({ default: '#000000', transparent: true }), bg: color({ default: '#ffffff', transparent: true }) },
        { default: { fg: '#000000', bg: '#ffffff' }, doc: 'the two output colours' }) },
    async run(img, p) {
      const { width: W, height: H } = img.info;
      const keepAlpha = (await transparentFraction(img)) >= 0.01;
      // 1-channel mask: 255 where light (→ bg), 0 where dark (→ fg)
      const mask = await (await raw(img)).flatten({ background: '#ffffff' }).greyscale().threshold(p.level).raw().toBuffer();
      const m1 = { raw: { width: W, height: H, channels: 1 } };
      const m4 = await (await rawOf(mask, W, H, 1)).joinChannel([mask, mask, mask], m1).raw().toBuffer();
      // per channel: out = fg + (bg − fg) · mask/255
      const fg = rgba(p.colors.fg), bg = rgba(p.colors.bg);
      let out = await (await rawOf(m4, W, H)).linear(bg.map((b, i) => (b - fg[i]) / 255), fg).raw().toBuffer();
      if (keepAlpha) {
        const alphaMask = await opaqueMask(img);
        // one step per pipeline: sharp runs ops in a FIXED order, not call order
        const outAlpha = await (await rawOf(out, W, H)).extractChannel(3).raw().toBuffer();
        const a = await (await rawOf(outAlpha, W, H, 1)).boolean(alphaMask, 'and', m1).extractChannel(0).raw().toBuffer();
        const rgb = await (await rawOf(out, W, H)).removeAlpha().raw().toBuffer();
        out = await (await rawOf(rgb, W, H, 3)).joinChannel(a, m1).raw().toBuffer();
      }
      return png(await rawOf(out, W, H));
    },
  },
  invert: {
    purpose: 'negate the colours (alpha kept)',
    params: {},
    async run(img) { return png((await raw(img)).negate({ alpha: false })); },
  },
  fill: {
    purpose: "magic wand + paint, headless: each seed point selects the pixels within `tolerance` of ITS colour — the connected region "
      + "around it (contiguous) or every such pixel in the image — and the union is filled with `color` (mode 'fill'), made transparent "
      + "(mode 'clear') or filled with the colour sampled at `color_from` (mode 'sample'). Always an RGBA PNG; meta.selected = pixels hit. "
      + "Recipes: make holes transparent = clear seeded on each hole; make lines black = fill #000000 seeded on each line; "
      + "fill an area with the background's colour = sample, color_from on the background; "
      + "clear the background around an object = clear seeded at the four corners [{x:0,y:0},{x:1,y:0},{x:0,y:1},{x:1,y:1}], contiguous true, grow 1–2 for the anti-aliased fringe",
    params: {
      points: points({ required: true, doc: 'seed points {x,y} normalized 0..1 (a review mark\'s position); each selects on its own, the regions are unioned' }),
      mode: oneOf(['fill', 'clear', 'sample'], { required: true, doc: "fill = paint `color`; clear = alpha → 0; sample = paint the colour at `color_from`" }),
      color: color({ doc: "mode 'fill' only: the paint, e.g. '#000000' or '#f4efe6' ('#rrggbbaa' for translucent)" }),
      color_from: obj({ x: num(0, 1, { required: true }), y: num(0, 1, { required: true }) }, { doc: "mode 'sample' only: {x,y} normalized — where to pick the paint (e.g. the background)" }),
      tolerance: int(0, 255, { default: 32, doc: 'max per-channel difference (RGBA, premultiplied) from the seed colour that still counts as the same colour' }),
      contiguous: bool({ default: true, doc: 'true = flood fill from the seed (4-connected); false = every pixel of that colour anywhere' }),
      grow: int(0, 64, { default: 0, doc: 'dilate the selection by this many px — covers anti-aliased fringes' }),
      feather: int(0, 64, { default: 0, doc: 'soft edge: the effect fades out over this many px beyond the (grown) selection' }),
    },
    resolve(p, pre = '') {
      if (p.mode === 'fill' && !p.color) throw bad(`${pre}mode 'fill' needs color`);
      if (p.mode === 'sample' && !p.color_from) throw bad(`${pre}mode 'sample' needs color_from {x,y}`);
      if ((p.color && p.mode !== 'fill') || (p.color_from && p.mode !== 'sample')) {
        throw bad(`${pre}color goes with mode 'fill' only, color_from with mode 'sample' only`);
      }
    },
    apply: (img, p) => pixels('fill', img, { ...p, rgba: p.color && rgba(p.color) }),
  },

  // ── prep: tone/detail ops (also usable as to_svg `prep` steps) ──
  levels: {
    purpose: 'levels: black/white points + gamma on RGB (alpha kept); auto = stretch the 0.5%/99.5% luminance percentiles of the opaque pixels',
    params: {
      auto: bool({ doc: 'auto black/white points (default true unless black/white are given); the points used are recorded in meta' }),
      black: int(0, 254, { doc: 'manual: input level that becomes 0 (default 0)' }),
      white: int(1, 255, { doc: 'manual: input level that becomes 255 (default 255)' }),
      gamma: num(0.1, 10, { default: 1, doc: '> 1 brightens the midtones, < 1 darkens them' }),
    },
    resolve(p, pre = '') {
      const manual = p.black !== undefined || p.white !== undefined;
      if (p.auto && manual) throw bad(`${pre}levels takes auto:true OR black/white, not both`);
      p.auto ??= !manual;
      if (!p.auto) {
        p.black ??= 0; p.white ??= 255;
        if (p.white <= p.black) throw bad(`${pre}white must be greater than black`);
      }
    },
    apply: (img, p) => pixels('levels', img, p),
  },
  local_contrast: {
    purpose: 'local contrast (CLAHE on lightness) — lifts faint, low-contrast lines and shading before a trace; alpha kept',
    params: {
      strength: num(0, 5, { default: 2, doc: 'contrast limit: 0 = off; sharp maxSlope = round(1 + 4·strength)' }),
      radius: int(4, 512, { default: 32, doc: 'half the side of the local window (px) — smaller = more local, stronger' }),
    },
    apply(img, p) {
      if (!p.strength) return img;
      const win = Math.min(2 * p.radius, img.info.width, img.info.height);
      return rgbOnly(img, s => s.clahe({ width: win, height: win, maxSlope: Math.round(1 + 4 * p.strength) }));
    },
  },
  sharpen: {
    purpose: 'unsharp-mask sharpen (sharp/libvips, on lightness); alpha kept',
    params: {
      sigma: num(0.3, 10, { default: 1.5, doc: 'radius of the blur the mask is built from' }),
      m1: num(0, 10, { default: 1, doc: 'sharpening applied to flat areas' }),
      m2: num(0, 20, { default: 2, doc: "sharpening applied to 'jagged' (detailed) areas" }),
      x1: num(0, 100, { default: 2, doc: 'threshold between flat and jagged' }),
      y2: num(0, 100, { default: 10, doc: 'maximum brightening' }),
      y3: num(0, 100, { default: 20, doc: 'maximum darkening' }),
    },
    apply: (img, p) => rgbOnly(img, s => s.sharpen(p)),
  },
  blur: {
    purpose: 'gaussian blur — denoise before a trace',
    params: { sigma: num(0.3, 100, { default: 1, doc: 'gaussian sigma (px)' }) },
    async apply(img, p) { return fromSharp((await raw(img)).blur(p.sigma)); },
  },
  posterize: {
    purpose: 'reduce each RGB channel to N evenly spaced levels (alpha kept)',
    params: { levels: int(2, 32, { default: 6, doc: 'levels per channel' }) },
    apply: (img, p) => pixels('posterize', img, p),
  },
  edges: {
    purpose: 'outline extraction (Sobel on luminance, composited on white) — line art for tracing; greyscale PNG',
    params: {
      method: oneOf(['sobel'], { default: 'sobel' }),
      strength: num(0.1, 20, { default: 2, doc: 'gain: at 1 a full black→white step is a solid line; raise it to catch faint lines' }),
      invert: bool({ default: true, doc: 'dark lines on white (what mono tracing wants); false = light lines on black' }),
      threshold: int(0, 255, { doc: 'optional: binarise — edge strength ≥ this becomes a solid line, the rest background' }),
    },
    grey: true,
    apply: (img, p) => pixels('edges', img, p),
  },
  remove_bg: {
    purpose: 'remove the background with a segmentation model (rembg + BiRefNet on the server CPU, one job at a time) — transparent PNG, a mask, or flattened on white',
    params: {
      model: oneOf(MODELS, { default: 'birefnet-general-lite', doc: 'birefnet-general-lite (default) = ~20 s on the server; birefnet-general = best edges but ~50 s, can exceed the 60 s web timeout; birefnet-general-lite = faster, slightly softer; isnet-general-use / u2net = older, fastest' }),
      output: oneOf(['rgba', 'mask', 'white'], { default: 'rgba', doc: 'rgba = transparent background; mask = white subject on black; white = subject flattened on white' }),
      post_process_mask: bool({ default: true, doc: 'clean the mask (morphological open + blur) — drops speckles' }),
      alpha_matting: bool({ default: false, doc: 'refine soft edges (hair, fur) with closed-form matting — slower' }),
      alpha_matting_foreground_threshold: int(0, 255, { default: 240, doc: 'mask values above this are sure foreground' }),
      alpha_matting_background_threshold: int(0, 255, { default: 10, doc: 'mask values below this are sure background' }),
      alpha_matting_erode_size: int(0, 64, { default: 10, doc: 'erode the sure regions by this (px) to widen the band matting decides' }),
      feather: num(0, 64, { default: 0, doc: 'gaussian blur of the final mask (px) — softens the cut edge' }),
      max_side: int(256, 4096, { default: 1536, doc: 'long side the image is scaled to for inference (bounds CPU); the mask is scaled back to full size' }),
    },
    run: (img, p) => removeBg(img, p),
    async apply(img, p) { return decode((await removeBg(img, p)).bytes); },
  },

  // ── game textures ──
  height: {
    purpose: 'grayscale height map from luminance (or one channel): optional invert, blur, auto contrast',
    params: {
      channel: oneOf(['luminance', 'r', 'g', 'b', 'a'], { default: 'luminance', doc: 'what becomes height (light = high)' }),
      invert: bool({ default: false, doc: 'dark = high instead' }),
      blur: num(0, 32, { default: 1, doc: 'gaussian sigma (px) — smooths noise so normals/AO are clean; 0 = none' }),
      contrast: oneOf(['auto', 'none'], { default: 'auto', doc: "auto = stretch the 0.5%/99.5% percentiles to full range" }),
      wrap: WRAP,
    },
    grey: true,
    apply: (img, p) => pixels('height', img, p),
  },
  normal: {
    purpose: 'tangent-space normal map (Sobel on height). OpenGL convention by default: +X right = red, +Y UP = green, flat = (128,128,255); flip_green for DirectX (+Y down)',
    params: {
      strength: num(0.01, 20, { default: 2, doc: 'bump depth: gradients are scaled by this before normalising' }),
      source: HEIGHT_SOURCE,
      flip_green: bool({ default: false, doc: 'false = OpenGL (Blender, Godot, Unity); true = DirectX (Unreal, Substance DX)' }),
      wrap: WRAP,
    },
    apply: (img, p) => pixels('normal', img, p),
  },
  ao: {
    purpose: 'ambient-occlusion / cavity approximation: darker where the height sits below its blurred neighbourhood; greyscale PNG',
    params: {
      radius: num(1, 128, { default: 8, doc: 'neighbourhood size (px); gaussian sigma = radius / 2' }),
      strength: num(0, 5, { default: 1, doc: 'darkening gain' }),
      source: HEIGHT_SOURCE,
      wrap: WRAP,
    },
    grey: true,
    apply: (img, p) => pixels('ao', img, p),
  },
  seamless: {
    purpose: 'make a texture tile: offset by half, then blend back over a band around the seams; preview:true also registers a 2×2 tiling (a second image, parent = the tile) returned as `preview`',
    params: {
      method: oneOf(['offset-blend'], { default: 'offset-blend' }),
      blend: num(0.01, 2048, { default: 64, doc: 'seam blend width: ≥ 1 = px, < 1 = fraction of the shorter side (capped just under half); px used in meta' }),
      preview: bool({ default: false, doc: "also register a 2×2 tiling of the tile (op 'tile', replayable)" }),
    },
    async run(img, p) {
      const { width: W, height: H } = img.info;
      if (W < 8 || H < 8) throw bad('seamless needs an image at least 8×8');
      if (p.preview && (2 * W > MAX_DIM || 2 * H > MAX_DIM)) throw bad(`preview would exceed ${MAX_DIM}px — resize to ≤ ${MAX_DIM / 2}px first or preview:false`);
      const tile = await pixels('seamless', img, p);
      const out = await encode(tile);
      if (p.preview) {
        const params = { x: 2, y: 2 };
        out.preview = { params, result: await encode(await OPS.tile.apply(tile, params)) };
      }
      return out;
    },
  },
  tile: {
    purpose: 'repeat the image in an x × y grid (check a texture tiles)',
    params: { x: int(1, 8, { default: 2, doc: 'copies across' }), y: int(1, 8, { default: 2, doc: 'copies down' }) },
    async apply(img, p) {
      const { width: W, height: H } = img.info;
      if (W * p.x > MAX_DIM || H * p.y > MAX_DIM) throw bad(`tiled result ${W * p.x}×${H * p.y} exceeds ${MAX_DIM}px`);
      return fromSharp((await raw(img)).extend({ right: W * (p.x - 1), bottom: H * (p.y - 1), extendWith: 'repeat' }));
    },
  },
  to_svg: {
    purpose: 'trace to a vector SVG (new Library image, subtype svg) — pick a method; params depend on it',
    params: { method: oneOf(Object.keys(SVG_METHODS), { default: 'mono' }) },   // + SVG_METHODS[method].params
    async run(img, p) {
      const t = await traceRaster(p.prep ? await runPrep(img, p.prep) : img, p.traceSize);
      let svg, extra = {};
      if (p.method === 'vtracer') {
        const id = randomUUID();
        const inPng = path.join(WORK_BASE, `${id}.in.png`), outSvg = path.join(WORK_BASE, `${id}.out.svg`);
        try {
          await (await rawOf(t.data, t.width, t.height)).png().toFile(inPng);
          svg = await runVtracer(inPng, outSvg, p);
        } finally { await Promise.all([rm(inPng, { force: true }), rm(outSvg, { force: true })]); }
      } else {
        const r = await traceInWorker({ ...t, method: p.method, params: p });
        if (!r.layers.length || r.layers.every(l => !l.d)) {
          throw new HttpError(422, 'nothing was traced', p.method === 'mono' ? 'adjust threshold, invert or channel' : 'try more colors or dropBackground:false');
        }
        svg = potraceSvg(t.width, t.height, r.layers, p);
        extra = p.method === 'mono' ? { channel: r.channel } : { palette: r.palette, background: r.background };
      }
      const f = await finishSvg(svg, p);
      return { bytes: Buffer.from(f.svg), ext: 'svg', subtype: 'svg',
        meta: { method: p.method, width: f.width, height: f.height, bytes: f.bytes, ...extra } };
    },
  },
};

function paramsFor(name, input) {
  if (name !== 'to_svg') return opParams(name, input);
  const method = checkValue('method', OPS.to_svg.params.method, input.method);
  const { method: _m, ...rest } = input;
  const p = { method, ...validate(SVG_METHODS[method].params, rest) };
  if (method === 'mono' && p.currentColor === undefined) p.currentColor = p.color === 'currentColor';
  return p;
}

function catalogue(python, models, faceModels) {
  return {
    ok: true,
    tool: 'image-ops',
    request: `POST ${BASE}/api/<op>  JSON { asset_id, ...params, label?, origin?: { room_id, room_name?, agent?, seat_id?, app? } }`,
    returns: '{ ok, asset, op, params } — asset is a NEW transient Library image; parent_id = asset_id; '
      + "derived_op = { tool:'image-ops', op, params } where params are the effective values (defaults filled) — "
      + 'POST them back to replay. Unknown params are rejected (400). Errors: { ok:false, error, hint? }.',
    output: 'raster ops → PNG (alpha kept; height/ao/edges greyscale); to_svg → SVG (subtype svg).',
    ops: [...Object.entries(OPS).map(([name, o]) => ({
      name, purpose: o.purpose, params: catalogueParams(o.params),
      ...(PREP_OPS.includes(name) && { prep: true }),
      ...(name === 'remove_bg' && { available: { python, models } }),
      ...(name === 'to_svg' && {
        methods: Object.fromEntries(Object.entries(SVG_METHODS).map(([m, d]) => [m, {
          purpose: d.purpose, params: catalogueParams(d.params),
          ...(m === 'vtracer' && { available: python }),
        }])),
      }),
    })), { ...FACE_OP, available: { python, models: { [FACE_MODEL]: faceModels } } }],
    notes: [
      `to_svg refuses outputs over ${(MAX_SVG_BYTES / 1048576).toFixed(0)} MB (422 with a hint); tracing + pixel maths are capped at ${MAX_CONCURRENT_TRACES} concurrent jobs, remove_bg at ${MAX_CONCURRENT_SEGMENTS}.`,
      `Ops marked prep:true can also run inside to_svg as \`prep\` steps (${PREP_OPS.join(', ')}) — e.g. remove_bg → local_contrast → sharpen, then vtracer — in one call.`,
      'PBR from one image: height → normal (source:"height") and ao (source:"height"); or normal/ao straight from the image (source:"image"). Use wrap:true on a seamless texture.',
      `face_match is analysis only (no new image, no parent_id): it answers with scores and writes meta.identity on each candidate. It runs one job at a time and returns 503 with the --fetch command until the buffalo_l models are downloaded.`,
      `remove_bg returns 503 with the exact install / --fetch command when rembg or the model is missing; available.models says which are downloaded.`,
      "Sending an image to briefing-table's Art library is Image Studio's `to_art` (not an image-ops op).",
    ],
  };
}

// ── Library I/O ───────────────────────────────────────────────────────────────────────
const ORIGIN_KEYS = ['app', 'room_id', 'room_name', 'agent', 'seat_id'];
function cleanOrigin(o) {        // same shape image-gen records (the Library UI reads meta.origin)
  if (!o || typeof o !== 'object' || !o.room_id) return null;
  const out = { kind: 'room' };
  for (const k of ORIGIN_KEYS) if (typeof o[k] === 'string' && o[k].trim()) out[k] = o[k].trim().slice(0, 200);
  return out.room_id ? out : null;
}

async function libFetch(p, opts = {}) {
  try { return await fetch(LIBRARY + p, { signal: AbortSignal.timeout(30_000), ...opts }); }
  catch (e) { throw new HttpError(502, `library unreachable: ${e.message}`); }
}

async function getSource(id) {
  const r = await libFetch(`/assets/${encodeURIComponent(id)}`);
  if (r.status === 404) throw new HttpError(404, `asset ${id} not found`);
  if (!r.ok) throw new HttpError(502, `library GET asset → ${r.status}`);
  const row = await r.json();
  if (row.category !== 'image') throw bad(`asset ${id} is ${row.category || 'not an image'} — image-ops needs an image`);
  const f = await libFetch(`/assets/${encodeURIComponent(id)}/file`);
  if (!f.ok) throw new HttpError(502, `library GET file → ${f.status}`);
  return { row, buf: Buffer.from(await f.arrayBuffer()) };
}

async function registerOutput({ row, op, params, label, origin, result }) {
  await mkdir(WORK_BASE, { recursive: true });
  const file = path.join(WORK_BASE, `${randomUUID()}.${result.ext}`);
  await writeFile(file, result.bytes);
  try {
    const stem = String(row.filename || row.label || row.id).replace(/\.[^.]+$/, '');
    const tag = op === 'to_svg' ? `svg-${params.method}` : op;
    const r = await libFetch('/assets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        srcPath: file, filename: `${stem}_${tag}.${result.ext}`, label: label || `${row.label || stem} · ${tag}`,
        source: 'image-ops', subtype: result.subtype || 'image', parent_id: row.id,
        derived_op: { tool: 'image-ops', op, params }, transient: true,
        meta: { op, ...result.meta, ...(origin && { origin }) },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new HttpError(502, `library register failed: ${j.error || r.status}`);
    return j.asset;
  } finally { await rm(file, { force: true }).catch(() => {}); }   // the Library copied it in
}

// ── Routes ────────────────────────────────────────────────────────────────────────────
export async function register(app) {
  await mkdir(WORK_BASE, { recursive: true }).catch(() => {});

  app.use(BASE, (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  app.get(`${BASE}/api/ops`, async (req, res) => res.json(catalogue(await pythonAvailable(), await modelsDownloaded(), await faceModelsPresent())));

  app.post(`${BASE}/api/face_match`, express.json({ limit: '64kb' }), async (req, res) => {
    try {
      const { asset_id, label: _l, origin: _o, ...input } = req.body || {};
      if (typeof asset_id !== 'string' || !asset_id) throw bad('asset_id (string, the source image) is required');
      res.json({ ok: true, op: 'face_match', ...(await faceMatch(asset_id, faceParams(input))) });
    } catch (e) {
      if (!e.status) console.error('[image-ops] face_match:', e);
      res.status(e.status || 500).json({ ok: false, error: e.message, ...(e.hint && { hint: e.hint }) });
    }
  });

  app.post(`${BASE}/api/:op`, express.json({ limit: '256kb' }), async (req, res) => {
    const name = req.params.op;
    try {
      if (!Object.hasOwn(OPS, name)) throw new HttpError(404, `unknown op '${name}' — see GET ${BASE}/api/ops (${Object.keys(OPS).join(', ')})`);
      const { asset_id, label, origin, ...input } = req.body || {};
      if (typeof asset_id !== 'string' || !asset_id) throw bad('asset_id (string) is required');
      if (label != null && (typeof label !== 'string' || label.length > 200)) throw bad('label must be a string ≤ 200 chars');
      const params = paramsFor(name, input);
      const { row, buf } = await getSource(asset_id);
      const img = await decode(buf);
      const op = OPS[name];
      const result = op.run ? await op.run(img, params) : await encode(await op.apply(img, params), op.grey);
      const o = cleanOrigin(origin);
      const asset = await registerOutput({ row, op: name, params, label, origin: o, result });
      const preview = result.preview   // seamless: the 2×2 tiling, parented to the tile
        && await registerOutput({ row: asset, op: 'tile', params: result.preview.params, origin: o, result: result.preview.result });
      res.json({ ok: true, asset, op: name, params, ...(preview && { preview }) });
    } catch (e) {
      if (!e.status) console.error(`[image-ops] ${name}:`, e);
      res.status(e.status || 500).json({ ok: false, error: e.message, ...(e.hint && { hint: e.hint }) });
    }
  });
}
