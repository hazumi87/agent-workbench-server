// Module host (P1, the design notes). Main hands over the module catalog (module.json files
// found in the bundled modules folder and the user's modules folder, plus each module's on/off
// flag and saved settings). This host:
//  - decides which modules are effective (own flag, parent chain, `requires`; core modules are
//    always on), imports each one's index.js and calls activate(api);
//  - renders module tabs in the top bar and module surfaces on the stage (the Dashboard is the
//    grid, other tabs are frames that show the module's entry page);
//  - renders Global Settings > Modules (the tree) and a settings page per module from its schema.
// Trust model now: first-party modules are imported into this renderer and get the api object
// directly. Every api method is still a plain {op, args} message answered by a promise, checked
// against the module's permissions, so moving third-party modules into a sandboxed frame later
// is a transport swap (postMessage), not a rewrite. No network: a module page is a local file.
// Nothing here ever sees terminal content; sessions.list hands out names, colors and
// flowing/idle only.

import { icon } from './m3-chrome.js';
import { sanitizeSvgTree } from './svg-sanitize.js';
import { slotInstallSeq } from './concierge-slot.js';
import { createCardRegistry, checkShown, eventForBinding, makeBinding, bindingCurrent, bindingOwner } from './tool-cards.js';
import { createToolRequests } from './module-requests.js';
import { moduleUiUrl } from './module-frame.js';
import { createImageHost } from './image-host.js';
import { createCompanionStore } from './image-companions.js';
import { match as matchClaims } from './attachment-claims.js';
import { createScratchFiles, readDraftPicture } from './scratch-companions.js';
import { mountPluginInstaller } from './web-plugins/page.mjs';
import { permissionWords as pluginPermissionWords, OFF as PLUGINS_OFF } from './web-plugins/model.mjs';

const CLASSES = {
  'cli-manager': { grants: ['ui.tab', 'sessions.read'], grid: true },
  'status-monitor': { grants: ['ui.pane', 'sessions.read'] },
  concierge: { grants: [] }, // P2
  workrooms: { grants: ['ui.tab'], rooms: true }, // W1: its tab's surface is the core-drawn Workrooms page
  tool: { grants: ['tools.provide'] }, // P3 (the design notes §4): a tool may provide; storage and tools.call are declared
};
const OUTPUT_KINDS = new Set(['text', 'image/svg+xml']); // P3: inline strings only
const TOOL_CONTEXTS = new Set(['dashboard', 'tab', 'message-attachment', 'workroom', 'agent', 'concierge']);
const PANE_KINDS = new Set(['list']); // pane kinds the core can render today

let catalog = []; // from main: manifests + enabled flag + saved settings, in load order
// Tasks seam S1: the host-drawn rail cards and the room the Workrooms page shows (the design notes)
// lazily: some tests load this file with its imports stripped, so nothing imported may run at load time
let railCardsReg = null;
const railCards = () => railCardsReg || (railCardsReg = createCardRegistry());
let shownRoom = null; // the last checked rooms.shown payload, or null
// ui.railCard is only a string a module declares, so until the team' install layer owns that consent,
// rail cards are for bundled (first-party) modules only (a builder's review, note a).
const cardsAllowed = (rec) => rec.m.source === 'bundled' && rec.m.class === 'tool' && !!rec.m.tool?.contexts?.includes('workroom') && hasPerm(rec, 'ui.railCard');
const ownerNow = (rec) => ({ moduleId: rec.id, gen: rec.gen, accountEpoch: shell?.accountEpoch?.() ?? 0, engineEpoch: shell?.engineEpoch?.() ?? 0,
  roomId: shownRoom ? shownRoom.roomId : undefined, familyId: shownRoom ? shownRoom.familyId : undefined });
// Tasks seam S2: a module page in the side column, for the room shown
const SIDE_PAGE = /^ui\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.html$/; // the module's own ui/ folder, one level, .html
const sideAllowed = (rec) => rec.m.source === 'bundled' && rec.m.class === 'tool' && !!rec.m.tool?.contexts?.includes('workroom');
/** A plugin's own page in the side column, bound to the room shown like a bundled tool's preview (the the lead's
 *  ruling, 2026-10-26: an installed tool whose page gets no data looks broken). The web only; an enabled plugin (the
 *  engine lists it on: installed with the person's consent, files unchanged since) that is a workroom tool and not in
 *  error. Its data calls take the same page admission and the engine's own (M4: the consent record, the granted verbs). */
const pluginPageAllowed = (rec) => !!window.wb?.web && rec.m.source === 'plugin' && rec.m.enabled === true && !rec.m.error && !rec.error
  && rec.m.class === 'tool' && !!rec.m.tool?.contexts?.includes('workroom');
/** A frame page the host may bind: a bundled tool's side page, or (the web) a consented plugin's. */
const framePageAllowed = (rec) => sideAllowed(rec) || pluginPageAllowed(rec);
// Tasks seam S3: the side page's pop-out, for a module holding ui.window, when the app can open a window
// the web has no module windows: there the pop-out is the FULL PAGE, a tab in the app's own tab strip (the owner's pattern:
// rail brief → preview → full page as a tab; the the lead and the design, 2026-10-26)
const windowAllowed = (rec) => sideAllowed(rec) && hasPerm(rec, 'ui.window') && (window.wb?.web ? typeof shell?.openToolPage === 'function' : typeof window.wb?.moduleWindowOpen === 'function');
/** A full page's binding is current while its module, generation, account and engine hold; its room is the one it was
 *  opened for (the page is not tied to the room shown: its tab replaces the room view). */
function pageCurrent(rec, b) {
  const o = bindingOwner(b);
  return !!o && !!rec && rec.pageBinding === b && sideAllowed(rec) && o.moduleId === rec.id && o.gen === rec.gen
    && o.accountEpoch === (shell?.accountEpoch?.() ?? 0) && o.engineEpoch === (shell?.engineEpoch?.() ?? 0);
}
function closePage(rec) {
  const key = rec.pageKey;
  rec.pageKey = null;
  rec.pageBinding = null;
  if (key) shell?.closeToolPage?.(key);
}
function closeSide(rec) {
  rec.sideBinding = null;
  rec.sideOpen = null;
  if (rec.sideKey) {
    const key = rec.sideKey;
    rec.sideKey = null;
    shell?.closeToolSide?.(key);
  }
}
// Tasks seam S4 step 5: a frame's request from a module page, admitted here (module-requests.js) against the
// page's own binding, the module's grants and the host's delete dialog, then sent to main. Created lazily:
// some tests load this file with its imports stripped.
let toolReqs = null;
const toolRequests = () => toolReqs || (toolReqs = createToolRequests({
  target: (b) => {
    const o = bindingOwner(b);
    return o ? { moduleId: o.moduleId, gen: o.gen, roomId: o.roomId } : null;
  },
  current: (b) => {
    const o = bindingOwner(b);
    const rec = o ? mods.get(o.moduleId) : null;
    if (rec && rec.pageBinding === b) return pageCurrent(rec, b); // the full page: its own room, not the room shown
    return !!rec && framePageAllowed(rec) && bindingCurrent(b, ownerNow(rec));
  },
  hasGrant: (b, grant) => {
    const o = bindingOwner(b);
    const rec = o ? mods.get(o.moduleId) : null;
    return !!rec && hasPerm(rec, grant);
  },
  call: (a) => window.wb.rooms.tasks(a),
  approve: (a) => window.wb.rooms.tasksApprove(a),
  confirm: (spec, signal) => (shell && typeof shell.confirmToolDelete === 'function' ? shell.confirmToolDelete(spec, signal) : Promise.resolve(false)),
}));
/** The page's frame link for owner ended: an open delete confirmation for it closes. */
export function toolCancel(owner) {
  if (toolReqs) toolReqs.cancel(owner);
}
/**
 * S3: the side page asked for its window. Only for the side page's current binding, a module holding ui.window,
 * and that page's own page and room; main checks it all again (module-window.js).
 */
export async function toolWindowOpen(binding) {
  const o = bindingOwner(binding);
  const rec = o ? mods.get(o.moduleId) : null;
  if (!rec || !windowAllowed(rec) || rec.sideBinding !== binding || !rec.sideOpen || !bindingCurrent(binding, ownerNow(rec))) {
    return { ok: false, kind: 'refused', status: 403, error: "This page can't open a window.", field: null };
  }
  const p = rec.sideOpen;
  if (isWeb()) {
    // the full page: the same module page, sandboxed and served from its own folder exactly as the preview is, in a
    // tab of the app's own strip (on a phone the full-screen layer); its own binding for its own room
    const url = moduleUiUrl(rec.m, p.page);
    url.searchParams.set('surface', 'window');
    url.searchParams.set('layout', 'page');
    url.searchParams.set('roomId', p.roomId);
    if (p.group) url.searchParams.set('group', p.group);
    const key = 'page:' + rec.id + ':' + p.roomId + (p.group ? ':' + p.group : '');
    if (rec.pageKey === key && shell?.showToolPage?.(key)) return { ok: true }; // already open: bring its tab forward
    closePage(rec);
    const pageBinding = makeBinding(ownerNow(rec));
    rec.pageKey = key;
    rec.pageBinding = pageBinding;
    rec.pageOpen = { roomId: p.roomId, familyId: o.familyId };
    const title = rec.m.name || rec.id.charAt(0).toUpperCase() + rec.id.slice(1);
    const opened = shell.openToolPage({ key, src: url.href, title, icon: iconName(rec.m.icon, 'extension'), roomId: p.roomId, binding: pageBinding,
      onDispose: () => { if (rec.pageKey === key) { rec.pageKey = null; rec.pageBinding = null; rec.pageOpen = null; } } });
    if (!opened) { rec.pageKey = null; rec.pageBinding = null; rec.pageOpen = null; return { ok: false, kind: 'refused', status: 409, error: "Couldn't open the full page.", field: null }; }
    return { ok: true };
  }
  try {
    return await window.wb.moduleWindowOpen({ moduleId: rec.id, page: p.page, roomId: p.roomId, group: p.group });
  } catch {
    return { ok: false, kind: 'transport' };
  }
}
/** The page's frame link hands each frame message here, with the side page's binding and its link owner. */
export function toolRequest(binding, owner, msg, reply) {
  const img = imageHosts.get(binding);
  if (img) {
    // the image viewer's own host (image-host.js), bound to the pictures it was opened on; the frame's id comes back
    const id = msg && Number.isSafeInteger(msg.id) ? msg.id : null;
    if (id === null || typeof msg.verb !== 'string') return;
    void img.call(msg.verb, msg.input).then((r) => reply(r && r.ok === true ? { id, ok: true, body: r.body ?? null } : { id, ...r, ok: false }));
    return;
  }
  toolRequests().handle(binding, owner, msg, reply);
}

