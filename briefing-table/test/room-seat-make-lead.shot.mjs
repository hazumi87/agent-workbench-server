/* MOCK shot of the seat menu's Make lead (never a live pane): serves web/ statically,
 * a page with two stub seat rows, a stubbed api. 1280 + 390; asserts the PATCH body,
 * the disabled state on the lead and the inline refusal.  node test/room-seat-make-lead.shot.mjs [outdir] */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const OUT = process.argv[2] ?? '/tmp/claude-1001/shots';
mkdirSync(OUT, { recursive: true });
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
const PAGE = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width, initial-scale=1">
<link rel=stylesheet href=/vendor/aurora-tokens.css><link rel=stylesheet href=/room.css><link rel=stylesheet href=/room-toast.css>
<body style="background:var(--bg,#111);color:var(--fg,#eee)"><ul id=roster style="list-style:none;padding:12px;max-width:300px"></ul>
<script type=module>
import { createSeatMenu } from '/room-seat-menu.mjs';
const seats = [{ id: 's1', handle: 'lead', status: 'live', actions: [], occupant: { id: 'p1', state: 'live' } }, { id: 's2', handle: 'builder', status: 'live', actions: [], occupant: { id: 'p2', state: 'live' } }];
window.calls = []; window.errors = []; window.refuse = true;
const m = createSeatMenu({ roomId: 'r1', api: async (p, o) => { window.calls.push({ p, o }); return window.refuse ? { ok: false, status: 409, body: { error: 'seat is not live in this room' } } : { ok: true, status: 200, body: { entries: [] } }; },
  room: () => ({ id: 'r1' }), seat: (id) => seats.find((s) => s.id === id), leadId: () => 's1', entries: () => [], act() {}, openWindow() {},
  applied: async () => {}, disconnected() {}, error: (t) => { window.errors.push(t); const d = document.createElement('div'); d.id = 'err'; d.textContent = t; document.body.append(d); }, redraw() {}, moveTargets: () => [] });
for (const s of seats) { const li = document.createElement('li'); li.className = 'seat'; li.tabIndex = 0; li.innerHTML = '<div class=seat-top><b>@' + s.handle + '</b></div>'; document.getElementById('roster').append(li); m.decorate(li, s); }
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
for (const [w, h] of [[1280, 800], [390, 700]]) {
  const pg = await br.newPage({ viewport: { width: w, height: h }, hasTouch: w < 600 });
  await pg.goto(base); await pg.waitForFunction(() => window.ready);
  const open = async (n) => { await pg.locator('.seat .rsm-more').nth(n).click({ force: true }); await pg.waitForSelector('.rsm-mi'); };
  await open(0);
  const lead = pg.locator('.rsm-mi', { hasText: 'Make lead' });
  ok(await lead.getAttribute('aria-disabled') === 'true', `${w}: disabled on the lead`);
  await pg.keyboard.press('Escape');
  await open(1);
  ok(await pg.locator('.rsm-mi', { hasText: 'Make lead' }).getAttribute('aria-disabled') !== 'true', `${w}: enabled on a non-lead seat`);
  await pg.screenshot({ path: join(OUT, `make-lead-menu-${w}.png`) });
  await pg.locator('.rsm-mi', { hasText: 'Make lead' }).click();
  await pg.waitForSelector('#err');
  const c = await pg.evaluate(() => window.calls[0]);
  ok(c.p === '/api/rooms/r1' && c.o.method === 'PATCH' && c.o.json.lead_seat === 's2', `${w}: PATCH /api/rooms/r1 {lead_seat:'s2'}`);
  ok(/builder not made lead — seat is not live/.test(await pg.locator('#err').textContent()), `${w}: the refusal is shown`);
  ok(await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${w}: no sideways scroll`);
  await pg.screenshot({ path: join(OUT, `make-lead-refused-${w}.png`) });
  await pg.close();
}
await br.close(); srv.close();
console.log(bad ? `FAIL ${bad}` : 'PASS');
process.exit(bad ? 1 : 0);
