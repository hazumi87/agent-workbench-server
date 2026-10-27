/* MARKDOWN IN A CHAT BUBBLE [line markdown]  node test/line-markdown.probe.mjs   the design system spec (UI [ref]), Owner via room interface [ref]
 * A scratch engine (dead broker, temp table, never a live pane) with the REAL page and the REAL marked + DOMPurify. One message carries every element; the probe
 * asserts what only a browser can: nothing bigger than the message text, raw HTML shown as text, images as links, code and tables scrolling INSIDE the bubble,
 * @mentions kept as chips outside code / quotes, lists capped at three levels, a plain line unchanged. SHOTS_DIR saves the review screenshots (PC + phone, dark + light). */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { P, assertFree, childEnv, windowCookie } from './_scratch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = P(437);
const DEAD = P(438);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-line-markdown-token';
const SHOTS = process.env.SHOTS_DIR || '';
let failures = 0;
const ok = (c, m, d) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${d !== undefined ? `  (${typeof d === 'string' ? d : JSON.stringify(d)})` : ''}`); if (!c) { failures += 1; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runTsx = (args, env) => new Promise((resolve) => {
  const pr = spawn(process.execPath, [TSX_CLI, ...args], { cwd: REPO_ROOT, env: childEnv(env) });
  let out = ''; let err = '';
  pr.stdout.on('data', (d) => (out += d)); pr.stderr.on('data', (d) => (err += d));
  pr.on('exit', (code) => resolve({ code, out, err }));
});
await assertFree(PORT, 'line-markdown.probe.mjs');
await assertFree(DEAD, 'line-markdown.probe.mjs');
const tmpDir = mkdtempSync(join(tmpdir(), 'wb-linemd-'));
const dbPath = join(tmpDir, 'mapping.db');
let engine = null; let browser = null; let log = '';

/* the test message: every element, and the traps (raw HTML, an image, @names in code and a quote, a very long line, a wide table, a deep list) */
const LONG = 'x'.repeat(160);
const MESSAGE = [
  '# Heading one',
  '### Heading three',
  '',
  'A paragraph with **bold**, *italic*, ~~gone~~, `inline code` and a [link](https://example.com/page) plus a bare https://example.com/bare URL. Hello @studio.',
  '',
  '<b>raw html</b> <script>window.__pwned = 1</script> <img src=x onerror="window.__pwned=2">',
  '',
  '![a cat](https://example.com/cat.png)',
  '',
  '- one',
  '  - two',
  '    - three',
  '      - four (joins three)',
  '- [x] done',
  '- [ ] todo',
  '',
  '1. first',
  '2. second',
  '',
  '> a quote that says @studio but is not a mention',
  '',
  '```js',
  'const wide = "' + LONG + '"; // @studio in code is not a mention',
  ...Array.from({ length: 24 }, (_, i) => `line ${i + 1}`),
  '```',
  '',
  '| a | b | c | d | e | f |',
  '|---|---|---|---|---|---|',
  '| 1 | 2 | 3 | 4 | 5 | ' + LONG + ' |',
  '',
  '| Step |',
  '|---|',
  '| 1. Night-4 test chain passes, builds fb33s and fb33, and every long sentence in a cell has to wrap inside the bubble instead of running off the right edge |',
  '| 2. A second row that is also long enough to need more than one line in a narrow bubble, such as a phone |',
  '',
  '---',
  '',
  'the end',
].join('\n');

