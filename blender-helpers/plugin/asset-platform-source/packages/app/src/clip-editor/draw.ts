// Clip editor — canvas painting. One time-base mapping (DispMap) is used for every
// drawing, hit-test and seek (Stem Lab's discipline): Source view shows the full source
// axis; Edited view collapses removed segments to zero width.
import type { Seg } from './model';
import { isJoin } from './model';
import type { Peaks } from './audio';

export const GUT = 34, TICK = 22, LANE = 28;

export class DispMap {
  readonly segs: (Seg & { d0: number; d1: number; i: number })[];
  readonly total: number;
  constructor(segs: Seg[], edited: boolean) {
    let d = 0;
    this.segs = segs.map((s, i) => {
      const w = edited && s.removed ? 0 : s.t1 - s.t0;
      const o = { ...s, d0: d, d1: d + w, i }; d += w; return o;
    });
    this.total = d;
  }
  toDisp(t: number): number {
    for (const s of this.segs) if (t < s.t1 || s === this.segs[this.segs.length - 1]) {
      return s.d1 === s.d0 ? s.d0 : s.d0 + Math.min(Math.max(t - s.t0, 0), s.t1 - s.t0);
    }
    return this.total;
  }
  fromDisp(d: number): number {
    for (const s of this.segs) if (s.d1 > s.d0 && (d < s.d1 || s === this.segs[this.segs.length - 1])) {
      return s.t0 + Math.min(Math.max(d - s.d0, 0), s.t1 - s.t0);
    }
    return this.segs.length ? this.segs[this.segs.length - 1].t1 : 0;
  }
}

export interface View { t0: number; spp: number; sr: number; W: number } // t0 in display time
export const secPerPx = (v: View) => v.spp / v.sr;
export const spanOf = (v: View) => (v.W - GUT) * secPerPx(v);
export const xOf = (v: View, d: number) => GUT + (d - v.t0) / secPerPx(v);
export const dAt = (v: View, x: number) => v.t0 + (x - GUT) * secPerPx(v);

// Colours: tokens resolved through the cascade, then normalised to rgba() via a 1-px
// canvas so color-mix()/color() values always work as canvas styles.
export type Colors = Record<'ink' | 'surface' | 'surface2' | 'surface3' | 'border2' | 'text' | 'dim' | 'dim2' | 'dim3'
  | 'keep' | 'keepSoft' | 'wave' | 'waveRemoved' | 'sel' | 'selSoft' | 'playhead' | 'wash' | 'hatch' | 'cut' | 'hover' | 'clip', string>;
const TOKENS: Record<keyof Colors, string> = {
  ink: 'var(--ink, #0C1014)', surface: 'var(--surface, #12181f)', surface2: 'var(--surface2, #19212a)',
  surface3: 'var(--surface3, #222a34)', border2: 'var(--border2, #323c49)', text: 'var(--text, #ddd)',
  dim: 'var(--dim, #8a96a3)', dim2: 'var(--dim2, #5d6874)', dim3: 'var(--dim3, #3a434d)',
  keep: 'var(--ce-keep, var(--teal, #2DD4BF))',
  keepSoft: 'var(--ce-keep-soft, color-mix(in srgb, var(--teal, #2DD4BF) 16%, transparent))',
  wave: 'var(--ce-wave, var(--teal, #2DD4BF))', waveRemoved: 'var(--ce-wave-removed, var(--dim3, #3a434d))',
  sel: 'var(--ce-sel, var(--sky, #38BDF8))',
  selSoft: 'var(--ce-sel-soft, color-mix(in srgb, var(--sky, #38BDF8) 18%, transparent))',
  playhead: 'var(--ce-playhead, var(--amber, #FBBF24))',
  wash: 'var(--ce-removed-wash, color-mix(in srgb, var(--ink, #0C1014) 62%, transparent))',
  hatch: 'var(--dim2, #5d6874)', cut: 'var(--ce-cut, var(--dim, #8a96a3))',
  hover: 'var(--ce-hover, var(--dim2, #5d6874))', clip: 'var(--ce-clip, var(--magenta, #FF2D78))',
};
export function readColors(host: HTMLElement): Colors {
  const probe = document.createElement('span'); host.appendChild(probe);
  const c = document.createElement('canvas'); c.width = c.height = 1;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  const out = {} as Colors;
  for (const k of Object.keys(TOKENS) as (keyof Colors)[]) {
    probe.style.color = TOKENS[k];
    g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = getComputedStyle(probe).color; g.fillRect(0, 0, 1, 1);
    const [r, gg, b, a] = g.getImageData(0, 0, 1, 1).data;
    out[k] = `rgba(${r},${gg},${b},${(a / 255).toFixed(3)})`;
  }
  probe.remove();
  return out;
}

