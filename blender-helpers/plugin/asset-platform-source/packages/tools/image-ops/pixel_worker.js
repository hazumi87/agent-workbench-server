// pixel_worker.js — per-pixel image maths for image-ops, run in a worker_thread so a big image
// never blocks the gateway's event loop. Pure JS on RGBA bytes; heights are Float32 0..1 so
// blurs and gradients don't band.
//
// workerData: { fn, data: RGBA bytes, width, height, params }
// posts:      { data: RGBA bytes, width, height, meta? }   (data's buffer is transferred)
import { parentPort, workerData } from 'worker_threads';

const { fn, data, width: W, height: H, params: p } = workerData;
const N = W * H;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const to8 = (v) => Math.round(clamp01(v) * 255);

// ── fields ────────────────────────────────────────────────────────────────────────────
// channel → Float32 0..1. 'luminance' is Rec.709; onWhite composites over white first (so a
// cut-out's silhouette reads as an edge); texture ops ignore alpha.
function field(channel = 'luminance', onWhite = false) {
  const f = new Float32Array(N);
  const k = { r: 0, g: 1, b: 2, a: 3 }[channel];
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    if (k !== undefined) { f[i] = data[o + k] / 255; continue; }
    let r = data[o], g = data[o + 1], b = data[o + 2];
    if (onWhite) { const a = data[o + 3] / 255; r = 255 + (r - 255) * a; g = 255 + (g - 255) * a; b = 255 + (b - 255) * a; }
    f[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }
  return f;
}

// lo/hi quantiles of a 0..1 field (4096-bin histogram), optionally only where use[i].
function quantiles(f, lo, hi, use) {
  const B = 4096, hist = new Uint32Array(B);
  let n = 0;
  for (let i = 0; i < f.length; i++) if (!use || use[i]) { hist[Math.min(B - 1, (f[i] * B) | 0)]++; n++; }
  const at = (q) => { let c = 0; const t = q * n; for (let b = 0; b < B; b++) { c += hist[b]; if (c > t) return (b + 0.5) / B; } return 1; };
  return n ? [at(lo), at(hi)] : [0, 1];
}

function stretch(f) {           // auto contrast: 0.5%/99.5% quantiles → 0..1
  const [a, b] = quantiles(f, 0.005, 0.995);
  const s = b > a ? 1 / (b - a) : 1;
  for (let i = 0; i < N; i++) f[i] = clamp01((f[i] - a) * s);
  return f;
}

// Gaussian ≈ three box blurs (O(1) per pixel whatever the sigma). wrap = tileable sampling.
function boxSizes(sigma) {
  const wIdeal = Math.sqrt(12 * sigma * sigma / 3 + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const m = Math.round((12 * sigma * sigma - 3 * wl * wl - 12 * wl - 9) / (-4 * wl - 4));
  return [0, 1, 2].map(i => ((i < m ? wl : wl + 2) - 1) / 2);
}
const idx = (k, n, wrap) => (wrap ? ((k % n) + n) % n : k < 0 ? 0 : k >= n ? n - 1 : k);
function boxPass(src, dst, r, horizontal, wrap) {
  const [len, lines] = horizontal ? [W, H] : [H, W];
  const at = horizontal ? (line, k) => line * W + k : (line, k) => k * W + line;
  const inv = 1 / (2 * r + 1);
  for (let line = 0; line < lines; line++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[at(line, idx(k, len, wrap))];
    for (let k = 0; k < len; k++) {
      dst[at(line, k)] = sum * inv;
      sum += src[at(line, idx(k + r + 1, len, wrap))] - src[at(line, idx(k - r, len, wrap))];
    }
  }
}
function gaussian(f, sigma, wrap = false) {
  if (!(sigma > 0)) return f;
  let a = f, b = new Float32Array(N);
  for (const r of boxSizes(sigma)) {
    if (r < 1) continue;
    boxPass(a, b, r, true, wrap); boxPass(b, a, r, false, wrap);
  }
  return a;
}

// Sobel gradients (x right, y down), unnormalised: a 0→1 step gives 4.
function sobel(f, wrap) {
  const gx = new Float32Array(N), gy = new Float32Array(N);
  for (let y = 0; y < H; y++) {
    const ym = idx(y - 1, H, wrap) * W, y0 = y * W, yp = idx(y + 1, H, wrap) * W;
    for (let x = 0; x < W; x++) {
      const xm = idx(x - 1, W, wrap), xp = idx(x + 1, W, wrap);
      const tl = f[ym + xm], t = f[ym + x], tr = f[ym + xp], l = f[y0 + xm], r = f[y0 + xp];
      const bl = f[yp + xm], b = f[yp + x], br = f[yp + xp];
      gx[y0 + x] = (tr + 2 * r + br) - (tl + 2 * l + bl);
      gy[y0 + x] = (bl + 2 * b + br) - (tl + 2 * t + tr);
    }
  }
  return { gx, gy };
}

// Height field for texture ops. heightParams = the `height` op's params.
function heightField(hp) {
  const f = field(hp.channel);
  if (hp.invert) for (let i = 0; i < N; i++) f[i] = 1 - f[i];
  const g = gaussian(f, hp.blur, hp.wrap);
  return hp.contrast === 'auto' ? stretch(g) : g;
}
const HEIGHT_FROM_IMAGE = { channel: 'luminance', invert: false, blur: 1, contrast: 'auto' };
const heightFor = (q) => heightField(q.source === 'height'
  ? { channel: 'luminance', invert: false, blur: 0, contrast: 'none', wrap: q.wrap }
  : { ...HEIGHT_FROM_IMAGE, wrap: q.wrap });

function grey(f) {              // 0..1 field → opaque grey RGBA
  const out = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) { const v = to8(f[i]), o = i * 4; out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255; }
  return out;
}
function lut(table) {           // RGB through a 256-entry table, alpha kept
  const out = new Uint8Array(data.length);
  for (let o = 0; o < data.length; o += 4) {
    out[o] = table[data[o]]; out[o + 1] = table[data[o + 1]]; out[o + 2] = table[data[o + 2]]; out[o + 3] = data[o + 3];
  }
  return out;
}

