// The room's seats on a phone (the design s8): a bottom sheet opened from the header's "Seats · n" button. Each seat has its state in words and ONE
// button: Start, Starting…, Restore, or Open (its terminal). The rail does the same job on a wide screen; under 600 px there is no rail.
import { icon } from '../m3-chrome.js';
import { el } from './line.js';
import { seatState, heldCount, seatGlyph } from './people.js';
import { seatNeedsYou } from './needs-you.js';

/** The rail's own seat menu, minus the rows the sheet's one button already covers (Start/Restore, Open window, Close window). */
export const COVERED = Object.freeze(['go', 'terminals', 'closew']);

export const SHEET_WORDS = Object.freeze({
  none: 'No seats yet. Add one to start working.',
  add: 'Add a seat',
  start: 'Start',
  starting: 'Starting…',
  restore: 'Restore',
  open: 'Open',
  close: 'Close',
});

/** What a seat's one button is: start | starting | restore | open. */
export function seatAction(s) {
  if (s.status === 'starting') return 'starting';
  if (s.status === 'live' || s.status === 'parked') return 'open';
  if (s.status === 'dehydrated' || s.status === 'ended' || (s.actions || []).includes('rehydrate')) return 'restore';
  return 'start';
}

/**
 * deps: host (the page root), view() -> the room's view (or null), roomId(), seats(v), lead(v) -> handle,
 *       seatItems(roomId, view, seat) -> the rail's menu items, start(roomId, seat) -> true/false, startWhy() -> the engine's sentence for the last refusal, or null, open(roomId, v, seat), addSeat(roomId), onClose()
 */
