// Widgets in the web build: the mount (web/mounts.json loads it after renderer.js, web build only). It puts the
// widget layer over #main and the widgets button in the room's own toolbar (the design : a room opens it, like
// Notes; not a top-bar destination) (W1: a host-drawn menu, one row per widget module and node, checked when open,
// arrow keys and Escape), and wires the layer to the page: the module catalog
// (the same modules.js instance renderer.js imported), the frame guard, the theme, layout per browser in
// localStorage, and the engine for the two widget verbs. Logic lives in web-model.js / web-layer.js / list.js.

import { createFrameLink, moduleUiUrl } from '../module-frame.js';
import { catalogNow, onCatalogApplied, setRoomTools, themeMessage } from '../modules.js';
import { createWidgetModel } from './web-model.js';
import { createWidgetLayer } from './web-layer.js';
import { chooseRow, menuKey } from './list.js';

const STORE_KEY = 'wb.widgets.v1';
const NODES = [{ id: 'local', name: 'This PC', exists: true }];

const store = {
  read() {
    try { return JSON.parse(globalThis.localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; }
  },
  write(v) {
    try { globalThis.localStorage.setItem(STORE_KEY, JSON.stringify(v)); } catch { /* blocked or full: not kept */ }
  },
};

async function request(method, path) {
  const res = await fetch(new URL(path, location.origin), { method, credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

function mount() {
  const main = document.getElementById('main');
  if (!main) return;
  const root = document.createElement('div');
  root.id = 'wbw-layer';
  main.appendChild(root);

  const model = createWidgetModel({ catalog: () => catalogNow(), store, request });
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'wr-ib wbw-btn';
  button.id = 'widgetsBtn';
  button.title = 'Tools';
  button.setAttribute('aria-label', 'Tools');
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  const ic = document.createElement('span');
  ic.className = 'ms';
  ic.setAttribute('aria-hidden', 'true');
  ic.textContent = 'widgets';
  button.appendChild(ic);
  setRoomTools(() => [button]); // the rooms page puts it in each room header it draws (hidden while no widget is listed)
  const drawn = document.querySelector('.wr-more'); // a room header drawn before this mount ran: join it until its next draw
  if (drawn && drawn.parentElement) drawn.parentElement.insertBefore(button, drawn);

  let menu = null;
  function closeList() {
    if (!menu) return;
    menu.remove();
    menu = null;
    button.setAttribute('aria-expanded', 'false');
  }
  function refresh() {
    button.hidden = model.rows(NODES).length === 0;
    if (menu) { closeList(); openList(); }
  }
  const layer = createWidgetLayer({
    doc: document, root, model,
    makeLink: (o) => createFrameLink({ ...o, win: window }),
    entry: (id) => catalogNow().find((m) => m.id === id) || null,
    uiUrl: (m, page) => moduleUiUrl(m, page),
    declare: (url, owner) => window.wb.moduleFrameExpect({ url, owner }),
    theme: () => themeMessage().roles,
    onChange: () => refresh(),
  });

  function openList() {
    const rows = model.rows(NODES);
    menu = document.createElement('div');
    menu.className = 'wbw-list';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Tools');
    const items = rows.map((r) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wbw-li';
      b.setAttribute('role', 'menuitemcheckbox');
      b.setAttribute('aria-checked', String(r.checked));
      b.disabled = r.disabled;
      const i = document.createElement('span');
      i.className = 'ms';
      i.setAttribute('aria-hidden', 'true');
      i.textContent = r.icon;
      const t = document.createElement('span');
      t.textContent = r.label;
      b.appendChild(i);
      b.appendChild(t);
      b.addEventListener('click', () => {
        const c = chooseRow(r);
        closeList();
        if (c && c.open) layer.open(c.open);
        else if (c && c.close) layer.close(c.close);
        button.focus();
      });
      menu.appendChild(b);
      return b;
    });
    menu.addEventListener('keydown', (e) => {
      const at = items.indexOf(document.activeElement);
      const k = menuKey(at < 0 ? 0 : at, e.key, items.length);
      if (k === 'close') { closeList(); button.focus(); e.preventDefault(); }
      else if (typeof k === 'number') { items[k].focus(); e.preventDefault(); }
    });
    const r = button.getBoundingClientRect();
    menu.style.top = Math.round(r.bottom + 4) + 'px';
    menu.style.left = Math.round(r.left) + 'px';
    document.body.appendChild(menu);
    // the room toolbar sits at the right edge: keep the list inside the window
    const over = menu.getBoundingClientRect().right - (document.documentElement.clientWidth - 8);
    if (over > 0) menu.style.left = Math.max(8, Math.round(r.left - over)) + 'px';
    button.setAttribute('aria-expanded', 'true');
    items.find((b) => !b.disabled)?.focus();
  }
  button.addEventListener('click', () => (menu ? closeList() : openList()));
  document.addEventListener('pointerdown', (e) => {
    if (menu && !menu.contains(e.target) && e.target !== button && !button.contains(e.target)) closeList();
  });

  const size = () => layer.resize({ w: root.clientWidth, h: root.clientHeight });
  new ResizeObserver(size).observe(root);
  size();
  // after each catalog the renderer applies (the boot list, then the engine's): never race the event that carried it
  onCatalogApplied(() => { layer.sync(); refresh(); });
  new MutationObserver(() => layer.theme()).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] });
  refresh();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
else mount();
