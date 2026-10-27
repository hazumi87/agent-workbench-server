/* THE NOTE TILE (the design system scratchpad, option A) in a REAL browser [ticket].
 *
 *   node test/note-tile.probe.mjs [outdir]    (screenshots go to outdir)
 *
 * No engine: a static page with the real room.css / room-attach.css /
 * room-notes.css and the real web/room-attach.mjs (mountAttach + sentView).
 * Measures the tile in every context (sent PC 90x120, sent phone 75x100,
 * tray PC 64x64, tray phone 56x56, keyboard up 40x40) and screenshots the
 * tray and the sent message at PC width and phone 390.
 */
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const OUT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'tmp-notetile-shots');
mkdirSync(OUT, { recursive: true });
let passed = 0;
let failed = 0;
const ok = (c, m) => {
  c ? passed++ : failed++;
  console.log(`  ${c ? '+' : 'X'} ${m}`);
};

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/vendor/aurora-tokens.css"><link rel="stylesheet" href="/room.css"><link rel="stylesheet" href="/room-attach.css"><link rel="stylesheet" href="/room-notes.css">
<style>body{background:var(--ink)} #sent{list-style:none;margin:0;padding:12px 16px} .bubble{padding:10px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;max-width:640px;margin-left:auto;width:fit-content}</style></head>
<body>
<ol id="sent"></ol>
<form class="rm-compose" id="compose" style="display:flex"><div class="rm-tray" id="attTray"></div><button type="button" class="rm-attach" id="attBtn">+</button>
<div class="rm-inputwrap"><textarea id="input" rows="1" placeholder="Message the lead"></textarea></div><button type="submit" class="rm-send">&rarr;</button></form>
<script type="module">
import { mountAttach, sentView } from '/room-attach.mjs';
const q = new URLSearchParams(location.search);
const hash = (c) => 'note-' + c.repeat(12) + '.txt';
const tray = document.getElementById('attTray');
const list = [{ id: 'a'.repeat(32), name: hash('a'), type: 'text/plain', size: 10, key: 'q' }];
if (q.get('img')) list.unshift({ id: 'e'.repeat(32), name: 'photo.png', type: 'image/png', size: 70, key: 's' });
if (q.get('file')) list.push({ id: 'b'.repeat(32), name: 'brief.pdf', type: 'application/pdf', size: 2048, key: 'r' });
const att = mountAttach({
  roomId: 'r1', api: async () => ({ ok: true, body: { files: list } }),
  input: document.getElementById('input'), sendBtn: document.querySelector('.rm-send'), tray, note: Object.assign(document.createElement('p'), { hidden: true }),
  addBtn: document.getElementById('attBtn'), fileInput: (window.fileInput = Object.assign(document.createElement('input'), { type: 'file' })), dropZone: document.createElement('div'),
  preview: () => null, cells: () => null, isPhone: () => false, openApp() {}, refresh: async () => {},
  noteInfo: (id) => setTimeout(() => att.noteMeta(id, { title: 'Weekly review agenda', words: 612 }), 0), openNote: (id) => (window.opened = id),
});
await att.restore();
if (q.get('offer')) { const b = document.createElement('button'); b.type = 'button'; b.className = 'rm-note-offer'; b.textContent = 'Move to a note?'; tray.append(b); }
window.opened = null; window.clickedSent = [];
const files = [];
const n = (c, t) => ({ name: hash(c), type: 'text/plain', size: 89, raw: '/x', kind: 'note', title: t, words: 16 });
if (q.get('sent') === 'two') files.push(n('c', 'Buy oat milk'), n('d', 'Call the plumber'));
if (q.get('sent') === 'img') files.push({ name: 'p.png', type: 'image/png', size: 5, raw: '/p.png' }, n('c', 'Buy oat milk'));
if (files.length) {
  const li = document.createElement('li'); li.className = 'entry by-user';
  const b = document.createElement('div'); b.className = 'bubble'; b.textContent = 'here are the refs';
  b.append(sentView(files, { open: (f) => window.clickedSent.push(f.name), openAll() {} }));
  li.append(b); document.getElementById('sent').append(li);
}
window.ready = true;
</script></body></html>`;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const MIME = { '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript' };
const srv = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (req.method === 'POST') {
    // an upload: a name with ffff never answers (stays uploading), any other answers 500 (fails)
    req.resume();
    if (!decodeURIComponent(String(req.headers['x-filename'] ?? '')).includes('ffff')) {
      res.statusCode = 500;
      res.end('{}');
    }
    return;
  }
  if (p === '/') {
    res.setHeader('content-type', 'text/html');
    res.end(PAGE);
    return;
  }
  if (p === '/p.png' || p.includes('/scratch/')) {
    res.setHeader('content-type', 'image/png');
    res.end(PNG);
    return;
  }
  try {
    const body = readFileSync(join(WEB, p));
    res.setHeader('content-type', MIME[extname(p)] ?? 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('no');
  }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}/`;
