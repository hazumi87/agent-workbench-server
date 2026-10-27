/* READ STATE ON THE ROOM LINE — room front-end order item 4 (2026-09-25;
 * engine half workrooms-build §2.7, deployed 514ee50).
 *
 *   node test/room-reads.probe.mjs
 *
 * What only a browser can prove:
 *   - an entry delivered to seats shows ONE quiet line: seen · not yet ·
 *     can't tell, and `unknown` renders as "can't tell", never as unread
 *   - entries delivered to nobody (Room facts) carry no read line
 *   - a `room.read` push updates the line in place (a member posting is the
 *     engine's "posted" evidence → seen), no reload needed
 *   - after a reload the re-GET agrees (the `reads` field is the truth)
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(62), DEAD broker P(63),
 * temp table seeded through the store (test/rooms-routes.seed.ts): no pty, no
 * broker, never Owner's data, childEnv() scrubbed, fabric + NATS off.
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
const PORT = P(62);
const DEAD_BROKER_PORT = P(63);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-reads-token';

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

/** One entry's read line as RENDERED: group state -> handles. */
const readLine = (p, id) => p.evaluate((eid) => {
  const li = document.querySelector(`#line li[data-id="${eid}"]`);
  if (!li) { return { missing: true }; }
  const el = li.querySelector(':scope > .entry-reads');
  if (!el) { return { none: true }; }
  const out = { shown: getComputedStyle(el).display !== 'none', text: el.textContent };
  for (const g of el.querySelectorAll('.rd')) {
    out[g.dataset.state] = g.textContent;
  }
  out.color = getComputedStyle(el).color;
  out.body = getComputedStyle(document.body).color;
  return out;
}, id);

try {
  const stale = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
  if (stale.ok) {
    console.log(` FAIL  :${PORT} is already serving something — a leaked engine from an aborted run?`);
    process.exit(1);
  }
} catch { /* nothing there */ }
for (const p of [PORT, DEAD_BROKER_PORT]) {
  await assertFree(p, 'room-reads.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-reads-'));
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
  const recipe = (id, name, vendor, agent) => ({ id, name, projectDir: `/srv/x/${agent}`, vendor, agent });
  await seed({
    recipes: [
      recipe('rec-lead', 'Lead', 'claude-code', 'leadp'),
      recipe('rec-b', 'Bee', 'claude-code', 'bee'),
      recipe('rec-c', 'Sea', 'codex-cli', 'sea'),
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

  const L1 = 'recipe:rec-lead';
  const B1 = 'recipe:rec-b';
  const post = await seed({
    sessions: [
      { paneid: L1, recipe_id: 'rec-lead', vendor: 'claude-code', agent: 'leadp', state: 'live' },
      { paneid: B1, recipe_id: 'rec-b', vendor: 'claude-code', agent: 'bee', state: 'live' },
    ],
    rooms: [{
      name: 'Reads Probe',
      seats: [
        { handle: 'leadp', recipe_id: 'rec-lead', occupant: L1 },
        { handle: 'bee', recipe_id: 'rec-b', occupant: B1 },
        { handle: 'sea', recipe_id: 'rec-c' },
      ],
    }],
  });
  const R = post.rooms[0].id;

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
  await sleep(2500);
  const push = await page.evaluate(() => document.body.dataset.push);
  ok(push === 'live', 'the page holds live push (room.read arrives over it)', push);

  /* 1. the user posts to the whole room from the page */
  await page.fill('#input', '@room please read this');
  await page.click('#sendBtn');
  await sleep(1500);
  const line = (await call(`/api/rooms/${R}/line?kind=chat`)).body;
  const chat = (line?.entries ?? []).find((e) => e.body === '@room please read this');
  ok(!!chat && chat.reads && Object.keys(chat.reads).sort().join(',') === 'bee,leadp,sea',
    'engine: the @room entry has reads for every other seat', chat?.reads);
  let r = await readLine(page, chat?.id);
  /* [web/room-phone-7] the read line says where each copy got to: a seat with
     no live pane has its delivery fact, so it reads "not live", not "can't tell" */
  ok(r.shown && !!r['not-live'] && r['not-live'].includes('@sea'), 'a never-started seat renders as "not live", not unread', r);
  ok(r['not-live']?.startsWith('not live'), '...with that exact wording', r['not-live']);
  ok(!(r.held || '').includes('@sea') && !(r.delivered || '').includes('@sea') && !(r.seen || '').includes('@sea'), '...and appears in no other group', r);
  ok(r.color !== r.body, 'the read line is dim, not body text (computed)', { line: r.color, body: r.body });

  /* 2. facts carry no read line */
  const facts = await page.evaluate(() => [...document.querySelectorAll('#line li[data-kind="fact"]')]
    .map((li) => !!li.querySelector(':scope > .entry-reads')));
  ok(facts.length === 0 || facts.every((x) => !x), 'Room facts (delivered to nobody) carry no read line', facts);

  /* 3. bee POSTS a later entry = the engine's "posted" evidence → seen, pushed */
  const before = r;
  const bp = await call(`/api/rooms/${R}/line`, { json: { text: '@leadp got it', from: { paneid: B1 } } });
  ok(bp.status === 200, 'setup: @bee posts from its pane', bp.status);
  await sleep(1500);
  r = await readLine(page, chat?.id);
  ok((r.seen || '').includes('@bee'), 'the room.read push moves @bee to "seen" in place, no reload', { before: before.text, after: r.text });
  ok(!(r.held || '').includes('@bee') && !(r.delivered || '').includes('@bee') && !(r.unknown || '').includes('@bee'), '...and out of its old group', r);
  const beeLine = await readLine(page, (await call(`/api/rooms/${R}/line?kind=chat`)).body.entries.find((e) => e.body === '@leadp got it')?.id);
  ok(!(beeLine.text || '').includes('@bee'), 'an entry never lists its own author as a reader', beeLine.text);

  /* 4. reload: the re-GET agrees */
  const snapshot = r.text;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2500);
  r = await readLine(page, chat?.id);
  ok((r.seen || '').includes('@bee') && (r['not-live'] || '').includes('@sea'), 'after a reload the re-GET shows the same answers', { before: snapshot, after: r.text });

  ok(errors.length === 0, 'no page errors', errors.slice(0, 3));
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
