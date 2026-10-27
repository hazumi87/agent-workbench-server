/**
 * PLUGIN GATE (src/server/modules/plugin-gate.ts; ported from workbench-app test/plugin-gate.test.mjs; the design notes C2-C4): the engine's
 * decisions for a module, pure. Bundled modules keep today's behaviour and run their main in the app page. A user module (a hand-placed folder or a zip)
 * never runs main in the app page, is on only with a consent record that matches what is on disk now, cannot be switched on without one, and is allowed
 * only with a pin equal to the hash computed now. Off never asks.
 */
import { isDeepStrictEqual } from 'node:util';
import * as G from '../src/server/modules/plugin-gate.ts';
import * as C from '../src/server/modules/consent.ts';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
function same(actual: unknown, want: unknown, msg: string): void {
  if (isDeepStrictEqual(actual, want)) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}: got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`); }
}

const HASH = 'c'.repeat(64), HASH2 = 'd'.repeat(64);
const NOW = '2026-10-26T04:00:00.000Z';
const bundled: G.GateModule = { id: 'hello-tool', source: 'bundled', name: 'Hello Tool', permissions: ['storage'], defaultEnabled: true, core: false };
const plug = (o: Partial<G.GateModule> = {}): G.GateModule => ({ id: 'notes-plus', source: 'user', name: 'Notes Plus', permissions: ['storage', 'microphone'], defaultEnabled: true, core: false, folderHash: HASH, installSeq: 2, ...o });
const recFor = (m: G.GateModule): C.ConsentRecord => C.makeRecord({ man: { permissions: m.permissions }, folderHash: HASH, installSeq: 2 }, NOW);

console.log('\n[bundled: unchanged, default on, runs main in the app page]');
same(G.gateEntry(bundled, undefined), { enabled: true, runMain: true, consent: null }, 'default on');
ok(G.gateEntry(bundled, { enabled: false }).enabled === false, 'the person can turn it off');
ok(G.gateEntry({ ...bundled, core: true }, { enabled: false }).enabled === true, 'a core module is always on');

console.log('\n[a user module never runs main in the app page, even when allowed]');
{
  const g = G.gateEntry(plug(), { enabled: true, consent: recFor(plug()) });
  same([g.enabled, g.runMain, g.consent?.state], [true, false, 'ok'], 'allowed, no main');
}

console.log('\n[a user module is off without a record, whatever config.enabled says, and shows why]');
for (const cfg of [undefined, {}, { enabled: true }, { enabled: true, consent: { forged: true } }]) {
  const g = G.gateEntry(plug(), cfg);
  ok(g.enabled === false && g.consent?.chip === 'Needs your OK', JSON.stringify(cfg));
}

console.log('\n[an allowed module is held again by a changed file, a new grant or a reinstall]');
{
  const rec = recFor(plug());
  ok(G.gateEntry(plug({ folderHash: HASH2 }), { enabled: true, consent: rec }).enabled === false, 'a changed file');
  ok(G.gateEntry(plug({ permissions: ['microphone', 'service'] }), { enabled: true, consent: rec }).enabled === false, 'a new grant');
  ok(G.gateEntry(plug({ installSeq: 3 }), { enabled: true, consent: rec }).enabled === false, 'a reinstall');
  ok(G.gateEntry(plug({ folderHash: null, error: 'link' }), { enabled: true, consent: rec }).enabled === false, 'a folder that could not be hashed is held');
  ok(G.gateEntry(plug({ error: 'link' }), { enabled: true, consent: rec }).enabled === false, 'a scan error holds it even with an old hash on the entry');
}

console.log('\n[switching on: refused for a user module without a matching record; off always works; bundled unchanged]');
{
  ok(G.mayTurnOn(plug(), {}) === false, 'no record');
  const rec = recFor(plug());
  ok(G.mayTurnOn(plug(), { consent: rec }) === true, 'a matching record');
  ok(G.mayTurnOn(plug({ folderHash: HASH2 }), { consent: rec }) === false, 'a record for other files');
  ok(G.mayTurnOn(bundled, {}) === true, 'bundled');
  ok(G.mayTurnOff(plug(), {}) === true, 'off never asks');
}

console.log('\n[the review: the dialog in the core\'s words, the facts, and the pin to the hash on disk now]');
{
  const r = G.review(plug({ version: '0.2.0', bytes: 1234 }));
  ok(r.ok === true, 'a review');
  if (r.ok) {
    ok(r.dialog.title === 'Allow Notes Plus?' && /use your microphone/.test(r.dialog.body), 'the dialog');
    same(r.facts, { version: '0.2.0', by: null, bytes: 1234 }, 'the facts');
    ok(r.pin === HASH, 'the pin');
  }
  const bad = G.review(bundled);
  ok(!bad.ok && bad.reason === 'not-a-plugin', 'a bundled module has no review');
  const unreadable = G.review(plug({ folderHash: null }));
  ok(!unreadable.ok && unreadable.reason === 'unreadable', 'an unreadable folder has none');
}

console.log('\n[allow: only a user module, only with the pin equal to the hash now; the record is exactly the core\'s]');
{
  const a = G.allow(plug(), HASH, NOW);
  ok(a.ok === true, 'allowed');
  same(a.ok ? a.record : null, C.makeRecord({ man: { permissions: plug().permissions }, folderHash: HASH, installSeq: 2 }, NOW), 'the record');
  const reason = (r: ReturnType<typeof G.allow>): string | undefined => (r.ok ? undefined : r.reason);
  ok(reason(G.allow(plug({ folderHash: HASH2 }), HASH, NOW)) === 'stale-pin', 'the folder changed after the dialog opened');
  ok(reason(G.allow(plug(), 'nope', NOW)) === 'stale-pin', 'a wrong pin');
  ok(reason(G.allow(bundled, HASH, NOW)) === 'not-a-plugin', 'bundled');
  ok(reason(G.allow(plug({ folderHash: null }), null, NOW)) === 'unreadable', 'unreadable');
}

console.log('\n[allow pins the zip\'s per-file hashes into the record (the app\'s gate dropped them; carried here)]');
{
  const fl = { 'module.json': 'a'.repeat(64), 'ui/page.html': 'b'.repeat(64) };
  const a = G.allow(plug({ fileHashes: fl }), HASH, NOW);
  ok(a.ok && isDeepStrictEqual(a.record.files, fl), 'the record carries files');
  ok(a.ok && C.recordOk(a.record), 'and is a valid record');
  const withFiles = a.ok ? a.record : null;
  const s = C.consentState({ source: 'user', man: { permissions: plug().permissions }, folderHash: HASH, installSeq: 2 }, withFiles);
  ok(s.state === 'ok', 'it lets the module on');
  const bad = G.allow(plug({ fileHashes: { 'a.txt': 'nope' } }), HASH, NOW);
  ok(!bad.ok && bad.reason === 'bad-file-hashes', 'a bad list is refused, not thrown');
  const none = G.allow(plug(), HASH, NOW);
  ok(none.ok && !('files' in none.record), 'a hand-placed folder\'s record has none');
}

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
