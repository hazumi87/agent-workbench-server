/* ============================================================================
 * AGENTS · REST [agent rest] (Owner 2026-10-07): two global idle levels for ALL
 * agents, nothing per room.
 *   Rest        level 1: restEnabled + restMinutes. Parks an idle agent with no
 *               background work; any message wakes it.
 *   Disconnect  level 2: the original ROOMS · IDLE REST (Owner 2026-10-04, note
 *               eee9ca063154 item 6), unchanged in behaviour.
 * SYSTEM-wide, not per person:
 * the page mounts this group like the others (web/settings.mjs contract) but
 * reads and writes its own route, GET/PATCH /api/rooms/idle-rest (a person's
 * window writes; the cookie rides along).
 *
 *   memberHours / leadHours   null = off; else hours (shown as hours or days)
 *   leadsWakeMembers          an active lead may wake a resting seat of its room
 *   roomsWakeLeads            a message from another room wakes a resting lead
 *
 * Resting keeps the conversation (a Restore brings it back); it only frees the
 * session. Everything is OFF until switched on here.
 * ========================================================================== */

export const DEFAULTS = { restEnabled: false, restMinutes: 15, memberHours: null, leadHours: null, leadsWakeMembers: false, roomsWakeLeads: false, backgroundGuard: false };

export const GUARD_LINE = "A seat whose screen shows a background command or sub-agent still running is never put to sleep (capped at 6 hours). Needs the engine's screen reading (on).";

export const REST_LINE = 'Parks an idle agent with no background work; any message wakes it; it comes back in 10-20 s at its old size.';

/** The Rest minutes as typed -> a whole number 1..1440, or NaN. */
export function toMinutes(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 1440 ? n : NaN;
}

/** hours -> {value, unit}: whole days when it divides evenly (and is 2+ days). */
export function splitHours(h) {
  if (h === null || h === undefined) {
    return { on: false, value: 24, unit: 'h' };
  }
  return h >= 48 && h % 24 === 0 ? { on: true, value: h / 24, unit: 'd' } : { on: true, value: h, unit: 'h' };
}

/** {on, value, unit} -> hours, or null when off. NaN when the value is unusable. */
export function toHours(p) {
  if (!p.on) {
    return null;
  }
  const n = Number(p.value);
  return Number.isFinite(n) && n > 0 ? n * (p.unit === 'd' ? 24 : 1) : NaN;
}

function mk(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) {
    n.className = cls;
  }
  if (text !== undefined) {
    n.textContent = text;
  }
  return n;
}

function ensureStyles() {
  if (document.querySelector('link[data-irs]')) {
    return;
  }
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = '/settings-idle-rest.css';
  l.dataset.irs = '1';
  document.head.append(l);
}

