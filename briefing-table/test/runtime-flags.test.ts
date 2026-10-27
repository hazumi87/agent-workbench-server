/**
 * RUNTIME SWITCHES (src/engine/runtime-flags.ts; the design notes §5.3,
 * F22) [ticket].
 *
 *  - no file → every switch at its safe default;
 *  - a flip is picked up on the next read with no restart (mtime change);
 *  - only the exact literal turns a switch on;
 *  - an unparseable file → safe defaults (never the last good value), logged;
 *  - every transition is logged once, with the mtime; an unchanged file logs
 *    nothing.
 * (/health `flags` is asserted through a real engine in assemble.test.mjs.)
 *
 * SAFETY: a temp config file via HARBOR_WB_CONFIG, set BEFORE import. Run
 * with tsx.
 */
import { mkdtempSync, rmSync, writeFileSync, utimesSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wb-runtime-flags-'));
const cfg = join(dir, 'config.json');
process.env.HARBOR_WB_CONFIG = cfg;

const flags = await import('../src/engine/runtime-flags.ts');

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
const logs: string[] = [];
flags.setLog((l) => logs.push(l));

let tick = 1_700_000_000;
/** Write the file with a distinct mtime (two writes in one ms share one). */
function write(text: string): void {
  writeFileSync(cfg, text);
  tick += 10;
  utimesSync(cfg, tick, tick);
}

console.log('\n[no config.json → safe defaults]');
eq(flags.runtimeFlag('seatRestorable'), false, 'seatRestorable off');
eq(flags.runtimeFlag('upgrade'), false, 'upgrade off');
eq(flags.runtimeFlag('collisionGuard'), 'enforce', 'collisionGuard enforce');
eq(logs.length, 0, 'nothing logged: nothing moved');

console.log('\n[a flip is read live, no restart]');
write(JSON.stringify({ reapMs: 0, seatRestorable: true }));
eq(flags.runtimeFlag('seatRestorable'), true, 'seatRestorable on after the file changed');
eq(logs.length, 1, 'one transition logged');
eq(/switch seatRestorable: false → true \(config\.json mtime \d{4}-/.test(logs[0] ?? ''), true, 'naming the switch, old → new and the mtime');
flags.runtimeFlag('seatRestorable');
flags.all();
eq(logs.length, 1, 'rereading an unchanged file logs nothing');
write(JSON.stringify({ seatRestorable: true, upgrade: true, collisionGuard: 'warn' }));
const a = flags.all();
eq(a.upgrade, true, 'upgrade on');
eq(a.collisionGuard, 'warn', 'collisionGuard warn');
eq(logs.length, 3, 'two more transitions, one line each');

console.log('\n[only the exact literal turns a switch on]');
write(JSON.stringify({ seatRestorable: 'true', upgrade: 1, collisionGuard: 'WARN' }));
const b = flags.all();
eq(b.seatRestorable, false, '"true" (a string) is not true');
eq(b.upgrade, false, '1 is not true');
eq(b.collisionGuard, 'enforce', '"WARN" is not "warn"');

console.log('\n[unparseable → safe defaults, never the last good value]');
write(JSON.stringify({ seatRestorable: true, upgrade: true }));
eq(flags.runtimeFlag('upgrade'), true, 'on again');
const before = logs.length;
write('{ "seatRestorable": true, "upgrade": tru');
eq(flags.runtimeFlag('upgrade'), false, 'a typo turns it OFF, not "still on"');
eq(flags.runtimeFlag('seatRestorable'), false, 'every switch, not just the one near the typo');
eq(logs.slice(before).some((l) => /unparseable/.test(l)), true, 'the parse failure is logged');
write('[1, 2]');
eq(flags.runtimeFlag('collisionGuard'), 'enforce', 'a JSON array is not a config: defaults');
write(JSON.stringify({ collisionGuard: 'warn' }));
eq(flags.runtimeFlag('collisionGuard'), 'warn', 'a good file is read again');
unlinkSync(cfg);
eq(flags.runtimeFlag('collisionGuard'), 'enforce', 'the file deleted → defaults');
eq(/collisionGuard: warn → enforce \(config\.json mtime missing\)/.test(logs[logs.length - 1] ?? ''), true, 'logged as missing');

flags.reset();
rmSync(dir, { recursive: true, force: true });
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