// The image markup viewer (the design notes): a message's pictures open in the side column through the frame
// link, answered by image-host.js for exactly those pictures. Opened from the line and the room's files; a sent
// message's marks are view-only. Without the bundled image-viewer module the caller keeps its own viewer.
const imageHosts = new Map(); // the side page's binding → its host
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
/** A message attachment's type from its name, when the line did not carry one (the matcher's type rung needs it). */
const typeOfName = (name) => IMAGE_TYPES[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';
/** The attachment tools that take part in matching: bundled, on, not in error, message-attachment, with claims. */
const attachmentTools = () => catalog.filter((x) => x && x.source === 'bundled' && x.enabled !== false && !x.error && x.class === 'tool' &&
  Array.isArray(x.tool?.contexts) && x.tool.contexts.includes('message-attachment') && Array.isArray(x.tool.claims));
const IMAGE_PAGE = 'ui/viewer.html';
/** items: [{roomId, name}] of one room, index: the one clicked. → true when the viewer opened. */
/** The claims matcher over one message's (or one tray's) files: the viewer-role tool that opens files[index], and the
 *  indexes of the files that same tool takes, in order; null for the built-in handler. */
function claimPictures(files, index) {
  if (!Array.isArray(files) || !files.length || files.length > 50 || !Number.isInteger(index) || index < 0 || index >= files.length) return null;
  const tools = attachmentTools();
  const attached = files.map((x, i) => ({ id: 'p' + i, name: x.name, type: typeof x.type === 'string' && x.type ? x.type : typeOfName(x.name) }));
  const { assignments } = matchClaims(attached, tools.map((t) => ({ id: t.id, claims: t.tool.claims })));
  const m = tools.find((t) => t.id === assignments[index].tool);
  if (!m || m.tool.role !== 'viewer') return null; // this host drives the picture viewer page contract only
  const mine = files.map((x, i) => i).filter((i) => assignments[i].tool === m.id);
  return { m, mine, start: mine.indexOf(index) };
}

/** Open the viewer page of tool m in the side column for these pictures, answered by image-host.js through the side
 *  page's own binding. end() runs when the page goes (or never opened). → true when it opened. */
function openViewerSide({ m, roomId, names, start, sent, io, onMarks, end }) {
  let key = null;
  const host = createImageHost({ roomId, pictures: names.map((name, i) => ({ id: 'p' + i, name })), start, sent }, {
    io, on: { dismiss: () => key && shell.closeToolSide?.(key), marks: (id, count) => { try { onMarks?.(Number(String(id).slice(1)), count); } catch { /* the caller's own error */ } } },
  });
  if (!host) { end(); return false; }
  const binding = Object.freeze({ image: true });
  key = 'tool:' + m.id;
  imageHosts.set(binding, host);
  const opened = shell.openToolSide({ key, src: moduleUiUrl(m, IMAGE_PAGE).href, title: 'Pictures', binding, onDispose: () => { host.close(); imageHosts.delete(binding); end(); } });
  if (!opened) {
    host.close();
    imageHosts.delete(binding);
    end();
  }
  return !!opened;
}

/** items: [{roomId, name, type?}] of one SENT message (or the room's files), index: the one clicked. View-only. → true when
 *  the viewer opened; false keeps the caller's built-in viewer. */
export function openImageViewer(items, index, { sent = true } = {}) {
  if (!shell?.openToolSide) return false;
  if (!Array.isArray(items) || !items.every((x) => x && items[0] && x.roomId === items[0].roomId && typeof x.name === 'string')) return false;
  const c = claimPictures(items, index);
  if (!c) return false;
  const roomId = items[0].roomId;
  // a sent picture's marks are view-only: read beside it through the same assets route the picture itself comes from,
  // which resolves the room's own asset folder in every engine mode (the room-files route is hosted-only; found in the
  // pre-send mark-up run, local mode). Web build only; nothing is ever written here.
  let live = true;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const io = {
    readPicture: (r, name) => window.wb.rooms.image(r, name).then((x) => (x && x.ok ? x.value : null)),
    readCompanion: (r, name) => (window.wb.web && typeof globalThis.fetch === 'function' ? readSentCompanion(roomId, name, ctl) : Promise.resolve(null)),
    writeCompanion: () => Promise.resolve(false),
  };
  return openViewerSide({ m: c.m, roomId, names: c.mine.map((i) => items[i].name), start: c.start, sent, io, end: () => { live = false; ctl?.abort(); } });
}

/** A sent picture's marks file, `<name>.annotations.svg` beside it in the room's assets. null when there is none. */
async function readSentCompanion(roomId, name, ctl) {
  const r = await globalThis.fetch('/api/rooms/' + encodeURIComponent(roomId) + '/assets/raw/' + encodeURIComponent(name + '.annotations.svg'), { credentials: 'same-origin', cache: 'no-store', signal: ctl?.signal });
  if (r.status === 404) return null;
  if (r.status !== 200) throw Object.assign(new Error('marks read ' + r.status), { code: 'unavailable' });
  return r.text();
}

/** Pre-send mark-up: a picture in the message box's tray, editable. a: {roomId, tray:[{id, name, type}]
 *  (the tray's uploaded tiles in order), index, onMarks(fileId, count), onClose()}. Marks are the picture's companion in the person's
 *  own draft scratch (scratch-companions.js); the engine moves it with its picture on send. Web build only. */
export function openImageMarkup(a) {
  if (!shell?.openToolSide || !window.wb?.web || typeof globalThis.fetch !== 'function') return false;
  if (!a || typeof a.roomId !== 'string' || !a.roomId || !Array.isArray(a.tray)) return false;
  const tray = a.tray.filter((t) => t && typeof t.id === 'string' && t.id && typeof t.name === 'string');
  if (tray.length !== a.tray.length) return false;
  const c = claimPictures(tray, a.index);
  if (!c) return false;
  const roomId = a.roomId;
  const pictures = c.mine.map((i) => ({ id: tray[i].id, name: tray[i].name }));
  const byName = new Map(pictures.map((p) => [p.name, p]));
  const fetchFn = (u, init) => globalThis.fetch(u, init);
  const scratch = createScratchFiles({ roomId, pictures, fetch: fetchFn });
  const marks = createCompanionStore(scratch);
  const io = {
    readPicture: (r, name) => (byName.has(name) ? readDraftPicture({ roomId, fileId: byName.get(name).id, fetch: fetchFn }) : Promise.resolve(null)),
    readCompanion: (r, name) => marks.read(name),
    writeCompanion: (r, name, text) => marks.write(name, text),
  };
  const onMarks = (i, count) => { if (pictures[i]) a.onMarks?.(pictures[i].id, count); };
  // onClose: the message box clears its open-tile ring when the viewer closes (or did not open); called once
  let closed = false;
  const end = () => { marks.destroy(); if (closed) return; closed = true; try { a.onClose?.(); } catch { /* the caller's own error */ } };
  return openViewerSide({ m: c.m, roomId, names: pictures.map((p) => p.name), start: c.start, sent: false, io, onMarks, end });
}
/** Revision 10: main forgets exactly this admission (card id and its sequence; best effort, main also drops stale ones). */
async function releaseCard(moduleId, cardId, seq) {
  if (!Number.isSafeInteger(seq)) return;
  try {
    await window.wb.moduleCardRelease?.({ moduleId, cardId, seq });
  } catch {
    // main drops it on the next change anyway
  }
}
/** Release every current admission (of one module, or all) before the renderer's registrations end. */
function releaseRegistrations(moduleId) {
  if (!railCardsReg) return;
  for (const r of railCardsReg.registrations(moduleId)) void releaseCard(r.moduleId, r.cardId, r.seq);
}
/** Every card of the module goes (a lost grant or context, deactivate), or one card (its own handle's dispose). */
function dropCard(rec, cardId) {
  if (cardId === undefined) rec.railCardActivate = null; // the activations go with the cards
  else rec.railCardActivate?.delete?.(cardId);
  if (cardId === undefined) releaseRegistrations(rec.id); // main's slots go with them ()
  if (railCardsReg && railCardsReg.bindingsOf(rec.id).length) { // no registry yet: no card to drop (and nothing imported is touched)
    railCards().remove(rec.id, cardId);
    shell?.toolCardsChanged?.();
  }
}
const mods = new Map(); // id -> record of an effective module
let shell = null; // hooks into the core renderer
let info = { userModulesDir: '' };
let surface = 'dashboard'; // id of the active top-bar tab ('dashboard' = the grid)
let appsEl = null;
let stageEl = null;

const dbg = (event, fields) => window.wb.dlog(event, fields);
const byId = (id) => catalog.find((m) => m.id === id) || null;
const str = (v, fallback, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : fallback);
/** An icon is a Material Symbols name and reaches innerHTML, so only a plain name passes (the review of PR #1). */
const iconName = (v, fallback) => (typeof v === 'string' && /^[a-z0-9_]{1,40}$/.test(v) ? v : fallback);

export function init(hooks, initInfo) {
  shell = hooks;
  info = { ...info, ...(initInfo || {}) };
  appsEl = document.querySelector('.hwb-apps');
  stageEl = document.getElementById('modStage');
  appsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.hwb-apptab');
    if (b) {
      surfaceChosen = true; // a person picked this: a start-up default must not take it back
      setSurface(b.dataset.app);
    }
  });
  // Tasks seam S5: main already checked the frame (src/rooms/task-events.js) and took the family from its own cache
  window.wb.on('rooms:tasks', (p) => {
    if (!p || typeof p.roomId !== 'string' || typeof p.familyId !== 'string') return; // a null or odd payload never reaches a module
    emitRoomsEvent('rooms.tasks', { roomId: p.roomId, familyId: p.familyId });
  });
}

/**
 * Tasks seam S5: a rooms.* event goes only to running tool modules that hold rooms.tasks.read and declare
 * the workroom context, re-checked on every event (a catalog change may have taken either away).
 */
