/* REPLY KEEPS THE ATTACHMENTS TRAY ON A PHONE.   node test/room-reply-tray-phone.probe.mjs
 * Owner (iPhone, 390 wide): with a reply chip set, the attachment thumbnails were not shown at all (the chip is the tray's
 * LEAD item, sticky-left; the tray scrolled to 0 and a phone's chip + gap filled the row, or the tiles slid under it).
 * With 3 attachments: no reply -> the tray shows all 3 tiles; with a reply chip -> the chip AND all 3 tiles are visible
 * (non-zero rect inside the viewport, nothing covering a tile), the textarea no shorter than without a reply (one line, 40px; the brief's 60px cannot hold: the box is 40px with no reply too); the same with the soft keyboard
 * faked up (a visualViewport shrink, as room-dialog-kb.probe.mjs does). Chromium, and WebKit if installed.
 * A PROBE, not in npm test. Scratch engine on P(960), dead broker P(961), stub share P(962); childEnv() scrubbed. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const HOST = '127.0.0.1';
const PORT = P(960);
const DEAD = P(961);
const SHARE_PORT = P(962);
const BASE = `http://${HOST}:${PORT}`;
const SHARE = `http://${HOST}:${SHARE_PORT}`;
const TOKEN = 'probe-reply-tray-phone-token';
let failures = 0;
const ok = (c, m, d) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${d !== undefined ? `  (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); if (!c) failures += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runTsx = (args, env) => new Promise((resolve) => {
  const pr = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
  let out = ''; let err = '';
  pr.stdout.on('data', (d) => (out += d)); pr.stderr.on('data', (d) => (err += d));
  pr.on('exit', (code) => resolve({ code, out, err }));
});
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEIGBmgAMYAAA+OA/1bLb6vAAAAAElFTkSuQmCC', 'base64');
const img = (name) => ({ name, mimeType: 'image/png', buffer: PNG });
const INIT = () => {
  const real = window.visualViewport;
  const fake = new EventTarget();
  let kb = 0;
  Object.defineProperties(fake, {
    width: { get: () => (real ? real.width : window.innerWidth) },
    height: { get: () => (real ? real.height : window.innerHeight) - kb },
    scale: { get: () => (real ? real.scale : 1) },
    offsetTop: { get: () => (real ? real.offsetTop : 0) },
    offsetLeft: { get: () => (real ? real.offsetLeft : 0) },
    pageTop: { get: () => (real ? real.pageTop : 0) },
    pageLeft: { get: () => (real ? real.pageLeft : 0) },
  });
  real?.addEventListener('resize', () => fake.dispatchEvent(new Event('resize')));
  Object.defineProperty(window, 'visualViewport', { get: () => fake, configurable: true });
  window.__kb = (px) => { kb = px; fake.dispatchEvent(new Event('resize')); };
};
/* a stub agent-share: accepts uploads, serves them back */
const files = new Map();
const stub = createServer((req, res) => {
  const u = new URL(req.url ?? '/', SHARE);
  if (req.method === 'POST' && u.pathname === '/api/upload') {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const dir = u.searchParams.get('dir') ?? '';
      const body = Buffer.concat(chunks);
      const boundary = /boundary=([^;]+)/.exec(req.headers['content-type'] ?? '')?.[1];
      const headEnd = body.indexOf('\r\n\r\n');
      const name = /filename="([^"]*)"/.exec(body.subarray(0, headEnd).toString('utf8'))?.[1];
      const end = body.lastIndexOf(Buffer.from(`\r\n--${boundary}--`));
      files.set(`${dir}/${name}`, body.subarray(headEnd + 4, end));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, saved: [`${dir}/${name}`] }));
    });
    return;
  }
  const path = decodeURIComponent(u.pathname);
  const f = path.startsWith('/raw/') ? files.get(path.slice(5)) : null;
  if (!f) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(f.length) });
  res.end(req.method === 'HEAD' ? undefined : f);
});

