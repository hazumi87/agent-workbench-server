/**
 * TASKS, the pure rules (src/engine/tasks-rules.ts; KB design-notes-id): percentages, bounds, input validation, spoofed authors, and who may
 * do which verb. No engine, no db.
 */
import {
  groupPct, roomPct, taskRefusal, spoofedKey, clampLimit, clampHours, validTitle, validBody, validNote, validPriority, validPct, validStatus,
  pastKeeping, TaskInputError, DONE_KEEP_MS, TITLE_MAX, BODY_MAX, NOTE_MAX, TOPICS_MAX, OPEN_MAX, TIMELINE_STRETCH_MAX, type TaskVerb, type TaskActor,
} from '../src/engine/tasks-rules.ts';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
const throwsField = (f: () => unknown): string | null => {
  try { f(); return null; } catch (e) { return e instanceof TaskInputError ? e.field : `other: ${(e as Error).message}`; }
};

console.log('\n[% of a group: the average pct, done counts as 100]');
ok(groupPct([]) === null, 'no tasks: null (nothing to average is not 0%)');
ok(groupPct([{ status: 'open', pct: 0 }]) === 0, 'one open task at 0: 0');
ok(groupPct([{ status: 'done', pct: 0 }]) === 100, 'a done task counts as 100 whatever its pct says');
ok(groupPct([{ status: 'done', pct: 30 }, { status: 'in-progress', pct: 50 }, { status: 'open', pct: 0 }]) === 50, '(100 + 50 + 0) / 3 = 50');
ok(groupPct([{ status: 'in-progress', pct: 33 }, { status: 'in-progress', pct: 34 }]) === 34, 'rounded to a whole number');

console.log('\n[% of the room: linked groups only]');
const g = (linked: boolean, ...pcts: number[]) => ({ linked, tasks: pcts.map((pct) => ({ status: 'open' as const, pct })) });
ok(roomPct([g(true, 100), g(true, 0)]) === 50, 'two linked groups: the average over their tasks');
ok(roomPct([g(true, 100), g(false, 0, 0, 0)]) === 100, 'an unlinked group is left out of the room line');
ok(roomPct([g(false, 40)]) === null, 'no linked group: null, not 0');
ok(roomPct([g(true), g(true, 60)]) === 60, 'a linked group with no tasks adds nothing');
ok(roomPct([g(true, 100, 100, 100), g(true, 0)]) === 75, 'it averages TASKS, not groups: 300/4');

console.log('\n[bounds]');
ok(clampLimit(undefined) === 50 && clampLimit('x') === 50 && clampLimit(NaN) === 50, 'limit defaults to 50');
ok(clampLimit(0) === 1 && clampLimit(-5) === 1 && clampLimit(1000) === 200 && clampLimit('75') === 75, 'limit is clamped to 1..200 (a string number is read)');
ok(clampHours(undefined) === 8 && clampHours(0) === 1 && clampHours(99) === 24 && clampHours('12') === 12, 'hours defaults to 8, clamped to 1..24');
ok(validTitle('  A   spaced   title ') === 'A spaced title', 'a title is trimmed and single-spaced');
ok(throwsField(() => validTitle('')) === 'title' && throwsField(() => validTitle(5)) === 'title' && throwsField(() => validTitle('x'.repeat(TITLE_MAX + 1))) === 'title', 'an empty, non-text or over-long title is refused, naming the field');
ok(validTitle('x'.repeat(TITLE_MAX)).length === TITLE_MAX, 'exactly 200 is fine');
ok(validBody(undefined) === '' && validBody('hi') === 'hi', 'a body is optional');
ok(throwsField(() => validBody('x'.repeat(BODY_MAX + 1))) === 'body' && throwsField(() => validBody(3)) === 'body', 'a body over 16 KB, or not text, is refused');
ok(throwsField(() => validBody('é'.repeat(BODY_MAX / 2 + 1))) === 'body', '16 KB is BYTES, not characters');
ok(validNote(' one line ') === 'one line' && throwsField(() => validNote('x'.repeat(NOTE_MAX + 1))) === 'note', 'a note is at most 280 characters');
ok(validPriority(0) === 0 && validPriority(5) === 5 && throwsField(() => validPriority(6)) === 'priority' && throwsField(() => validPriority(1.5)) === 'priority' && throwsField(() => validPriority('1')) === 'priority', 'priority is a whole number 0..5');
ok(validPct(0) === 0 && validPct(100) === 100 && throwsField(() => validPct(101)) === 'pct' && throwsField(() => validPct(-1)) === 'pct' && throwsField(() => validPct(50.5)) === 'pct', 'pct is a whole number 0..100');
ok(validStatus('in-progress') && validStatus('done') && !validStatus('finished') && !validStatus(undefined), 'four statuses');

console.log('\n[the author always comes from the caller]');
for (const k of ['from', 'by', 'author', 'actor', 'handle', 'seat', 'user', 'sender']) {
  ok(spoofedKey({ title: 'x', [k]: 'someone' }) === k, `"${k}" in the input is refused`);
}
ok(spoofedKey({ title: 'x', AUTHOR: 'y' }) === 'author', 'case does not matter');
ok(spoofedKey({ seat: 'rob' }, ['seat']) === null && spoofedKey({ seat: 'rob', author: 'z' }, ['seat']) === 'author', 'a verb may allow ONE key as a target (assign takes `seat`), and every other banned key stays refused');
ok(spoofedKey({ seat: 'rob' }) === 'seat', '...and without that allowance `seat` is still refused');
ok(spoofedKey({ title: 'x', group: 'plan' }) === null && spoofedKey(null) === null && spoofedKey([]) === null, 'ordinary input passes');

