/**
 * The "/" command list's rules (web/slash-list.mjs; the design system [ref]). Pure; the same shape the engine serves at
 * GET /api/rooms/commands, so the rows cannot drift from what the engine accepts.
 */
import { rank, fillOf, split, sendsAsTyped, needsArg, boldRange, usable, flat } from '../web/slash-list.mjs';

let passed = 0;
let failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  FAIL ${m}`); } };
const C = (word, usage, does, group, cls = 'executed') => ({ word, verb: word, usage, does, group, class: cls });
const cmds = [
  C('floor', '/floor take', 'End every turn held in this room', 'Floor'),
  C('floor', '/floor skip @<handle>', "Skip a seat's turn", 'Floor'),
  C('set', '/set turn <minutes|default>', "Set a seat's turn time in this room", 'Floor'),
  C('seat', '/seat restart @<handle>', 'Restart a seat that is not live', 'Seats'),
  C('seat', '/seat restart all', 'Restart every seat that is not live', 'Seats'),
  C('seat', '/seat restart stop', 'Stop a running restart', 'Seats'),
  C('set', '/set lead @<handle>', 'Hand the lead over', 'Seats'),
  C('rename', '/rename room <name>', 'Name the room', 'Room'),
  C('remove', '/remove @<handle> [confirm]', 'Give up the seat', 'Seats'),
  C('help', '/help', 'List these commands', 'Room'),
  C('archive', '/archive [confirm]', 'Put the room in stasis', 'Room'),
  C('brief', '/brief <markdown> | /brief clear | /brief', "Set, clear or show the room's brief", 'Room'),
  C('seam', '/seam', 'Open the seam definition', 'Room', 'not-in-build'),
];
const usages = (r) => flat(r).map((c) => c.usage);

console.log('\n[opens only on a leading "/"]');
ok(rank(cmds, 'hello').mode === 'closed' && rank(cmds, ' /seat').mode === 'closed' && rank(cmds, '').mode === 'closed', 'not first: closed');
ok(rank(cmds, '/a\nb').mode === 'closed', 'a second line: closed');
ok(rank([], '/').mode === 'closed' && rank(null, '/s').mode === 'closed', 'no commands (an older engine): closed, never throws');

console.log('\n[a bare "/" shows every usable command by area]');
const bare = rank(cmds, '/');
ok(bare.mode === 'bare' && bare.groups.map((g) => g.name).join() === 'Floor,Seats,Room', 'groups in the order Floor, Seats, Room');
ok(flat(bare).length === 12 && !usages(bare).includes('/seam'), 'ten commands; the not-in-build one is left out');
ok(rank(cmds.map(({ group, ...c }) => c), '/').groups.length === 1 && rank(cmds.map(({ group, ...c }) => c), '/').groups[0].name === null, 'no group field (older engine): one list, no headers');

console.log('\n[narrowing]');
const se = usages(rank(cmds, '/se'));
ok(se.includes('/seat restart @<handle>') && se.includes('/set lead @<handle>') && !se.includes('/seam') && !se.includes('/floor take'), '"/se" shows the /seat and /set commands, not /floor');
ok(usages(rank(cmds, '/floor')).join() === '/floor take,/floor skip @<handle>', '"/floor" shows take and skip');
ok(usages(rank(cmds, '/seat re')).join() === '/seat restart @<handle>,/seat restart all,/seat restart stop', 'two words still narrow, by prefix of the usage');
ok(usages(rank(cmds, '/SEAT RESTART A')).join() === '/seat restart all', 'case does not matter');
const inName = usages(rank(cmds, '/turn'));
ok(inName[0] === '/set turn <minutes|default>' && inName.slice(1).every((u) => u.startsWith('/floor')), 'a match INSIDE the name comes first ("/turn" finds /set turn), then description matches (the two /floor lines that say "turn")');
const order = usages(rank(cmds, '/re'));
ok(order.indexOf('/rename room <name>') < order.indexOf('/seat restart @<handle>') && order.indexOf('/remove @<handle> [confirm]') < order.indexOf('/seat restart @<handle>'), 'prefix matches (/rename, /remove) come before matches inside a name (/seat restart)');
ok(usages(rank(cmds, '/skip')).join() === '/floor skip @<handle>', 'a match inside the second word of the name finds /floor skip');
ok(usages(rank(cmds, '/lead')).join() === '/set lead @<handle>', 'a match in the name of a second word');
ok(usages(rank(cmds, '/ver')).length === 0 && rank(cmds, '/ver').mode === 'none', 'a description match must START a word: "/ver" does not match "Hand the lead OVER" or "...every..."');
const desc = rank(cmds, '/give');
ok(usages(desc).join() === '/remove @<handle> [confirm]', 'the description is searched last ("/give" finds /remove, "Give up the seat")');

console.log('\n[filled: the usage stays until the argument starts]');
ok(flat(rank(cmds, '/set turn ')).length === 1 && flat(rank(cmds, '/set turn '))[0].usage === '/set turn <minutes|default>', 'just filled "/set turn ": its one row (the format) stays in view');
ok(rank(cmds, '/floor take ').mode === 'hint', 'a command with no argument, followed by a space: its usage stays');
ok(rank(cmds, '/seat restart @wo').mode === 'closed' && rank(cmds, '/set turn 5').mode === 'closed', 'the argument has started: the usage row closes (the @handle list takes over for a name)');
ok(rank(cmds, '/seat restart ').mode === 'list' && flat(rank(cmds, '/seat restart ')).length === 3, 'just after "/seat restart ", the three forms stay as a list');
ok(rank(cmds, '/zzz foo').mode === 'closed', 'words that match nothing, with a space: closed (the line is sent as typed)');

console.log('\n[nothing matches]');
const none = rank(cmds, '/xyz');
ok(none.mode === 'none' && none.typed === '/xyz', 'one "No command matches /xyz" state');

console.log('\n[fill, split, bold, Enter]');
ok(fillOf(cmds[3]) === '/seat restart ' && fillOf(cmds[0]) === '/floor take ' && fillOf(cmds[2]) === '/set turn ' && fillOf(cmds[8]) === '/remove ' && fillOf(cmds[9]) === '/help ', 'fillOf: the words before the first placeholder, plus a space');
const sp = split(cmds[3]);
ok(sp.head === '/seat restart ' && sp.args === '@<handle>', 'split: the words and the dimmed arguments');
ok(split(cmds[0]).args === '' && split(cmds[0]).head === '/floor take', 'a command with no arguments has none dimmed');
ok(sendsAsTyped(cmds[0], '/floor take') && sendsAsTyped(cmds[0], '/floor take ') && !sendsAsTyped(cmds[0], '/flo'), 'Enter sends when the box already holds exactly the command');
ok(!sendsAsTyped(cmds[3], '/seat'), 'but not on a partial one: it fills');
ok(!sendsAsTyped(cmds[3], '/seat restart') && !sendsAsTyped(cmds[3], '/seat restart '), 'a bare command that still NEEDS its argument is filled, never sent');
ok(!sendsAsTyped(cmds[2], '/set turn') && !sendsAsTyped(cmds[8], '/remove'), 'same for /set turn and /remove (required argument)');
const byWord = (u) => cmds.find((c) => c.usage === u);
ok(sendsAsTyped(byWord('/help'), '/help') && sendsAsTyped(byWord('/archive [confirm]'), '/archive'), 'bare /help and /archive (optional argument) still send');
ok(sendsAsTyped(byWord('/brief <markdown> | /brief clear | /brief'), '/brief'), 'bare /brief still sends (it has a form without an argument)');
ok(needsArg(byWord('/seat restart all')) === false && needsArg(byWord('/floor skip @<handle>')) === true, 'needsArg: "/seat restart all" is complete; "/floor skip @<handle>" is not');
ok(JSON.stringify(boldRange(cmds[3], '/seat re')) === '[0,8]' && JSON.stringify(boldRange(cmds[2], '/turn')) === '[5,9]' && boldRange(cmds[3], '/give') === null, 'boldRange: the typed prefix, else the matched part of the name, else none');
ok(usable([{ usage: '/a', class: 'bind-only' }, { usage: '/b', class: 'not-in-build' }, null, {}]).length === 1, 'usable: bind-only is kept, not-in-build and junk dropped');
console.log(`PASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
