#!/usr/bin/env node
/*
 * asset-studio app — a zero-dependency HTTP server (node >= 20): a room's image
 * generation, driven by the room's agent over asset-platform's image-gen.
 * Every agent-callable route is JSON in, JSON out (S4, briefing-table-mcp.md §4.4);
 * no route returns image bytes — outputs are Library asset ids + their file URLs.
 *
 *   GET  /health                              -> {ok, version, uptime, bound, engine}
 *   GET  /rooms/:roomId/state                 -> get_state      settings, refs, budget, running jobs, latest result
 *   GET  /rooms/:roomId/models                -> list_models    [{model_type, name, refs, defaults}]
 *   GET  /rooms/:roomId/history               -> history        this room's generations, newest first
 *   GET  /rooms/:roomId/jobs/:jobId           -> job_status
 *   GET  /rooms/:roomId/room-images           -> room_images    the room's Assets that are images (+ Library id if known)
 *   GET  /rooms/:roomId/images[?bin=]         -> list_images    this room's generated images (+ their folder), newest first
 *   POST /rooms/:roomId/model   {model_type}  -> set_model
 *   POST /rooms/:roomId/prompt  {prompt, negative_prompt?}                   -> set_prompt
 *   POST /rooms/:roomId/params  {aspect?, width?, height?, seed?, num_inference_steps?,
 *                                guidance_scale?, draft?, count?}             -> set_params
 *   POST /rooms/:roomId/refs    {asset_id, slot?}                            -> set_ref
 *   POST /rooms/:roomId/refs/clear {slot?}                                   -> clear_ref
 *   POST /rooms/:roomId/refs/import {name, slot?}                            -> import_ref (a room image -> a reference)
 *   POST /rooms/:roomId/images/move {asset_id | asset_ids, to}               -> move_image (renders | favorites | recycle)
 *   POST /rooms/:roomId/images/colormatch {asset_id, ref_id, lift_dark?}     -> color_match (a new, colour-matched image)
 *   POST /rooms/:roomId/images/art {asset_id, name}                          -> to_art (Art-library SVG via briefing-table's icon-lab)
 *   POST /rooms/:roomId/images/crop  {asset_id, x, y, w, h, long_edge?}      -> crop_region (a region, upscaled, as a new image)
 *   POST /rooms/:roomId/images/paste {base_id, patch_id, x, y, w, h, feather?, feather_edges?} -> paste_region
 *   POST /rooms/:roomId/generate {count?, draft?}  -> 202 {job, budget}      -> generate (answers at once)
 *   POST /rooms/:roomId/jobs/:jobId/cancel                                   -> cancel
 *   POST /rooms/:roomId/recipe  {asset_id}                                   -> reload_recipe
 *   POST /rooms/:roomId/gpu/release  {}                                       -> release_gpu    unload Krea now (idle only; busy → {busy:true})
 *   POST /rooms/:roomId/budget  {max_images, reset?}                         -> set_budget (control: the user's; announced in the room)
 *   GET  /rooms/:roomId/reviews                                              -> review_list    design-review items, newest first
 *   POST /rooms/:roomId/reviews {title, note?, images:[1-4 Library ids], for?, purpose?, summary?, ask?, limits?, files?} -> review_add   #n (never reused), v1, waiting; a tool line for the requester
 *        purpose = status | feedback | vote; files = [{role?, label?, library: <id> | share: <path>}] up to 12, downloads beside the views
 *   POST /rooms/:roomId/reviews/update {n, images?, note?, title?}           -> review_update  new images/note = a new version (+ its tool line)
 *   POST /rooms/:roomId/reviews/status {n, status}                           -> review_status  waiting | replied | resolved
 *   POST /rooms/:roomId/reviews/remove {n}                                   -> review_remove
 *   POST /rooms/:roomId/reviews/:n/feedback {verdict?: up|down, comment?}    -> review_feedback  the USER's rating, SAVED unsent (a panel action)
 *   POST /rooms/:roomId/reviews/:n/marks {image, x, y} | {label, x, y} | {label, remove} -> review_mark  the USER's marks A, B … on numbered images (a panel action)
 *   POST /rooms/:roomId/reviews/:n/look {widths?, mode?, views?, image?, pin_at?, save?} -> review_look  pictures of the review as the user sees it (headless Chromium); pin_at "x,y" tries a pin without saving it unless save
 *   POST /rooms/:roomId/reviews/:n/refs {name? | image? | remove?}           -> review_ref   the user's own references (a pasted room image), numbered
 *   POST /rooms/:roomId/reviews/submit/:requester  (no body)                  -> review_submit    send that requester's unsent ratings: ONE room line to it (a panel action)
 *   POST /rooms/:roomId/reviews/submit  (no body)                             -> the same, while every unsent rating has ONE requester (else 409)
 *
 * The panel (not verbs — the room page frames it through the engine's GET-only proxy):
 *   GET  /rooms/:roomId/view        the view-only panel (Aurora room-asset-studio-v1)
 *   GET  /rooms/:roomId/tokens.css  vendored Aurora tokens      GET /rooms/:roomId/view.js  its script
 *   GET  /rooms/:roomId/panel.json  what the panel shows (its own poll; CORS-open, read-only)
 *   GET  /rooms/:roomId/thumb/:id   GET /rooms/:roomId/file/:id — this room's images (+ review images), from the Library
 *   GET  /rooms/:roomId/review/:n[?v=]  a room line's link target: the panel, opened on that item (rating form + Send);
 *                                         ?plain=1[&v=&i=] the server-rendered item page
 *   GET  /rooms/:roomId/review/:n/thumb    96 px JPEG of its latest first image    GET /rooms/:roomId/review.js  its script
 *   GET  /rooms/:roomId/download/:n/:v/:fid  one declared file of a review's package, streamed as an attachment (Library or file share)
 *   GET  /rooms/:roomId/links?refs=review/1,…  link-chip facts for briefing-table (≤8 refs; CORS-open, read-only)
 *
 * Only the ONE bound room is served (config.mjs BINDING, scripts/bind.sh); any other
 * room gets 409. Writes must be `content-type: application/json` (a browser page
 * cannot send that cross-origin without a preflight this server never answers) — except
 * review_submit, which the engine forwards with NO body: it may come bodyless, but never
 * with an Origin header (every browser POST carries one; the engine's server-side fetch doesn't).
 * Bind 127.0.0.1; port 0 = ephemeral, published in status/app.json with the pid.
 *
 * Start and stop it ONLY through scripts/start.sh and scripts/stop.sh.
 */
