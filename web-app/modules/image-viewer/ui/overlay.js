// The image viewer's mark layer, after the design's page (the image-markup mockup)
// and the design notes §16.2, §16.4. Pure: marks → what the page draws, in the stage's pixels. Box lines go in one
// SVG in two tones (class o, the outline, under class l, the line; a dashed draft; an invisible wide hit stroke).
// Pins, chips and handles are elements the page positions: the module page's CSP blocks inline styles, so it sets
// left/top through CSSOM from these numbers. A pin is a teardrop whose tip is the spot; a box's chip sits just
// inside its bottom-left corner; the selected box gets its two corner handles (12 px drawn, 44 px hit, in CSS).
// test/image-viewer-overlay.test.mjs.

import { toScreen } from './view.js';
import { labelFor, indexOfLetter } from './marks.js';

export const CHIP_PX = 22;
const CHIP_IN = 5; // px from the box's left edge
const CHIP_UP = CHIP_PX + CHIP_IN; // px above the box's bottom edge
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const r2 = (v) => Math.round(v * 100) / 100;

const rect = (a, b) => ({ x: r2(a.x), y: r2(a.y), w: r2(b.x - a.x), h: r2(b.y - a.y) });

/** layout(view, marks, {attachment, attachments, selected?, draft?, readOnly?}) → {lines, items}. */
export function layout(view, marks, { attachment, attachments, selected = null, draft = null, readOnly = false }) {
  const lines = [], items = [];
  for (const m of marks) {
    if (!m || !ID.test(m.id) || indexOfLetter(m.letter) < 0) continue;
    const label = labelFor(m.letter, attachment, attachments);
    const sel = m.id === selected;
    if (m.kind === 'pin') {
      const p = toScreen(view, m.at);
      items.push({ kind: 'pin', id: m.id, label, x: r2(p.x), y: r2(p.y), selected: sel, wide: label.length > 1 });
    } else if (m.kind === 'box') {
      const a = toScreen(view, { x: m.box.x1, y: m.box.y1 }), b = toScreen(view, { x: m.box.x2, y: m.box.y2 });
      const r = rect(a, b);
      lines.push({ cls: 'o', ...r }, { cls: 'l', ...r }, { cls: 'hit', ...r, id: m.id });
      items.push({ kind: 'chip', id: m.id, label, x: r2(a.x + CHIP_IN), y: r2(b.y - CHIP_UP), selected: sel });
      if (sel && !readOnly) {
        items.push({ kind: 'handle', id: m.id, part: 'tl', x: r2(a.x), y: r2(a.y) }, { kind: 'handle', id: m.id, part: 'br', x: r2(b.x), y: r2(b.y) });
      }
    }
  }
  if (draft) {
    const r = rect(toScreen(view, { x: draft.x1, y: draft.y1 }), toScreen(view, { x: draft.x2, y: draft.y2 }));
    lines.push({ cls: 'o', ...r }, { cls: 'l d', ...r });
  }
  return { lines, items };
}

/** The thumbnail's pencil after the number pill: the count and its words; nothing without marks. */
export function pencilMark(count) {
  if (!Number.isInteger(count) || count < 1) return null;
  return { count, label: count === 1 ? '1 mark' : count + ' marks' };
}
