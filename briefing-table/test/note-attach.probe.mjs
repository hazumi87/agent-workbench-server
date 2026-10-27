// Probe, not in npm test: a draft note + "Add to message" in headless Chromium: the note must be an attachment tile (not a "[note: ...]" text pointer) and, once sent, a note attachment with its title and word count. Usage: node test/note-attach.probe.mjs <repo> x. Scratch ports 7820/7821. Owner [ref].
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
  const fails = []; const check = (c, m) => { console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`); if (!c) fails.push(m); };
  const created = await api(`/api/rooms/${rooms[0]}/notes`, { text: 'Plan for the weekend\nthree more words here' });
  const note = created.body && (created.body.note || created.body);
  check(created.status === 200 && note && note.id, `a draft note exists (${created.status} ${note && note.id})`);
  const { chromium } = await import(pathToFileURL(join(REPO, 'node_modules/playwright/index.mjs')).href);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addCookies(cookies.map((c) => { const [name, ...v] = c.split('='); return { name, value: v.join('='), url: BASE }; }));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/room.html?room=${rooms[0]}`, { waitUntil: 'load' });
  await sleep(3500);
  await page.click('#padNotes'); await sleep(1200);
  await page.locator('#preview .sp-row, #preview li, #preview [class*="sp-"]').filter({ hasText: 'Plan for the weekend' }).first().click({ timeout: 5000 }).catch((e) => console.log('open-item click failed', String(e).slice(0, 80)));
  await sleep(900);
  await page.getByRole('button', { name: 'Add to message' }).first().click({ timeout: 5000 }).catch((e) => console.log('add click failed', String(e).slice(0, 80)));
  await sleep(1500);
  const st = await page.evaluate(() => ({ input: document.getElementById('input').value, tiles: [...document.querySelectorAll('#attTray .att-tile')].map((t) => t.className + '|' + (t.textContent || '').trim().slice(0, 50)) }));
  console.log('STATE', JSON.stringify(st));
  check(!/\[note:/.test(st.input), 'the box does not get a "[note: …]" text pointer');
  check(st.tiles.some((t) => /is-note/.test(t)), 'the note is an attachment tile in the tray');
  await page.click('#sendBtn'); await sleep(2500);
  const lines = (await api(`/api/rooms/${rooms[0]}/line?limit=20`)).body.entries.filter((e) => e.kind === 'attachment' || e.kind === 'chat');
  const last = lines[lines.length - 1];
  const m = last && last.meta ? JSON.parse(last.meta) : {};
  console.log('SENT', JSON.stringify({ kind: last && last.kind, attachments: (m.attachments || []).map((a) => ({ kind: a.kind, title: a.title, words: a.words })) }));
  check((m.attachments || []).some((a) => a.kind === 'note' && a.title && a.words >= 1), 'sent: the message carries a note attachment with its title and word count');
  console.log('NOTEATTACH', JSON.stringify({ repo: REPO.split('/').pop(), fails: fails.length }));
  await browser.close(); done(fails.length ? 1 : 0);
} catch (e) { console.error('FAILED', e?.stack ?? e); done(1); }