import http from 'node:http';
import { execFile } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { instancesOf, readJson, recordExit, writeJson, writeWidget as writeWidgetFile } from './state.mjs';
import { readBinding, readConfig, STATUS_DIR } from './config.mjs';
import * as studio from './images.mjs';
import * as reviews from './reviews.mjs';
import * as models from './models.mjs';
import * as watch from './watch.mjs';
import { lookFile, reviewLook } from './look.mjs';
import { resolveFamily } from './shared.mjs';
import { page, reviewPage } from './view.mjs';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const APP_JSON = path.join(STATUS_DIR, 'app.json');
const PID_FILE = path.join(STATUS_DIR, 'app.pid');
const WIDGET = path.join(STATUS_DIR, 'widget.json');
const EXIT_JSON = path.join(STATUS_DIR, 'exit.json');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'tool.json'), 'utf8')).version;

const BODY_MAX = 32 * 1024;
const envMs = (name, dflt) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : dflt);
const HEARTBEAT_MS = envMs('ASSET_STUDIO_HEARTBEAT_MS', 30_000); // the engine ages a status line out after 120 s
const TRACK_MS = envMs('ASSET_STUDIO_TRACK_MS', 2_000);
const startedAt = Date.now();
const STATIC_DIR = path.join(ROOT, 'app', 'static');
const TOKENS_CSS = fs.readFileSync(path.join(STATIC_DIR, 'tokens.css'), 'utf8');
const VIEW_JS = fs.readFileSync(path.join(STATIC_DIR, 'view.js'), 'utf8');
const REVIEW_JS = fs.readFileSync(path.join(STATIC_DIR, 'review.js'), 'utf8');
const VIEWER_JS = fs.readFileSync(path.join(STATIC_DIR, 'viewer.js'), 'utf8');   // the model domain's 3D viewer (a module)
// three.js, vendored verbatim; the bare `three` specifier (and GLTFLoader's ../utils/ path) become
// relative at load, so the modules resolve under the frame's own directory with no import map.
const VENDOR = Object.fromEntries(fs.readdirSync(path.join(STATIC_DIR, 'vendor')).map((f) => {
  const body = fs.readFileSync(path.join(STATIC_DIR, 'vendor', f), 'utf8');
  return [f, f.endsWith('.js')
    ? ['application/javascript; charset=utf-8', body.replace(/from\s*'three'/g, "from './three.module.min.js'").replace("'../utils/BufferGeometryUtils.js'", "'./BufferGeometryUtils.js'")]
    : ['text/plain; charset=utf-8', body]];
}));
const OPEN = { 'access-control-allow-origin': '*' };
const IMAGE_TABS = ['studio', 'favorites', 'recycle'];
const MODEL_TABS = { models: 'studio', watch: 'watch' };   // the panel's tab -> the model domain's
// tokens.css (v31) @font-faces its type RELATIVELY (fonts/<name>.woff2): the three the panel uses,
// vendored with their OFL licences. A font fetch from the sandboxed (opaque-origin) frame is a
// CORS request, so these answer access-control-allow-origin: *.
const FONTS = Object.fromEntries(['inter', 'spacegrotesk', 'jetbrainsmono'].map((f) => [`${f}.woff2`, fs.readFileSync(path.join(STATIC_DIR, 'fonts', `${f}.woff2`))]));
// Defense in depth: the engine's proxy sends its own sandbox CSP; this holds for a direct hit.
// wasm-unsafe-eval: the meshopt decoder compiles its wasm; blob:/data: — textures inside a GLB.
const VIEW_CSP = "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self' blob: data:; base-uri 'none'; form-action 'none'";
let engine = { ok: false, state: 'unchecked' };
let coreState = { ok: false, state: 'unchecked', online: 0, total: 0 };

