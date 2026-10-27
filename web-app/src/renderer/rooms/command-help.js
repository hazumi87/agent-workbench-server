// Formats come from the engine; this module contains no command catalog.
export function commandRows(commands) {
  if (!Array.isArray(commands)) return [];
  return commands.filter(c => c && ['executed', 'bind-only'].includes(c.class) &&
    typeof c.usage === 'string' && /^\/[a-z][a-z0-9_-]*(?:\s|$)/i.test(c.usage) && !/[\r\n]/.test(c.usage))
    .map(c => {
      // Never insert placeholders, optional confirmations or usage alternatives.
      const argumentAt = c.usage.search(/@?<|\[|\|/);
      const name = (argumentAt < 0 ? c.usage : c.usage.slice(0, argumentAt)).trimEnd();
      // Alternatives are separated by "| /command", not the pipes inside <a|b>.
      const sendsBare = c.usage.split(/\s+\|\s+(?=\/)/).some(usage =>
        usage.replace(/\[[^\]]*\]/g, '').trim().toLowerCase() === name.toLowerCase());
      return { kind: 'slash', name, fill: name + ' ', text: c.usage,
        sub: typeof c.does === 'string' ? c.does : '', group: ['Floor', 'Seats', 'Room'].includes(c.group) ? c.group : '', argumentAt, sendsBare };
    });
}

export function commandQuery(value, start, end = start) {
  return value.startsWith('/') && !/[\r\n]/.test(value) && start === value.length && start === end ? value.slice(1) : null;
}

export function matchCommands(rows, query) {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const wordStart = new RegExp('(^|[^a-z0-9])' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const matches = rows.map((row, index) => {
    const name = row.name.slice(1).toLowerCase();
    const rank = name.startsWith(q) ? 0 : q.includes(' ') ? -1 : name.includes(q) ? 1 : wordStart.test(row.sub.toLowerCase()) ? 2 : -1;
    return { row, rank, index };
  }).filter(m => m.rank >= 0).sort((a, b) => a.rank - b.rank || a.index - b.index).map(m => m.row);
  if (!q && rows.every(r => r.group)) {
    return ['Floor', 'Seats', 'Room'].flatMap(group => matches.filter(r => r.group === group));
  }
  return matches;
}

export function argumentStarted(rows, value) {
  return rows.some(row => row.argumentAt >= 0 && value.toLowerCase().startsWith(row.fill.toLowerCase()) &&
    value.slice(row.fill.length).trim().length > 0);
}

export function usageCommand(rows, value) {
  return rows.filter(row => row.argumentAt >= 0 && value.toLowerCase().startsWith(row.fill.toLowerCase()))
    .sort((a, b) => b.fill.length - a.fill.length)[0] || null;
}

export function hasFollowingArguments(row, value) {
  // The first usage alternative describes the fill path; optional operands also
  // deserve a hint. Pipes within a placeholder are not alternative commands.
  const format = row.text.split(/\s+\|\s+(?=\/)/)[0].replace(/[\[\]]/g, '').trim();
  return format.split(/\s+/).length > value.trim().split(/\s+/).length;
}
