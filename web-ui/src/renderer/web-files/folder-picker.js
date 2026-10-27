import {createServerFolderPicker} from './folder-picker-model.js';
import {createServerFolderPickerView} from './folder-picker-view.js';

// Promise seam for recipe/setup/trust consumers. One chooser at a time. The
// selected server path is not a permission grant; saves are checked by engine.
export function createServerFolderChooser({load,createDirectory,current=()=>true,document=globalThis.document,mount,makeView=createServerFolderPickerView}={}){
 if(typeof load!=='function')throw TypeError('Directory loader required');
 let active=null,disposed=false;
 const live=scope=>{try{return !disposed&&current()===true&&scope()===true;}catch{return false;}};
 function finish(operation,result){
  if(operation.finished)return;operation.finished=true;
  if(active===operation)active=null;
  operation.signal?.removeEventListener('abort',operation.cancel);
  try{operation.view?.destroy();}finally{operation.model?.destroy();operation.resolve(result);}
 }
 return Object.freeze({
  choose({signal,current:scope=()=>true,initialPath=null}={}){
   if(signal?.aborted||!live(scope))return Promise.resolve({ok:false,code:'changed'});
   if(active)return Promise.resolve({ok:false,code:'busy'});
   let resolve;const promise=new Promise(done=>resolve=done);
   const operation={resolve,signal,finished:false,view:null,model:null,cancel:null};active=operation;
   operation.cancel=()=>finish(operation,{ok:false,code:'changed'});
   try{
    operation.model=createServerFolderPicker({load,createDirectory,current:()=>!operation.finished&&live(scope),onState:state=>operation.view?.render(state)});
    operation.view=makeView({model:operation.model,document,mount:mount||document?.body,
     onChoose:selection=>finish(operation,live(scope)?{ok:true,path:selection.id}:{ok:false,code:'changed'}),
     onCancel:result=>finish(operation,{ok:false,code:result?.code==='changed'?'changed':'cancelled'})});
    signal?.addEventListener('abort',operation.cancel,{once:true});
    if(signal?.aborted||!live(scope))operation.cancel();
    else Promise.resolve(operation.view.open()).then(async result=>{
     if(result?.code==='changed'){operation.cancel();return;}
     if(result?.ok&&typeof initialPath==='string'&&initialPath.startsWith('/')&&initialPath!==operation.model.state().directory?.id){
      const navigation=await operation.model.goPath(initialPath);if(navigation?.code==='changed')operation.cancel();
     }
    },()=>finish(operation,{ok:false,code:'unavailable'}));
   }catch{finish(operation,{ok:false,code:'unavailable'});}
   return promise;
  },
  dispose(){disposed=true;if(active)finish(active,{ok:false,code:'changed'});},
 });
}
