/* TOUCH CONTROLS FOLLOW THE INPUT, NOT THE WIDTH [touch-wide] Owner 2026-10-05 (iPad: "I can't use mobile
 * controls ... I need special characters and use phone nav").
 *
 * The phone layout switches on WIDTH (<= 600px), and an iPad is wider, so it got the desktop page with
 * no way to reach the places / agents sheets. This sets `html.touch-wide` on a device whose PRIMARY
 * pointer is coarse (a finger) at any width above the phone breakpoint; CSS then adds ONLY the touch
 * controls to the wide layout (the header's CLI Manager + Agents buttons). The columns stay: this is
 * not a stretched phone page. The CLI special-keys keypad already follows `(pointer: coarse)` (solo.js).
 *
 * A tablet with a trackpad or mouse reports a FINE primary pointer and stays desktop.
 * `?touch=1` / `?touch=0` overrides it either way (a heuristic that cannot be overridden is a trap).
 * `(hover: none)` is deliberately not required: Chromium's touch emulation and some WebViews report
 * `hover: hover` beside `pointer: coarse`, and a coarse primary pointer already says "a finger". */
import { touchInput } from '/soft-keyboard.mjs'; // a coarse pointer, or an iPad in desktop-class mode [ipad keypad]

const COARSE = '(pointer: coarse)';
const WIDE = '(min-width: 601px)';

export function touchWanted() {
  try {
    const o = new URLSearchParams(location.search).get('touch');
    if (o === '1') {
      return true;
    }
    if (o === '0') {
      return false;
    }
  } catch {
    /* no location: the media query decides */
  }
  return touchInput();
}

/** A PHONE by its physical screen, whatever its viewport says (Owner 2026-10-05: an iPhone in Edge's desktop mode,
 *  or rotated, reported a wide layout viewport and was wrapped in the tablet shell, "unusable"). The shorter
 *  side of the screen: every iPhone is under 500 CSS px, the smallest iPad (mini) is 744. */
export function phoneSized() {
  try {
    const w = Number(window.screen?.width) || 0;
    const h = Number(window.screen?.height) || 0;
    return w > 0 && h > 0 && Math.min(w, h) < 700;
  } catch {
    return false;
  }
}

/** True when the touch controls belong on the WIDE layout (a touch TABLET: never a phone-sized screen, unless ?touch=1). */
export const isTouchWide = () => {
  let forced = false;
  try { forced = new URLSearchParams(location.search).get('touch') === '1'; } catch { /* no location */ }
  return touchWanted() && window.matchMedia?.(WIDE)?.matches === true && (forced || !phoneSized());
};

export function mountTouchUi(root = document.documentElement) {
  const paint = () => root.classList.toggle('touch-wide', isTouchWide());
  paint();
  for (const q of [COARSE, WIDE]) {
    const m = window.matchMedia?.(q);
    m?.addEventListener?.('change', paint);
  }
  return paint;
}
