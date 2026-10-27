import {createPluginAPI,MAX_ZIP_BYTES} from './api.mjs';
import {createPluginInstaller} from './controller.mjs';
import {permissionWords,RESIDUAL,OFF,MICROPHONE,validId} from './model.mjs';

const reasons={
  'not-a-zip':"This file isn't a zip, or it's damaged.",
  corrupt:"This file isn't a zip, or it's damaged.",
  'too-big':'The limit is 20 MB zipped and 50 MB unpacked.',
  'too-many-files':'This zip has more than 500 files.',
  unsigned:"The server refused this tool. It hasn't been approved.",
  planted:'Added to the tools folder on this server by hand. Not allowed yet.',
  program:"This zip contains a program, which tools can't include.",
  'bad-manifest':"Its module.json isn't valid.",
  changed:'This tool changed. Upload it again to review the new version.',
  expired:'This check expired. Upload the zip again.',
};

/** App-owned UI only. No plugin HTML, script, image or URL is ever loaded by the installer. */
export function mountPluginInstaller({host,fetch,api=createPluginAPI(fetch),refreshCatalog=null}){
  const doc=host.ownerDocument;let alive=true,generation=0,renderGeneration=0,dialog=null,autoRefreshed=false,refreshAbort=new AbortController();
  const el=(tag,text,key)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(key)node.dataset.wbTest=key;return node;};
  const closeDialog=()=>{if(dialog){if(dialog.open)dialog.close();dialog.remove();dialog=null;}};
  const button=(text,key,fn,valid)=>{const b=el('button',text,key);b.type='button';b.addEventListener('click',()=>{if(alive&&valid())void fn();});return b;};
  function paint(state){
    if(!alive)return;closeDialog();const turn=++renderGeneration,valid=()=>turn===renderGeneration;
    host.classList.add('web-plugins');host.dataset.wbTest='web-plugins';host.dataset.state=state.phase;host.replaceChildren();
    const status=el('p','', 'web-plugin-status');status.setAttribute('role','status');
    const input=el('input',undefined,'web-plugin-file');input.type='file';input.accept='.zip,application/zip';input.hidden=true;
    const pick=button('Install tool…','web-plugin-add',()=>input.click(),valid);
    const busy=['uploading','installing','removing'].includes(state.phase);
    pick.disabled=busy||state.phase==='off'||state.phase==='unconfirmed';pick.hidden=state.phase==='unconfirmed';
    input.addEventListener('change',()=>{if(valid()&&input.files?.length===1)void controller.upload(input.files[0]);});
    const drop=el('div','Drop one tool zip here.','web-plugin-drop');drop.className='web-plugin-drop';
    drop.hidden=true;dropNode=drop;statusNode=status;
    const toolbar=el('div');toolbar.className='web-plugin-toolbar';toolbar.append(pick);
    host.append(toolbar,input,drop,status);
    if(state.phase==='off'){status.textContent=OFF;drop.hidden=true;}
    else if(state.phase==='uploading'){status.textContent=`Uploading and checking ${state.file}…`;const progress=el('progress');progress.setAttribute('aria-label','Uploading and checking tool');host.append(progress);}
    else if(state.phase==='installing')status.textContent='Installing…';
    else if(state.phase==='removing')status.textContent='Removing…';
    else if(state.phase==='submitted')status.textContent=state.operation==='remove'?`${state.pluginName} was removed. Its own data stays.`:`${state.pluginName} is installed and on.`;
    else if(state.phase==='unconfirmed'){status.textContent=state.operation==='remove'?`Lost the connection. ${state.file||'This tool'} may already be deleted. Check the list.`:`Lost the connection while sending ${state.file||'this zip'}. It may or may not have been installed. Check the list, then add it again if it isn't there.`;drop.hidden=true;}
    else if(state.phase==='refused'){status.textContent=`Can't install ${state.file||'this zip'}. ${reasons[state.error]||'The server refused this request.'}`;status.setAttribute('role','alert');}
    else if(state.phase==='held')status.textContent='';
    // while the consent dialog is up it is the only place to answer: nothing stays behind it (the design's re-walk, B)
    else if(state.review)status.textContent='';
    else status.textContent=`Tools can be up to ${MAX_ZIP_BYTES/1024/1024} MB zipped. Only allow tools you trust.`;
    if(busy)host.append(button('Cancel','web-plugin-cancel',()=>controller.cancel(),valid));
    if(state.phase==='submitted')host.append(button('Done','web-plugin-done',()=>controller.reset(),valid));
    if(state.phase==='unconfirmed')host.append(button('Check the list','web-plugin-refresh',async()=>{
      const owner=generation;let ok=false;try{ok=await refreshCatalog?.({signal:refreshAbort.signal})===true;}catch{}
      if(alive&&owner===generation&&valid()&&ok)controller.reset();
    },valid));
    if(!['submitted','unconfirmed'].includes(state.phase))autoRefreshed=false;
    else if(!autoRefreshed&&refreshCatalog){autoRefreshed=true;void Promise.resolve().then(()=>{if(alive&&valid())return refreshCatalog({signal:refreshAbort.signal});}).catch(()=>{});}
    if(state.review){
      const review=state.review;
      const details=el('details',undefined,'web-plugin-files');details.append(el('summary',`${review.files.length} files`));
      const list=el('ul');for(const file of review.files)list.append(el('li',`${file.path} · ${file.bytes} bytes · SHA-256 ${file.sha256}`));details.append(list);
      const box=el('dialog',undefined,'web-plugin-consent');dialog=box;
      const heading=el('h3',`Allow ${review.plugin.name}?`);heading.id='web-plugin-consent-title';box.setAttribute('aria-labelledby',heading.id);
      box.append(heading,el('p',`${review.plugin.id} · Version ${review.plugin.version}`));
      if(review.replaces){
        box.append(el('p',`Replaces version ${review.replaces.version}.`));
        if(review.permissions.some(permission=>!review.replaces.permissions.includes(permission)))box.append(el('strong','This version asks for more than the one you have.'));
      }
      box.append(el('p',review.permissions.length?'This tool asks to:':`${review.plugin.name} doesn't ask for anything that needs your OK.`));
      const permissions=el('ul',undefined,'web-plugin-permissions');
      for(const permission of review.permissions)permissions.append(el('li',permissionWords(permission)));box.append(permissions);
      for(const warning of review.warnings)box.append(el('p',warning));box.append(details,el('p',RESIDUAL));
      if(state.phase==='held')box.append(el('p',MICROPHONE));
      const actions=el('div');actions.className='web-plugin-actions';
      const cancel=button('Cancel','web-plugin-consent-cancel',()=>controller.cancel(),valid);actions.append(cancel);
      if(state.phase==='review')actions.append(button('Allow','web-plugin-allow',()=>controller.allow(review.checkId),valid));
      box.append(actions);host.append(box);box.addEventListener('cancel',event=>{event.preventDefault();if(valid())controller.cancel();});box.showModal();cancel.focus();
    }
  }
  let dropNode,statusNode,dragDepth=0;
  const fileDrag=event=>Array.from(event.dataTransfer?.types||[]).includes('Files')||event.dataTransfer?.files?.length>0;
  const canDrop=()=>alive&&!['uploading','installing','removing','off','unconfirmed'].includes(controller.state().phase)&&!dialog;
  const dragEnter=event=>{if(fileDrag(event)&&canDrop()){event.preventDefault();dragDepth++;dropNode.hidden=false;}};
  const dragOver=event=>{if(fileDrag(event)&&canDrop()){event.preventDefault();dropNode.hidden=false;}};
  const dragLeave=()=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth&&dropNode)dropNode.hidden=true;};
  const dropped=event=>{event.preventDefault();dragDepth=0;dropNode.hidden=true;if(!canDrop())return;
    const files=event.dataTransfer?.files;if(!files?.length)return;
    if(files.length!==1){statusNode.textContent='Drop one zip at a time.';return;}
    void controller.upload(files[0]);
  };
  const controller=createPluginInstaller({api,onChange:paint});paint(controller.state());
  for(const [name,fn] of [['dragenter',dragEnter],['dragover',dragOver],['dragleave',dragLeave],['drop',dropped]])host.addEventListener(name,fn);
  return Object.freeze({
    state:controller.state,
    // Catalog integration calls this for a plugin row. No browser-only "Undo": no such engine contract exists.
    requestRemove(id,name=id){
      if(!alive||!validId(id)||['uploading','installing','removing','off','unconfirmed'].includes(controller.state().phase))return;
      controller.cancel();closeDialog();const turn=renderGeneration,owner=generation,valid=()=>owner===generation&&turn===renderGeneration;
      const box=el('dialog',undefined,'web-plugin-remove-confirm');dialog=box;const heading=el('h3',`Remove ${name}?`);heading.id='web-plugin-remove-title';box.setAttribute('aria-labelledby',heading.id);box.append(heading,el('p',"This clears the tool's files, your OK for it and its settings. Its own data stays, so installing it again gets it back."));
      const cancel=button('Cancel','web-plugin-remove-cancel',()=>{closeDialog();controller.cancel();},valid);const remove=button('Remove','web-plugin-remove',()=>{closeDialog();return controller.remove(id,true,name);},valid);
      const actions=el('div');actions.className='web-plugin-actions';actions.append(cancel,remove);box.append(actions);host.append(box);box.addEventListener('cancel',event=>{event.preventDefault();if(valid())controller.cancel();});box.showModal();cancel.focus();
    },
    reset(){generation++;refreshAbort.abort();refreshAbort=new AbortController();closeDialog();controller.reset();},
    destroy(){for(const [name,fn] of [['dragenter',dragEnter],['dragover',dragOver],['dragleave',dragLeave],['drop',dropped]])host.removeEventListener(name,fn);generation++;refreshAbort.abort();alive=false;closeDialog();controller.destroy();host.replaceChildren();},
  });
}
