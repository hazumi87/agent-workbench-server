#!/usr/bin/env node
// Cut a flat illustration out of its plain background: flood fill from the border over pixels close to the
// border's colour (alpha 0), a soft 1-step edge, then trim. Interior details in the background colour stay.
import sharp from 'sharp';
const [inp, out, tol = '38'] = process.argv.slice(2);
const { data, info } = await sharp(inp).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height, T = Number(tol);
const px = (i) => [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]];
const corners = [0, W - 1, (H - 1) * W, H * W - 1].map(px);
const bg = [0, 1, 2].map((k) => corners.map((c) => c[k]).sort((a, b) => a - b)[2]);
const dist = (i) => { const p = px(i); return Math.hypot(p[0] - bg[0], p[1] - bg[1], p[2] - bg[2]); };
const a = new Uint8Array(W * H).fill(255), seen = new Uint8Array(W * H), q = [];
for (let x = 0; x < W; x++) q.push(x, (H - 1) * W + x);
for (let y = 0; y < H; y++) q.push(y * W, y * W + W - 1);
while (q.length) {
  const i = q.pop();
  if (seen[i]) continue;
  seen[i] = 1;
  const d = dist(i);
  if (d > T * 2) continue;                                  // the object: stop
  a[i] = d <= T ? 0 : Math.round(255 * (d - T) / T);         // background, or the soft edge
  if (d > T) continue;                                      // only flood on through true background
  const x = i % W, y = (i / W) | 0;
  if (x > 0) q.push(i - 1); if (x < W - 1) q.push(i + 1); if (y > 0) q.push(i - W); if (y < H - 1) q.push(i + W);
}
const rgba = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) { rgba[i * 4] = data[i * 3]; rgba[i * 4 + 1] = data[i * 3 + 1]; rgba[i * 4 + 2] = data[i * 3 + 2]; rgba[i * 4 + 3] = a[i]; }
await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).trim({ threshold: 0 }).png().toFile(out);
const m = await sharp(out).metadata();
console.log(out, m.width + 'x' + m.height, 'bg', bg.join(','));
