// The companion file <file>.annotations.svg, the design notes §16.1, §16.5 and the owner's answers §16.9. Pure.
// One file per picture, named for the whole file name. It holds only raw geometry and labels: one group per
// mark with its kind, plain letter and attachment number, points as fractions of the picture in a 0 0 1 1
// box, and the picture's pixel size on the root. No styling: the viewer draws the marks itself.
// Agents will read and write this file too, so readCompanion() is strict: a closed grammar (no entities,
// comments, text, scripts or unknown attributes), bounded size and count, and each refusal names its reason.
// test/image-viewer-companion.test.mjs.

import { MAX_MARKS, MAX_SIDE_PX, letterFor, indexOfLetter } from './marks.js';

export const MAX_BYTES = 256 * 1024;
const FORMAT = 'workbench-annotations';
const NS = 'http://www.w3.org/2000/svg';
const NAME_BAD = /[\\/:\0]/;

/** `ogre.png` → `ogre.png.annotations.svg`; null for anything that is not a plain file name. */
export function companionName(file) {
  if (typeof file !== 'string' || !file || file.length > 200 || NAME_BAD.test(file) || file === '.' || file === '..') return null;
  return file + '.annotations.svg';
}

const num = (v) => String(Math.round(v * 1e6) / 1e6);
const in01 = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const sizeOk = (v) => Number.isInteger(v) && v > 0 && v <= MAX_SIDE_PX;
const fail = (error) => { throw Object.assign(new Error(error), { code: error }); };

/** Check saved marks ({width, height, next, marks}) and the attachment number; throws the reader's reason. */
function check(saved, attachment) {
  if (!saved || !sizeOk(saved.width) || !sizeOk(saved.height)) fail('bad-size');
  if (!Number.isInteger(attachment) || attachment < 1 || attachment > 999) fail('bad-attachment');
  if (!Array.isArray(saved.marks)) fail('grammar');
  if (saved.marks.length > MAX_MARKS) fail('too-many');
  const used = new Set();
  let top = -1;
  for (const m of saved.marks) {
    const i = indexOfLetter(m && m.letter);
    if (i < 0) fail('bad-letter');
    if (used.has(m.letter)) fail('duplicate-letter');
    used.add(m.letter);
    top = Math.max(top, i);
    if (m.kind === 'pin') { if (!m.at || !in01(m.at.x) || !in01(m.at.y)) fail('bad-point'); }
    else if (m.kind === 'box') {
      const b = m.box;
      if (!b || ![b.x1, b.y1, b.x2, b.y2].every(in01)) fail('bad-point');
      if (b.x2 < b.x1 || b.y2 < b.y1) fail('bad-box');
    } else fail('grammar');
  }
  if (!Number.isSafeInteger(saved.next) || saved.next <= top || indexOfLetter(letterFor(saved.next)) < 0) fail('bad-next');
}

/** Saved marks → the file's text. Throws (with the reader's reason) rather than write a file it would refuse. */
export function writeCompanion(saved, { attachment } = {}) {
  check(saved, attachment);
  const rows = saved.marks.map((m) => {
    const head = `  <g data-kind="${m.kind}" data-letter="${m.letter}" data-attachment="${attachment}">`;
    const shape = m.kind === 'pin'
      ? `<circle cx="${num(m.at.x)}" cy="${num(m.at.y)}" r="0"/>`
      : `<rect x="${num(m.box.x1)}" y="${num(m.box.y1)}" width="${num(m.box.x2 - m.box.x1)}" height="${num(m.box.y2 - m.box.y1)}"/>`;
    return head + shape + '</g>\n';
  });
  return `<svg xmlns="${NS}" viewBox="0 0 1 1" data-format="${FORMAT}" data-version="1" data-image-width="${saved.width}" data-image-height="${saved.height}" data-next="${letterFor(saved.next)}">\n` + rows.join('') + '</svg>\n';
}

// The closed grammar: a tag with only name="value" attributes, values free of < > & and quotes.
const TAG = /^<(\/?)([a-z]+)((?:\s+[A-Za-z][A-Za-z-]*="[^"<>&]*")*)\s*(\/?)>/;
const ATTR = /([A-Za-z][A-Za-z-]*)="([^"<>&]*)"/g;
const NUMBER = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:e-?\d+)?$/;
const ROOT_KEYS = ['xmlns', 'viewBox', 'data-format', 'data-version', 'data-image-width', 'data-image-height', 'data-next'];
const GROUP_KEYS = ['data-kind', 'data-letter', 'data-attachment'];
const SHAPE_KEYS = { circle: ['cx', 'cy', 'r'], rect: ['x', 'y', 'width', 'height'] };

