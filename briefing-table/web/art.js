/* PROJECT ART — master/detail manager.
 *
 * Not "icons" and not "Harbor" (Owner, 2026-09-21): harbor is the supervisor the
 * engine happens to run under, and what this page owns is a project's visual
 * identity — its COLOR, the watermark behind its terminals, and the mark on its
 * tabs. Served at /art.html, with /icons.* kept as an engine alias so every
 * bookmark, restored shell tab and already-running manager page still resolves
 * (src/server/index.ts PATH_ALIASES).
 *
 * Was a study surface (a horse race across simplification pipelines, scored on
 * mush and fidelity). That work is DONE: 101 human verdicts settled the
 * pipeline as trace@512 + SVGO, it is baked into /api/icon-lab/import, and the
 * reasoning lives in the design notes. Keeping the lab on screen would
 * be keeping the workings on a solved sum.
 *
 * What replaced it is what the page is for day to day: pick a set, see it at
 * BOTH sizes it is used at, and manage it. The driving case is two sets both
 * called "hearth" — one 74.8 KB / 31 paths from an online tracer, one 21.6 KB /
 * 1 path from the local import. Telling them apart needs the facts on screen,
 * so the facts ARE the detail pane, not decoration on it.
 */
import { LOGO_PRESETS } from '/vendor/aurora-logo-presets.js';
import {
  LOGO_DEFAULTS, WM_LINES, WM_WASH_FROM,
  sanitizeSvg, fitViewBox, renderLogo, paintWatermarkVars, assetStyle, applyMarkStyle,
} from '/logo-modal.mjs';

const els = {
  counts: document.getElementById('counts'),
  yours: document.getElementById('listYours'),
  system: document.getElementById('listSystem'),
  detail: document.getElementById('detail'),
  addBtn: document.getElementById('addBtn'),
  file: document.getElementById('fileInput'),
};

let library = [];     // user sets, from /api/logos
let selected = null;  // { kind:'lib'|'sys', id?, key?, name, svg, prev? }
let fileMode = 'add'; // what the shared file input is currently for

/* A REAL transcript, not a token sample. The watermark test is "can I still
 * read the terminal through it", and a half-empty pane never asks that
 * question — the text has to run the full height, across the densest part of
 * the mark, in the shapes a session actually produces: tool-call bullets,
 * indented output, elision markers, diffs, prose. Owner, 2026-09-03. */
const TRANSCRIPT = [
  '● Bash(node test/icons-page.probe.mjs 2>&1 | tail -4)',
  '  ⎿  PASS  no horizontal page overflow',
  '     PASS  probe left the library the size it found it  — 7 → 7',
  '     … +4 lines (ctrl+o to expand)',
  '  ⎿  (timeout 10m)',
  '',
  '● Read(src/engine/widget-status.ts)',
  '  ⎿  Read 121 lines',
  '',
  '● The refresh was demand-driven by the viewer: refresh() was only ever called',
  '  from inside the /api/table handler, so the cache was warmed by whoever',
  '  happened to be looking. Lorem ipsum dolor sit amet, consectetur adipiscing',
  '  elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut',
  '  enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut.',
  '',
  '● Update(web/manager.css)',
  '  ⎿  Updated web/manager.css with 12 additions and 3 removals',
  '     312    .live-widget { flex: 0 0 auto; }',
  '     313 +  /* UNSHRINKABLE — the number in it is the whole value. */',
  '     314 +  .live-meta { min-width: 0; white-space: nowrap; }',
  '',
  '● Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore',
  '  eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident,',
  '  sunt in culpa qui officia deserunt mollit anim id est laborum. Sed ut',
  '  perspiciatis unde omnis iste natus error sit voluptatem accusantium.',
  '',
  '● Bash(npm test 2>&1 | tail -3)',
  '  ⎿  PASS 225  FAIL 0',
  '     all green',
].join('\n');

/* ---------------------------------------------------------------- facts ---
 * The numbers that let two similarly-named sets be told apart. `paths` is the
 * cheap proxy for "how much geometry is in here" — the thing that decides
 * whether a mark survives 20px — and size follows it. The three flags are the
 * defects that make art unusable in a tab: no viewBox (cannot scale into the
 * box), no xmlns (invalid the moment it is treated as a file), baked fills
 * (beats currentColor, so it paints black on a dark titlebar).
 */
