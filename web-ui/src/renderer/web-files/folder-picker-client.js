// Server contract . request is the foundation's signed same-origin
// transport; this module neither stores credentials nor invents CSRF headers.
const MAX_REPLY_BYTES=4*1024*1024;
const absolute=value=>typeof value==='string'&&value.startsWith('/')&&value.length<=4096&&!/[\u0000-\u001f\u007f]/.test(value)&&!value.split('/').some(part=>part==='.'||part==='..');
const name=value=>typeof value==='string'&&value.length>0&&value.length<=255&&!/[\\/\u0000-\u001f\u007f]/.test(value)&&value!=='.'&&value!=='..';
async function json(response,valid){
 const reader=response.body?.getReader();if(!reader)throw Error('response');
 const chunks=[];let size=0;
 try{
  for(;;){const {done,value}=await reader.read();if(!valid())throw Error('changed');if(done)break;
   size+=value.byteLength;if(size>MAX_REPLY_BYTES)throw Error('response');chunks.push(value);
  }
  const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 }catch(error){try{await reader.cancel();}catch{}throw error;}finally{reader.releaseLock();}
}
export function createFolderDirectoryLoader({request,current=()=>true}={}){
 if(typeof request!=='function')throw TypeError('Directory transport required');
 return async function load(directoryId,{signal,hidden=false}={}){
  const valid=()=>{try{return !signal?.aborted&&current()===true;}catch{return false;}};
  if(!valid())return{ok:false,code:'changed'};
  if(directoryId!==null&&!absolute(directoryId))return{ok:false,code:'unavailable'};
  try{
   const params=new URLSearchParams({path:directoryId||'',hidden:hidden===true?'1':'0'});
   const response=await request('/api/fs/dirs?'+params.toString(),{method:'GET',signal});
   if(!valid())return{ok:false,code:'changed'};
   if(response.status===401)return{ok:false,code:'signed-out'};
   const body=await json(response,valid);
   if(!valid())return{ok:false,code:'changed'};
   if(!response.ok)return{ok:false,code:['outside-root','unreadable','not-found'].includes(body?.error)?body.error:'unavailable'};
   if(!absolute(body?.path)||!(body.parent===null||absolute(body.parent))||!Array.isArray(body.entries)||body.entries.length>500)throw Error('response');
   const seen=new Set(),entries=[];
   for(const entry of body.entries){
    if(!name(entry?.name)||!absolute(entry.path)||seen.has(entry.path))throw Error('response');
    seen.add(entry.path);entries.push({id:entry.path,name:entry.name});
   }
   return{ok:true,directory:{id:body.path,name:body.path.split('/').filter(Boolean).at(-1)||'/',parentId:body.parent},entries,...(body.truncated===true?{limited:true}:{})};
  }catch{return{ok:false,code:valid()?'unavailable':'changed'};}
 };
}

// POST capability is discovered from its response; a 404 means older engines
// cannot create folders. Every invocation sends at most one mutation.
export function createFolderDirectoryCreator({request,current=()=>true}={}){
 if(typeof request!=='function')throw TypeError('Directory transport required');
 return async function createDirectory(path,folderName,{signal}={}){
  const valid=()=>{try{return !signal?.aborted&&current()===true;}catch{return false;}};
  if(!valid())return{ok:false,code:'changed'};
  if(!absolute(path)||!name(folderName)||/^\.+$/.test(folderName))return{ok:false,code:'invalid'};
  try{
   const response=await request('/api/fs/dirs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path,name:folderName}),signal});
   if(!valid())return{ok:false,code:'changed'};
   if(!response.ok)return{ok:false,code:({400:'invalid',401:'signed-out',403:'outside-root',404:'unsupported',409:'exists'})[response.status]||'unavailable'};
   const body=await json(response,valid);
   if(!valid())return{ok:false,code:'changed'};
   return absolute(body?.path)?{ok:true,path:body.path}:{ok:false,code:'unavailable'};
  }catch{return{ok:false,code:valid()?'unavailable':'changed'};}
 };
}
