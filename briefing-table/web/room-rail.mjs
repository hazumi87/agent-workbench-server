/* THE RESIZABLE COLUMNS (the design system room-rail-resize-v1, Owner 2026-09-28: "make
 * the left column size the default and minimum on pc, but then allow me to
 * expand it out to the right"; the preview column the same way, Owner
 * 2026-09-30 [ticket]).
 *
 * ONE splitter, two uses. The handle is the Workbench splitter: a 12px
 * transparent hit strip centred ON the column's existing 1px edge, with a
 * small grip pill. Drag it, or focus it (role=separator) and use ← → (16px,
 * Shift 64px; the arrow moves the EDGE that way), Home (default), End (max),
 * Enter (reset); a double-click resets. The grip is invisible at rest and
 * shows on hover / focus / drag, fading out ~2s after (room-rail.css).
 *
 * THE LEFT COLUMN (the rail). Min = default = 272 (today's column). NO fixed
 * max (rooms/rail-max, Owner 2026-09-28: "widen the left column, narrow the
 * chat") — the only ceiling is never more than leaves the line 480 (plus the
 * preview column's width while it is open).
 *
 * THE PREVIEW COLUMN (right). Default 370 (hub v2, 2026-10-05), min 320 (the design system 2026-10-07), max 720 — and never more
 * than leaves the line 480 beside the rail's 272 minimum. It yields only to
 * the rail's MINIMUM, so as a window narrows the rail gives way first and the
 * thing being read keeps its width. The handle exists only while the column
 * is open (CSS: .rm-main.has-pv).
 *
 * THE CLAMPS ARE CSS (room-rail.css), at render, so a narrower window or an
 * opening preview takes width back without the saved preference ever being
 * written back; it re-widens when there is room again. This module only
 * moves --rail-pref / --pv-pref.
 *
 * Remembered per DEVICE across all rooms (localStorage, every access in a
 * try/catch). room.html reads the rail's in <head>, before the first paint, so
 * the column never jumps on load; the preview is closed at load, so it needs
 * no early read.
 *
 * Phone (<=600px): nothing changes; neither column is a side column there and
 * no grip is drawn.
 */

export const RAIL_KEY = 'hwb.room.railWidth';
export const PV_KEY = 'hwb.room.previewWidth';
const RAIL_MIN = 272;
const LINE = 480;
const PV_MIN = 320;
const PV_DEF = 370;
const PV_MAX = 720;
const SNAP = 8;

/**
 * @param {{main: HTMLElement, col: HTMLElement, id: string, cls: string, label: string,
 *          key: string, prop: string, min: number, def: number,
 *          dir: 1|-1, maxNow: () => number}} o
 *   dir: +1 when the grip is on the column's RIGHT edge (dragging right
 *   widens it), -1 when on its LEFT edge.
 */
function mountSplitter(o) {
  if (!o.col.id) {
    o.col.id = o.id;
  }
  const root = document.documentElement;
  const grip = document.createElement('div');
  grip.className = `rr-grip ${o.cls}`;
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-orientation', 'vertical');
  grip.setAttribute('aria-controls', o.col.id);
  grip.setAttribute('aria-label', o.label);
  grip.title = 'Drag to resize · double-click to reset';
  grip.tabIndex = 0;
  const tip = document.createElement('span');
  tip.className = 'rr-tip';
  tip.setAttribute('aria-hidden', 'true');
  grip.append(tip);
  o.main.append(grip);

  const maxNow = () => Math.max(o.min, Math.round(o.maxNow()));
  const shown = () => Math.round(o.col.getBoundingClientRect().width);
  const clamp = (w) => Math.max(o.min, Math.min(maxNow(), Math.round(w)));

  function paint() {
    const w = shown();
    grip.setAttribute('aria-valuemin', String(o.min));
    grip.setAttribute('aria-valuemax', String(maxNow()));
    grip.setAttribute('aria-valuenow', String(w));
    grip.setAttribute('aria-valuetext', `${w} pixels`);
    tip.textContent = `${w}px`;
  }
  function setPref(w, save) {
    root.style.setProperty(o.prop, `${w}px`);
    paint();
    if (save) {
      try {
        localStorage.setItem(o.key, String(w));
      } catch {
        /* no storage (private window, blocked site data): this session only */
      }
    }
  }

  /* the saved width (for the rail the <head> script already applied it; this keeps one owner) */
  let saved = o.def;
  try {
    saved = parseInt(localStorage.getItem(o.key) ?? '', 10) || o.def;
  } catch {
    /* unreadable storage = the default */
  }
  root.style.setProperty(o.prop, `${Math.max(o.min, saved)}px`); // no cap here; the CSS clamp does the limiting at render

  /* drag: pointer capture on the grip; frames must not swallow the moves */
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('is-drag');
    document.body.classList.add('rr-resizing');
    const x0 = e.clientX;
    const w0 = shown();
    const move = (ev) => {
      let w = w0 + o.dir * (ev.clientX - x0);
      if (Math.abs(w - o.def) < SNAP) {
        w = o.def; // snaps home within 8px of the default
      }
      setPref(clamp(w), false);
    };
    const end = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      grip.removeEventListener('lostpointercapture', end);
      grip.classList.remove('is-drag');
      document.body.classList.remove('rr-resizing');
      setPref(shown(), true); // what you see is what is kept
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('lostpointercapture', end);
  });
  grip.addEventListener('dblclick', () => setPref(o.def, true));
  grip.addEventListener('keydown', (e) => {
    const step = (e.shiftKey ? 64 : 16) * o.dir;
    const to = { ArrowLeft: shown() - step, ArrowRight: shown() + step, Home: o.def, End: maxNow(), Enter: o.def }[e.key];
    if (to === undefined) {
      return;
    }
    e.preventDefault();
    setPref(clamp(to), true);
  });

  /* the window, the other column or a drag moved this one: say so */
  new ResizeObserver(paint).observe(o.main);
  new ResizeObserver(paint).observe(o.col);
  paint();
  return { paint };
}

