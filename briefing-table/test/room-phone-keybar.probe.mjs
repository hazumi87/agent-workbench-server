/* THE KEY BAR IN A PHONE ROOM'S SEAT VIEW [room keybar]  node test/room-phone-keybar.probe.mjs
 * The real room page against a scratch engine (dead broker, temp table, never a live pane) at 390x844 (touch, mobile; Chromium
 * and WebKit when installed) with a SIMULATED soft keyboard (a faked visualViewport shrink on the ROOM page only, which is what
 * the seat frame cannot see: the room shrinks the seat layer, so inside the frame innerHeight == visualViewport.height).
 *   before the keys: the seat frame's .keypad is not shown; keyboard up: it is display:flex, inside the visible area, its first
 *   four keys Up, Down, Enter, Newline; keyboard down: hidden again; a seat frame that LOADS with the keyboard already up shows it. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = 7471;
const DEAD = 7472;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-phone-keybar-token';
const SHOTS = process.env.IPAD_SHOTS || tmpdir();
let failures = 0;
const ok = (c, m, d) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${d !== undefined ? `  (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); if (!c) failures += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runTsx = (args, env) => new Promise((resolve) => {
  const pr = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
  let out = ''; let err = '';
  pr.stdout.on('data', (d) => (out += d)); pr.stderr.on('data', (d) => (err += d));
  pr.on('exit', (code) => resolve({ code, out, err }));
});
/* before any page script: a visualViewport whose height the probe can shrink (the soft keyboard) */
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
await assertFree(PORT, 'room-phone-keybar.probe.mjs');
await assertFree(DEAD, 'room-phone-keybar.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-phone-keybar-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null; let browser = null; let log = '';
try {
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
    return JSON.parse(r.out.trim().split('\n').pop());
  };
  await seed({ recipes: [{ id: 'rec-a', name: 'Awake', projectDir: '/srv/x/awake', vendor: 'claude-code', agent: 'awake', color: '#0dab49' }] });
  const loader = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loader, join('src', 'server', 'index.ts')], { cwd: REPO_ROOT, env: childEnv({
    HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: dbPath, HARBOR_WB_TOKEN: TOKEN,
    HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'), HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_NO_WINDOW: '1',
    HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(DEAD),
    HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'cp'), HARBOR_WB_NODE: 'testnode' }) });
  engine.stdout.on('data', (d) => (log += d)); engine.stderr.on('data', (d) => (log += d));
  let up = false;
  for (let i = 0; i < 120 && !up; i += 1) { await sleep(250); try { up = (await fetch(`${BASE}/health`)).ok; } catch { /* not yet */ } }
  ok(up, 'scratch engine up', up ? undefined : log.slice(-300));
  if (!up) { throw new Error('no engine'); }
  const R = (await seed({ sessions: [{ paneid: 'recipe:rec-a', recipe_id: 'rec-a', vendor: 'claude-code', agent: 'awake', state: 'live' }],
    rooms: [{ name: 'Dialogs', seats: [{ handle: 'awake', recipe_id: 'rec-a', occupant: 'recipe:rec-a' }] }] })).rooms[0].id;
  const open = async (ctx) => {
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errs.push(String(e)));
    await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
    await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);
    await pg.goto(`${BASE}/room.html?room=${R}&shell=0`, { waitUntil: 'domcontentloaded' });
    await pg.waitForSelector('.ph-hdr', { state: 'attached' });
    await sleep(1500);
    return pg;
  };
  const openSeat = async (pg) => {
    await pg.tap('#phAgents');
    await pg.waitForSelector('#phSheet:not([hidden]) .seat[data-handle="awake"]');
    /* the sheet's seat row opens the seat's CLI in #seatView */
    await pg.evaluate(() => { document.querySelector('#phSheet .seat[data-handle="awake"]').click(); });
    await pg.waitForSelector('#seatView iframe:not([hidden])', { state: 'attached' });
    await sleep(2500);
  };
  const frameOf = (pg) => pg.frames().find((f) => f !== pg.mainFrame() && /solo\.html/.test(f.url()));
  const pad = (fr) => fr.evaluate(() => {
    const p = document.querySelector('.keypad');
    if (!p) { return { built: false }; }
    const r = p.getBoundingClientRect();
    const keys = [...p.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().width > 0 && getComputedStyle(b).display !== 'none').map((b) => (b.getAttribute('aria-label') || b.textContent).trim().split(' ')[0]);
    /* the bar's leading Hide/Show toggle is not one of the keys */
    if (/^(Hide|Show)$/.test(keys[0])) { keys.shift(); }
    return { built: true, display: getComputedStyle(p).display, top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), ih: innerHeight, kb: document.documentElement.classList.contains('kb-up'), keys: keys.slice(0, 4) };
  });
  const errs = [];
  for (const [name, type] of [['chromium', chromium], ['webkit', webkit]]) {
    try { browser = await type.launch({ headless: true }); } catch (e) { console.log(`  skip ${name}: not installed`); continue; }
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await ctx.addInitScript(INIT);
    const pg = await open(ctx);
    await openSeat(pg);
    let fr = frameOf(pg);
    ok(!!fr, `${name}: the seat's solo frame is open in #seatView`);
    if (!fr) { await browser.close(); browser = null; continue; }
    let s = await pad(fr);
    ok(s.built && s.display === 'none' && s.h === 0, `${name}: keyboard down: the key bar is not shown`, s);
    await pg.evaluate(() => window.__kb(330));
    await sleep(1200);
    s = await pad(fr);
    const fv = await pg.evaluate(() => window.visualViewport.height);
    ok(s.built && s.kb && s.display === 'flex' && s.h > 20, `${name}: keyboard up: the key bar is display:flex in the frame`, s);
    ok(s.built && s.top >= 0 && s.bottom <= s.ih + 1 && s.bottom <= fv + 1, `${name}: it sits inside the visible area (bottom ${s.bottom} <= frame ${s.ih}, visible ${Math.round(fv)})`, s);
    ok(JSON.stringify(s.keys) === JSON.stringify(['Up', 'Down', 'Enter', 'Newline']), `${name}: its first four keys are Up, Down, Enter, Newline`, s.keys);
    await pg.evaluate(() => window.__kb(0));
    await sleep(1200);
    s = await pad(frameOf(pg));
    ok(s.built && s.display === 'none', `${name}: keyboard down again: the key bar hides`, s);
    /* a seat frame that LOADS while the keyboard is already up */
    await pg.evaluate(() => window.__kb(330));
    await sleep(800);
    await pg.evaluate(() => { const f = document.querySelector('#seatView iframe'); f.src = f.src; });
    await sleep(3000);
    fr = frameOf(pg);
    s = fr ? await pad(fr) : { built: false };
    ok(s.built && s.kb && s.display === 'flex' && s.bottom <= s.ih + 1, `${name}: a seat frame that loads with the keyboard up shows the key bar`, s);
    await ctx.close();
    await browser.close(); browser = null;
  }
  /* WebKit reports in-flight fetches cancelled by a frame reload as errors: not ours */
  const real = errs.filter((e) => !/access control checks/.test(e));
  ok(real.length === 0, 'no page errors', real.slice(0, 2));
} catch (e) {
  failures += 1; console.log(` FAIL ${e?.stack ?? e}`);
} finally {
  await browser?.close();
  engine?.kill('SIGKILL');
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* EPERM on Windows */ }
}
console.log(failures ? `FAIL ${failures}` : 'PASS');
process.exit(failures ? 1 : 0);
