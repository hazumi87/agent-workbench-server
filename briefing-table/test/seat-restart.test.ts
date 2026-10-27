/**
 * Lead restart of a seat: the pure rules (src/engine/seat-restart.ts). The command and launch wiring is in
 * seat-restart-routes.test.mjs and room-commands.test.ts (parser fixtures).
 */
import {
  decideRestart, leadAuthority, restartMode, restartedFact, parseMeminfo, memoryGuard, seatRestartFrom, validSeatRestartPatch, SeatRestartError,
  RESTART_MIN_GAP_MS, SEAT_RESTART_DEFAULTS, type RestartFacts,
} from '../src/engine/seat-restart.ts';

let failed = 0;
let checks = 0;
const ok = (c: unknown, m: string) => {
  checks++;
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) failed++;
};
const section = (s: string) => console.log(`\n[${s}]`);

const roomy = { availableMb: 12000, swapTotalMb: 8000, swapFreeMb: 6000 };
const base = (o: Partial<RestartFacts> = {}): RestartFacts => ({
  byUser: false, byLeadOfRoom: true, targetIsLead: false, targetHandle: 'worker', targetState: 'killed', switching: false,
  lastRestartAt: null, now: 1_000_000_000, settings: { leadsRestartMembers: true }, mem: roomy, ...o,
});
const no = (f: RestartFacts) => { const d = decideRestart(f); return d.ok ? '' : d.error; };

