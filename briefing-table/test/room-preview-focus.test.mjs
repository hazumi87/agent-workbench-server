/**
 * The preview column and the focus (Owner [ref]: "focus goes away" while typing in a note or the message box).
 * The Scratchpad list re-opens the column on every 15 s refresh and open() used to focus it each time. takesFocus()
 * is the rule: the column may take the focus unless a text field outside it holds it. The behaviour in a real page
 * is test/shell-memory.probe.mjs's sibling probe (note typing with lines arriving).
 */
import { takesFocus } from '../web/room-preview.mjs';

let passed = 0;
let failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  FAIL ${m}`); } };
const col = { contains: (n) => n === inner, tagName: 'ASIDE' };
const inner = { tagName: 'BUTTON' };
const el = (tagName, extra = {}) => ({ tagName, ...extra });

ok(takesFocus(null, col), 'nothing focused: the column takes it');
ok(takesFocus(el('BODY'), col), 'the body: the column takes it');
ok(takesFocus(el('BUTTON'), col), 'a button (the Notes line that was just clicked): the column takes it');
ok(takesFocus(col, col) && takesFocus(inner, col), 'focus already in the column: fine');
ok(!takesFocus(el('TEXTAREA'), col), 'a textarea (the note editor, the message box): the column does NOT take it');
ok(!takesFocus(el('INPUT'), col), 'an input: not taken');
ok(!takesFocus(el('SELECT'), col), 'a select: not taken');
ok(!takesFocus(el('DIV', { isContentEditable: true }), col), 'a contenteditable: not taken');
ok(takesFocus(el('DIV'), col), 'an ordinary div: taken');
ok(takesFocus(inner, col), 'a control INSIDE the column (e.g. its own field) is never blocked');
console.log(`PASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
