/*
 * Asset Studio's ONE review queue (DESIGN.md): every asset the room's agents put in front of the
 * user — images (and meshes, next) — rated per image, sent per requester, with numbers, marks and the
 * user's own references. Built from Image Studio's review engine. State: work/reviews.json,
 * per room {reviews, review_seq}; image facts come from the image domain (app/images.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readBinding, readConfig, WORK_DIR } from './config.mjs';
import { AppError, ROOM_ID, ASSET_ID, RASTER, initiator, str, num, lib, postLine, listRoomAssets, familyKey } from './shared.mjs';
import * as images from './images.mjs';
import * as models from './models.mjs';

const STATE_FILE = path.join(WORK_DIR, 'reviews.json');
let store = null;
function load() {
  if (!store) {
    try {
      store = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
      store = { rooms: {} };
    }
    // the unified review (packages: purpose, summary, files) only ADDS fields; the first time a file from before it is read,
    // keep a copy of it exactly as it was (never overwritten), so nothing a user voted on can be lost to a bad write
    const backup = `${STATE_FILE}.pre-unified`;
    if (!store.schema && Object.keys(store.rooms ?? {}).length && !fs.existsSync(backup)) {
      try { fs.copyFileSync(STATE_FILE, backup); } catch { /* read-only folder: the app still works */ }
    }
  }
  return store;
}
function save() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  store.schema = 2;
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1));
  fs.renameSync(tmp, STATE_FILE);
}
/* The bound room's reviews (the binding check is the image domain's room()). r.roomId rides along,
   never saved: the review code asks the domains about its images by room. */
export function room(roomId) {
  images.room(roomId); // the binding check (a workgroup resolves to its family head)
  roomId = familyKey(roomId);
  const s = load();
  const r = (s.rooms[roomId] ??= { reviews: [], review_seq: 0 });
  for (const it of r.reviews) legacyUnsent(it);
  if (!Object.hasOwn(r, 'roomId')) Object.defineProperty(r, 'roomId', { value: roomId, enumerable: false });
  return r;
}
export function _reset() {
  store = null;
}

/* ---------------------------------------------------------------- review -- */

/* Design reviews ("review #1 the Example Character · #2 her shoes · #3 her ring").
   An item is numbered per room (n never reused) and keeps every version; the latest shows by
   default. Images are ANY Library image (not only this room's). Status (Aurora): a new item or a
   new version is `waiting` for the user; the agent marks it `replied` / `resolved`. Room lines
   link to an item as `review/<n>` (tool.json links) — GET /rooms/:roomId/review/:n. */
const REVIEW_STATUS = ['waiting', 'replied', 'resolved'];
const MAX_REVIEW_IMAGES = 12; // was 4: a model package has 8+ named views (the operator's spec); an older item keeps what it had

function reviewImageIds(r) {
  return new Set((r.reviews || []).flatMap((it) => [...it.versions.flatMap((v) => v.images), ...(it.compare ? [it.compare] : []), ...Object.keys(it.nums || {})]));
}

/* Numbers and marks (task, "then 'make it like #6' is unambiguous"). Every image an
   item shows gets a number for good, in the order first seen: its images (every version), the Original,
   the refs and batch each image was made from, then the user's own references. Never renumbered, so a
   number in a sent review keeps meaning that image. Returns whether a number was given (= save). */
function reviewNums(it, info) {
  const nums = (it.nums ??= {});
  let next = Math.max(0, ...Object.values(nums)) + 1, given = false;
  const give = (id) => {
    if (id && !nums[id]) { nums[id] = next++; given = true; }
  };
  it.versions.forEach((v) => v.images.forEach(give));
  give(it.compare);
  for (const id of new Set(it.versions.flatMap((v) => v.images))) {
    info[id]?.refs.forEach(give);
    info[id]?.siblings.forEach(give);
  }
  (it.user_refs || []).forEach((u) => give(u.id));
  return given;
}
/* the focus page's Info and References for an item's images: the image domain's generation facts */
const reviewInfo = (r, it) => images.generationInfo(r.roomId, [...new Set(it.versions.flatMap((v) => v.images))]);
const numbered = (r, it) => {
  if (reviewNums(it, reviewInfo(r, it))) save();
  return it.nums;
};
/* A mark: a point the user drags onto a numbered image — x, y = fractions of its width and height
   from the top left — labelled A…Z, AA, AB… across the item; the next label follows the highest one. */
