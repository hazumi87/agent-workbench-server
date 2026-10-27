import {defaultRequest, recipeApprovalPatch, approvalSnapshot, trustSnapshot, serverFolder} from './policy.mjs';

// api is injected by the browser facade. No Electron, fetch, storage, launch or trust side effects on construction.
// Its four methods accept {signal}; the transport must bound requests and reject HTTP error responses.
export function createSetupSettings({api, section = 'both', onChange = () => {}}) {
  if (!['both','agents','folders'].includes(section)) throw new Error('invalid-section');
  let alive = true, visible = false, epoch = 0, active = null, refreshRequired = false;
  let state = empty();
  function empty() { return {status:'idle', approval:null, folders:null, error:null}; }
  const snapshot = () => structuredClone(state);
  const publish = patch => { state = {...state, ...patch}; onChange(snapshot()); };
  const current = operation => alive && visible && operation.epoch === epoch && active === operation;
  function invalidate() {
    epoch++; visible = false; active?.abort.abort(); refreshRequired = false; state = empty(); onChange(snapshot());
  }
  function start() {
    if (!alive || !visible) return {error:'inactive'};
    if (active) return {error:'busy'};
    const operation = {epoch, abort:new AbortController()}; active = operation;
    return operation;
  }
  async function perform(work, kind) {
    const operation = start();
    if (operation.error) return {ok:false, error:operation.error};
    publish({status:kind === 'load' ? 'loading' : 'saving', error:null});
    const options = {signal:operation.abort.signal, current:() => current(operation)};
    const check = () => { if (!current(operation)) throw new Error('stale'); };
    try {
      const patch = await work(options, check);
      check(); refreshRequired = false; publish({...patch, status:'ready', error:null});
      return {ok:true};
    } catch (failure) {
      if (!current(operation)) return {ok:false,error:'stale'};
      const refused = kind !== 'load' && failure?.code === 'settings-refused' && [400,401,403,404,409,413,422].includes(failure.status);
      if (refused) { publish({status:'ready',error:'save-refused'}); return {ok:false,error:'save-refused'}; }
      refreshRequired = kind !== 'load';
      const error = kind === 'load' ? 'load-failed' : 'save-unconfirmed';
      publish({status:'error', error}); return {ok:false,error};
    } finally {
      // Keep admission while an aborted transport is still settling; never overlap writes across views.
      if (active === operation) active = null;
    }
  }
  function canSave() {
    if (!alive || !visible) return 'inactive';
    if (active) return 'busy';
    if (refreshRequired) return 'refresh-required';
    if (state.status !== 'ready') return 'not-ready';
    return null;
  }
  return Object.freeze({
    state:snapshot,
    async show() {
      if (!alive) return {ok:false,error:'inactive'};
      visible = true;
      return perform(async (options, check) => {
        const [approval, trust] = await Promise.all([section !== 'folders' ? api.readApproval(options) : null, section !== 'agents' ? api.readTrust(options) : null]);
        check(); return {approval:approval === null ? null : approvalSnapshot(approval), folders:trust === null ? null : trustSnapshot(trust)};
      }, 'load');
    },
    hide:invalidate,
    reset:invalidate,
    destroy() { invalidate(); alive = false; },
    async setDefault(value, acknowledged = false) {
      if (section === 'folders') return {ok:false,error:'wrong-section'};
      const error = canSave(); if (error) return {ok:false,error};
      let body;
      try { body = defaultRequest(value, acknowledged, state.approval?.autoApproveDisclosedAt); } catch (error) { return {ok:false,error:error.message}; }
      return perform(async (options, check) => {
        const reply = await api.writeApproval(body, options); check();
        const approval = approvalSnapshot(reply);
        if (approval.default !== body.default) throw new Error('unconfirmed');
        return {approval};
      }, 'save');
    },
    async setRecipe(id, setting, acknowledged = false) {
      if (section === 'folders') return {ok:false,error:'wrong-section'};
      const error = canSave(); if (error) return {ok:false,error};
      if (!state.approval.recipes.some(row => row.id === id)) return {ok:false,error:'unknown-recipe'};
      let patch;
      try { patch = recipeApprovalPatch(setting, state.approval.autoApproveDisclosedAt, acknowledged); } catch (error) { return {ok:false,error:error.message}; }
      return perform(async (options, check) => {
        // The recipe owner preserves the full record and checks options.current before its POST.
        const reply = await api.writeRecipeApproval(id, patch, options); check();
        if (reply?.ok !== true) {
          if (reply?.unconfirmed !== true && [400,401,403,404,409,413,422].includes(reply?.status)) throw {code:'settings-refused',status:reply.status};
          throw new Error('unconfirmed');
        }
        const raw = await api.readApproval(options); check();
        const approval = approvalSnapshot(raw);
        if (approval.recipes.find(row => row.id === id)?.setting !== setting) throw new Error('unconfirmed');
        return {approval};
      }, 'save');
    },
    async setTrust(path, trusted, confirmed = false) {
      if (section === 'agents') return {ok:false,error:'wrong-section'};
      const error = canSave(); if (error) return {ok:false,error};
      if (confirmed !== true) return {ok:false,error:'confirmation-required'};
      if (!serverFolder(path) || typeof trusted !== 'boolean') return {ok:false,error:'invalid-folder'};
      return perform(async (options, check) => {
        const reply = await api.writeTrust({path, trusted}, options); check();
        const folders = trustSnapshot(reply);
        if (folders.some(row => row.path === path) !== trusted) throw new Error('unconfirmed');
        return {folders};
      }, 'save');
    },
  });
}
