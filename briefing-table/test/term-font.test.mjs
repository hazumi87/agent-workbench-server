/**
 * Unit tests for the terminal font storage contract (web/term-font.mjs).
 *
 * These cover the DECISION, which is where the bug lived: font size was a
 * per-session value that followed a session between machines. The rule under
 * test is "the device owns its size, the engine only seeds a device that has
 * no opinion" — and in particular that an engine pref arriving later (every
 * reattach re-sends pane.ready) must NOT override a device that has spoken.
 *
 * No framework (Crawl: minimal deps), matching test/link-sweep.test.mjs.
 */
import {
  clampPx, loadDeviceFont, saveDeviceFont, resolveFont, KEY, FONT_MIN, FONT_MAX, FONT_DEFAULT,
} from '../web/term-font.mjs';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${msg}`);
  }
}
function eq(actual, expected, msg) {
  ok(Object.is(actual, expected), `${msg} (got ${JSON.stringify(actual)})`);
}

/* A minimal localStorage stand-in; the module must also survive it THROWING,
   which is what a private window or blocked site data actually does. */
function installStorage(mode = 'ok') {
  const map = new Map();
  globalThis.localStorage = {
    getItem(k) {
      if (mode === 'throw') {
        throw new Error('SecurityError: storage disabled');
      }
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (mode === 'throw') {
        throw new Error('QuotaExceededError');
      }
      map.set(k, v);
    },
  };
  return map;
}

console.log('\n[clamping]');
eq(clampPx(16), 16, 'a normal size passes through');
eq(clampPx(2), FONT_MIN, 'below the floor clamps up');
eq(clampPx(999), FONT_MAX, 'above the ceiling clamps down');
eq(clampPx(15.4), 15, 'fractional sizes round');
eq(clampPx('nonsense'), FONT_DEFAULT, 'garbage falls back to the default');
eq(clampPx(undefined), FONT_DEFAULT, 'undefined falls back to the default');
eq(clampPx(NaN), FONT_DEFAULT, 'NaN falls back to the default (not clamped to the floor)');

console.log('\n[device store]');
installStorage();
eq(loadDeviceFont(), null, 'a fresh device has NO opinion');
ok(saveDeviceFont(15), 'saving succeeds');
eq(loadDeviceFont().px, 15, 'the saved size reads back');
saveDeviceFont(999);
eq(loadDeviceFont().px, FONT_MAX, 'a stored size is clamped on the way back out');

const map = installStorage();
map.set(KEY, 'not json at all');
eq(loadDeviceFont(), null, 'corrupt stored data reads as no-opinion, not a crash');
map.set(KEY, JSON.stringify({ v: 1 }));
eq(loadDeviceFont(), null, 'a record with no px reads as no-opinion');

installStorage('throw');
eq(loadDeviceFont(), null, 'storage that THROWS reads as no-opinion');
eq(saveDeviceFont(14), false, 'storage that THROWS reports the save failed');

console.log('\n[resolution: the device owns its size, the engine seeds it]');
let r = resolveFont(null, 17);
eq(r.px, 17, 'no device opinion -> the engine pref seeds the size');
eq(r.fromDevice, false, 'and the pane stays open to later engine prefs');

r = resolveFont({ v: 1, px: 15 }, 17);
eq(r.px, 15, 'a device opinion BEATS the engine pref');
eq(r.fromDevice, true, 'and locks out later engine prefs');

r = resolveFont(null, null);
eq(r.px, FONT_DEFAULT, 'neither side has a value -> the default');
eq(r.fromDevice, false, 'still open to a later engine pref');

r = resolveFont(null, undefined);
eq(r.px, FONT_DEFAULT, 'an absent engine pref behaves like null');

/* The regression that motivated all of this: the laptop picks 15, then a
   reattach re-delivers the VRPC's 17 in pane.ready. The laptop must stay 15. */
r = resolveFont({ v: 1, px: 15 }, 17);
ok(r.px === 15 && r.fromDevice === true,
  'a reattach re-delivering the other machine’s size does not move this device');

console.log(`\n${'='.repeat(40)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
