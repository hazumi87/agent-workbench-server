/**
 * WORKGROUPS, the page half (Owner 2026-10-04, KB design-notes-id §10-§11): the
 * pure rules in web/room-workgroups.mjs, and the SHIPPED room.js / CSS / list
 * sources sliced for the wiring (a source test, no browser: the screenshots are
 * the harness's job).
 *   - a cross-post reads OUTGOING-ONLY / mixed / INCOMING from the engine's xpost;
 *   - the notice raises on a rise since the last look, never on the first look,
 *     never for the room on screen;
 *   - the notice is ONE class, absolutely positioned under the title bar (a toast
 *     over the line, never in the flow), 440px on a PC, full width on a phone;
 *   - addEntries admits an incoming line; the rail draws the family rows; the
 *     crumb, the placeholder and the cursor are wired; the CLI Manager list and
 *     the phone places sheet nest workgroups under their main room.
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
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  + ${msg}`);
  } else {
    failed++;
    console.log(`  X ${msg}`);
  }
}
const eq = (a, b, msg) => ok(Object.is(a, b), `${msg} (got ${JSON.stringify(a)})`);
const same = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);

console.log('\n[cross-post wording]');
const out = {
  origin_room: 'wg1', origin_name: 'Tool dev', direction: 'out', local: 0,
  targets: [
    { room: 'm', room_name: 'Alpha-Platform Apps', alias: 'apps', handle: 'alpha-platform' },
    { room: 'wg2', room_name: 'Tool operators', alias: null, handle: 'claude-asset-worker' },
  ],
};
same(wg.outgoingTargets(out), ['apps/@alpha-platform', 'Tool operators/@claude-asset-worker'], 'outgoing targets: alias/@name, else the room name');
eq(wg.outgoingTag(out, 'Tool dev'), 'cross-post · not posted in Tool dev', 'the tag names the room it was NOT posted in');
eq(wg.isOutgoingOnly(out), true, 'nobody local = outgoing only (the dashed look)');
eq(wg.isOutgoingOnly({ ...out, local: 1 }), false, 'a local recipient = a normal line with the header');
eq(wg.isOutgoingOnly({ ...out, direction: 'in' }), false, 'an incoming line is not outgoing');
eq(wg.isOutgoingOnly(null), false, 'no xpost = an ordinary line');
eq(wg.incomingHandles({ direction: 'in', targets: [{ handle: 'a' }, { handle: 'b' }] }), '@a, @b', 'incoming: who it reached HERE');

console.log('\n[the notice: cross-family, Owner 2026-10-06]');
/* the engine's rows (GET /api/rooms/me/unread) as notice items */
const row = (id, name, unread, newestId, head = id) => ({ roomId: id, name, familyHeadId: head, unread, newestId: unread ? newestId : null, color: null });
const rooms = (...rs) => wg.noticeRooms(rs);
const A = (n, id = 100) => row('a', 'Panels', n, id);
const B = (n, id = 200) => row('b', 'Palette', n, id, 'x');
const C = (n, id = 300) => row('c', 'Tool dev', n, id, 'm');
same(wg.noticeRaise(null, rooms(A(3)), 'm'), [], 'the first look raises nothing (opening a page is not news)');
same(wg.noticeRaise(wg.unreadSnapshot(rooms(A(0))), rooms(A(0)), 'm'), [], 'no change, no notice');
same(wg.noticeRaise(wg.unreadSnapshot(rooms(A(0))), rooms(A(2)), 'm').map((n) => n.name), ['Panels'], 'a rise names the room (ANY family)');
same(wg.noticeRaise(wg.unreadSnapshot(rooms(A(2))), rooms(A(2)), 'm'), [], 'the same count again raises nothing');
same(wg.noticeRaise(wg.unreadSnapshot(rooms(A(2))), rooms(A(3)), 'm').map((n) => n.unread), [3], 'a further rise raises again');
same(wg.noticeRaise(wg.unreadSnapshot(rooms(A(0))), rooms(A(2)), 'a'), [], 'never for the room on screen');
same(wg.noticeRaise(wg.unreadSnapshot(rooms(A(0), B(0), C(0))), rooms(A(1, 110), B(1, 250), C(1, 150)), 'm').map((n) => n.name), ['Palette', 'Tool dev', 'Panels'], 'several rooms of several families, NEWEST line first');
same(wg.waitingRooms(rooms(A(2), B(0)), 'm').map((r) => r.name), ['Panels'], 'phone: waiting = rooms still holding unread');
same(wg.waitingRooms(rooms(A(0), B(0)), 'm'), [], '...nothing once the person has visited them (unread zero): it clears by itself');
same(wg.waitingRooms(rooms(A(2)), 'a'), [], '...never the room on screen');
same(wg.noticeRooms(null), [], 'no rows (the read failed): nothing, never a throw');
same(wg.familyNoticeRooms({ parent: { id: 'm', name: 'M', unread: 1, state: 'open' }, workgroups: [{ id: 'w', name: 'W', unread: 0, state: 'open' }, { id: 'z', name: 'Z', unread: 5, state: 'archived' }] }).map((r) => r.id), ['m', 'w'], 'the family fallback drops archived rooms');
const sum = (...rs) => wg.noticeSummary(wg.waitingRooms(rooms(...rs), 'm'));
eq(wg.waitingText(sum(A(1))), '1 new', 'phone, one room: count only ("1 new")');
eq(wg.waitingText(sum(A(3), B(2))), '5 new in 2 rooms', 'phone, several: "N new in M rooms"');
eq(wg.waitingText(sum(A(60), B(60))), '99+ new in 2 rooms', '...the count caps at 99+');
/* TEAMS ARE NOT ROOMS (Owner 2026-10-27, IMG_8081/8082: "3 new in 3 rooms" for a main room and two workgroups): a room of a family of
   more than one open room is a TEAM; a room that stands alone stays a room; a mix says both. The strip and the sheet read one text. */
