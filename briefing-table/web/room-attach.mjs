/* ROOM COMPOSER ATTACHMENTS [ticket] (the design system room-attach-v1, Owner 2026-09-28).
 *
 * THE DRAFT TRAY: a + LEFT of the input (the OS picker, multiple), paste of
 * file/image data, and a drop anywhere on the line column all add files.
 * Each is uploaded at once to the person's SERVER scratchpad for this room
 * (GET/POST .../scratch, DELETE .../scratch/<id>), so the tray survives an F5,
 * a device switch or an outage, like the text draft. Nothing reaches the
 * room's assets until SEND (room.js posts the ids with the line).
 *
 * Send is disabled while anything is uploading or has failed (a message never
 * goes out missing a file the person thinks is attached). Text only: every
 * name is textContent, every image src is a route this page builds itself.
 *
 * THE SENT LINE: `sentView` draws a message's files under its text (images up
 * to 3, then a 4th with a "+N" scrim; a single image larger and uncropped;
 * files as chips), never the raw references agents get.
 */

const X_SVG = '<path d="M2 2l6 6M8 2l-6 6"/>';
const RETRY_SVG = '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>';
const SVGNS = 'http://www.w3.org/2000/svg';
const NOTE_SVG = '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>'; // the room's note icon (room-notes.mjs)
const NOTE_FILE = /^note-[a-f0-9]{12}[.]txt$/;
const DOT = String.fromCharCode(183);

function svg(viewBox, inner) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = inner; // a constant
  return s;
}

/** 312 KB, 1.2 MB, 840 B (the engine's own formatting, room-attach.ts). */
export function fmtSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** The mono extension on a file's type tile: PDF, ZIP, MOV (at most 4). */
export function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  return m ? m[1].toUpperCase().slice(0, 4) : 'FILE';
}

const isImage = (type) => typeof type === 'string' && type.startsWith('image/');

function typeTile(name, cls = 'att-type') {
  const t = document.createElement('span');
  t.className = cls;
  t.textContent = extOf(name);
  return t;
}

function nameBlock(name, sub) {
  const fn = document.createElement('span');
  fn.className = 'att-fn';
  const n = document.createElement('span');
  n.className = 'n';
  n.textContent = name;
  const s = document.createElement('span');
  s.className = 's';
  s.textContent = sub;
  fn.append(n, s);
  return fn;
}

/** "Note . 1,240 words" (the words arrive once the live note is read). */
function noteSub(n) {
  return Number.isFinite(n.words) ? `Note ${DOT} ${n.words.toLocaleString('en-US')} ${n.words === 1 ? 'word' : 'words'}` : 'Note';
}

/* ---- DRAG TO REORDER, the pure part (Owner 2026-10-04, room) ---- */

/** Where the dragged tile (originally at index `from`) would land: the number of OTHER tiles whose
 *  original centers lie left of the dragged tile's center `x`. `centers` is every tile's original center. */
export function sortTarget(centers, from, x) {
  let to = 0;
  centers.forEach((c, j) => {
    if (j !== from && c < x) {
      to++;
    }
  });
  return to;
}

/** Which way tile `j` moves to open the gap while `from` is dragged over slot `to`: +1 right, -1 left, 0 stays. */
export function shiftOf(j, from, to) {
  if (j < from && j >= to) {
    return 1;
  }
  if (j > from && j <= to) {
    return -1;
  }
  return 0;
}

/** A copy of `list` with the item at `from` moved to index `to` (the renumbering is the new index). */
export function moveItem(list, from, to) {
  const out = list.slice();
  if (from === to || from < 0 || from >= out.length) {
    return out;
  }
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, x);
  return out;
}

const HOLD_MS = 300; // press-and-hold before a tile lifts
const HOLD_SLOP = 8; // px of movement that means "scrolling, not holding"
const LIFT_PX = 5;

/* ------------------------------------------------------------ the tray ---- */

/**
 * Everything room.js hands over (its hooks stay thin: mount, restore, busy,
 * canSend, ids, sent, decorate).
 * @param {{roomId: string, api: Function, input: HTMLTextAreaElement,
 *          sendBtn: HTMLButtonElement, tray: HTMLElement, note: HTMLElement,
 *          addBtn: HTMLElement, fileInput: HTMLInputElement, dropZone: HTMLElement,
 *          preview: () => object|null, cells: () => object|null,
 *          docView?: (f: object) => {body: Node, tools: Node}|null,
 *            (room-doc-view: a markdown/text/note file opens as a document;
 *            null = the file preview below),
 *          isPhone: () => boolean, openApp: (panelId: string) => void,
 *          refresh: () => Promise<unknown>}} o
 */
