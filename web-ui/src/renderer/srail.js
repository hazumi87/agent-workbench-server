// The shared rail (0.19.0, B1–B6): one pattern for the Terminals panel (CLIs and Recipes, with its
// SERVERS list) and the Workrooms room rail. the design's "One rail for the Workbench" (aurora <commit>,
// <commit>, <commit>, <commit>, <commit>; the owner , , ). The Terminals panel is the
// reference: a 56 px header (title, pin, ✕ only while it floats), group labels on a color band with an
// icon, a caret and a +, 56 px rows with a 36 px icon and the name in the item's own color, and the
// state chip at the start of the second line.
//
// Each rail builds its own rows; this module holds what they share: the pin rule, collapsed groups,
// the group label, the room plate and the working ring. The look is in srail.css.

import { icon } from './m3-chrome.js';

export const PIN_FROM = 700; // under this the rail floats from the slim flag ("Not enough room to pin")
export const SLIM_UNDER = 900; // 240 px under this, 272 px from it

// The twelve swatches (the design's step-5 page, "Colors"): a room's color and, later, your own.
export const SWATCHES = ['#2E7D32', '#2B7A8C', '#2A5DA8', '#6B4EA2', '#A23B4F', '#C2185B', '#E8692C', '#C98A10', '#5B7B2E', '#00796B', '#5D4037', '#546E7A'];

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) {
    e.className = cls;
  }
  if (text != null) {
    e.textContent = text;
  }
  return e;
};

// Both rails start pinned (the owner ). Unpinning is remembered per window (sessionStorage is one
// window's) and per tab, so a person who unpins Terminals keeps Workrooms pinned.
export function isUnpinned(tab) {
  try {
    return sessionStorage.getItem('wb.sr.unpinned.' + tab) === '1';
  } catch (e) {
    return false;
  }
}
export function setUnpinned(tab, on) {
  try {
    sessionStorage.setItem('wb.sr.unpinned.' + tab, on ? '1' : '0');
  } catch (e) {
    // this window only, and only while it lasts
  }
}

// A group folded away with its caret stays folded in this window, per tab.
function collapsedSet(tab) {
  try {
    const a = JSON.parse(sessionStorage.getItem('wb.sr.collapsed.' + tab) || '[]');
    return new Set(Array.isArray(a) ? a : []);
  } catch (e) {
    return new Set();
  }
}
export function isCollapsed(tab, key) {
  return collapsedSet(tab).has(key);
}
export function toggleCollapsed(tab, key) {
  const s = collapsedSet(tab);
  if (s.has(key)) {
    s.delete(key);
  } else {
    s.add(key);
  }
  try {
    sessionStorage.setItem('wb.sr.collapsed.' + tab, JSON.stringify([...s]));
  } catch (e) {
    // not remembered
  }
  return s.has(key);
}

/** The rail's header: the title, the pin, and ✕ only while the rail floats over the page.
 *  o: { title, pinned, canPin, onPin(), onClose() }. The pin's words are the design's: "Unpin", "Pin",
 *  "Not enough room to pin" (then it is off). */
export function railHead(o) {
  const h = el('div', 'sr-h');
  const t = el('div', 'sr-t', o.title);
  t.title = o.title;
  h.appendChild(t);
  const pin = el('button', 'sr-hb sr-pin' + (o.pinned ? ' on' : ''));
  pin.type = 'button';
  pin.title = o.pinned ? 'Unpin' : o.canPin ? 'Pin' : 'Not enough room to pin';
  pin.setAttribute('aria-label', pin.title);
  pin.setAttribute('aria-pressed', String(!!o.pinned));
  pin.disabled = !o.pinned && !o.canPin;
  pin.innerHTML = icon('keep', o.pinned ? 'fill' : '');
  if (o.onPin) {
    pin.addEventListener('click', () => o.onPin());
  }
  h.appendChild(pin);
  if (!o.pinned) {
    const x = el('button', 'sr-hb sr-close');
    x.type = 'button';
    x.title = 'Close';
    x.setAttribute('aria-label', 'Close the list');
    x.innerHTML = icon('close');
    if (o.onClose) {
      x.addEventListener('click', () => o.onClose());
    }
    h.appendChild(x);
  }
  return { el: h, pin, title: t };
}

/** A group label: an icon, the label in capitals on a band of the group's color (30 % fading to 6 %,
 *  a 3 px edge), then the caret and the +. o: { key, icon, label, color, collapsed, onToggle(),
 *  add: { title, fn(button), dataset } | null, extra: Node | null }. Clicking the label or the caret folds it. */
export function groupLabel(o) {
  const g = el('div', 'sr-g' + (o.collapsed ? ' collapsed' : ''));
  g.dataset.grp = o.key;
  g.setAttribute('role', 'presentation');
  if (o.color) {
    g.style.setProperty('--g', o.color);
  }
  g.insertAdjacentHTML('beforeend', icon(o.icon || 'view_agenda', 'gi'));
  g.appendChild(el('span', 't', o.label));
  if (o.extra) {
    g.appendChild(o.extra);
  }
  const cr = el('button', 'sr-gb sr-caret');
  cr.type = 'button';
  cr.title = o.collapsed ? 'Show' : 'Fold away';
  cr.setAttribute('aria-label', (o.collapsed ? 'Show ' : 'Fold away ') + o.label);
  cr.setAttribute('aria-expanded', String(!o.collapsed));
  cr.innerHTML = icon('expand_more');
  g.appendChild(cr);
  if (o.add) {
    const b = el('button', 'sr-gb sr-add');
    b.type = 'button';
    b.title = o.add.title;
    b.setAttribute('aria-label', o.add.title);
    b.setAttribute('aria-haspopup', o.add.menu ? 'menu' : 'false');
    b.innerHTML = icon('add');
    for (const [k, v] of Object.entries(o.add.dataset || {})) {
      b.dataset[k] = v;
    }
    if (o.add.fn) {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        o.add.fn(b);
      });
    }
    g.appendChild(b);
  }
  if (o.onToggle) {
    g.addEventListener('click', (e) => {
      if (e.target.closest('.sr-add') || (o.extra && o.extra.contains(e.target) && e.target.closest('button'))) {
        return;
      }
      e.stopPropagation();
      o.onToggle();
    });
  }
  return g;
}

/** The room plate (briefing-table's): a rounded square, a 2 px outline in the room's color, a dark
 *  tinted fill and a small dark square inside. */
export function plate(color, size = 36) {
  const p = el('span', 'sr-ic sr-plate');
  p.style.setProperty('--plate', color || 'var(--md-sys-color-primary)');
  if (size !== 36) {
    p.style.setProperty('--ps', size + 'px');
  }
  p.setAttribute('aria-hidden', 'true');
  return p;
}

/** The working ring around a seat's avatar (the design's "An agent that is working", <commit>): a 2 px
 *  arc in primary turning once per 1.2 s while the seat works; a still amber circle while it waits for
 *  you; still under reduced motion. One ring per seat at most. */
export function withRing(avatar, state) {
  const w = el('span', 'sr-ic sr-avw' + (state ? ' ' + state : ''));
  w.appendChild(avatar);
  if (state) {
    const r = el('span', 'sr-ring');
    r.setAttribute('aria-hidden', 'true');
    w.appendChild(r);
  }
  return w;
}
