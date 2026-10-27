/* The app-behavior pref [room switch]: default stay, validated, guarded. node test/app-behavior-pref.test.mjs */
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  + ${m}`); } else { fail += 1; console.log(`  X ${m}`); } };
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); } };
const { getSwitchMode, setSwitchMode, parseSwitchMode, SWITCH_DEFAULT } = await import('../web/app-behavior-pref.mjs');
ok(SWITCH_DEFAULT === 'stay' && getSwitchMode() === 'stay', 'nothing stored: the app stays (the default)');
ok(setSwitchMode('reopen') === 'reopen' && getSwitchMode() === 'reopen', 'reopen is saved and read back');
ok(parseSwitchMode('nonsense') === 'stay' && parseSwitchMode(undefined) === 'stay' && parseSwitchMode('stay') === 'stay', 'an unknown value reads as stay');
ok(setSwitchMode('bogus') === 'stay' && getSwitchMode() === 'stay', 'writing an unknown value stores stay');
globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
ok(getSwitchMode() === 'stay' && setSwitchMode('reopen') === 'reopen', 'a blocked storage never throws: reads stay, the write is a no-op');
console.log(`PASS ${pass} FAIL ${fail}`);
process.exit(fail ? 1 : 0);
