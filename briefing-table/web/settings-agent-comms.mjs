/* ============================================================================
 * AGENT COMMS [agent comms] (Owner 2026-10-07: every chatter rule configurable,
 * and by default only WATCHED, never blocking work). SYSTEM-wide; reads and
 * writes GET/PATCH /api/agent-comms (a person's window writes; the cookie rides
 * along). Mounted by web/settings.mjs like the other groups.
 *
 *   Off      the rule is not checked
 *   Watch    checked and counted (Agents · chatter shows "would have stopped N");
 *            the line or message goes through
 *   Enforce  the line or message is refused and the agent is told why
 * ========================================================================== */

export const DEFAULTS = {
  ackOnly: 'watch',
  leadEcho: 'watch',
  dmBudget: 'watch',
  dmRepeat: 'watch',
  dmPerHour: 6,
  quietEnabled: true,
  leadRules: false,
  codexOneQueued: true,
  codexSteerControl: true,
  digestOver: 4,
  unaddressedToLead: true,
  personWakes: true,
  personWakeScope: 'all',
  replyInherits: true,
};

/** Which disconnected agents a line of yours wakes (shown while that switch is on). */
export const WAKE_SCOPES = [
  ['all', 'All disconnected agents'],
  ['auto', 'Only agents the system rested or lost, not ones you disconnected'],
];

/** One line under the digest number. */
export const DIGEST_HINT = 'When more messages than this wait for an agent, it gets one summary with a pointer to read them in full; your lines and stop lines still arrive whole. 0 = off.';

/** The on/off switches, in the order shown. */
export const FLAGS = ['quietEnabled', 'leadRules', 'codexOneQueued', 'codexSteerControl', 'unaddressedToLead', 'personWakes', 'replyInherits'];

export const MODES = [
  ['off', 'Off'],
  ['watch', 'Watch'],
  ['enforce', 'Enforce'],
];

/** The four rules, in the order shown, each with one plain line. */
export const RULES = [
  ['ackOnly', 'Acknowledgement-only room lines', 'A room line that only says "Ack", "Noted", "Thanks" and little else. Enforce tells the agent to acknowledge without posting.'],
  ['leadEcho', 'Lead repeating a worker', 'A lead telling you what another agent told you in the last 15 minutes. Enforce holds it; the lead can still send it on purpose.'],
  ['dmBudget', 'Direct-message budget', 'More direct messages from one agent to another in an hour than the number below.'],
  ['dmRepeat', 'Repeated direct messages', 'A direct message that says again what the same agent sent the same recipient within the hour.'],
];

/** The same list under the name the [address only] branch used. */
export const SWITCHES = FLAGS;

/** The draft as a PATCH body, or an error string when the number is unusable. */
export function toPatch(d) {
  const n = Number(d.dmPerHour);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    return 'messages per hour is a whole number, 1 to 1000';
  }
  const dg = Number(d.digestOver);
  if (!Number.isInteger(dg) || dg < 0 || dg > 100) {
    return 'digest after is a whole number, 0 (off) to 100';
  }
  const out = { dmPerHour: n, digestOver: dg, personWakeScope: d.personWakeScope === 'auto' ? 'auto' : 'all' };
  for (const [k] of RULES) {
    out[k] = d[k];
  }
  for (const k of FLAGS) {
    out[k] = !!d[k];
  }
  return out;
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
  if (document.querySelector('link[data-acs]')) {
    return;
  }
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = '/settings-agent-comms.css';
  l.dataset.acs = '1';
  document.head.append(l);
}

