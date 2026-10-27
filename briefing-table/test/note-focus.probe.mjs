// Probe, not in npm test: types into the Scratchpad note editor for 45 s with lines arriving and the Notes list open (15 s refresh), counts focus losses. Usage: node test/note-focus.probe.mjs <repo> x. Scratch ports 7820/7821. Owner [ref].
// Measure shell.html memory/GPU proxies: 5 rooms x N seeded lines, then live chatter. Usage: node measure.mjs <repo> <label>
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const REPO = process.argv[2], LABEL = process.argv[3] || 'run';
const SEED = Number(process.env.SEED_LINES || 2500), LIVE_S = Number(process.env.LIVE_SECONDS || 90), RATE = Number(process.env.LIVE_PER_SEC || 10);
const PORT = 7820, DEAD = 7821, TOKEN = 'shellmem-token', BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const childEnv = (extra) => ({ PATH: process.env.PATH, HOME: process.env.HOME, ...extra });
const tmp = mkdtempSync(join(tmpdir(), 'wb-shellmem-'));
const loader = pathToFileURL(join(REPO, 'node_modules/tsx/dist/loader.mjs')).href;
const seedPlan = { recipes: [{ id: 'rec-a', name: 'Ra', projectDir: '/srv/x/a', vendor: 'claude-code', agent: 'agent-a' }] };
await new Promise((res, rej) => { const p = spawn(process.execPath, [join(REPO, 'node_modules/tsx/dist/cli.mjs'), join('test', 'rooms-routes.seed.ts'), JSON.stringify(seedPlan)], { cwd: REPO, env: childEnv({ HARBOR_WB_TABLE: join(tmp, 'mapping.db'), HARBOR_WB_IDENTITY: 'legacy' }) }); p.on('exit', (c) => (c === 0 ? res() : rej(new Error('seed1 ' + c)))); });
const engine = spawn(process.execPath, ['--import', loader, join('src', 'server', 'index.ts')], { cwd: REPO, env: childEnv({
  HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: join(tmp, 'mapping.db'), HARBOR_WB_TOKEN: TOKEN, HARBOR_WB_IDENTITY: 'legacy',
  HARBOR_WB_NO_WINDOW: '1', HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(DEAD),
  HARBOR_WB_CLAUDE_PROJECTS: join(tmp, 'cp'), HARBOR_WB_NODE: 'testnode' }) });
