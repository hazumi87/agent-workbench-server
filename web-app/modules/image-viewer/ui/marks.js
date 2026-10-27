// The image viewer's marks, the design notes §16.3, §16.4 and the owner's answers §16.9. Pure, no DOM.
// Pin and Box marks on one picture, in fractions of the picture (0..1), boxes stored normalised. Letters are
// one sequence per picture and never reused (A..Z, AA..): a letter the person has seen may already be in
// their message, so deleting, undoing or redrawing never hands it out again. With 2+ attachments the label
// gets the attachment's number (1A). Undo and redo cover the viewer's own actions; a drag is one step.
// After sending, the marks are view-only. test/image-viewer-marks.test.mjs.

export const MAX_MARKS = 200;
export const MIN_BOX_PX = 4;
export const MAX_SIDE_PX = 65536;
export const SENT_TEXT = "Marks on a sent message can't be changed.";
const LETTERS = /^[A-Z]{1,3}$/;

/** 0 → A, 25 → Z, 26 → AA (bijective base 26). */
export function letterFor(i) {
  let n = i + 1, s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - 1 - r) / 26; }
  return s;
}
/** The index of a letter, or -1 for anything that is not 1 to 3 capitals. */
export function indexOfLetter(s) {
  if (typeof s !== 'string' || !LETTERS.test(s)) return -1;
  let n = 0;
  for (const c of s) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

export const labelFor = (letter, attachment, count) => (count >= 2 ? String(attachment) + letter : letter);

/** One line in the message box when the labels change under the person (§16.4 hazard). */
export const labelNotice = ({ before, after, firstHasMarks }) => (before < 2 && after >= 2 && firstHasMarks ? 'Labels now read 1A, 1B …' : null);

const round = (v) => Math.round(v * 1e6) / 1e6;
const clamp01 = (v) => round(Math.min(1, Math.max(0, v)));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pointOk = (p) => !!p && isNum(p.x) && isNum(p.y);
const point = (p) => ({ x: clamp01(p.x), y: clamp01(p.y) });
const norm = (a, b) => ({ x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) });
const sizeOk = (v) => Number.isInteger(v) && v > 0 && v <= MAX_SIDE_PX;
const copy = (m) => (m.kind === 'pin' ? { id: m.id, kind: 'pin', letter: m.letter, at: { ...m.at } } : { id: m.id, kind: 'box', letter: m.letter, box: { ...m.box } });

/**
 * createMarks({width, height, marks?, next?, readOnly?, onChange?}). `marks` are saved marks
 * ({kind, letter, at} or {kind, letter, box}); `next` is the index of the next letter, raised past any letter in use.
 */
