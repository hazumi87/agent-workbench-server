/* IMAGE LINKS IN ROOM LINES (Owner 2026-09-28), the page's half.
 *
 *   node test/room-image-links.probe.mjs
 *
 * What only a browser can prove (desktop 1280x800, then phone 390x844):
 *   - a line with one image URL on the engine's own origin shows ONE
 *     thumbnail in the attachments' single-image box (min 120, 100 on a phone;
 *     max 260x170), after the body, with lazy/async/no-referrer and the file
 *     name as alt; the text link stays in the body;
 *   - 3 image URLs (tailnet IP, any case, a query and a hash) are 3 tiles;
 *     6 are the first 4 and a "+2";
 *   - an untrusted host (https://example.com/x.png) draws no <img> and the
 *     browser NEVER requests it (every request is recorded); the link stays;
 *   - a 404 image hides its thumbnail (and the set) and keeps the link;
 *   - an agent-share URL for THIS room's folder is drawn through the engine's
 *     raw route; another share file loads from the share (its origin is
 *     trusted); a non-image link draws nothing;
 *   - facts and replies get thumbnails too; the reply's quote header does not;
 *   - a click opens the room's lightbox (#lightbox) with the image; Esc (a
 *     tap on a phone) closes it; Shift-click and a middle click go to
 *     openExternal (window.open stubbed) and open no lightbox; no reply, no
 *     menu starts;
 *   - no horizontal overflow at 390.
 *
 * Fixture PNGs: the engine-origin and tailnet-IP URLs are answered by
 * page.route (the browser still addresses them to that host, so the trust
 * rule is what is tested); the share URLs by a stub agent-share on P(238),
 * which the engine proxies for the room's own folder.
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(236), DEAD broker
 * P(237), stub agent-share P(238), temp table seeded through the store: never
 * Owner's data, childEnv() scrubbed, fabric + NATS off.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import { chromium } from 'playwright';
import { P, assertFree, childEnv, windowCookie, roomUserWrite } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(236);
const DEAD_BROKER_PORT = P(237);
const SHARE_PORT = P(238);
const BASE = `http://127.0.0.1:${PORT}`;
const SHARE = `http://127.0.0.1:${SHARE_PORT}`;
const TOKEN = 'probe-room-image-links-token';
const TAIL = 'http://100.64.0.9';

let failures = 0;
let passes = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (cond) { passes += 1; } else { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* a solid-colour RGB PNG, w x h */
function png(w, h, [r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x += 1) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const BIG = png(400, 300, [40, 160, 150]);
const TINY = png(20, 20, [200, 80, 60]);

let cookieP = null;
const userCookie = () => (cookieP ??= windowCookie(BASE, TOKEN));
async function call(path, opts = {}) {
  const method = opts.method ?? (opts.json !== undefined ? 'POST' : 'GET');
  const headers = roomUserWrite(path, method, opts.json) || opts.user ? { cookie: await userCookie() } : { authorization: `Bearer ${TOKEN}` };
  const init = { method, headers };
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.json);
  }
  const res = await fetch(BASE + path, init);
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
}
function runTsx(args, env) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('exit', (code) => resolve({ code, out, err }));
  });
}

try {
  const stale = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
  if (stale.ok) {
    console.log(` FAIL  :${PORT} is already serving something — a leaked engine from an aborted run?`);
    process.exit(1);
  }
} catch { /* nothing there */ }
for (const p of [PORT, DEAD_BROKER_PORT, SHARE_PORT]) {
  await assertFree(p, 'room-image-links.probe.mjs');
}

/* ---- stub agent-share: any /raw/<...>.png is BIG, anything else 404 ---- */
const shareHits = [];
const stub = createServer((req, res) => {
  const u = new URL(req.url ?? '/', SHARE);
  shareHits.push(decodeURIComponent(u.pathname));
  if (u.pathname.startsWith('/raw/') && /\.png$/i.test(u.pathname) && !/missing/.test(u.pathname)) {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(BIG.length) });
    return res.end(req.method === 'HEAD' ? undefined : BIG);
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => stub.listen(SHARE_PORT, '127.0.0.1', r));