export function emitRoomsEvent(name, payload) {
  for (const rec of mods.values()) {
    if (rec.m.class === 'tool' && rec.m.tool?.contexts?.includes('workroom') && hasPerm(rec, 'rooms.tasks.read')) {
      // S4 step 6: the module's open side page hears rooms.tasks for the family its binding was issued for
      if (name === 'rooms.tasks' && rec.sideKey && rec.sideBinding && eventForBinding(rec.sideBinding, ownerNow(rec), payload)) {
        shell?.toolEvent?.(rec.sideKey, 'rooms.tasks', payload);
      }
      // its full page hears rooms.tasks for the family it was opened for, while its binding is current
      if (name === 'rooms.tasks' && rec.pageKey && rec.pageBinding && pageCurrent(rec, rec.pageBinding) && rec.pageOpen && payload.familyId === rec.pageOpen.familyId) {
        shell?.toolEvent?.(rec.pageKey, 'rooms.tasks', payload);
      }
      // rooms.tasks only reaches a module whose card is bound to that family, while the binding is current
      if (name === 'rooms.tasks' && !railCards().bindingsOf(rec.id).some((b) => eventForBinding(b, ownerNow(rec), payload))) {
        continue;
      }
      emit(rec, name, payload);
    }
  }
}

/** The Workrooms page shows a room (or none): checked, remembered, and told to the modules (S1). */
export function roomShown(p) {
  // the three fields the modules hear; other keys the page adds for its own slices (the web Scratchpad's roomName,
  // <commit>) are not the modules' and must not make the whole message malformed
  const v = checkShown(p && typeof p === 'object' && !Array.isArray(p) ? { roomId: p.roomId, familyId: p.familyId, group: p.group } : p);
  if (v === undefined) {
    return; // malformed: never delivered
  }
  // A real transition (another room, or to or from no room) kills every earlier registration before the
  // modules hear of it, so A, then none, then A again can never revive an old handle (a builder, 5b).
  // The same room told again (an ordinary repaint) changes nothing.
  if (JSON.stringify(v) !== JSON.stringify(shownRoom)) {
    releaseRegistrations(); // main's admissions end with the room ()
    for (const rec of mods.values()) {
      rec.railCardActivate = null;
      rec.cardPending = null; // a registration still waiting for main belongs to the old room
      closeSide(rec); // a preview belongs to the room it was opened for (S2)
    }
    railCards().clear();
  }
  shownRoom = v;
  emitRoomsEvent('rooms.shown', v);
  shell?.toolCardsChanged?.(); // cards bound to the previous room are no longer current
}

/** The cards to draw in the rail for the room shown, in install order then by id. */
export function toolCardsForRail() {
  if (!shownRoom) {
    return [];
  }
  const ctx = { accountEpoch: shell?.accountEpoch?.() ?? 0, engineEpoch: shell?.engineEpoch?.() ?? 0, roomId: shownRoom.roomId, familyId: shownRoom.familyId };
  // the slot's validated order: bundled 0, then a safe positive installSeq, then missing or malformed last
  // (by id, in cardsFor); never a catalog-position fallback (a builder, finding 4)
  const order = (id) => {
    const m = catalog.find((x) => x.id === id);
    if (!m) return Infinity;
    if (m.source === 'bundled') return 0;
    return Number.isSafeInteger(m.installSeq) && m.installSeq > 0 ? m.installSeq : Infinity;
  };
  return railCards().cardsFor(ctx, order, (id) => mods.get(id)?.gen);
}

/** The person activated a card (click, Enter or Space): that card's own onActivate runs (revision 10: per card). */
export function activateToolCard(id, cardId = 'main') {
  const rec = mods.get(id);
  if (rec && cardsAllowed(rec) && railCards().cardsFor({ accountEpoch: shell?.accountEpoch?.() ?? 0, engineEpoch: shell?.engineEpoch?.() ?? 0,
    roomId: shownRoom?.roomId, familyId: shownRoom?.familyId }, undefined, (x) => mods.get(x)?.gen).some((c) => c.moduleId === id && c.cardId === cardId)) {
    const fn = rec.railCardActivate?.get?.(cardId);
    if (fn) {
      try {
        Promise.resolve(fn()).catch(() => dbg('module-railcard-error', { id }));
      } catch (e) {
        dbg('module-railcard-error', { id });
      }
    }
  }
}

/**
 * The account or the engine changed (renderer.js): every card binding is stale now, so the room shown is
 * told again and a module that re-registers on rooms.shown gets its card back (defect 2).
 */
export function epochsChanged() {
  for (const rec of mods.values()) {
    closeSide(rec); // a preview is bound to the old account or engine
  }
  if (shownRoom) {
    emitRoomsEvent('rooms.shown', shownRoom);
  }
  shell?.toolCardsChanged?.();
}

// ---------------------------------------------------------------- enablement

// A module runs when its own flag is on (core modules always are), its parent runs, and
// everything it requires runs.
export function effective(id, seen = new Set()) {
  const m = byId(id);
  if (!m || seen.has(id)) {
    return false;
  }
  seen.add(id);
  if (m.error) {
    return false; // a tool whose manifest failed its checks: skipped, the reason shown in Modules
  }
  if (!m.core && m.enabled === false) {
    return false;
  }
  if (m.parent && byId(m.parent) && !effective(m.parent, seen)) {
    return false;
  }
  for (const r of m.requires || []) {
    if (!effective(r, seen)) {
      return false;
    }
  }
  return true;
}

export async function applyCatalog(list) {
  catalog = Array.isArray(list) ? list : [];
  const ids = new Set(catalog.map((m) => m.id));
  for (const rec of [...mods.values()]) {
    if (!ids.has(rec.id) || !effective(rec.id)) {
      deactivate(rec);
    }
  }
  for (const m of catalog) {
    if (!effective(m.id)) {
      continue;
    }
    const rec = mods.get(m.id);
    if (!rec) {
      await activate(m);
    } else {
      const before = JSON.stringify(settingsOf(rec));
      rec.m = m;
      if (rec.conciergeSlot && (!hasPerm(rec, 'concierge.slot') || !m.tool?.contexts?.includes('concierge'))) {
        rec.conciergeSlot.dispose(); rec.conciergeSlot = null;
      }
      rec.conciergeSlot?.setOrder(slotInstallSeq(m));
      if (!cardsAllowed(rec)) {
        dropCard(rec); // a lost ui.railCard grant or workroom context takes the card away at once (revision 2, R3)
      }
      if (rec.m.source === 'plugin' ? !pluginPageAllowed(rec) : (!sideAllowed(rec) || !hasPerm(rec, 'ui.side'))) {
        closeSide(rec); // a plugin turned off, held (its files changed) or in error loses its page at once
      }
      const after = settingsOf(rec);
      if (JSON.stringify(after) !== before) {
        emit(rec, 'settings.changed', after);
      }
    }
  }
  renderTabs();
  shell.onPaneKinds(paneKinds());
  shell.onModules();
  for (const fn of [...catalogListeners]) {
    try { fn(catalog); } catch { /* a listener's own error */ }
  }
}

const catalogListeners = new Set();
/** Called with the catalog each time it has been applied (the web widget layer re-reads its rows). → unsubscribe. */
export function onCatalogApplied(fn) {
  catalogListeners.add(fn);
  return () => catalogListeners.delete(fn);
}