section('who may restart');
ok(decideRestart(base()).ok, 'the lead restarts a killed member of its room (setting on, the default)');
ok(decideRestart(base({ byUser: true, byLeadOfRoom: false })).ok, 'the person always may');
ok(/user's/.test(no(base({ byLeadOfRoom: false }))), 'a plain member may not');
ok(/is off/.test(no(base({ settings: { leadsRestartMembers: false } }))), 'the lead is refused when the setting is off');
ok(decideRestart(base({ byUser: true, settings: { leadsRestartMembers: false } })).ok, 'the person ignores the setting');
ok(/only the user restarts the room lead/.test(no(base({ targetIsLead: true }))), 'the lead cannot restart the lead');
ok(decideRestart(base({ byUser: true, byLeadOfRoom: false, targetIsLead: true })).ok, 'the person may restart the lead');

section('which seats');
ok(decideRestart(base({ targetState: 'dehydrated' })).ok && decideRestart(base({ targetState: 'none' })).ok, 'dehydrated and pane-less seats may be restarted');
ok(/is live; end it first/.test(no(base({ targetState: 'live' }))), 'a live seat is refused with "end it first"');
ok(/is live/.test(no(base({ byUser: true, targetState: 'live' }))), 'even for the person (a forced restart is a later step)');
ok(/being switched/.test(no(base({ switching: true }))), 'a seat whose assistant is being switched is refused');
ok(/not in a state/.test(no(base({ targetState: 'other' }))), 'an unknown state is refused');

section('family scope: the room-lead pointer decides (item row 7)');
const FAM = [
  { id: 'main', parent_id: null, lead_seat: 'pl' },
  { id: 'plan', parent_id: 'main', lead_seat: 'steward' },
  { id: 'build', parent_id: 'main', lead_seat: 'pm' },
];
const A = (actor: string, target: string, targetRoom: string) => leadAuthority({ actorSeatId: actor, targetSeatId: target, targetRoomId: targetRoom, family: FAM });
ok(A('pl', 'builder-1', 'build').byLead && !A('pl', 'builder-1', 'build').targetIsLead, 'the main-room lead restarts a seat in a group');
ok(A('pl', 'pm', 'build').byLead && !A('pl', 'pm', 'build').targetIsLead, 'the main-room lead restarts a group LEAD (the person\'s ruling: the lead starts its team)');
ok(!A('pl', 'pl2', 'main').targetIsLead && A('pl', 'pl2', 'main').byLead, 'the main-room lead restarts a plain seat of its own room');
ok(A('pm', 'builder-1', 'build').byLead, 'a group lead restarts a seat of its own group');
ok(!A('pm', 'draftsman', 'plan').byLead, 'a group lead may NOT restart a seat in another group');
ok(!A('pm', 'pl2', 'main').byLead, 'a group lead may NOT restart a seat in the main room');
ok(A('pm', 'pl', 'main').targetIsLead && !A('pm', 'pl', 'main').byLead, 'nobody below restarts the main-room lead');
ok(A('pl', 'pl', 'main').targetIsLead, 'the main-room lead is protected from every lead authority, itself included');
ok(A('pm', 'pm', 'build').targetIsLead, 'a group lead is protected from its own group lead authority (only the person or the main lead)');
ok(!A('plain', 'builder-1', 'build').byLead && !A('plain', 'pm', 'build').byLead, 'a seat that leads nothing has no lead authority');
ok(A('steward', 'pm', 'build').targetIsLead && !A('steward', 'pm', 'build').byLead, 'one group lead cannot restart another group lead');
const lead2 = [{ id: 'main', parent_id: null, lead_seat: 'x' }, { id: 'g', parent_id: 'main', lead_seat: 'x' }];
ok(leadAuthority({ actorSeatId: 'x', targetSeatId: 'y', targetRoomId: 'g', family: lead2 }).byLead, 'a lead that sits in a team still acts by its lead pointer ([ref])');

section('a first start is not a restart');
const tf = 1_000_000_000;
ok(decideRestart(base({ lastRestartAt: tf - 1000, now: tf, firstStart: true })).ok, 'the 10-minute gap does not apply to a first start');
ok(/min ago/.test(no(base({ lastRestartAt: tf - 1000, now: tf, firstStart: false }))), 'but it does to a restart');
ok(/is live/.test(no(base({ targetState: 'live', firstStart: true }))), 'a first start still obeys the other rules');
ok(/short of memory/.test(no(base({ firstStart: true, mem: { ...roomy, availableMb: 100 } }))), 'and the memory guard (it is the limit for a first start)');

section('rate limit');
const t0 = 1_000_000_000;
ok(/3 min ago.*try in 7 min/.test(no(base({ lastRestartAt: t0 - 3 * 60_000, now: t0 }))), 'the lead: a second restart 3 min later is refused and says when to retry');
ok(decideRestart(base({ lastRestartAt: t0 - RESTART_MIN_GAP_MS, now: t0 })).ok, 'after 10 min it may');
ok(decideRestart(base({ byUser: true, lastRestartAt: t0 - 1000, now: t0 })).ok, 'the person is not rate limited');

section('memory guard');
ok(/short of memory \(1200 MB available/.test(no(base({ mem: { ...roomy, availableMb: 1200 } }))), 'low available memory refuses, with the number');
ok(/swapping heavily \(90%/.test(no(base({ mem: { availableMb: 9000, swapTotalMb: 8000, swapFreeMb: 800 } }))), 'heavy swap refuses, with the percentage');
ok(decideRestart(base({ mem: null })).ok, 'no meminfo (not Linux): the guard does not apply');
ok(/short of memory/.test(no(base({ byUser: true, mem: { ...roomy, availableMb: 100 } }))), 'it applies to the person too (a start is a memory cost)');
ok(decideRestart(base({ mem: { availableMb: 9000, swapTotalMb: 0, swapFreeMb: 0 } })).ok, 'a machine with no swap is judged on available memory alone');
const mi = parseMeminfo('MemTotal:       32731464 kB\nMemFree:         1000000 kB\nMemAvailable:   20400000 kB\nSwapTotal:       8388604 kB\nSwapFree:        1400000 kB\n');
ok(mi?.availableMb === 19921 && mi?.swapTotalMb === 8191 && mi?.swapFreeMb === 1367, 'parseMeminfo reads MemAvailable and swap');
ok(parseMeminfo('nothing here') === null, 'parseMeminfo: no MemAvailable is null');
ok(/swapping/.test(memoryGuard(mi) ?? ""), "and that machine (83% swap) is refused for swapping");

section('how a seat comes back');
const U = '01a16cb8-1234-4abc-8def-0123456789ab';
ok(JSON.stringify(restartMode('claude-code', U)) === JSON.stringify({ resumeSessionId: U }), 'a Claude seat with a banked conversation resumes it');
ok(JSON.stringify(restartMode('claude-code', null)) === '{"fresh":true}', 'a Claude seat with none starts fresh');
ok(JSON.stringify(restartMode('codex-cli', U)) === '{"fresh":true}', 'a Codex seat starts fresh (no resume today)');
ok(JSON.stringify(restartMode('claude-code', 'not-a-uuid')) === '{"fresh":true}', 'a malformed id is never passed on');
ok(/resuming its conversation/.test(restartedFact('w', '@boss', 'resume')) && /no memory of before/.test(restartedFact('w', '@boss', 'fresh')), 'the fact says which');

section('the setting');
ok(SEAT_RESTART_DEFAULTS.leadsRestartMembers === true && seatRestartFrom(undefined).leadsRestartMembers === true, 'default ON');
ok(seatRestartFrom({ leadsRestartMembers: false }).leadsRestartMembers === false, 'stored OFF is read back OFF');
ok(seatRestartFrom('garbage').leadsRestartMembers === true, 'unreadable falls to the default');
ok(validSeatRestartPatch({ leadsRestartMembers: false }).leadsRestartMembers === false, 'a boolean patch is accepted');
for (const bad of [{}, { leadsRestartMembers: 'yes' }, { nope: 1 }, null, []]) {
  let threw = false;
  try { validSeatRestartPatch(bad); } catch (e) { threw = e instanceof SeatRestartError; }
  ok(threw, `rejected: ${JSON.stringify(bad)}`);
}

console.log(`PASS ${checks - failed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
