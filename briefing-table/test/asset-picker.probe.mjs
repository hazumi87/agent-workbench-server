/* ASSET PICKER in the room page [asset picker, Owner 2026-10-05]. MOCK ONLY.
 *
 *   node test/asset-picker.probe.mjs
 *   SHOTS=<dir> node test/asset-picker.probe.mjs    (also writes screenshots there)
 *
 * One fake tool app ("Studio", host_capabilities ["pick"], one panel verb
 * `add`) whose panel sends {panel:'pick'} on a click, against a scratch engine
 * with a STUB agent-share (20 room images) and a STUB asset library (25
 * images) on one stub server. Proves, in Chromium:
 *   - a pick WITHOUT a click is refused; over window.postMessage it is refused;
 *   - a click opens the picker: Room tab first, a 3x3 grid, only 9 loaded,
 *     a second page of 9 on scroll; Library tab: 9, then 9 more on scroll;
 *   - one tap answers {host:'picked', items:[...]} in the contract's shapes;
 *     x / Esc / backdrop answer cancelled; sources:['room'] shows no tabs;
 *   - the gate window: after a pick, the panel's next ONE action passes with
 *     no click (sent 7 s later, past the click's activation), the second does
 *     not; after a cancel nothing passes;
 *   - an app without the capability is told 'not declared';
 *   - phone (390): a bottom sheet.
 * Linux only. A PROBE, not in `npm test`. Engine P(364), dead broker P(365),
 * stub P(366). Never the real library or share. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(364);
const DEAD_BROKER_PORT = P(365);
const STUB_PORT = P(366);
const BASE = `http://127.0.0.1:${PORT}`;
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const TOKEN = 'probe-asset-picker-token';
const SHOTS = process.env.SHOTS || '';

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) { return v; }
    await sleep(150);
  }
}
if (process.platform !== 'linux') {
  console.log(`  skip  everything (${process.platform}: verifyEndpoint refuses every tool endpoint off Linux)`);
  process.exit(0);
}

/* ---- a coloured, distinguishable PNG (no dependency) ---- */
function crc32(buf) {
  let c;
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(i) {
  const W = 96, H = 96;
  const hue = (i * 47) % 360;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const o = y * (W * 3 + 1) + 1 + x * 3;
      const t = (x + y) / (W + H);
      const h = (hue + t * 60) % 360;
      const f = (n) => { const k = (n + h / 60) % 6; return Math.round(255 * (0.75 - 0.55 * Math.max(0, Math.min(k, 4 - k, 1)))); };
      raw[o] = f(5); raw[o + 1] = f(3); raw[o + 2] = f(1);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/* ---- the stub: agent-share + asset library on one server ---- */
const ROOM_N = 20;
const LIB_TOTAL = 25;
let shareFolder = null;
const stub = createServer((req, res) => {
  const u = new URL(req.url ?? '/', STUB);
  if (u.pathname === '/api/list') {
    if (u.searchParams.get('dir') !== shareFolder) { res.writeHead(404); return res.end('{}'); }
    const entries = [];
    for (let i = 0; i < ROOM_N; i++) {
      entries.push({ name: `room-${String(i).padStart(2, '0')}.png`, path: `${shareFolder}/room-${String(i).padStart(2, '0')}.png`, type: 'file', size: 400, mtime: 1000 + i });
    }
    entries.push({ name: 'notes.txt', path: `${shareFolder}/notes.txt`, type: 'file', size: 5, mtime: 5000 });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ dir: shareFolder, sig: 's', entries }));
  }
  if (u.pathname.startsWith('/raw/')) {
    const m = /room-(\d+)\.png$/.exec(decodeURIComponent(u.pathname));
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(m ? png(Number(m[1])) : 'text');
  }
  if (u.pathname === '/asset-management/library/api/assets') {
    const limit = Number(u.searchParams.get('limit'));
    const offset = Number(u.searchParams.get('offset'));
    const assets = [];
    for (let i = offset; i < Math.min(offset + limit, LIB_TOTAL); i++) { assets.push({ id: `lib-${i}`, label: `Library ${i}`, created_at: 9000 - i, category: 'image' }); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ assets, total: LIB_TOTAL, limit, offset }));
  }
  const t = /^\/asset-management\/library\/api\/assets\/lib-(\d+)\/thumb$/.exec(u.pathname);
  if (t) {
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    return res.end(png(100 + Number(t[1])));
  }
  res.writeHead(404); res.end('no');
});