// The room's own toolbar (the design : Widgets opens from the room, like Notes; not a top-bar destination). The web
// widget mount registers its button here; the rooms page asks for it each time it draws a room's header.
let roomToolsFn = null;
export function setRoomTools(fn) { roomToolsFn = typeof fn === 'function' ? fn : null; }
export function roomTools(roomId) {
  try {
    const list = roomToolsFn ? roomToolsFn(roomId) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

async function activate(m) {
  const rec = { id: m.id, m, gen: 0, api: null, active: false, error: null, held: null, tabs: new Map(), panes: new Map(), frames: new Map(), listeners: new Map(), tools: new Set(), inflight: new Set() };
  mods.set(m.id, rec);
  if (!m.main) {
    return; // manifest-only module: nothing to run
  }
  if (m.source !== 'bundled') {
    // a plugin never runs code in the app page, whatever its catalog entry says: UI only, in sandboxed frames
    // (the design notes §1, P9)
    rec.error = 'a plugin has no main script';
    dbg('module-error', { id: m.id, error: rec.error });
    return;
  }
  try {
    const src = await import(m.url + m.main);
    rec.api = makeApi(rec);
    if (typeof src.activate === 'function') {
      await src.activate(rec.api);
    }
    rec.active = true;
    dbg('module-activate', { id: m.id, source: m.source });
  } catch (e) {
    rec.conciergeSlot?.dispose(); rec.conciergeSlot = null;
    rec.error = String((e && e.message) || e).slice(0, 200);
    dbg('module-error', { id: m.id, error: rec.error });
  }
}

function deactivate(rec) {
  rec.gen++; // every api object handed out so far stops working
  rec.conciergeSlot?.dispose(); rec.conciergeSlot = null;
  dropCard(rec);
  closeSide(rec);
  closePage(rec); // its full page goes with it
  for (const f of rec.frames.values()) {
    f.remove();
  }
  dropTools(rec); // its tools leave the registry; in-flight calls are rejected with "tool turned off"
  mods.delete(rec.id);
  if (rec.tabs.has(surface)) {
    surface = 'dashboard';
    shell.onSurface(surface);
  }
  dbg('module-deactivate', { id: rec.id });
}

// ---------------------------------------------------------------- the Module API

function hasPerm(rec, perm) {
  const cls = CLASSES[rec.m.class] || { grants: [] };
  return (rec.m.permissions || []).includes(perm) || cls.grants.includes(perm);
}

function makeApi(rec) {
  const gen = ++rec.gen;
  const call = (op, args) => request(rec, gen, op, args);
  return Object.freeze({
    id: rec.id,
    manifest: Object.freeze({ id: rec.m.id, name: rec.m.name, version: rec.m.version, class: rec.m.class, icon: rec.m.icon }),
    call, // the raw transport: every method below is one of these
    // the room's tasks for a tool's main script (the Tasks card's summary and timeline, add-task): the engine admits
    // each call (M4), this host only lets a workroom tool ask about the room the page shows
    rooms: Object.freeze({
      tasks: (roomId, verb, input) => call('rooms.tasks', { roomId, verb, input }),
    }),
    ui: Object.freeze({
      registerTab: (a) => call('ui.registerTab', a),
      setTab: (a) => call('ui.setTab', a),
      registerPane: (a) => call('ui.registerPane', a),
      // Tasks seam S2: the module's own page in the side column for the room shown
      openSide: (a) => call('ui.side.open', a),
      // Tasks seam S1: one host-drawn rail card for the room shown; update/dispose carry its binding
      // revision 10: up to two cards, by id (default 'main'); main admits each (its cap, its order); kind 'room-tasks'
      // is main's rule to put first, never a number the module sends
      registerRailCard: async (a = {}) => {
        const cardId = a.id === undefined ? 'main' : a.id;
        const binding = await call('ui.railCard.register', { id: cardId, kind: a.kind === undefined ? null : a.kind });
        // ONE activation per card: a re-register of that id replaces it (a builder's review, defect 1)
        if (!(rec.railCardActivate instanceof Map)) rec.railCardActivate = new Map();
        if (typeof a.onActivate === 'function') rec.railCardActivate.set(cardId, a.onActivate);
        else rec.railCardActivate.delete(cardId);
        return Object.freeze({ update: (card) => call('ui.railCard.update', { binding, card }), dispose: () => call('ui.railCard.remove', { binding }) });
      },
    }),
    settings: Object.freeze({ get: () => call('settings.get'), set: (patch) => call('settings.set', patch) }),
    sessions: Object.freeze({ list: () => call('sessions.list') }),
    concierge: Object.freeze({
      register: (a) => call('concierge.register', a),
      binding: () => call('concierge.binding'),
      update: (a) => call('concierge.update', a),
      remove: () => call('concierge.remove'),
    }),
    // P3 tools (the design notes §4)
    tools: Object.freeze({
      provide: (a) => call('tools.provide', a),
      list: (a) => call('tools.list', a),
      call: (a) => call('tools.call', a),
    }),
    storage: Object.freeze({
      get: (a) => call('storage.get', a),
      set: (a) => call('storage.set', a),
      list: () => call('storage.list'),
      delete: (a) => call('storage.delete', a),
    }),
    events: Object.freeze({
      on: (name, fn) => {
        if (!rec.listeners.has(name)) {
          rec.listeners.set(name, new Set());
        }
        rec.listeners.get(name).add(fn);
        return () => rec.listeners.get(name).delete(fn);
      },
    }),
    log: (event, fields) => call('log', { event, fields }),
  });
}

async function request(rec, gen, op, args) {
  if (gen !== rec.gen || mods.get(rec.id) !== rec) {
    throw new Error('module ' + rec.id + ' is not active');
  }
  const h = OPS[op];
  if (!h) {
    throw new Error('unknown op: ' + String(op));
  }
  if (h.perm && !hasPerm(rec, h.perm)) {
    throw new Error(rec.id + ' lacks permission ' + h.perm);
  }
  return h.run(rec, args && typeof args === 'object' ? args : {});
}

function emit(rec, name, payload) {
  for (const fn of rec.listeners.get(name) || []) {
    try {
      fn(payload);
    } catch (e) {
      dbg('module-listener-error', { id: rec.id, event: name });
    }
  }
}

const OPS = {
  'rooms.tasks': { perm: 'rooms.tasks.read', async run(rec, a) {
    if (!cardsAllowed(rec)) throw new Error('the room\'s tasks are for a tool with the workroom context');
    if (!shownRoom || a.roomId !== shownRoom.roomId) throw Object.assign(new Error('only the room shown'), { status: 403 });
    if (typeof a.verb !== 'string' || a.verb === 'purge') throw Object.assign(new Error('deleting happens from the room\'s side preview'), { status: 403 });
    // the Room Tasks (Vikunja) card is desktop only and stays refused on the web by design: answer "no panel" here
    // (the module draws no card for a 404) instead of a request the engine refuses with "That isn't a Tasks action."
    if (isWeb() && a.verb === 'room-summary') throw Object.assign(new Error('no Room Tasks panel in the web build'), { status: 404 });
    const r = await window.wb.rooms.tasks({ moduleId: rec.id, gen: rec.gen, verb: a.verb, roomId: a.roomId, input: a.input === undefined ? {} : a.input });
    if (r && r.ok === true) return r.body;
    const e = new Error((r && typeof r.error === 'string' && r.error) || (r && r.kind === 'slow' ? 'too many requests' : 'the room could not answer'));
    if (r && Number.isInteger(r.status)) e.status = r.status;
    throw e;
  } },
  'concierge.register': { perm: 'concierge.slot', run(rec, a) {
    if (rec.m.class !== 'tool' || !rec.m.tool?.contexts?.includes('concierge')) throw new Error('tool needs explicit concierge context');
    if (!shell.conciergeSlots) throw new Error('Concierge slot unavailable');
    if (rec.conciergeSlot) throw new Error('Concierge slot already registered');
    rec.conciergeSlot = shell.conciergeSlots.register(rec.id, a, event => {
      const gen = rec.gen, pending = [];
      for (const fn of rec.listeners.get('concierge.activate') || []) {
        if (mods.get(rec.id) !== rec || gen !== rec.gen || !hasPerm(rec, 'concierge.slot') || !rec.m.tool?.contexts?.includes('concierge')) break;
        try { pending.push(Promise.resolve(fn(event))); } catch (error) { pending.push(Promise.reject(error)); }
      }
      // The slot host consumes rejection with the captured binding. Deactivation
      // during an async handler must not leave an unhandled stale-API rejection.
      return Promise.all(pending);
    }, slotInstallSeq(rec.m));
    return { registered: true };
  } },
  'concierge.binding': { perm: 'concierge.slot', run: rec => rec.conciergeSlot?.binding() || null },
  'concierge.update': { perm: 'concierge.slot', run: (rec, a) => rec.conciergeSlot?.update(a.patch, a.binding) || false },
  'concierge.remove': { perm: 'concierge.slot', run(rec) { rec.conciergeSlot?.dispose(); rec.conciergeSlot = null; return { removed: true }; } },
  'ui.side.open': { perm: 'ui.side', run(rec, a) {
    if (!sideAllowed(rec)) throw new Error('a side page needs a bundled tool module with the workroom context');
    if (typeof a.page !== 'string' || !SIDE_PAGE.test(a.page)) throw new Error('page must be ui/<name>.html in the module');
    const p = a.params;
    if (!p || typeof p !== 'object' || !Object.keys(p).every((k) => k === 'roomId' || k === 'group' || k === 'source')) throw new Error('params are {roomId, group, source?}');
    if (p.source !== undefined && p.source !== 'room-tasks') throw new Error('the only page source is room-tasks'); // revision 11
    if (!shownRoom || p.roomId !== shownRoom.roomId || (p.group ?? null) !== shownRoom.group) throw new Error('the page is only for the room shown');
    // S4 step 6: the module UI protocol (main serves only bundled, enabled modules' own ui/ files), never file:
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(rec.id)) throw new Error('this module id cannot have a side page (letters, digits and dashes only)');
    const url = moduleUiUrl(rec.m, a.page); // web: /app/modules/<id>/ or /app/plugins/<id>/ from the catalog
    url.searchParams.set('surface', 'preview');
    url.searchParams.set('roomId', shownRoom.roomId);
    if (shownRoom.group) url.searchParams.set('group', shownRoom.group);
    if (p.source) url.searchParams.set('source', p.source);
    if (windowAllowed(rec)) url.searchParams.set('popout', isWeb() ? 'page' : '1'); // S3: the pop-out only when it can open: a window, or on the web the full page
    closeSide(rec);
    rec.sideKey = 'tool:' + rec.id;
    const title = rec.m.name || rec.id.charAt(0).toUpperCase() + rec.id.slice(1);
    const sideBinding = makeBinding(ownerNow(rec));
    const opened = shell?.openToolSide?.({ key: rec.sideKey, src: url.href, title, binding: sideBinding, onDispose: () => { rec.sideKey = null; rec.sideBinding = null; rec.sideOpen = null; } });
    if (opened) {
      rec.sideBinding = sideBinding; // S4 step 6: its rooms.tasks events go to this page
      rec.sideOpen = { page: a.page, roomId: shownRoom.roomId, group: shownRoom.group || null }; // S3: what its pop-out opens
    }
    else rec.sideKey = null;
    return { opened: !!opened };
  } },
  'ui.railCard.register': { perm: 'ui.railCard', async run(rec, a) {
    if (!cardsAllowed(rec)) throw new Error('a rail card needs class tool and the workroom context');
    if (!shownRoom) throw new Error('no room is shown');
    const cardId = a && a.id !== undefined ? a.id : 'main';
    const kind = a && a.kind !== undefined && a.kind !== null ? a.kind : null;
    const owner = ownerNow(rec);
    const room = shownRoom;
    // one pending registration per card: a later one for the same id supersedes this one ()
    const mine = {};
    if (!(rec.cardPending instanceof Map)) rec.cardPending = new Map();
    rec.cardPending.set(cardId, mine);
    const pending = rec.cardPending;
    // main admits the card (revision 10): its cap, its order, its room-tasks rule; no answer, no card
    let r = null;
    try {
      r = await window.wb.moduleCardAdmit({ moduleId: rec.id, cardId, kind, roomId: room.roomId });
    } catch {
      r = null;
    }
    const superseded = rec.cardPending !== pending || pending.get(cardId) !== mine;
    if (!superseded) pending.delete(cardId);
    if (!r || r.ok !== true || !Number.isSafeInteger(r.seq) || r.seq < 1 || (r.kind ?? null) !== kind) {
      throw new Error((r && typeof r.why === 'string' ? r.why : 'main did not admit the card'));
    }
    // a newer registration of this card, or a late answer (another room, an account or engine change, a new
    // generation), is not drawn, and main forgets exactly this admission
    if (superseded) {
      void releaseCard(rec.id, cardId, r.seq);
      throw new Error('stale: a newer registration of this card replaced it');
    }
    if (shownRoom !== room || !bindingCurrent(makeBinding(owner), ownerNow(rec)) || mods.get(rec.id) !== rec) {
      void releaseCard(rec.id, cardId, r.seq);
      throw new Error('stale: the room changed while main admitted the card');
    }
    return railCards().register(rec.id, owner, cardId, r.seq, kind);
  } },
  'ui.railCard.update': { perm: 'ui.railCard', run(rec, a) {
    const ok = cardsAllowed(rec) && railCards().update(a.binding, a.card, ownerNow(rec));
    if (ok) shell?.toolCardsChanged?.();
    return ok; // false = stale binding or a refused descriptor: nothing drawn
  } },
  'ui.railCard.remove': { perm: 'ui.railCard', run(rec, a) {
    // fenced to the CURRENT registration: an old handle's dispose never removes a newer card (a builder, finding 3)
    const cardId = a.binding ? railCards().cardOf(rec.id, a.binding) : null;
    if (cardId === null) return { removed: false };
    const seq = railCards().registrations(rec.id).find((x) => x.cardId === cardId)?.seq;
    dropCard(rec, cardId); // that card only (revision 10)
    void releaseCard(rec.id, cardId, seq);
    return { removed: true };
  } },
  'ui.registerTab': {
    perm: 'ui.tab',
    run(rec, a) {
      const cls = CLASSES[rec.m.class] || {};
      const surf = a.surface === 'grid' ? 'grid' : a.surface === 'rooms' ? 'rooms' : 'frame';
      if (surf === 'grid' && !cls.grid) {
        throw new Error('only the cli-manager class may own the grid');
      }
      if (surf === 'rooms' && !cls.rooms) {
        throw new Error('only the workrooms class may own the rooms page');
      }
      const id = surf === 'grid' ? 'dashboard' : String(a.id || rec.id).replace(/[^a-z0-9_.-]/gi, '').slice(0, 40);
      if (!id) {
        throw new Error('a tab needs an id');
      }
      for (const r of mods.values()) {
        if (r !== rec && r.tabs.has(id)) {
          throw new Error('tab id in use: ' + id);
        }
      }
      const entry = surf === 'frame' ? String(a.entry || rec.m.entry || '') : null;
      if (surf === 'frame' && (!entry || entry.includes('..') || entry.startsWith('/') || /^[a-z]+:/i.test(entry))) {
        throw new Error('a frame tab needs an entry page inside the module');
      }
      rec.tabs.set(id, { id, mod: rec.id, label: str(a.label, rec.m.name, 40), icon: iconName(a.icon, rec.m.icon || 'extension'), surface: surf, entry });
      renderTabs();
      return { id };
    },
  },
  'ui.setTab': {
    perm: 'ui.tab',
    run(rec, a) {
      const t = rec.tabs.get(String(a.id));
      if (!t) {
        throw new Error('no such tab: ' + String(a.id));
      }
      if (a.label != null) {
        t.label = str(a.label, t.label, 40);
      }
      if (a.icon != null) {
        t.icon = iconName(a.icon, t.icon);
      }
      renderTabs();
      return { id: t.id };
    },
  },
  'ui.registerPane': {
    perm: 'ui.pane',
    run(rec, a) {
      const kind = String(a.kind || '');
      if (!PANE_KINDS.has(kind)) {
        throw new Error('unknown pane kind: ' + kind);
      }
      for (const r of mods.values()) {
        if (r !== rec && r.panes.has(kind)) {
          throw new Error('pane kind in use: ' + kind);
        }
      }
      rec.panes.set(kind, { kind, label: str(a.label, kind, 40), icon: iconName(a.icon, 'view_list') });
      shell.onPaneKinds(paneKinds());
      return { kind };
    },
  },
  // ---- P3 tools (the design notes §4)
  'tools.provide': {
    perm: 'tools.provide',
    run(rec, a) {
      const t = rec.m.tool;
      if (!t) {
        throw new Error(rec.id + ' is not a tool');
      }
      const id = String(a.id || '');
      if (!t.provides.includes(id)) {
        throw new Error(rec.id + ' does not provide ' + id + ' (its manifest lists ' + t.provides.join(', ') + ')');
      }
      const handlers = a.handlers && typeof a.handlers === 'object' ? a.handlers : {};
      const actions = t.actions.filter((x) => x.provides === id);
      for (const name of Object.keys(handlers)) {
        if (!actions.find((x) => x.name === name)) {
          throw new Error(id + ': no action ' + name + ' in actions.json');
        }
        if (typeof handlers[name] !== 'function') {
          throw new Error(id + ': the handler for ' + name + ' is not a function');
        }
      }
      const other = registry.get(id);
      if (other && other.rec !== rec) {
        // the first by load order wins; the second is held with the reason visible in Modules
        rec.held = other.rec.m.name + ' already provides ' + id;
        throw new Error(rec.held);
      }
      registry.set(id, { id, rec, handlers, actions });
      rec.tools.add(id);
      offTools.delete(id);
      toolsChanged();
      return { id };
    },
  },
  'tools.list': {
    perm: 'tools.call',
    run: (rec, a) => toolList(a),
  },
  'tools.call': {
    perm: 'tools.call',
    run: (rec, a) => callTool(String(a.id || ''), String(a.action || ''), a.input, a.context, rec.id),
  },
  'storage.get': { perm: 'storage', run: (rec, a) => storage(rec, 'get', a) },
  'storage.set': { perm: 'storage', run: (rec, a) => storage(rec, 'set', a) },
  'storage.list': { perm: 'storage', run: (rec) => storage(rec, 'list', {}) },
  'storage.delete': { perm: 'storage', run: (rec, a) => storage(rec, 'delete', a) },
  'settings.get': { perm: 'settings', run: (rec) => settingsOf(rec) },
  'settings.set': { perm: 'settings', run: (rec, patch) => setSettings(rec, patch) },
  'sessions.list': {
    perm: 'sessions.read',
    run: () => shell.sessions().map((s) => ({ sid: s.sid, wid: s.wid, name: s.name || '', hue: s.hue, flowing: !!s.flowing, hidden: s.wid == null })),
  },
  log: {
    perm: null,
    run(rec, a) {
      dbg('mod:' + rec.id + ':' + String(a.event || 'log').slice(0, 30), a.fields && typeof a.fields === 'object' ? a.fields : {});
      return true;
    },
  },
};

// ---------------------------------------------------------------- P3: the tool registry

const registry = new Map(); // tool id -> { id, rec, handlers, actions }
const offTools = new Map(); // tool id -> module id, for a tool whose module was turned off (a call says so)

function toolsChanged() {
  for (const r of mods.values()) {
    emit(r, 'tools.changed', toolList({}));
  }
  if (shell && shell.onModules) {
    shell.onModules();
  }
}

function dropTools(rec) {
  for (const id of rec.tools) {
    if (registry.get(id) && registry.get(id).rec === rec) {
      registry.delete(id);
      offTools.set(id, rec.id);
    }
  }
  rec.tools.clear();
  for (const reject of rec.inflight) {
    reject(new Error('tool turned off'));
  }
  rec.inflight.clear();
  if (rec.tools.size === 0 && rec.m.tool) {
    toolsChanged();
  }
}

/** The enabled tools, filtered: { accepts?, context?, role? } → [{ id, module, title, icon, role, accepts, contexts, actions }]. */
export function toolList(a = {}) {
  const out = [];
  for (const t of registry.values()) {
    const tool = t.rec.m.tool;
    if (a.role && tool.role !== a.role) continue;
    if (a.context && !(tool.contexts.includes(String(a.context)) || (tool.contexts.includes('*') && !['agent', 'concierge'].includes(String(a.context))))) continue; // sensitive contexts require explicit opt-in
    if (a.accepts && !acceptsMatch(tool.accepts, String(a.accepts))) continue;
    out.push({ id: t.id, module: t.rec.id, title: t.rec.m.name, icon: t.rec.m.icon || 'extension', role: tool.role, accepts: tool.accepts.slice(), contexts: tool.contexts.slice(), actions: t.actions.map((x) => ({ name: x.name, title: x.title, kind: x.output.kind, contexts: x.contexts.slice(), input: x.input })) });
  }
  return out;
}

function acceptsMatch(list, want) {
  return list.some((x) => x === want || (x.endsWith('/*') && want.startsWith(x.slice(0, -1))));
}

/** Call a tool's action: the input checked and clamped, the context checked, a timeout; the handler runs in the providing module. */
export async function callTool(id, action, input, context, callerId = 'core') {
  const t = registry.get(id);
  if (!t) {
    throw new Error(offTools.has(id) ? 'tool turned off' : 'no such tool: ' + id);
  }
  const act = t.actions.find((x) => x.name === action);
  if (!act) {
    throw new Error(id + ' has no action ' + action);
  }
  const ctx = String(context || '');
  if (!TOOL_CONTEXTS.has(ctx) || !act.contexts.includes(ctx)) {
    throw new Error(id + '.' + action + ' is not available in the ' + (ctx || 'unnamed') + ' context');
  }
  const h = t.handlers[action];
  if (typeof h !== 'function') {
    throw new Error(id + ' provides no handler for ' + action);
  }
  const rec = t.rec;
  const args = coerce(act.input || {}, input && typeof input === 'object' ? input : {});
  let timer = null;
  let rejectInflight = null;
  const gone = new Promise((_, reject) => {
    rejectInflight = reject;
    rec.inflight.add(reject);
  });
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(id + '.' + action + ' took longer than ' + Math.round(act.timeoutMs / 1000) + ' s')), act.timeoutMs);
  });
  try {
    const out = await Promise.race([Promise.resolve().then(() => h(args, Object.freeze({ context: ctx, caller: callerId, module: rec.id }))), gone, late]);
    if (typeof out !== 'string' || out.length > 1 << 20) {
      throw new Error(id + '.' + action + ' returned no ' + act.output.kind + ' string' + (typeof out === 'string' ? ' under 1 MB' : '')); // inline strings only (P3)
    }
    if (!OUTPUT_KINDS.has(act.output.kind)) {
      throw new Error('unsupported output kind');
    }
    return { kind: act.output.kind, data: out };
  } finally {
    clearTimeout(timer);
    rec.inflight.delete(rejectInflight);
  }
}

