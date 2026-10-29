import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './App.css';
import App from './App';
import { installGestureGuards } from './gestures';
import { normaliseLegacyRoute } from './shell/appRoute';

installGestureGuards();
// Old ?edit=<id> links → ?app=clip-editor&edit=<id>; the Clip Editor is an overlay route inside App.
normaliseLegacyRoute();

// ?thumbrender: a bare page for the mesh-thumbnail backfill worker (scripts/mesh-thumbs.mjs) —
// exposes window.__renderThumb(asset) → base64 JPEG and renders nothing else.
if (new URLSearchParams(location.search).has('thumbrender')) {
  import('./components/MeshViewer').then(m => {
    (window as unknown as Record<string, unknown>).__renderThumb = async (asset: Parameters<typeof m.renderThumbnail>[0]) => {
      const b = await m.renderThumbnail(asset);
      const bytes = new Uint8Array(await b.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    };
  });
} else if (new URLSearchParams(location.search).has('model')) {
  // ?model=<assetId>: a bare full-page 3D view of one Library mesh — no app, no chrome (,
  // for reviewing a model on a phone). Nothing else is rendered.
  import('./model-view').then(m => m.start(new URLSearchParams(location.search).get('model')!));
} else createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
