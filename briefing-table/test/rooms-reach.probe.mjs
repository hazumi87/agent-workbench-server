/* ROOMS REACHABLE WITHOUT CURL — room front-end order item 1 (2026-09-25,
 * workrooms.md §2.10 handover to cli-manager).
 *
 *   node test/rooms-reach.probe.mjs
 *
 * What only a browser can prove:
 *   - the manager lists GET /api/rooms, and "New room" creates one and opens it
 *   - inside the shell, Open mounts the room as a WORKROOM tab (the chrome's
 *     WR1-B plate, asserted on the rendered SVG, not on a class we set)
 *   - a second Open focuses that tab instead of adding one (room.html names
 *     itself room:<id>), and the tab carries the room's name
 *   - a reload restores the tab and it is still a workroom
 *   - at phone width the section does not push the page sideways
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(52), DEAD broker port
 * P(53), temp table, known token in a temp file, childEnv() (PTY_BROKER_* /
 * HARBOR_WB_* scrubbed, fabric + NATS off). Never :7420/:7430/:8200/:8201/:8204,
 * never Owner's data. Every room it makes lives in the temp table, which is
 * removed. Headless Chromium is right here: nothing is scrollbar- or
 * screen-shaped (real-Edge checks are vrpc1's Windows run).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = P(52);
const DEAD_BROKER_PORT = P(53); // told to the engine; nothing may listen there
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-rooms-reach-token';
const SHELL = `${BASE}/app/shell.html?kind=manager&debug=1`;

let failures = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (!cond) { failures += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The shell's tabs as RENDERED: frames, chip names, and whether each chip's
 *  glyph carries the workroom folder plate. */
const readShell = (p) => p.evaluate(() => ({
  where: location.pathname,
  frames: [...document.querySelectorAll('#stage iframe')].map((f) => ({
    src: f.getAttribute('src') || '',
    shown: getComputedStyle(f).display !== 'none',
  })),
  chips: [...document.querySelectorAll('.hwb-tabs .hwb-tab[data-tab]')].map((el) => {
    const body = el.querySelector('.ring svg .rg-wbody');
    return {
      name: el.querySelector('.tname')?.textContent || '',
      plate: !!body && getComputedStyle(body).display !== 'none',
      /* identity: a room with no lead is NEUTRAL — no watermark, no project base */
      logo: (el.querySelector('.tlogo')?.innerHTML || '').trim(),
      base: el.style.getPropertyValue('--base').trim(),
    };
  }),
}));

const managerFrame = (p) => p.frames().find((f) => /\/manager\.html/.test(f.url()));

try {
  const stale = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
  if (stale.ok) {
    console.log(` FAIL  :${PORT} is already serving something — a leaked engine from an aborted run?`);
    process.exit(1);
  }
} catch { /* nothing there: what we want */ }
for (const p of [PORT, DEAD_BROKER_PORT]) {
  await assertFree(p, 'rooms-reach.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-rooms-reach-'));
let engine = null;
let browser = null;
let engineLog = '';

