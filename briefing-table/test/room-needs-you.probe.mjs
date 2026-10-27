/* NEEDS YOU IN THE ROOM [ticket] [ticket] (Owner 2026-09-30: a seat sat on a
 * "/login" prompt for hours, and another on a permission prompt, and the room
 * said nothing — "Owner watches rooms, not tabs").
 *
 *   node test/room-needs-you.probe.mjs
 *
 * A REAL pane on a REAL engine: a LIVE scratch broker holds a bash pane filed
 * as gemini-cli (gemini is not installed for the account, so its launch
 * leaves a bash prompt; nothing is ever sent to a model). The probe prints
 * gemini's own auth-screen text into that terminal — the screen gemini-gate
 * reads (strings from @google/gemini-cli 0.62.0, test/fixtures/gemini-gate) —
 * and checks, through the engine and the room page:
 *   1. the seat's occupant carries blocked {reason: login} and the ring word
 *      is `waiting`;
 *   2. the rail row shows "needs you: login · open its tab";
 *   3. a line to the seat is HELD (not typed) with reason needs-you, and the
 *      line's read line says "held: @boss needs you (login)"; the addressed
 *      seat's delivery chip says "needs you: login";
 *   3b. an ack (a human saw it) makes the ring word `waiting-seen` and the
 *      rail ring the still coral double ring (window-chrome v33, ticket):
 *      computed animation-name none, the halo drawn, same coral, chip kept;
 *   4. the screen stops showing it (gemini's composer draws): the block
 *      clears, the chip goes, and the held line is typed.
 * Claude Code's own markers (login / permission / question) are proven on
 * real CC 2.1.285 recordings in test/prompt-block.test.ts; this probe is the
 * room's half. The engine never answers the prompt: detection only.
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(290), LIVE scratch
 * broker P(291), temp dir: never Owner's data, childEnv() scrubbed, fabric +
 * NATS off. Children are killed by PID.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { P, assertFree, childEnv, scratchShell, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOADER = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const PORT = P(290);
const BROKER_PORT = P(291);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-needs-you-token';

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function up(url) {
  for (let i = 0; i < 120; i += 1) {
    await sleep(250);
    try { if ((await fetch(url)).ok) { return true; } } catch { /* not yet */ }
  }
  return false;
}
async function until(fn, ms = 8000) {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v || Date.now() - t > ms) { return v; }
    await sleep(100);
  }
}

