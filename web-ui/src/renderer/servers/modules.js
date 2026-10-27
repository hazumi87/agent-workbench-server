// the design's approved step-6 module rows. All words from a module are text nodes;
// status and age remain separate from its own summary. A panel owns its refresh
// loop only while visible and bound to the same selected account.
import { el } from '../rooms/line.js';
import { openDialog } from '../rooms/dialog.js';

const ERRORS = {
  'account-changed': 'The selected account changed. Open this server again.',
  'server-login-changed': 'The selected server login changed. Open its modules again.',
  'no-broker-access': 'You need access to a login on this server to see its modules.',
  'broker-update-needed': 'This broker needs an update to show modules.',
  'module-host-unavailable': 'Modules are not available on this broker yet.',
  'realm-unavailable': "Can't reach your account to check access. Try again when it is back.",
  forbidden: "You can't do that on this server any more.",
  'resource-isolation-unavailable': "This server can't apply the module's resource limits yet. Ask an admin to finish its setup.",
  'clock-skew': "The server's clock is off. Ask an admin to set it to the right time.",
  'package-changed': 'This module changed. Refresh the list before installing it.',
  'package-not-offered': 'This version is no longer offered. Refresh the list.',
  'module-start-failed': "The module couldn't start. Open Details to see its status.",
  'module-not-responding': 'The module is not responding.',
};
const age = (at) => {
  if (!at) return 'never';
  const minutes = Math.floor(Math.max(0, Date.now() - at) / 60000);
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`;
};
export function moduleStatus(row, readOnly = false) {
  const states = { stopped: ['wait', 'Stopped'], starting: ['wait', 'Starting…'], healthy: ['ok', 'Healthy'], degraded: ['warn', 'Degraded'], 'not-responding': ['err', 'Not responding'] };
  const [dot, label] = states[row.status] || ['wait', 'Unavailable'];
  return { dot, text: label + (row.status === 'stopped' && readOnly ? ' · ask an admin to start it' : row.status === 'not-responding' ? ' · last heard ' + age(row.lastHeardAt) : '') };
}
export function newerPackage(row, catalog) {
  const number = (v) => String(v).split('.').map(Number);
  const compare = (a, b) => { const aa = number(a), bb = number(b); for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] - bb[i]; return 0; };
  return catalog.filter((p) => p.id === row.id && compare(p.version, row.version) > 0).sort((a, b) => compare(b.version, a.version))[0] || null;
}
const button = (label, fn, kind = 'text') => {
  const b = el('button', 'sv-btn ' + kind, label); b.type = 'button'; b.addEventListener('click', fn); return b;
};

export function createModulePanel({ server, role = 'member', targets, account, accountEpoch = () => 0, call, readOnly = false }) {
  const root = el('section', 'bm-panel');
  const owner = account()?.id;
  const ownerEpoch = accountEpoch();
  const manage = !readOnly && ['admin', 'manager'].includes(role);
  const install = !readOnly && role === 'admin';
  let chosen = null, rows = null, catalog = [], error = null, timer = null, loading = false, busy = false, ended = false;
  let loginEpoch = 0;
  let dialog = null, closeMode = null;
  const live = () => !ended && root.isConnected && root.getClientRects().length > 0 && owner && account()?.id === owner && accountEpoch() === ownerEpoch;
  const candidates = () => (targets() || []).filter((r) => !r.request && !r.keysOnly);
  function target() { const list = candidates(); return chosen ? list.find((r) => r.id === chosen) || null : list[0] || null; }
  const binding = () => ({ id: target()?.id, epoch: loginEpoch });
  const sameLogin = (bound) => bound && bound.id === target()?.id && bound.epoch === loginEpoch;
  async function request(operation, id = target()?.id) {
    if (!live() || !id) return { ok: false, error: 'account-changed' };
    const epoch = loginEpoch;
    let r;
    try { r = await call({ accountId: owner, serverId: id, operation }); } catch { r = { ok: false, error: 'module-operation-failed' }; }
    return !live() ? { ok: false, error: 'account-changed' } : target()?.id === id && epoch === loginEpoch ? r : { ok: false, error: 'server-login-changed' };
  }
  const failure = (r) => ERRORS[r?.error] || "That didn't work. Try again.";
  async function refresh() {
    clearTimeout(timer);
    if (!live() || loading || busy) return;
    if (closeMode) { timer = setTimeout(refresh, 5000); return; }
    const t = target();
    if (!t) { error = ERRORS['no-broker-access']; paint(); return; }
    chosen = t.id; loading = true;
    try {
      const r = await request({ op: 'list' });
      if (!live()) return;
      if (r.ok) { rows = r.result; error = null; } else { rows = null; error = failure(r); }
      if (install && r.ok) {
        const c = await request({ op: 'catalog' });
        if (!live()) return;
        catalog = c.ok ? c.result : [];
      }
    } finally {
      loading = false;
      if (live()) { paint(); timer = setTimeout(refresh, 5000); }
    }
  }
  async function run(operation, bound) {
    if (busy || !live()) return false;
    if (!sameLogin(bound)) { error = ERRORS['server-login-changed']; paint(); return false; }
    busy = true; paint();
    try {
      const r = await request(operation, bound.id);
      if (!live()) return false;
      error = r.ok ? null : failure(r);
      if (r.ok && rows) rows = [...rows.filter((x) => x.id !== r.result.id), r.result];
      return r.ok;
    } finally { busy = false; if (live()) { paint(); clearTimeout(timer); timer = setTimeout(refresh, 500); } }
  }
  function show(o) { closeMode?.(); dialog?.close(); dialog = openDialog(root, o); }
  async function details(row, bound) {
    if (!sameLogin(bound)) return;
    const r = await request({ op: 'details', moduleId: row.id }, bound.id);
    if (!live()) return;
    if (!r.ok) { error = failure(r); paint(); return; }
    const d = r.result, body = el('div', 'bm-details');
    body.append(el('p', null, `${d.name} ${d.version}`), el('p', null, moduleStatus(d).text));
    if (d.summary) body.append(el('p', null, d.summary + ' · last heard ' + age(d.lastHeardAt)));
    if (d.details || d.reason) body.append(el('p', null, d.details || d.reason));
    for (const line of d.logs || []) body.append(el('p', 'sv-sm', [line.at ? new Date(line.at).toLocaleString() : '', line.event, line.result].filter(Boolean).join(' · ')));
    show({ title: d.name + ' · Details', body, actions: [{ label: 'Close', primary: true }] });
  }
  async function stop(row, bound) {
    if (!sameLogin(bound)) return;
    const r = await request({ op: 'details', moduleId: row.id }, bound.id);
    if (!live()) return;
    if (!r.ok) { error = failure(r); paint(); return; }
    show({ title: `Stop ${row.name} on ${server.name}?`, text: 'Your terminals and CLIs are not affected. ' + (r.result.stopWarning || `Only ${row.name} stops until someone starts it again.`), actions: [{ label: 'Cancel' }, { label: 'Stop', kind: 'filled', primary: true, fn: () => run({ op: 'stop', moduleId: row.id }, bound) }] });
  }
  function mode(anchor, row, bound) {
    if (!sameLogin(bound)) return;
    closeMode?.();
    const body = el('div', 'sv-menu bm-modes');
    body.setAttribute('role', 'menu'); body.setAttribute('aria-label', row.name + ' modes');
    const close = () => {
      body.remove(); document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('resize', close); document.removeEventListener('scroll', close, true);
      closeMode = null;
    };
    const away = (e) => { if (!body.contains(e.target)) close(); };
    closeMode = close;
    for (const m of row.modes) {
      const b = button('', () => { close(); void run({ op: 'mode', moduleId: row.id, mode: m.id }, bound); });
      b.className = 'sv-mi'; b.setAttribute('role', 'menuitemradio'); b.setAttribute('aria-checked', String(row.mode === m.id));
      const words = el('span', 'sv-mit'); words.append(el('b', null, m.label), el('small', 'ds', m.description || ''));
      const check = el('span', 'ms ck' + (row.mode === m.id ? '' : ' off'), 'check');
      b.append(check, words); body.append(b);
    }
    body.append(el('p', 'sv-sm', 'The module lists these modes. The Workbench adds none.'));
    root.append(body);
    const r = anchor.getBoundingClientRect(), m = body.getBoundingClientRect();
    body.style.left = Math.max(8, Math.min(r.left, innerWidth - m.width - 8)) + 'px';
    body.style.top = Math.max(8, Math.min(r.bottom + 4, innerHeight - m.height - 8)) + 'px';
    const buttons = [...body.querySelectorAll('button')];
    buttons.find((b) => b.getAttribute('aria-checked') === 'true')?.focus({ preventScroll: true });
    body.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key === 'Tab') { close(); anchor.focus({ preventScroll: true }); if (e.key === 'Escape') e.preventDefault(); return; }
      const i = buttons.indexOf(document.activeElement);
      const next = e.key === 'ArrowDown' ? (i + 1) % buttons.length : e.key === 'ArrowUp' ? (i - 1 + buttons.length) % buttons.length : e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : -1;
      if (next >= 0) { e.preventDefault(); buttons[next].focus({ preventScroll: true }); }
    });
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('resize', close); document.addEventListener('scroll', close, true);
  }
  function offer(pkg, update = false, bound = binding()) {
    if (!sameLogin(bound)) return;
    const body = el('div');
    if (pkg.capabilities?.length) body.append(el('p', 'sv-sm', 'Capabilities: ' + pkg.capabilities.join(', ')));
    if (pkg.resources) body.append(el('p', 'sv-sm', `Limits: ${Math.ceil(pkg.resources.memoryBytes / 1048576)} MB memory · ${pkg.resources.cpuPercent}% CPU · ${pkg.resources.pids} processes`));
    body.append(el('p', 'sv-sm', 'Runs as ' + (target()?.login || 'this server login')));
    show({ title: `${update ? 'Update' : 'Install'} ${pkg.name} on ${server.name}?`, body, text: `${pkg.name} ${pkg.version}. ${pkg.summary || ''} Installing a module doesn't restart the broker, and ends no CLI. It stays stopped until you start it.`, actions: [{ label: 'Cancel' }, { label: update ? 'Update' : 'Install', kind: 'filled', primary: true, fn: () => run({ op: update ? 'update' : 'install', moduleId: pkg.id, version: pkg.version, manifestHash: pkg.manifestHash }, bound) }] });
  }
  function chooseInstall(bound) {
    if (!sameLogin(bound)) return;
    const body = el('div', 'bm-catalog');
    const offered = catalog.filter((p) => !(rows || []).some((r) => r.id === p.id));
    if (!offered.length) body.append(el('p', null, 'No other modules are offered by this broker.'));
    for (const p of offered) {
      const row = el('div', 'bm-row'), words = el('div', 'bm-words');
      words.append(el('b', null, `${p.name} ${p.version}`)); if (p.summary) words.append(el('small', null, p.summary));
      row.append(words, button('Install', () => offer(p, false, bound), 'tonal')); body.append(row);
    }
    body.append(el('p', 'sv-sm', "Installing a module doesn't restart the broker, and ends no CLI."));
    show({ title: 'Install a module on ' + server.name, body, actions: [{ label: 'Close' }] });
  }
  const content = el('div'); root.append(content);
  function paint() {
    content.textContent = '';
    content.append(el('p', 'sv-help', `Modules run on ${server.name} beside the broker. They never see what is in your terminals.`));
    const targetsNow = candidates(), t = target();
    const bound = binding();
    if (targetsNow.length > 1) {
      const label = el('label', 'sv-field', 'Server login'); const select = el('select');
      for (const r of targetsNow) { const opt = el('option', null, r.login); opt.value = r.id; opt.selected = r.id === t?.id; select.append(opt); }
      select.disabled = busy || loading;
      select.addEventListener('change', () => { chosen = select.value; loginEpoch++; closeMode?.(); dialog?.close(); rows = null; catalog = []; error = null; void refresh(); });
      label.append(select); content.append(label);
    }
    if (t) {
      const broker = el('div', 'bm-row'); broker.append(el('span', 'ms', 'hub'), el('b', null, 'Broker'), el('span', 'sv-sm', [t.brokerVersion, t.line].filter(Boolean).join(' · '))); content.append(broker);
    }
    if (error) { const p = el('p', 'sv-status', error); p.setAttribute('role', 'status'); content.append(p); }
    if (rows === null && !error) content.append(el('p', 'sv-sm', 'Loading modules…'));
    if (rows?.length === 0) content.append(el('p', 'sv-sm', 'No modules installed yet.'));
    for (const row of rows || []) {
      const box = el('div', 'bm-row'); box.dataset.module = row.id;
      const status = moduleStatus(row, !manage), words = el('div', 'bm-words');
      words.append(el('b', null, row.name));
      const line = el('small'); line.append(el('span', 'sv-dot ' + status.dot), document.createTextNode(status.text)); words.append(line);
      if (row.summary && row.status !== 'stopped') words.append(el('small', null, row.summary));
      box.append(el('span', 'ms', 'extension'), words);
      if (manage) {
        const acts = el('div', 'bm-actions'); acts.append(button('Details', () => details(row, bound)));
        if (row.status === 'stopped') acts.append(button('Start', () => run({ op: 'start', moduleId: row.id }, bound), 'tonal'));
        else if (row.status === 'not-responding') acts.append(button('Restart', () => run({ op: 'restart', moduleId: row.id }, bound), 'tonal'));
        else if (row.status !== 'starting') { if (row.modes.length) acts.append(button('Mode ▾', (e) => mode(e.currentTarget, row, bound), 'tonal')); acts.append(button('Stop', () => stop(row, bound))); }
        for (const b of acts.querySelectorAll('button')) b.disabled = busy;
        box.append(acts);
      }
      content.append(box);
      const update = install ? newerPackage(row, catalog) : null;
      if (update) { const note = el('div', 'sv-note', `${row.name} ${update.version} is available.`); const b = button('Update', () => offer(update, true, bound)); b.disabled = busy; note.append(b, document.createTextNode('A module update ends no CLI.')); content.append(note); }
    }
    if (install && rows !== null) { const b = button('Install a module…', () => chooseInstall(bound), 'tonal'); b.disabled = busy; content.append(b); }
    // Members get read-only rows; the server still authorizes every read.
    if (manage || error) { const b = button('Refresh', refresh); b.disabled = loading || busy; content.append(b); }
  }
  paint();
  timer = setTimeout(refresh, 0);
  return { el: root, refresh, destroy() { ended = true; clearTimeout(timer); closeMode?.(); dialog?.close(); root.remove(); } };
}