console.log('\n[who may do what]');
const person: TaskActor = { kind: 'person' };
const seat: TaskActor = { kind: 'seat' };
const owner: TaskActor = { kind: 'seat', ownsTask: true };
const lead: TaskActor = { kind: 'seat', lead: true, leadsThisGroup: true, leadsOwnGroup: true };
const otherLead: TaskActor = { kind: 'seat', lead: true, leadsThisGroup: false, leadsOwnGroup: false };
const roomLead: TaskActor = { kind: 'seat', lead: true, leadsThisGroup: true, leadsOwnGroup: false }; // leads the MAIN room: acts in every group, but this group is not its own
const ALL: TaskVerb[] = ['list', 'summary', 'timeline', 'add', 'claim', 'unclaim', 'flag', 'unflag', 'priority', 'subtasks', 'bug', 'unbug', 'ask-lead', 'status', 'assign', 'progress', 'pin', 'unpin', 'topics', 'topic-add', 'topic-rename', 'topic-delete', 'topic-move', 'move-to-topic', 'focus', 'link', 'unlink', 'purge', 'set-linked'];
ok(ALL.every((v) => taskRefusal(v, person) === null), 'the person may do every verb');
for (const v of ['list', 'summary', 'timeline', 'add', 'claim', 'flag', 'unflag', 'priority', 'subtasks', 'bug', 'unbug', 'ask-lead'] as TaskVerb[]) {
  ok(taskRefusal(v, seat) === null, `any seat: ${v}`);
}
ok(taskRefusal('status', seat) !== null && taskRefusal('status', owner) === null && taskRefusal('status', lead) === null, 'status: a seat only on a task it claimed; a lead on any');
for (const v of ['assign', 'progress', 'pin', 'unpin', 'topics', 'topic-add', 'topic-rename', 'topic-delete', 'topic-move', 'move-to-topic', 'focus'] as TaskVerb[]) {
  ok(taskRefusal(v, seat) !== null && taskRefusal(v, owner) !== null && taskRefusal(v, lead) === null, `${v}: the group's lead, a plain seat is refused`);
  ok(taskRefusal(v, otherLead) !== null, `${v}: another group's lead is refused too (a lead acts in its own group, or in all of them as the room lead)`);
}
ok(taskRefusal('link', lead) === null && taskRefusal('unlink', lead) === null, 'link/unlink: a lead for its own group');
ok(taskRefusal('link', otherLead) !== null && taskRefusal('unlink', seat) !== null, '...not another group\'s lead, not a plain seat');
ok(taskRefusal('purge', lead) !== null && taskRefusal('set-linked', lead) !== null && taskRefusal('purge', seat) !== null, 'purge and set-linked: never a seat, a lead included');
ok(/person/.test(taskRefusal('purge', lead) ?? ''), 'and the refusal says it is the person\'s');

console.log('\n[builder-two\'s review, rules: a lead acts in its OWN group; link is its own group only]');
ok(taskRefusal('status', lead) === null && taskRefusal('status', owner) === null && taskRefusal('status', seat) !== null, 'status: the owner, or the lead of the task\'s group');
ok(taskRefusal('status', otherLead) !== null, 'status: ANOTHER group\'s lead is refused (the build lead can not set a plan task to done)');
ok(taskRefusal('status', roomLead) === null, '...the room lead acts in every group');
ok(taskRefusal('unclaim', owner) === null && taskRefusal('unclaim', lead) === null && taskRefusal('unclaim', seat) !== null && taskRefusal('unclaim', otherLead) !== null, 'unclaim: the owner, or the group\'s lead; a plain seat and another group\'s lead can not release someone else\'s task');
ok(taskRefusal('unclaim', roomLead) === null, '...the room lead too');
ok(taskRefusal('link', lead) === null && taskRefusal('unlink', lead) === null, 'link and unlink: the group\'s own lead');
ok(taskRefusal('link', roomLead) !== null && taskRefusal('unlink', roomLead) !== null, '...NOT the room lead for a group that is not its own (only that group\'s lead, or the person, flips it)');
ok(taskRefusal('link', person) === null && taskRefusal('link', seat) !== null, 'the person always may');
ok(clampLimit('') === 50 && clampHours('') === 8, 'an empty ?limit= or ?hours= takes the default, not the minimum');
ok(clampLimit('  ') === 50 && clampHours(null) === 8, '...and so does blank space or null');
ok(TOPICS_MAX === 50 && OPEN_MAX === 2000 && TIMELINE_STRETCH_MAX === 200, 'the bounds: 50 topics per group, 2,000 open tasks per family, 200 stretches per seat in a timeline');

console.log('\n[retention]');
const now = 10_000_000_000;
ok(!pastKeeping(null, now) && !pastKeeping(now - DONE_KEEP_MS, now) && pastKeeping(now - DONE_KEEP_MS - 1, now), 'a done task is kept for 7 days exactly, an open one forever');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
