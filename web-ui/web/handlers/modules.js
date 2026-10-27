// Client slice 8, the web module host: the wb methods that main answered for modules:* and rooms:tasks* in the
// desktop app, forwarded to the engine's module routes (the engine's web-module routes). The ENGINE
// decides which modules are on (M2) and admits every data call (M4: person, module on, class and context, grant,
// verb input, purge approval, budget); the page keeps only what carries no data: the rail card cap
// (src/module-cards.js on the merged catalog) and the module frame URL guard. The catalog the page draws from is the
// app's own build-time list (urls, main scripts, tool and widget parts) with the engine's on/off and error laid over
// it: a module the engine does not list is off. Module settings stay in the page (the engine has no route for them).
// No Vikunja panel exists in the web build, so room-tasks cards are refused. test/web/forward-modules.test.mjs.
//
// deps: request(method, path, body?) → Promise<{status, json}> (same-origin, the sign-in cookie; throws when the
//         engine does not answer) · origin: the page's origin · boot() → the build-time catalog entries
//       makeCards(deps) → src/module-cards.js admission · account() → {accountId, selectionVersion}
//       roomKnown(roomId) → bool

import { createCardAdmission } from '../../src/module-cards.js';
import * as rt from '../runtime.js';

const ID = /^[a-z][a-z0-9-]{0,40}$/;
const STORAGE_OPS = new Set(['get', 'set', 'list', 'delete']);
const STORAGE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;
const UI_PAGE = /^\/app\/(modules|plugins)\/([a-z][a-z0-9-]{0,40})\/ui\/((?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.html)$/;
const WIN = 'page'; // one page is one window: module-cards.js keys by window
const DOWN = 'The server did not answer.';
const OFF_HERE = 'This tool is not on this server.';

const refused = (status, error, field) => ({ ok: false, kind: 'refused', status, error, field: field || null });
const TRANSPORT = Object.freeze({ ok: false, kind: 'transport' });
const words = (j, fallback) => (j && typeof j.error === 'string' && j.error ? (typeof j.message === 'string' && j.message ? j.message : j.error).slice(0, 300) : fallback);
const isList = (j) => !!j && Array.isArray(j.modules);

export function createModulesHandlers(deps) {
  let engine = null; // id → {enabled, error} from the engine's catalog; null until it has answered once
  let pluginsOn = null; // the engine's plugins.enabled (HARBOR_WB_PLUGINS); null until it has answered
  const settings = new Map(); // id → settings object (page-local)
  let catalog = [];
  let roles = null;

  /** The build-time list with the engine's on/off laid over it (before the engine answers: the build's defaults). */
  function merged() {
    const boot = Array.isArray(deps.boot()) ? deps.boot() : [];
    const ids = new Set(boot.map((b) => b.id));
    return (catalog = [...boot.map((b) => {
      const s = settings.has(b.id) ? settings.get(b.id) : b.settings || {};
      if (!engine) return { ...b, settings: s };
      const e = engine.get(b.id);
      // a bundled module the engine does not list: the server is not serving this app's folder (HARBOR_WB_APP_DIR);
      // flagged `missing` so the page says so plainly instead of quietly showing it off (lead #N, 4)
      if (!e) return { ...b, settings: s, enabled: b.core === true, error: b.core === true ? b.error ?? null : OFF_HERE, missing: true };
      return { ...b, settings: s, enabled: b.core === true ? !e.error : e.enabled === true, error: e.error || b.error || null };
    }), ...pluginRows.filter((r) => !ids.has(r.id))]); // a plugin never shadows a bundled id
  }
  let pluginRows = []; // the engine's installed plugins, in the page's shape (they are not in the build-time list)
  const PLUGIN_ID = /^[a-z][a-z0-9-]{0,40}$/;
  const PLUGIN_ENTRY = /^ui\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.html$/;
  function takeEngine(list) {
    engine = new Map();
    pluginRows = [];
    for (const v of list) {
      if (!v || typeof v.id !== 'string') continue;
      engine.set(v.id, { enabled: v.enabled === true, error: typeof v.error === 'string' && v.error ? v.error : null });
      if (v.source === 'plugin' && PLUGIN_ID.test(v.id)) {
        // a plugin is UI only: no main script, its pages under its own /app/plugins/<id>/ folder (M1 serves only its consented files)
        pluginRows.push({
          id: v.id, name: String(v.name || v.id).slice(0, 60), version: String(v.version || ''), class: typeof v.class === 'string' ? v.class : '',
          source: 'plugin', parent: null, icon: 'extension', core: false, main: null, settingsSchema: null, description: '',
          entry: typeof v.entry === 'string' && PLUGIN_ENTRY.test(v.entry) ? v.entry : null,
          permissions: Array.isArray(v.permissions) ? v.permissions.filter((x) => typeof x === 'string') : [],
          tool: Array.isArray(v.contexts) ? { contexts: v.contexts.filter((x) => typeof x === 'string'), role: typeof v.role === 'string' ? v.role : null } : null,
          url: '/app/plugins/' + v.id + '/', enabled: v.enabled === true, error: typeof v.error === 'string' && v.error ? v.error : null, settings: {},
        });
      }
    }
  }
  merged();

  const cards = deps.makeCards({
    catalog: () => catalog,
    moduleGen: (id) => catalog.find((m) => m.id === id)?.gen ?? 0,
    account: () => deps.account(),
    roomKnown: (roomId) => deps.roomKnown(roomId),
    roomTasksPanel: () => false,
  });

  /** The engine's catalog, merged; null when the engine did not answer (the page keeps what it has). */
  async function modulesList() {
    try {
      const r = await deps.request('GET', '/api/modules');
      if (r.status !== 200 || !isList(r.json)) return null;
      takeEngine(r.json.modules);
      if (r.json.plugins && typeof r.json.plugins.enabled === 'boolean') pluginsOn = r.json.plugins.enabled;
      return merged();
    } catch {
      return null;
    }
  }

  function taskCall(a) {
    if (!a || typeof a !== 'object' || typeof a.moduleId !== 'string' || !ID.test(a.moduleId)) return null;
    if (typeof a.verb !== 'string' || !a.verb || a.verb.length > 40) return null;
    if (typeof a.roomId !== 'string' || !a.roomId || a.roomId.length > 128) return null;
    return '/api/modules/' + a.moduleId + '/rooms/' + encodeURIComponent(a.roomId) + '/tasks';
  }

  return Object.freeze({
    /** The engine's catalog merged (null: it did not answer). */
    modulesList,
    catalog: () => catalog,
    /** Whether this server takes plugin installs: true, false, or null when the engine has not said. */
    pluginsEnabled: () => pluginsOn,

    /** A person turns a module on or off (PUT .../enabled), or changes its settings (kept in the page). → the list. */
    async moduleSet(p) {
      if (!p || typeof p.id !== 'string' || !ID.test(p.id) || !catalog.some((m) => m.id === p.id)) return catalog;
      if (p.settings && typeof p.settings === 'object' && !Array.isArray(p.settings)) settings.set(p.id, p.settings);
      if (typeof p.enabled === 'boolean') {
        try {
          const r = await deps.request('PUT', '/api/modules/' + p.id + '/enabled', { enabled: p.enabled });
          if (r.status === 200 && r.json && r.json.id === p.id && engine) {
            engine.set(p.id, { enabled: r.json.enabled === true, error: typeof r.json.error === 'string' && r.json.error ? r.json.error : null });
            return merged();
          }
        } catch { /* read it again below */ }
        return (await modulesList()) || merged(); // refused or unknown: the page snaps back to the engine's answer
      }
      return merged();
    },

    modulesRescan: async () => { const list = await modulesList(); if (list) appMissingNotice(list); return list || merged(); },

    async moduleStorage(p) {
      if (!p || typeof p.id !== 'string' || !ID.test(p.id)) return { ok: false, error: 'no such module' };
      const op = String(p.op || '');
      if (!STORAGE_OPS.has(op)) return { ok: false, error: 'unknown storage op: ' + op.slice(0, 20) };
      const base = '/api/modules/' + p.id + '/storage';
      if (op !== 'list' && (typeof p.key !== 'string' || !STORAGE_NAME.test(p.key) || p.key === '.' || p.key === '..')) {
        return { ok: false, error: 'a storage key is a plain name (letters, digits, dot, dash, underscore)' };
      }
      try {
        if (op === 'list') {
          const r = await deps.request('GET', base);
          return r.status === 200 && r.json && Array.isArray(r.json.names) ? { ok: true, keys: r.json.names, files: [] } : { ok: false, error: words(r.json, 'The server refused that.') };
        }
        const path = base + '/' + encodeURIComponent(p.key);
        if (op === 'get') {
          const r = await deps.request('GET', path);
          if (r.status === 404 && r.json && r.json.field === 'name') return { ok: true, value: null };
          if (r.status !== 200 || !r.json || typeof r.json.value !== 'string') return { ok: false, error: words(r.json, 'The server refused that.') };
          try { return { ok: true, value: JSON.parse(r.json.value) }; } catch { return { ok: true, value: null }; } // written by us as JSON text
        }
        if (op === 'delete') {
          const r = await deps.request('DELETE', path);
          return r.status === 200 ? { ok: true } : { ok: false, error: words(r.json, 'The server refused that.') };
        }
        const r = await deps.request('PUT', path, { value: JSON.stringify(p.value === undefined ? null : p.value) }); // the engine keeps strings
        return r.status === 200 ? { ok: true } : { ok: false, error: words(r.json, 'The server refused that.') };
      } catch {
        return { ok: false, error: DOWN };
      }
    },

    /** The page's guard before it sets a module frame's src (module-frame.js `declare`): this origin, an enabled
     *  catalog module under its own prefix (bundled /app/modules, plugin /app/plugins), a ui/ page, a load nonce.
     *  The engine's M1 route applies the real path rules and the sandbox CSP whatever this says. */
    moduleFrameExpect(p) {
      let u;
      try {
        u = new URL(p && p.url, deps.origin);
      } catch {
        return false;
      }
      if (u.origin !== deps.origin || !u.searchParams.get('wbl')) return false;
      const m = UI_PAGE.exec(u.pathname);
      if (!m || m[3].split('/').some((s) => s === '.' || s === '..' || /^\.|\.\./.test(s))) return false;
      const e = catalog.find((x) => x.id === m[2]);
      return !!e && e.enabled === true && !e.error && e.source === (m[1] === 'plugins' ? 'plugin' : 'bundled');
    },

    moduleCardAdmit: async (p) => cards.admit(WIN, { moduleId: p && p.moduleId, cardId: p && p.cardId, kind: p && p.kind, roomId: p && p.roomId }),
    async moduleCardRelease(p) {
      const seq = p && Number.isSafeInteger(p.seq) && p.seq > 0 ? p.seq : null;
      if (seq !== null) cards.release(WIN, { moduleId: p.moduleId, cardId: p.cardId, seq });
      return { ok: true };
    },

    /** Theme roles for pop-outs (desktop: main kept them for module windows). Nothing leaves the page. */
    moduleTheme(r) {
      roles = r && typeof r === 'object' ? r : null;
    },
    themeRoles: () => roles,

    async roomsTasks(a) {
      const path = taskCall(a);
      if (!path) return refused(400, 'Not a Tasks call.', 'input');
      const body = { verb: a.verb, input: a.input === undefined ? {} : a.input };
      if (a.approval !== undefined) body.approval = a.approval;
      try {
        const r = await deps.request('POST', path, body);
        if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status, body: r.json === undefined ? null : r.json };
        if (r.status === 429) return { ok: false, kind: 'slow' };
        if (r.status >= 400 && r.status < 500) {
          const j = r.json && typeof r.json === 'object' ? r.json : {};
          return refused(r.status, words(j, 'The room refused that.'), typeof j.field === 'string' ? j.field.slice(0, 40) : null);
        }
        return TRANSPORT;
      } catch {
        return TRANSPORT;
      }
    },

    async roomsTasksApprove(a) {
      const path = taskCall(a);
      if (!path) return { ok: false, kind: 'refused', status: 400 };
      try {
        const r = await deps.request('POST', path + '/approve', { verb: a.verb, input: a.input === undefined ? {} : a.input });
        if (r.status === 200 && r.json && typeof r.json.approval === 'string') return { ok: true, approval: r.json.approval };
        return { ok: false, kind: 'refused', status: r.status };
      } catch {
        return TRANSPORT;
      }
    },

    /** An engine stream event → [wb channel, payload] for the page's wb.on bus, or null when it is not ours. */
    engineEvent(name, payload) {
      if (name === 'modules.changed') {
        if (isList(payload)) takeEngine(payload.modules);
        return ['modules:changed', merged()];
      }
      if (name === 'rooms.tasks' && payload && typeof payload.roomId === 'string') {
        return ['rooms:tasks', { roomId: payload.roomId, familyId: typeof payload.familyId === 'string' ? payload.familyId : null }];
      }
      return null;
    },
  });
}

