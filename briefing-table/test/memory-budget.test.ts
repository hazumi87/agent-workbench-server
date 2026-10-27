/** Item 3, pure half: the verdict from fake memory facts, and which seat sleeps. */
import { assess, pickToSleep, MEMORY_DEFAULTS } from '../src/engine/memory-budget.ts';

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
const GB = 1024 ** 3;

ok(MEMORY_DEFAULTS.sleepAt === 0.7 && MEMORY_DEFAULTS.refuseAt === 0.85, 'defaults are 70 / 85');
ok(assess({ usedBytes: 1 * GB, freeBytes: 10 * GB, jobCapBytes: 2 * GB }).level === 'ok', 'half the job cap: ok');
ok(assess({ usedBytes: 1.4 * GB, freeBytes: 10 * GB, jobCapBytes: 2 * GB }).level === 'sleep', '70% of the job cap: sleep');
ok(assess({ usedBytes: 1.7 * GB, freeBytes: 10 * GB, jobCapBytes: 2 * GB }).level === 'refuse', '85% of the job cap: refuse');
const small = assess({ usedBytes: 1 * GB, freeBytes: 0.1 * GB, jobCapBytes: 2 * GB });
ok(Math.round(small.budgetBytes! / 1e6) === Math.round(1.1 * GB / 1e6) && small.level === 'refuse', 'a PC with little free memory shrinks the budget below the job cap');
ok(assess({ usedBytes: 6 * GB, freeBytes: 10 * GB, jobCapBytes: null }).level === 'ok', 'no job cap: the PC alone sets the budget');
const rf = assess({ usedBytes: 1.8 * GB, freeBytes: 9 * GB, jobCapBytes: 2 * GB });
ok(rf.numbers === '1843 MB of 2048 MB in use (90%)' && rf.text === 'agents are using too much memory to start another: 1843 MB of 2048 MB in use (90%), the limit is 85%. Sleep or end an agent, then try again.', 'the refusal is exactly this sentence: the numbers, the limit, what to do next');
ok(assess(null).numbers === null, 'unknown has no numbers');
for (const bad of [null, { usedBytes: NaN, freeBytes: 1, jobCapBytes: null }, { usedBytes: 1, freeBytes: -1, jobCapBytes: null }, { usedBytes: 0, freeBytes: 0, jobCapBytes: null }]) {
  const v = assess(bad as any);
  ok(v.level === 'unknown' && v.fraction === null && /could not be measured/.test(v.text), `unmeasurable (${JSON.stringify(bad)}) says so, never ok or refuse`);
}
ok(assess({ usedBytes: 1.4 * GB, freeBytes: 10 * GB, jobCapBytes: 2 * GB }, { sleepAt: 0.9, refuseAt: 0.95 }).level === 'ok', 'thresholds are passed in');

/* commit vs resident (client [ref]): the job cap is a COMMIT limit, the PC's free memory is PHYSICAL. Each is compared with its own kind. */
const split = assess({ usedBytes: 1.8 * GB, residentBytes: 0.6 * GB, freeBytes: 8 * GB, jobCapBytes: 2 * GB });
ok(split.level === 'refuse' && Math.round(split.fraction! * 100) === 90, 'commit against the cap decides when the PC has plenty: 1.8 of 2 GB commit is 90%');
const pcTight = assess({ usedBytes: 0.5 * GB, residentBytes: 0.5 * GB, freeBytes: 0.05 * GB, jobCapBytes: 2 * GB });
ok(pcTight.level === 'refuse', 'resident against free physical memory decides when the PC is tight: 0.5 of 0.55 GB is 91%');
const loose = assess({ usedBytes: 1.2 * GB, residentBytes: 0.4 * GB, freeBytes: 8 * GB, jobCapBytes: 2 * GB });
ok(loose.level === 'ok', 'a big commit that is mostly paged out is judged on both: 60% of the cap, 5% of the PC: ok');
ok(assess({ usedBytes: 1.4 * GB, freeBytes: 10 * GB, jobCapBytes: 2 * GB }).level === 'sleep', 'no residentBytes: it is the same number (older reports keep working)');
ok(assess({ usedBytes: 1, residentBytes: -1, freeBytes: 1, jobCapBytes: null }).level === 'unknown', 'a bad residentBytes is unmeasurable, not ignored');
ok(/commit/.test(split.text) || /MB of .* MB in use/.test(split.text), 'the refusal still carries the numbers');

ok(pickToSleep([{ id: 'a', idleMs: 5, neverRest: false }, { id: 'b', idleMs: 90, neverRest: false }, { id: 'c', idleMs: 40, neverRest: false }]) === 'b', 'the least recently active idle seat');
ok(pickToSleep([{ id: 'a', idleMs: 500, neverRest: true }, { id: 'b', idleMs: 90, neverRest: false }]) === 'b', 'never one that is working, waiting or holding a draft, however long it has been quiet');
ok(pickToSleep([{ id: 'a', idleMs: 500, neverRest: true }]) === null, 'nothing may rest: null');
ok(pickToSleep([{ id: 'z', idleMs: 7, neverRest: false }, { id: 'a', idleMs: 7, neverRest: false }]) === 'a', 'ties go to the lowest id');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
