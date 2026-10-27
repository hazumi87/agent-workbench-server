/* ROOM CYCLE UI — disconnect / reconnect a room [ticket] (engine half:
 * engine/room-cycle, POST /api/rooms/:id/disconnect|reconnect, room actions).
 *
 *   node test/room-cycle.probe.mjs
 *
 * What only a browser can prove (the engine's own behaviour is
 * test/room-cycle.test.mjs; here the two POSTs are answered with the engine's
 * exact shapes, because a dead-broker scratch engine has no pty to end):
 *   - the room tab's ✕ with `disconnect` offered: the bundle's 3 s popover,
 *     relabelled "Disconnect agents" / "agents keep running"; pressing it
 *     POSTs disconnect with NO bearer and keeps the tab, and the page shows
 *     every seat's result, an orphan pid plainly
 *   - the ✕ with nothing to disconnect closes the tab directly
 *   - reconnect=1 (the CLI Manager's Open) POSTs reconnect {target:'tab',
 *     surface:'browser'}, frames the restoring seat in the room (no window
 *     tab), reports each seat, and drops the flag from the address
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(44), DEAD broker P(45),
 * temp table seeded through the store, childEnv() scrubbed, fabric + NATS off.
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
const PORT = P(44);
const DEAD_BROKER_PORT = P(45);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-cycle-token';

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
  /* a room write as the USER takes a person's credential: the window cookie,
     no bearer (rooms.ts authorFor, [ticket]); everything else is the agent */
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
  await assertFree(p, 'room-cycle.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-cycle-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null;
let browser = null;
let engineLog = '';
const seed = async (plan) => {
  const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], {
    HARBOR_WB_TABLE: dbPath,
    HARBOR_WB_IDENTITY: 'legacy',
  });
  if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
  return JSON.parse(r.out.trim().split('\n').pop());
};

