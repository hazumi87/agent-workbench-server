// lineage: asset-platform/@asset/kit — created by domain-development (agent-user) — task (Track A A3)
//
// React port of the vanilla picker's url-history component
// (buildUrlHistoryComponent). A 2-column grid of thumbnail cards fetched from a
// `source` URL ({history:[{video_id,url,title,thumbnail,last_ts}]}); clicking a
// card fires onSelect with the full entry. Exposed as the light-DOM WC
// <asset-url-history source="…"> — selection is surfaced via a CustomEvent
// (asset-url-history:select) carrying the entry (the WC results-out channel),
// since string attributes can't carry a callback.
//
// `removable` opts a host into per-card removal: a ⋮ button opens a small menu and
// removal DELETEs to the same `source` URL with {video_id,url}. Off by default, so
// hosts whose API has no DELETE are unaffected.
import { useEffect, useState, useRef } from 'react';

export interface HistoryEntry {
  video_id?: string;
  url: string;
  title?: string;
  thumbnail?: string;
  last_ts?: string;
}

const keyOf = (e: HistoryEntry) => e.video_id || e.url;

export function UrlHistory({
  source,
  removable = false,
  onSelect,
}: {
  source: string;
  removable?: boolean;
  onSelect?: (e: HistoryEntry) => void;
}) {
  const [items, setItems] = useState<HistoryEntry[] | null>(null);
  const [msg, setMsg] = useState('Loading…');
  const [selected, setSelected] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    fetch(source, { credentials: 'same-origin' })
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then((d) => {
        if (!live) return;
        const h: HistoryEntry[] = (d && d.history) || [];
        if (!h.length) setMsg('No history yet.');
        setItems(h);
      })
      .catch((e) => live && setMsg('Could not load history: ' + e.message));
    return () => {
      live = false;
    };
  }, [source]);

  // Dismiss the menu on any outside click or Escape — a menu that only closes via its own
  // button strands the user behind an overlay they did not mean to open.
  useEffect(() => {
    if (!menuFor) return;
    const away = (ev: MouseEvent) => {
      if (!rootRef.current?.contains(ev.target as Node)) setMenuFor(null);
    };
    const esc = (ev: KeyboardEvent) => ev.key === 'Escape' && setMenuFor(null);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [menuFor]);

  async function remove(e: HistoryEntry) {
    const k = keyOf(e);
    setMenuFor(null);
    setBusy(k);
    setError(null);
    try {
      const r = await fetch(source, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ video_id: e.video_id, url: e.url }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || 'HTTP ' + r.status);
      }
      // Drop it locally rather than refetching: the list is small and already in hand, and a
      // refetch would flicker the whole grid for a one-row change.
      setItems((prev) => (prev || []).filter((x) => keyOf(x) !== k));
    } catch (err: any) {
      setError('Could not remove: ' + err.message);
    } finally {
      setBusy(null);
    }
  }

  if (!items || !items.length) return <div className="ap-empty">{msg}</div>;

  return (
    <div className="ap-hist-grid" ref={rootRef}>
      {error && <div className="ap-hist-error">{error}</div>}
      {items.map((e) => {
        const k = keyOf(e);
        return (
          <div
            key={k}
            className={
              'ap-hist-card' +
              (selected === k ? ' ap-hist-selected' : '') +
              (busy === k ? ' ap-hist-busy' : '')
            }
            onClick={() => {
              setSelected(k);
              onSelect?.(e);
            }}
          >
            {e.thumbnail ? (
              <img className="ap-hist-thumb" src={e.thumbnail} loading="lazy" alt="" />
            ) : (
              <div className="ap-hist-thumb" />
            )}
            {removable && (
              <div className="ap-hist-menu-wrap">
                <button
                  type="button"
                  className="ap-hist-dots"
                  aria-label="Actions for this entry"
                  aria-haspopup="menu"
                  aria-expanded={menuFor === k}
                  disabled={busy === k}
                  // The card itself loads the clip — a menu click must never do that too.
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setMenuFor(menuFor === k ? null : k);
                  }}
                >
                  ⋮
                </button>
                {menuFor === k && (
                  <div className="ap-hist-menu" role="menu" onClick={(ev) => ev.stopPropagation()}>
                    <button type="button" role="menuitem" className="ap-hist-menu-item ap-hist-danger" onClick={() => remove(e)}>
                      Remove from history
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className="ap-hist-label">{e.title || e.url}</div>
          </div>
        );
      })}
    </div>
  );
}
