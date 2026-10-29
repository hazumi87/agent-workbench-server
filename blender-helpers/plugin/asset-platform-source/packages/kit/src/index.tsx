// lineage: asset-platform/@asset/kit — created by domain-development (agent-user) — vk task 1a
//
// Kit entry point. Imports tokens (injected into the page by Vite) and self-
// registers the custom elements. Built to dist/asset-kit.js and deployed to the
// asset-tools gateway alongside the vanilla picker.js (gateway coexistence).
//
// GATE SPIKE 1 (three/R3F/drei resolution + clean pnpm bundle) PASSED on
// — 1,689 kB raw / 480 kB gzip with three bundled, no flat-tree shim
// needed. The throwaway wiring was removed; the three* deps remain declared in
// package.json for Step 4's real R3F GLB viewer (they are simply not imported
// yet, so they tree-shake out of this bundle).
// Import the token CSS as a raw STRING (Vite `?inline`) and inject it from JS,
// so a single <script src="asset-kit.js"> is all a gateway-served host page
// needs — no separate stylesheet link. (Vite lib/IIFE mode emits style.css but
// does not auto-inject it; self-injection keeps the coexistence story to one tag.)
import tokensCss from './tokens.css?inline';
import clipboardCss from './components/asset-clipboard.css?inline';
import audioPlayerCss from './components/audio-player.css?inline';
import pickerComponentsCss from './components/picker-components.css?inline';
import { registerAssetHello } from './spike-hello';
import { defineReactElement, type ReactElementContext } from './react-in-wc';
import { AssetClipboard } from './components/AssetClipboard';
import { AudioPlayer } from './components/AudioPlayer';
import { UrlHistory } from './components/UrlHistory';
import { ExportedClips } from './components/ExportedClips';
import { PickerPanel, type PanelTab } from './components/PickerPanel';
import { Picker } from './components/Picker';

function injectCss(id: string, css: string): void {
  if (document.getElementById(id)) return; // idempotent
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
}

injectCss('asset-kit-tokens', tokensCss);
injectCss('asset-kit-clipboard', clipboardCss);
injectCss('asset-kit-audio-player', audioPlayerCss);
injectCss('asset-kit-picker-components', pickerComponentsCss);

registerAssetHello();

// --- A3 picker components (consumed by tools via WC mounts) -----------------
// <asset-url-history source="…"> — selection bubbles as 'asset-url-history:select'.
defineReactElement(
  'asset-url-history',
  ({ attrs, emit }: ReactElementContext) => (
    <UrlHistory
      source={String(attrs.source ?? '')}
      removable={attrs.removable != null && String(attrs.removable) !== 'false'}
      onSelect={(e) => emit('asset-url-history:select', e)}
    />
  ),
  ['source', 'removable'],
);

// <asset-exported-clips source="…"> — selection bubbles as 'asset-exported-clips:select'.
defineReactElement(
  'asset-exported-clips',
  ({ attrs, emit }: ReactElementContext) => (
    <ExportedClips source={String(attrs.source ?? '')} onSelect={(e) => emit('asset-exported-clips:select', e)} />
  ),
  ['source'],
);

// <asset-picker base="…" title="…"> — legacy-mode clip list; selection bubbles as
// 'asset-picker:select' with {id,label,url,duration_s,source} (the vanilla onSelect
// payload). Consumed by demucs / audio-normalize / voice-filter.
defineReactElement(
  'asset-picker',
  ({ attrs, emit }: ReactElementContext) => (
    <Picker
      base={attrs.base ? String(attrs.base) : undefined}
      title={attrs.title ? String(attrs.title) : undefined}
      onSelect={(a) => emit('asset-picker:select', a)}
    />
  ),
  ['base', 'title'],
);

// <asset-picker-panel title="…" tabs='[{label,component,source}]'> — tabbed panel
// chrome; a tab's selection bubbles as 'asset-picker:select' {tab, entry}.
defineReactElement(
  'asset-picker-panel',
  ({ attrs, emit }: ReactElementContext) => {
    let tabs: PanelTab[] = [];
    try {
      tabs = attrs.tabs ? (JSON.parse(String(attrs.tabs)) as PanelTab[]) : [];
    } catch {
      tabs = [];
    }
    return <PickerPanel title={String(attrs.title ?? 'Picker')} tabs={tabs} emit={emit} />;
  },
  ['title', 'tabs'],
);

// <asset-audio-player src="…"> — shared audio player (A3, the "mount everywhere"
// primitive). Consumed by the clipboard and embeddable standalone by any host.
defineReactElement(
  'asset-audio-player',
  ({ attrs }: ReactElementContext) => (
    <AudioPlayer
      src={String(attrs.src ?? '')}
      preload={attrs.preload ? String(attrs.preload) : undefined}
      crossOrigin={
        attrs.crossorigin === 'use-credentials'
          ? 'use-credentials'
          : attrs.crossorigin === ''
            ? ''
            : 'anonymous'
      }
    />
  ),
  ['src', 'preload', 'crossorigin'],
);

// <asset-clipboard base="…"> — React port of the vanilla clipboard at parity (1b).
defineReactElement(
  'asset-clipboard',
  ({ attrs }: ReactElementContext) => (
    <AssetClipboard base={attrs.base ? String(attrs.base) : undefined} />
  ),
  ['base'],
);