function log(msg) {
  process.stdout.write(`${new Date().toISOString()} [asset-studio] ${msg}\n`);
}

function send(res, code, obj) {
  const body = JSON.stringify(obj) + '\n';
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

function sendRaw(res, code, type, body, extra = {}) {
  res.writeHead(code, {
    'content-type': type, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...extra,
  });
  res.end(body);
}

/* The panel's own GET routes. The room check is the same as the verbs' (studio.room): a
   panel for any other room shows a message, never another room's state. */
async function panelRoute(req, res, roomId, sub, q) {
  if (sub === '/tokens.css') return sendRaw(res, 200, 'text/css; charset=utf-8', TOKENS_CSS);
  if (sub === '/view.js') return sendRaw(res, 200, 'application/javascript; charset=utf-8', VIEW_JS);
  if (sub === '/review.js') return sendRaw(res, 200, 'application/javascript; charset=utf-8', REVIEW_JS);
  if (sub === '/viewer.js') return sendRaw(res, 200, 'application/javascript; charset=utf-8', VIEWER_JS, OPEN);
  if (sub.startsWith('/vendor/')) {
    const v = VENDOR[sub.slice(8)];
    return v ? sendRaw(res, 200, v[0], v[1], { ...OPEN, 'cache-control': 'public, max-age=86400' }) : send(res, 404, { ok: false, error: 'no such file' });
  }
  if (sub.startsWith('/fonts/')) {
    const f = FONTS[sub.slice(7)];
    return f ? sendRaw(res, 200, 'font/woff2', f, { 'cache-control': 'public, max-age=86400', 'access-control-allow-origin': '*' }) : send(res, 404, { ok: false, error: 'no such font' });
  }
  let r;
  try {
    await resolveFamily(roomId);
    r = studio.room(roomId);
  } catch (e) {
    if (!(e instanceof studio.AppError)) throw e;
    if (sub === '/view') return sendRaw(res, 200, 'text/html; charset=utf-8', page(e.message), { 'content-security-policy': VIEW_CSP });
    if (/^\/(review|watch)\/[^/]+$/.test(sub)) return sendRaw(res, 200, 'text/html; charset=utf-8', reviewPage({ message: e.message }), { 'content-security-policy': VIEW_CSP });
    return sendRaw(res, 200, 'application/json', JSON.stringify({ ok: false, error: e.message }) + '\n', { 'access-control-allow-origin': '*' });
  }
  if (sub === '/view') return sendRaw(res, 200, 'text/html; charset=utf-8', page(null, { mode: q.get('mode') }), { 'content-security-policy': VIEW_CSP });
  if (sub === '/panel.json') {
    // CORS-open: the sandboxed frame's fetch has an opaque origin (room-tasks' tasks.json rule). Read-only.
    // ETag + 304: an idle poll (nothing changed) costs headers only. The engine's frame proxy passes both through.
    // one panel.json for every tab: the image domain's (its tabs, else its budget and counts), the model
    // domain's on Models / Watch, and the review list always (the waiting count); review items on Review
    const asked = q.get('tab');
    const tab = [...IMAGE_TABS, ...Object.keys(MODEL_TABS), 'review'].includes(asked) ? asked : 'studio';
    const mr = models.room(roomId);
    const body = JSON.stringify({
      ok: true, ...(await studio.panelData(r, engine, IMAGE_TABS.includes(tab) ? tab : 'review')), tab,
      model: models.panelData(mr, coreState, MODEL_TABS[tab] || 'studio'),
      ...reviews.panelPart(reviews.room(roomId), tab),
    }) + '\n';
    const etag = `"${createHash('sha1').update(body).digest('base64url').slice(0, 20)}"`;
    const hdr = { 'access-control-allow-origin': '*', etag, 'cache-control': 'no-cache' };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, hdr); return res.end(); }
    return sendRaw(res, 200, 'application/json', body, hdr);
  }
  if (sub === '/links') {
    // briefing-table's link chips, fetched through the same frame proxy. CORS-open, read-only.
    try {
      return sendRaw(res, 200, 'application/json', JSON.stringify({ ok: true, items: reviews.links(reviews.room(roomId), q.get('refs')) }) + '\n', { 'access-control-allow-origin': '*' });
    } catch (e) {
      if (!(e instanceof studio.AppError)) throw e;
      return sendRaw(res, e.status, 'application/json', JSON.stringify({ ok: false, error: e.message }) + '\n', { 'access-control-allow-origin': '*' });
    }
  }
  // the rail's tab rows open the full panel in the room's preview column on that tab ()
  const tb = /^\/tab\/(studio|favorites|recycle|models|watch|review)$/.exec(sub);
  if (tb) return sendRaw(res, 200, 'text/html; charset=utf-8', page(null, { mode: q.get('mode'), base: '../', open: `tab/${tb[1]}` }), { 'content-security-policy': VIEW_CSP });
  // a room line's watch/<job> link: the panel on its Watch tab, that job (monitoring in the preview)
  const wl = /^\/watch\/([A-Za-z0-9_.-]{1,80})$/.exec(sub);
  if (wl) return sendRaw(res, 200, 'text/html; charset=utf-8', page(null, { mode: q.get('mode'), base: '../', open: `watch/${wl[1]}` }), { 'content-security-policy': VIEW_CSP });
  if (sub === '/watch.json' || sub.startsWith('/watch/')) return watchRoute(req, res, sub, q);
  const lk = /^\/look\/([a-z0-9]+)\/([a-z0-9-]+\.png)$/.exec(sub);
  if (lk) {
    const png = lookFile(lk[1], lk[2]);
    return png ? sendRaw(res, 200, 'image/png', png, { 'cache-control': 'private, max-age=60' }) : send(res, 404, { ok: false, error: 'no such picture (only the last five looks are kept)' });
  }
  const dl = /^\/download\/(\d{1,9})\/(\d{1,6})\/(f\d{1,2})$/.exec(sub);
  if (dl) return downloadRoute(res, reviews.room(roomId), dl);
  const rv = /^\/review\/([^/]+)$/.exec(sub);
  if (rv) {
    // One review item, large (the in-panel large view AND the link target): any version via ?v=.
    let item = null;
    try { item = reviews.findReview(reviews.room(roomId), decodeURIComponent(rv[1])); } catch (e) { if (!(e instanceof studio.AppError)) throw e; }
    // the panel itself, opened on the item, so the rating form and Send work where a room link opens it
    // (the preview had no voting); ?plain=1 = the server-rendered page, as before
    const v = Number(q.get('v')) || null;
    const html = item && q.get('plain') !== '1'
      ? page(null, { mode: q.get('mode'), base: '../', open: `review/${item.n}${v ? `/v${v}` : ''}` })
      : reviewPage(item ? { item, v, i: Number(q.get('i')) || 0 } : { missing: decodeURIComponent(rv[1]) });
    return sendRaw(res, item ? 200 : 404, 'text/html; charset=utf-8', html, { 'content-security-policy': VIEW_CSP });
  }
  const rt = /^\/review\/([^/]+)\/thumb$/.exec(sub);
  const m = /^\/(thumb|file)\/([^/]+)$/.exec(sub);
  try {
    const id = !rt && decodeURIComponent(m[2]);
    const mr = models.room(roomId);
    // a model asset of the room serves its viewer copy (meshopt / preview GLB); anything else is an image
    const { type, bytes } = rt ? await reviews.reviewThumb(reviews.room(roomId), decodeURIComponent(rt[1]))
      : models.meshOf(mr, id) ? await models.libraryBytes(mr, id, m[1])
        : await studio.libraryBytes(r, id, m[1], reviews.has(reviews.room(roomId), id));
    // CORS-open (read-only, this room's images only): lets the large view read pixels to pick a contrasting backdrop
    return sendRaw(res, 200, type, bytes, { 'cache-control': rt ? 'private, max-age=30' : 'private, max-age=300', 'access-control-allow-origin': '*' }); // an item's thumb follows its latest version
  } catch (e) {
    if (!(e instanceof studio.AppError)) throw e;
    return send(res, e.status, { ok: false, error: e.message });
  }
}
const PANEL = /^\/(view|look\/[a-z0-9]+\/[a-z0-9-]+\.png|tokens\.css|view\.js|review\.js|viewer\.js|panel\.json|links|watch\.json|tab\/(?:studio|favorites|recycle|models|watch|review)|watch\/[^/]+|watch\/[^/]+\/(?:frame\/[^/]+\/[^/]+(?:\/[^/]+)?|(?:model|reference)\.glb|look\/[^/]+\/[^/]+)|vendor\/[A-Za-z_.]+|review\/[^/]+(?:\/thumb)?|download\/\d+\/\d+\/f\d+|fonts\/[a-z]+\.woff2|(?:thumb|file)\/[^/]+)$/;

