/* ROOM ROUND 3 — the preview column, room settings, the room colour, and the
 * header "+" controls (the design system room-round3-v1 §1-3; Owner room lines [ref]/221).
 *
 *   node test/room-round3.probe.mjs
 *
 * Panels and their app frames are stubbed in the browser (the room-cells
 * probe's pattern); the settings routes are the engine's own. Proves:
 *   - a registered panel's {panel:'preview', item} opens the column: the main
 *     column SHRINKS (a third column, 370px by default: ticket), TYPE · name, the item's actions
 *     (a javascript: action dropped), URLs resolved against the frame, no
 *     accent bar; preview-state reaches the frames; Esc closes it and focus
 *     returns to the opener frame; the lightbox's Esc does not close it too
 *   - {panel:'preview', view} = the panel's frameUrl + path in a view frame
 *     (same sandbox, never same-origin); an item from it gets "← Back to …",
 *     and Back shows the SAME frame (no reload)
 *   - a frame that is not a registered panel is ignored; preview-close only
 *     from the owning panel
 *   - ⚙ Room settings: Save as default persists (human cookie); a bearer
 *     alone is 403; the page opens on the default; Reset returns to it;
 *     Use current view copies the live filter
 *   - room colour: a swatch recolours the room tab identity (hwbRoomIdentity)
 *     and the selected seat's ground (COMPUTED style, the derived tint, not
 *     teal); unset = the lead's project colour
 *   - "+" Add member in the seats header (44px on a phone); no full-width row
 *   - room line [ref]: room push is live; a seat's held depth dropping (a
 *     delivery) re-reads read state at once, so its unread badge goes within
 *     a poll (control: without a drop, push-live polls never re-read reads)
 *   - phone (390px): the column is a full-screen layer, back control, no
 *     sideways scroll
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(110), DEAD broker P(111).
 * Screenshots land in the OS temp dir (room-round3-*.png).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(110);
const DEAD_BROKER_PORT = P(111);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-round3-token';
const SHOTS = process.env.ROUND3_SHOTS || tmpdir();

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* the line filter is the room bar's menu now (the design system room-filter-v1): pick a
   seat choice / toggle a kind through it, then close it */
