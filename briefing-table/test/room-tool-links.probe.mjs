/* LINE LINKS INTO A TOOL VIEW [rooms/tool-links], the page's half.
 *
 *   node test/room-tool-links.probe.mjs
 *
 * What only a browser can prove (desktop 1280x800, then phone 390x844),
 * against FAKE tool apps whose tool.json declares links + "@meta":
 *   - ONE link = the chip: in the bubble after the body, 28px (40 on a
 *     phone), the tool icon in the accent, the label ellipsised, the tooltip
 *     "label · tool"; click -> the preview column shows the app's view at
 *     view_path (the real frame proxy, the real app); Expand -> LARGE (the
 *     modal, min(1100,92vw) x min(760,88vh)), focus trapped, Esc closes it
 *     back to the column, focus returns to Expand; Shift+click -> LARGE
 *     directly; the menu: Open in preview · Open large · Copy link (the copied
 *     link = #line-<id>~<tool>:<ref>, and opening it opens the view);
 *   - UNAVAILABLE: disabled (aria-disabled, .55), never hidden, the reason in
 *     the tooltip: left the room · in "<room>" now · Not running · Changed —
 *     needs approval; a click opens nothing; the menu keeps only Copy link;
 *   - TWO OR MORE = the list: the caption "<Tool> · n items", 4 rows then
 *     "Show 2 more"; the @meta batch fills thumbs + states (Waiting / Replied /
 *     Resolved), a superseded row stays clickable (dim, the note), a gone row
 *     is disabled; mixed tools: no caption, an icon per row; a SLOW batch
 *     (> 4 s) and a FAILING batch leave label-only rows, never an error;
 *   - {panel:'compose', text}: an empty composer is set, a non-empty one gets
 *     it at the caret with spaces; newlines stripped; never sent; 1 a second
 *     per frame; ignored from a non-app panel; from the large view the modal
 *     closes; the draft holds it;
 *   - phone: 40px chips, 56px rows, no Expand, no "Open large", no sideways
 *     scroll.
 *
 * OFF LINUX (win32): the engine's verifyEndpoint refuses every tool endpoint
 * by design (rooms/apps-sec: it reads /proc), so no fake tool ever RUNS and
 * no app panel exists. There the probe runs what needs no running tool (the
 * chip's place and size, every unavailable reason, disabled chips and rows,
 * the list's shape, Copy link, no sideways scroll) and SKIPS, with a printed
 * reason, the running-chip + preview / large / @meta batch / compose path.
 * Linux runs everything.
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(219), DEAD broker
 * P(220), the plain panel host P(221); the fake apps take ephemeral ports.
 * Temp table + tools dir, childEnv() scrubbed, fabric + NATS off.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv, windowCookie, roomUserWrite } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(219);
const DEAD_BROKER_PORT = P(220);
const PLAIN_PORT = P(221);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-tool-links-token';
const DASH = String.fromCharCode(8212);

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* Only on Linux can a fake tool RUN (see the header). */
const RUNS = process.platform === 'linux';
const skip = (what) => console.log(`  skip  ${what}  (${process.platform}: verifyEndpoint refuses every tool endpoint off Linux, so no tool runs here)`);

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
    console.log(` FAIL  :${PORT} is already serving something ${DASH} a leaked engine from an aborted run?`);
    process.exit(1);
  }
} catch { /* nothing there */ }
for (const p of [PORT, DEAD_BROKER_PORT, PLAIN_PORT]) {
  await assertFree(p, 'room-tool-links.probe.mjs');
}

/* the PLAIN panel host (a non-app panel: its compose must be ignored) */
const plain = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(req.method === 'HEAD' ? undefined : '<!doctype html><p>plain panel</p>');
});
await new Promise((r) => plain.listen(PLAIN_PORT, '127.0.0.1', r));

