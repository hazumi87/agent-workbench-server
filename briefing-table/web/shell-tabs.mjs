/* THE TAB SET, WRITTEN DOWN — so F5 does not empty the window.
 *
 * WHY THIS EXISTS (Owner, 2026-09-17): "i hit f5 to refresh the cli manager …
 * it cleared all the tabs." In WebView2 (and every Chromium), F5 / Ctrl+R with
 * focus inside an iframe reloads the TOP-LEVEL document — the shell — not the
 * frame. The shell then rebuilds itself from its own URL, and that URL carries
 * exactly ONE tab (`?tabs=<first>`, built by desktop-actions.shellUrl). Every
 * other tab in the window was only ever in memory, so it went. The 2026-09-15
 * discovery predicted this ("the tab SET is lost, since the window URL carries
 * only its first tab") and named the follow-up; this is it.
 *
 * WHY sessionStorage AND NOT localStorage — the scoping IS the design:
 *   - it is per TOP-LEVEL BROWSING CONTEXT, so it survives a reload of that
 *     window (the F5 case) …
 *   - … and a NEW window starts empty, so a torn-off tab does not inherit the
 *     window it came from (the tear-off case), and two shells never fight over
 *     one key. localStorage would get both of those exactly backwards.
 * No window id is needed (the host bridge does not publish one): the browser's
 * own scoping is the key.
 *
 * SAME-ORIGIN NEIGHBOURS: the shell's iframes (solo.html, manager.html) are on
 * this origin too, so they share this sessionStorage namespace. Hence the
 * distinctive key — nothing else in the repo writes `hwb.shell.*`.
 *
 * PURE ON PURPOSE. No DOM, no globals, storage passed in — so the serialise /
 * restore rules are unit-testable under node (test/shell-tabs.test.mjs, in
 * `npm test`) rather than only through a browser probe.
 */

export const TAB_SET_KEY = 'hwb.shell.tabset.v1';
export const TAB_SET_VERSION = 1;

/** A window with more tabs than this is not a window anyone is reading, and an
 *  unbounded write is how a storage quota error becomes a blank shell. */
export const TAB_SET_MAX = 40;

/** The fields that ARE identity and must survive a reload. `iframe` is a live
 *  DOM node and `id` is regenerated from the shell's own counter on the next
 *  load, so neither is written. `state` is deliberately included: a tab that
 *  was `waiting` should come back wearing the colour it had, and the engine
 *  corrects it within one message if it has moved on. */
const FIELDS = ['url', 'title', 'state', 'sessionId', 'base', 'logoKey'];

function cleanTab(t) {
  if (!t || typeof t !== 'object') { return null; }
  if (typeof t.url !== 'string' || !t.url) { return null; }
  const out = {};
  for (const k of FIELDS) {
    const v = t[k];
    out[k] = typeof v === 'string' && v ? v : null;
  }
  out.url = t.url;
  return out;
}

/**
 * Tab array (the shell's live model) → the plain object that gets written.
 * `activeIndex`, not `activeId`: ids are per-load sequence numbers and mean
 * nothing to the next load, while position in the set does.
 */
export function serializeTabSet(tabs, activeId, shellHref) {
  const list = (Array.isArray(tabs) ? tabs : []).map(cleanTab).filter(Boolean).slice(0, TAB_SET_MAX);
  let activeIndex = 0;
  if (Array.isArray(tabs)) {
    const kept = tabs.filter((t) => cleanTab(t)).slice(0, TAB_SET_MAX);
    const i = kept.findIndex((t) => t && t.id === activeId);
    if (i >= 0) { activeIndex = i; }
  }
  /* THE SHELL'S OWN URL AT WRITE TIME — what separates a RELOAD from a
     NAVIGATION, and therefore what stops a deliberately-closed tab coming
     back. See planInitialTabs. */
  return {
    v: TAB_SET_VERSION,
    at: Date.now(),
    href: typeof shellHref === 'string' ? shellHref : null,
    activeIndex,
    tabs: list,
  };
}

