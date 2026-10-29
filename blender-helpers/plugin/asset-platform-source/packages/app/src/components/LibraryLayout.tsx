import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IconCheck, IconLayout } from '../icons';
import type { Asset } from '../types';

// Library layout modes. The size slider sets column width (masonry, grids); Row is
// time-bucketed fixed-size cards and ignores it. The mode persists per viewer like the size.
export type LayoutMode = 'masonry' | 'fill' | 'fit' | 'row';

const LAYOUT_KEY = 'assetlib.layout';
const MODES: LayoutMode[] = ['masonry', 'fill', 'fit', 'row'];
const GAP = 6;

export function loadLayout(): LayoutMode {
  try {
    const v = localStorage.getItem(LAYOUT_KEY) as LayoutMode | null;
    if (v && MODES.includes(v)) return v;
  } catch {}
  return 'masonry';
}

export function saveLayout(m: LayoutMode) {
  try { localStorage.setItem(LAYOUT_KEY, m); } catch {}
}

/** Width/height ratio for a tile. Images use their pixel size; video without a size is 16:9;
 *  audio (waveform) is square. Clamped so a panorama or a sliver can't wreck a row/column. */
export function assetAspect(a: Asset): number {
  let meta: { width?: unknown; height?: unknown } = {};
  if (a.meta) {
    if (typeof a.meta === 'string') { try { meta = JSON.parse(a.meta); } catch {} }
    else meta = a.meta as typeof meta;
  }
  const w = Number(meta.width), h = Number(meta.height);
  const r = w > 0 && h > 0 ? w / h : a.category === 'video' ? 16 / 9 : 1;
  return Math.min(2.5, Math.max(0.4, r));
}

interface Box { asset: Asset; w: number; h: number }

/** Height of a card's meta band (name + meta line) for a tile width — the image never sits under
 *  it (the user, task). Narrow phone tiles keep only the name; Row cards carry their own text column. */
export function metaBand(w: number, layout: LayoutMode): number {
  if (layout === 'row') return 0;
  return w >= 120 ? 40 : w >= 95 ? 34 : 22;
}

function masonry(assets: Asset[], width: number, size: number): Box[][] {
  const n = Math.max(1, Math.floor((width + GAP) / (size + GAP)));
  const colW = (width - GAP * (n - 1)) / n; // unfloored so the last column meets the right edge
  const cols: Box[][] = Array.from({ length: n }, () => []);
  const heights = new Array(n).fill(0);
  // Greedy shortest-column placement is prefix-stable, so appending a page never moves
  // tiles that are already on screen (CSS columns would reflow everything).
  for (const asset of assets) {
    const i = heights.indexOf(Math.min(...heights));
    const h = Math.round(colW / assetAspect(asset)) + metaBand(colW, 'masonry');   // image at its own aspect + band
    cols[i].push({ asset, w: colW, h });
    heights[i] += h + GAP;
  }
  return cols;
}

// ── Row = one row per time segment (the user + Aurora,) ──────────────────────────────────────
// Buckets by the asset's own date (origin, else import), LOCAL time, week from Monday. Cards keep their
// incoming order inside a bucket; buckets appear in the order their first card does (so Oldest reads up).
export function assetDate(a: Asset): Date | null {
  const v = a.origin_created_at || a.created_at;
  if (!v) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : v.replace(' ', 'T') + 'Z');   // bare SQLite times are UTC
  return isNaN(d.getTime()) ? null : d;
}

const BUCKETS = ['Today', 'Yesterday', 'This week', 'Last week', 'Last month', 'Earlier'] as const;

function timeBuckets(assets: Asset[], now = new Date()): { label: string; assets: Asset[] }[] {
  const day = (n: number) => { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate()); d.setDate(d.getDate() - n); return d.getTime(); };
  const monday = (now.getDay() + 6) % 7;   // days since Monday
  const edges = [day(0), day(1), day(monday), day(monday + 7), day(31)];
  const out = new Map<string, Asset[]>();
  for (const a of assets) {
    const t = assetDate(a)?.getTime() ?? -Infinity;
    const i = edges.findIndex(e => t >= e);
    const label = BUCKETS[i < 0 ? 5 : i];
    (out.get(label) ?? out.set(label, []).get(label)!).push(a);
  }
  return [...out].map(([label, assets]) => ({ label, assets }));
}

