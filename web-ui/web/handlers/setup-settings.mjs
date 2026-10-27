import {serverFolder} from '../../src/renderer/web-setup/policy.mjs';

const refusalStatuses = new Set([400,401,403,404,409,413,422]);
const unknown = () => ({code:'settings-unconfirmed'});
const invalid = () => { throw {code:'settings-invalid'}; };
// Shared by the foundation registration and isolated transport tests. No arbitrary URL or verb input.
export function createSettingsAPI(fetch, {timeoutMs=15000, maxBytes=1024*1024} = {}) {
  if (typeof fetch !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) invalid();
  async function request(path, method, body, {signal,current}={}) {
    if(signal?.aborted || (current && current() !== true)) throw unknown();
    const abort = new AbortController(); let timer, reader;
    const cancel = () => abort.abort();
    const interrupted = new Promise((_,reject)=>abort.signal.addEventListener('abort',()=>{
      if(reader) void reader.cancel().catch(()=>{});
      reject(unknown());
    },{once:true}));
    signal?.addEventListener('abort',cancel,{once:true});
    timer=setTimeout(cancel,timeoutMs);
    try {
      return await Promise.race([interrupted,(async()=>{
        let response;
        try { response = await fetch(path,{method,credentials:'same-origin',redirect:'error',cache:'no-store',signal:abort.signal,
          headers:{accept:'application/json',...(body===undefined?{}:{'content-type':'application/json'})},
          ...(body===undefined?{}:{body:JSON.stringify(body)})}); } catch { throw unknown(); }
        if(abort.signal.aborted){void response.body?.cancel().catch(()=>{});throw unknown();}
        const length=response.headers.get('content-length');
        if(length !== null && Number(length)>maxBytes){void response.body?.cancel().catch(()=>{});throw unknown();}
        if(!response.body?.getReader) throw unknown();
        reader=response.body.getReader(); let size=0, text=''; const decoder=new TextDecoder('utf-8',{fatal:true});
        try {
          for(;;){const {done,value}=await reader.read();if(abort.signal.aborted)throw unknown();if(done)break;
            size+=value.byteLength;if(size>maxBytes){void reader.cancel().catch(()=>{});throw unknown();}
            text+=decoder.decode(value,{stream:true});
          }
          text+=decoder.decode();
        } catch { throw unknown(); }
        let data;try{data=JSON.parse(text);}catch{throw unknown();}
        if(refusalStatuses.has(response.status) && data && typeof data.error==='string') {
          // No raw server strings, URL, body, or credential data escapes into UI errors.
          throw {code:'settings-refused',status:response.status};
        }
        if(!response.ok)throw unknown();
        return data;
      })()]);
    } finally { clearTimeout(timer);signal?.removeEventListener('abort',cancel); }
  }
  return Object.freeze({
    readSetup: options=>request('/api/settings/setup','GET',undefined,options),
    readPersonDisplay: options=>request('/api/rooms/me','GET',undefined,options),
    readAgents: options=>request('/api/agents/status','GET',undefined,options),
    async writeSetup(input,options){
      if(!input || typeof input !== 'object')invalid();
      const body={};
      if('defaultFolder' in input){if(input.defaultFolder !== null && !serverFolder(input.defaultFolder))invalid();body.defaultFolder=input.defaultFolder;}
      if('complete' in input){if(input.complete !== true)invalid();body.complete=true;}
      if(!Object.keys(body).length)invalid();
      return request('/api/settings/setup','PUT',body,options);
    },
    async prepareAgentSignIn(vendor,options){
      if(!['claude-code','codex-cli','gemini-cli'].includes(vendor))invalid();
      return request(`/api/agents/${vendor}/sign-in`,'POST',{},options);
    },
    readApproval: options=>request('/api/settings/auto-approve','GET',undefined,options),
    async writeApproval(input,options){
      if(!input || !['on','off'].includes(input.default) || (input.disclosed!==undefined && input.disclosed!==true))invalid();
      const body={default:input.default,...(input.disclosed===true?{disclosed:true}:{})};
      return request('/api/settings/auto-approve','PUT',body,options);
    },
    readTrust: options=>request('/api/settings/folder-trust','GET',undefined,options),
    async writeTrust(input,options){
      if(!input || !serverFolder(input.path) || typeof input.trusted!=='boolean')invalid();
      return request('/api/settings/folder-trust','PUT',{path:input.path,trusted:input.trusted},options);
    },
  });
}
export function register(api){api.expose('settings',createSettingsAPI((path,init)=>api.engine.fetch(path,init)));}
