import {validId,validCheckId} from './model.mjs';
export const MAX_ZIP_BYTES=20*1024*1024;
const unknown=()=>({code:'unconfirmed'});
const refusals=new Set(['unsigned','planted','program','bad-manifest','not-a-zip','corrupt','expired','changed','too-big','too-many-files','bomb','reserved-id','core','occupied','link','bad-name','encrypted']);
export function validateFile(file) {
  if(!file || typeof file.name!=='string' || file.name.length>255 || !Number.isFinite(file.size) || file.size<1)throw {code:'refused',reason:'not-a-zip'};
  if(file.size>MAX_ZIP_BYTES)throw {code:'refused',reason:'too-big'};
  if(!/\.zip$/i.test(file.name) || !(file instanceof Blob))throw {code:'refused',reason:'not-a-zip'};
}
export function createPluginAPI(fetch,{timeoutMs=90000,maxReplyBytes=1024*1024}={}) {
  if(typeof fetch!=='function' || !Number.isFinite(timeoutMs) || timeoutMs<=0 || !Number.isSafeInteger(maxReplyBytes) || maxReplyBytes<1)throw Error('invalid transport options');
  async function request(path,method,body,{signal}={}){
    if(signal?.aborted)throw unknown();
    const controller=new AbortController();let reader;
    const cancel=()=>controller.abort();
    const interrupted=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>{if(reader)void reader.cancel().catch(()=>{});reject(unknown());},{once:true}));
    signal?.addEventListener('abort',cancel,{once:true});const timer=setTimeout(cancel,timeoutMs);
    try{return await Promise.race([interrupted,(async()=>{
      let response;try{response=await fetch(path,{method,body,signal:controller.signal,credentials:'same-origin',redirect:'error',cache:'no-store',headers:{accept:'application/json',...(typeof body==='string'?{'content-type':'application/json'}:{})}});}catch{throw unknown();}
      const dispose=()=>{void response.body?.cancel().catch(()=>{});};
      if(controller.signal.aborted){dispose();throw unknown();}
      if(response.status===404){dispose();throw {code:'off'};}
      if(response.status===204 && method!=='POST'){dispose();return {accepted:true};}
      const length=response.headers.get('content-length');if(length!==null && Number(length)>maxReplyBytes){dispose();throw unknown();}
      if(!response.body?.getReader)throw unknown();reader=response.body.getReader();let size=0,text='';const decoder=new TextDecoder('utf-8',{fatal:true});
      try{for(;;){const {done,value}=await reader.read();if(controller.signal.aborted)throw unknown();if(done)break;size+=value.byteLength;if(size>maxReplyBytes){void reader.cancel().catch(()=>{});throw unknown();}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}catch{throw unknown();}
      let data;try{data=JSON.parse(text);}catch{throw unknown();}
      if([400,401,403,409,413,422].includes(response.status)){/* the engine (M6) sends its reason word in `reason` and a sentence in `error`; either may carry the word */const named=[data?.reason,data?.error].find(r=>refusals.has(r));throw {code:'refused',reason:named||(response.status===413?'too-big':response.status===409&&data?.field==='checkId'?'expired':'refused')};}
      if(!response.ok)throw unknown();return data;
    })()]);}finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
  }
  return Object.freeze({
    async upload(file,options){validateFile(file);const form=new FormData();form.append('file',file,file.name);return request('/api/modules/plugins','POST',form,options);},
    async install(checkId,permissions,options){if(!validCheckId(checkId)||!Array.isArray(permissions))throw {code:'refused',reason:'changed'};return request(`/api/modules/plugins/${encodeURIComponent(checkId)}/install`,'POST',JSON.stringify({consent:{permissions:[...permissions]}}),options);},
    async remove(id,options){if(!validId(id))throw {code:'refused',reason:'bad-name'};return request(`/api/modules/plugins/${encodeURIComponent(id)}`,'DELETE',undefined,options);},
  });
}
