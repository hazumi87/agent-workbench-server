/**
 * ROOM DOCUMENT VIEWER [ticket]. The SHIPPED web/room-doc-view.mjs.
 *   Node (fetch stubbed): type detection (md, text, code, notes, images are
 *   never ours), the 2 MB cap (by header and by streamed bytes), http errors.
 *   Chromium (headless, a static server on P(330), the real vendored marked +
 *   DOMPurify): markdown renders headings / lists / tables / code / links;
 *   HOSTILE markdown (script, img onerror, javascript: and data: links, iframe,
 *   a style that would restyle the page, an svg with onload, forms, event
 *   handlers) comes out with none of it and nothing runs (window.__pwned stays
 *   undefined); every link is target=_blank rel=noopener noreferrer; images
 *   load only from https or the room's raw route; the toolbar order and
 *   labels; Copy contents copies the RAW text; Link copies the reference; the
 *   ... menu items (View source toggles); too large says so and offers Download;
 *   a source slice of room-cells' docOf: an image item keeps the old preview.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree } from './_scratch.mjs';
import { serveWeb } from './_docview-harness.mjs';

// Chromium on Windows reads the clipboard back with CRLF; the product copies LF.
const CRLF = String.fromCharCode(13, 10);
const LF = String.fromCharCode(10);
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const dv = await import(pathToFileURL(join(WEB, 'room-doc-view.mjs')).href);
let passed = 0;
let failed = 0;
function eq(a, b, label) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x === y) {
    passed++;
  } else {
    failed++;
    console.log(`  X ${label}\n      got  ${x}\n      want ${y}`);
  }
}
const ok = (v, label) => eq(!!v, true, label);

/* ---- type detection ---- */
eq(dv.docKind('plan.md', ''), 'markdown', 'plan.md is markdown');
eq(dv.docKind('README.MARKDOWN', 'application/octet-stream'), 'markdown', 'extension is case-blind');
eq(dv.docKind('x', 'text/markdown; charset=utf-8'), 'markdown', 'type text/markdown');
eq(dv.docKind('a.txt', 'text/plain'), 'text', '.txt is text');
eq(dv.docKind('run.log', ''), 'text', '.log is text');
eq(dv.docKind('d.json', 'application/json'), 'code', 'json is code (not wrapped)');
eq(dv.docKind('t.csv', ''), 'code', 'csv is code');
eq(dv.docKind('c.yaml', ''), 'code', 'yaml is code');
eq(dv.docKind('note-ab12.txt', 'text/plain', true), 'text', 'a note is text');
eq(dv.docKind('pic.png', 'image/png'), null, 'an image is not ours');
eq(dv.docKind('pic.md', 'image/png'), null, 'an image type beats a .md name');
eq(dv.docKind('a.pdf', 'application/pdf'), null, 'a pdf is not ours');
eq(dv.docKind('', ''), null, 'nothing is nothing');

/* ---- fetch + cap (stubbed) ---- */
const resp = (chunks, o = {}) => ({
  ok: o.ok ?? true,
  status: o.status ?? 200,
  headers: { get: (k) => (k === 'content-length' ? o.len ?? null : null) },
  body: { getReader() { let i = 0; return { read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }), cancel: async () => {} }; } },
});
const enc = (s) => new TextEncoder().encode(s);
eq(await dv.fetchDoc('/a', async () => resp([enc('he'), enc('llo é')])), { text: 'hello é' }, 'chunks join and decode as utf-8');
eq(await dv.fetchDoc('/a', async () => resp([enc('x')], { len: String(dv.MAX_BYTES + 1) })), { tooLarge: true }, 'content-length over 2 MB is too large');
eq(await dv.fetchDoc('/a', async () => resp([new Uint8Array(dv.MAX_BYTES), new Uint8Array(1)])), { tooLarge: true }, 'streamed bytes over 2 MB are too large');
eq(await dv.fetchDoc('/a', async () => resp([new Uint8Array(dv.MAX_BYTES)])).then((r) => r.text?.length), dv.MAX_BYTES, 'exactly 2 MB is allowed');
eq(await dv.fetchDoc('/a', async () => resp([], { ok: false, status: 404 })), { error: 'HTTP 404' }, 'an http error is named');
eq(await dv.fetchDoc('/a', async () => { throw new Error('boom'); }), { error: 'boom' }, 'a network error is named, never thrown');

