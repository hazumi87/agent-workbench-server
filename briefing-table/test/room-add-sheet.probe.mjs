/* THE ROOM'S + SHEET and THE PANEL CELL MENU (the design system room-add-sheet-v1,
 * Owner 2026-09-28).
 *
 *   node test/room-add-sheet.probe.mjs
 *
 * What only a browser can prove:
 *   SHEET — one sheet, two segmented tabs (Agents | Apps; a LIFTED selected
 *   segment, no underline); a centred 560px card on desktop, a full-height
 *   sheet on a phone with 44px targets and no sideways scroll; the tabs work
 *   from the keyboard (arrows, Home/End); Esc closes and focus goes back to
 *   the +; a backdrop click does not close it.
 *   AGENTS — LIVE TABS and START FROM A PROJECT in one list; a ticked tab
 *   shows its dry-run @handle; a ticked project opens its @name field (@
 *   inside; the suggestion steps past taken handles) and a keeps-context
 *   select; ONE "Add N" counts both; Add = ONE assemble for the tabs, then
 *   POST seats + seats/:id/start per project; a failed start stays inline on
 *   its row (the seat stays never-started) and Add then only starts it;
 *   Options ▸ (Lead, Opening message) folded; "Can't join (N) ▸" folded.
 *   APPS — against the REAL engine routes (rooms/apps-engine), with a temp
 *   HARBOR_WB_TOOLS_DIR of tool.json fixtures and two fake tool apps (one
 *   with a controllable /bind): a row per app: 40px tile, name,
 *   2-line description, "panel: …" meta, the state dot + word; Add / Remove
 *   (+ Undo toast) / Move here… (alertdialog, Cancel default; the job-running
 *   409 turns it into Wait / Move anyway → force) / no-seat inline; two
 *   sections "In this room" / "Can be added", each row's registration chip,
 *   a "Settings ›" link (never Register or Approve: those are Settings → Apps
 *   [ticket]); a held app's panel still draws, with the rail badge.
 *   NEW ROOM — the manager's Assemble is the same sheet with the name above
 *   the tabs; an app Add there is remembered ("Adds with the room") and done
 *   once the room is made (POST /api/rooms when no live tab is ticked).
 *   PANEL MENU — the ⋯ on a panel header (shown on hover/focus), right-click,
 *   Shift+F10; the seat menu's surface: title row, items in a fixed order,
 *   disabled with a reason at the ends; Alt+Up/Down reorders (the engine's
 *   order changes); inline Rename (PATCH); Collapse; Remove + Undo (DELETE,
 *   then the panel is registered again); an APP panel's Remove calls DELETE
 *   .../apps/:slug.
 *
 * WebKit is not installed on this host, so the phone is Chromium at 390px,
 * isMobile + hasTouch, with screen.width faked to 390 (the other phone probes'
 * screen fake).
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(164), DEAD broker P(165),
 * a fake tool app on P(166) (health + views; also the plain panels' host), a
 * fake EXCLUSIVE tool app with /bind on P(167); temp table seeded through the
 * store, temp tools dir; childEnv()
 * scrubbed; fabric + NATS off; never Owner's data.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { P, assertFree, childEnv, windowCookie, roomUserWrite } from './_scratch.mjs';

/* The Apps half needs the engine to VERIFY each fake app's listener (app-endpoint.ts:
   /proc/net/tcp, same uid, the app's own pid and cwd), which refuses off Linux by
   design. room-apps.test is LINUX_ONLY for the same reason. */
if (process.platform !== 'linux') {
  console.log(`SKIP room-add-sheet.probe: ${process.platform}: the engine verifies app endpoints through /proc, Linux only (room-apps is LINUX_ONLY too)`);
  process.exit(0);
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(164);
const DEAD_BROKER_PORT = P(165);
const APP_PORT = P(166);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-add-sheet-token';
const SHOT = process.env.SHOTS_DIR || null; // SHOTS_DIR=<dir>: screenshots for review
const shot = async (p, name) => { if (SHOT) { await p.screenshot({ path: join(SHOT, `room-add-sheet-${name}.png`) }); } };

let failures = 0;
let passes = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; } else { passes += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DOT = String.fromCharCode(183); // the middle dot the sheet's subtitles and options use

let cookieP = null;
const userCookie = () => (cookieP ??= windowCookie(BASE, TOKEN));
async function call(path, opts = {}) {
  const method = opts.method ?? (opts.json !== undefined ? 'POST' : 'GET');
  const person = roomUserWrite(path, method, opts.json) || (method !== 'GET' && path.startsWith('/api/apps'));
  const headers = person ? { cookie: await userCookie() } : { authorization: `Bearer ${TOKEN}` };
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
for (const p of [PORT, DEAD_BROKER_PORT, APP_PORT]) {
  await assertFree(p, 'room-add-sheet.probe.mjs');
}

/* the plain panels' host (a registered panel, not an app): every path a tiny page */
const app = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(req.method === 'HEAD' ? undefined : '<!doctype html><title>stub</title><p>stub panel</p>');
});
await new Promise((r) => app.listen(APP_PORT, '127.0.0.1', r));

/* A FAKE TOOL APP (rooms/apps-sec: the engine verifies WHO listens before it
   sends its bearer or builds a panel): its OWN process, cwd = the tool root,
   an ephemeral port, status/app.json with its real pid + port (room-apps.test's
   pattern). /bind refuses as /__ctl says (noSeat; jobs = N unless force);
   /__calls reports the bind calls; any other path is a tiny page. */
const STUB_SRC = `
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
const state = { noSeat: false, jobs: 0, calls: [] };
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readJson = (req) => new Promise((r) => { let raw = ''; req.on('data', (d) => (raw += d)); req.on('end', () => { try { r(JSON.parse(raw || '{}')); } catch { r({}); } }); });
const srv = createServer(async (req, res) => {
  const u = req.url ?? '';
  if (u.startsWith('/health')) return json(res, 200, { ok: true });
  if (u === '/__calls') return json(res, 200, state.calls);
  if (u === '/__ctl' && req.method === 'POST') { Object.assign(state, await readJson(req)); return json(res, 200, { ok: true }); }
  if (u === '/bind' && req.method === 'POST') {
    const body = await readJson(req);
    state.calls.push(body);
    if (state.noSeat) return json(res, 409, { reason: 'no-seat' });
    if (state.jobs && !body.force) return json(res, 409, { reason: 'job-running', jobs: Array.from({ length: state.jobs }, (_, i) => ({ room_id: 'room-x', job_id: 'job-' + i })) });
    return json(res, 200, { ok: true, bound: true });
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(req.method === 'HEAD' ? undefined : '<!doctype html><p>app view</p>');
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
const ctl = (a, body) => fetch(`http://127.0.0.1:${a.port}/__ctl`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const bindCalls = async (a) => (await fetch(`http://127.0.0.1:${a.port}/__calls`)).json();

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-add-sheet-'));
const dbPath = join(tmpDir, 'mapping.db');
/* THE TOOLS DIR: tool.json fixtures (the engine's own shapes, room-apps.test) */
const toolsDir = join(tmpDir, 'tools');
const RUN = []; // roots whose fake app is started (the others are down: no status/app.json)
function writeTool(slug, tool, run) {
  const root = join(toolsDir, slug);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'tool.json'), JSON.stringify(tool, null, 2));
  if (run) {
    RUN.push(root);
  }
  return root;
}
const tool = (slug, name, x = {}) => ({
  contract: 'tool/draft-0', name, slug: x.slug ?? slug, version: '0.1.0', description: x.description ?? `${name}.`,
  access: x.access ?? 'shared', endpoint: { bind: '127.0.0.1', discover: 'status/app.json#port' },
  /* a view path per app: two apps on one port must not share a panel URL (the engine adopts a same-URL panel) */
  panels: [{ title: x.panel ?? name, icon: x.icon ?? 'list', view: `GET /${slug}/rooms/:roomId/view` }, ...(x.morePanels ?? [])],
  ...(x.bind ? { lifecycle: { bind: { http: 'POST /bind' } } } : {}),
  ...(x.jobs ? { jobs: true } : {}),
  ...(x.verbs ? { verbs: x.verbs } : {}),
  ...(x.needs ? { needs: x.needs } : {}),
  ...(x.moveNotes ? { move_notes: x.moveNotes } : {}),
});
/* Image Studio's stand-in speaks for itself (tool.json move_notes); one bad
   entry (over 140 chars) the engine must drop */
const STUDIO_NOTES = ['"The old room" keeps its history, favorites and budget.', 'This room starts with its own budget.', 'y'.repeat(141)];
const LONG = "A room's Vikunja tasks as a panel: add, flag, set status, unflag. Vikunja stays the system of record, and this description is deliberately long enough to need clamping to two lines in the row.";
const ROOTS = {
  'room-tasks': writeTool('room-tasks', tool('room-tasks', 'Room Tasks', { panel: 'Tasks', icon: 'tasks', description: LONG }), true),
  'room-assets': writeTool('room-assets', tool('room-assets', 'Room Assets', { panel: 'Assets', icon: 'assets' }), true),
  'image-studio': writeTool('image-studio', tool('image-studio', 'Image Studio', { access: 'exclusive', bind: true, jobs: true, icon: 'studio', moveNotes: STUDIO_NOTES }), true),
  canvas: writeTool('canvas', tool('canvas', 'Canvas', { access: 'exclusive' }), true),
  kiln: writeTool('kiln', tool('kiln', 'Kiln', { access: 'exclusive', bind: true })),
  forge: writeTool('forge', tool('forge', 'Forge', { access: 'exclusive', bind: true })),
  'room-voice-app': writeTool('room-voice-app', tool('room-voice-app', 'Room Voice', { panel: 'Voice', icon: 'voice' })),
  'changed-app': writeTool('changed-app', tool('changed-app', 'Changed App', { panel: 'Changed', verbs: [{ name: 'list', class: 'read' }], needs: { gpu: false } }), true),
  'legacy-app': writeTool('legacy-app', tool('legacy-app', 'Legacy App'), true),
};
const BLENDER = writeTool('blender-studio', tool('blender-studio', 'Blender Studio', { panel: 'Blender', icon: 'studio' }), true);
writeTool('page-monitor', tool('page-monitor', 'Page Monitor', { slug: 'not-page-monitor' }));
const STUB = join(tmpDir, 'fake-app.mjs');
writeFileSync(STUB, STUB_SRC);
const RUNNING = {};
for (const root of RUN) {
  RUNNING[root] = await startApp(STUB, root);
}
const studio = RUNNING[ROOTS['image-studio']];
/* Forge's app.json names a port its own process does NOT hold (this probe's
   panel host): the engine must refuse to verify it (endpoint-unverified) */
mkdirSync(join(ROOTS.forge, 'status'), { recursive: true });
writeFileSync(join(ROOTS.forge, 'status', 'app.json'), JSON.stringify({ pid: process.pid, port: APP_PORT }));
let engine = null;
let browser = null;
let engineLog = '';
const seed = async (plan) => {
  const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
  return JSON.parse(r.out.trim().split('\n').pop());
};

