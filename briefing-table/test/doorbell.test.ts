/**
 * DOORBELL DELIVERY (W1, R1): in doorbell mode the room typer types ONE fixed ring and never any room text, peer or person; busy seats coalesce to one ring per room. Same harness as room-typer.test.ts:
 * a temp db, the real activity machine, a fake resident whose pty records writes.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wb-doorbell-'));
process.env.HARBOR_WB_TABLE = join(dir, 'scratch.db');
process.env.HARBOR_WB_ROOM_TYPE_SETTLE_MS = '200';
process.env.HARBOR_WB_TYPE_ENTER_MS = '120';
process.env.HARBOR_WB_TYPE_SUBMIT_CHECK_MS = '150';
process.env.HARBOR_WB_DELIVERY = 'doorbell';
process.env.HARBOR_WB_PTY_TRACE_TEXT = '1';
delete process.env.HARBOR_WB_ROOM_TYPE;

const typer = await import('../src/engine/room-typer.ts');
const activity = await import('../src/engine/activity.ts');
const sessions = await import('../src/engine/sessions.ts');
const ptyWrite = await import('../src/engine/pty-write.ts');
const { table } = await import('../src/table/endpoint.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string, d?: unknown): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}${d !== undefined ? ` (${JSON.stringify(d)})` : ''}`); } };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
activity.setOnChange((p, s) => typer.onActivity(p, s));
let probe: unknown = { pid: 4242, starttime: 1, startedAt: Date.now() - 3_600_000, leader: false }; // a positively known interactive claude
typer.setClaudeProbe((() => probe) as never);
typer.setLog(() => {});

function fakePane(paneid: string, vendor: string): string[] {
  table.upsert({ paneid, recipe_id: null, server: 'local', vendor, agent: null, session_id: null, state: 'live', generation: 1 });
  const writes: string[] = [];
  sessions.add(paneid, { state: 'live', pty: { write: (d: string) => writes.push(d) } } as never, null as never);
  activity.onLive(paneid);
  return writes;
}

const MARK = 'PEER-MARKER-7f3a';
const BODY = `${MARK} $(id) \`id\` ; && rm -rf /`;
const ROOM = 'dddddddd-0000-4000-8000-0000000000d1';

console.log('[the ring text]');
ok(typer.ringFor([{ roomId: ROOM, entryId: 986 }]) === '[room_read {"room":"dddddddd-0000-4000-8000-0000000000d1","since":985} - new line #986 - if replying, use room_post in that room]', 'one line: exact room UUID and exclusive cursor', typer.ringFor([{ roomId: ROOM, entryId: 986 }]));
ok(typer.ringFor([{ roomId: ROOM, entryId: 5 }, { roomId: ROOM, entryId: 9 }, { roomId: ROOM, entryId: 7 }]) === '[room_read {"room":"dddddddd-0000-4000-8000-0000000000d1","since":4} - 3 new lines, latest #9 - if replying, use room_post in that room]', 'several lines of one room: a count and the newest number');
ok(/^[\x20-\x7e]+$/.test(typer.ringFor([{ roomId: 'weird id; $(x)', entryId: 1.5 }])) && !/[;$()]/.test(typer.ringFor([{ roomId: 'weird id; $(x)', entryId: 1.5 }])), 'a hostile room id still gives an inert ASCII ring');

const first = typer.ringFor([{ roomId: ROOM, entryId: 1 }]);
ok(first.includes('"since":0'), 'the first room line uses cursor zero');
for (const entryId of [NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  ok(typer.ringFor([{ roomId: ROOM, entryId }]) === '[room notification - read with room_list_mine]', 'invalid line id never creates a forged cursor');
}
const mixed = typer.ringFor([{ roomId: 'bad\n@user command', entryId: 2 }, { roomId: ROOM, entryId: 3 }]);
ok(!mixed.includes('bad') && mixed.includes(ROOM) && mixed.includes('"since":2'), 'invalid ids do not contaminate a valid notification');
const many = typer.ringFor(Array.from({ length: 8 }, (_, i) => ({ roomId: `0000000${i}-0000-0000-0000-000000000000`, entryId: 2 })));
ok((many.match(/room_read/g) || []).length === 4 && many.length < 650, 'multi-room notification stays bounded at four exact references');

console.log('\n[a peer line and a person line: only the ring is typed]');
const P = 'recipe:doorbell#1';
const w = fakePane(P, 'claude-code');
ptyWrite.resetTrace();
ok(typer.enqueue(P, ROOM, 101, 'Planning', 'auriga', BODY) === 'injected', 'idle: delivered at once');
await sleep(250);
ok(w[0] === '[room_read {"room":"dddddddd-0000-4000-8000-0000000000d1","since":100} - new line #101 - if replying, use room_post in that room]' && w[1] === '\r', 'a peer line: the ring and its Enter, nothing else', w);
ok(!w.join('').includes(MARK) && !w.join('').includes('$(id)'), 'no peer text, no shell syntax reached the terminal');
activity.onTurnStart(P);
activity.onResponseDone(P);
ok(typer.enqueue(P, ROOM, 102, 'Planning', 'user', `${MARK} from the person`) !== 'off', 'a person line is queued/delivered too');
await sleep(300);
ok(!w.join('').includes(MARK), 'a PERSON line is not typed either (pull for everyone)', w);

console.log('\n[a busy seat: lines coalesce into one ring]');
const Q = 'recipe:doorbell#2';
const wq = fakePane(Q, 'claude-code');
activity.onQuestion(Q); // a prompt holds delivery
for (let i = 1; i <= 3; i++) typer.enqueue(Q, ROOM, 200 + i, 'Planning', 'auriga', `${MARK} line ${i}`);
ok(wq.length === 0, 'busy: nothing typed', wq);
activity.onResponseDone(Q);
await sleep(400);
ok(wq[0] === '[room_read {"room":"dddddddd-0000-4000-8000-0000000000d1","since":200} - 3 new lines, latest #203 - if replying, use room_post in that room]', 'one coalesced ring for the three lines', wq);
ok(!wq.join('').includes(MARK), 'and still no text');

console.log('\n[three outcomes: a classifier that cannot tell holds the ring, like none]');
const NQ = 'recipe:doorbell#3';
const wn = fakePane(NQ, 'claude-code');
probe = null;
typer.enqueue(NQ, ROOM, 300, 'Planning', 'auriga', `${MARK} unknown owner`);
await sleep(300);
ok(wn.length === 0 && (typer.diag().panes as Record<string, { lastResult: string }>)[NQ].lastResult === 'held:no-claude', 'cannot tell (null): nothing typed, held as no-claude', { wn, last: (typer.diag().panes as Record<string, { lastResult: string }>)[NQ].lastResult });
probe = 'none';
typer.enqueue(NQ, ROOM, 301, 'Planning', 'auriga', MARK);
await sleep(300);
ok(wn.length === 0, 'none: held too');
probe = { pid: 4242, starttime: 1, startedAt: Date.now() - 3_600_000, leader: false };

console.log('\n[the trace says the same]');
const traced = ptyWrite.writes({ origin: 'room-typer' });
ok(traced.length >= 3 && traced.every((r) => r.text !== undefined && !r.text.includes(MARK)), 'every room-typer write in the trace is a ring or an Enter', traced.map((r) => r.text));

console.log('\n[hosted Codex: tools handshake before the first Tab]');
process.env.HARBOR_WB_HOSTED = '1';
const btTools = await import('../src/engine/bt-tools.ts');
const C = 'recipe:hosted-codex-ready#1';
const cw = fakePane(C, 'codex-cli');
const generation = table.get(C)!.generation;
btTools.plan(C);
typer.enqueue(C, ROOM, 401, 'Planning', 'user', 'a factual question');
ok((typer.diag().panes as any)[C].lastResult === 'held:waiting-for-tools', 'fresh hosted Codex holds the ring before its tools handshake');
await sleep(350);
ok(cw.length === 0, 'neither ring nor key is typed during startup');
if (btTools.noteListed) {
  btTools.noteListed(C, generation + 1);
  await sleep(350);
  ok(cw.length === 0, 'another generation cannot open the startup gate');
  btTools.noteListed(C, generation);
  activity.onData(C, 'startup frame');
  await sleep(50);
  ok(cw.length === 0, 'a successful list still waits for output to settle');
  await sleep(500);
  ok(cw.length === 2 && cw[0].includes('"since":400') && cw[1] === '\t', 'settled authenticated startup releases one ring with Tab, never Enter');
  activity.onQuestion(C);
  typer.enqueue(C, ROOM, 402, 'Planning', 'user', 'another factual question');
  await sleep(350);
  ok(cw.length === 2, 'a permission prompt still holds after startup');
  btTools.plan(C);
  ok(btTools.listedAt(C, generation) === null, 'replanning clears old readiness');
}
sessions.remove(C);
btTools.drop(C);
const AD = 'recipe:hosted-codex-adopted#1';
const aw = fakePane(AD, 'codex-cli');
typer.enqueue(AD, ROOM, 403, 'Planning', 'user', 'a question after engine restart');
await sleep(300);
ok(aw.length === 2 && aw[1] === '\t', 'an adopted pane with no new launch plan does not deadlock on a second handshake');
sessions.remove(AD);
console.log('\n[hosted tools wait: fixed deadline, visible hold, guarded fallback]');
const FT = 'recipe:hosted-codex-timeout#1';
const fw = fakePane(FT, 'codex-cli');
// Backdate the real launch clock, not the production timeout, to test both sides.
btTools.plan(FT, Date.now() - 30_000 + 450);
typer.enqueue(FT, ROOM, 404, 'Planning', 'user', 'a factual question');
const held = typer.heldFor(FT);
const { heldWord } = await import('../web/held-words.mjs');
ok(held?.reason === 'waiting-for-tools' && heldWord(held) === 'waiting for tools', 'seat visibly says held: waiting for tools');
await sleep(150);
ok(fw.length === 0, 'no tools list: no ring before the fixed thirty-second deadline');
await sleep(650);
ok(fw.length === 2 && fw[1] === '\t', 'no tools list: clock alone releases one ring with Tab after thirty seconds');
sessions.remove(FT); btTools.drop(FT);
const FD = 'recipe:hosted-codex-timeout-dialog#1';
const fdw = fakePane(FD, 'codex-cli');
btTools.plan(FD, Date.now() - 31_000);
activity.onQuestion(FD);
typer.enqueue(FD, ROOM, 405, 'Planning', 'user', 'a factual question');
await sleep(300);
ok(fdw.length === 0, 'expired tools wait never answers a permission dialog');
sessions.remove(FD); btTools.drop(FD);
const DF = 'recipe:hosted-codex-timeout-draft#1';
const dfw = fakePane(DF, 'codex-cli');
btTools.plan(DF, Date.now() - 31_000);
activity.onInput(DF, 'my unsent draft');
typer.enqueue(DF, ROOM, 407, 'Planning', 'user', 'a factual question');
await sleep(300);
ok(dfw.length === 0 && typer.heldFor(DF)?.reason === 'draft', 'expired tools wait never overwrites a draft');
sessions.remove(DF); btTools.drop(DF);
const FR = 'recipe:hosted-codex-timeout-replan#1';
const frw = fakePane(FR, 'codex-cli');
btTools.plan(FR, Date.now() - 30_000 + 200);
typer.enqueue(FR, ROOM, 406, 'Planning', 'user', 'a factual question');
btTools.plan(FR); // old queued timer must re-read the new launch deadline
await sleep(500);
ok(frw.length === 0 && typer.heldFor(FR)?.reason === 'waiting-for-tools', 'old deadline cannot release a replanned launch');
sessions.remove(FR); btTools.drop(FR);
delete process.env.HARBOR_WB_HOSTED;


console.log('\n[HARBOR_WB_DELIVERY=typed forces the old delivery (T1 RED run)]');
process.env.HARBOR_WB_DELIVERY = 'typed';
ok(typer.doorbellOn() === false, 'typed override turns the doorbell off');
process.env.HARBOR_WB_DELIVERY = 'doorbell';

console.log('\n[the engine says who posted a line (author_kind), not the text]');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
const rooms = await import('../src/server/rooms.ts');
ok(rooms.authorKindOf({ author: 'user', author_seat: null }) === 'person' && rooms.authorKindOf({ author: 'voice', author_seat: null }) === 'person', 'the window credential (and the voice actor) is the person');
ok(rooms.authorKindOf({ author: 'auriga', author_seat: 'seat-1' }) === 'agent', 'a seat that posted is an agent');
ok(rooms.authorKindOf({ author: 'room', author_seat: null }) === 'room', 'an engine fact is the room');
ok(rooms.authorKindOf({ author: 'user', author_seat: 'seat-1' }) === 'person', "an agent's body saying '@user:' changes nothing: kind comes from the record (author field), and an agent cannot post with author user");

console.log('\n[a pull is the read]');
const reads = await import('../src/engine/room-reads.ts');
const rs = (id: number): Record<string, string> => (reads.readsFor({ id, room_id: ROOM, ts: 0, kind: 'chat', author: 'user', author_seat: null, target: null, target_seat: null, thread: null, body: null, ref: null, meta: null } as never) ?? {}) as Record<string, string>;
reads.open(ROOM, 900, 'seat-x', 'x', 'recipe:x#1');
ok(Object.values(rs(900))[0] === 'not-yet', 'before the pull: not-yet');
reads.markPulled(ROOM, [900, 901], 'seat-x');
ok(Object.values(rs(900))[0] === 'seen', 'after the agent pulls the line with its token: seen (terminal)');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