const pickWho = (f, who) => f.evaluate((w) => {
  document.getElementById('filterBtn').click();
  document.querySelector(`#filterMenu [data-who="${CSS.escape(w)}"]`).click();
  document.getElementById('filterBtn').click();
}, who);
const toggleKind = (f, k) => f.evaluate((kind) => {
  document.getElementById('filterBtn').click();
  document.querySelector(`#filterMenu [data-kind="${kind}"]`).click();
  document.getElementById('filterBtn').click();
}, k);

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
for (const p of [PORT, DEAD_BROKER_PORT]) {
  await assertFree(p, 'room-round3.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-round3-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null;
let browser = null;
let engineLog = '';
const seed = async (plan) => {
  const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
  return JSON.parse(r.out.trim().split('\n').pop());
};

const LEAD_COLOR = '#0dab49';
const PICK = '#ba08b4';

/* the stubbed apps: Assets (uploads, a More grid) and Tasks */
const APP = (id, path) => `<!doctype html><body style="margin:0;font:12px sans-serif;color:#ccc;background:#161b22">${id}${path ? ` / ${path}` : ''}<script>
  window.__got = [];
  addEventListener('message', (e) => { if (e.source === parent) window.__got.push(e.data); });
  const item = (key, extra) => Object.assign({ key, type: 'Image', title: key + '.png', image: 'img/' + key + '.png', status: 'ready',
    excerpt: 'line one\\nline two', meta: [['size', '412 KB'], ['added by', '@awake']],
    actions: [{ label: 'Copy reference', copy: 'ref:' + key }, { label: 'Download', download: 'files/' + key + '.png' },
              { label: 'Open full size', open: 'img/' + key + '.png' }, { label: 'Evil', open: 'javascript:alert(1)' }] }, extra || {});
  window.pick = (key, extra) => parent.postMessage({ panel: 'preview', item: item(key, extra) }, '*');
  window.task = () => parent.postMessage({ panel: 'preview', item: { key: 'ticket', type: 'Task', title: 'ticket Room settings', status: 'In progress', excerpt: 'the left column…', actions: [{ label: 'Open in Vikunja ↗', open: 'https://example.com/tasks/1' }] } }, '*');
  window.more = () => parent.postMessage({ panel: 'preview', view: { path: 'grid', title: 'All 3 assets' } }, '*');
  window.badView = (p) => parent.postMessage({ panel: 'preview', view: { path: p, title: 'x' } }, '*');
  window.closeIt = () => parent.postMessage({ panel: 'preview-close' }, '*');
  window.lb = () => parent.postMessage({ panel: 'open', url: 'img/a1.png', title: 'A1' }, '*');
</script></body>`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

try {
  await seed({ recipes: [
    { id: 'rec-a', name: 'Awake', projectDir: '/srv/x/awake', vendor: 'claude-code', agent: 'awake', color: LEAD_COLOR },
    { id: 'rec-b', name: 'Bravo', projectDir: '/srv/x/bravo', vendor: 'claude-code', agent: 'bravo', color: '#1f5fbf' },
  ] });
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
      HARBOR_WB_NODE: 'testnode',
      HARBOR_WB_EDITION: 'basic', // this probe is about the Assets PANEL on the phone: a Basic instance keeps its cell and its app row
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

  const post = await seed({ rooms: [{ name: 'Round Three', seats: [{ handle: 'awake', recipe_id: 'rec-a' }, { handle: 'bravo', recipe_id: 'rec-b' }] }] });
  const R = post.rooms[0].id;
  const SEAT = post.rooms[0].seats;
  const bearer = (path, init = {}) => fetch(BASE + path, { ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers || {}) } });
  const roomNow = async () => (await (await bearer(`/api/rooms/${R}`)).json()).room;

  browser = await chromium.launch({ headless: true });
  const F = (id) => `/api/rooms/${R}/panels/${id}/frame/t/tok-${id}/`;
  const PANELS = [
    { id: 'p-assets', room_id: R, kind: 'app', title: 'Assets', icon: 'assets', order: 1, seat_handle: null, scripts: true, uploads: true, url: 'http://127.0.0.1:9/never', frameUrl: F('p-assets') },
    { id: 'p-tasks', room_id: R, kind: 'app', title: 'Tasks', icon: 'tasks', order: 2, seat_handle: 'awake', scripts: true, url: 'http://127.0.0.1:9/never', frameUrl: F('p-tasks') },
  ];
  const hits = {};
  /* room line [ref]: a held line on @awake, and its read state. `waiting` is
     the badge's own signal since the badge-meaning change (Owner 2026-09-28:
     only lines REALLY waiting count; the engine serves seat.waiting {count,
     ids}): a stubbed held line must wear it too, or the engine's truthful
     "0 waiting" for this occupant-less seat wins. */
  const stub = { held: false, reads: null, waitingId: null };
  const FRAME_RE = /\/panels\/(p-[a-z]+)\/frame\/t\/[^/]+\/(.*)$/;
  async function wire(ctx) {
    await ctx.route(new RegExp(`/api/rooms/${R}(\\?.*)?$`), async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.panels = PANELS;
      if (stub.held) {
        const s = body.seats.find((x) => x.handle === 'awake');
        s.occupant = { ...(s.occupant || {}), held: { depth: 1, reason: 'draft', since: Date.now() } };
        if (stub.waitingId !== null) { s.waiting = { count: 1, ids: [stub.waitingId] }; }
      }
      await route.fulfill({ response: res, json: body });
    });
    await ctx.route(new RegExp(`/api/rooms/${R}/line\\?`), async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      if (stub.reads && body.entries?.length) {
        body.entries[body.entries.length - 1].reads = { awake: stub.reads };
      }
      await route.fulfill({ response: res, json: body });
    });
    /* pushed room.state carries the engine's seats: wear the same stubbed
       held line there too (a transparent relay otherwise) */
    await ctx.routeWebSocket(/\/pty/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => {
        if (typeof m === 'string' && stub.held && m.includes('"room.state"')) {
          try {
            const d = JSON.parse(m);
            const seat = d.type === 'room.state' && Array.isArray(d.seats) ? d.seats.find((x) => x.handle === 'awake') : null;
            if (seat) {
              seat.occupant = { ...(seat.occupant || {}), held: { depth: 1, reason: 'draft', since: Date.now() } };
              if (stub.waitingId !== null) { seat.waiting = { count: 1, ids: [stub.waitingId] }; }
              ws.send(JSON.stringify(d));
              return;
            }
          } catch { /* not ours */ }
        }
        ws.send(m);
      });
    });
    await ctx.route(FRAME_RE, async (route) => {
      const m = route.request().url().match(FRAME_RE);
      const [, id, tail] = m;
      const k = `${id}/${tail.split('?')[0]}`;
      if (route.request().method() === 'GET') { hits[k] = (hits[k] ?? 0) + 1; }
      if (/\.png$/.test(tail)) { await route.fulfill({ status: 200, contentType: 'image/png', body: PNG }); return; }
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: APP(id, tail) });
    });
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await wire(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => { errors.push(`dialog: ${d.message()}`); void d.dismiss(); });
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const ROOM_URL = `${BASE}/room.html?room=${R}`;
  await page.goto(ROOM_URL, { waitUntil: 'domcontentloaded' });
  await sleep(3500);
  /* by path: a non-rail frame's URL also carries ?surface=<kind> (ticket seam) */
  const frameOf = (id, tail = '') => page.frames().find((f) => f.url().split('?')[0].endsWith(`/panels/${id}/frame/t/tok-${id}/${tail}`));

  /* ---- the column ---- */
  const col = () => page.evaluate(() => {
    const pv = document.getElementById('preview');
    const r = pv.getBoundingClientRect();
    const cs = getComputedStyle(pv);
    const line = document.getElementById('roomLine').getBoundingClientRect();
    const acts = [...pv.querySelectorAll('.pv-acts > *')].map((a) => ({ tag: a.tagName, text: a.textContent, href: a.getAttribute('href'), dl: a.hasAttribute('download'), pri: a.classList.contains('pri') }));
    const t = pv.querySelector('.pv-t');
    return {
      shown: !pv.hidden, w: Math.round(r.width), lineW: Math.round(line.width), hasPv: document.getElementById('main').classList.contains('has-pv'),
      type: pv.querySelector('.pv-type')?.textContent, name: pv.querySelector('.pv-name')?.textContent, tt: t && getComputedStyle(t).textTransform,
      bl: `${cs.borderLeftWidth} ${cs.borderLeftStyle}`, bt: cs.borderTopWidth, shadow: cs.boxShadow !== 'none',
      img: pv.querySelector('.pv-img img')?.getAttribute('src'), status: pv.querySelector('.pv-status')?.textContent,
      meta: [...pv.querySelectorAll('.pv-meta dt')].map((d) => d.textContent), ex: pv.querySelector('.pv-excerpt')?.textContent,
      acts, trail: pv.querySelector('.pv-trail')?.hidden === false ? pv.querySelector('.pv-trail').textContent : null,
      view: (() => { const f = pv.querySelector('.pv-view:not([hidden]) iframe'); return f && { src: f.getAttribute('src'), sandbox: f.getAttribute('sandbox'), ref: f.getAttribute('referrerpolicy') }; })(),
      frames: pv.querySelectorAll('iframe').length,
      active: document.activeElement === pv ? 'column' : document.activeElement?.tagName === 'IFRAME' ? `iframe:${document.activeElement.closest('.cell')?.dataset.cell}` : document.activeElement?.id || document.activeElement?.tagName,
    };
  });
  let c = await col();
  ok(!c.shown && !c.hasPv, 'closed on entry: no third column', c);
  const lineBefore = c.lineW;

  await frameOf('p-assets').evaluate(() => window.pick('a1'));
  await sleep(500);
  c = await col();
  ok(c.shown && c.hasPv && c.w === 370, 'a panel\'s preview opens the column at its 370px default (ticket)', { w: c.w });
  ok(c.lineW === lineBefore - 370, '...and the main column SHRINKS by it (no overlay)', { before: lineBefore, after: c.lineW });
  ok(c.type === 'Image' && c.name === 'a1.png' && c.tt === 'uppercase', 'header: TYPE · name, the type in caps', c);
  ok(c.bl === '1px solid' && c.bt === '0px' && c.shadow, 'no accent bar: a 1px edge + soft shadow, no top bar', { bl: c.bl, bt: c.bt });
  const fb = `${BASE}${F('p-assets')}`;
  ok(c.img === `${fb}img/a1.png`, 'the image is an <img>, resolved against the frame', c.img);
  ok(c.status === 'ready' && c.meta.join() === 'size,added by' && c.ex === 'line one\nline two', 'status, meta pairs and the excerpt as text', c);
  ok(c.acts.length === 3 && c.acts[0].tag === 'BUTTON' && c.acts[0].pri && c.acts[1].href === `${fb}files/a1.png` && c.acts[1].dl && c.acts[2].href === `${fb}img/a1.png` && !c.acts.some((a) => /javascript/.test(a.href ?? '')),
    'actions: copy (the teal one), download, open — resolved; a javascript: action is dropped', c.acts);
  ok(c.active === 'column', 'focus moves onto the column (Esc is ours, not the frame\'s)', c.active);
  const gotA = await frameOf('p-assets').evaluate(() => window.__got.filter((m) => m.panel === 'preview-state').map((m) => m.key));
  const gotT = await frameOf('p-tasks').evaluate(() => window.__got.filter((m) => m.panel === 'preview-state').map((m) => m.key));
  ok(gotA[gotA.length - 1] === 'a1' && gotT[gotT.length - 1] === null, 'preview-state: the opener hears its key at once, another panel hears null', { gotA, gotT });
  await page.screenshot({ path: join(SHOTS, 'room-round3-desk-item.png') });

  /* copy from the column: a toast in the column */
  await page.click('#preview .pv-acts button');
  await sleep(300);
  ok(/Reference copied|Could not copy/.test(await page.evaluate(() => document.querySelector('#preview > .cell-toast')?.textContent ?? '')), 'Copy reference: the host copies, the toast shows in the column');

  /* the image → the lightbox; its Esc closes only the lightbox */
  await page.click('#preview .pv-img');
  await sleep(300);
  ok(await page.evaluate(() => !document.getElementById('lightbox').hidden && document.querySelector('#lbBody img')?.src.endsWith('/img/a1.png')), 'the image opens the host lightbox');
  await page.keyboard.press('Escape');
  await sleep(200);
  c = await col();
  ok(await page.evaluate(() => document.getElementById('lightbox').hidden) && c.shown, '...Esc closes the lightbox, the column stays');

  /* preview-close from ANOTHER panel is ignored; a non-panel frame is ignored */
  await frameOf('p-tasks').evaluate(() => window.closeIt());
  await sleep(300);
  ok((await col()).shown, 'preview-close from a panel that does not own it: ignored');
  await page.evaluate(() => {
    const f = document.createElement('iframe');
    f.id = 'rogue';
    f.setAttribute('sandbox', 'allow-scripts');
    f.srcdoc = `<script>parent.postMessage({panel:'preview', item:{key:'evil', type:'Evil', title:'rogue'}}, '*'); parent.postMessage({panel:'preview-close'}, '*');<\/script>`;
    document.body.append(f);
  });
  await sleep(500);
  c = await col();
  ok(c.shown && c.name === 'a1.png', 'a frame that is not a registered panel is ignored (no open, no close)', c.name);
  await page.evaluate(() => document.getElementById('rogue').remove());

  /* Esc closes; focus returns to the opener frame */
  await page.click('#preview .pv-h');
  await page.keyboard.press('Escape');
  await sleep(200);
  c = await col();
  ok(!c.shown && !c.hasPv && c.lineW === lineBefore, 'Esc closes the column; the main column gets its width back', c.lineW);
  ok(c.active === 'iframe:p-assets', '...and focus returns to the opener (the panel\'s frame)', c.active);
  const gotA2 = await frameOf('p-assets').evaluate(() => window.__got.filter((m) => m.panel === 'preview-state').map((m) => m.key));
  ok(gotA2[gotA2.length - 1] === null, '...which hears preview-state null', gotA2.slice(-2));

  /* a view: More → the panel's own app at a sub-path */
  await frameOf('p-assets').evaluate(() => { window.badView('../x'); window.badView('https://evil.example/'); window.badView('/abs'); });
  await sleep(300);
  ok(!(await col()).shown, 'a view path with "..", a scheme or a leading "/" is refused');
  await frameOf('p-assets').evaluate(() => window.more());
  await sleep(1200);
  c = await col();
  ok(c.shown && c.type === 'Assets' && c.name === 'All 3 assets' && c.view?.src === `${F('p-assets')}grid?surface=preview`, 'More: the view frame is frameUrl + "grid" + ?surface=preview, header "Assets · All 3 assets"', c);
  ok(/allow-scripts/.test(c.view?.sandbox ?? '') && !/allow-same-origin/.test(c.view?.sandbox ?? '') && c.view?.ref === 'no-referrer', '...the cell\'s sandbox (never same-origin), no-referrer', c.view);
  const gridHits = hits['p-assets/grid'];
  const grid = frameOf('p-assets', 'grid');
  await grid.evaluate(() => window.pick('a2'));
  await sleep(500);
  c = await col();
  ok(c.name === 'a2.png' && c.trail === '← Back to All 3 assets' && c.frames === 1 && !c.view, 'an item FROM the view: "← Back to All 3 assets", the view kept hidden', c);
  ok(c.img === `${fb}img/a2.png`, '...its URLs resolve against the VIEW frame', c.img);
  const gotG = await grid.evaluate(() => window.__got.filter((m) => m.panel === 'preview-state').map((m) => m.key));
  ok(gotG[gotG.length - 1] === 'a2', '...and the view frame hears preview-state a2', gotG);
  await page.click('#preview .pv-trail');
  await sleep(500);
  c = await col();
  ok(c.view && c.name === 'All 3 assets' && !c.trail && hits['p-assets/grid'] === gridHits, 'Back shows the same view frame again (no reload)', { hits: hits['p-assets/grid'], gridHits });
  await frameOf('p-tasks').evaluate(() => window.task());
  await sleep(400);
  c = await col();
  ok(c.type === 'Task' && c.name === 'ticket Room settings' && c.view === null && !c.trail, 'one at a time: a Task from another panel replaces it (the view is hidden, kept for the return stack: ticket)', c);
  await frameOf('p-tasks').evaluate(() => window.closeIt());
  await sleep(300);
  ok(!(await col()).shown, 'preview-close from the owning panel closes it');

  /* ---- "+" Add member (Owner, room line [ref]) ---- */
  const addm = await page.evaluate(() => { const b = document.querySelector('.cell[data-cell="seats"] .cell-hw #addBtn'); return b && { name: b.getAttribute('aria-label'), text: b.textContent, row: !!document.querySelector('.rm-add') }; });
  ok(addm && addm.name === 'Add or move a seat' && addm.text === '+' && !addm.row, '"+" (Add or move a seat, rail split 9141f4a) sits in the seats header; the full-width row is gone', addm);
  await page.click('#addBtn');
  ok(!!(await page.waitForSelector('.ras-scrim', { timeout: 5000 }).catch(() => null)), '...and opens the room + sheet');
  await page.keyboard.press('Escape');
  await sleep(300);

  /* ---- ⚙ Room settings ---- */
  const gear = await page.evaluate(() => { const r = document.getElementById('gearBtn').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(innerWidth - r.right) }; });
  ok(gear.w === 36 && gear.h === 36 && gear.right <= 16, 'the ⚙ is a 36px button at the top right', gear);
  await page.click('#gearBtn');
  await sleep(300);
  c = await col();
  ok(c.shown && c.name === 'Room settings' && (await page.getAttribute('#gearBtn', 'aria-pressed')) === 'true', '⚙ opens "Room settings" in the column, pressed', c.name);
  await page.screenshot({ path: join(SHOTS, 'room-round3-desk-settings.png') });
  const bad = await bearer(`/api/rooms/${R}/settings`, { method: 'PATCH', body: JSON.stringify({ color: '#123456' }) });
  ok(bad.status === 403, 'PATCH settings with a bearer alone: 403', bad.status);
  await page.click('.pv-chip[data-kind="fact"]');
  await page.click('.pv-chip[data-kind="command"]');
  await page.selectOption('.pv-sel', 'agents');
  await page.click('.pv-set .pv-btn.pri');
  await sleep(600);
  let rm = await roomNow();
  ok(JSON.stringify(rm.feed_default) === JSON.stringify({ kinds: ['chat', 'delivery', 'attachment', 'voice'], who: 'agents' }), 'Save as default persists on the room (human cookie)', rm.feed_default);
  ok(await page.evaluate(() => document.querySelector('.pv-msg')?.textContent === 'Saved'), '...and says so');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(3500);
  const feed = () => page.evaluate(() => ({
    kinds: [...document.querySelectorAll('#filterMenu [role=menuitemcheckbox]')].filter((i) => i.getAttribute('aria-checked') === 'true').map((i) => i.dataset.kind),
    who: document.querySelector('#filterMenu [role=menuitemradio][aria-checked="true"]')?.dataset.who, reset: document.querySelector('#filterMenu .rf-reset').getAttribute('aria-disabled') !== 'true',
  }));
  let fd = await feed();
  ok(fd.kinds.join() === 'chat,delivery,attachment,voice' && fd.who === 'agents' && !fd.reset, 'the page opens on the default feed (no Reset shown)', fd);
  await toggleKind(page, 'fact');
  await pickWho(page, '');
  fd = await feed();
  ok(fd.reset, 'a changed view shows Reset', fd);
  await page.evaluate(() => { document.getElementById('filterBtn').click(); document.querySelector('#filterMenu .rf-reset').click(); document.getElementById('filterBtn').click(); });
  fd = await feed();
  ok(fd.kinds.join() === 'chat,delivery,attachment,voice' && fd.who === 'agents' && !fd.reset, 'Reset returns the feed to the default', fd);
  await pickWho(page, SEAT.bravo);
  await page.click('#gearBtn');
  await sleep(300);
  await page.click('.pv-set .pv-btn:has-text("Use current view")');
  ok(await page.evaluate(() => document.querySelector('.pv-sel').value) === SEAT.bravo, 'Use current view copies the live filter into the form');
  await page.click('.pv-set .pv-btn.pri');
  await sleep(600);
  rm = await roomNow();
  ok(rm.feed_default?.who === SEAT.bravo, '...and saves it', rm.feed_default);

  /* ---- the room colour ---- */
  const tones = (hex) => page.evaluate((h) => {
    const probe = (css) => { const d = document.createElement('div'); d.style.color = css; document.body.append(d); const v = getComputedStyle(d).color; d.remove(); return v; };
    const sel = document.querySelector('#roomList .seat.sel');
    return {
      ground: getComputedStyle(sel).backgroundColor, shadow: getComputedStyle(sel).boxShadow, spine: getComputedStyle(sel).borderLeftColor,
      name: getComputedStyle(document.getElementById('roomName')).color,
      tint: probe(`oklch(from ${h} .30 clamp(0, calc(c * .45), .06) h)`), edge: probe(`oklch(from ${h} .45 clamp(0, calc(c * .55), .08) h)`),
      ink: probe(`oklch(from ${h} .82 clamp(.02, calc(c * .6), .13) h)`),
      teal: probe('color-mix(in srgb, var(--teal) 9%, var(--surface))'), rc: document.body.style.getPropertyValue('--room-c'),
    };
  }, hex);
  let t = await tones(LEAD_COLOR);
  ok(t.rc === LEAD_COLOR && t.ground === t.tint && t.ground !== t.teal, 'unset: the room colour is the lead\'s project colour; the selected seat\'s ground is its TINT, not teal', t);
  await page.click(`.pv-swatch[data-c="${PICK}"]`);
  await sleep(600);
  rm = await roomNow();
  t = await tones(PICK);
  ok(rm.color === PICK, 'a swatch saves the room colour', rm.color);
  ok(t.rc === PICK && t.ground === t.tint && t.shadow.includes(t.edge) && t.name === t.ink, 'set: the selected Room row ground = the derived tint (L .30), its hairline = the edge (L .45), the name = the ink (L .82) — computed', t);
  ok(t.spine === 'rgba(0, 0, 0, 0)', '...and no coloured spine on the selected Room row', t.spine);
  /* ROOM CHARACTER [rooms/character] superseded "Send stays teal": a SET room
     colour is the room's accent (the design system room-character v1.1); status stays */
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('.rm-send')).borderColor) === await page.evaluate((h) => { const d = document.createElement('div'); d.style.color = `oklch(from ${h} .80 clamp(.05, calc(c * .75), .14) h)`; document.body.append(d); const v = getComputedStyle(d).color; d.remove(); return v; }, PICK), 'Send takes the room accent (L .80 from the room colour), no longer teal');
  ok(await page.getAttribute(`.pv-swatch[data-c="${PICK}"]`, 'aria-pressed') === 'true', 'the picked swatch is marked');

  /* the room TAB: the page, embedded, hands the shell the room colour */
  const shell = await context.newPage();
  await shell.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await shell.evaluate((u) => {
    window.__ident = [];
    addEventListener('message', (e) => { if (e.data && 'hwbRoomIdentity' in e.data) window.__ident.push(e.data.hwbRoomIdentity); });
    document.body.textContent = '';
    const f = document.createElement('iframe');
    f.src = u;
    f.style.cssText = 'width:1200px;height:800px';
    document.body.append(f);
  }, ROOM_URL);
  await sleep(4500);
  let idents = await shell.evaluate(() => window.__ident);
  ok(idents.length > 0 && idents[idents.length - 1]?.base === PICK, 'room tab identity: a set room colour wins (hwbRoomIdentity.base)', idents);
  const cl = await fetch(`${BASE}/api/rooms/${R}/settings`, { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ color: null }) });
  ok(cl.status === 200, 'clearing the colour with the window cookie: 200', cl.status);
  await sleep(3500);
  idents = await shell.evaluate(() => window.__ident);
  ok(idents[idents.length - 1]?.base === LEAD_COLOR, '...unset: the tab is the lead\'s project colour again (today\'s behaviour)', idents.slice(-1));
  await shell.close();

  /* ---- room line [ref]: a delivered held line drops the seat's badge promptly ---- */
  ok(await page.evaluate(() => document.body.dataset.push) === 'live', 'room push is live on a normal room page (room.subscribed answered)');
  const badge = () => page.evaluate((id) => document.querySelector(`#roster .seat[data-seat-id="${id}"] .seat-count`)?.textContent ?? null, SEAT.awake);
  const newest = (await (await bearer(`/api/rooms/${R}/line?limit=1`)).json()).entries?.[0]?.id ?? null;
  const engAwake = (await (await bearer(`/api/rooms/${R}`)).json()).seats.find((x) => x.handle === 'awake');
  ok(engAwake?.waiting?.count === 0, 'engine truth: @awake (no occupant, nothing delivered) has waiting 0', engAwake?.waiting);
  /* THE NEW MEANING: a line whose read state says "not yet" but that the engine
     does NOT hold for the seat (e.g. handed to its fabric channel) is not a
     backlog: no badge */
  stub.reads = 'not-yet';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(3500);
  ok(await badge() === null, 'a not-yet line the engine does not hold for @awake (a channel delivery) shows NO badge', await badge());
  stub.held = true;
  stub.waitingId = newest;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(3500);
  ok(await badge() === '1', 'a held, not-yet-read line (in seat.waiting): @awake shows 1', await badge());
  stub.reads = 'seen';
  await sleep(4000);
  ok(await badge() === '1', 'control: with push live and nothing delivered, a poll does not re-read reads (badge still 1)', await badge());
  stub.held = false;
  stub.waitingId = null;
  const t0 = Date.now();
  let gone = null;
  for (let i = 0; i < 40; i++) {
    if (await badge() === null) { gone = Date.now() - t0; break; }
    await sleep(100);
  }
  ok(gone !== null && gone <= 3500, 'the held depth drops (a delivery): reads are re-read and the badge goes within one poll', { ms: gone });
  stub.reads = null;

  /* A GENUINELY WAITING LINE, no stubs: a second room whose seat is a live
     session row with no pty behind it (dead broker), so room-typer really
     holds the line addressed to it. The engine's waiting says 1; so must the
     badge, with the held text beside it. */
  await seed({
    recipes: [{ id: 'rec-g', name: 'Gamma', projectDir: '/srv/x/gamma', vendor: 'claude-code', agent: 'gamma', color: '#0dab49' }],
    sessions: [{ paneid: 'recipe:rec-g', recipe_id: 'rec-g', vendor: 'claude-code', agent: 'gamma', state: 'live' }],
  });
  const post2 = await seed({ rooms: [{ name: 'Badge Truth', seats: [{ handle: 'gamma', recipe_id: 'rec-g', occupant: 'recipe:rec-g' }] }] });
  const R2 = post2.rooms[0].id;
  const G = post2.rooms[0].seats.gamma;
  await page.goto(`${BASE}/room.html?room=${R2}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`#roster .seat[data-seat-id="${G}"]`);
  await sleep(1200);
  const sent = await fetch(`${BASE}/api/rooms/${R2}/line`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'for gamma' }) });
  const sentBody = await sent.json();
  ok(sentBody?.deliveries?.[0]?.typed === 'queued', 'engine: the line to @gamma is really held by the typer (queued)', sentBody?.deliveries?.[0]);
  const engG = (await (await bearer(`/api/rooms/${R2}`)).json()).seats.find((x) => x.id === G);
  ok(engG?.waiting?.count === 1, '...and the engine counts it waiting', engG?.waiting);
  let gBadge = null;
  for (let i = 0; i < 30 && gBadge !== '1'; i++) {
    await sleep(100);
    gBadge = await page.evaluate((id) => document.querySelector(`#roster .seat[data-seat-id="${id}"] .seat-count`)?.textContent ?? null, G);
  }
  const gHeld = await page.evaluate((id) => document.querySelector(`#roster .seat[data-seat-id="${id}"] .seat-held`)?.textContent ?? null, G);
  ok(gBadge === '1' && /^1 held/.test(gHeld ?? ''), 'a GENUINELY waiting line (no stubs): @gamma shows 1, beside "1 held · …"', { gBadge, gHeld });

  ok(errors.length === 0, 'no page errors (desktop)', errors.slice(0, 3));

  /* ---- phone ---- */
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await context.storageState() });
  await wire(phone);
  const pp = await phone.newPage();
  const perr = [];
  pp.on('pageerror', (e) => perr.push(String(e)));
  await pp.goto(ROOM_URL, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  const phcol = () => pp.evaluate(() => {
    const pv = document.getElementById('preview');
    const r = pv.getBoundingClientRect();
    const back = pv.querySelector('.pv-back').getBoundingClientRect();
    return { shown: !pv.hidden, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      back: Math.round(back.width) + 'x' + Math.round(back.height), x_hidden: getComputedStyle(pv.querySelector('.pv-x')).display === 'none',
      sw: document.documentElement.scrollWidth, pvSw: pv.scrollWidth, pvCw: pv.clientWidth, name: pv.querySelector('.pv-name').textContent };
  });
  const g = await pp.evaluate(() => { const r = document.getElementById('phGear').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
  /* phone header order (2026-10-02): the visual box is 32px tall, an invisible ::before returns the tap target to 44px */
  ok(g.w >= 44 && g.h >= 32, 'phone: the ⚙ is in the phone header, 44px wide (32px visual, 44px tap target)', g);
  await pp.click('#phGear');
  await sleep(400);
  let pc = await phcol();
  ok(pc.shown && pc.x === 0 && pc.w === 390 && pc.h >= 780 && pc.name === 'Room settings', 'phone: settings open as a full-screen layer', pc);
  ok(pc.back === '44x44' && pc.x_hidden, '...with a 44px back control (the ✕ is desktop\'s)', pc);
  ok(pc.sw <= 390 && pc.pvSw <= pc.pvCw, '...and no sideways scroll', { doc: pc.sw, pv: [pc.pvSw, pc.pvCw] });
  await pp.screenshot({ path: join(SHOTS, 'room-round3-phone-settings.png') });
  await pp.click('#preview .pv-back');
  await sleep(300);
  ok(!(await phcol()).shown, 'phone: back closes it');
  await pp.click('#phLine'); // the phone's one menu [phone menu]: the app is a row in its sheet
  await pp.click('#phStrip .ph-chip:has-text("Assets")');
  await sleep(1500);
  const pf = pp.frames().find((f) => f.url().endsWith(`/panels/p-assets/frame/t/tok-p-assets/`));
  await pf.evaluate(() => window.pick('a3'));
  await sleep(500);
  pc = await phcol();
  ok(pc.shown && pc.x === 0 && pc.w === 390 && pc.name === 'a3.png' && pc.sw <= 390, 'phone: an app layer\'s preview is a full-screen layer over it, no sideways scroll', pc);
  await pp.screenshot({ path: join(SHOTS, 'room-round3-phone-item.png') });
  await pp.click('#preview .pv-back');
  await sleep(300);
  ok(!(await phcol()).shown && await pp.evaluate(() => document.getElementById('main').classList.contains('in-layer')), 'phone: back returns to the app layer under it');
  await pp.click('#lyBack');
  await sleep(300);
  await pp.click('#phAgents');
  await sleep(300);
  const sheetAdd = await pp.evaluate(() => { const b = document.querySelector('#phSheet h3 .cell-hadd'); const r = b?.getBoundingClientRect(); return b && { name: b.getAttribute('aria-label'), w: Math.round(r.width), h: Math.round(r.height) }; });
  ok(sheetAdd && /^Add (member|a workgroup or an app)$/.test(sheetAdd.name) && sheetAdd.w >= 44 && sheetAdd.h >= 44, 'phone: the Agents sheet\'s "+" (Add member) is 44px', sheetAdd);
  ok(perr.length === 0, 'no page errors (phone)', perr.slice(0, 3));
} catch (e) {
  ok(false, `threw: ${e?.stack ?? e}`);
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
