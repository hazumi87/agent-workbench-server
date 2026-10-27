/**
 * Put the page back to 1x when something INSIDE it zoomed it (Owner 2026-10-03,
 * IMG_7709/7710).
 *
 * iOS auto-zooms on focus of any input under 16px, inside an iframe too, and
 * never zooms back. After rating a review in Image Studio the whole room page
 * stayed ~1.2x: the send button off-screen, no sideways scroll (html/body are
 * overflow:hidden on purpose) and a reload did not clear it. Switching tabs
 * did, by accident. The tool owner fixes their font size; this protects the
 * page from any tool that does it.
 *
 * Pinch-zoom is NOT blocked and `maximum-scale` is NOT left in the meta (the
 * 2026-09-01 CLAUDE.md entry: blocking pinch hid a bug for weeks, and
 * maximum-scale costs Display Zoom users a quarter of the app). The reset sets
 * `maximum-scale=1` for one moment, which makes iOS snap to 1x, then puts the
 * ORIGINAL string back byte for byte. It runs only at moments where nobody is
 * reading zoomed on purpose: focus coming back from a tool frame, a layer /
 * sheet / dialog closing, the page becoming visible. Never mid-pinch, never
 * while a text field of this page has focus (never fight the keyboard).
 */
import { isTextField } from '/soft-keyboard.mjs';

const SETTLE_MS = 350; // the keyboard has gone by then
const RESTORE_MS = 300; // how long the momentary maximum-scale stays

export function installZoomGuard(o = {}) {
  const vv = window.visualViewport;
  if (!vv) {
    return { reset() {}, scale: () => 1 };
  }
  let touching = 0;
  let timer = null;
  let blurredIntoFrame = false;
  const scale = () => vv.scale || 1;

  const run = (why) => {
    timer = null;
    try {
      const meta = document.querySelector('meta[name="viewport"]');
      const from = scale();
      if (!meta || from <= 1.01 || touching > 0 || isTextField(document.activeElement)) {
        return;
      }
      const original = meta.getAttribute('content');
      meta.setAttribute('content', `${original}, maximum-scale=1`);
      setTimeout(() => {
        meta.setAttribute('content', original);
        o.onReset?.({ zoomReset: from, why, after: scale() });
      }, RESTORE_MS);
    } catch {
      /* a guard must never break the page it protects */
    }
  };
  const reset = (why) => {
    clearTimeout(timer);
    timer = setTimeout(() => run(why), SETTLE_MS);
  };

  window.addEventListener('touchstart', (e) => { touching = e.touches.length; }, { passive: true, capture: true });
  window.addEventListener('touchend', (e) => { touching = e.touches.length; }, { passive: true, capture: true });
  window.addEventListener('touchcancel', () => { touching = 0; }, { passive: true, capture: true });
  /* (a) a tool frame had focus and the top document has it back */
  window.addEventListener('blur', () => {
    blurredIntoFrame = document.activeElement?.tagName === 'IFRAME';
  });
  window.addEventListener('focus', () => {
    if (blurredIntoFrame) {
      blurredIntoFrame = false;
      reset('frame-focus-return');
    }
  });
  /* (c) the accidental fix, made deliberate */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      reset('visible');
    }
  });
  /* (b) a layer / sheet / dialog closed (dispatched by room.js, room-cells.mjs) */
  window.addEventListener('room:overlay-closed', () => reset('overlay-closed'));
  return { reset, scale };
}