export function mountAttach(o) {
  const base = `/api/rooms/${encodeURIComponent(o.roomId)}/scratch`;
  const items = []; // {key, file, id, name, type, size, status: up|ok|fail, p, reason, thumb, xhr, el}
  let seq = 0;
  let max = { bytes: 25 * 1024 * 1024, count: 10 };
  let assetsPanel = true; // until the engine says otherwise: never a false "adds a panel"
  let capNote = '';
  let busy = false; // a line POST is in flight
  let overChar = false; // room.js: the composer text is over the 4000-char send cap [ticket]
  let lastPos = 0; // the tray position of the newest file added on this page
  /* THE LEAD SLOT (room-reply-v1): one element another module owns — the
     reply's quote chip — kept FIRST in the tray, ahead of every file. The tray
     shows while it holds either. */
  let lead = null;

  /* A REMOVED TILE NEVER COMES BACK. Each upload carries a random
     x-upload-key. A ✕ while it is in flight aborts it AND deletes it by that
     key (the engine tombstones the key, so an upload still on the wire is
     discarded when it lands); a response that got through anyway is deleted
     by its id. Removals the engine has not confirmed are kept here (per room,
     this browser) and retried on the next load, and restore() never draws
     one. Every storage access is guarded: the page works without it. */
  const GONE_KEY = `hwb.room.attach.gone.${o.roomId}`;
  const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  function goneList() {
    try {
      const v = JSON.parse(localStorage.getItem(GONE_KEY) || '[]');
      return Array.isArray(v) ? v.filter((g) => g && typeof g === 'object') : [];
    } catch {
      return [];
    }
  }
  function setGone(list) {
    try {
      if (list.length) {
        localStorage.setItem(GONE_KEY, JSON.stringify(list.slice(-50)));
      } else {
        localStorage.removeItem(GONE_KEY);
      }
    } catch {
      /* no storage: this page's own requests are all there is */
    }
  }
  const sameGone = (a, b) => (a.key && a.key === b.key) || (a.id && a.id === b.id);
  /** Delete a removed upload on the engine: by id when known, else by its
   *  upload key. Remembered until the engine confirms (200, or 404 = gone). */
  async function purge(entry) {
    setGone([...goneList().filter((g) => !sameGone(g, entry)), entry]);
    const url = entry.id ? `${base}/${encodeURIComponent(entry.id)}` : `${base}?key=${encodeURIComponent(entry.key)}`;
    try {
      const r = await fetch(url, { method: 'DELETE' });
      if (r.ok || r.status === 404) {
        setGone(goneList().filter((g) => !sameGone(g, entry)));
      }
    } catch {
      /* offline: retried on the next load */
    }
  }

  /** Send's state: off while a line is in flight, an upload is pending, a
   *  file failed (a message never goes out missing a file shown as
   *  attached), or the composer text is over the char limit [ticket]; its
   *  tooltip says which. */
  function paintSend() {
    const up = items.filter((i) => i.status === 'up').length;
    const fail = items.filter((i) => i.status === 'fail').length;
    o.sendBtn.disabled = overChar || busy || up > 0 || fail > 0;
    o.sendBtn.title = overChar ? 'Over the character limit' : fail ? 'Retry or remove the failed file' : up ? `Waiting for ${up} upload${up > 1 ? 's' : ''}` : 'Send (Enter)';
  }

  function paintNote() {
    const fail = items.filter((i) => i.status === 'fail').length;
    let msg = '';
    let err = false;
    if (fail) {
      msg = `${fail} file${fail > 1 ? 's' : ''} didn't upload: retry or remove ${fail > 1 ? 'them' : 'it'}`;
      err = true;
    } else if (capNote) {
      msg = capNote;
    } else if (items.length && !assetsPanel) {
      msg = 'Sending adds an Assets panel to this room.';
    }
    o.note.textContent = msg;
    o.note.hidden = !msg;
    o.note.classList.toggle('err', err);
  }

  function changed() {
    o.tray.hidden = items.length === 0 && !lead;
    items.forEach(paintNum); // live renumber: an add or a removal renumbers the tiles (and drops the badge at one)
    paintNote();
    paintSend();
  }

  function paintTile(it) {
    const el = it.el;
    const pad = !!it.note && it.status === 'ok'; // the scratchpad tile (the design system, ticket): no words on it
    const ghost = it.status === 'up' && (!!it.note || (NOTE_FILE.test(it.name) && it.type === 'text/plain')); // a note still uploading: the pad from the start, dimmed
    el.className = pad || ghost ? `att-tile is-note${ghost ? ' up' : ''}` : `att-tile ${isImage(it.type) ? 'img' : 'file'}${it.status === 'up' ? ' up' : ''}${it.status === 'fail' ? ' fail' : ''}`;
    const shown = it.note ? it.note.title || 'Note' : it.name;
    el.title = pad ? 'Open note' : it.status === 'fail' ? `${shown}: ${it.reason} (click to retry)` : ghost ? shown : it.note ? `${shown} (open the note)` : it.name;
    el.setAttribute('aria-label', pad ? 'Open note' : it.status === 'up' ? `${shown}, uploading` : it.status === 'fail' ? `${shown}, ${it.reason}` : it.note ? `Note: ${shown}` : it.name);
    it.nEl = null; // replaceChildren drops the number badge; paintNum below puts it back
    el.replaceChildren();
    if (pad) {
      if (it.note.title) el.append(srText(it.note.title));
    } else if (ghost) {
      const g = document.createElement('span'); // the pad itself, dimmed on its own so the meter and the x stay full strength
      g.className = 'is-note att-pad';
      g.setAttribute('aria-hidden', 'true');
      el.append(g);
    } else if (isImage(it.type)) {
      const img = document.createElement('img');
      img.alt = it.name;
      img.draggable = false;
      img.src = it.thumb;
      el.append(img);
      if (it.status === 'fail') {
        const r = document.createElement('span');
        r.className = 'att-retry';
        r.append(svg('0 0 24 24', RETRY_SVG));
        el.append(r);
      }
    } else {
      if (it.status === 'fail') {
        const r = document.createElement('span');
        r.className = 'att-retry';
        r.append(svg('0 0 24 24', RETRY_SVG));
        el.append(r);
      } else if (it.note) {
        const t = typeTile('', 'att-type att-note');
        t.textContent = '';
        t.append(svg('0 0 24 24', NOTE_SVG));
        el.append(t);
      } else {
        el.append(typeTile(it.name));
      }
      el.append(nameBlock(it.note ? it.note.title || 'Note' : it.name, it.status === 'fail' ? it.reason : it.note ? noteSub(it.note) : fmtSize(it.size)));
    }
    if (it.status === 'up') {
      const m = document.createElement('div');
      m.className = 'att-m';
      const i = document.createElement('i');
      i.style.width = `${Math.max(4, Math.round(it.p * 100))}%`;
      m.append(i);
      el.append(m);
    }
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'att-x';
    x.setAttribute('aria-label', `Remove ${shown}`);
    x.title = 'Remove';
    x.append(svg('0 0 10 10', X_SVG));
    x.addEventListener('click', (ev) => {
      ev.stopPropagation();
      remove(it, true);
    });
    el.append(x);
    paintNum(it);
  }

  /** The number badge (ticket, Owner 2026-10-02): the tile's place in this message, 1..N, only
   *  when there are 2+; the agents' attachment list numbers the same way (room-attach.ts agentBody). */
  function paintNum(it) {
    const n = items.indexOf(it) + 1;
    if (items.length < 2 || n < 1 || !it.el) {
      it.nEl?.remove();
      it.nEl = null;
    } else if (it.nEl) {
      it.nEl.textContent = String(n);
    } else {
      it.nEl = numBadge(n);
      it.el.append(it.nEl);
    }
  }

  function tile(it) {
    const el = document.createElement('div');
    el.tabIndex = 0;
    el.setAttribute('role', 'listitem');
    el.dataset.key = it.key;
    it.el = el;
    el.addEventListener('click', () => {
      if (it.status === 'fail' && it.file) {
        upload(it); // retry
      } else if (it.note && it.status === 'ok') {
        o.openNote?.(it.note.id); // the LIVE note, in the editor
      }
    });
    paintTile(it);
    o.tray.append(el);
  }

  function upload(it) {
    it.status = 'up';
    it.p = 0;
    it.reason = '';
    paintTile(it);
    changed();
    const xhr = new XMLHttpRequest();
    it.xhr = xhr;
    it.ukey = newKey(); // a fresh name per attempt: a removed one is never reused
    xhr.open('POST', base);
    xhr.setRequestHeader('x-upload-key', it.ukey);
    xhr.setRequestHeader('x-upload-pos', String(it.pos)); // the tray's order, not the arrival order
    xhr.setRequestHeader('x-filename', encodeURIComponent(it.name));
    xhr.setRequestHeader('content-type', it.type || 'application/octet-stream');
    xhr.upload.addEventListener('progress', (ev) => {
      if (ev.lengthComputable && it.status === 'up') {
        it.p = ev.loaded / ev.total;
        const bar = it.el.querySelector('.att-m i');
        if (bar) {
          bar.style.width = `${Math.max(4, Math.round(it.p * 100))}%`;
        }
      }
    });
    const done = (fn) => () => {
      if (it.removed) {
        /* the ✕ came first, and the engine answered anyway: delete that id now */
        let id = null;
        try {
          id = xhr.status === 200 ? JSON.parse(xhr.responseText)?.file?.id ?? null : null;
        } catch {
          id = null;
        }
        if (typeof id === 'string') {
          void purge({ key: it.ukey, id });
        }
        return;
      }
      if (it.xhr !== xhr) {
        return; // superseded by a retry
      }
      it.xhr = null;
      fn();
      if (items.includes(it)) {
        paintTile(it);
        changed();
      }
    };
    xhr.addEventListener('load', done(() => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status === 200 && body?.file?.id) {
        it.id = body.file.id;
        it.status = 'ok';
        return;
      }
      it.status = 'fail';
      it.reason =
        xhr.status === 413 && body?.field === 'count'
          ? `Over ${max.count} files per message`
          : xhr.status === 413
            ? `Over ${fmtSize(max.bytes)} limit`
            : 'Upload failed';
    }));
    const failed = done(() => {
      it.status = 'fail';
      it.reason = 'Upload failed';
    });
    xhr.addEventListener('error', failed);
    xhr.addEventListener('timeout', failed);
    xhr.send(it.file);
  }

  function pastedName(file) {
    if (file.name && file.name !== 'image.png' && file.name !== 'blob') {
      return file.name;
    }
    const d = new Date();
    const hm = `${String(d.getHours()).padStart(2, '0')}-${String(d.getMinutes()).padStart(2, '0')}`;
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'png';
    return `Pasted image ${hm}.${ext}`;
  }

  /** Add files (picker, paste, drop). Past the count cap, extra files do not
   *  become failure tiles: one note says the cap. */
  function add(files, { pasted = false } = {}) {
    capNote = '';
    let skipped = 0;
    for (const f of files) {
      if (items.length >= max.count) {
        skipped++;
        continue;
      }
      const name = pasted ? pastedName(f) : f.name || 'file';
      lastPos = Math.max(lastPos + 0.001, Date.now()); // strictly increasing: files picked together keep their order
      const it = { key: `k${++seq}`, file: f, id: null, name, type: f.type || '', size: f.size, status: 'up', p: 0, reason: '', thumb: '', xhr: null, el: null, pos: lastPos };
      if (isImage(it.type)) {
        it.thumb = URL.createObjectURL(f);
      }
      items.push(it);
      tile(it);
      if (f.size > max.bytes) {
        it.status = 'fail';
        it.reason = `Over ${fmtSize(max.bytes)} limit`;
        paintTile(it);
      } else {
        upload(it);
      }
    }
    if (skipped) {
      capNote = `${max.count} files per message`;
    }
    if (items.length) {
      o.tray.scrollLeft = o.tray.scrollWidth;
    }
    changed();
  }

  /** Remove a tile (✕, Delete). `server`: also delete it from the scratchpad. */
  function remove(it, server, focusNext = false) {
    const i = items.indexOf(it);
    if (i < 0) {
      return;
    }
    items.splice(i, 1);
    if (it.xhr) {
      /* in flight: abort, and delete by its upload key in case it lands */
      it.removed = true;
      const x = it.xhr;
      it.xhr = null;
      x.abort();
      void purge({ key: it.ukey, id: null });
    } else if (server && it.id) {
      void purge({ key: it.ukey ?? null, id: it.id });
    }
    if (it.thumb.startsWith('blob:')) {
      URL.revokeObjectURL(it.thumb);
    }
    const next = focusNext ? (items[i] ?? items[i - 1])?.el : null;
    it.el?.remove();
    capNote = '';
    changed();
    if (focusNext) {
      (next ?? o.input).focus();
    }
  }

  /* ---- the ways in ---- */
  o.addBtn.addEventListener('click', (ev) => {
    if (!o.addMenu?.(ev.currentTarget)) {
      o.fileInput.click(); // no notes here: the + is the plain file picker
    }
  });
  o.fileInput.addEventListener('change', () => {
    const files = [...(o.fileInput.files ?? [])];
    o.fileInput.value = '';
    if (files.length) {
      add(files);
    }
  });
  /* PASTE: file or image data adds a tile; text stays text (a clipboard that
     carries text as well is text: Office pastes a picture of the words too) */
  o.input.addEventListener('paste', (ev) => {
    const dt = ev.clipboardData;
    const files = dt ? [...dt.files] : [];
    if (!files.length || (dt.getData('text/plain') ?? '') !== '') {
      return;
    }
    ev.preventDefault();
    add(files, { pasted: true });
  });
  /* DROP: the whole line column is the target */
  const hasFiles = (ev) => [...(ev.dataTransfer?.types ?? [])].includes('Files');
  const zone = o.dropZone;
  zone.addEventListener('dragenter', (ev) => {
    if (hasFiles(ev)) {
      ev.preventDefault();
      zone.classList.add('is-drag');
    }
  });
  zone.addEventListener('dragover', (ev) => {
    if (hasFiles(ev)) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
      zone.classList.add('is-drag');
    }
  });
  zone.addEventListener('dragleave', (ev) => {
    if (!ev.relatedTarget || !zone.contains(ev.relatedTarget)) {
      zone.classList.remove('is-drag');
    }
  });
  zone.addEventListener('drop', (ev) => {
    if (!hasFiles(ev)) {
      return;
    }
    ev.preventDefault();
    zone.classList.remove('is-drag');
    add([...ev.dataTransfer.files]);
  });
  /* TILES: focusable; Delete/Backspace removes and moves focus to a neighbour */
  o.tray.addEventListener('keydown', (ev) => {
    const el = ev.target.closest?.('.att-tile');
    if (!el || ev.target !== el) {
      return;
    }
    const it = items.find((x) => x.el === el);
    if (ev.repeat) {
      return; // a HELD key removes one tile, never its neighbour too (focus moves there)
    }
    if (it && (ev.key === 'Delete' || ev.key === 'Backspace')) {
      ev.preventDefault();
      remove(it, true, true);
    } else if (it && ev.key === 'Enter' && it.status === 'fail' && it.file) {
      upload(it);
    } else if (it?.note && it.status === 'ok' && ev.key === 'Enter') {
      o.openNote?.(it.note.id);
    }
  });
  /* DRAG TO REORDER (Owner 2026-10-04, room). Press and hold ~300ms on a tile (never its x): it lifts
     5px with a 2px inside outline, follows the pointer along the row, the others slide aside to open
     the gap, and a drop there renumbers (items order -> ids() -> the line's files -> agents' [n]) and
     saves the order to the scratchpad (PUT .../scratch/order). Numbers and x are hidden meanwhile
     (CSS .is-sorting). Esc, pointercancel or a drop off the tray snaps back. Movement before the
     hold fires means the person is scrolling the tray: the hold is dropped. Nothing is focused. */
  let drag = null;
  let swallowClick = false;
  const sortable = () => items.length > 1 && !items.some((i) => i.status === 'up');
  function dragMove(ev) {
    const d = drag;
    if (!d || ev.pointerId !== d.pid) {
      return;
    }
    if (!d.held) {
      if (Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0) > HOLD_SLOP) {
        dragEnd(false, true); // scrolling: not a hold
      }
      return;
    }
    ev.preventDefault();
    const dx = ev.clientX - d.x0;
    const tr = o.tray.getBoundingClientRect();
    const outside = ev.clientX < tr.left - 48 || ev.clientX > tr.right + 48 || ev.clientY < tr.top - 64 || ev.clientY > tr.bottom + 64;
    d.dx = dx;
    d.to = outside ? d.from : sortTarget(d.centers, d.from, d.centers[d.from] + dx);
    d.el.style.transform = `translate(${dx}px, -${LIFT_PX}px)`;
    items.forEach((it, j) => {
      if (j !== d.from) {
        it.el.style.transform = shiftOf(j, d.from, d.to) ? `translateX(${shiftOf(j, d.from, d.to) * d.step}px)` : '';
      }
    });
  }
  function dragEnd(commit, quiet = false) {
    const d = drag;
    if (!d) {
      return;
    }
    drag = null;
    clearTimeout(d.timer);
    window.removeEventListener('pointermove', dragMove, true);
    window.removeEventListener('pointerup', dragUp, true);
    window.removeEventListener('pointercancel', dragCancel, true);
    document.removeEventListener('keydown', dragKey, true);
    if (!d.held) {
      return;
    }
    if (!quiet) {
      swallowClick = true; // the release is a click on the tile: not a tap
      setTimeout(() => (swallowClick = false), 0);
    }
    o.tray.classList.remove('is-sorting');
    d.el.classList.remove('is-lifted');
    const moved = commit && d.to !== d.from;
    if (moved) {
      const order = moveItem(items, d.from, d.to);
      items.splice(0, items.length, ...order);
      o.tray.classList.remove('is-settling');
      for (const it of items) {
        it.el.style.transform = '';
        o.tray.append(it.el);
      }
      if (lead) {
        o.tray.prepend(lead); // the lead slot stays first
      }
      changed(); // renumber
      void saveOrder();
    } else {
      o.tray.classList.add('is-settling'); // snap back, animated
      for (const it of items) {
        it.el.style.transform = '';
      }
      changed(); // numbers and x come back
      setTimeout(() => o.tray.classList.remove('is-settling'), 200);
    }
  }
  const dragUp = (ev) => ev.pointerId === drag?.pid && dragEnd(true);
  const dragCancel = (ev) => ev.pointerId === drag?.pid && dragEnd(false);
  const dragKey = (ev) => {
    if (ev.key === 'Escape' && drag?.held) {
      ev.preventDefault();
      ev.stopPropagation();
      dragEnd(false);
    }
  };
  /** Save the tray's order; a failure is said inline, never swallowed. */
  async function saveOrder() {
    try {
      const r = await fetch(`${base}/order`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: ids() }) });
      if (!r.ok) {
        throw new Error(String(r.status));
      }
    } catch {
      capNote = "Couldn't save the new order: it will send as shown, but a reload may restore the old one.";
      paintNote();
    }
  }
  const ids = () => items.filter((i) => i.status === 'ok' && i.id).map((i) => i.id);
  o.tray.addEventListener('pointerdown', (ev) => {
    const el = ev.target.closest?.('.att-tile');
    if (!el || ev.target.closest('.att-x') || drag || (ev.pointerType === 'mouse' && ev.button !== 0) || !sortable()) {
      return;
    }
    const from = items.findIndex((x) => x.el === el);
    if (from < 0) {
      return;
    }
    const rects = items.map((it) => it.el.getBoundingClientRect());
    const gap = parseFloat(getComputedStyle(o.tray).columnGap) || 8;
    drag = {
      pid: ev.pointerId, x0: ev.clientX, y0: ev.clientY, el, from, to: from, dx: 0, held: false,
      centers: rects.map((r) => r.left + r.width / 2),
      step: rects[from].width + gap,
      timer: setTimeout(() => {
        if (!drag) {
          return;
        }
        drag.held = true;
        o.tray.classList.add('is-sorting');
        el.classList.add('is-lifted');
        el.style.transform = `translate(0px, -${LIFT_PX}px)`;
        try {
          o.tray.setPointerCapture?.(drag.pid);
        } catch {
          /* the pointer is already gone: the up/cancel ends it */
        }
      }, HOLD_MS),
    };
    window.addEventListener('pointermove', dragMove, true);
    window.addEventListener('pointerup', dragUp, true);
    window.addEventListener('pointercancel', dragCancel, true);
    document.addEventListener('keydown', dragKey, true);
  });
  /* while held, a touch move must not scroll the tray (a move before the hold already cancelled it) */
  o.tray.addEventListener('touchmove', (ev) => {
    if (drag?.held && ev.cancelable) {
      ev.preventDefault();
    }
  }, { passive: false });
  o.tray.addEventListener('contextmenu', (ev) => {
    if (drag) {
      ev.preventDefault(); // Android's long-press menu / iOS callout while holding
    }
  });
  o.tray.addEventListener('click', (ev) => {
    if (swallowClick) {
      ev.stopPropagation();
      ev.preventDefault();
    }
  }, true);
  /* keyboard: Alt+Arrow moves the focused tile one place */
  o.tray.addEventListener('keydown', (ev) => {
    const el = ev.target;
    if (!ev.altKey || (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') || !el.classList?.contains('att-tile') || !sortable()) {
      return;
    }
    const from = items.findIndex((x) => x.el === el);
    const to = from + (ev.key === 'ArrowLeft' ? -1 : 1);
    if (from < 0 || to < 0 || to >= items.length) {
      return;
    }
    ev.preventDefault();
    items.splice(0, items.length, ...moveItem(items, from, to));
    for (const it of items) {
      o.tray.append(it.el);
    }
    if (lead) {
      o.tray.prepend(lead);
    }
    el.focus();
    changed();
    void saveOrder();
  });
  /* wheel-to-scroll the one row */
  o.tray.addEventListener('wheel', (ev) => {
    if (Math.abs(ev.deltaY) > Math.abs(ev.deltaX) && o.tray.scrollWidth > o.tray.clientWidth) {
      o.tray.scrollLeft += ev.deltaY;
      ev.preventDefault();
    }
  }, { passive: false });

  /** On load: the scratchpad's files come back as uploaded (no meters). */
  async function restore() {
    let r;
    try {
      r = await o.api(base);
    } catch {
      return;
    }
    if (!r.ok || !r.body) {
      return;
    }
    if (r.body.max && Number.isFinite(r.body.max.bytes) && Number.isFinite(r.body.max.count)) {
      max = { bytes: r.body.max.bytes, count: r.body.max.count };
    }
    assetsPanel = r.body.assetsPanel !== false;
    /* A file this page is still uploading may already be in the listing (it
       landed, its answer is not back yet): matched by its upload key, never
       drawn twice. */
    const have = new Set(items.map((i) => i.id).filter(Boolean));
    const flying = new Set(items.map((i) => i.ukey).filter(Boolean));
    const restored = [];
    const gone = goneList();
    for (const g of gone) {
      void purge(g); // a removal the engine never confirmed: finish it
    }
    for (const f of Array.isArray(r.body.files) ? r.body.files : []) {
      if (!f || typeof f.id !== 'string' || have.has(f.id) || !/^[a-f0-9]{32}$/.test(f.id) || (typeof f.key === 'string' && flying.has(f.key))) {
        continue;
      }
      if (gone.some((g) => sameGone(g, { id: f.id, key: typeof f.key === 'string' ? f.key : null }))) {
        continue; // removed here: never drawn again
      }
      const it = {
        key: `k${++seq}`,
        file: null,
        id: f.id,
        name: String(f.name ?? 'file'),
        type: String(f.type ?? ''),
        size: Number(f.size) || 0,
        status: 'ok',
        p: 1,
        reason: '',
        ukey: typeof f.key === 'string' ? f.key : null,
        thumb: `${base}/${f.id}`,
        xhr: null,
        el: null,
        pos: 0,
        note: null,
      };
      if (NOTE_FILE.test(it.name) && it.type === 'text/plain') {
        it.note = { id: it.name.slice(5, 17), title: '', words: null }; // a note's attachment: its tile, not a TXT file
        void o.noteInfo?.(it.note.id);
      }
      restored.push(it);
      tile(it);
    }
    /* the scratchpad's files come FIRST, in its order; anything added while
       the page loaded is newer and follows them */
    items.unshift(...restored);
    o.tray.prepend(...restored.map((it) => it.el));
    if (lead) {
      o.tray.prepend(lead); // the lead slot stays first
    }
    changed();
  }

  /* ---- the sent line: the preview column, the Assets panel ---- */
  function openSent(f, all, opener) {
    const doc = o.docView?.(f) ?? null;
    o.preview()?.open({
      owner: 'attach',
      key: f.raw,
      type: isImage(f.type) ? 'IMAGE' : f.kind === 'note' ? 'NOTE' : extOf(f.name),
      name: f.kind === 'note' ? f.title || 'Note' : f.name,
      body: doc ? doc.body : previewBody(f),
      ...(doc ? { tools: doc.tools } : {}),
      back: all.length > 1 ? { label: `← All ${all.length} files`, go: () => openSentSet(all, opener) } : undefined,
      opener,
    });
  }
  function openSentSet(all, opener) {
    o.preview()?.open({ owner: 'attach', key: null, type: 'FILES', name: `${all.length} files`, body: setBody(all, openSent), opener });
  }
  function assetsPanelOf() {
    return o.cells()?.list().find((p) => p.icon === 'assets' || String(p.title ?? '').trim().toLowerCase() === 'assets') ?? null;
  }
  /** Unfold a panel's cell and bring it into view; `arrive`: one soft teal
   *  wash, for a panel that just appeared. Through the cell's own header
   *  button, so the fold is saved and the frame loads as on a click. */
  function reveal(panelId, arrive) {
    const el = [...document.querySelectorAll('#panelCells > .cell')].find((c) => c.dataset.cell === panelId);
    if (!el) {
      return false;
    }
    if (el.classList.contains('collapsed')) {
      el.querySelector('.cell-h')?.click();
    }
    el.scrollIntoView({ block: 'nearest' });
    if (arrive) {
      el.classList.remove('cell-arrive');
      void el.offsetWidth; // restart the animation
      el.classList.add('cell-arrive');
      setTimeout(() => el.classList.remove('cell-arrive'), 1700);
    }
    return true;
  }
  /** "in Assets": the room's Assets panel (its cell; its layer on a phone);
   *  with none (it failed to register, or was removed) the message's files
   *  in the preview column. */
  function openAssets(files, opener) {
    const p = assetsPanelOf();
    if (p && o.isPhone()) {
      o.openApp(p.id);
    } else if (!p || !reveal(p.id, false)) {
      openSentSet(files, opener);
    }
  }

  paintSend();
  return {
    restore,
    /** THE LEAD SLOT (room-reply-v1): put `el` first in the tray (replacing
     *  what was there), or empty the slot with null. The caller owns `el`. */
    setLead(el) {
      if (lead && lead !== el) {
        lead.remove();
      }
      lead = el || null;
      if (lead) {
        o.tray.prepend(lead);
        o.tray.scrollLeft = 0;
      }
      changed();
    },
    /** NOTES (room-notes.mjs): a note's attachment as a tile. `attachment` is
     *  the engine's {file, title, words, ...}, `note` the NoteFull. The SAME
     *  note (or file) again REPLACES its tile's content, never adds a second. */
    putNote(attachment, note) {
      const f = attachment?.file;
      if (!f || typeof f.id !== 'string') {
        return;
      }
      const meta = { id: note?.id ?? attachment.note_id ?? '', title: String(attachment.title ?? ''), words: Number(attachment.words) };
      const mine = items.find((i) => i.id === f.id || (i.note && meta.id && i.note.id === meta.id));
      if (mine) {
        mine.id = f.id;
        mine.size = Number(f.size) || Number(attachment.bytes_length) || mine.size;
        mine.note = { ...meta, id: meta.id || mine.note?.id || '' };
        mine.status = 'ok';
        paintTile(mine);
        changed();
        return;
      }
      capNote = '';
      lastPos = Math.max(lastPos + 0.001, Date.now());
      const it = { key: `k${++seq}`, file: null, id: f.id, name: String(f.name ?? 'note.txt'), type: 'text/plain', size: Number(f.size) || Number(attachment.bytes_length) || 0, status: 'ok', p: 1, reason: '', ukey: typeof f.key === 'string' ? f.key : null, thumb: '', xhr: null, el: null, pos: lastPos, note: meta };
      items.push(it);
      tile(it);
      o.tray.scrollLeft = o.tray.scrollWidth;
      changed();
    },
    /** is this note attached to the message now */
    hasNote: (id) => items.some((i) => i.note?.id === id && i.status === 'ok'),
    /** a restored note tile learned its title and word count */
    noteMeta(id, m) {
      const it = items.find((i) => i.note?.id === id);
      if (it) {
        it.note = { ...it.note, ...m };
        paintTile(it);
      }
    },
    /** a line POST going out / back */
    busy(v) {
      busy = !!v;
      paintSend();
    },
    /** room.js: the composer text is over its 4000-char send cap (or back
     *  under it) — repaints Send alongside busy/upload/fail [ticket]. */
    overLimit(v) {
      overChar = !!v;
      paintSend();
    },
    /** may the composer send now: something to say (words or files) and
     *  nothing uploading, failed or in flight */
    canSend(text) {
      return !busy && !o.sendBtn.disabled && (!!text.trim() || items.some((i) => i.status === 'ok' && i.id));
    },
    /** the uploaded files' ids, in tray order (the line POST carries them) */
    ids,
    /** The message went out: drop exactly these tiles (the engine already
     *  emptied them from the scratchpad). A room that had no Assets panel got
     *  one: it appears in its slot, unfolded, with one soft teal wash (no
     *  toast; the line's "in Assets" points at it). A failure there changes
     *  nothing sent. */
    async sent(ids, body) {
      for (const it of items.filter((x) => x.id && ids.includes(x.id))) {
        remove(it, false);
      }
      const p = body?.assetsPanel;
      if (!p || typeof p.id !== 'string') {
        return;
      }
      assetsPanel = true;
      paintNote();
      if (p.added) {
        await o.refresh();
        if (!o.isPhone()) {
          reveal(p.id, true);
        }
      }
    },
    /** A note was made and the engine gave the room its Assets panel with it
     *  ({assetsPanel:{added}}): show the panel now, before anything is sent. */
    async panelAdded(body) {
      if (body?.assetsPanel?.added === true) {
        assetsPanel = true;
        paintNote();
        await o.refresh();
      }
    },
    /** entryNode's hook: a sent line's files as thumbnails under its text,
     *  and "N files · in Assets" under the bubble; never the raw references */
    decorate(li, bubble, e) {
      const files = e.kind === 'attachment' ? sentFiles(e, o.roomId) : [];
      if (!files.length) {
        return;
      }
      bubble.querySelector('.entry-kind')?.remove(); // the thumbnails say it
      bubble.append(sentView(files, { open: openSent, openAll: openSentSet }));
      const rc = document.createElement('div');
      rc.className = 'entry-files';
      const a = document.createElement('button');
      a.type = 'button';
      a.textContent = 'in Assets';
      a.addEventListener('click', () => openAssets(files, a));
      if (files.every((f) => f.inDb)) {
        rc.append(receiptCount(files)); // nothing of this message is in Assets
      } else {
        rc.append(`${receiptCount(files)} · `, a);
      }
      li.append(rc);
    },
  };
}