/* GET /rooms/:roomId/download/:n/:v/:fid — one file of a review's package (the Blender file, a manifest …), STREAMED from
   where it lives (the Library, or the file share) so a large .blend never sits in memory. Only a file the item declares
   is served (never a path from the URL); always an attachment, so a phone saves it. */
const DL_MS = 30 * 60000;
async function downloadRoute(res, r, m) {
  try {
    const ref = reviews.fileRef(r, m[1], m[2], m[3]);
    let up;
    try {
      up = await fetch(ref.url, { headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(DL_MS), redirect: 'error' });
    } catch (e) {
      throw new studio.AppError(503, `the file's source is unreachable (${e.cause?.code || e.name})`);
    }
    if (up.status === 404) { await up.body?.cancel(); throw new studio.AppError(404, 'that file is no longer where the review says it is'); }
    if (!up.ok || !up.body) { await up.body?.cancel(); throw new studio.AppError(502, `the file's source answered HTTP ${up.status}`); }
    // node's fetch decodes gzip / br but keeps the upstream's content-length: only pass a length on when the answer is NOT encoded
    const len = up.headers.has('content-encoding') ? 0 : Number(up.headers.get('content-length'));
    const ascii = ref.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'download';
    res.writeHead(200, {
      'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(ref.name)}`,
      'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...(len > 0 && { 'content-length': len }),
    });
    try {
      await pipeline(Readable.fromWeb(up.body), res);
    } catch {
      res.destroy(); // headers are out: the only honest answer to a failed stream is a cut one
    }
  } catch (e) {
    if (!(e instanceof studio.AppError)) throw e;
    return send(res, e.status, { ok: false, error: e.message });
  }
}

