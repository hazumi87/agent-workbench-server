/* PANEL ACTIONS, the room page's half [ticket].
 *
 *   node test/room-panel-actions.probe.mjs
 *
 * What only a browser can prove (desktop 1280x800), against FAKE tool apps:
 *   - the ACTION PORT: each app panel frame is handed exactly one MessagePort
 *     on its first load; a non-app panel frame gets none;
 *   - no click, no action: an action on the port before any user activation
 *     is not forwarded ('needs a click'); {panel:'action'} over
 *     window.postMessage (from a frame or the page) is never forwarded;
 *   - a real click in the app's own frame -> exactly ONE upstream call (the
 *     real route and proxy; the person's cookie on the host's fetch, none of
 *     it on the app's call), and {host:'action-result', name, ok:true} on the
 *     port; two clicks inside 500 ms -> one call ('too fast');
 *   - another app's frame asking for acts' action -> no call anywhere;
 *   - an app error -> ok:false with the app's error, and the cell toast;
 *   - a frame that navigates ITSELF gets no new port, and its clicks forward
 *     nothing; a sandboxed frame fetching the route directly reaches nothing.
 *
 * Linux only: verifyEndpoint reads /proc, so off Linux no fake tool runs.
 * A PROBE, not in `npm test`. OWN scratch engine on P(254), DEAD broker
 * P(255); the fake apps take ephemeral ports. Temp table + tools dir,
 * childEnv() scrubbed, fabric + NATS off.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(254);
const DEAD_BROKER_PORT = P(255);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-panel-actions-token';

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  await assertFree(p, 'room-panel-actions.probe.mjs');
}

/* The page every fake panel serves (app or plain): it counts the action ports
   it is handed, records every host answer (port or window), and has two
   buttons that send an action on its port (on window.postMessage when it
   has none, to prove the host refuses that). No backslash anywhere in it. */
const VIEW = '<!doctype html><title>v</title><p id="what">view</p>' +
  '<button id="pin">pin</button> <button id="fail">fail</button><script>' +
  'var port = null; var heard = []; document.body.dataset.ports = "0"; document.body.dataset.heard = "[]";' +
  'function note(d) { heard.push(d); document.body.dataset.heard = JSON.stringify(heard); }' +
  'window.addEventListener("message", function (e) {' +
  '  if (e.source !== parent || !e.data) return;' +
  '  if (e.data.host === "port" && e.ports && e.ports[0]) {' +
  '    document.body.dataset.ports = String(Number(document.body.dataset.ports) + 1);' +
  '    if (!port) { port = e.ports[0]; window.__port = port; port.onmessage = function (m) { note(Object.assign({ via: "port" }, m.data)); }; }' +
  '    return;' +
  '  }' +
  '  if (e.data.host === "action-result") note(Object.assign({ via: "window" }, e.data));' +
  '});' +
  'function send(msg) { if (port) port.postMessage(msg); else parent.postMessage(msg, "*"); }' +
  'document.getElementById("pin").onclick = function () { send({ panel: "action", name: "pin", params: { id: 42 } }); };' +
  'document.getElementById("fail").onclick = function () { send({ panel: "action", name: "fail" }); };' +
  '</script>';

/* A plain (non-app) panel host: the same page, so it can say it got no port. */
const plain = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(req.method === 'HEAD' ? undefined : VIEW);
});
await new Promise((r) => plain.listen(0, '127.0.0.1', r));

/* A FAKE TOOL APP: its own process, cwd = the tool root. Serves VIEW at
   .../view (any query); every other non-/health request is recorded in
   calls (/__calls reads them). `.../fail` answers 409. */
