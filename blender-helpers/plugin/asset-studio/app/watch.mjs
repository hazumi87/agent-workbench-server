/*
 * The Watch tab's read-only door to the file share. An operator agent runs Blender steps on another
 * machine and a tool writes "watch" data to the share after each one (config watchBase):
 *
 *   <base>/index.json                    {jobs:[{job, updated, steps}]}  newest first (absent = nothing yet)
 *   <base>/<job>/manifest.json           {job, updated, latest, cameras:[{id, label, position?, target?, fov?}],
 *                                         steps:[{n, verb, at, note, frames:{<camera>: path}}], model:{file, step}}
 *   <base>/<job>/frames/<camera>/<n>.jpg one picture per camera per step (never changes) — or, when the capture
 *   <base>/<job>/frames/<camera>/<mode>/<n>.jpg   renders display modes (manifest.modes; steps[].frames[camera] is then
 *                                        an object {<mode>: path} instead of a string)
 *   <base>/<job>/model/latest.glb        a light preview model, overwritten each step
 *   <base>/<job>/model/reference.glb     the reference model (manifest.reference {file, solid, grid}), written once per job
 *   <base>/<job>/looks/<n>/<file>.jpg    the pictures the operator itself opened at step n (steps[].looks[].file / .wide)
 *
 * The browser can't read the share (another origin, and the panel frame is sandboxed), so the app
 * proxies it: GET only, and every name that reaches the share's URL is checked here first — a job, a
 * camera and a step number are the only things a caller picks, each by a strict pattern, so no path
 * segment can escape. A share that is down, slow or sending rubbish is an answer, never a crash.
 */
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readConfig } from './config.mjs';
import { AppError } from './shared.mjs';

const JOB = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CAMERA = /^[a-z0-9_-]{1,32}$/;
const MODE = /^[a-z0-9_-]{1,32}$/;
const STEP = /^[0-9]{1,9}$/;
const LOOK = /^(?!.*\.\.)[A-Za-z0-9._-]{1,160}\.jpg$/; // a picture the operator opened: <label>-<ms>.jpg or -wide.jpg
const JSON_MS = 5000;
const FILE_MS = 20000;
const JSON_MAX = 2 * 1024 * 1024;
const FILE_MAX = 20 * 1024 * 1024; // the panel's proxy cap, as for the Library's bytes
const JOBS_MAX = 100;

export const isJob = (s) => JOB.test(s ?? '');

/* GET <base>/<rel> → the Response, or an AppError (503 no config / unreachable, 504 slow). */
async function upstream(rel, ms) {
  const base = readConfig().watchBase;
  if (!base) throw new AppError(503, 'the watch share is not configured (watchBase)');
  try {
    return await fetch(`${base}/${rel}`, { signal: AbortSignal.timeout(ms), redirect: 'error' });
  } catch (e) {
    throw new AppError(e.name === 'TimeoutError' ? 504 : 503, e.name === 'TimeoutError' ? 'the watch share is too slow' : `the watch share is unreachable (${e.cause?.code || e.name})`);
  }
}

/* The share's JSON (≤ 2 MB) as an object, or null for a 404. */
async function getJson(rel) {
  const f = await upstream(rel, JSON_MS);
  if (f.status === 404) {
    await f.body?.cancel();
    return null;
  }
  if (!f.ok) {
    await f.body?.cancel();
    throw new AppError(502, `the watch share answered HTTP ${f.status}`);
  }
  try {
    const buf = Buffer.from(await f.arrayBuffer());
    if (buf.length > JSON_MAX) throw new Error('too big');
    const j = JSON.parse(buf.toString('utf8'));
    if (j && typeof j === 'object' && !Array.isArray(j)) return j;
  } catch {
    /* below */
  }
  throw new AppError(502, `the watch share sent ${rel} in a form this app can't read`);
}

/* index.json → {jobs}, only well-formed rows. No index (404) is the normal empty state; a share
   that can't be reached is {jobs: [], error}. */
