/* THE SEAT CONTEXT MENU (the design system room-seat-menu-v1, Owner 2026-09-28: "a context
 * menu on seats if we do need to disconnect individuals without disconnecting
 * the room (others are working and tools are being used)").
 *
 * The surface is the CLI Manager's room menu (web/manager-rooms.mjs,
 * cli-manager-rooms-v1) plus a TITLE ROW: the @handle in its project ink and
 * the state in words, because Remove sits in this menu and you must be able to
 * see which seat you are acting on. It opens on a right-click on a seat row,
 * the row's ⋯ (hover / focus; always on touch), Shift+F10 / the Menu key, and
 * a long press (a bottom sheet on a phone). Arrows, Enter, Esc / click-away;
 * focus returns to the row.
 *
 * ITEMS, fixed order, always present, DISABLED not hidden (positions never
 * move under the cursor): Open window · Close window ("keeps running") ·
 * Restore|Start · Disconnect ("restorable") · — · Rename @handle… · — ·
 * Remove from room… (coral, last).
 * A disabled item keeps focus (aria-disabled) and says why in its tooltip.
 *
 * The ENGINE decides: Restore / Start is whatever seat.actions offers (the
 * existing seatAct), Close window is POST .../seats/:id/close-window
 * (human-only; Owner 2026-09-28: "even within the room I can close the user's
 * window if I want": every window / tab showing the session closes, the
 * session stays live, PARKED in the broker, like a tab ✕; a room page's own
 * framed view is not a window: it neither enables the item nor closes —
 * EXCEPT this page's own frame when it is the only view of the seat (Owner
 * 2026-09-29, [perf/poll-traffic]): then the item is enabled and closing drops
 * that frame, returns to the room line and parks the session; another
 * device's room view never counts),
 * Disconnect is
 * POST .../seats/:id/disconnect (human-only,
 * ends one pane with EndReason 'cycle' = dehydrated, restorable), Rename is
 * PATCH .../seats/:id {handle}, Remove is DELETE .../seats/:id (the lead is
 * refused: "hand the lead over first"). The engine writes every fact.
 *
 * A DISCONNECTED seat is a full member at rest: the restorable ring (room.js
 * seatChrome maps dehydrated -> `restorable`, never the chrome `disconnected`
 * state, which aliases to the coral alert ring), "disconnected · 2:14 PM"
 * (who did it, "by you", is the tooltip: at the default rail width the longer
 * form truncated the time away) and the row's own Restore. statusFor()
 * supplies those words, decorate() the tooltip.
 *
 * This module owns no room state. room.js hands it thin hooks (see
 * createSeatMenu) and asks two questions: decorate(row) and holding() — while
 * a menu, a rename or the Remove dialog is up, the 2.5 s roster redraw must
 * not pull the row out from under it.
 */
import { focusInto } from '/focus-intent.mjs';
import { openProfileCard } from '/agent-profile-card.mjs';
import { toast } from '/room-toast.mjs';

const PHONE = '(max-width: 600px)';
const LONG_PRESS_MS = 500;

const ICON = {
  open: '<path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>',
  start: '<path d="M7 4l12 8-12 8z"/>',
  close: '<path d="M4 5h16v14H4zM4 9h16M9.5 12.5l5 5M14.5 12.5l-5 5"/>',
  disc: '<path d="M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0"/>',
  reload: '<path d="M21 12a9 9 0 1 1-3-6.7M21 3v6h-6"/>',
  ren: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  lead: '<path d="M12 3l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8 6.6 19.7l1.1-6.1L3.2 9.4l6.1-.8z"/>',
  col: '<circle cx="12" cy="12" r="8"/><path d="M12 4v16"/>',
  rem: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  prof: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  /* the panel menu's (the design system room-add-sheet-v1 §4) */
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  fold: '<path d="M6 9l6 6 6-6"/>',
  unfold: '<path d="M6 15l6-6 6 6"/>',
  /* a line link's menu [rooms/tool-links] */
  preview: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/>',
  expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  /* notes (web/room-notes.mjs): a page with a folded corner and two text lines; the paperclip; a draft moving into a page; an import */
  note: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  clip: '<path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7L14 4.5a3.3 3.3 0 0 1 4.7 4.7L10 18a1.7 1.7 0 0 1-2.4-2.4L15 8"/>',
  move: '<path d="M4 12h11M11 7l5 5-5 5M19 4v16"/>',
  swap: '<path d="M4 8h14l-4-4M20 16H6l4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  import: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  /* the document viewer's ... menu [ticket], the knowledge-base viewer's glyphs */
  print: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  dl: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  src: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
};
export function svg(key) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[key]}</svg>`;
}
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

/** "2:14 PM", or "Sep 27, 2:14 PM" when it was not today. */
function clock(ts) {
  const d = new Date(ts);
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${t}`;
}

/* ==== THE MENU SURFACE, shared (the design system room-add-sheet-v1 §4: the panel
 * cell's menu "is the seat-menu component exactly"). One host per menu kind:
 * it draws the surface (a title row, items in a fixed order, disabled not
 * hidden, a bottom sheet on a phone), owns the keyboard (arrows, Home/End,
 * Esc; Tab never leaves), places it, and closes on a click away or the
 * window losing focus. What an item DOES is the caller's (choose). ==== */

/**
 * @returns {{open(spec): void, close(refocus?: boolean): void, isOpen(): boolean}}
 * spec: { row, more?, point?, label, title, sub?, tone?, data?: {k: v},
 *         items: ('sep' | {a, label, icon, off?, why?, cls?, sub?, k?})[],
 *         choose(item, back), closed(back, refocus) }
 * `back` is {row, more}: where the menu came from (focus returns there).
 */