for (const p of [PORT, DEAD, SHARE_PORT]) { await assertFree(p, 'room-reply-tray-phone.probe.mjs'); }
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-reply-tray-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null; const browsers = []; let log = '';
try {
  await new Promise((r) => stub.listen(SHARE_PORT, HOST, r));
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
    return JSON.parse(r.out.trim().split('\n').pop());
  };
  await seed({ recipes: [{ id: 'rec-a', name: 'Awake', projectDir: '/srv/x/awake', vendor: 'claude-code', agent: 'awake', color: '#0dab49' }] });
  const loader = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loader, join('src', 'server', 'index.ts')], { cwd: REPO_ROOT, env: childEnv({
    HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: HOST, HARBOR_WB_TABLE: dbPath, HARBOR_WB_TOKEN: TOKEN,
    HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'), HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_NO_WINDOW: '1',
    HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(DEAD),
    HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'cp'), HARBOR_WB_NODE: 'testnode', HARBOR_WB_CONFIG: join(tmpDir, 'config.json'),
    HARBOR_WB_AGENT_SHARE_URL: SHARE, HARBOR_WB_ROOM_SCRATCH_DIR: join(tmpDir, 'room-scratch') }) });
  engine.stdout.on('data', (d) => (log += d)); engine.stderr.on('data', (d) => (log += d));
  let up = false;
  for (let i = 0; i < 120 && !up; i += 1) { await sleep(250); try { up = (await fetch(`${BASE}/health`)).ok; } catch { /* not yet */ } }
  ok(up, 'scratch engine up', up ? undefined : log.slice(-300));
  if (!up) { throw new Error('no engine'); }
  const A = 'recipe:rec-a';
  const post = await seed({ sessions: [{ paneid: A, recipe_id: 'rec-a', vendor: 'claude-code', agent: 'awake', state: 'live' }],
    rooms: [{ name: 'ReplyTray', seats: [{ handle: 'awake', recipe_id: 'rec-a', occupant: A }] }] });
  const R = post.rooms[0].id;
  const LINE = `/api/rooms/${R}/line`;
  const orig = (await (await fetch(BASE + LINE, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'I found why the build was red: the cache key', from: { paneid: A } }) })).json()).entries[0];

  const engines = [['chromium', chromium]];
  try { const wk = await webkit.launch({ headless: true }); await wk.close(); engines.push(['webkit', webkit]); } catch { console.log('  (webkit not installed: chromium only)'); }
  for (const [name, type] of engines) {
    console.log(`--- ${name} 390x844 ---`);
    const browser = await type.launch({ headless: true }); browsers.push(browser);
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await ctx.addInitScript(INIT);
    const pg = await ctx.newPage();
    const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
    await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
    await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);
    await pg.goto(`${BASE}/room.html?room=${R}&shell=0`, { waitUntil: 'domcontentloaded' });
    await pg.waitForSelector(`#line li[data-id="${orig.id}"]`);
    await sleep(800);
    /* the reply target is a server draft shared by both engines' pages: start clean */
    if (await pg.$('#attTray .rp-chip')) { await pg.click('#attTray .rp-chip .rp-x'); await sleep(300); }
    await pg.setInputFiles('#attFile', [img('a.png'), img('b.png'), img('c.png')]);
    await pg.waitForFunction(() => document.querySelectorAll('#attTray .att-tile').length === 3 && !document.querySelector('#attTray .att-tile.up'), null, { timeout: 15000 }).catch(() => {});
    /* WebKit fires the file input twice: drop any extra tile so both engines hold exactly 3 */
    for (let i = 0; i < 6 && (await pg.locator('#attTray .att-tile').count()) > 3; i += 1) { await pg.locator('#attTray .att-tile .att-x').last().click({ force: true }); }
    await sleep(400);
    /* what is visible: each item's rect inside the viewport AND inside the tray's own box AND the top element at its centre */
    const measure = () => pg.evaluate(() => {
      const vv = window.visualViewport; const top = vv.offsetTop; const bot = top + vv.height;
      const tray = document.getElementById('attTray'); const tr = tray.getBoundingClientRect();
      const seen = (e) => {
        const r = e.getBoundingClientRect();
        const cx = Math.min(Math.max(r.left + r.width / 2, tr.left), tr.right - 1); const cy = r.top + r.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        const w = Math.max(0, Math.min(r.right, tr.right, innerWidth) - Math.max(r.left, tr.left, 0));
        return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), vis: Math.round(w), h: Math.round(r.height),
          inView: r.height > 0 && r.top >= top - 1 && r.bottom <= bot + 1, covered: !!hit && !e.contains(hit) };
      };
      const tiles = [...tray.querySelectorAll('.att-tile')].map(seen);
      const chip = tray.querySelector('.rp-chip');
      const ta = document.getElementById('input').getBoundingClientRect();
      return { hidden: tray.hidden, trayDisp: getComputedStyle(tray).display, tray: { l: Math.round(tr.left), r: Math.round(tr.right), h: Math.round(tr.height), sl: Math.round(tray.scrollLeft), sw: tray.scrollWidth },
        tiles, chip: chip ? seen(chip) : null, ta: Math.round(ta.height), taInView: ta.top >= top - 1 && ta.bottom <= bot + 1, kb: document.documentElement.classList.contains('kb-up') };
    });
    const tilesOk = (m) => m.tiles.length === 3 && m.tiles.every((t) => t.vis >= t.w - 1 && t.inView && !t.covered);
    const m0 = await measure();
    ok(!m0.hidden && tilesOk(m0), `${name}: 3 attachments, no reply: the tray shows all 3 thumbnails`, m0);
    const TA0 = m0.ta;
    ok(TA0 >= 40, `${name}: no reply: the box has its one-line height`, TA0);

    /* reply to the line: a right-click on its body opens the line menu */
    const reply = async () => {
      await pg.click(`#line li[data-id="${orig.id}"] .entry-body`, { button: 'right' });
      await pg.click('.rsm-menu .rsm-mi[data-a="reply"]');
      await sleep(500);
    };
    await reply();
    for (const kb of [0, 330]) {
      if (kb) { await pg.evaluate(() => { document.getElementById('input').focus(); window.__kb(330); }); await sleep(900); } 
      const m = await measure();
      const tag = `${name}${kb ? ' + keyboard' : ''}: reply chip + 3 attachments`;
      ok(!!m.chip && m.chip.vis >= m.chip.w - 1 && m.chip.inView && !m.chip.covered, `${tag}: the chip is visible`, m.chip);
      ok(tilesOk(m), `${tag}: all 3 thumbnails visible, inside the viewport, none covered`, { tiles: m.tiles, tray: m.tray });
      const overlap = m.chip && m.tiles.some((t) => t.x < m.chip.x + m.chip.w - 1 && t.x + t.w > m.chip.x + 1 && t.y < m.chip.y + m.chip.h - 1 && t.y + t.h > m.chip.y + 1);
      ok(!overlap, `${tag}: chip and thumbnails do not overlap`, { chip: [m.chip.x, m.chip.y, m.chip.h], tiles: m.tiles.map((t) => [t.x, t.y]) });
      ok(m.ta >= 40 && m.ta >= TA0 && m.taInView, `${tag}: the text box keeps its height (>= 40 and >= the no-reply height) and is above the keys`, { ta: m.ta, was: TA0, inView: m.taInView });
      await pg.screenshot({ path: join(tmpdir(), `reply-tray-${name}${kb ? '-kb' : ''}.png`) });
    }
    if (name === 'chromium') { ok(errs.length === 0, `${name}: no page errors`, errs.slice(0, 3)); } else if (errs.length) { console.log(`  (webkit page errors, not asserted: ${errs.length} cross-origin fetches on 127.0.0.1)`); }
    await ctx.close();
  }
} catch (e) {
  ok(false, `probe threw: ${e?.stack ?? e}`);
} finally {
  for (const b of browsers) { await b.close().catch(() => {}); }
  engine?.kill('SIGKILL'); stub.close();
  await sleep(300);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
