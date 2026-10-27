/**
 * IDLE REST policy (Owner 2026-10-04, item 6): the pure rules in
 * src/engine/idle-rest.ts. No db, no engine. Run with tsx.
 *   - off by default: no setting, nothing rests;
 *   - a member rests after memberHours idle; a lead after leadHours, and only when
 *     the WHOLE room is idle (the last to go);
 *   - a seat that is working / blocked / not live is never picked;
 *   - the wake rules (a lead wakes its members; another room wakes a lead);
 *   - the offline notices' wording; validation of a PATCH.
 */
import { IDLE_REST_DEFAULTS, idleRestFrom, validIdleRestPatch, restPlan, restFact, spanWords, mayWake, offlineNotice, IdleRestError } from '../src/engine/idle-rest.ts';
import type { RestSeat, IdleRestSettings } from '../src/engine/idle-rest.ts';

let passed = 0;
let failed = 0;
function eq(a: unknown, b: unknown, msg: string): void {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x === y) {
    passed++;
    console.log(`  + ${msg}`);
  } else {
    failed++;
    console.log(`  X ${msg} (got ${x}, want ${y})`);
  }
}
const H = 3_600_000;
const on = (o: Partial<IdleRestSettings>): IdleRestSettings => ({ ...IDLE_REST_DEFAULTS, ...o });
const seat = (id: string, o: Partial<RestSeat> = {}): RestSeat => ({ id, handle: id, isLead: false, live: true, idleMs: 0, ...o });
const picks = (seats: RestSeat[], s: IdleRestSettings, others: RestSeat[] = []) => restPlan(seats, s, others).map((p) => `${p.handle}:${p.kind}`);

console.log('\n[off by default]');
eq(IDLE_REST_DEFAULTS, { restEnabled: false, restMinutes: 15, memberHours: null, leadHours: null, leadsWakeMembers: false, roomsWakeLeads: false, backgroundGuard: false }, 'every setting is off or unset');
eq(picks([seat('a', { idleMs: 999 * H }), seat('boss', { isLead: true, idleMs: 999 * H })], IDLE_REST_DEFAULTS), [], 'nothing rests with the defaults, however idle');
eq(idleRestFrom(undefined), IDLE_REST_DEFAULTS, 'never stored: the defaults');
eq(idleRestFrom({ memberHours: 'x', leadHours: -3, leadsWakeMembers: 1 }), IDLE_REST_DEFAULTS, 'an unreadable stored value falls to the default');

console.log('\n[members]');
const s24 = on({ memberHours: 24 });
eq(picks([seat('a', { idleMs: 23 * H })], s24), [], 'idle 23 h of 24: stays');
eq(picks([seat('a', { idleMs: 24 * H })], s24), ['a:member'], 'idle 24 h: rests');
eq(picks([seat('a', { idleMs: 90 * H }), seat('b', { idleMs: 1 * H })], s24), ['a:member'], 'only the idle member rests');
eq(picks([seat('a', { idleMs: null })], s24), [], 'working / waiting / draft / ask (idleMs null): never');
eq(picks([seat('a', { live: false, idleMs: 99 * H })], s24), [], 'not live: nothing to rest');
eq(picks([seat('boss', { isLead: true, idleMs: 99 * H })], s24), [], 'a lead is not a member: the member period never rests it');

console.log('\n[leads: the last to go]');
const sl = on({ memberHours: 24, leadHours: 168 });
eq(picks([seat('boss', { isLead: true, idleMs: 200 * H }), seat('a', { idleMs: 50 * H })], sl), ['a:member'], 'a member rests first; the lead stays while one is live (idle 50 h < 7 d)');
eq(picks([seat('boss', { isLead: true, idleMs: 200 * H }), seat('a', { live: false })], sl), ['boss:lead'], 'every other seat resting: the lead rests at 7 d');
eq(picks([seat('boss', { isLead: true, idleMs: 167 * H }), seat('a', { live: false })], sl), [], 'lead idle 167 h of 168: stays');
eq(picks([seat('boss', { isLead: true, idleMs: 200 * H }), seat('a', { idleMs: null })], sl), [], 'a working member keeps the lead up');
eq(picks([seat('boss', { isLead: true, idleMs: 200 * H }), seat('a', { idleMs: 100 * H })], on({ leadHours: 168 })), [], 'members still live and only idle 100 h: the lead waits (its clock starts when the room is idle)');
eq(picks([seat('boss', { isLead: true, idleMs: 200 * H }), seat('a', { idleMs: 180 * H })], on({ leadHours: 168 })), ['boss:lead'], 'members idle past the lead period too (member rest off): the lead may go');
eq(picks([seat('boss', { isLead: true, idleMs: 200 * H })], on({ memberHours: 24 })), [], 'lead period unset: a lead never rests');
eq(picks([seat('boss', { isLead: true, idleMs: 200 * H }), seat('a', { live: false })], sl, [seat('w1', { idleMs: 10 * H })]), [], "a workgroup seat still live keeps the main room's lead up");
eq(picks([seat('boss', { isLead: true, idleMs: 200 * H }), seat('a', { live: false })], sl, [seat('w1', { live: false })]), ['boss:lead'], 'workgroup resting too: the lead goes');

