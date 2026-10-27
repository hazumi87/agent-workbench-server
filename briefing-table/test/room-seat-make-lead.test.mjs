// [make lead] source slices: the seat menu's "Make lead" item and its verb.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../web/room-seat-menu.mjs', import.meta.url), 'utf8');
let passed = 0;
let failed = 0;
function ok(c, m) {
  if (c) { passed++; console.log(`  + ${m}`); } else { failed++; console.log(`  X ${m}`); }
}
const items = src.slice(src.indexOf('function items(seat)'), src.indexOf('function closeMenu'));
ok(/a: 'lead', label: 'Make lead'/.test(items), 'the menu lists Make lead');
ok(/a: 'lead'[^\n]*off: lead, why: 'Already the lead'/.test(items), 'disabled on the current lead, with the reason');
ok(items.indexOf("a: 'lead'") > items.indexOf("a: 'ren'") && items.indexOf("a: 'lead'") < items.indexOf("a: 'rem'"), 'sits between Rename and Remove');
const fn = src.slice(src.indexOf('async function makeLead'), src.indexOf('/* ---- Disconnect'));
ok(/o\.api\(`\/api\/rooms\/\$\{encodeURIComponent\(o\.roomId\)\}`, \{ method: 'PATCH', json: \{ lead_seat: seat\.id \} \}\)/.test(fn), 'PATCH /api/rooms/:id {lead_seat: seat id}');
ok(/o\.error\(`@\$\{seat\.handle\} not made lead — \$\{r\.body\?\.error/.test(fn), "shows the engine's refusal");
ok(/it\.a === 'lead'\) \{\s*void makeLead\(seat\)/.test(src), 'choose() runs it');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
