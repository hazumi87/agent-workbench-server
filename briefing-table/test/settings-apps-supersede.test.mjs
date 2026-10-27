/* Settings -> Apps: unregistering can name the app that replaces it [app supersede] Owner 2026-10-05. Source slices. */
import { readFileSync } from 'node:fs';
const s = readFileSync(new URL('../web/settings-apps.mjs', import.meta.url), 'utf8');
let passed = 0;
let failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };
ok(/const unregister = \(a, supersededBy\) =>/.test(s), 'unregister takes the chosen successor');
ok(/supersededBy \? \{ superseded_by: supersededBy \} : \{\}/.test(s), 'it is sent as superseded_by only when chosen');
ok(/new Option\('nothing \(links stop\)', ''\)/.test(s), 'the default is no successor');
ok(/o\.slug !== x\.slug && ost === 'registered' && !o\.superseded_by/.test(s), 'offered: other registered apps that are not themselves replaced');
ok(/void unregister\(x, sel\.value\)/.test(s), 'the confirm button passes the choice');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
