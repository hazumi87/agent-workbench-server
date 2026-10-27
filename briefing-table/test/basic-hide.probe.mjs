/* BASIC EDITION HIDES [basic]  node test/basic-hide.probe.mjs   Owner 2026-10-08, room interface / lead [ref]
 * /health says edition 'basic' (stubbed: the scratch engine is the full build): the old seats layout (the room's row together with its seats, no
 * Room cell), no workgroup rows, no voice badge, no Assemble, no Agent comms / chatter / voice settings; a full edition keeps all of it. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(426);
const DEAD = P(427);
const SHOTS = process.env.SHOTS_DIR || '';
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-basic-hide-token';
let failures = 0;
const ok = (c, m, d) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${d !== undefined ? `  (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); if (!c) { failures += 1; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runTsx = (args, env) => new Promise((resolve) => {
  const pr = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
  let out = ''; let err = '';
  pr.stdout.on('data', (d) => (out += d)); pr.stderr.on('data', (d) => (err += d));
  pr.on('exit', (code) => resolve({ code, out, err }));
});
/* a visualViewport whose height the probe can shrink (the soft keyboard) */
await assertFree(PORT, 'basic-hide.probe.mjs');
await assertFree(DEAD, 'basic-hide.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-basic-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null; let browser = null; let log = '';
try {
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
    return JSON.parse(r.out.trim().split('\n').pop());
  };
  await seed({ recipes: [{ id: 'rec-a', name: 'Awake', projectDir: '/srv/x/awake', vendor: 'claude-code', agent: 'awake', color: '#0dab49' }, { id: 'rec-b', name: 'Other', projectDir: '/srv/x/other', vendor: 'claude-code', agent: 'other', color: '#1f5fbf' }] });
  const loader = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  engine = spawn(process.execPath, ['--import', loader, join('src', 'server', 'index.ts')], { cwd: REPO_ROOT, env: childEnv({
    HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: dbPath, HARBOR_WB_TOKEN: TOKEN,
    HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'), HARBOR_WB_IDENTITY: 'legacy', HARBOR_WB_NO_WINDOW: '1',
    HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(DEAD),
    HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'cp'), HARBOR_WB_NODE: 'testnode' }) });
  engine.stdout.on('data', (d) => (log += d)); engine.stderr.on('data', (d) => (log += d));
  let up = false;
  for (let i = 0; i < 120 && !up; i += 1) { await sleep(250); try { up = (await fetch(`${BASE}/health`)).ok; } catch { /* not yet */ } }
  ok(up, 'scratch engine up', up ? undefined : log.slice(-300));
  if (!up) { throw new Error('no engine'); }
  const seeded = (await seed({ rooms: [{ name: 'Layers Main', seats: [{ handle: 'awake', recipe_id: 'rec-a', occupant: 'recipe:rec-a' }, { handle: 'other', recipe_id: 'rec-b' }] }] })).rooms[0];
  const main = seeded.id;
  const { windowCookie } = await import('./_scratch.mjs');
  const cookie = await windowCookie(BASE, TOKEN);
  const call = async (path, method, json) => {
    const res = await fetch(BASE + path, { method, headers: { cookie, 'content-type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json) });
    let b = null; try { b = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: b };
  };
  const wgr = await call(`/api/rooms/${main}/workgroups`, 'POST', { name: 'Layers Sub', alias: 'sub', move: [seeded.seats.other ?? Object.values(seeded.seats)[1]], lead: { move: seeded.seats.other ?? Object.values(seeded.seats)[1] } });
  const WG = wgr.body?.room?.id ?? wgr.body?.workgroup?.id ?? wgr.body?.id;
  ok(!!WG, 'a main room and a workgroup exist', wgr.status);
  browser = await chromium.launch({ headless: true });
  const stub = async (c, edition) => { await c.route(/\/health$/, async (route) => { const res = await route.fetch(); const b = await res.json(); await route.fulfill({ response: res, json: { ...b, ...(edition ? { edition } : {}) } }); }); };
  const login = async (pg) => {
    await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
    await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);
  };
  const errs = [];
  for (const edition of ['basic', 'full']) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await stub(ctx, edition);
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errs.push(`${edition}: ${e}`));
    await login(pg);
    await pg.goto(`${BASE}/room.html?room=${main}`, { waitUntil: 'domcontentloaded' });
    await sleep(3500);
    const R = await pg.evaluate(() => {
      const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
      return {
        attr: document.documentElement.dataset.edition,
        roomCell: vis(document.querySelector('.cell[data-cell="room"]')),
        roomRowInSeats: !!document.querySelector('#roster .seat.is-room'),
        seatRows: document.querySelectorAll('#roster .seat:not(.is-room)').length,
        wgRows: document.querySelectorAll('#roomList .seat.is-sub, #roster .seat.is-sub').length,
      };
    });
    if (edition === 'basic') {
      ok(R.attr === 'basic' && !R.roomCell && R.roomRowInSeats && R.seatRows === 1 && R.wgRows === 0, 'basic: no Room cell; the room\'s row sits in the Seats list with its seat; no workgroup rows', R);
    } else {
      ok(R.attr === 'full' && R.roomCell && !R.roomRowInSeats && R.seatRows === 1, 'full: the Room cell and its row are where they were; the Seats list holds only seats', R);
    }
    if (edition === 'basic') {
      const RB = await pg.evaluate(() => ({ bar: document.getElementById('roomName')?.textContent.replace(/\s+/g, ' ').trim(), meta: document.querySelector('#roster .seat.is-room .seat-meta')?.textContent ?? null }));
      ok(/^Layers Main · 1 agent\s*ⓘ?$/.test(RB.bar) && !/Main room/.test(RB.bar), "basic: the room bar is the site's name then '· 1 agent' (no 'Main room', no lead)", RB);
      ok(RB.meta === '', "basic: the Room chat row's second line is the unread count or nothing (never 'main room')", RB);
    }
    /* the + sheet: Basic has no Workgroup tab */
    await pg.click('#addBtn').catch(() => {});
    await sleep(900);
    const T = await pg.evaluate(() => [...document.querySelectorAll('.ras-seg [role=tab]')].map((t) => t.textContent.replace(/\d+$/, '').trim()));
    if (edition === 'basic') { ok(T.includes('Apps') && T.includes('Agents') && !T.some((x) => /Workgroup|Move/.test(x)), 'basic: the one + opens Agents, Apps (no Workgroup, no Move)', T); }
    else { ok(T.length >= 1 && !T.includes('Apps'), 'full: the Seats + keeps Add | Move', T); }
    await pg.goto(`${BASE}/settings.html`, { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    const S = await pg.evaluate(() => [...document.querySelectorAll('#nav a')].map((a) => a.dataset.nav));
    const hidden = ['voice', 'agent-comms', 'chatter'];
    if (edition === 'basic') { ok(hidden.every((h) => !S.includes(h)) && S.includes('you') && S.includes('palette'), 'basic: Settings drops Voice, Agent comms and Agents · chatter', S); }
    else { ok(hidden.every((h) => S.includes(h)), 'full: Settings keeps all of them', S); }
    await pg.goto(`${BASE}/manager.html`, { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    const A = await pg.evaluate(() => { const b = document.getElementById('assembleBtn'); return !!b && getComputedStyle(b).display !== 'none' && b.getClientRects().length > 0; });
    const rn = await pg.evaluate(() => { const s = document.getElementById('roomNewSheet'); if (s) { s.hidden = false; } const b = document.getElementById('assembleBtn'); return !!b && getComputedStyle(b).display !== 'none' && b.getClientRects().length > 0; });
    ok(edition === 'basic' ? !rn : rn, edition === 'basic' ? 'basic: no Assemble path in the new-room sheet' : 'full: Assemble is in the new-room sheet', { A, rn });
    /* the phone */
    const ph = await ctx.newPage();
    await ph.setViewportSize({ width: 390, height: 780 });
    ph.on('pageerror', (e) => errs.push(`${edition} phone: ${e}`));
    await ph.goto(`${BASE}/room.html?room=${main}`, { waitUntil: 'domcontentloaded' });
    await sleep(3500);
    await ph.click('#phAgents');
    await sleep(500);
    const P2 = await ph.evaluate(() => ({ heads: [...document.querySelectorAll('#phSheet h3')].map((h) => h.textContent.replace(/[+\s]+$/, '')), roomRows: document.querySelectorAll('#phSheet .seat.is-room').length, wgRows: document.querySelectorAll('#phSheet .seat.is-sub').length }));
    if (edition === 'basic') { ok(P2.roomRows === 1 && P2.wgRows === 0 && P2.heads.includes('Seats'), 'basic phone: the sheet has the room\'s row and the seats, no workgroup rows', P2); }
    else { ok(P2.heads.includes('Rooms') && P2.heads.includes('Seats'), 'full phone: the sheet keeps Rooms and Seats', P2); }
    await ctx.close();
  }
  /* ---- New site (Basic): one question; posts to /api/projects/new-site; lands in the new room; a failure is said in the sheet ---- */
  {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await stub(ctx, 'basic');
    const posts = [];
    let mode = 'fail';
    await ctx.route(/\/api\/projects\/new-site$/, async (route) => {
      posts.push(route.request().postDataJSON());
      if (mode === 'fail') { await route.fulfill({ status: 502, json: { error: 'the new-site command failed; nothing was created' } }); }
      else { await route.fulfill({ json: { ok: true, existed: false, room: { id: main, name: 'My Site' }, site: { slug: 'my-site' }, started: true } }); }
    });
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errs.push(`newsite: ${e}`));
    await login(pg);
    await pg.goto(`${BASE}/manager.html`, { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    const card = await pg.evaluate(() => ({ t: document.querySelector('#roomNewCard .pt')?.textContent, s: document.querySelector('#roomNewCard small')?.textContent }));
    const wgc = await pg.evaluate(() => [...document.querySelectorAll('.rc-wg')].filter((c) => getComputedStyle(c.closest('.rc-wgs') ?? c).display !== 'none').length);
    ok(wgc === 0, 'basic: no workgroup chip on a Workbench room card', wgc);
    ok(card.t === 'New site' && /name/.test(card.s), 'basic: the dashed card says "New site"', card);
    await pg.click('#roomNewCard');
    const sheet = await pg.evaluate(() => ({ head: document.querySelector('#roomNewSheet .rn-head span')?.textContent, ph: document.getElementById('roomNewName').placeholder, btn: document.getElementById('roomNewBtn').textContent, lbl: document.querySelector('#roomNewForm .rn-lbl')?.textContent, hint: document.querySelector('#roomNewForm .rn-hint')?.textContent, paths: !document.querySelector('#roomNewSheet .rn-paths').hidden, inputs: document.querySelectorAll('#roomNewForm input').length }));
    ok(sheet.head === 'New site' && sheet.btn === 'Create site' && sheet.lbl === 'Name' && sheet.hint === 'Your agent starts on it right away.' && !sheet.paths && sheet.inputs === 1, 'basic: the sheet asks only for a name: a "Name" label, a dim line under it, the button says Create site (not the title again)', sheet);
    await pg.fill('#roomNewName', 'My Site');
    if (SHOTS) { await pg.screenshot({ path: join(SHOTS, 'new-site-pc.png') }); const ph = await ctx.newPage(); await ph.setViewportSize({ width: 390, height: 780 }); await ph.goto(`${BASE}/manager.html`, { waitUntil: 'domcontentloaded' }); await sleep(2500); await ph.click('#roomNewCard'); await ph.fill('#roomNewName', 'My Site'); await ph.screenshot({ path: join(SHOTS, 'new-site-phone.png') }); await ph.close(); }
    await pg.click('#roomNewBtn');
    await sleep(800);
    const E = await pg.evaluate(() => ({ err: document.getElementById('roomErr').textContent, shown: !document.getElementById('roomErr').hidden, btn: document.getElementById('roomNewBtn').textContent, dis: document.getElementById('roomNewBtn').disabled }));
    ok(JSON.stringify(posts) === '[{"name":"My Site"}]' && E.shown && /Could not create the site: the new-site command failed/.test(E.err) && !E.dis && E.btn === 'Create site', 'basic: POST {name}; a refusal is said in the sheet, the button comes back', { posts, E });
    mode = 'ok';
    const nav = pg.waitForURL(new RegExp(`/room\\.html\\?room=${main}`), { timeout: 6000 }).then(() => true).catch(() => false);
    const pop = ctx.waitForEvent('page', { timeout: 6000 }).then((p2) => p2.url()).catch(() => null);
    await pg.click('#roomNewBtn');
    const landed = (await nav) || ((await pop) ?? '').includes(`room=${main}`);
    ok(posts.length === 2 && landed, 'basic: a made site lands in its room', { posts: posts.length });
    await ctx.close();
  }
  /* ---- the Preview / Public bar (Basic site room) ---- */
  for (const dev of ['pc', 'phone']) {
    const ctx = await browser.newContext({ viewport: dev === 'pc' ? { width: 1400, height: 900 } : { width: 390, height: 780 }, hasTouch: dev === 'phone', isMobile: dev === 'phone' });
    await stub(ctx, 'basic');
    let site = { slug: 'my-site', id: 'abc123', name: 'My Site', previewUrl: 'https://preview.example/my-site', publicUrl: 'https://my-site.example', published: false, lastPublishedAt: null, changedSinceSave: true };
    const lines = [];
    await ctx.route(new RegExp(`/api/rooms/${main}/site$`), async (route) => { await route.fulfill({ json: site }); });
    await ctx.route(new RegExp(`/api/rooms/${main}/line$`), async (route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      lines.push(route.request().postDataJSON());
      await route.fulfill({ json: { status: 'posted', entries: [], deliveries: [] } });
    });
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errs.push(`sitebar ${dev}: ${e}`));
    await login(pg);
    await pg.goto(`${BASE}/room.html?room=${main}`, { waitUntil: 'domcontentloaded' });
    await sleep(3500);
    const B = await pg.evaluate(() => { const b = document.getElementById('siteBar'); if (!b || b.hidden) { return null; } const r = b.getBoundingClientRect(); return { top: Math.round(r.top), w: Math.round(r.width), sw: document.scrollingElement.scrollWidth, preview: b.querySelector('.sb-open')?.getAttribute('href'), label: b.querySelector('.sb-lbl')?.textContent, off: b.querySelector('.sb-off')?.textContent, div: !!b.querySelector('.sb-div'), lblBeforeSwitch: !!(b.querySelector('.sb-lbl')?.compareDocumentPosition(b.querySelector('.sb-switch')) & Node.DOCUMENT_POSITION_FOLLOWING), on: b.querySelector('.sb-switch')?.getAttribute('aria-checked'), pub: !!b.querySelector('.sb-addr'), now: !!b.querySelector('.sb-now'), btnH: Math.round(b.querySelector('.sb-switch').getBoundingClientRect().height), openTop: Math.round(b.querySelector('.sb-open').getBoundingClientRect().top), pubTop: Math.round(b.querySelector('.sb-pub').getBoundingClientRect().top) }; });
    ok(!!B && B.preview === 'https://preview.example/my-site' && B.on === 'false' && B.label === 'Public' && B.lblBeforeSwitch && /off/.test(B.off ?? '') && B.div && !B.pub && !B.now && B.sw <= (dev === 'pc' ? 1400 : 390), `${dev}: the bar is two things: "Open preview ↗", a divider, then "Public" before its switch reading "· off" (no address, no Publish now while private)`, B);
    if (dev === 'phone') { ok(B.pubTop > B.openTop + 20, 'phone: two rows: the preview first, the Public group under it', B); }
    if (dev === 'phone') { ok(B.btnH >= 40, 'phone: the switch is a 40px+ target', B.btnH); }
    await pg.click('#siteBar .sb-switch');
    await sleep(500);
    const A = await pg.evaluate(() => ({ asked: document.querySelector('#siteBar .sb-asked')?.textContent, on: document.querySelector('#siteBar .sb-switch').getAttribute('aria-checked') }));
    ok(JSON.stringify(lines) === '[{"text":"/publish"}]' && /asked .* to publish/.test(A.asked ?? '') && A.on === 'false', `${dev}: the switch sends /publish as a typed line and does NOT flip until the site says so`, { lines, A });
    site = { ...site, published: true, lastPublishedAt: 1791440000000, changedSinceSave: false };
    await pg.waitForFunction(() => document.querySelector('#siteBar .sb-switch')?.getAttribute('aria-checked') === 'true', null, { timeout: 9000 }).catch(() => {});
    const C = await pg.evaluate(() => ({ on: document.querySelector('#siteBar .sb-switch')?.getAttribute('aria-checked'), asked: !!document.querySelector('#siteBar .sb-asked'), link: document.querySelector('#siteBar .sb-addr')?.getAttribute('href'), copy: !!document.querySelector('#siteBar .sb-copy'), now: !!document.querySelector('#siteBar .sb-now'), when: document.querySelector('#siteBar .sb-when')?.textContent }));
    ok(C.on === 'true' && !C.asked && C.link === 'https://my-site.example' && C.copy && !C.now && /^published /.test(C.when ?? ''), `${dev}: once the site is public: switch on, the address with Copy, last-published time, no Publish now`, C);
    if (SHOTS) { await pg.screenshot({ path: join(SHOTS, `site-bar-${dev}.png`) }); }
    await pg.click('#siteBar .sb-switch');
    await sleep(400);
    ok(lines.length === 2 && lines[1].text === '/unpublish', `${dev}: switching off sends /unpublish`, lines);
    site = { ...site, changedSinceSave: true };
    await pg.evaluate(() => window.dispatchEvent(new Event('focus')));
    await pg.waitForSelector('#siteBar .sb-now', { timeout: 5000 }).catch(() => {});
    ok(await pg.evaluate(() => /Changes not published yet/.test(document.querySelector('#siteBar .sb-behind')?.textContent ?? '')), `${dev}: when the public copy is behind: "Changes not published yet" before Publish now`);
    if (SHOTS) { site = { ...site, published: true, changedSinceSave: true }; await pg.reload({ waitUntil: 'domcontentloaded' }); await sleep(3000); await pg.screenshot({ path: join(SHOTS, `site-bar-behind-${dev}.png`) }); }
    await pg.click('#siteBar .sb-now');
    await sleep(400);
    ok(lines.length === 3 && lines[2].text === '/publish', `${dev}: Publish now sends /publish`, lines);
    /* not a site room (all null) or not Basic (404): no bar */
    site = { slug: null, id: null, previewUrl: null, publicUrl: null, published: null, lastPublishedAt: null, changedSinceSave: null };
    await pg.reload({ waitUntil: 'domcontentloaded' });
    await sleep(3000);
    ok(await pg.evaluate(() => { const b = document.getElementById('siteBar'); return !b || b.hidden; }), `${dev}: a room that is not a site has no bar`);
    await ctx.close();
  }
  /* ---- /help in Basic: Room commands + Ask your agent; a row puts its /word in the box ---- */
  {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await stub(ctx, 'basic');
    await ctx.route(new RegExp(`/api/rooms/${main}/line$`), async (route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      await route.fulfill({ json: { status: 'applied', entries: [], deliveries: [], client: { action: 'help', data: [{ name: '/help', usage: '/help', explain: 'this list' }, { name: '/rename room', usage: '/rename room <name>', explain: 'rename the room' }], agent: [{ name: '/publish', explain: 'You are asking me to put the site on the public web.', confirm: true }, { name: '/preview', explain: 'Show the private copy.', confirm: false }] } } });
    });
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errs.push(`help: ${e}`));
    await login(pg);
    await pg.goto(`${BASE}/room.html?room=${main}`, { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    await pg.fill('#input', '/help');
    await pg.click('#sendBtn');
    await pg.waitForSelector('#help:not([hidden]) .rm-verb-ask', { timeout: 5000 }).catch(() => {});
    const H = await pg.evaluate(() => ({ heads: [...document.querySelectorAll('#help .rm-help-head')].map((h) => h.firstChild.textContent), room: [...document.querySelectorAll('#help .rm-verbs:not(.rm-verbs-agent) .rm-verb-usage')].map((x) => x.textContent), ask: [...document.querySelectorAll('#help .rm-verb-ask')].map((r) => [r.dataset.cmd, r.querySelector('.rm-verb-does').textContent]) }));
    ok(JSON.stringify(H.heads) === '["Room commands","Ask your agent"]' && H.room.length === 2 && H.ask.length === 2 && /asks first/.test(H.ask[0][1]) && !/asks first/.test(H.ask[1][1]), 'basic /help: Room commands, then Ask your agent (the "asks first" note only where the registry says confirm)', H);
    if (SHOTS) { await pg.screenshot({ path: join(SHOTS, 'help-pc.png') }); const ph = await ctx.newPage(); await ph.setViewportSize({ width: 390, height: 780 }); await ph.goto(`${BASE}/room.html?room=${main}`, { waitUntil: 'domcontentloaded' }); await sleep(3000); await ph.fill('#input', '/help'); await ph.click('#sendBtn'); await ph.waitForSelector('#help:not([hidden]) .rm-verb-ask', { timeout: 5000 }).catch(() => {}); await ph.screenshot({ path: join(SHOTS, 'help-phone.png') }); await ph.close(); }
    const X = await pg.evaluate(() => ({ x: document.querySelector('#help .rm-help-x')?.textContent, label: document.querySelector('#help .rm-help-x')?.getAttribute('aria-label'), lower: !!document.querySelector('#help .rm-help-close'), chips: [...document.querySelectorAll('#help .rm-ask-chip')].map((c) => c.textContent), sentence: document.querySelector('#help .rm-verb-ask .rm-verb-does').firstChild.textContent }));
    ok(X.x === '\u2715' && X.label === 'Close' && !X.lower && X.chips.join() === 'asks first' && !/asks first/.test(X.sentence), 'basic /help: the close is the ✕ icon button; "asks first" is a small chip at the end of the row (only on /publish), not part of the sentence', X);
    await pg.click('#help .rm-verb-ask[data-cmd="/publish"]');
    const V = await pg.evaluate(() => ({ v: document.getElementById('input').value, hidden: document.getElementById('help').hidden }));
    ok(V.v === '/publish ' && V.hidden, 'basic /help: tapping an agent command puts it in the box and closes the list', V);
    await ctx.close();
  }
  /* ---- "waking" and "Not delivered: @x is disconnected" + Wake and deliver ---- */
  for (const dev of ['pc', 'phone']) {
    const ctx = await browser.newContext({ viewport: dev === 'pc' ? { width: 1400, height: 900 } : { width: 390, height: 780 }, hasTouch: dev === 'phone', isMobile: dev === 'phone' });
    await stub(ctx, 'basic');
    const awakeSeat = seeded.seats.awake ?? Object.values(seeded.seats)[0];
    let readState = 'waking';
    let withFact = false;
    const wakes = [];
    await ctx.route(new RegExp(`/api/rooms/${main}/line\\?limit=`), async (route) => {
      const res = await route.fetch();
      const b = await res.json();
      const tpl = (b.entries ?? [])[0] ?? {};
      const chat = { ...tpl, id: 9001, kind: 'chat', author: 'user', author_seat: null, target: 'awake', target_seat: awakeSeat, body: '@awake please add a contact page', ts: Date.now(), reads: { awake: readState }, meta: null };
      const entries = [...(b.entries ?? []), chat];
      if (withFact) {
        entries.push({ ...tpl, id: 9002, kind: 'delivery', author: 'room', author_seat: null, target: '@awake', target_seat: awakeSeat, body: 'not delivered', ts: Date.now(), reads: undefined, meta: JSON.stringify({ paneid: null, delivered: false, cause: 9001, line: 9001, seat: awakeSeat, reason: 'disconnected', action: 'wake-deliver' }) });
      }
      await route.fulfill({ response: res, json: { ...b, entries } });
    });
    await ctx.route(new RegExp(`/api/rooms/${main}/seats/[^/]+/wake-deliver$`), async (route) => { wakes.push(route.request().postDataJSON()); await route.fulfill({ json: { ok: true, status: 'waking' } }); });
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errs.push(`wake ${dev}: ${e}`));
    await login(pg);
    await pg.goto(`${BASE}/room.html?room=${main}`, { waitUntil: 'domcontentloaded' });
    await sleep(3500);
    const rd = () => pg.evaluate(() => { const li = document.querySelector('li[data-id="9001"]'); const el = li?.querySelector(':scope > .entry-reads'); return { text: el?.textContent.replace(/\s+/g, ' ').trim() ?? null, state: [...(el?.querySelectorAll('.rd') ?? [])].map((x) => x.dataset.state), btn: !!el?.querySelector('.rd-wake'), btnH: Math.round(el?.querySelector('.rd-wake')?.getBoundingClientRect().height ?? 0) }; });
    let W = await rd();
    ok(W.state.join() === 'waking' && /waking @awake/.test(W.text ?? ''), `${dev}: a line to a disconnected agent being woken reads "waking @awake"`, W);
    ok(await pg.evaluate(() => !!document.querySelector('.entry-reads .rd-waking .rd-ring svg, .entry-reads .rd-waking .rd-ring *')), `${dev}: the waking line carries the working ring`);
    if (SHOTS) { await pg.screenshot({ path: join(SHOTS, `waking-${dev}.png`) }); }
    readState = 'unknown';
    withFact = true;
    await pg.reload({ waitUntil: 'domcontentloaded' });
    await sleep(3500);
    W = await rd();
    ok(W.state.join() === 'not-delivered' && /Not delivered: @awake is disconnected/.test(W.text ?? '') && W.btn, `${dev}: a failed wake reads "Not delivered: @awake is disconnected" with a Wake and deliver button`, W);
    const colour = await pg.evaluate(() => ({ word: getComputedStyle(document.querySelector('.rd-not-delivered .rd-w')).color, body: getComputedStyle(document.querySelector('.rd-not-delivered')).color }));
    ok(colour.word !== colour.body, `${dev}: the word is coral, not the body ink`, colour);
    const ND = await pg.evaluate(() => { const f = document.querySelector('li[data-nd]'); const b = document.querySelector('.rd-wake'); const w = document.querySelector('.rd-not-delivered .rd-w'); return { factHidden: !!f && (f.hidden || getComputedStyle(f).display === 'none'), btn: getComputedStyle(b).color, word: getComputedStyle(w).color }; });
    ok(ND.factHidden && ND.btn !== ND.word, `${dev}: the coral line says it once (the second "not delivered" line is hidden) and the button is the accent, not coral`, ND);
    if (dev === 'phone') { ok(W.btnH >= 40, 'phone: the button is a 40px+ target', W.btnH); }
    if (SHOTS) { await pg.screenshot({ path: join(SHOTS, `not-delivered-${dev}.png`) }); }
    await pg.click('.rd-wake');
    await sleep(600);
    W = await rd();
    ok(wakes.length === 1 && wakes[0].lineId === 9001 && W.state.join() === 'waking', `${dev}: Wake and deliver posts {lineId} and the line reads "waking" again`, { wakes, W });
    await ctx.close();
  }
  {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await stub(ctx, 'full');
    const pg = await ctx.newPage();
    await login(pg);
    await pg.goto(`${BASE}/room.html?room=${main}`, { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    ok(await pg.evaluate(() => !document.getElementById('siteBar')), 'full edition: the bar is never mounted');
    await ctx.close();
  }
  ok(errs.length === 0, 'no page errors', errs.slice(0, 3));
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
