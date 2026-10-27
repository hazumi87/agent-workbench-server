/* contour-trace — turn a black-on-white bitmap into a single-colour SVG path, with no dependency.
 *
 * Written 2026-10 to replace `potrace` (GPL-2.0) in the Icon Lab. A packaged tracer (@image-tracer-ts/core) was tried first and
 * could not keep rounded shapes round at 48-64 px: it follows the pixel staircase and fits straight facets. This does it the
 * other way round, which is also why potrace looked good: find the contour at SUB-PIXEL accuracy, then round the corners.
 *
 *   1. coverage field: ink = 1, background = 0, one value per pixel, padded with a border of 0 so every contour closes;
 *   2. a small blur (the corner-rounding lever: `smooth`), so a staircase becomes a slope;
 *   3. marching squares at 0.5, edge crossings placed by linear interpolation, loops linked by their edge ids;
 *   4. loops with area <= `turd` square pixels are dropped (speckle, and holes that small are filled);
 *   5. Douglas-Peucker to cut the point count, then every corner rounded with a quadratic curve whose reach is capped at
 *      `round` pixels and at half the adjoining edge, so long straight edges stay straight and short ones become curves.
 *
 * Pure functions, no I/O. Output is one <path> (even-odd) in the bitmap's own pixel coordinates.
 */
export interface TraceOptions {
  /** Drop loops whose area is this many square pixels or fewer. */
  turd: number;
  /** Corner rounding reach in pixels (0 = polygon with sharp corners). */
  round: number;
  /** Blur sigma in pixels applied to the coverage field before contouring. */
  smooth: number;
  /** Douglas-Peucker tolerance in pixels. */
  tolerance?: number;
}

type Pt = [number, number];

function blur(f: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0) {
    return f;
  }
  const rad = Math.max(1, Math.ceil(sigma * 2.5));
  const k: number[] = [];
  let sum = 0;
  for (let i = -rad; i <= rad; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k.push(v);
    sum += v;
  }
  for (let i = 0; i < k.length; i++) {
    k[i] /= sum;
  }
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -rad; i <= rad; i++) {
        const xx = x + i;
        a += xx >= 0 && xx < w ? f[y * w + xx] * k[i + rad] : 0;
      }
      tmp[y * w + x] = a;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -rad; i <= rad; i++) {
        const yy = y + i;
        a += yy >= 0 && yy < h ? tmp[yy * w + x] * k[i + rad] : 0;
      }
      out[y * w + x] = a;
    }
  }
  return out;
}

/** Marching squares at iso 0.5 over a w*h field; returns closed loops in field coordinates. */
function contours(f: Float32Array, w: number, h: number): Pt[][] {
  const iso = 0.5;
  // Edge ids: horizontal edge between (x,y)-(x+1,y) = (y*w + x)*2, vertical between (x,y)-(x,y+1) = (y*w + x)*2 + 1.
  const hEdge = (x: number, y: number) => (y * w + x) * 2;
  const vEdge = (x: number, y: number) => (y * w + x) * 2 + 1;
  const pos = new Map<number, Pt>();
  const at = (x: number, y: number) => f[y * w + x];
  const lerp = (a: number, b: number) => (iso - a) / (b - a);
  const point = (id: number): Pt => {
    let p = pos.get(id);
    if (p) {
      return p;
    }
    const x = (id >> 1) % w;
    const y = Math.floor((id >> 1) / w);
    if ((id & 1) === 0) {
      p = [x + lerp(at(x, y), at(x + 1, y)), y];
    } else {
      p = [x, y + lerp(at(x, y), at(x, y + 1))];
    }
    pos.set(id, p);
    return p;
  };
  const adj = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  };
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const tl = at(x, y) >= iso;
      const tr = at(x + 1, y) >= iso;
      const br = at(x + 1, y + 1) >= iso;
      const bl = at(x, y + 1) >= iso;
      const code = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
      if (code === 0 || code === 15) {
        continue;
      }
      const top = hEdge(x, y);
      const bottom = hEdge(x, y + 1);
      const left = vEdge(x, y);
      const right = vEdge(x + 1, y);
      switch (code) {
        case 1: case 14: link(left, bottom); break;
        case 2: case 13: link(bottom, right); break;
        case 3: case 12: link(left, right); break;
        case 4: case 11: link(top, right); break;
        case 6: case 9: link(top, bottom); break;
        case 7: case 8: link(left, top); break;
        case 5: case 10: {
          // Saddle: decide by the cell centre so thin diagonals stay joined only when the middle is ink.
          const centre = (at(x, y) + at(x + 1, y) + at(x + 1, y + 1) + at(x, y + 1)) / 4 >= iso;
          const joined = code === 5 ? centre : !centre;
          if (joined) {
            link(top, left);
            link(bottom, right);
          } else {
            link(top, right);
            link(bottom, left);
          }
          break;
        }
      }
    }
  }
  const seen = new Set<number>();
  const loops: Pt[][] = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) {
      continue;
    }
    const loop: Pt[] = [];
    let prev = -1;
    let cur = start;
    for (let guard = 0; guard < 4_000_000; guard++) {
      seen.add(cur);
      loop.push(point(cur));
      const nb = adj.get(cur)!;
      const next = nb[0] !== prev ? nb[0] : nb[1];
      // A 2-point oddity (both neighbours equal) ends the walk rather than looping forever.
      if (next === undefined || next === start) {
        break;
      }
      prev = cur;
      cur = next;
    }
    if (loop.length >= 3) {
      loops.push(loop);
    }
  }
  return loops;
}

