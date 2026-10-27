// Workbench chrome in Material 3 form: the tab strip, the session bar fill and the drop
// affordance. The activity ring and brand mark are the only the design pieces kept (the owner, 2026-10-15).

import { hwbRing, hwbRingFromChrome } from '../vendor/aurora/window-chrome/hwb-ring.js';
import { applyTo } from './m3.js';

export const icon = (name, cls = '') => '<span class="ms' + (cls ? ' ' + cls : '') + '" aria-hidden="true">' + name + '</span>';

// model: [{ id, name, seed, state: 'streaming'|'idle', active, markPath }]
export function renderTabs(root, { tabs, brand, onSelect, onNew }) {
  const strip = root.querySelector('.hwb-tabs');
  strip.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'hwb-scrollwrap';
  const scroll = document.createElement('div');
  scroll.className = 'hwb-scroll';
  for (const t of tabs) {
    const el = document.createElement('div');
    el.className = 'hwb-tab' + (t.active ? ' is-active' : '');
    el.dataset.tab = t.id;
    el.title = t.name;
    applyTo(el, t.seed);
    el.style.setProperty('--base', t.seed);
    const ring = document.createElement('span');
    hwbRing(ring, hwbRingFromChrome(t.state, { attached: true }), 20, { brand, markPath: t.markPath });
    const name = document.createElement('span');
    name.className = 'tname';
    name.textContent = t.name;
    const x = document.createElement('button');
    x.className = 'tclose';
    x.dataset.close = t.id;
    x.title = 'Hide this tab (the CLI keeps running)';
    x.setAttribute('aria-label', 'Hide tab');
    x.innerHTML = icon('close');
    el.append(ring, name, x);
    el.addEventListener('click', (e) => {
      if (!e.target.closest('.tclose')) {
        onSelect(t.id);
      }
    });
    scroll.appendChild(el);
  }
  wrap.appendChild(scroll);
  strip.append(wrap);
  // 0.19.0 (the owner , PM ): no "+" in any top bar; a new CLI starts from IN THIS WINDOW +
  if (onNew) {
    const add = document.createElement('button');
    add.className = 'hwb-newtab';
    add.title = 'New CLI';
    add.setAttribute('aria-label', 'New CLI');
    add.innerHTML = icon('add');
    add.addEventListener('click', onNew);
    strip.appendChild(add);
  }
}

// Session bar content: status ring, name and an activity chip. Callers append their buttons.
// `attached: false` gives the ring its disconnected look (a route error over the pane).
export function fillBar(el, { name, state, ringSize, brand, markPath, attached = true }) {
  el.textContent = '';
  const ring = document.createElement('span');
  ring.className = 'pane-ring';
  hwbRing(ring, hwbRingFromChrome(state, { attached }), ringSize, { brand, markPath });
  const title = document.createElement('div');
  title.className = 'sb-title';
  const nm = document.createElement('div');
  nm.className = 'sname';
  nm.textContent = name;
  title.appendChild(nm);
  // No Flowing/Idle chip: the ring already says it, and on a small pane the chip ate the title.
  const sp = document.createElement('div');
  sp.className = 'sp';
  el.append(ring, title, sp);
}

// ---- drop affordance for tabs dragged in from another window

export function dropIndex(root, clientX) {
  const tabs = [...root.querySelectorAll('.hwb-scroll .hwb-tab')];
  for (let i = 0; i < tabs.length; i++) {
    const r = tabs[i].getBoundingClientRect();
    if (clientX < r.left + r.width / 2) {
      return i;
    }
  }
  return tabs.length;
}

export function dropPreview(root, index) {
  root.classList.add('is-droptarget');
  root.dataset.dropIndex = String(index);
  const wrap = root.querySelector('.hwb-scrollwrap');
  if (!wrap) {
    return;
  }
  let caret = wrap.querySelector('.hwb-dropcaret');
  if (!caret) {
    caret = document.createElement('div');
    caret.className = 'hwb-dropcaret';
    wrap.appendChild(caret);
  }
  const tabs = [...root.querySelectorAll('.hwb-scroll .hwb-tab')];
  const box = wrap.getBoundingClientRect();
  let x = 0;
  if (tabs.length) {
    x = index >= tabs.length ? tabs[tabs.length - 1].getBoundingClientRect().right - box.left : tabs[index].getBoundingClientRect().left - box.left;
  }
  caret.style.left = Math.max(0, Math.min(x, box.width - 3)) + 'px';
}

export function clearDropPreview(root) {
  root.classList.remove('is-droptarget');
  delete root.dataset.dropIndex;
  const caret = root.querySelector('.hwb-dropcaret');
  if (caret) {
    caret.remove();
  }
}