/* ---- the panel: Pick sends {panel:'pick'}; Add sends the `add` action ---- */
const PORT_JS = 'var port = null; var heard = []; document.body.dataset.heard = "[]";' +
  'function note(d) { heard.push(d); document.body.dataset.heard = JSON.stringify(heard); }' +
  'window.addEventListener("message", function (e) {' +
  '  if (e.source !== parent || !e.data) return;' +
  '  if (e.data.host === "port" && e.ports && e.ports[0]) { if (!port) { port = e.ports[0]; window.__port = port; port.onmessage = function (m) { note(Object.assign({ via: "port" }, m.data)); }; } return; }' +
  '  if (e.data.host) note(Object.assign({ via: "window" }, e.data));' +
  '});';
const VIEW = '<!doctype html><title>v</title><body style="font:14px sans-serif"><p id="what">studio</p>' +
  '<button id="pick">+ Pick from assets</button> <button id="add">Add</button><script>' + PORT_JS +
  'document.getElementById("pick").onclick = function () { port.postMessage({ panel: "pick", kind: "image", sources: window.srcs || ["room", "library"], title: "Pick an image" }); };' +
  'document.getElementById("add").onclick = function () { port.postMessage({ panel: "action", name: "add", input: { what: "x" } }); };' +
  '</script>';
const STUB_APP = `
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
const VIEW = ${JSON.stringify(VIEW)};
let n = 0;
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const srv = createServer((req, res) => {
  const u = req.url ?? '';
  if (u.startsWith('/health')) return json(res, 200, { ok: true });
  if (u === '/__n') return json(res, 200, { n });
  if (req.method === 'GET' || req.method === 'HEAD') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(VIEW); }
  req.on('data', () => {}); req.on('end', () => { n += 1; json(res, 200, { ok: true }); });
});
srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; mkdirSync('status', { recursive: true }); writeFileSync('status/app.json', JSON.stringify({ pid: process.pid, port })); console.log('READY ' + port); });
`;
const children = [];
function startApp(path, root) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path], { cwd: root, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(proc);
    let out = '';
    const t = setTimeout(() => reject(new Error(`fake app did not start: ${out}`)), 10000);
    proc.stdout.on('data', (d) => { out += d; const m = /READY ([0-9]+)/.exec(out); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
    proc.stderr.on('data', (d) => (out += d));
  });
}

for (const p of [PORT, DEAD_BROKER_PORT, STUB_PORT]) { await assertFree(p, 'asset-picker.probe.mjs'); }
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-asset-picker-'));
const toolsDir = join(tmpDir, 'tools');
const tool = (slug, caps) => ({
  contract: 'tool/draft-0', name: slug, slug, version: '0.1.0', description: slug, access: 'shared',
  endpoint: { bind: '127.0.0.1', discover: 'status/app.json#port' },
  ...(caps ? { host_capabilities: ['pick'] } : {}),
  verbs: [{ name: 'add', class: 'mutate', panel: true, input: { what: 'string' }, call: { http: 'POST /rooms/:roomId/add' } }],
  panels: [{ title: slug, icon: 'image', view: 'GET /rooms/:roomId/view', scripts: true }],
});
const roots = {};
for (const [slug, caps] of [['studio', true], ['plain', false]]) {
  roots[slug] = join(toolsDir, slug);
  mkdirSync(roots[slug], { recursive: true });
  writeFileSync(join(roots[slug], 'tool.json'), JSON.stringify(tool(slug, caps), null, 2));
}
const APP = join(tmpDir, 'fake-app.mjs');
writeFileSync(APP, STUB_APP);
await startApp(APP, roots.studio);
await startApp(APP, roots.plain);
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

