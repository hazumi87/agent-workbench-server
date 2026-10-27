/* ROOM DRAFTS + Ctrl+Enter caret (Owner 2026-09-28).
 *
 *   node test/room-drafts.probe.mjs
 *
 * Proves, on a scratch engine in a real Chromium:
 *   - what is typed survives a reload (kept on the SERVER, per person per room)
 *   - a second browser (same person, NO shared localStorage) loads it
 *   - the server copy wins over an OLDER unsaved local copy; a NEWER unsaved
 *     local copy (an edit the server never got) wins and is then saved
 *   - offline: the edit is kept locally and saved when the browser is back online
 *   - send -> reload -> empty, in both browsers
 *   - a bearer cannot read the draft (403)
 *   - Ctrl+Enter at the bottom of the chat: the caret line stays visible inside
 *     the composer and the line view stays at its bottom, after EVERY press
 *     (also past the composer's 30vh cap); a mid-text Ctrl+Enter scrolls the
 *     box to the caret
 *   - desktop Enter still sends
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(116), DEAD broker P(117).
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
const PORT = P(116);
const DEAD_BROKER_PORT = P(117);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-drafts-token';

let failures = 0;
let passes = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (cond) { passes += 1; } else { failures += 1; }
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

try {
  const stale = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
  if (stale.ok) {
    console.log(` FAIL  :${PORT} is already serving something — a leaked engine from an aborted run?`);
    process.exit(1);
  }
} catch { /* nothing there */ }
for (const p of [PORT, DEAD_BROKER_PORT]) {
  await assertFree(p, 'room-drafts.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-drafts-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null;
let browser = null;
let engineLog = '';
const seed = async (plan) => {
  const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
  return JSON.parse(r.out.trim().split('\n').pop());
};
const call = async (path, init = {}) => {
  const res = await fetch(BASE + path, { ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers || {}) } });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
};