try {
  engine = spawn(process.execPath, ['--import', 'tsx', join(REPO_ROOT, 'src', 'server', 'index.ts')], {
    cwd: REPO_ROOT,
    env: childEnv({
      HARBOR_WB_PORT: String(PORT),
      HARBOR_WB_HOST: '127.0.0.1',
      HARBOR_WB_TABLE: join(tmpDir, 'mapping.db'),
      HARBOR_WB_NO_WINDOW: '1',
      HARBOR_WB_NATS_URL: '',
      HARBOR_WB_FABRIC_URL: '',
      HARBOR_WB_BROKER_AUTOSTART: '0',
      HARBOR_WB_BROKER_PORT: String(DEAD_BROKER_PORT),
      HARBOR_WB_CLAUDE_PROJECTS: join(tmpDir, 'claude-projects'),
      HARBOR_WB_TOKEN: TOKEN,
      HARBOR_WB_TOKEN_FILE: join(tmpDir, 'engine.token'),
    }),
  });
  engine.stdout.on('data', (d) => { engineLog += d; });
  engine.stderr.on('data', (d) => { engineLog += d; });
  let up = false;
  for (let i = 0; i < 80; i += 1) {
    await sleep(250);
    try { if ((await fetch(`${BASE}/health`)).ok) { up = true; break; } } catch { /* not yet */ }
  }
  ok(up, `scratch engine is serving on ${PORT}`, up ? undefined : engineLog.slice(-400));
  if (!up) { throw new Error('engine never came up'); }

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    const f = document.querySelector('form');
    (f.querySelector('input[name=token]') || f.querySelector('input')).value = t;
  }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  ok(!page.url().includes('/login'), 'signed in to the scratch engine', page.url().replace(BASE, ''));

  /* ---------------------------------------------------------------------
     1. STANDALONE MANAGER: the section is there with no rooms, and "New room"
        creates one and opens it in a new browser tab. */
  await page.goto(`${BASE}/manager.html`, { waitUntil: 'domcontentloaded' });
  await sleep(900);
  const empty = await page.evaluate(() => ({
    shown: getComputedStyle(document.getElementById('roomsWrap')).display !== 'none',
    rows: document.querySelectorAll('#roomList .rcard').length,
    form: !!document.getElementById('roomNewForm'),
    card: !!document.querySelector('#roomList > #roomNewCard'),
  }));
  ok(empty.shown && empty.form && empty.card, 'the Rooms section renders with zero rooms, ending in the "+ New room" card', empty);
  ok(empty.rows === 0, '...and list no rows', empty.rows);

  await page.click('#roomNewCard');
  await page.fill('#roomNewName', '');
  await page.click('#roomNewBtn');
  await sleep(300);
  const created0 = await (await fetch(`${BASE}/api/rooms`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  ok(Array.isArray(created0) && created0.length === 0, 'an empty name creates nothing', created0.length);

  await page.fill('#roomNewName', 'Probe room A');
  const [popup] = await Promise.all([
    context.waitForEvent('page', { timeout: 5000 }).catch(() => null),
    page.click('#roomNewBtn'),
  ]);
  ok(!!popup && /\/room\.html\?room=/.test(popup.url()), 'New room opens the new room (standalone: a browser tab)',
    popup ? popup.url().replace(BASE, '') : 'no popup');
  if (popup) {
    await popup.waitForLoadState('domcontentloaded');
    await sleep(900);
    ok((await popup.title()) === 'Probe room A · Workroom', '...showing that room (the tab names it; the room bar says where you are, not the name)', await popup.title());
    await popup.close();
  }
  await sleep(600);
  const rowsA = await page.evaluate(() => [...document.querySelectorAll('#roomList .rcard')].map((r) => ({
    name: r.querySelector('.rc-nm').childNodes[0].textContent,
    meta: r.querySelector('.rc-sub').textContent,
    plate: !!r.querySelector('.rc-g svg .rg-wbody'),
  })));
  ok(rowsA.length === 1 && rowsA[0].name === 'Probe room A', 'the manager lists the new room', rowsA);
  ok(rowsA[0]?.plate, '...wearing the workroom plate');
  ok(/0 seats · no lead/.test(rowsA[0]?.meta || ''), '...with its seat count and "no lead"', rowsA[0]?.meta);
  ok(await page.evaluate(() => document.getElementById('roomNewName').value === ''), 'the name field clears after a create');

  /* a second room through the API, archived: listed after the open one, dimmed */
  const hdr = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  /* a room write as the USER takes a person: the window cookie, no bearer [ticket] */
  const userHdr = { cookie: await windowCookie(BASE, TOKEN), 'content-type': 'application/json' };
  const rb = await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: userHdr, body: JSON.stringify({ name: 'Aardvark archived' }) })).json();
  const roomB = rb?.room?.id ? rb.room : rb;
  await fetch(`${BASE}/api/rooms/${roomB.id}/archive`, { method: 'POST', headers: userHdr, body: '{}' });
  await sleep(3000); // one manager poll
  const rowsB = await page.evaluate(() => [...document.querySelectorAll('#roomList .rcard')].map((r) => ({
    name: r.querySelector('.rc-nm').childNodes[0].textContent,
    opacity: getComputedStyle(r).opacity,
    nameFont: getComputedStyle(r.querySelector('.rc-nm')).fontFamily,
    folder: getComputedStyle(r.querySelector('.rc-g .rg-wbody')).opacity,
    openOpacity: getComputedStyle(r.querySelector('[data-act="open-room"]')).opacity,
  })));
  ok(rowsB.length === 2 && rowsB[0].name === 'Probe room A' && rowsB[1].name === 'Aardvark archived',
    'open rooms sort before archived ones (not alphabetically across states)', rowsB.map((r) => r.name));
  ok(Number(rowsB[1]?.folder) < 1 && Number(rowsB[0]?.folder) === 1,
    '...the archived room\'s folder glyph is dimmed, the open one is not (computed)', rowsB.map((r) => r.folder));
  ok(rowsB[1]?.opacity === '1' && rowsB[1]?.openOpacity === '1',
    '...but not the whole row: the row and its Open stay full strength (Auriga: ended dimming)', rowsB[1]);
  ok(rowsB[1]?.nameFont === rowsB[0]?.nameFont && !/mono/i.test(rowsB[1]?.nameFont || ''),
    '...and the archived name keeps the row font, not the session mono', rowsB.map((r) => r.nameFont));
  const inp = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById('roomNewName'));
    return { radius: cs.borderTopLeftRadius, style: cs.borderTopStyle, font: cs.fontFamily };
  });
  ok(inp.radius !== '0px' && inp.style === 'solid' && !/^Arial/i.test(inp.font),
    'the New-room field is styled like the form fields (radius, solid border, UI font)', inp);

  /* ---------------------------------------------------------------------
     2. INSIDE THE SHELL: Open mounts a WORKROOM tab. */
  await page.goto(SHELL, { waitUntil: 'domcontentloaded' });
  await sleep(1500);
  let mf = managerFrame(page);
  ok(!!mf, 'the shell hosts the manager as its hub tab');
  await mf.waitForSelector('#roomList .rcard [data-act="open-room"]', { timeout: 5000 });
  await mf.click('#roomList .rcard:first-child [data-act="open-room"]');
  await sleep(1800);
  let s = await readShell(page);
  const roomFrames = () => s.frames.filter((f) => /\/room\.html\?room=/.test(f.src));
  ok(roomFrames().length === 1 && roomFrames()[0].shown, 'Open mounts the room as a tab, and shows it', s.frames);
  ok(s.chips.length === 1 && s.chips[0].plate, 'the room tab wears the workroom plate (rendered SVG)', s.chips);
  ok(s.chips[0]?.name === 'Probe room A', 'the tab is labelled with the room name', s.chips[0]?.name);
  ok(s.chips[0]?.logo === '' && s.chips[0]?.base === '#5a6672',
    'a room with no lead is a NEUTRAL tab: no watermark, the neutral base (Auriga ruling)', s.chips[0]);

  /* 3. A SECOND OPEN FOCUSES, never duplicates. Go back to the hub first. */
  await page.evaluate(() => document.querySelector('.hwb-tab.is-hub')?.click());
  await sleep(400);
  mf = managerFrame(page);
  await mf.click('#roomList .rcard:first-child [data-act="open-room"]');
  await sleep(1200);
  s = await readShell(page);
  ok(roomFrames().length === 1, 'a second Open does not add a second tab', s.frames.length);
  ok(roomFrames()[0]?.shown, '...it brings the existing room tab forward');

  /* 4. CREATE FROM INSIDE THE SHELL opens the new room as a tab too. */
  await page.evaluate(() => document.querySelector('.hwb-tab.is-hub')?.click());
  await sleep(400);
  mf = managerFrame(page);
  await mf.click('#roomNewCard');
  await mf.fill('#roomNewName', 'Probe room C');
  await mf.click('#roomNewBtn');
  await sleep(1800);
  s = await readShell(page);
  ok(roomFrames().length === 2 && s.chips.some((c) => c.name === 'Probe room C' && c.plate),
    'New room inside the shell opens a second workroom tab', s.chips);

  /* 5. RELOAD: the tabs come back and are still workrooms (the kind is derived
        from the URL, so the tab-set format did not change). */
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2000);
  s = await readShell(page);
  ok(roomFrames().length === 2, 'both room tabs are restored after a reload', s.frames.length);
  ok(s.chips.filter((c) => c.plate).length === 2, '...and still draw as workrooms', s.chips);
  ok(s.chips.every((c) => c.logo === '' && c.base === '#5a6672'), '...still neutral after the restore', s.chips);

  /* 5b. A LEAD GIVES THE ROOM TAB ITS IDENTITY (item 3; the design system ruling: the
         lead project's mark, same formula as session tabs). A saved session
         with a colour and a preset logo becomes the first persistent seat of
         room A; the tab then wears that colour and that mark. */
  const presetKey = await page.evaluate(async () => Object.keys((await import('/vendor/aurora-logo-presets.js')).LOGO_PRESETS || {})[0] || null);
  const recRes = await fetch(`${BASE}/api/recipes`, { method: 'POST', headers: hdr,
    body: JSON.stringify({ name: 'Lead Project', target: 'local', projectDir: null, color: '#3b82f6', logo: JSON.stringify({ key: presetKey }) }) });
  const recBody = await recRes.json().catch(() => null);
  const leadRecipe = recBody?.recipe?.id || recBody?.id;
  const roomA = (await (await fetch(`${BASE}/api/rooms`, { headers: hdr })).json()).find((v) => v.room.name === 'Probe room A')?.room;
  const seatRes = await fetch(`${BASE}/api/rooms/${roomA?.id}/seats`, { method: 'POST', headers: userHdr, body: JSON.stringify({ recipe_id: leadRecipe }) });
  ok(!!presetKey && !!leadRecipe && seatRes.ok, 'setup: a saved session with a colour + preset logo is seated in room A', { presetKey, leadRecipe, seat: seatRes.status });
  await sleep(3500); // the room page's 2.5 s poll
  s = await readShell(page);
  const chipA = s.chips.find((c) => c.name === 'Probe room A');
  const chipC = s.chips.find((c) => c.name === 'Probe room C');
  ok(chipA?.base === '#3b82f6', 'with a lead, the room tab takes the lead project\'s colour', chipA?.base);
  ok(!!chipA?.logo && /<svg/i.test(chipA.logo), '...and its mark as the watermark', (chipA?.logo || '').slice(0, 40));
  ok(chipA?.plate, '...and still draws the workroom plate, not a brand plate');
  ok(chipC?.logo === '' && chipC?.base === '#5a6672', 'the room with no lead stays neutral', chipC);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2500);
  s = await readShell(page);
  ok(s.chips.find((c) => c.name === 'Probe room A')?.base === '#3b82f6', 'after a reload the room page re-sends it: the lead identity comes back',
    s.chips.find((c) => c.name === 'Probe room A'));

  ok(pageErrors.length === 0, 'no page errors in the shell', pageErrors.slice(0, 3));

  /* ---------------------------------------------------------------------
     6. PHONE WIDTH: the section does not widen the page, and the create
        controls keep the 40px touch floor. */
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await context.storageState() });
  const pp = await phone.newPage();
  await pp.goto(`${BASE}/manager.html`, { waitUntil: 'domcontentloaded' });
  await sleep(1200);
  await pp.click('#roomNewCard');
  await sleep(200);
  const m = await pp.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    inputH: document.getElementById('roomNewName').getBoundingClientRect().height,
    btnH: document.getElementById('roomNewBtn').getBoundingClientRect().height,
    openRight: Math.max(...[...document.querySelectorAll('#roomList [data-act="open-room"]')].map((b) => b.getBoundingClientRect().right)),
  }));
  ok(m.scrollW <= m.innerW, 'no horizontal scroll at 390px', m);
  ok(m.inputH >= 40 && m.btnH >= 40, 'New-room controls keep the 40px touch floor', { input: m.inputH, btn: m.btnH });
  ok(m.openRight <= m.innerW, 'every Open button is fully on screen', m.openRight);
  await phone.close();
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