export function createSeatsSheet(deps) {
  let scrim = null, sheet = null, opener = null, failed = new Map(), busy = new Set();
  const isOpen = () => !!scrim;

  function row(v, s, lead) {
    const r = el('div', 'wr-sheetrow');
    r.dataset.seat = s.handle;
    const glyph = seatGlyph(s, s.handle === lead, 48);
    const text = el('div', 'wr-sheettx');
    text.appendChild(el('div', 'wr-sheetnm', '@' + s.handle));
    const held = heldCount(s);
    const second = [s.handle === lead ? 'lead' : '', seatState(s)].filter(Boolean).join(' · ') + (held > 0 ? ' · ' + held + ' held' : '');
    const st = el('div', 'wr-sheetst');
    if (seatNeedsYou(s)) { st.classList.add('needs'); st.innerHTML = icon('priority_high'); } // P01: words and an icon, never color alone
    st.appendChild(document.createTextNode(second));
    text.appendChild(st);
    if (failed.has(s.id)) {
      const e = el('div', 'wr-sheeterr', failed.get(s.id) || "Couldn't start @" + s.handle + '. Try again.');
      e.setAttribute('role', 'alert');
      text.appendChild(e);
    }
    const action = busy.has(s.id) ? 'starting' : seatAction(s);
    const b = el('button', 'wr-sheetbtn ' + action + (action === 'open' && seatNeedsYou(s) ? ' needs' : '')); // P01: a seat that needs you gets the filled button
    b.type = 'button';
    if (action === 'starting') {
      b.disabled = true;
      b.appendChild(el('span', 'wr-sheetspin'));
      b.appendChild(document.createTextNode(SHEET_WORDS.starting));
    } else if (action === 'open') {
      b.innerHTML = icon('terminal');
      b.appendChild(document.createTextNode(SHEET_WORDS.open));
      b.setAttribute('aria-label', 'Open terminal for @' + s.handle);
      b.addEventListener('click', () => { const view = deps.view(); close(); if (view) deps.open(deps.roomId(), view, s); });
    } else {
      b.appendChild(document.createTextNode(action === 'restore' ? SHEET_WORDS.restore : SHEET_WORDS.start));
      b.setAttribute('aria-label', (action === 'restore' ? 'Restore @' : 'Start @') + s.handle);
      b.addEventListener('click', async () => {
        failed.delete(s.id);
        busy.add(s.id);
        render();
        let ok = false;
        try { ok = (await deps.start(deps.roomId(), s)) !== false; } catch { ok = false; }
        busy.delete(s.id);
        if (!ok) failed.set(s.id, (deps.startWhy && deps.startWhy()) || '');
        if (isOpen()) { if (ok) close(); else render(); } // a started seat's terminal opens: the person lands on it, not under the sheet
      });
    }
    const more = el('button', 'wr-ib wr-sheetmore');
    more.type = 'button';
    more.title = 'More for @' + s.handle;
    more.setAttribute('aria-label', 'More for @' + s.handle);
    more.setAttribute('aria-haspopup', 'dialog');
    more.innerHTML = icon('more_vert');
    more.addEventListener('click', () => openMore(v, s, more));
    r.append(glyph, text, b);
    if (deps.seatItems) r.appendChild(more);
    return r;
  }

  function render() {
    if (!sheet) return;
    const v = deps.view();
    const seats = v ? deps.seats(v) : [];
    const lead = v ? deps.lead(v) : null;
    const keep = sheet.querySelector('.wr-sheetlist') ? sheet.querySelector('.wr-sheetlist').scrollTop : 0;
    sheet.textContent = '';
    const head = el('div', 'wr-sheethead');
    head.appendChild(el('div', 'wr-sheettitle', 'Seats · ' + seats.length));
    const x = el('button', 'wr-ib wr-sheetx');
    x.type = 'button';
    x.title = SHEET_WORDS.close;
    x.setAttribute('aria-label', SHEET_WORDS.close);
    x.innerHTML = icon('close');
    x.addEventListener('click', () => close());
    head.appendChild(x);
    sheet.setAttribute('aria-label', 'Seats · ' + seats.length);
    const list = el('div', 'wr-sheetlist');
    if (!seats.length) list.appendChild(el('p', 'wr-sheetnone', SHEET_WORDS.none));
    for (const s of seats) list.appendChild(row(v, s, lead));
    const add = el('button', 'wr-sheetadd', SHEET_WORDS.add);
    add.type = 'button';
    add.addEventListener('click', () => { const id = deps.roomId(); close(); deps.addSeat(id); });
    list.appendChild(add);
    sheet.append(head, list);
    list.scrollTop = keep;
    if (document.activeElement === document.body || !sheet.contains(document.activeElement)) (sheet.querySelector('.wr-sheetbtn:not([disabled])') || x).focus();
  }

  // "More for @name": the rail's menu as a second bottom sheet of 48 px rows, the same words and order
  let moreScrim = null;
  function closeMore(restore = true) {
    if (!moreScrim) return;
    const from = moreScrim.opener;
    moreScrim.remove(); moreScrim = null;
    if (restore && from && from.isConnected) from.focus();
  }
  function openMore(v, s, from) {
    closeMore(false);
    const items = (deps.seatItems(deps.roomId(), v, s) || []).filter((it) => !COVERED.includes(it.id));
    moreScrim = el('div', 'wr-sheetscrim wr-moresheet');
    moreScrim.opener = from;
    moreScrim.addEventListener('click', (e) => { if (e.target === moreScrim) closeMore(); });
    const box = el('div', 'wr-sheet');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'More for @' + s.handle);
    const head = el('div', 'wr-sheethead');
    head.appendChild(el('div', 'wr-sheettitle', '@' + s.handle));
    const x = el('button', 'wr-ib wr-sheetx');
    x.type = 'button'; x.title = SHEET_WORDS.close; x.setAttribute('aria-label', SHEET_WORDS.close); x.innerHTML = icon('close');
    x.addEventListener('click', () => closeMore());
    head.appendChild(x);
    const list = el('div', 'wr-sheetlist');
    for (const it of items) {
      if (it.divider) { list.appendChild(el('div', 'wr-menud')); continue; }
      if (it.head) continue;
      const b = el('button', 'wr-moreitem' + (it.error ? ' err' : ''));
      b.type = 'button';
      b.dataset.item = it.id || it.label;
      b.innerHTML = icon(it.icon || 'check');
      const tx = el('span', 'wr-moretx');
      tx.appendChild(el('span', 'wr-sheetnm', it.label));
      const sub = it.disabled ? (it.hint || it.tip || '') : (it.hint || '');
      if (sub) tx.appendChild(el('span', 'wr-sheetst', sub));
      b.appendChild(tx);
      if (it.disabled) { b.disabled = true; b.setAttribute('aria-disabled', 'true'); }
      else b.addEventListener('click', () => { closeMore(false); close(false); it.fn && it.fn(); });
      list.appendChild(b);
    }
    box.append(head, list);
    moreScrim.appendChild(box);
    deps.host.appendChild(moreScrim);
    (list.querySelector('.wr-moreitem:not([disabled])') || x).focus();
  }

  function onKey(e) {
    if (e.key === 'Escape' && moreScrim) { e.stopPropagation(); closeMore(); return; }
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Tab' && sheet) { // keep focus inside the sheet
      const f = [...sheet.querySelectorAll('button:not([disabled])')];
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && (i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
    }
  }

  function open(from) {
    if (isOpen()) return;
    opener = from || null;
    failed = new Map(); busy = new Set();
    scrim = el('div', 'wr-sheetscrim');
    scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
    sheet = el('div', 'wr-sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    scrim.appendChild(sheet);
    deps.host.appendChild(scrim);
    document.addEventListener('keydown', onKey, true);
    render();
  }

  function close(restoreFocus = true) {
    if (!scrim) return;
    document.removeEventListener('keydown', onKey, true);
    closeMore(false);
    scrim.remove();
    scrim = sheet = null;
    const back = opener && opener.isConnected ? opener : opener && deps.host.querySelector('.wr-seatsb:not([hidden])'); // the header repaints while the sheet is open: its button is a new node
    opener = null;
    if (restoreFocus && back) back.focus();
    deps.onClose && deps.onClose();
  }

  return { open, close, refresh: render, isOpen };
}
