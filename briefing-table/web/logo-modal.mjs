/* Shared "ghosted CLI logo" editor (CLI Manager phase) — the design system parity + a
 * reusable named-SVG library.
 *
 * the design system cli-arrangement-v6 specs a ghosted project logo behind the terminal:
 * paste an SVG (or pick a preset), set scale (% of pane width), mono color
 * (white/black), and opacity. Stored per session as one object
 * {svg, scale, mono, opacity}.
 *
 * On top of the design system built-in presets we add a LIBRARY: pick "➕ Add a new SVG…",
 * name it, and it's stored server-side (`/api/logos`) for recall from any
 * window's picker. Leave the picker on "— choose —" and the logo is session-only
 * (lives on the recipe, not the library). Switching to "Add a new SVG…" never
 * clears the SVG box — so a one-off can be promoted to a named, stored logo.
 *
 * The logo travels the seam as a JSON STRING in the `logo` pref channel; only
 * these UIs parse/serialize it. renderLogo() paints it; openLogoModal() edits it.
 */
import { LOGO_PRESETS } from '/vendor/aurora-logo-presets.js';
import { sanitizeSvgText } from '/svg-sanitize.mjs';

export const LOGO_DEFAULTS = { scale: 80, mono: 'white', opacity: 10, line: 'none', washFrom: 'll-mid', backlit: true };

/* v21 watermark treatment (the design system window-chrome v21). Three fields on the same
 * opaque `logo` JSON, each with a default so every logo stored before v21 reads
 * as `none / ll-mid / backlit` with no migration. The look is the bundle's
 * hwb-watermark.css; renderLogo({pane}) applies its classes. */
export const WM_LINES = ['none', 'outline', 'blueprint', 'hatch', 'engrave', 'halftone'];
export const WM_WASH_FROM = ['ul', 'ur', 'll', 'lr', 'c', 'll-mid'];

/** The v21 fields of a logo, defaulted and validated (an unknown value reads as
 *  the default rather than minting a class nobody styles). */
export function wmFields(logo) {
  const l = logo || {};
  return {
    line: WM_LINES.includes(l.line) ? l.line : LOGO_DEFAULTS.line,
    washFrom: WM_WASH_FROM.includes(l.washFrom) ? l.washFrom : LOGO_DEFAULTS.washFrom,
    backlit: typeof l.backlit === 'boolean' ? l.backlit : LOGO_DEFAULTS.backlit,
  };
}

/** Pane-level custom properties the v21 watermark CSS reads: `--wm-pc` (the
 *  recipe colour — the ONLY hue the watermark paints with) and `--wm-op` (the
 *  logo's own opacity, 0..1; each recipe keeps its own). */
export function paintWatermarkVars(paneEl, logo, color) {
  if (!paneEl) {
    return;
  }
  if (color) {
    paneEl.style.setProperty('--wm-pc', color);
  } else {
    paneEl.style.removeProperty('--wm-pc');
  }
  if (logo && logo.svg) {
    paneEl.style.setProperty('--wm-op', String((logo.opacity != null ? logo.opacity : 10) / 100));
  } else {
    paneEl.style.removeProperty('--wm-op');
  }
}
const NEW_VALUE = '__new__';

/** A library set's stored style (`{line, washFrom, backlit, scale, opacity}`),
 *  defaulted. The field is one opaque JSON blob on the set, exactly as the
 *  recipe's own logo pref is — the engine stores and serves it, the UIs are
 *  the only things that parse it. A set saved before the field existed, or an
 *  the design system preset (which has none), reads as LOGO_DEFAULTS. */
export function assetStyle(asset) {
  let s = asset && asset.style;
  if (typeof s === 'string') {
    try {
      s = JSON.parse(s);
    } catch {
      s = null;
    }
  }
  s = s || {};
  const pc = (v, d) => (Number.isFinite(+v) ? Math.min(100, Math.max(1, Math.round(+v))) : d);
  return {
    ...wmFields(s),
    scale: pc(s.scale, LOGO_DEFAULTS.scale),
    opacity: pc(s.opacity, LOGO_DEFAULTS.opacity),
    mark: markFields(s.mark),
    /* THE PROJECT'S COLOR, on the art (Owner, 2026-09-21). Null means the art
       states none and a recipe's own value still stands — which is what every
       piece of art says until someone sets one here. */
    color: typeof s.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.color) ? s.color : null,
  };
}

