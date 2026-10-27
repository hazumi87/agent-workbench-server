// F7, Request access (the design's 3b design and its words). A page in the settings
// sheet, so the panes stay usable: Server · Sign in as (one or more, as chips; logins you have or have
// asked for are shown and disabled) · Note to the admin (optional) · [Cancel] [Send]. Two more states:
// nothing left to ask for, and a Send that couldn't reach the account (the form keeps what was typed).

import { icon } from './m3-chrome.js';

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

/** Servers with at least one login the person doesn't have or hasn't asked for. */
export function askable(servers) {
  return (servers || []).filter((s) => s.logins.some((l) => l.status === 'open'));
}

/**
 * rq: { loading, loadFailed, servers, serverId, picked (Set of login ids), note, error, sending }
 * h: { send(), cancel(), reload(), pick(serverId), toggle(loginId), note(text) }; host: the account address
 */
export function renderRequest(sec, rq, h, host) {
  sec.textContent = '';
  if (rq.loading) {
    return;
  }
  if (rq.loadFailed) {
    // the list couldn't be loaded: the quiet tone in place of the form; Cancel stays
    const p = el('div', 'rq-off');
    p.insertAdjacentHTML('beforeend', icon('cloud_off'));
    p.appendChild(el('span', null, `Can't reach ${host} to list its servers. Check your network, then try again.`));
    const acts = el('div', 'ac-acts');
    const cancel = el('button', 'ac-btn t', 'Cancel');
    cancel.addEventListener('click', () => h.cancel());
    const again = el('button', 'ac-btn t', 'Try again');
    again.addEventListener('click', () => h.reload());
    acts.append(cancel, again);
    sec.append(p, acts);
    return;
  }
  const list = askable(rq.servers);
  if (!list.length) {
    // the design  (4): while some logins are still waiting for approval, say so
    const waiting = (rq.servers || []).some((s) => s.logins.some((l) => l.status === 'asked'));
    sec.appendChild(el('div', 'rq-line', waiting ? "Every login on the account's servers is yours or waiting for approval." : "You have access to every login on the account's servers."));
    return;
  }
  const server = list.find((s) => s.id === rq.serverId) || list[0];

  // Server
  const sv = el('div', 'ac-of rq-sel');
  const svl = el('label', null, 'Server');
  svl.htmlFor = 'rqServer';
  const sel = el('select');
  sel.id = 'rqServer';
  for (const s of list) {
    const o = el('option', null, s.name);
    o.value = s.id;
    o.selected = s.id === server.id;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => h.pick(sel.value));
  sv.append(svl, sel);
  sv.insertAdjacentHTML('beforeend', icon('arrow_drop_down', 'rq-dd'));

  // Sign in as
  const lab = el('div', 'lbl', 'Sign in as');
  lab.id = 'rqAsLabel';
  const chips = el('div', 'rq-chips');
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-labelledby', 'rqAsLabel');
  for (const l of server.logins) {
    const on = rq.picked.has(l.id);
    const c = el('button', 'rq-chip' + (on ? ' on' : ''));
    c.type = 'button';
    c.dataset.login = l.id;
    if (l.status !== 'open') {
      c.disabled = true;
      c.append(l.login + ' · ' + (l.status === 'have' ? 'You have this' : 'Asked'));
    } else {
      c.setAttribute('aria-pressed', String(on));
      if (on) {
        c.insertAdjacentHTML('beforeend', icon('check'));
      }
      c.append(l.login);
      c.addEventListener('click', () => h.toggle(l.id));
    }
    chips.appendChild(c);
  }

  // Note to the admin (optional)
  const nf = el('div', 'ac-of rq-note');
  const nl = el('label', null, 'Note to the admin (optional)');
  nl.htmlFor = 'rqNote';
  const ta = el('textarea');
  ta.id = 'rqNote';
  ta.maxLength = 200;
  ta.rows = 3;
  ta.value = rq.note || '';
  ta.addEventListener('input', () => h.note(ta.value));
  const sup = el('div', 'ac-sup', "Say what it's for, like 'to debug the site'.");
  sup.id = 'rqNote-sup';
  ta.setAttribute('aria-describedby', sup.id);
  nf.append(nl, ta, sup);

  const acts = el('div', 'ac-acts');
  const cancel = el('button', 'ac-btn t', 'Cancel');
  cancel.addEventListener('click', () => h.cancel());
  const send = el('button', 'ac-btn f');
  send.id = 'rqSend';
  send.insertAdjacentHTML('beforeend', icon('send'));
  send.appendChild(el('span', null, 'Send'));
  send.disabled = rq.sending || ![...rq.picked].some((id) => server.logins.some((l) => l.id === id && l.status === 'open'));
  send.addEventListener('click', () => h.send(server.id));
  acts.append(cancel, send);
  sec.append(sv, lab, chips, nf, acts);
  if (rq.error) {
    const e = el('div', 'ac-inl e rq-err');
    e.setAttribute('role', 'alert');
    e.insertAdjacentHTML('beforeend', icon('error'));
    e.appendChild(el('span', null, `Can't reach ${host}, so the request wasn't sent. Try again in a moment.`));
    sec.appendChild(e);
  }
}