const MARKS_MAX = 200;
const markLabel = (k) => {
  let s = '';
  for (k += 1; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
  return s;
};
const labelIndex = (s) => [...s].reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;
/* A pin on a model (unified review P3): the spot on its visible solid surface, kept in the MODEL's own space so it survives a re-export —
   the point in the GLB's scene frame (glTF: Y up, metres; the viewer adds the scene untouched, so what it measures IS that frame), the same
   in the mesh's local frame, the surface normal, the node and its path, the triangle and the barycentric coordinates in it, the camera it was
   placed from and the parts that were hidden. Blender's frame is NOT claimed: `blender` says the mapping is missing until the exporter's map
   (<glb>.glb.map.json) is applied to the point. A pin stays on the model (mesh id) it was placed on; a new model revision never inherits it. */
const pubMark3d = (it, m) => ({
  label: m.label, kind: '3d', version: m.v, mesh_id: m.mesh, mesh: it.nums?.[m.mesh] ?? null,
  frame: 'glb-scene (glTF: Y up, metres)', point: m.point, local: m.local, normal: m.normal, node: m.node ?? '', path: m.path ?? [], triangle: m.triangle ?? null, barycentric: m.bary ?? null,
  camera: m.cam, hidden: m.hidden ?? [], ...(m.comment && { comment: m.comment }), blender: null, blender_note: 'mapping missing: apply the export map (<glb>.glb.map.json) to point', at: m.at,
});
const pubMarks = (it) => (it.marks || []).map((m) => (m.kind === '3d' ? pubMark3d(it, m) : { label: m.label, image: it.nums?.[m.image] ?? null, image_id: m.image, x: m.x, y: m.y }));
const nums3 = (str, n, name, lim = 1e6) => {
  if (typeof str !== 'string' || str.length > 200) throw new AppError(400, `${name} must be ${n} numbers, comma-separated`);
  const a = str.split(',').map((x) => Number(x.trim()));
  if (a.length !== n || a.some((x) => !Number.isFinite(x) || Math.abs(x) > lim)) throw new AppError(400, `${name} must be ${n} finite numbers, comma-separated`);
  return a.map((x) => Math.round(x * 1e5) / 1e5);
};
const nameList = (v, name) => {
  if (v === undefined || v === '') return [];
  const a = str(v, 1000, name).split('|').map((x) => x.trim()).filter(Boolean);
  if (a.length > 64 || a.some((x) => x.length > 120)) throw new AppError(400, `${name}: at most 64 names of up to 120 characters, separated by |`);
  return a;
};
const MARK_COMMENT_MAX = 500;
const frac = (v, k) => {
  if (typeof v !== 'number' || !(v >= 0 && v <= 1)) throw new AppError(400, `${k} must be a number from 0 to 1 (a fraction of the image's ${k === 'x' ? 'width' : 'height'})`);
  return Math.round(v * 1e4) / 1e4;
};
/* review_mark (the USER's, a panel action): {image, x, y} adds one; {label, x, y} moves it; {label,
   remove:true} removes it. Saved on the item at once; review_submit sends the item's marks with it. */
const PIN_KEYS = ['mesh', 'point', 'local', 'normal', 'node', 'path', 'triangle', 'bary', 'cam', 'hidden', 'comment'];
/* a pin's spot and the view it was placed from, parsed from the panel's scalar inputs (strings of numbers) */
function pinFields(b, it, ver, roomId) {
  if (typeof b.mesh !== 'string' || !ASSET_ID.test(b.mesh)) throw new AppError(400, 'mesh must be the Library id of one of the version\'s models');
  if (!ver.images.includes(b.mesh)) throw new AppError(400, `mesh ${b.mesh} is not one of #${it.n} v${ver.v}'s images`);
  const mesh = models.meshOf(models.room(roomId), b.mesh);
  if (!mesh || mesh.category !== 'mesh') throw new AppError(400, `${b.mesh} is not a model`);
  const c = nums3(b.cam, 7, 'cam', 1e6);
  if (!(c[6] > 0 && c[6] < 180)) throw new AppError(400, 'cam: the 7th number is the field of view in degrees (0–180)');
  const tri = b.triangle === undefined || b.triangle === '' ? null : Number(b.triangle);
  if (tri !== null && !(Number.isInteger(tri) && tri >= 0 && tri < 1e9)) throw new AppError(400, 'triangle must be a non-negative integer');
  return {
    mesh: b.mesh, point: nums3(b.point, 3, 'point'), local: nums3(b.local ?? b.point, 3, 'local'), normal: nums3(b.normal, 3, 'normal', 2),
    node: b.node === undefined ? '' : str(b.node, 120, 'node'), path: nameList(b.path, 'path'), triangle: tri, bary: b.bary === undefined || b.bary === '' ? null : nums3(b.bary, 3, 'bary', 2),
    cam: { position: c.slice(0, 3), target: c.slice(3, 6), fov: c[6] }, hidden: nameList(b.hidden, 'hidden'),
  };
}
/* Marks and pins are part of the answer: a mark placed, moved, commented or removed since the last Send is UNSENT, like a rating draft
   (pins on #23 never reached the agent). A mark carries `at` (its last change) and, once sent, `sent_at`; marks sent
   before that stamp existed count as sent when they are no newer than the item's last send. A removed mark that had been sent leaves
   its label in it.marks_gone until the next Send. Additive: nothing here rewrites an existing item. */
const markSent = (it, m) => (m.sent_at ? Date.parse(m.at) <= Date.parse(m.sent_at) : !!it.sent && Date.parse(m.at) <= Date.parse(it.sent.at));
const marksUnsent = (it) => (it.marks ?? []).filter((m) => !markSent(it, m));
const marksPending = (it) => marksUnsent(it).length + (it.marks_gone?.length ?? 0);
const nextLabel = (it, marks) => markLabel(marks.reduce((a, m) => Math.max(a, labelIndex(m.label)), -1) + 1); // the next follows the highest (as ever)
const dropMark = (it, marks, m) => {
  if (markSent(it, m)) (it.marks_gone ??= []).push(m.label);
  marks.splice(marks.indexOf(m), 1);
};
export function reviewMark(r, n, b) {
  const extra = Object.keys(b).find((k) => !['image', 'label', 'x', 'y', 'remove', ...PIN_KEYS].includes(k));
  if (extra) throw new AppError(400, `unknown field '${extra}' — review_mark takes image, x, y (add), label, x, y (move) or label, remove; for a pin on a model: mesh, point, normal, cam (+ local, node, path, triangle, bary, hidden, comment)`);
  const it = findReview(r, n);
  const marks = (it.marks ??= []);
  const at = new Date().toISOString();
  if (b.mesh !== undefined && b.label === undefined) { // a new pin on a model
    if (marks.length >= MARKS_MAX) throw new AppError(400, `#${it.n} has ${MARKS_MAX} marks already`);
    const ver = it.versions.at(-1);
    const label = nextLabel(it, marks);
    const comment = b.comment === undefined ? '' : str(b.comment, MARK_COMMENT_MAX, 'comment').trim();
    numbered(r, it);
    marks.push({ label, kind: '3d', v: ver.v, ...pinFields(b, it, ver, r.roomId), ...(comment && { comment }), at });
    save();
    return { n: it.n, label, marks: pubMarks(it) };
  }
  if (b.label !== undefined && marks.find((x) => x.label === b.label)?.kind === '3d') { // move / comment / remove an existing pin
    const m = marks.find((x) => x.label === b.label);
    if (b.remove === true) dropMark(it, marks, m);
    else {
      if (b.point !== undefined) { // moved: the new spot and view; what is not sent stays as it was
        const had = { mesh: m.mesh, point: m.point.join(','), local: m.local.join(','), normal: m.normal.join(','), node: m.node, path: m.path.join('|'), triangle: m.triangle ?? '', bary: m.bary ? m.bary.join(',') : '', cam: [...m.cam.position, ...m.cam.target, m.cam.fov].join(','), hidden: m.hidden.join('|') };
        Object.assign(m, pinFields({ ...had, ...Object.fromEntries(PIN_KEYS.filter((k) => k !== 'comment' && b[k] !== undefined).map((k) => [k, b[k]])) }, it, it.versions.find((x) => x.v === m.v) ?? it.versions.at(-1), r.roomId), { at });
      }
      if (b.comment !== undefined) {
        const comment = str(b.comment, MARK_COMMENT_MAX, 'comment').trim();
        if (comment) m.comment = comment;
        else delete m.comment;
        m.at = at;
      }
    }
    save();
    return { n: it.n, marks: pubMarks(it) };
  }
  if (b.label !== undefined) {
    const m = marks.find((x) => x.label === b.label);
    if (!m) throw new AppError(404, `no mark ${String(b.label).slice(0, 8)} on #${it.n}`);
    if (b.remove === true) dropMark(it, marks, m);
    else Object.assign(m, { x: frac(b.x, 'x'), y: frac(b.y, 'y'), at });
  } else {
    if (typeof b.image !== 'string' || !numbered(r, it)[b.image]) throw new AppError(400, `image must be the id of one of #${it.n}'s numbered images`);
    if (marks.length >= MARKS_MAX) throw new AppError(400, `#${it.n} has ${MARKS_MAX} marks already`);
    const label = nextLabel(it, marks);
    marks.push({ label, image: b.image, x: frac(b.x, 'x'), y: frac(b.y, 'y'), at });
  }
  save();
  return { n: it.n, marks: pubMarks(it) };
}
/* review_ref: the USER's own references on an item (the user: "paste a reference that gets added to
   references with a number"). {name} = a room image (the panel pastes it into the room first), {image} =
   a Library image, neither = the newest room image added in the last 10 minutes; {remove: id} takes one
   off (its number stays given). Each gets the item's next number. */
const USER_REFS_MAX = 24;
const FRESH_MS = 10 * 60000;
export async function reviewRef(r, roomId, n, b) {
  const extra = Object.keys(b).find((k) => !['name', 'image', 'remove'].includes(k));
  if (extra) throw new AppError(400, `unknown field '${extra}' — review_ref takes name, image or remove`);
  const it = findReview(r, n);
  const refs = (it.user_refs ??= []);
  if (b.remove !== undefined) {
    const k = refs.findIndex((u) => u.id === b.remove);
    if (k < 0) throw new AppError(404, `that image is not one of your references on #${it.n}`);
    refs.splice(k, 1);
    save();
    return { n: it.n, removed: b.remove, user_refs: refs };
  }
  let id;
  if (b.image !== undefined) id = (await reviewImages([b.image]))[0];
  else if (b.name !== undefined) id = await images.importRoomImageFor(roomId, str(b.name, 255, 'name'));
  else {
    const t = (a) => (typeof a.addedAt === 'number' ? a.addedAt : Date.parse(a.addedAt) || 0); // epoch ms from the engine
    const hit = (await listRoomAssets(roomId)).filter((a) => RASTER.test(a.type || '') && Date.now() - t(a) < FRESH_MS).sort((a, c) => t(c) - t(a))[0];
    if (!hit) throw new AppError(404, 'no image was added to the room in the last 10 minutes — paste or drop one first');
    id = await images.importRoomImageFor(roomId, hit.name, hit);
  }
  if (!refs.some((u) => u.id === id)) {
    if (refs.length >= USER_REFS_MAX) throw new AppError(400, `#${it.n} has ${USER_REFS_MAX} of your references already`);
    refs.push({ id, at: new Date().toISOString() });
  }
  const num = numbered(r, it)[id];
  save();
  return { n: it.n, ref: { id, num }, user_refs: refs };
}

export function findReview(r, n) {
  const k = Number(n);
  const it = Number.isInteger(k) ? r.reviews.find((x) => x.n === k) : null;
  if (!it) throw new AppError(404, `no review item #${n} in this room`);
  return it;
}
const reviewN = (b) => num(b.n, 1, 1e9, 'n', true);

/* An item's images: Library images — and, for an item's own versions (meshes: roomId given), Library
   meshes, which join the room's model set so the panel can show them in the 3D viewer. The Original and
   the user's references stay images (marks are on pictures). */
async function reviewImages(v, roomId = null) {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_REVIEW_IMAGES) throw new AppError(400, `images must be 1–${MAX_REVIEW_IMAGES} Library image${roomId ? ' or mesh' : ''} ids`);
  if (new Set(v).size !== v.length) throw new AppError(400, 'images has the same id twice');
  for (const id of v) {
    if (typeof id !== 'string' || !ASSET_ID.test(id)) throw new AppError(400, `bad image id ${JSON.stringify(id)}`);
    let m;
    try {
      m = await lib(`/assets/${encodeURIComponent(id)}`);
    } catch (e) {
      throw new AppError(503, `Library unreachable (${e.cause?.code || e.name})`);
    }
    if (m.status === 404) throw new AppError(400, `Library asset ${id} not found`);
    if (m.status !== 200) throw new AppError(502, `Library asset ${id} → HTTP ${m.status}`);
    if (roomId && m.json?.category === 'mesh') {
      await models.adopt(roomId, id);
      continue;
    }
    if (m.json?.category !== 'image') throw new AppError(400, `Library asset ${id} is not an image${roomId ? ' or a mesh' : ''} (${m.json?.category ?? 'no category'})`);
  }
  return v;
}
const reviewTitle = (v) => {
  const t = str(v, 80, 'title').trim();
  if (!t) throw new AppError(400, 'title is empty');
  return t;
};

