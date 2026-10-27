// The Servers tab (step 3e; , ; the design's workbench-step3e-servers-tab, ; PM ,
// , ). Native, over window.wb.servers (main signs every call with the device key):
//  - the list: the realm Overview's table for the servers you manage, plus "Your role";
//  - a server: the header (back, name, state, your role, [Grant access]), then People · Logins · Requests ·
//    Recipes · Install;
//  - People: each person's role (a picker for admins; plain for managers; "Set by the realm" for a realm
//    admin); lowering your own role asks first; "server needs an admin" when it would leave none. The
//    "May grant elevation" switch stays hidden until 6b (PM );
//  - Recipes: Everyone / Only these people (chips) / No one, saved at once, with its status line;
//  - writes that need the passkey (a role, approving, granting, removing access) open the browser: the
//    "Continue in your browser" strip [Open it again] until the realm says how it ended;
//  - sign-in, empty and "only you" states.
// A FOLDER OF ITS OWN: it reaches the rest of the app only through the deps it is given.
import { icon } from '../m3-chrome.js';
import { el } from '../rooms/line.js';
import { openDialog } from '../rooms/dialog.js';
import { createModulePanel } from './modules.js';
import { createSearchPicker } from './search-picker.js';

const ROLE = { admin: 'Admin', manager: 'Manager', member: 'Member' };
const ROLE_LINE = {
  admin: 'Everything on this server, including roles',
  manager: "Approves and revokes access and sets who can start recipes. Can't change roles",
  member: 'Uses their own access',
};
const RANK = { admin: 3, manager: 2, member: 1 };
const TABS = ['People', 'Logins', 'Requests', 'Recipes', 'Modules', 'Install'];

const WORDS = {
  signIn: 'Sign in to manage your servers',
  signInBody: 'Servers you manage show here after you sign in with your Workbench account.',
  waiting: 'Finish signing in in your browser',
  waitingBody: "Come back here when it says you're done. This page updates by itself.",
  none: "You don't manage any servers",
  noneBody: 'You manage a server when an admin makes you its manager or admin. Servers you only use are under Settings › Servers.',
  listSub: (realm) => 'Servers you are an admin or manager of' + (realm ? ' · ' + realm : ''),
  onlyYou: "You're the only one here.",
  noRequests: 'Nothing to approve',
  noRequestsBody: (s) => 'New requests for ' + s + ' show up here.',
  browserStrip: {
    approve: 'Approving asks for your passkey. Finish there, then come back.',
    role: 'Changing a role asks for your passkey. Finish there, then come back.',
    grant: 'Granting access asks for your passkey. Finish there, then come back.',
    revoke: 'Removing access asks for your passkey. Finish there, then come back.',
  },
  policyTitle: (s) => 'Who can start recipes on ' + s,
  policyHelp: 'A shell and This machine always work.',
  // PM : a governance control, not a security boundary
  policyHonest: "This controls recipes. A plain shell is always allowed; to restrict programs, use the server login's own permissions.",
  policies: (s) => [
    ['everyone', 'Everyone', 'Anyone with access to ' + s],
    ['listed', 'Only these people', 'Others can still open a shell'],
    ['none', 'No one', 'Recipes are off on ' + s + '. Shells still work'],
  ],
  nobodyListed: 'No one is listed yet, so no one can start recipes.',
  saved: (s) => 'Saved · ' + s + "'s broker has it",
  savedAway: (s) => 'Saved · ' + s + "'s broker will get it when it's back",
  saveFailed: "Couldn't save. Try again.",
  appliesTo: 'Applies to the next recipe someone starts. Recipes already running keep running.',
  lastAdmin: (s) => s + ' needs an admin',
  lastAdminBody: (who) => 'Make someone else an admin first, then change ' + who + '.',
  selfTitle: (role, s) => 'Make yourself ' + (role === 'manager' ? 'a manager' : 'a member') + ' of ' + s + '?',
  selfBody: "You won't be able to change roles here afterward. Another admin can change it back.",
  selfGo: (role) => (role === 'manager' ? 'Make me a manager' : 'Make me a member'),
  roleDone: (who, role, s) => who + ' is now ' + (role === 'admin' ? 'an admin' : role === 'manager' ? 'a manager' : 'a member') + ' of ' + s,
  realmAdminTip: 'A realm admin is admin on every server.',
  setByRealm: 'Set by the realm',
  // the action ended without effect: what the realm said
  failed: {
    'last-admin': null, // its own dialog
    'realm-admin': "That person is an admin of the whole account. Change it in the Console's People page.",
    'not-allowed': "You can't do that on this server any more.",
    gone: 'That request or access is gone.',
    passkey: "The passkey wasn't accepted. Try again.",
    expired: 'The browser step took too long. Try again.',
  },
  clock: "Your computer's clock is off. Set it to the right time, then try again.",
  unreachable: (h) => "Can't reach " + (h || 'your account') + '.',
  // Install (words UNDESIGNED until the design's)
  installTitle: (s) => 'Install the broker on ' + s,
  // the design : the app types nothing (the 0.12.2 ruling); the command shows with [Copy]
  installGo: (s, l) => 'Open a terminal to ' + s + ' as ' + l,
  installHint: 'Opens in Terminals. Sign in there, then paste the command.',
  installNoRoute: (s) => "You can't open a terminal to " + s + ' from here. Use the install page in the Console.',
  installNothing: (s) => 'Every login on ' + s + ' has its broker.',
};