for (const p of [PORT, BROKER_PORT]) {
  await assertFree(p, 'room-needs-you.probe.mjs');
}
const dir = mkdtempSync(join(tmpdir(), 'wb-room-needs-you-'));
const children = [];
let log = '';
function run(args, env) {
  const c = spawn(process.execPath, ['--import', LOADER, ...args], { cwd: REPO_ROOT, env });
  c.stdout.on('data', (d) => (log += d));
  c.stderr.on('data', (d) => (log += d));
  children.push(c);
  return c;
}
let browser = null;
let ws = null;
try {
  run(['node_modules/pty-broker/src/main.ts'], childEnv({ PTY_BROKER_PORT: String(BROKER_PORT) }));
  ok(await up(`http://127.0.0.1:${BROKER_PORT}/health`), `scratch broker on ${BROKER_PORT}`);
  run([join('src', 'server', 'index.ts')], childEnv({
    HARBOR_WB_PORT: String(PORT),
    HARBOR_WB_HOST: '127.0.0.1',
    HARBOR_WB_TABLE: join(dir, 'mapping.db'),
    HARBOR_WB_TOKEN: TOKEN,
    HARBOR_WB_TOKEN_FILE: join(dir, 'engine.token'),
    HARBOR_WB_IDENTITY: 'legacy',
    HARBOR_WB_NO_WINDOW: '1',
    HARBOR_WB_BROKER_AUTOSTART: '0',
    HARBOR_WB_BROKER_PORT: String(BROKER_PORT),
    HARBOR_WB_CLAUDE_PROJECTS: join(dir, 'claude-projects'),
    HARBOR_WB_NODE: 'testnode',
    HARBOR_WB_ROOM_TYPE_SETTLE_MS: '200',
    HARBOR_WB_TARGETS: JSON.stringify({ targets: [{ id: 'local', label: 'Local', kind: 'local', shell: scratchShell() }] }),
  }));
  const engineUp = await up(`${BASE}/health`);
  ok(engineUp, `scratch engine on ${PORT}`, engineUp ? undefined : log.slice(-600));
  if (!engineUp) { throw new Error('engine never came up'); }
  const cookie = await windowCookie(BASE, TOKEN);
  const call = async (path, method = 'GET', body, human = false) => {
    const headers = { 'content-type': 'application/json', ...(human ? { cookie } : { authorization: `Bearer ${TOKEN}` }) };
    const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  /* ---- a live pane filed as gemini-cli (its launch leaves a bash prompt), seated ---- */
  const recipe = (await call('/api/recipes', 'POST', { name: 'Needs You', target: 'local', projectDir: dir, vendor: 'gemini-cli', agent: 'needsyou' })).body?.recipe;
  ok(recipe?.vendor === 'gemini-cli', 'setup: a gemini-cli recipe', recipe?.vendor);
  const pane = `recipe:${recipe.id}`;
  ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/pty`, { headers: { authorization: `Bearer ${TOKEN}` } });
  ws.on('error', () => {});
  const msgs = [];
  ws.on('message', (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* not json */ } });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  ws.send(JSON.stringify({ type: 'attach', paneid: pane, recipe: recipe.id }));
  for (let i = 0; i < 80 && !msgs.some((m) => m.type === 'pane.ready' && m.paneid === pane); i += 1) { await sleep(150); }
  ok(msgs.some((m) => m.type === 'pane.ready' && m.paneid === pane), 'setup: a live pane in the scratch broker');
  await sleep(1500); // the launch's `gemini …` fails (not installed): a bash prompt
  const room = (await call('/api/rooms', 'POST', { name: 'Needs you room' }, true)).body;
  const seat = await call(`/api/rooms/${room.id}/seats`, 'POST', { recipe_id: recipe.id, handle: 'boss', occupant: pane }, true);
  ok(seat.status === 200, 'setup: the pane holds the lead seat', seat.status);
  const seatApi = async () => (await call(`/api/rooms/${room.id}`)).body?.seats?.find((s) => s.handle === 'boss');
  ok((await seatApi())?.occupant?.blocked === undefined, 'setup: not blocked yet', (await seatApi())?.occupant?.blocked);

  /* ---- 1. gemini's auth screen draws in the terminal ---- */
  const type = (s) => ws.send(JSON.stringify({ type: 'input', paneid: pane, data: s }));
  type("printf '%s\\n' 'How would you like to authenticate for this project?' '1. Sign in with Google'\r");
  const s1 = await until(async () => { const s = await seatApi(); return s?.occupant?.blocked?.reason === 'login' ? s : null; });
  ok(!!s1, 'the seat carries blocked {reason: login}', s1?.occupant?.blocked ?? (await seatApi())?.occupant);
  ok(typeof s1?.occupant?.blocked?.since === 'number', '...with since');
  ok(s1?.occupant?.activity === 'waiting', 'the ring word is waiting (coral "needs you")', s1?.occupant?.activity);
  const diag = (await call('/api/diag/activity')).body?.panes?.find((p) => p.paneid === pane);
  ok(diag?.blocked?.reason === 'login', '/api/diag/activity carries blocked {reason, since}', diag?.blocked);

  /* ---- 2. the rail row says it, with the way to answer it ---- */
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    const f = document.querySelector('form');
    (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
  }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  await page.goto(`${BASE}/room.html?room=${room.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#roster .seat[data-handle="boss"]');
  await page.waitForSelector('#roster .seat[data-handle="boss"] .seat-needs', { timeout: 6000 }).catch(() => {});
  const chip = await page.evaluate(() => {
    const el = document.querySelector('#roster .seat[data-handle="boss"] .seat-needs');
    return el ? { text: el.textContent, reason: el.dataset.reason, button: el.querySelector('button.seat-needs-open')?.textContent ?? null } : null;
  });
  ok(chip?.text === 'needs you: login · open its tab', 'the rail row: "needs you: login · open its tab"', chip);
  ok(chip?.button === 'open its tab', '..."open its tab" is a button (the seat\'s Open window)', chip?.button);

  /* ---- 3. a line to the seat is held, and says why ---- */
  /* sent from the page's own composer, so its send report drives the chips */
  const sentP = page.waitForResponse((r) => r.url().endsWith(`/api/rooms/${room.id}/line`) && r.request().method() === 'POST');
  await page.fill('#input', '@boss are you there');
  await page.click('#sendBtn');
  const d0 = (await (await sentP).json().catch(() => null))?.deliveries?.[0];
  ok(d0?.typed === 'queued', 'the engine holds the line (never typed into the prompt)', d0);
  const held = (await seatApi())?.occupant?.held;
  ok(held?.reason === 'needs-you' && held?.blocked === 'login', 'held: {reason: needs-you, blocked: login}', held);
  await page.waitForFunction(() => /held: @boss needs you \(login\)/.test(document.querySelector('#line .entry-reads')?.textContent ?? ''), null, { timeout: 6000 }).catch(() => {});
  const readLine = await page.evaluate(() => [...document.querySelectorAll('#line .entry-reads')].map((e) => e.textContent).pop() ?? null);
  ok(/held: @boss needs you \(login\)/.test(readLine ?? ''), 'the read line: "held: @boss needs you (login)"', readLine);
  await page.waitForSelector('#deliveryChips .rm-dchip .nw', { timeout: 6000 }).catch(() => {});
  const dchip = await page.evaluate(() => {
    const b = document.querySelector('#deliveryChips .rm-dchip[data-seat]');
    return b ? { nw: b.querySelector('.nw')?.textContent ?? null, title: b.title } : null;
  });
  ok(dchip?.nw === 'needs you: login', 'the addressed seat\'s delivery chip: "needs you: login"', dchip);
  ok(/open its tab/.test(dchip?.title ?? ''), '...pointing at its tab', dchip?.title);
  const row = await page.evaluate(() => document.querySelector('#roster .seat[data-handle="boss"] .seat-held')?.textContent ?? null);
  ok(/^1 held · needs you \(login\)/.test(row ?? ''), 'the rail row\'s held text: "1 held · needs you (login)"', row);

  /* ---- 3b. SEEN, NOT ANSWERED (window-chrome v33, ticket): an ack silences
     the alarm and the ring goes STILL — it does not drop to idle ---- */
  const ringLook = () => page.evaluate(() => {
    const r = document.querySelector('#roster .seat[data-handle="boss"] .seat-ring');
    const halo = r?.querySelector('.rg-halo');
    if (!r || !halo) { return null; }
    const h = getComputedStyle(halo);
    const t = getComputedStyle(r.querySelector('.rg-track'));
    return { state: r.dataset.state, haloAnim: h.animationName, haloOpacity: Number(h.opacity), haloStroke: h.stroke, trackAnim: t.animationName, trackStroke: t.stroke, label: r.getAttribute('aria-label') };
  });
  const unseen = await ringLook();
  ok(unseen?.state === 'attention' && unseen.haloAnim !== 'none', 'before the ack: the attention ring, its halo moving', unseen);
  ws.send(JSON.stringify({ type: 'attention.ack', paneid: pane, how: 'focus' }));
  const s3 = await until(async () => { const s = await seatApi(); return s?.occupant?.activity === 'waiting-seen' ? s : null; });
  ok(!!s3, 'after an ack: the ring word is waiting-seen, not idle', (await seatApi())?.occupant?.activity);
  ok(s3?.occupant?.blocked?.reason === 'login', '...and the seat is still blocked {reason: login}', s3?.occupant?.blocked);
  await page.waitForFunction(() => document.querySelector('#roster .seat[data-handle="boss"] .seat-ring')?.dataset.state === 'attention-seen', null, { timeout: 12000 }).catch(() => {});
  const seen = await ringLook();
  ok(seen?.state === 'attention-seen', 'the rail ring: attention-seen', seen?.state);
  ok(seen?.haloAnim === 'none' && seen?.trackAnim === 'none', 'nothing moves: halo and track animation-name none', seen && { halo: seen.haloAnim, track: seen.trackAnim });
  ok(seen?.haloOpacity > 0, 'the halo is DRAWN, frozen: a still double ring', seen?.haloOpacity);
  ok(!!seen && seen.haloStroke === unseen?.haloStroke && seen.trackStroke === unseen?.trackStroke, 'the same coral as the unseen alarm', seen && { seen: seen.trackStroke, unseen: unseen?.trackStroke });
  ok(/needs you, seen/.test(seen?.label ?? ''), 'its label: "needs you, seen"', seen?.label);
  ok(await page.evaluate(() => document.querySelector('#roster .seat[data-handle="boss"] .seat-needs')?.textContent ?? null) === 'needs you: login · open its tab',
    'the rail chip survives the ack');
  /* the session window: its titlebar ring and the word it tells the tab chrome
     (solo.js NATIVE_STATE -> the shell's alias table -> tab `waiting-seen`).
     A second page attaches as a VIEWER (the probe's socket holds control), so
     it cannot take the keyboard step 4 types with. */
  const sp = await context.newPage();
  sp.on('pageerror', (e) => errors.push(String(e)));
  await sp.goto(`${BASE}/solo.html?recipe=${encodeURIComponent(recipe.id)}&pane=${encodeURIComponent(pane)}`, { waitUntil: 'domcontentloaded' });
  await sp.waitForFunction(() => document.querySelector('.pane-ring')?.dataset.state === 'attention-seen', null, { timeout: 12000 }).catch(() => {});
  const soloLook = await sp.evaluate(() => {
    const r = document.querySelector('.pane-ring');
    return { state: r?.dataset.state ?? null, halo: r ? getComputedStyle(r.querySelector('.rg-halo')).animationName : null, emit: window.__lastEmit?.hwbState ?? null };
  });
  ok(soloLook.state === 'attention-seen' && soloLook.halo === 'none', 'the session window\'s ring: attention-seen, still', soloLook);
  ok(soloLook.emit === 'attention-seen', '...and it tells the tab chrome attention-seen', soloLook.emit);
  await sp.close();
  ok((await seatApi())?.occupant?.activity === 'waiting-seen', 'opening the window leaves it seen (a repeat ack is a no-op)', (await seatApi())?.occupant?.activity);

  /* ---- 4. the screen stops showing it: cleared, and the held line is typed ---- */
  type("printf '%s\\n' 'Type your message or @path/to/file' '? for shortcuts'\r");
  const s4 = await until(async () => { const s = await seatApi(); return s && !s.occupant?.blocked ? s : null; });
  ok(!!s4, 'gemini\'s composer drew: the block is gone', (await seatApi())?.occupant?.blocked);
  ok(s4 && s4.occupant?.activity !== 'waiting' && s4.occupant?.activity !== 'waiting-seen', '...and the ring leaves waiting-seen', s4?.occupant?.activity);
  const typed = await until(async () => !((await seatApi())?.occupant?.held));
  ok(typed, 'the held line was typed once the prompt was gone', (await seatApi())?.occupant?.held);
  await page.waitForFunction(() => !document.querySelector('#roster .seat[data-handle="boss"] .seat-needs'), null, { timeout: 6000 }).catch(() => {});
  ok(await page.evaluate(() => !document.querySelector('#roster .seat[data-handle="boss"] .seat-needs')), 'the rail chip is gone');
  ok(errors.length === 0, 'no page errors', errors.slice(0, 3));
} catch (e) {
  ok(false, `probe threw: ${e?.stack ?? e}`);
} finally {
  await browser?.close().catch(() => {});
  try { ws?.terminate(); } catch { /* gone */ }
  for (const c of children.reverse()) {
    if (c.pid && c.exitCode === null) {
      const gone = new Promise((r) => c.once('exit', r));
      try { process.kill(c.pid, 'SIGKILL'); } catch { /* already gone */ }
      await Promise.race([gone, sleep(3000)]);
    }
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