/** The TAB MARK's treatment — the art's second surface (the design notes §4).
 *
 *  Separate from the watermark's fields because the two fail in opposite
 *  directions: the watermark is ~80% of a pane and rewards detail, the mark is
 *  20 CSS px and is destroyed by it. Line art (runtime's hollow ring and rack)
 *  anti-aliases to a pale edge at that size, which reads as a white outline.
 *
 *  THESE ARE PRESENTATION KNOBS, NOT SHAPE TRANSFORMS, and that line is
 *  the design system (2026-09-20): never thicken, simplify or auto-swap art — below
 *  ~24px prefer a solid variant where one exists. Dimming the mark or tinting
 *  it away from the brightest value on a dark tab changes how loud the edge is
 *  without touching the drawing, which is the one lever the icon-lab verdicts
 *  left open.
 *
 *  `tint: 'auto'` is today's behaviour exactly — `currentColor`, i.e. whatever
 *  the chrome derives from the project hue — so a set that has never been
 *  tuned renders byte-identically to before.
 */
export const MARK_DEFAULTS = { opacity: 100, tint: 'auto' };

export function markFields(m) {
  const o = m || {};
  const op = Number.isFinite(+o.opacity) ? Math.min(100, Math.max(10, Math.round(+o.opacity))) : MARK_DEFAULTS.opacity;
  const tint = typeof o.tint === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.tint) ? o.tint : MARK_DEFAULTS.tint;
  return { opacity: op, tint };
}

/** Paint a mark host (a 20/40/64px box, or a mock tab's glyph) with the art's
 *  mark treatment. The SVG itself is never edited — only the host's colour and
 *  opacity — so the stored art stays what the user imported. */
export function applyMarkStyle(hostEl, mark) {
  if (!hostEl) {
    return;
  }
  const m = markFields(mark);
  hostEl.style.opacity = String(m.opacity / 100);
  if (m.tint === 'auto') {
    hostEl.style.removeProperty('color');
  } else {
    hostEl.style.color = m.tint;
  }
}

/** Parse the stored JSON string → logo object, or null. Tolerant of null/''/junk. */
export function parseLogo(raw) {
  if (!raw || typeof raw !== 'string') {
    return null;
  }
  try {
    const o = JSON.parse(raw);
    return o && o.svg ? o : null;
  } catch {
    return null;
  }
}

/**
 * Strip an intrinsic size forced onto the ROOT <svg> (width/height attrs, and
 * width/height in its style) — but ONLY when it has a viewBox, so scaling still
 * has a coordinate system. Tools like PowerPoint bake a fixed px size in; left
 * in, it overrides our `scale` (% of pane). Only the root tag is touched, never
 * inner geometry (e.g. `<rect width=…>`).
 */
export function stripSvgSize(svg) {
  return String(svg || '').replace(/<svg\b[^>]*>/i, (tag) => {
    if (!/\bviewBox\s*=/i.test(tag)) {
      return tag; // no coordinate system → keep the size, or it collapses
    }
    return tag
      .replace(/\s(?:width|height)\s*=\s*"[^"]*"/gi, '')
      .replace(/\s(?:width|height)\s*=\s*'[^']*'/gi, '')
      .replace(/\s(?:width|height)\s*=\s*[^\s>]+/gi, '')
      .replace(/\sstyle\s*=\s*"([^"]*)"/i, (m, s) => {
        const cleaned = s
          .replace(/(?:^|;)\s*(?:width|height)\s*:[^;]*/gi, '')
          .replace(/^\s*;+/, '')
          .trim();
        return cleaned ? ` style="${cleaned}"` : '';
      });
  });
}

/**
 * Hand every baked-in colour over to the `mono` control.
 *
 * This logo is a GHOST: one colour, white or black, at low opacity. A real
 * exported SVG arrives with `fill="[ref]"` on every path, and a presentation
 * attribute on the path beats the `fill: currentColor` the stylesheet puts on
 * the <svg> — inheritance is the weaker source. So a black-filled logo stayed
 * black on a black pane at 10% opacity: invisible, with no error anywhere
 * (found 2026-09-02). Rewriting the concrete colours to `currentColor` is what
 * makes White/Black mean anything on a pasted logo.
 *
 * `none` is left alone (it is a stroke-only shape saying "don't paint me"), and
 * so is `url(#…)` (a gradient/pattern reference — losing it would break the
 * geometry rather than recolour it). Applied at RENDER time only, so the stored
 * SVG stays exactly what the user pasted.
 */
