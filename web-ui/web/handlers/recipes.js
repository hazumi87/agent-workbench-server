'use strict';
// recipes:* in the web build. The ENGINE is the recipe store (GET/POST/DELETE /api/recipes), so there is no local store and no
// realm sync; the page keeps desktop-shaped records through web/lib/recipe-map.js. Owner: a builder.
//   forward     recipes:list, recipes:save, recipes:delete, recipes:duplicate, recipes:check-folder
//   substitute  recipes:sync (nothing to sync: the engine table is the one copy); recipes:folder-form and recipes:pick-folder keep the
//               desktop's token contract, with the dialog being slice 3's server-side picker (window.wb.web.files.chooseFolder), so a save claims
//               the folder a person chose, not a string the page invented
//   platform    recipes:setup (runs a program's prepare step in a folder); recipes:import-* are slice 4's (it reads the file in the
//               browser and calls importSelected below)
// Never sends a trust or a disclosure for an imported recipe (web/lib/recipe-map.js).
const { toEngine, fromEngine } = require('../lib/recipe-map');

const NAME_MAX = 60;
const FORM_ID = /^[\w.:-]{1,64}$/;
const CONTEXTS = ['general', 'concierge'];
const TOKEN_TTL_MS = 10 * 60 * 1000;
const hex = () => { const b = new Uint8Array(16); const c = globalThis.crypto; if (c && c.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256); return [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); }; // the browser always has crypto; the fallback only keeps a bare context (the coverage check) from throwing

/** The first free name: "Site copy", then "Site copy 2" (the desktop's Duplicate rule). */
function copyName(name, taken) {
  const have = new Set(taken.map((n) => String(n).toLowerCase()));
  const base = (String(name).slice(0, NAME_MAX - 5) + ' copy').trim();
  if (!have.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n++) { const c = base + ' ' + n; if (!have.has(c.toLowerCase())) return c; }
  return base + ' ' + Date.now();
}

