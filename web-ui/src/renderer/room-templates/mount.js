import {createTemplateController} from './controller.js';
// Page-owned presentation lifetime. Main mints tickets; this consumer cannot
// register a view, choose a principal, send HTTP, or persist a create attempt.
export function createTemplateMount({host,api,onOpenRoom,onBuiltin}={}) {
 let alive=true,context=null,controller=null,bound=null,epoch=0,lastTicket=-1,desired=null,created=null,formSequence=0;
 const sameScope=(a,b)=>a?.accountId===null&&b?.accountId===null&&Number.isSafeInteger(a.selectionVersion)&&a.selectionVersion>=0&&a.selectionVersion===b.selectionVersion;
 const eligible=()=>alive&&api&&context?.shown===true&&context.local===true&&sameScope(context.scope,context.scope);
 const current=stamp=>eligible()&&epoch===stamp&&!!bound;
 function retire(){++epoch;controller?.destroy();controller=null;const old=bound;bound=null;if(old)void old.closeView().catch(()=>{});host.hidden=true;}
 function show(options){if(!controller||!eligible())return;void controller.show({enabled:true,scope:JSON.stringify(context.scope),starters:[{id:'my-first-room',kind:'starter',name:'My first room',seats:2,teams:0},{id:'my-project',kind:'starter',name:'My project',seats:11,teams:4}],...options});}
 function receive(message){
  if(!eligible()||!sameScope(message?.scope,context.scope))return;
  const ticket=message.ticket;
  if(!ticket){retire();return;}
  if(typeof ticket.viewId!=='string'||!Number.isSafeInteger(ticket.viewEpoch)||ticket.viewEpoch<=lastTicket)return;
  lastTicket=ticket.viewEpoch;retire();const stamp=epoch;
  bound=api.bind(Object.freeze({viewId:ticket.viewId,viewEpoch:ticket.viewEpoch}));const ports=bound;
  controller=createTemplateController({host,api:ports,onClose:()=>{desired=null;host.hidden=true;},
   onBuiltin:async p=>current(stamp)&&onBuiltin?onBuiltin(p,()=>current(stamp)):{ok:false,code:'stale'},
   onCreated:async result=>{if(!current(stamp))return;created={scope:{...context.scope},value:structuredClone(result)};await onOpenRoom?.(result.roomId,()=>current(stamp));},
   onFolderAction:async(verb,input)=>{
    if(!current(stamp)||input.roomId!==context.roomId)return {ok:false,code:'stale'};
    const request={roomId:input.roomId,formId:'template-folder-'+(++formSequence)};
    let r=await ports.folderForm(request);if(!current(stamp))return {ok:false,code:'stale'};if(r?.ok!==true)return r;
    r=await ports.pickFolder({...request,mode:verb==='createFolder'?'create':'choose'});if(!current(stamp))return {ok:false,code:'stale'};if(r?.ok!==true)return r;
    r=await ports.applyFolder({...request,token:r.token});if(!current(stamp))return {ok:false,code:'stale'};
    if(r?.ok===true&&created?.value.roomId===input.roomId)created.value={...created.value,folder:'none'};
    return r;
   }});
  const options=desired||(created?.value.roomId===context.roomId&&sameScope(created.scope,context.scope)?{screen:'created',created:created.value}:context.roomId?null:{screen:'list'});
  desired=null;if(options)show(options);
 }
 const off=api?.onView?.(receive);
 return Object.freeze({
  context(next){
   if(!alive)return;
   const change=!context||context.shown!==next.shown||context.local!==next.local||!sameScope(context.scope,next.scope)||(context.roomId||null)!==(next.roomId||null);
   if(!change)return;
   if(context&&(!next.shown||!sameScope(context.scope,next.scope)))created=null;
   retire();desired=null;context={...next,scope:{...next.scope}};
  },
  open(options){if(!eligible())return false;desired={...options};
   if(!controller)controller=createTemplateController({host,api:{getState:async()=>({ok:false,code:'unavailable'})},onClose:()=>{desired=null;host.hidden=true;}});
   const value=desired;if(bound)desired=null;show(value);return true;},
  canSave(room){return !!(eligible()&&bound&&room?.id===context.roomId&&room.parent_id===null&&room.state==='open'&&room.created_by==='user');},
  destroy(){if(!alive)return;retire();alive=false;off?.();context=null;created=null;desired=null;},
 });
}
