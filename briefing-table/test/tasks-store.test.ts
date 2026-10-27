/**
 * TASKS, the rows (src/table/tasks-store.ts; KB design-notes-id): add/list/claim/status, the stretch bookkeeping (opens and closes EXACTLY on
 * status and claim changes), assign, progress notes, link, purge, the family boundary, and the summary shape. A scratch in-memory db.
 */
import Database from 'better-sqlite3';
import {
  ensureTaskTables, addTask, claim, unclaim, setStatus, setFlag, setPinned, setPriority, progress, assignToGroup, setGroupLinked, purge,
  listTasks, summary, requireTask, TaskError, releaseSeatTasks,
} from '../src/table/tasks-store.ts';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
const code = (f: () => unknown): number | string | null => {
  try { f(); return null; } catch (e) { return e instanceof TaskError ? e.status : `other: ${(e as Error).message}`; }
};

const d = new Database(':memory:');
ensureTaskTables(d);
ensureTaskTables(d); // idempotent
const FAM = 'main';
const PLAN = 'g-plan';
const BUILD = 'g-build';
const OTHER_FAM = 'main2';
const stretches = (id: number): { seat_id: string; start_at: number; end_at: number | null }[] =>
  d.prepare(`SELECT seat_id, start_at, end_at FROM task_stretches WHERE task_id=? ORDER BY id`).all(id) as never;

console.log('\n[add, list, and the order]');
const a = addTask(d, { familyId: FAM, roomId: PLAN, title: 'Write the brief' }, 1000);
const b = addTask(d, { familyId: FAM, roomId: PLAN, title: 'Pick a name', priority: 3 }, 1001);
const c = addTask(d, { familyId: FAM, roomId: BUILD, title: 'Wire the build' }, 1002);
ok(a.status === 'open' && a.pct === 0 && a.priority === 0 && a.claimed_seat === null && a.family_id === FAM && a.room_id === PLAN, 'a new task is open at 0%, unclaimed, in its group');
ok(b.priority === 3, 'with its priority');
ok(listTasks(d, FAM, { limit: 50 }).length === 3 && listTasks(d, FAM, { roomId: PLAN, limit: 50 }).length === 2, 'list: the whole family, or one group');
ok(listTasks(d, OTHER_FAM, { limit: 50 }).length === 0, 'another family sees none of them');
ok(listTasks(d, FAM, { limit: 2 }).length === 2, 'limit holds');
progress(d, FAM, b.id, 40, 'half way', 'lead', 1500);
setFlag(d, FAM, c.id, true, 1600);
ok(listTasks(d, FAM, { limit: 50 })[0].id === c.id, 'needs-you (flagged) first');
setPinned(d, FAM, a.id, true, 1700);
ok(listTasks(d, FAM, { limit: 50 }).map((t) => t.id).join() === [c.id, a.id, b.id].join(), 'then pinned, then least done first');

console.log('\n[the order after flagged and pinned: MOST done first, then oldest (builder-one [ref])]');
const o1 = addTask(d, { familyId: 'fam-o', roomId: 'g-o', title: 'low' }, 100);
const o2 = addTask(d, { familyId: 'fam-o', roomId: 'g-o', title: 'high-old' }, 101);
const o3 = addTask(d, { familyId: 'fam-o', roomId: 'g-o', title: 'high-new' }, 102);
const o4 = addTask(d, { familyId: 'fam-o', roomId: 'g-o', title: 'pinned-zero' }, 103);
progress(d, 'fam-o', o1.id, 20, '', 'lead', 110);
progress(d, 'fam-o', o2.id, 70, '', 'lead', 111);
progress(d, 'fam-o', o3.id, 70, '', 'lead', 112);
setPinned(d, 'fam-o', o4.id, true, 113);
ok(listTasks(d, 'fam-o', { limit: 50 }).map((t) => t.title).join() === 'pinned-zero,high-old,high-new,low', 'pinned first, then by % DESCENDING, a tie by id ASCENDING (oldest first)');
ok(listTasks(d, 'fam-o', { limit: 3 }).map((t) => t.title).join() === 'pinned-zero,high-old,high-new', 'a limit keeps the most-done tasks, not the least');

console.log('\n[the family boundary reads the same as "no such task"]');
ok(code(() => requireTask(d, OTHER_FAM, a.id)) === 404 && code(() => requireTask(d, FAM, 9999)) === 404, 'a task of another family, and one that does not exist: both 404');
ok(code(() => claim(d, OTHER_FAM, a.id, 's1')) === 404 && code(() => setStatus(d, OTHER_FAM, a.id, 'done')) === 404 && code(() => purge(d, OTHER_FAM, a.id)) === 404, 'no verb reaches across families');