/** storage.*: the module's own folder under <userData>/module-data/<id>/, through main; never a path. */
async function storage(rec, op, a) {
  const r = await window.wb.moduleStorage({ id: rec.id, op, key: a.key, value: a.value });
  if (!r || !r.ok) {
    throw new Error((r && r.error) || 'storage failed');
  }
  return op === 'get' ? r.value : op === 'list' ? { keys: r.keys, files: r.files } : true;
}

// ---- styling: host.css and the theme message (the design notes §5)

const HOST_CSS_URL = new URL('./host.css', import.meta.url).href;

/** The current roles, from what the shell set on :root, as the `theme` message carries them. */
export function themeMessage() {
  const roles = {};
  const st = document.documentElement.style;
  for (let i = 0; i < st.length; i++) {
    const name = st[i];
    if (name.startsWith('--md-sys-color-')) {
      roles[name] = st.getPropertyValue(name).trim();
    }
  }
  const t = shell && shell.theme ? shell.theme() : { scheme: document.documentElement.classList.contains('dark') ? 'dark' : 'light', contrast: 0 };
  return { type: 'theme', scheme: t.scheme, roles, contrast: t.contrast };
}

/**
 * Attach host.css then the tool's own style to a frame the host gave it (§5: the host injects, the
 * author writes no <link>), and send it the theme. A frame the host can reach gets the two <link>s
 * at the head of its document and the roles on its :root; one it cannot reach (another origin) is
 * told the two URLs in a `host.css` message and attaches them itself. Either way the `theme`
 * message follows, now and on every appearance change, so a page's own script can react.
 */