/* The submission package (, "unified review"; the design notes): what kind of answer a version asks for,
   a short "what changed", the request in one sentence, the limits worth knowing, and the files to download beside the
   pictures and the model (the Blender file the operator worked in, a manifest …). All optional and per VERSION, so an
   older item (none of these) reads as a request for feedback — the thumbs and comments it always had. A change to any of
   them is a new version, like new images or a new note (the package is the evidence; the title stays in place). */
export const PURPOSES = ['status', 'feedback', 'vote']; // "Status" (nothing is asked), "Feedback requested", "Vote"
const FILE_ROLES = ['blend', 'model', 'manifest', 'images', 'other'];
const FILES_MAX = 12;
const SHARE_PATH = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,80}(\/[A-Za-z0-9][A-Za-z0-9._ -]{0,80}){0,8}$/; // no '..', no leading dot, no query
export const purposeOf = (it) => it.versions.at(-1)?.purpose ?? 'feedback';
/* in the "Needs your response" group: a version that asks for something and is still waiting. A status never is. */
export const needsResponse = (it) => it.status === 'waiting' && purposeOf(it) !== 'status';
const pkgText = (b, k, max, prev) => (b[k] === undefined ? prev : b[k] === null ? '' : str(b[k], max, k).trim());
function pkgPurpose(b, prev) {
  if (b.purpose === undefined) return prev;
  if (!PURPOSES.includes(b.purpose)) throw new AppError(400, `purpose must be one of ${PURPOSES.join(', ')}`);
  return b.purpose;
}
const shareUrl = () => {
  const u = readConfig().shareUrl;
  if (!u) throw new AppError(503, 'the file share is not configured (shareUrl)');
  return u;
};
const shareFileUrl = (rel) => `${shareUrl()}/raw/${rel.split('/').map(encodeURIComponent).join('/')}`;
const SHARE_TYPES = { blend: 'application/x-blender', glb: 'model/gltf-binary', gltf: 'model/gltf+json', json: 'application/json', zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', ply: 'application/octet-stream', obj: 'text/plain', fbx: 'application/octet-stream' };
/* files: [{role?, label?, library: <id> | share: <path on the file share>}] — each is checked (it must exist) and its name, type
   and size are recorded when the package is published; omitted = the last version's files carry over. A file that is missing
   fails the whole call BY NAME: a package is never published with a download that isn't there. */
async function reviewFiles(v, prev) {
  if (v === undefined) return prev ?? [];
  if (!Array.isArray(v) || v.length > FILES_MAX) throw new AppError(400, `files must be a list of at most ${FILES_MAX} files`);
  const out = [];
  for (const [k, f] of v.entries()) {
    const where = `files[${k}]`;
    if (!f || typeof f !== 'object' || Array.isArray(f)) throw new AppError(400, `${where} must be an object with library or share`);
    const extra = Object.keys(f).find((x) => !['role', 'label', 'library', 'share'].includes(x));
    if (extra) throw new AppError(400, `${where}: unknown field '${extra}' — role, label, library or share`);
    if ((f.library === undefined) === (f.share === undefined)) throw new AppError(400, `${where} needs exactly one of library (a Library asset id) or share (a path on the file share)`);
    const role = f.role === undefined ? 'other' : f.role;
    if (!FILE_ROLES.includes(role)) throw new AppError(400, `${where}: role must be one of ${FILE_ROLES.join(', ')}`);
    const label = f.label === undefined ? '' : str(f.label, 80, `${where}.label`).trim();
    const id = `f${k + 1}`;
    if (f.library !== undefined) {
      if (typeof f.library !== 'string' || !ASSET_ID.test(f.library)) throw new AppError(400, `${where}: bad Library id ${JSON.stringify(f.library)}`);
      let m;
      try {
        m = await lib(`/assets/${encodeURIComponent(f.library)}`);
      } catch (e) {
        throw new AppError(503, `${where}: Library unreachable (${e.cause?.code || e.name})`);
      }
      if (m.status === 404) throw new AppError(400, `${where}: Library asset ${f.library} not found`);
      if (m.status !== 200) throw new AppError(502, `${where}: Library asset ${f.library} → HTTP ${m.status}`);
      out.push({ id, role, ...(label && { label }), name: String(m.json?.filename || m.json?.label || f.library).slice(0, 120), type: String(m.json?.format || '').slice(0, 20), size: Number.isFinite(m.json?.bytes) ? m.json.bytes : null, src: { library: f.library } });
    } else {
      if (typeof f.share !== 'string' || !SHARE_PATH.test(f.share)) throw new AppError(400, `${where}: share must be a plain path on the file share (letters, digits, . _ - space and /)`);
      let r;
      try {
        r = await fetch(shareFileUrl(f.share), { method: 'HEAD', headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(10000), redirect: 'error' });
      } catch (e) {
        throw new AppError(503, `${where}: the file share is unreachable (${e.cause?.code || e.name})`);
      }
      if (r.status === 404) throw new AppError(400, `${where}: ${f.share} is not on the file share`);
      if (!r.ok) throw new AppError(502, `${where}: the file share answered HTTP ${r.status} for ${f.share}`);
      const name = f.share.split('/').at(-1);
      const len = Number(r.headers.get('content-length'));
      out.push({ id, role, ...(label && { label }), name, type: name.includes('.') ? name.split('.').at(-1).toLowerCase().slice(0, 20) : '', size: Number.isFinite(len) && len >= 0 && r.headers.has('content-length') && !r.headers.has('content-encoding') ? len : null, src: { share: f.share } }); // a compressed answer's length is not the file's
    }
  }
  return out;
}
/* The package's structure (unified review, P2): CAPTIONS name the views (an image's id → "Overview"); ALTERNATIVES group views into the
   candidates a vote picks between ([{label, images}] → ids a, b, c…, every image of one in the version, an image in at most one);
   SCOPES are what a whole-result approval can be about (layout, geometry, color …). Per version, like the rest of the package. */
const SCOPES = ['layout', 'geometry', 'color', 'scale', 'materials', 'other'];
const ALT_MAX = 6;
const altId = (k) => String.fromCharCode(97 + k);
function reviewAlternatives(v, imgs) {
  if (!Array.isArray(v) || v.length > ALT_MAX) throw new AppError(400, `alternatives must be a list of at most ${ALT_MAX}`);
  const seen = new Set();
  return v.map((a, k) => {
    const where = `alternatives[${k}]`;
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new AppError(400, `${where} must be an object with label and images`);
    const extra = Object.keys(a).find((x) => !['label', 'images'].includes(x));
    if (extra) throw new AppError(400, `${where}: unknown field '${extra}' — label, images`);
    const label = str(a.label, 40, `${where}.label`).trim();
    if (!label) throw new AppError(400, `${where}.label is empty`);
    if (!Array.isArray(a.images) || !a.images.length) throw new AppError(400, `${where}.images must list at least one of the version's images`);
    for (const id of a.images) {
      if (!imgs.includes(id)) throw new AppError(400, `${where}: ${JSON.stringify(id)} is not one of the version's images`);
      if (seen.has(id)) throw new AppError(400, `${where}: image ${id} is in two alternatives`);
      seen.add(id);
    }
    return { id: altId(k), label, images: [...a.images] };
  });
}
function reviewCaptions(v, imgs) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new AppError(400, 'captions must be an object: image id → short name');
  const out = {};
  for (const [id, t] of Object.entries(v)) {
    if (!imgs.includes(id)) throw new AppError(400, `captions: ${JSON.stringify(id)} is not one of the version's images`);
    const c = str(t, 80, `captions[${id}]`).trim();
    if (c) out[id] = c;
  }
  return out;
}
function reviewScopes(v) {
  if (!Array.isArray(v) || v.length > SCOPES.length || new Set(v).size !== v.length || v.some((x) => !SCOPES.includes(x))) throw new AppError(400, `scopes must be a list (no repeats) of ${SCOPES.join(', ')}`);
  return [...v];
}
/* the structure of a call over what the last version had: omitted = carried over (alternatives and captions only while every image they name is still in the version) */
function structureOf(b, last, imgs) {
  const alternatives = b.alternatives === undefined
    ? (last.alternatives ?? []).every((a) => a.images.every((id) => imgs.includes(id))) ? last.alternatives ?? [] : (() => { throw new AppError(400, 'the version\'s images changed and the alternatives name images that are gone — send alternatives again (or [] to drop them)'); })()
    : reviewAlternatives(b.alternatives, imgs);
  const captions = b.captions === undefined
    ? Object.fromEntries(Object.entries(last.captions ?? {}).filter(([id]) => imgs.includes(id)))
    : reviewCaptions(b.captions, imgs);
  const scopes = b.scopes === undefined ? last.scopes ?? [] : reviewScopes(b.scopes);
  return { alternatives, captions, scopes };
}
const structureFields = ({ alternatives, captions, scopes }) => ({
  ...(alternatives.length && { alternatives }), ...(Object.keys(captions).length && { captions }), ...(scopes.length && { scopes }),
});

