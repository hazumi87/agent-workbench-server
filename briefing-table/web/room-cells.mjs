/* ROOM CELLS — the left column as a stack of collapsible cells (the design system
 * room-cells-v1, ticket/1762). The seats cell first (room.html draws it),
 * then one cell per room PANEL: an app-served view the ENGINE proxies.
 *
 * The rules that make a panel safe to draw, from the engine
 * (src/engine/panel-url.ts, header) — do not relax any of them here:
 *   - frame `frameUrl` (the engine proxy, a per-panel token), NEVER `url`;
 *     and change the iframe's src only when frameUrl changes (it is stable
 *     for hours, so a 2.5 s poll must not reload the app)
 *   - sandbox = allow-forms allow-popups allow-popups-to-escape-sandbox, plus
 *     allow-scripts ONLY when panel.scripts. NEVER allow-same-origin: the frame
 *     is served by the engine, i.e. THIS origin, and a same-origin frame with
 *     scripts could lift its own sandbox and act as the room page with Owner's
 *     cookie. Never allow-top-navigation, never allow-modals.
 *   - referrerpolicy=no-referrer
 *   - title and icon are TEXT and an icon KEY, never HTML or a URL
 *
 * What a panel may ask of the host, by postMessage (anything else is ignored):
 *   {panel:'height', px, glance?} → what its rail frame WANTS (default 180).
 *                                THE RAIL HEIGHT BUDGET [ticket] decides what
 *                                it GETS (allocateHeights): the open cells
 *                                share the rail's visible height, a cell never
 *                                gets more than its px nor less than 96, and
 *                                no cell is clipped while blank rail shows
 *                                below the last one. glance (optional, a
 *                                number 0..px, else ignored) is the height of
 *                                the app's must-see content, guaranteed FIRST
 *                                (before any cell grows toward its px).
 *                                Report glance = your priority content plus
 *                                about half of the next row, so a partly
 *                                visible row signals more below. Rail frames
 *                                only: preview / large / dialog / phone
 *                                layers size themselves and ignore it.
 *   {panel:'open', url, title} → the host lightbox (url resolved against the
 *                                frame, http(s) only); an image shows full
 *                                size, anything else as a link to open
 *   {panel:'count', n}         → the count in its cell header
 *   {panel:'copy', text}       → the host copies it (a sandboxed frame has no
 *                                clipboard) and shows a 1.5 s toast
 *   {panel:'download', url, name?} → the host saves it with its own <a download>
 *                                (a sandboxed frame without allow-downloads
 *                                cannot); url resolved against the frame,
 *                                http(s) only, same rule as a preview action
 *   {panel:'compose', text}    → the host PREFILLS the room composer (e.g.
 *                                "#2 v3: "), and NEVER sends it. Honoured only
 *                                from an APP panel's frames (app_slug set: its
 *                                cell, phone layer, preview view, large view),
 *                                never the voice panel; at most 1 a second per
 *                                frame. text: plain, newlines stripped, then
 *                                1..200 chars (longer = ignored). An empty
 *                                composer is set; otherwise it goes in at the
 *                                caret with a separating space; the composer
 *                                is focused with the caret after it and the
 *                                draft saved as typing would (o.onCompose).
 *                                From the large view the modal closes back to
 *                                the column; on a phone the preview closes, so
 *                                the composer is in sight.
 *   PANEL ACTIONS [ticket] travel on a MessagePort, never on window
 *   postMessage (a {panel:'action'} sent that way is refused, answered
 *   {host:'action-result', name, ok:false}):
 *     host → frame, on the frame's FIRST load only: {host:'port'} with one
 *       transferred MessagePort (e.ports[0]). Only an APP panel's frames
 *       (app_slug set, never the voice panel) get one. A second load (the
 *       frame navigated itself, or reloaded) closes that port and no new one
 *       is handed out until the HOST loads the frame again (a new frameUrl,
 *       retry, re-mount) — so a frame that navigated to another page can
 *       never act.
 *     frame → host, on that port: {panel:'action', name, params?, input?} →
 *       the host POSTs /api/rooms/:id/panels/:pid/action with the person's
 *       cookie: ONE of the app's own actions, declared `"panel": true` in the
 *       tool.json a human registered (the ENGINE holds the allow-list and
 *       fills :roomId). Needs a CLICK: honoured only while the room page has
 *       transient user activation (navigator.userActivation.isActive — a
 *       click inside the frame activates its ancestors too); at most one in
 *       flight and one per 500 ms per frame.
 *     host → frame, on that port: {host:'action-result', name, ok, error?,
 *       warning?} (warning [ticket]: the action ran, but the room line its
 *       postsToRoom verb answered was not posted — also toasted)
 *       ('needs a click' / 'too fast' / 'needs-approval' (the app is held:
 *       its tool.json changed) / 'not-registered' (a person unregistered it)
 *       / the engine's or app's error); a failure the route answered is also
 *       toasted in the cell.
 *     host → frame, on that port [ticket]: {host:'app-status', actions:
 *       'enabled'|'held'|'unregistered', settingsUrl:'/settings.html#apps'}
 *       right after the port, and again whenever the room's projection says
 *       the app's state CHANGED (panel.app_status, re-read on room.state). A
 *       held or unregistered app's VIEW still draws; only its actions stop.
 *     host → frame, on that port (ticket seam): {host:'surface', kind:
 *       'rail'|'preview'|'large'|'dialog'|'window'} right after the
 *       app-status (and again on change); none = 'rail'. The cell and the
 *       phone layer are 'rail'; 'window' is the full page (below). Every NON-rail frame's initial src also carries
 *       ?surface=<kind> (withSurface) so the app lays out from the first
 *       paint. Apps lay out by width and decide BEHAVIOUR by the surface.
 *     host → frame [app theme, the design system [ref], Owner 2026-10-05]: {host:'theme',
 *       mode:'dark'|'light', tokens:{...}, room?:'#hex'} right after the
 *       surface, and again on any palette / Dark-Light change (web/app-theme.mjs).
 *       A light frame's initial src also carries ?mode=light.
 *     frame → host, on that port [ticket]: {panel:'open-settings'} → the
 *       host opens Settings → Apps (a shell tab, else a window: a sandboxed
 *       frame cannot navigate itself). Needs a click, like an action; only on
 *       the port, so only the panel that holds it.
 *     FULL PAGE [ticket] (web/room-app-dialog.mjs, web/room-app.mjs):
 *     frame → host, on that port: {panel:'page', enabled, path?, title?} →
 *       declares a full page (path: a dialog-style relative path, '' = the
 *       panel root; title <= 40 chars, default 'Full view'); the cell's title
 *       bar then shows "Open full page" (PC only). enabled:false withdraws.
 *     frame → host, on that port: {panel:'open-page', path?, title?} → opens
 *       it: the dialog's gate (a click, 500 ms, 'enabled'), answered {host:
 *       'page-result', ok, error?} ('needs a click' / 'too fast' /
 *       'needs-approval' / 'not-registered' / 'bad path' / 'bad title' /
 *       'not available on a phone'). Opens /room-app.html?room=&panel=&path=
 *       &title= as a SELECTED tab of the CLI Manager shell ({hwbOpenTab},
 *       sessionId room-app:<room>:<panel>:<path>, so a repeat selects it),
 *       else a browser tab. Title: "<view> | <App> | <Room>". The rail
 *       panel is untouched; the page frames the same app with ?surface=window
 *       and the same port; room-only asks are answered 'not available in a
 *       full page' (see room-app.mjs).
 *     frame → host, on that port [ticket]: {panel:'dialog', path, title?,
 *       size?:'md'|'lg'} → a MODAL over the room framing the panel's OWN app
 *       at frameUrl + path (web/room-app-dialog.mjs: relative, under the
 *       panel's directory, never another app or the engine). The same gate as
 *       an action: a click (userActivation), one per 500 ms per frame, the app
 *       'enabled'. One dialog at a time. Answered {host:'dialog-result', ok,
 *       error?} ('needs a click' / 'too fast' / 'needs-approval' /
 *       'not-registered' / 'bad path' / 'bad title' / 'bad size' / 'a dialog
 *       is already open'). The dialog frame has the panel's sandbox and gets
 *       its OWN port (the same contract: actions, open-settings, app-status),
 *       plus {panel:'close-dialog'} (from it or its panel; no click needed).
 *       Esc (while focus is on the host side: a frame keeps its own keys), ✕
 *       and a scrim click close it too; however it closes, the ORIGINATING
 *       panel hears {host:'dialog-closed'} on its port. Closing touches
 *       nothing else. On a phone it is a full-screen sheet.
 *     frame → host, on that port [asset picker, Owner 2026-10-05]: {panel:'pick',
 *       kind:'image', sources:['room'] | ['room','library'], title?} → the host
 *       ASSET PICKER (web/asset-picker.mjs: a modal, a bottom sheet on a phone;
 *       Room tab, Library tab; newest first, 3x3, more on scroll). Needs the
 *       `pick` host capability declared in tool.json host_capabilities (the
 *       panel projection's host_caps), and the dialog's gate: a click, one per
 *       500 ms per frame, the app 'enabled'. One picker at a time. Answered
 *       {host:'picked', items:[{source:'room', name, type}]} |
 *       {host:'picked', items:[{source:'library', library_id}]} |
 *       {host:'picked', cancelled:true}; a refusal is {host:'picked', error}
 *       ('needs a click' / 'too fast' / 'needs-approval' / 'not-registered' /
 *       'not declared' / 'bad kind' / 'bad sources' / 'bad title' / 'a picker is
 *       already open'). One item (single pick). GATE: after a SUCCESSFUL pick
 *       that same panel's next ONE port action within 10 s passes the click gate
 *       as if clicked (the modal took the click's activation); a cancel opens
 *       nothing. Only a frame click can open the picker, so an agent cannot.
 *     NOTES [ticket] (spec KB design-notes-id; host half: web/room-notes.mjs).
 *       The panel is a sandboxed frame with no person cookie: it only READS
 *       notes (through its own app server) and asks the host to act. Any APP
 *       panel may use it (nothing here is Assets-specific); port only.
 *       frame → host: {panel:'notes', enabled:true} once after the handshake.
 *         The cell's title-bar "+" (and the phone layer's) becomes a menu:
 *         "Import a file" (only for an uploads panel) and "New note". Ignored
 *         when the engine has no notes (the + keeps today's behavior).
 *       frame → host: {panel:'note', op, id?}, op one of 'new' | 'edit' |
 *         'attach' | 'copy' | 'pin' | 'unpin' | 'archive' | 'unarchive'; id is
 *         12 hex chars (none for 'new'). new: the host creates a note and
 *         opens the editor on it; edit: opens the editor on id; attach:
 *         the note becomes a tile in the composer tray; copy: its text goes to
 *         the clipboard (a ClipboardItem promise, so a click's permission
 *         survives the fetch; textarea fallback); pin/unpin/archive/unarchive:
 *         the host POSTs. Answered {host:'note', op, id?, ok, error?}
 *         ('bad request' for an unknown op or a malformed id, else the engine's
 *         words).
 *       host → frame: {host:'notes-changed'} whenever the host changed a note
 *         in this room (created, saved-and-closed, attached, pinned, archived,
 *         moved from a draft), to every frame of a panel that declared notes,
 *         so the panel re-fetches at once instead of waiting for its poll.
 *       An older host never answers: the panel still lists and filters notes.
 *   {panel:'dragover'}         → files are over its frame: echo {panel:'dragover'}
 *   {panel:'drop'|'paste', files} → the host UPLOADS them to the room
 *                                (POST /api/rooms/:id/assets, raw body,
 *                                x-filename URI-encoded, the cookie), then
 *                                sends {panel:'added'}
 * and the host tells a panel {panel:'dragover'|'dragleave'|'added'}; a drag
 * over the cell OUTSIDE the frame (its header, owner line) is the host's own,
 * and a drop there uploads the same way (room-assets START-HERE.md).
 *
 * THE PREVIEW COLUMN (round 3, the design system room-round3-v1; contract: the round-3
 * panel <-> room preview contract, nuc1 2026-09-27). Same rules as above:
 *   {panel:'preview', item}  → the room's preview column shows the item (one at
 *       a time, replacing). item = {key<=120, type<=24, title<=200, image?,
 *       status?<=40, excerpt?<=2000, meta?<=12 [[label<=80, value<=200]],
 *       actions?<=4 of {label<=40, open:url | copy:text<=4096 | download:url}}.
 *       Every field is TEXT; URLs resolve against the SENDING frame and must
 *       be http(s); the image is an <img>, its click the host lightbox. No key
 *       (or one over 120) = ignored; an action or image that fails = dropped.
 *       A MARKDOWN / TEXT FILE [ticket]: an item with no image whose title, file
 *       name (its download/open URL) or type label says .md/.markdown/.txt/.log/
 *       .json/.csv/.yaml opens in the host's DOCUMENT VIEWER (room-doc-view.mjs):
 *       the host fetches the text from the download (else open) URL, renders
 *       markdown sanitized, and draws its own header tools (full screen, link =
 *       the item's copy action text, copy contents, ... print/download/source).
 *       The item's own actions are not drawn for it; the host fetches with the
 *       person's cookie, so the URL must be readable that way (same origin, or
 *       CORS), else the pane offers Download. Over 2 MB: "Too large to preview".
 *   {panel:'preview', view:{path, title<=80}} → the column shows the panel's
 *       OWN app at a sub-path: frameUrl + path (relative, no '..', no scheme,
 *       no '/' or '\\' start), a VIEW frame with the cell's sandbox and
 *       referrer rules. That frame may speak for its panel too; an item it
 *       sends opens with "← Back to <title>" (the view is kept, not reloaded).
 *   {panel:'preview-close'} → closes the column, only if it shows this panel's.
 *   HOST-INITIATED (line links into a tool view [rooms/tool-links]): the page
 *       opens a panel's view itself (openLink: the column, exactly as a
 *       {panel:'preview', view} would; or LARGE, a modal over the page with
 *       the same frame rules). The column's Expand (desktop) opens the view
 *       it shows large; Esc / ✕ closes the modal back to the column.
 *   host → every frame of every panel: {panel:'preview-state', key} — the key
 *       of this panel's item that is open now, else null (on change and on
 *       each frame's load).
 *
 * The upload is the host acting with Owner's cookie on a panel's say-so, so it
 * is honoured ONLY for a panel registered `uploads:true` (engine-set at
 * registration, never PATCHable; today: Assets), and even then capped (UPLOAD_MAX_FILES per message, UPLOAD_MAX_BYTES each) and every
 * upload is SHOWN in the cell ("Adding 2 files…" / the result).
 *
 * THE VOICE PANEL (the design notes §9, W1). The ONE panel the engine
 * registers itself: kind 'voice', seat_id null ("via voice agent"). Three
 * more messages, honoured ONLY from that panel's own frames (any other panel
 * sending them is ignored — the trust rule is part of the contract):
 *   {panel:'status', speaking:bool} → the RENDER HANDSHAKE and the one fact
 *       the engine lacks. The frame stays hidden until the first one: an
 *       iframe `load` proves nothing (it fires on the proxy's own 502 page
 *       too), so no status within VOICE_HANDSHAKE_MS = "Voice isn't
 *       answering · retry" plus the HOST's own Mute/Disconnect. Those fallback
 *       buttons exist only while the frame is down — never two sets.
 *   {panel:'voice', action:'mute'|'unmute'|'disconnect'} → o.onVoiceAction
 *       (the host calls the engine with the person's cookie)
 *   {panel:'line', lineId} → o.onLine (scroll to that line)
 * connected / muted / waiting are ENGINE facts (setVoice, from the room view)
 * and the cell header is the only place that draws them (§9.4).
 *
 * Collapse is kept per room, per cell, in this browser only (localStorage).
 * On a phone every cell but the seats starts collapsed.
 */