function attachHost(f, rec) {
  const own = rec.m.tool && rec.m.tool.style ? rec.m.url + rec.m.tool.style : null;
  const msg = themeMessage();
  let reached = false;
  try {
    const d = f.contentDocument;
    if (d && d.head) {
      if (!d.getElementById('wb-host-css')) {
        const host = d.createElement('link');
        host.id = 'wb-host-css';
        host.rel = 'stylesheet';
        host.href = HOST_CSS_URL;
        d.head.prepend(host);
        if (own) {
          const l = d.createElement('link');
          l.id = 'wb-tool-css';
          l.rel = 'stylesheet';
          l.href = own;
          host.after(l);
        }
      }
      for (const [k, v] of Object.entries(msg.roles)) {
        d.documentElement.style.setProperty(k, v);
      }
      d.documentElement.style.setProperty('color-scheme', msg.scheme);
      reached = true;
    }
  } catch (e) {
    // a frame of another origin: the messages below are all we can do
  }
  if (!f.contentWindow) {
    return;
  }
  if (!reached) {
    f.contentWindow.postMessage({ type: 'host.css', css: [HOST_CSS_URL], style: own }, '*');
  }
  f.contentWindow.postMessage(msg, '*');
}

/** The appearance changed: every tool frame hears the new roles, no reload. */
export function themeChanged() {
  for (const rec of mods.values()) {
    if (!rec.m.tool) continue;
    for (const f of rec.frames.values()) {
      attachHost(f, rec);
    }
  }
}

// ---------------------------------------------------------------- settings (schema-checked)

// schema: { key: { type: 'string'|'boolean'|'number', title, default, hint, enum?, min?, max?, maxLength? } }
export function coerce(schema, raw) {
  const out = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const [k, def] of Object.entries(schema || {})) {
    const v = src[k];
    if (def.type === 'boolean') {
      out[k] = typeof v === 'boolean' ? v : !!def.default;
    } else if (def.type === 'number') {
      let n = typeof v === 'number' && Number.isFinite(v) ? v : Number(def.default) || 0;
      if (typeof def.min === 'number') {
        n = Math.max(def.min, n);
      }
      if (typeof def.max === 'number') {
        n = Math.min(def.max, n);
      }
      out[k] = n;
    } else {
      let s = typeof v === 'string' ? v : String(def.default == null ? '' : def.default);
      if (typeof def.maxLength === 'number') {
        s = s.slice(0, def.maxLength);
      }
      if (Array.isArray(def.enum) && !def.enum.includes(s)) {
        s = def.enum.includes(def.default) ? def.default : def.enum[0];
      }
      out[k] = s;
    }
  }
  return out;
}

const settingsOf = (rec) => coerce(rec.m.settingsSchema || {}, rec.m.settings || {});

function setSettings(rec, patch) {
  const next = coerce(rec.m.settingsSchema || {}, { ...(rec.m.settings || {}), ...(patch || {}) });
  rec.m.settings = next;
  window.wb.moduleSet({ id: rec.id, settings: next }); // main persists and tells every window
  emit(rec, 'settings.changed', next);
  return next;
}

// ---------------------------------------------------------------- top-bar tabs + surfaces

function allTabs() {
  const out = [];
  let grid = null;
  for (const m of catalog) {
    const rec = mods.get(m.id);
    if (rec) {
      for (const t of rec.tabs.values()) {
        if (t.id === 'dashboard') {
          grid = t; // 0.12.5 (the owner , PM ): Workrooms · Terminals · Console · +
        } else {
          out.push(t);
        }
      }
    }
  }
  if (grid) {
    out.push(grid);
  }
  // the core's own tabs (0.12.2: the Console tab for the account's admins), after the modules'
  if (shell && typeof shell.extraTabs === 'function') {
    out.push(...shell.extraTabs());
  }
  return out;
}

const WEB_TABS = new Set(['workrooms', 'dashboard', 'scratchpad']);
export function renderTabs() {
  if (!appsEl) {
    return;
  }
  const ts = allTabs();
  if (surface !== 'dashboard' && !ts.find((t) => t.id === surface)) {
    surface = 'dashboard';
    shell.onSurface(surface);
  }
  appsEl.textContent = '';
  // the web build draws only Workrooms, Terminals and Scratchpad here (Settings is added by the navigation); a tab-class plugin lives in
  // Settings > Modules and opens from its room
  const drawn = window.wb.web ? ts.filter((t) => WEB_TABS.has(t.id)) : ts;
  for (const t of drawn) {
    const b = document.createElement('button');
    b.className = 'hwb-apptab' + (t.id === surface ? ' is-active' : '');
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(t.id === surface));
    b.dataset.app = t.id;
    b.dataset.mod = t.mod;
    b.title = t.label;
    b.innerHTML = icon(t.icon) + '<span class="al"></span>';
    b.querySelector('.al').textContent = t.label;
    const dot = tabDots.get(t.id);
    const count = tabCounts.get(t.id) || 0;
    if (count > 0) { // P01 (the design s12): a number, never a bare dot; read out as "Workrooms, 3 waiting"
      const n = document.createElement('span');
      n.className = 'hwb-tabn';
      n.setAttribute('aria-hidden', 'true');
      n.textContent = count > 99 ? '99+' : String(count);
      b.appendChild(n);
      b.setAttribute('aria-label', t.label + ', ' + n.textContent + ' waiting');
    } else if (dot && dot.dot) {
      const d = document.createElement('span');
      d.className = 'wr-pdot';
      d.title = dot.title || '';
      b.appendChild(d);
      b.title = dot.title || t.label;
    }
    appsEl.appendChild(b);
  }
  applySurface();
}

function applySurface() {
  const t = allTabs().find((x) => x.id === surface);
  const onModule = !!(t && t.surface === 'frame');
  const onRooms = !!(t && t.surface === 'rooms');
  const onServers = !!(t && t.surface === 'servers');
  const onCodex = !!(t && t.surface === 'codex');
  const onScratchpad = !!(t && t.surface === 'scratchpad');
  document.getElementById('win').classList.toggle('on-module', onModule);
  document.getElementById('win').classList.toggle('on-console', !!(t && t.surface === 'console'));
  document.getElementById('win').classList.toggle('on-rooms', onRooms);
  document.getElementById('win').classList.toggle('on-servers', onServers);
  document.getElementById('win').classList.toggle('on-codex', onCodex);
  document.getElementById('win').classList.toggle('on-scratchpad', onScratchpad);
  stageEl.hidden = !onModule;
  const roomsStage = document.getElementById('roomsStage');
  if (roomsStage) {
    roomsStage.hidden = !onRooms;
  }
  const serversStage = document.getElementById('serversStage');
  if (serversStage) {
    serversStage.hidden = !onServers;
  }
  const codexStage = document.getElementById('codexStage');
  if (codexStage) codexStage.hidden = !onCodex;
  const scratchpadStage = document.getElementById('scratchpadStage');
  if (scratchpadStage) scratchpadStage.hidden = !onScratchpad;
  for (const rec of mods.values()) {
    for (const [id, f] of rec.frames) {
      f.hidden = id !== surface;
    }
  }
  if (onModule) {
    ensureFrame(t);
  }
}

function ensureFrame(t) {
  const rec = mods.get(t.mod);
  if (!rec) {
    return;
  }
  let f = rec.frames.get(t.id);
  if (!f) {
    f = document.createElement('iframe');
    f.className = 'modframe';
    f.title = t.label;
    f.dataset.mod = rec.id;
    // security review M4 (Client ): scripts only, an opaque origin, so a tab page never reaches parent.wb, the
    // app's storage or the sign-in cookie; attachHost then styles it by message (its cross-origin path)
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('allow', '');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.addEventListener('load', () => {
      f.dataset.loaded = '1';
      if (rec.m.tool) {
        attachHost(f, rec); // host.css, then the tool's style; the host injects, the author writes no <link>
      }
    });
    f.src = rec.m.url + t.entry;
    stageEl.appendChild(f);
    rec.frames.set(t.id, f);
  }
  f.hidden = false;
  f.focus();
}

export function setSurface(id) {
  const next = id === 'dashboard' || allTabs().find((t) => t.id === id) ? id : 'dashboard';
  if (next === surface) {
    applySurface();
    return;
  }
  surface = next;
  renderTabs();
  shell.onSurface(surface);
  dbg('surface', { surface });
}

export const currentSurface = () => surface;
/** true once a person has clicked a top-bar tab (so the web build's "open on Workrooms" never overrides their choice) */
let surfaceChosen = false;
export const surfaceWasChosen = () => surfaceChosen;
/** 'grid' | 'frame' | 'rooms' | 'console' | 'servers' | 'codex' for the active tab. */
export const surfaceKind = () => {
  const t = allTabs().find((x) => x.id === surface);
  return t ? t.surface : 'grid';
};
// W1: a 6 px dot on a tab's pill ("something new for you in a room you can't see"), with its tooltip
const tabDots = new Map();
export function setTabDot(id, dot, title) {
  const was = tabDots.get(id);
  if (!!(was && was.dot) === !!dot && (was ? was.title : '') === (title || '')) {
    return;
  }
  tabDots.set(id, { dot: !!dot, title: title || '' });
  renderTabs();
}

// P01 (the design s12): a number on a tab (the seats that need you, on Workrooms); 0 takes it away
const tabCounts = new Map();
export function setTabCount(id, n) {
  const v = Number.isSafeInteger(n) && n > 0 ? n : 0;
  if ((tabCounts.get(id) || 0) === v) return;
  if (v) tabCounts.set(id, v); else tabCounts.delete(id);
  renderTabs();
}

export function paneKinds() {
  const out = new Set();
  for (const rec of mods.values()) {
    for (const k of rec.panes.keys()) {
      out.add(k);
    }
  }
  return out;
}

export const hasPaneKind = (kind) => paneKinds().has(kind);

// ---------------------------------------------------------------- Global Settings > Modules

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) {
    e.className = cls;
  }
  if (text != null) {
    e.textContent = text;
  }
  return e;
}

const PLUGIN_SIDE_ENTRY = /^ui\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.html$/;
/**
 * Open a plugin's entry page in the side column for the room shown, with a binding issued exactly like a bundled
 * tool's preview (ui.side.open): its data calls go through the same admission, and the engine checks the plugin's
 * consent and granted verbs (M4). → true when it opened. The page never names a room; the binding does.
 */
