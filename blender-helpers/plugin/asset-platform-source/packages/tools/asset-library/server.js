// asset-library — relational index over a curated asset store, audio-first.
// Files live in the data directory; this service owns a sibling SQLite index (node:sqlite,
// built into Node 22; tested with 22.23.1) and serves assets BY ID — no session cookie, so
// cross-origin use is simple. Supersedes the cookie-session asset-clipboard.
// Blueprint: the design notes.
//
// Storage model:
//   <data-dir>/assets/audio/samples/   curated source material (uploads, yt rips)
//   <data-dir>/assets/audio/voices/    registered voice bundles (promoted)
//   <data-dir>/assets/images/<source>/ images (uploads, mass imports); <stem>.thumb.jpg preview
//   <data-dir>/scratch/   transient working clips (24h reap)
//   <data-dir>/assets.db  the index
//
// Lineage is first-class: parent_id (NULL=source root) + root_id (denormalized ultimate
// source) + derived_op {tool,params,seed}. Seed captured for reproducibility (decision 9).
import express from 'express';
import multer from 'multer';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, rm, rename, copyFile, stat, readFile, access, appendFile, writeFile } from 'fs/promises';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8266;
export const BASE = '/asset-management/library';

// Env overrides exist so the importer / a staged boot can run against a copy, never the live DB.
const ASSETS_ROOT = process.env.ASSET_LIBRARY_ASSETS_ROOT || (process.env.HOME || '.') + '/asset-library-data/assets';  // curated source-of-truth
const APPDATA = process.env.ASSET_LIBRARY_APPDATA || (process.env.HOME || '.') + '/asset-library-data';
const SCRATCH = path.join(APPDATA, 'scratch');                      // transient working clips
const DB_PATH = path.join(APPDATA, 'assets.db');
// No auto-reap: scratch is the library's working tier . Pruned manually
// via POST /api/scratch/clear. Files live under SCRATCH until promoted or manually cleared.
const AUDIO_EXTS = ['.mp3', '.m4a', '.wav', '.ogg', '.flac', '.aac'];
// Texture formats (.tga/.dds/.tif/.exr/.psd/.hdr) are images too; browsers can't show them, so the
// viewer falls back to the ffmpeg thumbnail (Synty packs, task).
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.tga', '.dds', '.tif', '.tiff', '.exr', '.psd', '.hdr', '.bmp', '.svg'];   // .svg: image-ops output; ffmpeg's librsvg makes its thumbnail
// 3D (, the Mesh/Blender Studio pipeline): a mesh is its own category, never "audio".
const MESH_EXTS = ['.glb', '.gltf', '.fbx', '.obj', '.blend', '.ply', '.stl'];
const ACCEPTED = [...AUDIO_EXTS, ...IMAGE_EXTS, ...MESH_EXTS];
const MAX_FILE_SIZE = 200 * 1024 * 1024;
const categoryForExt = (ext) => {
  const e = String(ext).toLowerCase();
  return IMAGE_EXTS.includes(e) ? 'image' : MESH_EXTS.includes(e) ? 'mesh' : 'audio';
};

// Asset packs (collections of kind 'pack', e.g. the Synty imports: tens of thousands of rows) stay
// out of lists and facets until a pack is picked (collection=) or asked for (packs=1).
const NOT_PACK = "(collection IS NULL OR collection NOT IN (SELECT slug FROM collections WHERE kind='pack'))";

// abs path for an asset's stored file (rel_path is relative to whichever root by transient flag)
function absPath(row) {
  return path.join(row.transient ? SCRATCH : ASSETS_ROOT, row.rel_path);
}

let db;
function initDb() {
  db = new DatabaseSync(DB_PATH);
  // FIRST: another process (an importer) may hold the write lock; wait for it instead of failing the
  // boot — the schema statements below take a write lock ( a restart died on this).
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL DEFAULT 'audio',
      subtype TEXT,                 -- clip | voice | stem | sample
      rel_path TEXT NOT NULL,       -- relative to assets root (curated) or scratch/ (transient)
      label TEXT,
      filename TEXT,
      parent_id TEXT,               -- NULL = source root
      root_id TEXT,                 -- ultimate source (denormalized; = id for roots)
      source TEXT,                  -- producing tool: upload|yt-audio|voice-filter|demucs|neutts|...
      derived_op TEXT,              -- json {tool,params,seed,seed_gap?}; NULL for roots
      duration_s REAL,
      sample_rate INTEGER,
      format TEXT,
      bytes INTEGER,
      content_hash TEXT,            -- audio fingerprint for P6 dedup (lazy)
      transient INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      meta TEXT                     -- json per-type extras
    );
    CREATE INDEX IF NOT EXISTS idx_assets_parent ON assets(parent_id);
    CREATE INDEX IF NOT EXISTS idx_assets_root ON assets(root_id);
    CREATE INDEX IF NOT EXISTS idx_assets_cat ON assets(category);
    CREATE INDEX IF NOT EXISTS idx_assets_transient ON assets(transient);
    CREATE INDEX IF NOT EXISTS idx_assets_hash ON assets(content_hash);
  `);
  // Add trashed_at column if not present (idempotent — guard for re-run)
  try { db.exec(`ALTER TABLE assets ADD COLUMN trashed_at TEXT`); } catch {}
  db.exec('PRAGMA busy_timeout = 5000');  // the importer writes from a second process

  // Provenance for mass imports. `source` stays "what produced it" (midjourney,
  // yt-audio, upload…); `collection` says which import batch brought it in (NULL = made
  // here); origin_created_at is when the thing was originally made (NULL = created_at);
  // external_id is the source system's id, unique per source, so an import can re-run.
  for (const col of ['collection TEXT', 'origin_created_at TEXT', 'external_id TEXT']) {
    try { db.exec(`ALTER TABLE assets ADD COLUMN ${col}`); } catch {}
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS collections (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'import',
      description TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_assets_collection ON assets(collection);
    CREATE INDEX IF NOT EXISTS idx_assets_source ON assets(source);
    CREATE INDEX IF NOT EXISTS idx_assets_sort ON assets(COALESCE(origin_created_at, created_at));
    CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_external ON assets(source, external_id) WHERE external_id IS NOT NULL;
    -- Favorites: one list for now; list_id lets named lists slot in later.
    CREATE TABLE IF NOT EXISTS favorites (
      asset_id TEXT NOT NULL, list_id TEXT NOT NULL DEFAULT 'default', added_at TEXT NOT NULL,
      PRIMARY KEY (asset_id, list_id)
    );
    -- Ratings: one vote per user per asset; user_id is 'user' until SSO.
    CREATE TABLE IF NOT EXISTS ratings (
      asset_id TEXT NOT NULL, user_id TEXT NOT NULL DEFAULT 'user', value INTEGER NOT NULL, rated_at TEXT NOT NULL,
      PRIMARY KEY (asset_id, user_id)
    );

    -- Word search over label + filename + prompt (task stage 1). Kept in sync by triggers.
    CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(id UNINDEXED, label, filename, prompt);
    CREATE TRIGGER IF NOT EXISTS assets_fts_ai AFTER INSERT ON assets BEGIN
      INSERT INTO assets_fts(id,label,filename,prompt) VALUES (new.id, new.label, new.filename, CASE WHEN json_valid(new.meta) THEN json_extract(new.meta,'$.prompt') END);
    END;
    CREATE TRIGGER IF NOT EXISTS assets_fts_ad AFTER DELETE ON assets BEGIN
      DELETE FROM assets_fts WHERE id=old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS assets_fts_au AFTER UPDATE OF label, filename, meta ON assets BEGIN
      DELETE FROM assets_fts WHERE id=old.id;
      INSERT INTO assets_fts(id,label,filename,prompt) VALUES (new.id, new.label, new.filename, CASE WHEN json_valid(new.meta) THEN json_extract(new.meta,'$.prompt') END);
    END;
  `);
  // One-time backfill for rows that predate the FTS table.
  if (!db.prepare('SELECT 1 FROM assets_fts LIMIT 1').get()) {
    db.exec(`INSERT INTO assets_fts(id,label,filename,prompt)
      SELECT id, label, filename, CASE WHEN json_valid(meta) THEN json_extract(meta,'$.prompt') END FROM assets`);
  }
}

// Per-row marks for the viewer: favorite star, my vote, total score. Prepared once, lazily.
let markStmts = null;
function marks(id) {
  if (!db) return {};
  markStmts ||= {
    fav: db.prepare(`SELECT 1 FROM favorites WHERE asset_id=? AND list_id='default'`),
    mine: db.prepare(`SELECT value FROM ratings WHERE asset_id=? AND user_id='user'`),
    score: db.prepare(`SELECT COALESCE(SUM(value),0) AS s FROM ratings WHERE asset_id=?`),
  };
  return { is_favorite: !!markStmts.fav.get(id), rating: markStmts.mine.get(id)?.value ?? 0, score: markStmts.score.get(id)?.s ?? 0 };
}

