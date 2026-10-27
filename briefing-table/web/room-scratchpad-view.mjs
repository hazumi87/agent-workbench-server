/* THE SCRATCHPAD IN THE PREVIEW COLUMN [scratchpad] (the design system BUILD-HANDOFF 1.C, V2.1; Owner 2026-10-07).
 *
 *   LIST   title "Scratchpad · Assets · 3 new of 43". A top row: an Assets | Notes switch (each with its new count) and "+ Add" / "+ New note".
 *          "New · N" first, then "Earlier · N" with "Show N more". ASSETS: a 3-column grid of square thumbnails (the full image, cropped
 *          square with object-fit: cover, lazy; a file that is not an image is a tile with its extension), the name and "@who · when" under
 *          each, a teal dot on a new one. NOTES: a note has NO TITLE; a card is "@who · 8m ago", the first lines of its text (up to 3), then its
 *          tags as small chips (none = no chip row, no placeholder); a teal dot on a new one.
 *   ITEM   opens in the SAME column (a phone: the same full-screen layer), never a new window. A trail under the header, "‹ Assets · 2 new of
 *          43", goes back to the list. An asset: the image (click = large), name, "@who · when · type · size", Add to message (primary: puts
 *          `[asset: name]` in the message box), Download, Copy link; then "Came from" (hidden, label and all, until the row carries the line
 *          id). A note: "Note · @who · 8m ago", the tags, the full text, Add to message (`[note: @who, 8m ago]`), Edit. A pager "‹ 2 of 43 ›"
 *          steps through the list in its order.
 *
 * WHAT THE ENGINE DOES NOT SAY YET, and what this does about it (each one is a field, so the day it arrives nothing here changes):
 *   - note author / excerpt / total (`/notes?summary=1`, coming): until then the text is fetched per note and "@who" is left out;
 *   - the seen-state ("N new", the dot): the engine's `seen: false` on a list item, `POST .../scratchpad/seen` when an item opens, and its
 *     counts (`o.counts()`); an engine without it has no `seen` field, so nothing is new;
 *   - the asset's message id (`lineId`; null on the older assets): "Came from" shows only when it is there;
 *   - asset rename / move / remove: the ⋯ button shows only on an engine that has them (`lineId` on the row says so). */
import { copyToClipboard } from '/room-notes.mjs';
import { fromEngineCounts } from '/room-scratchpad.mjs';
import { openGallery } from '/room-lightbox-nav.mjs';
import { titleOf } from '/scratchpad-title.mjs';

const PAGE = 12; // the NOTES list: "Earlier" shows this many, then "Show N more"
const ROWS = 4; // the ASSETS grid shows four rows (12 tiles in three columns, 8 in two), counted across the whole list, then "Show N more" for the rest
const NOTE_LINES = 3;

export function agoShort(ts, now = Date.now()) {
  const m = Math.max(1, Math.round((now - ts) / 60000));
  if (m < 60) {
    return `${m}m ago`;
  }
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
export function sizeText(bytes) {
  if (!Number.isFinite(bytes)) {
    return '';
  }
  if (bytes >= 1048576) {
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
}
/** The first lines of a note's text, for a card: at most `n` non-empty lines. */
export function firstLines(text, n = NOTE_LINES) {
  return String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, n).join('\n');
}
export { titleOf };

/** `[note: <id> · @who, 8m ago]`: the id is what the engine looks up (it hands an agent the note's text); the label after it is for people. */
export function noteRef(n) {
  const label = [n.author ? `@${n.author}` : null, agoShort(n.updatedAt ?? n.createdAt)].filter(Boolean).join(', ');
  return `[note: ${n.id}${label ? ` · ${label}` : ''}]`;
}

function mk(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) {
    n.className = cls;
  }
  if (text !== undefined) {
    n.textContent = text;
  }
  return n;
}
const isImage = (a) => a.kind === 'image' || /^image\//.test(a.type || '');
const extOf = (name) => (String(name).includes('.') ? String(name).split('.').pop().slice(0, 4).toUpperCase() : 'FILE');

