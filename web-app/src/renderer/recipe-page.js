// The recipe form (F4; the design's step-3c page, aurora <commit>; words from her tables). A page in the
// settings sheet, breadcrumb Recipes › New recipe (editing: Recipes › site). The fields go in the order
// a person thinks: Name · Runs on · Folder (checked as that login) · Set up this folder · Run (the
// program) · Options for that program · Color · [Cancel] [Save]. Saving never refuses: a failed check
// shows beside its field and Save becomes Save anyway. 0.12.1:
// This machine is first and the default (a recipe there is a plain pane, ends with the Workbench), the Run
// list carries the local report and ends with Custom command…, a Command field and no Options for it.

import { starterStatus } from './starter-agents.js';
import { icon } from './m3-chrome.js';
import { markSvg } from './settings-pages.js';
import {renderParityFields} from './recipe-parity-controls.js';

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

const REPORT_FRESH_MS = 10 * 60 * 1000;

/** The folder as the person typed it, cleaned the way the page says (the store's rule, mirrored here so
 *  the check and the field show the clean value): trailing slash, spaces, a pasted `login@host:` prefix. */
export function normalizeFolder(raw) {
  let f = String(raw == null ? '' : raw).trim();
  f = f.replace(/^[A-Za-z0-9._-]+@[A-Za-z0-9.:_-]+:/, '');
  f = f.replace(/[\\/]+$/, '');
  return f === '' || f === '~' ? '~' : f.slice(0, 300);
}

function agoText(t) {
  const d = Math.max(0, Date.now() - t);
  const m = Math.round(d / 60000);
  if (m < 1) {
    return 'just now';
  }
  if (m < 60) {
    return m + ' min ago';
  }
  const h = Math.round(m / 60);
  if (h < 48) {
    return h + ' h ago';
  }
  return Math.round(h / 24) + ' d ago';
}

/** The Run picker's second line for a program on the chosen login (the design's Run picker table). */
export function reportLine(p, row) {
  if (!row) {
    return { text: '', kind: 'none' };
  }
  if (row.local) {
    // This machine: what the Workbench's own detect found ("2.1.3" / "Not found on this computer")
    const d = p.detected || null;
    if (!d) {
      return { text: 'Not checked yet', kind: 'unknown' };
    }
    if (d.state === 'missing') {
      return { text: 'Not installed', kind: 'missing' }; // 0.12.4
    }
    if (d.state === 'unknown') {
      return { text: `Couldn't check on ${(globalThis.wb && globalThis.wb.web ? 'this server' : 'this computer')}`, kind: 'unknown' };
    }
    return { text: d.version || 'installed', kind: 'installed' };
  }
  const rep = (row.programs || []).find((x) => x.id === p.id);
  const brokerUp = !(row.state === 'broker-down' || row.state === 'identity');
  if (!rep) {
    return { text: `Couldn't check on ${row.serverName}`, kind: 'unknown' };
  }
  if (rep.state === 'missing') {
    return { text: `Not found on ${row.serverName} for ${row.login}`, kind: 'missing' };
  }
  if (rep.state === 'unknown') {
    return { text: `Couldn't check on ${row.serverName}`, kind: 'unknown' };
  }
  const v = rep.version || 'installed';
  const fresh = brokerUp && Date.now() - rep.at < REPORT_FRESH_MS;
  return fresh ? { text: v, kind: 'installed' } : { text: `${v} · last checked ${agoText(rep.at)}`, kind: 'old' };
}

/** The page's custom list (p1/p2): a field that opens a list of rows under it, each with a mark or a dot,
 *  a name and a second line; the closed field shows only the chosen name, with supporting text under it.
 *  Keyboard: Up/Down move, Enter or Space pick, Esc closes and returns to the field. */
