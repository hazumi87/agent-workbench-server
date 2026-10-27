/**
 * TASKS, part two (src/table/tasks-store.ts): topics and focus, bulk subtasks, "needs you" stretches, the timeline (spec section 6), and the
 * 7-day retention sweep. A scratch in-memory db.
 */
import Database from 'better-sqlite3';
import {
  ensureTaskTables, addTask, claim, setStatus, setFlag, progress, requireTask, TaskError, listTasks, purge,
  topicList, topicAdd, topicRename, topicDelete, topicMove, moveToTopic, setFocus, addSubtasks, timeline, sweepRetention,
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
const FAM = 'main';
const PLAN = 'g-plan';
const H = 3_600_000;

console.log('\n[topics and focus]');
const t1 = topicAdd(d, PLAN, 'Launch');
const t2 = topicAdd(d, PLAN, 'Docs');
const t3 = topicAdd(d, PLAN, 'Polish');
ok(topicList(d, PLAN).map((t) => t.name).join() === 'Launch,Docs,Polish', 'topics come back in order');
ok(code(() => topicAdd(d, PLAN, '')) === 400 && code(() => topicAdd(d, PLAN, 'x'.repeat(81))) === 400, 'a topic name is 1..80 characters');
ok(code(() => topicAdd(d, PLAN, 'launch')) === 409, 'a name is unique in the group, whatever its case');
topicRename(d, PLAN, t2.id, 'Documentation');
ok(topicList(d, PLAN)[1].name === 'Documentation', 'renamed');
topicMove(d, PLAN, t3.id, 0);
ok(topicList(d, PLAN).map((t) => t.name).join() === 'Polish,Launch,Documentation', 'moved to the top');
topicMove(d, PLAN, t3.id, 99);
ok(topicList(d, PLAN).map((t) => t.name).join() === 'Launch,Documentation,Polish', 'a position past the end means last');
ok(code(() => topicRename(d, 'g-other', t1.id, 'x')) === 404, 'a topic of another group is "no such topic"');
const a = addTask(d, { familyId: FAM, roomId: PLAN, title: 'Ship it' }, 1000);
moveToTopic(d, FAM, a.id, t1.id);
ok(requireTask(d, FAM, a.id).topic_id === t1.id, 'a task moves to a topic');
ok(code(() => moveToTopic(d, FAM, a.id, 99999)) === 404, 'a topic that does not exist is refused');
const other = addTask(d, { familyId: FAM, roomId: 'g-build', title: 'Elsewhere' }, 1001);
ok(code(() => moveToTopic(d, FAM, other.id, t1.id)) === 404, 'a task cannot be filed under another group\'s topic');
setFocus(d, PLAN, t1.id);
ok((d.prepare(`SELECT topic_id FROM task_focus WHERE room_id=?`).get(PLAN) as { topic_id: number }).topic_id === t1.id, 'focus is set');
ok(code(() => setFocus(d, PLAN, 99999)) === 404, 'focus on a topic that does not exist is refused');
setFocus(d, PLAN, null);
ok((d.prepare(`SELECT topic_id FROM task_focus WHERE room_id=?`).get(PLAN) as { topic_id: number | null }).topic_id === null, 'focus cleared with none');
setFocus(d, PLAN, t1.id);
topicDelete(d, PLAN, t1.id);
ok(requireTask(d, FAM, a.id).topic_id === null && topicList(d, PLAN).length === 2, 'deleting a topic un-files its tasks');
ok((d.prepare(`SELECT topic_id FROM task_focus WHERE room_id=?`).get(PLAN) as { topic_id: number | null }).topic_id === null, '...and clears the focus that pointed at it');

console.log('\n[bounds: topics per group]');
for (let i = 0; i < 46; i++) topicAdd(d, 'g-cap', `t${i}`);
ok(topicList(d, 'g-cap').length === 46, 'a group takes topics up to the cap');
for (let i = 46; i < 50; i++) topicAdd(d, 'g-cap', `t${i}`);
ok(topicList(d, 'g-cap').length === 50 && code(() => topicAdd(d, 'g-cap', 'one too many')) === 409, 'the 51st topic in a group is a 409 that says so');
ok(topicList(d, PLAN).length >= 1 && code(() => topicAdd(d, 'g-other-cap', 'fine')) === null, 'another group is unaffected');

console.log('\n[bulk subtasks]');
const kids = addSubtasks(d, { familyId: FAM, parentId: a.id, titles: ['One', ' Two ', 'Three'] }, 2000);
ok(kids.length === 3 && kids.every((k) => k.parent_id === a.id && k.room_id === PLAN) && kids[1].title === 'Two', 'each title becomes a child task in the parent\'s group');
ok(code(() => addSubtasks(d, { familyId: FAM, parentId: a.id, titles: [] })) === 400, 'an empty list is refused');
ok(code(() => addSubtasks(d, { familyId: FAM, parentId: a.id, titles: Array.from({ length: 21 }, (_, i) => `t${i}`) })) === 400, 'at most 20 at once');
ok(code(() => addSubtasks(d, { familyId: FAM, parentId: a.id, titles: ['ok', ''] })) === 400, 'one bad title refuses the whole list');
ok(listTasks(d, FAM, { limit: 200 }).filter((t) => t.parent_id === a.id).length === 3, '...and nothing from the refused lists was written');
ok(code(() => addSubtasks(d, { familyId: FAM, parentId: kids[0].id, titles: ['deeper'] })) === 409, 'a subtask cannot have subtasks');

console.log('\n[needs-you stretches: only a FLAGGED task needs the person (builder-two [ref] ruling 6)]');
const n = addTask(d, { familyId: FAM, roomId: PLAN, title: 'Need an answer' }, 10_000);
const needs = (id: number): { start_at: number; end_at: number | null }[] => d.prepare(`SELECT start_at, end_at FROM task_needs WHERE task_id=? ORDER BY id`).all(id) as never;
setFlag(d, FAM, n.id, true, 10_100);
ok(needs(n.id).length === 1 && needs(n.id)[0].start_at === 10_100 && needs(n.id)[0].end_at === null, 'flagging opens a needs stretch');
setFlag(d, FAM, n.id, true, 10_150);
ok(needs(n.id).length === 1, 'flagging twice opens nothing new');
setStatus(d, FAM, n.id, 'blocked', 10_200);
ok(needs(n.id).length === 1 && needs(n.id)[0].end_at === null, 'blocking a flagged task changes nothing: still one open stretch');
setFlag(d, FAM, n.id, false, 10_300);
ok(needs(n.id)[0].end_at === 10_300, 'unflagging ENDS the need even though the task is still blocked (it may be waiting on another group, not on the person)');
setStatus(d, FAM, n.id, 'open', 10_400);
setStatus(d, FAM, n.id, 'blocked', 10_450);
ok(needs(n.id).length === 1, 'blocked on its own is NOT a need: no new stretch');
setFlag(d, FAM, n.id, true, 10_500);
ok(needs(n.id).length === 2 && needs(n.id)[1].start_at === 10_500, 'flagged again: a second stretch');
setStatus(d, FAM, n.id, 'done', 10_600);
ok(needs(n.id)[1].end_at === 10_600, 'done ends it');

console.log('\n[the timeline, spec section 6]');
const NOW = 100 * H;
const w = addTask(d, { familyId: FAM, roomId: PLAN, title: 'Write docs' }, NOW - 6 * H);
claim(d, FAM, w.id, 'seat-a', NOW - 6 * H);
setStatus(d, FAM, w.id, 'in-progress', NOW - 5 * H);
setStatus(d, FAM, w.id, 'open', NOW - 3 * H);
setStatus(d, FAM, w.id, 'in-progress', NOW - 1 * H);
const x = addTask(d, { familyId: FAM, roomId: PLAN, title: 'Review docs' }, NOW - 4 * H);
claim(d, FAM, x.id, 'seat-b', NOW - 4 * H);
setStatus(d, FAM, x.id, 'in-progress', NOW - 4 * H);
setStatus(d, FAM, x.id, 'done', NOW - 2 * H);
progress(d, FAM, w.id, 30, 'a third', 'seat-lead', NOW - 90 * 60_000);
const seatInfo = (id: string) => ({ a: { handle: 'writer', lead: false, state: 'working' }, b: { handle: 'reviewer', lead: false, state: 'idle' }, 'seat-a': { handle: 'writer', lead: false, state: 'working' }, 'seat-b': { handle: 'reviewer', lead: false, state: 'idle' } }[id] ?? { handle: id, lead: false, state: 'idle' });
const tl = timeline(d, FAM, [{ id: PLAN, alias: 'plan' }], 8, NOW, seatInfo);
ok(tl.from === NOW - 8 * H && tl.to === NOW && tl.now === NOW, 'the window is the last 8 hours');
const g = tl.groups.find((q) => q.alias === 'plan')!;
const writer = g.seats.find((s) => s.handle === 'writer')!;
ok(writer.stretches.length === 2 && writer.stretches[0].start === NOW - 5 * H && writer.stretches[0].end === NOW - 3 * H && writer.stretches[1].end === null && writer.stretches[0].kind === 'work' && writer.stretches[0].title === 'Write docs', 'a seat\'s stretches: closed ones with both ends, the open one with end null');
ok(g.seats.find((s) => s.handle === 'reviewer')!.stretches.length === 1, 'every seat that worked appears');
ok(g.marks.length === 1 && g.marks[0] === NOW - 90 * 60_000, 'marks are the times a lead set a %');
const peak = g.segments.filter((s) => s.working === 2);
ok(peak.length === 1 && peak[0].start === NOW - 4 * H && peak[0].end === NOW - 3 * H, 'segments count the seats working at once: two seats overlap for one hour');
ok(g.segments.every((s) => s.working >= 1) && g.segments.every((s, i, a2) => i === 0 || a2[i - 1].end <= s.start), 'segments are ordered and never overlap');
ok(tl.room.segments.length === g.segments.length && tl.room.marks.length === 1, 'the room line is the same data over the linked groups');
const narrow = timeline(d, FAM, [{ id: PLAN, alias: 'plan' }], 1, NOW, seatInfo);
ok(narrow.groups[0].seats.find((s) => s.handle === 'writer')!.stretches.length === 1 && narrow.groups[0].marks.length === 0, 'a narrower window keeps only what overlaps it');
ok(timeline(d, FAM, [{ id: PLAN, alias: 'plan' }], 8, NOW, seatInfo).groups[0].needs.length >= 0, 'needs stretches are listed per group');
const nd = timeline(d, FAM, [{ id: PLAN, alias: 'plan' }], 8, 10_550 + 8 * H, seatInfo); // the window starts at 10_550, inside the stretch
ok(nd.groups[0].needs.some((q) => q.start === 10_550 && q.end === 10_600), 'a needs band is {start, end} of the time a task needed the person, CLIPPED to the window (it began at 10_500, the window starts at 10_550)');

console.log('\n[timeline: needs stretches per seat, merged bands, clipping, the cap (builder-two [ref] items 4 and 5)]');
const NOW2 = 500 * H;
const tn1 = addTask(d, { familyId: 'fam-t', roomId: 'g-t', title: 'Needs A' }, NOW2 - 6 * H);
claim(d, 'fam-t', tn1.id, 'seat-a', NOW2 - 6 * H);
setFlag(d, 'fam-t', tn1.id, true, NOW2 - 5 * H);
setFlag(d, 'fam-t', tn1.id, false, NOW2 - 3 * H);
const tn2 = addTask(d, { familyId: 'fam-t', roomId: 'g-t', title: 'Needs B' }, NOW2 - 6 * H);
setFlag(d, 'fam-t', tn2.id, true, NOW2 - 4 * H);
setFlag(d, 'fam-t', tn2.id, false, NOW2 - 2 * H);
const tl2 = timeline(d, 'fam-t', [{ id: 'g-t', alias: 't' }], 8, NOW2, (id) => ({ handle: id, lead: false, state: 'idle' }));
const sa = tl2.groups[0].seats.find((x) => x.handle === 'seat-a')!;
ok(sa && sa.stretches.some((q) => q.kind === 'needs' && q.taskId === tn1.id && q.start === NOW2 - 5 * H && q.end === NOW2 - 3 * H && q.title === 'Needs A'), 'a seat gets kind "needs" stretches for the flagged tasks it has claimed');
ok(!tl2.groups[0].seats.some((x) => x.stretches.some((q) => q.kind === 'needs' && q.taskId === tn2.id)), 'an unclaimed flagged task is in the group\'s needs, under no seat');
ok(tl2.groups[0].needs.length === 1 && tl2.groups[0].needs[0].start === NOW2 - 5 * H && tl2.groups[0].needs[0].end === NOW2 - 2 * H, 'overlapping needs are MERGED into one band (5h to 2h ago)');
ok(tl2.room.needs.length === 1 && tl2.room.needs[0].start === NOW2 - 5 * H && tl2.room.needs[0].end === NOW2 - 2 * H, '...in the room line too');
const tn3 = addTask(d, { familyId: 'fam-t', roomId: 'g-t', title: 'Needs C open' }, NOW2 - 7 * H);
setFlag(d, 'fam-t', tn3.id, true, NOW2 - 10 * H); // started before the window
const tl3 = timeline(d, 'fam-t', [{ id: 'g-t', alias: 't' }], 8, NOW2, (id) => ({ handle: id, lead: false, state: 'idle' }));
const open3 = tl3.groups[0].needs.find((q) => q.end === null);
ok(!!open3 && open3.start === NOW2 - 8 * H, 'a stretch that began before the window is CLIPPED to its start, and stays open (end null)');
const cl = addTask(d, { familyId: 'fam-t', roomId: 'g-t', title: 'Long worker' }, NOW2 - 20 * H);
claim(d, 'fam-t', cl.id, 'seat-clip', NOW2 - 20 * H);
setStatus(d, 'fam-t', cl.id, 'in-progress', NOW2 - 12 * H);
const clipped = timeline(d, 'fam-t', [{ id: 'g-t', alias: 't' }], 8, NOW2, (id) => ({ handle: id, lead: false, state: 'idle' })).groups[0].seats.find((x) => x.handle === 'seat-clip')!;
ok(clipped.stretches[0].start === NOW2 - 8 * H && clipped.stretches[0].end === null, 'a work stretch from before the window starts at the window\'s edge');
for (let i = 0; i < 205; i++) {
  const w = addTask(d, { familyId: 'fam-cap2', roomId: 'g-cap2', title: `W${i}` }, NOW2 - 7 * H);
  claim(d, 'fam-cap2', w.id, 'seat-busy', NOW2 - 7 * H);
  setStatus(d, 'fam-cap2', w.id, 'in-progress', NOW2 - 7 * H + i * 60_000);
  setStatus(d, 'fam-cap2', w.id, 'open', NOW2 - 7 * H + i * 60_000 + 30_000);
}
const busy = timeline(d, 'fam-cap2', [{ id: 'g-cap2', alias: 'c' }], 8, NOW2, (id) => ({ handle: id, lead: false, state: 'idle' })).groups[0].seats[0];
ok(busy.stretches.length === 200, 'a seat shows at most 200 stretches', busy.stretches.length);
ok(busy.dropped === 5, 'and the answer SAYS it dropped some (5)', busy.dropped);
ok(busy.stretches[0].start > NOW2 - 7 * H + 4 * 60_000, 'it drops the OLDEST, keeping the newest');
ok(timeline(d, 'fam-t', [{ id: 'g-t', alias: 't' }], 8, NOW2, (id) => ({ handle: id, lead: false, state: 'idle' })).groups[0].seats.every((x) => !x.dropped), 'a seat that dropped nothing carries no `dropped`');

console.log('\n[timeline: every lane is bounded, not only the per-seat stretches (builder-two round 2, item 1)]');
const NOW3 = 900 * H;
const seg = (id: string) => (x: string) => ({ handle: x, lead: false, state: 'idle', id });
for (let i = 0; i < 600; i++) {
  const t = addTask(d, { familyId: 'fam-b', roomId: 'g-b', title: `S${i}` }, NOW3 - 7 * H);
  claim(d, 'fam-b', t.id, 'seat-b', NOW3 - 7 * H);
  setStatus(d, 'fam-b', t.id, 'in-progress', NOW3 - 7 * H + i * 30_000);
  setStatus(d, 'fam-b', t.id, 'open', NOW3 - 7 * H + i * 30_000 + 10_000); // 10 s of work, 20 s gap: 600 separate segments
}
for (let i = 0; i < 250; i++) {
  const t = addTask(d, { familyId: 'fam-b', roomId: 'g-b', title: `N${i}` }, NOW3 - 7 * H);
  setFlag(d, 'fam-b', t.id, true, NOW3 - 6 * H + i * 60_000);
  setFlag(d, 'fam-b', t.id, false, NOW3 - 6 * H + i * 60_000 + 20_000); // 250 separate needs bands
  progress(d, 'fam-b', t.id, 10, '', 'lead', NOW3 - 5 * H + i * 1000);
}
const big = timeline(d, 'fam-b', [{ id: 'g-b', alias: 'b' }], 8, NOW3, seg('x') as never);
const bg = big.groups[0];
ok(bg.segments.length === 500, 'segments are capped at 500', bg.segments.length);
ok(bg.needs.length === 200, 'needs bands are capped at 200', bg.needs.length);
ok(bg.marks.length === 200, 'marks are capped at 200', bg.marks.length);
ok(bg.dropped?.segments === 100 && bg.dropped?.needs === 50 && bg.dropped?.marks === 50, 'and the lane SAYS how many it dropped', JSON.stringify(bg.dropped));
ok(bg.segments[bg.segments.length - 1].start > bg.segments[0].start && bg.segments[0].start > NOW3 - 7 * H + 90 * 30_000, 'it keeps the NEWEST (the oldest 100 segments are the ones gone)');
ok(big.room.segments.length === 500 && big.room.needs.length === 200 && big.room.marks.length === 200 && big.room.dropped?.segments === 100, 'the room lane is capped the same way');
const small = timeline(d, 'fam-t', [{ id: 'g-t', alias: 't' }], 8, NOW2, seg('x') as never);
ok(small.groups[0].dropped === undefined && small.room.dropped === undefined, 'a lane that dropped nothing carries no `dropped`');
for (let i = 0; i < 4100; i++) d.prepare(`INSERT INTO task_stretches (task_id, seat_id, start_at, end_at) VALUES (999999, 'seat-flood', ?, ?)`).run(NOW3 - 2 * H + i, NOW3 - 2 * H + i + 1);
d.prepare(`INSERT INTO tasks (id, family_id, room_id, title, created_at, updated_at, status_at) VALUES (999999, 'fam-flood', 'g-flood', 'flood', 1, 1, 1)`).run();
const flood = timeline(d, 'fam-flood', [{ id: 'g-flood', alias: 'f' }], 8, NOW3, seg('x') as never).groups[0];
ok(flood.truncated === true && flood.seats[0].stretches.length <= 200, 'a flood past the query limit is read only up to it, and the group says `truncated`');

console.log('\n[retention: done tasks lose everything but title and dates after 7 days]');
const old = addTask(d, { familyId: FAM, roomId: PLAN, title: 'Old done', body: 'long text' }, 1000);
claim(d, FAM, old.id, 'seat-a', 1000);
setStatus(d, FAM, old.id, 'in-progress', 1100);
progress(d, FAM, old.id, 80, 'nearly', 'lead', 1200);
setStatus(d, FAM, old.id, 'done', 1300);
const fresh = addTask(d, { familyId: FAM, roomId: PLAN, title: 'Recent done', body: 'keep me' }, 1000);
setStatus(d, FAM, fresh.id, 'done', 1300 + 6 * 24 * H);
const openOld = addTask(d, { familyId: FAM, roomId: PLAN, title: 'Open and ancient', body: 'still here' }, 1000);
progress(d, FAM, openOld.id, 10, 'slow', 'lead', 1200);
setFlag(d, FAM, old.id, true, 1250);
const tpc = topicAdd(d, PLAN, 'Archive me');
moveToTopic(d, FAM, old.id, tpc.id);
const swept = sweepRetention(d, 1300 + 8 * 24 * H);
ok(swept === 2, 'two tasks trimmed: this one, and the earlier needs-you task that was done at 10_600', swept);
const o = requireTask(d, FAM, old.id);
ok(o.trimmed === 1 && o.body === '' && o.title === 'Old done' && o.done_at === 1300 && o.created_at === 1000 && o.status === 'done' && o.room_id === PLAN, 'it keeps its title, group, status and dates, not its body');
ok(o.claimed_seat === null && o.flagged === 0 && o.pinned === 0 && o.bug === 0 && o.topic_id === null, '...and its claimer, flags and topic are cleared');
ok((d.prepare(`SELECT COUNT(*) AS n FROM task_notes WHERE task_id=?`).get(old.id) as { n: number }).n === 0 && (d.prepare(`SELECT COUNT(*) AS n FROM task_stretches WHERE task_id=?`).get(old.id) as { n: number }).n === 0, 'its notes and stretches are gone');
ok(requireTask(d, FAM, fresh.id).body === 'keep me', 'a task done 6 days ago is untouched');
ok(requireTask(d, FAM, openOld.id).body === 'still here' && (d.prepare(`SELECT COUNT(*) AS n FROM task_notes WHERE task_id=?`).get(openOld.id) as { n: number }).n === 1, 'an open task keeps its notes however old');
ok(sweepRetention(d, 1300 + 8 * 24 * H) === 0, 'the sweep is idempotent');
purge(d, FAM, o.id);
ok(code(() => requireTask(d, FAM, o.id)) === 404 && (d.prepare(`SELECT COUNT(*) AS n FROM task_needs WHERE task_id=?`).get(o.id) as { n: number }).n === 0, 'purging removes the needs rows too');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