/* The Watch tab's routes (the model domain): the file share, read-only. A share failure is JSON, never a crash. */
async function watchRoute(req, res, sub, q) {
  try {
    if (sub === '/watch.json') {
      const job = q.get('job');
      const body = JSON.stringify(job === null ? { ok: true, ...(await watch.index()) } : { ...(await watch.manifest(job)), ok: true }) + '\n';
      const etag = `"${createHash('sha1').update(body).digest('base64url').slice(0, 20)}"`;
      const hdr = { ...OPEN, etag, 'cache-control': 'no-cache' };
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, hdr); return res.end(); }
      return sendRaw(res, 200, 'application/json', body, hdr);
    }
    const p = sub.split('/').slice(2); // [job, 'model.glb' | 'reference.glb'] | [job, 'frame', camera, '<n>.jpg'] | [job, 'frame', camera, mode, '<n>.jpg'] | [job, 'look', n, '<file>.jpg']
    const last = p[p.length - 1];
    const ref = p.length === 2 ? watch.fileRef(p[0], p[1] === 'reference.glb' ? 'reference' : 'model') : p[1] === 'look' ? watch.fileRef(p[0], 'look', last, p[2]) : watch.fileRef(p[0], 'frame', p[2], last.endsWith('.jpg') ? last.slice(0, -4) : '', p.length === 5 ? p[3] : undefined);
    return await watch.sendFile(res, ref, OPEN);
  } catch (e) {
    if (!(e instanceof studio.AppError)) throw e;
    return sendRaw(res, e.status, 'application/json', JSON.stringify({ ok: false, error: e.message }) + '\n', OPEN);
  }
}

function readBody(req, res) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_MAX) over = true; // keep draining; answer once
      else chunks.push(c);
    });
    req.on('end', () => {
      if (over) {
        send(res, 413, { ok: false, error: `body is ${size} bytes; the limit is ${BODY_MAX}` });
        resolve(null);
      } else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => resolve(null));
  });
}

