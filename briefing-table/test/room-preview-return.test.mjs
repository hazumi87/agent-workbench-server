/**
 * PREVIEW ✕ RETURNS [ticket, Owner 2026-10-05]. The SHIPPED web/room-preview.mjs
 * in Chromium (headless, a static server on P(345), the real room.css), plus
 * source slices of room-cells.mjs for the wiring.
 *
 *   When the column shows content that did NOT come from the app view under it,
 *   the view it replaced goes on a short return stack (cap 5); ✕, Esc and the
 *   phone's back control pop it. The column closes only when there is nothing
 *   to return to. An app's own navigation pushes nothing. A real close()
 *   forgets the stack. The returned view's frame is never reloaded.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree } from './_scratch.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const PORT = P(345);
const BASE = `http://127.0.0.1:${PORT}`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
let passed = 0;
let failed = 0;
function eq(a, b, label) {
  if (JSON.stringify(a) === JSON.stringify(b)) {
    passed++;
  } else {
    failed++;
    console.log(`  X ${label}\n      got  ${JSON.stringify(a)}\n      want ${JSON.stringify(b)}`);
  }
}

const HARNESS = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/vendor/aurora-tokens.css"><link rel="stylesheet" href="/room.css">
<body style="margin:0"><main id="main" class="rm-main" style="height:600px"><aside id="preview" hidden></aside></main>
<script type="module">
import { mountPreview } from '/room-preview.mjs';
const pv = mountPreview({ main: document.getElementById('main'), el: document.getElementById('preview') });
window.pv = pv;
window.loads = {};
/* a "view": an outer div holding a frame that counts its loads */
window.mkView = (id) => {
  const outer = document.createElement('div');
  const f = document.createElement('iframe');
  f.srcdoc = '<p>' + id + '</p>';
  f.addEventListener('load', () => { window.loads[id] = (window.loads[id] || 0) + 1; });
  outer.append(f);
  return outer;
};
window.views = {};
/* the room-cells wiring, in miniature: viewSpec / showView / openView / openItem */
window.showView = (owner, foreign) => {
  const v = window.views[owner];
  pv.open({ owner, key: null, type: owner, name: v.title, body: v.outer, foreign: !!foreign, view: spec(owner) });
};
const spec = (owner) => ({ node: window.views[owner].outer, label: window.views[owner].title, restore: () => { if (!window.views[owner]?.outer.isConnected) return false; window.showView(owner); return true; } });
window.openView = (owner, title) => {
  const cur = pv.current();
  const foreign = !!cur && cur.owner !== owner;
  if (!window.views[owner]) window.views[owner] = { title, outer: window.mkView(owner) };
  else window.views[owner].title = title;
  window.showView(owner, foreign);
};
window.openItem = (owner, key, fromView) => {
  const b = document.createElement('div'); b.className = 'pv-item'; b.textContent = key;
  pv.open({ owner, key, type: 'IMG', name: key, body: b, foreign: !fromView, view: fromView ? spec(owner) : null,
    keep: fromView ? [window.views[owner].outer] : [], back: fromView ? { label: 'Back to ' + window.views[owner].title, go: () => window.showView(owner) } : null });
};
window.ready = true;
</script>`;

await assertFree(PORT);
const srv = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__pv.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HARNESS);
    return;
  }
  const f = join(WEB, normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
  if (f.startsWith(WEB) && existsSync(f) && statSync(f).isFile()) {
    res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
    res.end(readFileSync(f));
    return;
  }
  res.writeHead(404);
  res.end('no');
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 700 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/__pv.html`);
  await page.waitForFunction(() => window.ready);
  const state = () => page.evaluate(() => ({ open: !document.getElementById('preview').hidden, owner: window.pv.current()?.owner ?? null, key: window.pv.current()?.key ?? null, ret: window.pv.returns(), name: document.querySelector('.pv-name').textContent, xTitle: document.querySelector('.pv-x').title }));
  const settle = () => page.waitForTimeout(150);

  /* 1. an app's own view: ✕ just closes */
  await page.evaluate(() => window.openView('assets', 'Assets view'));
  await settle();
  eq((await state()).ret, [], 'own view: nothing to return to');
  eq((await state()).xTitle, 'Close (Esc)', 'own view: ✕ says Close');
  await page.click('.pv-x');
  eq((await state()).open, false, 'own view: ✕ closes');

  /* 2. foreign item over a view: ✕ returns to the view, without reloading it */
  await page.evaluate(() => window.openView('tasks', 'Task board'));
  await settle();
  const loadsBefore = await page.evaluate(() => window.loads.tasks);
  await page.evaluate(() => window.openItem('assets', 'room.png', false));
  await settle();
  let s = await state();
  eq([s.owner, s.key, s.ret], ['assets', 'room.png', ['Task board']], 'foreign item: the view is on the stack');
  eq(s.xTitle, 'Back to Task board', 'foreign item: ✕ names where it goes');
  await page.click('.pv-x');
  s = await state();
  eq([s.open, s.owner, s.name, s.ret], [true, 'tasks', 'Task board', []], '✕ returns to the previous view');
  eq(await page.evaluate(() => window.loads.tasks), loadsBefore, 'the returned view frame was not reloaded');
  eq(await page.evaluate(() => document.querySelectorAll('.pv-b > div').length), 1, 'only the view is in the column again');
  await page.click('.pv-x');
  eq((await state()).open, false, '✕ on the returned view closes (nothing left)');

  /* 3. another app's view: the first view is returned to; own navigation pushes nothing */
  await page.evaluate(() => window.openView('tasks', 'Task board'));
  await page.evaluate(() => window.openView('tasks', 'Task board 2'));
  eq((await state()).ret, [], "an app's own navigation pushes nothing");
  await page.evaluate(() => window.openView('assets', 'Assets view'));
  await settle();
  eq((await state()).ret, ['Task board 2'], "another app's view pushes the view it replaced");
  await page.keyboard.press('Escape');
  s = await state();
  eq([s.owner, s.name], ['tasks', 'Task board 2'], 'Esc pops too');
  await page.keyboard.press('Escape');
  eq((await state()).open, false, 'Esc closes at the bottom');

  /* 4. an item from the view underneath keeps its Back trail; ✕ closes (stack empty) */
  await page.evaluate(() => window.openView('tasks', 'Task board'));
  await page.evaluate(() => window.openItem('tasks', 'T-1', true));
  s = await state();
  eq(s.ret, [], 'item from the view: nothing pushed');
  eq(await page.evaluate(() => document.querySelector('.pv-trail').hidden), false, 'item from the view: Back trail shown');
  await page.click('.pv-x');
  eq((await state()).open, false, 'item from the view: ✕ closes');

  /* 5. a chain, then a real close() forgets it */
  await page.evaluate(() => { window.openView('tasks', 'Task board'); window.openItem('assets', 'a.png', false); window.openView('docs', 'Docs'); });
  await settle();
  eq((await state()).ret, ['Task board'], 'view -> foreign item -> other view: only views stack (the item had no view)');
  await page.evaluate(() => window.openItem('assets', 'b.png', false));
  eq((await state()).ret, ['Docs', 'Task board'], 'a second foreign content stacks the second view');
  await page.click('.pv-x');
  eq((await state()).name, 'Docs', 'pop 1');
  await page.evaluate(() => window.pv.close());
  s = await state();
  eq([s.open, s.ret], [false, []], 'a real close() forgets the stack');
  await page.evaluate(() => window.openView('docs', 'Docs'));
  eq((await state()).ret, [], 'the next open starts with an empty stack');
  await page.evaluate(() => window.pv.close());

  /* 6. the cap */
  const names = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7'];
  await page.evaluate((n) => { for (const id of n) window.openView(id, id); }, names);
  s = await state();
  eq(s.ret, ['v6', 'v5', 'v4', 'v3', 'v2'], 'the stack holds 5; the oldest falls off');
  eq(await page.evaluate(() => document.querySelectorAll('.pv-b > div').length), 6, 'the dropped view is removed from the column (5 stacked + the current)');
  for (let i = 0; i < 5; i++) await page.click('.pv-x');
  eq((await state()).name, 'v2', 'five pops return down to the oldest kept');
  await page.click('.pv-x');
  eq((await state()).open, false, 'then ✕ closes');

  /* 7. forget(owner), and a stacked view that is gone is skipped */
  await page.evaluate(() => { window.pv.close(); window.openView('a', 'A'); window.openView('b', 'B'); window.openView('c', 'C'); });
  eq((await state()).ret, ['B', 'A'], 'setup a, b, c');
  await page.evaluate(() => window.pv.forget('b'));
  eq((await state()).ret, ['A'], 'forget(owner) drops that owner');
  await page.evaluate(() => { window.views.a.outer.remove(); });
  await page.click('.pv-x');
  eq((await state()).open, false, 'a stacked view that is gone is skipped, then the column closes');

  /* 8. phone: the layer's back control pops the same way */
  await page.setViewportSize({ width: 390, height: 800 });
  await page.evaluate(() => { window.openView('tasks', 'Task board'); window.openItem('assets', 'phone.png', false); });
  await settle();
  eq(await page.evaluate(() => getComputedStyle(document.querySelector('.pv-back')).display !== 'none'), true, 'phone: back control is shown');
  await page.click('.pv-back');
  s = await state();
  eq([s.open, s.name], [true, 'Task board'], 'phone: back returns to the previous view');
  await page.click('.pv-back');
  eq((await state()).open, false, 'phone: back closes when nothing is left');

  eq(errors, [], 'no page errors');
} catch (e) {
  failed++;
  console.log(`  X threw: ${e?.stack ?? e}`);
} finally {
  await browser.close();
  srv.close();
}