try {
  const seed = async (plan) => {
    const r = await runTsx([join('test', 'rooms-routes.seed.ts'), JSON.stringify(plan)], { HARBOR_WB_TABLE: dbPath, HARBOR_WB_IDENTITY: 'legacy' });
    if (r.code !== 0) { throw new Error(`seed failed: ${r.err}`); }
    return JSON.parse(r.out.trim().split('\n').pop());
  };
  await seed({ recipes: [{ id: 'rec-a', name: 'Studio', projectDir: '/srv/x/studio', vendor: 'claude-code', agent: 'studio', color: '#0dab49' }] });
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
  const seeded = (await seed({ rooms: [{ name: 'Markdown Room', seats: [{ handle: 'studio', recipe_id: 'rec-a', occupant: 'recipe:rec-a' }] }] })).rooms[0];
  const R = seeded.id;
  const cookie = await windowCookie(BASE, TOKEN);
  const post = async (text) => {
    const res = await fetch(`${BASE}/api/rooms/${R}/line`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    return res.status;
  };
  ok((await post(MESSAGE)) === 200, 'the test message (every element) is posted as the person');
  ok((await post('just a plain line, no marks at all')) === 200, 'a plain line is posted too');

  browser = await chromium.launch({ headless: true });
  const errs = [];
  const run = async (dev, mode) => {
    const phone = dev === 'phone';
    const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 780 } : dev === 'mid' ? { width: 640, height: 900 } : { width: 1400, height: 900 }, hasTouch: phone, isMobile: phone });
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errs.push(`${dev}/${mode}: ${e}`));
    await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate((t) => { const f = document.querySelector('form'); (f.querySelector('input[name=token]') || f.querySelector('input')).value = t; }, TOKEN);
    await Promise.all([pg.waitForNavigation().catch(() => {}), pg.click('form button:visible')]);
    await pg.goto(`${BASE}/room.html?room=${R}`, { waitUntil: 'domcontentloaded' });
    if (mode === 'light') {
      await pg.evaluate(async () => { const m = await import('/palette.mjs'); m.applyPref(document, { key: 'aurora', mode: 'light' }); });
    }
    await pg.waitForSelector('.entry .md', { timeout: 15000 }).catch(() => {});
    await sleep(1200);
    return { ctx, pg };
  };

  for (const dev of ['pc', 'mid', 'phone']) { // pc 1400, mid 640 (a half-width window), phone 390
    const { ctx, pg } = await run(dev, 'dark');
    const M = await pg.evaluate(() => {
      const md = document.querySelector('.entry .md');
      if (!md) { return null; }
      const bubble = md.closest('.entry-bubble');
      const fs = (el) => parseFloat(getComputedStyle(el).fontSize);
      const body = fs(md);
      const q = (s) => md.querySelector(s);
      const bw = bubble.getBoundingClientRect().width;
      const code = q('.md-code pre');
      const tbl = q('.md-table');
      const tbl2 = md.querySelectorAll('.md-table')[1];
      const cell2 = tbl2.querySelector('td');
      return {
        body,
        h1: fs(q('h1')), h3: fs(q('h3')), h1w: getComputedStyle(q('h1')).fontWeight, h3c: getComputedStyle(q('h3')).color !== getComputedStyle(q('h1')).color,
        bold: getComputedStyle(q('strong')).fontWeight, inlineCode: fs(q('p code')),
        link: { target: q('a[href^="https://example.com/page"]')?.getAttribute('target'), n: md.querySelectorAll('a[href]').length, bare: !!q('a[href="https://example.com/bare"]') },
        pwned: window.__pwned ?? null, rawHtmlText: md.textContent.includes('<b>raw html</b>') && md.textContent.includes('<script>'), scripts: md.querySelectorAll('script, img').length,
        imageAsLink: !!q('a[href="https://example.com/cat.png"]') && md.textContent.includes('a cat'),
        listDepth: Math.max(...[...md.querySelectorAll('li')].map((li) => { let n = 0; for (let p = li.parentElement; p && p !== md; p = p.parentElement) { if (p.tagName === 'UL' || p.tagName === 'OL') { n += 1; } } return n; })),
        boxes: md.textContent.includes('☑') && md.textContent.includes('☐'),
        quoteBar: getComputedStyle(q('blockquote')).borderLeftWidth,
        quoteMention: q('blockquote .mention') === null, codeMention: q('.md-code .mention') === null, textMention: !!q('p .mention'),
        copyBtn: !!q('.md-copy'), lang: q('.md-lang')?.textContent, codeMaxH: getComputedStyle(code).maxHeight, codeScrollsX: code.scrollWidth > code.clientWidth, codeScrollsY: code.scrollHeight > code.clientHeight, codeFont: fs(code),
        tableWrapScrolls: tbl.scrollWidth > tbl.clientWidth, tableOverflow: getComputedStyle(tbl).overflowX, tableFont: fs(q('table')),
        hr: !!q('hr'),
        copyAbove: (() => { const b = q('.md-copy').getBoundingClientRect(); const p = code.getBoundingClientRect(); return b.bottom <= p.top + 1; })(), copyAlways: getComputedStyle(q('.md-copy')).opacity === '1',
        langLeft: (() => { const l = q('.md-lang').getBoundingClientRect(); const b = q('.md-copy').getBoundingClientRect(); return l.right < b.left; })(),
        taskNoBullet: getComputedStyle(q('li.md-task')).listStyleType === 'none', taskCount: md.querySelectorAll('li.md-task').length,
        wrapFits: tbl2.scrollWidth <= tbl2.clientWidth, wrapW: Math.round(tbl2.querySelector('table').getBoundingClientRect().width), wrapBox: Math.round(tbl2.clientWidth), wrapLines: Math.round(cell2.getBoundingClientRect().height / parseFloat(getComputedStyle(cell2).lineHeight)), wrapMore: tbl2.classList.contains('md-more'),
        tableMore: tbl.classList.contains('md-more'), codeMore: code.classList.contains('md-more'),
        bubbleW: Math.round(bw), mdW: Math.round(md.getBoundingClientRect().width), pageScroll: document.scrollingElement.scrollWidth <= innerWidth,
        plain: [...document.querySelectorAll('.entry-body')].filter((b) => !b.querySelector('.md')).map((b) => b.textContent.trim()).filter((t) => /plain line/.test(t)),
      };
    });
    ok(!!M, `${dev}: the message renders as Markdown (a .md block)`);
    if (M) {
      ok(M.h1 === M.body && M.h3 === M.body && M.h1w === '700' && M.h3c, `${dev}: every heading is the message size, weight 700, the third level dimmer`, { body: M.body, h1: M.h1, h3: M.h3 });
      ok(M.bold === '600' && M.inlineCode < M.body, `${dev}: bold is 600; inline code is a touch smaller than the text`, { bold: M.bold, code: M.inlineCode, body: M.body });
      ok(M.link.target === '_blank' && M.link.bare, `${dev}: links open in a new tab and a bare URL is a link`, M.link);
      ok(M.pwned === null && M.scripts === 0 && M.rawHtmlText, `${dev}: raw HTML is shown as text and nothing in it runs`, { pwned: M.pwned, nodes: M.scripts });
      ok(M.imageAsLink, `${dev}: an image is a link, not a picture`);
      ok(M.listDepth <= 3 && M.boxes, `${dev}: lists stop at three levels; task boxes are read-only glyphs`, { depth: M.listDepth });
      ok(M.quoteBar === '2px' && M.quoteMention && M.codeMention && M.textMention, `${dev}: a quote has its 2px bar; an @name in a quote or in code is NOT a mention chip; in the text it is`, { quote: M.quoteMention, code: M.codeMention, text: M.textMention });
      ok(M.copyAbove && M.copyAlways && M.langLeft, `${dev}: Copy sits in a header strip above the code (language on the left), not over the first line, always visible`, { above: M.copyAbove, always: M.copyAlways, langLeft: M.langLeft });
      ok(M.taskNoBullet && M.taskCount === 2, `${dev}: a task item has no bullet, the box takes its place`, { none: M.taskNoBullet, n: M.taskCount });
      ok(M.tableMore && M.codeMore, `${dev}: a table and a code block that scroll sideways fade at the right edge`, { table: M.tableMore, code: M.codeMore });
      ok(M.copyBtn && M.lang === 'js' && M.codeMaxH === '320px' && M.codeScrollsX && M.codeScrollsY && M.codeFont === 12.5, `${dev}: the code block has Copy and its language, is capped at 320px and scrolls inside itself`, { lang: M.lang, maxH: M.codeMaxH, x: M.codeScrollsX, y: M.codeScrollsY });
      ok(M.tableOverflow === 'auto' && M.tableWrapScrolls && M.tableFont === M.body && M.hr, `${dev}: the table scrolls inside itself at the message's own size; a rule is a rule`, { overflow: M.tableOverflow, scrolls: M.tableWrapScrolls });
      ok(M.wrapFits && !M.wrapMore && Math.abs(M.wrapW - M.wrapBox) <= 1 && M.wrapLines >= 2, `${dev}: a table with long cells takes the bubble's width and its cells wrap; it does not scroll`, { fits: M.wrapFits, table: M.wrapW, box: M.wrapBox, lines: M.wrapLines });
      ok(M.mdW <= M.bubbleW && M.pageScroll, `${dev}: nothing widens the bubble or the page`, { bubble: M.bubbleW, md: M.mdW, pageFits: M.pageScroll });
      ok(M.plain.length >= 1, `${dev}: a line with no marks is the plain line, untouched`, M.plain);
    }
    if (SHOTS) { await pg.screenshot({ path: join(SHOTS, `markdown-${dev}-dark.png`) }); }
    /* the TOP of the message: headings, emphasis, inline code, links */
    if (SHOTS) { await pg.evaluate(() => document.querySelector('.entry .md').closest('.entry-bubble').scrollIntoView({ block: 'start' })); await sleep(300); await pg.screenshot({ path: join(SHOTS, `markdown-${dev}-dark-top.png`) }); }
    /* the fade goes once a table is scrolled to its end */
    const endFade = await pg.evaluate(async () => { const t = document.querySelector('.md .md-table'); t.scrollLeft = t.scrollWidth; await new Promise((r) => setTimeout(r, 200)); return t.classList.contains('md-more'); });
    ok(endFade === false, `${dev}: scrolled to its end, the table's fade is gone`);
    await ctx.close();
    const light = await run(dev, 'light');
    if (SHOTS) { await light.pg.screenshot({ path: join(SHOTS, `markdown-${dev}-light.png`) }); await light.pg.evaluate(() => document.querySelector('.entry .md').closest('.entry-bubble').scrollIntoView({ block: 'start' })); await sleep(300); await light.pg.screenshot({ path: join(SHOTS, `markdown-${dev}-light-top.png`) }); }
    await light.ctx.close();
  }
  ok(errs.length === 0, 'no page errors', errs.slice(0, 3));
} finally {
  if (browser) { await browser.close(); }
  if (engine) { engine.kill(); }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
