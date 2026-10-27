import {createAgentModel} from './model.js';
import {createApprovalSegment} from '../web-shared/approval-segment.mjs';
export const DISCLOSURE=Object.freeze([
 "With this on, new agents start in their program's mode that skips permission questions. They can run commands and change files on this server without asking you.",
 'Any agent in a room can cause that, including from a message another agent sends. Turn it on only for work you would let them do unattended.',
 'You can turn it off at any time, and set it for each agent separately.',
]);
export const ROOM_RULE='Claude Code and Codex can join a room. Gemini opens as a terminal.',TERMINAL_ONLY="Opens as a terminal. It can't join a room.",ROOM_PROGRAMS=['claude-code','codex-cli'];
export function openAgentDialog(api,{document=globalThis.document,onAdded=()=>{},onClose=()=>{},forRoom=false}={}) {
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 const node=el('dialog');node.className='wb-agent-dialog';node.dataset.wbTest='add-agent';
 const title=el('h2','Add an agent');title.id='wb-agent-title';node.setAttribute('aria-labelledby',title.id);node.append(title);
 const field=(label,input)=>{const wrap=el('label');wrap.className='wb-agent-field';wrap.append(el('span',label),input);node.append(wrap);};
 const program=el('select');program.setAttribute('aria-label','Program');field('Program',program);
 const programNote=el('p');programNote.className='wb-agent-help';programNote.dataset.wbTest='agent-program-note';programNote.hidden=true;node.append(programNote);
 const name=el('input');name.maxLength=60;name.setAttribute('aria-label','Name');field('Name',name);
 const folderRow=el('div');folderRow.className='wb-agent-folder';const folder=el('input');folder.readOnly=true;folder.placeholder='Home folder';folder.setAttribute('aria-label','Folder on this server');
 const choose=el('button','Choose folder…');choose.type='button';folderRow.append(folder,choose);field('Folder on this server',folderRow);
 const group=el('fieldset'),legend=el('legend','Auto-approve'),choices=el('div');group.append(legend,choices);node.append(group);
 const hint=el('p'),authority=el('p',"Only you can change this. Agents can't. A change applies the next time the agent starts.");authority.className='wb-agent-help';node.append(hint,authority);
 const error=el('p');error.setAttribute('role','alert');node.append(error);
 const retry=el('button','Try again');retry.type='button';retry.hidden=true;node.append(retry);
 const check=el('button','Check the list');check.type='button';check.hidden=true;node.append(check);
 const list=el('p');list.setAttribute('role','status');node.append(list);
 const actions=el('div');actions.className='wb-agent-actions';const cancel=el('button','Cancel'),save=el('button','Add agent');cancel.type=save.type='button';actions.append(cancel,save);node.append(actions);
 let closed=false,disclosure=null,programKey='',segmentKey='',noticeVersion=0;const previousFocus=document.activeElement;
 const words={load:"Couldn't load the agent settings. Try again.",name:'Give the agent a name.',folder:'Folder not found on this server. Choose another folder.',disclosure:'Read the notice before you turn this on.',unconfirmed:'Lost the connection while adding this agent. It may have been added. Check the list before you add it again.'};
 const current=()=>{try{return !closed&&node.isConnected&&node.open&&!node.closest('[hidden]')&&(typeof api.current!=='function'||api.current()===true);}catch{return false;}};
 const model=createAgentModel(api,{onState:render});
 function finish(){if(closed)return;closed=true;disclosure?.close(false);model.dispose();node.remove();if(previousFocus?.isConnected)previousFocus.focus();onClose();}
 function confirmOn(){
  return new Promise(resolve=>{
   const prompt=el('dialog');prompt.className='wb-agent-dialog';const heading=el('h2','Let agents run without asking?');heading.id='wb-agent-disclosure';prompt.setAttribute('aria-labelledby',heading.id);prompt.append(heading,...DISCLOSURE.map(text=>el('p',text)));
   const controls=el('div');controls.className='wb-agent-actions';const no=el('button','Keep it off'),yes=el('button','Turn on');no.type=yes.type='button';controls.append(no,yes);prompt.append(controls);
   let done=false;const close=value=>{if(done)return;done=true;prompt.remove();disclosure=null;resolve(value);};disclosure={close};
   no.addEventListener('click',()=>close(false));yes.addEventListener('click',()=>close(true));prompt.addEventListener('cancel',event=>{event.preventDefault();close(false);});document.body.append(prompt);prompt.showModal();no.focus();
  });
 }
 async function changeChoice(value){
  if(!current())return;const before=model.state();if(!model.set('choice',value))return;
  if(value==='on'&&before.policy?.autoApproveDisclosedAt===null){const accepted=await confirmOn();if(!current())return;if(accepted)model.acknowledge(true);else model.set('choice',before.choice);}
 }
 function render(st){
  if(closed)return;
  const ready=st.phase==='ready';node.dataset.state=st.phase;
  // opened from a room's Add a seat: only Claude Code and Codex can join a room, so only they are offered, with the rule under them; from Settings every program stays and a terminal-only one says so
  const offered=forRoom?st.programs.filter(p=>ROOM_PROGRAMS.includes(p.id)):st.programs;
  if(forRoom&&ready&&!ROOM_PROGRAMS.includes(st.programId)&&offered.length)model.set('programId',offered[0].id);
  programNote.textContent=forRoom?ROOM_RULE:st.programId&&!ROOM_PROGRAMS.includes(st.programId)?TERMINAL_ONLY:'';programNote.hidden=!programNote.textContent;
  const key=JSON.stringify(offered);if(key!==programKey){programKey=key;program.replaceChildren(...offered.map(p=>{const option=el('option',p.label);option.value=p.id;return option;}));}
  if(document.activeElement!==name)name.value=st.name;program.value=st.programId;folder.value=st.folder;
  program.disabled=!ready;name.disabled=!ready;choose.disabled=!ready||st.picking;cancel.disabled=st.phase==='saving';cancel.textContent=st.phase==='unconfirmed'?'Close':'Cancel';retry.hidden=st.error!=='load';check.hidden=st.phase!=='unconfirmed';
  const selectionKey=st.choice+':'+!ready;
  if(segmentKey!==selectionKey){
   const focus=choices.contains(document.activeElement)?document.activeElement?.dataset?.wbTest:null;
   const segment=createApprovalSegment({document,value:st.choice,label:'Auto-approve',disabled:!ready,onChange:changeChoice,current,testPrefix:'web-agent-approval'});
   choices.replaceChildren(segment);segmentKey=selectionKey;
   if(focus){const button=[...segment.children].find(n=>n.dataset.wbTest===focus);button?.focus();}
  }
  save.disabled=!ready||st.picking||!st.name.trim()||(st.choice==='on'&&st.policy?.autoApproveDisclosedAt===null&&!st.acknowledged);
  hint.textContent=!st.policy?'Checking the default…':st.choice==='follow'?(st.policy.default==='on'?'The default is On, so this agent will run without asking. Choose Off to make it ask.':'The default is Off, so this agent will ask before it acts.'):st.choice==='on'?'This agent will run without asking.':'This agent will ask before it acts.';
  error.textContent=st.error==='server-answer'?st.answer.text:st.error?words[st.error]:'';error.hidden=!st.error;
  if(st.error==='server-answer'&&st.answer.action==='show-disclosure'&&noticeVersion!==st.answerVersion&&!disclosure&&current()){
   noticeVersion=st.answerVersion;
   void confirmOn().then(accepted=>{if(current()&&accepted)model.acknowledge(true);});
  }
  if(st.phase==='saved'){onAdded({id:st.savedId});finish();}
 }
 retry.addEventListener('click',()=>model.load());
 check.addEventListener('click',async()=>{check.disabled=true;try{const rows=await api.list();if(!closed)list.textContent=Array.isArray(rows)?'Recipes: '+rows.slice(0,200).map(r=>String(r.name||'').slice(0,60)).join(', '):"Couldn't read the recipe list. Try again.";}catch{if(!closed)list.textContent="Couldn't read the recipe list. Try again.";}finally{if(!closed)check.disabled=false;}});
 name.addEventListener('input',()=>model.set('name',name.value));program.addEventListener('change',()=>model.set('programId',program.value));choose.addEventListener('click',()=>model.pickFolder());save.addEventListener('click',()=>model.save());cancel.addEventListener('click',finish);
 node.addEventListener('cancel',event=>{event.preventDefault();if(model.state().phase!=='saving')finish();});
 document.body.append(node);node.showModal();void model.load();
 return Object.freeze({dispose:finish,model,focus:()=>name.focus()});
}
