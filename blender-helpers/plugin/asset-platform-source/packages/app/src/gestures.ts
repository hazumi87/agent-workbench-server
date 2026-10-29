// Touch gesture guards for the phone layout. Ported from Aurora's mockup
// (asset-library-phone v1.4/v1.5) and the homelab mobile-web pattern (the design notes).
//
// Pinch rules (Aurora R1–R4):
//   R1 a second pointer going down cancels any pending long-press;
//   R2 once 2+ pointers have been down, the whole touch sequence is "multi": no long-press,
//      tap-to-open or ⋯ until EVERY finger has lifted;
//   R3 the click that ends a multi sequence is swallowed (capture phase, tiles only);
//   R4 350 ms cooldown after the last finger of a multi sequence lifts.
// Page pinch-zoom is NOT blocked globally (the design notes, CORRECTION with iOS Display
// Zoom, maximum-scale/user-scalable=no put part of the app off-screen and blocking pinch hid it). The grid
// and the preview stage own their gestures locally (touch-action + non-passive touchmove).

const pts = new Map<number, { x: number; y: number }>();
let multi = false;
let until = 0;

/** True while a multi-touch gesture is in progress or just ended (cooldown). */
export function gestureBusy(): boolean {
  return multi || pts.size > 1 || performance.now() < until;
}

/** Number of touch/pen pointers currently down. */
export function pointersDown(): number {
  return pts.size;
}

// After a long-press opens a sheet, lifting the finger fires a click on whatever is now under it
// (the sheet's backdrop), which would close the sheet at once. Swallow that one click.
let swallowUntil = 0;
export function swallowNextClick(ms = 800) { swallowUntil = performance.now() + ms; }

let installed = false;
export function installGestureGuards() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size > 1) multi = true;
  }, true);
  const end = (e: PointerEvent) => {
    if (!pts.delete(e.pointerId)) return;
    if (pts.size === 0 && multi) { multi = false; until = performance.now() + 350; }
  };
  document.addEventListener('pointerup', end, true);
  document.addEventListener('pointercancel', end, true);
  // R3/R4: a tile tap that is really the tail of a pinch must not open the tile.
  document.addEventListener('click', e => {
    const t = e.target as Element | null;
    if (performance.now() < swallowUntil) { swallowUntil = 0; e.stopPropagation(); e.preventDefault(); return; }
    if (t?.closest?.('.thumb') && gestureBusy()) { e.stopPropagation(); e.preventDefault(); }
  }, true);
}