const ago = (t) => {
  if (!t) return '—';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' days ago';
};
const initials = (n) =>
  String(n || '?')
    .split(/\s+/)
    .map((x) => x[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
const hue = (id) => {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 45% 42%)`;
};

/** A login's line, as the Overview words it. */
function loginLine(l) {
  if (l.health === 'failed') return { dot: 'err', text: 'the installer failed' };
  if (l.state === 'awaiting') return { dot: 'wait', text: 'waiting for the installer' };
  if (l.state === 'pending') return { dot: 'wait', text: 'waiting for approval' };
  if (l.health === 'never') return { dot: 'wait', text: 'no heartbeat yet' };
  if (l.health === 'down') return { dot: 'err', text: 'broker not running · ' + ago(l.lastSeen) };
  if (l.health === 'late') return { dot: 'warn', text: 'broker late · ' + ago(l.lastSeen) };
  if (l.draining) return { dot: 'warn', text: 'waiting to update' };
  return { dot: 'ok', text: 'running' };
}
const worst = (logins) => {
  const order = { err: 3, warn: 2, wait: 1, ok: 0 };
  return logins.map(loginLine).sort((a, b) => order[b.dot] - order[a.dot])[0] || { dot: 'wait', text: 'no logins' };
};

/**
 * createServersPage({ host, api, account(), signIn(), signInState(), openSettingsServers(), snackbar(text, o),
 *   terminalLogin(serverId) -> login | null, openTerminal(serverId, name) })
 */
export function createServersPage(deps) {
  const { host, api } = deps;
  let modulePanel = null;
  let menuCleanup = null;
  let grantAccessDialog = null;
  host.classList.add('sv-root');
  const st = {
    view: 'list',
    serverId: null,
    tab: 'People',
    list: null,
    detail: null,
    people: null,
    error: null,
    action: null, // { id, kind, says, target, role, until }
    poll: null,
    policySave: null, // 'saving' | 'ok' | 'away' | 'failed'
    lastPolicy: null,
  };
  const selection = () => JSON.stringify([deps.account()?.id || null, deps.accountEpoch?.() || 0]);
  let selected = selection(), navigation = 0;
  const stamp = () => ({ selection: selection(), navigation });
  const current = (s, detail) => selected === selection() && s.selection === selected && s.navigation === navigation && (!detail || st.detail === detail);
  function syncAccount() {
    const now = selection();
    if (now === selected) return;
    grantAccessDialog?.close(); grantAccessDialog = null;
    selected = now; navigation++;
    clearInterval(st.poll);
    Object.assign(st, { view: 'list', serverId: null, tab: 'People', list: null, detail: null, people: null, error: null, action: null, poll: null, policySave: null, lastPolicy: null, install: null });
    modulePanel?.destroy(); modulePanel = null;
  }

  const why = (r) => {
    if (!r) return 'unreachable';
    if (r.status === 0) return r.why || 'unreachable';
    if (r.json && r.json.error) return r.json.error;
    return r.status === 404 ? 'not-found' : 'error';
  };

  async function loadList() {
    const s = stamp();
    const r = await api.list();
    if (!current(s)) return;
    if (r.status === 200 && r.json && r.json.ok) {
      st.list = r.json.servers;
      st.error = null;
    } else {
      st.error = why(r);
    }
    paint();
  }
  async function loadServer(id) {
    const s = stamp();
    const r = await api.get(id);
    if (!current(s) || st.serverId !== id) return;
    if (r.status === 200 && r.json && r.json.ok) {
      st.detail = r.json;
      st.error = null;
    } else if (r.status === 404) {
      // no longer yours to manage (a role changed): back to the list
      st.view = 'list';
      st.detail = null;
      await loadList();
      return;
    } else {
      st.error = why(r);
    }
    paint();
  }
  async function loadPeople() {
    if (st.people) return st.people;
    const s = stamp();
    const r = await api.people();
    if (!current(s)) return [];
    st.people = r.status === 200 && r.json && r.json.ok ? r.json.people : [];
    return st.people;
  }

  /** The realm's answer to a passkey write: 202 + action (main opened the browser), or a refusal. */
  function startAction(r, kind, extra) {
    if (r.status === 202 && r.json && r.json.action) {
      st.action = { id: r.json.action.id, kind, says: r.json.action.says, until: r.json.action.expiresAt, ...extra };
      clearInterval(st.poll);
      st.poll = setInterval(pollAction, 1500);
      paint();
      return true;
    }
    failWith(why(r));
    return false;
  }
  async function pollAction() {
    const selectedAt = stamp();
    if (!current(selectedAt)) return;
    const a = st.action;
    if (!a) {
      clearInterval(st.poll);
      return;
    }
    const r = await api.action(a.id);
    if (!current(selectedAt) || st.action !== a) return;
    const s = r.status === 200 && r.json ? r.json.state : null;
    if (s === 'done') {
      clearInterval(st.poll);
      st.action = null;
      if (a.kind === 'role' && a.target) {
        deps.snackbar(WORDS.roleDone(a.target.name, a.role, (st.detail && st.detail.server.name) || 'the server'));
      }
      await refresh();
    } else if (s === 'failed' || s === 'expired') {
      clearInterval(st.poll);
      st.action = null;
      paint();
      failWith(s === 'expired' ? 'expired' : (r.json && r.json.why) || 'passkey', a);
    } else if (!s && r.status !== 0) {
      clearInterval(st.poll);
      st.action = null;
      paint();
    }
  }
  function failWith(w, a) {
    if (w === 'last-admin') {
      const s = (st.detail && st.detail.server.name) || 'This server';
      openDialog(host, { title: WORDS.lastAdmin(s), text: WORDS.lastAdminBody((a && a.target && a.target.name) || 'them'), actions: [{ label: 'OK', kind: 'filled', primary: true }] });
      return;
    }
    if (w === 'clock') {
      deps.snackbar(WORDS.clock);
      return;
    }
    if (w === 'scope' || w === 'no-token' || w === 'signed-out' || w === 'no-account' || w === 'no-device') {
      st.error = 'scope';
      paint();
      return;
    }
    if (w === 'unreachable') {
      deps.snackbar(WORDS.unreachable(deps.account() && deps.account().address));
      return;
    }
    deps.snackbar(WORDS.failed[w] || "That didn't work. Try again.");
  }

  async function refresh() {
    syncAccount();
    if (st.view === 'server' && st.serverId) {
      await loadServer(st.serverId);
    } else {
      await loadList();
    }
  }

  /* --- painting ------------------------------------------------------------------------------------ */

  function center(ic, title, body, buttons) {
    const box = el('div', 'sv-empty');
    const inner = el('div', 'sv-empty-in');
    inner.innerHTML = icon(ic);
    inner.appendChild(el('b', null, title));
    inner.appendChild(el('span', null, body));
    if (buttons && buttons.length) {
      const row = el('div', 'sv-empty-acts');
      for (const b of buttons) row.appendChild(b);
      inner.appendChild(row);
    }
    box.appendChild(inner);
    return box;
  }
  function button(label, kind, fn, o = {}) {
    const b = el('button', 'sv-btn ' + kind, null);
    b.type = 'button';
    if (o.icon) b.innerHTML = icon(o.icon);
    b.appendChild(document.createTextNode(label));
    if (o.data) b.dataset.sv = o.data;
    b.addEventListener('click', fn);
    return b;
  }

  function paint() {
    grantAccessDialog?.close(); grantAccessDialog = null;
    closeMenu();
    syncAccount();
    modulePanel?.destroy();
    modulePanel = null;
    host.textContent = '';
    const local = deps.localFirstState?.();
    if (local && !local.servers.length && deps.renderLocalEmpty) {
      deps.renderLocalEmpty(host);
      return;
    }
    const acct = deps.account();
    const signing = deps.signInState && deps.signInState();
    if (signing === 'waiting') {
      host.appendChild(center('open_in_browser', WORDS.waiting, WORDS.waitingBody, [button('Cancel', 'text', () => deps.signInCancel && deps.signInCancel()), button('Open it again', 'tonal', () => deps.signInReopen && deps.signInReopen())]));
      return;
    }
    if (!acct || st.error === 'scope' || !acct.serversScope) {
      host.appendChild(center('lock', WORDS.signIn, WORDS.signInBody, [button('Sign in', 'filled', () => deps.signIn(), { data: 'signin' })]));
      return;
    }
    if (st.view === 'server' && st.detail) {
      paintServer();
      return;
    }
    if (st.list && !st.list.length) {
      host.appendChild(center('dns', WORDS.none, WORDS.noneBody, [button('Open Settings › Servers', 'tonal', () => deps.openSettingsServers())]));
      return;
    }
    paintList();
  }

  function paintList() {
    const wrap = el('div', 'sv-page');
    const h = el('div', 'sv-h');
    h.appendChild(el('h2', null, 'Servers'));
    wrap.appendChild(h);
    wrap.appendChild(el('p', 'sv-sub', WORDS.listSub(deps.account() && deps.account().realmName)));
    if (!st.list) {
      wrap.appendChild(el('p', 'sv-sub', st.error ? WORDS.unreachable(deps.account().address) : 'Loading…'));
      host.appendChild(wrap);
      return;
    }
    const t = el('table', 'sv-tab');
    t.innerHTML = '<thead><tr><th>Server</th><th>Your role</th><th>Broker</th><th>Last heartbeat</th><th>CLIs running</th></tr></thead>';
    const tb = el('tbody');
    // problems first, as the Overview orders them
    const rank = { err: 0, warn: 1, wait: 2, ok: 3 };
    const rows = [...st.list].sort((a, b) => rank[worst(a.logins).dot] - rank[worst(b.logins).dot] || a.name.localeCompare(b.name));
    for (const s of rows) {
      const tr = el('tr', 'sv-row');
      tr.tabIndex = 0;
      tr.dataset.server = s.id;
      const w = worst(s.logins);
      const td1 = el('td');
      td1.innerHTML = `<span class="sv-dot ${w.dot}" aria-hidden="true"></span>`;
      td1.appendChild(el('b', null, s.name));
      const lines = s.logins.filter((l) => loginLine(l).dot !== 'ok').map((l) => l.login + ': ' + loginLine(l).text);
      td1.appendChild(el('span', 'sv-sm', lines.length ? lines.join(' · ') : s.os === 'windows' ? 'Windows' : s.os === 'mac' ? 'macOS' : 'Linux'));
      const td2 = el('td');
      td2.appendChild(roleChip(s.role));
      if (s.role === 'admin' && deps.account().admin) {
        const i = el('span', 'sv-info');
        i.innerHTML = icon('info');
        i.title = "You're a realm admin.";
        td2.appendChild(i);
      }
      const versions = [...new Set(s.logins.map((l) => l.brokerVersion).filter(Boolean))];
      const seen = Math.max(0, ...s.logins.map((l) => l.lastSeen || 0));
      const live = s.logins.reduce((n, l) => n + (Number(l.live) || 0), 0);
      tr.append(td1, td2, el('td', null, versions.join(', ') || '—'), el('td', null, seen ? ago(seen) : '—'), el('td', null, String(live)));
      const open = () => openServer(s.id);
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') open();
      });
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    wrap.appendChild(t);
    host.appendChild(wrap);
  }

  function roleChip(role, o = {}) {
    const c = el('span', 'sv-rch ' + role, ROLE[role] || role);
    if (o.tip) c.title = o.tip;
    return c;
  }

  function paintServer() {
    const d = st.detail;
    const selectedAt = stamp();
    const s = d.server;
    const mine = d.role;
    const wrap = el('div', 'sv-page');
    // the header: back, name, state, your role, [Grant access]
    const h = el('div', 'sv-sh');
    const back = button('Servers', 'text', () => {
      navigation++;
      st.view = 'list';
      st.serverId = null;
      st.detail = null;
      paint();
      void loadList();
    }, { icon: 'arrow_back', data: 'back' });
    h.appendChild(back);
    h.appendChild(el('h3', null, s.name));
    const w = worst(d.logins);
    const dot = el('span', 'sv-dotw');
    dot.innerHTML = `<span class="sv-dot ${w.dot}"></span>`;
    dot.appendChild(document.createTextNode(w.dot === 'ok' ? 'Running' : w.text.charAt(0).toUpperCase() + w.text.slice(1)));
    h.appendChild(dot);
    h.appendChild(roleChip(mine));
    h.appendChild(el('span', 'sv-grow'));
    h.appendChild(button('Grant access', 'filled', () => grantDialog(), { icon: 'person_add', data: 'grant' }));
    wrap.appendChild(h);
    // the browser strip while a passkey write waits
    if (st.action) {
      const strip = el('div', 'sv-strip');
      strip.innerHTML = icon('open_in_browser');
      const t = el('span', 'sv-strip-t');
      t.appendChild(el('b', null, 'Continue in your browser'));
      t.appendChild(document.createTextNode(' ' + (WORDS.browserStrip[st.action.kind] || WORDS.browserStrip.approve)));
      strip.appendChild(t);
      strip.appendChild(button('Open it again', 'text', () => current(selectedAt, d) && st.action && api.reopen(st.action.id), { data: 'reopen' }));
      const x = el('button', 'sv-ib');
      x.type = 'button';
      x.title = 'Close';
      x.innerHTML = icon('close');
      x.addEventListener('click', () => {
        clearInterval(st.poll);
        st.action = null;
        paint();
      });
      strip.appendChild(x);
      wrap.appendChild(strip);
    }
    // the side tabs
    const tabs = el('div', 'sv-tabs');
    tabs.setAttribute('role', 'tablist');
    const visible = TABS.filter((t) => t !== 'Install' || mine === 'admin');
    if (!visible.includes(st.tab)) st.tab = 'People';
    for (const t of visible) {
      const b = el('button', 'sv-tabb' + (t === st.tab ? ' on' : ''), t);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(t === st.tab));
      b.dataset.tab = t;
      if (t === 'Requests' && d.requests.length) b.appendChild(el('span', 'sv-rch admin sv-count', String(d.requests.length)));
      b.addEventListener('click', () => {
        st.tab = t;
        paint();
      });
      tabs.appendChild(b);
    }
    wrap.appendChild(tabs);
    const body = el('div', 'sv-body');
    body.dataset.tab = st.tab;
    if (st.tab === 'People') paintPeople(body);
    else if (st.tab === 'Logins') paintLogins(body);
    else if (st.tab === 'Requests') paintRequests(body);
    else if (st.tab === 'Recipes') paintRecipes(body);
    else if (st.tab === 'Modules') {
      modulePanel = createModulePanel({ server: s, role: mine, account: deps.account, accountEpoch: deps.accountEpoch, targets: () => deps.moduleTargets(s.id), call: deps.moduleCall });
      body.append(modulePanel.el);
    }
    else paintInstall(body);
    wrap.appendChild(body);
    host.appendChild(wrap);
  }

  function paintPeople(body) {
    const d = st.detail;
    const me = deps.account().userId;
    const head = el('div', 'sv-pr hd');
    head.append(el('div', 'nm', 'Person'), el('div', 'c2', 'Role'), el('div', 'c3', 'Logins'), el('div', 'c3', 'Last signed in'), el('span', 'sv-ibw'));
    body.appendChild(head);
    for (const p of d.people) {
      const row = el('div', 'sv-pr');
      row.dataset.person = p.userId;
      const av = el('span', 'sv-av', initials(p.name || p.email));
      av.style.background = hue(p.userId);
      const nm = el('div', 'nm');
      nm.appendChild(document.createTextNode(p.name || p.email || 'someone'));
      if (p.userId === me) nm.appendChild(el('span', 'sv-rch member sv-you', 'You'));
      nm.appendChild(el('small', null, p.email || ''));
      const c2 = el('div', 'c2');
      if (p.source === 'realm') {
        c2.appendChild(roleChip('admin', { tip: WORDS.realmAdminTip }));
        c2.appendChild(el('small', 'sv-set', WORDS.setByRealm));
      } else if (d.role === 'admin') {
        const rb = el('button', 'sv-rbtn', null);
        rb.type = 'button';
        rb.dataset.role = p.role;
        rb.appendChild(document.createTextNode(ROLE[p.role]));
        rb.insertAdjacentHTML('beforeend', icon('arrow_drop_down'));
        rb.addEventListener('click', () => rolePicker(rb, p));
        c2.appendChild(rb);
      } else {
        c2.appendChild(roleChip(p.role));
      }
      const more = el('button', 'sv-ib');
      more.type = 'button';
      more.title = 'More';
      more.innerHTML = icon('more_vert');
      more.addEventListener('click', () => personMenu(more, p));
      more.hidden = !d.grants.some((g) => g.person.id === p.userId);
      row.append(av, nm, c2, el('div', 'c3', p.logins && p.logins.length ? p.logins.join(', ') : '—'), el('div', 'c3', ago(p.lastSignIn)), more);
      body.appendChild(row);
    }
    if (d.people.length <= 1) {
      const n = el('div', 'sv-note');
      n.innerHTML = icon('group');
      n.appendChild(document.createTextNode(WORDS.onlyYou + ' '));
      const a = el('button', 'sv-link', 'Grant access');
      a.type = 'button';
      a.addEventListener('click', () => grantDialog());
      n.appendChild(a);
      n.appendChild(document.createTextNode(' to add someone.'));
      body.appendChild(n);
    }
  }

  function closeMenu() {
    menuCleanup?.();
    menuCleanup = null;
    host.querySelectorAll('.sv-menu').forEach((m) => m.remove());
  }
  function menuAt(anchor, build) {
    closeMenu();
    const m = el('div', 'sv-menu');
    m.setAttribute('role', 'menu');
    build(m);
    if (!m.querySelector('button')) return; // stale/no-action rows must never open a blank panel
    host.appendChild(m);
    // Fixed coordinates escape the scrolling page's content bounds. Measure the
    // actual menu, clamp to the visible stage, and flip above a low anchor.
    const position = () => {
      if (anchor.isConnected === false) { closeMenu(); return; }
      const r = anchor.getBoundingClientRect(), hr = host.getBoundingClientRect();
      const left = Math.max(0, hr.left) + 8, right = Math.min(window.innerWidth, hr.right) - 8;
      const top = Math.max(0, hr.top) + 8, bottom = Math.min(window.innerHeight, hr.bottom) - 8;
      const width = Math.max(0, right - left), height = Math.max(0, bottom - top);
      m.style.minWidth = Math.min(200, width) + 'px';
      m.style.maxWidth = Math.min(380, width) + 'px';
      m.style.maxHeight = height + 'px';
      m.style.left = left + 'px'; m.style.top = top + 'px';
      const box = m.getBoundingClientRect();
      m.style.left = Math.max(left, Math.min(r.left, right - box.width)) + 'px';
      const y = r.bottom + 4 + box.height <= bottom ? r.bottom + 4 : r.top - box.height - 4;
      m.style.top = Math.max(top, Math.min(y, bottom - box.height)) + 'px';
    };
    const away = (e) => { if (!m.contains(e.target)) closeMenu(); };
    const scroll = (e) => { if (!m.contains(e.target)) position(); };
    const observer = new ResizeObserver(position);
    menuCleanup = () => {
      observer.disconnect();
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', position);
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', position);
    observer.observe(host);
    position();
    m.querySelector('button')?.focus({ preventScroll: true });
    m.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeMenu();
        anchor.focus({ preventScroll: true });
      }
    });
    return m;
  }

  /** The role picker: three rows with their lines; a choice applies through the passkey. */
  function rolePicker(anchor, p) {
    menuAt(anchor, (m) => {
      m.classList.add('roles');
      for (const r of ['admin', 'manager', 'member']) {
        const b = el('button', 'sv-mi' + (r === p.role ? ' on' : ''));
        b.type = 'button';
        b.setAttribute('role', 'menuitemradio');
        b.setAttribute('aria-checked', String(r === p.role));
        b.dataset.role = r;
        b.innerHTML = icon(r === p.role ? 'check' : 'check', r === p.role ? 'ck' : 'ck off');
        const t = el('span', 'sv-mit');
        t.appendChild(el('b', null, ROLE[r]));
        t.appendChild(el('span', 'ds', ROLE_LINE[r]));
        b.appendChild(t);
        b.addEventListener('click', () => {
          closeMenu();
          if (r !== p.role) void changeRole(p, r);
        });
        m.appendChild(b);
      }
      // "May grant elevation" stays hidden until 6b (PM ); the realm keeps the flag
    });
  }

  async function changeRole(p, role) {
    const d = st.detail;
    const selectedAt = stamp();
    if (!d || !deps.account() || !current(selectedAt, d)) return;
    const me = deps.account().userId;
    if (p.userId === me && RANK[role] < RANK[p.role]) {
      const ok = await new Promise((resolve) => {
        openDialog(host, {
          title: WORDS.selfTitle(role, d.server.name),
          text: WORDS.selfBody,
          actions: [
            { label: 'Cancel', kind: 'text', fn: () => resolve(false) },
            { label: WORDS.selfGo(role), kind: 'filled', primary: true, fn: () => resolve(true) },
          ],
          onClose: () => resolve(false),
        });
      });
      if (!ok) return;
    }
    if (!current(selectedAt, d)) return;
    const r = await api.role(d.server.id, p.userId, role);
    if (!current(selectedAt, d)) return;
    startAction(r, 'role', { target: { id: p.userId, name: p.name || p.email }, role });
  }

  function personMenu(anchor, p) {
    const d = st.detail;
    const selectedAt = stamp();
    if (!d || !current(selectedAt, d)) return;
    const grants = d.grants.filter((g) => g.person.id === p.userId);
    menuAt(anchor, (m) => {
      for (const g of grants) {
        const b = el('button', 'sv-mi err');
        b.type = 'button';
        b.dataset.grant = g.id;
        b.innerHTML = icon('person_remove');
        b.appendChild(el('span', 'sv-mit', 'Remove access to ' + d.server.name + ' · ' + g.login + '…'));
        b.addEventListener('click', async () => {
          closeMenu();
          if (!current(selectedAt, d)) return;
          const r = await api.revoke(d.server.id, g.id, false);
          if (!current(selectedAt, d)) return;
          startAction(r, 'revoke', { target: { id: p.userId, name: p.name } });
        });
        m.appendChild(b);
      }
    });
  }

  /** Grant access (as the console's): a person and one of this server's logins, then the passkey. */
  async function grantDialog() {
    const d = st.detail;
    const selectedAt = stamp();
    if (!d || !current(selectedAt, d)) return;
    const people = await loadPeople();
    if (!current(selectedAt, d)) return;
    grantAccessDialog?.close();
    const body = el('div', 'sv-form');
    let dialog;
    const changed = () => dialog?.enable('Grant access', !!who.value() && !!login.value());
    const isCurrent = () => current(selectedAt, d);
    const who = createSearchPicker({ label: 'Person', name: 'person',
      options: people.map(x => ({ id: x.id, label: x.name + (x.email && x.email !== x.name ? ' · ' + x.email : ''),
        search: [x.name, x.email, x.username].filter(Boolean).join(' ') })),
      current: isCurrent, onChange: changed });
    const login = createSearchPicker({ label: 'Login', name: 'login',
      options: d.logins.filter(l => l.state === 'approved' || d.server.keysOnly).map(l => ({ id: l.id, label: l.login })),
      current: isCurrent, onChange: changed });
    body.append(who.el, login.el);
    dialog = openDialog(host, {
      title: 'Grant access to ' + d.server.name,
      body,
      onClose: () => { who.destroy(); login.destroy(); if (grantAccessDialog === dialog) grantAccessDialog = null; },
      actions: [
        { label: 'Cancel', kind: 'text' },
        {
          label: 'Grant access',
          kind: 'filled',
          primary: true,
          fn: async () => {
            if (!current(selectedAt, d)) return true;
            const personId = who.value(), loginId = login.value();
            if (!personId || !loginId) { dialog.error('Choose a person and a login from the results.'); return false; }
            const r = await api.grant(d.server.id, personId, loginId);
            if (!current(selectedAt, d)) return true;
            const name = (people.find((x) => x.id === personId) || {}).name;
            startAction(r, 'grant', { target: { id: personId, name } });
            return true;
          },
        },
      ],
    });
    grantAccessDialog = dialog;
    changed();
  }

  function paintLogins(body) {
    for (const l of st.detail.logins) {
      const row = el('div', 'sv-lrow');
      row.dataset.login = l.login;
      const line = loginLine(l);
      row.innerHTML = `<span class="sv-dot ${line.dot}"></span>`;
      row.appendChild(el('b', null, l.login));
      row.appendChild(el('span', 'sv-sm', line.text + (l.brokerVersion ? ' · broker ' + l.brokerVersion : '') + (l.lastSeen ? ' · ' + ago(l.lastSeen) : '') + (l.live != null ? ' · ' + l.live + ' running' : '')));
      body.appendChild(row);
    }
  }

  function paintRequests(body) {
    const d = st.detail;
    const selectedAt = stamp();
    if (!d.requests.length) {
      body.appendChild(center('inbox', WORDS.noRequests, WORDS.noRequestsBody(d.server.name)));
      return;
    }
    for (const q of d.requests) {
      const row = el('div', 'sv-reqrow');
      row.dataset.request = q.id;
      const av = el('span', 'sv-av', initials(q.person.name));
      av.style.background = hue(q.person.id);
      const nm = el('div', 'nm');
      nm.appendChild(document.createTextNode(q.person.name));
      nm.appendChild(el('small', null, 'wants access to ' + d.server.name + ' as ' + q.login + ' · ' + ago(q.asked)));
      row.append(
        av,
        nm,
        button('Decline', 'text', async () => {
          if (!current(selectedAt, d)) return;
          const r = await api.decline(d.server.id, q.id, '');
          if (!current(selectedAt, d)) return;
          if (r.status === 200) await refresh();
          else failWith(why(r));
        }, { data: 'decline' }),
        button('Approve', 'filled', async () => {
          if (!current(selectedAt, d)) return;
          const r = await api.approve(d.server.id, q.id);
          if (!current(selectedAt, d)) return;
          startAction(r, 'approve', { target: { id: q.person.id, name: q.person.name } });
        }, { data: 'approve' }),
      );
      body.appendChild(row);
    }
  }

  function paintRecipes(body) {
    const d = st.detail;
    const selectedAt = stamp();
    const s = d.server.name;
    const pol = d.policy;
    body.appendChild(el('h4', 'sv-h4', WORDS.policyTitle(s)));
    body.appendChild(el('p', 'sv-help', WORDS.policyHelp));
    const list = el('div', 'sv-radios');
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-label', WORDS.policyTitle(s));
    for (const [v, t, line] of WORDS.policies(s)) {
      const b = el('button', 'sv-rad' + (pol.policy === v ? ' on' : ''));
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(pol.policy === v));
      b.dataset.policy = v;
      b.appendChild(el('i'));
      const tx = el('div');
      tx.appendChild(document.createTextNode(t));
      tx.appendChild(el('small', null, line));
      b.appendChild(tx);
      b.addEventListener('click', () => {
        if (pol.policy !== v && current(selectedAt, d)) void savePolicy(v, pol.allow.map((x) => x.id), d);
      });
      list.appendChild(b);
      if (v === 'listed' && pol.policy === 'listed') {
        const chips = el('div', 'sv-chips');
        for (const a of pol.allow) {
          const c = el('span', 'sv-chip');
          c.dataset.person = a.id;
          c.appendChild(document.createTextNode(a.name));
          const x = el('button', 'sv-chipx');
          x.type = 'button';
          x.title = 'Remove ' + a.name;
          x.innerHTML = icon('close');
          x.addEventListener('click', () => { if (current(selectedAt, d)) void savePolicy('listed', pol.allow.map((y) => y.id).filter((id) => id !== a.id), d); });
          c.appendChild(x);
          chips.appendChild(c);
        }
        const add = button('Add people', 'text', async () => {
          if (!current(selectedAt, d)) return;
          const people = await loadPeople();
          if (!current(selectedAt, d)) return;
          menuAt(add, (m) => {
            for (const p of people.filter((x) => !pol.allow.some((a) => a.id === x.id))) {
              const mi = el('button', 'sv-mi');
              mi.type = 'button';
              mi.dataset.person = p.id;
              mi.appendChild(el('span', 'sv-mit', p.name));
              mi.addEventListener('click', () => {
                closeMenu();
                if (current(selectedAt, d)) void savePolicy('listed', [...pol.allow.map((y) => y.id), p.id], d);
              });
              m.appendChild(mi);
            }
          });
        }, { icon: 'add', data: 'add-people' });
        chips.appendChild(add);
        list.appendChild(chips);
        if (!pol.allow.length) {
          const warn = el('div', 'sv-warn');
          warn.innerHTML = icon('warning');
          warn.appendChild(document.createTextNode(WORDS.nobodyListed));
          list.appendChild(warn);
        }
      }
    }
    body.appendChild(list);
    const note = el('div', 'sv-status');
    note.dataset.status = st.policySave || (pol.delivered ? 'ok' : 'away');
    if (st.policySave === 'failed') {
      note.appendChild(document.createTextNode(WORDS.saveFailed + ' '));
      note.appendChild(button('Try again', 'text', () => current(selectedAt, d) && st.lastPolicy && void savePolicy(st.lastPolicy.policy, st.lastPolicy.allow, d)));
    } else if (st.policySave !== 'saving') {
      note.innerHTML = icon(pol.delivered ? 'check_circle' : 'schedule');
      note.appendChild(document.createTextNode(pol.delivered ? WORDS.saved(s) : WORDS.savedAway(s)));
    }
    body.appendChild(note);
    body.appendChild(el('p', 'sv-help', WORDS.appliesTo));
    body.appendChild(el('p', 'sv-help sv-honest', WORDS.policyHonest));
  }

  async function savePolicy(policy, allow, d) {
    const selectedAt = stamp();
    if (!d || st.detail !== d || !d.policy || !deps.account()) return;
    st.lastPolicy = { policy, allow };
    st.policySave = 'saving';
    // the choice shows at once; the status line says how the save went
    d.policy = { ...d.policy, policy, allow: allow.map((id) => (d.policy.allow.find((a) => a.id === id) || (st.people || []).find((p) => p.id === id) || { id, name: '…' })).map((a) => ({ id: a.id, name: a.name })) };
    paint();
    const r = await api.policy(d.server.id, policy, allow);
    if (!current(selectedAt, d)) return;
    if (r.status === 200 && r.json && r.json.ok) {
      st.policySave = null;
      d.policy = r.json.policy;
    } else {
      st.policySave = 'failed';
      if (why(r) === 'scope' || why(r) === 'clock') failWith(why(r));
    }
    paint();
  }

  function paintInstall(body) {
    const d = st.detail;
    const selectedAt = stamp();
    const s = d.server.name;
    const todo = d.logins.filter((l) => l.state === 'awaiting' || l.health === 'failed');
    body.appendChild(el('h4', 'sv-h4', WORDS.installTitle(s)));
    if (!todo.length) {
      body.appendChild(el('p', 'sv-help', WORDS.installNothing(s)));
      return;
    }
    // the command (one-time tokens), made once per visit to this tab
    if (!st.install || st.install.serverId !== d.server.id) {
      st.install = { serverId: d.server.id, command: null, loading: true };
      const pending = st.install;
      void api.install(d.server.id).then((r) => {
        if (current(selectedAt, d) && st.install === pending) {
          st.install = { serverId: d.server.id, command: r.status === 200 && r.json ? r.json.command : null, loading: false, why: r.status === 200 ? null : why(r) };
          if (st.tab === 'Install') paint();
        }
      });
    }
    const box = el('div', 'sv-code');
    const pre = el('pre', null, st.install.loading ? 'Making the command…' : st.install.command || "Couldn't make the command. Try again.");
    box.appendChild(pre);
    if (st.install.command) {
      const cp = button('Copy', 'text', async () => {
        try {
          if (!current(selectedAt, d)) return;
          await navigator.clipboard.writeText(st.install.command);
          cp.lastChild.textContent = 'Copied';
          setTimeout(() => (cp.lastChild.textContent = 'Copy'), 2000);
        } catch (e) {
          // the clipboard said no; the command is selectable
        }
      }, { icon: 'content_copy', data: 'copy' });
      box.appendChild(cp);
    }
    body.appendChild(box);
    const reach = deps.terminalLogin(d.server.id);
    const row = el('div', 'sv-lrow');
    if (reach) {
      row.appendChild(button(WORDS.installGo(s, reach), 'tonal', () => current(selectedAt, d) && deps.openTerminal(d.server.id, s), { icon: 'terminal', data: 'install' }));
      row.appendChild(el('span', 'sv-sm', WORDS.installHint));
    } else {
      row.appendChild(el('span', 'sv-sm', WORDS.installNoRoute(s)));
    }
    body.appendChild(row);
  }

  async function openServer(id, tab) {
    syncAccount(); navigation++;
    st.view = 'server';
    st.serverId = id;
    st.tab = TABS.includes(tab) ? tab : 'People';
    st.detail = null;
    st.policySave = null;
    st.install = null;
    paint();
    await loadServer(id);
  }

  return {
    destroy() {
      grantAccessDialog?.close(); grantAccessDialog = null; closeMenu();
      clearInterval(st.poll); modulePanel?.destroy(); modulePanel = null;
      navigation++;
    },
    /** The tab came forward: what /me says may have changed (a role), and the page fills. */
    async shown() {
      syncAccount(); const selectedAt = stamp();
      await (api.refreshMe ? api.refreshMe() : null);
      if (!current(selectedAt)) return;
      await refresh();
    },
    paint,
    refresh,
    /** For the self-test. */
    state: () => ({ view: st.view, serverId: st.serverId, tab: st.tab, action: st.action ? { id: st.action.id, kind: st.action.kind } : null, policySave: st.policySave, error: st.error }),
    openServer,
  };
}
