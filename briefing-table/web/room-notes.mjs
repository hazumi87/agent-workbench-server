/* ROOM NOTES, the HOST half (ticket; spec KB design-notes-id). A note is a
 * transient text document kept in a ROOM: the engine owns the rows
 * (src/server/rooms.ts handleNotes, /api/rooms/:id/notes); this module is
 * everything the room page draws and EVERY write (it holds the person's
 * cookie; an app panel's sandboxed frame has none and only asks, see
 * room-cells.mjs, {panel:'notes'} / {panel:'note'}).
 *
 * The first half is pure (no DOM, no imports, so test/room-notes.test.mjs runs
 * it as shipped): the fetch client, the autosave, the move-draft steps, the
 * panel's op table. The second half draws: the editor (a modal on a PC, a
 * layer on a phone), the composer's + menu hook and the over-limit action.
 *
 * Rules that hold throughout:
 *   - No Save button. The text is autosaved like the composer draft: a PUT
 *     debounced 400 ms, a keepalive flush when the page hides, and a local
 *     copy (guarded localStorage, keyed by note id) kept until the server
 *     confirms THE SAME text, so a refresh or an outage loses nothing.
 *   - Closing is always safe (Esc, the scrim, X): it saves, then asks the
 *     engine to index. A note that belongs to the MESSAGE (origin 'chat': the
 *     composer's + -> New note, or its tray tile) has no paperclip: the close
 *     attaches it (or re-attaches, so the tile holds the latest text; the
 *     engine removes an empty note, which then adds no tile). The paperclip is
 *     only for a note opened from the Assets panel and not in the tray.
 *   - Never .focus() a text field on touch. Never log or print note text.
 */

const ID_RE = /^[a-f0-9]{12}$/;
const DOT = String.fromCharCode(183);
export const NOTE_OPS = ['new', 'edit', 'attach', 'copy', 'pin', 'unpin', 'archive', 'unarchive'];
export const DEBOUNCE_MS = 400;
const PHONE = '(max-width: 600px)';

/** "now", "15m ago", "2h ago", "10d ago", "6mo ago" (the design system words). */
export function ageWord(ts, now = Date.now()) {
  const m = Math.floor(Math.max(0, now - Number(ts)) / 60000);
  if (!Number.isFinite(m) || m < 1) {
    return 'now';
  }
  if (m < 60) {
    return `${m}m ago`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return `${h}h ago`;
  }
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ago` : `${Math.floor(d / 30)}mo ago`;
}

export function wordCount(text) {
  return String(text ?? '').split(/\s+/).filter(Boolean).length;
}

/** Words in a composer draft at which the composer offers "Move to a note?"
 *  (a quiet suggestion, not a setting). */
export const NOTE_SUGGEST_WORDS = 500;

/** True once the text holds at least `n` words. One pass; stops as soon as it
 *  gets there, and skips the scan when the text is too short to hold that many
 *  (n words need at least 2n-1 characters). */
export function hasWords(text, n = NOTE_SUGGEST_WORDS) {
  const t = String(text ?? '');
  if (t.length < 2 * n - 1) {
    return false;
  }
  let words = 0;
  let inWord = false;
  for (let i = 0; i < t.length; i++) {
    if (/\s/.test(t[i])) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      if (++words >= n) {
        return true;
      }
    }
  }
  return false;
}

/** After a "Move to a note" from the status line (open = true) the note opens
 *  in the editor so the writer keeps going; a failed move opens nothing. */
export function openAfterMove(out, open, openNote) {
  if (open && out?.ok && out.note?.id) {
    openNote(out.note.id);
  }
}

/** The note's first words, for a tile's name (never the hash filename). */
export function titleOf(text, max = 40) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) {
    return 'Empty note';
  }
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}...`;
}

/** What a failed answer says, plainly. */
export function errText(r) {
  const e = r?.body?.error;
  return typeof e === 'string' && e ? e : r?.status === 0 ? 'no connection' : `HTTP ${r?.status}`;
}

/** The routes under /api/rooms/:id/notes. Never throws: an answer is always
 *  {ok, status, body}; a network failure is status 0. */
