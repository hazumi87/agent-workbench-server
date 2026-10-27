/* FOCUS RINGS FOR KEYBOARD USERS ONLY (the design system r22c review, 2026-09-28).
 *
 * A sheet or menu moves focus into itself when it opens (so Esc, the arrows
 * and Tab work at once). Opened by a TAP, that programmatic focus drew the
 * teal ring on whatever it landed on: the Agents segment when the phone + sheet
 * opened, Reply in a line's long-press sheet. The ring is for someone steering
 * with a keyboard; to a finger it reads as a stray selection.
 *
 * So: remember the last way the user interacted (a key, or a pointer), and
 * focus with `focusVisible` set from it. Focus still MOVES either way (the
 * dialog stays keyboard-operable the moment a key is pressed). Where the
 * browser ignores `focusVisible` (older WebKit), the element also carries
 * `data-quiet-focus` until it blurs or the next key press, and one injected
 * rule turns its ring off.
 *
 * Before any interaction the answer is "keyboard": the safe side for someone
 * who cannot use a pointer.
 */
const QUIET = 'data-quiet-focus';
let keyboard = true;

if (typeof window !== 'undefined' && !window.__hwbFocusIntent) {
  window.__hwbFocusIntent = true;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') {
      return; // a modifier alone is not a choice of input
    }
    keyboard = true;
    for (const x of document.querySelectorAll(`[${QUIET}]`)) {
      x.removeAttribute(QUIET); // from here on the user is steering by keys: show the ring
    }
  }, true);
  window.addEventListener('pointerdown', () => {
    keyboard = false;
  }, true);
  const style = document.createElement('style');
  style.textContent = `[${QUIET}]:focus, [${QUIET}]:focus-visible { outline: none !important; box-shadow: none !important; }`;
  document.head.append(style);
}

/** Was the last interaction a key press (true before any interaction)? */
export function byKeyboard() {
  return keyboard;
}

/** Move focus to `el`, with the ring only if the user is on a keyboard. */
export function focusInto(el) {
  if (!el || typeof el.focus !== 'function') {
    return;
  }
  if (keyboard) {
    el.removeAttribute(QUIET);
    el.focus({ preventScroll: true });
    return;
  }
  el.setAttribute(QUIET, '');
  el.addEventListener('blur', () => el.removeAttribute(QUIET), { once: true });
  el.focus({ preventScroll: true, focusVisible: false });
}
