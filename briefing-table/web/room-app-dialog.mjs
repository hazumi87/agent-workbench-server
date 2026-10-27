/* APP DIALOG — what a panel may ask for in {panel:'dialog', path, title?,
 * size?} [ticket], checked BEFORE the host draws anything. Pure: no DOM, no
 * imports, so test/room-app-dialog.test.mjs runs it as shipped.
 *
 * The dialog frames the panel's OWN app, through the SAME panel proxy and
 * frame token the panel's view uses (frameUrl + a relative path). The engine
 * proxy already refuses a tail that leaves the registered directory; this is
 * the host's own refusal, stricter, so a bad path never becomes a frame:
 *   - a string of 1..200 characters, no control characters or whitespace
 *   - RELATIVE: no scheme (`https:`, `javascript:`), no leading '/' (so no
 *     '//host' either), no backslash anywhere (a URL parser reads it as '/'),
 *     no leading '?' or '#' (a dialog names a page)
 *   - no '.' or '..' segment, plain or percent-encoded in any case, and no
 *     encoded '/' or backslash inside a segment
 *   - resolved against the frame's DIRECTORY it must stay under it, same
 *     origin (belt and braces over the rules above)
 * title: plain text, whitespace runs folded to one space, trimmed, at most
 * 80 characters.
 * size: 'md' (the default) or 'lg'; anything else is refused.
 * (The FULL PAGE helpers [ticket] are at the end of this file.)
 */

const BACKSLASH = String.fromCharCode(92);
const PATH_MAX = 200;
const TITLE_MAX = 80;
export const DIALOG_SIZES = ['md', 'lg'];

