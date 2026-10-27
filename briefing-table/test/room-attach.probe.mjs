/* ROOM COMPOSER ATTACHMENTS [ticket], against the design system room-attach-v1.
 *
 *   node test/room-attach.probe.mjs
 *
 * Proves, on a scratch engine in a real Chromium:
 *   - the + sits LEFT of the input: a 40px ghost square, tooltip "Attach files
 *     (or paste, or drop)"; → stays the teal action
 *   - picked files become tiles in ONE row ABOVE the input, lined up with the
 *     input (not the +), 64px tall (images square, files 208px chips); the
 *     row scrolls sideways rather than wrapping
 *   - ✕ removes a file from the server scratchpad; the tray (and the text
 *     draft) survive a reload, restored as uploaded (no meters)
 *   - a tile is focusable; Delete removes it and focus moves to a neighbour
 *   - UPLOADING (sky meter) and FAILED (coral, "Over 25 MB limit" from the
 *     413, the note) both disable Send with the reason in its tooltip; retry
 *     or remove re-enables it
 *   - pasting an image adds a tile ("Pasted image HH-MM.png"); pasting text
 *     stays text
 *   - drag-over outlines the whole line column; drop adds the file
 *   - past the per-message count, extra files are one note, not tiles
 *   - "Sending adds an Assets panel to this room." while drafting in a room
 *     without one; on send the panel appears in the rail with its wash
 *   - the sent bubble: thumbnails (3, then a 4th with "+N"), file chips, the
 *     receipt "N files · in Assets"; no raw reference in the human's view; a
 *     single image larger (a 4x4 one in a >= 120px box, never a speck), file
 *     chips on their own row after the images; a click opens the preview column
 *   - phone at 390px: + and → 44px, 56px tiles, no sideways page scroll
 *
 * A PROBE, not in `npm test`. OWN scratch engine P(144), DEAD broker P(145),
 * stub agent-share P(146), stub room-assets app P(147). Never the real share,
 * never :8206.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(144);
const DEAD_BROKER_PORT = P(145);
const SHARE_PORT = P(146);
const ASSETS_PORT = P(147);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const SHARE = `http://${HOST}:${SHARE_PORT}`;
const TOKEN = 'probe-room-attach-token';

let failures = 0;
let passes = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (cond) { passes += 1; } else { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* a throw inside a route handler would otherwise kill the probe past its
   finally, orphaning the scratch engine on its port */
process.on('unhandledRejection', (e) => ok(false, `unhandled: ${e?.stack ?? e}`));
/* ATTACH_SHOTS=<dir>: save a screenshot at each state, for a human/the design system review */
const shot = async (p, name) => {
  if (process.env.ATTACH_SHOTS) {
    await p.screenshot({ path: join(process.env.ATTACH_SHOTS, `${name}.png`) });
  }
};
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) { return true; } } catch { /* not yet */ }
    await sleep(100);
  }
  return false;
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

/* a real 2x2 PNG, so thumbnails decode */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEIGBmgAMYAAA+OA/1bLb6vAAAAAElFTkSuQmCC', 'base64');
const img = (name) => ({ name, mimeType: 'image/png', buffer: PNG });
/* a real 4x4 PNG: the small single image that must not render as a speck */
const PNG4 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAM0lEQVR4nAXBgQAAAAgEsccJIogggggiiIcI4rDaRAYdbHAhsuhiiyuRQw873Ig0bdacH38SGkGz1uO5AAAAAElFTkSuQmCC', 'base64');
const doc = (name, n = 2048) => ({ name, mimeType: 'application/pdf', buffer: Buffer.alloc(n, 37) });

/* ---- stub agent-share (upload + raw) ---- */
const shareFs = new Map();
const stub = createServer((req, res) => {
  const u = new URL(req.url ?? '/', SHARE);
  if (req.method === 'POST' && u.pathname === '/api/upload') {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const dir = u.searchParams.get('dir') ?? '';
      if (!shareFs.has(dir)) { shareFs.set(dir, []); }
      const body = Buffer.concat(chunks);
      const boundary = /boundary=([^;]+)/.exec(req.headers['content-type'] ?? '')?.[1];
      const headEnd = body.indexOf('\r\n\r\n');
      const name = /filename="([^"]*)"/.exec(body.subarray(0, headEnd).toString('utf8'))?.[1];
      const end = body.lastIndexOf(Buffer.from(`\r\n--${boundary}--`));
      shareFs.get(dir).push({ name, bytes: body.subarray(headEnd + 4, end) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, saved: [`${dir}/${name}`] }));
    });
    return;
  }
  const path = decodeURIComponent(u.pathname);
  if (path.startsWith('/raw/')) {
    const ref = path.slice(5);
    const i = ref.lastIndexOf('/');
    const f = shareFs.get(ref.slice(0, i))?.find((x) => x.name === ref.slice(i + 1));
    if (!f) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': /\.png$/.test(f.name) ? 'image/png' : 'application/octet-stream', 'content-length': String(f.bytes.length) });
    return res.end(req.method === 'HEAD' ? undefined : f.bytes);
  }
  res.writeHead(404);
  res.end();
});
/* ---- stub room-assets app: the panel's view ---- */
const app = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.method === 'HEAD' ? undefined : '<!doctype html><title>Assets</title><body style="background:#111;color:#ccc">assets view</body>');
});

