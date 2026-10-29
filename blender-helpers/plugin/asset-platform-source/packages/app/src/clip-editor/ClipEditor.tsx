// Clip Editor — P1 audio. Design: the design notes (AGREED PLAN, aurora mockup v2).
// Full-page takeover at /asset-management/library/?edit=<id>[&from=<childId>].
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Asset } from '../types';
import { IconBack } from '../icons';
import { Peaks, Player } from './audio';
import {
  type Draft, type Seg, freshDraft, split, removeRange, keepOnly, removeSegAt, restoreAt, moveBoundary,
  setFade, isJoin, keptRanges, editedDuration, segsFromRanges, fmtTime, segAt, insertSilence,
} from './model';
import {
  DispMap, type View, type Colors, GUT, LANE, readColors, drawStage, drawStrip, drawOverview,
  secPerPx, spanOf, xOf, dAt,
} from './draw';
import './clip-editor.css';

const LIB = '/asset-management/library';
const STAGE_H = 340, OVER_H = 56, K_MIN = -3, MAX_DUR = 15 * 60;
const FADES = [0, 5, 10, 20, 50];
type Sel = { a: number; b: number } | null;
type Drag =
  | { kind: 'press'; x0: number; t: number; shift: boolean }
  | { kind: 'select'; anchor: number }
  | { kind: 'trim'; i: number; orig: Seg[] }
  | { kind: 'pan'; x0: number; t0: number }
  | null;

function opOf(a: Asset | null) { return a && typeof a.derived_op === 'object' ? a.derived_op : null; }

// Hosted by ClipEditorApp (the full-page overlay, task): navigation goes through its callbacks —
// hrefs stay on links for middle-click / copy-link only.
export interface ClipEditorNav {
  onBack: () => void;
  onChangeClip: (opener: HTMLElement) => void;
  onEditAgain: (childId: string) => void;
  onOpenAsset: (id: string) => void;
  onLoaded: (a: Asset) => void;
  onSaved: () => void;
}
const plainClick = (e: React.MouseEvent) => !(e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);

