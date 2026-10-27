/**
 * THE ROOM PAGE in a real browser (the design notes §4 T6, §4.4, §6
 * "Roster renders every seat state") [ticket]. NOT in `npm test`: it needs
 * Playwright's bundled headless Chromium. Run it by hand:
 *
 *   node test/room-roster.probe.mjs
 *
 * OWN scratch engine on P(50) with a DEAD broker port P(51) (nothing may listen
 * there, so no pty is ever opened), a temp mapping db, legacy identity with a
 * known bearer written to a temp token file. Every child env is childEnv().
 * Never :7420/:7430/:8200/:8201/:8204, never the real data dir, never a row in
 * Owner's manager (trap 8). The temp dir is removed.
 *
 * SEAT STATES WITHOUT A PTY (§6 seeding note). Dehydrated / killed rows and the
 * room are written through the STORE before boot (boot reconcile sweeps only
 * `live`), live rows after boot, by test/rooms-routes.seed.ts. A `live` seat
 * (status `live` = live AND attached) needs a viewer on a real pty, which this
 * probe deliberately does not have; the engine side of that derivation is
 * rooms-routes' business. So the `live` RENDER is checked on a second page whose
 * GET /api/rooms/:id and room.state are rewritten in flight to mark one parked
 * seat attached — the page renders `status`, it never derives it.
 *
 * Every visual assertion reads COMPUTED style (trap 9), never a control's value.
 *
 * PUSH (§2.3) is guarded by a capability check: a raw /pty socket sends
 * `room.subscribe` and waits for `room.subscribed`. An engine without T5 answers
 * nothing, and the push assertions print a loud SKIPPED line instead of passing
 * or failing. The page's own degrade path (the "live push unavailable" note) is
 * asserted in either case.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { P, assertFree, childEnv, windowCookie, roomUserWrite } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(50); // scratch engine — port table in test/_scratch.mjs
const DEAD_BROKER_PORT = P(51); // nothing may listen
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'room-roster-probe-token';
const PAGE = 50; // the page's newest-N (web/room.js)

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];
function ok(cond, msg, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  ✗ ${msg}${detail !== undefined ? `\n      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* the line filter is the room bar's menu now (the design system room-filter-v1): pick a
   seat choice / toggle a kind through it, then close it */
const pickWho = (f, who) => f.evaluate((w) => {
  document.getElementById('filterBtn').click();
  document.querySelector(`#filterMenu [data-who="${CSS.escape(w)}"]`).click();
  document.getElementById('filterBtn').click();
}, who);
const toggleKind = (f, k) => f.evaluate((kind) => {
  document.getElementById('filterBtn').click();
  document.querySelector(`#filterMenu [data-kind="${kind}"]`).click();
  document.getElementById('filterBtn').click();
}, k);
async function until(fn, ms = 6000, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) {
      return v;
    }
    await sleep(step);
  }
}

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
  try {
    body = await res.json();
  } catch {
    /* not json */
  }
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

