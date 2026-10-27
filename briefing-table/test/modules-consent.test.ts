/**
 * MODULE CONSENT (src/server/modules/consent.ts; ported from workbench-app test/module-consent.test.mjs), from the consent rule (tool maintainers [ref],
 * accepted [ref]) and the design system words ([ref]): a user-folder module that asks for concierge.send, concierge.read, microphone, any rooms.tasks.* or
 * service arrives OFF with "Needs your OK" and "Wants to: ..."; it can be turned on only with a consent record that pins its grants, folder hash and
 * install; any change holds it again. Bundled modules stay on. Turning a module off never asks. Pure.
 */
import { isDeepStrictEqual } from 'node:util';
import * as c from '../src/server/modules/consent.ts';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
function same(actual: unknown, want: unknown, msg: string): void {
  if (isDeepStrictEqual(actual, want)) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}: got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`); }
}

const HASH = 'a'.repeat(64);
const HASH2 = 'b'.repeat(64);
const voice = { id: 'voice', name: 'Voice', permissions: ['ui.pane', 'microphone', 'concierge.send', 'service'] };
const user = (man: { permissions?: unknown }, extra: Partial<c.ConsentEntry> = {}): c.ConsentEntry => ({ source: 'user', man, folderHash: HASH, installSeq: 3, ...extra });
const NOW = '2026-10-25T20:00:00.000Z';

console.log('\n[the gated grants: concierge.send, concierge.read, microphone, every rooms.tasks.* and service]');
same(c.gatedGrants({ permissions: ['ui.tab', 'settings', 'storage', 'sessions.read'] }), [], 'none of the plain ones');
same(c.gatedGrants({ permissions: ['service', 'rooms.tasks.write', 'microphone', 'concierge.read', 'concierge.send', 'rooms.tasks.read', 'ui.side'] }),
  ['concierge.send', 'concierge.read', 'microphone', 'rooms.tasks.read', 'rooms.tasks.write', 'service'], 'display order');
same(c.gatedGrants({ permissions: ['rooms.tasks.archive'] }), ['rooms.tasks.archive'], 'any rooms.tasks.*');
same(c.gatedGrants({}), [], 'no permissions');
same(c.gatedGrants(null), [], 'no manifest');
same(c.gatedGrants({ permissions: ['microphone', 'microphone', 7, 'rooms.tasks.X'] }), ['microphone'], 'de-duplicated, and junk dropped');

console.log('\n[plain words for each gated grant, joined as one sentence]');
ok(c.wantsText(['microphone']) === 'use your microphone', 'one');
ok(c.wantsText(['microphone', 'service']) === 'use your microphone and run a program in the background on this PC', 'two');
ok(c.wantsText(['concierge.send', 'microphone', 'service']) === 'send messages as you through Concierge, use your microphone and run a program in the background on this PC', 'three');
ok(c.wantsText(['rooms.tasks.archive']) === "work with your rooms' tasks", 'a rooms.tasks.* grant without its own words');
ok(c.wantsText(['service', 'microphone']) === 'use your microphone and run a program in the background on this PC', 'display order whatever order they come in');
for (const g of ['concierge.send', 'concierge.read', 'microphone', 'rooms.tasks.read', 'rooms.tasks.write', 'rooms.tasks.delete', 'service']) ok(c.WORDS[g], 'words for ' + g);

console.log('\n[the dialog in Auriga\'s words]');
same(c.dialogText('Voice', ['microphone', 'concierge.send']), {
  title: 'Allow Voice?',
  body: 'Voice wants to: send messages as you through Concierge and use your microphone. Only allow tools you trust.',
  cancel: 'Cancel',
  allow: 'Allow',
}, 'Voice');

console.log('\n[a bundled module is on, whatever it asks for; it never needs a record]');
{
  const s = c.consentState({ source: 'bundled', man: voice, installSeq: 0 }, null);
  same([s.state, s.mayEnable, s.chip], ['bundled', true, null], 'bundled');
}

console.log('\n[a user module asking for nothing gated still needs one OK (Auriga [ref], lead [ref]), and a record lets it on]');
{
  const notes = { id: 'notes', name: 'Notes', permissions: ['ui.tab', 'storage'] };
  const s = c.consentState(user(notes), null);
  same([s.state, s.mayEnable, s.chip, s.reason, s.wants], ['not-allowed', false, 'Needs your OK', 'Installed from a zip. Not allowed yet.', null], 'not allowed yet');
  ok(c.consentState(user(notes, { installSeq: 0 }), null).reason === c.FOLDER_HELD, 'a hand-placed folder says so');
  const rec = c.makeRecord(user(notes), NOW);
  same(rec.grants, [], 'a record with no grants');
  ok(c.consentState(user(notes), rec).state === 'ok', 'a record lets it on');
  ok(c.consentState(user(notes, { folderHash: HASH2 }), rec).state === 'held', 'a changed file holds it again');
}

console.log('\n[the dialog for a module with nothing gated says so in Auriga\'s words]');
same(c.dialogText('Notes', []), { title: 'Allow Notes?', body: "Notes doesn't ask for anything that needs your OK. Only allow tools you trust.", cancel: 'Cancel', allow: 'Allow' }, 'Notes');

console.log('\n[a user module asking for gated grants arrives off with "Needs your OK" and its wants]');
{
  const s = c.consentState(user(voice), null);
  same([s.state, s.mayEnable, s.chip], ['needs-ok', false, 'Needs your OK'], 'needs-ok');
  ok(s.wants === 'Wants to: send messages as you through Concierge, use your microphone and run a program in the background on this PC.', 'its wants');
  same(s.grants, ['concierge.send', 'microphone', 'service'], 'its grants');
}

console.log('\n[a record made on Allow pins the grants, the words, the folder hash and the install]');
{
  const rec = c.makeRecord(user(voice), NOW);
  same(rec, {
    grants: ['concierge.send', 'microphone', 'service'],
    words: 'send messages as you through Concierge, use your microphone and run a program in the background on this PC',
    hash: HASH,
    installSeq: 3,
    at: NOW,
  }, 'the record');
  const s = c.consentState(user(voice), rec);
  same([s.state, s.mayEnable, s.chip], ['ok', true, null], 'it lets the module on');
}

console.log('\n[any change holds it again: a new grant, other files, a reinstall]');
{
  const rec = c.makeRecord(user(voice), NOW);
  const more = c.consentState(user({ ...voice, permissions: [...voice.permissions, 'concierge.read'] }), rec);
  same([more.state, more.mayEnable, more.chip], ['held', false, 'Needs your OK'], 'a new grant');
  ok(/asks for more/.test(more.reason ?? ''), 'its reason');
  const files = c.consentState(user(voice, { folderHash: HASH2 }), rec);
  ok(files.state === 'held' && /files changed/.test(files.reason ?? ''), 'other files');
  const again = c.consentState(user(voice, { installSeq: 4 }), rec);
  ok(again.state === 'held' && /installed again/.test(again.reason ?? ''), 'a reinstall');
}

console.log('\n[asking for fewer grants than allowed stays allowed]');
{
  const rec = c.makeRecord(user(voice), NOW);
  ok(c.consentState(user({ ...voice, permissions: ['microphone'] }), rec).state === 'ok', 'ok');
}

console.log('\n[a record from config.json is untrusted: a bad shape counts as no record]');
{
  const good = c.makeRecord(user(voice), NOW);
  for (const bad of [
    'yes', true, [], {}, null, undefined,
    { ...good, hash: 'nothex' },
    { ...good, grants: 'microphone' },
    { ...good, grants: ['microphone', 42] },
    { ...good, installSeq: -1 },
    { ...good, installSeq: 1.5 },
    { ...good, at: 'yesterday' },
    { ...good, words: 7 },
  ]) {
    ok(c.recordOk(bad) === false && c.consentState(user(voice), bad).state === 'needs-ok', 'refused ' + JSON.stringify(bad));
  }
  ok(c.recordOk(good) === true, 'a good record');
}

console.log('\n[a user module without a valid folder hash can never be allowed]');
{
  const s = c.consentState(user(voice, { folderHash: null }), c.makeRecord(user(voice), NOW));
  same([s.state, s.mayEnable], ['held', false], 'held');
  let msg = '';
  try { c.makeRecord(user(voice, { folderHash: 'short' }), NOW); } catch (e) { msg = (e as Error).message; }
  ok(/folder hash/.test(msg), 'makeRecord throws without a hash');
}

console.log('\n[turning a module off never asks]');
ok(c.offNeedsConsent() === false, 'never');

console.log('\n[slice 3 (lead [ref]): a zip install pins per-file hashes in the record; a bad list is refused; a record without one stays valid]');
{
  const fl = { 'module.json': 'a'.repeat(64), 'ui/page.html': 'b'.repeat(64) };
  const rec = c.makeRecord(user(voice, { fileHashes: fl }), NOW);
  same(rec.files, fl, 'the list is pinned');
  ok(c.recordOk(rec) === true, 'it is a valid record');
  ok(c.recordOk({ ...rec, files: { 'module.json': 'nope' } }) === false, 'a bad hash');
  ok(c.recordOk({ ...rec, files: { '../x': 'a'.repeat(64) } }) === false, 'a path that climbs');
  ok(c.recordOk({ ...rec, files: [] }) === false, 'a list instead of a map');
  const { files: _drop, ...plain } = rec;
  ok(c.recordOk(plain) === true, 'a hand-placed folder\'s record has no file list');
  ok('files' in c.makeRecord(user(voice), NOW) === false, 'and makeRecord adds none');
  let msg = '';
  try { c.makeRecord(user(voice, { fileHashes: { 'a.txt': 'nope' } }), NOW); } catch (e) { msg = (e as Error).message; }
  ok(/valid file list/.test(msg), 'makeRecord refuses a bad list');
}

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
