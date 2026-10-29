#!/usr/bin/env node
/*
 * colormatch — pull a view's colours onto the reference view's, class by class, so a set of
 * character views reads as ONE character (a 3D generator bakes colour into the texture, and
 * a different hair or hoodie tone per view becomes a seam).
 *
 *   node app/colormatch.mjs <reference.png> <target.png> <out.png>      (the app's color_match verb uses it too)
 *
 * Each non-background pixel belongs softly to three classes by its luma and saturation:
 * DARK (hair, outlines), SKIN (saturated), CLOTH (neutral mid tones). For each class the
 * target's mean RGB is shifted to the reference's mean, weighted per pixel — so skin moves
 * toward the reference's skin, hair toward its hair, cloth toward its cloth. Near-white
 * background is left alone. Deterministic, no GPU; ffmpeg does the PNG decode/encode.
 * Zero dependencies (node >= 20 + ffmpeg).
 */
import { execFileSync } from 'node:child_process';

function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim();
  const [w, h] = out.split(',').map(Number);
  return { w, h };
}
export function decode(file) {
  const { w, h } = probe(file);
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
  return { w, h, px: buf };
}
export function encode(file, { w, h, px }) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-i', '-', file], { input: px });
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/* Soft class weights [dark, skin, cloth] + a background flag, from one pixel. */
export function weights(r, g, b) {
  const y = 0.3 * r + 0.59 * g + 0.11 * b;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const sat = mx ? (mx - mn) / mx : 0;
  if (y > 236 && sat < 0.08) return null;                 // background
  const dark = clamp((110 - y) / 50, 0, 1);               // hair, outlines
  const s = clamp((sat - 0.12) / 0.14, 0, 1) * (1 - dark); // skin: saturated, not dark
  const cloth = Math.max(0, 1 - dark - s);                 // neutral mid tones
  return [dark, s, cloth];
}

function stats(img) {
  const sum = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], wsum = [0, 0, 0];
  const p = img.px;
  for (let i = 0; i < p.length; i += 3) {
    const w = weights(p[i], p[i + 1], p[i + 2]);
    if (!w) continue;
    for (let c = 0; c < 3; c++) {
      if (!w[c]) continue;
      wsum[c] += w[c];
      sum[c][0] += w[c] * p[i]; sum[c][1] += w[c] * p[i + 1]; sum[c][2] += w[c] * p[i + 2];
    }
  }
  return sum.map((s, c) => (wsum[c] > 50 ? s.map((v) => v / wsum[c]) : null));
}

/* Lift near-black pixels to a warm neutral grey of the same (brighter) luma — an edit model
   often renders hair blue-black or dead black where the reference has grey highlights. */
export function liftDark(img) {
  const out = Buffer.from(img.px);
  for (let i = 0; i < out.length; i += 3) {
    const y = 0.3 * out[i] + 0.59 * out[i + 1] + 0.11 * out[i + 2];
    const w = clamp((120 - y) / 60, 0, 1);
    if (!w) continue;
    const t = [y * 1.25 + 26, y * 1.25 + 20, y * 1.25 + 15];
    for (let k = 0; k < 3; k++) out[i + k] = clamp(Math.round(out[i + k] * (1 - w) + t[k] * w), 0, 255);
  }
  return { ...img, px: out };
}

/* The whole step, file to file. */
export function colorMatchFiles(refFile, tgtFile, outFile, { lift = true } = {}) {
  const ref = decode(refFile);
  let tgt = decode(tgtFile);
  if (lift) tgt = liftDark(tgt);
  const r = match(ref, tgt);
  encode(outFile, r.img);
  return { w: tgt.w, h: tgt.h, ref: r.ref, before: r.before };
}

export function match(ref, tgt) {
  const mr = stats(ref), mt = stats(tgt);
  const delta = mr.map((m, c) => (m && mt[c] ? m.map((v, k) => v - mt[c][k]) : [0, 0, 0]));
  const out = Buffer.from(tgt.px);
  for (let i = 0; i < out.length; i += 3) {
    const w = weights(out[i], out[i + 1], out[i + 2]);
    if (!w) continue;
    for (let k = 0; k < 3; k++) {
      const d = w[0] * delta[0][k] + w[1] * delta[1][k] + w[2] * delta[2][k];
      out[i + k] = clamp(Math.round(out[i + k] + d), 0, 255);
    }
  }
  return { img: { ...tgt, px: out }, ref: mr, before: mt, delta };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const [refFile, tgtFile, outFile] = process.argv.slice(2);
  if (!outFile) {
    console.error('usage: colormatch.mjs <reference.png> <target.png> <out.png>');
    process.exit(64);
  }
  const r = match(decode(refFile), decode(tgtFile));
  encode(outFile, r.img);
  const f = (m) => (m ? m.map((v) => Math.round(v)).join(',') : '-');
  console.log(JSON.stringify({ out: outFile, classes: ['dark', 'skin', 'cloth'].map((n, c) => `${n}: ${f(r.before[c])} -> ${f(r.ref[c])}`) }));
}
