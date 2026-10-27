// Workrooms (W2, write): the composer under a room's line. the design's step-5 page, #w2 (<commit>):
//  - one M3 field (48 px, a pill), + at the left ("Attach files"), send at the right ("Send (Enter)");
//    Enter sends, Shift+Enter is a new line; Tab continues the last @address; "/" at the start opens the
//    command list (↑ ↓ and Enter or Tab pick one); "@" opens the seat list;
//  - the count "4,012 / 4,000" from 3,800, then the error outline, Send off, "Too long to send. Shorten it,
//    or attach it as a file.";
//  - the reply chip over the field: "Replying to <name> · <excerpt>…" with ✕;
//  - the draft tray over the field: 64 × 64 thumbnails and file chips "plan.md · 4 KB", ✕ "Remove", up to 10;
//    files arrive by drop ("Drop to attach to <room>" · "Images and files up to 25 MB"), paste, or +;
//    each goes to the room's scratch tray at once and the ids ride on the send; over 25 MB: the snackbar
//    "<name> is over 25 MB and wasn't attached.";
//  - the failed message stays in the line, yours, with "Not sent" · Try again · Delete; offline it waits
//    as "Sending when you're back online" and goes out by itself;
//  - a newer draft on the server: "A newer draft from <device> · <ago>" [Use it] [Keep this] over the field;
//  - the delivery line under the field: "Last message reached a, b".
// The text goes to the engine verbatim (it parses @names and /commands, ROOMS-API.md §3.2); a person's
// line never carries `from`. Everything here talks to main through window.wb.rooms only.
import { ATTACH_UNAVAILABLE } from '../first-run/model.js';
import { icon } from '../m3-chrome.js';
import { el, avatarEl, timeWords, colorOf, seatLch, lchOfHex } from './line.js';
import { LEADING, quietRanges, inRanges } from './rules.js';
import { commandRows, commandQuery, matchCommands, argumentStarted, usageCommand, hasFollowingArguments } from './command-help.js';
let nextSuggestionId = 0;

const MAX = 4000;
const COUNT_FROM = 3800;
const TRAY_MAX = 10;
const FILE_MAX = 25 * 1024 * 1024;
const DRAFT_SAVE_MS = 800;

const WORDS = {
  placeholder: (room) => 'Message ' + room,
  tooLong: 'Too long to send. Shorten it, or attach it as a file.',
  overSize: (name) => name + " is over 25 MB and wasn't attached.",
  trayFull: 'A message can have up to 10 files.',
  uploadFailed: (name) => name + " couldn't be uploaded.",
  noFileStore: "Pictures can't be sent on this server yet. Whoever runs it needs to set up the file store.",
  replying: (name) => 'Replying to ' + name,
  prefillHint: 'Names are filled in so you can take any out.',
  notSent: 'Not sent',
  tryAgain: 'Try again',
  del: 'Delete',
  waiting: "Sending when you're back online",
  newer: (device, ago) => 'A newer draft from ' + device + ' · ' + ago,
  useIt: 'Use it',
  keepThis: 'Keep this',
  reached: (names) => 'Last message reached ' + names.join(', '),
  unknown: (word) => "There's no /" + word + ' here. Type /help for the list.',
};