function pickField({ id, label, valueText, placeholder, support, rows, footer, onPick, disabled, hint }) {
  const wrap = el('div', 'ac-of rf-pick');
  const lab = el('label', null, label);
  lab.htmlFor = id;
  const btn = el('button', 'rf-pick-btn');
  btn.type = 'button';
  btn.id = id;
  btn.disabled = !!disabled;
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  btn.appendChild(el('span', 'v' + (valueText ? '' : ' plh'), valueText || placeholder || ''));
  btn.insertAdjacentHTML('beforeend', icon('arrow_drop_down', 'rq-dd'));
  wrap.append(lab, btn);
  if (hint) {
    wrap.appendChild(el('div', 'ac-sup', hint));
  } else if (support) {
    wrap.appendChild(el('div', 'ac-sup', support));
  }
  const list = el('div', 'rf-list');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-labelledby', id);
  list.hidden = true;
  const items = [];
  for (const r of rows) {
    const row = el('div', 'rf-row' + (r.selected ? ' on' : '') + (r.dim ? ' dim' : '') + (r.link ? ' link' : ''));
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(!!r.selected));
    row.tabIndex = -1;
    row.dataset.value = r.value;
    if (r.mark) {
      const m = el('span', 'sic');
      m.appendChild(markSvg(r.mark, r.markColor || null));
      row.appendChild(m);
    } else if (r.dot) {
      row.appendChild(el('span', 'dot ' + r.dot));
    } else if (r.link) {
      row.insertAdjacentHTML('beforeend', icon('add', 'rf-add'));
    }
    const tx = el('div', 'tx');
    tx.appendChild(el('div', 't', r.text));
    if (r.line) {
      tx.appendChild(el('div', 's', r.line));
    }
    row.appendChild(tx);
    if (r.action) {
      const a = el('button', 'm3-text rf-act', r.action.label);
      a.type = 'button';
      a.addEventListener('click', (e) => {
        e.stopPropagation();
        r.action.fn();
      });
      row.appendChild(a);
    }
    list.appendChild(row);
    items.push(row);
  }
  if (footer) {
    const f = el('div', 'rf-foot');
    f.append(footer.text + ' ');
    const a = el('button', 'sv-link', footer.link);
    a.type = 'button';
    a.addEventListener('click', (e) => {
      e.stopPropagation();
      close();
      footer.fn();
    });
    f.appendChild(a);
    list.appendChild(f);
  }
  wrap.appendChild(list);
  let outside = null;
  const close = (back) => {
    list.hidden = true;
    wrap.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    if (outside) {
      document.removeEventListener('pointerdown', outside, true);
      outside = null;
    }
    if (back) {
      btn.focus();
    }
  };
  const open = () => {
    list.hidden = false;
    wrap.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    const cur = items.find((x) => x.classList.contains('on')) || items[0];
    if (cur) {
      cur.focus();
    }
    outside = (e) => {
      if (!wrap.contains(e.target)) {
        close(false);
      }
    };
    document.addEventListener('pointerdown', outside, true);
  };
  btn.addEventListener('click', () => (list.hidden ? open() : close(true)));
  const pick = (row) => {
    close(true);
    onPick(row.dataset.value);
  };
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.rf-row');
    if (row) {
      pick(row);
    }
  });
  list.addEventListener('keydown', (e) => {
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const n = i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      items[n].focus();
    } else if ((e.key === 'Enter' || e.key === ' ') && i >= 0) {
      pick(items[i]);
    } else if (e.key === 'Escape') {
      close(true);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  });
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && list.hidden) {
      e.preventDefault();
      open();
    }
  });
  return wrap;
}

/**
 * st: { id, name, loginId, folder, programId, options, color, dirty, saveAnyway,
 *       check: { state: 'idle'|'checking'|'found'|'missing'|'unknown', folder },
 *       setup: { state: 'idle'|'running'|'ready'|'failed', why } }
 * ctx: { servers (the account's granted rows), programs (programs:list), hues (the eight swatches) }
 * h: { set(field, value), checkFolder(), setup(), save(), cancel(), requestAccess(), openPrograms(),
 *      installHelp(programId), seedColor(hue) → css color }
 */