function rowOut(r) {
  if (!r) return r;
  return { ...r, ...marks(r.id), transient: !!r.transient, sort_at: r.origin_created_at || r.created_at,
    derived_op: r.derived_op ? safeJson(r.derived_op) : null,
    meta: r.meta ? safeJson(r.meta) : null };
}
function safeJson(s) { try { return JSON.parse(s); } catch { return s; } }

function ffprobe(p) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', ['-v', 'error', '-show_entries',
      'format=duration,bit_rate:stream=sample_rate,codec_name,channels,width,height', '-of', 'json', p]);
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.on('close', () => {
      try {
        const j = JSON.parse(out); const s = (j.streams || [])[0] || {};
        resolve({ duration_s: parseFloat(j.format?.duration) || null,
          sample_rate: parseInt(s.sample_rate) || null, format: s.codec_name || null,
          channels: parseInt(s.channels) || null,
          width: parseInt(s.width) || null, height: parseInt(s.height) || null });
      } catch { resolve({ duration_s: null, sample_rate: null, format: null, channels: null }); }
    });
    proc.on('error', () => resolve({ duration_s: null, sample_rate: null, format: null, channels: null }));
  });
}

// Ideal reference-audio spec for voice cloning (OmniVoice: 16kHz mono PCM input is
// ideal; the engine synthesizes its OUTPUT at 24kHz). Corroborated by clip_audit.py
// (target_sr=16000 mono). Lossy codecs can't be un-compressed, but transcoding to
// clean PCM WAV stops further degradation and gives the engine the ideal container.
const IDEAL_VOICE_CODEC = 'pcm_s16le';
const IDEAL_VOICE_SR = 16000;
const IDEAL_VOICE_CHANNELS = 1;

// True when a probed audio file is already PCM WAV at the ideal voice spec — i.e. no
// transcode would improve it. (probe = ffprobe result.)
function isIdealVoiceWav(probe) {
  return probe
    && probe.format === IDEAL_VOICE_CODEC
    && probe.sample_rate === IDEAL_VOICE_SR
    && probe.channels === IDEAL_VOICE_CHANNELS;
}

// Transcode any source audio → 16kHz mono pcm_s16le WAV at outAbs. Resolves outAbs on
// success, rejects on ffmpeg failure. Mirrors the spawn-with-close-code shape used by
// the waveform/normalize helpers.
function transcodeToIdealWav(srcAbs, outAbs) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-i', srcAbs,
      '-ar', String(IDEAL_VOICE_SR), '-ac', String(IDEAL_VOICE_CHANNELS),
      '-c:a', IDEAL_VOICE_CODEC,
      '-y', outAbs,
    ]);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve(outAbs);
      else reject(new Error(`transcode ffmpeg exited ${code}: ${stderr.slice(-400)}`));
    });
    proc.on('error', reject);
  });
}