const browser = await chromium.launch();

async function open(qs, ctxOpts) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => {
    failed++;
    console.log(`  X page error: ${e.message}`);
  });
  await page.goto(`${base}?${qs}`);
  await page.waitForFunction(() => window.ready === true);
  await page.waitForTimeout(150);
  return page;
}
const size = (page, sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
const PC = { viewport: { width: 1280, height: 500 } };
const PH = { viewport: { width: 390, height: 600 }, isMobile: true, hasTouch: true };
/** Add a file through the page's own picker (one that never finishes: ffff, or one that fails). */
const addFile = (page, name) => page.evaluate((n) => { const dt = new DataTransfer(); dt.items.add(new File(['x'], n, { type: 'text/plain' })); window.fileInput.files = dt.files; window.fileInput.dispatchEvent(new Event('change')); }, name);
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)}`);

for (const [name, ctx, tray, sent] of [['pc', PC, [64, 64], [90, 120]], ['phone', PH, [56, 56], [75, 100]]]) {
  console.log(name);
  let page = await open('file=1&offer=1', ctx);
  eq(await size(page, '#attTray .att-tile.is-note'), tray, 'tray tile');
  const t = await page.$eval('#attTray .att-tile.is-note', (e) => ({ text: [...e.childNodes].filter((c) => c.className !== 'att-sr' && c.className !== 'att-x').map((c) => c.textContent).join(''), srSize: Math.round(e.querySelector('.att-sr').getBoundingClientRect().width), label: e.getAttribute('aria-label'), title: e.title, sr: e.querySelector('.att-sr')?.textContent }));
  ok(t.text === '' && t.srSize <= 1 && t.label === 'Open note' && t.title === 'Open note' && t.sr === 'Weekly review agenda', 'tray tile: no visible text, aria-label, tooltip, first words for screen readers');
  const row = await page.$eval('#attTray', (tr) => { const o = tr.querySelector('.rm-note-offer').getBoundingClientRect(); const t = tr.querySelector('.att-tile.is-note').getBoundingClientRect(); return [Math.round(o.top + o.height / 2), Math.round(t.top + t.height / 2)]; });
  ok(Math.abs(row[0] - row[1]) <= 1, `the offer is centered on the tiles' row: ${row}`);
  page = await open('img=1&file=1&offer=1', ctx);
  const xs = await page.$$eval('#attTray .att-tile', (tl) => tl.map((t) => { const r = t.getBoundingClientRect(); const x = t.querySelector('.att-x').getBoundingClientRect(); return { kind: t.className, top: Math.round(x.top - r.top), right: Math.round(r.right - x.right), size: [Math.round(x.width), Math.round(x.height)] }; }));
  console.log('  x offsets: ' + JSON.stringify(xs));
  ok(xs.length === 3 && xs.every((v) => v.top === xs[0].top && v.right === xs[0].right && v.size[0] === xs[0].size[0]), 'image, note and file tiles: the three x controls have the same top/right offset and size');
  await page.screenshot({ path: join(OUT, `notetile-tray-img-note-file-${name}.png`), clip: { x: 0, y: 0, width: ctx.viewport.width, height: 120 } });
  page = await open('file=1&offer=1', ctx);
  await page.screenshot({ path: join(OUT, `notetile-tray-note-file-offer-${name}.png`), clip: { x: 0, y: 0, width: ctx.viewport.width, height: 120 } });
  if (name === 'phone') {
    page = await open('img=1&file=1', ctx);
    await page.evaluate(() => document.documentElement.classList.add('kb-up'));
    eq(await size(page, '#attTray .att-tile.is-note'), [40, 40], 'keyboard-up tray tile');
    await page.screenshot({ path: join(OUT, 'notetile-tray-kbup-phone.png'), clip: { x: 0, y: 0, width: 390, height: 100 } });
    /* keyboard up, measured for real: the 16px x never covers the center; the note's hit area is the upper-right quadrant */
    const kx = await page.$$eval('#attTray .att-tile', (tl) => tl.map((t) => { const r = t.getBoundingClientRect(); const x = t.querySelector('.att-x').getBoundingClientRect(); return { kind: t.className, size: [Math.round(x.width), Math.round(x.height)], off: [Math.round(x.left - r.left), Math.round(x.top - r.top), Math.round(r.right - x.right)] }; }));
    console.log('  kb-up x rects (size, left/top/right-gap): ' + JSON.stringify(kx));
    ok(kx.length === 3 && kx.every((v) => v.size[0] === 16 && v.size[1] === 16 && v.off[1] === kx[0].off[1] && v.off[2] === kx[0].off[2]), 'keyboard up: the x is 16x16 at the same top/right offset on image, note and file tiles');
    const scan = await page.$eval('#attTray .att-tile.is-note', (t) => { const r = t.getBoundingClientRect(); const x = t.querySelector('.att-x'); let minX = 1e9, maxY = -1e9; for (let py = 0; py < r.height; py += 0.5) for (let px = 0; px < r.width; px += 0.5) { const e = document.elementFromPoint(r.left + px, r.top + py); if (e === x || (e && x.contains(e))) { minX = Math.min(minX, px); maxY = Math.max(maxY, py); } } return { minX, maxY }; });
    console.log('  kb-up note x hit extent: ' + JSON.stringify(scan));
    ok(scan.minX >= 20 && scan.maxY <= 20, 'keyboard up: the note x hit area stays inside x >= 20, y <= 20');
    await page.screenshot({ path: join(OUT, 'tilefix-kbup-phone.png'), clip: { x: 0, y: 0, width: 390, height: 100 } });
    await page.locator('#attTray .att-tile.is-note').click({ position: { x: 20, y: 20 } });
    await page.waitForTimeout(100);
    ok((await page.evaluate(() => window.opened)) === 'aaaaaaaaaaaa' && (await page.$$('#attTray .att-tile')).length === 3, 'keyboard up: a tap at the exact center opens the note, does not remove it');
    await page.locator('#attTray .att-tile.is-note').click({ position: { x: 30, y: 10 } });
    await page.waitForTimeout(100);
    ok((await page.$$('#attTray .att-tile')).length === 2, 'keyboard up: a tap at 75% x / 25% y removes it');
  }
  page = await open('', ctx);
  await page.screenshot({ path: join(OUT, `notetile-tray-note-${name}.png`), clip: { x: 0, y: 0, width: ctx.viewport.width, height: 120 } });
  await page.locator('#attTray .att-tile.is-note').click({ position: { x: 24, y: 24 } }); // the pad's middle, never the remove control
  await page.waitForTimeout(100);
  ok((await page.evaluate(() => window.opened)) === 'aaaaaaaaaaaa', 'tapping the tray tile opens the live note');
  /* the x owns the UPPER-RIGHT QUADRANT and nothing more (the design system): the center opens, the quadrant removes */
  const qs = ['#attTray .att-tile.is-note'];
  page = await open('', ctx);
  await page.locator(qs[0]).click({ position: { x: tray[0] / 2 + 1, y: tray[1] / 2 + 1 } }); // just past the center
  await page.waitForTimeout(100);
  ok((await page.evaluate(() => window.opened)) === 'aaaaaaaaaaaa' && (await page.$$('#attTray .att-tile')).length === 1, 'a tap at the tile center opens the note and does not remove it');
  await page.locator(qs[0]).click({ position: { x: tray[0] * 0.75, y: tray[1] * 0.25 } });
  await page.waitForTimeout(100);
  ok((await page.$$('#attTray .att-tile')).length === 0, 'a tap inside the upper-right quadrant (75%, 25%) removes it');
  /* the hit area never crosses the midlines (where the control itself does not) */
  page = await open('', ctx);
  const hit = await page.$eval('#attTray .att-tile.is-note', (t) => { const x = t.querySelector('.att-x'); const a = getComputedStyle(x, '::after'); const r = t.getBoundingClientRect(); const c = x.getBoundingClientRect(); const o = [parseFloat(a.top), parseFloat(a.right), parseFloat(a.bottom), parseFloat(a.left)]; return { inset: o, left: c.left - r.left + o[3], bottom: c.bottom - r.top - o[2], mid: r.width / 2, ctlLeft: c.left - r.left, ctlBottom: c.bottom - r.top }; });
  console.log('  hit area (x::after inset top,right,bottom,left): ' + JSON.stringify(hit));
  ok(hit.left >= Math.min(hit.mid, hit.ctlLeft) - 0.5 && hit.bottom <= Math.max(hit.mid, hit.ctlBottom) + 0.5, 'the x hit area stays inside the upper-right quadrant (or the control itself where it already reaches the midline)');
  /* a note that is still uploading: the pad from the start, 45% opacity, a meter; same size as the finished one; a failed one is the wide chip */
  page = await open('', ctx);
  await addFile(page, 'note-ffffffffffff.txt');
  await page.waitForTimeout(150);
  const upw = await page.$$eval('#attTray .att-tile', (tl) => tl.map((t) => ({ cls: t.className, w: Math.round(t.getBoundingClientRect().width), h: Math.round(t.getBoundingClientRect().height), op: t.querySelector('.att-pad') ? getComputedStyle(t.querySelector('.att-pad')).opacity : null, meter: !!t.querySelector('.att-m i'), xt: (() => { const r = t.getBoundingClientRect(); const x = t.querySelector('.att-x').getBoundingClientRect(); return [Math.round(x.top - r.top), Math.round(r.right - x.right)]; })() })));
  console.log('  uploading vs finished: ' + JSON.stringify(upw));
  const [fin, upl] = [upw.find((v) => !v.cls.includes(' up')), upw.find((v) => v.cls.includes(' up'))];
  ok(upl && upl.cls.includes('is-note') && upl.op === '0.45' && upl.meter, 'an uploading note is the pad at 45% opacity with the meter in its foot');
  ok(upl && fin && upl.w === fin.w && upl.h === fin.h, `the uploading tile is the finished tile's size: ${upl && upl.w}x${upl && upl.h} vs ${fin && fin.w}x${fin && fin.h}`);
  ok(upl && fin && upl.xt[0] === fin.xt[0] && upl.xt[1] === fin.xt[1], 'the x stays upper right while uploading');
  await page.screenshot({ path: join(OUT, `tilefix-uploading-vs-finished-${name}.png`), clip: { x: 0, y: 0, width: ctx.viewport.width, height: 110 } });
  page = await open('', ctx);
  await addFile(page, 'note-eeeeeeeeeeee.txt');
  await page.waitForTimeout(250);
  const failed_ = await page.$$eval('#attTray .att-tile', (tl) => tl.map((t) => ({ cls: t.className, w: Math.round(t.getBoundingClientRect().width), retry: !!t.querySelector('.att-retry') })));
  const fl = failed_.find((v) => v.cls.includes('fail'));
  ok(fl && !fl.cls.includes('is-note') && fl.w > 150 && fl.retry, `a failed note upload is still the wide chip with the retry mark: ${JSON.stringify(fl)}`);
  page = await open('sent=two', ctx);
  eq(await size(page, '#sent .is-note'), sent, 'sent tile');
  eq(await page.$$eval('#sent .entry-att > .is-note', (e) => e.length), 2, 'two notes side by side in the image flow');
  eq(await page.$$eval('#sent .att-chips', (e) => e.length), 0, 'no chips row');
  await page.screenshot({ path: join(OUT, `notetile-sent-two-${name}.png`) });
  await page.click('#sent .is-note');
  eq(await page.evaluate(() => window.clickedSent), ['note-cccccccccccc.txt'], 'tapping a sent tile opens it (the preview)');
  page = await open('sent=img', ctx);
  const rows = await page.$eval('#sent .entry-att', (w) => [...w.children].map((c) => { const r = c.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; }));
  ok(rows.length === 2 && rows[0][0] === rows[1][0], `an image and a note on one row, tops ${rows.map((r) => r[0])}, heights ${rows.map((r) => r[1])}`);
  await page.screenshot({ path: join(OUT, `notetile-sent-img-note-${name}.png`) });
}

await browser.close();
srv.close();
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
