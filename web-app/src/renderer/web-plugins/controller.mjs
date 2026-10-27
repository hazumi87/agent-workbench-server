import {checkSummary,validId} from './model.mjs';
import {validateFile} from './api.mjs';
export function createPluginInstaller({api,onChange=()=>{}}){
  let alive=true,epoch=0,active=null;
  let state={phase:'idle',file:null,review:null,error:null};
  const snapshot=()=>structuredClone(state);
  const paint=patch=>{state={...state,...patch};onChange(snapshot());};
  const current=op=>alive&&active===op&&op.epoch===epoch;
  function invalidate(destroy=false){const uncertain=['installing','removing'].includes(state.phase);epoch++;active?.abort.abort();if(destroy)alive=false;paint({phase:uncertain&&!destroy?'unconfirmed':'idle',file:null,review:null,error:uncertain&&!destroy?'unconfirmed':null});}
  async function run(phase,fn){
    if(!alive||active)return {ok:false};
    const op={epoch,abort:new AbortController()};active=op;paint({phase,error:null});
    try{const patch=await fn({signal:op.abort.signal});if(!current(op))return {ok:false};paint(patch);return {ok:true};}
    catch(error){if(!current(op))return {ok:false};
      if(error?.code==='off')paint({phase:'off',review:null,error:null});
      else if(error?.code==='refused')paint({phase:'refused',review:null,error:error.reason||'refused'});
      else paint({phase:'unconfirmed',review:null,error:'unconfirmed'});
      return {ok:false};
    }finally{if(active===op)active=null;}
  }
  return Object.freeze({
    state:snapshot,
    async upload(file){
      if(!alive||active||state.phase==='off'||state.phase==='unconfirmed')return {ok:false};
      try{validateFile(file);}catch(error){paint({phase:'refused',file:typeof file?.name==='string'?file.name.slice(0,255):null,review:null,error:error.reason});return {ok:false};}
      paint({file:file.name,review:null,operation:'upload'});
      return run('uploading',async options=>{const review=checkSummary(await api.upload(file,options));return {phase:review.permissions.includes('microphone')?'held':'review',review,error:review.permissions.includes('microphone')?'microphone':null};});
    },
    async allow(checkId){
      if(state.phase!=='review'||!state.review||state.review.checkId!==checkId)return {ok:false};
      const review=state.review;state={...state,review:null,pluginName:review.plugin.name,operation:'install'};
      return run('installing',async options=>{await api.install(review.checkId,review.permissions,options);return {phase:'submitted',review:null,error:null};});
    },
    async remove(id,confirmed,name=id){
      if(!alive||active||state.phase==='off'||state.phase==='unconfirmed'||confirmed!==true||!validId(id))return {ok:false};
      state={...state,review:null,file:id,pluginName:typeof name==='string'&&name.length>0&&name.length<=200?name:id,operation:'remove'};return run('removing',async options=>{await api.remove(id,options);return {phase:'submitted',review:null,error:null};});
    },
    cancel:()=>invalidate(),
    reset(){invalidate();state={phase:'idle',file:null,review:null,error:null};onChange(snapshot());},
    destroy:()=>invalidate(true),
  });
}