/* what the panel and the agents read of a version's files: no source, a link the panel can open */
const pubFiles = (it, ver) => ver.files.map(({ src, ...f }) => ({ ...f, href: `download/${it.n}/${ver.v}/${f.id}` }));
const pubVer = (it, ver) => (ver.files?.length ? { ...ver, files: pubFiles(it, ver) } : ver);
const pubItem = (it) => (it.versions.some((v) => v.files?.length) ? { ...it, versions: it.versions.map((v) => pubVer(it, v)) } : it);
/* GET /rooms/:roomId/download/:n/:v/:fid — where one declared file's bytes come from (the server streams them) */
export function fileRef(r, n, v, fid) {
  const it = findReview(r, n);
  const ver = it.versions.find((x) => x.v === Number(v));
  const f = ver?.files?.find((x) => x.id === fid);
  if (!f) throw new AppError(404, `#${it.n} has no such file`);
  const name = f.name || f.id;
  if (f.src.library) return { name, url: `${readConfig().libraryUrl}/assets/${encodeURIComponent(f.src.library)}/file` };
  return { name, url: shareFileUrl(f.src.share) };
}

/* review_list's row: the latest version, and how many there are. Ratings in their agent-facing form. */
function reviewSummary(it) {
  const latest = pubVer(it, it.versions.at(-1));
  return { n: it.n, title: it.title, status: it.status, purpose: purposeOf(it), needs: needsResponse(it), agent: it.agent, ...(it.compare && { compare: it.compare }), at: it.at, updated_at: it.updated_at, versions: it.versions.length,
    latest: { ...latest, feedback: latest.feedback?.map((f) => pubRating(f, latest)) }, unsent: pubUnsent(it), ...(marksPending(it) && { unsent_marks: marksPending(it) }) };
}

/* Who REQUESTED an item (, briefing-table task): the agent its Send review line
   goes to. review_add's `for` (an agent handle; default the bound agent) is stored as it.agent; an
   item from before with none is the bound agent's. */
const requesterOf = (it) => it.agent || readBinding()?.agent || null;
/* The evidence tool line: the engine addresses a Send review line to a seat only when this app
   posted a tool line FOR it here within 14 days — so every new item / version says so, for its
   requester, linked to review/<n>. Best-effort: false = not posted (the send then goes to the lead). */
async function announceReview(roomId, it) {
  const ver = it.versions.at(-1);
  const k = ver.images.length;
  const word = { status: 'Status', feedback: 'Feedback wanted', vote: 'Vote' }[purposeOf(it)];
  const text = ver.purpose
    ? `${word} #${it.n}${ver.v > 1 ? ` v${ver.v}` : ''}: ${it.title} (${k} view${k > 1 ? 's' : ''}${ver.files?.length ? `, ${ver.files.length} download${ver.files.length > 1 ? 's' : ''}` : ''})`
    : `Review #${it.n}${ver.v > 1 ? ` v${ver.v}` : ''} ready: ${it.title} (${k} image${k > 1 ? 's' : ''})`; // from before the package fields: the line it always had
  return postLine(roomId, text, requesterOf(it), [{ tool: 'asset-studio', ref: `review/${it.n}`, label: `#${it.n}` }]).then(() => true, () => false);
}

