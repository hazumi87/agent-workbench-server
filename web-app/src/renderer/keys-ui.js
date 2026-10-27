// Step 5a, the keys fallback's screens (the design #s5, <commit>; the design notes piece 3; PM ): the dialogs
// (a server that takes no password, a refresh's four steps and its two failures, Remove everywhere), the key
// card on a server's page, and the reminder strip in Settings › Servers. The steps run in main (keyflow.js);
// nothing here holds a key: the public line is the only key material a window ever sees.

import { icon } from './m3-chrome.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) {
    n.className = cls;
  }
  if (text != null) {
    n.textContent = text;
  }
  return n;
};

/** "12 Sep" (the design: "made 12 Sep"). */
export const dayMonth = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const dateWord = (iso) => dayMonth(new Date(iso + 'T12:00:00').getTime());

/** One dialog in the app's style (.end-dlg .dlg). buttons: [{ label, kind: 'cancel'|'primary'|'danger', value }].
 *  Resolves the chosen value (Esc = the first cancel's). `body` is text or a node. */
function dialog({ ic, icColor, title, body, buttons, extra }) {
  return new Promise((resolve) => {
    const back = document.activeElement;
    const wrap = el('div', 'end-dlg kx-dlg');
    const d = el('div', 'dlg');
    d.setAttribute('role', 'alertdialog');
    d.setAttribute('aria-modal', 'true');
    d.innerHTML = icon(ic, 'ic');
    if (icColor) {
      d.querySelector('.ic').style.color = icColor;
    }
    d.appendChild(el('h4', null, title));
    if (body) {
      d.appendChild(typeof body === 'string' ? el('p', null, body) : body);
    }
    if (extra) {
      d.appendChild(extra);
    }
    const a = el('div', 'a');
    const close = (v) => {
      wrap.remove();
      if (back && back.isConnected) {
        back.focus();
      }
      resolve(v);
    };
    for (const b of buttons) {
      const x = el('button', b.kind, b.label);
      x.type = 'button';
      x.dataset.kx = b.value;
      x.addEventListener('click', () => close(b.value));
      a.appendChild(x);
    }
    d.appendChild(a);
    wrap.appendChild(d);
    wrap.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        close((buttons.find((b) => b.kind === 'cancel') || {}).value || null);
      }
    });
    document.body.appendChild(wrap);
    (a.querySelector('.primary') || a.querySelector('button')).focus();
    dialog.current = { wrap, close };
  });
}

/** the design k5: a server that takes no password (or a Windows server): an admin adds the key. */
export async function noPassword(r, deps) {
  const ex = el('div', 'kx-np');
  ex.appendChild(el('div', 'kx-mono', r.command || r.pub));
  const row = el('div', 'kx-copy');
  const cp = (label, text) => {
    const b = el('button', 'kx-tn', label);
    b.type = 'button';
    b.addEventListener('click', () => {
      void deps.copy(text);
      deps.snackbar('Copied.');
    });
    return b;
  };
  row.appendChild(cp('Copy public key', r.pub));
  if (r.command) {
    row.appendChild(cp('Copy the command', r.command));
  }
  ex.append(row, el('p', 'kx-small', "When it's done, check again."));
  const v = await dialog({
    ic: 'key_off',
    title: r.name + " doesn't allow passwords",
    body: 'Ask an admin of ' + r.name + " to add this PC's key. Send them this line, or the key itself.",
    extra: ex,
    buttons: [
      { label: 'Close', kind: 'cancel', value: 'close' },
      { label: 'Check again', kind: 'primary', value: 'check' },
    ],
  });
  return v;
}

