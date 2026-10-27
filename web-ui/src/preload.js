'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const INBOUND = new Set([
  'init',
  'recipes:changed', // step 3c: the recipes list after a change here, on another computer, or a pull
  'recipes:offline',
  'recipes:local-sync-status', // skipped local recipe names, never credentials
  'recipes:local-sync-error', // main-only local sync failures, no credentials
  'broker:groups', // step 3d: the rail's groups (the brokers' own lists) and the one-time kept-running line
  'sessions:offer', // step 4: the offer after an interruption and Recently closed
  'programs:changed', // 0.12.4: a program's detection changed (an Install pane ended, a check ran)
  'console:state', // 0.12.2: the Console tab's frame (ok, can't load) and its terminal link
  'console:terminal',
  'console:terminal-refused',
  'session:data',
  'session:exit',
  'session:adopt',
  'sessions:update',
  'win:max',
  'tab:activate',
  'snapshot:req',
  'debug',
  'drop:preview',
  'drop:clear',
  'concierge:taken',
  'concierge:reload', // D3: Reload when stuck's strips (typing, reloading, restarting, reloaded, failed, paused)
  'modules:changed',
  'modules:frame-revoke', // Tasks seam S4: main stopped a module frame's navigation; close its port
  'session:route',
  'session:gap',
  'session:typing-paused',
  'session:hide-req',
  'session:moved-away',
  'prefs:changed',
  'scratchpad:changed',
  'update:ready',
  'update:progress',
  'accounts:changed',
  'accounts:switched',
  'rooms:account',
  'room-templates:view',
  'accounts:signed-in',
  'accounts:servers',
  'accounts:access-news',
  'app:show-servers',
  'accounts:link',
  'rooms:status', // W1: the Workrooms tab's room-service client (src/rooms): the strip state, the cards, the line
  'rooms:rooms',
  'rooms:line',
  'rooms:read',
  'rooms:room',
  'rooms:seat',
  'rooms:scratchpad', // W2: notes and assets changed in a room
  'rooms:tasks', // Tasks seam S5: a room's tasks changed, ids only (src/rooms/task-events.js)
  'keys:state', // 5a: the station key's card, the ledger, the reminder
  'keys:progress', // 5a: a refresh's four steps
  'keys:resume', // 5a: a refresh finished at start (rule 8)
]);