/** The window.wb.rooms.* envelope from the preload: [{scope, args:[a]}] → a. */
const roomsArg = (args) => (args && args[0] && Array.isArray(args[0].args) ? args[0].args[0] : undefined);

/** The foundation's boot calls this (web/runtime.js boot, after rooms.js). */
export function register(api) {
  const request = async (method, path, body) => {
    const init = { method, headers: { accept: 'application/json' } };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    const res = await api.engine.fetch(path, init);
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  };
  // the build-time catalog, as the boot payload gives it (web/runtime.js modulesForInit)
  const pageBase = new URL('./', globalThis.location ? globalThis.location.href : 'http://localhost/');
  const boot = () => ((globalThis.__WB_WEB__ || {}).modules || []).map((m) => ({ ...m, url: new URL(m.url, pageBase).href, enabled: m.core ? true : m.defaultEnabled, settings: {} }));
  const h = createModulesHandlers({
    request,
    boot,
    origin: globalThis.location ? globalThis.location.origin : '',
    makeCards: (deps) => createCardAdmission(deps),
    account: () => ({ accountId: null, selectionVersion: 0 }), // one person per server, no accounts
    // a card carries no data (the engine admits every call behind it); the page draws cards only for the room it
    // shows, so any room id it names is the shown room
    roomKnown: (roomId) => typeof roomId === 'string' && roomId.length > 0 && roomId.length <= 128,
  });
  // as main did (broadcastModules): every change tells the page, so the renderer applies the new catalog and the
  // Settings page, the rail and the widgets repaint (found in the plugins-ON real-browser run)
  const told = (list) => { if (Array.isArray(list)) api.emit('modules:changed', list); return list; };
  api.handle('modules:set', async ([p]) => told(await h.moduleSet(p)));
  api.handle('modules:rescan', async () => told(await h.modulesRescan()));
  api.handle('modules:storage', ([p]) => h.moduleStorage(p));
  api.handle('modules:frame-expect', ([p]) => h.moduleFrameExpect(p));
  api.handle('modules:card-admit', ([p]) => h.moduleCardAdmit(p));
  api.handle('modules:card-release', ([p]) => h.moduleCardRelease(p));
  api.handle('modules:window-open', async () => ({ ok: false, kind: 'refused', status: 501, error: 'Opening a tool in its own window comes later in the web app.', field: null }));
  // the module-page task calls: the rooms core registered its desktop admission (refusing, rooms.js); the engine
  // admits them now (M4), so ownership moves here rather than being doubled
  rt.removeHandler('rooms:tasks');
  rt.removeHandler('rooms:tasks-approve');
  api.handle('rooms:tasks', (args) => h.roomsTasks(roomsArg(args)));
  api.handle('rooms:tasks-approve', (args) => h.roomsTasksApprove(roomsArg(args)));
  api.expose('modulesPluginsEnabled', () => h.pluginsEnabled());
  api.expose('modulesEngineEvent', (name, payload) => {
    const out = h.engineEvent(name, payload);
    if (out) api.emit(out[0], out[1]);
    return !!out;
  });
  // the engine's on/off (and its installed plugins) is laid over the build-time catalog once it answers. The page applies
  // the build's list from its init, which goes out after this file has run: an answer that comes back before the page is
  // ready would be overwritten, so it is told again once the page says it is ready (the design's re-walk: a plugin row, or a
  // module the person turned off, was lost on every reload)
  const ready = () => !!(globalThis.document && document.documentElement && document.documentElement.getAttribute('data-wb-web') === 'ready');
  const whenReady = (fn) => {
    if (ready()) { fn(); return; }
    if (typeof MutationObserver !== 'function' || !globalThis.document) return;
    const mo = new MutationObserver(() => { if (ready()) { mo.disconnect(); fn(); } });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-wb-web'] });
  };
  void h.modulesList().then((list) => {
    if (!list) return;
    appMissingNotice(list);
    api.emit('modules:changed', list);
    whenReady(() => api.emit('modules:changed', h.catalog()));
  });
}

