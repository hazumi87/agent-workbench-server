/* WORKROOM PAGE — engine-side STAND-IN (the design notes §0.1 Q4, §4 T6)
 * [ticket]. The web/workbench.js precedent: it proves the room seam by
 * speaking the §2 vocabulary exactly, and the design system room surface replaces it.
 *
 * What it holds and what it does NOT:
 *   - The ROSTER is the engine's `GET /api/rooms/:id` verbatim. Every seat's
 *     `status` / `occupant` / `vendor` is DERIVED BY THE ENGINE (§2.1); the page
 *     joins nothing. The ring is `hwbRingFromChrome` over the occupant, the same
 *     derivation solo and the manager use (a third copy of that table is the
 *     drift the ring work of 2026-09-01 removed).
 *   - The LINE is keyed by entry id. Every source (the newest page, back
 *     paging, the forward backfill, a POST's answer, a push) goes through ONE
 *     de-duping insert, so a push that races its own POST, or a backfill that
 *     overlaps a push, can never draw an entry twice.
 *   - The INPUT sends RAW text. No author, no target, no pre-parse: the engine
 *     parses (§3, command parity) and derives the author (§2.2). A page-side
 *     parser would give this surface its own dialect.
 *   - LIVE PUSH rides the existing /pty socket (§2.3): `room.subscribe` on
 *     EVERY open (a subscribe that outlives its socket is the
 *     fabric-subscriber bug), then a `since=` backfill. An engine that does not
 *     answer the subscribe degrades to polling with a visible note — the page
 *     never breaks on it.
 */
const BUILD = '2026-09-29-ios-keyboard';
console.log(`[room] build ${BUILD}`); // bump per change — a stale window shows an old tag

import { enteringShell } from '/ipad-shell-gate.mjs'; // a touch tablet's room hands itself to the shell's tab strip (first, so nothing else starts) [ipad tabs]
import { createTransport } from '/transport.mjs';
import { hwbRing, hwbRingFromChrome, hwbRingLabel, hwbRingLead } from '/aurora/window-chrome/hwb-ring.js';
import { brandMarkPath } from '/aurora/brand-marks/aurora-brand-marks.js';
import { loadBrands, brandFor } from '/brand.mjs';
import { openAddSheet } from '/room-add-sheet.mjs'; // the room's + sheet (the design system room-add-sheet-v1)
import { sanitizeSvg } from '/logo-modal.mjs';
import { mountCells, setUserTones, cellTone } from '/room-cells.mjs';
import { mountPreview } from '/room-preview.mjs';
import { heldWord } from '/held-words.mjs';
import { quotedRanges, inQuote } from '/room-reply-all.mjs'; // QUOTED TEXT is not an address (Owner [ref])
import { tabSuggestion } from '/room-tab-continue.mjs'; // Tab continues the last @address (Owner 2026-10-02, room line [ref])
import { mountAttach } from '/room-attach.mjs'; // composer attachments [ticket]
import { docKind, createDocView } from '/room-doc-view.mjs'; // markdown / text files open as documents [ticket]
import { openBrief, briefButton } from '/room-brief.mjs'; // the room's info flyout [room brief] Owner 2026-10-05
import { mountScratchpad, isAssetsPanel, lineText, fromEngineCounts } from '/room-scratchpad.mjs';
import { createScratchView } from '/room-scratchpad-view.mjs'; // its lists and one-item views in the preview column [scratchpad] // the left bar's Scratchpad cell, where Assets was [scratchpad]
import { createPlaces } from '/room-places.mjs'; // the Workbench chip's sheet: Full Workbench, the other rooms, live agents [workbench sheet]
import { mountSiteBar } from '/room-site-bar.mjs'; // the Basic edition's Preview / Public bar in a site room [basic]
import { copyText } from '/room-app-port.mjs';
import { lineWhen } from '/time-format.mjs';
import { ensureMarkdown, onMarkdownReady, markdownReady, renderLineMarkdown, hasMarkup } from '/room-line-markdown.mjs'; // chat lines as Markdown [line markdown]
import { getSwitchMode } from '/app-behavior-pref.mjs'; // what the right-hand app does when you switch room [room switch]
import { loadEdition, isBasic } from '/edition.mjs'; // Basic hides workgroups, Assemble, voice rooms and the Room cell [basic]
import { createSeatMenu, createMenuHost, menuToast, svg as menuSvg } from '/room-seat-menu.mjs';
import { toast as roomToast } from '/room-toast.mjs';
import { onEnterSubmits, attachSendMenu, enterAction } from '/enter-pref.mjs';
import { mountNotes, hasWords } from '/room-notes.mjs'; // NOTES [ticket]: the editor, the + menu, move-draft, the panel seam
import { KEYS as CLI_KEYS } from '/keypad-keys.mjs'; // the CLI special keys, one list (rail Keys block) [ipad keys]
import { lineTime } from '/time-format.mjs'; // the one clock for every line (the chat and search use it too) [time format]
import { openSearch } from '/search-ui.mjs'; // search this room: popover on a PC, a full-screen sheet on a phone [search ui]
import { mountDialogKeyboard } from '/dialog-keyboard.mjs'; // a dialog's text field stays above the soft keyboard [dialog kb]
import { mountTouchUi } from '/touch-ui.mjs'; // html.touch-wide: touch controls follow the input, not the width [touch-wide]
import { workgroupsGroup } from '/room-workgroups-settings.mjs'; // Room settings -> Workgroups (main room) [wg settings]
import { openRoomColor } from '/room-color-room.mjs'; // Color... on a workgroup row [workgroup design]
import { openDissolveRoom } from '/room-dissolve-room.mjs'; // Dissolve group... on a workgroup row [dissolve workgroup]
import { openRenameRoom } from '/room-rename-room.mjs'; // Rename... on a room row [rename workgroup]
import { createPanelMenu } from '/room-panel-menu.mjs'; // the panel cell menu (the design system room-add-sheet-v1 §4)
import { mountFilter } from '/room-filter.mjs'; // the line filter button (the design system room-filter-v1)
import { mountRail, mountPreviewResize, mountPreviewDrawer } from '/room-rail.mjs'; // the resizable left + preview columns (the design system room-rail-resize-v1)
import { youGlyph } from '/you-settings.mjs'; // your picture/monogram glyph (edited in global Settings now)
import { cleanVoice, paintBadge, paintStatus, voiceGlyph, voiceHeadNodes, voiceNotesNode, voiceSettingsGroup } from '/room-voice.mjs';
import { mountReply } from '/room-reply.mjs'; // REPLY TO A LINE (the design system room-reply-v1)
import { approvalAsk, approvalAnswered, approvalPlate } from '/room-approval.mjs'; // [approval ask] Approve / Cancel under an agent's APPROVAL: line
/* ROOM CHARACTER [rooms/character] (the design system room-character v1.1): art + wash + accent */
import { paintRoomCharacter, characterMark, artSettingsGroup, markStyle } from '/room-character.mjs';
import { roomLookGroups } from '/room-art-settings.mjs'; // Room settings: Art, Palette, Room color [hub-v2]
import { paintTile } from '/room-tile.mjs';
import { setWashPrefs } from '/room-wash.mjs';
import { setGlobalPref } from '/room-palette.mjs';
/* ROOM ART BY REFERENCE [perf/poll-traffic]: the poll carries the art's key + hash, not its SVG */
import { hydrateArt, rememberArt } from '/art-cache.mjs';
import { tickDeviceReport } from '/device-report.mjs'; // user device presence rides this page's poll [user device presence]
import { mentionsIn, factIsToMe } from '/fact-mentions.mjs'; // which room facts are To me [to-me facts]
import { toMeFlags, isToMe } from '/to-me.mjs'; // THE To-me rule, one module: the engine's GET .../line?to=me reads the same one
import * as slash from '/slash-list.mjs'; // the "/" command list [slash list]
import { isHidden, onVisibility } from '/page-visibility.mjs'; // [perf/poll-traffic] pause while not on screen
import { linkNodes } from '/room-links.mjs'; // LINKS IN LINES (Owner 2026-09-28)
import { relayExternal } from '/open-external.mjs'; // LINKS IN LINES: a seat's solo page hands its links up
import { mountToolLinks } from '/room-tool-links.mjs'; // LINE LINKS INTO A TOOL VIEW [rooms/tool-links]
import { mountImageLinks } from '/room-image-links.mjs'; // IMAGE LINKS IN LINES: an image URL as an inline thumbnail
import { installZoomGuard } from '/zoom-guard.mjs'; // undo a tool frame's iOS focus zoom (Owner 2026-10-03, IMG_7709/7710)
import { installRoomFrame } from '/room-frame.mjs'; // THE FRAME LOCKED TO THE GLASS on a phone [web/room-ios-lock]
import {
  outgoingTargets, outgoingTag, isOutgoingOnly, incomingHandles, foldIncoming, noticeRooms, familyNoticeRooms, noticeRaise, unreadSnapshot, waitingRooms, noticeSummary, waitingText, toastNames, stripHidden, placeholderFor, roomHref, seatsTitle, roomChatMeta, mainRoomMeta, chooseText, waitingLabel,
} from '/room-workgroups.mjs'; // WORKGROUPS (Owner 2026-10-04): cross-posts, the notice, the crumb, the composer's words
void enteringShell; // evaluated for its side effect: on a touch tablet it never settles, so this page does not start [ipad tabs]

const POLL_MS = 2500; // the manager's cadence (§2.3: room.state is not pushed on member activity)
const HIDDEN_POLL_MS = 15000; // a hidden tab's slow poll: keeps its shell ring roughly current
const PAGE = 50; // newest-N on load, and each back page
let lineUnpin = () => {}; // set by the line's pin tracker: a deliberate jump (search) leaves the bottom [search ui]
const FORWARD_PAGE = 200;
const SUBSCRIBE_WAIT_MS = 3000; // no `room.subscribed` by then = this engine has no push
const KINDS = ['chat', 'fact', 'delivery', 'attachment', 'command', 'voice'];

const $ = (id) => document.getElementById(id);
const roomId = new URLSearchParams(location.search).get('room');
/* first, before anything lays out: the clamp, the zoom blockers, the keyboard,
   the viewport report (web/room-frame.mjs) */
installRoomFrame({ build: BUILD, roomId });
installZoomGuard({
  /* one line on the existing viewport diag so a fire shows on Owner's phone */
  onReset: (r) => navigator.sendBeacon?.('/api/diag/viewport', new Blob([JSON.stringify({ page: 'room', build: BUILD, room: roomId, ...r })], { type: 'application/json' })),
});
let filterUi = null; // the line filter button (room-filter.mjs), mounted at boot

let paintWgs = null; // Room settings' Workgroups section repaint (set by settingsBody)
let paintInherit = null; // the workgroup settings' "From the main room" repaint (set by inheritGroup)
const state = {
  room: null,
  seats: [], // active seats, as the engine derived them
  entries: new Map(), // id -> entry
  minId: null,
  maxId: null,
  atStart: false,
  loaded: false, // the newest page has landed; before that a backfill has no cursor
  push: 'pending', // pending | live | unavailable
  hiddenKinds: new Set(),
  seatFilter: '',
  pendingConfirm: null, // {text, token}
  sel: 'room', // the left column's selection: 'room' or a seat id (nav v3)
  roomSeen: null, // the newest entry id when the room row was last selected
  actions: [], // the ROOM's cycle actions, engine-derived: disconnect | reconnect
  cycling: false, // a disconnect / reconnect is running
  feedApplied: false, // the room's default feed was applied on first load
  me: null, // {name, picture}: YOUR glyph beside your lines (GET /api/rooms/me)
  voice: null, // the engine's voice state (room view top-level `voice`, §15)
  voiceGlobal: null, // {enabled}: the user's global voice switch (room view top-level `voiceGlobal`)
  family: null, // WORKGROUPS: {parent, workgroups[]} with this person's unread per room (room view `family`)
  unreadPrev: null, // family unread at the last look (Map id -> n); null until the first, which raises nothing
  noticeDismissedKey: null, // phone: the newest line id (else line total) the person dismissed the strip at; anything newer brings it back
  unreadAll: null, // GET /api/rooms/me/unread rows: every open room's unread (cross-family alert); null = not read yet / unavailable
};

/* ------------------------------------------------------------------ http ---- */

async function api(path, opts = {}) {
  const init = { method: opts.method ?? 'GET', headers: {} };
  if (opts.signal) {
    init.signal = opts.signal; // a stale search answer is abandoned [search ui]
  }
  if (opts.json !== undefined) {
    init.method = opts.method ?? 'POST';
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.json);
  }
  const res = await fetch(path, init);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not json */
  }
  return { status: res.status, ok: res.ok, body };
}

/* --------------------------------------------------------------- roster ---- */

/** Seat -> ring spec, or null when the state has no glyph yet (never-started,
 *  empty: §4.4 gives them TEXT and no ring). Same rule as the manager's
 *  ringSpecFor: lifecycle first, activity only while live, so a dead session can
 *  never render as busy. */
/** THE one seat -> chrome-state mapping. The roster ring, the member TAB in
 *  the shell and the room tab's loudest-member state all come from it, so the
 *  surfaces can never disagree (the design system, item 3 review FAIL-1). */
function seatChrome(seat) {
  /* STARTING = work in progress, nothing to answer yet: the ruled AB·B
     active-background segment, not ended's dim ring (the design system NOTE-2) */
  if (seat.status === 'starting') {
    return 'background';
  }
  const o = seat.occupant;
  return !o ? 'ended' : o.state === 'live' ? o.activity || 'idle' : o.state === 'dehydrated' ? 'restorable' : 'ended';
}

function seatRingSpec(seat) {
  if (seat.status === 'never-started' || seat.status === 'empty') {
    return null;
  }
  const o = seat.occupant;
  return hwbRingFromChrome(seatChrome(seat), { attached: !!o?.attached, exit: o?.exit });
}

const STATUS_TEXT = {
  live: 'live',
  parked: 'parked — no window',
  dehydrated: 'restorable',
  ended: 'ended',
  'never-started': 'never started',
  empty: 'empty',
  starting: 'starting…',
};

/** The policy as the roster says it. Transient is a DECISION (wr §2.7), and the
 *  roster must be able to say so out loud. */
function policyLabel(seat) {
  if (seat.policy === 'persistent') {
    return 'persistent';
  }
  return `${seat.policy} · forgets by design`;
}

function leadIdOf(room, seats) {
  if (room?.lead_seat) {
    return room.lead_seat;
  }
  return seats.find((s) => s.is_lead)?.id ?? null;
}

/** Lead FIRST whatever its position (§1.2: forced at read time), then position. */
function orderSeats(room, seats) {
  const lead = leadIdOf(room, seats);
  return [...seats]
    .filter((s) => s.left_at === null || s.left_at === undefined)
    .sort((a, b) => (a.id === lead ? -1 : b.id === lead ? 1 : (a.position ?? 0) - (b.position ?? 0)));
}

