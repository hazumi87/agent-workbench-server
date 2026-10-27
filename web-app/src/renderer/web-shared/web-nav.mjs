// The web build's navigation (the design "Navigation", section 6): four destinations - Workrooms, Terminals, Scratchpad,
// Settings - as tabs in the top bar from 600 px and as a labelled bottom bar under it; the account button with Sign out;
// a skip link; a back arrow with the title inside a room or a Settings sub-page (where the bottom bar is hidden).
// The module host still draws the three module tabs in the top bar; this adds the rest. The renderer owns what a
// destination does (ops) and tells this when something changed (render()); layout is in web-nav/nav.css.
// No DOM watching: state comes from ops and from two web events ('room-shown', 'rooms-waiting').

export const DESTINATIONS = Object.freeze([
  Object.freeze({ id: 'workrooms', label: 'Workrooms', icon: 'forum' }),
  Object.freeze({ id: 'terminals', label: 'Terminals', icon: 'terminal' }),
  Object.freeze({ id: 'scratchpad', label: 'Scratchpad', icon: 'sticky_note_2' }),
  Object.freeze({ id: 'settings', label: 'Settings', icon: 'settings' }),
]);

/** A number or nothing (never a bare dot); capped at 99+. */
export function badgeText(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n > 99 ? '99+' : String(Math.floor(n));
}

const initialOf = (me) => {
  const word = String((me && (me.name || me.handle)) || '').trim();
  return word ? word[0].toUpperCase() : '·';
};
const whoOf = (me) => String((me && (me.name || me.handle)) || '').trim();