/* A FAKE TOOL APP: its own process, cwd = the tool root (the engine verifies
   who listens). Serves the panel view, review/:n pages, a 1x1 PNG per thumb,
   and the "@meta" batch; /__ctl steers the batch (delayMs, fail). */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const STUB_SRC = `
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
const state = { delayMs: 0, fail: false, metaCalls: 0 };
const STATES = { '1': 'waiting', '2': 'replied', '3': 'resolved' };
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readJson = (req) => new Promise((r) => { let raw = ''; req.on('data', (d) => (raw += d)); req.on('end', () => { try { r(JSON.parse(raw || '{}')); } catch { r({}); } }); });
const srv = createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.pathname.startsWith('/health')) return json(res, 200, { ok: true });
  if (u.pathname === '/__ctl' && req.method === 'POST') { Object.assign(state, await readJson(req)); return json(res, 200, state); }
  if (u.pathname === '/__state') return json(res, 200, state);
  if (/^\\/rooms\\/[^/]+\\/links$/.test(u.pathname)) {
    state.metaCalls += 1;
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    if (state.fail) return json(res, 500, { error: 'boom' });
    const refs = (u.searchParams.get('refs') || '').split(',').filter(Boolean);
    return json(res, 200, { items: refs.map((ref) => {
      const n = ref.split('/').pop();
      const it = { ref, thumb: 'thumbs/' + n + '.png' };
      if (STATES[n]) it.state = STATES[n];
      if (n === '5') { it.stale = 'superseded'; it.note = 'superseded by #6'; }
      if (n === '6') { it.stale = 'gone'; it.note = 'deleted by the author'; }
      return it;
    }) });
  }
  if (/\\/thumbs\\/[0-9]+\\.png$/.test(u.pathname)) {
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(req.method === 'HEAD' ? undefined : Buffer.from('${PNG}', 'base64'));
  }
  const m = /\\/review\\/([0-9]+)$/.exec(u.pathname);
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(req.method === 'HEAD' ? undefined : '<!doctype html><title>v</title><p id="what">' + (m ? 'review ' + m[1] : 'app view ' + u.pathname) + '</p>');
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

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-tool-links-'));
const dbPath = join(tmpDir, 'mapping.db');
const toolsDir = join(tmpDir, 'tools');
const LINKS = {
  'review/:n': { label: 'Review item', view: 'GET /rooms/:roomId/review/:n' },
  '@meta': 'GET /rooms/:roomId/links',
};
const tool = (slug, name, x = {}) => ({
  contract: 'tool/draft-0', name, slug, version: x.version ?? '0.1.0', description: `${name}.`,
  access: x.access ?? 'shared', endpoint: { bind: '127.0.0.1', discover: 'status/app.json#port' },
  panels: [{ title: name, icon: x.icon ?? 'image', view: 'GET /rooms/:roomId/view', scripts: true }],
  links: LINKS,
});
function writeTool(slug, t) {
  const root = join(toolsDir, slug);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'tool.json'), JSON.stringify(t, null, 2));
  return root;
}
const ROOTS = {
  studio: writeTool('studio', tool('studio', 'Image Studio')),
  'gone-tool': writeTool('gone-tool', tool('gone-tool', 'Gone Tool', { icon: 'tasks' })),
  mover: writeTool('mover', tool('mover', 'Mover', { access: 'exclusive' })),
  changer: writeTool('changer', tool('changer', 'Changer')),
  sleepy: writeTool('sleepy', tool('sleepy', 'Sleepy')),
};
const STUB = join(tmpDir, 'fake-app.mjs');
writeFileSync(STUB, STUB_SRC);
const RUNNING = {};
for (const slug of ['studio', 'gone-tool', 'mover', 'changer']) {
  RUNNING[slug] = await startApp(STUB, ROOTS[slug]);
}
const studio = RUNNING.studio;

let engine = null;
let browser = null;
let engineLog = '';
const seed = async (plan) => {
  const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
  return JSON.parse(r.out.trim().split('\n').pop());
};

try {
  await seed({ recipes: [{ id: 'rec-lead', name: 'Leader', projectDir: '/srv/x/leader', vendor: 'claude-code', agent: 'leader', color: '#1f5fbf' }] });
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

  const LEAD = 'recipe:rec-lead';
  const post = await seed({
    sessions: [{ paneid: LEAD, recipe_id: 'rec-lead', vendor: 'claude-code', agent: 'leader', state: 'live' }],
    rooms: [{ name: 'Links Room', seats: [{ handle: 'leader', recipe_id: 'rec-lead', occupant: LEAD }] }],
  });
  const R = post.rooms[0].id;
  const OTHER = (await call('/api/rooms', { json: { name: 'Other Room' } })).body;
  for (const [slug, root] of Object.entries(ROOTS)) {
    const r = await call('/api/apps', { json: { root }, user: true });
    if (r.status !== 200) { throw new Error(`register ${slug}: ${JSON.stringify(r)}`); }
  }
  for (const slug of Object.keys(ROOTS)) {
    const r = await call(`/api/rooms/${R}/apps`, { json: { slug } });
    if (r.status !== 200) { throw new Error(`add ${slug}: ${JSON.stringify(r)}`); }
  }
  const pr = await call(`/api/rooms/${R}/panels`, { json: { title: 'Plain', url: `http://127.0.0.1:${PLAIN_PORT}/plain/`, icon: 'tasks', scripts: true } });
  ok(pr.status === 200, 'setup: a plain (non-app) panel with scripts', pr.status);

  const LINE = `/api/rooms/${R}/line`;
  const say = async (text, links) => {
    const r = await call(LINE, { json: { text, from: { paneid: LEAD }, links } });
    if (r.status !== 200) { throw new Error(`post ${text}: ${JSON.stringify(r.body)}`); }
    return r.body.entries[0];
  };
  const L = (tool, n, label) => ({ tool, ref: `review/${n}`, ...(label ? { label } : {}) });
  const chipLine = await say('one for you', [L('studio', 2, '#2 her shoes')]);
  const listLine = await say('six to review', [1, 2, 3, 4, 5, 6].map((n) => L('studio', n, `#${n} look ${n}`)));
  const goneLine = await say('gone tool', [L('gone-tool', 1, 'Gone item')]);
  const moverLine = await say('mover', [L('mover', 1, 'Mover item')]);
  const changerLine = await say('changer', [L('changer', 1, 'Changer item')]);
  const sleepyLine = await say('sleepy', [L('sleepy', 1, 'Sleepy item')]);
  const mixedLine = await say('mixed', [L('studio', 7, 'Studio seven'), L('sleepy', 2, 'Sleepy two')]);
  /* now make them unavailable, AFTER the lines were written */
  ok((await call(`/api/rooms/${R}/apps/gone-tool`, { method: 'DELETE', user: true })).status === 200, 'setup: gone-tool left the room');
  ok((await call(`/api/rooms/${OTHER.id}/apps`, { json: { slug: 'mover', move: true } })).status === 200, 'setup: mover moved to "Other Room"');
  writeFileSync(join(ROOTS.changer, 'tool.json'), JSON.stringify(tool('changer', 'Changer', { version: '0.2.0' }), null, 2));
  const cat = (await call('/api/apps')).body.apps;
  ok(cat.find((a) => a.slug === 'changer')?.status === 'held' && cat.find((a) => a.slug === 'studio')?.links_meta === 'links',
    'setup: changer is held; the catalog carries studio links_meta', cat.map((a) => [a.slug, a.status]));

  browser = await chromium.launch({ headless: true });
  for (const vp of [{ name: 'desktop', width: 1280, height: 800, touch: false }, { name: 'phone', width: 390, height: 844, touch: true }]) {
    console.log(`--- ${vp.name} ${vp.width}x${vp.height}`);
    await ctl(studio, { delayMs: 0, fail: false });
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.touch });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => {
      const f = document.querySelector('form');
      (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
    }, TOKEN);
    await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
    await call(`/api/rooms/${R}/draft`, { method: 'PUT', json: { text: '', reply_to: null }, user: true });
    const ROOM = `${BASE}/room.html?room=${R}`;
    const li = (id) => `#line li[data-id="${id}"]`;
    const openRoom = async (hash = '') => {
      await page.goto(ROOM + hash, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(`${li(mixedLine.id)} .tl-list`);
      await sleep(700);
    };
    const activate = async (sel, force = false) => {
      if (vp.touch) { await page.tap(sel, { force }); } else { await page.click(sel, { force }); }
    };
    const pv = () => page.evaluate(() => {
      const el = document.querySelector('.rm-pv');
      const f = el?.querySelector('.pv-view:not([hidden]) iframe');
      return { open: !!el && !el.hidden, name: el?.querySelector('.pv-name')?.textContent ?? null, src: f?.getAttribute('src') ?? null, ex: el ? !el.querySelector('.pv-ex').hidden && getComputedStyle(el.querySelector('.pv-ex')).display !== 'none' : false };
    });
    const frameText = async (sel) => {
      const h = await page.waitForSelector(sel, { state: 'attached', timeout: 5000 }).catch(() => null);
      const f = await h?.contentFrame();
      if (!f) { return null; }
      await f.waitForSelector('#what', { timeout: 5000 }).catch(() => {});
      return f.evaluate(() => document.querySelector('#what')?.textContent ?? null).catch(() => null);
    };
    const closePv = () => page.evaluate(() => document.querySelector('.rm-pv .pv-x')?.click() || document.querySelector('.rm-pv .pv-back')?.click());
    await openRoom();

    let p = null;
    /* ---- 1. the chip ---- */
    const chip = `${li(chipLine.id)} .tl-chip`;
    const c1 = await page.evaluate((s) => {
      const b = document.querySelector(s);
      const bubble = b?.closest('.entry-bubble');
      const kids = bubble ? [...bubble.children].map((n) => n.classList[0] ?? '') : []; // the first class: a disabled box adds is-off
      const cs = b ? getComputedStyle(b) : null;
      const ic = b?.querySelector('.tl-ic');
      return {
        order: kids, h: b?.getBoundingClientRect().height, label: b?.querySelector('.tl-lab')?.textContent, title: b?.title,
        radius: cs?.borderTopLeftRadius, icColor: ic ? getComputedStyle(ic).color : null, svg: !!ic?.querySelector('svg'),
        accent: getComputedStyle(document.documentElement).getPropertyValue('--teal').trim(),
      };
    }, chip);
    ok(c1.order.indexOf('tl-chips') > c1.order.indexOf('entry-body') && c1.order.indexOf('entry-body') >= 0, 'the chip sits in the bubble, after the body', c1.order);
    ok(Math.round(c1.h) === (vp.touch ? 40 : 28), `the chip is ${vp.touch ? 40 : 28}px tall`, c1.h);
    if (!RUNS) {
      ok(c1.label === '#2 her shoes' && c1.title === 'Not running' && c1.radius === '6px' && c1.svg, 'label, r6, the tool icon; no tool runs here: tooltip "Not running"', c1);
      skip('the running chip: click -> preview, Expand -> LARGE, Shift+click, its full menu, opening the copied link');
    } else {
    ok(c1.label === '#2 her shoes' && c1.title === `#2 her shoes ${String.fromCharCode(183)} Image Studio` && c1.radius === '6px' && c1.svg, 'label, tooltip "label · tool", r6, the tool icon', c1);
    await activate(chip);
    await sleep(600);
    p = await pv();
    ok(p.open && p.name === '#2 her shoes' && /\/frame\/t\/[^/]+\/review\/2\?surface=preview$/.test(p.src ?? ''), 'click: the preview column shows the view at view_path through the frame proxy, with ?surface=preview', p);
    ok((await frameText('.rm-pv .pv-view:not([hidden]) iframe')) === 'review 2', '...and the app served review 2');
    ok(p.ex === !vp.touch, vp.touch ? 'phone: no Expand' : 'the column shows Expand (desktop)', p.ex);

    if (!vp.touch) {
      /* ---- 2. LARGE from Expand; Esc back to the column ---- */
      await page.click('.rm-pv .pv-ex');
      await sleep(500);
      const lg = await page.evaluate(() => {
        const card = document.querySelector('.tl-lg');
        const r = card?.getBoundingClientRect();
        return { open: !!card, w: r?.width, h: r?.height, t: card?.querySelector('.tl-lg-t')?.textContent, focus: document.activeElement?.className ?? '', src: card?.querySelector('iframe')?.getAttribute('src') ?? null, scrim: !!document.querySelector('.tl-lg-scrim') };
      });
      ok(lg.open && lg.scrim && Math.round(lg.w) === 1100 && Math.round(lg.h) === 704, 'Expand: the modal is min(1100,92vw) x min(760,88vh) over the scrim', lg);
      ok(lg.t === '#2 her shoes' && /review\/2\?surface=large$/.test(lg.src ?? '') && /tl-lg-x/.test(lg.focus), '...the label, the same view with ?surface=large, focus on its close', lg);
      ok((await frameText('.tl-lg iframe')) === 'review 2', '...the app frame is live in the modal');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      const trapped = await page.evaluate(() => !!document.activeElement?.closest('.tl-lg'));
      ok(trapped, 'focus is trapped inside the modal');
      await page.focus('.tl-lg-x');
      await page.keyboard.press('Escape');
      await sleep(250);
      const after = await page.evaluate(() => ({ modal: !!document.querySelector('.tl-lg'), pv: !document.querySelector('.rm-pv').hidden, focus: document.activeElement?.className ?? '' }));
      ok(!after.modal && after.pv && after.focus === 'pv-ex', 'Esc closes the modal back to the column (not both); focus returns to Expand', after);
      await closePv();
      await sleep(250);

      /* ---- 3. Shift+click = LARGE directly ---- */
      await page.click(chip, { modifiers: ['Shift'] });
      await sleep(500);
      const sh = await page.evaluate(() => ({ modal: !!document.querySelector('.tl-lg'), pv: !document.querySelector('.rm-pv').hidden }));
      ok(sh.modal && !sh.pv, 'Shift+click opens LARGE directly (the column stays shut)', sh);
      await page.click('.tl-lg-x');
      await sleep(250);
      ok(await page.evaluate(() => document.activeElement?.classList.contains('tl-chip')), '✕ closes it; focus returns to the chip');
    } else {
      await closePv();
      await sleep(250);
    }

    /* ---- 4. the chip's menu; Copy link; the link opens the view ---- */
    await page.dispatchEvent(chip, 'contextmenu', { clientX: 200, clientY: 200 });
    await sleep(250);
    const menu = await page.evaluate(() => {
      const m = document.querySelector('.rsm-menu[data-menu="toollink"]');
      return m ? { items: [...m.querySelectorAll('.rsm-mi')].map((b) => b.textContent.replace(/Shift\+click$/, '')), sheet: m.classList.contains('is-sheet'), title: m.querySelector('.rsm-mt')?.textContent } : null;
    });
    const wantItems = vp.touch ? ['Open in preview', 'Copy link'] : ['Open in preview', 'Open large', 'Copy link'];
    ok(JSON.stringify(menu?.items) === JSON.stringify(wantItems) && /#2 her shoes/.test(menu?.title ?? '') && menu?.sheet === vp.touch, `the menu: ${wantItems.join(' · ')}${vp.touch ? ' (a sheet)' : ''}`, menu);
    await page.click('.rsm-menu[data-menu="toollink"] .rsm-mi[data-a="copy"]');
    await sleep(300);
    const copied = await page.evaluate(() => navigator.clipboard.readText().catch((e) => `ERR ${e}`));
    const wantLink = `${ROOM}#line-${chipLine.id}~studio:review/2`;
    ok(copied === wantLink, 'Copy link = the line link + ~tool:ref', copied);
    await page.goto('about:blank');
    await openRoom(`#line-${chipLine.id}~studio:review/2`);
    await sleep(800);
    p = await pv();
    ok(p.open && /review\/2\?surface=preview$/.test(p.src ?? ''), 'opening the copied link opens the view', p);
    await closePv();
    await sleep(200);
    }
    if (!RUNS) {
      /* Copy link works on a disabled chip too (its menu keeps only that) */
      await page.dispatchEvent(chip, 'contextmenu', { clientX: 200, clientY: 200 });
      await sleep(250);
      const wm = await page.evaluate(() => [...document.querySelectorAll('.rsm-menu[data-menu="toollink"] .rsm-mi')].map((b) => b.textContent));
      ok(JSON.stringify(wm) === JSON.stringify(['Copy link']), "the chip's menu (not running): Copy link only", wm);
      await page.click('.rsm-menu[data-menu="toollink"] .rsm-mi[data-a="copy"]');
      await sleep(300);
      const copiedW = await page.evaluate(() => navigator.clipboard.readText().catch((e) => `ERR ${e}`));
      ok(copiedW === `${ROOM}#line-${chipLine.id}~studio:review/2`, 'Copy link = the line link + ~tool:ref', copiedW);
    }

    /* ---- 5. unavailable chips ---- */
    const reasons = [
      [goneLine.id, "Gone Tool isn't in this room any more"],
      [moverLine.id, 'Mover is in "Other Room" now'],
      [changerLine.id, `Changed ${DASH} needs approval`],
      [sleepyLine.id, 'Not running'],
    ];
    for (const [id, why] of reasons) {
      const u = await page.evaluate((s) => {
        const b = document.querySelector(s);
        return b ? { dis: b.getAttribute('aria-disabled'), op: getComputedStyle(b).opacity, title: b.title, shown: b.getBoundingClientRect().width > 0 } : null;
      }, `${li(id)} .tl-chip`);
      ok(u?.dis === 'true' && u.op === '0.55' && u.title === why && u.shown, `disabled, shown, "${why}"`, u);
    }
    await activate(`${li(sleepyLine.id)} .tl-chip`, true);
    await sleep(300);
    ok(!(await pv()).open, 'a disabled chip opens nothing');
    await page.dispatchEvent(`${li(goneLine.id)} .tl-chip`, 'contextmenu', { clientX: 200, clientY: 300 });
    await sleep(200);
    const dm = await page.evaluate(() => [...document.querySelectorAll('.rsm-menu[data-menu="toollink"] .rsm-mi')].map((b) => b.textContent));
    ok(JSON.stringify(dm) === JSON.stringify(['Copy link']), "a disabled link's menu keeps only Copy link", dm);
    await page.keyboard.press('Escape');
    await sleep(150);

    /* ---- 6. the list ---- */
    await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), `${li(listLine.id)} .tl-list`);
    await sleep(900);
    const ls = await page.evaluate((s) => {
      const box = document.querySelector(s);
      const rows = [...box.querySelectorAll('.tl-row')];
      return {
        cap: box.querySelector('.tl-cap')?.textContent, visible: rows.filter((r) => !r.hidden).length, more: box.querySelector('.tl-more')?.textContent ?? null,
        rows: rows.map((r) => ({
          h: Math.round(r.getBoundingClientRect().height) || null, n: r.querySelector('.tl-n')?.textContent, lab: r.querySelector('.tl-lab')?.textContent,
          st: r.querySelector('.tl-st')?.textContent, stCls: r.querySelector('.tl-st')?.className, dis: r.getAttribute('aria-disabled'),
          stale: r.classList.contains('is-stale'), img: r.querySelector('.tl-th img')?.naturalWidth ?? 0, thW: Math.round(r.querySelector('.tl-th')?.getBoundingClientRect().width ?? 0),
          imgOp: r.querySelector('.tl-th img') ? getComputedStyle(r.querySelector('.tl-th img')).opacity : null, title: r.title,
        })),
      };
    }, `${li(listLine.id)} .tl-list`);
    const DOT = String.fromCharCode(183);
    ok(ls.cap === `Image Studio ${DOT} 6 items${RUNS ? '' : ` ${DOT} Not running`}`, `the caption: "Image Studio ${DOT} 6 items"${RUNS ? '' : ' + the reason once'}`, ls.cap);
    ok(ls.visible === 4 && ls.more === 'Show 2 more', '4 rows, then "Show 2 more"', [ls.visible, ls.more]);
    const r = ls.rows;
    if (!RUNS) {
      ok(r[0].h === (vp.touch ? 56 : 48) && r[0].n === '#1' && r[0].lab === 'look 1', `rows ${vp.touch ? 56 : 48}px; "#1" + the label`, r[0]);
      ok(r.every((x) => x.dis === 'true' && x.title === 'Not running' && !x.img), 'every row disabled, "Not running", label-only', r.map((x) => [x.dis, x.title]));
      await page.click(`${li(listLine.id)} .tl-more`);
      await sleep(400);
      ok(await page.evaluate((s) => [...document.querySelectorAll(s + ' .tl-row')].every((x) => !x.hidden), `${li(listLine.id)} .tl-list`), 'Show more expands in place (6 rows)');
      skip('the @meta batch (thumbs, states, superseded / gone rows), a row click -> preview, the slow + failing batch');
      const mxW = await page.evaluate((s) => {
        const box = document.querySelector(s);
        return { cap: !!box.querySelector('.tl-cap'), icons: [...box.querySelectorAll('.tl-row .tl-ic svg')].length, dis: [...box.querySelectorAll('.tl-row')].map((x) => [x.getAttribute('aria-disabled'), x.title]) };
      }, `${li(mixedLine.id)} .tl-list`);
      ok(!mxW.cap && mxW.icons === 2 && mxW.dis.every((d) => d[0] === 'true' && d[1] === 'Not running'), 'mixed tools: no caption, an icon per row, each row disabled with its reason', mxW);
      skip("{panel:'compose'} (it comes from an app panel's frame, and no app panel exists here)");
    } else {
    ok(r[0].h === (vp.touch ? 56 : 48) && r[0].thW === (vp.touch ? 40 : 36), `rows ${vp.touch ? 56 : 48}px, thumbs ${vp.touch ? 40 : 36}px`, [r[0].h, r[0].thW]);
    ok(r[0].n === '#1' && r[0].lab === 'look 1', '"#1" + the label (its own "#1 " not repeated)', [r[0].n, r[0].lab]);
    ok(/s-waiting/.test(r[0].stCls) && r[0].st === 'Waiting' && /s-replied/.test(r[1].stCls) && r[1].st === 'Replied' && /s-resolved/.test(r[2].stCls) && r[2].st === 'Resolved' && !r[3].st, 'states from the batch: Waiting · Replied · Resolved · (none)', r.slice(0, 4).map((x) => x.st));
    ok(r.slice(0, 4).every((x) => x.img === 1), 'thumbs load from the frame proxy + the thumb path', r.map((x) => x.img));
    await page.click(`${li(listLine.id)} .tl-more`);
    await sleep(700);
    const ls2 = await page.evaluate((s) => [...document.querySelectorAll(s + ' .tl-row')].map((x) => ({ hidden: x.hidden, dis: x.getAttribute('aria-disabled'), stale: x.classList.contains('is-stale'), st: x.querySelector('.tl-st')?.textContent, stCls: x.querySelector('.tl-st')?.className, title: x.title, op: x.querySelector('.tl-th img') ? getComputedStyle(x.querySelector('.tl-th img')).opacity : null, labColor: getComputedStyle(x.querySelector('.tl-lab')).color, bg: getComputedStyle(x).backgroundColor, hov: x.matches(':hover'), foc: x.matches(':focus') })), `${li(listLine.id)} .tl-list`);
    ok(ls2.every((x) => !x.hidden), 'Show more expands in place (6 rows)', ls2.map((x) => [x.bg, x.hov, x.foc]));
    ok(ls2[4].stale && ls2[4].dis === 'false' && ls2[4].st === 'superseded by #6' && /tl-note/.test(ls2[4].stCls) && ls2[4].op === '0.5', 'superseded: clickable, dim, the thumb at 50%, the note in place of the state', ls2[4]);
    ok(ls2[5].stale && ls2[5].dis === 'true' && ls2[5].title === 'deleted by the author', 'gone: disabled, the note as text + tooltip', ls2[5]);
    await activate(`${li(listLine.id)} .tl-row >> nth=2`);
    await sleep(600);
    p = await pv();
    ok(p.open && /review\/3\?surface=preview$/.test(p.src ?? '') && p.name === '#3 look 3', 'a row click: the preview shows that item', p);
    await closePv();
    await sleep(200);

    /* mixed tools: no caption, an icon per row; the sleeping tool's row disabled */
    const mx = await page.evaluate((s) => {
      const box = document.querySelector(s);
      return { cap: !!box.querySelector('.tl-cap'), icons: [...box.querySelectorAll('.tl-row .tl-ic svg')].length, dis: [...box.querySelectorAll('.tl-row')].map((x) => [x.getAttribute('aria-disabled'), x.title]) };
    }, `${li(mixedLine.id)} .tl-list`);
    ok(!mx.cap && mx.icons === 2 && mx.dis[0][0] === 'false' && mx.dis[1][0] === 'true' && mx.dis[1][1] === 'Not running', 'mixed tools: no caption, an icon per row; the down tool\'s row disabled', mx);

    /* a SLOW batch, then a FAILING one: label-only rows, never an error */
    await ctl(studio, { delayMs: 6000 });
    await openRoom();
    await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), `${li(listLine.id)} .tl-list`);
    await sleep(600);
    const sk = await page.evaluate((s) => ({ th: document.querySelectorAll(s + ' .tl-row:not([hidden]) .tl-th.tl-sk').length, st: document.querySelectorAll(s + ' .tl-row:not([hidden]) .tl-st.tl-sk').length, labs: [...document.querySelectorAll(s + ' .tl-row:not([hidden]) .tl-lab')].map((x) => x.textContent) }), `${li(listLine.id)} .tl-list`);
    ok(sk.th === 4 && sk.st === 4 && sk.labs[0] === 'look 1', 'loading: labels at once, the thumb + state skeletons', sk);
    await sleep(4200);
    const sk2 = await page.evaluate((s) => ({ sk: document.querySelectorAll(s + ' .tl-sk').length, err: /error|fail/i.test(document.querySelector(s).textContent), labs: document.querySelectorAll(s + ' .tl-lab').length, slots: document.querySelectorAll(s + ' .tl-th:not([hidden])').length }), `${li(listLine.id)} .tl-list`);
    ok(sk2.sk === 0 && !sk2.err && sk2.labs === 6 && sk2.slots === 0, 'a slow batch (> 4 s): skeletons dropped, label-only rows, no error', sk2);
    await ctl(studio, { delayMs: 0, fail: true });
    await openRoom();
    await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), `${li(listLine.id)} .tl-list`);
    await sleep(1200);
    const fl = await page.evaluate((s) => ({ sk: document.querySelectorAll(s + ' .tl-sk').length, err: /error|boom|fail/i.test(document.querySelector(s).textContent), imgs: document.querySelectorAll(s + ' img').length, slots: document.querySelectorAll(s + ' .tl-th:not([hidden])').length }), `${li(listLine.id)} .tl-list`);
    ok(fl.sk === 0 && !fl.err && fl.imgs === 0 && fl.slots === 0, 'a failing batch: label-only rows (no thumb slots), never an error', fl);
    await ctl(studio, { fail: false });

    /* ---- 7. {panel:'compose'} ---- */
    const draftText = async () => (await call(`/api/rooms/${R}/draft`, { user: true })).body?.text ?? null;
    const composer = () => page.evaluate(() => {
      const i = document.getElementById('input');
      return { v: i.value, focus: document.activeElement === i, caret: i.selectionStart };
    });
    const lineCount = async () => (await call(`${LINE}?limit=200`)).body.entries.length;
    const n0 = await lineCount();
    await page.evaluate(() => { const i = document.getElementById('input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await activate(chip);
    await sleep(700);
    const viewSel = '.rm-pv .pv-view:not([hidden]) iframe';
    await frameText(viewSel);
    const postFrom = async (sel, text) => {
      const f = await (await page.$(sel))?.contentFrame();
      await f?.evaluate((t) => parent.postMessage({ panel: 'compose', text: t }, '*'), text);
    };
    await postFrom(viewSel, '#2 v3:\nline two ');
    await sleep(300);
    let c = await composer();
    ok(c.v === '#2 v3: line two' && c.focus && c.caret === c.v.length, 'empty composer: set (newline stripped), focused, caret at the end', c);
    const reopen = async () => {
      if (vp.touch) {
        await activate(chip);
        await sleep(600);
        await frameText(viewSel);
      } else {
        await sleep(1100); // past the 1 s gap
      }
    };
    if (vp.touch) {
      ok(!(await pv()).open, 'phone: the preview closes so the composer is in sight');
    }
    await page.evaluate(() => { document.getElementById('input').value = ''; });
    await reopen();
    const vf = await (await page.$(viewSel))?.contentFrame();
    await vf?.evaluate(() => {
      parent.postMessage({ panel: 'compose', text: 'first' }, '*');
      parent.postMessage({ panel: 'compose', text: 'second' }, '*');
    });
    await sleep(300);
    ok((await composer()).v === 'first', '1 a second per frame: a second message right after is ignored', (await composer()).v);
    await page.evaluate(() => { const i = document.getElementById('input'); i.value = 'hello world'; i.setSelectionRange(5, 5); });
    await reopen();
    await postFrom(viewSel, '#3');
    await sleep(300);
    c = await composer();
    ok(c.v === 'hello #3 world' && c.focus && c.caret === 8, 'non-empty: inserted at the caret with separating spaces, the caret at the end of the insert', c);
    await sleep(700);
    ok((await draftText()) === 'hello #3 world', 'the draft holds it (saved as typing would)', await draftText());
    ok((await lineCount()) === n0, 'never sent: no line was written');
    if (!vp.touch) {
      /* a non-app panel's frame: ignored */
      await page.evaluate(() => { document.getElementById('input').value = ''; });
      const plainSel = '.cell iframe[title="Plain"]';
      await page.waitForSelector(plainSel, { state: 'attached', timeout: 5000 }).catch(() => {});
      await sleep(400);
      await postFrom(plainSel, 'from plain');
      await sleep(300);
      ok((await composer()).v === '', 'a non-app panel asks: ignored');
      /* from the LARGE view: the modal closes back to the column */
      await page.click('.rm-pv .pv-ex');
      await sleep(600);
      await frameText('.tl-lg iframe');
      await postFrom('.tl-lg iframe', 'from large');
      await sleep(300);
      const lgc = await page.evaluate(() => ({ modal: !!document.querySelector('.tl-lg'), pv: !document.querySelector('.rm-pv').hidden, v: document.getElementById('input').value }));
      ok(!lgc.modal && lgc.pv && lgc.v === 'from large', 'from the large view: the modal closes back to the column, the composer holds it', lgc);
    }
    await closePv();
    await page.evaluate(() => { const i = document.getElementById('input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(600);
    } // RUNS

    /* ---- 8. no sideways scroll ---- */
    const sw = await page.evaluate(() => ({ doc: document.scrollingElement.scrollWidth, w: innerWidth, line: document.getElementById('lineScroll')?.scrollWidth, lw: document.getElementById('lineScroll')?.clientWidth }));
    ok(sw.doc <= sw.w && sw.line <= sw.lw + 1, 'no sideways scroll', sw);

    ok(errors.length === 0, 'no page errors', errors);
    await context.close();
  }
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
console.log(failures === 0 ? '\nroom-tool-links.probe: PASS' : `\nroom-tool-links.probe: ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
