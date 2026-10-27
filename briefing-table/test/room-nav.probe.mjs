/* WORKROOM LEVEL 2 IN THE SHELL — room front-end order item 3 (2026-09-25;
 * workrooms.md §2.6, the design system workroom-nav v2: ‹ back · F1 folder chat · lead ·
 * members · A2 add).
 *
 *   node test/room-nav.probe.mjs
 *
 * Runs the same checks TWICE:
 *   - "v24": /aurora/window-chrome/* is served from the design system published dist
 *     (WINDOW_CHROME_DIR, default /srv/code/auriga/dist/window-chrome) by
 *     Playwright request interception. The repo's PIN is not touched (the pin
 *     is vrpc1's); this is how the shell's v24 wiring is proven before the
 *     re-pull lands.
 *   - "pinned": whatever web/aurora/window-chrome holds (21.1 today), which
 *     ignores `room:` so the shell's fallback draws the room line as a tab and
 *     the hub chip goes back up.
 * Plus: without ?rooms=2 a room tab is NOT entered (the flag holds).
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(58), DEAD broker P(59),
 * temp table seeded through the store (test/rooms-routes.seed.ts): no pty, no
 * broker, never Owner's data, childEnv() scrubbed, fabric + NATS off.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(58);
const DEAD_BROKER_PORT = P(59);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-nav-token';
const V24_DIR = process.env.WINDOW_CHROME_DIR || '/srv/code/auriga/dist/window-chrome';

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

/** The strip and the stage as RENDERED. */
const readNav = (p) => p.evaluate(() => {
  const strip = document.querySelector('.hwb-tabs');
  const frames = [...document.querySelectorAll('#stage iframe')];
  const shown = frames.filter((f) => getComputedStyle(f).display !== 'none').map((f) => f.getAttribute('src') || '');
  const chips = strip ? [...strip.querySelectorAll('.hwb-tab[data-tab]')] : [];
  return {
    back: !!strip?.querySelector('.hwb-roomback'),
    add: !!strip?.querySelector('.hwb-roomadd'),
    hub: !!strip?.querySelector('.hwb-tab.is-hub'),
    chips: chips.map((el) => ({
      id: el.dataset.tab,
      name: el.querySelector('.tname')?.textContent || '',
      room: el.classList.contains('is-room'),
      active: el.classList.contains('is-active') || el.getAttribute('aria-selected') === 'true',
      primary: !!el.querySelector('.ring.is-primary'),
      workroom: !!el.querySelector('.ring svg .rg-wbody'),
      ring: el.querySelector('.ring')?.dataset.state || null,
      logo: (el.querySelector('.tlogo')?.innerHTML || '').trim().length > 0,
    })),
    frames: frames.length,
    shown,
    stored: (() => {
      try { return JSON.parse(sessionStorage.getItem('hwb.shell.tabset.v1') || 'null'); } catch { return null; }
    })(),
  };
});

