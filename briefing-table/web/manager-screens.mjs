/* THE WORKBENCH'S SCREENS [workbench home] (the design system BUILD-HANDOFF 1.K: "Every screen has ‹ Workbench").
 *
 * Three views of ONE page: home (rooms, then live sessions), recipes (what you can start: Other CLIs, then Agents) and
 * history (recently closed, where Resume lives). They are not new components: the page already draws all three, and a
 * screen is which of them is showing (body[data-screen], the CSS does the rest). The screen rides the address (#recipes,
 * #history) so a reload or a restored shell tab lands where the person was, and the browser's own back works.
 * Art, Account, Showcase and Global settings still open BESIDE the manager (Owner 2026-09-15): they are other pages. */

export const SCREENS = { home: 'Workbench', recipes: 'Recipes', history: 'History' };

export function screenOf(hash) {
  const k = String(hash || '').replace(/^#/, '');
  return Object.prototype.hasOwnProperty.call(SCREENS, k) ? k : 'home';
}

export function createScreens() {
  const body = document.body;
  const bar = document.getElementById('wbBar');
  const title = document.getElementById('wbBarTitle');
  let current = 'home';

  function show(name, { fromHash = false } = {}) {
    const next = screenOf(name);
    current = next;
    body.dataset.screen = next;
    if (bar) {
      bar.hidden = next === 'home';
    }
    if (title) {
      title.textContent = SCREENS[next];
    }
    document.title = next === 'home' ? 'Workbench' : `${SCREENS[next]} · Workbench`;
    if (!fromHash) {
      const want = next === 'home' ? location.pathname + location.search : `#${next}`;
      history.pushState(null, '', want);
    }
    window.scrollTo(0, 0);
  }

  /* NOT `[data-screen]` alone: <body> carries data-screen too (it is what the CSS keys on), so the bare selector matched
     EVERY click on the page and preventDefault'ed it: no submit button, no link, until this was caught by a form that
     would not submit (rooms-reach.probe) */
  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target.closest('[data-screen]:not(body)') : null;
    if (t) {
      e.preventDefault();
      show(t.dataset.screen);
    }
  });
  window.addEventListener('popstate', () => show(location.hash, { fromHash: true }));
  window.addEventListener('hashchange', () => show(location.hash, { fromHash: true }));
  show(location.hash, { fromHash: true });

  /* the counts the menu and the Live bar show: recipes, closed sessions that can be resumed, restorable live sessions */
  function setCounts({ recipes, history: hist, restorable }) {
    const put = (id, n) => {
      const el = document.getElementById(id);
      if (el) {
        el.textContent = n === null || n === undefined ? '' : String(n);
      }
    };
    put('mgrScreenRecipesN', recipes);
    put('mgrScreenHistoryN', hist);
    const live = document.getElementById('liveRestorable');
    if (live) {
      live.hidden = !(restorable > 0);
      put('liveRestorableN', restorable);
    }
  }
  return { show, setCounts, get current() { return current; } };
}