function area(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  return len === 0 ? Math.hypot(p[0] - a[0], p[1] - a[1]) : Math.abs(dx * (a[1] - p[1]) - (a[0] - p[0]) * dy) / len;
}

function dp(pts: Pt[], lo: number, hi: number, tol: number, keep: boolean[]): void {
  let worst = -1;
  let wi = -1;
  for (let i = lo + 1; i < hi; i++) {
    const d = perpDist(pts[i], pts[lo], pts[hi]);
    if (d > worst) {
      worst = d;
      wi = i;
    }
  }
  if (worst > tol && wi > 0) {
    keep[wi] = true;
    dp(pts, lo, wi, tol, keep);
    dp(pts, wi, hi, tol, keep);
  }
}

/** Douglas-Peucker on a CLOSED loop: split at the two points farthest apart so neither end is arbitrary. */
function simplify(loop: Pt[], tol: number): Pt[] {
  if (loop.length < 8) {
    return loop;
  }
  let a = 0;
  let b = 0;
  let best = -1;
  const step = Math.max(1, Math.floor(loop.length / 64));
  for (let i = 0; i < loop.length; i += step) {
    for (let j = i + 1; j < loop.length; j += step) {
      const d = Math.hypot(loop[i][0] - loop[j][0], loop[i][1] - loop[j][1]);
      if (d > best) {
        best = d;
        a = i;
        b = j;
      }
    }
  }
  const first = loop.slice(a, b + 1);
  const second = [...loop.slice(b), ...loop.slice(0, a + 1)];
  const run = (seg: Pt[]): Pt[] => {
    const keep = new Array<boolean>(seg.length).fill(false);
    keep[0] = true;
    keep[seg.length - 1] = true;
    dp(seg, 0, seg.length - 1, tol, keep);
    return seg.filter((_, i) => keep[i]);
  };
  const s1 = run(first);
  const s2 = run(second);
  return [...s1.slice(0, -1), ...s2.slice(0, -1)];
}

const f2 = (n: number) => String(Math.round(n * 100) / 100);

/** A closed polygon as a path whose every corner is cut by a quadratic curve reaching at most `round` px along each edge. */
function roundedPath(poly: Pt[], round: number): string {
  const n = poly.length;
  if (n < 3) {
    return '';
  }
  const cut = (from: Pt, to: Pt, d: number): Pt => {
    const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const t = len === 0 ? 0 : Math.min(1, d / len);
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
  };
  let d = '';
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n];
    const cur = poly[i];
    const next = poly[(i + 1) % n];
    const lin = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    const lout = Math.hypot(next[0] - cur[0], next[1] - cur[1]);
    const reach = Math.min(round, lin / 2, lout / 2);
    const a = cut(cur, prev, reach);
    const b = cut(cur, next, reach);
    d += `${i === 0 ? 'M' : 'L'}${f2(a[0])} ${f2(a[1])}Q${f2(cur[0])} ${f2(cur[1])} ${f2(b[0])} ${f2(b[1])}`;
  }
  return `${d}Z`;
}

/** `ink[i]` is 1 where the pixel is ink, 0 elsewhere (w*h values). Returns a complete SVG string in pixel units. */
export function traceInk(ink: Uint8Array, w: number, h: number, opt: TraceOptions): string {
  // Pad by two pixels so every contour closes, and a blur cannot clip it.
  const pad = 2;
  const W = w + pad * 2;
  const H = h + pad * 2;
  let f: Float32Array = new Float32Array(W * H);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      f[(y + pad) * W + x + pad] = ink[y * w + x] ? 1 : 0;
    }
  }
  f = blur(f, W, H, opt.smooth);
  // Fine at small sizes, proportionally looser at large ones (a 512 px trace does not need 0.12 px of precision).
  const tol = opt.tolerance ?? Math.max(0.12, 0.002 * Math.max(w, h));
  const parts: string[] = [];
  for (const raw of contours(f, W, H)) {
    // Field vertices sit on pixel centres: shift by half a pixel and remove the padding.
    const loop = raw.map(([x, y]): Pt => [x - pad + 0.5, y - pad + 0.5]);
    if (Math.abs(area(loop)) <= opt.turd) {
      continue;
    }
    const d = roundedPath(simplify(loop, tol), opt.round);
    if (d) {
      parts.push(d);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><path fill="#000" fill-rule="evenodd" d="${parts.join('')}"/></svg>`;
}
