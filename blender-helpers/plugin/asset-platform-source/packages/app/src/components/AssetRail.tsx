import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { gestureBusy, pointersDown, swallowNextClick } from '../gestures';
import { IconArrowDown, IconArrowUp, IconImage, IconMusic, IconLayout, IconSearch, IconCheck, IconPause, IconPlay, IconStar, IconStarFilled, IconChevronDown, IconChevronLeft, IconChevronRight, IconClose, IconCopy, IconDownload, IconLink, IconEdit, IconFilter, IconPlus, IconReload, IconScissors, IconCube, IconSort, IconTrash } from '../icons';
import type { Asset, AssetCategory, ToolDeclaration, RailTab } from '../types';
import { getTabsForTool } from '../toolRegistry';
import { VoicePlayer } from './VoicePlayer';
import { assetClassInfo } from '../assetClass';
import { assetDate, LayoutGrid, LayoutMenu, loadLayout, metaBand, saveLayout, type LayoutMode } from './LibraryLayout';
import { checkedSubs, subKey, type LibraryControls, type LibraryQuery } from '../hooks/useLibraryData';
import { BulkBar, IconCheckSquare, IconMore, type BulkKind, type BulkSection, type BulkSel } from './BulkBar';

const LIB_BASE = '/asset-management/library';

interface Props {
  activeCategory: AssetCategory | null;
  activeTool: ToolDeclaration | null;
  selectedAssets: Asset[];
  onAssetToggle: (asset: Asset, maxSlots: number) => void;
  isSelected: (id: string) => boolean;
  clipboardAssets: Asset[];
  recycleAssets: Asset[];
  libraryAssets: Asset[];
  library: LibraryControls;
  loading: boolean;
  refresh: () => void;
  onYtModalOpen: () => void;
  // Controlled tab state (owned by App so switchToCompare can drive it)
  activeTab: string;
  onTabChange: (tabId: string) => void;
  compareA: Asset | null;
  compareB: Asset | null;
  onSetCompareAB: (a: Asset | null, b: Asset | null) => void;
  // Viewer is lifted to App — these are passed down
  onViewAsset: (asset: Asset, list?: Asset[]) => void;   // list: the section it was opened from (for ‹ › stepping)
  onTileMenu?: (asset: Asset, list: Asset[]) => void;     // long-press on a tile (touch)
  confirm?: (o: { title: string; body?: string; ok: string; danger?: boolean }) => Promise<boolean>;
  favoriteAssets?: Asset[];
  favoriteIds?: Set<string>;
  onClearFavorites?: () => void;
  phone?: boolean;   // phone layout: one-line header, pinch-to-resize
  previewId?: string | null;   // asset open in the Preview: its tile lifts if visible (never scrolled to)
  // Multi-select. State lives in App (the phone bottom bar + swipe-back need it);
  // null = not in select mode.
  bulk?: BulkSel | null;
  onBulkChange?: (f: (b: BulkSel | null) => BulkSel | null) => void;
  onBulk?: (kind: BulkKind, assets: Asset[]) => void;
}

type SortOrder = LibraryQuery['sort'];

function assetLabel(a: Asset): string {
  return a.label || a.filename || 'asset ' + a.id.slice(0, 8);
}

function fmtDur(s: number | null | undefined): string {
  if (s == null || isNaN(s)) return '';
  const m = Math.floor(s / 60);
  const x = Math.floor(s % 60);
  return m + ':' + String(x).padStart(2, '0');
}

interface ThumbnailProps {
  asset: Asset;
  selected?: boolean;
  onToggle?: (a: Asset) => void;
  onView: (a: Asset) => void;
  quickActions?: React.ReactNode;
  thumbSize?: number;
  /** tile box from the layout; defaults to a thumbSize square */
  w?: number;
  h?: number;
  fit?: 'cover' | 'contain';
  toolActive?: boolean;
  onLongPress?: (a: Asset) => void;
  favorite?: boolean;
  previewed?: boolean;      // the asset open in the Preview lifts, like a selection without the ✓
  layout?: LayoutMode;
  picking?: boolean;        // select mode: every tile shows a checkbox and a click toggles
  picked?: boolean;
  onPick?: (a: Asset, shift: boolean) => void;   // also Ctrl/⌘-click outside select mode
  onMore?: (a: Asset) => void;                   // phone ⋯: the old long-press action sheet
  'data-testid'?: string;
}

// A card's top edge on screen, minus the lift transform (so a lifted card anchors like a still one).
function cardTop(c: HTMLElement) { const r = c.getBoundingClientRect(); return c.classList.contains('up') ? r.top + 3 + r.height * 0.0086 : r.top; }

// Card accent by asset type (Aurora card system: image lime, mesh coral, video indigo, audio magenta).
const CARD_ACCENT: Record<string, string> = { image: '--lime', video: '--indigo', audio: '--magenta', mesh: '--coral', model: '--coral', voice: '--teal' };
// Browsers show these; texture formats (.tga/.dds/.exr/.psd/…) preview via the server thumbnail.
const WEB_IMAGE = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;
// An SVG is transparent: show it on its stored light/dark backdrop (meta.backdrop, computed by the
// Library when the SVG is indexed — dark ink → white). Not yet computed → white (ink is usually dark).
function svgBackdrop(a: Asset): string | null {
  if (!/\.svg$/i.test(a.filename || '')) return null;
  let m: { backdrop?: string } = {};
  try { m = (typeof a.meta === 'string' ? JSON.parse(a.meta) : a.meta) || {}; } catch { /* ignore */ }
  return m.backdrop === 'dark' ? '#111111' : '#ffffff';
}
// three.js is ~600 KB: loaded only when a mesh is opened.
const MeshViewer = lazy(() => import('./MeshViewer'));
const MESH_VIEWABLE = ['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply'];

const CARD_TAG: Record<string, string> = { image: 'IMAGE', video: 'VIDEO', audio: 'AUDIO', mesh: 'MESH', model: 'MESH', voice: 'VOICE' };
const cardExt = (a: Asset) => (a.filename || a.rel_path || '').split('.').pop()?.toLowerCase() || '';
function cardExtra(a: Asset): string {   // duration, else pixel size
  let m: { width?: number; height?: number } = {};
  if (a.meta) { try { m = (typeof a.meta === 'string' ? JSON.parse(a.meta) : a.meta) as typeof m; } catch { /* ignore */ } }
  return a.duration_s != null && a.category !== 'image' ? fmtDur(a.duration_s) : m.width && m.height ? `${m.width}×${m.height}` : '';
}
const cardSub = (a: Asset) => [cardExt(a), cardExtra(a)].filter(Boolean).join(' · ');

// ── Row card text (the user + Aurora, "cards wider so you don't have to hover to read the title") ──
// Wrap to 2 lines first; past that, a MIDDLE ellipsis keeps the start and the last ~24 chars — the
// distinctive "(edit_6)" end of a derived name. The length budget is 2 lines of the text column at the
// title's measured average glyph width, less ~18% that word-wrapping wastes (≈42 chars at 260px).
let titleCtx: CanvasRenderingContext2D | null | undefined;
function titleWidth(s: string): number {
  if (titleCtx === undefined) {
    titleCtx = document.createElement('canvas').getContext('2d');
    if (titleCtx) titleCtx.font = `600 13px ${getComputedStyle(document.body).fontFamily}`;
  }
  return titleCtx ? titleCtx.measureText(s).width : s.length * 7.4;
}
function rowTitle(label: string, textW: number): { head: string; tail: string } {
  const budget = Math.max(28, Math.floor(textW * 2 * 0.82 / (titleWidth(label) / label.length || 7.4)));
  if (label.length <= budget) return { head: label, tail: '' };
  const tail = Math.min(24, Math.floor(budget * 0.45));
  return { head: label.slice(0, budget - tail - 1).trimEnd(), tail: label.slice(-tail) };
}
// Derived labels are "<source>[ variant] <base>" (asset-library deriveNames); the variant is recoverable
// from the filename "<base>-<source>_<variant>.ext". Its length, so the card can dim it and lead with <base>.
function sourceLead(a: Asset, label: string): number {
  const src = a.source;
  if (!src || !label.startsWith(src + ' ')) return 0;
  const i = (a.filename || '').lastIndexOf(`-${src}_`);
  const variant = i >= 0 ? (a.filename || '').slice(i + src.length + 2).replace(/\.[^.]*$/, '') : '';
  return variant && label.startsWith(`${src} ${variant} `) ? src.length + variant.length + 1 : src.length;
}
function rowTime(a: Asset): string {
  const d = assetDate(a);
  if (!d) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) });
}

// Touch long-press (~480 ms, like the mockup) opens the tile's action sheet; the click that
// follows the press is swallowed so the tile doesn't also open.
function useLongPress(onFire?: () => void) {
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  if (!onFire) return {};
  const clear = () => { if (t.current) clearTimeout(t.current); t.current = null; };
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      fired.current = false; clear();
      if (gestureBusy()) return;                                   // R2/R4: part of (or just after) a pinch
      const x0 = e.clientX, y0 = e.clientY; start.current = { x: x0, y: y0 };
      t.current = setTimeout(() => {
        if (gestureBusy() || pointersDown() !== 1) return;          // R1/R2: re-check at fire time
        fired.current = true; swallowNextClick(); navigator.vibrate?.(15); onFire();
      }, 480);
    },
    onPointerUp: clear, onPointerCancel: clear, onPointerLeave: clear,
    onPointerMove: (e: React.PointerEvent) => {                  // R5: >10px is a scroll, not a press
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) clear();
    },
    onContextMenu: (e: React.MouseEvent) => { if (fired.current || t.current) e.preventDefault(); },
    onClickCapture: (e: React.MouseEvent) => { if (fired.current) { e.stopPropagation(); e.preventDefault(); fired.current = false; } },
  };
}

