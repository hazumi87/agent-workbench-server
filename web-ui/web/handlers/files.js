'use strict';
// Browser-only namespace. Foundation owns same-origin cookies and CSRF;
// engine routes own person admission, room access and filesystem containment.
const {createFolderDirectoryLoader,createFolderDirectoryCreator}=require('../../src/renderer/web-files/folder-picker-client.js');
const {createRoomFilesClient}=require('../../src/renderer/web-files/room-files-client.js');
const {createServerFolderChooser}=require('../../src/renderer/web-files/folder-picker.js');
const {createRoomScratchpadPage}=require('../../src/renderer/web-files/scratchpad-page.js');
const {sayServerAnswer}=require('../lib/server-answers.js');
const {createRoomScratchIndex}=require('../../src/renderer/web-files/scratch-index.js');

function register(api){
  if(typeof api?.engine?.fetch!=='function'||typeof api?.expose!=='function')throw TypeError('Web files bridge required');
  const request=(path,options)=>api.engine.fetch(path,options);
  const chooser=createServerFolderChooser({load:createFolderDirectoryLoader({request}),createDirectory:createFolderDirectoryCreator({request})});
  let context=null,selected=null,epoch=0,offRoom=null;const listeners=new Set(),clients=new Set();
  const copy=()=>context?{...context,epoch}:null;
  const publish=()=>{for(const listener of [...listeners])try{listener(copy());}catch{}};
  function roomShown(value){
    const id=value?.roomId;
    const next=typeof id==='string'&&id.length>0&&id.length<=255&&id!=='.'&&id!=='..'&&!/[\\/\u0000-\u001f\u007f]/.test(id)?{roomId:id,familyId:typeof value.familyId==='string'?value.familyId:null,group:typeof value.group==='string'?value.group:null,...(typeof value.roomName==='string'&&value.roomName.length<=4096?{roomName:value.roomName}:{})}:null;
    if(JSON.stringify(next)===JSON.stringify(context))return;
    context=next;if(next)selected=next;++epoch;const old=[...clients];clients.clear();for(const client of old)client.destroy();publish();
  }
  // Does a sent picture have marks? Until the engine says so on the attachment, ONE GET per picture for the session (200 = <name>.annotations.svg exists; anything else = none). The ASSETS route (the one the picture itself comes from), never /files/assets, which only reads the room's asset folder in hosted mode.
  const marks=new Map();
  function hasMarks(roomId,name){
    if(typeof roomId!=='string'||!roomId||roomId.length>255||/[\\/\u0000-\u001f\u007f]/.test(roomId)||typeof name!=='string'||!name||name.length>240||/[\\/\u0000-\u001f\u007f]/.test(name))return Promise.resolve(false);
    const key=roomId+'\n'+name;if(marks.has(key))return marks.get(key);
    if(marks.size>=500)marks.delete(marks.keys().next().value);
    const answer=(async()=>{
      try{const r=await request('/api/rooms/'+encodeURIComponent(roomId)+'/assets/raw/'+encodeURIComponent(name+'.annotations.svg'),{method:'GET',headers:{accept:'image/svg+xml'}});
        try{await r.body?.cancel?.();}catch{}
        return r.status===200;}
      catch{marks.delete(key);return false;} // a transport failure is not an answer: ask again next time
    })();
    marks.set(key,answer);return answer;
  }
  const files=Object.freeze({
    hasMarks,roomShown,roomState:copy,serverAnswer:sayServerAnswer,
    subscribeRoom(listener){if(typeof listener!=='function')throw TypeError('Room listener required');listeners.add(listener);try{listener(selected?{...selected,epoch}:null);}catch{}return()=>listeners.delete(listener);},
    createPage:options=>{
      if(!offRoom)offRoom=globalThis.wb?.web?.events?.on('room-shown',roomShown)||null;
      return createRoomScratchpadPage({...options,files});
    },
    chooseFolder:options=>chooser.choose(options),
    async pickFolder(initial=null,options={}){
      const result=await chooser.choose({...options,initialPath:typeof initial==='string'?initial:null});
      if(result.ok)return result.path;
      if(['cancelled','changed'].includes(result.code))return null;
      throw Object.assign(Error("Couldn't list the folders. Try again."),{code:result.code});
    },
    dispose:()=>{marks.clear();chooser.dispose();roomShown(null);selected=null;offRoom?.();offRoom=null;listeners.clear();},
    directoryLoader:({current}={})=>createFolderDirectoryLoader({request,current}),
    index:(roomId,{current=()=>true,signal}={})=>{
      const captured=epoch,reader=createRoomScratchIndex({roomId,request,signal,current:()=>captured===epoch&&selected?.roomId===roomId&&current()===true});
      const wrapped=Object.freeze({...reader,destroy(){clients.delete(wrapped);reader.destroy();}});clients.add(wrapped);return wrapped;
    },
    room:(roomId,{current=()=>true,signal}={})=>{
      const captured=epoch,client=createRoomFilesClient({roomId,request,signal,current:()=>captured===epoch&&selected?.roomId===roomId&&current()===true});
      const wrapped=Object.freeze({...client,destroy(){clients.delete(wrapped);client.destroy();}});clients.add(wrapped);return wrapped;
    },
  });
  api.expose('files',files);
}
module.exports={register};
