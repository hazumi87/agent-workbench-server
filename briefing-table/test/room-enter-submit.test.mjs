/**
 * USE ENTER TO SEND (Owner 2026-10-04,): the SHIPPED
 * keydown handler in web/room.js is sliced out and run against stubs.
 *   - unset / true: today's behavior (desktop Enter sends, Shift+Enter is a
 *     new line, Ctrl+Enter inserts a new line, phone Enter is a new line);
 *   - false: Enter and Shift+Enter never send (the textarea's own newline,
 *     not prevented); Ctrl/Cmd+Enter is a new line (2026-10-05); phone the same;
 *   - the @-completion menu still takes Enter in every mode.
 * The settings checkbox is read from web/you-settings.mjs source.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const src = readFileSync(join(root, 'room.js'), 'utf8').replace(/\r\n/g, '\n');
const a = src.indexOf("input.addEventListener('keydown', (ev) => {");
const b = src.indexOf('/* ----------------------------------------------------------------- push');
if (a < 0 || b < a) {
  throw new Error('keydown block not found in web/room.js');
}
const body = src.slice(a, b);
const { enterAction } = await import(pathToFileURL(join(root, 'enter-pref.mjs')).href);

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  + ${msg}`);
  } else {
    failed++;
    console.log(`  X ${msg}`);
  }
}

function run({ enterSubmits, phone = false, menu = false }, key) {
  const log = { submitted: 0, accepted: 0, prevented: false, newline: false };
  let handler = null;
  const input = { addEventListener: (t, f) => { if (t === 'keydown') handler = f; } };
  const $ = (id) => (id === 'complete' ? { hidden: !menu } : {});
  const completion = { items: menu ? ['@alpha', '@beta'] : [], index: 0 };
  const matchMedia = (q) => ({ matches: phone && q.includes('max-width') });
  const state = { me: enterSubmits === undefined ? {} : { enterSubmits } };
  const fn = new Function('slashKey', 'input', '$', 'completion', 'matchMedia', 'state', 'atToken', 'acceptCompletion', 'closeCompletion', 'refreshCompletion', 'currentTabSuggestion', 'caretIntoView', 'Event', 'submitCompose', 'enterAction',
    body);
  fn(() => false, input, $, completion, matchMedia, state, () => ({ prefix: '@zzz' }), () => { log.accepted++; }, () => {}, () => {}, () => null, () => {}, class { constructor() {} }, () => { log.submitted++; }, enterAction);
  const ev = { key: 'Enter', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...key,
    preventDefault: () => { log.prevented = true; },
    target: { selectionStart: 0, selectionEnd: 0, setRangeText: () => { log.newline = true; }, dispatchEvent: () => {} } };
  handler(ev);
  return log;
}

console.log('\n[unset and ON: today]');
for (const v of [undefined, null, true]) {
  const tag = `enterSubmits=${v}`;
  ok(run({ enterSubmits: v }, {}).submitted === 1, `${tag}: desktop Enter sends`);
  ok(run({ enterSubmits: v }, { shiftKey: true }).submitted === 0, `${tag}: Shift+Enter does not send`);
  const c = run({ enterSubmits: v }, { ctrlKey: true });
  ok(c.submitted === 0 && c.newline, `${tag}: Ctrl+Enter inserts a new line`);
  ok(run({ enterSubmits: v, phone: true }, {}).submitted === 0, `${tag}: phone Enter does not send`);
}

console.log('\n[OFF]');
const off = (k, extra = {}) => run({ enterSubmits: false, ...extra }, k);
let r = off({});
ok(r.submitted === 0 && !r.prevented, 'Enter: not sent, not prevented (native new line)');
r = off({ shiftKey: true });
ok(r.submitted === 0 && !r.prevented, 'Shift+Enter: not sent, native new line');
/* Owner 2026-10-05: Ctrl/Cmd+Enter is a new line whatever the setting (same rule as agent chat) */
r = off({ ctrlKey: true });
ok(r.submitted === 0 && r.newline, 'Ctrl+Enter inserts a new line');
r = off({ metaKey: true });
ok(r.submitted === 0 && r.newline, 'Cmd+Enter inserts a new line');
r = off({}, { phone: true });
ok(r.submitted === 0 && !r.prevented, 'phone Enter: new line');

console.log('\n[completion menu keeps Enter]');
for (const v of [undefined, false, true]) {
  const m = run({ enterSubmits: v, menu: true }, {});
  ok(m.accepted === 1 && m.submitted === 0, `enterSubmits=${v}: Enter accepts the highlighted completion, does not send`);
}

console.log('\n[settings checkbox]');
const you = readFileSync(join(root, 'you-settings.mjs'), 'utf8');
ok(/Use Enter to send/.test(you) && /Off: Enter adds a new line; send with the Send button\./.test(you), 'checkbox + one-line explanation present');
ok(/saveEnterSubmits\(enterCb\.checked, save\)/.test(you), 'saves enterSubmits through the shared save() (via enter-pref, which also propagates)');
ok(/me\?\.enterSubmits !== false/.test(you), 'unset reads as ticked');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
