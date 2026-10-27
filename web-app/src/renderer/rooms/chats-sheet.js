// The room's chats on a phone (the design s11): the header's "Chats" button (the forum icon with the number of chats, hidden when the room has no
// workgroup) opens a bottom sheet in the seats sheet's pattern. One 72 px row per chat, the room chat first and then each workgroup: its name,
// what it is, what is new; the chat you are in says "Open now". Tapping a row opens that chat and closes the sheet; "New workgroup" ends the list.
import { icon } from '../m3-chrome.js';
import { el } from './line.js';

export const CHATS_WORDS = Object.freeze({
  room: 'Room chat',
  main: 'main room',
  group: 'workgroup',
  now: 'Open now',
  upToDate: 'up to date',
  newGroup: 'New workgroup',
});

/** What is new in a chat, in words: "{n} new" or "up to date". */
export function newWords(unread) {
  const n = Number(unread) || 0;
  return n > 0 ? n + ' new' : CHATS_WORDS.upToDate;
}

/**
 * The family's chats, the room chat first. fam: the main room's view ({room, unread, family: {workgroups}}); viewOf(id) -> a room's view;
 * currentId: the chat shown. -> [{id, name, sub, unread, current}] ([] without a family).
 */
export function chatsOf(fam, viewOf, currentId) {
  if (!fam || !fam.room) return [];
  const groups = ((fam.family && fam.family.workgroups) || []).filter((g) => g && g.id && g.state !== 'archived');
  return [{ id: fam.room.id, name: CHATS_WORDS.room, sub: CHATS_WORDS.main, unread: Number(fam.unread) || 0, current: fam.room.id === currentId }]
    .concat(groups.map((g) => {
      const gv = viewOf(g.id);
      return { id: g.id, name: String(g.name || (gv && gv.room && gv.room.name) || ''), sub: CHATS_WORDS.group, unread: Number(gv ? gv.unread : g.unread) || 0, current: g.id === currentId };
    }));
}

/** deps: host (the page root), family() -> {fam, currentId} | null (the main room's view and the chat shown), viewOf(id), open(roomId),
 *  newWorkgroup(familyId), onClose() */
export function createChatsSheet(deps) {
  let scrim = null, sheet = null, opener = null;
  const isOpen = () => !!scrim;
  const now = () => {
    const f = deps.family();
    return f && f.fam && f.fam.room ? { familyId: f.fam.room.id, list: chatsOf(f.fam, deps.viewOf, f.currentId) } : { familyId: null, list: [] };
  };

  /** The header's button for the room shown (built with the header; the page shows it under 600 px). Hidden with no workgroup. */
  function button() {
    const { list } = now();
    const b = el('button', 'wr-ib wr-chatsb');
    b.type = 'button';
    b.hidden = list.length < 2;
    b.title = 'Chats';
    b.setAttribute('aria-label', 'Chats, ' + list.length);
    b.setAttribute('aria-haspopup', 'dialog');
    b.innerHTML = icon('forum');
    b.appendChild(el('span', 'wr-chatsn', String(list.length)));
    b.addEventListener('click', () => open(b));
    return b;
  }

  function render() {
    if (!sheet) return;
    const { familyId, list } = now();
    if (list.length < 2) { close(); return; } // the last workgroup went: nothing to switch to
    sheet.textContent = '';
    const title = 'Chats · ' + list.length;
    const head = el('div', 'wr-sheethead');
    head.appendChild(el('div', 'wr-sheettitle', title));
    const x = el('button', 'wr-ib wr-sheetx');
    x.type = 'button';
    x.title = 'Close';
    x.setAttribute('aria-label', 'Close');
    x.innerHTML = icon('close');
    x.addEventListener('click', () => close());
    head.appendChild(x);
    sheet.setAttribute('aria-label', title);
    const rows = el('div', 'wr-sheetlist');
    for (const c of list) {
      const b = el('button', 'wr-sheetrow wr-chatrow' + (c.current ? ' on' : ''));
      b.type = 'button';
      b.dataset.chat = c.id;
      const tx = el('span', 'wr-sheettx');
      const what = newWords(c.unread);
      tx.append(el('span', 'wr-sheetnm', c.name), el('span', 'wr-sheetst', c.sub), el('span', 'wr-chatnew' + (c.unread > 0 ? ' has' : ''), what));
      b.appendChild(tx);
      if (c.current) {
        const chip = el('span', 'wr-chatnow');
        chip.innerHTML = icon('check');
        chip.appendChild(document.createTextNode(CHATS_WORDS.now));
        b.appendChild(chip);
        b.setAttribute('aria-current', 'true');
      } else {
        const chev = el('span', 'wr-toolchev');
        chev.innerHTML = icon('chevron_right');
        b.appendChild(chev);
      }
      b.setAttribute('aria-label', [c.name, c.sub, what, c.current ? CHATS_WORDS.now : ''].filter(Boolean).join(', '));
      b.addEventListener('click', () => { close(false); if (!c.current) deps.open(c.id); });
      rows.appendChild(b);
    }
    const add = el('button', 'wr-sheetadd wr-chatsadd');
    add.type = 'button';
    add.innerHTML = icon('add');
    add.appendChild(document.createTextNode(CHATS_WORDS.newGroup));
    add.addEventListener('click', () => { close(false); if (familyId) deps.newWorkgroup(familyId); });
    rows.appendChild(add);
    sheet.append(head, rows);
    if (!sheet.contains(document.activeElement)) (sheet.querySelector('.wr-chatrow.on') || sheet.querySelector('.wr-chatrow') || x).focus();
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Tab' && sheet) {
      const f = [...sheet.querySelectorAll('button:not([disabled])')];
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
  }

  function open(from) {
    if (isOpen()) return;
    opener = from || null;
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
    scrim.remove();
    scrim = sheet = null;
    const back = opener && opener.isConnected ? opener : opener && deps.host.querySelector('.wr-chatsb:not([hidden])');
    opener = null;
    if (restoreFocus && back) back.focus();
    deps.onClose && deps.onClose();
  }

  return { open, close, refresh: render, isOpen, button };
}
