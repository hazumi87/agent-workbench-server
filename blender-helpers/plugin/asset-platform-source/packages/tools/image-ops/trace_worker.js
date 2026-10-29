// trace_worker.js — potrace tracing, run in a worker_thread so it never blocks the gateway's
// event loop (potrace and the k-means colour quantiser are pure-JS and CPU-bound).
//
// workerData: { data: RGBA bytes, width, height, method: 'mono'|'layers', params }
// posts:      { layers: [{ color, d }] }  — bottom→top; `d` in raster pixel coordinates.
import { parentPort, workerData } from 'worker_threads';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const potracePath = require.resolve('potrace');
const { Potrace } = require('potrace');
// potrace only accepts a Jimp image (or something Jimp.read can decode); build one from our raw
// mask with potrace's OWN Jimp so its `instanceof` check passes.
const Jimp = createRequire(potracePath)('jimp');

const { data, width, height, method, params } = workerData;
const N = width * height;

// fg: Uint8Array(N) of 0/1 → one potrace path string ('' when nothing traced).
function trace(fg) {
  const px = Buffer.alloc(N * 4, 255);
  for (let i = 0; i < N; i++) if (fg[i]) { const o = i * 4; px[o] = px[o + 1] = px[o + 2] = 0; }
  const p = new Potrace({
    threshold: 128, blackOnWhite: true, turdSize: params.turdSize, alphaMax: params.alphaMax,
    optCurve: params.optCurve, optTolerance: params.optTolerance,
  });
  p.loadImage(new Jimp({ data: px, width, height }), (e) => { if (e) throw e; });  // sync for a Jimp input
  return /d="([^"]*)"/.exec(p.getPathTag(''))[1].trim();
}

const lum = (i) => {          // luminance composited on white (potrace's own convention)
  const o = i * 4, a = data[o + 3] / 255;
  const r = 255 + (data[o] - 255) * a, g = 255 + (data[o + 1] - 255) * a, b = 255 + (data[o + 2] - 255) * a;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

function mono() {
  const useAlpha = params.channel === 'alpha' || (params.channel === 'auto' && hasAlpha());
  const fg = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    let on = useAlpha ? data[i * 4 + 3] >= params.threshold : lum(i) < params.threshold;
    if (params.invert) on = !on;
    fg[i] = on ? 1 : 0;
  }
  return { channel: useAlpha ? 'alpha' : 'luminance', layers: [{ color: params.color, d: trace(fg) }] };
}

// "Meaningful" alpha: at least 1% of pixels are mostly transparent.
function hasAlpha() {
  let n = 0;
  for (let i = 0; i < N; i++) if (data[i * 4 + 3] < 128) n++;
  return n >= N * 0.01;
}

// Deterministic PRNG so the same source + params always give the same SVG (replayable recipes).
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const dist2 = (c, r, g, b) => (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;

// k-means++ on a subsample of the opaque pixels → k centres [r,g,b].
function kmeans(k) {
  const rand = mulberry32(1);
  const opaque = [];
  for (let i = 0; i < N; i++) if (data[i * 4 + 3] >= 128) opaque.push(i);
  if (!opaque.length) return [];
  const step = Math.max(1, Math.floor(opaque.length / 20000));
  const S = [];
  for (let j = 0; j < opaque.length; j += step) { const o = opaque[j] * 4; S.push([data[o], data[o + 1], data[o + 2]]); }
  const C = [S[Math.floor(rand() * S.length)].slice()];
  const d = new Float64Array(S.length).fill(Infinity);
  while (C.length < k) {
    let sum = 0;
    const last = C[C.length - 1];
    for (let j = 0; j < S.length; j++) { d[j] = Math.min(d[j], dist2(last, ...S[j])); sum += d[j]; }
    if (sum === 0) break;                       // fewer distinct colours than k
    let t = rand() * sum, j = 0;
    while ((t -= d[j]) > 0 && j < S.length - 1) j++;
    C.push(S[j].slice());
  }
  const lab = new Int32Array(S.length);
  for (let it = 0; it < 15; it++) {
    const acc = C.map(() => [0, 0, 0, 0]);
    for (let j = 0; j < S.length; j++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < C.length; c++) { const dd = dist2(C[c], ...S[j]); if (dd < bd) { bd = dd; best = c; } }
      lab[j] = best; const a = acc[best]; a[0] += S[j][0]; a[1] += S[j][1]; a[2] += S[j][2]; a[3]++;
    }
    let moved = 0;
    C.forEach((c, i) => { const a = acc[i]; if (!a[3]) return;
      const n = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; moved += dist2(c, ...n); C[i] = n; });
    if (moved < 1) break;
  }
  return C;
}

const hex = (c) => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');

function layers() {
  const C = kmeans(params.colors);
  const label = new Int16Array(N).fill(-1);       // -1 = transparent
  const count = new Array(C.length).fill(0);
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    if (data[o + 3] < 128) continue;
    let best = 0, bd = Infinity;
    for (let c = 0; c < C.length; c++) { const dd = dist2(C[c], data[o], data[o + 1], data[o + 2]); if (dd < bd) { bd = dd; best = c; } }
    label[i] = best; count[best]++;
  }
  // Background = what the border mostly is: transparent, or one colour cluster.
  const border = new Map();
  const vote = (i) => border.set(label[i], (border.get(label[i]) || 0) + 1);
  for (let x = 0; x < width; x++) { vote(x); vote((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { vote(y * width); vote(y * width + width - 1); }
  const bg = [...border].sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1;
  // Stack bottom→top: background first, then by area (largest underneath). In fill style each
  // layer's mask is the union of itself and every layer above it, so layers overlap instead of
  // leaving hairline gaps; in outline style each layer outlines only its own colour.
  const order = C.map((_, i) => i).filter(i => count[i] > 0 && i !== bg).sort((a, b) => count[b] - count[a]);
  if (bg >= 0) order.unshift(bg);
  const out = [];
  order.forEach((c, pos) => {
    if (params.dropBackground && c === bg) return;
    const above = new Set(order.slice(pos));
    const fg = new Uint8Array(N);
    for (let i = 0; i < N; i++) fg[i] = params.style === 'fill' ? (above.has(label[i]) ? 1 : 0) : (label[i] === c ? 1 : 0);
    const d = trace(fg);
    if (d) out.push({ color: hex(C[c]), d });
  });
  return { background: bg >= 0 ? hex(C[bg]) : 'transparent', palette: order.map(c => hex(C[c])), layers: out };
}

parentPort.postMessage(method === 'mono' ? mono() : layers());