/* -------------------------------------------------------- the sent line ---- */

/** The receipt's count, by kind: "3 files", "1 note", "2 files, 1 note". */
export function receiptCount(files) {
  const notes = files.filter((f) => f.kind === 'note').length;
  const n = (c, w) => `${c} ${w}${c > 1 ? 's' : ''}`;
  return [files.length - notes && n(files.length - notes, 'file'), notes && n(notes, 'note')].filter(Boolean).join(', ');
}

/** The files of a sent line, as the line entry's meta carries them; each
 *  with the page's OWN route to its bytes (a meta value is never a src). */
export function sentFiles(e, roomId) {
  let meta = null;
  try {
    meta = typeof e.meta === 'string' ? JSON.parse(e.meta) : e.meta;
  } catch {
    meta = null;
  }
  const list = Array.isArray(meta?.attachments) ? meta.attachments : [];
  return list
    .filter((a) => a && typeof a.name === 'string' && a.name && !a.name.includes('/'))
    .map((a) => ({
      name: a.name,
      type: typeof a.type === 'string' ? a.type : '',
      size: Number(a.size) || 0,
      /* a note kept in the database (sent_id) has no file in the assets: its text is the engine's own route */
      raw: a.kind === 'note' && /^[a-f0-9]{12}$/.test(a.sent_id ?? '') ? `/api/rooms/${encodeURIComponent(roomId)}/notes/sent/${a.sent_id}/raw` : `/api/rooms/${encodeURIComponent(roomId)}/assets/raw/${encodeURIComponent(a.name)}`,
      ...(a.kind === 'note' ? { kind: 'note', inDb: /^[a-f0-9]{12}$/.test(a.sent_id ?? ''), title: typeof a.title === 'string' ? a.title : '', words: Number.isFinite(a.words) ? a.words : null } : {}),
    }));
}

