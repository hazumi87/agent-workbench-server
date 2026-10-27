/* GLOBAL SETTINGS (Owner 2026-09-28): settings that belong to the PERSON across
 * every room live on this page, not in each room's ⚙ column. Opened from the
 * CLI Manager's status menu (a shell tab) or directly at /settings.html.
 *
 * DATA. One object, `me` = the answer of GET /api/rooms/me (per person: name,
 * handle, picture, hiddenRooms, the bubble prefs, and soon `voice`). Writes go
 * to PATCH /api/rooms/me, which is HUMAN-ONLY: a bearer gets 403, so this page
 * rides the person's window cookie exactly as the room page does.
 *
 * ==== THE MOUNT CONTRACT (groups owned by other modules) ====================
 *
 * GROUPS below lists every mounted group as
 *     { id, title, module: '/<file>.mjs', export: '<name>' }
 * For each one the page:
 *   1. draws the group frame, in list order: <section class="pv-grp"
 *      data-group="<id>"> with an <h4><title></h4> header and an empty body
 *      element `el` under it;
 *   2. dynamically imports `module` (same origin, same cookie);
 *   3. calls  handle = await mod[export](el, { me, save })
 * The module owns everything inside `el` and nothing outside it. It loads its
 * own CSS if it needs any beyond the classes listed under STYLING.
 *
 *   me            the latest GET /api/rooms/me object. It is ONE shared object,
 *                 updated IN PLACE (by save() and by every refetch), so a group
 *                 that keeps the reference always reads current values.
 *   save(patch)   -> Promise<me>. Sends PATCH /api/rooms/me with `patch` as the
 *                 JSON body, merges the server's answer into `me`, and resolves
 *                 with `me`. It does NOT re-render the calling group: that group
 *                 repaints its own controls. The page then calls update(me) on
 *                 every OTHER group (below).
 *                 On a 4xx/5xx it REJECTS with an Error whose message is the
 *                 server's own `error` text (else "HTTP <status>"), with
 *                 `.status` set, so the group can show it inline beside the
 *                 control. A network failure rejects with the fetch error.
 *   handle        what the mount returns: optionally { update(me) }. Returning
 *                 nothing (or no update) is fine. The page calls
 *                 handle.update(me) when `me` changed ELSEWHERE:
 *                   - after another group's save() resolved;
 *                   - after the page refetched GET /api/rooms/me, which it does
 *                     when the page comes back into view (visibilitychange to
 *                     visible, and window focus; coalesced into one fetch).
 *                 update() should repaint from `me` without losing an edit in
 *                 progress. A throw inside update() is logged and ignored.
 *
 * FAILURE IS QUIET AND LOCAL. If the module cannot be loaded (404, a syntax
 * error), has no such export, or the mount function throws/rejects, the group
 * body is emptied and shows one line, "Not available yet", and the page goes
 * on: the other groups and the page itself never break. The cause goes to the
 * console only. The section's data-state says which: mounted | missing | failed.
 * Groups load independently: one that fails or hangs never holds another.
 *
 * STYLING. The page carries the room ⚙ column's classes (web/settings.css):
 * pv-lbl, pv-note, pv-msg (data-kind="error"), pv-btn (.pri, .pv-txt), pv-in,
 * pv-sel, pv-chips / pv-chip. Use them; do not bring a new visual language.
 * The layout must hold at 390px wide with no sideways scroll.
 * ============================================================================ */

import { loadEdition } from '/edition.mjs';

const GROUPS = [
  /* your picture + your @name (Owner 2026-09-30): moved here from each room's
     ⚙ column -- this is now the ONE place either is edited. Listed first so
     it draws first, same order as before the move. */
  { id: 'you', title: 'You', module: '/you-settings.mjs', export: 'mountYouSettings' },
  /* the voice globals: built by the voice team as its own module */
  { id: 'voice', title: 'Voice', module: '/voice-global-settings.mjs', export: 'mountVoiceGlobals' },
  /* GLOBAL COLOR PALETTE (hub V2, Owner 2026-10-05): the app's base colors + the
     app title-bar tones, per person; applies at once on every page */
  { id: 'palette', title: 'Global color palette', module: '/settings-palette.mjs', export: 'mountPaletteSettings', tag: 'new' },
  /* register / approve / unregister apps for every room [ticket] */
  { id: 'apps', title: 'Apps', module: '/settings-apps.mjs', export: 'mountAppsSettings' },
  /* how the right-hand column's app behaves when you switch room or workgroup [room switch] (Owner 2026-10-08): a NEW section */
  { id: 'app-behavior', title: 'App behavior', module: '/settings-app-behavior.mjs', export: 'mountAppBehaviorSettings', tag: 'new' },
  /* system-wide rest (level 1, any agent) + disconnect (level 2, the 2026-10-04 idle rest)
     + wake toggles [agent rest] (Owner 2026-10-07) */
  { id: 'idle-rest', title: 'Agents · rest', module: '/settings-idle-rest.mjs', export: 'mountIdleRestSettings' },
  /* every chatter rule: off / watch / enforce, monitor-only by default (Owner 2026-10-07) [agent comms] */
  { id: 'agent-comms', title: 'Agent comms', module: '/settings-agent-comms.mjs', export: 'mountAgentCommsSettings', tag: 'new' },
  /* quiet agents + what crossed a chatter limit (Owner 2026-10-06) [chatter] */
  { id: 'chatter', title: 'Agents · chatter', module: '/settings-chatter.mjs', export: 'mountChatterSettings', tag: 'new' },
  /* the Concierge: which recipe, enabled, allowed actions (the design notes P0); never in Basic */
  { id: 'concierge', title: 'Concierge', module: '/settings-concierge.mjs', export: 'mountConciergeSettings', tag: 'new' },
];

