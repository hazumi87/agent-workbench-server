import {createOnboarding} from './onboarding.mjs';
export const DISCLOSURE=[
 'With this on, new agents start in their program\'s mode that skips permission questions. They can run commands and change files on this server without asking you.',
 'Any agent in a room can cause that, including from a message another agent sends. Turn it on only for work you would let them do unattended.',
 'You can turn it off at any time, and set it for each agent separately.',
];
const agentWords={true:'Installed',false:'Not installed',null:"Can't check"};
export function mountOnboarding({host,api,onComplete=()=>{}}){
 const doc=host.ownerDocument;let alive=true,version=0,dialog=null,completed=false;
 const el=(tag,text,key)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;if(key)n.dataset.wbTest=key;return n;};
 const close=()=>{if(dialog){if(dialog.open)dialog.close();dialog.remove();dialog=null;}};
 function paint(state){
  if(!alive)return;close();const mine=++version,current=()=>alive&&mine===version;
  host.replaceChildren();host.classList.add('web-oobe');host.dataset.wbTest='web-setup';host.dataset.step=['','welcome','approval','agents','folder'][state.step];host.dataset.state=state.status;host.hidden=state.status==='idle'||state.status==='done';
  if(state.status==='done'){if(!completed){completed=true;queueMicrotask(()=>{if(current())onComplete();});}return;}
  if(state.status==='idle')return;
  const busy=['loading','saving','picking'].includes(state.status),unconfirmed=state.error==='unconfirmed';
  const button=(text,key,fn,disabled=false)=>{const b=el('button',text,key);b.type='button';b.disabled=busy||disabled;b.addEventListener('click',()=>{if(current()&&!b.disabled)void fn();});return b;};
  const column=el('div');column.className='web-oobe-column';host.append(column);
  column.append(el('p',`Step ${state.step} of 4`,'web-setup-step'));
  if(!state.person){column.append(el('h1','Welcome to Agent Workbench'),el('p',state.error?"Couldn't load setup. Try again.":'Checking setup…'));if(state.error)column.append(button('Try again','web-setup-refresh',()=>controller.show()));return;}
  if(state.step===1){column.append(el('h1','Welcome to Agent Workbench'));if(state.person.name!==null)column.append(el('p',`Signed in as ${state.person.name}.`,'web-setup-person'));column.append(el('p','Run several coding agents in shared rooms, and talk to them with @names.'),el('p',"Your notes, assets and files are kept on this server, in each room's own folder. Agents in a room can read that room's folder."));}
  if(state.step===2){
   column.append(el('h1','Let agents run without asking?'),el('p','This sets the default for new agents. You can change it for each agent, and later in Settings.'));
   const group=el('div');group.setAttribute('role','radiogroup');group.setAttribute('aria-label','Default for new agents');
   for(const [value,title,help] of [['off','Ask me before an agent runs a command','The safe default. Each agent asks, and you approve in the room.'],['on','Let agents run without asking','They can run commands and change files on this server unattended.']]){
    const choice=button(title,`web-setup-approval-${value}`,()=>controller.chooseApproval(value),unconfirmed);const mark=el('span',state.choice===value?'●':'○');mark.className='web-oobe-radio-mark';mark.setAttribute('aria-hidden','true');choice.append(mark);choice.className='web-oobe-choice';choice.setAttribute('role','radio');choice.setAttribute('aria-checked',String(state.choice===value));choice.append(el('small',help));group.append(choice);
   }column.append(group);
  }
  if(state.step===3){
   column.append(el('h1','Your agents'),el('p','These programs are on this server. We can tell if a program is installed, not if you\'re signed in. You can do this later in Settings.'));
   column.append(el('p','Claude Code and Codex can join a room. Gemini opens as a terminal.','web-setup-room-scope'));
   if(state.agentsStatus==='unavailable')column.append(el('p',"Couldn't check the agents on this server. You can do this later in Settings.",'web-setup-agents-unavailable'));
   for(const agent of state.agents||[]){const row=el('div');row.className='web-oobe-agent';row.dataset.agentId=agent.id;const label=el('div',agent.label);label.append(el('small',agent.installed===false?'Not installed on this server. Ask whoever set up this server to install it.':agent.installed===null?"Can't check. Open a sign-in terminal to see.":agent.id==='claude-code'?'Installed on this server. Open sign-in, then finish in the terminal.':agent.id==='codex-cli'?'Installed on this server. Opens in a room or as a terminal. Open sign-in, then finish in the terminal.':'Installed on this server. Opens as a terminal. Open sign-in, then finish in the terminal.'));const chip=el('span',undefined,'web-setup-agent-status');chip.className='web-oobe-chip';if(agent.installed!==false){const mark=el('span',agent.installed===true?'✓':'?');mark.setAttribute('aria-hidden','true');chip.append(mark);}chip.append(el('span',agentWords[String(agent.installed)]));row.append(label,chip);if(agent.installed!==false)row.append(button('Open sign-in','web-setup-agent-signin',()=>controller.openAgent(agent.id),unconfirmed));column.append(row);}
  }
  if(state.step===4){
   column.append(el('h1','Where should your code live?'),el('p','New rooms use this folder by default. Your existing rooms keep their folders.'));
   const label=el('label','Code folder');label.htmlFor='web-setup-folder';const path=el('input',undefined,'web-setup-folder');path.id='web-setup-folder';path.type='text';path.readOnly=true;path.value=state.folder||'';path.placeholder='No folder chosen';
   const row=el('div');row.className='web-oobe-folder-row';row.append(path,button('Choose folder…','web-setup-choose-folder',()=>controller.chooseFolder(),unconfirmed));column.append(label,row);if(state.folderVerified)column.append(el('p','Found on this server.','web-setup-folder-found'));
  }
  if(state.error){const text=state.error==='unconfirmed'?"Couldn't confirm the change. Check the saved settings before trying again.":'The server did not accept that change. Check your choices and try again.';const result=el('p',text,'web-setup-result');result.dataset.outcome=state.error;result.setAttribute('role','alert');column.append(result);if(unconfirmed)column.append(button('Check again','web-setup-refresh',()=>state.step===3?controller.refreshAgents():controller.show()));}
  const actions=el('div');actions.className='web-oobe-actions';
  if(state.step>1)actions.append(button('Back','web-setup-back',()=>controller.back(),unconfirmed));
  if(state.step===3)actions.append(button('Skip for now','web-setup-skip',()=>controller.next(),unconfirmed));
  const next=button(state.step===4?'Finish':'Next',state.step===4?'web-setup-finish':'web-setup-next',()=>state.step===4?controller.finish():controller.next(),unconfirmed||state.disclosure||(state.step===4&&!state.folder));next.className='web-oobe-primary';actions.append(next);column.append(actions);
  if(busy&&state.status!=='picking'){const progress=el('p',state.status==='saving'?'Saving…':'Checking setup…');progress.setAttribute('role','status');column.append(progress);}
  if(state.disclosure){const box=el('dialog',undefined,'web-approval-disclosure');dialog=box;box.className='web-oobe-disclosure';const title=el('h2','Let agents run without asking?');title.id='web-oobe-disclosure-title';box.setAttribute('aria-labelledby',title.id);box.append(title,...DISCLOSURE.map(text=>el('p',text)));
   const footer=el('div');footer.className='web-oobe-actions';const cancel=button('Keep it off','web-approval-cancel',()=>controller.cancelDisclosure());const confirm=button('Turn on','web-approval-confirm',()=>controller.confirmDisclosure());confirm.className='web-oobe-primary';footer.append(cancel,confirm);box.append(footer);column.append(box);box.addEventListener('cancel',event=>{event.preventDefault();if(current())controller.cancelDisclosure();});box.showModal();cancel.focus();
  }
 }
 const controller=createOnboarding({api,onChange:paint});paint(controller.state());
 return Object.freeze({show:()=>{completed=false;return controller.show();},hide:controller.hide,reset:controller.reset,state:controller.state,destroy(){alive=false;version++;close();controller.destroy();host.replaceChildren();host.hidden=true;}});
}
