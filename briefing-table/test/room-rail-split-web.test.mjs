/**
 * THE RAIL SPLIT [rail split] Owner 2026-10-05 (the design system [ref]): the rail's one
 * Seats cell became a ROOM cell (the room row + the workgroup tree) and a SEATS
 * cell (only the selected room's seats). A source test over the shipped
 * room.html / room.js / room-add-sheet.mjs / room-add-move.mjs / CSS, plus the
 * pure rules in room-workgroups.mjs. The pictures are the harness's job.
 * Run with node.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const read = (f) => readFileSync(join(root, f), 'utf8').replace(/\r\n/g, '\n');
const wg = await import('../web/room-workgroups.mjs');

let passed = 0;
let failed = 0;
const ok = (c, m, x) => {
  if (c) { passed++; console.log(`  + ${m}`); } else { failed++; console.log(`  X ${m}${x === undefined ? '' : ` (${JSON.stringify(x)})`}`); }
};
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m, a);

const html = read('room.html');
const js = read('room.js');
const css = read('room.css');
const sheet = read('room-add-sheet.mjs');
const move = read('room-add-move.mjs');
const cells = read('room-cells.mjs');

console.log('[the two bars]');
const iRoom = html.indexOf('data-cell="room"');
const iSeats = html.indexOf('data-cell="seats"');
ok(iRoom > 0 && iSeats > iRoom, 'the Room cell is first in the rail, the Seats cell under it');
const roomCell = html.slice(iRoom, iSeats);
const seatsCell = html.slice(iSeats, html.indexOf('<div id="panelCells">'));
ok(/<span class="tt">Room<\/span>/.test(roomCell), 'the Room bar reads "Room"');
ok(/class="chev"/.test(roomCell) && /class="cell-h"/.test(roomCell), 'the Room bar has the collapse chevron like the other cells');
ok(/id="roomList"/.test(roomCell) && !/id="roster"/.test(roomCell), 'the Room cell holds the room + workgroup list');
ok(/id="seatsTt"/.test(seatsCell) && /id="seatCount"/.test(seatsCell) && /id="reconnectBtn"/.test(seatsCell) && /id="addBtn"/.test(seatsCell), 'the Seats bar keeps the title, the count, Reconnect and its +');
ok(/id="roster"/.test(seatsCell) && !/id="roomList"/.test(seatsCell), 'the Seats cell holds only the seats list');
ok(/id="roomAddBtn"/.test(roomCell) && !/id="roomAddBtn"/.test(seatsCell), 'the Room bar has its own +');
ok(/\.cell\[data-cell="seats"\], \.cell\[data-cell="room"\] \{ --cell-c: var\(--room-c\)/.test(css), 'both bars always wear the room color');
ok(cells.includes("wire(roomCell, 'room')") && cells.includes("id !== 'seats' && id !== 'room' && matchMedia"), 'Room folds like the other cells, and (like Seats) starts open on a phone');

console.log('\n[the Room chat row, one name per level]');
eq(wg.roomChatMeta(0, 3), '3 new in workgroups', 'main room, news in workgroups: "3 new in workgroups"');
eq(wg.roomChatMeta(2, 3), '3 new in workgroups', '...the badge carries the chat\'s own 2, so the words say the workgroups\'');
eq(wg.roomChatMeta(2, 0), '2 new', 'nothing new in workgroups: "2 new"');
eq(wg.roomChatMeta(0, 0), 'main room', 'nothing new at all: "main room"');
eq(wg.mainRoomMeta(0), 'main room', 'in a workgroup, the same row: "main room"');
eq(wg.mainRoomMeta(3), 'main room · 3 new', '...or "main room · 3 new"');

console.log('\n[the Seats title]');
eq(wg.seatsTitle({ name: 'Briefing Table', parent_id: null }), { prefix: 'Seats', name: 'Briefing Table', plate: false }, 'a main room: "Seats - <room name>", no plate');
eq(wg.seatsTitle({ name: 'Panels', parent_id: 'm1' }), { prefix: 'Seats', name: 'Panels', plate: true }, 'a workgroup: "Seats - Panels" with the plate');
const pt = js.slice(js.indexOf('function paintSeatsTitle()'), js.indexOf('const railKeys'));
ok(pt.includes("tt.textContent = 'Seats'") && !pt.includes('sub-plate'), 'the bar is just "Seats" (no "· room name", no plate: one name per level, Auriga 1.P); the name stays in the tooltip');
const rr = js.slice(js.indexOf('function renderRoster()'), js.indexOf('/* ------------------------------------------------------- the right column'));
ok(rr.includes('renderFamilyTree(rlist)') && js.includes('function renderFamilyTree(list)'), 'the Room cell draws one family tree (same in every family room) [rail split]');
const ft = js.slice(js.indexOf('function renderFamilyTree('), js.indexOf('/** A push carries no person'));
ok(ft.includes("navRow(list, state.family.parent, 'head')") && ft.includes('renderRoomRow(list)') && ft.includes("navRow(list, w, 'sub', w.id === roomId)") && !ft.includes('w.id !== roomId'), 'main room on top, ALL workgroups under it, the room you are in drawn selected');
ok(!/is-up/.test(read('room-workgroups.css')) && !js.includes('renderUpRow'), 'the in-workgroup up-row layout is gone');
ok(/renderSeatRow\(list, seat, lead\)/.test(rr) && !/renderSubRows\(list\)|renderUpRow\(list\)/.test(rr), 'the Seats cell draws only seats (Basic alone puts the room row in it: no Room cell there) [basic]');
ok(rr.includes('paintSeatsTitle()'), 'every redraw keeps the title current');

console.log('\n[the + sheets]');
eq(wg.addSheetTabs('room', true), [['workgroups', 'Workgroup'], ['apps', 'App']], 'Room +: Workgroup and App tabs');
eq(wg.addSheetTabs('room', false), [['apps', 'App']], 'Room + in a workgroup: no Workgroup tab (a workgroup holds none), App only');
eq(wg.addSheetTabs('seats', true), [['agents', 'Add'], ['move', 'Move']], 'Seats +: Add | Move');
eq(wg.addSheetTabs(undefined, true), null, 'the manager keeps its own three tabs');
ok(sheet.includes('addSheetTabs(o.scope, !!wgTab)'), 'the sheet takes its tabs from addSheetTabs');
ok(!/\['agents', 'Agents'.*\]\s*:\s*\[\['agents'/.test(sheet) && sheet.includes("[['agents', 'Agents', count()]"), 'the manager list is the unscoped fallback');
ok(sheet.includes("ad.append('Adding to ')") && sheet.includes("if (o.scope === 'seats' && targetRoom())"), 'the Add tab says "Adding to <name>" at the top');
ok(sheet.includes("' and its workgroups'") && sheet.includes("o.scope === 'room' && targetRoom()"), 'the Room +\'s App tab says "Adding to <main room> and its workgroups"');
ok(js.includes("room: head,") && /scope === 'room' && state\.room\.parent_id && state\.family\?\.parent/.test(js), 'apps always add to the family head (the main room) whichever row is selected');
ok(js.includes("$('addBtn').addEventListener('click', () => addMembers('seats'))") && js.includes("$('roomAddBtn').addEventListener('click', () => addMembers('room'))"), 'each + opens its own scope');
ok(js.includes("addMembers('room', 'workgroups')"), 'the room row\'s ... "Add new workgroup" opens the Room sheet on Workgroup');

console.log('\n[Move]');
ok(move.includes("/api/rooms/${encodeURIComponent(p.from)}/seats/${encodeURIComponent(p.seat)}/move") && move.includes('{ to_room: c.room().id }'), 'Move uses the existing seat-move route, from the source room, to HERE');
ok(move.includes('Same name, same session.'), 'the "same name, same session" note');
ok(move.includes('lead: hand the lead over first') && /aria-disabled/.test(move), 'a room\'s lead is listed but not movable');
ok(/ras-err'?, m\.error|m\.error = `Not moved/.test(move) && !/menuToast|alert\(/.test(move), 'a refusal is shown inline');
eq(wg.moveSources({ id: 'w1', parent_id: 'm' }, { parent: { id: 'm', name: 'Main', alias: null }, workgroups: [{ id: 'w1', name: 'A', state: 'open' }, { id: 'w2', name: 'B', alias: 'b', state: 'open' }, { id: 'w3', name: 'C', state: 'archived' }] }).map((r) => r.id), ['m', 'w2'], 'in a workgroup: the main room and the open siblings (not itself, not archived)');
eq(wg.moveSources({ id: 'm' }, { parent: null, workgroups: [{ id: 'w1', name: 'A', state: 'open' }] }).map((r) => r.id), ['w1'], 'in a main room: its open workgroups');
ok(read('room-seat-menu.mjs').includes("label: 'Move to workgroup…'") || read('room-seat-menu.mjs').includes('Move to workgroup'), 'the seat menu keeps "Move to workgroup..."');

console.log('\n[phone sheet]');
const fs = js.slice(js.indexOf('function fillSheet('), js.indexOf('function openSheet('));
ok(fs.includes("section('Rooms')") && fs.includes('renderFamilyTree(rooms)'), 'Rooms on top, with the rows and badges');
ok(fs.includes("section(split ? 'Seats' : 'Agents')") && fs.indexOf("section('Rooms')") < fs.indexOf("section(split ? 'Seats'"), '"Seats" below Rooms (no "· name")');
ok(fs.includes("$('roomAddBtn').click()") && fs.includes("$('addBtn').click()"), 'each section has the same + behavior as the rail');
ok(!fs.includes("'sub-plate sm'"), 'a workgroup\'s Seats heading carries no plate');
ok(!fs.includes("'Rooms and seats'") || fs.includes("agents: 'Rooms and seats'"), '"Rooms and seats" is only the menu sheet\'s accessible name');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