export function createMenuHost() {
  let menuEl = null;
  let scrimEl = null;
  let back = null;
  let closed = null;

  function close(refocus = true) {
    if (!menuEl) {
      return;
    }
    menuEl.remove();
    scrimEl?.remove();
    menuEl = null;
    scrimEl = null;
    document.removeEventListener('pointerdown', onAway, true);
    window.removeEventListener('blur', onBlur);
    const b = back;
    const cb = closed;
    back = null;
    closed = null;
    b?.more?.setAttribute('aria-expanded', 'false');
    cb?.(b, refocus);
  }
  /* a press inside a framed session never reaches this document: the window
     losing focus to it is the click-away */
  function onBlur() {
    close(false);
  }
  function onAway(e) {
    if (menuEl && !menuEl.contains(e.target)) {
      close(false);
    }
  }

  function open(spec) {
    close(false);
    const phone = matchMedia(PHONE).matches;
    back = { row: spec.row, more: spec.more ?? null };
    closed = spec.closed ?? null;
    spec.more?.setAttribute('aria-expanded', 'true');
    const m = el('div', `rsm-menu${phone ? ' is-sheet' : ''}`);
    m.setAttribute('role', 'menu');
    m.setAttribute('aria-label', spec.label);
    for (const [k, v] of Object.entries(spec.data ?? {})) {
      m.dataset[k] = v;
    }
    if (spec.tone) {
      m.style.setProperty('--pc', spec.tone);
    }
    if (phone) {
      m.append(el('div', 'grab'));
    }
    const title = el('div', 'rsm-mt', spec.title);
    if (spec.sub) {
      title.append(el('span', 'rsm-mst', spec.sub));
    }
    m.append(title);
    for (const it of spec.items) {
      if (it === 'sep') {
        m.append(el('div', 'rsm-msep'));
        continue;
      }
      const b = el('button', `rsm-mi${it.cls ? ` ${it.cls}` : ''}`);
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.dataset.a = it.a;
      b.innerHTML = svg(it.icon);
      b.append(it.label);
      if (it.off) {
        b.setAttribute('aria-disabled', 'true');
        b.title = it.why;
      } else if (it.sub) {
        b.append(el('span', 'rsm-sub', it.sub));
      }
      if (it.k) {
        b.append(el('span', 'rsm-k', it.k));
      }
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (b.getAttribute('aria-disabled') === 'true') {
          return; // disabled: announced, never acted on
        }
        spec.choose(it, back);
      });
      m.append(b);
    }
    if (phone) {
      /* a way out that is SEEN: on a phone the dimmed area is the only other
         exit and nothing says it is one (Owner, iPhone: "no way to exit that
         menu without pushing the back button"). Not an .rsm-mi: it is not an
         item (the arrow keys and the item count skip it). */
      m.append(el('div', 'rsm-msep'));
      const c = el('button', 'rsm-cancel', 'Cancel');
      c.type = 'button';
      c.dataset.a = 'cancel';
      c.addEventListener('click', (e) => {
        e.stopPropagation();
        close();
      });
      m.append(c);
    }
    m.addEventListener('keydown', (e) => {
      const all = [...m.querySelectorAll('.rsm-mi')];
      const i = all.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // one Esc closes only the thing on top
        close();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        all[e.key === 'Home' ? 0 : all.length - 1]?.focus();
      } else if (e.key === 'Tab') {
        e.preventDefault(); // a menu is left with Esc or a choice
      }
    });
    if (phone) {
      scrimEl = el('div', 'rsm-scrim');
      document.body.append(scrimEl);
    }
    document.body.append(m);
    menuEl = m;
    if (!phone) {
      const anchor = spec.more ?? spec.row;
      const r = anchor.getBoundingClientRect();
      const w = m.offsetWidth;
      const h = m.offsetHeight;
      const point = spec.point;
      let x = point ? point.x : spec.more ? r.right - w : r.left + 40;
      let y = point ? point.y : r.bottom + 4;
      x = Math.max(8, Math.min(x, innerWidth - w - 8));
      y = y + h > innerHeight - 8 ? Math.max(8, (point ? point.y : r.top) - h - 4) : y;
      m.style.left = `${x}px`;
      m.style.top = `${y}px`;
    }
    /* into the menu, but the ring only for a keyboard opener (a tap or a
       long press must not paint it: web/focus-intent.mjs) */
    focusInto(m.querySelector('.rsm-mi:not([aria-disabled="true"])') ?? m.querySelector('.rsm-mi'));
    /* armed at once: every opener (contextmenu, the ⋯'s click, a key, the
       long-press timer) fires AFTER its own pointerdown, so none can close it */
    document.addEventListener('pointerdown', onAway, true);
    window.addEventListener('blur', onBlur);
  }

  return { open, close, isOpen: () => !!menuEl };
}

/** The ways to open a menu on `target` besides its ⋯: a right-click,
 *  Shift+F10 / the Menu key (when `keyOn(e)` says the key is the target's),
 *  and a long press (iOS fires no contextmenu). open(point|null). */
export function wireMenuOpeners(target, open, keyOn = (e) => e.target === target, touchOn = () => true) {
  let lastTouch = false; // the pointer that started this gesture
  target.addEventListener('pointerdown', (e) => {
    lastTouch = e.pointerType === 'touch';
  }, true);
  target.addEventListener('contextmenu', (e) => {
    if (e.target.closest('input')) {
      return; // a rename field keeps the browser's own menu (paste)
    }
    if (lastTouch && !touchOn(e)) {
      return; // touchOn false: the press belongs to the browser (text selection)
    }
    e.preventDefault();
    open({ x: e.clientX, y: e.clientY });
  });
  target.addEventListener('keydown', (e) => {
    if (keyOn(e) && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) {
      e.preventDefault();
      e.stopPropagation();
      open(null);
    }
  });
  let timer = 0;
  let at = null;
  let fired = false;
  target.addEventListener('pointerdown', (e) => {
    fired = false;
    if (e.pointerType !== 'touch' || e.target.closest('button:not(.cell-h), input') || !touchOn(e)) {
      return;
    }
    at = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      timer = 0;
      fired = true;
      open(at);
    }, LONG_PRESS_MS);
  });
  const cancel = () => { clearTimeout(timer); timer = 0; };
  target.addEventListener('pointerup', cancel);
  target.addEventListener('pointercancel', cancel);
  target.addEventListener('pointermove', (e) => {
    if (timer && at && Math.hypot(e.clientX - at.x, e.clientY - at.y) > 10) {
      cancel();
    }
  });
  /* the click that ENDS a long press must not also select / toggle */
  target.addEventListener('click', (e) => {
    if (fired) {
      fired = false;
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }, true);
}

/** THE toast: one module, web/room-toast.mjs (the design system room-toast-v1, hub v2 2026-10-05). This keeps the old call
 *  shape for the ~28 sites: text + an optional action (Restore, Undo); act(btn) may return a promise and the toast
 *  goes when it settles. opts.kind 'error' = the coral one; opts.ms = its life. */
export function menuToast(text, actLabel, act, opts = {}) {
  return toast(text, { action: actLabel ? { label: actLabel, run: act } : null, kind: opts.kind, ms: opts.ms });
}

const isLive = (seat) => seat.occupant?.state === 'live';

/**
 * @param {object} o
 *   roomId, api(path, opts) -> {ok,status,body}
 *   room() -> the room row; seat(id) -> the current seat; leadId() -> seat id
 *   entries() -> iterable of the loaded line entries (for the disconnect fact)
 *   act(seat, verb, btn) -> Promise: the page's own seatAct (Restore / Start)
 *   openWindow(seat) -> the page's own "open this pane in a window"
 *   applied(body) -> Promise: fold a route's answer in (entries + a re-GET)
 *   disconnected(seatId) -> the page drops the ended pane's frame
 *   error(text) -> the page's error line
 *   redraw() -> the page redraws its roster
 *   moveTargets() -> the family's OTHER open rooms [{id, name, alias, main}] (Move to workgroup…)
 */
