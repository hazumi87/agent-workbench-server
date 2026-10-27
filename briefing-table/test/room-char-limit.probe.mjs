/* THE COMPOSER'S CHARACTER-LIMIT WARNING (ticket, Owner: he kept splitting a
 * message over the room's 4000-char SEND cap into several sends tonight).
 *
 *   node test/room-char-limit.probe.mjs
 *
 * What only a browser can prove:
 *   - under CHAR_WARN_AT (3988): no border change, no status-line note;
 *   - from 3988: the textarea's border turns coral, and the status line
 *     ($('delivery') — the same line "→ @x typed in" shows on) says how many
 *     characters are left;
 *   - past 4000: the overflow renders coral via the mirrored backdrop
 *     (#inputHi) behind a transparent-text textarea, the status line says
 *     "over by N — won't send", Send is disabled, and Enter sends nothing
 *     and inserts no newline — the text itself is never touched;
 *   - a very long paste is never truncated;
 *   - back under the cap, Send re-enables and the note clears;
 *   - a draft may SAVE well past the send cap (its own cap is
 *     DRAFT_BODY_MAX, 16000) and comes back on a reload;
 *   - a draft over DRAFT_BODY_MAX is refused (413).
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(258), DEAD broker
 * P(259), a bare room seeded through the store: never Owner's data, childEnv()
 * scrubbed, fabric + NATS off.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv, windowCookie, roomUserWrite } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(258);
const DEAD_BROKER_PORT = P(259);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-char-limit-token';
const CORAL = 'rgb(255, 92, 77)';

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    console.log(` FAIL  :${PORT} is already serving something — a leaked engine from an aborted run?`);
    process.exit(1);
  }
} catch { /* nothing there */ }
for (const p of [PORT, DEAD_BROKER_PORT]) {
  await assertFree(p, 'room-char-limit.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-charlimit-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null;
let browser = null;
let engineLog = '';
const seed = async (plan) => {
  const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
  return JSON.parse(r.out.trim().split('\n').pop());
};

try {
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
      HARBOR_WB_ROOM_SCRATCH_DIR: join(tmpDir, 'scratch'),
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

  const post = await seed({ rooms: [{ name: 'Char Limit Probe' }] });
  const R = post.rooms[0].id;
  const ROOM_URL = `${BASE}/room.html?room=${R}`;
  const LINE = `/api/rooms/${R}/line`;

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  let linePosts = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith(LINE)) {
      linePosts += 1;
    }
  });
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    const f = document.querySelector('form');
    (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
  }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  await page.goto(ROOM_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#input');
  await sleep(400);

  /** Sets the composer's text directly (the same effect a real keystroke or
   *  paste has: it changes input.value and fires 'input', which is all
   *  paintCharLimit listens for) and returns the computed state. */
  const setText = (text) => page.evaluate((t) => {
    const el = document.getElementById('input');
    el.value = t;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  const composerState = () => page.evaluate(() => {
    const ta = document.getElementById('input');
    const hi = document.getElementById('inputHi');
    const overEl = hi.querySelector('.over');
    const delivery = document.getElementById('delivery');
    const cs = getComputedStyle(ta);
    return {
      len: ta.value.length,
      border: cs.borderTopColor,
      color: cs.color,
      caret: cs.caretColor,
      hiHidden: hi.hidden,
      hiText: hi.textContent,
      overText: overEl ? overEl.textContent : null,
      overColor: overEl ? getComputedStyle(overEl).color : null,
      noteText: delivery.textContent,
      noteHidden: delivery.hidden,
      noteDanger: delivery.classList.contains('rm-delivery-danger'),
      sendDisabled: document.getElementById('sendBtn').disabled,
    };
  });

  /* ---- 1. under the warn threshold (3987): nothing changes ---- */
  await setText('a'.repeat(3987));
  let s = await composerState();
  ok(s.len === 3987 && s.border !== CORAL && s.noteHidden && s.hiHidden && !s.sendDisabled,
    'under 3988: no border change, no status-line note, Send enabled', s);

  /* ---- 2. at the warn threshold (3988): border + "N left" ---- */
  await setText('a'.repeat(3988));
  s = await composerState();
  ok(s.len === 3988 && s.border === CORAL && !s.noteHidden && s.noteDanger && s.noteText === '12 left' && s.hiHidden && !s.sendDisabled,
    'at 3988: coral border + "12 left" on the status line, still sendable', s);

  /* ---- 3. exactly the cap (4000): "0 left", not over ---- */
  await setText('a'.repeat(4000));
  s = await composerState();
  ok(s.len === 4000 && s.border === CORAL && s.noteText === '0 left' && s.hiHidden && !s.sendDisabled,
    'at exactly 4000: "0 left", still not over (the engine\'s own check is > 4000)', s);

  /* ---- 4. over the cap (4001): overlay, note, Send disabled, Enter no-ops ---- */
  await setText('a'.repeat(4001));
  s = await composerState();
  ok(s.len === 4001 && s.border === CORAL && !s.hiHidden && s.sendDisabled, 'over 4000: coral border, backdrop shown, Send disabled', s);
  ok(s.noteText === "over by 1 — won't send", '...status line: "over by 1 — won\'t send"', s.noteText);
  ok(s.hiText === 'a'.repeat(4001), '...the backdrop mirrors the full text (nothing truncated)', s.hiText.length);
  ok(s.overText === 'a', '...exactly the overflow (1 char) is in the coral span', s.overText);
  ok(s.overColor === CORAL, '...painted coral', s.overColor);
  ok(s.color === 'rgba(0, 0, 0, 0)', '...the real textarea text is transparent (the backdrop shows through)', s.color);
  ok(s.caret !== 'rgba(0, 0, 0, 0)', '...but the caret stays visible (caret-color is not transparent)', s.caret);
  const beforeEnter = await page.inputValue('#input');
  const postsBefore = linePosts;
  await page.focus('#input');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await sleep(200);
  const afterEnter = await page.inputValue('#input');
  ok(afterEnter === beforeEnter && afterEnter.length === 4001, 'Enter over the limit inserts NO newline and changes nothing', { before: beforeEnter.length, after: afterEnter.length });
  ok(linePosts === postsBefore, '...and sends nothing (no POST /line)', { before: postsBefore, after: linePosts });

  /* ---- 5. a long paste is never truncated ---- */
  await setText('b'.repeat(4100));
  s = await composerState();
  ok(s.len === 4100, 'a 4100-char paste keeps every character (not truncated to 4000 or anything else)', s.len);

  /* ---- 6. back under the cap: Send re-enables, the note clears ---- */
  await setText('short again');
  s = await composerState();
  ok(s.len === 11 && s.border !== CORAL && s.noteHidden && s.hiHidden && !s.sendDisabled, 'back under: border, note and overlay clear, Send is enabled again', s);
  await setText('');

  /* ---- 7. a draft may save well past the SEND cap ---- */
  await setText('d'.repeat(5000));
  await sleep(900); // the 400ms debounce, then the PUT
  const dr = (await call(`/api/rooms/${R}/draft`, { user: true })).body;
  ok(dr?.text?.length === 5000, 'a 5000-char draft saved (past the 4000 send cap, under the 16000 draft cap)', dr?.text?.length);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#input');
  await sleep(500);
  const restored = await page.inputValue('#input');
  ok(restored.length === 5000, '...and comes back after a reload', restored.length);

  /* ---- 8. over the draft cap (16001): 413, end to end through the UI ---- */
  const draftResp = page.waitForResponse((r) => r.url().includes(`/rooms/${R}/draft`) && r.request().method() === 'PUT', { timeout: 5000 });
  await setText('e'.repeat(16001));
  const resp = await draftResp;
  ok(resp.status() === 413, 'a 16001-char draft is refused: 413 (its own cap is DRAFT_BODY_MAX, 16000)', resp.status());

  ok(errors.length === 0, 'no page errors', errors.slice(0, 3));
} catch (e) {
  ok(false, `probe threw: ${e?.stack ?? e}`);
} finally {
  await browser?.close().catch(() => {});
  engine?.kill('SIGKILL');
  await sleep(300);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