/**
 * @param {{ roomId: string, api: (p: string, init?: object) => Promise<{ok: boolean, status: number, body: any}>, preview: object, counts?: () => object,
 *           notes: () => object|null, compose: (text: string) => void, lightbox: () => HTMLElement|null,
 *           scrollToLine?: (id: number) => void, family?: () => {id: string, name: string}[], isNew?: (kind: string, item: object) => boolean, markSeen?: (kind: string, item: object) => void,
 *           onCounts?: (c: object) => void, phone?: () => boolean }} o
 */
export function createScratchView(o) {
  const base = `/api/rooms/${encodeURIComponent(o.roomId)}`;
  const data = { assets: null, notes: null };
  /** how many notes the list actually holds, for the header (assets are never windowed, so none) */
  const shownOf = (kind) => (kind === 'notes' ? data.notes?.length : undefined);
  const noteText = new Map(); // id -> {updatedAt, text}
  const state = { kind: 'assets', shown: PAGE, all: false, item: null, loading: false, error: null };
  let alive = false;
  let host = null;
  let fileInput = null;

  /* NEW = the engine says this person has not seen it (`seen: false`, from the first visit on); absent = not new */
  const isNew = (k, it) => (o.isNew ? !!o.isNew(k, it) : it.seen === false);

  /* ---------- data ---------- */
  async function loadAssets() {
    const r = await o.api(`${base}/assets`);
    if (r.ok && Array.isArray(r.body?.assets)) {
      data.assets = [...r.body.assets].sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
      return true;
    }
    state.error = r.body?.error ?? `HTTP ${r.status}`;
    return false;
  }
  async function loadNotes() {
    const r = await o.api(`${base}/notes?summary=1`);
    if (!(r.ok && Array.isArray(r.body?.notes))) {
      state.error = r.body?.error ?? `HTTP ${r.status}`;
      return false;
    }
    const list = [...r.body.notes].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    data.notes = list;
    data.notesTotal = Number.isFinite(r.body.total) ? r.body.total : list.length;
    /* a card needs TEXT (the design system: a card with no text is worse than no card): the engine's excerpt when it sends one, else the note itself */
    await Promise.all(list.map(async (n) => {
      if (typeof n.excerpt === 'string') {
        noteText.set(n.id, { updatedAt: n.updatedAt, text: n.excerpt });
        return;
      }
      const have = noteText.get(n.id);
      if (have && have.updatedAt === n.updatedAt) {
        return;
      }
      const g = await o.api(`${base}/notes/${encodeURIComponent(n.id)}`);
      if (g.ok && typeof g.body?.text === 'string') {
        noteText.set(n.id, { updatedAt: n.updatedAt, text: g.body.text });
      }
    }));
    return true;
  }
  const sig = () => JSON.stringify([data.assets, data.notes, [...noteText.entries()]]);
  const counts = () => {
    const out = {};
    const engine = o.counts?.();
    for (const k of ['assets', 'notes']) {
      const list = data[k];
      if (list) {
        const derived = { n: list.filter((x) => isNew(k, x)).length, m: k === 'notes' ? data.notesTotal ?? list.length : list.length };
        /* the engine's counts win when it sent them (the notes list is a window, the total is the room's) */
        out[k] = engine?.[k] && Number.isFinite(engine[k].m) ? { n: engine[k].n, m: engine[k].m } : derived;
      }
    }
    return out;
  };
  async function refresh() {
    if (!alive) {
      return;
    }
    state.error = null;
    const before = sig();
    await Promise.all([loadAssets(), loadNotes()]);
    o.onCounts?.(counts());
    if (alive && (sig() !== before || state.error)) {
      paint(); // only when something changed: a poll must not re-draw a list under the person's finger
    }
  }

  /* ---------- the list in display order: New first, then Earlier ---------- */
  function ordered(kind) {
    const list = data[kind] ?? [];
    const fresh = list.filter((x) => isNew(kind, x));
    const earlier = list.filter((x) => !isNew(kind, x));
    return { fresh, earlier, all: [...fresh, ...earlier] };
  }
  const keyOf = (kind, it) => (kind === 'assets' ? it.name : it.id);

  /* ---------- painting ---------- */
  function open(kind) {
    alive = true;
    state.kind = kind;
    state.shown = PAGE;
    state.all = false;
    state.item = null;
    paint();
    void refresh();
  }
  const isOpen = () => alive && o.preview.current()?.owner === 'scratchpad';

  function paint() {
    if (!alive) {
      return;
    }
    const kind = state.kind;
    const c = counts()[kind] ?? { n: 0, m: data[kind]?.length ?? 0 };
    const body = mk('div', 'sp');
    if (state.item) {
      paintItem(body, kind);
      return;
    }
    body.append(topRow(kind, counts()));
    if (!data[kind]) {
      body.append(mk('p', 'sp-empty', state.error ? `Could not load: ${state.error}` : 'Loading…'));
    } else if (kind === 'assets') {
      paintAssets(body);
    } else {
      paintNotes(body);
    }
    host = body;
    /* the list is a VIEW the column can return to: an item replaces it as foreign content, and ‹ / ✕ / Esc then step back to the list
       before they close the column (item -> list -> the room, the design system 1.C) */
    o.preview.open({
      owner: 'scratchpad', key: kind, type: 'Scratchpad', name: titleOf(kind, c.n, c.m, shownOf(kind)), body,
      view: { node: body, label: titleOf(kind, c.n, c.m, shownOf(kind)), restore: () => { state.item = null; paint(); return true; } },
    });
  }

  function topRow(kind, cs) {
    const row = mk('div', 'sp-top');
    const seg = mk('div', 'sp-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Scratchpad');
    for (const k of ['assets', 'notes']) {
      const b = mk('button', 'sp-segb');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(k === kind));
      b.append(k === 'assets' ? 'Assets' : 'Notes');
      const n = cs[k]?.n ?? 0;
      if (n > 0) {
        b.append(mk('span', 'sp-segn', String(n)));
      }
      b.addEventListener('click', () => {
        if (k !== state.kind) {
          open(k);
        }
      });
      seg.append(b);
    }
    const add = mk('button', 'sp-add', kind === 'assets' ? '+ Add' : '+ New note');
    add.type = 'button';
    add.addEventListener('click', () => (kind === 'assets' ? pickFiles() : void o.notes()?.newNote('assets')));
    row.append(seg, add);
    return row;
  }

  function group(body, label, items, render, grid) {
    if (!items.length) {
      return;
    }
    body.append(mk('h5', 'sp-gh', label));
    const wrap = mk('div', grid ? 'sp-grid' : 'sp-cards');
    for (const it of items) {
      wrap.append(render(it));
    }
    body.append(wrap);
  }

  /** Columns now: three while the column is 344px or wider, else two (the same rule as the stylesheet's container query on the column). */
  const colsNow = () => ((o.preview.el?.clientWidth ?? 370) >= 343 ? 3 : 2);
  let lastCols = 0;
  function paintAssets(body) {
    const { fresh, earlier } = ordered('assets');
    if (!fresh.length && !earlier.length) {
      body.append(mk('p', 'sp-empty', 'No files yet. + Add puts one here.'));
      return;
    }
    const cols = colsNow();
    lastCols = cols;
    /* FOUR ROWS across the whole list: "New" is never cut, "Earlier" takes the rows left of the four (at least one) */
    const freshRows = Math.ceil(fresh.length / cols);
    const earlierRows = Math.max(1, ROWS - freshRows);
    group(body, `New · ${fresh.length}`, fresh, (a) => tile(a, true), true);
    const shown = state.all ? earlier : earlier.slice(0, earlierRows * cols);
    group(body, `Earlier · ${earlier.length}`, shown, (a) => tile(a, false), true);
    const left = earlier.length - shown.length;
    if (left > 0) {
      const b = mk('button', 'sp-more', `Show ${left} more`); // everything still hidden, in one go
      b.type = 'button';
      b.addEventListener('click', () => {
        state.all = true;
        paint();
      });
      body.append(b);
    }
  }
  function more(body, left) {
    if (left > 0) {
      const b = mk('button', 'sp-more', `Show ${Math.min(left, PAGE)} more`);
      b.type = 'button';
      b.addEventListener('click', () => {
        state.shown += PAGE;
        paint();
      });
      body.append(b);
    }
  }
  function tile(a, fresh) {
    const b = mk('button', 'sp-tile');
    b.type = 'button';
    b.dataset.name = a.name;
    const th = mk('span', 'sp-th');
    if (isImage(a)) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      /* the engine's thumbnail (`/assets/thumb/<name>?w=`, cached webp) when it has the route (it says so with `lineId` on the row); the
         full image otherwise, and a file tile when even that will not load. object-fit: cover keeps the grid even either way. */
      const thumb = 'lineId' in a ? `${base}/assets/thumb/${encodeURIComponent(a.name)}?w=256` : null;
      img.src = thumb ?? a.raw;
      img.addEventListener('error', () => {
        if (thumb && img.getAttribute('src') === thumb) {
          img.src = a.raw;
        } else {
          img.remove();
          th.classList.add('is-file');
          th.prepend(mk('span', 'sp-ext', extOf(a.name)));
        }
      });
      th.append(img);
    } else {
      th.classList.add('is-file');
      th.append(mk('span', 'sp-ext', extOf(a.name)));
    }
    if (fresh) {
      th.append(mk('span', 'sp-dot'));
    }
    const nm = mk('span', 'sp-nm', a.name);
    const mt = mk('span', 'sp-mt', [a.addedBy ? `@${asMe(a.addedBy)}` : null, agoShort(a.addedAt)].filter(Boolean).join(' · '));
    b.append(th, nm, mt);
    b.addEventListener('click', () => openItem('assets', a));
    return b;
  }

  function paintNotes(body) {
    const { fresh, earlier } = ordered('notes');
    if (!fresh.length && !earlier.length) {
      body.append(mk('p', 'sp-empty', 'No notes yet. + New note starts one.'));
      return;
    }
    group(body, `New · ${fresh.length}`, fresh, (n) => card(n, true), false);
    const shown = earlier.slice(0, state.shown);
    group(body, `Earlier · ${earlier.length}`, shown, (n) => card(n, false), false);
    more(body, earlier.length - shown.length);
  }
  /* YOUR OWN things read "@me" (the design system, 2026-10-08): "@user" is a role name and the person's own handle is theirs to see on others' items */
  const asMe = (h) => (h && (h === 'user' || h === o.me?.()) ? 'me' : h);
  const whoAgo = (n) => [n.author ? `@${asMe(n.author)}` : null, agoShort(n.updatedAt ?? n.createdAt)].filter(Boolean).join(' · ');
  function card(n, fresh) {
    const b = mk('button', 'sp-note');
    b.type = 'button';
    b.dataset.id = n.id;
    const h = mk('span', 'sp-nh', whoAgo(n));
    if (fresh) {
      h.prepend(mk('span', 'sp-dot'));
    }
    const text = firstLines(noteText.get(n.id)?.text ?? '');
    b.append(h, mk('span', 'sp-nt', text || '(empty note)'));
    const tags = Array.isArray(n.keywords) ? n.keywords.filter((t) => typeof t === 'string' && t) : [];
    if (tags.length) {
      const row = mk('span', 'sp-tags');
      for (const t of tags.slice(0, 6)) {
        row.append(mk('span', 'sp-tag', t));
      }
      b.append(row);
    }
    b.addEventListener('click', () => openItem('notes', n));
    return b;
  }

  /* ---------- upload ---------- */
  /** one path for the + Add dialog, a paste and a drop: each file is POSTed to the room's assets, then the list refreshes */
  async function upload(files) {
    for (const f of files) {
      try {
        const r = await fetch(`${base}/assets`, {
          method: 'POST',
          headers: { 'content-type': f.type || 'application/octet-stream', 'x-filename': encodeURIComponent(f.name || 'file') },
          body: f,
          credentials: 'same-origin',
        });
        if (!r.ok) {
          let why = null;
          try { why = (await r.json())?.error; } catch { /* not json */ }
          state.error = why ?? `HTTP ${r.status}`;
        }
      } catch (e) {
        state.error = e?.message ?? String(e);
      }
    }
    void refresh();
  }
  /* PASTE and DROP, which the Assets app did before it moved into the column. Paste goes here only when nothing else owns it: a
     paste into the message box stays the message's (its own tile), and a paste into a text field keeps its text. A pasted image
     has no name, so it gets one. */
  const named = (f) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${(f.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '')}`, { type: f.type }));
  const mine = () => isOpen() && state.kind === 'assets';
  document.addEventListener('paste', (ev) => {
    if (!mine()) {
      return;
    }
    const at = ev.target;
    const inColumn = !!o.preview.el?.contains?.(at);
    const free = at === document.body || at === document.documentElement || !at?.closest?.('input, textarea, [contenteditable="true"], [contenteditable=""]');
    if (!(inColumn || at === document.body) || !free) {
      return;
    }
    const files = [...(ev.clipboardData?.files ?? [])];
    if (!files.length) {
      return;
    }
    ev.preventDefault();
    void upload(files.map(named));
  });
  const hasFiles = (ev) => [...(ev.dataTransfer?.types ?? [])].includes('Files');
  o.preview.el?.addEventListener('dragover', (ev) => {
    if (mine() && hasFiles(ev)) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
    }
  });
  o.preview.el?.addEventListener('drop', (ev) => {
    if (mine() && hasFiles(ev)) {
      ev.preventDefault();
      void upload([...ev.dataTransfer.files]);
    }
  });
  function pickFiles() {
    if (!fileInput) {
      fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.multiple = true;
      fileInput.hidden = true;
      document.body.append(fileInput);
      fileInput.addEventListener('change', async () => {
        const files = [...fileInput.files];
        fileInput.value = '';
        await upload(files);
      });
    }
    fileInput.click();
  }

  /* ---------- one item ---------- */
  function openItem(kind, it) {
    state.kind = kind;
    state.item = { kind, key: keyOf(kind, it) };
    paint();
    void markSeen(kind, it); // opening a new item marks it seen: its dot goes and every count drops by one
  }
  async function markSeen(kind, it) {
    if (it.seen !== false) {
      return;
    }
    it.seen = true; // at once: the dot goes with the tap
    try {
      const r = await o.api(`${base}/scratchpad/seen`, { json: { kind: kind === 'assets' ? 'asset' : 'note', ids: [kind === 'assets' ? it.path : it.id] } });
      if (r.ok && r.body?.counts) {
        o.onCounts?.(fromEngineCounts(r.body.counts));
      } else {
        it.seen = false; // not marked: it is still new, say so
      }
    } catch {
      it.seen = false;
    }
    if (alive) {
      paint();
    }
  }
  function paintItem(body, kind) {
    const list = ordered(kind).all;
    const i = list.findIndex((x) => keyOf(kind, x) === state.item.key);
    if (i < 0) {
      state.item = null; // it is gone (removed, or the list moved on)
      paint();
      return;
    }
    const it = list[i];
    const cs = counts()[kind] ?? { n: 0, m: list.length };
    const trail = titleOf(kind, cs.n, cs.m, shownOf(kind));
    if (kind === 'assets') {
      assetBody(body, it);
    } else {
      noteBody(body, it);
    }
    body.append(pager(kind, list, i));
    host = body;
    o.preview.open({
      owner: 'scratchpad',
      key: kind,
      type: 'Scratchpad',
      name: kind === 'assets' ? it.name : `Note \u00b7 ${whoAgo(it)}`,
      body,
      foreign: true, // the list under it goes on the column's return stack: ✕ / ‹ / Esc step back to it
      back: { label: `\u2039 ${trail}`, go: () => o.preview.dismiss() }, // the same step as ‹ / ✕ / Esc: pops the list off the return stack and repaints it
    });
  }

  function actionsRow(items) {
    const row = mk('div', 'sp-acts');
    for (const a of items) {
      const b = mk('button', `sp-act${a.primary ? ' pri' : ''}`, a.label);
      b.type = 'button';
      b.addEventListener('click', a.run);
      row.append(b);
    }
    return row;
  }
  const addToMessage = (text) => () => {
    o.compose(text);
    if (o.phone?.()) {
      o.preview.close(); // the box is behind the layer
    }
  };
  /** "Add to message" on a NOTE [note attach] (Owner [ref]): the note joins the message as an attachment tile, the same attach the
   *  editor's paperclip does, so sending makes it a sent note shown with its title and word count. Only an engine that cannot attach
   *  falls back to the old text pointer. A note never attached or sent is left as it was. */
  async function attachNoteToMessage(n) {
    const r = await o.notes()?.attachNote?.(n.id);
    if (r && r.ok) {
      if (o.phone?.()) {
        o.preview.close(); // the box is behind the layer
      }
      return;
    }
    addToMessage(noteRef(n))();
  }
  async function copyLink(url, btn) {
    const ok = await copyToClipboard(new URL(url, location.href).href);
    const was = btn.textContent;
    btn.textContent = ok ? 'Copied' : 'Could not copy';
    setTimeout(() => { btn.textContent = was; }, 1500);
  }

  function assetBody(body, a) {
    if (isImage(a)) {
      const big = mk('button', 'sp-big');
      big.type = 'button';
      big.setAttribute('aria-label', `Open ${a.name} large`);
      const img = document.createElement('img');
      img.alt = a.name;
      img.src = a.raw;
      big.append(img);
      big.addEventListener('click', () => openLarge(a, big));
      body.append(big);
    } else {
      const f = mk('div', 'sp-big is-file');
      f.append(mk('span', 'sp-ext', extOf(a.name)));
      body.append(f);
    }
    const nameRow = mk('div', 'sp-namerow');
    nameRow.append(mk('div', 'sp-iname', a.name));
    /* ⋯ at the right end of the name line, its menu opening downward from there, right-aligned; only where an item verb exists (the engine
       says so with `lineId` on the row): an empty menu is worse than none */
    if ('lineId' in a) {
      nameRow.append(dotsMenu(a));
    }
    body.append(nameRow);
    body.append(mk('div', 'sp-imeta', [a.addedBy ? `@${asMe(a.addedBy)}` : null, agoShort(a.addedAt), a.type || a.kind, sizeText(a.size)].filter(Boolean).join(' · ')));
    const row = actionsRow([
      { label: 'Add to message', primary: true, run: addToMessage(`[asset: ${a.name}]`) },
      { label: 'Download', run: () => download(a) },
      { label: 'Copy link', run: (e) => void copyLink(a.url || a.raw, e.currentTarget) },
    ]);
    body.append(row);
    const from = a.lineId ?? a.entry_id ?? null; // the line that added it (null for the older assets: no block at all)
    if (from !== null && from !== undefined && o.scrollToLine) {
      const cf = mk('div', 'sp-from');
      cf.append(mk('h5', 'sp-gh', 'Came from'));
      const go = mk('button', 'sp-link', 'Go to the message ›');
      go.type = 'button';
      go.addEventListener('click', () => {
        if (o.phone?.()) {
          o.preview.close();
        }
        o.scrollToLine(Number(from));
      });
      cf.append(go);
      body.append(cf);
    }
  }
  /* ---------- ⋯: rename, move to another room of the family, remove (person-only routes; the file is moved aside, never deleted) ---------- */
  function dotsMenu(a) {
    const wrap = mk('span', 'sp-dotswrap');
    const btn = mk('button', 'sp-dots', '⋯');
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-label', `More for ${a.name}`);
    const pop = mk('div', 'sp-menu');
    pop.hidden = true;
    pop.setAttribute('role', 'menu');
    const item = (label, run) => {
      const b = mk('button', 'sp-mi', label);
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.addEventListener('click', run);
      return b;
    };
    const url = `${base}/assets/item/${encodeURIComponent(a.name)}`;
    const msg = mk('p', 'sp-menumsg');
    msg.hidden = true;
    async function run(method, json) {
      msg.hidden = false;
      msg.textContent = 'Working…';
      const r = await o.api(url, json === undefined ? { method } : { method, json });
      if (!r.ok) {
        msg.textContent = `Not done: ${r.body?.error ?? `HTTP ${r.status}`}`;
        return;
      }
      pop.hidden = true;
      state.item = null;
      await refresh();
      o.preview.dismiss(); // back to the list (a list that no longer has it)
    }
    const home = () => {
      pop.replaceChildren(
        item('Rename…', () => {
          const inp = mk('input', 'sp-input');
          inp.value = a.name;
          inp.setAttribute('aria-label', 'New name');
          const go = mk('button', 'sp-act pri', 'Rename');
          go.type = 'button';
          go.addEventListener('click', () => { if (inp.value.trim() && inp.value.trim() !== a.name) { void run('PATCH', { name: inp.value.trim() }); } });
          const back = mk('button', 'sp-act', 'Cancel');
          back.type = 'button';
          back.addEventListener('click', home);
          const row = mk('div', 'sp-acts');
          row.append(go, back);
          pop.replaceChildren(inp, row, msg);
          inp.focus();
        }),
        item('Move to…', () => {
          const targets = o.family?.() ?? [];
          pop.replaceChildren(mk('p', 'sp-menumsg', targets.length ? 'Move to' : 'No other room in this family'));
          for (const t of targets) {
            pop.append(item(t.name, () => void run('PATCH', { room: t.id })));
          }
          pop.append(item('Cancel', home), msg);
        }),
        item('Remove…', () => {
          const go = mk('button', 'sp-act pri', 'Remove');
          go.type = 'button';
          go.addEventListener('click', () => void run('DELETE'));
          const back = mk('button', 'sp-act', 'Cancel');
          back.type = 'button';
          back.addEventListener('click', home);
          const row = mk('div', 'sp-acts');
          row.append(go, back);
          pop.replaceChildren(mk('p', 'sp-menumsg', `Remove ${a.name}? It is kept aside, not deleted.`), row, msg);
        }),
        msg,
      );
      msg.hidden = true;
    };
    btn.addEventListener('click', () => {
      if (pop.hidden) {
        home();
        pop.hidden = false;
        pop.style.left = 'auto';
        pop.style.right = '0'; // downward from the name line, right-aligned
      } else {
        pop.hidden = true;
      }
    });
    wrap.append(btn, pop);
    return wrap;
  }

  function download(a) {
    const l = document.createElement('a');
    l.href = a.raw;
    l.download = a.name;
    l.rel = 'noopener';
    document.body.append(l);
    l.click();
    l.remove();
  }
  function openLarge(a, opener) {
    const lb = o.lightbox?.();
    const bd = lb?.querySelector('#lbBody');
    const cap = lb?.querySelector('#lbCap');
    if (!lb || !bd || !cap) {
      window.open(a.raw, '_blank', 'noopener');
      return;
    }
    /* the pager's own set (every image in the list, in its order): ‹ › / arrow keys / mouse side buttons step through it [[ref]] */
    const set = ordered('assets').all.filter(isImage);
    const at = set.findIndex((x) => x.name === a.name);
    openGallery(lb, at < 0 ? [{ src: a.raw, name: a.name }] : set.map((x) => ({ src: x.raw, name: x.name })), Math.max(0, at));
    const mo = new MutationObserver(() => {
      if (lb.hidden) {
        mo.disconnect();
        if (opener.isConnected) {
          opener.focus({ preventScroll: true });
        }
      }
    });
    mo.observe(lb, { attributes: true, attributeFilter: ['hidden'] });
  }

  function noteBody(body, n) {
    body.append(mk('div', 'sp-imeta', `${whoAgo(n)} · anyone in the room can edit`));
    const tags = Array.isArray(n.keywords) ? n.keywords.filter((t) => typeof t === 'string' && t) : [];
    if (tags.length) {
      const row = mk('div', 'sp-tags');
      for (const t of tags) {
        row.append(mk('span', 'sp-tag', t));
      }
      body.append(row);
    }
    const text = mk('div', 'sp-ntext');
    text.textContent = noteText.get(n.id)?.text ?? '';
    body.append(text);
    body.append(actionsRow([
      { label: 'Add to message', primary: true, run: () => void attachNoteToMessage(n) },
      { label: 'Edit', run: () => o.notes()?.openNote(n.id, 'assets') },
    ]));
  }

  function pager(kind, list, i) {
    const p = mk('div', 'sp-pager');
    const prev = mk('button', 'sp-pg', '‹');
    prev.type = 'button';
    prev.setAttribute('aria-label', 'Previous');
    prev.disabled = i <= 0;
    const next = mk('button', 'sp-pg', '›');
    next.type = 'button';
    next.setAttribute('aria-label', 'Next');
    next.disabled = i >= list.length - 1;
    const go = (j) => () => openItem(kind, list[j]);
    prev.addEventListener('click', go(i - 1));
    next.addEventListener('click', go(i + 1));
    p.append(prev, mk('span', 'sp-pn', `${i + 1} of ${list.length}`), next);
    return p;
  }

  /* a resize or a drag that changes the column count re-counts the four rows: no half-empty last row */
  if (o.preview.el && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      if (alive && !state.item && state.kind === 'assets' && lastCols && colsNow() !== lastCols) {
        paint();
      }
    }).observe(o.preview.el);
  }

  return {
    open,
    refresh,
    isOpen,
    close() { alive = false; state.item = null; },
    /** the preview closed or moved to another owner: stop repainting */
    released() { alive = false; },
    counts,
    data: () => data,
    host: () => host,
  };
}
