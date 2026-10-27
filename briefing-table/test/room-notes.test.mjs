/**
 * ROOM NOTES, the host half [ticket]. Unit test: the SHIPPED web/room-notes.mjs
 * and web/room-attach.mjs are imported as they are (no imports of their own),
 * and the panel seam in web/room-cells.mjs is sliced out and run against stubs.
 * No browser, no engine; fetch and the DOM are stubs.
 *   - the client maps every route; a network failure is status 0, never a throw;
 *   - autosave: debounced 400 ms, ONE put for a burst, a keepalive flush, the
 *     local copy kept until the server confirms the SAME text (and only then
 *     dropped), an outage keeps it, a 413 shows plainly, a leftover copy is
 *     offered back;
 *   - move draft: success clears the composer and adds the tile; failure leaves
 *     the composer text untouched and says the right words; clear-draft failure
 *     says the note is saved;
 *   - re-attach replaces the tile (same note, same file id), never adds one;
 *     a restored note-<hash>.txt scratch file draws as a note tile;
 *   - the seam ops map to the right requests and answers;
 *   - notes-changed goes to every view of every panel that declared notes,
 *     after each host-side change;
 *   - an engine without notes (404 on /notes) hides the note items.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const notes = await import(pathToFileURL(join(WEB, 'room-notes.mjs')).href);
const attachMod = await import(pathToFileURL(join(WEB, 'room-attach.mjs')).href);
const cellsSrc = readFileSync(join(WEB, 'room-cells.mjs'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  + ${msg}`);
  } else {
    failed++;
    console.log(`  X ${msg}`);
  }
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` (got ${JSON.stringify(a)})`}`);

/** A stub fetch: records calls, answers from `routes[METHOD path]`. */
function stubFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const path = String(url).replace('/api/rooms/r1/notes', '') || '/';
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined, keepalive: !!init.keepalive });
    const h = routes[`${method} ${path}`];
    const a = typeof h === 'function' ? h(calls.at(-1)) : h;
    if (a === 'throw') {
      throw new Error('offline');
    }
    const { status = 200, body = {} } = a ?? { status: 404, body: { error: 'not found' } };
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { f, calls };
}
const memStore = () => {
  const m = new Map();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), remove: (k) => m.delete(k), has: (k) => m.has(k) };
};
/** a manual clock for the debounce */
function clock() {
  const q = [];
  return {
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      q.push(t);
      return t;
    },
    clearTimer: (t) => {
      const i = q.indexOf(t);
      if (i >= 0) {
        q.splice(i, 1);
      }
    },
    pending: () => q.length,
    fire: async () => {
      const t = q.shift();
      t?.fn();
      await new Promise((r) => setImmediate(r));
    },
    ms: () => q[0]?.ms,
  };
}
const flushMicro = () => new Promise((r) => setImmediate(r));

console.log('room notes: client');
{
  const { f, calls } = stubFetch({
    'GET /': { body: { notes: [] } },
    'POST /': { body: { note: { id: 'a'.repeat(12), text: '' } } },
    'PUT /abc': { body: { id: 'abc', updatedAt: 5 } },
    'POST /abc/attach': { body: {} },
    'POST /abc/pin': { body: {} },
    'POST /abc/archive': { body: {} },
    'POST /abc/close': { body: {} },
    'POST /move-draft': { body: {} },
  });
  const c = notes.createNotesClient('r1', f);
  await c.list();
  await c.create('hi');
  await c.create('');
  await c.put('abc', 'text', true);
  await c.attach('abc');
  await c.pin('abc', true);
  await c.archive('abc', false);
  await c.close('abc');
  await c.moveDraft();
  eq(calls.map((x) => `${x.method} ${x.path}`), ['GET /', 'POST /', 'POST /', 'PUT /abc', 'POST /abc/attach', 'POST /abc/pin', 'POST /abc/archive', 'POST /abc/close', 'POST /move-draft'], 'each call goes to its route');
  eq(calls[1].body, { text: 'hi' }, 'create carries the text');
  eq(calls[2].body, {}, 'an empty create sends an empty object');
  ok(calls[3].keepalive === true && calls[3].body.text === 'text', 'put carries keepalive when asked');
  eq([calls[5].body, calls[6].body], [{ pinned: true }, { archived: false }], 'pin and archive carry their flag');
  const off = notes.createNotesClient('r1', async () => {
    throw new Error('x');
  });
  const r = await off.get('abc');
  ok(!r.ok && r.status === 0 && r.body.error === 'no connection', 'a network failure is status 0, not a throw');
  eq([notes.ageWord(1000, 1000 + 30000), notes.ageWord(0, 15 * 60000), notes.ageWord(0, 2 * 3600000), notes.ageWord(0, 10 * 86400000), notes.ageWord(0, 190 * 86400000)], ['now', '15m ago', '2h ago', '10d ago', '6mo ago'], 'ages read now / m / h / d / mo');
  ok(notes.titleOf('  hello   world ') === 'hello world' && notes.titleOf('') === 'Empty note' && notes.wordCount('a b  c\n d') === 4, 'title and word count');
}

