/* THE WORKGROUPS TAB of the room's + sheet (Owner 2026-10-04, note
 * eee9ca063154 item 3; the design system hub "Create a workgroup"). Top to bottom:
 *   1 THE WORKGROUP  name · alias (suggested from the name, checked live
 *                    against the family: "@x is free" / the engine's reason) ·
 *                    color (the room's 8 swatches)
 *   2 MOVE AN AGENT HERE  the room's current agents EXCEPT its lead
 *                    (a move keeps the name and the session)
 *   3 START A NEW AGENT   the Agents list (projects), for new instances
 * Every ticked agent shows its @handle (a moved agent's is locked in, a new
 * one's is editable and checked unique across the family) and a lead radio
 * (the first ticked leads by default). The footer reads "Name @alias · moves N
 * · starts N · lead @x"; Create stays off until there is a name, a free alias,
 * at least one agent, a lead and no clashing handle.
 *
 * ONE call does the rest: POST /api/rooms/:id/workgroups (the engine forms the
 * room, moves, adds, names the lead as one transaction, then starts the new
 * agents; a failed start is reported in words, never swallowed). The ENGINE
 * decides every clash (GET .../family-check); this module only words it.
 * Worktrees are not part of this step (new instances launch as today).
 *
 * Phone: the same rows at 44px targets, 16px inputs; nothing here focuses a
 * field by itself.
 */
const ELL = String.fromCharCode(8230);
const MIDDOT = String.fromCharCode(183);
const HANDLE_MAX = 64;
const ALIAS_MAX = 32;
const CHECK_MS = 300;
const GRAMMAR = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RESERVED = ['room', 'lead', 'all', 'user']; // src/engine/room-vocab.ts
/** the room settings' 8 swatches (room.js SWATCHES) */
export const SWATCHES = ['#1f8fa6', '#0dab49', '#1f5fbf', '#ba08b4', '#d9622b', '#c9a227', '#5b6bd6', '#b83b5e'];

const slugOf = (v, max) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '');
/** the same, AS YOU TYPE: a trailing hyphen survives (you are mid-word) */
const typing = (v, max) => String(v ?? '').replace(/^@+/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+/, '').slice(0, max);

/** The rows' rule, pure so a test can drive it: why Create cannot go yet ('' = it can). */
export function workgroupNeed(w) {
  if (!String(w.name || '').trim()) { return 'name it'; }
  if (!w.alias) { return 'give it an alias'; }
  if (!GRAMMAR.test(w.alias) || w.alias.length > ALIAS_MAX || RESERVED.includes(w.alias)) { return 'the alias is not valid'; }
  if (w.aliasCheck && w.aliasCheck.value === w.alias && !w.aliasCheck.free) { return `@${w.alias} is taken`; }
  if (!w.aliasCheck || w.aliasCheck.value !== w.alias) { return 'checking the alias'; }
  if (!w.picks.length) { return 'pick an agent'; }
  if (!w.lead || !w.picks.some((p) => p.key === w.lead)) { return 'pick a lead'; }
  for (const p of w.picks) {
    const h = p.handle;
    if (!h) { return 'every agent needs a name'; }
    if (!GRAMMAR.test(h) || RESERVED.includes(h) || h.length > HANDLE_MAX) { return `@${h} is not a valid name`; }
    if (h === w.alias) { return `@${h} is also the alias`; }
    if (w.picks.filter((q) => q.handle === h).length > 1) { return `@${h} is used twice here`; }
    if (!p.locked) {
      const c = w.handleChecks?.get(h);
      if (c && !c.free) { return `@${h} is already used in this room family`; }
      if (!c) { return 'checking the names'; }
    }
  }
  return '';
}

/**
 * @param {object} c
 *   call(path, json?, method?) -> {ok, status, body}
 *   room() -> the fixed room {id, name, lead_seat, seats[]}
 *   recipes() -> the projects (seatable, sorted)
 *   render() -> redraw the whole sheet; toast(text)
 *   mk, button, checkRow, secHead, glyph, handleField: the sheet's own pieces
 *   done(ans) -> the sheet's landing after a create with no problems
 */