try {
  const recipe = (id, name, agent) => ({ id, name, projectDir: `/srv/x/${agent}`, vendor: 'claude-code', agent });
  const DEH = 'recipe:rec-deh';
  await seed({
    recipes: [recipe('rec-new', 'Newbie', 'newbie'), recipe('rec-deh', 'Sleeper', 'sleeper'), recipe('rec-live', 'Awake', 'awake')],
    sessions: [{ paneid: DEH, recipe_id: 'rec-deh', vendor: 'claude-code', agent: 'sleeper', state: 'dehydrated' }],
  });

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

  const LIVE = 'recipe:rec-live';
  const post = await seed({
    sessions: [{ paneid: LIVE, recipe_id: 'rec-live', vendor: 'claude-code', agent: 'awake', state: 'live' }],
    rooms: [{
      name: 'Cycle Probe',
      seats: [
        { handle: 'awake', recipe_id: 'rec-live', occupant: LIVE },
        { handle: 'sleeper', recipe_id: 'rec-deh', occupant: DEH },
        { handle: 'newbie', recipe_id: 'rec-new' },
      ],
    }],
  });
  const R = post.rooms[0].id;
  const SEAT = post.rooms[0].seats;

  /* the engine's own answer, for comparison */
  const eng = (await call(`/api/rooms/${R}`)).body;
  const engActs = Object.fromEntries(eng.seats.map((s) => [s.handle, s.actions]));
  ok(JSON.stringify(engActs) === JSON.stringify({ awake: ['open'], sleeper: ['rehydrate'], newbie: ['start'] }),
    'engine: seat.actions are open / rehydrate / start', engActs);

  const SID = Object.fromEntries(eng.seats.map((x) => [x.handle, x.id]));
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let offer = ['disconnect'];
  await context.route(new RegExp(`/api/rooms/${R}(\\?.*)?$`), async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.actions = offer; // the engine's derived offer, pinned for the step under test
    await route.fulfill({ response: res, json: body });
  });
  const posts = [];
  await context.route(new RegExp(`/api/rooms/${R}/(disconnect|reconnect)$`), async (route) => {
    const req = route.request();
    const verb = req.url().endsWith('/disconnect') ? 'disconnect' : 'reconnect';
    posts.push({ verb, auth: req.headers().authorization ?? null, body: req.postDataJSON() });
    if (verb === 'disconnect') {
      await route.fulfill({ json: { ok: true, ended: 2, seats: [
        { seat: SID.awake, handle: 'awake', paneid: LIVE, result: 'disconnected', state: 'dehydrated', orphan: 'none' },
        { seat: SID.sleeper, handle: 'sleeper', paneid: DEH, result: 'disconnected', state: 'dehydrated', orphan: { pid: 4242, state: 'S' } },
        { seat: SID.newbie, handle: 'newbie', result: 'untouched', reason: 'no-pane' },
      ], entries: [] } });
    } else {
      await route.fulfill({ json: { ok: true, restoring: 1, seats: [
        { seat: SID.awake, handle: 'awake', result: 'restoring', paneid: LIVE, url: '/solo.html?recipe=rec-live', placement: 'tab' },
        { seat: SID.sleeper, handle: 'sleeper', result: 'already-live' },
        { seat: SID.newbie, handle: 'newbie', result: 'not-restorable', reason: 'no-pane' },
      ] } });
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    const f = document.querySelector('form');
    (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
  }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);

  const ROOM_URL = `/room.html?room=${R}`;
  await page.goto(`${BASE}/app/shell.html?kind=manager&debug=1&tabs=${encodeURIComponent(ROOM_URL)}`, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  const rf = () => page.frames().find((f) => f.url().includes('/room.html'));
  const roomTab = () => page.evaluate(() => [...document.querySelectorAll('.hwb-tab[data-tab]')].find((el) => el.querySelector('.ring svg .rg-wbody'))?.dataset.tab ?? null);
  const tabId = await roomTab();
  ok(!!tabId, 'the room is a window tab', tabId);

  /* ✕ → the popover, relabelled */
  await page.click(`.hwb-tab[data-tab="${tabId}"] .tclose`);
  await sleep(300);
  const pop = await page.evaluate(() => {
    const p = document.querySelector('.hwb-closepop');
    return p ? { end: p.querySelector('.cp-end')?.textContent, msg: p.querySelector('.cp-msg')?.textContent } : null;
  });
  ok(pop?.end === 'Disconnect agents' && /agents keep running/.test(pop?.msg ?? ''), 'the room tab ✕ opens the 3 s popover: "Disconnect agents" / "agents keep running"', pop);
  await page.click('.hwb-closepop .cp-end');
  await sleep(1500);
  ok(posts.length === 1 && posts[0].verb === 'disconnect' && posts[0].auth === null, 'Disconnect agents POSTs disconnect with the cookie only (no bearer)', posts);
  ok((await roomTab()) === tabId, '...and the room tab stays open for the results', await roomTab());
  const res = await rf().evaluate(() => {
    const r = document.getElementById('reply');
    return { shown: !r.hidden, text: r.textContent, orphan: r.querySelector('.cy-orphan')?.textContent ?? null, line: !document.getElementById('roomLine').hidden };
  });
  ok(res.shown && res.line && /Disconnected 2 agents · 1 still running/.test(res.text), 'the page reports the disconnect (2 agents, 1 still running), on the room line', res.text);
  ok(/pid 4242/.test(res.orphan ?? '') && /never kills/.test(res.orphan ?? ''), '...an orphan pid said plainly, and that the engine does not kill it', res.orphan);
  ok(/@newbie untouched \(no-pane\)/.test(res.text), '...and an untouched seat says why', res.text);

  /* nothing to disconnect: the ✕ just closes */
  offer = [];
  await sleep(3200); // one poll: the page tells the shell its new offer
  await page.click(`.hwb-tab[data-tab="${tabId}"] .tclose`);
  await sleep(800);
  ok(!(await page.evaluate(() => !!document.querySelector('.hwb-closepop'))) && (await roomTab()) === null, 'with nothing to disconnect, the ✕ closes the tab directly', await roomTab());

  /* RECONNECT: opening never reconnects (Owner 2026-10-02); the Seats-header button does */
  offer = ['reconnect'];
  const pg = await context.newPage();
  pg.on('pageerror', (e) => errors.push(String(e)));
  await pg.goto(`${BASE}${ROOM_URL}&reconnect=1`, { waitUntil: 'domcontentloaded' });
  await sleep(4500);
  ok(!posts.some((p) => p.verb === 'reconnect'), 'opening with a stale reconnect=1 does NOT reconnect', posts.map((p) => p.verb));
  await pg.click('#reconnectBtn');
  await sleep(4500);
  const rc = posts.find((p) => p.verb === 'reconnect');
  ok(rc && rc.auth === null && rc.body?.target === 'tab' && rc.body?.surface === 'browser', 'the Seats-header button POSTs reconnect {target:tab, surface:browser}, cookie only', rc);
  const after = await pg.evaluate(() => ({
    url: location.search,
    frames: [...document.querySelectorAll('#seatView iframe')].map((f) => f.getAttribute('src')),
    reply: document.getElementById('reply').textContent,
    btn: !document.getElementById('reconnectBtn').hidden,
  }));
  ok(!/reconnect=1/.test(after.url), '...and drops the flag from the address (a reload never repeats it)', after.url);
  ok(after.frames.length === 1 && /\/solo\.html\?recipe=rec-live/.test(after.frames[0]) && /inroom=1/.test(after.frames[0]), '...the restoring seat is attached in the room (its frame), not a window', after.frames);
  ok(/@sleeper was already live/.test(after.reply) && /@newbie not reconnected \(no-pane\)/.test(after.reply), '...every seat reported', after.reply);
  ok(after.btn, 'the Seats header offers Reconnect while the engine does', after.btn);
  ok(posts.filter((p) => p.verb === 'reconnect').length === 1, 'exactly one reconnect POST', posts.map((p) => p.verb));
  await pg.screenshot({ path: join(tmpdir(), 'room-cycle-reconnect.png') });
  ok(errors.length === 0, 'no page errors', errors.slice(0, 3));
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