/** A dialog path relative to the app's panel directory, or null (refused). */
export function dialogPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > PATH_MAX) {
    return null;
  }
  for (let i = 0; i < p.length; i += 1) {
    const code = p.charCodeAt(i);
    if (code <= 32 || code === 127) {
      return null; // control characters and whitespace
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('/') || p.includes(BACKSLASH) || p.startsWith('?') || p.startsWith('#')) {
    return null;
  }
  const segs = p.split(/[?#]/)[0].split('/');
  for (const s of segs) {
    let d;
    try {
      d = decodeURIComponent(s);
    } catch {
      return null; // a malformed escape
    }
    if (d === '.' || d === '..' || d.includes('/') || d.includes(BACKSLASH)) {
      return null;
    }
  }
  return p;
}

/** The frame URL for `path` under `frameUrl`'s directory, as a same-origin
 *  path (pathname + search + hash); null when it would leave that directory.
 *  base: what a relative frameUrl resolves against (the page's location). */
export function dialogUrl(frameUrl, path, base) {
  const clean = dialogPath(path);
  if (clean === null || typeof frameUrl !== 'string') {
    return null;
  }
  try {
    const frame = new URL(frameUrl, base);
    const dir = new URL('./', frame);
    const u = new URL(clean, dir);
    if (u.origin !== dir.origin || !u.pathname.startsWith(dir.pathname) || u.pathname === dir.pathname) {
      return null;
    }
    return u.pathname + u.search + u.hash;
  } catch {
    return null;
  }
}

/** The whole request: {ok:true, path, url, title, size} or {ok:false, error}. */
export function cleanDialog(d, frameUrl, base) {
  if (!d || typeof d !== 'object') {
    return { ok: false, error: 'bad request' };
  }
  const path = dialogPath(d.path);
  const url = path === null ? null : dialogUrl(frameUrl, path, base);
  if (url === null) {
    return { ok: false, error: 'bad path' };
  }
  if (d.title !== undefined && typeof d.title !== 'string') {
    return { ok: false, error: 'bad title' };
  }
  const title = String(d.title ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
  const size = d.size === undefined ? 'md' : d.size;
  if (!DIALOG_SIZES.includes(size)) {
    return { ok: false, error: 'bad size' };
  }
  return { ok: true, path, url, title, size };
}

/* ---- FULL PAGE [ticket]: {panel:'page', enabled, path?, title?} declares it,
 * {panel:'open-page', path?, title?} opens one place; both land in
 * /room-app.html (web/room-app.mjs). The path rule is the dialog's (the same
 * dialogPath/dialogUrl), except that '' is allowed: the app's panel root view.
 * title: the view's name, plain text, folded and trimmed, at most 40
 * characters; none = 'Full view'. Still pure, so test/room-app-page.test.mjs
 * runs it as shipped. */
export const PAGE_TITLE_MAX = 40;
export const PAGE_DEFAULT_TITLE = 'Full view';
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A page title as text: the cleaned string ('' = none given), or null when
 *  it is not a string. */
export function pageTitle(t) {
  if (t === undefined) {
    return '';
  }
  return typeof t === 'string' ? t.replace(/\s+/g, ' ').trim().slice(0, PAGE_TITLE_MAX) : null;
}

/** The path a page names: undefined/'' = the panel root; else the dialog's rule. */
function pagePathOf(p) {
  return p === undefined || p === '' ? '' : dialogPath(p);
}

/** {panel:'page'} -> {enabled:false} | {enabled:true, path, title} | null
 *  (a declaration with a bad path or title is ignored, nothing shown). */
export function cleanPageDecl(d, frameUrl, base) {
  if (!d || typeof d !== 'object') {
    return null;
  }
  if (d.enabled === false) {
    return { enabled: false };
  }
  if (d.enabled !== true) {
    return null;
  }
  const path = pagePathOf(d.path);
  const title = pageTitle(d.title);
  if (path === null || title === null || (path !== '' && dialogUrl(frameUrl, path, base) === null)) {
    return null;
  }
  return { enabled: true, path, title: title || PAGE_DEFAULT_TITLE };
}

/** The frame URL of a full page: the panel's frameUrl itself ('' = its root
 *  view) or the dialog's rule under its directory; null when refused. */
export function pageUrl(frameUrl, path, base) {
  return path === '' ? (typeof frameUrl === 'string' ? frameUrl : null) : dialogUrl(frameUrl, path, base);
}

/** {panel:'open-page'} (declared = what the panel declared, or null) ->
 *  {ok:true, path, title} | {ok:false, error}. */
export function cleanPageRequest(d, frameUrl, base, declared) {
  if (!d || typeof d !== 'object') {
    return { ok: false, error: 'bad request' };
  }
  const path = d.path === undefined ? (declared?.path ?? '') : pagePathOf(d.path);
  if (path === null || (path !== '' && dialogUrl(frameUrl, path, base) === null)) {
    return { ok: false, error: 'bad path' };
  }
  const t = pageTitle(d.title);
  if (t === null) {
    return { ok: false, error: 'bad title' };
  }
  return { ok: true, path, title: t || (d.path === undefined ? declared?.title : '') || PAGE_DEFAULT_TITLE };
}

/** The click + rate gate every port ask shares: the error word, or null. */
export function askGate(active, now, last, status, gap = 500) {
  if (active !== true) {
    return 'needs a click';
  }
  if (now - last < gap) {
    return 'too fast';
  }
  return status === 'held' ? 'needs-approval' : status === 'unregistered' ? 'not-registered' : null;
}

/** The address of a full page: /room-app.html?room=&panel=&path=&title= */
export function pageTabUrl(room, panel, path, title) {
  const q = new URLSearchParams({ room, panel });
  if (path) {
    q.set('path', path);
  }
  if (title) {
    q.set('title', title);
  }
  return `/room-app.html?${q}`;
}

/** The page's query string, validated: {ok:true, room, panel, path, title} or
 *  {ok:false, error}. Ids are plain tokens; the path passes the dialog's
 *  rule (re-checked against the real frame URL by the page). */
export function parsePageQuery(search) {
  const q = new URLSearchParams(search);
  const room = q.get('room') ?? '';
  const panel = q.get('panel') ?? '';
  if (!ID_RE.test(room) || !ID_RE.test(panel)) {
    return { ok: false, error: 'bad address' };
  }
  const path = pagePathOf(q.get('path') ?? '');
  const title = pageTitle(q.get('title') ?? '');
  if (path === null || title === null) {
    return { ok: false, error: 'bad address' };
  }
  return { ok: true, room, panel, path, title: title || PAGE_DEFAULT_TITLE };
}

/** The tab and document title: "<view> | <App> | <Room>" (never the room first). */
export function pageDocTitle(view, app, room) {
  return `${view} | ${app} | ${room}`;
}

/** The port asks that only make sense inside the room page, answered in a
 *  full page: {panel} -> [reply type, reason]. */
export const PAGE_UNAVAILABLE = {
  dialog: ['dialog-result', 'not available in a full page'],
  note: ['note', 'not available in a full page'],
};

/* ---- ASSET PICKER [asset picker, Owner 2026-10-05]: {panel:'pick', kind:'image',
 * sources:['room'] | ['room','library'], title} asks the host to open the
 * picker (web/asset-picker.mjs). Same click gate and rate as a dialog; the
 * panel must also have declared `pick` in tool.json host_capabilities. The
 * answer is {host:'picked', items:[...]} or {host:'picked', cancelled:true}.
 * A successful pick opens a SINGLE-USE WINDOW: that same panel's next ONE
 * action on the port, within PICK_WINDOW_MS, passes the click gate as if
 * clicked (the app adds the picked asset after the modal took the click's
 * activation away). A cancel opens nothing. Pure, so test/asset-picker.test.mjs
 * runs it as shipped. */
export const PICK_KINDS = ['image'];
export const PICK_SOURCES = ['room', 'library'];
export const PICK_WINDOW_MS = 10000;

/** {ok:true, kind, sources, title} or {ok:false, error}. */
export function cleanPick(d) {
  if (!d || typeof d !== 'object') {
    return { ok: false, error: 'bad request' };
  }
  if (!PICK_KINDS.includes(d.kind)) {
    return { ok: false, error: 'bad kind' };
  }
  if (!Array.isArray(d.sources) || d.sources.length === 0 || d.sources.length > PICK_SOURCES.length || !d.sources.every((s) => PICK_SOURCES.includes(s))) {
    return { ok: false, error: 'bad sources' };
  }
  if (d.title !== undefined && typeof d.title !== 'string') {
    return { ok: false, error: 'bad title' };
  }
  const sources = PICK_SOURCES.filter((s) => d.sources.includes(s)); // Room first, then Library
  return { ok: true, kind: d.kind, sources, title: String(d.title ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) };
}

/** Open the window for `panelId` after a successful pick. */
export function openPickWindow(windows, panelId, now) {
  windows.set(panelId, now + PICK_WINDOW_MS);
}

/** Does this panel's next action pass the click gate? Consumes the window
 *  either way once looked at: ONE action, never two. */
export function takePickWindow(windows, panelId, now) {
  const until = windows.get(panelId);
  windows.delete(panelId);
  return until !== undefined && now <= until;
}

/** The answer sent to the app: the picker's result as the contract words it. */
export function pickedMessage(items) {
  return Array.isArray(items) && items.length ? { host: 'picked', items } : { host: 'picked', cancelled: true };
}
