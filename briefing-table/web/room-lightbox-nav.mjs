/* ============================================================================
 * LIGHTBOX GALLERY — ‹ › beside the big image, the arrow keys, and the mouse's
 * back / forward buttons step through the images of the set it was opened from
 * (Owner [ref]), so he does not close it and open the next.
 *
 * Opens are the openers' own (room-scratchpad-view openLarge, room-image-links
 * openFull); they call `openGallery(lb, items, index)` with the SET they were
 * opened from. Any other opener (room-cells) just fills #lbBody and never
 * touches this: the state below is dropped the moment the lightbox hides, so
 * a stale set can never answer an arrow on a different image.
 *
 *   items: [{ src: string, name: string }]   index: the one to show first
 * ========================================================================== */

const states = new WeakMap();

function ensure(lb) {
  let s = states.get(lb);
  if (s) {
    return s;
  }
  s = { items: [], i: 0, prev: null, next: null, count: null };
  states.set(lb, s);
  const mk = (cls, label, text) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `rm-lb-nav ${cls}`;
    b.setAttribute('aria-label', label);
    b.textContent = text;
    /* the lightbox closes on any click: a step must not */
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      step(lb, cls === 'prev' ? -1 : 1);
    });
    return b;
  };
  s.prev = mk('prev', 'Previous image', '‹');
  s.next = mk('next', 'Next image', '›');
  s.count = document.createElement('span');
  s.count.className = 'rm-lb-count';
  lb.append(s.prev, s.next);
  lb.querySelector('#lbCap')?.after(s.count);

  const active = () => !lb.hidden && s.items.length > 1;
  document.addEventListener('keydown', (e) => {
    if (!active() || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) {
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      step(lb, e.key === 'ArrowLeft' ? -1 : 1);
    }
  });
  /* the mouse's side buttons: 3 = back, 4 = forward. The browser would navigate
     the page on them, so both edges are swallowed while the lightbox is up. */
  const side = (e) => e.button === 3 || e.button === 4;
  document.addEventListener('mousedown', (e) => {
    if (active() && side(e)) {
      e.preventDefault();
    }
  }, true);
  document.addEventListener('mouseup', (e) => {
    if (active() && side(e)) {
      e.preventDefault();
      step(lb, e.button === 3 ? -1 : 1);
    }
  }, true);
  new MutationObserver(() => {
    if (lb.hidden) {
      s.items = [];
      paintNav(s);
    }
  }).observe(lb, { attributes: true, attributeFilter: ['hidden'] });
  return s;
}

function paintNav(s) {
  const many = s.items.length > 1;
  s.prev.hidden = !many;
  s.next.hidden = !many;
  s.count.hidden = !many;
  if (many) {
    s.prev.disabled = s.i <= 0;
    s.next.disabled = s.i >= s.items.length - 1;
    s.count.textContent = `${s.i + 1} of ${s.items.length}`;
  }
}

function paintImage(lb, s) {
  const it = s.items[s.i];
  const body = lb.querySelector('#lbBody');
  const cap = lb.querySelector('#lbCap');
  body.textContent = '';
  const img = document.createElement('img');
  img.alt = it.name;
  img.referrerPolicy = 'no-referrer';
  img.decoding = 'async';
  img.src = it.src;
  body.append(img);
  cap.textContent = it.name;
  paintNav(s);
}

function step(lb, d) {
  const s = states.get(lb);
  if (!s) {
    return;
  }
  const j = s.i + d;
  if (j < 0 || j >= s.items.length) {
    return;
  }
  s.i = j;
  paintImage(lb, s);
}

/** Show items[index] in the lightbox with ‹ › over the whole set. The caller
 *  has already checked the lightbox exists; it still owns focus-return. */
export function openGallery(lb, items, index) {
  const s = ensure(lb);
  s.items = items;
  s.i = Math.max(0, Math.min(items.length - 1, index));
  paintImage(lb, s);
  lb.hidden = false;
  lb.tabIndex = -1;
  lb.focus({ preventScroll: true });
}