console.log('\n[claim and the stretch: exactly on status and claim changes]');
const t = addTask(d, { familyId: FAM, roomId: PLAN, title: 'Draft spec' }, 2000);
claim(d, FAM, t.id, 'seat-a', 2001);
ok(stretches(t.id).length === 0, 'claimed but still open: no stretch yet');
setStatus(d, FAM, t.id, 'in-progress', 2100);
ok(stretches(t.id).length === 1 && stretches(t.id)[0].seat_id === 'seat-a' && stretches(t.id)[0].start_at === 2100 && stretches(t.id)[0].end_at === null, 'entering in-progress with a claimer opens ONE stretch for that seat');
setStatus(d, FAM, t.id, 'in-progress', 2150);
ok(stretches(t.id).length === 1, 'setting the same status again opens nothing');
setStatus(d, FAM, t.id, 'blocked', 2200);
ok(stretches(t.id)[0].end_at === 2200, 'leaving in-progress closes it');
setStatus(d, FAM, t.id, 'in-progress', 2300);
ok(stretches(t.id).length === 2 && stretches(t.id)[1].end_at === null, 'back in progress: a second stretch');
unclaim(d, FAM, t.id, 2400);
ok(stretches(t.id)[1].end_at === 2400 && stretches(t.id).length === 2, 'unclaiming closes it');
claim(d, FAM, t.id, 'seat-b', 2500);
ok(stretches(t.id).length === 3 && stretches(t.id)[2].seat_id === 'seat-b' && stretches(t.id)[2].start_at === 2500, 'a new claimer on an in-progress task opens one for them');
ok(code(() => claim(d, FAM, t.id, 'seat-c', 2600)) === 409, 'another seat cannot take a claimed task');
ok(stretches(t.id).filter((s) => s.end_at === null).length === 1, 'never more than one open stretch');
setStatus(d, FAM, t.id, 'done', 2700);
const done = requireTask(d, FAM, t.id);
ok(done.status === 'done' && done.done_at === 2700 && done.pct === 100, 'done: stamped, and 100%');
ok(stretches(t.id)[2].end_at === 2700, '...and it closes the stretch');
ok(code(() => claim(d, FAM, t.id, 'seat-d', 2800)) === 409, 'a done task cannot be claimed');
ok(code(() => setStatus(d, FAM, t.id, 'finished')) === 400, 'an unknown status is a 400');
setStatus(d, FAM, t.id, 'open', 2900);
ok(requireTask(d, FAM, t.id).done_at === null, 'reopening clears done_at');
ok(listTasks(d, FAM, { limit: 50 }).every((x) => x.id !== t.id) === false, 'and it is back in the list');

console.log('\n[subtasks, priority, assign, notes]');
const parent = addTask(d, { familyId: FAM, roomId: BUILD, title: 'Big thing' }, 3000);
const child = addTask(d, { familyId: FAM, roomId: BUILD, title: 'Small piece', parentId: parent.id }, 3001);
ok(child.parent_id === parent.id, 'a subtask points at its parent');
ok(code(() => addTask(d, { familyId: FAM, roomId: BUILD, title: 'Too deep', parentId: child.id })) === 409, 'subtasks nest one level only');
ok(code(() => addTask(d, { familyId: FAM, roomId: BUILD, title: 'Wrong family', parentId: a.id }, 3002) && addTask(d, { familyId: OTHER_FAM, roomId: 'x', title: 'y', parentId: a.id })) === 404, 'a parent from another family is "no such task"');
setPriority(d, FAM, parent.id, 5, 3100);
ok(requireTask(d, FAM, parent.id).priority === 5, 'priority is set');
const moved = assignToGroup(d, FAM, a.id, BUILD, 3200);
ok(moved.room_id === BUILD && moved.assigned_from_room === PLAN && moved.claimed_seat === null, 'assigned to another group: it moves, remembers where from, and drops the claim');
ok(assignToGroup(d, FAM, a.id, BUILD, 3300).assigned_from_room === PLAN, 'assigning to where it already is changes nothing');
const notes = d.prepare(`SELECT pct, text, by_seat FROM task_notes WHERE task_id=?`).all(b.id) as { pct: number; text: string; by_seat: string }[];
ok(notes.length === 1 && notes[0].pct === 40 && notes[0].text === 'half way' && notes[0].by_seat === 'lead', 'a progress note keeps the %, the line and who');

