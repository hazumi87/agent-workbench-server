// Settings › Servers with an account, and a server's page (the design's 3b design, s1/s2;
// words from her tables). Each server is a read-only card ("From your account", the design : the account
// owns the record, so no edit or delete) with its logins inside; pending requests sit on top with Cancel request;
// Request access… ends the list. A server's page has one block per login: the status line, the broker
// line, the access line, [Test] [Open a shell] (Open is off while the broker is down or isn't the one
// the account approved), and Details at the bottom.

import { icon } from './m3-chrome.js';
import { createModulePanel } from './servers/modules.js';

const panels = new WeakMap();

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
const osWord = (os) => (os === 'windows' ? 'Windows' : os === 'mac' ? 'macOS' : 'Linux');

/** The account's servers, grouped: { id, name, address, hostname, os, from, logins: [rail rows] }. */
export function groupServers(rows) {
  const by = new Map();
  for (const r of rows || []) {
    if (r.request) {
      continue;
    }
    if (!by.has(r.serverId)) {
      by.set(r.serverId, { id: r.serverId, name: r.serverName, address: r.address, hostname: r.hostname, os: r.os, from: r.from, keysOnly: r.keysOnly, logins: [] });
    }
    by.get(r.serverId).logins.push(r);
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function dot(kind) {
  return el('span', 'sv-dot ' + (kind || ''));
}

/** A login's one-word state, as the rail says it (Settings adds the word to the Keeps running icon). */
function loginLine(r) {
  const line = el('div', 'sv-ln');
  if (r.dot) {
    line.appendChild(dot(r.dot));
  }
  line.appendChild(el('span', null, `${r.login} · ${r.line}`));
  if (r.keepsRunning && r.state === 'connected') {
    const k = el('span', 'sv-kr');
    k.insertAdjacentHTML('beforeend', icon('all_inclusive'));
    k.appendChild(document.createTextNode('Keeps running'));
    line.appendChild(k);
  }
  return line;
}

/** Below This machine, with an account: pending rows on top, a card per server, Request access…. */
export function renderAccountServers(sec, rows, realmName, h) {
  for (const p of panels.get(sec) || []) p.destroy();
  const currentPanels = [];
  panels.set(sec, currentPanels);
  const pending = (rows || []).filter((r) => r.request && r.state === 'waiting');
  const top = sec.firstChild;
  // 5a: the key reminder (the design #s5 k1): a prompt only, above the servers
  const strip = h.keyReminder ? h.keyReminder() : null;
  if (strip) {
    sec.insertBefore(strip, top);
  }
  for (const p of pending) {
    const row = el('div', 'sv-pend');
    row.dataset.req = p.reqId;
    row.insertAdjacentHTML('beforeend', icon('schedule', 'sv-pic'));
    const tx = el('div', 'sv-ptx');
    // the line stays on one line; Cancel request sits under it as a small text button
    tx.append(el('b', null, p.title), el('small', null, p.line));
    const b = el('button', 'ac-btn t', 'Cancel request');
    b.addEventListener('click', () => h.cancelRequest(p.reqId));
    tx.appendChild(b);
    row.appendChild(tx);
    sec.insertBefore(row, top);
  }
  for (const s of groupServers(rows)) {
    const card = el('button', 'pg-card sv-card');
    card.dataset.server = s.id;
    card.appendChild(el('div', 'pg-cardt', s.name));
    card.appendChild(el('div', 'pg-cards', [s.address, osWord(s.os), 'From your account'].filter(Boolean).join(' · ')));
    for (const r of s.logins) {
      card.appendChild(loginLine(r));
    }
    card.insertAdjacentHTML('beforeend', icon('chevron_right', 'pg-chev'));
    card.addEventListener('click', () => h.openServerPage(s.id));
    sec.appendChild(card);
    if (!s.keysOnly && h.moduleCall && h.account) {
      const p = createModulePanel({ server: s, account: h.account, accountEpoch: h.accountEpoch, targets: () => s.logins, call: h.moduleCall, readOnly: true });
      sec.append(p.el); currentPanels.push(p);
    }
    // 5a: a login that falls back to a key has one button under its card (the design k1: Connect with a password)
    for (const r of s.logins.filter((x) => x.action && h.keyAction)) {
      const ka = el('div', 'sv-keyact');
      ka.dataset.srv = r.id;
      const b = el('button', 'ac-btn tonal', r.action.label);
      b.dataset.ka = r.action.act;
      b.addEventListener('click', () => h.keyAction(r));
      ka.appendChild(b);
      sec.appendChild(ka);
    }
  }
  const rq = el('button', 'reqlink sv-req');
  rq.insertAdjacentHTML('beforeend', icon('add'));
  rq.appendChild(document.createTextNode('Request access…'));
  rq.addEventListener('click', () => h.requestAccess());
  sec.appendChild(rq);
}

/** A login's status line on its block (piece 2's Test words, the design's broker and identity lines). */
function statusLine(r, s, h, det) {
  const p = el('div', 'sv-st');
  p.appendChild(dot(r.dot));
  const t = r.test;
  let text;
  let details = false;
  if (r.state === 'identity') {
    text = `Broker identity doesn't match. Ask your admin to check ${s.name}.`;
    details = true;
  } else if (r.state === 'broker-down') {
    text = `Broker not running. CLIs can't keep running on ${s.name} right now.`;
    details = true;
  } else if (r.state === 'connected') {
    text = `Connected as ${r.login}. ${t && t.os ? t.os : osWord(r.os)}${t && t.shell ? ', ' + t.shell : ''}.`;
  } else if (r.state === 'cant-reach') {
    text = r.keysOnly ? `Can't reach ${s.name} on port ${r.port}. Check the address and that it's on your network.` : `Can't reach ${s.name}.`;
  } else if (t && !t.ok && t.why === 'timeout') {
    text = "Couldn't check: no answer in 5 seconds.";
  } else {
    text = r.line;
  }
  p.appendChild(el('span', null, text + (details ? ' ' : '')));
  if (details) {
    // the one Details on the page: this link opens and closes the box at the bottom
    const d = el('button', 'sv-link', det && det.open ? 'Hide details' : 'Details');
    d.setAttribute('aria-expanded', String(!!(det && det.open)));
    d.addEventListener('click', () => h.toggleDetails());
    p.appendChild(d);
  }
  return p;
}

/** One server's page. det: { open, hostFp, identity } (Details at the bottom). */
export function renderServerPage(sec, s, realmName, h, det) {
  for (const p of panels.get(sec) || []) p.destroy();
  panels.set(sec, []);
  sec.textContent = '';
  if (!s) {
    return;
  }
  sec.appendChild(el('div', 'sv-head', [s.hostname, s.address, osWord(s.os), 'From your account'].filter(Boolean).join(' · ')));
  for (const r of s.logins) {
    const blk = el('div', 'sv-blk');
    blk.dataset.srv = r.id;
    const hd = el('div', 'sv-bh');
    hd.insertAdjacentHTML('beforeend', icon('person', 'sv-pi'));
    hd.appendChild(el('b', null, r.login));
    blk.appendChild(hd);
    blk.appendChild(statusLine(r, s, h, det));
    if (r.keysOnly && r.usesKey) {
      // 5a (the design k3): this PC signs in with its own key here; the card, or the one way to set it up
      blk.appendChild(el('div', 'sv-sub', 'Keys-only server · no broker'));
      blk.appendChild(el('p', 'sv-sub kx-why', `${s.name} has no broker and doesn't trust the account's certificates, so this PC signs in with a key.`));
      if (r.action && h.keyAction) {
        const ka = el('div', 'sv-keyact');
        const b = el('button', 'ac-btn tonal', r.action.label);
        b.dataset.ka = r.action.act;
        b.addEventListener('click', () => h.keyAction(r));
        ka.appendChild(b);
        blk.appendChild(ka);
      }
      const kc = h.keyCard ? h.keyCard(r) : null;
      if (kc && !r.action) {
        blk.appendChild(kc);
      }
    } else if (r.keysOnly) {
      blk.appendChild(el('div', 'sv-sub', 'Keys-only server · no broker'));
      blk.appendChild(el('div', 'sv-sub', "Signs in with your account's access."));
    } else if (r.state !== 'broker-down' && r.state !== 'identity') {
      blk.appendChild(el('div', 'sv-sub', 'Broker: Running' + (r.brokerVersion ? ' · ' + r.brokerVersion : '')));
    }
    // one line under the login's name: renews by itself, or the renewal / expiry texts (the design's access table)
    if (r.state === 'renewal-failing') {
      const a = el('div', 'sv-sub sv-acc');
      a.insertAdjacentHTML('beforeend', icon('schedule'));
      a.appendChild(document.createTextNode(r.tip));
      blk.appendChild(a);
    } else if (r.state === 'expired') {
      const a = el('div', 'sv-sub');
      a.append('Access expired · ');
      const si = el('button', 'sv-link', 'Sign in again');
      si.addEventListener('click', () => h.signInAgain());
      a.appendChild(si);
      blk.appendChild(a);
    } else if (!r.usesKey) {
      blk.appendChild(el('div', 'sv-sub', 'Access renews by itself'));
    }
    const acts = el('div', 'ac-acts start');
    const test = el('button', 'ac-btn o');
    test.insertAdjacentHTML('beforeend', icon('network_check'));
    test.appendChild(el('span', null, 'Test'));
    test.addEventListener('click', () => h.test(r.id));
    const open = el('button', 'ac-btn tonal');
    open.insertAdjacentHTML('beforeend', icon('terminal'));
    open.appendChild(el('span', null, 'Open a shell'));
    open.disabled = !r.canOpen;
    if (!r.canOpen && r.tip) {
      open.title = r.tip;
    }
    open.addEventListener('click', () => h.open(r));
    acts.append(test, open);
    blk.appendChild(acts);
    sec.appendChild(blk);
  }
  if (!s.keysOnly && h.moduleCall && h.account) {
    const p = createModulePanel({ server: s, account: h.account, accountEpoch: h.accountEpoch, targets: () => s.logins, call: h.moduleCall, readOnly: true });
    sec.append(p.el); panels.set(sec, [p]);
  }
  // Details, once on the page: the host fingerprint of a keys-only server, or the broker
  // key the account approved for each login and the address it answers at. A status line with its own
  // Details link (broker down, identity) is the one control; otherwise the fold at the bottom is.
  const inline = s.logins.some((r) => r.state === 'identity' || r.state === 'broker-down');
  if (!inline) {
    const fold = el('button', 'sv-fold');
    fold.setAttribute('aria-expanded', String(!!det.open));
    fold.insertAdjacentHTML('beforeend', icon(det.open ? 'expand_less' : 'expand_more'));
    fold.appendChild(document.createTextNode('Details'));
    fold.addEventListener('click', () => h.toggleDetails());
    sec.appendChild(fold);
  }
  if (det.open) {
    const box = el('div', 'sv-det');
    if (s.keysOnly) {
      const line = el('div', 'sv-dl');
      line.append('Host fingerprint ');
      line.appendChild(el('span', 'sv-fp', det.hostFp || 'not recorded yet'));
      box.appendChild(line);
      if (det.hostFp) {
        const fl = el('div', 'sv-dl');
        const f = el('button', 'sv-link', 'Forget the old fingerprint');
        f.addEventListener('click', () => h.forgetHostKey());
        fl.appendChild(f);
        box.appendChild(fl);
      }
    } else {
      for (const r of s.logins) {
        // the design : expected and where; no "got"
        const line = el('div', 'sv-dl');
        line.append(`${r.login}: ${r.state === 'identity' ? 'Expected: ' : 'broker key '}`);
        line.appendChild(el('span', 'sv-fp', r.brokerFp || 'not recorded yet'));
        line.append(' · from your account');
        box.appendChild(line);
        if (r.state === 'identity') {
          box.appendChild(el('div', 'sv-dl', "The broker's answer wasn't signed by that key."));
        }
      }
      box.appendChild(el('div', 'sv-dl', `Address ${s.address}`));
    }
    sec.appendChild(box);
  }
}
