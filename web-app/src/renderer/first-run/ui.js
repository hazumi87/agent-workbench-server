import { icon } from '../m3-chrome.js';
import { ATTACH_UNAVAILABLE, copyProgressWords, folderMessages, folderAllowed, roomPlaces, uninstallWords, historyFolder } from './model.js';

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
const glyph = name => { const node = el('span', 'lf-glyph'); node.innerHTML = icon(name); node.setAttribute('aria-hidden', 'true'); return node; };
const button = (label, action, style = 'text') => {
  const node = el('button', 'lf-button ' + style, label); node.type = 'button';
  node.addEventListener('click', action); return node;
};
const pathField = (path, label = 'Files folder') => {
  const field = el('input', 'lf-path'); field.value = path; field.readOnly = true; field.tabIndex = -1;
  field.setAttribute('aria-label', label); return field;
};
const heading = (title, body) => { const node = el('div', 'lf-heading'); node.append(el('h1', null, title)); if (body) node.append(el('p', 'lf-secondary', body)); return node; };
const actions = (...items) => { const node = el('div', 'lf-actions'); node.append(...items); return node; };
const card = () => el('section', 'lf-card');
const message = (text, level = 'info') => {
  const node = el('div', 'lf-message ' + level);
  node.append(glyph(level === 'error' ? 'error' : level === 'warning' ? 'warning' : 'info'), el('span', null, text));
  node.setAttribute('role', level === 'error' ? 'alert' : 'status'); return node;
};
let serial = 0;