// ── Clip editor helpers ────────────────────────────────────────────────────
const DRAFTS = path.join(APPDATA, 'edit-drafts');
function draftPath(id) { return path.join(DRAFTS, `${id.replace(/[^a-zA-Z0-9-]/g, '')}.jsonl`); }

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`)));
    proc.on('error', reject);
  });
}

// Validate kept ranges + join fades and build the single-pass filter graph.
// Each join is an equal-power crossfade (acrossfade curve qsin) of `ms`, clamped so it
// never exceeds half of either neighbour; 0 = hard join (concat).
// pads[i] (ms, 0..5000): silence inserted before segment i (Insert silence,) — the
// segment fades in over 5 ms and adelay puts the silence in front; the join before it then
// crossfades the previous audio into that silence.
export function clipFilter(segments, fades, durationS, pads = []) {
  if (!Array.isArray(segments) || segments.length === 0) throw new Error('segments required');
  const segs = segments.map(s => [Number(s?.[0]), Number(s?.[1])]);
  const dur = durationS || Infinity;
  let prev = 0;
  for (const [a, b] of segs) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('segment times must be numbers');
    if (a < prev - 1e-9 || b - a < 0.01 - 1e-9 || b > dur + 0.001) throw new Error(`bad segment [${a}, ${b}]`);
    prev = b;
  }
  const f = segs.slice(1).map((_, i) => {
    const ms = Number(fades?.[i] ?? 10);
    if (!Number.isFinite(ms) || ms < 0 || ms > 500) throw new Error(`bad fade ${fades?.[i]}`);
    const maxS = Math.min(segs[i][1] - segs[i][0], segs[i + 1][1] - segs[i + 1][0]) / 2;
    return Math.min(ms / 1000, maxS);
  });
  const p = segs.map((_, i) => {
    const ms = Number(pads?.[i] ?? 0);
    if (!Number.isFinite(ms) || ms < 0 || ms > 5000) throw new Error(`bad silence ${pads?.[i]}`);
    return Math.round(ms);
  });
  const parts = segs.map(([a, b], i) => `[0:a]atrim=start=${a.toFixed(6)}:end=${b.toFixed(6)},asetpts=PTS-STARTPTS`
    + (p[i] > 0 ? `,afade=t=in:st=0:d=0.005,adelay=delays=${p[i]}:all=1` : '') + `[s${i}]`);
  let last = 's0';
  f.forEach((d, i) => {
    const out = i === f.length - 1 ? 'out' : `j${i}`;
    parts.push(d > 0
      ? `[${last}][s${i + 1}]acrossfade=d=${d.toFixed(6)}:c1=qsin:c2=qsin[${out}]`
      : `[${last}][s${i + 1}]concat=n=2:v=0:a=1[${out}]`);
    last = out;
  });
  if (segs.length === 1) parts[0] = parts[0].replace('[s0]', '[out]');
  return { filter: parts.join(';'), segments: segs, fades: f.map(d => Math.round(d * 1e6) / 1e3), ...(p.some(Boolean) && { pads: p }) };
}

// Generate waveform PNG sidecar beside an audio file. Non-fatal — logs on failure.
// pngPath = <stem>.png in the same dir as audioPath.
function waveformPngPath(audioPath) {
  const dir = path.dirname(audioPath);
  const stem = path.basename(audioPath, path.extname(audioPath));
  return path.join(dir, `${stem}.png`);
}
async function generateWaveformPng(audioPath, { force = false } = {}) {
  const out = waveformPngPath(audioPath);
  // Skip if already exists (idempotent), unless force regeneration requested
  if (!force) { try { await access(out); return out; } catch {} }
  else { try { await rm(out, { force: true }); } catch {} }
  // Pass 1: measure peak volume so quiet clips fill the waveform height
  let gain = 0;
  try {
    gain = await new Promise((res) => {
      let stderr = '';
      const p1 = spawn('ffmpeg', ['-i', audioPath, '-af', 'volumedetect', '-f', 'null', '-']);
      p1.stderr.on('data', (d) => { stderr += d.toString(); });
      p1.on('close', () => {
        const m = stderr.match(/max_volume:\s*([-\d.]+)\s*dB/);
        if (m) {
          const peak = parseFloat(m[1]);
          if (peak < -1) { res(Math.min(-1 - peak, 30)); return; }
        }
        res(0);
      });
      p1.on('error', () => res(0));
    });
  } catch (e) {
    console.warn(`[waveform] volumedetect failed for ${audioPath}: ${e.message}`);
  }

  const filterStr = gain > 0
    ? `volume=${gain}dB,showwavespic=s=400x400:colors=0xFFFFFFFF`
    : 'showwavespic=s=400x400:colors=0xFFFFFFFF';

  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-i', audioPath,
      '-filter_complex', filterStr,
      '-frames:v', '1', '-update', '1', out
    ]);
    proc.on('close', (code) => {
      if (code !== 0) { console.warn(`[waveform] ffmpeg exited ${code} for ${audioPath}`); resolve(null); }
      else resolve(out);
    });
    proc.on('error', (e) => { console.warn(`[waveform] spawn error: ${e.message}`); resolve(null); });
  });
}

// Generate a thumbnail PNG for a video: grab a frame from the MIDDLE of the clip
// (avoids black intro/outro frames), scaled to 400px wide (aspect preserved). Writes
// <stem>.png beside the video — the SAME sidecar path waveformPngPath uses, so the
// existing /thumb endpoint serves it with no change. Non-fatal, idempotent.
async function generateVideoThumb(videoPath, { durationS = null, force = false } = {}) {
  const out = waveformPngPath(videoPath); // <stem>.png — shared sidecar convention
  if (!force) { try { await access(out); return out; } catch {} }
  else { try { await rm(out, { force: true }); } catch {} }
  // Seek to the middle. If duration is unknown, fall back to 1s in (better than frame 0,
  // which is often black). -ss BEFORE -i = fast keyframe seek.
  const seek = (durationS && durationS > 2) ? (durationS / 2) : 1;
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-ss', String(seek), '-i', videoPath,
      '-frames:v', '1', '-vf', 'scale=400:-2', '-update', '1', '-y', out
    ]);
    proc.on('close', (code) => {
      if (code !== 0) { console.warn(`[vthumb] ffmpeg exited ${code} for ${videoPath}`); resolve(null); }
      else resolve(out);
    });
    proc.on('error', (e) => { console.warn(`[vthumb] spawn error: ${e.message}`); resolve(null); });
  });
}

// Image thumbnails can't use the <stem>.png sidecar — for a PNG that IS the image — so
// they get <stem>.thumb.jpg: 384px on the long edge, small enough for a 20k-image grid.
// Meshes get <stem>.thumb.jpg too — rendered in a browser (three.js) and PUT back, never a bare
// <stem>.png, which could be a real texture sitting next to its model (Synty packs).
function thumbPath(filePath, category) {
  return category === 'image' || category === 'mesh' ? filePath.replace(/\.[^.]+$/, '') + '.thumb.jpg' : waveformPngPath(filePath);
}
// SVG backdrop : one light/dark bit per SVG, computed when it is indexed and stored
// as meta.backdrop, so every surface (thumbnails, the Library viewer, Image Studio) puts transparent
// art on a background it shows up against. 'light' = dark ink → white behind; 'dark' = light ink.
const BACKDROP = { light: '#ffffff', dark: '#111111' };
function svgBackdrop(file) {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-v', 'error', '-width', '32', '-height', '32', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
    const chunks = [];
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.on('error', () => resolve('light'));
    proc.on('close', () => {
      const px = Buffer.concat(chunks);
      let ink = 0, lum = 0;
      for (let k = 0; k + 3 < px.length; k += 4) if (px[k + 3] > 128) { ink++; lum += 0.2126 * px[k] + 0.7152 * px[k + 1] + 0.0722 * px[k + 2]; }
      resolve(ink && lum / ink >= 115 ? 'dark' : 'light');   // no readable ink → light (black/currentColor default)
    });
  });
}
// An SVG indexed before the bit existed gets it on its first thumbnail request (and a fresh thumbnail).
async function ensureSvgBackdrop(r, filePath) {
  if (!/\.svg$/i.test(filePath)) return null;
  const meta = safeJson(r.meta) || {};
  if (meta.backdrop) return meta.backdrop;
  meta.backdrop = await svgBackdrop(filePath);
  db.prepare('UPDATE assets SET meta=? WHERE id=?').run(JSON.stringify(meta), r.id);
  await rm(thumbPath(filePath, 'image'), { force: true });
  return meta.backdrop;
}
async function generateImageThumb(imagePath, backdrop = 'light') {
  const out = thumbPath(imagePath, 'image');
  try { await access(out); return out; } catch {}
  // An SVG is rasterised by ffmpeg's librsvg at its nominal size (often tiny) and won't keep the
  // aspect on its own: size it from the viewBox (or width/height), 384 on the long side.
  let pre = [], flatten = '';
  if (/\.svg$/i.test(imagePath)) {
    // A JPEG drops the alpha (transparent → black box): composite onto the SVG's backdrop colour.
    flatten = `,format=rgba,split[fg][b];[b]drawbox=c=${BACKDROP[backdrop] || BACKDROP.light}@1:t=fill[bg];[bg][fg]overlay=format=auto`;
    const head = (await readFile(imagePath, 'utf8').catch(() => '')).slice(0, 4096);
    const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(head);
    const wh = [/\swidth\s*=\s*["']([\d.]+)/i.exec(head)?.[1], /\sheight\s*=\s*["']([\d.]+)/i.exec(head)?.[1]];
    const [w, h] = (vb ? [vb[1], vb[2]] : wh).map(Number);
    if (w > 0 && h > 0) {
      const k = 384 / Math.max(w, h);
      pre = ['-width', String(Math.max(1, Math.round(w * k))), '-height', String(Math.max(1, Math.round(h * k)))];
    }
  }
  return runFfmpeg(['-v', 'error', ...pre, '-i', imagePath, '-frames:v', '1',
    '-vf', "scale='min(384,iw)':'min(384,ih)':force_original_aspect_ratio=decrease" + flatten,
    '-q:v', '4', '-y', out]).then(() => out, (e) => { console.warn(`[ithumb] ${e.message}`); return null; });
}

// Sanitize → fs-safe base (no ext/path); filesystem-style (n) dedup within a target dir's
// already-indexed filenames for that category+transient bucket.
function sanitizeBase(name) {
  let b = String(name || 'asset').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  b = b.replace(/[^\w()\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return b || 'asset';
}
function dedupFilename(dirAbs, base, ext) {
  let cand = `${base}${ext}`;
  if (!existsSync(path.join(dirAbs, cand))) return cand;
  for (let i = 1; ; i++) { cand = `${base}(${i})${ext}`; if (!existsSync(path.join(dirAbs, cand))) return cand; }
}

// Core insert. opts: { srcAbsPath, label(origName/base), source, parent_id, derived_op,
//   subtype, transient(default true), curatedSubdir(rel under ASSETS_ROOT when !transient),
//   category (default: from the extension), filename (keep this name instead of deriving one),
//   collection, origin_created_at, external_id, meta }
async function indexAsset(opts) {
  const id = randomUUID();
  const transient = opts.transient !== false;
  // Preserve the real extension from the original filename (e.g. keep .mp3 as .mp3)
  const ext = (path.extname(opts.filename || opts.label || opts.srcAbsPath || '.wav') || '.wav').toLowerCase();
  const cat = opts.category || categoryForExt(ext);

  // derived naming: <source-base>-<tool>_<variant>; else upload base
  let base, label;
  if (opts.sourceBase) {
    const sb = sanitizeBase(opts.sourceBase);
    const variant = opts.variant ? `_${sanitizeBase(opts.variant)}` : '';
    base = `${sb}-${opts.source}${variant}`;
    label = `${opts.source}${opts.variant ? ' ' + opts.variant : ''} ${sb}`.trim();
  } else {
    base = sanitizeBase(opts.filename || opts.label || `asset-${id.slice(0, 8)}`);
    label = opts.label || base;
  }

  // destination dir: scratch (transient) or a curated subdir (e.g. audio/samples, audio/voices)
  const destDirRel = transient ? '' : (opts.curatedSubdir || (cat === 'image' ? 'images/uploads' : cat === 'mesh' ? 'meshes' : 'audio/samples'));
  const destDirAbs = transient ? SCRATCH : path.join(ASSETS_ROOT, destDirRel);
  await mkdir(destDirAbs, { recursive: true });
  const filename = dedupFilename(destDirAbs, base, ext === '.audio' ? '.wav' : ext);
  // a clashing upload shows its "(n)" name — unless the caller gave its own label
  if (transient && filename.match(/\((\d+)\)/) && opts.label && opts.label === opts.filename && !opts.sourceBase) {
    label = filename.replace(/\.[^.]+$/, '');
  }
  const destAbs = path.join(destDirAbs, filename);
  // rel_path is relative to the bucket's root
  const rel_path = transient ? filename : path.join(destDirRel, filename);

  // place the file (move from upload tmp, else copy from a tool's output)
  if (opts.moveFrom) { await rename(opts.srcAbsPath, destAbs).catch(async () => { await copyFile(opts.srcAbsPath, destAbs); await rm(opts.srcAbsPath, { force: true }); }); }
  else { await copyFile(opts.srcAbsPath, destAbs); }

  const probe = cat === 'mesh' ? {} : await ffprobe(destAbs);   // ffprobe knows nothing of meshes
  let bytes = null; try { bytes = (await stat(destAbs)).size; } catch {}
  let meta = opts.meta || null, content_hash = null;
  if (cat === 'image') {
    meta = { ...(meta || {}), width: probe.width, height: probe.height };
    if (ext === '.svg') meta.backdrop = await svgBackdrop(destAbs);
    content_hash = createHash('sha256').update(await readFile(destAbs)).digest('hex');
  } else if (cat === 'mesh') {
    content_hash = createHash('sha256').update(await readFile(destAbs)).digest('hex');
  }

  // Generate thumbnail sidecar (best-effort, non-fatal, awaited so the PNG exists before the
  // response returns — client /thumb works on first request). Audio → waveform; video →
  // middle-frame grab. Both write <stem>.png, so /thumb serves either.
  if (cat === 'image') {
    await generateImageThumb(destAbs, meta?.backdrop);
  } else if (cat === 'audio') {
    await generateWaveformPng(destAbs).catch(e => console.warn('[waveform] unexpected error:', e.message));
  } else if (cat === 'video') {
    await generateVideoThumb(destAbs, { durationS: probe.duration_s }).catch(e => console.warn('[vthumb] unexpected error:', e.message));
  }

  // resolve root_id from parent
  let root_id = id;
  if (opts.parent_id) {
    const p = db.prepare('SELECT root_id FROM assets WHERE id=?').get(opts.parent_id);
    root_id = p?.root_id || opts.parent_id;
  }

  const now = new Date().toISOString();
  db.prepare(`INSERT INTO assets
    (id,category,subtype,rel_path,label,filename,parent_id,root_id,source,derived_op,
     duration_s,sample_rate,format,bytes,content_hash,transient,created_at,meta,
     collection,origin_created_at,external_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, cat, opts.subtype || (cat === 'image' ? 'image' : cat === 'mesh' ? 'mesh' : transient ? 'clip' : 'sample'),
      rel_path, label, filename, opts.parent_id || null, root_id, opts.source || 'unknown',
      opts.derived_op ? JSON.stringify(opts.derived_op) : null,
      cat === 'image' || cat === 'mesh' ? null : probe.duration_s, probe.sample_rate ?? null, cat === 'mesh' ? ext.slice(1) : probe.format ?? null, bytes, content_hash,
      transient ? 1 : 0, now, meta ? JSON.stringify(meta) : null,
      opts.collection || null, opts.origin_created_at || null, opts.external_id || null);

  return rowOut(db.prepare('SELECT * FROM assets WHERE id=?').get(id));
}