export function createSeatMenu(o) {
  const host = createMenuHost();
  let renaming = null; // seat id
  let dialogEl = null;
  let handing = false; // the menu is handing over to a rename / the dialog
  const mine = new Map(); // seat id -> ts: a disconnect THIS page made

  let profOpen = false; // the model & effort card is up: hold redraws like a dialog
  const holding = () => !!(host.isOpen() || renaming || dialogEl || handing || profOpen);

  /* ---- the row ---- */

  /** The time a PERSON disconnected this seat's current (dehydrated) session:
   *  this page's own disconnect, else the fact the engine wrote for it (one
   *  seat's, or the room's "agents disconnected by the user"). null = it went
   *  to rest some other way (an engine restart), which is just "restorable". */
  function disconnectedAt(seat) {
    if (seat.occupant?.state !== 'dehydrated' || seat.status === 'starting') {
      return null;
    }
    const since = typeof seat.occupant.started_at === 'number' ? seat.occupant.started_at : 0;
    let at = mine.get(seat.id) ?? 0;
    const one = `@${seat.handle} disconnected by the user`;
    for (const e of o.entries()) {
      if (e.kind === 'fact' && typeof e.ts === 'number' && e.ts > at
        && (e.body === one || /^agents disconnected by the user \(/.test(e.body ?? ''))) {
        at = e.ts;
      }
    }
    return at && at >= since ? at : null;
  }

  /** The status words for a seat row, or null for the page's own. Short on
   *  purpose (the design system review S1): the time must survive the default rail
   *  width; "by you" is in the tooltip (decorate). */
  function statusFor(seat) {
    const at = disconnectedAt(seat);
    return at ? `disconnected · ${clock(at)}` : null;
  }

  /** Wire one seat row (the column's and the phone sheet's): the ⋯, the
   *  right-click, Shift+F10 / Menu, the long press; and re-mount a rename in
   *  progress (a row drawn while one is open). */
  function decorate(li, seat) {
    li.classList.add('has-more');
    const offAt = disconnectedAt(seat);
    li.classList.toggle('rsm-off', !!offAt); // its status line gets the row's full width (room.css)
    if (offAt) {
      const said = `disconnected by you · ${clock(offAt)}`;
      const st = li.querySelector('.seat-status');
      if (st) {
        st.title = said;
      }
      li.title = li.title ? `${li.title} · ${said}` : said;
    }
    /* CLEARED IN ITS CLI (Owner 2026-10-03): the
       engine saw a /clear in this live seat's terminal; a disconnect + reconnect
       would bring back the conversation from before it. A small amber badge beside
       the name (the rail's row and the phone Agents sheet both decorate here). */
    if (seat.occupant?.cleared_at && isLive(seat)) {
      const b = el('button', 'rsm-cleared');
      b.type = 'button';
      b.title = 'Cleared in its CLI';
      b.setAttribute('aria-label', `@${seat.handle}: cleared in its CLI`);
      b.textContent = 'cleared';
      b.addEventListener('click', (e) => {
        e.stopPropagation(); // the badge acts; the row around it selects
        confirmCleared(seat, li);
      });
      (li.querySelector('.seat-top') ?? li).append(b);
    }
    const more = el('button', 'rsm-more');
    more.type = 'button';
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-label', `More for @${seat.handle}`);
    more.innerHTML = svg('more');
    more.addEventListener('click', (e) => {
      e.stopPropagation(); // the button acts; the row around it selects
      openMenu(seat.id, li, null, more);
    });
    li.append(more);
    wireMenuOpeners(li, (point) => openMenu(seat.id, li, point));
    if (renaming === seat.id) {
      mountRename(li, seat);
    }
  }

  /* ---- the menu ---- */

  function toneOf(row) {
    return row ? getComputedStyle(row).getPropertyValue('--pc').trim() : '';
  }

  function stateWord(seat) {
    if (isLive(seat)) {
      return 'live';
    }
    if (seat.status === 'starting') {
      return 'starting';
    }
    if (seat.occupant?.state === 'dehydrated') {
      return disconnectedAt(seat) ? 'disconnected' : 'restorable';
    }
    if (seat.status === 'never-started' || seat.status === 'empty') {
      return 'never started';
    }
    return seat.status || 'ended';
  }

  function items(seat) {
    const live = isLive(seat);
    const acts = Array.isArray(seat.actions) ? seat.actions : [];
    const lead = o.leadId() === seat.id;
    const go = acts.includes('rehydrate') ? 'rehydrate' : acts.includes('start') ? 'start' : null;
    const goLabel = go === 'start' || (!go && !live && seat.occupant?.state !== 'dehydrated' && seat.status !== 'starting') ? 'Start' : 'Restore';
    const goWhy = live ? 'Already running' : seat.status === 'starting' ? 'Already starting' : 'This seat offers nothing to start here';
    return [
      { a: 'open', label: 'Open window', icon: 'open', off: !live || !seat.recipe_id, why: 'No live session to open' },
      /* Close window is on when anything shows the seat: occupant.windows (real
         windows / tabs), occupant.frames (any device's room view, index.ts
         projectRow) or THIS page's own frame. Owner 2026-10-03 (room line after
         [ref]): allowed from the phone too; every room view then lands on the
         room chat. (History: 2026-09-29 counted only this page's own frame.) */
      { a: 'closew', label: 'Close window', icon: 'close', off: !live || !(seat.occupant?.windows > 0 || seat.occupant?.frames > 0 || !!o.ownFrame?.(seat.id)), why: live ? 'No window open' : 'No live session', sub: 'keeps running' },
      { a: 'go', label: goLabel, icon: goLabel === 'Start' ? 'start' : 'restore', off: !go, why: goWhy, cls: 'go', verb: go },
      { a: 'disc', label: 'Disconnect', icon: 'disc', off: !live, why: 'Only a live session can be disconnected', sub: 'restorable' },
      {
        a: 'reload',
        label: 'Reload from project defaults…',
        icon: 'reload',
        off: !live || !seat.recipe_id,
        why: !seat.recipe_id ? 'No project to reload from' : 'Only a live session can be reloaded',
        sub: 'new model/effort',
      },
      /* SWITCH ASSISTANT [basic] (the design notes §3 item 8): Claude or Codex, the same conversation.
         Basic only (o.canSwitch); a stopped seat points to Start. */
      ...(o.canSwitch?.() ? [{ a: 'switch', label: 'Switch assistant…', icon: 'swap', off: !live || !seat.recipe_id, why: !seat.recipe_id ? 'No project to switch' : 'Stopped: Start it first, then switch', sub: 'Claude or Codex' }] : []),
      /* Owner 2026-10-02, room line [ref]: the agent's own model + effort, kept
         with it and used at every reconnect (agent-profile-card.mjs). */
      { a: 'prof', label: 'Model & effort…', icon: 'prof', off: !seat.occupant?.id, why: 'No session to set a profile on', sub: 'next reconnect' },
      'sep',
      /* WORKGROUPS (Owner 2026-10-04, item 4): the family's other rooms */
      ...(o.noWorkgroups?.() ? [] : [{ a: 'move', label: 'Move to workgroup…', icon: 'move', off: !(o.moveTargets?.() ?? []).length, why: 'No other room in this family', sub: 'same name, same session' }]), // Basic has no workgroups: no item at all, not a greyed one [basic]
      { a: 'ren', label: `Rename @${seat.handle}…`, icon: 'ren' },
      { a: 'lead', label: 'Make lead', icon: 'lead', off: lead, why: 'Already the lead', sub: 'same as /set lead' },
      'sep',
      { a: 'rem', label: 'Remove from room…', icon: 'rem', off: lead, why: 'Make another seat lead first', cls: 'danger' },
    ];
  }

  function closeMenu(refocus = true) {
    host.close(refocus);
  }

  /** The hold is over: focus the row it came from (still in the DOM, the
   *  redraw was held), then redraw anything that changed meanwhile. */
  function release(back, refocus) {
    if (refocus && back?.row?.isConnected) {
      back.row.focus({ preventScroll: true });
    }
    if (!holding()) {
      o.redraw();
    }
  }

  function openMenu(seatId, row, point, more) {
    host.close(false);
    const seat = o.seat(seatId);
    if (!seat) {
      return;
    }
    host.open({
      row,
      more,
      point,
      label: `@${seat.handle}`,
      title: `@${seat.handle}`,
      sub: stateWord(seat),
      tone: toneOf(row),
      data: { seat: seatId },
      items: items(seat),
      choose: (it, back) => choose(it, seatId, back),
      closed: (back, refocus) => release(back, refocus),
    });
  }

  function choose(it, seatId, back) {
    const seat = o.seat(seatId);
    if (it.a === 'prof') {
      closeMenu(false);
      if (seat?.occupant?.id) {
        handing = true;
        profOpen = true;
        openProfileCard({
          paneid: seat.occupant.id,
          label: `@${seat.handle}`,
          tone: toneOf(back?.row),
          profile: seat.occupant.profile ?? null,
          vendor: seat.vendor ?? seat.occupant.vendor ?? null,
          onClosed: () => {
            profOpen = false;
            release(back, true);
          },
        });
        handing = false;
      }
      return;
    }
    if (it.a === 'ren' || it.a === 'rem' || it.a === 'reload' || it.a === 'move' || it.a === 'switch') {
      /* keep the hold: the menu hands straight over to the rename / dialog,
         so the row it came from is still the one on screen */
      handing = true;
      closeMenu(false);
      const row = back?.row?.isConnected ? back.row : null;
      if (seat && it.a === 'ren' && row) {
        renaming = seatId;
        mountRename(row, seat);
      } else if (seat && it.a === 'rem') {
        confirmRemove(seat, back);
      } else if (seat && it.a === 'reload') {
        confirmReload(seat, back);
      } else if (seat && it.a === 'move') {
        confirmMove(seat, back);
      } else if (seat && it.a === 'switch') {
        confirmSwitch(seat, back);
      }
      handing = false;
      if (!holding()) {
        o.redraw();
      }
      return;
    }
    closeMenu(it.a !== 'open');
    if (!seat) {
      return;
    }
    if (it.a === 'open') {
      o.openWindow(seat);
    } else if (it.a === 'go') {
      void o.act(seat, it.verb, el('button'));
    } else if (it.a === 'disc') {
      void disconnect(seat);
    } else if (it.a === 'closew') {
      void closeWindow(seat);
    } else if (it.a === 'lead') {
      void makeLead(seat);
    }
  }

  /* ---- Make lead: the engine's own verb (PATCH the room's lead_seat, what
     /set lead does); its refusal is shown in words, like the other items ---- */

  async function makeLead(seat) {
    let r;
    try {
      r = await o.api(`/api/rooms/${encodeURIComponent(o.roomId)}`, { method: 'PATCH', json: { lead_seat: seat.id } });
    } catch (e) {
      r = { ok: false, status: 0, body: { error: e?.message ?? String(e) } };
    }
    if (!r.ok || r.body?.ok === false) {
      o.error(`@${seat.handle} not made lead — ${r.body?.error ?? `HTTP ${r.status}`}`);
      await o.applied(null).catch(() => {});
      return;
    }
    try {
      await o.applied(r.body);
    } catch {
      /* the next poll draws it */
    }
    menuToast(`@${seat.handle} is now the lead.`);
  }

  /* ---- Close window: no confirm (nothing ends; Open window brings it back) ---- */

  async function closeWindow(seat) {
    /* this page's own frame of the seat: after the engine has parked the
       session it drops and the page lands on the room chat (same rule as the
       frame-closed signal, Owner 2026-10-03) */
    const ownOnly = !!o.ownFrame?.(seat.id);
    let r;
    try {
      r = await o.api(`/api/rooms/${encodeURIComponent(o.roomId)}/seats/${encodeURIComponent(seat.id)}/close-window`, { json: {} });
    } catch (e) {
      r = { ok: false, status: 0, body: { error: e?.message ?? String(e) } };
    }
    if (!r.ok || r.body?.ok === false) {
      o.error(`@${seat.handle}'s window not closed — ${r.body?.error ?? `HTTP ${r.status}`}`);
      await o.applied(null).catch(() => {});
      return;
    }
    if (ownOnly) {
      o.closeOwnFrame?.(seat.id);
    }
    try {
      await o.applied(r.body); // the row repaints: no window (parked unless a room frame views it)
    } catch {
      /* the next poll draws it */
    }
    menuToast(`Closed @${seat.handle}'s window. The session keeps running.`);
  }

  /* ---- Disconnect: no confirm (it is reversible); a toast with Restore ---- */

  async function disconnect(seat) {
    let r;
    try {
      r = await o.api(`/api/rooms/${encodeURIComponent(o.roomId)}/seats/${encodeURIComponent(seat.id)}/disconnect`, { json: {} });
    } catch (e) {
      r = { ok: false, status: 0, body: { error: e?.message ?? String(e) } };
    }
    if (!r.ok || r.body?.ok === false) {
      o.error(`@${seat.handle} not disconnected — ${r.body?.error ?? r.body?.reason ?? (r.body?.result === 'failed' ? 'the session did not end' : `HTTP ${r.status}`)}`);
      await o.applied(null).catch(() => {});
      return;
    }
    mine.set(seat.id, Date.now());
    try {
      await o.applied(r.body); // the row flips: dehydrated = the restorable ring
      o.disconnected(seat.id); // then its ended pane's frame goes
    } catch {
      /* the next poll draws it */
    }
    if (r.body?.orphan && typeof r.body.orphan === 'object') {
      o.error(`@${seat.handle} still has a claude running: pid ${r.body.orphan.pid} (${r.body.orphan.state}). The engine never kills it; end it yourself before Restore.`);
    }
    menuToast(`Disconnected @${seat.handle}`, 'Restore', (btn) => {
      const now = o.seat(seat.id) ?? seat;
      return o.act(now, 'rehydrate', btn);
    });
  }

  /* ---- Rename: inline in the row ---- */

  /* ONE line at the 272px rail (the design system review S2); the en dashes are built,
     never typed, so no escape can be mangled on the way to disk */
  const EN = String.fromCharCode(8211);
  const HINT = `a${EN}z, 0${EN}9, - · unique here`;

  function mountRename(li, seat) {
    const handle = li.querySelector('.seat-handle');
    const meta = li.querySelector('.seat-meta');
    if (!handle || li.querySelector('.rsm-ren')) {
      return;
    }
    const lab = el('label', 'rsm-ren');
    lab.append(el('span', 'at', '@'));
    const inp = el('input');
    inp.value = seat.handle;
    inp.spellcheck = false;
    inp.autocapitalize = 'off';
    inp.setAttribute('autocomplete', 'off');
    inp.setAttribute('aria-label', `New handle for @${seat.handle}`);
    lab.append(inp);
    handle.replaceWith(lab);
    const line = el('div', 'rsm-renhint', HINT);
    line.id = `rsm-ren-${seat.id}`;
    inp.setAttribute('aria-describedby', line.id);
    if (meta) {
      meta.replaceWith(line);
    } else {
      li.append(line);
    }
    li.classList.add('is-renaming');
    let saving = false;
    let done = false;
    const end = (refocus) => {
      if (done) {
        return;
      }
      done = true;
      renaming = null;
      release({ row: li }, refocus);
    };
    lab.addEventListener('click', (e) => e.stopPropagation()); // typing here never selects the row
    lab.addEventListener('pointerdown', (e) => e.stopPropagation());
    inp.addEventListener('input', () => {
      lab.classList.remove('bad');
      line.className = 'rsm-renhint';
      line.textContent = HINT;
    });
    inp.addEventListener('keydown', async (e) => {
      e.stopPropagation(); // the roster's arrows / Enter are not this field's
      if (e.key === 'Escape') {
        e.preventDefault();
        end(true);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const v = inp.value.trim().replace(/^@/, '');
        if (v === seat.handle) {
          end(true);
          return;
        }
        saving = true;
        let r;
        try {
          r = await o.api(`/api/rooms/${encodeURIComponent(o.roomId)}/seats/${encodeURIComponent(seat.id)}`, { method: 'PATCH', json: { handle: v } });
        } catch (err) {
          r = { ok: false, status: 0, body: { error: err?.message ?? String(err) } };
        }
        saving = false;
        if (!r.ok) {
          lab.classList.add('bad');
          line.className = 'rsm-renerr';
          line.textContent = r.body?.error ?? `HTTP ${r.status}`;
          inp.focus();
          return;
        }
        end(true);
        try {
          await o.applied(r.body);
        } catch {
          /* the next poll draws it */
        }
      }
    });
    inp.addEventListener('blur', () => {
      /* a save in flight keeps the field (a refusal must be readable) */
      setTimeout(() => {
        if (!saving && !done && document.activeElement !== inp) {
          end(false);
        }
      }, 0);
    });
    inp.focus({ preventScroll: true });
    inp.select();
  }

  /* ---- Remove: the styleguide modal card, as an alertdialog ---- */

  /** What DELETE .../seats/:id actually does (src/table/store.ts removeSeat):
   *  it never ends a session (the occupant is emptied from the seat, not
   *  killed), never deletes (left_at is set; the occupant is retired to the
   *  seat's history as `evicted`), frees the handle, and writes "@x left the
   *  room". The lead is refused. */
  function happens(seat) {
    const live = isLive(seat) || seat.status === 'starting';
    return [
      live
        ? 'Its session keeps running: removing a seat never ends it. It goes back to Live Tabs in the Workbench.'
        : seat.occupant?.state === 'dehydrated'
          ? 'Nothing is ended: its conversation stays restorable from the Workbench.'
          : 'It has no running session, so nothing ends.',
      `@${seat.handle} leaves the roster and can no longer be addressed here; the handle is free again.`,
      'Kept: everything in the room chat, and the seat itself (its session is filed in the seat’s history).',
      'You can seat it again with + (as a new seat).',
    ];
  }

  /* ---- Move to workgroup... (Owner 2026-10-04, item 4): pick
   * one of the family's other rooms; POST .../seats/:id/move {to_room}. The
   * seat keeps its handle and session. A refusal (the room's lead: "hand the
   * lead over first") is the engine's own 409, shown inline, never a toast.
   * Same scrim / card / focus rules as the Remove card. ---- */

  function confirmMove(seat, back) {
    const targets = o.moveTargets?.() ?? [];
    const scrim = el('div', 'rsm-dscrim');
    const card = el('div', 'rsm-card kb-capped');
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'rsmMovH');
    card.setAttribute('aria-describedby', 'rsmMovB');
    const tone = toneOf(back?.row);
    if (tone) {
      card.style.setProperty('--pc', tone);
    }
    const hd = el('div', 'hd');
    hd.id = 'rsmMovH';
    hd.append('Move ', el('code', '', `@${seat.handle}`), ' to…');
    const bd = el('div', 'bd');
    bd.id = 'rsmMovB';
    bd.append('It keeps its name and its session. This room keeps the history and a “moved to” line.');
    const list = el('div', 'rsm-wgpick');
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-label', 'Move to');
    let picked = targets.length === 1 ? targets[0].id : '';
    const rows = [];
    for (const t of targets) {
      const b = el('button', 'rsm-wgopt');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.room = t.id;
      b.append(el('span', 'n', t.name), el('span', 'k', t.main ? 'main room' : t.alias ? `@${t.alias}` : 'workgroup'));
      b.addEventListener('click', () => {
        picked = t.id;
        paint();
      });
      rows.push([t.id, b]);
      list.append(b);
    }
    const err = el('div', 'rsm-derr');
    err.hidden = true;
    bd.append(list, err);
    const ft = el('div', 'ft');
    const no = el('button', 'rsm-btn', 'Cancel');
    no.type = 'button';
    no.dataset.a = 'cancel';
    const yes = el('button', 'rsm-btn', 'Move');
    yes.type = 'button';
    yes.dataset.a = 'move';
    ft.append(no, yes);
    function paint() {
      for (const [id, b] of rows) {
        b.setAttribute('aria-checked', String(id === picked));
        b.classList.toggle('on', id === picked);
      }
      yes.disabled = !picked;
    }
    paint();
    card.append(hd, bd, ft);
    scrim.append(card);
    document.body.append(scrim);
    dialogEl = scrim;
    const close = (refocus) => {
      if (!dialogEl) {
        return;
      }
      scrim.remove();
      dialogEl = null;
      release(back, refocus);
    };
    no.addEventListener('click', () => close(true));
    scrim.addEventListener('click', (e) => {
      if (e.target === scrim) {
        close(true);
      }
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      }
    });
    yes.addEventListener('click', async () => {
      if (!picked) {
        return;
      }
      yes.disabled = true;
      err.hidden = true;
      let r;
      try {
        r = await o.api(`/api/rooms/${encodeURIComponent(o.roomId)}/seats/${encodeURIComponent(seat.id)}/move`, { json: { to_room: picked } });
      } catch (e) {
        r = { ok: false, status: 0, body: { error: e?.message ?? String(e) } };
      }
      yes.disabled = false;
      if (!r.ok) {
        err.hidden = false;
        err.textContent = `Not moved — ${r.body?.error ?? `HTTP ${r.status}`}`;
        return;
      }
      close(false);
      try {
        await o.applied(r.body);
      } catch {
        /* the next poll draws it */
      }
      menuToast(`Moved @${seat.handle} to ${targets.find((t) => t.id === picked)?.name ?? 'the workgroup'}.`);
    });
    focusInto(rows[0]?.[1] ?? no);
  }

  function confirmRemove(seat, back) {
    const room = o.room();
    const scrim = el('div', 'rsm-dscrim');
    const card = el('div', 'rsm-card kb-capped');
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'rsmRemH');
    card.setAttribute('aria-describedby', 'rsmRemB');
    const tone = toneOf(back?.row);
    if (tone) {
      card.style.setProperty('--pc', tone);
    }
    const hd = el('div', 'hd');
    hd.id = 'rsmRemH';
    hd.append('Remove ', el('code', '', `@${seat.handle}`), ` from ${room?.name ?? 'this room'}?`);
    const bd = el('div', 'bd');
    bd.id = 'rsmRemB';
    bd.append('What happens:');
    const ul = el('ul');
    for (const t of happens(seat)) {
      ul.append(el('li', '', t));
    }
    bd.append(ul);
    const err = el('div', 'rsm-derr');
    err.hidden = true;
    bd.append(err);
    const ft = el('div', 'ft');
    const no = el('button', 'rsm-btn', 'Cancel');
    no.type = 'button';
    no.dataset.a = 'cancel';
    const yes = el('button', 'rsm-btn danger', 'Remove');
    yes.type = 'button';
    yes.dataset.a = 'remove';
    ft.append(no, yes);
    card.append(hd, bd, ft);
    scrim.append(card);
    document.body.append(scrim);
    dialogEl = scrim;
    const close = (refocus) => {
      if (!dialogEl) {
        return;
      }
      scrim.remove();
      dialogEl = null;
      release(back, refocus);
    };
    no.addEventListener('click', () => close(true));
    scrim.addEventListener('click', (e) => {
      if (e.target === scrim) {
        close(true);
      }
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      } else if (e.key === 'Tab') {
        e.preventDefault(); // two buttons: Tab moves between them and never leaves
        (document.activeElement === no ? yes : no).focus();
      }
    });
    yes.addEventListener('click', async () => {
      yes.disabled = true;
      let r;
      try {
        r = await o.api(`/api/rooms/${encodeURIComponent(o.roomId)}/seats/${encodeURIComponent(seat.id)}`, { method: 'DELETE', json: {} });
      } catch (e) {
        r = { ok: false, status: 0, body: { error: e?.message ?? String(e) } };
      }
      yes.disabled = false;
      if (!r.ok) {
        err.hidden = false;
        err.textContent = `Not removed — ${r.body?.error ?? `HTTP ${r.status}`}`;
        no.focus();
        return;
      }
      close(false);
      try {
        await o.applied(r.body);
      } catch {
        /* the next poll draws it */
      }
    });
    no.focus({ preventScroll: true });
  }

  /* ---- "Cleared in its CLI": a short card from the amber badge. [Reload...] hands
   * straight to the reload card; [Dismiss] drops the flag (person cookie, one
   * POST). Same scrim/card/focus rules as the other cards. ---- */

  function confirmCleared(seat, row) {
    host.close(false);
    const back = { row };
    const scrim = el('div', 'rsm-dscrim');
    const card = el('div', 'rsm-card kb-capped');
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'rsmClrH');
    card.setAttribute('aria-describedby', 'rsmClrB');
    const tone = toneOf(row);
    if (tone) {
      card.style.setProperty('--pc', tone);
    }
    const hd = el('div', 'hd');
    hd.id = 'rsmClrH';
    hd.append(el('code', '', `@${seat.handle}`), ' was cleared in its CLI');
    const bd = el('div', 'bd');
    bd.id = 'rsmClrB';
    bd.append(
      'This agent was /clear’ed in its terminal. A disconnect and reconnect would bring back the conversation from BEFORE the /clear, and what it did since isn’t kept. Reload it from project defaults instead?',
    );
    const err = el('div', 'rsm-derr');
    err.hidden = true;
    bd.append(err);
    const ft = el('div', 'ft');
    const dismiss = el('button', 'rsm-btn', 'Dismiss');
    dismiss.type = 'button';
    dismiss.dataset.a = 'dismiss';
    const reload = el('button', 'rsm-btn', 'Reload…');
    reload.type = 'button';
    reload.dataset.a = 'reload';
    ft.append(dismiss, reload);
    card.append(hd, bd, ft);
    scrim.append(card);
    document.body.append(scrim);
    dialogEl = scrim;
    let busy = false;
    const close = (refocus) => {
      if (!dialogEl) {
        return;
      }
      scrim.remove();
      dialogEl = null;
      release(back, refocus);
    };
    const cancel = () => {
      if (!busy) {
        close(true);
      }
    };
    scrim.addEventListener('click', (e) => {
      if (e.target === scrim) {
        cancel();
      }
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      } else if (e.key === 'Tab') {
        e.preventDefault(); // two buttons: Tab moves between them and never leaves
        (document.activeElement === dismiss ? reload : dismiss).focus();
      }
    });
    reload.addEventListener('click', () => {
      if (busy) {
        return;
      }
      handing = true; // the hold passes straight to the reload card
      scrim.remove();
      dialogEl = null;
      confirmReload(seat, back);
      handing = false;
    });
    dismiss.addEventListener('click', async () => {
      if (busy) {
        return;
      }
      busy = true;
      dismiss.disabled = true;
      reload.disabled = true;
      let r;
      try {
        r = await o.api(`/api/sessions/${encodeURIComponent(seat.occupant.id)}/cleared/dismiss`, { json: {} });
      } catch (e) {
        r = { ok: false, status: 0, body: { error: e?.message ?? String(e) } };
      }
      busy = false;
      dismiss.disabled = false;
      reload.disabled = false;
      if (!r.ok) {
        err.hidden = false;
        err.textContent = `Not dismissed — ${r.body?.error ?? `HTTP ${r.status}`}`;
        dismiss.focus();
        return;
      }
      if (seat.occupant) {
        seat.occupant.cleared_at = null; // the badge goes now, not at the next poll
      }
      row?.querySelector('.rsm-cleared')?.remove();
      close(true);
    });
    reload.focus({ preventScroll: true });
  }

  /* ---- Reload from project defaults: a confirm dialog + one engine call
   * (ticket, Owner 2026-10-01: remove + re-add through the room's own
   * existing verbs, never a rebind-in-place — so a successful reload shows a
   * NEW seat id). GET .../reload previews it (recipe/model/effort, the prior
   * work slug, and every OTHER open room the same pane holds a seat in);
   * POST runs it. A pane mid-turn is refused unless "reload anyway" is
   * ticked (force); "open a tab for the new session" defaults off (the
   * fresh session starts with no window, like a seat's own Restore). ---- */

  function confirmReload(seat, back) {
    const room = o.room();
    const scrim = el('div', 'rsm-dscrim');
    const card = el('div', 'rsm-card kb-capped');
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'rsmRelH');
    card.setAttribute('aria-describedby', 'rsmRelB');
    const tone = toneOf(back?.row);
    if (tone) {
      card.style.setProperty('--pc', tone);
    }
    const hd = el('div', 'hd');
    hd.id = 'rsmRelH';
    hd.append('Reload ', el('code', '', `@${seat.handle}`), ' from project defaults?');
    const bd = el('div', 'bd');
    bd.id = 'rsmRelB';
    bd.append(el('div', 'rsm-dload', 'Loading…'));
    const err = el('div', 'rsm-derr');
    err.hidden = true;
    bd.append(err);
    const ft = el('div', 'ft');
    const no = el('button', 'rsm-btn', 'Cancel');
    no.type = 'button';
    no.dataset.a = 'cancel';
    const yes = el('button', 'rsm-btn', 'Reload');
    yes.type = 'button';
    yes.dataset.a = 'reload';
    yes.disabled = true; // enabled once the preview lands (or refuses outright)
    ft.append(no, yes);
    card.append(hd, bd, ft);
    scrim.append(card);
    document.body.append(scrim);
    dialogEl = scrim;
    /* Owner 2026-10-03: a cancel (Esc, scrim,
       Cancel) while the reload request is in flight used to close the card and let
       the reload happen anyway; it is ignored until the request answers. */
    let submitting = false;
    const close = (refocus) => {
      if (!dialogEl) {
        return;
      }
      scrim.remove();
      dialogEl = null;
      release(back, refocus);
    };
    const cancel = () => {
      if (!submitting) {
        close(true);
      }
    };
    no.addEventListener('click', cancel);
    scrim.addEventListener('click', (e) => {
      if (e.target === scrim) {
        cancel();
      }
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const focusables = [...card.querySelectorAll('button:not(:disabled), input, textarea:not(:disabled)')];
        const i = focusables.indexOf(document.activeElement);
        focusables[(i + (e.shiftKey ? focusables.length - 1 : 1)) % focusables.length]?.focus();
      }
    });

    let forceBox = null;
    let openTabBox = null;
    let blockedByTurn = false;
    let welcomeMode = 'none';
    let welcomeBox = null;

    (async () => {
      let p;
      try {
        p = await o.api(`/api/rooms/${encodeURIComponent(o.roomId)}/seats/${encodeURIComponent(seat.id)}/reload`, { method: 'GET' });
      } catch (e) {
        p = { ok: false, status: 0, body: { error: e?.message ?? String(e) } };
      }
      if (!dialogEl) {
        return; // closed while the preview was in flight
      }
      bd.querySelector('.rsm-dload')?.remove();
      if (!p.ok) {
        err.hidden = false;
        err.textContent = `Could not load what Reload would do — ${p.body?.error ?? `HTTP ${p.status}`}`;
        no.focus();
        return;
      }
      const info = p.body ?? {};
      const list = el('ul');
      const r = info.recipe;
      list.append(
        el('li', '', r ? `Starts a fresh session of "${r.name}" (${r.model ?? 'default model'}, ${r.effort ?? 'default effort'}).` : 'No project is bound to this seat.'),
      );
      if (info.priorSlug) {
        list.append(el('li', '', `Previous session: ${info.priorSlug} — stays restorable after the reload.`));
      }
      if (Array.isArray(info.otherRooms) && info.otherRooms.length) {
        const li = el('li', '', `Also seated in: ${info.otherRooms.map((o2) => `${o2.roomName} (@${o2.handle})`).join(', ')} — reloaded there too.`);
        list.append(li);
      }
      bd.append(list);
      blockedByTurn = !!info.busy;
      if (blockedByTurn) {
        const warn = el('div', 'rsm-derr');
        warn.hidden = false;
        warn.textContent = `@${seat.handle} is mid-turn right now.`;
        bd.append(warn);
        const forceLabel = el('label', 'rsm-check');
        forceBox = document.createElement('input');
        forceBox.type = 'checkbox';
        forceBox.addEventListener('change', () => {
          yes.disabled = !forceBox.checked;
        });
        forceLabel.append(forceBox, ' reload anyway (interrupts it)');
        bd.append(forceLabel);
      }
      /* WELCOME (Owner 2026-10-03): the engine
         never posts as the user on its own. The lead sends it (default when one can),
         the user sends this text as himself, or nobody. Remembers nothing. */
      const w = info.welcome ?? {};
      const leadOk = !!w.lead;
      welcomeMode = leadOk ? 'lead' : 'me';
      const wh = el('div', 'rsm-wh', 'Welcome');
      const modes = [
        ...(leadOk ? [['lead', `Lead sends it (@${w.lead.handle} welcomes @${seat.handle})`]] : []),
        ['me', 'Send this as me'],
        ['none', 'No welcome'],
      ];
      const wgroup = el('div', 'rsm-wgroup');
      wgroup.setAttribute('role', 'radiogroup');
      wgroup.setAttribute('aria-label', 'Welcome');
      welcomeBox = document.createElement('textarea');
      welcomeBox.className = 'rsm-wtext';
      welcomeBox.rows = 5;
      welcomeBox.value = w.text ?? '';
      welcomeBox.setAttribute('aria-label', 'Welcome text, sent as you');
      const syncWelcome = () => {
        welcomeBox.hidden = welcomeMode !== 'me';
      };
      for (const [val, label] of modes) {
        const lb = el('label', 'rsm-check');
        const rb = document.createElement('input');
        rb.type = 'radio';
        rb.name = 'rsmWelcome';
        rb.value = val;
        rb.checked = val === welcomeMode;
        rb.addEventListener('change', () => {
          welcomeMode = val;
          syncWelcome();
        });
        lb.append(rb, ` ${label}`);
        wgroup.append(lb);
      }
      syncWelcome();
      bd.append(wh, wgroup, welcomeBox);
      const tabLabel = el('label', 'rsm-check');
      openTabBox = document.createElement('input');
      openTabBox.type = 'checkbox';
      tabLabel.append(openTabBox, ' open a tab for the new session');
      bd.append(tabLabel);
      yes.disabled = blockedByTurn;
      (blockedByTurn ? forceBox : yes)?.focus();
    })();

    /* RELOAD IS A LONG CALL, SO THE CARD SHOWS PROGRESS AND RESOLVES ITSELF [reload progress] (Owner 2026-10-06, phone: after
       Reload the card just sat there with no way to close it; the reload had gone through). The route holds the request until
       the new session passes startup (up to ~60 s) and its welcome is sent, and a phone can lose or background that request.
       So: on press the card becomes "Reloading @x…" with a Close (and tap-outside) that never cancels the reload; it closes
       ITSELF as soon as the room shows the reload (the HTTP answer, the seat's occupant changing, or the "re-added" fact); after
       ~30 s of neither it says so and stays closable. */
    const STILL_MS = Number(window.HWB_RELOAD_STILL_MS) || 30_000;
    let watch = null;
    let settled = false;
    const oldOcc = seat.occupant?.id ?? null;
    const startedAt = Date.now();
    const isReloadFact = (e) => e?.kind === 'fact' && typeof e.ts === 'number' && e.ts >= startedAt - 2000 && typeof e.body === 'string'
      && e.body.startsWith(`@${seat.handle} re-added from project defaults`);
    const seatChanged = () => {
      const now = (o.seats?.() ?? []).find((x) => x.handle === seat.handle);
      return !!now && !!now.occupant?.id && now.occupant.id !== oldOcc; // a NEW session; a rollback keeps the old occupant, so it never reads as done
    };
    /* the lines are read here, not left to the page's own feed: with push live the page does not poll lines, and the fact is
       the reload's last word */
    let reading = false;
    const factShows = async () => {
      for (const e of o.entries()) {
        if (isReloadFact(e)) {
          return true;
        }
      }
      if (reading) {
        return false;
      }
      reading = true;
      try {
        const r = await o.api(`/api/rooms/${encodeURIComponent(o.roomId)}/line?limit=12`);
        return !!r.ok && (r.body?.entries ?? []).some(isReloadFact);
      } catch {
        return false;
      } finally {
        reading = false;
      }
    };
    const settle = async (body, how) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(watch);
      if (dialogEl) {
        close(false);
      }
      try {
        await o.applied(body ?? null);
      } catch {
        /* the next poll draws it */
      }
      const n = Array.isArray(body?.rooms) ? body.rooms.length : 1;
      menuToast(`Reloaded @${seat.handle}${how === 'http' && n > 1 ? ` (${n} rooms)` : ''}.`);
    };
    const toProgress = () => {
      hd.textContent = '';
      hd.append('Reloading ', el('code', '', `@${seat.handle}`), '…');
      bd.textContent = '';
      const line = el('div', 'rsm-prog', 'The old session ends, a fresh one starts from the project defaults, and the welcome is sent. This can take up to a minute. You can close this: the reload keeps going.');
      line.setAttribute('role', 'status');
      bd.append(line, err);
      err.hidden = true;
      yes.remove();
      no.textContent = 'Close';
      no.disabled = false;
      no.dataset.a = 'close';
      const x = el('button', 'rsm-xclose');
      x.type = 'button';
      x.setAttribute('aria-label', 'Close');
      x.textContent = '✕';
      x.addEventListener('click', () => close(false));
      hd.append(x);
      let tick = 0;
      watch = setInterval(async () => {
        if (settled) {
          return;
        }
        tick += 1;
        if (seatChanged() || (tick % 2 === 0 && await factShows())) {
          void settle(null, 'room');
        } else if (Date.now() - startedAt > STILL_MS && !line.dataset.still && !settled) {
          line.dataset.still = '1';
          line.textContent = 'Still waiting: the seat may have reloaded already. Check the room; you can close this.';
        }
      }, 1000);
    };
    yes.addEventListener('click', async () => {
      if (submitting) {
        return;
      }
      submitting = true;
      yes.disabled = true;
      no.disabled = true;
      toProgress();
      /* from here a close (Close, X, tap outside, Esc) only hides the card: the request is NOT cancelled */
      submitting = false;
      let r;
      try {
        r = await o.api(`/api/rooms/${encodeURIComponent(o.roomId)}/seats/${encodeURIComponent(seat.id)}/reload`, {
          json: {
            force: !!forceBox?.checked,
            openTab: !!openTabBox?.checked,
            welcome: { mode: welcomeMode, ...(welcomeMode === 'me' ? { text: welcomeBox?.value ?? '' } : {}) },
          },
        });
      } catch (e) {
        r = { ok: false, status: 0, body: { error: e?.message ?? String(e) } };
      }
      if (settled) {
        if (!r.ok || r.body?.ok === false) {
          menuToast(`@${seat.handle}: the reload reported a problem — ${r.body?.error ?? r.body?.reason ?? `HTTP ${r.status}`}`, undefined, undefined, { kind: 'error' });
        }
        return;
      }
      if (!r.ok || r.body?.ok === false) {
        settled = true;
        clearInterval(watch);
        const msg = `Not reloaded — ${r.body?.error ?? r.body?.reason ?? `HTTP ${r.status}`}` +
          (r.body?.reason === 'launch-failed' ? ' (the previous session is unchanged and restorable)' : '');
        if (dialogEl) {
          err.hidden = false;
          err.textContent = msg;
          card.querySelector('.rsm-prog')?.remove();
          no.focus();
        } else {
          menuToast(`@${seat.handle}: ${msg}`, undefined, undefined, { kind: 'error' });
        }
        return;
      }
      await settle(r.body, 'http');
    });
  }


  /* ---- Switch assistant [basic] (the design notes §3 item 8): a card on the confirmReload template.
   * GET .../switch says what is running now (the LIVE occupant's vendor and the model and effort the engine knows,
   * "default" when it knows none) and the two presets; the current one is shown disabled ("You're already using …").
   * One confirm, then plain words polled from GET .../switch/:opId until it ends. Close never cancels; Cancel is
   * offered only while the switch is reversible, and "Continue anyway" only when the new assistant has not confirmed
   * the handover. A retry of the same choice joins the switch already running. ---- */

  function confirmSwitch(seat, back) {
    const base = `/api/rooms/${encodeURIComponent(o.roomId)}/seats/${encodeURIComponent(seat.id)}/switch`;
    const scrim = el('div', 'rsm-dscrim');
    const card = el('div', 'rsm-card rsm-switch kb-capped');
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'rsmSwH');
    const tone = toneOf(back?.row);
    if (tone) {
      card.style.setProperty('--pc', tone);
    }
    const hd = el('div', 'hd');
    hd.id = 'rsmSwH';
    hd.append('Switch ', el('code', '', `@${seat.handle}`), '’s assistant');
    const bd = el('div', 'bd');
    bd.append(el('div', 'rsm-dload', 'Loading…'));
    const err = el('div', 'rsm-derr');
    err.hidden = true;
    const ft = el('div', 'ft');
    const no = el('button', 'rsm-btn', 'Cancel');
    no.type = 'button';
    const yes = el('button', 'rsm-btn', 'Switch');
    yes.type = 'button';
    yes.disabled = true;
    ft.append(no, yes);
    card.append(hd, bd, ft);
    scrim.append(card);
    document.body.append(scrim);
    dialogEl = scrim;
    let timer = null;
    let submitting = false;
    let pick = null;
    const close = (refocus) => {
      clearInterval(timer);
      if (!dialogEl) {
        return;
      }
      scrim.remove();
      dialogEl = null;
      release(back, refocus);
    };
    no.addEventListener('click', () => {
      if (!submitting) close(true);
    });
    scrim.addEventListener('click', (e) => {
      if (e.target === scrim && !submitting) close(true);
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !submitting) {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      }
    });
    const call = async (path, json) => {
      try {
        return await o.api(path, json === undefined ? { method: 'GET' } : { json });
      } catch (e2) {
        return { ok: false, status: 0, body: { error: e2?.message ?? String(e2) } };
      }
    };

    /* the progress view: plain words, never a state name */
    const progress = (opId) => {
      hd.textContent = '';
      hd.append('Switching ', el('code', '', `@${seat.handle}`), '…');
      bd.textContent = '';
      const line = el('div', 'rsm-prog', 'Saving where you are…');
      line.setAttribute('role', 'status');
      line.setAttribute('aria-live', 'polite');
      bd.append(line, err);
      err.hidden = true;
      ft.textContent = '';
      const stop = el('button', 'rsm-btn danger', 'Cancel switch');
      stop.type = 'button';
      const go = el('button', 'rsm-btn', 'Continue anyway');
      go.type = 'button';
      const shut = el('button', 'rsm-btn', 'Close');
      shut.type = 'button';
      stop.hidden = true;
      go.hidden = true;
      ft.append(stop, go, shut);
      shut.addEventListener('click', () => close(true));
      let last = null;
      const paint = (v) => {
        last = v;
        line.textContent = v.words ?? '…';
        stop.hidden = !v.canCancel;
        go.hidden = !v.canContinue;
        if (v.held > 0 && !v.done) {
          line.append(el('div', 'rsm-dsub', `${v.held} line${v.held === 1 ? '' : 's'} you sent meanwhile will be delivered to whichever assistant ends up in the seat.`));
        }
        if (v.done) {
          clearInterval(timer);
          stop.hidden = true;
          go.hidden = true;
          if (v.ok) {
            menuToast(v.words);
            void o.applied?.(null);
          }
        }
      };
      stop.addEventListener('click', async () => {
        stop.disabled = true;
        const r = await call(`${base}/${encodeURIComponent(opId)}/cancel`, {});
        stop.disabled = false;
        if (!r.ok) {
          err.hidden = false;
          err.textContent = r.body?.error ?? `HTTP ${r.status}`;
        }
      });
      go.addEventListener('click', async () => {
        go.disabled = true;
        const r = await call(`${base}/${encodeURIComponent(opId)}/continue`, {});
        go.disabled = false;
        if (!r.ok) {
          err.hidden = false;
          err.textContent = r.body?.error ?? `HTTP ${r.status}`;
        }
      });
      const poll = async () => {
        const r = await call(`${base}/${encodeURIComponent(opId)}`);
        if (!dialogEl) {
          clearInterval(timer);
          return;
        }
        if (r.ok && r.body) {
          err.hidden = true;
          paint(r.body);
        } else if (!last) {
          err.hidden = false;
          err.textContent = `Cannot read the switch right now (${r.body?.error ?? `HTTP ${r.status}`}); it keeps going.`;
        }
      };
      timer = setInterval(() => void poll(), 1500);
      void poll();
      shut.focus();
    };

    (async () => {
      const r = await call(base);
      if (!dialogEl) {
        return;
      }
      bd.textContent = '';
      if (!r.ok) {
        err.hidden = false;
        err.textContent = `Could not load the assistants — ${r.body?.error ?? `HTTP ${r.status}`}`;
        bd.append(err);
        no.focus();
        return;
      }
      const w = r.body ?? {};
      if (w.active && w.active.seat === seat.id && !w.active.done) {
        progress(w.active.opId); // a switch is already running for this seat: show it
        return;
      }
      const cur = w.current ?? {};
      const now = el('div', 'rsm-swnow');
      if (w.live) {
        now.append(el('div', 'rsm-swh', `Now: ${cur.brand ?? 'unknown'}`), el('div', 'rsm-dsub', `Model ${cur.model ?? 'default'} · effort ${cur.effort ?? 'default'}`));
      } else {
        now.append(el('div', 'rsm-swh', `${cur.brand ?? 'This assistant'} is configured but stopped`), el('div', 'rsm-dsub', 'Start the seat first, then switch.'));
      }
      bd.append(now);
      const group = el('div', 'rsm-swchoices');
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-label', 'Switch to');
      for (const ch of w.choices ?? []) {
        const b = el('button', 'rsm-swchoice');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', 'false');
        b.disabled = !!ch.disabled;
        b.append(el('span', 'rsm-swlabel', ch.label), el('span', 'rsm-dsub', ch.disabled ? ch.why ?? '' : 'the conversation carries over from a saved summary'));
        b.addEventListener('click', () => {
          pick = ch.to;
          for (const x of group.children) x.setAttribute('aria-checked', String(x === b));
          yes.disabled = false;
        });
        group.append(b);
      }
      bd.append(group, err);
      group.querySelector('button:not(:disabled)')?.focus();
    })();

    yes.addEventListener('click', async () => {
      if (submitting || !pick) {
        return;
      }
      submitting = true;
      yes.disabled = true;
      no.disabled = true;
      const r = await call(base, { to: pick });
      submitting = false;
      no.disabled = false;
      if (!dialogEl) {
        return;
      }
      if (!r.ok || !r.body?.opId) {
        err.hidden = false;
        err.textContent = `Not switched — ${r.body?.error ?? `HTTP ${r.status}`}`;
        yes.disabled = false;
        return;
      }
      progress(r.body.opId);
    });
  }

  return { decorate, statusFor, holding, openMenu };
}