try {
  await seed({ recipes: [{ id: 'rec-lead', name: 'Lead', projectDir: '/srv/x/leadp', vendor: 'claude-code', agent: 'leadp', color: '#0dab49' }] });
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

  const L1 = 'recipe:rec-lead';
  const post = await seed({
    sessions: [{ paneid: L1, recipe_id: 'rec-lead', vendor: 'claude-code', agent: 'leadp', state: 'live' }],
    rooms: [{ name: 'Drafts', seats: [{ handle: 'leadp', recipe_id: 'rec-lead', occupant: L1 }] }, { name: 'Other', seats: [] }],
  });
  const R = post.rooms[0].id;
  const R2 = post.rooms[1].id;
  /* enough history that the line view scrolls */
  for (let i = 0; i < 40; i += 1) {
    await call(`/api/rooms/${R}/line`, { method: 'POST', body: JSON.stringify({ text: `history line ${i}: the lead reports progress on item ${i}.`, from: { paneid: L1 } }) });
  }

  browser = await chromium.launch({ headless: true });
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const a = await ctxA.newPage();
  const errors = [];
  a.on('pageerror', (e) => errors.push(`A: ${e}`));
  await a.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await a.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([a.waitForNavigation().catch(() => {}), a.click('form button:visible')]);
  const roomUrl = `${BASE}/room.html?room=${R}`;
  const open = async (page) => {
    await page.goto(roomUrl, { waitUntil: 'domcontentloaded' });
    await sleep(1800);
  };
  const val = (page) => page.$eval('#input', (el) => el.value);
  const serverDraft = (page, room = R) => page.evaluate(async (id) => (await (await fetch(`/api/rooms/${id}/draft`)).json()), room);
  const localCopy = (page) => page.evaluate((id) => { try { return JSON.parse(localStorage.getItem(`hwb.room.draft.${id}`) || 'null'); } catch { return 'err'; } }, R);

  await open(a);
  ok((await val(a)) === '', 'a fresh room opens with an empty composer');

  /* 1. type -> reload -> restored */
  await a.click('#input');
  await a.keyboard.type('half a thought about the deploy');
  await sleep(900);
  ok((await serverDraft(a)).text === 'half a thought about the deploy', 'typing is saved to the server after the pause');
  ok((await localCopy(a)) === null, '...and the local copy is dropped once the server holds it');
  await open(a);
  ok((await val(a)) === 'half a thought about the deploy', 'F5: the draft comes back');
  ok((await serverDraft(a, R2)).text === '', 'per room: the other room has no draft');
  const bearer = await call(`/api/rooms/${R}/draft`);
  ok(bearer.status === 403, 'a bearer cannot read the draft', bearer.status);

  /* 1b. a multi-line draft restored into a HIDDEN page (a background tab, the
     native app still laying out) fits once the page is shown (Owner 2026-09-28:
     it stayed one line tall after a refresh) */
  const multi = ['line one of a longer note', 'line two', 'line three', 'line four'].join(String.fromCharCode(10));
  await a.evaluate(async ([id, text]) => { await fetch(`/api/rooms/${id}/draft`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }); }, [R, multi]);
  const hid = await ctxA.newPage();
  await hid.addInitScript(() => { document.documentElement.style.display = 'none'; });
  await hid.goto(roomUrl, { waitUntil: 'domcontentloaded' });
  await sleep(1800);
  await hid.evaluate(() => { document.documentElement.style.display = ''; });
  await sleep(400);
  const fit = await hid.$eval('#input', (el) => ({ v: el.value.split(String.fromCharCode(10)).length, h: el.clientHeight, sh: el.scrollHeight }));
  ok(fit.v === 4 && fit.h + 2 >= fit.sh && fit.h > 60, 'a multi-line draft restored while hidden fits the box once shown (not one line)', fit);
  await hid.close();
  await a.evaluate(async (id) => { await fetch(`/api/rooms/${id}/draft`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'half a thought about the deploy' }) }); }, R);

  /* 2. a second browser, same person, no shared storage */
  const cookies = (await ctxA.storageState()).cookies;
  const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: { cookies, origins: [] }, hasTouch: true, isMobile: true });
  const b = await ctxB.newPage();
  b.on('pageerror', (e) => errors.push(`B: ${e}`));
  await open(b);
  ok((await val(b)) === 'half a thought about the deploy', 'a second browser (phone, no shared storage) loads the draft typed in the first');
  await b.click('#input');
  await b.keyboard.press('End');
  await b.keyboard.type(' — continued on the phone');
  await sleep(900);
  /* A holds an OLDER unsaved local copy: the server copy wins */
  await a.evaluate((id) => localStorage.setItem(`hwb.room.draft.${id}`, JSON.stringify({ text: 'stale from A', at: 1 })), R);
  await open(a);
  ok((await val(a)) === 'half a thought about the deploy — continued on the phone', 'the newer server copy wins over an older unsaved local one', await val(a));
  ok((await localCopy(a)) === null, '...and the stale local copy is dropped');

  /* 3. offline: kept locally, saved when back online */
  await ctxA.setOffline(true);
  await a.click('#input');
  await a.keyboard.press('End');
  await a.keyboard.type(' (offline)');
  await sleep(900);
  const lc = await localCopy(a);
  ok(lc && lc.text.endsWith('(offline)'), 'offline: the edit is kept locally', lc);
  ok(!(await serverDraft(b)).text.endsWith('(offline)'), '...the server does not have it yet');
  await ctxA.setOffline(false);
  await sleep(900);
  ok((await serverDraft(b)).text.endsWith('(offline)'), 'back online: the edit is saved to the server');
  ok((await localCopy(a)) === null, '...and the local copy dropped');

  /* a NEWER unsaved local copy wins over the server and is then saved */
  await a.evaluate((id) => localStorage.setItem(`hwb.room.draft.${id}`, JSON.stringify({ text: 'newer, never saved', at: Date.now() + 5000 })), R);
  await open(a);
  ok((await val(a)) === 'newer, never saved', 'a NEWER unsaved local copy wins on load');
  await sleep(600);
  ok((await serverDraft(b)).text === 'newer, never saved', '...and is saved to the server');

  /* 4. send -> reload -> empty (desktop Enter still sends) */
  await a.click('#input');
  await a.keyboard.press('Enter');
  await sleep(900);
  ok(await a.evaluate(() => [...document.querySelectorAll('#line .entry-body')].some((e) => e.textContent === 'newer, never saved')), 'desktop Enter sends the line');
  ok((await val(a)) === '', '...the composer empties');
  await open(a);
  ok((await val(a)) === '', 'send -> reload: empty (a sent message never comes back)');
  await open(b);
  ok((await val(b)) === '', '...in the other browser too');
  ok((await localCopy(a)) === null, '...and no local copy lingers');

  /* 4b. type then send inside the debounce: the pending save must not bring it back */
  await a.click('#input');
  await a.keyboard.type('quick one');
  await a.keyboard.press('Enter');
  await sleep(1200);
  await open(a);
  ok((await val(a)) === '', 'send inside the save debounce: still empty after reload');

  /* 5. Ctrl+Enter at the bottom of the chat */
  await open(a);
  await a.evaluate(() => { const s = document.getElementById('lineScroll'); s.scrollTop = s.scrollHeight; });
  await sleep(300);
  await a.click('#input');
  await a.keyboard.type('first line');
  const measure = () => a.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
    const t = document.getElementById('input');
    const s = document.getElementById('lineScroll');
    res({
      tTop: Math.round(t.scrollTop), tCH: t.clientHeight, tSH: t.scrollHeight, caretAtEnd: t.selectionEnd === t.value.length,
      sGap: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight), sCH: s.clientHeight,
    });
  }))));
  let worst = { caret: 0, line: 0 };
  let capped = false;
  const bad = [];
  for (let i = 0; i < 16; i += 1) {
    await a.keyboard.press('Control+Enter');
    const m = await measure();
    const caretGap = m.tSH - (m.tTop + m.tCH);
    worst = { caret: Math.max(worst.caret, caretGap), line: Math.max(worst.line, m.sGap) };
    capped = capped || m.tSH > m.tCH + 4;
    if (caretGap > 2 || m.sGap > 2 || !m.caretAtEnd) { bad.push({ i, ...m }); }
  }
  ok(capped, 'the composer reached its 30vh cap during the run (the case that hid the caret)');
  ok(bad.length === 0, 'after EVERY Ctrl+Enter: the caret line is visible in the composer and the line view is at its bottom', bad.length ? bad.slice(0, 3) : worst);
  ok((await val(a)).split('\n').length === 17, 'Ctrl+Enter inserted a newline each time (no send)', (await val(a)).split('\n').length);

  /* mid-text: the box scrolls to the caret */
  await a.evaluate(() => { const t = document.getElementById('input'); t.setSelectionRange(3, 3); t.scrollTop = t.scrollHeight; });
  await a.keyboard.press('Control+Enter');
  const mid = await a.evaluate(() => {
    const t = document.getElementById('input');
    const line = parseFloat(getComputedStyle(t).lineHeight) || 20;
    return { top: Math.round(t.scrollTop), line, caret: t.selectionStart, value2: t.value.slice(0, 5) };
  });
  ok(mid.top <= mid.line * 3 && mid.caret === 4, 'mid-text Ctrl+Enter scrolls the composer up to the caret', mid);
  await sleep(900);
  ok((await serverDraft(b)).text.startsWith('fir\nst line'), 'Ctrl+Enter edits are saved as a draft too');
  /* leave it clean */
  await a.fill('#input', '');
  await sleep(900);
  ok((await serverDraft(b)).text === '', 'clearing the box clears the draft');

  ok(!engineLog.includes('half a thought'), 'the draft text never reaches the engine log');
  ok(errors.length === 0, 'no page errors', errors);
  await ctxB.close();
  await ctxA.close();
} catch (e) {
  ok(false, `threw: ${e?.stack ?? e}`);
} finally {
  await browser?.close().catch(() => {});
  if (engine) {
    engine.kill('SIGKILL');
    await sleep(200);
  }
  rmSync(tmpDir, { recursive: true, force: true });
  if (failures) {
    console.log(`\nengine log (tail):\n${engineLog.split('\n').slice(-30).join('\n')}`);
  }
  console.log(`\nPASS ${passes}  FAIL ${failures}`);
  process.exit(failures ? 1 : 0);
}
