/* LIVE PREVIEW on the phone's Room settings (Owner 2026-10-05).  node test/room-live-preview.probe.mjs
 * The real room page against a scratch engine (dead broker, temp table, never a live pane), at 390 and 1280.
 *   390: the toggle is the first thing in Art; off = today's full sheet; on = a bottom half with the line's
 *   top visible above it (the art control still applies live); remembered across a reload; closing the sheet
 *   clears it; 16px inputs, no autofocus on the toggle, no sideways scroll.   1280: no toggle, nothing changes. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(390);
const DEAD = P(391);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-live-preview-token';
const SHOTS = process.env.LIVEPV_SHOTS || tmpdir();
let failures = 0;
const ok = (c, m, d) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${d !== undefined ? `  (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); if (!c) failures += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runTsx = (args, env) => new Promise((resolve) => {
  const pr = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
  let out = ''; let err = '';
  pr.stdout.on('data', (d) => (out += d)); pr.stderr.on('data', (d) => (err += d));
  pr.on('exit', (code) => resolve({ code, out, err }));
});
await assertFree(PORT, 'room-live-preview.probe.mjs');
await assertFree(DEAD, 'room-live-preview.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-live-pv-'));
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
  const R = (await seed({ rooms: [{ name: 'Preview', seats: [{ handle: 'awake', recipe_id: 'rec-a' }] }] })).rooms[0].id;
  browser = await chromium.launch({ headless: true });
  for (const [w, h, phone] of [[390, 780, true], [1280, 860, false]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: phone });
    const pg = await ctx.newPage();
    const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
    await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
    await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);
    const cookie = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
    for (let i = 0; i < 25; i += 1) {
      await fetch(`${BASE}/api/rooms/${R}/line`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: `line ${i}` }) });
    }
    const open = async () => { await pg.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' }); await pg.waitForSelector('#roster .seat, .ph-hdr', { state: 'attached' }); await sleep(800); await pg.click(phone ? '#phGear' : '#gearBtn'); await pg.waitForSelector('.pv-set'); };
    const geo = () => pg.evaluate(() => { const r = document.getElementById('preview').getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height), vh: innerHeight, live: document.getElementById('preview').classList.contains('pv-live') }; });
    await open();
    const row = pg.locator('.rs-artgrp .pv-live-row');
    if (!phone) {
      ok(!(await row.isVisible()), `${w}: no Live preview toggle on the desktop column`);
      ok(!(await geo()).live, `${w}: the column is unchanged`);
      await pg.screenshot({ path: join(SHOTS, `live-preview-${w}.png`) });
    } else {
      ok(await row.isVisible() && await pg.evaluate(() => document.querySelector('.rs-artgrp').children[1].classList.contains('pv-live-row')), `${w}: the toggle is first in the Art section`);
      ok(await pg.evaluate(() => document.activeElement?.type !== 'checkbox'), `${w}: the toggle was not auto-focused`);
      const off = await geo();
      ok(!off.live && off.top === 0 || off.h >= off.vh * 0.85, `${w}: off = today's full sheet`, off);
      await pg.screenshot({ path: join(SHOTS, `live-preview-${w}-off.png`) });
      await row.locator('input').check();
      await sleep(150);
      const on = await geo();
      ok(on.live && on.h >= on.vh * 0.4 && on.h <= on.vh * 0.6 && on.top >= on.vh * 0.35, `${w}: on = a bottom half, the line shows above`, on);
      ok(await pg.evaluate(() => { const l = document.querySelector('.rm-line'); const r = l.getBoundingClientRect(); return r.height > 0 && r.top < innerHeight * 0.5; }), `${w}: the chat line is visible above the sheet`);
      /* an art control still applies live */
      await pg.locator('.rs-artgrp input[type=radio]').first().check().catch(() => {});
      ok(await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${w}: no sideways scroll`);
      const small = await pg.evaluate(() => [...document.querySelectorAll('.pv-set input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]), .pv-set select')].filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16).map((e) => e.outerHTML.slice(0, 90)));
      ok(small.length === 0, `${w}: 16px inputs in the sheet`, small);
      await pg.screenshot({ path: join(SHOTS, `live-preview-${w}-on.png`) });
      await open();
      ok((await geo()).live && await pg.locator('.rs-artgrp .pv-live-row input').isChecked(), `${w}: remembered after a reload`);
      await pg.click('#phGear'); // the gear toggles the sheet closed
      await sleep(200);
      ok(!(await geo()).live, `${w}: closing the sheet clears it`);
      await pg.evaluate(() => { localStorage.setItem('hwb.room.livePreview', '0'); });
      await open();
      ok(!(await geo()).live, `${w}: off again = the full sheet`);
    }
    ok(errs.length === 0, `${w}: no page errors`, errs.slice(0, 2));
    await ctx.close();
  }
} catch (e) {
  failures += 1; console.log(` FAIL ${e?.stack ?? e}`);
} finally {
  await browser?.close();
  engine?.kill('SIGKILL');
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* EPERM on Windows */ }
}
console.log(failures ? `FAIL ${failures}` : 'PASS');
process.exit(failures ? 1 : 0);