function factsFor(svg) {
  const s = String(svg || '');
  const bad = [];
  if (!/\bviewBox\s*=/i.test(s)) {
    bad.push('no viewBox');
  }
  if (!/<svg\b[^>]*\bxmlns\s*=/i.test(s)) {
    bad.push('no xmlns');
  }
  if (/\b(?:fill|stroke)\s*=\s*["'](?!none|currentColor|url\()/i.test(s)) {
    bad.push('baked fills');
  }
  return { bytes: s.length, paths: (s.match(/<path\b/gi) || []).length, bad };
}

/** Mount offscreen so fitViewBox can measure, hand back repaired markup. */
function fitted(svg) {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:0;width:240px;height:240px;';
  host.innerHTML = sanitizeSvg(svg);
  document.body.appendChild(host);
  fitViewBox(host, false);
  const out = host.innerHTML;
  host.remove();
  return out;
}

/* ---- THE PREVIEW PAINTS IN THE PROJECT'S OWN COLOR ------------------------
 *
 * There used to be a row of tint swatches in the header, from when this page
 * was a study: you picked a color and EVERY preview rendered in it. That made
 * sense while the question was "how does this art behave under a tint" and
 * stopped making sense the moment each project's art carried its own color —
 * at which point an override does not illustrate the thing, it HIDES it (Owner,
 * 2026-09-21: "that's setting all the colors and not displaying the project
 * colors").
 *
 * So the selected project's color IS the page's tint. `--base` still drives the
 * derived chrome tokens exactly as before; only the source changed, from a
 * human picking one for everything to the art stating its own.
 */
const NEUTRAL_BASE = '#e9edf1'; // art that states no color yet — the same neutral the chrome falls back to

let tintHex = null;
let repaintWatermark = null;

function applyTint(hex) {
  tintHex = hex || NEUTRAL_BASE;
  /* SCOPED TO THE DETAIL PANE. On :root this leaked into every row in the list
     and repainted the whole column on each selection. */
  els.detail.style.setProperty('--base', tintHex);
  if (repaintWatermark) {
    repaintWatermark();
  }
}

/* ------------------------------------------------------------- the list ---
 * Grouped, because the two halves have different rights: the design system presets are
 * a Contract-A pin ("pin, never fork") and are read-only here, while the
 * library is yours to rename, replace and delete. One flat list would invite
 * editing something that cannot be edited.
 */
const isSelected = (s) =>
  !!selected &&
  selected.kind === s.kind &&
  (s.kind === 'lib' ? selected.id === s.id : selected.key === s.key);

function row(set) {
  const el = document.createElement('button');
  el.className = 'ic-row' + (isSelected(set) ? ' is-sel' : '');
  /* EACH ROW CARRIES ITS OWN COLOR, so the column can be SCANNED — which is the
     one thing the list is for: spotting two projects whose colors are too close
     to tell apart. A page-level tint made every row show the selected
     project's color instead. */
  const own = assetStyle(set).color;
  if (own) {
    el.style.setProperty('--base', own);
  }
  const f = factsFor(set.svg);
  const mark = document.createElement('span');
  mark.className = 'ic-row-mark';
  mark.innerHTML = fitted(set.svg);
  const body = document.createElement('span');
  body.className = 'ic-row-body';
  const nm = document.createElement('span');
  nm.className = 'ic-row-name';
  nm.textContent = set.name;
  const meta = document.createElement('span');
  meta.className = 'ic-row-meta' + (f.bad.length ? ' has-bad' : '');
  meta.textContent =
    `${f.paths}p · ${(f.bytes / 1024).toFixed(1)}K` +
    (f.bad.length ? ` · ${f.bad.length} issue${f.bad.length > 1 ? 's' : ''}` : '');
  body.append(nm, meta);
  el.append(mark, body);
  el.addEventListener('click', () => {
    selected = set;
    render();
  });
  return el;
}

function renderList() {
  /* CARRY `style`. This projection is what the detail pane reads, and dropping
     a field here makes a stored value invisible without any error anywhere —
     the art saved its treatment correctly and the bar repainted defaults, which
     reads exactly like "it did not save". */
  const yours = library.map((l) => ({
    kind: 'lib',
    id: l.id,
    name: l.name,
    svg: l.svg,
    prev: l.prev_svg,
    style: l.style,
  }));
  const system = Object.entries(LOGO_PRESETS)
    .filter(([k]) => !k.startsWith('lib:'))
    .map(([k, svg]) => ({ kind: 'sys', key: k, name: k, svg }));

  const head = (t, n) => {
    const h = document.createElement('div');
    h.className = 'ic-group-head';
    h.textContent = `${t} (${n})`;
    return h;
  };
  els.yours.innerHTML = '';
  els.system.innerHTML = '';
  els.yours.appendChild(head('Yours', yours.length));
  yours.forEach((s) => els.yours.appendChild(row(s)));
  els.system.appendChild(head('System · read-only', system.length));
  system.forEach((s) => els.system.appendChild(row(s)));
  els.counts.textContent = `${yours.length} yours · ${system.length} system`;
}

/* ----------------------------------------------------------- the detail ---
 * BOTH sizes the art is actually used at, because they fail in opposite
 * directions: the tab mark is 20 CSS px and is destroyed by detail, the
 * watermark is ~80% of a pane and rewards it. Judging one tells you nothing
 * about the other.
 */
/* ------------------------------------------------------- the art's style ---
 * WHERE EACH SETTING LIVES IS the design system RULING, not a preference of ours.
 * hwb-watermark.css says it in its own header: "line style per logo, chosen in
 * the engine's icon editor" and "each recipe keeps its own scale / opacity".
 * So the ART carries line / wash origin / backlit, plus the DEFAULT scale and
 * opacity a recipe inherits when it picks that art and may then override.
 *
 * This page is also the only surface that CAN show what they do. The line
 * styles are the v21 PANE rendering — stroke overrides and CSS masks that need
 * `.wm-pane` and a project hue around them — and are invisible in the flat
 * ghost the recipe modal previewed with, which is exactly why its Line select
 * looked dead. Here the mark is painted into a mock session pane, so the
 * preview IS the thing.
 */
const clampPc = (v, dflt) =>
  (Number.isFinite(+v) ? Math.min(100, Math.max(1, Math.round(+v))) : dflt);

function renderDetail() {
  if (!selected) {
    repaintWatermark = null; // the element it closed over is about to be gone
    els.detail.innerHTML = '<div class="ic-empty">Select an icon set on the left.</div>';
    return;
  }
  const set = selected;
  const f = factsFor(set.svg);
  const locked = set.kind === 'sys';
  const markSvg = fitted(set.svg);

  els.detail.innerHTML = [
    '<div class="ic-d-head">',
    '  <span class="ic-d-name"></span>',
    '  <span class="ic-d-badge"></span>',
    '  <span class="ic-d-actions"></span>',
    '</div>',
    '<div class="ic-style">',
    /* COLOR LEADS, because it is the project's identity and everything else on
       this bar is a treatment OF it — the watermark's ink, the wash and the tab
       mark's tint all derive from this one value. Owner, 2026-09-21: the color
       belongs with the icon, not repeated across every recipe that wears it. */
    '  <span class="ic-style-for">Project</span>',
    '  <label>Color <input type="color" data-s="color" /></label>',
    '  <button type="button" class="btn btn-ghost ic-color-clear" data-s="colorclear" title="Let each recipe keep its own color again">clear</button>',
    `  <label>Line <select data-s="line">${WM_LINES.map((v) => `<option value="${v}">${v}</option>`).join('')}</select></label>`,
    '  <label>Scale % <input type="number" data-s="scale" min="5" max="100" /></label>',
    '  <label>Opacity % <input type="number" data-s="opacity" min="1" max="100" /></label>',
    `  <label>Wash from <select data-s="washFrom">${WM_WASH_FROM.map((v) => `<option value="${v}">${v}</option>`).join('')}</select></label>`,
    '  <label>Backlit <select data-s="backlit"><option value="1">On</option><option value="0">Off</option></select></label>',
    '  <span class="ic-style-note" data-s="note"></span>',
    '</div>',
    /* THE TAB MARK IS THE ART'S SECOND SURFACE and it fails the other way: at
       20px, line art anti-aliases to a pale edge that reads as a white outline
       (runtime). These two are PRESENTATION, never shape - the design system ruling
       stands that art is never thickened, simplified or auto-swapped. */
    '<div class="ic-style ic-style-mark">',
    '  <span class="ic-style-for">Tab mark</span>',
    '  <label>Opacity % <input type="number" data-m="opacity" min="10" max="100" /></label>',
    '  <label>Tint <select data-m="tintmode"><option value="auto">Project color</option><option value="fixed">Fixed…</option></select></label>',
    '  <label class="ic-tint-pick" data-m="pickwrap" hidden><input type="color" data-m="tint" /></label>',
    '  <span class="ic-style-note" data-m="note"></span>',
    '</div>',
    '<div class="ic-frame">',
    '  <div class="ic-tabstrip">',
    '    <div class="ic-tab"><span class="ic-tlogo"></span><span class="ic-tabname"></span></div>',
    '    <div class="ic-tab is-inactive"><span class="ic-tlogo"></span><span class="ic-tabname">inactive</span></div>',
    '  </div>',
    '  <div class="ic-pane">',
    '    <span class="ic-wm"></span>',
    '    <pre class="ic-lorem"></pre>',
    '    <div class="ic-chrome">',
    '      <div class="ic-rule"></div>',
    '      <div class="ic-composer">&gt; <span class="ic-caret">▊</span></div>',
    '      <div class="ic-rule"></div>',
    '      <div class="ic-status">⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents</div>',
    '    </div>',
    '  </div>',
    '</div>',
    '<div class="ic-sizes">',
    '  <div class="ic-size"><span class="ic-size-box s20"></span><span class="ic-size-cap">tab mark · 20px</span></div>',
    '  <div class="ic-size"><span class="ic-size-box s40"></span><span class="ic-size-cap">40px</span></div>',
    '  <div class="ic-size"><span class="ic-size-box s64"></span><span class="ic-size-cap">64px</span></div>',
    '</div>',
    '<div class="ic-facts"></div>',
  ].join('\n');

  els.detail.querySelector('.ic-d-name').textContent = set.name;
  const badge = els.detail.querySelector('.ic-d-badge');
  badge.textContent = locked ? 'Built-in · read-only' : `lib:${set.id}`;
  badge.classList.toggle('is-locked', locked);
  els.detail.querySelector('.ic-tabname').textContent = set.name;
  els.detail.querySelector('.ic-lorem').textContent = TRANSCRIPT;

  els.detail.querySelectorAll('.ic-tlogo').forEach((h) => {
    h.innerHTML = markSvg;
  });
  els.detail.querySelectorAll('.ic-size-box').forEach((b) => {
    b.innerHTML = markSvg;
  });
  /* THE PREVIEW IS THE v21 PANE RENDERING, not the flat ghost: `.wm-pane` for
     the directional wash, `--wm-pc` for the project hue (the header tints pick
     it), `--wm-op` for strength, and the `.wm-line-*` classes on the <svg>.
     Anything less cannot show a line style at all. */
  const st = assetStyle(set);
  const pane = els.detail.querySelector('.ic-pane');
  const wmHost = els.detail.querySelector('.ic-wm');
  const sEl = (k) => els.detail.querySelector(`[data-s="${k}"]`);
  const note = sEl('note');

  /* Both surfaces repaint together: the watermark from the wm fields, and every
     mark box (the mock tab strip AND the true-size row) from the mark fields.
     Judging one tells you nothing about the other, which is the whole reason
     this page shows both at once. */
  const paintMarks = () => {
    els.detail.querySelectorAll('.ic-tlogo, .ic-size-box').forEach((h) => {
      applyMarkStyle(h, st.mark);
    });
  };
  const paint = () => {
    const logo = { svg: set.svg, ...st };
    paintWatermarkVars(pane, logo, tintHex);
    renderLogo(wmHost, logo, { pane });
    paintMarks();
  };
  repaintWatermark = paint; // so a tint change repaints without a full rerender
  /* THE SELECTED PROJECT'S COLOR IS THE PAGE'S TINT. Set before the first
     paint so nothing renders in the previous project's color for a frame. */
  applyTint(st.color);

  sEl('color').value = st.color || NEUTRAL_BASE;
  els.detail.querySelector('[data-s="colorclear"]').hidden = !st.color;
  sEl('line').value = st.line;
  sEl('washFrom').value = st.washFrom;
  sEl('backlit').value = st.backlit ? '1' : '0';
  sEl('scale').value = String(st.scale);
  sEl('opacity').value = String(st.opacity);
  paint();

  /* the design system presets are a Contract-A pin, so their style is NOT persisted
     here — but the controls still work, because judging a preset's line style
     against a real pane is the whole reason to come to this page. Say which it
     is rather than greying them out and leaving the question unanswerable. */
  const explain = locked
    ? 'preview only — built-in preset (a pin; not stored)'
    : 'color · line · wash · backlit belong to the art — every session of this project follows them; scale and opacity are defaults a recipe may override';
  note.textContent = explain;
  note.classList.remove('is-bad');

  let saveTimer = null;
  const persist = () => {
    if (locked) {
      return;
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/logos/${set.id}`, {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ style: st }),
        });
        if (!r.ok) {
          throw new Error(`HTTP ${r.status}`);
        }
        set.style = { ...st };
        note.textContent = 'saved';
        note.classList.remove('is-bad');
      } catch (e) {
        /* The engine half (a `style` column + PATCH branch) may not be in yet.
           The controls and the preview are still worth having, so say the
           truth instead of failing silently — the 2026-09-04 rule: news that
           the transport drops is news nobody has. */
        note.textContent = `not saved (${String(e.message || e)}) — the art keeps its old style`;
        note.classList.add('is-bad');
      }
    }, 400);
  };

  const mEl = (k) => els.detail.querySelector(`[data-m="${k}"]`);
  mEl('opacity').value = String(st.mark.opacity);
  const fixed = st.mark.tint !== 'auto';
  mEl('tintmode').value = fixed ? 'fixed' : 'auto';
  mEl('pickwrap').hidden = !fixed;
  /* The picker needs a concrete value even in `auto`: an <input type="color">
     with no value is black, which would look like a deliberate choice the
     moment someone switches to Fixed. Seed it with the previewed project
     colour so switching starts from where the eye already is. */
  mEl('tint').value = fixed ? st.mark.tint : (tintHex || '#e9edf1');
  mEl('note').textContent = locked
    ? 'preview only — built-in preset'
    : 'presentation only — the art is never thickened or simplified';

  const readMark = () => {
    const mode = mEl('tintmode').value;
    mEl('pickwrap').hidden = mode !== 'fixed';
    st.mark = {
      opacity: clampPc(mEl('opacity').value, 100),
      tint: mode === 'fixed' ? mEl('tint').value : 'auto',
    };
    paintMarks();
    persist();
  };
  ['opacity', 'tintmode', 'tint'].forEach((k) => {
    mEl(k).addEventListener('input', readMark);
  });

  /* Setting it here is what makes every session of the project agree; clearing
     it hands each recipe back its own, which is the only way out again. */
  sEl('color').addEventListener('input', () => {
    st.color = sEl('color').value;
    els.detail.querySelector('[data-s="colorclear"]').hidden = false;
    applyTint(st.color); // preview everything in it at once
    paint();
    persist();
  });
  els.detail.querySelector('[data-s="colorclear"]').addEventListener('click', () => {
    st.color = null;
    els.detail.querySelector('[data-s="colorclear"]').hidden = true;
    persist();
  });

  ['line', 'washFrom', 'backlit', 'scale', 'opacity'].forEach((k) => {
    sEl(k).addEventListener('input', () => {
      if (k === 'backlit') {
        st.backlit = sEl(k).value === '1';
      } else if (k === 'scale' || k === 'opacity') {
        st[k] = clampPc(sEl(k).value, LOGO_DEFAULTS[k]);
      } else {
        st[k] = sEl(k).value;
      }
      paint();
      persist();
    });
  });

  const facts = els.detail.querySelector('.ic-facts');
  const chip = (t, cls) => {
    const s = document.createElement('span');
    s.className = cls || '';
    s.textContent = t;
    facts.appendChild(s);
  };
  chip(`${f.paths} path${f.paths === 1 ? '' : 's'}`);
  chip(`${(f.bytes / 1024).toFixed(1)} KB`);
  if (f.bad.length) {
    f.bad.forEach((b) => chip(b, 'bad'));
  } else {
    chip('viewBox · xmlns · inherits color', 'good');
  }

  /* Actions live only on YOUR sets. the design system are a pin, and editing one here
     would fork it — the thing Contract A exists to prevent. */
  if (locked) {
    return;
  }
  const acts = els.detail.querySelector('.ic-d-actions');
  const btn = (label, title, fn, cls) => {
    const b = document.createElement('button');
    b.className = 'btn ' + (cls || '');
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', fn);
    acts.appendChild(b);
  };
  btn('Rename', 'Change the label. The key is lib:<id>, so panes wearing this mark are unaffected.', async () => {
    const name = prompt('Rename icon set', set.name);
    if (name && name.trim() && name !== set.name) {
      await patch(set.id, { name: name.trim() });
    }
  });
  btn('Replace image…', 'Swap the art, keeping one step of undo', () => {
    fileMode = 'replace';
    els.file.click();
  });
  if (set.prev) {
    btn('Revert', 'Swap back to the previous art (press again to swap forward)', async () => {
      await patch(set.id, { revert: true });
    });
  }
  btn(
    'Delete',
    'Remove this set',
    async () => {
      if (confirm(`Delete "${set.name}"? Panes wearing it fall back to a stock mark.`)) {
        await fetch(`/api/logos/${set.id}`, { method: 'DELETE', credentials: 'same-origin' });
        selected = null;
        await load();
      }
    },
    'btn-ghost ic-danger',
  );
}

function render() {
  renderList();
  renderDetail();
}

async function patch(id, body) {
  const r = await fetch(`/api/logos/${id}`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) {
    alert(j.error || `HTTP ${r.status}`);
    return;
  }
  await load(j.logo.id);
}

/* ---- file input, shared by Add and Replace ---------------------------- */
els.addBtn.addEventListener('click', () => {
  fileMode = 'add';
  els.file.click();
});

function readDataUrl(file) {
  return new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.readAsDataURL(file);
  });
}

els.file.addEventListener('change', async () => {
  const file = els.file.files[0];
  els.file.value = ''; // so picking the SAME file twice still fires
  if (!file) {
    return;
  }
  const isSvg = /svg/i.test(file.type) || /\.svg$/i.test(file.name);
  const payload = isSvg ? await file.text() : await readDataUrl(file);

  if (fileMode === 'replace' && selected && selected.kind === 'lib') {
    /* A raster cannot be swapped in directly — it has to be traced first, which
       is what /import does. So a PNG replace runs the import, lifts the SVG out
       of the throwaway set it creates, and swaps THAT into this set, keeping
       the identity (and therefore every pane wearing it) intact. */
    let svg = payload;
    if (!isSvg) {
      const r = await fetch('/api/icon-lab/import', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ png: payload, name: `__replace_${Date.now()}` }),
      });
      const j = await r.json();
      if (!r.ok) {
        alert(j.error || 'trace failed');
        return;
      }
      svg = j.logo.svg;
      await fetch(`/api/logos/${j.logo.id}`, { method: 'DELETE', credentials: 'same-origin' });
    }
    await patch(selected.id, { svg });
    return;
  }

  const name = prompt('Name this icon set', file.name.replace(/\.[^.]+$/, ''));
  if (!name || !name.trim()) {
    return;
  }
  const r = await fetch('/api/icon-lab/import', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(isSvg ? { svg: payload, name: name.trim() } : { png: payload, name: name.trim() }),
  });
  const j = await r.json();
  if (!r.ok) {
    alert(j.error || `HTTP ${r.status}`);
    return;
  }
  await load(j.logo.id);
});

async function load(selectId) {
  try {
    const r = await fetch('/api/logos', { credentials: 'same-origin' });
    library = r.ok ? (await r.json()).logos || [] : [];
  } catch {
    library = [];
  }
  const pick = (l) => ({ kind: 'lib', id: l.id, name: l.name, svg: l.svg, prev: l.prev_svg });
  if (selectId != null) {
    const l = library.find((x) => x.id === selectId);
    if (l) {
      selected = pick(l);
    }
  } else if (selected?.kind === 'lib') {
    const l = library.find((x) => x.id === selected.id);
    selected = l ? pick(l) : null;
  }
  render();
}

load();