console.log('\n[the wake rules]');
const lead = { seatId: 'boss', roomId: 'r1', isLead: true };
const member = { seatId: 'a', roomId: 'r1', isLead: false };
const other = { seatId: 'x', roomId: 'r2', isLead: false };
const user = { seatId: null, roomId: null, isLead: false };
const tgtMember = { roomId: 'r1', isLead: false };
const tgtLead = { roomId: 'r1', isLead: true };
eq(mayWake(IDLE_REST_DEFAULTS, lead, tgtMember), false, 'toggles off: a lead cannot wake a member');
eq(mayWake(on({ leadsWakeMembers: true }), lead, tgtMember), true, 'leadsWakeMembers: the room lead wakes a member');
eq(mayWake(on({ leadsWakeMembers: true }), member, tgtMember), false, 'a non-lead cannot');
eq(mayWake(on({ leadsWakeMembers: true }), { ...lead, roomId: 'r2' }, tgtMember), false, "a lead of ANOTHER room cannot wake this room's member");
eq(mayWake(on({ leadsWakeMembers: true }), user, tgtMember), false, 'a user line wakes nothing (the user has Restore)');
eq(mayWake(IDLE_REST_DEFAULTS, other, tgtLead), false, 'roomsWakeLeads off: another room cannot wake a lead');
eq(mayWake(on({ roomsWakeLeads: true }), other, tgtLead), true, 'roomsWakeLeads: a seat of another room wakes the lead');
eq(mayWake(on({ roomsWakeLeads: true }), member, tgtLead), false, 'its own room does not use this rule');
eq(mayWake(on({ roomsWakeLeads: true }), user, tgtLead), false, 'the user is not another room');
eq(mayWake(on({ roomsWakeLeads: true }), other, tgtMember), false, 'the lead rule never wakes a non-lead');

console.log('\n[the offline notices]');
eq(offlineNotice({ handle: 'worker', isLead: false, leadHandle: 'boss', leadLive: true }), '@worker is offline — contact the room lead @boss', 'member offline, lead up');
eq(offlineNotice({ handle: 'worker', isLead: false, leadHandle: 'boss', leadLive: false }), '@worker and the room lead @boss are offline — contact your lead or the user', 'member and lead offline');
eq(offlineNotice({ handle: 'boss', isLead: true, leadHandle: null, leadLive: false }), '@boss is offline — ask the user to bring it back', 'the lead itself');
eq(offlineNotice({ handle: 'worker', isLead: false, leadHandle: null, leadLive: false }), '@worker is offline — ask the user to bring it back', 'a room with no lead');

console.log('\n[wording and validation]');
eq(spanWords(24 * H), '24 h', '24 h');
eq(spanWords(7 * 24 * H), '7 d', '7 d');
eq(restFact('worker', 25 * H), '@worker is resting (idle 25 h)', 'the room fact');
eq(validIdleRestPatch({ memberHours: 24, leadHours: null, leadsWakeMembers: true }), { memberHours: 24, leadHours: null, leadsWakeMembers: true }, 'a good patch');
for (const bad of [{ memberHours: 0 }, { memberHours: 24 * 366 }, { leadHours: '7' }, { roomsWakeLeads: 1 }, { backgroundGuard: 'on' }, { nope: true }, {}, null, [1]]) {
  let code = 'accepted';
  try {
    validIdleRestPatch(bad);
  } catch (e) {
    code = e instanceof IdleRestError ? 'refused' : 'threw';
  }
  eq(code, 'refused', `refused: ${JSON.stringify(bad)}`);
}

/* ---- backgroundGuard (the design notes) ---- */
import { mayRest, backgroundHolds, BACKGROUND_GUARD_CAP_MS } from '../src/engine/idle-rest.ts';
{
  const NOW = 100 * H;
  const base = { state: 'idle', resumable: true, draft: false, held: 0, blocked: false, lastActiveAt: 0 };
  const work = { shells: 1, agents: 0, other: false };
  eq(mayRest(base, 15, NOW, 0), true, 'baseline: a long-quiet idle pane rests');
  eq(mayRest({ ...base, backgroundWork: work, backgroundSince: NOW - H }, 15, NOW, 0), true, 'guard OFF (default): detected work changes nothing');
  eq(mayRest({ ...base, backgroundGuard: true, backgroundWork: work, backgroundSince: NOW - H }, 15, NOW, 0), false, 'guard ON + detected shell: not rested');
  eq(mayRest({ ...base, backgroundGuard: true, backgroundWork: { shells: 0, agents: 2, other: false }, backgroundSince: NOW }, 15, NOW, 0), false, 'guard ON + detected agents: not rested');
  eq(mayRest({ ...base, backgroundGuard: true, backgroundWork: { shells: 0, agents: 0, other: false } }, 15, NOW, 0), true, 'guard ON + seen, nothing running: rests');
  eq(mayRest({ ...base, backgroundGuard: true, backgroundWork: null }, 15, NOW, 0), true, 'guard ON + cannot tell: today\'s behaviour (rests)');
  eq(mayRest({ ...base, backgroundGuard: true, backgroundWork: work, backgroundSince: NOW - BACKGROUND_GUARD_CAP_MS - 1 }, 15, NOW, 0), true, 'past the cap the guard lets go');
  eq(backgroundHolds({ ...base, backgroundGuard: true, backgroundWork: work, backgroundSince: NOW - BACKGROUND_GUARD_CAP_MS + 1000 }, NOW), true, 'just inside the cap still holds');
  eq(validIdleRestPatch({ backgroundGuard: true }), { backgroundGuard: true }, 'backgroundGuard is PATCHable');
  eq(idleRestFrom({ backgroundGuard: true }).backgroundGuard, true, 'stored true reads back');
  eq(idleRestFrom({ backgroundGuard: 'yes' }).backgroundGuard, false, 'junk reads back as off');
}

console.log(`\nPASS ${passed}  FAIL ${failed}`);
process.exit(failed ? 1 : 0);