/** The number pill on a tile's lower-left (ticket). Decoration: the tap goes through to the tile. */
function numBadge(n) {
  const sp = document.createElement('span');
  sp.className = 'att-n';
  sp.setAttribute('aria-hidden', 'true');
  sp.textContent = String(n);
  return sp;
}

/** Visually hidden text for screen readers (the note's first words). */
function srText(text) {
  const sp = document.createElement('span');
  sp.className = 'att-sr';
  sp.textContent = text;
  return sp;
}

/** A sent file's chip (the button `b`): a note is the design system scratchpad tile
 *  (`is-note`, drawn by CSS: no icon, no words), never its hash filename; its
 *  first words are for screen readers only. */
function paintSentFile(b, f, n = 0) {
  if (f.kind === 'note') {
    b.className = 'is-note';
    b.title = 'Open note';
    b.setAttribute('aria-label', 'Open note');
    if (f.title) b.append(srText(f.title));
    if (n) b.append(numBadge(n));
    return;
  }
  b.className = 'att-file';
  b.title = f.name;
  b.append(typeTile(f.name), nameBlock(f.name, fmtSize(f.size)));
  if (n) b.append(numBadge(n));
}

/**
 * The thumbnails under a sent line's text. `open(file, all)` opens one in the
 * preview column; `openAll(all)` the whole set (the "+N" tile).
 */