console.log('\n[summary: the rail card and the preview header]');
setGroupLinked(d, FAM, BUILD, false);
const s = summary(d, FAM, [{ id: 'main' }, { id: PLAN }, { id: BUILD }], 5000);
ok(s.room.totalGroups === 3 && s.room.linkedGroups === 2, 'three groups, two linked');
const gp = s.groups.find((g) => g.roomId === PLAN)!;
const gb = s.groups.find((g) => g.roomId === BUILD)!;
ok(gp.linked && !gb.linked, 'the unlinked group says so');
ok(gp.pct !== null && gb.pct !== null, 'each group has its own %');
ok(s.room.pct === gp.pct, 'the room % counts only the linked group (the unlinked one is left out)');
ok(gp.activity === 'Draft spec: open', 'the activity line is the latest STATUS change (a later flag or pin does not count)');
progress(d, FAM, b.id, 60, 'nearly there', 'lead', 4000);
ok(summary(d, FAM, [{ id: PLAN }], 5000).groups[0].activity === 'nearly there', '...or the latest lead note when that is newer');
ok(typeof s.room.needsYou === 'number' && s.room.needsYou >= 1, 'a flagged task counts in "need you"');
ok(summary(d, FAM, [{ id: 'main' }], 5000).room.pct === null, 'a group with no tasks and no linked tasks: pct null, not 0');
const old = addTask(d, { familyId: FAM, roomId: 'main', title: 'Long done' }, 100);
setStatus(d, FAM, old.id, 'done', 200);
ok(summary(d, FAM, [{ id: 'main' }], 200 + 8 * 24 * 3_600_000).groups[0].pct === null, 'a done task past 7 days no longer counts');

console.log('\n[the activity line follows a % too, even with no words]');
const q = addTask(d, { familyId: FAM, roomId: 'g-quiet', title: 'Quiet task' }, 6000);
ok(summary(d, FAM, [{ id: 'g-quiet' }], 6001).groups[0].activity === 'Quiet task: open', 'a new task: its status line');
progress(d, FAM, q.id, 70, '', 'lead', 6100);
ok(summary(d, FAM, [{ id: 'g-quiet' }], 6200).groups[0].activity === 'Quiet task: 70%', 'a % set with no note still moves the line, and says the %');
setFlag(d, FAM, q.id, true, 6300);
setPinned(d, FAM, q.id, true, 6400);
ok(summary(d, FAM, [{ id: 'g-quiet' }], 6500).groups[0].activity === 'Quiet task: 70%', 'a flag or a pin after it does not');
setStatus(d, FAM, q.id, 'in-progress', 6600);
ok(summary(d, FAM, [{ id: 'g-quiet' }], 6700).groups[0].activity === 'Quiet task: in-progress', 'a later status change does');

console.log('\n[needs you counts only a FLAGGED task]');
const nb = addTask(d, { familyId: 'fam-n', roomId: 'g-n', title: 'Blocked only' }, 7000);
setStatus(d, 'fam-n', nb.id, 'blocked', 7100);
ok(summary(d, 'fam-n', [{ id: 'g-n' }], 7200).groups[0].needsYou === 0, 'a task that is only blocked does not count in "need you"');
setFlag(d, 'fam-n', nb.id, true, 7300);
ok(summary(d, 'fam-n', [{ id: 'g-n' }], 7400).groups[0].needsYou === 1, 'flagged, it does');
ok(listTasks(d, 'fam-n', { limit: 5 })[0].id === nb.id, 'and it leads the list');
const nc = addTask(d, { familyId: 'fam-n', roomId: 'g-n', title: 'Plain' }, 7500);
setStatus(d, 'fam-n', nc.id, 'blocked', 7600);
ok(listTasks(d, 'fam-n', { limit: 5 })[0].id === nb.id, 'a merely blocked task does not jump the queue of a flagged one');

console.log('\n[reopening a done task: the % goes back to the last lead note, or 0]');
const ro = addTask(d, { familyId: 'fam-r', roomId: 'g-r', title: 'Reopen me' }, 8000);
progress(d, 'fam-r', ro.id, 40, 'forty', 'lead', 8100);
setStatus(d, 'fam-r', ro.id, 'done', 8200);
ok(requireTask(d, 'fam-r', ro.id).pct === 100, 'done is 100%');
setStatus(d, 'fam-r', ro.id, 'open', 8300);
ok(requireTask(d, 'fam-r', ro.id).pct === 40, 'reopened: the latest lead note\'s % (40), not 100');
const ro2 = addTask(d, { familyId: 'fam-r', roomId: 'g-r', title: 'No notes' }, 8400);
setStatus(d, 'fam-r', ro2.id, 'done', 8500);
setStatus(d, 'fam-r', ro2.id, 'open', 8600);
ok(requireTask(d, 'fam-r', ro2.id).pct === 0, 'with no lead note: 0');
progress(d, 'fam-r', ro.id, 55, 'more', 'lead', 8700);
setStatus(d, 'fam-r', ro.id, 'done', 8800);
setStatus(d, 'fam-r', ro.id, 'open', 8900);
ok(requireTask(d, 'fam-r', ro.id).pct === 55, 'the LATEST note wins');
setStatus(d, 'fam-r', ro.id, 'in-progress', 9000);
ok(requireTask(d, 'fam-r', ro.id).pct === 55, 'a status change that does not reopen leaves the % alone');

