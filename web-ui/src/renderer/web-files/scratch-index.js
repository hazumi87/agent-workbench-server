// Browser adaptation of the team' scratch-index reader (handoff <commit>).
// request() owns same-origin authentication. This is the legacy note/asset
// record index, NOT an index over the new FILES_DIR room tree. No paths, file
// locators, inferred refs, family queries, or persistent copies leave this seam.
export const LIMITS=Object.freeze({limitDefault:50,limitMax:200,cursorBytes:512,pageBytes:256*1024});
const encoder=new TextEncoder();
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const encodable=value=>{try{encodeURIComponent(value);return true;}catch{return false;}};
const roomName=value=>typeof value==='string'&&value.length>0&&value.length<=128&&value!=='.'&&value!=='..'&&!/[\\/\u0000-\u001f\u007f]/.test(value)&&encodable(value);
const cursorValue=value=>typeof value==='string'&&value.length>0&&encoder.encode(value).byteLength<=LIMITS.cursorBytes&&encodable(value);
const text=(value,max)=>typeof value==='string'?value.slice(0,max):'';
const optionalText=(value,max)=>typeof value==='string'&&value.length<=max?value:null;
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const timestamp=value=>count(value)!==null&&value<=8640000000000000?value:null;
const ref=/^(?:line_\d{1,12}|(?:note|asset)_[0-9a-f]{12})$/;
const assetId=/^[0-9a-f]{12}$/;
const fail=(why,extra={})=>({ok:false,why,...extra});
const cancelBody=response=>{try{response?.body?.cancel().catch(()=>{});}catch{/* no raw transport diagnostics */}};

function companion(value){
  if(!plain(value)||!['annotations','annotated'].includes(value.kind)||typeof value.asset_id!=='string'||!assetId.test(value.asset_id))return null;
  return Object.freeze({name:text(value.name,255),kind:value.kind,asset_id:value.asset_id,size:count(value.size),
    ...(typeof value.by==='string'?{by:text(value.by,128)}:{})});
}
function project(value,room){
  if(!plain(value)||value.room_id!==room||!['asset','note'].includes(value.kind)||typeof value.id!=='string'||!value.id||value.id.length>128||/[\u0000-\u001f\u007f]/.test(value.id))return null;
  const companions=[];
  if(Array.isArray(value.companions))for(const candidate of value.companions){const result=companion(candidate);if(result)companions.push(result);if(companions.length===8)break;}
  const presence=typeof value.inEngine==='boolean'?value.inEngine:null;
  return Object.freeze({
    ref:typeof value.ref==='string'&&ref.test(value.ref)?value.ref:null,
    id:value.id,room_id:room,kind:value.kind,name:text(value.name,255),type:text(value.type,255),size:count(value.size),author:text(value.author,128),
    created_at:timestamp(value.created_at),modified_at:timestamp(value.modified_at),version:optionalText(value.version,64),
    inEngine:presence,residency:presence===true&&value.residency==='local'?'local':'unknown',
    batch_id:typeof value.batch_id==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(value.batch_id)?value.batch_id:null,
    companions:Object.freeze(companions),preview:value.kind==='note'&&typeof value.preview==='string'?value.preview.slice(0,800):null,
  });
}

export function createRoomScratchIndex({roomId,request,current=()=>true,signal}={}){
  if(!roomName(roomId)||typeof request!=='function'||typeof current!=='function')throw TypeError('Room and index transport required');
  const room=roomId,base=`/api/rooms/${encodeURIComponent(room)}/assets/index`,cursors=new Map(),used=new Set(),pending=new Set();
  let epoch=0,destroyed=false,revoked=false;
  function invalidate(){++epoch;cursors.clear();used.clear();for(const controller of pending)controller.abort();pending.clear();}
  const revoke=()=>{revoked=true;invalidate();};
  function active(){
    if(destroyed||revoked)return false;
    try{if(!signal?.aborted&&current()===true)return true;}catch{/* detached owner */}
    revoke();return false;
  }
  signal?.addEventListener('abort',revoke,{once:true});
  async function readBody(response,controller,live){
    const reader=response.body?.getReader();if(!reader)throw Error('transport');
    const parts=[];let size=0,finished=false;
    const cancel=()=>{try{reader.cancel().catch(()=>{});}catch{/* already canceled */}};
    controller.signal.addEventListener('abort',cancel,{once:true});
    try{
      for(;;){
        if(!live())throw Error('stale');
        const {value,done}=await reader.read();
        if(!live())throw Error('stale');
        if(done){finished=true;break;}
        if(!(value instanceof Uint8Array))throw Error('transport');
        size+=value.byteLength;if(size>LIMITS.pageBytes)throw Error('transport');
        parts.push(value);
      }
      const bytes=new Uint8Array(size);let offset=0;
      for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
      return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    }finally{
      controller.signal.removeEventListener('abort',cancel);
      if(!finished)cancel();reader.releaseLock();
    }
  }
  return Object.freeze({
    async page({cursor=null,limit=LIMITS.limitDefault}={}){
      if(!active())return fail('stale');
      if(!Number.isInteger(limit)||limit<1||limit>LIMITS.limitMax)return fail('limit');
      const mine=epoch;
      let held=null;
      if(cursor!==null){
        const record=cursorValue(cursor)?cursors.get(cursor):null;
        if(!record||record.busy||record.epoch!==mine)return fail('cursor');
        record.busy=true;held=record;
      }
      const controller=new AbortController();pending.add(controller);
      const live=()=>active()&&mine===epoch&&!controller.signal.aborted;
      const failure=(why,extra)=>{
        if(!live())return fail('stale');
        if(held&&cursors.get(cursor)===held)held.busy=false;
        return fail(why,extra);
      };
      try{
        if(!live())return fail('stale');
        const query=new URLSearchParams({scope:'room',limit:String(limit)});if(held)query.set('cursor',cursor);
        const response=await request(`${base}?${query}`,{method:'GET',signal:controller.signal});
        if(!live()){cancelBody(response);return fail('stale');}
        if(response?.status!==200){
          cancelBody(response);
          return Number.isInteger(response?.status)&&response.status>=100&&response.status<=599?failure('engine',{status:response.status}):failure('transport');
        }
        const body=await readBody(response,controller,live);
        if(!live())return fail('stale');
        if(!plain(body)||!Array.isArray(body.items)||body.items.length>limit||count(body.total)===null||body.total<body.items.length)return failure('transport');
        const next=body.next_cursor===undefined||body.next_cursor===null?null:body.next_cursor;
        if(next!==null&&(!cursorValue(next)||next===cursor||used.has(next)||cursors.get(next)?.busy))return failure('transport');
        const items=Object.freeze(body.items.map(value=>project(value,room)).filter(Boolean));
        if(held){cursors.delete(cursor);used.add(cursor);}
        if(next!==null&&!cursors.has(next))cursors.set(next,{epoch:mine,busy:false});
        return Object.freeze({ok:true,items,cursor:next,total:body.total});
      }catch{return failure('transport');}
      finally{pending.delete(controller);if(!live())controller.abort();}
    },
    // Restart pagination after a refresh/switch/hide. Consumed cursors become
    // valid again only if the engine issues them under this new view epoch.
    bump(){if(!destroyed)invalidate();},
    destroy(){if(destroyed)return;destroyed=true;signal?.removeEventListener('abort',revoke);invalidate();},
  });
}