export function createMarks({ width, height, marks: saved = [], next = 0, readOnly = false, onChange = () => {} } = {}) {
  if (!sizeOk(width) || !sizeOk(height)) throw new Error('picture size must be whole pixels from 1 to ' + MAX_SIDE_PX);
  let marks = [];
  let seq = 0;
  const used = new Set();
  for (const s of saved) {
    const i = indexOfLetter(s && s.letter);
    if (i < 0) throw new Error('bad letter');
    if (used.has(s.letter)) throw new Error('duplicate letter ' + s.letter);
    used.add(s.letter);
    if (s.kind === 'pin' && pointOk(s.at)) marks.push({ id: 'm' + ++seq, kind: 'pin', letter: s.letter, at: point(s.at) });
    else if (s.kind === 'box' && s.box && [s.box.x1, s.box.y1, s.box.x2, s.box.y2].every(isNum)) {
      marks.push({ id: 'm' + ++seq, kind: 'box', letter: s.letter, box: norm(point({ x: s.box.x1, y: s.box.y1 }), point({ x: s.box.x2, y: s.box.y2 })) });
    } else throw new Error('bad mark ' + s.letter);
    next = Math.max(next, i + 1);
  }
  if (marks.length > MAX_MARKS) throw new Error('too many marks');
  if (!Number.isSafeInteger(next) || next < 0) next = 0;

  const undoStack = [];
  let redoStack = [];
  let open = null; // a drag in progress: the state before it and the reason to report at its end

  const snap = () => marks.map(copy);
  const find = (id) => marks.find((m) => m.id === id);
  const no = (reason) => (reason === 'sent' ? { ok: false, reason, text: SENT_TEXT } : { ok: false, reason });
  function commit(before, why) {
    if (open) { open.why = open.why || why; return; }
    undoStack.push(before);
    redoStack = [];
    onChange(why);
  }

  function add(mark) {
    if (readOnly) return no('sent');
    if (marks.length >= MAX_MARKS) return no('too-many');
    const before = snap();
    const m = { id: 'm' + ++seq, letter: letterFor(next++), ...mark };
    marks.push(m);
    commit(before, 'add');
    return { ok: true, mark: copy(m) };
  }

  function edit(id, kind, change) {
    if (readOnly) return no('sent');
    const m = find(id);
    if (!m) return no('no-such-mark');
    if (kind && m.kind !== kind) return no(kind === 'pin' ? 'not-a-pin' : 'not-a-box');
    const before = snap();
    const r = change(m);
    if (r) return r;
    commit(before, 'move');
    return { ok: true, mark: copy(m) };
  }

  return Object.freeze({
    addPin(p) {
      if (!pointOk(p)) return no('bad-point');
      return add({ kind: 'pin', at: point(p) });
    },
    addBox(a, b) {
      if (!pointOk(a) || !pointOk(b)) return no('bad-point');
      const box = norm(point(a), point(b));
      if ((box.x2 - box.x1) * width < MIN_BOX_PX || (box.y2 - box.y1) * height < MIN_BOX_PX) return no('too-small');
      return add({ kind: 'box', box });
    },
    movePin(id, p) {
      if (!pointOk(p)) return no('bad-point');
      return edit(id, 'pin', (m) => { m.at = point(p); });
    },
    /** Move a whole box by a fraction; it is clamped as a whole, so it keeps its size. */
    moveBox(id, d) {
      if (!d || !isNum(d.dx) || !isNum(d.dy)) return no('bad-point');
      return edit(id, 'box', (m) => {
        const w = m.box.x2 - m.box.x1, h = m.box.y2 - m.box.y1;
        const x1 = Math.min(1 - w, Math.max(0, m.box.x1 + d.dx)), y1 = Math.min(1 - h, Math.max(0, m.box.y1 + d.dy));
        m.box = { x1: round(x1), y1: round(y1), x2: round(x1 + w), y2: round(y1 + h) };
      });
    },
    /** Drag the top-left ('tl') or bottom-right ('br') corner; past the other corner it flips, stays normalised. */
    resizeBox(id, handle, p) {
      if (handle !== 'tl' && handle !== 'br') return no('bad-handle');
      if (!pointOk(p)) return no('bad-point');
      return edit(id, 'box', (m) => {
        const q = point(p);
        m.box = handle === 'tl' ? norm(q, { x: m.box.x2, y: m.box.y2 }) : norm({ x: m.box.x1, y: m.box.y1 }, q);
      });
    },
    remove(id) {
      if (readOnly) return no('sent');
      if (!find(id)) return no('no-such-mark');
      const before = snap();
      marks = marks.filter((m) => m.id !== id);
      commit(before, 'remove');
      return { ok: true };
    },
    /** Group the changes of one drag into one undo step, reported once at end(). */
    begin() { if (!readOnly && !open) open = { before: snap(), why: null }; },
    end() {
      if (!open) return;
      const { before, why } = open;
      open = null;
      if (why) commit(before, why);
    },
    cancel() {
      if (!open) return;
      marks = open.before;
      open = null;
    },
    undo() {
      if (readOnly) return no('sent');
      if (open || !undoStack.length) return no('nothing-to-undo');
      redoStack.push(snap());
      marks = undoStack.pop();
      onChange('undo');
      return { ok: true };
    },
    redo() {
      if (readOnly) return no('sent');
      if (open || !redoStack.length) return no('nothing-to-redo');
      undoStack.push(snap());
      marks = redoStack.pop();
      onChange('redo');
      return { ok: true };
    },
    canUndo: () => !readOnly && !open && undoStack.length > 0,
    canRedo: () => !readOnly && !open && redoStack.length > 0,
    get: (id) => { const m = find(id); return m ? copy(m) : null; },
    list: () => marks.map(copy),
    get readOnly() { return readOnly; },
    /** Plain data for the companion file. */
    save: () => ({ width, height, next, marks: marks.map(({ id, ...m }) => (m.kind === 'pin' ? { ...m, at: { ...m.at } } : { ...m, box: { ...m.box } })) }),
  });
}