// Workrooms is the product: it never vanishes quietly (lead #N). When the engine's list lacks it (`missing`, only
// once the engine has answered), the server is not serving this app's own folder: the page says so in place of the
// empty shell, names the setting, and offers a reload; gone again once a list has it. Here in the web facade, not the
// renderer, so it shows even when the renderer's boot stalls on module files that are not there.
export const APP_MISSING_TITLE = "This server can't run Agent Workbench yet";
export const APP_MISSING_TEXT = "The app's own tools aren't on this server, so Workrooms can't open. Whoever runs the server should point HARBOR_WB_APP_DIR at this app's built folder, then reload this page.";
export function appMissingNotice(list, doc = globalThis.document) {
  if (!doc || !doc.body || !Array.isArray(list)) return;
  const lost = list.some((m) => m && m.id === 'workrooms' && m.missing === true);
  let box = doc.getElementById('wbAppMissing');
  if (!lost) { if (box) box.remove(); return; }
  if (box) return;
  const make = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
  box = make('div', 'wb-appmissing');
  box.id = 'wbAppMissing';
  box.setAttribute('role', 'alert');
  const card = make('div', 'wb-appmissing-card');
  const again = make('button', 'wb-appmissing-reload', 'Reload');
  again.type = 'button';
  again.addEventListener('click', () => globalThis.location.reload());
  card.append(make('h1', null, APP_MISSING_TITLE), make('p', null, APP_MISSING_TEXT), again);
  box.append(card);
  doc.body.append(box);
}
