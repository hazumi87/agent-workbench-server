// Clip editor — the segment model (pure, no DOM). Plan: the design notes §2/§4.
//
// The source axis is covered by contiguous segments, each kept or removed. Nothing is
// ever deleted ("mark, don't delete"): Remove flips a range to removed, Restore flips it
// back. Adjacent removed segments are always merged, so between two kept runs there is
// exactly one removed "gap" — that gap owns the join's crossfade (fadeMs).

export const MIN_SEG = 0.01; // s — minimum kept segment (audio), so a join always fits
const EPS = 1e-6;

// padMs: silence inserted in the OUTPUT right before this kept segment (Insert silence, the user
//). It lives on the source axis as a property, so the source model stays contiguous.
export interface Seg { t0: number; t1: number; removed: boolean; fadeMs?: number | null; padMs?: number }

export interface Draft {
  v: 1;
  segs: Seg[];
  defaultFadeMs: number;
  zc: boolean;        // snap cuts to zero crossings
  flagClip: boolean;  // mark clipped samples in kept audio
}

export function freshDraft(dur: number): Draft {
  return { v: 1, segs: [{ t0: 0, t1: dur, removed: false }], defaultFadeMs: 10, zc: true, flagClip: true };
}

export function segAt(segs: Seg[], t: number): number {
  for (let i = 0; i < segs.length; i++) if (t < segs[i].t1 - EPS || i === segs.length - 1) return i;
  return segs.length - 1;
}

// Merge adjacent removed segments; also merge kept neighbours when `mergeKept`.
function normalize(segs: Seg[], mergeKept = false): Seg[] {
  const out: Seg[] = [];
  for (const s of segs) {
    const p = out[out.length - 1];
    if (p && p.removed === s.removed && (s.removed || (mergeKept && !s.padMs))) {   // a silence keeps its cut
      out[out.length - 1] = { ...p, t1: s.t1, fadeMs: p.fadeMs ?? s.fadeMs };
    } else out.push({ ...s });
  }
  return out;
}

// Cut at t. A cut closer than MIN_SEG to an existing boundary lands ON that boundary.
function cutAt(segs: Seg[], t: number): { segs: Seg[]; t: number } {
  const i = segAt(segs, t);
  const s = segs[i];
  if (t - s.t0 < MIN_SEG) return { segs, t: s.t0 };
  if (s.t1 - t < MIN_SEG) return { segs, t: s.t1 };
  return { segs: [...segs.slice(0, i), { ...s, t1: t }, { ...s, t0: t, fadeMs: null, padMs: undefined }, ...segs.slice(i + 1)], t };
}

export function split(segs: Seg[], t: number): Seg[] { return cutAt(segs, t).segs; }

// Silence of `ms` before the kept audio at t (a cut is made there if needed). ms = 0 clears it.
export function insertSilence(segs: Seg[], t: number, ms: number): Seg[] {
  const c = cutAt(segs, t);
  const i = c.segs.findIndex(s => !s.removed && s.t0 >= c.t - EPS);
  if (i < 0) return segs;
  return c.segs.map((s, j) => (j === i ? { ...s, padMs: ms > 0 ? ms : undefined } : s));
}

export function removeRange(segs: Seg[], a: number, b: number): Seg[] {
  if (b < a) [a, b] = [b, a];
  const A = cutAt(segs, a); const B = cutAt(A.segs, b);
  return normalize(B.segs.map(s => (s.t0 >= A.t - EPS && s.t1 <= B.t + EPS ? { ...s, removed: true } : s)));
}

export function keepOnly(segs: Seg[], a: number, b: number): Seg[] {
  if (b < a) [a, b] = [b, a];
  const end = segs[segs.length - 1].t1;
  let out = segs;
  if (a > MIN_SEG) out = removeRange(out, 0, a);
  if (end - b > MIN_SEG) out = removeRange(out, b, end);
  return out;
}

export function removeSegAt(segs: Seg[], t: number): Seg[] {
  const i = segAt(segs, t);
  if (segs[i].removed) return segs;
  return normalize(segs.map((s, j) => (j === i ? { ...s, removed: true } : s)));
}