console.log('room notes: autosave');
{
  const { f, calls } = stubFetch({ 'PUT /n1': { body: { id: 'n1', updatedAt: 9 } } });
  const k = clock();
  const store = memStore();
  const saved = [];
  const a = notes.createAutosave({ roomId: 'r1', id: 'n1', client: notes.createNotesClient('r1', f), text: 'one', store, ...k, onSaved: () => saved.push(1) });
  a.change('one two');
  a.change('one two three');
  ok(k.pending() === 1 && k.ms() === 400, 'a burst of edits arms ONE 400 ms timer');
  ok(store.has(a.key) && store.get(a.key).text === 'one two three', 'the local copy is kept at once');
  eq(calls.length, 0, 'nothing is sent before the pause');
  await k.fire();
  eq(calls.map((c) => c.body.text), ['one two three'], 'one PUT with the latest text');
  ok(!store.has(a.key) && saved.length === 1, 'the local copy is dropped once the server confirmed the same text');
  ok(!a.dirty, 'not dirty after a confirmed save');
  // a newer edit while a save is in flight: the copy stays until THAT text is confirmed
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const slow = stubFetch({ 'PUT /n2': async () => ({}) });
  const slowF = async (url, init) => {
    await gate;
    return slow.f(url, init);
  };
  const store2 = memStore();
  const b = notes.createAutosave({ roomId: 'r1', id: 'n2', client: notes.createNotesClient('r1', slowF), text: '', store: store2, ...clock() });
  b.change('first');
  const p = b.save();
  await flushMicro(); // the PUT of 'first' is on the wire
  b.change('first second');
  release();
  await p;
  ok(store2.has(b.key) && store2.get(b.key).text === 'first second', 'an edit made during a save keeps its local copy (only the confirmed text was dropped)');
  // an outage
  const down = notes.createAutosave({ roomId: 'r1', id: 'n3', client: notes.createNotesClient('r1', async () => {
    throw new Error('x');
  }), text: '', store: memStore(), ...clock(), onError: (m, s) => saved.push([m, s]) });
  down.change('typed offline');
  await down.save();
  ok(down.dirty && saved.at(-1)[1] === 0, 'an outage keeps the text dirty and reports status 0');
  ok((await down.settle()) === false, 'settle says the server does NOT hold it');
  // 413
  const big = stubFetch({ 'PUT /n4': { status: 413, body: { error: 'too long: 1000001 of 1000000 characters' } } });
  const errs = [];
  const c4 = notes.createAutosave({ roomId: 'r1', id: 'n4', client: notes.createNotesClient('r1', big.f), text: '', store: memStore(), ...clock(), onError: (m, s) => errs.push([m, s]) });
  c4.change('x');
  await c4.save();
  ok(errs[0][1] === 413 && /1000001/.test(errs[0][0]) && c4.text === 'x', 'a 413 is shown with its own words and the text is kept');
  // flush
  const fl = stubFetch({ 'PUT /n5': { body: {} } });
  const s5 = memStore();
  const d5 = notes.createAutosave({ roomId: 'r1', id: 'n5', client: notes.createNotesClient('r1', fl.f), text: 'a', store: s5, ...clock() });
  d5.flush();
  eq(fl.calls.length, 0, 'flush with nothing unsaved sends nothing');
  d5.change('ab');
  d5.flush();
  await flushMicro();
  ok(fl.calls.length === 1 && fl.calls[0].keepalive === true && fl.calls[0].body.text === 'ab', 'flush sends the unsaved text with keepalive');
  ok(!s5.has(d5.key), 'a confirmed flush drops the local copy');
  // leftover copy from a refresh
  const s6 = memStore();
  s6.set('hwb.room.note.r1.n6', { text: 'left over', at: 1 });
  const d6 = notes.createAutosave({ roomId: 'r1', id: 'n6', client: notes.createNotesClient('r1', fl.f), text: 'server text', store: s6, ...clock() });
  ok(d6.leftover() === 'left over', 'an unconfirmed local copy is offered back on reopen');
  s6.set('hwb.room.note.r1.n6', { text: 'server text', at: 1 });
  ok(d6.leftover() === null, 'a copy equal to the server text is not a leftover');
}

console.log('room notes: move draft');
{
  const mk = (route, over = {}) => {
    const { f, calls } = stubFetch({ 'POST /move-draft': route });
    const w = { text: 'my long draft', cleared: 0, kept: 0, tiles: [], restored: 0, prepared: 0 };
    const out = {
      client: notes.createNotesClient('r1', f),
      text: () => w.text,
      prepare: async () => {
        w.prepared++;
        return over.prepare ?? true;
      },
      clear: () => {
        w.cleared++;
        w.text = '';
      },
      keep: () => w.kept++,
      addTile: (a, n) => w.tiles.push([a, n]),
      restoreTray: async () => w.restored++,
    };
    return { out, w, calls };
  };
  const att = { file: { id: 'f'.repeat(32) }, title: 'my long draft', words: 3 };
  {
    const { out, w } = mk({ body: { note: { id: 'n'.repeat(12) }, attachment: att } });
    const r = await notes.moveDraftToNote(out);
    ok(r.ok && r.message === 'Draft moved to a note' && r.kind === 'info', 'success: the line says "Draft moved to a note"');
    ok(w.cleared === 1 && w.text === '' && w.tiles.length === 1 && w.prepared === 1, 'success: the composer is cleared, the tile added, the draft saved first');
  }
  {
    const { out, w } = mk({ body: { note: { id: 'n'.repeat(12) }, attachment: att } });
    const base = out.text;
    let n = 0;
    out.text = () => (n++ < 1 ? base() : 'typed while it moved');
    const r = await notes.moveDraftToNote(out);
    ok(r.ok && w.cleared === 0 && w.kept === 1, 'success but the person kept typing: the box is NOT cleared and the typing is a draft again');
  }
  {
    const { out, w } = mk({ status: 500, body: { error: 'step create-note failed while saving: x; your draft is untouched', field: 'create-note' } });
    const r = await notes.moveDraftToNote(out);
    ok(!r.ok && r.kind === 'err' && r.message === "Couldn't move the draft. Nothing was changed.", 'failure: "Couldn\'t move the draft. Nothing was changed."');
    ok(w.cleared === 0 && w.text === 'my long draft' && w.tiles.length === 0, 'failure: the composer text is untouched and no tile appears');
  }
  {
    const { out, w } = mk({ status: 500, body: { error: 'step clear-draft failed while clearing: x; the note is saved and attached; your draft was not cleared', field: 'clear-draft' } });
    const r = await notes.moveDraftToNote(out);
    ok(!r.ok && r.saved === true && /note is saved and attached/.test(r.message) && /draft was kept/.test(r.message), 'clear-draft failure: says the note is saved and attached and the draft was kept');
    ok(w.cleared === 0 && w.restored === 1, 'clear-draft failure: the composer stays, the tray re-lists (the attached note shows)');
  }
  {
    const { out, calls } = mk({ body: {} }, { prepare: false });
    const r = await notes.moveDraftToNote(out);
    ok(!r.ok && calls.length === 0, 'a draft that could not be saved first is never moved');
  }
  {
    const { out, calls } = mk({ body: {} });
    out.text = () => '   ';
    const r = await notes.moveDraftToNote(out);
    ok(!r.ok && calls.length === 0, 'an empty draft is never sent');
  }
}

