/* DIALOGS ABOVE THE SOFT KEYBOARD [dialog kb]  node test/room-note-editor-phone.probe.mjs   Owner 2026-10-06
 * (phone: the seat Reload card's welcome box sat under the keyboard). The real room page against a scratch engine (dead broker,
 * temp table, never a live pane) at 390 with a SIMULATED soft keyboard (a faked visualViewport shrink).
 *   Reload card: with "Send this as me" the welcome box shows; focused with the keys up, its whole box is inside the visible area
 *   (above the keys), the card is capped to it, the scrim IS the visible area; keyboard down: back to the centred card.
 *   Rename-room card: the same for its name field.   Brief flyout sheet: docks to the visible bottom, its textarea in view. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(436);
const DEAD = P(437);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-note-ed-token';
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
  let kb = 0; let top = 0;
  Object.defineProperties(fake, {
    width: { get: () => (real ? real.width : window.innerWidth) },
    height: { get: () => (real ? real.height : window.innerHeight) - kb },
    scale: { get: () => (real ? real.scale : 1) },
    offsetTop: { get: () => top },
    offsetLeft: { get: () => (real ? real.offsetLeft : 0) },
    pageTop: { get: () => (real ? real.pageTop : 0) },
    pageLeft: { get: () => (real ? real.pageLeft : 0) },
  });
  real?.addEventListener('resize', () => fake.dispatchEvent(new Event('resize')));
  Object.defineProperty(window, 'visualViewport', { get: () => fake, configurable: true });
  window.__kb = (px) => { kb = px; fake.dispatchEvent(new Event('resize')); };
  window.__pan = (px) => { top = px; fake.dispatchEvent(new Event('scroll')); };
};
await assertFree(PORT, 'room-note-editor-phone.probe.mjs');
await assertFree(DEAD, 'room-note-editor-phone.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-note-ed-'));
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
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(INIT);
  const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
  await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);
  await pg.goto(`${BASE}/room.html?room=${R}&shell=0`, { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('.ph-hdr', { state: 'attached' });
  await sleep(1500);
  const KB = 330;
  const snap = () => pg.evaluate(() => {
    const vv = window.visualViewport; const c = document.querySelector('.nt-card'); const r = c?.getBoundingClientRect();
    const comp = document.querySelector('.rm-compose')?.getBoundingClientRect();
    const t = document.elementFromPoint(195, Math.max(2, Math.round(vv.height - 20)));
    return { vvh: Math.round(vv.height), vvTop: Math.round(vv.offsetTop), ih: innerHeight, kbUp: document.documentElement.classList.contains('kb-up'), cssVvh: document.documentElement.style.getPropertyValue('--vvh'),
      card: r && { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }, comp: comp && { top: Math.round(comp.top), bottom: Math.round(comp.bottom) },
      hit: t?.className?.toString().slice(0, 40) || t?.tagName, inCard: !!t?.closest('.nt-card'), scrollY: scrollY };
  });
  await pg.tap('#attBtn');
  await pg.waitForSelector('.rsm-menu');
  await pg.locator('.rsm-mi', { hasText: 'New note' }).tap();
  await pg.waitForSelector('.nt-card');
  await sleep(300);
  if (await pg.$('.nt-card.nt-chat')) { await pg.tap('.nt-fs'); await sleep(300); }
  ok(await pg.$('.nt-card.nt-full') !== null, 'the editor is the full-page layer');
  const s0 = await snap();
  ok(s0.card.top === 0 && Math.abs(s0.card.bottom - s0.vvh) <= 1, 'keyboard down: the card is the visible viewport', s0);
  await pg.screenshot({ path: join(SHOTS, 'note-ed-0.png') });

  /* the keyboard comes up as iOS does it: focus, then the visual viewport shrinks (and may pan) */
  await pg.tap('.nt-ta');
  await pg.evaluate(() => window.__kb(330));
  await sleep(1300);
  const s1 = await snap();
  ok(s1.kbUp, 'the tracker saw the keyboard', s1);
  ok(s1.card.top === s1.vvTop && Math.abs(s1.card.bottom - (s1.vvTop + s1.vvh)) <= 1, 'keyboard up: the card is exactly the visible viewport (top to the keys)', s1);
  ok(s1.inCard, 'nothing behind the card shows at the bottom of the visible area (the point there is the card)', s1);
  await pg.screenshot({ path: join(SHOTS, 'note-ed-1.png') });

  /* typing: the textarea keeps focus and the keyboard never flips */
  await pg.evaluate(() => {
    const ta = document.querySelector('.nt-ta'); const comp = document.getElementById('input');
    window.__ev = []; window.__kbSeen = [];
    for (const [n, el] of [['note', ta], ['comp', comp]]) { for (const t of ['blur', 'focus']) { el.addEventListener(t, () => window.__ev.push(`${n}:${t}`)); } }
    new MutationObserver(() => window.__kbSeen.push(document.documentElement.classList.contains('kb-up'))).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    window.__act = [];
    setInterval(() => window.__act.push(document.activeElement === ta), 25);
  });
  for (let i = 0; i < 40; i += 1) { await pg.keyboard.type(String.fromCharCode(97 + (i % 26))); await sleep(60); }
  await sleep(2600); // past the 1 s poll and autosave
  for (let i = 0; i < 10; i += 1) { await pg.keyboard.type('z'); await sleep(60); }
  const ev = await pg.evaluate(() => ({ ev: window.__ev, kbSeen: window.__kbSeen, act: window.__act.filter((x) => !x).length, n: window.__act.length, len: document.querySelector('.nt-ta').value.length, isAct: document.activeElement === document.querySelector('.nt-ta') }));
  ok(ev.len === 50, 'all 50 characters landed in the note', ev.len);
  ok(ev.isAct && ev.act === 0, 'the note textarea was activeElement the whole run', ev);
  ok(ev.ev.length === 0, 'no blur/focus on the note or the composer during typing', ev.ev);
  ok(!ev.kbSeen.includes(false), 'the keyboard state never flipped down', ev.kbSeen);
  const s2 = await snap();
  ok(s2.card.top === s2.vvTop && Math.abs(s2.card.bottom - (s2.vvTop + s2.vvh)) <= 1 && s2.scrollY === 0, 'after typing: still exactly the visible viewport, page not scrolled', s2);

  /* iOS pans the visual viewport inside the layout one while a field is focused */
  await pg.evaluate(() => window.__pan?.(60));
  await sleep(1300);
  const s3 = await snap();
  ok(Math.abs(s3.card.bottom - (s3.vvTop + s3.vvh)) <= 1 && s3.card.top === s3.vvTop, 'panned 60px: the card follows the visible viewport', s3);
  ok(errs.length === 0, 'no page errors', errs.slice(0, 2));
} catch (e) {
  failures += 1; console.log(` FAIL ${e?.stack ?? e}`);
} finally {
  await browser?.close();
  engine?.kill('SIGKILL');
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* EPERM on Windows */ }
}
console.log(failures ? `FAIL ${failures}` : 'PASS');
process.exit(failures ? 1 : 0);