async function call(method, body) {
  const res = await fetch('/api/rooms/idle-rest', {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((j && j.error) || `HTTP ${res.status}`);
  }
  return j;
}

/**
 * @param {HTMLElement} el
 */
export async function mountIdleRestSettings(el) {
  ensureStyles();
  let saved = { ...DEFAULTS, ...(await call('GET')) };
  const draft = {
    restEnabled: saved.restEnabled,
    restMinutes: saved.restMinutes,
    member: splitHours(saved.memberHours),
    lead: splitHours(saved.leadHours),
    leadsWakeMembers: saved.leadsWakeMembers,
    roomsWakeLeads: saved.roomsWakeLeads,
  };
  el.textContent = '';
  const g = mk('section', 'irs');
  g.setAttribute('aria-label', 'Agents rest');
  g.append(mk('p', 'pv-note', 'A resting agent keeps its conversation and costs nothing while it rests. Everything here is off until you turn it on.'));

  const refs = {};
  /* LEVEL 1: Rest */
  g.append(mk('h3', 'irs-h', 'Rest'));
  const rrow = mk('div', 'irs-row');
  const ron = mk('input');
  ron.type = 'checkbox';
  ron.id = 'irs-rest-on';
  const rnum = mk('input', 'pv-in irs-num');
  rnum.type = 'number';
  rnum.min = '1';
  rnum.max = '1440';
  rnum.step = '1';
  rnum.id = 'irs-rest';
  ron.addEventListener('change', () => {
    draft.restEnabled = ron.checked;
    paint();
  });
  rnum.addEventListener('input', () => {
    draft.restMinutes = rnum.value;
  });
  const rl = mk('label', 'irs-check');
  rl.append(ron, mk('span', 'pv-lbl', 'Rest idle agents after'));
  rrow.append(rl, rnum, mk('span', 'pv-note', 'minutes'));
  g.append(rrow, mk('p', 'pv-note irs-hint', REST_LINE));
  /* BACKGROUND GUARD (Owner 2026-10-14, room [ref]): its own switch, saved the moment it is flipped (not by Save rest). */
  const gl = mk('label', 'irs-check irs-guard');
  const gb = mk('input');
  gb.type = 'checkbox';
  gb.id = 'irs-guard';
  gb.setAttribute('role', 'switch');
  const gwords = mk('span', 'irs-words');
  gwords.append(mk('span', 'pv-lbl', 'Keep working seats awake'), mk('small', 'pv-note', GUARD_LINE));
  gl.append(gb, gwords);
  const gmsg = mk('p', 'pv-msg irs-guard-msg');
  gmsg.id = 'irs-guard-msg';
  gmsg.setAttribute('role', 'status');
  const gnote = mk('p', 'pv-note irs-hint');
  gnote.id = 'irs-guard-off';
  gnote.hidden = true;
  g.append(gl, gmsg, gnote);
  fetch('/api/diag/vscreen').then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (d && typeof d.mode === 'string' && d.mode !== 'shadow') {
      gnote.textContent = 'Needs screen reading, which is off.';
      gnote.hidden = false;
    }
  }).catch(() => {});
  gb.addEventListener('change', async () => {
    const want = gb.checked;
    gb.disabled = true;
    gmsg.textContent = 'Saving…';
    gmsg.dataset.kind = '';
    try {
      const r = await call('PATCH', { backgroundGuard: want });
      saved = { ...saved, backgroundGuard: !!r.backgroundGuard };
      gb.checked = saved.backgroundGuard;
      gmsg.textContent = 'Saved';
    } catch (e) {
      gb.checked = !want;
      gmsg.textContent = `Not saved: ${e?.message ?? e}`;
      gmsg.dataset.kind = 'error';
    } finally {
      gb.disabled = false;
    }
  });
  gb.checked = !!saved.backgroundGuard;
  /* LEVEL 2: Disconnect */
  g.append(mk('h3', 'irs-h', 'Disconnect'));
  g.append(mk('p', 'pv-note irs-hint', 'The long level, for room seats: a disconnected agent comes back with Restore, or a wake the rules below allow.'));
  const period = (key, id, label, hint) => {
    const row = mk('div', 'irs-row');
    const on = mk('input');
    on.type = 'checkbox';
    on.id = `irs-${id}-on`;
    const num = mk('input', 'pv-in irs-num');
    num.type = 'number';
    num.min = '1';
    num.step = '1';
    num.id = `irs-${id}`;
    const unit = mk('select', 'pv-sel irs-unit');
    unit.id = `irs-${id}-unit`;
    for (const [v, t] of [['h', 'hours'], ['d', 'days']]) {
      const o = mk('option', '', t);
      o.value = v;
      unit.append(o);
    }
    on.addEventListener('change', () => {
      draft[key].on = on.checked;
      paint();
    });
    num.addEventListener('input', () => {
      draft[key].value = num.value;
    });
    unit.addEventListener('change', () => {
      draft[key].unit = unit.value;
    });
    const l = mk('label', 'irs-check');
    l.append(on, mk('span', 'pv-lbl', label));
    row.append(l, num, unit);
    g.append(row, mk('p', 'pv-note irs-hint', hint));
    refs[key] = { on, num, unit };
  };
  period('member', 'member', 'Disconnect idle members after', 'A member nobody has spoken to or heard from for this long is disconnected. Not while it is working, waiting on you, or has a draft.');
  period('lead', 'lead', 'Disconnect idle leads after', 'A lead is disconnected only when its whole room is idle: it is the last to go, and its clock starts when everyone else is resting or idle.');

  const flag = (key, id, label, hint) => {
    const l = mk('label', 'irs-check');
    const b = mk('input');
    b.type = 'checkbox';
    b.id = `irs-${id}`;
    b.addEventListener('change', () => {
      draft[key] = b.checked;
    });
    const words = mk('span', 'irs-words');
    words.append(mk('span', 'pv-lbl', label), mk('small', 'pv-note', hint));
    l.append(b, words);
    g.append(l);
    refs[key] = b;
  };
  flag('leadsWakeMembers', 'leads-wake', 'Leads can wake members', 'While active, a lead may wake a resting member of its own room (/wake @name, or by messaging it).');
  flag('roomsWakeLeads', 'rooms-wake', "Rooms can wake other rooms' leads", 'A message from another room to a resting lead brings that lead back. With this on, you can set a shorter lead rest.');

  const acts = mk('div', 'irs-acts');
  const save = mk('button', 'pv-btn pri', 'Save rest');
  save.type = 'button';
  save.id = 'irsSave';
  const msg = mk('p', 'pv-msg');
  msg.setAttribute('role', 'status');
  acts.append(save, msg);
  g.append(acts);

  function paint() {
    ron.checked = !!draft.restEnabled;
    rnum.value = String(draft.restMinutes);
    rnum.disabled = !draft.restEnabled;
    for (const k of ['member', 'lead']) {
      refs[k].on.checked = draft[k].on;
      refs[k].num.value = String(draft[k].value);
      refs[k].unit.value = draft[k].unit;
      refs[k].num.disabled = refs[k].unit.disabled = !draft[k].on;
    }
    refs.leadsWakeMembers.checked = draft.leadsWakeMembers;
    refs.roomsWakeLeads.checked = draft.roomsWakeLeads;
  }
  save.addEventListener('click', async () => {
    try {
      const patch = {
        restEnabled: !!draft.restEnabled,
        restMinutes: toMinutes(draft.restMinutes),
        memberHours: toHours(draft.member),
        leadHours: toHours(draft.lead),
        leadsWakeMembers: draft.leadsWakeMembers,
        roomsWakeLeads: draft.roomsWakeLeads,
      };
      if (Number.isNaN(patch.restMinutes)) {
        throw new Error('rest minutes is a whole number, 1 to 1440');
      }
      if (Number.isNaN(patch.memberHours) || Number.isNaN(patch.leadHours)) {
        throw new Error('a period is a number above zero');
      }
      msg.textContent = 'Saving…';
      msg.dataset.kind = '';
      save.disabled = true;
      saved = { ...DEFAULTS, ...(await call('PATCH', patch)) };
      Object.assign(draft, { restEnabled: saved.restEnabled, restMinutes: saved.restMinutes, member: splitHours(saved.memberHours), lead: splitHours(saved.leadHours) });
      msg.textContent = 'Saved';
      paint();
    } catch (e) {
      msg.textContent = `Not saved: ${e?.message ?? e}`;
      msg.dataset.kind = 'error';
    } finally {
      save.disabled = false;
    }
  });

  el.append(g);
  paint();
  return {};
}