import { cleanVoice, paintStatus, puckGlyph } from '/room-voice.mjs';
import { SETTINGS_APPS_URL, openAppSettings } from '/app-status.mjs';
import { cleanDialog, cleanPageDecl, cleanPageRequest, askGate, pageTabUrl, pageDocTitle, cleanPick, openPickWindow, takePickWindow, pickedMessage } from '/room-app-dialog.mjs';
import { openAssetPicker } from '/asset-picker.mjs';
import { ACTION_NAME, ACTION_GAP_MS, runPanelAction, copyText, saveUrl, openTab } from '/room-app-port.mjs';
import { createMenuHost } from '/room-seat-menu.mjs';
import { toneFor } from '/app-tones.mjs';
import { tokens as paletteTokens } from '/palette.mjs';
import { effectivePref } from '/room-palette.mjs';
import { themeMessage, withMode } from '/app-theme.mjs';
import { docKind, createDocView } from '/room-doc-view.mjs';
const RSAQUO = String.fromCharCode(8250);
const settingsAt = new WeakMap(); // frame element -> last honoured {panel:'open-settings'}

const H_MIN = 96;
const H_DEFAULT = 180;
const LOAD_TIMEOUT_MS = 15000;
const PHONE = '(max-width: 600px)';
const TOAST_MS = 1500;
const UPLOAD_MAX_FILES = 10;
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const COPY_MAX = 4096;
const PV_ACTIONS_MAX = 4;
const PV_META_MAX = 12;
const VOICE_HANDSHAKE_MS = 5000;
const VOICE_ACTIONS = ['mute', 'unmute', 'disconnect', 'id-on', 'id-off', 'openmic-on', 'openmic-off'];
const COMPOSE_MAX = 200;
const COMPOSE_GAP_MS = 1000;
const PAGE_SVG = '<path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>';
const CLOSE_SVG = '<path d="M6 6l12 12M18 6 6 18"/>';

/** The engine-registered voice panel (§9.1): kind voice AND no seat. */
function isVoice(p) {
  return p?.kind === 'voice' && (p.seat_id === null || p.seat_id === undefined) && !p.seat_handle;
}

/* 16px line glyphs by icon KEY (the design system room-cells-v1); unknown keys draw the
   generic panel square, never whatever the key says */