function brandMark(vendor) {
  const b = brandFor(vendor || 'unknown');
  const el = document.createElement('span');
  el.className = 'seat-mark';
  el.dataset.brand = b.brand;
  el.title = b.label;
  if (b.brandColor) {
    el.style.setProperty('--brand-src', b.brandColor);
  }
  el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="${brandMarkPath(b.brand)}"/></svg>`;
  return el;
}

/* NEVER STARTED / EMPTY: the brand PLATE with the ended dimming and NO ring
 * (nuc1 ruling 2026-09-25 on the design system FAIL-4b: the plate is identity, known
 * before the first start; a ring is lifecycle, and there is none yet). Drawn
 * by window-chrome v25's plate-only mode, which answers data-state="none".
 * An older bundle cannot draw it (it throws or paints an ended ring), so the
 * page falls back to the plain mark: never a ring for a seat with no
 * lifecycle, whichever bundle is pinned. */
function plateOrMark(seat, isLead, size = 22) {
  const b = brandFor(seat.vendor || 'unknown');
  const plate = document.createElement('span');
  plate.className = 'seat-plate';
  try {
    hwbRing(plate, null, size, { brand: b.brand || 'generic', markPath: brandMarkPath(b.brand || 'generic'), primary: isLead });
  } catch {
    /* pre-v25: hwbRing has no plate-only mode */
  }
  if (plate.dataset.state !== 'none') {
    return brandMark(seat.vendor);
  }
  if (b.brandColor) {
    plate.style.setProperty('--brand-src', b.brandColor);
  }
  plate.dataset.brand = b.brand;
  plate.title = `not started · ${b.label}`;
  return plate;
}

/* ---------------------------------------------------------- seat actions ---- */

/* The ENGINE decides which action a seat offers (seat.actions, §2.9); the page
 * draws it and never derives one. ROOM NAV v3 (Owner 2026-09-26): there is no
 * Open any more — SELECTING the row is open, and a seat never adds a window
 * tab. start / rehydrate = POST .../seats/:id/start with a browser-tab
 * placement (the engine hands back the path and places nothing: this page
 * frames it), then the seat is selected. */
/* The engine's verb is 'rehydrate'; the word a person sees is RESTORE, the
   CLI Manager's own word for the same act on a dehydrated session, and the
   ring's state is "restorable" (the design system, item 6 review FAIL-1: one act, one word). */
const ACTION_LABEL = { rehydrate: 'Restore', start: 'Start' };
const ACTION_TIP = {
  rehydrate: 'restore this seat\'s session: it comes back where it left off',
  start: 'start this seat\'s project in a new session and seat it here',
};

/* ------------------------------------------------------------- held ---- */

/* Room lines waiting to be TYPED into this seat's session (workrooms-build
 * §2.10, occupant.held). Quiet when the engine is only waiting its turn
 * (busy, settling, startup…); actionable when the block is a DRAFT, because
 * that is the one a person can clear: "I looked at the composer, it is empty".
 * The deliver route takes the window's cookie and never a bearer (the agent
 * whose pane it is must never declare its own composer clear); this page's
 * fetches send no Authorization header, so that is what it gets. */
const HELD_WHY = {
  draft: 'an unsent draft in its input box',
  'no-claude': "claude isn't running in it",
  restarting: 'it is restarting onto the channel',
  busy: 'it is busy',
  startup: 'it is still starting up',
  'waiting-for-tools': 'Codex is loading its room tools (up to 30 seconds)',
  'needs-you': 'its screen shows a prompt only you can answer — open its tab',
  'not-idle': 'it is not idle',
  settling: 'it is settling',
  'awaiting-idle': 'waiting for the previous message to land',
  'not-live': 'it is not live',
  pending: 'waiting its turn',
};

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

/** The held TEXT for the row's status line ("2 held · draft · 3m") and its
 *  tooltip. "held", never "waiting": in the chrome vocabulary waiting means
 *  blocked on YOU (the design system, item 7 Q3). There is no Deliver here any more: it
 *  asserts the input box is empty, so it lives where the box is visible, in
 *  the seat's own held line under its CLI (the design system room-nav-v3). */
function heldParts(seat) {
  const h = seat.occupant?.held;
  if (!h || !(h.depth > 0)) {
    return null;
  }
  const since = typeof h.since === 'number' ? ` · ${ago(h.since)}` : '';
  /* no-claude + detail not-interactive: a claude IS on the terminal, but not
     as the session (claude update, print mode) — nuc1's S0 vocabulary */
  const notInteractive = h.reason === 'no-claude' && h.detail === 'not-interactive';
  const text = `${h.depth} held · ${heldWord(h)}${since}`;
  /* startup names the KIND of question that is up (occupant.startup.prompt,
     or held.prompt); "unknown" = the engine could not watch that claude start */
  const kind = seat.occupant?.startup?.prompt || h.prompt;
  const why = notInteractive ? 'a claude is running here but not as its interactive session'
    : h.reason === 'startup' && kind === 'unknown' ? 'the engine could not see this claude start'
      : h.reason === 'startup' && kind ? `a ${kind} question is up in its window`
        : HELD_WHY[h.reason] ?? h.reason;
  const title = `${h.depth} room message${h.depth === 1 ? '' : 's'} held, not yet typed into @${seat.handle}: ${why}`;
  return { text, title, reason: h.reason };
}

/* NEEDS YOU [ticket/1886] (Owner 2026-09-30: "Owner watches rooms, not tabs").
 * The seat's session is stuck on a prompt only a human answers — its /login
 * screen, a permission dialog, a question picker (occupant.blocked, from the
 * engine's prompt-block). Said on the seat, with why, and a pointer to where
 * it can be answered: its tab (the seat menu's Open window). Never answered
 * from here — the page only opens the window. */
const BLOCKED_TIP = {
  login: 'its session is asking you to log in (/login)',
  permission: 'its session is waiting for you to approve or deny a tool',
  question: 'its session asked you a question and is waiting for the answer',
  limit: 'its session hit the usage limit and is asking what to do (wait for the reset, or switch to usage credits)',
};
function blockedReason(seat) {
  const b = seat?.occupant?.state === 'live' ? seat.occupant.blocked : null;
  return b && typeof b.reason === 'string' ? b.reason : null;
}
function needsYouChip(seat) {
  const why = blockedReason(seat);
  if (!why) {
    return null;
  }
  const chip = document.createElement('div');
  chip.className = 'seat-needs';
  chip.dataset.reason = why;
  const t = document.createElement('span');
  t.className = 'seat-needs-t';
  t.textContent = `needs you: ${why}`;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'seat-needs-open';
  b.textContent = 'open its tab';
  b.title = `@${seat.handle}: ${BLOCKED_TIP[why] ?? why} — open its window to answer it`;
  b.addEventListener('click', (ev) => {
    ev.stopPropagation(); // the button opens; the row around it selects
    void openSeatWindow(seat);
  });
  chip.title = b.title;
  chip.append(t, ' · ', b);
  return chip;
}

const SVGNS = 'http://www.w3.org/2000/svg';
/** the phone's icon for a seat action: the menu's stroke style (restore = a
 *  counter-clockwise arrow, start = a play triangle) */
function seatActIcon(a) {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'seat-act-i');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVGNS, 'path');
  path.setAttribute('d', a === 'start' ? 'M7 5v14l12-7z' : 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5');
  svg.append(path);
  return svg;
}

function seatActionButton(seat) {
  const a = Array.isArray(seat.actions) ? seat.actions[0] : undefined;
  if (!a || !ACTION_LABEL[a]) {
    return null;
  }
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'seat-act';
  b.dataset.act = a;
  /* the word stays (desktop shows it; a phone shows the icon and the word is
     the accessible name, "Restore @name"); phone CSS swaps which one paints */
  const t = document.createElement('span');
  t.className = 'seat-act-t';
  t.textContent = ACTION_LABEL[a];
  b.append(t, seatActIcon(a));
  b.setAttribute('aria-label', `${ACTION_LABEL[a]} @${seat.handle}`);
  b.title = ACTION_TIP[a];
  b.addEventListener('click', (ev) => {
    ev.stopPropagation(); // the button acts; the row around it selects
    void seatAct(seat, a, b);
  });
  return b;
}

async function seatAct(seat, a, btn) {
  btn.disabled = true;
  try {
    const r = await api(`/api/rooms/${encodeURIComponent(roomId)}/seats/${encodeURIComponent(seat.id)}/start`, {
      json: { target: 'tab', surface: 'browser' },
    });
    if (!r.ok) {
      showReply('error', (el) => {
        el.textContent = `@${seat.handle} not started — ${r.body?.error ?? `HTTP ${r.status}`}`;
      });
      return;
    }
    addEntries(r.body?.entries);
    await fetchRoom();
    select(seat.id, { focus: true, url: r.body?.path || null });
  } catch (e) {
    showReply('error', (el) => {
      el.textContent = `@${seat.handle} not started — ${e?.message ?? e}`;
    });
  } finally {
    btn.disabled = false;
  }
}

/* THE SEAT MENU (the design system room-seat-menu-v1, web/room-seat-menu.mjs): Open
   window · Restore|Start · Disconnect · Rename · Remove, on a right-click, the
   row's ⋯, Shift+F10 / Menu or a long press. These are its hooks; it holds
   the roster redraw while it is up (seatMenu.holding()). */
const seatMenu = createSeatMenu({
  roomId,
  api,
  room: () => state.room,
  seat: (id) => state.seats.find((s) => s.id === id),
  seats: () => state.seats, // the reload card watches for the seat's occupant changing [reload progress]
  leadId: () => leadIdOf(state.room, state.seats),
  entries: () => state.entries.values(),
  act: (seat, a, btn) => seatAct(seat, a, btn),
  openWindow: (seat) => void openSeatWindow(seat),
  applied: async (body) => {
    addEntries(body?.entries);
    await fetchRoom();
  },
  disconnected: (seatId) => {
    dropFrame(seatId); // its solo page's Relaunch would start FRESH
    if (state.sel === seatId) {
      select(seatId); // the panel with its Restore
    }
  },
  /* THIS ROOM'S OWN VIEW of a seat counts for Close window when it is the
     only thing showing it (Owner 2026-09-29; reverses "a room frame is not a
     window" for THIS page's frame only, never another device's room view).
     Closing drops the frame, returns to the room line, and the engine's
     close-window has already parked the session (never the reaper). */
  ownFrame: (seatId) => frames.has(seatId),
  closeOwnFrame: (seatId) => {
    dropFrame(seatId);
    if (state.sel === seatId) {
      select('room');
    }
  },
  error: (text) => showReply('error', (el) => {
    el.textContent = text;
  }),
  redraw: () => renderRoster(),
  /* MOVE TO WORKGROUP... (Owner 2026-10-04, item 4): the family's other rooms */
  noWorkgroups: () => isBasic(),
  canSwitch: () => isBasic(), // Switch assistant (Claude or Codex) is a Basic seat verb [basic]
  moveTargets: () => {
    const f = state.family;
    const out = [];
    if (state.room?.parent_id && f?.parent) {
      out.push({ id: f.parent.id, name: f.parent.name, alias: f.parent.alias, main: true });
    }
    for (const w of f?.workgroups ?? []) {
      if (w.id !== roomId && w.state !== 'archived') {
        out.push({ id: w.id, name: w.name, alias: w.alias, main: false });
      }
    }
    return out;
  },
});

/* ==== PANEL CELL MENU (the design system room-add-sheet-v1 §4, web/room-panel-menu.mjs) ====
   Rename · Move up / down · Collapse · Remove, on a panel cell's header (and a
   phone sheet's app row). The seat menu's component; these are its hooks. */
const appNames = new Map(); // app slug -> its catalog name (the menu's title row)
/* LINE LINKS [rooms/tool-links]: the whole catalog entry (status, rooms, icon,
   links_meta) — a link's chip derives its availability from it. null until
   the first answer. */
let appCatalog = null;
let appNamesAt = 0;
function loadAppNames() {
  if (Date.now() - appNamesAt < 30000) {
    return;
  }
  appNamesAt = Date.now();
  api('/api/apps').then((r) => {
    if (!r.ok) {
      return;
    }
    const cat = new Map();
    for (const a of Array.isArray(r.body?.apps) ? r.body.apps : []) {
      appNames.set(a.slug, a.name || a.slug);
      cat.set(a.slug, a);
    }
    appCatalog = cat;
    toolLinks?.refresh();
  }).catch(() => {});
}
const panelMenu = createPanelMenu({
  roomId,
  api,
  panels: () => cells?.list() ?? [],
  collapsed: (id) => cells?.collapsed(id) ?? false,
  setCollapsed: (id, v) => cells?.setCollapsed(id, v),
  headerOf: (id) => cells?.headerOf(id) ?? null,
  appName: (slug) => {
    if (!appNames.has(slug)) {
      loadAppNames();
    }
    return appNames.get(slug) ?? null;
  },
  applied: async (body) => {
    addEntries(body?.entries);
    await fetchRoom();
  },
  error: (text) => showReply('error', (el) => {
    el.textContent = text;
  }),
  redraw: () => renderPhone(),
});
/* ==== /PANEL CELL MENU ==== */

/* Open window: the seat's LIVE pane in a window of its own (the CLI Manager's
   "Open window": the engine places it and never opens a second view of one
   pty). Viewed from another machine the engine's desktop is not yours, so the
   solo page opens as a browser tab here, synchronously in the click's turn. */
const REMOTE = !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(location.hostname);
async function openSeatWindow(seat) {
  const url = seatUrl(seat);
  if (REMOTE && url) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  try {
    const r = await api(`/api/recipes/${encodeURIComponent(seat.recipe_id)}/launch`, { json: { pane: seat.occupant?.id } });
    if (!r.ok) {
      throw new Error(r.body?.error ?? `HTTP ${r.status}`);
    }
    if (r.body?.placement === 'browser' && (r.body.path || url)) {
      window.open(r.body.path || url, '_blank', 'noopener'); // no desktop: the url is in the reply
    }
  } catch (e) {
    showReply('error', (el) => {
      el.textContent = `@${seat.handle}: no window opened — ${e?.message ?? e}`;
    });
  }
}

/* ------------------------------------------------ the left column (nav v3) ---- */

/* ROOM NAV v3 (Owner 2026-09-26, the design system room-nav-v3): level 2 is this LEFT
 * COLUMN. The ROOM row first (selected on entry), then every seat, lead first.
 * Selecting a row swaps the right column: the line for the room, that seat's
 * solo page for a seat. Rows carry STATE (ring, status, held, unread count),
 * because the ring is how you see who needs you without reading. */

/** The room's loudest member, by the bundle's own ranking (hwbRingLead). */
function loudState() {
  const seats = orderSeats(state.room, state.seats);
  const i = hwbRingLead(seats.map(seatRingSpec));
  return i >= 0 ? seatChrome(seats[i]) : 'idle';
}

/** Room lines that landed since the room row was last looked at (not yours). */
function roomUnread() {
  if (state.sel === 'room' || state.roomSeen === null) {
    return 0;
  }
  let n = 0;
  for (const e of state.entries.values()) {
    if (e.id > state.roomSeen && !(e.author === 'user' && !e.author_seat)) {
      n++;
    }
  }
  return n;
}

/* ==== REPLY / SEAT BADGE (Owner 2026-09-28) ================================
 * The badge counts only lines REALLY waiting for this seat's agent: held or
 * queued by the typer, or typed in with the turn not started. The engine
 * serves them per seat (`waiting: {count, ids}`, room-reads waitingFor); a
 * line handed to the pane's fabric CHANNEL is not among them, though its
 * per-line marker still says "not yet". A room.read push that moves one of
 * the ids on (seen / can't tell) drops it here at once, before the next GET.
 * An engine without `waiting` falls back to the old per-line count. */
function seatUnread(seat) {
  const w = seat.waiting;
  if (w && Array.isArray(w.ids)) {
    let n = 0;
    for (const id of w.ids) {
      const st = state.entries.get(id)?.reads?.[seat.handle];
      if (st === undefined || st === 'not-yet') {
        n++;
      }
    }
    return n;
  }
  let n = 0;
  for (const e of state.entries.values()) {
    if (e.reads && e.reads[seat.handle] === 'not-yet') {
      n++;
    }
  }
  return n;
}
/* HELD + BADGE PUSHES (Owner 2026-09-28: "N held" and the badge must move the
 * moment a held line clears, not on the next poll). The engine pushes
 * `room.held` {seatId, held} (the typer's queue moved) and `room.waiting`
 * {seatId, waiting} (the badge set moved); this patches THAT seat's row in
 * place — the same renderSeatRow the roster uses, so the two cannot differ. */
function patchSeat(seatId, change) {
  const seat = state.seats.find((s) => s.id === seatId);
  if (!seat) {
    return;
  }
  change(seat);
  const old = $('roster').querySelector(`.seat[data-seat-id="${CSS.escape(seatId)}"]`);
  if (old && !seatMenu.holding()) { // a menu / rename / Remove dialog keeps its row (the next render has it)
    const tmp = document.createElement('ol');
    renderSeatRow(tmp, seat, leadIdOf(state.room, state.seats));
    const row = tmp.firstElementChild;
    if (row) {
      const hadFocus = document.activeElement === old;
      old.replaceWith(row);
      if (hadFocus) {
        row.focus({ preventScroll: true });
      }
    }
  }
  renderPhone(); // the phone's Agents sheet shows the same row
  repaintReads(); // held -> delivered -> seen under the bubbles [web/room-phone-7]
}
function onSeatHeld(m) {
  if (m.roomId !== roomId || typeof m.seatId !== 'string') {
    return;
  }
  patchSeat(m.seatId, (seat) => {
    if (seat.occupant) {
      if (m.held && typeof m.held === 'object') {
        seat.occupant.held = m.held;
      } else {
        delete seat.occupant.held;
      }
    }
  });
  watchHeld(state.seats); // a drop re-reads the line (its read state moves next)
}
function onSeatWaiting(m) {
  if (m.roomId !== roomId || typeof m.seatId !== 'string' || !m.waiting || !Array.isArray(m.waiting.ids)) {
    return;
  }
  patchSeat(m.seatId, (seat) => {
    seat.waiting = { count: m.waiting.ids.length, ids: m.waiting.ids };
  });
}
/* ==== /REPLY / SEAT BADGE ================================================== */

function roomGlyph(size) {
  const ring = document.createElement('span');
  ring.className = 'seat-ring';
  hwbRing(ring, hwbRingFromChrome(loudState(), { attached: false }), size, { workroom: true });
  ring.title = `the room · loudest member: ${loudState()}`;
  return ring;
}

function seatGlyph(seat, lead, size) {
  const spec = seatRingSpec(seat);
  if (!spec) {
    return plateOrMark(seat, seat.id === lead, size);
  }
  /* v21: every ring on its session's brand plate (the manager's rule) */
  const ring = document.createElement('span');
  ring.className = 'seat-ring';
  const b = brandFor(seat.vendor || 'unknown');
  /* primary = B5, the lead's old-gold plate edge (window-chrome v23+) */
  hwbRing(ring, spec, size, { brand: b.brand, markPath: brandMarkPath(b.brand), primary: seat.id === lead });
  if (b.brandColor) {
    ring.style.setProperty('--brand-src', b.brandColor);
  }
  ring.dataset.brand = b.brand;
  ring.title = `${hwbRingLabel(spec)} · ${b.label}`;
  return ring;
}

function countBadge(n, title) {
  const c = document.createElement('span');
  c.className = 'seat-count';
  c.textContent = String(n);
  c.title = title;
  return c;
}

function rowShell(id, label) {
  const li = document.createElement('li');
  li.className = 'seat';
  li.dataset.seatId = id;
  li.tabIndex = 0;
  li.setAttribute('role', 'option');
  li.setAttribute('aria-label', label);
  li.setAttribute('aria-selected', String(state.sel === id));
  if (state.sel === id) {
    li.classList.add('sel');
  }
  li.addEventListener('click', (ev) => {
    if (ev.target.closest('button')) {
      return; // a row's own button acts; it does not select
    }
    select(id, { focus: true });
  });
  return li;
}

function renderRoomRow(list) {
  const li = rowShell('room', `${state.room?.name ?? 'Room'}: the room chat`);
  li.classList.add('is-room');
  const glyph = document.createElement('span');
  glyph.className = 'seat-glyph';
  glyph.append(roomGlyph(28));
  const top = document.createElement('div');
  top.className = 'seat-top';
  /* ONE NAME PER LEVEL [layers] (Owner 2026-10-07, the design system handoff 1.P): the room's name is the tab's and the room bar's; this row says what it IS,
     "Room chat". The (i) is on the bar only. The second line carries only what the badge at the right does not say: the chat's own count
     is the badge, so it is not repeated in words. */
  const name = document.createElement('span');
  name.className = 'seat-handle';
  name.textContent = 'Room chat';
  top.append(name);
  const meta = document.createElement('div');
  meta.className = 'seat-meta';
  const n = roomUnread();
  const wgN = (state.family?.workgroups ?? []).filter((w) => w.id !== roomId && w.state !== 'archived').reduce((a, w) => a + (w.unread > 0 ? w.unread : 0), 0);
  meta.textContent = isBasic() ? (n ? `${n} new` : '') : roomChatMeta(n, wgN); // Basic: the unread count or nothing, never "main room" [basic]
  li.append(glyph, top, meta);
  if (n) {
    const side = document.createElement('div');
    side.className = 'seat-side';
    side.append(countBadge(n, `${n} new in the room chat`));
    li.append(side);
  }
  /* THE ROOM ROW'S ... (Owner 2026-10-04, item 1a): "Add new
     workgroup", in a MAIN room (a workgroup holds none). Rename... on every room row [rename workgroup] Owner 2026-10-05. */
  if (state.room && state.room.state !== 'archived') {
    rowMore(li, state.room, [
      { a: 'ren', label: 'Rename\u2026', icon: 'ren' },
      ...(state.room.parent_id ? [] : [{ a: 'wg', label: 'Add new workgroup', icon: 'plus' }]),
    ]);
  }
  list.append(li);
}
const roomMenu = createMenuHost(); // the room row's ... menu
let briefIsOpen = false; // the brief flyout holds the rail redraw, like the rename dialog

/** [room brief] Owner 2026-10-05: open the flyout for room `r` ({id, name}) anchored at `anchor` (null = under the header).
 *  This page is the person's (cookie), who can always write a brief. In a workgroup the flyout links to the main room's. */
function showBrief(r, anchor) {
  if (briefIsOpen) {
    return;
  }
  briefIsOpen = true;
  /* ONE BRIEF PER ROOM FAMILY, the main room's (Owner 2026-10-05: "it's a little confusing having
     it at every level; only at the room level"): a workgroup shows its main room's brief. */
  r = briefRoomOf(r);
  openBrief({
    anchor,
    room: { id: r.id, name: r.name },
    headId: null,
    api,
    phone: isPhone(),
    touch: matchMedia('(hover: none)').matches || isPhone(),
    canSet: true,
    done: () => fetchRoom(), // the family's has_brief and the room read repaint
    closed: () => {
      briefIsOpen = false;
      if (anchor?.isConnected) {
        anchor.focus({ preventScroll: true });
      }
    },
  });
}
/** The room whose brief this room shows: its main room when it is a workgroup. */
function briefRoomOf(r) {
  const parent = state.family?.parent;
  if (r?.parent_id && parent && parent.id === r.parent_id) {
    return { id: parent.id, name: parent.name };
  }
  if (r?.parent_id) {
    return { id: r.parent_id, name: parent?.name ?? 'Main room' };
  }
  return r;
}
/** The (i) on the main room's row and beside the main room's name in the crumb (never on a workgroup). */
function briefBtn(r) {
  return briefButton(`Brief for ${r.name}`, (b) => showBrief(r, b));
}
let renameRoomOpen = false; // the Rename... dialog holds the rail redraw

/** The ... button + menu of a room row (main room, workgroup): Rename... [rename workgroup] Owner 2026-10-05 */
function rowMore(li, r, items) {
  li.classList.add('has-more');
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'rsm-more';
  more.setAttribute('aria-haspopup', 'menu');
  more.setAttribute('aria-expanded', 'false');
  more.setAttribute('aria-label', `More for ${r.name}`);
  more.innerHTML = menuSvg('more');
  more.addEventListener('click', (e) => {
    e.stopPropagation(); // the button acts; the row around it selects
    roomMenu.open({
      row: li,
      more,
      label: r.name,
      title: r.name,
      sub: state.family?.workgroups?.some((w) => w.id === r.id) || r.parent_id ? 'workgroup' : 'room',
      items,
      choose: (it) => {
        roomMenu.close(false);
        if (it.a === 'wg') {
          addMembers('room', 'workgroups');
        } else if (it.a === 'col') {
          /* Color... [workgroup design] Owner 2026-10-05: "a way to update the room color mark" */
          renameRoomOpen = true; // holds the rail redraw, like Rename
          openRoomColor({
            room: r,
            swatches: SWATCHES,
            api,
            touch: matchMedia('(hover: none)').matches || matchMedia('(max-width: 600px)').matches,
            done: () => fetchRoom(),
            closed: () => {
              renameRoomOpen = false;
              if (li.isConnected) {
                li.focus({ preventScroll: true });
              }
            },
          });
        } else if (it.a === 'dis') {
          renameRoomOpen = true; // holds the rail redraw, like Rename
          const parentName = state.family?.parent?.name ?? (state.room?.parent_id ? 'the main room' : state.room?.name ?? 'the main room'); // on the main room itself the family has no `parent`: the room IS the root
          const parentId = r.parent_id ?? state.family?.parent?.id ?? null;
          openDissolveRoom({
            room: r,
            parentName,
            api,
            touch: matchMedia('(hover: none)').matches || matchMedia('(max-width: 600px)').matches,
            /* CONFIRMED INSIDE THE GROUP (Owner [ref]): never stand in a group that is archived under you. Leave a one-shot note and go to the
               ROOT; the root page performs the dissolve and shows the toast there (runPendingDissolve). From any other page: direct call. */
            defer: r.id === roomId && parentId ? () => {
              try {
                sessionStorage.setItem(DISSOLVE_PENDING, JSON.stringify({ groupId: r.id, rootId: parentId, name: r.name, rootName: parentName, at: Date.now() }));
              } catch { /* no storage: fall through to a plain navigation, nothing is dissolved */ }
              location.href = roomHref(location.href, parentId);
            } : null,
            done: async (out) => {
              dissolvedToast(r.name, out, parentName);
              await fetchRoom();
            },
            closed: () => {
              renameRoomOpen = false;
              if (li.isConnected) {
                li.focus({ preventScroll: true });
              }
            },
          });
        } else if (it.a === 'ren') {
          renameRoomOpen = true;
          openRenameRoom({
            room: r,
            api,
            touch: matchMedia('(hover: none)').matches || matchMedia('(max-width: 600px)').matches,
            done: () => fetchRoom(), // rail, crumb and tab title all repaint from the room read
            closed: () => {
              renameRoomOpen = false;
              if (li.isConnected) {
                li.focus({ preventScroll: true });
              }
            },
          });
        }
      },
      closed: (back, refocus) => {
        if (refocus && back?.row?.isConnected) {
          back.row.focus({ preventScroll: true });
        }
      },
    });
  });
  li.append(more);
}

function renderSeatRow(list, seat, lead) {
  const li = rowShell(seat.id, `@${seat.handle}`);
  li.dataset.handle = seat.handle;
  li.dataset.status = seat.status;
  li.dataset.policy = seat.policy;
  if (seat.id === lead) {
    li.classList.add('is-lead');
  }
  const glyph = document.createElement('span');
  glyph.className = 'seat-glyph';
  glyph.append(seatGlyph(seat, lead, 28));
  li.append(glyph);

  const top = document.createElement('div');
  top.className = 'seat-top';
  const handle = document.createElement('span');
  handle.className = 'seat-handle';
  handle.textContent = `@${seat.handle}`;
  handle.dataset.full = handle.textContent;
  top.append(handle);
  if (seat.id === lead) {
    const badge = document.createElement('span');
    badge.className = 'seat-lead';
    badge.textContent = 'lead';
    top.append(badge);
  }
  if (!seat.handle_named) {
    /* wr §2.5b: a number says only that it was second — nudge a real name. */
    const nudge = document.createElement('button');
    nudge.type = 'button';
    nudge.className = 'seat-nudge';
    nudge.textContent = 'name me';
    nudge.title = `a placeholder handle — /rename @${seat.handle} to @<what this seat is>`;
    nudge.addEventListener('click', () => {
      select('room');
      setInput(`/rename @${seat.handle} to @`);
    });
    top.append(nudge);
  }
  li.append(top);

  /* ONE status line: the ring's words when it is an ALERT (the text and the
     ring must say the same thing), else the engine's status; a transient
     policy (a DECISION, wr §2.7) and the held text ride along. The rest of
     the old card (policy, pool, channel ✓, title) is the row's tooltip. */
  const meta = document.createElement('div');
  meta.className = 'seat-meta';
  const status = document.createElement('span');
  status.className = 'seat-status';
  const ringSpec = seatRingSpec(seat);
  status.textContent = ringSpec && ringSpec.state === 'alert'
    ? hwbRingLabel(ringSpec)
    : seatMenu.statusFor(seat) ?? STATUS_TEXT[seat.status] ?? seat.status;
  /* [ticket] WHICH MODEL is answering, read by the engine from the session's
     transcript tail on its title clock (~40s for live sessions), so an
     in-CLI /model switch shows too. Before the status, so it survives a
     narrow column's ellipsis on the end. */
  const om = seat.occupant?.model;
  if (om) {
    const mdl = document.createElement('span');
    mdl.className = 'seat-model';
    mdl.textContent = seat.occupant?.effort ? `${om} ${seat.occupant.effort}` : om;
    meta.append(mdl, ' · ');
  }
  meta.append(status);
  if (seat.policy !== 'persistent') {
    meta.append(` · ${seat.policy === 'pool' ? `pool ×${seat.pool_size ?? '?'}` : seat.policy}`);
  }
  const held = heldParts(seat);
  if (held) {
    const h = document.createElement('span');
    h.className = 'seat-held';
    h.dataset.reason = held.reason;
    h.textContent = held.text;
    h.title = held.title;
    meta.append(' · ', h);
  }
  li.append(meta);
  /* the seat's own git worktree, when it runs in one (Owner 2026-10-05, worktree
     convention): one quiet line, the path in the tooltip */
  const wt = seat.occupant?.worktree;
  if (wt && wt.branch) {
    const w = document.createElement('div');
    w.className = 'seat-worktree dim';
    w.textContent = `worktree ${wt.branch}`;
    w.title = wt.path || '';
    li.append(w);
  }
  const needs = needsYouChip(seat);
  if (needs) {
    li.append(needs);
  }
  const tip = [`@${seat.handle}`, seat.occupant?.title || seat.project, seat.occupant?.model ? `model: ${seat.occupant.model}${seat.occupant.effort ? ` (effort ${seat.occupant.effort})` : ''}` : null, policyLabel(seat)].filter(Boolean);
  if (seat.occupant?.channel === true) {
    tip.push('channel ✓ (room messages land in its session directly)');
  }
  li.title = tip.filter(Boolean).join(' · ');

  const n = seatUnread(seat);
  const act = seatActionButton(seat);
  if (n || act) {
    const side = document.createElement('div');
    side.className = 'seat-side';
    if (n) {
      side.append(countBadge(n, `${n} room message${n === 1 ? '' : 's'} to @${seat.handle} waiting (held, or typed in and not yet started)`));
    }
    if (act) {
      side.append(act);
    }
    li.append(side);
  }
  seatMenu.decorate(li, seat); // the ⋯, right-click, Shift+F10, long press
  list.append(li);
  requestAnimationFrame(() => fitSeatHandle(handle));
}

/* PHONE: a seat's @name takes the top line and WRAPS (never an ellipsis); only
   when it would need more than two lines (a 320px phone, a very long handle)
   is the MIDDLE cut ('@asset-p…rm2') so both ends - where similar names
   differ - survive. Full text stays in data-full, the row's title and aria. */
const HANDLE_MAX_LINES = 2;
function fitSeatHandle(el) {
  if (!el.isConnected || el.dataset.full === undefined) {
    return;
  }
  const full = el.dataset.full;
  el.textContent = full;
  if (!window.matchMedia('(max-width: 600px)').matches) {
    return;
  }
  const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
  const over = () => el.getBoundingClientRect().height > lh * HANDLE_MAX_LINES + 1;
  if (!over()) {
    return;
  }
  let keep = full.length - 1;
  while (keep > 4) {
    const head = Math.ceil(keep / 2);
    el.textContent = `${full.slice(0, head)}…${full.slice(full.length - (keep - head))}`;
    if (!over()) {
      return;
    }
    keep -= 1;
  }
}
window.addEventListener('resize', () => {
  for (const el of document.querySelectorAll('.seat-handle[data-full]')) {
    fitSeatHandle(el);
  }
});

/* ==== WORKGROUPS (Owner 2026-10-04, KB design-notes-id; web/room-workgroups.mjs) ====
 * A main room and its workgroups are a FAMILY. The rail lists the family under
 * the room row (a workgroup shows its main room above it), a click navigates
 * the same tab to that room, and a reply that lands in another room of the
 * family raises a transient notice (a toast over the line, never a chat line,
 * never delivered to a lead). The pill is this person's unread count, kept by
 * the engine per person per room; the cursor moves as they read here. */

/** A row that NAVIGATES to another room of the family (not a seat: no select). */
function navRow(list, r, kind, here = false) {
  const li = document.createElement('li');
  li.className = `seat is-${kind}${kind === 'head' ? ' is-room' : ''}${here ? ' sel' : ''}`;
  li.setAttribute('aria-selected', String(here));
  li.dataset.navRoom = r.id;
  li.tabIndex = 0;
  li.setAttribute('role', 'option');
  const label = kind === 'head' ? `${r.name}: the main room` : `${r.name}${r.alias ? ` @${r.alias}` : ''}: a workgroup`;
  li.setAttribute('aria-label', label);
  li.title = label;
  if (typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color)) {
    li.style.setProperty('--sc', r.color);
  }
  const glyph = document.createElement('span');
  glyph.className = 'seat-glyph';
  const plate = document.createElement('span');
  plate.className = 'sub-plate';
  glyph.append(plate);
  const top = document.createElement('div');
  top.className = 'seat-top';
  const name = document.createElement('span');
  name.className = 'seat-handle';
  name.textContent = kind === 'head' ? 'Room chat' : r.name; // no arrow (the design system hub v2): the plate says it is a room; the main room's row says what it is [layers]
  top.append(name);
  if (kind !== 'head' && r.alias) {
    const al = document.createElement('span');
    al.className = 'sub-alias';
    al.textContent = `@${r.alias}`;
    top.append(al);
  }
  li.append(glyph, top);
  if (kind !== 'head') {
    const meta = document.createElement('div');
    meta.className = 'seat-meta';
    const ns = typeof r.seats === 'number' ? ` · ${r.seats} seat${r.seats === 1 ? '' : 's'}` : '';
    meta.textContent = `${r.lead ? `lead @${r.lead}` : 'no lead yet'}${ns}`;
    li.append(meta);
  } else {
    const meta = document.createElement('div');
    meta.className = 'seat-meta';
    meta.textContent = mainRoomMeta(r.unread); // [layers] "Room chat" / "main room · 3 new"
    li.append(meta);
  }
  if (r.unread > 0) {
    const side = document.createElement('div');
    side.className = 'seat-side';
    side.append(countBadge(r.unread, `${r.unread} new in ${r.name}`));
    li.append(side);
  }
  const go = () => {
    if (here) {
      select('room'); // the row for the room you are in shows its chat [rail split]
      return;
    }
    goToRoom(r.id);
  };
  li.addEventListener('click', go);
  li.addEventListener('keydown', (ev) => {
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === li) {
      ev.preventDefault();
      go();
    }
  });
  list.append(li);
  return li;
}

/** THE ROOM CELL'S TREE, the same in every family room [rail split] (Owner 2026-10-05): the main room at the top,
 *  ALL its workgroups under it on one tree line, the room you are in drawn selected. */
function renderFamilyTree(list) {
  const inWg = !!state.room?.parent_id && !!state.family?.parent;
  if (inWg) {
    const head = navRow(list, state.family.parent, 'head');
    rowMore(head, state.family.parent, [{ a: 'ren', label: 'Rename\u2026', icon: 'ren' }]);
  } else {
    renderRoomRow(list);
  }
  const subs = (state.family?.workgroups ?? []).filter((w) => w.state !== 'archived');
  subs.forEach((w, i) => {
    const li = navRow(list, w, 'sub', w.id === roomId);
    if (i === subs.length - 1) {
      li.classList.add('is-last-sub');
    }
    rowMore(li, w, [
      { a: 'ren', label: 'Rename\u2026', icon: 'ren' },
      { a: 'col', label: 'Color\u2026', icon: 'col' },
      { a: 'dis', label: 'Dissolve group\u2026', icon: 'move', sub: 'seats return to the main room' }, // workgroups only [dissolve workgroup]
    ]);
  });
  list.closest('.rm-seats')?.classList.toggle('in-sub', inWg);
  list.querySelector(':scope > .seat.is-room')?.classList.toggle('has-subs', subs.length > 0); // the tree line starts under the main room's glyph
}

/** A push carries no person, so no unread: keep what the last read said. */
function keepUnread(next) {
  const was = new Map([...(state.family?.parent ? [state.family.parent] : []), ...(state.family?.workgroups ?? [])].map((r) => [r.id, r.unread]));
  for (const r of [...(next.parent ? [next.parent] : []), ...(next.workgroups ?? [])]) {
    if (r.unread === undefined && was.has(r.id)) {
      r.unread = was.get(r.id);
    }
  }
}

/** THE ROOM BAR [layers] (Owner 2026-10-07, the design system handoff 1.P): the TAB names the project (always the main room's own name, also with a
 *  workgroup open), so the bar does not repeat it: it says WHERE YOU ARE inside it, then the (i):
 *    main room:  "Main room · 5 seats · lead @product-lead"
 *    workgroup:  [plate] "Design @design · workgroup · lead @design · 2 seats"
 *  (a phone has no tab: its own header, #phName, keeps the project's name). */
function paintCrumb(room) {
  const el = $('roomName');
  const parent = state.family?.parent;
  const seats = orderSeats(room, state.seats);
  const lead = seats.find((x) => x.id === leadIdOf(room, state.seats));
  const nSeats = `${seats.length} seat${seats.length === 1 ? '' : 's'}`;
  const who = lead ? `lead @${lead.handle}` : 'no lead';
  /* the design system wording, exactly: the main room reads "seats · lead", a workgroup "workgroup · lead · seats" */
  const tail = room.parent_id ? ['workgroup', who, nSeats] : [nSeats, who];
  el.textContent = '';
  const sub = !!room.parent_id;
  if (sub) {
    const plate = document.createElement('span');
    plate.className = 'sub-plate sm';
    if (typeof room.color === 'string' && /^#[0-9a-f]{6}$/i.test(room.color)) {
      plate.style.setProperty('--sc', room.color);
    }
    el.append(plate);
  }
  const head = document.createElement('span');
  head.className = 'rn-a';
  head.textContent = sub || isBasic() ? room.name : 'Main room'; // Basic has no workgroups: "Main room" says nothing there, the site's name is what the person came for [basic]
  el.append(head);
  if (sub && room.alias) {
    const al = document.createElement('span');
    al.className = 'al';
    al.textContent = `@${room.alias}`;
    el.append(al);
  }
  const rest = document.createElement('span');
  rest.className = 'rn-b';
  rest.textContent = isBasic() ? ` · ${seats.length} agent${seats.length === 1 ? '' : 's'}` : ` · ${tail.join(' · ')}`;
  el.append(rest);
  el.append(briefBtn(sub && parent ? { id: parent.id, name: parent.name } : room)); // [room brief] the main room's, in a workgroup too
}

/** The composer names who plain typing reaches (this room's lead). */
function paintPlaceholder(room) {
  const lead = leadIdOf(room, state.seats);
  const ph = placeholderFor(room, lead ? seatHandle(lead) : null);
  if (ph && ph !== basePlaceholder) {
    basePlaceholder = ph;
    paintTabHint();
  }
}

/* THE NOTICE (Owner 2026-10-04; the design system hub v2, 2026-10-05), a split by device (isPhone, <=600px):
   - PC: the room's one TOAST (web/room-toast.mjs): "New message in [plate] Name" + Open, under the
     title bar, 8 s with its action, a pointer over it holds it. The rail's unread pill is the lasting
     signal there.
   - PHONE: a persistent "Waiting" strip ABOVE the message box: "Waiting messages in [plate] Name .
     View" for one workgroup, "Waiting messages in N workgroups . View" for several (View opens the
     people-and-rooms sheet, whose workgroup rows carry their unread badges). Derived from the per-person
     unread, so it clears by itself when you visit those rooms; its X hides it until the NEXT new
     message. One line that never runs off the screen.
   Never a chat line, never delivered to anyone's agent. */
/** The workgroup's plate, small, then its bold name: the one treatment everywhere a workgroup is named. */
function wgPlate(r) {
  const plate = document.createElement('span');
  plate.className = 'sub-plate sm';
  if (typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color)) {
    plate.style.setProperty('--sc', r.color);
  }
  return plate;
}
function wgName(r) {
  const n = document.createElement('span');
  n.className = 'wg-n';
  n.append(wgPlate(r), r.name);
  return n;
}
/** "View" with several rooms waiting is a CHOICE, not a guess [notice menu] (Owner 2026-10-06): a menu folds up from the notice
 *  (a bottom sheet on a phone, a popover under the toast on a PC) listing every room with new lines and its badge, newest
 *  first; picking one opens that room. One room waiting still goes straight there. */
/* SWITCHING ROOM OR WORKGROUP KEEPS THE RIGHT-HAND APP [room switch] (Owner 2026-10-08). The app open in the column is remembered by what it IS (its
   app slug, its view path and title: never by a room's panel id) and opened again in the new room's own panel for that app, once the new page has its
   panels. Setting "App behavior": 'stay' (default) re-opens the same view; 'reopen' opens the app at its home for the new room. A room without that app
   opens nothing. This is the reload-and-reopen form: the app is loaded again (its scroll and state are not kept); a switch in place is the next step. */
const SWITCH_APP_KEY = 'hwb.room.switchApp';
const SWITCH_APP_FRESH_MS = 20000;
function rememberSwitchedApp() {
  try {
    const v = cells?.snapshotView?.();
    if (v) {
      sessionStorage.setItem(SWITCH_APP_KEY, JSON.stringify({ ...v, from: roomId, mode: getSwitchMode(), at: Date.now() }));
    } else {
      sessionStorage.removeItem(SWITCH_APP_KEY);
    }
  } catch { /* no storage: the app simply does not carry over */ }
}
function goToRoom(id) {
  rememberSwitchedApp();
  location.href = roomHref(location.href, id);
}
let switchedAppDone = false;
function restoreSwitchedApp() {
  if (switchedAppDone || !cells) {
    return;
  }
  switchedAppDone = true; // once per page: later room pushes never reopen it
  try {
    const raw = sessionStorage.getItem(SWITCH_APP_KEY);
    sessionStorage.removeItem(SWITCH_APP_KEY);
    const m = raw ? JSON.parse(raw) : null;
    if (!m || typeof m.slug !== 'string' || m.from === roomId || Date.now() - Number(m.at) > SWITCH_APP_FRESH_MS) {
      return;
    }
    cells.openApp({ slug: m.slug, path: m.mode === 'reopen' ? '' : m.path, title: m.title });
  } catch { /* an unreadable memory is no memory */ }
}
function viewWaiting(anchor) {
  const items = waitingRooms(noticeList(), roomId);
  const cgN = state.cgUnread?.unread ?? 0; // [concierge] a row of its own when it has replied
  if (!items.length && !cgN) {
    return;
  }
  if (!cgN && items.length === 1 && !isPhone()) {
    goToRoom(items[0].id); // PC: one room waiting goes straight there. A PHONE shows the one row first, so you know where the tap takes you (Owner 2026-10-08)
    return;
  }
  const sum = noticeSummary(items);
  roomMenu.open({
    row: anchor,
    more: anchor,
    label: waitingLabel(sum),
    title: waitingText(sum),
    sub: chooseText(sum),
    items: [
      ...items.map((r) => ({ a: r.id, label: r.name, icon: 'move', sub: r.unread > 99 ? '99+' : String(r.unread) })),
      ...(cgN ? [{ a: '__concierge', label: 'Concierge', icon: 'move', sub: cgN > 99 ? '99+' : String(cgN) }] : []),
    ],
    choose: (it) => {
      roomMenu.close(false);
      if (it.a === '__concierge') {
        import('/concierge.mjs').then((m) => m.openConcierge()).catch((e) => console.warn('concierge failed', e));
        return;
      }
      goToRoom(it.a);
    },
  });
  for (const b of document.querySelectorAll('.rsm-menu .rsm-mi')) {
    const r = items.find((x) => x.id === b.dataset.a);
    if (r) {
      b.querySelector('svg')?.replaceWith(wgPlate(r)); // the room's plate, not a generic icon
      b.querySelector('.rsm-sub')?.classList.add('nm-badge');
    }
  }
}
/** The rooms the alert watches: every open room (the cross-family read), else this family's. */
function noticeList() {
  return state.unreadAll ? noticeRooms(state.unreadAll) : familyNoticeRooms(state.family);
}
/** Read every open room's unread (CROSS-FAMILY UNREAD [cross unread], Owner 2026-10-06). A failure leaves the family's own. */
async function fetchUnreadAll() {
  try {
    const r = await api('/api/rooms/me/unread');
    state.unreadAll = r.ok && Array.isArray(r.body?.rooms) ? r.body.rooms : null;
    state.cgUnread = r.ok ? (r.body?.concierge ?? null) : null; // [concierge] its own field, never a room
    import('/concierge.mjs').then((m) => m.setUnread(state.cgUnread)).catch(() => {});
  } catch {
    state.unreadAll = null;
  }
}
function raiseNotices() {
  const list = noticeList();
  const raised = noticeRaise(state.unreadPrev, list, roomId);
  state.unreadPrev = unreadSnapshot(list);
  if (raised.length && !isPhone()) {
    /* PC: "New in A, B +2 more", newest first; View goes to the room with the newest counted line */
    const { names, more } = toastNames(raised);
    const text = document.createDocumentFragment();
    text.append('New in ');
    names.forEach((r, i) => {
      if (i) {
        text.append(', ');
      }
      text.append(wgName(r));
    });
    if (more) {
      text.append(` +${more} more`);
    }
    roomToast(text, { action: { label: 'View', run: (btn) => viewWaiting(btn) } });
  }
  paintNotice();
}

/** PHONE: ONE strip above the message box for every other room with unread lines: "3 new in 2 teams" (rooms that stand alone say
 *  "rooms"; count only: "1 new" for one room) . View (the room holding the newest counted line) . ✕ (hidden until a NEWER line arrives). */
function paintNotice() {
  const host = $('roomLine');
  let el = host.querySelector(':scope > .wg-notice');
  const items = isPhone() ? waitingRooms(noticeList(), roomId) : [];
  const sum = items.length ? noticeSummary(items) : null;
  if (!sum || stripHidden(sum, state.noticeDismissedKey)) {
    el?.remove();
    return;
  }
  const text = waitingText(sum);
  const sig = `${text}|${sum.newest?.id}|${sum.key}`;
  if (el && el.dataset.sig === sig) {
    return;
  }
  el?.remove();
  el = document.createElement('div');
  el.className = 'wg-notice';
  el.dataset.sig = sig;
  el.setAttribute('role', 'status');
  const tx = document.createElement('span');
  tx.className = 'tx';
  tx.textContent = text;
  const view = document.createElement('button');
  view.type = 'button';
  view.className = 'vw';
  view.textContent = 'View';
  view.addEventListener('click', () => viewWaiting(view));
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'x';
  x.setAttribute('aria-label', 'Hide until a newer message arrives');
  x.textContent = '\u2715';
  x.addEventListener('click', () => {
    state.noticeDismissedKey = sum.key;
    paintNotice();
  });
  el.append(tx, view, x);
  host.insertBefore(el, $('compose')); // above the message box
}

/* THE PERSON'S CURSOR: "I have seen this room up to line N" (PUT .../seen), sent
   a moment after lines land while the room's line is on screen. */
let seenSent = 0;
let seenTimer = 0;
function markSeenSoon() {
  clearTimeout(seenTimer);
  seenTimer = setTimeout(() => {
    const id = state.maxId;
    if (!id || id <= seenSent || isHidden() || state.sel !== 'room') {
      return;
    }
    api(`/api/rooms/${encodeURIComponent(roomId)}/seen`, { method: 'PUT', json: { last_seen_line_id: id } })
      .then((r) => {
        if (r.ok) {
          seenSent = Math.max(seenSent, id);
        }
      })
      .catch(() => {});
  }, 400);
}
/* ==== /WORKGROUPS ==== */

function renderRoster() {
  const list = $('roster');
  const rlist = $('roomList'); // [rail split]: the Room cell's own list
  const seats = orderSeats(state.room, state.seats);
  const lead = leadIdOf(state.room, state.seats);
  /* a 2.5 s poll redraws the column: keep the keyboard where it was */
  const focusedRow = document.activeElement?.closest?.('#roster .seat, #roomList .seat');
  const focused = focusedRow?.dataset.seatId ?? null;
  const focusedNav = focusedRow?.dataset.navRoom ?? null;
  if (state.sel !== 'room' && !seats.some((s) => s.id === state.sel) && !(isPhone() && appOf(state.sel))) {
    select('room'); // the selected seat (or app) left the room
    return;
  }
  if (!seatMenu.holding() && !roomMenu.isOpen() && !renameRoomOpen && !briefIsOpen) { // a seat menu / rename / Remove dialog keeps its row
    rlist.textContent = '';
    list.textContent = '';
    /* THE ROOM CELL [rail split] (Owner 2026-10-05): the room row + the workgroup tree, unread badges unchanged */
    if (isBasic()) {
      renderRoomRow(list); // BASIC keeps the old seats layout: the room's row together with its seats (no Room cell, no workgroup tree) [basic]
    } else {
      renderFamilyTree(rlist);
    }
    /* THE SEATS CELL: only the selected room's seats */
    for (const seat of seats) {
      renderSeatRow(list, seat, lead);
    }
    if (focused) {
      (list.querySelector(`.seat[data-seat-id="${CSS.escape(focused)}"]`) ?? rlist.querySelector(`.seat[data-seat-id="${CSS.escape(focused)}"]`))?.focus({ preventScroll: true });
    } else if (focusedNav) {
      rlist.querySelector(`.seat[data-nav-room="${CSS.escape(focusedNav)}"]`)?.focus({ preventScroll: true });
    }
    paintSeatsTitle();
  }
  $('noLead').hidden = !!lead;
  $('seatCount').textContent = String(seats.length);
  const cur = seats.find((x) => x.id === state.sel);
  if (cur && !$('seatNone').hidden && viewable(cur)) {
    showSeat(cur); // it came up (started elsewhere): now there is a pty to view
  } else if (cur && !$('seatNone').hidden && !frames.has(cur.id)) {
    showSeat(cur); // keep the panel's words and button current
  }
  renderPhone();
  renderSeatFilter(seats);
  applyFilters();
  dropGoneFrames(seats);
  paintSeatTones();
  paintLineGlyphs();
}

/* ------------------------------------------------------- the right column ---- */

const frames = new Map(); // seat id -> {el, src}; Map order = least recently shown first

/* AT MOST TWO HIDDEN SEAT FRAMES [perf/poll-traffic]. A seat's frame stays
   attached (hidden) after you look away so coming back is instant, but every
   one holds a live /pty stream plus its replay (up to 2 MB at attach), and it
   grew with every seat clicked through. The two most recently shown stay; an
   older one is removed, its socket closes and the stream stops (the session
   itself is untouched: it is parked like any window closed). `shown` is the
   seat whose frame is on screen now, or null. */
const HIDDEN_FRAMES_MAX = 2;
function capFrames(shown) {
  const hidden = [...frames.keys()].filter((id) => id !== shown);
  for (const id of hidden.slice(0, Math.max(0, hidden.length - HIDDEN_FRAMES_MAX))) {
    dropFrame(id);
  }
}
/** Mark a seat's frame most recently shown (the Map's end). */
function touchFrame(seatId) {
  const f = frames.get(seatId);
  if (f) {
    frames.delete(seatId);
    frames.set(seatId, f);
  }
}

function seatUrl(seat) {
  const pane = seat.occupant?.id || null;
  if (seat.occupant?.url) {
    return seat.occupant.url; // the engine's own path (§2.9 soloPathFor)
  }
  return pane && seat.recipe_id
    ? `/solo.html?recipe=${encodeURIComponent(seat.recipe_id)}&pane=${encodeURIComponent(pane)}`
    : null;
}

/** `inroom=1`: the solo page draws its own session bar (see solo.js). */
function framed(url) {
  return `${url}${url.includes('?') ? '&' : '?'}inroom=1`;
}

function dropGoneFrames(seats) {
  for (const [id, f] of frames) {
    if (!seats.some((s) => s.id === id)) {
      f.el.remove();
      frames.delete(id);
    }
  }
}

/** A seat whose pty is there to VIEW. Framing solo ATTACHES, and an attach to a
 *  dehydrated or ended row SPAWNS (the F11 path): selecting a row must never
 *  restore a conversation nobody asked for (the design system nav-v3 FAIL-1). Starting
 *  counts: someone pressed Start, and the attach is what completes it. */
function viewable(seat) {
  return seat.occupant?.state === 'live' || seat.status === 'starting';
}

const NOT_RUNNING = {
  dehydrated: 'is restorable: Restore brings it back where it left off.',
  ended: 'has ended.',
  'never-started': 'has no session yet.',
  empty: 'has no session yet.',
};

function showSeat(seat, urlOverride, focus) {
  const none = $('seatNone');
  let f = frames.get(seat.id);
  for (const [id, fr] of frames) {
    fr.el.hidden = id !== seat.id;
  }
  /* an explicit Start / Restore hands its pane over; else only a live seat
     frames. A frame already open stays as it is (its own Relaunch is explicit). */
  const url = urlOverride || (viewable(seat) ? seatUrl(seat) : null);
  if (!url && f) {
    none.hidden = true;
    f.el.hidden = false;
    touchFrame(seat.id);
    capFrames(seat.id);
    return;
  }
  if (!url) {
    const sig = JSON.stringify([seat.id, seat.status, seat.occupant?.state, seat.actions, seat.handle]);
    if (!none.hidden && none.dataset.sig === sig) {
      return; // unchanged: never rebuild a button under a click (the 2.5 s poll)
    }
    none.dataset.sig = sig;
    none.textContent = '';
    const head = document.createElement('div');
    head.className = 'rm-seatnone-head';
    head.append(seatGlyph(seat, leadIdOf(state.room, state.seats), 28));
    const b = document.createElement('b');
    b.textContent = `@${seat.handle}`;
    head.append(b);
    if (seat.project) {
      head.append(` · ${seat.project}`);
    }
    const p = document.createElement('p');
    const st = seat.occupant?.state === 'dehydrated' ? 'dehydrated' : seat.status;
    p.textContent = `@${seat.handle} ${NOT_RUNNING[st] ?? `is ${STATUS_TEXT[seat.status] ?? seat.status}.`}`;
    none.append(head, p);
    const act = seatActionButton(seat);
    if (act) {
      none.append(act);
    }
    none.hidden = false;
    return;
  }
  none.hidden = true;
  f = ensureFrame(seat, url);
  f.el.hidden = false;
  touchFrame(seat.id);
  capFrames(seat.id);
  if (focus) {
    f.el.focus();
  }
}

/** The seat's frame, created (hidden) or re-pointed at `url`. A new src is an
 *  ATTACH, which is what runs a restore's --resume. */
function ensureFrame(seat, url) {
  const src = framed(url);
  let f = frames.get(seat.id);
  if (!f) {
    const el = document.createElement('iframe');
    el.title = `@${seat.handle}`;
    el.allow = 'clipboard-read; clipboard-write; microphone';
    el.hidden = true;
    f = { el, src: '' };
    frames.set(seat.id, f);
    $('seatView').append(el);
  }
  if (f.src !== src) {
    f.src = src; // a new pane (Start / Restore) replaces the old view
    f.el.src = src;
  }
  return f;
}

/** Drop a seat's frame (its pane was ended): a later select shows the panel
 *  and its Restore, never a stale solo page whose Relaunch starts FRESH. */
function dropFrame(seatId) {
  const f = frames.get(seatId);
  if (f) {
    f.el.remove();
    frames.delete(seatId);
  }
  paintTwKeys();
}

/* THE iPAD KEYS [ipad keys]: the rail's Keys block (touch tablet, html.touch-wide). A key goes to the solo page framed in
   the seat view, which sends it to ITS CLI; with no seat's CLI open the keys are disabled and say so. The buttons act on
   pointerdown + preventDefault, like the solo keypad's, so the soft keyboard stays up and the terminal keeps focus. */
function openSeatFrame() {
  const f = state.sel !== 'room' ? frames.get(state.sel) : null;
  return f && !f.el.hidden && f.el.contentWindow ? f : null;
}
function paintTwKeys() {
  const grid = $('twKeysGrid');
  if (!grid.children.length) {
    for (const k of CLI_KEYS) {
      const b = document.createElement('button');
      b.type = 'button';
      if (typeof k.arrow === 'number') {
        /* the one arrow, rotated: all four match [the design system, line 4295] */
        b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" style="transform: rotate(${k.arrow}deg)"><path d="M12 19V5M6 11l6-6 6 6"/></svg>`;
      } else if (k.icon === 'newline') {
        /* shift (an up arrow on a bar) + return, drawn at the arrows' size and weight */
        b.innerHTML = '<svg viewBox="0 0 34 24" aria-hidden="true" class="kp-nl"><path d="M4 12l5-6 5 6M9 6v12"/><path d="M31 6v6a2 2 0 0 1-2 2H19M23 10l-4 4 4 4"/></svg>';
      } else if (k.icon === 'tick') {
        b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l5 6"/></svg>';
      } else {
        b.textContent = k.label;
      }
      b.setAttribute('aria-label', k.aria);
      if (k.cls) {
        b.className = k.cls;
      }
      b.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        const f = openSeatFrame();
        if (f) {
          f.el.contentWindow.postMessage({ hwbKeys: k.seq }, location.origin);
        }
      });
      grid.append(b);
    }
  }
  const open = !!openSeatFrame();
  for (const b of grid.children) {
    b.disabled = !open;
  }
  $('twKeysNote').textContent = open ? '' : "Select an agent's CLI";
}

