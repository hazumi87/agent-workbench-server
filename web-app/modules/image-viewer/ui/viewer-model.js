// The image viewer's model, after the design's page (the image-markup mockup) and
// the design notes §16.3. Pure: one viewer over a message's pictures. Each picture keeps its own marks, undo
// and view; Previous/Next (and the arrows, with focus in the viewer) move between them; the header reads
// "{filename} · 2 of 4". Marks save as they are made: debounced, flushed when moving on and on close, written as
// the picture's companion (<file>.annotations.svg) through the host's save(). A companion the reader refuses is
// shown as nothing and held: no marks are added over it, so it is never overwritten. A sent message is view-only.
// test/image-viewer-model.test.mjs.

import { createMarks, SENT_TEXT } from './marks.js';
import { readCompanion, writeCompanion } from './companion.js';
import { fitView } from './view.js';
import { createInteraction } from './interaction.js';
import { layout } from './overlay.js';

export const SAVE_MS = 400;
export const UNREADABLE_TEXT = "These marks can't be read."; // "mark", never "annotation" (the design's mark-up pass)
const HINTS = { pin: 'Click the picture to place a pin.', box: 'Drag across the picture to draw a box.' };

/**
 * createViewer({pictures:[{id, name, width, height, companion?}], start, box, sent, save(id, text), timers?})
 * timers: {set(fn, ms), clear(t)} (a fake clock in tests).
 */
export function createViewer({ pictures, start = 0, box, sent = false, save, timers }) {
  const T = timers || { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) };
  let index = Math.min(Math.max(0, start), pictures.length - 1);
  let stage = box;
  let expanded = false;
  const states = new Map(); // id → {marks, interaction, held, dirty, timer}

  function writeNow(id) {
    const s = states.get(id);
    if (!s || !s.dirty) return;
    if (s.timer) T.clear(s.timer);
    s.timer = null;
    s.dirty = false;
    const i = pictures.findIndex((p) => p.id === id);
    save(id, writeCompanion(s.marks.save(), { attachment: i + 1 }));
  }

  function stateOf(i) {
    const p = pictures[i];
    if (states.has(p.id)) return states.get(p.id);
    let saved = null, held = false;
    if (typeof p.companion === 'string') {
      const r = readCompanion(p.companion);
      if (r.ok && r.value.width === p.width && r.value.height === p.height) saved = r.value;
      else held = true;
    }
    const s = { held, dirty: false, timer: null };
    s.marks = createMarks({
      width: p.width, height: p.height, readOnly: sent || held,
      marks: saved ? saved.marks : [], next: saved ? saved.next : 0,
      onChange: () => {
        s.dirty = true;
        if (s.timer) T.clear(s.timer);
        s.timer = T.set(() => { s.timer = null; writeNow(p.id); }, SAVE_MS);
      },
    });
    s.interaction = createInteraction({ marks: s.marks, view: fitView({ width: p.width, height: p.height }, stage) });
    states.set(p.id, s);
    return s;
  }

  const cur = () => stateOf(index);
  function go(i) {
    if (i < 0 || i >= pictures.length || i === index) return { ok: false };
    writeNow(pictures[index].id);
    index = i;
    cur().interaction.resize(stage);
    return { ok: true };
  }

  return {
    get interaction() { return cur().interaction; },
    get index() { return index; },
    get expanded() { return expanded; },
    picture: () => pictures[index],
    header() {
      const p = pictures[index], position = `${index + 1} of ${pictures.length}`;
      return { name: p.name, position, title: `${p.name} · ${position}`, previous: index > 0, next: index < pictures.length - 1 };
    },
    next: () => go(index + 1),
    previous: () => go(index - 1),
    layout() {
      const s = cur(), it = s.interaction;
      return layout(it.view, s.marks.list(), { attachment: index + 1, attachments: pictures.length, selected: it.selected, draft: it.draft, readOnly: s.marks.readOnly });
    },
    tools() {
      const ro = cur().marks.readOnly, t = cur().interaction.tool;
      return { select: { pressed: t === 'select', disabled: false }, pin: { pressed: t === 'pin', disabled: ro }, box: { pressed: t === 'box', disabled: ro } };
    },
    edits() {
      const s = cur();
      if (s.marks.readOnly) return { undo: false, redo: false, remove: false };
      return { undo: s.marks.canUndo(), redo: s.marks.canRedo(), remove: !!s.interaction.selected };
    },
    /** The lock line under the picture, or null. */
    notice() { const s = cur(); return s.held ? UNREADABLE_TEXT : sent ? SENT_TEXT : null; },
    /** Under the tools: the tool's hint, or 'keys' for the key chips (the design's footer). */
    hint() { const s = cur(); return s.marks.readOnly ? null : HINTS[s.interaction.tool] || 'keys'; },
    zoomLabel: () => Math.round(cur().interaction.view.scale * 100) + '%',
    resize(b) { stage = b; cur().interaction.resize(b); },
    setExpanded(on) { expanded = !!on; },
    key(e) {
      const r = cur().interaction.key(e);
      if (r.request === 'next') return go(index + 1).ok ? { ok: true } : { ok: false };
      if (r.request === 'previous') return go(index - 1).ok ? { ok: true } : { ok: false };
      if (r.request === 'close') { for (const p of pictures) writeNow(p.id); return { ok: true, request: 'close' }; }
      return r;
    },
    /** Flush every pending save; the page calls this before it goes away. */
    close() { for (const p of pictures) writeNow(p.id); },
    /** Marks per picture, for the thumbnails' pencil. */
    counts: () => pictures.map((p, i) => (states.has(p.id) || p.companion ? stateOf(i).marks.list().length : 0)),
  };
}
