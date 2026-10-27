/**
 * The rule that decides whether a finished session can come back.
 *
 * This exists because getting it wrong is expensive and silent: on 2026-08-24 a
 * 12h idle timer fired when Owner's laptop lid closed, five live agent sessions
 * were stamped `killed`, and reopening them minted brand-new empty
 * conversations. The transcripts were fine the whole time — only the ROW was
 * wrong. These assertions are what stop that returning.
 *
 * Run with tsx (the rule is TS and imports the vendor module).
 */
import { endStateFor } from '../src/engine/end-state.ts';

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, msg: string): void {
  if (Object.is(actual, expected)) {
    passed += 1;
    console.log(`  ✓ ${msg} (${String(actual)})`);
  } else {
    failed += 1;
    console.log(`  ✗ ${msg} — expected ${String(expected)}, got ${String(actual)}`);
  }
}

console.log('\n[a session the USER ended stays ended]');
eq(endStateFor('user', 'claude-code'), 'killed', 'explicit end of a claude session');
eq(endStateFor('user', 'cli-manager'), 'killed', 'explicit end of a plain shell');
eq(endStateFor(undefined, 'claude-code'), 'killed',
  'an exit with no recorded reason is NOT treated as reaped');

console.log('\n[a session WE reaped comes back if the vendor can resume]');
eq(endStateFor('reaped', 'claude-code'), 'dehydrated',
  'reaped claude session is filed restorable');

console.log('\n[a room Disconnect (cycle) is filed restorable, like reaped]');
eq(endStateFor('cycle', 'claude-code'), 'dehydrated', 'cycled claude session comes back on reconnect');
eq(endStateFor('cycle', 'cli-manager'), 'killed', 'cycled bare shell has nothing to resume');

console.log('\n[but only if there is something to resume]');
eq(endStateFor('reaped', 'cli-manager'), 'killed',
  'reaped bare shell has no conversation, so it is not faked as restorable');
eq(endStateFor('reaped', null), 'killed', 'reaped row with no vendor recorded');
eq(endStateFor('reaped', ''), 'killed', 'reaped row with an empty vendor');

console.log(`\n${'='.repeat(40)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