/* the package's text fields and purpose from a call, over what the last version had */
function packageOf(b, prev) {
  const purpose = pkgPurpose(b, prev.purpose);
  // "What changed" is about THIS version: it never carries over (a version made by new images alone has none until it is given).
  // purpose, ask, limits and files do carry over — they describe the request, not the round.
  const pkg = { purpose, summary: pkgText(b, 'summary', 600, ''), ask: pkgText(b, 'ask', 200, prev.ask), limits: pkgText(b, 'limits', 800, prev.limits) };
  return Object.fromEntries(Object.entries(pkg).filter(([k, v]) => v !== undefined && (v !== '' || k === 'purpose' && v)));
}
export async function reviewAdd(r, roomId, b) {
  const agent = b.for === undefined ? readBinding()?.agent ?? null : initiator(b);
  if (agent === 'user') throw new AppError(400, 'for is the agent that asked for the review (a handle) — the user is who rates it');
  const title = reviewTitle(b.title);
  const note = b.note === undefined ? '' : str(b.note, 2000, 'note').trim();
  const imgs = await reviewImages(b.images, roomId);
  const compare = b.compare == null ? null : (await reviewImages([b.compare]))[0];
  const files = await reviewFiles(b.files, undefined);
  const pkg = packageOf(b, {});
  const structure = structureOf(b, {}, imgs);
  const at = new Date().toISOString();
  r.review_seq = (r.review_seq ?? 0) + 1;
  const item = { n: r.review_seq, title, note, status: 'waiting', agent, ...(compare && { compare }), versions: [{ v: 1, images: imgs, note, ...pkg, ...structureFields(structure), ...(files.length && { files }), at }], at, updated_at: at };
  r.reviews.push(item);
  save();
  return { n: item.n, item: pubItem(item), announced: await announceReview(roomId, item) };
}

/* New images or a new note = a new version (history kept) and the item waits again; a title
   is renamed in place. Sending what is already there changes nothing. */
export async function reviewUpdate(r, roomId, b) {
  const it = findReview(r, reviewN(b));
  const PKG = ['purpose', 'summary', 'ask', 'limits', 'files', 'alternatives', 'captions', 'scopes'];
  if (b.images === undefined && b.note === undefined && b.title === undefined && b.compare === undefined && !PKG.some((k) => b[k] !== undefined)) throw new AppError(400, 'give images, note, title, compare, purpose, summary, ask, limits, files, alternatives, captions or scopes');
  // compare (): the ORIGINAL the images are judged against — on the item, not a version; null removes it
  const compare = b.compare === undefined ? it.compare ?? null : b.compare === null ? null : (await reviewImages([b.compare]))[0];
  const compareChanged = (compare ?? null) !== (it.compare ?? null);
  if (compare) it.compare = compare;
  else delete it.compare;
  const title = b.title === undefined ? it.title : reviewTitle(b.title);
  const note = b.note === undefined ? undefined : str(b.note, 2000, 'note').trim();
  const imgs = b.images === undefined ? undefined : await reviewImages(b.images, roomId);
  const last = it.versions.at(-1);
  const at = new Date().toISOString();
  const files = await reviewFiles(b.files, last.files);
  const pkg = packageOf(b, last);
  const structure = structureOf(b, last, imgs ?? last.images);
  const next = { images: imgs ?? last.images, note: note ?? last.note, ...pkg, ...structureFields(structure), ...(files.length && { files }) };
  const sameFiles = JSON.stringify(files) === JSON.stringify(last.files ?? []);
  const sameStructure = JSON.stringify(structureFields(structure)) === JSON.stringify(structureFields({ alternatives: last.alternatives ?? [], captions: last.captions ?? {}, scopes: last.scopes ?? [] }));
  // a summary only counts as a change when the call gives one (omitting it is not "clear it")
  const samePkg = ['purpose', 'ask', 'limits', ...(b.summary !== undefined ? ['summary'] : [])].every((k) => (next[k] ?? '') === (last[k] ?? ''));
  const versioned = next.note !== last.note || next.images.join() !== last.images.join() || !sameFiles || !samePkg || !sameStructure;
  if (versioned) {
    it.versions.push({ v: last.v + 1, ...next, at });
    it.note = next.note;
    it.status = 'waiting';
  }
  if (versioned || title !== it.title || compareChanged) {
    it.title = title;
    it.updated_at = at;
    save();
  }
  return { item: pubItem(it), new_version: versioned, ...(versioned && { announced: await announceReview(roomId, it) }) };
}

export function reviewStatus(r, b) {
  const it = findReview(r, reviewN(b));
  if (!REVIEW_STATUS.includes(b.status)) throw new AppError(400, `status must be one of ${REVIEW_STATUS.join(', ')}`);
  if (it.status !== b.status) {
    it.status = b.status;
    it.updated_at = new Date().toISOString();
    save();
  }
  return { item: pubItem(it) };
}

/* Newest first (by n). */
export const reviewList = (r) => [...r.reviews].sort((a, b) => b.n - a.n).map(reviewSummary);
export const reviewListOut = (r) => ({ items: reviewList(r), unsent_ratings: unsentOf(r) });

/* Ratings are PER IMAGE and BATCHED ("👍 image 1, 👍 image 2 with a note on why I
   prefer it, 👎 image 3"). review_feedback {image, verdict?, comment?} — the USER's 👍/👎 and/or
   comment on ONE image from the panel (a briefing-table panel action, the design notes
   addendum 3; path param n; image 1-based in the item's current version) — SAVES that image's
   unsent draft: it.unsent = {v, images: {"<0-based index>": {verdict, comment, at}}}. Re-rating an
   image replaces only that image's draft; neither a verdict nor a comment DISCARDS it. Nothing goes
   to the room and the status stays. A draft on a newer version drops the older version's drafts.
   review_submit (no input) is the one send: every draft joins its version's feedback[] as
   {image, verdict, comment, at, sent_at}, those items turn replied, and ONE room line sums them up.
   Stored indices are 0-based; everything agents read (review_list, get_state, unsent_ratings, the
   line) says image 1-based ("img 2"). A rating from before per-image ratings has NO image: it was
   about the whole item, and stays readable as that (a pre-change unsent one sends as that too).
   No actor field anywhere: the engine fills that in later. */
const VERDICT = { up: '👍', down: '👎' };
const verOf = (it, v) => it.versions.find((x) => x.v === v) ?? it.versions.at(-1);
/* a pre-per-image unsent rating {v, verdict, comment, at} → {v, images: {}, item: {verdict, comment, at}} */
function legacyUnsent(it) {
  if (!it.unsent || it.unsent.images) return;
  const { v, ...item } = it.unsent;
  it.unsent = { v, images: {}, item };
}
/* an item's unsent drafts, oldest-style first: [{image?: 0-based, verdict, comment, at}] */
const draftsOf = (it) => (it.unsent
  ? [...(it.unsent.item ? [it.unsent.item] : []),
    ...(it.unsent.pick ? [{ pick: it.unsent.pick.alt, ...(it.unsent.pick.comment && { comment: it.unsent.pick.comment }), at: it.unsent.pick.at }] : []),
    ...Object.entries(it.unsent.scopes ?? {}).map(([scope, d]) => ({ scope, decision: d.decision, at: d.at })),
    ...Object.entries(it.unsent.images).sort((a, b) => a[0] - b[0]).map(([i, d]) => ({ image: Number(i), ...d }))]
  : []);
/* the agent-facing form of a rating: image 1-based + which Library image it is; no image = the whole item */
const pubRating = (f, ver) => (f.image === undefined ? f : { ...f, image: f.image + 1, image_id: ver.images[f.image] ?? null });
const pubUnsent = (it) => (it.unsent ? { v: it.unsent.v, ratings: draftsOf(it).map((d) => pubRating(d, verOf(it, it.unsent.v))) } : null);
const unsentOf = (r) => [...r.reviews].sort((a, b) => a.n - b.n).flatMap((it) => (pubUnsent(it)?.ratings ?? []).map((d) => ({ n: it.n, v: it.unsent.v, ...d })));
/* The user's answer about the WHOLE submission (unified review): a PICK between the version's alternatives ({pick: 'a' | 'none',
   comment?}; pick: null takes it back) or a decision on one SCOPE of whole-result acceptance ({scope: 'layout', decision:
   'approve' | 'changes'}; decision: null takes it back). Saved as unsent drafts beside the per-image ones and sent with them. A thumbs-up on
   one view never approves the whole result: that is what a scope decision is for. */