/** Select an entry: 'room', a seat id, or (phone only) 'app:<panel id>'. On
 *  the phone a seat or an app is a LAYER over the line, which stays under it
 *  for the slide; on desktop a seat replaces the line in the right column. */
function select(id, opts = {}) {
  const app = isPhone() ? appOf(id) : null;
  const seat = app || id === 'room' ? null : state.seats.find((s) => s.id === id);
  if (!seat && !app && state.sel !== 'room') {
    window.dispatchEvent(new Event('room:overlay-closed')); // a layer closed: zoom guard
  }
  state.sel = seat ? seat.id : app ? appId(app.id) : 'room';
  closeSheet();
  $('main').classList.toggle('in-layer', !!(seat || app));
  $('roomLine').hidden = !!seat && !isPhone();
  $('seatView').hidden = !seat;
  $('appView').hidden = !app;
  if (!seat) {
    capFrames(null); // every seat frame is hidden now: keep the two most recent
  }
  if (seat) {
    showSeat(seat, opts.url, opts.focus);
  } else if (app) {
    cells.showLayer(app.id, $('appView'));
  } else {
    state.roomSeen = state.maxId; // looking at the line = seen
    markSeenSoon(); // WORKGROUPS: and the person's cursor
  }
  renderRoster();
  paintTwKeys();
  /* Only the LINE takes the composer's focus. Opening an app on the phone
     used to fall through here (no seat, an app) and focus the input, which on
     iOS pops the keyboard over the app (Owner 2026-09-29). And on a touch
     screen a programmatic focus always raises the keyboard, so only a tap on
     the input itself may do it there. */
  if (!seat && !app && opts.focus && !matchMedia('(pointer: coarse)').matches) {
    $('input').focus({ preventScroll: true });
  }
}

/** The Seats bar names the selection: "Seats · <room>", with the workgroup plate in a workgroup [rail split] Owner 2026-10-05. */
function paintSeatsTitle() {
  /* ONE NAME PER LEVEL [layers] (the design system handoff 1.P): just "Seats" and the count. The tinted row above already says whose seats
     these are, so no "· room name" and no plate; the name stays in the tooltip. */
  const tt = $('seatsTt');
  const t = seatsTitle(state.room);
  const key = `${t.name}`;
  if (tt.dataset.k === key) {
    return;
  }
  tt.dataset.k = key;
  tt.textContent = 'Seats';
  tt.title = `${t.prefix} · ${t.name}`;
}

/* keyboard: ↑/↓ move between rows, Enter / Space selects (both lists) */
const railKeys = (ev) => {
  const row = ev.target.closest?.('.seat');
  if (!row || ev.target !== row) {
    return;
  }
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    const sib = ev.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
    sib?.focus();
  } else if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault();
    select(row.dataset.seatId, { focus: true });
  }
};
$('roster').addEventListener('keydown', railKeys);
$('roomList').addEventListener('keydown', railKeys);
/* the seat choices live in the filter menu (room-filter.mjs); a seat that
   left the room falls back to everyone */
function renderSeatFilter(seats) {
  const keep = state.seatFilter;
  state.seatFilter = keep in WHO_LABEL || seats.some((s) => s.id === keep) ? keep : '';
  paintWho();
}

function applyRoom(room, seats) {
  if (!room) {
    return;
  }
  state.room = room;
  state.seats = Array.isArray(seats) ? seats : [];
  paintCrumb(room);
  document.title = `${tabNameOf(room)} · Workroom`; // the project's name, the main room's, also in a workgroup [layers]
  paintPlaceholder(room);
  tellShell(room);
  void tellShellIdentity();
  const st = $('roomState');
  st.hidden = room.state === 'open';
  st.textContent = room.state;
  renderRoster();
  watchHeld(state.seats);
  if (!state.feedApplied) {
    state.feedApplied = true; // once: a poll never overrides the view in use
    setFeed(feedDefault());
  }
  paintRoomColor();
  refreshCompletion();
  replyUi?.repaint(); // REPLY: the chip's "· to @lead" follows the roster
  repaintReads(); // the seats' held / waiting sets moved the read lines [web/room-phone-7]
}

/* Inside the CLI-Manager shell this page is a TAB. It names itself
   `room:<id>` (so a second Open from the manager focuses this tab instead of
   adding one) and hands the shell the room's name as the tab label. The shell
   applies a title only alongside a state, and a room has no session state of
   its own yet, so it sends 'idle' (the aggregate of its members is item 3).
   Sent only when the name changes, not on every 2.5 s poll. */
const EMBEDDED = window.parent !== window;
let toldShell = '';
/** What the TAB is called [layers] (Owner 2026-10-07): the project's own name, the MAIN room's, also with a workgroup open. */
function tabNameOf(room) {
  return room.parent_id && state.family?.parent?.name ? state.family.parent.name : room.name;
}
function tellShell(room) {
  const tab = tabNameOf(room);
  if (!EMBEDDED || toldShell === tab) {
    return;
  }
  toldShell = tab;
  window.parent.postMessage({ hwbSessionId: `room:${room.id}` }, '*');
  window.parent.postMessage({ hwbState: toldRoomState || 'idle', title: tab }, '*');
}

/* The room TAB wears the LEAD project's identity (the design system ruling: tab watermark =
   the lead project's mark, same formula as session tabs), so the shell gets the
   lead's recipe colour, logo key, or custom mark, exactly the three things a
   session page hands over (hwbBase / hwbLogo / bar.project.mark). No lead =
   null = a neutral tab. Sent when it changes; recipes are re-read at most once
   a minute (a logo edited elsewhere shows up on the next change). */
let recipesById = null;
let recipesAt = 0;
let toldIdentity;
let toldMode;
async function tellShellIdentity() {
  if (!state.room) {
    return;
  }
  const lead = state.seats.find((s) => s.id === state.room.lead_seat) || null;
  let ident = null;
  /* recipes feed the lead's identity AND every member tab's mark and colour
     (and, unembedded too, the room colour an unset room inherits) */
  if (state.seats.length && (!recipesById || Date.now() - recipesAt > 60_000)) {
    recipesAt = Date.now();
    try {
      const r = await api('/api/recipes');
      recipesById = new Map((r.body?.recipes ?? []).map((x) => [x.id, x]));
    } catch {
      recipesById = recipesById || new Map();
    }
    paintRoomColor();
  }
  if (!EMBEDDED) {
    return;
  }
  /* [window-chrome v34] Owner approved 2026-10-05: the room's OWN Dark/Light override rides to the shell
     so its tab and session bar wear that mode (null = follow the shell). Same rule as
     room-palette.mjs: an override exists only while the room has a palette of its own. */
  const mode = state.room.pal ? (state.room.pal_mode === 'light' ? 'light' : 'dark') : null;
  if (mode !== toldMode) {
    toldMode = mode;
    window.parent.postMessage({ hwbRoomMode: mode }, '*');
  }
  if (lead && lead.recipe_id) {
    const rec = recipesById.get(lead.recipe_id);
    if (rec) {
      let logo = null;
      try { logo = rec.logo ? JSON.parse(rec.logo) : null; } catch { logo = null; }
      ident = {
        base: rec.color || null,
        logoKey: logo && typeof logo.key === 'string' ? logo.key : null,
        mark: logo && typeof logo.svg === 'string' ? sanitizeSvg(logo.svg) : null,
        markStyle: logoMarkStyle(logo), // ROOM CHARACTER [rooms/character]: v32 tab logoStyle
      };
    }
  }
  /* ROOM COLOUR (round 3): a set one wins over the lead's; the lead's mark stays */
  if (state.room.color) {
    ident = { logoKey: ident?.logoKey ?? null, mark: ident?.mark ?? null, markStyle: ident?.markStyle ?? null, base: state.room.color };
  }
  /* ---- ROOM CHARACTER [rooms/character]: the room's ART is the tab's mark ---- */
  const artMark = characterMark(state.room);
  if (artMark) {
    ident = { base: ident?.base ?? state.room.color ?? null, ...artMark };
  }
  /* ---- /ROOM CHARACTER ---- */
  const sig = JSON.stringify(ident);
  if (sig !== toldIdentity) {
    toldIdentity = sig;
    window.parent.postMessage({ hwbRoomIdentity: ident }, '*');
  }
  tellShellMembers();
}

/* LEVEL 2 (item 3): the shell draws one tab per seat inside the room, in the
   room's order (lead first, §1.2), each with ITS OWN state (A4: the engine
   sends per-member states, never an aggregate). A seat whose occupant is live
   gets a url (its session page, the same /solo.html?recipe=&pane= the manager
   opens); any other seat has none, and selecting it shows this line filtered
   to that seat. Sent on change. */
let toldMembers = '';
let toldRoomState = '';
/* A member tab is a session tab, so it wears its PROJECT mark as the
   unselected-tab watermark (the design system: ruled tab watermark, combined v4): a
   custom SVG, else the preset key the shell resolves. */
function recipeMark(recipeId) {
  const rec = recipesById?.get(recipeId);
  let logo = null;
  try { logo = rec?.logo ? JSON.parse(rec.logo) : null; } catch { logo = null; }
  return {
    logoKey: logo && typeof logo.key === 'string' ? logo.key : null,
    mark: logo && typeof logo.svg === 'string' ? sanitizeSvg(logo.svg) : null,
    markStyle: logoMarkStyle(logo), // ROOM CHARACTER [rooms/character]: v32 tab logoStyle
  };
}
/* ---- ROOM CHARACTER [rooms/character]: a recipe logo pref's {line, backlit}
   (the art's style, inherited by the engine on read), for window-chrome v32's
   tabs[].logoStyle, defaulted exactly as the pane's watermark reads it
   (markStyle -> wmFields). Null = no logo = today's solid fill. ---- */
function logoMarkStyle(logo) {
  return logo && typeof logo.svg === 'string' ? markStyle(logo) : null;
}
function tellShellMembers() {
  if (!EMBEDDED || !state.room) {
    return;
  }
  const lead = leadIdOf(state.room, state.seats);
  const members = orderSeats(state.room, state.seats).map((seat) => {
    const b = brandFor(seat.vendor || 'unknown');
    const pane = seat.occupant?.id || null;
    const live = !!pane && seat.occupant?.state === 'live' && !!seat.recipe_id;
    return {
      seatId: seat.id,
      handle: seat.handle,
      /* the engine's own path (§2.9 soloPathFor), else the old page-built form */
      url: seat.occupant?.url || (live ? `/solo.html?recipe=${encodeURIComponent(seat.recipe_id)}&pane=${encodeURIComponent(pane)}` : null),
      /* no lifecycle yet = 'none': v25 draws the plate alone (older bundles
         fall back to an ended ring on the TAB; the roster never rings it) */
      state: seat.status === 'never-started' || seat.status === 'empty' ? 'none' : seatChrome(seat),
      exit: seat.occupant?.exit || null,
      brand: b.brand,
      brandColor: b.brandColor || null,
      base: recipesById?.get(seat.recipe_id)?.color || null,
      ...recipeMark(seat.recipe_id),
      primary: seat.id === lead,
    };
  });
  const sig = JSON.stringify(members);
  if (sig !== toldMembers) {
    toldMembers = sig;
    window.parent.postMessage({ hwbRoomModel: { members } }, '*');
  }
  /* The TOP-LEVEL room tab shows its LOUDEST member (the design system ruling, room interface:
     status), ranked by the bundle's own hwbRingLead, never a rank copied
     here. A room whose seats have no lifecycle yet is idle. */
  const seats = orderSeats(state.room, state.seats);
  const specs = seats.map(seatRingSpec);
  const i = hwbRingLead(specs);
  const loud = i >= 0 ? seatChrome(seats[i]) : 'idle';
  if (loud !== toldRoomState) {
    toldRoomState = loud;
    window.parent.postMessage({ hwbState: loud, title: tabNameOf(state.room) }, '*');
  }
}

/* A seat's framed solo page says its held line changed (a delivery): re-read
   the room now, so the row and its badge follow at once (room line [ref]). */
window.addEventListener('message', (ev) => {
  if (ev.origin !== location.origin || !ev.data || typeof ev.data.hwbSeatHeld !== 'string') {
    return;
  }
  if ([...frames.values()].some((f) => f.el.contentWindow === ev.source)) {
    void fetchRoom().catch(() => {});
  }
});

/* A seat's framed solo page says its windows were closed from a seat menu
   (any device; Owner 2026-10-03): drop that frame and, if it was showing, go to
   the ROOM CHAT (the phone's seat layer closes back to the line). */
window.addEventListener('message', (ev) => {
  if (ev.origin !== location.origin || !ev.data || typeof ev.data.hwbFrameClosed !== 'string') {
    return;
  }
  for (const [seatId, f] of frames) {
    if (f.el.contentWindow === ev.source) {
      dropFrame(seatId);
      if (state.sel === seatId) {
        select('room');
      }
      return;
    }
  }
});

/* ==== LINKS IN LINES: a seat's solo page (a frame THIS page made) hands its
   external links up; this page passes them on (open-external.mjs). A panel
   app's frame is not one of ours and is never relayed. ==== */
relayExternal((src) => [...frames.values()].some((f) => f.el.contentWindow === src));
/* ==== /LINKS IN LINES ==== */

/* The shell's level-2 row asks this page for two things: show the line for a
   seat that has nothing live to open, and open Add member (A2). */
window.addEventListener('message', (ev) => {
  if (ev.source !== window.parent || !ev.data || typeof ev.data !== 'object') {
    return;
  }
  if (typeof ev.data.hwbRoomFocusSeat === 'string') {
    select(ev.data.hwbRoomFocusSeat);
  } else if (ev.data.hwbRoomDisconnect === true) {
    void disconnectAgents(); // the room tab's ✕ → "Disconnect agents"
  } else if (ev.data.hwbRoomAdd === true) {
    addMembers('seats'); // level-2 A2: the same one add button
  }
});

async function fetchRoom() {
  const r = await api(`/api/rooms/${encodeURIComponent(roomId)}?art=ref`);
  if (r.ok && r.body) {
    await hydrateArt(r.body.room); // the SVG from the cache (fetched once per key + hash)
    if (Array.isArray(r.body.actions)) {
      setActions(r.body.actions);
    }
    state.family = r.body.family ?? null; // before applyRoom: its roster paints the workgroup rows
    state.inherited = r.body.inherited ?? []; // design fields this workgroup takes from its main room
    applyRoom(r.body.room, r.body.seats);
    await fetchUnreadAll(); // every open room, for the cross-family alert
    raiseNotices();
    if (Array.isArray(r.body.panels)) {
      cells?.setPanels(r.body.panels);
    }
    applyVoice(r.body.voice);
    if (r.body.voiceGlobal !== undefined) {
      state.voiceGlobal = r.body.voiceGlobal;
    }
    /* LINE LINKS: a room refresh re-checks the catalog (throttled to 30 s)
       and repaints every link (a list re-fetches its batch past 30 s) */
    loadAppNames();
    toolLinks?.refresh();
  }
  return r;
}

/* ----------------------------------------------------------------- line ---- */

function seatHandle(id) {
  return state.seats.find((s) => s.id === id)?.handle ?? null;
}

/* ROOM AUTHORSHIP v2 (the design system room-authorship-v2, Owner 2026-09-27). WHO wrote
 * a line, at a glance and with no bars: YOU on the right in a raised neutral
 * bubble with your square picture; an AGENT on the left with its seat glyph,
 * its @name in its project's derived tone and a soft wash of that colour; the
 * ROOM's facts centred, small and dim; a DELIVERY a dim line under the message
 * it reports, on that message's side. Consecutive lines from one author GROUP
 * (regroup): one glyph and one name on the first, the tail corner tightens. */
function entrySide(e) {
  if (e.author === 'room') {
    return 'room';
  }
  return e.author === 'user' && !e.author_seat ? 'user' : 'agent';
}

/** The room voice agent's own line (§6.1): author `voice`, no seat. */
function byVoiceAgent(e) {
  return e.author === 'voice' && !e.author_seat;
}

/** The Concierge's proxy line (concierge.md P2): author `concierge`, no seat, meta.proxy 'user'. Never the person's. */
function byConcierge(e) {
  return e.author === 'concierge' && !e.author_seat;
}

function entryTime(e) {
  const d = new Date(e.ts);
  const ts = document.createElement('time');
  ts.className = 'entry-ts';
  ts.dateTime = d.toISOString();
  ts.textContent = lineTime(e.ts);
  return ts;
}

/** A TOOL line's {tool, for} (rooms.ts postToolLine), or null. */
function toolOf(e) {
  try {
    const m = typeof e.meta === 'string' ? JSON.parse(e.meta) : e.meta;
    return m && typeof m.tool === 'string' ? { tool: m.tool, for: String(m.for ?? '') } : null;
  } catch {
    return null;
  }
}

/** An entry's meta as an object (it may arrive as JSON text), or null. */
function lineMeta(e) {
  try {
    const m = typeof e.meta === 'string' ? JSON.parse(e.meta) : e.meta;
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}

function entryNode(e) {
  const li = document.createElement('li');
  const side = entrySide(e);
  li.className = `entry k-${e.kind} by-${side}`;
  li.dataset.id = String(e.id);
  li.dataset.kind = e.kind;
  if (e.kind === 'fact') {
    /* the names a fact's own text mentions (outside code spans), so the To-me view can tell a fact that names the person [to-me facts] */
    li.dataset.mentions = mentionsIn(e.body).join(' ');
  }
  li.dataset.authorSeat = e.author_seat ?? '';
  li.dataset.targetSeat = e.target_seat ?? '';
  li.dataset.author = e.author ?? '';
  li.dataset.target = e.target ?? '';
  const tf = toMeFlags(e); // the To-me flags are derived in ONE place (web/to-me.mjs)
  if (tf.tool) {
    li.dataset.tool = tf.tool;
    li.dataset.for = tf.for;
  }
  /* addressed to THE USER (@user or their @name, rooms.ts userAddressed):
     the explicit meta.to_user, or for an older line the stored shape —
     target = the handle (or 'user'), no seat. An agent's reply to a line the
     user wrote is to the user too (meta.reply.user). */
  const meta = lineMeta(e);
  li.dataset.toUser = tf.toUser ? '1' : '';
  li.dataset.replyUser = e.author_seat && meta?.reply?.user === true && !e.target ? '1' : ''; // a reply that names someone else is a forward [reply routing]
  /* ==== WORKGROUPS: a cross-posted line says which way it went ==== */
  const xp = e.xpost ?? null;
  const xOut = isOutgoingOnly(xp);
  if (xOut) {
    li.classList.add('xpost');
  } else if (xp?.direction === 'in') {
    li.classList.add('xin');
  }
  /* ==== /WORKGROUPS ==== */
  const body = document.createElement('div');
  body.className = 'entry-body';
  /* ==== LINKS IN LINES: http(s) URLs are links (web/room-links.mjs) ==== */
  if (side === 'room') {
    body.append(...linkNodes(e.body ?? ''));
  } else {
    /* MARKDOWN [line markdown]: a message with markup is rendered (sanitized, mentions and links kept); anything else is today's plain line. Drawn before
       the libraries have loaded, a line with markup is plain for a moment and redrawn when they arrive (data-md-pending). */
    const md = renderLineMarkdown(e.body ?? '', mentionNodes);
    body.append(...(md ?? linkNodes(e.body ?? '', mentionNodes)));
    if (!md && !markdownReady() && hasMarkup(e.body)) {
      li.dataset.mdPending = '1';
    }
  }
  /* ==== /LINKS IN LINES ==== */

  if (side === 'room') {
    /* a delivery sits under its CAUSE, on the cause's side; anything else
       the room says is a centred fact */
    let cause = null;
    try {
      const meta = typeof e.meta === 'string' ? JSON.parse(e.meta) : e.meta;
      cause = state.entries.get(meta?.cause) ?? null;
    } catch {
      cause = null; // meta is the engine's opaque JSON: unreadable = no side
    }
    if (e.kind === 'delivery' && cause && entrySide(cause) !== 'room') {
      li.dataset.side = entrySide(cause);
      body.append(' · ', entryTime(e));
      /* a "not delivered" fact says what the coral line under the bubble already says: hidden while that line shows [wake deliver] */
      try {
        const fm = typeof e.meta === 'string' ? JSON.parse(e.meta) : e.meta;
        if (fm?.delivered === false && NOT_DELIVERED_REASONS.has(fm.reason)) {
          li.dataset.nd = '1';
          li.dataset.cause = String(cause.id);
          li.hidden = !!$('line').querySelector(`li[data-id="${cause.id}"] > .entry-reads .rd-not-delivered`);
        }
      } catch { /* opaque meta: it stays a plain fact */ }
    } else {
      li.title = entryTime(e).textContent;
    }
    li.append(body);
    /* ==== IMAGE LINKS IN LINES (web/room-image-links.mjs) ==== */
    imageLinks?.decorate(li, e);
    /* ==== /IMAGE LINKS IN LINES ==== */
    paintReads(li, e.reads);
    replyUi?.decorate(li, e); // REPLY: a fact is repliable too (menu, keys, swipe)
    return li;
  }

  li.dataset.group = side === 'user' ? 'user' : `seat:${e.author_seat || e.author}`;
  const glyph = document.createElement('span');
  glyph.className = 'entry-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  if (side === 'user') {
    glyph.append(youGlyph(state.me));
  } else {
    glyph.dataset.seat = e.author_seat ?? '';
    /* the voice agent is neutral: no invented identity hue (§9.4) */
    glyph.append(byVoiceAgent(e) || byConcierge(e) ? voiceAgentGlyph() : lineGlyph(e.author_seat));
  }
  const bubble = document.createElement('div');
  bubble.className = 'entry-bubble';
  const head = document.createElement('div');
  head.className = 'entry-head';
  const who = document.createElement('span');
  /* your name is not repeated on your own lines: the side and the picture say it */
  who.className = side === 'user' ? 'entry-author rm-sr' : 'entry-author';
  who.textContent = side === 'user' ? 'you' : byVoiceAgent(e) ? 'voice' : byConcierge(e) ? `Concierge (for ${meta?.for ?? 'you'})` : `@${e.author}`;
  head.append(who);
  /* POSTED BY A PANEL ACTION [ticket]: the person's submit in an app's panel
     (rooms.ts postPanelLine) — their line, marked "via <App>" */
  const viaApp = typeof meta?.via_app_name === 'string' ? meta.via_app_name : typeof meta?.via_app === 'string' ? meta.via_app : '';
  if (viaApp) {
    li.dataset.viaApp = meta.via_app ?? '';
    const via = document.createElement('span');
    via.className = 'entry-via';
    via.textContent = `via ${viaApp}`;
    head.append(via);
  }
  if (e.kind === 'voice') {
    /* the speaker glyph beside the author says "voice"; no bar, no accent (§9.4) */
    const sp = voiceGlyph('speaker', 16);
    sp.classList.add('entry-voice');
    sp.setAttribute('aria-hidden', 'false');
    sp.setAttribute('role', 'img');
    sp.setAttribute('aria-label', 'voice');
    head.append(sp, ...voiceHeadNodes(e, { byVoiceAgent: byVoiceAgent(e), leadHandle: seatHandle(state.room?.lead_seat) }));
  }
  /* ==== WORKGROUPS: outgoing = "→ room/@name" + the tag; incoming = "from <room> → @a" ==== */
  if (xp?.direction === 'out') {
    const xto = document.createElement('span');
    xto.className = 'xp-to';
    xto.textContent = `→ ${outgoingTargets(xp).join(' · ')}`;
    head.append(xto);
    if (xOut) {
      const tag = document.createElement('span');
      tag.className = 'xp-tag';
      tag.textContent = outgoingTag(xp, state.room?.name ?? 'this room');
      head.append(tag);
    }
  } else if (xp?.direction === 'in') {
    const from = document.createElement('span');
    from.className = 'xp-from';
    const origin = document.createElement('b');
    origin.textContent = xp.origin_name;
    from.append('from ', origin, ` → ${incomingHandles(xp)}`);
    head.append(from);
    /* [xpost fold] an agent-to-agent copy reads as one line here; tap to read it */
    if (foldIncoming(xp, { toUser: li.dataset.toUser === '1', byUser: side === 'user' })) {
      li.classList.add('xp-folded');
      body.hidden = true;
      const show = document.createElement('button');
      show.type = 'button';
      show.className = 'xp-show';
      show.textContent = 'show';
      show.setAttribute('aria-expanded', 'false');
      show.addEventListener('click', (ev) => {
        ev.stopPropagation();
        body.hidden = !body.hidden;
        show.textContent = body.hidden ? 'show' : 'hide';
        show.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
      });
      head.append(show);
    }
  }
  if (e.target && e.kind !== 'voice' && !(viaApp && !e.target_seat) && !xOut && xp?.direction !== 'in') { // a via-app line with no lead is the person's own record: no arrow to themselves; a cross-post names its rooms instead
    const to = document.createElement('span');
    to.className = 'entry-target';
    to.textContent = `→ @${e.target}`;
    head.append(to);
  }
  if (e.kind !== 'chat' && e.kind !== 'voice') {
    const kind = document.createElement('span');
    kind.className = 'entry-kind';
    kind.textContent = e.kind;
    head.append(kind);
  }
  head.append(entryTime(e));
  bubble.append(head, body);
  li.append(glyph, bubble);
  att?.decorate(li, bubble, e); // a sent line's files [ticket]
  /* ==== IMAGE LINKS IN LINES (web/room-image-links.mjs): after the files, before the tool links ==== */
  imageLinks?.decorate(bubble, e);
  /* ==== /IMAGE LINKS IN LINES ==== */
  toolLinks?.decorate(li, bubble, e); // LINE LINKS [rooms/tool-links]: under the body, after the files
  replyUi?.decorate(li, e); // REPLY: the quote header, the hover pill, the menu, keys, swipe
  if (e.kind === 'voice') {
    const notes = voiceNotesNode(e); // under the bubble, not in it (A0 §3)
    if (notes) {
      li.append(notes);
    }
  }
  paintReads(li, e.reads);
  paintApproval(li, e);
  return li;
}

/** [approval ask] The Approve / Cancel plate under a seat's `APPROVAL:` line while the person has not answered it. */
function paintApproval(li, e) {
  const ask = approvalAsk(e);
  const open = ask !== null && !approvalAnswered(state.entries.values(), e.id);
  const had = li.querySelector(':scope > .rm-approval');
  if (!open) {
    had?.remove();
    return;
  }
  if (had) {
    return;
  }
  const seat = state.seats.find((s) => s.id === e.author_seat);
  const plate = approvalPlate(
    seat?.handle ?? e.author,
    async () => (await runCommand('Approved.', undefined, e.id)) === 'applied',
    () => replyUi?.start(e), // Cancel: the composer, already replying to this line
  );
  const reads = li.querySelector(':scope > .entry-reads');
  if (reads) {
    reads.before(plate);
  } else {
    li.append(plate);
  }
}

/** A line of the person's arrived or left: re-check every open plate. */
function repaintApprovals() {
  for (const li of $('line').querySelectorAll('li[data-id]')) {
    const e = state.entries.get(Number(li.dataset.id));
    if (e && (approvalAsk(e) !== null || li.querySelector(':scope > .rm-approval'))) {
      paintApproval(li, e);
    }
  }
}

/** An agent's glyph in the line: its seat glyph, the same one the seat row
 *  draws (repainted by paintLineGlyphs when the seat's state moves). A seat
 *  that has since left the room keeps a plain generic mark. */
function lineGlyph(seatId) {
  const seat = state.seats.find((s) => s.id === seatId);
  return seat ? seatGlyph(seat, leadIdOf(state.room, state.seats), 28) : brandMark('unknown');
}
const lineGlyphSig = new Map(); // seat id -> what its line glyphs were drawn from
function paintLineGlyphs() {
  const lead = leadIdOf(state.room, state.seats);
  for (const s of state.seats) {
    const sig = [s.vendor, s.status, seatChrome(s), !!s.occupant?.attached, s.occupant?.exit, s.id === lead].join('|');
    if (lineGlyphSig.get(s.id) === sig) {
      continue;
    }
    lineGlyphSig.set(s.id, sig);
    for (const g of $('line').querySelectorAll(`.entry-glyph[data-seat="${CSS.escape(s.id)}"]`)) {
      g.replaceChildren(seatGlyph(s, lead, 28));
    }
  }
}

/** Consecutive lines from one author form a GROUP. A room fact breaks it; a
 *  delivery under a message does not (it belongs to that message). Only what
 *  the filters show counts, so a hidden line never splits or joins a group. */
function regroup() {
  let prev = null;
  for (const li of $('line').children) {
    if (li.style.display === 'none' || li.dataset.side) {
      continue;
    }
    const key = li.dataset.group || '';
    const same = !!key && prev?.key === key;
    li.classList.toggle('same', same);
    li.classList.toggle('same-to', same && prev.target === li.dataset.target);
    prev = key ? { key, target: li.dataset.target } : null;
  }
}

/* ---- YOUR glyph: your square picture, else your initial (web/you-settings.mjs
   owns the look and the editor now — see youSettingsLink() below) ---- */
function paintYou() {
  for (const g of $('line').querySelectorAll('.entry.by-user > .entry-glyph')) {
    g.replaceChildren(youGlyph(state.me));
  }
}

/* Each seat's PROJECT colour as --pc on its seat rows and its line entries.
 * room.css derives the tones from it with PINNED lightness (the @name .82,
 * the wash .25, its edge .34), so any project colour keeps contrast; the raw
 * colour is never painted. A seat with no colour stays neutral. */