const ICONS = {
  tasks: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h8M8 17h5"/>',
  assets: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-8 8"/>',
  panel: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M4 9h16"/>',
  voice: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6"/><path d="M18 6.8a7.4 7.4 0 0 1 0 10.4"/>',
};
ICONS.list = ICONS.tasks;
ICONS.image = ICONS.assets;
ICONS.images = ICONS.assets;

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|svg)(\?|#|$)/i;

/** A URL a panel named, resolved against the frame that named it; http(s)
 *  only (javascript:, data:, blob: … never). */
function safeUrl(raw, base) {
  try {
    const u = new URL(String(raw), new URL(base, location.href));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch {
    return null;
  }
}

/** A view's sub-path: relative, under the panel's frame. No scheme, no '..'
 *  segment, no leading '/', no backslash (which a URL parser reads as '/'),
 *  at most 200 characters. null = refused. */
export function cleanPath(p) {
  if (typeof p !== 'string' || p.length > 200 || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('/') || p.includes(String.fromCharCode(92))) {
    return null;
  }
  const segs = p.split(/[?#]/)[0].split('/');
  if (segs.some((s) => s === '..' || s.toLowerCase() === '%2e%2e' || s === '.%2e' || s === '%2e.')) {
    return null;
  }
  return p;
}
/** frameUrl + a clean path; the result must stay under the frame. */
export function viewUrl(frameUrl, path) {
  const base = new URL(frameUrl, location.href);
  const u = new URL(path, base);
  return u.href.startsWith(base.href) ? u.pathname + u.search + u.hash : frameUrl;
}
/** WHERE a panel's frame is drawn (ticket seam; pinned with the panel-actions
 *  owner 2026-09-30). 'window' is reserved for the pop-out (not built). */
export const SURFACES = ['rail', 'preview', 'large', 'dialog', 'window'];
/** A frame's initial URL carries its surface so the app lays out right from
 *  the first paint: every NON-rail frame gets `?surface=<kind>` (`&` when the
 *  URL already has a query), before any #fragment. A rail frame, or an
 *  unknown kind, is returned unchanged. Only the frame's src — never the
 *  view's identity (v.src), which the change passes compare. */
export function withSurface(url, kind) {
  if (kind === 'rail' || !SURFACES.includes(kind)) {
    return url;
  }
  const i = url.indexOf('#');
  const base = i < 0 ? url : url.slice(0, i);
  const sep = !base.includes('?') ? '?' : /[?&]$/.test(base) ? '' : '&';
  return `${base}${sep}surface=${kind}${i < 0 ? '' : url.slice(i)}`;
}

/* THE RAIL HEIGHT BUDGET [ticket] (Owner 2026-09-30: the Tasks panel was cut
 * off at "+ New topic" while half the rail below Assets was blank. "Fit
 * everything pinned in the view, and then at least down to half of the text
 * new topic so there's user affordance that they can scroll to see more.")
 * PURE: the host measures `available` (the rail's visible height minus
 * everything that is not an open app frame) and writes the answer.
 *   pass 1: each cell gets max(min, min(glance ?? min(reqPx, dflt), reqPx)) —
 *     its must-see content first. If those do not fit, all scale down in
 *     proportion, none below `min` (the rail scrolls, as before).
 *   pass 2 (water-filling, SMALL needs first): what is left goes to the
 *     cells still short of their reqPx in ascending order of what each still
 *     lacks — each gets ALL of it while the leftover lasts, the first one it
 *     cannot cover gets whatever remains. So a short app that fits whole
 *     always shows whole, and the tall one takes the rest.
 * So no cell is clipped while blank space shows below the last one, and a
 * cell never passes its reqPx. Integer px. Self-contained on purpose (the
 * unit test slices it out of this file). */
export function allocateHeights(available, cells, min = 96, dflt = 180) {
  const avail = Math.max(0, Math.floor(Number.isFinite(available) ? available : 0));
  const req = cells.map((c) => Math.max(min, Math.round(c.reqPx)));
  const want = cells.map((c, i) => {
    const g = Number.isFinite(c.glance) ? c.glance : Math.min(c.reqPx, dflt);
    return Math.max(min, Math.min(Math.round(g), req[i]));
  });
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const topUp = (h, cap, left) => {
    for (let i = 0; left > 0 && i < h.length; i += 1) {
      if (h[i] < cap[i]) {
        h[i] += 1;
        left -= 1;
      }
    }
    return h;
  };
  if (sum(want) > avail) {
    /* too tight even for pass 1: scale down, floored at min */
    const floored = new Set();
    for (;;) {
      const free = sum(want.filter((_, i) => !floored.has(i)));
      const s = free > 0 ? Math.max(0, avail - floored.size * min) / free : 0;
      const newly = want.map((w, i) => (!floored.has(i) && w * s < min ? i : -1)).filter((i) => i >= 0);
      if (!newly.length) {
        const h = want.map((w, i) => (floored.has(i) ? min : Math.floor(w * s)));
        return topUp(h, want, avail - sum(h));
      }
      newly.forEach((i) => floored.add(i));
    }
  }
  let rem = avail - sum(want);
  const h = want.slice();
  const order = req.map((r, i) => i).filter((i) => req[i] > want[i]).sort((a, b) => (req[a] - want[a]) - (req[b] - want[b]) || a - b);
  for (const i of order) {
    const give = Math.min(req[i] - want[i], rem);
    h[i] += give;
    rem -= give;
    if (!rem) {
      break;
    }
  }
  return h;
}

/* THE RAIL REFRESH [ticket] (Owner 2026-09-29: "the tools in the left column
 * run together"). Each tool's cell wears ONE identity tone from the design system
 * extended palette (--id-*: categorisation, never the seven function colours),
 * so a tool keeps its tone in every room: Tasks cobalt, Assets green, Image
 * Studio orchid, Voice violet, Model Studio orange. An unknown tool hashes its
 * key into the same five. The seats cell wears the room colour (room.css). */
/* [hub-v2] the default table + hash moved to web/app-tones.mjs (the Settings page
   reads it too); a person's own tone for an app (Settings → Apps → Title bar,
   GET /api/rooms/me `tones`) wins over it. */
let userTones = {};
export function setUserTones(t) {
  userTones = t && typeof t === 'object' ? t : {};
}
export function cellTone(p) {
  return toneFor(p, userTones);
}

function iconSvg(key) {
  const k = typeof key === 'string' && Object.prototype.hasOwnProperty.call(ICONS, key) ? key : 'panel';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[k]; // a constant from the table above, never the key
  return svg;
}

/**
 * @param {{roomId: string, column: HTMLElement, list: HTMLElement,
 *          lightbox: HTMLElement, onStale?: () => void, onPanels?: () => void}} o
 *   column: the aside (holds the seats cell); list: where panel cells go;
 *   onStale: a frame's token was refused (expired): re-fetch the room.
 *   onPanels: the panel list or an app's count changed (the phone's chips).
 *   openSettings(): Settings → Apps (the title-bar badge, a panel's
 *   {panel:'open-settings'}); default: app-status.mjs's openAppSettings.
 *   decorateCell(hw, head, id, panel): a new panel cell's header, for the panel
 *   menu (room-panel-menu.mjs) to add its ⋯ and openers.
 *   preview: room-preview.mjs's column (optional; without it 'preview' is
 *   ignored).
 */
export function mountCells(o) {
  const key = `wb.room.cells.${o.roomId}`;
  const cells = new Map(); // panel id -> {el, head, tt, n, ic, body, own, frame, src, panel, timer}
  let voice = null; // the engine's voice state (setVoice)

  function readCollapse() {
    try {
      return JSON.parse(localStorage.getItem(key) || '{}') || {};
    } catch {
      return {};
    }
  }
  function isCollapsed(id) {
    const v = readCollapse()[id];
    if (typeof v === 'boolean') {
      return v;
    }
    return id !== 'seats' && id !== 'room' && matchMedia(PHONE).matches; // phone: apps start folded
  }
  function saveCollapse(id, v) {
    try {
      const m = readCollapse();
      m[id] = v;
      localStorage.setItem(key, JSON.stringify(m));
    } catch {
      /* private mode: the fold lasts this page's life */
    }
  }
  function wire(section, id, onOpen) {
    const head = section.querySelector('.cell-h');
    const apply = (v) => {
      section.classList.toggle('collapsed', v);
      head.setAttribute('aria-expanded', String(!v));
    };
    apply(isCollapsed(id));
    head.addEventListener('click', () => {
      const v = !section.classList.contains('collapsed');
      apply(v);
      saveCollapse(id, v);
      if (!v) {
        onOpen?.();
      }
      budget(); // a fold frees (or takes) rail height [ticket]
    });
  }

  /* the seats cell is in the page already */
  const seats = o.column.querySelector('.cell[data-cell="seats"]');
  if (seats) {
    wire(seats, 'seats');
  }
  /* the Room cell too [rail split]: its own fold, and (like Seats) open on a phone */
  const roomCell = o.column.querySelector('.cell[data-cell="room"]');
  if (roomCell) {
    wire(roomCell, 'room');
  }

  /* ---- a VIEW of a panel: its cell body (desktop) or its full-width LAYER
     (phone, room-phone-v1). Each view owns its own frame; moving an iframe
     reloads it, so the phone layer never borrows the cell's. Both obey the
     same rules (frameUrl only, the sandbox, no-referrer). ---- */
  function newView(c, body, layer, surface = 'rail') {
    return { c, body, layer, surface, frame: null, src: '', timer: 0, staleFor: '' };
  }
  function showLoading(v) {
    v.body.textContent = '';
    const b = document.createElement('div');
    b.className = 'cell-load';
    b.setAttribute('aria-label', `${v.c.panel.title} is loading`);
    v.body.append(b);
    v.frame = null;
    if (isVoice(v.c.panel)) {
      /* the HOST draws Voice's loading state, with its own Mute/Disconnect,
         until the frame reports in (A0 §1) */
      b.classList.add('vload');
      b.textContent = 'Connecting to Voice…';
      v.body.append(fallbackButtons());
    }
  }
  function showError(v) {
    clearTimeout(v.timer);
    v.body.textContent = '';
    v.frame = null;
    closePort(v);
    /* v.src keeps the url that failed: a poll re-loads only a CHANGED
       frameUrl, so an app that is down is not hammered every 2.5 s; retry is
       the person's act */
    const e = document.createElement('div');
    e.className = 'cell-err';
    const t = document.createElement('b');
    t.textContent = v.c.panel.title;
    const r = document.createElement('button');
    r.type = 'button';
    r.className = 'cell-retry';
    r.textContent = 'retry';
    r.addEventListener('click', () => void load(v));
    e.append(t, " isn't answering · ", r);
    v.body.append(e);
    if (isVoice(v.c.panel)) {
      v.body.append(fallbackButtons());
    }
  }

  /* ---- VOICE: the host's own Mute/Disconnect, drawn only while the frame is
     down (§9.3); they repaint from the engine's state, never guess ahead ---- */
  function fallbackButtons() {
    const w = document.createElement('div');
    w.className = 'vfb';
    /* THE SAME THREE BUTTONS AS THE PANEL, IN ITS ORDER (Owner, room line
       1020): open mic, the agent's voice, voice ID; then Disconnect. Open mic
       is a BUTTON, never a live "is it open now" indicator. */
    const omic = document.createElement('button');
    omic.type = 'button';
    omic.className = 'vfb-ib vfb-omic';
    const mute = document.createElement('button');
    mute.type = 'button';
    mute.className = 'vfb-ib vfb-mute';
    /* voice ID, live (Owner, room line [ref]): the same room setting as Settings'
       "Identify the speaker on every turn", so the two always agree */
    const vid = document.createElement('button');
    vid.type = 'button';
    vid.className = 'vfb-id';
    const disc = document.createElement('button');
    disc.type = 'button';
    disc.className = 'vfb-disc';
    disc.textContent = 'Disconnect';
    omic.addEventListener('click', () => o.onVoiceAction?.(voice?.openMic === false ? 'openmic-on' : 'openmic-off'));
    mute.addEventListener('click', () => o.onVoiceAction?.(voice?.muted ? 'unmute' : 'mute'));
    vid.addEventListener('click', () => o.onVoiceAction?.(voice?.idInRoom === false ? 'id-on' : 'id-off'));
    disc.addEventListener('click', () => o.onVoiceAction?.('disconnect'));
    w.append(omic, mute, vid, disc);
    paintFallback(w);
    return w;
  }
  function paintFallback(w) {
    const omic = w.querySelector('.vfb-omic');
    const open = voice?.openMic !== false;
    omic.replaceChildren(puckGlyph('puckIn', open ? 'on' : 'off'));
    omic.setAttribute('aria-pressed', String(open));
    omic.setAttribute('aria-label', 'Open mic');
    omic.title = open ? 'Open mic is ON: the Dot listens again after every reply. Click to turn it off.' : 'Open mic is OFF: say "hey jarvis" each time. Click to turn it on.';
    const mute = w.querySelector('.vfb-mute');
    const m = voice?.muted === true;
    mute.replaceChildren(puckGlyph('puckOut', m ? 'off' : null));
    mute.setAttribute('aria-pressed', String(m));
    mute.setAttribute('aria-label', m ? 'Unmute the agent' : 'Mute the agent');
    mute.title = m ? "The agent's voice is muted (replies go to the chat only). Click to let it speak." : "Mute the agent's voice: it stops speaking; you can still talk to it.";
    const vid = w.querySelector('.vfb-id');
    const on = voice?.idInRoom !== false;
    vid.textContent = 'Voice ID';
    vid.setAttribute('aria-pressed', String(on));
    vid.title = on ? 'Voice ID is on: only known voices reach the room. Click to turn it off.' : 'Voice ID is off: any voice reaches the room. Click to turn it on.';
    w.hidden = !voice?.connected;
  }
  /** No handshake in time: the host's unreachable state + fallback buttons,
   *  with the (hidden) frame kept so a late status can still revive it. */
  function showVoiceDown(v, f) {
    if (v.body.querySelector(':scope > .cell-err')) {
      return;
    }
    v.body.querySelector(':scope > .cell-load')?.remove();
    const e = document.createElement('div');
    e.className = 'cell-err';
    const t = document.createElement('b');
    t.textContent = 'Voice';
    const r = document.createElement('button');
    r.type = 'button';
    r.className = 'cell-retry';
    r.textContent = 'retry';
    r.addEventListener('click', () => void load(v));
    e.append(t, " isn't answering · ", r);
    v.body.insertBefore(e, f);
    if (!v.body.querySelector(':scope > .vfb')) {
      v.body.insertBefore(fallbackButtons(), f); // the loading state's set carries over: never two
    } else {
      v.body.insertBefore(v.body.querySelector(':scope > .vfb'), f);
    }
  }
  /** The voice frame reported in: show it, drop the loading/unreachable state
   *  and the fallback buttons (never two sets). */
  function voiceAlive(v) {
    clearTimeout(v.timer);
    v.alive = true;
    for (const n of v.body.querySelectorAll(':scope > .cell-load, :scope > .cell-err, :scope > .vfb')) {
      n.remove();
    }
    if (v.frame) {
      v.frame.hidden = false;
    }
  }
  function paintVoice() {
    for (const c of cells.values()) {
      if (c.vs) {
        paintStatus(c.vs, voice);
      }
      for (const v of [c.cv, c.lv]) {
        const w = v?.body.querySelector(':scope > .vfb');
        if (w) {
          paintFallback(w);
        }
      }
    }
  }
  async function load(v) {
    const c = v.c;
    const url = v.path !== undefined ? viewUrl(c.panel.frameUrl, v.path) : c.panel.frameUrl;
    /* a HELD or UNREGISTERED app still draws (ticket, superseding the old
       offline card): its actions are what stop, said by the title-bar badge
       and told to the panel on its port ({host:'app-status'}) */
    const src = withMode(withSurface(url, v.surface), currentTheme().mode); // v.src stays the view's identity; ?mode=light is the first-paint hint [app theme]
    clearTimeout(v.timer);
    showLoading(v);
    v.src = url;
    /* Ask first: a frame cannot tell its host that the proxy failed (it is an
       opaque origin), so a bad answer would be a blank or error page. HEAD is
       enough; an app that does not do HEAD (405/501) is still answering. */
    let status = 0;
    try {
      status = (await fetch(src, { method: 'HEAD', cache: 'no-store' })).status;
    } catch {
      status = 0;
    }
    if (v.src !== url || !cells.has(c.panel.id)) {
      return; // superseded while we asked
    }
    if (status === 401) {
      showError(v);
      if (v.staleFor !== url) {
        v.staleFor = url; // once per url: an unchanged one would loop
        o.onStale?.(); // the token expired: a fresh projection brings a new frameUrl
      }
      return;
    }
    if (!(status >= 200 && status < 400) && status !== 405 && status !== 501) {
      showError(v);
      return;
    }
    const f = document.createElement('iframe');
    f.title = c.panel.title;
    f.setAttribute('sandbox', `allow-forms allow-popups allow-popups-to-escape-sandbox${c.panel.scripts === true ? ' allow-scripts' : ''}`);
    f.setAttribute('referrerpolicy', 'no-referrer');
    if (!v.layer) {
      f.style.height = `${c.height}px`; // a layer fills its screen instead
    }
    f.hidden = true;
    const voiceView = isVoice(c.panel);
    v.alive = false;
    if (!voiceView) {
      f.addEventListener('load', () => {
        clearTimeout(v.timer);
        v.body.querySelector('.cell-load')?.remove();
        f.hidden = false;
        budget(); // a frame is now in the rail [ticket]
      }, { once: true });
    }
    /* every load (not once: appending fires one for about:blank first) tells
       the app which of its items the column shows */
    f.addEventListener('load', () => tell(v, { panel: 'preview-state', key: previewKey(c) }));
    /* PANEL ACTIONS: the action port, on this frame's FIRST load only; any
       later load is the frame navigating itself, so its port closes and it
       gets none (see the header) */
    if (c.panel.app_slug && !voiceView) {
      let loads = 0;
      f.addEventListener('load', () => {
        loads += 1;
        if (v.port?.frame === f) {
          closePort(v);
        }
        if (loads === 1 && v.frame === f) {
          handPort(v, f);
        }
      });
    }
    v.timer = voiceView
      ? setTimeout(() => {
        /* no render handshake: the frame may be the proxy's 502 page. Keep it
           (hidden) so a late status still revives it; show the host's state. */
        if (v.frame === f && !v.alive) {
          showVoiceDown(v, f);
        }
      }, VOICE_HANDSHAKE_MS)
      : setTimeout(() => {
        if (v.frame === f && f.hidden) {
          showError(v);
        }
      }, LOAD_TIMEOUT_MS);
    v.frame = f;
    closePort(v); // the frame it replaces
    /* src BEFORE insertion: inserted without one, a frame first loads
       about:blank, and that would be the "first load" the port goes to */
    f.src = src;
    v.body.append(f);
  }

  function makeCell(p) {
    const el = document.createElement('section');
    el.className = 'cell';
    el.dataset.cell = p.id;
    el.dataset.tone = cellTone(p); // [ticket] the tool's identity tone (room.css)
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'cell-h';
    const tt = document.createElement('span');
    tt.className = 'tt';
    const n = document.createElement('span');
    n.className = 'n';
    const chev = document.createElement('span');
    chev.className = 'chev';
    chev.setAttribute('aria-hidden', 'true');
    chev.textContent = '▾';
    head.append(iconSvg(p.icon), tt, n);
    let vs = null;
    if (isVoice(p)) {
      /* the ONLY place connected / muted / waiting are drawn (§9.4) */
      vs = document.createElement('span');
      vs.className = 'vs';
      head.append(vs);
      el.classList.add('cell-voice');
    }
    head.append(chev);
    /* ADD FILE is a compact "+" in the cell's own header (Owner 2026-09-27,
       room line [ref]: the old full-width bar is gone) */
    const hw = document.createElement('div');
    hw.className = 'cell-hw';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'cell-hadd';
    add.textContent = '+';
    add.title = 'Add file: a photo, a screenshot, any file';
    add.setAttribute('aria-label', 'Add file');
    /* THE BLOCKED BADGE [ticket]: a small link on the title bar while the
       app's actions are blocked (held / unregistered). Beside the header
       button, never inside it (a link in a button is invalid and the click
       would fold the cell). */
    const badge = document.createElement('a');
    badge.className = 'cell-badge';
    badge.href = SETTINGS_APPS_URL;
    badge.target = '_blank';
    badge.rel = 'noopener';
    badge.hidden = true;
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      openSettings();
    });
    /* OPEN FULL PAGE [ticket]: shown only while the app declared a page
       ({panel:'page'}), and never on a phone (room.css) */
    const pageBtn = document.createElement('button');
    pageBtn.type = 'button';
    pageBtn.className = 'cell-hpage';
    pageBtn.hidden = true;
    pageBtn.title = 'Open full page';
    pageBtn.setAttribute('aria-label', 'Open full page');
    const pgs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    pgs.setAttribute('viewBox', '0 0 24 24');
    pgs.setAttribute('aria-hidden', 'true');
    pgs.innerHTML = PAGE_SVG; // a constant
    pageBtn.append(pgs);
    hw.append(head, badge, pageBtn, add);
    const body = document.createElement('div');
    body.className = 'cell-b app';
    const own = document.createElement('div');
    own.className = 'cell-own';
    const wrap = document.createElement('div');
    wrap.className = 'cell-b';
    wrap.append(body, own);
    el.append(hw, wrap);
    const c = { el, head, tt, n, own, vs, badge, pageBtn, page: null, appStatus: undefined, panel: p, height: H_DEFAULT, reqPx: H_DEFAULT, icon: p.icon, count: 0, cv: null, lv: null, vv: null, mv: null, dv: null, add };
    if (vs) {
      paintStatus(vs, voice);
    }
    c.input = fileInput(() => c.cv);
    pageBtn.addEventListener('click', () => c.page && launchPage(c, c.page.path, c.page.title));
    hw.append(c.input);
    add.addEventListener('click', () => (hasNotes(c) ? openAddMenu(c, add, () => c.cv) : c.input.click()));
    c.cv = newView(c, body, false);
    wireDrop(c);
    wire(el, p.id, () => {
      if (!c.cv.frame && !c.cv.body.querySelector('.cell-err')) {
        void load(c.cv); // unfolded for the first time
      }
    });
    o.decorateCell?.(hw, head, p.id, p); // the panel menu (room-panel-menu.mjs)
    return c;
  }

  function paint(c, p) {
    c.panel = p;
    /* the app's registration state [ticket]: the badge, and every open
       port told when it CHANGED (never on a repaint that moved nothing) */
    const st = p.app_slug && !isVoice(p) ? appStatusOf(p) : null;
    if (st !== c.appStatus) {
      c.appStatus = st;
      const blocked = st === 'held' || st === 'unregistered';
      c.badge.hidden = !blocked;
      c.badge.textContent = st === 'held' ? `Needs approval ${RSAQUO}` : st === 'unregistered' ? `Not registered ${RSAQUO}` : '';
      c.badge.dataset.state = st ?? '';
      c.badge.title = blocked ? `${p.title}: its actions are blocked until ${st === 'held' ? 'a person approves its change' : 'it is registered again'} in Settings → Apps` : '';
      c.el.dataset.appStatus = st ?? '';
      for (const v of [c.cv, c.lv, c.vv, c.mv, c.dv]) {
        if (v) { tellStatus(v); }
      }
    }
    c.tt.textContent = p.title;
    c.head.title = p.title;
    if (c.icon !== p.icon) {
      c.icon = p.icon;
      c.head.querySelector('.ic').replaceWith(iconSvg(p.icon));
    }
    const via = isVoice(p) ? 'via voice agent' : p.seat_handle ? `via @${p.seat_handle}` : '';
    c.own.textContent = via;
    c.own.hidden = !via;
    paintAdd(c);
  }

  function dropView(v) {
    if (v) {
      clearTimeout(v.timer);
      (v.outer ?? v.body).remove();
    }
  }

  function setPanels(panels) {
    const list = Array.isArray(panels) ? panels.filter((p) => p && typeof p.id === 'string' && typeof p.frameUrl === 'string') : [];
    const keep = new Set(list.map((p) => p.id));
    for (const [id, c] of cells) {
      if (!keep.has(id)) {
        clearTimeout(c.cv.timer);
        c.el.remove();
        dropView(c.lv);
        cells.delete(id);
        o.preview?.forget(ownerOf(c));
        if (o.preview?.current()?.owner === ownerOf(c)) {
          o.preview.close({ focus: false }); // the panel left the room
        }
        if (large?.c === c) {
          closeLarge({ focus: false });
        }
        if (dialog?.c === c) {
          closeDialog({ focus: false }); // the panel left the room
        }
      }
    }
    list.forEach((p, i) => {
      let c = cells.get(p.id);
      if (!c) {
        c = makeCell(p);
        cells.set(p.id, c);
      }
      paint(c, p);
      if (o.list.children[i] !== c.el) {
        o.list.insertBefore(c.el, o.list.children[i] ?? null);
      }
      /* a folded cell loads when it is first unfolded; an open one now, and
         again only when its frameUrl CHANGES. On the phone the column is not
         shown, so its cells wait; the app's LAYER loads when it is opened. */
      if (!matchMedia(PHONE).matches && !c.el.classList.contains('collapsed') && c.cv.src !== p.frameUrl) {
        void load(c.cv);
      }
      if (c.lv && !c.lv.outer.hidden && c.lv.src !== p.frameUrl) {
        void load(c.lv);
      }
      if (c.vv && c.vv.src !== viewUrl(p.frameUrl, c.vv.path)) {
        void load(c.vv); // a fresh token: the view follows its panel
      }
      if (c.mv && c.mv.src !== viewUrl(p.frameUrl, c.mv.path)) {
        void load(c.mv);
      }
      /* an open DIALOG is not reloaded on a fresh token: it may hold a form
         the person is filling in, and its old token stays valid for hours */
    });
    syncHostCell(); // a voice panel arriving replaces the host's own cell
    budget(); // cells came or went [ticket]
    o.onPanels?.();
  }

  /** PHONE: show one app full width in `container` (its own frame, created
   *  the first time); every other app's layer is hidden, not unloaded. */
  function showLayer(id, container) {
    const c = cells.get(id);
    for (const x of cells.values()) {
      if (x.lv) {
        x.lv.outer.hidden = x !== c;
      }
    }
    if (!c) {
      return false;
    }
    if (!c.lv) {
      /* outer = the layer (shown/hidden, the toast's host); inner = where the
         frame loads (cleared on every load). Add file is the layer bar's "+"
         (room.js), which asks pickFile() for this layer's own file input. */
      const outer = document.createElement('div');
      outer.className = 'ly-app';
      outer.dataset.panel = id;
      const inner = document.createElement('div');
      inner.className = 'ly-frame';
      outer.append(inner);
      container.append(outer);
      c.lv = newView(c, inner, true);
      c.lv.outer = outer;
      c.lv.input = fileInput(() => c.lv);
      outer.append(c.lv.input);
      wireLayerDrop(c);
    }
    c.lv.outer.hidden = false;
    if (c.lv.src !== c.panel.frameUrl) {
      void load(c.lv);
    }
    return true;
  }

  /* ---- ADD FILE (Owner 2026-09-27: a phone has no drag). A host "+" (the
     cell header's; the phone layer bar's) over a real file input (accept: any
     type, multiple), so iOS offers Photos, Camera and Files; the files go
     through the same upload as a drop (the cookie, the caps, the listing, then
     {panel:added}). Only on a panel registered uploads:true. ---- */
  function fileInput(getView) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '*/*';
    input.multiple = true;
    input.hidden = true;
    input.addEventListener('change', () => {
      const files = [...input.files];
      input.value = ''; // the same file twice still fires change
      void upload(getView(), files);
    });
    return input;
  }
  /** PHONE: the layer bar's "+" for the app shown. false = not an upload app. */
  function pickFile(id) {
    const c = cells.get(id);
    if (!c?.lv || (c.panel.uploads !== true && !hasNotes(c))) {
      return false;
    }
    if (hasNotes(c)) {
      openAddMenu(c, document.getElementById('lyAdd') ?? c.add, () => c.lv);
    } else {
      c.lv.input.click();
    }
    return true;
  }

  /* ---- toast, copy, upload ---- */
  function toast(v, text, kind, at) {
    const host = at ?? (v.layer ? v.outer : v.c.cv.body.parentElement);
    let t = host.querySelector(':scope > .cell-toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'cell-toast';
      t.setAttribute('role', 'status');
      host.append(t);
    }
    t.textContent = text;
    t.dataset.kind = kind || '';
    t.hidden = false;
    clearTimeout(v.toastTimer);
    /* 'busy' stays up until the next word replaces it; a result goes after a while */
    v.toastTimer = kind === 'busy' ? 0 : setTimeout(() => { t.hidden = true; }, kind === 'error' ? 5000 : TOAST_MS * 2);
  }
  async function copy(v, text, at) {
    const ok = await copyText(text);
    toast(v, ok ? 'Reference copied' : 'Could not copy', ok ? '' : 'error', at);
  }
  function tell(v, msg) {
    try { v.frame?.contentWindow?.postMessage(msg, '*'); } catch { /* frame gone */ }
  }
  async function upload(v, files) {
    const c = v.c;
    if (c.panel.uploads !== true) {
      return; // not an upload panel: a forwarded drop/paste is ignored, said nowhere
    }
    const list = [...(files || [])].filter((f) => f instanceof File);
    if (!list.length) {
      return;
    }
    if (list.length > UPLOAD_MAX_FILES) {
      toast(v, `Not added: ${list.length} files at once (at most ${UPLOAD_MAX_FILES})`, 'error');
      tell(v, { panel: 'dragleave' });
      return;
    }
    const big = list.find((f) => f.size > UPLOAD_MAX_BYTES);
    if (big) {
      toast(v, `Not added: ${big.name} is over ${UPLOAD_MAX_BYTES / 1024 / 1024} MB`, 'error');
      tell(v, { panel: 'dragleave' });
      return;
    }
    let failed = null;
    let added = 0;
    for (const [i, f] of list.entries()) {
      toast(v, list.length === 1 ? `Adding ${f.name}…` : `Adding ${i + 1} of ${list.length}: ${f.name}…`, 'busy');
      try {
        const r = await fetch(`/api/rooms/${encodeURIComponent(o.roomId)}/assets`, {
          method: 'POST',
          headers: { 'content-type': f.type || 'application/octet-stream', 'x-filename': encodeURIComponent(f.name || 'file') },
          body: f,
        });
        if (!r.ok) {
          let why = `HTTP ${r.status}`;
          try { why = (await r.json()).error ?? why; } catch { /* not json */ }
          failed = `${f.name}: ${why}`;
          break;
        }
        added++;
      } catch (e) {
        failed = `${f.name}: ${e?.message ?? e}`;
        break;
      }
    }
    tell(v, { panel: added ? 'added' : 'dragleave' });
    toast(v, failed ? `Not added — ${failed}${added ? ` (${added} added before it)` : ''}` : `Added ${added === 1 ? list[0].name : `${added} files`} to the room`, failed ? 'error' : '');
  }
  /* a drag over the cell (or layer) but OUTSIDE its frame is the host's to see */
  function wireDropOn(el, getView) {
    const has = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    el.addEventListener('dragover', (e) => {
      const v = getView();
      if (!has(e) || !v.frame || v.c.panel.uploads !== true) {
        return;
      }
      e.preventDefault();
      tell(v, { panel: 'dragover' });
    });
    el.addEventListener('dragleave', (e) => {
      const v = getView();
      if (v.frame && !el.contains(e.relatedTarget)) {
        tell(v, { panel: 'dragleave' });
      }
    });
    el.addEventListener('drop', (e) => {
      const v = getView();
      if (!has(e) || !v.frame || v.c.panel.uploads !== true) {
        return;
      }
      e.preventDefault();
      void upload(v, e.dataTransfer.files);
    });
  }
  function wireDrop(c) {
    wireDropOn(c.el, () => c.cv);
  }
  function wireLayerDrop(c) {
    wireDropOn(c.lv.outer, () => c.lv);
  }

  /* ---- the lightbox ---- */
  function closeLightbox() {
    o.lightbox.hidden = true;
    o.lightbox.querySelector('#lbBody').textContent = '';
  }
  function openLightbox(c, rawUrl, rawTitle, base = c.panel.frameUrl) {
    const u = safeUrl(rawUrl, base);
    if (!u) {
      return; // javascript:, data:, blob: … never
    }
    const title = typeof rawTitle === 'string' ? rawTitle.slice(0, 200) : '';
    const body = o.lightbox.querySelector('#lbBody');
    const cap = o.lightbox.querySelector('#lbCap');
    body.textContent = '';
    cap.textContent = '';
    if (IMAGE_RE.test(u.pathname)) {
      const img = document.createElement('img');
      img.alt = title || c.panel.title;
      img.referrerPolicy = 'no-referrer';
      img.src = u.href;
      body.append(img);
      cap.textContent = `${title || ''}${title ? ' · ' : ''}via ${c.panel.title}`;
    } else {
      const a = document.createElement('a');
      a.href = u.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = `Open ${title || u.host} ↗`;
      a.addEventListener('click', (e) => e.stopPropagation());
      cap.append(a, ` · via ${c.panel.title}`);
    }
    o.lightbox.hidden = false;
    /* take the focus out of the panel's frame (the click that asked for this
       left it there), or Esc would go to the frame, not to us */
    o.lightbox.tabIndex = -1;
    o.lightbox.focus({ preventScroll: true });
  }
  o.lightbox.addEventListener('click', closeLightbox);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !o.lightbox.hidden) {
      closeLightbox();
    }
  });

  /* THE RAIL HEIGHT BUDGET [ticket] (allocateHeights, above). Replaces the
     rooms/rail-max ceiling (320, or 60% of a wide rail): the OPEN cells share
     the rail's visible height instead. Each cell keeps its last REQUESTED px
     (c.reqPx) and glance (c.glance), so any change re-allocates without
     waiting for a fresh post. Recomputed on: window resize, the rail's own
     size, the content's size (a cell added/removed/folded, the seats growing,
     a frame appearing), and every height post — always in ONE rAF, and a
     frame is written only when its height actually changes, so the write's
     own resize (the ResizeObservers below see it) re-measures to the same
     answer and stops there. Phone: the column is not shown (apps are
     layers), so nothing is measured or written. */
  function budgetCells() {
    return [...cells.values()].filter((c) => {
      const f = c.cv?.frame;
      return f && !f.hidden && !c.el.classList.contains('collapsed') && f.getClientRects().length > 0;
    });
  }
  function allocate() {
    budgetRaf = 0;
    if (matchMedia(PHONE).matches) {
      return;
    }
    const list = budgetCells();
    const view = o.column.clientHeight;
    if (!list.length || !view) {
      return;
    }
    /* everything in the rail that is NOT an open app frame: the seats, every
       header, owner line, error or loading block — measured, never assumed */
    let content = 0;
    for (const k of o.column.children) {
      const pos = getComputedStyle(k).position;
      if (pos !== 'absolute' && pos !== 'fixed') {
        content += k.getBoundingClientRect().height;
      }
    }
    let frames = 0;
    for (const c of list) {
      frames += c.cv.frame.getBoundingClientRect().height;
    }
    const hs = allocateHeights(view - Math.ceil(content - frames - 0.01), list.map((c) => ({ reqPx: c.reqPx, glance: c.glance })), H_MIN, H_DEFAULT);
    list.forEach((c, i) => {
      if (hs[i] !== c.height) {
        c.height = hs[i];
        c.cv.frame.style.height = `${hs[i]}px`;
      }
    });
  }
  let budgetRaf = 0;
  function budget() {
    if (!budgetRaf) {
      budgetRaf = requestAnimationFrame(allocate);
    }
  }
  {
    const ro = new ResizeObserver(budget);
    ro.observe(o.column);
    ro.observe(o.list);
    if (seats) {
      ro.observe(seats);
    }
    if (roomCell) {
      ro.observe(roomCell);
    }
  }
  window.addEventListener('resize', budget);

  /* ---- what a panel may ask ---- */
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || typeof d !== 'object' || typeof d.panel !== 'string') {
      return;
    }
    let v = null;
    for (const x of cells.values()) {
      for (const y of [x.cv, x.lv, x.vv, x.mv, x.dv]) {
        if (y?.frame && y.frame.contentWindow === ev.source) {
          v = y;
        }
      }
    }
    if (!v || ev.origin !== 'null') {
      return; // only a panel's own frame speaks for it, and every panel frame is sandboxed (opaque origin)
    }
    const c = v.c;
    if (d.panel === 'status' || d.panel === 'voice' || d.panel === 'line') {
      if (!isVoice(c.panel)) {
        return; // the trust rule: only the engine's voice panel says these
      }
      if (d.panel === 'status' && typeof d.speaking === 'boolean') {
        voiceAlive(v);
        /* `speaking` is the FRAME's to draw, never the header's (A0) */
      } else if (d.panel === 'voice' && VOICE_ACTIONS.includes(d.action)) {
        o.onVoiceAction?.(d.action);
      } else if (d.panel === 'line' && Number.isSafeInteger(d.lineId) && d.lineId > 0) {
        o.onLine?.(d.lineId);
      }
      return;
    }
    if (d.panel === 'height' && Number.isFinite(d.px)) {
      if (!v.layer) {
        c.reqPx = Math.round(d.px);
        /* glance: a number 0..px, or it is ignored (each post is the whole
           statement, so a post without one drops the last one) */
        c.glance = Number.isFinite(d.glance) && d.glance >= 0 && d.glance <= d.px ? Math.round(d.glance) : undefined;
        budget();
      }
    } else if (d.panel === 'open' && typeof d.url === 'string') {
      openLightbox(c, d.url, d.title, frameBase(v));
    } else if (d.panel === 'copy' && typeof d.text === 'string' && d.text.length <= COPY_MAX) {
      void copy(v, d.text);
    } else if (d.panel === 'download' && typeof d.url === 'string') {
      const u = safeUrl(d.url, frameBase(v));
      if (u) {
        saveUrl(u.href, d.name);
      }
    } else if (d.panel === 'dragover' && c.panel.uploads === true) {
      tell(v, { panel: 'dragover' }); // "drag is over this cell": show the app's own drop target
    } else if ((d.panel === 'drop' || d.panel === 'paste') && Array.isArray(d.files)) {
      void upload(v, d.files);
    } else if (d.panel === 'count') {
      const n = Number(d.n);
      c.count = Number.isInteger(n) && n > 0 && n < 100000 ? n : 0;
      c.n.textContent = c.count ? String(c.count) : '';
      o.onPanels?.();
    } else if (d.panel === 'preview' && o.preview && d.view && typeof d.view === 'object') {
      openView(v, d.view);
    } else if (d.panel === 'preview' && o.preview && d.item && typeof d.item === 'object') {
      openItem(v, d.item);
    } else if (d.panel === 'preview-close' && o.preview?.current()?.owner === ownerOf(c)) {
      o.preview.close();
    } else if (d.panel === 'compose') {
      compose(v, d.text);
    } else if (d.panel === 'action') {
      tell(v, { host: 'action-result', name: typeof d.name === 'string' ? d.name.slice(0, 64) : '', ok: false, error: 'send actions on the action port' });
    } else if (d.panel === 'dialog') {
      tell(v, { host: 'dialog-result', ok: false, error: 'send dialogs on the action port' });
    } else if (d.panel === 'pick') {
      tell(v, { host: 'picked', error: 'send picks on the action port' });
    }
  });

  /* ---- APP STATUS: what the panel's actions may do now [ticket] ---- */
  function appStatusOf(p) {
    return p.app_status === 'held' || p.app_status === 'unregistered' ? p.app_status : p.app_held ? 'held' : 'enabled';
  }
  function openSettings() {
    (o.openSettings ?? openAppSettings)();
  }
  function tellStatus(v) {
    if (!v.port || !v.c.panel.app_slug || isVoice(v.c.panel)) {
      return;
    }
    try {
      v.port.postMessage({ host: 'app-status', actions: appStatusOf(v.c.panel), settingsUrl: SETTINGS_APPS_URL });
    } catch {
      /* closed */
    }
  }

  /* ---- NOTES [ticket]: see the header. The host half is o.notes (web/room-notes.mjs) ---- */
  const noteViews = (c) => [c.cv, c.lv, c.vv, c.mv, c.dv];
  function declareNotes(c, d) {
    if (d.enabled === true && !isVoice(c.panel) && c.panel.app_slug) {
      c.notes = true;
      paintAdd(c);
      o.onPanels?.(); // the phone layer bar's + may now show
    }
  }
  /** this cell's + opens the menu (a panel that declared notes, on an engine that has them) */
  const hasNotes = (c) => !!c && c.notes === true && o.notes?.supported() === true;
  function paintAdd(c) {
    c.add.hidden = c.panel.uploads !== true && !c.notes;
    const n = hasNotes(c);
    c.add.title = n ? 'Add: import a file or start a note' : 'Add file: a photo, a screenshot, any file';
    c.add.setAttribute('aria-label', n ? 'Add' : 'Add file');
    if (n) {
      c.add.setAttribute('aria-haspopup', 'menu');
    } else {
      c.add.removeAttribute('aria-haspopup');
    }
  }
  const addMenuHost = createMenuHost();
  function openAddMenu(c, anchor, getView) {
    const r = anchor.getBoundingClientRect();
    const items = [];
    if (c.panel.uploads === true) {
      items.push({ a: 'import', label: 'Import a file', icon: 'import' });
    }
    items.push({ a: 'note', label: 'New note', icon: 'note' });
    addMenuHost.open({
      row: anchor,
      label: 'Add',
      title: 'Add',
      point: { x: r.left, y: r.bottom },
      items,
      choose(it) {
        addMenuHost.close(false);
        if (it.a === 'import') {
          getView().input.click();
        } else {
          void o.notes.newNote('assets');
        }
      },
    });
  }
  function noteOp(v, d, port) {
    const reply = (msg) => {
      try { port.postMessage(msg); } catch { /* closed */ }
    };
    if (!o.notes || o.notes.supported() !== true) {
      reply({ host: 'note', op: typeof d.op === 'string' ? d.op.slice(0, 16) : '', ok: false, error: 'notes are not available here' });
      return Promise.resolve();
    }
    return o.notes.panelOp(d, reply);
  }
  /** {host:'notes-changed'} to every frame of a panel that declared notes */
  function notesChanged() {
    for (const c of cells.values()) {
      if (c.notes) {
        for (const v of noteViews(c)) {
          try { v?.port?.postMessage({ host: 'notes-changed' }); } catch { /* closed */ }
        }
      }
    }
  }

  /* ---- FULL PAGE [ticket]: see the header. The page is web/room-app.html;
     the rail panel is untouched and keeps running ---- */
  const pageAt = new WeakMap(); // frame element -> last honoured {panel:'open-page'}
  function declarePage(c, d) {
    if (c.panel.app_slug && !isVoice(c.panel)) {
      const decl = cleanPageDecl(d, c.panel.frameUrl, location.href);
      if (decl) {
        c.page = decl.enabled ? { path: decl.path, title: decl.title } : null;
        c.pageBtn.hidden = !c.page;
      }
    }
  }
  function launchPage(c, path, title) {
    const name = o.roomName?.() || 'Room';
    return openTab(pageTabUrl(o.roomId, c.panel.id, path, title), pageDocTitle(title, c.panel.title, name), `room-app:${o.roomId}:${c.panel.id}:${path}`);
  }
  function openPage(v, d, port) {
    const c = v.c;
    const reply = (ok, error) => {
      try { port.postMessage(ok ? { host: 'page-result', ok: true } : { host: 'page-result', ok: false, error: String(error).slice(0, 200) }); } catch { /* closed */ }
    };
    if (!c.panel.app_slug || isVoice(c.panel)) {
      return;
    }
    /* the dialog's gate: a click, one per 500 ms per frame, the app enabled */
    const frame = v.frame;
    const now = Date.now();
    const gate = askGate(navigator.userActivation?.isActive, now, pageAt.get(frame) ?? 0, appStatusOf(c.panel));
    if (gate !== 'needs a click' && gate !== 'too fast') {
      pageAt.set(frame, now); // as a dialog: the rate counts once the click did
    }
    if (gate) {
      reply(false, gate);
      return;
    }
    if (matchMedia(PHONE).matches) {
      reply(false, 'not available on a phone');
      return;
    }
    const req = cleanPageRequest(d, c.panel.frameUrl, location.href, c.page);
    if (!req.ok) {
      reply(false, req.error);
      return;
    }
    reply(launchPage(c, req.path, req.title) !== 'blocked', 'the browser blocked the new tab');
  }

  /* ---- ASSET PICKER [asset picker, Owner 2026-10-05]: see the header ---- */
  const pickWindows = new Map(); // panel id -> ms until which its next action passes the click gate
  const pickAt = new WeakMap(); // frame element -> last honoured {panel:'pick'}
  let picker = null;
  function openPick(v, d, port) {
    const c = v.c;
    const reply = (msg) => {
      try { port.postMessage(msg); } catch { /* closed */ }
    };
    const refuse = (error) => reply({ host: 'picked', error: String(error).slice(0, 200) });
    if (!c.panel.app_slug || isVoice(c.panel)) {
      return; // an app's frames only
    }
    const frame = v.frame;
    const now = Date.now();
    const gate = askGate(navigator.userActivation?.isActive, now, pickAt.get(frame) ?? 0, appStatusOf(c.panel));
    if (gate !== 'needs a click' && gate !== 'too fast') {
      pickAt.set(frame, now);
    }
    if (gate) {
      refuse(gate);
      return;
    }
    if (!Array.isArray(c.panel.host_caps) || !c.panel.host_caps.includes('pick')) {
      refuse('not declared');
      return;
    }
    const req = cleanPick(d);
    if (!req.ok) {
      refuse(req.error);
      return;
    }
    if (picker) {
      refuse('a picker is already open');
      return;
    }
    picker = openAssetPicker({
      roomId: o.roomId,
      sources: req.sources,
      title: req.title,
      onDone: (items) => {
        picker = null;
        if (items?.length) {
          openPickWindow(pickWindows, c.panel.id, Date.now()); // a cancel opens nothing
        }
        reply(pickedMessage(items));
      },
    });
  }

  /* ---- ACTION: an app's panel triggers one of its own declared actions (see the header) ---- */
  const actionBusy = new WeakSet(); // frame elements with an action in flight
  const actionAt = new WeakMap(); // frame element -> last accepted ms
  function closePort(v) {
    if (v.port) {
      v.port.close();
      v.port = null;
    }
  }
  function handPort(v, f) {
    const ch = new MessageChannel();
    const port = ch.port1;
    port.frame = f;
    port.onmessage = (ev) => {
      const d = ev.data;
      /* only while this is still the view's port, its frame on the page */
      if (v.port === port && v.frame === f && f.isConnected && cells.has(v.c.panel.id) && d && typeof d === 'object') {
        if (d.panel === 'action') {
          void action(v, d, port);
        } else if (d.panel === 'dialog') {
          openDialog(v, d, port);
        } else if (d.panel === 'pick') {
          openPick(v, d, port);
        } else if (d.panel === 'close-dialog') {
          if (dialog && (dialog.dv === v || dialog.from === v)) {
            closeDialog(); // the dialog itself, or the panel that opened it
          }
        } else if (d.panel === 'page') {
          declarePage(v.c, d);
        } else if (d.panel === 'open-page') {
          openPage(v, d, port);
        } else if (d.panel === 'notes') {
          declareNotes(v.c, d);
        } else if (d.panel === 'note') {
          void noteOp(v, d, port);
        } else if (d.panel === 'open-settings') {
          /* a person's click (as for an action), at most once a second */
          const now = Date.now();
          if (navigator.userActivation?.isActive === true && now - (settingsAt.get(f) ?? 0) >= 1000) {
            settingsAt.set(f, now);
            openSettings();
          }
        }
      }
    };
    v.port = port;
    try {
      f.contentWindow.postMessage({ host: 'port' }, '*', [ch.port2]);
    } catch {
      closePort(v);
      return;
    }
    tellStatus(v); // the app's status, right after its port [ticket]
    try {
      port.postMessage({ host: 'surface', kind: v.surface });
    } catch {
      /* closed */
    }
    tellTheme(v); // right after the surface [app theme]
  }
  /* ---- APP THEME [app theme] the design system [ref], Owner 2026-10-05: see web/app-theme.mjs ---- */
  function currentTheme() {
    return themeMessage(paletteTokens, effectivePref(), document.documentElement.dataset.mode, o.roomColor?.());
  }
  function tellTheme(v, msg = currentTheme()) {
    try {
      v.port?.postMessage(msg);
    } catch {
      /* closed */
    }
  }
  let lastTheme = JSON.stringify(currentTheme());
  function broadcastTheme() {
    const msg = currentTheme();
    const key = JSON.stringify(msg);
    if (key === lastTheme) {
      return; // the palette-change and room-palette events of one change arrive together
    }
    lastTheme = key;
    for (const c of cells.values()) {
      for (const v of [c.cv, c.lv, c.vv, c.mv, c.dv]) {
        if (v) { tellTheme(v, msg); }
      }
    }
  }
  /* the global palette (applyPref), the room's own override and Dark/Light, and another tab's change */
  document.addEventListener('palette-change', broadcastTheme);
  document.addEventListener('room-palette', broadcastTheme);
  window.addEventListener('storage', (e) => { if (e.key === 'hwb.palette.v1') { setTimeout(broadcastTheme, 0); } });
  async function action(v, d, port) {
    const c = v.c;
    const plain = (x) => x === undefined || (!!x && typeof x === 'object' && !Array.isArray(x));
    if (!c.panel.app_slug || isVoice(c.panel) || typeof d.name !== 'string' || !ACTION_NAME.test(d.name) || !plain(d.params) || !plain(d.input)) {
      return; // an app's frames only, a well-formed ask only
    }
    const reply = (ok, error, warning) => {
      try { port.postMessage(ok ? { host: 'action-result', name: d.name, ok: true, ...(warning ? { warning: String(warning).slice(0, 200) } : {}) } : { host: 'action-result', name: d.name, ok: false, error: String(error).slice(0, 200) }); } catch { /* closed */ }
    };
    /* a person's click, not a script: activation in the frame propagates to
       this page; a browser without the API is treated as no click */
    const afterPick = takePickWindow(pickWindows, c.panel.id, Date.now()); // one action, once [asset picker]
    if (navigator.userActivation?.isActive !== true && !afterPick) {
      reply(false, 'needs a click');
      return;
    }
    const frame = v.frame;
    const now = Date.now();
    if (actionBusy.has(frame) || now - (actionAt.get(frame) ?? 0) < ACTION_GAP_MS) {
      reply(false, 'too fast');
      return;
    }
    actionAt.set(frame, now);
    actionBusy.add(frame);
    let r;
    try {
      r = await runPanelAction(o.roomId, c.panel.id, d);
    } finally {
      actionBusy.delete(frame);
    }
    const { ok, error, warning, entries } = r;
    /* POSTS TO ROOM [ticket]: a postsToRoom verb's line comes back with
       the answer — drawn now, whether or not the live push beats it */
    if (entries) {
      o.onEntries?.(entries);
    }
    reply(ok, error, warning);
    if (ok && warning) {
      toast(v, `${c.panel.title}: done — ${warning}`.slice(0, 260), 'error');
    } else if (error === 'needs-approval' || error === 'not-registered') {
      toast(v, `${c.panel.title}: ${error === 'needs-approval' ? 'needs approval' : 'is not registered'} — Settings → Apps`, 'error');
    } else if (!ok) {
      toast(v, `${c.panel.title}: ${d.name} failed — ${String(error).slice(0, 200)}`, 'error');
    }
  }

  /* ---- COMPOSE: a panel prefills the composer (never sends; see the header) ---- */
  const composedAt = new WeakMap(); // frame element -> last honoured ms
  function compose(v, raw) {
    const c = v.c;
    if (!c.panel.app_slug || isVoice(c.panel) || typeof raw !== 'string' || !o.onCompose) {
      return; // an app's frames only; never the voice panel
    }
    const text = raw.replace(/[\r\n]+/g, ' ').trim();
    if (!text || text.length > COMPOSE_MAX) {
      return;
    }
    const now = Date.now();
    if (now - (composedAt.get(v.frame) ?? 0) < COMPOSE_GAP_MS) {
      return; // 1 a second per frame
    }
    composedAt.set(v.frame, now);
    if (v === c.dv) {
      closeDialog({ focus: false }); // the composer in sight
    }
    if (v === c.mv) {
      closeLarge({ focus: false }); // back to the column, the composer in sight
    }
    if (matchMedia(PHONE).matches && o.preview?.current()) {
      o.preview.close({ focus: false }); // the phone's preview covers the composer
    }
    o.onCompose(text);
  }

  /* ---- the PREVIEW column (round 3): items, views, and the state echo ---- */
  const ownerOf = (c) => `panel:${c.panel.id}`;
  function previewKey(c) {
    const cur = o.preview?.current();
    return cur && cur.owner === ownerOf(c) ? cur.key : null;
  }
  /** Where the sending frame's relative URLs resolve: its own URL. */
  function frameBase(v) {
    return v.path !== undefined ? viewUrl(v.c.panel.frameUrl, v.path) : v.c.panel.frameUrl;
  }
  /** Tell every frame of every panel which of ITS items is open; drop a view
   *  frame the column no longer holds. Called by the column on every change. */
  function previewChanged() {
    for (const c of cells.values()) {
      if (c.vv && !c.vv.outer.isConnected) {
        clearTimeout(c.vv.timer);
        c.vv = null;
      }
      const key = previewKey(c);
      for (const v of [c.cv, c.lv, c.vv, c.mv]) {
        if (v?.frame) {
          tell(v, { panel: 'preview-state', key });
        }
      }
    }
  }

  function cleanItem(raw) {
    if (typeof raw.key !== 'string' || !raw.key || raw.key.length > 120) {
      return null; // the key is echoed back verbatim: never a cut one
    }
    const str = (x, max) => (typeof x === 'string' ? x.slice(0, max) : '');
    const meta = (Array.isArray(raw.meta) ? raw.meta : [])
      .filter((p) => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string')
      .slice(0, PV_META_MAX)
      .map(([l, val]) => [l.slice(0, 80), val.slice(0, 200)]);
    const actions = (Array.isArray(raw.actions) ? raw.actions : []).slice(0, PV_ACTIONS_MAX).filter((a) => {
      if (!a || typeof a !== 'object' || typeof a.label !== 'string' || !a.label || a.label.length > 40) {
        return false;
      }
      const kinds = ['open', 'copy', 'download'].filter((k) => a[k] !== undefined);
      return kinds.length === 1 && typeof a[kinds[0]] === 'string' && (kinds[0] !== 'copy' || a.copy.length <= COPY_MAX);
    });
    return {
      key: raw.key,
      type: str(raw.type, 24),
      title: str(raw.title, 200),
      image: typeof raw.image === 'string' ? raw.image : null,
      status: str(raw.status, 40),
      excerpt: str(raw.excerpt, 2000),
      meta,
      actions,
    };
  }

  /** A markdown / text file in an item: the document viewer replaces the
   *  item's own buttons. Named by the title, the file in its URL, or a type
   *  label like MD. null = not one (an image or anything else: the old preview). */
  function docOf(it, base) {
    const act = it.actions.find((a) => a.download !== undefined) ?? it.actions.find((a) => a.open !== undefined);
    const u = act ? safeUrl(act.download ?? act.open, base) : null;
    if (!u || it.image) {
      return null;
    }
    const file = decodeURIComponent(u.pathname.split('/').pop() || '');
    const kind = docKind(it.title) || docKind(file) || docKind(/^[A-Za-z]{2,8}$/.test(it.type) ? `x.${it.type}` : '');
    if (!kind) {
      return null;
    }
    const ref = it.actions.find((a) => a.copy !== undefined)?.copy;
    const name = /\.[A-Za-z0-9]+$/.test(it.title) ? it.title : file || it.title;
    return createDocView({ name, kind, url: u.href, ref, downloadName: name });
  }

  function itemBody(v, it) {
    const c = v.c;
    const base = frameBase(v);
    const b = document.createElement('div');
    b.className = 'pv-item';
    const doc = docOf(it, base);
    if (doc) {
      b.append(doc.body);
      b.dvTools = doc.tools;
      return b;
    }
    const img = it.image ? safeUrl(it.image, base) : null;
    if (img) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pv-img';
      btn.title = 'Open full size';
      const im = document.createElement('img');
      im.alt = it.title;
      im.referrerPolicy = 'no-referrer';
      im.src = img.href;
      btn.append(im);
      btn.addEventListener('click', () => openLightbox(c, img.href, it.title));
      b.append(btn);
    }
    if (it.status) {
      const st = document.createElement('p');
      st.className = 'pv-status';
      st.textContent = it.status;
      b.append(st);
    }
    if (it.meta.length) {
      const dl = document.createElement('dl');
      dl.className = 'pv-meta';
      for (const [l, val] of it.meta) {
        const dt = document.createElement('dt');
        dt.textContent = l;
        const dd = document.createElement('dd');
        dd.textContent = val;
        dl.append(dt, dd);
      }
      b.append(dl);
    }
    if (it.excerpt) {
      /* NOT .pv-ex: that is the header's 32px Expand button (room-tool-links.css),
         and sharing the name squeezed a task's description into a 32px column */
      const ex = document.createElement('p');
      ex.className = 'pv-excerpt';
      ex.textContent = it.excerpt;
      b.append(ex);
    }
    const acts = document.createElement('div');
    acts.className = 'pv-acts';
    for (const a of it.actions) {
      let n = null;
      if (a.copy !== undefined) {
        n = document.createElement('button');
        n.type = 'button';
        n.addEventListener('click', () => void copy(v, a.copy, o.preview.el));
      } else {
        const u = safeUrl(a.open ?? a.download, base);
        if (!u) {
          continue; // not http(s): the action is dropped, never drawn as a dead link
        }
        n = document.createElement('a');
        n.href = u.href;
        n.rel = 'noopener noreferrer';
        if (a.download !== undefined) {
          n.setAttribute('download', '');
        } else {
          n.target = '_blank';
        }
      }
      n.className = acts.children.length ? 'pv-btn' : 'pv-btn pri';
      n.textContent = a.label;
      acts.append(n);
    }
    if (acts.children.length) {
      b.append(acts);
    }
    return b;
  }

  function openItem(v, raw) {
    const it = cleanItem(raw);
    if (!it) {
      return;
    }
    const c = v.c;
    const fromView = v === c.vv;
    const ibody = itemBody(v, it);
    o.preview.open({
      owner: ownerOf(c),
      key: it.key,
      /* an item from the app view underneath keeps its own Back trail; any
         other (the Assets cell, a link) pushes the view it replaces [ticket] */
      foreign: !fromView,
      view: fromView ? viewSpec(c, c.vv) : null,
      type: it.type,
      name: it.title,
      body: ibody,
      tools: ibody.dvTools,
      keep: fromView ? [c.vv.outer] : [],
      back: fromView ? { label: `← Back to ${c.vv.title}`, go: () => showView(c) } : null,
      opener: v.frame,
    });
  }

  /** The column's Expand: the view it shows, LARGE (desktop only; the
   *  column hides the button on a phone). */
  const expandOf = (c) => (btn) => {
    if (c.vv) {
      openLarge(c, c.vv.path, c.vv.title, btn);
    }
  };

  /** What the column needs to come back to panel `c`'s view `vv` [ticket]. */
  const viewSpec = (c, vv) => ({
    node: vv.outer,
    label: vv.title || c.panel.title,
    restore: () => {
      if (cells.get(c.panel.id) !== c || c.vv !== vv || !vv.outer.isConnected) {
        return false; // the panel or the view is gone
      }
      showView(c);
      return true;
    },
  });
  /** foreign: another app's view replaces what is shown (not this app's own navigation) */
  const foreignView = (c) => {
    const cur = o.preview.current();
    return !!cur && cur.owner !== ownerOf(c);
  };

  function showView(c, opener, foreign = false) {
    const vv = c.vv;
    o.preview.open({ owner: ownerOf(c), key: null, type: c.panel.title, name: vv.title, body: vv.outer, expand: expandOf(c), foreign, view: viewSpec(c, vv), ...(opener ? { opener } : {}) });
  }

  function openView(v, raw) {
    const title = typeof raw.title === 'string' ? raw.title.slice(0, 80) : '';
    openViewOf(v.c, raw.path, title, v === v.c.vv ? undefined : v.frame);
  }

  /** The column shows panel `c`'s own app at `rawPath` (cleanPath-checked).
   *  opener: what focus returns to (undefined = keep the column's). */
  function openViewOf(c, rawPath, title, opener) {
    const path = cleanPath(rawPath);
    if (path === null || !o.preview) {
      return false;
    }
    if (c.vv && c.vv.path === path && c.vv.outer.isConnected) {
      c.vv.title = title;
      showView(c, opener, foreignView(c));
      return true;
    }
    const outer = document.createElement('div');
    outer.className = 'pv-view';
    const inner = document.createElement('div');
    inner.className = 'pv-frame';
    outer.append(inner);
    const vv = newView(c, inner, true, 'preview');
    vv.outer = outer;
    vv.path = path;
    vv.title = title;
    const foreign = foreignView(c);
    o.preview.forget(ownerOf(c)); // a view this one replaces is not a place to return to
    o.preview.open({ owner: ownerOf(c), key: null, type: c.panel.title, name: title, body: outer, opener, expand: expandOf(c), foreign, view: viewSpec(c, vv) });
    c.vv = vv; // after open: its change pass drops the view this one replaces
    void load(vv);
    return true;
  }

  /* ---- LARGE (line links [rooms/tool-links], the design system): the SAME app frame
     rules in a modal over the page — the .modal-card frame over --scrim,
     min(1100px, 92vw) x min(760px, 88vh); header = the tool icon + the label
     + ✕. Esc or ✕ closes it back to what was there (the column stays). Focus
     is trapped inside while open and returns to the opener after. One at a
     time. ---- */
  let large = null; // {c, scrim, card, x, opener}
  function openLarge(c, rawPath, title, opener) {
    const path = cleanPath(rawPath);
    if (path === null) {
      return false;
    }
    closeLarge({ focus: false });
    const scrim = document.createElement('div');
    scrim.className = 'tl-lg-scrim';
    const card = document.createElement('div');
    card.className = 'modal-card tl-lg';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', title || c.panel.title);
    const head = document.createElement('div');
    head.className = 'tl-lg-h';
    const t = document.createElement('span');
    t.className = 'tl-lg-t';
    t.textContent = title || c.panel.title;
    t.title = `${title || ''}${title ? ' · ' : ''}${c.panel.title}`;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'pv-x tl-lg-x';
    x.title = 'Close (Esc)';
    x.setAttribute('aria-label', 'Close the large view');
    const xs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    xs.setAttribute('viewBox', '0 0 24 24');
    xs.setAttribute('aria-hidden', 'true');
    xs.innerHTML = CLOSE_SVG; // a constant
    x.append(xs);
    head.append(iconSvg(c.panel.icon), t, x);
    const inner = document.createElement('div');
    inner.className = 'pv-frame tl-lg-b';
    card.append(head, inner);
    scrim.append(card);
    document.body.append(scrim);
    const mv = newView(c, inner, true, 'large');
    mv.outer = card;
    mv.path = path;
    mv.title = title;
    c.mv = mv;
    large = { c, scrim, card, x, opener: opener ?? document.activeElement };
    x.addEventListener('click', () => closeLarge());
    scrim.addEventListener('pointerdown', (e) => {
      if (e.target === scrim) {
        e.preventDefault(); // a click on the scrim is not a way out: Esc or ✕
      }
    });
    x.focus({ preventScroll: true });
    void load(mv);
    return true;
  }
  function closeLarge(opts = {}) {
    if (!large) {
      return;
    }
    const was = large;
    large = null;
    clearTimeout(was.c.mv?.timer);
    was.c.mv = null;
    was.scrim.remove();
    if (opts.focus !== false && was.opener?.isConnected && typeof was.opener.focus === 'function') {
      was.opener.focus({ preventScroll: true });
    }
  }
  /* capture phase, ahead of the column's own Esc (room.js escBlocked asks
     largeOpen()): one Esc closes only the modal */
  window.addEventListener('keydown', (e) => {
    if (!large || dialog) {
      return; // a dialog over the large view has the keys (below)
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeLarge();
    } else if (e.key === 'Tab') {
      /* the modal's own stops: ✕ and the frame; nothing behind it */
      const stops = [large.x, large.c.mv?.frame].filter((n) => n && !n.hidden);
      const i = stops.indexOf(document.activeElement);
      e.preventDefault();
      stops[(i + (e.shiftKey ? stops.length - 1 : 1) + stops.length) % stops.length]?.focus();
    }
  }, true);
  document.addEventListener('focusin', (e) => {
    if (large && !dialog && !large.card.contains(e.target)) {
      large.x.focus({ preventScroll: true }); // focus never lands behind the modal
    }
  });

  /* ---- APP DIALOG [ticket]: a panel asks, on its port and from a click,
     for its OWN app at a sub-path in a modal over the room (see the header).
     The frame is an ordinary view (newView/load): the panel's sandbox and
     referrer rules, frameUrl + path through the same proxy and token, its
     own port on its first load. One at a time; it may sit over a LARGE view
     (it then has the keys and the focus). ---- */
  const dialogAt = new WeakMap(); // frame element -> last honoured {panel:'dialog'}
  let dialog = null; // {c, dv, from, port, scrim, card, x, opener}
  function openDialog(v, d, port) {
    const c = v.c;
    const reply = (ok, error) => {
      try { port.postMessage(ok ? { host: 'dialog-result', ok: true } : { host: 'dialog-result', ok: false, error: String(error).slice(0, 200) }); } catch { /* closed */ }
    };
    if (!c.panel.app_slug || isVoice(c.panel)) {
      return; // an app's frames only (only they hold a port)
    }
    /* the ACTION gate, unchanged: a person's click, then the per-frame rate */
    if (navigator.userActivation?.isActive !== true) {
      reply(false, 'needs a click');
      return;
    }
    const frame = v.frame;
    const now = Date.now();
    if (now - (dialogAt.get(frame) ?? 0) < ACTION_GAP_MS) {
      reply(false, 'too fast');
      return;
    }
    dialogAt.set(frame, now);
    const st = appStatusOf(c.panel);
    if (st !== 'enabled') {
      reply(false, st === 'held' ? 'needs-approval' : 'not-registered');
      return;
    }
    if (dialog) {
      reply(false, 'a dialog is already open');
      return;
    }
    const req = cleanDialog(d, c.panel.frameUrl, location.href);
    if (!req.ok) {
      reply(false, req.error);
      return;
    }
    const appName = c.panel.title;
    const scrim = document.createElement('div');
    scrim.className = 'ad-scrim';
    const card = document.createElement('div');
    card.className = `modal-card ad-card kb-capped ad-${req.size}`;
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', req.title ? `${appName}: ${req.title}` : appName);
    card.tabIndex = -1;
    const head = document.createElement('div');
    head.className = 'ad-h';
    const t = document.createElement('span');
    t.className = 'ad-t';
    const an = document.createElement('b');
    an.className = 'ad-app';
    an.textContent = appName;
    t.append(an);
    if (req.title) {
      const dt = document.createElement('span');
      dt.className = 'ad-dt';
      dt.textContent = req.title;
      t.append(' · ', dt);
    }
    t.title = req.title ? `${appName} · ${req.title}` : appName;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'ad-x';
    x.title = 'Close (Esc)';
    x.setAttribute('aria-label', 'Close the dialog');
    const xs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    xs.setAttribute('viewBox', '0 0 24 24');
    xs.setAttribute('aria-hidden', 'true');
    xs.innerHTML = CLOSE_SVG; // a constant
    x.append(xs);
    head.append(iconSvg(c.panel.icon), t, x);
    const inner = document.createElement('div');
    inner.className = 'ad-b';
    card.append(head, inner);
    scrim.append(card);
    document.body.append(scrim);
    const dv = newView(c, inner, true, 'dialog');
    dv.outer = card;
    dv.path = req.path;
    dv.title = req.title;
    c.dv = dv;
    dialog = { c, dv, from: v, port, scrim, card, x, opener: frame };
    x.addEventListener('click', () => closeDialog());
    scrim.addEventListener('click', (e) => {
      if (e.target === scrim) {
        closeDialog(); // the scrim is a way out (unlike LARGE's)
      }
    });
    x.focus({ preventScroll: true }); // the close button, never a text field
    void load(dv);
    reply(true);
  }
  /** Close the dialog, however it was asked for; the ORIGINATING panel hears
   *  {host:'dialog-closed'} on its port. Nothing else changes. */
  function closeDialog(opts = {}) {
    if (!dialog) {
      return;
    }
    const was = dialog;
    dialog = null;
    clearTimeout(was.dv.timer);
    closePort(was.dv);
    if (was.c.dv === was.dv) {
      was.c.dv = null;
    }
    was.scrim.remove();
    window.dispatchEvent(new Event('room:overlay-closed')); // zoom guard (Owner 2026-10-03, IMG_7709/7710)
    try {
      was.port.postMessage({ host: 'dialog-closed' });
    } catch {
      /* the panel's port is gone (it navigated or left) */
    }
    /* focus back to the panel's frame (an iframe element, never a text
       field); not on a touch screen, where focus can raise a keyboard */
    const touch = matchMedia('(pointer: coarse)').matches;
    const back = large ? large.x : was.opener;
    if (opts.focus !== false && !touch && back?.isConnected && typeof back.focus === 'function') {
      back.focus({ preventScroll: true });
    }
  }
  window.addEventListener('keydown', (e) => {
    if (!dialog) {
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeDialog();
    } else if (e.key === 'Tab') {
      /* the dialog's own stops: ✕ and the frame; nothing behind it */
      const stops = [dialog.x, dialog.dv.frame].filter((n) => n && !n.hidden);
      const i = stops.indexOf(document.activeElement);
      e.preventDefault();
      stops[(i + (e.shiftKey ? stops.length - 1 : 1) + stops.length) % stops.length]?.focus();
    }
  }, true);
  document.addEventListener('focusin', (e) => {
    if (dialog && !dialog.card.contains(e.target)) {
      dialog.x.focus({ preventScroll: true }); // focus never lands behind the dialog
    }
  });

  /** A line link [rooms/tool-links]: panel `panelId`'s app at `path`, in the
   *  column (or LARGE). False when that panel is not here or the path is
   *  refused. */
  function openLink({ panelId, path, title, opener, large: big }) {
    const c = cells.get(panelId);
    if (!c) {
      return false;
    }
    const t = typeof title === 'string' ? title.slice(0, 80) : '';
    return big ? openLarge(c, path, t, opener) : openViewOf(c, path, t, opener);
  }

  /** The engine's voice state (room view / push / a mute reply). null = not
   *  connected. */
  function setVoice(raw) {
    const next = cleanVoice(raw);
    if (JSON.stringify(next) === JSON.stringify(voice)) {
      return;
    }
    voice = next;
    paintVoice();
    syncHostCell();
  }

  /* ---- A CONNECTION WITH NO PANEL (the panel host is not on the allow-list,
     so the engine registered none): the host draws a Voice cell of its own —
     the status and its own Mute/Disconnect — so disconnecting never depends
     on the panel existing either. Gone the moment a voice panel arrives. ---- */
  let hostCell = null;
  function syncHostCell() {
    const hasPanel = [...cells.values()].some((c) => isVoice(c.panel));
    const want = !!voice?.connected && !hasPanel;
    if (!want) {
      hostCell?.el.remove();
      hostCell = null;
      return;
    }
    if (!hostCell) {
      const el = document.createElement('section');
      el.className = 'cell cell-voice cell-voice-host';
      el.dataset.cell = 'voice-host';
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'cell-h';
      const tt = document.createElement('span');
      tt.className = 'tt';
      tt.textContent = 'Voice';
      const vs = document.createElement('span');
      vs.className = 'vs';
      const chev = document.createElement('span');
      chev.className = 'chev';
      chev.setAttribute('aria-hidden', 'true');
      chev.textContent = '▾';
      head.append(iconSvg('voice'), tt, vs, chev);
      const hw = document.createElement('div');
      hw.className = 'cell-hw';
      hw.append(head);
      const body = document.createElement('div');
      body.className = 'cell-b';
      const fb = fallbackButtons();
      body.append(fb);
      el.append(hw, body);
      wire(el, 'voice-host');
      hostCell = { el, vs, fb };
    }
    if (o.list.firstElementChild !== hostCell.el) {
      o.list.insertBefore(hostCell.el, o.list.firstElementChild);
    }
    paintStatus(hostCell.vs, voice);
    paintFallback(hostCell.fb);
  }

  return {
    setPanels,
    /** the person's tones changed (Settings): repaint every panel cell's tone [hub-v2] */
    retone: () => cells.forEach((c) => { c.el.dataset.tone = cellTone(c.panel); }),
    setVoice,
    previewChanged,
    pickFile,
    /** the phone layer bar's + should show for this panel (uploads, or notes) */
    canAdd: (id) => {
      const c = cells.get(id);
      return !!c && (c.panel.uploads === true || hasNotes(c));
    },
    notesChanged,
    showLayer,
    /** the panels in order, with the count each app last reported */
    list: () => [...o.list.children].map((el) => cells.get(el.dataset.cell)).filter(Boolean).map((c) => ({ ...c.panel, count: c.count })),
    iconSvg,
    /** the panel menu's Collapse (a cell folds exactly as its header click does) */
    collapsed: (id) => !!cells.get(id)?.el.classList.contains('collapsed'),
    setCollapsed: (id, v) => {
      const c = cells.get(id);
      if (c && c.el.classList.contains('collapsed') !== !!v) {
        c.head.click();
      }
    },
    headerOf: (id) => cells.get(id)?.head ?? null,
    /** The app view open in the column right now, as something ANOTHER room can find again: {slug, path, title}, or null (no app view is showing) [room switch] */
    snapshotView: () => {
      const cur = o.preview?.current?.();
      if (!cur) {
        return null;
      }
      for (const c of cells.values()) {
        if (cur.owner === ownerOf(c) && c.vv?.outer?.isConnected && c.panel.app_slug) {
          return { slug: c.panel.app_slug, path: c.vv.path, title: c.vv.title || c.panel.title };
        }
      }
      return null;
    },
    /** Open that app's view in THIS room's own panel for it (path '' = the app's home); false when this room has no such app [room switch] */
    openApp: ({ slug, path, title }) => {
      for (const c of cells.values()) {
        if (c.panel.app_slug === slug) {
          return openViewOf(c, typeof path === 'string' ? path : '', typeof title === 'string' && title ? title : c.panel.title);
        }
      }
      return false;
    },
    /* line links [rooms/tool-links] */
    openLink,
    closeLarge,
    largeOpen: () => !!large,
    /* app dialogs [ticket] */
    closeDialog,
    dialogOpen: () => !!dialog,
  };
}
