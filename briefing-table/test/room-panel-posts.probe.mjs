/* PANEL ACTIONS POST TO THE ROOM, the browser's half [ticket].
 *
 *   node test/room-panel-posts.probe.mjs
 *
 * What only a browser can prove (desktop 1280x800), against a FAKE tool app
 * whose `submit` verb declares `"postsToRoom": true`:
 *   - the person types in the app's own panel and clicks Submit: exactly ONE
 *     line appears in the room line, on the person's side, "via Studio", with
 *     the app's text and its link; no second Send anywhere; the frame hears
 *     {host:'action-result', ok:true} with no warning; after a reload it is
 *     still exactly one line (the answer's entries + the live push de-dupe);
 *   - an oversize roomLine: the action still ok, the frame hears the warning,
 *     the cell toasts it, and NO line appears;
 *   - adding postsToRoom to another verb holds the app, and Settings → Apps'
 *     approval diff says 'Panel action "quiet" may post lines to rooms on your
 *     submit'.
 *   - [ticket] TO THE REQUESTER: a live seat @bee (seeded through the store)
 *     that studio posted a tool line FOR; the panel's Ask button runs `ask`
 *     ({"to": "requester", "data": true}), whose answer names @bee and carries
 *     data: the line is drawn "via Studio" and ADDRESSED ("→ @bee"), the data
 *     is nowhere on the page, and the line filter shows it under @bee and To
 *     me but not under the lead; the approval diff words an added object form
 *     ("…addressed to the agent that requested the work, with a data payload
 *     for agents").
 *
 * Linux only: verifyEndpoint reads /proc, so off Linux no fake tool runs.
 * A PROBE, not in `npm test`. OWN scratch engine on P(286), DEAD broker
 * P(287); the fake app takes an ephemeral port. Temp table + tools dir,
 * childEnv() scrubbed, fabric + NATS off.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const TSX_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
function runTsx(args, env) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [TSX_CLI, ...args], { cwd: join(dirname(fileURLToPath(import.meta.url)), '..'), env: childEnv(env) });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('exit', (code) => resolve({ code, out, err }));
  });
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(286);
const DEAD_BROKER_PORT = P(287);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-panel-posts-token';

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
  await assertFree(p, 'room-panel-posts.probe.mjs');
}

/* The panel: a text box and a Submit button that sends `submit` on the action
   port with the box's text; every host answer on the port is recorded. No
   backslash anywhere in it. */
const VIEW = '<!doctype html><title>v</title><p id="what">studio</p>' +
  '<textarea id="t"></textarea> <button id="go">Submit</button> <button id="ask">Ask</button><script>' +
  'var port = null; var heard = []; document.body.dataset.heard = "[]";' +
  'window.addEventListener("message", function (e) {' +
  '  if (e.source !== parent || !e.data) return;' +
  '  if (e.data.host === "port" && e.ports && e.ports[0] && !port) {' +
  '    port = e.ports[0]; port.onmessage = function (m) { heard.push(m.data); document.body.dataset.heard = JSON.stringify(heard); };' +
  '  }' +
  '});' +
  'document.getElementById("go").onclick = function () { port.postMessage({ panel: "action", name: "submit", input: { text: document.getElementById("t").value } }); };' +
  'document.getElementById("ask").onclick = function () { port.postMessage({ panel: "action", name: "ask", input: { text: document.getElementById("t").value } }); };' +
  '</script>';

/* The FAKE app: serves VIEW; `submit` answers roomLine "Rated: <text>" with a
   link to review/2, or a 1001-character text when the text is "BIG". */