function Thumbnail({ asset, selected, onToggle, onView, quickActions, thumbSize = 88, w = thumbSize, h = thumbSize, fit = 'cover', toolActive = false, onLongPress, favorite = false, previewed = false, layout = 'fill', picking = false, picked = false, onPick, onMore, ...rest }: ThumbnailProps) {
  const press = useLongPress(onLongPress ? () => onLongPress(asset) : undefined);
  const label = assetLabel(asset);
  const meta = asset.meta
    ? (typeof asset.meta === 'string' ? JSON.parse(asset.meta) : asset.meta) as { audio_ref?: string }
    : {};
  const thumbId = (asset.subtype === 'voice' && meta.audio_ref) ? meta.audio_ref : asset.id;
  const thumbSrc = `${LIB_BASE}/api/assets/${thumbId}/thumb`;
  const isVideo = asset.category === 'video';
  const isPicture = isVideo || asset.category === 'image' || asset.category === 'mesh';   // meshes have rendered thumbnails now
  const band = metaBand(w, layout);                 // the image area never runs under the band
  const [broken, setBroken] = useState(false);      // missing thumbnail -> type icon, not a black face
  const kind = asset.subtype === 'voice' ? 'voice' : asset.category;
  const marks = (favorite || selected) && <>
    {favorite && <IconStarFilled className="card-fav" aria-label="Favorite" />}
    {selected && <span className="card-ck" aria-label="Selected"><IconCheck /></span>}
  </>;
  const row = layout === 'row';   // horizontal card: thumb + text column; CSS sizes it (the grid cell)
  const title = row ? rowTitle(label, w - h - 38) : null;   // h = the square thumb; 38 = padding + ★ column
  const lead = title ? Math.min(sourceLead(asset, label), title.head.length) : 0;
  return (
    <div
      className={`thumb card${selected ? ' selected' : ''}${selected || previewed ? ' up' : ''}${row ? ' card-row' : ''}${band && band < 30 ? ' card-xs' : ''}${picking ? ' picking' : ''}${picked ? ' picked' : ''}`}
      style={{ ...(!row && { width: w, height: h }), ['--accent' as string]: `var(${CARD_ACCENT[kind] || '--teal'})` }}
      aria-label={row ? label : undefined}
      role={picking ? 'checkbox' : undefined}
      aria-checked={picking ? picked : undefined}
      tabIndex={-1}   // focusable for the select-mode arrow keys; not a Tab stop
      // In select mode a click toggles and never opens the Preview.
      onClick={e => { if (onPick && (picking || e.ctrlKey || e.metaKey)) onPick(asset, picking && e.shiftKey); else onView(asset); }}
      onMouseDown={e => { if (picking && e.shiftKey) e.preventDefault(); }}   // shift-click: no text selection
      {...press}
      draggable
      onDragStart={e => { e.dataTransfer.setData('application/x-asset-id', asset.id); e.dataTransfer.effectAllowed = 'copy'; }}
      title={label}
      {...rest}
    >
      <div className="face">
        {picking && <span className={`pick-ck${picked ? ' on' : ''}`} aria-hidden>{picked && <IconCheck />}</span>}
        {onMore && !picking && (
          <button className="card-more" aria-label="More actions" title="More actions" data-testid="card-more"
            onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onMore(asset); }}><IconMore /></button>
        )}
        <div className="th">
          {broken ? (
            <div className="card-missing" title="No thumbnail">{isVideo ? <IconPlay /> : isPicture ? <IconImage /> : <IconMusic />}</div>
          ) : isPicture ? (
            <img className="thumb-img" src={thumbSrc} alt="" loading="lazy" decoding="async" draggable={false}
              onError={() => setBroken(true)} style={{ objectFit: fit, background: fit === 'contain' ? 'var(--surface2)' : '#000' }} />
          ) : (<>
            <img src={thumbSrc} alt="" hidden loading="lazy" onError={() => setBroken(true)} />
            <div className="thumb-wave" style={{
              position: 'absolute', inset: 0,
              maskImage: `url(${thumbSrc})`, WebkitMaskImage: `url(${thumbSrc})`,
              maskSize: 'contain', WebkitMaskSize: 'contain', maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat',
              maskPosition: 'center', WebkitMaskPosition: 'center', backgroundColor: 'var(--accent)',
            }} />
          </>)}
          {band >= 34 && <span className="card-tag">{CARD_TAG[kind] || kind.toUpperCase()}</span>}
          {isVideo && <IconPlay className="card-play" />}
          {toolActive && onToggle && !picking && (
            <div className="thumb-overlay">
              <input
                type="checkbox"
                className="thumb-check"
                checked={!!selected}
                onClick={e => { e.stopPropagation(); onToggle(asset); }}
                onChange={() => {}}
                title="Select for tool"
              />
              {quickActions}
            </div>
          )}
        </div>
        {title && (
          <div className="card-rt">
            <div className="card-rn">
              {lead > 0 && <span className="card-rsrc">{title.head.slice(0, lead)}</span>}
              {title.head.slice(lead)}{title.tail && <>…{title.tail}</>}
            </div>
            {/* type · duration/size (the extension only when there's neither) · time — the time never truncates */}
            <div className="card-rs"><span>{[kind, cardExtra(asset) || cardExt(asset)].filter(Boolean).join(' · ')}</span><span>{rowTime(asset) && ` · ${rowTime(asset)}`}</span></div>
          </div>
        )}
        {row && marks && <div className="card-mk">{marks}</div>}
        {band > 0 && (
          <div className="card-m" style={{ height: band }}>
            <div className="card-tx">
              <div className="card-nm">{label}</div>
              {band >= 34 && <div className="card-s">{cardSub(asset)}</div>}
            </div>
            {marks && <div className="card-mk">{marks}</div>}
          </div>
        )}
      </div>
      <div className="lit" />
    </div>
  );
}

const THUMB_SIZE_KEY = 'assetlib.thumbSize';
const THUMB_DEFAULT = 88;
const THUMB_MIN = 52;
const THUMB_MAX = 160;

function loadThumbSize(): number {
  try {
    const v = localStorage.getItem(THUMB_SIZE_KEY);
    if (v) { const n = parseInt(v); if (n >= THUMB_MIN && n <= THUMB_MAX) return n; }
  } catch {}
  return THUMB_DEFAULT;
}