/* versioned like every other asset (the engine stamps literal specifiers only;
   these are data, so carry this module's own stamp across) */
const STAMP = new URL(import.meta.url).search;

const $ = (id) => document.getElementById(id);
function mk(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) {
    el.className = cls;
  }
  if (text !== undefined) {
    el.textContent = text;
  }
  return el;
}

const me = {};
/** id -> the handle a group returned ({update(me)}), the You group's included */
const handles = new Map();

/** Replace `me`'s contents in place (a key the server dropped goes too). */
function adopt(next) {
  for (const k of Object.keys(me)) {
    if (!(k in next)) {
      delete me[k];
    }
  }
  Object.assign(me, next);
}

function notify(exceptId) {
  for (const [id, h] of handles) {
    if (id === exceptId || typeof h?.update !== 'function') {
      continue;
    }
    try {
      h.update(me);
    } catch (e) {
      console.warn(`settings: group "${id}" update threw:`, e);
    }
  }
}

async function readMe() {
  const res = await fetch('/api/rooms/me', { cache: 'no-store' });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) {
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return body;
}

async function saveFrom(groupId, patch) {
  const res = await fetch('/api/rooms/me', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch ?? {}),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  Object.assign(me, body ?? {});
  notify(groupId);
  return me;
}

/* coming back into view: one refetch, then every group repaints */
let refetching = null;
function refetch() {
  if (refetching || !handles.size) {
    return refetching;
  }
  refetching = readMe()
    .then((next) => {
      adopt(next);
      notify(null);
    })
    .catch((e) => console.warn('settings: refetch failed:', e))
    .finally(() => {
      refetching = null;
    });
  return refetching;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void refetch();
  }
});
window.addEventListener('focus', () => void refetch());

/* SECTION MENU (hub V2): one link per group, drawn at once (the groups mount
   later), the current one following the scroll */
function buildNav() {
  const nav = $('nav');
  for (const spec of GROUPS) {
    const a = mk('a', '', spec.title);
    a.href = `#${spec.id}`;
    a.dataset.nav = spec.id;
    if (spec.tag) {
      a.append(mk('span', 'new', spec.tag));
    }
    nav.append(a);
  }
  const setCurrent = (id) => {
    for (const a of nav.children) {
      a.setAttribute('aria-current', String(a.dataset.nav === id));
    }
  };
  setCurrent(GROUPS[0]?.id);
  nav.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-nav]');
    if (a) {
      setCurrent(a.dataset.nav);
    }
  });
  if (typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (en.isIntersecting) {
            setCurrent(en.target.id);
          }
        }
      },
      { rootMargin: '-10% 0px -70% 0px' },
    );
    for (const g of document.querySelectorAll('#groups > .pv-grp')) {
      io.observe(g);
    }
  }
}

function section(id, title) {
  const g = mk('section', 'pv-grp');
  g.dataset.group = id;
  g.id = id; // a deep link lands on it: /settings.html#apps
  const body = mk('div', 'st-body');
  g.append(mk('h4', '', title), body);
  $('groups').append(g);
  return { g, body };
}

/* ---- mounted groups (the "You" group is one of these now too -- see
   GROUPS above; web/you-settings.mjs owns its editor) ---- */
async function mountGroup(spec) {
  const { g, body } = section(spec.id, spec.title);
  g.dataset.state = 'loading';
  const unavailable = (state, why) => {
    g.dataset.state = state;
    body.replaceChildren(mk('p', 'pv-note', 'Not available yet'));
    console.warn(`settings: group "${spec.id}" ${state}:`, why);
  };
  let mount;
  try {
    const mod = await import(spec.module + STAMP);
    mount = mod?.[spec.export];
  } catch (e) {
    unavailable('missing', e);
    return;
  }
  if (typeof mount !== 'function') {
    unavailable('missing', `${spec.module} has no export ${spec.export}`);
    return;
  }
  try {
    const handle = await mount(body, { me, save: (patch) => saveFrom(spec.id, patch) });
    handles.set(spec.id, handle ?? null);
    g.dataset.state = 'mounted';
  } catch (e) {
    unavailable('failed', e);
  }
}

/* what a BASIC instance does not have [basic] (Owner 2026-10-08): voice, Agent comms, Agents · chatter */
const BASIC_HIDES = new Set(['voice', 'agent-comms', 'chatter', 'concierge']);

async function boot() {
  if ((await loadEdition()) === 'basic') {
    GROUPS.splice(0, GROUPS.length, ...GROUPS.filter((g) => !BASIC_HIDES.has(g.id)));
  }
  if (window.parent !== window) {
    $('backLink').hidden = true; // a shell tab: the Manager is its own tab
  }
  try {
    adopt(await readMe());
  } catch (e) {
    $('status').textContent = `Could not load your settings: ${e?.message ?? e}`;
    $('status').dataset.kind = 'error';
    return;
  }
  $('status').textContent = '';
  /* frames drawn in order at once (section() runs before any await); each
     group loads on its own, so one that fails or hangs never holds the next */
  const mounts = GROUPS.map(mountGroup);
  buildNav(); // the frames exist by now (section() ran synchronously above)
  await Promise.all(mounts);
  toHash();
}

/* DEEP LINK: #<group id> scrolls to that group once it is drawn (the groups
   mount after load, so the browser's own jump lands too early), and again
   when the hash changes on an open page (the shell re-aims its Settings tab) */
function toHash() {
  const id = location.hash.slice(1);
  const g = id && /^[a-z][a-z0-9-]*$/.test(id) ? document.getElementById(id) : null;
  if (g?.classList.contains('pv-grp')) {
    g.scrollIntoView({ block: 'start' });
  }
}
window.addEventListener('hashchange', toHash);

void boot();
