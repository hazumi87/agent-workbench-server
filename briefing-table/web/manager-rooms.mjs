/* THE MANAGER'S ROOMS (the design system cli-manager-rooms-v1, Owner's round 2026-09-28; CARDS since the Workbench home, 2026-10-06).
 *
 * (2) ROOMS AS CARDS. A room card carries its loudest member's ring on the WR1-B glyph, "N seats · lead @x", the unread
 * badge, its workgroups as chips, its seats as a row of rings, and Open room. A session seated in any room is left out of
 * the live list, which is "Live tabs" (seatedPanes()).
 *
 * (1) HIDE ROOMS. A per-PERSON list (GET/PATCH /api/rooms/me {hiddenRooms}: only this manager's list; agents keep full
 * access). The room menu (right click, the card's ⋯, Shift+F10 / the Menu key, a long press; a bottom sheet on a phone)
 * offers Open · Room settings · Hide from my list / Unhide. Hiding is instant with a 5 s Undo. The Rooms bar shows
 * "N hidden · View" only while N > 0, then "showing N hidden · Hide them"; it is per device, and shows hidden rooms in
 * place at 55% with an eye-off "hidden" tag and an Unhide button. Until /api/rooms/me answers WITH hiddenRooms (the
 * route also serves your picture), there is no Hide item at all: never a control that cannot work.
 */
import { hwbRing, hwbRingFromChrome, hwbRingLead, hwbRingLabel } from '/aurora/window-chrome/hwb-ring.js';
import { brandMarkPath } from '/aurora/brand-marks/aurora-brand-marks.js';
import { brandFor } from '/brand.mjs';
import { stripMarks } from '/markdown-plain.mjs'; // a card's last line is plain text [line markdown]
import { isBasic } from '/edition.mjs'; // Basic names them sites [basic]
import { tileById } from '/room-tile.mjs'; // a room's chosen art tile, by id (the file is /assets/tiles/<id>-512.webp)

const PHONE = '(max-width: 600px)';
const LONG_PRESS_MS = 500;
const TOAST_MS = 5000;
const K_SHOW = 'wb.mgr.rooms.showHidden';