async function call(method, body) {
  const res = await fetch('/api/agent-comms', {
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
export async function mountAgentCommsSettings(el) {
  ensureStyles();
  const draft = { ...DEFAULTS, ...(await call('GET')) };
  el.textContent = '';
  const g = mk('section', 'acs');
  g.setAttribute('aria-label', 'Agent comms');
  g.append(mk('p', 'pv-note', 'Rules for how agents talk to each other and to you. Watch only counts (see Agents · chatter); Enforce stops the message and tells the agent why.'));

  const refs = {};
  for (const [key, label, hint] of RULES) {
    const row = mk('div', 'acs-row');
    const id = `acs-${key}`;
    const lab = mk('label', 'pv-lbl acs-lbl', label);
    lab.htmlFor = id;
    const sel = mk('select', 'pv-sel acs-sel');
    sel.id = id;
    for (const [v, t] of MODES) {
      const o = mk('option', '', t);
      o.value = v;
      sel.append(o);
    }
    sel.addEventListener('change', () => {
      draft[key] = sel.value;
    });
    row.append(lab, sel);
    g.append(row, mk('p', 'pv-note acs-hint', hint));
    refs[key] = sel;
  }
  const nrow = mk('div', 'acs-row');
  const nlab = mk('label', 'pv-lbl acs-lbl', 'Direct messages per hour');
  nlab.htmlFor = 'acs-dmPerHour';
  const num = mk('input', 'pv-in acs-num');
  num.type = 'number';
  num.min = '1';
  num.max = '1000';
  num.step = '1';
  num.id = 'acs-dmPerHour';
  num.addEventListener('input', () => {
    draft.dmPerHour = num.value;
  });
  nrow.append(nlab, num);
  g.append(nrow, mk('p', 'pv-note acs-hint', 'From one agent to one other agent, in any hour. Used by the budget rule above.'));

  const drow = mk('div', 'acs-row');
  const dlab = mk('label', 'pv-lbl acs-lbl', 'Digest after');
  dlab.htmlFor = 'acs-digestOver';
  const dnum = mk('input', 'pv-in acs-num');
  dnum.type = 'number';
  dnum.min = '0';
  dnum.max = '100';
  dnum.step = '1';
  dnum.id = 'acs-digestOver';
  dnum.addEventListener('input', () => {
    draft.digestOver = dnum.value;
  });
  drow.append(dlab, dnum);
  g.append(drow, mk('p', 'pv-note acs-hint', DIGEST_HINT));

  const flag = (key, label, hint) => {
    const l = mk('label', 'acs-check');
    const b = mk('input');
    b.type = 'checkbox';
    b.id = `acs-${key}`;
    b.addEventListener('change', () => {
      draft[key] = b.checked;
      if (key === 'personWakes' && refs.personWakeScope) {
        refs.personWakeScope.disabled = !b.checked;
      }
    });
    const words = mk('span', 'acs-words');
    words.append(mk('span', 'pv-lbl', label), mk('small', 'pv-note', hint));
    l.append(b, words);
    g.append(l);
    refs[key] = b;
  };
  flag('quietEnabled', 'Quiet agents', 'Agents you mark quiet (Agents · chatter) get no direct messages from other agents. Off: the marks are kept but ignored.');
  flag('leadRules', 'Lead rules', "Your lines to a room's lead carry: relay once, no 'passed to' confirmation, don't repeat what a worker already told you.");
  flag('codexOneQueued', 'Codex: one message at a time', 'A Codex agent gets one delivery in its queue; the rest wait and arrive together, your lines first.');
  flag('codexSteerControl', 'Codex: stop and answers reach the running turn', 'A stop from you or a lead, or the answer to a question the Codex agent asked, goes into the turn it is running instead of waiting in its queue.');
  flag('unaddressedToLead', 'Lines that name nobody go to the lead', 'A room line goes only to the agents it @-names. Off: a line that names nobody stays in the room and reaches no agent.');
  flag('personWakes', 'Your lines wake disconnected agents', 'A line you send to a disconnected agent brings it back and is delivered once it is ready. Off: it stays undelivered with a Wake button.');
  const wrow = mk('div', 'acs-row');
  const wlab = mk('label', 'pv-lbl acs-lbl', 'Which agents it wakes');
  wlab.htmlFor = 'acs-personWakeScope';
  const wsel = mk('select', 'pv-sel acs-sel');
  wsel.id = 'acs-personWakeScope';
  for (const [v, t] of WAKE_SCOPES) {
    const o = mk('option', '', t);
    o.value = v;
    wsel.append(o);
  }
  wsel.addEventListener('change', () => {
    draft.personWakeScope = wsel.value;
  });
  wrow.append(wlab, wsel);
  g.append(wrow);
  refs.personWakeScope = wsel;
  flag('replyInherits', 'Replies go back to you', "An agent's line that names nobody, after a line you sent it, answers your line and comes to you instead of the lead. Off: it goes to the lead.");

  const acts = mk('div', 'acs-acts');
  const save = mk('button', 'pv-btn pri', 'Save agent comms');
  save.type = 'button';
  save.id = 'acsSave';
  const msg = mk('p', 'pv-msg');
  msg.setAttribute('role', 'status');
  acts.append(save, msg);
  g.append(acts);

  function paint() {
    for (const [k] of RULES) {
      refs[k].value = draft[k];
    }
    num.value = String(draft.dmPerHour);
    dnum.value = String(draft.digestOver);
    for (const k of FLAGS) {
      refs[k].checked = !!draft[k];
    }
    refs.personWakeScope.value = draft.personWakeScope === 'auto' ? 'auto' : 'all';
    refs.personWakeScope.disabled = !draft.personWakes;
  }
  save.addEventListener('click', async () => {
    try {
      const patch = toPatch(draft);
      if (typeof patch === 'string') {
        throw new Error(patch);
      }
      msg.textContent = 'Saving…';
      msg.dataset.kind = '';
      save.disabled = true;
      Object.assign(draft, await call('PATCH', patch));
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
