/* @NAMES IN THE LINE + YOUR @NAME (Owner 2026-09-28: "color the @ names in the
 * chat text with their color. Let's give the user an @ name too ... the
 * setting should be in settings for app wide ... the color be based on the
 * room color").
 *
 *   node test/room-mentions.probe.mjs
 *
 * Proves, on the real engine (a scratch one) in a real Chromium:
 *   - "Your @name" is now edited in global Settings, not the room (Owner
 *     2026-09-30) -- the engine's own validation still refuses a seat's
 *     handle; the room's gear panel shows only a "Settings ›" link (no
 *     picture/handle editor), which opens Settings at #you. The editor
 *     itself is covered by settings-page.probe.mjs and room-authorship.probe.mjs
 *   - an agent (bearer + from) posting "@owner ..." is accepted (not refused)
 *     and stored to the user; the page marks it as to the user
 *   - in a line's TEXT, colours compared by PAINTING to a canvas: a seat's
 *     @handle = that seat's derived project ink (L .82); @lead = the lead's;
 *     a seat with no colour = the plain text colour (never the author's);
 *     YOUR @name = the ROOM's ink (--rc-ink); an unknown @word = plain text
 *   - the same on your own lines; line breaks survive; markup in a message is
 *     text, never elements
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(118), DEAD broker P(119).
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
const PORT = P(118);
const DEAD_BROKER_PORT = P(119);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-mentions-token';
const SHOTS = process.env.MENTIONS_SHOTS || tmpdir();
const LEAD_COLOR = '#0317b0';
const BEE_COLOR = '#0dab49';
const ROOM_COLOR = '#d9622b'; // distinct from both seats, so "the room's ink" is provable

let failures = 0;
let passes = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}${detail !== undefined ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
  if (cond) { passes += 1; } else { failures += 1; }
};
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
  await assertFree(p, 'room-mentions.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-mentions-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null;
let browser = null;
let engineLog = '';
const seed = async (plan) => {
  const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
  return JSON.parse(r.out.trim().split('\n').pop());
};
const call = async (path, init = {}) => {
  const res = await fetch(BASE + path, { ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers || {}) } });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
};

/* In the page: paint a CSS colour to a 1x1 canvas and read the pixel back
   (a computed oklch() string is never parsed). */
const COLOR_KIT = () => {
  window.__px = (css) => {
    const d = document.createElement('div');
    d.style.color = css;
    document.body.append(d);
    const resolved = getComputedStyle(d).color;
    d.remove();
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    const x = c.getContext('2d');
    x.fillStyle = resolved;
    x.fillRect(0, 0, 1, 1);
    return [...x.getImageData(0, 0, 1, 1).data];
  };
};
const same = (a, b) => !!a && !!b && a.every((v, i) => Math.abs(v - b[i]) <= 2);