export function createWebNav({ document, root, win, bar, appsEl, main, wb, web, brandPath, ops }) {
  const doc = document;
  const made = [];
  const offs = [];
  const make = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const glyph = (name) => { const s = make('span', 'ms', name); s.setAttribute('aria-hidden', 'true'); return s; };

  // ---- skip link: first thing in the page, visible on focus
  const skip = make('a', 'wb-skip', 'Skip to content');
  skip.setAttribute('href', '#main');
  skip.addEventListener('click', (e) => { if (e && e.preventDefault) e.preventDefault(); main.setAttribute('tabindex', '-1'); main.focus(); });
  doc.body.prepend(skip);
  made.push(skip);

  // ---- top bar: back + title (phone, inside a room or a sub-page), the mark, the Settings tab, the account button
  const back = make('button', 'wb-back');
  back.setAttribute('type', 'button');
  back.append(glyph('arrow_back'));
  back.hidden = true;
  const title = make('span', 'wb-title', '');
  title.hidden = true;
  const mark = make('div', 'wb-mark');
  const markSvg = make('span', 'wb-mark-svg');
  markSvg.setAttribute('aria-hidden', 'true');
  markSvg.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" focusable="false"><path fill="currentColor" fill-rule="evenodd" d="${brandPath}"/></svg>`;
  mark.append(markSvg, make('span', 'wb-name', 'Agent Workbench'));
  bar.prepend(mark);
  bar.prepend(title);
  bar.prepend(back);
  made.push(back, title, mark);

  const settingsTab = make('button', 'hwb-apptab');
  settingsTab.id = 'wbNavSettings';
  settingsTab.setAttribute('type', 'button');
  settingsTab.dataset.dest = 'settings';
  settingsTab.append(glyph('settings'), make('span', 'al', 'Settings'));
  settingsTab.addEventListener('click', () => ops.go('settings'));
  if (typeof appsEl.after === 'function') appsEl.after(settingsTab); else bar.append(settingsTab);
  made.push(settingsTab);

  const acctWrap = make('div', 'wb-acct-wrap');
  const acct = make('button', 'wb-acct', '·');
  acct.setAttribute('type', 'button');
  acct.setAttribute('aria-label', 'Account menu');
  acct.setAttribute('aria-haspopup', 'menu');
  acct.setAttribute('aria-expanded', 'false');
  const menu = make('div', 'wb-acct-menu');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Account');
  menu.hidden = true;
  const who = make('div', 'wb-acct-who', 'Signed in');
  const signOut = make('button', 'wb-acct-out', 'Sign out');
  signOut.setAttribute('type', 'button');
  signOut.setAttribute('role', 'menuitem');
  // the server's own account page (password, passkeys, devices) in a new tab (P06)
  const accountLink = make('a', 'wb-acct-link');
  accountLink.setAttribute('href', '/account.html');
  accountLink.setAttribute('target', '_blank');
  accountLink.setAttribute('rel', 'noopener');
  accountLink.setAttribute('role', 'menuitem');
  accountLink.append(make('span', 'wb-acct-ln', 'Account'), make('span', 'wb-acct-ls', 'Password, passkeys, devices'));
  accountLink.addEventListener('click', () => closeMenu(false));
  menu.append(who, accountLink, signOut);
  acctWrap.append(acct, menu);
  bar.append(acctWrap);
  made.push(acctWrap);

  // ---- bottom bar (shown under 600 px by CSS, and only on a top-level screen)
  const bnav = make('nav', 'wb-bnav');
  bnav.setAttribute('aria-label', 'Main');
  const items = new Map();
  for (const d of DESTINATIONS) {
    const item = make('button', 'wb-bni');
    item.setAttribute('type', 'button');
    item.dataset.dest = d.id;
    item.setAttribute('aria-label', d.label);
    item.setAttribute('aria-current', 'false');
    const pill = make('span', 'wb-pill');
    pill.append(glyph(d.icon));
    const badge = make('span', 'wb-badge', '');
    badge.setAttribute('aria-hidden', 'true');
    badge.hidden = true;
    pill.append(badge);
    item.append(pill, make('span', 'wb-bl', d.label));
    item.addEventListener('click', () => ops.go(d.id));
    bnav.append(item);
    items.set(d.id, { item, badge, label: d.label });
  }
  win.append(bnav);
  made.push(bnav);

  // ---- state
  let shown = null; // the room on screen, from 'room-shown'
  let wasOpen = false; // whether the Settings panel was open at the last render
  let me = null;
  let menuOpen = false;

  function paintAccount() {
    acct.textContent = initialOf(me);
    const name = whoOf(me);
    who.textContent = name ? 'Signed in as ' + name : 'Signed in';
  }
  function closeMenu(returnFocus) {
    if (!menuOpen) return;
    menuOpen = false;
    menu.hidden = true;
    acct.setAttribute('aria-expanded', 'false');
    if (returnFocus) acct.focus();
  }
  function openMenu() {
    menuOpen = true;
    menu.hidden = false;
    acct.setAttribute('aria-expanded', 'true');
    signOut.focus();
  }
  acct.addEventListener('click', () => (menuOpen ? closeMenu(true) : openMenu()));
  signOut.addEventListener('click', async () => {
    closeMenu(true);
    try { await wb.rooms.signOut(); } catch (e) { /* the signed-out screen shows whatever state the page is really in */ }
  });
  menu.addEventListener('keydown', (e) => { if (e && e.key === 'Escape') closeMenu(true); });
  if (typeof doc.addEventListener === 'function') {
    const onDocClick = (e) => { if (menuOpen && e && e.target && !acctWrap.contains(e.target)) closeMenu(false); };
    doc.addEventListener('click', onDocClick);
    offs.push(() => doc.removeEventListener('click', onDocClick));
  }

  /** where the person is: top level (the bar shows) or one level down (back arrow and title replace it) */
  function where() {
    const s = ops.settings();
    if (s && s.open) {
      if (s.page === 'global' || !s.parent) return { top: true };
      return { top: false, label: 'Back to ' + s.parent.title, title: s.title, go: () => ops.settingsUp() };
    }
    if (ops.active() === 'workrooms' && shown) return { top: false, label: 'Back to Rooms', title: shown.roomName || 'Room', go: () => ops.backToRooms() };
    return { top: true };
  }

  function render() {
    const active = ops.active();
    for (const [id, { item }] of items) {
      const on = id === active;
      item.className = on ? 'wb-bni is-active' : 'wb-bni';
      item.setAttribute('aria-current', on ? 'page' : 'false');
    }
    const on = active === 'settings';
    settingsTab.className = on ? 'hwb-apptab is-active' : 'hwb-apptab';
    settingsTab.setAttribute('aria-current', on ? 'page' : 'false');
    const w = where();
    root.dataset.wbNav = w.top ? 'top' : 'sub';
    const settingsOpen = !!(ops.settings() && ops.settings().open);
    root.dataset.wbSettings = settingsOpen ? 'open' : 'closed';
    // the Settings panel is modal to the PAGE, not to the bars: the content behind it is inert (no Tab, no click) while the top
    // bar and the bottom bar stay operable; focus moves into the panel when it opens and comes back to Settings when it closes
    main.inert = settingsOpen;
    if (settingsOpen && !wasOpen && typeof ops.focusSettings === 'function') ops.focusSettings();
    if (!settingsOpen && wasOpen) {
      const a = doc.activeElement;
      // focus is lost when it is nowhere, or still on something INSIDE the panel that was just hidden (the browser blurs it lazily)
      if (!a || a === doc.body || (typeof ops.inPanel === 'function' && ops.inPanel(a))) {
        const target = settingsTab.offsetParent !== null ? settingsTab : items.get('settings').item;
        target.focus();
      }
    }
    wasOpen = settingsOpen;
    back.hidden = w.top;
    title.hidden = w.top;
    if (!w.top) {
      back.setAttribute('aria-label', w.label);
      title.textContent = w.title;
    }
  }
  // the back button's action changes with where you are; ONE listener asks where() at click time
  back.addEventListener('click', () => { const w = where(); if (!w.top) w.go(); });

  function paintBadge(info) {
    const text = badgeText(info && info.count);
    const entry = items.get('workrooms');
    entry.badge.textContent = text;
    entry.badge.hidden = text === '';
    entry.item.setAttribute('aria-label', text ? `${entry.label}, ${text} waiting` : entry.label);
  }

  // ---- inputs
  if (web && web.events) {
    offs.push(web.events.on('room-shown', (p) => { shown = p || null; render(); }));
    offs.push(web.events.on('rooms-waiting', paintBadge));
  }
  offs.push(wb.on('rooms:status', (status) => { if (status && status.me !== undefined) { me = status.me; paintAccount(); } }));
  const ready = Promise.resolve()
    .then(() => wb.rooms.status())
    .then((status) => { if (status && status.me !== undefined) me = status.me; })
    .catch(() => {})
    .then(paintAccount);
  paintAccount();
  paintBadge(null);
  render();

  function destroy() {
    for (const off of offs.splice(0)) { try { if (typeof off === 'function') off(); } catch (e) { /* gone */ } }
    for (const node of made.splice(0)) node.remove();
  }

  return { render, ready, destroy };
}
