import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { parseColor } from './color.mjs';
import { tintRaw } from './tint.mjs';

const LIBRARY = (process.env.TILE_LIBRARY_URL || 'http://127.0.0.1:8260/asset-management/library/api').replace(/\/$/, '');

/** Bytes of an element's picture: a file (relative to the composition), an http(s) URL, or `library:<asset id>`. */
export async function loadSource(src, baseDir) {
  if (/^https?:\/\//.test(src)) return fetchBytes(src);
  if (src.startsWith('library:')) return fetchBytes(`${LIBRARY}/assets/${src.slice(8)}/file`);
  return fs.readFileSync(path.resolve(baseDir, src));
}

async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

const rgba = (px, w, h) => sharp(px, { raw: { width: w, height: h, channels: 4 } });
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

/** One shadow vector for the whole tile: `light.angle` is where the light comes from (degrees clockwise from the top: 0 = above, 90 = right, 315 = top-left), so 315 casts toward the bottom-right. */
export function lightVector(light = {}) {
  const a = ((light.angle ?? 315) * Math.PI) / 180;
  return [-Math.sin(a), Math.cos(a)];
}

/** Resolve an element's shadow: element value over comp.shadow defaults; false/absent = none. */
export function shadowOf(el, comp) {
  const d = comp.shadow;
  if (el.shadow === false || (el.shadow == null && !d)) return null;
  const s = { distance: 12, blur: 8, opacity: 0.35, color: '#000000', ...(d || {}), ...(el.shadow === true || el.shadow == null ? {} : el.shadow) };
  const [vx, vy] = lightVector(comp.light);
  return { dx: s.dx ?? vx * s.distance, dy: s.dy ?? vy * s.distance, blur: s.blur, opacity: s.opacity, color: parseColor(s.color) };
}

/** An element as one RGBA picture: resized, flipped, rotated, tinted, with its shadow underneath. Its centre is the picture's centre. */
export async function buildUnit(el, comp, bytes) {
  const meta = await sharp(bytes).metadata();
  let w = meta.width, h = meta.height;
  let k = el.scale ?? 1;
  if (el.size) k = el.size / Math.max(w, h);
  if (el.width) k = el.width / w;
  if (el.height) k = el.height / h;
  w = Math.max(1, Math.round(w * k));
  h = Math.max(1, Math.round(h * k));
  let img = sharp(bytes).ensureAlpha().resize(w, h, { fit: 'fill' });
  const flip = String(el.flip || '');
  if (flip.includes('h') || flip === 'true') img = img.flop();
  if (flip.includes('v')) img = img.flip();
  let buf = await img.png().toBuffer();
  if (el.rot) buf = await sharp(buf).rotate(el.rot, { background: CLEAR }).png().toBuffer();
  const raw = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const { width: sw, height: sh } = raw.info;
  tintRaw(raw.data, el.tint);
  if (el.opacity != null && el.opacity < 1) for (let i = 3; i < raw.data.length; i += 4) raw.data[i] = Math.round(raw.data[i] * el.opacity);
  const sprite = await rgba(raw.data, sw, sh).png().toBuffer();
  const sd = shadowOf(el, comp);
  if (!sd) return { buf: sprite, w: sw, h: sh };

  const sigma = Math.max(0.3, sd.blur / 2);
  const pad = Math.ceil(sigma * 3 + Math.max(Math.abs(sd.dx), Math.abs(sd.dy)));
  const W = sw + 2 * pad, H = sh + 2 * pad;
  const shadow = Buffer.alloc(sw * sh * 4);
  const [r, g, b] = sd.color.map(v => Math.round(v * 255));
  for (let i = 0; i < sw * sh; i++) {
    shadow[i * 4] = r; shadow[i * 4 + 1] = g; shadow[i * 4 + 2] = b;
    shadow[i * 4 + 3] = Math.round(raw.data[i * 4 + 3] * sd.opacity);
  }
  const placed = await rgba(shadow, sw, sh).extend({ top: pad, bottom: pad, left: pad, right: pad, background: CLEAR }).png().toBuffer();
  const blurred = await sharp(placed).blur(sigma).png().toBuffer();
  const shifted = await sharp({ create: { width: W, height: H, channels: 4, background: CLEAR } })
    .composite([{ input: blurred, left: Math.round(sd.dx), top: Math.round(sd.dy) }]).png().toBuffer();
  const unit = await sharp(shifted).composite([{ input: sprite, left: pad, top: pad }]).png().toBuffer();
  return { buf: unit, w: W, h: H };
}

/** Where a unit's copies fall on the tile: every (i,j) shift of the tile size at which it still overlaps the tile. */
export function copies(cx, cy, uw, uh, W, H) {
  const left = Math.round(cx - uw / 2), top = Math.round(cy - uh / 2);
  const out = [];
  for (let j = Math.floor(-(top + uh) / H) + 1; top + j * H < H; j++)
    for (let i = Math.floor(-(left + uw) / W) + 1; left + i * W < W; i++) out.push([left + i * W, top + j * H]);
  return out;
}

/** The tile (PNG buffer, W×H) of a composition. `baseDir` resolves relative `src`. */
export async function renderTile(comp, baseDir = '.') {
  const W = comp.w ?? 1024, H = comp.h ?? 1024;
  const cache = new Map();
  const layers = [];
  const order = (comp.elements || []).map((el, n) => ({ el, n })).sort((a, b) => (a.el.z ?? 0) - (b.el.z ?? 0) || a.n - b.n);
  for (const { el, n } of order) {
    if (!el.src) throw new Error(`element ${n}: no src`);
    if (!cache.has(el.src)) cache.set(el.src, await loadSource(el.src, baseDir));
    const u = await buildUnit(el, comp, cache.get(el.src));
    const cx = el.x ?? W / 2, cy = el.y ?? H / 2;
    for (const [left, top] of copies(cx, cy, u.w, u.h, W, H)) {
      // sharp cannot place a picture partly outside the canvas: cut the part that is inside
      const x0 = Math.max(0, -left), y0 = Math.max(0, -top);
      const x1 = Math.min(u.w, W - left), y1 = Math.min(u.h, H - top);
      if (x1 <= x0 || y1 <= y0) continue;
      const input = x0 || y0 || x1 < u.w || y1 < u.h
        ? await sharp(u.buf).extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }).png().toBuffer()
        : u.buf;
      layers.push({ input, left: left + x0, top: top + y0 });
    }
  }
  const bg = comp.bg ? (([r, g, b]) => ({ r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255), alpha: 1 }))(parseColor(comp.bg)) : CLEAR;
  return sharp({ create: { width: W, height: H, channels: 4, background: bg } }).composite(layers).png().toBuffer();
}

