/* APP DIALOG, the room page's half [ticket].
 *
 *   node test/room-app-dialog.probe.mjs
 *
 * What only a browser can prove, against ONE fake tool app ("Studio", whose
 * `submit` verb declares postsToRoom):
 *   - {panel:'dialog'} on the action port WITHOUT a click: refused ('needs a
 *     click'), nothing drawn; over window.postMessage: refused, told to use
 *     the port;
 *   - a click: the modal opens (the app's name + the dialog title, a ✕), its
 *     frame is the panel's own app at frameUrl + path with the panel's sandbox
 *     and referrer rules and the proxy's CSP, it gets its OWN port (first
 *     message app-status), focus is on the ✕ (never a text field); the panel
 *     hears {host:'dialog-result', ok:true};
 *   - bad paths (absolute, protocol-relative, '..', encoded '..', the engine)
 *     are refused 'bad path', nothing drawn; a bad size is refused;
 *   - one at a time: a second request (from the panel, or from inside the
 *     dialog) is refused 'a dialog is already open';
 *   - ✕, Esc, a scrim click and {panel:'close-dialog'} each close it, and
 *     each time the panel hears {host:'dialog-closed'} on its port; the panel
 *     is never reloaded;
 *   - a form in the dialog submits a postsToRoom action with a click (one
 *     line "via Studio" in the room); the same without a click is refused;
 *   - phone (390 px): the dialog is a full-screen sheet, no sideways scroll;
 *   - held app: refused 'needs-approval'.
 *
 * Linux only: verifyEndpoint reads /proc, so off Linux no fake tool runs.
 * A PROBE, not in `npm test`. OWN scratch engine on P(300), DEAD broker
 * P(301); the fake app takes an ephemeral port. Temp table + tools dir,
 * childEnv() scrubbed, fabric + NATS off. No backslash typed in the pages.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(300);
const DEAD_BROKER_PORT = P(301);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-app-dialog-token';

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
  await assertFree(p, 'room-app-dialog.probe.mjs');
}

/* Both pages keep the FIRST port they are handed, count ports, and record
   every host answer (port or window) in data-heard. */
const PORT_JS = 'var port = null; var heard = []; var ports = 0; document.body.dataset.heard = "[]"; document.body.dataset.ports = "0";' +
  'function note(d) { heard.push(d); document.body.dataset.heard = JSON.stringify(heard); }' +
  'window.addEventListener("message", function (e) {' +
  '  if (e.source !== parent || !e.data) return;' +
  '  if (e.data.host === "port" && e.ports && e.ports[0]) {' +
  '    ports += 1; document.body.dataset.ports = String(ports);' +
  '    if (!port) { port = e.ports[0]; window.__port = port; port.onmessage = function (m) { note(Object.assign({ via: "port" }, m.data)); }; }' +
  '    return;' +
  '  }' +
  '  if (e.data.host) note(Object.assign({ via: "window" }, e.data));' +
  '});';
/* The panel: Open asks for a dialog (path/size overridable by window.dlgPath
   / window.dlgSize); Open twice asks again 700 ms later (past the rate gap,
   inside the click's activation). */
const VIEW = '<!doctype html><title>v</title><p id="what">studio</p>' +
  '<button id="open">Open</button> <button id="open2">Open twice</button><script>' + PORT_JS +
  'function ask() { var m = { panel: "dialog", path: window.dlgPath === undefined ? "form" : window.dlgPath, title: "Rate it" }; if (window.dlgSize) m.size = window.dlgSize; port.postMessage(m); }' +
  'document.getElementById("open").onclick = ask;' +
  'document.getElementById("open2").onclick = function () { ask(); setTimeout(ask, 700); };' +
  '</script>';
/* The dialog: a text box, Submit (a postsToRoom action), Close
   (close-dialog), and Another (asks for a second dialog). No autofocus. */
const FORM = '<!doctype html><title>f</title><p id="what">form</p>' +
  '<textarea id="t"></textarea> <button id="go">Submit</button> <button id="close">Close</button> <button id="dlg">Another</button><script>' + PORT_JS +
  'document.getElementById("go").onclick = function () { port.postMessage({ panel: "action", name: "submit", input: { text: document.getElementById("t").value } }); };' +
  'document.getElementById("close").onclick = function () { port.postMessage({ panel: "close-dialog" }); };' +
  'document.getElementById("dlg").onclick = function () { port.postMessage({ panel: "dialog", path: "form" }); };' +
  '</script>';