/** the design k4a/k4b/k4c: Refresh with its four steps, then the snackbar or one of the two failures. */
export async function refresh(row, deps) {
  const N = row.serverName || row.title;
  const steps = ['Made a new key', 'Put it on ' + N, 'Checking it in a new connection…', 'Took the old key off'];
  const list = el('div', 'kx-steps');
  const items = steps.map((t) => {
    const s = el('div', 'kx-stp wait');
    s.innerHTML = icon('radio_button_unchecked');
    s.appendChild(document.createTextNode(t));
    list.appendChild(s);
    return s;
  });
  const set = (n, state) => {
    const s = items[n - 1];
    if (!s) {
      return;
    }
    s.className = 'kx-stp ' + (state === 'done' ? 'done' : state === 'now' ? 'now' : state === 'failed' ? 'failed' : 'wait');
    s.querySelector('.ms').textContent = state === 'done' ? 'check_circle' : state === 'now' ? 'progress_activity' : state === 'failed' ? 'error' : 'radio_button_unchecked';
  };
  const note = el('p', 'kx-note', 'Your old key keeps working until the new one is checked.');
  const extra = el('div');
  extra.append(list, note);
  const off = deps.onProgress((p) => p.serverId === row.id && set(p.step, p.state));
  const open = dialog({ ic: 'key', title: 'Refreshing the key for ' + N, extra, buttons: [{ label: 'Cancel', kind: 'cancel', value: 'cancel' }] });
  const cancelB = document.querySelector('.kx-dlg [data-kx=cancel]');
  // Cancel is available until the check starts
  const offCheck = deps.onProgress((p) => p.serverId === row.id && p.step === 3 && cancelB && (cancelB.disabled = true));
  void open.then((v) => v === 'cancel' && deps.cancel(row.id)); // honored until the check starts
  const res = await deps.run(row.id);
  off();
  offCheck();
  if (dialog.current) {
    dialog.current.close(null);
  }
  if (res && res.ok) {
    deps.snackbar('Key refreshed on ' + N);
    return res;
  }
  if (!res || res.at === 'cancelled' || res.at === 'busy') {
    return res;
  }
  if (res.at === 'retire') {
    const v = await dialog({ ic: 'warning', icColor: 'var(--md-sys-color-error)', title: 'The old key is still on ' + N, body: "The new key works, but the old one couldn't be removed. Both keys are on " + N + ' for now.', extra: details(res.said), buttons: [{ label: 'Close', kind: 'cancel', value: 'close' }, { label: 'Try again', kind: 'primary', value: 'again' }] });
    return v === 'again' ? deps.retireAgain(row.id, res.oldFp) : res;
  }
  const lost = res.at === 'put' && res.lost;
  const v = await dialog({
    ic: 'error',
    icColor: 'var(--md-sys-color-error)',
    title: lost ? 'Lost ' + N + ' halfway' : "The new key didn't work on " + N,
    body: lost ? 'Your old key still works there; nothing was removed.' : 'Nothing was removed. Your old key still works.',
    extra: details(res.said),
    buttons: [
      { label: 'Close', kind: 'cancel', value: 'close' },
      { label: 'Try again', kind: 'primary', value: 'again' },
    ],
  });
  return v === 'again' ? refresh(row, deps) : res;
}

/** [Details]: what ssh said (its own words, from the Workbench's own check, never a terminal). */
function details(said) {
  const d = el('details', 'kx-det');
  d.appendChild(el('summary', null, 'Details'));
  d.appendChild(el('pre', null, said || 'ssh gave no reason.'));
  return d;
}

/** Remove everywhere… (error-colored; asks first, naming every server from the ledger). */
export async function removeEverywhere(ledger, deps) {
  const names = [...new Set(ledger.map((e) => e.name))];
  const list = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0] || '';
  const v = await dialog({ ic: 'key_off', title: "Remove this PC's key from " + list + '?', body: "You'll need a password again to connect.", buttons: [{ label: 'Cancel', kind: 'cancel', value: 'cancel' }, { label: 'Remove', kind: 'danger', value: 'remove' }] });
  if (v !== 'remove') {
    return null;
  }
  const r = await deps.removeEverywhere();
  deps.snackbar(r && r.ok ? "This PC's key is off " + list + '.' : "Couldn't remove it everywhere. Check the servers and try again.");
  return r;
}

