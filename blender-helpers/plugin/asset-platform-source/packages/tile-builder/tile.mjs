#!/usr/bin/env node
// tile-builder: node tile.mjs <composition.json> [--out <dir>] [--name <base>] [--sheet <px per tile>]
// Writes <name>.png (full size), <name>-512.png, <name>-3x3.png and <name>-stats.json into --out (default: next to the composition).
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { renderTile, sheet3x3, stats } from './lib/render.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; return args.splice(i, 2)[1]; };
const out = opt('--out'), name0 = opt('--name'), sheetPx = Number(opt('--sheet', 256));
const file = args[0];
if (!file) { console.error('usage: node tile.mjs <composition.json> [--out dir] [--name base] [--sheet px]'); process.exit(2); }
const comp = JSON.parse(fs.readFileSync(file, 'utf8'));
const dir = path.resolve(out || path.dirname(file));
const name = name0 || path.basename(file, '.json');
fs.mkdirSync(dir, { recursive: true });
const t0 = Date.now();
const tile = await renderTile(comp, path.dirname(path.resolve(file)));
const small = await sharp(tile).resize(512, Math.round((512 * (comp.h ?? 1024)) / (comp.w ?? 1024)), { fit: 'fill' }).png().toBuffer(); // 512 wide, same shape
const files = {
  tile: `${name}.png`, tile512: `${name}-512.png`, sheet: `${name}-3x3.png`, stats: `${name}-stats.json`,
};
fs.writeFileSync(path.join(dir, files.tile), tile);
fs.writeFileSync(path.join(dir, files.tile512), small);
fs.writeFileSync(path.join(dir, files.sheet), await sheet3x3(tile, sheetPx));
const st = { ...(await stats(tile)), w: comp.w ?? 1024, h: comp.h ?? 1024, elements: (comp.elements || []).length, ms: Date.now() - t0 };
fs.writeFileSync(path.join(dir, files.stats), JSON.stringify(st, null, 2));
console.log(JSON.stringify({ dir, files, stats: st }, null, 2));
