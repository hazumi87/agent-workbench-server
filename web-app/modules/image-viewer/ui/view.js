// The image viewer's geometry, the design notes §16.3. Pure, no DOM. A view is {scale, ox, oy, image, box}:
// the picture's top-left corner sits at (ox, oy) in the viewer's box, drawn at `scale` screen pixels per image
// pixel. Fit and 100%, wheel zoom about the pointer, pan that stops at the edges (a picture smaller than the
// box stays centred on that axis), screen <-> fraction, and hit testing with a 44 px target for pins and box
// corners (the drawn handle is 12 px). test/image-viewer-view.test.mjs.

export const HIT_PX = 44;
export const MAX_SCALE = 16;

const fitScale = (image, box) => Math.min(box.width / image.width, box.height / image.height);

/** Keep the picture in reach: centred on an axis where it is smaller than the box, edges stop the pan otherwise. */
function settle(v) {
  const w = v.image.width * v.scale, h = v.image.height * v.scale;
  const ox = w <= v.box.width ? (v.box.width - w) / 2 : Math.min(0, Math.max(v.box.width - w, v.ox));
  const oy = h <= v.box.height ? (v.box.height - h) / 2 : Math.min(0, Math.max(v.box.height - h, v.oy));
  return { scale: v.scale, ox, oy, image: v.image, box: v.box };
}

export const fitView = (image, box) => settle({ scale: fitScale(image, box), ox: 0, oy: 0, image, box });
export const actualView = (image, box) => settle({ scale: 1, ox: (box.width - image.width) / 2, oy: (box.height - image.height) / 2, image, box });

/** Zoom by `factor` keeping the picture point under (px, py) still; between half of Fit (or of 100%) and MAX_SCALE. */
export function zoomAt(v, factor, px, py) {
  const min = Math.min(fitScale(v.image, v.box), 1) / 2;
  const scale = Math.min(MAX_SCALE, Math.max(min, v.scale * factor));
  const k = scale / v.scale;
  return settle({ ...v, scale, ox: px - (px - v.ox) * k, oy: py - (py - v.oy) * k });
}

export const panBy = (v, dx, dy) => settle({ ...v, ox: v.ox + dx, oy: v.oy + dy });

/** A screen point → fractions of the picture, and whether it is on the picture. */
export function toFraction(v, sx, sy) {
  const x = (sx - v.ox) / (v.scale * v.image.width), y = (sy - v.oy) / (v.scale * v.image.height);
  return { x, y, inside: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
}
export const toScreen = (v, p) => ({ x: v.ox + p.x * v.scale * v.image.width, y: v.oy + p.y * v.scale * v.image.height });

const within = (v, p, sx, sy) => { const q = toScreen(v, p); return Math.hypot(q.x - sx, q.y - sy) <= HIT_PX / 2; };

function handleHit(v, m, sx, sy) {
  if (m.kind === 'pin') return within(v, m.at, sx, sy) ? 'pin' : null;
  if (within(v, { x: m.box.x1, y: m.box.y1 }, sx, sy)) return 'tl';
  if (within(v, { x: m.box.x2, y: m.box.y2 }, sx, sy)) return 'br';
  return null;
}
function bodyHit(v, m, sx, sy) {
  if (m.kind !== 'box') return null;
  const a = toScreen(v, { x: m.box.x1, y: m.box.y1 }), b = toScreen(v, { x: m.box.x2, y: m.box.y2 });
  return sx >= a.x && sx <= b.x && sy >= a.y && sy <= b.y ? 'body' : null;
}

/**
 * What is under (sx, sy): {id, part: 'pin'|'tl'|'br'|'body'} or null. The selected mark first, then any pin or
 * corner (newest first), then the inside of a box (newest first).
 */
export function hitTest(v, marks, sx, sy, selectedId = null) {
  const sel = selectedId && marks.find((m) => m.id === selectedId);
  if (sel) { const part = handleHit(v, sel, sx, sy) || bodyHit(v, sel, sx, sy); if (part) return { id: sel.id, part }; }
  const newest = [...marks].reverse();
  for (const m of newest) { const part = handleHit(v, m, sx, sy); if (part) return { id: m.id, part }; }
  for (const m of newest) { const part = bodyHit(v, m, sx, sy); if (part) return { id: m.id, part }; }
  return null;
}
