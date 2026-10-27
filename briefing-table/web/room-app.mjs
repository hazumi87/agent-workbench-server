/* FULL PAGE of a room app's panel [ticket], the host half. Opened by the room
 * page (web/room-cells.mjs, the cell's "Open full page" or the app's own
 * {panel:'open-page'}) at
 *   /room-app.html?room=<roomId>&panel=<panelId>&path=<path>&title=<title>
 * A thin host: it reads the room the way the room page does (same cookie),
 * frames the panel's OWN app at frameUrl + path with ?surface=window and the
 * rail frame's sandbox, and hands it the SAME port contract (docs in the
 * header of web/room-cells.mjs): app-status, {host:'surface', kind:'window'},
 * actions, open-settings, and window copy / download. The shared pieces are
 * web/room-app-port.mjs and web/room-app-dialog.mjs; the rail panel keeps
 * running in the room page, untouched.
 *
 * What only makes sense inside the room page is ANSWERED, never dropped:
 *   on the port:  {panel:'dialog'}   -> {host:'dialog-result', ok:false, error}
 *                 {panel:'note', op} -> {host:'note', op, ok:false, error}
 *                 {panel:'open-page'}-> {host:'page-result', ok:false, error:'already a full page'}
 *                 {panel:'notes'|'page'} (declarations) are ignored
 *   on window:    {panel:'preview'|'compose'|'open'|'drop'|'paste'} ->
 *                 {host:'unavailable', panel, error:'not available in a full page'}
 *                 (height, count, preview-close, dragover: ignored)
 * Every error is 'not available in a full page' unless named above. A held or
 * unregistered app is a plain message here, not a frame.
 */
import { parsePageQuery, pageUrl, pageDocTitle, askGate, PAGE_UNAVAILABLE } from '/room-app-dialog.mjs';
import { withSurface } from '/room-cells.mjs';
import { tokens as paletteTokens } from '/palette.mjs';
import { globalPref } from '/room-palette.mjs';
import { themeMessage } from '/app-theme.mjs';
import { SETTINGS_APPS_URL, openAppSettings } from '/app-status.mjs';
import { ACTION_NAME, ACTION_GAP_MS, runPanelAction, copyText, saveUrl, openTab } from '/room-app-port.mjs';

const NOT_HERE = 'not available in a full page';
const POLL_MS = 5000;
const COPY_MAX = 4096;
const $ = (id) => document.getElementById(id);

function say(html) {
  const m = document.createElement('div');
  m.className = 'ra-msg';
  m.append(...html);
  $('raMain').replaceChildren(m);
}
const text = (s) => document.createTextNode(s);
function toast(s) {
  const t = $('raToast');
  t.textContent = s;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, 3000);
}
function fail(msg) {
  document.title = msg;
  $('raTitle').textContent = msg;
  say([text(msg)]);
}

async function getRoom(id) {
  const r = await fetch(`/api/rooms/${encodeURIComponent(id)}`);
  if (r.status === 401) {
    location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    return null;
  }
  if (!r.ok) {
    return { status: r.status };
  }
  return { status: 200, ...(await r.json()) };
}

const appStatusOf = (p) => (p.app_status === 'held' || p.app_status === 'unregistered' ? p.app_status : p.app_held ? 'held' : 'enabled');