function reviewDecision(r, it, ver, b) {
  if (b.image !== undefined || b.verdict !== undefined) throw new AppError(400, 'pick and scope are about the whole submission: they take no image or verdict');
  if (b.pick !== undefined && b.scope !== undefined) throw new AppError(400, 'one answer per call: pick or scope');
  if (it.unsent && it.unsent.v !== ver.v) delete it.unsent; // drafts on a superseded version: this version starts afresh
  const at = new Date().toISOString();
  if (b.pick !== undefined) {
    if (!ver.alternatives?.length) throw new AppError(400, `#${it.n} v${ver.v} has no alternatives to pick between`);
    if (b.pick === null || b.pick === '') {
      if (it.unsent) delete it.unsent.pick;
    } else {
      if (b.pick !== 'none' && !ver.alternatives.some((a) => a.id === b.pick)) throw new AppError(400, `pick must be one of ${ver.alternatives.map((a) => `'${a.id}'`).join(', ')} or 'none' (or null / '' to take it back)`);
      const comment = b.comment === undefined || b.comment === null ? '' : str(b.comment, 2000, 'comment').trim();
      (it.unsent ??= { v: ver.v, images: {} }).pick = { alt: b.pick, ...(comment && { comment }), at };
    }
  } else {
    if (!ver.scopes?.includes(b.scope)) throw new AppError(400, `scope must be one of ${ver.scopes?.length ? ver.scopes.join(', ') : '(this version declares none)'}`);
    if (b.decision === undefined) throw new AppError(400, "decision must be 'approve' or 'changes' (or null / '' to take it back)");
    if (b.decision === null || b.decision === '') {
      if (it.unsent?.scopes) delete it.unsent.scopes[b.scope];
    } else {
      if (b.decision !== 'approve' && b.decision !== 'changes') throw new AppError(400, "decision must be 'approve' or 'changes' (or null / '' to take it back)");
      ((it.unsent ??= { v: ver.v, images: {} }).scopes ??= {})[b.scope] = { decision: b.decision, at };
    }
  }
  if (it.unsent && !Object.keys(it.unsent.images).length && !it.unsent.item && !it.unsent.pick && !Object.keys(it.unsent.scopes ?? {}).length) delete it.unsent;
  if (it.unsent?.scopes && !Object.keys(it.unsent.scopes).length) delete it.unsent.scopes;
  save();
  return { item: pubItem(it), unsent: pubUnsent(it), unsent_count: unsentOf(r).length };
}
export function reviewFeedback(r, n, b) {
  const extra = Object.keys(b).find((k) => !['verdict', 'comment', 'image', 'pick', 'scope', 'decision'].includes(k));
  if (extra) throw new AppError(400, `unknown field '${extra}' — review_feedback takes image, verdict, comment (a rating), or pick, or scope and decision`);
  const it = findReview(r, n);
  const ver = it.versions.at(-1);
  if (b.pick !== undefined || b.scope !== undefined) return reviewDecision(r, it, ver, b);
  const k = typeof b.image === 'number' || (typeof b.image === 'string' && /^\s*\d{1,2}\s*$/.test(b.image)) ? Number(b.image) : NaN;
  if (!Number.isInteger(k) || k < 1 || k > ver.images.length) {
    throw new AppError(400, `image must be 1–${ver.images.length}: which image of #${it.n} v${ver.v} this rating is for`);
  }
  const verdict = b.verdict === undefined || b.verdict === null || b.verdict === '' ? null : b.verdict;
  if (verdict !== null && !Object.hasOwn(VERDICT, verdict)) throw new AppError(400, "verdict must be 'up' or 'down' (or left out, with a comment)");
  if (typeof b.comment === 'string' && b.comment.length > 2000) throw new AppError(413, 'comment is over 2000 characters');
  const comment = b.comment === undefined || b.comment === null ? '' : str(b.comment, 2000, 'comment').trim();
  if (it.unsent && it.unsent.v !== ver.v) delete it.unsent; // drafts on a superseded version: this version starts afresh
  const had = !!it.unsent?.images[k - 1];
  if (verdict || comment) (it.unsent ??= { v: ver.v, images: {} }).images[k - 1] = { verdict, comment, at: new Date().toISOString() };
  else if (it.unsent) {
    delete it.unsent.images[k - 1];
    if (!Object.keys(it.unsent.images).length && !it.unsent.item && !it.unsent.pick && !Object.keys(it.unsent.scopes ?? {}).length) delete it.unsent;
  }
  save();
  const d = it.unsent?.images[k - 1];
  return { item: pubItem(it), image: k, draft: d ? pubRating({ image: k - 1, ...d }, ver) : null, unsent: pubUnsent(it), ...(!verdict && !comment && { discarded: had }), unsent_count: unsentOf(r).length };
}

/* review_submit — ONE line per REQUESTER (briefing-table task): POST .../reviews/submit/:requester
   sends that agent's drafts only, addressed to it (roomLine.to), with the ratings as roomLine.data;
   the old bare .../reviews/submit still works while every draft has one requester, else 409.
   The text, as before, for the drafts it sends:
     one item:  'reviewed #2 — img 1 👍, img 2 👍, img 3 👎 (comments on img 2, img 3)'
     several:   'reviewed 3 items, 7 images — 5 👍, 2 👎 (comments on #2·img2, #5·img1)'
   linked to the rated items (≤ 8, the engine's cap: one with a comment or a 👎 first). ≤ 1000
   characters (the comment list is capped). The engine posts it; nothing is marked sent before. */
const LINE_LINKS_MAX = 8;
const COMMENTS_MAX = 20;
const REQUESTER = /^[A-Za-z0-9_-]{1,64}$/;
let submitting = false;
const NOTE_MAX = 1500;
export async function reviewSubmit(r, roomId, b, who) {
  const extra = Object.keys(b).find((k) => k !== 'note');
  if (extra !== undefined) throw new AppError(400, `unknown field '${extra}' — review_submit takes only note`);
  // the user's one note or instructions for the requester, sent with the ratings ()
  if (b.note !== undefined && typeof b.note !== 'string') throw new AppError(400, 'note must be a string');
  const note = (b.note ?? '').trim();
  if (note.length > NOTE_MAX) throw new AppError(400, `note is ${note.length} characters (max ${NOTE_MAX})`);
  if (who !== undefined && !REQUESTER.test(who)) throw new AppError(400, 'requester must match [A-Za-z0-9_-]{1,64}');
  const pending = r.reviews.filter((it) => it.unsent || marksPending(it));
  if (!pending.length) throw new AppError(400, 'nothing to send — no unsent ratings or marks');
  const groups = [...new Set(pending.map(requesterOf))];
  if (who === undefined && groups.length > 1) {
    throw new AppError(409, `several requesters — send per requester (${groups.map((g) => `@${g}`).join(', ')})`, { reason: 'several-requesters', requesters: groups });
  }
  const to = who ?? groups[0];
  const batch = pending.filter((it) => requesterOf(it) === to).sort((a, b) => a.n - b.n).map((it) => ({ it, ds: draftsOf(it) }));
  if (!batch.length) throw new AppError(400, `nothing to send for @${to} — its requesters now: ${groups.map((g) => `@${g}`).join(', ')}`);
  return sendBatch(r, batch, note, to);
}
/* review_send (v3 nav, Aurora 13f29fb): ONE review's Submit, from its summary — its unsent ratings and the
   user's overall note (the item's note draft, review_note), as ONE line to the agent that asked for it.
   Nothing to send (no rating, no new note) = 400. */