const M2 = (n, id = 300) => row('m2', 'Northwind Team Workrooms', n, id, 'm2');
const T1 = (n, id = 310) => row('t1', 'Craftworks', n, id, 'm2');
const T2 = (n, id = 320) => row('t2', 'Planning', n, id, 'm2');
const ME = () => row('c1', 'Client', 0, null, 'm2'); // the team on screen: in the family, never counted as waiting
const S1 = (n, id = 330) => row('s1', 'Solo', n, id, 's1');
const sumT = (...rs) => wg.noticeSummary(wg.waitingRooms(rooms(ME(), ...rs), 'c1'));
same(rooms(ME(), M2(1), T1(1), S1(1)).map((r) => [r.id, r.team]), [['c1', true], ['m2', true], ['t1', true], ['s1', false]], 'a team = a room of a family of more than one open room; a room alone is not');
same(rooms(M2(1)).map((r) => r.team), [false], 'a main room whose workgroups are gone (or archived: the engine lists open rooms only) is a room again');
eq(wg.waitingText(sumT(M2(2), T1(1), T2(1))), '4 new in 3 teams', 'a main room and two workgroups: "4 new in 3 teams", not rooms');
eq(wg.chooseText(sumT(M2(2), T1(1), T2(1))), 'choose a team', '...the sheet says "choose a team"');
eq(wg.waitingLabel(sumT(M2(2), T1(1), T2(1))), 'Teams with new messages', '...and its accessible name says teams');
eq(wg.waitingText(sumT(M2(2), T1(1), T2(1), S1(2))), '6 new in 4 rooms and teams', 'a team mix with a room that stands alone: "rooms and teams"');
eq(wg.chooseText(sumT(M2(2), T1(1), S1(2))), 'choose a room or team', '...the sheet: "choose a room or team"');
eq(wg.waitingLabel(sumT(M2(2), T1(1), S1(2))), 'Rooms and teams with new messages', '...and its name');
eq(wg.waitingText(sumT(S1(2), row('s2', 'Other', 1, 340, 's2'))), '3 new in 2 rooms', 'rooms that stand alone still say rooms');
eq(wg.chooseText(sumT(S1(2), row('s2', 'Other', 1, 340, 's2'))), 'choose a room', '...and "choose a room"');
eq(wg.waitingText(sumT(T1(3))), '3 new', 'one place waiting: count only, whatever it is');
eq(wg.waitingText(sumT(M2(2), T1(1), T2(1))).match(/^(\S+) new/)[1], String(sumT(M2(2), T1(1), T2(1)).lines), 'the words count the lines of the rooms listed, nothing else');
same(wg.familyNoticeRooms({ parent: { id: 'm', name: 'M', unread: 1, state: 'open' }, workgroups: [{ id: 'w', name: 'W', unread: 2, state: 'open' }] }).map((r) => r.team), [true, true], 'the family fallback (no cross-family read): a main room with a workgroup is a team of teams');
same(wg.familyNoticeRooms({ parent: { id: 'm', name: 'M', unread: 1, state: 'open' }, workgroups: [{ id: 'w', name: 'W', unread: 2, state: 'archived' }] }).map((r) => r.team), [false], '...an archived workgroup does not make the main room a team');
{
  /* THE STRIP AND THE SHEET AGREE: both are `waitingText(sum)` over the same items, so they can never print different counts */
  const roomJs = readFileSync(join(root, 'room.js'), 'utf8');
  ok(roomJs.includes('const text = waitingText(sum);') && roomJs.includes('tx.textContent = text;'), 'the phone strip prints waitingText(sum)');
  ok(roomJs.includes('title: waitingText(sum),') && roomJs.includes('sub: chooseText(sum),') && roomJs.includes('label: waitingLabel(sum),'), 'the sheet title is that same waitingText(sum); its sub-line and name use the same words');
  ok(!roomJs.includes("sub: 'choose a room'") && !roomJs.includes("label: 'Rooms with new messages'"), 'no hard-coded "room" wording is left on the sheet');
  ok(read('room-places.mjs').includes("isTeam(room) ? 'Team' : 'Room'") && !read('room-places.mjs').includes('label: `Room ${room.name}`'), 'the Workbench sheet names a team "Team X", a room that stands alone "Room X"');
}
eq(sum(A(3, 110), B(2, 250)).newest.name, 'Palette', 'View goes to the room with the newest counted line');
eq(sum(A(3, 110), B(2, 250)).key, 250, 'the dismissal key is that newest line id');
ok(wg.stripHidden(sum(A(3, 110)), 110) && wg.stripHidden(sum(A(3, 110)), 200), 'the X hides the strip until a NEWER line than the dismissed one');
ok(!wg.stripHidden(sum(A(3, 110), B(1, 250)), 110) && !wg.stripHidden(sum(A(3)), null), '...a newer line (or no dismissal) shows it');
const tn = wg.toastNames(wg.noticeRaise(wg.unreadSnapshot(rooms(A(0), B(0), C(0))), rooms(A(1, 110), B(1, 250), C(1, 150)), 'm'));
same([tn.names.map((n) => n.name), tn.more], [['Palette', 'Tool dev'], 1], 'PC toast: at most 2 names (newest first), then "+N more"');
same([wg.toastNames([{ name: 'a' }]).names.length, wg.toastNames([{ name: 'a' }]).more], [1, 0], '...one name, no "more"');

