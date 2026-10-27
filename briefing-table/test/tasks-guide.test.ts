/**
 * THE TASKS SECTION OF THE ROOM GUIDE (src/server/tasks-guide.ts, wired into room-guide.ts guideText; text: KB design-notes-id section 13, FINAL, builder-two).
 * Shown only when Tasks is on AND the engine is a local one with a bound port (those are the panes that have HARBOR_WB_ENGINE_URL), with this room's id filled in.
 * A scratch table; nothing listens.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wb-tasks-guide-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';

const { table } = await import('../src/table/endpoint.ts');
const { guideText } = await import('../src/server/room-guide.ts');
const { setBoundPort } = await import('../src/engine/local-guard.ts');
const { TASKS_GUIDE } = await import('../src/server/tasks-guide.ts');

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
const room = table.createRoom({ name: 'Guide room' }, { actor: 'user' }).result;
const setMode = (m: string | undefined, tasks: string | undefined): void => {
  if (m === undefined) delete process.env.HARBOR_WB_MODE; else process.env.HARBOR_WB_MODE = m;
  if (tasks === undefined) delete process.env.HARBOR_WB_TASKS; else process.env.HARBOR_WB_TASKS = tasks;
};

console.log('\n[shown only to the panes that can use it]');
setBoundPort(51234);
setMode('local', undefined);
const on = guideText(room);
ok(/^## Tasks$/m.test(on) && on.includes('TASKS: this room\'s task list, kept on this PC.'), 'local engine, Tasks on, port bound: the Tasks section is in the guide');
ok(on.includes(`T="$HARBOR_WB_ENGINE_URL/api/rooms/${room.id}/tasks"`) && !on.includes('{ROOM_ID}'), 'this room\'s id is filled in, and no placeholder is left');
setMode(undefined, undefined);
ok(!guideText(room).includes('TASKS:'), 'a server engine: no section (Tasks is off there, and its panes have no HARBOR_WB_ENGINE_URL)');
setMode(undefined, '1');
ok(!guideText(room).includes('TASKS:'), 'a server engine with HARBOR_WB_TASKS=1: still none (no pane has an engine address to call)');
setMode('local', '0');
ok(!guideText(room).includes('TASKS:'), 'Tasks switched off locally (HARBOR_WB_TASKS=0): none');
setMode('local', undefined);
setBoundPort(null);
ok(!guideText(room).includes('TASKS:'), 'a local engine that has not bound a port yet: none (the panes would have no address)');
setBoundPort(51234);

console.log('\n[Post and read: the way to answer with no room tools]');
setMode('local', undefined);
setBoundPort(51234);
const withPost = guideText(room);
ok(/^## Post and read$/m.test(withPost) && withPost.includes(`L="$HARBOR_WB_ENGINE_URL/api/rooms/${room.id}/line"`) && withPost.includes('for=me&limit=20'), 'a local engine with a bound port: the guide teaches posting and reading on the pane token, with this room\'s id');
ok(withPost.includes('$HARBOR_WB_PANE_TOKEN_FILE') && !withPost.includes('{ROOM_ID}'), '...from the token FILE, no placeholder left');
setMode(undefined, undefined);
ok(!guideText(room).includes('## Post and read'), 'a server engine: no such section');
setMode('local', undefined);
setBoundPort(null);
ok(!guideText(room).includes('## Post and read'), 'a local engine with no bound port: none');
setBoundPort(51234);
console.log('\n[the text is exactly the ruled text]');
ok(TASKS_GUIDE.includes(' \\\n       -d \'{"title":"Wire the cells","priority":2}\''), 'the curl line continuation survived (a backslash then a newline, checked in the bytes)');
ok(TASKS_GUIDE.includes('TOKEN="${HARBOR_WB_PANE_TOKEN:-$(cat "$HARBOR_WB_PANE_TOKEN_FILE")}"') && TASKS_GUIDE.includes('-H "authorization: Bearer $TOKEN"'), 'the token comes from the pane env (or its file) and goes in the bearer header');
ok(!/\[\?\d\]/.test(TASKS_GUIDE), 'no [?n] placeholder from the draft is left');
ok(TASKS_GUIDE.includes('{"error": "<sentence>", "field": "<name>"}') && TASKS_GUIDE.includes('{"ok": false, "error": "<code>", "message": "..."}'), 'both error shapes are quoted');
ok(TASKS_GUIDE.includes('429 rate_limited') && TASKS_GUIDE.includes('403 not_seated') && TASKS_GUIDE.includes('403 not_for_pane_token'), 'the access and rate errors are named');
ok(TASKS_GUIDE.includes('at most 20 writes a minute, shared with your room posts'), 'and the shared write limit');
ok(TASKS_GUIDE.includes('Never print the token'), 'and the rule never to print the token');
const lines = TASKS_GUIDE.split('\n');
ok(lines.length > 25 && lines.every((l) => !l.includes('\r')), 'plain newlines, no carriage returns');

console.log('\n[it does not disturb the rest of the guide]');
ok(on.includes('# Room guide: Guide room') && on.includes('## Addressing') && on.includes('## Agent tools') && on.includes('## Apps in this room'), 'the existing sections are all still there');
ok(on.indexOf('## Tasks') > on.indexOf('## Apps in this room'), 'the Tasks section comes after them');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
