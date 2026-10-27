/* THE SCRATCHPAD [scratchpad]  node test/room-scratchpad.probe.mjs   Owner 2026-10-07, the design system BUILD-HANDOFF 1.C (V2.1)
 * The real room page against a scratch engine (dead broker, temp table, never a live pane); the panels and their frames are stubbed in the
 * browser in the engine's shape (as room-cells.probe does).
 *   SLICE 1 - the left bar: Room, Seats, the panels (Tasks), then ONE Scratchpad cell where Assets was: the engine's Assets panel cell is
 *   not drawn (but stays loaded), no To-Dos cell; two 40px signal lines "Assets N new of M" / "Notes N new of M" (the count in mono, teal
 *   with a 7px dot only when N > 0), the header's count is the two "new" numbers added; a line opens that list in the preview column,
 *   the open line is tinted, the same line again closes it; the cell folds and remembers it. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(418);
const DEAD = P(419);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-scratchpad-token';
let failures = 0;
const ok = (c, m, d) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${d !== undefined ? `  (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); if (!c) { failures += 1; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.SHOTS_DIR || ''; // SHOTS_DIR=<dir> saves the screenshots the design system reviews against the hub
const runTsx = (args, env) => new Promise((resolve) => {
  const pr = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
  let out = ''; let err = '';
  pr.stdout.on('data', (d) => (out += d)); pr.stderr.on('data', (d) => (err += d));
  pr.on('exit', (code) => resolve({ code, out, err }));
});
/* a visualViewport whose height the probe can shrink (the soft keyboard) */
const INIT = () => {
  const real = window.visualViewport;
  const fake = new EventTarget();
  let kb = 0;
  Object.defineProperties(fake, {
    width: { get: () => (real ? real.width : window.innerWidth) },
    height: { get: () => (real ? real.height : window.innerHeight) - kb },
    scale: { get: () => (real ? real.scale : 1) },
    offsetTop: { get: () => (real ? real.offsetTop : 0) },
    offsetLeft: { get: () => (real ? real.offsetLeft : 0) },
    pageTop: { get: () => (real ? real.pageTop : 0) },
    pageLeft: { get: () => (real ? real.pageLeft : 0) },
  });
  real?.addEventListener('resize', () => fake.dispatchEvent(new Event('resize')));
  Object.defineProperty(window, 'visualViewport', { get: () => fake, configurable: true });
  window.__kb = (px) => { kb = px; fake.dispatchEvent(new Event('resize')); };
};
await assertFree(PORT, 'room-scratchpad.probe.mjs');
await assertFree(DEAD, 'room-scratchpad.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-scratchpad-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null; let browser = null; let log = '';
try {
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
    return JSON.parse(r.out.trim().split('\n').pop());
  };
  await seed({ recipes: [{ id: 'rec-a', name: 'Awake', projectDir: '/srv/x/awake', vendor: 'claude-code', agent: 'awake', color: '#0dab49' }] });
  const loader = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loader, join('src', 'server', 'index.ts')], { cwd: REPO_ROOT, env: childEnv({
    HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: dbPath, HARBOR_WB_TOKEN: TOKEN,
    HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'), HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_NO_WINDOW: '1',
    HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(DEAD),
    HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'cp'), HARBOR_WB_NODE: 'testnode' }) });
  engine.stdout.on('data', (d) => (log += d)); engine.stderr.on('data', (d) => (log += d));
  let up = false;
  for (let i = 0; i < 120 && !up; i += 1) { await sleep(250); try { up = (await fetch(`${BASE}/health`)).ok; } catch { /* not yet */ } }
  ok(up, 'scratch engine up', up ? undefined : log.slice(-300));
  if (!up) { throw new Error('no engine'); }
  const R = (await seed({ rooms: [{ name: 'Pad Room', seats: [{ handle: 'awake', recipe_id: 'rec-a' }] }] })).rooms[0].id;
  browser = await chromium.launch({ headless: true });
  const F = (id) => `/api/rooms/${R}/panels/${id}/frame/t/tok-${id}/`;
  const PANELS = [
    { id: 'p-tasks', room_id: R, kind: 'view', title: 'Tasks', icon: 'tasks', order: 1, seat_handle: 'awake', scripts: true, url: 'http://127.0.0.1:9/never', frameUrl: F('p-tasks') },
    { id: 'p-assets', room_id: R, kind: 'view', title: 'Assets', icon: 'assets', order: 2, seat_handle: null, scripts: true, uploads: true, url: 'http://127.0.0.1:9/never', frameUrl: F('p-assets') },
  ];
  const ASSETS = Array.from({ length: 30 }, (_, i) => ({ name: `shot-${i + 1}.png`, path: `/x/shot-${i + 1}.png`, url: '', raw: `/api/rooms/${R}/assets/raw/shot-${i + 1}.png`, kind: 'image', size: 1000 * (i + 1), type: 'image/png', addedAt: Date.now() - (30 - i) * 60000, addedBy: 'awake', ...(i === 29 ? { entry_id: 4242 } : {}) }));
  ASSETS.push({ name: 'brief.pdf', path: '/x/brief.pdf', url: '', raw: `/api/rooms/${R}/assets/raw/brief.pdf`, kind: 'file', size: 2048, type: 'application/pdf', addedAt: Date.now() - 31 * 60000, addedBy: null });
  const NOTE_TEXT = { n1: 'Line one\nLine two\nLine three\nLine four\nLine five', n2: 'Second note, short', n3: 'Third note' };
  const NOTES = Array.from({ length: 3 }, (_, i) => ({ id: `n${i + 1}`, createdAt: Date.now() - (3 - i) * 3600000, updatedAt: Date.now() - (3 - i) * 3600000, pinned: false, archived: false, keywords: i === 0 ? ['rail', 'decision'] : [] }));
  /* the engine's seen-state (eng/scratch-seen), stubbed in the browser: OFF = an engine without it (404, no `seen` fields) */
  let engineOn = false;
  let assetsReadable = true;
  let batch2 = false; // the second engine batch: lineId on assets (thumbs, came-from, the ⋯ verbs), notes summary
  let edition = 'full';
  const itemCalls = [];
  const unseenA = new Set(['/x/shot-30.png', '/x/shot-29.png', '/x/shot-28.png']);
  const unseenN = new Set(['n3']);
  const seenPosts = [];
  const engineCounts = () => ({ assets: assetsReadable ? { new: unseenA.size, total: ASSETS.length } : null, notes: { new: unseenN.size, total: NOTES.length } });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route(new RegExp(`/api/rooms/${R}/scratchpad/counts$`), async (route) => { await (engineOn ? route.fulfill({ json: engineCounts() }) : route.fulfill({ status: 404, json: { error: 'not found' } })); });
  await ctx.route(new RegExp(`/api/rooms/${R}/scratchpad/seen$`), async (route) => {
    const b = route.request().postDataJSON();
    seenPosts.push(b);
    for (const id of b.ids) { (b.kind === 'asset' ? unseenA : unseenN).delete(id); }
    await route.fulfill({ json: { ok: true, marked: b.ids.length, counts: engineCounts() } });
  });
  await ctx.route(new RegExp(`/api/rooms/${R}(\\?.*)?$`), async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.panels = PANELS;
    await route.fulfill({ response: res, json: body });
  });
  await ctx.route(new RegExp(`/api/rooms/${R}/assets$`), async (route) => { await route.fulfill({ json: { folder: '', shareUrl: '', assets: (engineOn ? ASSETS.map((a) => ({ ...a, seen: !unseenA.has(a.path) })) : ASSETS).map((a) => (batch2 ? { ...a, lineId: a.entry_id ?? null } : a)) } }); });
  await ctx.route(new RegExp(`/api/rooms/${R}/notes(\\?.*)?$`), async (route) => { await route.fulfill({ json: { notes: engineOn ? NOTES.map((n) => ({ ...n, seen: !unseenN.has(n.id) })) : NOTES } }); });
  await ctx.route(new RegExp(`/api/rooms/${R}/notes/n[0-9]+$`), async (route) => { const id = route.request().url().split('/').pop(); await route.fulfill({ json: { id, text: NOTE_TEXT[id] } }); });
  await ctx.route(/\/health$/, async (route) => { const res = await route.fetch(); const b = await res.json(); await route.fulfill({ response: res, json: { ...b, edition } }); });
  await ctx.route(new RegExp(`/api/rooms/${R}/assets/thumb/`), async (route) => {
    const name = decodeURIComponent(route.request().url().split('/thumb/')[1].split('?')[0]);
    if (name === 'shot-1.png') { await route.fulfill({ status: 404, json: { icon: 'file' } }); return; }
    await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#7c5cff"/></svg>' });
  });
  await ctx.route(new RegExp(`/api/rooms/${R}/assets/item/`), async (route) => {
    const q = route.request();
    itemCalls.push({ method: q.method(), name: decodeURIComponent(q.url().split('/item/')[1]), body: q.postData() });
    await route.fulfill({ json: { ok: true, op: q.method().toLowerCase() } });
  });
  await ctx.route(/\/assets\/raw\//, async (route) => { await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#2dd4bf"/></svg>' }); });
  await ctx.route(/\/panels\/p-[a-z]+\/frame\/t\/[^/]+\//, async (route) => {
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><body style="margin:0">panel<script>parent.postMessage({panel:"height", px:200}, "*")</script></body>' });
  });
  const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
  await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);
  await pg.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
  await sleep(3500);

  /* ---- slice 1: the cell ---- */
  const rail = await pg.evaluate(() => {
    const vis = (el) => el.offsetParent !== null && getComputedStyle(el).display !== 'none';
    const order = [...document.querySelectorAll('.rm-roster > section.cell, #panelCells > .cell')].filter(vis).map((c) => c.dataset.cell);
    const assetsCell = document.querySelector('#panelCells > .cell[data-cell="p-assets"]');
    return { order, assetsInDom: !!assetsCell, assetsShown: assetsCell ? vis(assetsCell) : null, assetsFrame: !!assetsCell?.querySelector('iframe'), hasTodos: !!document.querySelector('[data-cell="todos"], [data-cell="to-dos"]') };
  });
  ok(rail.order.join(',') === 'room,seats,p-tasks,scratchpad', 'the rail is Room, Seats, Tasks, then ONE Scratchpad cell; no Assets cell, no To-Dos cell', rail);
  ok(rail.assetsInDom && rail.assetsShown === false && rail.assetsFrame, '...the engine\'s Assets panel stays loaded (uploads and notes ride on it), its cell just is not drawn', rail);
  const pad = await pg.evaluate(() => {
    const c = document.getElementById('padCell');
    const rows = ['padAssets', 'padNotes'].map((id) => { const r = document.getElementById(id); const b = r.getBoundingClientRect(); const pn = r.querySelector('.pn'); return { text: pn.textContent, h: Math.round(b.height), mono: getComputedStyle(pn).fontFamily.toLowerCase().includes('mono'), color: getComputedStyle(pn).color, key: r.querySelector('.pk').textContent, chevron: r.querySelector('.pc').textContent }; });
    return { title: c.querySelector('.tt').textContent, count: document.getElementById('padCount').textContent, rows, thumbs: c.querySelectorAll('img, iframe').length, tone: c.dataset.tone };
  });
  ok(pad.title === 'Scratchpad' && pad.count === '' && pad.thumbs === 0, 'the cell: "Scratchpad", no count while nothing is new, no thumbnails and no frame', pad);
  ok(pad.rows[0].key === 'Assets' && pad.rows[0].text === '0 new of 31' && pad.rows[1].key === 'Notes' && pad.rows[1].text === '0 new of 3', 'two lines: "Assets 0 new of 31" and "Notes 0 new of 3" (the totals the engine has today)', pad.rows);
  ok(pad.rows.every((r) => r.h === 40 && r.mono && r.chevron === '›'), '...40px rows, the count in mono, a ›', pad.rows);

  /* ---- counts: N > 0 gives the teal "N new" with a dot, the header sums them (the engine's seen-state plugs in here) ---- */
  const live = await pg.evaluate(async () => {
    const m = await import('/room-scratchpad.mjs');
    const host = document.createElement('div');
    host.innerHTML = document.getElementById('padCell').outerHTML.replace(/id="pad/g, 'id="xpad');
    document.body.append(host);
    const cell = host.firstElementChild;
    cell.querySelectorAll('[id]').forEach((n) => { n.id = n.id.replace('xpad', 'pad'); });
    for (const n of cell.querySelectorAll('.pn, #padCount')) { n.textContent = ''; }
    let inst = null;
    const fake = { cur: null, current() { return this.cur; }, close() { this.cur = null; inst.previewChanged(); } }; // like the real column: a close tells the cell
    const opened = [];
    inst = m.mountScratchpad({ roomId: 'unit', cell, list: document.createElement('div'), preview: fake, api: async () => ({ ok: false }), openList: (k) => { opened.push(k); fake.cur = { owner: 'scratchpad', key: k }; inst.previewChanged(); }, visible: () => false });
    inst.setCounts({ assets: { n: 3, m: 43 }, notes: { n: 1, m: 6 } });
    const q = (s) => cell.querySelector(s);
    const dot = (el) => getComputedStyle(el.querySelector('.pn'), '::before').content !== 'none' && getComputedStyle(el.querySelector('.pn'), '::before').content !== 'normal';
    const out = { a: q('#padAssets .pn').textContent, n: q('#padNotes .pn').textContent, head: q('#padCount').textContent, aDot: dot(q('#padAssets')), nDot: dot(q('#padNotes')), aCol: getComputedStyle(q('#padAssets .pn')).color };
    q('#padAssets').click();
    out.open1 = [q('#padAssets').classList.contains('open'), q('#padNotes').classList.contains('open')];
    q('#padNotes').click();
    out.open2 = [q('#padAssets').classList.contains('open'), q('#padNotes').classList.contains('open')];
    q('#padNotes').click();
    out.open3 = [q('#padAssets').classList.contains('open'), q('#padNotes').classList.contains('open')];
    out.opened = opened;
    inst.setCounts({ assets: { n: 0, m: 43 }, notes: { n: 0, m: 6 } });
    out.mutedCol = (inst.setCounts({ assets: { n: 0, m: 43 }, notes: { n: 0, m: 6 } }), getComputedStyle(q('#padAssets .pn')).color);
    out.zero = { a: q('#padAssets .pn').textContent, head: q('#padCount').textContent, aDot: dot(q('#padAssets')), aNew: q('#padAssets').dataset.new };
    inst.destroy();
    host.remove();
    return out;
  });
  ok(live.a === '3 new of 43' && live.n === '1 new of 6' && live.head === '4 new' && live.aDot && live.nDot, 'N > 0: "3 new of 43", "1 new of 6", a dot on each, and the header says "4 new" (the two added)', live);
  ok(live.aCol !== live.mutedCol, '...and the "N new" is teal, not the muted grey', { a: live.aCol, muted: live.mutedCol });
  ok(JSON.stringify(live.open1) === '[true,false]' && JSON.stringify(live.open2) === '[false,true]' && JSON.stringify(live.open3) === '[false,false]' && live.opened.join() === 'assets,notes', 'a line opens its list and is tinted; the other line takes over; the same line again closes it', live);
  ok(live.zero.a === '0 new of 43' && live.zero.head === '' && !live.zero.aDot && live.zero.aNew === '0', 'at zero: "0 new of 43", no dot, no header count', live.zero);

  /* ---- slice 2: the lists in the preview column ---- */
  await pg.click('#padAssets');
  await sleep(1500);
  const L = await pg.evaluate(() => {
    const pv = document.getElementById('preview');
    const tiles = [...pv.querySelectorAll('.sp-tile')];
    const rect = (e) => e.getBoundingClientRect();
    const firstRow = tiles.filter((t) => Math.abs(rect(t).top - rect(tiles[0]).top) < 2).length;
    const th = pv.querySelector('.sp-th');
    return {
      hidden: pv.hidden, type: pv.querySelector('.pv-type')?.textContent, name: pv.querySelector('.pv-name')?.textContent,
      seg: [...pv.querySelectorAll('.sp-segb')].map((b) => [b.textContent, b.getAttribute('aria-pressed')]), add: pv.querySelector('.sp-add')?.textContent,
      heads: [...pv.querySelectorAll('.sp-gh')].map((h) => h.textContent), tiles: tiles.length, firstRow, square: Math.abs(rect(th).width - rect(th).height) < 1,
      img: pv.querySelector('.sp-th img')?.getAttribute('src'), fit: getComputedStyle(pv.querySelector('.sp-th img')).objectFit, lazy: pv.querySelector('.sp-th img')?.loading,
      nm: pv.querySelector('.sp-nm')?.textContent, mt: pv.querySelector('.sp-mt')?.textContent, more: pv.querySelector('.sp-more')?.textContent,
      fileTile: [...pv.querySelectorAll('.sp-tile')].some((t) => t.querySelector('.sp-ext')?.textContent === 'PDF'), open: document.getElementById('padAssets').classList.contains('open'),
    };
  });
  ok(!L.hidden && L.type === 'Scratchpad' && L.name === 'Assets · 31', 'the Assets line opens the list in the preview column: "Scratchpad · Assets · 31"', L);
  ok(L.seg.map((x) => x.join(':')).join() === 'Assets:true,Notes:false' && L.add === '+ Add' && L.open, '...an Assets | Notes switch, "+ Add", the open line tinted', L);
  ok(L.heads[0] === 'Earlier · 31' && L.heads.length === 1 && L.tiles === 12 && L.more === 'Show 19 more', '...nothing is new, so "Earlier · 31": four rows (12 tiles in three columns), then "Show 19 more" (no empty "New" group)', L);
  ok(L.firstRow === 3 && L.square && /\/assets\/raw\/shot-31\.png$|\/assets\/raw\/shot-30\.png$/.test(L.img) && L.fit === 'cover' && L.lazy === 'lazy', '...a 3-column grid of square, lazy, cover-cropped thumbnails, newest first', L);
  ok(/^shot-30\.png$/.test(L.nm) && /^@awake · \d+m ago$/.test(L.mt), '...the name and "@who · when" under each', { nm: L.nm, mt: L.mt });
  await pg.click('#preview .sp-more');
  await sleep(200);
  const pg2 = await pg.evaluate(() => ({ tiles: document.querySelectorAll('#preview .sp-tile').length, more: document.querySelector('#preview .sp-more')?.textContent }));
  ok(pg2.tiles === 31 && !pg2.more, '"Show 19 more" reveals everything still hidden in ONE go', pg2);
  const pg3 = await pg.evaluate(() => ({ tiles: document.querySelectorAll('#preview .sp-tile').length, more: !!document.querySelector('#preview .sp-more'), file: [...document.querySelectorAll('#preview .sp-tile')].some((t) => t.querySelector('.sp-ext')?.textContent === 'PDF') }));
  ok(pg3.tiles === 31 && !pg3.more && pg3.file, '...to the end, and a file that is not an image is a tile with its extension', pg3);
  /* the same line again closes */
  await pg.click('#padAssets');
  await sleep(200);
  ok(await pg.evaluate(() => document.getElementById('preview').hidden && !document.getElementById('padAssets').classList.contains('open')), 'the same line again closes the column');
  /* Notes */
  await pg.click('#padNotes');
  await sleep(1500);
  const N = await pg.evaluate(() => {
    const pv = document.getElementById('preview');
    const cards = [...pv.querySelectorAll('.sp-note')];
    return {
      name: pv.querySelector('.pv-name')?.textContent, heads: [...pv.querySelectorAll('.sp-gh')].map((h) => h.textContent), add: pv.querySelector('.sp-add')?.textContent,
      seg: [...pv.querySelectorAll('.sp-segb')].map((b) => [b.textContent, b.getAttribute('aria-pressed')]),
      cards: cards.map((c) => ({ h: c.querySelector('.sp-nh').textContent, t: c.querySelector('.sp-nt').textContent, tags: [...c.querySelectorAll('.sp-tag')].map((x) => x.textContent), hasRow: !!c.querySelector('.sp-tags') })),
      clamp: getComputedStyle(cards[0].querySelector('.sp-nt')).webkitLineClamp,
    };
  });
  ok(N.name === 'Notes · 3' && N.add === '+ New note' && N.seg.map((x) => x.join(':')).join() === 'Assets:false,Notes:true', 'the Notes line opens its list ("Scratchpad · Notes · 3"), switch on Notes, "+ New note"', N);
  ok(N.cards.length === 3 && /^\d+h ago$/.test(N.cards[0].h) && N.cards[0].t === 'Third note', '...a note has NO title: a card is "when" then text (no @who until the engine says who)', N.cards);
  const withTags = N.cards.find((c) => c.tags.length);
  ok(N.cards.some((c) => c.t === 'Line one\nLine two\nLine three') && withTags?.tags.join() === 'rail,decision' && N.cards.filter((c) => !c.hasRow).length === 2 && N.clamp === '3', '...the first 3 lines of its text, its tags as chips, and NO chip row (no placeholder) for a note without tags', N.cards);
  /* ---- slice 3: one item ---- */
  await pg.click('#padAssets');
  await sleep(1200);
  await pg.click('#preview .sp-tile >> nth=0');
  await sleep(500);
  const I = await pg.evaluate(() => {
    const pv = document.getElementById('preview');
    return {
      trail: pv.querySelector('.pv-trail')?.textContent, name: pv.querySelector('.pv-name')?.textContent, iname: pv.querySelector('.sp-iname')?.textContent,
      meta: pv.querySelector('.sp-imeta')?.textContent, big: !!pv.querySelector('.sp-big img'), acts: [...pv.querySelectorAll('.sp-act')].map((b) => b.textContent),
      primary: pv.querySelector('.sp-act.pri')?.textContent, more: !!pv.querySelector('[aria-label*="More"], .sp-moremenu'), from: pv.querySelector('.sp-from')?.textContent ?? null,
      pager: pv.querySelector('.sp-pn')?.textContent, prevDis: pv.querySelector('.sp-pg')?.disabled,
    };
  });
  ok(I.trail.trim() === '‹ Assets · 31' && I.iname === 'shot-30.png', 'an asset opens in the same column; the trail reads "‹ Assets · 31" (the chevron is the only back cue on a PC)', I);
  ok(I.big && /^@awake · \d+m ago · image\/png · \d+(\.\d)? ?KB$|^@awake · \d+m ago · image\/png · \d+ B$/.test(I.meta), '...the image, its name and "@who · when · type · size"', I.meta);
  ok(I.acts.join() === 'Add to message,Download,Copy link' && I.primary === 'Add to message' && !I.more, '...Add to message (primary), Download, Copy link, and NO ⋯ until rename / move / remove exist', I);
  ok(I.from !== null && /Came from/.test(I.from) && /Go to the message ›/.test(I.from), '...an asset that carries its message id shows "Came from" with "Go to the message ›"', I.from);
  ok(I.pager === '1 of 31' && I.prevDis === true, '...a pager "1 of 31" with ‹ disabled at the start', { pager: I.pager, prev: I.prevDis });
  const pin = async (pg0) => pg0.evaluate(() => { const pv = document.getElementById('preview').getBoundingClientRect(); const pgr = document.querySelector('#preview .sp-pager'); const r = pgr.getBoundingClientRect(); return { gap: Math.round(pv.bottom - r.bottom), rule: getComputedStyle(pgr).borderTopWidth, full: Math.round(r.width) >= document.querySelector('#preview .pv-b').clientWidth - 1 }; });
  const pin1 = await pin(pg);
  ok(pin1.gap <= 2 && pin1.rule === '1px' && pin1.full, 'the pager is pinned to the bottom of the column, full width, with a 1px rule above it', pin1);
  await pg.click('#preview .sp-pg >> nth=1');
  await sleep(400);
  const I2 = await pg.evaluate(() => { const pv = document.getElementById('preview'); return { iname: pv.querySelector('.sp-iname')?.textContent, pager: pv.querySelector('.sp-pn')?.textContent, from: !!pv.querySelector('.sp-from') }; });
  ok(I2.iname === 'shot-29.png' && I2.pager === '2 of 31' && !I2.from, '› steps to the next, and an asset with no message id has no "Came from" block at all (label included)', I2);
  const pin2 = await pin(pg);
  ok(pin2.gap === pin1.gap, '...and it stays in the same place on the next item', { pin1, pin2 });
  await pg.click('#preview .sp-act.pri');
  await sleep(300);
  ok((await pg.inputValue('#input')).includes('[asset: shot-29.png]'), 'Add to message puts [asset: name] in the message box', await pg.inputValue('#input'));
  await pg.fill('#input', '');
  await pg.keyboard.press('Escape');
  await sleep(300);
  const esc1 = await pg.evaluate(() => ({ hidden: document.getElementById('preview').hidden, list: document.querySelectorAll('#preview .sp-tile').length > 0 }));
  ok(!esc1.hidden && esc1.list, 'Esc (and the phone\'s ‹, and ✕) from an item steps back to the list first', esc1);
  await pg.keyboard.press('Escape');
  await sleep(300);
  ok(await pg.evaluate(() => document.getElementById('preview').hidden), '...and the next one closes the column (item, list, the room)');
  await pg.click('#padAssets');
  await sleep(1200);
  await pg.click('#preview .sp-tile >> nth=0');
  await sleep(400);
  await pg.click('#preview .pv-trail');
  await sleep(400);
  ok(await pg.evaluate(() => document.querySelectorAll('#preview .sp-tile').length > 0 && !document.querySelector('#preview .sp-iname')), 'the trail goes back to the list');
  /* a note */
  await pg.click('#preview .sp-segb >> nth=1');
  await sleep(1200);
  await pg.click('#preview .sp-note[data-id="n1"]');
  await sleep(500);
  const NI = await pg.evaluate(() => {
    const pv = document.getElementById('preview');
    return { type: pv.querySelector('.pv-type')?.textContent, name: pv.querySelector('.pv-name')?.textContent, meta: pv.querySelector('.sp-imeta')?.textContent, text: pv.querySelector('.sp-ntext')?.textContent, acts: [...pv.querySelectorAll('.sp-act')].map((b) => b.textContent), pager: pv.querySelector('.sp-pn')?.textContent, trail: pv.querySelector('.pv-trail')?.textContent };
  });
  ok(NI.type === 'Scratchpad' && NI.name === 'Note · 3h ago' && /anyone in the room can edit$/.test(NI.meta) && NI.text.includes('Line five') && NI.trail.trim() === '‹ Notes · 3', 'a note opens as "Scratchpad · Note · 3h ago" (the same type label as an asset): its full text, "anyone in the room can edit", the trail "‹ Notes · 3"', NI);
  ok(NI.acts.join() === 'Add to message,Edit' && /^\d of 3$/.test(NI.pager), '...Add to message and Edit, and a pager (no Copy link: a note has no link to copy yet)', NI);
  await pg.click('#preview .sp-act.pri');
  await sleep(300);
  ok((await pg.inputValue('#input')).trim() === '[note: n1 · 3h ago]', 'Add to message puts [note: <id> · 3h ago] (the id is what the engine looks up; @who joins the label once the engine says who)', await pg.inputValue('#input'));
  await pg.fill('#input', '');
  await pg.click('#padNotes');
  await sleep(200);

  /* ---- slice 5: the engine's seen-state ---- */
  engineOn = true;
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await sleep(3500);
  const E = await pg.evaluate(() => ({ a: document.querySelector('#padAssets .pn').textContent, n: document.querySelector('#padNotes .pn').textContent, head: document.getElementById('padCount').textContent, aNew: document.getElementById('padAssets').dataset.new }));
  ok(E.a === '3 new of 31' && E.n === '1 new of 3' && E.head === '4 new' && E.aNew === '1', 'with the engine\'s counts: "3 new of 31", "1 new of 3", the header "4 new" (the two added)', E);
  await pg.click('#padAssets');
  await sleep(1500);
  const NL = await pg.evaluate(() => {
    const pv = document.getElementById('preview');
    const tiles = [...pv.querySelectorAll('.sp-tile')];
    return { name: pv.querySelector('.pv-name')?.textContent, heads: [...pv.querySelectorAll('.sp-gh')].map((h) => h.textContent), dots: tiles.filter((t) => t.querySelector('.sp-dot')).map((t) => t.dataset.name), seg: [...pv.querySelectorAll('.sp-segb')].map((b) => b.textContent), first: tiles[0]?.dataset.name };
  });
  ok(NL.name === 'Assets · 3 new of 31' && NL.heads[0] === 'New · 3' && NL.heads[1] === 'Earlier · 28' && NL.dots.join() === 'shot-30.png,shot-29.png,shot-28.png', 'the list: "Scratchpad · Assets · 3 new of 31", "New · 3" first with a dot on each, then "Earlier · 28"', NL);
  ok(NL.seg.join() === 'Assets3,Notes1', '...the switch carries each list\'s new count', NL.seg);
  await pg.click('#preview .sp-tile >> nth=0');
  await sleep(800);
  const SN = await pg.evaluate(() => ({ trail: document.querySelector('#preview .pv-trail')?.textContent, line: document.querySelector('#padAssets .pn').textContent, head: document.getElementById('padCount').textContent }));
  ok(seenPosts.length === 1 && seenPosts[0].kind === 'asset' && seenPosts[0].ids.join() === '/x/shot-30.png', 'opening a new asset POSTs scratchpad/seen {kind: "asset", ids: [its path]}', seenPosts);
  ok(/^‹ Assets · 2 new of 31$/.test(SN.trail.trim()) && SN.line === '2 new of 31' && SN.head === '3 new', '...and every count drops by one: the trail, the bar line, the cell header', SN);
  await pg.click('#preview .pv-trail');
  await sleep(300);
  const AF = await pg.evaluate(() => ({ dots: [...document.querySelectorAll('#preview .sp-tile')].filter((t) => t.querySelector('.sp-dot')).length, heads: [...document.querySelectorAll('#preview .sp-gh')].map((h) => h.textContent) }));
  ok(AF.dots === 2 && AF.heads[0] === 'New · 2', 'back at the list the opened one has no dot and "New" is 2', AF);
  await pg.click('#preview .sp-tile >> nth=0');
  await sleep(500);
  await pg.click('#preview .sp-tile >> nth=0').catch(() => {});
  await pg.keyboard.press('Escape');
  await sleep(300);
  await pg.keyboard.press('Escape');
  await sleep(300);
  /* a note */
  await pg.click('#padNotes');
  await sleep(1500);
  await pg.click('#preview .sp-note >> nth=0');
  await sleep(700);
  ok(seenPosts.some((b) => b.kind === 'note' && b.ids.join() === 'n3'), 'opening a new note POSTs {kind: "note", ids: [its id]}', seenPosts);
  ok((await pg.evaluate(() => document.querySelector('#padNotes .pn').textContent)) === '0 new of 3', '...and the Notes line reads "0 new of 3"');
  await pg.keyboard.press('Escape');
  await sleep(200);
  await pg.keyboard.press('Escape');
  await sleep(200);
  /* assets unreadable: no number, never "0 new" */
  assetsReadable = false;
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await sleep(3500);
  const U = await pg.evaluate(() => ({ a: document.querySelector('#padAssets .pn').textContent, aria: document.getElementById('padAssets').getAttribute('aria-label'), n: document.querySelector('#padNotes .pn').textContent }));
  ok(U.a === '' && U.aria === 'Assets' && U.n === '0 new of 3', 'agent-share unreadable: the Assets line says "Assets" with no number (never "0 new"); Notes still counts', U);
  assetsReadable = true;
  engineOn = false;

  /* ---- slice 4: the phone ---- */
  engineOn = true;
  assetsReadable = true;
  unseenA.clear(); ['/x/shot-30.png', '/x/shot-29.png'].forEach((x) => unseenA.add(x));
  unseenN.clear(); unseenN.add('n3');
  const ph = await ctx.newPage();
  const perrs = []; ph.on('pageerror', (e) => perrs.push(String(e)));
  await ph.setViewportSize({ width: 390, height: 780 });
  await ph.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
  await sleep(3500);
  const dotOn = await ph.evaluate(() => ({ hidden: document.getElementById('phAgentsDot').hidden, title: document.getElementById('phAgents').title, rail: getComputedStyle(document.querySelector('.rm-roster')).display }));
  ok(dotOn.hidden === false && /Scratchpad/.test(dotOn.title), 'phone: the agents button wears its dot while anything is new in the Scratchpad', dotOn);
  await ph.click('#phAgents');
  await sleep(500);
  const SH = await ph.evaluate(() => {
    const body = document.getElementById('phSheetBody');
    const h3 = [...body.querySelectorAll('h3')].map((h) => h.textContent);
    const rows = [...body.querySelectorAll('.ph-padrow')].map((r) => ({ k: r.querySelector('.pk').textContent, n: r.querySelector('.pn').textContent, h: Math.round(r.getBoundingClientRect().height), dot: getComputedStyle(r.querySelector('.pn'), '::before').content !== 'none' }));
    return { h3, rows, sheet: !document.getElementById('phSheet').hidden };
  });
  ok(SH.sheet && SH.h3[0] === 'Scratchpad' && SH.h3[1].startsWith('Rooms'), 'phone: the "Rooms and seats" sheet opens with a "Scratchpad" heading FIRST, then Rooms', SH.h3);
  ok(SH.rows.length === 2 && SH.rows[0].k === 'Assets' && SH.rows[0].n === '2 new of 31' && SH.rows[1].k === 'Notes' && SH.rows[1].n === '1 new of 3' && SH.rows.every((r) => r.h >= 52 && r.dot), '...two 52px rows: "Assets 2 new of 31" and "Notes 1 new of 3", each with its dot', SH.rows);
  await ph.click('.ph-padrow[data-kind="assets"]');
  await sleep(1500);
  const LY = await ph.evaluate(() => {
    const pv = document.getElementById('preview');
    const r = pv.getBoundingClientRect();
    return { sheet: !document.getElementById('phSheet').hidden, hidden: pv.hidden, full: Math.round(r.width) === innerWidth && Math.round(r.height) >= innerHeight - 2 && r.left <= 1 && r.top <= 1, back: pv.querySelector('.pv-back') && Math.round(pv.querySelector('.pv-back').getBoundingClientRect().height), title: pv.querySelector('.pv-name')?.textContent, cols: getComputedStyle(pv.querySelector('.sp-grid')).gridTemplateColumns.split(' ').length, tile: Math.round(pv.querySelector('.sp-th').getBoundingClientRect().width) };
  });
  ok(!LY.sheet && !LY.hidden && LY.full && LY.title === 'Assets · 2 new of 31', 'phone: a tap on a line closes the sheet and opens the Scratchpad as a full-screen layer', LY);
  ok(LY.back >= 40 && LY.cols === 3, '...a ‹ in its header, and the 3-column grid still fits', LY);
  await ph.click('#preview .sp-tile >> nth=0');
  await sleep(700);
  ok((await ph.textContent('#preview .pv-trail')).trim() === '‹ Assets · 1 new of 31', 'phone: an item opens in the same layer (trail "‹ Assets · 1 new of 31")');
  const actH = await ph.evaluate(() => [...document.querySelectorAll('#preview .sp-act')].map((b) => Math.round(b.getBoundingClientRect().height)));
  ok(actH.every((h) => h >= 44), '...its buttons are 44px', actH);
  await ph.click('#preview .pv-back');
  await sleep(400);
  ok(await ph.evaluate(() => !document.getElementById('preview').hidden && document.querySelectorAll('#preview .sp-tile').length > 0), 'phone: ‹ steps back one: item to list');
  await ph.click('#preview .pv-back');
  await sleep(400);
  ok(await ph.evaluate(() => document.getElementById('preview').hidden), 'phone: ‹ again returns to the room');
  /* Add to message closes the layer so the box shows */
  await ph.click('#phAgents');
  await sleep(400);
  await ph.click('.ph-padrow[data-kind="assets"]');
  await sleep(1200);
  await ph.click('#preview .sp-tile >> nth=0');
  await sleep(600);
  await ph.click('#preview .sp-act.pri');
  await sleep(500);
  ok((await ph.inputValue('#input')).includes('[asset: ') && (await ph.evaluate(() => document.getElementById('preview').hidden)), 'phone: Add to message puts the reference in the box and closes the layer so the box is showing', await ph.inputValue('#input'));
  ok(perrs.length === 0, 'no page errors (phone)', perrs.slice(0, 3));
  await ph.close();
  engineOn = false;

  /* ---- screenshots (SHOTS_DIR) and the light-mode check Owner asked for ---- */
  {
    const snap = async (page, name, clip) => { if (SHOTS) { await page.screenshot({ path: join(SHOTS, name), ...(clip ? { clip } : {}) }); } };
    const setMode = (page, mode) => page.evaluate(async (m) => { const mod = await import('/palette.mjs'); mod.applyPref(document, { key: 'aurora', mode: m }); await new Promise((r) => setTimeout(r, 250)); }, mode);
    engineOn = true;
    unseenA.clear(); ['/x/shot-30.png', '/x/shot-29.png', '/x/shot-28.png'].forEach((x) => unseenA.add(x));
    unseenN.clear(); unseenN.add('n3');
    const sp = await ctx.newPage();
    await sp.setViewportSize({ width: 1440, height: 900 });
    await sp.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
    await sleep(3500);
    for (const mode of ['dark', 'light']) {
      await setMode(sp, mode);
      await sp.click('#padAssets'); await sleep(1300);
      await snap(sp, `pc-${mode}-assets-list.png`);
      await sp.click('#preview .sp-tile >> nth=0'); await sleep(700);
      await snap(sp, `pc-${mode}-asset-item.png`);
      await sp.keyboard.press('Escape'); await sleep(250);
      await sp.click('#preview .sp-segb >> nth=1'); await sleep(1300);
      await snap(sp, `pc-${mode}-notes-list.png`);
      await sp.click('#preview .sp-note[data-id="n1"]'); await sleep(700);
      await snap(sp, `pc-${mode}-note-item.png`);
      if (mode === 'light') {
        const c = await sp.evaluate(() => {
          const px = (css) => { const cv = document.createElement('canvas'); cv.width = cv.height = 1; const x = cv.getContext('2d'); x.fillStyle = css; x.fillRect(0, 0, 1, 1); return [...x.getImageData(0, 0, 1, 1).data].slice(0, 3); };
          const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
          const cr = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
          const bg = (sel) => { let e = document.querySelector(sel); while (e) { const c = getComputedStyle(e).backgroundColor; if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') { return px(c); } e = e.parentElement; } return [255, 255, 255]; };
          const fg = (sel) => px(getComputedStyle(document.querySelector(sel)).color);
          const pair = (sel) => +cr(fg(sel), bg(sel)).toFixed(2);
          return { cellCount: pair('#padAssets .pn'), cellKey: pair('#padAssets .pk'), meta: pair('#preview .sp-imeta'), ntext: pair('#preview .sp-ntext'), tag: pair('#preview .sp-tag'), act: pair('#preview .sp-act:not(.pri)') };
        });
        ok(c.cellKey >= 4.5 && c.cellCount >= 3.5 && c.meta >= 3.5 && c.ntext >= 4.5 && c.act >= 4.5, 'light mode: the Scratchpad line, the item meta, a note\'s text and the buttons keep their contrast (palette applied, measured)', c);
      }
      await sp.keyboard.press('Escape'); await sleep(200);
      await sp.keyboard.press('Escape'); await sleep(200);
    }
    await setMode(sp, 'dark');
    await snap(sp, 'pc-dark-cell.png', { x: 0, y: 0, width: 380, height: 700 });
    await sp.close();
    /* the phone */
    const pp = await ctx.newPage();
    await pp.setViewportSize({ width: 390, height: 780 });
    await pp.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
    await sleep(3500);
    for (const mode of ['dark', 'light']) {
      await setMode(pp, mode);
      await pp.click('#phAgents'); await sleep(500);
      await snap(pp, `phone-${mode}-sheet.png`);
      await pp.click('.ph-padrow[data-kind="assets"]'); await sleep(1300);
      await snap(pp, `phone-${mode}-assets-list.png`);
      await pp.click('#preview .sp-tile >> nth=0'); await sleep(700);
      await snap(pp, `phone-${mode}-asset-item.png`);
      await pp.click('#preview .pv-back'); await sleep(300);
      await pp.click('#preview .pv-back'); await sleep(300);
    }
    await pp.close();
    engineOn = false;
  }

  /* ---- the second engine batch: thumbnails, lineId (came from), the ⋯ verbs; the edition gate ---- */
  batch2 = true;
  const p2 = await ctx.newPage();
  await p2.setViewportSize({ width: 1440, height: 900 });
  await p2.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
  await sleep(3500);
  await p2.click('#padAssets');
  await sleep(1500);
  const T = await p2.evaluate(() => [...document.querySelectorAll('#preview .sp-tile img')].slice(0, 3).map((i) => i.getAttribute('src')));
  ok(T.length === 3 && T.every((x) => /\/assets\/thumb\/shot-\d+\.png\?w=256$/.test(x)), 'with the engine\'s thumbnails (lineId on the row): each tile asks /assets/thumb/<name>?w=256, not the full image', T);
  await p2.click('#preview .sp-more').catch(() => {});
  await sleep(300);
  const fb = await p2.evaluate(async () => {
    const t = [...document.querySelectorAll('#preview .sp-tile')].find((x) => x.dataset.name === 'shot-1.png');
    if (!t) { return { found: false }; }
    await new Promise((r) => setTimeout(r, 800));
    return { found: true, src: t.querySelector('img')?.getAttribute('src') ?? null, ext: !!t.querySelector('.sp-ext') };
  });
  ok(!fb.found || /\/assets\/raw\/shot-1\.png$/.test(fb.src ?? ''), 'a thumbnail the engine answers 404 for falls back to the full image', fb);
  await p2.click('#preview .sp-tile >> nth=0');
  await sleep(600);
  const D = await p2.evaluate(() => ({ acts: [...document.querySelectorAll('#preview .sp-acts .sp-act')].map((b) => b.textContent), dots: !!document.querySelector('#preview .sp-dots'), dotsOnNameRow: !!document.querySelector('#preview .sp-namerow .sp-dots'), from: document.querySelector('#preview .sp-from')?.textContent ?? null }));
  ok(D.acts.join() === 'Add to message,Download,Copy link' && D.dots && D.dotsOnNameRow && /Go to the message ›/.test(D.from), 'with the second batch the asset has its ⋯ at the right end of the NAME line (not in the action row) and, from lineId, "Came from"', D);
  await p2.click('#preview .sp-dots');
  await sleep(200);
  if (SHOTS) { await p2.screenshot({ path: join(SHOTS, 'pc-dark-asset-menu.png') }); }
  const inside = await p2.evaluate(() => { const m = document.querySelector('#preview .sp-menu').getBoundingClientRect(); const pv = document.getElementById('preview').getBoundingClientRect(); const d = document.querySelector('#preview .sp-dots').getBoundingClientRect(); return { in: m.left >= pv.left && m.right <= pv.right && m.bottom <= pv.bottom, below: m.top >= d.bottom - 1, rightAligned: Math.abs(m.right - d.right) <= 2 }; });
  ok(inside.in && inside.below && inside.rightAligned, 'the ⋯ menu opens inside the column, downward from the name line, right-aligned to the button', inside);
  const M = await p2.evaluate(() => [...document.querySelectorAll('#preview .sp-menu .sp-mi')].map((b) => b.textContent));
  ok(M.join() === 'Rename…,Move to…,Remove…', 'the ⋯ menu: Rename…, Move to…, Remove…', M);
  await p2.click('#preview .sp-menu .sp-mi >> text=Rename…');
  await p2.fill('#preview .sp-menu .sp-input', 'renamed.png');
  await p2.click('#preview .sp-menu .sp-act.pri');
  await sleep(900);
  ok(itemCalls.length === 1 && itemCalls[0].method === 'PATCH' && /^shot-30\.png$/.test(itemCalls[0].name) && JSON.parse(itemCalls[0].body).name === 'renamed.png', 'Rename PATCHes assets/item/<name> {name}', itemCalls);
  ok(await p2.evaluate(() => document.querySelectorAll('#preview .sp-tile').length > 0 && !document.querySelector('#preview .sp-iname')), '...and returns to the list', null);
  await p2.click('#preview .sp-tile >> nth=0');
  await sleep(500);
  await p2.click('#preview .sp-dots');
  await p2.click('#preview .sp-menu .sp-mi >> text=Move to…');
  const mv = await p2.evaluate(() => document.querySelector('#preview .sp-menu')?.textContent);
  ok(/No other room in this family/.test(mv), 'Move to… with no other room in the family says so', mv);
  await p2.click('#preview .sp-menu .sp-mi >> text=Cancel');
  await p2.click('#preview .sp-menu .sp-mi >> text=Remove…');
  const rm = await p2.evaluate(() => document.querySelector('#preview .sp-menu')?.textContent);
  ok(/Remove shot-30\.png\? It is kept aside, not deleted\./.test(rm), 'Remove… asks first, and says the file is kept aside', rm);
  await p2.click('#preview .sp-menu .sp-act.pri');
  await sleep(900);
  ok(itemCalls.at(-1).method === 'DELETE' && itemCalls.at(-1).name === 'shot-30.png', '...then DELETEs assets/item/<name>', itemCalls.at(-1));
  await p2.keyboard.press('Escape');
  await p2.close();
  batch2 = false;

  /* EDITION: a Basic instance keeps the OLD left bar (the Assets cell, no Scratchpad) */
  edition = 'basic';
  const bp = await ctx.newPage();
  await bp.setViewportSize({ width: 1440, height: 900 });
  await bp.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
  await sleep(3500);
  const B = await bp.evaluate(() => {
    const vis = (el) => !!el && el.offsetParent !== null && getComputedStyle(el).display !== 'none';
    return { pad: vis(document.getElementById('padCell')), assets: vis(document.querySelector('#panelCells > .cell[data-cell="p-assets"]')), order: [...document.querySelectorAll('.rm-roster > section.cell, #panelCells > .cell')].filter(vis).map((c) => c.dataset.cell) };
  });
  ok(!B.pad && B.assets && B.order.join(',') === 'room,seats,p-tasks,p-assets', 'edition basic: no Scratchpad cell; the Assets cell is drawn as before (Room, Seats, Tasks, Assets)', B);
  await bp.setViewportSize({ width: 390, height: 780 });
  await sleep(600);
  await bp.click('#phAgents');
  await sleep(500);
  const BS = await bp.evaluate(() => [...document.querySelectorAll('#phSheetBody h3')].map((h) => h.textContent));
  ok(!BS.includes('Scratchpad'), 'edition basic, phone: no Scratchpad lines in the agents sheet', BS);
  await bp.close();
  edition = 'full';

  /* ---- an empty Scratchpad says so ---- */
  const empty = await pg.evaluate(async () => {
    const m = await import('/room-scratchpad.mjs');
    const host = document.createElement('div');
    host.innerHTML = document.getElementById('padCell').outerHTML.replace(/id="pad/g, 'id="xpad');
    document.body.append(host);
    const cell = host.firstElementChild;
    cell.querySelectorAll('[id]').forEach((n) => { n.id = n.id.replace('xpad', 'pad'); });
    const inst = m.mountScratchpad({ roomId: 'unit-empty', cell, list: document.createElement('div'), preview: { current: () => null, close() {} }, api: async () => ({ ok: false }), visible: () => false });
    inst.setCounts({ assets: { n: 0, m: 0 }, notes: { n: 0, m: 3 } });
    const q = (s) => cell.querySelector(s);
    const out = { a: q('#padAssets .pn').textContent, n: q('#padNotes .pn').textContent, aNew: q('#padAssets').dataset.new, aria: q('#padAssets').getAttribute('aria-label'), aCol: getComputedStyle(q('#padAssets .pn')).color, nCol: getComputedStyle(q('#padNotes .pn')).color };
    inst.destroy();
    host.remove();
    return out;
  });
  ok(empty.a === 'none yet' && empty.aNew === '0' && /none yet/.test(empty.aria) && empty.n === '0 new of 3' && empty.aCol === empty.nCol, 'an empty list reads "none yet" in the dim ink on the bar (not "0 new of 0")', empty);

  /* ---- folding is remembered ---- */
  await pg.click('#padHead');
  const folded = await pg.evaluate(() => ({ c: document.getElementById('padCell').classList.contains('collapsed'), body: getComputedStyle(document.querySelector('#padCell .cell-b')).display, exp: document.getElementById('padHead').getAttribute('aria-expanded') }));
  ok(folded.c && folded.body === 'none' && folded.exp === 'false', 'the header folds the cell', folded);
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await sleep(3000);
  ok(await pg.evaluate(() => document.getElementById('padCell').classList.contains('collapsed')), '...and a reload keeps it folded (per room)');
  await pg.click('#padHead');
  ok(errs.length === 0, 'no page errors', errs.slice(0, 3));
  await ctx.close();
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