function attrs(text, keys) {
  const out = {};
  for (const [, k, v] of text.matchAll(ATTR)) {
    if (k in out) return null;
    out[k] = v;
  }
  const got = Object.keys(out);
  return got.length === keys.length && keys.every((k) => k in out) ? out : null;
}
const parseNum = (s) => (NUMBER.test(s) ? Number(s) : NaN);

/** The file's text → {ok:true, value:{width, height, next, attachment, marks}} or {ok:false, error}. */
export function readCompanion(text) {
  if (typeof text !== 'string') return { ok: false, error: 'not-text' };
  if (text.length > MAX_BYTES) return { ok: false, error: 'too-big' };
  let s = text.replace(/^﻿/, '').replace(/^<\?xml[^?<>]*\?>/, '');
  const toks = [];
  s = s.trimStart();
  while (s.length) {
    if (s[0] !== '<') return { ok: false, error: toks.length ? 'grammar' : 'not-annotations' };
    const t = TAG.exec(s);
    if (!t) return { ok: false, error: toks.length ? 'grammar' : 'not-annotations' };
    toks.push({ close: !!t[1], name: t[2], attrs: t[3], self: !!t[4] });
    s = s.slice(t[0].length).trimStart();
  }
  const root = toks[0];
  if (!root || root.name !== 'svg' || root.close || root.self) return { ok: false, error: 'not-annotations' };
  const r = attrs(root.attrs, ROOT_KEYS);
  if (!r) return { ok: false, error: /data-format="workbench-annotations"/.test(root.attrs) ? 'grammar' : 'not-annotations' };
  if (r['data-format'] !== FORMAT || r.xmlns !== NS) return { ok: false, error: 'not-annotations' };
  if (r['data-version'] !== '1') return { ok: false, error: 'version' };
  if (r.viewBox !== '0 0 1 1') return { ok: false, error: 'grammar' };
  const width = /^\d{1,6}$/.test(r['data-image-width']) ? Number(r['data-image-width']) : NaN;
  const height = /^\d{1,6}$/.test(r['data-image-height']) ? Number(r['data-image-height']) : NaN;
  const nextIndex = indexOfLetter(r['data-next']);

  const marks = [];
  let attachment = null;
  let i = 1;
  for (; i < toks.length - 1; i += 3) {
    const [g, shape, end] = [toks[i], toks[i + 1], toks[i + 2]];
    if (!g || g.name !== 'g' || g.close || g.self || !shape || shape.close || !shape.self || !end || end.name !== 'g' || !end.close) return { ok: false, error: 'grammar' };
    const ga = attrs(g.attrs, GROUP_KEYS);
    if (!ga) return { ok: false, error: 'grammar' };
    const kind = ga['data-kind'];
    if ((kind === 'pin' && shape.name !== 'circle') || (kind === 'box' && shape.name !== 'rect') || (kind !== 'pin' && kind !== 'box')) return { ok: false, error: 'grammar' };
    const sa = attrs(shape.attrs, SHAPE_KEYS[shape.name]);
    if (!sa) return { ok: false, error: 'grammar' };
    if (!/^\d{1,3}$/.test(ga['data-attachment'])) return { ok: false, error: 'bad-attachment' };
    const n = Number(ga['data-attachment']);
    if (attachment !== null && n !== attachment) return { ok: false, error: 'bad-attachment' };
    attachment = n;
    if (marks.length >= MAX_MARKS) return { ok: false, error: 'too-many' };
    if (kind === 'pin') {
      if (sa.r !== '0') return { ok: false, error: 'grammar' };
      marks.push({ kind, letter: ga['data-letter'], at: { x: parseNum(sa.cx), y: parseNum(sa.cy) } });
    } else {
      const [x, y, w, h] = [sa.x, sa.y, sa.width, sa.height].map(parseNum);
      if (!(w >= 0) || !(h >= 0)) return { ok: false, error: 'bad-box' };
      marks.push({ kind, letter: ga['data-letter'], box: { x1: x, y1: y, x2: Math.round((x + w) * 1e6) / 1e6, y2: Math.round((y + h) * 1e6) / 1e6 } });
    }
  }
  const last = toks[i];
  if (i !== toks.length - 1 || !last || last.name !== 'svg' || !last.close) return { ok: false, error: 'grammar' };
  if (!sizeOk(width) || !sizeOk(height)) return { ok: false, error: 'bad-size' };
  if (nextIndex < 0) return { ok: false, error: 'bad-next' };
  const value = { width, height, next: nextIndex, marks, attachment: attachment ?? 1 };
  try { check(value, value.attachment); } catch (e) { return { ok: false, error: e.code || 'grammar' }; }
  return { ok: true, value };
}
