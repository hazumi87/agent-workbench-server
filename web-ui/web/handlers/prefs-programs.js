'use strict';
// prefs:* and programs:* in the web build. Owner: a builder. Both are SUBSTITUTES: the same contract, a browser store.
//   prefs:get / prefs:set   the page's own preferences (notification choice, hints, developer switch) kept in THIS browser's
//                           localStorage (never a secret, never a token). The desktop's `shell` is meaningless here (the shell
//                           is the engine host's) and is always ''. The Concierge fields keep their desktop defaults until
//                           slice 4's dock moves them to the engine (PATCH /api/concierge).
//   programs:list / :set    the catalog of programs the engine knows how to start, bundled from vendors/*/vendor.json (the same
//                           manifests the desktop reads), with enabled flags and default settings kept in localStorage. They
//                           pre-fill the recipe form in this browser; a recipe the engine starts uses its own saved fields.
//   programs:detect         PLATFORM-ONLY (classed so in web/channel-map.json): detection spawns a probe on the person's machine.
// The store is a small adapter so a test can swap it; with localStorage blocked it keeps the values in memory for the page's life.
const SEAM = [
  require('../../vendors/claude-code/vendor.json'),
  require('../../vendors/codex-cli/vendor.json'),
  require('../../vendors/gemini-cli/vendor.json'),
  require('../../vendors/ollama/vendor.json'),
  require('../../vendors/shell/vendor.json'),
];
const ORDER = ['claude-code', 'codex-cli', 'gemini-cli', 'ollama', 'shell'];
const PREFS_KEY = 'wb-web.prefs.v1';
const PROGRAMS_KEY = 'wb-web.programs.v1';
const SHELL_MAX = 300;

function makeStore(win = globalThis) {
  const mem = new Map();
  const ls = () => { try { return win.localStorage || null; } catch (e) { return null; } };
  return {
    read(key) {
      const s = ls();
      // a value that localStorage refused to keep (quota, private mode) lives in memory and wins over what the page last read
      try { const raw = mem.has(key) ? mem.get(key) : s ? s.getItem(key) : null; const v = raw ? JSON.parse(raw) : null; return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (e) { return {}; }
    },
    write(key, value) {
      const text = JSON.stringify(value);
      const s = ls();
      try { if (s) { s.setItem(key, text); mem.delete(key); } else mem.set(key, text); } catch (e) { mem.set(key, text); }
    },
  };
}

function catalog() {
  return SEAM.slice().sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id)).map((m) => ({
    id: String(m.id), label: String(m.label || m.id).slice(0, 60), binary: typeof m.binary === 'string' ? m.binary : '', mark: typeof m.mark === 'string' ? m.mark : 'generic',
    color: typeof m.color === 'string' ? m.color : '#5F6368', installUrl: typeof m.installUrl === 'string' ? m.installUrl : '',
    install: m.install && typeof m.install === 'object' ? (m.install.linux || m.install.default || null) : null,
    verifiedWith: String(m.verifiedWith || ''), resumable: m.resumable === true, settings: m.settings && typeof m.settings === 'object' ? m.settings : {},
  }));
}

function register(api) {
  const store = api.store || makeStore();
  const programs = catalog();
  const byId = (id) => programs.find((p) => p.id === id) || null;

  // ---- prefs
  function prefs() {
    const saved = store.read(PREFS_KEY);
    return {
      notify: { flash: true, toast: false, ...(saved.notify && typeof saved.notify === 'object' ? { flash: !!saved.notify.flash, toast: !!saved.notify.toast } : {}) },
      hints: saved.hints && typeof saved.hints === 'object' ? { ...saved.hints } : {},
      shell: '', developer: saved.developer === true,
      conciergeRecipe: null, conciergeRemember: true, conciergeReload: false, conciergeReloadMin: 5, conciergeReloadPaused: false,
      conciergeScope: { accountId: null, selectionVersion: 0 },
    };
  }
  api.handle('prefs:get', async () => prefs());
  api.handle('prefs:set', async ([p]) => {
    if (!p || typeof p !== 'object') return { error: 'account-changed' };
    const saved = store.read(PREFS_KEY);
    if (p.notify && typeof p.notify === 'object') saved.notify = { flash: !!p.notify.flash, toast: !!p.notify.toast };
    if (p.hints && typeof p.hints === 'object') saved.hints = { ...(saved.hints || {}), ...Object.fromEntries(Object.entries(p.hints).filter(([k, v]) => /^[A-Za-z0-9_.-]{1,60}$/.test(k) && typeof v === 'boolean')) };
    if (typeof p.developer === 'boolean') saved.developer = p.developer;
    // p.shell is the desktop's login shell: the engine host's shell is not the browser's to set. Ignored, said by prefs() ('')
    store.write(PREFS_KEY, saved);
    const now = prefs();
    api.emit('prefs:changed', now);
    return now;
  });

  // ---- programs
  function list() {
    const saved = store.read(PROGRAMS_KEY);
    return programs.map((p) => {
      const c = saved[p.id] && typeof saved[p.id] === 'object' ? saved[p.id] : {};
      const set = c.settings && typeof c.settings === 'object' ? c.settings : {};
      const settings = {};
      for (const [k, f] of Object.entries(p.settings)) settings[k] = set[k] !== undefined && set[k] !== '' ? set[k] : f.default;
      return {
        id: p.id, label: p.label, mark: p.mark, color: p.color, shipped: true, error: null,
        enabled: p.id === 'shell' ? true : typeof c.enabled === 'boolean' ? c.enabled : true,
        resumable: p.resumable, resumeError: null, verifiedWith: p.verifiedWith, binary: p.binary, schema: p.settings, settings,
        detected: null, installUrl: p.installUrl, install: p.install, prepare: false,
      };
    });
  }
  api.handle('programs:list', async () => list());
  api.handle('programs:set', async ([p]) => {
    if (!p || typeof p.id !== 'string' || !byId(p.id)) return list();
    const saved = store.read(PROGRAMS_KEY);
    const c = saved[p.id] && typeof saved[p.id] === 'object' ? saved[p.id] : {};
    if (typeof p.enabled === 'boolean' && p.id !== 'shell') c.enabled = p.enabled; // Shell is always on: every plain CLI runs it
    if (p.settings && typeof p.settings === 'object') {
      const allowed = Object.keys(byId(p.id).settings);
      const clean = {};
      for (const [k, v] of Object.entries(p.settings)) if (allowed.includes(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) clean[k] = typeof v === 'string' ? v.slice(0, SHELL_MAX + 200) : v;
      c.settings = { ...(c.settings || {}), ...clean };
    }
    saved[p.id] = c;
    store.write(PROGRAMS_KEY, saved);
    const now = list();
    api.emit('programs:changed', now);
    return now;
  });
}

module.exports = { register, makeStore, catalog, PREFS_KEY, PROGRAMS_KEY };