/* ---- a minimal DOM for the tray ---- */
class El {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.style = {};
    this.className = '';
    this.textContent = '';
    this.dataset = {};
    this.hidden = false;
    this.scrollLeft = 0;
    this.scrollWidth = 0;
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  append(...n) {
    this.children.push(...n);
  }
  prepend(...n) {
    this.children.unshift(...n);
  }
  replaceChildren(...n) {
    this.children = [...n];
    this.textContent = '';
  }
  remove() {
    this.removed = true;
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener(t, f) {
    (this.listeners[t] ??= []).push(f);
  }
  click() {
    for (const f of this.listeners.click ?? []) {
      f({ currentTarget: this, stopPropagation() {} });
    }
  }
  get firstText() {
    return this.textContent;
  }
}
globalThis.document = { createElement: (t) => new El(t), createElementNS: (_n, t) => new El(t) };
const textOf = (e) => [e.textContent, ...e.children.map(textOf)].join('|');

console.log('room notes: the tray tile');
{
  const tray = new El('div');
  const addBtn = new El('button');
  const opened = [];
  const asked = [];
  const att = attachMod.mountAttach({
    roomId: 'r1',
    api: async () => ({ ok: true, body: { files: [] } }),
    input: new El('textarea'),
    sendBtn: new El('button'),
    tray,
    note: new El('p'),
    addBtn,
    fileInput: Object.assign(new El('input'), { click() { asked.push('picker'); } }),
    dropZone: new El('div'),
    preview: () => null,
    cells: () => null,
    isPhone: () => false,
    openApp() {},
    refresh: async () => {},
    addMenu: (b) => {
      asked.push('menu');
      return b === addBtn && menuOn;
    },
    openNote: (id) => opened.push(id),
    noteInfo: () => {},
  });
  let menuOn = true;
  addBtn.click();
  eq(asked, ['menu'], 'the + asks the notes menu first and the picker stays closed');
  menuOn = false;
  addBtn.click();
  eq(asked, ['menu', 'menu', 'picker'], 'an engine without notes: the + is the plain file picker');
  const note = { id: 'a1b2c3d4e5f6' };
  const file = { id: 'f'.repeat(32), name: 'note-a1b2c3d4e5f6.txt', type: 'text/plain', size: 1240, key: 'k' };
  att.putNote({ file, title: 'First words of it', words: 1240, bytes_length: 1240 }, note);
  eq(tray.children.length, 1, 'attaching adds one tile');
  ok(att.hasNote('a1b2c3d4e5f6') && att.ids().length === 1 && att.ids()[0] === file.id, 'the tile is an uploaded attachment: its id goes with the line');
  const t1 = textOf(tray.children[0]);
  const tl = tray.children[0];
  ok(String(tl.className).includes('is-note') && tl.attrs['aria-label'] === 'Open note' && tl.title === 'Open note', 'the tray tile is the scratchpad: is-note, aria-label and tooltip "Open note"');
  ok(!/1,240/.test(t1) && !/Note/.test(t1) && !tl.children.some((c) => String(c.className).includes('att-note') || String(c.className).includes('att-fn')), 'no icon, no title line, no "Note . N words" on the tile');
  ok(tl.children.some((c) => c.className === 'att-sr' && c.textContent === 'First words of it'), 'the first words are there for screen readers only (att-sr)');
  ok(!/note-a1b2c3d4e5f6/.test(t1), 'never the hash filename');
  att.putNote({ file, title: 'First words changed', words: 1300, replaced: true, bytes_length: 1300 }, note);
  eq(tray.children.length, 1, 're-attach (replaced:true) REPLACES the tile, it does not add one');
  ok(/changed/.test(textOf(tray.children[0])) && !/1,300/.test(textOf(tray.children[0])), 'the replaced tile carries the new first words (screen readers only), no word count');
  eq(att.ids().length, 1, 'still one attachment id');
  tray.children[0].click();
  eq(opened, ['a1b2c3d4e5f6'], 'tapping the tile opens the live note');
  // remove: attachment only, never the note
  const del = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (u, i) => {
    del.push(`${i?.method} ${u}`);
    return { ok: true, status: 200 };
  };
  const xBtn = tray.children[0].children.find((c) => c.tag === 'button' && c.className === 'att-x');
  xBtn.click();
  await flushMicro();
  globalThis.fetch = origFetch;
  ok(!att.hasNote('a1b2c3d4e5f6') && att.ids().length === 0, 'x removes the tile');
  ok(del.length === 1 && /\/scratch\//.test(del[0]) && !/notes/.test(del[0]), 'x deletes the scratch attachment only; no note route is called');
  // restore: a note-<hash>.txt in the scratchpad draws as a note tile and asks for its info
  const asks = [];
  const tray2 = new El('div');
  const att2 = attachMod.mountAttach({
    roomId: 'r1',
    api: async () => ({ ok: true, body: { files: [{ id: 'e'.repeat(32), name: 'note-a1b2c3d4e5f6.txt', type: 'text/plain', size: 10, key: 'q' }, { id: 'd'.repeat(32), name: 'note-xyz.txt', type: 'text/plain', size: 10, key: 'r' }] } }),
    input: new El('textarea'),
    sendBtn: new El('button'),
    tray: tray2,
    note: new El('p'),
    addBtn: new El('button'),
    fileInput: new El('input'),
    dropZone: new El('div'),
    preview: () => null,
    cells: () => null,
    isPhone: () => false,
    openApp() {},
    refresh: async () => {},
    noteInfo: (id) => asks.push(id),
  });
  await att2.restore();
  ok(att2.hasNote('a1b2c3d4e5f6') && !att2.hasNote('xyz'), 'a restored note-<12 hex>.txt is a note tile; any other .txt stays a file');
  eq(asks, ['a1b2c3d4e5f6'], 'a restored note tile asks for its title and words');
  att2.noteMeta('a1b2c3d4e5f6', { title: 'Back again', words: 7 });
  ok(/Back again/.test(textOf(tray2.children[0])) && !/7 words/.test(textOf(tray2.children[0])) && String(tray2.children[0].className).includes('is-note'), 'the info fills the restored tile (first words for screen readers, no count)');
}

console.log('room notes: the panel seam');
{
  const mk = (routes) => {
    const { f, calls } = stubFetch(routes);
    const log = { opened: [], changed: 0, attached: [], copied: [] };
    const x = {
      client: notes.createNotesClient('r1', f),
      openEditor: (id, from) => log.opened.push([id, from]),
      attach: async (id) => {
        log.attached.push(id);
        return { ok: true, status: 200, body: {} };
      },
      copy: async (p) => {
        log.copied.push(await p);
        return true;
      },
      changed: () => log.changed++,
    };
    return { x, log, calls };
  };
  const id = 'abcdef012345';
  {
    const { x, log, calls } = mk({ 'POST /': { body: { note: { id } } } });
    const a = await notes.handleNoteOp({ panel: 'note', op: 'new' }, x);
    eq(a, { host: 'note', op: 'new', id, ok: true }, 'new: creates and answers with the new id');
    eq([calls[0].method, calls[0].path, log.opened, log.changed], ['POST', '/', [[id, 'assets']], 1], 'new: POST /notes, the editor opens "from Assets", panels told');
  }
  {
    const { x, log } = mk({});
    const a = await notes.handleNoteOp({ panel: 'note', op: 'edit', id }, x);
    eq([a, log.opened], [{ host: 'note', op: 'edit', id, ok: true }, [[id, 'assets']]], 'edit: opens the editor on id, from Assets');
  }
  {
    const { x, log } = mk({});
    const a = await notes.handleNoteOp({ panel: 'note', op: 'attach', id }, x);
    eq([a.ok, log.attached, log.changed], [true, [id], 0], 'attach: calls the host attach (which tells the panels itself)');
  }
  {
    const { x, log } = mk({ 'GET /abcdef012345': { body: { id, text: 'the body' } } });
    const a = await notes.handleNoteOp({ panel: 'note', op: 'copy', id }, x);
    eq([a.ok, log.copied], [true, ['the body']], 'copy: GETs the note and copies its text');
  }
  {
    const { x, calls, log } = mk({ 'POST /abcdef012345/pin': { body: {} }, 'POST /abcdef012345/archive': { body: {} } });
    await notes.handleNoteOp({ panel: 'note', op: 'pin', id }, x);
    await notes.handleNoteOp({ panel: 'note', op: 'unpin', id }, x);
    await notes.handleNoteOp({ panel: 'note', op: 'archive', id }, x);
    await notes.handleNoteOp({ panel: 'note', op: 'unarchive', id }, x);
    eq(calls.map((c) => `${c.path} ${JSON.stringify(c.body)}`), ['/abcdef012345/pin {"pinned":true}', '/abcdef012345/pin {"pinned":false}', '/abcdef012345/archive {"archived":true}', '/abcdef012345/archive {"archived":false}'], 'pin / unpin / archive / unarchive map to their POSTs');
    eq(log.changed, 4, 'each change tells the panels');
  }
  {
    const { x, calls } = mk({ 'POST /abcdef012345/pin': { status: 403, body: { error: 'a person only' } } });
    const a = await notes.handleNoteOp({ panel: 'note', op: 'pin', id }, x);
    eq(a, { host: 'note', op: 'pin', id, ok: false, error: 'a person only' }, 'an engine refusal comes back as ok:false with its words');
    const bad = await notes.handleNoteOp({ panel: 'note', op: 'frobnicate', id }, x);
    const bad2 = await notes.handleNoteOp({ panel: 'note', op: 'edit', id: '../x' }, x);
    const bad3 = await notes.handleNoteOp({ panel: 'note', op: 'attach' }, x);
    ok(!bad.ok && !bad2.ok && !bad3.ok && bad.error === 'bad request' && calls.length === 1, 'an unknown op or a malformed id is refused before any request');
  }
}

console.log('room notes: notes-changed and the + on the panel cell');
{
  const a = cellsSrc.indexOf('  const noteViews = (c) =>');
  const b = cellsSrc.indexOf('  /* ---- ACTION: an app');
  if (a < 0 || b < a) {
    throw new Error('notes block not found in web/room-cells.mjs');
  }
  const body = cellsSrc.slice(a, b);
  const posted = [];
  const view = (name) => ({ port: { postMessage: (m) => posted.push([name, m]) } });
  const cellA = { notes: true, panel: { id: 'assets', uploads: true, app_slug: 'room-assets' }, cv: view('A.cv'), lv: view('A.lv'), vv: null, mv: null, dv: view('A.dv'), add: { hidden: true, setAttribute() {}, removeAttribute() {} } };
  const cellB = { panel: { id: 'other', app_slug: 'x' }, cv: view('B.cv'), add: { hidden: true, setAttribute() {}, removeAttribute() {} } };
  const cellsMap = new Map([['assets', cellA], ['other', cellB]]);
  const menus = [];
  let support = true;
  const o = { notes: { supported: () => support, panelOp: async () => {}, newNote: () => {} }, onPanels: () => posted.push(['panels']) };
  const make = new Function('o', 'cells', 'isVoice', 'createMenuHost', 'document', `${body}\nreturn { declareNotes, hasNotes, paintAdd, notesChanged, openAddMenu, noteOp };`);
  const api = make(o, cellsMap, () => false, () => ({ open: (s) => menus.push(s), close() {} }), { getElementById: () => null });
  api.notesChanged();
  eq(posted.map((p) => p[0]), ['A.cv', 'A.lv', 'A.dv'], 'notes-changed goes to every view of a panel that declared notes, and to no other panel');
  ok(posted.every((p) => p[1].host === 'notes-changed'), 'it is {host:"notes-changed"}');
  posted.length = 0;
  api.declareNotes(cellB, { enabled: true });
  ok(cellB.notes === true && cellB.add.hidden === false && posted[0][0] === 'panels', 'a panel that declares notes gets the + (even without uploads) and the phone bar is told');
  api.declareNotes(cellsMap.get('other'), { enabled: false });
  const cellC = { panel: { id: 'v', app_slug: undefined }, add: { hidden: true } };
  api.declareNotes(cellC, { enabled: true });
  ok(cellC.notes !== true, 'a frame with no app (the voice panel) cannot declare notes');
  ok(api.hasNotes(cellA) === true, 'the + is a menu on an engine with notes');
  support = false;
  ok(api.hasNotes(cellA) === false, 'an engine WITHOUT notes (404): the note items are hidden, the + is the plain file picker');
  support = true;
  const replies = [];
  support = false;
  await api.noteOp({}, { panel: 'note', op: 'new' }, { postMessage: (m) => replies.push(m) });
  ok(replies[0].ok === false && replies[0].op === 'new', 'an op on an engine without notes is answered ok:false, not thrown');
  support = true;
  api.openAddMenu(cellA, { getBoundingClientRect: () => ({ left: 1, bottom: 2 }) }, () => cellA.cv);
  eq(menus[0].items.map((i) => i.label), ['Import a file', 'New note'], 'the Assets + menu: "Import a file", "New note"');
  api.openAddMenu({ panel: { uploads: false } }, { getBoundingClientRect: () => ({ left: 1, bottom: 2 }) }, () => null);
  eq(menus[1].items.map((i) => i.label), ['New note'], 'a panel without uploads: just "New note"');
}

console.log('room notes: the + menu on the composer');
{
  const { f, calls } = stubFetch({ 'GET /': { status: 404, body: { error: 'not found' } } });
  const opened = [];
  const make = (client) =>
    notes.mountNotes({
      roomId: 'r1',
      client,
      menuHost: { open: (s) => opened.push(s), close() {} },
      att: () => null,
      cells: () => null,
      chatHost: () => null,
      draft: { text: () => 'abc', prepare: async () => true, clear() {}, keep() {} },
      repaintLine() {},
      pickFile() {},
    });
  const n = make(notes.createNotesClient('r1', f));
  await flushMicro();
  ok(calls[0].path === '/' && n.supported() === false, 'a 404 on /notes marks the engine as without notes');
  ok(n.addMenu({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }) === false && opened.length === 0, 'no menu: the + falls back to the plain file picker');
  const ok2 = stubFetch({ 'GET /': { body: { notes: [] } } });
  const n2 = make(notes.createNotesClient('r1', ok2.f));
  await flushMicro();
  ok(n2.supported() === true, 'a 200 marks notes as supported');
  ok(n2.addMenu({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }) === true, 'the menu opens');
  eq(opened[0].items.map((i) => [i.label, !!i.off]), [['Attach a file', false], ['New note', false], ['Move draft to a note', false]], 'composer + menu: Attach a file, New note, Move draft to a note');
  const empty = notes.mountNotes({ roomId: 'r1', client: notes.createNotesClient('r1', ok2.f), menuHost: { open: (s) => opened.push(s), close() {} }, att: () => null, cells: () => null, chatHost: () => null, draft: { text: () => '  ', prepare: async () => true, clear() {}, keep() {} }, repaintLine() {}, pickFile() {} });
  await flushMicro();
  empty.addMenu({ getBoundingClientRect: () => ({ left: 0, top: 0 }) });
  ok(opened.at(-1).items[2].off === true, '"Move draft to a note" is disabled when the draft is empty');
  const flaky = notes.mountNotes({ roomId: 'r1', client: notes.createNotesClient('r1', async () => { throw new Error('x'); }), menuHost: { open() {}, close() {} }, att: () => null, cells: () => null, chatHost: () => null, draft: { text: () => 'a', prepare: async () => true, clear() {}, keep() {} }, repaintLine() {}, pickFile() {} });
  await flushMicro();
  ok(flaky.supported() === false && flaky.addMenu({}) === false, 'an unreachable engine never throws: the + stays the file picker');
}

console.log('close: removed notes');
{
  ok(notes.shouldReattach({ body: { note: {} } }, false, true) === true, 'a closed note in the tray is re-attached');
  ok(notes.shouldReattach({ body: { note: null, removed: true } }, false, true) === false, 'a removed (empty) note is not re-attached');
  ok(notes.shouldReattach({ body: { note: {} } }, true, true) === false, 'a close that attached does not attach twice');
  ok(notes.shouldReattach({ body: { note: {} } }, false, false) === false, 'not in the tray: nothing to refresh');
  ok(notes.shouldReattach({ body: { note: {} } }, false, false, 'chat') === true, 'a composer note is attached by its close');
  ok(notes.shouldReattach({ body: { note: null, removed: true } }, false, false, 'chat') === false, 'an empty composer note is removed, not attached');
}

console.log('the paperclip rule');
{
  const p = notes.showsPaperclip;
  ok(p({ origin: 'chat', inTray: false }) === false, 'composer new note / move-draft: no paperclip');
  ok(p({ origin: 'chat', inTray: true }) === false, 'opened from its tile: no paperclip');
  ok(p({ origin: 'assets', inTray: false }) === true, 'Assets new / edit, not in the tray: paperclip');
  ok(p({ origin: 'assets', inTray: true }) === false, 'Assets edit, already in the tray: no paperclip');
}

console.log('close attaches a composer note');
{
  const run = async (d, r) => {
    const calls = [];
    const errs = [];
    await notes.attachOnClose({ closeResult: { body: { note: {} } }, attached: false, inTray: false, origin: 'chat', ...d }, { attach: async () => (calls.push(1), r), onError: (e) => errs.push(e) });
    return { calls: calls.length, errs };
  };
  let o = await run({}, { ok: true });
  ok(o.calls === 1 && o.errs.length === 0, 'closed with text: attached exactly once');
  o = await run({ closeResult: { body: { note: null, removed: true } } }, { ok: true });
  ok(o.calls === 0, 'closed empty: no attach call, no tile');
  o = await run({}, { ok: false, status: 500, body: {} });
  ok(o.calls === 1 && o.errs.length === 1, 'an attach failure reports through the error line and does not throw');
}

console.log('the sent line: a note is a note tile');
{
  const hash = 'note-a1b2c3d4e5f6.txt';
  const entry = { kind: 'attachment', meta: JSON.stringify({ attachments: [
    { name: hash, type: 'text/plain', size: 89, kind: 'note', title: 'Buy oat milk and then call the', words: 16 },
    { name: 'brief.pdf', type: 'application/pdf', size: 2048 },
  ] }) };
  const files = attachMod.sentFiles(entry, 'r1');
  eq(files.map((f) => f.kind ?? null), ['note', null], 'sentFiles carries kind note only where the engine said so');
  const opened = [];
  const wrap = attachMod.sentView(files, { open: (f) => opened.push(f.name), openAll() {} });
  const chips = wrap.children;
  const tile = chips[0];
  ok(String(tile.className) === 'is-note' && !String(tile.className).includes('att-file'), 'the sent note is the scratchpad tile (is-note), not a file chip');
  ok(tile.title === 'Open note' && tile.attrs['aria-label'] === 'Open note', 'tooltip and aria-label are "Open note"');
  ok(tile.children.length === 2 && tile.children[0].className === 'att-sr' && tile.children[0].textContent === 'Buy oat milk and then call the' && tile.children[1].className === 'att-n', 'the first words (screen readers) and the number badge are the only content [ticket]');
  const t = textOf(tile);
  eq([tile.children[1].textContent, chips[1].children[0].children.at(-1).textContent], ['1', '2'], 'the numbers follow the message order (note 1, file 2), not the drawing order [ticket]');
  ok(!t.includes('16 words') && !t.includes('note-a1b2') && !t.includes('.txt') && !t.includes('TXT') && !String(tile.title).includes('note-a1b2'), 'no word count, no hash filename, no TXT chip');
  ok(chips.length === 2 && chips[1].className === 'att-chips' && !chips[1].children.includes(tile), 'the note is in the image flow (the wrap), the file is in the chips row');
  tile.click();
  eq(opened, [hash], 'tapping opens the sent snapshot through the normal open (read-only preview)');
  ok(!String(chips[1].children[0].className).includes('is-note') && textOf(chips[1]).includes('PDF'), 'a plain file chip is unchanged');
  const img = { name: 'p.png', type: 'image/png', size: 5, raw: '/x' };
  const two = attachMod.sentView([img, files[0], { ...files[0], name: 'note-b1b2c3d4e5f6.txt' }], { open() {}, openAll() {} });
  eq(two.children.map((c) => String(c.className)), ['att-img one', 'is-note', 'is-note'], 'an image then two notes: one flow, notes after the images, no chips row');
  const nums = (w) => w.children.flatMap((c) => (c.children ?? []).concat(c.children?.flatMap((g) => g.children ?? []) ?? [])).filter((x) => x.className === 'att-n').map((x) => x.textContent);
  eq(nums(two), ['1', '2', '3'], 'three attachments: badges 1..3 in message order (image, note, note) [ticket]');
  eq(nums(attachMod.sentView([img], { open() {}, openAll() {} })), [], 'ONE attachment: no badge [ticket]');
  ok(textOf(attachMod.setBody([img, files[0]], () => {})).includes('|1|') || nums(attachMod.setBody([img, files[0]], () => {}).children[0]).length === 2, 'the whole-set view numbers its tiles too [ticket]');
  const body = textOf(attachMod.previewBody(files[0]));
  ok(!body.includes('note-a1b2') && body.includes('Buy oat milk'), 'the preview shows the title, not the hash name');
  const snap = attachMod.sentFiles({ kind: 'attachment', meta: { attachments: [{ name: 'note-0123456789ab.txt', type: 'text/plain', size: 5, kind: 'note', title: 'T', words: 1, sent_id: '0123456789ab', raw: '/api/x' }] } }, 'r 1')[0];
  eq([snap.raw, snap.inDb], ['/api/rooms/r%201/notes/sent/0123456789ab/raw', true], 'a note kept in the database reads from the engine sent-note route, never assets/raw');
  ok(attachMod.sentFiles({ kind: 'attachment', meta: { attachments: [{ name: 'note-0123456789ab.txt', type: 'text/plain', size: 5, kind: 'note', sent_id: '../x' }] } }, 'r1')[0].raw.includes('/assets/raw/'), 'a malformed sent_id never builds a route from it');
  eq(files[0].inDb, false, 'an older note (an agent-share file) is not marked as kept in the database and still reads from assets/raw');
  const old = attachMod.sentFiles({ kind: 'attachment', meta: { attachments: [{ name: 'x.txt', type: 'text/plain', size: 3 }] } }, 'r1');
  ok(old[0].kind === undefined && textOf(attachMod.sentView(old, { open() {}, openAll() {} })).includes('TXT'), 'an older entry (no kind) renders as before');
}

/* RECEIPT WORDING + THE MOVED LINE'S LIFETIME (the design system review) */
{
  const f = (n) => Array.from({ length: n }, () => ({ name: 'a.txt' }));
  const nt = (n) => Array.from({ length: n }, () => ({ name: 'n.txt', kind: 'note' }));
  eq(attachMod.receiptCount(nt(1)), '1 note', 'receipt: 1 note');
  eq(attachMod.receiptCount(nt(3)), '3 notes', 'receipt: 3 notes');
  eq(attachMod.receiptCount(f(1)), '1 file', 'receipt: 1 file');
  eq(attachMod.receiptCount(f(2)), '2 files', 'receipt: 2 files');
  eq(attachMod.receiptCount([...f(2), ...nt(1)]), '2 files, 1 note', 'receipt: 2 files + 1 note');
  eq(attachMod.receiptCount([...nt(2), ...f(1)]), '1 file, 2 notes', 'receipt: 1 file + 2 notes (files first)');

  const realST = globalThis.setTimeout;
  const realCT = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (fn, ms) => (timers.push({ fn, ms, live: true }), timers.length);
  globalThis.clearTimeout = (id) => {
    if (timers[id - 1]) {
      timers[id - 1].live = false;
    }
  };
  try {
    let repaints = 0;
    const line = notes.mountNotes({ roomId: 'r1', client: notes.createNotesClient('r1', stubFetch({ 'GET /': { body: { notes: [] } }, 'POST /move-draft': { body: { note: { id: 'n1' }, attachment: { file: { id: 'f1' } } } } }).f), menuHost: { open() {}, close() {} }, att: () => null, cells: () => null, chatHost: () => null, draft: { text: () => 'abc', prepare: async () => true, clear() {}, keep() {} }, repaintLine: () => repaints++, pickFile() {} });
    await flushMicro();
    await line.moveDraft();
    ok(line.line()?.text === 'Draft moved to a note' && !line.line().err, 'the moved line is up after a move');
    const t = timers.filter((x) => x.live).at(-1);
    ok(t && t.ms === 4000, 'it is set to clear after 4 s');
    t.fn();
    ok(line.line() === null, 'the timer clears it');
    await line.moveDraft();
    const before = repaints;
    line.clearLine();
    ok(line.line() === null && repaints === before + 1, 'a successful send clears it at once (and repaints)');
    ok(!timers.filter((x) => x.live).some((x) => x.ms === 4000), 'its timer is cleared with it');
    line.clearLine();
    ok(repaints === before + 1, 'clearing an empty line repaints nothing');
  } finally {
    globalThis.setTimeout = realST;
    globalThis.clearTimeout = realCT;
  }
}

console.log('room notes: the long-draft suggestion [ticket]');
{
  const w = (n, sep = ' ') => Array.from({ length: n }, (_, i) => `w${i}`).join(sep);
  ok(notes.NOTE_SUGGEST_WORDS === 500, 'the threshold is 500 words');
  ok(!notes.hasWords(w(499)) && notes.hasWords(w(500)) && notes.hasWords(w(501)), 'hasWords: 499 no, 500 yes, 501 yes');
  ok(notes.hasWords(w(500, ' \n\t  ')) && !notes.hasWords(w(499, '\n\n  \t')), 'hasWords: mixed whitespace and newlines count as one separator');
  ok(notes.hasWords(`  ${w(500, '\n')}  `) && !notes.hasWords('') && !notes.hasWords(null), 'hasWords: leading/trailing space; empty and null are no');
  ok(!notes.hasWords('a '.repeat(10)) && notes.hasWords('a '.repeat(10), 10), 'hasWords: takes the threshold as an argument');
  eq(notes.wordCount(w(501, '\n ')), 501, 'hasWords agrees with wordCount');

  const opened = [];
  notes.openAfterMove({ ok: true, note: { id: 'n1' } }, true, (id) => opened.push(id));
  notes.openAfterMove({ ok: true, note: { id: 'n2' } }, false, (id) => opened.push(id));
  notes.openAfterMove({ ok: false, message: 'x' }, true, (id) => opened.push(id));
  notes.openAfterMove({ ok: false, saved: true, message: 'x' }, true, (id) => opened.push(id));
  eq(opened, ['n1'], 'the editor opens with the moved note only when asked and the move worked');

  /* the shipped status-line code (room.js), run against stubs */
  const src = readFileSync(join(WEB, 'room.js'), 'utf8').replace(/\r\n/g, '\n');
  const cut = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
  const code = `${cut('function paintCharLimit() {', "input.addEventListener('input', paintCharLimit)")}
    const paintTabHint = () => {}; /* the Tab placeholder hint (room-tab-continue) is not under test here */
    let deliveryNote = ''; let charNote = ''; let longDraft = false;
    ${cut('function paintDeliveryLine() {', 'function showDeliveries(')}
    return { paintCharLimit, paintDeliveryLine, set: (k, v) => { if (k === 'delivery') deliveryNote = v; } };`;
  const mk = ({ supported = true, text = '', line = null } = {}) => {
    const w2 = { act: [], offer: [], el: { hidden: true, textContent: '', classList: { toggle() {} } } };
    const state = { text, supported, line };
    const input = { classList: { toggle() {} }, get value() { return state.text; }, scrollTop: 0, scrollLeft: 0 };
    const inputHi = { hidden: true, textContent: '', append() {} };
    const nts = {
      line: () => state.line,
      supported: () => state.supported,
      paintLimitAction: (_el, show) => w2.act.push(show),
      paintOffer: (show) => w2.offer.push(!!show && state.supported),
    };
    const api = new Function('input', 'inputHi', '$', 'notes', 'att', 'CHAR_MAX', 'CHAR_WARN_AT', 'hasWords', 'document', 'syncHiScroll', code)(
      input, inputHi, () => w2.el, nts, null, 4000, 3500, notes.hasWords, { createTextNode: () => ({}), createElement: () => ({ append() {} }) }, () => {},
    );
    return { w: w2, state, ...api };
  };
  const longText = w(520); // ~2.9k chars, under the 4000 limit
  {
    const m = mk({ text: longText });
    m.paintCharLimit();
    ok(m.w.el.textContent === '' && m.w.el.hidden && m.w.act.at(-1) === false, 'a 520-word draft under 4000 chars: nothing on the status line, no status-line action');
    ok(m.w.offer.at(-1) === true, 'a 520-word draft: the composer offer is shown');
    m.state.text = w(499);
    m.paintCharLimit();
    ok(m.w.el.textContent === '' && m.w.offer.at(-1) === false, 'under 500 words: no offer');
  }
  {
    const m = mk({ text: w(900) }); // over 4000 chars
    m.paintCharLimit();
    ok(/^over by/.test(m.w.el.textContent) && m.w.act.at(-1) === true && m.w.offer.at(-1) === false, 'over the limit: the coral line keeps its action; no composer offer');
  }
  {
    const m = mk({ text: longText, supported: false });
    m.paintCharLimit();
    ok(m.w.el.textContent === '' && m.w.act.at(-1) === false && m.w.offer.at(-1) === false, 'notes unsupported: no offer');
  }
  {
    const m = mk({ text: longText, line: { text: "Couldn't move the draft. Nothing was changed.", err: true } });
    m.paintCharLimit();
    ok(/Couldn't move/.test(m.w.el.textContent), 'an error shows on the status line');
    m.state.line = { text: 'Draft moved to a note', err: false };
    m.paintDeliveryLine();
    ok(m.w.el.textContent === 'Draft moved to a note', 'the "Draft moved" result shows on the status line');
    m.state.line = null;
    m.set('delivery', '-> @a delivered');
    m.paintDeliveryLine();
    ok(m.w.el.textContent === '-> @a delivered' && m.w.offer.at(-1) === true, 'a delivery line is not displaced by the offer, and the offer stays');
    m.state.text = '';
    m.paintCharLimit();
    ok(m.w.offer.at(-1) === false, 'after a send or a move the draft is empty: the offer hides');
  }

  /* the offer button itself (room-notes.mjs paintOffer): text, home, placement */
  {
    const mkEl = (tag) => ({
      tag, children: [], parentNode: null, hidden: false, className: '', textContent: '', disabled: false,
      classList: { set: new Set(), toggle(c, on) { on ? this.set.add(c) : this.set.delete(c); }, add(c) { this.set.add(c); }, contains(c) { return this.set.has(c); } },
      get parentElement() { return this.parentNode; },
      get lastElementChild() { return this.children.at(-1) ?? null; },
      get nextElementSibling() { const sib = this.parentNode?.children ?? []; return sib[sib.indexOf(this) + 1] ?? null; },
      append(...n) { for (const x of n) { x.parentNode?.children.splice(x.parentNode.children.indexOf(x), 1); x.parentNode = this; this.children.push(x); } },
      insertBefore(n, ref) { n.parentNode?.children.splice(n.parentNode.children.indexOf(n), 1); n.parentNode = this; this.children.splice(this.children.indexOf(ref), 0, n); },
      addEventListener() {}, setAttribute() {},
      querySelector(sel) { return this.children.find((c) => sel === '.att-tile' ? c.classList.contains('att-tile') : sel === '.rm-tray' ? c.classList.contains('rm-tray') : false) ?? null; },
    });
    const realDoc = globalThis.document;
    globalThis.document = { createElement: mkEl, body: mkEl('body') };
    try {
      const form = mkEl('form');
      const trayEl = mkEl('div'); trayEl.classList.add('rm-tray');
      const addBtn = mkEl('button');
      form.append(trayEl, addBtn);
      const { f } = stubFetch({ 'GET /': { body: { notes: [] } } });
      const n = notes.mountNotes({ roomId: 'r1', client: notes.createNotesClient('r1', f), menuHost: { open() {}, close() {} }, att: () => null, cells: () => null, chatHost: () => null, draft: { text: () => '', prepare: async () => true, clear() {}, keep() {} }, repaintLine() {}, pickFile() {}, addBtn });
      await n.probe();
      n.paintOffer(true);
      const offerEl = form.children.find((c) => c.className === 'rm-note-offer');
      ok(!!offerEl && offerEl.textContent === 'Move to a note?' && !offerEl.hidden, 'the offer reads exactly "Move to a note?"');
      ok(form.children.indexOf(offerEl) === form.children.indexOf(addBtn) - 1 && !offerEl.classList.contains('in-tray'), 'no tiles: the offer is its own row in the form, just before the + (above the input)');
      const tile = mkEl('div'); tile.classList.add('att-tile');
      trayEl.append(tile);
      n.paintOffer(true);
      ok(offerEl.parentNode === trayEl && trayEl.lastElementChild === offerEl && trayEl.children.indexOf(tile) < trayEl.children.indexOf(offerEl) && offerEl.classList.contains('in-tray'), 'with a tile: the offer is in the tray, after the last tile');
      const tile2 = mkEl('div'); tile2.classList.add('att-tile');
      trayEl.append(tile2);
      n.paintOffer(true);
      ok(trayEl.lastElementChild === offerEl, 'a second tile: the offer follows the last tile');
      trayEl.children.splice(0, trayEl.children.length, offerEl);
      n.paintOffer(true);
      ok(offerEl.parentNode === form && !offerEl.classList.contains('in-tray'), 'tiles gone: the offer goes back to the input-aligned row');
      n.paintOffer(false);
      ok(offerEl.hidden === true, 'under the threshold: hidden');
    } finally {
      globalThis.document = realDoc;
    }
  }

  /* the click: move then open; the + menu path never opens the editor */
  const route = (id) => ({ 'GET /': { body: { notes: [] } }, 'POST /move-draft': { body: { note: { id }, attachment: { file: { id: 'f1' } } } } });
  const mkN = (routes, menus) => {
    const { f, calls } = stubFetch(routes);
    const n = notes.mountNotes({ roomId: 'r1', client: notes.createNotesClient('r1', f), menuHost: { open: (s) => menus?.push(s), close() {} }, att: () => null, cells: () => null, chatHost: () => null, draft: { text: () => 'abc', prepare: async () => true, clear() {}, keep() {} }, repaintLine() {}, pickFile() {} });
    return { n, calls };
  };
  {
    const menus = [];
    const { n, calls } = mkN(route('n1'), menus);
    await flushMicro();
    n.addMenu({ getBoundingClientRect: () => ({ left: 0, top: 0 }) });
    menus[0].choose(menus[0].items.find((i) => i.a === 'move'));
    await flushMicro();
    await flushMicro();
    ok(calls.some((c) => c.path === '/move-draft') && !calls.some((c) => c.method === 'GET' && c.path === '/n1') && !n.isOpen(), 'the + menu move: the tile only, the editor is not opened');
  }
  {
    const { n, calls } = mkN({ ...route('n1'), 'GET /n1': { status: 500, body: { error: 'x' } } });
    await flushMicro();
    const line = { children: [], append(...a) { this.children.push(...a); } };
    const realDoc = globalThis.document;
    globalThis.document = { createElement: () => ({ classList: { add() {} }, setAttribute() {}, append() {}, addEventListener(t, h) { this.h = h; }, style: {} }), body: { append() {} } };
    try {
      n.paintLimitAction(line, true);
      const b = line.children.find((c) => c && c.h);
      b?.h();
      await flushMicro();
      await flushMicro();
      await flushMicro();
      ok(!!b && calls.some((c) => c.path === '/move-draft') && calls.some((c) => c.method === 'GET' && c.path === '/n1'), 'the status-line action: moves the draft, then opens that note');
    } finally {
      globalThis.document = realDoc;
    }
  }
  {
    const { n, calls } = mkN({ 'GET /': { body: { notes: [] } }, 'POST /move-draft': { status: 500, body: { error: 'x' } } });
    await flushMicro();
    await n.moveDraft(true);
    await flushMicro();
    ok(!calls.some((c) => c.method === 'GET' && c.path !== '/') && !n.isOpen(), 'a failed move opens nothing');
  }
}

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
