/* APP FULL PAGE, in a browser [ticket].
 *
 *   node test/room-app-page.probe.mjs [shotsdir]
 *
 * One fake tool app ("Studio": a rail view, a `full` page, a postsToRoom
 * `submit` verb) in a real room page against a scratch engine:
 *   - the cell has NO "Open full page" control until the app declares
 *     {panel:'page', enabled:true, path:'full', title:'Review'}; withdrawing
 *     ({enabled:false}) hides it; a phone-width window never shows it;
 *   - a click on the control opens /room-app.html?room=&panel=&path=full&title=Review
 *     as a new browser tab (outside a shell); the page frames the panel's own
 *     app at frameUrl + full with ?surface=window, the rail sandbox, and gives
 *     it a port: app-status then {host:'surface', kind:'window'};
 *   - the document title is "Review | Studio | <room>" and never starts with
 *     the room; "Back to room" links to the room;
 *   - an action from the full page posts the same room line as from the rail;
 *   - room-only asks are answered: dialog, note, open-page on the port;
 *     preview / compose over window.postMessage; copy works;
 *   - inside a shell (the room page in an iframe) the control sends
 *     {hwbOpenTab:{url, title, sessionId}} to the parent; a second click sends
 *     the same sessionId (the shell selects the tab it has);
 *   - {panel:'open-page'}: without a click 'needs a click'; with one it opens
 *     (answered ok), a bad path is 'bad path'; a held app 'needs-approval';
 *   - bad query (a path with '..', another room's panel) = a plain message,
 *     never a frame; the rail panel is still mounted and alive throughout.
 * Screenshots go to the shots dir. A PROBE, not in `npm test`. OWN scratch
 * engine P(334), DEAD broker P(335); the fake app takes an ephemeral port.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(334);
const DEAD_BROKER_PORT = P(335);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-app-page-token';
const SHOTS = process.argv[2] ?? join(REPO_ROOT, 'tmp-apptab-shots');
mkdirSync(SHOTS, { recursive: true });

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

let cookieP = null;
async function call(path, opts = {}) {
  const headers = { cookie: await (cookieP ??= windowCookie(BASE, TOKEN)) };
  const init = { method: opts.method ?? (opts.json !== undefined ? 'POST' : 'GET'), headers };
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.json);
  }
  const res = await fetch(BASE + path, init);
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
}
for (const p of [PORT, DEAD_BROKER_PORT]) {
  await assertFree(p, 'room-app-page.probe.mjs');
}

/* Both pages keep the FIRST port, record every host answer (port or window)
   in data-heard; the rail view declares its full page on its port. */
const PORT_JS = 'var port = null; var heard = []; document.body.dataset.heard = "[]";' +
  'function note(d) { heard.push(d); document.body.dataset.heard = JSON.stringify(heard); }' +
  'window.addEventListener("message", function (e) {' +
  '  if (e.source !== parent || !e.data) return;' +
  '  if (e.data.host === "port" && e.ports && e.ports[0]) {' +
  '    if (!port) { port = e.ports[0]; window.__port = port; port.onmessage = function (m) { note(Object.assign({ via: "port" }, m.data)); }; if (window.onport) window.onport(); }' +
  '    return;' +
  '  }' +
  '  if (e.data.host) note(Object.assign({ via: "window" }, e.data));' +
  '});' +
  'document.getElementById("act").onclick = function () { port.postMessage({ panel: "action", name: "submit", input: { text: document.getElementById("t").value } }); };' +
  'document.getElementById("dlg").onclick = function () { port.postMessage({ panel: "dialog", path: "full" }); };' +
  'document.getElementById("note").onclick = function () { port.postMessage({ panel: "note", op: "new" }); };' +
  'document.getElementById("openp").onclick = function () { port.postMessage({ panel: "open-page", path: window.openPath === undefined ? "full" : window.openPath, title: "Item" }); };' +
  'document.getElementById("prev").onclick = function () { parent.postMessage({ panel: "preview", item: { key: "k", type: "x", title: "t" } }, "*"); parent.postMessage({ panel: "compose", text: "hi" }, "*"); parent.postMessage({ panel: "copy", text: "copied text" }, "*"); };';
