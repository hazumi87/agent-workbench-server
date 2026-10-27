import {approvalSnapshot,defaultRequest,serverFolder} from './policy.mjs';
const refuse=()=>{throw Error('invalid-reply');};
const text=(v,n=200)=>typeof v==='string'&&v.length>0&&v.length<=n&&!/[\x00-\x1f]/.test(v);
function setupView(value){
 if(!value||!text(value.person?.id)||(value.person.name!==null&&!text(value.person.name))||typeof value.completed!=='boolean'||(value.defaultFolder!==null&&!serverFolder(value.defaultFolder)))refuse();
 return {person:{id:value.person.id,name:value.person.name},completed:value.completed,folder:value.defaultFolder};
}
function agentRows(value){
 if(!Array.isArray(value)||value.length>20)refuse();const ids=new Set();
 return value.map(row=>{if(!text(row?.id,80)||ids.has(row.id)||!text(row.label,100)||![true,false,null].includes(row.installed))refuse();ids.add(row.id);return {id:row.id,label:row.label,installed:row.installed};});
}
// readSetup/readAgents/folder/completion/terminal methods are injected seams, not invented HTTP routes.
// The concrete adapter must bind a person scope and enforce time/body bounds; no browser persistence here.
export function createOnboarding({api,onChange=()=>{}}){
 let alive=true,shown=false,epoch=0,active=null,needsRefresh=false;
 const empty=()=>({status:'idle',step:1,person:null,approval:null,choice:'off',disclosure:false,agents:null,agentsStatus:'idle',folder:null,folderVerified:false,error:null});
 let state=empty();const snapshot=()=>structuredClone(state),paint=patch=>{state={...state,...patch};onChange(snapshot());};
 const current=op=>alive&&shown&&active===op&&op.epoch===epoch;
 function invalidate(){epoch++;shown=false;active?.abort.abort();needsRefresh=false;state=empty();onChange(snapshot());}
 function admitted(step){if(!alive||!shown)return 'inactive';if(active)return 'busy';if(needsRefresh)return 'refresh-required';if(state.status!=='ready'||(step&&state.step!==step))return 'not-ready';return null;}
 async function perform(work,{load=false,picking=false}={}){
  if(!alive||!shown||active)return {ok:false,error:'busy'};
  const op={epoch,abort:new AbortController()};active=op;paint({status:load?'loading':picking?'picking':'saving',error:null});
  const check=()=>{if(!current(op))throw Error('stale');},options={signal:op.abort.signal,current:()=>current(op)};
  try{await work(options,check);check();needsRefresh=false;return {ok:true};}
  catch(error){if(!current(op))return {ok:false,error:'stale'};
   const refused=!load&&error?.code==='settings-refused'&&[400,401,403,404,409,413,422].includes(error.status);
   needsRefresh=!load&&!refused;paint({status:load?'error':'ready',error:load?'load-failed':refused?'refused':'unconfirmed',disclosure:false});return {ok:false,error:state.error};
  }finally{if(active===op)active=null;}
 }
 async function saveChoice(value,ack,options,check){
  const body=defaultRequest(value,ack,state.approval.autoApproveDisclosedAt);
  const result=await api.writeApproval(body,options);check();const approval=approvalSnapshot(result);if(approval.default!==value||(ack&&approval.autoApproveDisclosedAt===null))refuse();
  paint({approval,choice:value,disclosure:false});
 }
 return Object.freeze({state:snapshot,
  async show(){if(!alive)return {ok:false,error:'inactive'};shown=true;return perform(async(options,check)=>{
   const [raw,approvalRaw]=await Promise.all([api.readSetup(options),api.readApproval(options)]);check();const setup=setupView(raw),approval=approvalSnapshot(approvalRaw);
   paint({...empty(),status:setup.completed?'done':'ready',person:setup.person,approval,choice:approval.default,folder:setup.folder});
  },{load:true});},
  hide:invalidate,reset:invalidate,destroy(){invalidate();alive=false;},
  back(){const error=admitted();if(error)return {ok:false,error};if(state.disclosure)return {ok:false,error:'disclosure'};paint({step:Math.max(1,state.step-1),error:null});return {ok:true};},
  async chooseApproval(value){const error=admitted(2);if(error)return {ok:false,error};if(!['on','off'].includes(value))return {ok:false,error:'invalid'};
   if(value==='on'&&state.approval.autoApproveDisclosedAt===null){paint({disclosure:true});return {ok:true};}paint({choice:value,disclosure:false});return {ok:true};},
  cancelDisclosure(){if(!admitted(2))paint({disclosure:false});},
  async confirmDisclosure(){const error=admitted(2);if(error)return {ok:false,error};if(!state.disclosure)return {ok:false,error:'disclosure'};
   return perform(async(options,check)=>{await saveChoice('on',true,options,check);paint({status:'ready'});});},
  async next(){const error=admitted();if(error)return {ok:false,error};if(state.disclosure)return {ok:false,error:'disclosure'};
   if(state.step===1){paint({step:2});return {ok:true};}
   if(state.step===2)return perform(async(options,check)=>{
    if(state.choice!==state.approval.default||state.approval.autoApproveDisclosedAt===null)await saveChoice(state.choice,state.approval.autoApproveDisclosedAt===null,options,check);
    let agents=null,agentsStatus='unavailable';try{const result=await api.readAgents(options);check();agents=agentRows(result);agentsStatus='ready';}catch{check();}
    paint({status:'ready',step:3,agents,agentsStatus});
   });
   if(state.step===3){paint({step:4,error:null});return {ok:true};}
   return {ok:false,error:'last-step'};
  },
  async openAgent(id){const error=admitted(3);if(error)return {ok:false,error};if(!state.agents?.some(row=>row.id===id&&row.installed!==false))return {ok:false,error:'not-available'};
   return perform(async(options,check)=>{const reply=await api.openAgentSignIn(id,options);check();if(reply?.opened!==true)refuse();paint({status:'ready'});});},
  async refreshAgents(){
   if(!alive||!shown||active||state.step!==3||!needsRefresh)return {ok:false,error:'not-ready'};
   const personId=state.person.id;
   // Reconcile reads only: never repeat recipe preparation or launch after an uncertain answer.
   return perform(async(options,check)=>{
    const [raw,approvalRaw,agentsRaw]=await Promise.all([api.readSetup(options),api.readApproval(options),api.readAgents(options)]);check();
    const setup=setupView(raw),approval=approvalSnapshot(approvalRaw),agents=agentRows(agentsRaw);if(setup.person.id!==personId)refuse();
    paint({status:setup.completed?'done':'ready',person:setup.person,approval,choice:approval.default,agents,agentsStatus:'ready',error:null,disclosure:false});
   });
  },
  async chooseFolder(){const error=admitted(4);if(error)return {ok:false,error};return perform(async(options,check)=>{
   const reply=await api.pickFolder(options);check();if(reply!==null&&!serverFolder(reply?.path))refuse();paint({status:'ready',...(reply?{folder:reply.path,folderVerified:true}:{})});
  },{picking:true});},
  async finish(){const error=admitted(4);if(error)return {ok:false,error};if(!serverFolder(state.folder))return {ok:false,error:'folder-required'};
   return perform(async(options,check)=>{
    const personId=state.person.id,path=state.folder;
    const folder=await api.writeDefaultFolder({path},options);check();if(folder?.path!==path)refuse();
    const reply=await api.completeSetup(options);check();if(reply?.completed!==true||reply.person?.id!==personId)refuse();paint({status:'done',error:null});
   });},
 });
}
