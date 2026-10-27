// Personal files only. The bound main-process API owns account and folder scope;
// this renderer receives note/asset IDs, never a file path to read or execute.
function element(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, action) {
  const node = element('button', 'sp-button', text);
  node.type = 'button'; node.addEventListener('click', action); return node;
}
function failure(result) {
  if (['conflict', 'revision-conflict', 'note-conflict'].includes(result?.reason)) return 'This note changed on disk. Your draft is still here. Reload the saved note to replace your draft.';
  if (result?.reason === 'scope-changed' || result?.reason === 'account-changed') return 'The account or folder changed. Refresh Scratchpad before trying again.';
  return 'Could not complete this action. Your unsaved text is still here.';
}
function noteTitle(note) { return (note.title || note.text?.split('\n').find(line => line.trim()) || 'Untitled note').replace(/^#+\s*/, '').slice(0, 160); }
function sizeLabel(value) {
  if (!Number.isFinite(value)) return '';
  return value < 1024 ? `${value} B` : value < 1048576 ? `${Math.ceil(value / 1024)} KB` : `${(value / 1048576).toFixed(1)} MB`;
}

export function createScratchpadPage({ host, api, onSettings = () => {} }) {
  const root = element('div', 'sp-page');
  const header = element('div', 'sp-header');
  const heading = element('div'); heading.append(element('h2', '', 'Scratchpad'), element('p', 'sp-muted', 'Personal notes and files for this account.'));
  const folderSettings = button('Folder settings', onSettings);
  header.append(heading, folderSettings);
  const setupHint = element('p', 'sp-muted', 'Finish setting up first. Then you can add files and notes.'); setupHint.hidden = true;
  const location = element('p', 'sp-location');
  const notice = element('p', 'sp-notice'); notice.setAttribute('role', 'status');
  let retryAction = null;
  const retry = button('Try again', () => { if (retryAction) void retryAction(); }); retry.hidden = true;
  const tabs = element('div', 'sp-tabs'); tabs.setAttribute('role', 'tablist');
  const notesTab = button('Notes', () => selectTab('notes'));
  const assetsTab = button('Assets', () => selectTab('assets'));
  for (const tab of [notesTab, assetsTab]) tab.setAttribute('role', 'tab');
  tabs.append(notesTab, assetsTab);
  const notesPane = element('section', 'sp-notes-pane');
  const newNote = button('New note', () => void createNote());
  const notes = element('div', 'sp-notes');
  const editor = element('section', 'sp-editor'); editor.hidden = true;
  const editorTitle = element('h3');
  const input = element('textarea', 'sp-note-input'); input.rows = 12; input.setAttribute('aria-label', 'Note text');
  const editorNotice = element('p', 'sp-muted'); editorNotice.setAttribute('role', 'status');
  const actions = element('div', 'sp-actions');
  const save = button('Save note', () => void saveNote());
  const reload = button('Reload saved note', () => void reloadNote()); reload.hidden = true;
  const close = button('Close note', () => void closeNote());
  actions.append(save, reload, close); editor.append(editorTitle, input, editorNotice, actions);
  notesPane.append(newNote, editor, notes);
  const assetsPane = element('section', 'sp-assets-pane'); assetsPane.hidden = true;
  assetsPane.tabIndex = 0; assetsPane.setAttribute('aria-label', 'Assets');
  const dropHint = element('p', 'sp-drop-hint', 'Drop to add to Assets'); dropHint.hidden = true;
  const assetActions = element('div', 'sp-actions');
  const add = button('Add files', () => void action('importAssets'));
  add.className += ' sp-add-files';
  add.setAttribute('aria-label', 'Add files');
  const showFolder = button('Show in folder', () => void action('showFolder'));
  assetActions.append(add, showFolder);
  const assets = element('div', 'sp-assets'); assetsPane.append(assetActions, element('p', 'sp-muted', 'Drag files here, paste, or choose Add files.'), dropHint, assets);
  root.append(header, setupHint, location, notice, retry, tabs, notesPane, assetsPane); host.append(root);

  let client = api.bind(), epoch = 0, refreshId = 0, shown = false, busy = false, disposed = false;
  let setupRequired = false;
  let selected = null, heldDraft = false, noteRows = [], assetRows = [], tab = 'notes', pendingFiles = [];
  const recentAssets = new Set();
  const current = (token, binding) => !disposed && epoch === token && binding.current();
  const dirty = () => !!selected && !selected.readOnly && input.value !== selected.text;
  function controls() {
    newNote.disabled = busy || heldDraft || setupRequired;
    input.readOnly = !!selected?.readOnly || heldDraft;
    input.disabled = busy;
    save.hidden = !!selected?.readOnly;
    save.disabled = busy || heldDraft || !dirty(); close.disabled = busy; reload.disabled = busy || heldDraft;
    add.disabled = busy || setupRequired; showFolder.disabled = busy || setupRequired;
    folderSettings.hidden = add.hidden = showFolder.hidden = setupRequired;
    tabs.hidden = location.hidden = notice.hidden = setupRequired;
    notesPane.hidden = setupRequired || tab !== 'notes'; assetsPane.hidden = setupRequired || tab !== 'assets';
    add.title = newNote.title = setupRequired ? 'Finish setting up first.' : ''; setupHint.hidden = !setupRequired;
    for (const node of notes.querySelectorAll('button')) node.disabled = busy || heldDraft;
    for (const node of assets.querySelectorAll('button')) node.disabled = busy;
  }
  input.addEventListener('input', () => { editorNotice.textContent = dirty() ? 'Unsaved changes' : ''; controls(); });
  function selectTab(next) {
    tab = next; notesPane.hidden = setupRequired || tab !== 'notes'; assetsPane.hidden = setupRequired || tab !== 'assets';
    notesTab.setAttribute('aria-selected', String(tab === 'notes')); assetsTab.setAttribute('aria-selected', String(tab === 'assets'));
  }
  function dismissEditor() {
    selected = null; heldDraft = false; input.value = ''; editor.hidden = true; reload.hidden = true; editorNotice.textContent = ''; controls();
  }
  function edit(note) {
    if (busy || heldDraft) return;
    if (dirty()) { notice.textContent = 'Save or close this note before opening another.'; return; }
    selected = { ...note }; input.value = note.text; editorTitle.textContent = note.readOnly ? 'Saved room copy' : 'Edit note';
    editorNotice.textContent = note.readOnly ? 'This copy is read-only. Edit the shared note in its room.' : '';
    editor.hidden = false; reload.hidden = true; notice.textContent = ''; controls(); input.focus();
  }
  function paint() {
    notes.replaceChildren(); assets.replaceChildren();
    if (!noteRows.length) notes.append(element('p', 'sp-empty', 'No notes yet. Create a note to keep it in this account’s Scratchpad.'));
    for (const note of noteRows) {
      const card = element('article', 'sp-note');
      card.append(element('h3', '', noteTitle(note)), element('p', 'sp-preview', note.text));
      if (note.sourceLabel || note.readOnly) card.append(element('small', 'sp-muted', note.sourceLabel || 'Saved room copy · read-only'));
      card.append(button(note.readOnly ? 'View note' : 'Edit note', () => edit(note))); notes.append(card);
    }
    for (const name of pendingFiles) {
      const card = element('article', 'sp-asset'); card.append(element('b', '', name), element('span', 'sp-muted', 'Adding…')); assets.append(card);
    }
    if (!assetRows.length && !pendingFiles.length) assets.append(element('p', 'sp-empty', 'No files yet. Add files from this computer.'));
    for (const asset of assetRows) {
      const row = element('article', 'sp-asset'); const details = element('div');
      details.append(element('b', '', asset.name), element('small', 'sp-muted', [asset.unreadable ? '' : sizeLabel(asset.size), asset.sourceLabel].filter(Boolean).join(' · ')));
      row.append(details);
      if (recentAssets.has(asset.id)) details.append(element('small', 'sp-new', 'New'));
      if (asset.unreadable) {
        details.append(element('span', 'sp-muted', "Can't check"), element('small', 'sp-muted', "Workbench can't read this file's record right now."));
      } else if (asset.missing || asset.damaged) {
        details.append(element('span', 'sp-muted', asset.missing ? 'File missing' : "Can't be opened"),
          element('small', 'sp-muted', asset.missing ? "This file isn't in the folder any more." : 'This file looks damaged.'));
        if (asset.missing && !asset.readOnly) row.append(button('Remove from list', () => void action('removeMissingAsset', asset.id)));
      } else row.append(button('Show file', () => void action('openAsset', asset.id)));
      assets.append(row);
    }
    controls();
  }
  async function refresh() {
    const token = epoch, binding = client, request = ++refreshId;
    if (!binding.current() || disposed) return;
    try {
      const [where, list] = await Promise.all([binding.location(), binding.list()]);
      if (!current(token, binding) || request !== refreshId) return;
      setupRequired = where?.setupRequired === true || list?.setupRequired === true;
      location.textContent = setupRequired ? '' : where?.path || 'Scratchpad folder unavailable';
      controls();
      if (!list?.ok) { notice.textContent = 'Could not read this Scratchpad folder. Check Folder settings.'; return; }
      noteRows = list.notes || []; assetRows = list.assets || []; paint();
      if (!where?.ok) notice.textContent = 'The Scratchpad folder is unavailable. Check Folder settings.';
      else if (list.issues?.some(issue => issue.problem === 'unreadable-folder')) notice.textContent = "Part of this Scratchpad can't be read. Nothing was changed.";
      else if (list.issues?.length) notice.textContent = 'Some saved files need attention. Nothing was deleted.';
      else if (where.warning === 'room-copy-unavailable') notice.textContent = 'Some room copies could not be saved. Open them again to retry.';
      // Background refresh never replaces the editor or its revision, even when
      // a synced disk copy changed. Save uses the originally loaded revision.
    } catch { if (current(token, binding) && request === refreshId) notice.textContent = 'Could not refresh Scratchpad.'; }
  }
  async function createNote() {
    if (busy || heldDraft || setupRequired || !client.current()) return;
    if (dirty()) { notice.textContent = 'Save or close this note before creating another.'; return; }
    const token = epoch, binding = client; busy = true; controls();
    try {
      const result = await binding.createNote('');
      if (!current(token, binding)) return;
      if (!result?.ok || !result.note) { notice.textContent = failure(result); return; }
      busy = false; edit(result.note); await refresh();
    } catch { if (current(token, binding)) notice.textContent = 'Could not create a note.'; }
    finally { if (current(token, binding)) { busy = false; controls(); } }
  }
  async function persist(token, binding) {
    if (!selected || selected.readOnly || heldDraft || !dirty()) return true;
    const id = selected.id, text = input.value, revision = selected.revision;
    const result = await binding.saveNote(id, text, revision);
    if (!current(token, binding)) return false;
    if (!result?.ok || !result.note) {
      editorNotice.textContent = failure(result); reload.hidden = false; return false;
    }
    selected = { ...result.note }; input.value = result.note.text; editorNotice.textContent = 'Saved'; reload.hidden = true; return true;
  }
  async function saveNote() {
    if (busy || heldDraft || !client.current()) return;
    const token = epoch, binding = client; busy = true; controls();
    try { if (await persist(token, binding) && current(token, binding)) await refresh(); }
    catch { if (current(token, binding)) editorNotice.textContent = 'Could not save this note. Your draft is still here.'; }
    finally { if (current(token, binding)) { busy = false; controls(); } }
  }
  async function closeNote() {
    if (busy || !selected) return;
    if (heldDraft || selected.readOnly) { dismissEditor(); return; }
    if (!client.current()) return;
    const token = epoch, binding = client; busy = true; controls();
    try {
      if (!await persist(token, binding) || !current(token, binding)) return;
      const result = await binding.closeNote(selected.id);
      if (!current(token, binding)) return;
      if (!result?.ok) { editorNotice.textContent = failure(result); return; }
      dismissEditor(); await refresh();
    } catch { if (current(token, binding)) editorNotice.textContent = 'Could not close this note. Your draft is still here.'; }
    finally { if (current(token, binding)) { busy = false; controls(); } }
  }
  async function reloadNote() {
    if (busy || heldDraft || !selected || !client.current()) return;
    const token = epoch, binding = client, id = selected.id; busy = true; controls();
    try {
      const result = await binding.list(); if (!current(token, binding)) return;
      const note = result?.ok && result.notes.find(value => value.id === id);
      if (!note) { editorNotice.textContent = 'The saved note is unavailable. Your draft is still here.'; return; }
      selected = { ...note }; input.value = note.text; reload.hidden = true; editorNotice.textContent = 'Loaded the saved note';
    } catch { if (current(token, binding)) editorNotice.textContent = 'Could not reload this note. Your draft is still here.'; }
    finally { if (current(token, binding)) { busy = false; controls(); } }
  }
  function importFailure(name, reason) {
    if (reason === 'setup-required') return 'Finish setting up first. Then you can add files and notes.';
    if (reason === 'path-too-long') return `${name} can't be stored here. The folder path is too long.`;
    return reason === 'too-large' ? `${name} is too big. The limit is 25 MB.` : `Couldn't add ${name}. Try again.`;
  }
  function showFailures(failures, retryFn) {
    notice.textContent = failures.map(item => importFailure(item.name, item.reason)).join(' ');
    retryAction = failures.length === 1 && !['path-too-long','setup-required'].includes(failures[0].reason) ? retryFn : null; retry.hidden = !retryAction;
  }
  const acceptsFiles = () => shown && !disposed && tab === 'assets' && client.current();
  function transferFiles(transfer) {
    if (!transfer) return [];
    const items = Array.from(transfer.items || []).filter(item => item.kind === 'file');
    return items.length ? items.map(item => item.getAsFile()).filter(Boolean) : Array.from(transfer.files || []);
  }
  function hasFiles(transfer) {
    return transferFiles(transfer).length > 0 || Array.from(transfer?.types || []).includes('Files');
  }
  function dragging(value) { dropHint.hidden = !value; assetsPane.setAttribute('data-dragging', String(value)); }
  assetsPane.addEventListener('click', event => {
    if (!event.target?.closest?.('button,a,input,textarea,select')) assetsPane.focus();
  });
  assetsPane.addEventListener('dragover', event => {
    if (!acceptsFiles() || !hasFiles(event.dataTransfer)) return;
    event.preventDefault(); event.stopPropagation(); dragging(!busy && !setupRequired);
    if (event.dataTransfer) event.dataTransfer.dropEffect = busy || setupRequired ? 'none' : 'copy';
  });
  assetsPane.addEventListener('dragleave', event => { if (!assetsPane.contains?.(event.relatedTarget)) dragging(false); });
  assetsPane.addEventListener('drop', event => {
    if (!acceptsFiles() || !hasFiles(event.dataTransfer)) return;
    event.preventDefault(); event.stopPropagation(); dragging(false);
    void importFiles(transferFiles(event.dataTransfer));
  });
  assetsPane.addEventListener('paste', event => {
    if (!acceptsFiles()) return;
    const files = transferFiles(event.clipboardData); if (!files.length) return;
    event.preventDefault(); event.stopPropagation(); void importFiles(files);
  });
  async function importFiles(files) {
    if (setupRequired) { notice.textContent = 'Finish setting up first. Then you can add files and notes.'; return; }
    if (busy || !acceptsFiles() || !files.length) return;
    if (files.length > 20) { notice.textContent = 'Choose up to 20 files at a time.'; return; }
    const token = epoch, binding = client, failures = [];
    busy = true; retry.hidden = true; retryAction = null; pendingFiles = files.map(file => file.name || 'Pasted image.png'); paint();
    try {
      for (const file of files) {
        if (!current(token, binding) || !shown) return;
        const name = file.name || 'Pasted image.png';
        try {
          if (!Number.isSafeInteger(file.size) || file.size < 0) throw { reason: 'invalid-request' };
          if (file.size > 25 * 1024 * 1024) throw { reason: 'too-large' };
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (!current(token, binding) || !shown) return;
          if (bytes.byteLength > 25 * 1024 * 1024) throw { reason: 'too-large' };
          const result = await binding.importAsset({ name, type: file.type || 'application/octet-stream', bytes });
          if (!current(token, binding) || !shown) return;
          if (!result?.ok) failures.push({ name, reason: result?.reason });
          else for (const asset of result.assets || []) recentAssets.add(asset.id);
        } catch (error) { if (!current(token, binding) || !shown) return; failures.push({ name, reason: error?.reason }); }
        pendingFiles = pendingFiles.slice(1); paint();
      }
      await refresh();
      if (current(token, binding) && shown) showFailures(failures, () => importFiles(files));
    } finally {
      if (current(token, binding)) { busy = false; pendingFiles = []; paint(); }
    }
  }
  async function action(verb, id) {
    if (busy || !client.current()) return;
    const token = epoch, binding = client; busy = true; controls();
    try {
      const result = await binding[verb](...(id === undefined ? [] : [id]));
      if (!current(token, binding)) return;
      if (verb === 'importAssets') for (const asset of result?.assets || []) recentAssets.add(asset.id);
      if (verb === 'importAssets' && result?.failures?.length) {
        await refresh(); if (current(token, binding)) showFailures(result.failures, () => action('importAssets')); return;
      }
      if (!result?.ok) { notice.textContent = verb === 'importAssets' ? "Couldn't add the file. Try again." : 'Could not complete this file action. Refresh Assets and try again.'; return; }
      if (!result.cancelled) { notice.textContent = ''; await refresh(); }
    } catch { if (current(token, binding)) notice.textContent = 'Could not complete this file action.'; }
    finally { if (current(token, binding)) { busy = false; controls(); } }
  }
  function reset() {
    epoch++; refreshId++; recentAssets.clear(); client = api.bind(); busy = false; setupRequired = false; pendingFiles = []; retryAction = null; retry.hidden = true; dragging(false); noteRows = []; assetRows = [];
    dismissEditor(); location.textContent = ''; notice.textContent = ''; paint();
  }
  function changed(event = {}) {
    if (event.locationChanged) {
      const retain = dirty(); epoch++; refreshId++; recentAssets.clear(); client = api.bind(); busy = false; pendingFiles = []; retryAction = null; retry.hidden = true; dragging(false);
      noteRows = []; assetRows = []; paint();
      if (retain) {
        heldDraft = true; editorNotice.textContent = 'The folder changed. Copy your unsaved text before closing this note; it cannot be saved to the new folder.'; controls();
      } else dismissEditor();
    }
    if (shown) void refresh();
  }
  selectTab('notes'); paint();
  return {
    refresh,
    setShown(value) { shown = value; dragging(false); if (!value) { epoch++; recentAssets.clear(); busy = false; pendingFiles = []; retryAction = null; retry.hidden = true; paint(); } else void refresh(); },
    accountChanged() { reset(); if (shown) void refresh(); },
    changed,
    canChangeLocation() { return !busy && !dirty() && !heldDraft; },
    dispose() { disposed = true; epoch++; recentAssets.clear(); pendingFiles = []; retryAction = null; root.remove(); },
  };
}

export function createScratchpadSettings({ host, api, canChangeLocation = () => true, onChanged = () => {}, onOpen = () => {} }) {
  const root = element('section', 'sp-settings');
  root.append(element('h2', '', 'Scratchpad folder'), element('p', 'sp-muted', 'Keep personal notes and files in a folder on this computer. Terminal output and chat captures are not stored here.'));
  const path = element('p', 'sp-folder-path'); path.setAttribute('aria-label', 'Scratchpad folder');
  const kind = element('p', 'sp-muted'); const notice = element('p', 'sp-notice'); notice.setAttribute('role', 'status');
  const recovery = element('aside', 'sp-recovery'); recovery.hidden = true;
  const recoveryText = element('p', 'sp-recovery-text'); const recoveryDetail = element('p', 'sp-muted');
  const useFound = button('Use that folder', () => void change('useFoundFolder'));
  const keepCurrent = button('Keep this one', () => { dismissedRecovery = recoveryKey; recovery.hidden = true; });
  recovery.append(recoveryText, recoveryDetail, useFound, keepCurrent);
  const actions = element('div', 'sp-actions');
  const choose = button('Choose folder', () => void change('chooseFolder'));
  const useDefault = button('Use default', () => void change('useDefault'));
  const show = button('Show in folder', () => void reveal());
  actions.append(choose, useDefault, show);
  root.append(recovery, path, kind, actions, notice,
    element('p', 'sp-muted', 'Files stay in the previous folder when you change locations.'),
    element('p', 'sp-muted', 'Choose a synced folder to use these files on other computers.'),
    element('p', 'sp-muted', 'This folder may sync to OneDrive.'),
    button('Open Scratchpad', onOpen)); host.append(root);
  let client = api.bind(), epoch = 0, requestId = 0, busy = false, disposed = false;
  let dismissedRecovery = null, recoveryKey = null;
  const current = (token, binding) => !disposed && epoch === token && binding.current();
  function controls() { choose.disabled = busy; useDefault.disabled = busy; show.disabled = busy; useFound.disabled = busy; keepCurrent.disabled = busy; }
  function paint(result) {
    const found = result?.recovery;
    recoveryKey = found?.path ? JSON.stringify([result.path, found.path, found.readable]) : null;
    recovery.hidden = !recoveryKey || recoveryKey === dismissedRecovery;
    recoveryText.textContent = found?.path ? `Your files are in ${found.path}${found.readable ? '.' : ", but it can't be checked right now."}` : '';
    recoveryText.title = recoveryText.textContent;
    recoveryDetail.textContent = found?.readable ? 'Nothing was moved or deleted. This view is showing a different folder.' : '';
    useFound.hidden = keepCurrent.hidden = !found?.readable;
    path.title = result?.path || '';
    path.textContent = result?.path || 'Folder unavailable'; kind.textContent = result?.isDefault ? (result?.ok ? 'Default location · Found on this computer.' : 'Default location') : 'Custom location';
    notice.textContent = result?.ok ? (result.warning === 'room-copy-unavailable' ? 'Some room copies could not be saved. Open them again to retry.' : '') : 'This folder is unavailable. Choose an accessible folder or use the default.';
  }
  async function refresh() {
    const token = epoch, binding = client, request = ++requestId;
    if (!binding.current()) return;
    try { const result = await binding.location(); if (current(token, binding) && request === requestId) paint(result); }
    catch { if (current(token, binding)) notice.textContent = 'Could not read the Scratchpad folder setting.'; }
  }
  async function change(verb) {
    if (busy || !client.current()) return;
    if (!canChangeLocation()) { notice.textContent = 'Save or close your note in Scratchpad before changing folders.'; return; }
    const token = epoch, binding = client; busy = true; controls();
    try {
      const result = await binding[verb]();
      // Changing location can revoke the old binding. Epoch still fences account
      // switches, while main has already validated the picker result's owner.
      if (disposed || epoch !== token) return;
      if (result?.cancelled) return;
      if (!result?.ok) { paint(result); return; }
      dismissedRecovery = null;
      client = api.bind(); paint(result); onChanged({ locationChanged: true });
    } catch { if (!disposed && epoch === token) notice.textContent = 'Could not change the Scratchpad folder.'; }
    finally { if (!disposed && epoch === token) { busy = false; controls(); } }
  }
  async function reveal() {
    if (busy || !client.current()) return;
    const token = epoch, binding = client; busy = true; controls();
    try { const result = await binding.showFolder(); if (current(token, binding) && !result?.ok) notice.textContent = 'Could not show the Scratchpad folder.'; }
    catch { if (current(token, binding)) notice.textContent = 'Could not show the Scratchpad folder.'; }
    finally { if (current(token, binding)) { busy = false; controls(); } }
  }
  return {
    refresh,
    accountChanged() { epoch++; requestId++; client = api.bind(); busy = false; dismissedRecovery = null; recovery.hidden = true; path.textContent = ''; kind.textContent = ''; notice.textContent = ''; controls(); void refresh(); },
    changed() { epoch++; client = api.bind(); busy = false; controls(); void refresh(); },
    dispose() { disposed = true; epoch++; root.remove(); },
  };
}