const BUTTONS = '<textarea id="t"></textarea> <button id="act">Act</button> <button id="dlg">Dlg</button> <button id="note">Note</button> <button id="openp">OpenPage</button> <button id="prev">Prev</button>';
const VIEW = '<!doctype html><title>v</title><p id="what">studio rail</p>' + BUTTONS +
  ' <button id="decl">Declare</button> <button id="wd">Withdraw</button><script>' + PORT_JS +
  'window.onport = function () { port.postMessage({ panel: "page", enabled: true, path: "full", title: "Review" }); };' +
  'document.getElementById("decl").onclick = function () { port.postMessage({ panel: "page", enabled: true, path: "full", title: "Review" }); };' +
  'document.getElementById("wd").onclick = function () { port.postMessage({ panel: "page", enabled: false }); };' +
  '</script>';
const FULL = '<!doctype html><title>f</title><p id="what">studio FULL</p><p id="loc"></p>' + BUTTONS + '<script>document.getElementById("loc").textContent = "x"; ' + PORT_JS + '</script>';

const STUB_SRC = `
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
const VIEW = ${JSON.stringify(VIEW)};
const FULL = ${JSON.stringify(FULL)};
let n = 0;
const gets = [];
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const srv = createServer((req, res) => {
  const u = req.url ?? '';
  if (u.startsWith('/health')) return json(res, 200, { ok: true });
  if (u === '/__n') return json(res, 200, { n, gets });
  const path = u.split('?')[0];
  if (req.method === 'GET' || req.method === 'HEAD') {
    gets.push(u);
    if (path.endsWith('/view')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(req.method === 'HEAD' ? undefined : VIEW); }
    if (path.endsWith('/full')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(req.method === 'HEAD' ? undefined : FULL); }
    res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('no');
  }
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    n += 1;
    let b = {};
    try { b = JSON.parse(raw || '{}'); } catch {}
    return json(res, 200, { ok: true, roomLine: { text: 'Said: ' + b.text } });
  });
});
srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port;
  mkdirSync('status', { recursive: true });
  writeFileSync('status/app.json', JSON.stringify({ pid: process.pid, port }));
  console.log('READY ' + port);
});
`;
const children = [];
function startApp(stubPath, root) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [stubPath], { cwd: root, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(proc);
    let out = '';
    let done = false;
    const t = setTimeout(() => !done && reject(new Error(`fake app in ${root} did not start: ${out}`)), 10000);
    proc.stdout.on('data', (d) => {
      out += d;
      const m = /READY ([0-9]+)/.exec(out);
      if (m && !done) { done = true; clearTimeout(t); resolve({ proc, port: Number(m[1]) }); }
    });
    proc.stderr.on('data', (d) => (out += d));
  });
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-app-page-'));
const dbPath = join(tmpDir, 'mapping.db');
const toolsDir = join(tmpDir, 'tools');
const tool = (description) => ({
  contract: 'tool/draft-0', name: 'Studio', slug: 'studio', version: '0.1.0', description, access: 'shared',
  endpoint: { bind: '127.0.0.1', discover: 'status/app.json#port' },
  verbs: [{ name: 'submit', class: 'mutate', panel: true, postsToRoom: true, input: { text: 'string' }, call: { http: 'POST /rooms/:roomId/submit' } }],
  panels: [{ title: 'Studio', icon: 'image', view: 'GET /rooms/:roomId/view', scripts: true }],
});
const root = join(toolsDir, 'studio');
mkdirSync(root, { recursive: true });
writeFileSync(join(root, 'tool.json'), JSON.stringify(tool('Studio.'), null, 2));
const STUB = join(tmpDir, 'fake-app.mjs');
writeFileSync(STUB, STUB_SRC);
const app = await startApp(STUB, root);
const appState = () => fetch(`http://127.0.0.1:${app.port}/__n`).then((r) => r.json());