// One authoritative selection snapshot for account-bound IPC. A late boot reply cannot undo a switch.
let selectionScope = { accountId: null, selectionVersion: -1 };
function selectedScope() { return { ...selectionScope }; }
function acceptSelection(st) {
  if (!st || !Number.isSafeInteger(st.selectionVersion) || st.selectionVersion < 0) return;
  if (st.selectionVersion >= selectionScope.selectionVersion) {
    selectionScope = { accountId: st.activeAccount || null, selectionVersion: st.selectionVersion };
  }
}
ipcRenderer.on('accounts:changed', (_e, st) => acceptSelection(st));
ipcRenderer.on('rooms:account', (_e, st) => acceptSelection({ activeAccount: st?.accountId, selectionVersion: st?.selectionVersion }));
const selectedScopeReady = ipcRenderer.invoke('accounts:state').then(acceptSelection).catch(() => {
  if (selectionScope.selectionVersion < 0) selectionScope = { accountId: null, selectionVersion: 0 }; // Accounts absent: mode A
});
function sameScope(a, b) {
  return !!a && !!b && a.selectionVersion >= 0 && a.accountId === b.accountId && a.selectionVersion === b.selectionVersion;
}
// Capture before awaiting startup or IPC: an A -> B -> A switch cannot retarget a
// Concierge operation that began for an older selection.
async function conciergeCall(invoke) {
  let scope = selectedScope();
  await selectedScopeReady;
  if (scope.selectionVersion < 0) scope = selectedScope();
  if (!sameScope(scope, selectedScope())) return { error: 'account-changed' };
  const result = await invoke(scope);
  return sameScope(scope, selectedScope()) ? result : { error: 'account-changed' };
}
// Main owns this generation. A renderer-local counter cannot reject an old
// window's request that arrives before that window receives the change event.
let scratchpadFolderGeneration = null;
function acceptScratchpadGeneration(value) {
  if (Number.isSafeInteger(value) && value >= 0 &&
      (scratchpadFolderGeneration === null || value >= scratchpadFolderGeneration)) scratchpadFolderGeneration = value;
}
ipcRenderer.on('scratchpad:changed', (_e, change) => acceptScratchpadGeneration(change?.folderGeneration));
function scratchpadApi(bound) {
  const scope = () => bound ? bound.selection : selectedScope();
  const current = () => (!bound || bound.folderGeneration === null || bound.folderGeneration === scratchpadFolderGeneration) && sameScope(scope(), selectedScope());
  const invoke = async (verb, request) => {
    await selectedScopeReady;
    if (!current()) return { ok: false, reason: 'scope-changed' };
    const selection = scope();
    const accountCurrent = () => sameScope(selection, selectedScope());
    // A new bound client may be made before the first discovery reply. Capture
    // exactly one authoritative generation before it can send any data action.
    if (verb === 'location' || (bound ? bound.folderGeneration === null : scratchpadFolderGeneration === null)) {
      const location = await ipcRenderer.invoke('scratchpad:location', { scope: selection });
      if (!accountCurrent()) return { ok: false, reason: 'scope-changed' };
      acceptScratchpadGeneration(location?.folderGeneration);
      if (bound && bound.folderGeneration === null && Number.isSafeInteger(location?.folderGeneration) && location.folderGeneration >= 0) bound.folderGeneration = location.folderGeneration;
      if (!current()) return { ok: false, reason: 'scope-changed' };
      if (verb === 'location') return location;
      if (!Number.isSafeInteger(bound ? bound.folderGeneration : scratchpadFolderGeneration)) return { ok: false, reason: 'storage-unavailable' };
    }
    const generation = bound ? bound.folderGeneration : scratchpadFolderGeneration;
    const result = await ipcRenderer.invoke('scratchpad:' + verb, { scope: selection, folderGeneration: generation, request });
    if (!accountCurrent()) return { ok: false, reason: 'scope-changed' };
    // Own folder changes deliberately revoke the old binding; the successful
    // result may still be shown and the page rebinds before its next operation.
    const changesFolder = verb === 'chooseFolder' || verb === 'useDefault' || verb === 'useFoundFolder';
    if (changesFolder) acceptScratchpadGeneration(result?.folderGeneration);
    if (!changesFolder && (!current() || generation !== scratchpadFolderGeneration)) return { ok: false, reason: 'scope-changed' };
    return result;
  };
  return {
    bind: () => scratchpadApi({ selection: scope(), folderGeneration: bound ? bound.folderGeneration : scratchpadFolderGeneration }),
    current,
    location: () => invoke('location'),
    chooseFolder: () => invoke('chooseFolder'),
    useDefault: () => invoke('useDefault'),
    useFoundFolder: (...args) => args.length ? Promise.resolve({ ok: false, reason: 'invalid-request' }) : invoke('useFoundFolder'),
    list: () => invoke('list'),
    createNote: text => invoke('createNote', { text }),
    saveNote: (id, text, revision) => invoke('saveNote', { id, text, revision }),
    closeNote: id => invoke('closeNote', { id }),
    importAssets: () => invoke('importAssets'),
    importAsset: input => {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).some(key => !['name', 'type', 'bytes'].includes(key)) ||
          typeof input.name !== 'string' || input.name.length > 4096 ||
          (input.type !== undefined && (typeof input.type !== 'string' || input.type.length > 128)) ||
          !(input.bytes instanceof Uint8Array)) return Promise.resolve({ ok: false, reason: 'invalid-request' });
      if (input.bytes.byteLength > 25 * 1024 * 1024) return Promise.resolve({ ok: false, reason: 'too-large' });
      return invoke('importAsset', { name: input.name, type: input.type, bytes: new Uint8Array(input.bytes) });
    },
    removeMissingAsset: id => typeof id === 'string' && id.length <= 80
      ? invoke('removeMissingAsset', { id }) : Promise.resolve({ ok: false, reason: 'invalid-id' }),
    openAsset: id => invoke('openAsset', { id }),
    showFolder: () => invoke('showFolder'),
  };
}
function codexApi(bound) {
  const scope = () => bound === undefined ? selectedScope() : bound;
  const invoke = async (verb, request) => {
    await selectedScopeReady;
    return ipcRenderer.invoke('codex:' + verb, { scope: scope(), request });
  };
  return {
    bind: () => codexApi(scope()),
    current: () => sameScope(scope(), selectedScope()),
    list: () => invoke('list'),
    open: (id, mode) => invoke('open', { id, ...(mode ? { mode } : {}) }),
    state: id => invoke('state', { id }),
    submit: (id, submissionId, text) => invoke('submit', { id, submissionId, text }),
    pending: id => invoke('pending', { id }),
    check: (id, submissionId, recovered) => invoke('check', { id, [recovered === true ? 'receiptId' : 'submissionId']: submissionId }),
    sendPending: (id, submissionId, recovered) => invoke('sendPending', { id, [recovered === true ? 'receiptId' : 'submissionId']: submissionId }),
    respond: (id, requestId, decision) => invoke('respond', { id, requestId, decision }),
    close: id => invoke('close', { id }),
  };
}
function roomApi(bound) {
  const getScope = () => bound === undefined ? selectedScope() : bound;
  const invoke = (channel, ...args) => ipcRenderer.invoke(channel, { scope: getScope(), args });
  const send = (channel, ...args) => ipcRenderer.send(channel, { scope: getScope(), args });
  return {
    bind: () => roomApi(getScope()),
    scope: () => ({ ...getScope() }),
    current: () => sameScope(getScope(), selectedScope()),
    status: async () => { await selectedScopeReady; return invoke('rooms:status'); },
    signIn: (username, password) => invoke('rooms:signin', { username, password }),
    signOut: () => invoke('rooms:signout'),
    list: (force) => invoke('rooms:list', { force: !!force }),
    room: (id) => invoke('rooms:room', { id }),
    connection: (id, connected) => invoke('rooms:connection', { id, connected }),
    line: (id, opts) => invoke('rooms:line', { id, ...(opts || {}) }),
    search: (id, q, limit) => invoke('rooms:search', { id, q, limit }),
    seen: (id, lastId) => invoke('rooms:seen', { id, lastId }),
    retry: () => invoke('rooms:retry'),
    visible: (tab, roomId) => send('rooms:visible', { tab: !!tab, roomId: roomId || null }),
    thumb: (roomId, name, w) => invoke('rooms:thumb', { roomId, name, w }),
    image: (roomId, name) => invoke('rooms:image', { roomId, name }),
    download: (roomId, name) => invoke('rooms:download', { roomId, name }),
    openWindow: (roomId, name) => invoke('rooms:open-window', { roomId, name }),
    me: (patch) => invoke('rooms:me', patch || {}),
    picture: () => invoke('rooms:picture'),
    // W2: the write side
    post: (id, a) => invoke('rooms:post', { id, ...(a || {}) }),
    tasks: (a) => invoke('rooms:tasks', a), // Tasks seam S4 step 5: a module page's call, admitted in main
    tasksApprove: (a) => invoke('rooms:tasks-approve', a),
    draft: (id) => invoke('rooms:draft', { id }),
    setDraft: (id, text, reply_to) => invoke('rooms:draft-set', reply_to === undefined ? { id, text } : { id, text, reply_to }),
    scratch: (id) => invoke('rooms:scratch', { id }),
    scratchUpload: (id, name, type, bytes, key, pos) => invoke('rooms:scratch-upload', { id, name, type, bytes, key, pos }),
    scratchRemove: (id, fileId) => invoke('rooms:scratch-remove', { id, fileId }),
    scratchOrder: (id, ids) => invoke('rooms:scratch-order', { id, ids }),
    assets: (id) => invoke('rooms:assets', { id }),
    notes: (id, q) => invoke('rooms:notes', { id, q }),
    note: (id, nid) => invoke('rooms:note', { id, nid }),
    noteCreate: (id, text) => invoke('rooms:note-create', { id, text }),
    noteSet: (id, nid, text) => invoke('rooms:note-set', { id, nid, text }),
    noteAttach: (id, nid) => invoke('rooms:note-attach', { id, nid }),
    noteClose: (id, nid) => invoke('rooms:note-close', { id, nid }),
    commands: () => invoke('rooms:commands'),
    pickFiles: () => invoke('rooms:pick-files'),
    // W3: people (rooms, workgroups, the room's lead, mode, brief and state, the seats)
    create: (a) => invoke('rooms:create', a || {}),
    patch: (id, a) => invoke('rooms:patch', { id, ...(a || {}) }),
    state: (id, verb) => invoke('rooms:state', { id, verb }),
    workgroup: (id, a) => invoke('rooms:workgroup', { id, ...(a || {}) }),
    familyCheck: (id, a) => invoke('rooms:family-check', { id, ...(a || {}) }),
    seatAdd: (id, a) => invoke('rooms:seat-add', { id, ...(a || {}) }),
    seatPatch: (id, sid, a) => invoke('rooms:seat-patch', { id, sid, ...(a || {}) }),
    seatRemove: (id, sid) => invoke('rooms:seat-remove', { id, sid }),
    seatHistory: (id, sid) => invoke('rooms:seat-history', { id, sid }),
    seatMove: (id, sid, to) => invoke('rooms:seat-move', { id, sid, to }),
    seatStart: (id, sid, a) => invoke('rooms:seat-start', { id, sid, ...(a || {}) }),
    wakeDeliver: (id, sid, lineId) => invoke('rooms:wake-deliver', { id, sid, lineId }),
    seatEnd: (id, sid, paneid) => invoke('rooms:seat-end', { id, sid, paneid }),
    seatDisconnect: (id, sid) => invoke('rooms:seat-disconnect', { id, sid }),
    seatProfile: (id, sid, p) => invoke('rooms:seat-profile', { id, sid, ...(p && 'model' in p ? { model: p.model } : {}), ...(p && 'effort' in p ? { effort: p.effort } : {}) }),
    seatCloseWindow: (id, sid) => invoke('rooms:seat-close-window', { id, sid }),
    seatReloadPreview: (id, sid) => invoke('rooms:seat-reload-preview', { id, sid }),
    seatReload: (id, sid, a) => invoke('rooms:seat-reload', { id, sid, ...(a || {}) }),
    settings: (id, a) => invoke('rooms:settings', { id, ...(a || {}) }),
    presence: () => invoke('rooms:presence'),
    recipes: () => invoke('rooms:recipes'),
    deliverHeld: (id, paneid) => invoke('rooms:deliver-held', { id, paneid }),
    // History export: fixed scoped calls; the renderer never receives an engine address or token.
    historyGet: () => invoke('rooms:history-get'),
    historySet: enabled => invoke('rooms:history-set', { enabled }),
    historyExport: roomId => invoke('rooms:history-export', { roomId }),
    historyStart: () => invoke('rooms:history-start'),
    historyCancel: () => invoke('rooms:history-cancel'),
  };
}