async function boot() {
  const q = parsePageQuery(location.search);
  if (!q.ok) {
    return fail('This page needs a room and an app panel.');
  }
  const got = await getRoom(q.room);
  if (!got) {
    return;
  }
  if (got.status !== 200) {
    return fail(got.status === 404 ? 'No such room.' : `Room unavailable (HTTP ${got.status}).`);
  }
  const roomName = String(got.room?.name ?? 'Room');
  const find = (g) => (Array.isArray(g.panels) ? g.panels.find((p) => p && p.id === q.panel && typeof p.frameUrl === 'string' && p.app_slug) : null);
  const panel = find(got);
  const appName = String(panel?.title ?? 'App').slice(0, 80);
  const title = pageDocTitle(q.title, appName, roomName);
  document.title = title;
  $('raTitle').textContent = title;
  $('raTitle').title = title;
  const roomUrl = `/room.html?room=${encodeURIComponent(q.room)}`;
  const back = $('raBack');
  back.href = roomUrl;
  back.hidden = false;
  back.addEventListener('click', (e) => {
    if (window.parent !== window) {
      e.preventDefault(); // select the room's tab in the shell (the manager's own call)
      window.parent.postMessage({ hwbOpenTab: { url: roomUrl, title: roomName, sessionId: `room:${q.room}` } }, '*');
    }
  });
  if (window.parent !== window) {
    window.parent.postMessage({ hwbSessionId: `room-app:${q.room}:${q.panel}:${q.path}` }, '*');
    window.parent.postMessage({ hwbState: 'idle', title }, '*');
  }
  if (got.room?.state === 'archived') {
    return say([text(`${roomName} is closed.`)]);
  }
  if (!panel) {
    return say([text(`This panel is no longer in ${roomName}.`)]);
  }
  const blocked = (p) => {
    const st = appStatusOf(p);
    if (st === 'enabled') {
      return null;
    }
    const a = document.createElement('a');
    a.href = SETTINGS_APPS_URL;
    a.textContent = 'Settings, Apps';
    a.addEventListener('click', (e) => { e.preventDefault(); openAppSettings(); });
    return [text(`${appName} is ${st === 'held' ? 'waiting for approval' : 'not registered'}. Open `), a, text('.')];
  };
  const msg = blocked(panel);
  if (msg) {
    return say(msg);
  }
  const src0 = pageUrl(panel.frameUrl, q.path, location.href);
  if (src0 === null) {
    return fail('That place is not in this app.');
  }
  mount(q, panel, withSurface(src0, 'window'), appName, roomName, find);
}