function paintSeatTones() {
  const css = state.seats.map((s) => {
    const c = recipesById?.get(s.recipe_id)?.color;
    const id = CSS.escape(s.id);
    return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)
      ? `.entry[data-author-seat="${id}"], .seat[data-seat-id="${id}"], .mention[data-seat="${id}"], .ph-chip[data-seat="${id}"] { --pc: ${c}; }`
      : '';
  }).filter(Boolean).join('\n');
  if ($('seatTones').textContent !== css) {
    $('seatTones').textContent = css;
  }
  paintMentions(); // a seat came, went or was renamed; the lead moved
}

/* @NAMES IN MESSAGE TEXT (Owner 2026-09-28: "color the @ names in the chat
 * text with their color"). Every @word in a user or agent line is its own
 * span (text nodes only, never HTML); paintMentions gives each its tone from
 * what the room knows NOW, so a seat added later colours old lines too:
 *   a seat's handle -> that seat's project ink (the tone its @name wears);
 *   @lead           -> the current lead seat's;
 *   YOUR @name      -> the ROOM's ink (--rc-ink, round 3's room colour);
 *   anything else   -> no tone: plain text. */
const MENTION_RE = /(?<![A-Za-z0-9_.@-])@([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/g;
function mentionNodes(text) {
  const out = [];
  let at = 0;
  const quoted = quotedRanges(text); // a quoted @name is shown as typed, never toned as an address
  for (const m of text.matchAll(MENTION_RE)) {
    if (inQuote(quoted, m.index)) {
      continue;
    }
    if (m.index > at) {
      out.push(document.createTextNode(text.slice(at, m.index)));
    }
    const span = document.createElement('span');
    span.className = 'mention';
    span.dataset.h = m[1].toLowerCase();
    span.textContent = m[0];
    toneMention(span);
    out.push(span);
    at = m.index + m[0].length;
  }
  if (at < text.length) {
    out.push(document.createTextNode(text.slice(at)));
  }
  return out;
}
function toneMention(span) {
  const h = span.dataset.h;
  const seat = h === 'lead'
    ? state.seats.find((s) => s.id === leadIdOf(state.room, state.seats))
    : state.seats.find((s) => s.handle === h);
  const mine = !seat && (h === 'user' || (!!state.me?.handle && h === state.me.handle)); // @user is me too (2026-09-28)
  const tone = seat ? 'seat' : mine ? 'user' : '';
  if ((span.dataset.tone ?? '') !== tone) {
    span.dataset.tone = tone;
  }
  const id = seat?.id ?? '';
  if ((span.dataset.seat ?? '') !== id) {
    span.dataset.seat = id;
  }
}
function paintMentions() {
  for (const span of $('line').querySelectorAll('.mention')) {
    toneMention(span);
  }
}

/* ---------------------------------------------------------- read state ---- */

/* Did each recipient's AGENT take this entry in (workrooms-build §2.7, item
 * 4). Quiet: one dim line under the entry. `reads` is absent on entries
 * delivered to nobody, and so is the line.
 *
 * WHERE A MESSAGE GOT TO [web/room-phone-7] (Owner, room line [ref]: moving the
 * status line to chips must not lose "→ @x typed in"; it goes where messaging
 * apps put it, the read line under the bubble). Per recipient, the FURTHEST
 * state reached, grouped in this order:
 *   seen @x          the engine's positive evidence (reads: seen)
 *   delivered @x     typed into its pane (the turn not yet seen) or handed to
 *                    its fabric channel
 *   held @x · draft  still in the typer's queue; the reason in the held
 *                    words (web/held-words.mjs); the state word in --amber
 *   not live @x      no live pane at delivery (its delivery fact, or the
 *                    send's own report)
 *   badge only @x    the badge, never typed (typing off, not claude-code)
 *   can't tell @x    the engine could not tell and nothing here knows better
 * Sources, all already on the page: reads (seen / not-yet / unknown; the
 * room.read push), the seat's waiting ids (room.waiting) and held queue
 * (room.held), the line's delivery facts, and the report of a line this page
 * sent (the send's deliveries). A not-yet line in the seat's waiting set is
 * typed in unless it is among the newest `held.depth` of that set (the typer
 * types first-in first-out, so what it still holds is the newest); a not-yet
 * line NOT in the set was handed to the channel. It repaints on every one of
 * those pushes and on the line GET, so held -> delivered -> seen moves in
 * place. */
const READ_RANK = { waking: -1, 'not-yet': 0, unknown: 1, seen: 2 }; // waking [wake deliver]: the person's line is held while a disconnected agent wakes; then it is delivered (not-yet), then seen
const READ_GROUPS = [
  ['seen', 'seen'],
  ['delivered', 'delivered'],
  ['waking', 'waking'],
  ['held', 'held'],
  ['not-delivered', 'Not delivered'],
  ['not-live', 'not live'],
  ['badge', 'badge only'],
  ['unknown', "can't tell"],
];
const READ_TITLE = {
  delivered: 'typed into its session (its turn not seen yet), or handed to its channel',
  held: 'still queued for its session: the reason follows; it is typed in when that clears',
  waking: 'that agent was disconnected: it is being woken, and the line is typed in once it is up',
  'not-delivered': 'that agent is disconnected and the line did not reach it',
  'not-live': 'no live session at that seat when the message was sent',
  badge: 'shown as a badge only: typing is off, or the agent is not claude-code',
  unknown: 'the engine could not tell whether these agents took it in (the message was dropped, no turn was seen, or no record since a restart)',
};

/** The report of each line this page sent: entry id -> handle -> {delivered, typed}. */
const sentReports = new Map();
function rememberReport(entries, deliveries) {
  const line = (Array.isArray(entries) ? entries : []).find((e) => e && e.kind !== 'delivery' && e.reads);
  if (!line || !Array.isArray(deliveries)) {
    return;
  }
  sentReports.set(line.id, new Map(deliveries.map((d) => [d.handle, { delivered: !!d.delivered, typed: d.typed }])));
  if (sentReports.size > 200) {
    sentReports.delete(sentReports.keys().next().value);
  }
}

/** The handles each entry's delivery facts say were not live (cause -> Set). */
let notLiveIdx = { at: -1, n: -1, map: new Map(), info: new Map() };
function notLiveFor(entryId) {
  if (notLiveIdx.at !== state.maxId || notLiveIdx.n !== state.entries.size) {
    const map = new Map();
    const info = new Map();
    for (const e of state.entries.values()) {
      if (e.kind !== 'delivery') {
        continue;
      }
      let meta = null;
      try {
        meta = typeof e.meta === 'string' ? JSON.parse(e.meta) : e.meta;
      } catch {
        meta = null;
      }
      const cause = meta?.cause ?? meta?.line;
      if (meta && meta.delivered === false && cause !== undefined && e.target) {
        const set = map.get(cause) ?? new Set();
        const h = String(e.target).replace(/^@/, '');
        set.add(h);
        map.set(cause, set);
        if (meta.reason) {
          /* WHY it was not delivered [wake deliver]: disconnected | no-session | wake-failed | waking; action 'wake-deliver' = there is a session to restore */
          const m = info.get(cause) ?? new Map();
          m.set(h, { reason: meta.reason, action: meta.action ?? null, seat: meta.seat ?? null });
          info.set(cause, m);
        }
      }
    }
    notLiveIdx = { at: state.maxId, n: state.entries.size, map, info };
  }
  return notLiveIdx.map.get(entryId) ?? null;
}
function notLiveWhy(entryId, handle) {
  notLiveFor(entryId); // refresh the index
  return notLiveIdx.info?.get(entryId)?.get(handle) ?? null;
}
/** Lines whose WAKE the person has just asked for: "entry:handle" -> asked-at (ms). The engine's own 'waking' read state replaces it. */
const wakeAsked = new Map();

/** One recipient's furthest state: [group, held reason?]. */
function recipientState(entryId, handle, read) {
  if (read === 'seen') {
    return ['seen'];
  }
  const askKey = `${entryId}:${handle}`;
  if (read === 'not-yet') {
    wakeAsked.delete(askKey); // delivered: the wake worked
  }
  if (read === 'waking' || (wakeAsked.has(askKey) && Date.now() - wakeAsked.get(askKey) < 90000)) {
    return ['waking'];
  }
  const seat = state.seats.find((s) => s.handle === handle) || null;
  const report = sentReports.get(entryId)?.get(handle) ?? null;
  if (read === 'not-yet') {
    const ids = Array.isArray(seat?.waiting?.ids) ? seat.waiting.ids : null;
    const held = seat?.occupant?.held;
    if (ids && ids.includes(entryId)) {
      const depth = held && held.depth > 0 ? held.depth : 0;
      const newest = depth ? [...ids].sort((a, b) => a - b).slice(-depth) : [];
      return newest.includes(entryId) ? ['held', heldWord(held)] : ['delivered'];
    }
    if (!ids && report?.typed === 'queued') {
      return ['held', held && held.depth > 0 ? heldWord(held) : 'queued'];
    }
    return ['delivered']; // injected, or handed to its channel
  }
  /* unknown: say what is known, else "can't tell" */
  const why = notLiveWhy(entryId, handle);
  if (why && (why.reason === 'disconnected' || why.reason === 'wake-failed' || why.reason === 'no-session')) {
    return ['not-delivered', why.reason, why.seat ?? seat?.id ?? null, why.action === 'wake-deliver'];
  }
  if (notLiveFor(entryId)?.has(handle) || (report && !report.delivered)) {
    return ['not-live'];
  }
  if (report && (report.typed === 'injected' || report.typed === 'channel')) {
    return ['delivered']; // typed in (no turn seen in time), or channel
  }
  if (report && (report.typed === undefined || report.typed === 'off' || report.typed === 'vendor')) {
    return ['badge'];
  }
  return ['unknown'];
}

const NOT_DELIVERED_REASONS = new Set(['disconnected', 'wake-failed', 'no-session']);
/** Hide (or show) the "not delivered" fact lines of one cause, following whether its coral line is on screen. */
function syncNdFacts(entryId, shown) {
  for (const f of $('line').querySelectorAll(`li[data-nd][data-cause="${entryId}"]`)) {
    f.hidden = shown;
  }
}
const NOT_DELIVERED_WHY = {
  disconnected: (h) => `@${h} is disconnected`,
  'wake-failed': (h) => `@${h} is disconnected (the wake failed)`,
  'no-session': (h) => `@${h} is disconnected (no session to restore)`,
};
/** CORAL "Not delivered: @x is disconnected" with a Wake and deliver button when there is a session to restore [wake deliver]. */
function notDeliveredChip(entryId, handle, x) {
  const [, reason, seatId, canWake] = x;
  const g = document.createElement('span');
  g.className = 'rd rd-not-delivered';
  g.dataset.state = 'not-delivered';
  g.title = READ_TITLE['not-delivered'];
  const w = document.createElement('span');
  w.className = 'rd-w';
  w.textContent = 'Not delivered:';
  g.append(w, ` ${(NOT_DELIVERED_WHY[reason] ?? NOT_DELIVERED_WHY.disconnected)(handle)} `);
  if (canWake && seatId) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rd-wake';
    b.textContent = 'Wake and deliver';
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = 'Waking…';
      let r = null;
      try {
        r = await api(`/api/rooms/${encodeURIComponent(roomId)}/seats/${encodeURIComponent(seatId)}/wake-deliver`, { json: { lineId: entryId } });
      } catch {
        r = null;
      }
      if (r?.ok) {
        wakeAsked.set(`${entryId}:${handle}`, Date.now());
        repaintReads();
        void fetchRoom();
        return;
      }
      b.disabled = false;
      b.textContent = 'Wake and deliver';
      roomToast(r?.status === 409 ? `@${handle} has no session to wake` : `Could not wake @${handle}${r?.body?.error ? `: ${r.body.error}` : ''}`, { kind: 'error' });
    });
    g.append(b);
  }
  return g;
}

/* HELD NOTICE [held notice] (Owner 2026-10-11, room lines [ref] / [ref]; both
   editions). A message of the person's that has sat HELD for a DRAFT (the
   seat's input box may hold unsent text) for HELD_NOTICE_MS is said under its
   own bubble, loudly, with the one action that sends it: Deliver posts
   `/deliver @handle` (rooms.ts deliverCommand, the person's only; it asks
   "Send anyway?" first when the engine counted real typed text there). All it
   reads is already on the page: the line's held state (recipientState), the
   seat's occupant.held.reason, and the line's own time. Nothing is written to
   the chat for it, and it goes when the line is typed. The look and the copy are
   the design system (styleguide/mockups/room-held-notice-v1.html; the CSS block in room.css). */
const HELD_NOTICE_MS = 5000;
let heldNoticeTimer = null;

/** The handles whose DRAFT hold on this line is now worth saying; a hold that
 *  is not old enough yet schedules the repaint that will say it. */
function heldNoticeDue(entryId, at) {
  const e = state.entries.get(entryId);
  if (!e || e.author !== 'user') {
    return [];
  }
  const drafts = at.filter(([h, x]) => x[0] === 'held' && state.seats.find((s) => s.handle === h)?.occupant?.held?.reason === 'draft').map(([h]) => h);
  if (!drafts.length) {
    return [];
  }
  const wait = HELD_NOTICE_MS - (Date.now() - e.ts);
  if (wait > 0) {
    if (heldNoticeTimer === null) {
      heldNoticeTimer = setTimeout(() => {
        heldNoticeTimer = null;
        repaintReads();
      }, wait + 50);
    }
    return [];
  }
  return drafts.sort();
}

/** A room command issued by a control on the page, not typed in the composer:
 *  the composer's text, attachments and reply target are left alone. A refusal
 *  and the confirm step use the strip a typed command uses. Settles to
 *  'applied' | 'refused' | 'cancelled' | 'failed'; a confirm waits for the
 *  person (Confirm runs it, Cancel or anything else taking the strip cancels). */
async function runCommand(text, confirmToken, replyTo) {
  let r;
  try {
    /* keep_draft: this did not come from the composer, so the engine must not clear the person's draft */
    r = await api(`/api/rooms/${encodeURIComponent(roomId)}/line`, { json: { text, keep_draft: true, ...(replyTo ? { reply_to: replyTo } : {}), ...(confirmToken ? { confirm: confirmToken } : {}) } });
  } catch (e) {
    roomToast(`not sent: ${e?.message ?? e}`, { kind: 'error' });
    return 'failed';
  }
  const b = r.body ?? {};
  if (!r.ok) {
    roomToast(`not sent: ${b.error ?? `HTTP ${r.status}`}`, { kind: 'error' });
    return 'failed';
  }
  if (b.status === 'confirm') {
    return new Promise((resolve) => {
      const strip = $('reply');
      let settled = false;
      const settle = (v) => {
        if (!settled) {
          settled = true;
          watch.disconnect();
          resolve(v);
        }
      };
      const yes = document.createElement('button');
      /* the strip was closed or reused by something else: that is a Cancel */
      const watch = new MutationObserver(() => {
        if (strip.hidden || !strip.contains(yes)) {
          settle('cancelled');
        }
      });
      showReply('confirm', (el) => {
        const p = document.createElement('span');
        p.className = 'rm-reply-text';
        p.textContent = b.confirm?.prompt ?? 'Confirm?';
        yes.type = 'button';
        yes.className = 'rm-confirm';
        yes.textContent = 'Confirm';
        yes.addEventListener('click', () => {
          const again = runCommand(text, b.confirm?.token);
          settle(again); // before the strip closes, so closing it is not read as a Cancel
          clearReply();
        });
        const no = document.createElement('button');
        no.type = 'button';
        no.className = 'rm-cancel';
        no.textContent = 'Cancel';
        no.addEventListener('click', clearReply);
        el.append(p, yes, no);
      });
      watch.observe(strip, { attributes: true, attributeFilter: ['hidden'], childList: true });
    });
  }
  if (b.status === 'refused') {
    showReply('refused', (el) => {
      const err = document.createElement('span');
      err.className = 'rm-reply-text';
      err.textContent = b.refused?.error ?? 'refused';
      el.append(err);
      if (b.refused?.suggestion) {
        const sug = document.createElement('span');
        sug.className = 'rm-suggest';
        sug.textContent = b.refused.suggestion;
        el.append(sug);
      }
    });
    return 'refused';
  }
  clearReply();
  addEntries(b.entries);
  void fetchRoom();
  return 'applied';
}

/** The plate (the design system room-held-notice-v1): who has not received this message,
 *  why, and Deliver. One per message; `handles` are its seats held for a draft. */
function heldNotice(handles) {
  const n = document.createElement('div');
  n.className = 'rm-notice';
  n.setAttribute('role', 'status');
  const t = document.createElement('span');
  t.className = 'rm-notice-text';
  const who = document.createElement('b');
  who.textContent =
    handles.length === 1
      ? `@${handles[0]} has not received this.`
      : handles.length === 2
        ? `@${handles[0]} and @${handles[1]} have not received this.`
        : `${handles.length} agents have not received this.`;
  t.append(who, handles.length === 1 ? ' Its input box may hold unsent text.' : ' Their input boxes may hold unsent text.');
  const act = document.createElement('button');
  act.type = 'button';
  act.className = 'rm-notice-act';
  act.textContent = 'Deliver';
  act.addEventListener('click', async () => {
    act.disabled = true;
    act.textContent = 'Sending…';
    for (const h of handles) {
      if ((await runCommand(`/deliver @${h}`)) !== 'applied') {
        act.disabled = false; // refused, cancelled or failed: back to held (the strip or the toast says why)
        act.textContent = 'Deliver';
        return;
      }
    }
    /* delivered: the repaint that follows the room's answer removes the plate */
  });
  n.append(t, act);
  return n;
}

/** Put, keep or remove a line's plate. An unchanged plate is kept as it is, so
 *  a pressed button stays pressed across repaints. */
function paintHeldNotice(li, handles) {
  let n = li.querySelector(':scope > .rm-notice');
  const sig = handles.join(' ');
  if (!handles.length) {
    n?.remove();
    return;
  }
  if (n && n.dataset.sig === sig) {
    return;
  }
  n?.remove();
  n = heldNotice(handles);
  n.dataset.sig = sig;
  const reads = li.querySelector(':scope > .entry-reads');
  if (reads) {
    reads.before(n);
  } else {
    li.append(n);
  }
}

function paintReads(li, reads) {
  let el = li.querySelector(':scope > .entry-reads');
  const handles = reads && typeof reads === 'object' ? Object.keys(reads) : [];
  if (!handles.length) {
    el?.remove();
    paintHeldNotice(li, []);
    return;
  }
  const entryId = Number(li.dataset.id);
  const at = handles.map((h) => [h, recipientState(entryId, h, reads[h])]);
  const noticed = heldNoticeDue(entryId, at); // [held notice] these seats are said on the plate, not as "held @x · draft"
  const sig = JSON.stringify([at, noticed]);
  if (el && el.dataset.sig === sig) {
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.className = 'entry-reads';
    li.append(el);
  }
  el.dataset.sig = sig;
  el.textContent = '';
  paintHeldNotice(li, noticed);
  syncNdFacts(entryId, at.some(([, x]) => x[0] === 'not-delivered'));
  for (const [st, label] of READ_GROUPS) {
    let mine = at.filter(([, x]) => x[0] === st);
    if (st === 'held' && noticed.length) {
      mine = mine.filter(([h]) => !noticed.includes(h)); // the plate above says these
    }
    if (!mine.length) {
      continue;
    }
    /* held groups by its reason: "held @a @b · draft" */
    if (st === 'not-delivered') {
      for (const [h, x] of mine.sort((a, b) => a[0].localeCompare(b[0]))) {
        el.append(notDeliveredChip(entryId, h, x));
      }
      continue;
    }
    const groups = st === 'held' ? [...new Set(mine.map(([, x]) => x[1]))].map((why) => [why, mine.filter(([, x]) => x[1] === why)]) : [[null, mine]];
    for (const [why, who] of groups) {
      const g = document.createElement('span');
      g.className = `rd rd-${st}`;
      g.dataset.state = st;
      if (st === 'waking') {
        /* the seat rows' own working ring, so it reads as happening, not as a warning */
        const ring = document.createElement('span');
        ring.className = 'seat-ring rd-ring';
        hwbRing(ring, hwbRingFromChrome('streaming', { attached: true }), 14);
        g.append(ring);
      }
      const w = document.createElement('span');
      w.className = 'rd-w';
      const names = who.map(([h]) => `@${h}`).sort().join(' ');
      if (why && why.startsWith('needs you')) {
        /* [ticket] "held: @x needs you (login)" — the prompt, not "queued" */
        w.textContent = `${label}:`;
        g.append(w, ` ${names} ${why}`);
      } else {
        w.textContent = label;
        g.append(w, ` ${names}${why ? ` · ${why}` : ''}`);
      }
      if (READ_TITLE[st]) {
        g.title = READ_TITLE[st];
      }
      el.append(g);
    }
  }
}

/** Repaint every read line on the page (a seat's held / waiting set moved,
 *  or the room was re-read): only the lines whose answer changed are touched. */
function repaintReads() {
  for (const li of $('line').querySelectorAll('li[data-id]')) {
    const e = state.entries.get(Number(li.dataset.id));
    if (e?.reads) {
      paintReads(li, e.reads);
    }
  }
}

/** Merge read states into an entry we hold. Forward only: seen is final,
 *  can't-tell may still become seen, nothing returns to not-yet (§2.7), so
 *  the higher rank always wins, whatever order pushes and re-GETs land in. */
function mergeReads(entryId, reads) {
  const e = state.entries.get(entryId);
  if (!e || !reads || typeof reads !== 'object') {
    return;
  }
  const cur = e.reads && typeof e.reads === 'object' ? { ...e.reads } : {};
  let changed = false;
  for (const [h, st] of Object.entries(reads)) {
    if (!(st in READ_RANK)) {
      continue;
    }
    if (cur[h] === undefined || READ_RANK[st] > READ_RANK[cur[h]]) {
      cur[h] = st;
      changed = true;
    }
  }
  if (!changed) {
    return;
  }
  e.reads = cur;
  const li = $('line').querySelector(`li[data-id="${entryId}"]`);
  if (li) {
    paintReads(li, cur);
  }
  /* the seat rows' unread badges count `not-yet`: repaint them now, once per
     batch, not on the next poll (Owner, room line [ref]) */
  if (!rosterSoon) {
    rosterSoon = true;
    queueMicrotask(() => {
      rosterSoon = false;
      if (state.room) {
        renderRoster();
      }
    });
  }
}
let rosterSoon = false;

/* HELD → DELIVERED (Owner, room line [ref]): when a seat's held depth drops, a
 * line was just typed in, and its read state moves soon after (not-yet →
 * seen on the turn that follows). Re-read the line NOW and twice more while
 * that turn starts, instead of waiting for the ~10 s read poll (or, with
 * push, for nothing but the room.read push). The badge's meaning is unchanged. */
const heldDepth = new Map(); // seat id -> held depth last seen
let chaseTimers = [];
function watchHeld(seats) {
  let dropped = false;
  for (const s of seats) {
    const d = s.occupant?.held?.depth > 0 ? s.occupant.held.depth : 0;
    if (d < (heldDepth.get(s.id) ?? 0)) {
      dropped = true;
    }
    heldDepth.set(s.id, d);
  }
  if (dropped) {
    chaseTimers.forEach(clearTimeout);
    chaseTimers = [0, 1500, 4000].map((ms) => setTimeout(() => void refreshReads(), ms));
  }
}

/** THE one insert. De-dupes by id and keeps the DOM in id order whichever
 *  source delivered the entry and in whatever order they arrived. */
/** An API line against the To-me rule (the dataset form of the same rule is matchesWho('me')). */
function lineIsToMe(e) {
  return isToMe(toMeFlags(e), e.kind === 'fact' && factIsToMe({ toUser: false, mentions: mentionsIn(e.body) }, state.me?.handle));
}

function addEntries(list) {
  const scroll = $('lineScroll');
  const pinned = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
  const ol = $('line');
  let added = 0;
  for (const e of list ?? []) {
    /* a room shows what was written in it AND what was cross-posted INTO it (xpost.direction 'in') */
    if (!e || typeof e.id !== 'number' || (e.room_id !== undefined && e.room_id !== roomId && e.xpost?.direction !== 'in')) {
      continue;
    }
    /* A HIDDEN FACT is for clients that fold it (toolkit [ref]: the floor's "closed" fact;
       Owner [ref]: it showed under "To me" in a tab opened before the deploy). This page
       draws nothing for it, whatever the filter, and a re-GET or a push cannot bring it back. */
    if (e.kind === 'fact' && (lineMeta(e)?.hidden === true || lineMeta(e)?.turn?.kind === 'closed')) {
      continue;
    }
    /* in the To-me view the page holds ONLY lines to the person (a live line to someone else is not drawn): nothing to evict, nothing hidden, no matter how chatty the agents are */
    if (state.seatFilter === 'me' && !state.entries.has(e.id) && !lineIsToMe(e)) {
      continue;
    }
    if (state.entries.has(e.id)) {
      /* already drawn: a re-GET is the source of truth for `reads` */
      if (e.reads) {
        mergeReads(e.id, e.reads);
      }
      /* A VOICE line is written before the voice service answers ('sending') and announced
         again with the outcome (room-voice E1c, finishVoiceLine): redraw it */
      const was = state.entries.get(e.id);
      if (e.kind === 'voice' && e.meta !== undefined && JSON.stringify(e.meta) !== JSON.stringify(was.meta)) {
        const next = { ...was, ...e, reads: was.reads ?? e.reads };
        state.entries.set(e.id, next);
        const old = ol.querySelector(`li[data-id="${e.id}"]`);
        if (old) {
          const node = entryNode(next);
          node.className = old.className; // keep the grouping regroup() gave it
          applyFilterTo(node);
          glassObs?.unobserve(old);
          old.replaceWith(node);
          glassObs?.observe(node);
        }
      }
      continue;
    }
    state.entries.set(e.id, e);
    const node = entryNode(e);
    applyFilterTo(node);
    /* Find the first rendered entry with a larger id and go before it. The
       common cases (append at the tail, prepend a back page) are the ends. */
    let before = null;
    if (state.maxId !== null && e.id < state.maxId) {
      for (const el of ol.children) {
        if (Number(el.dataset.id) > e.id) {
          before = el;
          break;
        }
      }
    }
    ol.insertBefore(node, before);
    glassObs?.observe(node);
    state.minId = state.minId === null ? e.id : Math.min(state.minId, e.id);
    state.maxId = state.maxId === null ? e.id : Math.max(state.maxId, e.id);
    added++;
  }
  if (added) {
    repaintApprovals(); // [approval ask] my answer closes the plate
    paintTabHint(); // a new line of mine moves the suggestion
    trimOld(); // MEMORY: the page keeps the newest LINE_CAP lines
    regroup();
    paintDeliveryChips(); // a seat that has now replied drops its chip [web/room-phone-7b]
  }
  if (added && pinned) {
    scroll.scrollTop = scroll.scrollHeight;
  }
  if (added && !$('feedNote').hidden) {
    paintFeedNote(); // a visible line arrived: the note goes
  }
  if (added && state.sel === 'room') {
    markSeenSoon(); // the person's cursor for the badge (workgroups)
  }
  if (added && state.sel === 'room' && state.roomSeen !== null) {
    state.roomSeen = state.maxId; // on screen = seen
  } else if (added && state.room) {
    renderRoster(); // the room row's "N new"
  }
  return added;
}

/* MEMORY [shell memory] (Owner [ref]): a room left open all day kept every line it ever drew, in the page, in
   state.entries and in each line's listeners, so a laptop with several rooms and chatting agents climbed in memory
   and GPU. The page keeps the newest LINE_CAP lines (LINE_CAP_HIDDEN on a hidden tab); older ones go and "load older"
   brings them back. Trimmed in steps (TRIM_SLACK) so it is not on every line, and never past the line the reader is
   looking at: a reader scrolled up keeps their place (the scroll is corrected for what was removed above it). */
const LINE_CAP = 300;
const LINE_CAP_HIDDEN = 120;
const TRIM_SLACK = 50;
/* GLASS [shell memory] (the design system [ref]): the bubble blur is a composited layer per bubble, so only bubbles within about a
   screen of the viewport wear it (the CSS adds the newest 40 as a floor, so the live end never goes flat). The swap
   happens off-screen and is not transitioned. */
const glassObs = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((list) => {
      for (const it of list) {
        it.target.classList.toggle('glass', it.isIntersecting);
      }
    }, { root: $('lineScroll'), rootMargin: '100% 0px' })
  : null;
let atBottom = true; // the reader is following the newest lines (kept by the scroll listener; a hidden frame cannot measure it)
function trimOld(force = false) {
  const ol = $('line');
  const hidden = isHidden();
  const cap = hidden ? LINE_CAP_HIDDEN : LINE_CAP;
  const n = ol.childElementCount;
  if (n <= (force ? cap : cap + TRIM_SLACK)) {
    return 0;
  }
  const scroll = $('lineScroll');
  let drop = n - cap;
  let anchor = null;
  let anchorTop = 0;
  if (!hidden) {
    for (const li of ol.children) {
      if (li.offsetTop + li.offsetHeight > scroll.scrollTop) {
        anchor = li;
        break;
      }
    }
    if (anchor) {
      drop = Math.min(drop, Array.prototype.indexOf.call(ol.children, anchor));
      anchorTop = anchor.getBoundingClientRect().top;
    }
  }
  if (drop <= 0) {
    return 0;
  }
  for (let i = 0; i < drop; i++) {
    const li = ol.firstElementChild;
    state.entries.delete(Number(li.dataset.id));
    glassObs?.unobserve(li);
    li.remove();
  }
  const first = ol.firstElementChild;
  if (first) {
    state.minId = Number(first.dataset.id);
  }
  if (anchor) {
    /* the browser's own scroll anchoring may already have kept the reader's line in place: correct only what is left */
    scroll.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
  }
  state.atStart = false; // older lines exist again: the button and scroll-up bring them back
  $('olderBtn').hidden = false;
  $('lineStart').hidden = true;
  return drop;
}

/** "To me" is cut by the ENGINE (GET .../line?to=me, the same web/to-me.mjs rule): the page asks for pages of lines to the person, so older ones are reached however many
 *  agent-to-agent lines lie between. Every other view pages unfiltered and hides client-side. */
function whoQuery() {
  return state.seatFilter === 'me' ? '&to=me' : '';
}
/** Forget the lines drawn and read the newest page again (the To-me view starts and ends here: its lines are a different sequence from the room's). */
async function reloadLine() {
  const ol = $('line');
  for (const li of [...ol.children]) {
    if (li.dataset.id) {
      glassObs?.unobserve(li);
      li.remove();
    }
  }
  state.entries.clear();
  state.minId = null;
  state.maxId = null;
  state.atStart = false;
  state.loaded = false;
  $('olderBtn').hidden = false;
  $('lineStart').hidden = true;
  await loadNewest();
}

async function loadNewest() {
  const r = await api(`/api/rooms/${encodeURIComponent(roomId)}/line?limit=${PAGE}${whoQuery()}`);
  if (!r.ok) {
    return;
  }
  const entries = r.body?.entries ?? [];
  addEntries(entries);
  state.loaded = true;
  if (entries.length < PAGE) {
    markStart();
  }
  const scroll = $('lineScroll');
  scroll.scrollTop = scroll.scrollHeight;
  void ensureVisible(); // the room's feed may hide all of the newest page [feed empty]
}

async function loadOlder() {
  if (state.atStart || state.minId === null) {
    return;
  }
  const r = await api(`/api/rooms/${encodeURIComponent(roomId)}/line?before=${state.minId}&limit=${PAGE}${whoQuery()}`);
  if (!r.ok) {
    return;
  }
  const entries = r.body?.entries ?? [];
  const scroll = $('lineScroll');
  const fromBottom = scroll.scrollHeight - scroll.scrollTop;
  addEntries(entries);
  scroll.scrollTop = scroll.scrollHeight - fromBottom; // keep the reader where they were
  if (entries.length < PAGE) {
    markStart();
  }
}

/* A FILTER THAT HIDES THE WHOLE NEWEST PAGE LOOKS LIKE AN EMPTY ROOM [feed empty] Owner 2026-10-06 (application on iPhone showed only
   "load older"): the room inherits the main room's feed (who: me) and a night of agent-to-agent lines filled the newest 50, every
   one hidden. So: while nothing loaded is visible and the room has an older page, fetch older pages (at most FILL_PAGES), and if
   still nothing, say so by name with a way out. */
const FILL_PAGES = 5;
let filling = null;
let fillUsed = 0; // pages fetched for a feed that shows nothing: the cap is for the feed, not for each trigger; a filter CHANGE resets it
function visibleLines() {
  for (const li of $('line').children) {
    if (li.style.display !== 'none' && !li.dataset.side) {
      return true;
    }
  }
  return false;
}
function ensureVisible() {
  if (!state.loaded) {
    return Promise.resolve();
  }
  if (filling) {
    return filling;
  }
  filling = (async () => {
    try {
      while (fillUsed < FILL_PAGES && !visibleLines() && !state.atStart && state.minId !== null) {
        fillUsed += 1;
        await loadOlder();
      }
    } catch {
      /* the note below still says what the filter did */
    } finally {
      filling = null;
      paintFeedNote();
    }
  })();
  return filling;
}
function paintFeedNote() {
  const note = $('feedNote');
  const lines = [...$('line').children].filter((li) => !li.dataset.side).length;
  const none = state.loaded && lines > 0 && !visibleLines();
  note.hidden = !none;
  if (none) {
    $('feedNoteText').textContent = state.seatFilter === 'me'
      ? `No messages to you in the newest ${lines}${state.atStart ? '' : ' loaded'}.`
      : `Nothing in the newest ${lines}${state.atStart ? '' : ' loaded'} matches the filter.`;
  }
}

function markStart() {
  state.atStart = true;
  $('olderBtn').hidden = true;
  $('lineStart').hidden = false;
}

let backfilling = null;
/** Forward paging: everything after the newest id we hold. Loops until a short
 *  page, so a long outage is recovered whole rather than one page of it. */
function backfill() {
  if (!state.loaded) {
    return Promise.resolve();
  }
  if (backfilling) {
    return backfilling;
  }
  backfilling = (async () => {
    for (let guard = 0; guard < 50; guard++) {
      const since = state.maxId ?? 0;
      const r = await api(`/api/rooms/${encodeURIComponent(roomId)}/line?since=${since}&limit=${FORWARD_PAGE}${whoQuery()}`);
      const entries = r.ok ? r.body?.entries ?? [] : [];
      addEntries(entries);
      if (entries.length < FORWARD_PAGE) {
        break;
      }
    }
  })().finally(() => {
    backfilling = null;
  });
  return backfilling;
}