// Unmounted unless the separate feature argv is supplied by an admitted host.
// Results stay plain data: contextBridge does not preserve custom Error fields.
function roomTemplatesApi(bound) {
  if (!bound) {
    let cached=null;const listeners=new Set();
    const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
    ipcRenderer.on('room-templates:view',(_event,message)=>{
      if(!exact(message,['scope','ticket'])||!exact(message.scope,['accountId','selectionVersion'])||message.scope.accountId!==null||!sameScope(message.scope,selectedScope()))return;
      const t=message.ticket;if(t!==null&&(!exact(t,['viewId','viewEpoch'])||typeof t.viewId!=='string'||t.viewId.length>160||!Number.isSafeInteger(t.viewEpoch)||t.viewEpoch<1))return;
      cached=Object.freeze({scope:Object.freeze({...message.scope}),ticket:t===null?null:Object.freeze({viewId:t.viewId,viewEpoch:t.viewEpoch})});
      for(const fn of listeners){try{fn(cached);}catch{}}
    });
    return Object.freeze({bind:ticket=>roomTemplatesApi({ticket:Object.freeze({viewId:ticket?.viewId,viewEpoch:ticket?.viewEpoch}),scope:selectedScope()}),
      onView:fn=>{if(typeof fn!=='function')return ()=>{};listeners.add(fn);if(cached&&sameScope(cached.scope,selectedScope()))fn(cached);return ()=>listeners.delete(fn);}});
  }
  let closed=false;
  const call=async(verb,input={})=>{
    if(closed)return {ok:false,code:'stale'};
    const closing=verb==='closeView';
    if(closing)closed=true;
    await selectedScopeReady;
    if(bound.scope.selectionVersion<0)bound.scope=selectedScope();
    if((closed&&!closing)||!sameScope(bound.scope,selectedScope())||bound.scope.accountId!==null)return {ok:false,code:'stale'};
    try {
      const result=await ipcRenderer.invoke(verb==='requestDiscard'?'room-templates:discard-request':'room-templates:call',
        verb==='requestDiscard'?{scope:{...bound.scope},ticket:bound.ticket}:{scope:{...bound.scope},ticket:bound.ticket,verb,input});
      if((closed&&!closing)||!sameScope(bound.scope,selectedScope()))return {ok:false,code:'stale'};
      return result;
    } catch {return {ok:false,code:'unavailable'};}
  };
  return Object.freeze({getState:()=>call('getState'),getSaveView:input=>call('getSaveView',input),
    create:input=>call('create',input),save:input=>call('save',input),rename:input=>call('rename',input),remove:input=>call('remove',input),
    folderForm:input=>call('folderForm',input),pickFolder:input=>call('pickFolder',input),applyFolder:input=>call('applyFolder',input),closeView:()=>call('closeView'),requestDiscard:()=>call('requestDiscard')});
}

