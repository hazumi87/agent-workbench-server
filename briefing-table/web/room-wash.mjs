/* LINE WASH, SPOT | EDGE [hub-v2] (Owner 2026-10-05, the design system b0f8099 sec 1.G).
 *
 * The line's wash is a radial gradient with two lightnesses: the SPOT (the
 * lower-left centre) and the EDGE it falls off to (hwb-watermark.css .wm-pane:
 * --wm-wash at 0%, --wm-term at 62%). One two-handle range sets both; the track
 * runs strongest -> plainest and is PAINTED with the wash itself.
 *
 * THIS MODULE IS THE ONLY WRITER of --wm-wash / --wm-term. The chroma rules are
 * hwb-watermark.css's, unchanged. Dark at the defaults is byte-for-byte today
 * (L .30 / .16), so in dark mode the properties are REMOVED at the defaults and
 * the stylesheet stands: nothing changes until a user moves it. Light has no
 * stylesheet default (the generic light sweep deliberately excludes .wm-pane),
 * so light always writes.
 *
 * Stored per PERSON, per MODE (room_user_prefs.wash), and follows the room's
 * effective mode: its own palette override if it has one, else the person's
 * global palette's. The mode is read from <html data-mode>, which
 * web/palette.mjs `apply` sets for either.
 *
 * Positions are 0..1 along the track; L(p) = l + (r - l) * p. */

/** The tracks and stops (the design system sec 1.G). `s`/`e` are the defaults. */
export const TRACK = {
  dark: { s: 0.3, e: 0.16, l: 0.46, r: 0.08, lo: 0.158, hi: 0.947 },
  light: { s: 0.925, e: 0.975, l: 0.66, r: 1, lo: 0.235, hi: 1 }, // the design system sec 1.G dc48334: track .66 -> 1, spot stop L .74
};
/* The chroma clamps of the shipped CSS (dark) and the light rule (the design system sec 1.G). */
const CHROMA = {
  dark: { spot: 'clamp(0,calc(c * .40),.065)', edge: 'clamp(0,calc(c * .15),.028)' },
  light: { spot: 'clamp(0,calc(c * .45),.065)', edge: 'clamp(0,calc(c * .12),.02)' },
};

/* SPOT POSITION [hub-v2 sec 1.I]: the room's stored {x, y} (0-100) or null. NULL WRITES NOTHING:
   the pane keeps its `.wm-at-<washFrom>` class and so the art's own origin, byte-for-byte as
   before. Only a stored position writes --wm-at inline, which beats the class. `liveAt` is a
   drag in flight (not yet saved). */
let spotAt = null;
let liveAt = null;
export function setSpotAt(a) {
  spotAt = a && Number.isFinite(a.x) && Number.isFinite(a.y) ? { x: a.x, y: a.y } : null;
}

let prefs = null; // {dark:{spot,edge}, light:{spot,edge}} as the engine answered; null = defaults
let save = null; // (patch) => Promise: PATCH /api/rooms/me {wash}
const listeners = new Set();

export function effectiveMode() {
  return document.documentElement.dataset.mode === 'light' ? 'light' : 'dark';
}

/** The person's {spot, edge} for a mode (the defaults when unset). */
export function washFor(mode = effectiveMode()) {
  const d = TRACK[mode];
  const v = prefs && prefs[mode];
  return v && Number.isFinite(v.spot) && Number.isFinite(v.edge) ? { spot: v.spot, edge: v.edge } : { spot: d.s, edge: d.e };
}

/** Hand the module what the engine said and how to save a change. */
export function setWashPrefs(w, saver) {
  prefs = w && typeof w === 'object' ? w : null;
  if (saver) {
    save = saver;
  }
  applyWash();
}

