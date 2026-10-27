// The in-app widget layer's geometry (the design notes W2, §4.4 four-zone stickiness; revision 1 P1). Pure
// numbers, no DOM: a new widget starts centred; each axis anchors to the half its centre sits in and keeps its
// distance from that edge when the app window resizes; every position is clamped so the widget stays reachable
// (inside an 8 px margin when it fits, its header's start corner at the margin when it doesn't). A stored anchor
// is used only when it is exactly the anchor shape. test/widget-geometry.test.mjs.

export const MARGIN = 8;
export const STEP = 8;
export const BIG_STEP = 32;
const MAX_OFFSET = 16384;
const ANCHOR_KEYS = 'dx,dy,h,v';

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/** One axis: whole pixels, inside [MARGIN, room - MARGIN - size], or MARGIN when the widget doesn't fit. */
function fit(at, room, size) {
  const hi = room - MARGIN - size;
  if (hi < MARGIN) return MARGIN;
  return Math.min(hi, Math.max(MARGIN, Math.round(at)));
}

/** A new widget's position: the centre of the layer. */
export function centred(layer, size) {
  return { x: fit(Math.floor((layer.w - size.w) / 2), layer.w, size.w), y: fit(Math.floor((layer.h - size.h) / 2), layer.h, size.h) };
}

/** Keep the widget reachable; a position that isn't a number starts it centred. */
export function clamp(pos, layer, size) {
  if (!pos || !finite(pos.x) || !finite(pos.y)) return centred(layer, size);
  return { x: fit(pos.x, layer.w, size.w), y: fit(pos.y, layer.h, size.h) };
}

/** Which half each axis's centre sits in (the middle line counts as the start half), and the distance from that edge. */
export function anchorOf(pos, layer, size) {
  const left = pos.x + size.w / 2 <= layer.w / 2;
  const top = pos.y + size.h / 2 <= layer.h / 2;
  return {
    h: left ? 'left' : 'right', dx: Math.max(0, Math.round(left ? pos.x : layer.w - (pos.x + size.w))),
    v: top ? 'top' : 'bottom', dy: Math.max(0, Math.round(top ? pos.y : layer.h - (pos.y + size.h))),
  };
}

/** The position an anchor gives in a layer of this size, clamped. */
export function place(anchor, layer, size) {
  const x = anchor.h === 'left' ? anchor.dx : layer.w - anchor.dx - size.w;
  const y = anchor.v === 'top' ? anchor.dy : layer.h - anchor.dy - size.h;
  return clamp({ x, y }, layer, size);
}

/** Arrow keys on the focused header: 8 px, with Shift 32 px. Any other key → null. */
export function keyMove(pos, key, shift, layer, size) {
  const d = shift ? BIG_STEP : STEP;
  const delta = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }[key];
  if (!delta) return null;
  return clamp({ x: pos.x + delta[0], y: pos.y + delta[1] }, layer, size);
}

/** A stored anchor from main's settings: exactly {h, dx, v, dy} with whole offsets, or null (the default position). */
export function readAnchor(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== ANCHOR_KEYS) return null;
  if (v.h !== 'left' && v.h !== 'right') return null;
  if (v.v !== 'top' && v.v !== 'bottom') return null;
  const ok = (n) => Number.isInteger(n) && n >= 0 && n <= MAX_OFFSET;
  if (!ok(v.dx) || !ok(v.dy)) return null;
  return { h: v.h, dx: v.dx, v: v.v, dy: v.dy };
}

/** A drag's pointer has left the layer by more than the margin: the widget moves out of the app (W3). */
export function pastEdge(pointer, layer) {
  if (!pointer || !finite(pointer.x) || !finite(pointer.y)) return false;
  return pointer.x < -MARGIN || pointer.y < -MARGIN || pointer.x > layer.w + MARGIN || pointer.y > layer.h + MARGIN;
}
