/* MOCK shots (never a live pane): Room settings -> Workgroups, and the agent-chat avatar.
 * node test/room-wg-settings.shot.mjs [outdir]  -- serves web/ statically, stubbed api, 1280 + 390. */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const OUT = process.argv[2] ?? '/tmp/claude-1001/shots';
mkdirSync(OUT, { recursive: true });
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
const PIC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PAGE = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width, initial-scale=1">
<link rel=stylesheet href=/vendor/aurora-tokens.css><link rel=stylesheet href=/room.css><link rel=stylesheet href=/agent-chat.css>
<body style="background:var(--bg,#111);color:var(--fg,#eee);padding:12px"><div class=pv-set id=set style="max-width:420px"></div>
<div class=ac id=chat style="max-width:420px;margin-top:12px"><ul style="list-style:none;padding:0;display:grid;gap:8px" id=ul></ul></div>
<script type=module>
import { workgroupsGroup } from '/room-workgroups-settings.mjs';
import { youGlyph } from '/you-settings.mjs';
let wgs = [{ id: 'w1', name: 'UI', alias: 'ui', color: '#4aa3ff', state: 'open' }, { id: 'w2', name: 'Alpha Platform', alias: 'asset', color: null, state: 'open' }];
window.calls = []; window.refuse = false;
const api = async (p, o) => { window.calls.push({ p, o }); return window.refuse ? { ok: false, status: 409, body: { error: 'name already taken in this family' } } : { ok: true, status: 200, body: {} }; };
const g = workgroupsGroup({ list: () => wgs, api, swatches: ['#4aa3ff', '#e5484d', '#30a46c'], touch: innerWidth < 600, refresh: async () => { wgs = wgs.map((w) => (w.id === window.rename?.id ? { ...w, name: window.rename.name } : w)); g.paint(); } });
document.getElementById('set').append(g.el);
for (const me of [{ name: 'Owner', picture: ${JSON.stringify(PIC)} }, { name: '', picture: null }]) {
  const li = document.createElement('li'); li.className = 'entry by-user'; const gl = document.createElement('span'); gl.className = 'entry-glyph'; gl.append(youGlyph(me));
  const b = document.createElement('div'); b.className = 'entry-bubble'; b.textContent = me.picture ? 'with a picture' : 'no picture, no name: the generic icon'; li.append(gl, b); document.getElementById('ul').append(li);
}
window.ready = true;
</script>`;
const srv = createServer((req, res) => {
  const u = new URL(req.url, 'http://x').pathname;
  if (u === '/') { res.setHeader('content-type', 'text/html'); res.end(PAGE); return; }
  const f = join(WEB, u);
  if (!f.startsWith(WEB) || !existsSync(f)) { res.statusCode = 404; res.end(); return; }
  res.setHeader('content-type', MIME[extname(f)] ?? 'application/octet-stream'); res.end(readFileSync(f));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}/`;
let bad = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); if (!c) bad++; };
const br = await chromium.launch();
for (const [w, h] of [[1280, 800], [390, 800]]) {
  const pg = await br.newPage({ viewport: { width: w, height: h }, hasTouch: w < 600 });
  await pg.goto(base); await pg.waitForFunction(() => window.ready);
  ok(await pg.locator('.pv-wg-row').count() === 2, `${w}: two workgroups listed`);
  ok((await pg.locator('.pv-wg-alias').allTextContents()).join() === '@ui,@asset', `${w}: aliases shown read-only`);
  await pg.evaluate(() => { window.refuse = true; });
  await pg.locator('.pv-wg-name').nth(1).fill('UI');
  await pg.locator('.pv-wg-name').nth(1).press('Enter');
  await pg.waitForSelector('.pv-wg-msg[data-kind=error]');
  const c1 = await pg.evaluate(() => window.calls[0]);
  ok(c1.p === '/api/rooms/w2' && c1.o.method === 'PATCH' && JSON.stringify(c1.o.json) === '{"name":"UI"}', `${w}: PATCH /api/rooms/w2 {name} only`);
  ok(/name already taken/.test(await pg.locator('.pv-wg-msg[data-kind=error]').textContent()), `${w}: refusal shown inline`);
  await pg.evaluate(() => { window.refuse = false; window.rename = { id: 'w2', name: 'Assets' }; });
  await pg.locator('.pv-wg-name').nth(1).fill('Assets');
  await pg.locator('.pv-wg-name').nth(1).press('Enter');
  await pg.waitForFunction(() => document.querySelectorAll('.pv-wg-name')[1].value === 'Assets' && document.querySelector('.pv-wg-name') !== document.activeElement);
  await pg.locator('.pv-wg-sw').nth(1).click();
  await pg.waitForSelector('.rsm-csws');
  await pg.locator('.rsm-csw').nth(2).click();
  await pg.locator('[data-a=save]').click();
  await pg.waitForFunction(() => window.calls.some((c) => c.p.endsWith('/w2/settings')));
  const c2 = await pg.evaluate(() => window.calls.find((c) => c.p.endsWith('/settings')));
  ok(c2.p === '/api/rooms/w2/settings' && c2.o.json.color === '#30a46c', `${w}: swatch -> picker -> PATCH settings {color}`);
  ok(await pg.locator('.ac .entry-glyph img').count() === 1 && await pg.locator('.ac .entry-glyph .you-person').count() === 1, `${w}: avatar picture; generic icon as the fallback`);
  ok(await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${w}: no sideways scroll`);
  await pg.screenshot({ path: join(OUT, `wg-settings-${w}.png`), fullPage: true });
  await pg.close();
}
await br.close(); srv.close();
console.log(bad ? `FAIL ${bad}` : 'PASS');
process.exit(bad ? 1 : 0);
