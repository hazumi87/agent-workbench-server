/**
 * Reply turns and threads, the pure state machine (the design notes,
 * acceptance checks 1-14 and 18, plus the A83 scenario replay). The wiring
 * checks (15 off mode, 16 Basic, 17 route errors) are in reply-turns-routes.test.mjs.
 */
import { ReplyTurns, threadOfMeta, factText, turnLineText, answeredText, type TurnsCtx, type TurnEffect, type FloorEffect } from '../src/engine/reply-turns.ts';
import { parse } from '../src/server/room-commands.ts';

let failed = 0;
let checks = 0;
const ok = (c: unknown, m: string) => {
  checks++;
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) failed++;
};
const section = (s: string) => console.log(`\n[${s}]`);

process.env.HARBOR_WB_TURN_WINDOW_MS = '30000';
process.env.HARBOR_WB_TURN_MS = '600000';
/* the sections before 20 predate the read gate (a holder that never acknowledged its grant is held once, section 20); they test the
   queue itself, so the gate is off for them and on, as shipped, in section 20 */
process.env.HARBOR_WB_TURN_READ_GATE = '0';

/* a tiny world: a clock, liveness, handles, and a grant counter */
function world() {
  let now = 1_000_000;
  const offline = new Set<string>();
  let g = 0;
  const T = new ReplyTurns(() => `g${++g}`);
  /* step 2: a pane blocked on the limit menu, and (opt-in) a last-output clock per seat */
  const blocked = new Map<string, string>();
  const active = new Map<string, number>();
  let ackOn = false;
  const ctx = (): TurnsCtx => ({
    now,
    isLive: (s) => !offline.has(s),
    handle: (s) => s,
    blockedReason: (s) => blocked.get(s) ?? null,
    ...(ackOn ? { lastActive: (s: string) => active.get(s) ?? null } : {}),
  });
  let nextId = 100;
  const room = 'r1';
  /* what the wiring reads off a stored parent line: meta.thread ?? its own id */
  const lineThread = new Map<number, number>();
  const parentThread = (parent: number | null | undefined): number | null => (parent == null ? null : (lineThread.get(parent) ?? parent));
  /* the person writes a line; returns [id, thread, effects] */
  const person = (refs: string[], o: { parent?: number | null; toRoom?: boolean; body?: string } = {}) => {
    const id = ++nextId;
    const thread = T.threadFor({ roomId: room, author: 'user', parentThread: parentThread(o.parent), references: refs, toRoom: !!o.toRoom });
    const eff = T.onLine({ id, roomId: room, author: 'user', who: '@owner', body: o.body ?? `line ${id}`, references: refs, toRoom: !!o.toRoom }, thread, ctx());
    lineThread.set(id, thread ?? id);
    return { id, thread: thread ?? id, eff };
  };
  /* a seat tries to post; returns the decision, and writes the line when allowed */
  const post = (seat: string, o: { parent?: number | null; refs?: string[]; body?: string } = {}) => {
    const thread = T.threadFor({ roomId: room, author: seat, parentThread: parentThread(o.parent), references: o.refs ?? [], toRoom: false });
    const d = T.decidePost(seat, thread, ctx());
    if (d.held) {
      return { held: true as const, behind: d.behind, thread: d.thread, eff: d.effects, answered: (d as { answered?: Array<{ id: number; who: string; excerpt: string }> }).answered };
    }
    const id = ++nextId;
    const eff = T.onLine({ id, roomId: room, author: seat, who: `@${seat}`, body: o.body ?? `answer ${id}`, references: o.refs ?? [], toRoom: false }, thread, ctx());
    lineThread.set(id, thread ?? id);
    return { held: false as const, id, thread: thread ?? id, eff: [...d.effects, ...eff] };
  };
  return {
    T,
    ctx,
    person,
    post,
    claim: (seat: string, thread: number, o: { grant?: string; pass?: boolean } = {}) => T.claim(seat, room, thread, o, ctx()),
    sweep: () => T.sweep(ctx()),
    tick: (ms: number) => {
      now += ms;
    },
    block: (s: string, why: string | null) => (why ? blocked.set(s, why) : blocked.delete(s)),
    ackOn: () => (ackOn = true),
    output: (s: string) => active.set(s, now),
    now: () => now,
    off: (s: string) => offline.add(s),
    on: (s: string) => offline.delete(s),
  };
}
const floors = (eff: TurnEffect[]) => eff.filter((e): e is FloorEffect => e.type === 'floor');
const skips = (eff: TurnEffect[]) => eff.filter((e) => e.type === 'skip');