try {
  const recipe = (id, name, agent, dir) => ({ id, name, projectDir: `/srv/x/${dir ?? agent}`, vendor: 'claude-code', agent });
  await seed({
    recipes: [{ ...recipe('rec-ap', 'Alpha Platform', 'alpha-platform'), model: 'opus', effort: 'high' }, recipe('rec-bb', 'Kiosk', 'kiosk'), recipe('rec-zz', 'Zebra', 'zebra', 'zebra-dir'),
      recipe('rec-lv', 'Liveone', 'liveone'), recipe('rec-lt', 'Livetwo', 'livetwo'),
      { id: 'rec-sh', name: 'Plain Shell', projectDir: '/srv/x/sh', vendor: 'cli-manager', agent: null }],
  });
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: dbPath, HARBOR_WB_TOKEN: TOKEN,
      HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'), HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT), HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'), HARBOR_WB_NODE: 'testnode',
      HARBOR_WB_TOOLS_DIR: toolsDir,
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

  await seed({
    sessions: [
      { paneid: 'recipe:rec-lv', recipe_id: 'rec-lv', vendor: 'claude-code', agent: 'liveone', state: 'live' },
      { paneid: 'recipe:rec-lt', recipe_id: 'rec-lt', vendor: 'claude-code', agent: 'livetwo', state: 'live' },
      { paneid: 'recipe:rec-sh', recipe_id: 'rec-sh', vendor: 'cli-manager', agent: null, state: 'live' },
    ],
  });
  const post = await seed({ rooms: [{ name: 'Sheet Probe', seats: [{ handle: 'alpha-platform', recipe_id: 'rec-ap' }] }] });
  const R = post.rooms[0].id;
  /* three plain panels on the stub app (loopback is on the allow-list) */
  const panelIds = [];
  for (const t of ['Alpha', 'Beta', 'Notes']) {
    const r = await call(`/api/rooms/${R}/panels`, { json: { title: t, url: `http://127.0.0.1:${APP_PORT}/${t.toLowerCase()}/`, icon: t === 'Beta' ? 'assets' : 'tasks' } });
    panelIds.push(r.body?.panel?.id);
  }
  ok(panelIds.every(Boolean), 'setup: three panels registered through the engine', panelIds);
  const enginePanels = async () => ((await call(`/api/rooms/${R}/panels`)).body?.panels ?? []).filter((p) => !p.app_slug).map((p) => ({ id: p.id, title: p.title, order: p.order }));
  /* the catalog, registered by a person; memberships as the engine writes them */
  for (const [slug, root] of Object.entries(ROOTS)) {
    const r = await call('/api/apps', { json: { root } });
    if (r.status !== 200) { throw new Error(`register ${slug}: ${JSON.stringify(r)}`); }
  }
  const OTHER = (await call('/api/rooms', { json: { name: 'Alpha-Platform Apps' } })).body;
  for (const [rid, slug] of [[R, 'room-tasks'], [R, 'changed-app'], [OTHER.id, 'image-studio'], [OTHER.id, 'canvas']]) {
    const r = await call(`/api/rooms/${rid}/apps`, { json: { slug } });
    if (r.status !== 200) { throw new Error(`add ${slug}: ${JSON.stringify(r)}`); }
  }
  /* changed since its pin: a MUTATE verb, a panel and a need added (Approve must say so) */
  writeFileSync(join(ROOTS['changed-app'], 'tool.json'), JSON.stringify(tool('changed-app', 'Changed App', {
    panel: 'Changed', description: 'Its tool.json changed.', verbs: [{ name: 'list', class: 'read' }, { name: 'wipe', class: 'mutate' }],
    needs: { gpu: true }, morePanels: [{ title: 'Extra', icon: 'list', view: 'GET /changed-app/rooms/:roomId/extra' }],
  }), null, 2));
  /* registered BEFORE the engine kept a copy: no pinned text to compare */
  { const db = new Database(dbPath); db.prepare(`UPDATE tool_registry SET tool_json=NULL WHERE slug='legacy-app'`).run(); db.close(); }
  writeFileSync(join(ROOTS['legacy-app'], 'tool.json'), JSON.stringify(tool('legacy-app', 'Legacy App', { description: 'changed' }), null, 2));
  const cat = (await call('/api/apps')).body?.apps ?? [];
  ok(cat.length === 9 && cat.find((a) => a.slug === 'changed-app')?.status === 'held' && cat.find((a) => a.slug === 'legacy-app')?.status === 'held' && cat.find((a) => a.slug === 'room-voice-app')?.status === 'down',
    'setup: nine apps registered through the engine; two changed tool.json files are held; one is down', cat.map((a) => [a.slug, a.status, a.rooms.map((x) => x.name)]));
  ok(cat.find((a) => a.slug === 'image-studio')?.jobs === true && cat.find((a) => a.slug === 'canvas')?.jobs === false, 'the catalog passes tool.json "jobs" through (Image Studio true, Canvas false)');

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const calls = [];
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (req.method() !== 'GET' && (u.pathname.startsWith('/api/rooms') || u.pathname.startsWith('/api/apps'))) {
      let body = null;
      try { body = JSON.parse(req.postData() || 'null'); } catch { /* not json */ }
      calls.push({ m: req.method(), path: u.pathname, body });
    }
  });
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);

  await page.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
  await sleep(1500);

  const open = async (p = page) => {
    await p.click('#addBtn');
    await p.waitForSelector('.ras-sheet [role="tab"]', { timeout: 6000 });
    await sleep(250);
  };
  const sheetState = (p = page) => p.evaluate(() => {
    const s = document.querySelector('.ras-sheet');
    if (!s) { return null; }
    const go = s.querySelector('.ras-go');
    return {
      tab: s.querySelector('[role="tab"][aria-selected="true"]')?.id,
      go: go ? { text: go.textContent, disabled: go.disabled } : null,
      err: s.querySelector('.ras-ft .ras-err')?.textContent || '',
    };
  });

  /* ============================== 1. the sheet ============================== */
  await open();
  const geo = await page.evaluate(() => {
    const s = document.querySelector('.ras-sheet');
    const r = s.getBoundingClientRect();
    const tabs = [...s.querySelectorAll('[role="tab"]')];
    const cs = (e) => getComputedStyle(e);
    const sel = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
    const off = tabs.find((t) => t.getAttribute('aria-selected') !== 'true');
    return {
      role: s.getAttribute('role'), modal: s.getAttribute('aria-modal'), w: Math.round(r.width),
      cx: Math.round(r.left + r.width / 2), vw: innerWidth, tablist: !!s.querySelector('[role="tablist"]'),
      names: tabs.map((t) => t.textContent), selBg: cs(sel).backgroundColor, offBg: cs(off).backgroundColor,
      selBorder: [cs(sel).borderTopWidth, cs(sel).borderBottomWidth, cs(sel).borderTopColor, cs(sel).borderBottomColor],
      secs: [...s.querySelectorAll('.ras-sec')].map((x) => x.firstChild.textContent),
      focus: document.activeElement?.id,
    };
  });
  ok(geo.role === 'dialog' && geo.modal === 'true', 'the + opens ONE sheet: a modal dialog', geo);
  ok(geo.w === 560 && Math.abs(geo.cx - geo.vw / 2) <= 1, 'desktop: a centred 560px card', { w: geo.w, cx: geo.cx, vw: geo.vw });
  ok(geo.tablist && geo.names.length === 2 && /^Agents/.test(geo.names[0]) && /^Apps/.test(geo.names[1]), 'segmented tabs: Agents | Apps', geo.names);
  ok(geo.selBg !== geo.offBg && geo.selBg !== 'rgba(0, 0, 0, 0)', 'the selected segment is LIFTED (its own ground)', { sel: geo.selBg, off: geo.offBg });
  ok(geo.selBorder[0] === geo.selBorder[1] && geo.selBorder[2] === geo.selBorder[3], '...with a hairline all round, no underline', geo.selBorder);
  ok(geo.focus === 'rasTab-agents', 'focus lands on the selected tab', geo.focus);
  ok(geo.secs.includes('Live tabs') && geo.secs.includes('Start from a project'), 'Agents: LIVE TABS and START FROM A PROJECT in one list', geo.secs);
  const lists = await page.evaluate(() => ({
    panes: [...document.querySelectorAll('.ras-pane')].map((r) => r.dataset.paneid),
    recs: [...document.querySelectorAll('.ras-proj')].map((r) => r.dataset.recipe),
    cant: document.querySelector('.ras-cant button')?.textContent, cantOpen: !!document.querySelector('.ras-cant ul'),
    opts: document.querySelector('.ras-opt')?.textContent, optBody: !!document.querySelector('.ras-optbody'),
    a2: [...document.querySelectorAll('button')].some((b) => /isn't running/.test(b.textContent)),
    primaries: document.querySelectorAll('.ras-ft .ras-btn.pri').length,
  }));
  ok(JSON.stringify(lists.panes.sort()) === JSON.stringify(['recipe:rec-lt', 'recipe:rec-lv']), 'LIVE TABS = the engine\'s seatable tabs', lists.panes);
  ok(lists.recs.join(',') === 'rec-ap,rec-bb,rec-lv,rec-lt,rec-zz', 'START FROM A PROJECT = every seatable recipe, by name (the plain shell left out)', lists.recs);
  ok(/^Can't join \(1\)/.test(lists.cant || '') && !lists.cantOpen, '"Can\'t join (N) ▸" is folded at the bottom', lists.cant);
  ok(/^Options/.test(lists.opts || '') && !lists.optBody, 'Options ▸ is folded', lists.opts);
  ok(!lists.a2 && lists.primaries === 1, 'CUT: no "project that isn\'t running" link, ONE primary button', lists);

  /* 2. tick a live tab: its dry-run @handle */
  await page.click('.ras-pane[data-paneid="recipe:rec-lv"]');
  await sleep(900);
  let row = await page.evaluate(() => {
    const r = document.querySelector('.ras-pane[data-paneid="recipe:rec-lv"]');
    return { checked: r.getAttribute('aria-checked'), hdl: r.querySelector('.ras-hdl')?.textContent, bg: getComputedStyle(r).backgroundColor, edge: getComputedStyle(r).borderTopColor };
  });
  ok(row.checked === 'true' && row.hdl === '@liveone', 'a ticked tab shows its dry-run @handle', row);
  let s = await sheetState();
  ok(s.go?.text === 'Add 1' && !s.go.disabled, 'the ONE action reads "Add 1"', s.go);

  /* 3. tick a project: the @name field with the suggestion, keeps-context */
  await page.click('.ras-proj[data-recipe="rec-ap"]');
  await sleep(200);
  const pr = await page.evaluate(() => {
    const r = document.querySelector('.ras-proj[data-recipe="rec-ap"]');
    const f = r.querySelector('.ras-fld');
    const at = f?.querySelector('.at');
    const inp = f?.querySelector('input');
    const rr = (e) => e.getBoundingClientRect();
    return {
      checked: r.getAttribute('aria-checked'), value: inp?.value, at: at?.textContent,
      atInside: at && rr(at).left >= rr(f).left && rr(at).right <= rr(inp).left + 0.5,
      fieldBorder: getComputedStyle(f).borderTopWidth, inputBorder: getComputedStyle(inp).borderTopWidth, w: Math.round(rr(f).width),
      how: [...r.querySelectorAll('.ras-how button')].map((b) => [b.textContent, b.getAttribute('aria-pressed')]),
      fresh: r.querySelector('.ras-fresh') ? { text: r.querySelector('.ras-fresh').textContent.trim(), on: r.querySelector('.ras-fresh input').checked } : null,
      sels: [...r.querySelectorAll('.ras-me select')].map((x) => [x.closest('label')?.querySelector('.ras-mlab')?.textContent ?? null, x.options[0].textContent, x.value]),
      keepsCtx: !!r.querySelector('select[aria-label="Keeps context"]'),
      sub: r.querySelector('.nm .b').textContent,
    };
  });
  ok(pr.checked === 'true' && pr.value === 'alpha-platform-2', 'a ticked project suggests @alpha-platform-2 (@alpha-platform is taken here)', pr);
  ok(pr.at === '@' && pr.atInside && pr.fieldBorder === '1px' && pr.inputBorder === '0px' && pr.w >= 180, '...the @ inside the bordered field, at least 180px', pr);
  ok(!pr.keepsCtx && JSON.stringify(pr.how) === JSON.stringify([['New', 'true'], ['Resume', 'false']]), '...[New | Resume], New chosen; no keeps-context select any more (auriga 2026-09-28)', pr.how);
  ok(pr.fresh && pr.fresh.text === 'forget between runs (fresh)' && pr.fresh.on === false, '...under New, one quiet box "forget between runs (fresh)", unchecked = persistent', pr.fresh);
  ok(JSON.stringify(pr.sels) === JSON.stringify([['Model', 'Recipe default (opus)', ''], ['Effort', 'Recipe default (high)', '']]),
    "...Model + Effort, each under its LABEL, the first option reading the recipe's value: Recipe default (opus) / (high)", pr.sels);
  ok(pr.sub === `alpha-platform ${DOT} starts a new session`, 'the row subtitle: "<folder> · starts a new session" (nothing differs from the recipe)', pr.sub);
  s = await sheetState();
  ok(s.go?.text === 'Add 2', '"Add 2" counts BOTH sections', s.go);

  /* 4. options */
  await page.click('.ras-opt');
  const ob = await page.evaluate(() => ({ lead: [...document.querySelectorAll('.ras-lead option')].map((o) => o.textContent), msg: document.querySelector('.ras-optbody .ras-link')?.textContent }));
  ok(ob.lead[0] === 'keep @alpha-platform' && ob.lead.includes('@liveone') && ob.lead.includes('@alpha-platform-2'), 'Options: Lead (keep the current lead, or any ticked one)', ob.lead);
  ok(/Opening message/.test(ob.msg || ''), '...and the Opening message', ob.msg);
  await shot(page, 'agents');
  await page.click('.ras-opt');

  /* 5. Add 2: ONE assemble, then add + start the project, IN VIEW */
  calls.length = 0;
  await page.evaluate(() => {
    window.__phases = [];
    new MutationObserver(() => {
      const ph = document.querySelector('.ras-proj[data-recipe="rec-ap"] .ras-phase');
      const t = ph ? ph.textContent : null;
      if (t && window.__phases[window.__phases.length - 1] !== t) { window.__phases.push(t); }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.route('**/api/rooms/*/seats/*/start', async (route) => { await sleep(900); await route.continue(); });
  await page.click('.ras-go');
  await sleep(500);
  const mid = await page.evaluate(() => ({ open: !!document.querySelector('.ras-scrim'), ph: document.querySelector('.ras-proj[data-recipe="rec-ap"] .ras-phase')?.textContent }));
  ok(mid.open && mid.ph === `starting${String.fromCharCode(8230)}`, 'Add keeps the sheet OPEN while the project starts: its row says "starting…"', mid);
  await sleep(2300);
  await page.unroute('**/api/rooms/*/seats/*/start');
  const phases = await page.evaluate(() => window.__phases);
  ok(phases.join('|') === `starting${String.fromCharCode(8230)}|${String.fromCharCode(10003)} started`, '...then ✓ started, then the sheet closes by itself (all in)', phases);
  const asm = calls.filter((c) => c.path === '/api/rooms/assemble');
  ok(asm.length === 1 && asm[0].body.dryRun === false && asm[0].body.seats.length === 1 && asm[0].body.seats[0].occupant === 'recipe:rec-lv' && typeof asm[0].body.key === 'string',
    'Add: ONE assemble (dryRun:false, the idempotency key) seats the tab', asm.map((c) => c.body));
  const addc = calls.filter((c) => c.path === `/api/rooms/${R}/seats`);
  const startc = calls.filter((c) => /\/seats\/[^/]+\/start$/.test(c.path));
  ok(addc.length === 1 && JSON.stringify(addc[0].body) === JSON.stringify({ recipe_id: 'rec-ap', handle: 'alpha-platform-2', policy: 'persistent' }), '...then POST seats {recipe_id, handle, policy}', addc.map((c) => c.body));
  ok(startc.length === 1 && JSON.stringify(startc[0].body) === JSON.stringify({ target: 'tab', surface: 'browser' }), '...then seats/:id/start', startc.map((c) => c.body));
  ok(!(await page.$('.ras-scrim')), 'the sheet closes on success');
  let seats = (await call(`/api/rooms/${R}`)).body.seats;
  ok(seats.some((x) => x.handle === 'liveone' && x.occupant?.id === 'recipe:rec-lv') && seats.some((x) => x.handle === 'alpha-platform-2' && x.occupant?.id), 'the engine has both: the tab seated, the project started on a fresh pane', seats.map((x) => [x.handle, x.occupant?.id]));
  const selAfter = await page.evaluate(() => document.querySelector('#roster .seat.sel')?.dataset.handle);
  ok(selAfter === 'alpha-platform-2', '...and the room selects the new agent', selAfter);
  const focusBack = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
  console.log(`    (focus after a start: ${focusBack})`);

  /* 6. a failed start: inline on its row; Add then only starts it */
  await open();
  await page.click('.ras-proj[data-recipe="rec-zz"]');
  await page.route('**/api/rooms/*/seats/*/start', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'probe: launch refused' }) }));
  calls.length = 0;
  await page.click('.ras-go');
  await sleep(1500);
  const fr = await page.evaluate(() => ({ open: !!document.querySelector('.ras-scrim'), err: document.querySelector('.ras-proj[data-recipe="rec-zz"] .ras-rerr')?.textContent || '', go: document.querySelector('.ras-go')?.textContent, foot: document.querySelector('.ras-ft .ras-err')?.textContent }));
  ok(fr.open && /@zebra was added but not started/.test(fr.err) && /probe: launch refused/.test(fr.err), 'a failed start is said inline ON ITS ROW; the sheet stays', fr);
  seats = (await call(`/api/rooms/${R}`)).body.seats;
  const zb = seats.find((x) => x.handle === 'zebra');
  ok(zb && !zb.occupant?.id && (zb.actions || []).includes('start'), '...the seat stays, never-started, with its own Start', zb && { occ: zb.occupant, actions: zb.actions });
  const retry = await page.evaluate(() => { const b = document.querySelector('.ras-proj[data-recipe="rec-zz"] .ras-retry'); return b && { text: b.textContent, disabled: b.disabled }; });
  ok(retry && retry.text === 'Retry start' && !retry.disabled, '...with the row\'s own "Retry start"', retry);
  await page.unroute('**/api/rooms/*/seats/*/start');
  calls.length = 0;
  await page.click('.ras-proj[data-recipe="rec-zz"] .ras-retry');
  await sleep(2500);
  ok(!(await page.$('.ras-scrim')) && calls.filter((c) => c.path === `/api/rooms/${R}/seats`).length === 0 && calls.filter((c) => c.path.endsWith('/start')).length === 1,
    'Retry start only STARTS it (no second seat); all in, the sheet closes by itself', calls.map((c) => c.path));
  seats = (await call(`/api/rooms/${R}`)).body.seats;
  ok(seats.filter((x) => x.handle.startsWith('zebra')).length === 1 && seats.find((x) => x.handle === 'zebra')?.occupant?.id, '...one @zebra, now started', seats.map((x) => x.handle));

  /* 6b. PER-START CHOICES (the design system 2026-09-28): the expanded row spans
     grid-column 2 / -1 with 8px row gaps; [New | Resume]; Resume opens the
     SHARED resume picker (web/resume-picker.mjs) for that recipe's sessions
     (served here by a route: this engine has no transcripts to list); cancel
     snaps back to New; the pick shows under the control; Model + Effort 50/50;
     the subtitle; and the REAL start bodies through the engine. */
  const S1 = '11111111-2222-4333-8444-555555555555';
  const S2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const SESS = [
    { sessionId: S1, title: 'Refactor the hull', lastPrompt: 'and the keel', firstCommand: null, mtimeMs: Date.now() - 3600e3, sizeBytes: 20480, branch: 'main' },
    { sessionId: S2, title: null, lastPrompt: 'fix the kiosk docs', firstCommand: null, mtimeMs: Date.now() - 7200e3, sizeBytes: 4096, branch: null },
  ];
  await page.route('**/api/recipes/rec-bb/sessions', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: SESS }) }));
  await open();
  await page.click('.ras-proj[data-recipe="rec-bb"]');
  await sleep(250);
  const bbGeo = await page.evaluate(() => {
    const row = document.querySelector('.ras-proj[data-recipe="rec-bb"]');
    const R = (e) => e.getBoundingClientRect();
    const more = row.querySelector('.more');
    const kids = [...more.children].filter((k) => getComputedStyle(k).display !== 'none');
    const hb = [...row.querySelectorAll('.ras-how button')];
    const me = row.querySelector('.ras-me');
    const fld = row.querySelector('.ras-fld');
    return {
      moreL: Math.round(R(more).left), moreR: Math.round(R(more).right), glyphL: Math.round(R(row.querySelector('.ras-glyph')).left),
      rowR: Math.round(R(row).right - parseFloat(getComputedStyle(row).paddingRight) - parseFloat(getComputedStyle(row).borderRightWidth)),
      fldL: Math.round(R(fld).left), fldR: Math.round(R(fld).right),
      gaps: kids.slice(1).map((k, i) => Math.round((R(k).top - R(kids[i]).bottom) * 10) / 10),
      kinds: kids.map((k) => k.className.split(' ')[0]),
      howH: hb.map((b) => Math.round(R(b).height)), howBg: hb.map((b) => getComputedStyle(b).backgroundColor),
      sels: [...me.querySelectorAll('select')].map((x) => ({ l: Math.round(R(x).left), r: Math.round(R(x).right), t: Math.round(R(x).top), w: Math.round(R(x).width) })),
      labs: [...me.querySelectorAll('.ras-mlab')].map((x) => {
        const sel = x.parentElement.querySelector('select');
        const cs = getComputedStyle(x);
        return { text: x.textContent, l: Math.round(R(x).left), b: Math.round(R(x).bottom), selT: Math.round(R(sel).top), selL: Math.round(R(sel).left), fs: cs.fontSize, color: cs.color, mb: cs.marginBottom };
      }),
      dim: (() => { const t = document.createElement('span'); document.body.append(t); t.style.color = 'var(--dim)'; const c = getComputedStyle(t).color; t.remove(); return c; })(),
      meL: Math.round(R(me).left), meR: Math.round(R(me).right),
    };
  });
  ok(bbGeo.moreL === bbGeo.glyphL && Math.abs(bbGeo.moreR - bbGeo.rowR) <= 1 && bbGeo.fldL === bbGeo.moreL && bbGeo.fldR === bbGeo.moreR,
    'the expanded area spans grid-column 2 / -1 (from the glyph column to the row edge), as the @name field does', bbGeo);
  ok(JSON.stringify(bbGeo.kinds.slice(0, 3)) === JSON.stringify(['ras-fld', 'ras-howwrap', 'ras-me']) && bbGeo.gaps.slice(0, 2).every((g) => Math.abs(g - 8) <= 0.5),
    '...one row each: @name, [New | Resume], Model + Effort, 8px row gaps', { kinds: bbGeo.kinds, gaps: bbGeo.gaps });
  ok(bbGeo.howH.every((h) => h === 36) && bbGeo.howBg[0] !== bbGeo.howBg[1] && bbGeo.howBg[1] === 'rgba(0, 0, 0, 0)', '[New | Resume]: 36px segments, the chosen one LIFTED', bbGeo);
  const [ms0, es0] = bbGeo.sels;
  ok(bbGeo.sels.length === 2 && ms0.t === es0.t && Math.abs(ms0.w - es0.w) <= 1 && es0.l - ms0.r === 8 && ms0.l === bbGeo.meL && es0.r === bbGeo.meR,
    'desktop (560): Model + Effort side by side, 50/50, filling the row', bbGeo.sels);
  ok(JSON.stringify(bbGeo.labs.map((x) => x.text)) === '["Model","Effort"]' && bbGeo.labs.every((x) => x.l === x.selL && x.b + 4 === x.selT && x.fs === '12px' && x.color === bbGeo.dim && x.mb === '4px'),
    "...each select under a small label, Model / Effort, in the recipe form's label style (12px, --dim, 4px above its field)", bbGeo.labs);
  const sub = (rid) => page.evaluate((id) => document.querySelector(`.ras-proj[data-recipe="${id}"] .nm .b`)?.textContent, rid);
  const opts = await page.evaluate(() => [...document.querySelectorAll('.ras-proj[data-recipe="rec-bb"] .ras-me select')].map((x) => [...x.options].map((o) => o.textContent)));
  ok(JSON.stringify(opts) === JSON.stringify([["Default (claude's)", 'sonnet', 'opus', 'fable'], ["Default (claude's)", 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode']]),
    `a recipe that sets no model/effort: "Default (claude's)" (not "none"), then the choices`, opts);
  await page.selectOption('[data-fid="pm-rec-bb"]', 'opus');
  await page.selectOption('[data-fid="pe-rec-bb"]', 'max');
  ok((await sub('rec-bb')) === `kiosk ${DOT} starts a new session ${DOT} opus ${DOT} max`, 'the subtitle names what differs: "starts a new session · opus · max"', await sub('rec-bb'));
  /* the COLLAPSED row (the design system r23 review): unticked, it still summarises the
     choice, and ticking it again brings the choice back */
  await page.click('.ras-proj[data-recipe="rec-bb"] .nm');
  await sleep(150);
  const coll = await page.evaluate(() => ({ on: document.querySelector('.ras-proj[data-recipe="rec-bb"]').getAttribute('aria-checked'), more: !!document.querySelector('.ras-proj[data-recipe="rec-bb"] .more') }));
  ok(coll.on === 'false' && !coll.more && (await sub('rec-bb')) === `kiosk ${DOT} starts a new session ${DOT} opus ${DOT} max`, 'COLLAPSED (unticked): the subtitle still reads "starts a new session · opus · max"', { coll, sub: await sub('rec-bb') });
  await page.click('.ras-proj[data-recipe="rec-bb"] .nm');
  await sleep(150);
  const back = await page.evaluate(() => [...document.querySelectorAll('.ras-proj[data-recipe="rec-bb"] .ras-me select')].map((x) => x.value));
  ok(JSON.stringify(back) === '["opus","max"]', '...and ticking it again brings the choice back', back);
  /* a long folder name gives way before the choices do (.b is a flex row, where
     bare text is clipped with no ellipsis) */
  const clip = await page.evaluate(() => {
    const b = document.querySelector('.ras-proj[data-recipe="rec-bb"] .nm .b');
    const f = b.querySelector('.ras-fold');
    const sm = b.querySelector('.ras-sum');
    const was = f.textContent;
    f.textContent = `a-very-long-project-folder-name-that-runs-on-and-on-forever ${String.fromCharCode(183)} `;
    const out = { sumFits: sm.scrollWidth <= sm.clientWidth, sumR: Math.round(sm.getBoundingClientRect().right), bR: Math.round(b.getBoundingClientRect().right), foldClipped: f.scrollWidth > f.clientWidth, foldEll: getComputedStyle(f).textOverflow };
    f.textContent = was;
    return out;
  });
  ok(clip.sumFits && clip.sumR <= clip.bR && clip.foldClipped && clip.foldEll === 'ellipsis', '...with a long folder, the FOLDER is ellipsed and "· opus · max" stays whole', clip);
  await page.click('.ras-proj[data-recipe="rec-bb"] .ras-fresh input');
  ok((await sub('rec-bb')) === `kiosk ${DOT} new ${DOT} fresh ${DOT} opus ${DOT} max`, '...with the fresh box: "new · fresh · …"', await sub('rec-bb'));
  await page.click('.ras-proj[data-recipe="rec-bb"] .ras-fresh input');
  /* Resume -> the picker, at once; Esc cancels it (not the sheet) and snaps back */
  await page.click('[data-fid="how-resume-rec-bb"]');
  await page.waitForSelector('#resumeModal .resume-row', { timeout: 5000 });
  const pk = await page.evaluate(() => {
    const m = document.getElementById('resumeModal');
    const box = m.querySelector('.rp-box').getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + 20);
    return {
      title: document.getElementById('resumeTitle').textContent, rows: [...m.querySelectorAll('.rr-title')].map((x) => x.textContent),
      onTop: m.contains(top), pressed: document.querySelector('[data-fid="how-resume-rec-bb"]').getAttribute('aria-pressed'),
    };
  });
  ok(pk.title === `Resume ${String.fromCharCode(8212)} Kiosk` && JSON.stringify(pk.rows) === JSON.stringify(['Refactor the hull', 'fix the kiosk docs']) && pk.onTop,
    "Resume OPENS the shared resume picker at once, over the sheet, listing that recipe's sessions", pk);
  ok(pk.pressed === 'true', '...Resume shows chosen while it is open', pk.pressed);
  await page.keyboard.press('Escape');
  await sleep(150);
  let st6 = await page.evaluate(() => ({ picker: !!document.getElementById('resumeModal'), sheet: !!document.querySelector('.ras-scrim'),
    how: [...document.querySelectorAll('.ras-proj[data-recipe="rec-bb"] .ras-how button')].map((b) => b.getAttribute('aria-pressed')), fresh: !!document.querySelector('.ras-proj[data-recipe="rec-bb"] .ras-fresh') }));
  ok(!st6.picker && st6.sheet && JSON.stringify(st6.how) === '["true","false"]' && st6.fresh, 'Esc cancels the picker (the sheet stays) and, nothing picked, snaps back to New', st6);
  await page.click('[data-fid="how-resume-rec-bb"]');
  await page.waitForSelector('#resumeModal .resume-row', { timeout: 5000 });
  await page.click(`#resumeModal .resume-row[data-session="${S2}"]`);
  await sleep(150);
  const pickLine = () => page.evaluate(() => {
    const r = document.querySelector('.ras-proj[data-recipe="rec-bb"]');
    const l = r.querySelector('.ras-pick');
    const how = r.querySelector('.ras-how');
    return { text: l?.textContent ?? null, below: l ? Math.round(l.getBoundingClientRect().top - how.getBoundingClientRect().bottom) : null,
      how: [...how.querySelectorAll('button')].map((b) => b.getAttribute('aria-pressed')), fresh: !!r.querySelector('.ras-fresh'),
      change: l?.querySelector('button')?.textContent, changeColor: l ? getComputedStyle(l.querySelector('button')).color : null };
  });
  let pl = await pickLine();
  ok(pl.text === `Resuming "fix the kiosk docs" ${DOT} Change` && pl.below >= 0 && JSON.stringify(pl.how) === '["false","true"]' && !pl.fresh,
    'a pick shows UNDER the control: Resuming "<title>" · Change (no fresh box: Resume is persistent)', pl);
  ok((await sub('rec-bb')) === `kiosk ${DOT} resumes "fix the kiosk docs" ${DOT} opus ${DOT} max`, 'the subtitle: resumes "<title>" · opus · max', await sub('rec-bb'));
  await page.click('.ras-proj[data-recipe="rec-bb"] .ras-pick button');
  await page.waitForSelector('#resumeModal .resume-row', { timeout: 5000 });
  await page.click('#resumeCancelBtn');
  await sleep(150);
  pl = await pickLine();
  ok(pl.text === `Resuming "fix the kiosk docs" ${DOT} Change` && !(await page.$('#resumeModal')), 'Change, then Cancel: the earlier pick stands', pl);
  /* Add: the seat (policy persistent), then its start RESUMING the pick through the engine */
  calls.length = 0;
  await page.click('.ras-go');
  await sleep(2500);
  const addBB = calls.filter((c) => c.path === `/api/rooms/${R}/seats`);
  const startBB = calls.filter((c) => /\/seats\/[^/]+\/start$/.test(c.path));
  ok(addBB.length === 1 && JSON.stringify(addBB[0].body) === JSON.stringify({ recipe_id: 'rec-bb', handle: 'kiosk', policy: 'persistent' }), 'Add: POST seats {recipe_id, handle, policy:persistent} (Resume implies persistent)', addBB.map((c) => c.body));
  ok(startBB.length === 1 && JSON.stringify(startBB[0].body) === JSON.stringify({ target: 'tab', surface: 'browser', resumeSessionId: S2, model: 'opus', effort: 'max' }),
    '...then seats/:id/start {resumeSessionId, model, effort}', startBB.map((c) => c.body));
  seats = (await call(`/api/rooms/${R}`)).body.seats;
  const bbSeat = seats.find((x) => x.handle === 'kiosk');
  const bbRow = (await seed({ read: ['recipe:rec-bb'] })).rows[0];
  ok(bbSeat?.occupant?.id === 'recipe:rec-bb' && bbRow?.session_id === S2 && bbRow?.state === 'dehydrated',
    'the engine: @kiosk on the picked session (the pane banks it, dehydrated: its attach runs --resume)', { occ: bbSeat?.occupant, row: bbRow && { s: bbRow.session_id, st: bbRow.state } });
  const bbView = await page.evaluate(() => [...document.querySelectorAll('#seatView iframe')].filter((f) => !f.hidden).map((f) => f.getAttribute('src')));
  ok(bbView.length === 1 && bbView[0].includes('model=opus') && bbView[0].includes('effort=max'), '...and the room frames it on the answer path, which carries the overrides to the attach', bbView);
  /* New + fresh + an effort override only (Model left at the recipe's) */
  await open();
  await page.click('.ras-proj[data-recipe="rec-ap"]');
  await sleep(200);
  await page.click('.ras-proj[data-recipe="rec-ap"] .ras-fresh input');
  await page.selectOption('[data-fid="pe-rec-ap"]', 'high');
  ok((await sub('rec-ap')) === `alpha-platform ${DOT} new ${DOT} fresh`, "choosing the recipe's OWN effort (high) is not a difference: the subtitle leaves it out", await sub('rec-ap'));
  await page.selectOption('[data-fid="pe-rec-ap"]', 'low');
  ok((await sub('rec-ap')) === `alpha-platform ${DOT} new ${DOT} fresh ${DOT} low`, '...a different one is named: "new · fresh · low"', await sub('rec-ap'));
  calls.length = 0;
  await page.click('.ras-go');
  await sleep(2500);
  const addAP = calls.filter((c) => c.path === `/api/rooms/${R}/seats`);
  const startAP = calls.filter((c) => /\/seats\/[^/]+\/start$/.test(c.path));
  ok(addAP.length === 1 && addAP[0].body.policy === 'fresh' && addAP[0].body.handle === 'alpha-platform-3', 'New + the fresh box: POST seats {policy: fresh}', addAP.map((c) => c.body));
  ok(startAP.length === 1 && JSON.stringify(startAP[0].body) === JSON.stringify({ target: 'tab', surface: 'browser', effort: 'low' }), "...then seats/:id/start {effort: low} (no model: the recipe's stands)", startAP.map((c) => c.body));
  seats = (await call(`/api/rooms/${R}`)).body.seats;
  const ap3 = seats.find((x) => x.handle === 'alpha-platform-3');
  const apView = await page.evaluate(() => [...document.querySelectorAll('#seatView iframe')].filter((f) => !f.hidden).map((f) => f.getAttribute('src')));
  ok(ap3?.policy === 'fresh' && /^recipe:rec-ap#[0-9a-f]{8}$/.test(ap3?.occupant?.id ?? '') && apView[0]?.includes('effort=low') && !apView[0]?.includes('model='),
    'the engine: a fresh pane, policy fresh, framed with &effort=low', { ap3: ap3 && { p: ap3.policy, o: ap3.occupant?.id }, apView });

  /* 7. keyboard: tabs, Esc, focus back */
  await open();
  await page.keyboard.press('ArrowRight');
  let k = await page.evaluate(() => ({ sel: document.querySelector('[role="tab"][aria-selected="true"]')?.id, focus: document.activeElement?.id }));
  ok(k.sel === 'rasTab-apps' && k.focus === 'rasTab-apps', 'ArrowRight moves to Apps (selected + focused)', k);
  await page.keyboard.press('Home');
  k = await page.evaluate(() => ({ sel: document.querySelector('[role="tab"][aria-selected="true"]')?.id, focus: document.activeElement?.id }));
  ok(k.sel === 'rasTab-agents' && k.focus === 'rasTab-agents', 'Home goes back to Agents', k);
  await page.mouse.click(5, 5); // the backdrop
  ok(!!(await page.$('.ras-scrim')), 'a backdrop click does NOT close it');
  await page.keyboard.press('Escape');
  k = await page.evaluate(() => ({ open: !!document.querySelector('.ras-scrim'), focus: document.activeElement?.id }));
  ok(!k.open && k.focus === 'addBtn', 'Esc closes it and focus returns to the +', k);
  /* opened from the KEYBOARD: focus lands on the Agents segment WITH the ring */
  await page.keyboard.press('Enter');
  await page.waitForSelector('.ras-sheet [role="tab"]', { timeout: 6000 });
  await sleep(200);
  const kr = await page.evaluate(() => { const a = document.activeElement; return { id: a?.id, fv: !!a?.matches(':focus-visible'), outline: getComputedStyle(a).outlineStyle, quiet: a?.hasAttribute('data-quiet-focus') }; });
  ok(kr.id === 'rasTab-agents' && kr.fv && kr.outline !== 'none' && !kr.quiet, 'opened by Enter on the +: focus on the Agents segment, ring shown (keyboard users)', kr);
  await page.keyboard.press('Escape');

  /* ================================ 8. Apps ================================ */
  const changedPanel = () => call(`/api/rooms/${R}/panels`).then((r) => (r.body?.panels ?? []).find((p) => p.app_slug === 'changed-app'));
  const cp = await changedPanel();
  const heldCell = await page.evaluate((id) => {
    const c = document.querySelector(`.cell[data-cell="${id}"]`);
    const b = c?.querySelector('.cell-hw .cell-badge');
    return c && { offline: !!c.querySelector('.cell-held'), badge: b && !b.hidden ? b.textContent : null, href: b?.getAttribute('href') };
  }, cp?.id);
  ok(cp?.app_held && cp?.app_status === 'held' && heldCell && !heldCell.offline && heldCell.badge === 'Needs approval ›' && heldCell.href === '/settings.html#apps',
    'a HELD app\'s panel keeps drawing (no offline card) and its title bar wears "Needs approval ›" -> /settings.html#apps [ticket]', { held: cp?.app_held, st: cp?.app_status, heldCell });
  await open();
  await page.click('#rasTab-apps');
  await sleep(1200);
  const readApps = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.ras-app:not(.ras-cand)')].map((r) => {
    const ic = r.querySelector('.ras-ic').getBoundingClientRect();
    const d = r.querySelector('.d');
    const st = r.querySelector('.ras-st');
    return [r.dataset.slug, {
      name: r.querySelector('.ras-aname').textContent, ic: [Math.round(ic.width), Math.round(ic.height)],
      clamp: getComputedStyle(d).webkitLineClamp, dh: Math.round(d.getBoundingClientRect().height), lh: parseFloat(getComputedStyle(d).lineHeight),
      meta: r.querySelector('.m').textContent, word: st?.textContent || '', stColor: st ? getComputedStyle(st).color : '',
      acts: [...r.querySelectorAll('.acts button')].map((b) => b.textContent), off: r.querySelector('.ras-off')?.textContent || '',
      err: r.querySelector('.ras-aerr')?.textContent || '',
      chip: r.querySelector('.app-chip')?.textContent || '', chipColor: r.querySelector('.app-chip') ? getComputedStyle(r.querySelector('.app-chip')).color : '',
      set: r.querySelector('.acts .app-set-link')?.getAttribute('href') || '',
    }];
  })));
  let A = await readApps();
  const tok = await page.evaluate(() => {
    const t = document.createElement('span');
    document.body.append(t);
    const c = (v) => { t.style.color = `var(${v})`; return getComputedStyle(t).color; };
    const out = { teal: c('--teal'), amber: c('--amber'), dim: c('--dim') };
    t.remove();
    return out;
  });
  ok(Object.keys(A).length === 9 && Object.values(A).every((x) => x.ic[0] === 40 && x.ic[1] === 40), 'Apps: a row per registered app (GET /api/apps), each with a 40px icon tile', Object.entries(A).map(([k, x]) => [k, x.ic]));
  ok(A['room-tasks'].clamp === '2' && A['room-tasks'].dh <= Math.ceil(A['room-tasks'].lh * 2) + 1, 'the description is clamped to 2 lines', { clamp: A['room-tasks'].clamp, h: A['room-tasks'].dh, lh: A['room-tasks'].lh });
  ok(A['room-tasks'].meta === 'panel: Tasks' && A['image-studio'].meta === 'panel: Image Studio · exclusive · one room at a time', 'a mono meta line "panel: Tasks" (+ "exclusive · one room at a time")', [A['room-tasks'].meta, A['image-studio'].meta]);
  ok(A['room-tasks'].word === 'In this room' && A['room-tasks'].stColor === tok.teal && A['room-tasks'].acts.join() === 'Remove', 'In this room (teal) → Remove', A['room-tasks']);
  ok(A['room-assets'].word === '' && A['room-assets'].acts.join() === 'Add', 'not added: no word, Add', A['room-assets']);
  ok(A['image-studio'].word === 'In "Alpha-Platform Apps"' && A['image-studio'].stColor === tok.dim && /^Move here/.test(A['image-studio'].acts.join()), 'exclusive, held elsewhere: In "<room>" (dim) → Move here…', A['image-studio']);
  ok(A['room-voice-app'].word === 'Not running' && A['room-voice-app'].stColor === tok.amber && A['room-voice-app'].acts.join() === 'Add' && /offline until the app runs/.test(A['room-voice-app'].off), 'down: Not running (amber), still Add, "It shows offline until the app runs."', A['room-voice-app']);
  ok(A['changed-app'].chip === 'Needs approval' && A['changed-app'].chipColor === tok.amber && A['changed-app'].acts.join() === 'Remove' && A['changed-app'].set === '/settings.html#apps',
    'tool.json changed: the "Needs approval" chip (amber), a Settings › link, NO Approve (only Remove: it is in this room) [ticket]', A['changed-app']);
  ok(A['room-tasks'].chip === 'Registered' && A['room-tasks'].chipColor === tok.teal && A['room-tasks'].set === '', 'a registered app: the "Registered" chip (teal), no Settings link', A['room-tasks']);
  const secs = await page.evaluate(() => [...document.querySelectorAll('.ras-body .ras-sec')].map((x) => [x.dataset.sec, x.firstChild.textContent, x.querySelector('.c')?.textContent]));
  ok(secs.length === 2 && secs[0][1] === 'In this room' && secs[1][1] === 'Can be added' && secs[0][2] === '2', 'two sections: "In this room" (2) then "Can be added"', secs);
  const order = await page.evaluate(() => [...document.querySelectorAll('.ras-body > *')].map((e) => (e.classList.contains('ras-sec') ? `#${e.dataset.sec}` : e.dataset?.slug)).filter(Boolean));
  ok(order.indexOf('room-tasks') < order.indexOf('#add') && order.indexOf('changed-app') < order.indexOf('#add') && order.indexOf('room-assets') > order.indexOf('#add'),
    'in-room apps above "Can be added", the rest below', order);
  const cand = await page.evaluate(() => [...document.querySelectorAll('.ras-app.ras-cand')].map((r) => ({ slug: r.dataset.slug, chip: r.querySelector('.app-chip')?.textContent, set: r.querySelector('.app-set-link')?.getAttribute('href'), btns: r.querySelectorAll('button').length })));
  ok(cand.some((c) => c.slug === 'blender-studio' && c.chip === 'Not registered' && c.set === '/settings.html#apps' && c.btns === 0),
    '"Can be added" lists a folder never registered: "Not registered" chip + Settings ›, no button', cand);
  const noOld = await page.evaluate(() => ({
    reg: !!document.querySelector('.ras-reg'), ap: !!document.querySelector('[data-fid^="ap-"]'),
    words: [...document.querySelectorAll('.ras-sheet button')].map((b) => b.textContent).filter((t) => /^(Approve|Register)/.test(t)),
  }));
  ok(!noOld.reg && !noOld.ap && !noOld.words.length, 'no Register or Approve anywhere in the + sheet [ticket]', noOld);
  const foot = await page.evaluate(() => ({ note: document.querySelector('.ras-ft .ras-note')?.textContent, btns: [...document.querySelectorAll('.ras-ft button')].map((b) => b.textContent), tabN: document.querySelector('#rasTab-apps .n')?.textContent }));
  ok(foot.note === 'Changes apply at once.' && foot.btns.join() === 'Done', 'Apps footer: "Changes apply at once." + Done', foot);
  ok(foot.tabN === '2', 'the Apps tab counts the apps in this room', foot.tabN);
  await shot(page, 'apps');
  const roomApps = async () => ((await call(`/api/rooms/${R}/apps`)).body?.apps ?? []).map((a) => a.slug).sort();
  const appPanels = async () => ((await call(`/api/rooms/${R}/panels`)).body?.panels ?? []).filter((p) => p.app_slug).map((p) => [p.app_slug, p.title]);

  /* Add (shared, running): the panel appears in the room */
  calls.length = 0;
  await page.click('.ras-app[data-slug="room-assets"] .acts button');
  await sleep(1200);
  const add = calls.find((c) => c.path === `/api/rooms/${R}/apps`);
  A = await readApps();
  ok(add && JSON.stringify(add.body) === '{"slug":"room-assets"}' && A['room-assets'].word === 'In this room', 'Add → POST .../apps {slug}; the row reads In this room', { add, word: A['room-assets'].word });
  ok((await roomApps()).includes('room-assets') && (await appPanels()).some(([s]) => s === 'room-assets'), '...the engine holds it, with its panel (app_slug)', await appPanels());
  ok(await page.evaluate(() => [...document.querySelectorAll('#panelCells .cell .tt')].some((t) => t.textContent === 'Assets')), '...and the room page draws its cell behind the sheet');
  /* Add a DOWN app: allowed; "In this room" + the offline line */
  await page.click('.ras-app[data-slug="room-voice-app"] .acts button');
  await sleep(1200);
  A = await readApps();
  ok(A['room-voice-app'].acts.join() === 'Remove' && /offline until the app runs/.test(A['room-voice-app'].off) && (await roomApps()).includes('room-voice-app'),
    'a down app can be added; its row keeps "It shows offline until the app runs."', A['room-voice-app']);
  /* Remove + Undo */
  calls.length = 0;
  await page.click('.ras-app[data-slug="room-tasks"] .acts button');
  await sleep(1000);
  ok(calls.some((c) => c.m === 'DELETE' && c.path === `/api/rooms/${R}/apps/room-tasks`) && !(await roomApps()).includes('room-tasks'), 'Remove → DELETE .../apps/:slug, no confirm; gone from the room', calls);
  const toast = await page.evaluate(() => ({ t: document.querySelector('.ras-toast span')?.textContent, b: document.querySelector('.ras-toast button')?.textContent }));
  ok(toast.t === 'Removed Tasks' && toast.b === 'Undo', 'a toast "Removed Tasks · Undo"', toast);
  await page.click('.ras-toast button');
  await sleep(1200);
  ok((await roomApps()).includes('room-tasks') && (await readApps())['room-tasks'].word === 'In this room', 'Undo puts it back (POST .../apps)', await roomApps());

  /* Move here… (exclusive, with an HTTP bind) */
  await page.click('.ras-app[data-slug="image-studio"] .acts button');
  await sleep(300);
  let dlg = await page.evaluate(() => {
    const c = document.querySelector('.ras-card');
    return c && { role: c.getAttribute('role'), modal: c.getAttribute('aria-modal'), h: c.querySelector('.hd').textContent, lis: [...c.querySelectorAll('li')].map((l) => l.textContent), btns: [...c.querySelectorAll('.cf button')].map((b) => b.textContent), focus: document.activeElement?.textContent };
  });
  ok(dlg && dlg.role === 'alertdialog' && dlg.modal === 'true' && dlg.h === 'Move Image Studio here?', 'Move here… opens an alertdialog "Move Image Studio here?"', dlg);
  ok(dlg && JSON.stringify(dlg.lis) === JSON.stringify(['It leaves "Alpha-Platform Apps", and its panel there goes.', 'A job already running there finishes there.', ...STUDIO_NOTES.slice(0, 2)]),
    '...what happens: the generic move, the job line (jobs:true), then the APP\'s own move_notes (the bad one dropped)', dlg?.lis);
  ok(dlg && dlg.btns.join() === 'Cancel,Move here' && dlg.focus === 'Cancel', '...Cancel is the default', dlg);
  await shot(page, 'move');
  await page.keyboard.press('Escape');
  k = await page.evaluate(() => ({ dlg: !!document.querySelector('.ras-card'), sheet: !!document.querySelector('.ras-scrim') }));
  ok(!k.dlg && k.sheet, 'Esc closes only the dialog', k);
  /* no-seat: the bind refuses; the dialog closes, a line on the row */
  await ctl(studio, { noSeat: true });
  await page.click('.ras-app[data-slug="image-studio"] .acts button');
  await sleep(200);
  calls.length = 0;
  await page.click('.ras-card [data-a="ok"]');
  await sleep(900);
  A = await readApps();
  ok(calls[0]?.body?.move === true && !(await page.$('.ras-card')) && /Image Studio's agent needs a seat in this room first\. Add it on the Agents tab\./.test(A['image-studio'].err),
    'Move here → {move:true}; a no-seat refusal is an inline line on the row', { body: calls[0]?.body, err: A['image-studio'].err });
  ok(!(await roomApps()).includes('image-studio'), '...and nothing moved', await roomApps());
  /* job-running: Wait / Move anyway → force */
  await ctl(studio, { noSeat: false, jobs: 1 });
  await page.click('.ras-app[data-slug="image-studio"] .acts button');
  await sleep(200);
  await page.click('.ras-card [data-a="ok"]');
  await sleep(900);
  dlg = await page.evaluate(() => {
    const c = document.querySelector('.ras-card');
    return c && { h: c.querySelector('.hd').textContent, btns: [...c.querySelectorAll('.cf button')].map((b) => [b.textContent, getComputedStyle(b).color]) };
  });
  ok(dlg && dlg.h === '1 job is running in "Alpha-Platform Apps"' && dlg.btns.map((b) => b[0]).join() === 'Wait,Move anyway' && dlg.btns[1][1] === tok.amber,
    'a job-running refusal turns it into "1 job is running in …" with Wait / Move anyway (amber)', dlg);
  await page.click('.ras-card [data-a="cancel"]');
  ok(!(await page.$('.ras-card')) && !(await roomApps()).includes('image-studio'), 'Wait closes it; nothing moved');
  await ctl(studio, { jobs: 2 });
  await page.click('.ras-app[data-slug="image-studio"] .acts button');
  await sleep(200);
  await page.click('.ras-card [data-a="ok"]');
  await sleep(900);
  ok(await page.evaluate(() => document.querySelector('.ras-card .hd')?.textContent) === '2 jobs are running in "Alpha-Platform Apps"', '...and says "2 jobs are running" for two');
  calls.length = 0;
  await ctl(studio, { calls: [] });
  await page.click('.ras-card [data-a="ok"]');
  await sleep(1200);
  const moved = await page.evaluate(() => ({ dlg: !!document.querySelector('.ras-card'), word: document.querySelector('.ras-app[data-slug="image-studio"] .ras-st')?.textContent, toast: document.querySelector('.ras-toast span')?.textContent }));
  const bc = await bindCalls(studio);
  ok(calls[0]?.body?.force === true && bc.some((b) => b.force === true), 'Move anyway re-POSTs with force:true (and the app\'s bind gets force)', { body: calls[0]?.body, bind: bc });
  ok(!moved.dlg && moved.word === 'In this room' && /^Moved Image Studio from "Alpha-Platform Apps"$/.test(moved.toast) && (await roomApps()).includes('image-studio'),
    '...moved: the row reads In this room, the toast names where from (bind called: no re-bind note)', moved);
  await ctl(studio, { jobs: 0 });
  /* an exclusive app with NO HTTP bind: the toast says its agent must re-bind */
  await page.click('.ras-app[data-slug="canvas"] .acts button');
  await sleep(200);
  const cl = await page.$$eval('.ras-card li', (ls) => ls.map((l) => l.textContent));
  ok(JSON.stringify(cl) === JSON.stringify(['It leaves "Alpha-Platform Apps", and its panel there goes.', 'What "Alpha-Platform Apps" keeps is up to Canvas.']),
    'the Move dialog shows only lines TRUE for the app: Canvas (no jobs, no move_notes) gets the generic two', cl);
  await page.click('.ras-card [data-a="ok"]');
  await sleep(1000);
  const cv = await page.evaluate(() => document.querySelector('.ras-toast span')?.textContent);
  ok(/Moved Canvas/.test(cv || '') && /Canvas's agent must re-bind itself/.test(cv || ''), 'bind:not-supported → "…Canvas\'s agent must re-bind itself"', cv);
  /* A DOWN exclusive app that declares an HTTP bind (r22c review): the
     engine's add calls the bind and a bind to an app that is not running is a
     502 bind-failed, so the row SAYS so and its Add is disabled (the copy and
     the behaviour agree); a down SHARED app stays addable (above). */
  A = await readApps();
  const kb = await page.evaluate(() => { const b = document.querySelector('.ras-app[data-slug="kiln"] .acts button'); return b && { text: b.textContent, disabled: b.disabled, title: b.title }; });
  ok(A.kiln.word === `Not running ${DOT} can be added once it runs` && A.kiln.stColor === tok.amber && !/offline until/.test(A.kiln.off),
    'a down EXCLUSIVE app with a bind: "Not running · can be added once it runs" (amber), no "shows offline" promise', A.kiln);
  ok(kb && kb.text === 'Add' && kb.disabled && kb.title === 'Not running: Kiln can be added once it runs', '...its Add is DISABLED, with that reason as its tooltip', kb);
  ok(/offline until the app runs/.test(A['room-voice-app'].off) && !/can be added once/.test(A['room-voice-app'].word), '...while a down SHARED app keeps "It shows offline until the app runs." (and was added above)', A['room-voice-app']);
  const kd = await call(`/api/rooms/${R}/apps`, { json: { slug: 'kiln' } });
  ok(kd.status === 502 && kd.body?.error === 'bind-failed' && !(await roomApps()).includes('kiln'), '...and that IS the engine: adding it anyway is a 502 bind-failed; nothing added', kd);
  const kcat = (await call('/api/apps')).body?.apps ?? [];
  const bindOf = (sl) => kcat.find((a) => a.slug === sl)?.bind;
  ok(bindOf('kiln') === true && bindOf('image-studio') === true && bindOf('canvas') === false && bindOf('room-voice-app') === false,
    'the catalog says which apps declare an HTTP bind (bind: true | false)', kcat.map((a) => [a.slug, a.bind]));
  /* bind-failed endpoint-unverified (rooms/apps-sec): its own words */
  await page.click('.ras-app[data-slug="forge"] .acts button');
  await sleep(1200);
  A = await readApps();
  ok(/^Forge isn't answering from its own process, so it can't be added right now\. Nothing moved\.$/.test(A.forge.err) && !(await roomApps()).includes('forge'),
    'a 502 bind-failed endpoint-unverified: "Forge isn\'t answering from its own process…"; nothing moved', A.forge.err);
  /* Settings › opens Settings → Apps (a page of its own here: a new window) */
  const [setPop] = await Promise.all([page.waitForEvent('popup', { timeout: 6000 }).catch(() => null), page.click('[data-fid="set-changed-app"]')]);
  ok(!!setPop && /\/settings\.html#apps$/.test(setPop.url()), 'Settings › opens /settings.html#apps', setPop?.url());
  await setPop?.close().catch(() => {});
  /* approve through Settings' route (a person), as Settings → Apps would */
  const cat2 = (await call('/api/apps')).body?.apps ?? [];
  const chSha = cat2.find((a) => a.slug === 'changed-app')?.sha256;
  const apr = await call('/api/apps/changed-app/approve', { json: chSha ? { expected_sha256: chSha } : {} });
  ok(apr.status === 200 && apr.body?.app?.state === 'registered', 'approved in Settings\' route: registered', apr.status);
  await page.click('[data-fid="done"]');
  ok(!(await page.$('.ras-scrim')), 'Done closes the sheet');
  await sleep(3500); // a poll
  const approvedCell = await page.evaluate((id) => { const c = document.querySelector(`.cell[data-cell="${id}"]`); const b = c?.querySelector('.cell-badge'); return c && { badge: !!b && !b.hidden, frames: c.querySelectorAll('iframe').length }; }, cp?.id);
  ok(approvedCell && !approvedCell.badge && approvedCell.frames === 1, 'approved: the badge goes, the panel keeps its app', approvedCell);

  /* ============================ 9. the panel menu ============================ */
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1500);
  const cellHead = (id) => `.cell[data-cell="${id}"] .cell-h`;
  const [T, AS, N] = panelIds;
  const moreOp = await page.evaluate((id) => getComputedStyle(document.querySelector(`.cell[data-cell="${id}"] .rpm-more`)).opacity, T);
  await page.hover(cellHead(T));
  const moreHover = await page.evaluate((id) => getComputedStyle(document.querySelector(`.cell[data-cell="${id}"] .rpm-more`)).opacity, T);
  ok(moreOp === '0' && moreHover === '1', 'the panel header\'s ⋯ shows on hover', { moreOp, moreHover });
  await page.click(cellHead(T), { button: 'right' });
  await sleep(200);
  let menu = await page.evaluate(() => {
    const m = document.querySelector('.rsm-menu');
    return m && {
      title: m.querySelector('.rsm-mt')?.textContent,
      items: [...m.children].filter((x) => x.matches('.rsm-mi, .rsm-msep')).map((x) => (x.matches('.rsm-msep') ? '—' : `${x.textContent}${x.getAttribute('aria-disabled') === 'true' ? ` [off: ${x.title}]` : ''}`)),
      coral: getComputedStyle(m.querySelector('[data-a="rem"]')).color,
      focus: document.activeElement?.dataset.a,
    };
  });
  const coral = await page.evaluate(() => { const t = document.createElement('span'); t.style.color = 'var(--coral)'; document.body.append(t); const c = getComputedStyle(t).color; t.remove(); return c; });
  const UP = String.fromCharCode(8593);
  const DOWN = String.fromCharCode(8595);
  ok(menu && menu.title === 'Alpharoom panel', 'right-click opens the SEAT MENU surface with a title row ("Alpha · room panel" for a plain panel)', menu?.title);
  ok(menu && JSON.stringify(menu.items) === JSON.stringify([`Rename panel${String.fromCharCode(8230)}`, `Move upAlt+${UP} [off: Already first]`, `Move downAlt+${DOWN}`, 'Collapse', '—', 'Remove from room']),
    '...items in the fixed order; Move up disabled at the top WITH its reason', menu?.items);
  ok(menu && menu.coral === coral, '...Remove from room in coral', menu?.coral);
  await shot(page, 'panel-menu');
  await page.keyboard.press('Escape');
  k = await page.evaluate(() => ({ menu: !!document.querySelector('.rsm-menu'), focus: document.activeElement?.closest('.cell')?.dataset.cell, cls: document.activeElement?.className }));
  ok(!k.menu && k.focus === T && k.cls === 'cell-h', 'Esc closes it; focus returns to the header', k);
  await page.keyboard.press('Shift+F10');
  ok(!!(await page.$('.rsm-menu')), 'Shift+F10 on the focused header opens it');
  await page.keyboard.press('Escape');
  /* Alt+Down */
  await page.focus(cellHead(T));
  await page.keyboard.press('Alt+ArrowDown');
  await sleep(1200);
  let ep = await enginePanels();
  k = await page.evaluate(() => ({ cells: [...document.querySelectorAll('#panelCells .cell')].map((c) => c.querySelector('.tt').textContent).slice(0, 3), focus: document.activeElement?.closest('.cell')?.querySelector('.tt')?.textContent }));
  ok(ep.map((p) => p.title).join() === 'Beta,Alpha,Notes' && k.cells.join() === 'Beta,Alpha,Notes', 'Alt+Down moves Alpha below Beta (the engine\'s order, PATCH {order})', { ep, cells: k.cells });
  ok(k.focus === 'Alpha', '...and the keyboard stays on the Alpha header', k.focus);
  await page.keyboard.press('Alt+ArrowUp');
  await sleep(1200);
  ep = await enginePanels();
  ok(ep.map((p) => p.title).join() === 'Alpha,Beta,Notes', 'Alt+Up moves it back', ep);
  /* the last one: Move down disabled */
  const lastId = await page.evaluate(() => [...document.querySelectorAll('#panelCells .cell[data-cell]')].filter((c) => !c.classList.contains('cell-voice-host')).pop()?.dataset.cell);
  await page.click(cellHead(lastId), { button: 'right' });
  menu = await page.evaluate(() => [...document.querySelectorAll('.rsm-menu .rsm-mi')].map((x) => [x.dataset.a, x.getAttribute('aria-disabled'), x.title]));
  ok(menu.find((x) => x[0] === 'down')?.[1] === 'true' && menu.find((x) => x[0] === 'down')?.[2] === 'Already last', 'at the bottom, Move down is disabled with its reason', menu);
  await page.keyboard.press('Escape');
  /* Rename */
  await page.click(cellHead(N), { button: 'right' });
  await page.click('.rsm-menu [data-a="ren"]');
  await sleep(150);
  const ren = await page.evaluate(() => ({ field: !!document.querySelector('.rpm-ren input'), val: document.querySelector('.rpm-ren input')?.value, focus: document.activeElement?.tagName }));
  ok(ren.field && ren.val === 'Notes' && ren.focus === 'INPUT', 'Rename panel… : inline in the header, focused', ren);
  await page.fill('.rpm-ren input', 'Notebook');
  await page.keyboard.press('Enter');
  await sleep(1000);
  ep = await enginePanels();
  ok(ep.find((p) => p.id === N)?.title === 'Notebook' && await page.evaluate((id) => document.querySelector(`.cell[data-cell="${id}"] .tt`)?.textContent === 'Notebook' && !document.querySelector('.rpm-ren'), N),
    'Enter saves (PATCH {title}); the header reads Notebook', ep);
  /* Collapse */
  await page.click(cellHead(AS), { button: 'right' });
  await page.click('.rsm-menu [data-a="fold"]');
  await sleep(200);
  ok(await page.evaluate((id) => document.querySelector(`.cell[data-cell="${id}"]`).classList.contains('collapsed'), AS), 'Collapse folds the cell');
  await page.click(cellHead(AS), { button: 'right' });
  const lbl = await page.evaluate(() => document.querySelector('.rsm-menu [data-a="fold"]')?.textContent);
  ok(lbl === 'Expand', '...and then offers Expand', lbl);
  await page.keyboard.press('Escape');
  /* Remove + Undo (a plain panel) */
  calls.length = 0;
  await page.click(cellHead(N), { button: 'right' });
  await page.click('.rsm-menu [data-a="rem"]');
  await sleep(1000);
  ep = await enginePanels();
  const rt = await page.evaluate(() => ({ t: document.querySelector('.rm-toast .tx')?.textContent, b: document.querySelector('.rm-toast .act')?.textContent }));
  ok(calls.some((c) => c.m === 'DELETE' && c.path === `/api/rooms/${R}/panels/${N}`) && !ep.some((p) => p.id === N), 'Remove from room: DELETE, no confirm; the panel is gone', ep);
  ok(rt.t === 'Removed Notebook' && rt.b === 'Undo', '...a toast "Removed Notebook · Undo"', rt);
  await page.click('.rm-toast .act');
  await sleep(1200);
  ep = await enginePanels();
  ok(ep.some((p) => p.title === 'Notebook'), 'Undo registers it again', ep);
  /* an APP panel (app_slug from the engine): Remove = DELETE .../apps/:slug */
  const appPanel = ((await call(`/api/rooms/${R}/panels`)).body?.panels ?? []).find((p) => p.app_slug === 'room-tasks');
  ok(!!appPanel, 'setup: Room Tasks\' panel carries app_slug in the room view', appPanel && { id: appPanel.id, app_slug: appPanel.app_slug });
  await page.keyboard.press('Escape');
  await page.click(cellHead(appPanel.id), { button: 'right' });
  await sleep(300);
  const t2 = await page.evaluate(() => document.querySelector('.rsm-menu .rsm-mt')?.textContent);
  ok(t2 === 'TasksRoom Tasks', 'an app\'s panel: the title row names the app ("Tasks · Room Tasks")', t2);
  calls.length = 0;
  await page.click('.rsm-menu [data-a="rem"]');
  await sleep(700);
  ok(calls.some((c) => c.m === 'DELETE' && c.path === `/api/rooms/${R}/apps/room-tasks`) && !calls.some((c) => c.path.includes('/panels/')), '...and its Remove calls DELETE .../apps/:slug', calls);
  const gone = ((await call(`/api/rooms/${R}/apps`)).body?.apps ?? []).map((a) => a.slug);
  const at = await page.evaluate(() => ({ t: document.querySelector('.rm-toast .tx')?.textContent }));
  ok(!gone.includes('room-tasks') && at.t === 'Removed Room Tasks', '...the app leaves the room; the toast names the app', { gone, at });
  await page.click('.rm-toast .act');
  await sleep(1200);
  ok(((await call(`/api/rooms/${R}/apps`)).body?.apps ?? []).some((a) => a.slug === 'room-tasks'), 'its Undo adds the app back (POST .../apps)');
  /* ========================= 9b. a NEW room (the manager) ========================= */
  await page.goto(`${BASE}/manager.html`, { waitUntil: 'domcontentloaded' });
  await sleep(1000);
  await page.click('#roomNewCard'); // Assemble is the New-room sheet's second path
  await page.click('#assembleBtn');
  await page.waitForSelector('.ras-sheet [role="tab"]', { timeout: 6000 });
  await sleep(300);
  const nr = await page.evaluate(() => {
    const name = document.querySelector('.ras-room .ras-name');
    const seg = document.querySelector('.ras-seg');
    return { title: document.querySelector('.ras-sh .t')?.textContent, above: !!name && !!seg && (name.compareDocumentPosition(seg) & Node.DOCUMENT_POSITION_FOLLOWING) > 0, focus: document.activeElement?.dataset.fid };
  });
  ok(nr.title === 'New room' && nr.above && nr.focus === 'newname', 'a NEW room: the same sheet, the name field ABOVE the tabs (and focused)', nr);
  const segOf = () => page.evaluate(() => ({
    segs: [...document.querySelectorAll('.ras-mode button')].map((b) => [b.textContent, b.getAttribute('aria-pressed')]),
    name: !!document.querySelector('.ras-room .ras-name input'), sel: [...document.querySelectorAll('.ras-room select')].map((x) => [...x.options].map((o) => o.textContent)),
    title: document.querySelector('.ras-sh .t')?.textContent,
  }));
  let sg = await segOf();
  ok(JSON.stringify(sg.segs) === JSON.stringify([['New room', 'true'], ['Existing room', 'false']]) && sg.name && sg.sel.length === 0, '[New room | Existing room]: New shows ONLY the name field', sg);
  await page.click('[data-fid="mode-existing"]');
  sg = await segOf();
  ok(sg.segs[1][1] === 'true' && !sg.name && sg.sel.length === 1 && sg.sel[0][0] === 'Pick a room' && sg.sel[0].includes('Alpha-Platform Apps') && !sg.sel[0].some((t) => /New room/.test(t)),
    '...Existing shows ONLY a room select, in the same slot (no mixed select)', sg);
  await page.selectOption('.ras-room select', { label: 'Alpha-Platform Apps' });
  await shot(page, 'existing-room');
  await sleep(300);
  ok((await segOf()).title === 'Add to Alpha-Platform Apps', '...picking a room makes it the sheet\'s room', (await segOf()).title);
  await page.click('[data-fid="mode-new"]');
  await page.fill('.ras-room .ras-name input', 'Fresh Room');
  await page.click('.ras-proj[data-recipe="rec-bb"] .nm');
  await page.click('#rasTab-apps');
  await sleep(1000);
  await page.click('.ras-app[data-slug="room-assets"] .acts button');
  await sleep(200);
  await page.click('.ras-app[data-slug="image-studio"] .acts button'); // held by Sheet Probe now (moved there above)
  await sleep(200);
  const pend = await page.evaluate(() => ({
    word: document.querySelector('.ras-app[data-slug="room-assets"] .ras-st')?.textContent,
    mv: document.querySelector('.ras-app[data-slug="image-studio"] .ras-st')?.textContent, dlg: !!document.querySelector('.ras-card'),
    go: document.querySelector('.ras-go')?.textContent, tip: document.querySelector('.ras-go')?.title, note: document.querySelector('.ras-ft .ras-note')?.textContent || '',
    tabN: document.querySelector('#rasTab-apps .n')?.textContent,
  }));
  ok(pend.word === 'Adds with the room' && pend.mv === 'Moves here with the room' && !pend.dlg && pend.tabN === '2', 'Apps in a new room: "Adds with the room" / "Moves here with the room" (no dialog yet)', pend);
  ok(pend.go === 'Create room · add 3' && pend.tip === '1 agent · 2 apps' && !pend.note, '"Create room · add 3" counts agents + apps; its tooltip says "1 agent · 2 apps"', pend);
  calls.length = 0;
  await ctl(studio, { jobs: 0, noSeat: false });
  const popP = page.context().waitForEvent('page', { timeout: 15000 }).catch(() => null);
  await page.click('.ras-go');
  await page.waitForSelector('.ras-card', { timeout: 8000 }).catch(() => null);
  const atCreate = await page.evaluate(() => ({ h: document.querySelector('.ras-card .hd')?.textContent, lis: [...document.querySelectorAll('.ras-card li')].map((l) => l.textContent), sheet: !!document.querySelector('.ras-scrim') }));
  ok(atCreate.sheet && atCreate.h === 'Move Image Studio here?' && /^It leaves "Sheet Probe"/.test(atCreate.lis[0] || ''), 'Create: the Move-with-room still gets its CONFIRM, now, in the open sheet', atCreate);
  await page.click('.ras-card [data-a="ok"]');
  const pop = await popP;
  await sleep(1500);
  const made = pop ? new URL(pop.url()).searchParams.get('room') : null;
  if (pop) { await pop.close(); }
  const mv = made ? (await call(`/api/rooms/${made}`)).body : null;
  const mApps = made ? ((await call(`/api/rooms/${made}/apps`)).body?.apps ?? []).map((a) => a.slug) : [];
  ok(calls.some((c) => c.path === '/api/rooms' && c.body?.name === 'Fresh Room') && !calls.some((c) => c.path === '/api/rooms/assemble'), 'no live tab ticked: the room is made with POST /api/rooms (no assemble)', calls.map((c) => c.path));
  ok(mv?.room?.name === 'Fresh Room' && mv.seats.some((x) => x.handle === 'kiosk' && x.occupant?.id) && mApps.includes('room-assets') && mApps.includes('image-studio'),
    '...then the project is added AND started, the app added and the confirmed move made, in that room; the room opens', { room: mv?.room?.name, seats: mv?.seats?.map((x) => [x.handle, x.occupant?.id]), apps: mApps });
  ok(mv?.room?.lead_seat && mv.seats.find((x) => x.id === mv.room.lead_seat)?.handle === 'kiosk', '...its first persistent seat leads', mv?.room?.lead_seat);

  ok(errors.length === 0, 'no page errors (desktop)', errors.slice(0, 3));

  /* ================================ 10. phone ================================ */
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: await context.storageState() });
  await phone.addInitScript(() => {
    Object.defineProperty(window.screen, 'width', { get: () => 390 });
    Object.defineProperty(window.screen, 'height', { get: () => 844 });
  });
  const pp = await phone.newPage();
  const perr = [];
  pp.on('pageerror', (e) => perr.push(String(e)));
  await pp.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
  await sleep(1500);
  /* opened by a TAP (after a key press: the LAST input decides): focus goes
     into the sheet, but the Agents segment draws NO ring (r22c review) */
  await pp.keyboard.press('Shift');
  await pp.tap('#phAgents');
  await sleep(400);
  await pp.tap('.ph-h3add .cell-hadd'); // the phone's "+": the same one add flow
  await pp.waitForSelector('.ras-sheet [role="tab"]', { timeout: 6000 });
  await sleep(300);
  const tr = await pp.evaluate(() => { const a = document.activeElement; return { id: a?.id, fv: !!a?.matches(':focus-visible'), outline: getComputedStyle(a).outlineStyle, quiet: a?.hasAttribute('data-quiet-focus') }; });
  ok(tr.id === 'rasTab-agents' && !tr.fv && tr.outline === 'none' && tr.quiet, 'phone: a TAP on + focuses the Agents segment with NO teal ring', tr);
  await pp.evaluate(() => document.querySelector('.ras-proj[data-recipe="rec-bb"]').click());
  await sleep(300);
  const measure = () => pp.evaluate(() => {
    const s = document.querySelector('.ras-sheet');
    const r = s.getBoundingClientRect();
    const small = [...s.querySelectorAll('button, select, .ras-fld, [role="checkbox"]')]
      .filter((e) => e.offsetParent !== null)
      .map((e) => ({ what: e.className || e.tagName, t: (e.textContent || '').slice(0, 20), h: Math.round(e.getBoundingClientRect().height), l: Math.round(e.getBoundingClientRect().left), r: Math.round(e.getBoundingClientRect().right) }))
      .filter((x) => x.h < 44);
    const fs = [...s.querySelectorAll('input, select, textarea')].filter((e) => e.offsetParent !== null).map((e) => getComputedStyle(e).fontSize);
    const out = [...s.querySelectorAll('*')].filter((e) => e.offsetParent !== null && e.getBoundingClientRect().right > innerWidth + 0.5).map((e) => e.className || e.tagName).slice(0, 5);
    return { vw: innerWidth, vh: innerHeight, top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width), sw: document.documentElement.scrollWidth, bodySw: s.querySelector('.ras-body').scrollWidth, bodyW: s.querySelector('.ras-body').clientWidth, small, fs, out };
  });
  let m = await measure();
  ok(m.top === 0 && m.h === m.vh && m.w === m.vw, 'phone: a FULL-HEIGHT sheet', m);
  ok(m.sw <= m.vw && m.bodySw <= m.bodyW && m.out.length === 0, 'phone: no sideways scroll', { sw: m.sw, vw: m.vw, bodySw: m.bodySw, bodyW: m.bodyW, out: m.out });
  ok(m.small.length === 0, 'phone (Agents): every target is at least 44px', m.small);
  ok(m.fs.every((f) => f === '16px'), 'phone: fields at 16px (no focus zoom)', m.fs);
  const pg = await pp.evaluate(() => {
    const row = document.querySelector('.ras-proj[data-recipe="rec-bb"]');
    const R = (e) => e.getBoundingClientRect();
    const me = row.querySelector('.ras-me');
    return {
      how: [...row.querySelectorAll('.ras-how button')].map((b) => [Math.round(R(b).height), Math.round(R(b).width)]),
      howW: Math.round(R(row.querySelector('.ras-how')).width), moreW: Math.round(R(row.querySelector('.more')).width),
      sels: [...me.querySelectorAll('select')].map((x) => ({ t: Math.round(R(x).top), b: Math.round(R(x).bottom), l: Math.round(R(x).left), w: Math.round(R(x).width), h: Math.round(R(x).height) })),
      labs: [...me.querySelectorAll('.ras-mlab')].map((x) => ({ text: x.textContent, t: Math.round(R(x).top), b: Math.round(R(x).bottom), l: Math.round(R(x).left), sel: Math.round(R(x.parentElement.querySelector('select')).top) })),
      opt0: [...me.querySelectorAll('select')].map((x) => x.options[0].textContent),
      meW: Math.round(R(me).width), meL: Math.round(R(me).left),
      fresh: Math.round(R(row.querySelector('.ras-fresh')).height),
    };
  });
  ok(pg.how.every(([h]) => h === 44) && Math.abs(pg.howW - pg.moreW) <= 1, 'phone: [New | Resume] 44px, across the row', pg);
  ok(pg.sels.length === 2 && pg.sels.every((x) => x.w === pg.meW && x.l === pg.meL && x.h === 44) && pg.labs[1].t - pg.sels[0].b === 8,
    'phone (390): Model and Effort one full row each, stacked (the Effort label 8px under the Model field)', { sels: pg.sels, labs: pg.labs });
  ok(JSON.stringify(pg.labs.map((x) => x.text)) === '["Model","Effort"]' && pg.labs.every((x) => x.l === pg.meL && x.b + 4 === x.sel) && JSON.stringify(pg.opt0) === JSON.stringify(["Default (claude's)", "Default (claude's)"]),
    `phone: each labelled (Model / Effort) directly above its field; the defaults read "Default (claude's)"`, { labs: pg.labs, opt0: pg.opt0 });
  ok(pg.fresh >= 44, 'phone: the fresh box is a 44px target', pg.fresh);
  await shot(pp, 'phone-agents');
  await pp.evaluate(() => document.querySelector('#rasTab-apps').click());
  await sleep(600);
  m = await measure();
  ok(m.small.length === 0 && m.sw <= m.vw && m.out.length === 0, 'phone (Apps): 44px targets, no sideways scroll', { small: m.small, out: m.out });
  await shot(pp, 'phone-apps');
  await pp.evaluate(() => document.querySelector('.ras-x').click());
  await sleep(200);
  /* the phone panel menu: on the Apps sheet's rows, ⋯ always shown, 44px, a bottom sheet */
  await pp.evaluate(() => document.getElementById('lySwitch').click()); // the Apps list lives in ⇄ Switch now [web/room-phone-7]
  await sleep(400);
  const pm = await pp.evaluate(() => {
    const b = document.querySelector('#phSheetBody .seat-app .rsm-more');
    const r = b?.getBoundingClientRect();
    return b && { op: getComputedStyle(b).opacity, w: Math.round(r.width), h: Math.round(r.height), label: b.getAttribute('aria-label') };
  });
  ok(pm && pm.op === '1' && pm.w >= 44 && pm.h >= 44, 'phone: an app row in the Apps sheet has the panel ⋯, always shown, 44px', pm);
  await pp.evaluate(() => document.querySelector('#phSheetBody .seat-app .rsm-more').click());
  await sleep(300);
  const psheet = await pp.evaluate(() => {
    const m = document.querySelector('.rsm-menu');
    const r = m?.getBoundingClientRect();
    return m && { sheet: m.classList.contains('is-sheet'), bottom: Math.round(r.bottom), vh: innerHeight, items: [...m.querySelectorAll('.rsm-mi')].map((x) => [x.dataset.a, Math.round(x.getBoundingClientRect().height), x.getAttribute('aria-disabled')]) };
  });
  ok(psheet && psheet.sheet && psheet.bottom === psheet.vh && psheet.items.every((x) => x[1] >= 44), 'phone: the panel menu is a bottom sheet with 44px+ items', psheet);
  await shot(pp, 'phone-panel-menu');
  ok(psheet && psheet.items.find((x) => x[0] === 'fold')?.[2] === 'true', '...Collapse is disabled there (an app has its own screen), with a reason', psheet?.items);
  ok(perr.length === 0, 'no page errors on the phone', perr.slice(0, 3));
  await phone.close();
} catch (e) {
  ok(false, `probe crashed: ${e?.stack ?? e}`);
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  app.close();
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures ? `\n${failures} FAILED, ${passes} passed` : `\nall ${passes} passed`);
process.exit(failures ? 1 : 0);
