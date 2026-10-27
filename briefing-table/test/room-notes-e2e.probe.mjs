/* ROOM NOTES, END TO END [ticket]: the real room page (web/room.html) in a real
 * Chromium against a real scratch engine, nothing stubbed but the agent-share
 * (a note's attachment is engine-held; sending one publishes to the share).
 *
 *   node test/room-notes-e2e.probe.mjs [shotsdir]
 *
 * Scenarios: New note from the composer + (autosave, close, listed with
 * keywords, reopen); the paperclip (one tile titled by the first words, edited
 * via the tile, still one tile, the engine's attachment bytes updated); Move
 * draft to a note (composer empty, tile, server draft empty, and after one
 * draft-sync tick still empty with no "Newer draft" offer); a paste over 4000
 * characters offers "Move to a note"; sending a message with a note attached;
 * an empty note is removed on close; search finds archived notes the list hides;
 * the phone editor from the chat (header/strip/composer hidden, chat scrollable,
 * nothing focused programmatically).
 *
 * With ROOM_ASSETS_DIR=<a room-assets checkout> it also starts that app on P(326)
 * pointed at this scratch engine and checks its /rooms/<id>/notes.json shapes.
 *
 * A PROBE, not in `npm test`. OWN scratch engine P(324), DEAD broker P(325),
 * stub agent-share on an ephemeral port, temp table, childEnv() scrubbed,
 * fabric + NATS off. Never :8201/:8204/:7420/:7430.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(324);
const DEAD_BROKER_PORT = P(325);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const TOKEN = 'probe-room-notes-e2e-token';
const SHOTS = process.argv[2] ?? join(REPO_ROOT, 'tmp-notes-shots');
mkdirSync(SHOTS, { recursive: true });

let passes = 0;
let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (cond) { passes += 1; } else { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on('unhandledRejection', (e) => ok(false, `unhandled: ${e?.stack ?? e}`));
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) { return true; } } catch { /* not yet */ }
    await sleep(100);
  }
  return false;
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

/* the agent-share stand-in: upload (a send publishes the attachment here) + raw */
const shareFs = new Map();
let uploads = 0; // a note is never uploaded: this share is DOWN (every upload answers 500)
const stub = createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  if (req.method === 'POST' && u.pathname === '/api/upload') {
    uploads++;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'share is down' }));
    return;
  }
  if (req.method === 'POST' && u.pathname === '/api/upload-never') {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const dir = u.searchParams.get('dir') ?? '';
      if (!shareFs.has(dir)) { shareFs.set(dir, []); }
      const body = Buffer.concat(chunks);
      const boundary = /boundary=([^;]+)/.exec(req.headers['content-type'] ?? '')?.[1];
      const headEnd = body.indexOf('\r\n\r\n');
      const name = /filename="([^"]*)"/.exec(body.subarray(0, headEnd).toString('utf8'))?.[1];
      const end = body.lastIndexOf(Buffer.from(`\r\n--${boundary}--`));
      shareFs.get(dir).push({ name, bytes: body.subarray(headEnd + 4, end) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, saved: [`${dir}/${name}`] }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => stub.listen(0, HOST, r));
const SHARE = `http://${HOST}:${stub.address().port}`;

for (const p of [PORT, DEAD_BROKER_PORT]) {
  await assertFree(p, 'room-notes-e2e.probe.mjs');
}
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-notes-e2e-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null;
let panel = null;
let browser = null;
let engineLog = '';
const seed = async (plan) => {
  const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
  return JSON.parse(r.out.trim().split('\n').pop());
};

