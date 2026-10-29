// lineage: asset-platform/@asset/kit — created by domain-development (agent-user) — task (Track A A3)
//
// <asset-picker-panel> — the kit's tabbed panel chrome, reproducing the vanilla
// AssetPicker's tab bar for tools that mounted with tabs (e.g. yt-audio). Driven
// by a `tabs` JSON attribute: [{label, component:'url-history'|'exported-clips',
// source}]. Renders the active tab's kit component; a tab's selection bubbles up
// as a CustomEvent on the host: 'asset-picker:select' with detail {tab, entry}.
// This is the WC-mount way to consume kit components (blueprint §2 step 3) — not
// a global window.AssetPicker shim.
import { useState } from 'react';
import { UrlHistory } from './UrlHistory';
import { ExportedClips } from './ExportedClips';

export interface PanelTab {
  label: string;
  component: 'url-history' | 'exported-clips';
  source: string;
  /** url-history only: show the per-card ⋮ menu with "Remove from history". */
  removable?: boolean;
}

export function PickerPanel({
  title,
  tabs,
  emit,
}: {
  title: string;
  tabs: PanelTab[];
  emit: (type: string, detail?: unknown) => void;
}) {
  const [active, setActive] = useState(0);
  const tab = tabs[active];

  return (
    <div className="ap-panel-kit">
      <div className="ap-panel-head">{title}</div>
      {tabs.length > 1 && (
        <div className="ap-tabs">
          {tabs.map((t, i) => (
            <button
              key={t.label}
              className={'ap-tab' + (i === active ? ' ap-tab-active' : '')}
              onClick={() => setActive(i)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div className="ap-view">
        {tab?.component === 'url-history' && (
          <UrlHistory source={tab.source} removable={!!tab.removable} onSelect={(entry) => emit('asset-picker:select', { tab: tab.label, entry })} />
        )}
        {tab?.component === 'exported-clips' && (
          <ExportedClips source={tab.source} onSelect={(entry) => emit('asset-picker:select', { tab: tab.label, entry })} />
        )}
      </div>
    </div>
  );
}
