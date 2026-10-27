/* THE ROOM TOAST IN LIGHT MODE (Owner 2026-10-25, [ref]): the toast wash is pinned at a DARK lightness (.30) while the
   text takes the palette's --text, which in Light is dark, so "New in <room>" was dark text on a dark box. light-mode.css
   re-derives the wash, edge and shadow for a light ground. This reads the REAL computed colours in headless Chromium
   (an oklch() value is painted to a 1x1 canvas and read back; getComputedStyle returns it verbatim) and asserts the
   contrast of the text, the action, and the close mark against the wash, in light AND dark, for a coloured room, a
   neutral room and an error. SAFETY: no engine, no ports; a static page built from the real stylesheets. */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
let passed = 0;
let failed = 0;
const ok = (c, m, got) => {
  if (c) {
    passed++;
    console.log(`  ok  ${m}`);
  } else {
    failed++;
    console.log(`  FAIL ${m}${got === undefined ? '' : ` (got ${JSON.stringify(got)})`}`);
  }
};

/* the palette's tokens for each mode (web/palette.mjs LIGHT/DARK rows, grey) */
const TOKENS = {
  dark: '--text: oklch(.93 0 0); --dim: oklch(.70 0 0); --ink: oklch(.155 0 0); --sky: oklch(.75 .12 235); --coral: oklch(.72 .16 25); --teal: oklch(.78 .12 190);',
  light: '--text: oklch(.25 0 0); --dim: oklch(.47 0 0); --ink: oklch(.985 0 0); --sky: oklch(.75 .12 235); --coral: oklch(.72 .16 25); --teal: oklch(.50 .10 190);',
};
const page = (mode, cls) => `<!doctype html><html ${mode === 'light' ? 'data-mode="light"' : ''}><head><style>
  body { margin: 0; background: ${mode === 'light' ? 'oklch(.985 0 0)' : 'oklch(.155 0 0)'}; ${TOKENS[mode]} --room-c: ${cls === 'neutral' ? 'oklch(.7 .01 150)' : 'oklch(.72 .15 145)'}; --font: sans-serif; }
  ${read('room-toast.css')}
  ${read('light-mode.css')}
  .rm-toast { transform: none; }
</style></head><body>
<div class="rm-toast in ${cls === 'neutral' ? 'neutral' : ''} ${cls === 'err' ? 'err' : ''}" id="t"><span class="tx">New in Client</span><button class="act">View</button><button class="x">x</button></div>
</body></html>`;

const lum = (rgb) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const browser = await chromium.launch();
try {
  for (const mode of ['light', 'dark']) {
    for (const cls of ['room', 'neutral', 'err']) {
      const p = await browser.newPage();
      await p.setContent(page(mode, cls));
      const px = await p.evaluate(() => {
        const c = document.createElement('canvas'); c.width = c.height = 1;
        const g = c.getContext('2d', { willReadFrequently: true });
        const rgb = (css) => { g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = css; g.fillRect(0, 0, 1, 1); return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3); };
        const cs = (sel) => getComputedStyle(document.querySelector(sel));
        return { wash: rgb(cs('#t').backgroundColor), text: rgb(cs('#t .tx').color), act: rgb(cs('#t .act').color), x: rgb(cs('#t .x').color), page: rgb(cs('body').backgroundColor) };
      });
      const tag = `${mode} ${cls}`;
      ok(contrast(px.text, px.wash) >= 4.5, `${tag}: the message text reads on the toast (contrast >= 4.5)`, Math.round(contrast(px.text, px.wash) * 100) / 100);
      ok(contrast(px.act, px.wash) >= 3, `${tag}: the View action reads on the toast (>= 3)`, Math.round(contrast(px.act, px.wash) * 100) / 100);
      ok(contrast(px.x, px.wash) >= 3, `${tag}: the close mark reads on the toast (>= 3)`, Math.round(contrast(px.x, px.wash) * 100) / 100);
      if (mode === 'light') ok(lum(px.wash) > 0.5, `${tag}: the toast is a light box on a light page`, Math.round(lum(px.wash) * 100) / 100);
      await p.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