// Restore the removed segment at t and heal it into its kept neighbours.
export function restoreAt(segs: Seg[], t: number): Seg[] {
  const i = segAt(segs, t);
  if (!segs[i].removed) return segs;
  const out = segs.map((s, j) => (j === i ? { ...s, removed: false, fadeMs: null } : s));
  // merge only across the restored segment's own edges, so user split marks elsewhere survive
  const merged: Seg[] = [];
  out.forEach((s, j) => {
    const p = merged[merged.length - 1];
    if (p && !p.removed && !s.removed && (j === i || j === i + 1)) merged[merged.length - 1] = { ...p, t1: s.t1 };
    else merged.push(s);
  });
  return merged;
}

// Drag the boundary between segs[i] and segs[i+1].
export function moveBoundary(segs: Seg[], i: number, t: number): Seg[] {
  const lo = segs[i].t0 + MIN_SEG, hi = segs[i + 1].t1 - MIN_SEG;
  const x = Math.min(hi, Math.max(lo, t));
  return segs.map((s, j) => (j === i ? { ...s, t1: x } : j === i + 1 ? { ...s, t0: x } : s));
}

export function setFade(segs: Seg[], i: number, fadeMs: number | null): Seg[] {
  return segs.map((s, j) => (j === i ? { ...s, fadeMs } : s));
}

// A join = a removed gap with kept audio on both sides.
export function isJoin(segs: Seg[], i: number): boolean {
  return segs[i].removed && i > 0 && i < segs.length - 1 && !segs[i - 1].removed && !segs[i + 1].removed;
}

// What Create clip renders: contiguous kept runs + one fade per join (ms).
// pads[i] (ms) = silence before ranges[i].
export function keptRanges(segs: Seg[], defaultFadeMs: number): { ranges: [number, number][]; fades: number[]; pads: number[] } {
  const ranges: [number, number][] = []; const fades: number[] = []; const pads: number[] = [];
  segs.forEach((s, i) => {
    if (s.removed) {
      if (isJoin(segs, i) && ranges.length) fades.push(s.fadeMs ?? defaultFadeMs);
      return;
    }
    const p = ranges[ranges.length - 1];
    if (p && Math.abs(p[1] - s.t0) < EPS && !s.padMs) p[1] = s.t1;
    else {
      if (p && Math.abs(p[1] - s.t0) < EPS) fades.push(0);   // adjacent, split only by a silence: no crossfade
      ranges.push([s.t0, s.t1]); pads.push(s.padMs ?? 0);
    }
  });
  return { ranges, fades, pads };
}

// Mirrors the server's clamp (fade ≤ half of either neighbour).
export function editedDuration(segs: Seg[], defaultFadeMs: number): number {
  const { ranges, fades, pads } = keptRanges(segs, defaultFadeMs);
  let d = ranges.reduce((a, [x, y]) => a + (y - x), 0) + pads.reduce((a, ms) => a + ms / 1000, 0);
  fades.forEach((ms, i) => {
    d -= Math.min(ms / 1000, (ranges[i][1] - ranges[i][0]) / 2, (ranges[i + 1][1] - ranges[i + 1][0]) / 2);
  });
  return d;
}

// Rebuild segments from a created clip's derived_op (Edit again).
export function segsFromRanges(ranges: [number, number][], fades: number[], dur: number, pads: number[] = []): Seg[] {
  const segs: Seg[] = []; let t = 0;
  ranges.forEach(([a, b], i) => {
    if (a - t > EPS) segs.push({ t0: t, t1: a, removed: true, fadeMs: i > 0 ? fades[i - 1] ?? null : null });
    segs.push({ t0: a, t1: b, removed: false, ...(pads[i] > 0 && { padMs: pads[i] }) });
    t = b;
  });
  if (dur - t > EPS) segs.push({ t0: t, t1: dur, removed: true });
  return segs;
}

export function fmtTime(t: number, ms = 3): string {
  const sign = t < 0 ? '-' : ''; t = Math.abs(t);
  const m = Math.floor(t / 60); const s = t - m * 60;
  return `${sign}${m}:${s.toFixed(ms).padStart(ms + 3, '0')}`;
}
