/* REGRESSION: the terminal's right edge must be readable.
 *
 * A PROBE, not part of `npm test`: it needs the live engine on :7420 and REAL
 * Edge (same convention as icons-page.probe.mjs). Run it by hand after touching
 * the terminal's box:  node test/xterm-scrollbar.probe.mjs
 *
 * Two asserts, both against REAL Edge (channel msedge, headed) because the OS
 * scrollbar mode is the whole bug: headless Chromium and iOS paint OVERLAY
 * bars, where this is structurally invisible — the same blind spot that hid the
 * viewport-zoom bug (KB 2026-09-01). Chromium emulation cannot catch it.
 *
 *   1. `.xterm-viewport` takes NO native gutter — its `overflow-y: scroll` is a
 *      leftover in the pinned vendor CSS and the bar it paints does not scroll.
 *   2. the rightmost painted glyph clears xterm's own overlay scrollbar.
 * Plus: the wheel still scrolls scrollback, so (1) cost no function.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.WB_BASE || 'http://127.0.0.1:7420';
const TOKEN = readFileSync('secrets/engine.token', 'utf8').trim();
const RECIPE = process.env.PROBE_RECIPE || 'eeeeeeee-0000-4000-8000-0000000000e1';
const MIN_CLEARANCE = 6; // px of quiet space between the last glyph and the bar

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}`); if (!cond) failures++; };

const browser = await chromium.launch({ channel: 'msedge', headless: false });
const page = await (await browser.newContext({ viewport: { width: 900, height: 640 } })).newPage();
await page.goto(`${BASE}/login`);
await page.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);

for (const w of [1200, 900, 700, 520]) {
  await page.setViewportSize({ width: w, height: 640 });
  await page.goto(`${BASE}/solo.html?recipe=${RECIPE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  // fill the full width AND build scrollback, so both bars have reason to show
  await page.keyboard.type('node -e "const c=process.stdout.columns||80;for(let i=0;i<300;i++){const p=`L${i} `;console.log(p+String.fromCharCode(35).repeat(c-p.length))}"');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2200);

  const m = await page.evaluate(() => {
    const host = document.querySelector('.pane-term');
    const vp = host.querySelector('.xterm-viewport');
    const bar = host.querySelector('.xterm-scrollable-element > .scrollbar.vertical');
    let far = 0;
    for (const row of host.querySelector('.xterm-rows').children) {
      for (const sp of row.children) {
        const r = sp.getBoundingClientRect();
        if (r.width && r.right > far) far = r.right;
      }
    }
    return {
      nativeGutter: vp.offsetWidth - vp.clientWidth,
      barLeft: bar ? bar.getBoundingClientRect().left : null,
      barWidth: bar ? Math.round(bar.getBoundingClientRect().width) : null,
      farGlyphRight: far,
      paneRight: host.getBoundingClientRect().right,
    };
  });
  const clearance = m.barLeft === null ? Infinity : m.barLeft - m.farGlyphRight;
  console.log(`\n[${w}px] gutter=${m.nativeGutter} bar=${m.barWidth}px@${Math.round(m.barLeft)} lastGlyph=${Math.round(m.farGlyphRight)} clearance=${clearance.toFixed(1)}px`);
  ok(m.nativeGutter === 0, `${w}px: .xterm-viewport paints no native scrollbar (gutter ${m.nativeGutter})`);
  ok(clearance >= MIN_CLEARANCE, `${w}px: last column clears the scrollbar by >=${MIN_CLEARANCE}px (got ${clearance.toFixed(1)})`);

  if (w === 900) {
    const before = await page.evaluate(() => document.querySelector('.xterm-rows').firstElementChild.textContent.trim().slice(0, 20));
    await page.mouse.move(450, 300);
    await page.mouse.wheel(0, -1500);
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => document.querySelector('.xterm-rows').firstElementChild.textContent.trim().slice(0, 20));
    ok(before !== after, `wheel still scrolls scrollback with the native bar suppressed (top row "${before}" -> "${after}")`);
    await page.screenshot({ path: 'test/xterm-scrollbar.png' });
  }
}
await browser.close();
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
