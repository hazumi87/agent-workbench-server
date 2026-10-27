// Probe, not in npm test: shell.html memory + GPU proxies. 5 rooms x SEED_LINES, then LIVE_SECONDS of chatter at LIVE_PER_SEC lines/s/room; PROBE=1 adds the load-older / reader-position checks. Usage: node test/shell-memory.probe.mjs <repo> <label> <outdir>. Scratch ports 7820/7821.
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
  for (let k = 0; k < 5; k++) { if (k > 0) { /* one live pane can sit in one seat per room */ } const sr = await api(`/api/rooms/${rooms[k]}/seats`, { recipe_id: 'rec-a', occupant: 'recipe:rec-a#1', handle: 'a' }); if (sr.status !== 200) throw new Error('seat ' + sr.status + JSON.stringify(sr.body).slice(0, 200)); }
  const t0 = Date.now(); let posted = 0;
  const post = async (id, i) => { const r = await api(`/api/rooms/${id}/line`, { text: '@a ' + text(i) }); if (r.status !== 200) throw new Error('line ' + r.status + JSON.stringify(r.body).slice(0, 200)); posted++; };
  for (let i = 0; i < SEED; i += 10) await Promise.all(rooms.flatMap((id) => Array.from({ length: 10 }, (_, j) => post(id, i + j))));
  console.log(`seeded ${posted} lines in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const { chromium } = await import(pathToFileURL(join(REPO, 'node_modules/playwright/index.mjs')).href);
  const browser = await chromium.launch({ headless: true, args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addCookies(cookies.map((c) => { const [name, ...v] = c.split('='); return { name, value: v.join('='), url: BASE }; }));
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable'); await cdp.send('HeapProfiler.enable'); await cdp.send('LayerTree.enable');
  let layers = 0; cdp.on('LayerTree.layerTreeDidChange', (e) => { layers = (e.layers ?? []).length; });
  const tabs = rooms.map((id) => encodeURIComponent(`/room.html?room=${id}`)).join(',');
  await page.goto(`${BASE}/shell.html?kind=manager&tabs=${tabs}`, { waitUntil: 'load' });
  await sleep(6000);
  if (process.env.DEBUG_FRAMES) console.log(JSON.stringify(await page.evaluate(() => [...document.querySelectorAll("iframe")].map((f) => { try { const d = f.contentDocument; return { src: f.src, shown: f.style.display, title: d.title, ol: d.querySelectorAll("ol").length, lis: d.querySelectorAll("li").length, ids: [...d.querySelectorAll("[id]")].slice(0,5).map(e=>e.id), name: d.getElementById("roomName")?.textContent }; } catch (e) { return { src: f.src, err: String(e) }; } }))));
  const sample = async (label) => {
    await cdp.send('HeapProfiler.collectGarbage'); await sleep(300);
    const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
    const dom = await cdp.send('Memory.getDOMCounters').catch(() => ({}));
    const per = await page.evaluate(() => {
      const out = [];
      for (const f of document.querySelectorAll('iframe')) {
        try { const d = f.contentDocument; out.push({ shown: f.style.display !== 'none', lis: d.querySelectorAll('#line > li').length, nodes: d.getElementsByTagName('*').length,
          blur: [...d.querySelectorAll('.entry-bubble')].filter((e) => { const s = getComputedStyle(e); return (s.backdropFilter || s.webkitBackdropFilter || 'none') !== 'none'; }).length, anims: d.getAnimations().length }); } catch { out.push({ err: true }); }
      }
      return out; });
    const r = { label, t: Math.round((Date.now() - tStart) / 1000), heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), nodes: m.Nodes, listeners: m.JSEventListeners, docs: m.Documents, domNodes: dom.nodes, domListeners: dom.jsEventListeners, layers, lisTotal: per.reduce((a, x) => a + (x.lis || 0), 0), blurTotal: per.reduce((a, x) => a + (x.blur || 0), 0), animsTotal: per.reduce((a, x) => a + (x.anims || 0), 0), perFrame: per };
    console.log(JSON.stringify({ ...r, perFrame: undefined })); return r;
  };
  const tStart = Date.now(); const samples = [await sample('loaded')];
  const end = Date.now() + LIVE_S * 1000; let n = SEED + 1, nextSample = Date.now() + 20000;
  while (Date.now() < end) {
    const tick = Date.now(); await Promise.all(rooms.flatMap((id) => Array.from({ length: RATE }, () => post(id, n++).catch(() => {}))));
    if (Date.now() >= nextSample) { samples.push(await sample('live')); nextSample = Date.now() + 20000; }
    await sleep(Math.max(0, 1000 - (Date.now() - tick)));
  }

  if (process.env.PROBE) {
    const fr = () => page.frames().find((f) => f.url().includes('/room.html') && f.url().includes(rooms[0]));
    const st = (f) => f.evaluate(() => { const sc = document.getElementById('lineScroll'); const ol = document.getElementById('line'); return { lis: ol.children.length, first: Number(ol.firstElementChild.dataset.id), last: Number(ol.lastElementChild.dataset.id), older: !document.getElementById('olderBtn').hidden, atStart: !document.getElementById('lineStart').hidden, top: sc.scrollTop, h: sc.scrollHeight, ch: sc.clientHeight }; });
    const f = fr();
    const a = await st(f); console.log('PROBE after live', JSON.stringify(a));
    await f.evaluate(() => { document.getElementById('lineScroll').scrollTop = 0; });
    await sleep(2500); const b = await st(f); console.log('PROBE scrolled to top -> older page loaded', JSON.stringify(b), 'firstId lower:', b.first < a.first, 'more lis:', b.lis > a.lis);
    // reader parked at the top; wait while live lines arrive; their view must not jump
    const anchorId = await f.evaluate(() => { const sc = document.getElementById('lineScroll'); sc.scrollTop = 600; const r = sc.getBoundingClientRect(); for (const li of document.getElementById('line').children) { const t = li.getBoundingClientRect(); if (t.bottom > r.top + 5) return { id: Number(li.dataset.id), y: Math.round(t.top - r.top) }; } });
    for (let i = 0; i < 20; i++) { await Promise.all(rooms.slice(0, 1).flatMap((id) => Array.from({ length: 30 }, () => post(id, n++).catch(() => {})))); await sleep(500); }
    const c = await f.evaluate((id) => { const sc = document.getElementById('lineScroll'); const li = document.querySelector(`#line > li[data-id="${id}"]`); const r = sc.getBoundingClientRect(); return { present: !!li, y: li ? Math.round(li.getBoundingClientRect().top - r.top) : null, lis: document.getElementById('line').children.length }; }, anchorId.id);
    console.log('PROBE reader mid-history, 600 live lines later', JSON.stringify({ anchor: anchorId, now: c }));
    await f.evaluate(() => { const sc = document.getElementById('lineScroll'); sc.scrollTop = sc.scrollHeight; }); await sleep(1500);
    const d = await st(f); console.log('PROBE back at bottom (trims)', JSON.stringify(d));
  }
  await sleep(4000); samples.push(await sample('final'));
  // scroll the active room to the top, load older a few times, to see the reader case
  writeFileSync(join(process.argv[4] || '.', `result-${LABEL}.json`), JSON.stringify({ label: LABEL, seed: SEED, liveSeconds: LIVE_S, ratePerRoomPerSec: RATE, samples }, null, 1));
  await browser.close(); done(0);
} catch (e) { console.error('FAILED', e?.stack ?? e); done(1); }