export function AssetRail({
  activeCategory, activeTool, selectedAssets, onAssetToggle, isSelected,
  clipboardAssets, recycleAssets, libraryAssets, library, loading, refresh, onYtModalOpen,
  activeTab, onTabChange, compareA, compareB, onSetCompareAB, onViewAsset, onTileMenu, confirm,
  favoriteAssets = [], favoriteIds, onClearFavorites, phone = false, previewId = null,
  bulk = null, onBulkChange, onBulk,
}: Props) {
  const tabs: RailTab[] = getTabsForTool(activeTool, activeCategory);
  const [filterOpen, setFilterOpen] = useState(false);
  const { query, setQuery, facets } = library;
  const sortOrder: SortOrder = query.sort;
  const setSortOrder = (f: (s: SortOrder) => SortOrder) => setQuery({ ...query, sort: f(query.sort) });
  const [searchDraft, setSearchDraft] = useState(query.q);
  const moreRef = useRef<HTMLDivElement>(null);
  const [recycleOpen, setRecycleOpen] = useState(false);
  const [clipboardOpen, setClipboardOpen] = useState(true);
  const [favoritesOpen, setFavoritesOpen] = useState(true);
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [thumbSize, setThumbSizeState] = useState<number>(loadThumbSize);
  const [layout, setLayoutState] = useState<LayoutMode>(loadLayout);
  const setLayout = (m: LayoutMode) => { setLayoutState(m); saveLayout(m); };
  const fit = layout === 'fit' ? 'contain' as const : 'cover' as const;
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Phone (task, Aurora v1.4): pinch the grid to resize — 2/3/4 columns, or S/M/L rows ──
  const [phoneCols, setPhoneCols] = useState(() => { try { return Math.min(4, Math.max(2, parseInt(localStorage.getItem('ap.phoneCols') || '3') || 3)); } catch { return 3; } });
  const [viewOpen, setViewOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [hud, setHud] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const sectionsRef = useRef<HTMLDivElement>(null);
  const railW = phone ? window.innerWidth : 0;
  const gridSize = !phone ? thumbSize
    : layout === 'row' ? 64   // Row cards are a fixed size; pinch sizes the grids only
    : Math.floor((railW - 20 - 6 * (phoneCols - 1)) / phoneCols);
  const sizeLabel = `${phoneCols} col`;
  const layoutLabel = { masonry: 'Masonry', fill: 'Grid', fit: 'Fit', row: 'Row' }[layout];
  const sortLabel = { newest: 'Newest', oldest: 'Oldest', alpha: 'A–Z' }[sortOrder];

  useEffect(() => {   // one-time "Pinch the grid" hint, no layout space (Aurora)
    if (!phone) return;
    let seen: string | null = null; try { seen = localStorage.getItem('ap-pinch-hint'); } catch { /* per-viewer only */ }
    if (seen) return;
    const a = setTimeout(() => setHint(true), 600), b = setTimeout(() => setHint(false), 6600);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [phone]);
  const dismissHint = () => { setHint(false); try { localStorage.setItem('ap-pinch-hint', '1'); } catch { /* ignore */ } };

  // Keep the library still when its WIDTH changes (the Preview column opening/closing, a window resize):
  // the user's rule is that opening Preview never moves the library (Aurora review, task). Anchor the
  // pressed tile (or the first visible one) and restore its on-screen top while the grid re-flows.
  const anchorRef = useRef<{ id: string; top: number } | null>(null);
  useEffect(() => {
    const el = sectionsRef.current;
    if (!el) return;
    let restoring = false, raf = 0, until = 0, lastW = el.clientWidth, held = 0;
    const pickFirstVisible = () => {
      const top = el.getBoundingClientRect().top;
      const c = [...el.querySelectorAll<HTMLElement>('.card[data-testid]')].find(x => x.getBoundingClientRect().bottom > top + 4);
      anchorRef.current = c ? { id: c.dataset.testid!, top: cardTop(c) } : null;
    };
    const onDown = (e: PointerEvent) => {
      const c = (e.target as Element).closest?.('.card[data-testid]') as HTMLElement | null;
      if (c) { anchorRef.current = { id: c.dataset.testid!, top: cardTop(c) }; held = performance.now() + 1500; }   // the pressed tile wins
    };
    const onScroll = () => { if (!restoring && performance.now() > held) pickFirstVisible(); };
    const restore = () => {
      const anchor = anchorRef.current, t = anchor && el.querySelector<HTMLElement>(`[data-testid="${anchor.id}"]`);
      if (anchor && t) { const d = cardTop(t) - anchor.top; if (Math.abs(d) > 1) { restoring = true; el.scrollTop += d; } }
      if (performance.now() < until) raf = requestAnimationFrame(restore); else restoring = false;
    };
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === lastW) return;
      lastW = el.clientWidth; until = performance.now() + 700;
      cancelAnimationFrame(raf); raf = requestAnimationFrame(restore);
    });
    el.addEventListener('pointerdown', onDown, true);
    el.addEventListener('scroll', onScroll, { passive: true });
    ro.observe(el);
    pickFirstVisible();
    return () => { el.removeEventListener('pointerdown', onDown, true); el.removeEventListener('scroll', onScroll); ro.disconnect(); cancelAnimationFrame(raf); };
  }, []);

  // Same anchor when the LISTS change under you (a render finishing, a refresh, a trash): items landing
  // above the visible card push it down — put it back before paint, by item id, not pixel offset.
  useLayoutEffect(() => {
    const el = sectionsRef.current, a = anchorRef.current;
    const t = a && el?.querySelector<HTMLElement>(`[data-testid="${a.id}"]`);
    if (!el || !a || !t) return;
    const d = cardTop(t) - a.top;
    if (Math.abs(d) > 1) el.scrollTop += d;
  }, [libraryAssets, clipboardAssets, favoriteAssets]);

  // Pinch on the grid (R6): non-passive touchmove + touch-action: pan-y, so the page never zooms.
  const pinch = useRef<{ d: number } | null>(null);
  const layoutRef = useRef(layout); layoutRef.current = layout;
  useEffect(() => {
    const el = sectionsRef.current;
    if (!phone || !el) return;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    let hudT: ReturnType<typeof setTimeout> | undefined;
    const onStart = (e: TouchEvent) => { if (e.touches.length >= 2) pinch.current = { d: dist(e.touches) }; };
    const onMove = (e: TouchEvent) => {
      if (!pinch.current || e.touches.length !== 2) return;
      e.preventDefault();
      const d = dist(e.touches), r = d / pinch.current.d;
      if (r < 1.3 && r > 0.77) return;
      const out = r > 1;   // spreading = bigger tiles
      if (layoutRef.current === 'row') return;   // Row cards are a fixed size
      setPhoneCols(v => { const n = Math.max(2, Math.min(4, v + (out ? -1 : 1))); try { localStorage.setItem('ap.phoneCols', String(n)); } catch { /**/ } setHud(`${n} columns`); return n; });
      pinch.current.d = d;
      clearTimeout(hudT); hudT = setTimeout(() => setHud(null), 700);
      dismissHint();
    };
    const onEnd = (e: TouchEvent) => { if (e.touches.length < 2) pinch.current = null; };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });
    return () => { el.removeEventListener('touchstart', onStart); el.removeEventListener('touchmove', onMove); el.removeEventListener('touchend', onEnd); el.removeEventListener('touchcancel', onEnd); clearTimeout(hudT); };
  }, [phone]);

  const setThumbSize = (n: number) => {
    setThumbSizeState(n);
    try { localStorage.setItem(THUMB_SIZE_KEY, String(n)); } catch {}
  };

  // Search is debounced so typing doesn't fire a query per keystroke.
  useEffect(() => {
    if (searchDraft === query.q) return;
    const t = setTimeout(() => setQuery({ ...query, q: searchDraft }), 300);
    return () => clearTimeout(t);
  }, [searchDraft, query, setQuery]);

  // Infinite scroll: fetch the next page when the sentinel under the grid comes into view.
  const { loadMore } = library;
  useEffect(() => {
    const el = moreRef.current;
    if (!el) return;
    const io = new IntersectionObserver(es => { if (es[0].isIntersecting) loadMore(); }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  // ‹ › steps in the order you READ the grid. Fill/Fit are already left→right, row by row; masonry
  // places each tile in the shortest column, so its list order zigzags between columns, and Row regroups
  // it into time buckets — sort those by the card's top edge, then left to right. Snapshotted
  // when the preview opens.
  const readingOrder = (list: Asset[], section: string): Asset[] => {
    if (layout !== 'masonry' && layout !== 'row') return list;
    const el = document.querySelector(`[data-testid="${section}"]`);
    if (!el) return list;
    const pos = new Map<string, { t: number; l: number }>();
    el.querySelectorAll<HTMLElement>('.card[data-testid]').forEach(c => {
      const r = c.getBoundingClientRect(); pos.set(c.dataset.testid!.replace(/^(lib|fav|clip|rec)-thumb-/, ''), { t: Math.round(r.top), l: Math.round(r.left) });
    });
    return [...list].sort((a, b) => {
      const pa = pos.get(a.id), pb = pos.get(b.id);
      if (!pa || !pb) return pa ? -1 : pb ? 1 : 0;
      return Math.abs(pa.t - pb.t) > 8 ? pa.t - pb.t : pa.l - pb.l;   // tops within 8px read as one row
    });
  };

  const toggleIn = (list: string[], v: string) => list.includes(v) ? list.filter(x => x !== v) : [...list, v];
  const filtersOn = query.excludedSources.length + query.categories.length + query.collections.length + query.subtypes.length > 0;
  const clearFilters = () => setQuery({ ...query, excludedSources: [], categories: [], collections: [], subtypes: [] });
  const typeName = (c: string) => assetClassInfo({ id: '', category: c }).className;
  // Active-filter chip: "Audio: voice, stem · −krea2 · Synty Pack"; ✕ clears all.
  const filterText = [
    ...query.categories.map(c => { const subs = checkedSubs(query, c); return typeName(c) + (subs.length ? `: ${subs.join(', ')}` : ''); }),
    ...query.excludedSources.map(src => `−${src}`),
    ...query.collections.map(slug => facets?.collections.find(c => c.slug === slug)?.name ?? slug),
  ].join(' · ');
  const filterChip = filtersOn && (
    <span className="filter-chip" data-testid="filter-chip" title={filterText}>
      <span className="filter-chip-tx">{filterText}</span>
      <button onClick={clearFilters} aria-label="Clear filters" title="Clear filters"><IconClose /></button>
    </span>
  );
  // A section the filters emptied says so, with a way out, instead of vanishing.
  const hiddenNote = (n: number, one: string, many: string) => (
    <div className="section-empty section-hidden" data-testid="section-hidden">
      {n} {n === 1 ? one : many} hidden by {filtersOn ? 'filters' : 'search'}
      {filtersOn && <> · <button className="section-clear-filters" onClick={clearFilters}>Clear filters</button></>}
    </div>
  );

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await fetch(`${LIB_BASE}/api/upload`, { method: 'POST', body: fd });
      refresh();
    } catch (e) {
      console.error('upload error', e);
    } finally {
      setUploading(false);
    }
  };

  const handleRevive = async (asset: Asset) => {
    try {
      await fetch(`${LIB_BASE}/api/clip/${asset.id}/revive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      refresh();
    } catch (e) { console.error(e); }
  };

  const handleTrashForever = async (asset: Asset) => {
    const name = assetLabel(asset);
    if (confirm && !(await confirm({ title: 'Delete forever?', body: `"${name}" will be permanently deleted. This can't be undone.`, ok: 'Delete forever', danger: true }))) return;
    try {
      await fetch(`${LIB_BASE}/api/clip/${asset.id}`, { method: 'DELETE' });
      refresh();
    } catch (e) { console.error(e); }
  };

  const sortAssets = (assets: Asset[]): Asset[] => {
    if (sortOrder === 'alpha') return [...assets].sort((a, b) => assetLabel(a).localeCompare(assetLabel(b)));
    if (sortOrder === 'oldest') return [...assets].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
    return [...assets].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  };

  // The search box filters Favorites, Clipboard and Recycle too , with the server's
  // rule: every word must start a word in the name, filename or prompt.
  const searchWords = (x: string) => x.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  // …and the Type / sub-type / Source filters too ("filter them equally").
  // A sub-filter narrows only its own type: pass if the type is checked and has no checked subs, or
  // this asset's subtype is one of them.
  const matchesSearch = (a: Asset) => {
    if (query.categories.length) {
      if (!query.categories.includes(a.category)) return false;
      const subs = checkedSubs(query, a.category);
      if (subs.length && !subs.includes(a.subtype ?? '')) return false;
    }
    if (query.excludedSources.length && query.excludedSources.includes(a.source ?? '')) return false;
    const want = searchWords(query.q);
    if (!want.length) return true;
    const meta = typeof a.meta === 'string' ? (() => { try { return JSON.parse(a.meta as string); } catch { return null; } })() : a.meta;
    const have = searchWords(`${a.label ?? ''} ${a.filename ?? ''} ${typeof meta?.prompt === 'string' ? meta.prompt : ''}`);
    return want.every(w => have.some(t => t.startsWith(w)));
  };
  const sortedClipboard = sortAssets(clipboardAssets).filter(matchesSearch);
  const favShown = favoriteAssets.filter(matchesSearch);
  const recycleShown = recycleAssets.filter(matchesSearch);

  // Selection checkboxes only for tools that take library inputs (slots > 0).
  const toolActive = !!activeTool && activeTool.slots.count > 0;
  const slotCount = activeTool?.slots.count ?? 0;
  const handleToggle = useCallback((asset: Asset) => onAssetToggle(asset, slotCount), [onAssetToggle, slotCount]);

  const validTab = tabs.find(t => t.id === activeTab) ? activeTab : tabs[0]?.id ?? 'library';

  // ── Multi-select ──
  // One section at a time: ranges never cross sections, and Revive vs Save/Recycle stays unambiguous.
  // Picking in another section starts a fresh selection there. The lists are what's ON SCREEN (filters
  // + search applied), so Select all / ranges only ever take visible tiles.
  const lists: Record<BulkSection, Asset[]> = { favorites: favShown, clipboard: sortedClipboard, recycle: recycleShown, library: libraryAssets };
  const bulkIds = new Set(bulk?.ids ?? []);
  const bulkAssets = bulk ? lists[bulk.section].filter(a => bulkIds.has(a.id)) : [];
  const setBulk = (f: (b: BulkSel | null) => BulkSel | null) => onBulkChange?.(f);
  const rangeIds = (sec: BulkSection, from: string, to: string) => {
    const order = readingOrder(lists[sec], `section-${sec}`).map(a => a.id);
    const i = order.indexOf(from), j = order.indexOf(to);
    return i < 0 || j < 0 ? [to] : order.slice(Math.min(i, j), Math.max(i, j) + 1);
  };
  const pick = (a: Asset, sec: BulkSection, shift = false) => {
    const range = shift && bulk?.section === sec && bulk.anchor ? rangeIds(sec, bulk.anchor, a.id) : null;
    setBulk(b => {
      if (!b || b.section !== sec) return { section: sec, ids: [a.id], anchor: a.id, base: [a.id] };
      if (range) return { ...b, ids: [...new Set([...b.base, ...range])] };
      const ids = b.ids.includes(a.id) ? b.ids.filter(x => x !== a.id) : [...b.ids, a.id];
      return { ...b, ids, anchor: a.id, base: ids };
    });
  };
  const selectAll = (sec: BulkSection) => {
    const ids = lists[sec].map(a => a.id);
    setBulk(() => ({ section: sec, ids, anchor: null, base: ids }));
  };
  const clearBulk = () => setBulk(() => null);
  const act = (k: BulkKind) => onBulk?.(k, bulkAssets);
  // Filters/search changed: keep only still-visible ids (skipped mid-load so a refetch can't wipe it).
  useEffect(() => {
    if (!bulk?.ids.length || loading) return;
    const vis = new Set(lists[bulk.section].map(a => a.id));
    if (bulk.ids.every(id => vis.has(id))) return;
    setBulk(b => b && { ...b, ids: b.ids.filter(id => vis.has(id)), base: b.base.filter(id => vis.has(id)), anchor: b.anchor && vis.has(b.anchor) ? b.anchor : null });
  });
  // Per-section tile props: checkbox/ring, click-to-toggle, and on the phone long-press = select
  // (Photos convention) with the old action sheet moved to a ⋯ button.
  const pickProps = (sec: BulkSection, list: Asset[], asset: Asset) => ({
    picking: !!bulk,
    picked: !!bulk && bulk.section === sec && bulkIds.has(asset.id),
    onPick: onBulkChange ? (a: Asset, shift: boolean) => pick(a, sec, shift) : undefined,
    onLongPress: phone && onBulkChange ? (a: Asset) => pick(a, sec) : onTileMenu && sec !== 'recycle' ? (a: Asset) => onTileMenu(a, list) : undefined,
    onMore: phone && onTileMenu && sec !== 'recycle' ? (a: Asset) => onTileMenu(a, list) : undefined,
  });

  // Keyboard, select mode only. Arrows move focus in the section (← → in reading order, ↑ ↓ to the
  // nearest tile in the next row), Space toggles, Shift+arrow extends from the anchor, Ctrl/⌘+A
  // selects the section, Esc clears AND leaves select mode in one step.
  const cardSec = (c: Element) => (c.closest('.rail-section') as HTMLElement | null)?.dataset.testid?.replace('section-', '') as BulkSection | undefined;
  const cardId = (c: HTMLElement) => c.dataset.testid!.replace(/^[a-z]+-thumb-/, '');
  const onGridKey = (e: React.KeyboardEvent) => {
    if (!bulk) return;
    const c = (e.target as HTMLElement).closest?.('.card[data-testid]') as HTMLElement | null;
    const sec = c && cardSec(c);
    if (!c || !sec) return;
    const asset = lists[sec].find(a => a.id === cardId(c));
    if (!asset) return;
    if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); pick(asset, sec); return; }
    if (!/^Arrow(Left|Right|Up|Down)$/.test(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault(); e.stopPropagation();   // (stops the Preview's ← → stepping too)
    const sectionEl = c.closest('.rail-section')!;
    let next: HTMLElement | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const order = readingOrder(lists[sec], `section-${sec}`);
      const n = order[order.findIndex(a => a.id === asset.id) + (e.key === 'ArrowLeft' ? -1 : 1)];
      next = n ? sectionEl.querySelector<HTMLElement>(`.card[data-testid$="-thumb-${n.id}"]`) : null;
    } else {
      const r = c.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, down = e.key === 'ArrowDown';
      let best = Infinity;
      sectionEl.querySelectorAll<HTMLElement>('.card[data-testid]').forEach(o => {
        const q = o.getBoundingClientRect(), dy = (q.top + q.height / 2 - cy) * (down ? 1 : -1);
        if (dy <= 4) return;
        const score = dy + 2 * Math.abs(q.left + q.width / 2 - cx);   // straight below beats diagonal
        if (score < best) { best = score; next = o; }
      });
    }
    const to = next as HTMLElement | null;
    if (!to) return;
    to.focus(); to.scrollIntoView({ block: 'nearest' });
    if (e.shiftKey) {
      const from = bulk.section === sec && bulk.anchor ? bulk.anchor : asset.id, range = rangeIds(sec, from, cardId(to));
      setBulk(b => (!b || b.section !== sec ? { section: sec, ids: range, anchor: from, base: [] }
        : { ...b, anchor: from, base: b.anchor ? b.base : b.ids, ids: [...new Set([...(b.anchor ? b.base : b.ids), ...range])] }));
    }
  };
  const keyRef = useRef({ bulk, selectAll, clearBulk }); keyRef.current = { bulk, selectAll, clearBulk };
  const selecting = !!bulk;
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('.sheet-backdrop, .fp-app')) return;   // a dialog/sheet/full-page app owns the keys
      const { bulk: b, selectAll: all, clearBulk: clear } = keyRef.current;
      if (e.key === 'Escape') { e.preventDefault(); clear(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && b) {
        const c = document.activeElement?.closest?.('.card[data-testid]');
        e.preventDefault(); all((c && cardSec(c)) || b.section);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selecting]);   // eslint-disable-line react-hooks/exhaustive-deps
  // The bulk bar takes the header's exact height (measured while the header is showing).
  const hdrH = useRef(0);

  return (
    <div className="asset-rail" data-testid="asset-rail">
      {/* Tab bar (phones: only when a tool adds tabs) */}
      {(!phone || tabs.length > 1) && <div className="rail-tabs" data-testid="rail-tabs">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`rail-tab${validTab === tab.id ? ' active' : ''}`}
            onClick={() => onTabChange(tab.id)}
            data-testid={`tab-${tab.id}`}
          >
            {tab.label}
          </button>
        ))}
      </div>}

      {/* Phone: ONE header line — Library · state chip · search · View (Aurora v1.4) */}
      {phone && (
        <div className={`rail-phone-bar${searchOpen ? ' searching' : ''}${bulk ? ' bulk-phone' : ''}`} data-testid="rail-phone-bar">
          {bulk ? (<>
            {/* select mode: ✕ · 3 selected · Select all; the actions sit in App's bottom bar */}
            <button className="ctrl-btn" aria-label="Clear selection" onClick={clearBulk} data-testid="bulk-clear"><IconClose /></button>
            <span className="bulk-count" data-testid="bulk-count">{bulkAssets.length} selected</span>
            <button className="bulk-link" onClick={() => selectAll(bulk.section)} data-testid="bulk-select-all">Select all</button>
          </>) : searchOpen ? (<>
            <IconSearch className="rail-phone-search-ic" />
            <input type="search" className="rail-search" autoFocus placeholder="Search names & prompts" value={searchDraft}
              onChange={e => setSearchDraft(e.target.value)} data-testid="rail-search" />
            <button className="ctrl-btn" aria-label="Close search" onClick={() => { setSearchOpen(false); setSearchDraft(''); }}><IconClose /></button>
          </>) : (<>
            <span className="rail-phone-title">Library</span>
            <button className="rail-state-chip" data-testid="rail-state-chip" onClick={() => setViewOpen(true)}>
              {layoutLabel}{layout === 'row' ? '' : ` · ${sizeLabel}`} · {sortLabel}{query.q ? ` · “${query.q}”` : ''}</button>
            {filterChip}
            <button className="ctrl-btn" aria-label="Search" data-testid="rail-search-btn" onClick={() => setSearchOpen(true)}><IconSearch /></button>
            <button className="ctrl-btn" aria-label="View options" data-testid="rail-view-btn" onClick={() => setViewOpen(true)}><IconLayout /></button>
          </>)}
        </div>
      )}
      {phone && viewOpen && (
        <div className="sheet-backdrop" data-testid="view-sheet" onClick={e => { if (e.target === e.currentTarget) setViewOpen(false); }}>
          <div className="sheet view-sheet" role="dialog" aria-label="View options">
            <div className="sheet-title">Layout</div>
            <div className="view-seg">
              {(['fill', 'masonry', 'row'] as LayoutMode[]).map(m => (
                <button key={m} className={`view-opt${layout === m ? ' on' : ''}`} onClick={() => setLayout(m)}>{{ fill: 'Grid', masonry: 'Masonry', row: 'Row', fit: 'Fit' }[m]}</button>))}
            </div>
            <div className="sheet-title">Sort</div>
            <div className="view-seg">
              {(['newest', 'oldest', 'alpha'] as SortOrder[]).map(o => (
                <button key={o} className={`view-opt${sortOrder === o ? ' on' : ''}`} onClick={() => setSortOrder(() => o)}>{{ newest: 'Newest', oldest: 'Oldest', alpha: 'A–Z' }[o]}</button>))}
            </div>
            <button className="sheet-act" onClick={() => { setViewOpen(false); setFilterOpen(true); }}><IconFilter /> Filter{filtersOn ? ' (on)' : ''}</button>
            {layout !== 'row' && <div className="view-note">Tile size: pinch the grid (now {phoneCols} columns)</div>}
            <div className="sheet-title">Add</div>
            <div className="view-seg">
              <button className="view-opt" onClick={() => { setViewOpen(false); fileInputRef.current?.click(); }} disabled={uploading}><IconPlus /> Import</button>
              <button className="view-opt" onClick={() => { setViewOpen(false); onYtModalOpen(); }}>Ripper</button>
            </div>
            <button className="sheet-act sheet-cancel" onClick={() => setViewOpen(false)}>Done</button>
          </div>
        </div>
      )}

      {/* Import row */}
      <div className="rail-import-row">
        <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={e => { if (e.target.files?.[0]) handleUpload(e.target.files[0]); }} />
        <button className="import-btn" onClick={() => fileInputRef.current?.click()} disabled={uploading} data-testid="import-btn">
          {uploading ? 'Uploading…' : '+ Import'}
        </button>
        <button className="source-btn" onClick={onYtModalOpen} data-testid="youtube-btn">Ripper</button>
        <button className="source-btn" onClick={() => alert('URL sourcing — future')}>URL</button>
      </div>

      {/* All Assets header with filter/sort/thumb-size slider — in select mode the bulk bar replaces it */}
      {bulk && !phone ? (
        <BulkBar height={hdrH.current} assets={bulkAssets} section={bulk.section} favoriteIds={favoriteIds}
          onAct={act} onClear={clearBulk} onSelectAll={() => selectAll(bulk.section)} />
      ) : (
      <div className="rail-allassets-header" ref={el => { if (el && el.offsetHeight) hdrH.current = el.offsetHeight; }}>
        <span data-testid="all-assets-label">All Assets</span>
        <input
          type="search"
          className="rail-search"
          placeholder="Search names & prompts"
          value={searchDraft}
          onChange={e => setSearchDraft(e.target.value)}
          data-testid="rail-search"
        />
        <div className="rail-controls">
          <input
            type="range"
            min={THUMB_MIN}
            max={THUMB_MAX}
            step={4}
            value={thumbSize}
            onChange={e => setThumbSize(Number(e.target.value))}
            disabled={layout === 'row'}
            title={layout === 'row' ? 'Row cards are a fixed size' : `Column width: ${thumbSize}px`}
            data-testid="thumb-size-slider"
            className="thumb-size-slider"
          />
          {filterChip}
          <LayoutMenu value={layout} onChange={setLayout} />
          <button className={`ctrl-btn${filterOpen || filtersOn ? ' active' : ''}`} onClick={() => setFilterOpen(v => !v)} title="Filter" aria-label="Filter" data-testid="filter-btn"><IconFilter /></button>
          <button className="ctrl-btn" title="Sort" onClick={() => setSortOrder(s => s === 'newest' ? 'oldest' : s === 'oldest' ? 'alpha' : 'newest')} data-testid="sort-btn"><IconSort /> {sortOrder}</button>
          {onBulkChange && (
            <button className="ctrl-btn select-btn" onClick={() => setBulk(() => ({ section: 'library', ids: [], anchor: null, base: [] }))}
              title="Select several (or Ctrl/⌘-click a tile)" data-testid="select-btn"><IconCheckSquare /> Select</button>
          )}
        </div>
      </div>
      )}

      {/* Filter panel */}
      {filterOpen && (
        <div className="filter-panel" data-testid="filter-panel">
          <div className="filter-header">
            <span>Asset Filter</span>
            <button onClick={() => setFilterOpen(false)} aria-label="Close filters"><IconClose /></button>
          </div>
          <div className="filter-node">
            <div className="filter-parent">Type <span className="filter-hint">(none checked = all)</span></div>
            {facets?.categories.map(c => {
              const subs = (facets.subtypes || []).filter(s => s.category === c.category && s.subtype !== c.category);
              const on = query.categories.includes(c.category);
              const nSubs = on ? checkedSubs(query, c.category).length : 0;
              return (
                <div key={c.category}>
                  <label className="filter-child">
                    {/* tri-state: some (not all) of its subs checked */}
                    <input type="checkbox" checked={on} ref={el => { if (el) el.indeterminate = nSubs > 0 && nSubs < subs.length; }}
                      onChange={() => setQuery({ ...query, categories: toggleIn(query.categories, c.category),
                        subtypes: on ? query.subtypes.filter(k => !k.startsWith(c.category + '/')) : query.subtypes })} />
                    {' '}{typeName(c.category)} <span className="filter-count">{c.count}</span>
                  </label>
                  {/* sub-filters: only under a CHECKED type */}
                  {subs.length > 1 && on && subs.map(s => (
                    <label key={s.subtype} className="filter-child filter-sub" data-testid={`filter-sub-${s.subtype}`}>
                      <input type="checkbox" checked={query.subtypes.includes(subKey(c.category, s.subtype))}
                        onChange={() => setQuery({ ...query, subtypes: toggleIn(query.subtypes, subKey(c.category, s.subtype)) })} />
                      {' '}{s.subtype} <span className="filter-count">{s.count}</span>
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
          <div className="filter-node" data-testid="filter-sources">
            <div className="filter-parent">Source</div>
            {facets?.sources.map(src => (
              <label key={src.source} className="filter-child">
                <input type="checkbox" checked={!query.excludedSources.includes(src.source)}
                  onChange={() => setQuery({ ...query, excludedSources: toggleIn(query.excludedSources, src.source) })} />
                {' '}{src.source} <span className="filter-count">{src.count}</span>
              </label>
            ))}
          </div>
          {facets && facets.collections.length > 0 && (
            <div className="filter-node">
              <div className="filter-parent">Collections <span className="filter-hint">(packs show only when checked)</span></div>
              {facets.collections.map(c => (
                <label key={c.slug} className="filter-child">
                  <input type="checkbox" checked={query.collections.includes(c.slug)}
                    onChange={() => setQuery({ ...query, collections: toggleIn(query.collections, c.slug) })} />
                  {' '}{c.name} <span className="filter-count">{c.count}</span>
                </label>
              ))}
            </div>
          )}
          {filtersOn && (
            <button className="filter-reset" onClick={clearFilters}>Show everything</button>
          )}
        </div>
      )}

      {validTab === 'library' && (
        <div className={`rail-sections${bulk ? ' is-picking' : ''}`} data-testid="rail-sections" ref={sectionsRef} onKeyDown={onGridKey}>
          {phone && hint && (
            <div className="pinch-hint" data-testid="pinch-hint">Pinch the grid to resize tiles <button onClick={dismissHint}>OK</button></div>
          )}
          {phone && hud && <div className="pinch-hud" data-testid="pinch-hud">{hud}</div>}
          {loading && <div className="rail-loading">Loading…</div>}

          {/* Favorites section: pinned for easy reference; items stay in the library too.
              Hidden only when there are none — filtered away, it says so. */}
          {favoriteAssets.length > 0 && (
          <div className="rail-section" data-testid="section-favorites">
            <div className="section-toggle-row">
              <button className="section-toggle" onClick={() => setFavoritesOpen(v => !v)} data-testid="favorites-toggle">
                <IconChevronDown className={favoritesOpen ? 'chev' : 'chev closed'} /> Favorites <span className="section-count">{favShown.length}</span>
              </button>
              {onClearFavorites && <button className="section-clear" onClick={onClearFavorites} data-testid="favorites-clear">Clear</button>}
            </div>
            {favoritesOpen && (
              <LayoutGrid data-testid="favorites-grid" assets={favShown} layout={layout} size={gridSize} phone={phone}
                empty={hiddenNote(favoriteAssets.length, 'favorite', 'favorites')}
                render={(asset, w, h) => (
                  <Thumbnail
                    key={asset.id}
                    asset={asset}
                    selected={isSelected(asset.id)}
                    onToggle={handleToggle}
                    onView={a => onViewAsset(a, readingOrder(favShown, 'section-favorites'))}
                    {...pickProps('favorites', favShown, asset)}
                    thumbSize={gridSize} w={w} h={h} fit={fit}
                    favorite
                    previewed={asset.id === previewId}
                    layout={layout}
                    toolActive={toolActive}
                    data-testid={`fav-thumb-${asset.id}`}
                  />
                )} />
            )}
          </div>
          )}

          {/* Clipboard section */}
          <div className="rail-section" data-testid="section-clipboard">
            <button className="section-toggle" onClick={() => setClipboardOpen(v => !v)} data-testid="clipboard-toggle">
              <IconChevronDown className={clipboardOpen ? 'chev' : 'chev closed'} /> Clipboard
            </button>
            {clipboardOpen && (
              <LayoutGrid data-testid="clipboard-grid" assets={sortedClipboard} layout={layout} size={gridSize} phone={phone}
                empty={!loading && (clipboardAssets.length ? hiddenNote(clipboardAssets.length, 'clipboard item', 'clipboard items')
                  : <div className="section-empty">No clipboard items</div>)}
                render={(asset, w, h) => (
                  <Thumbnail
                    key={asset.id}
                    asset={asset}
                    selected={isSelected(asset.id)}
                    onToggle={handleToggle}
                    onView={a => onViewAsset(a, readingOrder(sortedClipboard, 'section-clipboard'))}
                    {...pickProps('clipboard', sortedClipboard, asset)}
                    thumbSize={gridSize} w={w} h={h} fit={fit}
                    favorite={!!favoriteIds?.has(asset.id)}
                    previewed={asset.id === previewId}
                    layout={layout}
                    toolActive={toolActive}
                    data-testid={`clip-thumb-${asset.id}`}
                  />
                )} />
            )}
          </div>

          {/* Recycle section */}
          <div className="rail-section" data-testid="section-recycle">
            <button className="section-toggle" onClick={() => setRecycleOpen(v => !v)} data-testid="recycle-toggle">
              <IconChevronDown className={recycleOpen ? 'chev' : 'chev closed'} /> Recycle
            </button>
            {recycleOpen && (
              <LayoutGrid assets={recycleShown} layout={layout} size={gridSize} phone={phone}
                empty={recycleAssets.length ? hiddenNote(recycleAssets.length, 'recycled item', 'recycled items')
                  : <div className="section-empty">Recycle bin empty</div>}
                render={(asset, w, h) => (
                  <Thumbnail
                    key={asset.id}
                    asset={asset}
                    thumbSize={gridSize} w={w} h={h} fit={fit}
                    favorite={!!favoriteIds?.has(asset.id)}
                    previewed={asset.id === previewId}
                    layout={layout}
                    onView={a => onViewAsset(a, readingOrder(recycleShown, 'section-recycle'))}
                    {...pickProps('recycle', recycleShown, asset)}
                    data-testid={`rec-thumb-${asset.id}`}
                    quickActions={
                      <>
                        <button className="qa-btn revive" onClick={e => { e.stopPropagation(); handleRevive(asset); }} title="Revive" aria-label="Revive"><IconReload /></button>
                        <button className="qa-btn trash" onClick={e => { e.stopPropagation(); handleTrashForever(asset); }} title="Delete forever" aria-label="Delete forever"><IconTrash /></button>
                      </>
                    }
                  />
                )} />
            )}
          </div>

          {/* Library section */}
          <div className="rail-section" data-testid="section-library">
            <button className="section-toggle" onClick={() => setLibraryOpen(v => !v)} data-testid="library-toggle">
              <IconChevronDown className={libraryOpen ? 'chev' : 'chev closed'} /> Library <span className="section-count" data-testid="library-count">{library.total.toLocaleString()}</span>
            </button>
            {libraryOpen && (
              <LayoutGrid data-testid="library-grid" assets={libraryAssets} layout={layout} size={gridSize} phone={phone}
                empty={!loading && <div className="section-empty">{query.q || filtersOn ? 'Nothing matches' : 'No library assets'}</div>}
                render={(asset, w, h) => (
                  <Thumbnail
                    key={asset.id}
                    asset={asset}
                    selected={isSelected(asset.id)}
                    onToggle={handleToggle}
                    onView={a => onViewAsset(a, readingOrder(libraryAssets, 'section-library'))}
                    {...pickProps('library', libraryAssets, asset)}
                    thumbSize={gridSize} w={w} h={h} fit={fit}
                    favorite={!!favoriteIds?.has(asset.id)}
                    previewed={asset.id === previewId}
                    layout={layout}
                    toolActive={toolActive}
                    data-testid={`lib-thumb-${asset.id}`}
                  />
                )} />
            )}
            {libraryOpen && <div ref={moreRef} className="section-more">{library.loadingMore ? 'Loading more…' : libraryAssets.length < library.total ? `${libraryAssets.length.toLocaleString()} of ${library.total.toLocaleString()}` : ''}</div>}
          </div>
        </div>
      )}

      {validTab === 'audio-compare' && (
        <div className="compare-tab" data-testid="compare-tab">
          <div className="compare-slots">
            <div className="compare-slot">
              <div className="compare-label">A — Source</div>
              {compareA ? (
                <div>
                  <div className="compare-asset-name" data-testid="compare-a-name">{assetLabel(compareA)}</div>
                  {compareA.duration_s != null && <div className="compare-dur">{fmtDur(compareA.duration_s)}</div>}
                  <audio controls src={`${LIB_BASE}/api/clip/${compareA.id}`} style={{ width: '100%' }} data-testid="compare-a-audio" />
                  <button className="compare-clear-btn" onClick={() => onSetCompareAB(null, compareB)}>Clear A</button>
                </div>
              ) : <div className="compare-empty" data-testid="compare-a-empty">No source selected</div>}
            </div>
            <div className="compare-slot">
              <div className="compare-label">B — Output</div>
              {compareB ? (
                <div>
                  <div className="compare-asset-name" data-testid="compare-b-name">{assetLabel(compareB)}</div>
                  {compareB.duration_s != null && <div className="compare-dur">{fmtDur(compareB.duration_s)}</div>}
                  <audio controls src={`${LIB_BASE}/api/clip/${compareB.id}`} style={{ width: '100%' }} data-testid="compare-b-audio" />
                  <button className="compare-clear-btn" onClick={() => onSetCompareAB(compareA, null)}>Clear B</button>
                </div>
              ) : <div className="compare-empty" data-testid="compare-b-empty">No output yet</div>}
            </div>
          </div>
          <div className="compare-note" data-testid="compare-isolation-note">
            Per-tab selection isolation: this A/B pair is independent of the Library tab
            selection and the tool's input slot. Switching back to Library does not change the tool's source.
          </div>
        </div>
      )}
    </div>
  );
}

// ── AssetViewer — right-column viewer, managed by App ──────────────────────

interface AssetViewerProps {
  asset: Asset;
  onClose: () => void;
  onTrash: (a: Asset) => void;
  onDownload: (a: Asset) => void;
  onSave?: (a: Asset) => void;
  onViewAsset: (a: Asset) => void;
  onUseRecipe?: (a: Asset) => void;
  refresh: () => void;
  backTo?: Asset | null;        // the image we came from via a parent/reference link
  onBack?: () => void;
  onUseAsRef?: (a: Asset) => void;                          // image tool open: add as a reference
  step?: { pos: number; total: number; onStep: (d: -1 | 1) => void } | null;   // ‹ › through the list it was opened from
  isFavorite?: boolean;
  onToggleFavorite?: (a: Asset) => void;
  onRate?: (a: Asset, dir: 1 | -1) => void;
  onEditClip?: (a: Asset) => void;   // open the Clip Editor full-page app
  onOpenModelStudio?: (a: Asset) => void;   // open Model Studio on this mesh
}

// A clip made by the editor re-opens on its PARENT with its own segments ("Edit again").
export function clipEditTarget(a: Asset): { edit: string; from: string | null } {
  const op = typeof a.derived_op === 'string' ? null : a.derived_op;
  return op?.tool === 'clip-editor' && a.parent_id ? { edit: a.parent_id, from: a.id } : { edit: a.id, from: null };
}
function clipEditorHref(a: Asset): string {
  const t = clipEditTarget(a);
  return `${LIB_BASE}/?app=clip-editor&edit=${t.edit}${t.from ? `&from=${t.from}` : ''}`;
}

// Copy that works over plain HTTP. navigator.clipboard only exists in a secure context
// (HTTPS / localhost); on http://localhost it is undefined and a bare writeText does
// nothing, silently. Same ladder as Aurora's cfCopy (hwb-copy.js) and Importer's browse page:
// async API → selected textarea + execCommand('copy') → caller selects the text for Ctrl+C.
async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

function selectText(el: HTMLElement | null) {
  if (!el) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function parseMeta(m: Asset['meta']): Record<string, unknown> {
  if (!m) return {};
  if (typeof m === 'string') { try { return JSON.parse(m); } catch { return {}; } }
  return m as Record<string, unknown>;
}

export function AssetViewer({ asset, onClose, onTrash, onDownload, onSave, onViewAsset, onUseRecipe, refresh, backTo, onBack, onUseAsRef, step, isFavorite, onToggleFavorite, onRate, onEditClip, onOpenModelStudio }: AssetViewerProps) {
  // Image swipe with an axis lock (Aurora S1–S9): decide the direction once at 8px; a horizontal
  // gesture blocks page scroll (non-passive touchmove) and the image follows the finger; vertical
  // gestures scroll natively and never step. The left 24px edge belongs to swipe-back (App).
  const stepRef = useRef(step); stepRef.current = step;
  // ← / → step through the previews, unless you're typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (document.querySelector('.fp-app')) return;   // a full-page app is open over the library
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const st = stepRef.current;
      if (!st || st.total < 2) return;
      const d = e.key === 'ArrowLeft' ? -1 : 1;
      if ((d < 0 && st.pos <= 1) || (d > 0 && st.pos >= st.total)) return;
      e.preventDefault(); st.onStep(d);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const stageRef = useRef<HTMLDivElement>(null);
  const slideRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stageRef.current, sl = slideRef.current;
    if (!el || !sl) return;
    let g: { x0: number; y0: number; t0: number; axis: 'x' | 'y' | null; dx: number } | null = null;
    const anim = (on: boolean) => { sl.style.transition = on ? 'transform 180ms cubic-bezier(.2,.7,.2,1)' : 'none'; };
    const snapBack = () => { anim(true); sl.style.transform = ''; g = null; };
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      g = e.touches.length === 1 && stepRef.current && stepRef.current.total > 1 && t.clientX >= 24 && !gestureBusy()
        ? { x0: t.clientX, y0: t.clientY, t0: performance.now(), axis: null, dx: 0 } : null;
    };
    const onMove = (e: TouchEvent) => {
      if (!g) return;
      if (e.touches.length !== 1) { snapBack(); return; }
      const t = e.touches[0], dx = t.clientX - g.x0, dy = t.clientY - g.y0;
      if (!g.axis) {
        if (Math.hypot(dx, dy) < 8) return;                           // S3 dead zone
        g.axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y';        // S4 decide once
        if (g.axis === 'y') { g = null; return; }                      // S5 vertical: native scroll
      }
      if (e.cancelable) e.preventDefault();                            // S6 horizontal: page can't scroll
      g.dx = dx;
      const st = stepRef.current!, atEnd = (dx > 0 && st.pos <= 1) || (dx < 0 && st.pos >= st.total);
      anim(false); sl.style.transform = `translateX(${atEnd ? dx * 0.35 : dx}px)`;
    };
    const onEnd = () => {
      if (!g || g.axis !== 'x') { g = null; return; }
      const { dx, t0 } = g; g = null;
      const st = stepRef.current, dir: 1 | -1 = dx < 0 ? 1 : -1;
      const v = Math.abs(dx) / Math.max(performance.now() - t0, 1);
      const has = !!st && (dir > 0 ? st.pos < st.total : st.pos > 1);
      if (!st || !has || !(Math.abs(dx) >= 50 || (v >= 0.35 && Math.abs(dx) >= 20))) { snapBack(); return; }   // S7
      anim(true); sl.style.transform = `translateX(${dir > 0 ? -100 : 100}%)`;                                    // S8
      setTimeout(() => {
        st.onStep(dir);
        anim(false); sl.style.transform = `translateX(${dir > 0 ? 30 : -30}%)`;
        requestAnimationFrame(() => requestAnimationFrame(() => { anim(true); sl.style.transform = ''; }));
      }, 180);
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', snapBack, { passive: true });
    return () => { el.removeEventListener('touchstart', onStart); el.removeEventListener('touchmove', onMove); el.removeEventListener('touchend', onEnd); el.removeEventListener('touchcancel', snapBack); };
  }, [asset.id, asset.category]);   // re-attach when the stage appears (images only)
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [videoModalOpen, setVideoModalOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [labelDraft, setLabelDraft] = useState('');
  const [refTextDraft, setRefTextDraft] = useState('');
  const [notesDraft, setNotesDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [parentAsset, setParentAsset] = useState<Asset | null>(null);
  const [parentLoading, setParentLoading] = useState(false);
  // Local override: after a save, show the freshly-fetched asset instead of the stale prop
  const [localAsset, setLocalAsset] = useState<Asset | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const [idCopied, setIdCopied] = useState(false);
  const promptRef = useRef<HTMLDivElement>(null);

  const displayAsset = localAsset ?? asset;
  const meta = parseMeta(displayAsset.meta);
  const classInfo = assetClassInfo(displayAsset);
  const isVoice = displayAsset.subtype === 'voice';
  const assetLabel = displayAsset.label || displayAsset.filename || 'asset ' + displayAsset.id.slice(0, 8);
  const assetParentId = displayAsset.parent_id ?? null;

  // Reset local override and edit mode when the viewed asset changes
  useEffect(() => {
    setLocalAsset(null);
    setEditMode(false);
    setVideoModalOpen(false);
    setParentAsset(null);
    if (!asset.parent_id) { setParentLoading(false); return; }
    let cancelled = false;
    setParentLoading(true);
    fetch(`${LIB_BASE}/api/assets/${asset.parent_id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (!cancelled) { setParentAsset(data); setParentLoading(false); } })
      .catch(() => { if (!cancelled) setParentLoading(false); });
    return () => { cancelled = true; };
  }, [asset.id, asset.parent_id]);

  // Image-gen outputs keep their reference images in the recipe (derived_op.refs, main first).
  const genRefIds: string[] = (() => {
    const op = asset.derived_op && typeof asset.derived_op === 'object' ? asset.derived_op as { tool?: string; refs?: string[] } : null;
    return op?.tool === 'image-gen' && Array.isArray(op.refs) ? op.refs : [];
  })();
  const genRefKey = genRefIds.join(',');
  const [refAssets, setRefAssets] = useState<(Asset | null)[]>([]);
  useEffect(() => {
    if (!genRefKey) { setRefAssets([]); return; }
    let live = true;
    Promise.all(genRefKey.split(',').map(id => fetch(`${LIB_BASE}/api/assets/${id}`).then(r => (r.ok ? r.json() : null)).catch(() => null)))
      .then(as => { if (live) setRefAssets(as); });
    return () => { live = false; };
  }, [genRefKey]);

  const enterEdit = () => {
    setLabelDraft(assetLabel);
    setRefTextDraft(String(meta.ref_text ?? ''));
    setNotesDraft(String(meta.notes ?? ''));
    setEditMode(true);
  };

  const cancelEdit = () => setEditMode(false);

  const commitEdit = async () => {
    setSaving(true);
    try {
      const currentMeta = parseMeta(displayAsset.meta);
      const body: Record<string, unknown> = {};
      if (labelDraft !== assetLabel) body.label = labelDraft;
      const metaPatch: Record<string, string> = {};
      if (isVoice && refTextDraft !== String(currentMeta.ref_text ?? '')) metaPatch.ref_text = refTextDraft;
      if (notesDraft !== String(currentMeta.notes ?? '')) metaPatch.notes = notesDraft;
      if (Object.keys(metaPatch).length) body.meta = metaPatch;
      if (Object.keys(body).length > 0) {
        await fetch(`${LIB_BASE}/api/assets/${displayAsset.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        // Re-fetch the saved asset so the viewer title updates immediately without reopening
        const updated = await fetch(`${LIB_BASE}/api/assets/${displayAsset.id}`);
        if (updated.ok) setLocalAsset(await updated.json());
        refresh();
      }
      setEditMode(false);
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) { el.pause(); setPlaying(false); }
    else { el.play(); setPlaying(true); }
  };

  return (
    <div className="viewer-col" data-testid="viewer-col">
      {/* Toolbar */}
      <div className="av-toolbar" data-testid="av-toolbar">
        <span
          className={`av-toolbar-title${classInfo.subName ? '' : ' av-classonly'}`}
          data-testid="av-toolbar-title"
          style={{ ['--av-accent' as string]: classInfo.accent }}
          title={classInfo.subName ? `${classInfo.className} · ${classInfo.subName}` : classInfo.className}
        >
          <span className="av-class">{classInfo.className}</span>
          {classInfo.subName && (
            <>
              <span className="av-sep">·</span>
              <span className="av-sub">{classInfo.subName}</span>
            </>
          )}
        </span>
        <div className="av-toolbar-actions">
          {!editMode && onToggleFavorite && (
            <button className={`av-tbtn av-fav${isFavorite ? ' on' : ''}`} data-testid="av-fav" onClick={() => onToggleFavorite(displayAsset)}
              title={isFavorite ? 'Remove from favorites' : 'Add to favorites'} aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'} aria-pressed={!!isFavorite}>
              {isFavorite ? <IconStarFilled /> : <IconStar />}</button>
          )}
          {editMode ? (
            <>
              <button className="av-tbtn av-tbtn-save" onClick={commitEdit} disabled={saving} title="Save edits" aria-label="Save edits"><IconCheck /></button>
              <button className="av-tbtn" onClick={cancelEdit} title="Cancel edit" aria-label="Cancel edit"><IconClose /></button>
            </>
          ) : (
            <button className="av-tbtn" onClick={enterEdit} title="Edit" aria-label="Edit"><IconEdit /></button>
          )}
          {!editMode && displayAsset.category === 'audio' && (
            <a className="av-tbtn" href={clipEditorHref(displayAsset)} onClick={e => { if (onEditClip && !(e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) { e.preventDefault(); onEditClip(displayAsset); } }} title="Cut & edit in the Clip Editor" data-testid="av-clip-edit" aria-label="Cut & edit in the Clip Editor"><IconScissors /></a>
          )}
          {!editMode && displayAsset.category === 'mesh' && (
            <a className="av-tbtn" href={`${LIB_BASE}/?app=model-studio&edit=${displayAsset.id}`} onClick={e => { if (onOpenModelStudio && !(e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) { e.preventDefault(); onOpenModelStudio(displayAsset); } }} title="Open in Model Studio (rig, decimate, convert)" data-testid="av-model-studio" aria-label="Open in Model Studio"><IconCube /></a>
          )}
          {!editMode && displayAsset.transient && onSave && (
            <button className="av-tbtn av-tbtn-save" onClick={() => onSave(displayAsset)} title="Save to Library"><IconCheck /> Save</button>
          )}
          {/* Copy the asset id — the reference to hand an agent ("look at <asset-id>"), like a KB doc id. */}
          <button className="av-tbtn" data-testid="av-copy-id" onClick={async () => {
            const ok = await copyText(displayAsset.id);
            if (!ok) window.prompt('Image id — press Ctrl+C to copy', displayAsset.id);
            setIdCopied(ok);
            if (ok) setTimeout(() => setIdCopied(false), 1500);
          }} title={idCopied ? 'Copied' : `Copy image id (${displayAsset.id.slice(0, 8)}…)`} aria-label="Copy image id">
            {idCopied ? <IconCheck /> : <IconLink />}</button>
          <a
            href={`${LIB_BASE}/api/clip/${displayAsset.id}`}
            download={displayAsset.filename || displayAsset.id}
            className="av-tbtn"
            onClick={() => onDownload(displayAsset)}
            title="Download"
            aria-label="Download"
          ><IconDownload /></a>
          <button className="av-tbtn av-tbtn-danger" onClick={() => onTrash(displayAsset)} title="Trash" aria-label="Move to Recycle"><IconTrash /></button>
          <button className="av-tbtn av-close" onClick={onClose} title="Close viewer" aria-label="Close viewer"><IconClose /></button>
        </div>
      </div>

      {/* ‹ n / N › right under the toolbar: a fixed spot, so browsing with it never has to chase the
          buttons as image heights change. ← / → keys do the same. */}
      {step && step.total > 1 && (
        <div className="av-stepbar" data-testid="av-stepbar">
          <button className="av-step" data-testid="av-step-prev" aria-label="Previous" title="Previous (←)" disabled={step.pos <= 1} onClick={() => step.onStep(-1)}><IconChevronLeft /></button>
          <span className="av-step-count" data-testid="av-step-count">{step.pos} / {step.total}</span>
          <button className="av-step" data-testid="av-step-next" aria-label="Next" title="Next (→)" disabled={step.pos >= step.total} onClick={() => step.onStep(1)}><IconChevronRight /></button>
        </div>
      )}

      {backTo && onBack && (
        <button className="av-back" onClick={onBack} data-testid="av-back" title="Back to the image you came from">
          <span aria-hidden="true">←</span> Back to <span className="av-back-label">{backTo.label || backTo.filename || backTo.id.slice(0, 8)}</span>
        </button>
      )}

      {/* Body */}
      <div className="av-body">
        {/* Title */}
        <div className="av-field">
          {editMode ? (
            <input
              className="av-input"
              value={labelDraft}
              onChange={e => setLabelDraft(e.target.value)}
              placeholder="Asset label"
              data-testid="av-label-input"
            />
          ) : (
            <div className="av-label-display" data-testid="av-label-display">{assetLabel}</div>
          )}
        </div>

        {/* Notes (): free text the user or an agent adds — rankings, quality issues. */}
        {(editMode || String(meta.notes ?? '').trim()) && (
          <div className="av-field" data-testid="av-notes">
            <div className="av-field-label">Notes</div>
            {editMode ? (
              <textarea className="av-textarea av-notes-input" value={notesDraft} onChange={e => setNotesDraft(e.target.value)} rows={4} maxLength={4000}
                placeholder="Ranking, quality issues, what was tried…" data-testid="av-notes-input" />
            ) : (
              <div className="av-reftext-display av-notes" data-testid="av-notes-display">{String(meta.notes)}</div>
            )}
          </div>
        )}

        {/* Reference images of a generation (the first is also its parent) */}
        {genRefIds.length > 0 && (
          <div className="av-field" data-testid="av-refs">
            <div className="av-field-label">Reference images</div>
            <div className="av-refs">
              {genRefIds.map((id, i) => {
                const ra = refAssets[i];
                return (
                  <button key={id} className="av-ref" disabled={!ra} data-testid={`av-ref-${i}`}
                    title={ra ? `${ra.label || ra.filename || id} — open` : 'reference no longer in the library'}
                    onClick={() => ra && onViewAsset(ra)}>
                    <img src={`${LIB_BASE}/api/assets/${id}/thumb`} alt="" loading="lazy" />
                    <span className="av-ref-tag">{i === 0 ? 'Main' : 'Inject'}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Parent link */}
        {assetParentId && genRefIds.length === 0 && (
          <div className="av-parent-row" data-testid="av-parent-row">
            <span className="av-parent-prefix">Source/Parent: </span>
            {parentLoading ? (
              <span className="av-parent-loading">loading…</span>
            ) : parentAsset ? (
              <button
                className="av-parent-link"
                onClick={() => onViewAsset(parentAsset)}
                data-testid="av-parent-link"
              >
                {parentAsset.label || parentAsset.filename || parentAsset.id.slice(0, 8)}
              </button>
            ) : (
              <span className="av-parent-id">{assetParentId.slice(0, 8)}…</span>
            )}
          </div>
        )}

        {/* Voice player */}
        {isVoice && (() => {
          const audioRef2 = meta.audio_ref as string | undefined;
          return audioRef2
            ? <VoicePlayer audioRef={audioRef2} refText={meta.ref_text as string | undefined} />
            : null;
        })()}

        {/* Video: show the middle-frame thumbnail with a ▶ overlay; click → play in a modal. */}
        {displayAsset.category === 'video' && (
          <div
            className="av-video-poster"
            data-testid="av-video-poster"
            onClick={() => setVideoModalOpen(true)}
            title="Play video"
            style={{
              position: 'relative', width: '100%', aspectRatio: '16/9', borderRadius: 8,
              overflow: 'hidden', background: '#000', cursor: 'pointer', marginBottom: '0.75rem',
              backgroundImage: `url(${LIB_BASE}/api/assets/${displayAsset.id}/thumb)`,
              backgroundSize: 'cover', backgroundPosition: 'center',
            }}
          >
            <div style={{
              position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
              width: 54, height: 54, borderRadius: '50%', background: 'rgba(0,0,0,0.55)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <div style={{
                width: 0, height: 0, borderStyle: 'solid', marginLeft: 4,
                borderWidth: '11px 0 11px 18px',
                borderColor: 'transparent transparent transparent #fff',
              }} />
            </div>
          </div>
        )}

        {/* Image: the full file, click to open at full size in a new tab. */}
        {displayAsset.category === 'image' && (
          <div className="av-stage" ref={stageRef}>
          <div className="av-slide" ref={slideRef}>
          <a href={`${LIB_BASE}/api/assets/${displayAsset.id}/file`} target="_blank" rel="noreferrer" title="Open full size">
              <img className="av-image" data-testid="av-image" alt={assetLabel}
                onDragStart={e => e.dataTransfer.setData('application/x-asset-id', displayAsset.id)}
                src={`${LIB_BASE}/api/assets/${displayAsset.id}/${WEB_IMAGE.test(displayAsset.filename || '') ? 'file' : 'thumb'}`}
                style={{ width: '100%', borderRadius: 8, display: 'block', marginBottom: '0.75rem', background: svgBackdrop(displayAsset) ?? '#000' }} />
            </a>
          </div>
          </div>
        )}
        {/* Under the image: ▲ score ▼. */}
        {displayAsset.category === 'image' && onRate && (
          <div className="av-under" data-testid="av-under">
            {onRate && (
              <div className="av-rate" data-testid="av-rate">
                <button className={`av-vote up${displayAsset.rating === 1 ? ' on' : ''}`} data-testid="av-vote-up" aria-label="Upvote" aria-pressed={displayAsset.rating === 1} onClick={() => onRate(displayAsset, 1)}><IconArrowUp /></button>
                <span className="av-score" data-testid="av-score">{displayAsset.score ?? 0}</span>
                <button className={`av-vote down${displayAsset.rating === -1 ? ' on' : ''}`} data-testid="av-vote-down" aria-label="Downvote" aria-pressed={displayAsset.rating === -1} onClick={() => onRate(displayAsset, -1)}><IconArrowDown /></button>
              </div>
            )}
          </div>
        )}

        {/* Reload parameters (our generations) / Re-use prompt (imports) → the image tool. */}
        {onUseRecipe && displayAsset.category === 'image' && typeof meta.prompt === 'string' && (
          <button className="av-recipe-btn" data-testid="av-use-recipe" onClick={() => onUseRecipe(displayAsset)}>
            {displayAsset.source === 'midjourney' || !(displayAsset.derived_op && typeof displayAsset.derived_op === 'object' && (displayAsset.derived_op as { tool?: string }).tool === 'image-gen')
              ? <><IconReload /> Re-use prompt</> : <><IconReload /> Reload parameters</>}
          </button>
        )}

        {onUseAsRef && (
          <button className="av-recipe-btn av-useref-btn" data-testid="av-use-as-ref" onClick={() => onUseAsRef(displayAsset)}><IconPlus /> Use as reference</button>
        )}

        {/* Generation prompt (e.g. Midjourney imports) — kept so it can be re-run on a newer model. */}
        {typeof meta.prompt === 'string' && (
          <div className="av-field" data-testid="av-prompt">
            <div className="av-field-label">
              Prompt{' '}
              <button className="av-copy" data-testid="av-prompt-copy" onClick={async () => {
                const ok = await copyText(String(meta.prompt));
                if (!ok) selectText(promptRef.current);   // last resort: selected, Ctrl+C works
                setCopyState(ok ? 'copied' : 'manual');
                setTimeout(() => setCopyState('idle'), ok ? 1500 : 4000);
              }}>{copyState === 'copied' ? <><IconCheck /> Copied</> : copyState === 'manual' ? 'Selected — press Ctrl+C' : <><IconCopy /> Copy</>}</button>
            </div>
            <div ref={promptRef} className="av-reftext-display av-prompt">{String(meta.prompt)}</div>
          </div>
        )}

        {/* Audio player for non-voice audio (NOT video/image — they have a .format codec too, so guard it) */}
        {/* 3D mesh: the in-app viewer (orbit, animations, shape keys); other formats get the download. */}
        {displayAsset.category === 'mesh' && MESH_VIEWABLE.includes((displayAsset.format || '').toLowerCase()) && (
          <Suspense fallback={<div className="av-reftext-display">Loading the 3D viewer…</div>}>
            <MeshViewer key={displayAsset.id} asset={displayAsset} />
          </Suspense>
        )}
        {displayAsset.category === 'mesh' && !MESH_VIEWABLE.includes((displayAsset.format || '').toLowerCase()) && (
          <div className="av-field" data-testid="av-mesh">
            <div className="av-field-label">3D mesh</div>
            <div className="av-reftext-display">{(displayAsset.format || 'mesh').toUpperCase()} · no in-app preview for this format — open it in Blender (download above).</div>
          </div>
        )}
        {!isVoice && displayAsset.category !== 'video' && displayAsset.category !== 'image' && displayAsset.category !== 'mesh' && (displayAsset.category === 'audio' || displayAsset.format) && (
          <div className="av-player">
            <audio ref={audioRef} src={`${LIB_BASE}/api/clip/${displayAsset.id}`} onEnded={() => setPlaying(false)} />
            <button className="av-play" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>{playing ? <IconPause /> : <IconPlay />}</button>
          </div>
        )}

        {/* Voice ref_text */}
        {isVoice && (
          <div className="av-field">
            <div className="av-field-label">Transcript</div>
            {editMode ? (
              <textarea
                className="av-textarea"
                value={refTextDraft}
                onChange={e => setRefTextDraft(e.target.value)}
                rows={4}
                placeholder="Reference text / transcript"
                data-testid="av-reftext-input"
              />
            ) : (
              <div className="av-reftext-display" data-testid="av-reftext-display">
                {String(meta.ref_text ?? '') || <span className="av-reftext-empty">(no transcript)</span>}
              </div>
            )}
          </div>
        )}

        {/* Stats */}
        <div className="av-stats">
          {displayAsset.duration_s != null && displayAsset.category !== 'image' && <div>Duration: {fmtDur(displayAsset.duration_s)}</div>}
          {displayAsset.format && <div>Format: {displayAsset.format}</div>}
          {displayAsset.sample_rate && <div>Sample rate: {displayAsset.sample_rate} Hz</div>}
          {displayAsset.bytes != null && <div>File: {Math.round(displayAsset.bytes / 1024)} KB</div>}
          {typeof meta.width === 'number' && <div>Size: {String(meta.width)}×{String(meta.height)}</div>}
          {displayAsset.source && <div>Source: {displayAsset.source}</div>}
          {(() => {
            // Made by an agent in a briefing-table room (image-gen origin, task), else by a named agent.
            const o = meta.origin as { room_name?: string; room_id?: string; agent?: string; app?: string } | undefined;
            if (o?.room_id) return <div data-testid="av-origin">Made by: {o.agent ? `@${o.agent}` : 'an agent'} in room “{o.room_name || o.room_id.slice(0, 8)}”{o.app ? ` (${o.app})` : ''}</div>;
            const by = meta.generated_by;
            return typeof by === 'string' && by !== 'user' ? <div data-testid="av-origin">Made by: {by}</div> : null;
          })()}
          {displayAsset.origin_created_at && <div>Created: {new Date(displayAsset.origin_created_at).toLocaleString()}</div>}
          {displayAsset.collection && <div>Imported: {new Date(displayAsset.created_at ?? '').toLocaleDateString()} ({displayAsset.collection})</div>}
        </div>
      </div>

      {/* Video playback modal — opened from the poster; plays the raw file (ranged/seekable). */}
      {videoModalOpen && displayAsset.category === 'video' && (
        <div
          className="av-video-modal-backdrop"
          data-testid="av-video-modal"
          onClick={e => { if (e.target === e.currentTarget) setVideoModalOpen(false); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 2000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem',
          }}
        >
          <div style={{ position: 'relative', width: 'min(90vw, 1280px)', maxHeight: '90vh' }}>
            <button
              onClick={() => setVideoModalOpen(false)}
              data-testid="av-video-modal-close"
              title="Close"
              style={{
                position: 'absolute', top: -14, right: -14, zIndex: 1, width: 32, height: 32,
                borderRadius: '50%', border: 'none', background: '#222', color: '#fff',
                fontSize: 18, cursor: 'pointer', lineHeight: 1,
              }}
              aria-label="Close video"
            ><IconClose /></button>
            <video
              controls
              autoPlay
              src={`${LIB_BASE}/api/assets/${displayAsset.id}/file`}
              style={{ width: '100%', maxHeight: '90vh', borderRadius: 8, background: '#000', display: 'block' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
