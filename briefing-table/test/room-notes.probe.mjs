/* ROOM NOTES: the editor, the + menu and the phone layers in a REAL browser
 * [ticket].
 *
 *   node test/room-notes.probe.mjs [outdir]     (screenshots go to outdir)
 *
 * No engine: a static harness page (a trimmed copy of the room's markup, the
 * real room.css / room-attach.css / room-notes.css, the real
 * web/room-notes.mjs) with an in-memory stand-in for the notes routes.
 * What only a browser can prove:
 *   PC     - the editor is a modal (min(720px,92vw) x min(640px,72vh)), the
 *            textarea is focused with the caret at the end, one PUT follows a
 *            burst of typing, "Saved" fades in, Esc closes, a drag that ends on
 *            the scrim does not;
 *   PHONE  - from the chat the composer area is replaced (header, strip, the +
 *            and Send hidden, the chat line still scrollable), from Assets the
 *            editor is the whole screen; the textarea is 16px and NEVER
 *            focused on touch; the controls are 44px; no sideways scroll.
 * Phone = Chromium at 390px, isMobile + hasTouch (WebKit is not installed here).
 */
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const OUT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'tmp-notes-shots');
mkdirSync(OUT, { recursive: true });
let passed = 0;
let failed = 0;
const ok = (c, m) => {
  c ? passed++ : failed++;
  console.log(`  ${c ? '+' : 'X'} ${m}`);
};

