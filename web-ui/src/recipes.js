'use strict';
// Recipes (the design notes piece 5, step 3c; the design's step-3c page): a recipe starts a
// program in a folder on one of the account's server · login pairs with one click. They are settings,
// not window state: `config.json` → `recipes`. Mode B only (the owner ): a recipe names the realm's
// server-login id, never a label (piece 2: renaming a target silently broke five recipes once), and
// never This machine. Rename or Color on a pane never writes back here; a recipe changes only through
// its gear. Sessions are instances, not settings: nothing about a running CLI is stored on its recipe.
//
// This module is the store and its rules (pure, testable). The IPC, the rail and the form sit in
// main.js and the renderer; the realm sync (per field, tombstones) rides on top of the same records.

const crypto = require('crypto');
const {normalizeAgent,normalizeFont,worktreeOf,validateParity}=require('./recipe-parity');
const {validRaster}=require('./recipe-import-image');
const raster=value=>{try{return validRaster(value);}catch{return null;}};

const NAME_MAX = 60;
const FOLDER_MAX = 300;
const ARGS_MAX = 500;

/** The folder as the person typed it, cleaned the way the page says: trailing slash, spaces, and a
 *  pasted `login@host:` prefix are dropped silently. Empty means the home folder. */
function normalizeFolder(raw) {
  let f = String(raw == null ? '' : raw).trim();
  f = f.replace(/^[A-Za-z0-9._-]+@[A-Za-z0-9.:_-]+:/, ''); // your account@srv:~/site → ~/site
  f = f.replace(/[\\/]+$/, ''); // ~/site/ → ~/site (never the root: "/" becomes "" below)
  if (f === '' || f === '~') {
    return '~';
  }
  return f.slice(0, FOLDER_MAX);
}

/** "Leave empty to use the folder's name": the last segment, or the login's home. */
function nameFromFolder(folder) {
  const f = normalizeFolder(folder);
  if (f === '~') {
    return 'home';
  }
  const seg = f.split(/[\\/]/).filter(Boolean).pop();
  return (seg || 'home').slice(0, NAME_MAX);
}

/** The next free name: "site", then "site 2", "site 3" (a duplicate gets " 2" on save, silently);
 *  Duplicate makes "site copy", then "site copy 2". */
function uniqueName(want, taken) {
  const base = String(want || '').trim().slice(0, NAME_MAX) || 'recipe';
  const has = new Set(taken.map((n) => String(n).toLowerCase()));
  if (!has.has(base.toLowerCase())) {
    return base;
  }
  for (let n = 2; n < 1000; n++) {
    const cand = `${base} ${n}`;
    if (!has.has(cand.toLowerCase())) {
      return cand;
    }
  }
  return `${base} ${Date.now()}`;
}

function cleanOptions(o) {
  const out = {};
  for (const [k, v] of Object.entries(o && typeof o === 'object' ? o : {})) {
    if (/^[A-Za-z_][A-Za-z0-9_-]{0,40}$/.test(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
      out[k] = typeof v === 'string' ? v.slice(0, ARGS_MAX) : v;
    }
  }
  return out;
}

function cleanColor(c) {
  if (c === 'auto' || c == null || c === '') {
    return 'auto';
  }
  const n = Number(c);
  return Number.isFinite(n) ? ((Math.round(n) % 360) + 360) % 360 : 'auto';
}

/** One record as stored: every field present, nothing unexpected. */
function normalize(r) {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || typeof r.loginId !== 'string') {
    return null;
  }
  return {
    id: r.id,
    accountId: r.loginId === 'local' ? null : (typeof r.accountId === 'string' ? r.accountId : null),
    name: String(r.name || '').slice(0, NAME_MAX),
    loginId: r.loginId,
    serverId: typeof r.serverId === 'string' ? r.serverId : null,
    folder: normalizeFolder(r.folder),
    programId: typeof r.programId === 'string' ? r.programId : 'shell',
    // 0.12.1 (decided 2026-10-19, the lead , replacing ): a recipe on This machine
    // (loginId 'local'), and "Custom command…" (programId 'custom') with the line the person typed
    runsOn: r.loginId === 'local' ? 'local' : 'server',
    command: typeof r.command === 'string' ? r.command.trim().slice(0, ARGS_MAX) : '',
    // the words as they were when saved ("server · your account", "Claude Code"): for a row whose server or
    // program is gone; resolution always goes by the ids
    where: typeof r.where === 'string' ? r.where.slice(0, 80) : '',
    programLabel: typeof r.programLabel === 'string' ? r.programLabel.slice(0, 60) : '',
    options: cleanOptions(r.options),
    color: cleanColor(r.color),
    logo: raster(r.logo),
    agent: normalizeAgent(r.agent),
    fontSize: normalizeFont(r.fontSize),
    // Preserve unsupported explicit metadata for a refusal, never relabel Always as Auto.
    worktree: worktreeOf(r),
    vendorArgs: Array.isArray(r.vendorArgs)?r.vendorArgs.filter(x=>typeof x==='string').slice(0,32).map(x=>x.slice(0,500)):null,
    vendorFlags: Array.isArray(r.vendorFlags) ? r.vendorFlags.filter(x=>typeof x==='string').slice(0,32).map(x=>x.slice(0,80)) : [],
    unavailableTarget: typeof r.unavailableTarget==='string' ? r.unavailableTarget.slice(0,100) : null,
    importColor: /^#[0-9a-f]{6}$/i.test(r.importColor||'')?r.importColor:null,
    importWorktree: r.importWorktree==='auto'?'auto':'never',
    createdAt: Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
    updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt : Date.now(),
    rev: Number.isFinite(r.rev) ? r.rev : 0,
  };
}

