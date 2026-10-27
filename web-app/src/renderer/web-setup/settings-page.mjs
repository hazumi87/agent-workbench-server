import {createSetupSettings} from './controller.mjs';
import {DISCLOSURE} from './onboarding-page.mjs';
import {createApprovalSegment} from '../web-shared/approval-segment.mjs';
import {serverFolder} from './policy.mjs';
export const mountAgentSettings = options => mount({...options,section:'agents'});
export const mountFolderSettings = options => mount({...options,section:'folders'});
function mount({host,api,section}) {
 const doc=host.ownerDocument;let alive=true,shown=false,epoch=0,paintVersion=0,dialog=null,pending=null,picker=null,pickerError=null;
 const el=(tag,text,key)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;if(key)n.dataset.wbTest=key;return n;};
 function closeDialog(){if(dialog){if(dialog.open)dialog.close();dialog.remove();dialog=null;}}
 function draw(state){
  if(!alive)return;const focused=doc.activeElement?.dataset?.wbTest;closeDialog();const version=++paintVersion,current=()=>alive&&shown&&version===paintVersion;
  host.replaceChildren();host.classList.add('web-settings');host.dataset.wbTest=`web-settings-${section}`;host.dataset.state=state.status;host.hidden=!shown||state.status==='idle';if(host.hidden)return;
  const busy=['loading','saving'].includes(state.status)||!!picker,disabled=busy||state.status!=='ready';
  const button=(text,key,action,blocked=false)=>{const b=el('button',text,key);b.type='button';b.disabled=blocked;b.addEventListener('click',()=>{if(current()&&!b.disabled)void action();});return b;};
  const ask=(kind,id)=>{pending={kind,id};draw(controller.state());};
  const choose=(id,value)=>{
   if(value==='on'&&state.approval.autoApproveDisclosedAt===null){ask(id===null?'default':'recipe',id);return;}
   return id===null?controller.setDefault(value):controller.setRecipe(id,value);
  };
  host.append(el('h2',section==='agents'?'Agents':'Folders'));
  if(section==='agents'){
   host.append(el('p','Auto-approve lets an agent run commands and change files on this server without asking you first.'));
   // the way to make a new agent at every width (a phone has no seats column or recipes rail): the same Add an agent dialog
   const agents=doc.defaultView?.wb?.web?.agents;if(typeof agents?.open==='function'){const add=button('Add an agent','web-agents-add',()=>agents.open());add.className='web-settings-trust-add';host.append(add);}
   if(state.approval){
    const row=el('div');row.className='web-settings-row';const label=el('div','Default for new agents');label.append(el('small','Each agent can follow it or override it below.'));const toggle=button('','web-default-toggle',()=>choose(null,state.approval.default==='on'?'off':'on'),disabled);toggle.className='web-settings-switch';toggle.setAttribute('role','switch');toggle.setAttribute('aria-label','Default for new agents');toggle.setAttribute('aria-checked',String(state.approval.default==='on'));const switchRow=el('div');switchRow.className='web-settings-switch-row';switchRow.append(toggle,el('span',state.approval.default==='on'?'On':'Off','web-default-state'));row.append(label,switchRow);host.append(row,el('h3',"Each agent's setting"));
    for(const recipe of state.approval.recipes){
     const row=el('div');row.className='web-settings-row';row.dataset.recipeId=recipe.id;
     const label=el('div',recipe.name || 'Recipe unavailable');label.className='web-settings-label';label.append(el('small','Recipe'));const controls=el('div');controls.className='web-settings-recipe-controls';
     const group=createApprovalSegment({document:doc,value:recipe.setting,label:`Auto-approve for ${recipe.name || 'unavailable recipe'}`,disabled:disabled||!recipe.name,onChange:value=>choose(recipe.id,value),current});
     controls.append(group,el('p',`Effective: ${recipe.effective==='on'?'On':'Off'}${recipe.setting==='follow'?', follows the default':''}`,'web-recipe-effective'));row.append(label,controls);host.append(row);
    }
    if(!state.approval.recipes.length)host.append(el('p','No recipes yet.'));
   }
   host.append(el('p',"Only you can change this. Agents can't. A change applies the next time the agent starts."));
  }else{
   host.append(el('p','Claude Code asks "Do you trust this folder?" the first time it opens one. A folder listed here skips that question. Nothing is trusted until you add it.'));
   if(state.folders){
    if(!state.folders.length)host.append(el('p','No folders trusted. Claude Code will ask the first time it opens one.','web-trust-empty'));
    for(const folder of state.folders){const row=el('div');row.className='web-settings-row';const label=el('div',folder.path);label.className='web-settings-label';label.append(el('small','Trusted'));row.append(label,button('Remove','web-trust-remove',()=>ask('remove',folder.path),disabled));host.append(row);}
    const add=button('Trust a folder…','web-trust-add',pick,disabled||typeof api.pickFolder!=='function');add.className='web-settings-trust-add';host.append(add);
   }
  }
  if(busy){const message=el('p',picker?'Choosing a folder…':state.status==='loading'?'Checking…':'Saving…');message.setAttribute('role','status');host.append(message);}
  if(state.error||pickerError){const message=state.error==='save-unconfirmed'?"Couldn't confirm the change. Check the saved settings before trying again.":state.error==='save-refused'?'The server refused that change. Your choice was not saved.':pickerError?"Couldn't choose a folder. Try again.":"Couldn't load these settings. Try again.";const notice=el('p',message,'web-settings-result');notice.setAttribute('role','alert');host.append(notice);if(state.error!=='save-refused')host.append(button(state.error==='save-unconfirmed'?'Check again':'Try again','web-settings-refresh',()=>{pending=null;pickerError=null;return controller.show();},busy));}
  if(pending&&!disabled){
   const action=pending;dialog=el('dialog',undefined,'web-settings-dialog');dialog.className='web-settings-dialog';const title=el('h2',action.kind==='remove'?'Stop trusting this folder?':'Let agents run without asking?');title.id=`web-settings-${section}-dialog-title`;dialog.setAttribute('aria-labelledby',title.id);dialog.append(title);
   const paragraphs=action.kind==='remove'?[`Stop trusting ${action.id}? Claude Code will ask again next time.`]:DISCLOSURE;dialog.append(...paragraphs.map(text=>el('p',text)));
   const actions=el('div');actions.className='web-settings-actions';const cancel=button(action.kind==='remove'?'Cancel':'Keep it off','web-settings-cancel',()=>{pending=null;draw(controller.state());});const confirm=button(action.kind==='remove'?'Remove':'Turn on','web-settings-confirm',()=>{pending=null;return action.kind==='remove'?controller.setTrust(action.id,false,true):action.kind==='default'?controller.setDefault('on',true):controller.setRecipe(action.id,'on',true);});confirm.className='web-settings-primary';actions.append(cancel,confirm);dialog.append(actions);host.append(dialog);dialog.addEventListener('cancel',event=>{event.preventDefault();if(current()){pending=null;draw(controller.state());}});dialog.showModal();cancel.focus();
  }else if(focused){const nodes=host.querySelectorAll?.('[data-wb-test]')||[];Array.from(nodes).find(n=>n.dataset.wbTest===focused&&!n.disabled)?.focus();}
 }
 async function pick(){
  if(picker||!shown||!alive||controller.state().status!=='ready')return;
  const operation={epoch,abort:new AbortController()};picker=operation;pickerError=null;draw(controller.state());
  const current=()=>alive&&shown&&epoch===operation.epoch&&picker===operation;
  try{const choice=await api.pickFolder({signal:operation.abort.signal,current});if(!current()||choice===null)return;if(!serverFolder(choice?.path))throw Error('invalid-folder');await controller.setTrust(choice.path,true,true);}catch{if(current())pickerError=true;}finally{if(picker===operation){picker=null;if(alive&&shown&&epoch===operation.epoch)draw(controller.state());}}
 }
 const controller=createSetupSettings({api,section,onChange:draw});
 function invalidate(method){epoch++;shown=false;pending=null;pickerError=null;picker?.abort.abort();controller[method]();}
 draw(controller.state());
 return Object.freeze({state:controller.state,show(){if(!alive)return Promise.resolve({ok:false,error:'inactive'});epoch++;shown=true;pending=null;return controller.show();},hide:()=>invalidate('hide'),reset:()=>invalidate('reset'),destroy(){invalidate('destroy');alive=false;paintVersion++;closeDialog();host.replaceChildren();host.hidden=true;}});
}
