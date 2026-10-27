// Browser-only picker state. load() is supplied by the web bridge adapter, not a
// filesystem API. IDs are server-issued references, never permission grants:
// the engine must independently enforce its configured root and symlink rules.
// The adapter's internal projection is {ok,directory:{id,name,parentId},entries:[{id,name}]}.
export function createServerFolderPicker({load,createDirectory,current=()=>true,onState=()=>{}}={}) {
  if(typeof load!=='function')throw TypeError('Directory loader required');
  let epoch=0,request=null,destroyed=false,canCreate=typeof createDirectory==='function',createNeedsReload=false;
  const createState=()=>({canCreate,createOpen:false,createName:'',createError:null,creating:false,createNeedsReload});
  const folderName=value=>typeof value==='string'&&value.length>0&&value.length<=255&&!/[\\/\u0000-\u001f\u007f]/.test(value)&&!/^\.+$/.test(value);
  let state={open:false,busy:false,directory:null,entries:[],error:null,hidden:false,rootId:null,limited:false,...createState()};
  const active=()=>{try{return !destroyed&&current()===true;}catch{return false;}};
  const live=mine=>active()&&state.open&&epoch===mine;
  const snapshot=()=>({...state,directory:state.directory?{...state.directory}:null,entries:state.entries.map(entry=>({...entry}))});
  const publish=()=>{try{onState(snapshot());}catch{/* detached UI cannot change ownership */}};
  const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
  const exact=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
  function project(answer){
    const dir=answer?.directory;
    if(answer?.ok!==true||!exact(dir,['id','name','parentId'])||!text(dir.id,4096)||!text(dir.name,256)||
      !(dir.parentId===null||text(dir.parentId,4096)&&dir.parentId!==dir.id)||!Array.isArray(answer.entries)||answer.entries.length>500)return null;
    const seen=new Set(),entries=[];
    for(const entry of answer.entries){
      if(!exact(entry,['id','name'])||!text(entry.id,4096)||!text(entry.name,256)||seen.has(entry.id)||entry.id===dir.id)return null;
      seen.add(entry.id);entries.push({id:entry.id,name:entry.name});
    }
    return{directory:{id:dir.id,name:dir.name,parentId:dir.parentId},entries,limited:answer.limited===true};
  }
  async function read(id){
    const mine=++epoch,previous=request,controller=new AbortController();request=controller;
    state={...state,busy:true,creating:false,error:null};previous?.abort();publish();
    if(!live(mine))return{ok:false,code:'changed'};
    try{
      const answer=await load(id,{signal:controller.signal,hidden:state.hidden});
      if(!live(mine))return{ok:false,code:'changed'};
      const next=project(answer);
      if(!next){state={...state,error:['outside-root','unreadable','not-found','signed-out'].includes(answer?.code)?answer.code:'unavailable'};return{ok:false,code:state.error};}
      createNeedsReload=false;
      state={...state,...createState(),...next,rootId:state.rootId||(id===null?next.directory.id:null)};return{ok:true};
    }catch{
      if(!live(mine))return{ok:false,code:'changed'};
      state={...state,error:'unavailable'};return{ok:false,code:'unavailable'};
    }finally{if(live(mine)){request=null;state={...state,busy:false};publish();}}
  }
  function close(){
    ++epoch;const previous=request;request=null;state={open:false,busy:false,directory:null,entries:[],error:null,hidden:false,rootId:null,limited:false,...createState()};previous?.abort();publish();
  }
  return Object.freeze({
    open(){if(!active())return Promise.resolve({ok:false,code:'changed'});state={open:true,busy:false,directory:null,entries:[],error:null,hidden:false,rootId:null,limited:false,...createState()};return read(null);},
    navigate(id){
      if(!text(id,4096)||!active()||!state.open||state.busy||!state.entries.some(entry=>entry.id===id)&&state.directory?.parentId!==id)return Promise.resolve({ok:false,code:'unavailable'});
      return read(id);
    },
    beginCreate(){
      if(!active()||!state.open)return{ok:false,code:'changed'};
      if(state.busy||!state.directory||state.error||!canCreate)return{ok:false,code:'unavailable'};
      state={...state,createOpen:true,createName:'',createError:null};publish();return{ok:true};
    },
    setCreateName(value){
      if(!active()||!state.open)return{ok:false,code:'changed'};
      if(!state.createOpen||state.busy||typeof value!=='string')return{ok:false,code:'unavailable'};
      state={...state,createName:value,createError:null};publish();return{ok:true};
    },
    cancelCreate(){
      if(!active()||!state.open)return{ok:false,code:'changed'};
      if(state.busy)return{ok:false,code:'busy'};
      state={...state,createOpen:false,createName:'',createError:null};publish();return{ok:true};
    },
    async createFolder(){
      if(!active()||!state.open)return{ok:false,code:'changed'};
      if(state.busy)return{ok:false,code:'busy'};
      if(createNeedsReload)return{ok:false,code:'reload-required'};
      if(!canCreate||!state.createOpen||!state.directory||state.error)return{ok:false,code:'unavailable'};
      const name=state.createName;
      if(!folderName(name)){state={...state,createError:'invalid'};publish();return{ok:false,code:'invalid'};}
      const mine=++epoch,controller=new AbortController();request=controller;
      const parent=state.directory.id;
      state={...state,busy:true,creating:true,createError:null};publish();
      try{
        if(!live(mine))return{ok:false,code:'changed'};
        let result;try{result=await createDirectory(parent,name,{signal:controller.signal});}catch{result={ok:false,code:'unavailable'};}
        if(!live(mine))return{ok:false,code:'changed'};
        if(result?.ok===true&&text(result.path,4096)){
          // Success authorizes a GET only; confirmation still needs its listing.
          state={...state,createOpen:false,createName:'',createError:null};
          return await read(result.path);
        }
        const code=['exists','invalid','outside-root','signed-out','unsupported'].includes(result?.code)?result.code:'unavailable';
        if(code==='unsupported')canCreate=false;
        if(code==='unavailable')createNeedsReload=true;
        state={...state,canCreate,createNeedsReload,createError:code,createOpen:canCreate};
        return{ok:false,code};
      }finally{if(live(mine)){request=null;state={...state,busy:false,creating:false};publish();}}
    },
    goPath(path){return !text(path,4096)||!active()||!state.open||state.busy?Promise.resolve({ok:false,code:'unavailable'}):read(path);},
    home(){return !active()||!state.open||state.busy?Promise.resolve({ok:false,code:'unavailable'}):read(state.rootId);},
    setHidden(value){if(typeof value!=='boolean'||!active()||!state.open||state.creating)return Promise.resolve({ok:false,code:'unavailable'});state={...state,hidden:value};return read(state.directory?.id||null);},
    up(){const id=state.directory?.parentId;return id?this.navigate(id):Promise.resolve({ok:false,code:'unavailable'});},
    confirm(){
      if(!active()||!state.open||state.busy||!state.directory||state.error||state.createOpen)return null;
      const answer={id:state.directory.id,name:state.directory.name};close();return answer;
    },
    close,state:snapshot,
    destroy(){destroyed=true;close();},
  });
}