const INIT = () => {
  window.__opened = [];
  window.open = (...a) => { window.__opened.push(a); return null; };
};

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-image-links-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null;
let browser = null;
let engineLog = '';
const seed = async (plan) => {
  const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
  return JSON.parse(r.out.trim().split('\n').pop());
};

try {
  const recipe = (id, name, agent, color) => ({ id, name, projectDir: `/srv/x/${agent}`, vendor: 'claude-code', agent, color });
  await seed({ recipes: [recipe('rec-lead', 'Leader', 'leader', '#1f5fbf'), recipe('rec-buddy', 'Buddy', 'buddy', '#ba08b4')] });
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT),
      HARBOR_WB_HOST: '127.0.0.1',
      HARBOR_WB_TABLE: dbPath,
      HARBOR_WB_TOKEN: TOKEN,
      HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'),
      HARBOR_WB_IDENTITY: 'legacy',
      HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_NATS_URL: '',
      HARBOR_WB_FABRIC_URL: '',
      HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT),
      HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
      HARBOR_WB_ROOM_SCRATCH_DIR: join(tmpDir, 'scratch'),
      HARBOR_WB_AGENT_SHARE_URL: SHARE,
      HARBOR_WB_NODE: 'testnode',
    }),
  });
  engine.stdout.on('data', (d) => (engineLog += d));
  engine.stderr.on('data', (d) => (engineLog += d));
  let up = false;
  for (let i = 0; i < 120; i += 1) {
    await sleep(250);
    try { if ((await fetch(`${BASE}/health`)).ok) { up = true; break; } } catch { /* not yet */ }
  }
  ok(up, `scratch engine is serving on ${PORT}`, up ? undefined : engineLog.slice(-400));
  if (!up) { throw new Error('engine never came up'); }

  const LEAD = 'recipe:rec-lead';
  const BUDDY = 'recipe:rec-buddy';
  const live = (paneid, rid, agent) => ({ paneid, recipe_id: rid, vendor: 'claude-code', agent, state: 'live' });
  const post = await seed({
    sessions: [live(LEAD, 'rec-lead', 'leader'), live(BUDDY, 'rec-buddy', 'buddy')],
    rooms: [{ name: 'Image Links Probe', seats: [{ handle: 'leader', recipe_id: 'rec-lead', occupant: LEAD }, { handle: 'buddy', recipe_id: 'rec-buddy', occupant: BUDDY }] }],
  });
  const R = post.rooms[0].id;
  const LINE = `/api/rooms/${R}/line`;
  const folder = (await call(`/api/rooms/${R}/assets/folder`, { user: true })).body?.folder;
  ok(typeof folder === 'string' && folder.startsWith('rooms/'), 'setup: the room has an asset folder', folder);

  const say = async (text, who = BUDDY, extra = {}) => (await call(LINE, { json: { text, ...(who ? { from: { paneid: who } } : {}), ...extra } })).body.entries[0];
  const ONE = `${BASE}/__probe/big.png`;
  const one = await say(`here is the shot ${ONE} — looks right?`);
  const tiny = await say(`tiny: ${BASE}/__probe/tiny.PNG`);
  const THREE = [`${TAIL}/a.png`, `${TAIL}/b.JPG?x=1`, `${TAIL}/c.webp#frag`];
  const three = await say(`three: ${THREE.join(' ')}`, null); // the user's own line
  const SIX = ['p1.png', 'p2.jpeg', 'p3.gif', 'p4.avif', 'p5.png', 'p6.png'].map((n) => `${TAIL}/six/${n}`);
  const six = await say(`six: ${SIX.join(' ')}`);
  const UNTRUSTED = 'https://example.com/x.png';
  const untrusted = await say(`outside: ${UNTRUSTED}`);
  const mixed = await say(`mixed https://example.com/y.png and ${BASE}/__probe/mixed.png`);
  const broken = await say(`broken: ${BASE}/__probe/404.png`);
  const SHARE_OWN = `${SHARE}/raw/${folder}/pic.png`;
  const shareOwn = await say(`in assets: ${SHARE_OWN}`);
  const SHARE_OTHER = `${SHARE}/raw/elsewhere/other.png`;
  const shareOther = await say(`elsewhere: ${SHARE_OTHER}`);
  const nonImage = await say(`a doc ${BASE}/__probe/doc.pdf and https://x.io/page`);
  const reply = await say(`answer with a picture ${BASE}/__probe/reply.png`, LEAD, { reply_to: one.id });
  ok([one, tiny, three, six, untrusted, mixed, broken, shareOwn, shareOther, nonImage, reply].every((e) => e && e.id), 'setup: the lines are posted');
  ok(reply?.meta && JSON.stringify(reply.meta).includes(String(one.id)), 'setup: the reply line carries its reply', reply?.meta);
  const FACT_ID = reply.id + 50000;
  const factEntry = { id: FACT_ID, room_id: R, ts: new Date().toISOString(), kind: 'fact', author: 'room', author_seat: null, target: null, target_seat: null, body: `a fact with ${BASE}/__probe/fact.png`, meta: null };

  browser = await chromium.launch({ headless: true });

  for (const vp of [{ name: 'desktop', width: 1280, height: 800, touch: false }, { name: 'phone', width: 390, height: 844, touch: true }]) {
    console.log(`--- ${vp.name} ${vp.width}x${vp.height}`);
    const MIN = vp.touch ? 100 : 120;
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.touch });
    await context.addInitScript(INIT);
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('request', (r) => requests.push(r.url()));
    /* fixture images, addressed to the engine's origin and a tailnet IP */
    await page.route(`${BASE}/__probe/**`, (route) => {
      const u = new URL(route.request().url());
      if (/404/.test(u.pathname) || !/\.png$/i.test(u.pathname)) {
        return route.fulfill({ status: 404, body: 'no' });
      }
      return route.fulfill({ status: 200, contentType: 'image/png', body: /tiny/i.test(u.pathname) ? TINY : BIG });
    });
    await page.route(`${TAIL}/**`, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: BIG }));
    await page.route('https://example.com/**', (route) => route.abort());

    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => {
      const f = document.querySelector('form');
      (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
    }, TOKEN);
    await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
    await call(`/api/rooms/${R}/draft`, { method: 'PUT', json: { text: '', reply_to: null }, user: true });
    const ROOM = `${BASE}/room.html?room=${R}`;
    const li = (id) => `#line li[data-id="${id}"]`;
    /* the fact is shown to the page only (a room fact cannot be posted): the
       page's first read of the line gets it appended */
    const firstRead = (u) => u.pathname === `/api/rooms/${R}/line` && u.searchParams.has('limit') && !u.searchParams.has('before') && !u.searchParams.has('after');
    await page.route(firstRead, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.entries = [...(body.entries ?? []), factEntry];
      await route.fulfill({ response: res, json: body });
    });
    await page.goto(ROOM, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(`${li(reply.id)} .entry-body`);
    await page.unroute(firstRead);
    await sleep(500);
    /* bring a line into view so its lazy images load, then wait for them */
    const settle = async (id) => {
      await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), li(id));
      await page.waitForFunction((s) => [...document.querySelectorAll(s + ' .ril-set img')].every((i) => i.complete), li(id), { timeout: 5000 }).catch(() => {});
      await sleep(250);
    };
    const setOf = (id) => page.evaluate((s) => {
      const L = document.querySelector(s);
      const set = L?.querySelector('.ril-set');
      const body = L?.querySelector('.entry-body');
      const r = (el) => { const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right) }; };
      return {
        set: !!set, setHidden: set ? set.hidden : null, afterBody: set ? set.previousElementSibling === body : null,
        inBubble: set ? !!set.closest('.entry-bubble') : null,
        thumbs: set ? [...set.querySelectorAll('.ril-thumb')].map((b) => ({ one: b.classList.contains('one'), hidden: b.hidden, box: r(b), url: b.dataset.url, title: b.title })) : [],
        imgs: set ? [...set.querySelectorAll('img')].map((i) => ({ src: i.getAttribute('src'), alt: i.alt, loading: i.loading, decoding: i.decoding, ref: i.referrerPolicy, nw: i.naturalWidth, box: r(i) })) : [],
        more: set?.querySelector('.ril-more')?.textContent ?? null,
        links: body ? [...body.querySelectorAll('a.rl-link')].map((a) => a.getAttribute('href')) : [],
        allImgs: L ? [...L.querySelectorAll('img')].map((i) => i.getAttribute('src')) : [],
      };
    }, li(id));

    /* ---- 1. one image on the engine's origin: the single-image box ---- */
    await settle(one.id);
    let s = await setOf(one.id);
    ok(s.set && !s.setHidden && s.afterBody && s.inBubble, 'one image: a set under the body, in the bubble', s);
    ok(s.thumbs.length === 1 && s.thumbs[0].one, '...ONE thumbnail in the single-image box (.att-img.one)', s.thumbs);
    const im = s.imgs[0];
    ok(im && im.src === ONE && im.alt === 'big.png' && im.loading === 'lazy' && im.decoding === 'async' && im.ref === 'no-referrer', '...src = the URL, alt = the file name, lazy + async + no-referrer', im);
    ok(im && im.nw === 400, '...and it loaded', im?.nw);
    const b1 = s.thumbs[0]?.box;
    ok(b1 && b1.w >= MIN && b1.h >= MIN && b1.w <= 260 && b1.h <= 170, `...box within ${MIN}x${MIN} .. 260x170`, b1);
    ok(im && Math.abs(im.box.w / im.box.h - 4 / 3) < 0.05, '...the picture uncropped (contain keeps 4:3)', im?.box);
    ok(JSON.stringify(s.links) === JSON.stringify([ONE]), '...the text link stays in the body', s.links);
    await settle(tiny.id);
    s = await setOf(tiny.id);
    const bt = s.thumbs[0]?.box;
    ok(s.thumbs.length === 1 && s.thumbs[0].one && bt.w >= MIN && bt.h >= MIN, `a tiny image (20px, .PNG) is never a speck: >= ${MIN}px`, bt);

    /* ---- 2. three tiles; six = 4 + "+2" ---- */
    await settle(three.id);
    s = await setOf(three.id);
    ok(s.thumbs.length === 3 && s.thumbs.every((t) => !t.one && t.box.w === MIN && t.box.h === MIN), `three (a query, a hash, .JPG): three ${MIN}px tiles`, s.thumbs.map((t) => [t.one, t.box]));
    ok(JSON.stringify(s.imgs.map((i) => i.src)) === JSON.stringify(THREE) && s.imgs.every((i) => i.nw === 400), '...from the tailnet IP, each loaded', s.imgs.map((i) => [i.src, i.nw]));
    ok(s.inBubble && s.afterBody, '...on the user\'s own line too');
    await settle(six.id);
    s = await setOf(six.id);
    ok(s.thumbs.length === 4 && s.more === '+2' && JSON.stringify(s.thumbs.map((t) => t.url)) === JSON.stringify(SIX.slice(0, 4)), 'six: the first 4 and "+2"', { n: s.thumbs.length, more: s.more });
    ok(s.links.length === 6, '...all six stay links in the text', s.links.length);

    /* ---- 3. untrusted: no <img>, no request ---- */
    await settle(untrusted.id);
    s = await setOf(untrusted.id);
    ok(!s.set && s.allImgs.length === 0 && JSON.stringify(s.links) === JSON.stringify([UNTRUSTED]), 'an untrusted host: no thumbnail, no <img>, the link stays', s);
    await settle(mixed.id);
    s = await setOf(mixed.id);
    ok(s.thumbs.length === 1 && s.thumbs[0].one && s.imgs[0].src === `${BASE}/__probe/mixed.png` && s.links.length === 2, 'a line with one trusted + one untrusted: only the trusted one is drawn, both stay links', s.imgs.map((i) => i.src));

    /* ---- 4. a 404 hides its thumbnail ---- */
    await settle(broken.id);
    s = await setOf(broken.id);
    ok(s.set && s.setHidden && s.thumbs.length === 1 && s.thumbs[0].hidden, 'a 404: the thumbnail (and its set) quietly hidden', s);
    ok(await page.evaluate((sel) => { const set = document.querySelector(sel + ' .ril-set'); return set ? set.getBoundingClientRect().height === 0 : false; }, li(broken.id)), '...taking no room');
    ok(JSON.stringify(s.links) === JSON.stringify([`${BASE}/__probe/404.png`]), '...the link stays', s.links);

    /* ---- 5. agent-share ---- */
    await settle(shareOwn.id);
    s = await setOf(shareOwn.id);
    ok(s.thumbs.length === 1 && s.imgs[0]?.src === `/api/rooms/${R}/assets/raw/pic.png` && s.imgs[0]?.nw === 400, 'a share URL in THIS room\'s folder: drawn through the engine\'s raw route', s.imgs);
    ok(JSON.stringify(s.links) === JSON.stringify([SHARE_OWN]), '...the share URL stays the link', s.links);
    await settle(shareOther.id);
    s = await setOf(shareOther.id);
    ok(s.thumbs.length === 1 && s.imgs[0]?.src === SHARE_OTHER && s.imgs[0]?.nw === 400, 'another share file: trusted by the share origin, loaded from it', s.imgs);
    ok(shareHits.includes(`/raw/${folder}/pic.png`) && shareHits.includes('/raw/elsewhere/other.png'), '...the stub share served both', shareHits.slice(-4));
    await settle(nonImage.id);
    s = await setOf(nonImage.id);
    ok(!s.set && s.links.length === 2, 'a non-image link (.pdf, a page): no set', s);

    /* ---- 6. a fact, a reply ---- */
    await settle(FACT_ID);
    s = await setOf(FACT_ID);
    ok(s.set && !s.inBubble && s.thumbs.length === 1 && s.imgs[0]?.nw === 400, 'a fact: its image under its text (no bubble)', s);
    await settle(reply.id);
    s = await setOf(reply.id);
    const quote = await page.evaluate((sel) => {
      const q = document.querySelector(sel + ' .rp-qh');
      return q ? { imgs: q.querySelectorAll('img').length, text: q.textContent } : null;
    }, li(reply.id));
    ok(s.thumbs.length === 1 && s.imgs[0]?.src === `${BASE}/__probe/reply.png`, 'a reply: its own image drawn', s.imgs.map((i) => i.src));
    ok(quote && quote.imgs === 0, '...its quote header stays text only (the quoted line\'s image is not drawn there)', quote);
    const order = await page.evaluate((sel) => [...document.querySelector(sel + ' .entry-bubble').children].map((c) => c.className.split(' ')[0]), li(reply.id));
    ok(order.indexOf('rp-qh') < order.indexOf('entry-body') && order.indexOf('entry-body') < order.indexOf('entry-att'), '...order: quote, body, thumbnails', order);

    /* ---- 7. click → the lightbox; Esc / tap closes it ---- */
    await settle(one.id);
    const thumbSel = `${li(one.id)} .ril-thumb`;
    if (vp.touch) { await page.tap(thumbSel); } else { await page.click(thumbSel); }
    await sleep(300);
    let lb = await page.evaluate(() => {
      const l = document.querySelector('#lightbox');
      const img = l.querySelector('#lbBody img');
      return { open: !l.hidden, src: img?.getAttribute('src') ?? null, alt: img?.alt ?? null, cap: l.querySelector('#lbCap').textContent, ref: img?.referrerPolicy ?? null, focus: document.activeElement === l, chip: !!document.querySelector('#attTray > .rp-chip'), menu: !!document.querySelector('.rsm-menu'), opened: window.__opened.length };
    });
    ok(lb.open && lb.src === ONE && lb.alt === 'big.png' && lb.cap === 'big.png' && lb.ref === 'no-referrer', 'a click opens the room\'s lightbox with the image, captioned with its name', lb);
    ok(!lb.chip && !lb.menu && lb.opened === 0, '...no reply, no menu, no new window', lb);
    const full = await page.evaluate(() => { const i = document.querySelector('#lbBody img'); const b = i.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; });
    ok(full.w > 260 || full.h > 170, '...full size: larger than the thumbnail box', full);
    if (vp.touch) {
      await page.tap('#lightbox', { position: { x: 10, y: 10 } });
    } else {
      await page.keyboard.press('Escape');
    }
    await sleep(200);
    lb = await page.evaluate(() => ({ open: !document.querySelector('#lightbox').hidden, focusThumb: document.activeElement?.classList.contains('ril-thumb') ?? false }));
    ok(!lb.open, `${vp.touch ? 'a tap' : 'Esc'} closes it`, lb);
    if (!vp.touch) {
      ok(lb.focusThumb, '...and the focus is back on the thumbnail', lb);
      await page.click(thumbSel);
      await sleep(200);
      await page.mouse.click(10, 10);
      await sleep(200);
      ok(await page.evaluate(() => document.querySelector('#lightbox').hidden), 'a click on the backdrop closes it too');
    }

    /* ---- 8. Shift-click / middle click → openExternal ---- */
    if (!vp.touch) {
      await page.click(thumbSel, { modifiers: ['Shift'] });
      await sleep(200);
      let st = await page.evaluate(() => ({ opened: window.__opened, open: !document.querySelector('#lightbox').hidden }));
      ok(JSON.stringify(st.opened) === JSON.stringify([[ONE, '_blank', 'noopener,noreferrer']]) && !st.open, 'Shift-click: openExternal(url), no lightbox', st);
      await page.click(thumbSel, { button: 'middle' });
      await sleep(200);
      st = await page.evaluate(() => ({ n: window.__opened.length, last: window.__opened.at(-1), open: !document.querySelector('#lightbox').hidden }));
      ok(st.n === 2 && st.last[0] === ONE && !st.open, 'a middle click: openExternal too', st);
    } else {
      await page.evaluate((sel) => document.querySelector(sel).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true })), thumbSel);
      await sleep(200);
      const st = await page.evaluate(() => ({ opened: window.__opened, open: !document.querySelector('#lightbox').hidden }));
      ok(st.opened.length === 1 && st.opened[0][0] === ONE && !st.open, 'Shift-click (phone keyboard): openExternal(url), no lightbox', st);
    }

    /* ---- 9. privacy + layout ---- */
    const leaked = requests.filter((u) => u.includes('example.com'));
    ok(leaked.length === 0, 'the untrusted host was NEVER requested', leaked);
    if (vp.touch) {
      for (const id of [one.id, three.id, six.id, shareOwn.id, FACT_ID]) { await settle(id); }
      const ov = await page.evaluate(() => {
        const se = document.scrollingElement;
        const sets = [...document.querySelectorAll('.ril-set:not([hidden])')].map((x) => Math.round(x.getBoundingClientRect().right));
        const line = document.querySelector('#line');
        return { doc: [se.scrollWidth, se.clientWidth], line: line ? [line.scrollWidth, line.clientWidth] : null, maxRight: Math.max(...sets), vw: innerWidth };
      });
      ok(ov.doc[0] <= ov.doc[1] && (!ov.line || ov.line[0] <= ov.line[1]) && ov.maxRight <= ov.vw, 'no horizontal overflow at 390', ov);
    }

    ok(errors.length === 0, 'no page errors', errors);
    await context.close();
  }
} catch (e) {
  ok(false, 'probe crashed', String(e?.stack ?? e));
} finally {
  await browser?.close().catch(() => {});
  if (engine) {
    engine.kill('SIGTERM');
    await sleep(400);
    try { engine.kill('SIGKILL'); } catch { /* gone */ }
  }
  stub.close();
  rmSync(tmpDir, { recursive: true, force: true });
}
console.log(failures === 0 ? `\nroom-image-links.probe: PASS (${passes})` : `\nroom-image-links.probe: ${failures} FAIL, ${passes} ok`);
process.exit(failures === 0 ? 0 : 1);