export async function index() {
  try {
    const j = await getJson('index.json');
    const jobs = (Array.isArray(j?.jobs) ? j.jobs : []).filter((x) => x && typeof x.job === 'string' && JOB.test(x.job))
      .slice(0, JOBS_MAX).map((x) => ({ job: x.job, updated: typeof x.updated === 'string' ? x.updated : null, steps: Number.isFinite(x.steps) ? x.steps : null }));
    return { jobs };
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return { jobs: [], error: e.message };
  }
}

/* One job's manifest. 400 for a bad name, 404 when the share has no such job. */
export async function manifest(job) {
  if (!JOB.test(job)) throw new AppError(400, 'job must be lowercase letters, digits and dashes (≤ 64)');
  const j = await getJson(`${job}/manifest.json`);
  if (!j) throw new AppError(404, 'no such job on the watch share');
  return j;
}

/* kind: 'frame' (camera, n, mode?), 'look' (n, file in the camera slot's place: see below), 'model' or 'reference' → {type, cache, rel}.
   400 for any name that is not strictly valid. A look is <job>/looks/<n>/<file>: fileRef(job, 'look', file, n). */
export function fileRef(job, kind, camera, n, mode) {
  if (!JOB.test(job)) throw new AppError(400, 'job must be lowercase letters, digits and dashes (≤ 64)');
  if (kind === 'model') return { type: 'model/gltf-binary', cache: 'no-cache', rel: `${job}/model/latest.glb` };
  if (kind === 'reference') return { type: 'model/gltf-binary', cache: 'no-cache', rel: `${job}/model/reference.glb` }; // written once, but a re-run may replace it: revalidate
  if (kind === 'look') {
    if (!STEP.test(n ?? '')) throw new AppError(400, 'step must be digits');
    if (!LOOK.test(camera ?? '')) throw new AppError(400, 'look must be a .jpg name of letters, digits, . - or _ (≤ 160)');
    // like frames, a look is never rewritten (its name carries the time it was made)
    return { type: 'image/jpeg', cache: 'public, max-age=31536000, immutable', rel: `${job}/looks/${Number(n)}/${camera}` };
  }
  if (!CAMERA.test(camera ?? '')) throw new AppError(400, 'camera must be lowercase letters, digits, - or _ (≤ 32)');
  if (mode !== undefined && !MODE.test(mode)) throw new AppError(400, 'mode must be lowercase letters, digits, - or _ (≤ 32)');
  if (!STEP.test(n ?? '')) throw new AppError(400, 'step must be digits');
  // frames never change: cache them for good
  return { type: 'image/jpeg', cache: 'public, max-age=31536000, immutable', rel: `${job}/frames/${camera}/${mode === undefined ? '' : `${mode}/`}${Number(n)}.jpg` };
}

/* Stream a file from the share to res (≤ 20 MB; 20 s in all). */
export async function sendFile(res, ref, headers) {
  const f = await upstream(ref.rel, FILE_MS);
  if (f.status === 404) {
    await f.body?.cancel();
    throw new AppError(404, 'not on the watch share');
  }
  if (!f.ok || !f.body) {
    await f.body?.cancel();
    throw new AppError(502, `the watch share answered HTTP ${f.status}`);
  }
  const len = Number(f.headers.get('content-length'));
  if (len > FILE_MAX) {
    await f.body.cancel();
    throw new AppError(413, 'over the panel\'s 20 MB');
  }
  res.writeHead(200, { 'content-type': ref.type, 'cache-control': ref.cache, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...(len > 0 && { 'content-length': len }), ...headers });
  let seen = 0;
  const src = Readable.fromWeb(f.body);
  src.on('data', (c) => {
    seen += c.length;
    if (seen > FILE_MAX) src.destroy(new Error('over the panel\'s 20 MB'));
  });
  try {
    await pipeline(src, res);
  } catch {
    res.destroy(); // headers are out: the only honest answer to a failed stream is a cut one
  }
}
