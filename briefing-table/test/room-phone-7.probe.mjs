/* SEVEN PHONE CHANGES TO THE ROOM PAGE [web/room-phone-7] (Owner, room line [ref]).
 *
 *   node test/room-phone-7.probe.mjs                 (WebKit; falls back LOUDLY to Chromium)
 *   PROBE_BROWSER=chromium node test/room-phone-7.probe.mjs
 *   SHOTS_DIR=<dir> node test/room-phone-7.probe.mjs (screenshots)
 *
 * At 320x522 and 390x844 (isMobile + hasTouch, window.screen faked to the
 * viewport, a visualViewport the probe can shrink: the soft keyboard):
 *   1. the line (the jump strip) is HIDDEN by default; the grid button shows /
 *      hides it (aria-pressed, "Show the line" / "Hide the line"); a reload
 *      hides it again; the keyboard still auto-hides a shown line
 *   2. "CLI Manager" is the FIRST chip; its sheet lists Rooms (every open room
 *      but this one, a hidden one left out, with colour + mark) then Live
 *      agents; a room row navigates this tab to /room.html?room=, an agent row
 *      to its /solo.html; "Open in new tab" and a long press open a new page
 *   3. the title spans the full width on its own row (ellipsis at the right
 *      only), the icons sit under it, the header stays ~the same height
 *   4. the subtitle is two lines: "5 agents" / "1 app" (the Assets app is the Scratchpad now: its lines are in the agents sheet [scratchpad])
 *   5. the status line over the composer is the addressed seats' chips: one per
 *      recipient in the order addressed (a leading run + a mid-text mention),
 *      the row scrolls inside itself at 320, a chip's ring follows its seat's
 *      activity (and animates), a newer line replaces the chips
 *   6. the phone glass: bubble base alpha .5, no backdrop blur, the meta lift, the room art
 *      present, the halo on line text; removing html.phone-glass turns it off
 *   7. keyboard up (vv 254) + an attachment + 12 lines: the tray is compact,
 *      the textarea's bottom and the caret are inside the visible viewport
 *      (caret at the end, in the middle, and after typing)
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(240), DEAD broker P(241).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(240);
const DEAD_BROKER_PORT = P(241);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-phone-7-token';
const SHOTS = process.env.SHOTS_DIR || '';
const SIZES = [[320, 522], [390, 844]];
const VV = 254; // Owner's visible viewport with the keys up

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

/* the phone's screen, and a visualViewport the probe can shrink */
const INIT = ([sw, sh]) => {
  Object.defineProperty(window.screen, 'width', { get: () => sw });
  Object.defineProperty(window.screen, 'height', { get: () => sh });
  const real = window.visualViewport;
  const fake = new EventTarget();
  let kb = 0;
  Object.defineProperties(fake, {
    width: { get: () => (real ? real.width : window.innerWidth) },
    height: { get: () => (real ? real.height : window.innerHeight) - kb },
    scale: { get: () => (real ? real.scale : 1) },
    offsetTop: { get: () => (real ? real.offsetTop : 0) },
    offsetLeft: { get: () => (real ? real.offsetLeft : 0) },
    pageTop: { get: () => (real ? real.pageTop : 0) },
    pageLeft: { get: () => (real ? real.pageLeft : 0) },
  });
  real?.addEventListener('resize', () => fake.dispatchEvent(new Event('resize')));
  Object.defineProperty(window, 'visualViewport', { get: () => fake, configurable: true });
  window.__kb = (px) => { kb = px; fake.dispatchEvent(new Event('resize')); };
  /* the caret's depth in the box: the page's own twin method */
  window.__caret = () => {
    const el = document.getElementById('input');
    const twin = el.cloneNode(false);
    twin.removeAttribute('id');
    Object.assign(twin.style, { position: 'absolute', visibility: 'hidden', height: '0px', minHeight: '0px', maxHeight: 'none', width: `${el.offsetWidth}px`, left: '0', top: '0' });
    twin.value = el.value.slice(0, el.selectionEnd);
    el.parentNode.append(twin);
    const depth = twin.scrollHeight;
    twin.remove();
    const r = el.getBoundingClientRect();
    const v = window.visualViewport;
    const line = parseFloat(getComputedStyle(el).lineHeight) || 22;
    const caretBottom = r.top + (depth - el.scrollTop); // viewport y of the caret line's foot
    return {
      boxTop: Math.round(r.top), boxBottom: Math.round(r.bottom), vvBottom: Math.round(v.offsetTop + v.height), vvTop: Math.round(v.offsetTop),
      caretTop: Math.round(caretBottom - line), caretBottom: Math.round(caretBottom),
      scrollTop: Math.round(el.scrollTop), clientH: el.clientHeight, scrollH: el.scrollHeight,
      max: getComputedStyle(el).maxHeight, taMax: document.documentElement.style.getPropertyValue('--ta-max'),
      compose: Math.round(document.getElementById('compose').getBoundingClientRect().bottom),
    };
  };
};

try {
  const stale = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
  if (stale.ok) {
    console.log(` FAIL  :${PORT} is already serving something — a leaked engine from an aborted run?`);
    process.exit(1);
  }
} catch { /* nothing there */ }
for (const p of [PORT, DEAD_BROKER_PORT]) {
  await assertFree(p, 'room-phone-7.probe.mjs');
}
if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); }

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-phone-7-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null;
let browser = null;
let browserName = process.env.PROBE_BROWSER === 'chromium' ? 'chromium' : 'webkit';
let engineLog = '';
const seed = async (plan) => {
  const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
  return JSON.parse(r.out.trim().split('\n').pop());
};

