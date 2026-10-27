// Pure editor state. The owner supplies a room-bound conditional transport;
// revision is opaque here. No route, header, ETag, or authentication is assumed.
const sizeText=value=>value>=1048576?Math.ceil(value/1048576)+' MB':value>=1024?Math.ceil(value/1024)+' KB':value+' B';
const segment=value=>typeof value==='string'&&value.length>0&&value.length<=255&&value!=='.'&&value!=='..'&&!/[\u0000-\u001f\u007f/\\]/.test(value);
const noteName=value=>typeof value==='string'&&value.length<=4096&&!/^[A-Za-z]:\//.test(value)&&value.split('/').every(segment);
const validRevision=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&!/[\u0000-\u001f\u007f]/.test(value)&&value.trim().length>0;
const failure=code=>({ok:false,code});
const empty=()=>({open:false,busy:false,text:'',savedText:'',revision:null,dirty:false,error:null,message:null,needsReload:false});

export function createNoteEditorModel({roomId,name,read,write,current=()=>true,onState=()=>{},signal,draft,serverAnswer}={}){
  if(!segment(roomId)||!noteName(name)||typeof read!=='function'||typeof write!=='function'||typeof current!=='function'||typeof serverAnswer!=='function')throw TypeError('Note binding and transport required');
  const room=roomId,note=name;
  const messageFor=code=>code==='conflict'?serverAnswer('note.save',{status:412,reason:'changed'}):code==='deleted'?serverAnswer('note.save',{status:412,reason:'deleted'}):code==='person-only'?serverAnswer('person-only',{status:403,reason:'person-only'}):code==='server'?serverAnswer('generic',{}):null;
  let state=empty(),epoch=0,pending=null,operation=null,revoked=false,destroyed=false;
  const snapshot=()=>({...state});
  function revoke(){
    revoked=true;++epoch;
    const previous=pending;pending=null;operation=null;previous?.abort();
  }
  function active(){
    if(destroyed||revoked)return false;
    let allowed=false;
    try{allowed=!signal?.aborted&&current()===true;}catch{/* detached owner */}
    if(!allowed)revoke();
    return allowed;
  }
  const live=mine=>active()&&state.open&&mine===epoch;
  const publish=()=>{if(active())try{onState(snapshot());}catch{/* detached view cannot change ownership */}};
  signal?.addEventListener('abort',revoke,{once:true});
  function begin(kind){
    const controller=new AbortController();pending=controller;operation=kind;
    const mine=++epoch;state={...state,busy:true,error:null};publish();
    return{controller,mine};
  }
  function finish(mine){
    if(live(mine)){pending=null;operation=null;state={...state,busy:false};publish();}
  }
  async function load(){
    const {controller,mine}=begin('read');
    try{
      if(!live(mine))return failure('changed');
      const answer=await read(note,{signal:controller.signal});
      if(!live(mine))return failure('changed');
      if(answer?.ok===true&&typeof answer.text==='string'&&validRevision(answer.revision)){
        state={...state,text:answer.text,savedText:answer.text,revision:answer.revision,dirty:false,error:null,message:null,needsReload:false};
        return{ok:true};
      }
      const code=answer?.code==='not-found'&&validRevision(state.revision)?'deleted':answer?.reason==='person-only'||answer?.code==='sign-in'?'person-only':answer?.code==='forbidden'?'forbidden':'unavailable';
      state={...state,error:code,message:messageFor(code)||"Can't read this file."};return failure(code);
    }catch{
      if(!live(mine))return failure('changed');
      state={...state,error:'unavailable'};return failure('unavailable');
    }finally{finish(mine);}
  }
  async function save(){
    if(!active())return failure('changed');
    if(!state.open)return failure('closed');
    if(state.busy)return failure('busy');
    // An uncertain mutation or missing baseline can never turn into a retry
    // without the person explicitly reading the saved note first.
    if(state.needsReload||!validRevision(state.revision))return failure('reload-required');
    if(!state.dirty)return{ok:true};
    const sentText=state.text,revision=state.revision;
    const {controller,mine}=begin('write');
    try{
      if(!live(mine))return failure('changed');
      const answer=await write(note,sentText,{revision,signal:controller.signal});
      if(!live(mine))return failure('changed');
      if(answer?.ok===true&&validRevision(answer.revision)){
        state={...state,savedText:sentText,revision:answer.revision,dirty:state.text!==sentText,error:null,message:null,needsReload:false};
        return{ok:true};
      }
      if(answer?.ok===false&&answer.code==='conflict'){
        const code=answer.reason==='deleted'?'deleted':answer.reason===undefined||answer.reason==='changed'?'conflict':'server';
        state={...state,error:code,message:code==='server'?serverAnswer('note.save',{status:answer.status||412,reason:answer.reason}):messageFor(code),needsReload:true};return failure(code);
      }
      if(answer?.code==='too-large'&&Number.isSafeInteger(answer.sizeBytes)&&Number.isSafeInteger(answer.limitBytes)){
        state={...state,error:'too-large',message:serverAnswer('upload',{status:413,name:note,size:sizeText(answer.sizeBytes),limit:sizeText(answer.limitBytes)})};return failure('too-large');
      }
      if(answer?.reason==='person-only'||answer?.code==='sign-in'){
        state={...state,error:'person-only',message:messageFor('person-only')};return failure('forbidden');
      }
      if(answer?.ok===false&&answer.code==='forbidden'){
        state={...state,error:'forbidden',message:serverAnswer('person-only',{status:403,reason:answer.reason||answer.code})};return failure('forbidden');
      }
      const code=Number.isInteger(answer?.status)?'server':'unavailable';
      state={...state,error:code,message:code==='server'?serverAnswer('note.save',{status:answer.status,reason:answer.code}):messageFor(code),needsReload:true};return failure(code);
    }catch{
      if(!live(mine))return failure('changed');
      state={...state,error:'unavailable',needsReload:true};return failure('unavailable');
    }finally{finish(mine);}
  }
  function close({discard=false}={}){
    if(!active())return failure('changed');
    if((state.dirty||operation==='write')&&discard!==true)return failure('blocked');
    ++epoch;const previous=pending;pending=null;operation=null;state=empty();previous?.abort();publish();return{ok:true};
  }
  return Object.freeze({
    roomId:room,name:note,state(){active();return snapshot();},
    open(){
      if(!active())return Promise.resolve(failure('changed'));
      if(state.open)return Promise.resolve(state.dirty||state.busy?failure('blocked'):{ok:true});
      if(draft&&typeof draft.text==='string'&&typeof draft.savedText==='string'&&validRevision(draft.revision)){
        // A parked draft keeps its ORIGINAL baseline. Re-reading and silently
        // adopting a newer revision here would defeat conditional save.
        const error=messageFor(draft.error)?draft.error:draft.needsReload?'unavailable':null;
        state={...empty(),open:true,text:draft.text,savedText:draft.savedText,revision:draft.revision,dirty:draft.text!==draft.savedText,needsReload:draft.needsReload===true,error,message:messageFor(error)};
        draft=null;publish();return Promise.resolve({ok:true});
      }
      state={...empty(),open:true};return load();
    },
    setText(text){
      if(!active())return failure('changed');
      if(!state.open)return failure('closed');
      if(operation==='read')return failure('busy');
      if(typeof text!=='string')return failure('invalid');
      state={...state,text,dirty:text!==state.savedText};publish();return{ok:true};
    },
    save,
    reload(){
      if(!active())return Promise.resolve(failure('changed'));
      if(!state.open)return Promise.resolve(failure('closed'));
      if(state.busy)return Promise.resolve(failure('busy'));
      return load();
    },
    close,hide:close,
    destroy(){
      if(destroyed)return;
      destroyed=true;signal?.removeEventListener('abort',revoke);revoke();state={...state,open:false,busy:false};
    },
  });
}
