// UI state for the fixed native-folder verbs. The main process owns defaults and
// selected paths; only its opaque selection token is added to a local save.
export function createRecipeFolderPicker({api,current=()=>false,onState=()=>{}}={}) {
  let epoch=0,pending=null,state={formId:null,path:'',token:null,ready:false,busy:false,error:null,choiceVersion:0};
  const live=mine=>mine===epoch&&current()===true;
  const publish=()=>{try{onState({...state});}catch{/* a detached form cannot change ownership */}};
  const unavailable=()=>({ok:false,why:'unavailable'});
  function invalidate(){epoch++;pending=null;state={...state,ready:false,busy:false,token:null,error:null};publish();}
  async function begin({formId,context,recipeId=null,path='',selectionToken=null}={}) {
    invalidate();const mine=epoch;
    state={formId:null,path:typeof path==='string'?path:'',token:null,ready:false,busy:false,error:null,choiceVersion:0};
    if(!live(mine)||typeof formId!=='string'||!/^\w[\w.:-]{0,63}$/.test(formId)||!['general','concierge'].includes(context)||
      (recipeId!==null&&(typeof recipeId!=='string'||recipeId.length>128))||typeof api?.recipesFolderForm!=='function'||typeof api?.recipesPickFolder!=='function')return unavailable();
    state.formId=formId;state.token=typeof selectionToken==='string'&&selectionToken.length>0&&selectionToken.length<=256?selectionToken:null;publish();
    try{
      const answer=await api.recipesFolderForm(formId,context,recipeId);
      if(!live(mine))return {ok:false,why:'changed'};
      state.ready=answer?.ok===true;state.error=state.ready?null:'unavailable';publish();
      return state.ready?{ok:true}:unavailable();
    }catch{if(live(mine)){state.error='unavailable';publish();}return unavailable();}
  }
  function pick(mode) {
    if(pending)return pending;
    if(!['choose','create'].includes(mode)||!state.ready||!live(epoch))return Promise.resolve(unavailable());
    const mine=epoch,formId=state.formId;
    state.busy=true;state.error=null;publish();
    let finish;const job=new Promise(resolve=>{finish=resolve;});
    pending=job;
    void (async()=>{
      try{
        const answer=await api.recipesPickFolder(mode,formId);
        if(!live(mine))return {ok:false,why:'changed'};
        if(answer?.ok===false&&answer.why==='cancel')return {ok:false,why:'cancel'};
        if(answer?.ok!==true||typeof answer.path!=='string'||!answer.path||answer.path.includes('\0')||typeof answer.token!=='string'||!answer.token||answer.token.length>256){
          state.error=['changed','unreadable','not-dir'].includes(answer?.why)?answer.why:'unavailable';return {ok:false,why:state.error};
        }
        state.path=answer.path;state.token=answer.token;state.choiceVersion++;return {ok:true};
      }catch{if(live(mine))state.error='unavailable';return unavailable();}
      finally{if(live(mine)){state.busy=false;pending=null;publish();}}
    })().then(finish,()=>finish(unavailable()));
    return job;
  }
  return Object.freeze({begin,pick,invalidate,state:()=>({...state}),saveFields:()=>state.ready&&live(epoch)?{formId:state.formId,...(state.token?{folderToken:state.token}:{})}:null});
}
