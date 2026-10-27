/* APP REGISTRATION STATUS, shared by every surface that shows it [ticket,
 * ticket]: Settings → Apps (web/settings-apps.mjs), the room's + → Apps
 * (web/room-add-apps.mjs) and the rail's title-bar badge (web/room-cells.mjs).
 *
 * The ENGINE decides the state (GET /api/apps: `state`; a room panel:
 * `app_status`); this module only words it, draws the chip, and opens
 * Settings → Apps the one way every surface does:
 *   - inside the CLI Manager shell (a tab): ask the shell, {hwbOpenSettings:
 *     {section:'apps'}}: it focuses the Settings tab (or opens one) at #apps;
 *   - a page of its own: a new window at /settings.html#apps (a blocked
 *     window.open navigates this page instead).
 *
 * States, one vocabulary: 'registered' | 'needs-approval' |
 * 'unregistered-candidate' (GET /api/apps `state`), and the panel's
 * `app_status` / {host:'app-status'} `actions`: 'enabled' | 'held' |
 * 'unregistered' — the same three facts from the panel's side.
 */

export const SETTINGS_APPS_URL = '/settings.html#apps';

const WORDS = {
  registered: 'Registered',
  'needs-approval': 'Needs approval',
  'unregistered-candidate': 'Not registered',
};

/** a panel's `actions` -> the catalog `state` */
export function stateOfActions(actions) {
  return actions === 'held' ? 'needs-approval' : actions === 'unregistered' ? 'unregistered-candidate' : 'registered';
}

export function stateWord(state) {
  return WORDS[state] ?? WORDS['unregistered-candidate'];
}

/* the module's own asset stamp, carried to the stylesheet it loads (the engine
   versions literal specifiers only) */
const STAMP = new URL(import.meta.url).search;
export function ensureStyles() {
  if (document.querySelector('link[data-app-status]')) {
    return;
  }
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = `/app-status.css${STAMP}`;
  l.dataset.appStatus = '1';
  document.head.append(l);
}

/** The state chip: a dot + the word. */
export function stateChip(state) {
  ensureStyles();
  const s = WORDS[state] ? state : 'unregistered-candidate';
  const c = document.createElement('span');
  c.className = 'app-chip';
  c.dataset.state = s;
  c.append(document.createElement('i'), WORDS[s]);
  return c;
}

/** Open Settings → Apps (see the header). */
export function openAppSettings() {
  if (window.parent !== window) {
    try {
      window.parent.postMessage({ hwbOpenSettings: { section: 'apps' } }, '*');
      return;
    } catch {
      /* no shell after all: fall through */
    }
  }
  const w = window.open(SETTINGS_APPS_URL, '_blank');
  if (!w) {
    location.assign(SETTINGS_APPS_URL);
  }
}

/** A "Settings ›" link that opens Settings → Apps the shared way. */
export function settingsLink(text = `Settings ${String.fromCharCode(8250)}`, cls = 'app-set-link') {
  ensureStyles();
  const a = document.createElement('a');
  a.className = cls;
  a.href = SETTINGS_APPS_URL;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = text;
  a.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openAppSettings();
  });
  return a;
}

/* ---- the Approve dialog's words (moved here from the + sheet) ---- */

