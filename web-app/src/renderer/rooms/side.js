// Workrooms (W2): the room's side column, "Notes · Assets (the scratchpad)". the design's step-5 page, #w2:
//  - 340 px beside the line (margin-right 12, a 1 px outline-variant left border); under 1000 px it opens over
//    the line instead, full width, with a back arrow;
//  - the 48 px header: note glyph, "Notes · <room>", close;
//  - the tabs Notes · Assets (40 px, the 3 px primary indicator);
//  - Notes: "+ New note", then a card per note: title, two lines, "Edited by <who> · <ago>"; a note opens to
//    edit in place and saves as you type; "Editing · Saved" shows for 2 s;
//  - Assets: the room's files with their message.
// Notes and assets are per room, not per family (ROOMS-API.md §4.8). Everything goes through window.wb.rooms.
import { ATTACH_UNAVAILABLE } from '../first-run/model.js';
import { icon } from '../m3-chrome.js';
import { createThumbnailCache } from './thumbnail-cache.js';
import { el } from './line.js';

const SAVE_MS = 600;
const SAVED_FOR_MS = 2000;

function agoWords(ts) {
  const s = Math.max(0, Math.round((Date.now() - (Number(ts) || 0)) / 1000));
  if (s < 60) {
    return 'just now';
  }
  const m = Math.round(s / 60);
  if (m < 60) {
    return m + ' min ago';
  }
  const h = Math.round(m / 60);
  return h < 24 ? h + ' h ago' : Math.round(h / 24) + ' d ago';
}
function sizeWords(n) {
  n = Number(n) || 0;
  if (n < 1024) {
    return n + ' B';
  }
  if (n < 1024 * 1024) {
    return Math.round(n / 1024) + ' KB';
  }
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}
/** A note's title and the start of its body: the first line (a leading # dropped), then the rest. */
export function noteWords(text) {
  const lines = String(text || '').split('\n');
  const i = lines.findIndex((l) => l.trim());
  if (i < 0) {
    return { title: 'Untitled note', body: '' };
  }
  return { title: lines[i].replace(/^#+\s*/, '').trim() || 'Untitled note', body: lines.slice(i + 1).join(' ').replace(/\s+/g, ' ').trim() };
}

/**
 * createSide(deps): { roomId(), roomName(), me() -> handle, thumb(roomId, name, w), openImage(items, i),
 *   download(roomId, name), lineText(lineId) -> string|null, jump(lineId), onClose(), narrow() }
 */
export function createSide(deps) {
  const thumbnailCache = createThumbnailCache(10 * 1024 * 1024);
  let generation = 0;
  const capture = () => ({ generation, api: window.wb.rooms.bind() });
  const current = (request) => !!request && request.generation === generation && request.api.current();
  const root = el('aside', 'wr-side');
  root.setAttribute('aria-label', 'Notes and assets');
  root.hidden = true;
  const head = el('div', 'wr-sideh');
  const back = el('button', 'wr-ib wr-sideback');
  back.type = 'button';
  back.title = 'Back to the line';
  back.setAttribute('aria-label', 'Back to the line');
  back.innerHTML = icon('arrow_back');
  const glyph = el('span', 'wr-sideg');
  glyph.innerHTML = icon('sticky_note_2');
  const title = el('div', 'wr-sidet');
  const close = el('button', 'wr-ib wr-sidex');
  close.type = 'button';
  close.title = 'Close';
  close.setAttribute('aria-label', 'Close');
  close.innerHTML = icon('close');
  head.append(back, glyph, title, close);
  const tabs = el('div', 'wr-sidetabs');
  tabs.setAttribute('role', 'tablist');
  const tabBtn = (key, label) => {
    const b = el('button', 'wr-sidetab', label);
    b.type = 'button';
    b.dataset.tab = key;
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => show(key));
    return b;
  };
  const tNotes = tabBtn('notes', 'Notes');
  const tAssets = tabBtn('assets', 'Assets');
  tabs.append(tNotes, tAssets);
  const body = el('div', 'wr-sideb');
  root.append(head, tabs, body);

  const st = { tab: 'notes', roomId: null, notes: [], assets: [], editing: null, saveTimer: null, savedTimer: null, savedAt: 0, dirty: false, stale: false, error: null, token: 0 };

  const parkedEditors = new Map();
  // Tasks seam S2: a module page shown in this column ({ key, title, mount, onDispose }), or null
  let tool = null;
  function disposeTool() {
    if (!tool) return;
    const t = tool;
    tool = null;
    t.mount.remove?.();
    try { t.onDispose?.(); } catch (e) { /* the module host owns its own clean-up */ }
    deps.onToolChange?.(); // the page's phone tool layer (the design s10)
  }
  let editorEpoch = 0;
  const connected = id => !deps.roomConnected || deps.roomConnected(id);
  const editorCurrent = ed => !!ed && current(ed.request) && !ed.suspended && connected(ed.roomId);
  function parkEditor() {
    clearTimeout(st.saveTimer); clearTimeout(st.savedTimer);
    if (!st.editing) return;
    const ed = st.editing;
    ed.suspended = true; ed.version = (ed.version || 0) + 1;
    if (ed.saving) ed.dirty = true;
    parkedEditors.set(ed.roomId, ed);
    ed.card.remove(); st.editing = null;
  }
  function restoreEditor(id) {
    const ed = parkedEditors.get(id);
    if (!ed || !connected(id) || !current(ed.request)) return;
    parkedEditors.delete(id); ed.suspended = false; st.editing = ed;
    if (ed.dirty) st.saveTimer = setTimeout(() => save(ed), SAVE_MS);
  }
  const roomLabel = () => deps.roomName() || 'the room';
  function paintHead() {
    const closeLabel = tool ? 'Close preview' : 'Close';
    close.title = closeLabel;
    close.setAttribute('aria-label', closeLabel);
    if (tool) {
      // narrow (a phone): a tool page is the full-width layer with the back arrow, like Notes (the design's viewer §3); on a
      // phone its bar names the tool and its back arrow says "Back to the room" (the design's s10)
      const narrowTool = deps.narrow();
      title.textContent = narrowTool ? tool.title : tool.title + ' · ' + roomLabel();
      glyph.innerHTML = icon('extension');
      tabs.hidden = true;
      back.title = narrowTool ? 'Back to the room' : 'Back to the line';
      back.setAttribute('aria-label', back.title);
      back.hidden = !narrowTool;
      close.hidden = narrowTool;
      root.classList.toggle('over', narrowTool);
      return;
    }
    title.textContent = (st.tab === 'notes' ? 'Notes' : st.tab === 'brief' ? 'Brief' : 'Assets') + ' · ' + roomLabel();
    glyph.innerHTML = icon(st.tab === 'notes' ? 'sticky_note_2' : st.tab === 'brief' ? 'info' : 'folder_open');
    tabs.hidden = st.tab === 'brief'; // the brief is a column of its own (W3), not a third tab
    const narrow = deps.narrow();
    back.title = 'Back to the line';
    back.setAttribute('aria-label', back.title);
    back.hidden = !narrow;
    close.hidden = narrow;
    root.classList.toggle('over', narrow);
    for (const b of [tNotes, tAssets]) {
      const on = b.dataset.tab === st.tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
  }

  // ---- Notes
  const attachingNotes = new WeakSet();
  const filesAvailable = () => deps.filesAvailable?.() !== false;
  const attachUnavailable = ATTACH_UNAVAILABLE;
  function paintNoteAttach(button, updateLabel = true) {
    if (updateLabel) button.textContent = noteAttachLabel(button.dataset.note);
    button.disabled = attachingNotes.has(button) || !filesAvailable();
    if (!filesAvailable()) {
      button.title = attachUnavailable;
      button.setAttribute('aria-describedby', button.dataset.reason);
    } else { button.removeAttribute('title'); button.removeAttribute('aria-describedby'); }
  }
  const noteAttachLabel = id => deps.hasNote?.(id) ? 'Added to message' : 'Add to message';
  function refreshNoteAttachments() {
    for (const button of root.querySelectorAll('.wr-noteattach')) paintNoteAttach(button);
  }
  function noteCard(n) {
    const c = el('div', 'wr-note');
    c.dataset.note = n.id;
    c.tabIndex = 0;
    const w = noteWords(n.excerpt != null ? n.excerpt : n.text);
    c.appendChild(el('div', 'wr-notet', w.title));
    if (w.body) {
      c.appendChild(el('div', 'wr-noteb', w.body));
    }
    const who = !n.author || n.author === 'user' || n.author === deps.me() ? 'you' : n.author;
    c.appendChild(el('div', 'wr-notem', 'Edited by ' + who + ' · ' + agoWords(n.updatedAt)));
    const attach = el('button', 'wr-dlgbtn text wr-noteattach', noteAttachLabel(n.id));
    attach.dataset.note = n.id;
    attach.type = 'button';
    const reason = el('span', 'wr-popstatus', attachUnavailable);
    reason.id = 'wr-note-attach-reason-' + st.roomId + '-' + n.id;
    attach.dataset.reason = reason.id; c.appendChild(reason); paintNoteAttach(attach);
    attach.addEventListener('keydown', e => e.stopPropagation());
    attach.addEventListener('click', async e => {
      e.stopPropagation();
      const request = capture(), roomId = st.roomId, origin = deps.noteRequest?.();
      const valid = () => filesAvailable() && current(request) && st.roomId === roomId && connected(roomId) && (!origin || origin.isCurrent());
      if (attach.disabled || !valid()) return;
      attachingNotes.add(attach); attach.disabled = true;
      try {
        const r = await request.api.noteAttach(roomId, n.id).catch(() => null);
        if (!valid()) return;
        const added = r?.ok && deps.attachNote?.(r.value?.attachment, r.value?.note, origin);
        attach.textContent = added ? noteAttachLabel(n.id) : 'Try again';
      } finally { attachingNotes.delete(attach); paintNoteAttach(attach, false); }
    });
    c.appendChild(attach);
    const open = () => edit(n.id);
    c.addEventListener('click', open);
    c.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        open();
      }
    });
    return c;
  }
  function paintNotes() {
    const keep = st.editing && st.editing.card.isConnected ? st.editing.card : null;
    if (keep) {
      // the note being edited never leaves the DOM (that would take the caret): the others are redrawn around it
      for (const ch of [...keep.parentNode.children]) {
        if (ch !== keep && ch.classList.contains('wr-note')) {
          ch.remove();
        }
      }
      let after = null;
      for (const n of st.notes) {
        if (n.id === st.editing.id) {
          after = keep;
          continue;
        }
        const c = noteCard(n);
        if (after) {
          after.after(c);
          after = c;
        } else {
          keep.before(c);
        }
      }
      return;
    }
    body.textContent = '';
    const list = el('div', 'wr-notes');
    const add = el('button', 'wr-newnote');
    add.type = 'button';
    add.innerHTML = icon('add');
    add.appendChild(document.createTextNode('New note'));
    add.addEventListener('click', newNote);
    list.appendChild(add);
    if (st.error) {
      list.appendChild(el('div', 'wr-sidemsg', st.error));
    }
    for (const n of st.notes) {
      if (st.editing && st.editing.id === n.id) {
        list.appendChild(st.editing.card);
      } else {
        list.appendChild(noteCard(n));
      }
    }
    if (st.editing && !st.notes.some((n) => n.id === st.editing.id)) {
      list.insertBefore(st.editing.card, add.nextSibling); // a new note, before the list catches up
    }
    if (!st.notes.length && !st.editing && !st.error) {
      list.appendChild(el('div', 'wr-sidemsg', 'No notes in ' + roomLabel() + ' yet.'));
    }
    body.appendChild(list);
  }
  async function loadNotes() {
    const request = capture();
    const id = st.roomId;
    const token = ++st.token;
    const r = await request.api.notes(id);
    if (!current(request) || token !== st.token || id !== st.roomId) {
      return;
    }
    if (r && r.ok && r.value) {
      st.error = null;
      st.notes = (r.value.notes || []).filter((n) => !n.archived).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0));
    } else {
      st.error = "Couldn't load the notes.";
    }
    if (st.tab === 'notes') {
      paintNotes();
    }
  }
  function editorCard(id, text, request = capture()) {
    const c = el('div', 'wr-note editing');
    c.dataset.note = id;
    const ta = el('textarea', 'wr-noteta');
    ta.value = text;
    ta.setAttribute('aria-label', 'Note');
    const meta = el('div', 'wr-notem', 'Editing');
    c.append(ta, meta);
    const grow = () => {
      ta.style.height = 'auto';
      ta.style.height = Math.max(96, ta.scrollHeight) + 'px';
    };
    ta.addEventListener('input', () => {
      if (!editorCurrent(ed)) return;
      ed.dirty = true;
      meta.textContent = 'Editing';
      clearTimeout(st.saveTimer);
      st.saveTimer = setTimeout(() => save(ed), SAVE_MS);
      grow();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish();
      }
    });
    c.addEventListener('focusout', (e) => {
      if (!c.contains(e.relatedTarget)) {
        setTimeout(() => {
          if (st.editing && st.editing.card === c && !c.contains(document.activeElement)) {
            finish();
          }
        }, 0);
      }
    });
    requestAnimationFrame(() => {
      grow();
      ta.focus();
      ta.selectionStart = ta.selectionEnd = ta.value.length;
    });
    const ed = { id, roomId: st.roomId, request, card: c, ta, meta, dirty: false };
    return ed;
  }
  async function save(ed = st.editing) {
    if (!editorCurrent(ed)) return false;
    const version = ed.version || 0;
    if (ed.saving) return ed.saving;
    ed.saving = (async () => {
      while (ed.dirty && editorCurrent(ed)) {
        const text = ed.ta.value;
        ed.dirty = false;
        const r = await ed.request.api.noteSet(ed.roomId, ed.id, text).catch(() => null);
        if (!editorCurrent(ed) || (ed.version || 0) !== version) return false;
        if (!r?.ok) { ed.dirty = true; ed.meta.textContent = "Editing · Couldn't save"; return false; }
        if (ed.ta.value !== text) ed.dirty = true;
      }
      ed.meta.textContent = 'Editing · Saved';
      st.savedAt = Date.now();
      clearTimeout(st.savedTimer);
      st.savedTimer = setTimeout(() => {
        if (st.editing === ed && !ed.dirty) ed.meta.textContent = 'Editing';
      }, SAVED_FOR_MS);
      return true;
    })();
    try { return await ed.saving; } finally {
      ed.saving = null;
      if ((ed.version || 0) !== version && ed.dirty && editorCurrent(ed)) st.saveTimer = setTimeout(() => save(ed), SAVE_MS);
    }
  }
  async function edit(id, originRequest = deps.noteRequest?.()) {
    if (originRequest && (!originRequest.isCurrent() || originRequest.roomId !== st.roomId)) return;
    const request = capture(), roomId = st.roomId, epoch = editorEpoch;
    if (st.editing) {
      if (!(await finish())) return;
    }
    if (!current(request) || epoch !== editorEpoch || st.roomId !== roomId || !connected(roomId)) return;
    const r = await request.api.note(roomId, id);
    if (!current(request) || epoch !== editorEpoch || st.roomId !== roomId || !connected(roomId)) return;
    if (!r || !r.ok || !r.value) {
      st.error = "Couldn't open that note.";
      paintNotes();
      return;
    }
    if (originRequest && !originRequest.isCurrent()) return;
    st.editing = editorCard(id, String(r.value.text || ''), request);
    st.editing.originRequest = originRequest;
    paintNotes();
  }
  async function newNote(options = {}) {
    const originRequest = options.request;
    if (originRequest && (!originRequest.isCurrent?.() || originRequest.roomId !== st.roomId)) return;
    const request = capture(), roomId = st.roomId, epoch = editorEpoch;
    if (st.editing) {
      if (!(await finish())) return;
    }
    if (!current(request) || epoch !== editorEpoch || st.roomId !== roomId || !connected(roomId)) return;
    if (originRequest && !originRequest.isCurrent()) return;
    const r = await request.api.noteCreate(roomId, '');
    if (!current(request) || epoch !== editorEpoch || st.roomId !== roomId || !connected(roomId)) return;
    if (!r || !r.ok || !r.value || !r.value.note) {
      st.error = "Couldn't make a note.";
      paintNotes();
      return;
    }
    if (originRequest && !originRequest.isCurrent()) return;
    st.editing = editorCard(r.value.note.id, '', request);
    st.editing.origin = options.origin || 'assets';
    st.editing.originRequest = originRequest;
    paintNotes();
  }
  /** Stop editing: save what's left, close the note (an empty one is removed), then the list. */
  async function finish() {
    const ed = st.editing;
    if (!ed) return true;
    if (!editorCurrent(ed)) return false;
    const version = ed.version || 0;
    const valid = () => editorCurrent(ed) && (ed.version || 0) === version;
    if (ed.closing) return ed.closing;
    clearTimeout(st.saveTimer);
    ed.closing = (async () => {
      if (!(await save(ed)) || !valid()) return false;
      const closed = await ed.request.api.noteClose(ed.roomId, ed.id).catch(() => null);
      if (!valid()) return false;
      if (!closed?.ok) { ed.meta.textContent = "Editing · Couldn't close"; return false; }
      if (ed.dirty) return false;
      if (deps.roomId() === ed.roomId && (!ed.originRequest || ed.originRequest.isCurrent()) &&
          closed.value?.removed !== true && ed.ta.value.trim() &&
          (ed.origin === 'chat' || deps.hasNote?.(ed.id))) {
        const origin = ed.originRequest;
        const r = await ed.request.api.noteAttach(ed.roomId, ed.id).catch(() => null);
        if (!valid()) return false;
        if (deps.roomId() !== ed.roomId || (origin && !origin.isCurrent())) {
          if (st.editing === ed && !ed.dirty) st.editing = null;
          return !ed.dirty;
        }
        if (ed.dirty) return false;
        if (!r?.ok || !deps.attachNote?.(r.value?.attachment, r.value?.note || { id: ed.id, text: ed.ta.value }, origin)) {
          ed.meta.textContent = "Editing · Couldn't attach"; return false;
        }
      }
      if (ed.dirty) return false; // typing during close stays in its editor
      if (st.editing === ed) st.editing = null;
      await loadNotes();
      return true;
    })();
    try { return await ed.closing; } finally { ed.closing = null; }
  }

  // ---- Assets: the room's files with their message
  function paintAssets() {
    thumbnailCache.setRoom(st.roomId);
    body.textContent = '';
    const list = el('div', 'wr-assets');
    if (st.error) {
      list.appendChild(el('div', 'wr-sidemsg', st.error));
    } else if (!st.assets.length) {
      list.appendChild(el('div', 'wr-sidemsg', 'No files in ' + roomLabel() + ' yet.'));
    }
    const images = st.assets.filter((a) => a.kind === 'image' || /^image\//.test(a.type || ''));
    for (const a of st.assets) {
      const isImage = images.includes(a);
      const row = el('button', 'wr-asset');
      row.type = 'button';
      row.dataset.name = a.name;
      const pic = el('span', 'wr-assetp');
      if (isImage) {
        const request = capture(), roomId = st.roomId, token = st.token;
        thumbnailCache.load(JSON.stringify([roomId,a.name,128]), () => deps.thumb(roomId, a.name, 128), (url, decoded) => {
          if (url) {
            const img = document.createElement('img');
            img.addEventListener('load', () => decoded(img.naturalWidth * img.naturalHeight * 4), { once: true });
            img.src = url;
            img.alt = '';
            pic.textContent = '';
            pic.appendChild(img);
          }
        }, () => { pic.innerHTML = icon('image'); }, () => current(request) && roomId === st.roomId && token === st.token && pic.isConnected);
        pic.innerHTML = icon('image');
      } else {
        pic.innerHTML = icon('description');
      }
      row.appendChild(pic);
      const tx = el('span', 'wr-assett');
      tx.appendChild(el('span', 'wr-assetn', a.name));
      const who = a.addedBy === 'user' || a.addedBy === deps.me() ? 'You' : a.addedBy || '';
      tx.appendChild(el('span', 'wr-assets2', [who, agoWords(a.addedAt), sizeWords(a.size)].filter(Boolean).join(' · ')));
      const said = a.lineId != null ? deps.lineText(a.lineId) : null;
      if (said) {
        // clicking the quoted message jumps to it in the line
        const qb = el('span', 'wr-assetq', '“' + said + '”');
        qb.setAttribute('role', 'link');
        qb.title = 'Show it in the line';
        qb.addEventListener('click', (e) => {
          e.stopPropagation();
          deps.jump(a.lineId);
        });
        tx.appendChild(qb);
      }
      row.appendChild(tx);
      row.title = isImage ? 'Open ' + a.name : 'Download ' + a.name;
      row.addEventListener('click', () => {
        if (isImage) {
          deps.openImage(images.map((x) => ({ roomId: st.roomId, name: x.name, who: x.addedBy === 'user' ? 'You' : x.addedBy, ts: x.addedAt })), images.indexOf(a));
        } else {
          deps.download(st.roomId, a.name);
        }
      });
      list.appendChild(row);
    }
    body.appendChild(list);
  }
  async function loadAssets() {
    const request = capture();
    const id = st.roomId;
    const token = ++st.token;
    const r = await request.api.assets(id);
    if (!current(request) || token !== st.token || id !== st.roomId) {
      return;
    }
    if (r && r.ok && r.value) {
      st.error = null;
      st.assets = Array.isArray(r.value.assets) ? r.value.assets : [];
    } else {
      st.error = "Couldn't load the files.";
    }
    if (st.tab === 'assets') {
      paintAssets();
    }
  }

  // ---- W3: the room's brief: read-only until Edit; "No brief yet." with [Write one]; Clear asks
  let briefEditing = false;
  function paintBrief() {
    const request = capture();
    const roomId = st.roomId;
    const isCurrent = () => current(request) && st.roomId === roomId && st.tab === 'brief' && !root.hidden;
    body.textContent = '';
    const b = deps.brief ? deps.brief() : { text: '' };
    const box = el('div', 'wr-brief');
    if (briefEditing) {
      const ta = el('textarea', 'wr-briefta');
      ta.value = b.text || '';
      ta.setAttribute('aria-label', 'Brief');
      const acts = el('div', 'wr-briefa');
      const save = el('button', 'wr-dlgbtn filled', 'Save');
      save.type = 'button';
      const cancel = el('button', 'wr-dlgbtn text', 'Cancel');
      cancel.type = 'button';
      save.addEventListener('click', async () => {
        if (!isCurrent()) return;
        save.disabled = true;
        const ok = await deps.saveBrief(ta.value, { roomId, api: request.api });
        if (!isCurrent()) return;
        save.disabled = false;
        if (ok) {
          briefEditing = false;
          paintBrief();
        }
      });
      cancel.addEventListener('click', () => {
        if (!isCurrent()) return;
        briefEditing = false;
        paintBrief();
      });
      acts.append(cancel, save);
      box.append(ta, acts);
      body.appendChild(box);
      requestAnimationFrame(() => ta.focus());
      return;
    }
    if (!b.text) {
      box.appendChild(el('div', 'wr-sidemsg', 'No brief yet. The lead reads it when it starts.'));
      const w = el('button', 'wr-dlgbtn tonal', 'Write one');
      w.type = 'button';
      w.addEventListener('click', () => {
        if (!isCurrent()) return;
        briefEditing = true;
        paintBrief();
      });
      box.appendChild(w);
    } else {
      box.appendChild(el('div', 'wr-brieftext', b.text));
      const acts = el('div', 'wr-briefa');
      const edit = el('button', 'wr-dlgbtn tonal', 'Edit');
      edit.type = 'button';
      edit.addEventListener('click', () => {
        if (!isCurrent()) return;
        briefEditing = true;
        paintBrief();
      });
      const clear = el('button', 'wr-dlgbtn text', 'Clear');
      clear.type = 'button';
      clear.addEventListener('click', () => isCurrent() && deps.clearBrief && deps.clearBrief());
      acts.append(clear, edit);
      box.appendChild(acts);
    }
    body.appendChild(box);
  }

  // ---- the column
  async function show(tab, mode) {
    if (tool) {
      // leaving a tool page for the same room: dispose it, then give this room its parked editor back
      // (its save resumes from there); R4, corrected after a builder 
      disposeTool();
      if (!st.editing) restoreEditor(st.roomId);
    }
    const request = capture();
    if (st.editing && tab !== 'notes') {
      if (!(await finish())) return;
    }
    if (!current(request)) return;
    st.tab = tab === 'assets' ? 'assets' : tab === 'brief' ? 'brief' : 'notes';
    st.error = null;
    paintHead();
    if (st.tab === 'brief') {
      briefEditing = mode === 'edit';
      paintBrief();
    } else if (st.tab === 'notes') {
      paintNotes();
      loadNotes();
    } else {
      paintAssets();
      loadAssets();
    }
  }
  // While a tool shows, every way of dismissing it takes ONE step back (the design, Client ): the column
  // as it was before the tool opened. Otherwise these close the column, as before.
  const dismiss = () => (tool ? api.closeTool() : api.close());
  close.addEventListener('click', () => dismiss());
  back.addEventListener('click', () => dismiss());
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !st.editing) {
      e.preventDefault();
      dismiss();
    }
  });

  const api = {
    el: root,
    refreshNoteAttachments,
    newNote,
    editNote: edit,
    isOpen: () => !root.hidden,
    /**
     * Tasks seam S2: show a module's page here for the shown room. A live note editor is PARKED (saving
     * suspended, the dirty draft kept exactly), never finished; leaving the tool for the same room
     * restores it. A room switch, close, suspend or account reset disposes the page.
     */
    openTool(key, mount, { title, onDispose, binding } = {}) {
      if (!connected(deps.roomId())) return false;
      // how the column was, so closing the tool restores it: a closed column stays closed
      const prev = tool ? tool.prev : { open: !root.hidden, tab: st.tab };
      root.hidden = false;
      if (st.roomId !== deps.roomId()) {
        parkEditor(); st.token++; editorEpoch++;
        st.roomId = deps.roomId();
        st.notes = [];
        st.assets = [];
      }
      disposeTool();
      parkEditor();
      st.token++; // any Notes or Assets load still in flight is stale now
      tool = { key: String(key), title: String(title || 'Tool'), mount, onDispose, binding: binding || null, prev };
      st.error = null;
      paintHead();
      body.replaceChildren(mount);
      deps.onToolChange?.();
      return true;
    },
    toolOpen: () => (tool ? tool.key : null),
    toolBinding: () => (tool ? tool.binding : null), // S4: the frame's identity
    /** Close the tool page and put the column back as it was before the tool opened. */
    async closeTool() {
      if (!tool) return;
      const prev = tool.prev;
      disposeTool();
      if (!prev.open) {
        root.hidden = true;
        deps.onClose();
        return;
      }
      if (!st.editing) restoreEditor(st.roomId);
      await show(prev.tab);
    },
    /** Open on a tab for the shown room. */
    open(tab, mode) {
      if (!connected(deps.roomId())) return;
      root.hidden = false;
      if (st.roomId !== deps.roomId()) {
        parkEditor(); st.token++; editorEpoch++;
        st.roomId = deps.roomId();
        st.notes = [];
        st.assets = [];
      }
      if (!st.editing) restoreEditor(st.roomId);
      show(tab || st.tab, mode);
    },
    /** The room's view changed (a brief saved here or elsewhere): a shown brief repaints unless it's being edited. */
    briefChanged() {
      if (!root.hidden && st.tab === 'brief' && !briefEditing) {
        paintBrief();
      }
    },
    // A local disconnect hides the editor without discarding its unsaved text.
    suspend() {
      disposeTool();
      editorEpoch++;
      parkEditor();
      st.token++; root.hidden = true;
    },
    async close() {
      const request = capture();
      disposeTool(); // a parked note stays parked for its room; reopening Notes there restores it
      if (st.editing) {
        if (!(await finish())) return;
      }
      if (!current(request)) return;
      root.hidden = true;
      deps.onClose();
    },
    // Account changes discard this view. Flushing here would send the previous account's text.
    resetAccount() {
      disposeTool();
      thumbnailCache.clear();
      generation++; editorEpoch++; parkedEditors.clear();
      clearTimeout(st.saveTimer); clearTimeout(st.savedTimer);
      st.token++; st.roomId = null; st.editing = null; st.notes = []; st.assets = []; st.error = null;
      briefEditing = false; body.textContent = ''; root.hidden = true;
      deps.onClose();
    },
    /** The shown room changed: the column follows it (notes and assets are per room). */
    async roomChanged() {
      const request = capture();
      if (root.hidden || st.roomId === deps.roomId()) {
        return;
      }
      if (tool) {
        disposeTool(); // the tool page was for the previous room; its parked draft stays parked for that room
        st.tab = 'notes';
      }
      if (st.editing) {
        if (!(await finish())) return;
      }
      if (!current(request)) return;
      st.roomId = deps.roomId();
      st.notes = [];
      st.assets = [];
      show(st.tab);
    },
    /** room.scratchpad: notes or assets changed; the open note being edited is never pulled from under you. */
    changed(roomId) {
      if (root.hidden || roomId !== st.roomId || tool) {
        return; // never paint Notes or Assets over a tool page
      }
      if (st.tab === 'notes') {
        loadNotes();
      } else {
        loadAssets();
      }
    },
    relayout: () => {
      if (!root.hidden) {
        paintHead();
      }
    },
    canChangeFiles: () => !briefEditing && !st.editing?.dirty && !st.editing?.saving && ![...parkedEditors.values()].some(ed => ed.dirty || ed.saving),
    state: () => ({ briefEditing, open: !root.hidden, tab: tool ? tool.key : st.tab, roomId: st.roomId, notes: st.notes.map((n) => n.id), assets: st.assets.map((a) => a.name), editing: st.editing ? st.editing.id : null, over: root.classList.contains('over') }),
  };
  return api;
}