function monoize(svg) {
  const KEEP = /^(?:none|currentColor|url\()/i;
  return String(svg || '')
    .replace(/(\s(?:fill|stroke))\s*=\s*"([^"]*)"/gi, (m, attr, val) =>
      KEEP.test(val.trim()) ? m : `${attr}="currentColor"`,
    )
    .replace(/(\s(?:fill|stroke))\s*=\s*'([^']*)'/gi, (m, attr, val) =>
      KEEP.test(val.trim()) ? m : `${attr}="currentColor"`,
    )
    .replace(/(fill|stroke)\s*:\s*([^;"']+)/gi, (m, prop, val) =>
      KEEP.test(val.trim()) ? m : `${prop}:currentColor`,
    );
}

/** Basic hygiene on pasted SVG: strip <script> and inline on* handlers, then the
 *  forced root size and the baked-in colours. Local, self-authored content, but
 *  cheap insurance. */
export function sanitizeSvg(svg) {
  const cleaned = sanitizeSvgText(svg); // M6: an allow-list rebuild over a real parse, not a regex
  return monoize(stripSvgSize(cleaned));
}

/**
 * Give a viewBox-less <svg> a coordinate system, measured from what it actually
 * draws.
 *
 * We size the logo with `width: <scale>%` and `height: auto`, and BOTH need an
 * aspect ratio, which only a viewBox supplies. A bare `<svg>` root (plenty of
 * real exports have one — no viewBox, no width, no height) therefore falls back
 * to the CSS default 150px box and shows the top-left corner of a 1200-unit
 * drawing. Nothing errors; you just get a crop.
 *
 * The extent is not knowable from the text, so we measure the mounted element:
 * getBBox() is the union of the rendered geometry. Only ever ADDS a viewBox —
 * an SVG that brought its own is untouched. getBBox throws (or answers zero) if
 * the element is not in the render tree yet, which is why there is one retry on
 * the next frame: a pane that paints its logo before it is on screen would
 * otherwise be stuck with the crop until the next pref change.
 */
export function fitViewBox(hostEl, retry = true) {
  const svg = hostEl?.firstElementChild;
  if (!svg || svg.tagName.toLowerCase() !== 'svg' || svg.hasAttribute('viewBox')) {
    return;
  }
  let box = null;
  try {
    box = svg.getBBox();
  } catch {
    /* not in the render tree yet */
  }
  if (box && box.width > 0 && box.height > 0) {
    svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`);
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    return;
  }
  if (retry) {
    requestAnimationFrame(() => fitViewBox(hostEl, false));
  }
}

const monoColor = (mono) => (mono === 'black' ? '#000' : '#fff');

/** Paint a logo into a host element (mirrors the design system logoHTML). Pass null to clear.
 *
 *  TWO RENDERINGS, chosen by the caller:
 *
 *  - `{ pane }` given — the v21 TERMINAL WATERMARK (the design system window-chrome v21,
 *    hwb-watermark.css). Exactly the bundle's contract: `.wm-pane` +
 *    `.wm-at-<washFrom>` on the PANE (the project wash is the pane's ground,
 *    drawn even with no logo), a `.wm-backlit` WRAPPER when backlit, and
 *    `.wm .wm-line-<line>` on the inline <svg>. No inline colour or opacity:
 *    the ink is the project hue only (`--wm-pc`) and the strength is `--wm-op`
 *    (paintWatermarkVars) — so the stored `mono` field is deliberately NOT read
 *    here. The host keeps its size (scale %) and its centring.
 *  - no `pane` — the pre-v21 flat ghost (icons page previews), unchanged:
 *    inline mono colour + opacity, no wm-* classes.
 *
 *  The stored art is never edited; line styles are CSS (fills overridden,
 *  masks), per the bundle. */
const WM_PANE_CLASSES = (c) => c === 'wm-pane' || c.startsWith('wm-at-');

export function renderLogo(hostEl, logo, opts = {}) {
  if (!hostEl) {
    return;
  }
  const pane = opts.pane || null;
  if (pane) {
    const wm = wmFields(logo);
    [...pane.classList].filter(WM_PANE_CLASSES).forEach((c) => pane.classList.remove(c));
    pane.classList.add('wm-pane', `wm-at-${wm.washFrom}`);
  }
  if (!logo || !logo.svg) {
    hostEl.innerHTML = '';
    hostEl.style.display = 'none';
    return;
  }
  hostEl.style.display = '';
  hostEl.style.width = `${logo.scale || 80}%`;
  const svg = sanitizeSvg(logo.svg);
  if (!pane) {
    hostEl.style.color = monoColor(logo.mono);
    hostEl.style.opacity = String((logo.opacity != null ? logo.opacity : 10) / 100);
    hostEl.innerHTML = svg;
    fitViewBox(hostEl);
    return;
  }
  const wm = wmFields(logo);
  hostEl.style.removeProperty('color');
  hostEl.style.removeProperty('opacity');
  hostEl.innerHTML = wm.backlit ? `<div class="wm-backlit">${svg}</div>` : svg;
  const svgEl = hostEl.querySelector('svg');
  if (svgEl) {
    svgEl.classList.add('wm');
    if (wm.line !== 'none') {
      svgEl.classList.add(`wm-line-${wm.line}`);
    }
  }
  // fitViewBox measures its host's FIRST child, so hand it the wrapper when there is one
  fitViewBox(wm.backlit ? hostEl.firstElementChild : hostEl);
}

/* ---- the modal (built once, lazily) ---- */
let ui = null;
let onSaveCb = null;
let savedMap = new Map(); // "<id>" -> {id,name,svg}
let justSavedId = null; // id of a logo created by THIS save, so its key can be written

function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .lm-scrim { position: fixed; inset: 0; background: rgba(6,9,12,.55); z-index: 90; display: none; }
    .lm-scrim.open { display: block; }
    .lm-modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%);
      width: min(560px, 94vw); max-height: 92vh; overflow: auto; z-index: 91; display: none;
      background: var(--surface2, #16181d); border: 1px solid var(--border2, #2c2c34);
      border-radius: 12px; box-shadow: 0 18px 50px -12px rgba(0,0,0,.75); color: var(--text, #e6e6e6); }
    .lm-modal.open { display: block; }
    .lm-modal h3 { margin: 0; padding: 14px 16px; font-family: var(--display, inherit); font-size: 15px;
      border-bottom: 1px solid var(--border, #22252b); }
    .lm-modal h3 span { color: var(--dim, #8a8f98); font-weight: 400; font-size: 12px; }
    .lm-body { padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; }
    .lm-lbl { font-size: 12px; color: var(--dim, #8a8f98); }
    .lm-preset, .lm-name, .lm-svg { width: 100%; background: var(--ink, #0e0e10);
      border: 1px solid var(--border2, #2c2c34); border-radius: 7px; color: var(--text, #e6e6e6);
      padding: 8px; font-size: 13px; }
    .lm-svg { height: 120px; font-family: var(--mono, ui-monospace, monospace); font-size: 12px; resize: vertical; }
    .lm-namerow { display: none; flex-direction: column; gap: 4px; }
    .lm-namerow.show { display: flex; }
    .lm-row { display: flex; gap: 14px; flex-wrap: wrap; }
    .lm-row label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--dim, #8a8f98); }
    .lm-row input, .lm-row select { width: 120px; background: var(--ink, #0e0e10);
      border: 1px solid var(--border2, #2c2c34); border-radius: 6px; color: var(--text, #e6e6e6); padding: 6px 8px; font-size: 13px; }
    .lm-wm { display: flex; align-items: center; gap: 8px; font-size: 11.5px;
      font-family: var(--mono, ui-monospace, monospace); color: var(--dim2, #6b7280); }
    .lm-wm a { color: var(--teal, #22b8a8); text-decoration: none; }
    .lm-wm a:hover { text-decoration: underline; }
    .lm-prev-wrap { height: 130px; border: 1px dashed var(--border2, #2c2c34); border-radius: 8px;
      position: relative; overflow: hidden; }
    /* The wash IS the pane's background once .wm-pane lands on it; this sheet
       is injected at runtime and so would otherwise win at equal specificity. */
    .lm-prev-wrap:not(.wm-pane) { background: #000; }
    .lm-prev { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); }
    .lm-prev svg { width: 100%; height: auto; display: block; fill: currentColor; }
    .lm-foot { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border, #22252b); }
    .lm-btn { font: inherit; font-size: 13px; padding: 7px 14px; border-radius: 7px; cursor: pointer;
      color: var(--text, #e6e6e6); background: var(--surface3, #23262d); border: 1px solid var(--border2, #2c2c34); }
    .lm-btn:hover { border-color: var(--teal, #22b8a8); }
    .lm-btn.save { background: var(--teal, #22b8a8); color: #06302b; border-color: var(--teal, #22b8a8); }
    .lm-btn.remove { margin-right: auto; }
  `;
  document.head.appendChild(style);
}

const addOpt = (parent, value, text) => {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = text;
  parent.appendChild(o);
};

function build() {
  if (ui) {
    return ui;
  }
  injectStyles();
  const scrim = document.createElement('div');
  scrim.className = 'lm-scrim';
  const modal = document.createElement('div');
  modal.className = 'lm-modal';
  modal.innerHTML = `
    <h3>CLI logo <span>— ghosted behind the text</span></h3>
    <div class="lm-body">
      <label class="lm-lbl">Preset / library <span style="color:var(--dim)">(or paste your own below)</span></label>
      <select class="lm-preset" data-el="preset"></select>
      <div class="lm-namerow" data-el="namerow">
        <label class="lm-lbl">Save as <span style="color:var(--dim)">(stored for any window)</span></label>
        <input class="lm-name" data-el="name" type="text" placeholder="e.g. My project" />
      </div>
      <label class="lm-lbl">SVG code</label>
      <textarea class="lm-svg" data-el="svg" placeholder="&lt;svg viewBox=...&gt;…&lt;/svg&gt;"></textarea>
      <div class="lm-row">
        <label>Scale (% of pane width) <input type="number" data-el="scale" min="5" max="100" value="80"></label>
        <label>Color <select data-el="mono"><option value="white">White</option><option value="black">Black</option></select></label>
        <label>Opacity % <input type="number" data-el="opacity" min="1" max="100" value="10"></label>
      </div>
      <!-- THE ART'S OWN TREATMENT IS NOT EDITED HERE (2026-09-19). The design system’s
           hwb-watermark.css header rules it: "line style per logo, chosen in
           the engine's icon editor". It is also unjudgeable in this box — the
           line styles are masks and stroke overrides that need a pane around
           them. So: shown, inherited from the picked set, edited on the Icons
           page, where the preview is a real session pane. -->
      <div class="lm-wm" data-el="wmline">
        <span data-el="wmtext"></span>
        <a href="/art.html" target="_blank" rel="noopener">Icons page →</a>
      </div>
      <div class="lm-prev-wrap" data-el="prevpane"><div class="lm-prev" data-el="prev"></div></div>
    </div>
    <div class="lm-foot">
      <button class="lm-btn remove" data-el="remove">Remove</button>
      <button class="lm-btn" data-el="cancel">Cancel</button>
      <button class="lm-btn save" data-el="save">Save</button>
    </div>`;
  document.body.append(scrim, modal);

  const q = (name) => modal.querySelector(`[data-el="${name}"]`);
  ui = {
    scrim, modal,
    preset: q('preset'), namerow: q('namerow'), name: q('name'), svg: q('svg'),
    scale: q('scale'), mono: q('mono'), opacity: q('opacity'), prev: q('prev'),
    prevpane: q('prevpane'), wmtext: q('wmtext'),
    remove: q('remove'), cancel: q('cancel'), save: q('save'),
    /* The art's treatment, carried but not edited here. Replaced wholesale
       when a set is picked (inheritance), preserved otherwise so re-saving a
       recipe never silently drops what the Icons page set. */
    wm: { ...wmFields(null) },
    color: null,
  };

  /* PREVIEW IN THE RENDERING IT WILL ACTUALLY GET. The old preview hand-rolled
     the flat ghost — inline mono colour and opacity, no wm-* classes — so the
     line style, the wash and the backlit glow were invisible, which is exactly
     why Owner could change Line and see nothing. It now paints the v21 pane
     rendering into the preview box, which IS a pane for this purpose. */
  const updatePreview = () => {
    const logo = {
      svg: ui.svg.value,
      scale: +ui.scale.value || 80,
      mono: ui.mono.value,
      opacity: +ui.opacity.value || 10,
      ...ui.wm,
    };
    paintWatermarkVars(ui.prevpane, logo, ui.color);
    renderLogo(ui.prev, logo.svg ? logo : null, { pane: ui.prevpane });
    ui.wmtext.textContent = `${ui.wm.line === 'none' ? 'solid fill' : ui.wm.line} · wash ${ui.wm.washFrom}`
      + ` · backlit ${ui.wm.backlit ? 'on' : 'off'} — the art's own treatment`;
  };
  ['svg', 'scale', 'mono', 'opacity'].forEach((k) => ui[k].addEventListener('input', updatePreview));
  ui._updatePreview = updatePreview;

  // Picking an entry: "Add new" reveals the name field but LEAVES the SVG box
  // alone (so a pasted one-off can be named + stored). A preset / saved logo
  // populates the SVG box.
  ui.preset.addEventListener('change', () => {
    const v = ui.preset.value;
    ui.namerow.classList.toggle('show', v === NEW_VALUE);
    if (v === NEW_VALUE || v === '') {
      return;
    }
    if (v.startsWith('saved:')) {
      const asset = savedMap.get(v.slice('saved:'.length));
      if (asset) {
        ui.svg.value = asset.svg;
        /* INHERIT THE ART'S TREATMENT, and its default scale/opacity, at PICK
           time — the one moment a recipe chooses a piece of art. Picking is
           the only place inheritance can happen without overwriting a value
           someone tuned for this project later (the Icons page never reaches
           into a recipe). A set with no style yet reads as LOGO_DEFAULTS. */
        const st = assetStyle(asset);
        ui.wm = { line: st.line, washFrom: st.washFrom, backlit: st.backlit };
        if (st.scale != null) {
          ui.scale.value = st.scale;
        }
        if (st.opacity != null) {
          ui.opacity.value = st.opacity;
        }
      }
    } else if (LOGO_PRESETS[v]) {
      ui.svg.value = LOGO_PRESETS[v];
    }
    updatePreview();
  });

  const close = () => {
    scrim.classList.remove('open');
    modal.classList.remove('open');
  };
  /* ESCAPE IS THE EMERGENCY EXIT (Owner, 2026-09-21). A dialog whose only way
     out is a button can be trapped by any layout that hides the button; a
     keyboard route cannot be pushed off-screen. Cancels — it never saves — so
     a panicked press can never commit a half-edited logo. */
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && modal.classList.contains('open')) {
      ev.stopPropagation(); // the manager's own Escape must not also shut the form behind this
      close();
    }
  }, true);
  const commit = (logo) => {
    close();
    if (onSaveCb) {
      onSaveCb(logo);
    }
  };
  scrim.addEventListener('click', close);
  ui.cancel.addEventListener('click', close);
  ui.remove.addEventListener('click', () => commit(null));
  ui.save.addEventListener('click', async () => {
    const svg = ui.svg.value.trim();
    // "Add a new SVG…" also stores it in the library (named, reusable).
    if (ui.preset.value === NEW_VALUE) {
      if (!svg) {
        alert('Paste or choose an SVG before saving.');
        return;
      }
      if (!ui.name.value.trim()) {
        alert('Give the SVG a name to store it (or pick "— choose —" to keep it session-only).');
        return;
      }
      try {
        const r = await fetch('/api/logos', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: ui.name.value.trim(), svg }),
        });
        const j = await r.json();
        if (j?.logo?.id) {
          justSavedId = j.logo.id;
        }
        await refreshLibrary();
      } catch {
        /* library save failed — still apply to the session below */
      }
    }
    /* THE KEY IS WHAT MAKES A TAB ICON POSSIBLE.
     *
     * The window-host shell can only resolve a mark by KEY out of the preset
     * module — it never receives markup. solo.js has always preferred
     * `parsed.key` and fell back to matching the stored SVG against the pinned
     * presets, which no user logo can ever match, so no key was sent and the
     * shell hash-assigned a stock mark instead. Writing the key here is the
     * half that was missing.
     *
     * `lib:<id>`, never the name: renaming a set is a label change (Owner's
     * decision, 2026-09-02) and must not orphan the panes wearing it. A pasted
     * one-off has no key and stays session-only, which is correct — there is
     * nothing for a tab to resolve. */
    const sel = ui.preset.value;
    let key;
    if (sel === NEW_VALUE && justSavedId) {
      key = `lib:${justSavedId}`;
    } else if (sel.startsWith('saved:')) {
      key = `lib:${sel.slice('saved:'.length)}`;
    } else if (sel && sel !== NEW_VALUE && sel in LOGO_PRESETS) {
      key = sel;
    }
    justSavedId = null;
    commit(
      svg
        ? {
            ...(key ? { key } : {}),
            svg,
            scale: +ui.scale.value || 80,
            mono: ui.mono.value,
            opacity: +ui.opacity.value || 10,
            ...ui.wm,
          }
        : null,
    );
  });
  return ui;
}