/* ---- docOf (room-cells): sliced and run against stubs ---- */
{
  const src = readFileSync(join(WEB, 'room-cells.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const a = src.indexOf('  function docOf(it, base) {');
  const b = src.indexOf('  function itemBody(v, it)');
  ok(a > 0 && b > a, 'docOf is in room-cells');
  const safeUrl = (raw, base) => { try { const u = new URL(String(raw), base); return u.protocol.startsWith('http') ? u : null; } catch { return null; } };
  const made = [];
  const docOf = new Function('safeUrl', 'docKind', 'createDocView', `${src.slice(a, b)}\n return docOf;`)(safeUrl, dv.docKind, (o) => { made.push(o); return { body: 1 }; });
  const item = (o) => ({ type: 'FILE', title: 'T', image: null, actions: [], ...o });
  const dl = [{ label: 'Download', download: 'https://share.test/f/plan.md' }, { label: 'Copy reference', copy: 'https://share.test/ref/plan.md' }];
  ok(docOf(item({ title: 'plan.md', actions: dl }), 'https://x/'), 'a markdown item opens in the viewer');
  eq([made[0].kind, made[0].url, made[0].ref, made[0].name], ['markdown', 'https://share.test/f/plan.md', 'https://share.test/ref/plan.md', 'plan.md'], 'its url, reference and name');
  ok(docOf(item({ title: 'Plan', type: 'MD', actions: dl }), 'https://x/'), 'a type label MD counts');
  eq(docOf(item({ title: 'shot.png', image: 'https://share.test/f/shot.png', actions: [{ label: 'Open', open: 'https://share.test/f/shot.png' }] }), 'https://x/'), null, 'an image item keeps the old preview');
  eq(docOf(item({ title: 'a.pdf', actions: [{ label: 'Open', open: 'https://share.test/f/a.pdf' }] }), 'https://x/'), null, 'a pdf keeps the old preview');
  eq(docOf(item({ title: 'a.md', actions: [{ label: 'Copy', copy: 'x' }] }), 'https://x/'), null, 'no url to fetch: the old preview');
}

/* ---- the browser ---- */
const PORT = P(330);
await assertFree(PORT, 'room-doc-view.test');
const srv = await serveWeb(PORT);
const BASE = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/__harness.html`);
  await page.waitForFunction(() => window.ready);
  /* a mounted document with the stubbed fetch; the real libs load from /vendor */
  const mount = (text, o = {}) => page.evaluate(async ({ text, o }) => {
    window.__pwned = undefined;
    const d = window.mount({ name: o.name || 'doc.md', kind: o.kind || 'markdown', url: o.url || '/x.md', base: o.base, ref: o.ref, fetchDoc: async () => (o.result ?? { text }), menu: window.__menu });
    await new Promise((r) => setTimeout(r, 400));
    return d.kind;
  }, { text, o });
  const html = () => page.evaluate(() => document.querySelector('.dv').innerHTML);

  await mount('# Title\n\nHello **world** and `code`.\n\n- a\n- b\n\n| h1 | h2 |\n|----|----|\n| 1 | 2 |\n\n```js\nlet x = 1;\n```\n\n[ok](https://example.com/p) [mail](mailto:noreply@example.com)\n');
  const h = await html();
  ok(/<h1>Title<\/h1>/.test(h), 'renders a heading');
  ok(/<strong>world<\/strong>/.test(h) && /<li>a<\/li>/.test(h), 'renders emphasis and lists');
  ok(/<table>/.test(h) && /<th>h1<\/th>/.test(h), 'renders a table');
  ok(/<pre><code/.test(h) && /let x = 1;/.test(h), 'renders a code block');
  eq(await page.evaluate(() => [...document.querySelectorAll('.dv-md a')].map((a) => [a.getAttribute('href'), a.target, a.rel])), [['https://example.com/p', '_blank', 'noopener noreferrer'], ['mailto:noreply@example.com', '_blank', 'noopener noreferrer']], 'links keep http(s) and mailto, open in a new tab, noopener noreferrer');

  /* ---- hostile ---- */
  const evil = [
    '<script>window.__pwned = 1</script>',
    '<img src=x onerror="window.__pwned=2">',
    '<img src="https://example.com/a.png" onload="window.__pwned=3">',
    '[x](javascript:window.__pwned=4)',
    '[y](JaVaScRiPt:window.__pwned=5)',
    '[z](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '<a href="vbscript:msgbox(1)" onclick="window.__pwned=6">v</a>',
    '<iframe src="https://example.com" srcdoc="<script>parent.__pwned=7</script>"></iframe>',
    '<style>body{display:none !important} .rm-pv{position:fixed;inset:0;background:red}</style>',
    '<div style="position:fixed;inset:0;background:red">cover</div>',
    '<svg onload="window.__pwned=8"><circle r="5"/></svg>',
    '<svg><script>window.__pwned=9</script></svg>',
    '<math><mi xlink:href="javascript:window.__pwned=10">x</mi></math>',
    '<form action="https://evil.test"><input name=a><button>go</button></form>',
    '<object data="https://evil.test/x.swf"></object><embed src="https://evil.test/x.swf">',
    '<details open ontoggle="window.__pwned=11"><summary>s</summary></details>',
    '<p onmouseover="window.__pwned=12" class="pv-x" id="lightbox">hover</p>',
    '![d](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj48L3N2Zz4=)',
    '![h](http://insecure.test/a.png) ![r](//cdn.test/a.png) ![f](file:///etc/passwd)',
  ].join('\n\n');
  const before = await page.evaluate(() => getComputedStyle(document.body).display);
  await mount(evil);
  const eh = await html();
  const dom = await page.evaluate(() => ({
    bad: [...document.querySelectorAll('.dv script, .dv style, .dv iframe, .dv object, .dv embed, .dv form, .dv svg, .dv math, .dv input, .dv button, .dv link, .dv meta')].map((n) => n.tagName),
    on: [...document.querySelectorAll('.dv-md *')].flatMap((n) => [...n.attributes].filter((a) => /^on|^style$|^class$|^id$/i.test(a.name)).map((a) => `${n.tagName}.${a.name}`)),
    hrefs: [...document.querySelectorAll('.dv a')].map((a) => a.getAttribute('href')),
    imgs: [...document.querySelectorAll('.dv img')].map((i) => i.getAttribute('src')),
    pwned: window.__pwned,
    bodyDisplay: getComputedStyle(document.body).display,
    pvPos: getComputedStyle(document.getElementById('pv')).position,
  }));
  eq(dom.bad, [], 'no script/style/iframe/object/embed/form/svg/math/input/button/link/meta survives');
  eq(dom.on, [], 'no event-handler, style, class or id attribute survives');
  eq(dom.hrefs.filter(Boolean), [], 'no href survives from the hostile links (javascript:, data:, vbscript:)');
  eq(dom.imgs, ['https://example.com/a.png'], 'only the https image survives (svg data, http, protocol-relative, file are dropped) and its onload is gone');
  eq(dom.pwned, undefined, 'nothing ran: window.__pwned is still undefined');
  eq([dom.bodyDisplay, dom.pvPos], [before, 'fixed'], 'the page was not restyled');
  ok(!/onerror|onload|javascript:|<script|<iframe|srcdoc/i.test(eh), 'the rendered html has none of the hostile tokens');
  ok(/\[image: h\]/.test(await page.evaluate(() => document.querySelector('.dv').textContent)), 'a dropped image leaves its alt text');

  /* images: https, the raw route (relative to the document), a small data:image */
  await mount('![a](https://example.com/a.png) ![b](pic.png) ![c](../../etc.png) ![d](data:image/png;base64,iVBORw0KGgo=) ![e](/api/rooms/r1/assets/raw/other.png)', { base: `${BASE}/api/rooms/r1/assets/raw/doc.md` });
  eq(await page.evaluate(() => [...document.querySelectorAll('.dv img')].map((i) => i.getAttribute('src'))), ['https://example.com/a.png', `${BASE}/api/rooms/r1/assets/raw/pic.png`, 'data:image/png;base64,iVBORw0KGgo=', `${BASE}/api/rooms/r1/assets/raw/other.png`], 'images: https, relative to the raw route, data:image/png; a path that leaves the raw route is dropped');

  /* ---- toolbar, copy, menu ---- */
  await mount('# Doc\n\nbody **raw** text', { ref: 'https://share.test/ref/doc.md' });
  eq(await page.evaluate(() => [...document.querySelectorAll('#tools .dv-tb')].map((b) => [b.title, b.getAttribute('aria-label')])), [['Full screen', 'Full screen'], ['Copy link', 'Copy link'], ['Copy contents', 'Copy contents'], ['More options', 'More options']], 'toolbar order, tooltips and aria-labels');
  await page.click('#tools [aria-label="Copy contents"]');
  eq((await page.evaluate(() => navigator.clipboard.readText())).replaceAll(CRLF, LF), '# Doc\n\nbody **raw** text', 'Copy contents copies the raw text, not the html');
  await page.click('#tools [aria-label="Copy link"]');
  eq((await page.evaluate(() => navigator.clipboard.readText())).replaceAll(CRLF, LF), 'https://share.test/ref/doc.md', 'Link copies the reference');

  /* the ... menu: a stub host captures the spec */
  await page.evaluate(() => { window.__menu = { open: (s) => { window.__spec = s; }, close: () => {} }; });
  await mount('# Doc\n\nbody', {});
  await page.click('#tools [aria-label="More options"]');
  eq(await page.evaluate(() => window.__spec.items.map((i) => i.label)), ['Print', 'Download', 'View source'], 'the ... menu: Print, Download, View source (markdown)');
  await page.evaluate(() => window.__spec.choose(window.__spec.items[2]));
  ok(await page.evaluate(() => !!document.querySelector('.dv .dv-pre') && !document.querySelector('.dv .dv-md')), 'View source shows the raw text');
  await page.click('#tools [aria-label="More options"]');
  eq(await page.evaluate(() => window.__spec.items[2].label), 'View rendered', 'and the item flips to View rendered');
  await page.evaluate(() => window.__spec.choose(window.__spec.items[2]));
  ok(await page.evaluate(() => !!document.querySelector('.dv .dv-md h1')), 'View rendered returns to the document');
  await mount('plain text', { kind: 'text', name: 'a.txt' });
  await page.click('#tools [aria-label="More options"]');
  eq(await page.evaluate(() => window.__spec.items.map((i) => i.label)), ['Print', 'Download'], 'a plain text file has no source toggle');
  eq(await page.evaluate(() => getComputedStyle(document.querySelector('.dv-pre')).whiteSpace), 'pre-wrap', 'plain text wraps');
  await mount('{"a":1}', { kind: 'code', name: 'a.json' });
  eq(await page.evaluate(() => getComputedStyle(document.querySelector('.dv-pre')).whiteSpace), 'pre', 'json does not wrap');

  /* too large / error */
  await mount('', { result: { tooLarge: true } });
  eq(await page.evaluate(() => [document.querySelector('.dv-problem p').textContent, document.querySelector('.dv-problem a').textContent]), ['Too large to preview', 'Download'], 'too large says so and offers Download');
  await mount('', { result: { error: 'HTTP 403' } });
  ok(await page.evaluate(() => /HTTP 403/.test(document.querySelector('.dv-problem p').textContent)), 'an error is named, Download offered');

  /* full screen and print root */
  await mount('# Big\n\ntext');
  await page.click('#tools [aria-label="Full screen"]');
  ok(await page.evaluate(() => !!document.querySelector('.dv-scrim .dv-lg .dv-md h1')), 'Full screen opens the rendered document in a modal');
  await page.keyboard.press('Escape');
  ok(await page.evaluate(() => !document.querySelector('.dv-scrim')), 'Esc closes it');
  await page.click('#tools [aria-label="Full screen"]');
  await page.click('.dv-lg-x');
  ok(await page.evaluate(() => !document.querySelector('.dv-scrim')), 'the X closes it');

  eq(errors, [], 'no page errors');
} catch (e) {
  failed++;
  console.log(`  X threw: ${e?.stack ?? e}`);
} finally {
  await browser.close();
  srv.close();
}
console.log(`\nPASS ${passed}  FAIL ${failed}`);
process.exit(failed ? 1 : 0);
