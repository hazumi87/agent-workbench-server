// Probe, not in npm test: drives the "/" command list in headless Chromium (desktop; PHONE=1 for a phone-sized page): opens, narrows, keys, focus, hint, no match, Enter sends vs fills. Usage: node test/slash-list.probe.mjs <repo> x. Scratch ports 7820/7821. the design system [ref].
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
  const ctx = await browser.newContext({ viewport: process.env.PHONE ? { width: 390, height: 780 } : { width: 1400, height: 900 }, ...(process.env.PHONE ? { hasTouch: true, isMobile: true } : {}) });
  await ctx.addCookies(cookies.map((c) => { const [name, ...v] = c.split('='); return { name, value: v.join('='), url: BASE }; }));
  const page = await ctx.newPage();
  await page.goto(process.env.PHONE ? `${BASE}/room.html?room=${rooms[0]}` : `${BASE}/shell.html?kind=manager&tabs=${encodeURIComponent('/room.html?room=' + rooms[0])}`, { waitUntil: 'load' });
  await sleep(5000);
  const f = process.env.PHONE ? page.mainFrame() : page.frames().find((x) => x.url().includes('/room.html'));
  const snap = () => f.evaluate(() => { const ul = document.getElementById('complete'); const inp = document.getElementById('input');
    return { open: !ul.hidden && ul.classList.contains('rm-cmds'), rows: [...ul.querySelectorAll('.rm-cmd')].filter((r) => !r.classList.contains('rm-cmd-none')).length, heads: [...ul.querySelectorAll('.rm-cmd-head')].map((h) => h.textContent),
      first: ul.querySelector('.rm-cmd .rm-cmd-u') && ul.querySelector('.rm-cmd .rm-cmd-u').textContent, active: (ul.querySelector('.is-active .rm-cmd-u') || {}).textContent || null, none: !!ul.querySelector('.rm-cmd-none'), hint: !!ul.querySelector('.is-hint'),
      value: inp.value, focus: document.activeElement === inp, live: document.getElementById('cmdLive').textContent, rowH: ul.querySelector('.rm-cmd') && Math.round(ul.querySelector('.rm-cmd').getBoundingClientRect().height),
      ulH: Math.round(ul.getBoundingClientRect().height), ulW: Math.round(ul.getBoundingClientRect().width), inW: Math.round(document.getElementById('compose').getBoundingClientRect().width), bold: (ul.querySelector('.rm-cmd-u b') || {}).textContent || null, expanded: inp.getAttribute('aria-expanded') }; });
  const out = (k, v) => console.log('SLASH', k, JSON.stringify(v));
  await f.click('#input'); await sleep(600);
  await page.keyboard.type('hello /seat'); await sleep(300); out('mid-text slash (closed)', await snap());
  await f.evaluate(() => { document.getElementById('input').value = ''; document.getElementById('input').dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(200);
  await page.keyboard.type('/'); await sleep(500); out('bare /', await snap());
  await page.keyboard.type('se'); await sleep(300); out('/se', await snap());
  await page.keyboard.type('at re'); await sleep(300); out('/seat re', await snap());
  await page.keyboard.press('ArrowDown'); await sleep(150); out('ArrowDown', await snap());
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await sleep(150); out('ArrowUp x2 (wraps)', await snap());
  await page.keyboard.press('Tab'); await sleep(300); out('Tab fills', await snap());
  await page.keyboard.type('@briefing-t'); await sleep(300); out('arg being typed (handle list)', await snap());
  await page.keyboard.press('Escape'); await sleep(200); out('Esc keeps text', await snap());
  await f.evaluate(() => { const i = document.getElementById('input'); i.value = '/floor take'; i.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(300); out('/floor take typed in full', await snap());
  await f.evaluate(() => { const i = document.getElementById('input'); i.value = '/xyz'; i.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(300); out('/xyz no match', await snap());
  await f.evaluate(() => { const i = document.getElementById('input'); i.value = '/set turn 5'; i.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(300); out('/set turn 5 (hint)', await snap());
  await f.evaluate(() => { const i = document.getElementById('input'); i.value = '/help'; i.setSelectionRange(5, 5); i.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(300);
  const before = await f.evaluate(() => document.querySelectorAll('#line > li').length);
  await page.keyboard.press('Enter'); await sleep(1500);
  const after = await f.evaluate(() => ({ lis: document.querySelectorAll('#line > li').length, value: document.getElementById('input').value, help: !document.getElementById('help').hidden }));
  out('Enter on /help typed in full SENDS (help opens, box clears)', { before, after });
  await f.evaluate(() => { const i = document.getElementById('input'); i.value = '/fl'; i.setSelectionRange(3, 3); i.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(300);
  await page.keyboard.press('Enter'); await sleep(500); out('Enter on partial /fl FILLS, does not send', await snap());
  await browser.close(); done(0);
} catch (e) { console.error('FAILED', e?.stack ?? e); done(1); }
