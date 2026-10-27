/**
 * THE ROOM TOAST (the design system room-toast-v1 sections 1-5, hub v2 2026-10-05): ONE toast for the whole page.
 *   toast(text, { action: {label, run}, kind: 'info' | 'error', ms })
 * Under the title bar (top = the header's bottom + 8px, right 12px), slides in from the right, on a wash of the
 * room color's COMPLEMENTARY hue (CSS, web/room-toast.css). `text` may be a string or a Node (the workgroup
 * toast puts a plate and a bold name in it).
 *   - life: info 4 s; an action or an error 8 s; `ms` overrides (Notes keeps its short one). A pointer or
 *     keyboard focus on it pauses the clock; it restarts at 2.5 s when they leave.
 *   - a second toast REPLACES the one showing in place, except that a toast with an ACTION is never pushed out
 *     by one without: the new one stacks 6px under it, and the pair never grows past two.
 *   - error: coral, a "!" disc, role=alert. A neutral room (chroma < .03) wears the info hue instead.
 *   - phone: 8px side margins, 48px tall at least, 44px targets, a swipe right dismisses.
 */
const LIFE = 4000;
const LIFE_LONG = 8000;
const LEAVE_MS = 2500;
const GAP = 6;
const list = []; // {el, o, timer}, at most two

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) { n.className = cls; }
  if (text !== undefined) { n.textContent = text; }
  return n;
};

/** Chroma of a #rrggbb (OKLab), for the neutral-room test. */
function chromaOf(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) { return 1; }
  const lin = (i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin(0), lin(2), lin(4)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.4285922050 * mm + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * mm - 0.8086757660 * s;
  return Math.hypot(a, bb);
}
export const isNeutralRoom = () => {
  try {
    return chromaOf(getComputedStyle(document.body).getPropertyValue('--room-c')) < 0.03;
  } catch {
    return false;
  }
};

/** The header's bottom edge: the PC's bar, or the phone's two rows. */
function headerBottom() {
  for (const q of ['.ph-hdr', '.rm-top']) {
    const h = document.querySelector(q);
    const r = h?.getBoundingClientRect();
    if (r && r.height > 0) { return r.bottom; }
  }
  return 48;
}

function layout() {
  let y = headerBottom() + 8;
  for (const t of list) {
    t.el.style.top = `${y}px`;
    y += t.el.offsetHeight + GAP;
  }
}

function arm(t, ms) {
  clearTimeout(t.timer);
  t.timer = setTimeout(() => remove(t), ms);
}

function remove(t) {
  clearTimeout(t.timer);
  const i = list.indexOf(t);
  if (i < 0) { return; }
  list.splice(i, 1);
  t.el.classList.add('out');
  t.el.classList.remove('in');
  setTimeout(() => { t.el.remove(); layout(); }, 200);
  layout();
}

function build(text, o) {
  const err = o.kind === 'error';
  const n = el('div', `rm-toast${err ? ' err' : ''}${isNeutralRoom() ? ' neutral' : ''}`);
  n.setAttribute('role', err ? 'alert' : 'status');
  if (err) {
    const bang = el('span', 'bang', '!');
    bang.setAttribute('aria-hidden', 'true');
    n.append(bang);
  }
  const tx = el('span', 'tx');
  tx.append(text instanceof Node ? text : document.createTextNode(String(text ?? '')));
  n.append(tx);
  const t = { el: n, o, timer: 0 };
  if (o.action) {
    const a = el('button', 'act', o.action.label);
    a.type = 'button';
    a.addEventListener('click', () => {
      clearTimeout(t.timer);
      Promise.resolve()
        .then(() => o.action.run?.(a))
        .catch((e) => { toast(`Could not finish: ${e?.message ?? e}`, { kind: 'error' }); }) // never swallowed
        .finally(() => remove(t));
    });
    n.append(a);
  }
  const x = el('button', 'x', '✕');
  x.type = 'button';
  x.setAttribute('aria-label', 'Dismiss');
  x.addEventListener('click', () => remove(t));
  n.append(x);
  n.addEventListener('pointerenter', () => clearTimeout(t.timer));
  n.addEventListener('focusin', () => clearTimeout(t.timer));
  n.addEventListener('pointerleave', () => arm(t, LEAVE_MS));
  n.addEventListener('focusout', () => arm(t, LEAVE_MS));
  n.addEventListener('keydown', (e) => { if (e.key === 'Escape') { remove(t); } });
  /* phone: a swipe right dismisses */
  let x0 = null;
  n.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') { x0 = e.clientX; } });
  n.addEventListener('pointermove', (e) => {
    if (x0 !== null && e.clientX > x0) { n.style.transform = `translateX(${e.clientX - x0}px)`; }
  });
  const end = (e) => {
    if (x0 === null) { return; }
    const dx = e.clientX - x0;
    x0 = null;
    n.style.transform = '';
    if (dx > 60) { remove(t); }
  };
  n.addEventListener('pointerup', end);
  n.addEventListener('pointercancel', () => { x0 = null; n.style.transform = ''; });
  return t;
}

export function toast(text, o = {}) {
  const ms = o.ms ?? (o.action || o.kind === 'error' ? LIFE_LONG : LIFE);
  const first = list[0];
  const place = (t, at) => {
    document.body.append(t.el);
    if (at === undefined) { list.push(t); } else { list[at] = t; }
    layout();
    arm(t, ms);
    requestAnimationFrame(() => requestAnimationFrame(() => t.el.classList.add('in')));
  };
  const swap = (old, t) => { // in place: the text and kind change, no second slide
    const i = list.indexOf(old);
    clearTimeout(old.timer);
    t.el.classList.add('in');
    t.el.style.transition = 'none';
    old.el.replaceWith(t.el);
    list[i] = t;
    layout();
    arm(t, ms);
    requestAnimationFrame(() => { t.el.style.transition = ''; });
  };
  const t = build(text, o);
  if (first && first.o.action && !o.action) { // an action toast is never pushed out by a plain one
    if (list[1]) { swap(list[1], t); } else { place(t); }
  } else if (first && !list[1]) {
    swap(first, t);
  } else {
    list.slice().forEach(remove);
    place(t);
  }
  return t.el;
}