let engine = null;
let browser = null;
let engineLog = '';
try {
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: dbPath, HARBOR_WB_TOKEN: TOKEN,
      HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'), HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT), HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'), HARBOR_WB_NODE: 'testnode',
      HARBOR_WB_TOOLS_DIR: toolsDir, HARBOR_WB_ROOM_SCRATCH_DIR: join(tmpDir, 'scratch'),
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

  const ROOM = 'Alpha-Platform Apps';
  const R = (await call('/api/rooms', { json: { name: ROOM } })).body.id;
  const R2 = (await call('/api/rooms', { json: { name: 'Other Room' } })).body.id;
  const reg = await call('/api/apps', { json: { root } });
  if (reg.status !== 200) { throw new Error(`register studio: ${JSON.stringify(reg)}`); }
  for (const id of [R, R2]) {
    const add = await call(`/api/rooms/${id}/apps`, { json: { slug: 'studio' } });
    if (add.status !== 200) { throw new Error(`add studio: ${JSON.stringify(add)}`); }
  }
  const panelOf = async (id) => (await call(`/api/rooms/${id}`)).body.panels.find((p) => p.app_slug === 'studio');
  const P1 = (await panelOf(R)).id;
  const P2 = (await panelOf(R2)).id;

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    const f = document.querySelector('form');
    (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
  }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  await page.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
  const cellH = await page.waitForSelector('.cell iframe[title="Studio"]', { state: 'attached', timeout: 8000 }).catch(() => null);
  const fRail = await cellH?.contentFrame();
  await fRail?.waitForSelector('#act', { timeout: 8000 }).catch(() => {});
  ok(!!fRail, 'the Studio panel is drawn in the rail');
  const heardOf = (f) => f.evaluate(() => JSON.parse(document.body.dataset.heard || '[]'));
  const ctl = () => page.locator('.cell[data-cell="' + P1 + '"] .cell-hpage');
  const ctlVisible = () => ctl().isVisible();

  /* ---- 1. declared on the port: the control appears ---- */
  ok(await until(ctlVisible), "the app declared {panel:'page'}: the cell shows 'Open full page'");
  ok((await ctl().getAttribute('title')) === 'Open full page', 'tooltip: Open full page');
  await page.screenshot({ path: join(SHOTS, 'apptab-1-room-control.png') });

  /* ---- 2. withdraw hides it; declare again shows it ---- */
  await sleep(600);
  await fRail.click('#wd');
  ok(await until(async () => !(await ctlVisible())), 'enabled:false withdraws: the control is hidden');
  await sleep(600);
  await fRail.click('#decl');
  ok(await until(ctlVisible), 'declared again: the control is back');

  /* ---- 3. a phone-width window never shows it ---- */
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(300);
  ok(!(await ctlVisible()), 'phone width (390): the control is not shown');
  await page.setViewportSize({ width: 1280, height: 800 });
  await sleep(300);
  ok(await ctlVisible(), 'desktop width again: it is shown');

  /* ---- 4. the click opens the full page as a new tab ---- */
  const popP = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
  await ctl().click();
  const full = await popP;
  ok(!!full, 'a new browser tab opened (outside a shell)');
  full.on('pageerror', (e) => errors.push(`full: ${e}`));
  const u = new URL(full.url());
  ok(u.pathname === '/room-app.html' && u.searchParams.get('room') === R && u.searchParams.get('panel') === P1 && u.searchParams.get('path') === 'full' && u.searchParams.get('title') === 'Review', 'URL: /room-app.html?room=&panel=&path=full&title=Review', full.url());
  const fh = await full.waitForSelector('iframe', { state: 'attached', timeout: 8000 }).catch(() => null);
  const fFull = await fh?.contentFrame();
  await fFull?.waitForSelector('#act', { timeout: 8000 }).catch(() => {});
  ok(!!fFull && (await fFull.evaluate(() => document.getElementById('what').textContent)) === 'studio FULL', "the full page frames the app's `full` view");
  const geo = await full.evaluate(() => {
    const f = document.querySelector('iframe');
    return { src: f.getAttribute('src'), sb: f.getAttribute('sandbox'), rp: f.getAttribute('referrerpolicy'), title: document.title, bar: document.getElementById('raTitle').textContent, back: document.getElementById('raBack').getAttribute('href') };
  });
  const railSrc = await cellH.getAttribute('src');
  ok(geo.src === `${railSrc}full?surface=window`, 'frame = the rail frameUrl + full, with ?surface=window', geo.src.slice(-30));
  ok(/allow-scripts/.test(geo.sb) && !/allow-same-origin|allow-top-navigation|allow-modals/.test(geo.sb) && geo.rp === 'no-referrer', "the rail's sandbox and referrer rules", geo.sb);
  ok(geo.title === `Review | Studio | ${ROOM}` && geo.bar === geo.title, 'document and header title: "Review | Studio | <room>"', geo.title);
  ok(!geo.title.startsWith(ROOM), 'never starts with the room name');
  ok(geo.back === `/room.html?room=${R}`, "'Back to room' links to the room", geo.back);
  const heard1 = await heardOf(fFull);
  ok(heard1[0]?.host === 'app-status' && heard1[0].actions === 'enabled' && heard1[0].via === 'port', 'first port message: app-status enabled', heard1[0]);
  ok(heard1[1]?.host === 'surface' && heard1[1].kind === 'window', "then {host:'surface', kind:'window'}", heard1[1]);
  await full.screenshot({ path: join(SHOTS, 'apptab-2-full-page.png') });

  /* ---- 5. the rail is untouched and alive ---- */
  ok(await fRail.evaluate(() => document.getElementById('what').textContent) === 'studio rail', 'the rail panel is still mounted');
  const railHeard = await heardOf(fRail);
  ok(railHeard.filter((m) => m.host === 'port').length === 0 && railHeard.some((m) => m.host === 'surface' && m.kind === 'rail'), 'the rail kept its one port (surface rail), not reloaded');

  /* ---- 6. an action from the full page, as from the rail ---- */
  const viaLines = (pg) => pg.evaluate(() => [...document.querySelectorAll('#line li.entry')]
    .filter((li) => li.querySelector('.entry-via'))
    .map((li) => ({ via: li.querySelector('.entry-via')?.textContent, body: li.querySelector('.entry-body')?.textContent })));
  const n0 = (await appState()).n;
  await fFull.fill('#t', 'from full');
  await fFull.click('#act');
  const ar = await until(async () => (await heardOf(fFull)).find((m) => m.host === 'action-result'));
  ok(ar?.ok === true && ar.name === 'submit' && ar.via === 'port', "action from the full page: {host:'action-result', ok:true} on its port", ar);
  ok((await appState()).n === n0 + 1, 'one upstream call');
  const L = await until(async () => { const x = await viaLines(page); return x.length && x; });
  ok(L && L[L.length - 1]?.via === 'via Studio' && L[L.length - 1]?.body === 'Said: from full', 'the room (in the other tab) got its line "via Studio"', L && L[L.length - 1]);

  /* ---- 7. room-only asks are answered ---- */
  await sleep(600);
  await fFull.click('#dlg');
  await fFull.click('#note');
  await fFull.click('#openp');
  await fFull.click('#prev');
  await sleep(700);
  const h2 = await heardOf(fFull);
  const find = (host) => h2.find((m) => m.host === host);
  ok(find('dialog-result')?.ok === false && find('dialog-result').error === 'not available in a full page', 'dialog: refused, "not available in a full page"', find('dialog-result'));
  ok(find('note')?.ok === false && find('note').op === 'new' && find('note').error === 'not available in a full page', 'note: refused', find('note'));
  ok(find('page-result')?.ok === false && find('page-result').error === 'already a full page', 'open-page: "already a full page"', find('page-result'));
  const un = h2.filter((m) => m.host === 'unavailable');
  ok(un.length === 2 && un.map((m) => m.panel).sort().join() === 'compose,preview' && un.every((m) => m.error === 'not available in a full page'), 'preview and compose over window.postMessage: {host:unavailable}', un);
  ok(await until(() => full.evaluate(() => document.getElementById('raToast').textContent === 'Copied')), 'copy works');
  const pn = await page.evaluate(() => document.querySelector('.rm-pv:not([hidden])') !== null && !document.querySelector('.rm-pv')?.hidden);
  ok(pn === false || pn === true, 'room preview untouched (informational)');
  await full.close();

  /* ---- 8. open-page from the rail app: gate + answers ---- */
  const resultOf = async (f, n) => (await heardOf(f)).filter((m) => m.host === 'page-result')[n];
  await sleep(600);
  await fRail.evaluate(() => setTimeout(() => window.__port.postMessage({ panel: 'open-page', path: 'full' }), 7000));
  await sleep(8000);
  let r = await resultOf(fRail, 0);
  ok(r?.ok === false && r.error === 'needs a click', "{panel:'open-page'} without a click: 'needs a click'", r);
  const pop2 = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
  await fRail.click('#openp');
  const full2 = await pop2;
  r = await resultOf(fRail, 1);
  ok(r?.ok === true && !!full2, 'with a click: page-result ok:true and a tab opened', r);
  const u2 = full2 ? new URL(full2.url()) : null;
  ok(u2?.searchParams.get('path') === 'full' && u2.searchParams.get('title') === 'Item', "its own title ('Item') and path", full2?.url());
  ok(full2 ? await until(async () => (await full2.title()) === `Item | Studio | ${ROOM}`) : false, 'tab title "Item | Studio | <room>"');
  await full2?.close();
  /* two asks inside one click: opening a tab uses the click up, so the second
     is 'needs a click' (a window.open consumes transient activation) */
  await sleep(600);
  await fRail.evaluate(() => { const b = document.getElementById('openp'); b.onclick = function () { port.postMessage({ panel: 'open-page', path: 'full' }); port.postMessage({ panel: 'open-page', path: 'full' }); }; });
  const pop3 = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
  await fRail.click('#openp');
  const full3 = await pop3;
  await sleep(500);
  const rs = (await heardOf(fRail)).filter((m) => m.host === 'page-result').slice(-2);
  ok(rs[0]?.ok === true && rs[1]?.ok === false && rs[1].error === 'needs a click', "two asks in one click (browser tab): the second is 'needs a click'", rs);
  await full3?.close();
  /* bad paths and title */
  const ask = async (msg) => {
    await sleep(600);
    const n = (await heardOf(fRail)).filter((m) => m.host === 'page-result').length;
    await fRail.evaluate((m) => { document.getElementById('openp').onclick = function () { port.postMessage(m); }; }, msg);
    await fRail.click('#openp');
    return until(async () => { const x = (await heardOf(fRail)).filter((m) => m.host === 'page-result'); return x.length > n && x[x.length - 1]; });
  };
  ok((await ask({ panel: 'open-page', path: '../x' }))?.error === 'bad path', "'..': bad path");
  ok((await ask({ panel: 'open-page', path: '/api/rooms' }))?.error === 'bad path', 'an absolute path: bad path');
  ok((await ask({ panel: 'open-page', path: 'full', title: 7 }))?.error === 'bad title', 'a non-string title: bad title');

  /* ---- 9. inside a shell: hwbOpenTab to the parent, same sessionId again ---- */
  const shellPage = await context.newPage();
  await shellPage.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await shellPage.evaluate((room) => {
    window.__tabs = [];
    window.addEventListener('message', (e) => { if (e.data && e.data.hwbOpenTab) { window.__tabs.push(e.data.hwbOpenTab); } });
    document.body.innerHTML = '<iframe id="rm" style="width:1280px;height:760px;border:0" src="/room.html?room=' + room + '"></iframe>';
  }, R);
  const rmf = await (await shellPage.waitForSelector('#rm', { timeout: 8000 })).contentFrame();
  const sCtl = rmf.locator('.cell[data-cell="' + P1 + '"] .cell-hpage');
  ok(await until(() => sCtl.isVisible()), 'in a shell iframe: the control shows');
  await sCtl.click();
  await sleep(400);
  await sCtl.click();
  await sleep(400);
  const tabs = await shellPage.evaluate(() => window.__tabs);
  ok(tabs.length === 2 && tabs[0].url === `/room-app.html?room=${R}&panel=${P1}&path=full&title=Review` && tabs[0].title === `Review | Studio | ${ROOM}`, 'hwbOpenTab {url, title} to the parent shell', tabs[0]);
  ok(tabs[0].sessionId === `room-app:${R}:${P1}:full` && tabs[1].sessionId === tabs[0].sessionId, 'the same sessionId on a repeat (the shell selects the open tab)', tabs.map((t) => t.sessionId));
  /* in a shell nothing consumes the click, so the rate gate answers 'too fast' */
  const pf = rmf.childFrames().find((x) => x.url().includes('/frame/'));
  await pf.waitForSelector('#openp');
  await pf.evaluate(() => { document.getElementById('openp').onclick = function () { port.postMessage({ panel: 'open-page', path: 'full' }); port.postMessage({ panel: 'open-page', path: 'full' }); }; });
  await sleep(600);
  await pf.click('#openp');
  await sleep(600);
  const rs2 = (await heardOf(pf)).filter((m) => m.host === 'page-result').slice(-2);
  ok(rs2[0]?.ok === true && rs2[1]?.ok === false && rs2[1].error === 'too fast', "in a shell, two asks in one click: the second is 'too fast'", rs2);
  await shellPage.close();

  /* ---- 10. bad addresses: a message, never a frame ---- */
  const msgOf = async (qs) => {
    const pg = await context.newPage();
    await pg.goto(`${BASE}/room-app.html?${qs}`, { waitUntil: 'domcontentloaded' });
    await sleep(900);
    const out = await pg.evaluate(() => ({ frame: !!document.querySelector('iframe'), msg: document.querySelector('.ra-msg')?.textContent ?? '', title: document.title }));
    await pg.screenshot({ path: join(SHOTS, `apptab-msg-${qs.length}.png`) });
    await pg.close();
    return out;
  };
  let m = await msgOf(`room=${R}&panel=${P1}&path=..%2Fx`);
  ok(!m.frame && m.msg !== '', "a path with '..': a message, no frame", m);
  m = await msgOf(`room=${R}&panel=${P2}&path=full`);
  ok(!m.frame && /no longer in/.test(m.msg), "another room's panel: refused, no frame", m);
  m = await msgOf(`room=${R}`);
  ok(!m.frame && m.msg !== '', 'no panel: a message', m);
  m = await msgOf(`room=nope&panel=${P1}`);
  ok(!m.frame && /No such room/.test(m.msg), 'unknown room: a message', m);
  m = await msgOf(`room=${R}&panel=zzz&path=full`);
  ok(!m.frame && /no longer in/.test(m.msg), 'a panel not in the room: a message', m);

  /* ---- 11. a held app: open-page 'needs-approval'; a new page shows a message ---- */
  writeFileSync(join(root, 'tool.json'), JSON.stringify(tool('Studio, changed.'), null, 2));
  await call('/api/apps');
  ok(await until(async () => (await heardOf(fRail)).some((m) => m.host === 'app-status' && m.actions === 'held'), 9000), 'the rail panel hears app-status held');
  ok((await ask({ panel: 'open-page', path: 'full' }))?.error === 'needs-approval', "a held app: open-page 'needs-approval'");
  m = await msgOf(`room=${R}&panel=${P1}&path=full`);
  ok(!m.frame && /waiting for approval/.test(m.msg), 'a held app: the full page is a message, not a frame', m);

  ok(errors.length === 0, 'no page errors', errors);
  await context.close();
} catch (e) {
  ok(false, 'probe crashed', String(e?.stack ?? e));
} finally {
  await browser?.close().catch(() => {});
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch { /* gone */ }
  }
  if (engine) {
    engine.kill('SIGTERM');
    await sleep(400);
    try { engine.kill('SIGKILL'); } catch { /* gone */ }
  }
  rmSync(tmpDir, { recursive: true, force: true });
}
console.log(failures === 0 ? '\nroom-app-page.probe: PASS' : `\nroom-app-page.probe: ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
