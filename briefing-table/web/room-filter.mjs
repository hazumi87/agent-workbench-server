/* THE LINE FILTER AS ONE BUTTON (the design system room-filter-v1, Owner 2026-09-28:
 * "hide the chat/fact/delivery etc. and everyone dropdown at the top of the pc
 * app under an icon with a context menu for the selections").
 *
 * Desktop takes the PHONE's control: the same three-line glyph, the same teal
 * "not the room default" dot, the same choices. The strip over the line is
 * gone; this button sits in the room bar immediately left of the gear.
 *
 * THE MENU (the CLI Manager's menu surface, as the seat menu): a dropdown
 * under the button, right-aligned, 268px, scrolling inside when short.
 *   1. SHOW ON THE LINE  menuitemradio: Everyone · To me · Between agents ·
 *                        each @handle in its project ink
 *   2. KINDS             menuitemcheckbox, one per line kind; the last one
 *                        on cannot be turned off (the line never goes blank)
 *   3. the room default in words + Reset (disabled when already on it;
 *      Reset leaves the menu open so you can watch it happen)
 * Changes apply live behind the open menu. Esc, a click away or the button
 * close it and return the focus; Enter / Space / ↓ on the button opens it on
 * the current seat choice; the arrows move; Space toggles.
 *
 * THE PHONE keeps its header button; its sheet gains the same KINDS section
 * and the default + Reset footer (sheetSections).
 *
 * This module owns NO filter state. room.js holds the feed and hands in thin
 * hooks:
 *   btn                 the bar's button (web/room.html #filterBtn)
 *   kinds               the line kinds, in order (room.js KINDS)
 *   feed() / def()      {kinds:[shown...], who} now / the room's default
 *   whoOptions()        [[value, label, color?]...] in menu order
 *   whoLabel(who)       the lower-case words for a choice ("to me", "@x")
 *   setWho(who)         pick a seat choice
 *   toggleKind(k)       -> false when refused (the last kind on)
 *   reset()             back to the room's default
 *   refreshSheet()      the phone's filter sheet redraws its rows
 */

const W = 268;
const CHECK = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2 5 8.5l4.5-5"/></svg>';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) {
    e.className = cls;
  }
  if (text !== undefined) {
    e.textContent = text;
  }
  return e;
}

