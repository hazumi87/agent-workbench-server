#!/usr/bin/env node
// Look at a tile behind a real chat: node shots.mjs (--tile <png> | --asset <library id> | --background <url>) [--out dir] [--name base]
//   [--strengths 0.12,0.25] [--themes dark,light] [--page <url>] [--color <room hex>] [--blend soft-light]
// Loads Aurora's chat test page in headless Chromium and writes, per theme and strength, a PC shot (1280 wide, tile 256 px) and a phone shot
// (390 wide, tile 192 px) — <name>-<pc|phone>-<theme>-<strength>.png — and <name>-sheet.png, one contact sheet of all of them.
// --tile serves a local file to the page (no upload needed); --asset uses the Library file path; --background any URL the page can load.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; return args.splice(i, 2)[1]; };
const tileFile = opt('--tile'), asset = opt('--asset'), bgUrl = opt('--background');
const dir = path.resolve(opt('--out', '.')), name = opt('--name', 'chat');
const strengths = opt('--strengths', '0.12,0.25').split(',').map(s => s.trim());
const themes = opt('--themes', 'dark,light').split(',').map(s => s.trim());
const PAGE = opt('--page', 'http://127.0.0.1/styleguide/mockups/chat-page.html');
const color = opt('--color'), blend = opt('--blend');
if (!tileFile && !asset && !bgUrl) { console.error('usage: node shots.mjs (--tile <png> | --asset <id> | --background <url>) [--out dir] [--name base] [--strengths a,b] [--themes dark,light]'); process.exit(2); }

const origin = new URL(PAGE).origin;
const TILE_PATH = '/__tile-builder-tile.png';
const background = tileFile ? `${origin}${TILE_PATH}` : asset ? `/asset-management/library/api/assets/${asset}/file` : bgUrl;
const VIEWS = [{ id: 'pc', width: 1280, height: 800, tile: 256 }, { id: 'phone', width: 390, height: 844, tile: 192 }];
fs.mkdirSync(dir, { recursive: true });

const browser = await chromium.launch({ args: ['--disable-features=LocalNetworkAccessChecks'] });
const shots = [];
try {
  for (const v of VIEWS) {
    const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: 1 });
    if (tileFile) await ctx.route(`**${TILE_PATH}`, (route) => route.fulfill({ path: path.resolve(tileFile), contentType: 'image/png' }));
    const page = await ctx.newPage();
    for (const theme of themes) for (const strength of strengths) {
      const q = new URLSearchParams({ background, tile: String(v.tile), strength, theme });
      if (color) q.set('color', color);
      if (blend) q.set('blend', blend);
      await page.goto(`${PAGE}?${q}`, { waitUntil: 'load' });
      await page.evaluate(() => Promise.all([...document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; })))).catch(() => {});
      await page.waitForTimeout(400);
      const file = `${name}-${v.id}-${theme}-${strength}.png`;
      await page.screenshot({ path: path.join(dir, file) });
      shots.push({ file, view: v.id, theme, strength });
    }
    await ctx.close();
  }
} finally { await browser.close(); }

// contact sheet: a column per theme+strength, the PC shot over the phone shot
const colW = 420, label = 26;
const cols = [];
for (const theme of themes) for (const strength of strengths) cols.push({ theme, strength });
const cells = [];
let y = 0, rowH = [];
for (const v of VIEWS) {
  let h = 0;
  for (const [i, c] of cols.entries()) {
    const s = shots.find(x => x.view === v.id && x.theme === c.theme && x.strength === c.strength);
    const img = await sharp(path.join(dir, s.file)).resize({ width: v.id === 'pc' ? colW : Math.round(colW * 0.45) }).png().toBuffer();
    const m = await sharp(img).metadata();
    h = Math.max(h, m.height);
    cells.push({ input: img, left: i * colW + 8, top: label + y + 4 });
  }
  y += h + 8; rowH.push(h);
}
const heads = cols.map((c, i) => `<text x="${i * colW + 10}" y="18" font-family="sans-serif" font-size="15" fill="#fff">${c.theme} · strength ${c.strength}</text>`).join('');
const head = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cols.length * colW}" height="${label}"><rect width="100%" height="100%" fill="#222"/>${heads}</svg>`);
await sharp({ create: { width: cols.length * colW, height: label + y + 4, channels: 3, background: '#222' } })
  .composite([{ input: head, left: 0, top: 0 }, ...cells]).png().toFile(path.join(dir, `${name}-sheet.png`));
console.log(JSON.stringify({ dir, shots: shots.map(s => s.file), sheet: `${name}-sheet.png`, background }, null, 2));