function register(api) {
  const rows = new Map(); // engine rows by id: what a full-replace save must carry over
  let targetId = null;
  const note = (name, extra) => (api.cause ? api.cause(name, extra) : undefined);

  async function json(path, init) {
    let res;
    try { res = await api.engine.fetch(path, init); } catch (e) { throw Object.assign(new Error("Couldn't reach the server."), { code: 'unreachable', cause: e }); }
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    return { status: res.status, ok: res.ok, body };
  }
  const reason = (r, fallback) => (r.body && typeof r.body.error === 'string' && r.body.error ? r.body.error : fallback);

  async function target() {
    if (targetId) return targetId;
    const r = await json('/api/targets');
    const list = r.ok && r.body && Array.isArray(r.body.targets) ? r.body.targets : [];
    const pick = list.find((t) => t && t.id === 'local') || list[0];
    if (!pick || typeof pick.id !== 'string') return null;
    targetId = pick.id;
    return targetId;
  }

  async function load() {
    const r = await json('/api/recipes');
    if (!r.ok || !r.body || !Array.isArray(r.body.recipes)) throw Object.assign(new Error(reason(r, "Couldn't read the recipes.")), { code: 'http', status: r.status });
    rows.clear();
    for (const row of r.body.recipes) if (row && typeof row.id === 'string') rows.set(row.id, row);
    return [...rows.values()].map(fromEngine).filter(Boolean);
  }
  const changed = async () => { try { api.emit('recipes:changed', await load()); } catch (e) { /* the next list call reports it */ } };

  /** One POST /api/recipes: {ok:true, record, warning?} or {ok:false, status, error, field?}; `unconfirmed` when the answer never came. */
  async function post(body, { signal } = {}) {
    let res;
    try {
      res = await api.engine.fetch('/api/recipes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    } catch (e) {
      return { ok: false, unconfirmed: true, error: signal && signal.aborted ? 'Cancelled.' : "Couldn't confirm the save. Check the recipe list before trying again." };
    }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (res.ok && !(data && data.recipe && typeof data.recipe.id === 'string')) {
      // a 2xx that carries no recipe: the engine may or may not have saved it, so it is UNCONFIRMED, never "refused" and never "saved"
      return { ok: false, unconfirmed: true, status: res.status, error: "Couldn't confirm the save. Check the recipe list before trying again." };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: (data && typeof data.error === 'string' && data.error) || 'The server refused the recipe.', field: data && data.field, allowed: data && data.allowed };
    }
    rows.set(data.recipe.id, data.recipe);
    return { ok: true, record: fromEngine(data.recipe), ...(data.warning ? { warning: data.warning } : {}) };
  }

  // ---- the folder choice: a token bound to one form, spent by the save that claims it
  const forms = new Set();
  const held = new Map(); // token -> {path, formId, until}
  const now = api.now || Date.now;
  api.handle('recipes:folder-form', async ([a]) => {
    if (!a || typeof a !== 'object' || !FORM_ID.test(String(a.formId || '')) || !CONTEXTS.includes(a.context)) return { ok: false };
    if (a.recipeId != null && (typeof a.recipeId !== 'string' || a.recipeId.length > 128)) return { ok: false };
    forms.add(a.formId);
    if (forms.size > 50) forms.delete(forms.values().next().value);
    return { ok: true };
  });
  api.handle('recipes:pick-folder', async ([a]) => {
    if (!a || typeof a !== 'object' || !['choose', 'create'].includes(a.mode) || !forms.has(String(a.formId || ''))) return { ok: false, why: 'invalid' };
    const files = globalThis.wb && globalThis.wb.web && globalThis.wb.web.files;
    if (!files || typeof files.chooseFolder !== 'function') return { ok: false, why: 'unavailable' }; // slice 3's picker is not mounted: say so, never guess a path
    let r;
    try { r = await files.chooseFolder({ mode: a.mode }); } catch (e) { return { ok: false, why: 'unreadable' }; }
    if (!r || r.ok === false || r.canceled || typeof r.path !== 'string' || !r.path) return { ok: false, why: 'cancel' };
    const st = await json('/api/fs/dirs?path=' + encodeURIComponent(r.path) + '&hidden=0').catch(() => null);
    if (!st || !st.ok) return { ok: false, why: 'unreadable' };
    const token = hex();
    held.set(token, { path: String(st.body.path || r.path), formId: a.formId, until: now() + TOKEN_TTL_MS });
    if (held.size > 20) held.delete(held.keys().next().value);
    return { ok: true, token, path: held.get(token).path };
  });
  /** What a save stores for the folder: the path a valid token names (spent after the save), else what the page sent. */
  function claim(p) {
    if (!p || typeof p !== 'object') return { ok: true, payload: p, spend() {} };
    const { folderToken, formId, ...rest } = p;
    if (typeof folderToken !== 'string') return { ok: true, payload: rest, spend() {} };
    const h = held.get(folderToken);
    if (!h || now() > h.until || h.formId !== formId) return { ok: false, error: 'That folder choice is no longer valid. Choose the folder again.' };
    return { ok: true, payload: { ...rest, folder: h.path }, spend: () => held.delete(folderToken) };
  }

  api.handle('recipes:list', async () => load());

  api.handle('recipes:save', async ([raw]) => {
    const picked = claim(raw);
    if (!picked.ok) return { error: picked.error };
    const p = picked.payload;
    const t = await target();
    if (!t) return { error: 'This server has no place to run a program yet.' };
    if (!rows.size) await load().catch(() => {});
    const existing = p && typeof p.id === 'string' ? rows.get(p.id) || null : null;
    const m = toEngine(p, { targetId: t, existing });
    if (!m.ok) return { error: m.message, field: m.field };
    const r = await post(m.body);
    if (!r.ok) return { error: r.error, ...(r.status ? { status: r.status } : {}), ...(r.unconfirmed ? { unconfirmed: true } : {}), ...(r.field ? { field: r.field } : {}), ...(r.allowed ? { allowed: r.allowed } : {}) };
    picked.spend();
    note('recipe-saved', { id: r.record.id, program: r.record.programId, isNew: !m.body.id });
    void changed();
    return r.warning ? { ...r.record, warning: r.warning } : r.record;
  });

  api.handle('recipes:delete', async ([id]) => {
    const rid = String(id || '');
    if (!rid) return { error: 'Choose a recipe to delete.' };
    const r = await json('/api/recipes/' + encodeURIComponent(rid), { method: 'DELETE' });
    if (r.status === 409) return { error: reason(r, 'A seat in a room still starts from this recipe. Remove the seat first.') };
    if (!r.ok) return { error: reason(r, "Couldn't delete the recipe.") };
    rows.delete(rid);
    note('recipe-deleted', { id: rid });
    void changed();
    return { id: rid };
  });

  api.handle('recipes:duplicate', async ([id]) => {
    const t = await target();
    if (!t) return { error: 'This server has no place to run a program yet.' };
    if (!rows.size) await load().catch(() => {});
    const src = rows.get(String(id || ''));
    if (!src) return { error: 'That recipe is gone.' };
    const rec = fromEngine(src);
    const m = toEngine({ ...rec, id: undefined, name: copyName(rec.name, [...rows.values()].map((x) => x.name)), autoApprove: undefined }, { targetId: t, existing: src });
    if (!m.ok) return { error: m.message, field: m.field };
    delete m.body.id; // a copy is a new recipe
    const r = await post(m.body);
    if (!r.ok) return { error: r.error, ...(r.status ? { status: r.status } : {}), ...(r.unconfirmed ? { unconfirmed: true } : {}) };
    void changed();
    return r.record;
  });

  // nothing to sync: the engine's table is the one copy (the desktop's realm sync does not exist here)
  api.handle('recipes:sync', async () => ({ ok: true }));

  // "Found on this server." Folders are checked on the engine's host, inside its file root (GET /api/fs/dirs)
  api.handle('recipes:check-folder', async ([a]) => {
    const folder = a && typeof a.folder === 'string' ? a.folder.trim() : '';
    const home = folder === '' || folder === '~';
    const r = await json('/api/fs/dirs?path=' + encodeURIComponent(home ? '' : folder) + '&hidden=0').catch(() => null);
    if (!r) return { ok: false, why: 'error', message: "Couldn't ask the server." };
    if (r.ok && r.body) return { ok: true, path: String(r.body.path || folder || '~'), exists: true, dir: true };
    const code = r.body && r.body.error;
    if (r.status === 404 && code === 'not-found') return { ok: true, path: folder || '~', exists: false, dir: false };
    if (code === 'outside-root') return { ok: false, why: 'outside-root' };
    if (code === 'unreadable') return { ok: false, why: 'unreadable' };
    return { ok: false, why: 'error', message: reason(r, "The server couldn't check that folder.") };
  });

  /**
   * Slice 4's import: ONE POST /api/recipes per selected, already validated desktop-shaped record, in order.
   * No create is ever retried. It stops at the first refused or unconfirmed result and returns what is confirmed so far.
   *   -> [{index, status:'saved'|'refused'|'unconfirmed'|'not-sent', id?, record?, error?, field?}]
   * An aborted signal sends nothing further; a write already sent when it fires is 'unconfirmed' (read the list back).
   * Every imported recipe follows the default approval; no disclosure or trust is ever sent.
   */
  async function importSelected(list, { signal } = {}) {
    const out = [];
    const items = Array.isArray(list) ? list : [];
    const t = await target().catch(() => null);
    let stopped = false;
    for (let i = 0; i < items.length; i++) {
      if (stopped || (signal && signal.aborted)) { out.push({ index: i, status: 'not-sent' }); stopped = true; continue; }
      if (!t) { out.push({ index: i, status: 'refused', error: 'This server has no place to run a program yet.', field: 'target' }); stopped = true; continue; }
      const m = toEngine(items[i], { targetId: t, imported: true });
      if (!m.ok) { out.push({ index: i, status: 'refused', error: m.message, field: m.field }); stopped = true; continue; }
      const r = await post(m.body, { signal });
      if (r.ok) { out.push({ index: i, status: 'saved', id: r.record.id, record: r.record, ...(r.warning ? { warning: r.warning } : {}) }); continue; }
      out.push({ index: i, status: r.unconfirmed ? 'unconfirmed' : 'refused', error: r.error, ...(r.status ? { httpStatus: r.status } : {}), ...(r.field ? { field: r.field } : {}) });
      stopped = true;
    }
    if (out.some((x) => x.status === 'saved')) void changed();
    return out;
  }
  /**
   * writeApproval(id, {autoApprove: 'follow'|'on'|'off', disclosed?}, {signal, current}) -> {ok:true, record} | {ok:false, status?, error, field?, unconfirmed?, stale?}
   * One recipe's approval, through the one mapper: the recipe is read FRESH, every other field is carried (the engine's upsert is a full replace),
   * and only the approval changes. `current()` fences the write: it is asked before the read and again just before the POST, and a false
   * answer sends nothing (the account, the page or the scope moved on). "on" carries disclosed:true only when the caller says the person gave it.
   * A lost answer is UNCONFIRMED (the caller reads GET /api/settings/auto-approve back); nothing is ever retried.
   */
  async function writeApproval(id, patch, { signal, current } = {}) {
    const alive = () => !(signal && signal.aborted) && (typeof current !== 'function' || current() !== false);
    const rid = typeof id === 'string' ? id : '';
    const want = patch && typeof patch === 'object' ? patch.autoApprove : null;
    if (!rid) return { ok: false, field: 'id', error: 'Choose a recipe.' };
    if (!['follow', 'on', 'off'].includes(want)) return { ok: false, field: 'autoApprove', error: 'Choose follow, on or off.' };
    if (!alive()) return { ok: false, stale: true, error: 'Cancelled.' };
    const t = await target().catch(() => null);
    if (!t) return { ok: false, field: 'target', error: 'This server has no place to run a program yet.' };
    let list;
    try { list = await load(); } catch (e) { return { ok: false, error: "Couldn't read the recipe." }; }
    const row = rows.get(rid);
    const rec = list.find((r) => r.id === rid);
    if (!row || !rec) return { ok: false, status: 404, field: 'id', error: 'That recipe is gone.' };
    const m = toEngine({ ...rec, autoApprove: want, ...(want === 'on' && patch.disclosed === true ? { disclosed: true } : {}) }, { targetId: t, existing: row });
    if (!m.ok) return { ok: false, field: m.field, error: m.message };
    if (!alive()) return { ok: false, stale: true, error: 'Cancelled.' }; // fenced again, right before the POST
    const r = await post(m.body, { signal });
    if (!r.ok) return { ok: false, error: r.error, ...(r.status ? { status: r.status } : {}), ...(r.unconfirmed ? { unconfirmed: true } : {}), ...(r.field ? { field: r.field } : {}) };
    void changed();
    return { ok: true, record: r.record };
  }
  api.expose('recipes', { importSelected, writeApproval });
}

module.exports = { register, copyName };