/** the left column; `pv` (the preview <aside>) is optional, for its live width */
export function mountRail({ main, rail, pv }) {
  const pvEl = pv ?? document.getElementById('preview');
  return mountSplitter({
    main,
    col: rail,
    id: 'rail',
    cls: 'is-rail',
    label: 'Resize the left column',
    key: RAIL_KEY,
    prop: '--rail-pref',
    min: RAIL_MIN,
    def: RAIL_MIN,
    dir: 1,
    maxNow: () => main.clientWidth - LINE - (main.classList.contains('has-pv') && !main.classList.contains('pv-drawer') && pvEl ? pvEl.getBoundingClientRect().width : 0), // a drawer takes nothing from the rail
  });
}

/** the preview column (the right one); its grip is on the column's LEFT edge */
export function mountPreviewResize({ main, pv }) {
  return mountSplitter({
    main,
    col: pv,
    id: 'preview',
    cls: 'is-pv',
    label: 'Resize the preview column',
    key: PV_KEY,
    prop: '--pv-pref',
    min: PV_MIN,
    def: PV_DEF,
    dir: -1,
    maxNow: () => Math.min(PV_MAX, main.clientWidth - LINE - RAIL_MIN),
  });
}

/**
 * THE PREVIEW AS A DRAWER [pv drawer] (Owner 2026-10-07; the design system numbers): the chat keeps 480px. While the rail's REAL width (its
 * preference, clamped; never the squeezed width it has beside an open column, which would flip the mode back and forth) + 480 + the
 * preview's 320 minimum does not fit in the window, the preview is a drawer over the chat (370px or the window less 56px, anchored right)
 * with the room's scrim behind it: a click on the scrim closes it, as do its ✕ and Esc. Switching between column and drawer on a resize
 * only changes where the same panel sits: it is not closed, re-rendered or scrolled.
 * @param {{main: HTMLElement, rail: HTMLElement, pv: HTMLElement, dismiss: () => void}} o
 */
export function mountPreviewDrawer({ main, rail, pv, dismiss }) {
  const scrim = document.createElement('div');
  scrim.className = 'pv-scrim';
  scrim.hidden = true;
  scrim.setAttribute('aria-hidden', 'true');
  scrim.addEventListener('click', () => dismiss());
  main.append(scrim);
  const phone = () => matchMedia('(max-width: 600px)').matches;
  /** the rail's width as the person set it, held to its own limits, before any open column took from it */
  const railWidth = () => {
    const pref = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--rail-pref'), 10) || RAIL_MIN;
    return Math.max(RAIL_MIN, Math.min(pref, main.clientWidth - LINE));
  };
  function paint() {
    const drawer = !phone() && main.clientWidth > 0 && main.clientWidth < railWidth() + LINE + PV_MIN;
    main.classList.toggle('pv-drawer', drawer);
    scrim.hidden = !(drawer && main.classList.contains('has-pv'));
    scrim.style.left = `${Math.round(rail.getBoundingClientRect().width)}px`; // the scrim covers the CHAT only: the rail stays visible and usable
  }
  new ResizeObserver(paint).observe(main);
  new MutationObserver(paint).observe(main, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] }); // the rail's splitter moves --rail-pref on <html>
  new ResizeObserver(paint).observe(rail);
  matchMedia('(max-width: 600px)').addEventListener('change', paint);
  paint();
  return { paint, isDrawer: () => main.classList.contains('pv-drawer') };
}
