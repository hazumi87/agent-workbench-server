// The rail: the left column listing CLIs (the design notes piece 5; the design's step-2 design).
// Mode A: titled "CLIs", groups In this window · Window N · Hidden (empty groups not drawn). A flag on
// the left edge (mirror of the Concierge handle) shows the count of all CLIs and a red dot while any
// CLI needs you; Ctrl+Shift+L toggles. The rail opens OVER the grid (terminals never resize); the pin
// docks it, which pushes the grid once and keeps it open across restarts.
// Rows show only what the Workbench knows: ring + program mark, the name in the CLI's color,
// "This machine · <start folder>" (from launch, never read from the terminal), and a status word only
// for Hidden or Needs you. Hover/focus shows Show/Hide and ⋯ (Rename, Color, End…).

import { hwbRing, hwbRingFromChrome } from '../vendor/aurora/window-chrome/hwb-ring.js';
import * as m3 from './m3.js';
import { icon } from './m3-chrome.js';
import { markSvg } from './settings-pages.js';
import { PIN_FROM, SLIM_UNDER, isUnpinned, setUnpinned, isCollapsed, toggleCollapsed, groupLabel } from './srail.js';
import { causeWords } from './route-overlay.js';

// 0.19.0 (B1–B3, the design's "One rail for the Workbench"): this rail is the shared rail's reference. It
// starts pinned (the owner ); unpinning is remembered for this window's Terminals tab; under 700 px it
// floats from the flag ("Not enough room to pin"). Groups carry an icon on a color band, a caret that
// folds them, and IN THIS WINDOW owns the "+" (Shell, recipes, Custom command…, On a server…).
const TAB = 'terminals';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) {
    e.className = cls;
  }
  if (text != null) {
    e.textContent = text;
  }
  return e;
};

// deps: { host, flagHost, brand, markPath, seedOf(hue), displayName(s), myWid(), activeSid(), hues,
//         act(sid), showHide(sid), rename(sid, name), color(sid, hue), end(sid), newCli(),
//         pinChanged(), focusPane(), windowLabel(wid),
//         openServer(id), testServer(id), signInAgain(), requestAccess(), cancelRequest(reqId),
//         clearRequest(reqId), why(view) }   (the last seven: mode B's servers, 3b)
//
// Mode B (signed in, 3b, the design <commit>): a SERVERS area with one row per server · login. A row is a
// place: clicking it opens a shell there. The status line has the dot and words of the design's table;
// Keeps running is an icon only. Hover/focus shows Open a shell and ⋯ (Test).
//
// Step 3c (the design's step-3c page): once signed in the rail is titled CLIs and Recipes
// and a RECIPES area sits between the window groups and SERVERS: the program's mark, the name in the
// recipe's color, "server · your account" under it; Open / "2 open" on the right when its CLI runs; hover
// shows Start (or Go to it) and ⋯ (Start another · Edit… · Duplicate · Delete…); the header's + opens
// the form. Mode A has no RECIPES header at all. deps adds: startRecipe(id), startAnother(id),
// goTo(sid), newRecipe(), editRecipe(id), duplicateRecipe(id), deleteRecipe(id), fixRecipe(id, what),
// turnOnProgram(programId).
/** "just now" / "2 min ago" / "3 h ago": the rail's finished-row time. */
function agoWord(t) {
  const s = Math.max(0, Math.round((Date.now() - (Number(t) || 0)) / 1000));
  if (s < 60) {
    return 'just now';
  }
  const m = Math.round(s / 60);
  if (m < 60) {
    return m + ' min ago';
  }
  const h = Math.round(m / 60);
  return h < 24 ? h + ' h ago' : Math.round(h / 24) + ' d ago';
}