section('1. two seats referenced: the second is held until the first answers');
{
  const w = world();
  const a = w.person(['seat2', 'seat4']);
  ok(a.eff.length === 0, 'nobody has claimed yet: no floor, no fact');
  const early = w.post('seat4', { parent: a.id });
  ok(early.held && early.behind === 'seat2', 'seat4 posting first inside the window is HELD behind @seat2');
  const ans = w.post('seat2', { parent: a.id });
  ok(!ans.held, "seat2's post is written (it gets the floor by posting)");
  const f = floors(ans.eff);
  ok(f.length === 1 && f[0].seat === 'seat4', 'seat4 (claimed by its held post) gets the floor when seat2 answers');
  ok(f[0].delta.length === 1 && f[0].delta[0].who === '@seat2', "seat4's turn line carries seat2's answer as the delta");
  ok(f[0].thread === a.id && f[0].grant === 'g2', 'it names the thread and carries a grant');
  const again = w.post('seat4', { parent: a.id });
  ok(!again.held, 'seat4 can now post');
}

section('2. order is reference order: the room lead has no priority');
{
  const w = world(); // "seat4" stands for the room's lead: the module never sees a lead
  const a = w.person(['seat2', 'seat4']);
  w.claim('seat4', a.id);
  const r = w.claim('seat2', a.id);
  ok('state' in r && r.state === 'floor', 'seat2, referenced first, takes the floor over seat4 who claimed earlier');
}

section('3. a backticked @seat is not referenced; a mid-sentence one is, in text order');
{
  const seats = [
    { id: 's1', handle: 'seat1', state: 'active', policy: 'persistent' },
    { id: 's2', handle: 'seat2', state: 'active', policy: 'persistent' },
    { id: 's4', handle: 'seat4', state: 'active', policy: 'persistent' },
  ] as any;
  const p = parse('@seat2 can you get `@seat1` the notes, and ask @seat4 too', seats, { unaddressedToLead: false }) as any;
  const to = Array.isArray(p.to) ? p.to : [p.to];
  ok(to.join(',') === 's2,s4', 'the parser hands over seat2 then seat4, never the backticked seat1');
  const w = world();
  const a = w.person(to);
  const held = w.post('s4', { parent: a.id });
  ok(held.held && held.behind === 's2', 'the mid-sentence reference still has a place, behind the leading one');
}

section('4. an unclaimed place lapses after the window, silently');
{
  const w = world();
  const a = w.person(['seat2', 'seat4']);
  w.tick(31_000);
  const r = w.post('seat4', { parent: a.id });
  ok(!r.held, "after 30 s seat2's place no longer blocks: seat4's post is written");
  ok(skips(r.eff).length === 0, 'nothing is written about seat2');
}

section('5. a claim keeps the place past the window');
{
  const w = world();
  const a = w.person(['seat2', 'seat4']);
  const c = w.claim('seat2', a.id);
  ok('state' in c && c.state === 'floor' && typeof (c as any).grant === 'string', 'seat2 claims: it has the floor, and the claim answer carries its grant');
  ok(floors(c.effects).every((e) => e.seat !== 'seat2'), 'no turn line to seat2 for a floor it just asked for');
  w.tick(60_000);
  const r = w.post('seat4', { parent: a.id });
  ok(r.held && r.behind === 'seat2', "seat4 is still held a minute later: seat2's claim holds its place");
  const ans = w.post('seat2', { parent: a.id });
  ok(floors(ans.eff)[0]?.seat === 'seat4', 'seat2 answers: seat4 gets its turn');
}

section('6. pass moves the floor at once');
{
  const w = world();
  const a = w.person(['seat2', 'seat4']);
  w.claim('seat2', a.id);
  w.claim('seat4', a.id);
  const p = w.claim('seat2', a.id, { pass: true });
  ok('passed' in p && p.passed && floors(p.effects)[0]?.seat === 'seat4', 'seat2 passes: seat4 has the floor');
  const none = w.claim('seat9', a.id, { pass: true });
  ok('passed' in none && none.passed === false, 'passing with no place answers passed:false');
}

section('7. offline: a floor-holder is skipped with a fact; a waiting claimant is dropped silently');
{
  const w = world();
  const a = w.person(['seat2', 'seat4', 'seat5']);
  w.claim('seat2', a.id);
  w.claim('seat4', a.id);
  w.claim('seat5', a.id);
  w.off('seat4');
  w.off('seat2');
  const e = w.sweep();
  const s = skips(e);
  ok(s.length === 1 && s[0].seat === 'seat2' && (s[0] as any).why === 'offline', 'the floor-holder seat2 went offline: skipped, with a fact');
  ok(floors(e)[0]?.seat === 'seat5', 'seat4 (waiting, offline) is passed over silently; seat5 gets the floor');
  ok(factText(s[0], (x) => x) === '@seat2 went offline before answering #' + a.id, 'the fact says so in plain words');
}

section('8. floor budget: a silent holder is skipped after the turn time');
{
  const w = world();
  const a = w.person(['seat2', 'seat4']);
  w.claim('seat2', a.id);
  w.claim('seat4', a.id);
  w.tick(599_000);
  ok(w.sweep().length === 0, 'inside ten minutes nothing happens');
  w.tick(2_000);
  const e = w.sweep();
  ok(skips(e)[0]?.seat === 'seat2' && floors(e)[0]?.seat === 'seat4', 'past ten minutes seat2 is skipped and seat4 has the floor');
  ok(factText(skips(e)[0], (x) => x).includes('did not answer in time'), 'the skip fact reads "did not answer in time"');
  const late = w.post('seat2', { parent: a.id });
  ok(late.held && late.behind === 'seat4', 'a skipped seat is not punished: its late post is a late claim behind the holder');
}

