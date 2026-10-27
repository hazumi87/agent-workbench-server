/* ROOM PREVIEW COLUMN (the design system room-round3-v1 §2): alpha-platform's viewer
 * column, minus its bar. It appears when something is picked and the main
 * column SHRINKS (a third grid column, never an overlay); 320px (min 280, max
 * 400). Header: TYPE · name, then ✕. An optional "← Back to …" trail under it.
 * ONE preview at a time: opening another replaces the content. Esc closes it
 * too, and focus returns to what opened it. Phone (≤600px): the same element
 * is a full-screen layer over the line, with a back control.
 *
 * This module knows nothing about panels or settings: a caller hands it a
 * body NODE it built (text via textContent, never HTML from a panel) and an
 * owner string. room-cells.mjs owns the panel side (who may speak, what an
 * item may carry); room.js owns the ⚙ settings body.
 */

const CLOSE_SVG = '<path d="M6 6l12 12M18 6 6 18"/>';
/* ⤢ Expand (line links [rooms/tool-links]): two corners, outward */
const EXPAND_SVG = '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>';

/**
 * @param {{main: HTMLElement, el: HTMLElement, escBlocked?: () => boolean,
 *          onChange?: (cur: object|null) => void}} o
 *   main: .rm-main (gets .has-pv); el: the empty <aside> the column lives in;
 *   escBlocked: something above the column (lightbox, sheet, completion) owns Esc.
 */