export function openPluginPage(id) {
  const rec = typeof id === 'string' ? mods.get(id) : null;
  if (!rec || !pluginPageAllowed(rec) || !shownRoom || !/^[a-z][a-z0-9-]{0,40}$/.test(rec.id)) return false;
  const entry = rec.m.entry;
  if (typeof entry !== 'string' || !PLUGIN_SIDE_ENTRY.test(entry)) return false;
  const url = moduleUiUrl(rec.m, entry);
  if (url.protocol === 'wbmod:' || !url.pathname.startsWith('/app/plugins/' + rec.id + '/ui/')) return false; // its own folder only
  url.searchParams.set('surface', 'preview');
  url.searchParams.set('roomId', shownRoom.roomId);
  if (shownRoom.group) url.searchParams.set('group', shownRoom.group);
  closeSide(rec);
  rec.sideKey = 'plugin:' + rec.id;
  const binding = makeBinding(ownerNow(rec));
  const opened = shell?.openToolSide?.({ key: rec.sideKey, src: url.href, title: String(rec.m.name || rec.id).slice(0, 60), binding,
    onDispose: () => { rec.sideKey = null; rec.sideBinding = null; rec.sideOpen = null; } });
  if (opened) {
    rec.sideBinding = binding; // its rooms.tasks events go to this page (emitRoomsEvent)
    rec.sideOpen = { page: entry, roomId: shownRoom.roomId, group: shownRoom.group || null };
  } else rec.sideKey = null;
  return !!opened;
}
/** Plugin side pages (desktop plugin slice 6b, web: the design notes §5): for each plugin the catalog lists
 *  as enabled and not in error, with an entry ui/<name>.html, the page under its own /app/plugins/<id>/ folder. The
 *  engine's M1 route serves only its consented files; the side column opens it through the frame link. */
export function pluginSidePages() {
  const out = [];
  for (const m of catalog) {
    if (!m || m.source !== 'plugin' || m.enabled !== true || m.error || typeof m.id !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/.test(m.id)) continue;
    if (typeof m.entry !== 'string' || !PLUGIN_SIDE_ENTRY.test(m.entry)) continue;
    const url = moduleUiUrl(m, m.entry);
    if (url.protocol === 'wbmod:' || !url.pathname.startsWith('/app/plugins/' + m.id + '/ui/')) continue; // a plugin page only from its own folder
    out.push({ id: m.id, name: String(m.name || m.id).slice(0, 60), url: url.href });
  }
  return out;
}

/** The catalog entries as main (or the engine) gave them: the web widget layer reads widget, permissions and gen. */
export const catalogNow = () => catalog;

export function moduleList() {
  return catalog.map((m) => {
    const rec = mods.get(m.id);
    return { id: m.id, name: m.name, class: m.class, parent: m.parent, source: m.source, core: !!m.core, enabled: m.core || m.enabled !== false, effective: effective(m.id), active: !!(rec && rec.active), error: rec ? rec.error : null, tabs: rec ? [...rec.tabs.keys()] : [], panes: rec ? [...rec.panes.keys()] : [], settings: rec ? settingsOf(rec) : null };
  });
}

export function renderModulesPage(sec, builtins = []) {
  sec.textContent = '';
  if (isWeb() && catalog.some((m) => m.missing && !m.core)) {
    // the server is not serving this app's own modules: say it once, plainly, at the top (lead , 4)
    const warn = el('div', 'modmissing', "Some of this app's own tools aren't on this server, so they can't run. Whoever runs the server should point HARBOR_WB_APP_DIR at this app's built folder."); // platform 
    warn.setAttribute('role', 'alert');
    sec.appendChild(warn);
  }
  sec.appendChild(el('div', 'lbl', isWeb() ? 'Installed tools' : 'Installed modules'));
  const tree = el('div', 'modtree');
  for (const feature of builtins) {
    const row = el('div', 'modrow'); row.dataset.builtin = feature.id; row.style.setProperty('--d', 0);
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true; cb.disabled = true;
    cb.title = 'Included with Workbench: always available'; cb.setAttribute('aria-label', feature.name + ' is included with Workbench');
    const ic = el('span', 'mic'); ic.innerHTML = icon(iconName(feature.icon, 'extension'));
    const txt = el('div', 'mtx'); const name = el('div', 'mn', feature.name);
    name.appendChild(el('em', '', 'included'));
    txt.append(name, el('div', 'md desc', feature.description));
    const gear = el('button', 'sb-ib modgear'); gear.type = 'button'; gear.title = feature.name + ' settings';
    gear.setAttribute('aria-label', gear.title); gear.innerHTML = icon('settings');
    gear.addEventListener('click', feature.openSettings);
    row.append(cb, ic, txt, gear); tree.appendChild(row);
  }
  const addRows = (list, depth) => {
    for (const m of list) {
      tree.appendChild(moduleRow(m, depth));
      addRows(catalog.filter((c) => c.parent === m.id), depth + 1);
    }
  };
  addRows(catalog.filter((m) => !m.parent || !byId(m.parent)), 0);
  if (!catalog.length && !builtins.length) {
    tree.appendChild(el('div', 'hint', isWeb() ? 'No tools found.' : 'No modules found.'));
  }
  sec.appendChild(tree);
  const hint = el('div', 'hint');
  hint.textContent = 'Turning a module off removes its tab or pane in every window; a parent takes its children with it. ';
  if (isWeb()) {
    // no module folder or Rescan on a server; tools come in through "Install tool…" (a builder's installer)
    hint.textContent = 'Turning a tool off removes its tab or panel in every browser tab, and any tool that belongs to it.'; // the design s9
    sec.appendChild(hint);
    const off = window.wb.web.modulesPluginsEnabled?.() === false;
    if (off) {
      // the engine says this server takes no plugins: the design's line in place of "Add plugin…"
      pluginInstaller?.destroy?.();
      pluginInstaller = null;
      pluginHost = null;
      const host = el('div', 'modplugins web-plugins');
      host.appendChild(el('p', '', PLUGINS_OFF));
      sec.appendChild(host);
      return;
    }
    // ONE installer for the page's life: a repaint (every catalog change repaints this page) moves the same element
    // back in, so its state survives, e.g. "Plug One was removed. Its own data stays." (the design's re-walk, 2)
    if (!pluginInstaller || !pluginHost) {
      pluginHost = el('div', 'modplugins');
      pluginInstaller = mountPluginInstaller({ host: pluginHost, fetch: (u, i) => globalThis.fetch(u, i), refreshCatalog: async () => Array.isArray(await window.wb.modulesRescan()) }); // the installer counts only true as done
    }
    sec.appendChild(pluginHost);
    return;
  }
  const b = el('button', 'tbtn', 'Rescan');
  b.title = 'Look again for module folders';
  b.addEventListener('click', () => window.wb.modulesRescan());
  const where = el('div', 'hint');
  where.textContent = 'Your own modules: a folder with a module.json in ';
  const p = el('span', 'pth', info.userModulesDir || 'the modules folder');
  where.appendChild(p);
  sec.append(hint, where, b);
}

// Settings > Modules in the web build (the design's walk-through step 7, Client ): the person reads what a module
// does, in words; no internal ids, paths, versions of the build plumbing or desktop-only controls.
const isWeb = () => !!window.wb?.web;
// "It can …": the same verb form as the plugin consent words (web-plugins/model.mjs), so the two read as one list
const MODULE_PERMISSION_WORDS = {
  'ui.tab': 'add a tab', 'ui.pane': 'add a pane to Terminals', 'ui.side': 'open in the side column', 'ui.railCard': "show a card in a room's rail",
  'ui.window': 'open its own window', 'sessions.read': 'see your terminal sessions', settings: 'have its own settings', 'tools.provide': 'offer actions to other tools',
  'concierge.slot': 'sit in the Concierge',
};
/** A permission in plain words: the app's own modules first, then the plugin consent words (one source), never a raw id. */
const permissionPhrase = (p) => MODULE_PERMISSION_WORDS[p] || pluginPermissionWords(p);
/** The app's switch (settings-pages.js, .pg-sw) in place of a native checkbox. */
function moduleSwitch(on, label, disabled, onChange) {
  const b = el('button', 'pg-sw' + (on ? ' on' : ''));
  b.type = 'button';
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-checked', String(!!on));
  b.setAttribute('aria-label', label);
  if (disabled) b.disabled = true;
  if (onChange) b.addEventListener('click', () => onChange(b.getAttribute('aria-checked') !== 'true'));
  return b;
}
let pluginInstaller = null; // the web build's "Add plugin…" (web-plugins/page.mjs): one for the page's life
let pluginHost = null; // its element, moved back into each repaint of Settings > Modules