const STUB_SRC = `
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
const calls = [];
const VIEW = ${JSON.stringify(VIEW)};
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const srv = createServer((req, res) => {
  const u = req.url ?? '';
  if (u.startsWith('/health')) return json(res, 200, { ok: true });
  if (u === '/__calls') return json(res, 200, calls);
  if (req.method === 'GET' && u.split('?')[0].endsWith('/view')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(VIEW); }
  calls.push({ method: req.method, url: u, cookie: req.headers.cookie ?? null });
  if (u.endsWith('/fail')) return json(res, 409, { ok: false, error: 'nope from the app' });
  return json(res, 200, { ok: true });
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
const callsOf = (a) => fetch(`http://127.0.0.1:${a.port}/__calls`).then((r) => r.json());

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-panel-actions-'));
const dbPath = join(tmpDir, 'mapping.db');
const toolsDir = join(tmpDir, 'tools');
const tool = (slug, name, verbs) => ({
  contract: 'tool/draft-0', name, slug, version: '0.1.0', description: `${name}.`, access: 'shared',
  endpoint: { bind: '127.0.0.1', discover: 'status/app.json#port' }, verbs,
  panels: [{ title: name, icon: 'tasks', view: 'GET /rooms/:roomId/view', scripts: true }],
});
function writeTool(slug, t) {
  const root = join(toolsDir, slug);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'tool.json'), JSON.stringify(t, null, 2));
  return root;
}
const ROOTS = {
  acts: writeTool('acts', tool('acts', 'Acts', [
    { name: 'pin', class: 'mutate', panel: true, call: { http: 'POST /rooms/:roomId/items/:id/pin' } },
    { name: 'fail', class: 'mutate', panel: true, call: { http: 'POST /rooms/:roomId/fail' } },
  ])),
  other: writeTool('other', tool('other', 'Other', [{ name: 'poke', class: 'mutate', panel: true, call: { http: 'POST /rooms/:roomId/poke' } }])),
};
const STUB = join(tmpDir, 'fake-app.mjs');
writeFileSync(STUB, STUB_SRC);
const acts = await startApp(STUB, ROOTS.acts);
const other = await startApp(STUB, ROOTS.other);

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

  const R = (await call('/api/rooms', { json: { name: 'Actions Room' } })).body.id;
  for (const [slug, root] of Object.entries(ROOTS)) {
    const r = await call('/api/apps', { json: { root } });
    if (r.status !== 200) { throw new Error(`register ${slug}: ${JSON.stringify(r)}`); }
    const a = await call(`/api/rooms/${R}/apps`, { json: { slug } });
    if (a.status !== 200) { throw new Error(`add ${slug}: ${JSON.stringify(a)}`); }
  }
  const pr = await call(`/api/rooms/${R}/panels`, { json: { title: 'Plain', url: `http://127.0.0.1:${plain.address().port}/plain/`, icon: 'tasks', scripts: true } });
  ok(pr.status === 200, 'setup: a plain (non-app) panel with scripts', pr.status);

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
  const frameOf = async (title) => {
    const h = await page.waitForSelector(`.cell iframe[title="${title}"]`, { state: 'attached', timeout: 8000 }).catch(() => null);
    const f = await h?.contentFrame();
    if (f) { await f.waitForSelector('#what, p', { timeout: 8000 }).catch(() => {}); }
    return f;
  };
  const fActs = await frameOf('Acts');
  const fOther = await frameOf('Other');
  const fPlain = await frameOf('Plain');
  ok(!!fActs && !!fOther && !!fPlain, 'the three panel frames are drawn');
  await sleep(400);
  const heard = (f) => f.evaluate(() => JSON.parse(document.body.dataset.heard || '[]'));
  const ports = (f) => f.evaluate(() => Number(document.body.dataset.ports));
  const upstream = async () => (await callsOf(acts)).length;

  /* ---- 1. the port: one, on the first load, app panels only ---- */
  ok((await ports(fActs)) === 1 && (await ports(fOther)) === 1, 'each APP frame got exactly ONE action port on its first load', [await ports(fActs), await ports(fOther)]);
  ok((await ports(fPlain)) === 0, 'a non-app panel frame gets no port', await ports(fPlain));

  /* ---- 2. no click: nothing is forwarded (no user activation) ----
     Playwright's evaluate() runs WITH a user gesture in Chromium, which
     activates the frame and the page for ~5 s. So the frame schedules the send
     on its own timer 7 s out, and nothing touches the page meanwhile: when it
     fires, nobody has clicked for 7 s. */
  let n0 = await upstream();
  await fActs.evaluate(() => setTimeout(() => window.__port.postMessage({ panel: 'action', name: 'pin', params: { id: 1 } }), 7000));
  await sleep(8000);
  let h = await heard(fActs);
  ok((await upstream()) === n0, 'an action on the port WITHOUT a click: nothing forwarded', (await upstream()) - n0);
  ok(h.some((x) => x.via === 'port' && x.ok === false && x.error === 'needs a click'), "the frame hears ok:false 'needs a click' on its port", h);
  await fActs.evaluate(() => parent.postMessage({ panel: 'action', name: 'pin', params: { id: 1 } }, '*'));
  await page.evaluate(() => window.postMessage({ panel: 'action', name: 'pin', params: { id: 1 } }, '*'));
  await sleep(500);
  h = await heard(fActs);
  ok((await upstream()) === n0, '{panel:action} over window.postMessage (frame or page): nothing forwarded');
  ok(h.some((x) => x.via === 'window' && x.ok === false && /action port/.test(x.error ?? '')), 'the frame is told to use its action port', h);

  /* ---- 3. a real click in the app's own frame: exactly one upstream call ---- */
  n0 = await upstream();
  await fActs.click('#pin');
  await sleep(800);
  let calls = await callsOf(acts);
  ok(calls.length === n0 + 1, "a click in the app's own frame: exactly ONE upstream call", calls.length - n0);
  const last = calls[calls.length - 1];
  ok(last?.method === 'POST' && last?.url === `/rooms/${R}/items/42/pin`, 'POST /rooms/<this room>/items/42/pin', last);
  ok(last?.cookie === null, "the person's cookie never reached the app", last?.cookie);
  h = await heard(fActs);
  ok(h[h.length - 1]?.via === 'port' && h[h.length - 1]?.name === 'pin' && h[h.length - 1]?.ok === true, "the frame hears {host:'action-result', name:'pin', ok:true} on its port", h[h.length - 1]);

  /* ---- 4. at most one per 500 ms per frame ---- */
  await sleep(600);
  n0 = await upstream();
  await fActs.click('#pin');
  await fActs.click('#pin');
  await sleep(800);
  h = await heard(fActs);
  ok((await upstream()) === n0 + 1, 'two clicks inside 500 ms: ONE upstream call', (await upstream()) - n0);
  ok(h.some((x) => x.ok === false && x.error === 'too fast'), "the second hears 'too fast'", h.slice(-2));

  /* ---- 5. another app's frame asks for acts' pin: refused by the engine ---- */
  await sleep(600);
  n0 = await upstream();
  const o0 = (await callsOf(other)).length;
  await fOther.click('#pin');
  await sleep(800);
  ok((await upstream()) === n0 && (await callsOf(other)).length === o0, "another app's frame (a click, its own port): no call on acts or on other");
  h = await heard(fOther);
  ok(h[h.length - 1]?.ok === false && /does not let its panel trigger/.test(h[h.length - 1]?.error ?? ''), "it hears ok:false (its app declares no 'pin')", h[h.length - 1]);

  /* ---- 6. an app error comes back on the port and in the cell ---- */
  await fActs.click('#fail');
  await sleep(800);
  h = await heard(fActs);
  const fr = h[h.length - 1];
  ok(fr?.via === 'port' && fr?.name === 'fail' && fr?.ok === false && /nope from the app/.test(fr?.error ?? ''), "an app 409: the frame hears ok:false with the app's error", fr);
  const toastText = await page.evaluate(() => [...document.querySelectorAll('.cell-toast')].map((t) => (t.hidden ? '' : t.textContent)).join(' | '));
  ok(/Acts: fail failed/.test(toastText) && /nope from the app/.test(toastText), 'and the cell shows it (the cell toast)', toastText);

  /* ---- 7. the frame navigates ITSELF: its port closes, it gets no new one ---- */
  await sleep(600);
  n0 = await upstream();
  await fActs.evaluate(() => { location.href = 'view?again=1'; });
  await sleep(1200);
  const fNav = await (await page.$('.cell iframe[title="Acts"]'))?.contentFrame();
  await fNav?.waitForSelector('#pin', { timeout: 5000 }).catch(() => {});
  ok(/again=1/.test(fNav?.url() ?? ''), 'the Acts frame is now on another page', fNav?.url());
  ok((await ports(fNav)) === 0, 'after its own navigation the frame is handed NO port', await ports(fNav));
  await fNav.click('#pin'); // no port: the page falls back to window.postMessage
  await sleep(800);
  ok((await upstream()) === n0, 'a click in the navigated frame: nothing forwarded', (await upstream()) - n0);

  /* ---- 8. the frame fetching the route directly, bypassing the host ---- */
  n0 = (await callsOf(acts)).length;
  const pid = (await call(`/api/rooms/${R}/panels`)).body.panels.find((p) => p.app_slug === 'acts').id;
  const direct = await fNav.evaluate(async (u) => {
    const out = [];
    for (const [ct, body] of [['application/json', '{"name":"pin","params":{"id":"5"}}'], ['text/plain', '{"name":"pin","params":{"id":"5"}}']]) {
      try {
        const r = await fetch(u, { method: 'POST', credentials: 'include', headers: { 'content-type': ct }, body });
        out.push(r.status);
      } catch (e) {
        out.push('blocked');
      }
    }
    return out;
  }, `${BASE}/api/rooms/${R}/panels/${pid}/action`);
  await sleep(300);
  ok((await callsOf(acts)).length === n0, 'a sandboxed frame posting to the route directly reaches nothing', direct);

  ok(errors.length === 0, 'no page errors', errors);
  await context.close();
} catch (e) {
  ok(false, 'probe crashed', String(e?.stack ?? e));
} finally {
  await browser?.close().catch(() => {});
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch { /* gone */ }
  }
  plain.close();
  if (engine) {
    engine.kill('SIGTERM');
    await sleep(400);
    try { engine.kill('SIGKILL'); } catch { /* gone */ }
  }
  rmSync(tmpDir, { recursive: true, force: true });
}
console.log(failures === 0 ? '\nroom-panel-actions.probe: PASS' : `\nroom-panel-actions.probe: ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
