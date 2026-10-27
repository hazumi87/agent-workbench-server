import {createRoomFilesModel} from './room-files-model.js';
import {createNoteEditorModel} from './note-editor-model.js';
import {createScratchCards} from './cards-view.js';
import {confirmDialog} from './confirm-dialog.js';

// Browser-only room Scratchpad. Names and note contents are always text, never
// markup. The engine, rather than this selection state, authorizes every read.
export function createRoomScratchpadPage({host,files,document=host?.ownerDocument,confirm=message=>confirmDialog(message,{document}),openBlob,downloadBlob,prefs}={}){
  if(!host||!document||!files||typeof files.serverAnswer!=='function')throw TypeError('Scratchpad host and files required');
  const serverAnswer=files.serverAnswer;
  const folderSettings=document.getElementById?.('gsScratchpad');if(folderSettings)folderSettings.hidden=true;
  let shown=false,destroyed=false,room=null,roomName=null,client=null,model=null,epoch=0,editor=null,editorName=null,tab='assets',addingNote=false,cards=null,newNoteSource=null,needsListCheck=false;
  const viewPrefs=prefs||{get(){try{return globalThis.localStorage?.getItem('wb.web.files.view');}catch{return null;}},set(value){try{globalThis.localStorage?.setItem('wb.web.files.view',value);}catch{}}};
  const parked=new Map(),urls=new Set(),removers=[];
  const make=(tag,cls,text)=>{const node=document.createElement(tag);node.className=cls;if(text!==undefined)node.textContent=text;return node;};
  const bind=(node,event,fn)=>{node.addEventListener(event,fn);removers.push(()=>node.removeEventListener(event,fn));};
  const root=make('section','wb-room-files');root.tabIndex=0;root.setAttribute('aria-label','Room Scratchpad');
  const title=make('h1','wb-room-files__title','Scratchpad');
  const context=make('p','wb-room-files__room','Choose a room in Workrooms first.');
  const subtitle=make('p','wb-room-files__subtitle','Notes, assets and files for this room. Kept on this server. Agents in this room can read them.');
  const tabs=make('div','wb-room-files__tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Room files');
  const tabButtons=new Map();
  for(const [key,label] of [['notes','Notes'],['assets','Assets'],['files','Files']]){const b=make('button','wb-room-files__tab',label);b.type='button';b.setAttribute('role','tab');bind(b,'click',()=>void changeTab(key));tabs.append(b);tabButtons.set(key,b);}
  const input=make('input','wb-room-files__input');input.type='file';input.multiple=true;input.hidden=true;input.setAttribute('aria-label','Add files');
  const add=make('button','wb-room-files__add','Add files');add.type='button';bind(add,'click',()=>input.click());
  const refresh=make('button','wb-room-files__refresh','Check the list');refresh.type='button';refresh.hidden=true;bind(refresh,'click',()=>{needsListCheck=false;if(model)void model.refresh();});
  const newNote=make('button','wb-room-files__new-note','New note');newNote.type='button';newNote.hidden=true;
  const newNoteForm=make('div','wb-room-files__new-note-form');newNoteForm.hidden=true;
  const newName=make('input','wb-room-files__new-note-name');newName.type='text';newName.setAttribute('aria-label','Note name');
  const newNameLabel=make('label','wb-room-files__new-note-label');newNameLabel.append(make('span','','Note name'),newName);
  const createNote=make('button','wb-room-files__create-note','Create note'),cancelNote=make('button','wb-room-files__cancel-note','Cancel');createNote.type=cancelNote.type='button';
  newNoteForm.append(newNameLabel,createNote,cancelNote);bind(newNote,'click',()=>{newNoteSource=null;newNoteForm.hidden=false;newName.focus();});bind(cancelNote,'click',()=>{if(!addingNote){newNoteForm.hidden=true;newNoteSource=null;}});
  bind(createNote,'click',()=>void addNote());bind(newName,'keydown',event=>{if(event.key==='Enter'){event.preventDefault();void addNote();}});
  const hint=make('p','wb-room-files__hint','Drag files here, paste, or choose Add files.');
  const status=make('p','wb-room-files__status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const list=make('ul','wb-room-files__list');list.setAttribute('aria-label','Files in this room');
  const edit=make('section','wb-room-files__editor');edit.hidden=true;
  const editTitle=make('h2','wb-room-files__note-title');
  const text=make('textarea','wb-room-files__note-text');text.setAttribute('aria-label','Note text');
  const noteStatus=make('p','wb-room-files__note-status');noteStatus.setAttribute('role','status');
  const save=make('button','wb-room-files__save','Save note'),reload=make('button','wb-room-files__reload','Reload saved note'),close=make('button','wb-room-files__close','Close note');
  const saveAsNew=make('button','wb-room-files__save-new','Save as new note');saveAsNew.type='button';saveAsNew.hidden=true;
  bind(saveAsNew,'click',()=>{if(!editor||editor.state().error!=='deleted'||addingNote)return;newNoteSource={owner:editor,name:editorName,epoch};newName.value='';newNoteForm.hidden=false;newName.focus();});
  for(const b of [save,reload,close])b.type='button';
  bind(text,'input',()=>editor?.setText(text.value));bind(save,'click',()=>void editor?.save());
  bind(reload,'click',()=>void reloadNote());bind(close,'click',()=>void closeNote());
  const tools=make('div','wb-room-files__tools');tools.append(add,refresh,newNote);
  edit.append(editTitle,text,noteStatus,save,saveAsNew,reload,close);root.append(title,context,subtitle,tabs,input,tools,newNoteForm,hint,status,list,edit);host.replaceChildren(root);
  const live=mine=>!destroyed&&shown&&room&&epoch===mine;
  function park(){
    if(editor){const state=editor.state(),key=room+'\n'+editorName;if(state.dirty||state.needsReload)parked.set(key,{text:state.text,revision:state.revision,savedText:state.savedText,needsReload:state.needsReload||state.busy,error:state.busy?'unavailable':state.error});else parked.delete(key);editor.destroy();}
    editor=null;editorName=null;edit.hidden=true;
  }
  function deactivate(){needsListCheck=false;refresh.hidden=true;park();++epoch;cards?.destroy();cards=null;addingNote=false;newNoteSource=null;saveAsNew.hidden=true;createNote.disabled=false;cancelNote.disabled=false;newName.disabled=false;newNoteForm.hidden=true;newName.value='';model?.destroy();model=null;client?.destroy();client=null;for(const url of urls)URL.revokeObjectURL(url);urls.clear();}
  function paintEditor(s){
    if(!s.dirty&&!s.needsReload)parked.delete(room+'\n'+editorName);
    edit.hidden=!s.open;if(text.value!==s.text)text.value=s.text;text.disabled=s.busy&&!s.revision;
    save.disabled=s.busy||!s.dirty||s.needsReload||!s.revision;reload.disabled=s.busy||addingNote;close.disabled=s.busy||addingNote;saveAsNew.hidden=s.error!=='deleted';saveAsNew.disabled=s.busy||addingNote;
    noteStatus.textContent=s.message|| (s.error==='unavailable'?'Lost the connection while saving. Reload the saved note to see if it went through. Your draft is still here.':s.error?"Can't read this file.":s.dirty?'Unsaved changes':'Saved');
  }
  async function closeNote(){const owner=editor,mine=epoch;if(!owner)return true;if(owner.state().dirty&&await confirm('Discard the changes to this note?')!==true)return false;if(owner!==editor||!live(mine))return false;owner.close({discard:true});parked.delete(room+'\n'+editorName);owner.destroy();editor=null;editorName=null;edit.hidden=true;return true;}
  async function reloadNote(){const owner=editor;if(!owner)return;if(owner.state().dirty&&await confirm('Replace your draft with the saved note?')!==true)return;if(owner===editor)await owner.reload();}
  async function openNote(name){
    const mine=epoch;if(!await closeNote()||!live(mine))return;
    editorName=name;editTitle.textContent=name;
    const draft=parked.get(room+'\n'+name),transport=client;
    editor=createNoteEditorModel({roomId:room,name,serverAnswer,read:transport.readNote,write:transport.writeNote,current:()=>live(mine),onState:paintEditor,draft});
    await editor.open();if(live(mine))text.focus();
  }
  async function recoverNote(source,name,sentText,mine,transport){
    // Do not close or clear the deleted editor until the newly created note has
    // a confirmed read baseline. Edits made during either await stay in it.
    if(!live(mine)||editor!==source.owner)return false;
    let candidate;
    candidate=createNoteEditorModel({roomId:room,name,serverAnswer,read:transport.readNote,write:transport.writeNote,
      current:()=>live(mine)&&(editor===source.owner||editor===candidate),
      onState:s=>{if(editor===candidate)paintEditor(s);}});
    const result=await candidate.open();
    if(!live(mine)||editor!==source.owner){candidate.destroy();return false;}
    if(!result.ok){candidate.destroy();status.textContent="Can't read this file.";return false;}
    if(candidate.state().savedText!==sentText){candidate.destroy();status.textContent=serverAnswer('note.save',{status:200,reason:'new-changed'});return false;}
    const latest=source.owner.state().text;
    candidate.setText(latest);
    source.owner.close({discard:true});source.owner.destroy();parked.delete(room+'\n'+source.name);
    editor=candidate;editorName=name;editTitle.textContent=name;newNoteSource=null;
    paintEditor(candidate.state());text.focus();return true;
  }
  async function addNote(){
    if(!shown||!client||!model||model.state().busy||addingNote)return;
    const mine=epoch,owner=client,name=newName.value,source=newNoteSource;
    if(source&&(source.epoch!==mine||source.owner!==editor||editor.state().error!=='deleted'))return;
    if(!name||name==='.'||name==='..'||/[\\/\u0000-\u001f\u007f]/.test(name)){status.textContent=`${name} can't be used as a file name. Rename it and try again.`;return;}
    const sentText=source?source.owner.state().text:'';
    addingNote=true;createNote.disabled=true;cancelNote.disabled=true;newName.disabled=true;paint(model.state());if(editor)paintEditor(editor.state());
    try{
      if(source){
        let baseline;try{baseline=await owner.readRevision('notes',name);}catch{baseline={ok:false,code:'unavailable'};}
        if(!live(mine)||editor!==source.owner)return;
        if(baseline?.ok){status.textContent=serverAnswer('note.save',{status:200,reason:'new-name-exists'});return;}
        // A missing note is the only authoritative permission to attempt a
        // create. POST still never overwrites if another writer wins the gap.
        if(baseline?.code!=='not-found'||baseline.status!==404){status.textContent=failure({name,...baseline});return;}
      }
      let result;try{result=await owner.upload('notes',new Blob([sentText],{type:'text/plain; charset=utf-8'}),name);}catch{result={ok:false,code:'unconfirmed'};}
      if(!live(mine))return;
      if(!result.ok){paint(model.state());status.textContent=failure({name,...result});return;}
      if(source){
        const actual=result.name,oldBasename=source.name.split('/').at(-1);
        if(typeof actual!=='string'||!actual||(actual===oldBasename&&name!==oldBasename)||/[\\/\u0000-\u001f\u007f]/.test(actual)){
          status.textContent=failure({name,code:'unconfirmed'});return;
        }
        if(!await recoverNote(source,actual,sentText,mine,owner))return;
        newNoteForm.hidden=true;newName.value='';await model.refresh('notes','');return;
      }
      newNoteForm.hidden=true;newName.value='';await model.refresh('notes','');if(live(mine))await openNote(result.name||name);
    }finally{
      if(live(mine)){
        const message=status.textContent;
        addingNote=false;createNote.disabled=false;cancelNote.disabled=false;newName.disabled=false;
        paint(model.state());status.textContent=message;
        if(editor)paintEditor(editor.state());
      }
    }
  }
  function blobAction(blob,name,download){
    if(download&&downloadBlob){downloadBlob(blob,name);return;}
    if(!download&&openBlob){openBlob(blob,name);return;}
    // A blob keeps arbitrary uploaded HTML/SVG off the app's origin. Only plain
    // text and raster images may open inline; every other type is downloaded.
    const inline=/^(?:text\/plain(?:;|$)|image\/(?:png|jpeg|gif|webp|avif|bmp)(?:;|$))/i.test(blob.type);
    const url=URL.createObjectURL(blob);urls.add(url);const a=make('a','');a.href=url;a.rel='noopener noreferrer';
    if(download||!inline)a.download=name;else a.target='_blank';root.append(a);a.click();a.remove();
  }
  async function readFile(name,download){const mine=epoch;const result=await model.read(name);if(!live(mine))return;if(result.ok)blobAction(result.blob,name,download);else status.textContent="Can't read this file.";}
  const bytes=n=>n>=1048576?Math.ceil(n/1048576)+' MB':n>=1024?Math.ceil(n/1024)+' KB':n+' B';
  function failure(f){if(f.code==='unconfirmed'){needsListCheck=true;refresh.hidden=false;}if(f.reason==='person-only')return serverAnswer('person-only',{status:403,reason:'person_only'});if(f.code==='too-large')return serverAnswer('upload',{status:413,name:f.name,size:bytes(f.sizeBytes||0),limit:bytes(Number.isFinite(f.limitBytes)&&f.limitBytes>0?f.limitBytes:50*1024*1024)});if(f.code==='invalid')return `${f.name} can't be used as a file name. Rename it and try again.`;if(f.code==='sign-in')return 'You were signed out. Sign in again, then add it again.';if(f.code==='unconfirmed')return `Lost the connection while adding ${f.name}. Try again.`;return `Couldn't add ${f.name}. Try again.`;}
  function paint(s){
    if(!shown||destroyed)return;
    const mine=epoch,owner=model;
    add.hidden=s.dir==='notes';hint.hidden=s.dir==='notes';list.setAttribute('aria-label',s.dir==='notes'?'Notes in this room':'Files in this room');
    add.disabled=s.busy||!!s.sub||addingNote;refresh.disabled=s.busy||addingNote;newNote.hidden=s.dir!=='notes';newNote.disabled=s.busy||!!s.sub||addingNote;for(const [key,b] of tabButtons){b.disabled=s.busy||addingNote;b.setAttribute('aria-selected',String(s.dir===key));b.tabIndex=s.dir===key?0:-1;}
    status.textContent=s.busy?'Loading…':s.failures.length?s.failures.map(failure).join(' '):s.error==='sign-in'?'You were signed out. Sign in again.':s.error?"Couldn't load the files. Try again.":s.entries.length?'':s.dir==='notes'?'No notes yet. Create a note to keep it in this room.':'No files yet. Add files from this device.';
    refresh.textContent=s.error&&!needsListCheck?'Try again':'Check the list';refresh.hidden=!needsListCheck&&!s.error;
    if(!s.busy&&s.notices?.length)status.textContent+=(status.textContent?' ':'')+s.notices.map(n=>`Added as ${n.addedAs} because ${n.name} is already here.`).join(' ');
    cards?.destroy();cards=null;list.replaceChildren();
    if(s.sub){const up=make('button','wb-room-files__up','Up');up.type='button';up.disabled=s.busy;up.addEventListener('click',()=>{if(live(mine)&&model===owner)void owner.refresh(s.dir,s.sub.split('/').slice(0,-1).join('/'));});list.append(up);}
    for(const entry of s.entries.filter(e=>e.kind==='dir')){
      const li=make('li','wb-room-files__row'),label=make('span','wb-room-files__name',entry.name);li.append(label);
      const action=(word,fn)=>{const b=make('button','wb-room-files__action',word);b.type='button';b.disabled=s.busy||addingNote;b.addEventListener('click',()=>{if(live(mine)&&model===owner&&!addingNote)fn();});li.append(b);};
      action('Open folder',()=>void model.refresh(s.dir,s.sub?s.sub+'/'+entry.name:entry.name));
      list.append(li);
    }
    const entries=s.entries.filter(e=>e.kind==='file');
    if(entries.length){
      const host=make('li','wb-room-files__cards');host.setAttribute('role','presentation');list.append(host);
      // Raw directory entries have NO engine identity. Their names are never
      // converted into references, seen versions or inferred author records.
      const items=entries.map(entry=>({id:entry.name,room_id:room,name:entry.name,kind:s.dir==='notes'?'note':'asset',type:s.dir==='notes'?'text/plain':'',size:entry.size,modified_at:entry.mtime,created_at:null,author:'',version:null,inEngine:false,ref:null}));
      const current=()=>live(mine)&&model===owner&&!owner.state().busy&&!addingNote;
      cards=createScratchCards({host,document,now:Date.now,prefs:viewPrefs,hideUnavailableCopy:true,current,
        load:async()=>({ok:true,items,cursor:null}),
        open:item=>{if(current())void(s.dir==='notes'?openNote(s.sub?s.sub+'/'+item.name:item.name):readFile(item.name,false));},
        actions:(item,row,{current:cardCurrent,actionsHost})=>{
          row.className+=' wb-room-files__row';
          const actions=make('div','wb-room-files__card-actions');actions.setAttribute('role','group');actions.setAttribute('aria-label','Actions for '+item.name);
          const action=(word,fn)=>{const b=make('button','wb-room-files__action',word);b.type='button';b.disabled=s.busy||addingNote;b.addEventListener('click',()=>{if(current()&&cardCurrent())fn();});actions.append(b);};
          if(s.dir==='notes')action('Edit note',()=>void openNote(s.sub?s.sub+'/'+item.name:item.name));
          action('Open',()=>void readFile(item.name,false));action('Download',()=>void readFile(item.name,true));action('Delete…',()=>void remove(item.name));actionsHost.append(actions);
        }});
      void cards.refresh();
    }
  }
  async function remove(name){const mine=epoch;const result=await model.remove(name,()=>confirm(`Delete ${name}? This can't be undone.`));if(live(mine)&&result.code==='unconfirmed'){needsListCheck=true;refresh.hidden=false;}if(live(mine)&&!result.ok&&!['cancelled','changed'].includes(result.code))status.textContent=result.code==='unconfirmed'?`Lost the connection while deleting ${name}. Check the list to see if it was deleted.`:`Couldn't delete ${name}. Try again.`;}
  async function upload(values){
    if(model?.state().dir==='notes')return;needsListCheck=false;
    const batch=Array.from(values||[]);if(!model||!batch.length||addingNote)return;
    if(batch.length>20){status.textContent='Add up to 20 files at a time.';return;}
    const mine=epoch;const result=await model.upload(batch);if(live(mine)&&result.code==='invalid')status.textContent='Choose files with valid names, then try again.';
  }
  bind(input,'change',()=>{void upload(input.files);input.value='';});
  bind(root,'dragover',event=>{if(shown&&room)event.preventDefault();});
  bind(root,'drop',event=>{if(!shown||!room)return;event.preventDefault();void upload(event.dataTransfer?.files);});
  bind(root,'paste',event=>{if(event.target===text||!shown||!room||!event.clipboardData?.files?.length)return;event.preventDefault();void upload(event.clipboardData.files);});
  async function changeTab(next){if(addingNote)return;const mine=epoch;if(!await closeNote()||!live(mine))return;tab=next;needsListCheck=false;await model.refresh(next,'');}
  function activate(){
    deactivate();if(!shown||!room||destroyed){context.textContent='Choose a room in Workrooms first.';add.disabled=true;list.replaceChildren();status.textContent='';for(const b of tabButtons.values())b.disabled=true;return;}
    context.textContent='Room · '+(roomName||room);const mine=epoch;client=files.room(room,{current:()=>live(mine)});
    model=createRoomFilesModel({makeClient:()=>client,current:()=>live(mine),onState:paint});void model.bind(room).then(()=>{if(live(mine)&&tab!=='assets')void model.refresh(tab);});
  }
  const off=files.subscribeRoom(value=>{if(!value?.roomId)return;roomName=value.roomName||value.roomId;if(room!==value.roomId){deactivate();room=value.roomId;tab='assets';if(shown)activate();}else if(shown){context.textContent='Room · '+roomName;}});
  const beforeUnload=event=>{if(editor?.state().dirty||parked.size){event.preventDefault();event.returnValue='';}};
  globalThis.addEventListener?.('beforeunload',beforeUnload);
  return Object.freeze({
    element:root,
    selectTab(value){if(!['notes','assets','files'].includes(value))return;if(shown&&model)void changeTab(value);else tab=value;},
    setShown(value){if(destroyed||shown===(value===true))return;shown=value===true;if(shown){const mine=++epoch;Promise.resolve().then(()=>{if(live(mine))activate();else if(shown&&!destroyed&&!room)activate();});}else deactivate();},
    canChangeLocation:()=>!editor?.state().dirty,canChangeFiles:()=>!editor?.state().dirty,
    changed(){if(shown&&model)void model.refresh();},accountChanged(){deactivate();room=null;activate();},
    destroy(){if(destroyed)return;deactivate();destroyed=true;off?.();globalThis.removeEventListener?.('beforeunload',beforeUnload);for(const remove of removers)remove();root.remove();},
  });
}