function mount(q, panel, src, appName, roomName, find) {
  let port = null;
  let actionAt = 0;
  let busy = false;
  let settingsAt = 0;
  let status = appStatusOf(panel);
  const f = document.createElement('iframe');
  f.title = appName;
  f.setAttribute('sandbox', `allow-forms allow-popups allow-popups-to-escape-sandbox${panel.scripts === true ? ' allow-scripts' : ''}`);
  f.setAttribute('referrerpolicy', 'no-referrer');
  const tell = (m) => { try { f.contentWindow?.postMessage(m, '*'); } catch { /* gone */ } };
  const toPort = (m) => { try { port?.postMessage(m); } catch { /* closed */ } };
  /* the person's global palette (this page carries no room override) [app theme, the design system [ref]] */
  const tellTheme = () => toPort(themeMessage(paletteTokens, globalPref(), document.documentElement.dataset.mode));
  document.addEventListener('palette-change', tellTheme);
  window.addEventListener('storage', (e) => { if (e.key === 'hwb.palette.v1') { setTimeout(tellTheme, 0); } });
  const tellStatus = () => toPort({ host: 'app-status', actions: status, settingsUrl: SETTINGS_APPS_URL });

  /* the port, on the FIRST load only (the rail's rule: a frame that
     navigated itself has none) */
  let loads = 0;
  f.addEventListener('load', () => {
    loads += 1;
    if (loads === 1) {
      const ch = new MessageChannel();
      port = ch.port1;
      port.onmessage = (ev) => onPort(ev.data);
      try {
        f.contentWindow.postMessage({ host: 'port' }, '*', [ch.port2]);
      } catch {
        port = null;
        return;
      }
      tellStatus();
      toPort({ host: 'surface', kind: 'window' });
      tellTheme();
    } else if (port) {
      port.close();
      port = null;
    }
  });

  function onPort(d) {
    if (!d || typeof d !== 'object') {
      return;
    }
    if (d.panel === 'action') {
      void action(d);
    } else if (d.panel === 'open-settings') {
      const now = Date.now();
      if (navigator.userActivation?.isActive === true && now - settingsAt >= 1000) {
        settingsAt = now;
        openAppSettings();
      }
    } else if (d.panel === 'open-page') {
      toPort({ host: 'page-result', ok: false, error: 'already a full page' });
    } else if (PAGE_UNAVAILABLE[d.panel]) {
      const [type, error] = PAGE_UNAVAILABLE[d.panel];
      toPort(type === 'note' ? { host: type, op: typeof d.op === 'string' ? d.op.slice(0, 16) : '', ok: false, error } : { host: type, ok: false, error });
    }
  }
  async function action(d) {
    const plain = (x) => x === undefined || (!!x && typeof x === 'object' && !Array.isArray(x));
    if (typeof d.name !== 'string' || !ACTION_NAME.test(d.name) || !plain(d.params) || !plain(d.input)) {
      return;
    }
    const reply = (m) => toPort({ host: 'action-result', name: d.name, ...m });
    const now = Date.now();
    const gate = askGate(navigator.userActivation?.isActive, now, actionAt, status, ACTION_GAP_MS);
    if (gate || busy) {
      reply({ ok: false, error: gate || 'too fast' });
      return;
    }
    actionAt = now;
    busy = true;
    let r;
    try {
      r = await runPanelAction(q.room, q.panel, d);
    } finally {
      busy = false;
    }
    reply(r.ok ? { ok: true, ...(r.warning ? { warning: r.warning.slice(0, 200) } : {}) } : { ok: false, error: String(r.error).slice(0, 200) });
    if (!r.ok && (r.error === 'needs-approval' || r.error === 'not-registered')) {
      toast(`${appName}: ${r.error === 'needs-approval' ? 'needs approval' : 'is not registered'} (Settings, Apps)`);
    } else if (!r.ok) {
      toast(`${appName}: ${d.name} failed: ${String(r.error).slice(0, 160)}`);
    } else if (r.warning) {
      toast(`${appName}: done, ${r.warning}`.slice(0, 240));
    }
  }

  /* window messages: only this frame's. copy / download are the host's hands;
     what belongs to the room page is answered (see the header). */
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== f.contentWindow || !d || typeof d !== 'object') {
      return;
    }
    if (d.panel === 'copy' && typeof d.text === 'string' && d.text.length <= COPY_MAX) {
      void copyText(d.text).then((ok) => toast(ok ? 'Copied' : 'Could not copy'));
    } else if (d.panel === 'download' && typeof d.url === 'string') {
      try {
        const u = new URL(d.url, new URL(f.getAttribute('src'), location.href));
        if (u.protocol === 'https:' || u.protocol === 'http:') {
          saveUrl(u.href, d.name);
        }
      } catch { /* not a URL */ }
    } else if (['preview', 'compose', 'open', 'drop', 'paste'].includes(d.panel)) {
      tell({ host: 'unavailable', panel: d.panel, error: NOT_HERE });
    } else if (d.panel === 'action') {
      toPort({ host: 'action-result', name: typeof d.name === 'string' ? d.name.slice(0, 64) : '', ok: false, error: 'send actions on the action port' });
    }
  });

  /* ask first (a proxy failure is an opaque blank frame), as the rail does */
  (async () => {
    let st = 0;
    try { st = (await fetch(src, { method: 'HEAD', cache: 'no-store' })).status; } catch { st = 0; }
    if (!((st >= 200 && st < 400) || st === 405 || st === 501)) {
      const r = document.createElement('button');
      r.type = 'button';
      r.textContent = 'retry';
      r.addEventListener('click', () => location.reload());
      return say([text(`${appName} isn't answering · `), r]);
    }
    f.src = src;
    $('raMain').replaceChildren(f);
  })();

  /* the room's own state, re-read: the app's status goes to the port; a panel
     that left, a closed room or a blocked app replaces the frame */
  setInterval(async () => {
    const g = await getRoom(q.room).catch(() => null);
    if (!g || g.status !== 200) {
      return;
    }
    const p = find(g);
    const gone = !p ? `This panel is no longer in ${roomName}.` : g.room?.state === 'archived' ? `${roomName} is closed.` : null;
    if (gone) {
      return say([text(gone)]);
    }
    const st = appStatusOf(p);
    if (st !== status) {
      status = st;
      tellStatus();
    }
  }, POLL_MS);
}

void boot();
