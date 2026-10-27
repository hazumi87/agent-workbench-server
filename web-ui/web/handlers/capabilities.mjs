import {createSettingsAPI} from './setup-settings.mjs';

/** What the engine says it can do (engine v4: `hosted` and `bareShell` in GET /api/settings/setup). Absent fields mean "as before": a bare shell is offered. */
export function createCapabilities(read){
  let bare=true;const listeners=new Set();
  const verdict=setup=>!(setup && typeof setup==='object' && (setup.hosted===true || setup.bareShell===false));
  async function refresh(){
    let next=bare;
    try{next=verdict(await read());}catch{/* not signed in yet or unreachable: keep what we knew */}
    if(next!==bare){bare=next;for(const fn of [...listeners]){try{fn(bare);}catch{/* a listener must not stop the others */}}}
    return bare;
  }
  return Object.freeze({
    /** false only when the engine said so (hosted, or bareShell false). */
    bareShell:()=>bare,
    refresh,
    onChange(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
  });
}
export function register(api){
  const settings=createSettingsAPI((path,init)=>api.engine.fetch(path,init));
  api.expose('capabilities',createCapabilities(()=>settings.readSetup()));
}