const TICKS = [0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
function tickLabel(t: number, step: number) {
  if (step >= 1) { const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(0).padStart(2, '0')}`; }
  if (step >= 0.01) return `${t.toFixed(2)}s`;
  return `${Math.round(t * 1000)} ms`;
}

function hatch(g: CanvasRenderingContext2D, x0: number, x1: number, y0: number, y1: number, col: string) {
  g.save(); g.beginPath(); g.rect(x0, y0, x1 - x0, y1 - y0); g.clip();
  g.strokeStyle = col; g.lineWidth = 1; g.beginPath();
  for (let x = x0 - (y1 - y0) - ((x0 % 6) + 6) % 6; x < x1; x += 6) { g.moveTo(x, y1); g.lineTo(x + (y1 - y0), y0); }
  g.stroke(); g.restore();
}

export interface Paint {
  v: View; map: DispMap; peaks: Peaks; segs: Seg[]; C: Colors; fadeMs: number;
  sel: { a: number; b: number } | null; playhead: number; hoverX: number | null;
  flagClip: boolean; activeBoundary: number | null;
}

// Waveform columns of every segment between y0..y1 (mirrored L up / R down for stereo).
function wave(g: CanvasRenderingContext2D, p: Paint, y0: number, y1: number, compact = false) {
  const { v, map, peaks, C } = p; const sr = v.sr; const spp = v.spp;
  const mid = (y0 + y1) / 2, half = (y1 - y0) / 2 - 1;
  for (const s of map.segs) {
    if (s.d1 <= s.d0) continue;
    const xa = Math.max(GUT, Math.floor(xOf(v, s.d0))), xb = Math.min(v.W, Math.ceil(xOf(v, s.d1)));
    if (xb <= xa) continue;
    const col = s.removed ? C.waveRemoved : C.wave;
    if (spp >= 1 || compact) {
      g.fillStyle = col;
      for (let x = xa; x < xb; x++) {
        const t = s.t0 + (dAt(v, x) - s.d0); const s0 = t * sr, s1 = s0 + spp;
        if (s1 < s.t0 * sr || s0 > s.t1 * sr) continue;
        const a = Math.max(s0, s.t0 * sr), b = Math.min(s1, s.t1 * sr);
        if (compact) {
          let m = 0; for (let c = 0; c < peaks.ch.length; c++) { const [lo, hi] = peaks.range(c, a, b + 1); m = Math.max(m, hi, -lo); }
          g.globalAlpha = Math.min(1, 0.15 + m); g.fillRect(x, y0, 1, y1 - y0); continue;
        }
        if (peaks.stereo) {
          const [l0, l1] = peaks.range(0, a, b + 1), [r0, r1] = peaks.range(1, a, b + 1);
          const lu = Math.max(l1, -l0), rd = Math.max(r1, -r0);
          g.fillRect(x, mid - lu * half, 1, Math.max(1, lu * half));
          g.fillRect(x, mid, 1, Math.max(1, rd * half));
        } else {
          const [lo, hi] = peaks.range(0, a, b + 1);
          g.fillRect(x, mid - hi * half, 1, Math.max(1, (hi - lo) * half));
        }
      }
      g.globalAlpha = 1;
    } else {
      // < 1 sample per pixel: samples as dots at their true time, joined by dimmed lines
      const i0 = Math.max(Math.floor(s.t0 * sr), Math.floor((s.t0 + dAt(v, xa) - s.d0) * sr) - 1);
      const i1 = Math.min(Math.ceil(s.t1 * sr), Math.ceil((s.t0 + dAt(v, xb) - s.d0) * sr) + 1);
      for (let c = 0; c < peaks.ch.length; c++) {
        const cy = peaks.stereo ? (c === 0 ? mid - half / 2 : mid + half / 2) : mid;
        const ch = peaks.stereo ? half / 2 : half;
        const pts: [number, number][] = [];
        for (let i = i0; i <= i1; i++) pts.push([xOf(v, s.d0 + i / sr - s.t0), cy - peaks.sample(c, i) * ch]);
        g.globalAlpha = 0.3; g.strokeStyle = col; g.lineWidth = 1; g.beginPath();
        pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
        g.globalAlpha = 1; g.fillStyle = col;
        for (const [x, y] of pts) g.fillRect(x - 1.5, y - 1.5, 3, 3);
      }
    }
    if (s.removed && !compact) {
      g.fillStyle = C.wash; g.fillRect(xa, y0, xb - xa, y1 - y0);
      hatch(g, xa, xb, y0, y1, C.hatch);
    }
  }
}

// Edit lane: kept segments, removed hatch, cut marks, join wedges, handles, ordinals.
export function lane(g: CanvasRenderingContext2D, p: Paint, y0: number, h: number, handles: boolean) {
  const { v, map, C, segs } = p; const pps = 1 / secPerPx(v);
  g.fillStyle = C.surface; g.fillRect(GUT, y0, v.W - GUT, h);
  g.font = '10px var(--mono, ui-monospace, monospace)'; g.textBaseline = 'middle';
  for (const s of map.segs) {
    const xa = xOf(v, s.d0), xb = xOf(v, s.d1);
    if (xb < GUT || xa > v.W) continue;
    if (s.removed) {
      if (xb > xa) hatch(g, Math.max(GUT, xa), Math.min(v.W, xb), y0 + 3, y0 + h - 3, C.dim2);
      if (isJoin(segs, s.i)) {
        const w = Math.max(10, ((s.fadeMs ?? p.fadeMs) / 1000) * pps);
        g.fillStyle = C.keep; g.beginPath();
        if (xb - xa < 2) { // Edited view: one ⟩⟨ marker
          g.moveTo(xa - 6, y0 + 4); g.lineTo(xa, y0 + h / 2); g.lineTo(xa - 6, y0 + h - 4);
          g.moveTo(xa + 6, y0 + 4); g.lineTo(xa, y0 + h / 2); g.lineTo(xa + 6, y0 + h - 4);
          g.strokeStyle = C.keep; g.lineWidth = 1.5; g.stroke();
        } else {
          g.moveTo(xa - w, y0 + 4); g.lineTo(xa, y0 + 4); g.lineTo(xa, y0 + h - 4); g.closePath(); // fade-out wedge
          g.moveTo(xb + w, y0 + 4); g.lineTo(xb, y0 + 4); g.lineTo(xb, y0 + h - 4); g.closePath(); // fade-in wedge
          g.globalAlpha = 0.55; g.fill(); g.globalAlpha = 1;
        }
      }
    } else {
      g.fillStyle = C.keepSoft; g.fillRect(xa, y0 + 3, xb - xa, h - 6);
      g.fillStyle = C.keep; g.fillRect(xa, y0 + 3, xb - xa, 2);
    }
    if (xb - xa > 26) {
      g.fillStyle = s.removed ? C.dim2 : C.text;
      g.fillText(`#${s.i + 1}`, Math.max(GUT + 4, xa + 5), y0 + h / 2 + 1);
    }
  }
  // inserted silences (Seg.padMs): a neutral marker where the gap goes into the output
  for (const s of map.segs) {
    const ms = segs[s.i]?.padMs;
    if (s.removed || !ms) continue;
    const x = xOf(v, s.d0);
    if (x < GUT - 40 || x > v.W + 8) continue;
    g.strokeStyle = C.text; g.globalAlpha = 0.7; g.setLineDash([2, 2]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(x + 0.5, y0); g.lineTo(x + 0.5, y0 + h); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
    const label = `+${(ms / 1000).toFixed(ms % 100 ? 2 : 1)}s`;
    const w = g.measureText(label).width + 8;
    g.fillStyle = C.ink; g.fillRect(x + 2, y0 + h - 15, w, 12);
    g.fillStyle = C.text; g.fillText(label, x + 6, y0 + h - 9);
  }
  // boundaries: cut marks between two kept segments, handles on every boundary
  for (let i = 0; i < map.segs.length - 1; i++) {
    const x = xOf(v, map.segs[i].d1);
    if (x < GUT - 8 || x > v.W + 8) continue;
    const both = !map.segs[i].removed && !map.segs[i + 1].removed;
    if (both) {
      g.strokeStyle = C.cut; g.setLineDash([3, 3]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(x + 0.5, y0); g.lineTo(x + 0.5, y0 + h); g.stroke(); g.setLineDash([]);
      g.fillStyle = C.cut; g.fillText('✂', x + 3, y0 + 8);
    }
    if (handles) {
      const on = p.activeBoundary === i;
      g.fillStyle = C.keep; g.globalAlpha = on ? 1 : 0.85;
      g.fillRect(x - 4, y0 + (h - 22) / 2, 8, 22);
      g.fillStyle = C.ink; g.globalAlpha = 0.6;
      for (const dy of [-4, 0, 4]) g.fillRect(x - 2, y0 + h / 2 + dy, 4, 1);
      g.globalAlpha = 1;
    }
  }
}

function playheadLine(g: CanvasRenderingContext2D, p: Paint, y0: number, y1: number, caret: boolean) {
  const x = xOf(p.v, p.map.toDisp(p.playhead));
  if (x < GUT || x > p.v.W) return;
  g.fillStyle = p.C.playhead; g.shadowColor = p.C.playhead; g.shadowBlur = 6;
  g.fillRect(Math.round(x) - 1, y0, 2, y1 - y0); g.shadowBlur = 0;
  if (caret) { g.beginPath(); g.moveTo(x - 6, y0); g.lineTo(x + 6, y0); g.lineTo(x, y0 + 7); g.fill(); }
}

function selection(g: CanvasRenderingContext2D, p: Paint, y0: number, y1: number) {
  if (!p.sel) return;
  const xa = xOf(p.v, p.map.toDisp(Math.min(p.sel.a, p.sel.b))), xb = xOf(p.v, p.map.toDisp(Math.max(p.sel.a, p.sel.b)));
  const a = Math.max(GUT, xa), b = Math.min(p.v.W, xb);
  if (b <= a && Math.abs(xb - xa) > 0.5) return;
  g.fillStyle = p.C.selSoft; g.fillRect(a, y0, Math.max(1, b - a), y1 - y0);
  g.fillStyle = p.C.sel;
  if (xa >= GUT) g.fillRect(xa, y0, 1, y1 - y0);
  if (xb <= p.v.W) g.fillRect(xb - 1, y0, 1, y1 - y0);
}

export function drawStage(g: CanvasRenderingContext2D, p: Paint, H: number) {
  const { v, C } = p; const W = v.W; const wy0 = TICK, wy1 = H - LANE;
  g.fillStyle = C.ink; g.fillRect(0, 0, W, H);
  // ticks + faint major gridlines
  const span = spanOf(v);
  const step = TICKS.find(s => span / s <= 9) ?? 60;
  const minor = TICKS[Math.max(0, TICKS.indexOf(step) - 1)];
  g.font = '10px var(--mono, ui-monospace, monospace)'; g.textBaseline = 'middle';
  if (span / minor <= 260) {
    g.fillStyle = C.dim3;
    for (let t = Math.ceil(v.t0 / minor) * minor; t < v.t0 + span; t += minor) g.fillRect(Math.round(xOf(v, t)), TICK - 6, 1, 6);
  }
  for (let t = Math.ceil(v.t0 / step) * step; t < v.t0 + span; t += step) {
    const x = Math.round(xOf(v, t));
    g.fillStyle = C.surface3; g.fillRect(x, wy0, 1, wy1 - wy0);
    g.fillStyle = C.dim2; g.fillRect(x, TICK - 12, 1, 12);
    g.fillStyle = C.dim; g.fillText(tickLabel(Math.round(t / step) * step, step), x + 3, 8);
  }
  g.fillStyle = C.border2; g.fillRect(GUT, TICK - 0.5, W - GUT, 1);
  wave(g, p, wy0 + 4, wy1 - 4);
  // clipped samples inside kept audio
  if (p.flagClip && p.peaks.clipped.length) {
    g.fillStyle = C.clip;
    const lo = p.map.fromDisp(v.t0) * v.sr, hi = p.map.fromDisp(v.t0 + span) * v.sr;
    let lastX = -1;
    for (const i of p.peaks.clipped) {
      if (i < lo || i > hi) continue;
      const t = i / v.sr; const s = p.map.segs.find(q => t >= q.t0 && t < q.t1);
      if (!s || s.removed) continue;
      const x = Math.round(xOf(v, p.map.toDisp(t))); if (x === lastX) continue; lastX = x;
      g.fillRect(x, wy0 + 2, 1, 6); g.fillRect(x, wy1 - 8, 1, 6);
    }
  }
  selection(g, p, wy0, wy1);
  lane(g, p, H - LANE, LANE, true);
  if (p.hoverX != null && p.hoverX >= GUT) {
    g.fillStyle = C.hover; g.fillRect(Math.round(p.hoverX), TICK, 1, H - TICK);
  }
  playheadLine(g, p, TICK - 7, H, true);
  // dB gutter
  g.fillStyle = C.surface2; g.fillRect(0, 0, GUT, H);
  g.fillStyle = C.dim2; g.textAlign = 'right';
  const mid = (wy0 + wy1) / 2, half = (wy1 - wy0) / 2 - 5;
  if (p.peaks.stereo) { g.fillText('L', GUT - 6, wy0 + 10); g.fillText('R', GUT - 6, wy1 - 10); }
  for (const db of [-6, -12]) {
    const y = half * Math.pow(10, db / 20);
    g.fillText(`${db}`, GUT - 5, mid - y); g.fillText(`${db}`, GUT - 5, mid + y);
  }
  g.fillText('0', GUT - 5, mid - half); g.fillText('0', GUT - 5, mid + half);
  g.textAlign = 'left';
}

// Compact strip under the transport: AUD sliver/lane + EDIT lane, same view as the stage.
export function drawStrip(g: CanvasRenderingContext2D, p: Paint, audH: number) {
  const { v, C } = p;
  g.fillStyle = C.surface2; g.fillRect(0, 0, v.W, audH + LANE + 2);
  wave(g, p, 0, audH, true);
  lane(g, p, audH + 2, LANE, false);
  selection(g, p, 0, audH + 2 + LANE);
  playheadLine(g, p, 0, audH + 2 + LANE, false);
  g.fillStyle = C.surface2; g.fillRect(0, 0, GUT, audH + LANE + 2);
  g.fillStyle = C.dim2; g.font = '9px var(--mono, ui-monospace, monospace)'; g.textBaseline = 'middle';
  if (audH >= 12) g.fillText('AUD', 4, audH / 2);
  g.fillText('EDIT', 4, audH + 2 + LANE / 2);
}

// Overview: whole clip on the display axis, view box, playhead.
export function drawOverview(g: CanvasRenderingContext2D, p: Paint, W: number, H: number) {
  const { C, map } = p;
  const v: View = { t0: 0, spp: (Math.max(map.total, 1e-3) * p.v.sr) / (W - GUT), sr: p.v.sr, W };
  const q: Paint = { ...p, v };
  g.fillStyle = C.surface2; g.fillRect(0, 0, W, H);
  wave(g, q, 4, H - 4);
  // view box
  const span = spanOf(p.v);
  const bx0 = xOf(v, p.v.t0), bx1 = Math.max(bx0 + 6, xOf(v, p.v.t0 + span));
  g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(bx0, 1, bx1 - bx0, H - 2);
  g.strokeStyle = C.text; g.globalAlpha = 0.8; g.lineWidth = 1; g.strokeRect(bx0 + 0.5, 1.5, bx1 - bx0 - 1, H - 3); g.globalAlpha = 1;
  playheadLine(g, q, 0, H, false);
  g.fillStyle = C.surface2; g.fillRect(0, 0, GUT, H);
}