try {
  const recipe = (id, name, agent, color) => ({ id, name, projectDir: `/srv/x/${agent}`, vendor: 'claude-code', agent, color });
  await seed({ recipes: [recipe('rec-lead', 'Lead', 'leadp', LEAD_COLOR), recipe('rec-b', 'Bee', 'bee', BEE_COLOR), recipe('rec-c', 'Sea', 'sea', null)] });
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

  const L1 = 'recipe:rec-lead';
  const B1 = 'recipe:rec-b';
  const post = await seed({
    sessions: [
      { paneid: L1, recipe_id: 'rec-lead', vendor: 'claude-code', agent: 'leadp', state: 'live' },
      { paneid: B1, recipe_id: 'rec-b', vendor: 'claude-code', agent: 'bee', state: 'live' },
    ],
    rooms: [{ name: 'Mentions', seats: [{ handle: 'leadp', recipe_id: 'rec-lead', occupant: L1 }, { handle: 'bee', recipe_id: 'rec-b', occupant: B1 }, { handle: 'sea', recipe_id: 'rec-c' }] }],
  });
  const R = post.rooms[0].id;

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(COLOR_KIT);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  await page.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  /* the room's own colour, on the window's cookie (a person's setting) */
  const rc = await page.evaluate(async ({ id, color }) => (await fetch(`/api/rooms/${id}/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ color }) })).status, { id: R, color: ROOM_COLOR });
  ok(rc === 200, 'setup: the room colour is set', rc);

  /* ---- "Your @name": edited in global Settings now (Owner 2026-09-30), not
     the room. The room's own gear panel just points there (see the
     dedicated settings-page.probe.mjs and room-authorship.probe.mjs for the
     editor itself). Here: the engine's own validation still holds (a seat's
     handle is refused), reached directly since there is no room-side UI for
     it any more; and the room's gear panel shows the link, not the editor. */
  const bearerWrite = await call('/api/rooms/me', { method: 'PATCH', body: JSON.stringify({ handle: 'owner' }) });
  ok(bearerWrite.status === 403, 'a bearer-only PATCH {handle}: 403', bearerWrite.status);
  const asPerson = (body) => page.evaluate((b) => fetch('/api/rooms/me', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json().then((j) => ({ status: r.status, body: j }))), body);
  const seatConflict = await asPerson({ handle: 'bee' });
  ok(seatConflict.status === 409 && /seat/.test(seatConflict.body?.error ?? ''), "the engine refuses a seat's handle (no room UI needed to prove it)", seatConflict);
  const set = await asPerson({ handle: '@Owner' });
  ok(set.status === 200 && set.body?.handle === 'owner', 'Save: normalised to "owner", on the window cookie', set);
  ok((await call('/api/rooms/me')).body?.handle === 'owner', '...and the engine holds it');
  /* the room page's own `state.me` only refreshes at boot (no live push for a
     change made outside its own UI, same as the picture -- room-authorship.
     probe.mjs), so a reload is what lets @owner mentions wear the room's ink
     below */
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2000);

  await page.click('#gearBtn');
  await sleep(400);
  const youDoor = () => page.evaluate(() => ({
    noPicField: !document.querySelector('.pv-set .pv-picacts'),
    noHandleField: !document.getElementById('meHandle'),
    link: document.querySelector('.pv-set a[href="/settings.html#you"]')?.textContent ?? null,
  }));
  const yd = await youDoor();
  ok(yd.noPicField && yd.noHandleField && yd.link, 'room settings: no picture/handle editor any more, just a "Settings ›" link', yd);
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.click('.pv-set a[href="/settings.html#you"]'),
  ]);
  await popup.waitForLoadState('domcontentloaded').catch(() => {});
  ok(new URL(popup.url()).hash === '#you', 'the link opens Settings at #you', popup.url());
  await popup.close();
  await page.click('#gearBtn');
  await sleep(300);

  /* ---- the line ---- */
  const AGENT = '@owner hi. @leadp and @sea should look, @nobody knows, ask @lead; mail noreply@example.com\nsecond line <b>@bee</b>';
  const r1 = await call(`/api/rooms/${R}/line`, { method: 'POST', body: JSON.stringify({ text: AGENT, from: { paneid: B1 } }) });
  ok(r1.status === 200 && r1.body?.status !== 'refused', 'an agent (bearer + from) posts "@owner hi ...": accepted', { status: r1.status, line: r1.body?.status, error: r1.body?.refused?.error });
  const e1 = r1.body?.entries?.[0];
  ok(e1?.target === 'owner' && e1?.target_seat === null, '...stored as addressed to the user (target @owner, no seat)', { target: e1?.target, seat: e1?.target_seat });
  await page.fill('#input', 'thanks @bee, and @owner is me; @ghost is nobody');
  await page.click('#sendBtn');
  await sleep(3000); // a poll: the roster and recipe colours are current

  const read = await page.evaluate(({ lead, bee, room }) => {
    const entries = [...document.querySelectorAll('#line > .entry')];
    const agent = entries.find((li) => li.querySelector('.entry-body')?.textContent.startsWith('@owner hi.'));
    const mine = entries.find((li) => li.querySelector('.entry-body')?.textContent.startsWith('thanks @bee'));
    const spans = (li) => Object.fromEntries([...li.querySelectorAll('.entry-body .mention')].map((s) => [s.textContent, window.__px(getComputedStyle(s).color)]));
    const body = agent.querySelector('.entry-body');
    const range = document.createRange();
    const texts = [...body.childNodes].filter((n) => n.nodeType === 3);
    const lineTwo = texts.find((n) => n.data.includes('second line'));
    range.setStart(lineTwo, lineTwo.data.indexOf('second'));
    range.setEnd(lineTwo, lineTwo.data.indexOf('second') + 6);
    const first = agent.querySelector('.entry-body .mention');
    return {
      agentText: body.textContent,
      agentSpans: spans(agent),
      mineSpans: spans(mine),
      elems: [...body.querySelectorAll('*')].map((n) => n.tagName.toLowerCase() + (n.className ? `.${n.className}` : '')),
      twoLines: range.getBoundingClientRect().top > first.getBoundingClientRect().bottom - 1,
      plain: window.__px(getComputedStyle(body).color),
      mineplain: window.__px(getComputedStyle(mine.querySelector('.entry-body')).color),
      textTone: window.__px('var(--text)'),
      leadInk: window.__px(`oklch(from ${lead} .82 clamp(.02, calc(c * .6), .13) h)`),
      beeInk: window.__px(`oklch(from ${bee} .82 clamp(.02, calc(c * .6), .13) h)`),
      roomInk: window.__px(`oklch(from ${room} .82 clamp(.02, calc(c * .6), .13) h)`),
      authorName: window.__px(getComputedStyle(agent.querySelector('.entry-author')).color),
      toUser: agent.dataset.toUser,
    };
  }, { lead: LEAD_COLOR, bee: BEE_COLOR, room: ROOM_COLOR });
  const AS = read.agentSpans;
  ok(read.agentText === AGENT, 'the body text is exactly what was posted', read.agentText);
  ok(same(AS['@leadp'], read.leadInk), "a seat's @handle = that seat's derived project ink (L .82) — painted", { got: AS['@leadp'], want: read.leadInk });
  ok(same(AS['@lead'], read.leadInk), '@lead = the current lead seat\'s tone', { got: AS['@lead'], want: read.leadInk });
  ok(same(AS['@owner'], read.roomInk) && !same(read.roomInk, read.leadInk) && !same(read.roomInk, read.beeInk), 'YOUR @name = the ROOM\'s ink (--rc-ink) — painted', { got: AS['@owner'], want: read.roomInk });
  ok(same(AS['@nobody'], read.plain), 'an unknown @word = the plain text colour', { got: AS['@nobody'], plain: read.plain });
  ok(same(AS['@sea'], read.textTone) && same(read.authorName, read.beeInk) && !same(AS['@sea'], read.beeInk), "a seat with no project colour = plain text (never the AUTHOR's colour)", { sea: AS['@sea'], author: read.authorName });
  ok(!('@example' in AS) && !Object.keys(AS).some((k) => k.includes('example')), 'an email address is not a mention', Object.keys(AS));
  ok(same(AS['@bee'], read.beeInk), '...and an @handle inside markup is still just text, toned', AS['@bee']);
  ok(read.elems.every((t) => t === 'span.mention'), 'markup in a message stays text: the only elements are mention spans', read.elems);
  ok(read.agentText.includes('<b>@bee</b>'), '...the "<b>" is shown as typed', read.agentText.slice(-20));
  ok(read.twoLines, 'a line break in the message still breaks the line');
  ok(read.toUser === '1', 'the page marks the @owner line as to the user', read.toUser);
  const MS = read.mineSpans;
  ok(same(MS['@bee'], read.beeInk) && same(MS['@owner'], read.roomInk) && same(MS['@ghost'], read.mineplain), 'your own lines too: seat = its ink, you = room ink, unknown = plain', MS);

  /* the "to me" filter now includes a line addressed to you */
  await pickWho(page, 'me');
  await sleep(300);
  const shown = await page.evaluate(() => [...document.querySelectorAll('#line > .entry')].filter((li) => getComputedStyle(li).display !== 'none').map((li) => li.querySelector('.entry-body')?.textContent.slice(0, 9)));
  ok(shown.includes('@owner hi.'), '"to me" shows an agent line addressed to @owner', shown);
  await pickWho(page, '');
  await page.screenshot({ path: join(SHOTS, 'room-mentions-desktop.png') });

  ok(errors.length === 0, 'no page errors', errors);
} catch (e) {
  ok(false, `threw: ${e?.stack ?? e}`);
} finally {
  await browser?.close().catch(() => {});
  if (engine) {
    engine.kill('SIGKILL');
    await sleep(200);
  }
  rmSync(tmpDir, { recursive: true, force: true });
  if (failures) {
    console.log(`\nengine log (tail):\n${engineLog.split('\n').slice(-30).join('\n')}`);
  }
  console.log(`\nPASS ${passes}  FAIL ${failures}`);
  process.exit(failures ? 1 : 0);
}
