// Tasks preview and window page: the glue between the bridge, the model and the DOM. Clicks on
// data-view / data-group buttons drive the model; rooms.tasks from the host re-reads; the host's theme
// sets only --md-sys-color-* roles with plain colour values. The pop-out button (only once S3 builds the window) exists in the side
// preview only (the window is already popped out). Everything shown comes from model.html(), which
// escapes every value it did not compute.

import { createBridge } from './bridge.js';
import { createPreviewModel } from './preview-model.js';

const ROLE = /^--md-sys-color-[a-z-]{1,40}$/;
const COLOR = /^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla|oklch)\(\s*-?[\d.]+%?(\s*[, ]\s*-?[\d.]+%?){2}(\s*[,/]\s*[\d.]+%?)?\s*\))$/; // revision 7 item 4: the host's own set
const MAX_ROLES = 64;

export async function mountPreview({ doc, bridge, model, surface, popout = false, expanded = false }) {
  const app = doc.getElementById('app');
  let note = ''; // a refused pop-out, said in its own words (never a silent click)
  // the stylesheet lays the window out on its own above 640 px
  if (doc.documentElement && doc.documentElement.dataset) {
    doc.documentElement.dataset.surface = surface;
    // the web's expanded page (the design's Tasks §4): its own header and the three views; preview.css lays it out
    if (expanded) doc.documentElement.dataset.layout = 'expanded';
  }
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const render = () => {
    // the design (Client ): no control that does nothing, so the pop-out exists only once S3's window does
    // the pop-out: the desktop's own window (popout '1'), or on the web the full page as a tab (popout 'page', the owner's pattern)
    const pop = surface === 'preview' && popout === 'page'
      ? `<div class="tools"><button type="button" class="ib full" data-a="popout" aria-label="Open full page" title="Open full page"><svg class="i" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg><span class="lbl">Open full page</span></button></div>`
      : surface === 'preview' && popout === true
        ? `<div class="tools"><button type="button" class="ib" data-a="popout" aria-label="Open in its own window" title="Open in its own window">⧉</button></div>`
        : '';
    app.innerHTML = pop + (note ? `<p class="popnote" role="status">${esc(note)}</p>` : '') + model.html({ window: surface === 'window' });
    // positions and widths: data-l / data-w percent numbers, applied through CSSOM (the page's CSP has no
    // 'unsafe-inline'); only finite numbers, clamped to 0..100
    if (typeof app.querySelectorAll === 'function') {
      for (const el of app.querySelectorAll('[data-l],[data-w]')) {
        for (const [k, prop] of [['l', 'left'], ['w', 'width']]) {
          const raw = el.dataset[k];
          if (raw === undefined || !/^-?\d+(\.\d+)?$/.test(raw)) continue;
          el.style.setProperty(prop, Math.min(100, Math.max(0, Number(raw))) + '%');
        }
      }
    }
  };
  app.addEventListener('click', (e) => {
    const t = e.target;
    const v = t && t.closest && t.closest('[data-view]');
    if (v) {
      void model.setView(v.dataset.view).then(render);
      return;
    }
    const g = t && t.closest && t.closest('[data-group]');
    if (g) {
      void model.setGroup(g.dataset.group || null).then(render);
      return;
    }
    const a = t && t.closest && t.closest('[data-a]');
    if (a && a.dataset.a === 'back') { // the expanded page's own back arrow: the same fixed dismiss as Escape
      void bridge.call('dismiss', {}).catch(() => {});
      return;
    }
    if (a && a.dataset.a === 'popout') {
      note = '';
      void bridge.call('popout', {}).then(render, (e) => { // S3 opens the window; a refusal (the caps) is said here
        note = e && e.kind === 'refused' && e.message ? String(e.message).slice(0, 200) : popout === 'page' ? "Couldn't open the full page. Try again in a moment." : "Couldn't open the window. Try again in a moment.";
        render();
      });
    }
  });
  bridge.on('rooms.tasks', async () => {
    await model.changed();
    render();
  });
  bridge.on('theme', (vars) => {
    if (!vars || typeof vars !== 'object') return;
    let n = 0;
    for (const [k, v] of Object.entries(vars)) {
      if (n >= MAX_ROLES) break;
      if (ROLE.test(k) && typeof v === 'string' && v.trim().length <= 40 && COLOR.test(v.trim())) {
        doc.documentElement.style.setProperty(k, v.trim());
        n++;
      }
    }
  });
  // Escape in the side preview closes it (revision 7): a fixed dismiss over this page's own port, which the
  // host handles for this link only; the window (S3) has its own close
  if (surface === 'preview') {
    doc.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      void bridge.call('dismiss', {}).catch(() => {});
    });
  }
  await bridge.ready;
  await model.load();
  render();
  return { render };
}

// In the page itself (not under tests): wire the real bridge and model.
if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById && document.getElementById('app')) {
  const params = new URLSearchParams(location.search);
  const bridge = createBridge(window);
  const source = params.get('source') === 'room-tasks' ? 'room-tasks' : null; // revision 11
  const expanded = params.get('layout') === 'page' && !source; // the web host opened this page as the full page (a tab)
  const pop = source ? false : params.get('popout') === 'page' ? 'page' : params.get('popout') === '1'; // the window is the local Tasks view
  const model = createPreviewModel({ call: (verb, input) => bridge.call(verb, input), group: params.get('group') || null, source, expanded });
  const mounted = mountPreview({ doc: document, bridge, model, surface: params.get('surface') === 'window' ? 'window' : 'preview', popout: pop, expanded });
  // the throttled re-read (the model keeps the 2 s gap) repaints once it has read, unless the view closed
  setInterval(() => {
    void model.flush().then((read) => (read && !model.state().closed ? mounted.then((m) => m.render()) : undefined)).catch(() => {});
  }, 1000);
}