export function ClipEditor({ assetId, fromId, nav }: { assetId: string; fromId: string | null; nav: ClipEditorNav }) {
  const [asset, setAsset] = useState<Asset | null>(null);
  const [status, setStatus] = useState('Loading…');
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [past, setPast] = useState<Seg[][]>([]);
  const [future, setFuture] = useState<Seg[][]>([]);
  const [sel, setSel] = useState<Sel>(null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState<false | 'play' | 'loop'>(false);
  const [edited, setEdited] = useState(false);
  const [skipRemoved, setSkipRemoved] = useState(true);
  const [scrub, setScrub] = useState(true);
  const [view, setView] = useState<{ t0: number; k: number }>({ t0: 0, k: 10 });
  const [W, setW] = useState(() => Math.max(320, window.innerWidth - 370));
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [activeB, setActiveB] = useState<number | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error' | ''>('');
  const [savedAt, setSavedAt] = useState(0);
  const [, tick] = useState(0);   // re-renders "Draft saved · Ns ago"
  useEffect(() => { const t = setInterval(() => tick(n => n + 1), 5000); return () => clearInterval(t); }, []);
  const [created, setCreated] = useState<Asset[]>([]);
  const [derivedFrom, setDerivedFrom] = useState<Asset | null>(null);
  const [creating, setCreating] = useState(false);
  const [clipName, setClipName] = useState('');
  const [toast, setToast] = useState<{ msg: string; id?: string; err?: boolean } | null>(null);

  const stageRef = useRef<HTMLCanvasElement>(null);
  const stripRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const colors = useRef<Colors | null>(null);
  const player = useRef<Player | null>(null);
  const drag = useRef<Drag>(null);
  const pointerX = useRef<number | null>(null);
  const loaded = useRef(false);
  const lastSaved = useRef('');
  const spaceHeld = useRef(false);
  const panned = useRef(false); // a Space press that panned is not play/pause

  const dur = peaks ? Math.min(peaks.duration, asset?.duration_s ?? Infinity) : 0;
  const segs = draft?.segs ?? [];
  const map = useMemo(() => new DispMap(segs, edited), [segs, edited]);
  const sr = peaks?.sr ?? 48000;
  const v: View = { t0: view.t0, spp: Math.pow(2, view.k), sr, W };
  // fit = the exact rung that shows the whole clip; every other rung is a power of two
  const fitK = peaks ? Math.max(K_MIN, Math.log2(Math.max(1, map.total * sr) / Math.max(1, W - GUT))) : 10;
  const zoomIn = (k: number) => Math.ceil(k - 1e-9) - 1, zoomOut = (k: number) => Math.floor(k + 1e-9) + 1;
  const snap = useCallback((t: number) => (draft?.zc && peaks ? peaks.zeroCross(t) : t), [draft?.zc, peaks]);

  // ── load: asset row → decode → draft (or a created child's segments) ──────
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const a: Asset = await fetch(`${LIB}/api/assets/${encodeURIComponent(assetId)}`).then(r => { if (!r.ok) throw new Error('asset not found'); return r.json(); });
        if (dead) return;
        setAsset(a);
        nav.onLoaded(a);
        if (a.category !== 'audio') { setStatus('The Clip Editor edits audio today — video editing arrives in phase 2.'); return; }
        if ((a.duration_s ?? 0) > MAX_DUR) { setStatus('Long media (over 15 min) arrives with phase 2.'); return; }
        setStatus('Decoding audio…');
        const bytes = await fetch(`${LIB}/api/assets/${a.id}/file`).then(r => r.arrayBuffer());
        const ctx = new AudioContext(a.sample_rate ? { sampleRate: a.sample_rate } : undefined);
        const buf = await ctx.decodeAudioData(bytes);
        if (dead) return;
        const pk = new Peaks(buf);
        player.current = new Player(ctx, buf);
        player.current.onEnded = () => setPlaying(false);
        const d = Math.min(pk.duration, a.duration_s ?? Infinity);
        const saved = await fetch(`${LIB}/api/assets/${a.id}/edit-draft`).then(r => r.json()).catch(() => null);
        let dr: Draft = saved?.draft?.v === 1 && Math.abs(saved.draft.segs.at(-1).t1 - d) < 0.002 ? saved.draft : freshDraft(d);
        if (fromId) {
          const child: Asset | null = await fetch(`${LIB}/api/assets/${encodeURIComponent(fromId)}`).then(r => (r.ok ? r.json() : null));
          const p = opOf(child)?.params as { segments?: [number, number][]; fades?: number[]; pads?: number[] } | undefined;
          if (child && p?.segments) {
            setPast([dr.segs]);
            dr = { ...dr, segs: segsFromRanges(p.segments, p.fades ?? [], d, p.pads ?? []) };
            setDerivedFrom(child);
          }
        }
        // a loaded child's segments ARE a change worth saving; an untouched draft is not
        lastSaved.current = fromId ? '' : JSON.stringify(dr);
        loaded.current = true;
        setPeaks(pk); setDraft(dr); setStatus('');
      } catch (e) { if (!dead) setStatus(`Could not open: ${(e as Error).message}`); }
    })();
    return () => { dead = true; player.current?.stop(); };
  }, [assetId, fromId]);

  const loadCreated = useCallback(() => {
    fetch(`${LIB}/api/assets/${encodeURIComponent(assetId)}/lineage`).then(r => r.json()).then(j => {
      setCreated((j.descendants as Asset[] ?? []).filter(d => d.parent_id === assetId && opOf(d)?.tool === 'clip-editor' && !d.trashed_at));
    }).catch(() => {});
  }, [assetId]);
  useEffect(loadCreated, [loadCreated]);

  // ── autosave (debounced, append-only server side) ──────────────────────────
  useEffect(() => {
    if (!draft || !loaded.current) return;
    const body = JSON.stringify(draft);
    if (body === lastSaved.current) return;
    setSaveState('saving');
    const h = setTimeout(() => {
      fetch(`${LIB}/api/assets/${assetId}/edit-draft`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft }) })
        .then(r => { setSaveState(r.ok ? 'saved' : 'error'); if (r.ok) { lastSaved.current = body; setSavedAt(Date.now()); nav.onSaved(); } }).catch(() => setSaveState('error'));
    }, 1000);
    return () => clearTimeout(h);
  }, [draft, assetId]);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (saveState === 'saving' || creating) e.preventDefault(); };
    window.addEventListener('beforeunload', h); return () => window.removeEventListener('beforeunload', h);
  }, [saveState, creating]);

  // ── edits (every change is undoable) ───────────────────────────────────────
  const apply = useCallback((next: Seg[]) => {
    if (!draft || next === draft.segs) return;
    setPast(p => [...p.slice(-199), draft.segs]); setFuture([]);
    setDraft({ ...draft, segs: next });
  }, [draft]);
  const undo = useCallback(() => {
    if (!draft || !past.length) return;
    setFuture(f => [draft.segs, ...f]); setDraft({ ...draft, segs: past[past.length - 1] }); setPast(p => p.slice(0, -1));
  }, [draft, past]);
  const redo = useCallback(() => {
    if (!draft || !future.length) return;
    setPast(p => [...p, draft.segs]); setDraft({ ...draft, segs: future[0] }); setFuture(f => f.slice(1));
  }, [draft, future]);

  const doRemove = useCallback(() => {
    if (sel) { apply(removeRange(segs, snap(sel.a), snap(sel.b))); setSel(null); }
    else apply(removeSegAt(segs, playhead));
  }, [sel, segs, snap, playhead, apply]);
  const doSplit = useCallback(() => apply(split(segs, snap(playhead))), [segs, snap, playhead, apply]);
  // Insert silence at the playhead (a fast talker needs a pause at the start/end).
  const [silenceMs, setSilenceMs] = useState(300);
  const doSilence = useCallback(() => apply(insertSilence(segs, snap(playhead), silenceMs)), [segs, snap, playhead, silenceMs, apply]);
  const doKeepOnly = useCallback(() => { if (sel) { apply(keepOnly(segs, snap(sel.a), snap(sel.b))); setSel(null); } }, [sel, segs, snap, apply]);
  const doRestore = useCallback(() => apply(restoreAt(segs, playhead)), [segs, playhead, apply]);
  const doReset = useCallback(() => { apply([{ t0: 0, t1: dur, removed: false }]); setSel(null); setDerivedFrom(null); }, [dur, apply]);

  // ── view: zoom ladder, pan, follow ─────────────────────────────────────────
  const clampT0 = useCallback((t0: number, k: number) => {
    const span = (W - GUT) * Math.pow(2, k) / sr;
    return Math.max(0, Math.min(t0, map.total - span));
  }, [W, sr, map.total]);
  useEffect(() => { if (peaks) setView({ t0: 0, k: fitK }); /* open fitted */ }, [peaks]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setView(vw => ({ k: Math.min(vw.k, fitK), t0: clampT0(vw.t0, Math.min(vw.k, fitK)) })); }, [fitK, clampT0]);

  const zoomTo = useCallback((k: number) => {
    setView(vw => {
      k = Math.max(K_MIN, Math.min(fitK, k));
      if (k === vw.k) return vw;
      const span = (W - GUT) * Math.pow(2, vw.k) / sr, nspan = (W - GUT) * Math.pow(2, k) / sr;
      const pd = map.toDisp(playhead);
      const anchor = pd >= vw.t0 && pd <= vw.t0 + span ? pd : vw.t0 + span / 2;
      const frac = (anchor - vw.t0) / span;
      return { k, t0: clampT0(anchor - frac * nspan, k) };
    });
  }, [fitK, W, sr, map, playhead, clampT0]);
  const panBy = useCallback((dt: number) => setView(vw => ({ ...vw, t0: clampT0(vw.t0 + dt, vw.k) })), [clampT0]);

  // ── playback ───────────────────────────────────────────────────────────────
  const playRanges = useCallback((from: number): { ranges: [number, number][]; fades: number[]; pads: number[] } => {
    if (!draft) return { ranges: [], fades: [], pads: [] };
    if (!skipRemoved) return { ranges: [[from, dur]], fades: [], pads: [] };
    const kr = keptRanges(segs, draft.defaultFadeMs);
    const ranges: [number, number][] = []; const fades: number[] = []; const pads: number[] = [];
    kr.ranges.forEach(([a, b], i) => {
      if (b <= from + 0.001) return;
      if (ranges.length) fades.push(Math.min(kr.fades[i - 1] / 1000, (b - a) / 2, (ranges[ranges.length - 1][1] - ranges[ranges.length - 1][0]) / 2));
      pads.push(a >= from - 0.001 ? kr.pads[i] / 1000 : 0);   // a silence plays when we start at or before it
      ranges.push([Math.max(a, from), b]);
    });
    return { ranges, fades, pads };
  }, [draft, segs, skipRemoved, dur]);

  const stop = useCallback(() => { player.current?.stop(); setPlaying(false); }, []);
  const play = useCallback((from = playhead) => {
    const p = player.current; if (!p) return;
    const { ranges, fades, pads } = playRanges(from >= dur - 0.01 ? 0 : from);
    if (!ranges.length) return;
    p.play(ranges, fades, pads); setPlaying('play');
  }, [playhead, playRanges, dur]);
  const togglePlay = useCallback(() => (playing ? stop() : play()), [playing, stop, play]);
  const loopSel = useCallback((on: boolean) => {
    const p = player.current; if (!p) return;
    if (!on || !sel || Math.abs(sel.b - sel.a) < 0.02) { if (playing === 'loop') stop(); return; }
    p.playLoop(Math.min(sel.a, sel.b), Math.max(sel.a, sel.b)); setPlaying('loop');
  }, [sel, playing, stop]);

  const seek = useCallback((t: number, audible = true) => {
    t = Math.max(0, Math.min(dur, t));
    setPlayhead(t);
    if (playing === 'play') play(t);
    else if (audible && scrub) player.current?.slice(t);
  }, [dur, playing, play, scrub]);

  // playhead follows the audio; page-style follow (hold until 85 %, land at 25 %)
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const t = player.current?.now();
      if (t != null) {
        setPlayhead(t);
        if (!drag.current) setView(vw => {
          const span = (W - GUT) * Math.pow(2, vw.k) / sr, d = map.toDisp(t);
          return d > vw.t0 + span * 0.85 || d < vw.t0 ? { ...vw, t0: clampT0(d - span * 0.25, vw.k) } : vw;
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, W, sr, map, clampT0]);

  // ── painting ───────────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(320, Math.floor(el.clientWidth))));
    ro.observe(el); return () => ro.disconnect();
  }, [peaks]);

  useEffect(() => {
    if (!peaks || !draft) return;
    if (!colors.current && wrapRef.current) colors.current = readColors(wrapRef.current);
    const C = colors.current!; const dpr = window.devicePixelRatio || 1;
    const paint = { v, map, peaks, segs, C, fadeMs: draft.defaultFadeMs, sel, playhead, hoverX, flagClip: draft.flagClip, activeBoundary: activeB };
    const prep = (c: HTMLCanvasElement | null, w: number, h: number) => {
      if (!c) return null;
      if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; c.style.width = `${w}px`; c.style.height = `${h}px`; }
      const g = c.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0); return g;
    };
    const gs = prep(stageRef.current, W, STAGE_H); if (gs) drawStage(gs, paint, STAGE_H);
    const gt = prep(stripRef.current, W, 8 + LANE + 2); if (gt) drawStrip(gt, paint, 8);
    const go = prep(overRef.current, W, OVER_H); if (go) drawOverview(go, paint, W, OVER_H);
  });

  // ── pointer: stage ─────────────────────────────────────────────────────────
  const tAt = useCallback((x: number) => map.fromDisp(Math.max(0, Math.min(map.total, dAt(v, x)))), [map, v]);
  const boundaryAt = useCallback((x: number) => {
    let best = -1, bd = 11;
    for (let i = 0; i < map.segs.length - 1; i++) { const d = Math.abs(xOf(v, map.segs[i].d1) - x); if (d < bd) { bd = d; best = i; } }
    return best;
  }, [map, v]);

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!draft) return;
    const r = e.currentTarget.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
    e.currentTarget.setPointerCapture(e.pointerId); pointerX.current = x;
    if (e.button === 1 || spaceHeld.current) { panned.current = true; drag.current = { kind: 'pan', x0: x, t0: view.t0 }; return; }
    if (x < GUT) return;
    const b = y > STAGE_H - LANE - 4 ? boundaryAt(x) : -1;
    if (b >= 0) { drag.current = { kind: 'trim', i: b, orig: segs }; setActiveB(b); if (playing) stop(); return; }
    drag.current = { kind: 'press', x0: x, t: tAt(x), shift: e.shiftKey };
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect(); const x = e.clientX - r.left;
    setHoverX(x); pointerX.current = x;
    const d = drag.current; if (!d || !draft) return;
    if (d.kind === 'pan') { setView(vw => ({ ...vw, t0: clampT0(d.t0 - (x - d.x0) * secPerPx(v), vw.k) })); return; }
    if (d.kind === 'trim') {
      const t = snap(tAt(x)); setDraft({ ...draft, segs: moveBoundary(d.orig, d.i, t) });
      setPlayhead(t); if (scrub) player.current?.slice(t, 0.05); return;
    }
    if (d.kind === 'press' && Math.abs(x - d.x0) > 3) {
      const anchor = d.shift && sel ? (Math.abs(sel.a - d.t) > Math.abs(sel.b - d.t) ? sel.a : sel.b) : d.t;
      drag.current = { kind: 'select', anchor };
    }
    if (drag.current?.kind === 'select') setSel({ a: drag.current.anchor, b: tAt(x) });
  };
  const onUp = () => {
    const d = drag.current; drag.current = null; setActiveB(null);
    if (!d || !draft) return;
    if (d.kind === 'trim') {
      if (d.orig !== draft.segs) { setPast(p => [...p, d.orig]); setFuture([]); }
    } else if (d.kind === 'press') {
      if (d.shift && sel) {
        const far = Math.abs(sel.a - d.t) > Math.abs(sel.b - d.t) ? sel.a : sel.b;
        setSel({ a: far, b: d.t });
      } else { setSel(null); seek(d.t); }
    } else if (d.kind === 'select' && sel) {
      if (Math.abs(sel.b - sel.a) * sr < 1) setSel(null);
      else { const a = Math.min(sel.a, sel.b), b = Math.max(sel.a, sel.b); setSel({ a, b }); setPlayhead(a); }
    }
  };

  // edge auto-pan while selecting or trimming (driven by pointer POSITION, not the seek)
  useEffect(() => {
    let last = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now(); const dt = Math.min(0.12, (now - last) / 1000); last = now;
      const d = drag.current, x = pointerX.current;
      if (!d || (d.kind !== 'select' && d.kind !== 'trim') || x == null) return;
      const depth = x < GUT + 46 ? GUT + 46 - x : x > W - 46 ? -(x - (W - 46)) : 0;
      if (!depth) return;
      const f = Math.min(2, Math.abs(depth) / 46);
      const rate = (0.12 + (1.9 - 0.12) * Math.min(1, f * f)) * spanOf(v) / 5;
      panBy(-Math.sign(depth) * rate * dt);
    }, 33);
    return () => clearInterval(id);
  }, [W, v, panBy]);

  // wheel: ctrl/pinch zooms one rung per notch; shift / horizontal pans; plain wheel scrolls the page
  const notch = useRef({ acc: 0, t: 0 });
  useEffect(() => {
    const c = stageRef.current; if (!c) return;
    const h = (e: WheelEvent) => {
      const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      if (e.ctrlKey) {
        e.preventDefault();
        const n = notch.current, now = performance.now(), dy = e.deltaY * k;
        if (now - n.t > 250 || Math.sign(dy) !== Math.sign(n.acc)) n.acc = 0;
        n.t = now; n.acc += dy;
        if (Math.abs(n.acc) >= 50) { zoomTo(n.acc > 0 ? zoomOut(view.k) : zoomIn(view.k)); n.acc = 0; }
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        panBy(((e.shiftKey ? e.deltaY : e.deltaX) || e.deltaY) * k * secPerPx(v));
      }
    };
    c.addEventListener('wheel', h, { passive: false });
    return () => c.removeEventListener('wheel', h);
  }, [zoomTo, panBy, view.k, v]);

  // ── pointer: overview (drag the box, click to centre, wheel pages) ─────────
  const overDrag = useRef<{ x0: number; t0: number } | null>(null);
  const overT = (x: number) => ((x - GUT) / (W - GUT)) * map.total;
  const onOverDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect(); const x = e.clientX - r.left; const t = overT(x);
    e.currentTarget.setPointerCapture(e.pointerId);
    const span = spanOf(v);
    if (t < view.t0 || t > view.t0 + span) setView(vw => ({ ...vw, t0: clampT0(t - span / 2, vw.k) }));
    overDrag.current = { x0: x, t0: t < view.t0 || t > view.t0 + span ? clampT0(t - span / 2, view.k) : view.t0 };
  };
  const onOverMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const o = overDrag.current; if (!o) return;
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    setView(vw => ({ ...vw, t0: clampT0(o.t0 + ((x - o.x0) / (W - GUT)) * map.total, vw.k) }));
  };
  useEffect(() => {
    const c = overRef.current; if (!c) return;
    const h = (e: WheelEvent) => { e.preventDefault(); panBy(Math.sign(e.deltaY || e.deltaX) * spanOf(v) * 0.9); };
    c.addEventListener('wheel', h, { passive: false });
    return () => c.removeEventListener('wheel', h);
  }, [panBy, v]);

  // ── keyboard (ignored in inputs; every key has a button mirror) ────────────
  const createClip = useCallback(async () => {
    if (!draft || creating) return;
    const { ranges, fades, pads } = keptRanges(segs, draft.defaultFadeMs);
    if (!ranges.length) { setToast({ msg: 'Nothing kept — restore something first.', err: true }); return; }
    setCreating(true);
    try {
      const r = await fetch(`${LIB}/api/assets/${assetId}/clip`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segments: ranges, fades, pads, label: clipName.trim() || `edit ${created.length + 1}` }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      setToast({ msg: 'Clip created', id: j.asset.id }); loadCreated();
    } catch (e) { setToast({ msg: `Create clip failed: ${(e as Error).message}`, err: true }); }
    finally { setCreating(false); }
  }, [draft, creating, segs, assetId, clipName, created.length, loadCreated]);

  const editPoints = useMemo(() => [0, ...segs.map(s => s.t1)], [segs]);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const tg = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tg.tagName) || !draft) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.code === 'Space') {
        if (tg.tagName === 'BUTTON') return;
        e.preventDefault();
        if (!e.repeat) { spaceHeld.current = true; panned.current = false; }
        return;
      }
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); (e.shiftKey ? redo : undo)(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (mod && e.key === 'Enter') { e.preventDefault(); createClip(); return; }
      if (e.key.startsWith('Arrow') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        const step = e.altKey ? 1 / sr : mod ? 0.01 : e.shiftKey ? 10 : 1;
        seek(playhead + (e.key === 'ArrowLeft' ? -step : step)); return;
      }
      if (mod) return;
      switch (e.key) {
        case 'Home': e.preventDefault(); seek(0, false); setView(vw => ({ ...vw, t0: 0 })); break;
        case 'End': e.preventDefault(); seek(dur, false); break;
        case 'Delete': case 'Backspace': e.preventDefault(); doRemove(); break;
        case 's': case 'S': doSplit(); break;
        case 'i': case 'I': doSilence(); break;
        case 'k': case 'K': doKeepOnly(); break;
        case 'r': case 'R': doRestore(); break;
        case 'l': case 'L': if (!e.repeat) loopSel(true); break;
        case 'e': case 'E': setEdited(x => !x); break;
        case '[': setSel({ a: playhead, b: sel ? Math.max(sel.a, sel.b) : dur }); break;
        case ']': setSel({ a: sel ? Math.min(sel.a, sel.b) : 0, b: playhead }); break;
        case '+': case '=': zoomTo(zoomIn(view.k)); break;
        case '-': case '_': zoomTo(zoomOut(view.k)); break;
        case '0': zoomTo(fitK); break;
        case 'Escape': setSel(null); drag.current = null; break;
        case 'Tab': {
          e.preventDefault();
          const pts = editPoints;
          const t = e.shiftKey ? [...pts].reverse().find(p => p < playhead - 1e-4) : pts.find(p => p > playhead + 1e-4);
          if (t != null) seek(t, false);
          break;
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      const tg = e.target as HTMLElement;
      if (e.code === 'Space' && !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(tg.tagName)) {
        e.preventDefault();
        // a Space press that did not pan is play/pause
        if (spaceHeld.current && !panned.current) togglePlay();
        spaceHeld.current = false; panned.current = false;
      }
      if ((e.key === 'l' || e.key === 'L') && playing === 'loop') stop();
    };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  });

  // ── render ─────────────────────────────────────────────────────────────────
  const name = asset ? (asset.label || asset.filename || asset.id.slice(0, 8)) : '';
  const backBtn = <button className="ce-back" onClick={nav.onBack} data-testid="ce-back" aria-label="Back to the Library"><IconBack /><span className="ce-back-lbl">Library</span></button>;
  const title = <span className="ce-name" title={name}>Clip Editor{name && <span className="ce-name-src"> · {name}</span>}</span>;
  const change = <button className="ce-btn" onClick={e => nav.onChangeClip(e.currentTarget)} data-testid="ce-change"><span className="ce-long">Change clip…</span><span className="ce-short">Change…</span></button>;
  const ago = savedAt ? Math.max(0, Math.round((Date.now() - savedAt) / 1000)) : 0;
  if (status || !peaks || !draft) {
    return (
      <div className="ce-root">
        <header className="ce-head">{backBtn}{title}<span className="ce-spacer" />{change}</header>
        <div className="ce-status" data-testid="ce-status">{status || 'Loading…'}</div>
      </div>
    );
  }
  const nKept = segs.filter(s => !s.removed).length;
  const editedDur = editedDuration(segs, draft.defaultFadeMs);
  const selLen = sel ? Math.abs(sel.b - sel.a) : 0;
  const rung = view.k >= fitK - 1e-9 ? 'fit' : view.k >= 0 ? `${Math.pow(2, view.k)} spp` : `${Math.pow(2, -view.k)} px/smp`;
  const setD = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const underPlayhead = segs[segAt(segs, playhead)];

  return (
    <div className="ce-root" data-testid="clip-editor">
      <header className="ce-head">
        {backBtn}
        {title}
        <span className="ce-chip">audio · {(sr / 1000).toFixed(sr % 1000 ? 1 : 0)} kHz · {peaks.stereo ? 'stereo' : 'mono'}</span>
        <span className={`ce-save ${saveState}`} data-testid="ce-save">{saveState === 'saving' ? 'saving…' : saveState === 'error' ? '● draft not saved'
          : saveState === 'saved' ? <><span className="ce-dot" /><span className="ce-long">Draft saved · {ago < 5 ? 'just now' : ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)} min ago`}</span><span className="ce-short">Saved</span></> : ''}</span>
        {created.length > 0 && <span className="ce-chip dashed">{created.length} clip{created.length > 1 ? 's' : ''} made from this source</span>}
        {derivedFrom && <span className="ce-chip">derived from {derivedFrom.label || derivedFrom.id.slice(0, 8)}</span>}
        <span className="ce-spacer" />
        <span className="ce-durs" data-testid="ce-durs">{fmtTime(dur)} → {fmtTime(editedDur)} · {nKept} segment{nKept === 1 ? '' : 's'}</span>
        <button className="ce-btn" onClick={undo} disabled={!past.length} title="Undo (Ctrl+Z)">Undo</button>
        <button className="ce-btn" onClick={redo} disabled={!future.length} title="Redo (Ctrl+Shift+Z)">Redo</button>
        <button className="ce-btn" onClick={doReset} disabled={segs.length === 1 && !segs[0].removed} title="Return to the full source (undoable)">Reset edits</button>
        {change}
        <button className="ce-btn primary" onClick={createClip} disabled={creating || !nKept} data-testid="ce-create" title="Create clip (Ctrl+Enter)">{creating ? 'Creating…' : 'Create clip'}</button>
      </header>

      <div className="ce-body">
        <div className="ce-main" ref={wrapRef}>
          <div className="ce-stage">
            <div className="ce-tabs">
              <button className="ce-tab" disabled title="video only">View</button>
              <button className="ce-tab on">Audio</button>
              <span className="ce-spacer" />
              <span className="ce-chip">{peaks.stereo ? 'L/R mirrored' : 'mono'}</span>
              <button className={`ce-chip toggle${draft.zc ? ' on' : ''}`} onClick={() => setD({ zc: !draft.zc })}>snap: zero-crossing</button>
              <span className="ce-chip mono">peak {Number.isFinite(peaks.peakDb()) ? peaks.peakDb().toFixed(1) : '−∞'} dB</span>
            </div>
            <canvas ref={stageRef} className="ce-canvas" data-testid="ce-stage"
              onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
              onPointerLeave={() => setHoverX(null)}
              style={{ cursor: spaceHeld.current ? 'grab' : hoverX != null && boundaryAt(hoverX) >= 0 ? 'ew-resize' : 'text' }} />
          </div>

          <div className="ce-transport">
            <button className="ce-btn icon" onClick={() => { seek(0, false); setView(vw => ({ ...vw, t0: 0 })); }} title="Start (Home)">⇤</button>
            <button className="ce-btn icon" onClick={() => seek(playhead - 1 / sr * Math.max(1, Math.pow(2, view.k)))} title="Step back">‹</button>
            <button className="ce-btn icon play" onClick={togglePlay} data-testid="ce-play" title="Play/pause (Space)">{playing === 'play' ? '❚❚' : '▶'}</button>
            <button className="ce-btn icon" onClick={() => seek(playhead + 1 / sr * Math.max(1, Math.pow(2, view.k)))} title="Step forward">›</button>
            <span className="ce-time" data-testid="ce-time">{fmtTime(playhead)} <span className="dim">/ {fmtTime(dur)}</span></span>
            <span className="ce-seg2">
              <button className={!edited ? 'on' : ''} onClick={() => setEdited(false)} title="Source view (E)">Source</button>
              <button className={edited ? 'on' : ''} onClick={() => setEdited(true)} title="Edited view (E)">Edited</button>
            </span>
            <button className={`ce-btn toggle${skipRemoved ? ' on' : ''}`} onClick={() => setSkipRemoved(x => !x)} title="Playback jumps removed ranges">skip removed</button>
            <button className={`ce-btn toggle${scrub ? ' on' : ''}`} onClick={() => setScrub(x => !x)} title="Hear a short slice when you seek or drag">scrub</button>
            <button className={`ce-btn toggle${playing === 'loop' ? ' on' : ''}`} onClick={() => loopSel(playing !== 'loop')} disabled={!sel} title="Loop the selection (hold L)">loop sel</button>
            <span className="ce-spacer" />
            <button className="ce-btn icon" onClick={() => zoomTo(zoomOut(view.k))} disabled={view.k >= fitK - 1e-9} title="Zoom out (−)">−</button>
            <span className="ce-rung"><span>{spanOf(v).toFixed(spanOf(v) < 1 ? 3 : 2)}s view</span> <span>{rung}</span></span>
            <button className="ce-btn icon" onClick={() => zoomTo(zoomIn(view.k))} disabled={view.k <= K_MIN} title="Zoom in (+)">+</button>
            <button className="ce-btn" onClick={() => zoomTo(fitK)} title="Fit (0)">fit</button>
          </div>

          <canvas ref={stripRef} className="ce-canvas strip" onPointerDown={e => { const x = e.clientX - e.currentTarget.getBoundingClientRect().left; if (x >= GUT) { setSel(null); seek(tAt(x)); } }} />
          <canvas ref={overRef} className="ce-canvas over" data-testid="ce-overview"
            onPointerDown={onOverDown} onPointerMove={onOverMove} onPointerUp={() => { overDrag.current = null; }} />
          <div className="ce-hint">
            drag = select · click = seek · ⇧click extend · Del remove · S split · I insert silence · K keep only · R restore · L loop · Space play · ctrl+wheel / pinch zoom · ⇧wheel pan · Tab next edit point · E source/edited
          </div>
        </div>

        <aside className="ce-side">
          <section className="ce-box" data-testid="ce-selection">
            <h3>Selection <span className="dim">drag on the waveform</span></h3>
            {sel ? (
              <dl className="ce-kv">
                <dt>in</dt><dd className="sel">{Math.min(sel.a, sel.b).toFixed(4)} s</dd>
                <dt>out</dt><dd className="sel">{Math.max(sel.a, sel.b).toFixed(4)} s</dd>
                <dt>length</dt><dd>{selLen.toFixed(3)} s · {Math.round(selLen * sr).toLocaleString()} smp</dd>
              </dl>
            ) : <p className="dim small">No selection — Remove acts on segment #{segAt(segs, playhead) + 1} under the playhead{underPlayhead?.removed ? ' (already removed)' : ''}.</p>}
            <div className="ce-verbs">
              <button className="ce-btn strong" onClick={doRemove} data-testid="ce-remove">Remove <kbd>Del</kbd></button>
              <button className="ce-btn strong" onClick={doSplit}>Split <kbd>S</kbd></button>
              <span className="ce-silence">
                <button className="ce-btn strong" onClick={doSilence} title="Insert silence at the playhead" data-testid="ce-silence">Insert silence <kbd>I</kbd></button>
                <select className="ce-input" value={silenceMs} onChange={e => setSilenceMs(Number(e.target.value))} aria-label="Silence length">
                  {[100, 200, 300, 500, 750, 1000, 1500, 2000].map(ms => <option key={ms} value={ms}>{ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`}</option>)}
                </select>
              </span>
              <button className="ce-btn strong" onClick={doKeepOnly} disabled={!sel}>Keep only <kbd>K</kbd></button>
              <button className="ce-btn strong" onClick={doRestore} disabled={!underPlayhead?.removed}>Restore <kbd>R</kbd></button>
            </div>
          </section>

          <section className="ce-box">
            <h3>Segments <span className="dim">{nKept} kept · {segs.length - nKept} removed</span></h3>
            <div className="ce-segs" data-testid="ce-segs">
              {segs.map((s, i) => (
                <div key={`${s.t0}-${i}`}>
                  {!s.removed && s.padMs ? (
                    <div className="ce-joinrow silence" data-testid="ce-silence-row">
                      <span className="n">␣</span><span>{(s.padMs / 1000).toFixed(2)} s silence</span>
                      <button className="ce-mini" title="Remove this silence" onClick={() => apply(insertSilence(segs, s.t0, 0))}>−</button>
                    </div>
                  ) : null}
                  <div className={`ce-segrow${s.removed ? ' removed' : ''}${playhead >= s.t0 && playhead < s.t1 ? ' here' : ''}`}
                    onClick={() => { setSel(null); seek(s.t0, false); }}>
                    <span className="n">#{i + 1}</span>
                    <span className="t">{s.t0.toFixed(4)} – {s.t1.toFixed(4)}</span>
                    <span className="st">{s.removed ? 'removed' : 'keep'}</span>
                    <span className="d">{(s.t1 - s.t0).toFixed(3)} s</span>
                    {s.removed
                      ? <button className="ce-mini" title="Restore" onClick={e => { e.stopPropagation(); apply(restoreAt(segs, (s.t0 + s.t1) / 2)); }}>↺</button>
                      : <button className="ce-mini" title="Remove" onClick={e => { e.stopPropagation(); apply(removeSegAt(segs, (s.t0 + s.t1) / 2)); }}>−</button>}
                  </div>
                  {isJoin(segs, i) && (
                    <div className="ce-joinrow">
                      <span className="n">⟩⟨</span><span>join · crossfade</span>
                      <select value={s.fadeMs ?? draft.defaultFadeMs} onChange={e => apply(setFade(segs, i, Number(e.target.value)))}>
                        {FADES.map(f => <option key={f} value={f}>{f ? `${f} ms` : 'none'}</option>)}
                      </select>
                    </div>
                  )}
                  {i < segs.length - 1 && !s.removed && !segs[i + 1].removed && (
                    <div className="ce-joinrow cut"><span className="n">✂</span><span>cut mark · no join (adjacent)</span></div>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section className="ce-box">
            <h3>Joins &amp; snapping</h3>
            <label className="ce-row">default crossfade
              <select value={draft.defaultFadeMs} onChange={e => setD({ defaultFadeMs: Number(e.target.value) })}>
                {FADES.map(f => <option key={f} value={f}>{f ? `${f} ms · equal-power` : 'none'}</option>)}
              </select>
            </label>
            <label className="ce-row">snap to zero crossing (±2 ms)<input type="checkbox" checked={draft.zc} onChange={e => setD({ zc: e.target.checked })} /></label>
            <label className="ce-row">flag clipped samples in kept audio<input type="checkbox" checked={draft.flagClip} onChange={e => setD({ flagClip: e.target.checked })} /></label>
            {draft.flagClip && peaks.clipped.length > 0 && <p className="small clip">{peaks.clipped.length.toLocaleString()} clipped sample{peaks.clipped.length > 1 ? 's' : ''} in the source</p>}
          </section>

          <section className="ce-box" data-testid="ce-output">
            <h3>Output</h3>
            <label className="ce-row">name suffix<input className="ce-input" value={clipName} placeholder={`edit ${created.length + 1}`} onChange={e => setClipName(e.target.value)} maxLength={40} /></label>
            <p className="small dim">{fmtTime(editedDur)} · same format as the source ({asset?.format ?? '?'}, {(sr / 1000).toFixed(sr % 1000 ? 1 : 0)} kHz). The source is never modified; the draft stays so you can make another clip.</p>
            <button className="ce-btn primary wide" onClick={createClip} disabled={creating || !nKept}>{creating ? 'Creating…' : 'Create clip'}</button>
            {created.length > 0 && (
              <div className="ce-created">
                <div className="dim small">Created from this source</div>
                {created.map(c => (
                  <div key={c.id} className="ce-createdrow">
                    <a href={`${LIB}/?assetid=${c.id}`} onClick={e => { if (plainClick(e)) { e.preventDefault(); nav.onOpenAsset(c.id); } }} title="Open in the library">{c.label || c.filename}</a>
                    <span className="dim">{c.duration_s ? fmtTime(c.duration_s) : ''}</span>
                    <a className="ce-mini" href={`${LIB}/?app=clip-editor&edit=${assetId}&from=${c.id}`} onClick={e => { if (plainClick(e)) { e.preventDefault(); nav.onEditAgain(c.id); } }} title="Load this clip's edits as the draft">Edit again</a>
                  </div>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>

      {toast && (
        <div className={`ce-toast${toast.err ? ' err' : ''}`} data-testid="ce-toast">
          {toast.msg}
          {toast.id && <a href={`${LIB}/?assetid=${toast.id}`} onClick={e => { if (plainClick(e)) { e.preventDefault(); nav.onOpenAsset(toast.id!); } }}>Open</a>}
          <button className="ce-mini" onClick={() => setToast(null)}>×</button>
        </div>
      )}
    </div>
  );
}
