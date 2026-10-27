// Settings › Accounts (the design's step-3a design (d), (e), (f); words from her table). One page, four
// moments: No account yet → Sign in to your Workbench account (address) → Finish signing in in your
// browser (wait) → Name this computer; then the one-account card with Sign out (confirmed) and
// Manage devices and passkeys…. Nothing here is modal except the Sign out confirm, and sign-in
// problems show under the step they stop (F11). Present only when the Accounts module is.

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

const NOTICE = {
  'didnt-finish': () => "Sign-in didn't finish in the browser. Try again when you're ready.",
  off: () => 'This account is turned off. Ask your admin about it.',
  lost: (h) => `Lost the connection to ${h} while signing in. Try again.`,
  'device-limit': () => 'This account has added several computers in the last hour. Try again in an hour.',
};
// the example address comes from the build's config (st.example), never from code
const hint = (ex) => (ex ? `From your invite email, like ${ex}, or paste the invite link` : 'From your invite email, or paste the invite link');

function btn(kind, label, ic) {
  const b = el('button', 'ac-btn ' + kind);
  if (ic) {
    b.insertAdjacentHTML('beforeend', icon(ic));
  }
  b.appendChild(el('span', null, label));
  return b;
}

/** An outlined field: label on the border, the line under it (hint, or the error in error color). */
function field(id, label, value, sup, err) {
  const wrap = el('div', 'ac-of' + (err ? ' err' : ''));
  const lab = el('label', null, label);
  lab.htmlFor = id;
  const inp = el('input');
  inp.id = id;
  inp.type = 'text';
  inp.value = value || '';
  inp.spellcheck = false;
  inp.autocomplete = 'off';
  const s = el('div', 'ac-sup', sup);
  s.id = id + '-sup';
  inp.setAttribute('aria-describedby', s.id);
  if (err) {
    inp.setAttribute('aria-invalid', 'true');
  }
  wrap.append(lab, inp, s);
  return { wrap, inp };
}

function notice(text, kind) {
  const n = el('div', 'ac-inl ' + (kind || 'n'));
  n.setAttribute('role', 'status');
  n.insertAdjacentHTML('beforeend', icon(kind === 'e' ? 'error' : 'info'));
  n.appendChild(el('span', null, text));
  return n;
}

/**
 * st: the module's view ({account, flow, address, notice}); ui: this page's own state ({step,
 * address, error, focus}); h: handlers {begin, reopen, cancel, name, signout, manage, rerender}.
 */