console.log('\n[composer + links]');
eq(wg.placeholderFor({ parent_id: null, name: 'Main' }, 'alpha-platform'), 'Message @alpha-platform, @handle a seat, or /help', 'a main room names its lead');
eq(wg.placeholderFor({ parent_id: 'm', name: 'Tool dev' }, 'dev'), 'Message @dev (Tool dev lead), @lead for the main room, or /help', 'a workgroup names its lead and where @lead goes');
eq(wg.placeholderFor({ parent_id: null, name: 'Main' }, null), null, 'no lead: the page keeps its own words');
ok(wg.placeholderFor({ parent_id: null, name: 'M' }, 'x').endsWith(', or /help'), 'the tail stays ", or /help" (the Tab hint rewrites it)');
eq(wg.roomHref('http://h/room.html?room=a&x=1#line-4', 'b'), '/room.html?room=b&x=1', 'the same page, another room, other params kept, no hash');

console.log('\n[room.js wiring]');
const js = read('room.js');
ok(js.includes("e.xpost?.direction !== 'in'"), 'addEntries admits a line cross-posted INTO this room');
ok(js.includes("li.classList.add('xpost')") && js.includes("li.classList.add('xin')"), 'entryNode marks outgoing-only and incoming lines');
ok(js.includes('outgoingTag(xp') && js.includes("from.append('from '"), 'the outgoing tag and the incoming "from <room>" header are drawn');
ok(js.includes('renderFamilyTree(rlist)'), 'the Room cell draws the main room with its workgroups under it [rail split]');
ok(js.includes('goToRoom(r.id)') && js.includes('location.href = roomHref(location.href, id)'), 'a family row navigates the same tab (through goToRoom, which remembers the open app first)');
ok(js.includes('paintCrumb(room)') && js.includes("head.textContent = sub || isBasic() ? room.name : 'Main room'") && js.includes("room.parent_id ? ['workgroup', who, nSeats] : [nSeats, who]"), 'the room bar says where you are: "Main room · N seats · lead @x" / "<workgroup> @alias · workgroup · lead @x · N seats" (the tab names the project; Basic says the site\'s name) [layers]');
ok(js.includes("method: 'PUT', json: { last_seen_line_id: id }"), 'the person cursor is sent');
ok(js.includes('catch(() => {})') && js.includes('.then((r) => {'), 'the cursor send catches its own failures');
ok(/seenSent/.test(js) && js.includes("state.sel !== 'room'"), 'the cursor moves only while the room line is on screen');
ok(js.includes('state.family = r.body.family ?? null; // before applyRoom'), 'the family is read before the roster paints');
ok(js.includes('keepUnread(m.family)'), 'a push (which names no person) keeps the last unread');
ok(js.includes('basePlaceholder') && js.includes('paintPlaceholder(room)'), 'the composer names who plain typing reaches');
const notice = js.slice(js.indexOf('function raiseNotices()'), js.indexOf("/* THE PERSON'S CURSOR"));
ok(js.includes("toast as roomToast } from '/room-toast.mjs'") && notice.includes('roomToast(text'), 'PC: the room\'s one toast module shows it (no second toast)');
ok(notice.includes('raised.length && !isPhone()') && notice.includes("label: 'View', run: (btn) => viewWaiting(btn)") && notice.includes("text.append('New in ')") && notice.includes('+${more} more'), 'PC only: "New in [plate] A, B +N more" with View (newest first, at most 2 names)');
ok(js.includes("plate.className = 'sub-plate sm'") && notice.includes('text.append(wgName(r))'), 'the small plate before a name (the PC toast)');
ok(notice.includes('tx.textContent = text') && notice.includes('view.addEventListener(\'click\', () => viewWaiting(view))') && notice.includes("'Hide until a newer message arrives'"), 'phone strip: count only ("3 new in 2 rooms"), View opens the rooms menu (one room: straight there), the X says what it does');
const vwFn = js.slice(js.indexOf('function viewWaiting(anchor)'), js.indexOf('function raiseNotices()'));
ok(vwFn.includes('items.length === 1 && !isPhone()') && vwFn.includes('goToRoom(items[0].id)') && vwFn.includes('roomMenu.open({') && vwFn.includes("sub: r.unread > 99 ? '99+' : String(r.unread)") && vwFn.includes("classList.add('nm-badge')") && vwFn.includes('wgPlate(r)'), '[notice menu] View with several rooms opens the seat menu surface: a row per room (plate, name, badge, newest first); one room goes straight there');
ok(notice.includes("host.insertBefore(el, $('compose'))"), 'phone strip sits above the message box');
ok(notice.includes("el.className = 'wg-notice'") && notice.includes('isPhone() ? waitingRooms(noticeList(), roomId)') && js.includes('async function fetchUnreadAll'), 'phone: ONE persistent class, derived from EVERY open room\'s unread (clears itself)');
ok(notice.includes('state.noticeDismissedKey = sum.key') && notice.includes('stripHidden(sum, state.noticeDismissedKey)'), 'its close hides it until a NEWER line arrives');
ok(!/ol\.append|\$\('line'\)/.test(notice), 'appended to the line column, not the message list (never a chat line)');
ok(!/deliver|api\(|fetch\(/.test(notice), 'the notice delivers nothing to anyone');
const seatMenu = read('room-seat-menu.mjs');
ok(seatMenu.includes("import { toast } from '/room-toast.mjs'") && /export function menuToast[\s\S]{0,200}return toast\(/.test(seatMenu), 'menuToast is a thin wrapper over the one toast');
ok(js.includes("typeof r.seats === 'number'") && read('room-workgroups.mjs').includes('new in workgroups') && !js.includes('\\u2196'), 'rail: \"lead @x . N seats\", the room row says \"N new in workgroups\", no arrow on the up row');

console.log('\n[css]');
const css = read('room-workgroups.css');
let depth = 0;
let bad = false;
for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
  depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
  if (depth < 0) bad = true;
}
ok(depth === 0 && !bad, 'braces balance');
ok(/\.wg-notice\s*\{[^}]*position:\s*relative/.test(css) && /color-mix\(in srgb, var\(--sky\) 9%, var\(--surface\)\)/.test(css) && /\.wg-notice \.vw\s*\{[^}]*color:\s*var\(--sky\)/.test(css), 'phone strip: in the flow above the box, sky 9% ground, View in sky');
ok(/\.sub-plate\.sm\s*\{[^}]*width:\s*14px[^}]*border-radius:\s*4px/.test(css) && /\.sub-plate\.sm::after\s*\{[^}]*inset:\s*3px 2px 2px/.test(css), 'the small plate: 14px, radius 4, inset 3/2/2');
ok(/\.seat\.has-subs::after\s*\{[^}]*border-left:\s*1\.5px solid var\(--dim2\)/.test(css), 'ONE continuous tree line from under the room glyph');
ok(/\.seat\.is-sub \.seat-count\s*\{[^}]*background:\s*var\(--sa\)/.test(css) && /--sa:\s*oklch\(from var\(--sc\) \.80 clamp\(\.05, calc\(c \* \.75\), \.14\) h\)/.test(css), 'the badge wears acc(c), not the raw color');
ok(/\.rm-line\s*\{\s*position:\s*relative/.test(css), 'the line column is the notice\'s containing block');
ok(/\.entry\.xpost \.entry-bubble[^}]*dashed/.test(css), 'an outgoing cross-post is dashed');
ok(read('room.html').includes('/room-workgroups.css'), 'room.html loads the sheet');

console.log('\n[lists]');
const mgr = read('manager-rooms.mjs');
ok(mgr.includes("room.parent_id ? ' is-wg' : ''") && mgr.includes('drawn under its main room'), 'the Workbench nests workgroups under their main room');
ok(mgr.includes('v.room.parent_id, v.room.alias, v.room.color, v.room.art_tile?.id ?? null, v.last?.ts ?? null, v.last?.text ?? null, v.unread'), '...and re-draws when parent, alias, colour, art, last line or unread change');
const places = read('room-places.mjs');
ok(places.includes('rest.filter((w) => w.room.parent_id === v.room.id)'), 'the phone places sheet puts each workgroup right under its main room');
ok(places.includes("section('Workgroups of this room')") && places.includes('listed.filter((v) => v.room.parent_id === o.roomId)'), "the room you are in has its own workgroups led under a 'Workgroups of this room' heading, not floating under another room (Owner [ref])");
ok(read('manager.css').includes('.rc-wg {') && read('manager.css').includes('.rcard.is-wg'), 'the Workbench styles a workgroup chip on its main room and a stand-alone workgroup card');
ok(mgr.includes("mk('button', 'rc-wg')") && mgr.includes("chip.append(mk('b', '', String(w.unread)))"), 'workgroups are CHIPS on the main room card, each with its own unread count (a click opens that room)');

/* [xpost fold] Owner 2026-10-06: the same agent-to-agent line in two rooms */
{
  const inc = { direction: 'in', origin_name: 'Studio Dev', targets: [{ handle: 'alpha-studio' }] };
  ok(wg.foldIncoming(inc) === true, 'an incoming agent-to-agent copy folds');
  ok(wg.foldIncoming(inc, { toUser: true }) === false && wg.foldIncoming(inc, { byUser: true }) === false, 'a copy to or from the person stays open');
  ok(wg.foldIncoming({ direction: 'out', local: 0 }) === false && wg.foldIncoming(null) === false, 'the origin room and plain lines are never folded');
  const rjs = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'room.js'), 'utf8');
  ok(rjs.includes("li.classList.add('xp-folded')") && rjs.includes('body.hidden = true') && rjs.includes("show.className = 'xp-show'"), 'the room page folds the body behind a show button');
}


console.log('\n[follow the room]');
const roomJs = read('room.js');
ok(/function followGroup\(hide\)/.test(roomJs) && /id = 'designFollow'/.test(roomJs) && /setAttribute\('role', 'switch'\)/.test(roomJs.slice(roomJs.indexOf('function followGroup'), roomJs.indexOf('function followGroup') + 600)), 'a workgroup\'s settings carry a Follow-the-room switch (role=switch)');
ok(/state\.room\?\.parent_id \? followGroup\(\[\.\.\.inh, look\.art, look\.palette\]\) : null/.test(roomJs), '...only on a WORKGROUP (never a main room), hiding the From-the-main-room rows, Art and Palette; Room color stays');
ok(/saveSettings\(\{ design_follow: next \}, msg\)/.test(roomJs) && /'design_follow'\]/.test(roomJs), '...it PATCHes design_follow and takes the engine\'s answer back');
ok(/await fetchRoom\(\);/.test(roomJs.slice(roomJs.indexOf('function followGroup'), roomJs.indexOf('function followGroup') + 1800)), '...and repaints the line from the effective room at once');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
