'use strict';
const {createRecipeImportApi}=require('../../src/renderer/web-recipe-import/api.js');
const {chooseRecipeFile}=require('../../src/renderer/web-recipe-import/file-picker.js');

// The one recipe mapper/POST loop is wb.web.recipes.importSelected(list,{signal}).
// Its ordered results are {index,status:'saved',id} or status refused/unconfirmed,
// followed by not-sent for the rest. Stop after refusal/uncertainty, never retry a
// create, and check abort before every POST. A sent request may remain unconfirmed;
// cancellation cannot undo it. No trust, disclosure or source id transfers.
// Folder selection/loading reuse slice 3's files facade; this owns no second picker.
function register(api,{browser=globalThis,chooseFile}={}) {
  let bridge,disposed=false;
  const web=()=>browser.wb?.web;
  const ready=()=>typeof web()?.recipes?.importSelected==='function'&&typeof web()?.files?.chooseFolder==='function'&&typeof web()?.files?.directoryLoader==='function';
  const create=()=>createRecipeImportApi({
    chooseFile:options=>(chooseFile||((opts)=>chooseRecipeFile(browser,opts)))(options),
    randomId:()=>browser.crypto.randomUUID(),
    names:async()=>{const rows=await browser.wb.recipesList();if(!Array.isArray(rows))throw Error('unavailable');return rows.map(r=>r.name).filter(n=>typeof n==='string');},
    importSelected:(list,options)=>web().recipes.importSelected(list,options),
    pickFolder:async options=>{
      const result=await web().files.chooseFolder(options);
      if(result?.ok===true&&typeof result.path==='string')return result.path;
      if(['cancelled','changed'].includes(result?.code))return null;
      throw Error('unavailable');
    },
    checkFolder:async path=>{
      const load=web().files.directoryLoader({current:()=>!disposed});
      const result=await load(path);return result?.ok===true;
    },
  });
  bridge=create();
  const facade=Object.freeze({
    open:()=>ready()?bridge.open():Promise.resolve({ok:false,error:'Recipe importing is not ready on this server yet.'}),
    folder:id=>bridge.folder(id),commit:input=>bridge.commit(input),cancel:id=>bridge.cancel(id),
  });
  api.expose('recipeImport',facade);
  api.handle('recipes:import-open',()=>facade.open());
  api.handle('recipes:import-folder',([input])=>facade.folder(input?.operationId));
  api.handle('recipes:import-cancel',([input])=>facade.cancel(input?.operationId));
  api.handle('recipes:import-commit',([input])=>facade.commit(input));
  const hide=()=>bridge.dispose();
  const show=event=>{if(!disposed&&event.persisted)bridge=create();};
  browser.addEventListener('pagehide',hide);browser.addEventListener('pageshow',show);
  return ()=>{disposed=true;bridge.dispose();browser.removeEventListener('pagehide',hide);browser.removeEventListener('pageshow',show);};
}
module.exports={register};
