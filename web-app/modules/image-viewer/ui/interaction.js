// The image viewer's pointer and key handling, the design notes §16.3. Pure, no DOM: the page feeds it
// pointer positions in the viewer's own pixels and key events while focus is inside the viewer, and draws
// from `view`, `draft`, `selected` and the marks. Tools: Select (default), Pin, Box; V, P, B. Select drags a
// pin, a box (whole) or a box corner, and pans on empty space. Each drag is one undo step. Esc cancels a box
// being drawn or a drag, otherwise asks to close. The arrows and < > ask for the previous or next picture.
// After send, Pin and Box are off and any attempt to change a mark answers with the design's words.
// test/image-viewer-interaction.test.mjs.

import { SENT_TEXT } from './marks.js';
import { fitView, actualView, zoomAt, panBy, toFraction, hitTest } from './view.js';

const TOOLS = ['select', 'pin', 'box'];
const TOOL_KEYS = { v: 'select', p: 'pin', b: 'box' };
const WHEEL_STEP = 1.0015; // per wheel delta unit: one notch (100) is about 16 %

export function createInteraction({ marks, view: start }) {
  let view = start;
  let tool = 'select';
  let selected = null;
  let gesture = null; // {kind:'draw'|'pin'|'box'|'corner'|'pan'|'still', ...}

  const frac = (sx, sy) => toFraction(view, sx, sy);
  const round = (v) => Math.round(Math.min(1, Math.max(0, v)) * 1e6) / 1e6;
  const clamp = (p) => ({ x: round(p.x), y: round(p.y) });
  const sent = () => ({ ok: false, notice: SENT_TEXT });
  const exists = (id) => !!(id && marks.get(id));
  const draftOf = (a, b) => ({ x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) });

  function pointerDown(sx, sy) {
    const p = frac(sx, sy);
    if (tool === 'pin') { gesture = { kind: 'still', place: p.inside ? clamp(p) : null }; return { ok: true }; }
    if (tool === 'box') { gesture = p.inside ? { kind: 'draw', a: clamp(p), b: clamp(p) } : null; return { ok: true }; }
    const hit = hitTest(view, marks.list(), sx, sy, selected);
    if (!hit) { selected = null; gesture = { kind: 'pan', sx, sy }; return { ok: true }; }
    selected = hit.id;
    const m = marks.get(hit.id);
    if (marks.readOnly) { gesture = { kind: 'locked', sx, sy, moved: false }; return { ok: true }; }
    marks.begin();
    if (hit.part === 'pin') gesture = { kind: 'pin', id: m.id };
    else if (hit.part === 'body') gesture = { kind: 'box', id: m.id, from: p, box: m.box };
    else gesture = { kind: 'corner', id: m.id, handle: hit.part };
    return { ok: true };
  }

  function pointerMove(sx, sy) {
    if (!gesture) return { ok: true };
    const p = frac(sx, sy);
    switch (gesture.kind) {
      case 'draw': gesture.b = clamp(p); break;
      case 'pin': marks.movePin(gesture.id, p); break;
      case 'corner': marks.resizeBox(gesture.id, gesture.handle, p); break;
      case 'box': {
        // from the box as it was at the start, so a box held against an edge follows the pointer back exactly
        const want = { x: gesture.box.x1 + (p.x - gesture.from.x), y: gesture.box.y1 + (p.y - gesture.from.y) };
        const now = marks.get(gesture.id).box;
        marks.moveBox(gesture.id, { dx: want.x - now.x1, dy: want.y - now.y1 });
        break;
      }
      case 'pan': view = panBy(view, sx - gesture.sx, sy - gesture.sy); gesture.sx = sx; gesture.sy = sy; break;
      case 'locked': if (Math.hypot(sx - gesture.sx, sy - gesture.sy) > 3) gesture.moved = true; break;
      default: break;
    }
    return { ok: true };
  }

  function pointerUp(sx, sy) {
    const g = gesture;
    gesture = null;
    if (!g) return { ok: true };
    if (g.kind === 'still') {
      if (!g.place) return { ok: true };
      const r = marks.addPin(g.place);
      if (r.ok) selected = r.mark.id;
      return r.ok ? { ok: true } : r.reason === 'sent' ? sent() : { ok: false };
    }
    if (g.kind === 'draw') {
      g.b = clamp(frac(sx, sy));
      const r = marks.addBox(g.a, g.b);
      if (r.ok) selected = r.mark.id;
      return r.ok ? { ok: true } : r.reason === 'sent' ? sent() : { ok: false };
    }
    if (g.kind === 'locked') return g.moved ? sent() : { ok: true };
    if (g.kind === 'pin' || g.kind === 'box' || g.kind === 'corner') marks.end();
    return { ok: true };
  }

  function setTool(t) {
    if (!TOOLS.includes(t)) return { ok: false };
    if (marks.readOnly && t !== 'select') return sent();
    tool = t;
    gesture = null;
    return { ok: true };
  }

  function key(e) {
    const k = e && e.key;
    if (typeof k !== 'string') return { ok: false };
    const ctrl = !!(e.ctrlKey || e.metaKey);
    if (ctrl && (k === 'z' || k === 'Z')) {
      if (marks.readOnly) return sent();
      const r = e.shiftKey ? marks.redo() : marks.undo();
      if (!exists(selected)) selected = null;
      return { ok: r.ok };
    }
    if (ctrl) return { ok: false };
    if (k === 'Escape') {
      if (gesture && gesture.kind === 'draw') { gesture = null; return { ok: true }; }
      if (gesture && (gesture.kind === 'pin' || gesture.kind === 'box' || gesture.kind === 'corner')) { marks.cancel(); gesture = null; return { ok: true }; }
      return { ok: true, request: 'close' };
    }
    if (k === 'Delete' || k === 'Backspace') {
      if (!selected) return { ok: false };
      if (marks.readOnly) return sent();
      const r = marks.remove(selected);
      if (r.ok) selected = null;
      return { ok: r.ok };
    }
    if (k === 'ArrowLeft' || k === '<') return { ok: true, request: 'previous' };
    if (k === 'ArrowRight' || k === '>') return { ok: true, request: 'next' };
    const t = TOOL_KEYS[k.toLowerCase()];
    if (t && k.length === 1) return setTool(t);
    return { ok: false };
  }

  return {
    pointerDown, pointerMove, pointerUp, key, setTool,
    wheel(deltaY, sx, sy) { view = zoomAt(view, Math.pow(WHEEL_STEP, -deltaY), sx, sy); return { ok: true }; },
    fit() { view = fitView(view.image, view.box); },
    actual() { view = actualView(view.image, view.box); },
    resize(box) { view = fitView(view.image, box); },
    select(id) { selected = exists(id) ? id : null; },
    get view() { return view; },
    get tool() { return tool; },
    get selected() { return selected; },
    get draft() { return gesture && gesture.kind === 'draw' ? draftOf(gesture.a, gesture.b) : null; },
  };
}