/* -------------------------------------------------------------- filters ---- */

function matches(node) {
  if (state.hiddenKinds.has(node.dataset.kind)) {
    return false;
  }
  return matchesWho(node.dataset, state.seatFilter);
}

/* WHO the line shows (Owner 2026-09-27: All / Me / Between agents / a seat).
 * "To me" (Owner 2026-09-28): what I wrote, the voice agent, what went to
 * @room, a line ADDRESSED to me (@user or my @name, anywhere in it — the
 * engine stores meta.to_user; older lines by their shape), and what the lead
 * said without an @ (no @ targets the lead, so the lead's own unaddressed line
 * is to me).
 * A QUOTE NEVER COUNTS (Owner [ref], reversing 2026-09-28): an agent's reply to
 * a line I wrote is to me only through meta.to_user, i.e. when it names me, or
 * names nobody (the engine's reply inheritance marks that one). A reply that
 * quotes my line but is addressed to another seat is between agents. The rule
 * is the contract in docs ROOMS-API "To me"; the Workbench copies it.
 * Room FACTS are always to me (Owner 2026-09-30: "To me" was hiding them).
 * A TOOL line is to me only when I initiated it (for = "user"); one an agent
 * initiated is that agent's (Owner 2026-09-28).
 * "Between agents" = a seat writing to a DIFFERENT seat, and not to me. */
const WHO_LABEL = { '': 'everyone', me: 'to me', agents: 'between agents', voice: 'voice agent' };
function matchesWho(d, who) {
  if (!who) {
    return true;
  }
  if (who === 'me') {
    /* the rule is web/to-me.mjs; a room FACT shows under To me only when the engine flagged it to the person, or its own text names the person (code spans
       excluded) [lead ruling [ref]] */
    return isToMe(
      { kind: d.kind, author: d.author, authorSeat: d.authorSeat, target: d.target, targetSeat: d.targetSeat, toUser: d.toUser === '1', tool: d.tool ?? '', for: d.for ?? '' },
      d.kind === 'fact' && factIsToMe({ toUser: false, mentions: d.mentions }, state.me?.handle),
    );
  }
  if (who === 'voice') {
    return d.author === 'voice' && !d.authorSeat;
  }
  if (who === 'agents') {
    return (
      !!d.authorSeat &&
      d.author !== 'user' &&
      d.target !== 'room' &&
      d.toUser !== '1' &&
      !!d.targetSeat &&
      d.targetSeat !== d.authorSeat
    );
  }
  return d.authorSeat === who || d.targetSeat === who;
}
function whoLabel(who) {
  if (who in WHO_LABEL) {
    return WHO_LABEL[who];
  }
  const s = state.seats.find((x) => x.id === who);
  return s ? `@${s.handle}` : 'everyone';
}
function setWho(who) {
  fillUsed = 0;
  const was = state.seatFilter;
  state.seatFilter = who in WHO_LABEL || state.seats.some((s) => s.id === who) ? who : ''; // a seat no longer in the room = everyone
  if (state.loaded && (was === 'me') !== (state.seatFilter === 'me')) {
    void reloadLine().then(() => {
      applyFilters();
      paintWho();
    }); // entering or leaving To me swaps the sequence of lines: read it from the engine
    return;
  }
  applyFilters();
  paintWho();
}
/** The phone's filter state: a dot on the header's button. No bar over the
 *  line saying what it shows (Owner 2026-09-28: it cost vertical space); the
 *  filter sheet shows the choice and changes it. */
function paintWho() {
  const on = !sameFeed(currentFeed(), feedDefault()); // the dot = not the room's default (desktop's rule too)
  $('phFilterDot').hidden = !on;
  filterUi?.paint();
}

/* THE DEFAULT FEED (room round 3): the room's saved filter. The page opens on
 * it and Reset returns to it. Unset = every kind, everyone. */
const ALL_FEED = { kinds: KINDS, who: '' };
function feedDefault() {
  const f = state.room?.feed_default;
  if (!f || !Array.isArray(f.kinds)) {
    return ALL_FEED;
  }
  return { kinds: KINDS.filter((k) => f.kinds.includes(k)), who: typeof f.who === 'string' ? f.who : '' };
}
function currentFeed() {
  return { kinds: KINDS.filter((k) => !state.hiddenKinds.has(k)), who: state.seatFilter };
}
function sameFeed(a, b) {
  return a.who === b.who && a.kinds.join() === b.kinds.join();
}
function setFeed(f) {
  state.hiddenKinds = new Set(KINDS.filter((k) => !f.kinds.includes(k)));
  setWho(f.who);
}
/** desktop: the filter button's dot, its name and the menu's Reset follow
 *  whether the view is the room's default */
function paintFeedReset() {
  filterUi?.paint();
}

/** A filter HIDES (display:none), it never removes: the entry stays keyed, so
 *  lifting the filter shows it again and the de-dupe still knows it. */
function applyFilterTo(node) {
  node.style.display = matches(node) ? '' : 'none';
}

function applyFilters() {
  for (const node of $('line').children) {
    applyFilterTo(node);
  }
  regroup();
  paintFeedReset();
  paintFeedNote();
  void ensureVisible(); // a filter change can hide everything loaded [feed empty]
}

/** One kind on / off. The LAST kind on is refused (the design system room-filter-v1):
 *  the line can never go blank by accident. */
function toggleKind(k) {
  if (!state.hiddenKinds.has(k) && KINDS.length - state.hiddenKinds.size <= 1) {
    return false;
  }
  fillUsed = 0;
  if (state.hiddenKinds.has(k)) {
    state.hiddenKinds.delete(k);
  } else {
    state.hiddenKinds.add(k);
  }
  applyFilters();
  paintWho();
  return true;
}

/* THE LINE FILTER BUTTON (the design system room-filter-v1, web/room-filter.mjs): the
   room bar's menu, and the phone sheet's kinds + Reset. Thin hooks only. */
function buildKindFilters() {
  filterUi = mountFilter({
    btn: $('filterBtn'),
    kinds: KINDS,
    feed: currentFeed,
    def: feedDefault,
    whoOptions: () => [
      ...Object.entries(WHO_LABEL).map(([v, l]) => [v, l[0].toUpperCase() + l.slice(1)]),
      ...orderSeats(state.room, state.seats).map((s) => {
        const c = recipesById?.get(s.recipe_id)?.color;
        return [s.id, `@${s.handle}`, typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : ''];
      }),
    ],
    whoLabel,
    setWho,
    toggleKind,
    reset: () => setFeed(feedDefault()),
    refreshSheet: () => {
      if (!$('phSheet').hidden && openSheetKind === 'filter') {
        fillSheet('filter');
      }
    },
  });
  filterUi.paint();
}

/* -------------------------------------------------------------- compose ---- */

const input = $('input');

/* ------------------------------------------------------------ char limit --
 * ticket: Owner kept splitting a message into several sends over the room's
 * 4000-char SEND cap (LINE_BODY_MAX, src/table/store.ts). From CHAR_WARN_AT
 * ("within ~12 characters") the box's border turns coral and the composer's
 * status line ($('delivery') — the same line "→ @x typed in" shows on, less
 * cognitive load than a second line) says how many are left, then how many
 * over. Past CHAR_MAX the overflow renders coral (the mirrored backdrop,
 * #inputHi, behind a transparent-text textarea — a textarea can't color part
 * of its own text) and Send/Enter are blocked. NOTHING here ever truncates
 * or blocks typing or pasting — only sending. Drafts have their own, higher
 * cap server-side (DRAFT_BODY_MAX) so an over-length message still survives
 * an F5. */
const CHAR_MAX = 4000; // mirrors LINE_BODY_MAX — a send over it is refused there regardless of this
const CHAR_WARN_AT = CHAR_MAX - 12; // Owner: "within ~12 characters of 4000"
const inputHi = $('inputHi');

function syncHiScroll() {
  if (!inputHi.hidden) {
    inputHi.scrollTop = input.scrollTop;
    inputHi.scrollLeft = input.scrollLeft;
  }
}
input.addEventListener('scroll', syncHiScroll);

/** Repaints the border, the backdrop and the status-line note from the
 *  composer's current text. Called on every input/paste and everywhere the
 *  value is set programmatically (a draft restore, a panel prefill, a send
 *  clearing the box). */
function paintCharLimit() {
  const text = input.value;
  const len = text.length;
  const over = len > CHAR_MAX;
  const warn = len >= CHAR_WARN_AT;
  input.classList.toggle('rm-near-limit', warn);
  input.classList.toggle('rm-over-limit', over);
  if (over) {
    inputHi.textContent = '';
    inputHi.append(document.createTextNode(text.slice(0, CHAR_MAX)));
    const overSpan = document.createElement('span');
    overSpan.className = 'over';
    overSpan.textContent = text.slice(CHAR_MAX);
    inputHi.append(overSpan);
    inputHi.hidden = false;
    syncHiScroll();
  } else if (!inputHi.hidden) {
    inputHi.hidden = true;
    inputHi.textContent = '';
  }
  paintTabHint();
  longDraft = !over && hasWords(text);
  charNote = over ? `over by ${len - CHAR_MAX} — won't send` : warn ? `${CHAR_MAX - len} left` : '';
  paintDeliveryLine();
  att?.overLimit(over);
}
input.addEventListener('input', paintCharLimit);
/* ----------------------------------------------------------- /char limit ---- */

/* ---------------------------------------------------------- tab hint ----
 * Owner 2026-10-03 (room line [ref]): "if I start a message with Tab it includes
 * the @ names of my last message." The coaching already lives in the
 * placeholder, so it ends ", /help or tab to message @a @b." while the box is
 * empty and a suggestion exists (desktop only); Tab fills it (the keydown below). */
let basePlaceholder = input.getAttribute('placeholder') ?? ''; // WORKGROUPS: names the lead (paintPlaceholder)
function currentTabSuggestion() {
  if (input.value !== '' || phoneInput() || !$('reply').hidden) {
    return '';
  }
  const lead = leadIdOf(state.room, state.seats);
  return tabSuggestion({
    entries: state.entries.values(),
    seats: state.seats.map((s) => s.handle),
    leadHandle: lead ? seatHandle(lead) : null,
    me: state.me?.handle ?? null,
    meta: lineMeta,
    handleOf: seatHandle,
  });
}
/* Owner's wording: ", or /help" becomes ", /help or tab to message @a @b."
   A box too narrow for it ellipsises, as the placeholder always did. */
function paintTabHint() {
  const fill = currentTabSuggestion().trim();
  const ph = fill ? basePlaceholder.replace(', or /help', `, /help or tab to message ${fill}.`) : basePlaceholder;
  if (input.getAttribute('placeholder') !== ph) {
    input.setAttribute('placeholder', ph);
  }
}
/* ---------------------------------------------------------- /tab hint ---- */

/** {panel:'compose', text} (room-cells.mjs, the rules are there): PREFILL
 *  the composer, never send. Empty: set it. Otherwise insert at the caret
 *  with a separating space. Focus it with the caret after the text; the
 *  draft is saved as typing would. */
function composeFromPanel(text) {
  const v = input.value;
  let caret;
  if (!v) {
    input.value = text;
    caret = text.length;
  } else {
    const a = Math.min(input.selectionStart ?? v.length, v.length);
    const b = Math.min(Math.max(input.selectionEnd ?? a, a), v.length);
    const before = v.slice(0, a);
    const after = v.slice(b);
    const pre = before && !/\s$/.test(before) ? ' ' : '';
    const post = after && !/^\s/.test(after) ? ' ' : '';
    input.value = `${before}${pre}${text}${post}${after}`;
    caret = before.length + pre.length + text.length;
  }
  input.focus();
  input.setSelectionRange(caret, caret);
  fitInput();
  paintCharLimit();
  refreshCompletion();
  scheduleDraftSave();
}

function setInput(text) {
  input.value = text;
  input.focus();
  input.setSelectionRange(text.length, text.length);
  fitInput();
  paintCharLimit();
  refreshCompletion();
  scheduleDraftSave();
}

/* ---------------------------------------------------------------- draft ---- */
/* THE DRAFT IS KEPT ON THE SERVER (Owner 2026-09-28: "whatever is typed into
   the room chat should survive a refresh... an F5, moving from PC to mobile,
   or a network outage"). Per person per room (PUT/GET .../draft). A local copy
   is written on every edit and dropped once the server holds exactly that
   text, so an edit the server never got (an outage, a tab killed inside the
   debounce) is still here on the next load; it is retried on the next edit
   and when the browser comes back online. Every storage access is guarded:
   storage can be absent or throw, and the page must work without it.
   COMING BACK TO A TAB (ticket): the server draft is also read when the page
   becomes visible or the window gets focus, because the other device may have
   written it since. `seenAt` is the server `updatedAt` this page last loaded or
   last saved itself; a newer one with NO unsaved edit here replaces the box,
   a newer one with unsaved typing is only OFFERED (a button, never an
   overwrite). At most one fetch per 30s for those events, so focus and
   visibility firing together cost one request, and focus is never moved.
   WHILE VISIBLE (ticket): a page that just sits open fires no such event, so
   the room poll's answer carries this person's draft stamp (draftUpdatedAt) and
   a newer one runs the same reconcile at once (an engine without the field falls
   back to every 4th visible tick, ~10 s, guard 8 s); a hidden tab never does, it reads on show (isHidden() also covers a shell
   tab: a display:none iframe reads visible to the browser). */
const DRAFT_KEY = `hwb.room.draft.${roomId}`;
const DRAFT_DEBOUNCE_MS = 400;
/* dirty: THIS page holds an edit the server has not confirmed. Only this
   page's own edits are ever flushed: the local copy is shared by every tab
   of this browser, and pushing a copy another tab left would overwrite a
   newer draft from another device. */
const draft = { timer: null, chain: Promise.resolve(), busy: 0, dirty: false, seenAt: null, askedAt: null, syncAt: 0, offer: null };
const DRAFT_SYNC_MS = 30000;
const DRAFT_TICK_MS = 8000; // the visible-page tick's guard: also spaces a tick after a focus event

function localDraft() {
  try {
    const v = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    return v && typeof v.text === 'string' && typeof v.at === 'number' ? v : null;
  } catch {
    return null;
  }
}
/* REPLY: the reply target rides the draft (room-reply-v1). Its id goes to the
   server with the text; the local copy keeps the whole quote so the chip can
   come back from it alone. */
const replyId = () => replyUi?.target()?.id ?? null;
function keepLocalDraft(text) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ text, at: Date.now(), reply: replyUi?.target() ?? null }));
  } catch {
    /* no storage: the server copy is all there is */
  }
}
function dropLocalDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* nothing to drop */
  }
}

/** A successful PUT answers the stored draft: its updatedAt is what this page
 *  has now seen, so its own save never reads as "newer from elsewhere". */
async function noteSaved(r) {
  const b = await r.json().catch(() => null);
  if (b && typeof b.updatedAt === 'number') {
    draft.seenAt = b.updatedAt; // an offer stays: after this save it is the only copy of the other device's text
  }
}

function putDraft(text, keepalive) {
  return fetch(`/api/rooms/${encodeURIComponent(roomId)}/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, reply_to: replyId() }), // REPLY: the target with the text
    keepalive,
  });
}

/** Save what the composer holds now. Saves run one after another, so an older
 *  text can never land after a newer one. Never throws. */
function saveDraft() {
  clearTimeout(draft.timer);
  draft.timer = null;
  const text = input.value;
  const rid = replyId();
  draft.busy += 1;
  draft.chain = draft.chain.then(async () => {
    try {
      const r = await putDraft(text, false);
      if (r.ok) {
        await noteSaved(r);
      }
      if (r.ok && input.value === text && replyId() === rid) {
        dropLocalDraft(); // the server holds exactly what is shown
        draft.dirty = false;
      }
    } catch {
      /* offline: the local copy stays, and is retried */
    } finally {
      draft.busy -= 1;
    }
  });
  return draft.chain;
}

/** Every edit: keep it locally at once, save it to the server once typing
 *  pauses. */
function scheduleDraftSave() {
  draft.dirty = true;
  keepLocalDraft(input.value);
  clearTimeout(draft.timer);
  draft.timer = setTimeout(() => void saveDraft(), DRAFT_DEBOUNCE_MS);
}

/** The page is going away (hidden, closed, navigated): send any unsaved edit
 *  NOW, with keepalive so the request outlives the page. */
function flushDraft() {
  if (!draft.dirty) {
    return;
  }
  clearTimeout(draft.timer);
  draft.timer = null;
  const text = input.value;
  const rid = replyId();
  try {
    void putDraft(text, true)
      .then(async (r) => {
        if (r.ok) {
          await noteSaved(r);
        }
        if (r.ok && input.value === text && replyId() === rid) {
          dropLocalDraft();
          draft.dirty = false;
        }
      })
      .catch(() => {});
  } catch {
    /* the local copy stays */
  }
}

/** On load: fill an EMPTY composer with the draft. The server copy wins, unless
 *  this browser holds an unsaved edit newer than it (then that edit is shown
 *  and saved). */
async function restoreDraft() {
  let server = null;
  try {
    const r = await api(`/api/rooms/${encodeURIComponent(roomId)}/draft`);
    if (r.ok && r.body && typeof r.body.text === 'string') {
      server = r.body;
    }
  } catch {
    /* unreachable: the local copy is the best there is */
  }
  draft.seenAt = typeof server?.updatedAt === 'number' ? server.updatedAt : null;
  if (input.value) {
    return; // typed while loading: that wins
  }
  const local = localDraft();
  const localWins = local && (!server || server.updatedAt === null || local.at > server.updatedAt);
  const text = localWins ? local.text : (server?.text ?? '');
  if (!localWins) {
    dropLocalDraft();
  }
  if (text) {
    input.value = text;
    input.setSelectionRange(text.length, text.length);
    fitInput();
    paintCharLimit(); // a restored draft can already be over the 4000-char send cap [ticket]
  }
  replyUi?.restore(localWins ? (local.reply ?? null) : (server?.reply ?? null)); // REPLY: the chip comes back
  if (localWins) {
    draft.dirty = true; // an edit the server never got: saved now, or when back online
    if (server) {
      void saveDraft();
    }
  }
}

/** Put a server draft in the box (the cursor at the end, focus untouched) and
 *  take it as this page's own: nothing local is left to save over it. */
function applyServerDraft(s) {
  clearTimeout(draft.timer);
  draft.timer = null;
  draft.dirty = false;
  dropLocalDraft();
  input.value = s.text;
  input.setSelectionRange(s.text.length, s.text.length);
  fitInput();
  paintCharLimit();
  replyUi?.restore(s.reply ?? null);
  draft.seenAt = s.updatedAt;
  hideNewerDraft();
}

function hideNewerDraft() {
  draft.offer = null;
  $('newerDraft').hidden = true;
}

/** Read the server draft (at most once per `guard` ms, 30s for focus and
 *  visibility, 8s for the visible-page tick) and take it if it is newer than
 *  what this page has seen. Unsaved typing here is never overwritten: the newer
 *  copy is offered instead. Silent on every failure. */
async function syncDraft(guard = DRAFT_SYNC_MS) {
  try {
    const now = Date.now();
    if (isHidden() || navigator.onLine === false || draft.busy > 0 || now - draft.syncAt < guard) {
      return;
    }
    draft.syncAt = now;
    const r = await api(`/api/rooms/${encodeURIComponent(roomId)}/draft`);
    const s = r.ok && r.body && typeof r.body.text === 'string' && typeof r.body.updatedAt === 'number' ? r.body : null;
    if (!s || (draft.seenAt !== null && s.updatedAt <= draft.seenAt) || draft.busy > 0) {
      return;
    }
    if (s.text === input.value && !draft.dirty) {
      draft.seenAt = s.updatedAt; // the same words (a send cleared an already empty box)
    } else if (draft.dirty || draft.timer !== null) {
      draft.offer = s;
      $('newerDraft').hidden = false;
    } else {
      applyServerDraft(s);
    }
  } catch {
    /* unreachable: the box stays as it is */
  }
}

/** The room poll's draft stamp (this person's draft updated_at, or null). True
 *  when the engine sent one (so the fallback tick is not needed); a newer stamp
 *  than this page has seen reads the draft at once, once per stamp. */
function onDraftStamp(stamp) {
  if (stamp === undefined) {
    return false;
  }
  if (typeof stamp === 'number' && stamp > (draft.seenAt ?? 0) && stamp !== draft.askedAt) {
    draft.askedAt = stamp;
    void syncDraft(0);
  }
  return true;
}

/* NOTES [ticket]: the hooks web/room-notes.mjs uses to move the composer's text
   into a note. The engine moves the SERVER draft, so it is saved first; once
   the note is verified the composer, its local copy and its timer go empty and
   nothing re-saves them. */
async function prepareDraftForMove() {
  await saveDraft();
  return !draft.dirty;
}
function clearDraftMoved() {
  clearTimeout(draft.timer);
  draft.timer = null;
  draft.dirty = false;
  dropLocalDraft();
  input.value = '';
  fitInput();
  paintCharLimit();
  refreshCompletion();
  hideNewerDraft();
  /* the engine just emptied the server draft: that is the copy this page has
     now seen, so the next sync tick neither resurrects the moved text nor
     offers the move itself as a "Newer draft" */
  draft.busy += 1;
  return api(`/api/rooms/${encodeURIComponent(roomId)}/draft`)
    .then((r) => {
      if (r.ok && typeof r.body?.updatedAt === 'number') {
        draft.seenAt = r.body.updatedAt;
      }
    })
    .catch(() => {})
    .finally(() => {
      draft.busy -= 1;
    });
}

$('newerDraft').addEventListener('click', () => {
  if (draft.offer) {
    applyServerDraft(draft.offer);
    scheduleDraftSave(); // this page may have saved over it since: make the taken text the server's copy again
  }
});
addEventListener('focus', () => void syncDraft());
/* the offer stays while typing continues, and after this page's own save: it
   goes when it is taken (button) or the message is sent */
input.addEventListener('input', () => {
  scheduleDraftSave();
});
input.addEventListener('blur', () => {
  if (draft.timer !== null) {
    void saveDraft();
  }
});
addEventListener('online', () => {
  if (draft.dirty) {
    void saveDraft();
  }
});
addEventListener('pagehide', flushDraft);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    flushDraft();
  } else {
    void syncDraft();
  }
});

function showReply(kind, build) {
  const el = $('reply');
  el.textContent = '';
  el.className = `rm-reply is-${kind}`;
  build(el);
  el.hidden = false;
}

function clearReply() {
  const el = $('reply');
  el.hidden = true;
  el.textContent = '';
  state.pendingConfirm = null;
}

async function renderHelp(client) {
  /* BASIC [basic] (Owner 2026-10-08, lead [ref]): /help answers {client:{action:'help', data:<the Basic room commands>, agent:<the registry>}}. Two
     lists: "Room commands" (what the room itself does) and "Ask your agent" (what a /word means to the agent: tap one to put it in the box). */
  let basicRoom = Array.isArray(client?.data) ? client.data : null;
  let basicAgent = Array.isArray(client?.agent) ? client.agent : null;
  if (isBasic() && (!basicRoom || !basicAgent)) {
    const c = await api('/api/commands').catch(() => null);
    if (c?.ok) {
      basicRoom = basicRoom ?? (Array.isArray(c.body?.room) ? c.body.room : null);
      basicAgent = basicAgent ?? (Array.isArray(c.body?.agent) ? c.body.agent : null);
    }
  }
  if (basicRoom || basicAgent) {
    renderBasicHelp(basicRoom ?? [], basicAgent ?? []);
    return;
  }
  const r = await api('/api/rooms/commands');
  const el = $('help');
  el.textContent = '';
  const head = document.createElement('div');
  head.className = 'rm-help-head';
  head.textContent = 'Room commands';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'rm-help-close';
  close.textContent = 'close';
  close.addEventListener('click', () => {
    el.hidden = true;
  });
  head.append(close);
  el.append(head);
  const table = document.createElement('table');
  table.className = 'rm-verbs';
  for (const c of r.body?.commands ?? []) {
    const tr = document.createElement('tr');
    tr.className = 'rm-verb';
    tr.dataset.class = c.class;
    const u = document.createElement('td');
    u.className = 'rm-verb-usage';
    u.textContent = c.usage;
    const d = document.createElement('td');
    d.className = 'rm-verb-does';
    d.textContent = c.does + (c.class === 'executed' ? '' : ` (${c.class})`) + (c.confirms ? ' — asks to confirm' : '');
    tr.append(u, d);
    table.append(tr);
  }
  el.append(table);
  const foot = document.createElement('p');
  foot.className = 'rm-help-foot';
  foot.textContent = 'No @ goes to the lead; @handle goes to that seat; @room goes to everyone here. An unknown /command with an @ is carried to that seat as a request.';
  el.append(foot);
  el.hidden = false;
}

/** BASIC's /help: the room's own few commands, then "Ask your agent" (the registry). A row for the agent puts its /word in the box. */
function renderBasicHelp(room, agent) {
  const el = $('help');
  el.textContent = '';
  const mkEl = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) {
      n.className = cls;
    }
    if (text !== undefined) {
      n.textContent = text;
    }
    return n;
  };
  const head = mkEl('div', 'rm-help-head', 'Room commands');
  const close = mkEl('button', 'rm-help-x', '\u2715'); // the icon button the other sheets use
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.title = 'Close';
  close.addEventListener('click', () => {
    el.hidden = true;
  });
  head.append(close);
  el.append(head);
  const t1 = mkEl('table', 'rm-verbs');
  for (const c of room) {
    const tr = mkEl('tr', 'rm-verb');
    tr.append(mkEl('td', 'rm-verb-usage', c.usage || c.name), mkEl('td', 'rm-verb-does', c.explain || c.does || ''));
    t1.append(tr);
  }
  el.append(t1);
  if (agent.length) {
    const h2 = mkEl('div', 'rm-help-head rm-help-sub', 'Ask your agent');
    el.append(h2);
    const note = mkEl('p', 'rm-help-note', 'Type one of these and your agent explains it first. Tap one to put it in the box.');
    el.append(note);
    const t2 = mkEl('table', 'rm-verbs rm-verbs-agent');
    for (const raw of agent) {
      /* the registry's slash is optional (the design notes): "publish" and "/publish" are the same command; what is shown and typed has the slash */
      const c = { ...raw, name: String(raw.name ?? '').startsWith('/') ? String(raw.name) : `/${raw.name}` };
      const tr = mkEl('tr', 'rm-verb rm-verb-ask');
      tr.tabIndex = 0;
      tr.setAttribute('role', 'button');
      tr.dataset.cmd = c.name;
      const does = mkEl('td', 'rm-verb-does', c.explain || '');
      if (c.confirm !== false) {
        does.append(' ', mkEl('span', 'rm-ask-chip', 'asks first')); // a small chip at the end of the row, not part of the sentence
      }
      tr.append(mkEl('td', 'rm-verb-usage', c.name), does);
      const put = () => {
        el.hidden = true;
        composeFromPanel(`${c.name} `);
      };
      tr.addEventListener('click', put);
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          put();
        }
      });
      t2.append(tr);
    }
    el.append(t2);
  }
  el.append(mkEl('p', 'rm-help-foot', 'Plain words work too: just say what you want.'));
  el.hidden = false;
}

/* ------------------------------------------------------------ delivery ---- */

/* What happened to each recipient's copy, said QUIETLY (item 2): one dim line
 * under the input, replaced by the next send. The line itself is the record;
 * this only answers "did it reach them, and how". `typed` is the W3-interim
 * outcome (§3): injected into an idle claude pane, queued behind a busy one,
 * or badge-only (typing off / not claude-code). */
const TYPED_TEXT = {
  injected: 'typed in',
  queued: 'queued until idle',
  off: 'badge only (typing off)',
  vendor: 'badge only',
  self: null,
};

function deliveryText(d) {
  if (!d.delivered) {
    return 'not live';
  }
  const why = d.typed === 'queued' ? blockedReason(state.seats.find((s) => s.id === d.seat)) : null;
  if (why) {
    return `needs you (${why})`; // [ticket] held behind a prompt only a human answers
  }
  if (d.typed === undefined) {
    return 'badge';
  }
  return TYPED_TEXT[d.typed] === undefined ? String(d.typed) : TYPED_TEXT[d.typed];
}

/* CHAR LIMIT [ticket]: $('delivery') shows whichever of these is live —
 * charNote (paintCharLimit, above) wins while it applies, otherwise the last
 * send's report (below). Kept as strings, not written straight to the DOM,
 * so neither writer clobbers the other's turn. */
let deliveryNote = '';
let charNote = '';
let longDraft = false; // NOTES [ticket]: >= NOTE_SUGGEST_WORDS words and under the send limit

function paintDeliveryLine() {
  const el = $('delivery');
  /* NOTES [ticket]: a move-to-a-note result shows for a few seconds (a failure
     over everything, coral); while over the limit the line also carries the
     "Move to a note" action */
  const nm = notes?.line() ?? null;
  const shown = (nm?.err ? nm.text : '') || charNote || nm?.text || deliveryNote;
  const showsNote = !!nm && shown === nm.text;
  el.textContent = shown;
  el.hidden = !shown;
  el.classList.toggle('rm-delivery-danger', showsNote ? nm.err : !!charNote);
  el.classList.toggle('rm-delivery-note', showsNote); // shown on a phone too (room.css hides the plain line there)
  notes?.paintLimitAction(el, shown === charNote && input.value.length > CHAR_MAX);
  notes?.paintOffer(longDraft); // the long-draft "Move to a note?" lives in the composer, not on this line
}

function showDeliveries(list, text = '', entries = []) {
  const kept = (Array.isArray(list) ? list : [])
    .map((d) => [d, deliveryText(d)])
    .filter(([, t]) => t !== null);
  const parts = kept.map(([d, t]) => (t.startsWith('needs you') ? `held: @${d.handle} ${t}` : `@${d.handle} ${t}`));
  deliveryNote = parts.length ? `→ ${parts.join(' · ')}` : '';
  paintDeliveryLine();
  /* the phone's chips [web/room-phone-7]: the same recipients, in the order
     the line addressed them */
  lastLineId = (Array.isArray(entries) ? entries : []).find((e) => e && e.kind !== 'delivery')?.id ?? null;
  idleSince.clear(); // a newer line resets the silent clocks
  silent.clear();
  lastDeliveries = addressedOrder(kept.map(([d, t]) => ({ seat: d.seat, handle: d.handle, word: t, delivered: !!d.delivered, typed: d.typed })), text);
  dchipSig = '';
  paintDeliveryChips();
}

/* ---- THE DELIVERY CHIPS (phone) [web/room-phone-7] ----------------------
 * Owner (room line [ref]): "→ @briefing-table not live" over the composer
 * becomes the addressed seat's LIVE chip, the strip's own (ring + @handle,
 * the activity animation), so after Send you can watch that seat work. One
 * chip per seat the engine delivered your LAST line to (its resolved
 * recipients: the leading @ run, mid-text @mentions, the reply-to author, or
 * the lead when unaddressed), in the order addressed; the row scrolls
 * sideways like the strip. The chips carry ACTIVITY only: where each copy
 * got to (delivered, held · why, not live, badge only, seen) is the read
 * line under your bubble (paintReads), where messaging apps put it; the
 * send's own sentence stays in the chip's tooltip / accessible name. */
let lastDeliveries = [];
let lastLineId = null; // the user's line those chips report on
let dchipSig = '';

/* A SILENT seat drops its chip too [web/room-phone-7b] (Owner): its copy was
 * DELIVERED (the read line says delivered or seen; never while held, queued,
 * not live or badge only) and it has been IDLE, continuously, for
 * SILENT_MS. Streaming, background work and waiting-on-you all keep the chip
 * (and restart the clock), since that is when you want to watch it. Driven by
 * the same repaints the activity pushes and polls already cause; one timer
 * re-checks at the next expiry. Latched: a silent chip stays gone until your
 * next line. */
const SILENT_MS = 30_000;
const idleSince = new Map(); // seat id -> ms the seat went idle with its copy delivered
const silent = new Set(); // seat ids whose chip timed out
let silentTimer = null;
function silentCheck(d, seat) {
  if (silent.has(d.seat)) {
    return true;
  }
  const read = lastLineId === null ? undefined : state.entries.get(lastLineId)?.reads?.[d.handle];
  const where = read === undefined ? null : recipientState(lastLineId, d.handle, read)[0];
  const quiet = !!seat && seatChrome(seat) === 'idle' && (where === 'delivered' || where === 'seen');
  if (!quiet) {
    idleSince.delete(d.seat);
    return false;
  }
  const since = idleSince.get(d.seat) ?? Date.now();
  idleSince.set(d.seat, since);
  if (Date.now() - since >= SILENT_MS) {
    silent.add(d.seat);
    idleSince.delete(d.seat);
    return true;
  }
  return false;
}
function scheduleSilent() {
  clearTimeout(silentTimer);
  silentTimer = null;
  if (!idleSince.size) {
    return;
  }
  const next = Math.min(...idleSince.values()) + SILENT_MS - Date.now();
  silentTimer = setTimeout(() => {
    dchipSig = '';
    paintDeliveryChips();
  }, Math.max(50, next + 20));
}

/** Has this seat REPLIED since the user's last line: a chat or command it
 *  authored with a larger id (a tool line is not a reply) [web/room-phone-7b].
 *  A replied seat's chip goes; when all have, the row hides. */
function repliedSince(seatId) {
  if (lastLineId === null) {
    return false;
  }
  for (const e of state.entries.values()) {
    if (e.id > lastLineId && e.author_seat === seatId && (e.kind === 'chat' || e.kind === 'command') && !toolOf(e)) {
      return true;
    }
  }
  return false;
}

/** Recipients in the order the text named them. MEMBERSHIP is the engine's
 *  (the deliveries); only the ORDER is read from the text: a seat named in it
 *  sorts by where; one never named (the lead of an unaddressed line, the
 *  author of a reply) comes first, as the address it was. */
function addressedOrder(list, text) {
  const low = String(text || '').toLowerCase();
  const isWordChar = (c) => !!c && ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-' || c === '_');
  const at = (handle) => {
    const needle = `@${String(handle).toLowerCase()}`;
    for (let i = low.indexOf(needle); i >= 0; i = low.indexOf(needle, i + 1)) {
      if (!isWordChar(low[i - 1]) && !isWordChar(low[i + needle.length])) {
        return i;
      }
    }
    return -1;
  };
  return list.map((d, k) => ({ d, k, p: at(d.handle) }))
    .sort((a, b) => (a.p < 0 ? -1 : a.p) - (b.p < 0 ? -1 : b.p) || a.k - b.k)
    .map((x) => x.d);
}

function paintDeliveryChips() {
  const box = $('deliveryChips');
  if (!lastDeliveries.length) {
    if (!box.hidden) { // an unchanged write is still a mutation the composer observes
      box.textContent = '';
      box.hidden = true;
    }
    dchipSig = '';
    return;
  }
  const lead = leadIdOf(state.room, state.seats);
  const rows = lastDeliveries
    .map((d) => ({ d, seat: state.seats.find((s) => s.id === d.seat) || null }))
    .filter(({ d, seat }) => !repliedSince(d.seat) && !silentCheck(d, seat));
  scheduleSilent();
  if (!rows.length) {
    if (!box.hidden) {
      box.textContent = '';
      box.hidden = true; // every addressed seat answered: no empty row taking height
    }
    dchipSig = '';
    return;
  }
  const sig = JSON.stringify(rows.map((r) => [r.d.seat, r.d.handle, r.seat ? [seatChrome(r.seat), !!r.seat.occupant?.attached, r.seat.status, r.seat.vendor, r.seat.id === lead, blockedReason(r.seat)] : null]));
  if (sig === dchipSig) {
    return;
  }
  dchipSig = sig;
  const keep = box.scrollLeft;
  box.textContent = '';
  for (const { d, seat } of rows) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ph-chip rm-dchip';
    b.setAttribute('role', 'listitem');
    b.dataset.seat = d.seat;
    if (seat) {
      b.append(seatGlyph(seat, lead, 18)); // a status readout, not a button [web/room-phone-7b]
    }
    b.append(mk('span', 'h', `@${d.handle}`));
    const why = blockedReason(seat);
    if (why) {
      /* [ticket] the addressed seat is stuck on a prompt: say which, and
         the chip opens its tab — where it can be answered */
      b.classList.add('is-needs');
      b.append(mk('span', 'nw', `needs you: ${why}`));
    }
    const spec = seat ? seatRingSpec(seat) : null;
    const now = seat ? (why ? `needs you (${why}) — open its tab` : spec ? hwbRingLabel(spec) : STATUS_TEXT[seat.status] ?? seat.status) : null;
    const said = [`@${d.handle}: ${d.word}`, now ? `now ${now}` : null].filter(Boolean).join(' · ');
    b.title = said;
    b.setAttribute('aria-label', `Your last message reached ${said}`);
    if (seat) {
      b.addEventListener('click', () => (why ? void openSeatWindow(seat) : select(seat.id, { focus: true })));
    }
    box.append(b);
  }
  box.hidden = false;
  box.scrollLeft = keep;
}

/** POST the RAW text. No author, no target, no parse: the engine owns all
 *  three (§2.2, §3). `confirm` only on the follow-up of a confirm answer. */
async function send(text, confirmToken) {
  const ids = confirmToken ? [] : att.ids(); // composer attachments [ticket]
  const json = confirmToken ? { text, confirm: confirmToken } : ids.length ? { text, attachments: ids } : { text };
  const rid = confirmToken ? null : replyId(); // REPLY: the line answers this entry
  if (rid !== null) {
    json.reply_to = rid;
  }
  att.busy(true);
  /* A pending draft save must not land AFTER the server clears the draft on
     this post; a save already in flight is followed by one of the empty box. */
  const pendingSave = draft.timer !== null;
  clearTimeout(draft.timer);
  draft.timer = null;
  const savingAtSend = draft.busy > 0;
  let r;
  try {
    r = await api(`/api/rooms/${encodeURIComponent(roomId)}/line`, { json });
  } catch (e) {
    showReply('error', (el) => {
      el.textContent = `not sent — ${e?.message ?? e}`;
    });
    if (pendingSave) {
      scheduleDraftSave();
    }
    return;
  } finally {
    att.busy(false);
  }
  const b = r.body ?? {};
  if (!r.ok || b.status === 'refused' || b.status === 'confirm') {
    if (pendingSave) {
      scheduleDraftSave(); // not sent: the text is still a draft
    }
  }
  if (!r.ok) {
    showReply('error', (el) => {
      el.textContent = `not sent — ${b.error ?? `HTTP ${r.status}`}${b.field ? ` (${b.field})` : ''}`;
    });
    return;
  }
  switch (b.status) {
    case 'applied':
    case 'delivered':
    case 'posted':
      clearReply();
      notes?.clearLine(); // "Draft moved to a note" (or an old failure) is not about this message
      showDeliveries(b.deliveries, text, b.entries);
      rememberReport(b.entries, b.deliveries); // the read line's "delivered / badge only" [web/room-phone-7]
      addEntries(b.entries);
      if (b.client?.action === 'help') {
        await renderHelp(b.client);
      } else if (b.client?.action === 'brief' && state.room) {
        showBrief(state.room, null); // a bare /brief shows it [room brief]
      }
      input.value = '';
      fitInput();
      paintCharLimit();
      closeCompletion();
      if (rid !== null) {
        replyUi?.sent(); // REPLY: the engine cleared the draft's target with the post
      }
      dropLocalDraft(); // the server cleared its copy with the post
      draft.dirty = false;
      hideNewerDraft();
      if ((savingAtSend || draft.busy > 0) && !input.value) {
        void saveDraft();
      }
      if (ids.length) {
        await att.sent(ids, b);
      }
      if (b.entries?.length) {
        void fetchRoom(); // a command can change the roster; do not wait for the poll
      }
      return;
    case 'confirm':
      state.pendingConfirm = { text, token: b.confirm?.token };
      showReply('confirm', (el) => {
        const p = document.createElement('span');
        p.className = 'rm-reply-text';
        p.textContent = b.confirm?.prompt ?? 'Confirm?';
        const yes = document.createElement('button');
        yes.type = 'button';
        yes.className = 'rm-confirm';
        yes.textContent = 'Confirm';
        yes.addEventListener('click', () => {
          const pc = state.pendingConfirm;
          if (pc) {
            void send(pc.text, pc.token);
          }
        });
        const no = document.createElement('button');
        no.type = 'button';
        no.className = 'rm-cancel';
        no.textContent = 'Cancel';
        no.addEventListener('click', clearReply);
        el.append(p, yes, no);
      });
      return;
    case 'refused':
      state.pendingConfirm = null;
      showReply('refused', (el) => {
        const err = document.createElement('span');
        err.className = 'rm-reply-text';
        err.textContent = b.refused?.error ?? 'refused';
        el.append(err);
        if (b.refused?.suggestion) {
          const s = document.createElement('span');
          s.className = 'rm-suggest';
          s.textContent = b.refused.suggestion;
          el.append(s);
        }
      });
      return; // keep the text: the user fixes it rather than retyping it
    default:
      showReply('error', (el) => {
        el.textContent = `unexpected answer: ${JSON.stringify(b).slice(0, 200)}`;
      });
  }
}

/* The composer is NOT a <form> (Owner 2026-10-04, IMG 22-56): iOS 26 / Edge iOS
   raised the AutoFill row (key / card / location + dismiss) over a form's
   fields, and Edge's address bar then covered the composer. Send button and
   the Enter / Ctrl+Enter keys all call this. */
function submitCompose() {
  const text = input.value;
  if (!att.canSend(text)) {
    return;
  }
  void send(text, null);
}
$('sendBtn').addEventListener('click', submitCompose);
/* USE ENTER TO SEND, live + a Send context menu [enter pref] Owner 2026-10-05: a change in Settings, another window or
   another device lands here with no reload (web/enter-pref.mjs); right-click / long-press Send toggles it globally. */
onEnterSubmits((v) => { if (state.me) { state.me.enterSubmits = v; } });
attachSendMenu($('sendBtn'), { get: () => state.me?.enterSubmits, note: (t, kind) => roomToast(t, { kind }) });

/* ----------------------------------------------------------- completion ---- */

let completion = { items: [], index: 0, start: -1 };

/** The @token the caret is in, or null. */
function atToken() {
  const upto = input.value.slice(0, input.selectionStart ?? input.value.length);
  const m = /(^|\s)@([a-z0-9-]*)$/.exec(upto);
  return m ? { prefix: m[2], start: upto.length - m[2].length - 1 } : null;
}

/* ==== THE "/" COMMAND LIST [slash list] (the design system [ref], Owner [ref]) ====
 * Type "/" first in the box and the engine's own command list opens above it, narrowing as you type. The rules are
 * web/slash-list.mjs (pure); this is the surface: rows, keys, focus (it never leaves the box). */
let slashCmds = null; // null = not asked yet; [] = none (an older engine, or the call failed: the list simply never opens)
let slashUi = { mode: 'closed', rows: [], index: 0, dismissed: null };
async function loadSlashCommands() {
  if (slashCmds !== null) {
    return;
  }
  slashCmds = [];
  try {
    const r = await api('/api/rooms/commands');
    slashCmds = r.ok && Array.isArray(r.body?.commands) ? r.body.commands : [];
  } catch {
    slashCmds = [];
  }
  refreshCompletion();
}
function closeSlash() {
  slashUi = { mode: 'closed', rows: [], index: 0, dismissed: slashUi.dismissed };
  const ul = $('complete');
  ul.classList.remove('rm-cmds');
  ul.style.left = '';
  ul.style.right = '';
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}
function boldParts(text, range) {
  if (!range) {
    return [document.createTextNode(text)];
  }
  const b = document.createElement('b');
  b.textContent = text.slice(range[0], range[1]);
  return [document.createTextNode(text.slice(0, range[0])), b, document.createTextNode(text.slice(range[1]))];
}
function cmdRow(cmd, typed, i, opts = {}) {
  const li = document.createElement('li');
  li.className = 'rm-cmd';
  li.id = `cmd-${i}`;
  li.setAttribute('role', 'option');
  const u = document.createElement('span');
  u.className = 'rm-cmd-u';
  const { head, args } = slash.split(cmd);
  const range = slash.boldRange(cmd, typed);
  const hr = range ? [range[0], Math.min(range[1], head.length)] : null;
  u.append(...boldParts(head, hr && hr[1] > hr[0] ? hr : null));
  if (args) {
    const a = document.createElement('span');
    a.className = 'rm-cmd-a';
    a.textContent = args;
    u.append(a);
  }
  const d = document.createElement('span');
  d.className = 'rm-cmd-d';
  d.textContent = cmd.does || '';
  li.append(u, d);
  if (opts.hint) {
    li.classList.add('is-hint');
    li.setAttribute('aria-disabled', 'true');
  } else {
    li.setAttribute('aria-selected', i === slashUi.index ? 'true' : 'false');
    li.classList.toggle('is-active', i === slashUi.index);
    li.addEventListener('mousedown', (ev) => {
      ev.preventDefault(); // focus stays in the box
      fillSlash(i);
    });
  }
  return li;
}
/** Shows the list for what is in the box. True when it handled the box (so the @-handle list stays out of the way). */
function refreshSlash() {
  const v = input.value;
  if (v[0] !== '/' || document.activeElement !== input) {
    closeSlash();
    return false;
  }
  if (slashCmds === null) {
    void loadSlashCommands();
    return false;
  }
  const typed = v.slice(0, input.selectionStart ?? v.length);
  const res = slash.rank(slashCmds, typed.includes('\n') ? '' : typed);
  if (res.mode === 'closed' || (res.mode === 'hint' && atToken()) || (slashUi.dismissed !== null && slashUi.dismissed === v)) {
    closeSlash();
    return false;
  }
  const rows = slash.flat(res);
  const keep = slashUi.mode === res.mode && slashUi.rows.length === rows.length && slashUi.rows.every((r, i) => r === rows[i]);
  slashUi = { mode: res.mode, rows, index: res.mode === 'hint' || !keep ? 0 : Math.min(slashUi.index, Math.max(0, rows.length - 1)), dismissed: slashUi.dismissed };
  const ul = $('complete');
  ul.textContent = '';
  ul.classList.add('rm-cmds');
  completion = { items: [], index: 0, start: -1 };
  if (res.mode === 'bare') {
    let n = 0;
    for (const g of res.groups) {
      if (g.name) {
        const h = document.createElement('li');
        h.className = 'rm-cmd-head';
        h.setAttribute('role', 'presentation');
        h.textContent = g.name;
        ul.append(h);
      }
      for (const c of g.rows) {
        ul.append(cmdRow(c, typed, n++));
      }
    }
  } else if (res.mode === 'list') {
    res.rows.forEach((c, i) => ul.append(cmdRow(c, typed, i)));
  } else if (res.mode === 'hint') {
    ul.append(cmdRow(res.row, typed, 0, { hint: true }));
  } else {
    const li = document.createElement('li');
    li.className = 'rm-cmd rm-cmd-none';
    li.setAttribute('aria-disabled', 'true');
    const a = document.createElement('span');
    a.className = 'rm-cmd-u';
    a.textContent = `No command matches ${res.typed}`;
    const b = document.createElement('span');
    b.className = 'rm-cmd-d';
    b.textContent = 'Type / to see them all.';
    li.append(a, b);
    ul.append(li);
  }
  ul.hidden = false;
  /* the box's width, not the input row's: the row beside it holds the attach and send buttons */
  const boxR = $('compose').getBoundingClientRect();
  const parR = (ul.offsetParent ?? $('compose')).getBoundingClientRect();
  ul.style.left = `${Math.round(boxR.left - parR.left)}px`;
  ul.style.right = `${Math.round(parR.right - boxR.right)}px`;
  input.setAttribute('aria-expanded', 'true');
  const act = ul.querySelector('.is-active');
  if (act) {
    input.setAttribute('aria-activedescendant', act.id);
    act.scrollIntoView({ block: 'nearest' });
  } else {
    input.removeAttribute('aria-activedescendant');
  }
  $('cmdLive').textContent = res.mode === 'list' || res.mode === 'bare' ? `${rows.length} command${rows.length === 1 ? '' : 's'}` : '';
  return true;
}
function fillSlash(i) {
  const cmd = slashUi.rows[i];
  if (!cmd) {
    return;
  }
  const caret = input.selectionStart ?? input.value.length;
  const fill = slash.fillOf(cmd);
  input.value = fill + input.value.slice(caret);
  input.setSelectionRange(fill.length, fill.length);
  slashUi.dismissed = null;
  scheduleDraftSave();
  fitInput();
  refreshCompletion();
}
/** Keys while the list is open. True when the key was used. */
function slashKey(ev) {
  const open = !$('complete').hidden && (slashUi.mode === 'list' || slashUi.mode === 'bare');
  if (!open && slashUi.mode !== 'hint' && slashUi.mode !== 'none') {
    return false;
  }
  if (ev.key === 'Escape') {
    ev.preventDefault();
    slashUi.dismissed = input.value; // keeps the text; the list is back when the text changes
    closeSlash();
    $('complete').hidden = true;
    return true;
  }
  if (!open) {
    return false;
  }
  const n = slashUi.rows.length;
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    slashUi.index = (slashUi.index + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n;
    refreshCompletion();
    return true;
  }
  const row = slashUi.rows[slashUi.index];
  if (ev.key === 'Tab' && !ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
    ev.preventDefault();
    fillSlash(slashUi.index);
    return true;
  }
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey && row && !slash.sendsAsTyped(row, input.value)) {
    ev.preventDefault();
    fillSlash(slashUi.index);
    return true;
  }
  return false; // Enter on a command already typed in full goes on to send
}
/* ==== /SLASH LIST ==== */

function closeCompletion() {
  $('complete').hidden = true;
  closeSlash();
  completion = { items: [], index: 0, start: -1 };
}

/** Offers the ACTIVE seat handles from the roster already held — so a rename
 *  shows up here the moment a room.state (or the poll) lands. */
function refreshCompletion() {
  if (refreshSlash()) {
    return;
  }
  $('complete').classList.remove('rm-cmds');
  $('complete').style.left = '';
  $('complete').style.right = '';
  const tok = document.activeElement === input ? atToken() : null;
  if (!tok) {
    closeCompletion();
    return;
  }
  const handles = orderSeats(state.room, state.seats).map((s) => s.handle);
  const items = handles.filter((h) => h.startsWith(tok.prefix));
  const ul = $('complete');
  ul.textContent = '';
  if (!items.length) {
    closeCompletion();
    return;
  }
  completion = { items, index: Math.min(completion.index, items.length - 1), start: tok.start };
  items.forEach((h, i) => {
    const li = document.createElement('li');
    li.className = 'rm-opt';
    li.setAttribute('role', 'option');
    li.dataset.handle = h;
    li.textContent = `@${h}`;
    if (i === completion.index) {
      li.classList.add('is-active');
    }
    li.addEventListener('mousedown', (ev) => {
      ev.preventDefault(); // keep focus in the input
      acceptCompletion(i);
    });
    ul.append(li);
  });
  ul.hidden = false;
}

function acceptCompletion(i) {
  const h = completion.items[i];
  if (!h) {
    return;
  }
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, completion.start);
  const after = input.value.slice(caret);
  const insert = `@${h} `;
  input.value = before + insert + after;
  const pos = before.length + insert.length;
  input.setSelectionRange(pos, pos);
  closeCompletion();
  scheduleDraftSave();
}

input.addEventListener('input', refreshCompletion);
/* The box grows with what is typed (to its 30vh cap) instead of scrolling a
   one-line window over a paragraph. Two things it must not lose while doing
   it (Owner 2026-09-28, Ctrl+Enter at the bottom of the chat): a line view that
   was at its bottom stays there, and a caret at the end stays visible inside
   the box once it has reached its cap. */
function fitInput() {
  const scroll = $('lineScroll');
  const pinned = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight + 2}px`;
  if (pinned) {
    scroll.scrollTop = scroll.scrollHeight;
  }
  if (input.selectionEnd >= input.value.length) {
    input.scrollTop = input.scrollHeight;
  }
  syncHiScroll(); // CHAR LIMIT [ticket]: the backdrop follows the box's own scroll/resize
}

/* A draft restored while this page is hidden (a background tab, the native
   app still laying out) is measured at zero width and stays one line tall
   (Owner 2026-09-28). Re-fit whenever the box's WIDTH changes (hidden ->
   shown, a resize) and once fonts have loaded. Width only: fitInput changes
   the height, and reacting to that would loop. */
{
  let lastW = -1;
  try {
    new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect?.width ?? 0);
      if (w > 0 && w !== lastW) {
        lastW = w;
        if (input.value) {
          fitInput();
        }
      }
    }).observe(input);
  } catch { /* no ResizeObserver: the input event still fits it */ }
  try {
    document.fonts?.ready?.then(() => { if (input.value) { fitInput(); } }).catch(() => {});
  } catch { /* fonts API absent */ }
}

