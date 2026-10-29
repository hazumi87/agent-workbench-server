import { useState, useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import { IconChevronLeft, IconClose, IconCube, IconImage, IconLibrary, IconMenu, IconScissors, IconSparkle, IconStar, IconStarFilled } from './icons';
import type { AssetCategory, Asset, ToolDeclaration } from './types';
import { useLibraryData } from './hooks/useLibraryData';
import { useToolSelection } from './hooks/useToolSelection';
import { AssetRail, AssetViewer, clipEditTarget } from './components/AssetRail';
import { BulkActions, canSave, runPool, type BulkKind, type BulkSel } from './components/BulkBar';
import { ClipEditorApp } from './clip-editor/ClipEditorApp';
import { leaveApp, openApp, readRoute, refocusOpener, savedSnapshot, takeDraftSaved, useAppRoute, type LibSnapshot } from './shell/appRoute';
import type { LibraryQuery } from './hooks/useLibraryData';
// Model Studio: a full-page app like the Clip Editor, loaded on first open.
const ModelStudioApp = lazy(() => import('./model-studio/ModelStudioApp'));
type FullPageApp = 'clip-editor' | 'model-studio';
const FULL_PAGE_APPS: string[] = ['clip-editor', 'model-studio'];
import { CategoryCards } from './components/CategoryCards';
import { VoiceFilterTool } from './components/VoiceFilterTool';
import { DemucsTool } from './components/DemucsTool';
import { AudioNormalizeTool } from './components/AudioNormalizeTool';
import { VoiceRegisterTool } from './components/VoiceRegisterTool';
import { RideVideoTool } from './components/RideVideoTool';
import { ImageGenTool, type Recipe, type QueueStatus, type RefRequest } from './components/ImageGenTool';
import { IMAGE_GEN_TOOL } from './toolRegistry';
import { TOOL_REGISTRY } from './toolRegistry';

const LIB_BASE = '/asset-management/library';

// ── Audio/Video Ripper sourcing modal ───────────────────────────────────────
function YtAudioModal({ mode = 'audio', onClose, onRipComplete }: { mode?: 'audio' | 'video'; onClose: () => void; onRipComplete: () => void }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      if (ev.data?.type === 'yt-audio:rip-complete') onRipComplete();
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onRipComplete]);
  const isVideo = mode === 'video';
  const src = `/asset-management/tools/yt-audio/?context=shell${isVideo ? '&mode=video' : ''}`;
  return (
    <div className="modal-backdrop" data-testid="yt-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-window" data-testid="yt-modal">
        <div className="modal-header">
          <span>{isVideo ? 'Video Ripper' : 'Audio Ripper'}</span>
          <button className="modal-close" onClick={onClose} data-testid="yt-modal-close" aria-label="Close"><IconClose /></button>
        </div>
        <iframe ref={iframeRef} src={src}
          className="modal-iframe" data-testid="yt-modal-iframe" title={isVideo ? 'Video Ripper' : 'Audio Ripper'} allow="autoplay" />
      </div>
    </div>
  );
}

// ── Catalog overlay panel ───────────────────────────────────────────────────
const CATALOG_GROUPS = [
  {
    label: 'Import',
    items: [
      { id: '_file-import', label: 'File Import', class: 'sourcing' as const },
      { id: '_youtube',    label: 'Audio Ripper', class: 'sourcing' as const },
      { id: '_image-scrape', label: 'Image Scrape', class: 'sourcing' as const },
    ],
  },
  { label: 'Image Tools', items: TOOL_REGISTRY.filter(t => t.category === 'image' && t.class === 'transform') },
  { label: 'Mesh Tools',  items: [{ id: '_model-studio', label: 'Model Studio', class: 'app' as const }] as { id: string; label: string; class?: string }[] },   // full-page app
  {
    label: 'Video Tools',
    items: [
      { id: '_youtube-video', label: 'Video Ripper', class: 'sourcing' as const },
      ...TOOL_REGISTRY.filter(t => t.category === 'video' && t.class === 'transform'),
    ],
  },
  {
    label: 'Audio Tools',
    items: [
      { id: '_clip-editor', label: 'Clip Editor', class: 'app' as const },   // full-page app
      ...TOOL_REGISTRY.filter(t => t.category === 'audio' && (t.class === 'transform' || t.class === 'sourcing')),
    ],
  },
  { label: 'Voice Tools', items: TOOL_REGISTRY.filter(t => t.category === 'voice') },
  { label: 'Etc.',        items: [] as { id: string; label: string; class?: string }[] },
];