export function renderAccounts(sec, st, ui, h) {
  sec.textContent = '';
  const flow = st.flow;
  // the card, unless a workbench:// link asked for the address step (F11: "already signed in there")
  if (st.account && !flow && ui.step !== 'address') {
    const accounts = st.accounts || [st.account];
    for (const a of accounts) renderCard(sec, a, h, accounts.length > 1);
    const add = btn('o', 'Add another account', 'add');
    add.addEventListener('click', () => h.add());
    sec.appendChild(add);
    if (accounts.length > 1) sec.appendChild(el('p', 'ac-hint', 'Switching changes the servers and recipes you see. Open terminals stay as they are. This machine is always here.'));
    return;
  }
  if (flow && (flow.phase === 'waiting' || flow.phase === 'finishing')) {
    const box = el('div', 'ac-wait');
    const spin = el('div', 'ac-spin');
    spin.setAttribute('role', 'progressbar');
    spin.setAttribute('aria-label', 'Waiting for the browser');
    box.appendChild(spin);
    box.appendChild(el('div', 'ac-title', 'Finish signing in in your browser.'));
    box.appendChild(el('div', 'ac-hint', `We opened ${flow.host} in your browser.`));
    const acts = el('div', 'ac-acts start');
    const again = btn('o', 'Open it again', 'open_in_new');
    const cancel = btn('t', 'Cancel');
    again.addEventListener('click', () => h.reopen());
    cancel.addEventListener('click', () => {
      ui.step = 'address';
      ui.focus = 'address';
      h.cancel();
    });
    acts.append(again, cancel);
    box.appendChild(acts);
    sec.appendChild(box);
    return;
  }
  if (flow && flow.phase === 'name') {
    sec.appendChild(el('div', 'ac-title', 'Name this computer'));
    const f = field('acName', 'Computer name', ui.name != null ? ui.name : flow.name, ui.nameError || "So you can recognize it in your account's list of devices.", !!ui.nameError);
    f.inp.maxLength = 40;
    sec.appendChild(f.wrap);
    if (flow.notice) {
      sec.appendChild(notice(NOTICE[flow.notice](flow.host)));
    }
    const acts = el('div', 'ac-acts');
    const go = btn('f', 'Continue');
    if (flow.busy) {
      go.disabled = true;
      go.prepend(el('span', 'ac-spin sm'));
    }
    const submit = () => {
      const v = f.inp.value.trim();
      ui.name = f.inp.value;
      if (!v || [...v].length > 40) {
        ui.nameError = '1 to 40 characters.';
        h.rerender();
        return;
      }
      ui.nameError = null;
      h.name(v);
    };
    go.addEventListener('click', submit);
    f.inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        submit();
      }
    });
    f.inp.addEventListener('input', () => {
      ui.name = f.inp.value;
    });
    acts.appendChild(go);
    sec.appendChild(acts);
    if (!flow.busy) {
      setTimeout(() => f.inp.focus(), 0); // after the sheet is shown (a hidden element takes no focus)
    }
    return;
  }
  if (ui.step !== 'address') {
    // No account yet (mode A)
    const card = el('div', 'ac-card');
    card.appendChild(el('div', 'ac-cardt', 'No account yet'));
    card.appendChild(el('div', 'ac-cards', 'An account brings your servers, recipes and settings to every computer you sign in on. This machine keeps working without one.'));
    const go = btn('f', 'Sign in', 'login');
    go.addEventListener('click', () => {
      ui.step = 'address';
      ui.focus = 'address';
      h.rerender();
    });
    card.appendChild(go);
    sec.appendChild(card);
    return;
  }
  // Sign in to your Workbench account
  sec.appendChild(el('div', 'ac-title', 'Sign in to your Workbench account'));
  const f = field('acAddress', 'Account address', ui.address != null ? ui.address : st.address, ui.error || hint(st.example), !!ui.error);
  sec.appendChild(f.wrap);
  if (st.notice && !ui.error) {
    sec.appendChild(notice(NOTICE[st.notice](ui.address || st.address)));
  }
  const acts = el('div', 'ac-acts');
  const cancel = btn('t', 'Cancel');
  const go = btn('f', 'Continue');
  if (ui.busy) {
    go.disabled = true;
    go.prepend(el('span', 'ac-spin sm'));
  }
  cancel.addEventListener('click', () => {
    ui.step = null;
    ui.error = null;
    ui.address = null;
    h.cancel();
  });
  const submit = () => {
    ui.address = f.inp.value;
    h.begin(f.inp.value);
  };
  go.addEventListener('click', submit);
  f.inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      submit();
    }
  });
  f.inp.addEventListener('input', () => {
    ui.address = f.inp.value;
  });
  acts.append(cancel, go);
  sec.appendChild(acts);
  // A link fills the form but never starts sign-in by itself: focus goes to Continue.
  const target = ui.focus === 'continue' ? go : f.inp;
  ui.focus = null;
  setTimeout(() => target.focus(), 0); // after the sheet is shown (a hidden element takes no focus)
}

