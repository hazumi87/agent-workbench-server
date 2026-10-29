// lineage: asset-platform/@asset/kit — created by domain-development (agent-user) — task
//
// React port of the vanilla clipboard component (asset-library/picker.js
// buildClipboardComponent) at VANILLA PARITY — no new features, no redesign.
// Exposed as the light-DOM Web Component <asset-clipboard base="…">.
//
// Reuses the LIVE asset-library / asset-clipboard backend UNCHANGED (blueprint
// the design notes Step 1b). The `asset://` reference contract is explicitly NOT
// part of this step — that is Track B / B1 (the design notes), later.
//
// Markup + class names mirror the vanilla kit (.ap-*) so the shared picker.css
// fallbacks and our token aliases theme it identically. State model is faithful
// to the original: a LOCAL `savedIds` set (NOT an API field) drives the
// transient → saved flip; promoted clips remain in /api/list.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioPlayer } from './AudioPlayer';

interface Clip {
  id: string;
  label?: string;
  filename?: string;
  duration_s?: number | null;
}

// Default to the asset-LIBRARY (it serves the clipboard-compatible API: /api/list,
// /api/recycle, /api/assets, promote PATCH, DELETE). The standalone asset-clipboard
// service is retired (B0/P5) — the library is the durable backend; "Asset Clipboard"
// is now its transient (transient=1) view. A host can still override via base="…".
const DEFAULT_BASE = '/asset-management/library';

function fmtDur(s: number | null | undefined): string {
  if (s == null || isNaN(s)) return '—';
  const m = Math.floor(s / 60);
  const x = Math.floor(s % 60);
  return m + ':' + String(x).padStart(2, '0');
}

function clipName(c: Clip): string {
  return c.label || c.filename || 'clip ' + c.id;
}

type ApiFn = (path: string, opts?: RequestInit) => Promise<Response>;
type PanelKind = null | 'recycle' | 'existing';

