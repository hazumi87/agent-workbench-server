/* The Assets list in the preview column takes a paste and a drop as well as + Add (Owner [ref]): source-slice checks; the browser
   behaviour is the room-scratchpad probe's. */
import { readFileSync } from 'node:fs';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('  FAIL ' + m)); };
const src = readFileSync(new URL('../web/room-scratchpad-view.mjs', import.meta.url), 'utf8');
ok(/async function upload\(files\)/.test(src) && /fileInput\.addEventListener\('change', async \(\) => \{[^}]*await upload\(files\)/s.test(src), '+ Add, paste and drop share one upload');
ok(/document\.addEventListener\('paste'/.test(src) && /if \(!mine\(\)\)/.test(src), 'paste is handled only while the Assets view is the open preview');
ok(/input, textarea, \[contenteditable/.test(src) && /at === document\.body/.test(src), 'a paste into the message box or a text field is left alone');
ok(/clipboardData\?\.files/.test(src) && /pasted-/.test(src), 'a pasted image gets a name');
ok(/o\.preview\.el\?\.addEventListener\('drop'/.test(src) && /hasFiles\(ev\)/.test(src), 'a file dropped on the column is added');
console.log(`PASS ${pass} FAIL ${fail}`);
process.exit(fail ? 1 : 0);
