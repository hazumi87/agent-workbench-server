/* HELD TYPED DELIVERY ON THE ROSTER — room front end item 7 (2026-09-25;
 * engine half workrooms-build §2.10, occupant.held + deliver-held).
 *
 *   node test/room-held.probe.mjs
 *
 * What only a browser can prove:
 *   - a seat with lines waiting shows "N held · <reason> · <age>", quietly
 *   - ONLY a draft block offers "Composer clear — deliver" (the one block a
 *     person can clear); busy/startup/… are informational
 *   - the deliver POST carries NO Authorization header (the route is
 *     cookie-only: an agent must never declare its own composer clear)
 *   - the engine's answer is shown: a real refusal (no live resident here), and
 *     'injected' / 'held:<reason>' (answers faked in flight, since this scratch
 *     engine has no typer-live pane)
 *
 * The held state is injected into BOTH the GET and the room.state pushes (a
 * GET-only rewrite passes on a race; the design system, item 6 review).
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(82), DEAD broker P(83),
 * temp table seeded through the store (test/rooms-routes.seed.ts): no pty,
 * never Owner's data, childEnv() scrubbed, fabric + NATS off.
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
const PORT = P(82);
const DEAD_BROKER_PORT = P(83);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-held-token';

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
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
  await assertFree(p, 'room-held.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-held-'));
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
  await seed({ recipes: [recipe('rec-d', 'Drafty', 'drafty'), recipe('rec-b', 'Busy', 'busy')] });

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

  const D1 = 'recipe:rec-d';
  const B1 = 'recipe:rec-b';
  const post = await seed({
    sessions: [
      { paneid: D1, recipe_id: 'rec-d', vendor: 'claude-code', agent: 'drafty', state: 'live' },
      { paneid: B1, recipe_id: 'rec-b', vendor: 'claude-code', agent: 'busy', state: 'live' },
    ],
    rooms: [{ name: 'Held Probe', seats: [{ handle: 'drafty', recipe_id: 'rec-d', occupant: D1 }, { handle: 'busy', recipe_id: 'rec-b', occupant: B1 }] }],
  });
  const R = post.rooms[0].id;

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  /* inject held on both seats, into GET and the pushes */
  const since = Date.now() - 3 * 60 * 1000;
  const HELD = { drafty: { reason: 'draft', since, depth: 2 }, busy: { reason: 'busy', since, depth: 1 } };
  const inject = (seats) => { for (const s of seats) { if (HELD[s.handle] && s.occupant) { s.occupant.held = HELD[s.handle]; } } };
  await context.route((u) => u.pathname === `/api/rooms/${R}`, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    inject(body.seats);
    await route.fulfill({ response: res, json: body });
  });
  await context.routeWebSocket(/\/pty/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m === 'string' && m.includes('"room.state"')) {
        try {
          const o = JSON.parse(m);
          if (o.type === 'room.state' && Array.isArray(o.seats)) { inject(o.seats); ws.send(JSON.stringify(o)); return; }
        } catch { /* not ours */ }
      }
      ws.send(m);
    });
  });
  /* the deliver POST: record its headers; answer from the real engine first,
     then from scripted answers */
  const posts = [];
  let scripted = null;
  await context.route('**/api/panes/*/deliver-held', async (route) => {
    const req = route.request();
    let body = null;
    try { body = JSON.parse(req.postData() || 'null'); } catch { /* none */ }
    posts.push({ url: req.url(), auth: req.headers().authorization ?? null, body });
    if (scripted) {
      const { __status, ...rest } = scripted;
      await route.fulfill({ status: __status || 200, contentType: 'application/json', body: JSON.stringify(rest) });
      return;
    }
    await route.continue();
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
  await page.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
  await sleep(5500); // GET + several polls and pushes: the injected state must hold

  /* ROOM NAV v3: the row carries the held TEXT on its one status line; Deliver
     moved under the seat's CLI (the solo held line, 3b below), where the box
     it vouches for is visible (the design system room-nav-v3). */
  const read = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#roster .seat')].map((li) => {
    const h = li.querySelector('.seat-meta .seat-held');
    return [li.dataset.handle, h ? { text: h.textContent, button: !!li.querySelector('.seat-deliver'), color: getComputedStyle(h).color } : null];
  })));
  const r = await read();
  ok(r.drafty?.text === '2 held · draft · 3m', 'a drafted seat\'s row reads "2 held · draft · 3m"', r.drafty);
  ok(r.busy?.text === '1 held · busy · 3m', 'a busy seat\'s row reads "1 held · busy · 3m"', r.busy);
  ok(r.drafty?.button === false && r.busy?.button === false, 'no Deliver on the row (it lives under the seat\'s CLI)', r);
  const body = await page.evaluate(() => getComputedStyle(document.body).color);
  ok(r.drafty?.color !== body, 'the held text is quiet (dim, computed)', { held: r.drafty?.color, body });

  ok(errors.length === 0, 'no page errors', errors.slice(0, 3));

  /* 3b. THE SOLO WINDOW'S HELD LINE (assemble-room §3.6, web/held-bar.mjs).
     pane.held pushes are injected into the solo page's socket (this scratch
     engine has no typer-live pane to produce them); deliver-held answers
     are scripted per step. */
  scripted = null;
  const solo = await context.newPage();
  let soloWs = null;
  await solo.routeWebSocket(/\/pty/, (ws) => {
    soloWs = ws;
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
  });
  const pushHeld = (held) => soloWs.send(JSON.stringify({ type: 'pane.held', paneid: D1, held }));
  await solo.goto(`${BASE}/solo.html?recipe=rec-d`, { waitUntil: 'domcontentloaded' });
  await sleep(2000);
  const bar = () => solo.evaluate(() => {
    const b = document.getElementById('heldBar');
    return { hidden: b.hidden, text: b.querySelector('.held-text')?.textContent || null,
      btn: b.querySelector('.held-btn')?.textContent || null, confirm: b.querySelector('.held-confirm')?.textContent || null,
      note: b.querySelector('.held-note')?.textContent || null };
  });
  ok((await bar()).hidden, 'solo: no held line while nothing is held');
  pushHeld({ reason: 'draft', since, depth: 2 });
  await sleep(300);
  let hb = await bar();
  ok(!hb.hidden && hb.text === '2 held · draft · 3m' && hb.btn === 'Deliver 2 · box is empty', 'solo: a draft hold reads "2 held · draft · 3m" + "Deliver 2 · box is empty"', hb);
  pushHeld({ reason: 'no-claude', since, depth: 1 });
  await sleep(300);
  hb = await bar();
  ok(hb.text === '1 held · claude not running · 3m' && hb.btn === null, 'solo: no-claude reads "claude not running" and is never releasable here: no button', hb);
  pushHeld({ reason: 'no-claude', detail: 'not-interactive', since, depth: 1 });
  await sleep(300);
  hb = await bar();
  ok(hb.text === '1 held · claude not interactive · 3m' && hb.btn === null, 'solo: no-claude + not-interactive reads "claude not interactive", no button', hb);
  /* "unknown": the engine could not see this claude start */
  pushHeld({ reason: 'startup', since, depth: 1, prompt: 'unknown' });
  await sleep(300);
  scripted = { __status: 409, reason: 'startup', prompt: 'unknown', promptAt: null, held: { reason: 'startup', since, depth: 1, prompt: 'unknown' } };
  await solo.click('#heldBar .held-btn');
  await sleep(600);
  hb = await bar();
  ok(hb.confirm === 'The engine could not see this claude start. Deliver only if its window shows the input box.', 'solo: an "unknown" startup prompt gets its own confirm sentence', hb.confirm);
  await solo.click('#heldBar .held-cancel');
  await sleep(200);
  pushHeld({ reason: 'startup', since, depth: 1, prompt: 'trust' });
  await sleep(300);
  hb = await bar();
  ok(hb.btn === 'Deliver 1 · nothing showing', 'solo: a startup hold offers "Deliver 1 · nothing showing"', hb);
  const before = posts.length;
  scripted = { __status: 409, reason: 'startup', prompt: 'trust', promptAt: Date.now() - 3 * 60 * 1000, held: { reason: 'startup', since, depth: 1, prompt: 'trust' } };
  await solo.click('#heldBar .held-btn');
  await sleep(700);
  hb = await bar();
  ok(hb.confirm === 'The engine saw a trust prompt 3m ago. Deliver only if this window shows its input box.' && hb.btn === 'Deliver 1 anyway',
    'solo: the engine\'s 409 {prompt} becomes a confirm naming the prompt and its age', hb);
  scripted = { ok: true, paneid: D1, result: 'injected', held: null, overrode: ['startup'] };
  await solo.click('#heldBar .held-btn');
  await sleep(700);
  const sent = posts.slice(before);
  ok(sent.length === 2 && sent.every((x) => x.auth === null), 'solo: both deliver POSTs carry NO Authorization (cookie only)', sent);
  ok(sent[1]?.body?.override === 'trust' && !sent[0]?.body?.override, 'solo: confirming resends {override: <that kind>}', sent.map((x) => x.body));
  hb = await bar();
  ok(hb.hidden, 'solo: delivered → the line clears (held null)', hb);
  /* CONTROLLER-ONLY (nuc1 ruling): a viewing window shows the line, and its
     action takes control instead of delivering */
  pushHeld({ reason: 'draft', since, depth: 2 });
  soloWs.send(JSON.stringify({ type: 'pane.control', paneid: D1, controlling: false, holder: 'VRPC window' }));
  await sleep(400);
  hb = await bar();
  ok(hb.btn === 'Take control to deliver', 'solo, VIEWING: the action is "Take control to deliver", not Deliver', hb);
  const postsBefore = posts.length;
  await solo.evaluate(() => { const p = document.querySelector('.pane-paused'); if (p) { p.hidden = true; } }); // "Just watch" state
  await solo.click('#heldBar .held-btn');
  await sleep(300);
  const prompt = await solo.evaluate(() => { const p = document.querySelector('.pane-paused'); return !!p && !p.hidden; });
  ok(prompt && posts.length === postsBefore, '...it opens the control prompt and posts nothing', { prompt, posted: posts.length - postsBefore });
  soloWs.send(JSON.stringify({ type: 'pane.control', paneid: D1, controlling: true }));
  await sleep(400);
  hb = await bar();
  ok(hb.btn === 'Deliver 2 · box is empty', 'solo: back in control, Deliver returns', hb);
  pushHeld(null);
  await sleep(200);
  const focusBack = await solo.evaluate(() => !!document.activeElement?.closest?.('#term'));
  ok(focusBack, 'solo: after Deliver, focus is back in the terminal (vrpc1 CHANGE 1)');
  /* a note alone never lingers: "nothing was waiting" clears itself */
  pushHeld({ reason: 'draft', since, depth: 1 });
  await sleep(300);
  scripted = { ok: true, paneid: D1, result: 'empty', held: { reason: 'draft', since, depth: 1 } };
  await solo.click('#heldBar .held-btn');
  await sleep(600);
  const n1 = await bar();
  pushHeld(null);
  await sleep(300);
  const n2 = await bar();
  ok(n1.note === 'nothing was waiting' && n2.hidden, 'solo: a note shows, then a null push leaves NO note-only bar behind (CHANGE 2)', { n1, n2 });
  await solo.close();

  /* 4. phone: the deliver button keeps the 40px floor */
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await context.storageState() });
  await phone.route((u) => u.pathname === `/api/rooms/${R}`, async (route) => {
    const res = await route.fetch();
    const b = await res.json();
    inject(b.seats);
    await route.fulfill({ response: res, json: b });
  });
  await phone.routeWebSocket(/\/pty/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m === 'string' && m.includes('"room.state"')) {
        try { const o = JSON.parse(m); if (o.type === 'room.state' && Array.isArray(o.seats)) { inject(o.seats); ws.send(JSON.stringify(o)); return; } } catch { /* */ }
      }
      ws.send(m);
    });
  });
  const pp = await phone.newPage();
  await pp.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  await pp.click('#phAgents'); // room-phone v1: the Agents sheet
  await sleep(300);
  const m = await pp.evaluate(() => {
    const h = document.querySelector('#phSheet .seat[data-handle="drafty"] .seat-held');
    const rr = h?.getBoundingClientRect();
    return rr ? { text: h.textContent, right: Math.round(rr.right), vw: innerWidth, sw: document.documentElement.scrollWidth } : null;
  });
  ok(m && m.text === '2 held · draft · 3m' && m.right <= m.vw && m.sw <= m.vw, 'phone: the held text is in the Agents sheet\'s row, on screen, no sideways scroll', m);
  await phone.close();
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