/* The JSON body of a write, or null after answering. */
async function jsonBody(req, res) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    send(res, 415, { ok: false, error: 'send content-type: application/json' });
    return null;
  }
  const raw = await readBody(req, res);
  if (raw === null) return null;
  try {
    const b = JSON.parse(raw || '{}');
    if (b && typeof b === 'object' && !Array.isArray(b)) return b;
  } catch {
    /* below */
  }
  send(res, 400, { ok: false, error: 'body must be a JSON object' });
  return null;
}

/* A verb with no input, as the engine's panel action forwards it: no content-type, no body.
   A browser page could send that cross-origin too, so it must carry no Origin header. */
async function emptyBody(req, res) {
  if (req.headers.origin !== undefined) {
    send(res, 403, { ok: false, error: 'not from a browser page' });
    return null;
  }
  const raw = await readBody(req, res);
  if (raw === null) return null;
  if (raw.trim()) {
    send(res, 415, { ok: false, error: 'send content-type: application/json' });
    return null;
  }
  return {};
}

// verb table: [method, path pattern after /rooms/:roomId, handler(room, roomId, body, match)]
let PORT = 0;
const R = (re) => new RegExp(`^${re}$`);
const ROUTES = [
  ['GET', R('/state'), (r, id) => ({ ...studio.view(r), ...reviews.stateParts(reviews.room(id)) })],
  ['GET', R('/models'), () => studio.listModels().then((models) => ({ models }))],
  ['GET', R('/history'), (r) => ({ history: studio.history(r) })],
  ['GET', R('/jobs/([^/]+)'), (r, _id, _b, m) => ({ job: studio.jobStatus(r, m[1]) })],
  ['GET', R('/room-images'), (r, id) => studio.roomImages(r, id).then((images) => ({ images }))],
  ['GET', R('/images'), (r, _id, _b, _m, q) => ({ images: studio.listImages(r, q.get('bin') || undefined) })],
  ['POST', R('/model'), (r, _id, b) => studio.setModel(r, b)],
  ['POST', R('/prompt'), (r, _id, b) => studio.setPrompt(r, b)],
  ['POST', R('/params'), (r, _id, b) => studio.setParams(r, b)],
  ['POST', R('/refs'), (r, _id, b) => studio.setRef(r, b)],
  ['POST', R('/refs/clear'), (r, _id, b) => studio.clearRef(r, b)],
  ['POST', R('/refs/import'), (r, id, b) => studio.importRef(r, id, b)],
  ['POST', R('/images/move'), (r, id, b) => studio.moveImage(r, id, b)],
  ['POST', R('/images/colormatch'), (r, id, b) => studio.colorMatch(r, id, b)],
  ['POST', R('/images/art'), (r, id, b) => studio.toArt(r, id, b)],
  ['POST', R('/images/crop'), (r, id, b) => studio.cropRegion(r, id, b)],
  ['POST', R('/images/paste'), (r, id, b) => studio.pasteRegion(r, id, b)],
  ['POST', R('/generate'), (r, id, b) => studio.generate(r, id, b), 202],
  ['POST', R('/jobs/([^/]+)/cancel'), (r, _id, _b, m) => studio.cancel(r, m[1]).then((job) => ({ job }))],
  ['POST', R('/recipe'), (r, _id, b) => studio.reloadRecipe(r, b)],
  ['POST', R('/gpu/release'), (r) => studio.releaseGpu(r)],
  ['POST', R('/budget'), (r, id, b) => studio.setBudget(r, id, b).then((budget) => ({ budget }))],
  // the model domain (Model Studio's verbs, under /models/ and named model_*)
  ['GET', R('/models/state'), (_r, id) => models.view(models.room(id))],
  ['GET', R('/models/ops'), (_r, _id, _b, _m, q) => models.listOps(q.get('category') || undefined).then((ops) => ({ ops }))],
  ['GET', R('/models/history'), (_r, id) => ({ history: models.history(models.room(id)) })],
  ['GET', R('/models/jobs/([^/]+)'), (_r, id, _b, m) => ({ job: models.jobStatus(models.room(id), m[1]) })],
  ['POST', R('/models/import'), (_r, id, b) => models.importAsset(models.room(id), id, b)],
  ['POST', R('/models/run'), (_r, id, b) => models.run(models.room(id), id, b), 202],
  ['POST', R('/models/jobs/([^/]+)/cancel'), (_r, id, _b, m) => models.cancel(models.room(id), m[1]).then((job) => ({ job }))],
  ['POST', R('/models/budget'), (_r, id, b) => models.setBudget(models.room(id), id, b).then((budget) => ({ budget }))],
  ['GET', R('/reviews'), (_r, id) => reviews.reviewListOut(reviews.room(id))],
  ['POST', R('/reviews'), (_r, id, b) => reviews.reviewAdd(reviews.room(id), id, b)],
  ['POST', R('/reviews/update'), (_r, id, b) => reviews.reviewUpdate(reviews.room(id), id, b)],
  ['POST', R('/reviews/status'), (_r, id, b) => reviews.reviewStatus(reviews.room(id), b)],
  ['POST', R('/reviews/remove'), (_r, id, b) => reviews.reviewRemove(reviews.room(id), b)],
  ['POST', R('/reviews/([^/]+)/feedback'), (_r, id, b, m) => reviews.reviewFeedback(reviews.room(id), m[1], b)],
  ['POST', R('/reviews/([^/]+)/marks'), (_r, id, b, m) => reviews.reviewMark(reviews.room(id), m[1], b)],
  ['GET', R('/reviews/([^/]+)/marks'), (_r, id, _b, m) => reviews.reviewMarksOf(reviews.room(id), m[1])],
  ['POST', R('/reviews/([^/]+)/look'), (_r, id, b, m) => { reviews.findReview(reviews.room(id), m[1]); return reviewLook(id, m[1], b, PORT); }],
  ['POST', R('/reviews/([^/]+)/refs'), (_r, id, b, m) => reviews.reviewRef(reviews.room(id), id, m[1], b)],
  ['POST', R('/reviews/([^/]+)/note'), (_r, id, b, m) => reviews.reviewNote(reviews.room(id), m[1], b)],
  ['POST', R('/reviews/([^/]+)/send'), (_r, id, b, m) => reviews.reviewSend(reviews.room(id), id, m[1], b), 200, { bodyless: true }],
  ['POST', R('/reviews/submit'), (_r, id, b) => reviews.reviewSubmit(reviews.room(id), id, b), 200, { bodyless: true }],
  ['POST', R('/reviews/submit/([^/]+)'), (_r, id, b, m) => reviews.reviewSubmit(reviews.room(id), id, b, m[1]), 200, { bodyless: true }],
];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') {
      const b = readBinding();
      return send(res, 200, {
        ok: true, version: VERSION, uptime: Math.round((Date.now() - startedAt) / 1000),
        bound: b ? { room_id: b.room_id, room_name: b.room_name ?? null } : null, engine,
      });
    }
    if (req.method === 'POST' && url.pathname === '/bind') return await bindRoute(req, res);
    const m = /^\/rooms\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (m && PANEL.test(m[2])) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { ok: false, error: 'the panel is GET-only' });
      return await panelRoute(req, res, decodeURIComponent(m[1]), m[2], url.searchParams);
    }
    const hit = m && ROUTES.find(([meth, re]) => meth === req.method && re.test(m[2]));
    if (!hit) return send(res, 404, { ok: false, error: `no route ${req.method} ${url.pathname}` });
    const [, re, fn, code = 200, opt] = hit;
    const roomId = decodeURIComponent(m[1]);
    const b = req.method !== 'POST' ? {} : opt?.bodyless && !req.headers['content-type'] ? await emptyBody(req, res) : await jsonBody(req, res);
    if (b === null) return;
    try {
      await resolveFamily(roomId);
      const r = studio.room(roomId);
      const out = await fn(r, roomId, b, re.exec(m[2]).map((x, i) => (i ? decodeURIComponent(x) : x)), url.searchParams);
      if (req.method === 'POST') log(`${roomId.slice(0, 8)} ${req.method} ${m[2]}`);
      return send(res, code, { ok: true, ...out });
    } catch (e) {
      if (!(e instanceof studio.AppError)) throw e;
      if (e.status >= 500) log(`${req.method} ${url.pathname}: ${e.message}`);
      return send(res, e.status, { ok: false, error: e.message, ...e.extra });
    }
  } catch (e) {
    log(`error: ${e.stack || e}`);
    if (!res.headersSent) send(res, 500, { ok: false, error: String(e.message || e) });
  }
});

