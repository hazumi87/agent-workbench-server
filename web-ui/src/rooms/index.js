'use strict';
// Rooms (W1, Workrooms read): the room-service client the Workrooms tab reads through. All room traffic
// goes through here, in the main process (the engine has no CORS); the renderer gets a narrow preload
// API (status, sign in/out, list, room, line, seen, visible) and broadcasts, never a socket or a cookie.
//
// Sign-in is the tab's own (ROOMS-API.md §1.3): POST /login, the two identity cookies kept through
// safeStorage (never the password), no Authorization header; signing out clears them. The realm identity
// replaces this at step 6. Live updates ride the /pty socket (./live.js, allowlisted); after every
// (re)connect the followed set is sent again and the line is backfilled with since=<newest id>.
// Presence is not pushed: the shown room is polled every 2.5 s, only while the Workrooms tab shows.
//
// A FOLDER OF ITS OWN: this and src/renderer/rooms/ move together when the
// room service becomes a broker module at step 6. Nothing here reaches into the CLI Manager.

const { ipcMain, net, safeStorage, dialog, BrowserWindow, app } = require('electron');
const fs = require('fs');
const path = require('path');
const { createClient, cookieHeader } = require('./client');
const { createLive, tasksBroadcast } = require('./live'); // tasksBroadcast: Tasks seam S5, via live.js so index.js keeps its dependency list
const { profilePicture, profilePictureKey } = require('./user-picture');