export function createNotesClient(roomId, fetchImpl) {
  const f = fetchImpl ?? ((...a) => globalThis.fetch(...a));
  const base = `/api/rooms/${encodeURIComponent(roomId)}/notes`;
  async function req(method, path, body, keepalive) {
    try {
      const init = { method };
      if (body !== undefined) {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      if (keepalive) {
        init.keepalive = true;
      }
      const r = await f(base + path, init);
      let b = null;
      try {
        b = await r.json();
      } catch {
        b = null;
      }
      return { ok: r.ok, status: r.status, body: b };
    } catch {
      return { ok: false, status: 0, body: { error: 'no connection' } };
    }
  }
  const id = (x) => `/${encodeURIComponent(x)}`;
  return {
    list: () => req('GET', ''),
    create: (text) => req('POST', '', text ? { text } : {}),
    get: (x) => req('GET', id(x)),
    put: (x, text, keepalive) => req('PUT', id(x), { text }, keepalive),
    close: (x) => req('POST', `${id(x)}/close`),
    attach: (x) => req('POST', `${id(x)}/attach`),
    pin: (x, pinned) => req('POST', `${id(x)}/pin`, { pinned: !!pinned }),
    archive: (x, archived) => req('POST', `${id(x)}/archive`, { archived: !!archived }),
    moveDraft: () => req('POST', '/move-draft'),
  };
}

function guardedStore() {
  return {
    get(k) {
      try {
        return JSON.parse(localStorage.getItem(k) || 'null');
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {
        /* no storage: the server copy is all there is */
      }
    },
    remove(k) {
      try {
        localStorage.removeItem(k);
      } catch {
        /* nothing to drop */
      }
    },
  };
}

/** Autosave for ONE open note. `confirmed` is the text the server is known to
 *  hold; the local copy exists exactly while text !== confirmed. Saves run one
 *  after another, so an older text can never land after a newer one. */
export function createAutosave(o) {
  const store = o.store ?? guardedStore();
  const key = `hwb.room.note.${o.roomId}.${o.id}`;
  const setT = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = o.clearTimer ?? ((t) => clearTimeout(t));
  let confirmed = o.text ?? '';
  let text = confirmed;
  let timer = null;
  let chain = Promise.resolve();

  function save() {
    clearT(timer);
    timer = null;
    chain = chain.then(async () => {
      const t = text;
      if (t === confirmed) {
        return;
      }
      const r = await o.client.put(o.id, t);
      if (r.ok) {
        confirmed = t;
        if (text === t) {
          store.remove(key); // the server holds exactly what is shown
        }
        o.onSaved?.(r.body);
      } else {
        o.onError?.(errText(r), r.status);
      }
    });
    return chain;
  }
  return {
    key,
    /** a local copy that differs from the server's text (a refresh or an outage
     *  ended an earlier session): the text to show, or null. Call change() with it. */
    leftover() {
      const l = store.get(key);
      return l && typeof l.text === 'string' && l.text !== confirmed ? l.text : null;
    },
    change(t) {
      text = t;
      store.set(key, { text: t, at: Date.now() });
      clearT(timer);
      timer = setT(() => void save(), o.debounceMs ?? DEBOUNCE_MS);
    },
    save,
    /** the page is going away: send what is unsaved NOW, outliving the page */
    flush() {
      if (text === confirmed) {
        return;
      }
      clearT(timer);
      timer = null;
      const t = text;
      void o.client.put(o.id, t, true).then((r) => {
        if (r.ok) {
          confirmed = t;
          if (text === t) {
            store.remove(key);
          }
        }
      });
    },
    /** wait for every save; true when the server holds the text */
    async settle() {
      await save();
      return text === confirmed;
    },
    get dirty() {
      return text !== confirmed;
    },
    get text() {
      return text;
    },
  };
}

/** After a close: does the tray tile need the latest text? Not when the note
 *  was attached by this very close, nor when the engine removed it (it was
 *  empty). A note that belongs to the message (origin 'chat') is attached by
 *  its close even if it has no tile yet; an Assets note only if it has one. */
export function shouldReattach(closeResult, attached, inTray, origin) {
  return !attached && (inTray || origin === 'chat') && closeResult?.body?.removed !== true;
}

/** The paperclip: only for a note opened from the Assets panel that is not
 *  already in the composer tray. A 'chat' note belongs to the message. */
export function showsPaperclip({ origin, inTray }) {
  return origin === 'assets' && !inTray;
}

/** The tail of a close: attach when the rule says so. An attach failure never
 *  throws (the note is already saved): it goes to onError. */
export async function attachOnClose(d, x) {
  if (!shouldReattach(d.closeResult, d.attached, d.inTray, d.origin)) {
    return;
  }
  const r = await x.attach();
  if (!r?.ok) {
    x.onError(r);
  }
}

/** MOVE DRAFT TO A NOTE (spec D6, Owner's order: copy the draft into a new note
 *  and SAVE it; once that is verified, clear the draft and attach the note).
 *  The engine does the steps against the SERVER draft, so the composer is
 *  saved first. Failure leaves the composer text untouched, except clear-draft
 *  (the note is saved and attached; the draft stays).
 *  d: {client, text(), prepare(): Promise<boolean>, clear(), keep(), addTile(attachment, note), restoreTray()} */
export async function moveDraftToNote(d) {
  const text = d.text();
  const nothing = { ok: false, kind: 'err', message: "Couldn't move the draft. Nothing was changed." };
  if (!text.trim()) {
    return { ok: false, kind: 'err', message: 'Nothing to move yet.' };
  }
  if (!(await d.prepare())) {
    return nothing;
  }
  const r = await d.client.moveDraft();
  if (r.ok && r.body?.attachment && r.body?.note) {
    if (d.text() === text) {
      await d.clear(); // the composer and its local copy go empty and are not re-saved
    } else {
      d.keep(); // typed while it moved: that text is a draft again
    }
    d.addTile(r.body.attachment, r.body.note);
    return { ok: true, kind: 'info', message: 'Draft moved to a note', note: r.body.note, assetsPanel: r.body.assetsPanel };
  }
  if (r.body?.field === 'clear-draft') {
    await d.restoreTray?.(); // the attached note is in the scratchpad: show its tile
    return { ok: false, kind: 'err', saved: true, message: 'The note is saved and attached, but your draft was kept.' };
  }
  return nothing;
}

/** What a panel's {panel:'note', op, id?} asks of the host. Returns the
 *  {host:'note', ...} answer. x: {client, openEditor(id|null, from), attach(id),
 *  copy(Promise<string>), changed()} */
export async function handleNoteOp(d, x) {
  const op = d && typeof d.op === 'string' ? d.op : '';
  const id = d && typeof d.id === 'string' ? d.id : undefined;
  const say = (ok, error) => ({ host: 'note', op, ...(id ? { id } : {}), ok, ...(ok ? {} : { error }) });
  if (!NOTE_OPS.includes(op) || (op !== 'new' && !ID_RE.test(id ?? ''))) {
    return say(false, 'bad request');
  }
  if (op === 'new') {
    const r = await x.client.create('');
    if (!r.ok || !r.body?.note?.id) {
      return say(false, errText(r));
    }
    x.changed();
    x.openEditor(r.body.note.id, 'assets');
    return { host: 'note', op, id: r.body.note.id, ok: true };
  }
  if (op === 'edit') {
    x.openEditor(id, 'assets');
    return say(true);
  }
  if (op === 'copy') {
    const got = x.client.get(id).then((r) => {
      if (!r.ok || typeof r.body?.text !== 'string') {
        throw new Error(errText(r));
      }
      return r.body.text;
    });
    got.catch(() => {});
    const ok = await x.copy(got);
    return ok ? say(true) : say(false, 'could not copy');
  }
  const r = op === 'attach' ? await x.attach(id) : op === 'pin' || op === 'unpin' ? await x.client.pin(id, op === 'pin') : await x.client.archive(id, op === 'archive');
  if (!r.ok) {
    return say(false, errText(r));
  }
  if (op !== 'attach') {
    x.changed(); // attach() has told the panels itself
  }
  return say(true);
}

/* ====================================================================== */
/* ===================== the DOM half: nothing below runs at import ====== */
/* ====================================================================== */

const SVGNS = 'http://www.w3.org/2000/svg';
const X_PATH = '<path d="M5 5l14 14M19 5L5 19"/>';
/* full page / back (Owner 2026-10-02, room line [ref]): expand = four outward corners, collapse = four inward */
const EXPAND_PATH = '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>';
const COLLAPSE_PATH = '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>';
const CLIP_PATH = '<path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7L14 4.5a3.3 3.3 0 0 1 4.7 4.7L10 18a1.7 1.7 0 0 1-2.4-2.4L15 8"/>';
export const NOTE_PATH = '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>';

function icon(inner) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = inner; // a constant above
  return s;
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) {
    e.className = cls;
  }
  if (text !== undefined) {
    e.textContent = text;
  }
  return e;
}

