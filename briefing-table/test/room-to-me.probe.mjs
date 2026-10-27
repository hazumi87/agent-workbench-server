/* THE LINE'S "TO ME" (Owner 2026-09-28): an agent answering the user with
 * "@user ..." or "@owner ..." did not show under To me; he had to pick
 * Everyone.
 *
 *   node test/room-to-me.probe.mjs
 *
 * What only a browser can prove, through the real page against a real engine:
 *   - To me shows an agent's "@user ..." and "@owner ..." lines (bearer + from),
 *     an agent line that names the user mid-text, one that names the user AND
 *     a seat;
 *   - an agent's REPLY to a line the user wrote but ADDRESSED to another seat
 *     ("@leader the second one…") is NOT to me: a quote never counts (Owner
 *     [ref], reversing 2026-09-28); it shows under Between agents;
 *   - Between agents excludes every line to me, and still shows plain
 *     seat-to-seat lines;
 *   - To me still excludes plain seat-to-seat lines.
 *
 * A PROBE, not in `npm test`. OWN scratch engine on P(200), DEAD broker P(201),
 * temp table seeded through the store (test/rooms-routes.seed.ts): never Owner's
 * data, childEnv() scrubbed, fabric + NATS off.
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
const PORT = P(200);
const DEAD_BROKER_PORT = P(201);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-to-me-token';

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
  await assertFree(p, 'room-to-me.probe.mjs');
}

const tmpDir = mkdtempSync(join(tmpdir(), 'wb-room-to-me-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null;
let browser = null;
let engineLog = '';
const seed = async (plan) => {
  const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
  if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
  return JSON.parse(r.out.trim().split('\n').pop());
};

try {
  const recipe = (id, name, agent, color) => ({ id, name, projectDir: `/srv/x/${agent}`, vendor: 'claude-code', agent, color });
  await seed({ recipes: [recipe('rec-lead', 'Leader', 'leader', '#ba08b4'), recipe('rec-bee', 'Bee', 'bee', '#0dab49')] });

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

  const LEAD = 'recipe:rec-lead';
  const BEE = 'recipe:rec-bee';
  const live = (paneid, rid, agent) => ({ paneid, recipe_id: rid, vendor: 'claude-code', agent, state: 'live' });
  const seeded = await seed({
    sessions: [live(LEAD, 'rec-lead', 'leader'), live(BEE, 'rec-bee', 'bee')],
    rooms: [{
      name: 'To Me Probe',
      seats: [
        { handle: 'leader', recipe_id: 'rec-lead', occupant: LEAD },
        { handle: 'bee', recipe_id: 'rec-bee', occupant: BEE },
      ],
    }],
  });
  const R = seeded.rooms[0].id;
  const me = await call('/api/rooms/me', { method: 'PATCH', json: { handle: 'owner' } });
  ok(me.body?.handle === 'owner', 'setup: the user\'s @name is owner', me.body);

  const post = (text, from, extra = {}) => call(`/api/rooms/${R}/line`, { json: { text, ...(from ? { from: { paneid: from } } : {}), ...extra } });
  const u1 = await post('which build should we ship?');
  const uid = u1.body?.entries?.[0]?.id;
  const lines = {
    atUser: await post('@user the build is green', BEE),
    atOwner: await post('@owner ready for your review', LEAD),
    midUser: await post('done, over to @user for the call', BEE),
    userAndSeat: await post('@leader @user both of you: the fix is in', BEE),
    reply: await post('@leader the second one, it has the fix', BEE, { reply_to: uid }),
    agents1: await post('@bee please rebase first', LEAD),
    agents2: await post('@leader rebased, over to you', BEE),
  };
  ok(u1.status === 200 && Object.values(lines).every((r) => r.status === 200 && r.body?.status !== 'refused'), 'setup: every line posted (bearer + from for the agents)',
    Object.fromEntries(Object.entries(lines).map(([k, r]) => [k, `${r.status} ${r.body?.status} ${r.body?.error ?? ''}`])));

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
  await Promise.all([page.waitForNavigation().catch(() => {}), page.click('form button:visible')]);
  await page.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#line .entry');
  await sleep(1500);

  const shown = () => page.evaluate(() => [...document.querySelectorAll('#line > .entry')].filter((li) => getComputedStyle(li).display !== 'none')
    .map((li) => li.querySelector('.entry-body')?.textContent ?? ''));
  const pick = async (who) => {
    await page.click('#filterBtn');
    await sleep(150);
    await page.click(`#filterMenu [data-who="${who}"]`);
    await sleep(200);
    await page.keyboard.press('Escape');
    await sleep(100);
    return shown();
  };
  const has = (v, s) => v.some((b) => b.includes(s));

  const all = await pick('');
  ok(['the build is green', 'ready for your review', 'over to @user', 'both of you', 'the second one', 'rebase first', 'rebased, over'].every((s) => has(all, s)), 'Everyone shows every line', all);

  const facts = () => page.evaluate(() => [...document.querySelectorAll('#line > .entry[data-kind="fact"]')].filter((li) => getComputedStyle(li).display !== 'none').length);
  const factsAll = await facts();
  const toMe = await pick('me');
  const factsMe = await facts();
  ok(factsAll > 0 && factsMe === factsAll, 'To me: room facts (seats added, apps approved) stay visible (Owner 2026-09-30)', { factsAll, factsMe });
  ok(has(toMe, '@user the build is green'), 'To me: an agent\'s "@user ..." line', toMe);
  ok(has(toMe, '@owner ready for your review'), 'To me: an agent\'s "@owner ..." line', toMe);
  ok(has(toMe, 'over to @user for the call'), 'To me: an agent line naming @user mid-text', toMe);
  ok(has(toMe, 'both of you: the fix is in'), 'To me: an agent line to a seat AND @user', toMe);
  ok(!has(toMe, 'the second one, it has the fix'), 'To me: an agent\'s reply to my line addressed to the lead stays out (a quote never counts, [ref])', toMe);
  ok(has(toMe, 'which build should we ship?'), 'To me: my own line (unchanged)', toMe);
  ok(!has(toMe, 'rebase first') && !has(toMe, 'rebased, over to you'), 'To me: plain seat-to-seat lines stay out', toMe);

  const agents = await pick('agents');
  ok(has(agents, 'rebase first') && has(agents, 'rebased, over to you'), 'Between agents: plain seat-to-seat lines', agents);
  ok(!['the build is green', 'ready for your review', 'over to @user', 'both of you'].some((s) => has(agents, s)), 'Between agents: none of the lines to me', agents);
  ok(has(agents, 'the second one, it has the fix'), 'Between agents: the reply to my line that was addressed to the lead ([ref])', agents);

  const flags = await page.evaluate(() => [...document.querySelectorAll('#line > .entry')].map((li) => ({ b: li.querySelector('.entry-body')?.textContent ?? '', to: li.dataset.toUser, re: li.dataset.replyUser })));
  ok(flags.find((f) => f.b.includes('both of you'))?.to === '1', '...the user+seat line is flagged from meta.to_user, not inferred from its target', flags.find((f) => f.b.includes('both of you')));
  const tones = await page.evaluate(() => [...document.querySelectorAll('#line .mention')].map((m) => `${m.textContent}:${m.dataset.tone}`));
  ok(tones.includes('@user:user') && tones.includes('@owner:user'), '@user and @owner are both toned as me in the text', tones);
  await page.screenshot({ path: join(tmpdir(), 'room-to-me.png') });
  ok(errors.length === 0, 'no page errors', errors.slice(0, 3));
} catch (e) {
  ok(false, `probe threw: ${e?.stack ?? e}`);
} finally {
  await browser?.close().catch(() => {});
  engine?.kill('SIGKILL');
  await sleep(300);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
