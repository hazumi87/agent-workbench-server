const CHOICES=new Set(['follow','on','off']);
const PROGRAMS=new Set(['claude-code','codex-cli','gemini-cli','ollama','shell']);
const copy=value=>JSON.parse(JSON.stringify(value));
const validPolicy=p=>p&&['on','off'].includes(p.default)&&(p.autoApproveDisclosedAt===null||(Number.isSafeInteger(p.autoApproveDisclosedAt)&&p.autoApproveDisclosedAt>=0));
export function createAgentModel(api,{onState=()=>{},timeoutMs=15000}={}) {
 if(!api||!Number.isFinite(timeoutMs)||timeoutMs<=0)throw TypeError('Agent API required');
 const timers=api.timers||globalThis;
 let alive=true,generation=0,pending=null,abort=new AbortController();
 let st={phase:'loading',programs:[],policy:null,programId:'',name:'',folder:'',choice:'follow',acknowledged:false,picking:false,error:null,answer:null,answerVersion:0};
 const publish=()=>{if(alive)onState(copy(st));};
 const current=mine=>{try{return alive&&mine===generation&&!abort.signal.aborted&&(typeof api.current!=='function'||api.current()===true);}catch{return false;}};
 function set(field,value){
  if(!current(generation)||st.phase!=='ready'||st.picking)return false;
  if(field==='name'){if(typeof value!=='string'||value.length>60)return false;}
  else if(field==='programId'){if(!st.programs.some(p=>p.id===value))return false;}
  else if(field==='choice'){if(!CHOICES.has(value))return false;st.acknowledged=false;}
  else return false;
  st[field]=value;st.error=null;st.answer=null;publish();return true;
 }
 async function load(){
  if(!alive||pending||!['loading','error'].includes(st.phase))return false;
  const mine=++generation;st.phase='loading';st.error=null;publish();
  try{
   const [policy,rows]=await Promise.all([api.readApproval({signal:abort.signal}),api.programs()]);
   if(!current(mine))return;
   if(!validPolicy(policy)||!Array.isArray(rows))throw Error('load');
   const programs=rows.filter(p=>p?.enabled!==false&&PROGRAMS.has(p?.id)).map(p=>({id:p.id,label:String(p.label||p.id).slice(0,60)}));
   if(!programs.length)throw Error('load');
   st={...st,phase:'ready',policy:{default:policy.default,autoApproveDisclosedAt:policy.autoApproveDisclosedAt},programs,programId:programs[0].id,error:null};publish();
  }catch{if(current(mine)){st.phase='error';st.error='load';publish();}}
 }
 async function pickFolder(){
  if(!current(generation)||st.phase!=='ready'||st.picking)return false;
  const mine=generation;st.picking=true;st.error=null;publish();
  try{const result=await api.chooseFolder({signal:abort.signal});if(!current(mine))return false;
   if(result?.ok===true&&typeof result.path==='string'&&result.path.startsWith('/')&&result.path.length<=300&&!/[\u0000-\u001f\u007f]/.test(result.path))st.folder=result.path;
   else if(!['cancelled','changed'].includes(result?.code))st.error='folder';
  }catch{if(current(mine))st.error='folder';}
  finally{if(current(mine)){st.picking=false;publish();}}
 }
 function save(){
  if(pending)return pending;
  if(!current(generation)||st.phase!=='ready'||st.picking)return Promise.resolve(false);
  if(!st.name.trim()||!st.programs.some(p=>p.id===st.programId)){st.error='name';publish();return Promise.resolve(false);}
  if(st.choice==='on'&&st.policy.autoApproveDisclosedAt===null&&!st.acknowledged){st.error='disclosure';publish();return Promise.resolve(false);}
  const mine=generation,program=st.programs.find(p=>p.id===st.programId);
  const payload={name:st.name.trim(),programId:st.programId,programLabel:program.label,folder:st.folder||'~',options:{},autoApprove:st.choice,
   ...(st.choice==='on'&&st.policy.autoApproveDisclosedAt===null&&st.acknowledged?{disclosed:true}:{})};
  st.phase='saving';st.error=null;st.answer=null;publish();
  pending=(async()=>{
   if(st.folder){let found=false;try{found=await api.checkFolder(st.folder,{signal:abort.signal});}catch{}
    if(!current(mine))return false;
    if(found!==true){st.phase='ready';st.error='folder';publish();return false;}
   }
   if(!current(mine))return false;
   let timer,result;
   try{result=await Promise.race([
    Promise.resolve().then(()=>current(mine)?api.save(payload,{signal:abort.signal}):{unconfirmed:true}),
    new Promise(resolve=>{timer=timers.setTimeout(()=>resolve({unconfirmed:true}),timeoutMs);}),
   ]);}catch{result={unconfirmed:true};}finally{timers.clearTimeout(timer);}
   if(!current(mine))return false;
   if(result?.unconfirmed===true){st.phase='unconfirmed';st.error='unconfirmed';publish();return false;}
   if(result?.error||result?.ok===false){
    if(([400,401,403,404,409,413,422].includes(result.status))||typeof result.field==='string'){
     if(typeof api.serverAnswer!=='function')throw TypeError('Server answer mapper required');
     const answer=api.serverAnswer(result);if(typeof answer?.text!=='string')throw TypeError('Mapped sentence required');
     st.phase='ready';st.error='server-answer';st.answer=answer;st.answerVersion++;
     if(answer.action==='show-disclosure'){st.acknowledged=false;st.policy.autoApproveDisclosedAt=null;}
    }else{st.phase='unconfirmed';st.error='unconfirmed';}
    publish();return false;
   }
   if(typeof result?.id!=='string'||!result.id){st.phase='unconfirmed';st.error='unconfirmed';publish();return false;}
   st.phase='saved';st.savedId=result.id;publish();return true;
  })().finally(()=>{pending=null;});
  return pending;
 }
 return Object.freeze({load,set,pickFolder,save,state:()=>copy(st),acknowledge(value){if(current(generation)&&st.phase==='ready'&&st.choice==='on'){st.acknowledged=value===true;st.error=null;st.answer=null;publish();}},dispose(){alive=false;++generation;abort.abort();st={...st,phase:'closed'};}});
}
