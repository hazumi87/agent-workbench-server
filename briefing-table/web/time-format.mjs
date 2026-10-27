/* ONE CLOCK FOR EVERY LINE [time format] Owner 2026-10-06: the agent Chat tab showed 24-hour times while the room's line shows
 * the viewer's own clock (12-hour with AM/PM in a 12-hour locale). The room line, the agent chat and the search results all
 * call this, so they cannot drift apart. */

/** "02:05 PM" in a 12-hour locale, "14:05" in a 24-hour one: the viewer's local time, as the room line has always drawn it. */
export function lineTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Today: the time. Another day this year: "Oct 2 02:05 PM". Another year: "Oct 2 2025". */
export function lineWhen(ts, now = new Date()) {
  const d = new Date(ts);
  if (d.toDateString() === now.toDateString()) {
    return lineTime(ts);
  }
  const md = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.getFullYear() === now.getFullYear() ? `${md} ${lineTime(ts)}` : `${md} ${d.getFullYear()}`;
}