section('9. a late entrant into an emptied queue gets the floor at once, with the whole delta');
{
  const w = world();
  const a = w.person(['seat2', 'seat5']);
  const b = w.post('seat2', { parent: a.id });
  w.tick(40_000);
  w.sweep();
  w.person(['seat2'], { parent: b.id });
  w.post('seat2', { parent: b.id });
  w.tick(40_000);
  const c = w.claim('seat5', a.id);
  ok('state' in c && c.state === 'floor', 'seat5 comes back later and claims: floor at once');
  const turns = w.T.myTurns('seat5', w.ctx());
  ok(turns.length === 1 && turns[0].state === 'floor' && typeof turns[0].grant === 'string', 'my_turns shows its floor and grant');
}

section('10. a seat referenced by another SEAT in the thread gets a place and replies into it');
{
  const w = world();
  const a = w.person(['seat5']);
  const r = w.post('seat5', { parent: a.id, refs: ['seat10'], body: '@seat10 can you bring the numbers?' });
  ok(!r.held, 'seat5 asks @seat10 inside the thread');
  const t = w.T.myTurns('seat10', w.ctx());
  ok(t.length === 1 && t[0].thread === a.id, 'seat10 now has a place in that thread');
  const ans = w.post('seat10', { parent: r.id });
  ok(!ans.held && ans.thread === a.id, "seat10's reply joins the same thread, so the person sees it there");
}

section('11 + scenario: Owner [ref], thread A83, all ten steps');
{
  const w = world();
  // 1. The user asks BT and PL: A83-1.
  const a1 = w.person(['BT', 'PL'], { body: 'advice on the feature?' });
  // 2. Both want to respond: they queue (claims). PL trying to post now is held.
  w.claim('BT', a1.id);
  const plEarly = w.post('PL', { parent: a1.id });
  ok(plEarly.held && plEarly.behind === 'BT', 'step 2: PL is queued behind BT (named first)');
  // 3. BT answers A83-1: A83-2.
  const a2 = w.post('BT', { parent: a1.id, body: 'BT view' });
  ok(!a2.held, 'step 3: BT answers first');
  const plTurn = floors(a2.eff).find((e) => e.seat === 'PL');
  ok(!!plTurn && plTurn.delta.map((l) => l.id).join() === String(a2.id), "step 4: PL's turn line carries A83-2 before it answers");
  // 4. PL answers: A83-3.
  const a3 = w.post('PL', { parent: a1.id, body: 'PL view' });
  ok(!a3.held && a3.thread === a1.id, 'step 4: PL answers in the same thread');
  // 5. The user replies to PL and BT, in that order: A83-4.
  const a4 = w.person(['PL', 'BT'], { parent: a3.id, body: 'thoughts on both?' });
  ok(a4.thread === a1.id, 'step 5: the reply joins thread A83');
  // 6. Both queue; PL first.
  w.claim('BT', a1.id);
  const btEarly = w.post('BT', { parent: a4.id });
  ok(btEarly.held && btEarly.behind === 'PL', 'step 6: BT is queued behind PL');
  // 7. Before either replies the user writes to BT only: A83-5 (no reply chip: rule 2 joins A83).
  const a5 = w.person(['BT'], { body: 'BT, only you: about that last reply' });
  ok(a5.thread === a1.id, 'step 7: a chip-less line to BT joins A83 (pending, and BT is a member)');
  const bt = w.T.myTurns('BT', w.ctx())[0];
  ok(bt.lines.join() === `${a4.id},${a5.id}`, "step 7: A83-5 MERGES into BT's place; nothing is cancelled");
  const pl = w.T.myTurns('PL', w.ctx())[0];
  ok(pl.lines.join() === String(a4.id), "step 7: PL's place still answers A83-4 only");
  // 8. PL replies: A83-6.
  const a6 = w.post('PL', { parent: a4.id, body: 'PL on A83-4' });
  ok(!a6.held, 'step 8: PL sends A83-6');
  // 9. BT is next: it gets A83-4 and A83-5 as its sources and A83-6 in the delta.
  const btTurn = floors(a6.eff).find((e) => e.seat === 'BT');
  ok(!!btTurn && btTurn.sources.join() === `${a4.id},${a5.id}`, 'step 9: BT answers A83-4 and A83-5');
  ok(!!btTurn && btTurn.delta.map((l) => l.id).join() === String(a6.id), "step 9: BT's delta is PL's A83-6");
  ok(!!btTurn && turnLineText(btTurn).includes(`thread #${a1.id}`) && turnLineText(btTurn).includes(`room_read since=${a4.id - 1}`), 'step 9: the turn line names the thread and where to read the full text');
  // 10. BT chooses (a) reply to A83-6 naming PL and the user, or (b) reply to A83-5. Either ends its turn.
  const a7 = w.post('BT', { parent: a6.id, refs: [], body: '@PL @owner both of you' });
  ok(!a7.held && a7.thread === a1.id, 'step 10: BT answers; the reply stays in A83');
  ok(w.T.myTurns('BT', w.ctx()).length === 0 && w.T.myTurns('PL', w.ctx()).length === 0, 'step 10: no turns are left open');
}

