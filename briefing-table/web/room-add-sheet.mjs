/* THE ROOM'S + SHEET (the design system room-add-sheet-v1; Owner 2026-09-28: the +
 * modal was overloaded — seat live sessions, the A2 "project that isn't
 * running" form, Start a new agent, and now apps). ONE sheet, two tabs:
 *
 *   AGENTS — one checklist with ONE action. LIVE TABS: the sessions you can
 *   bring in (GET /api/sessions/readiness; eligibility and its reason are the
 *   ENGINE's, `seatability`, worded here, never decided); a ticked row shows
 *   its dry-run @handle. START FROM A PROJECT: every saved project (recipe);
 *   ticking one opens its choices (the design system 2026-09-28): the @name field (the
 *   dry-run-aware suggestion, the @ inside the field); [New | Resume] (Resume
 *   opens the shared resume picker for that project's past sessions; the
 *   pick shows under it; cancelling with nothing picked snaps back to New;
 *   under New one quiet "forget between runs (fresh)" box, unchecked =
 *   persistent); Model + Effort, whose first option is the recipe's own
 *   value. The row's subtitle summarises the choice. The footer's
 *   "Add N" counts both: sessions are SEATED (POST /api/rooms/assemble, one
 *   dry-run, one idempotency key per open), projects are ADDED AND STARTED
 *   (POST seats {recipe_id, handle, policy} then seats/:id/start with the
 *   {model, effort} overrides, or {resumeSessionId} for a Resume). A start
 *   that fails stays inline on its row; the seat stays never-started with its
 *   own Start, and Add N then only starts it. Options ▸ holds Lead and the
 *   Opening message. "Can't join (N) ▸" stays folded at the bottom.
 *   CUT (the design system): the A2 form, the Window choice, the second primary button,
 *   add-without-start.
 *
 *   APPS — the catalog with each app's state for THIS room (room-add-apps.mjs).
 *
 * A NEW room (the manager's Assemble) is the same sheet with the room's name
 * above the tabs; its apps are added right after the room is made.
 *
 * Desktop: a centred 560px card. Phone: a full-height sheet, 44px targets.
 * Esc closes (the top thing only); a backdrop click does NOT (a stray tap must
 * not lose a selection); focus returns to what opened it.
 *
 * Self-contained: it links its own stylesheet (room-add-sheet.css) and the
 * chrome's .hwb-lift, and mounts on document.body, so the manager and the room
 * page host it the same way.
 */
import { hwbRing, hwbRingFromChrome } from '/aurora/window-chrome/hwb-ring.js';
import { brandMarkPath } from '/aurora/brand-marks/aurora-brand-marks.js';
import { loadBrands, brandFor } from '/brand.mjs';
import { createAppsTab } from '/room-add-apps.mjs';
import { createWorkgroupTab } from '/room-add-workgroup.mjs'; // the Workgroups tab (Owner 2026-10-04,)
import { openResumePicker, sessionLabel } from '/resume-picker.mjs';
import { focusInto } from '/focus-intent.mjs';
import { createMoveTab } from '/room-add-move.mjs'; // the Seats cell's Move tab [rail split] Owner 2026-10-05
import { addSheetTabs } from '/room-workgroups.mjs';

const DRY_RUN_MS = 300;
const MSG_CAP = 4000;
const TOAST_MS = 8000;
const FINISH_MS = 700; // the last tick stays in view this long before the sheet closes
const ELL = String.fromCharCode(8230);
const MDASH = String.fromCharCode(8212);
const RSAQUO = String.fromCharCode(9656); // the ▸ of "Options ▸"
const DSAQUO = String.fromCharCode(9662); // the down triangle
const CHECK = String.fromCharCode(10003);
const MIDDOT = String.fromCharCode(183);

/* Per-start choices for a project (the design system 2026-09-28). The model list mirrors
   the CLI Manager's launch-new list (manager.js MODELS); the effort list is
   the engine's (src/engine/effort.ts), which refuses anything else. */
import { modelsFor, effortsFor } from '/vendor-profile.mjs'; // per vendor, one place (Owner 2026-10-03)
/** vendors whose command line the engine builds (a model applies) */
const MODEL_VENDORS = ['claude-code', 'gemini-cli', 'codex-cli'];
const isClaude = (r) => (r?.vendor || 'claude-code') === 'claude-code';

/* seat.reason (engine `seatability`) → what the `can't join` list says */
const CANT_JOIN = {
  shell: () => 'terminal · not addressable',
  'no-recipe': () => "not a saved project: can't join yet",
  'in-room': (p, room) => {
    const s = (p.seats || []).find((x) => room && x.roomId === room.id);
    return s ? `already here as @${s.handle}` : 'already in this room';
  },
  'not-restorable': () => 'ended: nothing to restore',
  'session-open-elsewhere': (p, _room, panes) => {
    const other = p?.seat?.openIn && (panes || []).find((q) => q.paneid === p.seat.openIn);
    return `same conversation is open in ${other ? (other.title || other.project || other.paneid) : 'another pane'}`;
  },
  'room-archived': () => 'archived: reopen it first',
  'restorable-later': () => 'restorable: Restore it first, then seat it',
  'needs-you': () => 'restorable sessions are seated by Owner',
};
/* refusals the real/dry call adds on top of seatability */
const REFUSED = {
  ...CANT_JOIN,
  'handle-taken': () => 'taken',
  'key-reused': () => 'this sheet already seated a different set: close and reopen',
};

async function call(path, json, method) {
  const init = json === undefined ? { method: method || 'GET' } : { method: method || 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) };
  const res = await fetch(path, init); // cookie credential; never a bearer (humanCredential)
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, ok: res.ok, body };
}
const fail = (e) => ({ ok: false, status: 0, body: { error: e?.message ?? String(e) } });

