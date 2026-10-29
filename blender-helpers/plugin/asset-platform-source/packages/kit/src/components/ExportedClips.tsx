// lineage: asset-platform/@asset/kit — created by domain-development (agent-user) — task (Track A A3)
//
// React port of the vanilla picker's exported-clips component
// (buildExportedClipsComponent). A vertical list fetched from `source`
// ({clips:[{id,label,url,ts}]}); each row shows the label + an inline shared
// <AudioPlayer> for the clip url; clicking a row fires onSelect(clip). Exposed as
// the light-DOM WC <asset-exported-clips source="…"> (selection via the
// asset-exported-clips:select CustomEvent).
import { useEffect, useState } from 'react';
import { AudioPlayer } from './AudioPlayer';

export interface ExportedClip {
  id: string;
  label?: string;
  url: string;
  ts?: string;
}

export function ExportedClips({
  source,
  onSelect,
}: {
  source: string;
  onSelect?: (c: ExportedClip) => void;
}) {
  const [items, setItems] = useState<ExportedClip[] | null>(null);
  const [msg, setMsg] = useState('Loading…');

  useEffect(() => {
    let live = true;
    fetch(source, { credentials: 'same-origin' })
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then((d) => {
        if (!live) return;
        const c: ExportedClip[] = (d && d.clips) || [];
        if (!c.length) setMsg('No exported clips yet.');
        setItems(c);
      })
      .catch((e) => live && setMsg('Could not load clips: ' + e.message));
    return () => {
      live = false;
    };
  }, [source]);

  if (!items || !items.length) return <div className="ap-empty">{msg}</div>;

  return (
    <div className="ap-clips-list">
      {items.map((c) => (
        <div className="ap-row" key={c.id} onClick={() => onSelect?.(c)}>
          <div className="ap-row-top">
            <span className="ap-row-label">{c.label || c.id}</span>
          </div>
          <AudioPlayer src={c.url} />
        </div>
      ))}
    </div>
  );
}