export async function reviewSend(r, roomId, n, b) {
  const extra = Object.keys(b).find((k) => k !== 'note');
  if (extra !== undefined) throw new AppError(400, `unknown field '${extra}' — review_send takes only note`);
  const it = findReview(r, n);
  const note = (b.note !== undefined ? str(b.note, NOTE_MAX, 'note') : it.note_draft ?? '').trim();
  const ds = draftsOf(it);
  if (!ds.length && !marksPending(it) && (!note || note === it.note_sent)) throw new AppError(400, `nothing to send on #${it.n} — no unsent ratings or marks and no new note`);
  return sendBatch(r, [{ it, ds }], note, requesterOf(it));
}
/* review_note: the user's overall note on one review, saved as they type (a panel action); sent by review_send.
   An empty note discards the draft. */
export function reviewNote(r, n, b) {
  const extra = Object.keys(b).find((k) => k !== 'note');
  if (extra !== undefined) throw new AppError(400, `unknown field '${extra}' — review_note takes only note`);
  const it = findReview(r, n);
  if (typeof b.note !== 'string') throw new AppError(400, 'note must be a string');
  if (b.note.length > NOTE_MAX) throw new AppError(400, `note is ${b.note.length} characters (max ${NOTE_MAX})`);
  const note = b.note.trim();
  if (note && note !== it.note_sent) it.note_draft = note;
  else delete it.note_draft;
  save();
  return { n: it.n, note_draft: it.note_draft ?? null, note_sent: it.note_sent ?? null };
}
async function sendBatch(r, batch, note, to) {
  if (submitting) throw new AppError(409, 'a review is already being sent');
  const all = batch.flatMap(({ it, ds }) => ds.map((d) => ({ it, d })));
  const mark = (d) => VERDICT[d.verdict] ?? '💬';
  const altOf = (it, d) => it.versions.at(-1).alternatives?.find((a) => a.id === d.pick);
  const pickWord = (it, d) => (d.pick === 'none' ? 'picked neither' : `picked ${d.pick.toUpperCase()}${altOf(it, d) ? ` · ${altOf(it, d).label}` : ''}`);
  const scopeWord = (d) => `${d.scope} ${d.decision === 'approve' ? '✓' : '✗'}`;
  const isWhole = (d) => d.pick !== undefined || d.scope !== undefined;
  const list = (xs) => (xs.length > COMMENTS_MAX ? [...xs.slice(0, COMMENTS_MAX), `+${xs.length - COMMENTS_MAX} more`] : xs).join(', ');
  const commentsOn = (xs) => (xs.length ? ` (comment${xs.length > 1 ? 's' : ''} on ${list(xs)})` : '');
  let summary;
  if (batch.length === 1) {
    const { it, ds } = batch[0];
    const who = (d) => (d.pick !== undefined ? 'pick' : d.scope !== undefined ? d.scope : d.image === undefined ? 'whole item' : `img ${d.image + 1}`);
    const say = (d) => (d.pick !== undefined ? pickWord(it, d) : d.scope !== undefined ? scopeWord(d) : `${who(d)} ${mark(d)}`);
    const spots = marksUnsent(it).map((m) => m.label), gone = it.marks_gone ?? [];
    const marked = [spots.length && `${spots.every((l) => it.marks.find((m) => m.label === l)?.kind === '3d') ? 'pin' : 'mark'}${spots.length > 1 ? 's' : ''} ${spots.join(', ')}`, gone.length && `removed ${gone.join(', ')}`].filter(Boolean).join('; ');
    summary = ds.length ? `reviewed #${it.n} — ${ds.map(say).join(', ')}${commentsOn(ds.filter((d) => d.comment).map(who))}` : marked ? `reviewed #${it.n} — ${marked}` : `reviewed #${it.n}`;
  } else {
    const imgs = all.filter(({ d }) => d.image !== undefined).length;
    const count = (k) => all.filter(({ d }) => !isWhole(d) && d.verdict === k).length;
    const picks = all.filter(({ d }) => d.pick !== undefined).length, scopes = all.filter(({ d }) => d.scope !== undefined).length;
    const tally = [[count('up'), '👍'], [count('down'), '👎'], [count(null), 'comment-only'], [picks, picks > 1 ? 'picks' : 'pick'], [scopes, scopes > 1 ? 'scope decisions' : 'scope decision']].filter(([c]) => c).map(([c, w]) => `${c} ${w}`);
    const commented = all.filter(({ d }) => d.comment).map(({ it, d }) => (d.image === undefined ? `#${it.n}` : `#${it.n}·img${d.image + 1}`));
    summary = `reviewed ${batch.length} items${imgs ? `, ${imgs} image${imgs > 1 ? 's' : ''}` : ''} — ${tally.join(', ')}${commentsOn(commented)}`;
  }
  const first = (x) => (x.ds.some((d) => d.comment || d.verdict === 'down') ? 0 : 1);
  const links = [...batch].sort((a, b) => first(a) - first(b)).slice(0, LINE_LINKS_MAX).map((x) => ({ label: `#${x.it.n}`, path: `review/${x.it.n}` }));
  // task: the ENGINE posts this as the user's own line ("via <app>") from the action's roomLine
  // (tool.json postsToRoom). ≤ 1000 chars or the engine drops it.
  const marks = batch.reduce((a, { it }) => a + (it.marks?.length ?? 0), 0);
  if (marks && batch.some(({ ds }) => ds.length)) summary += ` · ${marks} mark${marks > 1 ? 's' : ''}`; // pins alone: the line already names them
  batch.forEach(({ it }) => numbered(r, it));
  const data = reviewData(batch, note); // before the drafts are cleared
  const at = new Date().toISOString();
  for (const { it, ds } of batch) {
    if (it.unsent) {
      const ver = verOf(it, it.unsent.v);
      (ver.feedback ??= []).push(...ds.map((d) => ({ ...d, sent_at: at })));
      delete it.unsent;
    }
    (it.marks ?? []).forEach((m) => { m.sent_at = at; }); // every mark is now with the agent; so is every removal
    delete it.marks_gone;
    if (batch.length === 1 && note) it.note_sent = note; // the one review's overall note (review_send)
    delete it.note_draft;
    it.sent = { to, at };
    it.status = 'replied';
    it.updated_at = at;
  }
  save();
  const text = note ? `${summary} — note: “${note.length > 400 ? `${note.slice(0, 400)}…` : note}”` : summary; // the whole note is in data
  return { submitted: all.length, items: batch.length, requester: to, summary, ...(note && { note }), roomLine: { text: text.slice(0, 1000), links, ...(to && { to }), data } };
}
/* roomLine.data: the sent ratings for the agent (the engine hands it over as a fenced "not
   instructions" block; people never see it) — {app, reviews:[{n, v, title, ratings:[{image,
   verdict, comment?}]}]}, ≤ 4096 bytes as JSON. Over that: comments are cut shorter and shorter
   (truncated:true), then titles go and the last items are left out (more: <count>). */
