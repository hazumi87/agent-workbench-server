// The mini library picker (task; Aurora fullpage-apps-v1.2 §2 + §3C). Any tool or app that needs
// "load a file from the library" calls pickAsset(); it resolves to the chosen Asset, or null.
// ★ Favorites → Recents (this device) → All newest first; one search filters every group. Category
// chips only when `accept` has 2+ types. Desktop: a 560px modal; phone: a 72% bottom sheet.
// §1.1 (mandatory): a scroll never selects — see the tap guard below.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Asset } from '../types';
import { readRecents } from '../shell/appRoute';
import { IconClose, IconSearch } from '../icons';
import './picker.css';

const LIB = '/asset-management/library';
const NAMES: Record<string, string> = { audio: 'Audio', video: 'Video', image: 'Images', mesh: 'Meshes' };

export interface PickOptions { accept: string[]; title: string; opener?: HTMLElement | null; excludeSubtypes?: string[] }

export function pickAsset(opts: PickOptions): Promise<Asset | null> {
  const opener = opts.opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  return new Promise(resolve => {
    const done = (a: Asset | null) => {
      root.unmount(); host.remove();
      if (opener?.isConnected) opener.focus();   // Esc / pick hands focus back to the opener
      resolve(a);
    };
    root.render(<Picker opts={opts} onDone={done} />);
  });
}

const fmtDur = (s?: number | null) => (s == null ? '' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);
const nameOf = (a: Asset) => a.label || a.filename || a.id.slice(0, 8);

