// Probe, not in npm test: the To-me view in headless Chromium with a forward fixture (a reply to the person naming only another seat stays OUT of To me; a reply naming nobody, a line naming the person, and a new agent line naming nobody show) + the unchanged unread total. Usage: node test/reply-to-me.probe.mjs <repo> x. Scratch ports 7820/7821. Owner [ref]/[ref].
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
const seedPlan = { recipes: [{ id: 'rec-a', name: 'Ra', projectDir: '/srv/x/a', vendor: 'claude-code', agent: 'agent-a' }, { id: 'rec-b', name: 'Rb', projectDir: '/srv/x/b', vendor: 'claude-code', agent: 'agent-b' }] };
await new Promise((res, rej) => { const p = spawn(process.execPath, [join(REPO, 'node_modules/tsx/dist/cli.mjs'), join('test', 'rooms-routes.seed.ts'), JSON.stringify(seedPlan)], { cwd: REPO, env: childEnv({ HARBOR_WB_TABLE: join(tmp, 'mapping.db'), HARBOR_WB_IDENTITY: 'legacy' }) }); p.on('exit', (c) => (c === 0 ? res() : rej(new Error('seed1 ' + c)))); });
const engine = spawn(process.execPath, ['--import', loader, join('src', 'server', 'index.ts')], { cwd: REPO, env: childEnv({
  HARBOR_WB_PORT: String(PORT), HARBOR_WB_HOST: '127.0.0.1', HARBOR_WB_TABLE: join(tmp, 'mapping.db'), HARBOR_WB_TOKEN: TOKEN, HARBOR_WB_IDENTITY: 'legacy',
  HARBOR_WB_NO_WINDOW: '1', HARBOR_WB_NATS_URL: '', HARBOR_WB_FABRIC_URL: '', HARBOR_WB_BROKER_AUTOSTART: '0', HARBOR_WB_BROKER_PORT: String(DEAD),
  HARBOR_WB_CLAUDE_PROJECTS: join(tmp, 'cp'), HARBOR_WB_NODE: 'testnode', HARBOR_WB_REPLY_TURNS: 'enforce' }) });
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
  await new Promise((res, rej) => { const p = spawn(process.execPath, [join(REPO, 'node_modules/tsx/dist/cli.mjs'), join('test', 'rooms-routes.seed.ts'), JSON.stringify({ sessions: [{ paneid: 'recipe:rec-a#1', recipe_id: 'rec-a', vendor: 'claude-code', agent: 'agent-a', session_id: 's-a', state: 'live' }, { paneid: 'recipe:rec-b#1', recipe_id: 'rec-b', vendor: 'claude-code', agent: 'agent-b', session_id: 's-b', state: 'live' }] })], { cwd: REPO, env: childEnv({ HARBOR_WB_TABLE: join(tmp, 'mapping.db'), HARBOR_WB_IDENTITY: 'legacy' }) }); p.on('exit', (c) => (c === 0 ? res() : rej(new Error('seed2 ' + c)))); });
  const rooms = [];
  for (let k = 0; k < 5; k++) { const r = await api('/api/rooms', { name: `Mem room ${k + 1}` }); if (r.status !== 200) throw new Error('room ' + r.status + JSON.stringify(r.body)); rooms.push(r.body.id); }
  for (let k = 0; k < 5; k++) { if (k > 0) { /* one live pane can sit in one seat per room */ } const sr = await api(`/api/rooms/${rooms[k]}/seats`, { recipe_id: 'rec-a', occupant: 'recipe:rec-a#1', handle: 'advisor-seat' }); if (sr.status !== 200) throw new Error('seat ' + sr.status + JSON.stringify(sr.body).slice(0, 200));  const sr2 = await api(`/api/rooms/${rooms[k]}/seats`, { recipe_id: 'rec-b', occupant: 'recipe:rec-b#1', handle: 'platform' }); if (sr2.status !== 200) throw new Error('seat2 ' + sr2.status + JSON.stringify(sr2.body).slice(0, 200)); }
  const agentPost = async (text, extra = {}) => { const r = await fetch(`${BASE}/api/rooms/${rooms[0]}/line`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ text, from: { paneid: 'recipe:rec-a#1' }, ...extra }) }); const j = await r.json(); return j.entries && j.entries.find((e) => e.kind === 'chat'); };
  const personPost = async (text, extra = {}) => { const r = await api(`/api/rooms/${rooms[0]}/line`, { text, ...extra }); return r.body && r.body.entries && r.body.entries.find((e) => e.kind === 'chat'); };
  const fails = []; const check = (c, m) => { console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`); if (!c) fails.push(m); };
  const p1 = await personPost('@advisor-seat what is the status?');
  // a real turn fact: the seat claims the floor on the person's line
  const claim = await fetch(`${BASE}/api/rooms/${rooms[0]}/lines/${p1.id}/claim`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: { paneid: 'recipe:rec-a#1' } }) });
  await api(`/api/rooms/${rooms[0]}/line`, { text: '/floor take' });
  await sleep(700);
  const factsNow = (await api(`/api/rooms/${rooms[0]}/line?limit=100`)).body.entries.filter((e) => e.kind === 'fact');
  const turnFact = factsNow.find((e) => /skipped by the user|has the floor/.test(e.body || ''));
  const seatFact = factsNow.find((e) => /was added|joined|seat/i.test(e.body || '') && !/has the floor/.test(e.body || ''));
  const a1 = await agentPost('all fine here', { reply_to: p1.id });                  // names nobody, replies to the person -> to the person
  const a2 = await agentPost('@operator please take this one', { reply_to: p1.id }); // the FORWARD: names only platform
  const a3 = await agentPost('@user a note for you');                                  // names the person
  const a4 = await agentPost('`operator` finished the build');                         // a new line naming nobody -> to the person (Oct 21 rule)
  check(!!turnFact && JSON.parse(turnFact.meta).turn, `a real turn fact exists ("${turnFact && turnFact.body}") (claim ${claim.status})`);
  check(a1 && JSON.parse(a1.meta).to_user === true, 'engine: a reply to the person that names nobody is to the person');
  check(a2 && JSON.parse(a2.meta).to_user !== true && JSON.parse(a2.meta).reply.user === true && a2.target === 'platform', 'engine: the forward keeps reply.user as context, is not to_user, target platform');
  // (The all-messages unread total does not read these flags at all: UNREAD_KINDS counts every chat/attachment/voice line from someone else.)
  const { chromium } = await import(pathToFileURL(join(REPO, 'node_modules/playwright/index.mjs')).href);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addCookies(cookies.map((c) => { const [name, ...v] = c.split('='); return { name, value: v.join('='), url: BASE }; }));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/room.html?room=${rooms[0]}`, { waitUntil: 'load' });
  await sleep(3500);
  const visible = () => page.evaluate(() => [...document.querySelectorAll('#line > li')].filter((li) => li.style.display !== 'none' && (li.dataset.kind === 'chat' || li.dataset.kind === 'fact')).map((li) => li.dataset.id));
  const all = await visible();
  check(all.includes(String(a2.id)), `page, everyone view: the forward (#${a2.id}) is in the room line`);
  await page.click('#filterBtn'); await sleep(400);
  const item = page.locator('text=/^To me$/i').first();
  await item.click({ timeout: 4000 }).catch(() => {}); await sleep(700);
  await page.keyboard.press('Escape'); await sleep(300);
  const tome = await visible();
  const idOf = (e) => String(e.id);
  check(tome.includes(idOf(p1)), `page, To me: the person's own line (#${p1.id}) shows`);
  check(tome.includes(idOf(a1)), `page, To me: a reply to the person that names nobody (#${a1.id}) shows`);
  check(tome.includes(idOf(a3)), `page, To me: a line naming the person (#${a3.id}) shows`);
  check(tome.includes(idOf(a4)), `page, To me: a new agent line naming nobody (#${a4.id}) shows (the Oct 21 rule)`);
  check(!turnFact || !tome.includes(String(turnFact.id)), `page, To me: the turn fact "X has the floor" (#${turnFact && turnFact.id}) stays OUT`);
  check(!seatFact || !tome.includes(String(seatFact.id)), `page, To me: an ordinary room fact (#${seatFact && seatFact.id} "${seatFact && seatFact.body}") is out too: a fact shows only when flagged to the person`);
  check(!tome.includes(idOf(a2)), `page, To me: the FORWARD naming only platform (#${a2.id}) stays OUT`);
  console.log('TOME', JSON.stringify({ everyone: all.length, toMe: tome.length, fails: fails.length }));
  await browser.close(); done(fails.length ? 1 : 0);
} catch (e) { console.error('FAILED', e?.stack ?? e); done(1); }
