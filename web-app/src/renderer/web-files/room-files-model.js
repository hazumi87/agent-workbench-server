// Room-scoped browser state, independent of the transport and DOM. The engine
// remains the authority for sign-in, filesystem containment and publishing.
export function createRoomFilesModel({makeClient,current=()=>true,onState=()=>{}}={}){
 if(typeof makeClient!=='function')throw TypeError('Room files client factory required');
 let epoch=0,binding=null,destroyed=false,reads=0;
 let state={roomId:null,dir:'assets',sub:'',busy:false,entries:[],failures:[],notices:[],error:null};
 const active=()=>{try{return !destroyed&&current()===true;}catch{return false;}};
 const live=token=>active()&&binding===token&&token.epoch===epoch;
 const snapshot=()=>({...state,entries:state.entries.map(e=>({...e})),failures:state.failures.map(f=>({...f})),notices:state.notices.map(n=>({...n}))});
 const publish=()=>{try{onState(snapshot());}catch{/* detached views do not own requests */}};
 const changed=()=>({ok:false,code:'changed'});
 const code=result=>['sign-in','forbidden','not-found','conflict','too-large','invalid','unconfirmed'].includes(result?.code)?result.code:'unavailable';
 async function listing(token,dir,sub){
  const read=++reads;
  try{
   const result=await token.client.list(dir,sub);
   if(!live(token)||read!==reads)return changed();
   if(!result?.ok){state={...state,entries:[],error:code(result)};return{ok:false,code:state.error};}
   state={...state,dir,sub,entries:result.entries.map(e=>({...e})),error:null};return{ok:true};
  }catch{if(!live(token)||read!==reads)return changed();state={...state,entries:[],error:'unavailable'};return{ok:false,code:'unavailable'};}
 }
 async function refresh(dir=state.dir,sub=state.sub){
  const token=binding;if(!token||!live(token))return changed();
  if(state.busy)return{ok:false,code:'busy'};
  state={...state,busy:true,failures:[],notices:[]};publish();
  try{return await listing(token,dir,sub);}finally{if(live(token)){state={...state,busy:false};publish();}}
 }
 async function bind(roomId){
  if(!active())return changed();
  const old=binding,token={roomId,epoch:++epoch,client:null};binding=token;++reads;
  state={roomId,dir:'assets',sub:'',busy:false,entries:[],failures:[],notices:[],error:null};
  old?.client?.destroy();
  try{token.client=makeClient(roomId,{current:()=>live(token)});}catch{binding=null;state={...state,error:'unavailable'};publish();return{ok:false,code:'unavailable'};}
  return refresh();
 }
 return Object.freeze({
  bind,refresh,state:snapshot,
  async upload(files){
   const token=binding;if(!token||!live(token))return changed();
   if(state.busy)return{ok:false,code:'busy'};
   if(!Array.isArray(files)||files.length<1||files.length>20||files.some(f=>!(f instanceof Blob)||typeof f.name!=='string'||!f.name))return{ok:false,code:'invalid'};
   const dir=state.dir,sub=state.sub;
   // The route's POST is a directory-root upload. Do not silently redirect a
   // drop in a nested folder to its parent; a nested-upload contract is pending.
   if(sub)return{ok:false,code:'invalid'};
   state={...state,busy:true,failures:[],notices:[],error:null};publish();let uploaded=0;const failures=[],notices=[];
   try{
    for(const file of files){
     if(!live(token))return changed();
     let result;try{result=await token.client.upload(dir,file,file.name);}catch{result={ok:false,code:'unavailable'};}
     if(!live(token))return changed();
     if(result?.ok){uploaded++;if(typeof result.name==='string'&&result.name!==file.name)notices.push({name:file.name,addedAs:result.name});}else failures.push({name:file.name,code:code(result),...(result?.reason==='person-only'?{reason:'person-only'}:{}),...(Number.isFinite(result?.limitBytes)?{limitBytes:result.limitBytes}:{}),...(Number.isFinite(result?.sizeBytes)?{sizeBytes:result.sizeBytes}:result?.code==='too-large'?{sizeBytes:file.size}:{})});
    }
    state={...state,failures,notices};if(uploaded)await listing(token,dir,sub);
    return live(token)?{ok:failures.length===0,uploaded,failures:failures.map(f=>({...f}))}:changed();
   }finally{if(live(token)){state={...state,busy:false};publish();}}
  },
  async read(name){
   const token=binding;if(!token||!live(token))return changed();
   const entry=state.entries.find(e=>e.name===name&&e.kind==='file');if(!entry)return{ok:false,code:'invalid'};
   const dir=state.dir,rel=state.sub?state.sub+'/'+name:name;
   try{const result=await token.client.read(dir,rel);return live(token)?result:changed();}catch{return live(token)?{ok:false,code:'unavailable'}:changed();}
  },
  async remove(name,confirm){
   const token=binding;if(!token||!live(token))return changed();
   if(state.busy)return{ok:false,code:'busy'};
   const entry=state.entries.find(e=>e.name===name&&e.kind==='file');
   if(!entry||typeof confirm!=='function')return{ok:false,code:'invalid'};
   const dir=state.dir,sub=state.sub,rel=sub?sub+'/'+name:name;
   state={...state,busy:true};publish();
   try{
    // Listing hashes may be cached by metadata. Get the authoritative raw-GET
    // revision before the person's confirmation, never from a directory page.
    const baseline=await token.client.readRevision(dir,rel);if(!live(token))return changed();
    if(!baseline?.ok)return{ok:false,code:code(baseline)};
    const revision=baseline.revision;
    if(typeof revision!=='string'||revision.length>4096||!/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(revision))return{ok:false,code:'unavailable'};
    const yes=await confirm({name,roomId:token.roomId});if(!live(token))return changed();
    if(yes!==true)return{ok:false,code:'cancelled'};
    const result=await token.client.remove(dir,rel,{revision});if(!live(token))return changed();
    if(!result?.ok)return{ok:false,code:code(result)};
    await listing(token,dir,sub);return live(token)?{ok:true}:changed();
   }catch{return live(token)?{ok:false,code:'unavailable'}:changed();}
   finally{if(live(token)){state={...state,busy:false};publish();}}
  },
  destroy(){destroyed=true;++epoch;++reads;const old=binding;binding=null;state={roomId:null,dir:'assets',sub:'',busy:false,entries:[],failures:[],notices:[],error:null};old?.client?.destroy();publish();},
 });
}