section('12. @room: a thread with no floor');
{
  const w = world();
  const a = w.person([], { toRoom: true, body: 'please submit your session summaries' });
  const r1 = w.post('seat2', { parent: a.id });
  const r2 = w.post('seat4', { parent: a.id });
  ok(!r1.held && !r2.held, 'two summaries replying to the @room line are both written at once');
  ok(r1.thread === a.id && r2.thread === a.id, 'both stay in the broadcast thread');
  ok(floors([...r1.eff, ...r2.eff]).length === 0, 'no turn lines, no floor facts');
}

section('13. thread joining');
{
  const w = world();
  const a = w.person(['seat2']);
  w.post('seat2', { parent: a.id });
  w.tick(3 * 24 * 3600_000); // days later
  const old = w.person(['seat2'], { parent: a.id });
  ok(old.thread === a.id, 'a reply joins its parent thread however old');
  const b = w.person(['seat2', 'seat4']);
  const c = w.person(['seat4']);
  ok(c.thread === b.id, 'a chip-less line joins the newest pending thread containing every referenced seat');
  const d = w.person(['seat7']);
  ok(d.thread === d.id, 'a line naming a seat outside every pending thread opens a new one');
  w.tick(31_000);
  w.sweep();
  const e = w.person(['seat2']);
  ok(e.thread === e.id, 'once nothing is pending, a chip-less line opens a new thread (the "bring me up to speed" case)');
}

section('14. the person is never held');
{
  const w = world();
  const a = w.person(['seat2', 'seat4']);
  w.claim('seat2', a.id);
  const again = w.person(['seat2', 'seat4'], { parent: a.id });
  ok(again.id > a.id && again.thread === a.id, 'a person line into a thread with a floor-holder is written and joins it');
}

section('18. Owner\'s five-seat example');
{
  const w = world();
  const a = w.person(['seat2', 'seat4', 'seat1', 'seat5', 'seat10'], { body: '@seat2 @seat4 can you get @seat1 the info on the caretaker. and @seat5 can you follow up with @seat10 and give me the results?' });
  w.claim('seat2', a.id);
  w.claim('seat4', a.id);
  const s2 = w.post('seat2', { parent: a.id, body: 'here is the caretaker info, @seat1' });
  ok(!s2.held && floors(s2.eff)[0]?.seat === 'seat4', 'seat2 answers, seat4 gets the floor');
  const p = w.claim('seat4', a.id, { pass: true });
  ok('passed' in p && p.passed, 'seat4 sees the info is already there and passes');
  w.tick(31_000);
  w.sweep();
  ok(['seat1', 'seat5', 'seat10'].every((s) => w.T.myTurns(s, w.ctx()).length === 0), 'seat1, seat5 and seat10 never claimed: their places lapsed silently');
  w.tick(3600_000);
  const c = w.claim('seat5', a.id);
  ok('state' in c && c.state === 'floor', 'an hour later seat5 comes back with results: floor at once in an empty queue');
  const mine = w.T.myTurns('seat5', w.ctx())[0];
  ok(!!mine && typeof mine.grant === 'string', 'its turn carries a grant');
  const ack = w.claim('seat5', a.id, { grant: mine.grant });
  ok('acknowledged' in ack, 'acknowledging with the grant succeeds');
  const twice = w.claim('seat5', a.id, { grant: mine.grant });
  ok(!twice.ok && twice.error === 'wrong_grant', 'a grant is single use');
  const wrong = w.claim('seat2', a.id, { grant: 'nope' });
  ok(!wrong.ok && wrong.error === 'wrong_grant', 'another seat with a made-up grant is refused');
}

section('words');
{
  const e: FloorEffect = { type: 'floor', roomId: 'r', thread: 10, seat: 'bt', sources: [12, 15], after: 'pl', grant: 'GG', delta: [{ id: 13, author: 'pl', who: '@pl', excerpt: 'hi' }], more: 2 };
  ok(factText(e, (x) => x) === '@bt has the floor on #12, #15 (after @pl)', 'the floor fact');
  ok(!factText(e, (x) => x).includes('GG'), 'the fact never carries the grant');
  const t = turnLineText(e);
  ok(t.includes('grant: GG') && t.includes('#13 @pl: "hi"') && t.includes('2 more') && !t.includes(String.fromCharCode(10)), 'the turn line: grant, delta, overflow count, one line');
  ok(t.includes('@pl already answered (#13). Reply to #13') && t.includes('do not restate'), 'after another seat answered: reply to that seat, add only what is new');
  const p = turnLineText({ ...e, delta: [{ id: 13, author: 'user', who: '@owner', excerpt: 'hi' }] });
  ok(p.includes('Reply to the line you are answering') && !p.includes('already answered'), 'only the person newer: the old wording');
}

