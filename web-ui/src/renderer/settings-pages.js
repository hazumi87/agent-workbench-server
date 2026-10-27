// Settings pages for mode A (the design notes F12; the design's step-2 design): Servers
// (This machine only), This machine (its default shell), Programs (the shipped five with switches),
// a program's page (default model, extra arguments, Installed on with This machine), and
// Notifications. Accounts (step 3a) lives in accounts-page.js, shown only with its module.

import { icon } from './m3-chrome.js';
import { brandMarkPath } from '../vendor/aurora/brand-marks/aurora-brand-marks.js';

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

export function markSvg(key, color) {
  const s = el('span', 'pg-mark');
  s.style.setProperty('--mk', color || 'var(--md-sys-color-on-surface-variant)');
  s.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="' + brandMarkPath(key) + '"/></svg>';
  return s;
}

function switchEl(on, label, disabled) {
  const b = el('button', 'pg-sw' + (on ? ' on' : ''));
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-checked', String(!!on));
  b.setAttribute('aria-label', label);
  if (disabled) {
    b.disabled = true;
  }
  return b;
}

function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) {
    return 'just now';
  }
  const m = Math.round(s / 60);
  return m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago';
}

export function modelLabel(p) {
  const f = p.schema && p.schema.model;
  if (!f) {
    return '';
  }
  const v = p.settings.model;
  const i = (f.options || []).indexOf(v);
  return i >= 0 && f.labels ? f.labels[i] : String(v || '');
}

// The one line under a program's name on the Programs list.
export function programSummary(p, machine) {
  if (p.error) {
    return "Couldn't load · " + p.error;
  }
  if (p.id === 'shell') {
    return machine ? machine.shell : 'Your shell';
  }
  // 0.12.4: "Installed · 0.9.1" beside the found ones, "Not installed" for the missing
  if (p.detected && p.detected.state === 'missing') {
    return 'Not installed';
  }
  const m = modelLabel(p);
  if (p.detected && p.detected.state === 'installed') {
    return 'Installed' + (p.detected.version ? ' · ' + p.detected.version : '') + (m ? ' · Default model: ' + m : '');
  }
  return m ? 'Default model: ' + m : '';
}

export function renderServers(sec, machine, go) {
  sec.textContent = '';
  const card = el('button', 'pg-card');
  card.dataset.go = 'machine';
  const web = !!globalThis.wb?.web;
  const host = typeof machine?.name === 'string' && machine.name.trim() ? machine.name : 'Host not reported';
  const t = el('div', 'pg-cardt', web ? 'This server' : 'This machine');
  const sub = el('div', 'pg-cards', web ? host + ' · Workbench engine' : machine ? machine.name + ' · ' + machine.os + ' · ' + machine.shell : '');
  const hint = el('div', 'pg-cardh', web ? 'Agents run on this server.' : "CLIs run here. You can choose the default shell on This machine's page.");
  card.append(t, sub, hint);
  card.insertAdjacentHTML('beforeend', icon('chevron_right', 'pg-chev'));
  card.addEventListener('click', () => go('machine'));
  sec.appendChild(card);
}

export function renderMachine(sec, machine, prefs, setPrefs) {
  sec.textContent = '';
  if (globalThis.wb?.web) {
    // machine:info supplies the serving hostname; browser OS/shell are not engine facts.
    const host = typeof machine?.name === 'string' && machine.name.trim() ? machine.name : 'Host not reported';
    sec.appendChild(el('div', 'lbl', 'Server host'));
    sec.appendChild(el('div', 'pg-sub', host));
    sec.appendChild(el('div', 'lbl', 'Workbench engine'));
    sec.appendChild(el('div', 'hint', 'Agents run on this server.'));
    return;
  }
  sec.appendChild(el('div', 'lbl', 'Default shell'));
  const inp = el('input');
  inp.type = 'text';
  inp.id = 'machineShell';
  inp.spellcheck = false;
  inp.autocomplete = 'off';
  inp.value = prefs.shell || '';
  inp.placeholder = machine ? machine.shell : '';
  inp.setAttribute('aria-label', 'Default shell');
  sec.appendChild(inp);
  sec.appendChild(el('div', 'hint', 'Leave empty to use ' + (machine ? machine.shell : 'the system shell') + '. New CLIs use it; open ones keep theirs.'));
  let t = null;
  inp.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => setPrefs({ shell: inp.value.trim() }), 400);
  });
}