try {
  await seed({
    recipes: [{ id: 'rec-lead', name: 'Lead', projectDir: '/srv/x/leadp', vendor: 'cli-manager', agent: 'leadp', color: '#0dab49' }],
    sessions: [{ paneid: 'recipe:rec-lead', recipe_id: 'rec-lead', vendor: 'cli-manager', agent: 'leadp', state: 'live' }],
  });
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
      HARBOR_WB_CONFIG: join(tmpDir, 'config.json'),
      HARBOR_WB_AGENT_SHARE_URL: SHARE,
      HARBOR_WB_ROOM_SCRATCH_DIR: join(tmpDir, 'room-scratch'),
    }),
  });
  engine.stdout.on('data', (d) => (engineLog += d));
  engine.stderr.on('data', (d) => (engineLog += d));
  const up = await until(async () => (await fetch(`${BASE}/health`)).ok, 30000);
  ok(up, `scratch engine is serving on ${PORT}`, up ? undefined : engineLog.slice(-400));
  if (!up) { throw new Error('engine never came up'); }

  const cookie = await windowCookie(BASE, TOKEN);
  const api = async (path, { json, method, bearer } = {}) => {
    const m = method ?? (json !== undefined ? 'POST' : 'GET');
    const headers = bearer ? { authorization: `Bearer ${TOKEN}` } : { cookie };
    const init = { method: m, headers };
    if (json !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(json);
    }
    const res = await fetch(BASE + path, init);
    let body = null;
    try { body = await res.json(); } catch { /* not json */ }
    return { status: res.status, body };
  };
  /* the room + its seat come from the store seed (a seat needs a live broker
     session, which a dead-broker scratch engine cannot start); every note call
     below goes through the engine's own API */
  const seeded = await seed({ rooms: [{ name: 'Notes E2E', seats: [{ handle: 'leadp', recipe_id: 'rec-lead', occupant: 'recipe:rec-lead' }] }] });
  const R = seeded.rooms[0].id;
  ok(!!R, 'a room with one seat');
  const N = `/api/rooms/${R}/notes`;
  const listed = async () => (await api(N, { bearer: true })).body?.notes ?? [];
  const scratch = async () => (await api(`/api/rooms/${R}/scratch`)).body?.files ?? [];
  const rawOf = async (f) => (await fetch(BASE + f.raw, { headers: { cookie } })).text();

  browser = await chromium.launch({ headless: true });
  const login = async (ctx) => {
    await ctx.addCookies([{ name: 'wb_auth', value: cookie.split('wb_auth=')[1].split(';')[0], url: BASE }]);
  };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await login(ctx);
  const page = await ctx.newPage();
  const errors = []; // (the Assets panel frame 405s: its app is not running here)
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('/panels/')) { errors.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); } });
  const roomUrl = `${BASE}/room.html?room=${R}`;
  const shot = (p, name) => p.screenshot({ path: join(SHOTS, `e2e-${name}.png`) });
  const open = async (p = page) => {
    await p.goto(roomUrl, { waitUntil: 'domcontentloaded' });
    await until(() => p.evaluate(() => document.getElementById('roomName').textContent !== 'Workroom'));
    await sleep(500); // the notes probe + the tray restore
  };
  const tiles = (p = page) => p.$$eval('#attTray .att-tile', (els) => els.map((e) => ({ cls: e.className, label: e.getAttribute('aria-label'), n: e.querySelector('.att-fn .n')?.textContent, s: e.querySelector('.att-fn .s')?.textContent, sr: e.querySelector('.att-sr')?.textContent, vis: [...e.childNodes].filter((c) => c.className !== 'att-sr' && c.className !== 'att-x').map((c) => c.textContent).join('') })));
  const menuPick = async (p, a) => {
    await p.click('#attBtn');
    await p.waitForSelector('.rsm-menu');
    await p.click(`.rsm-mi[data-a="${a}"]`);
  };
  await open();

  /* 1. composer + -> New note -> type -> autosave -> close -> listed with keywords -> reopen */
  console.log('\n[1] new note, autosave, close, list, reopen');
  ok((await page.$eval('#attBtn', (b) => b.title)) === 'Attach a file or add a note', 'the + tooltip names both ways in');
  await page.click('#attBtn');
  await page.waitForSelector('.rsm-menu');
  const items = await page.$$eval('.rsm-menu .rsm-mi', (b) => b.map((x) => x.textContent));
  ok(JSON.stringify(items) === JSON.stringify(['Attach a file', 'New note', 'Move draft to a note']), 'the + menu lists the three actions', items);
  await shot(page, 'pc-plus-menu');
  await page.click('.rsm-mi[data-a="note"]');
  await page.waitForSelector('.nt-card');
  ok(await page.$eval('.nt-ta', (t) => document.activeElement === t), 'PC: the textarea is focused');
  const BODY1 = 'Pickled quince recipe: boil the quince with sugar and cloves until the quince is soft.';
  await page.keyboard.type(BODY1);
  ok(await until(() => page.$eval('.nt-state', (s) => s.classList.contains('on'))), '"Saved" shows after the autosave');
  await shot(page, 'pc-editor');
  const idNote = (await listed()).length;
  await page.keyboard.press('Escape');
  await page.waitForSelector('.nt-card', { state: 'detached' });
  const l1 = await until(async () => (await listed()).length === 1);
  const row1 = (await listed())[0];
  ok(l1 && row1.keywords.includes('quince') && !row1.archived, 'closed: GET /notes lists it with keywords', row1);
  ok(await until(async () => (await tiles()).length === 1), 'a composer note is attached by its close: ONE tile, no paperclip pressed');
  ok(idNote <= 1, 'one note exists');
  const ID1 = row1.id;
  const panels1 = (await api(`/api/rooms/${R}/panels`)).body?.panels ?? [];
  ok(panels1.some((p) => p.icon === 'assets'), 'a room with no Assets panel got one with its first note (New note, type, close), before any send', panels1.map((p) => p.title));
  ok((await api(`${N}/${ID1}`, { bearer: true })).body.text === BODY1, 'the engine holds exactly what was typed');
  await page.evaluate(() => document.querySelector('#attBtn')); // keep page alive
  /* reopen: through the + menu's New note would create another, so reopen by attaching then opening the tile (scenario 2) */

  /* 2. a composer note has no paperclip: type, close, tile (the quince tile is already there); edit via the tile */
  console.log('\n[2] close attaches, edit via the tile');
  await menuPick(page, 'note');
  await page.waitForSelector('.nt-card');
  const BODY2 = 'Weekly review agenda: budget, hiring, the roadmap for the third quarter.';
  await page.keyboard.type(BODY2);
  await page.waitForTimeout(700);
  ok(await page.$eval('.nt-clip', (b) => b.hidden || getComputedStyle(b).display === 'none'), 'a composer note shows no paperclip');
  await page.click('.nt-x');
  await page.waitForSelector('.nt-card', { state: 'detached' });
  ok(await until(async () => (await tiles()).length === 2), 'closed with text: attached, TWO tiles');
  let t = await tiles();
  ok(/is-note/.test(t[1]?.cls) && t[1]?.label === 'Open note' && /^Weekly review agenda/.test(t[1]?.sr ?? '') && t[1]?.vis === '', 'the tile is the scratchpad: no visible words, aria-label "Open note", the first words for screen readers', t[1]);
  await shot(page, 'pc-note-tile');
  const ID2 = (await listed()).find((x) => x.keywords.includes('agenda'))?.id;
  ok(!!ID2, 'the second note is listed');
  let files = await scratch();
  const raws = await Promise.all(files.map((f) => rawOf(f)));
  ok(files.length === 2 && raws.includes(BODY2), 'engine attachment bytes = the note text', files.length);
  await page.click('#attTray .att-tile:nth-child(2)');
  await page.waitForSelector('.nt-card');
  ok(await page.$eval('.nt-ta', (x) => x.value) === BODY2, 'tapping the tile opens the LIVE note (reopen shows the text)');
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' Add the offsite.');
  await page.waitForTimeout(700);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.nt-card', { state: 'detached' });
  ok(await until(async () => { const fs = await scratch(); return fs.length === 2 && (await Promise.all(fs.map((f) => rawOf(f)))).some((r) => r.endsWith('Add the offsite.')); }), 'edited then closed: still two attachments, bytes updated');
  t = await tiles();
  ok(t.length === 2, 'still TWO tiles', t.length);

  /* 3. move draft */
  console.log('\n[3] move draft to a note');
  const DRAFT_TEXT = 'A long thought about parsnips that I started in the box and want to keep as a note instead.';
  await page.fill('#input', DRAFT_TEXT);
  await page.waitForTimeout(900);
  ok((await api(`/api/rooms/${R}/draft`)).body.text === DRAFT_TEXT, 'the server holds the draft');
  await menuPick(page, 'move');
  ok(await until(async () => (await tiles()).length === 3), 'a third tile appears');
  ok((await page.$eval('#input', (i) => i.value)) === '', 'the composer is empty');
  ok(await until(async () => (await api(`/api/rooms/${R}/draft`)).body.text === ''), 'the server draft row is empty');
  ok((await listed()).some((x) => x.keywords.includes('parsnips')), 'the note is listed');
  await shot(page, 'pc-draft-moved');
  console.log('  ... waiting 12 s for a draft-sync tick');
  await sleep(12000);
  ok((await page.$eval('#input', (i) => i.value)) === '', 'after a draft-sync tick the composer is STILL empty');
  ok(await page.$eval('#newerDraft', (b) => b.hidden), 'no "Newer draft" offer');
  /* 4. over the limit */
  console.log('\n[4] paste over 4000 characters');
  const LONG = Array.from({ length: 700 }, (_, i) => `zebra${i}`).join(' ').slice(0, 4400);
  await page.fill('#input', LONG);
  ok(await until(() => page.$eval('#delivery', (d) => !d.hidden && /Move to a note/.test(d.textContent))), 'the status line carries "Move to a note"');
  await shot(page, 'pc-over-limit');
  await page.click('#delivery .rm-note-act');
  ok(await until(async () => (await tiles()).length === 4), 'moved: a fourth tile');
  ok((await page.$eval('#input', (i) => i.value)) === '', 'the composer is empty after the move');
  ok(await until(() => page.$eval('#delivery', (d) => /Draft moved to a note/.test(d.textContent))), 'the line reads "Draft moved to a note"');
  const big = (await listed()).find((x) => x.keywords.some((k) => k.startsWith('zebra')));
  ok(!!big, 'the long note is listed');
  await page.waitForSelector('.nt-card');
  ok(await page.$eval('.nt-ta', (t) => t.value.startsWith('zebra0 zebra1')), 'the over-limit move ends with the note open in the editor');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.nt-card', { state: 'detached' });
  ok((await tiles()).length === 4, 'closing the editor adds no fifth tile (the tile was already in the tray)');

  /* 5. send with a note attached */
  console.log('\n[5] send with notes attached');
  await page.fill('#input', 'notes for you');
  await page.click('#sendBtn');
  ok(await until(() => page.evaluate(() => { const li = [...document.querySelectorAll('#line .entry.k-attachment')].pop(); return !!li && /notes for you/.test(li.textContent); }), 10000), 'the sent line shows the message with attachments');
  const sent = await page.evaluate(() => { const li = [...document.querySelectorAll('#line .entry.k-attachment')].pop(); return { chips: li ? li.querySelectorAll('.entry-att > .is-note').length : 0, inChipsRow: li ? li.querySelectorAll('.att-chips .is-note, .att-file').length : 0 }; });
  ok(sent.chips === 4 && sent.inChipsRow === 0, 'the line carries all four note attachments, in the image flow, none in the chips row', sent);
  const tilesSent = await page.evaluate(() => { const li = [...document.querySelectorAll('#line .entry.k-attachment')].pop(); return [...li.querySelectorAll('.is-note')].map((e) => { const r = e.getBoundingClientRect(); return { cls: e.className, text: [...e.childNodes].filter((c) => c.className !== 'att-sr').map((c) => c.textContent).join(''), title: e.title, label: e.getAttribute('aria-label'), sr: e.querySelector('.att-sr')?.textContent, w: Math.round(r.width), h: Math.round(r.height) }; }); });
  ok(tilesSent.length === 4 && tilesSent.every((x) => x.cls === 'is-note' && x.text === '' && x.label === 'Open note' && x.title === 'Open note' && x.w === 90 && x.h === 120), 'the sent line shows scratchpad tiles (90x120, no visible text, "Open note")', tilesSent[0]);
  ok(tilesSent.some((x) => /^Weekly review agenda/.test(x.sr ?? '')) && tilesSent.some((x) => /^A long thought about parsnips/.test(x.sr ?? '')), 'each tile carries the first words of its note for screen readers');
  ok(tilesSent.every((x) => !/note-[a-f0-9]{12}/.test(x.text + x.title + x.sr) && !/\.txt|TXT/.test(x.text + x.title + x.sr)), 'no hash filename and no TXT chip anywhere on the sent line');
  ok(await until(async () => (await tiles()).length === 0), 'the tray is empty');
  ok(uploads === 0, 'agent-share was never asked to take a note (it is down, and the send worked)', uploads);
  const entries = (await api(`/api/rooms/${R}/line?kind=attachment`)).body?.entries ?? [];
  const att0 = JSON.parse(entries[entries.length - 1]?.meta ?? '{}').attachments?.[0] ?? {};
  ok(att0.kind === 'note' && /^[a-f0-9]{12}$/.test(att0.sent_id ?? '') && !att0.url, 'the line attachment is a database note (sent_id, no agent-share url)', att0);
  const sentGet = await api(`/api/rooms/${R}/notes/sent/${att0.sent_id}`, { bearer: true });
  ok(sentGet.status === 200 && typeof sentGet.body?.text === "string" && sentGet.body.text.length > 10, "GET sent returns the text", sentGet.status);
  await page.evaluate(() => [...document.querySelectorAll('#line .entry.k-attachment')].pop().querySelector('.is-note').click());
  ok(await until(() => page.evaluate(() => /\S/.test((document.querySelector('.dv-md, .dv-pre') || {}).textContent || '')), 8000), 'tapping the sent note tile shows its text');
  await shot(page, 'pc-sent-note-open');
  await page.keyboard.press('Escape');

  /* 6. empty note */
  console.log('\n[6] empty note');
  const before = (await listed()).length;
  await menuPick(page, 'note');
  await page.waitForSelector('.nt-card');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.nt-card', { state: 'detached' });
  await sleep(600);
  ok((await listed()).length === before, 'an empty note closed without typing is not in the list');
  ok((await page.$$('#attTray .att-tile')).length === 0, 'and no tile');

  /* 7. search + archive */
  console.log('\n[7] search and archive');
  const s1 = (await api(`${N}?q=quince`, { bearer: true })).body.notes;
  ok(s1.length === 1 && s1[0].id === ID1 && /quince/i.test(s1[0].excerpt), 'q=quince finds the note with an excerpt', s1.map((x) => x.id));
  await api(`${N}/${ID1}/archive`, { json: { archived: true } });
  ok(!(await listed()).some((x) => x.id === ID1), 'archived: not in the list');
  const s2 = (await api(`${N}?q=quince`, { bearer: true })).body.notes;
  ok(s2.length === 1 && s2[0].archived === true, 'archived: found by search');
  /* 7b. a draft typed in a second browser context (same person) reaches this
     page's EMPTY composer within one or two polls, with no extra GET while idle */
  console.log('\n[7b] draft sync across devices');
  ok((await page.$eval('#input', (i) => i.value)) === '', 'the first context has an empty composer');
  const ctx2 = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await login(ctx2);
  const dev2 = await ctx2.newPage();
  await open(dev2);
  const draftGets = [];
  page.on('request', (r) => { if (/\/draft$/.test(r.url()) && r.method() === 'GET') { draftGets.push(Date.now()); } });
  await sleep(6000);
  ok(draftGets.length === 0, 'idle: no GET /draft while nothing changed', draftGets.length);
  await dev2.fill('#input', 'typed on the other device');
  const t0 = Date.now();
  const got = await until(() => page.$eval('#input', (i) => i.value === 'typed on the other device'), 6000);
  ok(got, 'the other device\'s draft appears in this composer within 6 s', `${Date.now() - t0} ms`);
  ok(draftGets.length === 1, 'and it cost exactly one GET /draft', draftGets.length);
  await dev2.fill('#input', '');
  await until(() => page.$eval('#input', (i) => i.value === ''), 6000);
  await ctx2.close();
  ok(errors.length === 0, 'no page errors on the PC', errors.slice(0, 3));
  await page.close();

  /* 8. phone */
  console.log('\n[8] phone 390x844, touch');
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await login(pctx);
  const ph = await pctx.newPage();
  const perr = [];
  ph.on('pageerror', (e) => perr.push(String(e)));
  await open(ph);
  await shot(ph, 'phone-chat');
  await ph.tap('#attBtn');
  await ph.waitForSelector('.rsm-menu');
  await shot(ph, 'phone-plus-menu');
  await ph.tap('.rsm-mi[data-a="note"]');
  await ph.waitForSelector('.nt-card.nt-chat');
  await ph.waitForTimeout(300);
  const m = await ph.evaluate(() => {
    const vis = (s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0; };
    const sc = document.getElementById('lineScroll');
    const ta = document.querySelector('.nt-ta');
    const card = document.querySelector('.nt-card').getBoundingClientRect();
    return {
      header: vis('.ph-home') || vis('.rm-top'), strip: vis('#phStrip'), compose: vis('.rm-compose'),
      focused: document.activeElement === ta, active: document.activeElement?.tagName, font: getComputedStyle(ta).fontSize,
      scrollable: sc.scrollHeight >= sc.clientHeight, chatVisible: sc.getBoundingClientRect().height > 40, cardH: Math.round(card.height), vv: Math.round(window.visualViewport.height),
      sideways: document.documentElement.scrollWidth > innerWidth,
    };
  });
  ok(!m.header && !m.strip && !m.compose, 'phone from chat: header, strip and composer are hidden', m);
  ok(m.chatVisible, 'the chat stays visible', m);
  ok(!m.focused && m.active !== 'TEXTAREA', 'nothing is focused programmatically on touch', m.active);
  ok(m.font === '16px' && !m.sideways, '16px text, no sideways scroll', m);
  await shot(ph, 'phone-editor-from-chat');
  await ph.tap('.nt-ta');
  await ph.keyboard.type('phone note about turnips');
  await ph.waitForTimeout(700);
  await shot(ph, 'phone-editor-typed');
  await ph.tap('.nt-x');
  await ph.waitForSelector('.nt-card', { state: 'detached' });
  ok(await ph.evaluate(() => getComputedStyle(document.querySelector('.rm-compose')).display !== 'none'), 'closing returns the composer');
  ok(await until(async () => (await listed()).some((x) => x.keywords.includes('turnips'))), 'the phone note was saved and indexed on close');
  ok(perr.length === 0, 'no page errors on the phone', perr.slice(0, 3));
  await ph.close();

  /* 8b. a long (500+ words) draft under the send limit: the composer offer */
  console.log('\n[8b] a 520-word draft suggests moving to a note');
  const pg = await ctx.newPage();
  await open(pg);
  const tilesBefore = (await tiles(pg)).length;
  const WORDY = Array.from({ length: 520 }, (_, i) => `ox${i % 10}`).join(' ');
  await pg.fill('#input', WORDY);
  const box = (sel) => pg.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; });
  ok(await until(() => pg.$eval('.rm-note-offer', (b) => !b.hidden && b.textContent === 'Move to a note?')), 'the composer offer reads exactly "Move to a note?"');
  ok(await pg.$eval('#delivery', (d) => d.hidden && !d.querySelector('.rm-note-act') && !/Long message/.test(d.textContent)), 'nothing on the status line');
  const offerNoTiles = await box('.rm-note-offer');
  const inputBox = await box('#input');
  ok(Math.abs(offerNoTiles.l - inputBox.l) <= 2 && offerNoTiles.b <= inputBox.t, 'no tiles: its left edge is the input left edge (within 2px) and it sits above the input', { offer: offerNoTiles, input: inputBox });
  await shot(pg, 'pc-offer-no-tiles');
  await pg.setInputFiles('#attFile', { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  ok(await until(async () => (await tiles(pg)).length === tilesBefore + 1), 'one file tile in the tray');
  ok(await until(() => pg.$eval('.rm-note-offer', (b) => b.parentElement.id === 'attTray' && b.previousElementSibling?.classList.contains('att-tile'))), 'with a tile: the offer moves into the tray, after the last tile');
  const lastTile = await pg.$$eval('#attTray .att-tile', (els) => { const r = els.at(-1).getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; });
  const offerTiles = await box('.rm-note-offer');
  ok(offerTiles.l >= lastTile.r && Math.abs((offerTiles.t + offerTiles.b) / 2 - (lastTile.t + lastTile.b) / 2) <= 3, 'with a tile: right of the last tile, centered on the tiles row (within 3px)', { offer: offerTiles, tile: lastTile });
  await shot(pg, 'pc-offer-with-tile');
  await pg.click('#attTray .att-x').catch(() => {});
  ok(await until(async () => (await tiles(pg)).length === tilesBefore), 'the file tile is removed');
  ok(await until(() => pg.$eval('.rm-note-offer', (b) => b.parentElement.id !== 'attTray')), 'tile gone: the offer returns to the input-aligned row');
  await pg.click('.rm-note-offer');
  await pg.waitForSelector('.nt-card');
  ok(await pg.$eval('.nt-ta', (t, w) => t.value === w, WORDY), 'the editor opens with the moved text');
  ok((await pg.$eval('#input', (i) => i.value)) === '', 'the composer is empty');
  ok(await until(async () => (await tiles(pg)).length === tilesBefore + 1), 'one new tile in the tray');
  await pg.keyboard.press('Escape');
  await pg.waitForSelector('.nt-card', { state: 'detached' });
  ok(await pg.$eval('.rm-note-offer', (b) => b.hidden), 'after the move the offer is hidden');
  await pg.close();
  const ph2 = await pctx.newPage();
  await open(ph2);
  await ph2.fill('#input', WORDY);
  ok(await until(() => ph2.$eval('.rm-note-offer', (b) => !b.hidden)), 'phone: the offer shows at 520 words');
  await shot(ph2, 'phone-offer-with-tile'); // the earlier move left a note tile in the tray
  await ph2.tap('#attTray .att-x');
  ok(await until(async () => (await tiles(ph2)).length === 0 && (await ph2.$eval('.rm-note-offer', (b) => b.parentElement.id !== 'attTray'))), 'phone: tile removed, the offer is back on the input row');
  const pOffer = await ph2.$eval('.rm-note-offer', (e) => { const r = e.getBoundingClientRect(); return { l: r.left, h: r.height }; });
  const pInput = await ph2.$eval('#input', (e) => e.getBoundingClientRect().left);
  ok(Math.abs(pOffer.l - pInput) <= 2 && pOffer.h >= 44, 'phone: left edge on the input, 44px hit area', { pOffer, pInput });
  await shot(ph2, 'phone-offer');
  await ph2.close();
  await pctx.close();

  /* 9. the Assets panel app (slice C), read-only, against this engine */
  const PANEL_DIR = process.env.ROOM_ASSETS_DIR;
  if (PANEL_DIR) {
    console.log('\n[9] the room-assets panel app reads these notes');
    const PANEL_PORT = P(326);
    await assertFree(PANEL_PORT, 'room-notes-e2e.probe.mjs');
    const tokenFile = join(tmpDir, 'panel.token');
    writeFileSync(tokenFile, TOKEN);
    panel = spawn(process.execPath, [join(PANEL_DIR, 'app', 'server.mjs')], {
      cwd: PANEL_DIR,
      env: childEnv({ ROOM_ASSETS_PORT: String(PANEL_PORT), HARBOR_WB_ENGINE_URL: BASE, ROOM_ASSETS_ENGINE_TOKEN_FILE: tokenFile, ROOM_ASSETS_SHARE_URL: SHARE }),
    });
    let plog = '';
    panel.stdout.on('data', (d) => (plog += d));
    panel.stderr.on('data', (d) => (plog += d));
    const PB = `http://${HOST}:${PANEL_PORT}`;
    const pup = await until(async () => (await fetch(`${PB}/health`)).ok, 10000);
    ok(pup, 'the panel app is serving', pup ? undefined : plog.slice(-300));
    if (pup) {
      const get = async (q) => (await fetch(`${PB}/rooms/${R}/notes.json${q ?? ''}`)).json();
      const eng = (await listed());
      const d = await get();
      ok(d.ok === true && Array.isArray(d.notes) && d.notes.length === eng.length && d.notes.every((n) => typeof n.id === 'string' && typeof n.updatedAt === 'number' && Array.isArray(n.keywords) && typeof n.pinned === 'boolean' && typeof n.archived === 'boolean'), 'notes.json: {ok, notes:[{id, updatedAt, pinned, archived, keywords}]} = the engine list', { n: d.notes?.length });
      const s = await get('?q=turnips');
      ok(s.ok === true && s.notes.length === 1 && typeof s.notes[0].excerpt === 'string' && /turnips/.test(s.notes[0].excerpt), 'notes.json?q=: search hits carry a plain excerpt', s.notes?.[0]);
      const a = await get('?q=quince');
      ok(a.ok === true && a.notes.length === 1 && a.notes[0].archived === true, 'an archived note is found by the panel search');
      ok(!JSON.stringify(d).includes('Pickled'), 'the list never carries note text');
    }
  }
} catch (e) {
  ok(false, `probe aborted: ${e?.stack ?? e}`);
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  if (engine && engine.exitCode === null) {
    const gone = new Promise((r) => engine.once('exit', r));
    engine.kill('SIGTERM');
    await Promise.race([gone, sleep(3000)]);
    if (engine.exitCode === null) { engine.kill('SIGKILL'); }
  }
  if (panel && panel.exitCode === null) {
    panel.kill('SIGTERM');
    await sleep(500);
    if (panel.exitCode === null) { panel.kill('SIGKILL'); }
  }
  stub.close();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log(`\nPASS ${passes} FAIL ${failures}  (screenshots: ${SHOTS})`);
process.exit(failures ? 1 : 0);
