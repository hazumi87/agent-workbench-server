import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const TOKEN = readFileSync('C:/code/briefing-table/secrets/engine.token','utf8').trim();
let f = 0;
const ok = (c, l, d) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${d ? `  — ${d}` : ''}`); if (!c) f++; };
const b = await chromium.launch();
const p = await (await b.newContext({ extraHTTPHeaders: { authorization: `Bearer ${TOKEN}` }, viewport: { width: 1400, height: 900 } })).newPage();
const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
await p.goto('http://127.0.0.1:7448/manager.html', { waitUntil: 'networkidle' });
await p.evaluate(() => { location.hash = '#recipes'; }); // the recipe editor's button lives on the Recipes screen
await p.click('#newBtn'); await p.waitForSelector('#fColorBtn');

await p.click('#fColorBtn'); await p.waitForTimeout(200);
await p.keyboard.press('Escape'); await p.waitForTimeout(250);
ok(await p.$eval('#fColorPop', (e) => e.hidden), 'Escape closes the palette FIRST');
ok(!(await p.$eval('#formModal', (e) => e.hidden)), '...and leaves the form open — one press, one thing');

await p.keyboard.press('Escape'); await p.waitForTimeout(250);
ok(await p.$eval('#formModal', (e) => e.hidden), 'a second Escape leaves the form');

/* The logo modal is the other dialog that can trap you. */
await p.evaluate(() => { location.hash = '#recipes'; }); // the recipe editor's button lives on the Recipes screen
await p.click('#newBtn'); await p.waitForSelector('#fLogoBtn');
await p.click('#fLogoBtn'); await p.waitForTimeout(500);
ok(await p.$eval('.lm-modal', (e) => e.classList.contains('open')), 'the logo modal opened');
await p.keyboard.press('Escape'); await p.waitForTimeout(300);
ok(!(await p.$eval('.lm-modal', (e) => e.classList.contains('open'))), 'Escape closes the logo modal');
ok(!(await p.$eval('#formModal', (e) => e.hidden)), '...without also closing the form behind it');
ok(errs.length === 0, 'no page errors', errs.slice(0, 2).join(' | ') || 'clean');
await b.close();
process.exit(f ? 1 : 0);
