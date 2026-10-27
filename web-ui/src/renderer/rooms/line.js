// Workrooms (W1): the line of a room, read-only. Entries come from the preload's rooms API (already
// de-duplicated by id, meta parsed). the design's step-5 page: M3 bubbles (theirs left on
// surface-container-high, yours right on primary-container), the reply quote as a tonal block with a
// 3 px bar, "seen" chips under a message, facts as one centered line, thumbnails 120 × 76 in the bubble,
// app chips outlined; "Load older messages" then "Start of <room>" at the top, the "N new" divider above
// the first unseen message, "↓ N new" when scrolled up and new lines arrive.
import { icon } from '../m3-chrome.js';
import { createThumbnailCache } from './thumbnail-cache.js';
import { quietRanges, inRanges } from './rules.js';
import { approvalAsk, approvalAnswer, approvalPlate, approvalDone, APPROVAL_WORDS } from './approval.js';

const PAGE = 50;
const UNREAD_KINDS = new Set(['chat', 'attachment', 'voice']);

export const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) {
    n.className = cls;
  }
  if (text != null) {
    n.textContent = text;
  }
  return n;
};

const DAY = 24 * 3600 * 1000;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "6:46 PM" today, "Mon 9:02 AM" this week, "Oct 12 9:02 AM" before (the page shows the first two). */
export function timeWords(ts, now = Date.now()) {
  if (ts == null || ts === '') return '';
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '';
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) {
    return t;
  }
  if (now - ts < 6 * DAY) {
    return WEEKDAY[d.getDay()] + ' ' + t;
  }
  return MONTH[d.getMonth()] + ' ' + d.getDate() + ' ' + t;
}

/** The hue of the seat at `index` in its family (the golden-angle spread); one seat, one color everywhere. */
// C2: one color per seat, its recipe's color from the engine, never
// generated from position. The page sets the source (handle -> '#rrggbb' | null); without one a seat keeps the
// older position hue.
let colorSource = null, identityColors = {};
export function setSeatColors(fn, options = {}) {
  colorSource = typeof fn === 'function' ? fn : null;
  identityColors = options;
}
function identityPalette(node, handle, index = null, mine = false) {
  const seed = mine ? identityColors.me?.() : colorOf(handle) || identityColors.seedForHandle?.(handle);
  if (typeof identityColors.apply === 'function' && /^#[0-9a-f]{6}$/i.test(seed || '')) {
    identityColors.apply(node, seed);
    node.dataset.identityPalette = 'true';
    node.dataset.identitySeed = seed;
    return true;
  }
  return false;
}
export function colorOf(handle) {
  const c = colorSource ? colorSource(String(handle || '').replace(/^@/, '')) : null;
  return c || null;
}
export function hueAt(index) {
  return Math.round((210 + index * 137.508) % 360);
}
export function seatColor(index) {
  return 'hsl(' + hueAt(index) + ' 45% 42%)';
}

/** A seat's hue as CIE LCh (chroma, hue): mention TEXT uses it at a fixed tone, 30 light / 85 dark, so it reads
 *  on any bubble; avatars and the rail keep seatColor(). */
export function seatLch(index) {
  const h = hueAt(index) / 360;
  const sat = 0.45;
  const lig = 0.42;
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
  const p = 2 * lig - q;
  const ch = (t) => {
    t = (t + 1) % 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  return lchOfRgb(ch(h + 1 / 3), ch(h), ch(h - 1 / 3));
}
/** The same for a '#rrggbb' (C2: a seat's recipe color). */
export function lchOfHex(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
  return m ? lchOfRgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255) : null;
}
function lchOfRgb(r0, g0, b0) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const [r, g, b] = [r0, g0, b0].map(lin);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const A = 500 * (f(X) - f(Y));
  const B = 200 * (f(Y) - f(Z));
  return { c: Math.round(Math.hypot(A, B)), h: Math.round(((Math.atan2(B, A) * 180) / Math.PI + 360) % 360) };
}

/** An address a person typed, as a link only when it is plainly http or https (no credentials in it): else null. Trailing punctuation is not part of it. */
export function safeUrl(raw) {
  let t = String(raw || '');
  let tail = '';
  for (;;) {
    const m = /[.,;:!?)\]}>'"\u2019\u201d]$/.exec(t);
    if (!m) break;
    // a closing bracket belongs to the address when it has its opening twin inside it
    if (m[0] === ')' && (t.match(/\(/g) || []).length >= (t.match(/\)/g) || []).length) break;
    tail = m[0] + tail; t = t.slice(0, -1);
  }
  if (t.length < 8 || t.length > 2000) return null;
  let u;
  try { u = new URL(t); } catch { return null; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || !u.hostname) return null;
  return { text: t, href: u.href, tail };
}

/** Body text -> nodes: @mentions (a seat's own color, else primary; yours marked), `code`, line breaks. Nothing
 *  else is interpreted. W2: kindOf(handle) -> 'you' | 'room' | 'lead' | 'alias' | null; an @word that names no seat
 *  and no address stays plain text; your own mention shows your name (meName()). */
