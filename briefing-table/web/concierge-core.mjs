/* THE CONCIERGE ICON'S PURE RULES (web/concierge.mjs is the DOM). Unit-tested in
 * test/concierge-web.test.mjs: when the icon shows, what it says, how a wb: chip
 * opens (the design notes P1: a desktop or iPad opens a NEW shell tab, a
 * phone navigates). */

/** True when there is a Concierge to show (on, with an active recipe). Basic answers 404, so no status at all. */
export function shown(st) {
  return !!st && !!st.settings?.enabled && !!st.active;
}

/** The icon's tooltip and accessible name. */
export function iconTitle(st, n) {
  if (!shown(st)) return '';
  if (!st.prerequisite?.paneTokens) return 'Concierge: pane tokens are off on this engine, so it cannot see the Workbench yet';
  return n > 0 ? `Concierge: ${n} new ${n === 1 ? 'reply' : 'replies'}` : `Concierge (${st.active.name})`;
}

/** How a link opens: inside the shell a NEW tab; a phone navigates this tab; a bare desktop page opens a browser tab. */
export function linkAction(where) {
  if (where.embedded) return 'shell-tab';
  return where.phone ? 'navigate' : 'window';
}

/** The message the shell's tab handler takes; a room keeps one tab per room by its sessionId. */
export function openTabMessage(l) {
  return { hwbOpenTab: { url: l.url, title: l.label || null, ...(l.room ? { sessionId: `room:${l.room}` } : {}) } };
}
