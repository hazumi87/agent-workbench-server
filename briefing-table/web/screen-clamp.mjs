/**
 * Lay the app out in the width the GLASS has, not the width the browser claims.
 *
 * `width=device-width` is a request, and iOS can answer it with a width the
 * screen does not have. On Owner's phone (Display Zoom on, Edge-on-iOS — same
 * WebKit as Safari) the layout viewport came out 398 CSS px against a
 * `screen.width` of 320: a quarter of the app sat permanently off the right
 * edge, unreachable, because html/body are overflow:hidden. Every containment
 * rule in solo.css was working correctly and none of it helped — they all
 * contained the page to 398, and 398 was never the right number.
 *
 * Removing `maximum-scale=1.0` from the viewport meta is the real fix and it is
 * done (see solo.html). This is the net under it, for the case where the browser
 * lays out wide anyway. REWRITING THE META AT RUNTIME DOES NOT WORK — measured
 * live on his device at 04:38: the clamp fired, set `width=320`, and innerWidth
 * stayed 398. iOS applies a viewport meta at load and ignores later width
 * changes. So do not ask the browser for a narrower viewport; simply lay the app
 * out inside one. `--app-w` is the visible width, the app's root box is pinned
 * to it, and the leftover strip of layout viewport is blank ground nobody sees.
 *
 * `screen.width` is famously unreliable — on iOS it reports the PORTRAIT width
 * whichever way the phone is held — so read it through the current orientation
 * rather than trusting the axis.
 */

/** The width actually on screen, or null when we cannot do better than trust
 *  the browser (desktop, or a device that reports nothing useful). */
export function visibleWidth() {
  const sw = window.screen?.width;
  const sh = window.screen?.height;
  if (!sw || !sh) {
    return null;
  }
  const portrait = window.innerHeight >= window.innerWidth;
  return portrait ? Math.min(sw, sh) : Math.max(sw, sh);
}

/**
 * Set `--app-w` when the layout viewport overhangs the screen, and keep it in
 * step with rotation. Returns nothing; read `--app-w` from CSS.
 */
export function installScreenClamp(onChange) {
  const apply = () => {
    const visible = visibleWidth();
    const root = document.documentElement;
    /* 2% slack: safe-area insets and rounding are not a bug. A quarter of the
       page hanging off the side is. */
    const overhangs = visible !== null && window.innerWidth > visible * 1.02;
    if (overhangs) {
      root.style.setProperty('--app-w', `${visible}px`);
      root.classList.add('is-screen-clamped');
    } else {
      root.style.removeProperty('--app-w');
      root.classList.remove('is-screen-clamped');
    }
    onChange?.(overhangs ? visible : null);
  };
  apply();
  window.addEventListener('resize', apply);
  /* iOS reports the new orientation late; re-measure after it settles. */
  window.addEventListener('orientationchange', () => setTimeout(apply, 300));
  return apply;
}