const ICON = {
  open: '<path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.8 9.8 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
};
function svg(key, cls = '') {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[key]}</svg>`;
}

function readJson(k, dflt) {
  try {
    const v = JSON.parse(localStorage.getItem(k) ?? 'null');
    return v ?? dflt;
  } catch {
    return dflt;
  }
}
function writeJson(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: this page's life only */ }
}

/* ---- the seat → ring rule: the room page's own (room.js seatChrome) ---- */
function seatChrome(seat) {
  if (seat.status === 'starting') {
    return 'background';
  }
  const o = seat.occupant;
  return !o ? 'ended' : o.state === 'live' ? o.activity || 'idle' : o.state === 'dehydrated' ? 'restorable' : 'ended';
}
function seatSpec(seat) {
  if (seat.status === 'never-started' || seat.status === 'empty') {
    return null;
  }
  return hwbRingFromChrome(seatChrome(seat), { attached: !!seat.occupant?.attached, exit: seat.occupant?.exit });
}
function leadOf(room, seats) {
  return room.lead_seat || seats.find((s) => s.is_lead)?.id || null;
}
function ordered(room, seats) {
  const lead = leadOf(room, seats);
  return [...seats]
    .filter((s) => s.left_at === null || s.left_at === undefined)
    .sort((a, b) => (a.id === lead ? -1 : b.id === lead ? 1 : (a.position ?? 0) - (b.position ?? 0)));
}

/** pane id -> the room it sits in {id, name, color}: the Live sessions list names each session's room (the design system 1.K). A pane
 *  seated in a main room AND a workgroup answers the main room. */
export function roomOfPanes(rooms) {
  const out = new Map();
  const list = [...(rooms || [])].sort((a, b) => (a.room.parent_id ? 1 : 0) - (b.room.parent_id ? 1 : 0));
  for (const v of list) {
    for (const s of v.seats || []) {
      const id = typeof s.occupant === 'object' ? s.occupant?.id : s.occupant_kind === 'pane' ? s.occupant : null;
      if (id && !out.has(id)) {
        out.set(id, { id: v.room.id, name: v.room.name, color: typeof v.room.color === 'string' && /^#[0-9a-f]{6}$/i.test(v.room.color) ? v.room.color : null, room: v.room });
      }
    }
  }
  return out;
}

/** Every pane seated in any room. */
export function seatedPanes(rooms) {
  const out = new Set();
  for (const v of rooms || []) {
    for (const s of v.seats || []) {
      const id = typeof s.occupant === 'object' ? s.occupant?.id : s.occupant_kind === 'pane' ? s.occupant : null;
      if (id) {
        out.add(id);
      }
    }
  }
  return out;
}

/**
 * @param {{list: HTMLElement, toggle: HTMLButtonElement,
 *          openRoom: (room, actions) => void,
 *          openPane: (recipeId: string, paneid: string) => Promise<void>|void,
 *          colorOf: (recipeId: string) => string|null}} o
 */
export function createRoomsView(o) {
  const st = {
    rooms: [],
    hidden: new Set(),
    meOk: false, // /api/rooms/me answered: Hide is offered only then
    showHidden: readJson(K_SHOW, false) === true,
    sig: '',
  };

  /* ---- the per-person hidden set ---- */
  async function loadMe() {
    try {
      const r = await fetch('/api/rooms/me');
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}`);
      }
      const b = await r.json();
      /* the route also serves your picture (room authorship v2): Hide is
         offered only once it carries the hidden set */
      if (!Array.isArray(b?.hiddenRooms)) {
        throw new Error('no hiddenRooms yet');
      }
      st.hidden = new Set(b.hiddenRooms.filter((x) => typeof x === 'string'));
      st.meOk = true;
    } catch {
      st.meOk = false; // no route yet (or a blip): no Hide, nothing hidden
    }
    st.sig = '';
    render(st.rooms);
  }
  async function saveHidden(next, undoOf) {
    const before = st.hidden;
    st.hidden = next;
    st.sig = '';
    render(st.rooms);
    try {
      const r = await fetch('/api/rooms/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hiddenRooms: [...next] }),
      });
      if (!r.ok) {
        let why = `HTTP ${r.status}`;
        try { why = (await r.json()).error ?? why; } catch { /* not json */ }
        throw new Error(why);
      }
      const b = await r.json().catch(() => null);
      if (Array.isArray(b?.hiddenRooms)) {
        st.hidden = new Set(b.hiddenRooms);
      }
      if (undoOf) {
        toast(`Hidden “${undoOf.name}”. Only your list.`, 'Undo', () => void saveHidden(new Set([...st.hidden].filter((x) => x !== undoOf.id))));
      }
    } catch (e) {
      st.hidden = before; // put it back as it was: the list must not lie
      toast(`Could not change your list — ${e?.message ?? e}`);
    }
    st.sig = '';
    render(st.rooms);
  }
  function setHidden(room, hide) {
    const next = new Set(st.hidden);
    if (hide) {
      next.add(room.id);
    } else {
      next.delete(room.id);
    }
    void saveHidden(next, hide ? room : null);
  }

  /* ---- the Show hidden N toggle (per device) ---- */
  o.toggle.addEventListener('click', () => {
    st.showHidden = !st.showHidden;
    writeJson(K_SHOW, st.showHidden);
    st.sig = '';
    render(st.rooms);
  });
  function paintToggle(n) {
    o.toggle.hidden = !(st.meOk && n > 0);
    o.toggle.setAttribute('aria-pressed', String(st.showHidden));
    o.toggle.textContent = st.showHidden ? `showing ${n} hidden · Hide them` : `${n} hidden · View`; /* the design system 1.K: no icon, the words are the control */
    o.toggle.title = st.showHidden ? 'Hidden rooms are showing, dimmed: click to put them away' : `${n} room${n === 1 ? '' : 's'} hidden from your list: click to show them`;
  }

  /* ---- cards (the design system BUILD-HANDOFF 1.K, hub/workbench.html roomCard) ----
     A room is a CARD: a wash header in its colour (the WR1-B plate with the loudest member's ring, the name, "N seats ·
     lead @x", the person's unread as a badge), then its workgroups as chips, its seats as a row of rings, and Open room
     + ⋯. A workgroup nests as a chip on its main room (a click on it opens THAT room); one whose main room is not
     listed stands as a card of its own. No expand/collapse: the seats are the ring row, and a live agent is a card in
     Live sessions. Opening a room never wakes its agents (Owner 2026-10-02): there is no Restore button here. */
  const HEX = /^#[0-9a-f]{6}$/i;
  const roomColor = (room) => (typeof room.color === 'string' && HEX.test(room.color) ? room.color : '#5a6672');
  const mk = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) {
      n.className = cls;
    }
    if (text !== undefined) {
      n.textContent = text;
    }
    return n;
  };
  function seatRing(seat, lead) {
    const g = mk('span', 'rc-seat');
    const spec = seatSpec(seat);
    const b = brandFor(seat.vendor || 'unknown');
    try {
      const r = hwbRing(g, spec, 24, { brand: b.brand || 'generic', markPath: brandMarkPath(b.brand || 'generic'), primary: seat.id === lead });
      if (b.brandColor) {
        r.style.setProperty('--brand-src', b.brandColor);
      }
      g.title = `@${seat.handle} · ${spec ? hwbRingLabel(spec) : 'not started'} · ${b.label}`;
    } catch {
      /* an older bundle without plate-only: no glyph rather than a wrong ring */
    }
    return g;
  }

  function roomCard(v, subs = []) {
    const room = v.room;
    const seats = ordered(room, v.seats || []);
    const lead = leadOf(room, seats);
    const hidden = st.hidden.has(room.id);
    const n = seats.length;
    const leadSeat = seats.find((s) => s.id === lead);
    const card = mk('div', `rcard${room.state === 'open' ? '' : ' is-archived'}${hidden ? ' is-hidden' : ''}${room.parent_id ? ' is-wg' : ''}`);
    card.dataset.room = room.id;
    card.style.setProperty('--rc', roomColor(room));
    card.tabIndex = 0;
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', `${room.name}, ${n} seat${n === 1 ? '' : 's'}${hidden ? ', hidden' : ''}`);

    const hd = mk('div', 'rc-hd');
    /* THE ROOM'S OWN ART (the design system hub/workbench.html .hd .art; Owner 2026-10-07: "the cards are missing the background art"):
       its chosen tile behind the header, ghosted (opacity .16, luminosity; light: multiply .10), 180px. The tile id rides on
       the room list the page already fetches (room.art_tile). A room with no tile gets no layer. */
    const tile = room.art_tile && typeof room.art_tile.id === 'string' ? tileById(room.art_tile.id) : null;
    if (tile) {
      const art = mk('span', 'rc-art');
      art.setAttribute('aria-hidden', 'true');
      art.style.backgroundImage = `url(${tile.src})`;
      hd.append(art);
    }
    const glyph = mk('span', 'rc-g');
    const specs = seats.map(seatSpec);
    const i = hwbRingLead(specs.map((x) => x ?? null));
    const loudSpec = i >= 0 ? specs[i] : null;
    if (room.parent_id) {
      glyph.append(mk('span', 'sub-plate'));
    } else {
      const loud = room.state !== 'open' ? 'ended' : i >= 0 ? seatChrome(seats[i]) : 'idle';
      const ring = hwbRing(glyph, hwbRingFromChrome(loud, { attached: false }), 34, { workroom: true });
      ring.title = room.state === 'open' ? `Workroom · loudest: ${loud}` : `Workroom (${room.state})`;
    }
    const tx = mk('div', 'rc-tx');
    const nm = mk('div', 'rc-nm', room.name);
    if (room.parent_id && room.alias) {
      nm.append(mk('span', 'rr-al', `@${room.alias}`));
    }
    const hid = mk('span', 'rr-hid');
    hid.innerHTML = `${svg('eyeOff')}hidden`;
    nm.append(hid);
    const sub = mk('div', 'rc-sub');
    if (isBasic()) {
      /* BASIC (the design system, Basic design pass): a site has agents, no seats and no lead to name: "1 agent" */
      sub.append(`${room.state !== 'open' ? `${room.state} · ` : ''}${n} agent${n === 1 ? '' : 's'}`);
    } else {
      sub.append(`${room.state !== 'open' ? `${room.state} · ` : ''}${n} seat${n === 1 ? '' : 's'} · `);
      if (leadSeat) {
        sub.append('lead ', mk('span', 'h', `@${leadSeat.handle}`));
      } else {
        sub.append('no lead');
      }
    }
    tx.append(nm, sub);
    hd.append(glyph, tx);
    if (v.unread > 0) {
      const badge = mk('span', `rc-badge${loudSpec?.state === 'alert' ? ' att' : ''}`, String(v.unread));
      badge.setAttribute('aria-label', `${v.unread} new in ${room.name}`);
      hd.append(badge);
    }

    const bd = mk('div', 'rc-bd');
    if (subs.length) {
      const wgs = mk('div', 'rc-wgs');
      for (const w of subs) {
        const chip = mk('button', 'rc-wg');
        chip.type = 'button';
        chip.title = `Open ${w.room.name}`;
        chip.style.setProperty('--sc', roomColor(w.room));
        chip.append(mk('span', 'sub-plate'), w.room.name);
        if (w.unread > 0) {
          chip.append(mk('b', '', String(w.unread)));
        }
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          o.openRoom(w.room, w.actions);
        });
        wgs.append(chip);
      }
      bd.append(wgs);
    }
    const row = mk('div', 'rc-seats');
    const nLive = seats.filter((x) => x.occupant?.state === 'live').length;
    if (n && !nLive) {
      row.append(mk('span', 'rc-more', `${n} seat${n === 1 ? '' : 's'}, none live`)); /* the design system [ref]: muted text, not a row of dead rings */
    } else if (n) {
      for (const s of seats.slice(0, 5)) {
        row.append(seatRing(s, lead));
      }
      if (n > 5) {
        row.append(mk('span', 'rc-more', `+${n - 5} seats`));
      }
    } else {
      row.append(mk('span', 'rc-more', 'no seats yet'));
    }
    bd.append(row);

    /* the room's last line, when the room list carries it (the engine adds it later): "@lead text"; absent = no line at all */
    const last = v.last ?? v.last_line ?? null;
    const lastText = typeof last?.text === 'string' ? last.text : typeof last?.body === 'string' ? last.body : '';
    if (lastText) {
      const l = mk('div', 'rc-last');
      const who = last.author ?? last.handle ?? '';
      if (who) {
        l.append(mk('span', 'h', `@${String(who).replace(/^@/, '')}`), ' ');
      }
      l.append(stripMarks(lastText)); // a card's last line is plain: the marks go [line markdown]
      bd.append(l);
    }
    const acts = mk('div', 'rc-acts');
    if (hidden) {
      const un = mk('button', 'btn rr-unhide', 'Unhide');
      un.type = 'button';
      un.dataset.act = 'unhide';
      un.addEventListener('click', (e) => {
        e.stopPropagation();
        void setHidden(room, false);
      });
      acts.append(un);
    }
    const open = mk('button', 'btn btn-accent', isBasic() ? 'Open' : 'Open room');
    open.type = 'button';
    open.dataset.act = 'open-room';
    open.addEventListener('click', (e) => {
      e.stopPropagation();
      o.openRoom(room, v.actions);
    });
    const more = mk('button', 'rr-more');
    more.type = 'button';
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-label', `More for ${room.name}`);
    more.title = 'More';
    more.innerHTML = svg('more');
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenu(v, more, null);
    });
    acts.append(open, more);
    bd.append(acts);
    card.append(hd, bd);

    card.addEventListener('click', (e) => {
      if (!e.target.closest('button')) {
        o.openRoom(room, v.actions);
      }
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(v, card, { x: e.clientX, y: e.clientY });
    });
    card.addEventListener('keydown', (e) => {
      if (e.target !== card) {
        return;
      }
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault();
        openMenu(v, card, null);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        o.openRoom(room, v.actions);
      }
    });
    /* a long press = the menu (iOS fires no contextmenu) */
    let timer = 0;
    let at = null;
    card.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || e.target.closest('button')) {
        return;
      }
      at = { x: e.clientX, y: e.clientY };
      timer = setTimeout(() => { timer = 0; openMenu(v, card, at); }, LONG_PRESS_MS);
    });
    const cancel = () => { clearTimeout(timer); timer = 0; };
    card.addEventListener('pointerup', cancel);
    card.addEventListener('pointercancel', cancel);
    card.addEventListener('pointermove', (e) => {
      if (timer && at && Math.hypot(e.clientX - at.x, e.clientY - at.y) > 10) {
        cancel();
      }
    });
    return card;
  }

  function render(rooms) {
    st.rooms = Array.isArray(rooms) ? rooms : [];
    const sig = JSON.stringify([
      st.rooms.map((v) => [v.room.id, v.room.name, v.room.state, v.room.lead_seat, v.room.parent_id, v.room.alias, v.room.color, v.room.art_tile?.id ?? null, v.last?.ts ?? null, v.last?.text ?? null, v.unread,
        (v.seats || []).map((s) => [s.id, s.handle, s.status, s.occupant?.state, s.occupant?.activity, s.occupant?.attached, s.recipe_id, s.vendor])]),
      [...st.hidden], st.showHidden, st.meOk,
    ]);
    if (sig === st.sig || menuEl) {
      return; // unchanged, or a menu is open over the rows (it must not lose its anchor)
    }
    st.sig = sig;
    const focus = document.activeElement?.closest?.('.rcard')?.dataset.room ?? null;
    const focusMore = document.activeElement?.classList?.contains('rr-more');
    o.list.textContent = '';
    const sorted = [...st.rooms].sort((a, b) => (a.room.state === 'open' ? 0 : 1) - (b.room.state === 'open' ? 0 : 1)
      || a.room.name.localeCompare(b.room.name));
    let nHidden = 0;
    /* WORKGROUPS: a workgroup is listed right under its main room (when that room is listed) */
    const ids = new Set(sorted.map((v) => v.room.id));
    const under = new Map();
    for (const v of sorted) {
      if (v.room.parent_id && ids.has(v.room.parent_id)) {
        (under.get(v.room.parent_id) ?? under.set(v.room.parent_id, []).get(v.room.parent_id)).push(v);
      }
    }
    for (const v of sorted) {
      if (v.room.parent_id && ids.has(v.room.parent_id)) {
        continue; // drawn under its main room below
      }
      const shown = [];
      for (const w of [v, ...(under.get(v.room.id) ?? [])]) {
        const hid = st.hidden.has(w.room.id) || (w !== v && st.hidden.has(v.room.id));
        nHidden += hid ? 1 : 0;
        if (hid && !st.showHidden) {
          continue;
        }
        shown.push(w);
      }
      if (shown[0] === v) {
        o.list.append(roomCard(v, shown.slice(1)));
      } else {
        shown.forEach((w) => o.list.append(roomCard(w))); // the main room is hidden: its workgroups stand alone
      }
    }
    paintToggle(nHidden);
    if (o.tail) {
      o.list.append(o.tail); // "+ New room" ends the grid
    }
    if (focus) {
      const r = o.list.querySelector(`.rcard[data-room="${CSS.escape(focus)}"]`);
      (focusMore ? r?.querySelector('.rr-more') : r)?.focus({ preventScroll: true });
    }
  }

  /* ---- the menu: one surface (desktop), a bottom sheet (phone) ---- */
  let menuEl = null;
  let scrimEl = null;
  let returnTo = null;
  function closeMenu() {
    if (!menuEl) {
      return;
    }
    menuEl.remove();
    scrimEl?.remove();
    menuEl = null;
    scrimEl = null;
    document.removeEventListener('pointerdown', onAway, true);
    returnTo?.focus?.({ preventScroll: true });
    returnTo = null;
    render(st.rooms); // anything that changed while it was open
  }
  function onAway(e) {
    if (menuEl && !menuEl.contains(e.target)) {
      closeMenu();
    }
  }
  function openMenu(v, anchor, point) {
    closeMenu();
    const room = v.room;
    const phone = matchMedia(PHONE).matches;
    const hidden = st.hidden.has(room.id);
    returnTo = anchor;
    const m = document.createElement('div');
    m.className = `rr-menu${phone ? ' is-sheet' : ''}`;
    m.setAttribute('role', 'menu');
    m.setAttribute('aria-label', room.name);
    const item = (icon, label, act) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'rr-mi';
      b.setAttribute('role', 'menuitem');
      b.innerHTML = svg(icon);
      b.append(label);
      b.addEventListener('click', () => { closeMenu(); act(); });
      return b;
    };
    if (phone) {
      m.innerHTML = '<div class="grab" aria-hidden="true"></div>';
      const t = document.createElement('div');
      t.className = 'rr-mt';
      t.textContent = room.name;
      m.append(t);
    }
    m.append(
      item('open', 'Open', () => o.openRoom(room, v.actions)),
      item('gear', 'Room settings', () => o.openRoom(room, v.actions, { settings: true })),
    );
    if (st.meOk) {
      const sep = document.createElement('div');
      sep.className = 'rr-msep';
      m.append(sep, item(hidden ? 'eye' : 'eyeOff', hidden ? 'Unhide' : 'Hide from my list', () => setHidden(room, !hidden)));
      const note = document.createElement('div');
      note.className = 'rr-mnote';
      note.textContent = 'Only your list. Agents keep full access.';
      m.append(note);
    }
    m.addEventListener('keydown', (e) => {
      const items = [...m.querySelectorAll('.rr-mi')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
      } else if (e.key === 'Tab') {
        e.preventDefault(); // a menu is left with Esc or a choice
      }
    });
    if (phone) {
      scrimEl = document.createElement('div');
      scrimEl.className = 'rr-scrim';
      document.body.append(scrimEl);
    }
    document.body.append(m);
    menuEl = m;
    if (!phone) {
      const r = anchor.getBoundingClientRect();
      const w = m.offsetWidth;
      const h = m.offsetHeight;
      let x = point ? point.x : r.right - w;
      let y = point ? point.y : r.bottom + 4;
      x = Math.max(8, Math.min(x, innerWidth - w - 8));
      y = y + h > innerHeight - 8 ? Math.max(8, (point ? point.y : r.top) - h - 4) : y;
      m.style.left = `${x}px`;
      m.style.top = `${y}px`;
    }
    m.querySelector('.rr-mi')?.focus({ preventScroll: true });
    setTimeout(() => document.addEventListener('pointerdown', onAway, true), 0);
  }

  /* ---- the toast ---- */
  let toastEl = null;
  let toastTimer = 0;
  function toast(text, actLabel, act) {
    toastEl?.remove();
    clearTimeout(toastTimer);
    const t = document.createElement('div');
    t.className = 'rr-toast';
    t.setAttribute('role', 'status');
    t.append(text);
    if (actLabel) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = actLabel;
      b.addEventListener('click', () => { t.remove(); act(); });
      t.append(b);
    }
    document.body.append(t);
    toastEl = t;
    toastTimer = setTimeout(() => t.remove(), TOAST_MS);
  }

  void loadMe();
  return { render, reloadMe: loadMe };
}