function agentSetupApi() {
  const call = async (verb, input) => {
    const result=await ipcRenderer.invoke('agent-setup:call',verb,input);
    if(!result?.ok){
      // contextBridge does not preserve custom Error properties. Folder refusals
      // are fixed data so the page can offer consent without native error text.
      if(['chooseCodeFolder','saveCodeFolder'].includes(verb)){
        const codes=['code-folder-synced','code-folder-system','code-folder-network','code-folder-root','code-folder-absolute','code-folder-protected','code-folder-unwritable'];
        return {ok:false,code:codes.includes(result?.code)?result.code:'agent-setup-unavailable'};
      }
      throw Error('Agent setup unavailable');
    }
    return result.value;
  };
  return {getState:()=>call('state'),check:()=>call('check'),cancel:()=>call('cancel'),
    select:value=>call('select',value),finish:()=>call('finish'),
    chooseCodeFolder:()=>call('chooseCodeFolder'),saveCodeFolder:value=>call('saveCodeFolder',value),
    install:id=>call('install',id),cancelInstall:()=>call('cancelInstall'),terminalRead:value=>call('terminalRead',value),
    terminalWrite:value=>call('terminalWrite',value),terminalResize:value=>call('terminalResize',value)};
}

function localSetupApi() {
  const call = async (method, value) => {
    const result = await ipcRenderer.invoke('local-setup:call', method, value);
    if (!result?.ok && method === 'completeSetup' && ['scratchpad-choice-required','setup-state-changed'].includes(result?.code)) {
      return {ok:false,code:result.code,refresh:true};
    }
    if (!result?.ok) throw Object.assign(Error(result?.message || 'Local setup unavailable'), {code:result?.code});
    return result.value;
  };
  const api = {ownsLocalHistory:true};
  for (const method of ['getState','chooseFolder','checkFolder','completeSetup','cancelSetup','setupProgress','changeFiles','openFolder',
    'setHistoryEnabled','exportHistory','startHistoryExport','cancelExport','restartLocalRooms','selectRoomPlace','restoreStarterFiles']) api[method] = value => call(method,value);
  api.subscribe = fn => {
    const listener = () => { void call('getState').then(fn).catch(()=>{}); };
    ipcRenderer.on('local-setup:changed',listener); return () => ipcRenderer.removeListener('local-setup:changed',listener);
  };
  api.registerNotesGuard = (check, lock) => {
    const held = new Set();
    const listener = (_event, request) => {
      if (typeof request?.nonce !== 'string') return;
      if (!request.lock) { held.delete(request.nonce); lock(held.size>0); return; }
      let clean=false; try { clean=check()===true; if(clean){held.add(request.nonce);lock(true);} } catch {}
      ipcRenderer.send('local-setup:notes-answer',{nonce:request.nonce,clean});
    };
    ipcRenderer.on('local-setup:notes-check',listener);
    return () => {ipcRenderer.removeListener('local-setup:notes-check',listener);held.clear();lock(false);};
  };
  return api;
}

