/** Independent proof whitelist for the final full-UUID/exclusive-cursor ring.
 * No product imports: only canonical room/since JSON and fixed words pass. */
export function proofRingRecords(text) {
  const tail = ' - if replying, use room_post in that room]';
  if (typeof text !== 'string' || !text.startsWith('[') || !text.endsWith(tail)) return null;
  const parts = text.slice(1, -tail.length).split(' | ');
  if (!parts.length || parts.length > 4) return null;
  const records = [], rooms = new Set();
  for (const part of parts) {
    const m = /^room_read (\{[^\r\n]*\}) - (new line|(\d+) new lines, latest) #([1-9]\d*)$/.exec(part);
    if (!m) return null;
    let args; try { args = JSON.parse(m[1]); } catch { return null; }
    if (!args || Object.keys(args).join(',') !== 'room,since' || JSON.stringify(args) !== m[1]) return null;
    if (typeof args.room !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.room)) return null;
    const latest = Number(m[4]), count = m[2] === 'new line' ? 1 : Number(m[3]);
    if (!Number.isSafeInteger(args.since) || args.since < 0 || !Number.isSafeInteger(latest) || latest <= args.since || !Number.isSafeInteger(count) || count < 1 || (m[3] && count < 2)) return null;
    if (count === 1 ? args.since !== latest - 1 : count > latest - args.since) return null;
    if (rooms.has(args.room)) return null;
    rooms.add(args.room); records.push({ room: args.room, since: args.since, latest, count });
  }
  return records;
}
export function isProofRing(text, expected = {}) {
  const rows = proofRingRecords(text);
  return !!rows && rows.every(row => !expected.room || row.room === expected.room) &&
    (expected.latest === undefined || rows.some(row => row.latest === expected.latest)) &&
    (expected.since === undefined || rows.some(row => row.since === expected.since));
}