let elog = ''; engine.stdout.on('data', (d) => (elog += d)); engine.stderr.on('data', (d) => (elog += d));
const done = (code) => { try { engine.kill('SIGKILL'); } catch {} try { rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };
try {
  let up = false; for (let i = 0; i < 200 && !up; i++) { await sleep(250); up = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false); }
  if (!up) throw new Error('engine did not start\n' + elog.slice(-1500));
  const login = await fetch(`${BASE}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(TOKEN)}`, redirect: 'manual' });
  const cookies = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]);
  const cookie = cookies.join('; ');
  const api = async (path, json) => { const r = await fetch(BASE + path, { method: json ? 'POST' : 'GET', headers: { cookie, ...(json ? { 'content-type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined }); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
  const words = 'the lead model reported build tests passing on branch merge review pushed commit cut notes room seat floor turn claim ack idle limit stream'.split(' ');
  const text = (i) => `line ${i}: ` + Array.from({ length: 18 + (i % 25) }, (_, k) => words[(i * 7 + k * 3) % words.length]).join(' ') + (i % 11 === 0 ? ' `code span` **bold**' : '');
  await new Promise((res, rej) => { const p = spawn(process.execPath, [join(REPO, 'node_modules/tsx/dist/cli.mjs'), join('test', 'rooms-routes.seed.ts'), JSON.stringify({ sessions: [{ paneid: 'recipe:rec-a#1', recipe_id: 'rec-a', vendor: 'claude-code', agent: 'agent-a', session_id: 's-a', state: 'live' }] })], { cwd: REPO, env: childEnv({ HARBOR_WB_TABLE: join(tmp, 'mapping.db'), HARBOR_WB_IDENTITY: 'legacy' }) }); p.on('exit', (c) => (c === 0 ? res() : rej(new Error('seed2 ' + c)))); });
  const rooms = [];
  for (let k = 0; k < 5; k++) { const r = await api('/api/rooms', { name: `Mem room ${k + 1}` }); if (r.status !== 200) throw new Error('room ' + r.status + JSON.stringify(r.body)); rooms.push(r.body.id); }
  for (let k = 0; k < 5; k++) { if (k > 0) { /* one live pane can sit in one seat per room */ } const sr = await api(`/api/rooms/${rooms[k]}/seats`, { recipe_id: 'rec-a', occupant: 'recipe:rec-a#1', handle: 'advisor-seat' }); if (sr.status !== 200) throw new Error('seat ' + sr.status + JSON.stringify(sr.body).slice(0, 200)); }
  const post = async (id, i) => { const r = await api(`/api/rooms/${id}/line`, { text: '@advisor-seat ' + text(i) }); if (r.status !== 200) throw new Error('line ' + r.status); };
  for (let i = 0; i < 120; i++) await post(rooms[0], i);
  const { chromium } = await import(pathToFileURL(join(REPO, 'node_modules/playwright/index.mjs')).href);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addCookies(cookies.map((c) => { const [name, ...v] = c.split('='); return { name, value: v.join('='), url: BASE }; }));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/shell.html?kind=manager&tabs=${encodeURIComponent('/room.html?room=' + rooms[0])}`, { waitUntil: 'load' });
  await sleep(5000);
  const f = page.frames().find((x) => x.url().includes('/room.html'));
  await f.evaluate(() => { window.__fo = []; const d = document; d.addEventListener('focusout', (e) => window.__fo.push({ t: Math.round(performance.now()), from: e.target.id || e.target.tagName, to: (e.relatedTarget && (e.relatedTarget.id || e.relatedTarget.tagName)) || null, active: document.activeElement && (document.activeElement.id || document.activeElement.tagName) }), true); });
  await f.evaluate(() => { window.__fo = []; document.addEventListener('focusout', (e) => window.__fo.push({ t: Math.round(performance.now()), from: e.target.id || e.target.className || e.target.tagName, to: (e.relatedTarget && (e.relatedTarget.id || e.relatedTarget.className || e.relatedTarget.tagName)) || null }), true); });
  await f.click('#padNotes'); await sleep(800);
  await f.click('.sp-add'); await sleep(1200);
  const sel = await f.evaluate(() => { const a = document.activeElement; return { tag: a && a.tagName, cls: a && a.className, id: a && a.id }; });
  console.log('NOTE-OPEN', JSON.stringify(sel));
  const isNote = () => f.evaluate(() => { const a = document.activeElement; return !!(a && a.tagName === 'TEXTAREA' && a.id !== 'input'); });
  const lost = []; let n = 1000; const end = Date.now() + 45000; let typed = 0;
  const feed = (async () => { while (Date.now() < end) { await post(rooms[0], n++).catch(() => {}); await sleep(350); } })();
  while (Date.now() < end) {
    await page.keyboard.type('editing my note about the plan ', { delay: 70 }); typed += 31;
    if (!(await isNote())) { lost.push({ at: Date.now() % 100000, act: await f.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.tagName)) }); const ta = await f.$('.nt-card textarea'); if (ta) await ta.click(); }
  }
  await feed;
  const fo = await f.evaluate(() => window.__fo);
  console.log('NOTEFOCUS', JSON.stringify({ repo: REPO.split('/').pop(), typed, lostCount: lost.length, lost: lost.slice(0, 4), focusout: fo.length, firstFocusouts: fo.slice(0, 6) }));
  await browser.close(); done(0);
} catch (e) { console.error('FAILED', e?.stack ?? e); done(1); }