section('19. read before post: two seats typed one line together (the #6957 replay, 2026-10-12)');
{
  const w = world();
  const L = w.person(['bt', 'cx']); // one line naming both: both are typed it at once, nobody waits
  const a = w.post('bt', { parent: L.id }); // bt answers fast: first, so its own post is the answer
  ok(!a.held, 'the first seat to answer posts at once');
  const b1 = w.post('cx', { parent: L.id }); // cx was writing meanwhile and was never handed bt's answer
  ok(b1.held && b1.behind === null, 'the second seat is stopped once: it has not been handed the newer answer');
  const floor = b1.eff.find((e): e is FloorEffect => e.type === 'floor' && e.seat === 'cx');
  ok(!!floor && floor.delta.some((l) => l.id === (a as any).id), 'it gets its turn line, and the line carries the first answer');
  ok(!!floor && floor.after === 'bt', 'the fact says it follows @bt');
  const b2 = w.post('cx', { parent: L.id });
  ok(!b2.held, 'with the floor and the answer in hand, its post goes through');
  const w2 = world();
  const L2 = w2.person(['bt']);
  ok(!w2.post('bt', { parent: L2.id }).held, 'a lone seat answering is never stopped');
  const w3 = world();
  const L3 = w3.person(['bt', 'cx']);
  w3.person(['bt', 'cx'], { parent: L3.id }); // the person adds a follow-up naming both: merged into their places
  ok(!w3.post('bt', { parent: L3.id }).held, 'a newer line of the person that names the seat is already its source: not stale');
}

section('15/16. the mode switch: off by default, never in Basic');
{
  const { mode } = await import('../src/engine/reply-turns.ts');
  const keep = { t: process.env.HARBOR_WB_REPLY_TURNS, e: process.env.HARBOR_WB_EDITION };
  const restore = () => {
    if (keep.t === undefined) delete process.env.HARBOR_WB_REPLY_TURNS; else process.env.HARBOR_WB_REPLY_TURNS = keep.t;
    if (keep.e === undefined) delete process.env.HARBOR_WB_EDITION; else process.env.HARBOR_WB_EDITION = keep.e;
  };
  delete process.env.HARBOR_WB_REPLY_TURNS;
  delete process.env.HARBOR_WB_EDITION;
  ok(mode() === 'off', 'unset: off (today\'s behaviour)');
  process.env.HARBOR_WB_REPLY_TURNS = 'enforce';
  ok(mode() === 'enforce', 'HARBOR_WB_REPLY_TURNS=enforce: enforce');
  process.env.HARBOR_WB_EDITION = 'basic';
  ok(mode() === 'off', 'Basic edition: inert even in enforce');
  restore();
}

section('closed: the queue emptied after a floor was handed (toolkit [ref])');
{
  const closes = (eff: TurnEffect[]) => eff.filter((e) => e.type === 'closed');
  {
    const w = world();
    const a = w.person(['seat2', 'seat4']);
    ok(closes(a.eff).length === 0, 'a fresh thread with places is not closed');
    const one = w.post('seat2', { parent: a.id });
    ok(closes(one.eff).length === 0, 'seat2 answered but seat4 is still referenced (inside its window): not closed');
    w.claim('seat4', a.id);
    const two = w.post('seat4', { parent: a.id });
    const c = closes(two.eff);
    ok(c.length === 1 && (c[0] as any).thread === a.id && (c[0] as any).roomId === 'r1', 'the last answer empties the queue: one closed effect naming the thread');
    ok(factText(c[0], (x) => x) === `the floor on #${a.id} is closed`, 'its fact text');
    ok(closes(w.sweep()).length === 0, 'once per emptying: a sweep does not close it again');
  }
  {
    const w = world();
    const a = w.person(['seat2']);
    w.claim('seat2', a.id);
    const r = w.claim('seat2', a.id, { pass: true });
    ok(closes(r.effects).length === 1, 'a final PASS closes the thread (the case that left no trace before)');
  }
  {
    const w = world();
    const a = w.person(['seat2']);
    w.claim('seat2', a.id);
    w.tick(601_000);
    const e = w.sweep();
    ok(skips(e).length === 1 && closes(e).length === 1, 'a timed-out final holder: skipped, then closed');
  }
  {
    const w = world();
    const a = w.person(['seat2']);
    w.tick(10 * 60_000);
    ok(closes(w.sweep()).length === 0, 'a thread whose only place lapsed without ever handing a floor is never "closed"');
    void a;
  }
  {
    const w = world();
    const a = w.person(['seat2']);
    w.claim('seat2', a.id);
    const first = w.post('seat2', { parent: a.id });
    ok(closes(first.eff).length === 1, 'closed after the answer');
    const b = w.person(['seat4'], { parent: a.id });
    w.claim('seat4', b.thread);
    const again = w.post('seat4', { parent: b.id });
    ok(b.thread === a.id && closes(again.eff).length === 1, 'the same thread reopened by a new line closes again on its next emptying');
  }
}

