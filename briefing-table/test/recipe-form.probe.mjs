/* THE RECIPE FORM (CLI Manager), the design system 2026-09-28: Effort beside Model; the
 * "[ ] Resume" checkbox and "Save & Launch" are gone; a LEGACY named resume
 * shows only on a recipe that still has one, in the checkbox's old slot, dim:
 * Launches by resuming "<name>" . Clear, where Clear acts ON SAVE.
 *
 *   node test/recipe-form.probe.mjs
 *
 * What only a browser can prove: the form's controls (and the ones that must
 * be absent); Effort sits BESIDE Model at the same size and style, and on a
 * 390px phone each takes its own full row; the legacy line's words, colours
 * and place; Clear hides the line but changes nothing until Save, and the
 * real POST /api/recipes body (and the engine's stored recipe) after it; the
 * Effort select saves and clears; a non-claude vendor hides Effort; the card's
 * Resume opens the SHARED picker (web/resume-picker.mjs).
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(192), DEAD broker P(193),
 * a temp table seeded through the store, childEnv() scrubbed, fabric + NATS
 * off; never Owner's data.
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
const PORT = P(192);
const DEAD_BROKER_PORT = P(193);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-recipe-form-token';
const DOT = String.fromCharCode(183);
const MDASH = String.fromCharCode(8212);

let failures = 0;
let passes = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; } else { passes += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

for (const p of [PORT, DEAD_BROKER_PORT]) {
  await assertFree(p, 'recipe-form.probe.mjs');
}
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-recipe-form-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null;
let browser = null;
let engineLog = '';
const recipesNow = async () => (await (await fetch(`${BASE}/api/recipes`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).recipes;
const recipeNow = async (id) => (await recipesNow()).find((r) => r.id === id);

try {
  const seed = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify({
    recipes: [
      { id: 'rec-legacy', name: 'Legacy', projectDir: '/srv/x/legacy', vendor: 'claude-code', agent: 'legacy', model: 'opus', effort: 'high', resume: 1, resumeName: 'planning' },
      { id: 'rec-plain', name: 'Plain', projectDir: '/srv/x/plain', vendor: 'claude-code', agent: 'plain' },
      { id: 'rec-pick', name: 'Picker', projectDir: '/srv/x/picker', vendor: 'claude-code', agent: 'picker', resume: 1 },
    ],
  })], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (seed.code !== 0) { throw new Error(`seed failed: ${seed.err}`); }
  const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: dbPath, HARBOR_WB_TOKEN: TOKEN,
      HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'), HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT), HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'), HARBOR_WB_NODE: 'testnode',
    }),
  });
  engine.stdout.on('data', (d) => (engineLog += d));
  engine.stderr.on('data', (d) => (engineLog += d));
  let up = false;
  for (let i = 0; i < 120 && !up; i += 1) {
    await sleep(250);
    up = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false);
  }
  ok(up, `scratch engine is serving on ${PORT}`, up ? undefined : engineLog.slice(-400));
  if (!up) { throw new Error('engine never came up'); }

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const saves = [];
  page.on('request', (q) => {
    if (q.method() === 'POST' && new URL(q.url()).pathname === '/api/recipes') {
      try { saves.push(JSON.parse(q.postData() || 'null')); } catch { saves.push(null); }
    }
  });
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  await page.goto(`${BASE}/manager.html#recipes`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sess', { timeout: 8000 });
  await sleep(800);

  const card = (name) => page.locator('.sess', { has: page.locator('.sess-name', { hasText: new RegExp(`^${name}$`) }) }).first();
  const openEdit = async (pg, name) => {
    await pg.locator('.sess', { has: pg.locator('.sess-name', { hasText: new RegExp(`^${name}$`) }) }).first().locator('[data-act="edit"]').click();
    await pg.waitForSelector('#formModal:not([hidden])', { timeout: 5000 });
    await sleep(150);
  };
  /* Save, and Save again when the engine warns about the folder (this scratch
     engine cannot reach the target's machine, so every save carries the
     "could not check" warning; a second Save means "I know" and closes). */
  const save = async (pg = page) => {
    await pg.click('#saveBtn');
    await sleep(700);
    if (await pg.$('#formModal:not([hidden])') && await pg.$('#fDirWarn:not([hidden])')) {
      await pg.click('#saveBtn');
      await sleep(700);
    }
  };
  const form = (pg = page) => pg.evaluate(() => {
    const R = (e) => e.getBoundingClientRect();
    const m = document.getElementById('fModel');
    const e = document.getElementById('fEffort');
    const lab = (x) => x?.closest('.f-row')?.querySelector(':scope > span')?.textContent ?? null;
    const cs = (x) => (x ? getComputedStyle(x) : null);
    const leg = document.getElementById('fLegacyResume');
    const probe = document.createElement('span');
    document.body.append(probe);
    const tok = (v) => { probe.style.color = `var(${v})`; return getComputedStyle(probe).color; };
    const dim = tok('--dim');
    const sky = tok('--sky');
    probe.remove();
    const vis = (x) => !!x && x.offsetParent !== null && getComputedStyle(x).display !== 'none';
    return {
      resumeBox: !!document.getElementById('fResume'), resumeName: !!document.getElementById('fResumeName'),
      saveLaunch: !!document.getElementById('saveLaunchBtn') || [...document.querySelectorAll('#form button')].some((b) => /launch/i.test(b.textContent)),
      actions: [...document.querySelectorAll('#form .f-actions button')].map((b) => b.textContent.trim()),
      model: m && { l: R(m).left, r: R(m).right, t: R(m).top, b: R(m).bottom, w: Math.round(R(m).width), h: Math.round(R(m).height), bg: cs(m).backgroundColor, bd: cs(m).borderTopColor + ' ' + cs(m).borderTopWidth, fs: cs(m).fontSize, rad: cs(m).borderTopLeftRadius, label: lab(m), value: m.value, tag: m.tagName, options: [...(m.options ?? [])].map((o) => o.value) },
      effort: e && { l: R(e).left, r: R(e).right, t: R(e).top, b: R(e).bottom, w: Math.round(R(e).width), h: Math.round(R(e).height), bg: cs(e).backgroundColor, bd: cs(e).borderTopColor + ' ' + cs(e).borderTopWidth, fs: cs(e).fontSize, rad: cs(e).borderTopLeftRadius, label: lab(e), value: e.value, tag: e.tagName, vis: vis(e), options: [...e.options].map((o) => [o.value, o.textContent]) },
      legacy: { vis: vis(leg), text: leg?.textContent ?? '', color: leg ? cs(leg).color : null, prevIsPair: leg?.previousElementSibling?.classList.contains('f-pair') ?? false,
        clear: leg?.querySelector('button') ? { text: leg.querySelector('button').textContent, color: cs(leg.querySelector('button')).color, h: Math.round(R(leg.querySelector('button')).height) } : null },
      dim, sky, sw: document.documentElement.scrollWidth, vw: innerWidth,
    };
  });

  /* 1. a recipe with a legacy named resume */
  await openEdit(page, 'Legacy');
  let f = await form();
  ok(!f.resumeBox && !f.resumeName, 'no "[ ] Resume" checkbox and no session-name field', { box: f.resumeBox, name: f.resumeName });
  ok(!f.saveLaunch && JSON.stringify(f.actions) === JSON.stringify(['Save', 'Cancel']), 'no "Save & Launch": only Save (and Cancel)', f.actions);
  ok(f.effort && f.effort.tag === 'SELECT' && f.effort.label === 'Effort' && f.model.label === 'Model', 'an EFFORT select, labelled "Effort", beside Model', f.effort && { tag: f.effort.tag, label: f.effort.label });
  ok(JSON.stringify(f.effort.options) === JSON.stringify([['', 'Default'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max'], ['ultracode', 'ultracode']]),
    '...options: Default · low · medium · high · xhigh · max · ultracode', f.effort.options);
  ok(f.effort.value === 'high' && f.model.value === 'opus', "...showing the recipe's own (opus, high)", { m: f.model.value, e: f.effort.value });
  ok(Math.round(f.effort.t) === Math.round(f.model.t) && Math.abs(f.effort.w - f.model.w) <= 1 && f.effort.h === f.model.h && Math.round(f.effort.l - f.model.r) === 10,
    'desktop: side by side, same width and height, 10px apart', { model: f.model, effort: f.effort });
  ok(f.model.tag === 'SELECT' && ['', 'sonnet', 'opus', 'fable'].every((v) => f.model.options.includes(v)), 'Model is a dropdown listing Default, sonnet, opus and fable whatever the recipe holds (a datalist showed only the typed value)', f.model);
  ok(f.effort.bg === f.model.bg && f.effort.bd === f.model.bd && f.effort.fs === f.model.fs && f.effort.rad === f.model.rad, '...and the same field style (ground, border, type, corners)', [f.model.bg, f.model.bd, f.model.fs, f.effort.bg, f.effort.bd, f.effort.fs]);
  ok(f.legacy.vis && f.legacy.text === `Launches by resuming "planning" ${DOT} Clear` && f.legacy.prevIsPair, `the LEGACY line, in the old checkbox's slot: Launches by resuming "planning" ${DOT} Clear`, f.legacy);
  ok(f.legacy.color === f.dim && f.legacy.clear?.color === f.sky, '...in --dim, with a sky Clear', { line: f.legacy.color, dim: f.dim, clear: f.legacy.clear?.color, sky: f.sky });

  /* 2. Clear is ON SAVE: the line goes, nothing is written; Cancel forgets it */
  await page.click('#fLegacyResume button');
  f = await form();
  let rec = await recipeNow('rec-legacy');
  ok(!f.legacy.vis && saves.length === 0 && rec.resume === 1 && rec.resumeName === 'planning', 'Clear hides the line and writes NOTHING yet', { vis: f.legacy.vis, saves: saves.length, rec: [rec.resume, rec.resumeName] });
  await page.click('#cancelBtn');
  await openEdit(page, 'Legacy');
  f = await form();
  ok(f.legacy.vis && /planning/.test(f.legacy.text), 'Cancel, reopen: the legacy line is back (Clear never saved)', f.legacy.text);
  await page.click('#fLegacyResume button');
  await save();
  rec = await recipeNow('rec-legacy');
  const last = saves[saves.length - 1];
  ok(last && last.resume === false && last.resumeName === '' && last.effort === 'high' && last.model === 'opus', "Clear + Save: the body carries resume false, resumeName '' (and keeps model/effort)", last && { resume: last.resume, resumeName: last.resumeName, model: last.model, effort: last.effort });
  ok(rec.resume === 0 && rec.resumeName === null && rec.effort === 'high' && rec.model === 'opus', '...the engine: no named resume any more; model and effort kept', { resume: rec.resume, resumeName: rec.resumeName, effort: rec.effort, model: rec.model });
  await openEdit(page, 'Legacy');
  f = await form();
  ok(!f.legacy.vis, '...reopened: no legacy line (the recipe no longer has one)', f.legacy);

  /* 3. the Effort select saves, and Default clears it */
  await page.selectOption('#fEffort', 'ultracode');
  await save();
  ok(saves[saves.length - 1]?.effort === 'ultracode' && (await recipeNow('rec-legacy')).effort === 'ultracode', 'Effort ultracode saves', saves[saves.length - 1]?.effort);
  await openEdit(page, 'Legacy');
  await page.selectOption('#fEffort', '');
  await save();
  ok(saves[saves.length - 1]?.effort === null && (await recipeNow('rec-legacy')).effort === null, 'Effort Default saves null (no --effort flag)', saves[saves.length - 1]?.effort);

  /* 4. a recipe with no legacy resume; a resume-by-picker one; the vendor */
  await openEdit(page, 'Plain');
  f = await form();
  ok(!f.legacy.vis && f.effort.value === '', 'a recipe with no named resume: no legacy line; Effort reads Default', { legacy: f.legacy.vis, effort: f.effort.value });
  await page.selectOption('#fVendor', 'gemini-cli');
  f = await form();
  ok(!f.effort.vis && f.model.w > 300, 'gemini-cli: Effort (a claude flag) is hidden and Model takes the row', { effortVis: f.effort.vis, modelW: f.model.w });
  await page.selectOption('#fVendor', 'claude-code');
  await page.click('#cancelBtn');
  await openEdit(page, 'Picker');
  f = await form();
  ok(f.legacy.vis && f.legacy.text === `Launches by opening the resume picker ${DOT} Clear`, 'a legacy resume WITHOUT a name reads "Launches by opening the resume picker · Clear"', f.legacy.text);
  await page.click('#cancelBtn');

  /* 5. a NEW recipe saves its effort */
  await page.evaluate(() => { location.hash = '#recipes'; }); // the recipe editor's button lives on the Recipes screen
  await page.click('#newBtn');
  await page.waitForSelector('#formModal:not([hidden])');
  await page.fill('#fName', 'Fresh One');
  await page.fill('#fDir', '/srv/x/fresh-one');
  await page.selectOption('#fEffort', 'max');
  await save();
  const made = (await recipesNow()).find((r) => r.name === 'Fresh One');
  const madeBody = saves[saves.length - 1];
  ok(made?.effort === 'max' && made?.resume === 0 && madeBody?.resume === false && madeBody?.resumeName === '', 'a NEW recipe: effort max saved, no resume', { effort: made?.effort, resume: made?.resume, body: madeBody && [madeBody.resume, madeBody.resumeName] });
  if (!(await page.$('#formModal[hidden]'))) { await page.click('#cancelBtn').catch(() => {}); }

  /* 6. the card's Resume opens the SHARED picker (one picker, two surfaces) */
  await card('Plain').locator('[data-act="resume"]').click();
  await page.waitForSelector('#resumeModal .rp-box', { timeout: 5000 });
  await sleep(400);
  const pk = await page.evaluate(() => ({ title: document.getElementById('resumeTitle')?.textContent, list: document.getElementById('resumeList')?.textContent.trim(), dialog: document.querySelector('#resumeModal .rp-box')?.getAttribute('role') }));
  ok(pk.title === `Resume ${MDASH} Plain` && pk.dialog === 'dialog' && /No resumable sessions/.test(pk.list), "the card's Resume opens the shared picker (web/resume-picker.mjs)", pk);
  await page.keyboard.press('Escape');
  await sleep(150);
  ok(!(await page.$('#resumeModal')) && (await page.$('#formModal[hidden]')), '...Esc closes it', null);
  ok(errors.length === 0, 'no page errors (desktop)', errors.slice(0, 3));

  /* 7. PHONE 390: Model and Effort one full row each, stacked */
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: await context.storageState() });
  await phone.addInitScript(() => {
    Object.defineProperty(window.screen, 'width', { get: () => 390 });
    Object.defineProperty(window.screen, 'height', { get: () => 844 });
  });
  const pp = await phone.newPage();
  const perr = [];
  pp.on('pageerror', (e) => perr.push(String(e)));
  await pp.goto(`${BASE}/manager.html#recipes`, { waitUntil: 'domcontentloaded' });
  await pp.waitForSelector('.sess', { timeout: 8000 });
  await sleep(600);
  await openEdit(pp, 'Picker');
  f = await form(pp);
  ok(f.effort.t >= f.model.b + 8 - 0.5 && Math.round(f.effort.l) === Math.round(f.model.l) && f.effort.w === f.model.w, 'phone (390): Effort takes its own row under Model, the same full width', { model: f.model, effort: f.effort });
  ok(f.model.h === 44 && f.effort.h === 44 && f.model.fs === '16px' && f.effort.fs === '16px', 'phone: 44px fields at 16px (no focus zoom)', [f.model.h, f.effort.h, f.model.fs, f.effort.fs]);
  ok(f.legacy.vis && f.legacy.clear?.h >= 44, 'phone: Clear is a 44px target', f.legacy.clear);
  ok(f.sw <= f.vw, 'phone: no sideways scroll', { sw: f.sw, vw: f.vw });
  /* the design system r23 review: the Theme row (swatch . Logo . A 16 . A-/A+ .
     auto-saves) ran past the modal's right edge; it wraps to a second line */
  const th = await pp.evaluate(() => {
    const row = document.querySelector('#form .f-theme');
    const form = document.getElementById('form');
    const fr = form.getBoundingClientRect();
    const inner = fr.right - parseFloat(getComputedStyle(form).paddingRight);
    const kids = [...row.children].filter((k) => k.offsetParent !== null).map((k) => ({ c: k.className || k.id, l: Math.round(k.getBoundingClientRect().left), r: Math.round(k.getBoundingClientRect().right), t: Math.round(k.getBoundingClientRect().top) }));
    return { inner: Math.round(inner), rowSW: row.scrollWidth, rowCW: row.clientWidth, formSW: form.scrollWidth, formCW: form.clientWidth, wrapped: kids.some((k) => k.t > Math.min(...kids.map((x) => x.t)) + 16), kids };
  });
  ok(th.kids.length >= 4 && th.kids.every((k) => k.r <= th.inner) && th.rowSW <= th.rowCW && th.formSW <= th.formCW,
    'phone: the Theme row stays inside the form (no horizontal overflow)', th);
  ok(th.wrapped, '...by wrapping onto a second line', th.kids.map((k) => [k.c, k.t]));
  ok(perr.length === 0, 'no page errors (phone)', perr.slice(0, 3));
  await phone.close();
} catch (e) {
  ok(false, `probe crashed: ${e?.stack ?? e}`);
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill('SIGKILL'); }
  await sleep(200);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
if (failures) {
  console.log('\nengine log (tail):\n' + engineLog.split('\n').slice(-20).join('\n'));
}
console.log(failures ? `\n${failures} FAILED, ${passes} passed` : `\nall ${passes} passed`);
process.exit(failures ? 1 : 0);