export function sentView(files, { open, openAll }) {
  const wrap = document.createElement('div');
  wrap.className = 'entry-att';
  const images = files.filter((f) => isImage(f.type));
  const notes = files.filter((f) => !isImage(f.type) && f.kind === 'note');
  const others = files.filter((f) => !isImage(f.type) && f.kind !== 'note');
  const shown = images.length > 3 ? images.slice(0, 4) : images;
  const num = (f) => (files.length > 1 ? files.indexOf(f) + 1 : 0); // the message's order, as agentBody numbers it
  shown.forEach((f, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `att-img${images.length === 1 ? ' one' : ''}`;
    b.title = f.name;
    const img = document.createElement('img');
    img.alt = f.name;
    img.loading = 'lazy';
    img.src = f.raw;
    b.append(img);
    if (i === 3) {
      const more = document.createElement('span');
      more.className = 'more';
      more.textContent = `+${images.length - 3}`;
      b.append(more);
      b.setAttribute('aria-label', `${images.length - 3} more: show all ${files.length} files`);
      b.addEventListener('click', () => openAll(files, b));
    } else {
      if (num(f)) b.append(numBadge(num(f)));
      b.addEventListener('click', () => open(f, files, b));
    }
    wrap.append(b);
  });
  /* file chips take their OWN row after the images (the design system review A2): side
     by side they read as one more thumbnail */
  /* notes sit in the IMAGE flow (same row height, they wrap like images) */
  for (const f of notes) {
    const b = document.createElement('button');
    b.type = 'button';
    paintSentFile(b, f, num(f));
    b.addEventListener('click', () => open(f, files, b));
    wrap.append(b);
  }
  const chips = others.length && (images.length || notes.length) ? document.createElement('div') : wrap;
  if (chips !== wrap) {
    chips.className = 'att-chips';
    wrap.append(chips);
  }
  for (const f of others) {
    const b = document.createElement('button');
    b.type = 'button';
    paintSentFile(b, f, num(f));
    b.addEventListener('click', () => open(f, files, b));
    chips.append(b);
  }
  return wrap;
}