/** Scroll the box so the caret is visible, wherever it is. A programmatic
 *  insert (Ctrl+Enter) does not scroll a textarea by itself. The caret's
 *  depth is the height of the text up to it, laid out in an invisible
 *  zero-height twin of the box (the box's own value is never touched, so its
 *  undo history survives). */
function caretIntoView() {
  const el = input;
  const end = el.selectionEnd;
  if (end >= el.value.length) {
    el.scrollTop = el.scrollHeight;
    return;
  }
  const twin = el.cloneNode(false);
  twin.removeAttribute('id');
  twin.setAttribute('aria-hidden', 'true');
  twin.tabIndex = -1;
  Object.assign(twin.style, { position: 'absolute', visibility: 'hidden', height: '0px', minHeight: '0px', width: `${el.offsetWidth}px`, left: '0', top: '0' });
  twin.value = el.value.slice(0, end);
  el.parentNode.append(twin);
  const depth = twin.scrollHeight;
  twin.remove();
  const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
  if (depth > el.scrollTop + el.clientHeight) {
    el.scrollTop = depth - el.clientHeight;
  } else if (depth - line < el.scrollTop) {
    el.scrollTop = Math.max(0, depth - line);
  }
}
input.addEventListener('input', fitInput);

/* THE COMPOSER FITS THE GLASS WHILE THE KEYBOARD IS UP [web/room-phone-7].
 * Owner (IMG_7667): an attachment + a few lines of text, and the bottom of the
 * box sat behind the keys where the caret could not reach it: the box grew to
 * its 30vh cap (vh = the LARGE viewport, ~2x the glass with the keys up) and
 * the column simply ran past the visible viewport. With html.kb-up the box's
 * max-height is what is LEFT of --vvh after the header, the reply / help
 * notes, the delivery chips and the composer's own tray + padding, floored
 * at two lines; beyond it the box scrolls inside itself and follows the
 * caret. The tray is one compact row meanwhile (room-attach.css). */
const TA_FLOOR = 44; // two lines of the box's 22px line-height
function capComposer() {
  const root = document.documentElement;
  if (!root.classList.contains('kb-up')) {
    if (root.style.getPropertyValue('--ta-max')) {
      root.style.removeProperty('--ta-max');
    }
    return;
  }
  const vvh = parseFloat(root.style.getPropertyValue('--vvh')) || window.visualViewport?.height || window.innerHeight;
  const outer = (el) => {
    if (!el || el.hidden) {
      return 0;
    }
    const cs = getComputedStyle(el);
    if (cs.display === 'none') {
      return 0;
    }
    return el.getBoundingClientRect().height + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
  };
  const form = $('compose');
  const rest = form.getBoundingClientRect().height - input.getBoundingClientRect().height; // the tray, the note, the padding
  /* the line's scroller keeps its padding at zero height */
  const sc = getComputedStyle($('lineScroll'));
  const scrollMin = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((n, k) => n + (parseFloat(sc[k]) || 0), 0);
  /* everything else in the line column that takes a row (the reply / help
     notes, the delivery chips), and the header above it */
  let rows = 0;
  for (const el of $('roomLine').children) {
    if (el !== form && el.id !== 'lineScroll' && getComputedStyle(el).position !== 'absolute') {
      rows += outer(el);
    }
  }
  const used = outer(document.querySelector('.rm-top')) + outer(document.querySelector('.ph-hdr')) + rows + scrollMin + rest;
  const max = Math.max(TA_FLOOR, Math.floor(vvh - used));
  if (root.style.getPropertyValue('--ta-max') !== `${max}px`) {
    root.style.setProperty('--ta-max', `${max}px`);
  }
}
function fitComposer() {
  capComposer();
  if (document.activeElement === input) {
    caretIntoView();
  }
}
window.addEventListener('room-kb', () => {
  fitInput(); // the cap moved: re-measure the box against it
  fitComposer();
});
input.addEventListener('input', fitComposer);
{
  let queued = false;
  document.addEventListener('selectionchange', () => {
    if (queued || document.activeElement !== input || input.scrollHeight <= input.clientHeight) {
      return;
    }
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      caretIntoView();
    });
  });
  try {
    /* Only a real change of the composer's cap re-shows the caret. The room
       poll re-writes these rows every few seconds (an unchanged `hidden` is
       still a mutation), and pulling the caret into view on each one dragged a
       box the person had scrolled up to read back to the bottom every ~5 s
       (Owner 2026-10-03, phone). */
    const mo = new MutationObserver(() => {
      if (document.documentElement.classList.contains('kb-up')) {
        const before = document.documentElement.style.getPropertyValue('--ta-max');
        capComposer();
        if (document.activeElement === input && document.documentElement.style.getPropertyValue('--ta-max') !== before) {
          caretIntoView();
        }
      }
    });
    for (const id of ['attTray', 'attNote', 'reply', 'help', 'deliveryChips']) {
      mo.observe($(id), { childList: true, attributes: true, attributeFilter: ['hidden'] });
    }
  } catch { /* no MutationObserver: the keyboard and input events still fit it */ }
}
input.addEventListener('click', refreshCompletion);
input.addEventListener('blur', () => setTimeout(closeCompletion, 100));
input.addEventListener('keydown', (ev) => {
  if (slashKey(ev)) {
    return;
  }
  const open = !$('complete').hidden && completion.items.length;
  if (open && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
    ev.preventDefault();
    const n = completion.items.length;
    completion.index = (completion.index + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n;
    refreshCompletion();
    return;
  }
  /* Tab on an EMPTY box with a suggestion fills the last @address; anything
     else (a typed box, Shift+Tab, no suggestion) is the old behavior below. */
  if (ev.key === 'Tab' && !ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !open && input.value === '' && currentTabSuggestion()) {
    ev.preventDefault();
    const fill = currentTabSuggestion();
    input.value = fill;
    input.setSelectionRange(fill.length, fill.length);
    input.dispatchEvent(new Event('input', { bubbles: true })); // the draft, the height, the ghost
    return;
  }
  /* Enter on a handle that is ALREADY typed in full sends the line; otherwise
     "/remove @dead" + Enter would complete @dead to itself instead of sending. */
  const complete = open && completion.items[completion.index] === atToken()?.prefix;
  if (open && (ev.key === 'Tab' || (ev.key === 'Enter' && !complete))) {
    ev.preventDefault();
    acceptCompletion(completion.index);
    return;
  }
  if (open && ev.key === 'Escape') {
    ev.preventDefault();
    closeCompletion();
    return;
  }
  /* PHONE (Owner 2026-09-27): Enter is a NEW LINE and only Send sends: a
     phone keyboard's return key is where a thumb lands mid-thought. Desktop
     keeps Enter = send, Shift+Enter = new line. Ctrl+Enter is a new line too
     (Owner 2026-09-27: the CLI habit), which a textarea does not do by itself,
     so it is inserted here. */
  /* USE ENTER TO SEND = OFF (Owner 2026-10-04,: "I hit
     enter accidentally way too often"): Enter and Shift+Enter are a plain new
     line (the textarea's own), and only Send sends. Ctrl/Cmd+Enter stays as the
     power-user send. Unset (null) or ON falls through to the behavior below. */
  /* ONE KEY RULE with the agent chat (web/enter-pref.mjs enterAction, Owner 2026-10-05):
     Shift+Enter and Ctrl/Cmd+Enter are a new line; Enter sends only when "Use Enter to
     send" is on; a phone's Enter is a new line and only Send sends. */
  const act = enterAction(ev, state.me?.enterSubmits, phoneInput());
  if (act === 'newline') {
    ev.preventDefault();
    const el = ev.target;
    el.setRangeText(String.fromCharCode(10), el.selectionStart, el.selectionEnd, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    caretIntoView();
  } else if (act === 'send') {
    ev.preventDefault();
    closeCompletion();
    submitCompose();
  }
});

/** A phone for the composer's purposes: a coarse (touch) pointer, or the
 *  phone layout. Asked per keystroke, so a rotated tablet or a resized
 *  window follows. */
function phoneInput() {
  return matchMedia('(pointer: coarse)').matches || matchMedia('(max-width: 600px)').matches;
}

/* ----------------------------------------------------------------- push ---- */

function setPush(s) {
  state.push = s;
  document.body.dataset.push = s;
  $('pushNote').hidden = s !== 'unavailable';
}

function startLive() {
  const transport = createTransport();
  let waitTimer = null;
  transport.on('room.subscribed', (m) => {
    if (Array.isArray(m.rooms) && m.rooms.includes(roomId)) {
      clearTimeout(waitTimer);
      setPush('live');
    }
  });
  transport.on('room.line', (m) => {
    if (m.roomId === roomId) {
      addEntries([m.entry]);
    }
  });
  transport.on('room.state', (m) => {
    if (m.roomId === roomId) {
      rememberArt(m.room); // a push carries the SVG: the next poll needs no fetch
      if (m.family) {
        keepUnread(m.family); // a push names no person, so it carries no unread: keep the last
        state.family = m.family;
      }
      state.inherited = m.inherited ?? state.inherited ?? [];
      applyRoom(m.room, m.seats);
      if (Array.isArray(m.panels)) {
        cells?.setPanels(m.panels);
      }
      if ('voice' in m) {
        applyVoice(m.voice);
      }
      if ('voiceGlobal' in m) {
        state.voiceGlobal = m.voiceGlobal;
      }
    }
  });
  /* THE SCRATCHPAD'S COUNTS ARE PER PERSON [scratchpad]: {counts} after this person's own mark-seen (their own windows only), or {changed:true}
     after a new asset or note, when everyone re-reads (the counts differ per person) */
  transport.on('room.scratchpad', (m) => {
    if (m.roomId !== roomId) {
      return;
    }
    if (m.counts) {
      pad?.setCounts(fromEngineCounts(m.counts));
    }
    if (m.changed) {
      void pad?.refresh();
      if (scratchView?.isOpen()) {
        void scratchView.refresh();
      }
    }
  });
  transport.on('room.held', onSeatHeld); // SEAT BADGE: the held queue moved
  transport.on('room.waiting', onSeatWaiting); // SEAT BADGE: the badge set moved
  /* one push per CHANGE, after the entry's room.line (§2.7) */
  transport.on('room.read', (m) => {
    if (m.roomId === roomId && typeof m.entryId === 'number' && typeof m.handle === 'string') {
      mergeReads(m.entryId, { [m.handle]: m.state });
    }
  });
  transport.onStatus((s) => {
    if (s !== 'open') {
      clearTimeout(waitTimer);
      /* The subscription died with the socket: until the next open re-earns
         `live`, the poll backfills the line so an outage is not a frozen page. */
      if (state.push === 'live') {
        setPush('pending');
      }
      return;
    }
    /* EVERY open: the engine's per-socket set died with the old socket. */
    transport.send({ type: 'room.subscribe', rooms: [roomId] });
    clearTimeout(waitTimer);
    waitTimer = setTimeout(() => {
      if (state.push !== 'live') {
        setPush('unavailable'); // this engine has no room push yet: poll instead
      }
    }, SUBSCRIBE_WAIT_MS);
    void backfill(); // whatever landed while the socket was down
    void refreshReads(); // and read changes pushed while it was down: re-GET is truth
  });
  return transport;
}

/* ----------------------------------------------------------------- poll ---- */

/* Re-read the newest page for its `reads` (the source of truth after a
   reconnect, §2.7). addEntries merges reads into entries already drawn. */
async function refreshReads() {
  const r = await api(`/api/rooms/${encodeURIComponent(roomId)}/line?limit=${PAGE}`).catch(() => null);
  if (r?.ok && Array.isArray(r.body?.entries)) {
    addEntries(r.body.entries);
  }
}

let pollCount = 0;
let draftTick = 0;
let lastHiddenFetch = 0;
async function poll() {
  tickDeviceReport('room'); // throttled to ~60 s while visible; the page's one poll carries it, no second timer
  /* [perf/poll-traffic] a background shell tab is a display:none iframe that
     still reads visibilityState 'visible': the shell's word counts too.
     Hidden is not silent: this page is the only source of the room's ring in
     the shell (hwbRoomModel / hwbState come out of fetchRoom), so a hidden tab
     still refreshes the room state, at most every HIDDEN_POLL_MS (its ring is
     up to that old), a fraction of the visible traffic. The rest of the poll
     (backfill, reads) stays off until the tab is shown. */
  if (isHidden()) {
    if (navigator.onLine === false || Date.now() - lastHiddenFetch < HIDDEN_POLL_MS) {
      return;
    }
    lastHiddenFetch = Date.now();
    await fetchRoom().catch(() => {});
    return;
  }
  const got = await fetchRoom().catch(() => null);
  /* an open, visible page fires no focus event [ticket]: the room answer carries
     this person's draft stamp, so a change reads the draft at once; an engine
     that sends no stamp (older) keeps the every-4th-tick (~10 s) read */
  if (!onDraftStamp(got?.body && 'draftUpdatedAt' in got.body ? got.body.draftUpdatedAt : undefined)) {
    draftTick += 1;
    if (draftTick % 4 === 0) {
      void syncDraft(DRAFT_TICK_MS);
    }
  }
  if (state.push !== 'live') {
    await backfill().catch(() => {});
    /* no push = no room.read either: re-read reads every ~10 s while any held
       entry still has an answer that can change (not-yet, or can't-tell) */
    pollCount += 1;
    const open = [...state.entries.values()].some((e) => e.reads && Object.values(e.reads).some((v) => v !== 'seen'));
    if (open && pollCount % 4 === 0) {
      await refreshReads();
    }
  }
}

/* ---------------------------------------------------------------- boot ---- */

/* ---------------------------------------------------------- add member ---- */

/* ==== ROOM ADD SHEET (the design system room-add-sheet-v1) ====
   THE ROOM'S ONE ADD BUTTON: the + sheet with this room fixed and the lead
   kept. Agents: live tabs are seated, projects added AND started (the old A2
   form is cut: a project that isn't running is a row there). Apps: the
   catalog with each app's state for this room. */
function addMembers(scope = 'seats', tab) {
  if (!state.room) {
    return;
  }
  if (isBasic()) {
    scope = null; // BASIC: the one + opens the old three tabs minus Workgroups: Agents, Apps [basic]
  }
  /* [rail split] (Owner 2026-10-05, the design system [ref]): the Room cell's + = Workgroup | App; the Seats cell's + = Add | Move.
     Apps belong to the WHOLE family, so the Room cell's + always targets the MAIN room, whichever row is selected. */
  const head = scope === 'room' && state.room.parent_id && state.family?.parent
    ? { id: state.family.parent.id, name: state.family.parent.name, color: state.family.parent.color, state: 'open', seats: [] }
    : { ...state.room, seats: state.seats };
  openAddSheet({
    room: head,
    scope,
    family: state.family,
    tab: tab === 'apps' ? 'apps' : tab === 'workgroups' ? 'workgroups' : tab === 'move' ? 'move' : 'agents',
    onSeated: () => void fetchRoom(),
    /* a NEW agent from a project, started straight into the room: the same
       landing as a seat's own Start (seatAct) */
    onStarted: async (seat, path, answer) => {
      addEntries(answer?.entries);
      await fetchRoom();
      select(seat.id, { focus: true, url: path || null });
    },
    onRoomChanged: () => void fetchRoom(),
    /* a WORKGROUP was made (the Workgroups tab): the rail shows it after the re-GET;
       the toast (or the sheet's Open workgroup) goes there */
    onWorkgroup: async (ans, open) => {
      await fetchRoom();
      const id = ans?.room?.id;
      if (!id) {
        return;
      }
      if (open) {
        goToRoom(id);
        return;
      }
      menuToast(`Created ${ans.room.name}`, 'Open', () => {
        goToRoom(id);
      });
    },
    applied: async (body) => {
      addEntries(body?.entries);
      await fetchRoom();
    },
  }).catch((e) => {
    showReply('error', (el) => {
      el.textContent = `could not open Add — ${e?.message ?? e}`;
    });
  });
}
/* ==== /ROOM ADD SHEET ==== */
$('addBtn').addEventListener('click', () => addMembers('seats'));
$('roomAddBtn').addEventListener('click', () => addMembers('room'));
/* STAY PINNED WHEN THE LINE CHANGES SIZE (the design system, item 5 (c)). The delivery
   note, a reply, the composer growing and the phone roster all take height
   from the scroll area BELOW its content; a reader at the bottom must stay at
   the bottom, or the newest entry is cut in half. Pinned-ness is recorded on
   every scroll (not measured after the shrink, when it is already lost) and
   re-applied on every resize of the scroll box. */
{
  const scroll = $('lineScroll');
  let pinnedNow = true;
  /* a deliberate jump (search) leaves the bottom: the content that paged in just before it changed the box size, so the scroll
     that follows would read as "the layout" and be pinned back; the jump says so first [search ui] */
  lineUnpin = () => {
    pinnedNow = false;
    lastH = scroll.scrollHeight;
    lastCH = scroll.clientHeight;
  };
  let lastH = scroll.scrollHeight;
  let lastCH = scroll.clientHeight;
  const repin = () => {
    lastH = scroll.scrollHeight;
    lastCH = scroll.clientHeight;
    if (pinnedNow) {
      scroll.scrollTop = scroll.scrollHeight;
    }
  };
  scroll.addEventListener('scroll', () => {
    /* A scroll that coincides with a SIZE change is the layout (the browser
       clamping or anchoring while the box shrinks and entries land), not the
       reader, and must not decide pinned-ness: it once landed 42 px from the
       bottom, over the threshold, mid-send. Only a scroll at a stable size is
       the reader's. */
    if (scroll.scrollHeight !== lastH || scroll.clientHeight !== lastCH) {
      repin();
      return;
    }
    pinnedNow = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
  }, { passive: true });
  if (typeof ResizeObserver === 'function') {
    /* Both sides: the BOX shrinking (a note, a reply, the composer) and the
       CONTENT growing after an entry is drawn (a read line arriving on a
       room.read push, a merge on re-GET). */
    const ro = new ResizeObserver(repin);
    ro.observe(scroll);
    ro.observe($('line'));
  }
}

async function showPicker() {
  $('main').hidden = true;
  $('picker').hidden = false;
  const r = await api('/api/rooms');
  const ol = $('roomList');
  for (const v of Array.isArray(r.body) ? r.body : []) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `/room.html?room=${encodeURIComponent(v.room.id)}`;
    a.textContent = `${v.room.name} (${v.seats.length} seat${v.seats.length === 1 ? '' : 's'})`;
    li.append(a);
    ol.append(li);
  }
}

/* ------------------------------------------------ ROOM ON PHONE v1 ---- */

/* the design system room-phone-v1 (≤600px only; desktop keeps the column): the LINE is
 * home. An agent or an app is a full-screen LAYER that slides over it (‹ Line,
 * the title, ⇄ Switch; a swipe from the left edge goes back). Home carries a
 * header (room glyph, name, "N agents · M apps", Apps / Agents) and a JUMP
 * STRIP: agents that need you, then the apps, then the other agents by their
 * latest line. Lists are bottom SHEETS built from the desktop column's own
 * rows, so rows, glyphs and words cannot drift. */

const PHONE_Q = matchMedia('(max-width: 600px)');
const isPhone = () => PHONE_Q.matches;

const appId = (panelId) => `app:${panelId}`;
function appOf(id) {
  if (typeof id !== 'string' || !id.startsWith('app:')) {
    return null;
  }
  return cells?.list().find((p) => p.id === id.slice(4)) ?? null;
}

/** An app as a row of the desktop column's shape (sheets only). */
function renderAppRow(list, p) {
  const li = rowShell(appId(p.id), p.title);
  li.classList.add('seat-app');
  const glyph = document.createElement('span');
  glyph.className = 'seat-glyph';
  glyph.append(cells.iconSvg(p.icon));
  const top = document.createElement('div');
  top.className = 'seat-top';
  const name = document.createElement('span');
  name.className = 'seat-handle';
  name.style.fontFamily = 'var(--font)';
  name.style.fontWeight = '600';
  name.textContent = p.title;
  top.append(name);
  const meta = document.createElement('div');
  meta.className = 'seat-meta';
  meta.append(...appMeta(p, 'room app'));
  li.append(glyph, top, meta);
  if (p.count) {
    const side = document.createElement('div');
    side.className = 'seat-side';
    side.append(countBadge(p.count, `${p.count} in ${p.title}`));
    li.append(side);
  }
  list.append(li);
}

/* THE JUMP STRIP [phone rail] (Owner 2026-10-08): Workbench first, then this room's apps, then its seats (needs-you first). NO rooms on it (Owner:
   "not have the rooms on the rail"): the other rooms are one tap away on the Workbench and in the people button's sheet. The four-square button shows / hides it. */
/* THE WORKBENCH CHIP OPENS THE PLACES SHEET [workbench sheet] (Owner 2026-10-08, relayed by cli-manager [ref]): in a room or workgroup the rail's Workbench chip opens
   the phone's bottom sheet, WORKBENCH: a "Full Workbench" row on top (goes to the Workbench page), then Rooms (the other open rooms), then the live agents that
   sit in no room. Outside a room (the Workbench page itself) nothing changes: its own four-square already opens the same sheet there. */
const places = createPlaces({
  roomId,
  hidden: () => state.me?.hiddenRooms ?? null,
  recipeColor: (id) => recipesById?.get(id)?.color || null,
  recipeName: (id) => recipesById?.get(id)?.name || null,
  onChange: () => {
    if (!$('phSheet').hidden && openSheetKind === 'places' && !seatMenu.holding() && !panelMenu.holding()) {
      fillSheet('places');
    }
  },
});
function workbenchChip() {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ph-chip ph-places';
  b.setAttribute('role', 'listitem');
  b.title = 'Workbench: all your rooms and sessions';
  b.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>';
  b.append('Workbench');
  b.addEventListener('click', () => openSheet('places'));
  return b;
}
/** The phone rail's Scratchpad chip (full edition only): the Scratchpad replaced the Assets app, so the rail must lead to it [phone pad chip].
 *  It opens the same list the Agents sheet's Scratchpad section opens (Assets first). */
function padChip(isNew) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ph-chip ph-padchip';
  b.dataset.go = 'scratchpad';
  b.setAttribute('role', 'listitem');
  b.title = isNew ? 'Scratchpad: something is new' : 'Scratchpad: assets and notes';
  b.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="4" width="14" height="16" rx="2"/><path d="M8.5 9h7M8.5 12.5h7M8.5 16h4"/></svg>';
  b.append('Scratchpad');
  if (isNew) {
    const d = document.createElement('span');
    d.className = 'dot';
    b.append(d);
  }
  b.addEventListener('click', () => scratchView?.open('assets'));
  return b;
}
/** The latest line id each seat wrote: "recent activity" for the strip. */
function lastSpoke() {
  const m = new Map();
  for (const e of state.entries.values()) {
    if (e.author_seat) {
      m.set(e.author_seat, Math.max(m.get(e.author_seat) ?? 0, e.id));
    }
  }
  return m;
}

