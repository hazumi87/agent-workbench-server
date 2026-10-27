/* ROOM DOCUMENT VIEWER probe [ticket]: a long sample at column (420), wide
 * (900) and phone (390) widths, plus full screen. Static harness, no engine.
 *   node test/room-doc-view.probe.mjs   (screenshots: DOCVIEW_SHOTS or tmp)
 * A PROBE, not in `npm test`. Scratch port P(330). */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { P, assertFree } from './_scratch.mjs';
import { serveWeb } from './_docview-harness.mjs';

const SHOTS = process.env.DOCVIEW_SHOTS || tmpdir();
mkdirSync(SHOTS, { recursive: true });
const docs = mkdtempSync(join(tmpdir(), 'docview-'));
process.env.DOCVIEW_DOCS = docs;
const md = [
  '# Launch plan for the Harbor workroom preview', '',
  'A short intro with **bold**, _italic_, `inline code` and a very long URL: https://example.com/a/really/long/path/that/keeps/going/and/going/and/going/with/no/spaces/at/all/until/it/must/wrap?x=1&y=2&z=3', '',
  '## Steps', '', '1. First step', '2. Second step', '   - nested bullet one', '   - nested bullet two', '3. Third step', '',
  '### Table', '', '| Name | Owner | Status | Notes | Due |', '|------|-------|--------|-------|-----|', '| Preview column | web | done | wide table that must scroll inside its own box | 2026-10-02 |', '| Doc viewer | web | in review | markdown and text | 2026-10-03 |', '',
  '```js', 'const veryLongLine = "this code line is long enough that it has to scroll horizontally inside its block and not wrap";', 'console.log(veryLongLine);', '```', '',
  '> A quoted paragraph that explains why the viewer exists.', '',
  '![diagram](/api/rooms/r1/assets/raw/pic.png)', '', '![blocked](http://insecure.test/x.png)', '',
  '#### Hostile bits', '', '<script>window.__pwned = 1</script>', '', '<img src=x onerror="window.__pwned=2">', '', '[bad link](javascript:window.__pwned=3) and [good link](https://example.com)', '',
  '<iframe src="https://example.com"></iframe>', '', '<style>body{background:red}</style>', '', '<svg onload="window.__pwned=4"></svg>', '',
  ...Array.from({ length: 25 }, (_, i) => `Paragraph ${i + 1}. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.`).flatMap((x) => [x, '']),
].join('\n');
writeFileSync(join(docs, 'plan.md'), md);
const PORT = P(330);
await assertFree(PORT, 'room-doc-view.probe');
const srv = await serveWeb(PORT);
const BASE = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ headless: true });
let failures = 0;
const check = (v, label) => { if (!v) { failures++; console.log(`  X ${label}`); } else { console.log(`  ok ${label}`); } };
try {
  for (const [tag, w, h, pvw] of [['column', 1000, 800, 420], ['wide', 1200, 800, 900], ['phone', 390, 800, 390]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/__harness.html`);
    await page.waitForFunction(() => window.ready);
    await page.evaluate((pvw) => { document.getElementById('pv').style.width = `${pvw}px`; }, pvw);
    await page.evaluate(() => window.mount({ name: 'plan.md', kind: 'markdown', url: '/__doc/plan.md', base: `${location.origin}/api/rooms/r1/assets/raw/plan.md`, ref: 'https://share.test/ref/plan.md' }));
    await page.waitForSelector('.dv-md');
    await page.waitForTimeout(400);
    check(await page.evaluate(() => window.__pwned === undefined), `${tag}: nothing ran`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${tag}: no sideways page scroll`);
    check(await page.evaluate(() => { const b = document.getElementById('pvb'); return b.scrollWidth <= b.clientWidth + 1; }), `${tag}: the body itself does not scroll sideways`);
    check(await page.evaluate(() => { const t = document.querySelector('.dv-md table'); return t.scrollWidth > t.clientWidth || t.getBoundingClientRect().width <= document.getElementById('pvb').clientWidth; }), `${tag}: the table fits or scrolls in its own box`);
    await page.screenshot({ path: join(SHOTS, `docview-${tag}.png`) });
    if (tag === 'column') {
      await page.click('#tools [aria-label="Full screen"]');
      await page.waitForSelector('.dv-lg .dv-md');
      await page.screenshot({ path: join(SHOTS, 'docview-fullscreen.png') });
      await page.keyboard.press('Escape');
      /* the real menu host (room-seat-menu.mjs), not a stub */
      await page.click('#tools [aria-label="More options"]');
      await page.waitForSelector('.rsm-menu');
      await page.screenshot({ path: join(SHOTS, 'docview-menu.png') });
      check(await page.evaluate(() => [...document.querySelectorAll('.rsm-menu .rsm-mi')].map((b) => b.textContent).join('|') === 'Print|Download|View source'), 'the real menu lists Print, Download, View source');
    }
    if (tag === 'phone') {
      await page.click('#tools [aria-label="More options"]');
      await page.waitForSelector('.rsm-menu.is-sheet');
      await page.screenshot({ path: join(SHOTS, 'docview-phone-menu.png') });
      check(await page.evaluate(() => getComputedStyle(document.querySelector('.dv-full-btn')).display === 'none'), 'phone: no Full screen button');
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  srv.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
process.exit(failures ? 1 : 0);
