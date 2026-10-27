/* THE CLI MANAGER CHIP'S SHEET [web/room-phone-7] (Owner, room line [ref]).
 *
 * The first chip on the phone's line (the jump strip) is "CLI Manager". It
 * opens the room's own bottom sheet (the one the Agents button opens) listing
 * the OTHER places to go: every open room but this one (with its colour and
 * its art mark), then every live agent session NOT seated in an open room
 * (a seated one is reached through its room) with its ring on its brand
 * plate and its title [web/room-phone-7b]. A tap NAVIGATES THIS TAB there: a room to
 * /room.html?room=<id>, a session to its solo page (the same relative path the
 * engine hands the manager, src/server/solo-path.ts). Each row also offers
 * "Open in new tab": a trailing icon, or a long press. The full CLI Manager
 * page's own behaviour is untouched.
 *
 * Data: GET /api/rooms (the manager's room list, rooms hidden from YOUR list
 * left out) and GET /api/table (live, non-component rows with a recipe),
 * re-read at most every 4 s while the sheet is open. Rows are drawn from the
 * last answer at once, so the room page's 2.5 s repaint of an open sheet never
 * flickers through a loading state.
 */
import { hwbRing, hwbRingFromChrome, hwbRingLabel, hwbRingLead } from '/aurora/window-chrome/hwb-ring.js';
import { hwbMarkClass } from '/aurora/window-chrome/hwb-chrome.js';
import { brandMarkPath } from '/aurora/brand-marks/aurora-brand-marks.js';
import { brandFor } from '/brand.mjs';
import { sanitizeSvg } from '/logo-modal.mjs';
import { roomLogo, markStyle } from '/room-character.mjs';
import { hydrateArt } from '/art-cache.mjs';

const LONG_PRESS_MS = 500;
const STALE_MS = 4000;
const NEUTRAL_ROOM = '#5a6672'; // room.js NEUTRAL_ROOM: a room with no colour and no lead
const OPEN_NEW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';

/** The engine's soloPathFor, verbatim in shape: a project's PRIMARY pane
 *  carries no &pane= (its historical form), any other pane is named. */
export function soloPath(recipeId, paneid) {
  const pane = paneid && paneid !== `recipe:${recipeId}` ? paneid : null;
  return `/solo.html?recipe=${encodeURIComponent(recipeId)}${pane ? `&pane=${encodeURIComponent(pane)}` : ''}`;
}
export function roomPath(id) {
  return `/room.html?room=${encodeURIComponent(id)}`;
}

/* ---- the ring rules: room.js seatChrome / the manager's ringSpecFor ---- */
function seatChrome(seat) {
  if (seat.status === 'starting') {
    return 'background';
  }
  const o = seat.occupant;
  return !o ? 'ended' : o.state === 'live' ? o.activity || 'idle' : o.state === 'dehydrated' ? 'restorable' : 'ended';
}
/* Live rows blocked on you sort first: an unseen block, then a seen one
   (window-chrome v33, ticket — seen is still blocked), then the rest. */
function blockedOnYou(row) {
  return row.activity === 'waiting' ? 2 : row.activity === 'waiting-seen' ? 1 : 0;
}
function seatSpec(seat) {
  if (seat.status === 'never-started' || seat.status === 'empty') {
    return null;
  }
  return hwbRingFromChrome(seatChrome(seat), { attached: !!seat.occupant?.attached, exit: seat.occupant?.exit });
}
function rowSpec(row) {
  return hwbRingFromChrome(row.activity || 'idle', { attached: !!row.attached, exit: row.exit });
}

function mk(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) {
    n.className = cls;
  }
  if (text !== undefined) {
    n.textContent = text;
  }
  return n;
}

/**
 * @param {{roomId: string|null,       null = not in a room (the solo page's sheet)
 *          exceptPane?: string,          this page's own pane: left out of Live agents
 *          noFullManager?: boolean,      the manager page's own sheet: we ARE the manager, so omit its row
 *          hidden: () => string[]|null,          rooms hidden from this person's list
 *          recipeColor: (id: string) => string|null,
 *          recipeName: (id: string) => string|null,
 *          onChange: () => void}} o              the data landed: repaint the open sheet
 */
