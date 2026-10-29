/*
 * review_look — a review as the user sees it, in pictures, for a resident that cannot run a browser script.
 * One verb: app/look.mjs checks the options, runs scripts/review-look.mjs (headless Chromium, its own
 * process group, 90 s cap, one at a time) and keeps the pictures under work/look/<run>/. The last
 * LOOK_KEEP runs are kept. The panel is shown as this app serves it, not inside the room's own frame.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readConfig, ROOT, WORK_DIR } from './config.mjs';
import { AppError } from './shared.mjs';
import * as models from './models.mjs';
import { findReview, room as reviewRoom } from './reviews.mjs';

const LOOK_DIR = path.join(WORK_DIR, 'look');
const LOOK_KEEP = 5, LOOK_MS = 90000;
const MB = 1048576;

/* Memory guard. The server has little headroom and no swap, and a browser on a big model can take all of it
   (an out-of-memory condition can restart other services). Free memory is MemAvailable;
   ASSET_STUDIO_MEMINFO points the reading elsewhere (tests). Null = unreadable, which refuses. */
export function memAvailableMb() {
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(fs.readFileSync(process.env.ASSET_STUDIO_MEMINFO || '/proc/meminfo', 'utf8'));
    return m ? Math.floor(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
export function limits(cfg) {
  return { minMb: num(cfg.lookMinMemMb, 2560), bigModelMb: num(cfg.lookBigModelMb, 10), bigMinMb: num(cfg.lookBigMinMemMb, 6144), killMb: num(cfg.lookKillMemMb, 1024) };
}

/* What to do before starting a browser: {floorMb, no3d, notes} or throws the 503. modelBytes = the viewer copy's
   size of the biggest model the review shows (null = none, or shown as a picture). */
export function plan(o, modelBytes, availMb, lim) {
  const big = modelBytes !== null && modelBytes > lim.bigModelMb * MB;
  const wants3d = big && o.big_model === true;
  const floorMb = wants3d ? lim.bigMinMb : lim.minMb;
  if (availMb === null) throw new AppError(503, 'cannot read the free memory, so no browser was started', { reason: 'low-memory' });
  if (availMb < floorMb) throw new AppError(503, `not enough free memory for a browser right now: ${(availMb / 1024).toFixed(1)} GB available, ${(floorMb / 1024).toFixed(1)} GB needed`, { reason: 'low-memory', available_mb: availMb, needed_mb: floorMb });
  const notes = big && !wants3d ? [`the model is ${(modelBytes / MB).toFixed(0)} MB, over the ${lim.bigModelMb} MB limit, so its 3D view was skipped (pass big_model: true to open it; that needs ${(lim.bigMinMb / 1024).toFixed(1)} GB free)`] : [];
  return { floorMb, no3d: big && !wants3d, notes };
}
export const LOOK_FILE = /^(\d{3,4}-(?:list|summary|focus|aim|pin|pin-unsaved))\.png$/;
let busy = false;

function options(b) {
  const widths = b.widths === undefined ? [370, 900] : b.widths;
  if (!Array.isArray(widths) || !widths.length || widths.length > 2 || !widths.every((w) => Number.isInteger(w) && w >= 320 && w <= 1400)) throw new AppError(400, 'widths: one or two whole numbers, 320 to 1400 (default [370, 900])');
  const mode = b.mode ?? 'dark';
  if (mode !== 'dark' && mode !== 'light') throw new AppError(400, 'mode: dark or light');
  const views = b.views === undefined ? ['list', 'summary', 'focus'] : b.views;
  if (!Array.isArray(views) || !views.length || !views.every((v) => ['list', 'summary', 'focus'].includes(v))) throw new AppError(400, 'views: any of list, summary, focus');
  const image = b.image === undefined ? null : b.image;
  if (image !== null && (!Number.isInteger(image) || image < 0 || image > 11)) throw new AppError(400, 'image: the view to focus, counted from 0 in the review\'s image order (default: the 3D model if there is one, else the first view)');
  let pin_at = null;
  if (b.pin_at !== undefined && b.pin_at !== null && b.pin_at !== '') {
    const m = /^\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)\s*$/.exec(String(b.pin_at));
    pin_at = m && Number(m[1]) <= 1 && Number(m[2]) <= 1 ? [Number(m[1]), Number(m[2])] : null;
    if (!pin_at) throw new AppError(400, 'pin_at: "x,y" as fractions of the 3D view, each 0 to 1, e.g. "0.5,0.6"');
  }
  return { widths, mode, views, image, pin_at, save: b.save === true, big_model: b.big_model === true };
}

function keepLast() {
  try {
    const runs = fs.readdirSync(LOOK_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    for (const r of runs.slice(0, Math.max(0, runs.length - LOOK_KEEP))) fs.rmSync(path.join(LOOK_DIR, r), { recursive: true, force: true });
  } catch { /* nothing to prune */ }
}

/* review_look: the pictures, as paths and URLs (a picture is fetched from its URL; the verbs themselves never carry bytes). */
export async function reviewLook(roomId, n, b, port) {
  const o = options(b);
  if (busy) throw new AppError(409, 'a look is already running — try again in a minute');
  const cfg = readConfig();
  const mr = models.room(roomId);
  const ver = findReview(reviewRoom(roomId), n).versions.at(-1);
  const sizes = ver.images.map((id) => models.viewerBytes(mr, id)).filter((x) => x !== null);
  const lim = limits(cfg);
  const pl = plan(o, sizes.length ? Math.max(...sizes) : null, memAvailableMb(), lim);
  const playwright = cfg.playwright;
  if (!playwright) throw new AppError(503, 'no browser available here (set "playwright" in config.local.json)', { reason: 'no-browser' });
  busy = true;
  const run = Date.now().toString(36);
  const out = path.join(LOOK_DIR, run);
  try {
    const arg = JSON.stringify({ ...o, base: `http://127.0.0.1:${port}/rooms/${encodeURIComponent(roomId)}`, n, out, playwright, no3d: pl.no3d });
    let starved = false, left = null;
    const stdout = await new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'review-look.mjs'), arg], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let s = '';
      c.stdout.on('data', (d) => { s = (s + d).slice(-200000); });
      const kill = () => { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } };
      const t = setTimeout(() => { kill(); resolve(''); }, LOOK_MS);
      const w = setInterval(() => { // about once a second: stop before the box runs out
        const a = memAvailableMb();
        if (a === null || a < lim.killMb) { starved = true; left = a; kill(); }
      }, 1000);
      const end = () => { clearTimeout(t); clearInterval(w); resolve(s); };
      c.on('close', end);
      c.on('error', end);
    });
    if (starved) throw new AppError(503, `stopped: free memory fell to ${left === null ? 'an unreadable value' : `${left} MB`} (limit ${lim.killMb} MB), so the browser was killed`, { reason: 'low-memory', available_mb: left });
    let res = null;
    try { res = JSON.parse(stdout.trim().split('\n').pop()); } catch { /* below */ }
    if (!res) throw new AppError(504, 'the look did not finish in 90 seconds', { reason: 'timeout' });
    if (!res.ok) throw new AppError(/no browser/.test(res.error) ? 503 : 502, res.error, { reason: /no browser/.test(res.error) ? 'no-browser' : 'look-failed' });
    keepLast();
    const url = (f) => `http://127.0.0.1:${port}/rooms/${encodeURIComponent(roomId)}/look/${run}/${f}`;
    return {
      run, mode: o.mode,
      pictures: res.pictures.map((p) => ({ ...p, path: path.join(out, p.file), url: url(p.file) })),
      pin: res.pin, notes: [...pl.notes, ...res.notes, 'the panel as the app serves it — not inside the room\'s own frame'],
    };
  } finally {
    busy = false;
  }
}

export function lookFile(run, file) {
  if (!/^[a-z0-9]{1,12}$/.test(run) || !LOOK_FILE.test(file)) return null;
  try { return fs.readFileSync(path.join(LOOK_DIR, run, file)); } catch { return null; }
}
