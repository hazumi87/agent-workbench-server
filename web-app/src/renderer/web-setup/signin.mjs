// The engine owns sign-in and its cookies. This gate only reads the existing rooms status.
export function createSignInGate({wb,onChange=()=>{},timeoutMs=15000}){
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw Error('Invalid status deadline');
  let cancelRead=()=>{};
  let alive=true,generation=0,state={phase:'checking',loginPath:'/login'};
  const snapshot=()=>({...state});
  function publish(phase){if(!alive)return;state={phase,loginPath:'/login'};onChange(snapshot());}
  function receive(status){publish(status?.signedIn===true?'signed-in':status?.signedIn===false?'signed-out':'unavailable');}
  function reset(){if(!alive)return;generation++;cancelRead();publish('checking');}
  async function refresh(){
    if(!alive)return;
    cancelRead();const mine=++generation;publish('checking');
    let timer,release;
    const bounded=new Promise(resolve=>{release=()=>{clearTimeout(timer);resolve(null);};timer=setTimeout(release,timeoutMs);});
    cancelRead=release;
    try{const status=await Promise.race([Promise.resolve().then(()=>wb.rooms.status()),bounded]);if(alive&&mine===generation)receive(status);}
    catch{if(alive&&mine===generation)publish('unavailable');}
    finally{clearTimeout(timer);if(cancelRead===release)cancelRead=()=>{};}
  }
  const offStatus=wb.on('rooms:status',status=>{if(!alive)return;generation++;cancelRead();receive(status);});
  const offAccount=wb.on('rooms:account',()=>{reset();void refresh();});
  return Object.freeze({state:snapshot,refresh,reset,destroy(){if(!alive)return;alive=false;generation++;cancelRead();offStatus();offAccount();}});
}

export function mountSignIn({host,wb}){
  const doc=host.ownerDocument;
  const dialog=doc.createElement('dialog');dialog.className='web-signin';dialog.dataset.wbTest='web-signin';
  dialog.setAttribute('aria-labelledby','web-signin-title');
  const title=doc.createElement('h1');title.id='web-signin-title';
  const message=doc.createElement('p');message.setAttribute('role','status');
  const login=doc.createElement('a');login.href='/login?next='+encodeURIComponent('/app/');login.textContent='Sign in';login.dataset.wbTest='web-signin-link';
  const retry=doc.createElement('button');retry.type='button';retry.textContent='Try again';retry.dataset.wbTest='web-signin-retry';
  const column=doc.createElement('div');column.className='web-signin-column';
  const icon=doc.createElement('span');icon.className='ms web-signin-icon';icon.setAttribute('aria-hidden','true');
  column.append(icon,title,message,login,retry);dialog.append(column);host.append(dialog);
  // The engine sign-in page replaces this document only after an explicit link press.
  // Escape must not uncover controls that belong to a previous signed-in state.
  const preventCancel=event=>event.preventDefault();dialog.addEventListener('cancel',preventCancel);
  let previous=null;
  const gate=createSignInGate({wb,onChange(state){
    dialog.dataset.state=state.phase;
    if(state.phase==='signed-in'){if(dialog.open)dialog.close();previous=state.phase;return;}
    title.textContent=state.phase==='signed-out'?'Sign in to Agent Workbench':state.phase==='unavailable'?"Couldn't check if you're signed in.":'Agent Workbench';
    icon.textContent=state.phase==='signed-out'?'lock':'cloud_off';
    message.textContent=state.phase==='signed-out'?'Your session on this server ended. Sign in again to continue. Your rooms and files are still here.':state.phase==='checking'?'Checking your sign-in…':"The server didn't answer. Your rooms and files are not affected.";
    login.hidden=state.phase!=='signed-out';retry.hidden=state.phase!=='unavailable';
    if(!dialog.open)dialog.showModal();
    if(previous!==state.phase){if(!login.hidden)login.focus();else if(!retry.hidden)retry.focus();}
    previous=state.phase;
  }});
  const again=()=>{void gate.refresh();};retry.addEventListener('click',again);void gate.refresh();
  return {destroy(){gate.destroy();retry.removeEventListener('click',again);dialog.removeEventListener('cancel',preventCancel);if(dialog.open)dialog.close();dialog.remove();},state:gate.state};
}
