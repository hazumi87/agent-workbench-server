import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { renderTile, copies, stats } from '../lib/render.mjs';
import { tintRaw } from '../lib/tint.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-'));
// an asymmetric grey element: a disc with a notch, transparent around it
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><ellipse cx="80" cy="60" rx="70" ry="45" fill="#808080"/><rect x="140" y="50" width="55" height="20" fill="#404040"/></svg>`;
fs.writeFileSync(path.join(dir, 'e.png'), await sharp(Buffer.from(svg)).png().toBuffer());
const raw = async (png) => (await sharp(png).raw().toBuffer({ resolveWithObject: true }));

test('copies: an element across an edge is drawn again on the opposite side', () => {
  assert.deepEqual(copies(10, 50, 40, 40, 100, 100).sort(), [[-10, 30], [90, 30]].sort());
  assert.equal(copies(50, 50, 40, 40, 100, 100).length, 1);
  assert.equal(copies(0, 0, 40, 40, 100, 100).length, 4); // a corner: four copies
  assert.ok(copies(50, 50, 250, 250, 100, 100).length >= 9); // bigger than the tile
});

test('seamless by construction: shifting everything by half a tile equals rolling the tile by half', async () => {
  const W = 256, H = 256;
  const base = { w: W, h: H, bg: '#202020', shadow: { distance: 10, blur: 6, opacity: 0.4 }, elements: [
    { src: 'e.png', x: 10, y: 20, scale: 0.8, rot: 30 },
    { src: 'e.png', x: 240, y: 200, scale: 1, rot: -50, flip: 'h', tint: { color: '#c04040' }, z: 2 },
    { src: 'e.png', x: 128, y: 250, scale: 0.6, z: 1 },
  ] };
  const a = await raw(await renderTile(base, dir));
  const shifted = { ...base, elements: base.elements.map(e => ({ ...e, x: (e.x + W / 2) % W, y: (e.y + H / 2) % H })) };
  const b = await raw(await renderTile(shifted, dir));
  const c = a.info.channels;
  let worst = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
    for (let k = 0; k < c; k++) {
      const ia = (y * W + x) * c + k, ib = (((y + H / 2) % H) * W + ((x + W / 2) % W)) * c + k;
      worst = Math.max(worst, Math.abs(a.data[ia] - b.data[ib]));
    }
  assert.ok(worst <= 3, `max channel difference ${worst}`);
});

test('tint: a mid grey recoloured keeps its lightness; desaturate greys a colour', () => {
  const g = Buffer.from([128, 128, 128, 255]);
  tintRaw(g, { color: '#c04040' });
  assert.ok(g[0] > g[1] && g[0] > g[2]);
  const lum = (b) => 0.3 * b[0] + 0.59 * b[1] + 0.11 * b[2];
  assert.ok(Math.abs(lum(g) - 128) < 3);
  const c = Buffer.from([200, 40, 40, 255]);
  tintRaw(c, { desaturate: 1 });
  assert.ok(Math.abs(c[0] - c[1]) < 2 && Math.abs(c[1] - c[2]) < 2);
  const d = Buffer.from([128, 128, 128, 255]);
  tintRaw(d, { brightness: 0.5 });
  assert.ok(d[0] < 70);
});

test('shadow follows one light direction: light from the top-left casts toward the bottom-right', async () => {
  const mk = (shadow) => ({ w: 200, h: 200, bg: '#ffffff', light: { angle: 315 }, shadow,
    elements: [{ src: 'e.png', x: 100, y: 100, scale: 0.5 }] });
  const withS = await raw(await renderTile(mk({ distance: 20, blur: 2, opacity: 0.8 }), dir));
  const noS = await raw(await renderTile(mk(false), dir));
  const c = withS.info.channels;
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
    const d = noS.data[(y * 200 + x) * c] - withS.data[(y * 200 + x) * c];
    if (d > 30) { sx += x; sy += y; n++; }
  }
  assert.ok(n > 50);
  // the shadow's centre sits right of and below the element's (the ellipse centre, about (92, 100) before the offset)
  assert.ok(sx / n > 100 && sy / n > 100, `centroid ${sx / n}, ${sy / n}`);
});

test('stats flags a tile outside the tint range', async () => {
  const flat = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#808080' } }).png().toBuffer();
  assert.equal((await stats(flat)).tint_set_ok, true);
  const white = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ffffff' } }).png().toBuffer();
  assert.equal((await stats(white)).tint_set_ok, false);
});