/** 3×3 sheet of a tile at `size` px per tile. */
export async function sheet3x3(tile, size) {
  const m = await sharp(tile).metadata();
  const w = size, h = Math.max(1, Math.round((size * m.height) / m.width)); // a W×H tile keeps its shape
  const t = await sharp(tile).resize(w, h, { fit: 'fill' }).png().toBuffer();
  const input = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) input.push({ input: t, left: i * w, top: j * h });
  return sharp({ create: { width: w * 3, height: h * 3, channels: 4, background: CLEAR } }).composite(input).png().toBuffer();
}

/** Grey-range report for the `tint` set (Aurora: values within 35-65 % grey, mean about 50 %), and the tile's edge match. */
export async function stats(tile) {
  const { data, info } = await sharp(tile).flatten({ background: '#808080' }).raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height, c = info.channels, hist = new Uint32Array(256);
  let sum = 0, sat = 0;
  for (let i = 0; i < n; i++) {
    const r = data[i * c], g = data[i * c + 1], b = data[i * c + 2];
    const l = Math.round(0.3 * r + 0.59 * g + 0.11 * b);
    hist[l]++; sum += l; sat += Math.max(r, g, b) - Math.min(r, g, b);
  }
  const pct = p => { let a = 0; for (let v = 0; v < 256; v++) { a += hist[v]; if (a >= n * p) return v; } return 255; };
  const pc = v => Math.round((v / 255) * 1000) / 10;
  const lo = pct(0.01), hi = pct(0.99);
  return { mean_grey_pct: pc(sum / n), p1_grey_pct: pc(lo), p99_grey_pct: pc(hi), mean_chroma_pct: pc(sat / n),
    tint_set_ok: lo >= 0.35 * 255 - 6 && hi <= 0.65 * 255 + 6 && Math.abs(sum / n - 127.5) < 0.1 * 255 && sat / n < 0.04 * 255 };
}
