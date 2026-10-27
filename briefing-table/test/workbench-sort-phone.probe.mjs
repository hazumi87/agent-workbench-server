/* THE WORKBENCH SORT  node test/workbench-sort-phone.probe.mjs   Owner room [ref]: Show all lists seated agents by ROOT, then the root's own seats,
 * then each GROUP, lead first then handle; each seat reads "Root > Group . @handle". 390x844 touch + 1280x800, Chromium + WebKit.
 * /api/table and /api/rooms are STUBBED (a scratch engine has no live agents). */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(461);
const DEAD = P(462);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-wbsort-token';
let failures = 0;
const ok = (c, m, d) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${d !== undefined ? `  (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); if (!c) { failures += 1; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.SHOTS_DIR || '';
const runTsx = (args, env) => new Promise((resolve) => {
  const pr = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
  let out = ''; let err = '';
  pr.stdout.on('data', (d) => (out += d)); pr.stderr.on('data', (d) => (err += d));
  pr.on('exit', (code) => resolve({ code, out, err }));
});
await assertFree(PORT, 'workbench-sort-phone.probe.mjs');
await assertFree(DEAD, 'workbench-sort-phone.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-wbsort-'));
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
  const mkS = (pane, title) => ({ paneid: pane, state: 'live', kind: 'session', vendor: 'claude-code', recipe_id: null, friendlyName: title, title, activity: 'idle', attached: true, color: null });
  const room = (id, name, parent, lead, seats) => ({ room: { id, name, state: 'open', parent_id: parent, color: '#3b82f6', alias: null, lead_seat: lead }, seats: seats.map(([sid, handle, pane]) => ({ id: sid, handle, left_at: null, occupant: { id: pane, state: 'live', activity: 'idle', attached: true } })), unread: 0 });
  const panes = { 'p-b-root': 'Bee root', 'p-b1-x': 'Bee group x', 'p-a-root': 'Aye root', 'p-a1-lead': 'Aye one lead', 'p-a1-m': 'Aye one m', 'p-a2-q': 'Aye two q', 'p-loose': 'Loose agent' };
  /* deliberately scrambled input order: B first, groups before roots */
  const rooms = [
    room('B1', 'B1 Group', 'B', null, [['b1x', 'bx', 'p-b1-x']]),
    room('A2', 'A2 Group', 'A', null, [['a2q', 'aq', 'p-a2-q']]),
    room('B', 'B Root', null, null, [['br', 'broot', 'p-b-root']]),
    room('A1', 'A1 Group', 'A', 'a1l', [['a1m', 'am', 'p-a1-m'], ['a1l', 'zlead', 'p-a1-lead']]),
    room('A', 'A Root', null, null, [['ar', 'aroot', 'p-a-root']]),
  ];
  const sessions = Object.entries(panes).map(([p, t]) => mkS(p, t));
  const EXPECT = ['Loose agent', 'A Root · @aroot', 'A Root › A1 Group · @zlead', 'A Root › A1 Group · @am', 'A Root › A2 Group · @aq', 'B Root · @broot', 'B Root › B1 Group · @bx'];
  const errs = [];
  for (const [bname, bt] of [['chromium', chromium], ['webkit', webkit]]) {
    let br;
    try { br = await bt.launch({ headless: true }); } catch (e) { console.log(`  skip ${bname}: ${String(e).slice(0, 80)}`); continue; }
    for (const [vname, w, h, touch] of [['phone', 390, 844, true], ['desktop', 1280, 800, false]]) {
      const ctx = await br.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch && bname === 'chromium' });
      await ctx.route(/\/api\/table$/, async (route) => { const res = await route.fetch(); const b = await res.json(); await route.fulfill({ response: res, json: { ...b, sessions } }); });
      await ctx.route(/\/api\/rooms(\?[^/]*)?$/, async (route) => { if (route.request().method() !== 'GET') { await route.continue(); return; } await route.fulfill({ json: rooms }); });
      const pg = await ctx.newPage();
      pg.on('pageerror', (e) => errs.push(`${bname}/${vname}: ${e}`));
      await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
      await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
      await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);
      await pg.goto(`${BASE}/manager.html`, { waitUntil: 'domcontentloaded' });
      await sleep(3500);
      await pg.click('#liveShowAll');
      await sleep(500);
      const rs = await pg.evaluate(() => [...document.querySelectorAll('#liveList .live-row')].map((r) => { const c = r.querySelector('.live-roomchip'); const rc = c.getBoundingClientRect(); const rr = r.getBoundingClientRect(); return { name: r.querySelector('.live-name').textContent, chip: c.textContent, inside: rc.right <= rr.right + 1 && rc.left >= rr.left - 1, clipped: c.scrollWidth > c.clientWidth + 1 }; }));
      const got = rs.map((r) => (r.chip === 'not in a room' ? r.name : r.chip));
      const tag = `${bname} ${vname}`;
      ok(JSON.stringify(got) === JSON.stringify(EXPECT), `${tag}: order + label format`, got);
      ok(rs.every((r) => r.inside), `${tag}: every chip stays inside its card`, rs.filter((r) => !r.inside));
      ok(vname === 'phone' || rs.every((r) => !r.clipped), `${tag}: no chip clipped (desktop)`, rs.filter((r) => r.clipped).map((r) => r.chip));
      ok(await pg.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), `${tag}: no sideways scroll`);
      if (process.env.SHOTS_DIR) { await pg.screenshot({ path: join(process.env.SHOTS_DIR, `wbsort-${bname}-${vname}.png`) }); }
      pg.removeAllListeners('pageerror'); // WebKit rejects in-flight polls when the context closes: not a page fault
      await ctx.close();
    }
    await br.close();
  }
  const real = errs.filter((e) => !/Load failed|access control/.test(e)); // WebKit rejects in-flight stubbed polls at teardown
  ok(real.length === 0, 'no page errors', real.slice(0, 3));
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log(failures ? `\nFAIL ${failures}` : '\nPASS');
process.exit(failures ? 1 : 0);
