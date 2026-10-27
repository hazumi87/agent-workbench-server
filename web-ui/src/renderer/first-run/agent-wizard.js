import { agentWords } from './agents.js';
import { createInstallerView } from './installer-view.js';

// A stable Workrooms panel. Navigation changes instructions, never terminal
// state or starter readiness. The held first launch has no callable action.
export function createAgentWizard({host, api, onVisibility=()=>{}}) {
  const doc = host.ownerDocument;
  const make = (tag, cls, text) => {const n=doc.createElement(tag);n.className=cls;if(text)n.textContent=text;return n;};
  const labels = {'claude-code':'Claude Code','codex-cli':'Codex','gemini-cli':'Gemini'};
  const steps = ['Set up your agents','Where should your code live?','Git','Open Claude once','Choose a theme','Sign in','Review the API key question','Review security','Review folder trust','Review MCP servers'];
  let alive=true, visible=false, generation=null, epoch=0, loaded=false, busy=false, checking=false, step=0, message='';
  let folderDraft=null,folderSynced=false,acceptSynced=false,explicitOpen=false;
  function folderRefusal(code){
    folderSynced=code==='code-folder-synced';acceptSynced=false;
    message=folderSynced?'':({
      'code-folder-system':'That folder is part of Windows. Choose a folder in your own files.',
      'code-folder-network':"Network folders can't be used yet. Choose a folder on this computer.",
      'code-folder-root':'Choose a folder, not the whole drive.',
      'code-folder-absolute':'Choose a full folder path, like C:\\Users\\you\\code.',
      'code-folder-protected':'Choose a folder outside the app data and install folders.',
      'code-folder-unwritable':"Workbench can't write to that folder. Choose another folder."
    }[code]||'Could not use that code folder. Choose another folder and try again.');
  }
  const initial=()=>({rows:Object.keys(labels).map(id=>({id,installed:'unknown'})),selected:[],dismissed:false});
  let snapshot=initial();
  let terminal=null,pollTimer=null,help=false,skipConfirm=false,lastVisible=false,terminalFault=false;
  const content=make('div',''),terminalHost=make('div','lf-installer-terminal');terminalHost.hidden=true;
  terminalHost.setAttribute('aria-label','Agent installer terminal');host.replaceChildren(content,terminalHost);
  const installing=()=>busy||snapshot.installer?.owned&&['opening','installing','cancelling','cleanup-unconfirmed'].includes(snapshot.installer.status);
  function dropTerminal(){terminal?.destroy();terminal=null;clearTimeout(pollTimer);pollTimer=null;}
  function prepareTerminal(){
    if(!terminal)terminal=createInstallerView({host:terminalHost,api,onError:()=>{if(alive&&visible&&!['failed','installed','unknown','cancelled'].includes(snapshot.installer?.status)){terminalFault=true;message='The installer terminal is unavailable. Cancel the installation and try again.';paint();}}});
    return terminal.prepare();
  }
  function poll(){
    clearTimeout(pollTimer);pollTimer=null;
    if(!alive||!visible||!snapshot.installer?.owned||!['opening','installing','cancelling'].includes(snapshot.installer.status))return;
    const stamp=epoch;
    pollTimer=setTimeout(async()=>{
      pollTimer=null;if(!alive||!visible||stamp!==epoch)return;
      if(busy){poll();return;}
      try{const value=await api.getState();if(!alive||!visible||stamp!==epoch)return;
        const changed=JSON.stringify(snapshot)!==JSON.stringify(value);snapshot=value;
        if(terminalFault&&['failed','installed','unknown','cancelled'].includes(value.installer?.status)){terminalFault=false;message='';}
        if(changed)paint();poll();
      }catch{if(alive&&visible&&stamp===epoch){message='Could not check the installation. Cancel it and try again.';paint();}}
    },300);
  }
  host.classList.add('lf-host','lf-agent-wizard');host.hidden=true;
  host.setAttribute('aria-label','Set up agents');
  function button(text, action, disabled=false) {
    const b=make('button','lf-button tonal',text);b.type='button';b.disabled=disabled;
    b.addEventListener('click',()=>{if(alive&&visible&&!b.disabled)action();});return b;
  }
  function paint() {
    if(!alive)return;
    host.hidden=!visible||snapshot.dismissed===true&&!explicitOpen;
    if(lastVisible!==!host.hidden){lastVisible=!host.hidden;onVisibility(lastVisible);}
    if(host.hidden)return;
    const surface=make('div','lf-page');
    surface.append(make('h2','',steps[step]));
    const intro=['Agent Workbench runs coding agents on this computer. Choose the ones you want to set up now. You can do this later in Settings.','Pick a folder where your agents keep their work.','Agents use git to save their work.'][step];
    if(intro)surface.append(make('p','lf-secondary',intro));
    if(step===0) {
      for(const value of snapshot.rows||[]) {
        const row=checking?{...value,installed:'checking'}:value;
        if(!Object.hasOwn(labels,row.id))continue;
        const words=agentWords(row),card=make('section','lf-agent-row');card.setAttribute('aria-label',words.accessibleName);
        const choice=make('label','lf-choice'),tick=make('input','');tick.type='checkbox';tick.checked=snapshot.selected?.includes(row.id);tick.disabled=installing();
        tick.addEventListener('change',()=>{const selected=new Set(snapshot.selected||[]);tick.checked?selected.add(row.id):selected.delete(row.id);void act('select',[...selected]);});
        const copy=make('div','lf-agent-copy'),title=make('div','lf-agent-title');
        choice.append(tick,make('span','',labels[row.id]));title.append(choice,make('span','lf-location',words.chip));
        let detail=words.detail;
        if(row.installed==='missing')detail=snapshot.canInstall?(row.id==='claude-code'?'Will be installed, then you sign in.':'Will be installed.'):'Install it yourself, then choose Check again.';
        copy.append(title,make('p','lf-secondary',detail));card.append(copy);
        if(snapshot.canInstall&&['missing','failed'].includes(row.installed))card.append(button(row.installed==='failed'?'Try again':'Install '+labels[row.id],()=>void act('install',row.id),installing()||snapshot.installer?.status==='busy'));
        surface.append(card);
      }
      surface.append(button('Check again',()=>void act('check'),installing()));
    } else if(step===1) {
      const folder=snapshot.codeFolder;
      surface.append(make('p','lf-secondary','New rooms use this folder by default. Your existing rooms keep their folders.'));
      if(folder) {
        const input=make('input','lf-path');input.type='text';input.value=folderDraft??folder.path;input.setAttribute('aria-label','Code folder');input.disabled=busy;
        input.addEventListener('input',()=>{
          folderDraft=input.value;folderSynced=false;acceptSynced=false;message='';
          // Keep the input/caret stable while clearing feedback for the previous path.
          surface.querySelector('.lf-helper')?.remove();
          surface.querySelector('.lf-folder-warning')?.remove();
          const status=surface.querySelector('.lf-operation');if(status)status.textContent='';
          const use=surface.querySelector('.lf-folder-use');if(use)use.hidden=false;
        });surface.append(input);
        const folderActions=make('div','lf-actions');
        folderActions.append(button('Choose folder',()=>void act('chooseCodeFolder'),busy));surface.append(folderActions);
        if(folderSynced) {
          const warning=make('section','lf-folder-warning');
          warning.append(make('p','lf-message warning','This folder syncs with OneDrive. Agents write many files, which can slow syncing. Use it anyway?'));
          const choices=make('div','lf-actions');choices.append(button('Use it anyway',()=>void act('saveCodeFolder',{path:folderDraft??folder.path,acceptSynced:true}),busy),
            button('Choose another',()=>void act('chooseCodeFolder'),busy));warning.append(choices);surface.append(warning);
        }
        const use=button('Use this folder',()=>void act('saveCodeFolder',{path:folderDraft??folder.path,acceptSynced:false}),busy);use.classList.add('lf-folder-use');use.hidden=folderSynced;folderActions.append(use);
        if(folder.saved&&!busy&&!message&&!folderSynced&&(folderDraft??folder.path)===folder.path)surface.append(make('p','lf-helper','Code-folder default saved.'));
      } else surface.append(make('p','lf-message','Code-folder settings are not available here.'));
    } else if(step===2) {
      surface.append(make('p','lf-message','Git setup is not available yet. You can continue without installing git.'));
    } else {
      const text=[null,'Opening Claude Code here is not available yet. You can continue with setup.',
        'Claude Code is asking you to choose a theme. Use the arrow keys in the window below, then press Enter.','Sign in using the terminal instructions when the first launch is available.',
        'Review the API key question in the terminal.','Read the security notes in the terminal.',
        'Review the folder trust question in the terminal.','Review the MCP server question in the terminal.'][step-2];
      surface.append(make('p','lf-message',text));
      if(step===3)surface.append(button('Open Claude once',()=>{},true));
      surface.append(button('I see this instead ▾',()=>{help=!help;paint();}));
      if(help){
        surface.append(button("Claude isn't installed",()=>{step=0;help=false;paint();}),
          button('No browser opened',()=>{message='A sign-in link is not available yet.';paint();}),
          button('Unable to connect',()=>{message='Network checking is not available yet. Check your connection, then try again.';paint();}));
      }
    }
    const status=make('p','lf-operation',checking?'':busy?'Working…':message||({installing:'Follow the installer in the terminal below.',cancelled:'Installation did not finish. Check the terminal, then try again.',installed:'Installation finished.',unknown:'Installation finished, but the agent could not be checked. Choose Check again.', 'needs-npm':'Gemini needs npm. Install Node.js and npm first, then try again.',failed:'','cleanup-unconfirmed':'The installer could not be stopped. Close Workbench before trying again.'}[snapshot.installer?.status]||''));status.setAttribute('role','status');status.hidden=!status.textContent;surface.append(status);
    const actions=make('div','lf-actions');
    if(step>0)actions.append(button('Back',()=>{step--;message='';paint();},busy));
    if(step<steps.length-1)actions.append(button(step>=3?"I've answered it, continue":'Next',()=>{step++;message='';help=false;paint();},busy));
    else actions.append(button('Back to agents',()=>{step=0;paint();},busy));
    if(snapshot.installer?.owned||busy&&terminal)actions.append(button('Cancel installation',()=>void act('cancelInstall'),snapshot.installer?.status==='cancelling'));
    const skip=button('Skip for now',()=>{if(installing()&&terminal){skipConfirm=true;paint();}else void act('finish');});skip.className='lf-button text';actions.append(skip);
    surface.append(actions);
    if(skipConfirm){
      const dialog=make('section','lf-message lf-skip-question');dialog.setAttribute('role','alertdialog');dialog.setAttribute('aria-label','Stop installation and skip setup?');
      const stay=button('Keep setting up',()=>{skipConfirm=false;paint();});
      const choices=make('div','lf-actions');choices.append(stay,button('Stop and skip',()=>{skipConfirm=false;void act('finish');}));
      dialog.append(make('p','','Stop installation and skip setup? The installer and anything it started will stop.'),choices);surface.append(dialog);
      content.replaceChildren(surface);stay.focus();
    }else content.replaceChildren(surface);
    if(snapshot.installer?.owned&&terminal)terminal.attach(snapshot.installer);
  }
  async function act(method,input) {
    if(!alive||!visible||busy&&!['cancelInstall','finish'].includes(method))return;
    if(method==='install'){
      dropTerminal();terminalFault=false;message='';if(!prepareTerminal()){message='The installer terminal could not open. Nothing was started.';paint();return;}
    }
    if(['cancelInstall','finish'].includes(method))dropTerminal();
    const stamp=++epoch;busy=true;checking=method==='getState'||method==='check';message='';paint();
    try {
      const result=await api[method](input);
      if(!alive||!visible||stamp!==epoch)return;
      if(result?.ok===false&&method.includes('CodeFolder')){folderRefusal(result.code);return;}
      if((!result&&method!=='chooseCodeFolder')||result?.ok===false)throw Error();
      if(method==='chooseCodeFolder') {
        if(result){folderDraft=result.path;folderSynced=result.synced===true;acceptSynced=false;}
      } else {snapshot=result;loaded=true;if(method==='finish')explicitOpen=false;if(method==='saveCodeFolder'){folderDraft=result.codeFolder?.path??folderDraft;folderSynced=false;acceptSynced=false;}}

    } catch(error) {if(alive&&visible&&stamp===epoch) {
      message=method==='install'?'Could not start the installation. Check again, then try again.':method==='cancelInstall'?'Could not stop the installer. Close Workbench before trying again.':method==='finish'?'Could not save your choice. Try again.':method.includes('CodeFolder')?'Could not use that code folder. Choose another folder and try again.':'Could not check your agents. Try again.';
    }}
    finally {if(alive&&visible&&stamp===epoch){
      busy=false;checking=false;
      // State reads never launch processes; the visible wizard requests one bounded check.
      // Room repaints retain this mount, while hide/account changes invalidate the epoch.
      if(method==='getState'&&loaded&&(!snapshot.dismissed||explicitOpen)&&!installing())void act('check');
      else {paint();poll();if(method==='install'&&terminal&&!terminalHost.hidden)terminalHost.scrollIntoView?.({block:'start',behavior:'auto'});}
    }}
  }
  function cancel() {epoch++;busy=false;checking=false;loaded=false;dropTerminal();try{Promise.resolve(api.cancel()).catch(()=>{});}catch{}}
  return Object.freeze({
    context({shown,local,scope}) {
      if(!alive)return;
      const changed=generation!==scope;
      if(changed){if(generation!==null)cancel();explicitOpen=false;generation=scope;loaded=false;step=0;message='';help=false;skipConfirm=false;folderDraft=null;folderSynced=false;acceptSynced=false;snapshot=initial();}
      const next=shown&&local;
      if(!changed&&visible===next)return;
      if(visible&&!next){explicitOpen=false;cancel();}visible=next;
      paint();if(visible&&!loaded)void act('getState');
    },
    // Only an explicit caller can override dismissal. The page first activates
    // its visible local All rooms context; no bridge/preference write is needed.
    reopen(){
      if(!alive||!visible)return false;
      if(explicitOpen||loaded&&!snapshot.dismissed)return true;
      explicitOpen=true;step=0;message='';help=false;skipConfirm=false;paint();
      if(!loaded)void act('getState');else if(!installing())void act('check');
      return true;
    },
    destroy(){if(!alive)return;explicitOpen=false;cancel();alive=false;visible=false;host.replaceChildren();host.hidden=true;if(lastVisible){lastVisible=false;onVisibility(false);}}
  });
}
