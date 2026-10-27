import {createRoomTemplates} from './page.js';
// Fixed-verb consumer; no renderer HTTP client or durable library lives here.
export function createTemplateController({host,api,onBuiltin=null,onFolderAction=null,onCreated=null,onClose=null}={}){
 let alive=true,shown=false,epoch=0,busy=false,held=false,view={};
 const page=createRoomTemplates({host,onAction:action});
 const current=stamp=>alive&&shown&&stamp===epoch;
 const paint=()=>{if(alive&&shown)page.show({...view,formVersion:epoch,busy,recoveryAllowed:view.enabled===true&&held,canDiscard:view.failure?.code==='held'&&typeof api?.requestDiscard==='function',enabled:view.enabled===true&&!held});};
 function failure(result){
  if(result?.code==='forbidden')return {code:'forbidden'};
  if(result?.code==='name_used')return {code:'name_used'};
  if(result?.code==='unsupported_format')return {code:'unsupported_format'};
  if(result?.code==='missing_recipe'&&result.unchanged===true)return {code:'missing_recipe',...(result.recipe?{recipe:result.recipe}:{}),...(result.recipes?{recipes:result.recipes}:{})};
  if(result?.unchanged===true&&['invalid','recipe_conflict'].includes(result.code))return {code:'refused',unchanged:true,engineCode:result.code};
  return {code:'held'};
 }
 async function show(options={}){
  if(!alive)return;const stamp=++epoch;shown=true;held=false;busy=true;
  view={scope:options.scope,enabled:options.enabled===true,screen:options.screen||'list',selectedId:options.selectedId,name:options.name,targetId:options.targetId,created:options.created,items:[]};paint();
  if(!view.enabled||typeof view.scope!=='string'||!view.scope||!api){busy=false;held=true;paint();return;}
  try{
   const state=await api.getState();if(!current(stamp))return;
   if(state?.ok!==true||!Array.isArray(state.items)||state.held===true){held=true;busy=false;view.failure={code:state?.held===true?'held':'unavailable'};paint();return;}
   view.items=[...(Array.isArray(options.starters)?options.starters.filter(r=>r?.kind==='starter'):[]),...state.items];
   if(view.screen==='save'){
    const saved=await api.getSaveView({roomId:options.roomId});if(!current(stamp))return;
    if(saved?.ok!==true){held=true;busy=false;view.failure=failure(saved);paint();return;}view.room=saved.room;
   }
   busy=false;paint();
  }catch{if(current(stamp)){held=true;busy=false;view.failure={code:'unavailable'};paint();}}
 }
 async function action(verb,payload){
  if(!alive||!shown||busy||view.enabled!==true||(held&&!['discard','cancel'].includes(verb)))return;
  const stamp=epoch;
  if(held&&verb==='cancel'){shown=false;++epoch;page.hide();onClose?.();return;}
  if(['pick','showRename','showDelete'].includes(verb)){
   const target=view.items.find(r=>r.id===payload.templateId);if(!target||target.kind!=='user')return;
   view={...view,screen:verb==='pick'?'picker':verb==='showRename'?'rename':'delete',selectedId:target.id,targetId:target.id,name:target.name,failure:null,savedName:null};paint();return;
  }
  if(verb==='view'||verb==='cancel'){view={...view,screen:'list',failure:null,savedName:null};paint();return;}
  const functions={create:'create',save:'save',rename:'rename',remove:'remove'};
  let call;
  if(verb==='discard'&&typeof api.requestDiscard==='function')call=()=>api.requestDiscard();
  else if(verb==='create'&&['blank','my-first-room','my-project'].includes(payload.templateId))call=onBuiltin&&(()=>onBuiltin(payload));
  else if(verb==='chooseFolder'||verb==='createFolder')call=onFolderAction&&(()=>onFolderAction(verb,payload));
  else if(functions[verb]&&typeof api?.[functions[verb]]==='function')call=()=>api[functions[verb]](payload);
  if(!call){held=true;view.failure={code:'held'};paint();return;}
  if(verb==='create'){view.selectedId=payload.templateId;view.name=payload.name;}
  const priorFailure=view.failure;busy=true;view.failure=null;paint();
  try{
   const result=await call();if(!current(stamp))return;
   busy=false;
   if(result?.code==='cancelled'){view.failure=priorFailure;paint();return;}
   if(result?.ok!==true){view.failure=failure(result);held=view.failure.code==='held';if(payload.name)view.name=payload.name;paint();return;}
   if(verb==='discard'){await show({scope:view.scope,enabled:true,screen:'list'});return;}
   if(result.handled===true){shown=false;++epoch;page.hide();return;}
   if(result.folder?.found===true&&view.created){view={...view,created:{...view.created,folder:'none'}};}
   else if(result.created){view={...view,screen:'created',created:result.created,failure:null,savedName:null};}
   else if(Array.isArray(result.items)){view={...view,screen:'list',items:[...view.items.filter(r=>r.kind==='starter'),...result.items],savedName:result.savedName||null,failure:null};}
   else {held=true;view.failure={code:'held'};}
   paint();
   if(result.created&&current(stamp))await onCreated?.(result.created);
  }catch{if(current(stamp)){busy=false;held=true;view.failure={code:'held'};paint();}}
 }
 return Object.freeze({show,hide(){shown=false;++epoch;page.hide();},destroy(){alive=false;shown=false;++epoch;page.destroy();}});
}
