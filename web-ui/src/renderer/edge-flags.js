// The two edge flags, CLIs on the left and the Concierge on the right (0.12.3, the design , 2–3):
// at rest a slim 10 × 48 tab flush to the edge, vertically centered on the stage, with only a dot when
// something there needs attention. It opens to the full flag (icon and count) when the pointer comes
// within 48 px of that edge and within 96 px above or below it, and tucks back 400 ms after the pointer
// leaves that zone. Keyboard focus opens it (Enter opens its rail or dock as before). On touch, the first
// tap opens the flag and the second opens the rail. The slide itself is CSS; reduced motion drops it.
const NEAR_X = 48;
const NEAR_Y = 96;
const CLOSE_AFTER_MS = 400;

export function edgeFlags(flags) {
  const state = new Map(); // el -> { timer, pinnedOpen }
  for (const f of flags) {
    state.set(f.el, { timer: null, pinnedOpen: false });
    f.el.addEventListener('focus', () => open(f.el, true));
    f.el.addEventListener('focusin', () => open(f.el, true));
    f.el.addEventListener('blur', () => {
      state.get(f.el).pinnedOpen = false;
      scheduleClose(f.el);
    });
    // touch: the first tap opens the flag only; the click that follows it is swallowed
    f.el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' && !f.el.classList.contains('edge-open')) {
        open(f.el, true);
        f.el.dataset.tapOpened = '1';
      }
    });
    f.el.addEventListener(
      'click',
      (e) => {
        if (f.el.dataset.tapOpened === '1') {
          delete f.el.dataset.tapOpened;
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      true,
    );
  }

  function open(el, keep) {
    const s = state.get(el);
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    if (keep) {
      s.pinnedOpen = true;
    }
    el.classList.add('edge-open');
  }
  function scheduleClose(el) {
    const s = state.get(el);
    if (s.pinnedOpen || s.timer) {
      return;
    }
    s.timer = setTimeout(() => {
      s.timer = null;
      if (!s.pinnedOpen) {
        el.classList.remove('edge-open');
      }
    }, CLOSE_AFTER_MS);
  }

  let raf = 0;
  let last = null;
  function onMove(e) {
    if (e.pointerType === 'touch') {
      return;
    }
    last = { x: e.clientX, y: e.clientY };
    if (raf) {
      return;
    }
    raf = requestAnimationFrame(() => {
      raf = 0;
      const { x, y } = last;
      for (const f of flags) {
        const el = f.el;
        if (el.hidden || !el.isConnected) {
          continue;
        }
        const r = el.getBoundingClientRect();
        if (!r.width) {
          continue;
        }
        const nearX = f.side === 'left' ? x <= r.right - r.width + NEAR_X && x >= 0 : x >= r.left + r.width - NEAR_X && x <= window.innerWidth;
        const cy = r.top + r.height / 2;
        const nearY = Math.abs(y - cy) <= NEAR_Y + r.height / 2;
        if (nearX && nearY) {
          open(el, false);
        } else if (el.classList.contains('edge-open')) {
          scheduleClose(el);
        }
      }
    });
  }
  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerleave', () => flags.forEach((f) => scheduleClose(f.el)));
  document.addEventListener('mouseleave', () => flags.forEach((f) => scheduleClose(f.el)));

  return {
    /** The self-test's hand: where the pointer is, as a pointermove would report it. */
    pointerAt: (x, y) => onMove({ pointerType: 'mouse', clientX: x, clientY: y }),
    isOpen: (el) => el.classList.contains('edge-open'),
  };
}