function moduleRow(m, depth) {
  const rec = mods.get(m.id);
  const eff = effective(m.id);
  const own = m.core || m.enabled !== false;
  const parentOn = !m.parent || !byId(m.parent) || effective(m.parent);
  const row = el('div', 'modrow' + (eff ? '' : ' is-off'));
  row.style.setProperty('--d', depth);
  row.dataset.mod = m.id;
  let cb;
  if (isWeb()) {
    cb = moduleSwitch(own && !m.error, m.name + (own && !m.error ? ' is on' : ' is off'), !!m.core || !parentOn || !!m.error, (on) => window.wb.moduleSet({ id: m.id, enabled: on }));
    cb.title = m.core ? 'Always on' : !parentOn ? 'Off with the tool it belongs to' : own ? 'Turn off' : 'Turn on';
  } else {
    cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = own && !m.error;
    cb.disabled = !!m.core || !parentOn || !!m.error;
    cb.title = m.core ? 'Core module: always on' : !parentOn ? 'Off with its parent' : own ? 'Turn off' : 'Turn on';
    cb.addEventListener('change', () => window.wb.moduleSet({ id: m.id, enabled: cb.checked }));
  }
  const ic = el('span', 'mic');
  ic.innerHTML = icon(m.icon || 'extension');
  const txt = el('div', 'mtx');
  const name = el('div', 'mn', m.name);
  if (isWeb()) {
    name.appendChild(el('em', 'modchip', m.source === 'plugin' ? 'Added by you' : 'Built in')); // the design s9: where it came from, in words
  } else if (m.core) {
    name.appendChild(el('em', '', 'core'));
  }
  const parts = [m.class, m.source, 'v' + m.version];
  if (m.error) {
    parts.push('not loaded: ' + m.error);
  } else if (rec && rec.held) {
    parts.push('not used: ' + rec.held); // a second provider of an id: the first by load order wins
  } else if (rec && rec.error) {
    parts.push('failed to load: ' + rec.error);
  } else if (own && !eff) {
    parts.push(parentOn ? 'needs ' + (m.requires || []).filter((r) => !effective(r)).join(', ') : 'off with ' + (byId(m.parent) || {}).name);
  }
  if (isWeb()) {
    // the version and any reason it is not running, then what it may do, in words
    const status = parts.slice(3);
    txt.append(name, el('div', 'md', ['Version ' + m.version, ...status].join(' · ')));
    // the web build has no module windows yet: never promise one
    const can = (m.permissions || []).filter((p) => p !== 'ui.window').map(permissionPhrase);
    if (can.length) txt.appendChild(el('div', 'md', 'It can ' + can.join(', ') + '.'));
    if (m.description) txt.appendChild(el('div', 'md desc', m.description));
    if (m.source === 'plugin') txt.appendChild(el('div', 'md', "Opens from a room's Tools button.")); // the design s9: the Tools page has no Open button
    row.append(cb, ic, txt);
    if (m.source === 'plugin') {
      // a person-installed plugin: Remove asks first (a builder's installer draws the confirmation; no Undo); on its
      // own line under the text, so the name and words keep the row's width (the design's re-walk, 3)
      const rm = el('button', 'tbtn modremove', 'Remove');
      rm.type = 'button';
      rm.setAttribute('aria-label', 'Remove ' + m.name);
      rm.addEventListener('click', () => pluginInstaller?.requestRemove?.(m.id, m.name));
      const line = el('div', 'modactions');
      line.appendChild(rm);
      txt.appendChild(line);
    }
    if ((m.settingsSchema && Object.keys(m.settingsSchema).length) || (m.tool && !m.error)) {
      const g = el('button', 'sb-ib modgear');
      g.title = m.name + ' settings';
      g.setAttribute('aria-label', m.name + ' settings');
      g.innerHTML = icon('settings');
      g.disabled = !eff;
      g.addEventListener('click', () => shell.openSettings('mod:' + m.id));
      row.appendChild(g);
    }
    return row;
  }
  const sub = el('div', 'md', parts.join(' · '));
  const perms = el('div', 'md', 'permissions: ' + ((m.permissions || []).length ? m.permissions.join(', ') : 'none'));
  txt.append(name, sub, perms);
  if (m.tool) {
    // what a tool serves, where, and the two sheets that style any frame it gets (§5)
    txt.appendChild(el('div', 'md', 'provides ' + m.tool.provides.join(', ') + ' · works in ' + m.tool.contexts.join(', ') + (m.tool.role ? ' · role ' + m.tool.role : '') + ' · styled by host.css' + (m.tool.style ? ', ' + m.tool.style : '')));
  }
  if (m.description) {
    txt.appendChild(el('div', 'md desc', m.description));
  }
  row.append(cb, ic, txt);
  if ((m.settingsSchema && Object.keys(m.settingsSchema).length) || (m.tool && !m.error)) {
    const g = el('button', 'sb-ib modgear');
    g.title = m.name + ' settings';
    g.setAttribute('aria-label', m.name + ' settings');
    g.innerHTML = icon('settings');
    g.disabled = !eff;
    g.addEventListener('click', () => shell.openSettings('mod:' + m.id));
    row.appendChild(g);
  }
  return row;
}

export function renderModuleSettings(sec, id) {
  sec.textContent = '';
  const m = byId(id);
  if (!m) {
    sec.appendChild(el('div', 'hint', isWeb() ? 'This tool is not installed.' : 'This module is not installed.'));
    return;
  }
  const rec = mods.get(id);
  const lbl = el('div', 'lbl', m.name + ' ');
  lbl.appendChild(el('em', '', 'v' + m.version + ' · ' + m.class));
  sec.appendChild(lbl);
  if (m.description) {
    sec.appendChild(el('div', 'hint', m.description));
  }
  const schema = m.settingsSchema || {};
  const cur = coerce(schema, m.settings || {});
  const apply = (patch) => {
    if (rec) {
      setSettings(rec, patch);
    } else {
      window.wb.moduleSet({ id, settings: coerce(schema, { ...(m.settings || {}), ...patch }) });
    }
  };
  for (const [k, def] of Object.entries(schema)) {
    sec.appendChild(fieldFor(k, def, cur[k], (v) => apply({ [k]: v })));
    if (def.hint) {
      sec.appendChild(el('div', 'hint', def.hint));
    }
  }
  if (!Object.keys(schema).length) {
    sec.appendChild(el('div', 'hint', isWeb() ? 'This tool has no settings.' : 'This module has no settings.'));
  }
  if (m.tool && !m.error) {
    sec.appendChild(el('div', 'hint', 'Its frames are styled by host.css' + (m.tool.style ? ', then ' + m.tool.style : '') + '.'));
    const prefs = shell && shell.prefs ? shell.prefs() : {};
    if (prefs && prefs.developer && !isWeb()) { // no developer mode in the web build
      renderTry(sec, m, rec);
    }
  }
}

// One schema field (the settings dialect; the same code renders an action's input form).
function fieldFor(k, def, value, onChange) {
  const fld = el('div', 'fld');
  const title = el('span', '', def.title || k);
  if (def.chip) {
    title.appendChild(el('span', 'fld-chip', def.chip)); // a small tag beside the name ("Preview"), not part of it
  }
  fld.appendChild(title);
  let input;
  if (def.type === 'boolean') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!value;
    input.addEventListener('change', () => onChange(input.checked));
  } else if (Array.isArray(def.enum)) {
    input = document.createElement('select');
    for (const o of def.enum) {
      input.add(new Option(String(o), String(o)));
    }
    input.value = value;
    input.addEventListener('change', () => onChange(input.value));
  } else if (def.type === 'number') {
    input = document.createElement('input');
    const ranged = typeof def.min === 'number' && typeof def.max === 'number';
    input.type = ranged ? 'range' : 'number';
    if (typeof def.min === 'number') {
      input.min = def.min;
    }
    if (typeof def.max === 'number') {
      input.max = def.max;
    }
    input.step = def.step || 1;
    input.value = value;
    const out = ranged ? el('output', '', String(value)) : null;
    input.addEventListener('input', () => {
      if (out) {
        out.textContent = input.value;
      }
      onChange(Number(input.value));
    });
    input.dataset.key = k;
    fld.appendChild(input);
    if (out) {
      fld.appendChild(out);
    }
    return fld;
  } else {
    input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    if (typeof def.maxLength === 'number') {
      input.maxLength = def.maxLength;
    }
    input.value = value == null ? '' : value;
    input.addEventListener('input', () => onChange(input.value));
  }
  input.dataset.key = k;
  fld.appendChild(input);
  return fld;
}

// Try (the design notes §6; behind the Developer switch): pick an action, fill its input
// form from the schema, call it in the dashboard context, see the output inline. The first caller
// and the test harness in one. Words: the design's mapping for PR #1 (2026-10-19).
function renderTry(sec, m, rec) {
  const box = el('div', 'try');
  box.dataset.tool = m.id;
  box.appendChild(el('div', 'lbl', 'Try it'));
  const t = m.tool;
  const actions = t.actions.filter((a) => a.contexts.includes('dashboard'));
  if (!rec || !rec.active) {
    box.appendChild(el('div', 'hint', 'Turn ' + m.name + ' on to try it.'));
    sec.appendChild(box);
    return;
  }
  if (!actions.length) {
    box.appendChild(el('div', 'hint', m.name + ' has nothing to try here. Try runs the actions a tool offers the dashboard.'));
    sec.appendChild(box);
    return;
  }
  const pick = el('div', 'fld');
  pick.appendChild(el('span', '', 'Action'));
  const sel = document.createElement('select');
  sel.dataset.key = 'action';
  for (const a of actions) {
    sel.add(new Option(a.title + ' (' + a.provides + ')', a.name));
  }
  pick.appendChild(sel);
  box.appendChild(pick);
  const form = el('div', 'try-form');
  const out = el('div', 'try-out');
  const status = el('div', 'hint try-status');
  const values = {};
  const build = () => {
    form.textContent = '';
    const a = actions.find((x) => x.name === sel.value);
    for (const [k, def] of Object.entries(a.input || {})) {
      values[k] = values[k] === undefined ? (def.default == null ? (def.type === 'boolean' ? false : def.type === 'number' ? 0 : '') : def.default) : values[k];
      form.appendChild(fieldFor(k, def, values[k], (v) => (values[k] = v)));
    }
  };
  sel.addEventListener('change', build);
  build();
  const run = el('button', 'tbtn', 'Run');
  run.dataset.act = 'try-run';
  run.addEventListener('click', async () => {
    run.disabled = true;
    status.textContent = 'Running…';
    out.textContent = '';
    const a = actions.find((x) => x.name === sel.value);
    try {
      const r = await callTool(a.provides, a.name, values, 'dashboard', 'try');
      showOutput(out, r);
      status.textContent = 'Returned ' + r.kind + ' · ' + r.data.length.toLocaleString('en-US') + ' characters';
    } catch (e) {
      status.textContent = m.name + " couldn't run " + a.title + ': ' + String((e && e.message) || e);
    }
    run.disabled = false;
  });
  box.append(form, run, status, out);
  sec.appendChild(box);
}

/** The inline output: an SVG becomes live markup (so the host's roles reach it); text stays text. */
let renders = 0;
function showOutput(out, r) {
  out.textContent = '';
  if (r.kind === 'image/svg+xml') {
    const doc = new DOMParser().parseFromString(r.data, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg' || svg.namespaceURI !== 'http://www.w3.org/2000/svg' || doc.querySelector('parsererror')) {
      out.appendChild(el('div', 'hint', "The output isn't valid SVG, so it can't be drawn."));
      return;
    }
    // the allowlist (svg-sanitize.js): drawing elements and attributes only; no style, no class, no
    // handlers, no SMIL, no url( but url(#id), href on use only, ids and references scoped to this
    // render. What went is logged, never shown as markup.
    const removed = sanitizeSvgTree(svg, { prefix: 'tc' + ++renders + '-' }); // ids scoped per render: no host id clobbered, no reference out of the card
    if (removed.elements.length || removed.attributes.length) {
      dbg('tool-svg-pruned', { elements: removed.elements.slice(0, 10), attributes: removed.attributes.slice(0, 10) });
    }
    const node = document.importNode(svg, true);
    node.removeAttribute('width');
    node.removeAttribute('height');
    node.classList.add('try-svg');
    out.appendChild(node);
  } else {
    const pre = el('pre', 'try-text', r.data);
    out.appendChild(pre);
  }
}

// For the hidden self test: call an op as a module would.
export function callFor(id, op, args) {
  const rec = mods.get(id);
  if (!rec) {
    return Promise.reject(new Error('module not active: ' + id));
  }
  return request(rec, rec.gen, op, args);
}