/**
 * The written object (or its JSON) → `{ tabs, activeIndex }`, or null.
 *
 * NULL FOR ANYTHING IT DOES NOT FULLY UNDERSTAND — a wrong version, a shape it
 * cannot read, an empty set. A shell that restores half a set is worse than one
 * that falls back to its URL, because the fallback is a state the user already
 * recognises. Never throws: a malformed value must cost a fallback, not a blank
 * window.
 */
export function parseTabSet(raw) {
  let o = raw;
  if (typeof raw === 'string') {
    try { o = JSON.parse(raw); } catch { return null; }
  }
  if (!o || typeof o !== 'object') { return null; }
  if (o.v !== TAB_SET_VERSION) { return null; }
  const tabs = (Array.isArray(o.tabs) ? o.tabs : []).map(cleanTab).filter(Boolean).slice(0, TAB_SET_MAX);
  if (tabs.length === 0) { return null; }
  let activeIndex = Number.isInteger(o.activeIndex) ? o.activeIndex : 0;
  if (activeIndex < 0 || activeIndex >= tabs.length) { activeIndex = 0; }
  return {
    tabs,
    activeIndex,
    at: typeof o.at === 'number' ? o.at : 0,
    href: typeof o.href === 'string' ? o.href : null,
  };
}

/* ---- storage wrappers ---------------------------------------------------
 * Every read and write is wrapped: a private window, blocked site data, or a
 * quota can make any of these throw, and none of it is worth a broken shell.
 * The shell must render correctly with storage that never works. */

export function readTabSet(storage) {
  try {
    return parseTabSet(storage && storage.getItem(TAB_SET_KEY));
  } catch { return null; }
}

export function writeTabSet(storage, tabs, activeId, shellHref) {
  try {
    const set = serializeTabSet(tabs, activeId, shellHref);
    if (set.tabs.length === 0) {
      /* A window with no tabs is closing, not a set worth keeping — and an
         empty write would be read back as "restore nothing", which parseTabSet
         already refuses. Remove rather than write a lie. */
      storage.removeItem(TAB_SET_KEY);
      return null;
    }
    storage.setItem(TAB_SET_KEY, JSON.stringify(set));
    return set;
  } catch { return null; }
}

export function clearTabSet(storage) {
  try { storage.removeItem(TAB_SET_KEY); } catch { /* nothing to do */ }
}

/**
 * WHAT THIS WINDOW SHOULD OPEN WITH.
 *
 * The URL's `?tabs=` is a MEMBER of the set, never the whole of it — that
 * asymmetry is the entire fix.
 *
 * WHETHER A URL TAB IS ADDED DEPENDS ON WHY WE ARE HERE, and the stored
 * `href` is what tells the two apart:
 *
 *   RELOAD (same URL as when the set was written) — the URL's tabs were
 *     already dealt with on the load that wrote the set. Re-adding them brings
 *     back a tab the user deliberately CLOSED, which is the same defect as
 *     losing one, wearing the opposite sign.
 *   NAVIGATION (a different URL) — the host is telling this window to show
 *     something. A tab it was told to open must not be silently dropped, so
 *     anything the set does not already hold is appended.
 *
 * `source` is returned because it is the one thing worth logging: "session" vs
 * "url" answers "did the restore run" without reading storage by hand.
 */
export function planInitialTabs(stored, urlTabs, shellHref) {
  const urls = (Array.isArray(urlTabs) ? urlTabs : []).filter((u) => typeof u === 'string' && u);
  if (!stored || !Array.isArray(stored.tabs) || stored.tabs.length === 0) {
    return {
      tabs: urls.map((u) => ({ url: u, title: null, state: null, sessionId: null, base: null, logoKey: null })),
      activeIndex: 0,
      source: 'url',
    };
  }
  const tabs = stored.tabs.slice();
  const reloaded = typeof shellHref === 'string' && !!stored.href && stored.href === shellHref;
  if (!reloaded) {
    const have = new Set(tabs.map((t) => t.url));
    for (const u of urls) {
      if (!have.has(u)) {
        tabs.push({ url: u, title: null, state: null, sessionId: null, base: null, logoKey: null });
        have.add(u);
      }
    }
  }
  let activeIndex = stored.activeIndex;
  if (!Number.isInteger(activeIndex) || activeIndex < 0 || activeIndex >= tabs.length) { activeIndex = 0; }
  return { tabs: tabs.slice(0, TAB_SET_MAX), activeIndex, source: reloaded ? 'session' : 'session+url' };
}