const DATA_MAX = 4096;
function reviewData(batch, note = '') {
  const clip = (c, k) => (c.length > k ? `${c.slice(0, k)}…` : c);
  /* the marks of an item in the response: image marks as ever; pins as a summary ('full': label, which model, the point, the node, the comment;
     'lite': no comment or node; 'count': just how many) — the whole list is always readable with review_marks, so this line is a summary */
  const markData = (it, nums, lvl) => {
    if (!it.marks?.length) return {};
    const img = it.marks.filter((m) => m.kind !== '3d').map((m) => ({ label: m.label, image: nums[m.image] ?? null, x: m.x, y: m.y }));
    const pins = it.marks.filter((m) => m.kind === '3d');
    return {
      ...(img.length && { marks: img }),
      ...(pins.length && lvl !== 'count' && { pins: pins.map((m) => ({ label: m.label, mesh: nums[m.mesh] ?? null, point: m.point, ...(lvl === 'full' && { node: m.node, ...(m.comment && { comment: m.comment }) }) })) }),
      ...(pins.length && lvl === 'count' && { pins_count: pins.length }),
    };
  };
  const build = (k, titles, count, lvl = 'full') => ({
    app: 'asset-studio',
    ...(note && { note }),
    reviews: batch.slice(0, count).map(({ it, ds }) => {
      const ver = verOf(it, it.unsent?.v ?? it.versions.at(-1).v), nums = it.nums || {};
      return {
        n: it.n, v: it.unsent?.v ?? it.versions.at(-1).v, ...(titles && { title: it.title }),
        ratings: ds.map((d) => ({
          ...(d.image !== undefined && { image: d.image + 1, num: nums[ver.images[d.image]] ?? null }),
          ...(d.pick !== undefined && { pick: d.pick, ...(ver.alternatives?.find((a) => a.id === d.pick) && { alternative: ver.alternatives.find((a) => a.id === d.pick).label }) }),
          ...(d.scope !== undefined && { scope: d.scope, decision: d.decision }),
          ...(d.pick === undefined && d.scope === undefined && { verdict: d.verdict ?? null }),
          ...(d.comment && k > 0 && { comment: clip(d.comment, k) }),
        })),
        // the numbers the user sees ("#6") → image ids, and the marks: {label, image: its number, x, y} (fractions from the top left)
        images: Object.fromEntries(Object.entries(nums).map(([id, num]) => [num, id])),
        ...markData(it, nums, lvl),
        ...(marksUnsent(it).length && { marks_new: marksUnsent(it).map((m) => m.label) }), // the labels placed or changed since the last Send
        ...(it.marks_gone?.length && { marks_removed: it.marks_gone }),
      };
    }),
    ...(count < batch.length && { more: batch.length - count }),
  });
  const fits = (d) => Buffer.byteLength(JSON.stringify(d)) <= DATA_MAX;
  const whole = build(Infinity, true, batch.length);
  if (fits(whole)) return whole;
  for (const [k, lvl] of [[600, 'full'], [300, 'full'], [120, 'full'], [40, 'full'], [0, 'full'], [0, 'lite'], [0, 'count']]) {
    const d = { ...build(k, true, batch.length, lvl), truncated: true };
    if (fits(d)) return d;
  }
  for (let count = batch.length; ; count--) {
    const d = { ...build(0, false, count, 'count'), truncated: true };
    if (fits(d) || count === 0) return d;
  }
}
/* get_state: each image's latest SENT rating on its item's current version (a whole-item one from
   before per-image ratings shows once, without image) */
function feedbackOf(r) {
  return (r.reviews || []).flatMap((it) => {
    const v = it.versions.at(-1);
    const last = new Map((v.feedback ?? []).map((f) => [f.pick !== undefined ? 'pick' : f.scope !== undefined ? `scope:${f.scope}` : f.image ?? 'item', f]));
    return [...last.values()].map((f) => ({ n: it.n, v: v.v, status: it.status, ...pubRating(f, v) }));
  });
}

/* review_marks (GET .../reviews/:n/marks): every mark on an item IN FULL — the agent's read of the pins (the response line is only a summary) */
export function reviewMarksOf(r, n) {
  const it = findReview(r, n);
  numbered(r, it);
  return { n: it.n, title: it.title, status: it.status, marks: pubMarks(it), note: 'pin points are in the GLB scene frame (glTF: Y up, metres); `blender` stays null until the exporter\'s <glb>.glb.map.json is applied' };
}

export function reviewRemove(r, b) {
  const it = findReview(r, reviewN(b));
  r.reviews = r.reviews.filter((x) => x !== it);
  save();
  return { removed: it.n };
}

/* GET /rooms/:roomId/review/:n/thumb — the latest version's first image as a 96 px square
   (cover crop) JPEG, for briefing-table's chat link rows. Small by construction (≤64 KB). */
const reviewThumbs = new Map(); // library id -> jpeg bytes (a few KB each)
export async function reviewThumb(r, n) {
  const id = findReview(r, n).versions.at(-1).images[0];
  if (!reviewThumbs.has(id)) {
    const mr = models.room(r.roomId);
    const { bytes } = models.meshOf(mr, id) ? await models.libraryBytes(mr, id, 'thumb') : await images.libraryBytes(images.room(r.roomId), id, 'thumb', true);
    let jpg;
    try {
      jpg = execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-vf', 'scale=96:96:force_original_aspect_ratio=increase,crop=96:96',
        '-frames:v', '1', '-q:v', '4', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { input: bytes, maxBuffer: 8 << 20 });
    } catch (err) {
      throw new AppError(502, `could not make a thumbnail of ${id}: ${String(err.stderr || err.message).split('\n')[0]}`);
    }
    if (reviewThumbs.size > 200) reviewThumbs.clear();
    reviewThumbs.set(id, jpg);
  }
  return { type: 'image/jpeg', bytes: reviewThumbs.get(id) };
}

/* GET /rooms/:roomId/links?refs=review/1,review/2/v1 — what a room line's link chips show,
   in the refs' order (briefing-table's link contract). State lookup only. */
const LINKS_MAX = 8;
export function links(r, refsParam) {
  const refs = String(refsParam ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!refs.length) throw new AppError(400, 'refs is empty — ?refs=review/1,review/2');
  if (refs.length > LINKS_MAX) throw new AppError(400, `at most ${LINKS_MAX} refs`);
  return refs.map((ref) => {
    const w = /^watch\/([A-Za-z0-9_.-]{1,80})$/.exec(ref);
    if (w) return { ref, label: `Watch · ${w[1]}` }; // a run's live Watch view (the job list is the share's, not checked here)
    const m = /^review\/(\d{1,9})(?:\/v(\d{1,6}))?$/.exec(ref);
    if (!m) return { ref, stale: true, note: 'not a link this tool knows' };
    const it = r.reviews.find((x) => x.n === Number(m[1]));
    if (!it) return { ref, stale: true, note: `Review #${m[1]} was removed` };
    const latest = it.versions.at(-1).v;
    const v = m[2] === undefined ? latest : Number(m[2]);
    return {
      ref, label: `#${it.n} ${it.title}`, state: it.status, thumb: `review/${it.n}/thumb`,
      ...(v > latest || v < 1 ? { stale: true, note: `v${v} is not a version of #${it.n}` } : v < latest ? { note: `superseded by v${latest}` } : {}),
    };
  });
}

/* ------------------------------------------------- what the server composes -- */

/* panel.json's review part: the list always; on the Review tab every version of every item */
export function panelPart(r, tab) {
  return {
    reviews: reviewList(r),
    ...(tab === 'review' && { review_items: r.reviews.map((it) => {
      const info = reviewInfo(r, it);
      if (reviewNums(it, info)) save();
      const mr = models.room(r.roomId);
      const meshes = Object.fromEntries([...new Set(it.versions.flatMap((v) => v.images))].map((id) => [id, models.meshOf(mr, id)]).filter(([, a]) => a && a.category === 'mesh').map(([id, a]) => [id, a.view]));
      return { n: it.n, title: it.title, status: it.status, purpose: purposeOf(it), needs: needsResponse(it), agent: it.agent, requester: requesterOf(it), compare: it.compare ?? null, versions: it.versions.map((v) => pubVer(it, v)), unsent: it.unsent ?? null, info,
        nums: it.nums, marks: it.marks || [], marks_unsent: marksUnsent(it).map((m) => m.label), marks_gone: it.marks_gone ?? [], user_refs: (it.user_refs || []).map((u) => u.id), meshes,
        note_draft: it.note_draft ?? null, note_sent: it.note_sent ?? null, sent: it.sent ?? null };
    }) }),
  };
}
/* get_state's review part */
export const stateParts = (r) => ({ feedback: feedbackOf(r), unsent_ratings: unsentOf(r) });
/* does a review show this asset (the panel's byte routes serve it)? */
export const has = (r, id) => reviewImageIds(r).has(id);