export function mountFilter(o) {
  const btn = o.btn;
  const menu = el('div', 'rf-menu');
  menu.id = 'filterMenu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Filter the chat');
  menu.hidden = true;
  document.body.append(menu);
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', menu.id);

  let whoSig = '';
  let whoGroup = null;
  let kindGroup = null;
  let note = null;
  let resetBtn = null;

  const isDefault = () => sameFeed(o.feed(), o.def());
  function sameFeed(a, b) {
    return a.who === b.who && a.kinds.join() === b.kinds.join();
  }
  function kindsWords(kinds) {
    return kinds.length === o.kinds.length ? 'all kinds' : kinds.length ? kinds.join(', ') : 'no kinds';
  }

  function build() {
    menu.textContent = '';
    menu.append(el('div', 'rf-mh', 'Show in the chat'));
    whoGroup = el('div', 'rf-grp');
    whoGroup.setAttribute('role', 'group');
    whoGroup.setAttribute('aria-label', 'Show in the chat');
    for (const [v, label, color] of o.whoOptions()) {
      const b = el('button', 'rf-mi rf-radio');
      b.type = 'button';
      b.setAttribute('role', 'menuitemradio');
      b.dataset.who = v;
      const t = el('span', color !== undefined ? 'rf-h' : 'rf-t', label);
      if (color) {
        t.style.setProperty('--pc', color); // the project ink is DERIVED in CSS, never the raw colour
      }
      b.append(t, el('span', 'rf-ck', '✓'));
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        o.setWho(v);
        paint();
        focusKey(`[data-who="${CSS.escape(v)}"]`);
      });
      whoGroup.append(b);
    }
    menu.append(whoGroup, el('div', 'rf-sep'), el('div', 'rf-mh', 'Kinds'));
    kindGroup = el('div', 'rf-grp');
    kindGroup.setAttribute('role', 'group');
    kindGroup.setAttribute('aria-label', 'Kinds');
    for (const k of o.kinds) {
      const b = el('button', 'rf-mi rf-check');
      b.type = 'button';
      b.setAttribute('role', 'menuitemcheckbox');
      b.dataset.kind = k;
      const box = el('span', 'rf-box');
      box.innerHTML = CHECK;
      b.append(box, el('span', 'rf-t', k));
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        o.toggleKind(k); // refused for the last kind on: nothing changes
        paint();
        b.focus({ preventScroll: true });
      });
      kindGroup.append(b);
    }
    menu.append(kindGroup, el('div', 'rf-sep'));
    const foot = el('div', 'rf-foot');
    note = el('span', 'rf-note');
    resetBtn = el('button', 'rf-reset', 'Reset');
    resetBtn.type = 'button';
    resetBtn.setAttribute('role', 'menuitem');
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (resetBtn.getAttribute('aria-disabled') === 'true') {
        return;
      }
      o.reset();
      paint();
      focusCurrent(); // Reset is disabled now: the focus goes to the seat choice
    });
    foot.append(note, resetBtn);
    menu.append(foot);
  }

  /** The whole visible state, from the feed: the menu's checks, the footer,
   *  the button's dot and its name. Cheap; called on every change. */
  function paint() {
    const sig = JSON.stringify(o.whoOptions());
    if (sig !== whoSig) {
      const key = document.activeElement && menu.contains(document.activeElement) ? keyOf(document.activeElement) : null;
      whoSig = sig;
      build();
      if (key) {
        focusKey(key);
      }
    }
    const f = o.feed();
    const d = o.def();
    const known = [...whoGroup.children].some((b) => b.dataset.who === f.who);
    for (const b of whoGroup.children) {
      b.setAttribute('aria-checked', String(b.dataset.who === (known ? f.who : '')));
    }
    for (const b of kindGroup.children) {
      b.setAttribute('aria-checked', String(f.kinds.includes(b.dataset.kind)));
      b.title = f.kinds.length === 1 && f.kinds[0] === b.dataset.kind ? 'At least one kind stays on' : '';
    }
    const def = isDefault();
    note.textContent = '';
    note.append(`Room default: ${o.whoLabel(d.who)} · ${kindsWords(d.kinds)}.`, el('br'), 'Set it in ⚙ Room settings.');
    resetBtn.setAttribute('aria-disabled', String(def));
    resetBtn.title = def ? 'Already showing the room default' : "Return the chat to the room's default";
    btn.classList.toggle('is-filtered', !def);
    const name = def ? 'Filter the chat' : `Filter the chat · showing: ${o.whoLabel(f.who)} · ${f.kinds.length} of ${o.kinds.length} kinds`;
    btn.title = name;
    btn.setAttribute('aria-label', name);
  }

  function keyOf(node) {
    if (node.dataset.who !== undefined) {
      return `[data-who="${CSS.escape(node.dataset.who)}"]`;
    }
    if (node.dataset.kind) {
      return `[data-kind="${CSS.escape(node.dataset.kind)}"]`;
    }
    return '.rf-reset';
  }
  function focusKey(sel) {
    menu.querySelector(sel)?.focus({ preventScroll: true });
  }
  function focusCurrent() {
    (menu.querySelector('.rf-radio[aria-checked="true"]') ?? menu.querySelector('.rf-mi'))?.focus({ preventScroll: true });
  }
  const items = () => [...menu.querySelectorAll('.rf-mi, .rf-reset:not([aria-disabled="true"])')];

  function place() {
    const r = btn.getBoundingClientRect();
    const top = Math.round(r.bottom + 4);
    menu.style.top = `${top}px`;
    menu.style.left = `${Math.round(Math.max(8, Math.min(r.right - W, innerWidth - W - 8)))}px`;
    menu.style.maxHeight = `${Math.max(120, Math.min(560, innerHeight - top - 12))}px`;
  }

  const isOpen = () => !menu.hidden;
  function open() {
    if (isOpen()) {
      return;
    }
    paint();
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    place();
    focusCurrent();
    document.addEventListener('pointerdown', onAway, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', place);
  }
  function close(refocus = true) {
    if (!isOpen()) {
      return;
    }
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onAway, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('resize', place);
    if (refocus) {
      btn.focus({ preventScroll: true });
    }
  }
  /* a click away closes it; the focus goes back to the button unless the
     click itself landed on something that takes the focus */
  function onAway(e) {
    if (menu.contains(e.target) || btn.contains(e.target)) {
      return;
    }
    close(!e.target.closest?.('button, input, textarea, select, a[href], [tabindex], iframe'));
  }
  /* a press inside a framed page never reaches this document */
  function onBlur() {
    close(false);
  }

  btn.addEventListener('click', () => (isOpen() ? close() : open()));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && !isOpen()) {
      e.preventDefault();
      open();
    }
  });
  menu.addEventListener('keydown', (e) => {
    const all = items();
    const i = all.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // one Esc closes only the thing on top
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus({ preventScroll: false });
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      all[e.key === 'Home' ? 0 : all.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      close(false);
      btn.focus({ preventScroll: true }); // the Tab then moves on from the button
    }
  });

  /** The PHONE sheet's second and third sections, appended under the seat
   *  choices room.js already draws: the kinds, then the default + Reset. */
  function sheetSections(body) {
    const f = o.feed();
    const h = el('h3', '', 'Kinds');
    const ol = el('ol', 'rf-slist');
    ol.setAttribute('aria-label', 'Kinds');
    for (const k of o.kinds) {
      const li = el('li');
      const b = el('button', 'rf-srow');
      b.type = 'button';
      b.dataset.kind = k;
      b.setAttribute('role', 'checkbox');
      b.setAttribute('aria-checked', String(f.kinds.includes(k)));
      const box = el('span', 'rf-box');
      box.innerHTML = CHECK;
      b.append(box, el('span', 'rf-t', k));
      b.addEventListener('click', () => {
        o.toggleKind(k);
        paint();
        o.refreshSheet();
      });
      li.append(b);
      ol.append(li);
    }
    const d = o.def();
    const foot = el('div', 'rf-sfoot');
    const n = el('span', 'rf-note');
    n.append(`Room default: ${o.whoLabel(d.who)} · ${kindsWords(d.kinds)}.`, el('br'), 'Set it in ⚙ Room settings.');
    const r = el('button', 'rf-reset', 'Reset');
    r.type = 'button';
    const def = isDefault();
    r.disabled = def;
    r.addEventListener('click', () => {
      o.reset();
      paint();
      o.refreshSheet(); // the sheet stays up: you watch it happen
    });
    foot.append(n, r);
    body.append(h, ol, foot);
  }

  return { paint, open, close, isOpen, sheetSections };
}
