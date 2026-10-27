/* A TEXT FIELD IN A DIALOG STAYS ABOVE THE SOFT KEYBOARD [dialog kb] Owner 2026-10-06 (phone: the seat Reload card's welcome box was
 * under the keyboard, so it could not be edited). The CSS half (room.css `html.kb-up .rsm-dscrim ...`) shrinks every dialog scrim to
 * the VISIBLE area (--vv-top / --vvh, set by web/soft-keyboard.mjs) and caps the card to it, scrolling inside. This is the other half:
 * when a field in a dialog takes focus, and again as the keyboard settles or changes height, scroll it into view inside its card. */
const DIALOG = '.rsm-card, .apc-card, .nt-card, .ad-card, .dv-card, .rbf';
const FIELD = 'textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="button"]):not([type="submit"])';

export const isDialogField = (t) => t instanceof Element && t.matches(FIELD) && !!t.closest(DIALOG);

function lift(el) {
  try {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  } catch {
    /* an element that left the page */
  }
}

export function mountDialogKeyboard() {
  document.addEventListener('focusin', (e) => {
    if (isDialogField(e.target)) {
      const t = e.target;
      setTimeout(() => lift(t), 60); // the keyboard has started to rise
      setTimeout(() => lift(t), 450); // ...and has settled
    }
  });
  /* the keyboard rose, fell or changed height (room page: 'room-kb', solo / manager: 'soft-kb') */
  for (const ev of ['room-kb', 'soft-kb']) {
    window.addEventListener(ev, () => {
      const a = document.activeElement;
      if (isDialogField(a)) {
        lift(a);
      }
    });
  }
}