/**
 * The store over `config.recipes`. `persist()` writes config.json; `onChange()` tells the windows.
 * Every verb returns the record it made, or { error } with the page's reason.
 */
function createRecipes({ config, persist, onChange, accountId = undefined, parityEnabled = false }) {
  const owns = (r) => accountId === undefined || r.loginId === 'local' || (!!accountId && r.accountId === accountId);
  const visible = () => all().filter(owns);
  let hooks = {}; // the sync's: saved(rec), removed(rec)
  const all = () => {
    if (!Array.isArray(config.recipes)) {
      config.recipes = [];
    }
    const clean = config.recipes.map(normalize).filter(Boolean);
    if (clean.length !== config.recipes.length) {
      config.recipes = clean;
    }
    return config.recipes;
  };
  const changed = () => {
    persist();
    if (onChange) {
      onChange(list());
    }
  };
  /** Alphabetical by name (the page: drag to reorder is not in 3c). */
  function list() {
    return visible()
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.createdAt - b.createdAt);
  }
  function byId(id) {
    return visible().find((r) => r.id === id) || null;
  }
  /** Create (no id) or update (an id): the form's fields. */
  function save(input) {
    const p = input && typeof input === 'object' ? input : {};
    const existing = typeof p.id === 'string' ? byId(p.id) : null;
    if (typeof p.id === 'string' && !existing) {
      return { error: 'That recipe is gone.' };
    }
    const loginId = typeof p.loginId === 'string' && p.loginId ? p.loginId : existing && existing.loginId;
    if (!loginId) {
      return { error: 'Choose where it runs first.' };
    }
    if (loginId !== 'local' && accountId === null) {
      return { error: 'Sign in to save a server recipe.' };
    }
    const programId = typeof p.programId === 'string' && p.programId ? p.programId : existing && existing.programId;
    if (!programId) {
      return { error: 'Choose what to run.' };
    }
    const command = typeof p.command === 'string' ? p.command : existing ? existing.command : '';
    if (programId === 'custom' && !String(command || '').trim()) {
      return { error: 'Type the command to run.' };
    }
    const parityKeys=['agent','fontSize','worktree'];
    if(parityEnabled!==true&&parityKeys.some(k=>Object.hasOwn(p,k)&&p[k]!==existing?.[k]))return {error:'Recipe options are not available in this build yet.'};
    const parity={...existing,...p,programId,options:p.options!=null?p.options:existing?.options};
    if(parityEnabled===true){const error=validateParity(parity);if(error)return {error};}
    const folder = normalizeFolder(p.folder != null ? p.folder : existing ? existing.folder : '~');
    const wanted = String(p.name == null ? (existing ? existing.name : '') : p.name).trim() || nameFromFolder(folder);
    const others = visible().filter((r) => !existing || r.id !== existing.id).map((r) => r.name);
    const name = existing && wanted.toLowerCase() === existing.name.toLowerCase() ? existing.name : uniqueName(wanted, others);
    const now = Date.now();
    const rec = normalize({
      id: existing ? existing.id : crypto.randomUUID(),
      accountId: loginId === 'local' ? null : accountId,
      name,
      loginId,
      serverId: typeof p.serverId === 'string' ? p.serverId : existing ? existing.serverId : null,
      folder,
      programId,
      where: typeof p.where === 'string' ? p.where : existing ? existing.where : '',
      programLabel: typeof p.programLabel === 'string' ? p.programLabel : existing ? existing.programLabel : '',
      command,
      options: p.options != null ? p.options : existing ? existing.options : {},
      color: p.color != null ? p.color : existing ? existing.color : 'auto',
      logo: Object.hasOwn(p,'logo')?p.logo:existing?.logo,
      agent: Object.hasOwn(p,'agent')?p.agent:existing?.agent,
      fontSize: Object.hasOwn(p,'fontSize')?p.fontSize:existing?.fontSize,
      worktree: Object.hasOwn(p,'worktree')?p.worktree:existing?.worktree,
      vendorFlags: p.vendorFlags??existing?.vendorFlags,
      vendorArgs: Object.hasOwn(p,'vendorArgs')?p.vendorArgs:existing&&p.options?.extraArgs!==undefined&&p.options.extraArgs!==existing.options?.extraArgs?null:existing?.vendorArgs,
      unavailableTarget: Object.hasOwn(p,'unavailableTarget')?p.unavailableTarget:existing?.unavailableTarget,
      importWorktree: p.importWorktree??existing?.importWorktree,
      importColor: Object.hasOwn(p,'importColor')?p.importColor:existing&&p.color!=null&&p.color!==existing.color?null:existing?.importColor,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      rev: existing ? existing.rev : 0,
    });
    const rows = all();
    const i = existing ? rows.findIndex((r) => r.id === existing.id && owns(r)) : -1;
    if (i >= 0) {
      rows[i] = rec;
    } else {
      rows.push(rec);
    }
    changed();
    if (hooks.saved) {
      hooks.saved(rec);
    }
    return rec;
  }
  function importNew(inputs) {
    if(!Array.isArray(inputs)||inputs.length>200||inputs.some(p=>!p||p.id))return {error:'This recipe import is not valid.'};
    const shadow={recipes:all().slice()},temp=createRecipes({config:shadow,accountId,parityEnabled,persist(){}}),added=[];
    for(const input of inputs){const row=temp.save(input);if(row.error)return row;added.push(row);}
    if(added.length){config.recipes=shadow.recipes;changed();for(const row of added)hooks.saved?.(row);}
    return added;
  }
  function remove(id) {
    const rows = all();
    const i = rows.findIndex((r) => r.id === id && owns(r));
    if (i < 0) {
      return { error: 'That recipe is gone.' };
    }
    const [gone] = rows.splice(i, 1);
    changed();
    if (hooks.removed) {
      hooks.removed(gone);
    }
    return gone;
  }
  /** The sync's way in: a record from the account, as is (no name rule, no hooks, no persist of its own). */
  function putQuiet(r) {
    if (accountId !== undefined && (r.loginId === 'local' || !accountId || (byId(r.id) && byId(r.id).loginId === 'local'))) {
      return null; // realm records can never overwrite This machine
    }
    const rec = normalize({ ...r, ...(accountId === undefined ? {} : { accountId }) });
    if (!rec) {
      return null;
    }
    const rows = all();
    const i = rows.findIndex((x) => x.id === rec.id && owns(x));
    if (i >= 0) {
      rows[i] = rec;
    } else {
      rows.push(rec);
    }
    return rec;
  }
  function removeQuiet(id) {
    const rows = all();
    const i = rows.findIndex((x) => x.id === id && owns(x) && (accountId === undefined || x.loginId !== 'local'));
    if (i >= 0) {
      rows.splice(i, 1);
    }
  }
  /** "Duplicate makes 'site copy'". */
  function duplicate(id) {
    const src = byId(id);
    if (!src) {
      return { error: 'That recipe is gone.' };
    }
    const now = Date.now();
    const rec = normalize({ ...src, id: crypto.randomUUID(), name: uniqueName(`${src.name} copy`, visible().map((r) => r.name)), createdAt: now, updatedAt: now, rev: 0 });
    all().push(rec);
    changed();
    if (hooks.saved) {
      hooks.saved(rec);
    }
    return rec;
  }
  return { importNew, list, byId, save, remove, duplicate, putQuiet, removeQuiet, setHooks: (h) => (hooks = h || {}) };
}

module.exports = { createRecipes, normalizeFolder, nameFromFolder, uniqueName, normalize };