export function bodyNodes(text, seatIndex, kindOf, meName, contextSeed = null) {
  const frag = document.createDocumentFragment();
  const s = String(text || '');
  const re = /(`[^`\n]+`)|(https?:\/\/[^\s<>`]+)|(@[A-Za-z0-9_.-]+)|(\n)/g;
  const quiet = quietRanges(s); // 0.22.2 (the owner ): a name in quotes or fenced code is not a reference
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) {
      frag.appendChild(document.createTextNode(s.slice(last, m.index)));
    }
    if (m[1]) {
      frag.appendChild(el('code', 'wr-code', m[1].slice(1, -1)));
    } else if (m[2]) {
      // an http(s) address is a link that opens in a new tab and carries nothing of ours (P03); anything else stays text
      const u = inRanges(quiet, m.index) || !(globalThis.wb && globalThis.wb.web) ? null : safeUrl(m[2]); // web only: the desktop's windows decide for themselves
      if (!u) frag.appendChild(document.createTextNode(m[2]));
      else {
        const a = el('a', 'wr-url', u.text);
        a.href = u.href; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow'; a.referrerPolicy = 'no-referrer';
        frag.appendChild(a);
        if (u.tail) frag.appendChild(document.createTextNode(u.tail));
      }
    } else if (m[3]) {
      const handle = m[3].slice(1);
      const kind = kindOf ? kindOf(handle) : null;
      const i = kind === 'you' || !seatIndex ? null : seatIndex(handle);
      if (inRanges(quiet, m.index) || (kindOf && kind == null && i == null)) {
        frag.appendChild(document.createTextNode(m[3]));
      } else {
        const me = kind === 'you' && meName ? meName() : null;
        const at = el('span', 'wr-at' + (kind === 'you' ? ' me' : ''), me ? '@' + me : m[3]);
        at.dataset.at = handle;
        if (kind !== 'you') {
          // "Mention": a click or Enter puts it into your message
          at.title = 'Mention';
          at.tabIndex = 0;
          at.setAttribute('role', 'button');
        }
        if (kind === 'you') identityPalette(at, handle, i, true);
        const own = kind === 'you' ? null : colorOf(handle);
        if (own || i != null) {
          identityPalette(at, handle, i);
          const lch = (own && lchOfHex(own)) || seatLch(i);
          at.classList.add('seat');
          at.style.setProperty('--at-c', String(lch.c));
          at.style.setProperty('--at-h', String(lch.h));
        }
        if(contextSeed&&at.dataset.identitySeed?.toLowerCase()===contextSeed.toLowerCase())at.dataset.sameHue='true';
        frag.appendChild(at);
      }
    } else {
      frag.appendChild(document.createElement('br'));
    }
    last = re.lastIndex;
  }
  if (last < s.length) {
    frag.appendChild(document.createTextNode(s.slice(last)));
  }
  return frag;
}

export function initials(handle) {
  const parts = String(handle || '?').replace(/^@/, '').split(/[-_. ]+/).filter(Boolean);
  const two = parts.length >= 2 ? parts[0][0] + parts[1][0] : String(parts[0] || '?').slice(0, 2);
  return two.toUpperCase();
}
/** A stable hue per handle, for the seat avatar when the page carries no color for it. */
export function hueOf(handle) {
  let h = 0;
  for (const ch of String(handle || '')) {
    h = (h * 31 + ch.charCodeAt(0)) % 360;
  }
  return h;
}
/** Seats in one room get hues spread by the golden angle from the seat's position; a handle alone is hashed. */
export function avatarEl(handle, size = 32, index = null) {
  const a = el('span', 'wr-av', initials(handle));
  identityPalette(a, handle, index);
  a.style.setProperty('--avs', size + 'px');
  a.title = '@' + String(handle || '').replace(/^@/, '');
  return a;
}

/**
 * createLine({ host, roomName, me, thumb(roomId, name, w) -> Promise<dataUrl|null>, openImage(items, index),
 *              loadOlder(before) -> Promise<{entries, hasOlder}>, markSeen(lastId), seatColor(handle) })
 */
