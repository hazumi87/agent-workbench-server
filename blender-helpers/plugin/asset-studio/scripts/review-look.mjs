#!/usr/bin/env node
/*
 * review-look — open one review the way the user sees it, in headless Chromium, and save pictures.
 * Run by app/look.mjs (never by hand): argv[2] is one JSON object, the last stdout line is the answer.
 *
 *   {base, n, out, playwright, widths, mode, views, image, pin_at, save}
 *
 * The panel is loaded from this app, in an iframe, with a stand-in for the room's host (theme and the
 * panel's actions). Nothing but this app's own origin is fetched. Panel actions pass through to the app
 * EXCEPT review_mark, which only saves when `save` is true: otherwise the pin the panel would have placed
 * is reported and left unsaved.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const o = JSON.parse(process.argv[2] || '{}');
const notes = [], pictures = [];
let pin = null;
const done = (extra) => { console.log(JSON.stringify({ ok: true, pictures, pin, notes, ...extra })); process.exit(0); };
const fail = (error) => { console.log(JSON.stringify({ ok: false, error, pictures, notes })); process.exit(0); };

let chromium;
try {
  chromium = createRequire(path.join(o.playwright, 'package.json'))('playwright').chromium;
} catch {
  fail('no browser available here (set "playwright" in config.local.json to a folder that has node_modules/playwright)');
}
// The panel's own tokens are the dark palette; a host in light mode sends the whole light one. This is that set (Aurora light).
const LIGHT = { ink: 'oklch(0.985 0.012 250)', surface: 'oklch(0.965 0.012 250)', surface2: 'oklch(0.940 0.012 250)', surface3: 'oklch(0.910 0.012 250)', border: 'oklch(0.870 0.012 250)', border2: 'oklch(0.800 0.012 250)', text: 'oklch(0.250 0.007 250)', dim: 'oklch(0.470 0.012 250)', dim2: 'oklch(0.580 0.012 250)', coral: 'oklch(0.500 0.190 29)', sky: 'oklch(0.520 0.130 232)', amber: 'oklch(0.500 0.150 82)', lime: 'oklch(0.520 0.170 128)', magenta: 'oklch(0.520 0.210 356)', indigo: 'oklch(0.520 0.150 272)', 'id-orchid': 'oklch(0.600 0.160 322)' };
const origin = new URL(o.base).origin;
fs.mkdirSync(o.out, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  for (const w of o.widths) {
    const pg = await browser.newPage({ viewport: { width: w, height: 1500 }, colorScheme: o.mode });
    await pg.route('**/*', (r) => {
      const u = r.request().url();
      return u.startsWith(origin + '/') || /^(data|blob|about):/.test(u) ? r.continue() : r.abort();
    });
    pg.on('pageerror', (e) => notes.push(`page error at ${w}px: ${String(e.message).slice(0, 160)}`));
    await pg.setContent(`<body style="margin:0"><iframe id="f" src="${o.base}/tab/review?mode=${o.mode}" style="border:0;width:${w}px;height:1480px"></iframe></body>`);
    const frame = await (await pg.waitForSelector('#f')).contentFrame();
    await frame.waitForSelector('.card', { timeout: 20000 });
    await pg.exposeFunction('hostAction', async (msg) => {
      const p = msg.name === 'review_mark' ? 'marks' : msg.name === 'review_feedback' ? 'feedback' : null;
      if (!p) return { host: 'action-result', name: msg.name, ok: true };
      if (msg.name === 'review_mark' && !o.save) {
        pin = { saved: false, ...(msg.input || {}) };
        return { host: 'action-result', name: msg.name, ok: true };
      }
      const r = await (await fetch(`${o.base}/reviews/${msg.params.n}/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg.input || {}) })).json();
      if (msg.name === 'review_mark') pin = { saved: !r.error, ...(msg.input || {}) };
      return { host: 'action-result', name: msg.name, ok: !r.error, error: r.error || '' };
    });
    await pg.evaluate(({ mode, tokens }) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = async (m) => { if (m.data && m.data.panel === 'action') ch.port1.postMessage(await window.hostAction(m.data)); };
      document.getElementById('f').contentWindow.postMessage({ host: 'port' }, '*', [ch.port2]);
      ch.port1.postMessage({ host: 'theme', mode, tokens }); // the panel takes its theme over the port only
    }, { mode: o.mode, tokens: o.mode === 'light' ? LIGHT : {} });
    await pg.waitForTimeout(500);
    const shot = async (view) => {
      const file = `${w}-${view}.png`;
      await pg.screenshot({ path: path.join(o.out, file) });
      pictures.push({ view, width: w, file });
    };
    if (o.views.includes('list')) await shot('list');
    if (o.views.some((v) => v !== 'list')) {
      if (!(await frame.locator(`.card[data-n="${o.n}"]`).count())) for (const h of await frame.locator('.fold .hbar').all()) await h.click().catch(() => {});
      await frame.click(`.card[data-n="${o.n}"]`);
      await frame.waitForSelector('.vt, .rv-h', { timeout: 10000 });
      await pg.waitForTimeout(400);
      if (o.views.includes('summary')) await shot('summary');
      if (o.views.includes('focus') || o.pin_at) {
        const model = frame.locator('.vt:has(.cube)').first();
        const rows = (await frame.locator('.vt').count()) ? '.vt' : '[data-frow]'; // an older review lists its images as rows, not a strip of tiles
        const tile = o.image === null ? ((await model.count()) ? model : frame.locator(rows).first()) : frame.locator(`${rows}[data-frow="${o.image}"]`);
        if (!(await tile.count())) notes.push(o.image === null ? 'this review has no views' : `this review has no view number ${o.image}`);
        else if (o.no3d && (await tile.locator('.cube').count())) notes.push('the 3D view was not opened (see the size note); the list and summary above are taken');
        else {
          await tile.click();
          const ready = await frame.waitForSelector('.mv[data-state="ready"]', { timeout: 30000 }).then(() => true, () => false);
          const isModel = (await frame.locator('.mv').count()) > 0;
          if (isModel && !ready) notes.push(`the 3D model did not load at ${w}px (${(await frame.locator('.mv').getAttribute('data-state')) || 'no state'})`);
          if (!isModel && o.pin_at) notes.push('this view is a picture, not a 3D model: no pin was placed');
          await pg.waitForTimeout(800);
          if (o.views.includes('focus')) await shot('focus');
          if (o.pin_at && isModel && ready) {
            await frame.click('[data-pinarm]');
            await frame.waitForSelector('.mv-arm', { timeout: 5000 });
            const b = await frame.locator('.mv canvas').boundingBox();
            const x = b.x + b.width * o.pin_at[0], y = b.y + b.height * o.pin_at[1];
            await pg.mouse.move(x, y);
            await pg.mouse.down();
            await pg.mouse.move(x + 1, y + 1);
            await pg.waitForTimeout(300);
            await shot('aim');
            await pg.mouse.up();
            await pg.waitForTimeout(1000);
            if (!pin) notes.push('nothing under that point: no surface, so no pin');
            else await shot(o.save ? 'pin' : 'pin-unsaved');
          }
        }
      }
    }
    await pg.close();
  }
} catch (e) {
  notes.push(`stopped: ${String(e.message).split('\n')[0].slice(0, 200)}`);
}
await browser.close().catch(() => {});
done({});
