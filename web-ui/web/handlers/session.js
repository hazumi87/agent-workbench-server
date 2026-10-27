'use strict';
// session:* in the web build: the terminal panes, on the engine's WS /pty (web/lib/pty-link.js), with the sign-in cookie.
// Owner: a builder. The desktop's session manager (main.js: node-pty, ssh, broker, term routes, hold/hide, snapshots) has no
// counterpart in a browser; the ENGINE keeps every pane running and replays its last 2 MB on attach, so this module is small:
//   session:permit        a one-use token: a CLI starts only from an explicit launch (a click), never from a reload. The one exception is the
//                         renderer's first terminal at page load (why 'startup', once): it REATTACHES to the Shell pane that is already
//                         running, and only starts one when there is none, so a reload keeps your terminal and never leaks a pane
//   adoption               after the page-load terminal, every OTHER running recipe pane of this person (the table's plain recipe:<id> panes)
//                          is adopted the way the desktop re-adopts on a reload: a session record plus a session:adopt event, the pane held
//                          until the page says session:attached; seat and fresh instances (recipe:<id>#x) belong to rooms and are left alone
//   session:create        recipe -> POST /api/recipes/:id/launch, then attach {spawn:true}; a plain shell is the engine recipe "Shell";
//                         attachOnly (a listed pane) and the room seat's terminal (route 'term') attach to an EXISTING pane and never spawn
//   session:input/resize  frames to the pane; typed input is never queued: a down socket or no keyboard lease says "typing paused"
//   session:close         ends a pane the person started (POST /api/sessions/:paneid/end); a seat viewer only lets go
//   session:retry         a permit relaunches (Run again, Restore, Start fresh); no permit only reattaches
//   session:term-control  takeControl on /pty (there is no release frame on /pty: false)
//   events                session:data, session:gap (the replay after a reattach), session:route, session:exit, session:typing-paused, sessions:update
// A reconnect or reload NEVER sends spawn:true: it reattaches with intent 'reclaim' and reattachOnly. The keyboard lease is the engine's:
// one holder types; a second tab views.
const { createLink } = require('../lib/pty-link');