let stripSig = '';
function renderPhone() {
  if (!state.room || !cells) {
    return;
  }
  const seats = orderSeats(state.room, state.seats);
  const lead = leadIdOf(state.room, state.seats);
  const apps = cells.list().filter((p) => !pad || !isAssetsPanel(p)); // the Scratchpad replaces the Assets app (full edition)
  /* seen is still blocked (window-chrome v33, ticket): it still sorts first
     and keeps its dot — only the alarm was silenced, not the ask */
  const needs = (s) => seatChrome(s) === 'waiting' || seatChrome(s) === 'waiting-seen';
  /* header */
  const g = $('phGlyph');
  g.textContent = '';
  g.append(roomGlyph(22));
  /* THE PHONE'S TITLE [layers] (the design system): a phone has no tab, so the project's name lives here: "Project › Workgroup", the project in the
     dimmer ink and the workgroup in the strong one; when it does not fit, the project shortens first. */
  {
    const pn = $('phName');
    const proj = state.room.parent_id ? state.family?.parent?.name ?? null : null;
    const key = `${proj ?? ''}|${state.room.name}`;
    if (pn.dataset.k !== key) {
      pn.dataset.k = key;
      pn.textContent = '';
      if (proj) {
        const a = document.createElement('span');
        a.className = 'pn-proj';
        a.textContent = proj;
        const sep = document.createElement('span');
        sep.className = 'pn-sep';
        sep.setAttribute('aria-hidden', 'true');
        sep.textContent = '›';
        const w = document.createElement('span');
        w.className = 'pn-wg';
        w.textContent = state.room.name;
        pn.append(a, sep, w);
      } else {
        pn.textContent = state.room.name;
      }
      pn.title = proj ? `${proj} › ${state.room.name}` : state.room.name;
    }
  }
  if (!$('phBrief').firstChild) {
    $('phBrief').append(briefButton('Room brief', (b) => showBrief(state.room, b))); // [room brief] the (i) in the phone header; the flyout reads the room by id when opened
  }
  /* two deliberate lines, never a wrap mid-phrase; no apps = no apps line */
  const metaLines = [`${seats.length} agent${seats.length === 1 ? '' : 's'}`, ...(apps.length ? [`${apps.length} app${apps.length === 1 ? '' : 's'}`] : [])];
  if ($('phMeta').dataset.sig !== metaLines.join('|')) {
    $('phMeta').dataset.sig = metaLines.join('|');
    $('phMeta').replaceChildren(...metaLines.map((t) => mk('span', null, t)));
  }
  const anyNeeds = seats.some(needs);
  const padNew = (pad?.newTotal() ?? 0) > 0; // something new in the Scratchpad: its lines are in the agents sheet [scratchpad]
  $('phAgentsDot').hidden = !(anyNeeds || padNew);
  $('phAgents').title = anyNeeds ? 'Agents · one needs you' : padNew ? 'Agents · new in the Scratchpad' : 'Agents';
  if (!$('phStrip').hidden) {
    const spoke = lastSpoke();
    const others = seats.filter((s) => !needs(s)).sort((a, b) => (spoke.get(b.id) ?? 0) - (spoke.get(a.id) ?? 0));
    const order = [['wb'], ...(pad ? [['pad']] : []), ...apps.map((p) => ['app', p]), ...seats.filter(needs).map((s) => ['seat', s]), ...others.map((s) => ['seat', s])];
    const sig = JSON.stringify(order.map(([k, x]) => (k === 'wb' ? 'wb' : k === 'pad' ? ['pad', padNew] : [k, x.id, k === 'seat' ? [x.handle, seatChrome(x), x.status, x.id === lead] : [x.title, x.icon]])));
    if (sig !== stripSig) {
      stripSig = sig;
      const strip = $('phStrip');
      const keep = strip.scrollLeft;
      strip.textContent = '';
      for (const [k, x] of order) {
        if (k === 'wb') {
          strip.append(workbenchChip());
          continue;
        }
        if (k === 'pad') {
          strip.append(padChip(padNew));
          continue;
        }
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ph-chip';
        b.setAttribute('role', 'listitem');
        if (k === 'seat') {
          b.dataset.go = x.id;
          b.dataset.seat = x.id; // its project ink on the @handle [web/room-phone-7b]
          b.append(seatGlyph(x, lead, 24));
          const h = document.createElement('span');
          h.className = 'h';
          h.textContent = `@${x.handle}`;
          b.append(h);
          if (needs(x)) {
            const d = document.createElement('span');
            d.className = 'dot';
            b.append(d);
            b.title = `@${x.handle} needs you`;
          }
        } else {
          b.dataset.go = appId(x.id);
          b.append(cells.iconSvg(x.icon), x.title);
        }
        b.addEventListener('click', () => select(b.dataset.go, { focus: true }));
        strip.append(b);
      }
      strip.scrollLeft = keep;
    }
  }
  paintLayerBar();
  paintDeliveryChips(); // a seat's activity moved: its chip under the line follows
  if (!$('phSheet').hidden && !seatMenu.holding() && !panelMenu.holding()) {
    fillSheet(openSheetKind); // keep an open sheet's rows current
  }
}

function paintLayerBar() {
  const n = roomUnread();
  $('lyMissed').textContent = String(n);
  $('lyMissed').hidden = !n;
  $('lyBack').setAttribute('aria-label', n ? `Back to the room, ${n} new` : 'Back to the room');
  const seat = state.seats.find((s) => s.id === state.sel);
  const app = appOf(state.sel);
  const t = $('lyTitle');
  t.classList.toggle('h', !!seat);
  /* the same glyph as the row you came from (the design system): plate + ring, or the app's icon */
  const g = $('lyGlyph');
  g.textContent = '';
  if (seat) {
    g.append(seatGlyph(seat, leadIdOf(state.room, state.seats), 28));
  } else if (app) {
    g.append(cells.iconSvg(app.icon));
  }
  if (seat) {
    t.textContent = `@${seat.handle}`;
    const spec = seatRingSpec(seat);
    const held = heldParts(seat);
    const why = blockedReason(seat);
    const status = why ? `needs you: ${why}` : spec && spec.state === 'alert' ? hwbRingLabel(spec) : seatChrome(seat) === 'waiting' ? 'needs you' : seatChrome(seat) === 'waiting-seen' ? 'needs you, seen' : STATUS_TEXT[seat.status] ?? seat.status;
    $('lySub').textContent = `${status}${held ? ` · ${held.text}` : ''}`;
  } else if (app) {
    t.textContent = app.title;
    $('lySub').replaceChildren(...appMeta(app, ''));
  }
  $('lyAdd').hidden = !(app && (app.uploads === true || cells?.canAdd(app.id) === true));
}

/* ---- sheets ---- */
let openSheetKind = null;
function fillSheet(kind) {
  const body = $('phSheetBody');
  const keep = body.scrollTop;
  body.textContent = '';
  const seats = orderSeats(state.room, state.seats);
  const lead = leadIdOf(state.room, state.seats);
  const section = (title) => {
    const h = document.createElement('h3');
    h.textContent = title;
    const ol = document.createElement('ol');
    ol.setAttribute('role', 'listbox');
    ol.setAttribute('aria-label', title);
    body.append(h, ol);
    return ol;
  };
  if (kind === 'places') {
    places.fill(body, section); // [workbench sheet] Full Workbench, Rooms, Live agents
  }
  if (kind === 'all') {
    renderRoomRow(section('Switch to'));
  }
  const appsSection = () => {
    const apps = (cells?.list() ?? []).filter((p) => !pad || !isAssetsPanel(p)); // the Scratchpad replaces the Assets app (full edition)
    if (kind === 'agents' && !apps.length) {
      return; // the menu has no empty Apps heading
    }
    const ol = section('Apps');
    for (const p of apps) {
      renderAppRow(ol, p);
      panelMenu.decorateRow(ol.lastElementChild, p.id); // PANEL CELL MENU
    }
    if (!apps.length) {
      const e = document.createElement('p');
      e.className = 'rm-addnote';
      e.style.padding = '8px 16px 14px';
      e.textContent = 'No apps in this room yet.';
      body.append(e);
    }
  };
  if (kind === 'all' || kind === 'apps') {
    appsSection();
  }
  if (kind === 'all' || kind === 'agents') {
    /* THE SAME SPLIT AS THE RAIL [rail split] (Owner 2026-10-05): a Rooms section on top (the room row, its workgroups,
       their unread badges) and "Seats - <room>" below, each with its own "+" (Workgroup | App; Add | Move) */
    const split = kind === 'agents';
    if (split && pad) {
      /* THE SCRATCHPAD'S TWO LINES, first in the sheet (the design system 1.C V2.1): a tap closes the sheet and opens that list as the full-screen
         layer (the preview column is the layer on a phone); the agents button wears its dot while anything is new */
      const pol = section('Scratchpad');
      pol.classList.add('ph-pad');
      for (const k of ['assets', 'notes']) {
        const c = pad?.counts()[k] ?? { n: 0, m: null };
        const li = document.createElement('li');
        const b = mk('button', 'ph-padrow');
        b.type = 'button';
        b.dataset.kind = k;
        b.dataset.new = c.n > 0 ? '1' : '0';
        b.append(mk('span', 'pk', k === 'assets' ? 'Assets' : 'Notes'), mk('span', 'pn', c.m === null ? '' : lineText(c.n, c.m)), mk('span', 'pc', '›'));
        b.addEventListener('click', () => {
          closeSheet();
          scratchView?.open(k);
        });
        li.append(b);
        pol.append(li);
      }
    }
    const rooms = split ? section('Rooms') : null;
    if (split && isBasic()) {
      renderRoomRow(rooms); // BASIC: the room's own row, no workgroup tree and no Workgroup | App "+" [basic]
    } else if (split) {
      renderFamilyTree(rooms);
      const radd = mk('button', 'cell-hadd', '+');
      radd.type = 'button';
      radd.title = 'Add a workgroup or an app';
      radd.setAttribute('aria-label', 'Add a workgroup or an app');
      radd.addEventListener('click', () => {
        closeSheet();
        $('roomAddBtn').click();
      });
      const rh3 = rooms.previousElementSibling;
      rh3.classList.add('ph-h3add');
      const rg = mk('span', 'ph-h3btns');
      rg.append(radd);
      rh3.append(rg);
    }
    const ol = section(split ? 'Seats' : 'Agents'); // [layers] "Seats" and nothing else: the room's name is not repeated
    for (const s of seats) {
      renderSeatRow(ol, s, lead);
    }
    if (kind === 'agents') {
      /* the same compact "+" as the column's seats header (Owner, room line [ref]) */
      const add = mk('button', 'cell-hadd', '+');
      add.type = 'button';
      add.title = 'Add or move a seat';
      add.setAttribute('aria-label', 'Add or move a seat');
      add.addEventListener('click', () => {
        closeSheet();
        $('addBtn').click(); // the same one add flow as the column
      });
      const rec = $('reconnectBtn').cloneNode(true); // the same Reconnect room (Owner 2026-10-02)
      rec.removeAttribute('id');
      rec.hidden = !state.actions.includes('reconnect');
      rec.disabled = state.cycling;
      rec.addEventListener('click', () => {
        closeSheet();
        void reconnectAgents();
      });
      const h3 = ol.previousElementSibling;
      h3.classList.add('ph-h3add');
      const grp = mk('span', 'ph-h3btns');
      grp.append(rec, add);
      /* [concierge] the phone header is full: its icon rides the Agents sheet's top row */
      if (cgModule) {
        const cg = cgModule.conciergeButton('cell-hadd');
        cg.addEventListener('click', () => closeSheet());
        grp.prepend(cg);
      }
      h3.append(grp);
    }
  }
  /* the line's filter: its own sheet from home, and the last section of
     ⇄ Switch (the design system: never back on home as a row of controls) */
  if (kind === 'filter' || kind === 'all') {
    const ol = section(kind === 'all' ? 'Filter the chat' : 'Show in the chat');
    const opts = [...Object.keys(WHO_LABEL), ...seats.map((x) => x.id)];
    for (const who of opts) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ph-frow hwb-lift'; // selected = lifted (window-chrome v31), no bar
      b.dataset.who = who;
      b.setAttribute('aria-pressed', String(state.seatFilter === who));
      b.textContent = who in WHO_LABEL ? WHO_LABEL[who][0].toUpperCase() + WHO_LABEL[who].slice(1) : whoLabel(who);
      b.addEventListener('click', () => {
        setWho(who);
        select('room'); // closes the sheet, and the line is where a filter shows
      });
      li.append(b);
      ol.append(li);
    }
    if (kind === 'filter') {
      filterUi?.sheetSections(body); // the design system room-filter-v1: the same three sections as desktop's menu
    }
  }
  body.scrollTop = keep;
}
function openSheet(kind) {
  openSheetKind = kind;
  fillSheet(kind);
  $('phScrim').hidden = false;
  $('phSheet').hidden = false;
  $('phSheet').setAttribute('aria-label', { all: 'Switch', apps: 'Apps', agents: 'Agents', filter: 'Filter the chat', places: 'Workbench' }[kind]);
  $('phSheet').querySelector('.seat.sel, .seat')?.focus({ preventScroll: true });
}
function closeSheet() {
  if (openSheetKind) {
    window.dispatchEvent(new Event('room:overlay-closed')); // zoom guard
  }
  openSheetKind = null;
  $('phScrim').hidden = true;
  $('phSheet').hidden = true;
}
/* THE RAIL TOGGLE [phone rail]: the strip is hidden by default on a phone and the four-square button shows / hides it. Not persisted: a
   reload hides it again. The keyboard's own auto-hide (room.css html.kb-up) still applies while it is shown. */
function setLineShown(on) {
  $('phStrip').hidden = !on;
  const b = $('phLine');
  b.setAttribute('aria-pressed', String(on));
  const word = on ? 'Hide rooms, apps & seats' : 'Show rooms, apps & seats';
  b.title = word;
  b.setAttribute('aria-label', word);
  if (on) {
    stripSig = '';
    renderPhone();
  }
}
$('phLine').addEventListener('click', () => setLineShown($('phStrip').hidden));
$('phFilter').addEventListener('click', () => openSheet('filter'));
$('phAgents').addEventListener('click', () => openSheet('agents'));
mountTouchUi();
paintTwKeys();
mountDialogKeyboard();
$('lySwitch').addEventListener('click', () => openSheet('all'));
$('lyAdd').addEventListener('click', () => {
  const app = appOf(state.sel);
  if (app) {
    cells.pickFile(app.id);
  }
});
$('phScrim').addEventListener('click', closeSheet);
$('lyBack').addEventListener('click', () => select('room'));
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !$('phSheet').hidden) {
    closeSheet();
  }
});

/* swipe from the left edge = back to the line */
{
  let x0 = null;
  let y0 = 0;
  const edge = $('lyEdge');
  edge.addEventListener('touchstart', (e) => {
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
  }, { passive: true });
  edge.addEventListener('touchmove', (e) => {
    if (x0 === null) {
      return;
    }
    const dx = e.touches[0].clientX - x0;
    const dy = Math.abs(e.touches[0].clientY - y0);
    if (dx > 60 && dx > dy * 1.5) {
      x0 = null;
      select('room');
    }
  }, { passive: true });
  edge.addEventListener('touchend', () => { x0 = null; }, { passive: true });
}


/* the phone layout comes and goes (rotation, a resized window): an app layer
   exists only on the phone, so leaving it returns to the line */
PHONE_Q.addEventListener('change', () => {
  if (!isPhone() && appOf(state.sel)) {
    select('room');
  } else {
    select(state.sel);
  }
});

/* ------------------------------------------------ room cycle [ticket] ---- */

/* DISCONNECT / RECONNECT (Owner 2026-09-27: a Claude Code update needs every
 * claude restarted). Disconnect ends every seat's live pane (the room, its
 * seats and its line stay); reconnect brings each back into its SAME
 * conversation. Both are HUMAN-only on the engine (the cookie; this page sends
 * no bearer). The engine may report an ORPHAN per seat: a claude still running
 * after its pane ended. It never kills one, and this page says so plainly. */

let toldActions = null;
function setActions(list) {
  state.actions = list.filter((a) => a === 'disconnect' || a === 'reconnect');
  /* the Seats header's button and the phone Agents sheet's copy (Owner 2026-10-02, room line [ref]) */
  for (const rb of document.querySelectorAll('.cell-hrec')) {
    rb.hidden = !state.actions.includes('reconnect');
    rb.disabled = state.cycling;
  }
  /* the shell's room-tab ✕ offers Disconnect only while there is one to do */
  const sig = state.actions.join(',');
  if (EMBEDDED && sig !== toldActions) {
    toldActions = sig;
    window.parent.postMessage({ hwbRoomActions: state.actions }, '*');
  }
}

function showCycle(title, lines, orphan) {
  select('room');
  showReply('cycle', (el) => {
    el.classList.toggle('has-orphan', !!orphan);
    const box = document.createElement('div');
    box.className = 'rm-cycleres';
    const t = document.createElement('b');
    t.textContent = title;
    box.append(t);
    for (const [handle, text, cls] of lines) {
      const d = document.createElement('div');
      d.className = `cy-seat${cls ? ` ${cls}` : ''}`;
      const h = document.createElement('span');
      h.className = 'h';
      h.textContent = `@${handle}`;
      d.append(h, ` ${text}`);
      box.append(d);
    }
    el.append(box);
    if (!state.cycling) {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'rm-cancel';
      x.textContent = 'Dismiss';
      x.addEventListener('click', clearReply);
      el.append(x);
    }
  });
}

async function disconnectAgents() {
  if (state.cycling) {
    return;
  }
  state.cycling = true;
  setActions(state.actions);
  showCycle('Disconnecting agents…', [], false);
  let r;
  try {
    r = await api(`/api/rooms/${encodeURIComponent(roomId)}/disconnect`, { json: {} });
  } catch (e) {
    r = { ok: false, status: 0, body: { error: e?.message ?? String(e) } };
  }
  state.cycling = false;
  if (!r.ok) {
    showReply('error', (el) => {
      el.textContent = `agents not disconnected — ${r.body?.error ?? `HTTP ${r.status}`}`;
    });
    await fetchRoom();
    return;
  }
  addEntries(r.body?.entries);
  const lines = [];
  let orphans = 0;
  let ended = 0;
  for (const s of r.body?.seats ?? []) {
    if (s.result === 'disconnected') {
      ended++;
      dropFrame(s.seat);
      lines.push([s.handle, 'disconnected: its conversation is kept for Reconnect', '']);
    } else if (s.result === 'failed') {
      lines.push([s.handle, `NOT disconnected — ${s.error ?? s.reason ?? 'failed'}`, 'cy-fail']);
    } else {
      lines.push([s.handle, `untouched${s.reason ? ` (${s.reason})` : ''}`, '']);
    }
    if (s.orphan && typeof s.orphan === 'object') {
      orphans++;
      lines.push([s.handle, `still has a claude running: pid ${s.orphan.pid} (${s.orphan.state}). The engine never kills it; end it yourself before Reconnect.`, 'cy-orphan']);
    } else if (s.result === 'disconnected' && s.orphan === null) {
      lines.push([s.handle, 'could not tell whether a claude is still running after it', 'cy-orphan']);
    }
  }
  const n = typeof r.body?.ended === 'number' ? r.body.ended : ended;
  showCycle(`Disconnected ${n} agent${n === 1 ? '' : 's'}${orphans ? ` · ${orphans} still running` : ''}. The room, its seats and its chat stay.`, lines, orphans > 0);
  await fetchRoom();
}

/** Wait until the seat's pane is live (the attach ran --resume), or give up. */
async function waitLive(seatId, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await new Promise((res) => setTimeout(res, 1000));
    await fetchRoom();
    if (state.seats.find((x) => x.id === seatId)?.occupant?.state === 'live') {
      return true;
    }
  }
  return false;
}

async function reconnectAgents() {
  if (state.cycling) {
    return;
  }
  state.cycling = true;
  setActions(state.actions);
  showCycle('Reconnecting agents…', [], false);
  let r;
  try {
    /* browser placement: the engine opens no window and adds no tab; THIS page
       attaches each pane (the attach is what runs --resume) */
    r = await api(`/api/rooms/${encodeURIComponent(roomId)}/reconnect`, { json: { target: 'tab', surface: 'browser' } });
  } catch (e) {
    r = { ok: false, status: 0, body: { error: e?.message ?? String(e) } };
  }
  if (!r.ok) {
    state.cycling = false;
    showReply('error', (el) => {
      el.textContent = `agents not reconnected — ${r.body?.error ?? `HTTP ${r.status}`}`;
    });
    await fetchRoom();
    return;
  }
  const res = r.body?.seats ?? [];
  const lines = [];
  const todo = res.filter((s) => s.result === 'restoring');
  let done = 0;
  /* ONE AFTER ANOTHER, like the engine: two resumes racing into one project is
     the double-resume hazard (assemble-room F11). Each seat's frame attaches;
     the next waits until that one is live (or 20 s). */
  for (const s of todo) {
    showCycle(`Reconnecting ${done + 1} of ${todo.length}: @${s.handle}…`, lines, false);
    const seat = state.seats.find((x) => x.id === s.seat) ?? { id: s.seat, handle: s.handle };
    const url = typeof s.url === 'string' && s.url.startsWith('/') ? s.url : seatUrl({ ...seat, occupant: { id: s.paneid } });
    if (url) {
      ensureFrame(seat, url);
    }
    const live = url ? await waitLive(s.seat, 20000) : false;
    done++;
    lines.push([s.handle, live ? 'reconnected into its same conversation' : 'still coming up: select it to watch', live ? '' : 'cy-orphan']);
  }
  for (const s of res) {
    if (s.result === 'already-live') {
      lines.push([s.handle, 'was already live', '']);
    } else if (s.result === 'not-restorable') {
      lines.push([s.handle, `not reconnected${s.reason ? ` (${s.reason})` : ''}`, '']);
    }
  }
  state.cycling = false;
  showCycle(`Reconnected ${todo.length} agent${todo.length === 1 ? '' : 's'}.`, lines, false);
  await fetchRoom();
}

$('reconnectBtn').addEventListener('click', () => void reconnectAgents());

/* ------------------------------------------- ROOM SETTINGS (round 3) ---- */

/* the design system room-round3-v1 §3: the ⚙ (36px, top right of the room header; the
 * phone header's on a phone) opens "Room settings" in the PREVIEW column.
 * Two groups: the DEFAULT FEED (the line filter the room opens on, and what
 * Reset returns to) and the ROOM COLOUR. Both live on the room in the engine
 * (PATCH /api/rooms/:id/settings, a person's credential only).
 *
 * THE ROOM COLOUR is identity, never function: one pick sets --room-c and
 * room.css derives five tones with PINNED lightness (tab, ink .82, wash .27,
 * tint .30, edge .45), so any pick keeps contrast. Send, links, focus and
 * status keep their teal / sky / amber / coral. Unset = the lead seat's
 * project colour (today's room tab), neutral with no lead. */
const NEUTRAL_ROOM = '#5a6672'; // shell.html's NEUTRAL_BASE: a room with no lead
const SWATCHES = ['#1f8fa6', '#0dab49', '#1f5fbf', '#ba08b4', '#d9622b', '#c9a227', '#5b6bd6', '#b83b5e'];
const TONES = ['tab', 'ink', 'wash', 'tint', 'edge'];

function leadColor() {
  const lead = state.seats.find((s) => s.id === state.room?.lead_seat);
  return (lead && recipesById?.get(lead.recipe_id)?.color) || null;
}
function paintRoomColor() {
  const c = state.room?.color || leadColor() || NEUTRAL_ROOM;
  document.body.style.setProperty('--room-c', c);
  document.body.dataset.roomColor = state.room?.color ? 'set' : 'inherited';
  paintSeatTones(); // the recipes (project colours) just landed or changed
  /* ROOM CHARACTER [rooms/character]: the line's wash + art, the header mark, the accent guard */
  paintRoomCharacter(state.room, c);
  paintInherit?.();
  paintWgs?.();
}

let preview = null;

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

async function saveSettings(patch, msg) {
  /* a Dark/Light flip on an INHERITED palette: the mode needs a palette of this room's own, so
     it takes the main room's with it (becoming this workgroup's override) [workgroup design] */
  if (patch.pal_mode !== undefined && patch.pal === undefined && (state.inherited ?? []).includes('pal') && state.room?.pal) {
    patch = { ...patch, pal: state.room.pal };
  }
  msg.textContent = 'Saving…';
  msg.dataset.kind = '';
  try {
    const r = await api(`/api/rooms/${encodeURIComponent(roomId)}/settings`, { method: 'PATCH', json: patch });
    if (!r.ok || !r.body?.room) {
      msg.textContent = `Not saved: ${r.body?.error ?? `HTTP ${r.status}`}`;
      msg.dataset.kind = 'error';
      return false;
    }
    state.inherited = r.body.inherited ?? [];
    state.room.color = r.body.room.color;
    state.room.feed_default = r.body.room.feed_default;
    /* ROOM CHARACTER [rooms/character] */
    rememberArt(r.body.room); // [perf/poll-traffic] the answer carries the SVG
    for (const k of ['art', 'art_render', 'art_tile', 'wash_at', 'bubble_glass', 'pal', 'pal_mode', 'design_follow']) {
      if (k in r.body.room) {
        state.room[k] = r.body.room[k];
      }
    }
    if ('voice' in r.body.room) {
      state.room.voice = r.body.room.voice;
    }
    msg.textContent = 'Saved';
    paintRoomColor();
    paintFeedReset();
    paintWho();
    void tellShellIdentity();
    return true;
  } catch (e) {
    msg.textContent = `Not saved: ${e?.message ?? e}`;
    msg.dataset.kind = 'error';
    return false;
  }
}

/* LINE WASH, SPOT | EDGE [hub-v2]: the slider's debounced save, PATCH /api/rooms/me {wash}. */
async function saveWash(patch) {
  const r = await api('/api/rooms/me', { method: 'PATCH', json: { wash: patch } });
  if (r?.ok && r.body && state.me) {
    state.me.wash = r.body.wash;
  }
}