const POLL_ROOM_MS = 2500; // presence, the shown room, while the tab shows
const POLL_LIST_MS = 15000; // the cards, while All rooms shows
const POLL_LINE_MS = 5000; // the line, while push is unavailable (the "polling" strip)
const RETRY_MS = [10000, 20000, 40000, 60000];
const OFFLINE_PROBE_MS = 5000; // offline: a quiet probe (no countdown on the strip) until the network answers // "Trying again in 10 s", doubling up to 1 min
const PAGE = 50; // "50 at a time"
const VISIBLE_CACHE_ROWS = 300;
const HIDDEN_CACHE_ROWS = 120;
const UNREAD_KINDS = new Set(['chat', 'attachment', 'voice']);
// a picked file's type, from its extension (the room service stores what it is told)
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', txt: 'text/plain', md: 'text/markdown', json: 'application/json', pdf: 'application/pdf', zip: 'application/zip', csv: 'text/csv', html: 'text/html', log: 'text/plain' };
const mimeOf = (name) => MIME[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';

function init(ctx) {
  const ipcMain = ctx.ipcMain || require('electron').ipcMain;
  const localMode = ctx.localMode === true;
  let authEpoch = 0;
  let suspended = false;
  const dir = ctx.dir;
  const cause = ctx.cause || (() => {});
  const broadcast = ctx.broadcast || (() => {});

  // ---- the cookies (safeStorage; the same keychain rule as accounts/index.js)
  const secPath = path.join(dir, 'rooms.secrets');
  let memSecrets = null;
  if (process.env.WB_SELFTEST && process.platform === 'linux' && safeStorage.setUsePlainTextEncryption) {
    safeStorage.setUsePlainTextEncryption(true);
  }
  const keychain = () => {
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        return false;
      }
      const backend = process.platform === 'linux' && safeStorage.getSelectedStorageBackend ? safeStorage.getSelectedStorageBackend() : 'os';
      return backend !== 'basic_text' || !!process.env.WB_SELFTEST;
    } catch (e) {
      return false;
    }
  };
  function readCookies() {
    if(localMode)return null;
    if (!keychain()) {
      return memSecrets;
    }
    try {
      const j = JSON.parse(safeStorage.decryptString(fs.readFileSync(secPath)));
      return j && j.cookies ? j.cookies : null;
    } catch (e) {
      return null;
    }
  }
  function writeCookies(cookies) {
    if(localMode)return; // Per-launch credentials never enter safeStorage or a file.
    if (!cookies) {
      memSecrets = null;
      try {
        fs.rmSync(secPath, { force: true });
      } catch (e) {
        // gone already
      }
      return;
    }
    if (!keychain()) {
      memSecrets = cookies; // no keychain: this run only, never written in the clear
      cause('rooms-keychain-missing', {});
      return;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(secPath, safeStorage.encryptString(JSON.stringify({ cookies })), { mode: 0o600 });
  }
  let cookies = readCookies();

  // ---- A1's state (the quiet sign-in below, after sign in / out)
  let realm = ctx.realm || null; // { ticket(), signedInAt() } (main, from the accounts module), or null in mode A
  const autoPath = path.join(dir, 'rooms-auto.json');
  let auto = (() => {
    try {
      const j = JSON.parse(fs.readFileSync(autoPath, 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch (e) {
      return {};
    }
  })();
  function writeAuto(patch) {
    auto = { ...auto, ...patch };
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(autoPath, JSON.stringify(auto), { mode: 0o600 });
    } catch (e) {
      // kept in memory for this run
    }
  }
  let autoNote = null; // not-linked | off | unreachable | not-allowed | no-account
  let autoBusy = null;
  let lastExchange = 0;
  let renewTimer = null;
  const RENEW_EARLY_MS = 10 * 60 * 1000;
  let exchangeGapMs = 60 * 1000; // a session refused within a minute of its exchange gets no second try
  const SESSION_MS = 8 * 60 * 60 * 1000;


  // ---- the server address: the build's config (package.json workbench.roomsServer), the self-test's env
  let server = process.env.WB_ROOMS_URL || ctx.server || '';
  const client = createClient({ base: server, cookies: () => cookies, localMode });

  // ---- state
  let conn = 'signed-out'; // signed-out | live | polling | offline | down
  let retryN = 0;
  let retryTimer = null;
  let retryAt = 0;
  let pictureData = null;
  let me = null; // { handle, name, hiddenRooms, color } (A4: your own color, null until chosen)
  const colorOrNull = (c) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : null);
  let rooms = []; // room views from GET /api/rooms (room, seats, family, last, unread, …)
  let listEtag = null;
  const lines = new Map(); // roomId -> { byId: Map, ids: number[] (ascending), hasOlder: bool }
  let visible = { tab: false, roomId: null };
  let pollTimer = null;
  let lineTimer = null;
  let liveOpen = false;
  let listedOnce = false;
  let serverHost = '';
  try {
    serverHost = new URL(server).host;
  } catch (e) {
    serverHost = '';
  }

  const live = createLive({
    url: () => client.wsUrl(),
    cookie: () => localMode ? client.currentCookie() : cookieHeader(cookies),
    onOpen: async (kept) => {
      liveOpen = true;
      cause('rooms-live', { rooms: kept.length });
      setConn('live');
      stopLinePoll();
      // no resume token: backfill every followed room from its newest id
      for (const id of kept) {
        await backfill(id).catch(() => {});
      }
    },
    onClose: (why) => {
      const was = liveOpen;
      liveOpen = false;
      if (conn === 'signed-out') {
        return;
      }
      cause('rooms-live-closed', { why, was });
      scheduleReconnect();
    },
    onEvent: (msg) => onLiveEvent(msg),
  });

  // Account-local subscription preferences, partitioned by server address. No
  // room/seat state or server read cursor is changed by this switch.
  const connectionPath = path.join(dir, 'rooms-connections.json');
  let connections = {};
  try { const saved = JSON.parse(fs.readFileSync(connectionPath, 'utf8')); if (saved && typeof saved === 'object' && !Array.isArray(saved)) connections = saved; } catch {}
  const connectionEpochs = new Map();
  const disconnectedIds = () => Array.isArray(connections[client.base()]) ? connections[client.base()] : [];
  const disconnected = id => disconnectedIds().includes(String(id));
  function roomFence(id) {
    const base = client.base(), epoch = connectionEpochs.get(String(id));
    const check = () => {
      if (disconnected(id) || base !== client.base() || epoch !== connectionEpochs.get(String(id))) {
        throw Object.assign(new Error('Room disconnected. Reconnect from its ⋯ menu.'), { code: 'room-disconnected' });
      }
    };
    check();
    return check;
  }
  function requestFence(method, p) {
    const match = /^\/api\/rooms\/([^/?]+)(.*)$/.exec(p);
    // Rename remains available in the disconnected room's menu.
    return match && !(method === 'PATCH' && !match[2]) ? roomFence(decodeURIComponent(match[1])) : () => {};
  }
  function connection(id, connected) {
    id = String(id);
    if (!rooms.some(v => String(v.room?.id) === id)) throw new Error('Room is unavailable');
    if (typeof connected !== 'boolean') throw new Error('Expected connected state');
    if (disconnected(id) === !connected) return status();
    const ids = new Set(disconnectedIds());
    connected ? ids.delete(id) : ids.add(id);
    const next = { ...connections, [client.base()]: [...ids] };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(connectionPath, JSON.stringify(next), { mode: 0o600 });
    connections = next;
    connectionEpochs.set(id, (connectionEpochs.get(id) || 0) + 1);
    lines.delete(id);
    listEtag = null;
    subscribeAll();
    restartPoll();
    broadcast('rooms:status', status());
    if (connected) list({ force: true }).catch(() => {});
    return status();
  }

  // ---- the strip state
  function status() {
    return {
      present: true,
      localMode,
      server: localMode ? '' : serverHost,
      origin: (() => {
        if(localMode)return '';
        try {
          return new URL(client.base()).origin; // C9: the room page's address for a copied line link
        } catch (e) {
          return '';
        }
      })(),
      serverName: localMode ? 'This computer' : String(ctx.serverName || '') || serverHost,
      signedIn: !!cookies,
      // A1: why the quiet sign-in didn't happen (the design 's five lines), and the engine's account page
      note: autoNote,
      accountPage: (() => {
        if(localMode)return '';
        try {
          return new URL('/account.html', client.base()).href;
        } catch (e) {
          return '';
        }
      })(),
      conn,
      retryAt: conn === 'down' ? retryAt : 0,
      me,
      dropped: live.counts().dropped,
      disconnectedRooms: [...disconnectedIds()],
    };
  }
  function setConn(next) {
    if (next === conn) {
      return;
    }
    conn = next;
    cause('rooms-conn', { conn });
    broadcast('rooms:status', status());
  }
  let testOffline = false; // the self-test's hand: "you're offline" without pulling the cable
  function online() {
    if (testOffline) {
      return false;
    }
    try {
      return net.isOnline();
    } catch (e) {
      return true;
    }
  }

  /** One request with the shared outcome handling: 401/302 = signed out, unreachable = offline/down. */
  async function call(method, p, opts) {
    const checkRoom = requestFence(method, p);
    if (!cookies) {
      throw Object.assign(new Error('signed out'), { code: 'signed-out' });
    }
    let r;
    try {
      r = await client.request(method, p, opts);
    } catch (e) {
      if(localMode&&e.code==='account-changed')throw e;
      if (method === 'GET') checkRoom();
      const off = !online();
      if (off) {
        setConn('offline');
        scheduleReconnect(); // a probe every 5 s: back online, the waiting lines go out even with the tab hidden
      } else {
        setConn('down');
        scheduleReconnect();
      }
      throw Object.assign(new Error(e.message || 'unreachable'), { code: off ? 'offline' : e.code || 'unreachable' });
    }
    if (method === 'GET') checkRoom(); // a late read must never restore a disconnected cache
    if (r.status === 401 || r.status === 302) {
      signedOut('auth');
      quietSignIn('expired').catch(() => {}); // A1: one quiet try; a refusal leaves the sign-in card
      throw Object.assign(new Error('signed out'), { code: 'signed-out', status: r.status });
    }
    if (r.status === 403 && r.json && r.json.mustChangePassword) {
      signedOut('password');
      throw Object.assign(new Error('set a password first'), { code: 'signed-out', status: 403 });
    }
    if (conn === 'down' || conn === 'offline') {
      setConn(liveOpen ? 'live' : 'polling');
    }
    return r;
  }

  function signedOut(why) {
    cause('rooms-signed-out', { why });
    cookies = null;
    if(localMode)client.setLocalSession(null);
    writeCookies(null);
    me = null;
    pictureData = null;
    rooms = [];
    listEtag = null;
    lines.clear();
    live.close();
    liveOpen = false;
    clearTimeout(retryTimer);
    retryTimer = null;
    stopLinePoll();
    setConn('signed-out');
    broadcast('rooms:rooms', { rooms: [] });
  }

  function scheduleReconnect() {
    if (suspended) return;
    if (retryTimer || !cookies) {
      return;
    }
    const wait = conn === 'down' ? RETRY_MS[Math.min(retryN, RETRY_MS.length - 1)] : conn === 'offline' ? OFFLINE_PROBE_MS : 1000;
    retryAt = Date.now() + wait;
    if (conn === 'down') {
      retryN += 1;
      broadcast('rooms:status', status());
    }
    retryTimer = setTimeout(() => {
      retryTimer = null;
      resume().catch(() => {});
    }, wait);
  }

  /** After a sign-in, at start with cookies, and on every retry: the list, then the socket. */
  async function resume() {
    if (suspended) return;
    if (!cookies) {
      return;
    }
    try {
      await list({ force: true });
    } catch (e) {
      return; // call() set the strip and the retry
    }
    if (suspended || !cookies) return;
    retryN = 0;
    if (!liveOpen) {
      setConn('polling');
      startLinePoll();
      subscribeAll();
      live.connect();
    }
  }

  let followed = '';
  /** The socket follows every open room (ROOMS-API.md §2.2: a full-set replace); sent again when the set changes. */
  function subscribeAll() {
    const ids = rooms.filter((v) => v.room && v.room.state !== 'archived' && !disconnected(v.room.id)).map((v) => String(v.room.id)).sort();
    const key = ids.join('\n');
    if (key !== followed || !liveOpen) {
      followed = key;
      live.subscribe(ids);
    }
  }

  // ---- reads
  async function list({ force } = {}) {
    const r = await call('GET', '/api/rooms?art=ref', { etag: force ? null : listEtag });
    if (r.status === 304) {
      return rooms;
    }
    if (r.status !== 200 || !Array.isArray(r.json)) {
      throw Object.assign(new Error('rooms list ' + r.status), { code: 'bad-answer', status: r.status });
    }
    listEtag = r.etag;
    rooms = r.json.map(v => disconnected(v.room?.id) ? (rooms.find(old => old.room?.id === v.room.id) || v) : v);
    const accessible = new Set(rooms.filter((v) => v.room).map((v) => String(v.room.id)));
    for (const id of lines.keys()) {
      if (!accessible.has(String(id))) lines.delete(id);
    }
    listedOnce = true;
    subscribeAll(); // a room that appeared since the socket opened is followed from now on
    if (!me) {
      try {
        const current = roomCopyFence();
        const m = await call('GET', '/api/rooms/me');
        if (!current()) return rooms;
        pictureData = m.status === 200 ? profilePicture(m.json?.picture) : null;
        me = m.status === 200 && m.json ? { handle: m.json.handle || null, name: m.json.name || null, hiddenRooms: Array.isArray(m.json.hiddenRooms) ? m.json.hiddenRooms : [], color: colorOrNull(m.json.color), tones: m.json.tones || {}, enterSubmits: typeof m.json.enterSubmits === 'boolean' ? m.json.enterSubmits : undefined, pictureKey: profilePictureKey(pictureData) } : null;
      } catch (e) {
        me = null;
      }
    }
    broadcast('rooms:rooms', { rooms });
    broadcast('rooms:status', status());
    return rooms;
  }

  async function room(id) {
    const r = await call('GET', '/api/rooms/' + encodeURIComponent(id) + '?art=ref');
    if (r.status === 404) {
      return null;
    }
    if (r.status !== 200 || !r.json) {
      throw Object.assign(new Error('room ' + r.status), { code: 'bad-answer', status: r.status });
    }
    const i = rooms.findIndex((v) => v.room && v.room.id === id);
    if (i >= 0) {
      rooms[i] = { ...rooms[i], ...r.json };
    }
    return r.json;
  }

  function cacheFor(id) {
    let c = lines.get(id);
    if (!c) {
      c = { byId: new Map(), ids: [], hasOlder: true, newest: 0 };
      lines.set(id, c);
    }
    return c;
  }
  // This cache is only a bounded transport convenience, never the server's history.
  // Keep the singleton's existing visibility hint; it does not own other windows.
  function trimCache(id, c) {
    const cap = visible.tab && visible.roomId === id ? VISIBLE_CACHE_ROWS : HIDDEN_CACHE_ROWS;
    if (c.ids.length <= cap) return;
    const drop = Math.min(c.ids.length, Math.ceil((c.ids.length - cap) / PAGE) * PAGE);
    for (const entryId of c.ids.splice(0, drop)) c.byId.delete(entryId);
  }
  function normalize(e) {
    const out = { ...e };
    if (typeof out.meta === 'string') {
      try {
        out.meta = JSON.parse(out.meta);
      } catch (x) {
        out.meta = null;
      }
    }
    return out;
  }
  /** Entries into the room's cache by id (a push, a page and a backfill may carry the same one). */
  function merge(id, entries) {
    if (disconnected(id)) return [];
    const c = cacheFor(id);
    const changed = [];
    for (const raw of entries) {
      const e = normalize(raw);
      if (!Number.isFinite(e.id)) {
        continue;
      }
      c.newest = Math.max(c.newest, e.id); // independent of historical pagination/eviction
      const had = c.byId.get(e.id);
      c.byId.set(e.id, had ? { ...had, ...e, reads: e.reads || had.reads } : e);
      if (!had) {
        c.ids.push(e.id);
      }
      changed.push(c.byId.get(e.id));
    }
    if (changed.length) {
      c.ids.sort((a, b) => a - b);
    }
    trimCache(id, c);
    // Return the requested page/push even when its entries are not retained here.
    return changed;
  }
  function newestId(id) {
    const c = lines.get(id);
    return c ? c.newest : 0;
  }

  /** The newest page, or the page before `before`, or everything since `since`. */
  // C3 (the design "Search and filter"): the room service's own search, every word must match, newest first, up to 200
  async function search(id, q, limit) {
    const text = String(q || '').trim().slice(0, 200);
    if (!text) {
      return { q: '', results: [] };
    }
    const n = Math.max(1, Math.min(200, Number(limit) || 200));
    return answer(await call('GET', roomPath(id, 'search') + '?q=' + encodeURIComponent(text) + '&limit=' + n), 'search');
  }
  async function line(id, { before, since, limit } = {}) {
    const n = Math.max(1, Math.min(1000, Number(limit) || PAGE));
    const q = ['limit=' + n];
    if (Number.isFinite(before)) {
      q.push('before=' + before);
    } else if (Number.isFinite(since)) {
      q.push('since=' + since);
    }
    const r = await call('GET', '/api/rooms/' + encodeURIComponent(id) + '/line?' + q.join('&'));
    if (r.status !== 200 || !r.json || !Array.isArray(r.json.entries)) {
      throw Object.assign(new Error('line ' + r.status), { code: 'bad-answer', status: r.status });
    }
    const got = r.json.entries;
    const entries = merge(id, got);
    const c = cacheFor(id);
    if (!Number.isFinite(since) && got.length < n) {
      c.hasOlder = false; // a short page: the start of the room
    }
    return { entries, hasOlder: c.hasOlder, newest: newestId(id) };
  }

  async function backfill(id) {
    if (disconnected(id)) return;
    const from = newestId(id);
    if (!from) {
      return; // nothing held yet: the page loads on open
    }
    let since = from;
    for (let i = 0; i < 50; i++) {
      const r = await line(id, { since, limit: 200 });
      if (r.entries.length) {
        broadcast('rooms:line', { roomId: id, entries: r.entries, why: 'backfill' });
      }
      if (r.entries.length < 200) {
        break;
      }
      since = r.newest;
    }
  }

  async function seen(id, lastId) {
    const r = await call('PUT', '/api/rooms/' + encodeURIComponent(id) + '/seen', { body: { last_seen_line_id: Number(lastId) } });
    if (r.status === 200) {
      const v = rooms.find((x) => x.room && x.room.id === id);
      if (v) {
        v.unread = 0;
        broadcast('rooms:rooms', { rooms });
      }
    }
    return r.status === 200;
  }

  // ---- pushes
  function onLiveEvent(msg) {
    const id = msg.roomId;
    if (id && disconnected(id)) return;
    if (msg.type === 'room.line' && id && msg.entry) {
      const entries = merge(id, [msg.entry]);
      const e = entries[0];
      // the person's own cursor is the server's; between list refreshes the count moves here
      const v = rooms.find((x) => x.room && x.room.id === id);
      if (v && e && UNREAD_KINDS.has(e.kind) && e.author !== 'user' && !(visible.tab && visible.roomId === id)) {
        v.unread = (Number(v.unread) || 0) + 1;
        broadcast('rooms:rooms', { rooms });
      }
      broadcast('rooms:line', { roomId: id, entries, why: 'push' });
    } else if (msg.type === 'room.state' && id && msg.room) {
      const i = rooms.findIndex((x) => x.room && x.room.id === id);
      const next = { room: msg.room, inherited: msg.inherited, seats: msg.seats, actions: msg.actions, panels: msg.panels, voice: msg.voice, voiceGlobal: msg.voiceGlobal, family: msg.family };
      if (i >= 0) {
        rooms[i] = { ...rooms[i], ...next };
      } else {
        rooms.push(next);
      }
      broadcast('rooms:rooms', { rooms });
    } else if (msg.type === 'room.read' && id) {
      const c = lines.get(id);
      const e = c && c.byId.get(Number(msg.entryId));
      if (e) {
        e.reads = { ...(e.reads || {}), [msg.handle]: msg.state };
      }
      broadcast('rooms:read', { roomId: id, entryId: msg.entryId, handle: msg.handle, state: msg.state });
    } else if ((msg.type === 'room.held' || msg.type === 'room.waiting') && id) {
      broadcast('rooms:seat', { roomId: id, seatId: msg.seatId, handle: msg.handle, held: msg.held, waiting: msg.waiting });
    } else if (msg.type === 'room.tasks') {
      // Tasks seam S5: ids only, the family from OUR rooms cache, never from the frame; anything else is dropped
      const p = tasksBroadcast(msg, rooms);
      if (p) broadcast('rooms:tasks', p);
    } else if (msg.type === 'room.scratchpad' && id) {
      // W2: this person's notes and assets counts, or "changed" (re-read): the Notes · Assets column follows
      broadcast('rooms:scratchpad', { roomId: id, counts: msg.counts || null, changed: !!msg.changed });
    }
  }

  // ---- polling (presence while visible; the line while push is unavailable)
  function restartPoll() {
    if (suspended) return;
    clearInterval(pollTimer);
    pollTimer = null;
    if (!visible.tab || !cookies || disconnected(visible.roomId)) {
      return;
    }
    pollTimer = setInterval(() => {
      if (visible.roomId) {
        room(visible.roomId)
          .then((v) => {
            if (v) {
              broadcast('rooms:room', { roomId: visible.roomId, view: v });
            }
          })
          .catch(() => {});
      } else {
        list().catch(() => {});
      }
    }, visible.roomId ? POLL_ROOM_MS : POLL_LIST_MS);
  }
  function startLinePoll() {
    if (suspended) return;
    if (lineTimer) {
      return;
    }
    lineTimer = setInterval(() => {
      if (liveOpen || !cookies) {
        return;
      }
      for (const id of lines.keys()) {
        backfill(id).catch(() => {});
      }
    }, POLL_LINE_MS);
  }
  function stopLinePoll() {
    clearInterval(lineTimer);
    lineTimer = null;
  }

  // ---- sign in / out
  async function signIn(username, password) {
    if(localMode)return {ok:false,why:'local-session-managed'};
    const epoch = ++authEpoch;
    let r;
    try {
      r = await client.login(username, password);
    } catch (e) {
      cause('rooms-signin', { ok: false, why: e.code || 'unreachable' });
      return { ok: false, why: online() ? 'unreachable' : 'offline' };
    }
    if (suspended || epoch !== authEpoch) return { ok: false, why: 'account-changed' };
    if (!r.ok) {
      cause('rooms-signin', { ok: false, status: r.status });
      return { ok: false, why: r.status === 401 || r.status === 403 ? 'wrong' : 'failed', status: r.status };
    }
    cookies = r.cookies;
    writeCookies(cookies);
    writeAuto({ via: 'password', endsAt: null });
    clearTimeout(renewTimer);
    autoNote = null;
    cause('rooms-signin', { ok: true, remember: !!cookies.homelab_device });
    if (r.mustChangePassword) {
      signedOut('password');
      return { ok: false, why: 'password' };
    }
    conn = 'polling';
    broadcast('rooms:status', status());
    await resume();
    return { ok: true };
  }

  async function signOut() {
    if(localMode)return {ok:false,why:'local-session-managed'};
    authEpoch++;
    const logout = cookies ? client.logout().catch(() => {}) : Promise.resolve();
    // A1 (PM ): after your own Sign out the quiet sign-in stays off until your next account sign-in
    writeAuto({ offAt: realm && realm.signedInAt() ? realm.signedInAt() : null, via: null, endsAt: null });
    clearTimeout(renewTimer);
    autoNote = null;
    signedOut('user');
    await logout;
    return { ok: true };
  }

  // ---- A1, one sign-in (platform , PM  and , the design ). With an account signed in, the
  // main process trades a realm ticket (60 s, from accounts' engineTicket) for an 8 h engine session at
  // /auth/realm/exchange: Workrooms opens signed in. It runs at start without a session, once when a session
  // answers 401, and 10 min before the 8 h end; never in a loop. Any refusal leaves today's sign-in card with
  // one line saying why (`autoNote`). The ticket stays in this process: never a window, a URL or the cause log.
  function scheduleRenew() {
    if(localMode)return;
    if (suspended) return;
    clearTimeout(renewTimer);
    renewTimer = null;
    if (auto.via !== 'realm' || !auto.endsAt) {
      return;
    }
    const wait = Math.min(Math.max(5000, auto.endsAt - RENEW_EARLY_MS - Date.now()), 2 ** 31 - 1);
    renewTimer = setTimeout(() => {
      renewTimer = null;
      quietSignIn('renew').catch(() => {});
    }, wait);
    if (renewTimer.unref) {
      renewTimer.unref();
    }
  }

  function quietSignIn(trigger) {
    if(localMode)return Promise.resolve({ok:false,why:'local-session-managed'});
    if (!autoBusy) {
      const pending = exchangeOnce(trigger).finally(() => {
        if (autoBusy === pending) autoBusy = null;
      });
      autoBusy = pending;
    }
    return autoBusy;
  }

  async function exchangeOnce(trigger) {
    const epoch = authEpoch;
    const stale = () => suspended || epoch !== authEpoch;
    if (stale()) return { ok: false, why: 'account-changed' };
    const refuse = (why, shown) => {
      cause('rooms-auto', { trigger, ok: false, why });
      if (shown && autoNote !== why) {
        autoNote = why;
        broadcast('rooms:status', status());
      }
      return { ok: false, why };
    };
    if (!realm || (realm.present && !realm.present())) {
      return refuse('absent', false); // no accounts module (mode A): today's sign-in, no line
    }
    const at = realm.signedInAt();
    if (!at) {
      return refuse('no-account', true);
    }
    if (auto.offAt && auto.offAt === at) {
      return refuse('signed-out-by-you', false);
    }
    if (trigger === 'expired' && Date.now() - lastExchange < exchangeGapMs) {
      return refuse('too-soon', false);
    }
    let t;
    try {
      t = await realm.ticket();
    } catch (e) {
      t = { status: 0, why: 'unreachable' };
    }
    if (stale()) return { ok: false, why: 'account-changed' };
    if (!t || t.status !== 200 || !t.json || typeof t.json.ticket !== 'string' || !t.json.ticket) {
      const st = t ? t.status : 0;
      const why =
        st === 0 && t && ['no-account', 'no-device', 'no-token', 'signed-out'].includes(t.why)
          ? 'no-account'
          : st === 404
            ? 'off'
            : st === 403 && t.json && t.json.error === 'not-allowed'
              ? 'not-allowed'
              : 'unreachable';
      return refuse(why, true);
    }
    let r;
    try {
      r = await client.exchange(t.json.ticket);
    } catch (e) {
      return refuse('engine-unreachable', false); // the card's own words cover an engine that can't be reached
    }
    if (stale()) return { ok: false, why: 'account-changed' };
    if (!r.ok) {
      const why =
        r.status === 403 && r.field === 'link'
          ? 'not-linked'
          : r.status === 404 || (r.status === 403 && r.field === 'origin')
            ? 'off'
            : r.status === 403 && r.field === 'account'
              ? 'not-allowed'
              : 'unreachable';
      return refuse(why, true);
    }
    lastExchange = Date.now();
    cookies = r.cookies;
    writeCookies(cookies);
    writeAuto({ via: 'realm', endsAt: r.expiresAt || Date.now() + SESSION_MS, offAt: null });
    autoNote = null;
    cause('rooms-auto', { trigger, ok: true });
    if (r.mustChangePassword) {
      signedOut('password');
      return { ok: false, why: 'password' };
    }
    scheduleRenew();
    if (conn === 'signed-out') {
      conn = 'polling';
    }
    broadcast('rooms:status', status());
    await resume();
    return { ok: true };
  }

  /** Main: the account signed in or out. A new sign-in turns the quiet sign-in back on (PM ). */
  function accountChanged() {
    autoNote = null;
    if (!cookies) {
      quietSignIn('account').catch(() => {});
    } else {
      broadcast('rooms:status', status());
    }
  }

  function setVisible(v) {
    visible = { tab: !!(v && v.tab), roomId: v && v.roomId ? String(v.roomId) : null };
    for (const [id, c] of lines) trimCache(id, c);
    restartPoll();
  }

  function setBaseOnly(url) {
    if (!client.setBase(url)) {
      return false;
    }
    server = url;
    try {
      serverHost = new URL(url).host;
    } catch (e) {
      serverHost = '';
    }
    return true;
  }

  /** Chunk 5: a different address is a different engine, so its cookies and cards go (a ticket minted for one
   *  account is never posted to another's engine); the same address changes nothing. */
  function setServer(url, opts) {
    if(localMode)return false; // Only the supervisor can replace this endpoint.
    if (!(opts && opts.switch)) {
      return setBaseOnly(url); // the self-tests' plain address change: no sign-out, no quiet sign-in
    }
    if (client.base() === url) {
      return true;
    }
    const was = client.base();
    if (!client.setBase(url)) {
      client.setBase(was);
      return false;
    }
    server = url;
    try {
      serverHost = new URL(url).host;
    } catch (e) {
      serverHost = '';
    }
    cause('rooms-server', { host: serverHost });
    if (cookies || conn !== 'signed-out') {
      signedOut('server');
    }
    autoNote = null;
    lastExchange = 0;
    writeAuto({ via: null, endsAt: null });
    broadcast('rooms:status', status());
    quietSignIn('server').catch(() => {});
    return true;
  }

  // Trusted main-process entry only; deliberately no IPC handler/preload method.
  function setLocalSession(value) {
    if(!localMode)throw Error('Local room session unavailable');
    ++authEpoch;signedOut('local-engine-changed');
    if(value===null)return;
    client.setLocalSession(value);
    // This is only an authentication presence marker. The cookie stays in client.
    cookies={local:true};conn='polling';autoNote=null;
    broadcast('rooms:status',status());
    void resume().catch(()=>{});
  }

  // ---- IPC (the preload's door)
  const wrap = (fn) => async (e, ...a) => {
    try {
      return { ok: true, value: await fn(...a) };
    } catch (err) {
      return { ok: false, code: err && err.code ? err.code : 'error', message: err && err.message ? err.message : String(err), ...(err && Number.isInteger(err.status) ? { status: err.status } : {}) };
    }
  };
  // Tasks seam S4 step 5 (the design notes revision 7, item 5, C2, C3): a bundled module page's Tasks
  // call, from the app page only. The account comes from the scoped envelope (scoped.js); here: the fixed
  // verb map, main's own catalog and grant (ctx.tasks.admit), the room in THIS client's cache, main's
  // budgets, a main-minted single-use approval for purge, and the window credential. No require here: main
  // hands the pieces in as ctx.tasks (this file is loaded in a vm by tests).
  const tasksRefused = (status, error, field) => ({ ok: false, kind: 'refused', status, error, field: field || null });
  const tasksTransport = () => ({ ok: false, kind: 'transport' });
  const tasksRoomKnown = (id) => rooms.some((v) => v && v.room && v.room.id === id);
  const tasksScope = (e, a, b) => ({ window: e.sender.id, module: String(a.moduleId), gen: a.gen, accountId: typeof ctx.accountId === 'string' ? ctx.accountId : null, // this client's own account (scoped.js)
    selectionVersion: 0, engineEpoch: authEpoch, room: a.roomId, verb: 'purge', taskId: b.taskId });
  /** Revision 11: the room-tasks panel of a room, from THIS client's cache: icon 'tasks' and the room's own view url
   *  (room-tasks' registration); the lowest id when several seats registered one. null when there is none. */
  function roomTasksPanel(roomId) {
    const v = rooms.find((x) => x && x.room && x.room.id === roomId);
    const own = 'http://127.0.0.1:';
    const tail = '/rooms/' + roomId + '/view';
    const ids = (v && Array.isArray(v.panels) ? v.panels : [])
      .filter((p) => p && p.icon === 'tasks' && typeof p.id === 'string' && typeof p.url === 'string' && p.url.startsWith(own) && p.url.endsWith(tail) && /^\d+$/.test(p.url.slice(own.length, -tail.length)))
      .map((p) => p.id).sort();
    return ids[0] || null;
  }
  /** the design : a room-summary answer carries main's own name for the server ("Room Tasks on server"). */
  function withServerName(b, r) {
    if (!b.panel || !r || r.ok !== true || !r.body || typeof r.body !== 'object' || Array.isArray(r.body)) return r;
    let name = '';
    try { name = String(status().serverName || '').slice(0, 60); } catch (e) { name = ''; }
    return { ...r, body: { ...r.body, serverName: name } };
  }
  /** A verb that goes through a panel gets main's panel id in its path, or a 404 reply. */
  function tasksPanel(b, roomId) {
    if (!b.panel) return null;
    const pid = b.panel === 'room-tasks' ? roomTasksPanel(roomId) : null;
    if (!pid) return tasksRefused(404, 'No Room Tasks panel in this room.', 'room');
    b.path = b.path.replace('{panel}', encodeURIComponent(pid));
    return null;
  }
  /** The common checks; → {b} or a reply. */
  function tasksAdmit(e, a) {
    const t = ctx.tasks;
    if (!t || !e || !e.sender || !t.fromAppPage(e)) return { reply: tasksTransport() };
    if (!a || typeof a !== 'object' || typeof a.moduleId !== 'string' || !Number.isSafeInteger(a.gen)) return { reply: tasksRefused(400, 'Not a Tasks call.', 'input') };
    const b = t.verbs.build(a.verb, a.roomId, a.input);
    if (!b.ok) return { reply: tasksRefused(400, b.error, b.field) };
    if (!t.admit(a.moduleId, b.grant)) return { reply: tasksRefused(403, "That tool isn't allowed to do this.", 'verb') };
    if (!cookies || !tasksRoomKnown(a.roomId)) return { reply: tasksRefused(404, 'No such room here.', 'room') };
    const noPanel = tasksPanel(b, a.roomId);
    if (noPanel) return { reply: noPanel };
    return { b };
  }
  async function tasksCall(e, a) {
    const { reply, b } = tasksAdmit(e, a);
    if (reply) return reply;
    if (b.needsApproval && !ctx.tasks.approvals.take(a.approval, tasksScope(e, a, b))) return tasksRefused(403, 'That confirmation has expired. Try again.', 'approval');
    return withServerName(b, await tasksRun(b, a.moduleId, e.sender.id + ':' + String(a.owner || ''), a.input));
  }
  /** The engine call after admission, for rooms:tasks and tasksBound alike: the one shared budget, the window credential. */
  async function tasksRun(b, moduleId, frame, input) {
    const ticket = ctx.tasks.budget.take({ module: moduleId, frame, bytes: Buffer.byteLength(JSON.stringify(input || {}), 'utf8') });
    if (!ticket.ok) return { ok: false, kind: 'slow' };
    try {
      const r = await call(b.method, b.path, b.body ? { body: b.body } : undefined);
      if (r.status >= 200 && r.status < 300) {
        const size = r.text != null ? Buffer.byteLength(String(r.text), 'utf8') : Buffer.byteLength(JSON.stringify(r.json === undefined ? null : r.json), 'utf8');
        return ctx.tasks.budget.replyOk(size) ? { ok: true, status: r.status, body: r.json === undefined ? null : r.json } : tasksTransport();
      }
      if (r.status >= 400 && r.status < 500) {
        const j = r.json && typeof r.json === 'object' ? r.json : {};
        const words = typeof j.error === 'string' && j.error.length > 2 && !/^[a-z_]+$/.test(j.error) ? j.error : typeof j.message === 'string' ? j.message : 'The room refused that.';
        return tasksRefused(r.status, String(words).slice(0, 300), typeof j.field === 'string' ? j.field.slice(0, 40) : null);
      }
      return tasksTransport();
    } catch (err) {
      return tasksTransport();
    } finally {
      ticket.done();
    }
  }
  /**
   * S3 (the design notes revision 9, R9.2): a module window's request, called by main's module-window
   * directly (no IPC event, so no sender is made up and rooms:tasks stays app-page only). scope is main's
   * captured owner: tasksAdmit's checks minus the sender's, delete verbs refused outright (no host-drawn
   * confirmation in a window), and a stale epoch or another account is account-changed.
   */
  async function tasksBound(s, verb, input) {
    const t = ctx.tasks;
    if (!t) return tasksTransport();
    if (!s || typeof s !== 'object' || typeof s.moduleId !== 'string' || typeof s.frame !== 'string' || typeof s.roomId !== 'string') return tasksRefused(400, 'Not a Tasks call.', 'input');
    const mine = typeof ctx.accountId === 'string' ? ctx.accountId : null;
    if (suspended || s.accountId !== mine || s.engineEpoch !== authEpoch) return { ok: false, code: 'account-changed' };
    const b = t.verbs.build(verb, s.roomId, input);
    if (!b.ok) return tasksRefused(400, b.error, b.field);
    if (b.needsApproval || b.grant === 'rooms.tasks.delete') return tasksRefused(403, "Delete from the room's side preview.", 'verb');
    if (!t.admit(s.moduleId, b.grant)) return tasksRefused(403, "That tool isn't allowed to do this.", 'verb');
    if (!cookies || !tasksRoomKnown(s.roomId)) return tasksRefused(404, 'No such room here.', 'room');
    const noPanel = tasksPanel(b, s.roomId);
    if (noPanel) return noPanel;
    try {
      return withServerName(b, await tasksRun(b, s.moduleId, s.frame, input));
    } catch (err) {
      return tasksTransport();
    }
  }
  /** A room as THIS client's cache knows it, for a module window's owner: its family, its name, the live workgroup aliases. */
  function tasksRoom(roomId) {
    if (typeof roomId !== 'string' || !roomId || roomId.length > 128) return null;
    for (const v of rooms) {
      const r = v && v.room;
      if (!r) continue;
      const wgs = v.family && Array.isArray(v.family.workgroups) ? v.family.workgroups : [];
      const g = !r.parent_id ? wgs.find((x) => x && x.id === roomId) : null;
      if (r.id !== roomId && !g) continue;
      const famId = r.id === roomId && r.parent_id ? r.parent_id : r.id;
      const fam = famId === r.id ? v : rooms.find((x) => x && x.room && x.room.id === famId);
      const groups = ((fam && fam.family && fam.family.workgroups) || []).filter((x) => x && x.state !== 'archived' && typeof x.alias === 'string' && x.alias).map((x) => x.alias);
      return { familyId: famId, title: String((g ? g.name : r.name) || ''), groups };
    }
    return null;
  }
  ipcMain.handle('rooms:tasks', async (e, a) => {
    try {
      return await tasksCall(e, a);
    } catch (err) {
      return tasksTransport();
    }
  });
  ipcMain.handle('rooms:tasks-approve', async (e, a) => {
    try {
      const { reply, b } = tasksAdmit(e, a);
      if (reply) return { ok: false, kind: reply.kind, status: reply.status };
      if (!b.needsApproval) return { ok: false, kind: 'refused', status: 400 };
      const token = ctx.tasks.approvals.mint(tasksScope(e, a, b));
      return token ? { ok: true, approval: token } : { ok: false, kind: 'refused', status: 400 };
    } catch (err) {
      return { ok: false, kind: 'transport' };
    }
  });
  ipcMain.handle('rooms:status', () => status());
  ipcMain.handle('rooms:picture', wrap(async () => ({ key: me?.pictureKey || null, picture: cookies ? pictureData : null })));
  ipcMain.handle('rooms:signin', (e, a) => signIn(a && a.username, a && a.password));
  ipcMain.handle('rooms:signout', () => signOut());
  ipcMain.handle('rooms:list', wrap(async (a) => (listedOnce && !(a && a.force) ? rooms : list({ force: true }))));
  ipcMain.handle('rooms:connection', wrap(a => connection(a && a.id, a && a.connected)));
  ipcMain.handle('rooms:room', wrap((a) => room(String(a && a.id))));
  // One structure-only event per line load (short room id, count, result, connection): no payloads.
  ipcMain.handle('rooms:line', wrap(async (a) => {
    const room = String((a && a.id) || '').slice(0, 8);
    try {
      const r = await line(String(a && a.id), a || {});
      cause('rooms-line', { room, ok: true, count: r.entries.length, older: !!r.hasOlder, conn });
      return r;
    } catch (err) {
      cause('rooms-line', { room, ok: false, code: err && err.code ? err.code : 'error', conn });
      throw err;
    }
  }));
  ipcMain.handle('rooms:search', wrap((a) => search(String(a && a.id), a && a.q, a && a.limit)));
  ipcMain.handle('rooms:seen', wrap((a) => seen(String(a && a.id), a && a.lastId)));
  ipcMain.handle('rooms:retry', wrap(async () => {
    clearTimeout(retryTimer);
    retryTimer = null;
    retryN = 0;
    await resume();
    return status();
  }));
  ipcMain.on('rooms:visible', (e, v) => setVisible(v));
  // images come through here as data: URLs (the renderer's CSP allows self and data: only); the thumb
  // route makes webp at 64..512 wide, the raw route the file itself (capped at 12 MB)
  let noThumbEngine = null, noThumbUntil = 0, last415File = null;
  const assetPath = (roomId, name, thumb, w) => '/api/rooms/' + encodeURIComponent(String(roomId)) + '/assets/' + (thumb ? 'thumb/' : 'raw/') + encodeURIComponent(String(name)) + (thumb ? '?w=' + (Number(w) || 256) : '');
  function roomCopyFence() {
    const epoch = authEpoch, credentials = cookies;
    // Keep the originating client/authentication valid through every local I/O
    // await. Checking once before starting a copy does not fence a later logout.
    return () => !suspended && epoch === authEpoch && !!credentials && cookies === credentials;
  }
  async function bytes(roomId, name, thumb, w) {
    if (!cookies) {
      return null;
    }
    const checkRoom = roomFence(roomId);
    const authCurrent = roomCopyFence();
    const current = () => { try { checkRoom(); return authCurrent(); } catch { return false; } };
    const engine = authEpoch + '@' + client.base();
    if (noThumbEngine !== engine) { noThumbEngine = engine; noThumbUntil = 0; last415File = null; }
    const skipThumb = thumb && noThumbEngine === engine && Date.now() < noThumbUntil;
    let r = skipThumb ? { status: 415 } : await client.requestBytes(assetPath(roomId, name, thumb, w));
    checkRoom();
    if (!current()) return null;
    // Local engines may ship without the thumbnail encoder. Both the chat and
    // Assets use this loader; fallback previews have a smaller admission/transport cap.
    if (thumb && !skipThumb && r.status !== 415) last415File = null;
    if (thumb && (r.status === 415 || r.status === 501)) {
      if (!skipThumb) {
        const file = JSON.stringify([String(roomId), String(name)]);
        //415 also means a corrupt/unsupported file, so one file is insufficient evidence.
        if (r.status === 501 || (last415File !== null && last415File !== file)) {
          noThumbUntil = Date.now() + 5 * 60 * 1000; last415File = null;
        } else last415File = file;
      }
      const info = await client.request('HEAD', assetPath(roomId, name, false));
      checkRoom();
      if (!current()) return null;
      const length = info.status === 200 && info.headers?.['content-length'];
      const size = length ? Number(length) : NaN, maxBytes = 1.5 * 1024 * 1024;
      if (!Number.isFinite(size) || size <= 0 || size > maxBytes) return null;
      r = await client.requestBytes(assetPath(roomId, name, false), { maxBytes });
      checkRoom();
      if (!current()) return null;
    }
    if (r.status !== 200 || !r.buffer) {
      return null;
    }
    if (!thumb && current() && ctx.scratchpad) {
      await ctx.scratchpad.asset(roomId, name, r.buffer, r.type, current).catch(() => {});
    }
    return { buffer: r.buffer, type: r.type || 'application/octet-stream' };
  }
  const dataUrl = (b) => (b ? 'data:' + b.type.split(';')[0] + ';base64,' + b.buffer.toString('base64') : null);
  ipcMain.handle('rooms:thumb', wrap(async (a) => dataUrl(await bytes(a.roomId, a.name, true, a.w))));
  ipcMain.handle('rooms:image', wrap(async (a) => dataUrl(await bytes(a.roomId, a.name, false))));
  ipcMain.handle('rooms:download', wrap(async (a, e) => {
    const b = await bytes(a.roomId, a.name, false);
    if (!b) {
      return false;
    }
    if (process.env.WB_SELFTEST) {
      return { bytes: b.buffer.length }; // no dialog in the self-test
    }
    if (ctx.native && typeof ctx.native.saveFile === 'function') return ctx.native.saveFile({ name: String(a.name), type: b.type, buffer: b.buffer }); // the web build: the browser's own download
    const r = await dialog.showSaveDialog({ defaultPath: path.join(app.getPath('downloads'), String(a.name)) });
    if (r.canceled || !r.filePath) {
      return false;
    }
    fs.writeFileSync(r.filePath, b.buffer);
    return true;
  }));
  ipcMain.handle('rooms:open-window', wrap(async (a) => {
    const b = await bytes(a.roomId, a.name, false);
    if (!b) {
      return false;
    }
    if (process.env.WB_SELFTEST) {
      return { bytes: b.buffer.length };
    }
    if (ctx.native && typeof ctx.native.openAsset === 'function') return ctx.native.openAsset({ roomId: a.roomId, name: String(a.name), type: b.type }); // the web build: a tab on the engine's own raw route
    const w = new BrowserWindow({ width: 1000, height: 760, title: String(a.name), webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    w.loadURL(dataUrl(b)).catch(() => {});
    return true;
  }));
  // ---- W2, the write side (ROOMS-API.md §3.2). A person's line never carries `from` (the engine stamps
  // the author); the text goes verbatim (the engine parses @names and /commands); `attachments` are
  // scratch ids uploaded first; a refusal is HTTP 200 with status 'refused'.
  async function callRaw(method, p, buffer, headers) {
    requestFence(method, p);
    if (!cookies) {
      throw Object.assign(new Error('signed out'), { code: 'signed-out' });
    }
    let r;
    try {
      r = await client.requestRaw(method, p, buffer, headers);
    } catch (e) {
      if(localMode&&e.code==='account-changed')throw e;
      const off = !online();
      if (off) {
        setConn('offline');
        scheduleReconnect(); // a probe every 5 s: back online, the waiting lines go out even with the tab hidden
      } else {
        setConn('down');
        scheduleReconnect();
      }
      throw Object.assign(new Error(e.message || 'unreachable'), { code: off ? 'offline' : e.code || 'unreachable' });
    }
    if (r.status === 401 || r.status === 302) {
      signedOut('auth');
      throw Object.assign(new Error('signed out'), { code: 'signed-out', status: r.status });
    }
    return r;
  }
  const roomPath = (id, sub) => '/api/rooms/' + encodeURIComponent(String(id)) + (sub ? '/' + sub : '');
  const answer = (r, what) => {
    if (r.status >= 200 && r.status < 300) {
      return r.json;
    }
    const err = Object.assign(new Error((r.json && (r.json.error || r.json.message)) || what + ' ' + r.status), { code: 'http', status: r.status, field: r.json && r.json.field, body: r.json });
    throw err;
  };
  async function post(id, a) {
    const body = { text: String(a && a.text != null ? a.text : '') };
    if (Number.isFinite(a && a.reply_to)) {
      body.reply_to = Number(a.reply_to);
    }
    if (Array.isArray(a && a.attachments) && a.attachments.length) {
      body.attachments = a.attachments.map(String);
    }
    if (Array.isArray(a && a.links) && a.links.length) {
      body.links = a.links;
    }
    if (a && a.confirm) {
      body.confirm = String(a.confirm);
    }
    if (a && a.keep_draft) {
      body.keep_draft = true;
    }
    const r = await call('POST', roomPath(id, 'line'), { body });
    const j = answer(r, 'post');
    if (j && Array.isArray(j.entries) && j.entries.length) {
      const entries = merge(id, j.entries); // meta parsed, the cache updated
      j.entries = entries;
      broadcast('rooms:line', { roomId: id, entries, why: 'post' });
    }
    cause('rooms-post', { room: id, status: j && j.status, n: j && j.entries ? j.entries.length : 0 });
    return j;
  }
  const draft = async (id) => answer(await call('GET', roomPath(id, 'draft')), 'draft');
  const setDraft = async (id, a) => answer(await call('PUT', roomPath(id, 'draft'), { body: { text: String(a && a.text != null ? a.text : ''), ...(a && 'reply_to' in a ? { reply_to: a.reply_to } : {}) } }), 'draft');
  const scratch = async (id) => answer(await call('GET', roomPath(id, 'scratch')), 'scratch');
  async function scratchUpload(id, a) {
    const buffer = Buffer.isBuffer(a.bytes) ? a.bytes : Buffer.from(a.bytes || []);
    const headers = { 'x-filename': encodeURIComponent(String(a.name || 'file')), 'content-type': String(a.type || 'application/octet-stream') };
    if (a.key) {
      headers['x-upload-key'] = String(a.key);
    }
    if (Number.isFinite(a.pos)) {
      headers['x-upload-pos'] = String(a.pos);
    }
    const current = roomCopyFence();
    const result = answer(await callRaw('POST', roomPath(id, 'scratch'), buffer, headers), 'upload');
    if (current() && ctx.scratchpad) {
      await ctx.scratchpad.asset(id, String(a.name || 'file'), buffer, headers['content-type'], current).catch(() => {});
    }
    return result;
  }
  const scratchRemove = async (id, fileId) => answer(await call('DELETE', roomPath(id, 'scratch/' + encodeURIComponent(String(fileId)))), 'remove');
  const scratchOrder = async (id, ids) => answer(await call('PUT', roomPath(id, 'scratch/order'), { body: { ids: (ids || []).map(String) } }), 'order');
  const assets = async (id) => answer(await call('GET', roomPath(id, 'assets')), 'assets');
  const notes = async (id, q) => answer(await call('GET', roomPath(id, 'notes') + (q ? '?q=' + encodeURIComponent(q) : '?summary=1')), 'notes');
  async function withNoteCopy(id, request) {
    const current = roomCopyFence();
    const result = answer(await request(), 'note');
    if (current() && ctx.scratchpad && typeof result?.note?.text === 'string' && result.note.text.trim()) {
      await ctx.scratchpad.note(id, result.note, current).catch(() => {});
    }
    return result;
  }
  const note = async (id, nid) => withNoteCopy(id, () => call('GET', roomPath(id, 'notes/' + encodeURIComponent(String(nid)))));
  const noteCreate = async (id, text) => withNoteCopy(id, () => call('POST', roomPath(id, 'notes'), { body: { text: String(text || '') } }));
  const noteSet = async (id, nid, text) => withNoteCopy(id, () => call('PUT', roomPath(id, 'notes/' + encodeURIComponent(String(nid))), { body: { text: String(text || '') } }));
  const noteAttach = async (id, nid) => answer(await call('POST', roomPath(id, 'notes/' + encodeURIComponent(String(nid)) + '/attach'), { body: {} }), 'note');
  const noteClose = async (id, nid) => answer(await call('POST', roomPath(id, 'notes/' + encodeURIComponent(String(nid)) + '/close'), { body: {} }), 'note');
  async function commands() {
    // The composer coalesces one catalog request per open list. Fetch anew on
    // reopen so server upgrades, identity and address changes cannot leave stale help.
    return answer(await call('GET', '/api/rooms/commands'), 'commands');
  }
  ipcMain.handle('rooms:post', wrap((a) => post(String(a && a.id), a || {})));
  ipcMain.handle('rooms:draft', wrap((a) => draft(String(a && a.id))));
  ipcMain.handle('rooms:draft-set', wrap((a) => setDraft(String(a && a.id), a || {})));
  ipcMain.handle('rooms:scratch', wrap((a) => scratch(String(a && a.id))));
  ipcMain.handle('rooms:scratch-upload', wrap((a) => scratchUpload(String(a && a.id), a || {})));
  ipcMain.handle('rooms:scratch-remove', wrap((a) => scratchRemove(String(a && a.id), a && a.fileId)));
  ipcMain.handle('rooms:scratch-order', wrap((a) => scratchOrder(String(a && a.id), a && a.ids)));
  ipcMain.handle('rooms:assets', wrap((a) => assets(String(a && a.id))));
  ipcMain.handle('rooms:notes', wrap((a) => notes(String(a && a.id), a && a.q)));
  ipcMain.handle('rooms:note', wrap((a) => note(String(a && a.id), a && a.nid)));
  ipcMain.handle('rooms:note-create', wrap((a) => noteCreate(String(a && a.id), a && a.text)));
  ipcMain.handle('rooms:note-set', wrap((a) => noteSet(String(a && a.id), a && a.nid, a && a.text)));
  ipcMain.handle('rooms:note-attach', wrap((a) => noteAttach(String(a && a.id), a && a.nid)));
  ipcMain.handle('rooms:note-close', wrap((a) => noteClose(String(a && a.id), a && a.nid)));
  ipcMain.handle('rooms:commands', wrap(() => commands()));

  // ---- W3, people (ROOMS-API.md §3.3): rooms and workgroups, the room's lead, mode, brief and state, the seats.
  // The person never sends `from` (the engine stamps them, H); after a change the room's view is read again and
  // the cards follow. Remove, archive and dissolve are only ever sent after the page has asked.
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
  const only = (o, keys) => Object.fromEntries(keys.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));
  async function after(id, j) {
    if (j && Array.isArray(j.entries) && j.entries.length) {
      const entries = merge(id, j.entries);
      j.entries = entries;
      broadcast('rooms:line', { roomId: id, entries, why: 'post' });
    }
    try {
      const v = await room(id);
      if (v) {
        broadcast('rooms:room', { roomId: id, view: v });
      }
      await list({ force: true });
    } catch (e) {
      // the strip says why; the change itself went through
    }
    return j;
  }
  async function roomCreate(a) {
    const body = { name: str(a && a.name, 80) || '' };
    if (a && a.alias) {
      body.alias = str(a.alias, 40);
    }
    if (a && a.parent_id) {
      body.parent_id = String(a.parent_id);
    }
    const j = answer(await call('POST', '/api/rooms', { body }), 'create');
    await list({ force: true }).catch(() => {});
    cause('rooms-create', { workgroup: !!body.parent_id });
    return j;
  }
  async function roomPatch(id, a) {
    const body = only(a, ['name', 'lead_seat', 'mode', 'brief']);
    if (disconnected(id) && Object.keys(body).some(key => key !== 'name')) roomFence(id);
    const result = answer(await call('PATCH', roomPath(id), { body }), 'room');
    if (disconnected(id)) {
      const view = rooms.find(v => v.room?.id === id);
      if (view && body.name !== undefined) view.room = { ...view.room, name: body.name };
      broadcast('rooms:rooms', { rooms });
      return result;
    }
    return after(id, result);
  }
  async function roomState(id, verb) {
    if (!['archive', 'reopen', 'dissolve'].includes(verb)) {
      throw Object.assign(new Error('no such room action'), { code: 'bad-request' });
    }
    const j = answer(await call('POST', roomPath(id, verb), { body: {} }), verb);
    cause('rooms-state', { verb });
    return after(verb === 'dissolve' && j && j.parent ? j.parent : id, j);
  }
  async function workgroupCreate(id, a) {
    const body = { name: str(a && a.name, 80) || '' };
    if (a && a.alias) {
      body.alias = str(a.alias, 40);
    }
    if (Array.isArray(a && a.move) && a.move.length) {
      body.move = a.move.slice(0, 20).map(String);
    }
    if (Array.isArray(a && a.start) && a.start.length) {
      body.start = a.start.slice(0, 20).map((x) => ({ recipe_id: String(x.recipe_id), ...(x.handle ? { handle: String(x.handle) } : {}) }));
    }
    return after(id, answer(await call('POST', roomPath(id, 'workgroups'), { body }), 'workgroup'));
  }
  async function familyCheck(id, a) {
    const q = new URLSearchParams();
    if (a && a.alias) {
      q.append('alias', String(a.alias));
    }
    for (const h of ((a && a.handles) || []).slice(0, 50)) {
      q.append('handle', String(h));
    }
    return answer(await call('GET', roomPath(id, 'family-check') + '?' + q.toString()), 'check');
  }
  const seatPath = (id, sid, sub) => roomPath(id, 'seats/' + encodeURIComponent(String(sid)) + (sub ? '/' + sub : ''));
  const POLICIES = ['persistent', 'fresh', 'dispatched', 'pool'];
  function policyBody(a) {
    const b = {};
    if (a && a.policy !== undefined) {
      if (!POLICIES.includes(a.policy)) {
        throw Object.assign(new Error('no such policy'), { code: 'bad-request' });
      }
      b.policy = a.policy;
    }
    if (a && a.pool_size !== undefined) {
      b.pool_size = Math.max(1, Math.min(20, Number(a.pool_size) || 1));
    }
    return b;
  }
  async function seatAdd(id, a) {
    const body = { ...policyBody(a) };
    if (a && a.recipe_id) {
      body.recipe_id = String(a.recipe_id);
    } else if (a && a.project) {
      body.project = String(a.project);
    }
    if (a && a.handle) {
      body.handle = str(a.handle, 40);
    }
    return after(id, answer(await call('POST', roomPath(id, 'seats'), { body }), 'seat'));
  }
  async function seatPatch(id, sid, a) {
    const body = { ...policyBody(a) };
    if (a && a.handle) {
      body.handle = str(a.handle, 40);
    }
    return after(id, answer(await call('PATCH', seatPath(id, sid), { body }), 'seat'));
  }
  const seatRemove = async (id, sid) => after(id, answer(await call('DELETE', seatPath(id, sid), { body: {} }), 'remove'));
  const seatHistory = async (id, sid) => answer(await call('GET', seatPath(id, sid, 'history')), 'history');
  const seatMove = async (id, sid, to) => after(id, answer(await call('POST', seatPath(id, sid, 'move'), { body: { to_room: String(to) } }), 'move'));
  async function seatStart(id, sid, a) {
    const body = {};
    if (a && a.fresh) {
      body.fresh = true;
    }
    if (a && a.model) {
      body.model = str(a.model, 80);
    }
    return after(id, answer(await call('POST', seatPath(id, sid, 'start'), { body }), 'start'));
  }
  const wakeDeliver = async (id, sid, lineId) => after(id, answer(await call('POST', seatPath(id, sid, 'wake-deliver'), { body: { lineId: Number(lineId) } }), 'wake'));
  async function seatEnd(id, sid, expectedPane) {
    if (!localMode) throw Error('Stop is available only for a local shell seat.');
    const epoch = authEpoch, base = client.base(), checkRoom = roomFence(id);
    const check = () => {
      if (!cookies || suspended || epoch !== authEpoch || base !== client.base()) throw Error('Local rooms changed. Reopen the seat menu.');
      checkRoom();
    };
    check();
    const recipes = answer(await call('GET', '/api/recipes'), 'recipes');
    check();
    const view = await room(id);check();
    const seat = view?.seats?.find(s => s.id === sid && !s.left_at);
    if (!seat || !['live', 'parked'].includes(seat.status) || !expectedPane || seat.occupant?.id !== expectedPane) {
      throw Error('This seat changed or is no longer running. Reopen its menu.');
    }
    const recipe = recipes?.recipes?.find(r => r.id === seat.recipe_id);
    if (!recipe || recipe.target !== 'local' || recipe.vendor !== 'cli-manager' || recipe.agent) {
      throw Error('This is not a plain shell seat. Use Disconnect for an assistant.');
    }
    // The renderer supplies a confirmation snapshot, never an arbitrary End URL.
    return after(id, answer(await call('POST', '/api/sessions/' + encodeURIComponent(seat.occupant.id) + '/end', { body: {} }), 'end'));
  }
  const seatDisconnect = async (id, sid) => after(id, answer(await call('POST', seatPath(id, sid, 'disconnect'), { body: {} }), 'disconnect'));
  // 0.19.0 (PM ): the seat ⋮ at briefing-table's parity (web/room-seat-menu.mjs). Close window closes every
  // window showing the seat (it stays live, parked); Reload restarts it from its project's defaults, its preview
  // first. A room's color is its settings (PATCH …/settings {color}), one of the twelve swatches.
  // 0.22.1: Model & effort, the seat's stored {model, effort} for its next launch (PATCH …/seats/:sid/profile,
  // briefing-table <commit>; a person only). The body is those two keys and nothing else; '' or null is "Default".
  async function seatProfile(id, sid, a) {
    const body = {};
    for (const k of ['model', 'effort']) {
      if (!a || !(k in a)) {
        continue;
      }
      const v = a[k];
      if (v === null || v === '') {
        body[k] = null;
      } else if (typeof v === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(v)) {
        body[k] = v;
      } else {
        throw Object.assign(new Error(k + ' is a name (letters, digits, . _ -)'), { code: 'bad-request' });
      }
    }
    if (!Object.keys(body).length) {
      throw Object.assign(new Error('nothing to change'), { code: 'bad-request' });
    }
    return after(id, answer(await call('PATCH', seatPath(id, sid, 'profile'), { body }), 'profile'));
  }
  const seatCloseWindow = async (id, sid) => after(id, answer(await call('POST', seatPath(id, sid, 'close-window'), { body: {} }), 'close-window'));
  const seatReloadPreview = async (id, sid) => answer(await call('GET', seatPath(id, sid, 'reload')), 'reload');
  const seatReload = async (id, sid, a) => after(id, answer(await call('POST', seatPath(id, sid, 'reload'), { body: { force: !!(a && a.force), openTab: false, welcome: { mode: 'none' } } }), 'reload'));
  async function roomSettings(id, a) {
    const body = {};
    if (a && typeof a.color === 'string' && /^#[0-9a-f]{6}$/i.test(a.color)) {
      body.color = a.color;
    }
    if (!Object.keys(body).length) {
      throw Object.assign(new Error('nothing to change'), { code: 'bad-request' });
    }
    return after(id, answer(await call('PATCH', roomPath(id, 'settings'), { body }), 'settings'));
  }
  const presence = async () => answer(await call('GET', '/api/presence/user'), 'presence');
  // the person's recipes, for New room and Add a seat: the one read outside the room contract (PM )
  const recipes = async () => answer(await call('GET', '/api/recipes'), 'recipes');
  // a seat's held lines, sent now (the design's "Deliver now"; ROOMS-API.md §3.3)
  const deliverHeld = async (id, paneid) => after(id, answer(await call('POST', '/api/panes/' + encodeURIComponent(String(paneid)) + '/deliver-held', { body: {} }), 'deliver'));
  ipcMain.handle('rooms:create', wrap((a) => roomCreate(a || {})));
  ipcMain.handle('rooms:patch', wrap((a) => roomPatch(String(a && a.id), a || {})));
  ipcMain.handle('rooms:state', wrap((a) => roomState(String(a && a.id), String(a && a.verb))));
  ipcMain.handle('rooms:workgroup', wrap((a) => workgroupCreate(String(a && a.id), a || {})));
  ipcMain.handle('rooms:family-check', wrap((a) => familyCheck(String(a && a.id), a || {})));
  ipcMain.handle('rooms:seat-add', wrap((a) => seatAdd(String(a && a.id), a || {})));
  ipcMain.handle('rooms:seat-patch', wrap((a) => seatPatch(String(a && a.id), a && a.sid, a || {})));
  ipcMain.handle('rooms:seat-remove', wrap((a) => seatRemove(String(a && a.id), a && a.sid)));
  ipcMain.handle('rooms:seat-history', wrap((a) => seatHistory(String(a && a.id), a && a.sid)));
  ipcMain.handle('rooms:seat-move', wrap((a) => seatMove(String(a && a.id), a && a.sid, a && a.to)));
  ipcMain.handle('rooms:seat-start', wrap((a) => seatStart(String(a && a.id), a && a.sid, a || {})));
  ipcMain.handle('rooms:wake-deliver', wrap((a) => wakeDeliver(String(a && a.id), a && a.sid, a && a.lineId)));
  ipcMain.handle('rooms:seat-end', wrap(a => seatEnd(String(a && a.id), String(a && a.sid), a && a.paneid)));
  ipcMain.handle('rooms:seat-disconnect', wrap((a) => seatDisconnect(String(a && a.id), a && a.sid)));
  ipcMain.handle('rooms:seat-close-window', wrap((a) => seatCloseWindow(String(a && a.id), a && a.sid)));
  ipcMain.handle('rooms:seat-reload-preview', wrap((a) => seatReloadPreview(String(a && a.id), a && a.sid)));
  ipcMain.handle('rooms:seat-reload', wrap((a) => seatReload(String(a && a.id), a && a.sid, a || {})));
  ipcMain.handle('rooms:seat-profile', wrap((a) => seatProfile(String(a && a.id), a && a.sid, a || {})));
  ipcMain.handle('rooms:settings', wrap((a) => roomSettings(String(a && a.id), a || {})));
  ipcMain.handle('rooms:presence', wrap(() => presence()));
  ipcMain.handle('rooms:recipes', wrap(() => recipes()));
  // ---- W3b (W3b-ATTACH-GRANT.md draft 2; PM , ): a one-time grant for one seated pane, minted here
  // with the person's cookie and the fixed Origin, used at once by the terminal subsystem's own /term socket
  // (never the rooms socket). The grant never reaches a renderer, and nothing here logs it.
  /** A seat's room and pane from the cached views, on the local runtime's own rooms only; null otherwise. */
  function localSeatLocation(seatId) {
    return localMode ? require('./seat-pane').locateSeat(rooms, seatId) : null; // loaded on use: the vm test fixtures resolve a fixed set of modules
  }
  async function mintTerminal(a) {
    // the seat's CURRENT pane, read fresh: after a Wake it is a new one, and a resting seat has none
    const v = await room(String(a.room));
    const seat = v && Array.isArray(v.seats) ? v.seats.find((x) => x.id === String(a.seat) && !x.left_at) : null;
    if (!seat) {
      return { ok: false, why: 'gone', status: 404 };
    }
    if (!seat.occupant || !seat.occupant.id || !['live', 'parked'].includes(seat.status)) {
      return { ok: false, why: 'not-live', status: 409 };
    }
    const body = { paneid: String(seat.occupant.id), intent: a.intent === 'control' ? 'control' : 'view', room: String(a.room), seat: String(a.seat) };
    const r = await call('POST', '/api/terminal-grants', { body });
    if (r.status !== 200 || !r.json || !r.json.grant) {
      const why = r.status === 409 ? 'not-live' : r.status === 429 ? 'too-many' : r.status === 404 && !(r.json && r.json.field) ? 'off' : r.status === 403 && r.json && r.json.field === 'accounts' ? 'off' : r.status === 403 ? 'not-allowed' : r.status === 404 ? 'gone' : 'error';
      cause('term-grant-refused', { status: r.status, why });
      return { ok: false, why, status: r.status, limit: r.json && r.json.limit ? Number(r.json.limit) : null };
    }
    let u;
    try { u = new URL(String(r.json.socket || '/term'), client.base()); }
    catch { return { ok: false, why: 'error', status: 0 }; }
    if (localMode) {
      const engine = new URL(client.base());
      // A terminal grant cannot redirect the per-launch human cookie. Only the
      // same owned loopback listener's /term path may receive it.
      if (!['http:', 'ws:'].includes(u.protocol) || engine.protocol !== 'http:' ||
          engine.hostname !== '127.0.0.1' || u.hostname !== engine.hostname ||
          u.port !== engine.port || u.username || u.password ||
          u.pathname !== '/term' || u.search || u.hash) {
        return { ok: false, why: 'error', status: 0 };
      }
      u.protocol = 'ws:';
    } else if (u.protocol === 'https:') {
      u.protocol = 'wss:';
    } else if (u.protocol === 'http:' && process.env.WB_SELFTEST) {
      u.protocol = 'ws:'; // the self-test's stub only; a real room service is https (R1: wss only)
    } else if (u.protocol !== 'wss:') {
      return { ok: false, why: 'error', status: 0 };
    }
    cause('term-grant-minted', { intent: body.intent });
    return { ok: true, grant: String(r.json.grant), socket: u.toString(), cookie: localMode ? client.currentCookie() : cookieHeader(cookies), expiresIn: Number(r.json.expires_in) || 30, paneid: body.paneid };
  }
  ipcMain.handle('rooms:deliver-held', wrap((a) => deliverHeld(String(a && a.id), a && a.paneid)));
  // History export uses the existing authenticated client and the outer account dispatcher.
  async function historyCall(method, suffix = '', body, roomId) {
    const epoch = authEpoch, base = client.base();
    const checkRoom = roomId === undefined ? () => {} : roomFence(roomId);
    const check = () => {
      if (!cookies || suspended || epoch !== authEpoch || base !== client.base()) throw Object.assign(new Error('Account or engine changed. Reopen settings.'), { code: 'account-changed' });
      checkRoom();
    };
    check();
    let result;
    try { result = await call(method, '/api/history-export' + suffix, body === undefined ? undefined : { body }); }
    catch (error) { check(); throw error; }
    check(); return answer(result, 'history export');
  }
  ipcMain.handle('rooms:history-get', wrap(() => historyCall('GET')));
  ipcMain.handle('rooms:history-set', wrap(a => {
    if (typeof a?.enabled !== 'boolean') throw Object.assign(new Error('Expected history enabled boolean'), { code: 'bad-request' });
    return historyCall('PATCH', '', { enabled: a.enabled });
  }));
  ipcMain.handle('rooms:history-export', wrap(a => {
    const id = a?.roomId;
    if (id !== undefined && (typeof id !== 'string' || !rooms.some(view => view.room?.id === id))) throw Object.assign(new Error('Room is unavailable'), { code: 'bad-request' });
    return historyCall('POST', '/run', { now: true, ...(id === undefined ? {} : { roomId: id }) }, id);
  }));
  ipcMain.handle('rooms:history-start', wrap(() => historyCall('POST', '/run', {})));
  ipcMain.handle('rooms:history-cancel', wrap(() => historyCall('POST', '/cancel', {})));

  // the composer's + ("Attach files"): the system's open dialog; bytes come back for the tray's upload.
  // Over 25 MB a file comes back with its size only, so the composer can say it wasn't attached.
  const picks = [];
  ipcMain.handle('rooms:pick-files', async (e) => {
    let paths;
    if (ctx.native && typeof ctx.native.pickFiles === 'function' && !process.env.WB_SELFTEST) return ctx.native.pickFiles({ max: 10, limit: 25 * 1024 * 1024, mimeOf }); // the web build: the browser's file input
    if (process.env.WB_SELFTEST) {
      paths = picks.shift() || []; // no dialog in the self-test: the test hand queues the paths
    } else {
      const w = BrowserWindow.fromWebContents(e.sender);
      const r = await dialog.showOpenDialog(w, { properties: ['openFile', 'multiSelections'] });
      paths = r.canceled ? [] : r.filePaths;
    }
    const out = [];
    for (const f of paths.slice(0, 10)) {
      try {
        const size = fs.statSync(f).size;
        const name = path.basename(f);
        out.push(size > 25 * 1024 * 1024 ? { name, type: mimeOf(name), size } : { name, type: mimeOf(name), size, bytes: fs.readFileSync(f) });
      } catch (err) {
        // gone between the dialog and the read
      }
    }
    return out;
  });
  ipcMain.handle('rooms:me', wrap(async (patch) => {
    const body = patch && typeof patch === 'object' ? { ...patch } : {};
    if (body.picture !== undefined && body.picture !== null && !profilePicture(body.picture)) {
      throw Object.assign(new Error('picture: inline PNG, JPEG or WebP up to 256 KB, or null'), { code: 'bad-request' });
    }
    if (body.color !== undefined && body.color !== null && !colorOrNull(body.color)) {
      throw Object.assign(new Error('color: #rrggbb or null'), { code: 'bad-request' });
    }
    const current = roomCopyFence();
    const r = await call('PATCH', '/api/rooms/me', { body });
    if (!current()) throw Object.assign(new Error('account changed'), { code: 'account-changed' });
    if (r.status === 200 && r.json) {
      if (r.json.picture !== undefined) pictureData = profilePicture(r.json.picture);
      me = { handle: r.json.handle || (me && me.handle) || null, name: r.json.name || (me && me.name) || null, hiddenRooms: Array.isArray(r.json.hiddenRooms) ? r.json.hiddenRooms : (me && me.hiddenRooms) || [], color: r.json.color !== undefined ? colorOrNull(r.json.color) : (me && me.color) || null, tones: r.json.tones !== undefined ? r.json.tones : (me && me.tones) || {}, enterSubmits: typeof r.json.enterSubmits === 'boolean' ? r.json.enterSubmits : me && me.enterSubmits, pictureKey: profilePictureKey(pictureData) };
      broadcast('rooms:status', status());
      return me;
    }
    throw Object.assign(new Error('me ' + r.status), { code: 'bad-answer', status: r.status });
  }));

  if (cookies) {
    // signed in last time: the cards come up from the cache of the server, then the socket
    conn = 'polling';
    setTimeout(() => resume().catch(() => {}), 200);
    scheduleRenew();
  } else if (!process.env.WB_SELFTEST) {
    setTimeout(() => quietSignIn('start').catch(() => {}), 200); // A1 (the self-test starts it by hand)
  }

  return {
    status,
    setLocalSession,
    deactivate: () => {
      suspended = true;
      authEpoch++;
      autoBusy = null;
      clearTimeout(renewTimer);
      clearTimeout(retryTimer);
      clearInterval(pollTimer);
      renewTimer = retryTimer = pollTimer = null;
      stopLinePoll();
      live.close();
      liveOpen = false;
    },
    activate: () => {
      suspended = false;
      broadcast('rooms:status', status());
      if (cookies) { scheduleRenew(); resume().catch(() => {}); }
      else accountChanged();
    },
    forget: () => { authEpoch++; suspended = true; clearTimeout(renewTimer); clearInterval(pollTimer); signedOut('account'); },
    setServer,
    tasksBound,
    tasksRoom,
    tasksEpoch: () => authEpoch,
    tasksRoomTasksPanel: (roomId) => typeof roomId === 'string' && !!roomTasksPanel(roomId), // revision 10: main's rule for kind room-tasks
    signIn,
    signOut,
    quietSignIn,
    accountChanged,
    /** Self-test only: the realm side (a fake ticket source) and the renew timer's due time. */
    setRealm: process.env.WB_SELFTEST
      ? (r, o = {}) => {
          const was = realm;
          realm = r;
          if (o.gapMs !== undefined) {
            exchangeGapMs = o.gapMs;
          }
          return was;
        }
      : undefined,
    autoState: process.env.WB_SELFTEST ? () => ({ ...auto, renewDue: !!renewTimer, lastExchange }) : undefined,
    list,
    room,
    line,
    seen,
    setVisible,
    connection,
    post,
    draft,
    setDraft,
    scratch,
    scratchUpload,
    scratchRemove,
    scratchOrder,
    assets,
    notes,
    note,
    noteCreate,
    noteSet,
    noteClose,
    noteAttach,
    commands,
    // W3
    roomCreate,
    roomPatch,
    roomState,
    workgroupCreate,
    familyCheck,
    seatAdd,
    seatPatch,
    seatRemove,
    seatHistory,
    seatMove,
    seatStart,
    wakeDeliver,
    seatDisconnect,
    seatEnd,
    seatProfile,
    seatCloseWindow,
    seatReloadPreview,
    seatReload,
    roomSettings,
    presence,
    recipes,
    deliverHeld,
    mintTerminal,
    localSeatLocation,
    // self-test only
    test: process.env.WB_SELFTEST
      ? {
          live,
          secretsFileHas: (s) => {
            try {
              return fs.readFileSync(secPath, 'utf8').includes(s);
            } catch (e) {
              return false;
            }
          },
          keychain,
          dropSocket: () => live.close(),
          cache: (id) => lines.get(id),
          queuePick: (paths) => picks.push(paths),
          setOffline: (v) => {
            testOffline = !!v;
          },
        }
      : undefined,
  };
}

module.exports = { init };