export function AssetClipboard({ base = DEFAULT_BASE }: { base?: string }) {
  const [clips, setClips] = useState<Clip[]>([]);
  const [savedIds, setSavedIds] = useState<Record<string, boolean>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<PanelKind>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addbarRef = useRef<HTMLDivElement>(null);

  // Close the Add menu on an OUTSIDE click — faithful to the vanilla kit's
  // document mousedown listener (NOT a button blur, which races menu-item
  // clicks: focus leaving the button would close the menu before the item's
  // click lands, detaching it mid-click).
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (addbarRef.current && !addbarRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [menuOpen]);

  // Stable api helper — recomputed only when base changes (not every render),
  // so the load effect below doesn't churn.
  const api: ApiFn = useMemo(() => {
    const creds: RequestCredentials = (() => {
      try {
        return new URL(base, location.href).origin === location.origin ? 'same-origin' : 'omit';
      } catch {
        return 'same-origin';
      }
    })();
    return (path, opts) =>
      fetch(base + path, { credentials: creds, ...opts }).then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r;
      });
  }, [base]);

  const loadClips = useCallback(() => {
    api('/api/list')
      .then((r) => r.json())
      .then((data) => {
        setClips(data.clips || data.assets || []);
        setLoadError(null);
      })
      .catch((e) => setLoadError(e.message));
  }, [api]);

  // Initial + on-base-change load.
  useEffect(() => {
    loadClips();
  }, [loadClips]);

  const flashRowError = useCallback((msg: string) => {
    setRowError(msg);
    setTimeout(() => setRowError(null), 5000);
  }, []);

  // local removal (matches vanilla removeRow): drop from list + clear saved flag.
  const removeRow = useCallback((id: string) => {
    setClips((cs) => cs.filter((c) => c.id !== id));
    setSavedIds((s) => {
      const n = { ...s };
      delete n[id];
      return n;
    });
  }, []);

  const saveRow = useCallback(
    (clip: Clip) => {
      setSavingId(clip.id);
      api('/api/assets/' + encodeURIComponent(clip.id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          promote: { subdir: 'audio/samples', name: clip.label || clip.filename, subtype: 'clip' },
        }),
      })
        .then(() => {
          setSavedIds((s) => ({ ...s, [clip.id]: true }));
          setSavingId(null);
        })
        .catch((e) => {
          setSavingId(null);
          flashRowError('Save failed: ' + e.message);
        });
    },
    [api, flashRowError],
  );

  const trashRow = useCallback(
    (id: string) => {
      api('/api/clip/' + encodeURIComponent(id) + '/trash', { method: 'POST' })
        .then(() => removeRow(id))
        .catch((e) => flashRowError('Trash failed: ' + e.message));
    },
    [api, removeRow, flashRowError],
  );

  const onFilesChosen = useCallback(
    (files: FileList | null) => {
      const list = Array.from(files || []);
      if (!list.length) return;
      let done = 0;
      list.forEach((f) => {
        const fd = new FormData();
        fd.append('file', f);
        api('/api/upload', { method: 'POST', body: fd })
          .catch(() => {})
          .finally(() => {
            done++;
            if (done === list.length) loadClips();
          });
      });
    },
    [api, loadClips],
  );

  const togglePanel = useCallback((kind: Exclude<PanelKind, null>) => {
    setPanel((p) => (p === kind ? null : kind));
  }, []);

  // Add menu (5 items; URL disabled = "soon"), parity with the vanilla ADD items.
  const addItems = useMemo(
    () => [
      { icon: '💾', label: 'Hard drive', fn: () => fileInputRef.current?.click() },
      { icon: '🔧', label: 'Tool', fn: () => {} }, // tools wired when a host passes them
      { icon: '🗑', label: 'Recycle bin', fn: () => togglePanel('recycle') },
      { icon: '📁', label: 'Existing clip', fn: () => togglePanel('existing') },
      { icon: '🔗', label: 'URL', soon: true as const },
    ],
    [togglePanel],
  );

  return (
    <div className="ap-root ap-cb">
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => onFilesChosen(e.target.files)}
      />

      {rowError && <div className="ap-error">{rowError}</div>}

      <div className="ap-cb-addbar" style={{ position: 'relative' }} ref={addbarRef}>
        <button className="ap-btn ap-cb-add-btn" onClick={() => setMenuOpen((o) => !o)}>
          + Add
        </button>
        {menuOpen && (
          <div
            className="ap-menu ap-cb-add-menu"
            style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4 }}
          >
            {addItems.map((item) => (
              <button
                key={item.label}
                className={'ap-menu-item' + (item.soon ? ' ap-menu-item-disabled' : '')}
                disabled={item.soon}
                onClick={() => {
                  if (item.soon) return;
                  setMenuOpen(false);
                  item.fn?.();
                }}
              >
                <span className="ap-mi-icon">{item.icon}</span> {item.label}
                {item.soon && <span className="ap-mi-soon"> (soon)</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {panel === 'recycle' && (
        <RecyclePanel
          api={api}
          onClose={() => setPanel(null)}
          onRevived={() => {
            setPanel(null);
            loadClips();
          }}
        />
      )}
      {panel === 'existing' && <ExistingClipsPanel api={api} onClose={() => setPanel(null)} />}

      {loadError ? (
        <div className="ap-error">Could not load clipboard: {loadError}</div>
      ) : clips.length === 0 ? (
        <div className="ap-empty">Clipboard is empty &mdash; use Add to bring in clips.</div>
      ) : (
        clips.map((clip) => {
          const saved = !!savedIds[clip.id];
          return (
            <div className="ap-row ap-cb-row" data-id={clip.id} key={clip.id}>
              <div className="ap-row-top">
                <span className="ap-row-label">{clipName(clip)}</span>
                <span className="ap-row-dur">{fmtDur(clip.duration_s)}</span>
              </div>
              <AudioPlayer src={base + '/api/clip/' + encodeURIComponent(clip.id)} />
              <div className="ap-cb-controls">
                <button
                  className={'ap-btn ap-cb-save' + (saved ? ' ap-cb-saved' : '')}
                  disabled={saved || savingId === clip.id}
                  onClick={() => saveRow(clip)}
                >
                  {savingId === clip.id ? '…' : 'Save'}
                </button>
                {saved ? (
                  <button
                    className="ap-btn ap-cb-x"
                    title="Remove from clipboard (already saved)"
                    onClick={() => removeRow(clip.id)}
                  >
                    {'✕'}
                  </button>
                ) : (
                  <button
                    className="ap-btn ap-cb-trash"
                    title="Move to recycle bin (48h)"
                    onClick={() => trashRow(clip.id)}
                  >
                    {'🗑'}
                  </button>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// ---- Recycle bin panel (parity with openRecycleBin) ------------------------
function RecyclePanel({
  api,
  onClose,
  onRevived,
}: {
  api: ApiFn;
  onClose: () => void;
  onRevived: () => void;
}) {
  const [items, setItems] = useState<Clip[] | null>(null);
  const [msg, setMsg] = useState('Loading…');

  useEffect(() => {
    api('/api/recycle')
      .then((r) => r.json())
      .then((data) => {
        const list: Clip[] = data.clips || data.assets || [];
        if (!list.length) setMsg('Recycle bin is empty.');
        setItems(list);
      })
      .catch((e) => setMsg('Could not load recycle bin: ' + e.message));
  }, [api]);

  const revive = (id: string) =>
    api('/api/clip/' + encodeURIComponent(id) + '/revive', { method: 'POST' }).then(onRevived);

  const del = (id: string) => {
    if (!confirm('This will permanently delete the asset. Are you sure?')) return;
    api('/api/clip/' + encodeURIComponent(id), { method: 'DELETE' }).then(() => {
      setItems((cur) => {
        const next = (cur || []).filter((c) => c.id !== id);
        if (!next.length) setMsg('Recycle bin is empty.');
        return next;
      });
    });
  };

  return (
    <div className="ap-recycle-panel">
      <div className="ap-recycle-header">
        Recycle Bin (48h)
        <button className="ap-btn ap-recycle-close" onClick={onClose}>
          {'✕'}
        </button>
      </div>
      <div className="ap-recycle-body">
        {!items || !items.length ? (
          <span className="ap-empty">{msg}</span>
        ) : (
          items.map((clip) => (
            <div className="ap-recycle-row" key={clip.id}>
              <span className="ap-row-label">{clipName(clip)}</span>
              <button className="ap-btn ap-recycle-revive" onClick={() => revive(clip.id)}>
                Revive
              </button>
              <button
                className="ap-btn ap-recycle-delete"
                title="Permanently delete now"
                onClick={() => del(clip.id)}
              >
                {'🗑'}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---- Existing library clips panel (parity with openExistingClipBrowser) ----
function ExistingClipsPanel({ api, onClose }: { api: ApiFn; onClose: () => void }) {
  const [items, setItems] = useState<Clip[] | null>(null);
  const [msg, setMsg] = useState('Loading…');

  useEffect(() => {
    api('/api/assets?transient=0')
      .then((r) => r.json())
      .then((data) => {
        const list: Clip[] = data.assets || data.clips || [];
        if (!list.length) setMsg('No library clips yet.');
        setItems(list);
      })
      .catch((e) => setMsg('Could not load: ' + e.message));
  }, [api]);

  return (
    <div className="ap-recycle-panel ap-existclip-panel">
      <div className="ap-recycle-header">
        Library Clips
        <button className="ap-btn ap-recycle-close" onClick={onClose}>
          {'✕'}
        </button>
      </div>
      <div className="ap-empty" style={{ fontSize: 11 }}>
        ⚠ Copy-into-clipboard is a future task — listing only for now.
      </div>
      <div className="ap-recycle-body">
        {!items || !items.length ? (
          <span className="ap-empty">{msg}</span>
        ) : (
          items.map((clip) => (
            <div className="ap-recycle-row" key={clip.id}>
              <span className="ap-row-label">{clipName(clip)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
