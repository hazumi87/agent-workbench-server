// Header-only tool host. No terminal, audio, credential or engine-content access.
const STATES = new Set(['idle', 'listening', 'busy', 'speaking', 'error']);
const ICONS = new Set(['mic', 'mic_off', 'volume_up', 'hearing', 'science']);
const same = (a, b) => !!a && !!b && a.epoch === b.epoch && a.accountEpoch === b.accountEpoch && a.sid === b.sid;
const text = (v, max, empty = false) => typeof v === 'string' && v.length <= max && (empty || v.trim().length > 0);
export function slotInstallSeq(record) {
  if (record?.source === 'bundled') return 0;
  return Number.isSafeInteger(record?.installSeq) && record.installSeq > 0 ? record.installSeq : null;
}
const sequence = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function order(a, b) {
  if (a.order !== b.order) {
    if (a.order === null) return 1;
    if (b.order === null) return -1;
    return a.order < b.order ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
function descriptor(value) {
  const d = { ...value };
  if (d.state === 'checking' || d.state === 'unavailable') { d.state = 'idle'; d.disabled = true; }
  else if (d.state === 'understanding' || d.state === 'replying') { d.state = 'busy'; d.disabled = false; }
  if (!ICONS.has(d.icon) || !text(d.label, 80) || !STATES.has(d.state) ||
      (d.disabled !== undefined && typeof d.disabled !== 'boolean') || (d.detail !== undefined && !text(d.detail, 240, true))) throw new Error('Invalid Concierge slot descriptor');
  return { icon: d.icon, label: d.label, state: d.state, disabled: d.disabled === true, detail: d.detail || '' };
}

export function createConciergeSlots({ readBinding, changed = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const records = new Map(); let context = null;
  const read = () => { const b = readBinding(); return b?.open && b.sid ? { epoch: b.epoch, accountEpoch: b.accountEpoch, sid: b.sid } : null; };
  const paint = () => { if (readBinding()?.open) changed(); };
  const stopLevel = r => { if (r.timer !== null) clearTimer(r.timer); r.timer = null; r.pending = undefined; r.level = undefined; };
  const revoke = r => { stopLevel(r); r.binding = null; r.value = { ...r.value, icon: r.base.icon, label: r.base.label, state: 'idle', detail: '' }; };
  function refresh() {
    const next = read();
    if (same(context, next) || !context && !next) return;
    context = next;
    for (const r of records.values()) revoke(r);
    paint();
  }
  function valid(r, binding) {
    refresh(); return records.get(r.id) === r && context !== null && binding !== null && binding === r.binding && same(r.owner, context);
  }
  function getBinding(r) {
    refresh(); if (!context || records.get(r.id) !== r) return null;
    if (!r.binding) { r.owner = { ...context }; r.binding = Object.freeze({}); }
    return r.binding;
  }
  function update(r, patch, binding) {
    if (!valid(r, binding)) return false;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k => !['icon', 'label', 'state', 'disabled', 'detail', 'level'].includes(k))) throw new Error('Invalid Concierge slot descriptor');
    const { level, ...fields } = patch;
    if (Object.keys(fields).length) {
      const state = fields.state;
      // A normal state clears a prior transient checking/unavailable disable.
      const normal = state && STATES.has(state) && fields.disabled === undefined ? { disabled: false } : {};
      const next = descriptor({ ...r.value, ...normal, ...fields });
      const differs = Object.keys(next).some(key => next[key] !== r.value[key]);
      r.value = next;
      if (r.value.state !== 'listening' || r.value.disabled) stopLevel(r);
      if (differs) paint();
    }
    if (Object.hasOwn(patch, 'level')) {
      if (typeof level !== 'number' || !Number.isFinite(level) || level < 0 || level > 1 || r.value.state !== 'listening' || r.value.disabled) return false;
      r.pending = level;
      if (r.timer === null) r.timer = setTimer(() => {
        r.timer = null;
        if (!valid(r, binding) || r.value.state !== 'listening' || r.value.disabled) { stopLevel(r); return; }
        r.level = r.pending; r.pending = undefined; paint();
      }, 100);
    }
    return true;
  }
  return Object.freeze({
    refresh,
    invalidate() { context = null; for (const r of records.values()) revoke(r); paint(); },
    register(id, value, activate, installOrder = null) {
      if (typeof id !== 'string' || !/^[a-z][a-z0-9.-]{0,79}$/.test(id) || typeof activate !== 'function') throw new Error('Invalid Concierge slot descriptor');
      if (records.has(id)) throw new Error('Concierge slot already registered');
      const base = descriptor(value);
      const r = { id, base, value: { ...base }, activate, order: sequence(installOrder), binding: null, owner: null, level: undefined, timer: null };
      records.set(id, r); refresh(); paint();
      return Object.freeze({ binding: () => getBinding(r), update: (patch, binding) => update(r, patch, binding),
        setOrder(value) { if (records.get(id) !== r) return; const next = sequence(value); if (r.order !== next) { r.order = next; paint(); } },
        dispose() { if (records.get(id) !== r) return; stopLevel(r); r.binding = null; records.delete(id); paint(); } });
    },
    list() { return [...records.values()].sort(order).map(r => Object.freeze({ id: r.id, ...r.value, disabled: r.value.disabled || !read(), level: r.level })); },
    activate(id) {
      const r = records.get(id); if (!r) return false;
      const binding = getBinding(r); if (!binding || r.value.disabled) return false;
      try { Promise.resolve(r.activate(Object.freeze({ type: 'button', action: 'tap', binding }))).catch(() => {
        if (valid(r, binding)) update(r, { state: 'error', detail: 'The tool did not respond. Try again.' }, binding);
      }); } catch (_) { update(r, { state: 'error', detail: 'The tool did not respond. Try again.' }, binding); }
      return true;
    },
  });
}

// Each paint may replace the whole header. Keep state in the host, never the DOM.
// Update existing buttons in place, so an ordinary state/level update never takes focus.
export function mountConciergeSlots({ host, header, icon, focusId = null, before = null, detailsBefore = null }) {
  const doc = header.ownerDocument, wrap = doc.createElement('div'), label = doc.createElement('span'), tools = doc.createElement('span'), buttons = new Map();
  wrap.className = 'cg-tool-slots'; label.className = 'cg-scope'; label.textContent = 'Local'; tools.className = 'cg-tool-buttons'; wrap.append(label, tools); header.insertBefore(wrap, before);
  const details = doc.createElement('div'); details.className = 'cg-tool-details'; details.hidden = true;
  details.setAttribute('role', 'status'); details.setAttribute('aria-live', 'polite');
  if (detailsBefore) detailsBefore.parentElement.insertBefore(details, detailsBefore);
  function render() {
    const focused = [...buttons].find(([, b]) => b === doc.activeElement)?.[0];
    const rows = host.list(), ids = new Set(rows.map(r => r.id));
    for (const [id, button] of buttons) if (!ids.has(id)) {
      const focused = doc.activeElement === button;
      const next = button.nextElementSibling || header.querySelector('.dock-gear, .px');
      button.remove(); buttons.delete(id); if (focused) next?.focus();
    }
    let previous = null;
    for (const row of rows) {
      let b = buttons.get(row.id);
      if (!b) {
        b = doc.createElement('button'); b.type = 'button'; b.className = 'sb-ib cg-tool-button'; b.dataset.toolId = row.id;
        b.addEventListener('click', () => host.activate(row.id)); buttons.set(row.id, b);
      }
      const face = doc.createElement('span'); face.className = 'cg-tool-face'; face.innerHTML = icon(row.icon);
      b.replaceChildren(face); b.disabled = row.disabled;
      b.dataset.state = row.state; b.title = [row.label, row.detail || row.state].join(' · ');
      b.setAttribute('aria-label', b.title); b.setAttribute('aria-pressed', String(row.state === 'listening'));
      b.setAttribute('aria-busy', String(row.state === 'busy'));
      b.style.setProperty('--cg-level', String(row.level ?? 0));
      const expected = previous ? previous.nextElementSibling : tools.firstElementChild;
      if (expected !== b) tools.insertBefore(b, expected || null);
      previous = b;
    }
    const detail = rows.filter(row => row.detail).map(row => `${row.label} · ${row.detail}`).join('\n');
    const layoutChanged = details.textContent !== detail || details.hidden !== !detail;
    // Level-only updates never rewrite the live region or refit the terminal.
    if (details.textContent !== detail) details.textContent = detail;
    details.hidden = !detail;
    if (focused && buttons.has(focused) && doc.activeElement === doc.body) buttons.get(focused).focus();
    return layoutChanged;
  }
  render(); if (focusId) buttons.get(focusId)?.focus();
  return { render, focusedId: () => [...buttons].find(([, b]) => b === doc.activeElement)?.[0] || null, dispose() { wrap.remove(); details.remove(); } };
}