const ROW_MIN = 260, ROW_MAX = 340, ROW_GAP = 8;

interface GridProps {
  assets: Asset[];
  layout: LayoutMode;
  size: number;
  render: (a: Asset, w: number, h: number) => React.ReactNode;
  empty?: React.ReactNode;
  phone?: boolean;   // Row: one full-width card per line
  'data-testid'?: string;
}

export function LayoutGrid({ assets, layout, size, render, empty, phone = false, ...rest }: GridProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => { if (ref.current) setWidth(ref.current.clientWidth - 20); }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(es => setWidth(Math.floor(es[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  let body: React.ReactNode;
  if (layout === 'masonry' && width > 0) {
    body = masonry(assets, width, size).map((col, i) => (
      <div key={i} className="thumb-col">{col.map(b => render(b.asset, b.w, b.h))}</div>
    ));
  } else if (layout === 'row') {
    // The CSS grid places the cards; w is the cell width the title's length budget is fitted to.
    const cols = phone ? 1 : Math.max(1, Math.floor((width + ROW_GAP) / (ROW_MIN + ROW_GAP)));
    const w = width > 0 ? Math.min(phone ? width : ROW_MAX, (width - ROW_GAP * (cols - 1)) / cols) : ROW_MIN;
    body = timeBuckets(assets).map(b => (
      <section key={b.label} className="row-bucket" data-testid={`bucket-${b.label.toLowerCase().replace(' ', '-')}`}>
        <div className="row-bucket-h">{b.label} <span className="row-bucket-n">{b.assets.length}</span></div>
        <div className="row-bucket-grid">{b.assets.map(a => render(a, w, phone ? 64 : 72))}</div>
      </section>
    ));
  } else {
    body = assets.map(a => render(a, size, size + metaBand(size, layout)));
  }
  // Neighbour light after every layout / lift change (the rim catch-light of cards near a lifted one).
  useLayoutEffect(() => {
    if (!ref.current) return;
    relight(ref.current);
    const el = ref.current, t = setTimeout(() => relight(el), 220);   // again once the 0.18s lift has settled
    return () => clearTimeout(t);
  });
  return (
    <div ref={ref} className={`thumb-grid layout-${layout}${phone ? ' row-phone' : ''}`} {...rest}>
      {body}
      {assets.length === 0 && empty}
    </div>
  );
}

// ── Neighbour light (Aurora, card-lift-layouts v1.1, task) ─────────────────────────────────────
// The lifted card is the only light source, thrown down-right. A neighbour catches it ONLY on the outer
// 1px of its 2px plate ring (the .lit layer sits under the face; screen blend) — the crisp catch-light
// of /styleguide/#cards, unchanged. Geometry (distance from the lifted card's edges) only decides which
// facing edge (left edge of a tile to the right, top edge of a tile below), where along it, and how bright.
const PLATE = (() => {   // hsl(220 9% 40%) → rgb
  const h = 220 / 360, S = 0.09, L = 0.4, q = L + S - L * S, p2 = 2 * L - q;
  const f = (t: number) => { t = (t + 1) % 1; return t < 1 / 6 ? p2 + (q - p2) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p2 + (q - p2) * (2 / 3 - t) * 6 : p2; };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map(v => Math.round(v * 255));
})();
const hexRgb = (v: string) => { const m = v.trim().match(/^#?([0-9a-f]{6})$/i); if (!m) return [128, 128, 128]; const n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const bloom = (rgb: string, k: number, rx: number, ry: number, x: number, y: number) =>
  `radial-gradient(${rx}px ${ry}px at ${x}px ${y}px,rgba(${rgb},${k}) 0%,rgba(${rgb},${(0.78 * k).toFixed(3)}) 22%,rgba(${rgb},${(0.3 * k).toFixed(3)}) 50%,rgba(${rgb},0) 72%)`;
export function relight(grid: HTMLElement) {
  const cards = [...grid.querySelectorAll<HTMLElement>('.card')];
  const g = grid.getBoundingClientRect();
  const P = cards.map(c => { const r = c.getBoundingClientRect(); return { x: r.left - g.left, y: r.top - g.top, w: r.width, h: r.height }; });
  const lit: string[][] = cards.map(() => []);
  cards.forEach((src, i) => {
    if (!src.classList.contains('up')) return;
    const L = P[i];
    const acc = hexRgb(getComputedStyle(src).getPropertyValue('--accent'));
    const rgb = PLATE.map((p, j) => Math.round(p * 0.2 + acc[j] * 0.8)).join(',');
    const R = Math.min(70, 0.45 * L.w), ax = L.x + 0.7 * L.w, ay = L.y + 0.7 * L.h;
    cards.forEach((n, j) => {
      if (j === i || n.classList.contains('up')) return;
      const N = P[j], gx = N.x - (L.x + L.w), gy = N.y - (L.y + L.h);
      if (gx >= 0 && gx <= R && N.y < L.y + L.h && N.y + N.h > L.y) {          // left edge faces the light
        const y = ay - N.y, cy = Math.max(0, Math.min(N.h, y)), off = Math.abs(y - cy);
        const k = Math.max(0, 1 - Math.max(0, gx - 16) / R) * Math.max(0, 1 - off / (0.62 * L.h));
        if (k > 0.02) lit[j].push(bloom(rgb, +k.toFixed(3), 0.52 * N.w, 0.62 * L.h, -0.08 * N.w, y));
      }
      if (gy >= 0 && gy <= R && N.x < L.x + L.w && N.x + N.w > L.x) {          // top edge faces the light
        const x = ax - N.x, cx = Math.max(0, Math.min(N.w, x)), off = Math.abs(x - cx);
        const k = Math.max(0, 1 - Math.max(0, gy - 16) / R) * Math.max(0, 1 - off / (0.62 * L.w));
        if (k > 0.02) lit[j].push(bloom(rgb, +k.toFixed(3), 0.62 * L.w, 0.52 * N.h, x, -0.08 * N.h));
      }
    });
  });
  cards.forEach((c, j) => { const el = c.querySelector<HTMLElement>('.lit'); if (el) el.style.background = lit[j].join(','); });
}

// Icons follow the mockup (task / image-12): 16px, currentColor.
const ICONS: Record<LayoutMode, React.ReactNode> = {
  masonry: <><rect x="1" y="1" width="6" height="14" rx="1" /><rect x="9" y="1" width="6" height="6" rx="1" /><rect x="9" y="9" width="6" height="6" rx="1" /></>,
  fill: <g fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1.75" y="1.75" width="5" height="5" rx="1" /><rect x="9.25" y="1.75" width="5" height="5" rx="1" /><rect x="1.75" y="9.25" width="5" height="5" rx="1" /><rect x="9.25" y="9.25" width="5" height="5" rx="1" /></g>,
  fit: <g fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1.5 5V2.5a1 1 0 0 1 1-1H5M11 1.5h2.5a1 1 0 0 1 1 1V5M14.5 11v2.5a1 1 0 0 1-1 1H11M5 14.5H2.5a1 1 0 0 1-1-1V11" /><circle cx="8" cy="8" r="2.5" /></g>,
  row: <g fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1.5 3.25h13" /><rect x="1.75" y="7.25" width="5" height="6" rx="1" /><rect x="9.25" y="7.25" width="5" height="6" rx="1" /></g>,
};
const LABELS: Record<LayoutMode, string> = { masonry: 'Masonry', fill: 'Fill in grid', fit: 'Fit in grid', row: 'Row' };

const Icon = ({ m }: { m: LayoutMode }) => <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>{ICONS[m]}</svg>;

export function LayoutMenu({ value, onChange }: { value: LayoutMode; onChange: (m: LayoutMode) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="layout-menu-wrap" ref={ref}>
      <button className={`ctrl-btn layout-btn${open ? ' active' : ''}`} onClick={() => setOpen(v => !v)}
        title={`Layout: ${LABELS[value]}`} aria-haspopup="menu" aria-expanded={open} data-testid="layout-btn">
        <IconLayout />
      </button>
      {open && (
        <div className="layout-menu" role="menu" data-testid="layout-menu">
          <div className="layout-menu-title">Layout</div>
          {MODES.map(m => (
            <button key={m} role="menuitemradio" aria-checked={m === value}
              className={`layout-item${m === value ? ' checked' : ''}`}
              onClick={() => { onChange(m); setOpen(false); }} data-testid={`layout-${m}`}>
              <Icon m={m} /><span>{LABELS[m]}</span>{m === value && <span className="layout-check"><IconCheck /></span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