export function renderRecipe(sec, st, ctx, h) {
  sec.textContent = '';
  if(st.unavailableTarget)sec.append(el('p','rq-line',`${st.name} needs a server connection, which this version does not have, so it can't start.`));
  const rows = (ctx.servers || []).filter((r) => !r.request && !r.keysOnly);
  const machine = ctx.machine || {};
  const osWord = machine.os || ''; // the host's own word, never guessed from the browser (the web build runs on a server whose OS the page cannot see)
  const win = osWord === 'Windows';
  const LOCAL = { loginId: 'local', serverName: (globalThis.wb && globalThis.wb.web ? 'this server' : 'this computer'), login: '', local: true, shell: machine.shell || '' };
  // a login asked for from this form (the design's No dead ends): the recipe saves now and starts once approved
  const pending = st.loginId && st.loginId !== 'local' ? (ctx.servers || []).find((r) => r.request && r.loginId === st.loginId) || null : null;
  const row = st.loginId === 'local' ? LOCAL : rows.find((r) => r.loginId === st.loginId) || pending || null;
  const programs = (ctx.programs || []).filter((p) => p.enabled);
  const offCount = (ctx.programs || []).filter((p) => !p.enabled).length;
  const CUSTOM = { id: 'custom', label: 'Custom command', mark: 'generic', color: null, enabled: true, custom: true };
  const program = st.programId === 'custom' ? CUSTOM : (ctx.programs || []).find((p) => p.id === st.programId) || null;
  const exampleFolder = win ? 'C:\\Code\\site' : '~/code/site';

  // Name
  const nf = el('div', 'ac-of');
  const nl = el('label', null, 'Name');
  nl.htmlFor = 'rfName';
  const name = el('input');
  name.id = 'rfName';
  name.type = 'text';
  name.maxLength = 60;
  name.value = st.name || '';
  name.setAttribute('aria-describedby', 'rfName-sup');
  name.addEventListener('input', () => h.set('name', name.value));
  const nsup = el('div', 'ac-sup', "Leave empty to use the folder's name");
  nsup.id = 'rfName-sup';
  nf.append(nl, name, nsup);

  // Runs on: This machine first and the default ("Windows · ends when the Workbench closes"), then the
  // server · login pairs with their 3b status word (dot + word in the rows, never in the value), then
  // Request access…; standalone, the servers give way to "Servers come with an account. Sign in…"
  const sv = pickField({
    id: 'rfRunsOn',
    label: 'Runs on',
    valueText: row ? (row.local ? (globalThis.wb && globalThis.wb.web ? 'This server' : 'This machine') : `${row.serverName} · ${row.login}`) : '',
    placeholder: 'Choose where it runs',
    rows: [globalThis.wb && globalThis.wb.web
      ? { value: 'local', text: 'This server', line: 'Keeps running on the server', selected: st.loginId === 'local' } // the web build: the engine runs it, and it outlives this page
      : { value: 'local', text: 'This machine', line: `${osWord} · ends when the Workbench closes`, selected: st.loginId === 'local' }]
      .concat(rows.map((r) => ({ value: r.loginId, text: `${r.serverName} · ${r.login}`, line: r.line, dot: r.dot || null, selected: r.loginId === st.loginId })))
      .concat(ctx.signedIn ? [{ value: '__request', text: 'Request access…', link: true }] : []),
    footer: ctx.signedIn ? null : { text: 'Servers come with an account.', link: 'Sign in…', fn: () => h.signIn && h.signIn() },
    onPick: (v) => (v === '__request' ? h.requestAccess() : h.set('loginId', v)),
    hint: pending ? "Waiting for the admin's approval. The recipe saves now and starts once it's approved." : row && !row.local && (row.state === 'broker-down' || row.state === 'identity') ? `${row.serverName}'s broker for ${row.login} isn't running. The recipe saves, but it can't start until the broker is back.` : '',
  });

  // Folder, checked as the chosen login when the field loses focus
  const ff = el('div', 'ac-of');
  const fl = el('label', null, row && !row.local ? `Folder on ${row.serverName}` : 'Folder');
  fl.htmlFor = 'rfFolder';
  const folder = el('input', 'mono');
  folder.id = 'rfFolder';
  folder.type = 'text';
  folder.spellcheck = false;
  folder.maxLength = 300;
  folder.value = st.folder === '~' && !st.folderTyped ? '' : st.folder || '';
  folder.placeholder = row?.local ? 'No folder chosen' : '~/site';
  folder.readOnly = !!row?.local;
  if(row?.local)folder.setAttribute('aria-readonly','true');
  folder.setAttribute('aria-describedby', 'rfFolder-sup');
  if(!row?.local){folder.addEventListener('input', () => h.set('folder', folder.value));folder.addEventListener('blur', () => h.checkFolder());}
  const agentsDefault = !st.id && st.loginId === 'local' && !st.folderTyped && !!folder.value;
  folder.title = folder.value;
  const fsup = el('div', 'ac-sup', agentsDefault ? (st.folderRole === 'concierge' ? "The Concierge's own folder, unless you choose another." : 'Your agents folder, unless you choose another.') : row ? (row.local ? `On this computer. Like ${exampleFolder}` : `On ${row.serverName}. Like /home/agent/site`) : 'Like ~/site');
  fsup.id = 'rfFolder-sup';
  ff.append(fl, folder, fsup);
  if(row?.local){
    const actions=el('div','ac-acts start rf-folder-actions');
    for(const [mode,words]of [['choose','Choose folder…'],['create','Create new folder…']]){
      const button=el('button','ac-btn tonal',words);button.type='button';
      button.disabled=st.saving===true||st.folderPickerState?.ready!==true||st.folderPickerState?.busy===true;
      button.addEventListener('click',()=>{if(!button.disabled)h.pickFolder?.(mode);});actions.appendChild(button);
    }
    ff.append(actions,el('div','ac-sup',"Create new folder: you'll name it in the next window."));
    if(st.folderPickerState?.error){const error=el('div','ac-sup rf-folder-error',"Couldn't open the folder picker. Try again.");error.setAttribute('role','status');ff.appendChild(error);}
  }
  const ck = st.check || { state: 'idle' };
  if(ck.state==='missing')ff.classList.add('err');
  if (ck.state !== 'idle' && row) {
    const line = el('div', 'rf-check ' + ck.state);
    if (ck.state === 'checking') {
      line.insertAdjacentHTML('beforeend', icon('progress_activity'));
      line.appendChild(el('span', null, 'Checking…'));
    } else if (ck.state === 'found') {
      line.insertAdjacentHTML('beforeend', icon('check_circle'));
      line.appendChild(el('span', null, row.local ? `Found on ${(globalThis.wb && globalThis.wb.web ? 'this server' : 'this computer')}.` : `Found on ${row.serverName}.`));
    } else if (ck.state === 'missing') {
      line.insertAdjacentHTML('beforeend', icon('error'));
      line.appendChild(el('span', null, row.local ? `Not found on ${(globalThis.wb && globalThis.wb.web ? 'this server' : 'this computer')}. Choose another folder.` : `Not found on ${row.serverName}.`));
    } else {
      line.insertAdjacentHTML('beforeend', icon('help'));
      line.appendChild(el('span', null, row.local ? "Couldn't check this folder." : `Couldn't check: ${row.serverName} didn't answer.`));
    }
    ff.appendChild(line);
  }
  // Set up this folder: only when the program has prepare and the folder was found; never run by Save
  if (program && program.prepare && ck.state === 'found' && !row.local) {
    const su = st.setup || { state: 'idle' };
    const wrap = el('div', 'rf-setup');
    if (su.state === 'running') {
      wrap.appendChild(el('div', 'ac-sup', 'Setting up…'));
    } else if (su.state === 'ready') {
      // "Ready: …" (the design : no Details on success); what changed, in plain words, rides as the
      // line's tooltip
      const r = el('div', 'rf-check found');
      r.insertAdjacentHTML('beforeend', icon('check_circle'));
      r.appendChild(el('span', null, `Ready: ${program.label} won't ask its first-run questions here.`));
      // the design : "Marked ~/site as trusted for Claude Code in ~/.claude.json. Nothing else changed."
      r.title = /^Already set up/.test(su.output || '') ? `Already set up: ${st.folder} is trusted for ${program.label} in ~/.claude.json. Nothing changed.` : `Marked ${st.folder} as trusted for ${program.label} in ~/.claude.json. Nothing else changed.`;
      wrap.appendChild(r);
    } else {
      const b = el('button', 'ac-btn o');
      b.insertAdjacentHTML('beforeend', icon('build'));
      b.appendChild(el('span', null, `Set up this folder for ${program.label}`));
      b.addEventListener('click', () => h.setup());
      wrap.appendChild(b);
      if (su.state === 'failed') {
        const f = el('div', 'rf-check missing');
        f.insertAdjacentHTML('beforeend', icon('error'));
        f.appendChild(el('span', null, `Couldn't set up ${st.folder}. `));
        const d = el('button', 'sv-link', su.open ? 'Hide details' : 'Details');
        d.type = 'button';
        d.addEventListener('click', () => h.setupDetails && h.setupDetails());
        f.appendChild(d);
        wrap.appendChild(f);
        if (su.open) {
          wrap.appendChild(el('pre', 'rf-out', [su.why, su.output].filter(Boolean).join('\n').trim() || 'No output.'));
        }
      }
    }
    ff.appendChild(wrap);
  }

  // Run: the picker, only the programs that are on; installed first, then the rest in Programs' order,
  // Shell always last with the login's shell; each row with what the chosen login's broker reported;
  // the closed field shows the name, the report as supporting text ("2.1.303 on Brokered")
  const withLines = programs.map((p) => ({ p, line: reportLine(p, row) }));
  const order = (x) => (x.p.id === 'shell' ? 3 : x.line.kind === 'installed' || x.line.kind === 'old' ? 0 : x.line.kind === 'unknown' ? 1 : 2);
  withLines.sort((a, b) => order(a) - order(b));
  const shellName = (row && row.shell) || (row && row.test && row.test.shell) || '';
  const chosenLine = program && row && !program.custom ? reportLine(program, row) : { text: '', kind: 'none' };
  const rf = pickField({
    id: 'rfRun',
    label: 'Run',
    disabled: !row,
    valueText: program ? (program.id === 'shell' ? 'Shell' : program.label) : '',
    placeholder: 'Choose a program',
    support: !row ? '' : program && program.custom ? 'Runs in your shell, in this folder' : program && program.id === 'shell' ? shellName : chosenLine.kind === 'installed' || chosenLine.kind === 'old' ? `${chosenLine.text} on ${row.serverName}` : chosenLine.kind === 'unknown' ? chosenLine.text : '',
    hint: !row ? 'Choose where it runs first.' : '',
    rows: withLines
      .map(({ p, line }) => ({
        value: p.id,
        text: p.id === 'shell' ? 'Shell' : p.shipped === false ? `${p.label} · Yours` : p.label,
        line: p.id === 'shell' ? shellName || (row && row.local ? 'your shell' : "the login's shell") : line.text,
        mark: p.mark || 'generic',
        markColor: p.color || null,
        dim: line.kind === 'missing',
        selected: p.id === st.programId,
        // 0.12.4: a missing vendor's row keeps a trailing [Install] on this computer
        action: line.kind === 'missing' && row && row.local && p.install && h.install ? { label: 'Install', fn: () => h.install(p.id) } : null,
      }))
      // Custom command… last: anything you'd type yourself, in your shell, in that folder
      .concat([{ value: 'custom', text: 'Custom command…', line: "Anything you'd type yourself", mark: 'generic', markColor: null, selected: st.programId === 'custom' }]),
    footer: offCount ? { text: "Programs that are off aren't listed.", link: 'Programs…', fn: () => h.openPrograms() } : null,
    onPick: (v) => h.set('programId', v),
  });
  if (row && program && !program.custom && program.id !== 'shell' && chosenLine.kind === 'missing') {
    // 0.12.4: choosing a missing vendor shows the missing card below, starting nothing
    const m = el('div', 'ac-sup rf-missing');
    if (row.local) {
      m.append(`${program.label} isn't installed on ${(globalThis.wb && globalThis.wb.web ? 'this server' : 'this computer')}. This recipe needs it. Install it here, then the recipe starts. `);
      if (program.install && h.install) {
        const a = el('button', 'sv-link', 'Install');
        a.type = 'button';
        a.addEventListener('click', () => h.install(program.id));
        m.appendChild(a);
      } else {
        const a = el('button', 'sv-link', 'How to install');
        a.type = 'button';
        a.addEventListener('click', () => h.installHelp(program.id));
        m.appendChild(a);
      }
    } else {
      m.append(`${program.label} isn't installed on ${row.serverName}. Ask ${row.serverName}'s admin to install it.`);
    }
    rf.appendChild(m);
  }

  // Custom command (0.12.1): the Command field, mono, with the design's hint; no Options section for it
  let cmdField = null;
  if (program && program.custom) {
    cmdField = el('div', 'ac-of');
    const cl2 = el('label', null, 'Command');
    cl2.htmlFor = 'rfCommand';
    const ci = el('input', 'mono');
    ci.id = 'rfCommand';
    ci.type = 'text';
    ci.spellcheck = false;
    ci.maxLength = 500;
    ci.value = st.command || '';
    ci.setAttribute('aria-describedby', 'rfCommand-sup');
    ci.addEventListener('input', () => h.set('command', ci.value));
    const cs = el('div', 'ac-sup', `Runs in your shell, in this folder. Like npm run dev or ${win ? '.\\build.ps1' : './build.sh'}`);
    cs.id = 'rfCommand-sup';
    cmdField.append(cl2, ci, cs);
  }

  // Options for <Program>: each field from the schema, the default as a placeholder, reset when changed
  const opts = el('div', 'rf-opts');
  const parity=renderParityFields({doc:document,state:st,handlers:h});
  let effortPlaced=false;
  if (program && program.schema && Object.keys(program.schema).length) {
    opts.appendChild(el('div', 'lbl', `Options for ${program.label}`));
    const schema = program.schema;
    const cur = st.options || {};
    for (const [key, f] of Object.entries(schema)) {
      if(st.parityEnabled===true&&key==='effort')continue;
      if (f.type === 'secret') {
        continue; // a secret field is never on a recipe
      }
      if(parity?.effort&&!effortPlaced&&key!=='model'){opts.appendChild(parity.effort);effortPlaced=true;}
      const of = el('div', 'ac-of rf-opt' + (f.type === 'choice' ? ' rq-sel' : ''));
      const lab = el('label', null, key === 'model' ? 'Model' : f.label || key); // "Model" on a recipe
      lab.htmlFor = 'rfOpt-' + key;
      of.appendChild(lab);
      const dflt = (program.settings && program.settings[key] != null ? program.settings[key] : f.default) || '';
      const dfltLabel = f.type === 'choice' && f.labels && f.options ? f.labels[f.options.indexOf(dflt)] || dflt : dflt;
      let input;
      if (f.type === 'choice') {
        const set = cur[key] != null && (f.options || []).includes(cur[key]);
        const field = pickField({
          id: 'rfOpt-' + key,
          label: key === 'model' ? 'Model' : f.label || key,
          valueText: set ? (f.labels && f.labels[(f.options || []).indexOf(cur[key])]) || cur[key] : '',
          placeholder: dfltLabel ? `Default: ${dfltLabel}` : 'Default',
          rows: (f.options || []).map((o, i) => ({ value: o, text: (f.labels && f.labels[i]) || o, selected: cur[key] === o })),
          onPick: (v) => h.set('options', { ...cur, [key]: v || undefined }),
        });
        field.classList.add('rf-opt');
        if (set) {
          const reset = el('button', 'rail-ib rf-reset');
          reset.type = 'button';
          reset.title = 'Reset to default';
          reset.setAttribute('aria-label', 'Reset to default');
          reset.innerHTML = icon('restart_alt');
          reset.addEventListener('click', () => h.set('options', { ...cur, [key]: undefined }));
          field.appendChild(reset);
        }
        opts.appendChild(field);
        continue;
      } else {
        input = el('input', f.type === 'args' ? 'mono' : '');
        input.type = 'text';
        input.spellcheck = false;
        input.value = cur[key] != null ? String(cur[key]) : '';
        input.placeholder = dflt ? `Default: ${dfltLabel}` : '';
        input.addEventListener('input', () => h.set('options', { ...cur, [key]: input.value || undefined }));
      }
      input.id = 'rfOpt-' + key;
      of.appendChild(input);
      if (f.type === 'choice') {
        of.insertAdjacentHTML('beforeend', icon('arrow_drop_down', 'rq-dd'));
      }
      if (cur[key] != null && cur[key] !== '') {
        const reset = el('button', 'rail-ib rf-reset');
        reset.title = 'Reset to default';
        reset.setAttribute('aria-label', 'Reset to default');
        reset.innerHTML = icon('restart_alt');
        reset.addEventListener('click', () => h.set('options', { ...cur, [key]: undefined }));
        of.appendChild(reset);
      }
      if (f.type === 'args') {
        of.appendChild(el('div', 'ac-sup', "Added after the program's own arguments, like --verbose"));
      }
      opts.appendChild(of);
    }
  }
  if(parity?.effort&&!effortPlaced)opts.appendChild(parity.effort);

  // Color: eight swatches, Auto first
  const cl = el('div', 'lbl', 'Color');
  const sw = el('div', 'rf-swatches');
  sw.setAttribute('role', 'radiogroup');
  sw.setAttribute('aria-label', 'Color');
  const auto = el('button', 'rf-sw auto' + (st.color === 'auto' || st.color == null ? ' on' : ''));
  auto.type = 'button';
  auto.title = 'Auto';
  auto.setAttribute('role', 'radio');
  auto.setAttribute('aria-checked', String(st.color === 'auto' || st.color == null));
  auto.textContent = 'Auto';
  auto.addEventListener('click', () => h.set('color', 'auto'));
  sw.appendChild(auto);
  for (const hue of ctx.hues || []) {
    const b = el('button', 'rf-sw' + (st.color === hue ? ' on' : ''));
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(st.color === hue));
    b.setAttribute('aria-label', 'Hue ' + hue);
    b.style.background = h.seedColor(hue);
    b.addEventListener('click', () => h.set('color', hue));
    sw.appendChild(b);
  }

  // [Cancel] [Save] / [Save anyway]
  const acts = el('div', 'ac-acts rf-acts');
  const cancel = el('button', 'ac-btn t', 'Cancel');
  cancel.addEventListener('click', () => h.cancel());
  const save = el('button', 'ac-btn f');
  save.id = 'rfSave';
  save.insertAdjacentHTML('beforeend', icon('save'));
  save.appendChild(el('span', null, st.saveAnyway ? 'Save anyway' : 'Save'));
  save.disabled = !!st.saving || !!st.logoBusy || (row?.local&&st.folderPickerState&&st.folderPickerState.ready!==true) || !!st.folderPickerState?.busy || !row || !program || (program.custom && !String(st.command || '').trim());
  save.addEventListener('click', () => h.save());
  acts.append(cancel, save);

  sec.append(nf, sv, ff, rf, ...(cmdField ? [cmdField] : []), opts, ...(parity?[parity.worktree,parity.identity]:[]), cl, sw, ...(parity?[parity.appearance]:[]), acts);
  // Enter in a text field saves
  for (const i of sec.querySelectorAll('input[type=text]')) {
    i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !save.disabled) {
        e.preventDefault();
        h.save();
      }
    });
  }
}