// exported for in-process tool use (mirrors the old addClip signature, extended)
export async function addAsset(opts) { return indexAsset(opts); }

// User text → FTS5 query: every word must match, the last one as a prefix ("grass fie" works).
// Words are quoted so FTS syntax characters in a prompt can't break the query.
function ftsQuery(q) {
  const words = String(q).match(/[\p{L}\p{N}]+/gu) || [];
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? '*' : ''}`).join(' ');
}

// --- Import support: used by one-off importers running as a separate process ---
export function openLibrary() { ensureDb(); }
export function ensureCollection({ slug, name, kind = 'import', description = null }) {
  ensureDb();
  db.prepare(`INSERT INTO collections(slug,name,kind,description,created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(slug) DO UPDATE SET name=excluded.name, kind=excluded.kind, description=excluded.description`)
    .run(slug, name, kind, description, new Date().toISOString());
}
// Idempotent: an item already imported (same source + external_id) is skipped, not duplicated.
export async function importAsset(opts) {
  ensureDb();
  const hit = db.prepare('SELECT id FROM assets WHERE source=? AND external_id=?').get(opts.source, opts.external_id);
  if (hit) return { skipped: true, id: hit.id };
  const asset = await indexAsset({ ...opts, transient: false });
  return { skipped: false, id: asset.id };
}

// --- in-process read/delete helpers for sibling tools (same node process) ---
// The gateway loads every tool into one process, so a tool (e.g. ride-video)
// can resolve a source asset's row + on-disk path without an HTTP round-trip.
// db is initialized in register; lazily init if a tool reaches here first.
function ensureDb() { if (!db) initDb(); }

// Full row (rowOut-shaped: booleans/JSON parsed) for an asset id, or null.
export function getAsset(id) {
  ensureDb();
  return rowOut(db.prepare('SELECT * FROM assets WHERE id=?').get(id)) || null;
}

// Absolute on-disk path for an asset row (as returned by getAsset/addAsset).
export function assetAbsPath(row) { return absPath(row); }

// System-owned meta write for sibling tools: shallow-merge `patch` into an asset's
// meta JSON. Unlike the user-facing PATCH /api/assets/:id (which whitelists only a
// few keys), this is the trusted in-process path for setting system fields like
// profile_ref/overlay_ref. Returns the refreshed row or null.
export function updateAssetMeta(id, patch) {
  ensureDb();
  const r = db.prepare('SELECT * FROM assets WHERE id=?').get(id);
  if (!r) return null;
  const existing = r.meta ? safeJson(r.meta) : {};
  const merged = (existing && typeof existing === 'object') ? { ...existing, ...patch } : { ...patch };
  db.prepare('UPDATE assets SET meta=? WHERE id=?').run(JSON.stringify(merged), id);
  return rowOut(db.prepare('SELECT * FROM assets WHERE id=?').get(id));
}

// Delete one asset row + its file + PNG thumbnail sidecar. Does NOT cascade —
// callers own downward cleanup (blueprint Ruling 3). Returns true if a row was
// removed. `alsoFiles` sidecar names (relative to the file's dir) are removed too
// (e.g. the overlay lives beside its mp4 as a plain file in some layouts).
export async function deleteAsset(id) {
  ensureDb();
  const row = db.prepare('SELECT * FROM assets WHERE id=?').get(id);
  if (!row) return false;
  const abs = absPath(row);
  await rm(abs, { force: true }).catch(() => {});
  // thumbnail sidecar beside the file
  await rm(thumbPath(abs, row.category), { force: true }).catch(() => {});
  db.prepare('DELETE FROM assets WHERE id=?').run(id);
  return true;
}

// Promote a transient (scratch) asset into the curated tree: move the audio file +
// its PNG sidecar (regenerate if absent) and flip transient=0 in place. No-op if the
// row is already curated. Returns the refreshed row. Used by PATCH /assets/:id and by
// voices/create (so a registered voice's source seed is preserved with its lineage).
async function promoteToCurated(r, { subdir = 'audio/samples', name, subtype, meta } = {}) {
  if (!r.transient) return rowOut(db.prepare('SELECT * FROM assets WHERE id=?').get(r.id));
  const destDirAbs = path.join(ASSETS_ROOT, subdir);
  await mkdir(destDirAbs, { recursive: true });
  const ext = path.extname(r.filename) || '.wav';
  const base = sanitizeBase(name || r.label || r.filename);
  const newName = dedupFilename(destDirAbs, base, ext);
  const fromAbs = absPath(r), toAbs = path.join(destDirAbs, newName);
  await rename(fromAbs, toAbs).catch(async () => { await copyFile(fromAbs, toAbs); await rm(fromAbs, { force: true }); });

  // Move the thumbnail sidecar to match the new path; regenerate if missing
  const oldPng = thumbPath(fromAbs, r.category);
  const newPng = thumbPath(toAbs, r.category);
  if (existsSync(oldPng)) {
    await rename(oldPng, newPng).catch(async () => { await copyFile(oldPng, newPng); await rm(oldPng, { force: true }); });
  } else if (r.category === 'image') {
    await generateImageThumb(toAbs, safeJson(r.meta)?.backdrop);
  } else {
    await generateWaveformPng(toAbs).catch(e => console.warn('[waveform] promote regen failed:', e.message));
  }

  db.prepare('UPDATE assets SET transient=0, rel_path=?, filename=?, subtype=?, meta=COALESCE(?,meta) WHERE id=?')
    .run(path.join(subdir, newName), newName, subtype || r.subtype || 'clip',
         meta ? JSON.stringify(meta) : null, r.id);
  return rowOut(db.prepare('SELECT * FROM assets WHERE id=?').get(r.id));
}

const upload = multer({
  dest: path.join(SCRATCH, '.uploads'),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(ACCEPTED.includes(ext) ? null : new Error('Unsupported format'), ACCEPTED.includes(ext));
  },
});

export async function register(app) {
  await mkdir(APPDATA, { recursive: true }).catch(() => {});
  await mkdir(SCRATCH, { recursive: true }).catch(() => {});
  await mkdir(path.join(SCRATCH, '.uploads'), { recursive: true }).catch(() => {});
  initDb();

  // CORS — public-on-tailnet, no credentials (assets fetched by id, not session).
  // Safe to allow any origin since there is no cookie/auth on these read paths.
  app.use(BASE, (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // --- AssetPicker front-end (served here so a tool can point base at the library) ---
  app.get(`${BASE}/picker.js`, (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'picker.js')));
  app.get(`${BASE}/picker.css`, (req, res) => res.type('text/css').sendFile(path.join(__dirname, 'picker.css')));

  // NOTE (Phase B): the legacy standalone browse.html root handlers were REMOVED here.
  // The data API base is now /asset-management/library — the SAME base the SPA shell
  // serves. The shell (registered after this tool) owns the base root + all non-/api,
  // non-picker paths (SPA routing). The API claims only /api/* and /picker.{js,css}.
  // browse.html is superseded by the SPA; serving it at the base root shadowed the SPA.

  // --- asset-clipboard-COMPATIBLE alias routes (P2) ---
  // The existing AssetPicker speaks the old clipboard API; these aliases let it point
  // base->library unchanged. Picker shows the TRANSIENT working tier; curated assets are
  // reached via the native /api/assets routes above.
  app.get(`${BASE}/api/list`, (req, res) => {
    res.json({ clips: db.prepare('SELECT * FROM assets WHERE transient=1 AND trashed_at IS NULL ORDER BY created_at DESC LIMIT 500').all().map(rowOut) });
  });

  app.get(`${BASE}/api/clip/:id`, (req, res) => {
    const r = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    const fp = absPath(r);
    if (!existsSync(fp)) return res.status(404).json({ error: 'file missing' });
    res.sendFile(fp);
  });

  app.post(`${BASE}/api/upload`, (req, res) => {
    upload.single('file')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      try {
        const asset = await indexAsset({ srcAbsPath: req.file.path, moveFrom: true,
          label: req.file.originalname, source: 'upload', transient: true });
        res.json({ ok: true, clip: asset });
      } catch (e) { res.status(500).json({ error: e.message }); }
      finally { rm(req.file.path, { force: true }).catch(() => {}); }
    });
  });

  app.patch(`${BASE}/api/clip/:id`, express.json(), (req, res) => {
    const r = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    const label = req.body && req.body.label;
    if (label) db.prepare('UPDATE assets SET label=? WHERE id=?').run(String(label).slice(0, 200), r.id);
    res.json({ ok: true, clip: rowOut(db.prepare('SELECT * FROM assets WHERE id=?').get(r.id)) });
  });

  app.delete(`${BASE}/api/clip/:id`, async (req, res) => {
    const r = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    try { await rm(absPath(r), { force: true }); } catch {}
    db.prepare('DELETE FROM assets WHERE id=?').run(r.id);
    res.json({ ok: true });
  });

  // --- Recycle bin (soft-delete, 48h revivable) ---

  // POST /api/clip/:id/trash — soft-delete a transient clip into the recycle bin
  app.post(`${BASE}/api/clip/:id/trash`, express.json(), (req, res) => {
    const r = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    db.prepare('UPDATE assets SET trashed_at=? WHERE id=?').run(new Date().toISOString(), r.id);
    res.json({ ok: true });
  });

  // GET /api/recycle — list trashed clips still within 48h window; lazy-purge expired ones
  app.get(`${BASE}/api/recycle`, async (req, res) => {
    const cutoff = new Date(Date.now() - 48 * 3600000).toISOString();
    // lazy purge: hard-delete expired trashed rows + files
    const expired = db.prepare('SELECT * FROM assets WHERE trashed_at IS NOT NULL AND trashed_at <= ?').all(cutoff);
    for (const r of expired) {
      try { await rm(absPath(r), { force: true }); } catch {}
      db.prepare('DELETE FROM assets WHERE id=?').run(r.id);
    }
    const clips = db.prepare('SELECT * FROM assets WHERE trashed_at IS NOT NULL AND trashed_at > ? ORDER BY trashed_at DESC LIMIT 500').all(cutoff).map(rowOut);
    res.json({ clips });
  });

  // POST /api/clip/:id/revive — restore a trashed clip back into the clipboard
  app.post(`${BASE}/api/clip/:id/revive`, express.json(), (req, res) => {
    const r = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    db.prepare('UPDATE assets SET trashed_at=NULL WHERE id=?').run(r.id);
    res.json({ ok: true, clip: rowOut(db.prepare('SELECT * FROM assets WHERE id=?').get(r.id)) });
  });

  app.get(`${BASE}/api/health`, (req, res) =>
    res.json({ ok: true, db: DB_PATH, count: db.prepare('SELECT count(*) c FROM assets').get().c }));

  // list/filter. Newest first by ORIGINAL date (origin_created_at, else created_at), so an
  // imported 2023 image sorts among 2023, not among today's work. sort=oldest|alpha.
  // Paged: limit/offset.
  // source/collection take comma lists; imported=1|0 splits mass imports from made-here.
  app.get(`${BASE}/api/assets`, (req, res) => {
    const { category, transient, q, maxDur, root_id, parent_id, subtype,
      source, collection, imported, from, to } = req.query;
    const where = [], args = [];
    const inList = (col, v) => {
      const vals = String(v).split(',').filter(Boolean);
      if (vals.length) { where.push(`${col} IN (${vals.map(() => '?').join(',')})`); args.push(...vals); }
    };
    if (source) inList('source', source);
    if (collection) inList('collection', collection);
    else if (req.query.packs !== '1') where.push(NOT_PACK);
    if (imported === '1') where.push('collection IS NOT NULL');
    if (imported === '0') where.push('collection IS NULL');
    if (from) { where.push('COALESCE(origin_created_at, created_at) >= ?'); args.push(from); }
    if (to) { where.push('COALESCE(origin_created_at, created_at) < ?'); args.push(to); }
    if (category) inList('category', category);
    // subtype: a comma list. Plain names match any category; "category/subtype" pairs narrow ONLY
    // their category (the filter panel's sub-filters — other checked types stay whole).
    if (subtype) {
      const vals = String(subtype).split(',').filter(Boolean);
      const plain = vals.filter(v => !v.includes('/')), pairs = vals.filter(v => v.includes('/'));
      if (plain.length) inList('subtype', plain.join(','));
      if (pairs.length) {
        const cats = [...new Set(pairs.map(v => v.split('/')[0]))];
        where.push(`NOT (category IN (${cats.map(() => '?').join(',')}) AND (category || '/' || COALESCE(subtype, '')) NOT IN (${pairs.map(() => '?').join(',')}))`);
        args.push(...cats, ...pairs);
      }
    }
    if (transient !== undefined && transient !== '') { where.push('transient=?'); args.push(transient === '1' || transient === 'true' ? 1 : 0); }
    if (root_id) { where.push('root_id=?'); args.push(root_id); }
    if (parent_id) { where.push('parent_id=?'); args.push(parent_id); }
    if (q) {
      const match = ftsQuery(q);
      if (!match) return res.json({ assets: [], total: 0 });
      where.push('id IN (SELECT id FROM assets_fts WHERE assets_fts MATCH ?)'); args.push(match);
    }
    if (maxDur) { where.push('duration_s <= ?'); args.push(parseFloat(maxDur)); }
    // exclude soft-deleted (trashed) from all lists
    where.push('trashed_at IS NULL');
    const w = ' WHERE ' + where.join(' AND ');
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 500, 1), 1000);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const total = db.prepare('SELECT count(*) c FROM assets' + w).get(...args).c;
    const order = { oldest: 'COALESCE(origin_created_at, created_at) ASC', alpha: 'COALESCE(label, filename) COLLATE NOCASE' }[req.query.sort]
      || 'COALESCE(origin_created_at, created_at) DESC';
    const rows = db.prepare(`SELECT * FROM assets${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset);
    res.json({ assets: rows.map(rowOut), total, limit, offset });
  });

  // Filter-panel facets: what sources and collections exist in the library, with counts.
  app.get(`${BASE}/api/facets`, (req, res) => {
    const live = 'trashed_at IS NULL AND transient=0';
    res.json({
      sources: db.prepare(`SELECT source, count(*) count FROM assets WHERE ${live} AND ${NOT_PACK} GROUP BY source ORDER BY count DESC`).all(),
      categories: db.prepare(`SELECT category, count(*) count FROM assets WHERE ${live} AND ${NOT_PACK} GROUP BY category ORDER BY count DESC`).all(),
      // sub-filters: every subtype in use, in any tier (a voice-ref or a stem can sit in the clipboard)
      subtypes: db.prepare(`SELECT category, subtype, count(*) count FROM assets WHERE trashed_at IS NULL AND ${NOT_PACK} AND subtype IS NOT NULL GROUP BY category, subtype ORDER BY category, count DESC`).all(),
      // one grouped pass over assets (idx_assets_collection), not a join per collection: with the
      // 106 Synty pack collections the join took ~1.8 s
      collections: (() => {
        const n = new Map(db.prepare(`SELECT collection, count(*) c FROM assets WHERE collection IS NOT NULL AND ${live} GROUP BY collection`).all().map(r => [r.collection, r.c]));
        return db.prepare('SELECT * FROM collections ORDER BY created_at').all().map(c => ({ ...c, count: n.get(c.slug) ?? 0 }));
      })(),
    });
  });

  // ── Favorites ─────────────────────────────────────────
  app.get(`${BASE}/api/favorites`, (req, res) => {
    const rows = db.prepare(`SELECT a.* FROM favorites f JOIN assets a ON a.id=f.asset_id
      WHERE f.list_id='default' AND a.trashed_at IS NULL ORDER BY f.added_at DESC`).all();
    res.json({ assets: rows.map(rowOut) });
  });
  app.put(`${BASE}/api/favorites/:id`, (req, res) => {
    if (!db.prepare('SELECT 1 FROM assets WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'not found' });
    db.prepare(`INSERT OR IGNORE INTO favorites(asset_id, list_id, added_at) VALUES (?, 'default', ?)`).run(req.params.id, new Date().toISOString());
    res.json({ ok: true });
  });
  app.delete(`${BASE}/api/favorites/:id`, (req, res) => {
    db.prepare(`DELETE FROM favorites WHERE asset_id=? AND list_id='default'`).run(req.params.id);
    res.json({ ok: true });
  });
  // Clear un-stars everything (never deletes assets); returns what was removed so it can be restored.
  app.delete(`${BASE}/api/favorites`, (req, res) => {
    const removed = db.prepare(`SELECT asset_id, added_at FROM favorites WHERE list_id='default'`).all();
    db.prepare(`DELETE FROM favorites WHERE list_id='default'`).run();
    res.json({ ok: true, removed });
  });

  // ── Rating: value -1 | 0 | 1; 0 clears the vote ─────────────
  app.put(`${BASE}/api/assets/:id/rating`, express.json(), (req, res) => {
    const v = Number(req.body?.value);
    if (![-1, 0, 1].includes(v)) return res.status(400).json({ error: 'value must be -1, 0 or 1' });
    if (!db.prepare('SELECT 1 FROM assets WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'not found' });
    if (v === 0) db.prepare(`DELETE FROM ratings WHERE asset_id=? AND user_id='user'`).run(req.params.id);
    else db.prepare(`INSERT INTO ratings(asset_id, user_id, value, rated_at) VALUES (?, 'user', ?, ?)
      ON CONFLICT(asset_id, user_id) DO UPDATE SET value=excluded.value, rated_at=excluded.rated_at`).run(req.params.id, v, new Date().toISOString());
    res.json({ ok: true, ...marks(req.params.id) });
  });

  app.get(`${BASE}/api/assets/:id`, (req, res) => {
    const r = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    res.json(rowOut(r));
  });

  // full lineage tree: ancestors (walk parent) + descendants (recursive)
  app.get(`${BASE}/api/assets/:id/lineage`, (req, res) => {
    const id = req.params.id;
    const self = db.prepare('SELECT * FROM assets WHERE id=?').get(id);
    if (!self) return res.status(404).json({ error: 'not found' });
    const ancestors = db.prepare(`
      WITH RECURSIVE up(id) AS (
        SELECT parent_id FROM assets WHERE id=?
        UNION ALL SELECT a.parent_id FROM assets a JOIN up ON a.id=up.id WHERE a.parent_id IS NOT NULL
      ) SELECT a.* FROM assets a JOIN up ON a.id=up.id`).all(id).map(rowOut);
    const descendants = db.prepare(`
      WITH RECURSIVE down(id) AS (
        SELECT id FROM assets WHERE parent_id=?
        UNION ALL SELECT a.id FROM assets a JOIN down ON a.parent_id=down.id
      ) SELECT a.* FROM assets a JOIN down ON a.id=down.id`).all(id).map(rowOut);
    res.json({ self: rowOut(self), ancestors, descendants,
      family: db.prepare('SELECT * FROM assets WHERE root_id=? ORDER BY created_at').all(self.root_id).map(rowOut) });
  });

  app.get(`${BASE}/api/assets/:id/file`, (req, res) => {
    const r = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    const p = absPath(r);
    if (!existsSync(p)) return res.status(404).json({ error: 'file missing' });
    // Portable deep-link support (Phase A): ?download=1 (or ?view=download) forces a
    // browser download via Content-Disposition: attachment. Otherwise serve inline so
    // images render / audio plays in-page (view=direct). res.sendFile already infers
    // Content-Type from the extension; we set an explicit fallback by category so a
    // missing/unknown extension still renders inline for known media instead of
    // defaulting to octet-stream (which would force a download).
    const wantsDownload = req.query.download === '1' || req.query.view === 'download';
    if (!res.getHeader('Content-Type') && !path.extname(p)) {
      const fallback = r.category === 'image' ? 'image/*'
        : r.category === 'audio' ? 'audio/*'
        : r.category === 'video' ? 'video/*'
        : null;
      if (fallback) res.setHeader('Content-Type', fallback);
    }
    if (wantsDownload) {
      const dlName = r.filename || `${r.id}${path.extname(p)}`;
      res.setHeader('Content-Disposition', `attachment; filename="${dlName.replace(/"/g, '')}"`);
    }
    res.sendFile(p);
  });

  // GET /api/assets/:id/thumb — serve the PNG thumbnail sidecar (<stem>.png): a waveform
  // for audio, a middle-frame grab for video. Lazily generates a video thumb on first
  // request if the sidecar is missing (e.g. assets stored before this feature). 404 only
  // if the asset/file is gone or generation fails.
  app.get(`${BASE}/api/assets/:id/thumb`, async (req, res) => {
    const r = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    const filePath = absPath(r);
    const pngPath = thumbPath(filePath, r.category);
    const backdrop = r.category === 'image' && existsSync(filePath) ? await ensureSvgBackdrop(r, filePath) : null;
    if (!existsSync(pngPath)) {
      // Lazy backfill for video/images (audio waveforms are generated at index time only).
      if (r.category === 'video' && existsSync(filePath)) {
        await generateVideoThumb(filePath, { durationS: r.duration_s }).catch(() => {});
      } else if (r.category === 'image' && existsSync(filePath)) {
        await generateImageThumb(filePath, backdrop || undefined);
      }
      if (!existsSync(pngPath)) return res.status(404).json({ error: 'no thumbnail sidecar' });
    }
    res.setHeader('Content-Type', r.category === 'image' || r.category === 'mesh' ? 'image/jpeg' : 'image/png');
    res.setHeader('Cache-Control', backdrop ? 'public, max-age=300' : 'public, max-age=86400');   // SVG thumbs were re-rendered once (backdrop): don't pin the old one for a day
    res.sendFile(pngPath);
  });

  // PUT /api/assets/:id/thumb — a mesh's thumbnail, rendered client-side (the Library's 3D viewer
  // or the backfill worker, packages/app/scripts/mesh-thumbs.mjs). JPEG only, ≤2 MB; replaces.
  app.put(`${BASE}/api/assets/:id/thumb`, express.raw({ type: 'image/jpeg', limit: '2mb' }), async (req, res) => {
    const r = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    if (r.category !== 'mesh') return res.status(400).json({ error: 'only meshes take an uploaded thumbnail' });
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) return res.status(400).json({ error: 'expected a JPEG body (content-type image/jpeg)' });
    const out = thumbPath(absPath(r), 'mesh');
    try {
      await writeFile(out + '.tmp', buf);
      await rename(out + '.tmp', out);
    } catch (e) { return res.status(500).json({ error: e.message }); }
    res.json({ ok: true, bytes: buf.length });
  });

  // POST /api/assets/waveform-sweep — retro sweep: generate PNG sidecars for all audio assets lacking one.
  // Pass ?force=1 or body {force:true} to regenerate existing PNGs (e.g. after color change).
  app.post(`${BASE}/api/assets/waveform-sweep`, async (req, res) => {
    const force = req.query.force === '1' || req.body?.force === true;
    const rows = db.prepare("SELECT * FROM assets WHERE category='audio'").all();
    let generated = 0, skipped = 0, errors = 0;
    for (const r of rows) {
      const audioPath = absPath(r);
      const pngPath = waveformPngPath(audioPath);
      if (!force && existsSync(pngPath)) { skipped++; continue; }
      if (!existsSync(audioPath)) { errors++; continue; }
      const result = await generateWaveformPng(audioPath, { force });
      if (result) generated++; else errors++;
    }
    res.json({ ok: true, total: rows.length, generated, skipped, errors, force });
  });

  // GET /api/assets/:id/reference — MINT a portable AssetReference v1 from a row.
  // Track B / B1; contract governed by decision the design notes. The library
  // mints engine-agnostic, full stop: identity + rawUrl + (placement|null for
  // non-spatial) + lineage. optimizedUrl/optimizeProfile are null until an
  // adapter requests on-demand optimization (B2). placement is read from the
  // asset's meta JSON when present (3D assets), else null. Additive + read-only.
  app.get(`${BASE}/api/assets/:id/reference`, (req, res) => {
    const r = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    const row = rowOut(r); // parses meta/derived_op JSON
    const meta = (row.meta && typeof row.meta === 'object') ? row.meta : {};

    // Absolute, CORS-readable URL to the raw bytes (served by /file, no cookie).
    const origin = `${req.protocol}://${req.get('host')}`;
    const rawUrl = `${origin}${BASE}/api/assets/${encodeURIComponent(row.id)}/file`;

    // placement geometry: present only for spatial assets, carried in meta.placement.
    // Pass through verbatim if the shape is there; otherwise null (per contract,
    // non-spatial categories and user GLBs without geometry degrade to null).
    const placement = meta.placement && typeof meta.placement === 'object' ? meta.placement : null;

    res.json({
      contractVersion: 1,
      assetId: row.id,
      category: row.category,
      subtype: row.subtype ?? null,
      label: row.label ?? row.filename ?? row.id,
      rawUrl,
      optimizedUrl: null,        // populated on-demand by an adapter (B2)
      optimizeProfile: null,
      placement,
      lineageId: row.root_id ?? row.id,   // ultimate source row
      derivedFrom: row.parent_id ?? null, // parent if this is a transformed variant
      meta,
    });
  });

  // ── Clip editor (the design notes) ────────────────────────────────────
  // Draft = the editor's working state for ONE source asset. Append-only JSONL, last
  // line wins (the Live-TV edit-list model): nothing is overwritten, every autosave is
  // recoverable. The server treats the draft as opaque JSON.
  app.get(`${BASE}/api/assets/:id/edit-draft`, async (req, res) => {
    const r = db.prepare('SELECT id FROM assets WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    try {
      const lines = (await readFile(draftPath(r.id), 'utf8')).trim().split('\n');
      res.json(JSON.parse(lines[lines.length - 1]));
    } catch { res.json({ draft: null }); }
  });

  app.put(`${BASE}/api/assets/:id/edit-draft`, express.json({ limit: '1mb' }), async (req, res) => {
    const r = db.prepare('SELECT id FROM assets WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    if (!req.body?.draft || typeof req.body.draft !== 'object') return res.status(400).json({ error: 'draft object required' });
    const rec = { ts: new Date().toISOString(), draft: req.body.draft };
    await mkdir(DRAFTS, { recursive: true });
    await appendFile(draftPath(r.id), JSON.stringify(rec) + '\n');
    res.json({ ok: true, ts: rec.ts });
  });

  // Create clip: kept ranges → ONE ffmpeg pass (atrim + acrossfade/concat) → child asset.
  // body: { segments: [[t0,t1],...] kept ranges in source time, ascending, non-overlapping;
  //         fades: [ms,...] one per join (segments.length-1), 0 = hard join; label? }
  app.post(`${BASE}/api/assets/:id/clip`, express.json(), async (req, res) => {
    const r = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    if (r.category !== 'audio') return res.status(400).json({ error: 'clip editor P1 supports audio only' });
    const src = absPath(r);
    if (!existsSync(src)) return res.status(404).json({ error: 'file missing' });
    let plan;
    try { plan = clipFilter(req.body?.segments, req.body?.fades, r.duration_s, req.body?.pads); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    // Lossless sources keep their format; lossy sources render to WAV (no extra generation).
    const srcExt = path.extname(src).toLowerCase();
    const ext = ['.wav', '.flac'].includes(srcExt) ? srcExt : '.wav';
    const codec = ext === '.flac' ? ['-c:a', 'flac'] : ['-c:a', r.format?.startsWith('pcm_') ? r.format : 'pcm_s16le'];
    const tmp = path.join(SCRATCH, '.uploads', `clip-${randomUUID()}${ext}`);
    try {
      await runFfmpeg(['-v', 'error', '-i', src, '-filter_complex', plan.filter, '-map', '[out]',
        ...(r.sample_rate ? ['-ar', String(r.sample_rate)] : []), ...codec, '-y', tmp]);
      const base = (r.label || r.filename || 'clip').replace(/\.[^.]+$/, '');
      const suffix = String(req.body?.label || 'edit').replace(/[^\w .-]/g, '').slice(0, 40) || 'edit';
      const asset = await indexAsset({ srcAbsPath: tmp, moveFrom: true, label: `${base} (${suffix})${ext}`,
        source: 'clip-editor', parent_id: r.id,
        category: 'audio', subtype: 'clip', transient: true,
        derived_op: { tool: 'clip-editor', params: { segments: plan.segments, fades: plan.fades, ...(plan.pads && { pads: plan.pads }) } } });
      res.json({ ok: true, asset });
    } catch (e) {
      rm(tmp, { force: true }).catch(() => {});
      res.status(500).json({ error: e.message });
    }
  });

  // register a file already on disk (a tool's output): {srcPath,label/sourceBase,variant,source,parent_id,derived_op,subtype,transient}
  app.post(`${BASE}/api/assets`, express.json(), async (req, res) => {
    const b = req.body || {};
    if (!b.srcPath || !existsSync(b.srcPath)) return res.status(400).json({ error: 'srcPath missing or not found' });
    try {
      // filename carries the real extension (→ category): without it indexAsset guessed it from the
      // label and fell back to .wav, so an image registered here became "audio" (Image Studio,).
      const asset = await indexAsset({ srcAbsPath: b.srcPath, filename: b.filename || path.basename(b.srcPath), label: b.label, sourceBase: b.sourceBase,
        variant: b.variant, source: b.source, parent_id: b.parent_id, derived_op: b.derived_op,
        subtype: b.subtype, transient: b.transient !== false, meta: b.meta });
      res.json({ ok: true, asset });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // browser upload → save as a SOURCE (transient working copy in scratch by default)
  app.post(`${BASE}/api/assets/upload`, (req, res) => {
    upload.single('file')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      try {
        // ?dedupe=1 (image-gen reference drops): if these exact bytes are already in the
        // library, reference that asset instead of making a transient copy.
        if (req.query.dedupe === '1') {
          const hash = createHash('sha256').update(await readFile(req.file.path)).digest('hex');
          const hit = db.prepare('SELECT * FROM assets WHERE content_hash=? AND trashed_at IS NULL ORDER BY transient ASC, created_at ASC LIMIT 1').get(hash);
          if (hit) return res.json({ ok: true, asset: rowOut(hit), existing: true });
        }
        // Optional lineage fields: a tool on ANOTHER host (the GPU host Blender/Mesh
        // residents) can't use POST /api/assets {srcPath}, so the multipart upload carries
        // label/source/subtype/parent_id and JSON derived_op/meta itself. Absent = as before.
        const f = req.body || {};
        const json = (v, name) => {
          if (v === undefined || v === '') return undefined;
          try { return JSON.parse(v); } catch { throw Object.assign(new Error(`${name} must be JSON`), { status: 400 }); }
        };
        const derived_op = json(f.derived_op, 'derived_op'), meta = json(f.meta, 'meta');
        if (f.parent_id && !db.prepare('SELECT 1 FROM assets WHERE id=?').get(String(f.parent_id))) {
          return res.status(400).json({ error: `parent_id ${f.parent_id} is not in the library` });
        }
        const asset = await indexAsset({ srcAbsPath: req.file.path, moveFrom: true,
          filename: req.file.originalname, label: f.label ? String(f.label).slice(0, 200) : req.file.originalname,
          source: f.source ? String(f.source).slice(0, 60) : 'upload', subtype: f.subtype ? String(f.subtype).slice(0, 40) : undefined,
          parent_id: f.parent_id ? String(f.parent_id) : undefined, derived_op, meta,
          transient: true });
        res.json({ ok: true, asset });
      } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
      finally { rm(req.file.path, { force: true }).catch(() => {}); }
    });
  });

  // rename label OR promote (transient→curated). body: {label?, promote?:{subdir,name,subtype,meta}}
  // Whitelisted keys a user may write via the meta patch path.
  // Lineage/derived keys (audio_ref, parent_id, root_id, derived_op, placement) are
  // intentionally excluded — they are set by the system only.
  // notes : free text anyone — the user or an agent — can add to a record: rankings,
  // quality issues, what was tried. PATCH {meta:{notes}} replaces it; the viewer edits it.
  // identity: the face_match score of an image against a source photo ({source_id, score, verdict, model, at, ...}) — written by image-ops.
  // projection: a mesh's camera/cut-out spec for Blender's per-view texture projection
  // (written by Mesh Studio; frame, cameras, cut-out paths) — an object, replaced whole.
  const META_USER_EDITABLE = new Set(['ref_text', 'notes', 'projection', 'identity']);

  app.patch(`${BASE}/api/assets/:id`, express.json(), async (req, res) => {
    const r = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    try {
      if (b.label) db.prepare('UPDATE assets SET label=? WHERE id=?').run(String(b.label).slice(0, 200), r.id);
      if (b.meta && typeof b.meta === 'object') {
        // Merge whitelisted keys into existing meta; reject/ignore any non-whitelisted keys.
        const existing = r.meta ? safeJson(r.meta) : {};
        const merged = typeof existing === 'object' && existing !== null ? { ...existing } : {};
        for (const [k, v] of Object.entries(b.meta)) {
          if (k === 'notes') merged.notes = String(v ?? '').slice(0, 4000);
          else if (META_USER_EDITABLE.has(k)) merged[k] = v;
        }
        db.prepare('UPDATE assets SET meta=? WHERE id=?').run(JSON.stringify(merged), r.id);
      }
      // A voice's name or transcript changed → voice-to-voice gets the new version (same voice_id).
      if (r.subtype === 'voice' && (b.label || (b.meta && 'ref_text' in b.meta))) await syncVoiceToV2V(r.id);
      if (b.promote) {
        await promoteToCurated(r, {
          subdir: b.promote.subdir || (r.category === 'image' ? 'images/uploads' : 'audio/samples'),
          name: b.promote.name,
          subtype: b.promote.subtype || (r.category === 'image' ? 'image' : 'clip'),
          meta: b.promote.meta,
        });
      }
      res.json({ ok: true, asset: rowOut(db.prepare('SELECT * FROM assets WHERE id=?').get(r.id)) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete(`${BASE}/api/assets/:id`, async (req, res) => {
    const r = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    const kids = db.prepare('SELECT count(*) c FROM assets WHERE parent_id=?').get(r.id).c;
    if (kids && req.query.force !== '1') return res.status(409).json({ error: `has ${kids} child asset(s); pass ?force=1 to delete anyway` });
    try { await rm(absPath(r), { force: true }); } catch {}
    db.prepare('DELETE FROM assets WHERE id=?').run(r.id);
    res.json({ ok: true });
  });

  // MANUAL cleanup of the scratch/working tier (no auto-reap — scratch
  // is the library's working tier, not a throwaway clipboard; the user prunes when they
  // choose). POST {olderThanDays?} — omit to clear ALL transient assets; or set a day cutoff.
  app.post(`${BASE}/api/scratch/clear`, express.json(), async (req, res) => {
    const days = req.body && Number(req.body.olderThanDays);
    let rows;
    if (days && days > 0) {
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      rows = db.prepare('SELECT * FROM assets WHERE transient=1 AND trashed_at IS NULL AND created_at < ?').all(cutoff);
    } else {
      rows = db.prepare('SELECT * FROM assets WHERE transient=1 AND trashed_at IS NULL').all();
    }
    let removed = 0;
    for (const r of rows) {
      try { await rm(absPath(r), { force: true }); } catch {}
      db.prepare('DELETE FROM assets WHERE id=?').run(r.id);
      removed++;
    }
    res.json({ ok: true, removed });
  });

  // scratch usage stats (count + bytes of transient assets) — for a future cleanup UI
  app.get(`${BASE}/api/scratch/stats`, (req, res) => {
    const r = db.prepare("SELECT count(*) c, COALESCE(SUM(bytes),0) bytes, MIN(created_at) oldest FROM assets WHERE transient=1").get();
    res.json({ count: r.c, bytes: r.bytes, oldest: r.oldest });
  });

  // --- Voice bundle catalog ---

  // GET /api/voices — list all registered voice bundles
  app.get(`${BASE}/api/voices`, (req, res) => {
    res.json({ voices: db.prepare("SELECT * FROM assets WHERE subtype='voice' AND trashed_at IS NULL ORDER BY created_at DESC").all().map(rowOut) });
  });

  // POST /api/voices/create — library-owned write path (pointer + ideal-spec ref).
  // Body JSON: { audio_asset_id (req), label? (opt), ref_text (req), image? (opt asset id) }
  // Creates a subtype='voice' record that references the audio asset by id.
  // If the referenced audio is NOT already PCM WAV at the ideal voice spec (lossy mp3,
  // wrong rate/channels), transcode it to a 16kHz-mono-PCM WAV registered as a LINEAGE
  // CHILD (parent_id = original) and point the voice at the child — so the engine gets
  // the ideal container while the original stays visible via the lineage. No slug
  // enforcement, no folder bundle. (Deferred: loudness/silence/F0 eval + cleanup/trim.)
  // voice-to-voice keeps its own voice list: a Library voice exists there only after its register
  // call (confirmed by the v2v agent,). Idempotent by voice_id = our asset id, so a
  // re-register replaces. The outcome is recorded on the voice as meta.v2v.
  const V2V_REGISTER = process.env.V2V_REGISTER_URL || ''; // optional voice-registration service; unset = 503
  async function syncVoiceToV2V(voiceId) {
    const v = db.prepare('SELECT * FROM assets WHERE id=?').get(voiceId);
    if (!v || v.subtype !== 'voice') throw new Error('not a voice');
    const meta = safeJson(v.meta) || {};
    const ref = (meta.audio_ref && db.prepare('SELECT * FROM assets WHERE id=?').get(meta.audio_ref)) || v;
    let out;
    try {
      if (!V2V_REGISTER) throw new Error('voice registration service is not configured (set V2V_REGISTER_URL)');
      const form = new FormData();
      form.append('audio', new Blob([await readFile(absPath(ref))], { type: 'audio/wav' }), ref.filename || 'ref.wav');
      form.append('name', v.label || v.filename || v.id.slice(0, 8));
      form.append('ref_text', meta.ref_text || '');
      form.append('voice_id', v.id);
      const r = await fetch(V2V_REGISTER, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
      const text = await r.text();
      out = r.ok ? { status: 'registered' }
        : r.status === 503 ? { status: 'pending', error: /tts_unavailable/.test(text) ? "voice-to-voice's TTS isn't loaded (restarting?) — retry in a moment" : 'voice-to-voice is busy on the GPU — retry in a moment' }
        : { status: 'failed', error: `voice-to-voice HTTP ${r.status}: ${text.slice(0, 200)}` };
    } catch (e) {
      out = { status: 'pending', error: `voice-to-voice didn't answer (${e.name === 'TimeoutError' ? 'timeout' : e.message}) — is it running?` };
    }
    const fresh = safeJson(db.prepare('SELECT meta FROM assets WHERE id=?').get(voiceId).meta) || {};
    fresh.v2v = { voice_id: v.id, ...out, at: new Date().toISOString() };
    db.prepare('UPDATE assets SET meta=? WHERE id=?').run(JSON.stringify(fresh), voiceId);
    return fresh.v2v;
  }

  // POST /api/voices/:id/sync — (re)register a Library voice with voice-to-voice (the tool's Retry).
  app.post(`${BASE}/api/voices/:id/sync`, async (req, res) => {
    try { res.json({ ok: true, v2v: await syncVoiceToV2V(req.params.id) }); }
    catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.post(`${BASE}/api/voices/create`, express.json(), async (req, res) => {
    try {
      const { audio_asset_id, label, ref_text, image } = req.body || {};
      if (!audio_asset_id) return res.status(400).json({ ok: false, error: 'audio_asset_id required' });
      if (!ref_text && ref_text !== '') return res.status(400).json({ ok: false, error: 'ref_text required' });
      const audioRow = db.prepare("SELECT * FROM assets WHERE id=?").get(audio_asset_id);
      if (!audioRow) return res.status(404).json({ ok: false, error: `audio asset ${audio_asset_id} not found` });
      if (audioRow.category !== 'audio') return res.status(400).json({ ok: false, error: 'audio_asset_id must reference an audio asset' });

      // Capture the seed: if the source clip is still transient (in the clipboard
      // scratch tier), promote it to the curated tree FIRST so registering a voice
      // permanently preserves its source with intact lineage — clipboard cleanup can
      // no longer orphan a registered voice's origin. No-op if already curated.
      let sourceRow = audioRow;
      if (audioRow.transient) {
        await promoteToCurated(audioRow, { subdir: 'audio/samples' });
        sourceRow = db.prepare("SELECT * FROM assets WHERE id=?").get(audio_asset_id);
      }

      // Resolve the ref audio: keep the source as-is if it's already ideal PCM WAV,
      // otherwise transcode to a 16k-mono-PCM child and point the voice at that.
      let refRow = sourceRow;
      const srcAbs = absPath(sourceRow);
      const probe = await ffprobe(srcAbs);
      if (!isIdealVoiceWav(probe)) {
        const tmpOut = path.join(SCRATCH, '.uploads', `voiceref-${randomUUID()}.wav`);
        await mkdir(path.dirname(tmpOut), { recursive: true });
        try {
          await transcodeToIdealWav(srcAbs, tmpOut);
          // indexAsset places the file (move from tmp), ffprobes it, generates the
          // waveform sidecar, and resolves root_id from parent_id — all reused here.
          const child = await indexAsset({
            srcAbsPath: tmpOut, moveFrom: true, category: 'audio', subtype: 'voice-ref',
            transient: false, curatedSubdir: 'audio/voices',
            parent_id: audio_asset_id, source: 'voice-register-transcode',
            derived_op: { op: 'transcode-wav', from: sourceRow.format || null,
              to: `${IDEAL_VOICE_CODEC}@${IDEAL_VOICE_SR}/${IDEAL_VOICE_CHANNELS}ch` },
            sourceBase: (sourceRow.filename || 'voice').replace(/\.[^.]+$/, ''),
            variant: 'ref',
          });
          refRow = db.prepare("SELECT * FROM assets WHERE id=?").get(child.id);
        } finally {
          await rm(tmpOut, { force: true }).catch(() => {});
        }
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      const meta = JSON.stringify({ audio_ref: refRow.id, ref_text, image: image || null });
      db.prepare(
        `INSERT INTO assets (id,category,subtype,rel_path,label,filename,parent_id,root_id,source,derived_op,transient,created_at,meta)
         VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)`
      ).run(id, 'audio', 'voice', refRow.rel_path, label || null, refRow.filename, refRow.id, refRow.root_id || refRow.id, 'voice-register', null, now, meta);
      const v2v = await syncVoiceToV2V(id);   // never throws: the outcome lands in meta.v2v
      const saved = db.prepare('SELECT * FROM assets WHERE id=?').get(id);
      res.json({ ok: true, voice: rowOut(saved), v2v });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // --- STT (speech-to-text) ---
  // POST /api/transcribe  multipart field: audio (any format)
  // Proxies to the optional transcribe_sidecar.py process; set TRANSCRIBE_URL to its base URL. Unset = 503.
  app.post(`${BASE}/api/transcribe`, (req, res) => {
    upload.single('audio')(req, res, async (err) => {
      if (err) return res.status(400).json({ ok: false, error: err.message });
      if (!req.file) return res.status(400).json({ ok: false, error: "missing 'audio' field" });
      const TRANSCRIBE_URL = process.env.TRANSCRIBE_URL;
      if (!TRANSCRIBE_URL) { rm(req.file.path, { force: true }).catch(() => {}); return res.status(503).json({ ok: false, error: 'transcription is not configured (set TRANSCRIBE_URL)' }); }
      try {
        const audioBytes = await readFile(req.file.path);
        rm(req.file.path, { force: true }).catch(() => {});
        const form = new FormData();
        form.append('audio', new Blob([audioBytes]), req.file.originalname || 'audio.wav');
        const r = await fetch(`${TRANSCRIBE_URL}/transcribe`, { method: 'POST', body: form });
        if (!r.ok) {
          const txt = await r.text().catch(() => '');
          return res.status(502).json({ ok: false, error: `sidecar ${r.status}: ${txt}` });
        }
        const data = await r.json();
        res.json(data);
      } catch (e) {
        res.status(502).json({ ok: false, error: `transcribe sidecar unavailable: ${e.message}` });
      }
    });
  });

}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = express();
  await register(app);
  app.listen(PORT, '0.0.0.0', () => console.log(`asset-library standalone on :${PORT} at ${BASE}`));
}
