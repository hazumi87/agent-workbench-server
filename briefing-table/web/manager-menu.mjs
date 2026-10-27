/* THE MANAGER'S PHONE MENU (Owner 2026-10-03, room line [ref] thread: "cli-manager
 * doesn't have a way to get to settings on phone").
 *
 * A four-squares button at the left of the manager's phone header opens the same
 * bottom sheet the room and solo pages use (places-sheet.css). Top: the quick
 * menu (Rooms, Live agents: createPlaces without its own "Full CLI Manager"
 * row, we ARE the manager). Below: the PC window menu's items that work in a
 * phone browser. Skipped on purpose, they act on a native window: "Assemble
 * room from this window's tabs", "Reload CLI Manager (all tabs)", "Reset CLI
 * Manager". Not shown when embedded: the shell's own status menu is that menu.
 * Each item navigates THIS tab, as the room page's rail does.
 */
import { createPlaces } from '/room-places.mjs';

/** The PC status menu's items (shell.html act-menu) that make sense standalone,
 *  plus the manager header's own aux links. `href` null = read the live anchor
 *  (manager.js rewrites those from ui-config.json). */
export const MENU_ITEMS = [
  { label: 'Settings', href: '/settings.html' },
  { label: 'Account', anchor: 'accountBtn', href: '/account.html' },
  { label: 'Art', anchor: 'artBtn', href: '/art.html' },
];

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

function itemRow(item) {
  const href = (item.anchor && document.getElementById(item.anchor)?.getAttribute('href')) || item.href;
  const li = mk('li', 'seat pl-row pl-full');
  li.style.minHeight = '48px';
  li.tabIndex = 0;
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', 'false');
  li.dataset.menu = item.label;
  const top = mk('div', 'seat-top');
  top.style.gridColumn = '1 / 3';
  top.style.gridRow = '1 / 3';
  top.style.alignSelf = 'center';
  top.append(mk('span', 'seat-handle pl-name', item.label));
  const side = mk('div', 'seat-side pl-chev', '›');
  side.setAttribute('aria-hidden', 'true');
  li.append(top, side);
  const go = () => window.location.assign(href);
  li.addEventListener('click', go);
  li.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      go();
    }
  });
  return li;
}

export function initManagerMenu() {
  const btn = document.getElementById('mgrMenuBtn');
  const sheet = document.getElementById('phSheet');
  const scrim = document.getElementById('phScrim');
  const body = document.getElementById('phSheetBody');
  if (!btn || !sheet || window.parent !== window) {
    return; // embedded: the shell's own menu is this menu
  }
  btn.hidden = false; // CSS shows it at <=600px only
  let places = null;
  let recipes = new Map();
  let hidden = null;

  const close = () => {
    scrim.hidden = true;
    sheet.hidden = true;
  };
  const fill = () => {
    const keep = body.scrollTop;
    body.textContent = '';
    const section = (title) => {
      const ol = mk('ol');
      ol.setAttribute('role', 'listbox');
      ol.setAttribute('aria-label', title);
      body.append(mk('h3', null, title), ol);
      return ol;
    };
    body.append(mk('h3', null, 'Workbench'));
    places.fill(body, section);
    const more = section('Menu');
    for (const item of MENU_ITEMS) {
      more.append(itemRow(item));
    }
    body.scrollTop = keep;
  };
  const show = () => {
    scrim.hidden = false;
    sheet.hidden = false; // nothing is focused: a phone keyboard must not move on open
  };
  async function open() {
    if (!places) {
      const [r, me] = await Promise.all([
        fetch('/api/recipes').then((x) => (x.ok ? x.json() : null)).catch(() => null),
        fetch('/api/rooms/me').then((x) => (x.ok ? x.json() : null)).catch(() => null),
      ]);
      recipes = new Map((r?.recipes ?? []).map((x) => [x.id, x]));
      hidden = me?.hiddenRooms ?? null;
      places = createPlaces({
        roomId: null,
        noFullManager: true,
        hidden: () => hidden,
        recipeColor: (id) => recipes.get(id)?.color || null,
        recipeName: (id) => recipes.get(id)?.name || null,
        onChange: () => {
          if (!sheet.hidden) {
            fill();
          }
        },
      });
      scrim.addEventListener('click', close);
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && !sheet.hidden) {
          close();
        }
      });
    }
    fill();
    show();
  }
  btn.addEventListener('click', () => {
    open().catch((e) => {
      console.warn('manager menu failed', e);
      body.textContent = `Could not load: ${String(e?.message ?? e)}`;
      show();
    });
  });
}