// Separate default-off starter feature. Never wrap/proxy the contextBridge object.
function starterRoomsApi(bound) {
  let captured=bound;
  const scope = () => captured == null ? selectedScope() : captured;
  const call = async (verb, input) => {
    await selectedScopeReady;
    if(captured===null)captured=selectedScope();
    const wanted = scope();
    if (!sameScope(wanted, selectedScope()) || wanted.accountId !== null) throw Error('Starter rooms changed. Open the room again.');
    const result = await ipcRenderer.invoke('starter-rooms:call', {scope:wanted,verb,input});
    if (!sameScope(wanted, selectedScope())) throw Error('Starter rooms changed. Open the room again.');
    if (!result?.ok) throw Object.assign(Error(result?.error || 'Starter rooms unavailable.'), {code:result?.code,field:result?.field});
    return result.value;
  };
  return Object.freeze({bind:()=>starterRoomsApi(selectedScope().selectionVersion<0?null:scope()),open:input=>call('open',input),openRoom:input=>call('openRoom',input),
    status:input=>call('status',input),startSeat:input=>call('startSeat',input),startTeam:input=>call('startTeam',input),
    preferences:()=>call('preferences'),setAutoStart:enabled=>call('setAutoStart',{enabled}),
    terminalIntent:(first,second)=>ipcRenderer.invoke('starter:terminal-intent',{seatId:String(second===undefined?first:second)}) /* (seatId), or the earlier (roomId, seatId): main derives the room either way */});
}