try {
  const stale = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
  if (stale.ok) {
    console.log(` FAIL  :${PORT} is already serving something — a leaked engine from an aborted run?`);
    process.exit(1);
  }
} catch { /* nothing there */ }
for (const p of [PORT, DEAD_BROKER_PORT]) {
  await assertFree(p, 'room-nav.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-nav-'));
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
  const recipe = (id, name, vendor, agent, color) => ({ id, name, projectDir: `/srv/x/${agent}`, vendor, agent, color });
  await seed({
    recipes: [
      recipe('rec-lead', 'Lead Project', 'claude-code', 'leadp', '#3b82f6'),
      { ...recipe('rec-b', 'Bee', 'claude-code', 'bee', '#22c55e'), logo: JSON.stringify({ key: 'audio-editor' }) },
      recipe('rec-c', 'Sea', 'codex-cli', 'sea', null),
      recipe('rec-g', 'Gem', 'gemini-cli', 'gem', null),
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

  /* live rows after boot, then the room: @leadp (lead, live), @bee (live), @sea (never started) */
  const L1 = 'recipe:rec-lead';
  const B1 = 'recipe:rec-b';
  const post = await seed({
    sessions: [
      { paneid: L1, recipe_id: 'rec-lead', vendor: 'claude-code', agent: 'leadp', state: 'live' },
      { paneid: B1, recipe_id: 'rec-b', vendor: 'claude-code', agent: 'bee', state: 'live' },
      { paneid: 'recipe:rec-g', recipe_id: 'rec-g', vendor: 'gemini-cli', agent: 'gem', state: 'dehydrated' },
    ],
    rooms: [{
      name: 'Nav Probe',
      seats: [
        { handle: 'bee', recipe_id: 'rec-b', occupant: B1, policy: 'fresh' }, // position 0, not lead
        { handle: 'leadp', recipe_id: 'rec-lead', occupant: L1 }, // first persistent = LEAD
        { handle: 'sea', recipe_id: 'rec-c' }, // never started
        { handle: 'gem', recipe_id: 'rec-g', occupant: 'recipe:rec-g' }, // dehydrated = restorable
      ],
    }],
  });
  const R = post.rooms[0].id;
  const SEAT = post.rooms[0].seats;
  const ROOM_URL = `/room.html?room=${R}`;
  const shellUrl = (flag) => `${BASE}/app/shell.html?kind=manager&debug=1${flag ? '&rooms=2' : ''}&tabs=${encodeURIComponent('/manager.html')},${encodeURIComponent(ROOM_URL)}`;

  browser = await chromium.launch({ headless: true });

  /* What a pass EXPECTS follows the bundle it actually serves (vrpc1,
     2026-09-25: once the pin reached v26 the "pinned" pass IS level 2), read
     from that bundle's VERSION, never assumed from which pass it is. */
  const bundleVersion = (dir) => {
    try { return Number(readFileSync(join(dir, 'VERSION'), 'utf8').trim()) || 0; } catch { return 0; }
  };
  const PIN_DIR = join(REPO_ROOT, 'web', 'aurora', 'window-chrome');

  async function pass(label, useV24) {
    const ver = bundleVersion(useV24 ? V24_DIR : PIN_DIR);
    const L2 = ver >= 24; // hwbRenderTabs room: ‹ back · F1 · A2
    const PLATE = ver >= 25; // plate-only never-started glyph
    console.log(`    (window-chrome v${ver}: level-2 row ${L2 ? 'expected' : 'NOT expected (fallback)'}, plate-only ${PLATE ? 'expected' : 'not expected'})`);
    console.log(`\n--- ${label} ---`);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    if (useV24) {
      await context.route('**/aurora/window-chrome/**', (route) => {
        const name = new URL(route.request().url()).pathname.split('/aurora/window-chrome/')[1];
        const file = join(V24_DIR, name);
        if (!name || !existsSync(file)) { return route.continue(); }
        const type = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[extname(file)] || 'application/octet-stream';
        return route.fulfill({ status: 200, contentType: type, body: readFileSync(file) });
      });
    }
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    if (process.env.NAV_DEBUG) { page.on('console', (m) => { const t = m.text(); if (process.env.NAV_DEBUG === 'all' || /room|member|hwbRoom|select/i.test(t)) console.log('      [console] ' + t.slice(0, 300)); }); }
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => {
      const f = document.querySelector('form');
      (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
    }, TOKEN);
    await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);

    await page.goto(shellUrl(true), { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    // select the hub first, then ENTER the room by selecting its tab
    await page.evaluate(() => document.querySelector('.hwb-tab.is-hub')?.click());
    await sleep(400);
    let n = await readNav(page);
    const roomChip = n.chips.find((c) => c.workroom);
    ok(!!roomChip && !n.back, 'top level: the room is an ordinary workroom tab, no back control', n.chips);
    await page.click(`.hwb-tab[data-tab="${roomChip?.id}"]`);
    await sleep(3200); // the room page's poll hands the shell its members
    n = await readNav(page);

    const members = n.chips.filter((c) => c.id.startsWith('m:'));
    ok(members.map((c) => c.name).join(',') === '@leadp,@bee,@sea,@gem', 'inside: one tab per seat, LEAD FIRST (not position order)', members.map((c) => c.name));
    const gemTab = members.find((c) => c.name === '@gem');
    const rf = page.frames().find((f) => f.url().includes('/room.html'));
    const gemRoster = await rf.$eval('#roster .seat[data-handle="gem"] .seat-ring', (e) => e.dataset.state).catch(() => null);
    ok(gemTab?.ring === 'restorable' && gemRoster === 'restorable', 'a dehydrated seat is RESTORABLE on its tab AND in the roster (one mapping)', { tab: gemTab?.ring, roster: gemRoster });
    ok(members.find((c) => c.name === '@bee')?.logo, 'an unselected member tab wears its project watermark (session-tab rule)');
    const sea = await rf.evaluate(() => {
      const li = document.querySelector('#roster .seat[data-handle="sea"]');
      return { ring: !!li?.querySelector('.seat-ring'), plate: li?.querySelector('.seat-plate')?.dataset.state || null, mark: !!li?.querySelector('.seat-mark') };
    });
    ok(!sea.ring, 'a never-started seat has NO ring in the roster (§4.4 as amended)', sea);
    if (PLATE) {
      ok(sea.plate === 'none', `v${ver}: it wears the plate-only brand plate`, sea);
    } else {
      ok(sea.mark && !sea.plate, `v${ver}: the plain mark fallback`, sea);
    }
    ok(members[0]?.id === `m:${SEAT.leadp}`, '...keyed by seat id', members[0]?.id);
    ok(n.shown.length === 1 && n.shown[0].includes('/room.html'), 'the landing is the room line (one click still shows it)', n.shown);
    ok(n.stored?.tabs?.length === 2, 'the window\'s tab set is still 2 (manager + room): members are not window tabs', n.stored?.tabs?.length);
    if (L2) {
      const chat = n.chips.find((c) => c.room);
      ok(n.back && !n.hub, 'level 2: ‹ back replaces the hub chip');
      ok(!!chat && chat.name === 'Nav Probe' && chat.active, 'level 2: the F1 folder-chat tab carries the room name and is selected', chat);
      ok(n.add, 'level 2: A2 add replaces the +');
      ok(members[0]?.primary && !members[1]?.primary && !members[2]?.primary, 'level 2: B5 gold edge on the lead only', members.map((m) => m.primary));
    } else {
      const chat = n.chips.find((c) => c.id === 'chat');
      ok(!!chat && chat.workroom && chat.active, 'fallback: the room line is drawn as a workroom tab in front (fallback)', chat);
      ok(n.hub, 'fallback: the hub chip stays, as the way back');
    }

    // a LIVE member opens its session page in a member frame
    if (process.env.NAV_DEBUG) {
      console.log('      [dbg] ' + JSON.stringify(await page.evaluate((id) => {
        const el = document.querySelector(`.hwb-tab[data-tab="m:${id}"]`);
        const r = el?.getBoundingClientRect();
        const top = r ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
        return { found: !!el, rect: r && [r.x, r.y, r.width, r.height], topIsChip: !!top && el.contains(top), top: top && top.className };
      }, SEAT.bee)));
    }
    await page.click(`.hwb-tab[data-tab="m:${SEAT.bee}"]`);
    await sleep(900);
    if (process.env.NAV_DEBUG) {
      console.log((await page.evaluate(() => document.getElementById('log')?.textContent || '(no #log)')).split('\n').slice(-14).map((l) => '      [shell] ' + l).join('\n'));
    }
    n = await readNav(page);
    /* the engine's occupant.url (§2.9 soloPathFor): a project's PRIMARY pane
       (recipe:<id>) carries no &pane=; any other pane names itself */
    const beeUrl = n.shown[0] || '';
      /* a room's own framed view of a seat carries &roomframe=1 (883e35f: not a
       window); allow it at the end */
    const beeBare = beeUrl.replace(/[?&]roomframe=1$/, '');
    ok(n.shown.length === 1 && beeUrl.includes('/solo.html?recipe=rec-b')
      && (beeBare.endsWith('/solo.html?recipe=rec-b') || beeUrl.includes(encodeURIComponent(B1))),
      'a live member tab shows that session\'s page', n.shown);
    ok(n.stored?.tabs?.length === 2, '...and still adds nothing to the window\'s tab set', n.stored?.tabs?.length);
    const framesAfterBee = n.frames;

    // a member with nothing live: the room line, filtered to that seat
    await page.click(`.hwb-tab[data-tab="m:${SEAT.sea}"]`);
    await sleep(700);
    n = await readNav(page);
    ok(n.shown.length === 1 && n.shown[0].includes('/room.html'), 'a never-started member tab shows the room line', n.shown);
    const roomFrame = page.frames().find((f) => f.url().includes('/room.html'));
    /* nav v3: the room page SELECTS that seat in its own column (a
       never-started seat shows its panel with Start), no longer a filter */
    const sel = await roomFrame.evaluate(() => document.querySelector('#roster .seat.sel')?.dataset.seatId ?? null);
    ok(sel === SEAT.sea, '...with that seat selected in the room\'s column', sel);

    // back to bee: the SAME frame, not a second one
    await page.click(`.hwb-tab[data-tab="m:${SEAT.bee}"]`);
    await sleep(500);
    n = await readNav(page);
    ok(n.frames === framesAfterBee, 'returning to a member reuses its frame', { before: framesAfterBee, now: n.frames });

    if (L2) {
      // A2 opens Add member on the room page
      await page.click('.hwb-roomadd');
      await sleep(900);
      n = await readNav(page);
      /* A2 = the room's one add button = the Assemble modal, room fixed
         (the design notes §3.1) */
      const addOpen = await roomFrame.isVisible('.ras-scrim');
      ok(n.shown[0]?.includes('/room.html') && addOpen, 'A2 shows the room line with the Assemble modal open (room fixed)', { shown: n.shown, addOpen });
      await page.keyboard.press('Escape');
      // ‹ back
      await page.click('.hwb-roomback');
    } else {
      await page.evaluate(() => document.querySelector('.hwb-tab.is-hub')?.click());
    }
    await sleep(700);
    n = await readNav(page);
    ok(!n.back && n.hub && !n.chips.some((c) => c.id.startsWith('m:')), 'back: the top level returns (hub, no member tabs)', n.chips);
    ok(n.shown.length === 1 && n.shown[0].includes('/manager.html'), '...on the tab you came from (the manager)', n.shown);
    const lead = n.chips.find((c) => c.workroom);
    ok(!!lead, '...and the room tab is still there');
    /* loudest member: leadp + bee are live with no pty (activity disconnected
       = ALERT), gem restorable, sea none → alert outranks the rest */
    ok(lead?.ring === 'alert', 'the room tab shows its LOUDEST member (hwbRingLead), not idle', lead?.ring);

    ok(errors.length === 0, 'no page errors in the shell', errors.slice(0, 3));
    await context.close();
  }

  if (existsSync(join(V24_DIR, 'hwb-chrome.js'))) {
    await pass('design-system dist (v24+ level 2, v25 plate), via interception', true);
  } else {
    /* Not a failure of the shell: there is simply no the design system dist on this
       machine to serve (vrpc1, 2026-09-25: absent on Windows). Say so. */
    console.log(`\n  SKIP  design-system dist pass: no window-chrome at ${V24_DIR} (set WINDOW_CHROME_DIR to a design-system clone's dist/window-chrome)`);
  }
  await pass('pinned bundle (fallback)', false);

  /* THE FLAG HOLDS: without ?rooms=2, selecting a room tab is just a tab */
  console.log('\n--- no flag ---');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pg = await ctx.newPage();
  await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await pg.evaluate((t) => {
    const f = document.querySelector('form');
    (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
  }, TOKEN);
  await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);
  await pg.goto(shellUrl(false), { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  let n = await readNav(pg);
  const rc = n.chips.find((c) => c.workroom);
  await pg.click(`.hwb-tab[data-tab="${rc?.id}"]`);
  await sleep(3000);
  n = await readNav(pg);
  ok(!n.chips.some((c) => c.id.startsWith('m:')) && n.hub, 'without ?rooms=2 a room tab is NOT entered', n.chips.map((c) => c.id));
  await ctx.close();
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