section('floor-fact replies stay in the thread (floor-fix 1)');
{
  ok(threadOfMeta('{"thread":7}', 9) === 7, 'meta.thread wins');
  ok(threadOfMeta('{"turn":{"thread":14450,"kind":"floor"}}', 14452) === 14450, 'a turn fact is about its turn.thread');
  ok(threadOfMeta('{"thread":7,"turn":{"thread":8}}', 9) === 7, 'meta.thread beats turn.thread');
  ok(threadOfMeta(null, 9) === 9 && threadOfMeta('', 9) === 9 && threadOfMeta('{bad', 9) === 9, 'no usable meta: its own id');
  ok(threadOfMeta('{"turn":{"thread":"x"}}', 9) === 9, 'a non-integer turn.thread is ignored');
  /* the HomeHub case: the holder answers the "has the floor" fact, not the person's line */
  const w = world();
  const a = w.person(['seat2']);
  w.claim('seat2', a.id);
  const factId = 900; // the room fact "@seat2 has the floor on #a", meta.turn.thread = a.id
  const parent = threadOfMeta(JSON.stringify({ turn: { thread: a.id, seat: 'seat2', lines: [a.id], kind: 'floor' } }), factId);
  const r = w.post('seat2', { parent: parent === factId ? factId : a.id });
  ok(parent === a.id && !r.held && r.thread === a.id, 'a reply to the floor fact lands in the thread that holds the floor');
  w.tick(10 * 60_000 + 1000);
  ok(skips(w.sweep()).length === 0, 'and the holder is NOT skipped as "did not answer in time" afterwards');
}

section('floor-fix 2: a frozen holder is released in minutes, with the reason');
{
  const why = (e: TurnEffect[]) => e.filter((x) => x.type === 'skip').map((x) => (x as { why: string }).why);
  /* a holder on the limit menu is skipped at the next sweep, not after the turn clock */
  {
    const w = world();
    const a = w.person(['seat2']);
    w.claim('seat2', a.id);
    const b = w.person(['seat4'], { parent: a.id });
    w.claim('seat4', b.thread);
    w.block('seat2', 'limit');
    const e = w.sweep();
    ok(why(e).join() === 'limit', 'the holder on the usage-limit menu is skipped at once (why=limit)');
    ok(floors(e).length === 1 && floors(e)[0].seat === 'seat4', 'and the floor goes to the next claimed seat');
    ok(/usage limit/.test(factText(e.find((x) => x.type === 'skip')!, (s) => s)), 'the room fact names the reason');
  }
  /* a seat that is limited when its turn comes is passed over, not handed the floor */
  {
    const w = world();
    const a = w.person(['seat2', 'seat4']);
    w.claim('seat2', a.id);
    w.claim('seat4', a.id);
    w.block('seat2', 'limit');
    const e = w.sweep();
    ok(why(e).join() === 'limit' && floors(e)[0]?.seat === 'seat4', 'a queued seat on the limit menu is skipped and never holds the floor');
  }
  /* a non-limit block (permission, question) is not an instant skip */
  {
    const w = world();
    const a = w.person(['seat2']);
    w.claim('seat2', a.id);
    w.block('seat2', 'permission');
    ok(why(w.sweep()).length === 0, 'a pane waiting on a permission prompt is not skipped instantly');
  }
  /* the ack window: silent for ackMs -> unresponsive; any output resets it; an ack or a post counts */
  {
    const w = world();
    w.ackOn();
    const a = w.person(['seat2']);
    w.claim('seat2', a.id);
    w.output('seat2');
    w.tick(100_000);
    ok(why(w.sweep()).length === 0, 'silent for 100 s: still inside the 2 min window');
    w.output('seat2');
    w.tick(100_000);
    ok(why(w.sweep()).length === 0, 'output at 100 s reset the window (200 s after the grant, still held)');
    w.tick(30_000);
    const e = w.sweep();
    ok(why(e).join() === 'unresponsive', 'silent for 2 min after its last output: skipped as unresponsive');
    ok(/silent for 2 min/.test(factText(e.find((x) => x.type === 'skip')!, (s) => s)), 'the fact says how long');
  }
  {
    const w = world();
    w.ackOn();
    const a = w.person(['seat2']);
    const r = w.claim('seat2', a.id) as { grant?: string };
    ok(!!r.grant, 'claiming at the floor hands back the grant');
    w.tick(60_000);
    const c = w.claim('seat2', a.id, { grant: r.grant });
    ok((c as { acknowledged?: boolean }).acknowledged === true, 'the seat acks its grant');
    w.tick(10 * 60_000 - 60_000 - 1000);
    ok(why(w.sweep()).length === 0, 'an acked holder is not cut off by the ack window (only by the turn clock)');
    w.tick(2000);
    ok(why(w.sweep()).join() === 'timeout', 'the turn clock still ends it');
  }
  /* without a last-output clock the ack window is off (back-compat for every other test) */
  {
    const w = world();
    const a = w.person(['seat2']);
    w.claim('seat2', a.id);
    w.tick(5 * 60_000);
    ok(why(w.sweep()).length === 0, 'no lastActive provided: no ack window');
  }
}