for (const p of [PORT, DEAD_BROKER_PORT, SHARE_PORT, ASSETS_PORT]) {
  await assertFree(p, 'room-attach.probe.mjs');
}
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-attach-probe-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null;
let browser = null;
let engineLog = '';
const seed = async (plan) => {
  const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
  return JSON.parse(r.out.trim().split('\n').pop());
};
const call = async (path, init = {}) => {
  const res = await fetch(BASE + path, { ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers || {}) } });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
};

try {
  await new Promise((r) => stub.listen(SHARE_PORT, HOST, r));
  await new Promise((r) => app.listen(ASSETS_PORT, HOST, r));
  await seed({ recipes: [{ id: 'rec-lead', name: 'Lead', projectDir: '/srv/x/leadp', vendor: 'cli-manager', agent: 'leadp', color: '#0dab49' }] });
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT),
      HARBOR_WB_HOST: HOST,
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
      HARBOR_WB_NODE: 'testnode',
      HARBOR_WB_CONFIG: join(tmpDir, 'config.json'),
      HARBOR_WB_AGENT_SHARE_URL: SHARE,
      HARBOR_WB_ROOM_ASSETS_URL: `http://${HOST}:${ASSETS_PORT}`,
      HARBOR_WB_ROOM_SCRATCH_DIR: join(tmpDir, 'room-scratch'),
    }),
  });
  engine.stdout.on('data', (d) => (engineLog += d));
  engine.stderr.on('data', (d) => (engineLog += d));
  const up = await until(async () => (await fetch(`${BASE}/health`)).ok, 30000);
  ok(up, `scratch engine is serving on ${PORT}`, up ? undefined : engineLog.slice(-400));
  if (!up) { throw new Error('engine never came up'); }

  const L1 = 'recipe:rec-lead';
  const post = await seed({
    sessions: [{ paneid: L1, recipe_id: 'rec-lead', vendor: 'cli-manager', agent: 'leadp', state: 'live' }],
    rooms: [{ name: 'Attach', seats: [{ handle: 'leadp', recipe_id: 'rec-lead', occupant: L1 }] }],
  });
  const R = post.rooms[0].id;

  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  const roomUrl = `${BASE}/room.html?room=${R}`;
  /* open the room and wait for STATE: the room drawn and the tray restored
     from the scratchpad (as many settled tiles as the engine holds) */
  const open = async (p = page) => {
    await p.goto(roomUrl, { waitUntil: 'domcontentloaded' });
    await until(() => p.evaluate(() => document.getElementById('roomName').textContent !== 'Workroom'));
    await until(() => p.evaluate(async (id) => {
      const n = (await (await fetch(`/api/rooms/${id}/scratch`)).json()).files.length;
      const tiles = [...document.querySelectorAll('#attTray .att-tile')];
      return tiles.length === n && tiles.every((t) => !t.classList.contains('up'));
    }, R), 8000);
  };
  const tileSel = (name) => `#attTray .att-tile[aria-label="${name}"]`;
  const tiles = (p = page) => p.$$eval('#attTray .att-tile', (els) => els.map((e) => ({ cls: e.className, name: e.getAttribute('aria-label'), h: Math.round(e.getBoundingClientRect().height), w: Math.round(e.getBoundingClientRect().width) })));
  const sendState = (p = page) => p.$eval('#sendBtn', (b) => ({ disabled: b.disabled, title: b.title }));
  const note = (p = page) => p.$eval('#attNote', (n) => (n.hidden ? '' : n.textContent));
  const scratch = () => page.evaluate(async (id) => (await (await fetch(`/api/rooms/${id}/scratch`)).json()), R);
  const settled = (p = page) => until(async () => (await tiles(p)).every((t) => !/\bup\b/.test(t.cls)));

  await open();

  /* 1. the + */
  const bar = await page.evaluate(() => {
    const r = (id) => document.getElementById(id).getBoundingClientRect();
    const a = r('attBtn');
    const i = r('input');
    const s = r('sendBtn');
    const cs = getComputedStyle(document.getElementById('attBtn'));
    return { aw: a.width, ah: a.height, left: a.right <= i.left, right: s.left >= i.right, tip: document.getElementById('attBtn').title, border: cs.borderTopWidth, trayHidden: document.getElementById('attTray').hidden };
  });
  ok(bar.aw === 40 && bar.ah === 40 && bar.left && bar.right, 'the + is a 40px square LEFT of the input; → stays on the right', bar);
  ok(bar.tip === 'Attach files (or paste, or drop)' && bar.border === '1px', 'a ghost (1px border) teaching the other two ways in', bar);
  ok(bar.trayHidden, 'no tray until the first file');

  /* 2. pick files -> tray above the input, aligned with the input. The
     images are held back so the pdf LANDS first: arrival order is not the
     order the person picked (the Windows first-run failure). */
  await page.route('**/scratch', async (route) => {
    if (route.request().method() === 'POST' && /hero-ref/.test(route.request().headers()['x-filename'] ?? '')) {
      await until(() => /attachment drafted \(2048 B\)/.test(engineLog), 5000); // the pdf has landed
    }
    await route.continue();
  });
  await page.setInputFiles('#attFile', [img('hero-ref-1.png'), img('hero-ref-2.png'), doc('hero-brief.pdf')]);
  await settled();
  await page.unroute('**/scratch');
  let t = await tiles();
  ok(t.length === 3 && t.every((x) => x.h === 64), 'three tiles, each 64px tall', t);
  ok(t[0].w === 64 && t[2].w === 208, 'images 64px squares, a file a 208px chip', t.map((x) => x.w));
  const geo = await page.evaluate(() => {
    const tr = document.getElementById('attTray').getBoundingClientRect();
    const first = document.querySelector('#attTray .att-tile').getBoundingClientRect();
    const i = document.getElementById('input').getBoundingClientRect();
    return { above: tr.bottom <= i.top, dx: Math.round(first.left - i.left) };
  });
  ok(geo.above && Math.abs(geo.dx) <= 1, 'the tray sits above the input, lined up with the input (not the +)', geo);
  ok(!(await sendState()).disabled, 'uploaded: Send is enabled');
  ok((await note()) === 'Sending adds an Assets panel to this room.', 'a room with no Assets panel says so while drafting', await note());
  ok((await scratch()).files.length === 3, 'the three are in the server scratchpad');
  ok([...shareFs.values()].flat().length === 0, 'nothing is in the room assets yet');
  await shot(page, '1-tray');

  /* 3. ✕ removes; reload restores the rest with the text */
  await page.click(`${tileSel('hero-ref-2.png')} .att-x`);
  await until(async () => (await scratch()).files.length === 2);
  ok((await tiles()).length === 2 && (await scratch()).files.length === 2, '✕ removes the tile AND the scratchpad file');
  await page.fill('#input', 'here are the refs for the hero, and the brief');
  await until(() => page.evaluate(async (id) => (await (await fetch(`/api/rooms/${id}/draft`)).json()).text === 'here are the refs for the hero, and the brief', R));
  await open();
  t = await tiles();
  ok(t.length === 2 && t.every((x) => !/\bup\b|\bfail\b/.test(x.cls)), 'F5: the tiles come back as uploaded (no meters)', t);
  ok(t.map((x) => x.name).join() === 'hero-ref-1.png,hero-brief.pdf', '...in the order they were PICKED, though the pdf landed first', t.map((x) => x.name));
  ok((await page.inputValue('#input')) === 'here are the refs for the hero, and the brief', '...with the text draft');
  const thumb = await page.$eval('#attTray .att-tile.img img', (i) => ({ ok: i.complete && i.naturalWidth > 0, src: i.getAttribute('src') }));
  ok(thumb.ok && thumb.src.includes('/scratch/'), 'a restored image shows its thumbnail from the scratchpad', thumb);

  /* 4. keyboard: Delete removes, focus to the neighbour */
  await page.setInputFiles('#attFile', [doc('notes.pdf', 100)]);
  await settled();
  await page.focus(tileSel('hero-brief.pdf'));
  const held = await page.evaluate(() => {
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', repeat: true, bubbles: true, cancelable: true }));
    return document.querySelectorAll('#attTray .att-tile').length;
  });
  ok(held === 3, 'a HELD key (repeat) removes nothing more', held);
  await page.keyboard.press('Delete');
  await until(async () => (await tiles()).length === 2);
  const focus = await page.evaluate(() => ({ n: document.querySelectorAll('#attTray .att-tile').length, on: document.activeElement?.classList.contains('att-tile'), label: document.activeElement?.getAttribute('aria-label') }));
  ok(focus.n === 2 && focus.on && focus.label === 'notes.pdf', 'Delete on a focused tile removes THAT tile; focus moves to its neighbour', focus);
  await until(async () => (await scratch()).files.length === 2);
  ok((await scratch()).files.map((f) => f.name).join() === 'hero-ref-1.png,notes.pdf', '...and the engine lost exactly that file', (await scratch()).files.map((f) => f.name));

  /* 4b. ✕ WHILE THE UPLOAD IS IN FLIGHT: the tile never comes back.
     (a) the engine already stored it, its answer not yet back; (b) the
     request still held before it reached the engine. */
  for (const [label, stored] of [['the engine had already stored it', true], ['it had not reached the engine', false]]) {
    let letGo;
    const held = new Promise((r) => { letGo = r; });
    let reached = false;
    await page.route('**/scratch', async (route) => {
      if (route.request().method() !== 'POST') { return route.continue(); }
      try {
        if (stored) {
          const resp = await route.fetch(); // the engine stores it now
          reached = true;
          await held;
          await route.fulfill({ response: resp });
        } else {
          await held;
          await route.continue();
        }
      } catch { /* the page aborted it */ }
    });
    const nm = stored ? 'raced-stored.png' : 'raced-onwire.png';
    await page.setInputFiles('#attFile', [img(nm)]);
    await until(async () => (await tiles()).some((x) => x.name === `${nm}, uploading`));
    if (stored) {
      await until(() => reached);
      ok((await scratch()).files.some((f) => f.name === nm), '(a) the engine holds the file before the ✕, its answer held back');
    }
    await page.click(`#attTray .att-tile[aria-label="${nm}, uploading"] .att-x`);
    letGo();
    await until(async () => !(await tiles()).some((x) => x.name.startsWith(nm)) && !(await scratch()).files.some((f) => f.name === nm));
    await page.unroute('**/scratch');
    ok(!(await tiles()).some((x) => x.name.startsWith(nm)), `✕ mid-upload (${label}): the tile is gone`);
    await open();
    const names = (await scratch()).files.map((f) => f.name);
    ok(!(await tiles()).some((x) => x.name.startsWith(nm)) && !names.includes(nm), `...after a reload too, and GET scratch has no such file`, names);
  }

  /* 5. uploading: Send waits */
  let release;
  const gate = new Promise((r) => { release = r; });
  await page.route('**/scratch', async (route) => {
    if (route.request().method() === 'POST') { await gate; }
    await route.continue();
  });
  await page.setInputFiles('#attFile', [img('screen-rec.png')]);
  await until(async () => (await tiles()).some((x) => /\bup\b/.test(x.cls)));
  let s = await sendState();
  const meter = await page.$eval('#attTray .att-tile.up .att-m', (m) => ({ h: m.getBoundingClientRect().height, bg: getComputedStyle(m.firstElementChild).backgroundColor }));
  ok(s.disabled && s.title === 'Waiting for 1 upload', 'uploading: Send is disabled, "Waiting for 1 upload"', s);
  ok(meter.h === 3, 'a 3px meter in the tile\'s foot', meter);
  await page.press('#input', 'Enter');
  await sleep(300);
  ok((await page.inputValue('#input')).length > 0, 'Enter does nothing yet; the text stays');
  release();
  await settled();
  ok(!(await sendState()).disabled, 'the upload lands: Send is enabled');
  await page.unroute('**/scratch');

  /* 6. failed: the 413's reason, the note, Send held until removed */
  await page.route('**/scratch', (route) => (route.request().method() === 'POST'
    ? route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ error: 'the file is 30000000 bytes (max 26214400)', field: 'body' }) })
    : route.continue()));
  await page.setInputFiles('#attFile', [doc('walkthrough.mov', 500)]);
  await until(async () => (await tiles()).some((x) => /\bfail\b/.test(x.cls)));
  s = await sendState();
  const failTile = await page.$eval('#attTray .att-tile.fail', (el) => ({ reason: el.querySelector('.att-fn .s')?.textContent, border: getComputedStyle(el).borderTopColor, retry: !!el.querySelector('.att-retry') }));
  ok(failTile.reason === 'Over 25 MB limit' && failTile.retry, 'failed: the size line becomes the reason ("Over 25 MB limit") with a retry glyph', failTile);
  ok((await note()) === "1 file didn't upload: retry or remove it", 'the coral note', await note());
  ok(s.disabled && s.title === 'Retry or remove the failed file', 'Send stays disabled until it is resolved', s);
  await shot(page, '2-failed');
  await page.unroute('**/scratch');
  await page.click('#attTray .att-tile.fail .att-x');
  await until(async () => !(await sendState()).disabled);
  ok(!(await sendState()).disabled && (await note()) === 'Sending adds an Assets panel to this room.', 'removed: Send is enabled again');

  /* 7. paste: an image adds a tile, text stays text */
  const pasted = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    document.getElementById('input').dispatchEvent(ev);
    const dt2 = new DataTransfer();
    dt2.setData('text/plain', 'just words');
    const ev2 = new ClipboardEvent('paste', { clipboardData: dt2, bubbles: true, cancelable: true });
    document.getElementById('input').dispatchEvent(ev2);
    return { imageTaken: ev.defaultPrevented, textLeft: !ev2.defaultPrevented };
  }, PNG.toString('base64'));
  await settled();
  t = await tiles();
  ok(pasted.imageTaken && t.some((x) => /^Pasted image \d\d-\d\d\.png$/.test(x.name)), 'pasting an image adds a tile named "Pasted image HH-MM.png"', t.map((x) => x.name));
  ok(pasted.textLeft && t.length === 4, 'pasting text is left to the input (no tile)', t.length);

  /* 8. drag-over: the whole line column */
  const drag = await page.evaluate(async (b64) => {
    const line = document.getElementById('roomLine');
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'dropped.png', { type: 'image/png' }));
    line.querySelector('#lineScroll').dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    line.querySelector('#lineScroll').dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    const drop = line.querySelector('.rm-drop');
    const lr = line.getBoundingClientRect();
    const dr = drop.getBoundingClientRect();
    const cs = getComputedStyle(drop);
    const on = { cls: line.classList.contains('is-drag'), shown: cs.display !== 'none', inset: Math.round(dr.left - lr.left), dashed: cs.borderTopStyle, text: drop.textContent.replace(/\s+/g, ' ').trim() };
    line.dispatchEvent(new DragEvent('dragleave', { dataTransfer: dt, bubbles: true, relatedTarget: null }));
    const left = !line.classList.contains('is-drag');
    line.querySelector('#lineScroll').dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    line.querySelector('#lineScroll').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return { on, left, after: !line.classList.contains('is-drag') };
  }, PNG.toString('base64'));
  ok(drag.on.cls && drag.on.shown && drag.on.inset === 8 && drag.on.dashed === 'dashed', 'drag-over: a dashed outline inset 8px over the whole line column', drag.on);
  ok(drag.on.text === 'Drop to attach Nothing is shared until you Send', '"Drop to attach · Nothing is shared until you Send"', drag.on.text);
  ok(drag.left && drag.after, 'the outline leaves on drag-leave and on drop');
  await settled();
  ok((await tiles()).some((x) => x.name === 'dropped.png'), 'the drop adds the file');

  /* 9. the count cap: one note, no failure tiles */
  const before = (await tiles()).length;
  await page.setInputFiles('#attFile', Array.from({ length: 8 }, (_, i) => img(`extra-${i}.png`)));
  await settled();
  t = await tiles();
  ok(t.length === 10 && !t.some((x) => /\bfail\b/.test(x.cls)), `past 10 files (had ${before}, picked 8): 10 tiles, no failure tiles`, t.length);
  ok((await note()) === '10 files per message', 'one inline note says the cap', await note());
  const row = await page.$eval('#attTray', (el) => {
    const tops = new Set([...el.children].map((c) => Math.round(c.getBoundingClientRect().top)));
    const cs = getComputedStyle(el);
    return { rows: tops.size, wrap: cs.flexWrap, overflowX: cs.overflowX };
  });
  ok(row.rows === 1 && row.wrap === 'nowrap' && row.overflowX === 'auto', 'the row never wraps; it scrolls sideways when it overflows (phone below)', row);
  /* back to 6: three images the text refers to, plus the pdf */
  while ((await tiles()).length > 6) {
    const n = (await tiles()).length;
    await page.click('#attTray .att-tile:last-child .att-x');
    await until(async () => (await tiles()).length === n - 1);
  }
  await until(async () => (await scratch()).files.length === 6);

  /* 10. SEND */
  const sentNames = (await scratch()).files.map((f) => f.name);
  await page.click('#sendBtn');
  await until(async () => (await tiles()).length === 0);
  await until(() => page.evaluate(() => !!document.querySelector('#line .entry.k-attachment .entry-files') && [...document.querySelectorAll('#panelCells .cell .tt')].some((t) => t.textContent === 'Assets')));
  ok((await tiles()).length === 0 && (await page.$eval('#attTray', (el) => el.hidden)), 'sent: the tray empties');
  ok((await scratch()).files.length === 0, '...and so does the scratchpad');
  const folderFiles = [...shareFs.values()].flat().map((f) => f.name).sort();
  ok(JSON.stringify(folderFiles) === JSON.stringify([...sentNames].sort()), 'the files are in the room assets (the stub share)', folderFiles);
  const bubble = await page.evaluate(() => {
    const li = [...document.querySelectorAll('#line .entry.k-attachment')].pop();
    if (!li) { return null; }
    const imgs = [...li.querySelectorAll('.entry-att .att-img')];
    return {
      text: li.querySelector('.entry-body').textContent,
      imgs: imgs.length,
      sizes: imgs.map((b) => Math.round(b.getBoundingClientRect().width)),
      more: imgs[3]?.querySelector('.more')?.textContent ?? null,
      chips: [...li.querySelectorAll('.entry-att .att-file')].map((c) => ({ h: Math.round(c.getBoundingClientRect().height), n: c.querySelector('.n').textContent, top: c.getBoundingClientRect().top, left: Math.round(c.getBoundingClientRect().left) })),
      imgBottom: Math.max(...imgs.map((b) => b.getBoundingClientRect().bottom)),
      imgLeft: Math.round(Math.min(...imgs.map((b) => b.getBoundingClientRect().left))),
      roomRight: li.querySelector('.entry-att').getBoundingClientRect().right - Math.max(...imgs.map((b) => b.getBoundingClientRect().right)),
      receipt: li.querySelector('.entry-files')?.textContent,
      kindLabel: !!li.querySelector('.entry-kind'),
      html: li.innerText,
      srcs: imgs.map((b) => b.querySelector('img').getAttribute('src')),
      loaded: imgs.every((b) => b.querySelector('img').complete),
    };
  });
  ok(bubble && bubble.text === 'here are the refs for the hero, and the brief', 'the sent line carries the words', bubble?.text);
  ok(bubble && bubble.imgs === 4 && bubble.more === '+2' && bubble.sizes.every((w) => w === 120), 'images: 120px squares, 3 then a 4th with "+2" (5 images)', bubble);
  ok(bubble && bubble.chips.length === 1 && bubble.chips[0].h === 56 && bubble.chips[0].n === 'notes.pdf', 'files: 56px chips after the images', bubble?.chips);
  ok(bubble && bubble.chips.every((c) => c.top >= bubble.imgBottom && c.left === bubble.imgLeft), 'A2: the file chip sits on its OWN row: its top below the images\' bottom, flush left with them', bubble && { chips: bubble.chips, imgBottom: bubble.imgBottom, imgLeft: bubble.imgLeft, roomRight: bubble.roomRight });
  ok(bubble && bubble.roomRight >= 228, '...and that is the rule, not a squeeze: there was room for it beside them (>= 220 + gap)', bubble?.roomRight);
  ok(bubble && bubble.receipt === '6 files · in Assets', 'the receipt: "6 files · in Assets"', bubble?.receipt);
  ok(bubble && !/raw\/|8215|http:/.test(bubble.html) && bubble.srcs.every((u) => u.startsWith(`/api/rooms/${R}/assets/raw/`)), 'no raw reference in the human\'s view (thumbnails come through the engine)', bubble?.srcs);
  ok(bubble && !bubble.kindLabel, 'no "attachment" kind label: the thumbnails say it');
  const cell = await page.evaluate(() => {
    const c = [...document.querySelectorAll('#panelCells .cell')].find((x) => x.querySelector('.tt')?.textContent === 'Assets');
    return c ? { arrive: c.classList.contains('cell-arrive'), collapsed: c.classList.contains('collapsed') } : null;
  });
  await shot(page, '3-sent');
  ok(cell && !cell.collapsed, 'the Assets panel appeared in the rail, unfolded', cell);
  ok(cell?.arrive, '...with its one teal wash', cell);
  ok((await note()) === '', 'the "adds an Assets panel" note is gone');
  const agentLine = (await call(`/api/rooms/${R}/line?kind=attachment`)).body?.entries?.pop();
  const meta = JSON.parse(agentLine?.meta ?? '{}');
  ok(meta.attachments?.length === 6 && meta.attachments.every((a) => a.url.startsWith(`${SHARE}/raw/`)), 'an agent reading the line gets each file\'s Copy-reference URL', meta.attachments?.map((a) => a.url));

  /* 11. click a thumbnail -> preview column; "in Assets" -> the panel */
  const lastAtt = () => page.locator('#line .entry.k-attachment').last();
  await lastAtt().locator('.att-img').first().click();
  await until(() => page.evaluate(() => !document.getElementById('preview').hidden));
  const pv = await page.evaluate(() => ({ shown: !document.getElementById('preview').hidden, name: document.querySelector('#preview .pv-name')?.textContent, img: !!document.querySelector('#preview .pv-img img') }));
  ok(pv.shown && pv.name === 'hero-ref-1.png' && pv.img, 'a thumbnail opens that asset in the preview column', pv);
  await page.keyboard.press('Escape');
  await lastAtt().locator('.att-img').nth(3).click();
  await until(() => page.evaluate(() => document.querySelector('#preview .pv-name')?.textContent === '6 files'));
  const set = await page.evaluate(() => ({ name: document.querySelector('#preview .pv-name')?.textContent, n: document.querySelectorAll('#preview .att-set .att-img, #preview .att-set .att-file').length }));
  ok(set.name === '6 files' && set.n === 6, '"+2" opens the whole set', set);
  await page.keyboard.press('Escape');

  /* 12. a single image: larger, not cropped, never a speck (a 4x4 fixture) */
  await page.setInputFiles('#attFile', [{ name: 'this-one.png', mimeType: 'image/png', buffer: PNG4 }]);
  await settled();
  await page.fill('#input', 'this one');
  await page.press('#input', 'Enter');
  await until(() => page.evaluate(() => { const li = [...document.querySelectorAll('#line .entry.k-attachment')].pop(); const im = li?.querySelector('.att-img img'); return li?.querySelector('.entry-body')?.textContent === 'this one' && im?.complete && im.naturalWidth > 0; }));
  const one = await lastAtt().locator('.att-img').first().evaluate((b) => {
    const im = b.querySelector('img');
    const br = b.getBoundingClientRect();
    const ir = im.getBoundingClientRect();
    const probe = document.createElement('span');
    probe.style.color = 'var(--surface)';
    document.body.append(probe);
    const surface = getComputedStyle(probe).color;
    probe.remove();
    return { one: b.classList.contains('one'), w: br.width, h: br.height, fit: getComputedStyle(im).objectFit, natural: [im.naturalWidth, im.naturalHeight],
      img: [ir.width, ir.height], centre: [Math.abs((ir.left + ir.right) / 2 - (br.left + br.right) / 2), Math.abs((ir.top + ir.bottom) / 2 - (br.top + br.bottom) / 2)],
      bg: getComputedStyle(b).backgroundColor, surface };
  });
  ok(one.one && one.w <= 262 && one.h <= 172 && one.fit === 'contain', 'a single image shows larger (<= 260x170), uncropped', one);
  ok(one.natural[0] === 4 && one.natural[1] === 4 && one.w >= 120 && one.h >= 120 && one.w <= 260 && one.h <= 170, 'A1: a 4x4 single image renders in a >= 120x120 box, <= 260x170 (not a speck)', one);
  ok(one.img[0] >= 100 && one.img[1] >= 100 && one.centre[0] <= 1 && one.centre[1] <= 1 && one.bg === one.surface, 'A1: ...the picture scaled up into it (contain), centred on --surface', one);
  ok((await lastAtt().locator('.entry-files').textContent()) === '1 file · in Assets', '"1 file · in Assets"');
  const panels = (await call(`/api/rooms/${R}/panels`)).body?.panels ?? [];
  ok(panels.filter((p) => p.title === 'Assets').length === 1, 'still one Assets panel');

  /* 13. attachments only */
  await page.setInputFiles('#attFile', [doc('only.pdf', 64)]);
  await settled();
  await page.fill('#input', '');
  await page.click('#sendBtn');
  await until(() => page.evaluate(() => [...document.querySelectorAll('#line .entry.k-attachment')].pop()?.querySelector('.att-file .n')?.textContent === 'only.pdf'));
  const onlyBubble = await page.evaluate(() => { const li = [...document.querySelectorAll('#line .entry.k-attachment')].pop(); return { body: li.querySelector('.entry-body').textContent, bodyShown: getComputedStyle(li.querySelector('.entry-body')).display !== 'none' }; });
  ok(onlyBubble.body === '' && !onlyBubble.bodyShown, 'an empty input with a tile sends: the bubble is just the file', onlyBubble);

  ok(errors.length === 0, 'no page errors (desktop)', errors.slice(0, 3));
  const cookies = (await ctx.storageState()).cookies;
  await ctx.close();

  /* 14. PHONE at 390px */
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: { cookies, origins: [] } });
  const ph = await pctx.newPage();
  const perr = [];
  ph.on('pageerror', (e) => perr.push(String(e)));
  await open(ph);
  await ph.setInputFiles('#attFile', [...Array.from({ length: 6 }, (_, i) => img(`p-${i}.png`)), doc('phone-brief.pdf')]);
  await settled(ph);
  const pm = await ph.evaluate(() => {
    const r = (el) => el.getBoundingClientRect();
    const tiles = [...document.querySelectorAll('#attTray .att-tile')];
    const x = tiles[0].querySelector('.att-x');
    const hit = getComputedStyle(x, '::after');
    return {
      add: [r(document.getElementById('attBtn')).width, r(document.getElementById('attBtn')).height],
      send: [r(document.getElementById('sendBtn')).width, r(document.getElementById('sendBtn')).height],
      tileH: Math.round(r(tiles[0]).height),
      imgW: Math.round(r(tiles[0]).width),
      chipW: Math.round(r(tiles[tiles.length - 1]).width),
      x: Math.round(r(x).width),
      hitInset: hit.top,
      sw: document.scrollingElement.scrollWidth,
      cw: document.scrollingElement.clientWidth,
      bodySW: document.body.scrollWidth,
      trayScrolls: document.getElementById('attTray').scrollWidth > document.getElementById('attTray').clientWidth,
      accept: document.getElementById('attFile').getAttribute('capture'),
    };
  });
  ok(pm.add[0] === 44 && pm.add[1] === 44 && pm.send[0] === 44 && pm.send[1] === 44, 'phone: + and → are 44px', pm);
  ok(pm.tileH === 56 && pm.imgW === 56 && pm.chipW === 180 && pm.x === 24 && pm.hitInset === '-10px', 'phone: 56px tiles, 180px chips, a 24px ✕ with a 44px hit area', pm);
  ok(pm.sw <= pm.cw && pm.bodySW <= pm.cw && pm.trayScrolls, 'phone: no sideways page scroll; the tray scrolls itself', pm);
  await shot(ph, '4-phone-tray');
  await ph.setViewportSize({ width: 320, height: 700 });
  await sleep(300);
  const narrow = await ph.evaluate(() => {
    const t = (id) => Math.round(document.getElementById(id).getBoundingClientRect().bottom);
    return { a: t('attBtn'), i: t('input'), s: t('sendBtn'), sw: document.scrollingElement.scrollWidth, cw: document.scrollingElement.clientWidth };
  });
  ok(narrow.a === narrow.s && Math.abs(narrow.i - narrow.s) <= 1 && narrow.sw <= narrow.cw, '320px: +, input and → stay on one row; no sideways scroll', narrow);
  await ph.setViewportSize({ width: 390, height: 844 });
  await sleep(300);
  ok(pm.accept === null, 'phone: a plain multiple file input (no capture), so the OS offers library / camera / files');
  await ph.click('#sendBtn');
  await until(async () => (await tiles(ph)).length === 0);
  await until(() => ph.evaluate(() => [...document.querySelectorAll('#line .entry.k-attachment')].pop()?.querySelectorAll('.att-img').length === 4));
  const pb = await ph.evaluate(() => {
    const li = [...document.querySelectorAll('#line .entry.k-attachment')].pop();
    const imgs = [...li.querySelectorAll('.entry-att .att-img')];
    const chip = li.querySelector('.entry-att .att-file');
    return { n: imgs.length, w: Math.round(imgs[0].getBoundingClientRect().width), sw: document.scrollingElement.scrollWidth, cw: document.scrollingElement.clientWidth, more: imgs[3]?.querySelector('.more')?.textContent,
      chipTop: chip?.getBoundingClientRect().top ?? null, imgBottom: Math.max(...imgs.map((b) => b.getBoundingClientRect().bottom)) };
  });
  ok(pb.chipTop !== null && pb.chipTop >= pb.imgBottom, 'phone: the file chip is on its own row after the images', pb);
  ok(pb.n === 4 && pb.w === 100 && pb.more === '+3' && pb.sw <= pb.cw, 'phone: the sent bubble (100px thumbnails, "+3") fits the glass', pb);
  await shot(ph, '5-phone-sent');
  ok(perr.length === 0, 'no page errors (phone)', perr.slice(0, 3));
  await pctx.close();

  ok(!/hero-ref|hero-brief|walkthrough/.test(engineLog), 'no file name reaches the engine log');
} catch (e) {
  ok(false, `threw: ${e?.stack ?? e}`);
} finally {
  await browser?.close().catch(() => {});
  stub.closeAllConnections?.();
  stub.close();
  app.closeAllConnections?.();
  app.close();
  if (engine) {
    engine.kill('SIGKILL');
    await sleep(200);
  }
  rmSync(tmpDir, { recursive: true, force: true });
  if (failures) {
    console.log(`\nengine log (tail):\n${engineLog.split('\n').slice(-30).join('\n')}`);
  }
  console.log(`\nPASS ${passes}  FAIL ${failures}`);
  process.exit(failures ? 1 : 0);
}