export function renderPrograms(sec, list, machine, h) {
  sec.textContent = '';
  sec.appendChild(el('div', 'pg-sub', 'What the Workbench can run'));
  for (const p of list) {
    const row = el('div', 'pg-row' + (p.enabled ? '' : ' off'));
    row.dataset.id = p.id;
    const open = el('button', 'pg-open');
    open.setAttribute('aria-label', p.label + ', open its page');
    open.appendChild(markSvg(p.mark, p.color));
    const tx = el('span', 'pg-tx');
    const nm = el('b', null, p.label);
    nm.appendChild(el('span', 'pg-tag', p.shipped ? (globalThis.wb?.web ? 'Built in' : 'Shipped') : 'Yours'));
    const sum = el('small', null, programSummary(p, machine));
    if (p.resumeError) {
      // a package that says it can resume but can't: listed so, the reason on hover
      if (sum.textContent) {
        sum.appendChild(document.createTextNode(' · ')); // no stray dot when it's the only word
      }
      const cr = el('span', 'pg-cantresume', "Can't resume");
      cr.title = 'Its package says it can resume a conversation, but it has no way to.'; // the design 
      sum.appendChild(cr);
    }
    tx.append(nm, sum);
    // (a hosted engine opens no bare shell: the Shell row says so and has no switch; the check reads the engine's own capability, wb.web.capabilities)
    const noShell = p.id === 'shell' && !!globalThis.wb?.web?.capabilities && globalThis.wb.web.capabilities.bareShell() === false;
    if (globalThis.wb?.web) tx.append(el('small', 'pg-terminal', noShell ? 'Not available on this server.' : p.id === 'claude-code' || p.id === 'codex-cli' ? 'Opens in a room or as a terminal.' : 'Opens as a terminal.')); // Claude Code and Codex can join a room: every other program runs in Terminals
    open.appendChild(tx);
    // The whole row opens the program's page; only the switch toggles (the design, step 2).
    row.addEventListener('click', (e) => {
      if (!e.target.closest('.pg-sw')) {
        h.open(p.id);
      }
    });
    row.classList.add('linked');
    let ctl;
    let ib = null;
    if (p.detected && p.detected.state === 'missing' && p.install && h.install) {
      // 0.12.4: Install beside a missing vendor, on the right before the switch; the row still opens its page
      ib = el('button', 'm3-text pg-install-row', 'Install');
      ib.type = 'button';
      ib.addEventListener('click', (e) => {
        e.stopPropagation();
        h.install(p.id);
      });
    }
    if (p.id === 'shell') {
      ctl = noShell ? el('span', 'pg-always') : el('span', 'pg-always', 'Always on'); // every plain CLI runs your shell
    } else {
      ctl = switchEl(p.enabled, p.label + (p.enabled ? ' is on' : ' is off'), !!p.error);
      ctl.addEventListener('click', () => h.toggle(p.id, !p.enabled));
    }
    row.append(open, ...(ib ? [ib] : []), ctl);
    row.insertAdjacentHTML('beforeend', icon('chevron_right', 'pg-chev2'));
    sec.appendChild(row);
  }
}

/** The program page's line; the loader's reason stays in the log and on hover. */
export function cantResumeWords() {
  return "This program can't pick a conversation back up after a restart. Its package says it can, but the instructions for it are missing. Ask whoever made the package to fix it.";
}