function settingsBody() {
  const wrap = mk('div', 'pv-set');
  /* ---- default feed ---- */
  const g1 = mk('div', 'pv-grp');
  g1.append(mk('h4', '', 'Default feed'));
  const draft = { ...feedDefault(), kinds: new Set(feedDefault().kinds) };
  const chips = mk('div', 'pv-chips');
  const sel = mk('select', 'pv-sel');
  sel.setAttribute('aria-label', 'Show');
  const paintDraft = () => {
    for (const b of chips.children) {
      b.setAttribute('aria-pressed', String(draft.kinds.has(b.dataset.kind)));
    }
    sel.textContent = '';
    for (const who of [...Object.keys(WHO_LABEL), ...orderSeats(state.room, state.seats).map((x) => x.id)]) {
      const o = mk('option', '', whoLabel(who));
      o.value = who;
      sel.append(o);
    }
    sel.value = draft.who;
    draft.who = sel.value;
  };
  for (const k of KINDS) {
    const b = mk('button', 'pv-chip', k);
    b.type = 'button';
    b.dataset.kind = k;
    b.addEventListener('click', () => {
      if (draft.kinds.has(k)) {
        draft.kinds.delete(k);
      } else {
        draft.kinds.add(k);
      }
      paintDraft();
    });
    chips.append(b);
  }
  sel.addEventListener('change', () => { draft.who = sel.value; });
  const acts1 = mk('div', 'pv-acts');
  const save = mk('button', 'pv-btn pri', 'Save as default');
  save.type = 'button';
  const use = mk('button', 'pv-btn', 'Use current view');
  use.type = 'button';
  const msg1 = mk('p', 'pv-msg');
  msg1.setAttribute('role', 'status');
  save.addEventListener('click', () => void saveSettings({ feed_default: { kinds: KINDS.filter((k) => draft.kinds.has(k)), who: draft.who } }, msg1));
  use.addEventListener('click', () => {
    const f = currentFeed();
    draft.kinds = new Set(f.kinds);
    draft.who = f.who;
    paintDraft();
  });
  acts1.append(save, use);
  g1.append(chips, sel, mk('p', 'pv-note', 'Reset returns the feed to this.'), acts1, msg1);
  paintDraft();

  /* ---- ROOM CHARACTER [rooms/character]: today's Art group, moved UNCHANGED into the
         "Room art" option of the Art radio below (HELD, Owner 2026-10-05) ---- */
  const artGroup = artSettingsGroup({
    getRoom: () => state.room,
    getColour: () => state.room?.color || leadColor() || NEUTRAL_ROOM,
    save: saveSettings,
  });
  /* ---- Art (radio: Tiled artwork | Room art) + Line wash, Palette, Room color rows [hub-v2] ---- */
  const look = roomLookGroups({
    getRoom: () => state.room,
    save: saveSettings,
    live: (tile) => paintTile($('roomLine'), tile), // a slider mid-drag: the line follows, nothing saved
    roomArtEl: artGroup.el,
    leadColor,
    neutral: NEUTRAL_ROOM,
    leadName: () => {
      const lead = state.seats.find((x) => x.id === state.room?.lead_seat);
      return lead ? `@${lead.handle}` : '';
    },
    swatches: SWATCHES,
    tones: TONES,
  });
  paintWgs = null;
  const wgs = state.room?.parent_id || isBasic() ? null : workgroupsGroup({
    list: () => (state.family?.workgroups ?? []).filter((w) => w.state !== 'archived'),
    api,
    swatches: SWATCHES,
    touch: matchMedia('(hover: none)').matches || matchMedia('(max-width: 600px)').matches,
    refresh: () => fetchRoom(),
  });
  paintWgs = wgs ? wgs.paint : null;
  look.art.querySelector('h4')?.after(livePreviewRow()); // phone only (CSS)
  /* FOLLOW THE ROOM [wg follow] (Owner 2026-10-07): a workgroup's art, tile, wash, glass and palette are its main room's while
     this is on; its own saved values wait, unused, for it to go off. Color is always the workgroup's own. A main room has none. */
  const inh = inheritGroup();
  const follow = state.room?.parent_id ? followGroup([...inh, look.art, look.palette]) : null;
  wrap.append(g1, ...(wgs ? [wgs.el] : []), ...(follow ? [follow.el] : []), ...inh, look.art, look.palette, look.color, voiceSettingsGroup({ room: state.room, voiceGlobal: state.voiceGlobal, save: saveSettings, characters: voiceCharacters }), youSettingsLink());
  return wrap;
}

/** The "Follow the room" switch at the top of a workgroup's Art & color [wg follow]. `hide` = the controls it makes moot. */
function followGroup(hide) {
  const g = mk('div', 'pv-grp pv-follow');
  const hd = mk('div', 'pv-vhd');
  const sw = mk('button', 'pv-switch');
  sw.type = 'button';
  sw.id = 'designFollow';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-label', 'Follow the room: use the main room\u2019s art and palette');
  sw.append(mk('span', 'pv-knob'));
  hd.append(mk('h4', '', 'Follow the room'), sw);
  const note = mk('p', 'pv-hint pv-follow-note');
  note.id = 'designFollowNote';
  const msg = mk('p', 'pv-msg');
  msg.setAttribute('role', 'status');
  const paint = () => {
    const on = state.room?.design_follow !== false; // the engine's default is on
    const main = state.family?.parent?.name ?? 'the main room';
    sw.setAttribute('aria-checked', String(on));
    note.textContent = on
      ? `Uses ${main}\u2019s art and palette, in this workgroup\u2019s color.`
      : `This workgroup has its own art and palette. Turn this on to use ${main}\u2019s.`;
    for (const el of hide) {
      el.hidden = on;
    }
  };
  sw.addEventListener('click', async () => {
    const next = state.room?.design_follow === false; // flip
    sw.disabled = true;
    try {
      if (await saveSettings({ design_follow: next }, msg)) {
        paint();
        paintInherit?.();
        await fetchRoom(); // the line, the tile, the wash, the glass and the palette repaint from the engine's effective room at once
      }
    } finally {
      sw.disabled = false;
    }
  });
  g.append(hd, note, msg);
  paint();
  return { el: g, paint };
}

/* A WORKGROUP'S DESIGN, FROM ITS MAIN ROOM [workgroup design] Owner 2026-10-05: the engine fills each
   design field the workgroup leaves unset from the main room and says which in `inherited`.
   This group says so beside the controls, and "Reset to main room" clears the workgroup's own
   value (PATCH null) so it follows the main room again. Nothing in a main room. */
const INHERIT_ROWS = [
  { label: 'Art', fields: ['art', 'art_tile'] },
  { label: 'Line wash spot', fields: ['wash_at'] },
  { label: 'Bubble glass', fields: ['bubble_glass'] },
  { label: 'Palette', fields: ['pal'] },
  { label: 'Default feed', fields: ['feed_default'] }, // Owner 2026-10-05: cascades from the main room
];
function inheritGroup() {
  paintInherit = null;
  if (!state.room?.parent_id) {
    return [];
  }
  const g = mk('div', 'pv-grp pv-inh');
  g.append(mk('h4', '', 'From the main room'));
  const rows = mk('div', 'pv-inh-rows');
  const msg = mk('p', 'pv-msg');
  msg.setAttribute('role', 'status');
  g.append(rows, msg);
  paintInherit = () => {
    const main = state.family?.parent?.name ?? 'the main room';
    const inh = state.inherited ?? [];
    rows.textContent = '';
    for (const row of INHERIT_ROWS) {
      const own = row.fields.filter((f) => !inh.includes(f) && state.room?.[f] !== null && state.room?.[f] !== undefined);
      const line = mk('div', 'pv-inh-row');
      line.dataset.field = row.fields[0];
      line.append(mk('span', 'k', row.label));
      if (own.length) {
        line.append(mk('span', 'v', 'this workgroup\u2019s own'));
        const b = mk('button', 'pv-btn', 'Reset to main room');
        b.type = 'button';
        b.addEventListener('click', () => {
          const patch = {};
          for (const f of row.fields) {
            patch[f] = null;
          }
          void saveSettings(patch, msg);
        });
        line.append(b);
      } else if (row.fields.some((f) => inh.includes(f))) {
        line.append(mk('span', 'v', `from ${main}`));
      } else {
        line.append(mk('span', 'v', `none set in ${main}`));
      }
      rows.append(line);
    }
  };
  paintInherit();
  return [g];
}

/* ------------------------------------------------- ROOM VOICE (W1, §9–§10) ---- */

/* The voice character catalogue, through the engine (a person's cookie; the
 * page cannot reach the voice service). Three outcomes: a list, or down with a reason. */
async function voiceCharacters() {
  try {
    const r = await api('/api/voice/characters');
    if (r.ok && Array.isArray(r.body?.characters)) {
      const list = r.body.characters
        .filter((c) => c && typeof c.id === 'string' && c.id)
        .map((c) => ({ id: c.id, name: typeof c.name === 'string' ? c.name : c.id, description: typeof c.description === 'string' ? c.description : '' }));
      return { ok: true, list };
    }
    return { ok: false, error: r.body?.error ?? `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** The engine's voice state (room view, push, or a mute/disconnect reply):
 *  the Voice cell's header and the phone's Apps badge. */
function applyVoice(raw) {
  const next = cleanVoice(raw);
  const changed = JSON.stringify(next) !== JSON.stringify(state.voice);
  state.voice = next;
  cells?.setVoice(state.voice);
  paintBadge($('phVoice'), state.voice);
  if (changed && state.room) {
    renderPhone(); // the Apps sheet row and the layer bar carry the word too
  }
}

/** Mute / Unmute / Disconnect, from the frame or the host's own buttons: the
 *  host calls the engine with the person's cookie and repaints from the reply
 *  (§9.4), not from the next poll. */
async function voiceAction(action) {
  let r;
  try {
    r = await api(`/api/rooms/${encodeURIComponent(roomId)}/voice`, { json: { action } });
  } catch (e) {
    r = { ok: false, status: 0, body: { error: e?.message ?? String(e) } };
  }
  if (!r.ok) {
    showReply('error', (el) => {
      const what = { disconnect: 'not disconnected', mute: 'not muted', unmute: 'not unmuted', 'id-on': 'ID not turned on', 'id-off': 'ID not turned off', 'openmic-on': 'open mic not turned on', 'openmic-off': 'open mic not turned off' }[action] ?? 'not changed';
      el.textContent = `voice ${what} — ${r.body?.error ?? `HTTP ${r.status}`}`;
    });
    return;
  }
  if (r.body && 'voice' in r.body) {
    applyVoice(r.body.voice);
  }
  if (action === 'disconnect') {
    void fetchRoom(); // the panel leaves the room with the connection
  }
}

/** Who put an app in the room: its seat, or the voice agent for the
 *  engine-registered voice panel (§9.1). '' = the room's own. */
function isVoicePanel(p) {
  return p?.kind === 'voice' && !p.seat_id && !p.seat_handle;
}
/** An app's line under its title (the phone's Apps sheet and layer bar). The
 *  VOICE app carries its status word there too: the phone never shows the
 *  column's cell header, so this is where a phone reads it (the design system W1 item 8). */
function appMeta(p, fallback) {
  const via = appVia(p) || fallback;
  if (!isVoicePanel(p)) {
    return [via];
  }
  const vs = document.createElement('span');
  vs.className = 'vs';
  paintStatus(vs, state.voice);
  return [vs, ` · ${via}`];
}
function appVia(p) {
  if (isVoicePanel(p)) {
    return 'via voice agent';
  }
  return p.seat_handle ? `via @${p.seat_handle}` : '';
}

/** The voice agent's glyph in the line: neutral, the speaker mark. */
function voiceAgentGlyph() {
  const el = document.createElement('span');
  el.className = 'va-glyph';
  el.append(voiceGlyph('speaker', 16));
  return el;
}

const LINE_PAGES_MAX = 5;
/** {panel:'line', lineId} (§9.3): scroll to that line and highlight it. A
 *  line older than the page holds is paged in (at most LINE_PAGES_MAX pages);
 *  failing that, a short note. It never scrolls to nothing. A filter hiding
 *  the line is lifted by returning to the room's full feed first. */
async function scrollToLine(id, { pages = LINE_PAGES_MAX } = {}) {
  if (!state.entries.has(id) && state.maxId !== null && id > state.maxId) {
    await backfill(); // newer than the page holds: fetch forward first
  }
  for (let i = 0; i < pages && !state.entries.has(id) && !state.atStart && state.minId !== null && id < state.minId; i++) {
    await loadOlder();
  }
  const li = $('line').querySelector(`li[data-id="${id}"]`);
  if (!li) {
    showReply('info', (el) => {
      el.textContent = 'that exchange is further back';
    });
    return;
  }
  if (li.style.display === 'none') {
    setFeed({ kinds: KINDS, who: '' });
    applyFilters();
  }
  /* the chat's OWN scroller, centred on the line (scrollIntoView fails inside the room's nested layout [search ui]): instant
     when it is more than 4 screens away, smooth otherwise */
  const sc = $('lineScroll');
  lineUnpin();
  const delta = li.getBoundingClientRect().top - sc.getBoundingClientRect().top - (sc.clientHeight - li.offsetHeight) / 2;
  sc.scrollTo({ top: Math.max(0, sc.scrollTop + delta), behavior: Math.abs(delta) > sc.clientHeight * 4 ? 'auto' : 'smooth' });
  li.classList.remove('is-found');
  void li.offsetWidth; // restart the highlight
  li.classList.add('is-found');
  setTimeout(() => li.classList.remove('is-found'), 2400);
}

/* SEARCH THIS ROOM [search ui] (Owner 2026-10-06 via [ref]; the design system §1.K; engine GET /api/rooms/:id/search). Every word must
   appear, newest first; it covers lines written in the room or cross-posted into it. The result's place: the room it was
   written in when that is another one, else "earlier" while the line is not on the page yet. A pick jumps to it, paging
   back as far as it takes. */
function openRoomSearch(anchor) {
  const roomName = (rid) => {
    const f = state.family;
    return (f?.parent?.id === rid ? f.parent.name : (f?.workgroups ?? []).find((w) => w.id === rid)?.name) ?? 'another room';
  };
  openSearch({
    anchor,
    title: 'Search this room',
    placeholder: 'Search this room…',
    hint: "Search this room's whole history…",
    recentKey: 'hwb.search.recent.room',
    fetch: async (q, signal) => {
      const r = await api(`/api/rooms/${encodeURIComponent(roomId)}/search?q=${encodeURIComponent(q)}&limit=50`, { signal });
      if (!r.ok) {
        throw new Error(r.body?.error ?? `HTTP ${r.status}`);
      }
      return {
        results: (r.body?.results ?? []).map((e) => {
          const seat = e.author_seat ? state.seats.find((x) => x.id === e.author_seat) : null;
          return {
            key: e.id,
            author: e.author_seat ? `@${seat?.handle ?? e.author}` : e.author === 'user' ? 'you' : e.author,
            ink: seat ? recipesById?.get(seat.recipe_id)?.color ?? null : null,
            time: e.ts,
            place: e.room_id && e.room_id !== roomId ? roomName(e.room_id) : state.entries.has(e.id) ? '' : 'earlier',
            parts: e.snippet,
          };
        }),
      };
    },
    onPick: (res) => void scrollToLine(res.key, { pages: 200 }),
  });
}
$('searchBtn').addEventListener('click', () => openRoomSearch($('searchBtn')));
$('phSearch').addEventListener('click', () => openRoomSearch($('phSearch')));
document.addEventListener('keydown', (ev) => {
  /* Ctrl/Cmd+F opens the room search on a PC (a touch device has no such key) */
  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === 'f' && !matchMedia('(pointer: coarse)').matches) {
    ev.preventDefault();
    openRoomSearch($(matchMedia('(max-width: 600px)').matches ? 'phSearch' : 'searchBtn'));
  }
});

/* YOUR PICTURE + YOUR @NAME moved to global Settings (Owner 2026-09-30: "This
 * needs to move from room settings to global settings"). The room's ⚙ column
 * no longer builds or owns this editor at all -- web/you-settings.mjs does,
 * mounted by web/settings.mjs. This is just the door: a quiet link that opens
 * Settings at #you, the same way Settings -> Apps opens from elsewhere
 * (web/app-status.mjs's openAppSettings, ticket/1906/1907) -- inside the CLI
 * Manager shell (a tab) it asks the shell via postMessage; standing alone it
 * opens/focuses a browser tab (a blocked popup navigates this page instead).
 */
const YOU_SETTINGS_URL = '/settings.html#you';
function openYouSettings() {
  if (window.parent !== window) {
    try {
      window.parent.postMessage({ hwbOpenSettings: { section: 'you' } }, '*');
      return;
    } catch {
      /* no shell after all: fall through */
    }
  }
  const w = window.open(YOU_SETTINGS_URL, '_blank');
  if (!w) {
    location.assign(YOU_SETTINGS_URL);
  }
}
function youSettingsLink() {
  const g = mk('div', 'pv-grp');
  const a = mk('a', '', `Settings ${String.fromCharCode(8250)}`);
  a.href = YOU_SETTINGS_URL;
  a.target = '_blank';
  a.rel = 'noopener';
  a.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openYouSettings();
  });
  const p = mk('p', 'pv-note');
  p.append('Your picture and @name are in ', a, '.');
  g.append(p);
  return g;
}

function openSettings(opener) {
  if (!preview || !state.room) {
    return; // not booted yet
  }
  if (preview.current()?.owner === 'settings') {
    preview.close();
    return;
  }
  preview.open({ owner: 'settings', type: '', name: 'Room settings', body: settingsBody(), opener });
}
/* LIVE PREVIEW (Owner 2026-10-05, phone): the settings sheet covers the chat, so the Art section's toggle
   shrinks it to a bottom half and the line shows above it. Per person, localStorage (guarded). */
const LIVE_PV_KEY = 'hwb.room.livePreview';
function livePreviewOn() {
  try {
    return localStorage.getItem(LIVE_PV_KEY) === '1';
  } catch {
    return false;
  }
}
function setLivePreview(on) {
  try {
    localStorage.setItem(LIVE_PV_KEY, on ? '1' : '0');
  } catch {
    /* no storage: it holds for this page only */
  }
  liveWant = on;
  paintLivePreview();
}
let liveWant = null; // null = read the stored value
const liveWanted = () => (liveWant === null ? livePreviewOn() : liveWant);
function paintLivePreview() {
  const on = preview?.current()?.owner === 'settings' && liveWanted();
  $('preview').classList.toggle('pv-live', on);
  $('main').classList.toggle('pv-live-on', on);
}
function livePreviewRow() {
  const row = mk('label', 'pv-live-row');
  const cb = mk('input');
  cb.type = 'checkbox';
  cb.checked = liveWanted();
  cb.addEventListener('change', () => setLivePreview(cb.checked));
  row.append(cb, mk('span', '', 'Live preview'), mk('small', '', 'Shrinks this sheet so the chat shows above it'));
  return row;
}
function paintGear() {
  paintLivePreview();
  const on = preview?.current()?.owner === 'settings';
  for (const id of ['gearBtn', 'phGear']) {
    $(id).setAttribute('aria-pressed', String(on));
  }
}
$('gearBtn').addEventListener('click', (ev) => openSettings(ev.currentTarget));
/* [concierge] its icon beside the room settings button (hidden when off, and in Basic) */
let cgModule = null;
import('/concierge.mjs')
  .then((m) => {
    cgModule = m;
    $('gearBtn').before(m.conciergeButton('rm-cg'));
  })
  .catch((e) => console.warn('concierge icon failed', e));
$('phGear').addEventListener('click', (ev) => openSettings(ev.currentTarget));

/* the column's cells (room-cells.mjs): seats first, then the room's panels */
let cells = null;
let pad = null; // THE SCRATCHPAD cell [scratchpad]: web/room-scratchpad.mjs
let scratchView = null;
let fullRail = true; // the new left bar (Seats, Tasks, Scratchpad) is the FULL edition's; a Basic instance keeps the old one [edition] // ... and what it opens in the preview column: web/room-scratchpad-view.mjs
let toolLinks = null; // LINE LINKS INTO A TOOL VIEW [rooms/tool-links]
let att = null; // composer attachments [ticket]: web/room-attach.mjs
let notes = null; // NOTES [ticket]: web/room-notes.mjs
let replyUi = null; // REPLY TO A LINE: web/room-reply.mjs
let imageLinks = null; // IMAGE LINKS IN LINES: web/room-image-links.mjs

const DISSOLVE_PENDING = 'hwb.room.dissolve.pending';
function dissolvedToast(name, out, rootName) {
  const n = out?.moved?.length ?? 0;
  menuToast(`${name} dissolved: ${n} seat${n === 1 ? '' : 's'} returned to ${rootName}. History kept.`);
}
/** The other half of a dissolve confirmed inside the group (Owner [ref]). Consume-once (the key goes BEFORE the call), 60 s life,
 *  only on the root it names; a refusal is an error toast, the dialog is not reopened. */
async function runPendingDissolve() {
  let p = null;
  try {
    const raw = sessionStorage.getItem(DISSOLVE_PENDING);
    if (raw === null) {
      return;
    }
    p = JSON.parse(raw);
    if (p?.rootId === roomId || !p || typeof p.at !== 'number' || Date.now() - p.at > 60_000) {
      sessionStorage.removeItem(DISSOLVE_PENDING); // consumed here, or stale; a page that is not the named root leaves a fresh one alone
    }
  } catch {
    try { sessionStorage.removeItem(DISSOLVE_PENDING); } catch { /* ignore */ }
    return;
  }
  if (!p || p.rootId !== roomId || typeof p.groupId !== 'string' || typeof p.at !== 'number' || Date.now() - p.at > 60_000) {
    return;
  }
  try {
    const res = await api(`/api/rooms/${encodeURIComponent(p.groupId)}/dissolve`, { method: 'POST', json: {} });
    if (res.ok) {
      dissolvedToast(p.name ?? 'The group', res.body, res.body?.parent_name ?? p.rootName ?? 'the main room');
      await fetchRoom();
    } else {
      roomToast(`Could not dissolve ${p.name ?? 'the group'}: ${res.body?.error ?? `HTTP ${res.status}`}`, { kind: 'error' });
    }
  } catch (e) {
    roomToast(`Could not dissolve ${p.name ?? 'the group'}: ${e?.message ?? e}`, { kind: 'error' });
  }
}

/** The libraries arrived: redraw the lines that were drawn plain while they loaded [line markdown]. */
function redrawMarkdownLines() {
  for (const li of $('line').querySelectorAll('li[data-md-pending]')) {
    const e = state.entries.get(Number(li.dataset.id));
    const body = li.querySelector('.entry-body');
    delete li.dataset.mdPending;
    if (!e || !body) {
      continue;
    }
    const md = renderLineMarkdown(e.body ?? '', mentionNodes);
    if (md) {
      body.replaceChildren(...md);
    }
  }
}

async function boot() {
  if (!roomId) {
    await showPicker();
    return;
  }
  void runPendingDissolve();
  void ensureMarkdown();
  onMarkdownReady(redrawMarkdownLines);
  preview = mountPreview({
    main: $('main'),
    el: $('preview'),
    /* one Esc closes only the top thing: the lightbox, a sheet, the @-list,
       the Assemble modal */
    escBlocked: () => !!notes?.isOpen() || !$('lightbox').hidden || !$('phSheet').hidden || !$('complete').hidden || !!document.querySelector('.ras-scrim') || seatMenu.holding() || panelMenu.holding() || !!filterUi?.isOpen() || !!cells?.largeOpen() || !!cells?.dialogOpen() || !!toolLinks?.menuOpen() || !!document.querySelector('.dv-scrim, .rsm-menu'),
    onChange: () => {
      cells?.previewChanged();
      if (preview?.current()?.owner !== 'scratchpad') {
        scratchView?.released();
      }
      pad?.previewChanged();
      paintGear();
    },
  });
  mountRail({ main: $('main'), rail: document.querySelector('.rm-roster'), pv: $('preview') }); // desktop only; inert on a phone
  mountPreviewResize({ main: $('main'), pv: $('preview') }); // the same splitter on the preview's left edge [ticket]
  mountPreviewDrawer({ main: $('main'), rail: document.querySelector('.rm-roster'), pv: $('preview'), dismiss: () => preview.dismiss() }); // too narrow for rail + chat 480 + preview 320: a drawer over the chat [pv drawer]
  notes = mountNotes({
    roomId,
    menuHost: createMenuHost(),
    att: () => att,
    cells: () => cells,
    chatHost: () => $('roomLine'),
    draft: { text: () => input.value, prepare: prepareDraftForMove, clear: clearDraftMoved, keep: () => scheduleDraftSave() },
    repaintLine: paintDeliveryLine,
    pickFile: () => $('attFile').click(),
    addBtn: $('attBtn'),
  });
  cells = mountCells({
    roomId,
    roomName: () => state.room?.name,
    roomColor: () => state.room?.color,
    notes,
    preview,
    column: document.querySelector('.rm-roster'),
    list: $('panelCells'),
    lightbox: $('lightbox'),
    onStale: () => void fetchRoom(),
    onPanels: () => {
      pad?.hideAssetsPanel(cells?.list() ?? []);
      renderPhone();
      toolLinks?.refresh(); // LINE LINKS: a panel came or went
    },
    decorateCell: (hw, head, id, p) => { // PANEL CELL MENU
      if (p?.app_slug) {
        loadAppNames(); // the menu's title row names the app
      }
      panelMenu.decorateCell(hw, head, id);
    },
    onVoiceAction: (action) => void voiceAction(action),
    onLine: (id) => void scrollToLine(id),
    onCompose: (text) => composeFromPanel(text), // {panel:'compose'}: prefill, never send
    onEntries: (list) => addEntries(list), // a postsToRoom action's line [ticket]
  });
  /* THE EDITION GATE: /health says which edition this instance is ('full' = the Advanced Workbench, today's default; a missing answer
     is full). Basic keeps the OLD seats layout with the Assets cell: no Scratchpad cell, no phone lines, the Assets app still listed. */
  try {
    fullRail = (await loadEdition()) === 'full';
  } catch {
    fullRail = true;
  }
  if (isBasic()) {
    /* THE PREVIEW / PUBLIC BAR [basic]: under the top row on a PC, under the phone header on a phone; hidden when this is not a site room.
       The switch and Publish now send /publish or /unpublish as the person's own TYPED line: the agent explains and asks before acting. */
    const place = (el) => {
      if (isPhone()) {
        $('phStrip').before(el);
      } else {
        $('main').before(el);
      }
    };
    const bar = mountSiteBar({
      roomId,
      api: (path, opts) => api(path, opts),
      sendTyped: async (text) => {
        const r = await api(`/api/rooms/${encodeURIComponent(roomId)}/line`, { json: { text } });
        const b = r.body ?? {};
        if (!r.ok || b.status === 'refused' || b.status === 'confirm') {
          return false;
        }
        addEntries(b.entries);
        showDeliveries(b.deliveries, text, b.entries);
        return true;
      },
      copy: copyText,
      toast: (t, o) => roomToast(t, o),
      place,
      agent: () => {
        const lead = leadIdOf(state.room, state.seats);
        const s = state.seats.find((x) => x.id === lead) ?? state.seats[0];
        return s ? `@${s.handle}` : null;
      },
      when: lineWhen,
    });
    PHONE_Q.addEventListener('change', () => place(bar.el));
  }
  if (fullRail) {
    scratchView = createScratchView({
      roomId,
      api: (path, opts) => api(path, opts),
      preview,
      notes: () => notes,
      compose: (text) => composeFromPanel(text),
      lightbox: () => $('lightbox'),
      scrollToLine: (id) => void scrollToLine(id),
      family: () => [...(state.family?.parent ? [state.family.parent] : []), ...(state.family?.workgroups ?? []).filter((w) => w.state !== 'archived')].filter((x) => x.id !== roomId).map((x) => ({ id: x.id, name: x.name })),
      phone: () => matchMedia('(max-width: 600px)').matches,
      me: () => state.me?.handle ?? null,
      onCounts: (c) => pad?.setCounts(c),
      counts: () => pad?.counts() ?? null,
    });
    pad = mountScratchpad({
      roomId,
      cell: $('padCell'),
      list: $('panelCells'),
      preview,
      api: (path, opts) => api(path, opts),
      cellTone,
      openList: (kind) => scratchView.open(kind),
      view: { isOpen: () => scratchView.isOpen(), refresh: () => scratchView.refresh() },
      onChange: () => renderPhone(), // the agents button's dot, and an open sheet's two lines
      visible: () => !!state.room,
    });
  }
  /* ==== IMAGE LINKS IN LINES (web/room-image-links.mjs) ==== */
  imageLinks = mountImageLinks({ roomId, lightbox: () => $('lightbox') });
  /* ==== /IMAGE LINKS IN LINES ==== */
  /* ==== LINE LINKS INTO A TOOL VIEW [rooms/tool-links] ==== */
  toolLinks = mountToolLinks({
    roomId,
    cells: () => cells,
    catalog: () => appCatalog,
    iconSvg: (key) => cells.iconSvg(key),
  });
  att = mountAttach({
    roomId,
    api,
    input,
    sendBtn: $('sendBtn'),
    tray: $('attTray'),
    note: $('attNote'),
    addBtn: $('attBtn'),
    fileInput: $('attFile'),
    dropZone: $('roomLine'),
    preview: () => preview,
    docView: (f) => {
      const kind = docKind(f.name, f.type, f.kind === 'note');
      return kind ? createDocView({ name: f.kind === 'note' ? f.title || 'Note' : f.name, kind, url: f.raw, ref: f.url, downloadName: f.kind === 'note' ? 'note.txt' : f.name }) : null;
    },
    cells: () => cells,
    isPhone: () => isPhone(),
    openApp: (id) => select(appId(id)),
    refresh: fetchRoom,
    addMenu: (btn) => notes.addMenu(btn), // NOTES: the + opens a menu when the engine has notes
    openNote: (id, from) => void notes.openNote(id, from),
    attachNote: (id) => notes.attachNote(id), // "Add to message" on a note: a tile in the tray, not a text pointer [note attach]
    noteInfo: (id) => notes.noteInfo(id),
  });
  /* ==== REPLY TO A LINE (the design system room-reply-v1): hooks only ==== */
  replyUi = mountReply({
    roomId,
    line: $('line'),
    scroll: $('lineScroll'),
    column: $('roomLine'),
    input,
    att,
    entry: (id) => state.entries.get(id),
    seats: () => state.seats,
    leadId: () => leadIdOf(state.room, state.seats),
    seatHandle: (id) => seatHandle(id),
    userHandle: () => state.me?.handle ?? null,
    tone: (span) => toneMention(span),
    toneOf: (seatId) => {
      const seat = state.seats.find((s) => s.id === seatId);
      const c = seat ? recipesById?.get(seat.recipe_id)?.color : null;
      return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : null;
    },
    loadOlder: () => loadOlder(),
    atStart: () => state.atStart,
    minId: () => state.minId,
    showAll: () => {
      setFeed({ kinds: KINDS, who: '' });
      applyFilters();
    },
    completionOpen: () => !$('complete').hidden,
    draftChanged: () => scheduleDraftSave(),
  });
  /* ==== /REPLY ==== */
  buildKindFilters();
  $('olderBtn').addEventListener('click', () => void loadOlder());
  /* THE REST OF THE HISTORY COMES AS YOU SCROLL UP (Owner [ref]): only the newest page loads with the room; reaching the
     top fetches the next one, and loadOlder keeps the reader where they were. One fetch at a time, none once at the start. */
  let olderBusy = false;
  /* MEMORY: follow-state for the trim; back at the newest after reading history, the extra lines go */
  $('lineScroll').addEventListener('scroll', () => {
    const sc = $('lineScroll');
    if (isHidden() === false) {
      atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 40;
      if (atBottom) {
        trimOld();
      }
    }
  }, { passive: true });
  $('lineScroll').addEventListener('scroll', () => {
    const sc = $('lineScroll');
    if (olderBusy || !state.loaded || state.atStart || sc.scrollTop > 300 || sc.scrollHeight <= sc.clientHeight) {
      return;
    }
    olderBusy = true;
    loadOlder().catch(() => {}).finally(() => { olderBusy = false; });
  }, { passive: true });
  $('feedShowAll').addEventListener('click', () => setFeed(ALL_FEED));
  loadBrands().then(() => renderRoster());
  /* a fetch that fails (WebKit: "Load failed" when the tab navigates away
     mid-boot, e.g. a CLI Manager pick) answers not-ok instead of an
     unhandled rejection [web/room-phone-7b] */
  const [r, me] = await Promise.all([fetchRoom().catch(() => ({ ok: false, status: 0, body: null })), api('/api/rooms/me').catch(() => null)]);
  if (me?.ok && me.body) {
    state.me = me.body; // else the monogram, from nothing: never a broken line
    setUserTones(me.body.tones); // [hub-v2] the person's app title-bar tones, before any cell is made
    setGlobalPref(me.body.palette); // [hub-v2] "Follows global (name · mode)" and Reset to global
    setWashPrefs(me.body.wash, saveWash); // [hub-v2] the line wash, Spot | Edge: per person, per mode
  }
  if (!r.ok) {
    $('roomName').textContent = r.status === 404 ? 'No such room' : `Room unavailable (HTTP ${r.status})`;
    return;
  }
  void restoreDraft();
  void att.restore(); // the attached files come back with the text
  await loadNewest();
  replyUi.openHash(); // REPLY: a copied line link (#line-<id>) lands on its line
  toolLinks.openHash(); // LINE LINKS: #line-<id>~<tool>:<ref> then opens the view
  state.roomSeen = state.maxId ?? 0; // the room row is selected on entry: what loaded is seen
  startLive();
  /* Opening a room NEVER reconnects it (Owner 2026-10-02, room line [ref]: look
     at the chat and rail without waking the agents; Reconnect is the button on
     the Seats header). A stale reconnect=1 from an old link is only cleaned. */
  const q = new URLSearchParams(location.search);
  if (q.get('reconnect') === '1') {
    q.delete('reconnect');
    history.replaceState(null, '', `${location.pathname}?${q}`);
  }
  /* the Workbench's "Room settings" lands here with Room settings open (the same panel as the gear); the flag is spent at once */
  if (q.get('settings') === '1') {
    q.delete('settings');
    history.replaceState(null, '', `${location.pathname}?${q}${location.hash}`);
    openSettings(null);
  }
  restoreSwitchedApp(); // LAST in boot: the column is built, the room is loaded and nothing after this closes it [room switch]
  setInterval(poll, POLL_MS);
  onVisibility((visible) => {
    if (!visible && atBottom) {
      trimOld(true); // MEMORY: a hidden room keeps less (a reader parked mid-history keeps their place)
    }
    if (visible) {
      if (atBottom) {
        const sc = $('lineScroll');
        sc.scrollTop = sc.scrollHeight; // a hidden frame lost its position; a follower is back at the newest
      }
      markSeenSoon(); // WORKGROUPS: shown again = the lines that landed meanwhile are seen
      void syncDraft(); // a shell tab shown again fires no visibilitychange or focus [ticket]
      /* the Enter preference may have just changed in Settings (Owner 2026-10-04,) */
      api('/api/rooms/me').then((m) => { if (m?.ok && m.body && state.me) { state.me.enterSubmits = m.body.enterSubmits; setUserTones(m.body.tones); cells?.retone(); pad?.retone(); } }).catch(() => {});
      void poll(); // shown again: current at once, not on the next tick
    }
  });
}

void boot();
