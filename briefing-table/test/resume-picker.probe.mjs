/* RESUME PICKER UX PROBE — the manager's Resume dialog, driven in a real browser
 * against the LIVE server engine over Serve. Exists because on 2026-09-18 the API
 * listed 7 sessions while Owner's picker said "no sessions": his click landed in
 * the ~60 s after an engine restart before the VRPC window agent (the engine's
 * file reader for VRPC transcripts, contract §5b-fs) had re-registered. The
 * API and the UX are two different questions; this asks the second one.
 * Auth: the engine bearer as an extra HTTP header (the identity login form has no
 * token field in `both` mode). Not in `npm test` (live engine). Writes a
 * screenshot to the agent-share. Exit 0 only when the picker lists this
 * session by its friendly name. */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE = 'https://server.example.ts.net:8444';
const TOKEN = readFileSync('C:/code/briefing-table/secrets/homebase-engine.token', 'utf8').trim();
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true, extraHTTPHeaders: { authorization: `Bearer ${TOKEN}` } });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('console.error:', m.text().slice(0, 160)); });
page.on('response', (r) => { if (r.url().includes('/sessions') && !r.url().includes('/api/sessions/')) console.log('HTTP', r.status(), r.url().replace(BASE, '')); });
await page.goto(`${BASE}/manager.html#recipes`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
console.log('url after login:', page.url(), '| .sess count', await page.locator('.sess').count(), '| title', await page.title());
console.log('first names:', await page.evaluate(() => [...document.querySelectorAll('.sess')].slice(0,6).map((c) => (c.querySelector('.sess-name')||c).textContent.trim().slice(0,30))));
const cards = await page.evaluate(() => [...document.querySelectorAll('.sess')].map((c) => ({ name: c.querySelector('.sess-name')?.textContent.trim(), meta: c.querySelector('.sess-meta')?.textContent.trim().slice(0, 60), hasResume: !!c.querySelector('[data-act="resume"]') })));
const target = cards.find((c) => c.name === 'Briefing Table');
console.log('cards named Briefing Table*:', cards.filter((c) => c.name?.startsWith('Briefing Table')));
if (!target || !target.hasResume) { console.log('UX FAIL: no Resume button on the Briefing Table (VRPC) card'); await b.close(); process.exit(1); }
const card = page.locator('.sess', { has: page.locator('.sess-name', { hasText: /^Briefing Table$/ }) }).first();
await card.locator('[data-act="resume"]').click();
await page.waitForTimeout(4000);
const modal = await page.evaluate(() => { const m = document.getElementById('resumeModal'); const l = document.getElementById('resumeList'); return { hidden: m.hidden, title: document.getElementById('resumeTitle')?.textContent, text: l.textContent.trim().slice(0, 200), rows: [...l.querySelectorAll('.rr-title')].map((e) => e.textContent.trim()) }; });
console.log('picker:', JSON.stringify(modal));
await page.screenshot({ path: 'C:/agent-share/briefing-table/resume-picker-probe.png' });
const ok = !modal.hidden && modal.rows.length > 0 && modal.rows.some((r) => r.includes(process.env.PROBE_SESSION_NAME || 'briefing-table migration'));
console.log(ok ? 'UX PASS — picker lists this session by name' : 'UX FAIL');
await b.close(); process.exit(ok ? 0 : 1);
