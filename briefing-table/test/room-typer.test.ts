/**
 * W3-interim ROOM TYPER (src/engine/room-typer.ts) [ticket].
 *
 * Pure: frame() and blockReason(). Stateful: the per-pane FIFO driven by the
 * REAL activity machine (onLive / onTurnStart / onResponseDone / onQuestion /
 * onInput) with a fake resident whose pty records writes — no broker, no pty.
 *
 * SAFETY: a temp db via HARBOR_WB_TABLE, set BEFORE any import (the store
 * reads it at module load). Run with tsx.
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'wb-room-typer-'));
process.env.HARBOR_WB_TABLE = join(dir, 'scratch.db');
process.env.HARBOR_WB_ROOM_TYPE_SETTLE_MS = '200';
process.env.HARBOR_WB_VOICE_ENTER_MS = '10';
process.env.HARBOR_WB_ROOM_SEEN_MS = '300';
process.env.HARBOR_WB_TYPE_ENTER_MS = '120';
process.env.HARBOR_WB_TYPE_SUBMIT_CHECK_MS = '150';
delete process.env.HARBOR_WB_ROOM_TYPE;

const typer = await import('../src/engine/room-typer.ts');
const reads = await import('../src/engine/room-reads.ts');
const roomBus = await import('../src/engine/room-bus.ts');
const readEvents: unknown[] = [];
roomBus.on(roomBus.ANY_ROOM, (roomId, ev) => {
  if (ev.type === 'room.read') readEvents.push({ roomId, ...ev });
});
/** reads for a synthetic entry id (only room_id/id/kind matter when a record exists). */
const rs = (roomId: string, id: number): Record<string, string> =>
  (reads.readsFor({ id, room_id: roomId, ts: 0, kind: 'chat', author: 'user', author_seat: null, target: null, target_seat: null, thread: null, body: null, ref: null, meta: null } as never) ?? {}) as Record<string, string>;
