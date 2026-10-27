// The installer owns this terminal. It never reads prompt text or synthesizes
// input: even the installer's first Enter must come from the person.
export function createInstallerView({host,api,Terminal=globalThis.Terminal,
  FitAddon=globalThis.FitAddon?.FitAddon,schedule=setTimeout,clear=clearTimeout,onError=()=>{}}) {
 let term=null,fit=null,observer=null,timer=null,operation=null,cursor=0,epoch=0,ended=false,disposed=false,writing=null;
 const subscriptions=[],input=[];let queued=0;
 function fail(stamp,id){if(!current(stamp,id)||ended)return;ended=true;input.length=0;queued=0;if(term)term.options.disableStdin=true;onError();}
 function current(stamp,id){return !disposed&&epoch===stamp&&operation===id;}
 async function drain(stamp,id){
  if(writing||!current(stamp,id))return;
  const ticket={stamp,id};writing=ticket;
  try {
   while(input.length&&current(stamp,id)&&!ended){
    const data=input.shift();queued-=data.length;
    const accepted=await api.terminalWrite({operationId:id,data});
    // A late false reply belongs to the old view just as a late success does.
    // It cannot report an error or mutate the replacement operation's queue.
    if(!current(stamp,id))return;
    if(!accepted){fail(stamp,id);break;}
   }
  }catch{fail(stamp,id);}
  finally {if(writing===ticket)writing=null;}
 }
 async function poll(stamp,id){
  try {
   const result=await api.terminalRead({operationId:id,cursor});
   if(!current(stamp,id))return;
   if(!result||typeof result.data!=='string'||result.data.length>16384||!Number.isSafeInteger(result.cursor)||result.cursor<cursor)throw Error();
   if(result.truncated)term.write('\r\n[Earlier installer output omitted]\r\n');
   if(result.data)term.write(result.data);cursor=result.cursor;
   if(result.ended&&!result.data){ended=true;term.options.disableStdin=true;return;}
   timer=schedule(()=>{timer=null;void poll(stamp,id);},100);
  }catch{fail(stamp,id);}
 }
 return Object.freeze({
  prepare(){
   if(disposed||typeof Terminal!=='function')return false;
   if(term)return true;
   try {
    term=new Terminal({convertEol:false,scrollback:1000,cols:90,rows:16,disableStdin:true});host.hidden=false;term.open(host);
    if(FitAddon){fit=new FitAddon();term.loadAddon(fit);fit.fit();}
    subscriptions.push(term.onData(data=>{
     if(disposed||!operation||ended||typeof data!=='string'||data.length>4096||queued+data.length>16384)return;
     input.push(data);queued+=data.length;void drain(epoch,operation);
    }),term.onResize(({cols,rows})=>{
     if(disposed||!operation||ended)return;
     const stamp=epoch,id=operation;void Promise.resolve(api.terminalResize({operationId:id,cols,rows})).catch(()=>{fail(stamp,id);});
    }));
    if(fit&&globalThis.ResizeObserver){observer=new ResizeObserver(()=>{if(!disposed)try{fit.fit();}catch{}});observer.observe(host);}
    return true;
   }catch{term?.dispose();term=null;host.replaceChildren();host.hidden=true;return false;}
  },
  attach(value){
   if(disposed||!value?.owned||typeof value.operationId!=='string'||value.operationId===operation||!term)return;
   clear(timer);timer=null;input.length=0;queued=0;writing=null;
   operation=value.operationId;cursor=0;ended=false;const stamp=++epoch;term.options.disableStdin=false;
   if(fit)try{fit.fit();}catch{}
   if(Number.isInteger(term.cols)&&Number.isInteger(term.rows))void Promise.resolve(api.terminalResize({operationId:operation,cols:term.cols,rows:term.rows})).catch(()=>{});
   void poll(stamp,operation);
  },
  destroy(){if(disposed)return;disposed=true;epoch++;clear(timer);writing=null;input.length=0;queued=0;observer?.disconnect();for(const item of subscriptions)item?.dispose();term?.dispose();host.replaceChildren();host.hidden=true;}
 });
}
