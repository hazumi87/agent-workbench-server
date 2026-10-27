/* THE WORKBENCH TITLE BAR: the find box and the one ⋯ menu [workbench home] (the design system BUILD-HANDOFF 1.K "The Workbench").
 *
 * FIND filters what is already on the page by name, nothing is fetched: a room card (its name, its lead and its workgroups' names), a live session, a recently closed one, a recipe card. A filtered
 * page says so ("No match") rather than going blank. The lists repaint themselves (the engine pushes), so the filter is
 * re-applied after each repaint (a MutationObserver), never held in a flag the next render would clear.
 *
 * THE ⋯ MENU is a popover under the button on a PC and a bottom sheet on a phone. It only HOLDS the aux anchors
 * (Art, Account, Showcase, Global settings): their click behaviour (a new tab beside the manager) stays in manager.js. */

const LISTS = ['roomList', 'liveList', 'recentList', 'otherList', 'agentList'];

/** One filterable unit per list child (a room card, a live row, a recent group, a recipe card). */
function units(root) {
  return [...root.children].filter((c) => c.id !== 'roomNewCard' && c.id !== 'newSessionCard').map((c) => [c]); // the + card is never filtered away
}

export function matches(text, q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const t = text.toLowerCase();
  return words.every((w) => t.includes(w));
}

export function applyFind(q) {
  const query = q.trim();
  let shown = 0;
  let total = 0;
  for (const id of LISTS) {
    const root = document.getElementById(id);
    if (!root) {
      continue;
    }
    for (const group of units(root)) {
            const text = group.map((n) => n.textContent ?? '').join(' ');
      const hit = !query || matches(text, query);
      for (const n of group) {
        n.toggleAttribute('data-found-hide', !hit);
      }
      if (n_visible(group[0])) {
        total += 1;
        shown += hit ? 1 : 0;
      }
    }
  }
  const note = document.getElementById('mgrFindNone');
  if (note) {
    note.hidden = !(query && total > 0 && shown === 0);
    note.textContent = `No room or session matches “${query}”.`;
  }
  return { shown, total };
}

/* a list child that is not hidden by something else (an empty list's placeholder counts as nothing) */
function n_visible(n) {
  return !n.hidden && !n.classList.contains('rr-empty');
}

export function initFind() {
  const input = document.getElementById('mgrFind');
  if (!input) {
    return;
  }
  const run = () => applyFind(input.value);
  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      input.value = '';
      run();
    }
  });
  let t = 0;
  const mo = new MutationObserver(() => {
    if (input.value.trim()) {
      clearTimeout(t);
      t = setTimeout(run, 30);
    }
  });
  for (const id of LISTS) {
    const el = document.getElementById(id);
    if (el) {
      mo.observe(el, { childList: true });
    }
  }
}

export function initMore() {
  const btn = document.getElementById('mgrMore');
  const menu = document.getElementById('mgrMoreMenu');
  if (!btn || !menu) {
    return;
  }
  const close = (refocus) => {
    if (menu.hidden) {
      return;
    }
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.getElementById('mgrMoreScrim')?.remove();
    if (refocus) {
      btn.focus({ preventScroll: true });
    }
  };
  const open = () => {
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    const scrim = document.createElement('div');
    scrim.id = 'mgrMoreScrim';
    scrim.className = 'mgr-more-scrim';
    scrim.addEventListener('click', () => close(false));
    document.body.append(scrim);
    /* a PC focuses the first item; a touch screen never raises focus on its own */
    if (!matchMedia('(pointer: coarse)').matches) {
      [...menu.querySelectorAll('.mgr-mi')].find((a) => !a.hidden)?.focus({ preventScroll: true });
    }
  };
  btn.addEventListener('click', () => (menu.hidden ? open() : close(true)));
  menu.addEventListener('click', (e) => {
    if (e.target.closest('.mgr-mi')) {
      close(false); // the aux handler in manager.js does the opening
    }
  });
  document.addEventListener('keydown', (e) => {
    if (menu.hidden) {
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [...menu.querySelectorAll('.mgr-mi')].filter((a) => !a.hidden);
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
  });
}