let cookieP = null;
async function call(path, opts = {}) {
  const headers = { cookie: await (cookieP ??= windowCookie(BASE, TOKEN)) };
  const init = { method: opts.method ?? (opts.json !== undefined ? 'POST' : 'GET'), headers };
  if (opts.json !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(opts.json); }
  const res = await fetch(BASE + path, init);
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
}

let engine = null;
let browser = null;
let engineLog = '';
try {
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'), HARBOR_WB_TOKEN: TOKEN,
      HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'), HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT), HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'), HARBOR_WB_NODE: 'testnode',
      HARBOR_WB_TOOLS_DIR: toolsDir, HARBOR_WB_ROOM_SCRATCH_DIR: join(tmpDir, 'scratch'),
      HARBOR_WB_AGENT_SHARE_URL: STUB, HARBOR_WB_LIBRARY_URL: `${STUB}/asset-management/library`,
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

  const R = (await call('/api/rooms', { json: { name: 'Picker Room' } })).body.id;
  shareFolder = (await call(`/api/rooms/${R}/assets/folder`)).body.folder;
  for (const slug of ['studio', 'plain']) {
    const reg = await call('/api/apps', { json: { root: roots[slug] } });
    if (reg.status !== 200) { throw new Error(`register ${slug}: ${JSON.stringify(reg)}`); }
    const add = await call(`/api/rooms/${R}/apps`, { json: { slug } });
    if (add.status !== 200) { throw new Error(`add ${slug}: ${JSON.stringify(add)}`); }
  }
  const panels = (await call(`/api/rooms/${R}/panels`)).body;
  const plist = Array.isArray(panels) ? panels : panels?.panels ?? [];
  const caps = Object.fromEntries(plist.map((p) => [p.title, p.host_caps ?? null]));
  ok(JSON.stringify(caps.studio) === '["pick"]' && !caps.plain, 'the engine projects host_caps ["pick"] for the app that declared it, none for the other', caps);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  await page.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
  const frameOf = async (title) => {
    const h = await page.waitForSelector(`.cell iframe[title="${title}"]`, { state: 'attached', timeout: 8000 }).catch(() => null);
    const f = await h?.contentFrame();
    await f?.waitForSelector('#pick', { timeout: 8000 }).catch(() => {});
    return f;
  };
  const fS = await frameOf('studio');
  const fP = await frameOf('plain');
  ok(!!fS && !!fP, 'both panels are drawn');
  await sleep(500);
  const heardOf = (f) => f.evaluate(() => JSON.parse(document.body.dataset.heard || '[]'));
  const picked = async (f, n0 = 0) => (await heardOf(f)).filter((m) => m.host === 'picked').slice(n0);
  const pickCount = async (f) => (await picked(f)).length;
  const open = () => page.evaluate(() => !!document.querySelector('.ap-scrim'));
  const shot = async (name, p = page) => { if (SHOTS) { await p.screenshot({ path: join(SHOTS, `picker-${name}.png`) }); } };
  const clickPick = async (f) => { await sleep(600); const n = await pickCount(f); await f.click('#pick'); return n; };
  const thumbs = () => page.evaluate(() => document.querySelectorAll('.ap-pane:not([hidden]) .ap-thumb').length);
  const imagesLoaded = () => page.evaluate(() => [...document.querySelectorAll('.ap-pane:not([hidden]) .ap-thumb img')].filter((i) => i.complete && i.naturalWidth > 0).length);

  /* ---- 1. no click: refused; window.postMessage: refused; undeclared: not declared ---- */
  await fS.evaluate(() => setTimeout(() => window.__port.postMessage({ panel: 'pick', kind: 'image', sources: ['room'] }), 6500));
  await sleep(7500);
  let r = (await picked(fS)).pop();
  ok(r?.via === 'port' && r.error === 'needs a click' && !(await open()), "a pick on the port WITHOUT a click: 'needs a click', nothing drawn", r);
  await fS.evaluate(() => parent.postMessage({ panel: 'pick', kind: 'image', sources: ['room'] }, '*'));
  await sleep(400);
  r = (await heardOf(fS)).filter((m) => m.via === 'window' && m.host === 'picked').pop();
  ok(/action port/.test(r?.error ?? '') && !(await open()), 'a pick over window.postMessage: refused, told to use the port', r);
  let n = await clickPick(fP);
  r = await until(async () => (await picked(fP, n))[0]);
  ok(r?.error === 'not declared' && !(await open()), "an app that did not declare the capability: 'not declared'", r);

  /* ---- 2. a click opens it: Room tab first, 9 loaded, a second page on scroll ---- */
  n = await clickPick(fS);
  ok(await until(open), 'a click opens the picker');
  await until(async () => (await imagesLoaded()) >= 9);
  const geo = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.ap-tab')].map((t) => [t.textContent, t.getAttribute('aria-selected')]);
    const card = document.querySelector('.ap-card');
    const th = [...document.querySelectorAll('.ap-pane:not([hidden]) .ap-thumb')].map((t) => t.getBoundingClientRect());
    const b = card.getBoundingClientRect();
    return { tabs, role: card.getAttribute('role'), modal: card.getAttribute('aria-modal'), title: document.querySelector('.ap-t')?.textContent,
      active: document.activeElement?.className, tag: document.activeElement?.tagName, w: b.width, left: b.left,
      square: th.every((t) => Math.abs(t.width - t.height) < 1), cols: new Set(th.map((t) => Math.round(t.left))).size, rows: new Set(th.map((t) => Math.round(t.top))).size };
  });
  ok(JSON.stringify(geo.tabs) === '[["Room","true"],["Library","false"]]', 'tabs: Room (selected) first, Library second', geo.tabs);
  ok(geo.role === 'dialog' && geo.modal === 'true' && geo.title === 'Pick an image', 'a role=dialog modal with the app\'s title', geo);
  ok(geo.active === 'ap-x' && geo.tag === 'BUTTON', 'focus on the cancel button, not a field', [geo.tag, geo.active]);
  ok((await thumbs()) === 9 && geo.cols === 3 && geo.rows === 3 && geo.square, 'a 3x3 grid of 9 square thumbs, nothing more loaded yet', geo);
  ok((await imagesLoaded()) === 9, 'all 9 thumbs decoded (the raw room images)');
  const firstTitle = await page.evaluate(() => document.querySelector('.ap-pane:not([hidden]) .ap-thumb').title);
  ok(firstTitle === 'room-19.png', 'newest first (room-19 leads)', firstTitle);
  await shot('1-room-1280');
  await page.evaluate(() => { const b = document.querySelector('.ap-b'); b.scrollTop = b.scrollHeight; });
  ok(await until(async () => (await thumbs()) === 18), 'scrolling to the end loads the next 9 (18 in all)', await thumbs());
  await until(async () => (await imagesLoaded()) === 18);
  await page.evaluate(() => { const b = document.querySelector('.ap-b'); b.scrollTop = b.scrollHeight; });
  ok(await until(async () => (await thumbs()) === 20), 'and the last 2 (20 images; the .txt is not offered)', await thumbs());
  await shot('2-room-scrolled-1280');

  /* ---- 3. Library tab: 9, then 9 more on scroll ---- */
  await page.click('.ap-tab:has-text("Library")');
  ok(await until(async () => (await thumbs()) === 9 && (await imagesLoaded()) === 9), 'Library tab: 9 thumbs through the engine proxy');
  const libFirst = await page.evaluate(() => document.querySelector('.ap-pane:not([hidden]) .ap-thumb').title);
  ok(libFirst === 'Library 0', 'newest first as the library lists them', libFirst);
  await shot('3-library-1280');
  await page.evaluate(() => { const b = document.querySelector('.ap-b'); b.scrollTop = b.scrollHeight; });
  ok(await until(async () => (await thumbs()) === 18), 'scrolling loads a second page (18)', await thumbs());
  await until(async () => (await imagesLoaded()) === 18);
  await shot('4-library-scrolled-1280');

  /* ---- 4. a tap picks (library shape), closes, answers; the gate window ---- */
  await page.click('.ap-pane:not([hidden]) .ap-thumb:nth-child(2)');
  ok(await until(async () => !(await open())), 'one tap closes the picker');
  r = await until(async () => (await picked(fS, n))[0]);
  ok(JSON.stringify(r?.items) === '[{"source":"library","library_id":"lib-1"}]' && r.via === 'port', "answered {host:'picked', items:[{source:'library', library_id}]}", r);
  /* Playwright's evaluate carries a user gesture (it would activate the frame), so the two actions are
     TIMERS set inside the page: they fire 6.0 s and 6.7 s after the call, when no activation is left,
     and the pick's 10 s window is still open for the first only */
  const a0 = (await heardOf(fS)).filter((m) => m.host === 'action-result').length;
  await fS.evaluate(() => {
    setTimeout(() => window.__port.postMessage({ panel: 'action', name: 'add', input: { what: 'a' } }), 6000);
    setTimeout(() => window.__port.postMessage({ panel: 'action', name: 'add', input: { what: 'b' } }), 6700);
  });
  await sleep(7600);
  const acts = (await heardOf(fS)).filter((m) => m.host === 'action-result').slice(a0);
  ok(acts[0]?.ok === true, 'the gate window: the next action 6 s after the pick passes with NO click', acts[0]);
  ok(acts[1]?.ok === false && acts[1].error === 'needs a click', "...and it is ONE action: the second is 'needs a click'", acts[1]);

  /* ---- 5. cancel opens nothing; x / Esc / backdrop answer cancelled; room-only has no tabs ---- */
  await fS.evaluate(() => { window.srcs = ['room']; });
  n = await clickPick(fS);
  ok(await until(open), 'reopened with sources [room]');
  ok((await page.evaluate(() => document.querySelectorAll('.ap-tab').length)) === 0, 'only the asked-for source: no tabs');
  await shot('5-room-only-1280');
  await page.click('.ap-x');
  r = await until(async () => (await picked(fS, n))[0]);
  ok(r?.cancelled === true && !r.items, "✕: {host:'picked', cancelled:true}", r);
  const b0 = (await heardOf(fS)).filter((m) => m.host === 'action-result').length;
  await fS.evaluate(() => setTimeout(() => window.__port.postMessage({ panel: 'action', name: 'add', input: { what: 'c' } }), 6000));
  await sleep(6800);
  const b1 = (await heardOf(fS)).filter((m) => m.host === 'action-result')[b0];
  ok(b1?.ok === false && b1.error === 'needs a click', 'after a cancel the window is NOT open: the action needs a click', b1);
  n = await clickPick(fS);
  await until(open);
  await page.keyboard.press('Escape');
  r = await until(async () => (await picked(fS, n))[0]);
  ok(r?.cancelled === true && !(await open()), 'Esc: cancelled, closed', r);
  n = await clickPick(fS);
  await until(open);
  await page.mouse.click(6, 6);
  r = await until(async () => (await picked(fS, n))[0]);
  ok(r?.cancelled === true && !(await open()), 'backdrop: cancelled, closed', r);
  n = await clickPick(fS);
  await until(open);
  await until(async () => (await thumbs()) === 9);
  await page.click('.ap-pane:not([hidden]) .ap-thumb:nth-child(1)');
  r = await until(async () => (await picked(fS, n))[0]);
  ok(JSON.stringify(r?.items) === '[{"source":"room","name":"room-19.png","type":"image/png"}]', "a room pick: {source:'room', name, type}", r);

  /* ---- 6. one picker at a time; focus trap ---- */
  await fS.evaluate(() => { window.srcs = ['room', 'library']; });
  n = await clickPick(fS);
  await until(open);
  await sleep(600);
  const k0 = await pickCount(fS);
  await fS.evaluate(() => window.__port.postMessage({ panel: 'pick', kind: 'image', sources: ['room'] })); // the evaluate carries a gesture
  r = await until(async () => (await picked(fS, k0))[0]);
  ok(r?.error === 'a picker is already open' && (await page.evaluate(() => document.querySelectorAll('.ap-scrim').length)) === 1, "a second pick while one is open: 'a picker is already open', still one picker", r);
  const stops = [];
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); stops.push(await page.evaluate(() => document.querySelector('.ap-card')?.contains(document.activeElement))); }
  ok(stops.every(Boolean), 'Tab cycles inside the picker (focus is trapped)', stops);
  await page.keyboard.press('Escape');
  await until(async () => !(await open()));

  /* ---- 7. phone: a bottom sheet ---- */
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await context.storageState(), hasTouch: true, isMobile: true });
  const pp = await phone.newPage();
  pp.on('pageerror', (e) => errors.push(`phone: ${e}`));
  await pp.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
  await pp.waitForSelector('#phAgents', { timeout: 8000 }).catch(() => {});
  await pp.click('#phLine').catch(() => {});
  await pp.click('#phStrip .ph-chip:has-text("studio")').catch(() => {});
  const lh = await pp.waitForSelector('iframe[title="studio"]:visible', { timeout: 8000 }).catch(() => null);
  const fPh = await lh?.contentFrame();
  await fPh?.waitForSelector('#pick', { timeout: 8000 }).catch(() => {});
  await sleep(600);
  await fPh?.tap('#pick').catch(() => fPh?.click('#pick'));
  ok(await until(() => pp.evaluate(() => !!document.querySelector('.ap-scrim'))), 'phone: a tap opens the picker');
  await until(() => pp.evaluate(() => [...document.querySelectorAll('.ap-pane:not([hidden]) .ap-thumb img')].filter((i) => i.complete && i.naturalWidth > 0).length === 9));
  const ph = await pp.evaluate(() => {
    const b = document.querySelector('.ap-card').getBoundingClientRect();
    const th = [...document.querySelectorAll('.ap-pane:not([hidden]) .ap-thumb')].map((t) => t.getBoundingClientRect());
    const x = document.querySelector('.ap-x').getBoundingClientRect();
    const se = document.scrollingElement;
    return { w: b.width, left: b.left, bottom: b.bottom, top: b.top, iw: innerWidth, ih: innerHeight, sw: se.scrollWidth, n: th.length,
      cols: new Set(th.map((t) => Math.round(t.left))).size, rows: new Set(th.map((t) => Math.round(t.top))).size, xw: x.width, xh: x.height,
      grab: getComputedStyle(document.querySelector('.ap-grab')).display, radius: getComputedStyle(document.querySelector('.ap-card')).borderTopLeftRadius };
  });
  ok(ph.w === ph.iw && ph.left === 0 && Math.abs(ph.bottom - ph.ih) <= 1 && ph.top > 0, 'phone: a full-width sheet docked at the bottom', ph);
  ok(ph.n === 9 && ph.cols === 3 && ph.rows === 3 && ph.sw <= ph.iw, 'phone: the 3x3 grid, no sideways scroll', ph);
  ok(ph.xw >= 44 && ph.xh >= 44 && ph.grab === 'block' && ph.radius === '14px', 'phone: a 44px cancel, the grab bar, the 14px sheet corners', ph);
  await shot('6-room-390', pp);
  await pp.click('.ap-tab:has-text("Library")');
  await until(() => pp.evaluate(() => document.querySelectorAll('.ap-pane:not([hidden]) .ap-thumb').length === 9));
  await sleep(600);
  await shot('7-library-390', pp);
  await pp.evaluate(() => { const b = document.querySelector('.ap-b'); b.scrollTop = b.scrollHeight; });
  ok(await until(() => pp.evaluate(() => document.querySelectorAll('.ap-pane:not([hidden]) .ap-thumb').length === 18)), 'phone: scrolling loads the second page');
  await sleep(600);
  await shot('8-library-scrolled-390', pp);
  await pp.tap('.ap-x').catch(() => pp.click('.ap-x'));
  ok(await until(() => pp.evaluate(() => !document.querySelector('.ap-scrim'))), 'phone: the cancel closes it');
  await phone.close();

  ok(errors.length === 0, 'no page errors', errors);
  await context.close();
} catch (e) {
  ok(false, 'probe crashed', String(e?.stack ?? e));
} finally {
  await browser?.close().catch(() => {});
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  stub.closeAllConnections?.();
  stub.close();
  if (engine) { engine.kill('SIGTERM'); await sleep(400); try { engine.kill('SIGKILL'); } catch { /* gone */ } }
  rmSync(tmpDir, { recursive: true, force: true });
}
console.log(failures === 0 ? '\nasset-picker.probe: PASS' : `\nasset-picker.probe: ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