/* The FAKE app: VIEW at .../view, FORM at .../form, 404 for any other GET;
   a POST (submit) answers roomLine "Rated: <text>". */
const STUB_SRC = `
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
const VIEW = ${JSON.stringify(VIEW)};
const FORM = ${JSON.stringify(FORM)};
let n = 0;
const gets = [];
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const srv = createServer((req, res) => {
  const u = req.url ?? '';
  if (u.startsWith('/health')) return json(res, 200, { ok: true });
  if (u === '/__n') return json(res, 200, { n, gets });
  const path = u.split('?')[0];
  if (req.method === 'GET' || req.method === 'HEAD') {
    gets.push(path);
    if (path.endsWith('/view')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(req.method === 'HEAD' ? undefined : VIEW); }
    if (path.endsWith('/form')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(req.method === 'HEAD' ? undefined : FORM); }
    res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('no');
  }
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    n += 1;
    let b = {};
    try { b = JSON.parse(raw || '{}'); } catch {}
    return json(res, 200, { ok: true, roomLine: { text: 'Rated: ' + b.text } });
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

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-app-dialog-'));
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

  const R = (await call('/api/rooms', { json: { name: 'Dialog Room' } })).body.id;
  const reg = await call('/api/apps', { json: { root } });
  if (reg.status !== 200) { throw new Error(`register studio: ${JSON.stringify(reg)}`); }
  const add = await call(`/api/rooms/${R}/apps`, { json: { slug: 'studio' } });
  if (add.status !== 200) { throw new Error(`add studio: ${JSON.stringify(add)}`); }

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
  const fView = await cellH?.contentFrame();
  await fView?.waitForSelector('#open', { timeout: 8000 }).catch(() => {});
  ok(!!fView, 'the Studio panel is drawn');
  await sleep(500);
  const heardOf = (f) => f.evaluate(() => JSON.parse(document.body.dataset.heard || '[]'));
  const heard = () => heardOf(fView);
  const lastDialogResult = async () => (await heard()).filter((m) => m.host === 'dialog-result').pop();
  const closedCount = async () => (await heard()).filter((m) => m.via === 'port' && m.host === 'dialog-closed').length;
  const isOpen = () => page.evaluate(() => !!document.querySelector('.ad-scrim'));
  const dialogFrame = async () => {
    const h = await page.waitForSelector('.ad-scrim iframe', { state: 'attached', timeout: 8000 }).catch(() => null);
    const f = await h?.contentFrame();
    await f?.waitForSelector('#go', { timeout: 8000 }).catch(() => {});
    return f;
  };
  /* one click on Open (the rate gap first), then wait for the answer */
  const openOnce = async () => {
    await sleep(600);
    const n = (await heard()).filter((m) => m.host === 'dialog-result').length;
    await fView.click('#open');
    return until(async () => { const r = (await heard()).filter((m) => m.host === 'dialog-result'); return r.length > n && r[r.length - 1]; });
  };

  /* ---- 1. no click: refused; over window.postMessage: refused ---- */
  await fView.evaluate(() => setTimeout(() => window.__port.postMessage({ panel: 'dialog', path: 'form' }), 7000));
  await sleep(8000);
  let r = await lastDialogResult();
  ok(r?.via === 'port' && r.ok === false && r.error === 'needs a click', "{panel:'dialog'} on the port WITHOUT a click: ok:false 'needs a click'", r);
  ok(!(await isOpen()), '...and nothing is drawn');
  await fView.evaluate(() => parent.postMessage({ panel: 'dialog', path: 'form' }, '*'));
  await sleep(400);
  r = (await heard()).filter((m) => m.via === 'window' && m.host === 'dialog-result').pop();
  ok(r?.ok === false && /action port/.test(r.error ?? '') && !(await isOpen()), '{panel:dialog} over window.postMessage: refused, told to use the port', r);

  /* ---- 2. a click: it opens ---- */
  r = await openOnce();
  ok(r?.via === 'port' && r.ok === true, "a click on Open: {host:'dialog-result', ok:true} on the panel's port", r);
  ok(await isOpen(), 'the dialog is drawn');
  let fDlg = await dialogFrame();
  const geo = await page.evaluate(() => {
    const cell = document.querySelector('.cell iframe[title="Studio"]');
    const f = document.querySelector('.ad-scrim iframe');
    const card = document.querySelector('.ad-card');
    return {
      role: card?.getAttribute('role'), modal: card?.getAttribute('aria-modal'),
      app: document.querySelector('.ad-app')?.textContent, dt: document.querySelector('.ad-dt')?.textContent,
      x: !!document.querySelector('.ad-x svg'), cellSrc: cell?.getAttribute('src'), src: f?.getAttribute('src'),
      sb: f?.getAttribute('sandbox'), cellSb: cell?.getAttribute('sandbox'), rp: f?.getAttribute('referrerpolicy'),
      active: document.activeElement?.className, activeTag: document.activeElement?.tagName, md: card?.classList.contains('ad-md'),
    };
  });
  ok(geo.role === 'dialog' && geo.modal === 'true', 'a role=dialog, aria-modal card', [geo.role, geo.modal]);
  ok(geo.app === 'Studio' && geo.dt === 'Rate it' && geo.x, "the title bar: the app's name, the dialog's title, a ✕", [geo.app, geo.dt]);
  ok(!!geo.cellSrc && geo.src === `${geo.cellSrc}form?surface=dialog`, "the frame is the panel's OWN app: frameUrl + 'form' (the same proxy + token), with ?surface=dialog", geo.src?.slice(-28));
  ok(!/surface=/.test(geo.cellSrc ?? ''), 'the rail cell\'s frame carries no ?surface', geo.cellSrc?.slice(-20));
  ok(geo.sb === geo.cellSb && /allow-scripts/.test(geo.sb) && !/allow-same-origin/.test(geo.sb) && geo.rp === 'no-referrer', "the panel's sandbox + referrer rules, never allow-same-origin", geo.sb);
  const csp = await page.evaluate(async (u) => (await fetch(u)).headers.get('content-security-policy'), geo.src);
  ok(/^sandbox /.test(csp ?? '') && !/allow-same-origin/.test(csp ?? ''), "the proxy's CSP sandbox on the dialog's page", csp);
  ok(geo.active === 'ad-x' && geo.activeTag === 'BUTTON', 'focus is on the ✕, not a text field', [geo.activeTag, geo.active]);
  ok(geo.md, "no size: 'md'");
  const inner = await fDlg?.evaluate(() => ({ ports: Number(document.body.dataset.ports), heard: JSON.parse(document.body.dataset.heard), active: document.activeElement?.tagName }));
  ok(inner?.ports === 1 && inner.heard[0]?.host === 'app-status' && inner.heard[0].actions === 'enabled', "the dialog frame gets its OWN port; first message {host:'app-status', actions:'enabled'}", inner);
  ok(inner?.heard[1]?.host === 'surface' && inner.heard[1].kind === 'dialog' && inner.heard[1].via === 'port', "...then {host:'surface', kind:'dialog'} on that port (ticket seam)", inner?.heard[1]);
  const railSurface = (await heard()).find((m) => m.host === 'surface');
  ok(railSurface?.kind === 'rail' && railSurface.via === 'port', "the panel (rail cell) hears {host:'surface', kind:'rail'} on its port", railSurface);
  ok(inner?.active !== 'TEXTAREA', 'nothing focused the text box in the dialog', inner?.active);

  /* ---- 3. one at a time: from inside the dialog ---- */
  await fDlg.click('#dlg');
  const rin = await until(async () => (await heardOf(fDlg)).find((m) => m.host === 'dialog-result'));
  ok(rin?.ok === false && rin.error === 'a dialog is already open', "a second dialog asked from inside the dialog: 'a dialog is already open'", rin);
  ok((await page.evaluate(() => document.querySelectorAll('.ad-scrim').length)) === 1, '...still exactly one dialog');

  /* ---- 4. an action from the dialog: a click posts one line via Studio ---- */
  const viaLines = () => page.evaluate(() => [...document.querySelectorAll('#line li.entry')]
    .filter((li) => li.querySelector('.entry-via'))
    .map((li) => ({ via: li.querySelector('.entry-via')?.textContent, body: li.querySelector('.entry-body')?.textContent })));
  const before = (await viaLines()).length;
  let n0 = (await appState()).n;
  await fDlg.fill('#t', 'from the dialog');
  await fDlg.click('#go');
  const ar = await until(async () => (await heardOf(fDlg)).find((m) => m.host === 'action-result'));
  ok(ar?.via === 'port' && ar.ok === true && ar.name === 'submit', "a click on Submit in the dialog: {host:'action-result', ok:true} on the DIALOG's port", ar);
  ok((await appState()).n === n0 + 1, 'exactly one upstream call', (await appState()).n - n0);
  const L = await until(async () => { const x = await viaLines(); return x.length > before && x; });
  ok(L && L[L.length - 1]?.via === 'via Studio' && L[L.length - 1]?.body === 'Rated: from the dialog', 'one line in the room, "via Studio", the app\'s text', L && L[L.length - 1]);

  /* ---- 5. no click from the dialog (an action) or the panel (a dialog): refused ---- */
  n0 = (await appState()).n;
  const hd0 = (await heardOf(fDlg)).length;
  await fDlg.evaluate(() => setTimeout(() => window.__port.postMessage({ panel: 'action', name: 'submit', input: { text: 'late' } }), 7000));
  await sleep(8000);
  const late = (await heardOf(fDlg)).slice(hd0).find((m) => m.host === 'action-result');
  ok(late?.ok === false && late.error === 'needs a click' && (await appState()).n === n0, "an action from the dialog WITHOUT a click: 'needs a click', no upstream call", late);

  /* ---- 6. ✕ closes; the panel hears dialog-closed ---- */
  let c0 = await closedCount();
  await page.click('.ad-x');
  ok(await until(async () => !(await isOpen())), '✕ closes the dialog');
  ok(await until(async () => (await closedCount()) === c0 + 1), "the panel hears {host:'dialog-closed'} on its port (✕)", await closedCount() - c0);

  /* ---- 7. Esc closes ---- */
  r = await openOnce();
  ok(r?.ok === true && (await isOpen()), 'reopened');
  c0 = await closedCount();
  await page.keyboard.press('Escape');
  ok(await until(async () => !(await isOpen())), 'Esc closes the dialog');
  ok(await until(async () => (await closedCount()) === c0 + 1), '...and the panel hears dialog-closed (Esc)');

  /* ---- 8. a scrim click closes ---- */
  r = await openOnce();
  ok(r?.ok === true && (await isOpen()), 'reopened');
  c0 = await closedCount();
  await page.mouse.click(8, 8);
  ok(await until(async () => !(await isOpen())), 'a scrim click closes the dialog');
  ok(await until(async () => (await closedCount()) === c0 + 1), '...and the panel hears dialog-closed (scrim)');

  /* ---- 9. {panel:'close-dialog'} from the dialog closes ---- */
  r = await openOnce();
  fDlg = await dialogFrame();
  c0 = await closedCount();
  await fDlg.click('#close');
  ok(await until(async () => !(await isOpen())), "{panel:'close-dialog'} from the dialog closes it");
  ok(await until(async () => (await closedCount()) === c0 + 1), '...and the panel hears dialog-closed (close-dialog)');

  /* ---- 10. one at a time: from the panel (a second ask 700 ms later) ---- */
  await sleep(600);
  const nr = (await heard()).filter((m) => m.host === 'dialog-result').length;
  await fView.click('#open2');
  const two = await until(async () => { const x = (await heard()).filter((m) => m.host === 'dialog-result'); return x.length >= nr + 2 && x.slice(nr); });
  ok(two && two[0].ok === true && two[1].ok === false && two[1].error === 'a dialog is already open', "a second ask from the panel while one is open: 'a dialog is already open'", two);
  ok((await page.evaluate(() => document.querySelectorAll('.ad-scrim').length)) === 1, '...still exactly one dialog');
  await page.keyboard.press('Escape');
  await until(async () => !(await isOpen()));

  /* ---- 11. bad paths / a bad size: refused, nothing drawn ---- */
  const gets0 = (await appState()).gets.length;
  for (const [p, why] of [['../other/view', "'..'"], ['https://example.com/x', 'an absolute URL'], ['//example.com/x', 'protocol-relative'],
    ['/api/rooms', 'the engine (an absolute path)'], ['%2e%2e/view', "an encoded '..'"], ['', 'empty']]) {
    await fView.evaluate((x) => { window.dlgPath = x; }, p);
    r = await openOnce();
    ok(r?.ok === false && r.error === 'bad path' && !(await isOpen()), `refused: ${why} -> 'bad path', nothing drawn`, r);
  }
  await fView.evaluate(() => { window.dlgPath = undefined; window.dlgSize = 'xl'; });
  r = await openOnce();
  ok(r?.ok === false && r.error === 'bad size' && !(await isOpen()), "size 'xl': 'bad size'", r);
  ok((await appState()).gets.length === gets0, 'no refused request reached the app');
  await fView.evaluate(() => { window.dlgSize = 'lg'; });
  r = await openOnce();
  const lg = await page.evaluate(() => { const c = document.querySelector('.ad-card'); const b = c?.getBoundingClientRect(); return { lg: c?.classList.contains('ad-lg'), w: b?.width, h: b?.height }; });
  ok(r?.ok === true && lg.lg && lg.w > 1000, "size 'lg': the large card", lg);
  await page.click('.ad-x');
  await until(async () => !(await isOpen()));
  await fView.evaluate(() => { window.dlgSize = undefined; });

  /* ---- 12. closing changed nothing else: the panel was never reloaded ---- */
  const pv = await fView.evaluate(() => ({ ports: Number(document.body.dataset.ports), n: JSON.parse(document.body.dataset.heard).length }));
  ok(pv.ports === 1 && pv.n > 10, 'the panel kept its one port and its history (never reloaded)', pv);

  /* ---- 13. phone 390 px: a full-screen sheet, no sideways scroll ---- */
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await context.storageState(), hasTouch: true, isMobile: true });
  const pp = await phone.newPage();
  pp.on('pageerror', (e) => errors.push(`phone: ${e}`));
  await pp.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
  await pp.waitForSelector('#phAgents', { timeout: 8000 }).catch(() => {});
  await pp.click('#phLine').catch(() => {});
  await pp.click('#phStrip .ph-chip:has-text("Studio")').catch(() => {});
  const lh = await pp.waitForSelector('iframe[title="Studio"]:visible', { timeout: 8000 }).catch(() => null);
  const fPh = await lh?.contentFrame();
  await fPh?.waitForSelector('#open', { timeout: 8000 }).catch(() => {});
  await sleep(500);
  await fPh?.tap('#open').catch(() => fPh?.click('#open'));
  const phOpen = await until(() => pp.evaluate(() => !!document.querySelector('.ad-scrim iframe')));
  ok(phOpen, 'phone: a tap on Open opens the dialog');
  await sleep(400);
  const ph = await pp.evaluate(() => {
    const b = document.querySelector('.ad-card')?.getBoundingClientRect();
    const x = document.querySelector('.ad-x')?.getBoundingClientRect();
    const se = document.scrollingElement;
    return { w: b?.width, h: b?.height, left: b?.left, top: b?.top, iw: innerWidth, ih: innerHeight, sw: se.scrollWidth, bw: document.body.scrollWidth, xw: x?.width, xh: x?.height, xr: x?.right };
  });
  ok(ph.w === ph.iw && ph.left === 0 && ph.top === 0 && ph.h >= ph.ih - 1, 'phone: a full-screen sheet', ph);
  ok(ph.sw <= ph.iw && ph.bw <= ph.iw, 'phone: no horizontal scroll', ph);
  ok(ph.xw >= 44 && ph.xh >= 44 && ph.xr <= ph.iw, 'phone: the ✕ is a 44px target, on screen', ph);
  await pp.tap('.ad-x').catch(() => pp.click('.ad-x'));
  ok(await until(() => pp.evaluate(() => !document.querySelector('.ad-scrim'))), 'phone: ✕ closes it');
  await phone.close();

  /* ---- 14. a held app: refused 'needs-approval' ---- */
  writeFileSync(join(root, 'tool.json'), JSON.stringify(tool('Studio, changed.'), null, 2));
  await call('/api/apps'); // any read detects the change and holds it
  const held = await until(async () => (await heard()).some((m) => m.host === 'app-status' && m.actions === 'held'), 9000);
  ok(held, "the panel hears {host:'app-status', actions:'held'}");
  r = await openOnce();
  ok(r?.ok === false && r.error === 'needs-approval' && !(await isOpen()), "a held app: 'needs-approval', nothing drawn", r);

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
console.log(failures === 0 ? '\nroom-app-dialog.probe: PASS' : `\nroom-app-dialog.probe: ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