/**
 * Is this keystroke the browser's "reload the page"?
 *
 * F5, Ctrl+R, Cmd+R, and the hard-reload variants. Ctrl+Shift+R counts: the
 * user is asking for a refresh either way, and what they mean by it is THIS
 * TAB, not the window frame around it.
 *
 * Deliberately NOT matched: Ctrl+F5 with Alt, anything with Alt at all (an OS
 * accelerator), and F5 inside a text field is still a reload — F5 types
 * nothing, so there is no editing gesture to protect.
 */
export function isReloadKey(e) {
  if (!e || e.altKey) { return false; }
  if (e.key === 'F5') { return true; }
  const k = typeof e.key === 'string' ? e.key.toLowerCase() : '';
  return (e.ctrlKey || e.metaKey) && k === 'r';
}

/* (v21 bar wash: the prep's washVars() lived here. The released bundle
   measures it itself — hwbPositionBarWash, on render, scroll and resize — so
   the shell no longer computes it; one mechanism, the bundle's.) */

/* ==== which pane a tab holds ==============================================
 * The v21 bundle names a tab by the shell's tab id; ending its session needs
 * the ENGINE's paneid. The shell's `sessionId` is not reliably that (solo pages
 * never send one), but the URL always is: solo.html resolves its paneid as
 * `?pane=` or else `recipe:<?recipe=>` (web/solo.js), so this mirrors that one
 * line. Null for anything that is not a session page (the Manager, mocks).
 */
export function paneidFromTabUrl(url) {
  let u;
  try { u = new URL(url, 'http://x/'); } catch (e) { return null; }
  if (!/(^|\/)solo\.html$/.test(u.pathname)) { return null; }
  const pane = u.searchParams.get('pane');
  if (pane) { return pane; }
  const recipe = u.searchParams.get('recipe');
  return recipe ? `recipe:${recipe}` : null;
}

/* ==== the v21 bundle's tab events, routed to paths that already exist ====
 * Names and detail shapes are the design system v21 wiring list. Each maps onto a verb
 * the shell already has, so the bundle adds no new behaviour - only new
 * triggers:
 *   hwb:close-view  {id, reason}  -> close the TAB (session parks in the broker)
 *   hwb:end-session {id}          -> the CLI Manager's "End" (bundle confirmed)
 *   hwb:refresh     {id}          -> reload that tab's page
 * Returns what it did (for the log and the tests); unknown types and events
 * without an id are ignored, never thrown.
 */
export const BUNDLE_EVENTS = ['hwb:close-view', 'hwb:end-session', 'hwb:refresh'];

export function routeBundleEvent(type, detail, handlers) {
  const id = detail && typeof detail.id === 'string' ? detail.id : null;
  if (!id || !handlers) { return null; }
  if (type === 'hwb:close-view') {
    handlers.closeView(id, typeof detail.reason === 'string' ? detail.reason : '');
    return 'close-view';
  }
  if (type === 'hwb:end-session') {
    handlers.endSession(id);
    return 'end-session';
  }
  if (type === 'hwb:refresh') {
    handlers.refresh(id);
    return 'refresh';
  }
  return null;
}

/* ==== the v21 session bar's icons ==========================================
 * hwbRenderSessionBar's three icons dispatch these (bubbling, no detail). The
 * data behind them belongs to the tab's PAGE, so the shell forwards each as
 * {hwbBarAction: <kind>} to the selected tab's iframe. */
export const BAR_EVENTS = ['hwb:messages', 'hwb:handoff', 'hwb:links'];

export function barActionFor(type) {
  return BAR_EVENTS.includes(type) ? type.slice(4) : null;
}
