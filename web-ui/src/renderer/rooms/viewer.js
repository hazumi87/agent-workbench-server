// Workrooms (W1): the image viewer. One message's images only, over the whole Workrooms tab: a 52 px
// top bar (sender · time, Download, Open in a window, close), the image centered, round arrows, "2 of 3"
// under it. Esc closes; ← → move (the design's step-5 page, figure s4).
import { icon } from '../m3-chrome.js';
import { el, timeWords } from './line.js';

export function createViewer(deps) {
  const root = el('div', 'wr-viewer');
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Image viewer');
  const bar = el('div', 'wr-vbar');
  const title = el('div', 'wr-vtitle');
  const dl = el('button', 'wr-vib');
  dl.type = 'button';
  dl.title = 'Download';
  dl.setAttribute('aria-label', 'Download');
  dl.innerHTML = icon('download');
  const win = el('button', 'wr-vib');
  win.type = 'button';
  win.title = 'Open in a window';
  win.setAttribute('aria-label', 'Open in a window');
  win.innerHTML = icon('open_in_new');
  const close = el('button', 'wr-vib');
  close.type = 'button';
  close.title = 'Close';
  close.setAttribute('aria-label', 'Close');
  close.innerHTML = icon('close');
  bar.append(title, dl, win, close);
  const stage = el('div', 'wr-vstage');
  const prev = el('button', 'wr-varrow left');
  prev.type = 'button';
  prev.setAttribute('aria-label', 'Previous image');
  prev.innerHTML = icon('chevron_left');
  const next = el('button', 'wr-varrow right');
  next.type = 'button';
  next.setAttribute('aria-label', 'Next image');
  next.innerHTML = icon('chevron_right');
  const img = document.createElement('img');
  img.className = 'wr-vimg';
  const count = el('div', 'wr-vcount');
  stage.append(prev, img, next);
  root.append(bar, stage, count);
  let items = [];
  let at = 0;
  let lastFocus = null;

  async function show() {
    const it = items[at];
    if (!it) {
      return;
    }
    title.textContent = [it.who, timeWords(it.ts)].filter(Boolean).join(' · ');
    count.textContent = at + 1 + ' of ' + items.length;
    prev.hidden = items.length < 2;
    next.hidden = items.length < 2;
    img.alt = it.name;
    img.removeAttribute('src');
    img.classList.add('loading');
    const url = await deps.image(it.roomId, it.name);
    if (items[at] !== it) {
      return;
    }
    img.classList.remove('loading');
    if (url) {
      img.src = url;
    } else {
      img.alt = "Can't load " + it.name;
    }
  }
  function open(list, index) {
    items = list || [];
    at = Math.max(0, Math.min(index || 0, items.length - 1));
    if (!items.length) {
      return;
    }
    lastFocus = document.activeElement;
    root.hidden = false;
    show();
    close.focus();
  }
  function hide() {
    root.hidden = true;
    img.removeAttribute('src');
    if (lastFocus && lastFocus.focus) {
      lastFocus.focus();
    }
  }
  function move(d) {
    if (items.length < 2) {
      return;
    }
    at = (at + d + items.length) % items.length;
    show();
  }
  close.addEventListener('click', hide);
  prev.addEventListener('click', () => move(-1));
  next.addEventListener('click', () => move(1));
  dl.addEventListener('click', () => {
    const it = items[at];
    if (it && deps.download) {
      deps.download(it.roomId, it.name);
    }
  });
  win.addEventListener('click', () => {
    const it = items[at];
    if (it && deps.openWindow) {
      deps.openWindow(it.roomId, it.name);
    }
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hide();
    } else if (e.key === 'ArrowLeft') {
      move(-1);
    } else if (e.key === 'ArrowRight') {
      move(1);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  });
  stage.addEventListener('click', (e) => {
    if (e.target === stage) {
      hide();
    }
  });
  return { el: root, open, hide, isOpen: () => !root.hidden, state: () => ({ open: !root.hidden, at, count: items.length, title: title.textContent }) };
}