/* five seats in THIS room; three live. Long handles so three chips overflow 320. */
const AGENTS = [
  ['alpha-reviewer', '#0dab49'],
  ['bravo-builder', '#b5651d'],
  ['charlie-the-tester', '#1f5fbf'],
  ['delta', '#8a2be2'],
  ['echo', '#0a8f8f'],
];
const OTHERS = [['loner-agent', '#ba0d0d'], ['bee-lead', '#c9a227']];
const ROOM = 'Briefing Table phone seven room with a long name';
const STRIPES = Array.from({ length: 25 }, (_, i) => `<rect x="${i * 4}" y="0" width="2" height="100"/>`).join('');
const ART_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${STRIPES}</svg>`;

try {
  /* bravo is not claude-code: the typer never types into it (badge only) */
  const vendorOf = (agent) => (agent === 'bravo-builder' ? 'cli-manager' : 'claude-code');
  const recipe = (agent, color) => ({ id: `rec-${agent}`, name: agent, projectDir: `/srv/x/${agent}`, vendor: vendorOf(agent), agent, color });
  await seed({ recipes: [...AGENTS, ...OTHERS].map(([a, c]) => recipe(a, c)) });
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

  const pane = (a) => `recipe:rec-${a}`;
  const post = await seed({
    sessions: [...AGENTS.slice(0, 3), ...OTHERS].map(([a]) => ({ paneid: pane(a), recipe_id: `rec-${a}`, vendor: vendorOf(a), agent: a, state: 'live' })),
    rooms: [
      { name: ROOM, seats: AGENTS.map(([a], i) => ({ handle: a, recipe_id: `rec-${a}`, occupant: i < 3 ? pane(a) : null })) },
      { name: 'Bee room', seats: [{ handle: 'bee-lead', recipe_id: 'rec-bee-lead', occupant: pane('bee-lead') }] },
      { name: 'Cee room', seats: [] },
      { name: 'Hidden room', seats: [] },
    ],
  });
  const [R, RB, RC, RH] = post.rooms.map((x) => x.id);
  const bearer = (path, init = {}) => fetch(BASE + path, { ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers || {}) } });

  try {
    browser = browserName === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ headless: true });
  } catch (e) {
    console.log(`\n  *** WEBKIT COULD NOT LAUNCH ON THIS HOST — running on CHROMIUM instead ***\n  ${String(e.message || e).split('\n')[0]}\n`);
    browserName = 'chromium';
    browser = await chromium.launch({ headless: true });
  }
  console.log(`[browser: ${browserName}]`);
  const login = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const lp = await login.newPage();
  await lp.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await lp.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([lp.waitForNavigation().catch(() => {}), lp.click('form button:visible')]);
  const storage = await login.storageState();
  const cookie = (await login.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const asUser = (path, init = {}) => fetch(BASE + path, { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers || {}) } });

  const made = await (await bearer('/api/logos', { method: 'POST', body: JSON.stringify({ name: 'Stripes', svg: ART_SVG }) })).json();
  const art = await asUser(`/api/rooms/${R}/settings`, { method: 'PATCH', body: JSON.stringify({ art: `lib:${made?.logo?.id}`, color: '#1f8fa6' }) });
  const artB = await asUser(`/api/rooms/${RB}/settings`, { method: 'PATCH', body: JSON.stringify({ art: `lib:${made?.logo?.id}`, color: '#ba08b4' }) });
  const hide = await asUser('/api/rooms/me', { method: 'PATCH', body: JSON.stringify({ hiddenRooms: [RH] }) });
  ok(art.status === 200 && artB.status === 200 && hide.status === 200, 'setup: this room and Bee room wear art + a colour; Hidden room is hidden from my list', [art.status, artB.status, hide.status]);
  for (let i = 0; i < 24; i += 1) {
    const by = AGENTS[i % 3][0];
    const text = i % 3 === 2 ? `a line from me ${i}: @alpha-reviewer the deploy graph is pinned and the marks sit behind the names.` : `line ${i}: the deploy graph is pinned and the marks sit behind the names, @delta.`;
    const r = i % 3 === 2
      ? await asUser(`/api/rooms/${R}/line`, { method: 'POST', body: JSON.stringify({ text }) })
      : await bearer(`/api/rooms/${R}/line`, { method: 'POST', body: JSON.stringify({ text, from: { paneid: pane(by) } }) });
    if (r.status !== 200) { ok(false, `setup: line ${i}`, [r.status, await r.text()]); break; }
  }

  /* two apps, injected into the room view (the phone never loads a panel's
     frame), and a seat's activity the probe can move */
  const PANELS = [
    { id: 'p-tasks', title: 'Tasks', icon: 'tasks', app: 'tasks', frameUrl: '/probe-none/tasks/' },
    { id: 'p-assets', title: 'Assets', icon: 'image', app: 'assets', frameUrl: '/probe-none/assets/' },
  ];
  const acts = new Map(); // handle -> injected occupant activity
  let hideLoner = false; // /api/table without the one unseated live agent
  const heldGone = new Set(); // handles whose typer queue is emptied (their line typed in)
  const ROOM_URL = `${BASE}/room.html?room=${R}`;
  const errors = [];
  const openPhone = async (w, h) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, storageState: storage });
    await ctx.addInitScript(INIT, [w, h]);
    await ctx.route((u) => u.pathname === `/api/rooms/${R}`, async (route) => {
      if (route.request().method() !== 'GET') { return route.continue(); }
      const res = await route.fetch();
      let body = null;
      try { body = await res.json(); } catch { return route.fulfill({ response: res }); }
      body.panels = [...(Array.isArray(body.panels) ? body.panels : []), ...PANELS];
      for (const s of body.seats ?? []) {
        if (acts.has(s.handle) && s.occupant && typeof s.occupant === 'object') {
          s.occupant.activity = acts.get(s.handle);
        }
        if (heldGone.has(s.handle) && s.occupant && typeof s.occupant === 'object') {
          delete s.occupant.held;
        }
      }
      return route.fulfill({ response: res, json: body });
    });
    /* the typer's answer for bravo, as a non-claude seat reports it (this
       probe's panes have no pty, so the engine reports every seat not live) */
    await ctx.route((u) => u.pathname === `/api/rooms/${R}/line`, async (route) => {
      if (route.request().method() !== 'POST' || !String(route.request().postData() || '').includes('please look')) { return route.continue(); }
      const res = await route.fetch();
      let body = null;
      try { body = await res.json(); } catch { return route.fulfill({ response: res }); }
      for (const dd of body.deliveries ?? []) {
        if (dd.handle === 'bravo-builder') { dd.delivered = true; dd.typed = 'vendor'; }
      }
      return route.fulfill({ response: res, json: body });
    });
    await ctx.route((u) => u.pathname === '/api/table', async (route) => {
      if (!hideLoner) { return route.continue(); }
      const res = await route.fetch();
      const body = await res.json();
      body.sessions = (body.sessions ?? []).filter((x) => x.recipe_id !== 'rec-loner-agent');
      return route.fulfill({ response: res, json: body });
    });
    await ctx.route(/\/probe-none\//, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>app</p>' }));
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errors.push(`${w}: ${e} @ ${pg.url().replace(BASE, '')} ${String(e.stack || '').split('\n').slice(0, 3).join(' | ')}`));
    await pg.goto(ROOM_URL, { waitUntil: 'domcontentloaded' });
    await pg.waitForSelector('#line .entry');
    await sleep(3000); // a poll: the apps land, the strip
    return { ctx, pg };
  };
  const shot = async (pg, name) => { if (SHOTS) { await pg.screenshot({ path: join(SHOTS, `phone7-${name}.png`) }); } };
  const docOverflow = (pg) => pg.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, bw: document.body.scrollWidth, iw: innerWidth }));

  for (const [w, h] of SIZES) {
    console.log(`\n[${w}x${h}]`);
    let { ctx, pg } = await openPhone(w, h);
    await shot(pg, `${w}-home`);

    /* ---- 1. the line toggle ---- */
    const strip = () => pg.evaluate(() => {
      const s = document.getElementById('phStrip');
      const b = document.getElementById('phLine');
      return { hidden: s.hidden, display: getComputedStyle(s).display, h: Math.round(s.getBoundingClientRect().height), pressed: b.getAttribute('aria-pressed'), label: b.getAttribute('aria-label'), title: b.title, count: b.querySelector('.n') ? 1 : 0, apps: !!document.getElementById('phApps') };
    });
    let st = await strip();
    ok(st.hidden && st.display === 'none' && st.h === 0 && st.pressed === 'false' && st.label === 'Show rooms, apps & seats' && st.count === 0 && !st.apps, `${w}: the line is hidden by default; the grid button says "Show rooms, apps & seats", not pressed, no count badge`, st);
    await pg.click('#phLine');
    await sleep(200);
    const pressedBox = await pg.evaluate(() => {
      const b = document.getElementById('phLine').getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('phName'));
      const t = range.getBoundingClientRect();
      return { bg: getComputedStyle(document.getElementById('phLine')).backgroundColor, top: Math.round(b.top), right: Math.round(b.right), textL: Math.round(t.left), textB: Math.round(t.bottom), h: Math.round(b.height) };
    });
    ok(pressedBox.bg !== 'rgba(0, 0, 0, 0)' && (pressedBox.top >= pressedBox.textB || pressedBox.right <= pressedBox.textL + 1), `${w}: the pressed box does not cover the title (the toggle spans both header rows at the far left, so: box right ${pressedBox.right} <= text left ${pressedBox.textL}, or box top ${pressedBox.top} >= text bottom ${pressedBox.textB})`, pressedBox);
    st = await strip();
    ok(!st.hidden && st.display === 'flex' && st.h > 40 && st.pressed === 'true' && st.label === 'Hide rooms, apps & seats', `${w}: tapping it shows the line ("Hide rooms, apps & seats", pressed)`, st);
    await shot(pg, `${w}-line-shown`);
    await pg.click('#phLine');
    await sleep(200);
    st = await strip();
    ok(st.hidden && st.display === 'none' && st.pressed === 'false', `${w}: tapping again hides it`, st);
    await pg.click('#phLine');
    await pg.reload({ waitUntil: 'domcontentloaded' });
    await pg.waitForSelector('#line .entry');
    await sleep(2800);
    st = await strip();
    ok(st.hidden && st.display === 'none' && st.pressed === 'false', `${w}: not remembered: a reload hides it again`, st);

    /* ---- 3 + 4. the header ---- */
    const hd = await pg.evaluate(() => {
      const r = (el) => el.getBoundingClientRect();
      const hdr = document.querySelector('.ph-hdr');
      const name = document.getElementById('phName');
      const g = document.getElementById('phGlyph');
      const btns = [...document.querySelectorAll('.ph-hdr .ph-ib')];
      const rowBtns = btns.filter((b) => b.id !== 'phLine'); // the icon row; the line toggle spans both rows
      const glyphs = btns.map((b) => r(b.querySelector('svg')));
      const cs = getComputedStyle(name);
      const range = document.createRange();
      range.selectNodeContents(name);
      const textLeft = range.getClientRects()[0]?.left ?? null;
      const tr = range.getBoundingClientRect(); // the title's TEXT box
      const hit = (b) => { const be = getComputedStyle(b, '::before'); return Math.round(r(b).height - (parseFloat(be.top) || 0) - (parseFloat(be.bottom) || 0)); };
      const hits = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const meta = document.getElementById('phMeta');
      return {
        hdrH: Math.round(r(hdr).height), hdrR: Math.round(r(hdr).right),
        nameL: Math.round(r(name).left), nameR: Math.round(r(name).right), nameB: Math.round(r(name).bottom), nameT: Math.round(r(name).top),
        textL: textLeft === null ? null : Math.round(textLeft), scrollL: name.scrollLeft,
        clipped: name.scrollWidth > name.clientWidth, overflow: cs.textOverflow, ws: cs.whiteSpace, dir: cs.direction, padR: cs.paddingRight,
        glyphL: Math.round(r(g).left), glyphR: Math.round(r(g).right),
        iconTop: Math.round(Math.min(...rowBtns.map((b) => r(b.querySelector('svg')).top))), /* the ICON ROW: agents, filter, gear; the line toggle spans both rows */ iconL: Math.round(Math.min(...btns.map((b) => r(b).left))),
        btnH: btns.map((b) => Math.round(r(b).height)), btnHit: btns.map(hit),
        textB: Math.round(tr.bottom), boxTop: Math.round(Math.min(...rowBtns.map((b) => r(b).top))),
        overlap: rowBtns.filter((b) => hits(r(b), tr)).map((b) => b.id),
        /* each button's box, padding and PRESSED box (aria-pressed forced on for the read) */
        boxes: btns.map((b) => {
          const cs = getComputedStyle(b);
          const was = b.getAttribute('aria-pressed');
          b.setAttribute('aria-pressed', 'true');
          const pr = r(b);
          const pbg = getComputedStyle(b).backgroundColor;
          if (was === null) { b.removeAttribute('aria-pressed'); } else { b.setAttribute('aria-pressed', was); }
          return { id: b.id, w: Math.round(r(b).width), h: Math.round(r(b).height), pad: cs.padding, pressedH: Math.round(pr.height), pressedBg: pbg, pressedHits: hits(pr, tr) };
        }),
        metaLines: [...meta.children].map((c) => c.textContent), metaRects: [...meta.children].map((c) => Math.round(r(c).top)), metaT: Math.round(r(meta).top), metaL: Math.round(r(meta).left), metaR: Math.round(r(meta).right),
        metaMid: Math.round((r(meta).top + r(meta).bottom) / 2), agentsMid: Math.round((r(document.getElementById('phAgents')).top + r(document.getElementById('phAgents')).bottom) / 2),
        lineL: Math.round(r(document.getElementById('phLine')).left), lineR: Math.round(r(document.getElementById('phLine')).right),
        glyphT: Math.round(r(g).top), glyphB: Math.round(r(g).bottom), glyphW: Math.round(r(g).width),
        agentsL: Math.round(r(document.getElementById('phAgents')).left), agentsR: Math.round(r(document.getElementById('phAgents')).right),
        filterL: Math.round(r(document.getElementById('phFilter')).left), gearL: Math.round(r(document.getElementById('phGear')).left),
        gearR: Math.round(r(document.getElementById('phGear')).right),
        textLine: Math.round(r(document.getElementById('phLine')).top + r(document.getElementById('phLine')).height / 2),
      };
    });
    ok(hd.nameL >= hd.lineR - 1 && hd.nameR >= hd.hdrR - 56, /* the room-brief (i) holds row 1's right edge (Owner 2026-10-05) */ `${w}: the title is row 1, full width right of the line toggle (${hd.nameL}..${hd.nameR} of ${hd.hdrR}) [Owner 2026-10-02, phone header order]`, hd);
    ok(hd.lineL < 12 && hd.lineR <= hd.glyphL && hd.glyphR <= hd.agentsL + 8 && hd.agentsR <= hd.metaL && hd.metaR <= hd.filterL + 1 && hd.filterL < hd.gearL && hd.gearR <= hd.hdrR, `${w}: row 2 reads line toggle | mark | agents | meta | filter | gear, left to right`, hd);
    ok(hd.glyphT >= hd.nameB - 1 && hd.glyphW <= 24 && hd.metaT >= hd.nameB - 1, `${w}: the mark (${hd.glyphW}px) and the meta sit under the title`, hd);
    ok(hd.clipped && hd.overflow === 'ellipsis' && hd.ws === 'nowrap' && hd.dir === 'ltr' && hd.scrollL === 0 && hd.textL !== null && hd.textL - hd.nameL >= 0 && hd.textL - hd.nameL <= 8 && /* the title's 6px left padding (.ph-name padding: 0 12px 0 6px) */ parseFloat(hd.padR) >= 10, `${w}: the long title ellipsises at the RIGHT only (starts at its left padding, ${hd.padR} after it)`, hd);
    ok(hd.iconTop >= hd.nameB - 1 && hd.iconL < hd.nameL, `${w}: the icon row sits under the title (icon glyph top ${hd.iconTop} >= title bottom ${hd.nameB})`, hd);
    ok(hd.hdrH >= 52 && hd.hdrH <= 68, /* 65: the room-brief (i) sits in row 1 (Owner 2026-10-05) */ `${w}: the header keeps its height (${hd.hdrH}px, as web/room-phone-7 shipped it)`, hd);
    ok(hd.overlap.length === 0 && hd.boxTop >= hd.textB && hd.btnH.every((x) => x < hd.hdrH - 20), `${w}: the icons' visual boxes (${hd.btnH}px) sit under the title's text box and never touch it (box top ${hd.boxTop} >= text bottom ${hd.textB}) [web/room-phone-7b]`, hd);
    ok(hd.btnHit.every((x) => x >= 44), `${w}: ...each still a 44px tap target (${hd.btnHit})`, hd.btnHit);
    const b0 = hd.boxes[0];
    ok(hd.boxes.length >= 4 && hd.boxes.every((b) => b.w === b0.w && b.h === b0.h && b.pad === b0.pad && b.pressedH === b0.pressedH && b.pressedBg === b0.pressedBg && b.pressedBg !== 'rgba(0, 0, 0, 0)' && !b.pressedHits), `${w}: every header icon button has the same box, padding and selected box (${b0.w}x${b0.h}, padding ${b0.pad}), none touching the title`, hd.boxes);
    ok(JSON.stringify(hd.metaLines) === '["5 agents","1 app"]' && hd.metaRects[1] > hd.metaRects[0] && Math.abs(hd.metaMid - hd.agentsMid) <= 3, `${w}: the subtitle stays two stacked lines ("5 agents" / "1 app": the Assets app is the Scratchpad, in the agents sheet), centered on the icon row after the agents button`, hd);

    /* ---- 2. the rail [phone rail] (Owner 2026-10-08): Workbench, this room's apps, then its seats; NO rooms on it ---- */
    await pg.click('#phLine');
    await pg.waitForSelector('#phStrip .ph-chip.ph-places', { timeout: 6000 }).catch(() => {});
    await sleep(200);
    const rail = await pg.evaluate(() => [...document.querySelectorAll('#phStrip > .ph-chip')].map((c) => (c.classList.contains('ph-places') ? 'wb' : c.classList.contains('ph-room') ? `room:${c.textContent.trim()}` : c.dataset.go?.startsWith('app:') ? 'app' : c.dataset.seat ? 'seat' : '?')));
    const kinds = rail.map((x) => x.split(':')[0]);
    ok(rail[0] === 'wb' && !rail.some((x) => x.startsWith('room:')) , `${w}: the rail opens with Workbench and has NO rooms on it`, rail);
    ok(kinds.indexOf('app') === 1 && kinds.lastIndexOf('app') < kinds.indexOf('seat') && !kinds.includes('?'), `${w}: ...then this room's apps, then its seats`, kinds);
    await shot(pg, `${w}-rail`);
    await pg.click('#phStrip .ph-places');
    await pg.waitForSelector('#phSheet:not([hidden]) .pl-full', { timeout: 6000 }).catch(() => {});
    await pg.waitForFunction(() => document.querySelectorAll('#phSheet h3').length >= 1, null, { timeout: 8000 }).catch(() => {}); // the headings land after the rows on a slower machine
    const wbs = await pg.evaluate(() => ({ label: document.getElementById('phSheet').getAttribute('aria-label'), first: document.querySelector('#phSheetBody .pl-row')?.textContent.replace(/\s+/g, ' ').trim(), heads: [...document.querySelectorAll('#phSheet h3')].map((h) => h.textContent) }));
    ok(wbs.label === 'Workbench' && /^Full Workbench/.test(wbs.first ?? '') && wbs.heads[0] === 'Rooms', `${w}: the Workbench chip opens the Workbench sheet (Full Workbench on top, then Rooms)`, wbs);
    await shot(pg, `${w}-workbench-sheet`);
    await Promise.all([pg.waitForURL('**/manager.html', { timeout: 5000 }).catch(() => {}), pg.click('#phSheet .pl-full')]);
    ok(pg.url().endsWith('/manager.html'), `${w}: "Full Workbench" goes home`, pg.url());
    await pg.goto(ROOM_URL, { waitUntil: 'domcontentloaded' });
    await pg.waitForSelector('#line .entry');
    await sleep(2800);
    /* the people button's sheet: Scratchpad / Rooms / Seats, no Workbench row, no Apps (they are on the rail) */
    await pg.click('#phAgents');
    await sleep(300);
    const sh = await pg.evaluate(() => ({ heads: [...document.querySelectorAll('#phSheet h3')].map((x) => x.textContent.replace(/[+].*/, '').trim()), wb: !!document.getElementById('phWorkbench') }));
    ok(!sh.wb && !sh.heads.includes('Apps') && sh.heads.includes('Seats'), `${w}: the people button's sheet has no Workbench row and no Apps section`, sh);
    await pg.evaluate(() => document.getElementById('phScrim').click());
    await sleep(300);


    /* ---- [web/room-phone-7b] no "line" in what the phone says ---- */
    await pg.click('#phLine');
    await pg.click('#phStrip .ph-chip[data-go^="app:"]');
    await sleep(900);
    const back = await pg.evaluate(() => { const b = document.getElementById('lyBack'); return { text: b.childNodes[0]?.textContent.trim(), label: b.getAttribute('aria-label') }; });
    ok(back.text === '‹ Room' && /^Back to the room/.test(back.label), `${w}: a layer's back button reads "‹ Room" ("${back.label}")`, back);
    await pg.click('#lyBack');
    await sleep(500);
    const words = async () => pg.evaluate(() => {
      const out = [];
      const seen = (el) => { for (const a of ['aria-label', 'title', 'placeholder']) { const v = el.getAttribute?.(a); if (v && /\bline\b/i.test(v)) { out.push(`${el.id || el.className}[${a}]: ${v}`); } } };
      const walk = (el) => {
        if (el.closest?.('#line .entry, .rm-lb')) { return; } // messages are the users' own words
        seen(el);
        for (const n of el.childNodes) {
          if (n.nodeType === 3 && /\bline\b/i.test(n.textContent) && getComputedStyle(el).display !== 'none') { out.push(`${el.id || el.className}: ${n.textContent.trim()}`); }
          if (n.nodeType === 1) { walk(n); }
        }
      };
      walk(document.body);
      return out;
    });
    let w1 = await words();
    await pg.click('#phFilter');
    await sleep(400);
    w1 = w1.concat(await words());
    await pg.evaluate(() => document.getElementById('phScrim').click());
    await pg.evaluate(() => document.getElementById('lySwitch').click());
    await sleep(400);
    w1 = w1.concat(await words());
    await pg.evaluate(() => document.getElementById('phScrim').click());
    await sleep(300);
    ok(w1.length === 0, `${w}: no user-visible "line" wording on the phone (home, the filter sheet, the ⇄ Switch sheet, labels and titles included)`, w1);

    /* ---- 5. the delivery chips ---- */
    await pg.fill('#input', '@charlie-the-tester @alpha-reviewer please look, and @bravo-builder too');
    await pg.click('#sendBtn');
    await sleep(1200);
    const dc = () => pg.evaluate(() => {
      const box = document.getElementById('deliveryChips');
      const chips = [...box.querySelectorAll('.rm-dchip')];
      const strip = (h) => [...document.querySelectorAll('#phStrip .ph-chip')].find((c) => c.querySelector('.h')?.textContent === h);
      return {
        shown: !box.hidden && getComputedStyle(box).display === 'flex', text: getComputedStyle(document.getElementById('delivery')).display,
        chips: chips.map((c) => ({ h: c.querySelector('.h')?.textContent, sfx: c.querySelector('.dsfx')?.textContent ?? null, marks: c.querySelectorAll('.dmark').length, ring: c.querySelector('.seat-ring')?.dataset.state ?? c.querySelector('.seat-plate')?.dataset.state ?? null, title: c.title, anim: c.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length, cls: c.className })),
        alphaStrip: strip('@alpha-reviewer')?.querySelector('.seat-ring')?.dataset.state ?? null,
        sw: box.scrollWidth, cw: box.clientWidth, ox: getComputedStyle(box).overflowX, wrap: getComputedStyle(box).flexWrap,
        top: Math.round(box.getBoundingClientRect().bottom), composeTop: Math.round(document.getElementById('compose').getBoundingClientRect().top),
      };
    });
    let d = await dc();
    ok(d.shown && d.text === 'none', `${w}: the text status line is gone; the chips row shows`, { shown: d.shown, text: d.text });
    ok(JSON.stringify(d.chips.map((c) => c.h)) === '["@charlie-the-tester","@alpha-reviewer","@bravo-builder"]', `${w}: one chip per recipient, in the order addressed (leading run, then the mid-text mention)`, d.chips.map((c) => c.h));
    ok(d.chips.every((c) => c.cls.includes('ph-chip') && c.ring && /@\S+ /.test(c.title)), `${w}: each is the strip's chip (ring + @handle) with the report in its tooltip`, d.chips);
    /* [web/room-phone-7b] a status readout, not buttons; handles in project ink */
    const ro = await pg.evaluate(() => {
      const box = document.getElementById('deliveryChips');
      const bcs = getComputedStyle(box);
      const chips = [...box.querySelectorAll('.rm-dchip')];
      return {
        flowH: Math.round(box.getBoundingClientRect().height + parseFloat(bcs.marginTop) + parseFloat(bcs.marginBottom)),
        chips: chips.map((c) => {
          const cs = getComputedStyle(c);
          const af = getComputedStyle(c, '::after');
          return { bg: cs.backgroundColor, bw: cs.borderTopWidth, bs: cs.borderTopStyle, pad: cs.padding, hit: Math.round(c.getBoundingClientRect().height - parseFloat(af.top) - parseFloat(af.bottom)) };
        }),
        inks: chips.map((c) => {
          const seat = c.dataset.seat;
          let author = document.querySelector(`#line .entry[data-author-seat="${CSS.escape(seat)}"] .entry-author`);
          if (!author) { // its bubbles are not on this page of the line: the same rule, on a stand-in
            const li = document.createElement('li');
            li.className = 'entry by-agent';
            li.dataset.authorSeat = seat;
            li.innerHTML = '<div class="entry-bubble"><span class="entry-author">x</span></div>';
            document.getElementById('line').append(li);
            author = li.querySelector('.entry-author');
            setTimeout(() => li.remove(), 0);
          }
          const strip = document.querySelector(`#phStrip .ph-chip[data-seat="${CSS.escape(seat)}"] .h`);
          return { h: c.querySelector('.h').textContent, readout: getComputedStyle(c.querySelector('.h')).color, strip: strip && getComputedStyle(strip).color, author: author && getComputedStyle(author).color, text: getComputedStyle(document.body).color };
        }),
      };
    });
    ok(ro.flowH <= 24 && ro.chips.every((c) => c.bg === 'rgba(0, 0, 0, 0)' && (c.bs === 'none' || c.bw === '0px') && c.pad === '0px' && c.hit >= 32), `${w}: the chips are a readout: no background, no border, no padding; the row takes ${ro.flowH}px; each keeps a 32px tap target`, ro);
    ok(ro.inks.length === 3 && ro.inks.every((x) => x.author && x.readout === x.author && x.strip === x.author && x.author !== x.text), `${w}: each @handle wears its seat's project ink, the same as its bubble's author name, in the readout and on the strip`, ro.inks);
    const dover = await docOverflow(pg);
    if (w === 320) {
      ok(d.sw > d.cw && (d.ox === 'auto' || d.ox === 'scroll') && d.wrap === 'nowrap' && dover.sw <= w, `320: three chips overflow and scroll inside their row (${d.sw} in ${d.cw}); the page does not scroll sideways`, { d: [d.sw, d.cw, d.ox, d.wrap], dover });
      const moved = await pg.evaluate(() => { const b = document.getElementById('deliveryChips'); b.scrollLeft = 200; return b.scrollLeft; });
      ok(moved > 0, '320: the chip row scrolls sideways', moved);
    } else {
      ok(dover.sw <= w && d.wrap === 'nowrap', `${w}: no sideways page overflow`, dover);
    }
    await shot(pg, `${w}-chips`);
    /* the chip follows its seat's activity */
    const ring0 = d.chips.find((c) => c.h === '@alpha-reviewer')?.ring;
    acts.set('alpha-reviewer', 'streaming');
    await sleep(3200);
    d = await dc();
    const a1 = d.chips.find((c) => c.h === '@alpha-reviewer');
    ok(a1 && a1.ring === 'active-streaming' && a1.ring !== ring0 && a1.ring === d.alphaStrip && a1.anim > 0, `${w}: when the seat works, its chip's ring moves with it (${ring0} -> ${a1?.ring}, the strip says ${d.alphaStrip}) and animates (${a1?.anim} running)`, a1);
    acts.set('alpha-reviewer', 'waiting');
    await sleep(3200);
    d = await dc();
    const a2 = d.chips.find((c) => c.h === '@alpha-reviewer');
    ok(a2 && a2.ring === d.alphaStrip && a2.ring !== 'active-streaming', `${w}: ...and again when it needs you (${a2?.ring})`, a2);
    acts.delete('alpha-reviewer');
    ok(d.chips.every((c) => c.marks === 0 && c.sfx === null), `${w}: the chips carry activity only: no corner marks, no status words`, d.chips.map((c) => [c.h, c.marks, c.sfx]));

    /* ---- 5b. where each copy got to: the read line under MY bubble ---- */
    const readLine = (needle) => pg.evaluate((n) => {
      const li = [...document.querySelectorAll('#line > .entry.by-user')].filter((x) => x.querySelector('.entry-body')?.textContent.includes(n)).pop();
      const el = li?.querySelector(':scope > .entry-reads');
      if (!el) { return { none: true, groups: {} }; }
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 15;
      const out = { text: el.textContent, lines: Math.round(el.getBoundingClientRect().height / lh), groups: {} };
      for (const g of el.querySelectorAll('.rd')) {
        const k = g.dataset.state;
        out.groups[k] = (out.groups[k] ? `${out.groups[k]} | ` : '') + g.textContent;
        if (k === 'held') {
          out.heldWord = getComputedStyle(g.querySelector('.rd-w')).color;
          out.heldRest = getComputedStyle(g).color;
        }
      }
      const probe = document.createElement('span');
      probe.style.color = 'var(--amber)';
      document.body.append(probe);
      out.amber = getComputedStyle(probe).color;
      probe.remove();
      return out;
    }, needle);
    let rl = await readLine('please look');
    ok(/^held @alpha-reviewer @charlie-the-tester · [a-z]/.test(rl.groups.held || '') && rl.heldWord === rl.amber && rl.heldRest !== rl.amber, `${w}: two live claude seats still in the typer's queue read "held @x @y · <reason>", the word held in amber`, rl);
    ok(rl.groups.badge === 'badge only @bravo-builder', `${w}: a seat the typer never types into reads "badge only"`, rl.groups);
    /* held -> delivered -> seen, live, no reload */
    heldGone.add('alpha-reviewer');
    await sleep(3200);
    rl = await readLine('please look');
    ok((rl.groups.delivered || '') === 'delivered @alpha-reviewer' && !(rl.groups.held || '').includes('@alpha-reviewer'), `${w}: its queue empties: "delivered @alpha-reviewer", in place`, rl.groups);
    const said = await bearer(`/api/rooms/${R}/line`, { method: 'POST', body: JSON.stringify({ text: 'on it', from: { paneid: pane('alpha-reviewer') } }) });
    await sleep(1500);
    rl = await readLine('please look');
    ok(said.status === 200 && (rl.groups.seen || '') === 'seen @alpha-reviewer' && !(rl.groups.delivered || '').includes('@alpha'), `${w}: it answers on the line: "seen @alpha-reviewer", pushed, no reload`, rl.groups);
    heldGone.delete('alpha-reviewer');
    await shot(pg, `${w}-reads`);
    /* [web/room-phone-7b] a seat that has REPLIED drops its chip; all replied = no row */
    d = await dc();
    ok(JSON.stringify(d.chips.map((c) => c.h)) === '["@charlie-the-tester","@bravo-builder"]', `${w}: @alpha-reviewer replied: only the others' chips remain`, d.chips.map((c) => c.h));
    const tool = await bearer(`/api/rooms/${R}/line`, { method: 'POST', body: JSON.stringify({ text: 'build finished', from: { paneid: pane('bravo-builder') }, tool: { slug: 'probe-tool', for: 'user' } }) });
    await sleep(1500);
    d = await dc();
    ok(tool.status === 200 && d.chips.some((c) => c.h === '@bravo-builder'), `${w}: a tool line is not a reply (status ${tool.status})`, d.chips.map((c) => c.h));
    for (const who of ['bravo-builder', 'charlie-the-tester']) {
      await bearer(`/api/rooms/${R}/line`, { method: 'POST', body: JSON.stringify({ text: `ack from ${who}`, from: { paneid: pane(who) } }) });
      await sleep(1500);
      d = await dc();
      if (who === 'bravo-builder') {
        ok(JSON.stringify(d.chips.map((c) => c.h)) === '["@charlie-the-tester"]', `${w}: @bravo-builder replied: only @charlie-the-tester's chip remains`, d.chips.map((c) => c.h));
      }
    }
    const gone = await pg.evaluate(() => { const b = document.getElementById('deliveryChips'); return { hidden: b.hidden, h: Math.round(b.getBoundingClientRect().height), n: b.children.length }; });
    ok(gone.hidden && gone.h === 0, `${w}: every addressed seat replied: the chip row is gone (no empty row)`, gone);

    await pg.fill('#input', '@echo hello');
    await pg.click('#sendBtn');
    await sleep(1200);
    d = await dc();
    ok(d.shown && JSON.stringify(d.chips.map((c) => c.h)) === '["@echo"]' && /not live/.test(d.chips[0]?.title), `${w}: a newer line brings the row back with its own chips (@echo; its report in the tooltip)`, d.chips);
    rl = await readLine('@echo hello');
    ok(rl.groups['not-live'] === 'not live @echo' && rl.lines === 1, `${w}: a seat with no live pane reads "not live @echo", one compact line`, rl);

    /* [web/room-phone-7b] a SILENT seat drops its chip: delivered, then idle
       for 30 s; held or waiting-on-you keeps it (390 only: real time) */
    if (w === 390) {
      const chipsNow = async () => (await dc()).chips.map((c) => c.h);
      await pg.fill('#input', '@alpha-reviewer @charlie-the-tester silence test');
      await pg.click('#sendBtn');
      await sleep(1200);
      heldGone.add('alpha-reviewer');
      acts.set('alpha-reviewer', 'streaming');
      acts.set('charlie-the-tester', 'idle');
      await sleep(10000);
      let cn = await chipsNow();
      ok(JSON.stringify(cn) === '["@alpha-reviewer","@charlie-the-tester"]', '390: delivered and streaming 10 s: the chip stays (held + idle stays too)', cn);
      acts.set('alpha-reviewer', 'idle');
      await sleep(20000);
      cn = await chipsNow();
      ok(cn.includes('@alpha-reviewer'), '390: idle 20 s: not yet', cn);
      await sleep(13000);
      cn = await chipsNow();
      ok(JSON.stringify(cn) === '["@charlie-the-tester"]', '390: delivered, then idle 30 s: the silent seat\'s chip is gone; the HELD seat keeps its chip', cn);
      await pg.fill('#input', '@charlie-the-tester waiting test');
      await pg.click('#sendBtn');
      await sleep(1200);
      heldGone.add('charlie-the-tester');
      acts.set('charlie-the-tester', 'waiting');
      await sleep(33000);
      cn = await chipsNow();
      ok(JSON.stringify(cn) === '["@charlie-the-tester"]', '390: delivered and WAITING on you for 33 s: the chip stays', cn);
      acts.clear();
      heldGone.clear();
    }

    /* ---- 6. the phone glass ---- */
    const glass = () => pg.evaluate(() => {
      const alpha = (c) => {
        const slash = c.match(/\/\s*([0-9.]+)\s*\)$/);
        if (slash) { return parseFloat(slash[1]); }
        const rgba = c.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([0-9.]+)\)$/);
        return rgba ? parseFloat(rgba[1]) : 1;
      };
      const b = document.querySelector('#line .entry.by-agent > .entry-bubble');
      const u = document.querySelector('#line .entry.by-user > .entry-bubble');
      const cs = getComputedStyle(b);
      const art = document.querySelector('#roomLine > .rc-art');
      const ar = art?.getBoundingClientRect();
      const fact = document.querySelector('#line .entry.by-room') || document.querySelector('.rm-start');
      return {
        cls: document.documentElement.classList.contains('phone-glass'),
        bg: cs.backgroundColor, a: alpha(cs.backgroundColor), ua: alpha(getComputedStyle(u).backgroundColor),
        bf: cs.backdropFilter || cs.webkitBackdropFilter || 'none',
        art: !!art && !!art.querySelector('svg') && ar.width > 20 && getComputedStyle(art).display !== 'none', pane: document.getElementById('roomLine').classList.contains('wm-pane'),
        halo: fact ? getComputedStyle(fact).textShadow : null,
        /* the see-through lift: the time at dim/text 50-50, the @name at L .92 */
        ts: getComputedStyle(b.querySelector('.entry-ts')).color,
        tsLift: (() => { const x = document.createElement('span'); x.style.color = 'color-mix(in srgb, var(--dim) 50%, var(--text))'; document.body.append(x); const c = getComputedStyle(x).color; x.remove(); return c; })(),
        author: (() => { const n = [...document.querySelectorAll('#line .entry.by-agent:not(.same) .entry-author')].pop(); return n ? getComputedStyle(n).color : null; })(),
      };
    });
    let gl = await glass();
    ok(gl.cls && gl.a !== null && Math.abs(gl.a - 0.5) < 0.02 && Math.abs(gl.ua - 0.5) < 0.02 && (gl.bf === 'none' || gl.bf === ''), `${w}: phone glass ON by default: bubble base alpha ${gl.a} / ${gl.ua}, backdrop-filter ${gl.bf} [web/room-phone-7b]`, gl);
    ok(gl.ts === gl.tsLift && /^oklch\(0\.92 /.test(gl.author || ''), `${w}: past 40%, the see-through lift: the time ${gl.ts}, the @name ${gl.author}`, gl);
    ok(gl.art && gl.pane, `${w}: the room art watermark is behind the line`, gl);
    ok(!gl.halo || gl.halo !== 'none', `${w}: text on the line's art wears the halo`, gl.halo);
    /* scroll smoothness: frame intervals while the line scrolls */
    const fr = await pg.evaluate(() => new Promise((res) => {
      const s = document.getElementById('lineScroll');
      s.scrollTop = s.scrollHeight;
      const gaps = [];
      let last = performance.now();
      let n = 0;
      const step = () => {
        const now = performance.now();
        gaps.push(now - last);
        last = now;
        s.scrollTop -= 24;
        if (++n < 60) { requestAnimationFrame(step); } else {
          gaps.sort((x, y) => x - y);
          res({ avg: Math.round(gaps.reduce((x, y) => x + y, 0) / gaps.length), p95: Math.round(gaps[Math.floor(gaps.length * 0.95)]), moved: s.scrollTop < s.scrollHeight - s.clientHeight });
        }
      };
      requestAnimationFrame(step);
    }));
    ok(fr.moved && fr.p95 < 100, `${w}: the glass line scrolls (headless frame gaps: avg ${fr.avg} ms, p95 ${fr.p95} ms)`, fr);
    await pg.evaluate(() => { const s = document.getElementById('lineScroll'); s.scrollTop = s.scrollHeight; });
    await shot(pg, `${w}-glass`);
    await pg.evaluate(() => document.documentElement.classList.remove('phone-glass'));
    await sleep(1300); // room-reply.css eases a bubble's background over .9s
    gl = await glass();
    ok(!gl.cls && gl.a === 1 && (gl.bf === 'none' || gl.bf === '') && gl.ts !== gl.tsLift, `${w}: removing html.phone-glass turns it off (alpha ${gl.a}, ${gl.bf}, no lift)`, gl);
    await pg.evaluate(() => document.documentElement.classList.add('phone-glass'));

    /* ---- 7. the keyboard + an attachment + 12 lines ---- */
    await ctx.close();
    ({ ctx, pg } = await openPhone(w, h));
    await pg.click('#phLine'); // the line shown: the keyboard must still hide it
    await pg.setInputFiles('#attFile', [
      { name: 'screenshot-of-the-room.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') },
      { name: 'notes-for-the-reviewers.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
    ]);
    await sleep(1200);
    const TEXT = Array.from({ length: 12 }, (_, i) => `line ${i + 1} of what I had been typing`).join('\n');
    await pg.fill('#input', TEXT);
    await pg.evaluate((k) => { const i = document.getElementById('input'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); window.__kb(k); }, h - VV);
    await sleep(1400);
    let c = await pg.evaluate(() => window.__caret());
    const tray = await pg.evaluate(() => ({ hdr: Math.round(document.querySelector('.ph-hdr').getBoundingClientRect().height), home: Math.round(document.getElementById('phHome').getBoundingClientRect().height), kb: document.documentElement.classList.contains('kb-up'), tiles: [...document.querySelectorAll('#attTray .att-tile')].map((t) => Math.round(t.getBoundingClientRect().height)), rows: new Set([...document.querySelectorAll('#attTray .att-tile')].map((t) => Math.round(t.getBoundingClientRect().top))).size, strip: getComputedStyle(document.getElementById('phStrip')).display }));
    ok(tray.kb && tray.tiles.length === 2 && tray.tiles.every((x) => x <= 42) && tray.rows === 1 && tray.strip === 'none', `${w}: keyboard up: the tray is one compact row (${tray.tiles}px tiles) and the shown line steps aside`, tray);
    ok(tray.home >= tray.hdr - 1, `${w}: ...and the header is whole, not squeezed (${tray.home} of ${tray.hdr})`, tray);
    ok(c.boxBottom <= c.vvBottom + 1 && c.compose <= c.vvBottom + 1 && c.boxTop >= c.vvTop, `${w}: vv ${VV} + an attachment + 12 lines: the whole text box is inside the visible viewport (${c.boxTop}..${c.boxBottom} in ${c.vvTop}..${c.vvBottom}; max-height ${c.max})`, c);
    ok(c.scrollH > c.clientH && parseFloat(c.max) >= 44, `${w}: ...the box scrolls inside itself (${c.clientH} of ${c.scrollH}), floor 44`, c);
    ok(c.caretBottom <= c.boxBottom + 1 && c.caretTop >= c.boxTop - 1 && c.caretBottom <= c.vvBottom, `${w}: the caret at the end is visible (${c.caretTop}..${c.caretBottom})`, c);
    await shot(pg, `${w}-keyboard`);
    /* the caret in the middle: a selection change scrolls it into view */
    await pg.evaluate(() => { const i = document.getElementById('input'); i.scrollTop = i.scrollHeight; const at = i.value.indexOf('line 3 of'); i.setSelectionRange(at, at); });
    await sleep(300);
    c = await pg.evaluate(() => window.__caret());
    ok(c.caretTop >= c.boxTop - 1 && c.caretBottom <= c.boxBottom + 1, `${w}: moving the caret up (line 3) scrolls it into the box (${c.caretTop}..${c.caretBottom} in ${c.boxTop}..${c.boxBottom})`, c);
    await pg.evaluate(() => { const i = document.getElementById('input'); i.scrollTop = 0; i.setSelectionRange(i.value.length, i.value.length); });
    await pg.keyboard.type(' and more');
    await pg.keyboard.press('Enter');
    await pg.keyboard.type('a thirteenth line');
    await sleep(400);
    c = await pg.evaluate(() => window.__caret());
    ok(c.caretBottom <= c.boxBottom + 1 && c.caretTop >= c.boxTop - 1 && c.boxBottom <= c.vvBottom + 1, `${w}: typing at the end keeps the caret visible and the box above the keys`, c);
    const over = await docOverflow(pg);
    ok(over.sw <= w, `${w}: no sideways overflow with the keyboard up`, over);
    await pg.evaluate(() => { window.__kb(0); document.getElementById('input').blur(); });
    await sleep(900);
    const down = await pg.evaluate(() => ({ kb: document.documentElement.classList.contains('kb-up'), taMax: document.documentElement.style.getPropertyValue('--ta-max'), strip: getComputedStyle(document.getElementById('phStrip')).display, tile: Math.round(document.querySelector('#attTray .att-tile').getBoundingClientRect().height) }));
    ok(!down.kb && down.taMax === '' && down.strip === 'flex' && down.tile === 56, `${w}: keyboard down: the cap is cleared, the tiles are full size, the shown line is back`, down);
    await ctx.close();
  }

  ok(errors.length === 0, 'no page errors', errors.slice(0, 3));
} catch (e) {
  ok(false, `threw: ${e?.stack ?? e}`);
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  if (engine) { engine.kill('SIGKILL'); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* the engine may still hold the db */ }
}
console.log(`\n${failures ? `FAIL ${failures}` : 'PASS'} [${browserName}]`);
process.exit(failures ? 1 : 0);