/** May the preview column take the focus now? Not while a text field outside it holds the focus (someone is typing). */
export function takesFocus(active, column) {
  if (!active || active === column || (column && column.contains && column.contains(active))) {
    return true;
  }
  const tag = String(active.tagName || '').toUpperCase();
  return !(active.isContentEditable === true || tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT');
}

export function mountPreview(o) {
  const el = o.el;
  el.classList.add('rm-pv');
  el.hidden = true;
  el.tabIndex = -1;
  el.setAttribute('role', 'complementary');
  el.setAttribute('aria-label', 'Preview');

  const head = document.createElement('div');
  head.className = 'pv-h';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'pv-back';
  back.textContent = '‹';
  back.setAttribute('aria-label', 'Back');
  const t = document.createElement('span');
  t.className = 'pv-t';
  const type = document.createElement('span');
  type.className = 'pv-type';
  const name = document.createElement('b');
  name.className = 'pv-name';
  t.append(type, name);
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'pv-x';
  x.title = 'Close (Esc)';
  x.setAttribute('aria-label', 'Close the preview');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = CLOSE_SVG; // a constant
  x.append(svg);
  /* EXPAND (the design system, line links): a 32px ghost icon button left of ✕, only for
     a spec that can go large (a panel's VIEW); never on a phone (CSS) */
  const ex = document.createElement('button');
  ex.type = 'button';
  ex.className = 'pv-ex';
  ex.title = 'Expand';
  ex.setAttribute('aria-label', 'Open large');
  ex.hidden = true;
  const exs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  exs.setAttribute('viewBox', '0 0 24 24');
  exs.setAttribute('aria-hidden', 'true');
  exs.innerHTML = EXPAND_SVG; // a constant
  ex.append(exs);
  /* TOOLS: a node a body brings for the header (the document viewer's
     full screen / link / copy / ... buttons), left of Expand */
  const tools = document.createElement('div');
  tools.className = 'pv-tools';
  head.append(back, t, tools, ex, x);
  const trail = document.createElement('button');
  trail.type = 'button';
  trail.className = 'pv-trail';
  trail.hidden = true;
  const body = document.createElement('div');
  body.className = 'pv-b';
  el.append(head, trail, body);

  let cur = null; // {owner, key, opener, root, back, view}
  /* THE RETURN STACK (ticket, Owner 2026-10-05): app views a FOREIGN content
     replaced (a room image from the Assets cell, a line link, another app's
     view), newest last. Entries: {owner, node, label, restore}. In memory
     only: a reload starts with none and the preview closed (the preview is
     never persisted), so no stale stack can come back. */
  const stack = [];
  const STACK_MAX = 5;

  /**
   * Open (or replace) the column.
   * spec: {owner, key?, type?, name, body: Node, keep?: Node[],
   *        back?: {label, go}, opener?: Element}
   *   keep: nodes to hold HIDDEN in the column (a view frame an item came
   *   from, so its "Back" does not reload it). Everything else is dropped.
   *   opener: what focus returns to on close; omitted = keep the current one.
   *   tools: a Node for the header, left of Expand and ✕ (dropped on the next open).
   *   expand(btn): shows the ⤢ Expand button (desktop), called with it on click.
   *   view: {node, label, restore} when this content IS an app view, or an item
   *   that came from one (restore() shows that view again; false = gone).
   *   foreign: this content did NOT come from the app view underneath it, so
   *   the view it replaces is pushed on the return stack (✕ pops it).
   */
  function open(spec) {
    if (spec.foreign && cur?.view && cur.view.node !== spec.view?.node && stack.at(-1)?.node !== cur.view.node) {
      stack.push({ owner: cur.owner, node: cur.view.node, label: cur.view.label, restore: cur.view.restore });
      stack.splice(0, Math.max(0, stack.length - STACK_MAX)); // the oldest falls off; its node is dropped below
    }
    /* root = what opened the column for this owner: a Back inside it keeps it */
    const same = cur && cur.owner === spec.owner;
    const root = same ? cur.root : spec.opener ?? document.activeElement;
    cur = { owner: spec.owner, key: spec.key ?? null, opener: spec.opener ?? (same ? cur.opener : root), root, back: spec.back ?? null, expand: spec.expand ?? null, view: spec.view ?? null };
    ex.hidden = !cur.expand;
    tools.replaceChildren(...(spec.tools ? [spec.tools] : []));
    type.textContent = spec.type || '';
    name.textContent = spec.name || '';
    t.classList.toggle('no-type', !spec.type);
    t.title = spec.type ? `${spec.type} · ${spec.name || ''}` : spec.name || '';
    trail.hidden = !spec.back;
    trail.textContent = spec.back ? spec.back.label : '';
    /* never MOVE a node that stays: moving an iframe reloads it */
    /* the stacked views stay in the column, hidden: an iframe moved or dropped reloads */
    const keep = [...(spec.keep || []), ...stack.map((e) => e.node)].filter((n) => n && n !== spec.body);
    for (const n of [...body.children]) {
      if (n !== spec.body && !keep.includes(n)) {
        n.remove();
      }
    }
    for (const n of keep) {
      n.hidden = true;
      if (n.parentNode !== body) {
        body.append(n);
      }
    }
    if (spec.body.parentNode !== body) {
      body.prepend(spec.body);
    }
    spec.body.hidden = false;
    body.scrollTop = 0;
    const was = el.hidden;
    el.hidden = false;
    o.main.classList.add('has-pv');
    paintX();
    /* take the focus out of the frame that asked (Esc typed there would go to
       the frame, not to us), and onto the column. NOT out of a text field the person is typing in: the Scratchpad list
       re-opens the column on every 15 s refresh, and each one pulled the caret out of the note or the message box. */
    if (takesFocus(document.activeElement, el)) {
      el.focus({ preventScroll: true });
    }
    o.onChange?.(cur, was);
  }

  /** ✕ names where it goes when there is somewhere to go back to. */
  function paintX() {
    const top = stack.at(-1);
    x.title = top ? `Back to ${top.label || 'the previous view'}` : 'Close (Esc)';
    x.setAttribute('aria-label', top ? `Back to ${top.label || 'the previous view'}` : 'Close the preview');
  }

  /** ✕ / Esc / the phone's ‹: return to the last view a foreign content
   *  replaced; close when there is none (or it is gone). */
  function dismiss() {
    while (stack.length) {
      const e = stack.pop();
      if (e.node.isConnected && e.restore() !== false) {
        return;
      }
    }
    close();
  }

  /** Drop the stacked views of `owner` (its view was replaced or the panel left). */
  function forget(owner) {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].owner === owner) {
        stack.splice(i, 1);
      }
    }
    paintX();
  }

  function close(opts = {}) {
    if (!cur) {
      return;
    }
    const was = cur;
    cur = null;
    stack.length = 0; // a real close (app, panel gone, Settings, phone compose) forgets where we were
    paintX();
    el.hidden = true;
    o.main.classList.remove('has-pv');
    body.replaceChildren();
    tools.replaceChildren();
    o.onChange?.(null, false);
    if (opts.focus !== false) {
      const target = [was.opener, was.root].find((n) => n && n.isConnected && !el.contains(n) && typeof n.focus === 'function');
      target?.focus({ preventScroll: true });
    }
  }

  x.addEventListener('click', () => dismiss());
  ex.addEventListener('click', () => cur?.expand?.(ex));
  back.addEventListener('click', () => dismiss());
  trail.addEventListener('click', () => cur?.back?.go());
  /* capture phase: decide before the lightbox / sheet / completion handlers
     run, so one Esc closes only the thing on top */
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !cur || o.escBlocked?.()) {
      return;
    }
    dismiss();
  }, true);

  return {
    open,
    close,
    dismiss,
    forget,
    /** labels of the views ✕ would return to, next first */
    returns: () => stack.map((e) => e.label).reverse(),
    /** {owner, key} of what is open, or null */
    current: () => (cur ? { owner: cur.owner, key: cur.key } : null),
    el,
  };
}
