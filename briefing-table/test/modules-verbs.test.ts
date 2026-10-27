/**
 * MODULE TASKS VERBS (src/server/modules/verbs.ts; ported from workbench-app test/module-tasks-verbs.test.mjs): the fixed verb map a module page's
 * Tasks calls go through. Each verb has one grant, one method and one path under /api/rooms/:id (KB design-notes-id §4, §8, §10). Inputs are
 * checked here before anything reaches the engine: only the verb's own keys, the right types, the spec's bounds, and never an author key. The room
 * comes from the caller's binding, never from the input. The app's Vikunja-only room-summary verb is not in the engine, so it has no tests here.
 * Pure.
 */
import { isDeepStrictEqual } from 'node:util';
import { build, VERBS } from '../src/server/modules/verbs.ts';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
function same(actual: unknown, want: unknown, msg: string): void {
  if (isDeepStrictEqual(actual, want)) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}: got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`); }
}
const R = 'room-1';
const pathOf = (verb: unknown, input: unknown, room: unknown = R): unknown => { const r = build(verb, room, input); return r.ok ? r.path : null; };
const methodOf = (verb: string, input: unknown): unknown => { const r = build(verb, R, input); return r.ok ? r.method : null; };
const bodyOf = (verb: string, input: unknown): unknown => { const r = build(verb, R, input); return r.ok ? r.body : null; };

console.log('\n[reads: list, summary, timeline, topics, with their query bounds]');
same(build('summary', R, {}), { ok: true, grant: 'rooms.tasks.read', method: 'GET', path: '/api/rooms/room-1/tasks/summary', body: null }, 'summary');
same(build('list', R, { group: 'server', status: 'open', limit: 50 }),
  { ok: true, grant: 'rooms.tasks.read', method: 'GET', path: '/api/rooms/room-1/tasks?group=server&status=open&limit=50', body: null }, 'list with its three query keys');
ok(pathOf('list', {}) === '/api/rooms/room-1/tasks', 'list with no query');
ok(pathOf('timeline', { hours: 8 }) === '/api/rooms/room-1/tasks/timeline?hours=8', 'timeline hours');
ok(pathOf('topics', {}) === '/api/rooms/room-1/tasks/topics', 'topics');

console.log('\n[writes: add, status, progress, flag, priority, pin, focus, link, assign]');
same(build('add', R, { title: 'Wire the cells', priority: 2 }),
  { ok: true, grant: 'rooms.tasks.write', method: 'POST', path: '/api/rooms/room-1/tasks', body: { title: 'Wire the cells', priority: 2 } }, 'add');
same(build('status', R, { tid: 12, status: 'done' }),
  { ok: true, grant: 'rooms.tasks.write', method: 'POST', path: '/api/rooms/room-1/tasks/12/status', body: { status: 'done' } }, 'status');
ok(pathOf('progress', { tid: 3, pct: 40, note: 'cells wired' }) === '/api/rooms/room-1/tasks/3/progress', 'progress');
same([methodOf('flag', { tid: 3 }), methodOf('unflag', { tid: 3 })], ['POST', 'DELETE'], 'flag is a POST, unflag a DELETE');
ok(methodOf('focus', { topic: null }) === 'PUT', 'focus is a PUT, and null clears it');
ok(pathOf('link', {}) === '/api/rooms/room-1/tasks/link', 'link');
same(bodyOf('assign', { tid: 4, group: 'client' }), { group: 'client' }, 'assign to a group');
same(bodyOf('assign', { tid: 4, seat: 'builder-two' }), { seat: 'builder-two' }, 'assign to a seat (the one place "seat" is an input)');

console.log('\n[delete is its own grant and needs an approval token, which never reaches the engine]');
same(build('purge', R, { tid: 9 }), { ok: true, grant: 'rooms.tasks.delete', method: 'DELETE', path: '/api/rooms/room-1/tasks/9', body: null, needsApproval: true, taskId: 9 }, 'purge');

console.log('\n[refused: an unknown verb, a person-only verb the app does not expose, claim (a person cannot claim), and room-summary (not in the engine)]');
for (const verb of ['drop', 'claim', 'unclaim', 'set-linked', 'room-summary', '__proto__', 'constructor', '', null]) {
  const r = build(verb, R, {});
  ok(r.ok === false && r.field === 'verb', 'verb ' + JSON.stringify(verb));
}
ok(!('room-summary' in VERBS), 'the verb table has no room-summary');

console.log('\n[refused: unknown keys, author keys, and the room in the input]');
for (const [verb, input, field] of [
  ['add', { title: 'x', by: 'me' }, 'by'], ['add', { title: 'x', author: 'me' }, 'author'], ['add', { title: 'x', from: 'me' }, 'from'],
  ['add', { title: 'x', seat: 's' }, 'seat'], ['status', { tid: 1, status: 'done', user: 'u' }, 'user'],
  ['summary', { roomId: 'other' }, 'roomId'], ['list', { room: 'other' }, 'room'], ['add', { title: 'x', extra: 1 }, 'extra'],
] as const) {
  const r = build(verb, R, input);
  ok(r.ok === false && r.field === field, verb + ' ' + field);
}

console.log('\n[refused: wrong types and out-of-bound values]');
for (const [verb, input, field] of [
  ['list', { limit: 0 }, 'limit'], ['list', { limit: 201 }, 'limit'], ['list', { limit: 1.5 }, 'limit'], ['list', { status: 'later' }, 'status'],
  ['list', { group: '  ' }, 'group'], ['list', { group: 7 }, 'group'],
  ['timeline', { hours: 25 }, 'hours'], ['timeline', { hours: 0 }, 'hours'],
  ['add', {}, 'title'], ['add', { title: '' }, 'title'], ['add', { title: 'x'.repeat(201) }, 'title'], ['add', { title: 'x', body: 'b'.repeat(16 * 1024 + 1) }, 'body'],
  ['add', { title: 'x', priority: 6 }, 'priority'], ['add', { title: 'x', parent: 'p' }, 'parent'],
  ['status', { tid: 1, status: 'gone' }, 'status'], ['status', { status: 'done' }, 'tid'], ['status', { tid: -1, status: 'done' }, 'tid'], ['status', { tid: '1', status: 'done' }, 'tid'],
  ['progress', { tid: 1, pct: 101, note: 'n' }, 'pct'], ['progress', { tid: 1, pct: 5, note: 'n'.repeat(281) }, 'note'],
  ['assign', { tid: 1 }, 'group'], ['assign', { tid: 1, group: 'a', seat: 'b' }, 'group'],
  ['subtasks', { tid: 1, titles: [] }, 'titles'], ['subtasks', { tid: 1, titles: ['ok', 7] }, 'titles'],
] as const) {
  const r = build(verb, R, input);
  ok(r.ok === false && r.field === field, verb + ' ' + JSON.stringify(input).slice(0, 60) + ' -> ' + field);
}

console.log('\n[the room id is path-encoded and must be a plain id; input that is not an object is refused]');
ok(build('summary', 'a/b', {}).ok === false, 'a room id with a slash');
ok(build('summary', '', {}).ok === false, 'an empty room id');
ok(build('summary', R, null).ok === false, 'null input');
ok(build('summary', R, []).ok === false, 'array input');

console.log('\n[every verb names exactly one of the three grants]');
for (const [name, spec] of Object.entries(VERBS)) ok(['rooms.tasks.read', 'rooms.tasks.write', 'rooms.tasks.delete'].includes(spec.grant), name);

console.log('\n[list status is one the engine accepts: open, in-progress, blocked or done (never "all")]');
for (const st of ['open', 'in-progress', 'blocked', 'done']) ok(build('list', R, { status: st }).ok === true, st);
{
  const r = build('list', R, { status: 'all' });
  ok(r.ok === false && r.field === 'status', '"all" is refused, naming status');
}

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
