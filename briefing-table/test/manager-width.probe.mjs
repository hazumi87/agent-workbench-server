/* REGRESSION: the CLI Manager must stay readable at every window width.
 *
 * A PROBE, not part of `npm test`: needs the live engine on :7420 and REAL Edge
 * (same convention as icons-page.probe.mjs). Real Edge because the OS scrollbar
 * mode changes the usable width — see test/xterm-scrollbar.probe.mjs.
 *
 * Asserts, per width, on BOTH card types (.live-row and .sess — the launcher
 * card was missed in the first phone pass and that is how the last one shipped
 * broken):
 *   1. nothing renders past the page's content edge
 *   2. a card's name never overlaps its own controls
 *   3. the page never scrolls horizontally
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.WB_BASE || 'http://127.0.0.1:7420';
const TOKEN = readFileSync('secrets/engine.token', 'utf8').trim();
const WIDTHS = (process.env.WIDTHS || '1600,1280,1100,1000,900,800,700,640,600,520,398,360')
  .split(',').map(Number);

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); if (!c) failures++; };

/* AUTH BY HEADER, NEVER BY DRIVING THE LOGIN FORM.
 *
 * This probe runs in REAL Edge and NOT headless (classic scrollbars and screen
 * geometry are invisible otherwise), which means it opens a window on Owner's
 * actual desktop. Driving /login there put a passkey / Windows Hello prompt in
 * front of him — a modal only a human can answer — so every run stopped dead
 * until he logged it in BY HAND. He had to do that four times before anyone
 * noticed (2026-09-21). A test that needs the user is not a test.
 *
 * The bearer header authenticates every request including the first, so the
 * login page is never reached and no authenticator is ever invoked.
 */
const browser = await chromium.launch({ channel: 'msedge', headless: false });
const page = await (await browser.newContext({
  viewport: { width: 1280, height: 900 },
  extraHTTPHeaders: { authorization: `Bearer ${TOKEN}` },
})).newPage();
/* Prove it BEFORE the width loop: a probe silently measuring a login page
   reports geometry about the wrong document entirely. */
{
  const landing = await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  ok(landing.status() === 200 && !page.url().includes('/login'),
    `authenticated by header, no login form (${page.url().replace(BASE, '') || '/'})`);
}

for (const w of WIDTHS) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const r = await page.evaluate(() => {
    const past = [];
    const overlaps = [];
    for (const card of document.querySelectorAll('.sess, .live-row')) {
      const kind = card.classList.contains('sess') ? '.sess' : '.live-row';
      const label = (card.querySelector('.sess-name, .live-name')?.textContent || '?').trim().slice(0, 22);
      /* Measure against the CARD's own content edge, not the page's. A control
         pushed out of its column is clipped by `overflow:hidden` long before it
         reaches the window edge — which is exactly how "Open window" shipped
         cut in half at 1280px while a page-edge check called it clean. */
      const ccs = getComputedStyle(card);
      const cb = card.getBoundingClientRect();
      const edge = cb.left + parseFloat(ccs.borderLeftWidth) + card.clientWidth - parseFloat(ccs.paddingRight);
      for (const kid of card.querySelectorAll('*')) {
        if (kid.children.length) continue;
        /* The brand WATERMARK is decorative, inert (pointer-events:none) and
           deliberately anchored into the card's padding — it is a ground, not a
           control, and flagging it here would be flagging a background for
           touching the edge of its own box. */
        if (kid.closest('.sess-bwm')) continue;
        const b = kid.getBoundingClientRect();
        if (!b.width || !b.height) continue;
        if (b.right > edge + 0.5) {
          const owner = kid.parentElement ? (kid.parentElement.getAttribute('class') || kid.parentElement.tagName) : '?';
          past.push({ kind, label, el: kid.tagName.toLowerCase() + ' in [' + owner + ']',
                      right: Math.round(b.right), over: Math.round(b.right - edge), text: (kid.textContent || '').trim().slice(0, 18) });
        }
      }
      /* TEXT can escape a box that itself sits inside the card — "Kiosk",
         one unbreakable word in a squeezed .sess-main, painted straight over
         its own model dropdown while every ELEMENT box measured legal. Check
         the ink, not just the boxes. */
      for (const t of card.querySelectorAll('.sess-name, .sess-meta, .live-name, .live-meta')) {
        /* Only where overflow is VISIBLE. An ellipsised element has
           scrollWidth > clientWidth by definition — that is what draws the "…"
           — so testing every element flags deliberate truncation as a bug. */
        if (getComputedStyle(t).overflowX !== 'visible') continue;
        if (t.scrollWidth > t.clientWidth + 1) {
          past.push({ kind, label, el: '.' + (t.className || '').toString().split(/\s+/)[0],
                      right: 0, over: t.scrollWidth - t.clientWidth, text: 'text escapes its box' });
        }
      }
      const main = card.querySelector('.sess-main, .live-name');
      const acts = card.querySelector('.sess-actions, .live-actions') || card.querySelector('.sess-model');
      if (main && acts) {
        const a = main.getBoundingClientRect(), b = acts.getBoundingClientRect();
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 1 && oy > 1) overlaps.push({ kind, label, overlapPx: Math.round(ox) });
      }
    }
    return {
      /* Defensive: a page that ended up somewhere else (a /login redirect, a
         slow first paint) has no columns, and getComputedStyle(null) throws an
         error that reads as a product bug rather than as "the page isn't
         there". Report it instead. */
      cols: (() => { const c = document.querySelector('.mgr-cols');
        return c ? getComputedStyle(c).gridTemplateColumns : 'NO .mgr-cols — where am I? ' + location.pathname; })(),
      hScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      past, overlaps,
    };
  });

  console.log(`\n[${w}px] grid="${r.cols}"`);
  ok(r.past.length === 0, `${w}px: nothing renders past the content edge` + (r.past.length ? ` — ${r.past.length}: ` + r.past.slice(0, 3).map((p) => `${p.kind} "${p.label}" ${p.el} +${p.over}px`).join('; ') : ''));
  ok(r.overlaps.length === 0, `${w}px: no name/controls overlap` + (r.overlaps.length ? ` — ${r.overlaps.length}: ` + r.overlaps.slice(0, 3).map((o) => `${o.kind} "${o.label}" ${o.overlapPx}px`).join('; ') : ''));
  ok(r.hScroll <= 0, `${w}px: no horizontal page scroll (overflow ${r.hScroll}px)`);
  if ([1280, 1000, 700].includes(w)) await page.screenshot({ path: `test/manager-${w}.png` });
}
await browser.close();
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