function Picker({ opts, onDone }: { opts: PickOptions; onDone: (a: Asset | null) => void }) {
  const chips = opts.accept.length > 1;
  const [cat, setCat] = useState<string>(chips ? opts.accept[0] : opts.accept.join(','));
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [favs, setFavs] = useState<Asset[]>([]);
  const [all, setAll] = useState<Asset[] | null>(null);
  const [kbi, setKbi] = useState(0);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const arrowMode = useRef(false);   // Space previews after ↑/↓; otherwise it types into search
  const [kbShown, setKbShown] = useState(false);   // touch has no keyboard cursor: highlight only after an arrow
  const phone = typeof matchMedia === 'function' && matchMedia('(max-width: 700px)').matches;
  const types = cat === 'all' ? opts.accept : cat.split(',');

  useEffect(() => { if (!phone) searchRef.current?.focus(); }, [phone]);
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 120); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    fetch(`${LIB}/api/favorites`).then(r => r.json()).then(j => setFavs(j.assets || [])).catch(() => {});
    return () => audio.current?.pause();
  }, []);
  useEffect(() => {
    let dead = false;
    const p = new URLSearchParams({ category: types.join(','), limit: '80' });
    if (dq) p.set('q', dq);
    fetch(`${LIB}/api/assets?${p}`).then(r => r.json()).then(j => { if (!dead) setAll(j.assets || []); }).catch(() => !dead && setAll([]));
    return () => { dead = true; };
  }, [dq, cat]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ★ → Recents → All, each id once; typing filters every group (the server searches All).
  const groups = useMemo(() => {
    const ok = (a: { category: string; label?: string | null; filename?: string | null }) =>
      types.includes(a.category) && !opts.excludeSubtypes?.includes((a as Asset).subtype ?? '') && (!dq || `${a.label ?? ''} ${a.filename ?? ''}`.toLowerCase().includes(dq.toLowerCase()));
    const f = favs.filter(ok);
    const seen = new Set(f.map(a => a.id));
    const r = (readRecents() as Asset[]).filter(a => ok(a) && !seen.has(a.id));
    r.forEach(a => seen.add(a.id));
    const rest = (all || []).filter(a => !seen.has(a.id) && !opts.excludeSubtypes?.includes(a.subtype ?? ''));
    return ([['★ Favorites', f], ['Recents', r], ['All', rest]] as [string, Asset[]][]).filter(([, l]) => l.length);
  }, [favs, all, dq, cat]);   // eslint-disable-line react-hooks/exhaustive-deps
  const rows = groups.flatMap(([, l]) => l);
  useEffect(() => { setKbi(0); }, [dq, cat]);
  useEffect(() => { listRef.current?.querySelector('.pk-row.kb')?.scrollIntoView({ block: 'nearest' }); }, [kbi]);

  const favIds = new Set(favs.map(a => a.id));
  const preview = (a: Asset | undefined) => {
    if (!a || (a.category !== 'audio' && a.category !== 'video')) return;
    if (playing === a.id) { audio.current?.pause(); setPlaying(null); return; }
    audio.current?.pause();
    audio.current = new Audio(`${LIB}/api/assets/${a.id}/file`);
    audio.current.onended = () => setPlaying(null);
    audio.current.play().then(() => setPlaying(a.id), () => setPlaying(null));
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); arrowMode.current = true; setKbShown(true);
      setKbi(i => Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (e.key === 'Enter') { e.preventDefault(); if (rows[kbi]) onDone(rows[kbi]); }
    else if (e.key === 'Escape') { e.preventDefault(); onDone(null); }
    else if (e.key === ' ' && (arrowMode.current || (e.target as HTMLElement).tagName !== 'INPUT')) { e.preventDefault(); preview(rows[kbi]); }
    else if (e.key.length === 1) arrowMode.current = false;
  };

  // §1.1 tap guard: pick on click only; cancel past 10px of movement or any scroll during the
  // gesture; a touch within 100ms of a scroll only stops the momentum.
  const g = useRef({ x: 0, y: 0, bad: false, active: false, lastScroll: 0, endBad: false });
  const onScroll = () => { g.current.lastScroll = performance.now(); if (g.current.active) g.current.bad = true; };
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    Object.assign(g.current, { x: t.clientX, y: t.clientY, active: true, bad: performance.now() - g.current.lastScroll < 100 });
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (Math.hypot(t.clientX - g.current.x, t.clientY - g.current.y) > 10) g.current.bad = true;
  };
  const onTouchEnd = () => { g.current.active = false; g.current.endBad = g.current.bad; };
  const pick = (a: Asset) => { if (g.current.endBad) { g.current.endBad = false; return; } onDone(a); };

  // Phone: swipe the sheet's handle/header down to close (it stays in the app).
  const sheetY = useRef<number | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragStart = (e: React.TouchEvent) => { if (phone) sheetY.current = e.touches[0].clientY; };
  const dragMove = (e: React.TouchEvent) => {
    if (sheetY.current == null || !sheetRef.current) return;
    sheetRef.current.style.transform = `translateY(${Math.max(0, e.touches[0].clientY - sheetY.current)}px)`;
  };
  const dragEnd = (e: React.TouchEvent) => {
    if (sheetY.current == null || !sheetRef.current) return;
    const dy = e.changedTouches[0].clientY - sheetY.current;
    sheetY.current = null;
    if (dy > 80) onDone(null); else sheetRef.current.style.transform = '';
  };

  let n = -1;
  return (
    <div className="pk-layer" onKeyDown={onKey} onContextMenu={e => e.preventDefault()}>
      <div className="pk-scrim" onClick={() => onDone(null)} />
      <div className={`pk-pick${phone ? ' phone' : ''}`} ref={sheetRef} role="dialog" aria-modal="true" aria-label={opts.title} data-testid="asset-picker">
        <div className="pk-head" onTouchStart={dragStart} onTouchMove={dragMove} onTouchEnd={dragEnd}>
          {phone && <div className="pk-grab" />}
          <div className="pk-ph">
            <b>{opts.title}</b>
            <button className="pk-ib" onClick={() => onDone(null)} aria-label="Close"><IconClose /></button>
          </div>
        </div>
        <div className="pk-pf">
          <label className="pk-search"><IconSearch /><input ref={searchRef} value={q} onChange={e => setQ(e.target.value)}
            placeholder={`Search ${types.map(t => (NAMES[t] || t).toLowerCase()).join(' + ')}…`} data-testid="picker-search" /></label>
          {chips && (
            <div className="pk-chips">
              {[...opts.accept, 'all'].map(c => (
                <button key={c} className={`pk-chip${cat === c ? ' on' : ''}`} onClick={() => setCat(c)}>{c === 'all' ? 'All' : NAMES[c] || c}</button>
              ))}
            </div>
          )}
        </div>
        <div className="pk-lst" ref={listRef} onScroll={onScroll} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} role="listbox">
          {all === null && !groups.length && <div className="pk-none">Loading…</div>}
          {all !== null && !groups.length && <div className="pk-none">No match.</div>}
          {groups.map(([title, list]) => (
            <div key={title}>
              <div className="pk-gh">{title}</div>
              {list.map(a => {
                n++;
                const i = n, img = a.category === 'image';
                return (
                  <div key={a.id} className={`pk-row${i === kbi && (kbShown || !phone) ? ' kb' : ''}`} role="option" aria-selected={i === kbi}
                    onClick={() => pick(a)} onMouseMove={() => { if (kbi !== i) setKbi(i); }} data-testid="picker-row">
                    <div className={`pk-rt${img ? ' img' : ''}`}><img src={`${LIB}/api/assets/${a.id}/thumb`} alt="" loading="lazy" draggable={false} /></div>
                    <div className="pk-rn"><div>{nameOf(a)}</div><small>{[fmtDur(a.duration_s), a.category].filter(Boolean).join(' · ')}{playing === a.id ? ' · ▶ playing' : ''}</small></div>
                    {favIds.has(a.id) && <span className="pk-fav">★</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {!phone && (
          <div className="pk-keys"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> pick</span><span><kbd>Space</kbd> preview</span><span><kbd>Esc</kbd> close</span></div>
        )}
      </div>
    </div>
  );
}