interface CatalogOverlayProps {
  activeCategory: AssetCategory | null;
  onToolSelect: (t: ToolDeclaration) => void;
  onYtModalOpen: (mode?: 'audio' | 'video') => void;
  onOpenApp: (id: FullPageApp) => void;
  onClose: () => void;
}
function CatalogOverlay({ activeCategory, onToolSelect, onYtModalOpen, onOpenApp, onClose }: CatalogOverlayProps) {
  return (
    <div className="catalog-overlay-backdrop" data-testid="catalog-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="catalog-overlay-panel" data-testid="catalog-panel">
        <div className="catalog-overlay-header">
          <span className="catalog-title">Asset Tools</span>
          <button className="catalog-close-btn" onClick={onClose} aria-label="Close catalog"><IconClose /></button>
        </div>
        {CATALOG_GROUPS.map(group => (
          <div key={group.label} className="catalog-group">
            <div className="catalog-group-label">{group.label}</div>
            {group.items.length === 0 && (
              <div className="catalog-item empty">[…{group.label.toLowerCase()}]</div>
            )}
            {group.items.map(item => (
              <button
                key={item.id}
                className={`catalog-item${activeCategory && 'category' in item && (item as ToolDeclaration).category !== activeCategory ? ' dimmed' : ''}`}
                data-testid={
                  item.id === '_youtube-video' ? 'catalog-youtube-video' :
                  item.id === '_youtube' ? 'catalog-youtube' :
                  item.id === '_file-import' ? 'catalog-file-import' :
                  `catalog-${item.id}`
                }
                onClick={() => {
                  if (item.id === '_clip-editor') { onOpenApp('clip-editor'); onClose(); return; }
                  if (item.id === '_model-studio') { onOpenApp('model-studio'); onClose(); return; }
                  if (item.id === '_youtube-video') {
                    onYtModalOpen('video'); onClose(); return;
                  }
                  if (item.id === '_youtube' || (item.class === 'sourcing' && (item as ToolDeclaration).id === 'yt-audio')) {
                    onYtModalOpen('audio'); onClose(); return;
                  }
                  if (item.class === 'transform') {
                    onToolSelect(item as ToolDeclaration); return;
                  }
                }}
              >
                {item.id === '_clip-editor' ? <><IconScissors className="catalog-glyph" />{item.label}<small className="catalog-mark">full-page</small></>
                  : item.id === '_model-studio' ? <><IconCube className="catalog-glyph" />{item.label}<small className="catalog-mark">full-page</small></> : item.label}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tool workspace (left column content) ───────────────────────────────────
interface ToolWorkspaceProps {
  tool: ToolDeclaration;
  selectedAssets: Asset[];
  onDeselectSlot: (i: number) => void;
  onSubmit: () => void;
  submitting: boolean;
  onProcessDone: (src: Asset, out: Asset | null) => void;
  onGenerated: () => void;
  onViewAsset: (a: Asset, list?: Asset[]) => void;
  recipe: Recipe | null;
  onQueueStatus?: (s: QueueStatus) => void;
  refRequest?: RefRequest | null;
  ratingsVersion?: number;
  onShowAsset?: (a: Asset) => void;   // show in the Preview without leaving the tool (phone stays on Tool)
}
function fmtDur(s: number | null | undefined) {
  if (s == null || isNaN(s)) return '';
  return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}
function assetLabel(a: Asset) { return a.label || a.filename || 'asset ' + a.id.slice(0, 8); }

function ToolWorkspace({ tool, selectedAssets, onDeselectSlot, onSubmit, submitting, onProcessDone, onGenerated, onViewAsset, recipe, onQueueStatus, refRequest, ratingsVersion, onShowAsset }: ToolWorkspaceProps) {
  if (tool.id === 'image-gen') {
    return <ImageGenTool selectedAssets={selectedAssets} onDeselectSlot={onDeselectSlot} onGenerated={onGenerated} onViewAsset={onViewAsset} recipe={recipe} onQueueStatus={onQueueStatus} refRequest={refRequest} ratingsVersion={ratingsVersion} />;
  }
  if (tool.id === 'voice-filter') {
    return <VoiceFilterTool selectedAssets={selectedAssets} onDeselectSlot={onDeselectSlot} onProcessDone={onProcessDone} />;
  }
  if (tool.id === 'demucs') {
    return <DemucsTool selectedAssets={selectedAssets} onDeselectSlot={onDeselectSlot} onProcessDone={onProcessDone} />;
  }
  if (tool.id === 'audio-normalize') {
    return <AudioNormalizeTool selectedAssets={selectedAssets} onDeselectSlot={onDeselectSlot} onProcessDone={(src, out) => onProcessDone(src, out)} />;
  }
  if (tool.id === 'ride-video') {
    return <RideVideoTool selectedAssets={selectedAssets} onDeselectSlot={onDeselectSlot} onProcessDone={onProcessDone} />;
  }
  if (tool.id === 'voice-register') {
    return <VoiceRegisterTool selectedAssets={selectedAssets} onDeselectSlot={onDeselectSlot} onProcessDone={onProcessDone} onShowAsset={onShowAsset} />;
  }
  // Generic stub (passthrough)
  return (
    <div className="vf-workspace">
      <div className="workspace-slots">
        {selectedAssets.length === 0 && (
          <div className="slots-empty">Select {tool.slots.count > 1 ? `up to ${tool.slots.count}` : '1'} asset{tool.slots.count !== 1 ? 's' : ''} from the Library →</div>
        )}
        {selectedAssets.map((asset, idx) => (
          <div key={asset.id} className="slot-row">
            <div className="slot-info">
              <span className="slot-label">{assetLabel(asset)}</span>
              {asset.duration_s != null && <span className="slot-dur">{fmtDur(asset.duration_s)}</span>}
            </div>
            <button className="slot-remove" onClick={() => onDeselectSlot(idx)} aria-label="Remove"><IconClose /></button>
          </div>
        ))}
      </div>
      <button className="submit-btn" onClick={onSubmit} disabled={selectedAssets.length === 0 || submitting}>
        {submitting ? 'Processing…' : 'Process (no-op)'}
      </button>
    </div>
  );
}

// ── App ─────────────────────────────────────────────────────────────────────
export interface ConfirmOpts { title: string; body?: string; ok: string; danger?: boolean }

const PHONE_QUERY = '(max-width: 720px)';
// The refresh after a full-page app closes can insert tiles ABOVE the viewport (a new clip lands at
// the top of Clipboard). Pin the first visible tile where it is for a few seconds:
// on each re-render, scroll by however far it moved. A user scroll re-bases the pin.
function keepAnchor(scroller: HTMLElement) {
  const edge = scroller.getBoundingClientRect().top;
  const anchor = Array.from(scroller.querySelectorAll<HTMLElement>('.thumb')).find(t => t.getBoundingClientRect().bottom > edge);
  if (!anchor) return;
  let y0 = anchor.getBoundingClientRect().top, adjusting = false;
  const onScroll = () => { if (!adjusting) y0 = anchor.getBoundingClientRect().top; adjusting = false; };
  const mo = new MutationObserver(() => {
    if (!anchor.isConnected) return;
    const dy = anchor.getBoundingClientRect().top - y0;
    if (Math.abs(dy) > 1) { adjusting = true; scroller.scrollTop += dy; }
  });
  mo.observe(scroller, { childList: true, subtree: true });
  scroller.addEventListener('scroll', onScroll, { passive: true });
  setTimeout(() => { mo.disconnect(); scroller.removeEventListener('scroll', onScroll); }, 4000);
}

function useIsPhone() {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

export default function App() {
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [activeCategory, setActiveCategory] = useState<AssetCategory | null>(null);
  const [activeTool, setActiveTool] = useState<ToolDeclaration | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [ytModalOpen, setYtModalOpen] = useState(false);
  const [ytMode, setYtMode] = useState<'audio' | 'video'>('audio');

  const [activeRailTab, setActiveRailTab] = useState('library');
  const [compareA, setCompareA] = useState<Asset | null>(null);
  const [compareB, setCompareB] = useState<Asset | null>(null);
  const [viewerAsset, setViewerAsset] = useState<Asset | null>(null);

  // ── Phone layout: one zone at a time + a bottom tab bar. Every zone stays mounted
  // (only hidden), so scroll positions and tool forms survive switching tabs.
  const isPhone = useIsPhone();
  // Full-page apps: an overlay route over the still-mounted library.
  const route = useAppRoute();
  const appOpen = FULL_PAGE_APPS.includes(route.app ?? '');
  const [phoneTab, setPhoneTab] = useState<'library' | 'tool' | 'preview'>('library');
  const [viewerOrigin, setViewerOrigin] = useState<'library' | 'tool'>('library');
  const [queueStatus, setQueueStatus] = useState<QueueStatus>({ active: 0, label: '', pct: null });
  const [toolDot, setToolDot] = useState(false);   // a render finished while you were elsewhere
  const [refRequest, setRefRequest] = useState<RefRequest | null>(null);
  const [viewerList, setViewerList] = useState<Asset[] | null>(null);     // for ‹ › stepping
  const [tileMenu, setTileMenu] = useState<{ asset: Asset; list: Asset[] } | null>(null);
  // Multi-select: null = not selecting. Here, not in the rail, because the phone's
  // bottom action bar and swipe-back live at this level.
  const [bulk, setBulk] = useState<BulkSel | null>(null);
  // Ask before anything disruptive (trash too, even though Recycle can revive).
  const [confirmReq, setConfirmReq] = useState<(ConfirmOpts & { resolve: (ok: boolean) => void }) | null>(null);
  const askConfirm = useCallback((o: ConfirmOpts) => new Promise<boolean>(resolve => setConfirmReq({ ...o, resolve })), []);
  const answerConfirm = (ok: boolean) => { confirmReq?.resolve(ok); setConfirmReq(null); };
  const prevActive = useRef(0);
  useEffect(() => {
    if (queueStatus.active < prevActive.current && phoneTab !== 'tool') setToolDot(true);
    prevActive.current = queueStatus.active;
  }, [queueStatus.active, phoneTab]);
  useEffect(() => { if (phoneTab === 'tool') setToolDot(false); }, [phoneTab]);
  // Following a parent/reference link from the viewer pushes the current asset here so the
  // viewer can offer "← Back". Opening an asset from the library/tool starts a fresh trail.
  const [viewerTrail, setViewerTrail] = useState<Asset[]>([]);
  const openViewerFrom = useCallback((origin: 'library' | 'tool', a: Asset | null, list?: Asset[]) => {
    setViewerTrail([]); setViewerAsset(a); setViewerOrigin(origin); setViewerList(list || null);
    if (a) setPhoneTab('preview');
  }, []);
  const openViewer = useCallback((a: Asset | null, list?: Asset[]) => openViewerFrom('library', a, list), [openViewerFrom]);
  const openViewerFromTool = useCallback((a: Asset, list?: Asset[]) => openViewerFrom('tool', a, list), [openViewerFrom]);
  // ‹ › through the list the asset was opened from; hidden once you've followed a reference link.
  const stepIdx = viewerAsset && viewerList && viewerTrail.length === 0 ? viewerList.findIndex(x => x.id === viewerAsset.id) : -1;
  const viewerStep = stepIdx >= 0 && viewerList ? {
    pos: stepIdx + 1, total: viewerList.length,
    onStep: (d: -1 | 1) => { const n = viewerList[stepIdx + d]; if (n) setViewerAsset(n); },
  } : null;
  // Phone header ←: Preview returns to where it was opened from; the Tool returns to the Library.
  const phoneBack = !isPhone ? null
    : appOpen ? { label: 'Library', go: leaveApp }
    : catalogOpen ? null
    : bulk && phoneTab === 'library' ? { label: 'Clear', go: () => setBulk(null) }   // Back = clear the selection
    : phoneTab === 'preview' ? (viewerOrigin === 'tool' && activeTool
        ? { label: activeTool.label.replace('Image Generation', 'Generate'), go: () => setPhoneTab('tool') }
        : { label: 'Library', go: () => setPhoneTab('library') })
    : phoneTab === 'tool' ? { label: 'Library', go: () => setPhoneTab('library') } : null;
  // Edge swipe-back (Aurora S2–S7): a one-finger drag from the left 24px does what the header ←
  // does. Axis-locked at 8px; horizontal blocks page scroll; commits at 70px. Safari's own edge
  // gesture is suppressed by the viewport/overscroll/gesture guards (the design notes).
  const bodyRef = useRef<HTMLDivElement>(null);
  const appHostRef = useRef<HTMLDivElement>(null);
  const edgeTabRef = useRef<HTMLDivElement>(null);
  const phoneBackRef = useRef(phoneBack); phoneBackRef.current = phoneBack;
  useEffect(() => {
    // The library body AND the full-page app host: one swipe-back implementation for both.
    const els = [bodyRef.current, appHostRef.current].filter((x): x is HTMLDivElement => !!x), tab = edgeTabRef.current;
    if (!isPhone || !els.length || !tab) return;
    let g: { x0: number; y0: number; axis: 'x' | 'y' | null; dx: number } | null = null;
    const show = (d: number) => { tab.style.transform = `translateX(${d - 40}px)`; tab.style.opacity = d > 70 ? '1' : d > 0 ? '.6' : '0'; };
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      g = e.touches.length === 1 && t.clientX < 24 && phoneBackRef.current ? { x0: t.clientX, y0: t.clientY, axis: null, dx: 0 } : null;
    };
    const onMove = (e: TouchEvent) => {
      if (!g) return;
      if (e.touches.length !== 1) { g = null; show(0); return; }
      const t = e.touches[0], dx = t.clientX - g.x0, dy = t.clientY - g.y0;
      if (!g.axis) {
        if (Math.hypot(dx, dy) < 8) return;
        g.axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y';
        if (g.axis === 'y') { g = null; return; }
      }
      if (e.cancelable) e.preventDefault();
      g.dx = dx; show(Math.max(0, Math.min(80, dx)));
    };
    const onEnd = () => {
      const done = g && g.axis === 'x' && g.dx >= 70;
      g = null; show(0);
      if (done) phoneBackRef.current?.go();
    };
    for (const el of els) {
      el.addEventListener('touchstart', onStart, { passive: true });
      el.addEventListener('touchmove', onMove, { passive: false });
      el.addEventListener('touchend', onEnd, { passive: true });
      el.addEventListener('touchcancel', onEnd, { passive: true });
    }
    return () => { for (const el of els) { el.removeEventListener('touchstart', onStart); el.removeEventListener('touchmove', onMove); el.removeEventListener('touchend', onEnd); el.removeEventListener('touchcancel', onEnd); } };
  }, [isPhone]);

  const phoneTitle = catalogOpen ? 'Tools' : phoneTab === 'tool' ? (activeTool?.label || 'Tool') : phoneTab === 'preview' ? 'Preview' : 'Asset Library';
  const followViewerLink = useCallback((a: Asset) => {
    if (viewerAsset && viewerAsset.id !== a.id) setViewerTrail(t => [...t, viewerAsset]);
    setViewerAsset(a);
  }, [viewerAsset]);
  const viewerBack = useCallback(() => {
    const prev = viewerTrail[viewerTrail.length - 1];
    if (!prev) return;
    setViewerTrail(viewerTrail.slice(0, -1));
    setViewerAsset(prev);
  }, [viewerTrail]);
  const [recipe, setRecipe] = useState<Recipe | null>(null);

  const { clipboardAssets, recycleAssets, favoriteAssets, setFavoriteAssets, libraryAssets, loading, refresh, library } = useLibraryData();
  const favoriteIds = new Set(favoriteAssets.map(a => a.id));

  // ── Full-page apps: enter / leave / restore (Aurora fullpage-apps-v1.2 §3A) ──
  const railScroll = () => document.querySelector<HTMLElement>('[data-testid="rail-sections"]');
  const snapRef = useRef<LibSnapshot | null>(null);
  const startApp = (app: FullPageApp, edit: string | null, from: string | null = null, fallback: string | null = null) => {
    snapRef.current = { query: library.query, viewerId: viewerAsset?.id ?? null, toolId: activeTool?.id ?? null, scroll: railScroll()?.scrollTop ?? 0 };
    openApp(app, edit, from, snapRef.current, fallback);
  };
  // A toast may carry an Undo (bulk actions); it then stays up longer so there's time to reach it.
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const setAppToast = useCallback((text: string, undo?: () => void) => setToast(text ? { text, undo } : null), []);
  const appToast = toast?.text ?? '';
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), toast.undo ? 6000 : 2600); return () => clearTimeout(t); }, [toast]);
  // A reload (or cold link) inside the app: put the library back the way it was underneath.
  useEffect(() => {
    const snap = readRoute().app ? savedSnapshot() : null;
    if (!snap) return;
    snapRef.current = snap;
    if (snap.query) library.setQuery({ ...library.query, ...(snap.query as LibraryQuery) });   // older snapshots lack newer fields
    const tool = snap.toolId && TOOL_REGISTRY.find(t => t.id === snap.toolId);
    if (tool) setActiveTool(tool);
    if (snap.viewerId) fetch(`${LIB_BASE}/api/assets/${encodeURIComponent(snap.viewerId)}`).then(r => (r.ok ? r.json() : null)).then(a => a && setViewerAsset(a)).catch(() => {});
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving: "Draft kept" (never a confirm), the scroll offset in a rAF, focus back to the opener.
  const wasOpen = useRef<{ edit: string | null } | null>(null);
  useEffect(() => {
    if (appOpen) { wasOpen.current = { edit: route.edit }; return; }
    if (!wasOpen.current) return;
    if (takeDraftSaved()) setAppToast('Draft kept — reopen it from the clip');
    wasOpen.current = null;
    const top = snapRef.current?.scroll;
    requestAnimationFrame(() => {
      const el = railScroll();
      if (el && top != null) el.scrollTop = top;
      if (el) keepAnchor(el);
      refocusOpener();
      refresh();   // the library stayed mounted: pick up what the app made (a new clip didn't show)
    });
  }, [appOpen, route.edit]);   // eslint-disable-line react-hooks/exhaustive-deps
  const openAssetFromApp = (id: string) => {
    leaveApp();
    fetch(`${LIB_BASE}/api/assets/${encodeURIComponent(id)}`).then(r => (r.ok ? r.json() : null)).then(a => a && openViewer(a)).catch(() => {});
  };
  const { selectedAssets, toggleAsset, removeAsset, clearSelection, isSelected } = useToolSelection();

  // ── Portable asset deep-links (Phase A) ────────────────────────────────────
  // ?assetid=<id>&view=preview|direct|download. view=preview (default) loads the
  // asset into the viewer column. view=direct/download are normally pure server
  // redirects (no SPA load); if the SPA is reached with them anyway, honor by
  // redirecting the browser to the raw-bytes endpoint. Runs once on mount.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const assetId = params.get('assetid');
    if (!assetId) return;
    const view = params.get('view') || 'preview';
    if (view === 'direct' || view === 'download') {
      const dl = view === 'download' ? '?download=1' : '';
      window.location.replace(`${LIB_BASE}/api/assets/${encodeURIComponent(assetId)}/file${dl}`);
      return;
    }
    // view=preview: fetch the row and open the viewer column.
    let cancelled = false;
    fetch(`${LIB_BASE}/api/assets/${encodeURIComponent(assetId)}`)
      .then(r => (r.ok ? r.json() : null))
      .then((asset: Asset | null) => { if (asset && !cancelled) { setViewerAsset(asset); setPhoneTab('preview'); } })
      .catch(e => console.error('deep-link load error', e));
    return () => { cancelled = true; };
  }, []);

  const openCatalog  = useCallback(() => setCatalogOpen(true), []);
  const closeCatalog = useCallback(() => setCatalogOpen(false), []);

  const handleToolSelect = useCallback((tool: ToolDeclaration) => {
    setActiveTool(tool);
    setActiveCategory(tool.category);
    setCatalogOpen(false);
    setPhoneTab('tool');
    clearSelection();
    setActiveRailTab('library');
  }, [clearSelection]);

  const handleCategorySelect = useCallback((cat: AssetCategory) => {
    setActiveCategory(cat);
    if (activeTool && activeTool.category !== cat) {
      setActiveTool(null);
      clearSelection();
      setActiveRailTab('library');
    }
  }, [activeTool, clearSelection]);

  const handleSubmit = useCallback(async () => {
    if (!activeTool || selectedAssets.length === 0) return;
    setSubmitting(true);
    try {
      const first = selectedAssets[0];
      const fileResp = await fetch(`${LIB_BASE}/api/clip/${first.id}`);
      if (fileResp.ok) {
        const blob = await fileResp.blob();
        const fd = new FormData();
        fd.append('file', new File([blob], `passthrough-${first.filename || first.id}.wav`, { type: blob.type }));
        await fetch(`${LIB_BASE}/api/upload`, { method: 'POST', body: fd });
      }
      refresh();
    } catch (e) { console.error('submit error', e); }
    finally { setSubmitting(false); }
  }, [activeTool, selectedAssets, refresh]);

  const handleProcessDone = useCallback((source: Asset, output: Asset | null) => {
    refresh();
    if (activeTool?.onOutput === 'switchToCompare' && output) {
      setCompareA(source);
      setCompareB(output);
      setActiveRailTab('audio-compare');
    }
  }, [activeTool, refresh]);

  // ── Favorites: optimistic toggle; Clear asks first and never deletes assets ──
  const toggleFavorite = useCallback(async (asset: Asset) => {
    const on = !favoriteAssets.some(a => a.id === asset.id);
    setFavoriteAssets(fs => (on ? [{ ...asset, is_favorite: true }, ...fs] : fs.filter(a => a.id !== asset.id)));
    const r = await fetch(`${LIB_BASE}/api/favorites/${asset.id}`, { method: on ? 'PUT' : 'DELETE' }).catch(() => null);
    if (!r?.ok) { refresh(); alert(`Couldn't ${on ? 'add to' : 'remove from'} favorites`); }
  }, [favoriteAssets, setFavoriteAssets, refresh]);
  const clearFavorites = useCallback(async () => {
    const n = favoriteAssets.length;
    if (!n || !(await askConfirm({ title: `Clear ${n} favorite${n === 1 ? '' : 's'}?`, body: 'This only removes the stars. Nothing is deleted from the library.', ok: 'Clear favorites' }))) return;
    setFavoriteAssets(() => []);
    const r = await fetch(`${LIB_BASE}/api/favorites`, { method: 'DELETE' }).catch(() => null);
    if (!r?.ok) { refresh(); alert("Couldn't clear favorites"); }
  }, [favoriteAssets, setFavoriteAssets, askConfirm, refresh]);
  // ── Rating: one vote; the same arrow again clears it ──
  const [ratingsVersion, setRatingsVersion] = useState(0);
  // Optimistic ("the rating is laggy"): the vote shows at once; the server's
  // answer then confirms it, or the old vote comes back with a note.
  const rateAsset = useCallback(async (asset: Asset, dir: 1 | -1) => {
    const before = { rating: asset.rating ?? 0, score: asset.score ?? 0 };
    const value = before.rating === dir ? 0 : dir;
    const put = (m: { rating: number; score: number }) => setViewerAsset(v => (v && v.id === asset.id ? { ...v, ...m } : v));
    put({ rating: value, score: before.score - before.rating + value });
    const r = await fetch(`${LIB_BASE}/api/assets/${asset.id}/rating`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }) })
      .then(x => x.json()).catch(e => ({ error: String(e) }));
    if (!r?.ok) { put(before); setAppToast(`Couldn't save the rating: ${r?.error || 'unknown'}`); return; }
    put({ rating: r.rating, score: r.score });
    setRatingsVersion(n => n + 1);
  }, []);

  const handleTrashAsset = useCallback(async (asset: Asset) => {
    const name = asset.label || asset.filename || asset.id.slice(0, 8);
    if (!(await askConfirm({ title: 'Move to Recycle?', body: `"${name}" goes to Recycle, where you can revive it for 48 hours.`, ok: 'Move to Recycle' }))) return;
    try {
      await fetch(`${LIB_BASE}/api/clip/${asset.id}/trash`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      refresh();
      setViewerAsset(null);
    } catch (e) { console.error(e); }
  }, [refresh, askConfirm]);

  const handleSaveAsset = useCallback(async (asset: Asset) => {
    try {
      await fetch(`${LIB_BASE}/api/assets/${asset.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promote: { subdir: 'audio/samples', name: asset.label || asset.filename, subtype: 'clip' } }),
      });
      refresh();
      setViewerAsset(null);
    } catch (e) { console.error(e); }
  }, [refresh]);

  // ── Bulk actions: per item, 4 at a time (no bulk endpoint), one refresh, then a
  // toast with Undo, and the selection clears. No confirm for Recycle — it's recoverable and Undo exists
  // (the single-item trash keeps its confirm).
  const runBulk = useCallback(async (kind: BulkKind, assets: Asset[]) => {
    setBulk(null);
    const post = (id: string, verb: 'trash' | 'revive') => fetch(`${LIB_BASE}/api/clip/${id}/${verb}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.ok);
    const star = (id: string, on: boolean) => fetch(`${LIB_BASE}/api/favorites/${id}`, { method: on ? 'PUT' : 'DELETE' }).then(r => r.ok);
    const setStars = (xs: Asset[], on: boolean) => {   // optimistic, like toggleFavorite
      const ids = new Set(xs.map(a => a.id));
      setFavoriteAssets(fs => (on ? [...xs.map(a => ({ ...a, is_favorite: true })), ...fs.filter(a => !ids.has(a.id))] : fs.filter(a => !ids.has(a.id))));
    };
    const n = (k: number, of: number) => `${k}${k < of ? ` of ${of}` : ''}`;
    const undoWith = (fn: () => Promise<unknown>) => async () => { setAppToast(''); await fn(); refresh(); setAppToast('Undone'); };
    if (kind === 'fav' || kind === 'unfav') {
      const on = kind === 'fav', xs = assets.filter(a => favoriteIds.has(a.id) !== on);
      setStars(xs, on);
      const ok = await runPool(xs, a => star(a.id, on));
      refresh();
      setAppToast(`${on ? 'Favorited' : 'Unfavorited'} ${n(ok.length, xs.length)}`,
        ok.length ? undoWith(() => { setStars(ok, !on); return runPool(ok, a => star(a.id, !on)); }) : undefined);
    } else if (kind === 'trash' || kind === 'revive') {
      const ok = await runPool(assets, a => post(a.id, kind));
      const gone = new Set(ok.map(a => a.id));
      if (kind === 'trash') setViewerAsset(v => (v && gone.has(v.id) ? null : v));
      refresh();
      setAppToast(`${kind === 'trash' ? 'Moved' : 'Revived'} ${n(ok.length, assets.length)}${kind === 'trash' ? ' to Recycle' : ''}`,
        ok.length ? undoWith(() => runPool(ok, a => post(a.id, kind === 'trash' ? 'revive' : 'trash'))) : undefined);
    } else if (kind === 'save') {
      // Promote moves the file out of scratch; there's no un-promote, so Save has no Undo.
      const xs = assets.filter(canSave);
      const ok = await runPool(xs, a => fetch(`${LIB_BASE}/api/assets/${a.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promote: a.category === 'image'
          ? { subdir: 'images/uploads', name: a.label || a.filename, subtype: 'image' }
          : { subdir: 'audio/samples', name: a.label || a.filename, subtype: 'clip' } }),
      }).then(r => r.ok));
      refresh();
      setAppToast(`Saved ${n(ok.length, xs.length)} to Library`);
    }
  }, [favoriteIds, setFavoriteAssets, refresh, setAppToast]);
  // The phone bottom bar resolves the selection itself (the rail passes its own list on desktop).
  const bulkAssets = (() => {
    if (!bulk) return [];
    const pool = { favorites: favoriteAssets, clipboard: clipboardAssets, recycle: recycleAssets, library: libraryAssets }[bulk.section];
    const ids = new Set(bulk.ids);
    return pool.filter(a => ids.has(a.id));
  })();

  // An image tool shows the library as images only (Scenario-style); closing it restores.
  const { query: libQuery, setQuery: setLibQuery } = library;
  const imageTool = activeTool?.category === 'image';
  useEffect(() => {
    if (imageTool && !(libQuery.categories.length === 1 && libQuery.categories[0] === 'image')) {
      setLibQuery({ ...libQuery, categories: ['image'] });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageTool]);

  // "Reload parameters" (our generations) / "Re-use prompt" (imports): recipe → tool column,
  // reference images → the tool's slots.
  const handleUseRecipe = useCallback(async (asset: Asset) => {
    const r = await fetch(`/asset-management/tools/image-gen/api/recipe/${asset.id}`).then(x => x.json()).catch(() => null);
    if (!r?.ok) { alert(r?.error || 'No recipe for this asset'); return; }
    setActiveTool(IMAGE_GEN_TOOL);
    setActiveCategory('image');
    setActiveRailTab('library');
    clearSelection();
    setRecipe({ ...r.recipe });   // the tool loads recipe.refs itself
    setPhoneTab('tool');
  }, [clearSelection]);

  const handleYtOpen  = useCallback((mode: 'audio' | 'video' = 'audio') => { setYtMode(mode); setYtModalOpen(true); }, []);
  const handleYtClose = useCallback(() => setYtModalOpen(false), []);

  // Breadcrumb reflects active state
  const breadcrumb = activeTool
    ? `localhost → Development → Asset Library → ${activeTool.label}`
    : activeCategory
      ? `localhost → Development → Asset Library → ${activeCategory.charAt(0).toUpperCase() + activeCategory.slice(1)} Tools`
      : 'localhost → Development → Asset Library';

  return (
    <div className="shell" data-testid="shell">
      <div ref={appHostRef}>
        {route.app === 'clip-editor' && <ClipEditorApp route={route} onOpenAsset={openAssetFromApp} />}
        {route.app === 'model-studio' && <Suspense fallback={<div className="fp-app" />}><ModelStudioApp route={route} onOpenAsset={openAssetFromApp} /></Suspense>}
      </div>
      {appToast && <div className="fp-toast" role="status" data-testid="fp-toast">{appToast}
        {toast?.undo && <> · <button className="fp-toast-undo" data-testid="toast-undo" onClick={toast.undo}>Undo</button></>}</div>}

      {/* ── Global nav bar: ONE hamburger + breadcrumb links ── */}
      <header className="shell-nav" data-testid="shell-nav" inert={appOpen} aria-hidden={appOpen || undefined}>
        <button
          className="hamburger-btn"
          onClick={openCatalog}
          data-testid="hamburger-btn"
          aria-label="Open tool catalog"
        >
          <IconMenu />
        </button>
        {isPhone ? (
          <div className="phone-hdr" data-testid="phone-hdr">
            {phoneBack && (
              <button className="phone-back" data-testid="phone-back" onClick={phoneBack.go} aria-label={`Back to ${phoneBack.label}`}>
                <IconChevronLeft /><span>{phoneBack.label}</span>
              </button>
            )}
            <h1 className="phone-title">{phoneTitle}</h1>
          </div>
        ) : (
        <nav className="nav-breadcrumb" data-testid="nav-breadcrumb" aria-label="Breadcrumb">
          <a href="/" className="bc-link" data-testid="bc-localhost">localhost</a>
          <span className="bc-sep"> → </span>
          <a href="/dev.html" className="bc-link" data-testid="bc-development">Development</a>
          <span className="bc-sep"> → </span>
          <a
            href="/asset-management/"
            className="bc-link"
            data-testid="bc-asset-library"
            onClick={e => {
              e.preventDefault();
              // Clear active tool → returns to landing state (no tool, no column)
              setActiveTool(null);
              setActiveCategory(null);
              clearSelection();
              setActiveRailTab('library');
            }}
          >Asset Library</a>
          {activeTool && (
            <>
              <span className="bc-sep"> → </span>
              <span className="bc-current" data-testid="bc-active-tool">{activeTool.label}</span>
            </>
          )}
          {!activeTool && activeCategory && (
            <>
              <span className="bc-sep"> → </span>
              <span className="bc-current">{activeCategory.charAt(0).toUpperCase() + activeCategory.slice(1)} Tools</span>
            </>
          )}
        </nav>
        )}
      </header>

      {/* ── Multi-column body: [tool?] + library + [viewer?] ── */}
      <div
        ref={bodyRef}
        inert={appOpen}
        aria-hidden={appOpen || undefined}
        className={`shell-body${activeTool ? ' has-tool' : ''}${viewerAsset ? ' has-viewer' : ''}${isPhone ? ` phone phone-tab-${phoneTab}` : ''}`}
        data-testid="shell-body"
      >
        {/* Left: tool workspace — only rendered when a tool is active */}
        {activeTool && (
          <div className="tool-col" data-testid="tool-col">
            <div className="tool-col-header" data-testid="tool-col-header">
              <span className="workspace-title" data-testid="workspace-title">{activeTool.label}</span>
              <button
                className="tool-col-close"
                onClick={() => { setActiveTool(null); clearSelection(); setActiveRailTab('library'); }}
                data-testid="tool-col-close"
                title="Close tool"
                aria-label="Close tool"
              ><IconClose /></button>
            </div>
            <ToolWorkspace
              tool={activeTool}
              selectedAssets={selectedAssets}
              onDeselectSlot={removeAsset}
              onSubmit={handleSubmit}
              submitting={submitting}
              onProcessDone={handleProcessDone}
              onGenerated={refresh}
              onViewAsset={openViewerFromTool}
              recipe={recipe}
              onQueueStatus={setQueueStatus}
              refRequest={refRequest}
              ratingsVersion={ratingsVersion}
              onShowAsset={a => { setViewerTrail([]); setViewerAsset(a); setViewerOrigin('tool'); setViewerList(null); }}
            />
          </div>
        )}
        {isPhone && !activeTool && (
          <div className="tool-col phone-empty" data-testid="phone-tool-empty">
            <p>No tool open.</p>
            <button className="submit-btn" onClick={openCatalog}>Choose a tool</button>
          </div>
        )}

        {/* Center: library column — always present; shrinks when viewer is open */}
        <div className="library-col" data-testid="library-col">
          {/* Features row: category cards — hidden when a tool is active */}
          {!activeTool && (
            <div className="features-row" data-testid="features-row">
              <CategoryCards
                activeCategory={activeCategory}
                onSelectCategory={handleCategorySelect}
              />
            </div>
          )}

          {/* Asset Rail: tabs + import + filter + sections */}
          <AssetRail
            activeCategory={activeCategory}
            activeTool={activeTool}
            selectedAssets={selectedAssets}
            onAssetToggle={toggleAsset}
            isSelected={isSelected}
            clipboardAssets={clipboardAssets}
            recycleAssets={recycleAssets}
            libraryAssets={libraryAssets}
            library={library}
            loading={loading}
            refresh={refresh}
            onYtModalOpen={handleYtOpen}
            activeTab={activeRailTab}
            onTabChange={setActiveRailTab}
            compareA={compareA}
            compareB={compareB}
            onSetCompareAB={(a, b) => { setCompareA(a); setCompareB(b); }}
            onViewAsset={openViewer}
            onTileMenu={(asset, list) => setTileMenu({ asset, list })}
            confirm={askConfirm}
            favoriteAssets={favoriteAssets}
            favoriteIds={favoriteIds}
            onClearFavorites={clearFavorites}
            phone={isPhone}
            previewId={viewerAsset?.id ?? null}
            bulk={bulk}
            onBulkChange={setBulk}
            onBulk={runBulk}
          />
        </div>

        {/* Right: viewer column — conditional, appears when an asset is clicked */}
        {viewerAsset && (
          <AssetViewer
            asset={viewerAsset}
            onClose={() => { openViewer(null); if (isPhone) setPhoneTab(viewerOrigin); }}
            onTrash={handleTrashAsset}
            onDownload={() => {}}
            onSave={handleSaveAsset}
            onViewAsset={followViewerLink}
            backTo={viewerTrail[viewerTrail.length - 1] || null}
            onBack={viewerBack}
            onUseRecipe={handleUseRecipe}
            onUseAsRef={activeTool?.id === 'image-gen' && viewerAsset.category === 'image'
              ? a => { setRefRequest({ asset: a, n: Date.now() }); if (isPhone) setPhoneTab('tool'); } : undefined}
            step={viewerStep}
            isFavorite={favoriteIds.has(viewerAsset.id)}
            onToggleFavorite={toggleFavorite}
            onRate={rateAsset}
            onEditClip={a => { const t = clipEditTarget(a); startApp('clip-editor', t.edit, t.from); }}
            onOpenModelStudio={a => startApp('model-studio', a.id)}
            refresh={refresh}
          />
        )}
        {isPhone && !viewerAsset && (
          <div className="viewer-col phone-empty" data-testid="phone-preview-empty">
            <p>Nothing selected.</p>
            <p className="phone-empty-hint">Tap an image in the Library, or a render in the Tool, to preview it here.</p>
          </div>
        )}
      </div>

      {isPhone && <div className="edge-back-tab" ref={edgeTabRef} aria-hidden="true"><IconChevronLeft /></div>}

      {/* ── Phone: render progress on other tabs + the tab bar ── */}
      {isPhone && queueStatus.active > 0 && phoneTab !== 'tool' && !catalogOpen && (
        <button className="phone-render-bar" data-testid="phone-render-bar" onClick={() => setPhoneTab('tool')}>
          <span className="ig-spin" />
          <span className="phone-render-text">Rendering{queueStatus.active > 1 ? ` · ${queueStatus.active} jobs` : ''}{queueStatus.label ? ` · ${queueStatus.label}` : ''}</span>
          <span className="phone-render-go">Open ›</span>
          {queueStatus.pct != null && <span className="phone-render-prog" style={{ width: `${queueStatus.pct}%` }} />}
        </button>
      )}
      {/* Phone select mode: the actions take the tab bar's place (thumb reach), same height */}
      {isPhone && bulk && phoneTab === 'library' && !catalogOpen && !appOpen && (
        <nav className="phone-bulkbar" data-testid="phone-bulkbar" aria-label="Selection actions">
          <BulkActions assets={bulkAssets} section={bulk.section} favoriteIds={favoriteIds} onAct={k => runBulk(k, bulkAssets)} phone />
        </nav>
      )}
      {isPhone && !(bulk && phoneTab === 'library' && !catalogOpen && !appOpen) && (
        <nav className="phone-tabs" data-testid="phone-tabs" aria-label="Sections" inert={appOpen} aria-hidden={appOpen || undefined}>
          {([
            ['library', 'Library', <IconLibrary key="i" />],
            ['tool', activeTool ? activeTool.label.replace('Image Generation', 'Generate') : 'Tool', <IconSparkle key="i" />],
            ['preview', 'Preview', <IconImage key="i" />],
          ] as const).map(([id, label, icon]) => (
            <button key={id} className={`phone-tab${!catalogOpen && phoneTab === id ? ' on' : ''}`} data-testid={`phone-tab-${id}`}
              onClick={() => { closeCatalog(); setPhoneTab(id); }} aria-current={!catalogOpen && phoneTab === id ? 'page' : undefined}>
              {icon}
              <span>{label}</span>
              {id === 'tool' && queueStatus.active > 0 && <span className="phone-badge">{queueStatus.active}</span>}
              {id === 'tool' && queueStatus.active === 0 && toolDot && <span className="phone-dot" />}
            </button>
          ))}
          <button className={`phone-tab${catalogOpen ? ' on' : ''}`} data-testid="phone-tab-tools" onClick={() => (catalogOpen ? closeCatalog() : openCatalog())}>
            <IconMenu />
            <span>Tools</span>
          </button>
        </nav>
      )}

      {/* ── Confirm dialog ── */}
      {confirmReq && (
        <div className="sheet-backdrop confirm-backdrop" data-testid="confirm" onClick={e => { if (e.target === e.currentTarget) answerConfirm(false); }}
          onKeyDown={e => { if (e.key === 'Escape') answerConfirm(false); }}>
          <div className="sheet confirm-dialog" role="alertdialog" aria-labelledby="confirm-title">
            <div className="confirm-title" id="confirm-title">{confirmReq.title}</div>
            {confirmReq.body && <div className="confirm-body">{confirmReq.body}</div>}
            <div className="confirm-actions">
              <button className="sheet-act sheet-cancel" data-testid="confirm-cancel" onClick={() => answerConfirm(false)}>Cancel</button>
              <button className={`sheet-act${confirmReq.danger ? ' danger' : ' primary'}`} data-testid="confirm-ok" autoFocus onClick={() => answerConfirm(true)}>{confirmReq.ok}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Long-press action sheet (touch) ── */}
      {tileMenu && (() => {
        const a = tileMenu.asset;
        const hasPrompt = a.category === 'image' && a.meta && typeof (a.meta as Record<string, unknown>).prompt === 'string';
        const isGen = !!(a.derived_op && typeof a.derived_op === 'object' && (a.derived_op as { tool?: string }).tool === 'image-gen');
        const close = () => setTileMenu(null);
        return (
          <div className="sheet-backdrop" data-testid="tile-menu" onClick={e => { if (e.target === e.currentTarget) close(); }}>
            <div className="sheet" role="menu">
              <div className="sheet-title">{a.label || a.filename || a.id.slice(0, 8)}</div>
              <button className="sheet-act" onClick={() => { close(); openViewer(a, tileMenu.list); }}>Open</button>
              {a.category === 'audio' && (
                <button className="sheet-act" data-testid="tile-menu-edit" onClick={() => { close(); const t = clipEditTarget(a); startApp('clip-editor', t.edit, t.from); }}><IconScissors /> Edit clip</button>
              )}
              <button className="sheet-act" data-testid="tile-menu-fav" onClick={() => { close(); toggleFavorite(a); }}>
                {favoriteIds.has(a.id) ? <><IconStarFilled /> Unfavorite</> : <><IconStar /> Favorite</>}</button>
              {activeTool?.id === 'image-gen' && a.category === 'image' && (
                <button className="sheet-act" data-testid="tile-menu-ref" onClick={() => { close(); setRefRequest({ asset: a, n: Date.now() }); setPhoneTab('tool'); }}>Use as reference</button>
              )}
              {hasPrompt && (
                <button className="sheet-act" onClick={() => { close(); handleUseRecipe(a); }}>{isGen ? 'Reload parameters' : 'Re-use prompt'}</button>
              )}
              <a className="sheet-act" href={`${LIB_BASE}/api/assets/${a.id}/file?download=1`} onClick={close}>Download</a>
              <button className="sheet-act sheet-cancel" onClick={close}>Cancel</button>
            </div>
          </div>
        );
      })()}

      {/* ── Catalog overlay (hamburger fly-out) ── */}
      {catalogOpen && (
        <CatalogOverlay
          activeCategory={activeCategory}
          onToolSelect={handleToolSelect}
          onYtModalOpen={handleYtOpen}
          onOpenApp={app => startApp(app, null, null, isPhone ? '[data-testid="phone-tab-tools"]' : '.hamburger-btn')}
          onClose={closeCatalog}
        />
      )}

      {/* ── Audio/Video Ripper sourcing modal ── */}
      {ytModalOpen && (
        <YtAudioModal mode={ytMode} onClose={handleYtClose} onRipComplete={() => refresh()} />
      )}
    </div>
  );
}