const PERMIT_MS = 60000;
const TAB_KEY = 'wb-web.tab.v1';
const HUE = 215;
// one name, one colour, in every tab and after every reload: the hue is a hash of the name, never random
const hueOf = (name) => { let h = 0; for (const c of String(name || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return name ? h % 360 : HUE; };
const TAKE_MS = 2500;
const ID = /^[A-Za-z0-9._:#%-]{1,160}$/;
/** This tab's name for the keyboard lease. The engine tells holders apart by this label: two tabs both called "Web" are ONE driver to it,
 *  so a second tab's reclaim would take the keyboard from the first. sessionStorage keeps it across a reload of THIS tab and gives every other
 *  tab its own; without storage it is per page load. */
function tabLabel(win = globalThis) {
  let id = null;
  try { id = win.sessionStorage && win.sessionStorage.getItem(TAB_KEY); } catch (e) { id = null; }
  if (!id || !/^[0-9a-f]{6}$/.test(id)) {
    id = hex().slice(0, 6);
    try { if (win.sessionStorage) win.sessionStorage.setItem(TAB_KEY, id); } catch (e) { /* per page load then */ }
  }
  return 'Web ' + id;
}
const hex = () => { const b = new Uint8Array(12); const c = globalThis.crypto; if (c && c.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256); return [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); }; // the browser always has crypto; the fallback only keeps a bare context (the coverage check) from throwing

function register(api) {
  const handlers = new Map(); // the session:* handlers, so the sessions facade below calls the same code the channels run
  const handle = (chan, fn) => { handlers.set(chan, fn); api.handle(chan, fn); };
  const opts = api.sessionOptions || {};
  const sessions = new Map(); // sid -> record
  const byPane = new Map(); // paneid -> Set<sid>
  const permits = new Map(); // token -> expiry
  let nextSid = 1;
  let startupUsed = false;
  let startupTerminal = false;
  let link = null;
  let shellId = null;
  let targetId = null;
  const now = opts.now || Date.now;
  let labelCache = opts.label || null;
  const label = () => (labelCache = labelCache || tabLabel()); // read when first needed: a bare context at register time has no storage
  const defer = opts.defer || ((f) => setTimeout(f, 0)); // a test holds the release to prove the bytes wait

  const emit = (c, p) => api.emit(c, p);
  // ---- who types: one tab holds the keyboard lease; the others are WATCHING (window.wb.web.terminal draws the strip and the button)
  const controlFns = new Set();
  const controlState = (s) => (s.term ? null : !s.ready ? 'away' : s.controlling ? 'typing' : 'watching');
  const control = (s, extra) => { const st = controlState(s); if (st === null) return; const m = { sid: s.sid, state: st, ...(extra || {}) }; for (const fn of [...controlFns]) { try { fn(m); } catch (e) { /* a listener's own error */ } } };
  const ptyUrl = () => opts.url || ((globalThis.location && globalThis.location.protocol === 'https:' ? 'wss' : 'ws') + '://' + globalThis.location.host + '/pty');

  // ---- the page's list of sessions (the rail and the tabs read it)
  const row = (s) => ({
    sid: s.sid, wid: 1, title: s.title, name: s.name, hue: s.hue, hidden: false, flowing: s.flowing, needsYou: null, place: 'This server', login: '', folder: s.folder || '~',
    recipeId: s.recipeId || null, accountId: null, accountLabel: null, realmName: null, lastUsed: s.lastInput || s.created, launchWord: null, keepsRunning: !s.term,
    termOf: s.termOf || null, serverId: 'local', bsid: s.paneid, launchDone: !!(s.route && (s.route.state === 'finished' || s.route.state === 'stopped')), resumable: false, stopped: null,
    launchAt: s.route && s.route.since ? s.route.since : null,
  });
  const list = () => [...sessions.values()].map(row);
  const broadcast = () => emit('sessions:update', list());
  const routeOf = (s, patch) => { s.route = { ...s.route, ...patch }; emit('session:route', { sid: s.sid, ...s.route }); };

  // ---- the engine's door
  async function json(path, init) {
    const res = await api.engine.fetch(path, init);
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    return { status: res.status, ok: res.ok, body };
  }
  const post = (path, body) => json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

  function ensureLink() {
    if (link) return link;
    link = createLink({ url: ptyUrl, WebSocketImpl: opts.WebSocketImpl, timers: opts.timers, onFrame, onStatus });
    return link;
  }
  let opened = false;
  function onStatus(st) {
    if (st === 'closed') {
      for (const s of sessions.values()) { if (s.ready) { s.ready = false; routeOf(s, { state: 'reconnecting' }); control(s); } }
    } else if (st === 'open') {
      if (opened) for (const s of sessions.values()) if (!s.ended) reattach(s); // a reconnect: reclaim, never spawn
      opened = true;
    }
  }
  const attachFrame = (s, extra) => ({ type: 'attach', paneid: s.paneid, label: label(), ...extra });
  function reattach(s) { link.send(attachFrame(s, { intent: s.term && !s.controlOnOpen ? 'view' : 'reclaim', reattachOnly: true })); }
  function bind(s) { if (!byPane.has(s.paneid)) byPane.set(s.paneid, new Set()); byPane.get(s.paneid).add(s.sid); }
  function unbind(s) { const set = byPane.get(s.paneid); if (set) { set.delete(s.sid); if (!set.size) byPane.delete(s.paneid); } }

  function deliver(s, data) {
    if (s.holding) { s.queue.push(data); return; }
    emit('session:data', { sid: s.sid, data });
  }
  function release(s) {
    if (!s.holding) return;
    s.holding = false;
    const q = s.queue; s.queue = [];
    for (const d of q) emit('session:data', { sid: s.sid, data: d });
  }

  function finish(s, code) {
    s.ended = true; s.ready = false;
    if (s.shell) { // a plain shell closes its tab, like the desktop's
      emit('session:exit', { sid: s.sid });
      sessions.delete(s.sid); unbind(s); broadcast();
      return;
    }
    routeOf(s, { state: s.term ? 'term-closed' : 'finished', code: Number.isInteger(code) ? code : null, since: now() });
    broadcast();
  }

  function onFrame(m) {
    const set = m && typeof m.paneid === 'string' ? byPane.get(m.paneid) : null;
    if (!set) return;
    for (const sid of [...set]) {
      const s = sessions.get(sid);
      if (!s) continue;
      switch (m.type) {
        case 'pane.control': {
          const had = s.controlling;
          s.controlling = m.controlling === true;
          if (s.ready && had !== s.controlling) control(s);
          if (s.term && s.ready) routeOf(s, { state: s.controlling ? 'controlling' : 'viewing' });
          if (s.controlling && s.takeWaiters) { for (const f of s.takeWaiters.splice(0)) f(true); }
          break;
        }
        case 'pane.control-lost': { const had = s.controlling; s.controlling = false; if (s.term && s.ready) routeOf(s, { state: 'viewing' }); else if (s.ready) control(s, { lost: had === true }); break; }
        case 'pane.control-denied': break; // the watching strip says it; the generic "typing paused" is for a lost connection only
        case 'pane.ready':
          s.ready = true; s.ended = false; s.expectReplay = m.reattached === true;
          if (typeof m.title === 'string' && m.title) s.title = m.title.slice(0, 120);
          if (m.prefs && typeof m.prefs.friendlyName === 'string' && m.prefs.friendlyName) { s.name = m.prefs.friendlyName.slice(0, 60); s.hue = hueOf(s.name); }
          routeOf(s, { state: s.term ? (s.controlling ? 'controlling' : 'viewing') : 'up' });
          control(s);
          if (s.cols > 0 && s.rows > 0) link.send({ type: 'resize', paneid: s.paneid, cols: s.cols, rows: s.rows });
          broadcast();
          break;
        case 'pane.data':
          if (s.expectReplay) { s.expectReplay = false; emit('session:gap', { sid: s.sid, replay: String(m.data || '') }); } else deliver(s, String(m.data == null ? '' : m.data));
          break;
        case 'pane.reattached': s.expectReplay = false; break;
        case 'pane.exit': finish(s, m.code); break;
        case 'pane.needs-launch': s.ended = true; s.ready = false; routeOf(s, { state: 'finished', code: null, message: String(m.message || '').slice(0, 200), since: now() }); broadcast(); break;
        case 'pane.error': s.ended = true; s.ready = false; routeOf(s, { state: 'spawn-failed', message: String(m.message || 'The server could not start this.').slice(0, 200) }); broadcast(); break;
        case 'pane.title': if (typeof m.title === 'string' && m.title) { s.title = m.title.slice(0, 120); broadcast(); } break;
        case 'pane.state': { const f = m.state === 'streaming'; if (f !== s.flowing) { s.flowing = f; broadcast(); } break; }
        default: break;
      }
    }
  }

  // ---- launch helpers
  async function target() {
    if (targetId) return targetId;
    const r = await json('/api/targets');
    const t = r.ok && r.body && Array.isArray(r.body.targets) ? (r.body.targets.find((x) => x && x.id === 'local') || r.body.targets[0]) : null;
    targetId = t && typeof t.id === 'string' ? t.id : null;
    return targetId;
  }
  /** A plain shell is the engine's shell recipe "Shell" (the component list names original-setup paths a hosted engine does not have). */
  // the engine's name for a recipe (its pane's friendlyName at launch): the one name every tab and reload shows for it
  let recipeNames = null, recipeNamesAt = 0;
  async function recipeName(id) {
    if (!recipeNames || now() - recipeNamesAt > 30000) { const r = await json('/api/recipes').catch(() => null); recipeNames = new Map(((r && r.ok && r.body && r.body.recipes) || []).map((x) => [x.id, x.name])); recipeNamesAt = now(); }
    return recipeNames.get(id) || null;
  }
  /** The engine's name for a running pane (its table row's friendlyName, else its recipe's name). */
  async function paneName(paneid) {
    const r = await json('/api/table');
    const row = r.ok && r.body && Array.isArray(r.body.sessions) ? r.body.sessions.find((x) => x && x.paneid === paneid) : null;
    if (row && row.friendlyName) return String(row.friendlyName).slice(0, 60);
    const m = /^recipe:([^#]+)/.exec(paneid); return (m && (await recipeName(m[1]))) || '';
  }
  async function shellRecipe() {
    if (shellId) return shellId;
    const r = await json('/api/recipes');
    const rows = r.ok && r.body && Array.isArray(r.body.recipes) ? r.body.recipes : [];
    const have = rows.find((x) => x && x.vendor === 'cli-manager' && x.name === 'Shell');
    if (have) { shellId = have.id; return shellId; }
    const t = await target();
    if (!t) return null;
    const made = await post('/api/recipes', { name: 'Shell', target: t, vendor: 'cli-manager', projectDir: null });
    shellId = made.ok && made.body && made.body.recipe ? made.body.recipe.id : null;
    return shellId;
  }
  /** The Shell pane that is already running on the engine (the table lists it), so a page load reattaches instead of starting another. */
  async function liveShellPane(rid) {
    const r = await json('/api/table');
    const rows = r.ok && r.body && Array.isArray(r.body.sessions) ? r.body.sessions : [];
    const mine = rows.find((x) => x && typeof x.paneid === 'string' && x.paneid.startsWith('recipe:' + rid) && x.state === 'live');
    return mine && ID.test(mine.paneid) ? mine.paneid : null;
  }
  async function launchRecipe(rid, extra) {
    const r = await post('/api/recipes/' + encodeURIComponent(rid) + '/launch', { target: 'tab', ...extra });
    if (!r.ok || !r.body || typeof r.body.paneid !== 'string') {
      const why = r.body && typeof r.body.error === 'string' ? r.body.error : 'The server would not start it.';
      return { error: r.status === 409 ? why : why };
    }
    return { paneid: r.body.paneid };
  }
  async function seatPane(room, seat) {
    const r = await json('/api/rooms/' + encodeURIComponent(String(room)) + '?art=ref');
    const seats = r.ok && r.body && Array.isArray(r.body.seats) ? r.body.seats : [];
    const st = seats.find((x) => x && String(x.id) === String(seat));
    const id = st && st.occupant && typeof st.occupant.id === 'string' ? st.occupant.id : null;
    return id && ID.test(id) ? id : null;
  }
  const permitOk = (token) => {
    for (const [k, exp] of permits) if (exp < now()) permits.delete(k);
    if (typeof token !== 'string' || !permits.has(token)) return false;
    permits.delete(token);
    return true;
  };

  handle('session:permit', async () => { const t = hex(); permits.set(t, now() + PERMIT_MS); if (permits.size > 50) permits.delete(permits.keys().next().value); return t; });

  /** A reload re-adopts what is running: each live plain recipe pane not already open in this page becomes a tab (held until attached). */
  async function adoptRunning() {
    let rows = [];
    try { const r = await json('/api/table'); rows = r.ok && r.body && Array.isArray(r.body.sessions) ? r.body.sessions : []; } catch (e) { return; }
    for (const x of rows) {
      if (!x || typeof x.paneid !== 'string' || x.state !== 'live' || !/^recipe:[A-Za-z0-9._-]+$/.test(x.paneid) || byPane.has(x.paneid)) continue;
      const s = { sid: nextSid++, paneid: x.paneid, title: String(x.friendlyName || x.agent || 'Terminal').slice(0, 120), name: String(x.friendlyName || '').slice(0, 60), hue: hueOf(x.friendlyName),  folder: typeof x.project === 'string' ? x.project : '~', recipeId: x.paneid.slice('recipe:'.length),
        term: false, termOf: null, shell: false, controlOnOpen: false, launchRecipe: x.paneid.slice('recipe:'.length), ready: false, ended: false, controlling: false, flowing: false, holding: true, queue: [], cols: 0, rows: 0,
        created: now(), lastInput: 0, expectReplay: false, takeWaiters: [], route: null };
      s.route = { state: 'connecting', route: 'broker', serverId: 'local', serverName: 'the server', login: '', since: now(), recipeId: s.recipeId };
      sessions.set(s.sid, s); bind(s);
      ensureLink().send(attachFrame(s, { intent: 'reclaim', reattachOnly: true }));
      emit('session:adopt', { sid: s.sid, title: s.title, name: s.name, hue: s.hue, snapshot: null, dropX: null }); // held until the page says session:attached
    }
    broadcast();
  }

  handle('session:create', async ([a]) => {
    const cols = a && Number.isInteger(a.cols) ? a.cols : 0;
    const rows = a && Number.isInteger(a.rows) ? a.rows : 0;
    const spec = a && a.spec && typeof a.spec === 'object' ? a.spec : {};
    const term = spec.route === 'term';
    const attachOnly = spec.attachOnly === true && typeof spec.bsid === 'string';
    const s = { sid: 0, paneid: '', title: 'Terminal', name: '', hue: HUE, folder: typeof spec.folder === 'string' ? spec.folder : '~', recipeId: null, term, termOf: null, shell: false, controlOnOpen: false,
      ready: false, ended: false, controlling: false, flowing: false, holding: true, queue: [], cols, rows, created: now(), lastInput: 0, expectReplay: false, takeWaiters: [], route: null };
    let frame;
    if (term) {
      if (!spec.room || !spec.seat) return { error: 'Choose a seat to watch.' };
      const paneid = await seatPane(spec.room, spec.seat).catch(() => null);
      if (!paneid) return { error: "That seat isn't running." };
      s.paneid = paneid; s.controlOnOpen = spec.controlOnOpen === true;
      s.termOf = { roomId: String(spec.room), seatId: String(spec.seat), handle: String(spec.handle || ''), roomName: String(spec.roomName || '') };
      frame = attachFrame(s, { intent: s.controlOnOpen ? 'reclaim' : 'view', reattachOnly: true });
    } else if (spec.spawnPane && typeof spec.spawnPane.paneid === 'string') {
      // a room seat's Start on a hosted engine: the engine bound the seat to a pane and answered placement "browser": the pane is spawned only when a viewer
      // attaches WITH spawn, and its doorbell works only while one stays attached. This is that viewer; the seat's launch already happened.
      if (!permitOk(a && a.permit)) return { error: 'a CLI starts only from an explicit launch' };
      const pid = spec.spawnPane.paneid, rid = typeof spec.spawnPane.recipe === 'string' ? spec.spawnPane.recipe : '';
      if (!ID.test(pid) || !/^[A-Za-z0-9_-]{1,80}$/.test(rid)) return { error: 'Choose a seat to start.' };
      const have = byPane.get(pid);
      if (have && have.size) { const sid0 = [...have][0]; const e0 = sessions.get(sid0); if (e0 && !e0.ended) return { sid: sid0, title: e0.title, name: e0.name, hue: e0.hue, route: e0.route }; } // Start again: this page is already attached
      s.paneid = pid; s.recipeId = rid; s.launchRecipe = rid;
      s.name = (await recipeName(rid).catch(() => null)) || ''; s.hue = hueOf(s.name);
      frame = attachFrame(s, { recipe: rid, spawn: true });
    } else if (attachOnly) {
      if (!ID.test(spec.bsid)) return { error: 'Choose a session to open.' };
      s.paneid = spec.bsid;
      s.name = await paneName(s.paneid).catch(() => ''); s.hue = hueOf(s.name);
      frame = attachFrame(s, { intent: 'reclaim', reattachOnly: true });
    } else {
      const startup = !(a && a.permit) && a && a.why === 'startup' && !startupUsed && !(spec.recipeId);
      if (startup) { startupUsed = true; startupTerminal = true; }
      else if (!permitOk(a && a.permit)) return { error: 'a CLI starts only from an explicit launch' };
      let rid = typeof spec.recipeId === 'string' && spec.recipeId ? spec.recipeId : null;
      if (!rid) { rid = await shellRecipe().catch(() => null); s.shell = true; }
      if (!rid) return { error: 'This server has no shell to start yet.' };
      s.recipeId = s.shell ? null : rid;
      s.launchRecipe = rid;
      s.name = (await recipeName(rid).catch(() => null)) || (s.shell ? 'Shell' : ''); s.hue = hueOf(s.name);
      const running = startup ? await liveShellPane(rid).catch(() => null) : null;
      if (running) {
        s.paneid = running; // the page-load terminal is the shell that is already there: reclaim it, never spawn another
        frame = attachFrame(s, { intent: 'reclaim', reattachOnly: true });
      } else {
        const extra = {};
        if (typeof spec.resumeSessionId === 'string') extra.resumeSessionId = spec.resumeSessionId;
        const l = await launchRecipe(rid, extra).catch(() => ({ error: "Couldn't reach the server." }));
        if (l.error) return { error: l.error };
        s.paneid = l.paneid;
        frame = attachFrame(s, { recipe: rid, spawn: true });
      }
    }
    s.sid = nextSid++;
    s.route = { state: 'connecting', route: term ? 'term' : 'broker', serverId: 'local', serverName: 'the server', login: '', since: now(), ...(s.recipeId ? { recipeId: s.recipeId } : {}), ...(term ? { handle: s.termOf.handle, roomName: s.termOf.roomName } : {}) };
    sessions.set(s.sid, s); bind(s);
    ensureLink().send(frame);
    if (cols > 0 && rows > 0) link.send({ type: 'resize', paneid: s.paneid, cols, rows });
    broadcast();
    defer(() => release(s)); // the page maps the id first, then the first bytes
    if (startupTerminal) { startupTerminal = false; void adoptRunning(); }
    return { sid: s.sid, title: s.title, name: s.name, hue: s.hue, route: s.route };
  });

  const of = (sid) => sessions.get(sid) || null;
  api.on('session:input', ([a]) => {
    const s = a && of(a.sid);
    if (!s || typeof a.data !== 'string') return;
    s.lastInput = now();
    if (s.ready && !s.controlling && !s.term) return; // watching: the strip above the terminal says so; nothing is sent, nothing queued
    if (!s.ready || !s.controlling || !link || !link.send({ type: 'input', paneid: s.paneid, data: a.data })) { if (!s.term) emit('session:typing-paused', { sid: s.sid }); }
  });
  api.on('session:resize', ([a]) => {
    const s = a && of(a.sid);
    if (!s || !(a.cols > 0) || !(a.rows > 0)) return;
    s.cols = Math.floor(a.cols); s.rows = Math.floor(a.rows);
    if (link && s.ready && s.controlling) link.send({ type: 'resize', paneid: s.paneid, cols: s.cols, rows: s.rows });
  });
  api.on('session:attached', ([a]) => {
    const s = a && of(a.sid);
    if (!s) return;
    if (a.cols > 0 && a.rows > 0) { s.cols = a.cols; s.rows = a.rows; if (link && s.ready && s.controlling) link.send({ type: 'resize', paneid: s.paneid, cols: s.cols, rows: s.rows }); }
    release(s);
  });
  api.on('session:close', ([sid]) => {
    const s = of(sid);
    if (!s) return;
    sessions.delete(s.sid); unbind(s);
    if (!s.term && !s.ended) void post('/api/sessions/' + encodeURIComponent(s.paneid) + '/end', {}).catch(() => {}); // a started pane ends; a seat's CLI keeps running
    broadcast();
  });
  api.on('session:title', ([a]) => { const s = a && of(a.sid); if (s && typeof a.title === 'string' && a.title) { s.title = a.title.slice(0, 120); broadcast(); } });
  api.on('session:meta', ([a]) => {
    const s = a && of(a.sid);
    if (!s) return;
    s.name = String(a.name || '').slice(0, 60);
    const h = Math.round(Number(a.hue));
    if (!Number.isNaN(h)) s.hue = Math.max(0, Math.min(360, h));
    broadcast();
  });
  api.on('session:seen', ([a]) => { const s = a && of(a.sid); if (s && link && s.ready && typeof a.how === 'string') link.send({ type: 'attention.ack', paneid: s.paneid, how: a.how.slice(0, 20) }); });
  api.on('session:open', () => {}); // no hidden sessions in a page: every session is open in it
  api.on('session:retry', ([a]) => { void retry(a).catch(() => {}); });
  async function retry(a) {
    const s = a && of(a.sid);
    if (!s || s.term) return;
    if (permitOk(a.permit) && s.launchRecipe) {
      const l = await launchRecipe(s.launchRecipe, a.fresh === true ? { fresh: true } : {}).catch(() => ({ error: "Couldn't reach the server." }));
      if (l.error) { routeOf(s, { state: 'spawn-failed', message: l.error }); return; }
      unbind(s); s.paneid = l.paneid; bind(s); s.ended = false; s.holding = false;
      routeOf(s, { state: 'connecting', since: now() });
      ensureLink().send(attachFrame(s, { recipe: s.launchRecipe, spawn: true }));
      return;
    }
    if (link && !s.ended) reattach(s); // no permit: only reattach to what is still there, never spawn
  }
  handle('session:term-control', async ([a]) => {
    const s = a && of(a.sid);
    if (!s || !s.term || !link) return false;
    if (a.take !== true) return false; // /pty has no release frame; letting go means closing the pane
    if (s.controlling) return true;
    return new Promise((resolve) => {
      const t = setTimeout(() => { s.takeWaiters = s.takeWaiters.filter((f) => f !== done); resolve(false); }, TAKE_MS);
      const done = (v) => { clearTimeout(t); resolve(v); };
      s.takeWaiters.push(done);
      link.send({ type: 'takeControl', paneid: s.paneid, label: label(), id: hex() });
    });
  });
  /** Take the keyboard here: true once the engine says this tab holds it. */
  function take(s) {
    if (!s || s.term || !link) return Promise.resolve(false);
    if (s.controlling) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => { s.takeWaiters = s.takeWaiters.filter((f) => f !== done); resolve(false); }, TAKE_MS);
      const done = (v) => { clearTimeout(t); resolve(v); };
      s.takeWaiters.push(done);
      link.send({ type: 'takeControl', paneid: s.paneid, label: label(), id: hex() });
    });
  }
  api.expose('terminal', {
    onControl(fn) { controlFns.add(fn); for (const s of sessions.values()) if (s.ready) control(s); return () => controlFns.delete(fn); },
    state: (sid) => { const s = sessions.get(sid); return s ? controlState(s) : null; },
    takeControl: (sid) => take(sessions.get(sid)),
  });
  // For code that drives a terminal itself (the Concierge dock): the same permit + create the desktop channels use, in one call each, so
  // there is no second transport. Both return what session:create returns: {sid, route} or {error}. launch() starts the chosen recipe
  // (an explicit launch, never a reload); attach() opens an EXISTING pane by its engine id and never spawns.
  const create = async (spec, { cols = 100, rows = 30, why = 'launch' } = {}) => handlers.get('session:create')([{ cols, rows, spec, permit: await handlers.get('session:permit')([], {}), why }], {});
  api.expose('sessions', {
    // a hosted room seat's Start: spawn the seat's pane through this page's /pty link and keep it attached; {sid, route} or {error}
    spawnSeat: (paneid, recipeId, opts) => (typeof paneid === 'string' && paneid && typeof recipeId === 'string' && recipeId ? create({ route: 'local', spawnPane: { paneid, recipe: recipeId } }, opts) : Promise.resolve({ error: 'Choose a seat to start.' })),
    // lets go of this page's record of a session WITHOUT ending the pane (session:close ends a pane the person started)
    release(sid) { const s = sessions.get(sid); if (!s) return false; sessions.delete(s.sid); unbind(s); broadcast(); return true; },
  });
  return { dispose() { if (link) link.close(); link = null; sessions.clear(); byPane.clear(); } }; // for tests; the runtime ignores a return value
}

module.exports = { register, PERMIT_MS, tabLabel };
