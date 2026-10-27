/* Icon-sets STYLE STUDIO probe — asserts against a live engine (:7420, or
 * HARBOR_WB_PORT).
 *
 * WHY THIS EXISTS. The art's treatment — line style, wash origin, backlit, and
 * the default scale/opacity a recipe inherits — used to be edited in the recipe
 * editor's logo modal, where NONE of it could be seen: that modal previewed the
 * pre-v21 flat ghost, which by construction ignores all three v21 fields. Owner,
 * 2026-09-19: "the logo dialog doesn't update the preview after you change line
 * style, so i can't see it enabled." The settings moved here, where the preview
 * is a mock session pane, per the design system own ruling in hwb-watermark.css ("line
 * style per logo, chosen in the engine's icon editor").
 *
 * So the thing under test is not "does a control exist" but "does turning it
 * change what the pane paints" — every assertion reads COMPUTED style off the
 * rendered mark, never the control's own value.
 *
 * NON-DESTRUCTIVE on real data: it creates its own set, edits only that, and
 * deletes it in a finally — including on failure (the 2026-09-03 ratings
 * incident: a probe must not leave rows in Owner's manager).
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const PORT = process.env.HARBOR_WB_PORT ?? '7420';
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = readFileSync(new URL('../secrets/engine.token', import.meta.url), 'utf8').trim();
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

let failures = 0;
const ok = (cond, label, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!cond) {
    failures++;
  }
};
const api = (p, opts) => fetch(`${BASE}${p}`, { headers: H, ...opts }).then((r) => r.json());

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M4 4h16v16H4z"/></svg>';
const name = `probe-style-${Date.now()}`;
const made = await api('/api/icon-lab/import', { method: 'POST', body: JSON.stringify({ svg: SVG, name }) });
const id = made?.logo?.id;
ok(!!id, 'probe set created', made?.error || `#${id}`);

let browser;
try {
  browser = await chromium.launch();
  const ctx = await browser.newContext({
    extraHTTPHeaders: { authorization: `Bearer ${TOKEN}` },
    viewport: { width: 1400, height: 950 },
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto(`${BASE}/art.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  /* Select OUR set by name — never `.ic-row` first, which is whatever the
     library happens to sort first and may be an the design system pin. */
  await page.click(`.ic-row:has(.ic-row-name:text-is("${name}"))`);
  await page.waitForSelector('.ic-style');

  /* The preview is the v21 PANE rendering, which is the whole point: a flat
     ghost cannot show a line style, a wash or a glow. */
  ok(await page.$eval('.ic-pane', (e) => e.classList.contains('wm-pane')), 'the preview pane is a .wm-pane');
  ok(/radial-gradient/.test(await page.$eval('.ic-pane', (e) => getComputedStyle(e).backgroundImage)),
    '...and the directional wash actually paints');
  ok(await page.$eval('.ic-wm svg', (e) => e.classList.contains('wm')), '...and the mark is the bundle\'s .wm');

  /* LINE STYLE — the setting that looked dead. Each family fails differently,
     so each is read where it shows: a stroke override on the shapes, a mask on
     the svg. Asserting only the class would pass with the stylesheet missing. */
  for (const line of ['outline', 'blueprint', 'engrave', 'halftone']) {
    await page.selectOption('[data-s="line"]', line);
    ok(await page.$eval('.ic-wm svg', (e, l) => e.classList.contains(`wm-line-${l}`), line),
      `line "${line}" reaches the mark`);
  }
  await page.selectOption('[data-s="line"]', 'outline');
  ok((await page.$eval('.ic-wm svg path', (e) => getComputedStyle(e).fill)) === 'none',
    '...outline strokes rather than fills');
  await page.selectOption('[data-s="line"]', 'halftone');
  ok(/radial-gradient/.test(await page.$eval('.ic-wm svg',
    (e) => getComputedStyle(e).webkitMaskImage || getComputedStyle(e).maskImage)),
    '...halftone applies its mask');
  await page.selectOption('[data-s="line"]', 'none');
  ok(!(await page.$eval('.ic-wm svg', (e) => [...e.classList].some((c) => c.startsWith('wm-line-')))),
    '...and "none" leaves a flat fill, minting no class');

  /* BACKLIT is a WRAPPER, not a class on the svg — a masked element would clip
     its own glow (hwb-watermark.css W13). */
  await page.selectOption('[data-s="backlit"]', '0');
  ok(!(await page.$('.ic-wm .wm-backlit')), 'backlit off removes the glow wrapper');
  await page.selectOption('[data-s="backlit"]', '1');
  ok(!!(await page.$('.ic-wm .wm-backlit')), '...and on restores it');

  await page.selectOption('[data-s="washFrom"]', 'ur');
  ok(await page.$eval('.ic-pane', (e) => e.classList.contains('wm-at-ur')), 'the wash origin moves');

  await page.fill('[data-s="scale"]', '40');
  await page.dispatchEvent('[data-s="scale"]', 'input');
  ok((await page.$eval('.ic-wm', (e) => e.style.width)) === '40%', 'scale sizes the mark');

  await page.fill('[data-s="opacity"]', '35');
  await page.dispatchEvent('[data-s="opacity"]', 'input');
  ok((await page.$eval('.ic-pane', (e) => getComputedStyle(e).getPropertyValue('--wm-op').trim())) === '0.35',
    'opacity drives --wm-op (the bundle reads nothing else)');

  /* THE HUE IS THE PROJECT'S OWN, and it is set right here now. The header used
     to carry tint swatches that overrode every preview with one chosen color —
     a study control that, once each project's art carried its own color,
     concealed exactly what the page exists to show (Owner, 2026-09-21). So the
     assertion moved with the source: changing the PROJECT color repaints the
     watermark, and does it without a rerender that would throw away the other
     controls' state. */
  ok(!(await page.$('.ic-tint')), 'the global tint override is gone from the header');
  const before = await page.$eval('.ic-pane', (e) => getComputedStyle(e).getPropertyValue('--wm-pc').trim());
  await page.evaluate(() => {
    const el = document.querySelector('[data-s="color"]');
    el.value = '#0dab49';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const after = await page.$eval('.ic-pane', (e) => getComputedStyle(e).getPropertyValue('--wm-pc').trim());
  ok(before !== after && after.toLowerCase() === '#0dab49',
    "the project's color repaints the watermark hue", `${before} -> ${after}`);
  ok((await page.$eval('[data-s="opacity"]', (e) => e.value)) === '35', '...without resetting the controls');

  /* PERSISTENCE. The engine stores the style on the SET (`logos.style`). Until
     that field exists the bar must SAY the save failed rather than look saved —
     silence here is the failure mode this whole file exists to catch. */
  await page.waitForTimeout(900);
  const note = await page.$eval('.ic-style-note', (e) => e.textContent.trim());
  const reload = await api(`/api/logos`);
  const row = (reload.logos || []).find((l) => l.id === id);
  const saved = row && row.style;
  if (saved) {
    const st = typeof saved === 'string' ? JSON.parse(saved) : saved;
    ok(st.opacity === 35 && st.washFrom === 'ur', 'the style is stored on the set', JSON.stringify(st));
    ok(!/not saved/.test(note), '...and the bar says so', note);
    /* AND IT COMES BACK. Storing it is half the feature: the list projection
       feeding the detail pane dropped `style`, so the bar repainted defaults on
       every selection and a saved treatment was invisible — which reads as
       "it did not save" and is what Owner reported. */
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    await page.click(`.ic-row:has(.ic-row-name:text-is("${name}"))`);
    await page.waitForSelector('.ic-style');
    ok((await page.$eval('[data-s="opacity"]', (e) => e.value)) === '35',
      '...and a reload shows the stored value, not the default');
    ok((await page.$eval('[data-s="washFrom"]', (e) => e.value)) === 'ur',
      '...for every channel');
  } else {
    ok(/not saved/.test(note), 'no `style` field yet — and the bar SAYS it did not save', note);
  }

  /* The PATCH's own 400 is the expected outcome while the field is pending, so
     it is discounted HERE and only here — ignoring 400s outright would blind
     this probe to the next one. */
  /* ---- THE TAB MARK, the art's SECOND surface ----
     Judged separately from the watermark on purpose: line art that reads
     perfectly at 80% of a pane anti-aliases to a pale edge at 20px (runtime),
     and the levers for that are presentation, never shape. */
  await page.fill('[data-m="opacity"]', '55');
  await page.dispatchEvent('[data-m="opacity"]', 'input');
  await page.waitForTimeout(200);
  const markOp = await page.$eval('.ic-size-box.s20', (e) => e.style.opacity);
  ok(markOp === '0.55', 'mark opacity reaches the 20px mark', markOp);
  const tabOp = await page.$eval('.ic-tlogo', (e) => e.style.opacity);
  ok(tabOp === '0.55', '...and the mock tab glyph, which is the same art', tabOp);
  /* The watermark must NOT move: two surfaces, two treatments. */
  const wmOp = await page.$eval('.ic-pane', (e) => getComputedStyle(e).getPropertyValue('--wm-op').trim());
  ok(wmOp !== '0.55', '...without touching the watermark', wmOp);

  await page.selectOption('[data-m="tintmode"]', 'fixed');
  await page.waitForTimeout(150);
  ok(!(await page.$eval('[data-m="pickwrap"]', (e) => e.hidden)), 'choosing a fixed tint reveals the picker');
  await page.evaluate(() => {
    const el = document.querySelector('[data-m="tint"]');
    el.value = '#3a4a5a';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(200);
  const col = await page.$eval('.ic-size-box.s20', (e) => getComputedStyle(e).color);
  ok(/58,\s*74,\s*90/.test(col), 'a fixed tint paints the mark, not the project hue', col);
  await page.selectOption('[data-m="tintmode"]', 'auto');
  await page.waitForTimeout(200);
  ok(await page.$eval('.ic-size-box.s20', (e) => !e.style.color),
    'back to Project colour clears the override rather than freezing a value');

  /* ---- INHERITANCE, the other half of the split ----
     A recipe gets the art's treatment at PICK time and nowhere else: the
     Icons page never reaches into a recipe, so styling a set cannot silently
     restyle panes already wearing it, and re-saving a recipe cannot drop what
     the Icons page set. Skipped when the engine cannot store a style yet —
     there would be nothing to inherit. */
  if (saved) {
    const mp = await ctx.newPage();
    const mErrors = [];
    mp.on('pageerror', (e) => mErrors.push(String(e)));
    await mp.goto(`${BASE}/manager.html#recipes`, { waitUntil: 'networkidle' });
    await mp.waitForTimeout(600);
    await mp.evaluate(() => { location.hash = '#recipes'; }); // the recipe editor's button lives on the Recipes screen
    await mp.click('#newBtn');
    await mp.click('#fLogoBtn');
    await mp.waitForSelector('.lm-modal.open');
    ok(!(await mp.$('[data-el="line"]')), 'the recipe modal no longer edits the art treatment');
    ok(!!(await mp.$('.lm-wm a[href="/art.html"]')), '...it points here instead');
    await mp.waitForFunction(() => document.querySelectorAll('.lm-preset option').length > 2);
    await mp.selectOption('.lm-preset', `saved:${id}`);
    await mp.waitForTimeout(300);
    ok((await mp.$eval('[data-el="scale"]', (e) => e.value)) === '40', 'picking the set inherits its default scale');
    ok((await mp.$eval('[data-el="opacity"]', (e) => e.value)) === '35', '...and its default opacity');
    ok(await mp.$eval('.lm-prev-wrap', (e) => e.classList.contains('wm-pane')),
      '...and the modal previews in the PANE rendering, not the flat ghost');
    ok(!!(await mp.$('.lm-prev .wm-backlit')), '...carrying the art\'s backlit setting');
    errors.push(...mErrors);
    await mp.close();
  }

  const noise = saved ? [] : errors.filter((e) => /status of 400/.test(e));
  const real = errors.filter((e) => !noise.includes(e));
  ok(real.length === 0, 'no page errors', real.slice(0, 3).join(' | ') || 'clean');
} finally {
  if (browser) {
    await browser.close();
  }
  if (id) {
    await fetch(`${BASE}/api/logos/${id}`, { method: 'DELETE', headers: H }).catch(() => {});
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