/* POST /bind {room_id, force?} — the engine's "Move here" (tool.json lifecycle.bind.http). Loopback
   only, the caller's bearer must be the engine's own API token. Runs the same scripts the resident
   runs (bind, then register-panel), as this app's pane. 409 job-running (unless force: the job
   finishes in its old room) · 409 no-seat (the resident holds no seat there). */
function run(...args) {
  return new Promise((resolve) => execFile(process.execPath, [path.join(ROOT, 'scripts/lib/tool.mjs'), ...args],
    { timeout: 15000 }, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr })));
}
async function bindRoute(req, res) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return send(res, 403, { ok: false, error: 'loopback only' });
  let token = '';
  try { token = fs.readFileSync(readConfig().engineTokenFile || '', 'utf8').trim(); } catch {}
  const got = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''));
  if (!token || got.length !== Buffer.byteLength(token) || !timingSafeEqual(got, Buffer.from(token))) return send(res, 401, { ok: false, error: 'engine bearer required' });
  const b = await jsonBody(req, res);
  if (b === null) return;
  if (typeof b.room_id !== 'string' || !/^[0-9a-f][0-9a-f-]{7,63}$/i.test(b.room_id)) return send(res, 400, { ok: false, error: 'room_id required' });
  const prev = readBinding();
  if (prev?.room_id === b.room_id) return send(res, 200, { ok: true, bound: prev, unchanged: true });
  const busy = [...studio.runningJobs(), ...models.runningJobs()];
  if (busy.length && !b.force) return send(res, 409, { ok: false, reason: 'job-running', error: 'a render is still running', jobs: busy });
  const bound = await run('bind', b.room_id);
  if (bound.code) {
    const noSeat = /holds no seat/.test(bound.stderr);
    return send(res, noSeat ? 409 : 502, { ok: false, reason: noSeat ? 'no-seat' : 'bind-failed', error: bound.stderr.trim() });
  }
  const panel = await run('register-panel', b.room_id);
  log(`bound to ${b.room_id.slice(0, 8)} over HTTP${b.force ? ' (force)' : ''}; panel ${panel.code ? 'FAILED' : 'ok'}`);
  return send(res, 200, { ok: true, ...JSON.parse(bound.stdout.trim().split('\n').pop()), panel: panel.code ? { ok: false, error: panel.stderr.trim() } : { ok: true } });
}