export function createLine(deps) {
  const thumbnailCache = createThumbnailCache(10 * 1024 * 1024);
  const root = el('div', 'wr-line');
  root.setAttribute('role', 'log');
  root.setAttribute('aria-live', 'polite');
  const top = el('div', 'wr-top');
  const older = el('button', 'wr-older', 'Load older messages');
  older.type = 'button';
  const start = el('div', 'wr-div', '');
  top.append(older, start);
  const body = el('div', 'wr-entries');
  root.append(top, body);
  const jump = el('button', 'wr-jump');
  jump.type = 'button';
  jump.hidden = true;
  const state = { roomId: null, entries: [], byId: new Map(), hasOlder: true, loading: false, firstNewId: null, newCount: 0, newSince: 0, seenTimer: null, unseenBelow: 0 };

  let epoch = 0, disposed = false, visible = true, history = false, latestId = 0;
  const timers = new Set(), frames = new Set(), listeners = [], actions = new WeakMap();
  const turnFacts = new Map(), pending = new Map();
  function later(fn, ms) {
    const stamp = epoch;
    const id = setTimeout(() => { timers.delete(id); if (!disposed && visible && stamp === epoch) fn(); }, ms);
    timers.add(id); return id;
  }
  function cancelTimer(id) { clearTimeout(id); timers.delete(id); }
  function frame(fn) {
    const stamp = epoch;
    const id = requestAnimationFrame(() => { frames.delete(id); if (!disposed && visible && stamp === epoch) fn(); });
    frames.add(id); return id;
  }
  function stopWork() {
    epoch++; thumbnailCache.clear(); state.loading = false; older.disabled = false;
    for (const id of timers) clearTimeout(id);
    for (const id of frames) cancelAnimationFrame(id);
    timers.clear(); frames.clear();
  }
  function listen(node, name, fn) { node.addEventListener(name, fn); listeners.push(() => node.removeEventListener(name, fn)); }
  function rememberTurns(entries) {
    for (const e of entries) {
      const t = e.meta && e.meta.turn;
      if (!t) continue;
      const prior = turnFacts.get(t.thread);
      if (!prior || Number(e.id) > Number(prior.id)) turnFacts.set(t.thread, e);
    }
    // A bounded latest-fact summary preserves current header state across message eviction.
    if (turnFacts.size > 300) {
      const sorted = [...turnFacts.values()].sort((a,b) => a.id-b.id);
      for (const e of sorted.slice(0, sorted.length-300)) turnFacts.delete(e.meta.turn.thread);
    }
  }
  function trim(fromEnd = false) {
    const cap = visible ? 300 : 120;
    if (state.entries.length <= cap) return;
    const n = Math.min(state.entries.length, Math.ceil((state.entries.length-cap)/50)*50);
    const removed = fromEnd ? state.entries.splice(-n) : state.entries.splice(0,n);
    for (const e of removed) { state.byId.delete(e.id); body.querySelector('[data-id="'+e.id+'"]')?.remove(); }
    if (!fromEnd) state.hasOlder = true;
    paintTop();
  }
  function redraw() {
    body.textContent = '';
    if (!visible || disposed) return;
    for (const e of state.entries) body.appendChild(render(e));
    for (const e of pending.values()) body.appendChild(render(e));
    foldClosed(true);
  }
  function showReturn() {
    jump.textContent = 'Return to newest'; jump.hidden = false;
  }
  async function returnLatest() {
    if (disposed || !visible || !state.roomId) return false;
    if (!history) { scrollToBottom(); jump.hidden = true; state.unseenBelow = 0; armSeen(); return true; }
    const stamp = epoch, room = state.roomId, newestAtRequest = latestId;
    let page;
    try { page = await deps.loadLatest?.(); } catch { return false; }
    if (!page || disposed || !visible || stamp !== epoch || room !== state.roomId) return false;
    const arrivedDuringRequest = latestId > newestAtRequest;
    open(room, state.roomName, page, 0);
    if (arrivedDuringRequest && latestId > (state.entries.at(-1)?.id || 0)) { history = true; showReturn(); }
    deps.onLatest?.(); return true;
  }
  function setVisible(on) {
    if (disposed || visible === !!on) return;
    visible = !!on; stopWork();
    if (!visible) { trim(); body.textContent = ''; jump.hidden = true; root.remove(); jump.remove(); }
  }
  function clear() {
    stopWork(); state.roomId = null; state.entries = []; state.byId.clear(); turnFacts.clear();
    latestId = 0; history = false; state.unseenBelow = 0; state.firstNewId = null; pending.clear(); body.textContent = ''; jump.hidden = true;
  }
  function destroy() {
    if (disposed) return;
    clear(); disposed = true; listeners.splice(0).forEach(fn => fn()); root.remove(); jump.remove();
  }

  function setStart(roomName) {
    start.textContent = 'Start of ' + (roomName || 'the room');
  }
  function paintTop() {
    older.hidden = !state.hasOlder;
    start.hidden = !!state.hasOlder;
  }

  function isUnreadKind(e) {
    return UNREAD_KINDS.has(e.kind) && e.author !== 'user';
  }

  // W3: a quick word where a button was ("Delivered", "Nudged"), for 2 s
  function settle(row, word) {
    row.textContent = '';
    row.classList.add('done');
    row.insertAdjacentHTML('beforeend', icon('check'));
    row.appendChild(document.createTextNode(word));
    later(() => row.remove(), 2000);
  }
  /** What the engine's raw fact texts say in words a person reads (null: leave the text as it is). */
  function factWords(body) {
    const text = String(body || '');
    let m = /^not-delivered: (@[\w.-]+) is disconnected \((?:no session to restore|the wake failed:[^)]*)\)$/.exec(text);
    if (m) return { notRunning: m[1] };
    m = /^panel "([^"]+)" was added(?: to (@[\w.-]+))?$/.exec(text);
    if (m) return { text: m[1] === 'Assets' ? "Assets added to this room's Scratchpad." : m[1] + ' added to ' + (m[2] ? m[2] + "'s seat." : 'this room.') };
    return null;
  }
  /** "Not delivered · @seat isn't running" with Start it: the one wording for a seat that never started, and the seat list's own Start. */
  function startRow(e, handle) {
    const who = '@' + String(handle).replace(/^@/, '');
    const row = el('div', 'wr-undeliv wr-fact');
    row.dataset.id = String(e.id);
    row.innerHTML = icon('schedule_send');
    row.appendChild(el('span', 'wr-undt', 'Not delivered · ' + who + " isn't running"));
    if (deps.startSeatByHandle) {
      const b = el('button', 'wr-lnk', 'Start it');
      b.type = 'button';
      b.addEventListener('click', async () => {
        b.disabled = true;
        const stamp = epoch;
        const ok = await deps.startSeatByHandle(who).catch(() => false);
        if (stamp !== epoch || disposed || !visible) return;
        if (ok) settle(row, 'Started'); else b.disabled = false;
      });
      row.appendChild(b);
    }
    return row;
  }
  const REASON = { disconnected: 'was resting', 'no-session': 'was resting', waking: 'was waking up', switching: 'was switching' };
  // C3: the room's filter (kinds and From); a line it leaves out is drawn hidden
  function render(e) {
    const n = draw(e);
    if (e.meta && e.meta.hidden === true) {
      n.hidden = true; // an engine fact for clients only (the turn-closed fact, meta.hidden): never a line
      n.classList.add('wr-hiddenfact');
    } else if (floorClosed(e)) {
      n.classList.add('wr-closedfloor'); // C11: its turn is over
      n.hidden = !state.showClosedFloor || (!!state.filter && !state.filter(e));
    } else if (state.filter && !state.filter(e)) {
      n.hidden = true;
    }
    return n;
  }
  // C11: a floor line ("willow has the floor on #N") shows only while its turn is
  // open. The engine says a turn closed with a hidden fact {turn: {thread, kind: 'closed'}}; for history from
  // before that fact existed, a floor line is closed once a later floor line of the same thread exists, and the
  // last one once the turn timeout has passed. "Closed floor lines" in the filter brings them back.
  const TURN_TIMEOUT_MS = 15 * 60 * 1000;
  function floorClosed(e) {
    const t = e.kind === 'fact' && e.meta && e.meta.turn;
    if (!t || t.kind !== 'floor' || t.thread == null) {
      return false;
    }
    let later = Number(turnFacts.get(t.thread)?.id) > Number(e.id);
    for (const x of state.entries) {
      const xt = x.kind === 'fact' && x.meta && x.meta.turn;
      if (!xt || xt.thread !== t.thread || x.id === e.id) {
        continue;
      }
      if (x.id > e.id && ['floor', 'closed', 'timeout', 'offline', 'limit', 'unresponsive', 'user'].includes(xt.kind)) {
        later = true;
      }
    }
    return later || Date.now() - (Number(e.ts) || 0) > TURN_TIMEOUT_MS;
  }
  /** A turn closed while the line is shown: its floor lines fold away (150 ms; none with reduced motion), and
   *  the view stays where it was (at the bottom, it stays at the bottom). */
  function foldClosed(instant = false) {
    const wasBottom = atBottom();
    for (const e of state.entries) {
      if (!floorClosed(e)) continue;
      const n = body.querySelector('[data-id="' + e.id + '"]');
      if (!n || n.classList.contains('wr-closedfloor')) {
        continue;
      }
      n.classList.add('wr-closedfloor');
      if (state.showClosedFloor) {
        continue;
      }
      if (instant || matchMedia('(prefers-reduced-motion: reduce)').matches) {
        n.hidden = true;
      } else {
        n.style.height = n.offsetHeight + 'px';
        n.classList.add('wr-folding');
        frame(() => {
          if (n.classList.contains('wr-folding')) {
            n.style.height = '0px'; // a late frame (a background window) never outlives the fold
          }
        });
        later(() => {
          n.hidden = true;
          n.classList.remove('wr-folding');
          n.style.height = '';
          if (wasBottom) {
            scrollToBottom();
          }
        }, 160);
      }
    }
    if (wasBottom) {
      scrollToBottom();
    }
  }
  /** C7: the seats working on your message: their newest line's avatar keeps a turning ring. */
  function setWorking(handles) {
    state.working = handles;
    for (const n of body.querySelectorAll('.wr-msg.wr-working')) {
      n.classList.remove('wr-working');
    }
    for (const h of handles || []) {
      const mine = [...body.querySelectorAll('.wr-msg[data-author="' + CSS.escape(h) + '"]')].pop();
      if (mine) {
        mine.classList.add('wr-working');
      }
    }
  }
  function setShowClosedFloor(on) {
    state.showClosedFloor = !!on;
    for (const e of state.entries) {
      const n = body.querySelector('[data-id="' + e.id + '"]');
      if (n && n.classList.contains('wr-closedfloor')) {
        n.classList.remove('wr-folding');
        n.style.height = '';
        n.hidden = !state.showClosedFloor || (!!state.filter && !state.filter(e));
      }
    }
  }
  function draw(e) {
    // W3: a line that didn't reach a seat: "Not delivered · <seat> was resting" [Wake it], under your message
    if (e.kind === 'delivery' && e.meta && e.meta.delivered === false && e.meta.seat && e.meta.cause) {
      const handle = e.target || (deps.handleOf ? deps.handleOf(e.meta.seat) : null) || 'the seat';
      if (deps.seatNeverRan && deps.seatNeverRan(e.meta.seat)) return startRow(e, handle); // never started: Start it, not Wake it
      const row = el('div', 'wr-undeliv');
      row.dataset.id = String(e.id);
      row.dataset.cause = String(e.meta.cause);
      row.innerHTML = icon('schedule_send');
      row.appendChild(el('span', 'wr-undt', 'Not delivered · ' + handle + ' ' + (REASON[e.meta.reason] || 'was resting')));
      const b = el('button', 'wr-lnk', 'Wake it');
      b.type = 'button';
      b.addEventListener('click', async () => {
        b.disabled = true;
        const stamp = epoch;
        const ok = deps.wakeDeliver ? await deps.wakeDeliver(e.meta.seat, e.meta.cause) : false;
        if (stamp !== epoch || disposed || !visible) return;
        if (ok) {
          settle(row, 'Delivered');
        } else {
          b.disabled = false;
        }
      });
      row.appendChild(b);
      return row;
    }
    // W3: a seat that didn't answer in time: the amber line with [Nudge] (the same line again; one per turn)
    const turn0 = e.kind === 'fact' && e.meta && e.meta.turn;
    if (turn0 && turn0.kind === 'timeout' && turn0.seat && Array.isArray(turn0.lines) && turn0.lines.length) {
      const f = el('div', 'wr-fact warn');
      f.dataset.id = String(e.id);
      f.innerHTML = icon('hourglass_disabled');
      f.appendChild(document.createTextNode((e.body || '').replace(/^@/, '')));
      const b = el('button', 'wr-lnk', 'Nudge');
      b.type = 'button';
      b.title = 'Send the line again';
      b.addEventListener('click', async () => {
        b.disabled = true;
        const stamp = epoch;
        const ok = deps.wakeDeliver ? await deps.wakeDeliver(turn0.seat, turn0.lines[0]) : false;
        if (stamp !== epoch || disposed || !visible) return;
        if (ok) {
          const n = el('span', 'wr-nudged', 'Nudged');
          b.replaceWith(n);
          later(() => n.remove(), 2000);
        } else {
          b.disabled = false;
        }
      });
      f.appendChild(b);
      return f;
    }
    // raw engine words a person should never read: a line to a seat that never started, and "panel ... was added"
    if (e.kind === 'fact' || e.kind === 'delivery') {
      const said = factWords(e.body);
      if (said && said.notRunning) {
        return startRow(e, said.notRunning);
      }
      if (said && said.text) {
        const f = el('div', 'wr-fact');
        f.dataset.id = String(e.id);
        f.innerHTML = icon('info');
        f.appendChild(document.createTextNode(said.text));
        lineActs(f, e, f);
        return f;
      }
    }
    if (e.kind === 'fact' || e.kind === 'delivery' || e.kind === 'command') {
      const f = el('div', 'wr-fact');
      f.dataset.id = String(e.id);
      const turn = e.meta && e.meta.turn;
      f.innerHTML = icon(turn ? 'front_hand' : e.kind === 'delivery' ? 'send' : 'info');
      f.appendChild(document.createTextNode(e.body || ''));
      lineActs(f, e, f); // C9: the same "…" menu on every line, a fact too
      return f;
    }
    const mine = e.author === 'user';
    const row = el('div', 'wr-msg' + (mine ? ' mine' : '') + (!mine && state.working && state.working.has(e.author) ? ' wr-working' : ''));
    row.dataset.id = String(e.id);
    row.dataset.author = String(e.author || '');
    const identityIndex=deps.seatIndex?deps.seatIndex(e.author):null;
    if(mine||identityIndex!=null||colorOf(e.author))identityPalette(row,e.author,identityIndex,mine);
    if (mine && deps.userAvatar) {
      const avatar = deps.userAvatar(); avatar.removeAttribute('role'); avatar.removeAttribute('aria-label'); avatar.setAttribute('aria-hidden', 'true'); row.appendChild(avatar);
    }
    if (!mine) {
      row.appendChild(avatarEl(e.author, 32, deps.seatIndex ? deps.seatIndex(e.author) : null));
    }
    const col = el('div', 'wr-col');
    const bubble = el('div', 'wr-bubble');
    const head = el('div', 'wr-head');
    const who = el('span', 'wr-who', mine ? 'You' : e.author);
    head.appendChild(who);
    const tgt = e.target === 'user' ? (deps.me ? deps.me() : null) || 'user' : e.target;
    if (tgt && tgt !== 'room') {
      head.appendChild(el('span', 'wr-to', '→ @' + String(tgt).replace(/^@/, '')));
    }
    head.appendChild(el('span', 'wr-time', timeWords(e.ts)));
    bubble.appendChild(head);
    const reply = e.meta && e.meta.reply;
    if (reply && (reply.handle || reply.excerpt)) {
      const q = el('div', 'wr-quote');
      q.innerHTML = icon('reply');
      const b = el('b', null, String(reply.handle || (reply.user ? 'you' : '')));
      q.append(b, document.createTextNode(' ' + String(reply.excerpt || '')));
      bubble.appendChild(q);
    }
    if (e.body) {
      const t = el('div', 'wr-text');
      t.appendChild(bodyNodes(e.body, deps.seatIndex, deps.addressKind, deps.me, row.dataset.identitySeed));
      bubble.appendChild(t);
    }
    // C6: pictures at briefing-table's size. One picture: 120 × 120 up
    // to 260 × 170, contained, uncropped, its name and size in a corner chip. Several: 120 × 120 squares, cropped to
    // fill; past three, the fourth tile reads "+N" and opens the set. With two or more attachments every tile and
    // chip carries its number in send order (pictures, notes and files together), never the "+N" tile.
    const atts = (e.meta && Array.isArray(e.meta.attachments) ? e.meta.attachments : []).filter((a) => a && a.name);
    const numbered = atts.length >= 2;
    const num = (node, a) => {
      if (numbered) {
        const b = el('span', 'wr-num', String(atts.indexOf(a) + 1));
        b.setAttribute('aria-hidden', 'true');
        node.appendChild(b);
      }
    };
    const images = atts.filter((a) => /^image\//.test(String(a.type || '')));
    const openAt = (i) => deps.openImage(images.map((x) => ({ roomId: state.roomId, name: x.name, who: mine ? 'You' : e.author, ts: e.ts })), i);
    const picture = (a, i, cls, w) => {
      const b = el('button', cls);
      b.type = 'button';
      b.title = a.name;
      b.setAttribute('aria-label', 'Open ' + a.name);
      b.innerHTML = icon('image');
      const stamp = epoch;
      const roomId = state.roomId;
      const reset = () => { b.innerHTML = icon('image'); num(b, a); drawPencil(); };
      // a picture with marks shows the pencil after its number pill; the host answers once per picture for the session. The thumbnail
      // replaces the tile's children when it loads, so the pencil is drawn again after every paint of the tile.
      let marked = false;
      const drawPencil = () => {
        if (!marked || !b.isConnected || b.querySelector('.wr-trimk')) return;
        const pen = el('span', 'wr-trimk'); pen.innerHTML = icon('edit'); pen.setAttribute('role', 'img'); pen.setAttribute('aria-label', 'Has marks'); pen.title = 'Has marks'; b.appendChild(pen);
        b.setAttribute('aria-label', 'Open ' + a.name + ', has marks');
      };
      const ask = () => {
        // the engine says it on the attachment (annotations: true | false): trust it, no request; only an attachment without the flag is probed
        if (a.annotations === true) { marked = true; drawPencil(); return; }
        if (a.annotations === false) return;
        if (!deps.hasMarks || stamp !== epoch || disposed) return;
        Promise.resolve(deps.hasMarks(roomId, a.name)).then((yes) => { if (yes === true && stamp === epoch && !disposed) { marked = true; drawPencil(); } }).catch(() => {});
      };
      thumbnailCache.load(JSON.stringify([roomId,a.name,w]), () => deps.thumb(roomId, a.name, w), (url, decoded) => {
        if (stamp !== epoch || disposed || !visible) return;
        if (url) {
          const img = document.createElement('img');
          img.alt = a.name;
          img.addEventListener('load', () => decoded(img.naturalWidth * img.naturalHeight * 4), { once: true });
          img.src = url;
          b.textContent = '';
          b.appendChild(img);
          if (cls === 'wr-pic1') {
            const chip = el('span', 'wr-picchip', a.name);
            img.addEventListener('load', () => {
              if (img.naturalWidth && a.width && a.height) {
                chip.textContent = a.name + ' · ' + a.width + ' × ' + a.height;
              }
            });
            b.appendChild(chip);
          }
          num(b, a);
          drawPencil();
        } else {
          b.innerHTML = icon('image');
          num(b, a);
          drawPencil();
        }
      }, reset, () => stamp === epoch && !disposed && visible && b.isConnected);
      num(b, a);
      b.addEventListener('click', () => openAt(i));
      ask();
      return b;
    };
    if (images.length === 1) {
      const strip = el('div', 'wr-thumbs one');
      strip.appendChild(picture(images[0], 0, 'wr-pic1', 520));
      bubble.appendChild(strip);
    } else if (images.length > 1) {
      const strip = el('div', 'wr-thumbs wr-pgrid');
      images.slice(0, images.length > 3 ? 3 : images.length).forEach((a, i) => strip.appendChild(picture(a, i, 'wr-thumb', 240)));
      if (images.length > 3) {
        const more = el('button', 'wr-thumb wr-picmore', '+' + (images.length - 3));
        more.type = 'button';
        more.title = 'All ' + images.length + ' pictures';
        more.setAttribute('aria-label', 'All ' + images.length + ' pictures');
        more.addEventListener('click', () => openAt(3));
        strip.appendChild(more);
      }
      bubble.appendChild(strip);
    }
    const files = atts.filter((a) => !/^image\//.test(String(a.type || '')));
    if (files.length) {
      const strip = el('div', 'wr-files');
      for (const a of files) {
        const c = el('span', 'wr-chip');
        c.innerHTML = icon(a.kind === 'note' ? 'sticky_note_2' : 'attach_file');
        c.appendChild(document.createTextNode(a.kind === 'note' && a.title ? a.title : a.name));
        if (a.kind === 'note' && Number.isInteger(a.words) && a.words >= 0) {
          c.appendChild(document.createTextNode(' · ' + a.words + (a.words === 1 ? ' word' : ' words')));
        }
        num(c, a);
        strip.appendChild(c);
      }
      bubble.appendChild(strip);
    }
    const links = e.meta && Array.isArray(e.meta.links) ? e.meta.links : [];
    if (links.length) {
      const strip = el('div', 'wr-links');
      for (const l of links) {
        const c = el('span', 'wr-chip');
        c.innerHTML = icon('palette');
        c.appendChild(document.createTextNode(String(l.label || (l.tool + ' · ' + l.ref))));
        c.title = 'Opens in the side column (W4)';
        strip.appendChild(c);
      }
      bubble.appendChild(strip);
    }
    col.appendChild(bubble);
    // P05 (the design s12): under a seat's "APPROVAL:" line, the person's Approve / Cancel, or what they answered
    const asker = !mine && deps.seatOf ? approvalAsk(e, deps.seatOf) : null;
    if (asker) col.appendChild(approvalNode(e, asker));
    // W2: an unsent line of yours: "Not sent" · Try again · Delete, or "Sending when you're back online"
    const local = e.pending && e.meta && e.meta.local;
    if (local) {
      row.classList.add('pending', local.state);
      const lr = el('div', 'wr-local');
      if (local.state === 'failed') {
        lr.innerHTML = icon('error');
        lr.appendChild(el('span', 'wr-ns', 'Not sent'));
        const again = el('button', 'wr-lnk', 'Try again');
        again.type = 'button';
        again.addEventListener('click', () => deps.onRetry && deps.onRetry(e.id));
        const del = el('button', 'wr-lnk', 'Delete');
        del.type = 'button';
        del.addEventListener('click', () => deps.onDiscard && deps.onDiscard(e.id));
        lr.append(again, del);
      } else if (local.state === 'waiting') {
        lr.innerHTML = icon('cloud_off');
        lr.appendChild(el('span', 'wr-ns wait', "Sending when you're back online"));
      } else {
        lr.innerHTML = icon('schedule');
        lr.appendChild(el('span', 'wr-ns wait', 'Sending…'));
      }
      col.appendChild(lr);
    }
    // C9: hover shows a pill with Reply and "…" at the top right of the bubble; the line takes
    // focus; R replies, Shift+F10 or the Menu key opens the menu (right-click too)
    if (!local) {
      lineActs(row, e, bubble);
    }
    const seen = Object.entries(e.reads || {}).filter(([, st]) => st === 'seen');
    if (seen.length) {
      const chips = el('div', 'wr-seen');
      for (const [h] of seen) {
        const c = el('span', 'wr-chip wr-seenchip');
        c.innerHTML = icon('done_all');
        c.appendChild(document.createTextNode('seen ' + h));
        chips.appendChild(c);
      }
      col.appendChild(chips);
    }
    row.appendChild(col);
    return row;
  }

  /** P05: every plate still asking whose line now has the person's answer becomes the quiet line. */
  function answeredPlates() {
    if (!visible) return;
    for (const p of body.querySelectorAll('.wr-approval:not(.done)')) {
      const n = p.closest('.wr-msg');
      const e = n && state.byId.get(Number(n.dataset.id));
      if (e && approvalAnswer(state.entries, e.id)) n.replaceWith(render(e));
    }
  }
  /** P05: the plate under an approval ask, or the quiet line once the person answered it (any reply of theirs to the line). */
  function approvalNode(e, handle) {
    const done = approvalAnswer(state.entries, e.id);
    if (done) return approvalDone((done.approved ? APPROVAL_WORDS.approved : APPROVAL_WORDS.answered)(timeWords(done.entry.ts)));
    return approvalPlate(handle, {
      // Approve: one person line, "Approved.", as a reply to this line; never sent when an answer is already here
      onApprove: async () => (approvalAnswer(state.entries, e.id) ? 'answered' : deps.approve ? (await deps.approve(e)) === true : false),
      onReply: () => (deps.approvalReply ? deps.approvalReply(e) : deps.onReply && deps.onReply(e)),
    });
  }
  /** C9: the hover pill (Reply · More) and the keys on a line; the menu itself is the page's (deps.lineMenu). */
  function lineActs(row, e, anchor) {
    const acts = el('div', 'wr-acts');
    const rb = el('button', 'wr-act');
    rb.type = 'button';
    rb.dataset.act = 'reply';
    rb.title = 'Reply';
    rb.setAttribute('aria-label', 'Reply');
    rb.innerHTML = icon('reply');
    const mb = el('button', 'wr-act');
    mb.type = 'button';
    mb.dataset.act = 'more';
    mb.title = 'More';
    mb.setAttribute('aria-label', 'More');
    mb.setAttribute('aria-haspopup', 'menu');
    mb.innerHTML = icon('more_horiz');
    acts.append(rb, mb);
    anchor.appendChild(acts);
    anchor.classList.add('wr-hasacts');
    actions.set(row, { entry: e, anchor });
    row.tabIndex = -1;
  }

  function act(ev) {
    let row = ev.target;
    while (row && row !== root && !actions.has(row)) row = row.parentElement;
    const a = row && actions.get(row);
    if (!a) return false;
    const button = ev.target.closest?.('[data-act]');
    const reply = ev.type === 'click' && button?.dataset.act === 'reply' || ev.type === 'keydown' && ev.target === row && /^[rR]$/.test(ev.key) && !ev.ctrlKey && !ev.altKey && !ev.metaKey;
    const menu = ev.type === 'contextmenu' || ev.type === 'click' && button?.dataset.act === 'more' || ev.type === 'keydown' && ev.target === row && (ev.key === 'ContextMenu' || ev.key === 'F10' && ev.shiftKey);
    if (!reply && !menu) return false;
    ev.preventDefault(); ev.stopPropagation();
    if (reply) deps.onReply?.(a.entry);
    else {
      const b = (button || a.anchor).getBoundingClientRect();
      deps.lineMenu?.(a.entry, ev.type === 'contextmenu' ? {x:ev.clientX,y:ev.clientY} : {x:b.left+24,y:b.bottom+4}, row);
    }
    return true;
  }
  listen(root, 'contextmenu', act);

  function atBottom() {
    return root.scrollHeight - root.scrollTop - root.clientHeight < 40;
  }
  function scrollToBottom() {
    root.scrollTop = root.scrollHeight;
  }

  function divider(n) {
    const d = el('div', 'wr-div wr-new', n + ' new');
    d.dataset.new = String(n);
    return d;
  }

  /** The room opens: the newest page, the "N new" divider above the first unseen one, scrolled there. */
  function open(roomId, roomName, page, unread) {
    if (disposed) return;
    stopWork(); history = false; state.roomName = roomName;
    if (state.roomId !== roomId) { latestId = 0; turnFacts.clear(); pending.clear(); }
    state.roomId = roomId;
    state.entries = [];
    state.byId = new Map();
    state.hasOlder = !!page.hasOlder;
    state.firstNewId = null;
    state.newCount = 0;
    state.unseenBelow = 0;
    body.textContent = '';
    jump.hidden = true;
    setStart(roomName);
    paintTop();
    const all = (page.entries || []).slice().sort((a, b) => a.id - b.id);
    rememberTurns(all); latestId = Math.max(latestId, ...all.map(e => Number(e.id)), 0);
    const entries = all.slice(-(visible ? 300 : 120));
    if (entries.length < all.length) state.hasOlder = true;
    paintTop();
    // the first unseen: counting unread-kind lines by others from the end
    let firstNew = null;
    if (unread > 0) {
      let n = 0;
      for (let i = entries.length - 1; i >= 0 && n < unread; i--) {
        if (isUnreadKind(entries[i])) {
          n += 1;
          firstNew = entries[i].id;
        }
      }
    }
    state.firstNewId = firstNew;
    state.newCount = unread > 0 ? unread : 0;
    for (const e of entries) {
      if (firstNew != null && e.id === firstNew) {
        body.appendChild(divider(state.newCount));
      }
      state.entries.push(e);
      state.byId.set(e.id, e);
      if (visible) body.appendChild(render(e));
    }
    foldClosed(true); // C11: floor lines whose turn closed later in this page
    answeredPlates(); // P05: an ask drawn before its reply in this page was read
    frame(() => {
      const d = body.querySelector('.wr-new');
      if (d) {
        d.scrollIntoView({ block: 'start' });
        root.scrollTop = Math.max(0, root.scrollTop - 8);
      } else {
        scrollToBottom();
      }
      armSeen();
    });
  }

  /** "Gone after you've been in the room 5 s or sent something": the cursor moves, the divider goes. */
  function armSeen() {
    cancelTimer(state.seenTimer);
    state.seenTimer = later(() => {
      const newest = state.entries.length ? state.entries[state.entries.length - 1].id : 0;
      if (newest && deps.markSeen) {
        deps.markSeen(newest);
      }
      const d = body.querySelector('.wr-new');
      if (d) {
        d.remove();
      }
      state.firstNewId = null;
    }, 5000);
  }

  /** New entries (a push, a backfill): appended in id order; a re-announced one is redrawn in place. */
  function add(entries, { why } = {}) {
    if (disposed || !state.roomId || !entries.length) return;
    const wasBottom = atBottom() && !history;
    rememberTurns(entries);
    for (const e of entries.slice().sort((a,b) => a.id-b.id)) {
      latestId = Math.max(latestId, Number(e.id) || 0);
      const had = state.byId.has(e.id);
      if (!had && visible && !wasBottom) {
        history = true; if (isUnreadKind(e)) state.unseenBelow++; continue;
      }
      if (had) state.entries[state.entries.findIndex(x => x.id === e.id)] = e;
      else state.entries.push(e);
      state.byId.set(e.id,e);
    }
    state.entries.sort((a,b) => a.id-b.id);
    trim();
    // Remove evicted DOM before creating replacements, avoiding a transient unbounded batch.
    for (const e of entries) if (visible && state.byId.has(e.id)) {
      const n = body.querySelector('[data-id="'+e.id+'"]');
      if (n) n.replaceWith(render(e)); else body.appendChild(render(e));
    }
    answeredPlates(); // P05: a reply to an approval ask turns its plate into the quiet line
    if (entries.some(e => e.meta && e.meta.turn)) foldClosed(true);
    if (wasBottom && visible) { scrollToBottom(); armSeen(); }
    else if (visible && history) showReturn();
    void why;
  }

  /** C3: show only the lines `fn(e)` keeps (null shows all). */
  function clearRing() {
    cancelTimer(state.ringTimer);
    for (const x of body.querySelectorAll('.wr-ring')) {
      x.classList.remove('wr-ring');
    }
  }
  function setFilter(fn) {
    clearRing();
    state.filter = typeof fn === 'function' ? fn : null;
    for (const e of state.entries) {
      const node = body.querySelector('[data-id="' + e.id + '"]');
      if (node && !(e.meta && e.meta.hidden === true)) {
        node.hidden = (node.classList.contains('wr-closedfloor') && !state.showClosedFloor) || (!!state.filter && !state.filter(e));
      }
    }
  }
  /** C3: a search result: load back to the line if it's older than what's shown, scroll to it and ring it. */
  async function reveal(id) {
    const stamp = epoch, room = state.roomId;
    for (let i = 0; i < 40 && !state.byId.has(id) && state.hasOlder; i++) {
      await loadOlder();
      if (stamp !== epoch || room !== state.roomId || disposed || !visible) return false;
    }
    if (stamp !== epoch || disposed || !visible) return false;
    const node = body.querySelector('[data-id="' + id + '"]');
    if (!node) {
      return false;
    }
    node.hidden = false; // shown in place even when the filter leaves it out, until the filter changes
    node.classList.remove('wr-folding');
    node.style.height = '';
    for (const x of body.querySelectorAll('.wr-ring')) {
      x.classList.remove('wr-ring');
    }
    node.classList.add('wr-ring');
    node.scrollIntoView({ block: 'center' });
    cancelTimer(state.ringTimer);
    state.ringTimer = later(() => node.classList.remove('wr-ring'), 4000);
    return true;
  }

  /** C2: the seats' colors arrived: draw the shown lines again. */
  function recolor() {
    for (const e of [...state.entries, ...pending.values()]) {
      const node = body.querySelector('[data-id="' + e.id + '"]');
      if (node) {
        node.replaceWith(render(e));
      }
    }
  }

  function updateReads(entryId, handle, st) {
    const e = state.byId.get(Number(entryId));
    if (!e) {
      return;
    }
    e.reads = { ...(e.reads || {}), [handle]: st };
    const node = body.querySelector('[data-id="' + e.id + '"]');
    if (node) {
      node.replaceWith(render(e));
    }
  }

  async function loadOlder() {
    if (disposed || !visible || state.loading || !state.hasOlder || !state.entries.length) return;
    state.loading = true; older.disabled = true; history = true; showReturn();
    const stamp = epoch, oldest = state.entries[0].id;
    const anchors = [...body.children].filter(n => n.dataset.id);
    const anchor = anchors.find(n => n.getBoundingClientRect().bottom >= root.getBoundingClientRect().top) || anchors[0];
    const anchorId = anchor?.dataset.id, anchorTop = anchor?.getBoundingClientRect().top;
    try {
      const r = await deps.loadOlder(oldest);
      if (!r || stamp !== epoch || disposed || !visible) return;
      const entries = (r.entries || []).filter(e => !state.byId.has(e.id)).sort((a,b) => a.id-b.id);
      rememberTurns(entries); history = true;
      state.entries = entries.concat(state.entries);
      for (const e of entries) state.byId.set(e.id,e);
      trim(true); state.hasOlder = !!r.hasOlder; paintTop(); redraw(); showReturn();
      const kept = anchorId && body.querySelector('[data-id="'+anchorId+'"]');
      if (kept) root.scrollTop += kept.getBoundingClientRect().top-anchorTop;
    } catch { /* Keep the current window and the retry control. */ }
    finally { if (stamp === epoch) { state.loading = false; older.disabled = false; } }
  }

  listen(older, 'click', loadOlder);
  let scrollingTimer = null;
  // W2: a mention in the line goes into your message ("@willow " at the caret)
  listen(root, 'click', (ev) => {
    if (act(ev)) return;
    const at = ev.target.closest && ev.target.closest('.wr-at:not(.me)');
    if (at && deps.onMention) {
      deps.onMention(at.dataset.at);
    }
  });
  listen(root, 'keydown', (ev) => {
    if (act(ev)) return;
    const at = ev.key === 'Enter' && ev.target.closest && ev.target.closest('.wr-at:not(.me)');
    if (at && deps.onMention) {
      ev.preventDefault();
      deps.onMention(at.dataset.at);
    }
  });
  /** Show one line: older pages load until it's there (at most 20), then it scrolls to the middle and flashes. */
  async function jumpTo(id) {
    const stamp = epoch, room = state.roomId;
    id = Number(id);
    for (let n = 0; n < 20 && !state.byId.has(id) && state.hasOlder; n++) {
      await loadOlder();
      if (stamp !== epoch || room !== state.roomId || disposed || !visible) return false;
    }
    if (stamp !== epoch || disposed || !visible) return false;
    const node = body.querySelector('[data-id="' + id + '"]');
    if (!node) {
      return false;
    }
    node.scrollIntoView({ block: 'center' });
    // the 2 px primary ring, then it fades after 1.5 s (gone at once under reduced motion: CSS)
    node.classList.add('flash');
    cancelTimer(node.flashTimer);
    node.flashTimer = later(() => node.classList.remove('flash'), 1500);
    return true;
  }
  listen(root, 'scroll', () => {
    root.classList.add('scrolling'); // the overlay scrollbar shows while scrolling
    cancelTimer(scrollingTimer);
    scrollingTimer = later(() => root.classList.remove('scrolling'), 800);
    if (root.scrollTop < 60 && state.hasOlder && !state.loading && state.entries.length >= PAGE) {
      loadOlder(); // "Also loads by itself when you scroll to the top"
    }
    if (atBottom() && !history && !jump.hidden) {
      jump.hidden = true;
      state.unseenBelow = 0;
      armSeen();
    }
  });
  listen(jump, 'click', returnLatest);

  return {
    el: root,
    setVisible, destroy, returnLatest,
    recolor,
    refreshUserPicture() {
      if (disposed || !visible || !deps.userAvatar) return;
      for (const avatar of body.querySelectorAll('.wr-user-picture')) { const next = deps.userAvatar(); next.removeAttribute('role'); next.removeAttribute('aria-label'); next.setAttribute('aria-hidden', 'true'); avatar.replaceWith(next); }
    },
    setFilter,
    setWorking,
    entries: () => state.entries,
    setShowClosedFloor,
    reveal,
    clearRing,
    jump,
    open,
    add,
    updateReads,
    loadOlder,
    // W2: the composer's unsent lines, drawn at the end of the line and never in the cache
    addPending(e) {
      if (disposed || e.room_id !== state.roomId) return;
      pending.set(e.id, e);
      if (!visible) return;
      const node = body.querySelector('[data-id="' + e.id + '"]');
      if (node) {
        node.replaceWith(render(e));
      } else {
        body.appendChild(render(e));
      }
      scrollToBottom();
    },
    updatePending(e) {
      if (disposed || e.room_id !== state.roomId) return;
      pending.set(e.id, e);
      const node = body.querySelector('[data-id="' + e.id + '"]');
      if (node) {
        node.replaceWith(render(e));
      }
    },
    removePending(id) {
      pending.delete(id);
      const node = body.querySelector('[data-id="' + id + '"]');
      if (node) {
        node.remove();
      }
    },
    scrollToBottom,
    jumpTo,
    /** W3: "Held for <seat> · it's busy" [Deliver now] under each line a busy seat holds: { lineId: { handle, paneid } } */
    markHeld(map) {
      for (const n of body.querySelectorAll('.wr-heldrow:not(.done):not(.busy)')) { // one being delivered stays for its "Delivered"
        if (!map[n.dataset.line]) {
          n.remove();
        }
      }
      for (const [id, h] of Object.entries(map || {})) {
        const msg = body.querySelector('.wr-msg[data-id="' + id + '"] .wr-col');
        if (!msg || msg.querySelector('.wr-heldrow')) {
          continue;
        }
        const row = el('div', 'wr-heldrow');
        row.dataset.line = id;
        row.innerHTML = icon('pause_circle');
        row.appendChild(el('span', null, 'Held for ' + h.handle + " · it's busy"));
        const b = el('button', 'wr-lnk', 'Deliver now');
        b.type = 'button';
        b.addEventListener('click', async () => {
          b.disabled = true;
          row.classList.add('busy');
          const stamp = epoch;
          const ok = deps.deliverHeld ? await deps.deliverHeld(h.paneid) : false;
          if (stamp !== epoch || disposed || !visible) return;
          row.classList.remove('busy');
          if (ok) {
            settle(row, 'Delivered');
            // the seat's other held lines went with it
            for (const other of body.querySelectorAll('.wr-heldrow:not(.done)')) {
              other.remove();
            }
          } else {
            b.disabled = false;
          }
        });
        row.appendChild(b);
        msg.appendChild(row);
      }
    },
    /** W3: the turn facts loaded, oldest first (the header's floor chip reads them). */
    turns: () => [...turnFacts.values()].sort((a,b) => a.id-b.id),
    /** One line from what's loaded (the side column quotes an asset's message). */
    entry: (id) => state.byId.get(Number(id)) || null,
    clear,
    state: () => ({ roomId: state.roomId, history, visible, disposed, timers: timers.size, count: state.entries.length, hasOlder: state.hasOlder, firstNewId: state.firstNewId, newCount: state.newCount, unseenBelow: state.unseenBelow, jump: !jump.hidden, divider: !!body.querySelector('.wr-new') }),
  };
}
