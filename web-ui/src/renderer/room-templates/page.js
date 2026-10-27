import {pickerChoices,saveSummary,templateFailure,createdSummary} from './model.js';
// Isolated presentation surface; controller.js binds the fixed-verb facade.
// No HTTP, persistence, template serialization or launch here.
export function createRoomTemplates({host,onAction=()=>{}}){
 const doc=host.ownerDocument;let alive=true,shown=false,version=0,pending=false,v={},items=[],name='',selected='blank',pickerDraftKey=null,teams=[],teamDraftKey=null,error='',conflictName=null,folderDeferred=false,noticeDismissed=false,createdKey=null;
 const node=(tag,cls,text)=>{const n=doc.createElement(tag);n.className=cls||'';if(text!=null)n.textContent=text;return n;};
 const validId=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(x);
 const target=()=>items.find(t=>t.id===v.targetId&&t.kind==='user');
 const held=()=>!!v.failure&&!['name_used','unsupported_format','missing_recipe'].includes(v.failure.code)&&!(v.failure.code==='refused'&&v.failure.unchanged===true);
 const enabled=()=>alive&&shown&&v.enabled===true&&typeof v.scope==='string'&&!!v.scope&&!pending&&!v.busy&&!held();
 function emit(action,payload,recovery=false){
  if(recovery?(!alive||!shown||pending||v.busy||v.recoveryAllowed!==true):!enabled())return;pending=true;paint();
  // Host owns completion/reconciliation. An exception is NOT proof that a
  // mutation failed. Hold admission until it supplies a fresh view.
  try{Promise.resolve(onAction(action,payload)).catch(()=>{});}catch{}
 }
 function paint(){
  if(!alive||!shown)return;
  const focus=host.contains(doc.activeElement)?doc.activeElement:null,focusId=focus?.id,start=focus?.selectionStart,end=focus?.selectionEnd,stamp=++version;
  const current=()=>alive&&shown&&stamp===version;let buttonCount=0;
  const root=node('section','rt-page');root.setAttribute('aria-label','Room templates');
  const button=(label,fn,blocked=false)=>{const n=node('button','rt-button',label);n.type='button';n.id='rt-action-'+label.toLowerCase().replace(/[^a-z0-9]+/g,'-')+'-'+buttonCount++;n.disabled=blocked||!enabled();n.addEventListener('click',()=>{if(current()&&!n.disabled)fn();});return n;};
  const row=(...ns)=>{const r=node('div','rt-actions');r.append(...ns);return r;};
  const input=(label)=>{const wrap=node('div','rt-field'),lab=node('label','',label),n=node('input');n.id='rt-name';n.type='text';n.maxLength=80;n.value=name;n.disabled=!enabled();lab.htmlFor=n.id;
   n.addEventListener('input',()=>{if(current()&&enabled()){name=n.value.slice(0,80);error='';paint();}});wrap.append(lab,n);return wrap;};
  const title=t=>root.append(node('h3','',t));
  const cancel=()=>emit('cancel',{});
  function checkName(){if(!name.trim()){error='Give the template a name.';paint();return false;}if(conflictName!==null&&name.trim()===conflictName){error=`You already have a template called ${conflictName}. Choose another name.`;paint();return false;}return true;}
  const meta=t=>t.teams?`${t.seats} seats · ${t.teams} teams`:`${t.seats} seats`;
  if(v.screen==='picker'){
   title('Create a room');root.append(input('Room name'));const choices=node('fieldset','rt-choices');choices.append(node('legend','','Start from'));
   for(const item of items){const label=node('label','rt-option'),radio=node('input'),words=node('span');radio.type='radio';radio.name='rt-template';radio.id='rt-pick-'+item.id;radio.checked=selected===item.id;radio.disabled=!enabled();
    radio.addEventListener('change',()=>{if(current()&&enabled()){selected=item.id;name=item.kind==='blank'?'':item.name;error='';paint();}});
    words.append(node('strong','',item.name),node('span','rt-help',item.kind==='blank'?item.brief:meta(item)));label.append(radio,words);choices.append(label);
   }
   root.append(choices,row(button('Cancel',cancel),button('Create room',()=>{if(!name.trim())return;emit('create',{templateId:selected,name:name.trim()});},!name.trim()||!items.some(item=>item.id===selected))));
  }else if(v.screen==='save'||v.screen==='rename'){
   const saving=v.screen==='save',t=target(),source=v.room;
   if(!saving&&!t){host.replaceChildren(root);return;}
   title(saving?'Save as template':'Rename');root.append(input('Template name'));
   let summary={ok:true};
   if(saving){
    summary=saveSummary(source,teams);const group=node('fieldset','rt-teams');group.append(node('legend','','Teams to include'));
    if(Array.isArray(source?.teams))for(const team of source.teams.slice(0,500)){
     if(!validId(team?.id))continue;
     const lab=node('label','rt-option'),box=node('input');box.type='checkbox';box.id='rt-team-'+team.id;box.checked=teams.includes(team.id);box.disabled=!enabled();
     box.addEventListener('change',()=>{if(current()&&enabled()){teams=box.checked?[...new Set([...teams,team.id])]:teams.filter(id=>id!==team.id);paint();}});
     lab.append(box,node('span','',typeof team.name==='string'?team.name.slice(0,120):team.id),node('span','rt-help',`${Number.isSafeInteger(team.seats)?team.seats:0} seats`));group.append(lab);
    }root.append(group);
    if(summary.error)root.append(node('p','rt-error',summary.error));
    const kept=node('div','rt-kept');for(const [label,entries] of [['Kept',['The brief','Teams and seats',"Each seat’s role and recipe",'Tools and permission level','Folder choice']],['Not kept',['Messages','Notes and files','Tasks','Paths on this PC','Passwords']]]){const col=node('div'),list=node('ul');col.append(node('strong','',label));for(const entry of entries)list.append(node('li','',entry));col.append(list);kept.append(col);}root.append(kept);
   }
   root.append(row(button('Cancel',cancel),button(saving?'Save template':'Rename',()=>{
    if(!checkName())return;
    if(saving)emit('save',{roomId:source.id,name:name.trim(),teamIds:[...teams]});else emit('rename',{templateId:t.id,name:name.trim()});
   },saving&&(!summary.ok||source?.canSave!==true||!validId(source?.id)))));
  }else if(v.screen==='delete'){
   const t=target();if(t){title('Delete this template?');root.append(node('p','',`“${t.name}” will be deleted. Rooms you made from it stay as they are.`),row(button('Cancel',cancel),button('Delete',()=>emit('remove',{templateId:t.id}))));}
  }else if(v.screen==='created'){
   const created=v.created,summary=createdSummary(created);
   // The host must supply a complete known projection; never discard a setting
   // we don't understand or guess names from arbitrary engine facts.
   if(summary&&validId(created?.roomId)){
    if(summary.lines.length&&!noticeDismissed){const notice=node('aside','rt-created');notice.setAttribute('role','status');notice.append(node('h4','',summary.title));for(const line of summary.lines)notice.append(node('p','',line));notice.append(button('Dismiss',()=>{noticeDismissed=true;paint();}));root.append(notice);}
    if(summary.folder!=='none'){
     const card=node('section','rt-card');card.append(node('h4','',folderDeferred?'No folder yet':'Where should this room work?'));
     if(!folderDeferred)card.append(node('p','',(globalThis.wb&&globalThis.wb.web?'The template uses a folder. Pick one on this server.':'The template uses a folder. Pick one on this computer.')));
     card.append(row(button('Choose folder…',()=>emit('chooseFolder',{roomId:created.roomId})),...(!folderDeferred?[button('Create new folder…',()=>emit('createFolder',{roomId:created.roomId})),button('Not now',()=>{folderDeferred=true;paint();})]:[])));root.append(card);
    }
   }
  }else if(v.screen==='list'){
   const users=items.filter(t=>t.kind==='user');if(users.length){title('Your templates');const grid=node('div','rt-grid');for(const t of users){const card=node('article','rt-card');card.append(node('h4','',t.name),node('p','',t.brief),node('p','rt-help',meta(t)),button('Create room',()=>emit('pick',{templateId:t.id})));
    const more=node('details'),summary=node('summary','rt-button','More');summary.setAttribute('aria-label','More options for '+t.name);more.append(summary,row(button('Rename',()=>emit('showRename',{templateId:t.id})),button('Delete',()=>emit('showDelete',{templateId:t.id}))));card.append(more);grid.append(card);}root.append(grid);}
  }
  const refusal=templateFailure(v.failure);if(error||refusal){const n=node('p','rt-error',error||refusal);n.setAttribute('role','alert');root.append(n);}
  if(v.recoveryAllowed===true){const recovery=(label,verb)=>{const b=node('button','rt-button',label);b.type='button';b.disabled=!!v.busy||(verb==='discard'&&v.canDiscard!==true);b.addEventListener('click',()=>{if(current()&&!b.disabled)emit(verb,{},true);});return b;};root.append(row(recovery('Close','cancel'),...(v.failure?.code==='held'?[recovery('Discard','discard')]:[])));}
  if(v.savedName&&typeof v.savedName==='string'){const notice=node('div','rt-notice');notice.setAttribute('role','status');notice.append(node('span','',`Saved as template “${v.savedName.slice(0,120)}”`),button('View',()=>emit('view',{})));root.append(notice);}
  host.replaceChildren(root);host.hidden=v.screen==='list'&&root.children.length===0;
  if(focusId){const replacement=host.querySelector('#'+focusId);if(replacement&&!replacement.disabled){replacement.focus();if(Number.isInteger(start))replacement.setSelectionRange(start,Number.isInteger(end)?end:start);}}
 }
 return Object.freeze({show(view){if(!alive)return;++version;v=structuredClone(view);const nextKey=v.screen==='created'?JSON.stringify([v.scope,v.created?.roomId,v.created?.notApplied,v.created?.toolNames,v.created?.folder]):null;if(nextKey!==createdKey){folderDeferred=false;noticeDismissed=false;createdKey=nextKey;}items=pickerChoices(v.items);pending=false;shown=true;host.hidden=false;
  const nextPickerKey=v.screen==='picker'?JSON.stringify([v.scope,v.formVersion??null]):null;
  if(nextPickerKey!==null&&nextPickerKey===pickerDraftKey){
   // Removal invalidates the choice; it never silently changes it to Blank room.
   if(!items.some(item=>item.id===selected))selected=null;
  }else{
   selected=items.some(t=>t.id===v.selectedId)?v.selectedId:v.selectedId?null:'blank';
   name=(typeof v.name==='string'?v.name: v.screen==='save'?v.room?.name:v.screen==='rename'?target()?.name:items.find(t=>t.id===selected&&t.kind!=='blank')?.name)||'';name=name.slice(0,120);
  }
  // A requested choice can precede its initial summaries. Initialize when loaded.
  pickerDraftKey=v.busy&&selected===null&&items.length===1?null:nextPickerKey;
  const available=Array.isArray(v.room?.teams)?v.room.teams.filter(t=>validId(t?.id)).map(t=>t.id):[];
  const nextDraftKey=v.screen==='save'&&validId(v.room?.id)?JSON.stringify([v.scope,v.room.id,v.formVersion??null]):null;
  // Controller repaints describe the same form during saves and refusals.
  // Keep its explicit subset; newly appearing teams require a new selection.
  teams=nextDraftKey!==null&&nextDraftKey===teamDraftKey?teams.filter(id=>available.includes(id)):available;
  teamDraftKey=nextDraftKey;conflictName=v.failure?.code==='name_used'?name.trim():null;error=conflictName?`You already have a template called ${conflictName}. Choose another name.`:'';paint();},
  hide(){shown=false;pickerDraftKey=null;teamDraftKey=null;teams=[];++version;host.hidden=true;},destroy(){shown=false;alive=false;pickerDraftKey=null;teamDraftKey=null;teams=[];++version;host.replaceChildren();}});
}