const pos = (m, L) => (L - TRACK[m].l) / (TRACK[m].r - TRACK[m].l);
const lof = (m, p) => +(TRACK[m].l + (TRACK[m].r - TRACK[m].l) * p).toFixed(3);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Write the vars on every .wm-pane (and the tile wash's offsets on <html>). */
export function applyWash() {
  const m = effectiveMode();
  const d = TRACK[m];
  const v = washFor(m);
  const atDefault = Math.abs(v.spot - d.s) < 0.0005 && Math.abs(v.edge - d.e) < 0.0005;
  for (const p of document.querySelectorAll('.wm-pane')) {
    if (m === 'dark' && atDefault) {
      p.style.removeProperty('--wm-wash');
      p.style.removeProperty('--wm-term');
    } else {
      p.style.setProperty('--wm-wash', `oklch(from var(--wm-pc,var(--dim2)) ${v.spot} ${CHROMA[m].spot} h)`);
      p.style.setProperty('--wm-term', `oklch(from var(--wm-pc,var(--dim2)) ${v.edge} ${CHROMA[m].edge} h)`);
    }
  }
  const at = liveAt || spotAt;
  /* the line also when a tile is on: the tile's wash reads --wm-at from the line, and a tiled
     room may carry no .wm-pane at all */
  for (const p of document.querySelectorAll('.wm-pane, .rm-line.rc-tiled')) {
    if (at) {
      p.style.setProperty('--wm-at', `${at.x}% ${at.y}%`);
    } else {
      p.style.removeProperty('--wm-at');
    }
  }
  /* With tiled art on, the wash layer in front of the art carries the same falloff:
     the room color shifted by how far each handle sits from the DEFAULT spot. */
  const r = document.documentElement.style;
  r.setProperty('--rc-wsd', (v.spot - d.s).toFixed(3));
  r.setProperty('--rc-wed', (v.edge - d.s).toFixed(3));
  for (const f of listeners) {
    f();
  }
}

/* A mode flip repaints the wash at once, not on the next poll. */
if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
  new MutationObserver(() => applyWash()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
}

/** Ask to be told when the wash (or the mode it follows) changed. */
export function onWash(f) {
  listeners.add(f);
  return () => listeners.delete(f);
}

let pending = null;
let timer = 0;
function commit(m, v) {
  prefs = { ...(prefs || {}), [m]: v };
  applyWash();
  if (!save) {
    return;
  }
  pending = { [m]: { spot: v.spot, edge: v.edge } };
  clearTimeout(timer);
  timer = setTimeout(flush, 250); // a drag is many events; the engine hears the last
}
async function flush() {
  const body = pending;
  pending = null;
  if (!body || !save) {
    return;
  }
  try {
    await save(body);
  } catch {
    /* the paint already followed the drag; the next change retries */
  }
}

/** The two-handle range, built into `host`. Returns {paint}. */
export function mountWashSlider(host) {
  host.replaceChildren();
  host.innerHTML = '<div class="wse"><div class="wse-t"><i class="wse-off l"></i><i class="wse-off r"></i><i class="wse-band"></i><b class="wse-h s" tabindex="0" role="slider" aria-label="Spot"></b><b class="wse-h e" tabindex="0" role="slider" aria-label="Edge"></b></div><div class="wse-lb"><span>Spot <b class="vs"></b></span><span class="vc"></span><span>Edge <b class="ve"></b></span></div></div>';
  const q = (c) => host.querySelector(c);
  const t = q('.wse-t');
  const M = () => effectiveMode();
  const K = () => TRACK[M()];
  function paint() {
    const m = M();
    const k = K();
    const v = washFor(m);
    const ps = pos(m, v.spot);
    const pe = pos(m, v.edge);
    t.style.background = `linear-gradient(90deg,oklch(from var(--room-c) ${k.l} ${CHROMA[m].spot} h),oklch(from var(--room-c) ${k.r} ${CHROMA[m].edge} h))`;
    q('.wse-off.l').style.width = `${k.lo * 100}%`;
    q('.wse-off.r').style.width = `${(1 - k.hi) * 100}%`;
    q('.wse-h.s').style.left = `${ps * 100}%`;
    q('.wse-h.e').style.left = `${pe * 100}%`;
    q('.wse-band').style.left = `${ps * 100}%`;
    q('.wse-band').style.width = `${Math.max(0, (pe - ps) * 100)}%`;
    q('.vs').textContent = `L ${v.spot.toFixed(2)}`;
    q('.ve').textContent = `L ${v.edge.toFixed(2)}`;
    q('.vc').textContent = Math.abs(v.spot - v.edge) < 0.005 ? 'even' : `contrast ${Math.abs(v.spot - v.edge).toFixed(2)}`;
    q('.wse-h.s').setAttribute('aria-valuetext', `L ${v.spot.toFixed(2)}`);
    q('.wse-h.e').setAttribute('aria-valuetext', `L ${v.edge.toFixed(2)}`);
  }
  function set(ps, pe) {
    const m = M();
    const k = K();
    let a = clamp(ps, k.lo, k.hi);
    let b = clamp(pe, k.lo, k.hi);
    if (a > b) {
      [a, b] = [b, a];
    }
    commit(m, { spot: lof(m, a), edge: lof(m, b) });
  }
  const at = (e) => {
    const r = t.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  };
  t.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const m0 = M();
    const v = washFor(m0);
    let ps = pos(m0, v.spot);
    let pe = pos(m0, v.edge);
    const p0 = at(e);
    /* a handle, the band between them, or the bare track (the nearer handle jumps) */
    const which = e.target.closest('.wse-h.s') ? 's' : e.target.closest('.wse-h.e') ? 'e' : e.target.closest('.wse-band') ? 'b' : Math.abs(p0 - ps) <= Math.abs(p0 - pe) ? 's' : 'e';
    if (which === 's') {
      ps = Math.min(p0, pe);
    } else if (which === 'e') {
      pe = Math.max(p0, ps);
    }
    if (which !== 'b') {
      set(ps, pe);
    }
    const k = K();
    const w = pe - ps;
    const cur = () => washFor(M());
    const mv = (ev) => {
      const p = at(ev);
      const c = cur();
      if (which === 's') {
        set(Math.min(p, pos(M(), c.edge)), pos(M(), c.edge));
      } else if (which === 'e') {
        set(pos(M(), c.spot), Math.max(p, pos(M(), c.spot)));
      } else {
        const a = clamp(ps + (p - p0), k.lo, k.hi - w); // the band keeps its width: lighter/darker, same contrast
        set(a, a + w);
      }
    };
    const up = () => {
      document.removeEventListener('pointermove', mv);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      void flush();
    };
    document.addEventListener('pointermove', mv);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  });
  t.addEventListener('dblclick', () => {
    const m = M();
    commit(m, { spot: TRACK[m].s, edge: TRACK[m].e }); // back to the defaults
    void flush();
  });
  host.addEventListener('keydown', (e) => {
    const h = e.target.closest('.wse-h');
    const d = e.key === 'ArrowLeft' ? -0.01 : e.key === 'ArrowRight' ? 0.01 : 0;
    if (!h || !d) {
      return;
    }
    e.preventDefault();
    const m = M();
    const v = washFor(m);
    let ps = pos(m, v.spot);
    let pe = pos(m, v.edge);
    if (h.classList.contains('s')) {
      ps = Math.min(ps + d, pe);
    } else {
      pe = Math.max(pe + d, ps);
    }
    set(ps, pe);
    host.querySelector(h.classList.contains('s') ? '.wse-h.s' : '.wse-h.e')?.focus();
  });
  host.addEventListener('focusout', () => void flush());
  const off = onWash(() => {
    if (host.isConnected) {
      paint();
    } else {
      off(); // the settings column closed: stop listening
    }
  });
  paint();
  return { paint, destroy: off };
}

