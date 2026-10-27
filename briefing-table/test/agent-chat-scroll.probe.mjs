/* THE AGENT CHAT KEEPS THE ROOM LINE'S SCROLLING RULES [chat scroll]  node test/agent-chat-scroll.probe.mjs   Owner 2026-10-06
 * (the Chat tab of an agent's window opened at the TOP: the newest messages were a long scroll away). The real solo page
 * against a scratch engine (dead broker, temp table, never a live pane); the chat transcript API is answered by the probe
 * (120 messages, pages of 50), so every case is deterministic. At 390 and 1280:
 *   1 open: the Chat tab lands on the NEWEST message.   2 CLI and back: lands on the newest again.
 *   3 at the bottom, a new message: stays pinned.   4 scrolled up, a new message: NO jump, and a "New messages" pill shows;
 *   the pill takes you to the bottom and goes.   5 "load older" keeps your place (the same line stays where it was). */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(408);
const DEAD = P(409);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-agent-chat-scroll-token';
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
await assertFree(PORT, 'agent-chat-scroll.probe.mjs');
await assertFree(DEAD, 'agent-chat-scroll.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-chat-scroll-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null; let browser = null; let log = '';
try {
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
    return JSON.parse(r.out.trim().split('\n').pop());
  };
  await seed({ recipes: [{ id: 'rec-a', name: 'Awake', projectDir: '/srv/x/awake', vendor: 'claude-code', agent: 'awake', color: '#0dab49' }] });
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
  await seed({ sessions: [{ paneid: 'recipe:rec-a', recipe_id: 'rec-a', vendor: 'claude-code', agent: 'awake', state: 'live' }] }); // after boot: a stale live row would be reconciled away
  browser = await chromium.launch({ headless: true });
  const TOTAL = 120;
  const mk = (n) => ({ id: `m${n}`, role: n % 2 ? 'user' : 'assistant', text: `message ${n} ${'lorem ipsum dolor sit amet '.repeat(3 + (n % 5))}`, ts: 1_700_000_000_000 + n * 1000 });
  for (const c of [{ name: 'phone 390', w: 390, h: 780, touch: true }, { name: 'desktop 1280', w: 1280, h: 860, touch: false }]) {
    const ctx = await browser.newContext({ viewport: { width: c.w, height: c.h }, hasTouch: c.touch, isMobile: c.touch, locale: 'en-US' });
    const login = await ctx.newPage();
    await login.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await login.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
    await Promise.all([login.waitForNavigation().catch(() => {}), login.click('form button:visible')]);
    await login.close();
    let newest = TOTAL; // the mock transcript's newest id number
    const pg = await ctx.newPage();
    const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
    await pg.route('**/api/sessions/*/chat*', async (route) => {
      const u = new URL(route.request().url());
      const after = u.searchParams.get('after');
      const bef = u.searchParams.get('before');
      const num = (id) => Number(String(id).slice(1));
      let items;
      let before = null;
      if (after) {
        items = Array.from({ length: Math.max(0, newest - num(after)) }, (_, i) => mk(num(after) + 1 + i));
      } else if (bef) {
        const end = num(bef) - 1; const start = Math.max(1, end - 49);
        items = Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => mk(start + i));
        before = start > 1 ? `m${start}` : null;
      } else {
        const start = Math.max(1, newest - 49);
        items = Array.from({ length: newest - start + 1 }, (_, i) => mk(start + i));
        before = start > 1 ? `m${start}` : null;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ supported: true, items, before, latest: `m${newest}` }) });
    });
    const geo = () => pg.evaluate(() => { const s = document.getElementById('acScroll'); return { top: Math.round(s.scrollTop), h: s.scrollHeight, ch: s.clientHeight, gap: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight), shown: !document.getElementById('agentChat').hidden, last: [...document.querySelectorAll('#acList > li')].pop()?.dataset.id, count: document.querySelectorAll('#acList > li').length }; });
    /* the pane's socket is answered by the probe too: a pane.ready that names the vendor (claude-code) is what makes the window offer Chat */
    await pg.routeWebSocket(/\/pty/, (ws) => {
      ws.onMessage((m) => {
        let d = null;
        try { d = JSON.parse(String(m)); } catch { return; }
        if (d?.type === 'attach' && d.paneid) {
          ws.send(JSON.stringify({ type: 'pane.ready', paneid: d.paneid, vendor: 'claude-code', cols: 80, rows: 24, controlling: true, mcp: [] }));
        }
      });
    });
    await pg.addInitScript(() => { try { localStorage.clear(); } catch { /* none */ } });
    await pg.goto(`${BASE}/solo.html?recipe=rec-a&shell=0`, { waitUntil: 'domcontentloaded' });
    await pg.waitForSelector('#acScroll', { state: 'attached', timeout: 15000 });
    await sleep(3500);
    let g = await geo();
    ok(g.shown && g.count >= 40 && g.gap <= 2 && g.last === `m${TOTAL}`, `${c.name}: 1 open: the Chat tab lands on the newest message (m${TOTAL})`, g);
    await pg.screenshot({ path: join(SHOTS, `chat-scroll-${c.w}-open.png`) });
    const clk = await pg.evaluate(() => { const li = [...document.querySelectorAll('#acList > li')].find((x) => x.querySelector('.entry-ts')); const t = li?.querySelector('.entry-ts')?.textContent ?? ''; const id = Number(li.dataset.id.slice(1)); return { shown: t, room: new Date(1_700_000_000_000 + id * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }; });
    ok(/^\d{2}:\d{2}\s?(AM|PM)$/.test(clk.shown) && clk.shown === clk.room, `${c.name}: the chat's times are the room line's clock (12-hour with AM/PM in this locale): "${clk.shown}"`, clk);

    /* 1b: the window is HIDDEN while the chat loads (a background shell tab is a display:none frame), then revealed */
    const hid = await ctx.newPage();
    await hid.routeWebSocket(/\/pty/, (ws) => {
      ws.onMessage((m) => {
        let d = null;
        try { d = JSON.parse(String(m)); } catch { return; }
        if (d?.type === 'attach' && d.paneid) {
          ws.send(JSON.stringify({ type: 'pane.ready', paneid: d.paneid, vendor: 'claude-code', cols: 80, rows: 24, controlling: true, mcp: [] }));
        }
      });
    });
    await hid.route('**/api/sessions/*/chat*', async (route) => {
      const start = newest - 49;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ supported: true, items: Array.from({ length: 50 }, (_, i) => mk(start + i)), before: `m${start}`, latest: `m${newest}` }) });
    });
    await hid.addInitScript(() => {
      try { localStorage.clear(); } catch { /* none */ }
      document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.display = 'none'; window.__reveal = () => { document.documentElement.style.display = ''; }; });
    });
    await hid.goto(`${BASE}/solo.html?recipe=rec-a&shell=0`, { waitUntil: 'domcontentloaded' });
    await hid.waitForFunction(() => document.querySelectorAll('#acList > li').length >= 40, null, { timeout: 15000 }).catch(() => {});
    const loadedHidden = await hid.evaluate(() => document.querySelectorAll('#acList > li').length);
    await hid.evaluate(() => window.__reveal());
    await sleep(1200);
    const g1b = await hid.evaluate(() => { const s = document.getElementById('acScroll'); return { top: Math.round(s.scrollTop), gap: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight), ch: s.clientHeight, shown: !document.getElementById('agentChat').hidden }; });
    ok(loadedHidden >= 40 && g1b.ch > 100 && g1b.gap <= 2, `${c.name}: 1b loaded while the window was hidden, then shown: it lands on the newest, not the top`, { loadedHidden, ...g1b });
    await hid.close();

    /* 1c: the shell's BACKGROUND tab (a display:none frame) loads the chat; the tab is selected later */
    if (c.w >= 1000) {
      const sh = await ctx.newPage();
      await sh.routeWebSocket(/\/pty/, (ws) => {
        ws.onMessage((m) => {
          let d = null;
          try { d = JSON.parse(String(m)); } catch { return; }
          if (d?.type === 'attach' && d.paneid) {
            ws.send(JSON.stringify({ type: 'pane.ready', paneid: d.paneid, vendor: 'claude-code', cols: 80, rows: 24, controlling: true, mcp: [] }));
          }
        });
      });
      await sh.route('**/api/sessions/*/chat*', async (route) => {
        const start = newest - 49;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ supported: true, items: Array.from({ length: 50 }, (_, i) => mk(start + i)), before: `m${start}`, latest: `m${newest}` }) });
      });
      await sh.addInitScript(() => { try { sessionStorage.clear(); localStorage.clear(); } catch { /* none */ } });
      /* two tabs: the CLI Manager is the hub, the agent page is a normal tab; select the manager first so the agent tab loads in the background */
      await sh.goto(`${BASE}/shell.html?tabs=${encodeURIComponent('/solo.html?recipe=rec-a')},${encodeURIComponent('/settings.html')}`, { waitUntil: 'domcontentloaded' });
      await sh.waitForFunction(() => [...document.querySelectorAll('#stage iframe')].length >= 2, null, { timeout: 15000 });
      const agentFrame = () => sh.frames().find((f) => /^[^?]*solo\.html/.test(f.url()));
      await sh.waitForFunction(() => true);
      await sleep(3000);
      /* make the settings tab the active one so the agent tab is the hidden one, wait for its chat to load, then select the agent tab */
      await sh.locator('.hwb-tab', { hasText: /Settings/ }).first().click().catch(() => {});
      await sleep(2500);
      const loadedBg = await agentFrame().evaluate(() => document.querySelectorAll('#acList > li').length).catch(() => -1);
      await sh.locator('.hwb-tab:not(.is-hub)').first().click();
      await sleep(1500);
      const g1c = await agentFrame().evaluate(() => { const s = document.getElementById('acScroll'); return s ? { top: Math.round(s.scrollTop), gap: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight), ch: s.clientHeight, shown: !document.getElementById('agentChat').hidden } : { missing: true, url: location.href, html: document.body.innerHTML.slice(0, 200) }; });
      ok(loadedBg >= 40 && g1c.ch > 100 && g1c.gap <= 2, `${c.name}: 1c the shell tab loaded the chat in the background, then was selected: it lands on the newest`, { loadedBg, ...g1c });
      await sh.close();
    }

    /* 2: to the CLI and back */
    await pg.evaluate(() => { document.getElementById('acScroll').scrollTop = 200; }); // up, but not near the top (that would auto-load older)
    await pg.evaluate(() => document.getElementById('sbar').dispatchEvent(new CustomEvent('hwb:view', { detail: { view: 'cli' }, bubbles: true })));
    await sleep(400);
    ok(!(await geo()).shown, `${c.name}: 2 the CLI view hides the chat`);
    await pg.evaluate(() => document.getElementById('sbar').dispatchEvent(new CustomEvent('hwb:view', { detail: { view: 'chat' }, bubbles: true })));
    await sleep(800);
    g = await geo();
    ok(g.shown && g.gap <= 2, `${c.name}: 2 switching back to Chat lands on the newest again (even if it was left scrolled up)`, g);

    /* 3: at the bottom, a new message stays pinned */
    newest += 1;
    await sleep(4500);
    g = await geo();
    ok(g.last === `m${newest}` && g.gap <= 2, `${c.name}: 3 at the bottom, a new message keeps it pinned (m${newest})`, g);
    const pill0 = await pg.evaluate(() => { const b = document.getElementById('acNewer'); return !b || b.hidden; });
    ok(pill0, `${c.name}: 3 ...and no "New messages" pill while pinned`);

    /* 4: scrolled up, a new message: no jump + the pill */
    await pg.evaluate(() => { const s = document.getElementById('acScroll'); s.scrollTop = Math.max(0, s.scrollHeight - s.clientHeight - 600); });
    await sleep(300);
    const before4 = await geo();
    newest += 1;
    await sleep(4500);
    g = await geo();
    ok(Math.abs(g.top - before4.top) <= 2 && g.gap > 300, `${c.name}: 4 scrolled up, a new message does NOT jump (top ${before4.top} -> ${g.top})`, { before: before4, after: g });
    const pill = await pg.evaluate(() => { const b = document.getElementById('acNewer'); return b && !b.hidden ? b.textContent.trim() : null; });
    ok(pill && /New message/.test(pill), `${c.name}: 4 ...a "New messages" pill shows`, pill);
    await pg.click('#acNewer');
    await sleep(500);
    g = await geo();
    ok(g.gap <= 2 && (await pg.evaluate(() => document.getElementById('acNewer').hidden)), `${c.name}: 4 the pill takes you to the newest and goes`, g);

    /* 5: load older keeps your place (the button, from a scroll position that is not near the top) */
    await pg.evaluate(() => { document.getElementById('acScroll').scrollTop = 300; });
    await sleep(300);
    const anchor = await pg.evaluate(() => { const s = document.getElementById('acScroll'); const sr = s.getBoundingClientRect(); const li = [...document.querySelectorAll('#acList > li')].find((x) => x.getBoundingClientRect().top >= sr.top); return { id: li.dataset.id, off: Math.round(li.getBoundingClientRect().top - sr.top), count: document.querySelectorAll('#acList > li').length }; });
    await pg.evaluate(() => document.getElementById('acOlder').click());
    await sleep(1500);
    const after5 = await pg.evaluate((id) => { const s = document.getElementById('acScroll'); const li = document.querySelector(`#acList > li[data-id="${id}"]`); return { off: li ? Math.round(li.getBoundingClientRect().top - s.getBoundingClientRect().top) : null, count: document.querySelectorAll('#acList > li').length }; }, anchor.id);
    ok(after5.off !== null && Math.abs(after5.off - anchor.off) <= 3 && after5.count > anchor.count, `${c.name}: 5 "load older" keeps your place (${anchor.id} stays at ${anchor.off}px; now ${after5.off}px, ${anchor.count} -> ${after5.count} loaded)`, { anchor, after5 });
    /* 6: SEARCH this conversation: the button, the results (every word bold), a pick of an OLD message pages history in until it is
       there, centres it and flashes it; the `more` note */
    await pg.route('**/api/sessions/*/chat/search*', async (route) => {
      const u = new URL(route.request().url());
      const qs = (u.searchParams.get('q') ?? '').toLowerCase();
      const hit = (n) => ({ id: `m${n}`, role: n % 2 ? 'user' : 'assistant', ts: 1_700_000_000_000 + n * 1000, snippet: [{ t: 'a note about ' }, { t: qs.split(' ')[0], hit: true }, { t: ' in the middle of message ' + n }], at: n > 70 ? null : `m${n + 40}` });
      const results = qs.includes('zzqq') ? [] : [hit(120), hit(7)];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ q: qs, results, more: qs.includes('deep') }) });
    });
    await pg.evaluate(() => { document.getElementById('acScroll').scrollTop = document.getElementById('acScroll').scrollHeight; });
    await pg.click('#acSearch');
    await pg.waitForSelector('.sr', { timeout: 4000 });
    await pg.fill('.sr-input', 'lorem deep');
    await pg.waitForSelector('.sr-row', { timeout: 5000 });
    const chatRes = await pg.evaluate(() => ({ count: document.querySelector('.sr-count')?.textContent ?? '', rows: [...document.querySelectorAll('.sr-row')].map((r) => ({ au: r.querySelector('.sr-au')?.textContent, bold: [...r.querySelectorAll('strong')].map((x) => x.textContent) })) }));
    ok(/^2 matches · newest first · older history not searched$/.test(chatRes.count) && chatRes.rows.length === 2 && chatRes.rows[0].bold.includes('lorem'), `${c.name}: 6 chat search: "2 matches · newest first · older history not searched", the word in bold`, chatRes);
    await pg.fill('.sr-input', 'zzqq');
    await pg.waitForSelector('.sr-none', { timeout: 5000 });
    await pg.fill('.sr-input', 'lorem');
    await pg.waitForSelector('.sr-row', { timeout: 5000 });
    await pg.locator('.sr-row').nth(1).click(); // m7: the oldest of the mock transcript (not on the page: only the newest 50 are)
    await pg.waitForFunction(() => !!document.querySelector('#acList > li[data-id="m7"]'), null, { timeout: 15000 }).catch(() => {});
    await sleep(900);
    const jumpC = await pg.evaluate(() => { const li = document.querySelector('#acList > li[data-id="m7"]'); const s = document.getElementById('acScroll'); if (!li) { return null; } const lr = li.getBoundingClientRect(); const sr = s.getBoundingClientRect(); return { found: li.classList.contains('is-found'), centre: Math.round((lr.top + lr.bottom) / 2 - (sr.top + sr.bottom) / 2), inView: lr.top >= sr.top - 1 && lr.bottom <= sr.bottom + 1, closed: !document.querySelector('.sr'), pill: !document.getElementById('acNewer').hidden }; });
    ok(jumpC && jumpC.closed && jumpC.found && jumpC.inView && !jumpC.pill, `${c.name}: 6 picking an old hit pages history in, closes the search, brings the message into view and flashes it (no snap back to the bottom)`, jumpC);
    await sleep(3000);
    const stay = await pg.evaluate(() => { const li = document.querySelector('#acList > li[data-id="m7"]'); const s = document.getElementById('acScroll'); const lr = li.getBoundingClientRect(); const sr = s.getBoundingClientRect(); return lr.top >= sr.top - 1 && lr.bottom <= sr.bottom + 1; });
    ok(stay, `${c.name}: 6 ...and a poll later it is still there`);

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
