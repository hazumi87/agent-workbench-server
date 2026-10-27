/* LIGHTBOX GALLERY (Owner [ref]): ‹ ›, the arrow keys and the mouse side buttons
 * step through the set; a step never closes the lightbox; hiding it drops the set.
 *   node test/room-lightbox-nav.probe.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const src = readFileSync(fileURLToPath(new URL('../web/room-lightbox-nav.mjs', import.meta.url)), 'utf8');
let pass = 0;
let fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL', m); } };

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(`<div id="lightbox" hidden><figure><div id="lbBody"></div><figcaption id="lbCap"></figcaption></figure></div>
<script type="module">${src}
const lb = document.getElementById('lightbox');
lb.addEventListener('click', () => { lb.hidden = true; });
window.go = (n, i) => openGallery(lb, Array.from({ length: n }, (_, k) => ({ src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=#' + k, name: 'img' + k })), i);
</script>`);
await page.waitForFunction(() => typeof window.go === 'function');
const name = () => page.evaluate(() => document.getElementById('lbCap').textContent);
const hidden = () => page.evaluate(() => document.getElementById('lightbox').hidden);
const count = () => page.evaluate(() => document.querySelector('.rm-lb-count').textContent);
const dis = (c) => page.evaluate((c) => document.querySelector('.rm-lb-nav.' + c).disabled, c);

await page.evaluate(() => window.go(3, 1));
ok(!(await hidden()) && (await name()) === 'img1' && (await count()) === '2 of 3', 'opens at index 1');
await page.click('.rm-lb-nav.next');
ok((await name()) === 'img2' && !(await hidden()), 'next steps and stays open');
ok(await dis('next'), 'next disabled at the end');
await page.click('.rm-lb-nav.prev');
await page.click('.rm-lb-nav.prev');
ok((await name()) === 'img0' && (await dis('prev')), 'prev to the start');
await page.keyboard.press('ArrowRight');
ok((await name()) === 'img1', 'ArrowRight');
await page.keyboard.press('ArrowLeft');
ok((await name()) === 'img0', 'ArrowLeft');
const side = (type, button) => page.evaluate(([type, button]) => {
  const e = new MouseEvent(type, { button, bubbles: true, cancelable: true });
  document.body.dispatchEvent(e);
  return e.defaultPrevented;
}, [type, button]);
ok(await side('mouseup', 4), 'forward button is swallowed');
ok((await name()) === 'img1', 'mouse forward steps');
await side('mouseup', 3);
ok((await name()) === 'img0', 'mouse back steps');
await page.evaluate(() => { document.getElementById('lightbox').click(); });
ok(await hidden(), 'a click on the backdrop closes');
ok(await page.evaluate(() => document.querySelector('.rm-lb-nav.next').hidden), 'closed: nav hidden');
ok(!(await side('mouseup', 4)), 'closed: side buttons are left to the browser');
await page.evaluate(() => window.go(1, 0));
ok(await page.evaluate(() => document.querySelector('.rm-lb-nav.next').hidden), 'one image: no arrows');
await browser.close();
console.log(`PASS ${pass} FAIL ${fail}`);
process.exit(fail ? 1 : 0);