const lines = Array.from({ length: 30 }, (_, i) => `<li class="entry by-room"><div class="bubble">Chat line ${i + 1}: something somebody said in the room</div></li>`).join('');
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/vendor/aurora-tokens.css"><link rel="stylesheet" href="/room.css"><link rel="stylesheet" href="/room-attach.css"><link rel="stylesheet" href="/room-notes.css">
<style>.bubble{padding:6px 10px;margin:4px 16px;background:var(--surface2);border-radius:8px}</style></head>
<body>
<header class="rm-top"><span class="rm-name">Workroom</span></header>
<main class="rm-main" id="main">
<aside class="rm-roster"></aside>
<div class="ph-home" id="phHome"><div class="ph-hdr">Room header</div><div class="ph-strip" id="phStrip">strip</div></div>
<section class="rm-line" id="roomLine">
<div class="rm-scroll" id="lineScroll" style="overflow:auto"><ol class="rm-entries" id="line" style="list-style:none;margin:0;padding:0">${lines}</ol></div>
<p class="rm-delivery rm-delivery-danger" id="delivery">over by 340 - won't send</p>
<form class="rm-compose" id="compose"><div class="rm-tray" id="attTray"></div><button type="button" class="rm-attach" id="attBtn">+</button>
<div class="rm-inputwrap"><textarea id="input" rows="1" placeholder="Message the lead"></textarea></div><button type="submit" class="rm-send">&rarr;</button></form>
</section></main>
<script type="module">
import { mountNotes } from '/room-notes.mjs';
import { createMenuHost } from '/room-seat-menu.mjs';
const db = new Map(); let n = 0; window.puts = [];
const realFetch = window.fetch;
window.fetch = async (url, init = {}) => {
  const m = String(url).match(/notes(?:\\/([^/?]+))?(?:\\/([a-z-]+))?$/);
  if (!m) return realFetch(url, init);
  const [, id, sub] = m; const method = init.method || 'GET';
  const J = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b });
  if (!id && method === 'GET') return J({ notes: [] });
  if (!id && method === 'POST') { const nid = String(++n).padStart(12, 'a'); db.set(nid, { id: nid, text: '', updatedAt: Date.now() }); return J({ note: db.get(nid) }); }
  const note = db.get(id);
  if (!note) return J({ error: 'nope' }, 404);
  if (!sub && method === 'GET') return J(note);
  if (method === 'PUT') { note.text = JSON.parse(init.body).text; window.puts.push(note.text); return J({ id, updatedAt: Date.now() }); }
  if (sub === 'close') return J({ note });
  if (sub === 'attach') return J({ note, attachment: { file: { id: 'f'.repeat(32), name: 'note-' + id + '.txt', size: note.text.length }, title: note.text.slice(0, 30), words: note.text.split(/\\s+/).length } });
  return J({});
};
window.attached = new Set(); window.tiles = [];
window.notes = mountNotes({
  roomId: 'r1', menuHost: createMenuHost(),
  att: () => ({ hasNote: (id) => window.attached.has(id), putNote: (a, nn) => { window.attached.add(nn.id); window.tiles.push(a.title); }, noteMeta() {}, panelAdded() {}, restore() {} }),
  cells: () => ({ notesChanged() { window.changed = (window.changed || 0) + 1; } }),
  chatHost: () => document.getElementById('roomLine'),
  draft: { text: () => document.getElementById('input').value, prepare: async () => true, clear() {}, keep() {} },
  repaintLine() {}, pickFile() {},
});
document.getElementById('attBtn').addEventListener('click', (e) => window.notes.addMenu(e.currentTarget));
window.ready = true;
</script></body></html>`;

const MIME = { '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript' };
const srv = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/') {
    res.setHeader('content-type', 'text/html');
    res.end(PAGE);
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

async function open(ctxOpts) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => {
    failed++;
    console.log(`  X page error: ${e.message}`);
  });
  await page.goto(base);
  await page.waitForFunction(() => window.ready === true);
  await page.waitForTimeout(150);
  return page;
}

console.log('PC 1280');
{
  const page = await open({ viewport: { width: 1280, height: 800 } });
  await page.click('#attBtn');
  await page.waitForSelector('.rsm-menu');
  await page.screenshot({ path: join(OUT, 'pc-menu.png') });
  const items = await page.$$eval('.rsm-menu .rsm-mi', (b) => b.map((x) => x.textContent + (x.getAttribute('aria-disabled') ? '(off)' : '')));
  ok(JSON.stringify(items) === JSON.stringify(['Attach a file', 'New note', 'Move draft to a note(off)']), `the + menu: ${items.join(' / ')}`);
  await page.click('.rsm-mi[data-a="note"]');
  await page.waitForSelector('.nt-card');
  const box = await page.$eval('.nt-card', (c) => {
    const r = c.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  ok(box.w === 720 && box.h === 576, `the modal is 720 x 576 (min(640px,72vh) at 800 high): ${box.w} x ${box.h}`);
  ok(await page.$eval('.nt-ta', (t) => document.activeElement === t), 'the textarea is focused on a PC');
  await page.keyboard.type('Remember to ask about the chewing gum, then the other thing.');
  await page.waitForTimeout(900);
  ok((await page.evaluate(() => window.puts.length)) === 1, 'a burst of typing is ONE autosave PUT');
  ok(await page.$eval('.nt-state', (s) => s.classList.contains('on') && s.textContent === 'Saved'), '"Saved" shows after the autosave');
  await page.screenshot({ path: join(OUT, 'pc-editor.png') });
  await page.click('.nt-x');
  await page.waitForSelector('.nt-card', { state: 'detached' });
  ok((await page.evaluate(() => window.tiles.length)) === 1, 'closing a composer note attached it (no paperclip)');
  await page.evaluate(() => window.notes.openNote(Array.from({ length: 12 }, () => 'a').join('').replace(/a$/, '1')));
  await page.waitForSelector('.nt-card');
  // a drag that starts inside and ends on the scrim must NOT close
  const sc = await page.$eval('.nt-scrim', (s) => ({ w: s.clientWidth }));
  await page.mouse.move(640, 300);
  await page.mouse.down();
  await page.mouse.move(sc.w - 5, 5);
  await page.mouse.up();
  ok((await page.$('.nt-card')) !== null, 'a drag that ends on the scrim does not close it');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.nt-card', { state: 'detached' });
  ok(true, 'Esc closes');
  await page.close();
}

console.log('PHONE 390');
{
  const phone = { viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
  const page = await open(phone);
  await page.screenshot({ path: join(OUT, 'phone-chat-before.png') });
  await page.evaluate(() => window.notes.newNote('chat'));
  await page.waitForSelector('.nt-card.nt-chat');
  await page.waitForTimeout(200);
  const m = await page.evaluate(() => {
    const vis = (s) => {
      const e = document.querySelector(s);
      return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0;
    };
    const ta = document.querySelector('.nt-ta');
    const card = document.querySelector('.nt-card').getBoundingClientRect();
    const btn = document.querySelector('.nt-x').getBoundingClientRect();
    const sc = document.getElementById('lineScroll');
    return {
      header: vis('.ph-home'), compose: vis('.rm-compose'), delivery: vis('.rm-delivery'),
      font: getComputedStyle(ta).fontSize, focused: document.activeElement === ta,
      cardH: Math.round(card.height), vvH: Math.round(window.visualViewport.height), btn: Math.round(btn.width),
      scrollable: sc.scrollHeight > sc.clientHeight, scrollW: document.documentElement.scrollWidth, innerW: innerWidth,
      bottom: Math.round(card.bottom), chatBottom: Math.round(sc.getBoundingClientRect().bottom), cardTop: Math.round(card.top),
    };
  });
  ok(!m.header && !m.compose && !m.delivery, 'from the chat: the header, strip, + and Send, and the status line are hidden');
  ok(m.font === '16px' && !m.focused, `the textarea is 16px and NOT focused on touch (${m.font}, focused ${m.focused})`);
  ok(Math.abs(m.cardH - Math.round(m.vvH * 0.6)) <= 2, `it is about 60% of the visual viewport (${m.cardH} of ${m.vvH})`);
  ok(m.btn === 44, `the controls are 44px (${m.btn})`);
  ok(m.scrollable && m.chatBottom <= m.cardTop + 1, 'the chat stays visible above it and scrollable');
  ok(m.scrollW <= m.innerW, 'no sideways scroll');
  await page.screenshot({ path: join(OUT, 'phone-chat-editor.png') });
  await page.tap('.nt-ta');
  await page.keyboard.type('phone typed text for the note body');
  await page.waitForTimeout(700);
  ok((await page.evaluate(() => window.puts.at(-1))) === 'phone typed text for the note body', 'typing autosaves');
  await page.screenshot({ path: join(OUT, 'phone-chat-typed.png') });
  await page.tap('.nt-x');
  await page.waitForSelector('.nt-card', { state: 'detached' });
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('.rm-compose')).display !== 'none'), 'closing returns the composer');
  // attached already: the paperclip is hidden on a phone
  await page.evaluate(() => window.attached.add('aaaaaaaaaaa1'));
  await page.evaluate(() => window.notes.openNote('aaaaaaaaaaa1'));
  await page.waitForSelector('.nt-card.nt-chat');
  ok(await page.$eval('.nt-clip', (b) => b.hidden || getComputedStyle(b).display === 'none'), 'the paperclip is hidden when the note is already attached');
  const xBefore = await page.$eval('.nt-x', (b) => Math.round(b.getBoundingClientRect().right));
  ok(xBefore >= 390 - 16, 'X stays at the right edge');
  await page.tap('.nt-x');
  await page.waitForSelector('.nt-card', { state: 'detached' });
  // from Assets: the whole screen
  await page.evaluate(() => window.notes.newNote('assets'));
  await page.waitForSelector('.nt-card.nt-full');
  const f = await page.$eval('.nt-card', (c) => {
    const r = c.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bg: getComputedStyle(c).backgroundColor, ink: getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() };
  });
  ok(f.w === 390 && f.top === 0 && f.h >= 770, `from Assets it is 100% of the screen (${f.w} x ${f.h})`);
  ok(await page.$eval('.nt-ta', (t) => document.activeElement !== t), 'not focused on touch from Assets either');
  await page.screenshot({ path: join(OUT, 'phone-assets-editor.png') });
  ok(await page.$eval('.nt-fs', (b) => b.hidden || getComputedStyle(b).display === 'none'), 'from Assets (already full) there is no full-page toggle');
  await page.tap('.nt-x');
  await page.waitForSelector('.nt-card', { state: 'detached' });

  /* FULL PAGE <-> BACK, from the chat (Owner 2026-10-02, room line [ref]) */
  const box = () => page.evaluate(() => {
    const r = (s) => { const b = document.querySelector(s)?.getBoundingClientRect(); return b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right), b: Math.round(b.bottom) } : null; };
    const card = document.querySelector('.nt-card');
    const h = document.documentElement.classList;
    return { card: r('.nt-card'), head: r('.nt-h'), x: r('.nt-x'), clip: r('.nt-clip'), fs: r('.nt-fs'), ta: r('.nt-ta'), parent: card.parentElement.id || card.parentElement.tagName, cls: card.className, open: h.contains('nt-open'), chatOpen: h.contains('nt-chat-open'), label: document.querySelector('.nt-fs').getAttribute('aria-label'), focused: document.activeElement === document.querySelector('.nt-ta') };
  });
  await page.evaluate(() => window.notes.newNote('chat'));
  await page.waitForSelector('.nt-card.nt-chat');
  await page.evaluate(() => { const t = document.querySelector('.nt-ta'); t.value = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n'); t.dispatchEvent(new Event('input')); t.setSelectionRange(40, 47); t.scrollTop = 120; });
  await page.waitForTimeout(700);
  const putsBefore = await page.evaluate(() => window.puts.length);
  const c1 = await box();
  ok(c1.fs && c1.fs.w === 44 && c1.fs.h === 44 && c1.fs.r < c1.clip.x + 1 || (c1.fs && c1.fs.r <= c1.x.x), 'chat: a 44px full-page toggle sits LEFT of the X group', c1);
  ok(c1.label === 'Full page' && c1.chatOpen && !c1.open, 'chat: labeled "Full page", chat html class set', c1);
  await page.screenshot({ path: join(OUT, 'room-notes-chat-layer.png') });
  await page.tap('.nt-fs');
  await page.waitForTimeout(250);
  const c2 = await box();
  const sel = await page.evaluate(() => { const t = document.querySelector('.nt-ta'); return { a: t.selectionStart, b: t.selectionEnd, top: t.scrollTop, len: t.value.length }; });
  ok(c2.parent === 'BODY' && /nt-full/.test(c2.cls) && !/nt-chat/.test(c2.cls) && c2.open && !c2.chatOpen, 'full: re-parented to body, nt-full, html.nt-open only', c2);
  ok(c2.label === 'Back to message box', 'full: toggle is "Back to message box"', c2.label);
  ok(c2.card.w === 390 && c2.card.y === 0 && c2.card.h >= 770, 'full: the card is the whole screen', c2.card);
  ok(c2.x.w === c1.x.w && c2.x.h === c1.x.h && c2.x.r === c1.x.r && c2.x.y - c2.head.y === c1.x.y - c1.head.y && c2.head.r === c1.head.r, `X keeps its exact spot in the header (right ${c2.x.r}, ${c2.x.y - c2.head.y} below the header top, same in both)`, { c1: c1.x, c2: c2.x });
  ok(c2.fs.x === c1.fs.x && c2.fs.w === c1.fs.w, 'the toggle keeps its spot too', { c1: c1.fs, c2: c2.fs });
  ok(c2.ta.h > c1.ta.h && Math.abs(c2.ta.b - c2.card.b) <= 2, `full: the textarea takes the full height (${c1.ta.h} -> ${c2.ta.h}, bottom ${c2.ta.b} of ${c2.card.b})`, { c1: c1.ta, c2: c2.ta });
  ok(sel.a === 40 && sel.b === 47 && sel.top === 120 && sel.len > 100, 'caret/selection and scroll position survive the re-parent', sel);
  ok(!c2.focused, 'never focused by the toggle');
  await page.screenshot({ path: join(OUT, 'room-notes-full-page.png') });
  await page.tap('.nt-fs');
  await page.waitForTimeout(250);
  const c3 = await box();
  ok(c3.parent !== 'BODY' && /nt-chat/.test(c3.cls) && !/nt-full/.test(c3.cls) && c3.chatOpen && !c3.open && c3.label === 'Full page', 'back: the chat layer again, classes swapped', c3);
  ok(c3.card.h === c1.card.h && c3.x.y === c1.x.y && c3.x.r === c1.x.r, 'back: card height and X exactly as before', { c1: c1.card, c3: c3.card });
  ok((await page.evaluate(() => window.puts.length)) === putsBefore, 'the toggle caused no extra save');
  await page.tap('.nt-fs');
  await page.waitForTimeout(150);
  await page.tap('.nt-x'); // close while FULL
  await page.waitForSelector('.nt-card', { state: 'detached' });
  ok(await page.evaluate(() => !document.documentElement.classList.contains('nt-open') && !document.documentElement.classList.contains('nt-chat-open')), 'closing from full clears both html classes');
  await page.close();
}

await browser.close();
srv.close();
console.log(`\nPASS ${passed} FAIL ${failed}  (screenshots: ${OUT})`);
process.exit(failed ? 1 : 0);
