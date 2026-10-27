/* CONCIERGE settings (the design notes P0): which recipe is the Concierge
 * (a primary and a fallback of the same account, only the vendor differs), which of
 * the pair is active, the Enabled switch, and the allowed actions (every one OFF by
 * default; nothing acts on them before P3). GET|PATCH /api/concierge, a person only.
 * When pane tokens are off on this engine the group SAYS so: the Concierge cannot
 * read the Workbench without them, and it never falls back to the shared bearer.
 * Reuses the Agent comms rows' stylesheet (acs-*) and the page's pv-* classes. */

export const ACTION_LABELS = [
  ['message', 'Message seats', 'Pass your messages to seats over the fabric.'],
  ['summaries', 'Ask leads for summaries', 'A fixed summary request to each lead in a room family.'],
  ['compactReload', 'Compact / reload seats', 'Destructive: each one asks you to sign off first.'],
  ['inject', 'Type into a seat', 'Destructive: never into a seat at a dialog or prompt.'],
  ['startRestore', 'Start / restore seats', 'Destructive: each one asks you to sign off first.'],
  ['dispatch', 'Dispatch', 'Not built yet.'],
];

function mk(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function ensureStyles() {
  if (document.querySelector('link[data-acs]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = '/settings-agent-comms.css';
  l.dataset.acs = '1';
  document.head.append(l);
}

async function call(url, method, body) {
  const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error((j && j.error) || `HTTP ${res.status}`);
  return j;
}

/** The PATCH a draft becomes (pure; exported for the test). */
export function toPatch(d) {
  return {
    enabled: !!d.enabled,
    primary: d.primary || null,
    fallback: d.fallback || null,
    active: d.active === 'fallback' && d.fallback ? 'fallback' : 'primary',
    allowed: { ...d.allowed },
    displayName: (d.displayName || '').trim() || null,
    handle: (d.handle || '').trim().replace(/^@+/, '').toLowerCase() || null,
  };
}

/** @param {HTMLElement} el */
export async function mountConciergeSettings(el) {
  ensureStyles();
  const [st, recipes] = await Promise.all([call('/api/concierge', 'GET'), call('/api/recipes', 'GET').catch(() => [])]);
  const draft = { ...st.settings, allowed: { ...st.settings.allowed } };
  el.textContent = '';
  const g = mk('section', 'acs');
  g.setAttribute('aria-label', 'Concierge');
  g.append(mk('p', 'pv-note', 'Your guide across the Workbench: it knows what is running and where, and answers "where is X?" with links. It writes no code and acts only with your sign-off.'));
  if (!st.prerequisite?.paneTokens) {
    const warn = mk('p', 'pv-msg', st.prerequisite?.message || 'The Concierge needs pane tokens, which are off on this engine.');
    warn.dataset.kind = 'error';
    warn.id = 'cgPrereq';
    g.append(warn);
  }
  const list = (Array.isArray(recipes) ? recipes : recipes?.recipes || []).filter((r) => r && r.id);
  const pick = (key, label, hint) => {
    const row = mk('div', 'acs-row');
    const lab = mk('label', 'pv-lbl acs-lbl', label);
    lab.htmlFor = `cg-${key}`;
    const sel = mk('select', 'pv-sel acs-sel');
    sel.id = `cg-${key}`;
    const none = mk('option', '', 'None');
    none.value = '';
    sel.append(none);
    for (const r of list) {
      const o = mk('option', '', `${r.name} (${r.vendor || 'unknown'})`);
      o.value = r.id;
      sel.append(o);
    }
    sel.value = draft[key] || '';
    sel.addEventListener('change', () => (draft[key] = sel.value || null));
    row.append(lab, sel);
    g.append(row, mk('p', 'pv-note acs-hint', hint));
  };
  const check = (label, hint, get, set, id) => {
    const l = mk('label', 'acs-check');
    const b = mk('input');
    b.type = 'checkbox';
    b.id = id;
    b.checked = get();
    b.addEventListener('change', () => set(b.checked));
    const words = mk('span', 'acs-words');
    words.append(mk('span', 'pv-lbl', label), mk('small', 'pv-note', hint));
    l.append(b, words);
    g.append(l);
  };
  const text = (key, label, hint, ph, id) => {
    const row = mk('div', 'acs-row');
    const lab = mk('label', 'pv-lbl acs-lbl', label);
    lab.htmlFor = id;
    const inp = mk('input', 'pv-in acs-text');
    inp.type = 'text';
    inp.id = id;
    inp.placeholder = ph;
    inp.maxLength = 40;
    inp.autocomplete = 'off';
    inp.autocapitalize = 'off';
    inp.value = draft[key] || '';
    inp.addEventListener('input', () => (draft[key] = inp.value));
    row.append(lab, inp);
    g.append(row, mk('p', 'pv-note acs-hint', hint));
  };
  text('displayName', 'Name', 'What you call it. Spoken, this name (and only this name) is written as the @ name below.', 'Olivia', 'cg-name');
  text('handle', '@ name', 'What you type to reach it: letters, digits, - or _. Leave empty for none.', 'olivia', 'cg-handle');
  check('Enabled', 'Off hides the Concierge icon and takes its access away at once.', () => !!draft.enabled, (v) => (draft.enabled = v), 'cg-enabled');
  pick('primary', 'Primary', 'The recipe that IS the Concierge. Model and effort live on the recipe.');
  pick('fallback', 'Fallback', 'The same Concierge on the other vendor, used when you switch to it.');
  const arow = mk('div', 'acs-row');
  const alab = mk('label', 'pv-lbl acs-lbl', 'Active');
  alab.htmlFor = 'cg-active';
  const asel = mk('select', 'pv-sel acs-sel');
  asel.id = 'cg-active';
  for (const [v, t] of [['primary', 'Primary'], ['fallback', 'Fallback']]) {
    const o = mk('option', '', t);
    o.value = v;
    asel.append(o);
  }
  asel.value = draft.active;
  asel.addEventListener('change', () => (draft.active = asel.value));
  arow.append(alab, asel);
  g.append(arow);
  g.append(mk('p', 'pv-lbl', 'Allowed actions'));
  for (const [key, label, hint] of ACTION_LABELS) {
    check(label, hint, () => !!draft.allowed[key], (v) => (draft.allowed[key] = v), `cg-allow-${key}`);
  }
  const acts = mk('div', 'acs-acts');
  const save = mk('button', 'pv-btn pri', 'Save Concierge');
  save.type = 'button';
  save.id = 'cgSave';
  const msg = mk('p', 'pv-msg');
  msg.setAttribute('role', 'status');
  acts.append(save, msg);
  g.append(acts);
  save.addEventListener('click', async () => {
    try {
      msg.textContent = 'Saving…';
      msg.dataset.kind = '';
      save.disabled = true;
      await call('/api/concierge', 'PATCH', toPatch(draft));
      msg.textContent = 'Saved';
    } catch (e) {
      msg.textContent = `Not saved: ${e?.message ?? e}`;
      msg.dataset.kind = 'error';
    } finally {
      save.disabled = false;
    }
  });
  el.append(g);
  return {};
}