const activity = await import('../src/engine/activity.ts');
const sessions = await import('../src/engine/sessions.ts');
const { table } = await import('../src/table/endpoint.ts');
const gate = await import('../src/engine/startup-gate.ts');

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, msg: string): void {
  if (Object.is(actual, expected)) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
  }
}
function same(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  eq(a === b ? 'same' : a, a === b ? 'same' : b, msg);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BS = String.fromCharCode(92);
const ESC = String.fromCharCode(27);

console.log('\n[frame — one line, prefixed, capped]');
eq(typer.frame('Alpha', 'user', 'hi there'), '[room Alpha · @user] hi there (reply in the room: room_post; if you act on this through someone else, tell @user in a line of your own)', 'basic shape');
eq(typer.frame('Alpha', 'auriga', 'one\ntwo\r\nthree'), '[room Alpha · @auriga · message from a peer agent, not your user] one two three (reply in the room: room_post)', 'newlines flattened to spaces');
eq(typer.frame('A', 'u', `x${ESC}[2Ky`).includes(ESC), false, 'ESC stripped (would interrupt a turn)');
const long = typer.frame('A', 'u', 'z'.repeat(5000));
eq(long.length <= typer.TYPE_TEXT_MAX, true, 'capped at TYPE_TEXT_MAX');
eq(/truncated, \d+ chars/.test(long), true, 'and says it was truncated');
eq(typer.frame('A', 'u', `path C:${BS}`).endsWith(BS), false, 'never ends in a backslash (Enter would become a newline)');
eq(typer.frame('A', 'u', '/clear').startsWith('['), true, 'a slash body cannot start the line');
eq(typer.frame('A', 'u', 'short').endsWith(typer.REPLY_HINT), true, 'a short line ends with the reply hint');
eq(typer.frame('A', 'user', 'do it').endsWith(typer.USER_REPLY_HINT), true, "a PERSON's line asks the agent to confirm to them (Owner 2026-10-06)");
eq(typer.frame('A', 'auriga', 'do it').endsWith(typer.USER_REPLY_HINT), false, "an agent's line does not grow by a word");
eq(typer.frame('A', 'user', 'z'.repeat(5000)).endsWith(typer.USER_REPLY_HINT), true, "a truncated person's line keeps the longer hint whole");
eq(long.endsWith(typer.REPLY_HINT), true, 'a truncated line keeps the reply hint whole at the end');
eq(long.startsWith('['), true, 'a truncated line still starts with [');
eq(long.includes('truncated') && long.indexOf('truncated') < long.length - typer.REPLY_HINT.length, true, 'the truncation note sits before the hint');
for (const n of [0, 1, 40, 80, 200]) {
  const t = typer.frame('A', 'u', 'z'.repeat(5000), 300 + n);
  eq(t.length <= 300 + n && t.endsWith(typer.REPLY_HINT), true, `truncated at max ${300 + n}: within max, hint whole`);
}

console.log('\n[blockReason — every guard, in order]');
const base = {
  enabled: true,
  live: true,
  vendor: 'claude-code',
  claude: null,
  startup: false,
  state: 'idle',
  busy: false,
  draft: 'clean' as const,
  now: 10_000,
  lastOutputAt: 5_000,
  settleMs: 1500,
  awaitingIdle: false,
};
eq(typer.blockReason(base), null, 'all hold → type');
eq(typer.blockReason({ ...base, startup: true }), 'startup', 'S0: no evidence yet that claude is past its startup prompts');
eq(typer.blockReason({ ...base, startup: true, draft: 'draft', awaitingIdle: true }), 'startup', 'startup is named ahead of the in-REPL guards');
eq(typer.blockReason({ ...base, startup: true, vendor: 'cli-manager' }), 'vendor', '...but never ahead of vendor (a shell is never typed into at all)');
eq(typer.blockReason({ ...base, enabled: false }), 'off', 'kill switch');
eq(typer.blockReason({ ...base, live: false }), 'not-live', 'no live pty');
eq(typer.blockReason({ ...base, vendor: 'cli-manager' }), 'vendor', 'a shell is never typed into');
eq(typer.blockReason({ ...base, vendor: null }), 'vendor', 'unknown vendor is not claude-code');
eq(typer.blockReason({ ...base, state: 'streaming' }), null, 'streaming: a running reply is typeable (Owner 2026-09-27; claude-code queues it)');
eq(typer.blockReason({ ...base, state: 'streaming', lastOutputAt: 9_000 }), null, '...and its output does not hold it as settling');
eq(typer.blockReason({ ...base, state: 'streaming', busy: true }), 'busy', '...but a dialog inside the turn still holds');
eq(typer.blockReason({ ...base, state: 'waiting' }), 'not-idle', 'waiting (permission prompt / question)');
eq(typer.blockReason({ ...base, state: null }), 'not-idle', 'never seen by the activity machine');
eq(typer.blockReason({ ...base, state: 'background' }), null, 'background (no turn, sub-agents redrawing) is typeable');
eq(typer.blockReason({ ...base, state: 'background', lastOutputAt: 9_000 }), null, '...and its redraws do not hold it as settling');
eq(typer.blockReason({ ...base, state: 'background', busy: true }), 'busy', '...but an in-turn dialog still holds');
eq(typer.blockReason({ ...base, state: 'background', draft: 'draft' }), 'draft', '...and a draft is still never seized');
eq(typer.blockReason({ ...base, busy: true }), 'busy', 'in-turn dialog even if the ring reads idle');
eq(typer.blockReason({ ...base, draft: 'draft' }), 'draft', 'an unsent draft is never seized');
eq(typer.blockReason({ ...base, draft: 'unobserved' }), null, 'unobserved input is not a draft (Assumed)');
eq(typer.blockReason({ ...base, lastOutputAt: 9_000 }), 'settling', 'output 1s ago: settling');
eq(typer.blockReason({ ...base, lastOutputAt: undefined }), null, 'never any output: settled');
eq(typer.blockReason({ ...base, awaitingIdle: true }), 'awaiting-idle', 'one at a time');
eq(typer.blockReason({ ...base, claude: false }), 'no-claude', 'guard 9: claude does not own the terminal');
eq(typer.blockReason({ ...base, claude: true }), null, 'claude owns it → type');
eq(typer.blockReason({ ...base, claude: null }), null, 'could not tell (not the server, EACCES) → deliver as today');
eq(typer.blockReason({ ...base, claude: false, startup: true, draft: 'draft' }), 'no-claude', 'no-claude is named ahead of startup and the in-REPL guards');
eq(typer.blockReason({ ...base, claude: false, vendor: 'cli-manager' }), 'vendor', '...but never ahead of vendor');

console.log('\n[the queue, driven by the real activity machine]');
activity.setOnChange((p, s) => typer.onActivity(p, s));
const logs: string[] = [];
typer.setLog((l) => logs.push(l));

function fakePane(paneid: string, vendor: string): string[] {
  table.upsert({ paneid, recipe_id: null, server: 'local', vendor, agent: null, session_id: null, state: 'live' });
  const writes: string[] = [];
  const cli = { state: 'live', pty: { write: (d: string) => writes.push(d) } };
  sessions.add(paneid, cli as never, null as never);
  activity.onLive(paneid);
  return writes;
}

const P = 'recipe:typer#1';
const w = fakePane(P, 'claude-code');
eq(activity.get(P), 'idle', 'fresh pane is idle');
eq(typer.enqueue(P, 'r1', 1, 'Alpha', 'user', 'first'), 'injected', 'idle, clean, settled → typed at once');
await sleep(40);
eq(w[0], '[room Alpha · @user · #1] first (reply in the room: room_post reply_to 1; if you act on this through someone else, tell @user in a line of your own)', 'the framed line was written to the pty');
eq(w[1], '\r', 'then Enter as its own write');

eq(typer.enqueue(P, 'r1', 2, 'Alpha', 'user', 'second'), 'queued', 'awaiting idle after an inject → queued');
activity.onTurnStart(P); // the typed line started a turn
activity.onResponseDone(P); // … and it ended → idle
await sleep(40);
eq(w[2], '[room Alpha · @user · #2] second (reply in the room: room_post reply_to 2; if you act on this through someone else, tell @user in a line of your own)', 'the next line goes on the next idle transition');

activity.onResponseDone(P);
activity.onTurnStart(P);
activity.onResponseDone(P); // clear awaiting
eq(w.length, 4, 'nothing extra typed with an empty queue');

activity.onInput(P, 'half a tho'); // Owner starts typing
eq(typer.enqueue(P, 'r1', 3, 'Alpha', 'user', 'third'), 'queued', 'a draft holds it');
eq((typer.diag().panes as Record<string, { lastResult: string }>)[P].lastResult, 'held:draft', 'diag says why');
activity.onTurnStart(P);
activity.onResponseDone(P); // idle, but the draft is still there
await sleep(40);
eq(w.length, 4, 'idle with a draft still does not type');
activity.onInput(P, 'ught\r'); // he submits
activity.onTurnStart(P);
activity.onResponseDone(P);
await sleep(40);
eq(w[4], '[room Alpha · @user · #3] third (reply in the room: room_post reply_to 3; if you act on this through someone else, tell @user in a line of your own)', 'after his submit and the next idle, it types');

activity.onResponseDone(P);
activity.onQuestion(P); // a permission prompt
eq(typer.enqueue(P, 'r1', 4, 'Alpha', 'user', 'fourth'), 'queued', 'waiting holds it');
eq(w.length, 6, 'not typed into a prompt');
activity.onResponseDone(P);
await sleep(40);
eq(w[6], '[room Alpha · @user · #4] fourth (reply in the room: room_post reply_to 4; if you act on this through someone else, tell @user in a line of your own)', 'typed once the prompt resolved to idle');

console.log('\n[settle]');
activity.onTurnStart(P);
activity.onResponseDone(P); // the idle after "fourth"
activity.onData(P, 'x'.repeat(50)); // a small repaint just now
eq(typer.enqueue(P, 'r1', 5, 'Alpha', 'user', 'fifth'), 'queued', 'fresh output → settling');
await sleep(350);
eq(w[8], '[room Alpha · @user · #5] fifth (reply in the room: room_post reply_to 5; if you act on this through someone else, tell @user in a line of your own)', 'typed by the settle timer once quiet');

console.log('\n[bounded FIFO, drop-oldest]');
activity.onQuestion(P); // hold everything
for (let i = 0; i < typer.QUEUE_MAX + 3; i++) {
  typer.enqueue(P, 'r1', 100 + i, 'Alpha', 'user', `m${i}`);
}
const dp = (typer.diag().panes as Record<string, { depth: number; dropped: number }>)[P];
eq(dp.depth, typer.QUEUE_MAX + 1, 'depth capped (the queue plus ONE drop note)');
eq(dp.dropped, 3, 'three dropped');
{
  const note = typer.composeDropNote([{ roomId: 'r1', room: 'Alpha', first: 100, n: 3 }]);
  eq(note, '[queue overflow · 3 earlier lines were dropped before you saw them · Read them: room_read(room: "Alpha", since: 99)]', 'the drop note names the count and where to read');
}
eq(logs.some((l) => l.includes('dropped oldest')), true, 'drop logged');
eq(logs.some((l) => /m\d/.test(l)), false, 'no log line carries message content');
eq(JSON.stringify(typer.diag()).includes('m1'), false, 'no diag field carries message content');

console.log('\n[held-batch: pure packBatch / composeBatch]');
{
  eq(typer.composeBatch(['a', 'b'], 1, 2, 'r1'), '[batch · 2 room lines while you were busy] [1 of 2] a  [2 of 2] b', 'header + markers, oldest first');
  eq(typer.composeBatch(['a'], 3, 4, 'fabric'), '[batch · 4 fabric messages while you were busy] [3 of 4] a', 'noun follows the roomId; numbering can start mid-run');
  same(typer.packBatch(['a', 'b', 'c'], 3, 'r1', 1000), [['a', 'b', 'c']], 'everything fits under max: one chunk');

  const long = 'x'.repeat(40); // composed: 1 item 92 chars, 2 items 143, 3 items 194
  const MAX = 150; // fits 2 together, not 3 — forces a real (non-escape-hatch) split
  const chunks = typer.packBatch([long, long, long], 3, 'r1', MAX);
  eq(chunks.length > 1, true, 'oversize splits into more than one delivery');
  eq(chunks.flat().length, 3, 'no line lost across the split');
  eq(chunks.every((c) => c.every((t) => t === long)), true, 'every piece is byte-identical to the original — never truncated');
  let idx = 1;
  for (const c of chunks) {
    eq(typer.composeBatch(c, idx, 3, 'r1').length <= MAX, true, `chunk starting at ${idx} fits under max once composed`);
    idx += c.length;
  }

  const bigItem = 'y'.repeat(200);
  const chunks2 = typer.packBatch([bigItem, 'small'], 2, 'r1', 80);
  same(chunks2, [[bigItem], ['small']], 'a line that cannot fit even alone still goes out alone, untruncated — never dropped');
}

console.log('\n[held-batch: three lines held while busy arrive as ONE delivery; assembled at SEND time, not queue time]');
{
  const LB = 'recipe:batch#late';
  const wl = fakePane(LB, 'claude-code');
  activity.onQuestion(LB); // a permission prompt: holds every queued line
  eq(typer.enqueue(LB, 'rb2', 1, 'Late', 'user', 'one'), 'queued', 'held #1');
  eq(typer.enqueue(LB, 'rb2', 2, 'Late', 'user', 'two'), 'queued', 'held #2');
  /* "a line posted a second before the pane frees must join that same batch"
     (Owner, 2026-09-29): queued right up until the guard clears, in the same
     synchronous call graph as the release below — this proves the batch is
     built by READING the queue at flush time, never from a snapshot taken
     when the first line arrived. */
  eq(typer.enqueue(LB, 'rb2', 3, 'Late', 'user', 'three'), 'queued', 'held #3, added just before release');
  activity.onResponseDone(LB); // releases: flush reads whatever is queued NOW
  await sleep(40);
  eq(wl.length, 2, 'still ONE delivery (text + its Enter) — the late arrival joined it, not a second turn');
  eq(
    wl[0],
    '[batch · 3 room lines while you were busy] [1 of 3] [room Late · @user · #1] one (reply in the room: room_post reply_to 1; if you act on this through someone else, tell @user in a line of your own)  [2 of 3] [room Late · @user · #2] two (reply in the room: room_post reply_to 2; if you act on this through someone else, tell @user in a line of your own)  [3 of 3] [room Late · @user · #3] three (reply in the room: room_post reply_to 3; if you act on this through someone else, tell @user in a line of your own)',
    'all three, including the one queued just before release, in one batch, oldest first',
  );
  eq(typer.heldFor(LB), null, 'nothing left waiting');

  /* the mirror case: a line that arrives AFTER the batch has already been
     sent must be held for the NEXT delivery — never dropped, never folded
     into the batch that already went out. */
  eq(typer.enqueue(LB, 'rb2', 4, 'Late', 'user', 'four'), 'queued', 'after the send: queued for the next round (one delivery still in flight)');
  eq(typer.heldFor(LB)?.depth, 1, 'exactly one held, not merged into the batch already typed');
  activity.onTurnStart(LB);
  activity.onResponseDone(LB);
  await sleep(40);
  eq(wl.length, 4, 'a second, separate delivery');
  eq(wl[2], '[room Late · @user · #4] four (reply in the room: room_post reply_to 4; if you act on this through someone else, tell @user in a line of your own)', 'the late line was typed on its own — never lost');
  sessions.remove(LB);
}

console.log('\n[vendor and kill switch]');
const S = 'recipe:shell#1';
const ws = fakePane(S, 'cli-manager');
eq(typer.enqueue(S, 'r1', 1, 'Alpha', 'user', 'ls'), 'vendor', 'a shell pane is badge-only');
typer.enqueue(S, 'r1', 2, 'Alpha', 'user', 'ls');
eq(logs.filter((l) => l.includes(S) && l.includes('badge only')).length, 1, 'logged once');
eq(ws.length, 0, 'nothing written to the shell');
process.env.HARBOR_WB_ROOM_TYPE = '0';
eq(typer.enqueue(P, 'r1', 9, 'Alpha', 'user', 'x'), 'off', 'HARBOR_WB_ROOM_TYPE=0 → off');
delete process.env.HARBOR_WB_ROOM_TYPE;

console.log('\n[fabric envelopes type through the same guards]');
const F = 'recipe:fab#1';
const wf = fakePane(F, 'claude-code');
const ENV_ID = '01J9ZQ4K7X3M2N8P5R6S7T8V9W-full-envelope-id';
eq(typer.enqueueFabric(F, { id: ENV_ID, from: 'operator-team', kind: 'ask', thread: 'feedface', body: 'ping\nplease' }), 'injected', 'an idle claude pane gets the envelope typed');
eq(wf[0], `[fabric · @operator-team · ask · t:feedface · id:${ENV_ID}] ping please`, 'framed with sender, kind, thread and the FULL envelope id');
activity.onTurnStart(F);
activity.onResponseDone(F); // idle again → the next one may go
await sleep(20);
eq(typer.enqueueFabric(F, { from: 'x', kind: 'notice', body: 'no id' }), 'injected', 'an envelope with no id or thread');
await sleep(20);
eq(wf[2], '[fabric · @x · notice] no id', 'omits both t: and id: rather than printing empties');
eq(typer.enqueueFabric(S, { from: 'x', kind: 'notice', body: 'y' }), 'vendor', 'a shell stays badge-only');
process.env.HARBOR_WB_FABRIC_TYPE = '0';
eq(typer.enqueueFabric(F, { from: 'x', kind: 'notice', body: 'y' }), 'off', 'HARBOR_WB_FABRIC_TYPE=0 → off');
delete process.env.HARBOR_WB_FABRIC_TYPE;
sessions.remove(F);

console.log('\n[held projection + deliver-held: the human says the composer is clear]');
{
  const HD = 'recipe:held#draft';
  const wh = fakePane(HD, 'claude-code');
  eq(typer.heldFor(HD), null, 'nothing waiting → no held field');
  activity.onInput(HD, 'abc');
  activity.onInput(HD, `${ESC}[D`); // ← adds nothing; the composer still holds 3 chars
  typer.enqueue(HD, 'rh', 1, 'Room', 'user', 'one');
  typer.enqueue(HD, 'rh', 2, 'Room', 'user', 'two');
  const h = typer.heldFor(HD);
  eq(h?.reason, 'draft', 'held: reason draft');
  eq(h?.depth, 2, 'held: depth 2');
  eq(typeof h?.since, 'number', 'held: since when');
  eq((typer.diag().panes as Record<string, { held: { reason: string } }>)[HD].held.reason, 'draft', 'diag carries the same held object');
  const dHD = typer.deliverHeld(HD);
  eq(dHD.ok && dHD.result, 'injected', 'draft waived + every other guard holds → typed at once');
  same(dHD.ok && dHD.overrode, ['draft'], '...and the answer names the hold it overrode');
  await sleep(30);
  eq(
    wh[0],
    '[batch · 2 room lines while you were busy] [1 of 2] [room Room · @user · #1] one (reply in the room: room_post reply_to 1; if you act on this through someone else, tell @user in a line of your own)  [2 of 2] [room Room · @user · #2] two (reply in the room: room_post reply_to 2; if you act on this through someone else, tell @user in a line of your own)',
    'held-batch: BOTH queued lines for the same room go out as ONE delivery, not one turn each',
  );
  eq(typer.heldFor(HD), null, 'nothing left waiting — the whole run was delivered together');

  const HB = 'recipe:held#busy';
  fakePane(HB, 'claude-code');
  activity.onInput(HB, 'x');
  activity.onTurnStart(HB);
  typer.enqueue(HB, 'rh', 3, 'Room', 'user', 'three');
  const dHB = typer.deliverHeld(HB);
  eq(dHB.ok && dHB.result, 'injected', 'a running turn no longer holds it: the draft waived, the line is typed mid-reply (Owner 2026-09-27)');
  eq(typer.heldFor(HB), null, 'and nothing is held');

  const HS = 'recipe:held#startup';
  const ws2 = fakePane(HS, 'claude-code');
  gate.arm(HS, { channel: false });
  gate.onPtyData(HS, `${ESC}[2GQuick${ESC}[8Gsafety${ESC}[15Gcheck:${ESC}[22GIs this a project you trust?\r\n ❯ No, exit\r\n Yes, I trust this folder\r\n Enter to confirm`);
  typer.enqueue(HS, 'rh', 4, 'Room', 'user', 'four');
  eq(typer.heldFor(HS)?.reason, 'startup', 'projection: startup');
  const r409 = typer.deliverHeld(HS);
  eq(r409.ok, false, 'guard 4: a trust prompt is CURRENT → refused');
  eq(!r409.ok && r409.reason === 'startup' && r409.prompt, 'trust', '...naming the prompt (409 {prompt, promptAt})');
  eq(!r409.ok && r409.reason === 'startup' && typeof r409.promptAt, 'number', '...and when it was seen');
  eq(ws2.length, 0, 'nothing typed into a pane that may sit on a startup prompt');
  const wrong = typer.deliverHeld(HS, 'old-session');
  eq(!wrong.ok && wrong.reason, 'startup', 'an override naming a DIFFERENT kind is refused');
  eq(gate.isBlocked(HS), true, 'a refusal changes nothing');
  const over = typer.deliverHeld(HS, 'trust');
  eq(over.ok, true, 'the override naming THAT kind waives it');
  same(over.ok && over.overrode, ['startup'], '...and says it overrode startup');
  eq(over.ok && over.prompt, 'trust', '...over a trust prompt');
  eq((gate.diag()[HS] as { clearedBy: string }).clearedBy, 'deliver-held', 'the gate records clearedBy deliver-held');
  await sleep(30);
  eq(ws2[0], '[room Room · @user · #4] four (reply in the room: room_post reply_to 4; if you act on this through someone else, tell @user in a line of your own)', 'typed');

  const HN = 'recipe:held#noprompt';
  const wHN = fakePane(HN, 'claude-code');
  gate.arm(HN, { channel: false });
  typer.enqueue(HN, 'rh', 5, 'Room', 'user', 'five');
  const noPrompt = typer.deliverHeld(HN);
  eq(noPrompt.ok && noPrompt.overrode.join(), 'startup', 'no prompt seen since arm → the startup hold is waived at once');
  await sleep(30);
  eq(wHN[0], '[room Room · @user · #5] five (reply in the room: room_post reply_to 5; if you act on this through someone else, tell @user in a line of your own)', 'typed');
  const HF = 'recipe:held#far';
  const wHF = fakePane(HF, 'claude-code');
  gate.arm(HF, { channel: false });
  gate.onPtyData(HF, 'Enter to confirm' + ' plain output'.repeat(40)); // the prompt is > 400 normalised chars back
  typer.enqueue(HF, 'rh', 6, 'Room', 'user', 'six');
  eq(typer.deliverHeld(HF).ok, true, 'a prompt more than 400 chars back is not current → waived');
  await sleep(30);
  eq(wHF[0], '[room Room · @user · #6] six (reply in the room: room_post reply_to 6; if you act on this through someone else, tell @user in a line of your own)', 'typed');
  /* Review #4/#11: a dev-channels dialog drawn after the watcher TIMED OUT is
     unanswered — one tap must not answer it. */
  const HT = 'recipe:held#late-dev-channels';
  const wHT = fakePane(HT, 'claude-code');
  gate.arm(HT, { channel: true });
  gate.setDialogProbe(() => 'timeout');
  gate.onPtyData(HT, `${ESC}[3GWARNING:${ESC}[12GLoading${ESC}[20Gdevelopment${ESC}[32Gchannels\r\n  ❯ 1. I am using this for local development\r\n  2. Exit\r\n Enter to confirm · Esc to cancel`);
  typer.enqueue(HT, 'rh', 7, 'Room', 'user', 'seven');
  const late = typer.deliverHeld(HT);
  eq(!late.ok && late.reason === 'startup' && late.prompt, 'dev-channels', 'watcher timed out + dev-channels seen → 409 {prompt: dev-channels}, no one-tap release');
  eq(typer.heldFor(HT)?.prompt, 'dev-channels', 'pane.held / occupant.held name it');
  eq(wHT.length, 0, 'nothing typed into the dialog');
  eq(typer.deliverHeld(HT, 'dev-channels').ok, true, 'the override naming it releases');
  /* Review 2 P2 (f3): the same pane before the dialog has drawn at all. */
  const HE = 'recipe:held#early-dev-channels';
  const wHE = fakePane(HE, 'claude-code');
  gate.arm(HE, { channel: true });
  gate.setDialogProbe(() => 'not-seen');
  gate.onPtyData(HE, 'svc-ops@homeserver:~$ claude --resume x --mcp-config y\r\n');
  typer.enqueue(HE, 'rh', 8, 'Room', 'user', 'eight');
  const early = typer.deliverHeld(HE);
  eq(!early.ok && early.reason === 'startup' && early.prompt, 'dev-channels', 'a channel launch whose dialog has not drawn: 409 {prompt: dev-channels}');
  eq(wHE.length, 0, 'nothing typed');
  eq(typer.deliverHeld(HE, 'dev-channels').ok, true, '...one override naming it releases');
  gate.setDialogProbe(() => null);
  for (const p of [HN, HF, HT, HE]) sessions.remove(p);
  eq(JSON.stringify(typer.heldFor(HD)).includes('two'), false, 'the projection never carries message content');
  for (const p of [HD, HB, HS]) sessions.remove(p);
}

console.log('\n[guard 9: no-claude — a fresh /proc read right before each typed write]');
type Read = { pid: number; starttime: number; startedAt: number | null; leader?: boolean } | 'none' | 'not-repl' | null;
const SETTLE = Number(process.env.HARBOR_WB_ROOM_TYPE_SETTLE_MS);
const idleAgain = (p: string) => {
  activity.onTurnStart(p);
  activity.onResponseDone(p);
};
{
  const calls: Array<[string, boolean]> = [];
  let owns: Read = 'none';
  typer.setClaudeProbe((p, cached) => {
    calls.push([p, cached]);
    return owns;
  });
  const NC = 'recipe:held#noclaude';
  const wn = fakePane(NC, 'claude-code');
  eq(typer.enqueue(NC, 'rn', 1, 'Room', 'user', 'echo $(id)'), 'queued', 'claude not owning the tty (bash has it): QUEUED, never typed');
  eq(wn.length, 0, 'nothing reached the pty');
  eq(calls.some(([p, c]) => p === NC && c === false), true, 'the write path asked UNCACHED');
  eq(typer.heldFor(NC)?.reason, 'no-claude', 'held: reason no-claude');
  eq(calls.some(([p, c]) => p === NC && c === true), true, 'the projection (roster, readiness) reads the cache');
  const dnc = typer.deliverHeld(NC);
  eq(!dnc.ok && dnc.reason, 'no-claude', 'deliver-held refuses no-claude (guard 4 never releases it)');
  const dnc2 = typer.deliverHeld(NC, 'trust');
  eq(!dnc2.ok && dnc2.reason, 'no-claude', '...even with an override');
  eq(wn.length, 0, 'nothing typed');
  eq(gate.info(NC)?.origin, 'owner', 'review 2 P1-B (1): the no-claude read ARMED the gate for the next claude');
  owns = null; // not the server / EACCES
  const dnull = typer.deliverHeld(NC);
  eq(!dnull.ok && dnull.reason === 'startup' && dnull.prompt, 'unknown', 'could not tell, but a gate armed for an unwatched claude has seen nothing: 409 {prompt: unknown}');
  calls.length = 0;
  const dnull2 = typer.deliverHeld(NC, 'unknown');
  eq(dnull2.ok && dnull2.result, 'injected', '...the override naming `unknown` delivers (could not tell → deliver as today)');
  eq(calls.filter(([, c]) => c === false).length, 2, 'fresh reads: one by deliver-held, one immediately before the write');
  await sleep(30);
  eq(wn[0], '[room Room · @user · #1] echo $(id) (reply in the room: room_post reply_to 1; if you act on this through someone else, tell @user in a line of your own)', 'typed');
  idleAgain(NC);
  owns = 'none';
  typer.enqueue(NC, 'rn', 3, 'Room', 'user', 'a');
  typer.enqueueFabric(NC, { id: 'e9', from: 'x', kind: 'msg', body: 'b' });
  same(typer.queued(NC), { typed: 1, fabric: 1 }, 'queued(): room lines and fabric envelopes counted apart');
  eq(typer.heldFor(NC)?.detail, undefined, 'bash has the pty: no detail (claude is not running)');
  owns = 'not-repl'; // `claude update` in the foreground (review 2 P2)
  typer.onActivity(NC, 'idle');
  eq(typer.heldFor(NC)?.reason, 'no-claude', 'a claude on the pty that is not its REPL: still held no-claude');
  eq(typer.heldFor(NC)?.detail, 'not-interactive', '...and the hold says a claude IS running, just not as its interactive session');
  const dnr = typer.deliverHeld(NC);
  eq(!dnr.ok && dnr.reason === 'no-claude' && dnr.detail, 'not-interactive', 'deliver-held still refuses it, naming why');
  typer.setClaudeProbe(() => null);
  sessions.remove(NC);
}

console.log('\n[review 2 P1-B: the startup gate watches the claude it is about]');
{
  const OLD = `${ESC}[2GThis session is 3 days old and 254k tokens.\r\n 1. Resume from summary (recommended)\r\n   2. Resume full session as-is\r\n Enter to confirm - Esc to cancel`;
  const COMPOSER = `${ESC}[2m${'-'.repeat(60)}${ESC}[22m\r\n> \r\n${ESC}[2m${'-'.repeat(60)}${ESC}[22m\r\n  ${ESC}[2m?${ESC}[5Gfor${ESC}[9Gshortcuts${ESC}[22m`;
  let owns: Read = null;
  typer.setClaudeProbe(() => owns);
  let pidSeq = 7000;
  const claude = (startedAgoMs: number) => ({ pid: pidSeq++, starttime: pidSeq, startedAt: Date.now() - startedAgoMs });
  const LONG_AGO = 600_000;
  /* Guard 2b: a keystroke is evidence only with 200+ prompt-free chars after
     it — feed some, so each case below still tests the DISTRUST of a key that
     would otherwise count. */
  const KEYED = (p: string) => {
    gate.onHumanInput(p);
    gate.onPtyData(p, '\r\n' + 'drwxr-xr-x 2 svc-ops svc-ops 4096 Sep 25 some-file\r\n'.repeat(5));
  };
  const typed = (w: string[], body: string) => w.some((x) => /^\[room Room · @user · #\d+\] /.test(x) && x.includes(`] ${body} (reply in the room: room_post reply_to `));
  /** A pane whose spawn gate was disarmed by a turn hook, with owner A recorded. */
  const recorded = async (p: string) => {
    const w = fakePane(p, 'claude-code');
    gate.arm(p, { channel: false });
    gate.onHook(p, 'Stop', Date.now() - 300_000);
    owns = claude(LONG_AGO);
    typer.enqueue(p, 'rb', 1, 'Room', 'user', 'first');
    await sleep(30);
    idleAgain(p);
    return { w, A: owns };
  };

  // (1) A recorded; A exits; the none-read arms; B starts and DRAWS ITS COMPOSER.
  const P1 = 'recipe:p1b#healthy';
  const { w: w1 } = await recorded(P1);
  eq(typed(w1, 'first'), true, 'owner A (started before the gate went done): recorded, typed');
  owns = 'none';
  eq(typer.enqueue(P1, 'rb', 2, 'Room', 'user', 'two'), 'queued', 'A gone: held no-claude');
  eq(gate.info(P1)?.origin, 'owner', '(1) the none-read armed a gate for the next claude');
  owns = claude(1500); // B: `claude -c`, started 1.5 s ago
  gate.onPtyData(P1, COMPOSER); // B's first screen — the gate has watched it from its first byte
  await sleep(SETTLE + 80);
  eq(typed(w1, 'two'), true, 'a HEALTHY hand-started claude: its own composer clears the gate — typed with no human (was: held until someone acted)');

  // (1) again, B shows the old-session dialog instead.
  const P2 = 'recipe:p1b#dialog';
  const { w: w2 } = await recorded(P2);
  owns = 'none';
  typer.enqueue(P2, 'rb', 2, 'Room', 'user', 'two');
  owns = claude(1500);
  gate.onPtyData(P2, OLD);
  typer.onActivity(P2, 'idle');
  await sleep(30);
  eq(typed(w2, 'two'), false, 'B on its old-session dialog: nothing typed');
  eq(typer.heldFor(P2)?.reason, 'startup', '...held startup');
  eq(typer.heldFor(P2)?.prompt, 'old-session', '...and the hold NAMES the dialog (it was scanned)');
  const r2 = typer.deliverHeld(P2);
  eq(!r2.ok && r2.reason === 'startup' && r2.prompt, 'old-session', 'deliver-held: 409 old-session, no one-tap answer');

  // (2) the human's `claude -c` + Enter at bash is not evidence about B.
  const P3 = 'recipe:p1b#keystroke';
  const { w: w3 } = await recorded(P3);
  owns = 'none';
  typer.enqueue(P3, 'rb', 2, 'Room', 'user', 'two');
  KEYED(P3); // typing `claude -c` at the bash prompt
  await sleep(20);
  owns = claude(0); // B started after that keystroke, and has drawn nothing yet
  typer.onActivity(P3, 'idle');
  await sleep(SETTLE + 80);
  eq(typed(w3, 'two'), false, '(2) a keystroke from BEFORE the claude started does not clear its gate');
  eq(gate.isBlocked(P3), true, '...held until B draws its composer');
  gate.onPtyData(P3, COMPOSER);
  owns = { ...(owns as object), startedAt: Date.now() - 1000 } as Read; // (same process; its composer ~1 s in)
  await sleep(SETTLE + 80);
  eq(typed(w3, 'two'), true, '...then typed');

  // Review 4: `exec claude …` at the root shell carries the SHELL's pid and
  // start time (a session leader). Never judged by that start time.
  const execd = (shellStartedAgoMs: number) => ({ ...claude(shellStartedAgoMs), leader: true });
  // (a) adopted pane (no gate), first read lands on an exec'd claude on its old-session dialog.
  const PX1 = 'recipe:p1b#exec-adopted';
  const wX1 = fakePane(PX1, 'claude-code');
  sessions.get(PX1)!.spawnedAt = Date.now() - 3_600_000; // adopted an hour ago
  owns = execd(3 * 3_600_000); // "started" 3 h ago — the shell's start
  sessions.pushOutput(sessions.get(PX1)!, OLD);
  typer.enqueue(PX1, 'rb', 1, 'Room', 'user', 'one');
  await sleep(30);
  eq(typed(wX1, 'one'), false, 'exec\'d claude on an adopted pane, dialog up: NOT typed (was: recorded as long-running, typed into the dialog)');
  eq(typer.heldFor(PX1)?.prompt, 'unknown', '...held as `unknown`');
  gate.onPtyData(PX1, OLD); // the dialog, as the armed gate now sees it redrawn
  eq(typer.heldFor(PX1)?.prompt, 'old-session', '...and a dialog it draws names itself');
  // (b) spawned pane whose gate went done on A's hook, owner never recorded (verifier Y2).
  const PX2 = 'recipe:p1b#exec-spawned';
  const wX2 = fakePane(PX2, 'claude-code');
  gate.arm(PX2, { channel: false });
  gate.onHook(PX2, 'Stop');
  owns = execd(60_000); // start = the pane's spawn, before the gate went done
  typer.enqueue(PX2, 'rb', 1, 'Room', 'user', 'one');
  await sleep(30);
  eq(typed(wX2, 'one'), false, 'exec\'d claude on a spawned pane whose gate is done: held');
  gate.onPtyData(PX2, COMPOSER); // its composer, drawn after the arm
  await sleep(SETTLE + 80);
  eq(typed(wX2, 'one'), true, 'exec\'d claude that draws its composer: delivered');
  // (b2) HOSTED direct spawn: claude IS the session leader. The first delivery's fresh read must NOT re-arm the spawn gate as an unwatched owner gate (it would hold a claude
  // that was already seen ready, with no composer left to redraw). Control: the same read off hosted DOES re-arm (the exec'd-by-a-shell case above).
  const reread = async (id: string, hosted: boolean): Promise<string | undefined> => {
    if (hosted) process.env.HARBOR_WB_HOSTED = '1';
    try {
      fakePane(id, 'claude-code');
      gate.arm(id, { channel: false }); // origin: spawn
      gate.onHook(id, 'Stop'); // it has been seen ready (a turn): the gate is DONE
      owns = execd(60_000);
      typer.enqueue(id, 'rb', 1, 'Room', 'user', 'one');
      await sleep(30);
      return gate.info(id)?.origin;
    } finally {
      delete process.env.HARBOR_WB_HOSTED;
    }
  };
  eq(await reread('recipe:p1b#hosted-direct', true), 'spawn', 'hosted direct spawn (leader): the spawn gate is kept, not re-armed unwatched');
  eq(await reread('recipe:p1b#not-hosted-leader', false), 'owner', 'control: off hosted, an exec\'d leader still re-arms the gate unwatched');
  // (c) after a none-read: `exec claude -c` looks "older" (the shell's start) — never dropped.
  const PX3 = 'recipe:p1b#exec-older';
  const { w: wX3 } = await recorded(PX3);
  owns = 'none';
  typer.enqueue(PX3, 'rb', 2, 'Room', 'user', 'two');
  KEYED(PX3); // `exec claude -c` + Enter
  owns = execd(3_600_000); // B = the root bash, exec'd, still loading quietly
  typer.onActivity(PX3, 'idle');
  await sleep(SETTLE + 80);
  eq(typed(wX3, 'two'), false, 'exec\'d claude still loading after a none-read: held (was: gate dropped as "older", typed before its dialog drew)');
  eq(typer.heldFor(PX3)?.reason, 'startup', '...held startup');
  gate.onPtyData(PX3, OLD);
  eq(typer.heldFor(PX3)?.prompt, 'old-session', '...its dialog, when it draws, names itself');

  // Review 3 (re-arm after hook disarm): the none-read gate watched B start,
  // then B's OWN turn hook disarmed it; the next line must not re-arm.
  const PH2 = 'recipe:p1b#hook-after';
  const { w: wH2 } = await recorded(PH2);
  owns = 'none';
  typer.enqueue(PH2, 'rb', 2, 'Room', 'user', 'two');
  owns = claude(1500); // B, started after the none-read armed the gate
  gate.onPtyData(PH2, COMPOSER); // its composer clears the gate...
  activity.onInput(PH2, 'fix the'); // ...but the human is already typing (a draft holds the retry)
  await sleep(SETTLE + 80);
  eq(typed(wH2, 'two'), false, '(held behind the human\'s draft)');
  const logFrom = logs.length;
  activity.onInput(PH2, '\r'); // submits
  activity.onTurnStart(PH2);
  gate.onHook(PH2, 'UserPromptSubmit'); // B's hook: the gate is DONE, after B started
  activity.onResponseDone(PH2);
  await sleep(SETTLE + 80);
  eq(typed(wH2, 'two'), true, 'after B\'s own turn the line is typed');
  eq(logs.slice(logFrom).some((l) => l.includes(PH2) && l.includes('started unwatched')), false, '...with NO "started unwatched" re-arm (the gate done by B\'s hook watched B)');
  eq(gate.info(PH2)?.done, true, '...and the gate stays done');
  /* ...while a gate that went done BEFORE a claude started still arms. */
  const PH3 = 'recipe:p1b#hook-before';
  const { w: wH3 } = await recorded(PH3); // spawn gate done 300 s ago, A recorded
  owns = claude(3000); // B, started long after that hook, no read in between
  typer.enqueue(PH3, 'rb', 2, 'Room', 'user', 'two');
  await sleep(30);
  eq(typed(wH3, 'two'), false, 'a gate done BEFORE the new claude started: armed, held');
  eq(logs.some((l) => l.includes(PH3) && l.includes('started unwatched')), true, '...logged as started unwatched');

  // Review 3 (delayed start): `sleep 2 && claude` — the keystrokes clear the
  // gate, the retry still finds no claude, THEN claude starts and draws.
  const PD = 'recipe:p1b#delayed';
  const { w: wD } = await recorded(PD);
  owns = 'none';
  typer.enqueue(PD, 'rb', 2, 'Room', 'user', 'two');
  KEYED(PD); // `sleep 2 && claude` + Enter at bash
  eq(gate.isBlocked(PD), false, '(the keystrokes cleared the gate)');
  await sleep(SETTLE + 80); // the draft-clean / clear retry runs: claude not exec'd yet
  eq(gate.isBlocked(PD), true, 'a no-claude read sets the shell\'s keystrokes aside: blocked again');
  owns = claude(1200); // claude has started
  gate.onPtyData(PD, COMPOSER); // ...and draws its composer: a blocked → clear EDGE
  await sleep(SETTLE + 80);
  eq(typed(wD, 'two'), true, 'a claude started after a silent pre-command is typed into, with no human (was: pending for good)');

  // older: `fg` of a claude no read ever named (engine restart, never typed into).
  const P4 = 'recipe:p1b#fg-unrecorded';
  const w4 = fakePane(P4, 'claude-code');
  gate.arm(P4, { channel: false });
  gate.onHook(P4, 'Stop', Date.now() - 300_000);
  owns = 'none'; // Ctrl+Z
  typer.enqueue(P4, 'rb', 1, 'Room', 'user', 'one');
  eq(gate.info(P4)?.origin, 'owner', 'suspended: the none-read armed a gate');
  KEYED(P4); // `fg` + Enter at the shell
  owns = claude(LONG_AGO); // fg: a process that started long before it went missing
  typer.onActivity(P4, 'idle');
  await sleep(30);
  eq(typed(w4, 'one'), false, 'review 4: `fg` of an unrecorded older process — the gate is KEPT and the `fg` keystroke set aside (it might be a background load)');
  eq(gate.info(P4)?.origin, 'owner', '...the none-read gate is still there');
  gate.onPtyData(P4, COMPOSER); // CC's SIGCONT handler (handleResume) repaints the whole frame
  await sleep(SETTLE + 80);
  eq(typed(w4, 'one'), true, '...and the returning claude\'s own repaint clears it: typed');

  // Review 3 (clock step): the start time LOOKS older than the none-read (a
  // backward clock step), but the gate has scanned a startup dialog since.
  const TRUST_FRAME = `${ESC}[2GQuick${ESC}[8Gsafety${ESC}[15Gcheck:${ESC}[22GIs this a project you trust?\r\n No, exit\r\n Yes, I trust this folder\r\n Enter to confirm`;
  const PK = 'recipe:p1b#clock-step';
  const { w: wK } = await recorded(PK);
  owns = 'none';
  typer.enqueue(PK, 'rb', 2, 'Room', 'user', 'two');
  owns = claude(5000); // a NEW claude whose start reads 5 s before the none-read
  gate.onPtyData(PK, TRUST_FRAME); // its trust dialog, scanned by the none-read gate
  typer.onActivity(PK, 'idle');
  await sleep(30);
  eq(typed(wK, 'two'), false, 'an "older"-looking owner with a startup dialog on screen: the gate is NOT dropped — nothing typed');
  eq(typer.heldFor(PK)?.prompt, 'trust', '...held, the dialog named');

  // fg of the recorded owner.
  const P5 = 'recipe:p1b#fg-recorded';
  const { w: w5, A: A5 } = await recorded(P5);
  owns = 'none';
  typer.enqueue(P5, 'rb', 2, 'Room', 'user', 'two');
  owns = A5;
  typer.onActivity(P5, 'idle');
  await sleep(30);
  eq(typed(w5, 'two'), true, '`fg` of the recorded owner (same pid+starttime): typed');
  eq(gate.info(P5), null, '...its none-read gate dropped');

  // Review 4: a non-exec'd claude that looks older — `claude -c &` then `fg`
  // while it is still loading — is held, not dropped.
  const PB2 = 'recipe:p1b#bg-load';
  const { w: wB2 } = await recorded(PB2);
  owns = 'none';
  typer.enqueue(PB2, 'rb', 2, 'Room', 'user', 'two');
  KEYED(PB2); // `fg` + Enter
  owns = claude(60_000); // forked a minute ago (before the none-read), still loading
  typer.onActivity(PB2, 'idle');
  await sleep(SETTLE + 80);
  eq(typed(wB2, 'two'), false, 'a background load brought to the foreground: held (was: gate dropped, typed before its dialog)');
  gate.onPtyData(PB2, OLD);
  eq(typer.heldFor(PB2)?.prompt, 'old-session', '...its dialog names itself');

  // Spawn / Restore: a deliver-held while claude has not exec'd yet (verifier S8).
  const P6 = 'recipe:p1b#spawn';
  const w6 = fakePane(P6, 'claude-code');
  gate.arm(P6, { channel: false }); // the spawn
  typer.enqueue(P6, 'rb', 1, 'Room', 'user', 'one');
  owns = 'none';
  const d6 = typer.deliverHeld(P6);
  eq(!d6.ok && d6.reason, 'no-claude', 'deliver-held before claude exec\'d: no-claude');
  eq(gate.info(P6)?.origin, 'spawn', '...and the LIVE spawn gate was not re-armed');
  owns = claude(1000); // the spawned claude, started after the spawn armed its gate
  gate.onPtyData(P6, COMPOSER);
  await sleep(SETTLE + 80);
  eq(typed(w6, 'one'), true, 'the spawn gate watched it start: its composer clears it — typed, no double-arm');

  // Guard 1: an ADOPTED pane's gate, seeded from the replay, meets guard 9's owner check.
  const PA = 'recipe:p1b#adopt-dialog';
  const wA = fakePane(PA, 'claude-code');
  gate.adopt(PA, 'x '.repeat(900) + OLD); // the deploy restart left the old-session dialog up
  owns = claude(LONG_AGO); // running long before this engine adopted it
  typer.enqueue(PA, 'rb', 1, 'Room', 'user', 'one');
  await sleep(30);
  eq(typed(wA, 'one'), false, 'guard 1: an adopted pane on its old-session dialog: nothing typed');
  eq(typer.heldFor(PA)?.prompt, 'old-session', '...held, the dialog named from the replay');
  eq(gate.info(PA)?.origin, 'adopt', '...a first-seen claude that started before adoption is only recorded: the seeded gate stays');
  gate.onPtyData(PA, COMPOSER);
  await sleep(SETTLE + 80);
  eq(typed(wA, 'one'), false, '...a live footer repainted under it, no key: still held (item 2 included)');
  gate.onHumanInput(PA); // Esc
  gate.onPtyData(PA, COMPOSER);
  await sleep(SETTLE + 80);
  eq(typed(wA, 'one'), true, '...Esc, then its composer: typed');
  const PB = 'recipe:p1b#adopt-clear';
  const wB = fakePane(PB, 'claude-code');
  gate.adopt(PB, 'x '.repeat(900) + COMPOSER);
  owns = claude(LONG_AGO);
  typer.enqueue(PB, 'rb', 1, 'Room', 'user', 'one');
  await sleep(30);
  eq(typed(wB, 'one'), true, 'guard 1: an adopted pane whose replay holds no prompt text: typed as before');
  const PC = 'recipe:p1b#adopt-new-claude';
  const wC = fakePane(PC, 'claude-code');
  gate.adopt(PC, 'x '.repeat(900) + COMPOSER); // clear by replay...
  await sleep(20);
  owns = claude(0); // ...but the claude on the pty started AFTER the adoption
  typer.enqueue(PC, 'rb', 1, 'Room', 'user', 'one');
  await sleep(30);
  eq(typed(wC, 'one'), false, 'guard 1: a claude started after adoption — the replay evidence was about the old screen: held');
  gate.onPtyData(PC, COMPOSER);
  await sleep(SETTLE + 80);
  eq(typed(wC, 'one'), true, '...until that claude draws its own composer');

  // (3) A -> B with no read in between, the gate done: arm, UNSEEDED (review 3).
  const late = async (p: string, tail: string) => {
    const { w } = await recorded(p);
    sessions.pushOutput(sessions.get(p)!, tail); // what the replay holds when the line arrives
    owns = claude(3000);
    typer.enqueue(p, 'rb', 2, 'Room', 'user', 'two');
    await sleep(30);
    return w;
  };
  /* The review-3 P1: A's composer footer is still in the replay, then the
     shell and B loading quietly. A seed would have read A's footer as
     evidence about B and typed. */
  const AUTO = `${ESC}[2m${'-'.repeat(60)}${ESC}[22m\r\n> \r\n  ${ESC}[35mauto mode on${ESC}[39m (shift+tab to cycle)`;
  const w7 = await late('recipe:p1b#stale-footer', `${AUTO}\r\nsvc-ops@homeserver:~$ claude -c\r\n`);
  eq(typed(w7, 'two'), false, '(3) the previous claude\'s composer footer in the replay does NOT clear the new claude\'s gate');
  eq(typer.heldFor('recipe:p1b#stale-footer')?.reason, 'startup', '...held startup');
  eq(typer.heldFor('recipe:p1b#stale-footer')?.prompt, 'unknown', '...as `unknown`');
  gate.onPtyData('recipe:p1b#stale-footer', COMPOSER); // B's OWN composer, drawn after the arm
  await sleep(SETTLE + 80);
  eq(typed(w7, 'two'), true, '...until the new claude draws its own composer — then typed');
  const w8 = await late('recipe:p1b#late-dialog', OLD);
  eq(typed(w8, 'two'), false, '(3) a dialog only in the replay: nothing typed');
  eq(typer.heldFor('recipe:p1b#late-dialog')?.prompt, 'unknown', '...held as `unknown` (the replay is never read)');
  gate.onHook('recipe:p1b#late-dialog', 'Stop'); // a matched turn hook also lifts it
  await sleep(SETTLE + 80);
  eq(typed(w8, 'two'), true, 'a matched turn hook lifts an unseeded gate too');
  const w9 = await late('recipe:p1b#late-nothing', 'plain output with nothing to recognise\r\n');
  eq(typed(w9, 'two'), false, '(3) held');
  const d9 = typer.deliverHeld('recipe:p1b#late-nothing');
  eq(!d9.ok && d9.reason === 'startup' && d9.prompt, 'unknown', 'deliver-held: 409 {prompt: unknown} — one tap cannot type into an unseen screen');
  eq(typer.deliverHeld('recipe:p1b#late-nothing', 'unknown').ok, true, '...the override naming it releases');
  await sleep(30);
  eq(typed(w9, 'two'), true, '...typed');

  // Residual: a FIRST-seen owner that started after the gate went done (verifier S5).
  const P10 = 'recipe:p1b#first-after-done';
  const w10 = fakePane(P10, 'claude-code');
  gate.arm(P10, { channel: false });
  gate.onHook(P10, 'Stop', Date.now() - 60_000);
  sessions.pushOutput(sessions.get(P10)!, OLD);
  owns = claude(10_000); // started 50 s after the turn hook that disarmed the gate
  typer.enqueue(P10, 'rb', 1, 'Room', 'user', 'one');
  await sleep(30);
  eq(typed(w10, 'one'), false, 'a first-seen claude that started AFTER the gate went done: armed — nothing typed into its dialog');
  eq(typer.heldFor(P10)?.prompt, 'unknown', '...held as `unknown`');
  const P11 = 'recipe:p1b#first-before-done';
  const w11 = fakePane(P11, 'claude-code');
  gate.arm(P11, { channel: false });
  gate.onHook(P11, 'Stop', Date.now() - 60_000);
  owns = claude(LONG_AGO); // the claude that ran that turn
  typer.enqueue(P11, 'rb', 1, 'Room', 'user', 'one');
  await sleep(30);
  eq(typed(w11, 'one'), true, 'a first-seen claude that started BEFORE: only recorded, typed (no false hold)');

  // Adopted pane (no gate): started after adoption → armed (unseeded); before → recorded (guard 1's).
  const P12 = 'recipe:p1b#adopted-after';
  const w12 = fakePane(P12, 'claude-code');
  sessions.get(P12)!.spawnedAt = Date.now() - 60_000;
  sessions.pushOutput(sessions.get(P12)!, OLD);
  owns = claude(10_000);
  typer.enqueue(P12, 'rb', 1, 'Room', 'user', 'one');
  await sleep(30);
  eq(typed(w12, 'one'), false, 'adopted, claude started after the adoption: held');
  eq(typer.heldFor(P12)?.prompt, 'unknown', '...as `unknown`');
  const P13 = 'recipe:p1b#adopted-before';
  const w13 = fakePane(P13, 'claude-code');
  owns = claude(LONG_AGO);
  typer.enqueue(P13, 'rb', 1, 'Room', 'user', 'one');
  await sleep(30);
  eq(typed(w13, 'one'), true, 'adopted, claude started before the adoption: recorded, typed');

  typer.setClaudeProbe(() => null);
  for (const p of [P1, P2, P3, PX1, PX2, PX3, PB2, PH2, PH3, PD, P4, PK, P5, P6, 'recipe:p1b#stale-footer', 'recipe:p1b#late-dialog', 'recipe:p1b#late-nothing', P10, P11, P12, P13]) sessions.remove(p);
}

console.log('\n[pane.held — the pane\'s own hold, pushed on change only (the solo head)]');
{
  const evs: Array<{ paneid: string; held: unknown }> = [];
  typer.setHeldListener((paneid, held) => evs.push({ paneid, held }));
  const PH = 'recipe:held#events';
  const wph = fakePane(PH, 'claude-code');
  const mine = () => evs.filter((e) => e.paneid === PH).map((e) => e.held as { reason: string; depth: number } | null);
  activity.onInput(PH, 'abc'); // a draft in the composer
  typer.enqueue(PH, 'rp', 1, 'Room', 'user', 'one');
  eq(JSON.stringify(mine().map((h) => h && [h.reason, h.depth])), '[["draft",1]]', 'set: {reason draft, depth 1}');
  typer.enqueue(PH, 'rp', 2, 'Room', 'user', 'two');
  eq(JSON.stringify(mine().map((h) => h && [h.reason, h.depth])), '[["draft",1],["draft",2]]', 'depth change: pushed');
  typer.onActivity(PH, 'idle'); // a retry that changes nothing
  typer.onActivity(PH, 'idle');
  eq(mine().length, 2, 'an identical value is never pushed twice');
  const since = (mine()[1] as { since: number }).since;
  eq(typeof since, 'number', 'the pushed value carries since');
  typer.deliverHeld(PH); // the human waives the draft → held-batch: BOTH queued lines go out together
  eq(JSON.stringify(mine().slice(2).map((h) => h && [h.reason, h.depth])), '[null]', 'both delivered as one batch: cleared at once, no "one at a time" wait in between');
  await sleep(30);
  eq(
    wph[0],
    '[batch · 2 room lines while you were busy] [1 of 2] [room Room · @user · #1] one (reply in the room: room_post reply_to 1; if you act on this through someone else, tell @user in a line of your own)  [2 of 2] [room Room · @user · #2] two (reply in the room: room_post reply_to 2; if you act on this through someone else, tell @user in a line of your own)',
    'the batch was typed as one delivery',
  );
  eq(mine().filter((h) => h === null).length, 1, 'cleared → null, exactly once so far');

  /* a lone line queued right after that delivery still gets the ordinary
     single-line projection (batching only changes what happens when MORE
     THAN ONE line is ready at once) — and still waits for the idle after the
     in-flight delivery, one turn at a time. */
  typer.enqueue(PH, 'rp', 4, 'Room', 'user', 'three');
  eq(mine().slice(-1)[0]?.reason, 'awaiting-idle', 'a lone line right after an inject still waits for the idle');
  activity.onTurnStart(PH);
  eq(mine().slice(-1)[0]?.reason, 'awaiting-idle', '(a turn starting keeps it awaiting the idle: nothing new)');
  activity.onResponseDone(PH);
  await sleep(30);
  eq(wph.length >= 4, true, 'the third line was typed on the idle');
  eq(wph[2], '[room Room · @user · #4] three (reply in the room: room_post reply_to 4; if you act on this through someone else, tell @user in a line of your own)', '...bare, no header — a lone line is unchanged by held-batch');
  eq(mine().slice(-1)[0], null, 'cleared → null again');
  eq(mine().filter((h) => h === null).length, 2, '...twice now');
  for (let i = 1; i < mine().length; i++) {
    if (JSON.stringify(mine()[i]) === JSON.stringify(mine()[i - 1])) eq('dup', 'none', 'no two consecutive pushes are identical');
  }

  const PS = 'recipe:held#events-startup';
  fakePane(PS, 'claude-code');
  gate.arm(PS, { channel: false });
  gate.onPtyData(PS, `${ESC}[2GQuick${ESC}[8Gsafety${ESC}[15Gcheck:${ESC}[22GIs this a project you trust?\r\n ❯ No, exit\r\n Yes, I trust this folder\r\n Enter to confirm`);
  typer.enqueue(PS, 'rp', 3, 'Room', 'user', 'three');
  const hs = evs.filter((e) => e.paneid === PS).slice(-1)[0]?.held as { reason: string; prompt?: string } | undefined;
  eq(hs?.reason, 'startup', 'a startup hold is pushed');
  eq(hs?.prompt, 'trust', '...naming the current prompt kind (prompt?)');
  eq(typer.heldFor(PS)?.prompt, 'trust', 'heldFor (occupant.held, pane.ready) carries the same field');
  typer.setHeldListener(() => {});
  for (const p of [PH, PS]) sessions.remove(p);
}

console.log('\n[a draft going clean in a pane that STAYS idle retries the queue (no activity transition)]');
{
  const HR = 'recipe:held#retry';
  const wr = fakePane(HR, 'claude-code');
  activity.onInput(HR, 'oops');
  eq(typer.enqueue(HR, 'rr2', 1, 'Room', 'user', 'waiting line'), 'queued', 'held behind the draft');
  activity.onInput(HR, '\u007f'.repeat(4)); // he deletes it: net zero, clean — and the pane never left idle
  eq(activity.get(HR), 'idle', '(no activity transition happened)');
  eq(wr.length, 0, 'NOT typed synchronously from the input handler (his keystroke has not reached the pty yet)');
  await sleep(Number(process.env.HARBOR_WB_ROOM_TYPE_SETTLE_MS) + 80);
  eq(wr[0], '[room Room · @user · #1] waiting line (reply in the room: room_post reply_to 1; if you act on this through someone else, tell @user in a line of your own)', 'typed a settle later, by the draft→clean retry');

  const HQ = 'recipe:held#retry-busy';
  const wq = fakePane(HQ, 'claude-code');
  activity.onInput(HQ, 'go');
  typer.enqueue(HQ, 'rr2', 2, 'Room', 'user', 'after the turn');
  activity.onInput(HQ, '\r'); // he SUBMITS: draft → clean, and a turn is about to start
  activity.onTurnStart(HQ); // UserPromptSubmit lands inside the settle
  await sleep(Number(process.env.HARBOR_WB_ROOM_TYPE_SETTLE_MS) + 80);
  eq(wq[0], '[room Room · @user · #2] after the turn (reply in the room: room_post reply_to 2; if you act on this through someone else, tell @user in a line of your own)', 'the deferred retry types it into the starting turn (mid-reply delivery, Owner 2026-09-27)');
  activity.onResponseDone(HQ);
  await sleep(30);
  same(wq, ['[room Room · @user · #2] after the turn (reply in the room: room_post reply_to 2; if you act on this through someone else, tell @user in a line of your own)', '\r'], '...exactly once (text, then its Enter): the idle after the turn types nothing new');
  for (const p of [HR, HQ]) sessions.remove(p);
}

console.log('\n[fabric replays are never re-typed]');
{
  const { isReplayed } = await import('../src/engine/fabric.ts');
  eq(isReplayed({ ack: 'none' }), false, "ack none → first delivery, may type");
  eq(isReplayed({}), false, 'no ack field → may type');
  eq(isReplayed({ ack: 'delivered' }), true, 'ack delivered → replay, badge only');
  eq(isReplayed({ ack: 'seen' }), true, 'ack seen → replay');
}

console.log('\n[pane end drops the queue]');
reads.open('r1', 500, 'seat-p', 'pee', P); // a held line with a read record
activity.onQuestion(P);
typer.enqueue(P, 'r1', 500, 'Alpha', 'user', 'held at the end');
eq(rs('r1', 500).pee, 'not-yet', 'held behind a prompt: not-yet');
sessions.remove(P);
eq((typer.diag().panes as Record<string, unknown>)[P], undefined, 'queue gone with the pane');
eq(rs('r1', 500).pee, 'unknown', 'a line dropped with its pane: unknown (could not tell), never seen');

console.log('\n[read state: seen needs a TURN after the inject (gate G item 2)]');
const R1 = fakePane('recipe:reads#1', 'claude-code');
readEvents.length = 0;
reads.open('rr', 1, 'seat-1', 'one', 'recipe:reads#1');
eq(rs('rr', 1).one, 'not-yet', 'opened: not-yet');
eq(typer.enqueue('recipe:reads#1', 'rr', 1, 'Room', 'user', 'hear this'), 'injected', 'typed at once');
eq(rs('rr', 1).one, 'not-yet', 'injected, no turn yet: still not-yet');
activity.onTurnStart('recipe:reads#1'); // UserPromptSubmit for the typed line
eq(rs('rr', 1).one, 'seen', 'the turn it started is the evidence: seen');
same(readEvents, [
  { roomId: 'rr', type: 'room.read', entryId: 1, handle: 'one', state: 'not-yet' },
  { roomId: 'rr', type: 'room.read', entryId: 1, handle: 'one', state: 'seen' },
], 'one room.read per CHANGE, {entryId, handle, state}');
activity.onResponseDone('recipe:reads#1');
eq(rs('rr', 1).one, 'seen', 'seen is terminal');
eq(R1[0], '[room Room · @user · #1] hear this (reply in the room: room_post reply_to 1; if you act on this through someone else, tell @user in a line of your own)', '(the line really was typed)');

const R2 = 'recipe:reads#2';
fakePane(R2, 'claude-code');
reads.open('rr', 2, 'seat-2', 'two', R2);
typer.enqueue(R2, 'rr', 2, 'Room', 'user', 'no hooks here');
activity.onData(R2, 'y'.repeat(900)); // the byte rule says streaming — but no turn hook
eq(activity.get(R2), 'streaming', '(byte-rule streaming)');
eq(rs('rr', 2).two, 'not-yet', 'byte streaming is NOT evidence (the echo alone can do that)');
await sleep(Number(process.env.HARBOR_WB_ROOM_SEEN_MS) + 120);
eq(rs('rr', 2).two, 'unknown', 'no turn inside the window: unknown, not seen and not not-yet forever');

const R3 = 'recipe:reads#3';
fakePane(R3, 'claude-code');
reads.open('rr', 3, 'seat-3', 'three', R3);
typer.enqueue(R3, 'rr', 3, 'Room', 'user', 'late turn');
await sleep(Number(process.env.HARBOR_WB_ROOM_SEEN_MS) + 120);
activity.onTurnStart(R3); // a turn long after the window: not ours to claim
eq(rs('rr', 3).three, 'unknown', 'a turn OUTSIDE the window is not evidence');

console.log('\n[read state: badge-only, overflow, and a member post]');
reads.open('rr', 4, 'seat-4', 'shell', S);
reads.cannotTell('rr', 4, 'seat-4', 'badge-only');
eq(rs('rr', 4).shell, 'unknown', 'badge-only vendor: unknown');
const bus = await import('../src/engine/room-bus.ts');
const post = (id: number, seat: string | null, kind = 'chat') =>
  bus.emit('rr', { type: 'room.line', entry: { id, room_id: 'rr', ts: Date.now(), kind, author: 'x', author_seat: seat, target: null, target_seat: null, thread: null, body: null, ref: null, meta: null } as never });
post(3, 'seat-4'); // an entry OLDER than #4 — says nothing about #4
eq(rs('rr', 4).shell, 'unknown', 'a post before the entry is not evidence');
post(9, 'seat-4', 'fact');
eq(rs('rr', 4).shell, 'unknown', 'a fact is not a member post');
post(10, 'seat-4');
eq(rs('rr', 4).shell, 'seen', 'the member posted AFTER the entry: seen, whatever the vendor');
eq(rs('rr', 2).two, 'unknown', 'another seat\'s post moves nothing of ours');

const R5 = 'recipe:reads#5';
fakePane(R5, 'claude-code');
activity.onQuestion(R5); // hold everything
for (let i = 0; i < typer.QUEUE_MAX + 1; i++) {
  reads.open('rr', 100 + i, 'seat-5', 'five', R5);
  typer.enqueue(R5, 'rr', 100 + i, 'Room', 'user', `q${i}`);
}
eq(rs('rr', 100).five, 'unknown', 'dropped by the FIFO: unknown');
eq(rs('rr', 101).five, 'not-yet', 'still queued: not-yet');
const rd = reads.diag() as { entries: number; byState: Record<string, number> };
eq(rd.entries > 0 && typeof rd.byState.seen === 'number', true, 'diag: counts by state');
eq(JSON.stringify(reads.diag()).includes('q1'), false, 'diag carries no content');

console.log('\n[read state: no record (engine restarted since) → derived unknown]');
const U = { actor: 'user' as const };
const room = table.createRoom({ name: 'Restarted' }, U).result;
const bob = table.addSeat(room.id, { project: 'bob', handle: 'bob' }, U).result;
table.addSeat(room.id, { project: 'cat', handle: 'cat' }, U);
const [toLead] = table.appendLine(room.id, [{ kind: 'chat', body: 'to the lead', target: null }], U).entries;
const [toRoom] = table.appendLine(room.id, [{ kind: 'chat', body: 'everyone', target: 'room' }], U).entries;
const [fromBob] = table.appendLine(room.id, [{ kind: 'chat', body: 'me', target: 'room' }], { actor: { seatId: bob.id } }).entries;
same(reads.readsFor(toLead), { bob: 'unknown' }, 'un-addressed: the lead at write time, unknown');
same(reads.readsFor(toRoom), { bob: 'unknown', cat: 'unknown' }, '@room: every seat active then, unknown');
same(reads.readsFor(fromBob), { cat: 'unknown' }, 'never the author\'s own seat');
const facts = table.listLine(room.id, { kind: 'fact' });
eq(facts.length > 0 && facts.every((f) => reads.readsFor(f) === undefined), true, 'a Room fact has no reads (field absent)');

console.log('\n[ticket: gemini-cli joins the typed vendors — same room-typer guards, its own screen gate]');
{
  const gate = await import('../src/engine/gemini-gate.ts');
  const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gemini-gate');
  const gchunk = (name: string): string => (JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8')) as { chunk: string }).chunk;

  console.log('\n  [idle -> typed at once, same as a claude pane]');
  const G1 = 'recipe:gemini#idle';
  const wg1 = fakePane(G1, 'gemini-cli');
  gate.arm(G1);
  gate.onPtyData(G1, gchunk('idle'));
  eq(typer.enqueue(G1, 'g1', 1, 'Alpha', 'user', 'hi gemini'), 'injected', 'idle, no draft, settled → typed at once');
  await sleep(40);
  eq(wg1[0], '[room Alpha · @user · #1] hi gemini (reply in the room: room_post reply_to 1; if you act on this through someone else, tell @user in a line of your own)', 'the framed line was written to the pty');
  eq(wg1[1], '\r', 'then Enter as its own write');
  sessions.remove(G1);

  console.log('\n  [not-ready before the composer has ever drawn: held, never typed]');
  const G2 = 'recipe:gemini#notready';
  const wg2 = fakePane(G2, 'gemini-cli');
  gate.arm(G2); // armed, but no onPtyData yet — no evidence the TUI is up
  eq(typer.enqueue(G2, 'g2', 1, 'Alpha', 'user', 'too early'), 'queued', 'not-ready holds it (reused as TypeBlock "startup")');
  eq(wg2.length, 0, 'nothing typed');
  eq(typer.heldFor(G2)?.reason, 'startup', 'held: reason startup (shared name, gemini meaning)');
  const dNR = typer.deliverHeld(G2); // no evidence has drawn yet — the human's override is what lifts it
  eq(dNR.ok && dNR.result, 'injected', 'a human at the window is positive evidence — waived at once, like claude\'s "no prompt seen since arm"');
  await sleep(30);
  eq(wg2[0], '[room Alpha · @user · #1] too early (reply in the room: room_post reply_to 1; if you act on this through someone else, tell @user in a line of your own)', 'typed');
  sessions.remove(G2);

  console.log('\n  [busy (generating): held — unlike claude\'s streaming, never typeable for this vendor]');
  const G3 = 'recipe:gemini#busy';
  const wg3 = fakePane(G3, 'gemini-cli');
  gate.arm(G3);
  gate.onPtyData(G3, gchunk('idle'));
  gate.onPtyData(G3, gchunk('busy'));
  eq(typer.enqueue(G3, 'g3', 1, 'Alpha', 'user', 'while thinking'), 'queued', 'busy holds it (reused as TypeBlock "not-idle")');
  eq(wg3.length, 0, 'nothing typed while generating');
  eq(typer.heldFor(G3)?.reason, 'not-idle', 'held: reason not-idle');
  gate.onPtyData(G3, gchunk('idle')); // the turn ends
  typer.onActivity(G3, 'idle');
  await sleep(40);
  eq(wg3[0], '[room Alpha · @user · #1] while thinking (reply in the room: room_post reply_to 1; if you act on this through someone else, tell @user in a line of your own)', 'typed once the turn ends and the composer redraws idle');
  sessions.remove(G3);

  console.log('\n  [a tool-approval dialog holds it; deliver-held refuses without the matching override]');
  const G4 = 'recipe:gemini#dialog';
  const wg4 = fakePane(G4, 'gemini-cli');
  gate.arm(G4);
  gate.onPtyData(G4, gchunk('idle'));
  gate.onPtyData(G4, gchunk('dialog-proceed'));
  eq(typer.enqueue(G4, 'g4', 1, 'Alpha', 'user', 'do the thing'), 'queued', 'a dialog holds it (reused as TypeBlock "busy")');
  eq(typer.heldFor(G4)?.reason, 'busy', 'held: reason busy');
  eq(typer.heldFor(G4)?.prompt, 'proceed', 'projection names the dialog kind (gemini-gate.dialogKindOf, same field claude uses for its prompt kind)');
  const refused = typer.deliverHeld(G4);
  eq(!refused.ok && refused.reason === 'startup' && refused.prompt, 'proceed', 'refused, naming the dialog (the shared 409 shape claude\'s startup prompts use)');
  eq(wg4.length, 0, 'nothing typed into the dialog');
  const wrongOverride = typer.deliverHeld(G4, 'auth');
  eq(!wrongOverride.ok && wrongOverride.reason, 'startup', 'an override naming the WRONG kind is still refused');
  const rightOverride = typer.deliverHeld(G4, 'proceed');
  eq(rightOverride.ok, true, 'the override naming the actual dialog kind releases it');
  await sleep(30);
  eq(wg4[0], '[room Alpha · @user · #1] do the thing (reply in the room: room_post reply_to 1; if you act on this through someone else, tell @user in a line of your own)', 'typed');
  sessions.remove(G4);

  console.log('\n  [the auth/login screen holds it the same way, kind "auth"]');
  const G5 = 'recipe:gemini#auth';
  const wg5 = fakePane(G5, 'gemini-cli');
  gate.arm(G5);
  gate.onPtyData(G5, gchunk('dialog-auth'));
  eq(typer.enqueue(G5, 'g5', 1, 'Alpha', 'user', 'x'), 'queued', 'the login screen holds it too');
  eq(typer.heldFor(G5)?.prompt, 'auth', 'named auth, not proceed');
  eq(typer.deliverHeld(G5, 'proceed').ok, false, 'the wrong kind refuses');
  eq(typer.deliverHeld(G5, 'auth').ok, true, 'the right kind releases');
  sessions.remove(G5);

  console.log('\n  [a draft in the composer holds a gemini pane exactly like a claude pane]');
  const G6 = 'recipe:gemini#draft';
  const wg6 = fakePane(G6, 'gemini-cli');
  gate.arm(G6);
  gate.onPtyData(G6, gchunk('idle'));
  activity.onInput(G6, 'half a tho'); // the SAME generic keystroke classifier claude uses
  eq(typer.enqueue(G6, 'g6', 1, 'Alpha', 'user', 'held behind the draft'), 'queued', 'a draft holds it, vendor-agnostic (activity.ts)');
  eq(typer.heldFor(G6)?.reason, 'draft', 'held: reason draft');
  eq(wg6.length, 0, 'nothing typed');
  activity.onInput(G6, 'ught\r'); // he submits — draft goes clean
  await sleep(Number(process.env.HARBOR_WB_ROOM_TYPE_SETTLE_MS) + 80);
  eq(wg6[0], '[room Alpha · @user · #1] held behind the draft (reply in the room: room_post reply_to 1; if you act on this through someone else, tell @user in a line of your own)', 'typed once the draft clears (the same draft->clean retry claude panes use)');
  sessions.remove(G6);

  console.log('\n  [held-batch: lines held while busy arrive as ONE delivery, same as claude]');
  const G7 = 'recipe:gemini#batch';
  const wg7 = fakePane(G7, 'gemini-cli');
  gate.arm(G7);
  gate.onPtyData(G7, gchunk('busy')); // holds every queued line
  eq(typer.enqueue(G7, 'g7', 1, 'Room', 'user', 'one'), 'queued', 'held #1');
  eq(typer.enqueue(G7, 'g7', 2, 'Room', 'user', 'two'), 'queued', 'held #2');
  gate.onPtyData(G7, gchunk('idle')); // the turn ends
  typer.onActivity(G7, 'idle');
  await sleep(40);
  eq(wg7.length, 2, 'one delivery (text + its Enter), not two turns');
  eq(
    wg7[0],
    '[batch · 2 room lines while you were busy] [1 of 2] [room Room · @user · #1] one (reply in the room: room_post reply_to 1; if you act on this through someone else, tell @user in a line of your own)  [2 of 2] [room Room · @user · #2] two (reply in the room: room_post reply_to 2; if you act on this through someone else, tell @user in a line of your own)',
    'both lines in one batch, oldest first — exactly the claude held-batch shape',
  );
  sessions.remove(G7);

  console.log('\n  [pane end drops the gemini-gate too]');
  const G8 = 'recipe:gemini#end';
  fakePane(G8, 'gemini-cli');
  gate.arm(G8);
  gate.onPtyData(G8, gchunk('idle'));
  eq(gate.state(G8), 'idle', 'idle before the pane ends');
  sessions.remove(G8);
  eq(gate.state(G8), 'not-ready', 'sessions.onRemove wiring: gemini-gate.drop() ran, reads not-ready again');

  console.log('\n  [still badge-only: gemini-cli in TYPE_VENDORS never widens who else is typeable]');
  eq(typer.enqueue(S, 'g9', 1, 'Alpha', 'user', 'ls'), 'vendor', 'a plain cli-manager shell is still never typed into');
}

console.log('\n[ticket: a pane whose screen needs the human holds its lines as needs-you, never typed]');
{
  const pb = await import('../src/engine/prompt-block.ts');
  const PB = 'recipe:typer#needs-you';
  const wb = fakePane(PB, 'claude-code');
  pb.arm(PB, 'claude-code');
  pb.onPtyData(PB, '⎿ Not logged in · Please run /login'); // CC 2.1.285's error line, captured
  eq(activity.get(PB), 'waiting', 'the ring reads waiting');
  eq(typer.enqueue(PB, 'nb', 1, 'Alpha', 'user', 'are you there'), 'queued', 'a line to it is held');
  eq(typer.heldFor(PB)?.reason, 'needs-you', 'held: reason needs-you');
  eq(typer.heldFor(PB)?.blocked, 'login', '...naming the prompt: login');
  activity.ack(PB, 'input'); // a human looked, the ring quiets to idle...
  const d = typer.deliverHeld(PB); // ...and says "deliver"
  eq(d.ok && d.result, 'held:needs-you', 'deliver-held never waives it: a typed line + Enter would answer the prompt');
  await sleep(40);
  eq(wb.length, 0, 'nothing was typed into the prompt');
  pb.onPtyData(PB, 'Login successful. Press Enter to continue…');
  await sleep(400); // retrySoon waits one settle period (200 ms in this suite)
  eq(wb[0], '[room Alpha · @user · #1] are you there (reply in the room: room_post reply_to 1; if you act on this through someone else, tell @user in a line of your own)', 'cleared: the held line is typed a settle later');
  sessions.remove(PB);
  eq(pb.get(PB), null, 'pane end drops its prompt-block entry');
}


{
  console.log('\n[codex typer: paste + Tab, QUEUES WHILE BUSY - Owner 2026-10-06, live r20B/r20C on video-to-3d]');
  const CX = 'recipe:codex-typer#1';
  table.upsert({ paneid: CX, recipe_id: null, server: 'local', vendor: 'codex-cli', agent: null, session_id: null, state: 'live' });
  const cw: Array<{ t: number; d: string }> = [];
  sessions.add(CX, { state: 'live', pty: { write: (d: string) => cw.push({ t: Date.now(), d }) } } as never, null as never);
  activity.onLive(CX);
  activity.noteHook(CX);
  const PON = ESC + '[200~';
  const POFF = ESC + '[201~';
  const HINT = ' (reply in the room: room_post reply_to 1; if you act on this through someone else, tell @user in a line of your own)';
  eq(typer.enqueue(CX, 'cx', 1, 'Alpha', 'user', 'first'), 'injected', 'idle codex pane: typed at once');
  eq(cw[0]?.d, PON + '[room Alpha · @user · #1] first' + HINT + POFF, 'the text is ONE bracketed paste, closed');
  eq(cw.length, 1, 'no submit key in the same write');
  await sleep(250);
  eq(cw[1]?.d, '\t', 'the submit key is TAB (submits when idle, queues mid-turn), its own write');
  eq((cw[1]?.t ?? 0) - (cw[0]?.t ?? 0) >= 100, true, 'it comes after the pause (>=100 ms of the 120)');

  // a turn running (streaming output, turn started): the next line is NOT held
  activity.onTurnStart(CX);
  activity.onData(CX, 'x'.repeat(800));
  await sleep(50);
  eq(typer.enqueue(CX, 'cx', 2, 'Alpha', 'user', 'second'), 'injected', 'mid-turn: typed straight into Codex\'s queue, not held');
  await sleep(250);
  eq(cw.filter((c) => c.d.includes('second')).length, 1, 'delivered exactly once');
  eq(cw.filter((c) => c.d === '\r').length, 0, 'never an Enter (an Enter mid-turn would steer the running turn)');
  eq(cw.filter((c) => c.d === '\t').length, 2, 'one Tab per line, no retry');
  activity.onResponseDone(CX); // [one queued] the running turn COMPLETED: Codex takes the queued line now

  // what still holds: a draft in the box, and a permission prompt
  activity.onInput(CX, 'half typed');
  eq(typer.enqueue(CX, 'cx', 3, 'Alpha', 'user', 'third'), 'queued', 'a draft in the box still holds');
  eq(typer.heldFor(CX)?.reason, 'draft', '...and says so');
  activity.onInput(CX, '\r');
  await sleep(400);
  eq(cw.filter((c) => c.d.includes('third')).length, 1, 'the box cleared: delivered');
  activity.onQuestion(CX);
  eq(typer.enqueue(CX, 'cx', 4, 'Alpha', 'user', 'fourth'), 'queued', 'a permission prompt (waiting) still holds: Tab must never answer it');

  // two rooms' lines waiting: each run goes out in turn, with no idle in between
  activity.onInput(CX, ESC + '[2J'); // (reset the question state the prompt left: a fresh pane instead)
  sessions.remove(CX);
  const CY = 'recipe:codex-typer#2';
  table.upsert({ paneid: CY, recipe_id: null, server: 'local', vendor: 'codex-cli', agent: null, session_id: null, state: 'live' });
  const cyw: string[] = [];
  sessions.add(CY, { state: 'live', pty: { write: (d: string) => cyw.push(d) } } as never, null as never);
  activity.onLive(CY);
  activity.onInput(CY, 'x'); // a draft holds everything while both rooms queue up
  typer.enqueue(CY, 'roomA', 10, 'A', 'user', 'a1');
  typer.enqueue(CY, 'roomB', 11, 'B', 'user', 'b1');
  typer.enqueue(CY, 'roomA', 12, 'A', 'user', 'a2');
  activity.onInput(CY, ''); // box empty again
  activity.onData(CY, 'x'.repeat(800)); // and it keeps streaming: no idle ever comes
  await sleep(1500);
  eq(['a1', 'b1', 'a2'].every((t) => cyw.some((d) => d.includes(t))), true, 'all three delivered with no idle in between');
  eq(cyw.filter((d) => d === '	').length, 1, '[one queued] as ONE batch across both rooms: one Tab, one turn');
  eq(cyw.some((d) => d.includes('messages while you were busy')), true, '...headed as messages (it spans rooms)');
  sessions.remove(CY);

  typer.setLog(() => undefined);
  const clw = fakePane('recipe:claude-unchanged#1', 'claude-code');
  typer.enqueue('recipe:claude-unchanged#1', 'cl', 1, 'Alpha', 'user', 'hi');
  await sleep(40);
  eq(clw[0], '[room Alpha · @user · #1] hi' + HINT, 'claude: raw text, no paste markers');
  eq(clw[1], '\r', 'claude: Enter a beat later, as before');
}


{
  console.log('\n[codex typer: never a second paste before the previous Tab (type lock) - 2026-10-06]');
  {
    const CL = 'recipe:codex-lock#1';
    table.upsert({ paneid: CL, recipe_id: null, server: 'local', vendor: 'codex-cli', agent: null, session_id: null, state: 'live' });
    const lw: string[] = [];
    sessions.add(CL, { state: 'live', pty: { write: (d: string) => lw.push(d) } } as never, null as never);
    activity.onLive(CL);
    typer.enqueue(CL, 'rl', 1, 'R', 'user', 'L1');
    typer.enqueue(CL, 'rl', 2, 'R', 'user', 'L2');
    typer.enqueue(CL, 'rl', 3, 'R', 'user', 'L3');
    await sleep(1400);
    const kinds = lw.map((d) => (d === '\t' ? 'T' : 'P'));
    eq(kinds.join(''), 'PTPT', 'paste, Tab, paste, Tab: the 2nd and 3rd went as ONE batch after the first Tab');
    eq(lw[2]?.includes('L2') && lw[2]?.includes('L3'), true, 'the batch holds both');
    sessions.remove(CL);
  }

  console.log('\n[codex typer: a pane with no hooks is typed the same way (no idle needed) - 2026-10-06]');
  const HX = 'recipe:codex-nohook#1';
  table.upsert({ paneid: HX, recipe_id: null, server: 'local', vendor: 'codex-cli', agent: null, session_id: null, state: 'live' });
  const hw: string[] = [];
  sessions.add(HX, { state: 'live', pty: { write: (d: string) => hw.push(d) } } as never, null as never);
  activity.onLive(HX);
  activity.onData(HX, 'x'.repeat(800)); // Codex redraws constantly: it never reads idle
  eq(activity.hookSeen(HX), false, 'no hook seen');
  eq(typer.enqueue(HX, 'hx', 1, 'Alpha', 'user', 'one'), 'injected', 'typed while it streams (the operator case: 15 lines held "not-idle" for minutes)');
  process.env.HARBOR_WB_QUEUE_HOLD_MS = '600';
  eq(typer.enqueue(HX, 'hx', 2, 'Alpha', 'user', 'two'), 'queued', 'the next waits: one already sits in Codex\'s queue');
  await sleep(300);
  eq(hw.filter((d) => d === '\t').length, 1, '[one queued] no hooks and never idle: still just the one');
  eq(typer.heldFor(HX)?.reason, 'one-queued', '...and says why');
  await sleep(1100);
  eq(hw.filter((d) => d === '\t').length, 2, 'the hold runs out: the rest goes');
  delete process.env.HARBOR_WB_QUEUE_HOLD_MS;
  sessions.remove(HX);

  console.log('\n[one queued: the person first, the rest as ONE batch once the queued one is taken - Owner 2026-10-06]');
  const OQ = 'recipe:codex-onequeued#1';
  table.upsert({ paneid: OQ, recipe_id: null, server: 'local', vendor: 'codex-cli', agent: null, session_id: null, state: 'live' });
  const ow: string[] = [];
  sessions.add(OQ, { state: 'live', pty: { write: (d: string) => ow.push(d) } } as never, null as never);
  activity.onLive(OQ);
  activity.noteHook(OQ);
  activity.onTurnStart(OQ);
  activity.onData(OQ, 'x'.repeat(800)); // a turn running
  eq(typer.enqueue(OQ, 'r1', 1, 'Dev', 'alpha-blender', 'ack me'), 'injected', 'mid-turn: one line into Codex\'s queue');
  await sleep(400);
  typer.enqueue(OQ, 'r1', 2, 'Dev', 'alpha-blender', 'note A');
  typer.enqueue(OQ, 'fabric', 0, 'fabric', 'x', 'dm B');
  typer.enqueue(OQ, 'r2', 3, 'Studio', 'user', 'stand down');
  await sleep(400);
  eq(ow.filter((d) => d === '\t').length, 1, 'three more arrive: nothing typed while the first still waits in its queue');
  activity.onTurnStart(OQ); // a NEW turn starting (the person typed a prompt) is not readiness
  typer.onActivity(OQ, 'streaming');
  await sleep(500);
  eq(ow.filter((d) => d === '\t').length, 1, '[FIX 3] a turn STARTING does not release the hold (hooks work: wait for the turn to complete)');
  eq(typer.heldFor(OQ)?.reason, 'one-queued', '...still held one-queued');
  activity.onResponseDone(OQ); // the turn the queued line waited behind COMPLETED: Codex took it
  await sleep(700);
  const batch = ow.find((d, i) => i > 1 && d !== '\t') ?? '';
  eq(ow.filter((d) => d === '\t').length, 2, 'then ONE delivery for all three');
  eq(batch.indexOf('stand down') >= 0 && batch.indexOf('stand down') < batch.indexOf('note A') && batch.indexOf('stand down') < batch.indexOf('dm B'), true, 'the person\'s line first');
  eq(typer.fromPerson('[room S · @alpha-studio] From Owner, in his words: "stop"'), true, 'a relay of the person\'s words counts as theirs');
  sessions.remove(OQ);

  console.log('\n[agent comms: codexOneQueued off = the pre-10-06 queue (no hold, no person-first, no cross-room batch)]');
  table.setEngineSetting('agentComms', { codexOneQueued: false });
  const NX = 'recipe:codex-oq-off#1';
  table.upsert({ paneid: NX, recipe_id: null, server: 'local', vendor: 'codex-cli', agent: null, session_id: null, state: 'live' });
  const nw: string[] = [];
  sessions.add(NX, { state: 'live', pty: { write: (d: string) => nw.push(d) } } as never, null as never);
  activity.onLive(NX);
  activity.onData(NX, 'x'.repeat(800)); // never idle, no hooks: the one-queued hold would hold this pane
  eq(typer.enqueue(NX, 'nx', 1, 'Alpha', 'user', 'one'), 'injected', 'the first is typed');
  typer.enqueue(NX, 'nx', 2, 'Alpha', 'agent-x', 'two');
  typer.enqueue(NX, 'nx2', 3, 'Beta', 'user', 'three');
  await sleep(2200);
  const pastes = nw.filter((d) => d !== '\t');
  eq(nw.filter((d) => d === '\t').length, 3, 'each run typed as soon as the previous Tab is in: three deliveries');
  eq(pastes[1]?.includes('two') && pastes[2]?.includes('three'), true, 'in arrival order, one room per delivery (no person-first reorder)');
  eq(typer.heldFor(NX)?.reason === 'one-queued', false, 'never held one-queued');
  table.setEngineSetting('agentComms', null);
  sessions.remove(NX);
}

{
  /* Codex delivery review 2026-10-07 (KB design-notes-id): labelled batches, a steer
     path for control lines, readiness = the turn COMPLETED. */
  const TAB = String.fromCharCode(9);
  const CR = String.fromCharCode(13);
  const T0 = Date.UTC(2026, 9, 7, 14, 5);
  const codexPane = (id: string, hooks: boolean): string[] => {
    const wr = fakePane(id, 'codex-cli');
    if (hooks) activity.noteHook(id);
    return wr;
  };

  console.log('\n[FIX 1: labels + order per thread (pure)]');
  eq(typer.labelOf({ thread: 'room Dev', from: 'blender', msgId: 'line 7', ts: T0, replyNeeded: false }), 'room Dev · @blender · line 7 · 14:05Z · fyi', 'room line label: thread, sender, id, time, fyi');
  eq(typer.labelOf({ thread: 't:th-9', from: 'peer', msgId: 'id:ENV-1', replyNeeded: true }), 't:th-9 · @peer · id:ENV-1 · reply needed', 'fabric ask label says reply needed');
  eq(typer.labelOf({}), '', 'an already-composed text carries no label');
  eq(typer.composeBatch(['a', 'b'], 1, 2, 'mixed', ['L1', '']), '[batch · 2 messages while you were busy] [1 of 2 · L1] a  [2 of 2] b', 'a label rides inside its marker');
  const it = (roomId: string, n: number, from: string, thread?: string) => ({ roomId, entryId: n, text: `x${n}`, from, ...(thread ? { thread } : {}) });
  same(
    typer.orderQueued([it('rA', 1, 'agent-a'), it('fabric', 0, 'peer', 't:T'), it('rA', 2, 'user'), it('rB', 3, 'agent-b'), it('rB', 4, 'user')]).map((x) => x.text),
    ['x1', 'x2', 'x3', 'x4', 'x0'],
    "threads holding the person's lines go first, whole: an older line of a thread never lands after a newer one",
  );
  same(typer.orderQueued([it('fabric', 0, 'p', 't:A'), it('fabric', 1, 'q', 't:B'), it('fabric', 2, 'p', 't:A')]).map((x) => x.text), ['x0', 'x2', 'x1'], 'fabric threads group by thread, arrival order within');
  const longT = 'y'.repeat(710);
  eq(typer.packBatch([longT, longT, longT], 3, 'mixed', 1500).length, 2, 'unlabelled: two of these fit one delivery');
  eq(typer.packBatch([longT, longT, longT], 3, 'mixed', 1500, ['lab one', 'lab two', 'lab three']).length, 3, 'labels count toward TYPE_TEXT_MAX: packBatch splits on them');

  console.log('\n[FIX 1: a codex batch is labelled and ordered per thread]');
  const LB = 'recipe:codex-label#1';
  const lw = codexPane(LB, true);
  activity.onTurnStart(LB);
  activity.onData(LB, 'x'.repeat(800));
  eq(typer.enqueue(LB, 'rz', 1, 'Zed', 'agent-z', 'first'), 'injected', 'one line into the running turn\'s queue');
  await sleep(300);
  typer.enqueue(LB, 'rr', 2, 'Rome', 'agent-a', 'older agent line', false, { ts: T0, replyNeeded: false });
  typer.enqueueFabric(LB, { id: 'ENV-ASK-1', from: 'peer', kind: 'ask', thread: 'th-1', body: 'which file?', ts: new Date(T0).toISOString() });
  typer.enqueue(LB, 'rr', 3, 'Rome', 'user', 'newer person line', false, { ts: T0 + 60_000, replyNeeded: true });
  typer.enqueue(LB, 'rs', 4, 'Sofia', 'agent-s', 'sofia line', false, { ts: T0, replyNeeded: false });
  await sleep(300);
  eq(lw.filter((d) => d === TAB).length, 1, 'held one-queued while the first waits');
  activity.onResponseDone(LB);
  await sleep(700);
  const lb = lw.filter((d) => d !== TAB).at(-1) ?? '';
  const at = (s: string) => lb.indexOf(s);
  eq(lw.filter((d) => d === TAB).length, 2, 'the turn completed: ONE labelled batch');
  eq(at('older agent line') >= 0 && at('older agent line') < at('newer person line'), true, "the person's thread first, but its older line stays before the newer one");
  eq(at('newer person line') < at('which file?') && at('which file?') < at('sofia line'), true, 'then the other threads in arrival order');
  eq(lb.includes('[1 of 4 · room Rome · @agent-a · line 2 · 14:05Z · fyi]'), true, 'room line label: thread, sender, id, time, fyi');
  eq(lb.includes('[2 of 4 · room Rome · @user · line 3 · 14:06Z · reply needed]'), true, 'a line addressed to it: reply needed');
  eq(lb.includes('[3 of 4 · t:th-1 · @peer · id:ENV-ASK-1 · 14:05Z · reply needed]'), true, 'a fabric ask: full id, thread, reply needed');
  eq(lb.length <= 1500, true, 'within TYPE_TEXT_MAX');
  sessions.remove(LB);

  console.log('\n[FIX 2: a STOP steers into the running turn, past the one-queued hold]');
  eq(typer.isStopLine('stop'), true, '"stop"');
  eq(typer.isStopLine('@codex @lead Stop! now'), true, 'leading @mentions skipped, punctuation and case ignored');
  eq(typer.isStopLine('HALT the render'), true, '"halt"');
  eq(typer.isStopLine('please stop'), false, 'conservative: stop must be the first word');
  eq(typer.isStopLine('stopping soon'), false, '"stopping" is not a stop');
  const ST = 'recipe:codex-steer#1';
  const sw = codexPane(ST, true);
  activity.onTurnStart(ST);
  activity.onData(ST, 'x'.repeat(800));
  typer.enqueue(ST, 'rs1', 1, 'Dev', 'agent-a', 'queued one');
  await sleep(300);
  eq(typer.enqueue(ST, 'rs1', 2, 'Dev', 'agent-a', 'held behind'), 'queued', 'the next waits one-queued');
  eq(typer.enqueue(ST, 'rs1', 3, 'Dev', 'user', 'stop now', false, { control: typer.isStopLine('stop now') }), 'injected', 'a stop from the person goes at once');
  await sleep(300);
  eq(sw.filter((d) => d.includes('stop now')).length, 1, 'typed once');
  eq(sw[sw.findIndex((d) => d.includes('stop now')) + 1], CR, '...submitted with Enter (the steer key), not Tab');
  eq(sw.some((d) => d.includes('held behind')), false, 'the held line still waits behind the queued one');
  eq(typer.heldFor(ST)?.reason, 'one-queued', '...one-queued, as before');
  console.log('\n[FIX 2: the answer to the pane\'s own ask steers; one-shot]');
  typer.noteOwnAsk(ST, ['th-own', 'ENV-OWN']);
  eq(typer.enqueueFabric(ST, { id: 'ENV-ANS', from: 'peer', kind: 'msg', thread: 'th-own', body: 'here is the answer' }), 'injected', 'the answer on the ask\'s thread goes at once');
  await sleep(300);
  eq(sw[sw.findIndex((d) => d.includes('here is the answer')) + 1], CR, '...with the steer key');
  eq(typer.enqueueFabric(ST, { id: 'ENV-ANS2', from: 'peer', kind: 'msg', thread: 'th-own', body: 'follow-up' }), 'queued', 'a second message on that thread queues normally (one-shot)');
  sessions.remove(ST);

  console.log('\n[FIX 2: codexSteerControl off = Tab, queued like any line]');
  table.setEngineSetting('agentComms', { codexSteerControl: false });
  const SO = 'recipe:codex-steer-off#1';
  const so = codexPane(SO, true);
  activity.onTurnStart(SO);
  activity.onData(SO, 'x'.repeat(800));
  typer.enqueue(SO, 'ro', 1, 'Dev', 'agent-a', 'queued one');
  await sleep(300);
  eq(typer.enqueue(SO, 'ro', 2, 'Dev', 'user', 'stop now', false, { control: true }), 'queued', 'switch off: the stop waits one-queued');
  await sleep(300);
  eq(so.includes(CR), false, 'never an Enter');
  activity.onResponseDone(SO);
  await sleep(700);
  eq(so[so.findIndex((d) => d.includes('stop now')) + 1], TAB, 'once released it goes with Tab, as before');
  table.setEngineSetting('agentComms', null);
  sessions.remove(SO);

  console.log('\n[FIX 3: hooks work = the hold ignores the timer and the screen; the Stop releases]');
  process.env.HARBOR_WB_QUEUE_HOLD_MS = '200';
  const RC = 'recipe:codex-ready#1';
  const rw = codexPane(RC, true);
  activity.onTurnStart(RC);
  activity.onData(RC, 'x'.repeat(800));
  typer.enqueue(RC, 'rc', 1, 'Dev', 'agent-a', 'one');
  await sleep(300);
  typer.enqueue(RC, 'rc', 2, 'Dev', 'agent-a', 'two');
  await sleep(700);
  eq(rw.filter((d) => d === TAB).length, 1, 'the hold timer does not release a hooked pane');
  activity.onTurnStart(RC);
  await sleep(300);
  eq(rw.filter((d) => d === TAB).length, 1, 'nor does a turn starting');
  activity.onResponseDone(RC);
  await sleep(700);
  eq(rw.filter((d) => d === TAB).length, 2, 'a completed turn does');
  eq(activity.doneCount(RC), 1, 'activity counts completed turns');
  sessions.remove(RC);
  console.log('\n[FIX 3: no hooks = the screen\'s idle and the timer stay the fallbacks]');
  const NH = 'recipe:codex-ready-nohook#1';
  const nh = codexPane(NH, false);
  activity.onData(NH, 'x'.repeat(800));
  typer.enqueue(NH, 'nh', 1, 'Dev', 'agent-a', 'one');
  typer.enqueue(NH, 'nh', 2, 'Dev', 'agent-a', 'two');
  await sleep(150);
  eq(nh.filter((d) => d === TAB).length, 1, 'held one-queued');
  await sleep(600);
  eq(nh.filter((d) => d === TAB).length, 2, 'the timer releases a pane with no hooks');
  delete process.env.HARBOR_WB_QUEUE_HOLD_MS;
  sessions.remove(NH);
}

{
  /* #5 BACKLOG DIGEST (Owner 2026-10-07, room interface/5772) */
  const TAB = String.fromCharCode(9);
  const CR = String.fromCharCode(13);
  const T0 = Date.UTC(2026, 9, 7, 9, 30);
  const mk = (n: number, o: Record<string, unknown> = {}) => ({
    roomId: 'rd', entryId: n, text: `[room Dev · @a${n}] body ${n}`, from: `a${n}`, msgId: `line ${n}`, thread: 'room Dev', room: 'Dev',
    ts: T0 + n * 60_000, replyNeeded: true, addressed: true, gist: `gist ${n}`, ...o,
  });

  console.log('\n[digest (pure): who is digested, the line, the fit]');
  eq(typer.planDigest([mk(1), mk(2), mk(3), mk(4)], 4), null, 'at N or fewer addressed: no digest');
  eq(typer.planDigest([mk(1), mk(2), mk(3), mk(4), mk(5)], 0), null, '0 = off');
  const plan = typer.planDigest(
    [mk(1), mk(2, { from: 'user' }), mk(3), mk(4, { control: true }), mk(5), mk(6, { addressed: false, replyNeeded: false }), mk(7), mk(8, { roomId: 'fabric', entryId: 0, msgId: 'id:ENV-8', thread: 't:th8', replyNeeded: false }), { roomId: 'x', entryId: 9, text: 'composed' }],
    4,
  );
  same(plan && [plan.full.map((i) => i.entryId), plan.digested.map((i) => i.entryId), plan.fyi.map((i) => i.entryId)], [[2, 4, 9], [1, 3, 5, 7, 0], [6]], "the person's, control and metadata-less items stay full; room-wide lines are the tail");
  const dg = typer.composeDigest(plan!.digested, plan!.fyi);
  eq(dg.startsWith('[digest · 5 messages for you since 09:31Z · 4 need a reply]'), true, 'header: count, since, how many need a reply');
  eq(dg.includes('(1) room Dev · @a1 · line 1 — gist 1') && dg.includes('(5) t:th8 · @a8 · id:ENV-8 — gist 8'), true, 'one entry per item: thread · sender · id — gist');
  eq(dg.includes(' · and 1 room-wide line'), true, 'room-wide lines are one tail');
  eq(dg.includes('Read them in full: room_read(room: "Dev", since: 0)') && dg.includes('fabric_inbox ids: ENV-8'), true, 'pointers: room_read since one before the first line (exclusive), fabric ids in full');
  eq(typer.gistOf('x'.repeat(200)).length, 60, 'a gist is ~60 chars');
  const many = Array.from({ length: 20 }, (_, i) => mk(i + 1, { gist: typer.gistOf('g'.repeat(200)) }));
  const big = typer.composeDigest(many, []);
  eq(big.length <= 1500, true, 'twenty items still fit TYPE_TEXT_MAX');
  eq(/… and [0-9]+ more/.test(big) && big.includes('Read them in full: room_read'), true, '...the overflow is counted and the pointer is never cut');

  console.log('\n[digest: a codex pane gets the person\'s line in full, then ONE digest]');
  const DX = 'recipe:codex-digest#1';
  const dw = fakePane(DX, 'codex-cli');
  activity.noteHook(DX);
  activity.onInput(DX, 'x'); // a draft holds everything while the backlog builds
  for (let n = 1; n <= 5; n++) typer.enqueue(DX, 'rd', 100 + n, 'Dev', `agent-${n}`, `please do task ${n}`, false, { ts: T0, replyNeeded: true });
  typer.enqueue(DX, 'rd', 106, 'Dev', 'agent-6', 'fyi everyone', false, { ts: T0, replyNeeded: false });
  typer.enqueueFabric(DX, { id: 'ENV-DG-1', from: 'peer', to: 'codex-digest', kind: 'msg', thread: 'th-dg', body: 'a direct note', ts: new Date(T0).toISOString() });
  typer.enqueue(DX, 'rp', 200, 'Person', 'user', 'the person says hello', false, { ts: T0, replyNeeded: true });
  activity.onInput(DX, CR); // the box is submitted: clear
  await sleep(1200);
  const pastes = dw.filter((d) => d !== TAB);
  eq(dw.filter((d) => d === TAB).length, 1, 'one delivery');
  const dtext = pastes[0] ?? '';
  eq(dtext.includes('the person says hello') && dtext.indexOf('the person says hello') < dtext.indexOf('[digest'), true, "the person's line goes in full, first");
  eq(dtext.includes('[digest · 6 messages for you since 09:30Z · 5 need a reply]'), true, 'the rest is ONE digest (5 room asks + the DM)');
  eq(dtext.includes('[room Dev · @agent-1]') || dtext.includes('[fabric · @peer'), false, 'no digested item is typed in its full frame (gist only)');
  eq(dtext.includes('(1) room Dev · @agent-1 · line 101 — please do task 1'), true, '...each is one gist entry');
  eq(dtext.includes('room_read(room: "Dev", since: 100)') && dtext.includes('fabric_inbox ids: ENV-DG-1') && dtext.includes('and 1 room-wide line'), true, 'with the pointers and the room-wide tail');
  eq(typer.queued(DX).typed + typer.queued(DX).fabric, 0, 'nothing left queued');
  sessions.remove(DX);

  console.log('\n[digest: a claude pane\'s typed queue too; digestOver 0 = the full batch]');
  const DC = 'recipe:claude-digest#1';
  const cw = fakePane(DC, 'claude-code');
  activity.onInput(DC, 'x');
  for (let n = 1; n <= 5; n++) typer.enqueue(DC, 'rc', 300 + n, 'Ops', `agent-${n}`, `ops task ${n}`, false, { ts: T0, replyNeeded: true });
  activity.onInput(DC, CR);
  await sleep(800);
  eq(cw.some((d) => d.startsWith('[digest · 5 messages for you')) && cw.includes(CR), true, 'claude: one digest, typed with Enter');
  sessions.remove(DC);
  table.setEngineSetting('agentComms', { digestOver: 0 });
  const DO = 'recipe:claude-digest-off#1';
  const ow2 = fakePane(DO, 'claude-code');
  activity.onInput(DO, 'x');
  for (let n = 1; n <= 5; n++) typer.enqueue(DO, 'ro', 400 + n, 'Ops', `agent-${n}`, `ops task ${n}`, false, { ts: T0, replyNeeded: true });
  activity.onInput(DO, CR);
  await sleep(800);
  eq(ow2.some((d) => d.startsWith('[batch · 5 room lines') && d.includes('ops task 5')), true, 'off: the full batch, as before');
  table.setEngineSetting('agentComms', null);
  sessions.remove(DO);
}

/* Windows refuses to unlink scratch.db while the in-process store holds it
   (no close verb, Seam C2) — same guard as reconcile.test.ts. */
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* held open by better-sqlite3 until exit */
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