console.log('\n[a seat that leaves: its stretches close and its tasks are unclaimed]');
const lv = addTask(d, { familyId: 'fam-l', roomId: 'g-l', title: 'Leaver work' }, 9100);
claim(d, 'fam-l', lv.id, 'gone-seat', 9100);
setStatus(d, 'fam-l', lv.id, 'in-progress', 9200);
const lv2 = addTask(d, { familyId: 'fam-l', roomId: 'g-l', title: 'Someone else\'s' }, 9100);
claim(d, 'fam-l', lv2.id, 'stays-seat', 9100);
setStatus(d, 'fam-l', lv2.id, 'in-progress', 9200);
const freed = releaseSeatTasks(d, 'gone-seat', 9300);
ok(freed === 1, 'one task released');
ok(requireTask(d, 'fam-l', lv.id).claimed_seat === null && requireTask(d, 'fam-l', lv.id).status === 'in-progress', 'unclaimed (the work is still open for someone else)');
ok(stretches(lv.id)[0].end_at === 9300, 'its stretch closed at the moment the seat left');
ok(requireTask(d, 'fam-l', lv2.id).claimed_seat === 'stays-seat' && stretches(lv2.id)[0].end_at === null, 'another seat\'s work is untouched');
ok(releaseSeatTasks(d, 'gone-seat', 9400) === 0, 'idempotent');

console.log('\n[bounds: open tasks per family]');
for (let i = 0; i < 1998; i++) d.prepare(`INSERT INTO tasks (family_id, room_id, title, created_at, updated_at, status_at) VALUES ('fam-cap', 'g-cap', 't', 1, 1, 1)`).run();
ok(code(() => addTask(d, { familyId: 'fam-cap', roomId: 'g-cap', title: 'one' })) === null, 'task 1,999 is fine');
ok(code(() => addTask(d, { familyId: 'fam-cap', roomId: 'g-cap', title: 'two' })) === null, 'task 2,000 is fine');
ok(code(() => addTask(d, { familyId: 'fam-cap', roomId: 'g-cap', title: 'three' })) === 409, 'the 2,001st OPEN task is a 409 that says so');
const doneOne = d.prepare(`SELECT id FROM tasks WHERE family_id='fam-cap' LIMIT 1`).get() as { id: number };
setStatus(d, 'fam-cap', doneOne.id, 'done', 5);
ok(code(() => addTask(d, { familyId: 'fam-cap', roomId: 'g-cap', title: 'after a done' })) === null, 'a done task makes room (the cap counts OPEN tasks)');
ok(code(() => addTask(d, { familyId: 'fam-other', roomId: 'g-x', title: 'unaffected' })) === null, 'another family is unaffected');

console.log('\n[summary: the room focus is the MAIN room\'s]');
d.prepare(`INSERT OR REPLACE INTO task_focus (room_id, topic_id) VALUES ('fam-f', 11), ('g-f1', 22), ('g-f2', 33)`).run();
const sf = summary(d, 'fam-f', [{ id: 'g-f1' }, { id: 'fam-f' }, { id: 'g-f2' }], 9500);
ok(sf.room.focus === 11, 'room.focus is the main room\'s focus, whatever order the groups come in');
ok(sf.groups.find((g) => g.roomId === 'g-f1')!.focus === 22 && sf.groups.find((g) => g.roomId === 'g-f2')!.focus === 33, '...and each group keeps its own');

console.log('\n[link and purge]');
setGroupLinked(d, FAM, BUILD, true);
ok(summary(d, FAM, [{ id: BUILD }], 5000).groups[0].linked === true, 'relinking works');
purge(d, FAM, parent.id);
ok(code(() => requireTask(d, FAM, parent.id)) === 404 && code(() => requireTask(d, FAM, child.id)) === 404, 'purge removes the task and its subtasks');
ok((d.prepare(`SELECT COUNT(*) AS n FROM task_stretches WHERE task_id IN (?, ?)`).get(parent.id, child.id) as { n: number }).n === 0, '...and their stretches and notes');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