function mintKey() {
  try { return `asm-${crypto.randomUUID()}`.slice(0, 64); } catch { return `asm-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

/* ------------------------------------------------ handles (new agents) ---- */
const RESERVED_HANDLES = ['room', 'lead', 'all', 'user']; // src/engine/room-vocab.ts
const HANDLE_MAX = 64;

/** The agent-slug normalisation (src/engine/agent-slug.ts), for a finished value. */
function slugify(v) {
  return String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, HANDLE_MAX).replace(/-+$/g, '');
}
/** The same, AS YOU TYPE: a trailing hyphen survives (you are mid-word). */
function typingHandle(v) {
  return String(v ?? '').replace(/^@+/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+/, '').slice(0, HANDLE_MAX);
}
function folderOf(dir) {
  return String(dir || '').split(String.fromCharCode(92)).join('/').split('/').filter(Boolean).pop() || '';
}
/** A plain shell with no agent slug has nothing to address: not seatable. */
function seatableRecipe(r) {
  return !!r && typeof r.id === 'string' && !(r.vendor === 'cli-manager' && !r.agent);
}
/** The recipe's agent slug (else its folder, else its name), suffixed -2, -3 …
 *  past every handle already taken. */
function suggestHandle(r, taken) {
  const base = slugify(r?.agent) || slugify(folderOf(r?.projectDir)) || slugify(r?.name) || 'agent';
  const free = (h) => !taken.has(h) && !RESERVED_HANDLES.includes(h);
  if (free(base)) { return base; }
  for (let n = 2; ; n++) {
    const sfx = `-${n}`;
    const h = base.slice(0, HANDLE_MAX - sfx.length).replace(/-+$/g, '') + sfx;
    if (free(h)) { return h; }
  }
}

/* ---------------------------------------------------------------- styles ---- */
function injectStyles() {
  const link = (href, test) => {
    if (!document.querySelector(`link[href*="${test}"]`)) {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      document.head.append(l);
      return l;
    }
    return null;
  };
  /* .hwb-lift lives in the chrome sheet; a host page that has not linked it
     (the manager, the room page) gets it here, from the same pin */
  link('/aurora/window-chrome/hwb-chrome.css', 'window-chrome/hwb-chrome.css');
  return link('/room-add-sheet.css', 'room-add-sheet.css');
}

/* ------------------------------------------------------------------ glyph ---- */
function glyph(p, isLead, size = 32) {
  const b = brandFor(p.vendor || 'unknown');
  const el = document.createElement('span');
  el.className = 'ras-glyph';
  let spec = null;
  if (p.state === 'dehydrated') {
    spec = hwbRingFromChrome('restorable', {});
  } else if (p.state === 'live' && p.claudeRunning !== false) {
    /* claude not running in it = not running: plate-only (§3.2, NOTE-1) */
    spec = hwbRingFromChrome(p.activity || 'idle', { attached: !!p.attached });
  }
  el.dataset.state = spec ? 'ring' : 'none';
  const opts = { brand: b.brand || 'generic', markPath: brandMarkPath(b.brand || 'generic'), primary: !!isLead };
  try {
    hwbRing(el, spec, size, opts); // spec null = plate-only (v25+): not running
  } catch {
    hwbRing(el, hwbRingFromChrome('ended', {}), size, opts); // pre-v25 pin
  }
  if (b.brandColor) { el.style.setProperty('--brand-src', b.brandColor); }
  el.classList.add('ctx-aggregate');
  return el;
}

function mk(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) { e.className = cls; }
  if (text !== undefined) { e.textContent = text; }
  return e;
}
function button(cls, text, fid) {
  const b = mk('button', cls, text);
  b.type = 'button';
  if (fid) { b.dataset.fid = fid; }
  return b;
}
const phone = () => window.matchMedia('(max-width: 600px)').matches;

/* ------------------------------------------------------------------ sheet ---- */
/**
 * @param {object} o
 * @param {object|null} o.room       fixed room ({id, name, lead_seat, seats}) — the room's +
 * @param {'agents'|'workgroups'|'apps'|'move'} [o.tab]  the tab to open on
 * @param {'room'|'seats'|null} [o.scope]  [rail split] Owner 2026-10-05: 'room' = the Room cell's + (Workgroup, App tabs only),
 *        'seats' = the Seats cell's + (Add | Move, "Adding to <name>"); unset = the manager's three tabs
 * @param {object|null} [o.family]  the room view's `family` (the Move tab's sources)
 * @param {((answer, open)=>void)|null} o.onWorkgroup  a workgroup was created (the Workgroups tab); `open` = the person asked to go there
 * @param {string[]}    o.windowTabs this window's session paneids (pre-checked; sort first)
 * @param {string|null} o.activePaneid the shell's active tab (lead default)
 * @param {(ans)=>void} o.onSeated   after a committed Add ({room, ...}); the manager opens the room
 * @param {(seat, path, answer)=>void} o.onStarted  a NEW agent was started from a
 *        project; `path` is the fresh pane's page (the room selects that seat)
 * @param {(()=>void)|null} o.onRoomChanged  something was written but the sheet
 *        stayed open (a start failed, an app was added): refresh
 * @param {((body)=>Promise|void)|null} o.applied  fold a route's answer in
 *        (entries + a re-GET); the room page's own. Defaults to onRoomChanged.
 */
export async function openAddSheet(o = {}) {
  const sheetCss = injectStyles();
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const fixed = o.room || null;
  const windowTabs = new Set(Array.isArray(o.windowTabs) ? o.windowTabs : []);
  const st = {
    tab: o.scope === 'seats' ? (o.tab === 'move' ? 'move' : 'agents')
      : o.scope === 'room' ? (o.tab === 'workgroups' && fixed && !fixed.parent_id ? 'workgroups' : 'apps')
      : o.tab === 'apps' ? 'apps' : o.tab === 'workgroups' && fixed && !fixed.parent_id ? 'workgroups' : 'agents',
    key: mintKey(),
    panes: [],
    rooms: [],
    recipes: [],
    selected: new Set(), // paneids
    handles: new Map(), // paneid → a handle the user typed
    derived: new Map(), // paneid → {handle, autoSuffixed, outcome, reason}
    skip: new Set(), // refused on a real 409: excluded from the next Add
    editing: null, // paneid whose @handle is being edited
    projects: new Map(), // recipeId → {handle, suggested, policy, error, created, how, pick, fresh, model, effort}
    /* a project's per-start choices OUTLIVE an untick (the design system r23 review): the
       COLLAPSED row's subtitle summarises them, and ticking it again brings
       them back. recipeId → {how, pick, fresh, model, effort} */
    choices: new Map(),
    mode: fixed ? 'existing' : 'new',
    newName: '',
    existingId: fixed ? fixed.id : '',
    made: null, // a room THIS sheet made ({id, name, …}): a retry adds to it
    extraTaken: new Set(),
    lead: '', // a pane id or `rec:<id>`, or '' = default / keep
    leadTouched: false,
    optsOpen: false,
    msgOn: false,
    msgText: '',
    msgTouched: false,
    busy: false,
    going: false, // Add is in flight (busy also covers a dry-run)
    started: [], // {seat, path, answer} of every project started from this sheet
    ans: null, // what the Add committed (the room), for the landing
    dryTimer: 0,
    dryGen: 0,
    cantOpen: false,
    error: '',
  };

  /* ---- the frame ---- */
  const scrim = mk('div', 'ras-scrim');
  const sheet = mk('div', 'ras-sheet');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'rasTitle');
  scrim.append(sheet);
  document.body.append(scrim);
  /* a first open waits for the stylesheet, or the sheet flashes unstyled */
  if (sheetCss && !sheetCss.sheet) {
    await new Promise((r) => { sheetCss.addEventListener('load', r, { once: true }); sheetCss.addEventListener('error', r, { once: true }); setTimeout(r, 1500); });
  }

  let closed = false;
  let dlg = null; // the open alertdialog, if any
  let toastTimer = 0;
  const onKey = (ev) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      ev.preventDefault();
      if (dlg) {
        dlg.close();
      } else {
        close();
      }
    } else if (ev.key === 'Tab') {
      trapTab(ev, dlg ? dlg.card : sheet);
    }
  };
  document.addEventListener('keydown', onKey, true);
  function close() {
    if (closed) { return; }
    closed = true;
    clearTimeout(st.dryTimer);
    clearTimeout(toastTimer);
    document.removeEventListener('keydown', onKey, true);
    scrim.remove();
    if (opener?.isConnected) {
      opener.focus({ preventScroll: true });
    }
  }
  /** Tab stays inside the sheet (or the dialog on top of it). */
  function trapTab(ev, box) {
    const f = [...box.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((x) => !x.disabled && x.offsetParent !== null && x.getAttribute('tabindex') !== '-1');
    if (!f.length) { return; }
    const i = f.indexOf(document.activeElement);
    if (ev.shiftKey && (i <= 0)) {
      ev.preventDefault();
      f[f.length - 1].focus();
    } else if (!ev.shiftKey && (i === f.length - 1 || i < 0)) {
      ev.preventDefault();
      f[0].focus();
    }
  }

  const targetRoom = () => (st.made ? st.made
    : st.mode === 'existing' ? (fixed || st.rooms.find((r) => r.id === st.existingId) || null) : null);
  const applied = async (body) => {
    if (o.applied) {
      await o.applied(body);
    } else {
      o.onRoomChanged?.();
    }
  };

  const apps = createAppsTab({
    call: (path, json, method) => call(path, json, method),
    roomId: () => targetRoom()?.id ?? null,
    render: () => render(),
    toast: (text, act) => toast(text, act),
    dialog: (spec) => openDialog(spec),
    applied,
  });

  /* THE WORKGROUPS TAB: only in a MAIN room (a workgroup holds no workgroups) */
  const canWorkgroup = !!fixed && !fixed.parent_id && fixed.state !== 'archived' && document.documentElement.dataset.edition !== 'basic'; // Basic has no workgroups [basic]
  const wgTab = canWorkgroup ? createWorkgroupTab({
    call: (path, json, method) => call(path, json, method),
    room: () => fixed,
    recipes: () => st.recipes,
    render: () => render(),
    mk,
    button,
    checkRow: (...a) => checkRow(...a),
    secHead: (...a) => secHead(...a),
    glyph: (...a) => glyph(...a),
    handleField: (...a) => handleField(...a),
    done: (ans, open) => {
      close();
      o.onWorkgroup?.(ans, open);
    },
  }) : null;

  /* THE MOVE TAB (Seats cell only): an agent from elsewhere in the family, moved HERE */
  const moveTab = o.scope === 'seats' && fixed ? createMoveTab({
    call: (path, json, method) => call(path, json, method),
    room: () => fixed,
    family: () => o.family ?? null,
    render: () => render(),
    mk,
    button,
    glyph: (...a) => glyph(...a),
    checkRow: (...a) => checkRow(...a),
    secHead: (...a) => secHead(...a),
    applied,
    toast: (text) => toast(text),
  }) : null;

  sheet.innerHTML = `<div class="ras-empty">loading${ELL}</div>`;
  const roomQ = fixed ? `?room=${encodeURIComponent(fixed.id)}` : '';
  const [rd, rooms, recs] = await Promise.all([
    call(`/api/sessions/readiness${roomQ}`).catch(fail),
    fixed ? Promise.resolve({ ok: true, body: [] }) : call('/api/rooms').catch(fail),
    call('/api/recipes').catch(fail),
    loadBrands().catch(() => {}),
  ]);
  if (closed) { return { close }; }
  st.panes = Array.isArray(rd.body?.panes) ? rd.body.panes : [];
  st.rooms = Array.isArray(rooms.body) ? rooms.body.map((v) => v.room).filter((r) => r && r.id) : [];
  const recList = Array.isArray(recs?.body?.recipes) ? recs.body.recipes : [];
  st.recipes = recList.filter(seatableRecipe).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (!rd.ok) {
    st.error = `could not list sessions ${MDASH} ${rd.body?.error ?? `HTTP ${rd.status}`}`;
  } else if (!recs.ok) {
    st.error = `could not list projects ${MDASH} ${recs.body?.error ?? `HTTP ${recs.status}`}`;
  }
  for (const p of st.panes) {
    if (p.seat?.eligible && windowTabs.has(p.paneid)) {
      st.selected.add(p.paneid);
    }
  }
  if (o.activePaneid && st.selected.has(o.activePaneid)) {
    st.lead = o.activePaneid;
  }
  void apps.load();

  const eligible = () => st.panes.filter((p) => p.seat?.eligible);
  const ineligible = () => st.panes.filter((p) => !p.seat?.eligible);
  const sortKey = (p) => (windowTabs.has(p.paneid) ? 0 : p.state === 'live' && p.attached ? 1 : p.state === 'live' ? 2 : 3);
  const chosen = () => [...st.selected].filter((id) => !st.skip.has(id));
  const handleOf = (id) => st.handles.get(id) ?? st.derived.get(id)?.handle ?? '';
  const recipeOf = (id) => st.recipes.find((r) => r.id === id) || null;
  const projHandle = (rid) => slugify(st.projects.get(rid)?.handle);
  /** what the Add button counts: seated sessions + projects to add/start */
  /** projects still to add / start (a started one shows its tick until the sheet closes) */
  const openProjects = () => [...st.projects].filter(([, p]) => p.phase !== 'done');
  const count = () => chosen().length + openProjects().length;
  /** every chosen item as a lead candidate key, in list order */
  const persistentKeys = () => [...chosen(), ...openProjects().filter(([, p]) => p.policy === 'persistent').map(([rid]) => `rec:${rid}`)];
  const keyHandle = (k) => (k.startsWith('rec:') ? projHandle(k.slice(4)) : handleOf(k));

  function takenHandles(exceptRid) {
    const t = new Set();
    const r = targetRoom();
    for (const s of (r?.seats || fixed?.seats || [])) {
      if (s && !s.left_at && s.handle) { t.add(s.handle); }
    }
    for (const id of chosen()) {
      const h = handleOf(id);
      if (h) { t.add(h); }
    }
    for (const [rid, p] of st.projects) {
      if (rid !== exceptRid && slugify(p.handle)) { t.add(slugify(p.handle)); }
    }
    for (const h of st.extraTaken) { t.add(h); }
    return t;
  }
  /** a suggested (not typed) project handle follows what else is taken */
  function refreshSuggestions() {
    for (const [rid, p] of st.projects) {
      if (p.created) { continue; }
      if (!p.handle || p.handle === p.suggested) {
        p.suggested = suggestHandle(recipeOf(rid), takenHandles(rid));
        p.handle = p.suggested;
      }
    }
  }
  /** why a project cannot go yet ('' = it can): refusals the page can know */
  function projNeed(rid) {
    const p = st.projects.get(rid);
    const h = projHandle(rid);
    if (!h) { return 'name it'; }
    if (RESERVED_HANDLES.includes(h)) { return `@${h} is reserved`; }
    if (!p.created && takenHandles(rid).has(h)) { return `@${h} is already taken in this room`; }
    return '';
  }

  function effectiveLead() {
    const pk = persistentKeys();
    if (st.lead && pk.includes(st.lead)) { return st.lead; }
    if (targetRoom()) { return ''; } // keep the current lead
    return pk[0] || '';
  }
  function currentLeadHandle() {
    const r = targetRoom();
    const seats = r?.seats || [];
    return seats.find?.((s) => s.id === r.lead_seat)?.handle || null;
  }
  function prefill() {
    const hs = [...chosen().map((id) => handleOf(id)), ...[...st.projects.keys()].map(projHandle)].map((h) => `@${h || '?'}`);
    const lead = effectiveLead();
    const leadH = lead ? `@${keyHandle(lead)}` : (targetRoom() ? `@${currentLeadHandle() || 'the lead'}` : '@the lead');
    const name = targetRoom()?.name || st.newName || 'this room';
    return `You're in room "${name}" with ${hs.join(', ') || 'no one yet'}. ${leadH} leads; I'll work through ${leadH}. No reply needed: the room shows me when you've read this. Talk to each other when the work needs it.`;
  }
  const msgOver = () => st.msgOn && st.msgText.length > MSG_CAP;
  const message = () => (st.msgOn && st.msgText.trim() ? st.msgText : '');

  function body(dryRun) {
    /* handles do not depend on the name, so an unnamed NEW room still
       dry-runs (under a placeholder that is rolled back with the rest) */
    const tr = targetRoom();
    const r = tr ? { id: tr.id } : { name: st.newName.trim() || (dryRun ? 'Unnamed room' : '') };
    const b = {
      room: r,
      key: st.key,
      dryRun,
      seats: chosen().map((id) => {
        const s = { occupant: id, policy: 'persistent' };
        if (st.handles.has(id)) { s.handle = st.handles.get(id); }
        return s;
      }),
    };
    const lead = effectiveLead();
    if (lead && !lead.startsWith('rec:') && (!tr || st.leadTouched)) { b.lead = lead; }
    /* the opening message rides the assemble only when nothing else is
       added: projects start after it, so then it goes on the line at the end */
    const m = dryRun || openProjects().length ? '' : message();
    if (m) {
      b.conventions = `${tr ? chosen().map((id) => `@${handleOf(id)}`).join(' ') : '@room'} ${m}`.slice(0, MSG_CAP + 200);
    }
    return b;
  }

  function roomReady() {
    return targetRoom() ? true : st.newName.trim().length > 0 && st.newName.trim().length <= 200;
  }

  function scheduleDry() {
    clearTimeout(st.dryTimer);
    const canDry = targetRoom() ? true : st.newName.trim().length <= 200;
    if (!canDry || chosen().length === 0) {
      st.dryGen++; // a dry-run in flight is stale now
      st.busy = false;
      st.derived.clear();
      refreshSuggestions();
      render();
      return;
    }
    st.busy = true;
    refreshSuggestions();
    render();
    const gen = ++st.dryGen;
    st.dryTimer = setTimeout(async () => {
      const r = await call('/api/rooms/assemble', body(true)).catch(fail);
      if (closed || gen !== st.dryGen) { return; }
      st.busy = false;
      applyResults(r.body?.results);
      if (!r.ok && !r.body?.results) {
        st.error = r.body?.error ?? `HTTP ${r.status}`;
      } else if (r.ok) {
        st.error = '';
      }
      refreshSuggestions();
      render();
    }, DRY_RUN_MS);
  }

  function applyResults(results) {
    if (!Array.isArray(results)) { return; }
    for (const x of results) {
      st.derived.set(x.paneid, { handle: x.handle, autoSuffixed: !!x.autoSuffixed, outcome: x.outcome, reason: x.reason });
    }
  }

  function need() {
    if (count() === 0 && !(st.mode === 'new' && !st.made && apps.pendingCount())) { return 'tick a tab or a project'; }
    if (!roomReady()) { return st.mode === 'new' ? 'name the room' : 'pick a room'; }
    if (msgOver()) { return 'the message is too long'; }
    for (const [rid] of openProjects()) {
      const n = projNeed(rid);
      if (n) { return `@${projHandle(rid) || recipeOf(rid)?.name || 'a project'}: ${n}`; }
    }
    return '';
  }

  /* -------------------------------------------------------------- Add N ---- */
  async function go() {
    if (st.busy || need()) { return; }
    st.busy = true;
    st.going = true;
    st.error = '';
    render();
    const hadProjects = openProjects().length > 0;
    const chosenAtStart = chosen().length > 0;
    const madeHere = !targetRoom();
    let ans = null;
    const problems = [];
    const seatedHandles = [];
    const newLead = effectiveLead();
    /* 1. the live tabs: ONE assemble (a new room is made by it) */
    if (chosen().length) {
      const r = await call('/api/rooms/assemble', body(false)).catch(fail);
      if (closed) { return; }
      if (!r.ok) {
        st.busy = false;
        st.going = false;
        if (r.status === 409 && Array.isArray(r.body?.results)) {
          applyResults(r.body.results);
          const names = [];
          for (const x of r.body.results) {
            if (x.outcome === 'refused') {
              st.skip.add(x.paneid);
              const p = st.panes.find((q) => q.paneid === x.paneid);
              const why = (REFUSED[x.reason] ?? (() => x.reason))(p || {}, targetRoom(), st.panes);
              names.push(`${p?.title || p?.project || x.paneid} can't be seated: ${why}.`);
            }
          }
          st.error = `${names.join(' ')} Add ${count()} skips ${names.length === 1 ? 'it' : 'them'}.`;
        } else {
          st.error = `not added ${MDASH} ${r.body?.error ?? `HTTP ${r.status}`}${r.body?.field ? ` (${r.body.field})` : ''}`;
        }
        render();
        return;
      }
      ans = r.body;
      for (const x of ans.results || []) {
        if (x.outcome === 'seated' || x.outcome === 'already') {
          seatedHandles.push(x.handle);
          st.extraTaken.add(x.handle);
        }
        st.selected.delete(x.paneid);
      }
      st.skip.clear();
      st.derived.clear();
      st.key = mintKey(); // what that key committed is done; a retry is a new set
      if (!targetRoom() && ans.room?.id) {
        st.made = { ...ans.room, seats: ans.seats || [] };
      }
    }
    /* 2. a NEW room with no live tab in it: made here */
    if (!targetRoom()) {
      const r = await call('/api/rooms', { name: st.newName.trim() }).catch(fail);
      if (closed) { return; }
      if (!r.ok || !r.body?.id) {
        st.busy = false;
        st.going = false;
        st.error = `room not made ${MDASH} ${r.body?.error ?? `HTTP ${r.status}`}`;
        render();
        return;
      }
      st.made = { ...r.body, seats: [] };
      ans = { room: r.body };
    }
    const room = targetRoom();
    const base = `/api/rooms/${encodeURIComponent(room.id)}/seats`;
    let leadSeat = null;
    /* 3. the projects: each added, then started, IN VIEW (the design system cut
       requirement: the sheet stays open; "starting..." then a tick per row) */
    for (const [rid] of openProjects()) {
      const r = await addAndStart(rid, base);
      if (closed) { return; }
      if (r.seat) {
        if (newLead === `rec:${rid}`) { leadSeat = r.seat.id; }
        seatedHandles.push(r.seat.handle);
      }
      if (r.problem) {
        problems.push(r.problem);
      }
    }
    /* 4. a project named as lead */
    if (leadSeat && (st.leadTouched || st.mode === 'new')) {
      const r = await call(`/api/rooms/${encodeURIComponent(room.id)}`, { lead_seat: leadSeat }, 'PATCH').catch(fail);
      if (!r.ok) { problems.push(`lead not set: ${r.body?.error ?? `HTTP ${r.status}`}`); }
    }
    /* 5. the opening message: the assemble carried it when only live tabs
       were added; with projects it goes on the line once they are in */
    const m = message();
    if (m && hadProjects && seatedHandles.length) {
      const to = madeHere ? '@room' : seatedHandles.map((h) => `@${h}`).join(' ');
      const r = await call(`/api/rooms/${encodeURIComponent(room.id)}/line`, { text: `${to} ${m}` }).catch(fail);
      if (!r.ok || r.body?.status === 'refused' || r.body?.status === 'confirm') {
        problems.push(`the opening message was not sent (${r.body?.error ?? r.body?.status ?? `HTTP ${r.status}`}): send it from the line`);
      } else {
        st.msgOn = false;
      }
    } else if (m && !hadProjects && chosenAtStart) {
      st.msgOn = false; // the assemble sent it
    }
    /* 6. a NEW room's apps */
    if (apps.pendingCount()) {
      problems.push(...await apps.applyPending());
    }
    if (closed) { return; }
    st.busy = false;
    st.going = false;
    st.ans = ans ? { ...ans, room: ans.room?.id ? ans.room : room } : { room };
    if (problems.length) {
      st.error = `${problems.join('; ')}.`;
      refreshSuggestions();
      render();
      o.onRoomChanged?.();
      return;
    }
    finish();
  }

  /** Add (unless already added) and start ONE project, drawing its phase on
   *  its row. -> {seat?, problem?} */
  async function addAndStart(rid, base) {
    const p = st.projects.get(rid);
    const handle = projHandle(rid);
    p.error = '';
    p.phase = 'starting';
    render();
    let seat = p.created && p.created.handle === handle ? p.created : null;
    if (!seat) {
      const add = await call(base, { recipe_id: rid, handle, policy: p.policy }).catch(fail);
      if (closed) { return {}; }
      if (!add.ok || !add.body?.seat?.id) {
        p.phase = 'failed';
        p.error = `not added ${MDASH} ${add.body?.error ?? `HTTP ${add.status}`}`;
        render();
        return { problem: `@${handle} not added` };
      }
      seat = { id: add.body.seat.id, handle: add.body.seat.handle || handle };
      p.created = seat;
      st.extraTaken.add(seat.handle);
    }
    const start = await call(`${base}/${encodeURIComponent(seat.id)}/start`, startBody(p)).catch(fail);
    if (closed) { return { seat }; }
    if (!start.ok) {
      /* the seat stays (never-started; its own Start works): never deleted */
      p.phase = 'failed';
      p.error = `@${seat.handle} was added but not started ${MDASH} ${start.body?.error ?? `HTTP ${start.status}`}. It stays in the room, never started.`;
      render();
      return { seat, problem: `@${seat.handle} not started` };
    }
    p.phase = 'done';
    st.started.push({ seat: start.body?.seat || seat, path: start.body?.path || null, answer: start.body });
    render();
    return { seat };
  }

  /** The seat start's body: the launch placement, then the per-start choices
   *  — a Resume names the picked session (the launch route's picker door), a
   *  New carries only what differs from the recipe (nothing = a plain start). */
  function startBody(p) {
    const b = { target: 'tab', surface: 'browser' };
    if (p.how === 'resume' && p.pick) {
      b.resumeSessionId = p.pick.sessionId;
    }
    if (p.model) { b.model = p.model; }
    if (p.effort) { b.effort = p.effort; }
    return b;
  }

  /** A failed row's own "Retry start": only that start; the sheet closes by
   *  itself once every project is in. */
  async function retryStart(rid) {
    const room = targetRoom();
    const p = st.projects.get(rid);
    if (!room || !p || p.phase === 'starting' || st.busy) { return; }
    st.busy = true;
    const r = await addAndStart(rid, `/api/rooms/${encodeURIComponent(room.id)}/seats`);
    if (closed) { return; }
    st.busy = false;
    o.onRoomChanged?.();
    if (!r.problem && !openProjects().length) {
      st.error = '';
      finish();
      return;
    }
    render();
  }

  /** everything went in: let the ticks be seen, then close and land */
  function finish() {
    const ans = st.ans;
    const started = st.started;
    render();
    setTimeout(() => {
      if (closed) { return; }
      close();
      o.onSeated?.(ans);
      const last = started[started.length - 1];
      if (last) {
        o.onStarted?.(last.seat, last.path, last.answer);
      }
    }, started.length ? FINISH_MS : 0);
  }

  function addLabel() {
    const agents = count();
    const appsN = st.mode === 'new' && !st.made ? apps.pendingCount() : 0;
    const n = agents + appsN;
    const skip = [...st.selected].filter((id) => st.skip.has(id)).length;
    const lead = effectiveLead();
    const handover = !!targetRoom() && st.leadTouched && lead;
    const verb = st.mode === 'new' && !st.made ? 'Create room' : 'Add';
    const label = verb === 'Add' ? `Add ${n || ''}`.trim() : n ? `Create room · add ${n}` : 'Create room';
    const also = [];
    if (skip) { also.push(`skips ${skip}`); }
    if (handover) { also.push(`@${keyHandle(lead)} becomes lead`); }
    if (message()) { also.push('an opening message'); }
    const tip = [agents ? `${agents} agent${agents === 1 ? '' : 's'}` : '', appsN ? `${appsN} app${appsN === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
    return { label, also: also.length ? `also: ${also.join(' · ')}` : '', tip };
  }

  /* ---------------------------------------------------------- toast ---- */
  function toast(text, act) {
    sheet.querySelector('.ras-toast')?.remove();
    clearTimeout(toastTimer);
    const t = mk('div', 'ras-toast');
    t.setAttribute('role', 'status');
    t.append(mk('span', '', text));
    if (act) {
      const b = button('', act.label, 'toast-act');
      b.addEventListener('click', async () => {
        clearTimeout(toastTimer);
        b.disabled = true;
        try { await act.run(); } catch { /* the row says it */ }
        t.remove();
      });
      t.append(b);
    }
    sheet.append(t);
    toastTimer = setTimeout(() => t.remove(), TOAST_MS);
  }

  /* ----------------------------------------------------- alertdialog ---- */
  /** spec: {title, intro, lines[], cancel, ok, err, busy, onOk(d)} */
  function openDialog(spec) {
    dlg?.close();
    const back = document.activeElement;
    const ds = mk('div', 'ras-dscrim');
    const card = mk('div', 'ras-card');
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'rasDlgH');
    card.setAttribute('aria-describedby', 'rasDlgB');
    ds.append(card);
    sheet.append(ds);
    const d = {
      card,
      close() {
        if (dlg !== d) { return; }
        ds.remove();
        dlg = null;
        spec.onClose?.();
        if (back?.isConnected) { back.focus({ preventScroll: true }); } else { sheet.querySelector('[role="tab"][aria-selected="true"]')?.focus(); }
      },
      update() {
        const had = document.activeElement?.dataset?.a;
        card.textContent = '';
        const hd = mk('div', 'hd', spec.title);
        hd.id = 'rasDlgH';
        const bd = mk('div', 'bd');
        bd.id = 'rasDlgB';
        bd.append(spec.intro);
        if (spec.lines.length) {
          const ul = mk('ul');
          for (const t of spec.lines) { ul.append(mk('li', t.cls || '', t.text ?? t)); }
          bd.append(ul);
        }
        if (spec.err) {
          const e = mk('div', 'ras-derr', spec.err);
          e.setAttribute('role', 'status');
          bd.append(e);
        }
        const cf = mk('div', 'cf');
        const no = button('ras-btn', spec.cancel, 'dlg-no');
        no.dataset.a = 'cancel';
        const yes = button('ras-btn warn', spec.busy ? `${spec.ok}${ELL}` : spec.ok, 'dlg-yes');
        yes.dataset.a = 'ok';
        yes.disabled = !!spec.busy;
        no.addEventListener('click', () => d.close());
        yes.addEventListener('click', () => {
          Promise.resolve(spec.onOk(d)).catch((e) => {
            spec.busy = false;
            spec.err = `${MDASH} ${e?.message ?? e}`;
            d.update();
          });
        });
        cf.append(no, yes);
        card.append(hd, bd, cf);
        focusInto(had === 'ok' && !yes.disabled ? yes : no);
      },
    };
    dlg = d;
    d.update();
  }

  /* ------------------------------------------------------------ render ---- */
  function render() {
    if (closed) { return; }
    const keepFocus = document.activeElement && sheet.contains(document.activeElement) ? document.activeElement.dataset.fid : null;
    const keepSel = document.activeElement?.selectionStart;
    const bodyEl = sheet.querySelector('.ras-body');
    const keepScroll = bodyEl ? bodyEl.scrollTop : 0;
    const keepToast = sheet.querySelector('.ras-toast');
    const keepDlg = dlg ? sheet.querySelector('.ras-dscrim') : null;
    sheet.textContent = '';

    /* head */
    const sh = mk('div', 'ras-sh');
    const tr = targetRoom();
    const t = mk('span', 't', tr ? `Add to ${tr.name}` : st.mode === 'existing' ? 'Add to a room' : 'New room');
    t.id = 'rasTitle';
    const x = button('ras-x', '', 'x');
    x.setAttribute('aria-label', 'Close');
    x.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13"/></svg>';
    x.addEventListener('click', close);
    sh.append(t, x);
    sheet.append(sh);

    /* THE ROOM (the manager): a segmented [New room | Existing room], then
       EITHER the name field OR a room select in the same slot (the design system; no
       mixed select) */
    if (!fixed && !st.made) {
      const rr = mk('div', 'ras-room');
      const seg = mk('div', 'ras-mode');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'Room');
      const anyOpen = st.rooms.some((r) => r.state === 'open');
      for (const [val, text] of [['new', 'New room'], ['existing', 'Existing room']]) {
        const b = button('', text, `mode-${val}`);
        b.setAttribute('aria-pressed', String(st.mode === val));
        if (val === 'existing' && !anyOpen) {
          b.disabled = true;
          b.title = 'No open rooms yet';
        }
        b.addEventListener('click', () => {
          if (st.mode === val) { return; }
          st.mode = val;
          st.skip.clear();
          st.lead = '';
          st.leadTouched = false;
          void apps.load();
          scheduleDry();
        });
        seg.append(b);
      }
      rr.append(seg);
      if (st.mode === 'new') {
        const f = mk('label', 'ras-fld ras-name');
        const nm = mk('input');
        nm.type = 'text';
        nm.placeholder = 'Room name';
        nm.maxLength = 220;
        nm.value = st.newName;
        nm.dataset.fid = 'newname';
        nm.setAttribute('aria-label', 'New room name');
        nm.addEventListener('input', () => { st.newName = nm.value; scheduleDry(); });
        f.append(nm);
        rr.append(f);
      } else {
        const sel = mk('select', 'ras-sel ras-rsel');
        sel.dataset.fid = 'room';
        sel.setAttribute('aria-label', 'Existing room');
        const none = mk('option', '', 'Pick a room');
        none.value = '';
        sel.append(none);
        for (const r of st.rooms) {
          const op = mk('option', '', r.state === 'open' ? r.name : `${r.name} (archived: reopen it first)`);
          op.value = r.id;
          op.disabled = r.state !== 'open';
          sel.append(op);
        }
        sel.value = st.existingId;
        sel.addEventListener('change', () => {
          st.existingId = sel.value;
          st.skip.clear();
          st.lead = '';
          st.leadTouched = false;
          void apps.load();
          scheduleDry();
        });
        rr.append(sel);
      }
      sheet.append(rr);
      if (st.mode === 'new' && st.newName.trim().length > 200) {
        sheet.append(mk('div', 'ras-err ras-inset', 'a room name is at most 200 characters'));
      }
    }

    /* the segmented tabs: a lifted selected segment, no underline */
    const seg = mk('div', 'ras-seg');
    seg.setAttribute('role', 'tablist');
    seg.setAttribute('aria-label', 'Add');
    const countOf = { agents: count, workgroups: () => wgTab?.count() ?? 0, apps: () => apps.count(), move: () => moveTab?.count() ?? 0 };
    const scoped = addSheetTabs(o.scope, !!wgTab);
    const tabs = scoped
      ? scoped.map(([id, text]) => [id, text, id === 'move' ? 0 : countOf[id]()])
      : [['agents', 'Agents', count()], ...(wgTab ? [['workgroups', 'Workgroups', wgTab.count()]] : []), ['apps', 'Apps', apps.count()]];
    for (const [id, text, n] of tabs) {
      const b = button('', '', `tab-${id}`);
      b.id = `rasTab-${id}`;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(st.tab === id));
      b.setAttribute('aria-controls', 'rasPanel');
      b.tabIndex = st.tab === id ? 0 : -1;
      b.append(text);
      if (n) { b.append(mk('span', 'n', String(n))); }
      b.addEventListener('click', () => setTab(id));
      b.addEventListener('keydown', (e) => {
        const order = tabs.map((q) => q[0]);
        const i = order.indexOf(id);
        let j = null;
        if (e.key === 'ArrowRight') { j = (i + 1) % order.length; }
        if (e.key === 'ArrowLeft') { j = (i + order.length - 1) % order.length; }
        if (e.key === 'Home') { j = 0; }
        if (e.key === 'End') { j = order.length - 1; }
        if (j !== null) {
          e.preventDefault();
          setTab(order[j]);
          sheet.querySelector(`#rasTab-${order[j]}`)?.focus();
        }
      });
      seg.append(b);
    }
    sheet.append(seg);

    /* the body: ONE scroller */
    const box = mk('div', 'ras-body');
    box.id = 'rasPanel';
    box.setAttribute('role', 'tabpanel');
    box.setAttribute('aria-labelledby', `rasTab-${st.tab}`);
    if (st.tab === 'apps') {
      if (o.scope === 'room' && targetRoom()) {
        /* apps belong to the WHOLE family (Owner 2026-10-05): this adds to the main room, whichever row is selected */
        const ad = mk('div', 'ras-adding');
        ad.dataset.fid = 'adding';
        ad.append('Adding to ', mk('b', '', targetRoom().name), ' and its workgroups');
        box.append(ad);
      }
      apps.body(box);
    } else if (st.tab === 'workgroups' && wgTab) {
      wgTab.body(box);
    } else if (st.tab === 'move' && moveTab) {
      moveTab.body(box);
    } else {
      if (o.scope === 'seats' && targetRoom()) {
        /* [rail split] new seats go into the room named at the top */
        const ad = mk('div', 'ras-adding');
        ad.dataset.fid = 'adding';
        ad.append('Adding to ');
        if (fixed?.parent_id) { ad.append(mk('span', 'sub-plate sm')); }
        ad.append(mk('b', '', targetRoom().name));
        box.append(ad);
      }
      agentsBody(box);
    }
    sheet.append(box);

    /* the footer */
    const ft = mk('div', 'ras-ft');
    if (st.tab === 'apps' && targetRoom()) {
      apps.footer(ft, close);
    } else if (st.tab === 'workgroups' && wgTab) {
      wgTab.footer(ft, close);
    } else if (st.tab === 'move' && moveTab) {
      moveTab.footer(ft, close);
    } else {
      agentsFooter(ft);
    }
    sheet.append(ft);
    if (keepToast) { sheet.append(keepToast); }
    if (keepDlg) { sheet.append(keepDlg); }

    box.scrollTop = keepScroll;
    if (keepFocus) {
      const f = sheet.querySelector(`[data-fid="${CSS.escape(keepFocus)}"]`);
      if (f) {
        focusInto(f); // a re-render keeps focus; a tap-driven one keeps it quiet
        if (typeof keepSel === 'number' && typeof f.setSelectionRange === 'function') {
          try { f.setSelectionRange(keepSel, keepSel); } catch { /* not a text field */ }
        }
      }
    }
  }

  function setTab(id) {
    if (st.tab === id) { return; }
    st.tab = id;
    render();
  }

  /* ---- Agents ---- */
  function checkRow(cls, on, label, toggle) {
    const row = mk('div', `ras-row hwb-lift ${cls}${on ? ' is-sel' : ''}`);
    row.setAttribute('role', 'checkbox');
    row.setAttribute('aria-checked', String(on));
    row.setAttribute('aria-label', label);
    row.tabIndex = 0;
    row.addEventListener('click', (e) => {
      if (e.target.closest('input, select, button, label')) { return; }
      toggle();
    });
    row.addEventListener('keydown', (e) => {
      if (e.target === row && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        toggle();
      }
    });
    const box = mk('span', 'ras-box');
    box.setAttribute('aria-hidden', 'true');
    box.innerHTML = '<svg viewBox="0 0 12 12"><path d="M2.5 6.2 5 8.5l4.5-5"/></svg>';
    row.append(box);
    return row;
  }

  function secHead(title, n, extra) {
    const s = mk('div', 'ras-sec');
    s.append(title, mk('span', 'sp'));
    if (extra) { s.append(extra); }
    s.append(mk('span', 'c', String(n)));
    return s;
  }

  function agentsBody(box) {
    const el = eligible();
    const lead = effectiveLead();
    /* LIVE TABS */
    let tg = null;
    const tabsHere = el.filter((p) => windowTabs.has(p.paneid));
    if (tabsHere.length) {
      const allOn = tabsHere.every((p) => st.selected.has(p.paneid));
      tg = button('ras-link', allOn ? "this window's tabs ✓" : "this window's tabs", 'wintabs');
      tg.title = allOn ? "clear this window's tabs" : "tick this window's tabs";
      tg.addEventListener('click', () => {
        for (const p of tabsHere) { allOn ? st.selected.delete(p.paneid) : st.selected.add(p.paneid); }
        scheduleDry();
      });
    }
    box.append(secHead('Live tabs', el.length, tg));
    if (!el.length) {
      box.append(mk('div', 'ras-empty', 'No live tabs to bring in. Start one from a project below.'));
    }
    for (const p of [...el].sort((a, b) => sortKey(a) - sortKey(b))) {
      box.append(paneRow(p, p.paneid === lead));
    }
    /* START FROM A PROJECT */
    box.append(secHead('Start from a project', st.recipes.length));
    if (!st.recipes.length) {
      box.append(mk('div', 'ras-empty', 'No saved projects to start.'));
    }
    for (const r of st.recipes) {
      box.append(projectRow(r, lead === `rec:${r.id}`));
    }
    /* CAN'T JOIN, folded */
    const inel = ineligible();
    if (inel.length) {
      const cj = mk('div', 'ras-cant');
      const b = button('ras-link dim', `Can't join (${inel.length}) ${st.cantOpen ? DSAQUO : RSAQUO}`, 'cant');
      b.setAttribute('aria-expanded', String(st.cantOpen));
      b.addEventListener('click', () => { st.cantOpen = !st.cantOpen; render(); });
      cj.append(b);
      if (st.cantOpen) {
        const ul = mk('ul');
        for (const p of inel) {
          const why = (CANT_JOIN[p.seat?.reason] ?? (() => p.seat?.reason || 'not eligible'))(p, targetRoom(), st.panes);
          const li = mk('li', '', `${p.title || p.project || p.paneid} ${MDASH} ${why}`);
          li.dataset.paneid = p.paneid;
          ul.append(li);
        }
        cj.append(ul);
      }
      box.append(cj);
    }
  }

  function paneRow(p, isLead) {
    const on = st.selected.has(p.paneid);
    const d = st.derived.get(p.paneid);
    const refused = on && (st.skip.has(p.paneid) || d?.outcome === 'refused');
    const row = checkRow('ras-pane', on, p.title || p.project || p.paneid, () => {
      if (st.selected.has(p.paneid)) {
        st.selected.delete(p.paneid);
        st.skip.delete(p.paneid);
      } else {
        st.selected.add(p.paneid);
      }
      scheduleDry();
    });
    row.dataset.paneid = p.paneid;
    row.dataset.fid = `row-${p.paneid}`;
    if (refused) { row.classList.add('is-refused'); }
    const tone = p.color || p.projectColor;
    if (tone) { row.style.setProperty('--pc', tone); }
    row.append(glyph(p, isLead && on));
    const nm = mk('div', 'nm');
    nm.append(mk('div', 'a', p.title || p.project || p.paneid));
    const b = mk('div', 'b');
    const hv = handleOf(p.paneid);
    if (on && st.editing === p.paneid) {
      b.append(handleField(hv, `h-${p.paneid}`, `Name (@handle) for ${p.title || p.paneid}`, (v) => {
        const s = v.replace(/^@/, '').trim();
        if (s) { st.handles.set(p.paneid, s); } else { st.handles.delete(p.paneid); }
        scheduleDry();
      }, () => { st.editing = null; render(); }));
    } else if (on && hv) {
      const hb = button('ras-hdl', `@${hv}`, `hb-${p.paneid}`);
      hb.title = 'rename it';
      hb.setAttribute('aria-label', `@${hv}: rename`);
      hb.addEventListener('click', (e) => {
        e.stopPropagation();
        st.editing = p.paneid;
        render();
        sheet.querySelector(`[data-fid="${CSS.escape(`h-${p.paneid}`)}"]`)?.focus();
      });
      b.append(hb);
      if (d?.autoSuffixed && !st.handles.has(p.paneid)) {
        const nudge = button('seat-nudge', 'name me', `nm-${p.paneid}`);
        nudge.title = 'auto-numbered: the name was taken. Give it a real one.';
        nudge.addEventListener('click', (e) => {
          e.stopPropagation();
          st.editing = p.paneid;
          render();
          sheet.querySelector(`[data-fid="${CSS.escape(`h-${p.paneid}`)}"]`)?.focus();
        });
        b.append(nudge);
      }
      b.append(' · ');
    }
    b.append(p.project || p.host || '');
    nm.append(b);
    /* what the row must say: a refusal (on the row), then the engine's notes */
    const notes = [];
    if (on && d?.outcome === 'refused') {
      notes.push([(REFUSED[d.reason] ?? (() => d.reason))(p, targetRoom(), st.panes), 'bad']);
    } else if (on && d?.outcome === 'already') {
      notes.push([`already here as @${d.handle}`]);
    }
    const tr = targetRoom();
    const others = (p.seats || []).filter((s) => !(tr && s.roomId === tr.id));
    if (others.length) { notes.push([`in ${others.map((s) => s.roomName).join(', ')}`]); }
    /* the engine's limits, before you tick: they are why you might not */
    if (p.state === 'dehydrated') {
      notes.push(['restorable: Restore it from the room (that also puts it on the channel)']);
    } else {
      if (p.delivery === 'badge' || (p.vendor && p.vendor !== 'claude-code')) { notes.push(['gets a badge only']); }
      if (p.draft === 'unobserved') { notes.push(["can't see its input box"]); }
      if (p.claudeRunning === false) { notes.push(["claude isn't running in it: room lines wait until it is"]); }
    }
    if (notes.length) {
      const c = mk('div', 'c');
      notes.forEach(([text, cls], i) => {
        if (i) { c.append(' · '); }
        c.append(mk('span', cls || '', text));
      });
      nm.append(c);
    }
    row.append(nm);
    return row;
  }

  function handleField(value, fid, label, onInput, onEnter) {
    const f = mk('label', 'ras-fld ras-hfld');
    f.append(mk('span', 'at', '@'));
    const inp = mk('input');
    inp.type = 'text';
    inp.value = value;
    inp.maxLength = HANDLE_MAX + 1;
    inp.spellcheck = false;
    inp.autocapitalize = 'off';
    inp.setAttribute('autocomplete', 'off');
    inp.dataset.fid = fid;
    inp.setAttribute('aria-label', label);
    inp.addEventListener('click', (e) => e.stopPropagation());
    inp.addEventListener('input', () => onInput(inp.value, inp));
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onEnter?.();
      }
    });
    f.append(inp);
    return f;
  }

  /* ---- a project's per-start choices (the design system 2026-09-28) ---- */
  /** Resume implies persistent; under New the quiet box decides. */
  function syncPolicy(p) {
    p.policy = p.how === 'resume' ? 'persistent' : p.fresh ? 'fresh' : 'persistent';
  }
  /** The row's subtitle: what Add will do, naming only what differs from the
   *  recipe's defaults. Never empty: the verb always leads. */
  function choiceSummary(r, p) {
    if (!p) { return 'starts a new session'; }
    const parts = [];
    if (p.how === 'resume' && p.pick) {
      parts.push(`resumes "${p.pick.title}"`);
    } else if (p.how === 'resume') {
      parts.push('resumes a past session');
    } else if (p.fresh) {
      parts.push('new', 'fresh');
    } else {
      parts.push('starts a new session');
    }
    if (p.model && p.model !== (r.model || '')) { parts.push(p.model); }
    if (p.effort && p.effort !== (r.effort || '')) { parts.push(p.effort); }
    return parts.join(` ${MIDDOT} `);
  }
  let picker = null; // the open resume picker, if any
  /** Resume: open the SHARED picker (web/resume-picker.mjs, the manager
   *  card's own) for this project's past sessions. A pick is remembered and
   *  shown; cancelling with nothing picked snaps back to New. */
  function pickSession(r, p) {
    if (picker || closed) { return; }
    p.how = 'resume';
    syncPolicy(p);
    render();
    const refocus = (fid) => focusInto(sheet.querySelector(`[data-fid="${CSS.escape(fid)}"]`));
    picker = openResumePicker({
      recipe: r,
      onPick: (sess) => {
        picker = null;
        if (closed) { return; }
        p.pick = { sessionId: sess.sessionId, title: sessionLabel(sess) };
        p.how = 'resume';
        syncPolicy(p);
        render();
        refocus(`chg-${r.id}`);
      },
      onCancel: () => {
        picker = null;
        if (closed) { return; }
        if (!p.pick) {
          p.how = 'new';
          syncPolicy(p);
        }
        render();
        refocus(`how-${p.how}-${r.id}`);
      },
    });
  }
  /** Row 2: [New | Resume], the lifted segment; then the pick or the fresh box. */
  function howControl(r, p, locked) {
    const wrap = mk('div', 'ras-howwrap');
    const seg = mk('div', 'ras-how');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', `New or resumed session for ${r.name}`);
    for (const [val, text] of [['new', 'New'], ['resume', 'Resume']]) {
      const b = button('', text, `how-${val}-${r.id}`);
      b.dataset.how = val;
      b.setAttribute('aria-pressed', String(p.how === val));
      b.disabled = locked;
      if (val === 'resume') { b.title = "Resume one of this project's past sessions"; }
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (val === 'resume') {
          pickSession(r, p);
          return;
        }
        if (p.how === 'new') { return; }
        p.how = 'new';
        syncPolicy(p);
        render();
      });
      seg.append(b);
    }
    wrap.append(seg);
    if (p.how === 'resume' && p.pick) {
      const line = mk('div', 'ras-pick');
      line.append(mk('span', 'ras-pickt', `Resuming "${p.pick.title}"`), ` ${MIDDOT} `);
      const chg = button('ras-link', 'Change', `chg-${r.id}`);
      chg.disabled = locked;
      chg.title = 'Pick a different session';
      chg.addEventListener('click', (e) => {
        e.stopPropagation();
        pickSession(r, p);
      });
      line.append(chg);
      line.title = p.pick.sessionId;
      wrap.append(line);
    } else if (p.how === 'new') {
      wrap.append(freshBox(r, p, locked));
    }
    return wrap;
  }
  /** Under New: one quiet box. Unchecked = persistent (the old default). */
  function freshBox(r, p, locked) {
    const lab = mk('label', 'ras-fresh');
    const cb = mk('input');
    cb.type = 'checkbox';
    cb.checked = !!p.fresh;
    cb.disabled = locked;
    cb.dataset.fid = `fr-${r.id}`;
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      p.fresh = cb.checked;
      syncPolicy(p);
      render();
    });
    lab.addEventListener('click', (e) => e.stopPropagation());
    lab.append(cb, ' forget between runs (fresh)');
    lab.title = 'Unchecked, the seat keeps its conversation between runs (persistent)';
    return lab;
  }
  /** Row 3: Model + Effort, each under a small label (the recipe form's). The
   *  first option READS the recipe's own value: "Recipe default (opus)", or
   *  "Default (claude's)" when the recipe sets none. Choosing it = no override. */
  function modelEffort(r, p, locked) {
    const models = modelsFor(r.vendor);
    const efforts = effortsFor(r.vendor);
    const me = mk('div', `ras-me${models.length && efforts.length ? ' two' : ''}`);
    const cli = (r.vendor || 'claude-code').split('-')[0]; // claude / gemini / codex
    const sel = (label, fid, own, values, cur, set) => {
      const wrap = mk('label', 'ras-mel');
      wrap.append(mk('span', 'ras-mlab', label));
      const x = mk('select', 'ras-sel');
      x.dataset.fid = fid;
      x.setAttribute('aria-label', label);
      x.title = `${label} for this start (the project keeps its own)`;
      const d = mk('option', '', own ? `Recipe default (${own})` : `Default (${cli}${String.fromCharCode(39)}s)`);
      d.value = '';
      x.append(d);
      for (const v of values) {
        const o = mk('option', '', v);
        o.value = v;
        x.append(o);
      }
      x.value = cur;
      x.disabled = locked;
      x.addEventListener('click', (e) => e.stopPropagation());
      x.addEventListener('change', () => { set(x.value); render(); });
      wrap.addEventListener('click', (e) => e.stopPropagation());
      wrap.append(x);
      return wrap;
    };
    if (models.length) {
      me.append(sel('Model', `pm-${r.id}`, r.model, models, p.model, (v) => { p.model = v; }));
    }
    if (efforts.length) {
      me.append(sel('Effort', `pe-${r.id}`, r.effort, efforts, p.effort, (v) => { p.effort = v; }));
    }
    return me;
  }

  function projectRow(r, isLead) {
    const p = st.projects.get(r.id);
    const on = !!p;
    const row = checkRow('ras-proj', on, r.name, () => {
      if (st.going || p?.phase === 'starting' || p?.phase === 'done') {
        return; // in flight or in: not a choice any more
      }
      if (st.projects.has(r.id)) {
        const q = st.projects.get(r.id);
        if (q.created) { st.extraTaken.add(q.created.handle); }
        st.choices.set(r.id, { how: q.how, pick: q.pick, fresh: q.fresh, model: q.model, effort: q.effort });
        st.projects.delete(r.id);
      } else {
        const sug = suggestHandle(r, takenHandles(r.id));
        const kept = st.choices.get(r.id);
        const np = {
          handle: sug, suggested: sug, policy: 'persistent', error: '', created: null,
          how: 'new', // 'new' | 'resume'
          pick: null, // the picked past session {sessionId, title} (Resume)
          fresh: false, // New only: forget between runs = the seat policy 'fresh'
          model: '', // '' = the recipe's own
          effort: '', // '' = the recipe's own
          ...(kept ?? {}),
        };
        if (np.how === 'resume' && !np.pick) { np.how = 'new'; }
        syncPolicy(np);
        st.projects.set(r.id, np);
      }
      refreshSuggestions();
      render();
    });
    row.dataset.recipe = r.id;
    row.dataset.fid = `rec-${r.id}`;
    if (r.color) { row.style.setProperty('--pc', r.color); }
    row.append(glyph({ vendor: r.vendor, state: 'none' }, isLead && on));
    const nm = mk('div', 'nm');
    nm.append(mk('div', 'a', r.name));
    const folder = folderOf(r.projectDir);
    /* the folder and the summary in their own spans: the FOLDER gives way first
       (.b is a flex row, where bare text is clipped with no ellipsis, which is
       how a long folder name hid "· opus · max" at the end) */
    const b = mk('div', 'b');
    if (folder && folder !== r.name) {
      b.append(mk('span', 'ras-fold', `${folder} ${MIDDOT} `));
    }
    const summary = p?.created ? `@${p.created.handle} is in the room` : choiceSummary(r, p ?? st.choices.get(r.id));
    b.append(mk('span', 'ras-sum', summary));
    b.title = b.textContent;
    nm.append(b);
    row.append(nm);
    /* THE PHASE, in view (the design system): starting... then a tick; a failure keeps its reason + Retry start */
    if (p?.phase === 'starting' || p?.phase === 'done') {
      row.classList.add(`is-${p.phase}`);
      const ph = mk('span', `ras-phase ${p.phase}`, p.phase === 'starting' ? `starting${ELL}` : `${CHECK} started`);
      ph.setAttribute('role', 'status');
      row.append(ph);
    }
    if (on) {
      /* THE EXPANDED AREA (the design system 2026-09-28): grid-column 2 / -1 like the
         @name field, 8px row gaps. Row 1 @name; row 2 [New | Resume] (+ the
         pick, or the quiet fresh box); row 3 Model + Effort. */
      const locked = st.busy || !!p.created || p.phase === 'starting' || p.phase === 'done';
      const more = mk('div', 'more');
      const fld = handleField(p.handle, `ph-${r.id}`, `Name (@handle) for the new ${r.name} agent`, (v, inp) => {
        const t = typingHandle(v);
        if (t !== inp.value) {
          inp.value = t;
          try { inp.setSelectionRange(t.length, t.length); } catch { /* not a text field */ }
        }
        p.handle = t;
        p.error = '';
        paintProj();
        paintFoot();
      }, () => void go());
      fld.querySelector('input').disabled = locked;
      more.append(fld);
      if (isClaude(r)) {
        more.append(howControl(r, p, locked));
      } else {
        more.append(freshBox(r, p, locked));
      }
      if (MODEL_VENDORS.includes(r.vendor || 'claude-code')) {
        more.append(modelEffort(r, p, locked));
      }
      const err = mk('div', 'ras-rerr');
      err.setAttribute('role', 'status');
      more.append(err);
      if (p.phase === 'failed' && p.created) {
        const rs = button('ras-btn sm pri ras-retry', 'Retry start', `retry-${r.id}`);
        rs.disabled = st.busy;
        rs.addEventListener('click', (e) => {
          e.stopPropagation();
          void retryStart(r.id);
        });
        more.append(rs);
      }
      row.append(more);
      const paintProj = () => {
        const n = projNeed(r.id);
        const refusal = /taken|reserved/.test(n) ? n : '';
        err.textContent = p.error || refusal;
        err.hidden = !err.textContent;
        fld.classList.toggle('bad', !!(p.error || refusal));
      };
      paintProj();
    }
    return row;
  }

  function agentsFooter(ft) {
    if (st.error) {
      const e = mk('div', 'ras-err', st.error);
      e.setAttribute('role', 'status');
      ft.append(e);
    }
    const opt = button('ras-opt', `Options ${st.optsOpen ? DSAQUO : RSAQUO}`, 'opts');
    opt.setAttribute('aria-expanded', String(st.optsOpen));
    opt.addEventListener('click', () => { st.optsOpen = !st.optsOpen; render(); });
    const why = mk('span', 'ras-why');
    const cancel = button('ras-btn', 'Cancel', 'cancel');
    cancel.addEventListener('click', close);
    const add = button('ras-btn pri ras-go', '', 'go');
    add.addEventListener('click', () => void go());
    const also = mk('div', 'ras-also');
    ft.append(opt, why, cancel, add, also);
    if (st.optsOpen) {
      ft.append(optionsBody());
    }
    paintFoot = () => {
      const { label, also: a, tip } = addLabel();
      add.textContent = st.going ? `${label}${ELL}` : label;
      add.title = tip; // the breakdown: agents, apps
      const n = need();
      add.disabled = st.busy || !!n;
      why.textContent = n && n !== 'tick a tab or a project' ? n : '';
      why.hidden = !why.textContent;
      also.textContent = a;
      also.hidden = !a;
    };
    paintFoot();
  }
  let paintFoot = () => {};

  function optionsBody() {
    const ob = mk('div', 'ras-optbody');
    const lw = mk('label', 'ras-lead');
    lw.append('Lead ');
    const ls = mk('select', 'ras-sel');
    ls.dataset.fid = 'lead';
    const tr = targetRoom();
    if (tr) {
      const keep = mk('option', '', currentLeadHandle() ? `keep @${currentLeadHandle()}` : 'keep (no lead yet)');
      keep.value = '';
      ls.append(keep);
    }
    for (const k of persistentKeys()) {
      const op = mk('option', '', `@${keyHandle(k) || ELL}`);
      op.value = k;
      ls.append(op);
    }
    ls.value = tr && !st.leadTouched ? '' : effectiveLead();
    ls.disabled = ls.options.length === 0;
    ls.addEventListener('change', () => {
      st.lead = ls.value;
      st.leadTouched = ls.value !== '';
      scheduleDry();
    });
    lw.append(ls);
    ob.append(lw);
    const mt = button('ras-link', `${st.msgOn ? String.fromCharCode(8722) : '+'} Opening message`, 'msgtoggle');
    mt.setAttribute('aria-expanded', String(st.msgOn));
    mt.title = 'each addressed agent takes a turn to read it';
    mt.addEventListener('click', () => {
      st.msgOn = !st.msgOn;
      if (st.msgOn && !st.msgTouched) { st.msgText = prefill(); }
      render();
    });
    ob.append(mt);
    if (st.msgOn) {
      if (!st.msgTouched) { st.msgText = prefill(); }
      const mw = mk('div', 'ras-msg');
      const ta = mk('textarea');
      ta.dataset.fid = 'msg';
      ta.value = st.msgText;
      ta.setAttribute('aria-label', 'Opening message');
      const counter = mk('div', 'ras-counter');
      const cText = () => `${st.msgText.length} / ${MSG_CAP}`;
      counter.textContent = cText();
      counter.classList.toggle('is-over', msgOver());
      ta.addEventListener('input', () => {
        st.msgText = ta.value;
        st.msgTouched = true;
        counter.textContent = cText();
        counter.classList.toggle('is-over', msgOver());
        paintFoot();
      });
      mw.append(ta, counter, mk('div', 'ras-cost', 'Each addressed agent takes one turn to read it. An agent idle for a long time re-reads its whole conversation.'));
      const rest = chosen().map((id) => st.panes.find((q) => q.paneid === id)).filter((q) => q?.state === 'dehydrated');
      if (rest.length) {
        mw.append(mk('div', 'ras-cost', `${rest.map((q) => `@${handleOf(q.paneid)}`).join(', ')} won't be typed this. It stays in the room chat for them to read after Restore.`));
      }
      ob.append(mw);
    }
    return ob;
  }

  render();
  /* into the sheet; the ring only for a keyboard opener (a tap on the phone
     must not paint the Agents segment: web/focus-intent.mjs) */
  focusInto(sheet.querySelector('[data-fid="newname"]') ?? sheet.querySelector('[role="tab"][aria-selected="true"]'));
  if (st.selected.size) { scheduleDry(); }
  return { close };
}
