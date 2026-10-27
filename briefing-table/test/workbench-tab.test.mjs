// [workbench tab] the browser tab says Workbench and every page wears the four-square icon.
import { readFileSync, readdirSync } from 'node:fs';
const web = new URL('../web/', import.meta.url);
let passed = 0;
let failed = 0;
function ok(c, m) { if (c) { passed++; } else { failed++; console.log(`FAIL ${m}`); } }
const shell = readFileSync(new URL('shell.html', web), 'utf8');
ok(!/document\.title = (t|active)/.test(shell), 'shell never copies an inner tab name into the browser tab');
ok((shell.match(/document\.title = 'Workbench';/g) || []).length === 2, 'both shell paint paths pin the title to Workbench');
for (const f of readdirSync(web).filter((n) => n.endsWith('.html'))) {
  ok(/<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg"/.test(readFileSync(new URL(f, web), 'utf8')), `${f} links the icon`);
}
const svg = readFileSync(new URL('favicon.svg', web), 'utf8');
ok((svg.match(/<rect /g) || []).length === 4, 'icon is four squares');
ok(/'\/favicon\.svg'/.test(readFileSync(new URL('../src/server/auth.ts', import.meta.url), 'utf8')), 'icon is public so the sign-in page shows it');
const idx = readFileSync(new URL('../src/server/index.ts', import.meta.url), 'utf8');
ok(/immutableAsset \? 'public, max-age=31536000, immutable'/.test(idx), 'versioned assets are cached for good');
ok(/'content-encoding': 'gzip'/.test(idx), 'text is gzipped');
const room = readFileSync(new URL('room.js', web), 'utf8');
ok(/lineScroll'\)\.addEventListener\('scroll'[\s\S]{0,400}loadOlder\(\)/.test(room), 'scrolling to the top loads the next older page');
ok(/onTearOff: function \(id\) \{[\s\S]{0,500}window\.chrome\.webview\)\) \{ return null; \}[\s\S]{0,40}removeTab\(id\)/.test(shell), 'a plain browser never removes a tab for a tear-off it cannot do');
const mgr = readFileSync(new URL('manager.js', web), 'utf8');
ok(/body\.target = 'tab';[\s\S]{0,700}window\.chrome\.webview\)\) \{ body\.surface = 'browser'; \}/.test(mgr), 'an embedded manager in a plain browser launches as a browser tab');
console.log(`PASS ${passed}  FAIL ${failed}`);
process.exit(failed ? 1 : 0);