/** Copy text; `text` may be a Promise (Safari keeps the click's permission for
 *  a ClipboardItem that resolves later). Insecure contexts fall back to a
 *  textarea. true when it was copied. */
export async function copyToClipboard(text) {
  try {
    if (globalThis.ClipboardItem && navigator.clipboard?.write) {
      const blob = Promise.resolve(text).then((t) => new Blob([t], { type: 'text/plain' }));
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      return true;
    }
  } catch {
    /* fall through to writeText */
  }
  let t;
  try {
    t = await text;
  } catch {
    return false;
  }
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/**
 * @param {{roomId: string, menuHost: {open: Function, close: Function},
 *   att: () => object|null, cells: () => object|null,
 *   chatHost: () => HTMLElement,
 *   draft: {text: () => string, prepare: () => Promise<boolean>, clear: () => void, keep: () => void},
 *   repaintLine: () => void, pickFile: () => void, client?: object}} o
 */
export function mountNotes(o) {
  const client = o.client ?? createNotesClient(o.roomId);
  let supported = null; // null = not known yet, false = this engine has no notes (404)
  let editor = null;
  let lineMsg = null; // {text, err}
  let lineTimer = 0;
  let moving = false;
  const closing = new Map(); // note id -> the promise of its close, so a reopen waits

  async function probe() {
    const r = await client.list();
    const was = supported;
    supported = r.status === 404 ? false : r.ok ? true : supported;
    if (supported !== was) {
      o.repaintLine(); // a restored long draft can wait on this answer
    }
    if (supported === true && o.addBtn) {
      o.addBtn.title = 'Attach a file or add a note'; // the + opens a menu now
      o.addBtn.setAttribute('aria-label', 'Attach a file or add a note');
    }
    return supported;
  }
  void probe();

  /* ---- the status line under the chat (room.js paintDeliveryLine) ---- */
  function say(text, err) {
    clearTimeout(lineTimer);
    lineMsg = { text, err: !!err };
    o.repaintLine();
    lineTimer = setTimeout(() => {
      lineMsg = null;
      o.repaintLine();
    }, err ? 6000 : 4000);
  }
  function toast(text, err) {
    /* the one toast (hub v2); Notes keeps its short life. Loaded on demand: this file's first half has no imports (node tests) */
    void import('/room-toast.mjs').then((m) => m.toast(text, { kind: err ? 'error' : 'info', ms: err ? 5000 : 2200 })).catch(() => {});
  }

  function changed() {
    o.cells()?.notesChanged?.();
  }

  async function attachNote(id) {
    const r = await client.attach(id);
    if (r.ok && r.body?.attachment) {
      o.att()?.putNote(r.body.attachment, r.body.note);
      changed();
    }
    return r;
  }

  /** The note's tile in the tray was restored after a reload: its title and
   *  word count come from the live note. */
  async function noteInfo(id) {
    const r = await client.get(id);
    if (r.ok && typeof r.body?.text === 'string') {
      o.att()?.noteMeta(id, { title: titleOf(r.body.text), words: wordCount(r.body.text) });
    }
  }

  /* ---- move the composer's draft to a note ---- */
  async function moveDraft(open) {
    if (moving || supported !== true) {
      return;
    }
    moving = true;
    o.repaintLine();
    let out;
    try {
      out = await moveDraftToNote({
        client,
        text: o.draft.text,
        prepare: o.draft.prepare,
        clear: o.draft.clear,
        keep: o.draft.keep,
        addTile: (a, n) => o.att()?.putNote(a, n),
        restoreTray: () => o.att()?.restore(),
      });
    } finally {
      moving = false;
    }
    say(out.message, !out.ok);
    if (out.ok || out.saved) {
      changed();
    }
    if (out.ok) {
      void o.att()?.panelAdded(out);
    }
    openAfterMove(out, open, (id) => void openEditor(id, 'chat')); // mid-writing: carry on in the note
  }

  /* ---- the composer's + menu ---- */
  function addMenu(anchor) {
    if (supported !== true) {
      void probe();
      return false; // an engine without notes: the + is the plain file picker
    }
    const r = anchor.getBoundingClientRect();
    const empty = !o.draft.text().trim();
    o.menuHost.open({
      row: anchor,
      label: 'Add to message',
      title: 'Add',
      point: { x: r.left, y: r.top },
      items: [
        { a: 'file', label: 'Attach a file', icon: 'clip' },
        { a: 'note', label: 'New note', icon: 'note' },
        { a: 'move', label: 'Move draft to a note', icon: 'move', off: empty, why: 'Write a message first' },
      ],
      choose(it) {
        o.menuHost.close(false);
        if (it.a === 'file') {
          o.pickFile();
        } else if (it.a === 'note') {
          void newNote('chat');
        } else {
          void moveDraft();
        }
      },
    });
    return true;
  }

  async function newNote(from) {
    const r = await client.create('');
    if (!r.ok || !r.body?.note?.id) {
      toast(`Couldn't start a note: ${errText(r)}`, true);
      return;
    }
    changed();
    void o.att()?.panelAdded(r.body);
    void openEditor(r.body.note.id, from);
  }

  /* ---- the editor ---- */
  /** from: 'chat' (the composer: on a phone the editor takes the message box's
   *  place) or 'assets' (on a phone, the whole screen). */
  async function openEditor(id, from) {
    if (editor) {
      if (editor.id === id) {
        return;
      }
      await closeEditor(editor);
    }
    await closing.get(id);
    const r = await client.get(id);
    if (!r.ok || typeof r.body?.text !== 'string') {
      toast(`Couldn't open the note: ${errText(r)}`, true);
      return;
    }
    mountEditor(id, r.body, from);
  }

  function mountEditor(id, note, from) {
    const phone = matchMedia(PHONE).matches;
    const startedFull = phone && from === 'assets';
    let full = startedFull; // mutable: opened from the chat, the phone toggles full page <-> chat layer
    const auto = createAutosave({
      roomId: o.roomId,
      id,
      client,
      text: note.text,
      onSaved: () => {
        ed.updatedAt = Date.now();
        paintAge();
        stateEl.classList.remove('err');
        stateEl.textContent = 'Saved';
        stateEl.classList.add('on');
        clearTimeout(ed.fade);
        ed.fade = setTimeout(() => stateEl.classList.remove('on'), 1600);
      },
      onError: (msg, status) => {
        clearTimeout(ed.fade);
        stateEl.classList.add('on', 'err');
        stateEl.textContent = status === 413 ? msg : status === 0 ? 'Offline: a copy is kept here' : `Not saved: ${msg}`;
      },
    });
    const ed = { id, from, auto, updatedAt: Number(note.updatedAt) || Date.now(), fade: 0, closing: null, opener: document.activeElement, phone, get full() { return full; }, get chat() { return phone && !full; } };
    editor = ed;

    const card = el('div', 'modal-card nt-card kb-capped');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', phone ? 'false' : 'true');
    card.setAttribute('aria-label', 'Note');
    const head = el('div', 'nt-h');
    const left = el('div', 'nt-hl');
    const ageEl = el('span', 'nt-age');
    const stateEl = el('span', 'nt-state');
    stateEl.setAttribute('role', 'status');
    left.append(ageEl, stateEl);
    const clip = el('button', 'nt-btn nt-clip');
    clip.type = 'button';
    clip.title = 'Attach to message';
    clip.setAttribute('aria-label', 'Attach to message');
    clip.append(icon(CLIP_PATH));
    const x = el('button', 'nt-btn nt-x');
    x.type = 'button';
    x.title = 'Close';
    x.setAttribute('aria-label', 'Close');
    x.append(icon(X_PATH));
    /* phone, opened from the CHAT only (Assets is already full): LEFT of the clip/x group,
       so the X never moves (Owner 2026-10-02, room line [ref]) */
    const fs = el('button', 'nt-btn nt-fs');
    fs.type = 'button';
    fs.hidden = !phone || startedFull;
    head.append(left, fs, clip, x);
    const ta = el('textarea', 'nt-ta');
    ta.setAttribute('aria-label', 'Note text');
    ta.spellcheck = true;
    ta.autocomplete = 'off';
    ta.value = note.text;
    const left0 = auto.leftover(); // an unconfirmed copy from a refresh or an outage: pick up where they left off
    if (left0 !== null) {
      ta.value = left0;
      auto.change(left0);
      void auto.save();
    }
    card.append(head, ta);

    function paintAge() {
      ageEl.textContent = `Note ${DOT} ${ageWord(ed.updatedAt)}`;
    }
    paintAge();
    /* the paperclip: Assets notes only, and not once the note is in the tray */
    clip.hidden = !showsPaperclip({ origin: from, inTray: !!o.att()?.hasNote(id) });

    let root;
    if (!phone) {
      root = el('div', 'nt-scrim');
      let downOnScrim = false;
      root.addEventListener('pointerdown', (e) => {
        downOnScrim = e.target === root;
      });
      root.addEventListener('click', (e) => {
        if (e.target === root && downOnScrim) {
          void closeEditor(ed); // a drag that ends outside the card is not a click away
        }
      });
      root.append(card);
      document.body.append(root);
    } else {
      root = card;
    }
    /* the phone layer: full page (body) or the chat's message-box layer (chatHost). Re-parenting
       keeps the textarea's text, caret and scroll (put back below); autosave never sees it. */
    const mount = () => {
      const h = document.documentElement.classList;
      card.classList.toggle('nt-full', full);
      card.classList.toggle('kb-capped', !full); // the full page is the visible box, never capped
      card.classList.toggle('nt-chat', !full);
      h.toggle('nt-open', full);
      h.toggle('nt-chat-open', !full); // hides every other control (room-notes.css)
      const keep = { a: ta.selectionStart, b: ta.selectionEnd, d: ta.selectionDirection, t: ta.scrollTop };
      (full ? document.body : o.chatHost()).append(card);
      ta.setSelectionRange(keep.a, keep.b, keep.d); // setSelectionRange never focuses
      ta.scrollTop = keep.t;
      card.style.top = '';
      fs.title = full ? 'Back to message box' : 'Full page';
      fs.setAttribute('aria-label', fs.title);
      fs.replaceChildren(icon(full ? COLLAPSE_PATH : EXPAND_PATH));
    };
    if (phone) {
      mount();
    }

    /* phone: sized to the VISUAL viewport so the keyboard never covers text */
    const vv = window.visualViewport;
    const size = () => {
      if (!phone) {
        return;
      }
      const h = vv?.height ?? innerHeight;
      if (full) {
        card.style.top = `${vv?.offsetTop ?? 0}px`;
        card.style.height = `${Math.round(h)}px`;
      } else {
        card.style.height = `${Math.round(h * 0.6)}px`;
      }
    };
    size();
    fs.addEventListener('click', () => {
      full = !full;
      mount();
      size();
    });
    vv?.addEventListener('resize', size);
    vv?.addEventListener('scroll', size);
    window.addEventListener('room-kb', size); // the tracker's own sync (frames + 1 s poll), for when iOS sends no vv event

    ta.addEventListener('input', () => auto.change(ta.value));
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        void closeEditor(ed);
      }
    };
    const onPageHide = () => auto.flush();
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        auto.flush();
      }
    };
    const onOnline = () => void auto.save();
    document.addEventListener('keydown', onKey);
    addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVis);
    addEventListener('online', onOnline);
    ed.teardown = () => {
      document.removeEventListener('keydown', onKey);
      removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVis);
      removeEventListener('online', onOnline);
      vv?.removeEventListener('resize', size);
      vv?.removeEventListener('scroll', size);
      window.removeEventListener('room-kb', size);
      clearTimeout(ed.fade);
      root.remove();
      document.documentElement.classList.remove('nt-open', 'nt-chat-open');
      if (!phone && ed.opener?.isConnected) {
        try {
          ed.opener.focus();
        } catch {
          /* gone */
        }
      }
      if (editor === ed) {
        editor = null;
      }
    };
    ed.busy = (v) => {
      fs.disabled = v;
      clip.disabled = v;
      x.disabled = v;
    };
    ed.say = (text, err) => {
      clearTimeout(ed.fade);
      stateEl.textContent = text;
      stateEl.classList.toggle('err', !!err);
      stateEl.classList.add('on');
    };
    x.addEventListener('click', () => void closeEditor(ed));
    clip.addEventListener('click', () => void paperclip(ed));
    /* PC only: never summon the keyboard on a touch device (the user taps in) */
    if (!phone && !matchMedia('(pointer: coarse)').matches) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }

  async function paperclip(ed) {
    ed.busy(true);
    await ed.auto.settle();
    const r = await attachNote(ed.id);
    if (!r.ok) {
      ed.busy(false);
      ed.say(r.status === 400 ? 'Nothing to attach yet' : `Couldn't attach: ${errText(r)}`, true);
      return;
    }
    await closeEditor(ed, true);
  }

  /** Close: the UI goes at once; the save, the index and (if it is attached)
   *  the re-attach finish behind it. A reopen of the same note waits for them. */
  function closeEditor(ed, attached = false) {
    if (ed.closing) {
      return ed.closing;
    }
    ed.teardown();
    ed.closing = (async () => {
      await ed.auto.settle(); // an outage leaves the local copy: nothing is lost
      const r = await client.close(ed.id);
      await attachOnClose(
        { closeResult: r, attached, inTray: !!o.att()?.hasNote(ed.id), origin: ed.from },
        { attach: () => attachNote(ed.id), onError: (e) => toast(`Couldn't attach the note: ${errText(e)}`, true) },
      ); // the tile holds the latest text (idempotent replace)
      changed();
    })();
    closing.set(ed.id, ed.closing);
    void ed.closing.then(() => {
      if (closing.get(ed.id) === ed.closing) {
        closing.delete(ed.id);
      }
    });
    return ed.closing;
  }

  /* ---- the "Move to a note" action on the status line (over the limit) ---- */
  function paintLimitAction(line, show) {
    if (!show || supported !== true) {
      return;
    }
    const b = el('button', 'rm-note-act', 'Move to a note');
    b.type = 'button';
    b.disabled = moving;
    b.addEventListener('click', () => void moveDraft(true));
    line.append(' ', b);
  }

  /* ---- the long-draft offer [ticket]: "Move to a note?" in the composer, not the status line ----
     With tiles in the tray it sits in the tray row after the last tile; without,
     it is its own row in the form above the input, left-aligned with the input
     (room-notes.css). One button, moved between the two homes. */
  const form = o.addBtn?.parentElement ?? null;
  const tray = form?.querySelector('.rm-tray') ?? null;
  let offer = null;
  function placeOffer() {
    if (!offer || !form) {
      return;
    }
    const inTray = !!tray?.querySelector('.att-tile');
    offer.classList.toggle('in-tray', inTray);
    if (inTray) {
      if (offer.parentNode !== tray || tray.lastElementChild !== offer) {
        tray.append(offer);
      }
    } else if (offer.parentNode !== form || offer.nextElementSibling !== o.addBtn) {
      form.insertBefore(offer, o.addBtn);
    }
  }
  if (tray && typeof MutationObserver === 'function') {
    new MutationObserver(placeOffer).observe(tray, { childList: true });
  }
  function paintOffer(show) {
    if (!form) {
      return;
    }
    if (!show || supported !== true) {
      if (offer) {
        offer.hidden = true;
      }
      return;
    }
    if (!offer) {
      offer = el('button', 'rm-note-offer', 'Move to a note?');
      offer.type = 'button';
      offer.addEventListener('click', () => void moveDraft(true));
    }
    offer.hidden = false;
    offer.disabled = moving;
    placeOffer();
  }

  return {
    supported: () => supported === true,
    paintOffer,
    probe,
    addMenu,
    newNote,
    moveDraft,
    noteInfo,
    openNote: (id, from = 'chat') => openEditor(id, from),
    /** put a note in the message as an attachment tile (the same attach the editor's paperclip uses) [note attach] */
    attachNote,
    isOpen: () => !!editor,
    line: () => lineMsg,
    /** a message went out: whatever this line said is no longer news */
    clearLine() {
      clearTimeout(lineTimer);
      if (lineMsg) {
        lineMsg = null;
        o.repaintLine();
      }
    },
    paintLimitAction,
    /** from room-cells.mjs: an app panel's {panel:'note', op, id?}; `reply` answers on its port */
    async panelOp(d, reply) {
      reply(
        await handleNoteOp(d, {
          client,
          openEditor: (id, from) => void openEditor(id, from),
          attach: attachNote,
          copy: copyToClipboard,
          changed,
        }),
      );
    },
  };
}