function renderCard(sec, a, h, multiple) {
  const card = el('div', 'ac-acard');
  const t = el('div', 't');
  t.appendChild(el('span', 'av', (a.username[0] || '?').toUpperCase()));
  const who = el('span');
  who.appendChild(el('b', null, a.label));
  // the email on one line, the address on the next (the design , fix 3)
  who.appendChild(el('small', null, a.email));
  who.appendChild(el('small', null, a.address));
  t.appendChild(who);
  card.appendChild(t);
  const ended = a.status === 'ended';
  const line = el('div', 'ln' + (ended ? ' warn' : a.status === 'unreachable' ? ' quiet' : ''));
  const lineText = (ic, text) => {
    line.insertAdjacentHTML('beforeend', icon(ic));
    line.appendChild(el('span', null, text));
  };
  if (ended) {
    // the reason first when the account gives one
    lineText('error', a.statusText);
    card.insertBefore(line, t.nextSibling);
    card.appendChild(el('div', 'ln', `This computer: ${a.deviceName}`));
  } else {
    card.appendChild(el('div', 'ln', `This computer: ${a.deviceName}`));
    if (a.status === 'unreachable') {
      lineText('cloud_off', a.statusText); // the renewal tone: a signed-in computer isn't in trouble
    } else {
      lineText('check_circle', 'Signed in · access renews by itself');
    }
    card.appendChild(line);
  }
  const acts = el('div', 'a');
  if (multiple) {
    if (a.active) acts.appendChild(el('span', 'ac-active', 'Active'));
    else { const choose = btn('o', 'Make active'); choose.addEventListener('click', () => h.select(a.id)); acts.appendChild(choose); }
  }
  if (ended) {
    if (a.signInAgain) {
      const again = btn('f', 'Sign in again');
      again.addEventListener('click', () => h.signInAgain(a.address));
      acts.appendChild(again);
    }
  } else {
    const manage = btn('t', 'Manage devices and passkeys…', 'open_in_new');
    manage.addEventListener('click', () => h.manage(a.id));
    acts.appendChild(manage);
  }
  const out = btn('t err', 'Sign out');
  out.addEventListener('click', () => confirmSignOut(a, h));
  acts.appendChild(out);
  card.appendChild(acts);
  sec.appendChild(card);
}

/** Sign out confirms with what happens. Focus starts on Cancel. */
export function confirmSignOut(a, h) {
  if (document.querySelector('.ac-dlg')) {
    return;
  }
  const back = document.activeElement;
  const wrap = el('div', 'end-dlg ac-dlg');
  const d = el('div', 'dlg');
  d.setAttribute('role', 'alertdialog');
  d.setAttribute('aria-modal', 'true');
  d.setAttribute('aria-labelledby', 'acOutT');
  d.insertAdjacentHTML('beforeend', icon('logout', 'ic'));
  const h4 = el('h4', null, `Sign out of ${a.label}?`);
  h4.id = 'acOutT';
  d.appendChild(h4);
  d.appendChild(el('p', null, "CLIs running on its servers keep running; they're here again when you sign back in.")); // the design's 3d page (F13)
  const row = el('div', 'a');
  const cancel = el('button', 'cancel', 'Cancel');
  const out = el('button', 'primary', 'Sign out');
  row.append(cancel, out);
  d.appendChild(row);
  wrap.appendChild(d);
  document.body.appendChild(wrap);
  const close = () => {
    wrap.remove();
    if (back && back.isConnected) {
      back.focus();
    }
  };
  cancel.classList.add('rx-ring');
  cancel.focus();
  cancel.addEventListener('click', close);
  out.addEventListener('click', () => {
    close();
    h.signout(a.id);
  });
  wrap.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      close();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      cancel.classList.remove('rx-ring');
      (document.activeElement === out ? cancel : out).focus();
    }
  });
}

/** F13: one snackbar, inverse surface, 6 s, with ✕. o = { action: { label, fn }, ms, close: false } for
 *  3b's access notices (the approved one has an action and no ✕, 8 s). */
export function snackbar(text, o = {}) {
  document.querySelector('.ac-snack')?.remove();
  const s = el('div', 'ac-snack');
  s.setAttribute('role', 'status');
  s.appendChild(el('span', null, text));
  if (o.action) {
    const a = el('button', 'act', o.action.label);
    a.addEventListener('click', () => {
      s.remove();
      o.action.fn();
    });
    s.appendChild(a);
  }
  if (o.close !== false) {
    const x = el('button', 'x');
    x.setAttribute('aria-label', 'Dismiss');
    x.insertAdjacentHTML('beforeend', icon('close'));
    x.addEventListener('click', () => s.remove());
    s.appendChild(x);
  }
  document.body.appendChild(s);
  s.wbMs = o.ms || 6000;
  s.wbTimer = setTimeout(() => s.remove(), s.wbMs);
  return s;
}

/** The self-test's captures take a while on a loaded box: a snackbar on screen gets its full time again
 *  before each one, so a 900-wide retake still shows it. */
export function holdSnackbar() {
  const s = document.querySelector('.ac-snack');
  if (s && s.wbTimer) {
    clearTimeout(s.wbTimer);
    s.wbTimer = setTimeout(() => s.remove(), s.wbMs || 6000);
  }
}