export function renderProgram(sec, p, h) {
  sec.textContent = '';
  if (!p) {
    return;
  }
  if (p.resumeError) {
    const w = el('div', 'pg-cantresume-line');
    w.innerHTML = icon('history_toggle_off');
    w.appendChild(document.createTextNode(cantResumeWords()));
    w.title = p.resumeError;
    sec.appendChild(w);
  }
  const schema = p.schema || {};
  if (schema.model) {
    const f = schema.model;
    sec.appendChild(el('div', 'lbl', f.label || 'Default model'));
    const sel = el('select');
    sel.id = 'progModel';
    sel.setAttribute('aria-label', f.label || 'Default model');
    (f.options || []).forEach((o, i) => {
      const op = el('option', null, (f.labels && f.labels[i]) || o);
      op.value = o;
      sel.appendChild(op);
    });
    const other = el('option', null, 'Other…');
    other.value = '__other';
    sel.appendChild(other);
    const known = (f.options || []).includes(p.settings.model);
    sel.value = known ? p.settings.model : '__other';
    const oth = el('input', 'mono');
    oth.type = 'text';
    oth.id = 'progModelOther';
    oth.spellcheck = false;
    oth.placeholder = 'Model name';
    oth.setAttribute('aria-label', 'Model name');
    oth.value = known ? '' : p.settings.model || '';
    oth.hidden = known;
    sel.addEventListener('change', () => {
      oth.hidden = sel.value !== '__other';
      if (sel.value !== '__other') {
        h.set(p.id, { model: sel.value });
      } else {
        oth.focus();
      }
    });
    let t = null;
    oth.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => oth.value.trim() && h.set(p.id, { model: oth.value.trim() }), 400);
    });
    sec.append(sel, oth);
  }
  if (schema.extraArgs) {
    const f = schema.extraArgs;
    sec.appendChild(el('div', 'lbl sp1', f.label || 'Extra arguments'));
    const a = el('input', 'mono');
    a.type = 'text';
    a.id = 'progArgs';
    a.spellcheck = false;
    a.value = p.settings.extraArgs || '';
    a.placeholder = '--verbose';
    a.setAttribute('aria-label', f.label || 'Extra arguments');
    let t = null;
    a.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => h.set(p.id, { extraArgs: a.value }), 400);
    });
    sec.append(a, el('div', 'hint', 'Added to every launch.'));
  }
  if (p.binary) {
    sec.appendChild(el('div', 'lbl sp1', 'Installed on'));
    const line = el('div', 'pg-inst');
    const d = p.detected;
    const who = el('div', 'pg-who');
    who.appendChild(el('div', 'pg-where', 'This machine'));
    let what = 'Checking…';
    if (d && d.state === 'installed') {
      const untested = p.verifiedWith && d.version && !d.version.startsWith(p.verifiedWith) ? ' · untested with ' + d.version : '';
      what = (d.version || 'installed') + ' · checked ' + ago(d.at) + untested;
    } else if (d && d.state === 'missing') {
      what = 'not installed';
    } else if (d && d.state === 'unknown') {
      what = "couldn't check";
    }
    who.appendChild(el('div', 'pg-what', what));
    line.appendChild(who);
    const again = el('button', 'pg-again', 'Check again');
    again.addEventListener('click', () => h.detect(p.id));
    line.appendChild(again);
    sec.appendChild(line);
    if (d && d.state === 'missing' && p.install && h.install) {
      // 0.12.4: Install runs the vendor's command in a visible pane; the command is shown first, never run silently
      const inst = el('div', 'pg-install');
      inst.appendChild(el('div', 'hint', 'Install opens a pane with this command typed, waiting for your Enter: ' + p.install));
      const b = el('button', 'tonal pg-install-btn', 'Install');
      b.addEventListener('click', () => h.install(p.id));
      inst.appendChild(b);
      sec.appendChild(inst);
    }
    if (!d) {
      h.detect(p.id);
    }
  }
}

export function renderNotifications(sec, prefs, setPrefs, platform) {
  if (globalThis.wb?.web?.notifications) return globalThis.wb.web.notifications.render(sec, prefs, setPrefs);
  sec.textContent = '';
  const n = prefs.notify || { flash: true, toast: false };
  sec.appendChild(el('div', 'pg-sub', "When a CLI needs you and the Workbench isn't in front"));
  const row = (key, label, hint) => {
    const r = el('div', 'pg-row');
    const tx = el('span', 'pg-tx');
    tx.appendChild(el('b', null, label));
    if (hint) {
      tx.appendChild(el('small', null, hint));
    }
    const sw = switchEl(!!n[key], label);
    sw.id = 'notify-' + key;
    sw.addEventListener('click', () => setPrefs({ notify: { ...n, [key]: !n[key] } }));
    r.append(tx, sw);
    sec.appendChild(r);
  };
  row('flash', 'Flash the taskbar button', '');
  row('toast', platform === 'win32' ? 'Show a Windows notification' : 'Show a notification', "One per CLI, with its name and where it runs. Never what's in the terminal.");
}

