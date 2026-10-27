/**
 * CONCIERGE SIGN-OFFS (the design notes; design review [ref]). The record, its rules and the engine words. A scratch table; the clock is injected.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wb-signoff-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';

const { table } = await import('../src/table/endpoint.ts');
const so = await import('../src/engine/concierge-signoff.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };
const fails = (fn: () => unknown, code: string, status: number, m: string): void => {
  try { fn(); ok(false, `${m} (accepted)`); } catch (e: any) { ok(e?.code === code && e?.status === status, `${m} (${e?.status} ${e?.code ?? e?.message})`); }
};
const ALL: any = { message: true, summaries: true, compactReload: true, inject: true, startRestore: true, dispatch: true };
const ON = (over: any = {}): any => ({ ...ALL, ...over });

const R = table.createRoom({ name: 'Crew', alias: 'crew' }, { actor: 'user' }).result;
const R2 = table.createRoom({ name: 'Crew2', alias: 'crew2' }, { actor: 'user' }).result;
const mk = (room: any, h: string): any => {
  table.upsertRecipe({ id: `rec-${h}`, name: h, target: 'local', projectDir: `/x/${h}`, vendor: 'claude-code', agent: h, model: null, resume: 0, resumeName: null,
    initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null } as never);
  table.upsert({ paneid: `recipe:rec-${h}`, recipe_id: `rec-${h}`, server: 'local', vendor: 'claude-code', agent: h, session_id: null, state: 'live', generation: 1 } as never);
  return table.addSeat(room.id, { recipe_id: `rec-${h}`, occupant: `recipe:rec-${h}`, handle: h } as never, { actor: 'user' }).result;
};
const a = mk(R, 'alpha');
const b = mk(R, 'bravo');
const c = mk(R2, 'charlie');
const T0 = 1_000_000;

console.log('\n[request: the engine words, frozen targets, group expansion]');
const s1 = so.request({ verb: 'reload', targets: [{ room: R.id, handle: '@alpha' }, { room: R.id, handle: 'alpha' }, { room: R2.id, handle: 'charlie' }] }, ON(), T0);
ok(s1.state === 'pending' && /^[0-9a-f]{12}$/.test(s1.id) && s1.expires_at === T0 + 10 * 60_000, 'pending, 12-hex id, expires in 10 minutes');
ok(s1.targets.length === 2 && s1.targets.map((t: any) => t.handle).join() === 'alpha,charlie', 'a repeated seat is one target; handles resolve with or without @');
ok(s1.text === 'Reload 2 seats: @alpha @charlie', 'the card words are the engine\'s, from verb + targets');
const sAll = so.request({ verb: 'compact', targets: [{ room: R.id, all: true }] }, ON(), T0);
ok(sAll.targets.length === 2 && sAll.text === 'Compact 2 seats: @alpha @bravo', '{room, all:true} expands server-side to every seat in the room');
fails(() => so.request({ verb: 'reload', targets: [{ room: R.id, handle: 'nobody' }] }, ON(), T0), 'bad_targets', 400, 'a seat that does not exist is refused, not skipped');
fails(() => so.request({ verb: 'reload', targets: [{ room: 'no-such', handle: 'x' }] }, ON(), T0), 'bad_targets', 400, 'a room that does not exist is refused');
fails(() => so.request({ verb: 'reload', targets: [] }, ON(), T0), 'bad_targets', 400, 'no targets is refused');
fails(() => so.request({ verb: 'explode', targets: [{ room: R.id, handle: 'alpha' }] }, ON(), T0), 'bad_verb', 400, 'an unknown verb is refused');
fails(() => so.request({ verb: 'reload', targets: [{ room: R.id, handle: 'alpha' }], args: { x: 1 } }, ON(), T0), 'bad_args', 400, 'a verb that takes no args refuses them');
fails(() => so.request({ verb: 'reload', targets: [{ room: R.id, handle: 'alpha' }] }, ON({ compactReload: false }), T0), 'action_off', 403, 'the allowed-action switch OFF refuses the request');

console.log('\n[inject: the card QUOTES the text, verbatim, labelled as the Concierge\'s]');
const inj = so.request({ verb: 'inject', targets: [{ room: R.id, handle: 'bravo' }], args: { text: 'run rm -rf /tmp/x\nthen "stop"' } }, ON(), T0);
ok(inj.text === 'Type into 1 seat: @bravo\nText from the Concierge: "run rm -rf /tmp/x\\nthen \\"stop\\""', 'exact text shown, JSON-quoted so nothing hides in it');
fails(() => so.request({ verb: 'inject', targets: [{ room: R.id, handle: 'bravo' }], args: { text: 'a', extra: 1 } }, ON(), T0), 'bad_args', 400, 'an extra arg that is not on the card is refused');
fails(() => so.request({ verb: 'inject', targets: [{ room: R.id, handle: 'bravo' }] }, ON(), T0), 'bad_args', 400, 'inject without text is refused');
fails(() => so.request({ verb: 'inject', targets: [{ room: R.id, handle: 'bravo' }], args: { text: 'x'.repeat(2001) } }, ON(), T0), 'bad_args', 400, 'inject text over 2000 characters is refused');

console.log('\n[at most 5 pending]');
fails(() => { for (let i = 0; i < 6; i++) so.request({ verb: 'reload', targets: [{ room: R.id, handle: 'alpha' }] }, ON(), T0); }, 'too_many_pending', 429, 'the 6th pending request is refused');
ok(so.list('pending', 50, T0).length === 5, '...five are waiting');

console.log('\n[answer: approve, cancel, once, voice only when proven]');
fails(() => so.answer(s1.id, 'maybe', 'owner', 'tap', false, T0 + 1), 'bad_answer', 400, 'answer is approve or cancel');
fails(() => so.answer(s1.id, 'approve', 'owner', 'voice', false, T0 + 1), 'voice_not_proven', 403, 'via voice without the host proof is refused');
fails(() => so.answer('ffffffffffff', 'approve', 'owner', 'tap', false, T0 + 1), 'no_such_signoff', 404, 'unknown id is 404');
const ap = so.answer(s1.id, 'approve', 'owner', undefined, false, T0 + 1000);
ok(ap.state === 'approved' && ap.answered_by === 'owner' && ap.via === 'tap' && ap.answered_at === T0 + 1000, 'approved, by whom, via tap (the default)');
fails(() => so.answer(s1.id, 'cancel', 'owner', 'tap', false, T0 + 2000), 'not_pending', 409, 'a second answer is 409 with the state');
const cx = so.answer(sAll.id, 'cancel', 'owner', 'tap', false, T0 + 1000);
ok(cx.state === 'cancelled', 'cancel');
ok(so.answer(inj.id, 'approve', 'owner', 'voice', true, T0 + 1000).via === 'voice', 'voice is recorded when the app host proved it');

console.log('\n[consume: single use, bound to the verb, frozen targets, expiry]');
fails(() => so.consume(sAll.id, 'compact', T0 + 5000), 'not_approved', 409, 'a cancelled sign-off cannot be consumed');
fails(() => so.consume(s1.id, 'compact', T0 + 5000), 'wrong_verb', 409, 'a different verb than the one approved is refused');
const used = so.consume(s1.id, 'reload', T0 + 5000);
ok(used.state === 'consumed' && used.consumed_at === T0 + 5000 && used.targets.length === 2, 'consumed once; the act gets the FROZEN targets');
fails(() => so.consume(s1.id, 'reload', T0 + 5001), 'not_approved', 409, 'a second use is refused (single use)');
const late = so.request({ verb: 'restore', targets: [{ room: R.id, handle: 'alpha' }] }, ON(), T0 + 20_000);
so.answer(late.id, 'approve', 'owner', 'tap', false, T0 + 21_000);
fails(() => so.consume(late.id, 'restore', T0 + 20_000 + 10 * 60_000 + 1), 'not_approved', 409, 'an approved sign-off past its expiry cannot be consumed');
ok(so.get(late.id, T0 + 20_000 + 10 * 60_000 + 1)!.state === 'expired', '...and reads as expired');
fails(() => so.answer(so.request({ verb: 'reload', targets: [{ room: R.id, handle: 'alpha' }] }, ON(), T0 + 30_000).id, 'approve', 'owner', 'tap', false, T0 + 30_000 + 10 * 60_000), 'not_pending', 409, 'answering a pending one after expiry is 409 (expired)');
so.recordResult(s1.id, { ok: true, results: [{ target: 'alpha', status: 'done' }] });
ok(so.get(s1.id, T0 + 6000)!.state === 'consumed' && (so.get(s1.id, T0 + 6000)!.result as any).ok === true, 'the result is recorded and the record stays consumed');

console.log('\n[the switches cancel]');
const t = T0 + 100_000_000;
const p1 = so.request({ verb: 'reload', targets: [{ room: R.id, handle: 'alpha' }] }, ON(), t);
const p2 = so.request({ verb: 'inject', targets: [{ room: R.id, handle: 'alpha' }], args: { text: 'hi' } }, ON(), t);
const p3 = so.request({ verb: 'start', targets: [{ room: R.id, handle: 'alpha' }] }, ON(), t);
so.answer(p3.id, 'approve', 'owner', 'tap', false, t);
so.cancelForSettings(true, ON({ inject: false }));
ok(so.get(p2.id, t)!.state === 'cancelled' && so.get(p1.id, t)!.state === 'pending' && so.get(p3.id, t)!.state === 'approved', 'an allowed-action OFF cancels only that verb\'s records');
so.cancelForSettings(true, ON({ startRestore: false }));
ok(so.get(p3.id, t)!.state === 'cancelled', '...including an approved one not yet used');
so.cancelForSettings(false, ON());
ok(so.get(p1.id, t)!.state === 'cancelled', 'the Concierge OFF cancels every pending one');

console.log('\n[retention]');
ok(so.prune(T0 + 100_000_000 + 31 * 24 * 3600_000) >= 1 && so.get(s1.id, T0) === undefined, 'answered records older than 30 days are pruned');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