export function createPlaces(o) {
  const data = { rooms: null, live: null, at: 0, busy: false, err: null };

  async function load() {
    if (data.busy) {
      return;
    }
    data.busy = true;
    try {
      const [r, t] = await Promise.all([
        fetch('/api/rooms?art=ref').then((x) => (x.ok ? x.json() : Promise.reject(new Error(`rooms HTTP ${x.status}`)))),
        fetch('/api/table').then((x) => (x.ok ? x.json() : Promise.reject(new Error(`table HTTP ${x.status}`)))),
      ]);
      data.rooms = Array.isArray(r) ? r.filter((v) => v && v.room) : [];
      await Promise.all(data.rooms.map((v) => hydrateArt(v.room))); // [perf/poll-traffic] the art by key + hash
      data.live = Array.isArray(t?.sessions) ? t.sessions : [];
      data.err = null;
    } catch (e) {
      data.err = String(e?.message ?? e); // keep the last lists: a blip must not blank the sheet
    } finally {
      data.at = Date.now();
      data.busy = false;
    }
    o.onChange();
  }

  /** Navigate here, or (newTab) open beside. */
  function go(url, newTab) {
    if (newTab) {
      window.open(url, '_blank', 'noopener');
    } else {
      window.location.assign(url);
    }
  }

  /** One row of the sheet: the desktop column's .seat shape, a tap goes, the
   *  trailing icon or a long press opens a new tab. */
  function row(list, { label, url, glyph, name, meta, colour, mark }) {
    const li = mk('li', 'seat pl-row');
    li.tabIndex = 0;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    li.setAttribute('aria-label', label);
    li.dataset.url = url;
    if (colour) {
      li.style.setProperty('--pl-c', colour);
      li.classList.add('pl-tinted');
    }
    if (mark) {
      const m = mk('span', 'pl-mark');
      m.setAttribute('aria-hidden', 'true');
      m.innerHTML = mark;
      li.append(m);
    }
    const g = mk('span', 'seat-glyph');
    g.append(glyph);
    const top = mk('div', 'seat-top');
    top.append(mk('span', 'seat-handle pl-name', name));
    const m2 = mk('div', 'seat-meta', meta);
    const side = mk('div', 'seat-side');
    const nb = mk('button', 'pl-new');
    nb.type = 'button';
    nb.title = 'Open in new tab';
    nb.setAttribute('aria-label', `Open ${name} in a new tab`);
    nb.innerHTML = OPEN_NEW;
    nb.addEventListener('click', (e) => {
      e.stopPropagation();
      go(url, true);
    });
    side.append(nb);
    li.append(g, top, m2, side);
    let timer = 0;
    let pressed = false;
    li.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) {
        return;
      }
      pressed = false;
      clearTimeout(timer);
      timer = setTimeout(() => {
        pressed = true;
        go(url, true);
      }, LONG_PRESS_MS);
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
      li.addEventListener(ev, () => clearTimeout(timer));
    }
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault(); // the long press is ours (desktop right click too)
      if (!pressed) {
        clearTimeout(timer);
        pressed = true;
        go(url, true);
      }
    });
    li.addEventListener('click', (e) => {
      if (e.target.closest('button')) {
        return;
      }
      if (pressed) {
        pressed = false; // the long press already opened it
        return;
      }
      go(url, false);
    });
    li.addEventListener('keydown', (e) => {
      if (e.target === li && e.key === 'Enter') {
        e.preventDefault();
        go(url, e.ctrlKey || e.metaKey);
      }
    });
    list.append(li);
  }

  function roomRows(section) {
    const hidden = new Set(o.hidden() || []);
    const listed = (data.rooms || []).filter((v) => v.room.id !== o.roomId && v.room.state === 'open' && !hidden.has(v.room.id));
    /* WORKGROUPS (Owner 2026-10-04): each one right under its main room. THIS room's own workgroups (Owner 2026-10-13,
       [ref]): their main room is the one you are in, so it is not listed and they used to float, indented, under whichever
       room happened to be above them by recency. They lead the sheet under their own heading instead. */
    const own = listed.filter((v) => v.room.parent_id === o.roomId);
    const ownIds = new Set(own.map((v) => v.room.id));
    const rest = listed.filter((v) => !ownIds.has(v.room.id));
    const ids = new Set(rest.map((v) => v.room.id));
    const views = [];
    for (const v of rest) {
      if (!v.room.parent_id || !ids.has(v.room.parent_id)) {
        views.push(v, ...rest.filter((w) => w.room.parent_id === v.room.id));
      }
    }
    if (own.length) {
      const ow = section('Workgroups of this room');
      for (const v of own) {
        roomRow(ow, v);
      }
    }
    if (views.length) {
      const ol = section('Rooms');
      for (const v of views) {
        roomRow(ol, v);
      }
    }
    return views.length + own.length;
  }

  /** A TEAM is a room of a family of more than one open room (a workgroup, or a main room that has workgroups): the sheet's
   *  accessible name says "Team X" for it, never "Room X" (Owner 2026-10-27: teams were being stated as rooms). */
  function isTeam(room) {
    return !!room.parent_id || (data.rooms || []).some((w) => w.room.state === 'open' && w.room.parent_id === room.id);
  }

  /** One room's row (a workgroup shows its "\u21b3" and its alias). */
  function roomRow(ol, v) {
    const room = v.room;
    const seats = (v.seats || []).filter((s) => s.left_at === null || s.left_at === undefined);
    const i = hwbRingLead(seats.map((s) => seatSpec(s) ?? null));
    const loud = i >= 0 ? seatChrome(seats[i]) : 'idle';
    const ring = mk('span', 'seat-ring');
    hwbRing(ring, hwbRingFromChrome(loud, { attached: false }), 28, { workroom: true });
    ring.title = `Workroom · loudest: ${loud}`;
    const lead = seats.find((s) => s.id === room.lead_seat) || seats.find((s) => s.is_lead);
    const colour = room.color || (lead && o.recipeColor(lead.recipe_id)) || NEUTRAL_ROOM;
    const logo = roomLogo(room);
    const n = seats.length;
    row(ol, {
      label: `${isTeam(room) ? 'Team' : 'Room'} ${room.name}`,
      url: roomPath(room.id),
      glyph: ring,
      name: room.parent_id ? `\u21b3 ${room.name}` : room.name,
      meta: [room.parent_id && room.alias ? `workgroup @${room.alias}` : null, `${n} seat${n === 1 ? '' : 's'}`, lead ? `lead @${lead.handle}` : 'no lead', v.unread > 0 ? `${v.unread} new` : null].filter(Boolean).join(' · '),
      colour,
      mark: logo ? `<span class="mark${hwbMarkClass(markStyle(logo))}">${sanitizeSvg(logo.svg)}</span>` : null,
    });
  }

  /** Panes that occupy a seat in any OPEN room (this one included): the
   *  manager's seatedPanes rule (manager-rooms.mjs). */
  function seated() {
    const out = new Set();
    for (const v of data.rooms || []) {
      if (v.room.state !== 'open') {
        continue;
      }
      for (const s of v.seats || []) {
        const id = typeof s.occupant === 'object' ? s.occupant?.id : s.occupant_kind === 'pane' ? s.occupant : null;
        if (id && (s.left_at === null || s.left_at === undefined)) {
          out.add(id);
        }
      }
    }
    return out;
  }

  function liveRows(section) {
    const inRoom = seated();
    const live = (data.live || [])
      .filter((s) => s.state === 'live' && s.recipe_id && s.kind !== 'component' && !inRoom.has(s.paneid) && s.paneid !== o.exceptPane)
      .map((s) => ({ s, title: s.title || o.recipeName(s.recipe_id) || s.friendlyName || s.paneid }))
      .sort((a, b) => blockedOnYou(b.s) - blockedOnYou(a.s) || a.title.localeCompare(b.title));
    const ol = section('Live agents');
    for (const { s, title } of live) {
      const spec = rowSpec(s);
      const b = brandFor(s.vendor || 'unknown');
      const ring = mk('span', 'seat-ring');
      hwbRing(ring, spec, 28, { brand: b.brand, markPath: brandMarkPath(b.brand) });
      if (b.brandColor) {
        ring.style.setProperty('--brand-src', b.brandColor);
      }
      ring.dataset.brand = b.brand;
      ring.title = `${hwbRingLabel(spec)} · ${b.label}`;
      const project = o.recipeName(s.recipe_id) || s.friendlyName || null;
      row(ol, {
        label: `Agent ${title}`,
        url: soloPath(s.recipe_id, s.paneid),
        glyph: ring,
        name: title,
        meta: [hwbRingLabel(spec), project && project !== title ? project : null, s.attached ? null : 'no window'].filter(Boolean).join(' · '),
        colour: null,
        mark: null,
      });
    }
    return live.length;
  }

  /** "Full CLI Manager ›": the first row, above the sections. Same tab. */
  function fullManagerRow(body) {
    const ol = mk('ol');
    ol.setAttribute('role', 'listbox');
    ol.setAttribute('aria-label', 'Full Workbench');
    const li = mk('li', 'seat pl-row pl-full');
    li.style.minHeight = '44px';
    li.style.paddingTop = '0';
    li.style.paddingBottom = '0';
    li.tabIndex = 0;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    li.setAttribute('aria-label', 'Full Workbench');
    const g = mk('span', 'seat-glyph');
    g.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/></svg>';
    const top = mk('div', 'seat-top');
    top.style.gridRow = '1 / 3';
    top.style.alignSelf = 'center';
    top.append(mk('span', 'seat-handle pl-name', 'Full Workbench'));
    const side = mk('div', 'seat-side pl-chev', '\u203a');
    side.setAttribute('aria-hidden', 'true');
    li.append(g, top, side);
    li.addEventListener('click', () => go('/manager.html', false));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        go('/manager.html', false);
      }
    });
    ol.append(li);
    body.append(ol);
  }

  return {
    /** Fill the sheet body (room.js fillSheet, kind 'places'). */
    fill(body, section) {
      if (!o.noFullManager) {
        fullManagerRow(body);
      } // above every section, even while loading (Owner 2026-10-02, room line [ref])
      if (Date.now() - data.at > STALE_MS) {
        void load();
      }
      if (data.rooms === null) {
        const p = mk('p', 'rm-addnote pl-note', data.err ? `Could not load: ${data.err}` : 'Loading…');
        body.append(p);
        return;
      }
      const nRooms = roomRows(section);
      if (!nRooms) {
        body.append(mk('p', 'rm-addnote pl-note', 'No other open rooms.'));
      }
      const nLive = liveRows(section);
      if (!nLive) {
        body.append(mk('p', 'rm-addnote pl-note', 'No other live agents'));
      }
    },
    refresh: () => load(),
  };
}