/* ---- the room-cells wiring (source slices) ---- */
{
  const src = readFileSync(join(WEB, 'room-cells.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const slice = (a, b) => {
    const i = src.indexOf(a);
    const j = src.indexOf(b, i);
    return i >= 0 && j > i ? src.slice(i, j) : '';
  };
  const item = slice('  function openItem(v, raw) {', '  /** The column\'s Expand');
  eq(/foreign: !fromView/.test(item) && /view: fromView \? viewSpec\(c, c\.vv\) : null/.test(item), true, 'openItem: foreign unless it came from the view underneath');
  const ov = slice('  function openViewOf(', '  /* ---- LARGE');
  eq(/showView\(c, opener, foreignView\(c\)\)/.test(ov), true, 'openViewOf (reuse): another app is foreign');
  eq(/const foreign = foreignView\(c\);[\s\S]*o\.preview\.forget\(ownerOf\(c\)\)[\s\S]*foreign, view: viewSpec\(c, vv\)/.test(ov), true, 'openViewOf (new): forgets its own old view, passes foreign + view');
  eq(/foreignView = \(c\) =>[\s\S]{0,120}cur\.owner !== ownerOf\(c\)/.test(src), true, 'foreignView compares owners (own navigation is not foreign)');
  eq(/cells\.delete\(id\);\n\s*o\.preview\?\.forget\(ownerOf\(c\)\);/.test(src), true, 'a panel that leaves the room is forgotten');
  const rp = readFileSync(join(WEB, 'room-preview.mjs'), 'utf8').replace(/\r\n/g, '\n');
  eq(/x\.addEventListener\('click', \(\) => dismiss\(\)\)/.test(rp) && /back\.addEventListener\('click', \(\) => dismiss\(\)\)/.test(rp), true, '✕ and the phone back control dismiss (pop or close)');
}
console.log(`\nPASS ${passed}  FAIL ${failed}`);
process.exit(failed ? 1 : 0);
