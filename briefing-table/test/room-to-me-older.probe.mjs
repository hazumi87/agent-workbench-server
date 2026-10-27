/* "TO ME" REACHES BACK (Owner 2026-10-26): the To-me view only filtered the newest lines the page had loaded, so five lines to the person that sat
 * under 300+ agent-to-agent lines read as "none". It now asks the engine for the To-me page (GET .../line?to=me, the one rule in web/to-me.mjs).
 *
 *   node test/room-to-me-older.probe.mjs
 *
 * Real Edge/Chromium at 1400 and 390 px: 5 lines to the person, then 310 agent-to-agent lines; To me shows all five and none of the chatter, a LIVE
 * agent-to-agent line does not enter the view, Everyone shows the chatter again, and a later To me still has all five.
 *
 * What only a browser can prove, through the real page against a real engine:
 *   - To me shows an agent's "@user ..." and "@owner ..." lines (bearer + from),
 *     an agent line that names the user mid-text, one that names the user AND
 *     a seat;
 *   - an agent's REPLY to a line the user wrote but ADDRESSED to another seat
 *     ("@leader the second one…") is NOT to me: a quote never counts (Owner
 *     [ref], reversing 2026-09-28); it shows under Between agents;
 *   - Between agents excludes every line to me, and still shows plain
 *     seat-to-seat lines;
 *   - To me still excludes plain seat-to-seat lines.
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(200), DEAD broker P(201),
 * temp table seeded through the store (test/rooms-routes.seed.ts): never Owner's
 * data, childEnv() scrubbed, fabric + NATS off.
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
const PORT = P(210);
const DEAD_BROKER_PORT = P(211);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-to-me-older-token';

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
  const headers = roomUserWrite(path, method, opts.json) ? { cookie: await userCookie() } : { authorization: `Bearer ${TOKEN}` };
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
  await assertFree(p, 'room-to-me-older.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-to-me-older-'));
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
  const recipe = (id, name, agent, color) => ({ id, name, projectDir: `/srv/x/${agent}`, vendor: 'claude-code', agent, color });
  await seed({ recipes: [recipe('rec-lead', 'Leader', 'leader', '#ba08b4'), recipe('rec-bee', 'Bee', 'bee', '#0dab49')] });

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

  const LEAD = 'recipe:rec-lead';
  const BEE = 'recipe:rec-bee';
  const live = (paneid, rid, agent) => ({ paneid, recipe_id: rid, vendor: 'claude-code', agent, state: 'live' });
  const seeded = await seed({
    sessions: [live(LEAD, 'rec-lead', 'leader'), live(BEE, 'rec-bee', 'bee')],
    rooms: [{
      name: 'To Me Probe',
      seats: [
        { handle: 'leader', recipe_id: 'rec-lead', occupant: LEAD },
        { handle: 'bee', recipe_id: 'rec-bee', occupant: BEE },
      ],
    }],
  });
  const R = seeded.rooms[0].id;
  const me = await call('/api/rooms/me', { method: 'PATCH', json: { handle: 'owner' } });
  ok(me.body?.handle === 'owner', 'setup: the user\'s @name is owner', me.body);

  const post = (text, from) => call(`/api/rooms/${R}/line`, { json: { text, from: { paneid: from } } });
  for (let i = 1; i <= 5; i += 1) {
    await post(`@user please look at item ${i}`, BEE);
  }
  let posted = 0;
  for (let i = 1; i <= 310; i += 1) {
    const r = await post(`@leader seat to seat ${i}`, BEE);
    posted += r.status === 200 ? 1 : 0;
  }
  ok(posted === 310, 'setup: 5 lines to the person, then 310 agent-to-agent lines', posted);

  browser = await chromium.launch({ headless: true });
  const login = async (context) => {
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
    await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
    await page.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#line .entry');
    await sleep(1500);
    return page;
  };
  const errors = [];
  const shown = (page) => page.evaluate(() => [...document.querySelectorAll('#line > .entry')].filter((li) => getComputedStyle(li).display !== 'none')
    .map((li) => li.querySelector('.entry-body')?.textContent ?? ''));
  const items = (v) => v.filter((b) => /please look at item/.test(b)).length;
  const chat = (v) => v.filter((b) => /seat to seat/.test(b)).length;

  for (const [label, vp, phone] of [['1400', { width: 1400, height: 900 }, false], ['390', { width: 390, height: 844 }, true]]) {
    const context = await browser.newContext({ viewport: vp, hasTouch: phone, isMobile: phone });
    const page = await login(context);
    const pick = async (who, name) => {
      if (phone) {
        await page.tap('#phFilter');
        await sleep(300);
        await page.locator('#phSheet .ph-frow', { hasText: new RegExp(`^${name}$`) }).first().tap();
        await sleep(300);
        await page.keyboard.press('Escape');
      } else {
        await page.click('#filterBtn');
        await sleep(150);
        await page.click(`#filterMenu [data-who="${who}"]`);
        await sleep(200);
        await page.keyboard.press('Escape');
      }
      await sleep(900);
      return shown(page);
    };
    const first = await shown(page);
    ok(items(first) === 0 && chat(first) > 0, `${label}: Everyone opens on the newest lines, all agent chatter (none of the five is in them)`, { items: items(first), chat: chat(first) });
    const me = await pick('me', 'To me');
    ok(items(me) === 5, `${label}: To me shows all five lines to the person, though 310 agent lines lie after them`, { items: items(me), shown: me.length });
    ok(chat(me) === 0, `${label}: ...and none of the agent-to-agent lines`, chat(me));
    await post('@leader a live agent line while To me is open', BEE);
    await sleep(1500);
    const live = await shown(page);
    ok(items(live) === 5 && chat(live) === 0 && !live.some((b) => /a live agent line/.test(b)), `${label}: a live agent-to-agent line does not enter the To-me view`, live.length);
    await post('@user a live line to the person', BEE);
    await sleep(1500);
    ok((await shown(page)).some((b) => /a live line to the person/.test(b)), `${label}: a live line to the person does`);
    const everyone = await pick('', 'Everyone');
    ok(chat(everyone) > 0 && everyone.some((b) => /a live agent line/.test(b)), `${label}: back on Everyone the chatter is back (the engine's room page, not the To-me one)`, everyone.length);
    const again = await pick('me', 'To me');
    ok(items(again) === 5, `${label}: a second To me still has all five`, items(again));
    await page.screenshot({ path: join(tmpdir(), `room-to-me-older-${label}.png`) });
    await context.close();
  }
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
