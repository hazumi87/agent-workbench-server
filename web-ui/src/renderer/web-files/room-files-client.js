// Browser-only room files seam. request() owns same-origin sign-in and CSRF.
// Binding and local validation are UI fences, never server authorization.
export const MAX_ROOM_FILE_BYTES=50*1024*1024;
const MAX_LIST_BYTES=4*1024*1024;
const MAX_REPLY_BYTES=16*1024;
const MAX_ENTRIES=1000;
const directories=new Set(['notes','assets','files']);
const segment=value=>typeof value==='string'&&value.length>0&&value.length<=255&&
  value!=='.'&&value!=='..'&&!/[\u0000-\u001f\u007f\\/]/.test(value);
const relative=(value,empty=false)=>typeof value==='string'&&value.length<=4096&&
  !/^[A-Za-z]:\//.test(value)&&(empty&&value===''||value.split('/').every(segment));
const changed=()=>({ok:false,code:'changed'});
const invalid=()=>({ok:false,code:'invalid'});
const unavailable=()=>({ok:false,code:'unavailable'});
// Validate one strong entity-tag without interpreting or reconstructing its
// opaque contents. In particular, never allow a wildcard or an ETag list.
const revision=value=>typeof value==='string'&&value.length<=4096&&/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value);
const metadata=value=>!!value&&segment(value.name)&&Number.isSafeInteger(value.size)&&value.size>=0&&
  Number.isFinite(value.mtime)&&value.mtime>=0&&value.mtime<=8640000000000000&&revision(value.etag);
const cancelBody=response=>{try{response?.body?.cancel().catch(()=>{});}catch{/* ignored server body */}};