function writeWidget(s) {
  try {
    writeWidgetFile(WIDGET, s);
  } catch (e) {
    log(`could not write widget status: ${e.message}`);
  }
}

/* The status line: app up, bound room, engine state. `configured: false` shows as warn. */
async function beat(port) {
  [engine, coreState] = await Promise.all([studio.engineHealth(), models.coreHealth()]);
  writeWidget({ state: 'up', port, configured: engine.ok, ...(!engine.ok && { reason: `engine offline (${engine.state})` }) });
}

let heartbeat = null;
let tracker = null;
let tracking = false;
async function trackTick() {
  if (tracking) return;
  tracking = true;
  try {
    await studio.track();
    await models.track();
  } catch (e) {
    log(`track: ${e.message}`);
  } finally {
    tracking = false;
  }
}

/* ONE instance per tool folder. start.sh checks under its lock; this catches a hand launch. */
const others = instancesOf(SELF, process.pid);
if (others?.length) {
  log(`another instance is already running (pid ${others.join(', ')}) — not starting`);
  process.exit(1);
}

server.on('error', (e) => {
  log(`cannot listen: ${e.code || e.message}`);
  process.exit(1);
});

server.listen(readConfig().port, '127.0.0.1', () => {
  const { port } = server.address();
  PORT = port;
  fs.mkdirSync(STATUS_DIR, { recursive: true });
  writeJson(APP_JSON, { pid: process.pid, port, version: VERSION, startedAt: new Date(startedAt).toISOString() });
  beat(port);
  heartbeat = setInterval(() => beat(port), HEARTBEAT_MS);
  heartbeat.unref();
  tracker = setInterval(trackTick, TRACK_MS);
  tracker.unref();
  log(`listening on 127.0.0.1:${port} (pid ${process.pid})`);
});

/* A clean exit tidies its own run files and records itself as `clean` (room-tasks' rule:
   a run file is removed only when it still names THIS process). */
let exiting = false;
let tidied = false;
function tidy(why) {
  if (tidied) return;
  tidied = true;
  try {
    if (readJson(APP_JSON)?.pid === process.pid) fs.rmSync(APP_JSON, { force: true });
    if (fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.rmSync(PID_FILE, { force: true });
    recordExit(EXIT_JSON, 'clean', process.pid, why);
  } catch (e) {
    log(`cleanup: ${e.message}`);
  }
  writeWidget({ state: 'down', lastExit: 'clean' });
}
function cleanExit(why) {
  if (exiting) return;
  exiting = true;
  log(`${why} received — shutting down`);
  clearInterval(heartbeat);
  clearInterval(tracker);
  const force = setTimeout(() => {
    log('close timed out — exiting');
    tidy(why);
    process.exit(0);
  }, 3000);
  force.unref();
  server.close(() => {
    tidy(why);
    log('stopped');
    process.exit(0);
  });
  server.closeAllConnections();
}
process.on('SIGTERM', () => cleanExit('SIGTERM'));
process.on('SIGINT', () => cleanExit('SIGINT'));