contextBridge.exposeInMainWorld('wb', {
  ...(typeof process !== 'undefined' && process.argv?.includes('--wb-room-templates') ? {roomTemplates:roomTemplatesApi()} : {}),
  ...(typeof process !== 'undefined' && process.argv?.includes('--wb-starter-workrooms') ? {starterRooms:starterRoomsApi()} : {}),
  ...(typeof process !== 'undefined' && process.argv?.includes('--wb-agent-setup') ? {agentSetup:agentSetupApi()} : {}),
  ...(typeof process !== 'undefined' && process.argv?.includes('--wb-local-setup') ? {localSetup:localSetupApi()} : {}),
  scratchpad: scratchpadApi(),
  codex: codexApi(),
  on: (channel, fn) => {
    if (!INBOUND.has(channel) || typeof fn !== 'function') return () => {};
    let active = true;
    const listener = (_e, payload) => { if (active) fn(payload); };
    ipcRenderer.on(channel, listener);
    return () => {
      if (!active) return;
      active = false;
      ipcRenderer.removeListener(channel, listener);
    };
  },
  createSession: async (cols, rows, spec, launch) => {
    await selectedScopeReady;
    return ipcRenderer.invoke('session:create', { cols, rows, spec, ...(launch || {}), scope: launch?.scope || selectedScope() });
  },
  permit: () => ipcRenderer.invoke('session:permit'),
  startupDone: () => ipcRenderer.send('startup:done'),
  seen: (sid, how) => ipcRenderer.send('session:seen', { sid, how }),
  paneActive: (sid) => ipcRenderer.send('pane:active', sid),
  retrySession: (sid, opts) => ipcRenderer.send('session:retry', { sid, ...(opts || {}), scope: selectedScope() }),
  createConcierge: (cols, rows) => conciergeCall(scope => ipcRenderer.invoke('concierge:create', { cols, rows, scope })),
  conciergeReload: (act) => ipcRenderer.send('concierge:reload-' + (act === 'retry' || act === 'dismiss' ? act : 'cancel'), selectedScope()), // D3
  reportState: (st) => ipcRenderer.send('state:report', st),
  moduleSet: (p) => ipcRenderer.invoke('modules:set', p),
  modulesRescan: () => ipcRenderer.invoke('modules:rescan'),
  moduleStorage: (p) => ipcRenderer.invoke('modules:storage', p),
  moduleFrameExpect: (p) => ipcRenderer.invoke('modules:frame-expect', p),
  moduleWindowOpen: (p) => ipcRenderer.invoke('modules:window-open', p), // S3: the pop-out, checked again in main
  moduleTheme: (roles) => ipcRenderer.send('modules:theme', roles), // S3: the theme roles for module windows
  moduleCardAdmit: (p) => ipcRenderer.invoke('modules:card-admit', p), // revision 10: main admits each rail card
  moduleCardRelease: (p) => ipcRenderer.invoke('modules:card-release', p),
  input: (sid, data) => ipcRenderer.send('session:input', { sid, data, scope: selectedScope() }),
  resize: (sid, cols, rows) => ipcRenderer.send('session:resize', { sid, cols, rows, scope: selectedScope() }),
  closeSession: (sid) => ipcRenderer.send('session:close', sid, selectedScope()),
  setTitle: (sid, title) => ipcRenderer.send('session:title', { sid, title }),
  attached: (sid, cols, rows) => ipcRenderer.send('session:attached', { sid, cols, rows, scope: selectedScope() }),
  snapshotReply: (reqId, snapshot) => ipcRenderer.send('snapshot:reply', { reqId, snapshot }),
  dragStart: (sid, snapshot) => ipcRenderer.invoke('drag:start', { sid, snapshot }),
  dragMove: () => ipcRenderer.send('drag:move'),
  dragEnd: () => ipcRenderer.send('drag:end'),
  focusSession: (sid) => ipcRenderer.send('flyout:focus', sid),
  hideSession: (sid, snapshot) => ipcRenderer.send('session:hide', { sid, snapshot }),
  hideRemote: (sid) => ipcRenderer.send('session:hideRemote', sid),
  moveHere: (sid, x, y) => ipcRenderer.send('session:moveHere', { sid, x, y }),
  programsList: () => ipcRenderer.invoke('programs:list'),
  programsSet: (p) => ipcRenderer.invoke('programs:set', p),
  programsDetect: (id) => ipcRenderer.invoke('programs:detect', id),
  recipeImport: Object.freeze({
    open:()=>ipcRenderer.invoke('recipes:import-open'),
    folder:operationId=>ipcRenderer.invoke('recipes:import-folder',{operationId}),
    cancel:operationId=>ipcRenderer.invoke('recipes:import-cancel',{operationId}),
    commit:input=>ipcRenderer.invoke('recipes:import-commit',input),
  }),
  recipesList: () => ipcRenderer.invoke('recipes:list'),
  recipesSave: (p) => ipcRenderer.invoke('recipes:save', p),
  recipesDelete: (id) => ipcRenderer.invoke('recipes:delete', id),
  recipesDuplicate: (id) => ipcRenderer.invoke('recipes:duplicate', id),
  recipesFolderForm: (formId, context, recipeId) => ipcRenderer.invoke('recipes:folder-form', { formId: String(formId), context: String(context), recipeId: recipeId == null ? null : String(recipeId) }),
  recipesPickFolder: (mode, formId) => ipcRenderer.invoke('recipes:pick-folder', { mode: String(mode), formId: String(formId) }),
  recipesCheckFolder: (serverId, folder) => ipcRenderer.invoke('recipes:check-folder', { serverId, folder }),
  recipesSync: () => ipcRenderer.invoke('recipes:sync'),
  recipesSetup: (serverId, folder, programId) => ipcRenderer.invoke('recipes:setup', { serverId, folder, programId }),
  // step 3d: the brokers' lists now, and End on a CLI no pane here holds
  termControl: (sid, take) => ipcRenderer.invoke('session:term-control', { sid, take: !!take }), // W3b
  brokerGroups: () => ipcRenderer.invoke('broker:groups'),
  brokerModules: (request) => ipcRenderer.invoke('broker:modules', request),
  brokerEnd: (serverId, bsid) => ipcRenderer.invoke('broker:end', { serverId, bsid }),
  // 0.12.2: the Console tab (the realm's console in a view of its own, bounded to the renderer's slot)
  consoleOpen: (bounds, theme) => ipcRenderer.invoke('console:open', bounds, theme), // 0.12.5: theme rides on the address
  consoleBounds: (bounds) => ipcRenderer.send('console:bounds', bounds),
  consoleHide: () => ipcRenderer.send('console:hide'),
  consoleReload: (theme) => ipcRenderer.invoke('console:reload', theme),
  consoleHandoffAgain: () => ipcRenderer.invoke('console:handoff-again'), // 3d: "Open it again" on the hand-off strip
  consoleInfo: () => ipcRenderer.invoke('console:info'),
  consoleTestNavigate: (url) => ipcRenderer.invoke('console:test-navigate', url),
  consoleTestEval: (js) => ipcRenderer.invoke('console:test-eval', js),
  consoleTestWaitLoad: (ms) => ipcRenderer.invoke('console:test-wait-load', ms),
  consoleTestAuthenticator: () => ipcRenderer.invoke('console:test-authenticator'),
  consoleTestShot: (file) => ipcRenderer.invoke('console:test-shot', file),
  consoleTestCredentials: (id) => ipcRenderer.invoke('console:test-credentials', id),
  consoleTestFocus: () => ipcRenderer.invoke('console:test-focus'),
  // W1 (Workrooms read): the narrow door to the rooms client in main
  // 5a: the keys fallback (main's keyflow)
  keys: {
    state: () => ipcRenderer.invoke('keys:state'),
    connect: (id) => ipcRenderer.invoke('keys:connect', id),
    checkAdded: (id) => ipcRenderer.invoke('keys:check-added', id),
    refresh: (id) => ipcRenderer.invoke('keys:refresh', id),
    cancelRefresh: (id) => ipcRenderer.invoke('keys:refresh-cancel', id),
    retireAgain: (id, fp) => ipcRenderer.invoke('keys:retire-again', id, fp),
    removeEverywhere: () => ipcRenderer.invoke('keys:remove-everywhere'),
    older: (id) => ipcRenderer.invoke('keys:older', id),
    forget: (id, line) => ipcRenderer.invoke('keys:forget', id, line),
    make: () => ipcRenderer.invoke('keys:make'),
    remind: (days) => ipcRenderer.invoke('keys:remind', days),
    snooze: () => ipcRenderer.invoke('keys:snooze'),
  },
  rooms: roomApi(),
  machineInfo: () => ipcRenderer.invoke('machine:info'),
  prefsGet: () => conciergeCall(scope => ipcRenderer.invoke('prefs:get', scope)),
  prefsSet: (p) => conciergeCall(scope => ipcRenderer.invoke('prefs:set', p, scope)),
  windowTheme: (theme) => ipcRenderer.invoke('window:theme', theme),
  updateState: () => ipcRenderer.invoke('update:state'),
  updateRestart: () => ipcRenderer.invoke('update:restart'),
  appRestart: () => ipcRenderer.invoke('app:restart'), // 0.12.4: Restart Workbench after an install
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  // step 4 (resume): the offer after an interruption, Recently closed, and a stopped row's restore spec
  sessions: {
    offer: () => ipcRenderer.invoke('sessions:offer'),
    dismiss: () => ipcRenderer.invoke('sessions:dismiss', selectedScope()),
    remove: (key) => ipcRenderer.invoke('sessions:remove', key, selectedScope()),
    restoreSpec: (key) => ipcRenderer.invoke('sessions:restore-spec', key, selectedScope()),
  },
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateAuto: (on) => ipcRenderer.invoke('update:auto', on),
  openLicenses: () => ipcRenderer.invoke('about:licenses'),
  openSession: (sid) => ipcRenderer.send('session:open', sid),
  // Accounts (step 3a): these reject when the module is absent; the renderer then shows mode A only.
  // 3e: the Servers tab (the realm's per-server API, signed in main; passkey writes open the browser)
  servers: {
    list: () => ipcRenderer.invoke('servers:list', undefined, selectedScope()),
    get: (id) => ipcRenderer.invoke('servers:get', id, selectedScope()),
    policy: (id, policy, allow) => ipcRenderer.invoke('servers:policy', { id, policy, allow }, selectedScope()),
    role: (id, person, role) => ipcRenderer.invoke('servers:role', { id, person, role }, selectedScope()),
    approve: (id, request) => ipcRenderer.invoke('servers:approve', { id, request }, selectedScope()),
    decline: (id, request, note) => ipcRenderer.invoke('servers:decline', { id, request, note }, selectedScope()),
    revoke: (id, grant, letRun) => ipcRenderer.invoke('servers:revoke', { id, grant, letRun }, selectedScope()),
    install: (id) => ipcRenderer.invoke('servers:install', id, selectedScope()),
    people: () => ipcRenderer.invoke('servers:people', undefined, selectedScope()),
    grant: (id, person, login) => ipcRenderer.invoke('servers:grant', { id, person, login }, selectedScope()),
    action: (id) => ipcRenderer.invoke('servers:action', id, selectedScope()),
    reopen: (id) => ipcRenderer.invoke('servers:reopen', id, selectedScope()),
    refreshMe: () => ipcRenderer.invoke('servers:refresh-me', undefined, selectedScope()),
  },
  accounts: {
    state: () => ipcRenderer.invoke('accounts:state'),
    begin: (address) => ipcRenderer.invoke('accounts:begin', address),
    rescope: () => ipcRenderer.invoke('accounts:rescope'),
    reopen: () => ipcRenderer.invoke('accounts:reopen'),
    cancel: () => ipcRenderer.invoke('accounts:cancel'),
    name: (name) => ipcRenderer.invoke('accounts:name', name),
    select: (id) => ipcRenderer.invoke('accounts:select', id),
    signout: (id) => ipcRenderer.invoke('accounts:signout', id),
    manage: (id) => ipcRenderer.invoke('accounts:manage', id),
    // 3b: the granted servers as the rail shows them, and piece 2's Test for one of them
    servers: () => ipcRenderer.invoke('accounts:servers'),
    testServer: (id) => ipcRenderer.invoke('accounts:test-server', id),
    // F7: Request access
    requestable: () => ipcRenderer.invoke('accounts:requestable'),
    request: (serverId, loginIds, note) => ipcRenderer.invoke('accounts:request', { serverId, loginIds, note }),
    requestAct: (id, act) => ipcRenderer.invoke('accounts:request-act', { id, act }),
  },
  // a server page's Details (3b)
  hostKey: (id) => ipcRenderer.invoke('server:host-key', id),
  forgetHostKey: (id) => ipcRenderer.invoke('server:forget-host-key', id),
  closeIfEmpty: () => ipcRenderer.send('win:closeEmpty'),
  reportMode: (mode) => ipcRenderer.send('win:mode', mode),
  arrangeTabs: () => ipcRenderer.send('arrange:tabs'),
  setMeta: (sid, name, hue) => ipcRenderer.send('session:meta', { sid, name, hue }),
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
  dlog: (event, fields) => ipcRenderer.send('debug:log', { event, fields }),
  setDebug: (on) => ipcRenderer.send('debug:set', on),
});
