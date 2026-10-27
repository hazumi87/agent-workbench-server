// Provisional browser view. The owner wires model onState to view.render(state)
// and includes folder-picker.css once through its external stylesheet bundle.
let nextPickerId=0;
export function createServerFolderPickerView({model,document=globalThis.document,mount=document?.body,onChoose=()=>{},onCancel=()=>{}}={}){
  if(!document||!mount||!model||!['state','open','close','up','navigate','confirm'].every(key=>typeof model[key]==='function'))throw TypeError('Folder picker model required');
  let destroyed=false,opened=false,priorFocus=null,entryButtons=[],generation=0,settled=false,prepared=false,lastDirectoryId=null,createWasOpen=false;
  const listeners=[],entryListeners=[];
  const make=(tag,className,text)=>{
    const node=document.createElement(tag);node.className=className;
    if(text!==undefined)node.textContent=text;
    return node;
  };
  const bind=(node,type,handler,list=listeners)=>{
    node.addEventListener(type,handler);list.push(()=>node.removeEventListener(type,handler));
  };
  const clear=list=>{for(const remove of list.splice(0))remove();};
  const element=make('div','wb-web-folder-picker');element.hidden=true;element.setAttribute('data-wb-test','picker');
  const dialog=make('section','wb-web-folder-picker__dialog');
  const heading=make('h2','wb-web-folder-picker__heading','Choose a folder on this server');
  const headingId=`wb-web-folder-picker-title-${++nextPickerId}`;
  heading.setAttribute('id',headingId);dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-labelledby',headingId);dialog.setAttribute('tabindex','-1');
  const path=make('input','wb-web-folder-picker__path');path.type='text';path.setAttribute('aria-label','Server folder');path.setAttribute('data-wb-test','path');path.setAttribute('autocomplete','off');path.setAttribute('spellcheck','false');
  const newFolder=make('button','wb-web-folder-picker__new','New folder');newFolder.type='button';newFolder.setAttribute('data-wb-test','new-folder');
  const address=make('div','wb-web-folder-picker__address');address.append(path,newFolder);
  const createRow=make('div','wb-web-folder-picker__create-row');createRow.hidden=true;
  const createName=make('input','wb-web-folder-picker__name');createName.type='text';createName.setAttribute('aria-label','Folder name');createName.setAttribute('data-wb-test','new-folder-name');createName.setAttribute('autocomplete','off');
  const createButton=make('button','wb-web-folder-picker__create','Create');createButton.type='button';
  const createCancel=make('button','wb-web-folder-picker__create-cancel','Cancel');createCancel.type='button';createCancel.setAttribute('data-wb-test','new-folder-cancel');
  createRow.append(createName,createButton,createCancel);
  const createStatus=make('p','wb-web-folder-picker__create-status');createStatus.setAttribute('role','status');createStatus.hidden=true;
  const createReload=make('button','wb-web-folder-picker__create-reload','Reload folders');createReload.type='button';createReload.hidden=true;
  const up=make('button','wb-web-folder-picker__up','Up');up.type='button';
  const hiddenLabel=make('label','wb-web-folder-picker__hidden-label');
  const hidden=make('input','wb-web-folder-picker__hidden');hidden.type='checkbox';hidden.checked=false;
  hiddenLabel.append(hidden,make('span','wb-web-folder-picker__hidden-text','Show hidden folders'));
  const tools=make('div','wb-web-folder-picker__tools');tools.append(up,hiddenLabel);
  const status=make('p','wb-web-folder-picker__status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const back=make('button','wb-web-folder-picker__back','Go back');back.type='button';back.hidden=true;
  const retry=make('button','wb-web-folder-picker__retry','Retry');retry.type='button';retry.hidden=true;
  const limit=make('p','wb-web-folder-picker__limit');limit.hidden=true;
  const list=make('ul','wb-web-folder-picker__list');list.setAttribute('aria-label','Folders');list.setAttribute('data-wb-test','list');
  const actions=make('div','wb-web-folder-picker__actions');
  const cancel=make('button','wb-web-folder-picker__cancel','Cancel');cancel.type='button';cancel.setAttribute('data-wb-test','cancel');
  const choose=make('button','wb-web-folder-picker__choose','Choose this folder');choose.type='button';choose.setAttribute('data-wb-test','choose');
  actions.append(cancel,choose);dialog.append(heading,address,tools,status,back,retry,limit,createRow,createStatus,createReload,list,actions);element.append(dialog);mount.append(element);
  const inside=node=>{while(node){if(node===dialog)return true;node=node.parentNode;}return false;};
  function restore(){
    const previous=priorFocus;priorFocus=null;
    if(previous?.isConnected!==false)previous?.focus?.();
  }
  function render(state=model.state()){
    if(destroyed)return;
    if(!state.open){
      element.hidden=true;
      if(opened){opened=false;restore();}
      return;
    }
    const opening=!opened,hadEntryFocus=entryButtons.includes(document.activeElement);
    if(opening){if(!prepared){++generation;settled=false;}prepared=false;priorFocus=document.activeElement;opened=true;}
    element.hidden=false;dialog.setAttribute('aria-busy',state.busy?'true':'false');
    const directoryId=state.directory?.id||'';
    if(opening||lastDirectoryId!==directoryId||document.activeElement!==path)path.value=directoryId;
    lastDirectoryId=directoryId;path.disabled=!!state.busy;hidden.disabled=!!state.busy;hidden.checked=state.hidden===true;
    up.hidden=!state.directory?.parentId;up.disabled=!!state.busy||up.hidden;
    const rowOpen=state.createOpen===true&&state.canCreate===true;
    newFolder.hidden=state.canCreate!==true;newFolder.disabled=!!state.busy||!state.directory||!!state.error||rowOpen;
    createRow.hidden=!rowOpen;
    for(const control of [createName,createButton,createCancel]){control.hidden=!rowOpen;control.disabled=!!state.busy||!rowOpen;}
    if(createName.value!==state.createName)createName.value=state.createName||'';
    createButton.disabled=createButton.disabled||!state.createName||state.createNeedsReload===true;
    const createWords={exists:`A folder named ${state.createName||''} already exists here.`,invalid:"That name can't be used for a folder.",'outside-root':"That place isn't available here.",'signed-out':"Can't create this folder. Sign in again.",unavailable:"Couldn't create the folder. Reload the folders before trying again."};
    createStatus.textContent=createWords[state.createError]||'';createStatus.hidden=!createStatus.textContent;
    createReload.hidden=state.createNeedsReload!==true;createReload.disabled=!!state.busy;
    choose.disabled=!!state.busy||!state.directory||!!state.error||rowOpen;
    const outside=state.error==='outside-root'&&typeof state.rootId==='string'&&state.rootId.length>0;
    status.textContent=state.busy?'Loading…':outside?`That place isn't available here. Go back to ${state.rootId}.`:state.error==='not-found'?'No folder with that path.':state.error?"Can't open this folder. Choose another.":state.entries.length?'':'No folders here.';
    back.hidden=!outside;back.disabled=!!state.busy;retry.hidden=!state.error||!!state.directory||outside;retry.disabled=!!state.busy;
    limit.hidden=state.limited!==true;limit.textContent=state.limited===true?'Showing the first 500 folders. Type a path above to go further.':'';
    clear(entryListeners);entryButtons=[];list.replaceChildren();
    for(const entry of state.entries){
      const item=make('li','wb-web-folder-picker__item');
      const button=make('button','wb-web-folder-picker__folder',entry.name);button.type='button';button.disabled=!!state.busy;
      bind(button,'click',()=>run(()=>model.navigate(entry.id)),entryListeners);
      entryButtons.push(button);item.append(button);list.append(item);
    }
    if(rowOpen&&!createWasOpen)createName.focus();
    else if(!rowOpen&&createWasOpen&&!newFolder.hidden)newFolder.focus();
    else if(opening||hadEntryFocus)cancel.focus();
    createWasOpen=rowOpen;
  }
  function cancelSession(code,mine=generation){
    if(destroyed||settled||mine!==generation)return;
    settled=true;prepared=false;
    try{model.close();}catch{/* detached owner */}
    render();try{onCancel({code});}catch{/* detached owner */}
  }
  function run(action,mine=generation){
    if(destroyed)return Promise.resolve();
    try{
      const answer=action();render();
      return Promise.resolve(answer).then(value=>{if(value?.code==='changed')cancelSession('changed',mine);render();return value;},()=>{render();});
    }catch{render();return Promise.resolve();}
  }
  const close=()=>cancelSession('cancelled');
  bind(newFolder,'click',()=>run(()=>model.beginCreate()));
  bind(createName,'input',()=>run(()=>model.setCreateName(createName.value)));
  bind(createName,'keydown',event=>{if(event.key==='Enter'&&!createButton.disabled){event.preventDefault();run(()=>model.createFolder());}});
  bind(createButton,'click',()=>run(()=>model.createFolder()));
  bind(createCancel,'click',()=>run(()=>model.cancelCreate()));
  bind(createReload,'click',()=>run(()=>model.goPath(model.state().directory.id)));
  bind(path,'keydown',event=>{if(event.key==='Enter'&&!path.disabled){event.preventDefault();run(()=>model.goPath(path.value));}});
  bind(hidden,'change',()=>run(()=>model.setHidden(hidden.checked)));
  bind(back,'click',()=>run(()=>model.home()));
  bind(retry,'click',()=>run(()=>model.home()));
  bind(up,'click',()=>run(()=>model.up()));
  bind(cancel,'click',close);
  bind(choose,'click',()=>run(()=>{
    const selected=model.confirm();render();if(selected){settled=true;onChoose(selected);}
  }));
  bind(document,'keydown',event=>{
    if(!opened||destroyed)return;
    if(event.key==='Escape'){event.preventDefault();close();return;}
    if(event.key!=='Tab')return;
    const controls=[path,newFolder,up,hidden,back,retry,createName,createButton,createCancel,createReload,...entryButtons,cancel,choose].filter(node=>!node.hidden&&!node.disabled);
    const first=controls[0],last=controls[controls.length-1],focused=document.activeElement;
    if(!inside(focused)||event.shiftKey&&focused===first||!event.shiftKey&&focused===last){
      event.preventDefault();(event.shiftKey?last:first).focus();
    }
  });
  bind(document,'focusin',()=>{
    if(opened&&!inside(document.activeElement))cancel.focus();
  });
  render();
  return Object.freeze({
    element,render,
    open(){++generation;settled=false;prepared=true;return run(()=>model.open());},
    destroy(){
      if(destroyed)return;
      destroyed=true;clear(listeners);clear(entryListeners);
      try{model.close();}catch{/* detached owner */}
      element.remove();opened=false;restore();
    },
  });
}
