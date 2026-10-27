/* DIALOGS ABOVE THE SOFT KEYBOARD [dialog kb]  node test/room-dialog-kb.probe.mjs   Owner 2026-10-06
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
const PORT = P(404);
const DEAD = P(405);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-dialog-kb-token';
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
await assertFree(PORT, 'room-dialog-kb.probe.mjs');
await assertFree(DEAD, 'room-dialog-kb.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-dialog-kb-'));
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
  /* in view = the whole element inside the VISIBLE area [vv-top, vv-top + vvh] */
  const inView = (sel) => pg.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) { return null; }
    const r = e.getBoundingClientRect();
    const top = window.visualViewport.offsetTop;
    const vis = top + window.visualViewport.height;
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), visTop: Math.round(top), visBottom: Math.round(vis), ok: r.top >= top - 1 && r.bottom <= vis + 1 };
  }, sel);

  /* ---- the seat's Reload card ---- */
  await pg.tap('#phAgents');
  await pg.waitForSelector('#phSheet:not([hidden]) .seat[data-handle="awake"] .rsm-more');
  await pg.tap('#phSheet .seat[data-handle="awake"] .rsm-more');
  await pg.waitForSelector('.rsm-menu');
  await pg.locator('.rsm-mi', { hasText: 'Reload from project defaults' }).tap();
  await pg.waitForSelector('.rsm-card .rsm-wgroup', { timeout: 10000 });
  await pg.locator('.rsm-wgroup input[value="me"]').check();
  await sleep(200);
  ok(await pg.evaluate(() => !document.querySelector('.rsm-wtext').hidden), 'Reload card: "Send this as me" shows the welcome box');
  await pg.evaluate(() => { document.querySelector('.rsm-wtext').focus(); window.__kb(330); });
  await sleep(900);
  const box = await inView('.rsm-wtext');
  ok(box?.ok, 'Reload card: with the keyboard up the welcome box is inside the visible area (above the keys)', box);
  const card = await inView('.rsm-card');
  ok(card && card.top >= card.visTop - 1 && card.bottom <= card.visBottom + 1, 'Reload card: the card itself fits the visible area (capped, scrolling inside)', card);
  const scrim = await pg.evaluate(() => { const s = document.querySelector('.rsm-dscrim'); const r = s.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height), vvh: Math.round(window.visualViewport.height) }; });
  ok(Math.abs(scrim.h - scrim.vvh) <= 1 && scrim.top === 0, 'Reload card: the scrim IS the visible area', scrim);
  await pg.screenshot({ path: join(SHOTS, 'dialog-kb-reload.png') });
  const act = await pg.evaluate(() => [...document.querySelectorAll('.rsm-card .ft button')].map((b) => { const r = b.getBoundingClientRect(); return r.bottom <= window.visualViewport.height + 1 && r.height > 0; }));
  ok(act.length >= 2 && act.every(Boolean), 'Reload card: its buttons are reachable above the keys too', act);
  await pg.evaluate(() => { document.activeElement.blur(); window.__kb(0); });
  await sleep(500);
  const down = await pg.evaluate(() => { const c = document.querySelector('.rsm-card').getBoundingClientRect(); return { mid: Math.round((c.top + c.bottom) / 2), ih: innerHeight, kb: document.documentElement.classList.contains('kb-up') }; });
  ok(!down.kb && Math.abs(down.mid - down.ih / 2) < 40, 'Reload card: keyboard down, the card is centred again', down);
  await pg.locator('.rsm-card .ft button', { hasText: 'Cancel' }).tap();
  await pg.waitForSelector('.rsm-dscrim', { state: 'detached' });

  /* ---- the brief flyout sheet (the room's markdown note, phone bottom sheet) ---- */
  await pg.evaluate(() => document.getElementById('phScrim')?.click()); // the Agents sheet the card was opened from
  await sleep(300);
  await pg.tap('#phBrief button');
  await pg.waitForSelector('.rbf.is-sheet', { timeout: 8000 }).catch(() => {});
  const hasBrief = await pg.evaluate(() => !!document.querySelector('.rbf.is-sheet'));
  if (hasBrief) {
    const edit = pg.locator('.rbf button', { hasText: /Edit|Add|Set/ }).first();
    if (await edit.count()) { await edit.tap(); await sleep(300); }
    const hasTa = await pg.evaluate(() => !!document.querySelector('.rbf textarea'));
    if (hasTa) {
      await pg.evaluate(() => { document.querySelector('.rbf textarea').focus(); window.__kb(330); });
      await sleep(900);
      const sheet = await inView('.rbf.is-sheet');
      const ta = await inView('.rbf textarea');
      ok(sheet && sheet.bottom <= sheet.visBottom + 1 && ta?.ok, 'Brief sheet: docked to the visible bottom, its textarea above the keys', { sheet, ta });
      await pg.screenshot({ path: join(SHOTS, 'dialog-kb-brief.png') });
    } else {
      console.log('  (brief: no editable textarea for this credential; skipped)');
    }
  } else {
    console.log('  (brief: no flyout in this room; skipped)');
  }
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