function sizeWords(n) {
  if (n < 1024) {
    return n + ' B';
  }
  if (n < 1024 * 1024) {
    return Math.round(n / 1024) + ' KB';
  }
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}
function agoWords(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
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
function fmt(n) {
  return n.toLocaleString('en-US');
}

/**
 * createComposer(deps): { host (the room column), roomId(), roomName(), seats() -> [{handle, state}],
 *   seatIndex(handle), conn() -> 'live'|'polling'|'offline'|'down'|'signed-out', snackbar(text),
 *   pendingAdd(entry)/pendingRemove(id)/pendingUpdate(entry) for the line's local rows,
 *   scrollToBottom(), pickFiles() -> Promise<[{name,type,bytes}]>, device }
 */
export function createComposer(deps) {
  let destroyed = false;
  let paintFrame = null, blurTimer = null;
  const cleanups = [];
  const listen = (node, name, fn) => { node.addEventListener(name, fn); cleanups.push(() => node.removeEventListener(name, fn)); };
  let generation = 0;
  const capture = () => ({ generation, api: window.wb.rooms.bind() });
  const current = (request) => !destroyed && !!request && request.generation === generation && request.api.current();
  const root = el('div', 'wr-cmp');
  const offer = el('div', 'wr-draftoffer');
  offer.hidden = true;
  const chip = el('div', 'wr-rpl');
  chip.hidden = true;
  // C8 (the design "Replying fills in the names"): the one-time hint under the chip
  const nameHint = el('div', 'wr-rplhint', WORDS.prefillHint);
  nameHint.hidden = true;
  let hintSeen = false;
  try {
    hintSeen = localStorage.getItem('wb.rooms.prefillHint') === '1';
  } catch (e) {
    // shown again next time
  }
  const tray = el('div', 'wr-tray');
  tray.hidden = true;
  const trayHint = el('div', 'wr-trihint');
  trayHint.hidden = true;
  const field = el('div', 'wr-ci');
  const plus = el('button', 'wr-cib');
  plus.type = 'button';
  plus.title = 'Add a file';
  plus.setAttribute('aria-label', 'Add a file');
  plus.setAttribute('aria-haspopup', 'menu');
  plus.setAttribute('aria-expanded', 'false');
  plus.innerHTML = icon('add');
  const filesAvailable = () => deps.filesAvailable?.() !== false;
  // a scratch file with `companionOf` (a picture's <name>.annotations.svg) belongs to its picture: never a tile, never counted, never sent on its own
  const trayFiles = () => st.files.filter((f) => !f.companionOf);
  const marksWords = (n) => (n === 1 ? '1 mark' : n + ' marks');
  const attachReason = el('span', 'wr-popstatus', ATTACH_UNAVAILABLE);
  attachReason.id = 'wr-attach-reason-' + ++nextSuggestionId;

  const ta = el('textarea', 'wr-ta');
  ta.rows = 1;
  ta.setAttribute('aria-label', 'Message');
  // 0.22.2 (the owner /): the names you type that the room knows (a seat, you, lead, room, a family room)
  // take their mention color as you type; a name in quotes or code stays plain (it is not a reference). A
  // mirror behind the textarea draws the text; the textarea's own text is transparent, its caret is not.
  const mirror = el('div', 'wr-tamirror');
  mirror.setAttribute('aria-hidden', 'true');
  const taw = el('div', 'wr-taw');
  taw.append(mirror, ta);
  let paintQueued = false;
  function paint() {
    paintQueued = false; paintFrame = null;
    if (destroyed) return;
    const s = ta.value;
    mirror.textContent = '';
    const quiet = quietRanges(s);
    const re = /(?<![A-Za-z0-9_.@-])@([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/g;
    let last = 0;
    let m;
    while ((m = re.exec(s))) {
      const kind = deps.addressKind ? deps.addressKind(m[1]) : null;
      const i = kind ? null : deps.seatIndex ? deps.seatIndex(m[1]) : null;
      if (inRanges(quiet, m.index) || (kind == null && i == null)) {
        continue;
      }
      if (m.index > last) {
        mirror.appendChild(document.createTextNode(s.slice(last, m.index)));
      }
      const span = el('span', 'wr-tam' + (kind === 'you' ? ' me' : ''), m[0]);
      const own = kind ? null : colorOf(m[1]);
      if (own || i != null) {
        const lch = (own && lchOfHex(own)) || seatLch(i);
        span.classList.add('seat');
        span.style.setProperty('--at-c', String(lch.c));
        span.style.setProperty('--at-h', String(lch.h));
      }
      deps.paintMention?.(span,m[1],kind,i);
      mirror.appendChild(span);
      last = m.index + m[0].length;
    }
    mirror.appendChild(document.createTextNode(s.slice(last) + '\u200b')); // a trailing newline keeps its height
    mirror.scrollTop = ta.scrollTop;
  }
  const repaint = () => {
    if (!destroyed && !paintQueued) {
      paintQueued = true;
      paintFrame = requestAnimationFrame(paint);
    }
  };
  {
    // every write to the text (a prefill, a reply, a room switch, a send) repaints, not only typing
    const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    Object.defineProperty(ta, 'value', { configurable: true, get() { return proto.get.call(this); }, set(v) { proto.set.call(this, v); paint(); } });
    const rangeText = ta.setRangeText.bind(ta);
    ta.setRangeText = (...a) => { const r = rangeText(...a); paint(); return r; };
  }
  ta.addEventListener('input', repaint);
  ta.addEventListener('scroll', () => { mirror.scrollTop = ta.scrollTop; });
  const count = el('span', 'wr-count');
  count.hidden = true;
  const send = el('button', 'wr-send');
  send.type = 'button';
  const enterSends = () => (deps.enterPref ? deps.enterPref.get() : true); // Enter sends unless the person turned it off (web: the saved preference)
  const sendWords = () => (deps.enterPref ? 'Send · press and hold for options' : 'Send (Enter)');
  send.title = sendWords();
  send.setAttribute('aria-label', 'Send');
  send.innerHTML = icon('send');
  // the Send button's options (web): right-click or press-and-hold opens "Enter sends the message" / "Enter starts a new line"
  if (deps.enterPref && deps.sendMenu) {
    let holdTimer = null, held = false;
    const openOptions = (x, y) => deps.sendMenu({ x, y }, [
      { id: 'enter-sends', label: 'Enter sends the message', checked: enterSends(), fn: () => deps.enterPref.set(true) },
      { id: 'enter-newline', label: 'Enter starts a new line', checked: !enterSends(), fn: () => deps.enterPref.set(false) },
    ]);
    send.addEventListener('contextmenu', (e) => { e.preventDefault(); const r = send.getBoundingClientRect(); openOptions(Math.max(8, r.right - 220), Math.max(8, r.top - 112)); });
    send.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      held = false;
      holdTimer = setTimeout(() => { held = true; const r = send.getBoundingClientRect(); openOptions(Math.max(8, r.right - 220), Math.max(8, r.top - 112)); }, 500);
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) send.addEventListener(ev, () => { clearTimeout(holdTimer); });
    send.addEventListener('click', (e) => { if (held) { held = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true); // the press that opened the options is not a send
    deps.enterPref.subscribe && deps.enterPref.subscribe(() => { send.title = sendWords(); });
  }
  field.append(plus, taw, count, send);
  const hint = el('div', 'wr-cmphint');
  hint.hidden = true;
  const deliv = el('div', 'wr-dl');
  const list = el('div', 'wr-pop');
  list.hidden = true;
  list.setAttribute('role', 'listbox');
  list.id = 'room-suggestions-' + ++nextSuggestionId;
  list.setAttribute('aria-label', 'Message suggestions');
  ta.setAttribute('role', 'combobox');
  ta.setAttribute('aria-autocomplete', 'list');
  ta.setAttribute('aria-controls', list.id);
  ta.setAttribute('aria-expanded', 'false');
  const popStatus = el('span', 'wr-popstatus');
  popStatus.setAttribute('role', 'status');
  popStatus.setAttribute('aria-live', 'polite');
  const drop = el('div', 'wr-drop');
  drop.hidden = true;
  drop.innerHTML = icon('upload_file');
  const dropT = el('div', 'wr-dropt');
  drop.appendChild(dropT);
  drop.appendChild(el('div', 'wr-drops', 'Images and files up to 25 MB'));
  const confirmBar = el('div', 'wr-confirm');
  confirmBar.hidden = true;
  root.append(offer, confirmBar, chip, nameHint, tray, trayHint, field, hint, deliv, list, popStatus, attachReason);

  const addMenu = el('div', 'wr-addmenu');
  addMenu.hidden = true;
  addMenu.setAttribute('role', 'menu');
  addMenu.setAttribute('aria-label', 'Add to message');
  root.appendChild(addMenu);
  let visit = 0;
  const addRequest = () => { const r = { ...capture(), roomId: st.roomId, visit }; r.isCurrent = () => addCurrent(r); return r; };
  const addCurrent = (r) => current(r) && r.roomId === st.roomId && r.visit === visit;
  const closeAdd = () => { addMenu.hidden = true; plus.setAttribute('aria-expanded', 'false'); };

  // per-room state: the text, the reply target, the tray, the pending (unsent) lines
  const perRoom = new Map();
  const st = { roomId: null, reply: null, files: [], pending: [], pop: null, popItems: [], popAt: 0, draftTimer: null, lastEdit: 0, confirm: null, dragDepth: 0, sending: false };

  function roomState(id) {
    let r = perRoom.get(id);
    if (!r) {
      r = { text: '', reply: null, files: [], pending: [], lastEdit: 0, deliveries: null };
      perRoom.set(id, r);
    }
    return r;
  }

  // ---- the field
  function grow() {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 6 * 20 + 14) + 'px';
  }
  function paintCount() {
    const n = ta.value.length;
    const over = n > MAX;
    if (n >= COUNT_FROM) {
      count.hidden = false;
      count.textContent = fmt(n) + ' / ' + fmt(MAX);
    } else {
      count.hidden = true;
    }
    count.classList.toggle('over', over);
    field.classList.toggle('over', over);
    hint.hidden = !over;
    hint.textContent = '';
    if (over) {
      hint.innerHTML = icon('error');
      hint.appendChild(document.createTextNode(WORDS.tooLong));
    }
    paintSend();
  }
  function canSend() {
    const text = ta.value;
    return !!st.roomId && (!deps.roomConnected || deps.roomConnected(st.roomId)) && !st.moving && !st.sending && (text.trim().length > 0 || trayFiles().length > 0) && text.length <= MAX;
  }
  function paintSend() {
    send.disabled = !canSend();
    const available = filesAvailable();
    attachReason.textContent = deps.filesUnavailableText?.() || ATTACH_UNAVAILABLE;
    plus.disabled = !available;
    plus.title = available ? 'Add a file' : attachReason.textContent;
    attachReason.hidden = available;
    if (available) plus.removeAttribute('aria-describedby');
    else { plus.setAttribute('aria-describedby', attachReason.id); closeAdd(); }

  }
  function setPlaceholder() {
    ta.placeholder = WORDS.placeholder(deps.roomName() || 'the room');
  }

  // ---- the reply chip
  function setReply(r) {
    st.reply = r || null;
    roomState(st.roomId).reply = st.reply;
    ta.placeholder = st.reply && typeof st.reply.placeholder === 'string' ? st.reply.placeholder : WORDS.placeholder(deps.roomName() || 'the room'); // P05: "Say what you want instead"
    chip.textContent = '';
    chip.hidden = !st.reply;
    if (st.reply) {
      chip.innerHTML = icon('reply');
      const t = el('span', 'wr-rplt');
      const b = el('b', null, st.reply.handle);
      t.append(document.createTextNode(WORDS.replying('') + ' '), b, document.createTextNode(' · ' + String(st.reply.excerpt || '')));
      chip.appendChild(t);
      const x = el('button', 'wr-rplx');
      x.type = 'button';
      x.title = 'Stop replying';
      x.setAttribute('aria-label', 'Stop replying');
      x.innerHTML = icon('close');
      x.addEventListener('click', () => {
        dropPrefill();
        setReply(null);
        ta.focus();
      });
      chip.appendChild(x);
      deliv.textContent = '';
      ta.focus();
    }
    scheduleDraft();
    deps.onReplyChanged?.();
  }

  // ---- C8: the reply fills in the names (briefing-table's web/room-reply.mjs applyPrefill / dropPrefill).
  // The prefill is plain text in the field; a cancel takes it back only while the box is exactly what it left.
  function applyPrefill(prefix) {
    let v = ta.value;
    if (st.prefill && v === st.prefill.value) {
      v = v.slice(st.prefill.prefix.length); // the last reply's prefill, untouched: replaced
      ta.value = v;
    }
    const had = st.prefill;
    st.prefill = null;
    if (!prefix || LEADING.test(v.trimStart())) {
      if (had && ta.value !== had.value) {
        onInput();
      }
      return;
    }
    ta.value = prefix + v;
    ta.focus();
    ta.setSelectionRange(prefix.length, prefix.length);
    st.prefill = { prefix, value: ta.value };
    onInput();
    nameHint.hidden = hintSeen;
  }
  function dropPrefill() {
    const p = st.prefill;
    st.prefill = null;
    nameHint.hidden = true;
    if (p && ta.value === p.value) {
      ta.value = p.value.slice(p.prefix.length);
      onInput();
    }
  }
  // Backspace right after an @name takes the whole name (and its space); Ctrl+Z brings it back
  function backspaceName() {
    const at = ta.selectionStart;
    if (at == null || at !== ta.selectionEnd) {
      return false;
    }
    const m = /(^|\s)(@[A-Za-z0-9]+(?:-[A-Za-z0-9]+)* ?)$/.exec(ta.value.slice(0, at));
    if (!m || (!m[2].endsWith(' ') && /[A-Za-z0-9-]/.test(ta.value.charAt(at)))) {
      return false;
    }
    ta.setSelectionRange(at - m[2].length, at);
    document.execCommand('delete'); // keeps the field's undo
    return true;
  }

  // ---- the draft tray
  // ---- removing a tile: gone at once, the engine's copy goes after UNDO_MS unless Undo (the design: "Removed. Undo")
  const UNDO_MS = 8000;
  const pendingRemovals = new Map(); // file record -> {timer, index}
  function commitRemoval(f) {
    const p = pendingRemovals.get(f); if (!p) return;
    clearTimeout(p.timer); pendingRemovals.delete(f);
    if (f.id) f.request.api.scratchRemove(f.roomId, f.id).catch(() => {});
  }
  function flushRemovals() { for (const f of [...pendingRemovals.keys()]) commitRemoval(f); }
  let openMarkupId = null; // the picture the editable viewer has open: its tile keeps a ring
  const coarse = () => { try { return !!window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } };
  const markable = (f) => !!(deps.openImageMarkup && f.image && f.id && !f.uploading && !f.error);
  function openMarkup(f) {
    const pictures = trayFiles().filter(markable);
    const at = pictures.indexOf(f); if (at < 0) return;
    const onMarks = (fileId, count) => { const t = trayFiles().find((x) => x.id === fileId); if (t && t.marks !== count) { t.marks = Number(count) || 0; paintTray(); } };
    const onClose = () => { if (openMarkupId === f.id) { openMarkupId = null; paintTray(); } };
    openMarkupId = f.id; paintTray();
    try { deps.openImageMarkup({ roomId: f.roomId, tray: pictures.map((x) => ({ id: x.id, name: x.name, type: x.type })), index: at, onMarks, onClose }); } catch (e) { openMarkupId = null; paintTray(); }
  }
  function paintTray() {
    tray.textContent = '';
    const shown = trayFiles();
    tray.hidden = !shown.length;
    for (const [index, f] of shown.entries()) {
      const item = el('div', 'wr-tri' + (f.image ? ' img' : '') + (f.error ? ' err' : '') + (openMarkupId && f.id === openMarkupId ? ' open' : ''));
      item.title = f.name + (f.error ? ' · ' + f.error : '');
      const can = markable(f);
      // a picture that can be marked up is a button (the picture, its number and its pencil); the ✕ is its sibling, never inside it
      let face = item;
      if (can) {
        face = el('button', 'wr-trib'); face.type = 'button';
        face.setAttribute('aria-label', 'Mark up ' + f.name + (shown.length > 1 ? ', attachment ' + (index + 1) : '') + (f.marks > 0 ? ', ' + marksWords(f.marks) : ''));
        face.addEventListener('click', () => openMarkup(f));
        face.addEventListener('keydown', (e) => { if (e.key === 'Delete') { e.preventDefault(); removeFile(f, true); } });
        item.appendChild(face);
      }
      if (f.image && f.preview) {
        const img = document.createElement('img');
        img.src = f.preview;
        img.alt = can ? '' : f.name;
        face.appendChild(img);
      } else {
        face.innerHTML = icon(f.noteId ? 'sticky_note_2' : f.image ? 'image' : 'description');
        const tx = el('span', 'wr-trit');
        tx.appendChild(el('span', 'n', f.name));
        tx.appendChild(el('span', 's', f.uploading ? 'uploading…' : f.error ? f.error : f.noteId ? f.words + (f.words === 1 ? ' word' : ' words') : sizeWords(f.size)));
        face.appendChild(tx);
      }
      if (f.noteId && deps.openNote) {
        item.tabIndex = 0; item.setAttribute('role', 'button');
        const open = () => deps.openNote(f.noteId, addRequest());
        item.addEventListener('click', open);
        item.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      }
      if (shown.length > 1) face.appendChild(el('span', 'wr-trinum', String(index + 1)));
      if (f.marks > 0) { const pen = el('span', 'wr-trimk'); pen.innerHTML = icon('edit'); pen.setAttribute('role', 'img'); pen.setAttribute('aria-label', marksWords(f.marks)); pen.title = marksWords(f.marks); face.appendChild(pen); }
      if (f.uploading) {
        item.appendChild(el('span', 'wr-triup'));
      }
      const x = el('button', 'wr-trix');
      x.type = 'button';
      x.title = 'Remove';
      x.setAttribute('aria-label', 'Remove ' + f.name);
      x.innerHTML = icon('close');
      x.addEventListener('click', e => { e.stopPropagation(); removeFile(f, true); });
      item.appendChild(x);
      tray.appendChild(item);
    }
    // the line under the tiles: tells a person a picture does something; gone once any picture has marks
    const markables = shown.filter(markable);
    const hint = markables.length > 0 && !markables.some((f) => f.marks > 0);
    trayHint.hidden = !hint;
    trayHint.textContent = hint ? (coarse() ? 'Tap a picture to mark it up.' : 'Click a picture to mark it up.') : '';
    paintSend();
    deps.onAttachmentsChanged?.();
  }
  async function addFiles(files, request = capture()) {
    if (!filesAvailable()) { deps.snackbar?.(attachReason.textContent); return; }
    const roomId = st.roomId;
    for (const file of files) {
      if (!current(request) || !roomId || st.roomId !== roomId) return;
      if (trayFiles().length >= TRAY_MAX) {
        deps.snackbar(WORDS.trayFull);
        break;
      }
      if (file.size > FILE_MAX) {
        deps.snackbar(WORDS.overSize(file.name));
        continue;
      }
      const f = { request, src: file, roomId, local: 'l' + Math.random().toString(36).slice(2), name: file.name, type: file.type || 'application/octet-stream', size: file.size, image: /^image\//.test(file.type || ''), uploading: true, id: null, preview: null, error: null };
      st.files.push(f);
      roomState(st.roomId).files = st.files;
      // a picked file carries its bytes as `data` (a File's own .bytes() is a method in Chromium)
      if (f.image && file.data) {
        f.preview = 'data:' + f.type + ';base64,' + bytesToBase64(file.data);
      } else if (f.image && file.slice && file.size <= 4 * 1024 * 1024) {
        // a data: URL, read from the file (the page's CSP allows img-src data:, never blob:)
        f.preview = await new Promise((resolve) => {
          const rd = new FileReader();
          rd.onload = () => resolve(String(rd.result || '') || null);
          rd.onerror = () => resolve(null);
          rd.readAsDataURL(file);
        });
      }
      if (!current(request) || st.roomId !== roomId) return;
      paintTray();
      await upload(f);
    }
  }
  /** One tray item to its room's scratch tray; a failure keeps it with the error outline and offers Try again. */
  async function upload(f) {
    const request = f.request;
    if (!current(request)) return;
    const file = f.src;
    f.uploading = true;
    f.error = null;
    paintTray();
    let bytes;
    try {
      bytes = file.data || new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      bytes = null;
    }
    if (!current(request)) return;
    const r = bytes ? await request.api.scratchUpload(f.roomId, f.name, f.type, bytes, f.local, roomState(f.roomId).files.indexOf(f)).catch(() => null) : null;
    if (!current(request)) return;
    f.uploading = false;
    if (r && r.ok && r.value && r.value.file) {
      f.id = r.value.file.id;
      f.src = null;
      f.companionOf = r.value.file.companionOf || null; // the engine marks a picture's <name>.annotations.svg: it rides with its picture and is never a tile
    } else if (r && r.ok === false && /limit is \d+ per message/.test(String(r.message || ''))) {
      // the engine's draft already holds the most a message can carry: nothing was stored, so the tile goes and the person is told
      st.files = st.files.filter((x) => x !== f);
      roomState(f.roomId).files = st.files;
      deps.snackbar(WORDS.trayFull);
    } else {
      f.error = "Couldn't upload";
      deps.snackbar(WORDS.uploadFailed(f.name), { action: { label: 'Try again', fn: () => roomState(f.roomId).files.includes(f) && upload(f) } });
    }
    paintTray();
  }
  /** Files an earlier page left in the room's scratch tray still count toward the 10: show them in the tray (as chips; the picture itself is not re-read). */
  const adoptedRooms = new Set();
  async function adoptLeftovers(roomId) {
    if (adoptedRooms.has(roomId)) return;
    adoptedRooms.add(roomId);
    const request = capture();
    const r = await request.api.scratch?.(roomId).catch(() => null);
    if (!r || !r.ok || !r.value || !Array.isArray(r.value.files)) { adoptedRooms.delete(roomId); return; }
    if (!current(request) || st.roomId !== roomId) return;
    const rs = roomState(roomId);
    const known = new Set(rs.files.map((f) => f.id).filter(Boolean));
    const extra = r.value.files.filter((x) => x && typeof x.id === 'string' && !known.has(x.id)).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
    if (!extra.length) return;
    for (const x of extra) {
      rs.files.push({ request, roomId, local: 'l' + Math.random().toString(36).slice(2), id: x.id, name: String(x.name || 'file'), type: String(x.type || 'application/octet-stream'), size: Number(x.size) || 0, image: /^image\//.test(String(x.type || '')), uploading: false, error: null, marks: 0, companionOf: x.companionOf || null, preview: null, src: null });
    }
    if (st.roomId === roomId) { st.files = rs.files; paintTray(); }
  }
  function bytesToBase64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }
  async function removeFile(f, withUndo = false) {
    if (!current(f.request)) return;
    const index = st.files.indexOf(f);
    st.files = st.files.filter((x) => x !== f);
    roomState(st.roomId).files = st.files;
    paintTray();
    if (!f.id) return;
    if (!withUndo) { f.request.api.scratchRemove(f.roomId, f.id).catch(() => {}); return; }
    const timer = setTimeout(() => commitRemoval(f), UNDO_MS);
    pendingRemovals.set(f, { timer, index });
    deps.snackbar?.('Removed.', { action: { label: 'Undo', fn: () => {
      const p = pendingRemovals.get(f); if (!p) return;
      clearTimeout(p.timer); pendingRemovals.delete(f);
      const rs = roomState(f.roomId);
      if (!rs.files.includes(f)) { rs.files.splice(Math.min(p.index, rs.files.length), 0, f); if (st.roomId === f.roomId) st.files = rs.files; }
      if (st.roomId === f.roomId) paintTray();
    } } });
  }
  function clearTray() {
    flushRemovals();
    st.files = [];
    roomState(st.roomId).files = [];
    paintTray();
  }

  // ---- drop and paste
  function hostEl() {
    return deps.host;
  }
  listen(hostEl(), 'dragenter', (e) => {
    if (!filesAvailable() || !st.roomId || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) {
      return;
    }
    st.dragDepth += 1;
    dropT.textContent = 'Drop to attach to ' + (deps.roomName() || 'the room');
    drop.hidden = false;
    e.preventDefault();
  });
  listen(hostEl(), 'dragover', (e) => {
    if (!drop.hidden) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  listen(hostEl(), 'dragleave', () => {
    st.dragDepth = Math.max(0, st.dragDepth - 1);
    if (!st.dragDepth) {
      drop.hidden = true;
    }
  });
  listen(hostEl(), 'drop', (e) => {
    if (drop.hidden) {
      return;
    }
    e.preventDefault();
    st.dragDepth = 0;
    drop.hidden = true;
    addFiles([...(e.dataTransfer.files || [])]);
  });
  ta.addEventListener('paste', (e) => {
    const files = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (files.length) {
      e.preventDefault();
      addFiles(files); // "Paste does the same without the overlay"
    }
  });
  function hasNote(id) { return st.files.some(f => f.noteId === id); }
  function putNote(attachment, note, request = addRequest()) {
    const file = attachment?.file || attachment;
    if (!filesAvailable() || !addCurrent(request) || !file?.id || !note?.id) return false;
    const index = st.files.findIndex(f => f.noteId === note.id);
    if (index < 0 && trayFiles().length >= TRAY_MAX) { deps.snackbar(WORDS.trayFull); return false; }
    const text = String(note.text || '');
    const title = attachment.title || file.title || text.replace(/\s+/g, ' ').trim().slice(0, 40) || 'Untitled note';
    const words = Number.isInteger(attachment.words) && attachment.words >= 0 ? attachment.words : text.split(/\s+/).filter(Boolean).length;
    const f = { ...file, request, roomId: st.roomId, noteId: note.id, kind: 'note', title, words,
      name: title, type: file.type || 'text/plain', size: file.size || attachment.bytes_length || text.length, image: false, uploading: false };
    if (index < 0) st.files.push(f); else st.files[index] = f;
    roomState(st.roomId).files = st.files;
    paintTray(); return true;
  }
  async function moveDraft(request) {
    if (!filesAvailable() || !addCurrent(request) || !ta.value.trim() || st.moving) return;
    const text = ta.value;
    st.moving = true; paintSend();
    try {
      const saved = await request.api.noteCreate(request.roomId, text);
      if (!addCurrent(request)) return;
      const note = saved?.ok && saved.value?.note;
      if (!note?.id || note.text !== text) throw new Error('save');
      const attached = await request.api.noteAttach(request.roomId, note.id);
      if (!addCurrent(request)) return;
      if (!attached?.ok || !putNote(attached.value?.attachment, attached.value?.note || { ...note, text }, request)) throw new Error('attach');
      if (ta.value === text) { ta.value = ''; onInput(); }
      deps.snackbar('Draft moved to a note');
    } catch {
      if (addCurrent(request)) deps.snackbar("Couldn't move the draft. Your draft was kept.");
    } finally { if (addCurrent(request)) { st.moving = false; paintSend(); } }
  }
  plus.addEventListener('click', () => {
    if (!filesAvailable()) return;
    if (!addMenu.hidden) { closeAdd(); return; }
    const request = addRequest();
    if (!request.roomId) return;
    addMenu.textContent = '';
    addMenu.appendChild(el('div', 'wr-addtitle', 'Add'));
    const actions = [
      ['Attach a file', 'attach_file', async () => {
        const picked = await request.api.pickFiles();
        if (addCurrent(request) && picked?.length) await addFiles(picked.map(p => ({ name: p.name, type: p.type, size: p.size ?? p.bytes.length, data: p.bytes })), request);
      }],
      ['New note', 'sticky_note_2', () => deps.newNote?.(request)],
      ['Move draft to a note', 'note_add', () => moveDraft(request)],
    ];
    for (const [label, glyph, fn] of actions) {
      const button = el('button', 'wr-additem'); button.type = 'button'; button.setAttribute('role', 'menuitem');
      button.innerHTML = icon(glyph); button.appendChild(document.createTextNode(label));
      button.disabled = label === 'Move draft to a note' && (!ta.value.trim() || st.moving);
      button.addEventListener('click', async () => { if (!addCurrent(request) || button.disabled) return; closeAdd(); await fn(); });
      addMenu.appendChild(button);
    }
    addMenu.hidden = false; plus.setAttribute('aria-expanded', 'true');
    addMenu.querySelector('button')?.focus();
  });
  root.addEventListener('keydown', e => {
    if (addMenu.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAdd(); plus.focus(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = [...addMenu.querySelectorAll('button')].filter(b => !b.disabled);
      const at = items.indexOf(document.activeElement);
      items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus(); e.preventDefault();
    }
  });
  listen(document, 'pointerdown', e => { if (!addMenu.contains(e.target) && !plus.contains(e.target)) closeAdd(); });

  // ---- the @ list and the slash list
  let popVersion = 0, catalog = null, filledCommand = null, keyboardPop = false, popQuery = '';
  let catalogRows = [], usageHint = false, completedHandleCommand = null;
  function closePop(keepCatalog = false) {
    popVersion++; if (!keepCatalog) catalog = null; filledCommand = null;
    catalogRows = []; usageHint = false; completedHandleCommand = null;
    st.pop = null; st.popItems = []; st.popAt = 0;
    list.hidden = true; list.textContent = ''; popStatus.textContent = '';
    ta.setAttribute('aria-expanded', 'false'); ta.removeAttribute('aria-activedescendant');
  }
  /** Who you can address: the room's seats, then @lead, @room and the family's other rooms by alias (ROOMS-API.md §3.2). */
  function addresses() {
    return [...deps.seats().map((x) => ({ ...x, seat: true })), ...(deps.extraAddresses ? deps.extraAddresses() : [])];
  }
  function atQuery() {
    const v = ta.value.slice(0, ta.selectionStart);
    const m = /(?:^|\s)@([A-Za-z0-9_.-]*)$/.exec(v);
    return m ? m[1] : null;
  }
  function slashQuery() {
    return commandQuery(ta.value, ta.selectionStart, ta.selectionEnd);
  }
  async function paintPop() {
    const version = ++popVersion, request = capture(), room = st.roomId, opened = visit;
    const sq = slashQuery(), aq = atQuery();
    if (sq != null && aq == null) {
      if (sq !== popQuery) {
        st.popItems = []; st.popAt = 0; list.hidden = true;
        ta.setAttribute('aria-expanded', 'false'); ta.removeAttribute('aria-activedescendant');
      }
      st.pop = 'slash'; popQuery = sq;
      if (!catalog) catalog = Promise.resolve().then(() => request.api.commands());
      let r;
      try { r = await catalog; } catch { r = null; }
      if (version !== popVersion || !current(request) || opened !== visit || st.roomId !== room || slashQuery() !== sq) return;
      // Remember a failed request until Escape/close, rather than retrying per key.
      if (!r?.ok || !Array.isArray(r.value?.commands)) { closePop(true); return; }
      const rows = commandRows(r.value.commands);
      catalogRows = rows; usageHint = false;
      if (completedHandleCommand && ta.value.toLowerCase().startsWith(completedHandleCommand.fill.toLowerCase())) {
        st.popItems = []; list.hidden = true; popStatus.textContent = '';
        ta.setAttribute('aria-expanded', 'false'); ta.removeAttribute('aria-activedescendant');
        return;
      }
      completedHandleCommand = null;
      if (filledCommand && ta.value === filledCommand.fill) st.popItems = [filledCommand];
      else {
        filledCommand = null;
        st.popItems = matchCommands(rows, sq);
        if (!st.popItems.length && argumentStarted(rows, ta.value)) {
          filledCommand = usageCommand(rows, ta.value);
          st.popItems = filledCommand ? [filledCommand] : []; usageHint = !!filledCommand;
        }
      }
    } else if (aq != null) {
      usageHint = false;
      st.popItems = addresses().filter(s => s.handle.toLowerCase().startsWith(aq.toLowerCase())).map(s =>
        ({ kind: 'at', handle: s.handle, seat: s.seat, glyph: s.glyph, text: '@' + s.handle, sub: s.state || '' }));
      st.pop = 'at'; popQuery = aq;
      if (!st.popItems.length) { closePop(); return; }
    } else { closePop(); return; }
    st.popAt = Math.min(st.popAt, Math.max(0, st.popItems.length - 1));
    renderPop();
  }
  function highlighted(host, text) {
    const query = popQuery.trim().toLowerCase(), at = query ? text.toLowerCase().indexOf(query) : -1;
    if (at < 0) { host.appendChild(document.createTextNode(text)); return; }
    host.append(document.createTextNode(text.slice(0, at)), el('strong', null, text.slice(at, at + query.length)), document.createTextNode(text.slice(at + query.length)));
  }
  function renderPop() {
    list.textContent = '';
    list.className = 'wr-pop ' + st.pop + (keyboardPop ? ' keyboard' : '') + (filledCommand ? ' usage' : '');
    list.hidden = false; ta.setAttribute('aria-expanded', 'true');
    popStatus.textContent = st.popItems.length + (st.pop === 'slash' ? ' command' : ' suggestion') + (st.popItems.length === 1 ? '' : 's');
    const grouped = st.pop === 'slash' && !popQuery && st.popItems.length && st.popItems.every(it => it.group);
    let group = '';
    if (!st.popItems.length) {
      const row = el('div', 'wr-popempty');
      row.append(el('div', null, 'No command matches /' + popQuery), el('div', 'wr-popd', 'Type / to see them all.'));
      list.appendChild(row); ta.removeAttribute('aria-activedescendant');
    }
    st.popItems.forEach((it, i) => {
      if (grouped && group !== it.group) { group = it.group; const heading = el('div', 'wr-popgroup', group); heading.setAttribute('role', 'presentation'); list.appendChild(heading); }
      const row = el('div', 'wr-popr' + (i === st.popAt ? ' on' : ''));
      row.id = list.id + '-' + i;
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(i === st.popAt));
      if (i === st.popAt) ta.setAttribute('aria-activedescendant', row.id);
      if (it.kind === 'at') {
        if (it.seat) row.appendChild(avatarEl(it.handle, 24, deps.seatIndex && deps.seatIndex(it.handle)));
        else if (it.glyph) { const g = el('span', 'wr-popg'); g.innerHTML = icon(it.glyph); row.appendChild(g); }
        row.append(el('span', 'wr-popt', it.text), el('span', 'wr-pops', it.sub));
      } else {
        const title = el('div', 'wr-popt');
        if (it.argumentAt >= 0) {
          highlighted(title, it.text.slice(0, it.argumentAt));
          const args = el('span', 'wr-popargs'); highlighted(args, it.text.slice(it.argumentAt)); title.appendChild(args);
        } else highlighted(title, it.text);
        const description = el('div', 'wr-popd'); highlighted(description, it.sub); description.title = it.sub;
        row.append(title, description);
      }
      row.addEventListener('pointerenter', () => { keyboardPop = false; st.popAt = i; updatePopSelection(); });
      row.addEventListener('pointerdown', e => e.preventDefault());
      row.addEventListener('click', () => { clearTimeout(blurTimer); st.popAt = i; pick(); ta.focus(); });
      list.appendChild(row);
    });
  }
  function updatePopSelection() {
    list.classList.toggle('keyboard', keyboardPop);
    const rows = [...list.querySelectorAll('[role="option"]')];
    rows.forEach((row, i) => { row.classList.toggle('on', i === st.popAt); row.setAttribute('aria-selected', String(i === st.popAt)); });
    const selected = rows[st.popAt];
    if (selected) { ta.setAttribute('aria-activedescendant', selected.id); if (keyboardPop) selected.scrollIntoView?.({ block: 'nearest' }); }
  }
  function pick() {
    const it = st.popItems[st.popAt];
    if (!it) {
      return;
    }
    if (usageHint) return; // The format is a hint: never replace an argument being typed.
    const head = ta.value.slice(0, ta.selectionStart);
    const tail = ta.value.slice(ta.selectionStart);
    if (it.kind === 'at') {
      const cut = head.replace(/@[A-Za-z0-9_.-]*$/, '');
      ta.value = cut + '@' + it.handle + ' ' + tail;
      ta.selectionStart = ta.selectionEnd = cut.length + it.handle.length + 2;
      const command = usageCommand(catalogRows, ta.value);
      if (command && !hasFollowingArguments(command, ta.value)) completedHandleCommand = command;
    } else {
      ta.value = it.fill;
      ta.selectionStart = ta.selectionEnd = it.fill.length;
    }
    if (it.kind === 'slash') { filledCommand = it; st.popAt = 0; }
    else if (!usageCommand(catalogRows, ta.value)) closePop();
    onInput();
  }
  /** Tab continues the last @address: the first seat matching the prefix at the caret, or the next match. */
  function tabContinue() {
    const q = atQuery();
    if (q == null) {
      return false;
    }
    const seats = addresses();
    const match = seats.find((s) => s.handle.toLowerCase().startsWith(q.toLowerCase()) && s.handle.toLowerCase() !== q.toLowerCase()) || seats.find((s) => s.handle.toLowerCase().startsWith(q.toLowerCase()));
    if (!match) {
      return false;
    }
    const head = ta.value.slice(0, ta.selectionStart).replace(/@[A-Za-z0-9_.-]*$/, '');
    const tail = ta.value.slice(ta.selectionStart);
    ta.value = head + '@' + match.handle + ' ' + tail;
    ta.selectionStart = ta.selectionEnd = head.length + match.handle.length + 2;
    closePop();
    onInput();
    return true;
  }

  // ---- the draft on the server (saved as you type, read when the room opens)
  function scheduleDraft() {
    clearTimeout(st.draftTimer);
    const request = draftRequest;
    st.draftTimer = setTimeout(() => saveDraft(request), DRAFT_SAVE_MS);
  }
  let draftRequest = null;
  let lastSaved = { text: '', reply_to: null };
  async function saveDraft(request = draftRequest) {
    if (!current(request)) return;
    const id = st.roomId;
    if (!id || (deps.roomConnected && !deps.roomConnected(id))) {
      return;
    }
    const text = ta.value;
    const reply_to = st.reply ? st.reply.id : null;
    if (text === lastSaved.text && reply_to === lastSaved.reply_to) {
      return;
    }
    lastSaved = { text, reply_to };
    await request.api.setDraft(id, text, reply_to).catch(() => {});
  }
  async function readDraft(id) {
    const request = capture(), opened = visit;
    const r = await request.api.draft(id);
    if (!current(request) || opened !== visit || !r || !r.ok || !r.value || st.roomId !== id) {
      return;
    }
    const d = r.value;
    const local = roomState(id);
    if (!d.text) {
      return;
    }
    if (!local.text || (d.updatedAt > local.lastEdit && d.text !== local.text)) {
      if (!local.text) {
        // nothing typed here: the server's draft is the draft
        ta.value = d.text;
        local.text = d.text;
        lastSaved = { text: d.text, reply_to: d.reply_to || null };
        if (d.reply) {
          setReply({ id: d.reply.id || d.reply_to, handle: d.reply.handle, excerpt: d.reply.excerpt });
        }
        grow();
        paintCount();
      } else {
        showOffer(d, request);
      }
    }
  }
  function showOffer(d, request) {
    offer.textContent = '';
    offer.hidden = false;
    offer.innerHTML = icon('devices');
    // the engine's draft carries no device name (ROOMS-API.md §3.2): "another device" until it does
    offer.appendChild(el('span', 'grow', WORDS.newer(d.device || 'another device', agoWords(d.updatedAt || Date.now()))));
    const use = el('button', 'wr-txtb', WORDS.useIt);
    use.type = 'button';
    use.addEventListener('click', () => {
      if (!current(request)) return;
      ta.value = d.text;
      roomState(st.roomId).text = d.text;
      lastSaved = { text: d.text, reply_to: d.reply_to || null };
      if (d.reply) {
        setReply({ id: d.reply.id || d.reply_to, handle: d.reply.handle, excerpt: d.reply.excerpt });
      }
      offer.hidden = true;
      grow();
      paintCount();
      ta.focus();
    });
    const keep = el('button', 'wr-txtb', WORDS.keepThis);
    keep.type = 'button';
    keep.addEventListener('click', () => {
      if (!current(request)) return;
      offer.hidden = true;
      scheduleDraft(); // this one wins: it goes to the server
    });
    offer.append(use, keep);
  }

  // ---- sending, the pending line, Not sent, the offline wait
  let localId = -1;
  function pendingEntry(text, files, reply) {
    const id = localId--;
    return { request: capture(), id, room_id: st.roomId, ts: Date.now(), kind: files.length ? 'attachment' : 'chat', author: 'user', target: null, body: text || null, meta: { ...(reply ? { reply: { id: reply.id, handle: reply.handle, excerpt: reply.excerpt, user: reply.user } } : {}), ...(files.length ? { attachments: files.map((f) => ({ name: f.name, type: f.type, size: f.size, ...(f.noteId ? { kind: 'note', title: f.title, words: f.words } : {}) })) } : {}), local: { state: 'sending' } }, pending: true };
  }
  async function doSend() {
    if (!canSend()) {
      return;
    }
    const text = ta.value;
    const local = /^\/([a-z]+)\s*$/.exec(text.trim());
    if (local && !trayFiles().length && deps.localCommand && deps.localCommand(local[1])) {
      ta.value = '';
      roomState(st.roomId).text = '';
      closePop();
      grow();
      paintCount();
      scheduleDraft();
      return;
    }
    const files = trayFiles().filter((f) => f.id);
    if (st.files.some((f) => f.uploading)) {
      deps.snackbar('Still uploading…');
      return;
    }
    const reply = st.reply;
    const entry = pendingEntry(text, files, reply);
    entry.sentFiles = files; // a refused send puts them back in the tray (they are still in the engine's scratch tray)
    const rs = roomState(st.roomId);
    rs.pending.push(entry);
    deps.pendingAdd(entry);
    deps.scrollToBottom();
    ta.value = '';
    rs.text = '';
    lastSaved = { text: '', reply_to: null };
    clearTray();
    st.prefill = null;
    nameHint.hidden = true;
    setReply(null);
    closePop();
    grow();
    paintCount();
    await attempt(entry, { text, attachments: files.map((f) => f.id), reply_to: reply ? reply.id : undefined });
  }
  function restoreFiles(entry) {
    const files = entry.sentFiles; if (!files || !files.length) return;
    const rs = roomState(entry.room_id);
    for (const f of files) if (!rs.files.includes(f)) rs.files.push(f);
    if (st.roomId === entry.room_id) { st.files = rs.files; paintTray(); }
  }
  /** What a person reads when the server refuses a send: the shared map's sentence for a missing file store, never the operator's text or a variable name. */
  function refusalWords(r, a) {
    const text = String(r.message || '');
    const carriesFiles = !!(a && Array.isArray(a.attachments) && a.attachments.length);
    // ANY 503 on a send that carries files, the old operator text, or a variable name anywhere: the one sentence, never the engine's words
    if ((r.status === 503 && (carriesFiles || /file store/i.test(text))) || /HARBOR_|\/set store/.test(text)) {
      const say = globalThis.wb && globalThis.wb.web && globalThis.wb.web.files && globalThis.wb.web.files.serverAnswer;
      let said = null; try { said = say ? say('send.file', { status: 503, reason: text }) : null; } catch (e) { said = null; }
      return typeof said === 'string' && said && !/HARBOR_|\/set store/.test(said) ? said : WORDS.noFileStore;
    }
    return text;
  }
  async function attempt(entry, a) {
    const request = entry.request;
    if (!current(request)) return;
    const paused = deps.roomConnected && !deps.roomConnected(entry.room_id);
    entry.meta.local = { state: paused || deps.conn() === 'offline' ? 'waiting' : 'sending' };
    entry.req = a;
    deps.pendingUpdate(entry);
    if (paused || deps.conn() === 'offline') {
      return; // "Offline: it waits as 'Sending when you're back online' and goes out by itself"
    }
    st.sending = true;
    paintSend();
    const r = await request.api.post(entry.room_id, a);
    if (!current(request)) return;
    st.sending = false;
    paintSend();
    const rs = roomState(entry.room_id);
    if (r && r.ok && r.value) {
      const v = r.value;
      if (v.status === 'refused') {
        rs.pending = rs.pending.filter((e) => e !== entry);
        deps.pendingRemove(entry.id);
        deps.snackbar((v.refused && v.refused.error) || WORDS.unknown(String(a.text || '').slice(1).split(/\s+/)[0] || ''));
        restoreFiles(entry);
        ta.value = a.text || '';
        grow();
        paintCount();
        return;
      }
      if (v.status === 'confirm' && v.confirm) {
        rs.pending = rs.pending.filter((e) => e !== entry);
        deps.pendingRemove(entry.id);
        showConfirm(v.confirm, a, request);
        return;
      }
      if (v.client && v.client.action === 'help') {
        rs.pending = rs.pending.filter((e) => e !== entry);
        deps.pendingRemove(entry.id);
        ta.value = '/';
        ta.focus();
        onInput(); // the list, as the engine's answer
        return;
      }
      rs.pending = rs.pending.filter((e) => e !== entry);
      deps.pendingRemove(entry.id); // the real line arrived with the answer (main broadcast it)
      if (Array.isArray(v.deliveries) && v.deliveries.length) {
        const names = v.deliveries.filter((d) => d.delivered).map((d) => d.handle);
        rs.deliveries = names;
        deliv.textContent = names.length ? WORDS.reached(names) : '';
      }
      return;
    }
    const code = r && r.code;
    if (code === 'signed-out') {
      rs.pending = rs.pending.filter((e) => e !== entry);
      deps.pendingRemove(entry.id);
      return;
    }
    if (code === 'http' && r.message) {
      rs.pending = rs.pending.filter((e) => e !== entry);
      deps.pendingRemove(entry.id);
      deps.snackbar(refusalWords(r, a));
      restoreFiles(entry);
      ta.value = a.text || '';
      grow();
      paintCount();
      return;
    }
    // unreachable / down: the message stays in the line, yours, with Not sent · Try again · Delete
    entry.meta.local = { state: code === 'offline' || deps.conn() === 'offline' ? 'waiting' : 'failed' };
    deps.pendingUpdate(entry);
  }
  function retry(id) {
    const rs = roomState(st.roomId);
    const e = rs.pending.find((x) => x.id === id);
    if (e && e.req) {
      attempt(e, e.req);
    }
  }
  function discard(id) {
    const rs = roomState(st.roomId);
    rs.pending = rs.pending.filter((x) => x.id !== id);
    deps.pendingRemove(id);
  }
  function connChanged() {
    const c = deps.conn();
    if (c === 'live' || c === 'polling') {
      for (const [, rs] of perRoom) {
        for (const e of rs.pending.slice()) {
          if (e.meta.local && e.meta.local.state === 'waiting' && e.req) {
            attempt(e, e.req);
          }
        }
      }
    } else if (c === 'offline') {
      for (const [, rs] of perRoom) {
        for (const e of rs.pending) {
          if (e.meta.local && e.meta.local.state === 'failed') {
            e.meta.local = { state: 'waiting' };
            deps.pendingUpdate(e);
          }
        }
      }
    }
  }
  function showConfirm(c, a, request) {
    st.confirm = { token: c.token, a };
    confirmBar.textContent = '';
    confirmBar.hidden = false;
    confirmBar.innerHTML = icon('help');
    const q = /^[^?]*\?/.exec(String(c.prompt || ''));
    confirmBar.appendChild(el('span', 'grow', q ? q[0] : c.prompt || 'Are you sure?'));
    const ok = el('button', 'wr-txtb', 'Confirm');
    ok.type = 'button';
    ok.addEventListener('click', async () => {
      if (!current(request)) return;
      confirmBar.hidden = true;
      const entry = pendingEntry(a.text, [], null);
      roomState(st.roomId).pending.push(entry);
      deps.pendingAdd(entry);
      await attempt(entry, { ...a, confirm: st.confirm.token });
      st.confirm = null;
    });
    const no = el('button', 'wr-txtb', 'Cancel');
    no.type = 'button';
    no.addEventListener('click', () => {
      confirmBar.hidden = true;
      st.confirm = null;
    });
    confirmBar.append(ok, no);
  }

  // ---- input and keys
  function onInput() {
    if (!nameHint.hidden && st.prefill && ta.value !== st.prefill.value) {
      nameHint.hidden = true; // the first edit dismisses it, for good
      hintSeen = true;
      try {
        localStorage.setItem('wb.rooms.prefillHint', '1');
      } catch (e) {
        // shown again next time
      }
    }
    const rs = roomState(st.roomId);
    rs.text = ta.value;
    rs.lastEdit = Date.now();
    grow();
    paintCount();
    paintPop();
    scheduleDraft();
  }
  ta.addEventListener('input', () => { keyboardPop = true; onInput(); });
  ta.addEventListener('click', () => { if (!list.hidden) paintPop(); });
  ta.addEventListener('keyup', e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) && !list.hidden) paintPop(); });
  list.addEventListener('pointerdown', () => clearTimeout(blurTimer));
  ta.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Escape' && (st.pop || catalog)) { closePop(); e.preventDefault(); return; }
    if (e.key === 'Tab' && usageHint) return; // A format hint must not trap keyboard focus.
    if (!list.hidden && !e.shiftKey) {
      if (e.key === 'ArrowDown' && st.popItems.length) {
        keyboardPop = true;
        st.popAt = (st.popAt + 1) % st.popItems.length;
        updatePopSelection();
        e.preventDefault();
        return;
      }
      if (e.key === 'ArrowUp' && st.popItems.length) {
        keyboardPop = true;
        st.popAt = (st.popAt - 1 + st.popItems.length) % st.popItems.length;
        updatePopSelection();
        e.preventDefault();
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && st.popItems.length) {
        const item = st.popItems[st.popAt];
        if (e.key === 'Enter' && item.kind === 'slash' && (usageHint || (item.sendsBare && ta.value.trim().toLowerCase() === item.name.toLowerCase()))) { closePop(); e.preventDefault(); doSend(); return; }
        pick();
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        closePop();
        e.preventDefault();
        return;
      }
    }
    if (e.key === 'Tab' && !e.shiftKey && tabContinue()) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && (enterSends() || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      doSend();
      return;
    }
    if (e.key === 'Escape') closePop(); // Also invalidate a catalog request that has not painted yet.
    if (e.key === 'Escape' && st.reply) {
      dropPrefill();
      setReply(null);
      e.preventDefault();
    }
    if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && backspaceName()) {
      e.preventDefault();
    }
  });
  ta.addEventListener('blur', () => { clearTimeout(blurTimer); if (!destroyed) blurTimer = setTimeout(closePop, 120); });
  send.addEventListener('click', doSend);

  return {
    el: root,
    drop,
    recolor(){if(destroyed)return;if(paintFrame!=null)cancelAnimationFrame(paintFrame);paint();},
    /** The room changed: its own text, reply, tray and pending lines come back; the draft is read. */
    open(roomId) {
      if (destroyed) return;
      if (st.roomId === roomId) {
        return; // the same room again (a repaint, the tab shown again): what's on screen stays
      }
      visit++; closeAdd(); st.moving = false;
      clearTimeout(st.draftTimer);
      if (st.roomId && st.roomId !== roomId) {
        saveDraft(); // the room you leave keeps its draft on the server, even inside the 800 ms
      }
      st.roomId = roomId;
      draftRequest = capture();
      void adoptLeftovers(roomId);
      const rs = roomState(roomId);
      ta.value = rs.text;
      st.files = rs.files;
      lastSaved = { text: rs.text, reply_to: rs.reply ? rs.reply.id : null };
      setPlaceholder();
      offer.hidden = true;
      confirmBar.hidden = true;
      closePop();
      st.reply = null;
      st.prefill = null;
      nameHint.hidden = true;
      chip.hidden = true;
      if (rs.reply) {
        setReply(rs.reply);
      }
      paintTray();
      deliv.textContent = rs.deliveries && rs.deliveries.length ? WORDS.reached(rs.deliveries) : '';
      grow();
      paintCount();
      if (rs.disconnectedDraft) {
        rs.disconnectedDraft = false;
        lastSaved = { text: null, reply_to: null };
        scheduleDraft();
      } else readDraft(roomId);
    },
    /** The line (re)drew: this room's unsent lines go back at its end. */
    pendingAgain() {
      for (const e of roomState(st.roomId).pending) {
        deps.pendingAdd(e);
      }
    },
    resetAccount() {
      draftRequest = null;
      generation++; visit++; closeAdd(); st.moving = false;
      clearTimeout(st.draftTimer);
      st.roomId = null; st.files = []; st.reply = null; st.pending = []; st.sending = false;
      st.confirm = null; st.prefill = null; st.dragDepth = 0;
      perRoom.clear(); ta.value = ''; lastSaved = { text: '', reply_to: null };
      offer.hidden = true; confirmBar.hidden = true; chip.hidden = true; nameHint.hidden = true; drop.hidden = true; closePop();
      paintTray(); paintCount();
    },
    destroy() {
      if (destroyed) return;
      flushRemovals();
      clearTimeout(st.draftTimer); clearTimeout(blurTimer);
      // Capture the current bound account before fencing in-flight work. saveDraft
      // snapshots room/text synchronously and never retries under a new account.
      saveDraft(draftRequest);
      destroyed = true; generation++; visit++;
      if (paintFrame != null) cancelAnimationFrame(paintFrame);
      for (const cleanup of cleanups.splice(0)) cleanup();
      closeAdd(); closePop(); st.dragDepth = 0; drop.hidden = true;
      root.remove(); drop.remove();
      // Pending sends/drafts are not discarded or sent under another account.
    },
    close({ save = true } = {}) {
      closePop();
      visit++; closeAdd(); st.moving = false;
      clearTimeout(st.draftTimer);
      if (save) saveDraft();
      else if (st.roomId) {
        const rs = roomState(st.roomId);
        rs.text = ta.value;
        rs.disconnectedDraft = true;
      }
      st.roomId = null;
    },
    /** Reply to a line: the chip, and (C8) its names filled in, `r.prefill` ("@a @b "). */
    reply: (r) => {
      setReply(r);
      applyPrefill(r ? r.prefill || '' : '');
    },
    /** A mention clicked in the line: "@handle " at the caret, with a space before it when needed. */
    insertMention(handle) {
      if (!st.roomId || !handle) {
        return;
      }
      const at = ta.selectionStart != null && document.activeElement === ta ? ta.selectionStart : ta.value.length;
      const head = ta.value.slice(0, at);
      const tail = ta.value.slice(at);
      const add = (head && !/\s$/.test(head) ? ' ' : '') + '@' + handle + ' ';
      ta.value = head + add + tail;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = head.length + add.length;
      onInput();
    },
    focus: () => ta.focus(),
    resetHint() {
      hintSeen = false;
      try {
        localStorage.removeItem('wb.rooms.prefillHint');
      } catch (e) {
        // in memory only
      }
    },
    refreshFilesAvailability: paintSend,
    addFiles,
    putNote,
    hasNote,
    noteRequest: addRequest,
    retry,
    discard,
    connChanged,
    words: WORDS,
    state: () => ({ roomId: st.roomId, text: ta.value, reply: st.reply, files: trayFiles().map((f) => ({ name: f.name, id: f.id, uploading: f.uploading, marks: f.marks || 0 })), pending: roomState(st.roomId).pending.map((e) => ({ id: e.id, state: e.meta.local && e.meta.local.state })), pop: st.pop, popItems: st.popItems.map((i) => i.text), popAt: st.popAt, over: field.classList.contains('over'), count: count.hidden ? null : count.textContent, sendOff: send.disabled, offer: !offer.hidden, confirm: !confirmBar.hidden, deliv: deliv.textContent, drop: !drop.hidden }),
  };
}