section('floor-fix 3: /floor take, /floor skip, /set turn');
{
  const why = (e: TurnEffect[]) => e.filter((x) => x.type === 'skip').map((x) => (x as { why: string }).why);
  /* /floor skip @seat: the holder is skipped and the next claimed seat gets the floor */
  {
    const w = world();
    const a = w.person(['seat2', 'seat4']);
    w.claim('seat2', a.id);
    w.claim('seat4', a.id);
    const r = w.T.skipSeat('r1', 'seat2', w.ctx());
    ok(r.skipped === 1 && why(r.effects).join() === 'user', 'skip @seat takes the holder out (why=user)');
    ok(floors(r.effects).length === 1 && floors(r.effects)[0].seat === 'seat4', 'and the next claimed seat gets the floor');
    ok(/skipped by the user/.test(factText(r.effects.find((x) => x.type === 'skip')!, (s) => s)), 'the fact says the user did it');
    ok(w.T.skipSeat('r1', 'seat9', w.ctx()).skipped === 0, 'a seat with no turn: nothing skipped');
  }
  /* a QUEUED seat can be skipped too, without disturbing the holder */
  {
    const w = world();
    const a = w.person(['seat2', 'seat4']);
    w.claim('seat2', a.id);
    w.claim('seat4', a.id);
    const r = w.T.skipSeat('r1', 'seat4', w.ctx());
    ok(r.skipped === 1 && floors(r.effects).length === 0, 'skipping a queued seat leaves the holder holding');
    const mine = w.T.myTurns('seat2', w.ctx());
    ok(mine.length === 1 && mine[0].state === 'floor', 'the holder still has the floor');
  }
  /* /floor take: every held turn in the room ends; other rooms are untouched */
  {
    const w = world();
    const a = w.person(['seat2']);
    w.claim('seat2', a.id);
    const b = w.person(['seat4']);
    w.claim('seat4', b.id);
    const other = new ReplyTurns(() => 'x');
    ok(other.takeFloor('r2', w.ctx()).skipped === 0, 'nothing held in another room');
    const r = w.T.takeFloor('r1', w.ctx());
    ok(r.skipped === 2 && why(r.effects).every((x) => x === 'user'), 'take ends both held turns');
    ok(w.T.myTurns('seat2', w.ctx()).length === 0 && w.T.myTurns('seat4', w.ctx()).length === 0, 'and nobody holds a place afterwards');
    ok(w.T.takeFloor('r1', w.ctx()).skipped === 0, 'taking again with nothing held skips nothing');
  }
  /* the person never waits: a seat skipped by the user can still post (a fresh place) */
  {
    const w = world();
    const a = w.person(['seat2']);
    w.claim('seat2', a.id);
    w.T.takeFloor('r1', w.ctx());
    const p = w.post('seat2', { parent: a.id });
    ok(!p.held, 'a seat that was skipped may still post when it comes back');
  }
  /* per-room turn time: shorter than the default ends the turn sooner */
  {
    const w = world();
    const a = w.person(['seat2']);
    w.claim('seat2', a.id);
    w.tick(2 * 60_000 + 1000);
    const ctx2 = { ...w.ctx(), turnMsFor: () => 2 * 60_000 };
    ok(why(w.T.sweep(ctx2)).join() === 'timeout', 'a 2 min room turn time skips after 2 min (default is longer)');
  }
  {
    const w = world();
    const a = w.person(['seat2']);
    w.claim('seat2', a.id);
    w.tick(2 * 60_000 + 1000);
    ok(why(w.sweep()).length === 0, 'without the setting the same 2 min is inside the default');
  }
}

section('floor per thread: a seat waiting on thread A still posts a new line to another agent, or in thread B (Owner [ref])');
{
  const w = world();
  const a = w.person(['seat2', 'seat4']); // thread A: seat2 holds the floor, seat4 is queued behind it
  w.claim('seat2', a.id);
  w.claim('seat4', a.id);
  ok(w.T.myTurns('seat4', w.ctx()).some((x) => x.thread === a.id && x.state === 'queued'), 'setup: seat4 is queued in thread A');
  const n = w.post('seat4', { refs: ['seat9'] });
  ok(!n.held && n.thread !== a.id, 'a NEW line from the queued seat to another agent is not held, and it opens its own thread');
  ok(w.T.myTurns('seat4', w.ctx()).some((x) => x.thread === a.id), "...and seat4's place in A is untouched");
  const m = w.post('seat4', { refs: ['seat2'] });
  ok(m.held === true && m.thread === a.id, 'a new line naming a member of A (seat2) still joins A and waits its turn');
  const q = w.post('seat4', { refs: [] });
  ok(q.held === true && q.thread === a.id, 'a line naming nobody (its answer to what it was asked) still joins A');
  /* thread B: the person asks seat4 and seat6; seat4 holds B's floor. seat4's reply in B is allowed although it waits in A. */
  const b = w.person(['seat4', 'seat6']);
  w.claim('seat4', b.id);
  const r = w.post('seat4', { parent: b.id });
  ok(!r.held && r.thread === b.id, 'a reply in thread B (where seat4 holds the floor) goes through while seat4 still waits in A');
  const cw = world();
  const ca = cw.person(['seat2', 'seat4']);
  cw.claim('seat2', ca.id);
  cw.claim('seat4', ca.id);
  const cb = cw.person(['seat6']);
  cw.claim('seat6', cb.id);
  const rb = cw.post('seat4', { parent: cb.id });
  ok(rb.held === true && rb.thread === cb.id && rb.behind === 'seat6', "a reply in B is held only by B's floor (behind seat6), never by A's");
}