// About: version, Updates (Check for updates, its status line, Check automatically),
// the privacy line and the licenses. Before step 3a there is no feed: the button and the switch are
// hidden, not disabled, and a line says to install by hand.
// st = { version, available, auto, checking, last: { state, version, at, why }, progress, ready }
export function renderAbout(sec, st, h) {
  sec.textContent = '';
  const head = el('div', 'ab-head');
  head.appendChild(el('div', 'ab-name', 'Agent Workbench'));
  const ver = el('div', 'ab-ver', 'Version ' + st.version);
  ver.id = 'aboutVersion';
  head.appendChild(ver);
  sec.appendChild(head);
  sec.appendChild(el('div', 'lbl sp1', 'Updates'));
  if (!st.available) {
    const line = el('div', 'ab-status');
    line.id = 'aboutStatus';
    line.innerHTML = icon('info');
    line.appendChild(el('span', null, globalThis.wb?.web ? "Whoever runs this server installs updates." : "Updates aren't available in this version yet. Install new versions by hand for now."));
    sec.appendChild(line);
  } else {
    const btn = el('button', 'ab-check', st.checking ? 'Checking…' : 'Check for updates');
    btn.id = 'aboutCheck';
    btn.disabled = !!st.checking;
    btn.addEventListener('click', () => h.check());
    sec.appendChild(btn);
    const line = el('div', 'ab-status');
    line.id = 'aboutStatus';
    const say = (ic, text, cls) => {
      line.innerHTML = ic ? icon(ic) : '';
      line.appendChild(el('span', null, text));
      if (cls) {
        line.classList.add(cls);
      }
    };
    const last = st.last;
    if (st.ready) {
      say('', 'Version ' + st.ready.version + ' is ready.');
      const go = el('button', 'ab-restart', 'Restart to update');
      go.id = 'aboutRestart';
      go.addEventListener('click', () => h.restart());
      line.appendChild(go);
    } else if (st.progress) {
      say('', 'Downloading version ' + st.progress.version + '…');
      const bar = el('div', 'ab-bar');
      const fill = el('div', 'ab-fill');
      fill.style.width = st.progress.total ? Math.round((100 * st.progress.got) / st.progress.total) + '%' : '30%';
      bar.appendChild(fill);
      line.appendChild(bar);
      line.classList.add('stack');
    } else if (last && last.state === 'up-to-date') {
      const d = new Date(last.at);
      const today = d.toDateString() === new Date().toDateString();
      say('check_circle', "You're up to date. Checked " + (today ? 'at ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'on ' + d.toLocaleDateString()) + '.');
    } else if (last && last.state === 'sig-failed') {
      say('error', (last.version ? 'Version ' + last.version : 'An update') + " didn't pass its signature check, so it wasn't installed.", 'bad');
    } else if (last && last.state === 'error') {
      say('cloud_off', "Couldn't check for updates. Try again later.");
    }
    sec.appendChild(line);
    const row = el('div', 'pg-row ab-auto');
    const tx = el('span', 'pg-tx');
    tx.appendChild(el('b', null, 'Check automatically'));
    tx.appendChild(el('small', null, 'Checks when the Workbench starts and once a day.'));
    const sw = switchEl(st.auto, 'Check automatically');
    sw.id = 'aboutAuto';
    sw.addEventListener('click', () => h.auto(!st.auto));
    row.append(tx, sw);
    sec.appendChild(row);
  }
  sec.appendChild(el('div', 'hint ab-privacy', globalThis.wb?.web ? 'A check only downloads the list of versions. It sends nothing about you or this server.' : 'A check only downloads the list of versions. It sends nothing about you or this computer.'));
  const lic = el('button', 'ab-link', 'Open-source licenses');
  lic.id = 'aboutLicenses';
  lic.addEventListener('click', () => h.licenses());
  sec.appendChild(lic);
}

// App tone painting is not installed in the web pilot. Hide the desktop entry
// until it has a real web consumer; a synthetic click cannot open it either.
export function configureAppsLink(button, web, open) {
  button.hidden = web === true;
  button.addEventListener('click', () => { if (web !== true) open('apps'); });
}
