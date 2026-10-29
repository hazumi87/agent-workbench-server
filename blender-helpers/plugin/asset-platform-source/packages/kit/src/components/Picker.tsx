// lineage: asset-platform/@asset/kit — created by domain-development (agent-user) — task (Track A A3)
//
// React port of the vanilla picker's "picker" list component (legacy mount mode)
// — the clip list the legacy-mode tools (demucs, audio-normalize, voice-filter)
// consume. Fetches {base}/api/list, renders selectable rows with the shared
// <AudioPlayer>, and emits the vanilla onSelect payload
// {id,label,url,duration_s,source} on click. Exposed as the light-DOM WC
// <asset-picker base="…"> (selection via 'asset-picker:select').
//
// Scope note: the legacy vanilla mount also offered a Compare (A/B Web Audio) tab.
// demucs/audio-normalize/voice-filter use the SELECT flow (pick → process), not
// the picker's compare tab (voice-filter has its OWN A/B player), so parity for
// these tools is the selectable list. The kit's compare component is a separate
// later port if a tool ever needs it.
import { useCallback, useEffect, useState } from 'react';
import { AudioPlayer } from './AudioPlayer';

interface Clip {
  id: string;
  label?: string;
  filename?: string;
  file?: string;
  duration_s?: number | null;
  source?: string | null;
}

export interface PickerAsset {
  id: string;
  label: string;
  url: string;
  duration_s: number | null;
  source: string | null;
}

const DEFAULT_BASE = '/asset-management/library';

function fmtDur(s: number | null | undefined): string {
  if (s == null || isNaN(s)) return '—';
  const m = Math.floor(s / 60);
  const x = Math.floor(s % 60);
  return m + ':' + String(x).padStart(2, '0');
}

export function Picker({
  base = DEFAULT_BASE,
  title = 'Asset Clipboard',
  onSelect,
}: {
  base?: string;
  title?: string;
  onSelect?: (a: PickerAsset) => void;
}) {
  const [clips, setClips] = useState<Clip[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const creds: RequestCredentials = (() => {
    try {
      return new URL(base, location.href).origin === location.origin ? 'same-origin' : 'omit';
    } catch {
      return 'same-origin';
    }
  })();

  const load = useCallback(() => {
    fetch(base + '/api/list', { credentials: creds })
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then((d) => {
        setClips((d && d.clips) || []);
        setErr(null);
      })
      .catch((e) => setErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  useEffect(() => {
    load();
  }, [load]);

  const pick = (c: Clip) => {
    setSelected(c.id);
    onSelect?.({
      id: c.id,
      label: c.label || c.file || c.filename || 'clip ' + c.id,
      url: base + '/api/clip/' + encodeURIComponent(c.id),
      duration_s: c.duration_s ?? null,
      source: c.source ?? null,
    });
  };

  return (
    <div className="ap-panel-kit">
      <div className="ap-panel-head">
        {title}
        <button className="ap-refresh" title="Refresh" onClick={() => load()}>
          ⟳
        </button>
      </div>
      <div className="ap-view">
        {err ? (
          <div className="ap-error">Could not load: {err}</div>
        ) : !clips.length ? (
          <div className="ap-empty">No clips yet.</div>
        ) : (
          <div className="ap-clips-list">
            {clips.map((c) => (
              <div
                className={'ap-row' + (selected === c.id ? ' ap-selected' : '')}
                key={c.id}
                onClick={() => pick(c)}
              >
                <div className="ap-row-top">
                  <span className="ap-row-label">{c.label || c.file || c.filename || 'clip ' + c.id}</span>
                  <span className="ap-row-dur">{fmtDur(c.duration_s)}</span>
                </div>
                <AudioPlayer src={base + '/api/clip/' + encodeURIComponent(c.id)} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