// ── ops ───────────────────────────────────────────────────────────────────────────────
const FNS = {
  levels() {
    let { black, white } = p;
    if (p.auto) {
      const f = field('luminance');
      const opaque = new Uint8Array(N);
      let any = false;
      for (let i = 0; i < N; i++) if (data[i * 4 + 3] >= 128) { opaque[i] = 1; any = true; }
      const [a, b] = quantiles(f, 0.005, 0.995, any ? opaque : null);
      black = Math.round(a * 255); white = Math.max(black + 1, Math.round(b * 255));
    }
    const t = new Uint8Array(256);
    for (let v = 0; v < 256; v++) t[v] = to8(Math.pow(clamp01((v - black) / (white - black)), 1 / p.gamma));
    return { data: lut(t), meta: { black, white } };
  },
  posterize() {
    const t = new Uint8Array(256), L = p.levels - 1;
    for (let v = 0; v < 256; v++) t[v] = Math.round(Math.round(v / 255 * L) * 255 / L);
    return { data: lut(t) };
  },
  edges() {
    const { gx, gy } = sobel(field('luminance', true), false);
    const e = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let v = clamp01(Math.hypot(gx[i], gy[i]) / 4 * p.strength);
      if (p.threshold !== undefined) v = v * 255 >= p.threshold ? 1 : 0;
      e[i] = p.invert ? 1 - v : v;
    }
    return { data: grey(e) };
  },
  height() { return { data: grey(heightField(p)) }; },
  normal() {
    // OpenGL / +Y up (green = surface faces up the image); flip_green → DirectX (+Y down).
    const { gx, gy } = sobel(heightFor(p), p.wrap);
    const out = new Uint8Array(N * 4), sy = p.flip_green ? -1 : 1;
    for (let i = 0; i < N; i++) {
      const nx = -gx[i] * p.strength, ny = sy * gy[i] * p.strength, len = Math.hypot(nx, ny, 1), o = i * 4;
      out[o] = to8((nx / len + 1) / 2); out[o + 1] = to8((ny / len + 1) / 2); out[o + 2] = to8((1 / len + 1) / 2); out[o + 3] = 255;
    }
    return { data: out };
  },
  ao() {
    // cavity: how far a pixel sits below its blurred neighbourhood → darker.
    const h = heightFor(p);
    const b = gaussian(Float32Array.from(h), p.radius / 2, p.wrap);
    const a = new Float32Array(N);
    for (let i = 0; i < N; i++) a[i] = 1 - p.strength * 4 * Math.max(0, b[i] - h[i]);
    return { data: grey(a) };
  },
  seamless() {
    // offset-blend, one axis at a time. Along x: S = the image shifted by half (continuous across
    // its left/right borders, seam down the middle); over a band of `bw` px around that middle
    // seam fade back to the unshifted image, which is continuous there → tiles in x, no hard seam.
    // Then the same along y on that result (a y-shift keeps the x-tiling). Doing both axes at
    // once would let the horizontal band reach the side borders and re-expose the original seam.
    // Shift by ceil(n/2) so the seam sits between h-1 and h for odd sizes too.
    const hx = W >> 1, hy = H >> 1;
    const want = p.blend < 1 ? Math.round(p.blend * Math.min(W, H)) : p.blend;
    const bw = Math.max(1, Math.min(want, Math.min(hx, hy) - 1));   // the band never reaches a border
    const ramp = (d) => { const t = clamp01(1 - d / bw); return t * t * (3 - 2 * t); };   // smoothstep
    const pass = (src, alongX) => {
      const out = new Uint8Array(N * 4);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const w = alongX ? ramp(Math.abs(x - hx + 0.5)) : ramp(Math.abs(y - hy + 0.5));
          const s = (alongX ? y * W + (x + W - hx) % W : ((y + H - hy) % H) * W + x) * 4, o = (y * W + x) * 4;
          for (let c = 0; c < 4; c++) out[o + c] = Math.round(src[s + c] + (src[o + c] - src[s + c]) * w);
        }
      }
      return out;
    };
    return { data: pass(pass(data, true), false), meta: { blend_px: bw } };
  },
  fill() {
    // magic wand: colours compared premultiplied (so every fully transparent pixel matches every
    // other), max per-channel difference ≤ tolerance. Each seed floods (4-connected) or scans on its
    // own; mark[] holds the seed number so a later seed can pass through an earlier seed's region.
    const at = (q) => Math.min(H - 1, Math.floor(q.y * H)) * W + Math.min(W - 1, Math.floor(q.x * W));
    const pm = (i, c) => (c === 3 ? data[i * 4 + 3] : data[i * 4 + c] * data[i * 4 + 3] / 255);
    const sel = new Uint8Array(N), mark = new Uint8Array(N), stack = new Int32Array(N);
    p.points.forEach((pt, k) => {
      const s = at(pt), seed = [0, 1, 2, 3].map(c => pm(s, c)), id = k + 1;
      const near = (i) => { for (let c = 0; c < 4; c++) if (Math.abs(pm(i, c) - seed[c]) > p.tolerance) return false; return true; };
      if (!p.contiguous) { for (let i = 0; i < N; i++) if (near(i)) sel[i] = 1; return; }
      let n = 0;
      const push = (j) => { if (mark[j] !== id && near(j)) { mark[j] = id; stack[n++] = j; } };
      push(s);
      while (n) {
        const i = stack[--n], x = i % W;
        sel[i] = 1;
        if (x > 0) push(i - 1);
        if (x < W - 1) push(i + 1);
        if (i >= W) push(i - W);
        if (i < N - W) push(i + W);
      }
    });
    // grow / feather: chamfer distance (1, √2) from the selection, two passes.
    let weight = (i) => sel[i];
    if (p.grow || p.feather) {
      const d = new Float32Array(N);
      for (let i = 0; i < N; i++) d[i] = sel[i] ? 0 : Infinity;
      const relax = (i, x, y, dx, dy, w) => {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < W && yy >= 0 && yy < H && d[yy * W + xx] + w < d[i]) d[i] = d[yy * W + xx] + w;
      };
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        relax(i, x, y, -1, 0, 1); relax(i, x, y, 0, -1, 1); relax(i, x, y, -1, -1, Math.SQRT2); relax(i, x, y, 1, -1, Math.SQRT2);
      }
      for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
        const i = y * W + x;
        relax(i, x, y, 1, 0, 1); relax(i, x, y, 0, 1, 1); relax(i, x, y, 1, 1, Math.SQRT2); relax(i, x, y, -1, 1, Math.SQRT2);
      }
      weight = (i) => (d[i] <= p.grow ? 1 : p.feather ? clamp01(1 - (d[i] - p.grow) / p.feather) : 0);
    }
    const paintc = p.mode === 'fill' ? p.rgba : p.mode === 'sample' ? [...data.subarray(at(p.color_from) * 4, at(p.color_from) * 4 + 4)] : null;
    const out = new Uint8Array(data);
    let selected = 0;
    for (let i = 0; i < N; i++) {
      const w = weight(i), o = i * 4;
      if (!w) continue;
      selected++;
      if (!paintc) out[o + 3] = Math.round(data[o + 3] * (1 - w));
      else for (let c = 0; c < 4; c++) out[o + c] = Math.round(data[o + c] + (paintc[c] - data[o + c]) * w);
    }
    const sampled = p.mode === 'sample' && { color: '#' + paintc.map(v => v.toString(16).padStart(2, '0')).join('') };
    return { data: out, meta: { selected, ...sampled } };
  },
};

const r = FNS[fn]();
parentPort.postMessage({ width: W, height: H, meta: r.meta, data: r.data }, [r.data.buffer]);