/** All methods are host-injected. No guessed paths, disk writes, engine launch or network. */
export function createFirstRunUI({ api, onSetupComplete = () => {}, onAddServer = () => {}, onCreateRoom = () => {}, notify = () => {}, setupWaitMs = 10000 }) {
  const views = new Map();
  const dialogs = new Set();
  let destroyed = false, snapshot = null;
  const current = view => !destroyed && views.get(view.host) === view;
  function mount(host, name) {
    for (const [oldHost, oldView] of views) if (!oldHost.isConnected || (oldHost !== host && host.contains(oldHost))) { oldView.dispose?.(); views.delete(oldHost); }
    views.get(host)?.dispose?.();
    const view = { host, name, epoch: 0, state: null, dispose: null };
    views.set(host, view); host.replaceChildren(); host.classList.add('lf-host'); return view;
  }
  function renderView(view, render, state) {
    try { render(state); }
    catch (error) {
      view.host.replaceChildren(message("Couldn't display this screen. Close it and try again.", 'error'));
      console.error('First-run screen render failed', error);
    }
  }
  async function load(view, render) {
    const epoch = ++view.epoch;
    view.host.replaceChildren(message('Loading…'));
    let state;
    try { state = await api.getState(); }
    catch (error) {
      if (current(view) && epoch === view.epoch) view.host.replaceChildren(message(error.message || "Couldn't load settings.", 'error'));
      return;
    }
    if (!current(view) || epoch !== view.epoch) return;
    snapshot = state; view.state = state; renderView(view, render, state);
  }
  function errorAt(host, error) { host.replaceChildren(message(error?.message || "Couldn't finish. Try again.", 'error')); }
  function folderChecks(host, checks) { host.replaceChildren(...folderMessages(checks).map(row => message(row.text, row.level))); }
  function setup(host, refreshed = false) {
    const view = mount(host, 'setup');
    load(view, state => {
      if (state.setupRequired === false) { host.replaceChildren(); views.delete(host); onSetupComplete({ok:true}); return; }
      let chosen = state.files.path, checks = state.files.checks, migration = state.files.oldScratchpad ? 'in-place' : 'none', checking = false, busy = false;
      const root = el('main', 'lf-setup'), surface = el('div', 'lf-setup-surface');
      const mark = el('div', 'lf-product-mark'); mark.append(glyph('space_dashboard'));
      const intro = heading('Welcome to Agent Workbench');
      intro.querySelector('h1').id = 'lf-welcome-' + ++serial; root.setAttribute('aria-labelledby', intro.querySelector('h1').id);
      surface.append(mark, intro);
      if (refreshed) surface.append(message('This screen was out of date, so it was refreshed. Check your choice and press Continue.', 'refreshed'));
      if (state.files.oldScratchpad) {
        const old = card(); old.classList.add('lf-old'); old.append(el('h2', null, 'Your Scratchpad is here'),
          el('p', null, 'We found Scratchpad files from before in ' + state.files.oldScratchpad + '. Keep using that folder, or start with the new one?'));
        const name = 'scratchpad-choice-' + serial;
        for (const [value, label, detail] of [['in-place', 'Keep using it', 'Nothing is moved.'], ['fresh', 'Use the new folder', 'The old files stay where they are.']]) {
          const row = el('label', 'lf-choice'); const input = el('input'); input.type = 'radio'; input.name = name; input.value = value; input.checked = value === migration;
          input.addEventListener('change', () => { migration = value; });
          const text = el('span'); text.append(el('strong', null, label), el('span', 'lf-secondary', detail)); row.append(input, text); old.append(row);
        }
        surface.append(old);
      }
      const question = el('h2', null, 'Where should Agent Workbench keep your files?'); question.id = 'lf-question-' + serial;
      const field = pathField(chosen); field.setAttribute('aria-labelledby', question.id);
      const checksEl = el('div', 'lf-checks'), errors = el('div'), status = el('div', 'lf-operation'); status.setAttribute('role', 'status');
      const waiting = el('div', 'lf-waiting'); waiting.hidden = true;
      waiting.append(message('This is taking longer than usual.'));
      let operation = 0, waitTimer = null;
      const stopWaiting = () => { clearTimeout(waitTimer); waitTimer = null; waiting.hidden = true; };
      const armWaiting = () => { stopWaiting(); waitTimer = setTimeout(() => { if (current(view) && busy) waiting.hidden = false; }, setupWaitMs); };
      // While Continue runs, show how many files are copied ("Copied 120 of 3,400 files"): counts only, once a second.
      let progressTimer = null;
      const stopProgress = () => { clearInterval(progressTimer); progressTimer = null; };
      const watchProgress = () => {
        stopProgress();
        progressTimer = setInterval(async () => {
          if (!(current(view) && busy)) { stopProgress(); return; }
          try { const words = copyProgressWords(await api.setupProgress()); if (words && current(view) && busy) status.textContent = words; } catch { /* the count is a courtesy */ }
        }, 1000);
      };
      const keepWaiting = button('Keep waiting', armWaiting);
      const cancel = button('Cancel', async () => {
        if (!busy || cancel.disabled) return;
        const stamp = operation; cancel.disabled = keepWaiting.disabled = true;
        try {
          const result = await api.cancelSetup({ operationId: view.operationId });
          if (!current(view) || stamp !== operation) return;
          if (result?.ok !== true) throw Error(result?.message || "Setup is still running. Keep waiting, then try again.");
          operation++; busy = false; stopWaiting(); status.textContent = ''; paint(); choose.focus();
        } catch (error) { if (current(view) && stamp === operation) errorAt(errors, error); }
        finally { cancel.disabled = keepWaiting.disabled = false; }
      });
      waiting.append(actions(keepWaiting, cancel));
      view.dispose = () => { operation++; stopWaiting(); stopProgress(); };
      const next = button('Continue', async () => {
        if (busy || checking || !folderAllowed(checks)) return;
        const stamp = ++operation;
        view.operationId = globalThis.crypto.randomUUID();
        busy = true; errors.replaceChildren(); paint(); status.textContent = 'Setting up…'; armWaiting(); watchProgress();
        try {
          const result = await api.completeSetup({ path: chosen, oldScratchpad: migration, operationId: view.operationId });
          if (!current(view) || stamp !== operation) return;
          if (result?.ok === false && result.refresh === true && ['scratchpad-choice-required','setup-state-changed'].includes(result.code)) {
            busy = false; stopWaiting(); stopProgress(); setup(host, true); return;
          }
          if (result?.ok === false) throw Error(result.message || "Couldn't set up this folder.");
          stopWaiting(); host.replaceChildren(); views.delete(host); onSetupComplete(result);
        } catch (error) {
          if (current(view) && stamp === operation) {
            busy = false; stopWaiting(); status.textContent = '';
            errorAt(errors, error); paint();
          }
        }
      }, 'filled');
      const choose = button('Choose folder…', async () => {
        if (busy || checking) return;
        const stamp = ++view.epoch; checking = true; paint(); errors.replaceChildren();
        try {
          const path = await api.chooseFolder({ current: chosen });
          if (!current(view) || stamp !== view.epoch) return;
          if (path) { const checked = await api.checkFolder(path); if (!current(view) || stamp !== view.epoch) return; chosen = path; field.value = path; checks = checked; }
        } catch (error) { if (current(view) && stamp === view.epoch) { checks = null; errorAt(errors, error); } }
        finally { if (current(view) && stamp === view.epoch) { checking = false; paint(); } }
      });
      function paint() { folderChecks(checksEl, checks); next.disabled = busy || checking || !folderAllowed(checks); choose.disabled = busy || checking; }
      const helper = el('div', 'lf-helper'); helper.append(el('p', null, "Your notes, assets and agent folders go here. Your notes are saved here as copies. Edit them in Agent Workbench."),
        el('p', null, "Chat history stays in the app's own data and is not kept here."), el('p', null, 'No account needed. You can add a server later.'));
      surface.append(question, field, actions(choose), checksEl, helper, errors, actions(next), status, waiting); root.append(surface);
      host.replaceChildren(root); paint(); next.focus();
      root.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
        if (event.key === 'Enter' && event.target === field && !next.disabled) next.click();
        if (event.key === 'Tab') {
          const items = [...root.querySelectorAll('button:not(:disabled),input[type=radio]:checked')].filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
          const first = items[0], last = items.at(-1);
          if (!items.length) { event.preventDefault(); return; }
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      });
    });
    return view;
  }
  function files(host) {
    const view = mount(host, 'files');
    load(view, state => {
      const root = el('div', 'lf-page'); root.append(heading('Files', 'Your notes, assets and agent folders.'));
      const currentCard = card(), errors = el('div');
      currentCard.append(el('h2', null, 'Files folder'), pathField(state.files.path));
      let chosen = null, checks = null, busy = false;
      const candidate = el('div', 'lf-candidate'); candidate.hidden = true;
      const open = button('Open folder', () => api.openFolder({ kind: 'files' }).catch(error => errorAt(errors, error)));
      const choose = button('Choose folder…', () => pick(false));
      const reset = button('Use default', () => pick(true));
      const note = el('p', 'lf-secondary', 'Choosing a new folder never moves or deletes your files.');
      const blocked = state.files.dirtyNotes;
      if (blocked) currentCard.append(message('Save or close your open notes first.', 'warning'));
      choose.disabled = reset.disabled = !!blocked;
      currentCard.append(actions(open, choose, reset), note, el('p', 'lf-secondary', 'Your notes are saved here as read-only copies. Edit them in Agent Workbench. Changes made to a copy here are not saved back.'),
        actions(button('Open notes folder', () => api.openFolder({ kind: 'notes' }).catch(error => errorAt(errors, error)))),
        el('p', 'lf-secondary', 'Editing a copy elsewhere does not change the note, and the next copy replaces the edited file. A crash can leave a copy up to 30 seconds behind. The copy syncs like any file in the folder.'),
        message(state.files.checks?.onlineOnly ? 'Some files are online-only. Agents may be slow to read them.' : 'This folder is kept on this device.'), candidate);
      async function pick(useDefault) {
        if (busy || blocked) return;
        busy = true; choose.disabled = reset.disabled = true; errors.replaceChildren();
        const stamp = ++view.epoch;
        try {
          const path = useDefault ? state.files.defaultPath : await api.chooseFolder({ current: state.files.path });
          if (!current(view) || stamp !== view.epoch || !path) return;
          chosen = path; checks = await api.checkFolder(path);
          if (!current(view) || stamp !== view.epoch) return;
          candidate.hidden = false; candidate.replaceChildren(el('h3', null, 'Use this folder'), pathField(path, 'New files folder'));
          const msgs = el('div'); folderChecks(msgs, checks); candidate.append(msgs);
          const copy = button('Copy my files here', () => change('copy'), 'filled');
          const fresh = button('Start fresh here', () => change('fresh'), 'tonal');
          copy.disabled = fresh.disabled = !folderAllowed(checks);
          candidate.append(el('p', 'lf-secondary', 'Copying checks every file and keeps the old files. Starting fresh leaves the old folder untouched.'), actions(copy, fresh));
        } catch (error) { if (current(view) && stamp === view.epoch) errorAt(errors, error); }
        finally { if (current(view) && stamp === view.epoch) { busy = false; choose.disabled = reset.disabled = false; } }
      }
      async function change(action) {
        if (busy || blocked || !folderAllowed(checks)) return;
        busy = true; candidate.querySelectorAll('button').forEach(node => { node.disabled = true; });
        try {
          const result = await api.changeFiles({ path: chosen, action });
          if (!current(view)) return;
          if (result?.ok === false) throw Error(result.message || "Couldn't change this folder.");
          files(host);
        } catch (error) { if (current(view)) { busy = false; errorAt(errors, error); candidate.querySelectorAll('button').forEach(node => { node.disabled = false; }); } }
      }
      root.append(currentCard);
      if (state.files.previousFolders?.length) {
        const previous = card(); previous.append(el('h2', null, 'Previous folders'));
        for (const path of state.files.previousFolders) { const row = el('div', 'lf-previous'); row.append(el('span', 'lf-fullpath', path), button('Open', () => api.openFolder({ path }).catch(error => errorAt(errors, error)))); previous.append(row); }
        root.append(previous);
      }
      const historyHost = el('section'); root.append(errors, historyHost); host.replaceChildren(root);
      history(historyHost, { embedded: true });
    }); return view;
  }
  function history(host, { embedded = false } = {}) {
    const view = mount(host, 'history');
    const render = state => {
      const active = host.contains(document.activeElement) ? document.activeElement : null;
      const focusKey = active?.type === 'checkbox' ? 'toggle' : active?.tagName === 'BUTTON' ? active.textContent : null;
      const root = el('div', embedded ? 'lf-history-embed' : 'lf-page');
      if (embedded) root.append(el('h2', null, 'Chat history'), el('p', 'lf-secondary', "Chat history is saved on this computer in the app's own data."));
      else root.append(heading('Chat history', "Chat history is saved on this computer in the app's own data."));
      const backup = card(), errors = el('div'); backup.append(el('h2', null, 'A daily copy, with your files'));
      const label = el('label', 'lf-toggle'); const toggle = el('input'); toggle.type = 'checkbox'; toggle.checked = state.history.enabled !== false;
      toggle.addEventListener('change', async () => { toggle.disabled = true; try { await api.setHistoryEnabled(toggle.checked); } catch (error) { toggle.checked = !toggle.checked; errorAt(errors, error); } finally { toggle.disabled = false; } });
      label.append(toggle, el('span', null, 'Save a copy of each finished day'));
      backup.append(label, el('p', 'lf-fullpath', `Copies are saved in ${historyFolder(state.files)}.`),
        el('p', 'lf-secondary', 'Exported chat history is saved in your files folder. If OneDrive or another service backs up that folder, it backs these up too.'),
        el('p', 'lf-lastcopy', state.history.lastCopy ? 'Last copy: ' + state.history.lastCopy : 'No copies yet'));
      const exportNow = button('Export now', async () => {
        exportNow.disabled = true; errors.replaceChildren();
        try { const result = await api.exportHistory(); if (current(view)) { if (result?.ok === false) throw Error(result.message); notify(result?.files?.length === 0 ? 'No chat history to export yet.' : "Today's chat so far was saved as a separate copy."); history(host, { embedded }); } }
        catch (error) { if (current(view)) { errorAt(errors, error); exportNow.disabled = false; } }
      }, 'filled');
      backup.append(actions(exportNow, button('Open history folder', () => api.openFolder({ kind: 'history' }).catch(error => errorAt(errors, error)))));
      if (state.history.error) backup.append(message(state.history.error, 'error'));
      const progress = state.history.progress;
      if (progress) {
        const box = el('div', 'lf-export'); const text = el('span', null, `Saving earlier days… ${progress.done} of ${progress.total}`); text.setAttribute('role', 'status');
        const meter = el('progress'); meter.max = progress.total || 1; meter.value = progress.done; meter.setAttribute('aria-label', 'Earlier days saved');
        box.append(text, meter, button('Cancel', async () => { try { await api.cancelExport(); if (current(view)) history(host, { embedded }); } catch (error) { if (current(view)) errorAt(errors, error); } })); backup.append(box); exportNow.disabled = true;
      }
      root.append(backup, errors); host.replaceChildren(root);
      if (focusKey) (focusKey === 'toggle' ? toggle : [...root.querySelectorAll('button')].find(b => b.textContent === focusKey && !b.disabled))?.focus();
    };
    load(view, render);
    const subscribeHistory = api.subscribeHistory || api.subscribe;
    if (subscribeHistory) view.dispose = subscribeHistory.call(api, state => { if (current(view)) { view.epoch++; snapshot = state; view.state = state; renderView(view, render, state); } },
      () => current(view) && host.isConnected && host.getClientRects().length > 0,
      error => { if (current(view)) { const notice = host.querySelector('.lf-history-error') || el('div', 'lf-history-error'); errorAt(notice, error); host.append(notice); } });
    return view;
  }
  function servers(host) {
    const view = mount(host, 'servers');
    load(view, state => {
      if (state.servers.length) { view.host.replaceChildren(); return; }
      const root = el('div', 'lf-empty'); root.append(glyph('dns'), heading('You are working locally', 'Add a server to share rooms and agents with other people, and to keep your chats safe and available on your other computers.'),
        el('p', 'lf-secondary', 'Chats on this computer stay on this computer.'), button('Add a server', onAddServer, 'filled')); host.replaceChildren(root);
    }); return view;
  }
  function choiceDialog(host, title, places, selected, go, resolve) {
    const shade = el('div', 'lf-shade lf-host'), dialog = el('section', 'lf-dialog'); const label = 'lf-dialog-' + ++serial;
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', label);
    const h = el('h2', null, title); h.id = label; dialog.append(h); let picked = selected;
    const name = 'place-' + serial;
    for (const place of places) {
      const row = el('label', 'lf-place'); const input = el('input'); input.type = 'radio'; input.name = name; input.value = place.id; input.checked = place.id === selected;
      input.addEventListener('change', () => { picked = place.id; });
      const words = el('span'); words.append(el('strong', null, place.name), el('span', 'lf-secondary', place.detail)); row.append(input, glyph(place.icon), words); dialog.append(row);
    }
    const before = document.activeElement;
    let closed = false, busy = false;
    const close = value => { if (closed) return; closed = true; dialogs.delete(close); shade.remove(); if (before?.isConnected) before.focus(); resolve?.(value); };
    dialogs.add(close);
    const errors = el('div'); dialog.append(errors);
    const proceed = button('Continue', async () => {
      if (busy) return; busy = true; proceed.disabled = true;
      try { await go(picked); if (!destroyed) close(picked); }
      catch (error) { if (!closed && !destroyed) errorAt(errors, error); }
      finally { busy = false; proceed.disabled = false; }
    }, 'filled');
    dialog.append(actions(button('Cancel', () => { if (!busy) close(null); }), proceed)); shade.append(dialog); host.append(shade); proceed.focus();
    shade.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); close(null); }
      if (event.key === 'Tab') {
        const focusable = [...dialog.querySelectorAll('button,input:checked')].filter(node => !node.disabled);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }); return { close, el: shade };
  }
  async function chooseRoom(host = document.body) {
    const state = await api.getState();
    if (destroyed) return null;
    snapshot = state;
    const places = roomPlaces(state);
    if (places.length === 1) { await onCreateRoom('local'); return 'local'; }
    const selected = places.some(place => place.id === state.lastRoomPlace) ? state.lastRoomPlace : 'local';
    return new Promise(resolve => choiceDialog(host, 'Where should this room live?', places, selected, onCreateRoom, resolve));
  }
  async function removeServer(server, host = document.body) {
    if (destroyed) return;
    return new Promise(resolve => {
      const shade = el('div', 'lf-shade lf-host'), box = el('section', 'lf-dialog'); const title = el('h2', null, 'Remove ' + server.name + '?');
      title.id = 'lf-remove-' + ++serial; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', title.id);
      const before = document.activeElement, error = el('div'); let busy = false, closed = false;
      const close = result => { if (closed) return; closed = true; dialogs.delete(close); shade.remove(); if (before?.isConnected) before.focus(); resolve(result); };
      dialogs.add(close);
      box.append(title, el('p', 'lf-secondary', 'Its rooms leave your list. Copies already saved on this computer stay. Rooms on this computer are not affected.'), error);
      const cancel = button('Cancel', () => { if (!busy) close(false); });
      const remove = button('Remove', async () => {
        if (busy) return; busy = true; remove.disabled = cancel.disabled = true;
        try { await api.removeServer(server.id); if (!destroyed) close(true); }
        catch (e) { if (!closed && !destroyed) errorAt(error, e); }
        finally { busy = false; remove.disabled = cancel.disabled = false; }
      }, 'filled');
      box.append(actions(cancel, remove)); shade.append(box); host.append(shade); cancel.focus();
      shade.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !busy) { event.preventDefault(); close(false); }
        if (event.key === 'Tab') { event.preventDefault(); (document.activeElement === cancel ? remove : cancel).focus(); }
      });
    });
  }
  function connectedServers(host, state = snapshot) {
    if (!state?.servers.length) return;
    const group = card(); group.classList.add('lf-host'); group.append(el('h2', null, 'Room servers'));
    for (const server of state.servers) { const row = el('div', 'lf-previous'); row.append(el('span', null, server.name), button('Remove ' + server.name, () => removeServer(server))); group.append(row); }
    host.append(group);
  }
  function locationChip(room, state = snapshot) {
    if (!state?.servers.length) return null;
    const place = roomPlaces(state).find(place => place.id === (room.place || 'local')); if (!place) return null;
    const node = el('span', 'lf-location'); if (place.color) node.style.setProperty('--lf-server-color', place.color); node.append(glyph(place.icon), document.createTextNode(place.name)); return node;
  }
  function locations(host) {
    const view = mount(host, 'locations');
    load(view, state => {
      const root = el('div', 'lf-page'); root.append(heading('Rooms'));
      let filter = 'all'; const list = el('div', 'lf-room-list');
      const paint = () => { list.replaceChildren(); for (const room of state.rooms.filter(room => filter === 'all' || (room.place || 'local') === filter)) {
        const row = el('div', 'lf-room-row'); row.append(glyph('forum'), el('strong', null, room.name)); const chip = locationChip(room, state); if (chip) row.append(chip); list.append(row);
      } };
      if (state.servers.length) {
        const filters = el('div', 'lf-segments'); filters.setAttribute('aria-label', 'Room location');
        for (const place of [{ id: 'all', name: 'All' }, ...roomPlaces(state)]) {
          const b = button(place.name, () => { filter = place.id; for (const item of filters.children) item.setAttribute('aria-pressed', String(item === b)); paint(); });
          b.setAttribute('aria-pressed', String(filter === place.id)); filters.append(b);
        } root.append(filters);
      }
      root.append(list, actions(button('Create room', () => chooseRoom(), 'filled'))); host.replaceChildren(root); paint();
    }); return view;
  }
  function localStatus(host, supplied) {
    const view = mount(host, 'local-status');
    const render = state => {
      const local = state.localRooms;
      if (local.status === 'running') { host.replaceChildren(); return; }
      if (local.status === 'starting') { host.replaceChildren(message('Starting local rooms…')); return; }
      const root = el('div', 'lf-empty'), error = el('div');
      const stopped = local.status === 'stopped';
      root.append(glyph(stopped ? 'power_settings_new' : 'cloud_off'), heading(stopped ? 'Disconnected' : "Local rooms couldn't start.", stopped ? "This room's live connection is closed, so nothing here updates. Your messages and files are kept." : 'Your files are safe. Restart local rooms to try again.'));
      const restart = button('Restart local rooms', async () => { restart.disabled = true; try { await api.restartLocalRooms(); if (current(view)) localStatus(host); } catch (e) { if (current(view)) { errorAt(error, e); restart.disabled = false; } } }, 'filled');
      root.append(restart);
      if (!stopped) { const details = el('details'); details.append(el('summary', null, 'Show details'), el('pre', 'lf-detail', local.detail || 'No additional details.')); root.append(details); }
      root.append(error); host.replaceChildren(root);
    };
    if (supplied) render(supplied); else load(view, render); return view;
  }
  function about(host, { withTitle = true } = {}) {
    const view = mount(host, 'about'); load(view, state => {
      const errors = el('div');
      const root = el('div', 'lf-page'); if (withTitle) root.append(heading('Agent Workbench ' + state.version)); const status = card();
      status.append(el('h2', null, 'Local rooms'), el('p', null, state.localRooms.status === 'running' ? 'Running' : 'Stopped'),
        button('Restart local rooms', async () => { try { await api.restartLocalRooms(); if (current(view)) about(host, { withTitle }); } catch (error) { if (current(view)) errorAt(errors, error); } })); root.append(status, errors); host.replaceChildren(root);
    }); return view;
  }
  function uninstall(host) {
    const view = mount(host, 'uninstall'); load(view, state => {
      const words = uninstallWords(state.cliCount || 0, state.files.path), root = el('div', 'lf-page lf-uninstall'); root.append(heading(words.title));
      if (words.running) root.append(message(words.running, 'warning'));
      const box = card(); box.append(el('p', null, words.body)); const label = el('label', 'lf-toggle'), check = el('input'); check.type = 'checkbox';
      label.append(check, el('span', null, words.checkbox)); box.append(label, el('p', 'lf-secondary', words.helper)); root.append(box); host.replaceChildren(root);
    }); return view;
  }
  function attachmentControls(host, ready = false) {
    const row = el('div', 'lf-attachments'); const reason = el('span', 'lf-sr'); reason.id = 'lf-attach-reason-' + ++serial; reason.textContent = ATTACH_UNAVAILABLE;
    for (const [name, label] of [['attach_file', 'Attach files'], ['image', 'Attach image']]) {
      const b = button('', () => {}, 'icon'); b.append(glyph(name)); b.setAttribute('aria-label', label);
      b.disabled = !ready; if (!ready) { b.title = ATTACH_UNAVAILABLE; b.setAttribute('aria-describedby', reason.id); } row.append(b);
    } row.append(reason); host.append(row); return row;
  }
  return { setup, files, history, servers, chooseRoom, removeServer, connectedServers, locations, locationChip, localStatus, about, uninstall, attachmentControls,
    refresh: () => api.getState().then(state => { snapshot = state; return state; }),
    notifyMemoryRestart: () => notify('Local rooms restarted to free memory. Your chats are saved.'),
    destroy() { destroyed = true; for (const close of [...dialogs]) close(null); for (const view of views.values()) view.dispose?.(); views.clear(); } };
}