section('20. read before answer: a floor-holder that never read its turn line is held once (the [ref]/[ref] double answer, 2026-10-25)');
{
  delete process.env.HARBOR_WB_TURN_READ_GATE; // the shipped default: on
  /* the incident shape: the person names two seats; both are typed the line together; seat2 answers; seat4 (which never
     posted before and never acknowledged its grant) answers from the line it was typed, before it read its turn line */
  const incident = () => {
    const w = world();
    const a = w.person(['seat2', 'seat4']);
    w.claim('seat4', a.id);
    const first = w.post('seat2', { parent: a.id, body: 'seat2 says the registry is the reason' });
    const grant = floors(first.eff)[0];
    return { w, a, first, grant };
  };
  {
    const { w, a, first, grant } = incident();
    ok(!first.held && grant && grant.seat === 'seat4' && grant.delta.length === 1, "setup: seat2 answered; seat4 holds the floor with seat2's line handed to it");
    const dup = w.post('seat4', { parent: a.id });
    ok(dup.held === true && dup.answered?.length === 1 && dup.answered[0].who === '@seat2' && dup.answered[0].id === first.id, "seat4's first post is HELD once and shows seat2's answer (author, line number)");
    ok(dup.held === true && dup.behind === null, 'it is not held "behind" anyone: the floor is its own');
    const retry = w.post('seat4', { parent: a.id });
    ok(retry.held === false, 'the retry goes through');
    const third = w.post('seat4', { parent: a.id });
    ok(third.held === false && !('answered' in third && (third as { answered?: unknown }).answered), 'the check fires once: a further post is never held again');
    const t = answeredText(dup.held ? (dup.answered as never) : []);
    ok(t.includes(`#${first.id}`) && t.includes('@seat2') && t.includes('room_claim with pass') && t.includes('fires once') && t.includes(`since=${first.id - 1}`), 'the refusal text names the line, its author, the room_read to run and the pass option');
  }
  {
    const { w, a, grant } = incident();
    const ack = w.claim('seat4', a.id, { grant: grant.grant });
    ok('acknowledged' in ack && ack.acknowledged === true, 'seat4 acknowledges its grant with a claim');
    const p = w.post('seat4', { parent: a.id });
    ok(p.held === false, 'a holder that acknowledged the grant is never held');
  }
  {
    const w = world();
    const a = w.person(['seat2', 'seat4']);
    const p = w.post('seat2', { parent: a.id });
    ok(p.held === false, 'the first answer has nothing handed to it: never held');
  }
  {
    const w = world();
    const a = w.person(['seat2', 'seat4']);
    const early = w.post('seat4', { parent: a.id });
    ok(early.held === true, 'seat4 posts early and is told to wait for its turn line');
    w.post('seat2', { parent: a.id });
    const after = w.post('seat4', { parent: a.id });
    ok(after.held === false, 'a seat that was refused earlier posts after its turn line by protocol: not held again');
  }
  {
    const w = world();
    const a = w.person(['seat2', 'seat4']);
    w.claim('seat4', a.id);
    w.person(['seat2', 'seat4'], { body: 'and what about the other thing?' }); // the person follows up in the thread
    w.claim('seat2', a.id, { pass: true }); // seat2 has nothing to add: the floor goes to seat4 with only the person's lines
    const p = w.post('seat4', { parent: a.id });
    ok(p.held === false, "the person's own lines handed with the grant never hold a post (the person is never the one waited on)");
  }
  {
    process.env.HARBOR_WB_TURN_READ_GATE = '0';
    const { w, a } = incident();
    const p = w.post('seat4', { parent: a.id });
    ok(p.held === false, 'HARBOR_WB_TURN_READ_GATE=0 switches the check off');
    delete process.env.HARBOR_WB_TURN_READ_GATE;
  }
  {
    const w = world();
    const a = w.person(['seat2']);
    const p = w.post('seat2', { parent: a.id });
    ok(p.held === false, 'a one-seat reply is unchanged');
  }
}

console.log(`PASS ${checks - failed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
