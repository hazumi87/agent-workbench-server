import {createRecipeImport} from './controller.js';

// Matches the existing renderer's recipeImport facade. All authority remains
// with the foundation's server picker, folder check and recipe batch adapter.
export function createRecipeImportApi({chooseFile, pickFolder, checkFolder, importSelected, names=()=>[], randomId=()=>crypto.randomUUID()}) {
  let current = null, disposed = false;
  function cancel() { current?.chooserAbort.abort(); current?.controller.dispose(); current = null; }
  function owned(id) { return !disposed && current && current.id === id ? current : null; }
  async function open() {
    if (disposed) return {ok:false,error:'Import is no longer open.'};
    cancel();
    const op = {id:randomId(),controller:createRecipeImport({checkFolder,importSelected}),preview:null,chooserAbort:new AbortController()};
    current=op;
    try {
      // File chooser starts before any await, preserving the click gesture.
      const file = await chooseFile({signal:op.chooserAbort.signal});
      if (!owned(op.id)) return {ok:true,value:null};
      if (!file) {cancel();return {ok:true,value:null};}
      op.preview = await op.controller.open(file,{names:await names()});
      if (!owned(op.id)) return {ok:true,value:null};
      return {ok:true,value:{...op.preview,operationId:op.id,fileName:String(file.name||'recipes.json').slice(0,200)}};
    } catch {
      if (owned(op.id)) cancel();
      return {ok:false,error:"Couldn't read that recipes file. Check the file and try again."};
    }
  }
  async function folder(id) {
    const op=owned(id);
    if (!op) return {ok:false,error:'Choose the recipes file again.'};
    try {
      const value=await pickFolder({signal:op.chooserAbort.signal});
      if (!owned(id)) return {ok:false,error:'Import is no longer open.'};
      return {ok:true,value};
    } catch {return {ok:false,error:"Couldn't open the server folder picker. Try again."};}
  }
  async function commit(input) {
    const op=owned(input?.operationId);
    if (!op) return {ok:false,finished:true,error:'Choose the recipes file again.'};
    try {
      const result=await op.controller.commit(input.selections,input);
      const added=result.saved.map(index=>({name:op.preview.rows[index].name}));
      if (result.status==='complete') {
        if (owned(op.id)) cancel();
        return {ok:true,value:{added,skipped:[]}};
      }
      const prefix=added.length?`Imported ${added.length} ${added.length===1?'recipe':'recipes'}. `:'';
      return {ok:false,finished:true,unconfirmed:result.status==='unconfirmed',error:prefix+(result.status==='refused'?"The next recipe couldn't be imported. Check your recipes before starting another import.":'Import could not be confirmed. Check your recipes before trying again.')};
    } catch (e) {
      if (e.code==='folder-unavailable') return {ok:false,error:'Folder not found on this server. Choose another folder.'};
      if (e.code==='operation-finished') return {ok:false,finished:true,error:'Check your recipes before starting another import.'};
      return {ok:false,error:'Review the selected recipes and their warnings before importing.'};
    }
  }
  return Object.freeze({open,folder,commit,cancel(id){if(!id||owned(id))cancel();return {ok:true};},dispose(){disposed=true;cancel();}});
}