/** The Recipes page (the breadcrumb's root): the same rows as the rail, each opening its form. */
export function renderRecipesList(sec, rows, h) {
  sec.textContent = '';
  if(h.importRecipes){const button=el('button','ri-button','Import recipes…');button.addEventListener('click',h.importRecipes);sec.append(button,el('p','rq-line','Add recipes from a file someone gave you or that you exported.'));}
  const starter = starterStatus(h.starterAgents);
  if (starter) {
    const status = el('p', 'rq-line', starter.text);
    status.setAttribute('role', 'status');
    sec.appendChild(status);
    if (starter.restore && h.restoreStarters) {
      const restore = el('button', 'ri-button', 'Restore missing starter files');
      restore.disabled = !!h.restoringStarters;
      restore.addEventListener('click', h.restoreStarters);
      sec.appendChild(restore);
    }
  }
  for (const name of h.skippedRecipes || []) {
    const status = el('div', 'rq-line rf-local-sync-status', `“${name}” wasn’t updated in local rooms because its program isn’t supported. Choose another program in this recipe.`);
    status.setAttribute('role', 'status');
    sec.appendChild(status);
  }
  if (!rows.length) {
    sec.appendChild(el('div', 'rq-line', 'Recipes start a program in a folder with one click.'));
  }
  for (const v of rows) {
    const card = el('button', 'pg-card rf-card');
    card.dataset.recipe = v.id;
    const head = el('div', 'pg-cardt');
    if(v.logo){const logo=el('img','');logo.src=v.logo;logo.alt='';logo.width=24;logo.height=24;head.appendChild(logo);}else head.appendChild(markSvg(v.mark || 'generic', v.markColor || null));
    head.appendChild(document.createTextNode(' ' + v.name));
    if (v.state === 'server-unavailable') {
      const chip = el('span', 'rf-blocked-chip', 'Needs a server');
      chip.title = v.startTip; chip.setAttribute('aria-label', v.startTip); head.appendChild(chip);
    }
    card.appendChild(head);
    if (v.state !== 'server-unavailable') card.appendChild(el('div', 'pg-cards', [v.where, v.word].filter(Boolean).join(' · ')));
    card.insertAdjacentHTML('beforeend', icon('chevron_right', 'pg-chev'));
    card.addEventListener('click', () => h.edit(v.id));
    sec.appendChild(card);
  }
  const add = el('button', 'reqlink sv-req');
  add.insertAdjacentHTML('beforeend', icon('add'));
  add.appendChild(document.createTextNode('New recipe'));
  add.addEventListener('click', () => h.create());
  sec.appendChild(add);
}