/** The key card on a keys-only server's page (the design's keyCard, k3). `row` is the access row, `kv` the keys
 *  view ({ key, remind, ledger }), `older` the tagged keys left on this login by another PC. */
export function keyCard(row, kv, older, h) {
  const card = el('div', 'keyc');
  card.dataset.kc = row.id;
  const krow = (ic, b, small, btn) => {
    const r = el('div', 'krow');
    r.innerHTML = icon(ic);
    const tx = el('div', 'tx');
    tx.append(el('b', null, b), el('small', null, small));
    r.appendChild(tx);
    if (btn) {
      r.appendChild(btn);
    }
    return r;
  };
  const btn = (label, cls, fn, act) => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.dataset.ka = act;
    b.addEventListener('click', fn);
    return b;
  };
  const k = kv && kv.key;
  if (k) {
    card.appendChild(krow('key', "This PC's key", 'ed25519 · made ' + dayMonth(k.created) + ' · ' + k.ageDays + (k.ageDays === 1 ? ' day old' : ' days old'), btn('Refresh key', 'kx-tn', () => h.refresh(row), 'refresh')));
    // the reminder: a prompt only (rule 5)
    const sel = el('button', 'kx-rbtn');
    sel.type = 'button';
    sel.dataset.ka = 'remind';
    sel.innerHTML = '';
    sel.append(kv.remind.days ? 'Every ' + kv.remind.days + ' days' : 'Never');
    sel.insertAdjacentHTML('beforeend', icon('arrow_drop_down'));
    sel.addEventListener('click', () => h.remindMenu(sel));
    card.appendChild(krow('notifications', 'Remind me to refresh', 'A prompt only. It never refreshes by itself.', sel));
  }
  const on = (kv && kv.ledger) || [];
  if (on.length) {
    const where = on.map((e) => e.name + ' · ' + e.login + ' (' + dayMonth(e.at) + ')').join(' · ');
    const rm = btn('Remove everywhere…', 'kx-t kx-err', () => h.removeEverywhere(), 'remove');
    card.appendChild(krow('dns', 'Installed on', where, rm));
  }
  const N = row.serverName;
  if (older && older.length) {
    for (const o of older) {
      const fg = btn('Forget', 'kx-t', () => h.forget(row, o.line), 'forget');
      card.appendChild(krow('history', older.length === 1 ? '1 older key on ' + N : older.length + ' older keys on ' + N, (o.samePc ? 'Made earlier on this PC' : 'Made by this account on another PC') + ' · ' + dateWord(o.date), fg));
    }
  }
  return card;
}

/** The reminder strip in Settings › Servers (the design k1): one key past its interval. */
export function reminderStrip(kv, h) {
  if (!kv || !kv.remind || !kv.remind.due || !kv.ledger.length) {
    return null;
  }
  const first = kv.ledger[0];
  const s = el('div', 'hstrip kx-remind');
  s.innerHTML = icon('key');
  const t = el('span', 't');
  t.append(el('b', null, 'Your key for ' + first.name + ' is ' + kv.key.ageDays + ' days old'), ' Refreshing takes a few seconds.');
  const go = el('button', 'tb', 'Refresh');
  go.type = 'button';
  go.dataset.ka = 'remind-refresh';
  go.addEventListener('click', () => h.refreshFirst(first));
  const x = el('button', 'ib');
  x.type = 'button';
  x.title = 'Remind me next week';
  x.setAttribute('aria-label', 'Remind me next week');
  x.dataset.ka = 'snooze';
  x.innerHTML = icon('close');
  x.addEventListener('click', () => h.snooze());
  s.append(t, go, x);
  return s;
}

export const REMIND_CHOICES = [30, 60, 90, 180, 0];