/* ---- THE SPOT POSITION PAD [hub-v2 sec 1.I] (Owner 2026-10-05, the design system 3385f69) ----
   A 128px square, a map of the line: x, y in 0-100 -> `.wm-pane { --wm-at: x% y% }`.
   Painted with the current wash; a 14px ring marks the spot. Press switches the document to
   the precision cursor (room-hub.css `html.wsp-aim`) and hides the ring; touch draws the same
   crosshair 56px ABOVE the finger and the aim is the crosshair. Moves are live (--wm-at only);
   release saves. Arrow keys nudge 1% (Shift 5%); double-click CLEARS the stored position
   (null: the art's own origin returns; it does not store 25% 75%). */
const TOUCH_LIFT = 56;
const roundTenth = (n) => Math.round(clamp(n, 0, 100) * 10) / 10;

/** Where the spot is now: the stored/live position, else the pane's own origin (the class path), else 25 75. */
function currentAt() {
  const a = liveAt || spotAt;
  if (a) {
    return a;
  }
  const pane = document.querySelector('.wm-pane');
  const m = pane && /^\s*(-?[\d.]+)%\s+(-?[\d.]+)%/.exec(getComputedStyle(pane).getPropertyValue('--wm-at'));
  return m ? { x: clamp(+m[1], 0, 100), y: clamp(+m[2], 0, 100) } : { x: 25, y: 75 };
}