export function createRoomFilesClient({roomId,request,current=()=>true,signal}={}){
  if(!segment(roomId)||typeof request!=='function'||typeof current!=='function')throw TypeError('Room and request required');
  const room=roomId,base=`/api/rooms/${encodeURIComponent(room)}/files`,pending=new Set();
  let destroyed=false;
  const active=()=>{try{return !destroyed&&!signal?.aborted&&current()===true;}catch{return false;}};
  function destroy(){
    destroyed=true;
    signal?.removeEventListener('abort',destroy);
    for(const controller of pending)controller.abort();
    pending.clear();
  }
  signal?.addEventListener('abort',destroy,{once:true});
  const filePath=(dir,rel)=>`${base}/${dir}/${rel.split('/').map(encodeURIComponent).join('/')}`;
  function project(answer){
    if(!Array.isArray(answer?.entries)||answer.entries.length>MAX_ENTRIES)return null;
    const entries=[],seen=new Set();
    for(const entry of answer.entries){
      if(!entry||!segment(entry.name)||seen.has(entry.name)||!['file','dir'].includes(entry.kind)||
        !Number.isSafeInteger(entry.size)||entry.size<0||!Number.isFinite(entry.mtime)||entry.mtime<0||entry.mtime>8640000000000000)return null;
      // Listing ETags may be cached. They are display metadata, never a
      // conditional mutation's baseline; obtain that from a fresh raw GET.
      seen.add(entry.name);entries.push({name:entry.name,kind:entry.kind,size:entry.size,mtime:entry.mtime});
    }
    return entries;
  }
  async function boundedBody(response,limit,controller,live=active){
    if(!response.body)return{parts:[]};
    const reader=response.body.getReader(),parts=[];
    let size=0,finished=false;
    const cancel=()=>{try{reader.cancel().catch(()=>{});}catch{/* fixed outer error result */}};
    controller.signal.addEventListener('abort',cancel,{once:true});
    try{
      while(true){
        if(!live())return{error:changed()};
        const {done,value}=await reader.read();
        if(!live())return{error:changed()};
        if(done){finished=true;return{parts};}
        if(!(value instanceof Uint8Array))return{error:unavailable()};
        size+=value.byteLength;
        if(size>limit)return{error:{ok:false,code:'too-large',limitBytes:limit,sizeBytes:size}};
        parts.push(value);
      }
    }finally{
      controller.signal.removeEventListener('abort',cancel);
      if(!finished)cancel();
      reader.releaseLock();
    }
  }
  async function send(path,options,read,operationSignal){
    const uncertain=()=>options.method==='POST'||options.method==='PUT'||options.method==='DELETE'?{ok:false,code:'unconfirmed'}:unavailable();
    const live=()=>active()&&!operationSignal?.aborted;
    if(!live())return changed();
    const controller=new AbortController();pending.add(controller);
    const abort=()=>controller.abort();operationSignal?.addEventListener('abort',abort,{once:true});
    try{
      // Check immediately before invoking the supplied transport as well as after
      // both awaits: a response body may finish after its room has been closed.
      if(!live())return changed();
      const response=await request(path,{...options,signal:controller.signal});
      if(!live()){cancelBody(response);return changed();}
      if(!response?.ok){
        const status=response?.status;
        let details=null;
        if([403,412,413].includes(status)){
          // The only server detail that leaves this bounded body is a fixed
          // reason enum (or numeric limit), never a raw message or path.
          try{const body=await boundedBody(response,MAX_REPLY_BYTES,controller,live);if(!live())return changed();if(!body.error)details=JSON.parse(await new Blob(body.parts).text());}catch{}
        }else cancelBody(response);
        if(!live())return changed();
        const code=({401:'sign-in',403:'forbidden',404:'not-found',409:'conflict',412:'conflict',413:'too-large',428:'reload-required'})[status]||'unavailable';
        const reason=status===412?(details?.error==='gone'?'deleted':details?.error==='changed'?'changed':'unmapped'):status===403&&details?.error==='person_only'?'person-only':null;
        const limit=Number.isSafeInteger(details?.max)&&details.max>0?details.max:MAX_ROOM_FILE_BYTES;
        return{ok:false,code,...(Number.isInteger(status)?{status}:{}),...(reason?{reason}:{}),...(status===413?{limitBytes:limit}:{})};
      }
      if(read){
        const noteRevision=read==='note-read'||read==='revision'?response.headers.get('etag'):null;
        if((read==='note-read'||read==='revision')&&!revision(noteRevision)){cancelBody(response);return live()?unavailable():changed();}
        if(read==='revision'){
          // No HEAD route exists. The raw GET's header is authoritative for
          // this response; do not read a potentially large companion's bytes.
          cancelBody(response);return live()?{ok:true,revision:noteRevision}:changed();
        }
        // Never call Response.json/blob: they allocate an unbounded body first.
        // Stream and count actual decoded bytes even if Content-Length is absent
        // or inaccurate; stop reading and cancel at the first overflowing chunk.
        const limit=read==='list'?MAX_LIST_BYTES:read==='upload'||read==='note-write'?MAX_REPLY_BYTES:MAX_ROOM_FILE_BYTES;
        const body=await boundedBody(response,limit,controller,live);
        if(!live())return changed();
        if(body.error)return read==='upload'||read==='note-write'?uncertain():body.error;
        if(read==='blob'){
          const baseline=response.headers.get('etag');
          return{ok:true,blob:new Blob(body.parts,{type:response.headers.get('content-type')||''}),...(revision(baseline)?{revision:baseline}:{})};
        }
        let text;
        if(read==='note-read'){
          // Do not turn malformed UTF-8 into replacement characters that a
          // subsequent save could silently write over the original bytes.
          const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}),parts=[];
          for(const part of body.parts)parts.push(decoder.decode(part,{stream:true}));
          parts.push(decoder.decode());text=parts.join('');
          if(text.includes('\u0000'))return unavailable();
        }else text=await new Blob(body.parts).text();
        if(!live())return changed();
        if(read==='note-read')return{ok:true,text,revision:noteRevision};
        const answer=JSON.parse(text);
        if(read==='upload'||read==='note-write'){
          if(!metadata(answer))return uncertain();
          return read==='upload'?{ok:true,name:answer.name}:{ok:true,revision:answer.etag};
        }
        const entries=project(answer);
        return entries?{ok:true,entries}:unavailable();
      }
      cancelBody(response);
      return{ok:true};
    }catch{
      return live()?uncertain():changed();
    }finally{
      pending.delete(controller);
      operationSignal?.removeEventListener('abort',abort);
      if(!live())controller.abort();
    }
  }
  function bodyError(body){
    if(!(body instanceof Blob))return invalid();
    return body.size>MAX_ROOM_FILE_BYTES?{ok:false,code:'too-large',limitBytes:MAX_ROOM_FILE_BYTES,sizeBytes:body.size}:null;
  }
  return Object.freeze({
    roomId:room,
    list(dir,sub=''){
      if(!active())return Promise.resolve(changed());
      if(!directories.has(dir)||!relative(sub,true))return Promise.resolve(invalid());
      return send(`${base}?dir=${dir}&sub=${encodeURIComponent(sub)}`,{method:'GET'},'list');
    },
    read(dir,rel){
      if(!active())return Promise.resolve(changed());
      if(!directories.has(dir)||!relative(rel))return Promise.resolve(invalid());
      return send(filePath(dir,rel),{method:'GET'},'blob');
    },
    readRevision(dir,rel,{signal:operationSignal}={}){
      if(!active()||operationSignal?.aborted)return Promise.resolve(changed());
      if(!directories.has(dir)||!relative(rel))return Promise.resolve(invalid());
      return send(filePath(dir,rel),{method:'GET'},'revision',operationSignal);
    },
    readNote(name,{signal:operationSignal}={}){
      if(!active()||operationSignal?.aborted)return Promise.resolve(changed());
      if(!relative(name))return Promise.resolve(invalid());
      return send(filePath('notes',name),{method:'GET'},'note-read',operationSignal);
    },
    writeNote(name,text,{revision:baseline,signal:operationSignal}={}){
      if(!active()||operationSignal?.aborted)return Promise.resolve(changed());
      if(!relative(name)||typeof text!=='string')return Promise.resolve(invalid());
      if(!revision(baseline))return Promise.resolve({ok:false,code:'reload-required'});
      const body=new Blob([text],{type:'text/plain; charset=utf-8'}),error=bodyError(body);
      if(error)return Promise.resolve(error);
      return send(filePath('notes',name),{method:'PUT',body,headers:{'if-match':baseline}},'note-write',operationSignal);
    },
    write(dir,rel,body,{revision:baseline}={}){
      if(!active())return Promise.resolve(changed());
      if(!directories.has(dir)||!relative(rel))return Promise.resolve(invalid());
      const error=bodyError(body);if(error)return Promise.resolve(error);
      if(baseline!==undefined&&!revision(baseline))return Promise.resolve(invalid());
      return send(filePath(dir,rel),{method:'PUT',body,headers:baseline===undefined?{'if-none-match':'*'}:{'if-match':baseline}});
    },
    upload(dir,body,name=body?.name){
      if(!active())return Promise.resolve(changed());
      if(!directories.has(dir)||!segment(name))return Promise.resolve(invalid());
      const error=bodyError(body);if(error)return Promise.resolve(error);
      // Engine room-files.ts decodes this header once, reads raw bytes, and
      // returns the actual basename after applying no-overwrite suffixes.
      return send(`${base}/${dir}`,{method:'POST',body,headers:{'x-filename':encodeURIComponent(name)}},'upload');
    },
    remove(dir,rel,{revision:baseline}={}){
      if(!active())return Promise.resolve(changed());
      if(!directories.has(dir)||!relative(rel))return Promise.resolve(invalid());
      if(baseline!==undefined&&!revision(baseline))return Promise.resolve(invalid());
      return send(filePath(dir,rel),{method:'DELETE',...(baseline===undefined?{}:{headers:{'if-match':baseline}})});
    },
    destroy,
  });
}
