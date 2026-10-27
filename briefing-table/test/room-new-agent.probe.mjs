/* START A NEW AGENT FROM A RECIPE, NAMED, STRAIGHT INTO THE ROOM (Owner
 * 2026-09-28; since the design system room-add-sheet-v1 a START FROM A PROJECT row of
 * the + sheet's Agents tab, added AND started by its one "Add N") — POST
 * seats {recipe_id, handle, policy} then POST
 * seats/:id/start {target:'tab', surface:'browser'}, and the room selects the
 * new seat on the fresh pane.
 *
 *   node test/room-new-agent.probe.mjs
 *
 * What only a browser can prove:
 *   - the picker lists the seatable recipes (a plain shell with no agent slug
 *     is left out), sorted by name, with the project folder
 *   - the suggested @name is the recipe's agent slug, suffixed -2, -3 … past
 *     the handles already in the room, and moves on after each start
 *   - Start in room makes exactly the two calls, closes, and the room selects
 *     the new seat framed on its FRESH pane
 *   - a taken name typed by hand is refused inline (the page's own check, and
 *     the engine's 409 when the page could not know)
 *   - a start that fails after the seat was added says so and leaves the seat
 *   - the section fits a 390px phone (the expanded row's choices, the design system
 *     2026-09-28, are room-add-sheet.probe's; here only their geometry)
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(126), DEAD broker P(127)
 * (the seat start places a fresh pane and binds the seat; nothing spawns),
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
const PORT = P(126);
const DEAD_BROKER_PORT = P(127);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-new-agent-token';

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
  await assertFree(p, 'room-new-agent.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-new-agent-'));
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
  const recipe = (id, name, agent, dir) => ({ id, name, projectDir: `/srv/x/${dir}`, vendor: 'claude-code', agent });
  await seed({
    recipes: [
      recipe('rec-ap', 'Alpha Platform', 'alpha-platform', 'alpha-platform'),
      recipe('rec-zz', 'Zebra', 'zebra', 'zebra-dir'),
      recipe('rec-bb', 'Kiosk', 'kiosk', 'kiosk'),
      { id: 'rec-sh', name: 'Plain Shell', projectDir: '/srv/x/sh', vendor: 'cli-manager', agent: null },
    ],
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

  /* the room already holds @alpha-platform (a never-started seat) */
  const post = await seed({ rooms: [{ name: 'New Agent Probe', seats: [{ handle: 'alpha-platform', recipe_id: 'rec-ap' }] }] });
  const R = post.rooms[0].id;
  const seatsNow = async () => (await call(`/api/rooms/${R}`)).body.seats;

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const calls = [];
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (req.method() === 'POST' && u.pathname.startsWith(`/api/rooms/${R}/seats`)) {
      let body = null;
      try { body = JSON.parse(req.postData() || 'null'); } catch { /* not json */ }
      calls.push({ path: u.pathname.slice(`/api/rooms/${R}`.length), body });
    }
  });
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    const f = document.querySelector('form');
    (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
  }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  await page.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
  await sleep(1500);

  /* (room add sheet v1, the design system: the new-agent section is now the Agents tab's
     START FROM A PROJECT rows — tick a project, its @name field opens in
     place, the footer's ONE "Add N" adds and starts it) */
  const openPlus = async () => {
    await page.click('#addBtn');
    await page.waitForSelector('.ras-proj', { timeout: 5000 });
    await sleep(200);
  };
  const tick = async (rid) => {
    await page.click(`.ras-proj[data-recipe="${rid}"] .nm`);
    await sleep(150);
  };
  const fieldSel = (rid) => `.ras-proj[data-recipe="${rid}"] .ras-fld input`;
  const na = (rid) => page.evaluate((id) => {
    const row = id ? document.querySelector(`.ras-proj[data-recipe="${id}"]`) : null;
    const err = row?.querySelector('.ras-rerr');
    const go = document.querySelector('.ras-go');
    return {
      open: !!document.querySelector('.ras-scrim'),
      handle: row?.querySelector('.ras-fld input')?.value ?? null,
      err: err && !err.hidden ? err.textContent : '',
      go: go ? { text: go.textContent, disabled: go.disabled } : null,
      why: document.querySelector('.ras-why')?.textContent || '',
    };
  }, rid);

  /* 1. the projects */
  await openPlus();
  const opts = await page.$$eval('.ras-proj', (rs) => rs.map((r) => ({ v: r.dataset.recipe, t: r.querySelector('.nm .a').textContent, b: r.querySelector('.nm .b').textContent })));
  ok(opts.map((o) => o.v).join(',') === 'rec-ap,rec-bb,rec-zz',
    'START FROM A PROJECT lists the seatable recipes sorted by name; the plain shell (no agent slug) is left out', opts);
  ok(/^zebra-dir · /.test(opts.find((o) => o.v === 'rec-zz')?.b || ''), '...each with its project folder', opts);
  ok(await page.isVisible('.ras-go') && (await page.$$eval('.ras-sec', (xs) => xs.map((x) => x.firstChild.textContent))).includes('Live tabs'), 'the live-tab part of the sheet is still there (LIVE TABS)');
  let s = await na();
  ok(s.go?.disabled && s.go.text === 'Add', 'Add waits for a tick', s);

  /* 2. the suggestion avoids a taken handle */
  await tick('rec-ap');
  s = await na('rec-ap');
  ok(s.handle === 'alpha-platform-2', 'ticking Alpha Platform suggests @alpha-platform-2 (@alpha-platform is taken here)', s);
  ok(!s.go.disabled && s.go.text === 'Add 1', '...and Add 1 is ready', s.go);
  /* the design system review N1 + N2: the @ is a dim prefix INSIDE the bordered name
     field (as in the seat rename), and the field is at least 180px */
  const fld = await page.evaluate(() => {
    const r = (el) => el.getBoundingClientRect();
    const f = document.querySelector('.ras-proj[data-recipe="rec-ap"] .ras-fld');
    const at = f?.querySelector('.at');
    const inp = f?.querySelector('input');
    const how = document.querySelector('.ras-proj[data-recipe="rec-ap"] .ras-how');
    const fs = getComputedStyle(f);
    const is = getComputedStyle(inp);
    const probe = document.createElement('span');
    probe.style.color = 'var(--dim)';
    f.append(probe);
    const dim = getComputedStyle(probe).color;
    probe.remove();
    return {
      f: { l: r(f).left, rt: r(f).right, t: r(f).top, b: r(f).bottom, w: Math.round(r(f).width), border: fs.borderTopWidth + ' ' + fs.borderTopStyle },
      at: at ? { text: at.textContent, l: r(at).left, rt: r(at).right, t: r(at).top, b: r(at).bottom, color: getComputedStyle(at).color } : null,
      inp: { l: r(inp).left, border: is.borderTopWidth, sw: inp.scrollWidth, cw: inp.clientWidth, color: is.color },
      dim, firstChild: f.firstElementChild === at,
      below: how ? Math.round((r(how).top - r(f).bottom) * 10) / 10 : null,
    };
  });
  ok(fld.at && fld.at.text === '@' && fld.firstChild && fld.f.border === '1px solid' && fld.inp.border === '0px'
    && fld.at.l >= fld.f.l + 1 && fld.at.rt <= fld.inp.l + 0.5 && fld.at.t >= fld.f.t && fld.at.b <= fld.f.b && fld.at.color === fld.dim && fld.at.color !== fld.inp.color,
    'N1: the @ is a dim prefix INSIDE the bordered name field (the field is the box, the input is borderless)', fld);
  ok(fld.f.w >= 180 && fld.inp.sw <= fld.inp.cw, 'N2: the name field is at least 180px and @alpha-platform-2 fits it unclipped', { w: fld.f.w, sw: fld.inp.sw, cw: fld.inp.cw });
  ok(fld.below !== null && Math.abs(fld.below - 8) <= 0.5, '...and the choices stack UNDER it, one row each, 8px apart (auriga 2026-09-28: [New | Resume] is row 2)', fld.below);

  /* 3. Add 1: the two calls, then the seat is selected on its fresh pane */
  calls.length = 0;
  await page.click('.ras-go');
  await sleep(2500);
  s = await na();
  ok(!s.open, 'the sheet closes on success', s);
  ok(calls.length === 2 && calls[0].path === '/seats' && JSON.stringify(calls[0].body) === JSON.stringify({ recipe_id: 'rec-ap', handle: 'alpha-platform-2', policy: 'persistent' }),
    'call 1: POST seats {recipe_id, handle, policy:persistent}', calls[0]);
  ok(calls[1] && /^\/seats\/[^/]+\/start$/.test(calls[1].path) && JSON.stringify(calls[1].body) === JSON.stringify({ target: 'tab', surface: 'browser' }),
    "call 2: POST seats/:id/start {target:'tab', surface:'browser'}", calls[1]);
  let seats = await seatsNow();
  const ap2 = seats.find((x) => x.handle === 'alpha-platform-2');
  ok(ap2 && ap2.occupant?.id && /^recipe:rec-ap#[0-9a-f]{8}$/.test(ap2.occupant.id), 'the engine has @alpha-platform-2 with a FRESH occupant pane of the recipe', ap2?.occupant);
  const view = await page.evaluate(() => ({
    sel: document.querySelector('#roster .seat.sel')?.dataset.handle,
    frames: [...document.querySelectorAll('#seatView iframe')].filter((f) => !f.hidden).map((f) => f.getAttribute('src')),
    seatShown: !document.getElementById('seatView').hidden,
  }));
  ok(view.sel === 'alpha-platform-2' && view.seatShown && view.frames.length === 1 && ap2 && view.frames[0].includes(encodeURIComponent(ap2.occupant.id)),
    '...and the room selects the new seat, framed on that pane', view);

  /* 4. back to back: the suggestion moves on; a typed name is normalised */
  await openPlus();
  await tick('rec-ap');
  s = await na('rec-ap');
  ok(s.handle === 'alpha-platform-3', 'reopened: the suggestion moves to @alpha-platform-3', s);
  await page.fill(fieldSel('rec-ap'), '');
  await page.type(fieldSel('rec-ap'), 'Asset  Two!');
  s = await na('rec-ap');
  ok(s.handle === 'asset-two-', 'typing is normalised to the handle grammar as you type ("Asset  Two!" → asset-two-)', s);
  calls.length = 0;
  await page.press(fieldSel('rec-ap'), 'Enter');
  await sleep(2500);
  seats = await seatsNow();
  const two = seats.find((x) => x.handle === 'asset-two');
  ok(!(await na()).open && two?.occupant?.id && two.occupant.id !== ap2?.occupant?.id, 'Enter adds + starts it as @asset-two (trailing hyphen dropped), a second fresh pane of the same recipe', two?.occupant);
  ok(calls[0]?.body?.handle === 'asset-two', '...the handle sent is the finished one', calls[0]);

  /* 5. a taken handle typed by hand: refused inline, before any call */
  await openPlus();
  await tick('rec-bb');
  ok((await na('rec-bb')).handle === 'kiosk', 'a recipe whose slug is free suggests it bare (@kiosk)', await na('rec-bb'));
  calls.length = 0;
  await page.fill(fieldSel('rec-bb'), 'alpha-platform');
  s = await na('rec-bb');
  ok(/@alpha-platform is already taken in this room/.test(s.err) && s.go.disabled, 'typing a taken @name shows the refusal inline and holds Add', s);
  await page.fill(fieldSel('rec-bb'), 'room');
  s = await na('rec-bb');
  ok(/reserved/.test(s.err) && s.go.disabled, '...and a reserved one (@room) likewise', s);

  /* 6. the engine's refusal, when the page could not know (taken meanwhile) */
  await page.fill(fieldSel('rec-bb'), 'late-name');
  const other = await call(`/api/rooms/${R}/seats`, { json: { handle: 'late-name', policy: 'persistent' } });
  ok(other.status === 200, 'setup: someone else takes @late-name meanwhile', other.status);
  await page.click('.ras-go');
  await sleep(1200);
  s = await na('rec-bb');
  ok(s.open && /not added/.test(s.err) && /late-name/.test(s.err) && /taken/.test(s.err), "the engine's 409 lands inline on the row; the sheet stays open", s);
  ok(calls.filter((c) => c.path.endsWith('/start')).length === 0, '...and no start was attempted', calls);

  /* 7. added, but the start fails: say so, leave the seat */
  await page.route('**/api/rooms/*/seats/*/start', (route) =>
    route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'probe: launch refused' }) }));
  await page.fill(fieldSel('rec-bb'), 'half-way');
  await page.click('.ras-go');
  await sleep(1500);
  s = await na('rec-bb');
  ok(s.open && /@half-way was added but not started/.test(s.err) && /probe: launch refused/.test(s.err), 'a failed start after the add is said inline', s);
  ok(s.go.text === 'Add 1' && !s.go.disabled, '...and Add (1) is ready to retry the start (not a second seat)', s.go);
  ok(await page.evaluate(() => document.querySelector('.ras-proj[data-recipe="rec-bb"] .ras-retry')?.textContent === 'Retry start'), '...and the row has its own "Retry start"');
  seats = await seatsNow();
  const hw = seats.find((x) => x.handle === 'half-way');
  ok(hw && !hw.occupant?.id && (hw.actions || []).includes('start'), '...the seat stays, never-started, with its own Start', hw && { occupant: hw.occupant, actions: hw.actions });
  const rosterHas = await page.evaluate(() => !!document.querySelector('#roster .seat[data-handle="half-way"]'));
  ok(rosterHas, '...and the roster behind the sheet already shows it', rosterHas);
  await page.unroute('**/api/rooms/*/seats/*/start');
  calls.length = 0;
  await page.click('.ras-go');
  await sleep(2500);
  seats = await seatsNow();
  const hw2 = seats.find((x) => x.handle === 'half-way');
  ok(!(await na()).open && calls.length === 1 && calls[0].path.endsWith('/start') && hw2?.occupant?.id, 'the retry starts THAT seat (one call, no second add)', calls);
  ok(seats.filter((x) => x.handle.startsWith('half-way')).length === 1, '...one @half-way seat, not two', seats.map((x) => x.handle));
  ok(errors.length === 0, 'no page errors', errors.slice(0, 3));

  /* 8. phone: the rows fit 390 */
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: await context.storageState() });
  const pp = await phone.newPage();
  const perr = [];
  pp.on('pageerror', (e) => perr.push(String(e)));
  await pp.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
  await sleep(1500);
  await pp.evaluate(() => document.getElementById('addBtn').click());
  await pp.waitForSelector('.ras-proj', { timeout: 5000 });
  await pp.evaluate(() => document.querySelector('.ras-proj[data-recipe="rec-zz"] .nm').click());
  await sleep(200);
  const m = await pp.evaluate(() => {
    const row = document.querySelector('.ras-proj[data-recipe="rec-zz"]');
    const r = (el) => el.getBoundingClientRect();
    const box = (k) => ({ l: Math.round(r(k).left), rt: Math.round(r(k).right), h: Math.round(r(k).height), fs: getComputedStyle(k.matches('.ras-fld') ? k.querySelector('input') : k).fontSize });
    const fields = [...row.querySelectorAll('.ras-fld, select')].map(box);
    const kids = [...fields, ...[...row.querySelectorAll('.ras-how button'), document.querySelector('.ras-go')].map(box)];
    return { vw: innerWidth, sw: document.documentElement.scrollWidth, boxSw: document.querySelector('.ras-body').scrollWidth, boxW: document.querySelector('.ras-body').clientWidth, kids, fields, handle: row.querySelector('.ras-fld input').value };
  });
  ok(m.sw <= m.vw && m.boxSw <= m.boxW, 'phone: no sideways scroll at 390', m);
  ok(m.kids.every((k) => k.l >= 0 && k.rt <= m.vw && k.h >= 44), 'phone: name, New | Resume, Model, Effort and Add sit inside the screen, 44px targets', m.kids);
  ok(m.fields.length === 3 && m.fields.every((k) => k.fs === '16px'), 'phone: fields (name, Model, Effort) at 16px (no focus zoom)', m.fields.map((k) => k.fs));
  ok(m.handle === 'zebra', 'phone: the suggestion works there too', m.handle);
  ok(perr.length === 0, 'no page errors on the phone', perr.slice(0, 3));
  await phone.close();
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