/** Rebuild the picker: "— choose —", "➕ Add a new SVG…", the the design system presets, then
 *  the user's saved library. Preserves the current selection. */
async function refreshLibrary() {
  const b = build();
  let saved = [];
  try {
    saved = (await (await fetch('/api/logos')).json()).logos || [];
  } catch {
    saved = [];
  }
  savedMap = new Map(saved.map((l) => [String(l.id), l]));
  const keep = b.preset.value;
  b.preset.innerHTML = '';
  addOpt(b.preset, '', '— choose —');
  addOpt(b.preset, NEW_VALUE, '➕ Add a new SVG…');
  const gp = document.createElement('optgroup');
  gp.label = 'Presets';
  /* Skip `lib:` keys — the superset served at the preset URL now carries the
     user library too (so the shell can resolve it), but those already appear
     under "Saved" below and would otherwise be listed twice. */
  Object.keys(LOGO_PRESETS)
    .filter((n) => !n.startsWith('lib:'))
    .forEach((n) => addOpt(gp, n, n));
  b.preset.appendChild(gp);
  if (saved.length) {
    const gs = document.createElement('optgroup');
    gs.label = 'Saved';
    saved.forEach((l) => addOpt(gs, `saved:${l.id}`, l.name));
    b.preset.appendChild(gs);
  }
  b.preset.value = keep;
}