const STUB_SRC = `
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
const VIEW = ${JSON.stringify(VIEW)};
let n = 0;
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const srv = createServer((req, res) => {
  const u = req.url ?? '';
  if (u.startsWith('/health')) return json(res, 200, { ok: true });
  if (u === '/__n') return json(res, 200, { n });
  if (req.method === 'GET' && u.split('?')[0].endsWith('/view')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(VIEW); }
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    n += 1;
    let b = {};
    try { b = JSON.parse(raw || '{}'); } catch {}
    if (u.split('?')[0].endsWith('/ask')) {
      return json(res, 200, { ok: true, roomLine: { text: 'Answered: ' + b.text, to: '@bee', data: { picked: [2, 7], marker: 'zz-data-marker' } } });
    }
    const text = b.text === 'BIG' ? 'x'.repeat(1001) : 'Rated: ' + b.text;
    return json(res, 200, { ok: true, roomLine: { text, links: [{ label: '#2 shoes', path: 'review/2' }] } });
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

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-panel-posts-'));
const dbPath = join(tmpDir, 'mapping.db');
const toolsDir = join(tmpDir, 'tools');
const VERBS = [
  { name: 'submit', class: 'mutate', panel: true, postsToRoom: true, input: { text: 'string' }, call: { http: 'POST /rooms/:roomId/submit' } },
  { name: 'quiet', class: 'mutate', panel: true, call: { http: 'POST /rooms/:roomId/quiet' } },
  { name: 'ask', class: 'mutate', panel: true, postsToRoom: { to: 'requester', data: true }, input: { text: 'string' }, call: { http: 'POST /rooms/:roomId/ask' } },
];
const tool = (verbs) => ({
  contract: 'tool/draft-0', name: 'Studio', slug: 'studio', version: '0.1.0', description: 'Studio.', access: 'shared',
  endpoint: { bind: '127.0.0.1', discover: 'status/app.json#port' }, verbs,
  panels: [{ title: 'Studio', icon: 'image', view: 'GET /rooms/:roomId/view', scripts: true }],
  links: { 'review/:n': { label: 'Review', view: 'GET /rooms/:roomId/review/:n' } },
});
const root = join(toolsDir, 'studio');
mkdirSync(root, { recursive: true });
writeFileSync(join(root, 'tool.json'), JSON.stringify(tool(VERBS), null, 2));
const STUB = join(tmpDir, 'fake-app.mjs');
writeFileSync(STUB, STUB_SRC);
const app = await startApp(STUB, root);
const appCalls = async () => (await (await fetch(`http://127.0.0.1:${app.port}/__n`)).json()).n;

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

  const R = (await call('/api/rooms', { json: { name: 'Posts Room' } })).body.id;
  ok((await call(`/api/rooms/${R}/seats`, { json: { project: 'auriga' } })).status === 200, 'setup: the room has a seat (the lead)');
  ok((await call('/api/apps', { json: { root } })).status === 200, 'setup: studio registered');
  ok((await call(`/api/rooms/${R}/apps`, { json: { slug: 'studio' } })).status === 200, 'setup: studio added to the room');

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
  const open = async () => {
    await page.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
    const h = await page.waitForSelector('.cell iframe[title="Studio"]', { state: 'attached', timeout: 8000 }).catch(() => null);
    const f = await h?.contentFrame();
    await f?.waitForSelector('#go', { timeout: 8000 }).catch(() => {});
    await sleep(500);
    return f;
  };
  let f = await open();
  ok(!!f, 'the Studio panel is drawn');
  const heard = () => f.evaluate(() => JSON.parse(document.body.dataset.heard || '[]'));
  const viaLines = () => page.evaluate(() => [...document.querySelectorAll('#line li.entry')]
    .filter((li) => li.querySelector('.entry-via'))
    .map((li) => ({
      side: li.classList.contains('by-user') ? 'user' : 'other', author: li.dataset.author, via: li.querySelector('.entry-via')?.textContent,
      body: li.querySelector('.entry-body')?.textContent, text: li.textContent, shown: li.style.display !== 'none',
    })));
  const composer = () => page.evaluate(() => document.querySelector('textarea#input, #composer textarea, textarea')?.value ?? '');

  /* ---- 1. type, click Submit: exactly one line, the person's, via Studio ---- */
  const before = (await viaLines()).length;
  await f.fill('#t', '4 rated, 3 up');
  await f.click('#go');
  await sleep(1200);
  let L = await viaLines();
  ok(L.length === before + 1, 'one click on Submit: exactly ONE new line in the room line', L.length - before);
  const l = L[L.length - 1];
  ok(l?.side === 'user' && l?.author === 'user', "it is the person's line (the user's side, author user)", l);
  ok(l?.via === 'via Studio' && l?.body === 'Rated: 4 rated, 3 up', 'it reads "via Studio" with the app\'s text', l);
  ok(/#2 shoes/.test(l?.text ?? ''), 'and carries its link', l?.text);
  let h = await heard();
  ok(h[h.length - 1]?.host === 'action-result' && h[h.length - 1]?.ok === true && h[h.length - 1]?.warning === undefined, "the frame hears {host:'action-result', ok:true}, no warning", h[h.length - 1]);
  ok((await composer()) === '', 'nothing waits in the composer: no second Send', await composer());

  /* ---- 2. a reload: still exactly one (answer + push de-duped) ---- */
  f = await open();
  L = await viaLines();
  ok(L.length === before + 1 && L.filter((x) => x.body === 'Rated: 4 rated, 3 up').length === 1, 'after a reload: still exactly one', L.length);

  /* ---- 3. an oversize roomLine: the action is ok, nothing posted, the person is told ---- */
  await sleep(600);
  const n0 = await appCalls();
  await f.fill('#t', 'BIG');
  await f.click('#go');
  await sleep(1200);
  L = await viaLines();
  h = await heard();
  ok((await appCalls()) === n0 + 1, 'the action ran (one upstream call)');
  ok(L.length === before + 1, 'an oversize roomLine: NO line posted', L.length - before);
  ok(h[h.length - 1]?.ok === true && /1001 characters/.test(h[h.length - 1]?.warning ?? ''), 'the frame hears ok:true with the warning', h[h.length - 1]);
  const toastText = await page.evaluate(() => [...document.querySelectorAll('.cell-toast')].map((t) => (t.hidden ? '' : t.textContent)).join(' | '));
  ok(/Studio: done/.test(toastText) && /nothing was posted/.test(toastText), 'and the cell toasts it', toastText);

  /* ---- 3b. [ticket] to the requester, with data: addressed, the data unseen ---- */
  const seeded = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify({
    recipes: [{ id: 'rec-bee', name: 'Bee', projectDir: '/srv/x/bee', vendor: 'claude-code', agent: 'bee' }],
    sessions: [{ paneid: 'recipe:rec-bee', recipe_id: 'rec-bee', vendor: 'claude-code', agent: 'bee', state: 'live' }],
  })], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  ok(seeded.code === 0, 'setup: a live pane for @bee (seeded through the store)', seeded.err.slice(-300));
  const bee = await call(`/api/rooms/${R}/seats`, { json: { recipe_id: 'rec-bee', handle: 'bee', occupant: 'recipe:rec-bee' } });
  ok(bee.status === 200, 'setup: @bee seated on its live pane', bee.body);
  const view = (await call(`/api/rooms/${R}`)).body;
  const beeSeat = view?.seats?.find((x) => x.handle === 'bee')?.id;
  const leadSeat = view?.room?.lead_seat;
  const ev = await fetch(`${BASE}/api/rooms/${R}/line`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'rating your 4 shoes', from: { paneid: 'recipe:rec-bee' }, tool: { slug: 'studio', for: '@bee' } }),
  });
  ok(ev.status === 200, "setup: studio's tool line FOR @bee (the evidence)", ev.status);
  f = await open();
  await f.fill('#t', 'shoes 2 and 7');
  await f.click('#ask');
  await sleep(1200);
  h = await heard();
  ok(h[h.length - 1]?.host === 'action-result' && h[h.length - 1]?.ok === true && h[h.length - 1]?.warning === undefined, 'Ask: ok, no warning', h[h.length - 1]);
  const asked = await page.evaluate(() => {
    const li = [...document.querySelectorAll('#line li.entry')].find((x) => x.querySelector('.entry-body')?.textContent === 'Answered: shoes 2 and 7');
    return li ? { via: li.querySelector('.entry-via')?.textContent, to: li.querySelector('.entry-target')?.textContent, side: li.classList.contains('by-user') ? 'user' : 'other' } : null;
  });
  ok(asked?.via === 'via Studio' && asked?.side === 'user', "the person's line, via Studio", asked);
  ok(asked?.to === String.fromCharCode(8594) + ' @bee', 'drawn ADDRESSED to @bee, like a person\'s @-addressed line', asked);
  const pageText = await page.evaluate(() => document.getElementById('line').textContent);
  ok(!pageText.includes('zz-data-marker') && !pageText.includes('picked'), 'the data payload is nowhere on the page (agents only)');
  const shownBodies = () => page.evaluate(() => [...document.querySelectorAll('#line > .entry')].filter((li) => getComputedStyle(li).display !== 'none').map((li) => li.querySelector('.entry-body')?.textContent ?? ''));
  const pick = async (who) => {
    await page.click('#filterBtn');
    await sleep(150);
    await page.click(`#filterMenu [data-who="${who}"]`);
    await sleep(200);
    await page.keyboard.press('Escape');
    await sleep(100);
    return shownBodies();
  };
  const ANS = 'Answered: shoes 2 and 7';
  ok((await pick(beeSeat)).includes(ANS), "the line filter: shown under @bee (the requester's view)");
  ok(!(await pick(leadSeat)).includes(ANS), '...NOT under the lead: it was never the lead\'s');
  ok((await pick('me')).includes(ANS), '...and under To me (the person wrote it)');
  await pick('');

  /* ---- 4. adding postsToRoom holds the app; Settings → Apps shows the permission ---- */
  const LATE = { name: 'late', class: 'mutate', panel: true, postsToRoom: { to: 'requester', data: true }, call: { http: 'POST /rooms/:roomId/late' } };
  writeFileSync(join(root, 'tool.json'), JSON.stringify(tool([VERBS[0], { ...VERBS[1], postsToRoom: true }, VERBS[2], LATE]), null, 2));
  await call('/api/apps'); // any read detects the change and holds it
  const sp = await context.newPage();
  sp.on('pageerror', (e) => errors.push(`settings: ${e}`));
  await sp.goto(`${BASE}/settings.html#apps`, { waitUntil: 'domcontentloaded' });
  await sp.waitForSelector('section[data-group="apps"][data-state="mounted"] .sa-app', { timeout: 9000 }).catch(() => {});
  await sleep(300);
  const row = await sp.evaluate(() => {
    const r = document.querySelector('#apps .sa-app[data-slug="studio"]');
    return r ? { chip: r.querySelector('.app-chip')?.textContent, diff: [...r.querySelectorAll('.sa-dl li')].map((li) => ({ text: li.textContent, cls: li.className })) } : null;
  });
  ok(row?.chip === 'Needs approval', 'studio is held: "Needs approval"', row?.chip);
  ok(row?.diff?.some((d) => d.text === 'Panel action "quiet" may post lines to rooms on your submit' && /warn/.test(d.cls)), 'the approval diff lists the new permission (a warning)', row?.diff);
  ok(row?.diff?.some((d) => d.text === 'Panel action "late" may post lines to rooms on your submit, addressed to the agent that requested the work, with a data payload for agents' && /warn/.test(d.cls)),
    '[ticket] ...and words an added object form: to the requester, with data', row?.diff);

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
console.log(failures === 0 ? '\nroom-panel-posts.probe: PASS' : `\nroom-panel-posts.probe: ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