export function createRail(deps) {
  let open = false;
  let pinned = !isUnpinned(TAB); // the pin: a Terminals setting, per window
  let allowPin = true; // 0.12.5 (the owner , PM ): on Console and module tabs the rail floats
  let flagOwner = null; // W1 (PM ): on Workrooms the left flag opens the room's rail, not this one
  const canPin = () => window.innerWidth >= PIN_FROM;
  const docked = () => pinned && allowPin && canPin();
  let list = [];
  let servers = null; // mode B's server area (null in mode A)
  let recipes = null; // the recipes' view rows from the renderer (both modes since 0.12.1, )
  let unsaved = null; // "1 recipe not saved · Finish" (the design's No dead ends): { label, link, fn } or null
  // step 3d (the design's 3d page, "Rail groups"): one group per server · login where something of this
  // person's keeps running on the broker and isn't open here: { key, title, count, atLimit, line,
  // dim, warn, rows: [{ key, serverId, bsid, name, hue, line, ended }] } from the renderer
  let bgroups = [];
  let focusSid = null;
  let menu = null; // { sid, el }
  let newMenu = null; // the IN THIS WINDOW + menu: { el, sub, anchor }
  // step 4 (the design's workbench-step4-restore): the offer after an interruption heads the rail; stopped
  // conversations keep their rows with their own Restore; "Recently closed" closes the rail
  let offer = null; // { id, at, cause, server, count, shells, rows, restoring?: { done, of } }
  let recentCount = 0;
  let renaming = null; // sid
  let renameDraft = null; // { sid, value, start, end, focused }: the open editor's text across a re-render

  const rail = el('aside', 'rail sr');
  rail.id = 'rail';
  rail.setAttribute('aria-label', 'CLIs');
  rail.hidden = true;
  const head = el('div', 'rail-h sr-h');
  const title = el('div', 'rail-t sr-t', 'CLIs');
  const pinB = el('button', 'rail-ib rail-pin sr-hb sr-pin');
  pinB.dataset.ra = 'pin';
  const closeB = el('button', 'rail-ib rail-close sr-hb');
  closeB.dataset.ra = 'close';
  closeB.title = 'Close';
  closeB.setAttribute('aria-label', 'Close the list');
  closeB.innerHTML = icon('close');
  head.append(title, pinB, closeB);
  const body = el('div', 'rail-b');
  body.setAttribute('role', 'listbox');
  body.setAttribute('aria-label', 'CLIs');
  rail.append(head, body); // 0.19.0 (the owner ): no New CLI button at the foot; IN THIS WINDOW + has it
  deps.host.appendChild(rail);

  const flag = el('button', 'rail-flag');
  flag.id = 'railFlag';
  flag.title = 'CLIs (Ctrl+Shift+L)';
  flag.setAttribute('aria-label', 'CLIs (Ctrl+Shift+L)');
  flag.setAttribute('aria-expanded', 'false');
  deps.flagHost.appendChild(flag);

  function persistPin() {
    setUnpinned(TAB, !pinned);
  }

  function paintHead() {
    // "CLIs and Recipes (signed in) · CLIs (mode A)"
    title.textContent = recipes ? 'CLIs and Recipes' : 'CLIs';
    rail.setAttribute('aria-label', title.textContent);
    title.title = title.textContent;
    const on = docked();
    pinB.innerHTML = icon('keep', on ? 'fill' : '');
    pinB.title = on ? 'Unpin' : canPin() ? 'Pin' : 'Not enough room to pin';
    pinB.setAttribute('aria-label', pinB.title);
    pinB.setAttribute('aria-pressed', String(on));
    pinB.classList.toggle('on', on);
    pinB.disabled = !on && !canPin();
    pinB.hidden = !allowPin;
    closeB.hidden = on;
    rail.classList.toggle('slim', window.innerWidth < SLIM_UNDER);
  }

  function paintFlag() {
    flag.textContent = '';
    if (flagOwner) {
      flag.innerHTML = icon('forum');
      flag.appendChild(el('span', 'n', String(flagOwner.count || 0)));
      if (flagOwner.dot) {
        const dot = el('span', 'dot');
        dot.setAttribute('aria-hidden', 'true');
        flag.appendChild(dot);
      }
      flag.title = 'Room (Ctrl+Shift+L)';
      flag.setAttribute('aria-label', 'Room (Ctrl+Shift+L)');
      flag.hidden = !!flagOwner.hidden;
      flag.setAttribute('aria-expanded', 'false');
      return;
    }
    flag.title = 'CLIs (Ctrl+Shift+L)';
    flag.innerHTML = icon('view_list');
    flag.appendChild(el('span', 'n', String(list.length)));
    if (list.some((s) => s.needsYou === 'alarm') || (offer && offer.count)) { // step 4: an offer waits
      const dot = el('span', 'dot');
      dot.setAttribute('aria-hidden', 'true');
      flag.appendChild(dot);
      flag.setAttribute('aria-label', 'CLIs (Ctrl+Shift+L), one needs you');
    } else {
      flag.setAttribute('aria-label', 'CLIs (Ctrl+Shift+L)');
    }
    flag.hidden = docked();
    flag.setAttribute('aria-expanded', String(open || docked()));
  }

  function groups() {
    const me = deps.myWid();
    const out = [];
    // IN THIS WINDOW is always drawn: it owns the + (0.19.0, the owner )
    out.push({ key: 'here', label: 'In this window', icon: 'terminal', rows: list.filter((s) => s.wid === me) });
    const others = [...new Set(list.filter((s) => s.wid != null && s.wid !== me).map((s) => s.wid))].sort((a, b) => a - b);
    for (const wid of others) {
      out.push({ key: 'w' + wid, label: deps.windowLabel(wid), icon: 'web_asset', rows: list.filter((s) => s.wid === wid) });
    }
    const hidden = list.filter((s) => s.wid == null);
    if (hidden.length) {
      out.push({ key: 'hidden', label: 'Hidden', icon: 'visibility_off', color: 'var(--md-sys-color-outline)', rows: hidden });
    }
    return out;
  }

  // A group label of the shared rail; a folded group draws no rows (its caret brings them back).
  function label(key, text, ic, color, o = {}) {
    const collapsed = isCollapsed(TAB, key);
    const g = groupLabel({
      key,
      icon: ic,
      label: text,
      color,
      collapsed,
      add: o.add || null,
      extra: o.extra || null,
      onToggle: () => {
        toggleCollapsed(TAB, key);
        closeMenu();
        closeNewMenu();
        render();
        const again = body.querySelector('.sr-g[data-grp="' + key + '"] .sr-caret');
        if (again) {
          again.focus();
        }
      },
    });
    if (o.cls) {
      g.classList.add(...o.cls.split(' '));
    }
    body.appendChild(g);
    return !collapsed;
  }

  // "3 Claude conversations stopped when server restarted." · "Today, 2:14 PM · 1 shell ended too" ·
  // [Choose…] [Restore all]; one conversation: "site stopped when server restarted." [Restore]; while restoring,
  // "Restoring 2 of 3…"; ✕ is "Not now" (to Recently closed)
  function offerCard(o) {
    const card = el('div', 'rail-offer');
    card.setAttribute('role', 'region');
    card.setAttribute('aria-label', 'Stopped conversations');
    const head = el('div', 'ro-h');
    head.insertAdjacentHTML('beforeend', icon('history'));
    const tx = el('div', 'ro-tx');
    const where = o.server === 'This machine' ? 'this computer' : o.server;
    const c = causeWords(o.cause, where);
    const one = o.count === 1 && o.rows[0];
    const what = one ? one.name : o.count + ' Claude conversation' + (o.count === 1 ? '' : 's');
    tx.appendChild(el('b', null, o.restoring ? 'Restoring ' + Math.min(o.restoring.done + 1, o.restoring.of) + ' of ' + o.restoring.of + '…' : what + ' stopped' + (c.long ? ' ' + c.long : '') + '.'));
    const d = new Date(o.at || Date.now());
    const day = new Date().toDateString() === d.toDateString() ? 'Today' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const shells = o.shells ? ' · ' + o.shells + (o.shells === 1 ? ' shell' : ' shells') + ' ended too' : '';
    tx.appendChild(el('small', null, day + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + shells));
    head.appendChild(tx);
    const x = el('button', 'rail-ib ro-x');
    x.type = 'button';
    x.dataset.oa = 'dismiss';
    x.title = 'Not now';
    x.setAttribute('aria-label', 'Not now');
    x.innerHTML = icon('close');
    head.appendChild(x);
    card.appendChild(head);
    if (!o.restoring) {
      const acts = el('div', 'ro-a');
      if (!one) {
        const ch = el('button', 'ro-btn text', 'Choose…');
        ch.type = 'button';
        ch.dataset.oa = 'choose';
        acts.appendChild(ch);
      }
      const all = el('button', 'ro-btn filled', one ? 'Restore' : 'Restore all');
      all.type = 'button';
      all.dataset.oa = 'all';
      acts.appendChild(all);
      card.appendChild(acts);
    }
    return card;
  }

  function ringState(s) {
    if (s.needsYou === 'alarm') {
      return 'waiting';
    }
    return s.flowing ? 'streaming' : 'idle';
  }

  function chip(parent, id, name, label) {
    if (!id || !deps.multipleAccounts?.()) return;
    const a = deps.accountCard?.(id);
    const c = el('span', 'account-chip', name || a?.realmName || 'Account');
    c.title = label || a?.label || '';
    parent.appendChild(c);
  }
  function row(s) {
    const r = el('div', 'rr sr-r');
    r.dataset.sid = s.sid;
    r.tabIndex = -1;
    r.setAttribute('role', 'option');
    const hidden = s.wid == null;
    if (hidden) {
      r.classList.add('hid');
    }
    if (s.wid === deps.myWid() && s.sid === deps.activeSid()) {
      r.classList.add('sel');
      r.setAttribute('aria-selected', 'true');
    }
    const seed = deps.seedOf(s.hue);
    m3.applyTo(r, seed);
    const ring = el('span', 'rr-ring');
    hwbRing(ring, hwbRingFromChrome(ringState(s), { attached: true }), 36, { brand: deps.brand, markPath: deps.markPath });
    const tx = el('div', 'tx');
    if (renaming === s.sid) {
      // A re-render while the name is being typed (a session broadcast from main lands at any time)
      // keeps what was typed, the caret and the focus: the draft is carried over from the old editor.
      const inp = el('input', 'rr-rename');
      const d = renameDraft && renameDraft.sid === s.sid ? renameDraft : null;
      inp.value = d ? d.value : s.name || '';
      inp.maxLength = 60;
      inp.spellcheck = false;
      inp.setAttribute('aria-label', 'Name');
      tx.appendChild(inp);
      if (d) {
        inp.setSelectionRange(d.start, d.end); // now, not in a frame callback: a hidden window may never run one
      }
      requestAnimationFrame(() => {
        if (d) {
          if (d.focused) {
            inp.focus(); // never takes the keyboard from wherever it went
            inp.setSelectionRange(d.start, d.end);
          }
          return;
        }
        inp.focus();
        inp.select();
      });
    } else {
      const name = el('div', 'n1', deps.displayName(s));
      chip(name, s.accountId, s.realmName, s.accountLabel);
      tx.appendChild(name);
    }
    // "Brokered · your account · ~/site": where it runs, as whom, and its start folder
    // B6: the state chip starts the second line, so the full name always shows on the first
    const n2 = el('div', 'n2');
    if (s.needsYou === 'alarm') {
      n2.appendChild(el('span', 'sr-chip err need', 'Needs you'));
    }
    if (s.stopped) {
      // step 4: "Stopped · server restarted", dimmed, with its own Restore always on the row
      r.classList.add('stopped');
      const c = causeWords(s.stopped.cause, s.place === 'This machine' ? 'this computer' : s.place);
      // the design : the line reads just "Stopped" beside [Restore]; the cause is the tooltip and the pane's card
      n2.appendChild(document.createTextNode('Stopped'));
      n2.title = 'Stopped' + (c.long ? ' ' + c.long : '');
    } else {
      n2.appendChild(document.createTextNode([s.place || 'This machine', s.login || '', s.folder || '~'].filter(Boolean).join(' · ')));
    }
    tx.appendChild(n2);
    r.append(ring, tx);
    if (s.needsYou === 'alarm') {
      // the chip on line 2 says it
    } else if (hidden) {
      r.appendChild(el('span', 'w', 'Hidden'));
    } else if (s.launchWord) {
      // a recipe's CLI that did not start (3c, the design's launch table: "Not found on server"); a finished or
      // stopped custom command reads "Finished · 2 min ago"
      r.appendChild(el('span', 'w' + (s.launchDone ? (s.launchWord === 'Stopped' ? ' amber' : '') : ' amber'), s.launchDone ? s.launchWord + ' · ' + agoWord(s.launchAt) : s.launchWord));
    }
    if (s.keepsRunning) {
      // 3d: the Keeps running icon with the one honest sentence (the design's 3d page)
      const k = el('span', 'kr');
      k.innerHTML = icon('all_inclusive');
      k.title = 'Stays on ' + (s.place || 'the server') + ' when you close the Workbench. Ends if ' + (s.place || 'it') + ' or its broker restarts.';
      k.setAttribute('aria-label', 'Keeps running');
      r.appendChild(k);
    }
    if (s.stopped) {
      const rb = el('button', 'rail-restore', 'Restore');
      rb.type = 'button';
      rb.dataset.ra = 'restore';
      rb.tabIndex = -1;
      rb.title = 'Restore this conversation';
      r.appendChild(rb);
    }
    const acts = el('div', 'acts');
    const sh = el('button', 'rail-ib');
    sh.dataset.ra = s.launchDone ? 'closedone' : 'showhide';
    sh.tabIndex = -1;
    sh.title = s.launchDone ? 'Close' : hidden ? 'Show' : 'Hide · keeps running';
    sh.setAttribute('aria-label', sh.title);
    sh.innerHTML = icon(s.launchDone ? 'close' : hidden ? 'visibility' : 'visibility_off');
    const more = el('button', 'rail-ib');
    more.dataset.ra = 'more';
    more.tabIndex = -1;
    more.title = 'More';
    more.setAttribute('aria-label', 'More for ' + deps.displayName(s));
    more.setAttribute('aria-haspopup', 'menu');
    more.innerHTML = icon('more_vert');
    // a stopped row (the design's step-4 table): its name, "Stopped · cause" and Restore; ⋯ on hover, no Hide
    // (nothing runs to hide), so the name keeps the width
    if (s.stopped) {
      acts.append(more);
    } else {
      acts.append(sh, more);
    }
    r.appendChild(acts);
    r.setAttribute('aria-label', deps.displayName(s) + ', ' + (s.place || 'This machine') + (s.needsYou === 'alarm' ? ', needs you' : hidden ? ', hidden' : ''));
    return r;
  }

  function render() {
    paintHead();
    paintFlag();
    const keepFocus = rail.contains(document.activeElement) ? focusSid : null;
    const editor = renaming != null ? body.querySelector('.rr-rename') : null;
    renameDraft = editor ? { sid: renaming, value: editor.value, start: editor.selectionStart, end: editor.selectionEnd, focused: document.activeElement === editor } : null;
    body.textContent = '';
    if (offer && offer.count) {
      body.appendChild(offerCard(offer));
    }
    for (const g of groups()) {
      const add = g.key === 'here' ? { title: 'New CLI', menu: true, dataset: { ra: 'newmenu' } } : null;
      if (!label(g.key, g.label, g.icon, g.color || 'var(--md-sys-color-primary)', { add, cls: 'grp' })) {
        continue;
      }
      for (const s of g.rows) {
        body.appendChild(row(s));
      }
      if (g.key === 'here' && !g.rows.length) {
        body.appendChild(el('div', 'rail-empty', list.length || bgroups.length ? 'None in this window.' : 'No CLIs yet. Start one with +.'));
      }
    }
    // 3d: the groups of CLIs that keep running on a broker and aren't open here
    for (const g of bgroups) {
      const cnt = g.count ? el('span', 'cnt' + (g.atLimit ? ' limit' : ''), g.count) : null;
      if (!label(g.key, g.title, 'all_inclusive', g.dim ? 'var(--md-sys-color-outline)' : 'var(--md-sys-color-secondary)', { extra: cnt, cls: 'grp bgrp' + (g.dim ? ' dim' : '') })) {
        continue;
      }
      if (g.line) {
        const ln = el('div', 'bline' + (g.warn ? ' warn' : ''));
        if (g.warn || g.dim) {
          ln.appendChild(el('span', 'dot ' + (g.warn ? 'warn' : 'wait')));
        }
        ln.appendChild(el('span', null, g.line));
        body.appendChild(ln);
      }
      for (const v of g.rows) {
        body.appendChild(brokerRow(v, g));
      }
    }
    // Signed in (mode B): RECIPES above SERVERS ("a recipe is the everyday way in; a server row is a
    // plain shell"). The header stays with the empty line and the button: never an empty list with no words.
    if (recipes && label('recipes', 'Recipes', 'menu_book', 'var(--md-sys-color-tertiary)', { add: { title: 'New recipe', dataset: { sa: 'new-recipe' } }, cls: 'grp with-add' })) {
      if (unsaved) {
        const u = el('div', 'rail-rcp-unsaved');
        u.appendChild(el('span', null, unsaved.label + ' · '));
        const fin = el('button', 'slink', unsaved.link);
        fin.dataset.sa = 'finish';
        u.appendChild(fin);
        body.appendChild(u);
      }
      for (const v of recipes) {
        body.appendChild(recipeRow(v));
      }
      if (!recipes.length) {
        const e = el('div', 'rail-rcp-empty');
        e.appendChild(el('div', 'ln', 'Recipes start a program in a folder with one click.'));
        const b = el('button', 'ac-btn tonal rcp-new');
        b.dataset.sa = 'new-recipe';
        b.innerHTML = icon('add');
        b.appendChild(el('span', null, 'New recipe'));
        e.appendChild(b);
        body.appendChild(e);
      }
    }
    // Signed in (mode B): the server area, one row per granted server · login (3b).
    if (servers && label('servers', 'Servers', 'dns', '#2E7D32', { cls: 'grp' })) {
      for (const v of servers) {
        body.appendChild(serverRow(v));
      }
      if (!servers.length) {
        body.appendChild(el('div', 'rail-srv-empty', 'No servers yet.'));
      }
      // F7: the area ends with Request access… (also under the empty state, the design's state 9)
      const rq = el('button', 'reqlink');
      rq.dataset.sa = 'request';
      rq.innerHTML = icon('add');
      rq.appendChild(document.createTextNode('Request access…'));
      body.appendChild(rq);
    }
    if (recentCount) {
      const rc = el('button', 'reqlink rail-recent');
      rc.dataset.sa = 'recent';
      rc.innerHTML = icon('history');
      rc.appendChild(document.createTextNode('Recently closed'));
      body.appendChild(rc);
    }
    if (!list.length && !bgroups.length) {
      return;
    }
    if (menu) {
      // a re-render (a rename or color landing from main) keeps the open menu, of the same kind
      const keepFocus = menu.el.contains(document.activeElement);
      if (menu.colors) {
        openColors(menu.sid, keepFocus);
      } else if (menu.grp) {
        openBrokerMenu(menu.grp, keepFocus);
      } else if (menu.rcp) {
        openRecipeMenu(menu.rcp, keepFocus); // a recipe's ⋯ survives the CLI list changing under it
      } else if (menu.srv) {
        openServerMenu(menu.srv);
      } else {
        openMenu(menu.sid, keepFocus);
      }
    }
    if (keepFocus != null && renaming == null && !menu) {
      focusRow(keepFocus);
    }
  }

  function rows() {
    return [...body.querySelectorAll('.rr')];
  }

  // One server · login. Its words come from the Accounts module (the design's 3b table), never from a pane.
  /** v: { id, name, hue, mark, markColor, where, tip, open, goSid, state, word, amber, link, linkAction,
   *       canStart, startTip } (the renderer resolves program, server and sessions into this). */
  function recipeRow(v) {
    const r = el('div', 'rcp sr-r' + (v.dim ? ' dim' : ''));
    r.dataset.rcp = v.id;
    r.dataset.state = v.state || 'ok';
    r.tabIndex = 0;
    r.setAttribute('role', 'option');
    r.setAttribute('aria-label', v.name + ', ' + (v.line || v.where) + (v.word ? ', ' + v.word : '') + (v.link ? ' · ' + v.link : ''));
    r.title = v.tip || '';
    const ic = el('span', 'sic sr-ic');
    ic.appendChild(markSvg(v.mark || 'generic', v.markColor || '#5F6368'));
    const tx = el('div', 'tx');
    const n1 = el('div', 'n1', v.name);
    chip(n1, v.accountId, v.realmName, v.accountLabel);
    if (v.hue != null) {
      r.style.setProperty('--c', m3.palette(deps.seedOf(v.hue)).primary); // the name in the recipe's color
    }
    const n2 = el('div', 'n2');
    if (v.line) {
      // page b1: the dot, the word and its link (Fix…, Turn on, Request access…) in place of where it runs
      if (v.lock) {
        n2.insertAdjacentHTML('beforeend', icon('lock', 'lk')); // 3e: the recipe policy's lock
      } else if (v.dot) {
        n2.appendChild(el('span', 'dot ' + v.dot));
      }
      n2.appendChild(document.createTextNode(v.line + (v.link ? ' · ' : '')));
      if (v.link) {
        const a = el('button', 'slink', v.link);
        a.type = 'button';
        a.dataset.sa = v.linkAction || 'fix';
        n2.appendChild(a);
      }
    } else {
      n2.textContent = v.where;
    }
    tx.append(n1, n2);
    r.append(ic, tx);
    if (v.word) {
      r.appendChild(el('span', 'w', v.word)); // "Open" / "2 open"
    }
    const acts = el('div', 'acts');
    const go = el('button', 'rail-ib');
    if (v.open > 0) {
      go.dataset.sa = 'goto';
      go.title = 'Go to it';
      go.setAttribute('aria-label', 'Go to ' + v.name);
      go.innerHTML = icon('arrow_forward');
    } else {
      go.dataset.sa = 'start';
      go.title = v.canStart ? 'Start' : v.startTip || 'Start';
      go.setAttribute('aria-label', 'Start ' + v.name);
      go.innerHTML = icon('play_arrow');
      if (v.state === 'server-unavailable') {
        go.setAttribute('aria-disabled', 'true'); go.setAttribute('aria-label', v.startTip);
      } else go.disabled = !v.canStart;
    }
    const moreB = el('button', 'rail-ib');
    moreB.dataset.sa = 'more';
    moreB.title = 'More';
    moreB.setAttribute('aria-label', 'More for ' + v.name);
    moreB.innerHTML = icon('more_vert');
    acts.append(go, moreB);
    r.appendChild(acts);
    return r;
  }

  /** A CLI that keeps running on a broker and isn't open here (3d): mark · name · "~/api · started on
   *  LAPTOP" · [Open]; ⋯: Open · End…. An ended one: "Ended · 3 min ago" · ✕ (it leaves the broker's
   *  list by itself after its retention window). */
  function brokerRow(v, g) {
    const r = el('div', 'brow sr-r' + (v.ended ? ' ended' : '') + (g.dim ? ' dim' : ''));
    r.dataset.brow = v.key;
    r.tabIndex = 0;
    r.setAttribute('role', 'option');
    r.setAttribute('aria-label', v.name + ', ' + v.line + (v.ended ? '' : ', keeps running on ' + g.title));
    const seed = deps.seedOf(v.hue);
    m3.applyTo(r, seed);
    const ring = el('span', 'rr-ring');
    hwbRing(ring, hwbRingFromChrome(v.ended ? 'idle' : 'idle', { attached: false }), 36, { brand: deps.brand, markPath: deps.markPath });
    const tx = el('div', 'tx');
    tx.appendChild(el('div', 'n1', v.name));
    tx.appendChild(el('div', 'n2', v.line));
    r.append(ring, tx);
    const acts = el('div', 'acts');
    if (v.ended) {
      const x = el('button', 'rail-ib');
      x.dataset.ba = 'dismiss';
      x.tabIndex = -1;
      x.title = 'Clear';
      x.setAttribute('aria-label', 'Clear ' + v.name);
      x.innerHTML = icon('close');
      acts.appendChild(x);
    } else {
      const openB = el('button', 'ac-btn tonal brow-open');
      openB.dataset.ba = 'open';
      openB.tabIndex = -1;
      openB.textContent = 'Open';
      openB.title = 'Open here (it keeps running on ' + g.title + ')';
      const more = el('button', 'rail-ib');
      more.dataset.ba = 'more';
      more.tabIndex = -1;
      more.title = 'More';
      more.setAttribute('aria-label', 'More for ' + v.name);
      more.setAttribute('aria-haspopup', 'menu');
      more.innerHTML = icon('more_vert');
      acts.append(openB, more);
    }
    r.appendChild(acts);
    return r;
  }

  function brokerView(key) {
    for (const g of bgroups) {
      const v = g.rows.find((x) => x.key === key);
      if (v) {
        return { v, g };
      }
    }
    return null;
  }

  function openBrokerMenu(key, focusFirst = true) {
    closeMenu();
    const r = body.querySelector('.brow[data-brow="' + key + '"]');
    const hit = brokerView(key);
    if (!r || !hit || hit.v.ended) {
      return;
    }
    const m = el('div', 'rail-menu');
    m.setAttribute('role', 'menu');
    const item = (act, ic, label, cls) => {
      const b = el('button', 'rm-i' + (cls ? ' ' + cls : ''));
      b.dataset.rm = act;
      b.setAttribute('role', 'menuitem');
      b.innerHTML = icon(ic);
      b.appendChild(document.createTextNode(label));
      m.appendChild(b);
      return b;
    };
    item('b-open', 'open_in_new', 'Open');
    item('b-end', 'cancel', 'End…', 'danger');
    rail.appendChild(m);
    placeMenu(m, r);
    r.classList.add('menu-open');
    menu = { grp: key, el: m };
    if (focusFirst) {
      ringTo(m.querySelector('button'));
    }
  }

  function actBroker(key, what) {
    const hit = brokerView(key);
    if (!hit) {
      return;
    }
    const { v } = hit;
    if (what === 'end') {
      deps.endBroker && deps.endBroker(v.serverId, v.bsid, v.name);
    } else if (what === 'dismiss') {
      deps.dismissEnded && deps.dismissEnded(v.serverId, v.bsid);
    } else if (what === 'more') {
      openBrokerMenu(key);
    } else if (!v.ended) {
      closeIfFloating();
      deps.openBroker && deps.openBroker(v.serverId, v.bsid, v);
    }
  }

  function openRecipeMenu(id, focusFirst = true) {
    closeMenu();
    const r = body.querySelector('.rcp[data-rcp="' + id + '"]');
    const v = (recipes || []).find((x) => x.id === id);
    if (!r || !v) {
      return;
    }
    const m = el('div', 'rail-menu');
    m.setAttribute('role', 'menu');
    const item = (act, ic, label, cls) => {
      const b = el('button', 'rm-i' + (cls ? ' ' + cls : ''));
      b.dataset.rm = act;
      b.setAttribute('role', 'menuitem');
      b.innerHTML = icon(ic);
      b.appendChild(document.createTextNode(label));
      m.appendChild(b);
      return b;
    };
    if (v.open > 0) {
      item('rcp-another', 'play_arrow', 'Start another');
    }
    item('rcp-edit', 'edit', 'Edit…');
    item('rcp-dup', 'content_copy', 'Duplicate');
    item('rcp-del', 'delete', 'Delete…', 'danger');
    rail.appendChild(m);
    placeMenu(m, r);
    menu = { rcp: id, el: m };
    if (focusFirst) {
      ringTo(m.querySelector('button'));
    }
  }

  /** A click on a recipe row: Go to it when one is open (the most recent), else Start. */
  function actRecipe(id) {
    const v = (recipes || []).find((x) => x.id === id);
    if (!v) {
      return;
    }
    if (v.state === 'server-unavailable') {
      deps.explainRecipe?.(v); return;
    }
    if (v.open > 0 && v.goSid != null) {
      deps.goTo(v.goSid);
      closeIfFloating();
    } else if (deps.startRecipe) {
      // a row whose broker is down still answers Enter: the renderer says why (the snackbar with Server page)
      deps.startRecipe(id);
      closeIfFloating();
    }
  }

  function serverRow(v) {
    const r = el('div', 'srow sr-r' + (v.dim ? ' dim' : ''));
    r.dataset.srv = v.id;
    r.dataset.state = v.state;
    if (v.reqId) {
      r.dataset.req = v.reqId;
    }
    r.tabIndex = 0;
    r.setAttribute('role', 'option');
    r.setAttribute('aria-label', v.title + ', ' + v.line + (v.link ? ' · ' + v.link : ''));
    if (v.tip) {
      r.title = v.tip;
    }
    const ic = el('span', 'sic sr-ic');
    ic.innerHTML = icon(v.icon || 'dns');
    const tx = el('div', 'tx');
    const st = el('div', 'dotw');
    if (v.dot) {
      st.appendChild(el('span', 'dot ' + v.dot));
    }
    st.appendChild(el('span', 'ln', v.line + (v.link || v.action ? ' · ' : '')));
    if (v.link) {
      const a = el('button', 'slink', v.link);
      a.dataset.sa = v.state === 'denied' ? 'why' : 'signin'; // Denied · Why? shows the admin's note
      st.appendChild(a);
    } else if (v.action) {
      // 5a: the keys fallback's one action on the row (Connect with a password, Make a new key)
      const a = el('button', 'slink', v.action.label);
      a.dataset.sa = 'keyact';
      st.appendChild(a);
    }
    if (v.keepsRunning) {
      const k = el('span', 'kr');
      k.innerHTML = icon('all_inclusive');
      k.title = 'Keeps running';
      st.appendChild(k);
    }
    const name = el('div', 'n1', v.title);
    chip(name, v.accountId, v.realmName, v.accountLabel);
    tx.append(name, st);
    const acts = el('div', 'acts');
    const moreB = el('button', 'rail-ib');
    moreB.dataset.sa = 'more';
    moreB.title = 'More';
    moreB.setAttribute('aria-label', 'More for ' + v.title);
    moreB.innerHTML = icon('more_vert');
    if (v.clearable) {
      // a denied request: ✕ clears it (the design's state 8)
      const x = el('button', 'rail-ib');
      x.dataset.sa = 'clear';
      x.title = 'Clear';
      x.setAttribute('aria-label', 'Clear ' + v.title);
      x.innerHTML = icon('close');
      acts.appendChild(x);
    } else if (v.request) {
      acts.appendChild(moreB); // a pending request: ⋯ has Cancel request (state 7)
    } else {
      const openB = el('button', 'rail-ib');
      openB.dataset.sa = 'open';
      openB.title = v.canOpen ? 'Open a shell' : v.tip || 'Open a shell';
      openB.setAttribute('aria-label', 'Open a shell');
      openB.innerHTML = icon('terminal');
      openB.disabled = !v.canOpen;
      acts.append(openB, moreB);
    }
    r.append(ic, tx, acts);
    return r;
  }

  function openServer(id) {
    const v = (servers || []).find((x) => x.id === id);
    if (v && v.canOpen && deps.openServer) {
      deps.openServer(id);
      closeIfFloating();
    }
  }

  function openServerMenu(id) {
    closeMenu();
    const r = body.querySelector('.srow[data-srv="' + id + '"]');
    if (!r) {
      return;
    }
    const m = el('div', 'rail-menu');
    m.setAttribute('role', 'menu');
    const b = el('button', 'rm-i');
    b.setAttribute('role', 'menuitem');
    if (r.dataset.req) {
      b.dataset.rm = 'cancel-req';
      b.innerHTML = icon('cancel');
      b.appendChild(document.createTextNode('Cancel request'));
    } else {
      b.dataset.rm = 'test';
      b.innerHTML = icon('network_check');
      b.appendChild(document.createTextNode('Test'));
      const pg = el('button', 'rm-i');
      pg.setAttribute('role', 'menuitem');
      pg.dataset.rm = 'page';
      pg.innerHTML = icon('dns');
      pg.appendChild(document.createTextNode('Server page…'));
      m.append(b, pg);
    }
    if (!m.contains(b)) {
      m.appendChild(b);
    }
    rail.appendChild(m);
    const more = r.querySelector('[data-sa=more]') || r;
    r.classList.add('menu-open');
    const mb = more.getBoundingClientRect();
    const hb = rail.getBoundingClientRect();
    m.style.top = Math.round(mb.bottom - hb.top + 2) + 'px';
    m.style.right = Math.max(8, Math.round(hb.right - mb.right)) + 'px';
    menu = { srv: id, el: m };
    ringTo(b);
  }

  // ---- IN THIS WINDOW + (0.19.0, the owner ; the design's menu table): one place for everything the old
  // New CLI did. Shell on this machine first; each recipe, which runs at once (one that can't run here
  // shows its reason and opens its fix); Custom command…; On a server… with the servers you can use.
  // It hangs from the + (or the empty page's [New CLI]) over the page, so it is not clipped by the rail.
  function closeNewMenu() {
    if (newMenu) {
      newMenu.el.remove();
      if (newMenu.sub) {
        newMenu.sub.remove();
      }
      newMenu.anchor.setAttribute('aria-expanded', 'false');
      newMenu = null;
    }
  }

  function nmItem(m, act, ic, label, hint, o = {}) {
    const b = el('button', 'rm-i nm-i' + (o.cls ? ' ' + o.cls : ''));
    b.type = 'button';
    b.dataset.nm = act;
    if (o.id != null) {
      b.dataset.id = o.id;
    }
    b.setAttribute('role', 'menuitem');
    b.disabled = !!o.disabled;
    if (o.sub) {
      b.setAttribute('aria-haspopup', 'menu');
    }
    if (o.icon) {
      b.appendChild(o.icon);
    } else {
      b.insertAdjacentHTML('beforeend', icon(ic));
    }
    b.appendChild(el('span', 'nm-l', label));
    if (hint) {
      b.appendChild(el('span', 'nm-h', hint));
    }
    if (o.sub) {
      b.insertAdjacentHTML('beforeend', icon('arrow_right', 'nm-more'));
    }
    m.appendChild(b);
    return b;
  }

  function openNewMenu(anchor) {
    closeMenu();
    if (newMenu && newMenu.anchor === anchor) {
      closeNewMenu();
      return;
    }
    closeNewMenu();
    const m = el('div', 'rail-menu nm-menu');
    m.setAttribute('role', 'menu');
    m.setAttribute('aria-label', 'New CLI');
    const web = !!(window.wb && window.wb.web); // the web build runs on a server: just "Shell", no machine words, no Servers door
    nmItem(m, 'shell', 'terminal', web ? 'Shell' : 'Shell on this machine', web ? '' : deps.shellLine ? deps.shellLine() : '');
    for (const v of recipes || []) {
      const mk = el('span', 'nm-mk');
      mk.appendChild(markSvg(v.mark || 'generic', v.markColor || '#5F6368'));
      const ok = v.canStart || v.open > 0;
      nmItem(m, 'recipe', null, v.name, ok ? v.where : v.line || v.startTip || v.where, { id: v.id, icon: mk, cls: ok ? '' : 'cant' });
    }
    m.appendChild(el('div', 'nm-div'));
    nmItem(m, 'custom', 'edit', 'Custom command…', '');
    if (!web) nmItem(m, 'server', 'dns', 'On a server…', '', { sub: true });
    document.body.appendChild(m);
    const b = anchor.getBoundingClientRect();
    const w = m.offsetWidth;
    m.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, Math.round(b.left))) + 'px';
    const h = m.offsetHeight;
    const top = b.bottom + 4 + h > window.innerHeight - 8 ? Math.max(8, b.top - 4 - h) : b.bottom + 4;
    m.style.top = Math.round(top) + 'px';
    anchor.setAttribute('aria-expanded', 'true');
    newMenu = { el: m, sub: null, anchor };
    ringTo(m.querySelector('button'));
  }

  function openServerSub(fromItem) {
    if (!newMenu) {
      return;
    }
    if (newMenu.sub) {
      newMenu.sub.remove();
    }
    const m = el('div', 'rail-menu nm-menu nm-sub');
    m.setAttribute('role', 'menu');
    m.setAttribute('aria-label', 'On a server');
    const usable = (servers || []).filter((v) => !v.request && !v.reqId);
    if (!usable.length) {
      nmItem(m, 'none', 'dns', 'No servers yet', '', { disabled: true });
    }
    for (const v of usable) {
      nmItem(m, 'srv', 'dns', v.title, v.canOpen ? '' : v.line, { id: v.id, disabled: !v.canOpen });
    }
    m.appendChild(el('div', 'nm-div'));
    nmItem(m, 'request', 'add', 'Request access…', '');
    document.body.appendChild(m);
    const b = fromItem.getBoundingClientRect();
    const w = m.offsetWidth;
    const right = b.right + 2 + w <= window.innerWidth - 8;
    m.style.left = Math.round(right ? b.right + 2 : Math.max(8, b.left - w - 2)) + 'px';
    m.style.top = Math.round(Math.max(8, Math.min(window.innerHeight - m.offsetHeight - 8, b.top - 6))) + 'px';
    newMenu.sub = m;
    ringTo(m.querySelector('button:not(:disabled)'));
  }

  function actNew(b) {
    const what = b.dataset.nm;
    if (what === 'server') {
      openServerSub(b);
      return;
    }
    const id = b.dataset.id;
    closeNewMenu();
    closeIfFloating();
    if (what === 'shell') {
      deps.newCli();
    } else if (what === 'recipe') {
      const v = (recipes || []).find((x) => x.id === id);
      if (v && v.open > 0 && !v.canStart && v.goSid != null) {
        deps.goTo(v.goSid);
      } else if (v && v.canStart) {
        deps.startRecipe(id);
      } else if (v && deps.fixRecipe) {
        deps.fixRecipe(id, v.state); // "Not found on this computer" opens its fix
      }
    } else if (what === 'custom') {
      deps.customCommand ? deps.customCommand() : deps.newRecipe && deps.newRecipe();
    } else if (what === 'srv') {
      deps.openServer && deps.openServer(id);
    } else if (what === 'request') {
      deps.requestAccess && deps.requestAccess();
    }
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.nm-i');
    if (b && newMenu && (newMenu.el.contains(b) || (newMenu.sub && newMenu.sub.contains(b)))) {
      actNew(b);
    }
  });
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (newMenu && !newMenu.el.contains(e.target) && !(newMenu.sub && newMenu.sub.contains(e.target)) && !newMenu.anchor.contains(e.target)) {
        closeNewMenu();
      }
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (!newMenu) {
        return;
      }
      const inSub = newMenu.sub && newMenu.sub.contains(document.activeElement);
      const host = inSub ? newMenu.sub : newMenu.el;
      const items = [...host.querySelectorAll('button:not(:disabled)')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
        ringTo(items[(i + 1) % items.length]);
      } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
        ringTo(items[(i - 1 + items.length) % items.length]);
      } else if (e.key === 'ArrowRight' && !inSub && document.activeElement && document.activeElement.dataset.nm === 'server') {
        openServerSub(document.activeElement);
      } else if ((e.key === 'ArrowLeft' || e.key === 'Escape') && inSub) {
        newMenu.sub.remove();
        newMenu.sub = null;
        ringTo(newMenu.el.querySelector('[data-nm=server]'));
      } else if (e.key === 'Escape') {
        const a = newMenu.anchor;
        closeNewMenu();
        a.focus();
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );

  function focusRow(sid) {
    const r = body.querySelector('.rr[data-sid="' + sid + '"]') || rows()[0];
    if (!r) {
      const add = body.querySelector('[data-ra=newmenu]');
      if (add) {
        ringTo(add);
      }
      return;
    }
    focusSid = Number(r.dataset.sid);
    for (const x of rows()) {
      x.classList.toggle('foc', x === r);
    }
    ringTo(r);
  }

  function setOpen(v, { focus = true } = {}) {
    open = !!v;
    rail.hidden = !(open || docked());
    rail.classList.toggle('pinned', docked());
    document.documentElement.classList.toggle('rail-docked', docked());
    closeMenu();
    paintHead();
    paintFlag();
    if ((open || docked()) && focus) {
      render();
      focusRow(deps.activeSid());
    }
    if (deps.openChanged) {
      deps.openChanged(open || docked()); // 0.12.2: the Console tab's view yields to a floating rail
    }
  }

  function closeIfFloating() {
    if (!docked()) {
      setOpen(false, { focus: false });
    }
  }

  function closeMenu() {
    if (menu) {
      menu.el.remove();
      const r = menu.srv ? body.querySelector('.srow[data-srv="' + menu.srv + '"]') : menu.rcp ? body.querySelector('.rcp[data-rcp="' + menu.rcp + '"]') : body.querySelector('.rr[data-sid="' + menu.sid + '"]');
      if (r) {
        r.classList.remove('menu-open');
      }
      menu = null;
    }
  }

  // The menu hangs under the row's ⋯ (the design, step 2), and the row keeps its active look meanwhile.
  function placeMenu(m, r) {
    const more = r.querySelector('[data-ra=more]') || r;
    r.classList.add('menu-open');
    const mb = more.getBoundingClientRect();
    const hb = rail.getBoundingClientRect();
    m.style.top = Math.round(mb.bottom - hb.top + 2) + 'px';
    m.style.right = Math.max(8, Math.round(hb.right - mb.right)) + 'px';
  }

  function openMenu(sid, focusFirst = true) {
    closeMenu();
    const r = body.querySelector('.rr[data-sid="' + sid + '"]');
    if (!r) {
      return;
    }
    const m = el('div', 'rail-menu');
    m.setAttribute('role', 'menu');
    const item = (act, ic, label, cls) => {
      const b = el('button', 'rm-i' + (cls ? ' ' + cls : ''));
      b.dataset.rm = act;
      b.setAttribute('role', 'menuitem');
      b.innerHTML = icon(ic);
      b.appendChild(document.createTextNode(label));
      m.appendChild(b);
      return b;
    };
    item('rename', 'edit', 'Rename');
    item('color', 'palette', 'Color');
    item('end', 'cancel', 'End…', 'danger');
    rail.appendChild(m);
    placeMenu(m, r);
    menu = { sid, el: m };
    if (focusFirst) {
      ringTo(m.querySelector('button'));
    }
  }

  // The keyboard focus ring (3 px secondary, as in step 1), drawn by class so it always shows.
  function ringTo(b) {
    for (const x of rail.querySelectorAll('.kb-ring')) {
      x.classList.remove('kb-ring');
    }
    if (b) {
      b.classList.add('kb-ring');
      b.focus();
    }
  }

  function openColors(sid, focusFirst = true) {
    closeMenu();
    const r = body.querySelector('.rr[data-sid="' + sid + '"]');
    if (!r) {
      return;
    }
    const m = el('div', 'rail-menu rail-colors');
    m.setAttribute('role', 'menu');
    m.setAttribute('aria-label', 'Color');
    for (const h of deps.hues) {
      const b = el('button', 'rc-sw');
      b.dataset.hue = h;
      b.setAttribute('role', 'menuitem');
      b.setAttribute('aria-label', 'Color ' + h);
      b.style.background = m3.palette(deps.seedOf(h)).primary;
      m.appendChild(b);
    }
    rail.appendChild(m);
    placeMenu(m, r);
    menu = { sid, el: m, colors: true };
    if (focusFirst) {
      ringTo(m.querySelector('button'));
    }
  }

  function act(sid) {
    deps.act(sid);
    closeIfFloating();
  }

  rail.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm && menu && menu.rcp) {
      const id = menu.rcp;
      const what = rm.dataset.rm;
      closeMenu();
      if (what === 'rcp-another' && deps.startAnother) {
        closeIfFloating();
        deps.startAnother(id);
      } else if (what === 'rcp-edit' && deps.editRecipe) {
        closeIfFloating();
        deps.editRecipe(id);
      } else if (what === 'rcp-dup' && deps.duplicateRecipe) {
        closeIfFloating();
        deps.duplicateRecipe(id);
      } else if (what === 'rcp-del' && deps.deleteRecipe) {
        deps.deleteRecipe(id);
      }
      return;
    }
    if (rm && menu && menu.grp) {
      const key = menu.grp;
      closeMenu();
      actBroker(key, rm.dataset.rm === 'b-end' ? 'end' : 'open');
      return;
    }
    const br = e.target.closest('.brow');
    if (br) {
      const ba = e.target.closest('[data-ba]');
      actBroker(br.dataset.brow, ba ? ba.dataset.ba : 'open');
      return;
    }
    // step 4: the offer card and Recently closed
    const oa = e.target.closest('[data-oa]');
    if (oa && offer) {
      const what = oa.dataset.oa;
      if (what === 'all') {
        deps.restoreOffer && deps.restoreOffer(offer.rows);
      } else if (what === 'choose') {
        deps.chooseOffer && deps.chooseOffer(offer);
      } else if (what === 'dismiss') {
        deps.dismissOffer && deps.dismissOffer();
      }
      return;
    }
    if (e.target.closest('[data-sa="recent"]')) {
      closeIfFloating();
      deps.openRecent && deps.openRecent();
      return;
    }
    if (e.target.closest('[data-sa="new-recipe"]')) {
      closeIfFloating();
      deps.newRecipe && deps.newRecipe();
      return;
    }
    if (e.target.closest('[data-sa="finish"]')) {
      closeIfFloating();
      unsaved && unsaved.fn();
      return;
    }
    const rc = e.target.closest('.rcp');
    if (rc) {
      const id = rc.dataset.rcp;
      const sa = e.target.closest('[data-sa]');
      const what = sa ? sa.dataset.sa : 'act';
      const v = (recipes || []).find((x) => x.id === id);
      if (what === 'more') {
        openRecipeMenu(id);
      } else if (what === 'start') {
        if (v?.state === 'server-unavailable') { deps.explainRecipe?.(v); return; }
        if (v && v.canStart && deps.startRecipe) {
          closeIfFloating();
          deps.startRecipe(id);
        }
      } else if (what === 'goto') {
        if (v && v.goSid != null) {
          closeIfFloating();
          deps.goTo(v.goSid);
        }
      } else if (what === 'fix') {
        closeIfFloating();
        deps.fixRecipe && deps.fixRecipe(id, v ? v.state : '');
      } else if (what === 'turn-on') {
        closeIfFloating();
        deps.turnOnProgram && v && deps.turnOnProgram(v.programId);
      } else if (what === 'request') {
        closeIfFloating();
        deps.requestAccess && deps.requestAccess();
      } else {
        actRecipe(id);
      }
      return;
    }
    if (rm && menu && menu.srv) {
      const id = menu.srv;
      const reqId = (body.querySelector('.srow[data-srv="' + id + '"]') || { dataset: {} }).dataset.req;
      closeMenu();
      if (rm.dataset.rm === 'test' && deps.testServer) {
        deps.testServer(id);
      } else if (rm.dataset.rm === 'page' && deps.serverPage) {
        const v = (servers || []).find((x) => x.id === id);
        closeIfFloating();
        if (v) {
          deps.serverPage(v.serverId);
        }
      } else if (rm.dataset.rm === 'cancel-req' && reqId && deps.cancelRequest) {
        deps.cancelRequest(reqId);
      }
      return;
    }
    if (e.target.closest('.reqlink')) {
      closeIfFloating();
      deps.requestAccess && deps.requestAccess();
      return;
    }
    const sr = e.target.closest('.srow');
    if (sr) {
      const sa = e.target.closest('[data-sa]');
      const what = sa ? sa.dataset.sa : 'open';
      const v = (servers || []).find((x) => x.id === sr.dataset.srv);
      if (what === 'more') {
        openServerMenu(sr.dataset.srv);
      } else if (what === 'signin') {
        closeIfFloating();
        deps.signInAgain && deps.signInAgain();
      } else if (what === 'keyact' && v && v.action && deps.keyAction) {
        closeIfFloating();
        deps.keyAction(v);
      } else if (what === 'why' && v && deps.why) {
        deps.why(v);
      } else if (what === 'clear' && v && deps.clearRequest) {
        deps.clearRequest(v.reqId);
      } else {
        openServer(sr.dataset.srv);
      }
      return;
    }
    if (rm && menu) {
      const sid = menu.sid;
      const what = rm.dataset.rm;
      closeMenu();
      if (what === 'rename') {
        renaming = sid;
        render();
      } else if (what === 'color') {
        openColors(sid);
      } else if (what === 'end') {
        deps.end(sid);
      }
      return;
    }
    const sw = e.target.closest('.rc-sw');
    if (sw && menu) {
      const sid = menu.sid;
      closeMenu();
      deps.color(sid, Number(sw.dataset.hue));
      focusRow(sid);
      return;
    }
    const b = e.target.closest('[data-ra]');
    const r = e.target.closest('.rr');
    if (b) {
      const what = b.dataset.ra;
      if (what === 'pin') {
        pinned = !pinned;
        persistPin();
        setOpen(pinned ? true : false, { focus: false });
        deps.pinChanged();
      } else if (what === 'close') {
        setOpen(false, { focus: false });
        deps.focusPane();
      } else if (what === 'newmenu') {
        openNewMenu(b);
      } else if (r && what === 'restore') {
        deps.restore && deps.restore(Number(r.dataset.sid)); // step 4: an explicit launch, with a permit
      } else if (r && what === 'showhide') {
        deps.showHide(Number(r.dataset.sid));
      } else if (r && what === 'closedone') {
        deps.closeDone && deps.closeDone(Number(r.dataset.sid));
      } else if (r && what === 'more') {
        openMenu(Number(r.dataset.sid));
      }
      return;
    }
    if (r && renaming == null && !(deps.justDragged && deps.justDragged())) {
      act(Number(r.dataset.sid));
    }
  });

  // A row can be dragged into the grid or out of the window (the renderer runs the drag).
  body.addEventListener('pointerdown', (e) => {
    for (const x of rail.querySelectorAll('.kb-ring')) {
      x.classList.remove('kb-ring');
    }
    const r = e.target.closest('.rr');
    if (r && !e.target.closest('button, input') && deps.dragStart) {
      deps.dragStart(e, Number(r.dataset.sid));
    }
  });

  rail.addEventListener('keydown', (e) => {
    if (renaming != null && e.target.classList.contains('rr-rename')) {
      if (e.key === 'Enter') {
        const sid = renaming;
        renaming = null;
        deps.rename(sid, e.target.value.trim());
        render();
        focusRow(sid);
      } else if (e.key === 'Escape') {
        const sid = renaming;
        renaming = null;
        render();
        focusRow(sid);
      }
      e.stopPropagation();
      return;
    }
    if (menu) {
      const items = [...menu.el.querySelectorAll('button')];
      const i = items.indexOf(document.activeElement);
      const horiz = !!menu.colors;
      if (e.key === (horiz ? 'ArrowRight' : 'ArrowDown') || e.key === 'Tab') {
        ringTo(items[(i + 1) % items.length]);
      } else if (e.key === (horiz ? 'ArrowLeft' : 'ArrowUp')) {
        ringTo(items[(i - 1 + items.length) % items.length]);
      } else if (e.key === 'Escape') {
        const sid = menu.sid;
        closeMenu();
        focusRow(sid);
      } else {
        return; // Enter/Space activate the focused button natively
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const sr = e.target.classList && e.target.classList.contains('srow') ? e.target : null;
    if (sr && (e.key === 'Enter' || e.key === ' ')) {
      openServer(sr.dataset.srv);
      e.preventDefault();
      return;
    }
    // a group row (3d): Enter or Space opens it here; the context-menu key opens ⋯
    const br = e.target.classList && e.target.classList.contains('brow') ? e.target : null;
    if (br && (e.key === 'Enter' || e.key === ' ')) {
      actBroker(br.dataset.brow, 'open');
      e.preventDefault();
      return;
    }
    if (br && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) {
      openBrokerMenu(br.dataset.brow);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // a recipe row: Enter or Space acts (Go to it, or Start); the context-menu key opens ⋯
    const rc = e.target.classList && e.target.classList.contains('rcp') ? e.target : null;
    if (rc && (e.key === 'Enter' || e.key === ' ')) {
      actRecipe(rc.dataset.rcp);
      e.preventDefault();
      return;
    }
    if (rc && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) {
      openRecipeMenu(rc.dataset.rcp);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const rs = rows();
    const cur = rs.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (rs.length) {
        const n = cur < 0 ? 0 : (cur + (e.key === 'ArrowDown' ? 1 : rs.length - 1)) % rs.length;
        focusRow(Number(rs[n].dataset.sid));
      }
    } else if (e.key === 'Enter' && cur >= 0) {
      act(Number(rs[cur].dataset.sid));
    } else if (e.key === ' ' && cur >= 0) {
      deps.showHide(Number(rs[cur].dataset.sid));
    } else if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) && cur >= 0) {
      openMenu(Number(rs[cur].dataset.sid));
    } else if (e.key === 'Escape') {
      closeIfFloating();
      deps.focusPane();
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  });

  flag.addEventListener('click', () => {
    if (flagOwner) {
      flagOwner.open();
      return;
    }
    setOpen(!open);
  });

  // A click outside a floating rail closes it.
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (open && !docked() && !rail.contains(e.target) && !flag.contains(e.target) && !e.target.closest('.end-dlg')) {
        setOpen(false, { focus: false });
      }
    },
    true
  );

  let wasCan = canPin();
  window.addEventListener('resize', () => {
    const can = canPin();
    rail.classList.toggle('slim', window.innerWidth < SLIM_UNDER);
    if (can !== wasCan) {
      wasCan = can;
      if (pinned && allowPin) {
        setOpen(false, { focus: false });
        deps.pinChanged();
      } else {
        paintHead();
      }
    }
  });

  setOpen(false, { focus: false });

  return {
    el: rail,
    flag,
    /** Draw the rows again from what is known (the self-test's stand-in for a broadcast from main). */
    rerender() {
      if (open || docked()) {
        render();
      }
    },
    /** null in mode A (no RECIPES header); the recipes' view rows once signed in (3c). */
    setRecipes(next, u) {
      recipes = next;
      unsaved = u || null;
      paintHead();
      if (open || docked()) {
        render();
      }
    },
    /** 3d: the groups of CLIs that keep running on brokers (see `groups` above). */
    setGroups(next) {
      bgroups = Array.isArray(next) ? next : [];
      if (open || pinned) {
        render();
      }
    },
    /** "Show them": the rail open at that group, its first row focused. */
    focusGroup(key) {
      if (!open && !pinned) {
        setOpen(true);
      }
      const gh = body.querySelector('.bgrp[data-grp="' + key + '"]');
      if (gh) {
        gh.scrollIntoView({ block: 'nearest' });
        const first = gh.nextElementSibling && gh.nextElementSibling.classList.contains('brow') ? gh.nextElementSibling : body.querySelector('.brow[data-brow^="' + key + '/"]');
        if (first) {
          first.focus();
        }
      }
    },
    /** Step 4: the offer and how many are in Recently closed (from main's sessions:offer). */
    setOffer(view) {
      offer = view && view.offer ? view.offer : null;
      recentCount = view && Array.isArray(view.recent) ? view.recent.length : 0;
      paintFlag();
      if (open || docked()) {
        render();
      }
    },
    setRestoring(r) {
      if (offer) {
        offer = { ...offer, restoring: r || undefined };
        if (open || docked()) {
          render();
        }
      }
    },
    /** null in mode A (no server area); the account's servers once signed in. */
    setServers(next) {
      servers = next;
      if (open || docked()) {
        render();
      }
    },
    update(next) {
      list = next || [];
      if (renaming != null && !list.some((s) => s.sid === renaming)) {
        renaming = null;
      }
      if (open || docked()) {
        render();
      } else {
        paintFlag();
      }
    },
    // Ctrl+Shift+L: a floating rail opens or closes; a pinned one takes or gives back the keyboard.
    toggle() {
      if (flagOwner) {
        flagOwner.toggle();
        return;
      }
      if (docked()) {
        if (rail.contains(document.activeElement)) {
          deps.focusPane();
        } else {
          render();
          focusRow(deps.activeSid());
        }
        return;
      }
      if (open) {
        setOpen(false, { focus: false });
        deps.focusPane();
      } else {
        setOpen(true);
      }
    },
    open: () => setOpen(true),
    close: () => setOpen(false, { focus: false }),
    /** The IN THIS WINDOW + menu, from the rail's + or the empty page's [New CLI]. */
    openNewMenu(anchor) {
      if (!anchor) {
        if (!open && !docked()) {
          setOpen(true, { focus: false });
        }
        render();
        anchor = body.querySelector('[data-ra=newmenu]');
      }
      if (anchor) {
        openNewMenu(anchor);
      }
    },
    closeNewMenu,
    newMenuOpen: () => !!newMenu,
    isOpen: () => open || docked(),
    isPinned: () => docked(),
    /** 0.12.5: the pin holds on Terminals only; elsewhere the rail floats (flag + overlay), the pin button hides.
     *  Leaving Terminals closes a floating rail; coming back brings the pinned rail back as left. */
    /** W1: lend the left flag to another rail (null gives it back). The owner carries count, dot, hidden. */
    setFlagOwner(o) {
      flagOwner = o || null;
      paintFlag();
    },
    repaintFlag: () => paintFlag(),
    setPinAllowed(v) {
      const was = docked();
      allowPin = !!v;
      if (was !== docked()) {
        setOpen(false, { focus: false });
        deps.pinChanged();
      } else {
        paintHead();
      }
    },
    focusRow,
    setEnabled(on) {
      flag.style.display = on ? '' : 'none';
      if (!on) {
        rail.hidden = true;
        document.documentElement.classList.remove('rail-docked');
      } else {
        setOpen(open, { focus: false });
      }
    },
  };
}