/** Open the editor. `current` = logo object (or null); `onSave(logoOrNull)`
 *  fires on Save/Remove. `color` = the recipe's accent, which is the ONLY hue
 *  the v21 watermark paints with — without it the preview would show the look
 *  in some other project's colour, which is worse than no colour at all. */
export function openLogoModal({ current, onSave, color }) {
  const b = build();
  onSaveCb = onSave;
  const L = current || { svg: '', ...LOGO_DEFAULTS };
  b.svg.value = L.svg || '';
  b.scale.value = L.scale || 80;
  b.mono.value = L.mono || 'white';
  b.opacity.value = L.opacity != null ? L.opacity : 10;
  b.wm = wmFields(L);
  b.color = color || null;
  b.name.value = '';
  b.namerow.classList.remove('show');
  b.preset.value = '';
  b._updatePreview();
  b.scrim.classList.add('open');
  b.modal.classList.add('open');
  /* RESTORE THE PICKER from the stored key, once the list exists.
     Without this, re-opening a logo showed the right ART with the picker reset
     to "— choose —", so saving again derived NO key and silently dropped the
     set's identity. The art stayed correct and the tab fell back to a
     hash-assigned stock mark — which is exactly what made Owner's the design system
     Styleguide render as "styleguide" no matter how often he re-picked it.
     The engine also stamps the key on write now, so this is the UX half of a
     fix that no longer depends on the UI getting it right. */
  refreshLibrary().then(() => {
    const key = current && typeof current.key === 'string' ? current.key : null;
    if (!key) {
      return;
    }
    const want = key.startsWith('lib:') ? `saved:${key.slice(4)}` : key;
    if ([...b.preset.options].some((o) => o.value === want)) {
      b.preset.value = want;
    }
  });
}
