// The room's tools on a phone (the design s10): a bottom sheet opened from the header's "Tools" button, the seats sheet's pattern. One 72 px row per tool the
// room offers (a tool card, or an added tool's page): its icon, its name, the card's line and note, a chevron. Tapping a row hands the tool to the page.
import { icon } from '../m3-chrome.js';
import { el } from './line.js';

/** What a row says under the name: the card's line, its progress, and what needs the person. */
export function toolNote(item) {
  return [item.pct !== null && item.pct !== undefined ? item.pct + '% done' : '', item.line || '', item.badge ? item.badge + ' need you' : ''].filter(Boolean).join(' · ');
}

/** deps: host (the page root), items() -> [{key, icon, title, line, pct, badge, open()}], onClose() */
export function createToolsSheet(deps) {
  let scrim = null, sheet = null, opener = null;
  const isOpen = () => !!scrim;

  function render() {
    if (!sheet) return;
    const items = deps.items();
    sheet.textContent = '';
    const head = el('div', 'wr-sheethead');
    head.appendChild(el('div', 'wr-sheettitle', 'Tools · ' + items.length));
    const x = el('button', 'wr-ib wr-sheetx');
    x.type = 'button';
    x.title = 'Close';
    x.setAttribute('aria-label', 'Close');
    x.innerHTML = icon('close');
    x.addEventListener('click', () => close());
    head.appendChild(x);
    sheet.setAttribute('aria-label', 'Tools · ' + items.length);
    const list = el('div', 'wr-sheetlist');
    for (const it of items) {
      const b = el('button', 'wr-sheetrow wr-toolrow');
      b.type = 'button';
      b.dataset.tool = it.key;
      const tile = el('span', 'wr-tooltile');
      tile.innerHTML = icon(it.icon || 'extension');
      const tx = el('span', 'wr-sheettx');
      tx.appendChild(el('span', 'wr-sheetnm', it.title));
      const note = toolNote(it);
      if (note) tx.appendChild(el('span', 'wr-sheetst', note));
      const chev = el('span', 'wr-toolchev');
      chev.innerHTML = icon('chevron_right');
      b.append(tile, tx, chev);
      b.setAttribute('aria-label', note ? it.title + ', ' + note : it.title);
      b.addEventListener('click', () => { close(); it.open(); });
      list.appendChild(b);
    }
    sheet.append(head, list);
    if (!sheet.contains(document.activeElement)) (sheet.querySelector('.wr-toolrow') || x).focus();
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
    const back = opener && opener.isConnected ? opener : opener && deps.host.querySelector('.wr-toolsb:not([hidden])');
    opener = null;
    if (restoreFocus && back) back.focus();
    deps.onClose && deps.onClose();
  }

  return { open, close, refresh: render, isOpen };
}
