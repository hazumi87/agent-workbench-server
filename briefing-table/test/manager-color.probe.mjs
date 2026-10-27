/* The session colour is settable WITHOUT a host colour dialog, and the form
   shows what the colour is. Both halves of "locked on color". */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE = process.env.WB || 'http://127.0.0.1:7448';
const TOKEN = readFileSync('C:/code/briefing-table/secrets/engine.token', 'utf8').trim();
let f = 0;
const ok = (c, l, d) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${d ? `  — ${d}` : ''}`); if (!c) f++; };
const hdr = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

const b = await chromium.launch();
const ctx = await b.newContext({ extraHTTPHeaders: hdr, ignoreHTTPSErrors: true, viewport: { width: 1400, height: 1300 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
p.on('dialog', (d) => { console.log('  DIALOG:', d.message()); d.dismiss(); });
p.on('request', (r) => { if (r.url().includes('/api/recipes') && r.method() !== 'GET') console.log('  ->', r.method(), r.url()); });
p.on('response', (r) => { if (r.url().includes('/api/recipes') && r.request().method() !== 'GET') console.log('  <-', r.status()); });
await p.goto(`${BASE}/manager.html`, { waitUntil: 'networkidle' });
await p.waitForTimeout(800);

await p.evaluate(() => { location.hash = '#recipes'; }); // the recipe editor's button lives on the Recipes screen
await p.click('#newBtn');
await p.waitForSelector('#fColorBtn');

const rgb = (s) => s.replace(/\s/g, '');
const swatch0 = await p.$eval('#fColorBtn', (e) => getComputedStyle(e).backgroundColor);
ok(rgb(swatch0) === 'rgb(34,184,168)', 'the swatch paints the current colour', swatch0);

/* THE POINT: no OS dialog anywhere in this path. */
await p.click('#fColorBtn');
ok(!(await p.$eval('#fColorPop', (e) => e.hidden)), 'clicking the swatch opens the palette');
const chips = await p.$$eval('.f-colorchip', (els) => els.length);
ok(chips >= 10, 'the palette offers the chrome-safe tints', String(chips));

await p.click('.f-colorchip[data-hex="#ba0d0d"]');
await p.waitForTimeout(150);
ok(await p.$eval('#fColorPop', (e) => e.hidden), 'picking a chip closes the palette');
ok(rgb(await p.$eval('#fColorBtn', (e) => getComputedStyle(e).backgroundColor)) === 'rgb(186,13,13)',
  '...and the swatch follows immediately');
ok((await p.$eval('#fColor', (e) => e.value)) === '#ba0d0d', '...and the value the form SAVES is the new one');

/* A hand-typed hex, applied only when complete. */
await p.click('#fColorBtn');
await p.fill('#fColorHex', '#2b7a4b');
await p.waitForTimeout(200);
ok((await p.$eval('#fColor', (e) => e.value)) === '#2b7a4b', 'a typed hex is accepted', '#2b7a4b');
await p.fill('#fColorHex', '#2b7');
await p.waitForTimeout(200);
ok((await p.$eval('#fColor', (e) => e.value)) === '#2b7a4b', '...and a half-typed one changes nothing');

/* It must actually reach the engine, and come back on re-open. */
await p.fill('#fName', `__probe_color_${Date.now()}`);
/* Deterministic: the swatch TOGGLES, and `fill` focuses without a pointer
   event, so the palette's state here depends on history. Open it only if shut. */
if (await p.$eval('#fColorPop', (e) => e.hidden)) { await p.click('#fColorBtn'); }
await p.fill('#fColorHex', '#7d3cc8');
await p.waitForTimeout(200);
/* THE REGRESSION THIS GUARDS: as an absolutely-positioned overlay the palette
   sat on top of the form's Save button, and because it lived inside the colour
   wrap the outside-click handler never closed it — so a real click landed on
   the palette and Save silently did nothing. Geometry is the honest test: the
   two must not intersect while the palette is open. */
const overlap = await p.evaluate(() => {
  const a = document.getElementById('fColorPop').getBoundingClientRect();
  const b = document.getElementById('saveBtn').getBoundingClientRect();
  const hit = !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  return { hit, pop: [Math.round(a.top), Math.round(a.bottom)], save: [Math.round(b.top), Math.round(b.bottom)] };
});
ok(!overlap.hit, 'the open palette does not cover the Save button',
  `palette ${overlap.pop.join('-')}, save ${overlap.save.join('-')}`);

/* The click itself goes through the element, not coordinates: this form is
   taller than the modal's scroll box in a short window, which is a separate
   pre-existing layout question and not what this probe is about. */
await p.evaluate(() => document.getElementById('saveBtn').click());
await p.waitForTimeout(1200);
const formState = await p.evaluate(() => ({
  modalOpen: !document.getElementById('formModal').hidden,
  warn: (document.getElementById('fDirWarn')?.textContent || '').trim().slice(0, 80),
  warnHidden: document.getElementById('fDirWarn')?.hidden,
  target: document.getElementById('fTarget')?.value,
}));
console.log('  form after save:', JSON.stringify(formState));
const saved = (await (await fetch(`${BASE}/api/recipes`, { headers: hdr })).json())
  .recipes.filter((r) => /^__probe_color_/.test(r.name));
ok(saved.length === 1 && saved[0].color === '#7d3cc8', 'the chosen colour is what the engine stores',
  saved[0] ? saved[0].color : 'no recipe saved');

if (saved[0]) {
  await p.click(`.sess:has(.sess-name:text-is("${saved[0].name}")) [data-act="edit"]`).catch(() => {});
  await p.waitForTimeout(700);
  const reopened = await p.$eval('#fColorBtn', (e) => getComputedStyle(e).backgroundColor).catch(() => '');
  ok(rgb(reopened) === 'rgb(125,60,200)', 're-opening the recipe SHOWS its colour', reopened);
  await fetch(`${BASE}/api/recipes/${saved[0].id}`, { method: 'DELETE', headers: hdr }).catch(() => {});
}

/* THE DIALOG MUST ALWAYS BE LEAVEABLE. A stray </div> left by an earlier edit
   closed the Theme row early and threw the action row clean out of the form's
   scroll box, so Save and Cancel were unreachable at EVERY height — "i can't
   leave the dialog" (Owner, 2026-09-21). Structure, not styling, and invisible
   to any test that only asked whether the colour control worked. Checked at
   four heights, palette open and shut, and the hit test proves the button is
   the element a real click would reach. */
for (const h of [1200, 900, 760, 640]) {
  await p.setViewportSize({ width: 1400, height: h });
  for (const open of [false, true]) {
    await p.evaluate((o) => {
      const pop = document.getElementById('fColorPop');
      if (pop.hidden === o) { document.getElementById('fColorBtn').click(); }
    }, open);
    await p.waitForTimeout(250);
    const m = await p.evaluate(() => {
      const f = document.getElementById('form').getBoundingClientRect();
      const s = document.getElementById('saveBtn').getBoundingClientRect();
      const c = document.getElementById('cancelBtn').getBoundingClientRect();
      const inBox = (r) => r.top >= f.top - 1 && r.bottom <= f.bottom + 1 && r.height > 0;
      const el = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
      return { save: inBox(s), cancel: inBox(c), hit: el ? el.id : 'none' };
    });
    ok(m.save && m.cancel && m.hit === 'saveBtn',
      `Save and Cancel are reachable at ${h}px with the palette ${open ? 'open' : 'shut'}`,
      `save=${m.save} cancel=${m.cancel} hit=${m.hit}`);
  }
}

ok(errs.length === 0, 'no page errors', errs.slice(0, 3).join(' | ') || 'clean');
await b.close();
process.exit(f ? 1 : 0);