const ARROW = String.fromCharCode(8594);
export function day(ts) {
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
const shown = (v) => (v === null || v === undefined ? 'none' : typeof v === 'string' ? v : JSON.stringify(v));

/** A postsToRoom setting {to, data} in words, after "…on your submit"
 *  [ticket]; '' for the plain ticket form (to the lead, no data). */
function postsHow(p) {
  if (!p) { return ''; }
  return (p.to === 'requester' ? ', addressed to the agent that requested the work' : '') + (p.data ? ', with a data payload for agents' : '');
}
/** Both halves, always said: a CHANGED setting names what it was and is. */
function postsWhole(p) {
  return `${p?.to === 'requester' ? 'addressed to the agent that requested the work' : "addressed to the room's lead"}, ${p?.data ? 'with a data payload for agents' : 'with no data payload'}`;
}

/** The engine's structured tool.json diff (GET /api/apps/:slug/diff) in
 *  plain words; a MUTATE verb is called out (cls 'warn'). */
export function diffLines(d) {
  const out = [];
  const L = (text, cls = '') => out.push({ text, cls });
  for (const v of d.verbs.added) {
    v.class === 'mutate' ? L(`New action "${v.name}" that CHANGES things (mutate)`, 'warn') : L(`New action "${v.name}" (${v.class === 'read' ? 'read-only' : v.class})`);
  }
  for (const v of d.verbs.changed) {
    v.to === 'mutate' ? L(`Action "${v.name}" now CHANGES things (${v.from} ${ARROW} mutate)`, 'warn') : L(`Action "${v.name}": ${v.from} ${ARROW} ${v.to}`);
  }
  for (const v of d.verbs.removed) {
    L(`Drops action "${v.name}"${v.class === 'mutate' ? ' (a mutate action)' : ''}`);
  }
  /* panel actions [ticket]: what a button in its panel may now DO */
  for (const n of d.actions?.added ?? []) { L(`Its panel's buttons may now trigger "${n}"`, 'warn'); }
  for (const n of d.actions?.changed ?? []) { L(`Panel action "${n}" now calls a different method or path`, 'warn'); }
  for (const n of d.actions?.removed ?? []) { L(`Its panel can no longer trigger "${n}"`); }
  /* [ticket] a submit in its panel posts a line to the room, as you;
     [ticket] addressed to the agent that asked, and/or with data for agents */
  for (const n of d.posts?.added ?? []) { L(`Panel action "${n}" may post lines to rooms on your submit${postsHow(d.posts.how?.[n])}`, 'warn'); }
  for (const c of d.posts?.changed ?? []) {
    L(`Panel action "${c.name}" now posts lines to rooms on your submit, ${postsWhole(c.to)} (was: ${postsWhole(c.from)})`, 'warn');
  }
  for (const n of d.posts?.removed ?? []) { L(`Panel action "${n}" no longer posts lines to rooms`); }
  /* host features [asset picker]: what its panels may ask the room page to open */
  const HOST_WORDS = { pick: 'the asset picker (choose an image from the room or the library)' };
  for (const n of d.host?.added ?? []) { L(`Its panels may now open ${HOST_WORDS[n] ?? n}`); }
  for (const n of d.host?.removed ?? []) { L(`Its panels can no longer open ${HOST_WORDS[n] ?? n}`); }
  for (const t of d.panels.added) { L(`New panel "${t}"`); }
  for (const t of d.panels.removed) { L(`Drops panel "${t}"`); }
  if (d.access) {
    L(d.access.to === 'exclusive' ? 'Becomes exclusive: one room at a time' : 'Becomes shared: any number of rooms at once', 'warn');
  }
  if (d.jobs) {
    L(d.jobs.to ? 'Now runs jobs (they can outlive a move)' : 'No longer declares jobs');
  }
  for (const n of d.needs) {
    L(n.from === null ? `Now needs ${n.key}: ${shown(n.to)}` : n.to === null ? `No longer needs ${n.key}` : `Needs ${n.key}: ${shown(n.from)} ${ARROW} ${shown(n.to)}`);
  }
  if (d.other.length) {
    L(`Also changed: ${d.other.join(', ')}`);
  }
  return out;
}

/** The intro line above the diff (same words the + sheet's dialog used). */
export function diffIntro(b, lines) {
  return !b.diff
    ? `tool.json changed since ${day(b.pinned_at)}; the engine can't show the difference yet.`
    : lines.length ? `Its tool.json changed since ${day(b.pinned_at)}:` : `Its tool.json changed since ${day(b.pinned_at)}, but only in its formatting: nothing it declares is different.`;
}
