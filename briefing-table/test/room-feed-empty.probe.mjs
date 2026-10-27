/* A FEED THAT HIDES EVERY LOADED LINE [feed empty]  node test/room-feed-empty.probe.mjs   Owner 2026-10-06
 * (application on iPhone: "load older" and nothing else). The real room page against a scratch engine (dead broker, temp table,
 * never a live pane); agent-to-agent lines are written straight into the temp db. The room's default feed is "to me".
 *   QUIET   130 agent-to-agent lines newer than one line of mine: the newest 50 are all hidden, the page fetches older pages
 *           until my line is visible (3 fetches), no note.
 *   FLOODED 400 agent-to-agent lines (more than the 5-page cap): nothing visible, the note names the filter ("No messages to
 *           you in the newest N loaded"), "load older" is still there, "Show all" shows the lines and drops the note.
 *   NORMAL  a room whose newest page has my lines: ONE page fetched, no note.
 *   390 phone and 1280 desktop. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(400);
const DEAD = P(401);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-room-feed-empty-token';
const SHOTS = process.env.IPAD_SHOTS || tmpdir();
let failures = 0;
const ok = (c, m, d) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${d !== undefined ? `  (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); if (!c) failures += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runTsx = (args, env) => new Promise((resolve) => {
  const pr = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
  let out = ''; let err = '';
  pr.stdout.on('data', (d) => (out += d)); pr.stderr.on('data', (d) => (err += d));
  pr.on('exit', (code) => resolve({ code, out, err }));
});
await assertFree(PORT, 'room-feed-empty.probe.mjs');
await assertFree(DEAD, 'room-feed-empty.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-feed-empty-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null; let browser = null; let log = '';
try {
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
    return JSON.parse(r.out.trim().split('\n').pop());
  };
  await seed({ recipes: [
    { id: 'rec-a', name: 'Awake', projectDir: '/srv/x/awake', vendor: 'claude-code', agent: 'awake', color: '#0dab49' },
    { id: 'rec-b', name: 'Bravo', projectDir: '/srv/x/bravo', vendor: 'claude-code', agent: 'bravo', color: '#1f5fbf' },
  ] });
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
  const plan = await seed({ rooms: ['Quiet', 'Flooded', 'Normal'].map((name) => ({ name, seats: [{ handle: 'awake', recipe_id: 'rec-a' }, { handle: 'bravo', recipe_id: 'rec-b' }] })) });
  const rooms = Object.fromEntries(plan.rooms.map((r) => [r.name, r]));
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath);
  const ins = db.prepare('INSERT INTO room_line (room_id, ts, kind, author, author_seat, target, target_seat, thread, body, ref, meta) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL)');
  const fill = (room, agentLines) => {
    const t0 = Date.now() - 1_000_000;
    ins.run(room.id, t0, 'chat', 'user', null, 'room', null, 'hello from me');
    const a = room.seats.awake; const b = room.seats.bravo;
    for (let i = 0; i < agentLines; i += 1) { ins.run(room.id, t0 + 1 + i, 'chat', 'awake', a, 'bravo', b, `agent line ${i}`); }
  };
  fill(rooms.Quiet, 130);
  fill(rooms.Flooded, 400);
  fill(rooms.Normal, 3); // 3 agent lines + my line: all within one page; "to me" shows mine
  db.close();
  browser = await chromium.launch({ headless: true });
  for (const c of [{ name: 'phone 390', w: 390, h: 780, touch: true }, { name: 'desktop 1280', w: 1280, h: 860, touch: false }]) {
    const ctx = await browser.newContext({ viewport: { width: c.w, height: c.h }, hasTouch: c.touch, isMobile: c.touch });
    const pg = await ctx.newPage();
    const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
    await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
    await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);
    const cookie = (await ctx.cookies()).map((x) => `${x.name}=${x.value}`).join('; ');
    for (const room of Object.values(rooms)) {
      const r = await fetch(`${BASE}/api/rooms/${room.id}/settings`, { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ feed_default: { kinds: ['chat', 'delivery', 'attachment', 'voice'], who: 'me' } }) });
      if (!r.ok) { throw new Error(`feed_default ${r.status} ${await r.text()}`); }
    }
    const open = async (room) => {
      const reqs = [];
      pg.removeAllListeners('request');
      pg.on('request', (rq) => { if (/\/line\?/.test(rq.url()) && /[?&]before=/.test(rq.url())) { reqs.push(rq.url()); } /* the BACK pages only: the newest load, the since= backfill and the live poll are not paging */ });
      await pg.goto(`${BASE}/room.html?room=${room.id}&shell=0`, { waitUntil: 'domcontentloaded' });
      await pg.waitForSelector('#line', { state: 'attached' });
      await sleep(3500);
      const st = await pg.evaluate(() => {
        const vis = [...document.querySelectorAll('#line .entry')].filter((li) => getComputedStyle(li).display !== 'none').map((li) => li.querySelector('.entry-body')?.textContent ?? '');
        const note = document.getElementById('feedNote');
        const older = document.getElementById('olderBtn');
        return { vis, all: document.querySelectorAll('#line .entry').length, noteShown: !note.hidden && getComputedStyle(note).display !== 'none', noteText: note.textContent.trim(), olderShown: !older.hidden && getComputedStyle(older).display !== 'none' };
      });
      return { st, reqs };
    };
    const q = await open(rooms.Quiet);
    ok(q.st.vis.includes('hello from me') && !q.st.noteShown, `${c.name}: QUIET: the page reached my line past 100+ hidden ones, no note`, { vis: q.st.vis.slice(0, 3), all: q.st.all, reqs: q.reqs.length });
    ok(q.reqs.length === 2, `${c.name}: QUIET: it fetched the 2 back pages it needed (${q.reqs.length}), under the cap`);
    const f = await open(rooms.Flooded);
    ok(f.st.vis.length === 0 && f.st.noteShown && /No messages to you in the newest \d+ loaded/.test(f.st.noteText) && f.st.olderShown, `${c.name}: FLOODED: nothing visible, the note names the filter, "load older" is still there`, { note: f.st.noteText, older: f.st.olderShown, all: f.st.all });
    ok(f.reqs.length === 5, `${c.name}: FLOODED: exactly 5 back pages, then it stops (${f.reqs.length})`);
    await pg.screenshot({ path: join(SHOTS, `feed-empty-${c.w}.png`) });
    await pg.click('#feedShowAll');
    await sleep(500);
    const after = await pg.evaluate(() => ({ vis: [...document.querySelectorAll('#line .entry')].filter((li) => getComputedStyle(li).display !== 'none').length, noteShown: !document.getElementById('feedNote').hidden }));
    ok(after.vis > 0 && !after.noteShown, `${c.name}: FLOODED: "Show all" shows the lines and drops the note`, after);
    const n = await open(rooms.Normal);
    ok(n.st.vis.includes('hello from me') && !n.st.noteShown && n.reqs.length === 0, `${c.name}: NORMAL: no back page fetched, my line shown, no note`, { reqs: n.reqs.length, vis: n.st.vis });
    ok(errs.length === 0, `${c.name}: no page errors`, errs.slice(0, 2));
    await ctx.close();
  }
} catch (e) {
  failures += 1; console.log(` FAIL ${e?.stack ?? e}`);
} finally {
  await browser?.close();
  engine?.kill('SIGKILL');
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* EPERM on Windows */ }
}
console.log(failures ? `FAIL ${failures}` : 'PASS');
process.exit(failures ? 1 : 0);
