// Local-first Servers surface (master spec B2.2). Remote administration is mounted
// only for a signed-in server scope; the local entry never needs an account or IPC.
export function createLocalServerPage(deps) {
  const {host}=deps;
  const canAdd=()=>deps.canAddServer?.()===true;
  let remote=null, remoteHost=null, selected=null, destroyed=false, local=null, observer=null;
  const syncVisibility=()=>{if(local)local.hidden=remote?.state().view==='server';};
  const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e;};
  function sync() {
    if(destroyed)return false;
    const account=deps.account();
    const key=JSON.stringify([account?.id||null,deps.accountEpoch?.()||0,!!account?.serversScope,canAdd()]);
    if(key!==selected){observer?.disconnect();observer=null;remote?.destroy();remote=null;remoteHost=null;selected=key;}
    if(!remoteHost){
      host.textContent='';host.classList.add('sv-root');
      local=node('section','sv-page');local.setAttribute('aria-label','This computer');local.setAttribute('data-server','local');
      local.appendChild(node('h2',null,'This computer'));
      local.appendChild(node('p','sv-sub','Local rooms'));
      host.appendChild(local);
      remoteHost=node('div');host.appendChild(remoteHost);
      if(account?.serversScope){
        remote=deps.createRemote({...deps,host:remoteHost});
        // The delegated page also navigates internally (Back and list rows).
        // Observe its renders without changing the remote page's event handling.
        observer=new MutationObserver(syncVisibility);observer.observe(remoteHost,{childList:true,subtree:true});
      }
      else {
        const empty=node('section','sv-empty');const inner=node('div','sv-empty-in');
        const symbol=node('span','ms','dns');symbol.setAttribute('aria-hidden','true');inner.appendChild(symbol);
        inner.appendChild(node('h2',null,'You are working locally'));
        inner.appendChild(node('p',null,'Add a server to share rooms and agents with other people, and to keep your chats safe and available on your other computers.'));
        inner.appendChild(node('p','sv-sm','Chats on this computer stay on this computer.'));
        if(canAdd()){
        const add=node('button','sv-btn filled','Add a server');add.type='button';add.addEventListener('click',()=>{
          if(destroyed||!canAdd())return;
          return Promise.resolve().then(()=>{if(!destroyed&&canAdd())return deps.addServer();}).catch(()=>{
            if(!destroyed)deps.snackbar("That didn't work. Try again.");
          });
        });inner.appendChild(add);
        }
        empty.appendChild(inner);remoteHost.appendChild(empty);
      }
    }
    host.style.background=remote ? '' : 'var(--md-sys-color-surface)';
    syncVisibility();
    return true;
  }
  return {
    paint(){if(sync()){remote?.paint();syncVisibility();}},
    async shown(){if(sync())await remote?.shown();},
    async refresh(){if(sync())await remote?.refresh();},
    async openServer(id,tab){if(sync()){const result=remote?.openServer(id,tab);syncVisibility();await result;syncVisibility();}},
    state(){return remote?.state()||{view:'local',serverId:null};},
    destroy(){destroyed=true;observer?.disconnect();observer=null;remote?.destroy();remote=null;host.textContent='';},
  };
}
