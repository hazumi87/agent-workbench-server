/* THE "/" COMMAND LIST (the design system [ref]; Owner [ref]): type "/" first in the message box and the room's commands appear,
 * narrowing as you type. PURE: no DOM, no engine; the page hands in the engine's own list (GET /api/rooms/commands), so
 * the rows never drift from what the engine accepts. The look and the keys are room.js and room.css.
 *
 *   rank(commands, typed)   what to show for the text in the box:
 *     {mode:'closed'}                         "/" is not the first character, or nothing to say
 *     {mode:'bare', groups:[{name, rows}]}    a lone "/": every command, by area (headers only when the engine sent groups)
 *     {mode:'list', rows}                     prefix matches of the usage, then a match in the name, then in the description
 *     {mode:'hint', row}                      a command is filled and no argument is typed yet: its usage stays in view until one starts
 *     {mode:'none', typed}                    "No command matches /xyz"
 *   fillOf(cmd)    the text Tab/Enter puts in: the words before the first placeholder, and a space
 *   split(cmd)     {head, args}: the usage's words and its dimmed arguments
 *   sendsAsTyped(cmd, typed)  Enter sends instead of filling: the box holds the command typed in full AND it needs no argument
 *   needsArg(cmd)  the usage has a required placeholder (so a bare command is filled, not sent)
 */

const GROUP_ORDER = ['Floor', 'Seats', 'Room'];

/** The commands a person can use: everything the engine lists except what is not in this build. */
export function usable(commands) {
  return (Array.isArray(commands) ? commands : []).filter((c) => c && typeof c.usage === 'string' && c.class !== 'not-in-build');
}

export function fillOf(cmd) {
  const u = cmd.usage;
  const at = u.search(/[@<[]/);
  return `${(at < 0 ? u : u.slice(0, at)).trimEnd()} `;
}

export function split(cmd) {
  const u = cmd.usage;
  const at = u.search(/[@<[]/);
  return at < 0 ? { head: u, args: '' } : { head: u.slice(0, at), args: u.slice(at) };
}

/** Whether the command still needs an argument the person has not typed: a placeholder that is not optional ([...]) and no
 *  alternative form of the usage that ends at the command's own words (/brief has one). */
export function needsArg(cmd) {
  const fill = fillOf(cmd).trim().toLowerCase();
  if (cmd.usage.split(' | ').some((alt) => alt.trim().toLowerCase() === fill)) {
    return false;
  }
  const { args } = split(cmd);
  return args !== '' && !args.startsWith('[');
}

/** Enter SENDS only a command that is typed in full and wants nothing more; one that still needs its argument is filled. */
export function sendsAsTyped(cmd, typed) {
  return typed.trim().toLowerCase() === fillOf(cmd).trim().toLowerCase() && !needsArg(cmd);
}

/** [start, end) of the typed text inside the usage when it is a prefix, else the name match, else null. */
export function boldRange(cmd, typed) {
  const u = cmd.usage.toLowerCase();
  const q = typed.toLowerCase();
  if (u.startsWith(q)) {
    return [0, q.length];
  }
  const body = q.slice(1);
  const i = body ? u.indexOf(body, 1) : -1;
  return i < 0 ? null : [i, i + body.length];
}

export function rank(commands, typed) {
  if (typeof typed !== 'string' || typed[0] !== '/' || typed.includes('\n')) {
    return { mode: 'closed' };
  }
  const cmds = usable(commands);
  if (!cmds.length) {
    return { mode: 'closed' };
  }
  const q = typed.toLowerCase();
  if (q === '/') {
    const hasGroups = cmds.some((c) => typeof c.group === 'string' && c.group);
    if (!hasGroups) {
      return { mode: 'bare', groups: [{ name: null, rows: cmds }] };
    }
    const names = [...new Set([...GROUP_ORDER, ...cmds.map((c) => c.group || 'Room')])];
    const groups = names.map((name) => ({ name, rows: cmds.filter((c) => (c.group || 'Room') === name) })).filter((g) => g.rows.length);
    return { mode: 'bare', groups };
  }
  const prefix = cmds.filter((c) => c.usage.toLowerCase().startsWith(q));
  if (!q.includes(' ')) {
    const body = q.slice(1);
    const rest = cmds.filter((c) => !prefix.includes(c));
    const inName = rest.filter((c) => fillOf(c).toLowerCase().includes(body)); // the command's own words, e.g. '/seat restart '
    const wordStart = new RegExp(`(^|[^a-z0-9])${body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    const inDesc = rest.filter((c) => !inName.includes(c) && wordStart.test(String(c.does || '').toLowerCase())); // a word that STARTS with it, so "/se" is not every description with "use" in it
    const rows = [...prefix, ...inName, ...inDesc];
    return rows.length ? { mode: 'list', rows } : { mode: 'none', typed };
  }
  if (prefix.length) {
    return { mode: 'list', rows: prefix };
  }
  /* the command's words are filled and nothing else yet: its usage stays in view until the argument starts (the design system [ref]) */
  const filled = cmds.filter((c) => q === fillOf(c).toLowerCase());
  return filled.length ? { mode: 'hint', row: filled[0] } : { mode: 'closed' };
}

/** The rows in the order they are shown, whatever the mode (for keyboard movement). */
export function flat(result) {
  if (result.mode === 'bare') {
    return result.groups.flatMap((g) => g.rows);
  }
  if (result.mode === 'list') {
    return result.rows;
  }
  return result.mode === 'hint' ? [result.row] : [];
}