export function createWorkgroupTab(c) {
  const { mk, button } = c;
  const w = {
    name: '',
    alias: '',
    aliasEdited: false,
    color: null, // not chosen until a swatch is pressed: the engine then picks one no sibling wears [workgroup design] Owner 2026-10-05
    moves: [], // seat ids in the order ticked
    starts: [], // recipe ids in the order ticked
    handles: new Map(), // key -> handle (a start's is editable; a move's is its own)
    lead: null,
    aliasCheck: null, // {value, free, reason} for the alias it was asked about
    aliasPending: false,
    handleChecks: new Map(), // handle -> {free, reason}
    busy: false,
    error: '',
    result: null, // an answer with problems: shown until closed
  };
  let timer = 0;
  let gen = 0;
  let paintHints = () => {};
  let paintFoot = () => {};

  const room = () => c.room();
  const movable = () => (room()?.seats || []).filter((s) => s && !s.left_at && s.id !== room().lead_seat);
  const seatOf = (id) => movable().find((s) => s.id === id) || null;
  const recipeOf = (id) => c.recipes().find((r) => r.id === id) || null;
  const keyOfMove = (id) => `m:${id}`;
  const keyOfStart = (id) => `s:${id}`;
  const picks = () => [
    ...w.moves.map((id) => ({ key: keyOfMove(id), locked: true, handle: seatOf(id)?.handle || '' })),
    ...w.starts.map((id) => ({ key: keyOfStart(id), locked: false, handle: w.handles.get(keyOfStart(id)) || '' })),
  ];
  const view = () => ({ ...w, picks: picks() });
  const need = () => workgroupNeed(view());
  const leadHandle = () => picks().find((p) => p.key === w.lead)?.handle || '';

  /** a handle the sheet knows is taken: the room's own seats and the picks (the engine knows the rest) */
  function knownTaken(exceptKey) {
    const t = new Set((room()?.seats || []).filter((s) => !s.left_at).map((s) => s.handle));
    for (const p of picks()) { if (p.key !== exceptKey && p.handle) { t.add(p.handle); } }
    if (w.alias) { t.add(w.alias); }
    return t;
  }
  function suggest(r) {
    const base = slugOf(r?.agent, HANDLE_MAX) || slugOf(String(r?.projectDir || '').split(String.fromCharCode(92)).join('/').split('/').filter(Boolean).pop(), HANDLE_MAX) || slugOf(r?.name, HANDLE_MAX) || 'agent';
    const taken = knownTaken(keyOfStart(r.id));
    const free = (h) => !taken.has(h) && !RESERVED.includes(h);
    if (free(base)) { return base; }
    for (let n = 2; ; n++) {
      const sfx = `-${n}`;
      const h = base.slice(0, HANDLE_MAX - sfx.length).replace(/-+$/g, '') + sfx;
      if (free(h)) { return h; }
    }
  }

  /* ---- the live check: the alias and every new agent's handle, ONE debounced GET ---- */
  function scheduleCheck() {
    clearTimeout(timer);
    const alias = w.alias;
    const hs = [...new Set(w.starts.map((id) => w.handles.get(keyOfStart(id))).filter((h) => h && GRAMMAR.test(h)))];
    const wantAlias = alias && GRAMMAR.test(alias) && alias.length <= ALIAS_MAX;
    if (!wantAlias && !hs.length) {
      w.aliasPending = false;
      return;
    }
    w.aliasPending = !!wantAlias && w.aliasCheck?.value !== alias;
    const mine = ++gen;
    timer = setTimeout(async () => {
      const q = new URLSearchParams();
      if (wantAlias) { q.set('alias', alias); }
      for (const h of hs) { q.append('handle', h); }
      let r;
      try {
        r = await c.call(`/api/rooms/${encodeURIComponent(room().id)}/family-check?${q}`);
      } catch (e) {
        r = { ok: false, status: 0, body: { error: e?.message ?? String(e) } };
      }
      if (mine !== gen) { return; }
      w.aliasPending = false;
      if (r.ok) {
        if (r.body.alias) { w.aliasCheck = r.body.alias; }
        for (const x of r.body.handles || []) { w.handleChecks.set(x.value, x); }
      } else {
        w.error = `could not check the names ${String.fromCharCode(8212)} ${r.body?.error ?? `HTTP ${r.status}`}`;
      }
      paintHints();
      paintFoot();
    }, CHECK_MS);
  }

  /* ---- ticks ---- */
  function toggle(kind, id) {
    const list = kind === 'move' ? w.moves : w.starts;
    const key = kind === 'move' ? keyOfMove(id) : keyOfStart(id);
    const i = list.indexOf(id);
    if (i >= 0) {
      list.splice(i, 1);
      if (w.lead === key) { w.lead = picks()[0]?.key ?? null; }
    } else {
      list.push(id);
      if (kind === 'start') { w.handles.set(key, suggest(recipeOf(id))); }
      if (!w.lead) { w.lead = key; }
    }
    scheduleCheck();
    c.render();
  }

  /* ---- body ---- */
  function hint(cls, text) {
    const h = mk('div', `rwg-hint ${cls}`, text);
    h.setAttribute('role', 'status');
    return h;
  }
  function aliasHintText() {
    if (!w.alias) { return ['', 'Plain typing in the workgroup reaches its lead; @alias reaches it from the room.']; }
    if (!GRAMMAR.test(w.alias) || w.alias.length > ALIAS_MAX) { return ['bad', 'lowercase letters, digits and single hyphens']; }
    if (RESERVED.includes(w.alias)) { return ['bad', `@${w.alias} is reserved`]; }
    if (w.aliasCheck && w.aliasCheck.value === w.alias) {
      return w.aliasCheck.free ? ['ok', `@${w.alias} is free`] : ['bad', w.aliasCheck.reason || `@${w.alias} is already used in this room family`];
    }
    return ['', `checking @${w.alias}${ELL}`];
  }

  function body(box) {
    rowFields.length = 0;
    if (w.result) {
      resultBody(box);
      return;
    }
    const r = room();
    /* 1 THE WORKGROUP */
    box.append(c.secHead('1 \u00b7 The workgroup', ''));
    const def = mk('div', 'rwg-def');
    const nameF = mk('label', 'rwg-row');
    nameF.append(mk('span', 'k', 'Name'));
    const nm = mk('input');
    nm.type = 'text';
    nm.placeholder = 'e.g. Asset Studio';
    nm.maxLength = 200;
    nm.value = w.name;
    nm.dataset.fid = 'wg-name';
    nm.setAttribute('aria-label', 'Workgroup name');
    const nmWrap = mk('span', 'ras-fld');
    nmWrap.append(nm);
    nameF.append(nmWrap);
    const aliasF = mk('label', 'rwg-row');
    aliasF.append(mk('span', 'k', 'Alias'));
    const al = mk('input');
    al.type = 'text';
    al.placeholder = 'asset-studio';
    al.maxLength = ALIAS_MAX + 1;
    al.value = w.alias;
    al.spellcheck = false;
    al.autocapitalize = 'off';
    al.setAttribute('autocomplete', 'off');
    al.dataset.fid = 'wg-alias';
    al.setAttribute('aria-label', 'Workgroup alias');
    const alWrap = mk('span', 'ras-fld');
    alWrap.append(mk('span', 'at', '@'), al);
    aliasF.append(alWrap);
    const hintHost = mk('div', 'rwg-hinthost');
    nm.addEventListener('input', () => {
      w.name = nm.value;
      if (!w.aliasEdited) {
        w.alias = slugOf(nm.value, ALIAS_MAX);
        al.value = w.alias;
      }
      scheduleCheck();
      paintHints();
      paintFoot();
    });
    al.addEventListener('input', () => {
      w.aliasEdited = true;
      const t = typing(al.value, ALIAS_MAX + 1);
      if (t !== al.value) { al.value = t; }
      w.alias = t.replace(/-+$/g, '');
      scheduleCheck();
      paintHints();
      paintFoot();
    });
    const colorF = mk('div', 'rwg-row');
    colorF.append(mk('span', 'k', 'Color'));
    const sws = mk('div', 'rwg-sws');
    sws.setAttribute('role', 'group');
    sws.setAttribute('aria-label', 'Workgroup color');
    for (const hex of SWATCHES) {
      const b = button('rwg-sw', '', `wg-color-${hex}`);
      b.style.setProperty('--c', hex);
      b.title = hex;
      b.setAttribute('aria-label', hex);
      b.setAttribute('aria-pressed', String(w.color === hex));
      b.addEventListener('click', () => {
        w.color = hex;
        for (const o of sws.children) { o.setAttribute('aria-pressed', String(o === b)); }
      });
      sws.append(b);
    }
    colorF.append(sws, mk('div', 'rwg-note', 'Pick one, or leave it: a color no other room here uses is chosen for you.'));
    def.append(nameF, aliasF, hintHost, colorF);
    box.append(def);

    /* 2 MOVE AN AGENT HERE */
    const mv = movable();
    box.append(c.secHead('2 \u00b7 Move an agent here', mv.length));
    box.append(mk('div', 'rwg-note', `Same name, same session. ${r?.name ?? 'The room'} keeps its lead and the history.`));
    if (!mv.length) {
      box.append(mk('div', 'ras-empty', `${r?.name ?? 'The room'} has no agent besides its lead to move.`));
    }
    for (const s of mv) {
      box.append(pickRow('move', s.id, `@${s.handle}`, moveMeta(s), c.glyph({ vendor: s.vendor ?? s.occupant?.vendor, state: s.occupant?.state, activity: s.occupant?.activity, attached: !!s.occupant?.attached }, false)));
    }
    /* 3 START A NEW AGENT */
    const rs = c.recipes();
    box.append(c.secHead('3 \u00b7 Start a new agent', rs.length));
    box.append(mk('div', 'rwg-note', 'A new instance of a project, started fresh in the workgroup.'));
    if (!rs.length) { box.append(mk('div', 'ras-empty', 'No saved projects to start.')); }
    for (const p of rs) {
      const g = c.glyph({ vendor: p.vendor, state: 'none' }, false);
      box.append(pickRow('start', p.id, p.name, 'starts a new session', g, p.color));
    }

    paintHints = () => {
      hintHost.textContent = '';
      const [cls, text] = aliasHintText();
      hintHost.append(hint(cls, text));
      nmWrap.classList.toggle('bad', false);
      alWrap.classList.toggle('bad', cls === 'bad');
      for (const [fld, key] of rowFields) {
        const p = picks().find((q) => q.key === key);
        if (!p) { continue; }
        const bad = handleProblem(p);
        fld.classList.toggle('bad', !!bad);
        const lock = fld.closest('.more')?.querySelector('.rwg-lock');
        if (lock) {
          lock.textContent = bad || (p.locked ? '\u2713 locked in' : 'free');
          lock.classList.toggle('bad', !!bad);
        }
      }
    };
    paintFoot();
    paintHints();
  }

  const rowFields = [];
  function moveMeta(s) {
    const st = s.occupant?.state === 'live' ? 'live' : s.occupant?.state === 'dehydrated' ? 'restorable' : s.status || 'idle';
    return `${st}${s.project ? ` ${MIDDOT} ${s.project}` : ''}`;
  }
  function handleProblem(p) {
    const h = p.handle;
    if (!h) { return 'name it'; }
    if (!GRAMMAR.test(h) || h.length > HANDLE_MAX) { return 'letters, digits and single hyphens'; }
    if (RESERVED.includes(h)) { return `@${h} is reserved`; }
    if (h === w.alias) { return 'also the alias'; }
    if (picks().filter((q) => q.handle === h).length > 1) { return 'used twice here'; }
    if (!p.locked) {
      const ch = w.handleChecks.get(h);
      if (ch && !ch.free) { return 'already used in this room family'; }
    }
    return '';
  }

  function pickRow(kind, id, title, meta, glyphEl, tone) {
    const key = kind === 'move' ? keyOfMove(id) : keyOfStart(id);
    const on = (kind === 'move' ? w.moves : w.starts).includes(id);
    const row = c.checkRow('ras-proj rwg-pick', on, title, () => toggle(kind, id));
    row.dataset.fid = `wg-${key}`;
    row.dataset.pick = key;
    if (tone) { row.style.setProperty('--pc', tone); }
    row.append(glyphEl);
    const nm = mk('div', 'nm');
    nm.append(mk('div', 'a', title), mk('div', 'b', meta));
    row.append(nm);
    if (on) {
      const p = picks().find((q) => q.key === key);
      const more = mk('div', 'more');
      const line = mk('div', 'rwg-hline');
      const fld = c.handleField(p.handle, `wg-h-${key}`, `Name (@handle) for ${title}`, (v, inp) => {
        const t = typing(v, HANDLE_MAX);
        if (t !== inp.value) { inp.value = t; }
        w.handles.set(key, t.replace(/-+$/g, ''));
        scheduleCheck();
        paintHints();
        paintFoot();
      }, () => {});
      const inp = fld.querySelector('input');
      if (p.locked) {
        inp.readOnly = true;
        inp.tabIndex = -1;
        fld.classList.add('is-locked');
      }
      const lock = mk('span', 'rwg-lock', p.locked ? '\u2713 locked in' : '');
      const lead = mk('label', 'rwg-lead');
      const rd = mk('input');
      rd.type = 'radio';
      rd.name = 'wg-lead';
      rd.checked = w.lead === key;
      rd.dataset.fid = `wg-lead-${key}`;
      rd.addEventListener('click', (e) => e.stopPropagation());
      rd.addEventListener('change', () => {
        w.lead = key;
        paintFoot();
      });
      lead.addEventListener('click', (e) => e.stopPropagation());
      lead.append(rd, ' lead');
      line.append(fld, lock, lead);
      more.append(line);
      row.append(more);
      rowFields.push([fld, key]);
    }
    return row;
  }

  /* ---- the result, when a start failed ---- */
  function resultBody(box) {
    const a = w.result;
    const wrap = mk('div', 'rwg-result');
    wrap.append(mk('div', 'rwg-rt', `${a.room?.name ?? 'The workgroup'} was created, with problems`));
    wrap.append(mk('div', 'rwg-note', `Moved ${a.moved?.length ?? 0}, started ${(a.started || []).filter((x) => x.ok).length}; @${a.lead} leads.`));
    const ul = mk('ul', 'rwg-problems');
    for (const t of a.problems || []) { ul.append(mk('li', '', t)); }
    wrap.append(ul);
    box.append(wrap);
  }

  /* ---- footer ---- */
  function footer(ft, close) {
    if (w.error) {
      const e = mk('div', 'ras-err', w.error);
      e.setAttribute('role', 'status');
      ft.append(e);
    }
    if (w.result) {
      const open = button('ras-btn pri', 'Open workgroup', 'wg-open');
      open.addEventListener('click', () => {
        const a = w.result;
        close();
        c.done(a, true);
      });
      const done = button('ras-btn', 'Close', 'wg-close');
      done.addEventListener('click', () => {
        const a = w.result;
        close();
        c.done(a, false);
      });
      ft.append(mk('span', 'rwg-sum'), done, open);
      return;
    }
    const sum = mk('span', 'rwg-sum');
    const why = mk('span', 'ras-why');
    const cancel = button('ras-btn', 'Cancel', 'wg-cancel');
    cancel.addEventListener('click', close);
    const go = button('ras-btn pri ras-go', 'Create workgroup', 'wg-create');
    go.addEventListener('click', () => void create(close));
    ft.append(sum, why, cancel, go);
    paintFoot = () => {
      const bits = [];
      bits.push(w.name.trim() ? `${w.name.trim()} @${w.alias || ELL}` : 'Name it');
      bits.push(`moves ${w.moves.length}`);
      bits.push(`starts ${w.starts.length}`);
      if (w.lead) { bits.push(`lead @${leadHandle() || ELL}`); } else if (picks().length) { bits.push('pick a lead'); }
      sum.textContent = bits.join(` ${MIDDOT} `);
      const n = need();
      go.disabled = w.busy || !!n;
      go.textContent = w.busy ? `Creating${ELL}` : 'Create workgroup';
      why.textContent = n && n !== 'name it' ? n : '';
      why.hidden = !why.textContent;
    };
    paintFoot();
  }

  async function create(close) {
    if (w.busy || need()) { return; }
    w.busy = true;
    w.error = '';
    paintFoot();
    const payload = {
      name: w.name.trim(),
      alias: w.alias,
      ...(w.color ? { color: w.color } : {}), // none sent = the engine auto-picks a distinct one
      move: [...w.moves],
      start: w.starts.map((id) => ({ recipe_id: id, handle: w.handles.get(keyOfStart(id)) })),
      lead: w.lead.startsWith('m:') ? { move: w.lead.slice(2) } : { start: w.lead.slice(2) },
    };
    let r;
    try {
      r = await c.call(`/api/rooms/${encodeURIComponent(room().id)}/workgroups`, payload);
    } catch (e) {
      r = { ok: false, status: 0, body: { error: e?.message ?? String(e) } };
    }
    w.busy = false;
    if (!r.ok) {
      /* all or nothing: the engine wrote nothing, so everything stays as typed */
      w.error = `Not created ${String.fromCharCode(8212)} ${r.body?.error ?? `HTTP ${r.status}`}`;
      c.render();
      return;
    }
    if (r.body.partial) {
      w.result = r.body;
      c.render();
      return;
    }
    close();
    c.done(r.body, false);
  }

  return {
    body,
    footer,
    count: () => w.moves.length + w.starts.length,
    /** the engine said a name check is stale (a room changed): ask again */
    recheck: scheduleCheck,
    state: w,
  };
}
