/* DIALOG CARD CAP IS OPT-IN [kb cap]  node test/room-card-cap-phone.probe.mjs   Owner 2026-10-13 (audit the design notes C2/D4)
 * 390x844 iPhone emulation, faked soft keyboard (visualViewport shrink, as test/room-dialog-kb.probe.mjs).
 *   CENTRED dialogs (the seat menu's Reload / Remove / Move / Switch cards, the chat-height note card): computed max-height and
 *     overflow-y with the keyboard up and down. PROBE_RECORD=<file> writes them (run it on main); PROBE_EXPECT=<file> asserts the same
 *     numbers (run it on the branch): the old behaviour must be unchanged.
 *   FULL-HEIGHT cards (the full-page note editor; the document viewer .dv-lg, static harness, kb-up set by hand like the tracker does):
 *     card top..bottom == the visible viewport, elementFromPoint at the bottom of the visible area is the card, keyboard up AND down.
 * Scratch engine on P(n) (WB_TEST_PORT_OFFSET), dead broker, temp table, never a live pane. A PROBE, not in `npm test`. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';
import { serveWeb } from './_docview-harness.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(560);
const DEAD = P(561);
const HPORT = P(562);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-card-cap-token';
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
};
const KB = 330;
const recorded = {}; // label -> {up:{maxH,oy,h}, down:{...}}
await assertFree(PORT, 'room-card-cap-phone.probe.mjs');
await assertFree(DEAD, 'room-card-cap-phone.probe.mjs');
await assertFree(HPORT, 'room-card-cap-phone.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-card-cap-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null; let browser = null; let log = ''; let hsrv = null;
try {
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
    return JSON.parse(r.out.trim().split('\n').pop());
  };
  await seed({ recipes: [
    { id: 'rec-a', name: 'Awake', projectDir: '/srv/x/awake', vendor: 'claude-code', agent: 'awake', color: '#0dab49' },
    { id: 'rec-b', name: 'Other', projectDir: '/srv/x/other', vendor: 'claude-code', agent: 'other', color: '#0d6bab' },
  ] });
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
  const R = (await seed({ sessions: [
    { paneid: 'recipe:rec-a', recipe_id: 'rec-a', vendor: 'claude-code', agent: 'awake', state: 'live' },
    { paneid: 'recipe:rec-b', recipe_id: 'rec-b', vendor: 'claude-code', agent: 'other', state: 'live' },
  ], rooms: [{ name: 'Dialogs', seats: [
    { handle: 'awake', recipe_id: 'rec-a', occupant: 'recipe:rec-a' }, { handle: 'other', recipe_id: 'rec-b', occupant: 'recipe:rec-b' },
  ] }] })).rooms[0].id;
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(INIT);
  const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
  await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);
  await pg.goto(`${BASE}/room.html?room=${R}&shell=0`, { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('.ph-hdr', { state: 'attached' });
  await sleep(1500);

  const cardVals = (sel) => pg.evaluate((s) => {
    const c = document.querySelector(s); if (!c) { return null; }
    const cs = getComputedStyle(c); const r = c.getBoundingClientRect();
    return { maxH: cs.maxHeight, oy: cs.overflowY, h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) };
  }, sel);
  const both = async (label, sel) => {
    const down0 = await cardVals(sel);
    await pg.evaluate((k) => window.__kb(k), KB); await sleep(700);
    const upv = await cardVals(sel);
    await pg.evaluate(() => window.__kb(0)); await sleep(500);
    const down = await cardVals(sel);
    recorded[label] = { up: { maxH: upv?.maxH, oy: upv?.oy, h: upv?.h }, down: { maxH: down?.maxH, oy: down?.oy, h: down?.h } };
    console.log(`  VAL ${label}: ${JSON.stringify(recorded[label])}  (first-open down ${JSON.stringify(down0)})`);
    return { upv, down };
  };

  /* ---- CENTRED dialogs: the seat menu's cards ---- */
  const openSeatItem = async (handle, re) => {
    await pg.tap('#phAgents');
    await pg.waitForSelector(`#phSheet:not([hidden]) .seat[data-handle="${handle}"] .rsm-more`);
    await pg.tap(`#phSheet .seat[data-handle="${handle}"] .rsm-more`);
    await pg.waitForSelector('.rsm-menu');
    const item = pg.locator('.rsm-mi:not([aria-disabled="true"])', { hasText: re }).first();
    if (!(await item.count())) { await pg.keyboard.press('Escape'); await pg.evaluate(() => document.getElementById('phScrim')?.click()); await sleep(300); return false; }
    await item.tap();
    await pg.waitForSelector('.rsm-card', { timeout: 6000 }).catch(() => {});
    return !!(await pg.$('.rsm-card'));
  };
  const closeCard = async () => {
    await pg.evaluate(() => { document.activeElement?.blur?.(); window.__kb(0); });
    const cancel = pg.locator('.rsm-card .ft button').first();
    if (await cancel.count()) { await cancel.tap().catch(() => {}); }
    await pg.waitForSelector('.rsm-dscrim', { state: 'detached', timeout: 4000 }).catch(() => {});
    await pg.evaluate(() => document.getElementById('phScrim')?.click());
    await sleep(400);
  };
  const opened = [];
  for (const [label, handle, re] of [['reload', 'awake', /Reload from project/], ['remove', 'awake', /Remove from room/], ['remove-other', 'other', /Remove from room/],
    ['move', 'other', /Move to workgroup/], ['switch', 'other', /Switch assistant/], ['cleared', 'other', /Clear/]]) {
    if (!(await openSeatItem(handle, re))) { console.log(`  (not reachable here: ${label})`); continue; }
    opened.push(label);
    const { upv, down } = await both(`centred:${label}`, '.rsm-card');
    ok(upv && upv.maxH !== 'none' && upv.oy === 'auto', `${label}: keyboard up, the card carries the cap (max-height ${upv?.maxH}, overflow-y ${upv?.oy})`, upv);
    ok(upv && upv.top >= 0 && upv.bottom <= 844 - KB + 1, `${label}: keyboard up, the card fits above the keys`, upv);
    ok(down && down.maxH.endsWith('px') && Math.abs(down.h - 0) >= 0, `${label}: keyboard down, the card is back to its normal cap (${down?.maxH})`);
    await closeCard();
  }
  ok(opened.includes('reload') && opened.includes('remove-other') || opened.includes('remove'), 'at least Reload and a Remove card were reachable', opened);

  /* ---- the note: chat-height card (centred-class, capped) then the full page (never capped) ---- */
  await pg.tap('#attBtn');
  await pg.waitForSelector('.rsm-menu');
  await pg.locator('.rsm-mi', { hasText: 'New note' }).tap();
  await pg.waitForSelector('.nt-card');
  await sleep(400);
  if (await pg.$('.nt-card.nt-full')) { await pg.tap('.nt-fs'); await sleep(400); }
  ok(!!(await pg.$('.nt-card.nt-chat')), 'the note opens as the chat-height card');
  const chat = await both('centred:note-chat', '.nt-card');
  ok(chat.upv?.maxH !== 'none' && chat.upv?.oy === 'auto', 'note chat card: keyboard up, capped', chat.upv);
  await pg.tap('.nt-fs');
  await sleep(500);
  ok(!!(await pg.$('.nt-card.nt-full')), 'the full-page note editor is open');
  const fullSnap = () => pg.evaluate(() => {
    const vv = window.visualViewport; const c = document.querySelector('.nt-card'); const r = c.getBoundingClientRect(); const cs = getComputedStyle(c);
    const y = Math.round(vv.offsetTop + vv.height - 6);
    const t = document.elementFromPoint(195, y);
    return { vvTop: Math.round(vv.offsetTop), vvBottom: Math.round(vv.offsetTop + vv.height), top: Math.round(r.top), bottom: Math.round(r.bottom), maxH: cs.maxHeight, hitIsCard: !!t?.closest('.nt-card'), hit: (t?.className?.toString() || t?.tagName || '').slice(0, 30), kbUp: document.documentElement.classList.contains('kb-up') };
  });
  const f0 = await fullSnap();
  ok(f0.top === f0.vvTop && Math.abs(f0.bottom - f0.vvBottom) <= 1 && f0.hitIsCard, 'note full page, keyboard down: card == visible viewport, bottom point is the card', f0);
  await pg.tap('.nt-ta'); await pg.evaluate((k) => window.__kb(k), KB); await sleep(1300);
  const f1 = await fullSnap();
  ok(f1.kbUp && f1.top === f1.vvTop && Math.abs(f1.bottom - f1.vvBottom) <= 1 && f1.hitIsCard && f1.maxH === 'none', 'note full page, keyboard up: card == visible viewport (no 24px strip), bottom point is the card, no cap', f1);
  await pg.screenshot({ path: join(SHOTS, 'card-cap-note-full.png') });
  await pg.evaluate(() => window.__kb(0)); await sleep(800);

  /* ---- the document viewer, static harness (the real module + room.css + room-doc-view.css) ---- */
  const docs = mkdtempSync(join(tmpdir(), 'docview-cap-'));
  process.env.DOCVIEW_DOCS = docs;
  writeFileSync(join(docs, 'plan.md'), '# Plan\n\n' + Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}. Lorem ipsum dolor sit amet.\n`).join('\n'));
  hsrv = await serveWeb(HPORT);
  const dctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const dp = await dctx.newPage();
  await dp.goto(`http://127.0.0.1:${HPORT}/__harness.html`);
  await dp.waitForFunction(() => window.ready);
  await dp.evaluate(() => window.mount({ name: 'plan.md', kind: 'markdown', url: '/__doc/plan.md', base: `${location.origin}/api/rooms/r1/assets/raw/plan.md`, ref: 'https://share.test/ref/plan.md' }));
  await dp.waitForSelector('.dv-md');
  await dp.evaluate(() => window.cur.openFull());
  await dp.waitForSelector('.dv-lg .dv-md');
  await sleep(300);
  const dvSnap = (vvh) => dp.evaluate((h) => {
    const c = document.querySelector('.dv-lg'); const r = c.getBoundingClientRect();
    const t = document.elementFromPoint(195, h - 6);
    return { vvh: h, top: Math.round(r.top), bottom: Math.round(r.bottom), hitIsCard: !!t?.closest('.dv-lg'), hit: (t?.className?.toString() || t?.tagName || '').slice(0, 30) };
  }, vvh);
  const d0 = await dvSnap(844);
  ok(d0.top === 0 && Math.abs(d0.bottom - 844) <= 1 && d0.hitIsCard, 'doc viewer, keyboard down: card == visible viewport, bottom point is the card', d0);
  /* what the tracker writes while the keyboard is up (web/soft-keyboard.mjs): html.kb-up, --vvh, --vv-top */
  await dp.evaluate((h) => { const e = document.documentElement; e.classList.add('kb-up'); e.style.setProperty('--vvh', `${h}px`); e.style.setProperty('--vv-top', '0px'); }, 844 - KB);
  await sleep(300);
  const d1 = await dvSnap(844 - KB);
  ok(d1.top === 0 && Math.abs(d1.bottom - (844 - KB)) <= 1 && d1.hitIsCard, 'doc viewer, keyboard up: card == visible viewport (top to just above the keys, no 24px strip), bottom point is the card', d1);
  await dp.screenshot({ path: join(SHOTS, 'card-cap-docview-kb.png') });
  await dctx.close();
  ok(errs.length === 0, 'no page errors', errs.slice(0, 2));

  if (process.env.PROBE_RECORD) { writeFileSync(process.env.PROBE_RECORD, JSON.stringify(recorded, null, 1)); console.log(`  recorded ${Object.keys(recorded).length} centred card states to ${process.env.PROBE_RECORD}`); }
  if (process.env.PROBE_EXPECT) {
    const exp = JSON.parse(readFileSync(process.env.PROBE_EXPECT, 'utf8'));
    for (const k of Object.keys(exp)) { ok(JSON.stringify(recorded[k]) === JSON.stringify(exp[k]), `UNCHANGED vs main: ${k}`, { main: exp[k], now: recorded[k] }); }
  }
} catch (e) {
  failures += 1; console.log(` FAIL ${e?.stack ?? e}`);
} finally {
  await browser?.close();
  hsrv?.close();
  engine?.kill('SIGKILL');
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* EPERM on Windows */ }
}
console.log(failures ? `FAIL ${failures}` : 'PASS');
process.exit(failures ? 1 : 0);