/** The preview column's body for one sent file. */
export function previewBody(f) {
  const b = document.createElement('div');
  b.className = 'pv-item';
  if (isImage(f.type)) {
    const box = document.createElement('div');
    box.className = 'pv-img';
    const img = document.createElement('img');
    img.alt = f.name;
    img.src = f.raw;
    box.append(img);
    b.append(box);
  }
  const dl = document.createElement('dl');
  dl.className = 'pv-meta';
  const meta = f.kind === 'note' ? [['Note', f.title || 'Note'], ['Size', fmtSize(f.size)]] : [['Name', f.name], ['Size', fmtSize(f.size)], ['Type', f.type || 'file']];
  for (const [l, v] of meta) {
    const dt = document.createElement('dt');
    dt.textContent = l;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
  b.append(dl);
  const acts = document.createElement('div');
  acts.className = 'pv-acts';
  const full = document.createElement('a');
  full.className = 'pv-btn pri';
  full.href = f.raw;
  full.target = '_blank';
  full.rel = 'noopener noreferrer';
  full.textContent = f.kind === 'note' ? 'Open note' : 'Open full size';
  const dlink = document.createElement('a');
  dlink.className = 'pv-btn';
  dlink.href = f.raw;
  dlink.setAttribute('download', f.kind === 'note' ? 'note.txt' : f.name);
  dlink.textContent = 'Download';
  acts.append(full, dlink);
  b.append(acts);
  return b;
}

/** The preview column's body for a whole set ("+N"): every file, each one
 *  opening its own preview. */
export function setBody(files, open) {
  const b = document.createElement('div');
  b.className = 'pv-item att-set';
  const grid = document.createElement('div');
  grid.className = 'entry-att';
  for (const f of files) {
    const t = document.createElement('button');
    t.type = 'button';
    if (isImage(f.type)) {
      t.title = f.name;
      t.className = 'att-img';
      const img = document.createElement('img');
      img.alt = f.name;
      img.src = f.raw;
      t.append(img);
      if (files.length > 1) t.append(numBadge(files.indexOf(f) + 1));
    } else {
      paintSentFile(t, f, files.length > 1 ? files.indexOf(f) + 1 : 0);
    }
    t.addEventListener('click', () => open(f, files, t));
    grid.append(t);
  }
  b.append(grid);
  return b;
}