/** `save(at|null)` -> Promise<boolean> (room.js saveSettings {wash_at}). Returns {paint, destroy}. */
export function mountSpotPad(host, save) {
  host.replaceChildren();
  host.innerHTML = '<div class="wsp"><div class="wsp-pad" role="slider" tabindex="0" aria-label="Spot position"><i></i></div><div class="wsp-t"><b class="wsp-v"></b>Where the spot sits. Press in the square and move: the room follows live, let go when it is right. Arrow keys nudge (Shift = 5). Double-click resets.</div></div>';
  const pad = host.querySelector('.wsp-pad');
  const dot = pad.querySelector('i');
  const readout = host.querySelector('.wsp-v');
  function paint() {
    const m = effectiveMode();
    const v = washFor(m);
    const a = currentAt();
    pad.style.background = `radial-gradient(ellipse 130% 130% at ${a.x}% ${a.y}%,oklch(from var(--room-c) ${v.spot} ${CHROMA[m].spot} h) 0%,oklch(from var(--room-c) ${v.edge} ${CHROMA[m].edge} h) 62%)`;
    dot.style.left = `${a.x}%`;
    dot.style.top = `${a.y}%`;
    readout.textContent = `Spot at ${Math.round(a.x)}% \u00b7 ${Math.round(a.y)}%`;
    pad.setAttribute('aria-valuetext', readout.textContent);
  }
  async function commitAt(a) {
    const before = spotAt;
    liveAt = null;
    spotAt = a; // optimistic: the room already shows it
    applyWash();
    let ok = false;
    try {
      ok = await save(a);
    } catch {
      ok = false;
    }
    if (!ok) {
      spotAt = before; // the save said no (its own message is on screen): show what is stored
      applyWash();
    }
  }
  const aimAt = (e) => {
    const r = pad.getBoundingClientRect();
    const y = e.clientY - (e.pointerType === 'touch' ? TOUCH_LIFT : 0);
    return { x: roundTenth(((e.clientX - r.left) / r.width) * 100), y: roundTenth(((y - r.top) / r.height) * 100), cy: y };
  };
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try {
      pad.setPointerCapture(e.pointerId);
    } catch {
      /* a pointer that already ended: nothing to capture */
    }
    pad.classList.add('aiming');
    const html = document.documentElement;
    html.classList.add('wsp-aim');
    let cross = null;
    if (e.pointerType === 'touch') {
      cross = document.createElement('div');
      cross.className = 'wsp-x';
      document.body.append(cross);
    }
    const mv = (ev) => {
      const a = aimAt(ev);
      if (cross) {
        cross.style.left = `${ev.clientX}px`;
        cross.style.top = `${a.cy}px`;
      }
      liveAt = { x: a.x, y: a.y };
      applyWash();
    };
    const up = (ev) => {
      pad.removeEventListener('pointermove', mv);
      pad.removeEventListener('pointerup', up);
      pad.removeEventListener('pointercancel', up);
      pad.classList.remove('aiming');
      html.classList.remove('wsp-aim');
      cross?.remove();
      const a = aimAt(ev);
      void commitAt({ x: a.x, y: a.y });
    };
    pad.addEventListener('pointermove', mv);
    pad.addEventListener('pointerup', up);
    pad.addEventListener('pointercancel', up);
    mv(e);
  });
  pad.addEventListener('dblclick', () => {
    void commitAt(null);
  });
  pad.addEventListener('keydown', (e) => {
    const st = e.shiftKey ? 5 : 1;
    const a = { ...currentAt() };
    if (e.key === 'ArrowLeft') {
      a.x -= st;
    } else if (e.key === 'ArrowRight') {
      a.x += st;
    } else if (e.key === 'ArrowUp') {
      a.y -= st;
    } else if (e.key === 'ArrowDown') {
      a.y += st;
    } else {
      return;
    }
    e.preventDefault();
    void commitAt({ x: roundTenth(a.x), y: roundTenth(a.y) });
  });
  const off = onWash(() => {
    if (host.isConnected) {
      paint();
    } else {
      off();
    }
  });
  paint();
  return { paint, destroy: off };
}