/** Does this engine answer room.subscribe? (T5.) A raw socket, bearer-authed. */
function pushCapable(roomId) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${HOST}:${PORT}/pty`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const done = (v) => {
      clearTimeout(t);
      try {
        ws.close();
      } catch {
        /* closing */
      }
      resolve(v);
    };
    const t = setTimeout(() => done(false), 2500);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'room.subscribe', rooms: [roomId] })));
    ws.on('message', (d) => {
      try {
        const m = JSON.parse(String(d));
        if (m.type === 'room.subscribed') {
          done(Array.isArray(m.rooms) && m.rooms.includes(roomId));
        }
      } catch {
        /* not json */
      }
    });
    ws.on('error', () => done(false));
  });
}

/** What the page shows, read from the DOM with COMPUTED style. */
async function readRoster(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      if (!el) {
        return false;
      }
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    };
    return [...document.querySelectorAll('#roster .seat:not(.is-room)')].map((li) => {
      const ring = li.querySelector('.seat-ring');
      return {
        handle: li.dataset.handle,
        status: li.dataset.status,
        visible: vis(li),
        statusText: li.querySelector('.seat-status')?.textContent ?? null,
        statusVisible: vis(li.querySelector('.seat-status')),
        ring: !!ring,
        ringVisible: vis(ring),
        ringSvg: !!ring?.querySelector('svg'),
        ringTitle: ring?.title ?? null,
        /* the brand mark is the plain .seat-mark, the ring's plate, or (window-
           chrome v25+, never-started/empty) the plate-only .seat-plate */
        mark: vis(li.querySelector('.seat-mark')) || vis(ring) || vis(li.querySelector('.seat-plate')),
        nudge: vis(li.querySelector('.seat-nudge')),
        /* nav v3: ONE status line; a transient policy / pool rides on it, and
           the full policy words are the row's tooltip */
        policy: li.title || null,
        meta: li.querySelector('.seat-meta')?.textContent ?? null,
        metaVisible: vis(li.querySelector('.seat-meta')),
        lead: li.classList.contains('is-lead'),
      };
    });
  });
}

async function readLine(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('#line .entry')].map((li) => ({
      id: Number(li.dataset.id),
      kind: li.dataset.kind,
      authorSeat: li.dataset.authorSeat,
      targetSeat: li.dataset.targetSeat,
      body: li.querySelector('.entry-body')?.textContent ?? '',
      display: getComputedStyle(li).display,
    })),
  );
}

async function allIds(roomId) {
  const r = await call(`/api/rooms/${roomId}/line?limit=1000`);
  return (r.body?.entries ?? []).map((e) => e.id);
}

/* the Send button, not Enter: on a phone Enter is a new line (Owner 2026-09-27) */
async function typeAndSend(page, text) {
  await page.fill('#input', text);
  await page.click('#sendBtn');
}

async function run() {
  try {
    const stale = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
    if (stale.ok) {
      throw new Error(`:${PORT} is already serving something — a leaked engine from an aborted run?`);
    }
  } catch (e) {
    if (String(e?.message ?? '').includes('already serving')) {
      throw e;
    }
  }
  for (const p of [PORT, DEAD_BROKER_PORT]) {
    await assertFree(p, 'room-roster.probe.mjs');
  }

  /* The bundled browser first: if it is missing, say so and FAIL loudly rather
     than report a pass with nothing checked. */
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    throw new Error(`Playwright's bundled Chromium could not launch (run \`npx playwright install chromium\`): ${e.message.split('\n')[0]}`);
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-roster-'));
  const dbPath = join(tmpDir, 'mapping.db');
  let engine = null;
  let engineLog = '';
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], {
      HARBOR_WB_TABLE: dbPath,
      HARBOR_WB_IDENTITY: 'legacy',
    });
    if (r.code !== 0) {
      throw new Error(`seed failed: ${r.err}`);
    }
    return JSON.parse(r.out.trim().split('\n').pop());
  };

  try {
    /* ------------------------------------------------ seed, before boot ---- */
    const recipe = (id, name, dir, vendor, agent) => ({ id, name, projectDir: dir, vendor, agent });
    const HA1 = 'recipe:rec-ha#1';
    const BARN8 = 'recipe:rec-barn#8';
    const BARN9 = 'recipe:rec-barn#9';
    const pre = await seed({
      recipes: [
        recipe('rec-auriga', 'Auriga', '/srv/x/auriga', 'claude-code', 'auriga'),
        recipe('rec-barn', 'Kiosk', '/srv/x/kiosk', 'cli-manager', 'kiosk'),
        recipe('rec-ha', 'Home Operations', '/srv/x/home-ops', 'claude-code', 'home-ops'),
        recipe('rec-scout', 'Scout', '/srv/x/scout', 'claude-code', 'scout'),
      ],
      sessions: [
        { paneid: HA1, recipe_id: 'rec-ha', vendor: 'claude-code', agent: 'home-ops', state: 'dehydrated' },
        { paneid: BARN8, recipe_id: 'rec-barn', vendor: 'cli-manager', agent: 'kiosk', state: 'killed' },
        { paneid: BARN9, recipe_id: 'rec-barn', vendor: 'cli-manager', agent: 'kiosk', state: 'killed' },
      ],
      rooms: [
        {
          name: 'Probe Room',
          seats: [
            { handle: 'scout', recipe_id: 'rec-scout', policy: 'fresh' }, // position 0, non-persistent: never lead
            { handle: 'ha', recipe_id: 'rec-ha', occupant: HA1 }, // position 1: the first persistent seat = LEAD; dehydrated
            { handle: 'ghost', recipe_id: 'rec-auriga' }, // never-started
            { handle: 'gone', recipe_id: 'rec-barn', occupant: BARN8, thenEmpty: true }, // empty
            { handle: 'dead', recipe_id: 'rec-barn', occupant: BARN9 }, // ended
          ],
        },
      ],
    });
    const room = pre.rooms[0];
    const R = room.id;

    console.log(`booting scratch engine :${PORT} (dead broker :${DEAD_BROKER_PORT}, db ${dbPath})`);
    /* --import the tsx LOADER, not the CLI: the CLI re-spawns node, and killing
       it would orphan the engine on the port. */
    const loaderArg = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
    engine = spawn(process.execPath, ['--import', loaderArg, join('src', 'server', 'index.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({
        HARBOR_WB_PORT: String(PORT),
        HARBOR_WB_HOST: HOST,
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
    const up = await until(() => fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false), 30000, 250);
    if (!up) {
      throw new Error(`engine did not come up\n${engineLog.slice(-1500)}`);
    }

    /* ------------------------------------------ live rows + seats, after boot ---- */
    const A1 = 'recipe:rec-auriga#1';
    const A2 = 'recipe:rec-auriga#2';
    await seed({
      sessions: [
        { paneid: A1, recipe_id: 'rec-auriga', vendor: 'claude-code', agent: 'auriga', state: 'live' },
        { paneid: A2, recipe_id: 'rec-auriga', vendor: 'claude-code', agent: 'auriga', state: 'live' },
      ],
    });
    const sA1 = await call(`/api/rooms/${R}/seats`, { json: { recipe_id: 'rec-auriga', occupant: A1 } });
    const sA2 = await call(`/api/rooms/${R}/seats`, { json: { recipe_id: 'rec-auriga', occupant: A2 } });
    const sPool = await call(`/api/rooms/${R}/seats`, { json: { project: 'swarm', handle: 'sketcher-swarm', policy: 'pool', pool_size: 3 } });
    if (sA1.status !== 200 || sA2.status !== 200 || sPool.status !== 200) {
      throw new Error(`seat setup failed: ${JSON.stringify([sA1.body, sA2.body, sPool.body])}`);
    }
    // Enough line to page: each un-addressed chat goes to the (dehydrated) lead = chat + delivery.
    for (let i = 1; i <= 40; i++) {
      await call(`/api/rooms/${R}/line`, { json: { text: `seed message ${i}` } });
    }

    const view = (await call(`/api/rooms/${R}`)).body;
    const byH = Object.fromEntries(view.seats.map((s) => [s.handle, s]));
    console.log('\n[preconditions — the engine view the page will render]');
    ok(view.room.lead_seat === byH.ha.id && byH.ha.position !== 0, 'the lead is @ha and its position is NOT 0', { lead: view.room.lead_seat, position: byH.ha.position });
    const wantStatus = { scout: 'never-started', ha: 'dehydrated', ghost: 'never-started', gone: 'empty', dead: 'ended', auriga: 'parked', auriga2: 'parked', 'sketcher-swarm': 'never-started' };
    ok(
      Object.entries(wantStatus).every(([h, s]) => byH[h]?.status === s),
      'seeded seats carry the intended derived statuses',
      Object.fromEntries(view.seats.map((s) => [s.handle, s.status])),
    );
    ok(byH.auriga2?.handle_named === 0, '@auriga2 is an unnamed placeholder (handle_named=0)');
    const engineIds = await allIds(R);
    ok(engineIds.length > PAGE * 1.5, `the line holds more than one page (${engineIds.length} entries)`);

    /* ------------------------------------------------------------ page A ---- */
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => {
      const f = document.querySelector('form');
      (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
    }, TOKEN);
    await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
    ok(!page.url().includes('/login'), 'signed in to the scratch engine');

    // Intercept every POST to the line: the body is the claim under test.
    const posted = [];
    await page.route(
      (u) => /^\/api\/rooms\/[^/]+\/line$/.test(u.pathname),
      async (route) => {
        const req = route.request();
        if (req.method() === 'POST') {
          try {
            posted.push(JSON.parse(req.postData() ?? 'null'));
          } catch {
            posted.push(req.postData());
          }
        }
        await route.continue();
      },
    );
    // A transparent /pty relay, so the probe can FORCE the page's socket closed.
    const sockets = [];
    await page.routeWebSocket(
      (u) => u.pathname === '/pty',
      (ws) => {
        const server = ws.connectToServer();
        const conn = { ws, server, subscribes: [] };
        // Page -> engine is forwarded by hand so each connection's room.subscribe frames are counted.
        ws.onMessage((m) => {
          try {
            const j = JSON.parse(String(m));
            if (j.type === 'room.subscribe') {
              conn.subscribes.push(j.rooms);
            }
          } catch {
            /* not json */
          }
          server.send(m);
        });
        sockets.push(conn);
      },
    );

    await page.goto(`${BASE}/room.html?room=${encodeURIComponent(R)}`, { waitUntil: 'domcontentloaded' });
    await until(() => page.evaluate(() => document.querySelectorAll('#roster .seat:not(.is-room)').length > 0 && document.querySelectorAll('#line .entry').length > 0));

    console.log('\n[roster — one row per active seat, lead first, every state, on computed style]');
    let rows = await readRoster(page);
    ok(rows.length === view.seats.length, `one row per active seat (${rows.length} rows, ${view.seats.length} seats)`);
    ok(new Set(rows.map((r) => r.handle)).size === rows.length, 'no seat drawn twice');
    ok(rows.every((r) => r.visible), 'every row is displayed');
    ok(rows[0]?.handle === 'ha' && rows[0].lead, 'the lead (@ha, position 1) is the FIRST row', rows.map((r) => r.handle));
    for (const r of rows) {
      const glyphed = !['never-started', 'empty'].includes(r.status);
      ok(r.status === wantStatus[r.handle], `@${r.handle}: row status ${r.status}`);
      ok(r.statusVisible && !!r.statusText, `@${r.handle}: a visible TEXT status ("${r.statusText}")`);
      if (glyphed) {
        ok(r.ringVisible && r.ringSvg, `@${r.handle} (${r.status}): a ring is drawn`, r);
      } else {
        ok(!r.ring, `@${r.handle} (${r.status}): NO ring — text only`, r);
      }
      ok(r.mark, `@${r.handle}: a brand mark is shown`);
    }
    ok(/nobody watching/.test(rows.find((r) => r.handle === 'auriga2')?.ringTitle ?? ''), 'a parked seat\'s ring says nobody is watching', rows.find((r) => r.handle === 'auriga2')?.ringTitle);
    ok(/restorable/.test(rows.find((r) => r.handle === 'ha')?.ringTitle ?? ''), 'a dehydrated seat\'s ring says restorable');
    const unnamed = new Set(view.seats.filter((s) => !s.handle_named).map((s) => s.handle));
    ok(unnamed.size > 0 && rows.every((r) => r.nudge === unnamed.has(r.handle)), 'the "name me" nudge shows exactly on handle_named=0 seats', { unnamed: [...unnamed], nudged: rows.filter((r) => r.nudge).map((r) => r.handle) });
    const scout = rows.find((r) => r.handle === 'scout');
    ok(scout?.metaVisible && /· fresh/.test(scout.meta ?? '') && /forgets by design/.test(scout.policy ?? ''), `a non-persistent seat says so: "${scout?.meta}" / "${scout?.policy}"`);
    const ha = rows.find((r) => r.handle === 'ha');
    ok(!/fresh|pool/.test(ha?.meta ?? '') && /persistent/.test(ha?.policy ?? ''), 'a persistent seat does not (the tooltip says persistent)', ha);
    const pools = rows.filter((r) => r.handle === 'sketcher-swarm');
    ok(pools.length === 1 && /pool ×3/.test(pools[0].meta ?? ''), `a pool seat is ONE row with its count ("${pools[0]?.meta}")`);

    console.log('\n[line — newest-N, back paging, keyed by id]');
    let line = await readLine(page);
    const newest = engineIds.slice(-PAGE);
    ok(JSON.stringify(line.map((e) => e.id)) === JSON.stringify(newest), `the newest ${PAGE} entries, in id order`);
    await page.click('#olderBtn');
    await until(async () => (await readLine(page)).length > PAGE);
    line = await readLine(page);
    const ids = line.map((e) => e.id);
    ok(new Set(ids).size === ids.length, 'back paging adds no duplicate');
    ok(JSON.stringify(ids) === JSON.stringify(engineIds.slice(-ids.length)) && ids.length === Math.min(PAGE * 2, engineIds.length), `back paging extends the line with no gap (${ids.length} entries)`);
    while (!(await page.evaluate(() => getComputedStyle(document.getElementById('olderBtn')).display === 'none'))) {
      await page.click('#olderBtn');
      await sleep(300);
    }
    line = await readLine(page);
    ok(JSON.stringify(line.map((e) => e.id)) === JSON.stringify(engineIds), 'paged back to the start: the page holds the whole line, once each');
    ok(await page.evaluate(() => getComputedStyle(document.getElementById('lineStart')).display !== 'none'), 'and says "start of the line"');

    console.log('\n[filters hide via display:none]');
    await toggleKind(page, 'delivery');
    line = await readLine(page);
    const deliveries = line.filter((e) => e.kind === 'delivery');
    ok(deliveries.length > 0 && deliveries.every((e) => e.display === 'none'), `kind filter: every delivery entry is display:none (${deliveries.length})`);
    ok(line.filter((e) => e.kind !== 'delivery').every((e) => e.display !== 'none'), 'and every other kind still shows');
    await toggleKind(page, 'delivery');
    await pickWho(page, byH.ha.id);
    line = await readLine(page);
    const mine = (e) => e.authorSeat === byH.ha.id || e.targetSeat === byH.ha.id;
    ok(line.some(mine) && line.filter(mine).every((e) => e.display !== 'none'), 'seat filter: entries by or to @ha show');
    ok(line.filter((e) => !mine(e)).length > 0 && line.filter((e) => !mine(e)).every((e) => e.display === 'none'), 'and every other entry is display:none');
    ok((await page.evaluate(() => document.querySelectorAll('#line .entry').length)) === engineIds.length, 'filtering removed nothing from the DOM');
    await pickWho(page, '');

    console.log('\n[input — raw text to the engine; refusal, help, confirm]');
    posted.length = 0;
    await typeAndSend(page, '/frobnicate');
    await until(() => page.evaluate(() => getComputedStyle(document.getElementById('reply')).display !== 'none'));
    const reply = await page.evaluate(() => {
      const el = document.getElementById('reply');
      return { cls: el.className, text: el.textContent, shown: getComputedStyle(el).display !== 'none' };
    });
    ok(reply.shown && /is-refused/.test(reply.cls) && reply.text.length > 0, `an unknown command's refusal is rendered: "${reply.text}"`);
    ok(posted.length === 1 && JSON.stringify(Object.keys(posted[0] ?? {})) === '["text"]' && posted[0].text === '/frobnicate', 'the POST body is exactly {text} — raw, no author, no target', posted);
    ok((await allIds(R)).length === engineIds.length, 'a refusal wrote nothing to the line');

    posted.length = 0;
    await typeAndSend(page, 'hello from the page @nobody-parses-this-here');
    await until(async () => (await readLine(page)).some((e) => e.body.startsWith('hello from the page')));
    ok((await readLine(page)).some((e) => e.body === 'hello from the page @nobody-parses-this-here'), 'a chat lands on the line verbatim');
    ok(posted.length === 1 && !('author' in posted[0]) && !('target' in posted[0]) && !('from' in posted[0]), 'and its POST carried no author / target / from', posted);

    const commands = (await call('/api/rooms/commands')).body.commands;
    await typeAndSend(page, '/help');
    await until(() => page.evaluate(() => getComputedStyle(document.getElementById('help')).display !== 'none'));
    const helpRows = await page.evaluate(() => [...document.querySelectorAll('#help .rm-verb')].filter((r) => getComputedStyle(r).display !== 'none').length);
    ok(helpRows === commands.length, `/help renders the verb table from GET /api/rooms/commands (${helpRows}/${commands.length})`);

    posted.length = 0;
    const before = (await allIds(R)).length;
    await typeAndSend(page, '/remove @dead');
    await until(() => page.evaluate(() => /is-confirm/.test(document.getElementById('reply').className)));
    const confirmShown = await page.evaluate(() => {
      const b = document.querySelector('#reply .rm-confirm');
      return !!b && getComputedStyle(b).display !== 'none' && getComputedStyle(document.getElementById('reply')).display !== 'none';
    });
    ok(confirmShown, 'a /remove answers with a prompt and a Confirm button');
    ok((await allIds(R)).length === before, 'nothing written before the confirm');
    await page.click('#reply .rm-confirm');
    await until(async () => !(await readRoster(page)).some((r) => r.handle === 'dead'));
    ok(!(await readRoster(page)).some((r) => r.handle === 'dead'), 'Confirm removes the seat from the roster');
    ok(posted.length === 2 && posted[1].text === '/remove @dead' && typeof posted[1].confirm === 'string' && JSON.stringify(Object.keys(posted[1])) === '["text","confirm"]', 'the Confirm re-POSTs the same text with confirm:<token>', posted);
    const afterIds = await allIds(R);
    ok(afterIds.length === before + 2, 'the confirmed command wrote its command + fact entries');
    ok(await until(async () => (await readLine(page)).some((e) => e.id === afterIds.at(-1))), 'and they are on the page');

    console.log('\n[@-completion — the active handles, including a renamed one]');
    // Rename from OUTSIDE the page: it learns by room.state push or the 2.5 s poll.
    await call(`/api/rooms/${R}/line`, { json: { text: '/rename @auriga2 to @auriga-two' } });
    ok(await until(async () => (await readRoster(page)).some((r) => r.handle === 'auriga-two'), 7000), 'a rename made elsewhere reaches the roster');
    const expected = (await readRoster(page)).map((r) => r.handle);
    await page.fill('#input', '');
    await page.focus('#input');
    await page.keyboard.type('ping @');
    await until(() => page.evaluate(() => getComputedStyle(document.getElementById('complete')).display !== 'none'));
    const offered = await page.evaluate(() =>
      [...document.querySelectorAll('#complete .rm-opt')].filter((o) => getComputedStyle(o).display !== 'none').map((o) => o.dataset.handle),
    );
    ok(JSON.stringify(offered) === JSON.stringify(expected), '@ offers exactly the active seat handles', { offered, expected });
    ok(offered.includes('auriga-two') && !offered.includes('auriga2') && !offered.includes('dead'), 'including the renamed one, not its old name, not a removed seat');
    await page.keyboard.type('auriga-t');
    await page.keyboard.press('Tab');
    ok((await page.inputValue('#input')) === 'ping @auriga-two ', 'Tab accepts the completion');
    await page.fill('#input', '');

    console.log('\n[live push (§2.3)]');
    const capable = await pushCapable(R);
    const pushState = await until(() => page.evaluate(() => (document.body.dataset.push !== 'pending' ? document.body.dataset.push : null)), 5000);
    if (!capable) {
      skipped++;
      console.log('  !!! SKIPPED (push: engine has no room.subscribe yet) — the push assertions did not run');
      ok(pushState === 'unavailable', 'with no push, the page degrades to polling', pushState);
      ok(await page.evaluate(() => getComputedStyle(document.getElementById('pushNote')).display !== 'none'), 'and shows the "live push unavailable" note');
      // Degraded is not frozen: an entry written elsewhere arrives by the since= poll.
      await call(`/api/rooms/${R}/line`, { json: { text: '@ghost poll-probe-one' } });
      ok(await until(async () => (await readLine(page)).some((e) => e.body === '@ghost poll-probe-one'), 6000), 'and polling still brings in an entry posted elsewhere');
      const lp = (await readLine(page)).map((e) => e.id);
      ok(new Set(lp).size === lp.length && JSON.stringify(lp) === JSON.stringify(await allIds(R)), 'polled line: no gap, no duplicate');
      ok(sockets.length > 0 && sockets.every((s) => JSON.stringify(s.subscribes) === JSON.stringify([[R]])), 'the page still sent room.subscribe on its socket open', sockets.map((s) => s.subscribes));
    } else {
      ok(pushState === 'live', 'the engine answered room.subscribe: the page is on live push', pushState);
      ok(await page.evaluate(() => getComputedStyle(document.getElementById('pushNote')).display === 'none'), 'and shows no degrade note');
      await call(`/api/rooms/${R}/line`, { json: { text: '@ghost push-probe-one' } });
      // In live mode the page does NOT poll the line, so arriving is the push.
      ok(await until(async () => (await readLine(page)).some((e) => e.body === '@ghost push-probe-one'), 2000), 'a line entry posted elsewhere appears without a reload');
      const conns = sockets.length;
      // Force the socket closed, write while it is down, and let the page reconnect.
      for (const s of sockets) {
        await s.ws.close().catch(() => {});
        await s.server.close().catch(() => {});
      }
      for (const n of [1, 2, 3]) {
        await call(`/api/rooms/${R}/line`, { json: { text: `@ghost gap-${n}` } });
      }
      ok(await until(() => sockets.length > conns, 6000), 'the page reopened its socket after the forced close');
      const gapShown = await until(async () => {
        const l = await readLine(page);
        return [1, 2, 3].every((n) => l.some((e) => e.body === `@ghost gap-${n}`));
      }, 6000);
      ok(gapShown, 'the entries written while the socket was down were backfilled');
      await sleep(1000);
      const l = (await readLine(page)).map((e) => e.id);
      const truth = await allIds(R);
      ok(new Set(l).size === l.length, 'no duplicate after the reconnect');
      ok(JSON.stringify(l) === JSON.stringify(truth), 'no gap: the page holds exactly the engine\'s line');
      ok(
        sockets.length > 1 && sockets.every((s) => s.subscribes.length === 1 && JSON.stringify(s.subscribes[0]) === JSON.stringify([R])),
        `room.subscribe was sent on EVERY socket open, once each (${sockets.length} sockets)`,
        sockets.map((s) => s.subscribes),
      );
      ok(await until(() => page.evaluate(() => document.body.dataset.push === 'live'), 5000), 'the reopened socket is back on live push');
      await call(`/api/rooms/${R}/line`, { json: { text: '@ghost push-after-reconnect' } });
      ok(await until(async () => (await readLine(page)).some((e) => e.body === '@ghost push-after-reconnect'), 2000), 'a push arrives on the NEW socket (the re-subscribe took)');
    }

    /* ------------------------------------------------------------ page B ---- */
    console.log('\n[live seat render + lead first against a shuffled order (rewritten in flight)]');
    const ctxB = await browser.newContext({ viewport: { width: 1200, height: 800 }, storageState: await context.storageState() });
    const pageB = await ctxB.newPage();
    pageB.on('pageerror', (e) => pageErrors.push(e.message));
    /* The engine cannot report `live` (= attached) without a viewer on a real
       pty. Mark @the design system attached and REVERSE the seat order (lead last), in
       both the GET and any room.state push. */
    const rewrite = (seats) =>
      [...seats]
        .map((s) => (s.handle === 'auriga' && s.occupant ? { ...s, status: 'live', occupant: { ...s.occupant, activity: 'idle', attached: true } } : s))
        .reverse();
    await pageB.route(
      (u) => u.pathname === `/api/rooms/${R}`,
      async (route) => {
        const res = await route.fetch();
        const j = await res.json();
        await route.fulfill({ response: res, json: { ...j, seats: rewrite(j.seats) } });
      },
    );
    await pageB.routeWebSocket(
      (u) => u.pathname === '/pty',
      (ws) => {
        const server = ws.connectToServer();
        server.onMessage((m) => {
          try {
            const j = JSON.parse(String(m));
            if (j.type === 'room.state' && Array.isArray(j.seats)) {
              ws.send(JSON.stringify({ ...j, seats: rewrite(j.seats) }));
              return;
            }
          } catch {
            /* not json */
          }
          ws.send(m);
        });
      },
    );
    await pageB.goto(`${BASE}/room.html?room=${encodeURIComponent(R)}`, { waitUntil: 'domcontentloaded' });
    await until(() => pageB.evaluate(() => document.querySelectorAll('#roster .seat:not(.is-room)').length > 0));
    const rowsB = await readRoster(pageB);
    ok(rowsB[0]?.handle === 'ha', 'the lead is still first when the engine order puts it last', rowsB.map((r) => r.handle));
    const live = rowsB.find((r) => r.handle === 'auriga');
    ok(live?.status === 'live' && live.ringVisible && live.ringSvg, 'a live seat renders with a ring');
    ok(/watching/.test(live?.ringTitle ?? '') && !/nobody watching/.test(live?.ringTitle ?? ''), `and its ring says someone is watching ("${live?.ringTitle}")`);
    ok(live?.statusVisible && live.statusText === 'live', 'and a visible "live" status');
    const states = new Set([...rows.map((r) => r.status), ...rowsB.map((r) => r.status)]);
    ok(['live', 'parked', 'dehydrated', 'never-started', 'empty', 'ended'].every((s) => states.has(s)), 'every seat state was rendered', [...states]);
    await ctxB.close();

    console.log('\n[phone width — no horizontal scroll, every button a 40px target]');
    /* Every VISIBLE button, measured on its box: the help panel and a confirm
       prompt are opened first so their buttons are on screen too. The confirm
       is Cancelled, so nothing changes. */
    const measure = (p) =>
      p.evaluate(() => {
        const de = document.documentElement;
        const buttons = [...document.querySelectorAll('button')]
          .filter((b) => {
            const cs = getComputedStyle(b);
            const r = b.getBoundingClientRect();
            return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
          })
          .map((b) => ({ cls: b.className, text: b.textContent.trim(), h: Math.round(b.getBoundingClientRect().height * 10) / 10 }));
        return { sw: de.scrollWidth, cw: de.clientWidth, bw: document.body.scrollWidth, buttons };
      });
    // A fresh placeholder seat, so a "name me" nudge is on screen to measure (the earlier one was renamed).
    const sNudge = await call(`/api/rooms/${R}/seats`, { json: { recipe_id: 'rec-auriga' } });
    ok(sNudge.status === 200, 'a placeholder seat added for the phone pass', sNudge.body);
    for (const width of [375, 320]) {
      const ctxP = await browser.newContext({ viewport: { width, height: 740 }, storageState: await context.storageState() });
      const pageP = await ctxP.newPage();
      pageP.on('pageerror', (e) => pageErrors.push(e.message));
      await pageP.goto(`${BASE}/room.html?room=${encodeURIComponent(R)}`, { waitUntil: 'domcontentloaded' });
      await until(() => pageP.evaluate(() => document.querySelectorAll('#roster .seat:not(.is-room)').length > 0 && document.querySelectorAll('#line .entry').length > 0));
      /* nav v3 (the design system room-nav-v3): on a phone the column is a SWITCHER row
         naming the current entry, so the line gets the glass; a tap opens the
         sheet with the same rows. */
      /* room-phone v1: the LINE is home, under a header; the seats are a sheet */
      const sheetShown = () => pageP.evaluate(() => !document.getElementById('phSheet').hidden);
      const col = await pageP.evaluate(() => ({
        column: getComputedStyle(document.querySelector('.rm-roster')).display !== 'none',
        lineH: Math.round(document.querySelector('.rm-line').getBoundingClientRect().height),
        vh: innerHeight,
        label: document.getElementById('phName').textContent,
        room: document.getElementById('roomName').textContent,
      }));
      ok(!col.column && !(await sheetShown()), `${width}px: no column on the phone; home is the line`, col);
      ok(col.lineH >= col.vh * 0.6, `${width}px: the line gets most of the glass (${col.lineH}/${col.vh})`, col);
      ok(col.label === col.room, `${width}px: the header names the room`, col);
      await pageP.click('#phAgents');
      ok(await sheetShown(), `${width}px: one tap opens the Agents sheet`);
      await pageP.click('#phScrim', { position: { x: 20, y: 20 } }); // the scrim closes it
      await typeAndSend(pageP, '/help');
      await until(() => pageP.evaluate(() => getComputedStyle(document.getElementById('help')).display !== 'none'));
      await typeAndSend(pageP, '/remove @ghost');
      await until(() => pageP.evaluate(() => /is-confirm/.test(document.getElementById('reply').className)));
      /* home first (the reply, help and composer), then the Agents sheet (its
         rows' buttons): one measure each, merged */
      const m0 = await measure(pageP);
      await pageP.click('#phAgents');
      const m1 = await measure(pageP);
      await pageP.click('#phScrim', { position: { x: 20, y: 20 } });
      const m = { ...m0, sw: Math.max(m0.sw, m1.sw), bw: Math.max(m0.bw, m1.bw), buttons: [...m0.buttons, ...m1.buttons] };
      ok(m.sw <= m.cw && m.bw <= m.cw, `no horizontal page scroll at ${width}px (${m.sw}/${m.bw} <= ${m.cw})`);
      const classes = new Set(m.buttons.map((b) => b.cls.split(' ')[0]));
      ok(['rm-send', 'rm-older', 'rm-confirm', 'rm-cancel', 'rm-help-close', 'seat-nudge'].every((c) => classes.has(c)), `${width}px: every button kind is on screen to measure`, [...classes]);
      const small = m.buttons.filter((b) => b.h < 40);
      ok(small.length === 0, `${width}px: every visible button is >= 40px tall (${m.buttons.length} measured)`, small);
      await pageP.click('#reply .rm-cancel');
      await ctxP.close();
    }
    ok((await call(`/api/rooms/${R}`)).body.seats.some((s) => s.handle === 'ghost'), 'the phone pass Cancelled its /remove: @ghost is still seated');

    ok(pageErrors.length === 0, 'no page errors', pageErrors);
  } finally {
    try {
      await browser?.close();
    } catch {
      /* closing */
    }
    if (engine) {
      engine.kill();
      await sleep(300);
    }
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

run()
  .catch((e) => {
    failed++;
    failures.push(`probe aborted: ${e?.message ?? e}`);
    console.log(`\n  ✗ probe aborted: ${e?.stack ?? e}`);
  })
  .finally(() => {
    console.log(`\nPASS ${passed} FAIL ${failed}${skipped ? ` SKIPPED ${skipped} (push)` : ''}`);
    if (failures.length) {
      console.log(failures.map((f) => `  - ${f.split('\n')[0]}`).join('\n'));
    }
    process.exit(failed ? 1 : 0);
  });
