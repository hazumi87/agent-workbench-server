// Additive starter controls. Frozen contextBridge methods are called directly;
// no Proxy, credential, terminal parsing, automatic seed from render, or fan-out.
export function createStarterWorkrooms({api,onOpen=()=>{},onTerminal=()=>{},onSetupAgents,now=()=>globalThis.performance?.now()??Date.now(),onGridChange=()=>{},onVisibilityChange=()=>{},onSettings,storage,snackbar=()=>{}}={}) {
  let destroyed=false,shownId=null,epoch=0,timer=null,checkTimer=null,value=null,busy=false;
  const missingSeats=new Set(),checks=new Map(),refusals=new Map(),openFailures=new Map(),hideKey='wb.starter-workrooms.hidden:local';
  let undoPending=false,undoTimer=null;
  let store=storage,hidden=false,references={},preferencesReady=false,preferencesLoading=null,gridNode=null,gridOptions={};
  try{if(store===undefined)store=globalThis.localStorage;hidden=store?.getItem(hideKey)==='true';}catch{}
  function loadPreferences(){
    if(preferencesReady||preferencesLoading||typeof api?.preferences!=='function')return preferencesLoading;
    preferencesLoading=Promise.resolve().then(()=>api.preferences()).then(result=>{
      if(destroyed)return;const next={};
      for(const key of ['my-first-room','my-project']){const ref=result?.references?.[key];
        if(ref&&typeof ref.room_id==='string'&&ref.groups&&typeof ref.groups==='object'&&!Array.isArray(ref.groups)&&Object.keys(ref.groups).length===(key==='my-project'?4:0))next[key]={room_id:ref.room_id,groups:{...ref.groups}};}
      const changed=JSON.stringify(references)!==JSON.stringify(next);references=next;preferencesReady=true;
      if(gridNode)paintGrid();if(changed)onGridChange();
    }).catch(()=>{}).finally(()=>{preferencesLoading=null;});return preferencesLoading;
  }
  const node=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls;if(text)n.textContent=text;return n;};
  const mount=node('section','wb-starter-controls');mount.hidden=true;mount.setAttribute('aria-label','Starter room agents');
  const button=(text,action,disabled=false,kind='tonal')=>{const b=node('button','wb-starter-button '+kind,text);b.type='button';b.disabled=disabled;b.addEventListener('click',action);return b;};
  function error(e,seatId){if(!destroyed){if(e?.code==='vendor-missing'){missingSeats.add(seatId||value?.leadId);paint();return;}const message=e?.message||e?.error||"Couldn't start the agents. Try again.";if(seatId)refusals.set(seatId,message);snackbar(message);paint();}}
  const names={'my-first-room':'My first room','my-project':'My project'};
  function openFailure(template,result){
    const ref=references[template],name=gridOptions.rooms?.find(v=>v.room?.id===ref?.room_id)?.room?.name||names[template]||'this starter room';
    const known=['unknown_template','invalid','recipe_conflict','not_local','starter-recipes-missing','starter-read-failed','engine-contract-unavailable','starter-cancelled'];
    const message=!['missing-route','unexpected'].includes(result?.reason)&&known.includes(result?.code)&&typeof (result?.error||result?.message)==='string'?(result.error||result.message):`Couldn't open ${name}. ${result?.reason==='missing-route'||result?.code==='starter-route-missing'?'Update Workbench and try again.':'Try again in a moment.'}`;
    openFailures.set(template,message);if(gridNode)paintGrid();
  }
  async function perform(method,input){if(destroyed||busy||!api)return;busy=true;if(input?.seatId){refusals.delete(input.seatId);missingSeats.delete(input.seatId);}if(method==='open')openFailures.delete(input.template);paint();if(gridNode)paintGrid();const mine=epoch;
    try{const r=await api[method](input);if(destroyed||mine!==epoch)return;
      if(method==='open'){
        if(!r?.roomId){openFailure(input.template,r);return;}
        preferencesReady=false;await loadPreferences();if(!destroyed&&mine===epoch)onOpen(r.roomId);return;
      }
      if(r?.error){error(r,input?.seatId||r.leadId);return;}await refresh();}
    catch(e){if(!destroyed&&mine===epoch){if(method==='open')openFailure(input.template,e);else error(e,input?.seatId);}}
    finally{if(!destroyed&&mine===epoch){busy=false;paint();if(gridNode)paintGrid();}}}

  function accept(result){
    for(const seat of result?.seats||[]){
      const previous=value?.seats?.find(s=>s.id===seat.id);
      const paneChanged=previous&&(seat.paneId||null)!==(previous.paneId||null);
      if(paneChanged||['starting','ready','waiting','shell'].includes(seat.state)){
        missingSeats.delete(seat.id);refusals.delete(seat.id);
      }
    }
    value=result;if(result?.code==='vendor-missing')missingSeats.add(result.leadId);
  }
  function seatState(seat){
    if(seat.state!=='unknown'){checks.delete(seat.id);return seat.state;}
    const pane=seat.paneId||null;let check=checks.get(seat.id);
    if(!check||check.pane!==pane){check={pane,since:now()};checks.set(seat.id,check);}
    return now()-check.since>=10000?'unconfirmed':'unknown';
  }
  const hasPane=seat=>typeof seat?.paneId==='string'&&seat.paneId.length>0;
  function paint(){const paintEpoch=epoch;clearTimeout(checkTimer);checkTimer=null;mount.replaceChildren();mount.hidden=!value||!shownId||destroyed;if(mount.hidden)return;
    const head=node('div','wb-starter-heading');head.append(node('h3','','Agents'));mount.append(head);
    const roster=node('div','wb-starter-roster');roster.setAttribute('role','list');
    for(const seat of value.seats||[]){const state=seatState(seat);const row=node('div','wb-starter-seat'),label=node('div','wb-starter-seat-label'),plate=node('span','wb-starter-plate',seat.handle.slice(0,2).toUpperCase());
      row.setAttribute('role','listitem');plate.setAttribute('aria-hidden','true');
      label.append(node('strong','wb-starter-name',`@${seat.handle}${seat.lead?' · lead':''}`),node('span','wb-starter-state',(state==='shell'?'no agent running':state==='unconfirmed'?"can't tell":seat.label)||({'not-started':'not started',starting:'starting…',ready:'ready',unknown:'checking…'}[state]||state)));
      row.append(plate,label,button('Start',()=>perform('startSeat',{template:value.template,roomId:seat.roomId,seatId:seat.id}),busy||seat.canStart!==true));roster.append(row);}
    mount.append(roster);
    const pane=node('div','wb-starter-messages');pane.setAttribute('aria-live','polite');
    // Frame H: persistent refusal in the pane, never inside the roster row.
    for(const seat of value.seats||[]){const refusal=refusals.get(seat.id)||(seat.id===value.leadId?value.error:null);
      if(refusal&&!missingSeats.has(seat.id)){const message=node('section','wb-starter-message');message.append(node('strong','wb-starter-message-title',`Can't start @${seat.handle}.`),node('p','wb-starter-refusal',refusal));pane.append(message);}}
    for(const seat of value.seats||[]){const state=seatState(seat);
      if(missingSeats.has(seat.id)){const message=node('section','wb-starter-message');message.append(node('p','',(globalThis.wb&&globalThis.wb.web?"Claude Code isn't installed on this server.":"Claude Code isn't installed on this computer.")),node('p','','Set up your agents to use this room.'));if(typeof onSetupAgents==='function')message.append(button('Set up agents',()=>{if(!destroyed&&paintEpoch===epoch&&shownId&&missingSeats.has(seat.id))onSetupAgents();},busy,'filled'));pane.append(message);}
      if(!hasPane(seat)&&seat.lead&&!missingSeats.has(seat.id)&&!['ready','starting','unavailable'].includes(state)){
        const message=node('section','wb-starter-message');message.append(node('p','',`@${seat.handle} isn't running. Set up your agents to use this room.`));
        if(typeof onSetupAgents==='function')message.append(button('Set up your agents',()=>{const current=value?.seats?.find(s=>s.id===seat.id);if(!destroyed&&paintEpoch===epoch&&shownId&&current&&!hasPane(current))onSetupAgents();},busy,'filled'));
        pane.append(message);
      }
      if(hasPane(seat)&&['waiting','shell','unconfirmed'].includes(state)){const terminalPane=seat.paneId;const message=node('section','wb-starter-message');const words=state==='shell'?`No agent is running in @${seat.handle}'s terminal. Open the terminal to start it, or set up your agents.`:state==='unconfirmed'?`Couldn't tell what's running in @${seat.handle}'s terminal. Open it to take a look.`:seat.prompt==='unknown'?`@${seat.handle} is waiting for an answer. Open its terminal to reply, then it carries on.`:`@${seat.handle} is ${seat.label||'waiting at a CLI prompt'}. Open its terminal to answer, then it carries on.`;message.append(node('p','',words),button('Open terminal',()=>{const current=value?.seats?.find(s=>s.id===seat.id);if(!destroyed&&paintEpoch===epoch&&shownId&&hasPane(current)&&current.paneId===terminalPane)onTerminal(current);},busy,'filled'));pane.append(message);}
    }
    const due=(value.seats||[]).filter(s=>s.state==='unknown').map(s=>checks.get(s.id)?.since+10000-now()).filter(ms=>ms>0);if(due.length){const mine=epoch;checkTimer=setTimeout(()=>{if(!destroyed&&mine===epoch)paint();},Math.min(...due));}
    const lead=(value.seats||[]).find(s=>s.id===value.leadId),team=node('div','wb-starter-team');
    const leadReady=lead?.state==='ready';
    team.append(node('p','',leadReady?`@${lead.handle} is ready.`:'Start team is available once the lead is ready.'));
    team.append(button('Start team',()=>perform('startTeam',{template:value.template}),busy||!leadReady));pane.append(team);mount.append(pane);
  }
  async function refresh(){if(!shownId||!value?.template||destroyed)return;const mine=epoch;
    try{const r=await api.status({template:value.template});if(!destroyed&&mine===epoch){accept({...r,template:value.template});if(r?.error&&r.leadId&&r.code!=='vendor-missing')refusals.set(r.leadId,r.error);paint();}}
    catch(e){if(!destroyed&&mine===epoch){value=null;paint();error(e);}}
  }
  function poll(){clearTimeout(timer);if(destroyed||!shownId||!value)return;const mine=epoch;timer=setTimeout(async()=>{await refresh();if(!destroyed&&mine===epoch)poll();},2500);}
  async function shown(roomId){if(destroyed||roomId===shownId)return;shownId=roomId||null;busy=false;const mine=++epoch;clearTimeout(timer);clearTimeout(checkTimer);checks.clear();missingSeats.clear();value=null;refusals.clear();paint();if(!shownId||!api)return;
    try{const r=await api.openRoom({roomId});if(!destroyed&&mine===epoch){if(r?.roomId){accept(r);if(r.error&&r.code!=='vendor-missing')error(r,r.leadId);paint();poll();}else if(r?.error)error(r);}}
    catch(e){if(!destroyed&&mine===epoch)error(e);}}
  function summary(template,plannedCount,plannedLead){
    const ref=references[template],views=Array.isArray(gridOptions.rooms)?gridOptions.rooms:[];
    const root=views.find(v=>v?.room?.id===ref?.room_id),children=views.filter(v=>v?.room?.parent_id===ref?.room_id).map(v=>v.room.id);
    const ids=ref?[ref.room_id,...new Set([...Object.values(ref.groups),...children,...(root?.family?.workgroups||[]).map(g=>g.id)])]:[];
    const found=ids.map(id=>views.filter(v=>v?.room?.id===id));
    if(gridOptions.fresh===false||ids.some(id=>gridOptions.disconnectedIds?.has(id))||!ref||new Set(ids).size!==ids.length||found.some(v=>v.length!==1||!Array.isArray(v[0].seats)))return `${plannedCount} seats · lead @${plannedLead}`;
    const rooms=found.map(v=>v[0]);if(rooms.slice(1).some(v=>v.room.parent_id!==ref.room_id))return `${plannedCount} seats · lead @${plannedLead}`;
    const seats=rooms.flatMap(v=>v.seats.filter(s=>!s.left_at)),lead=seats.find(s=>s.id===rooms[0].room.lead_seat);
    const known=new Set(seats.map(s=>s.id)).size===seats.length&&seats.every(s=>['live','parked','starting','never-started','empty','ended','dehydrated'].includes(s.status));
    const live=seats.filter(s=>['live','parked'].includes(s.status)).length;
    return `${seats.length} seats · ${lead?'lead @'+lead.handle:'no lead'}${known?' · '+(live?live+' live':'none live'):''}`;
  }
  function setHidden(next,announce=false){
    if(destroyed||typeof next!=='boolean')return false;
    try{if(!store?.setItem)throw Error();store.setItem(hideKey,String(next));hidden=next;onVisibilityChange();clearTimeout(undoTimer);undoTimer=null;undoPending=announce&&next;
      if(undoPending){
        snackbar('Starter rooms hidden. Bring them back in Settings.',{ms:12000,action:{label:'Undo',fn:()=>setHidden(false)}});
        undoTimer=setTimeout(()=>{undoTimer=null;if(destroyed)return;undoPending=false;if(gridNode)paintGrid();onGridChange();},12000);
      }
      if(gridNode)paintGrid();onGridChange();return true;
    }catch{snackbar("Couldn't save this preference. Try again.");return false;}
  }
  function visibilityChanged(event){if(event?.key!==hideKey||destroyed)return;try{hidden=store?.getItem(hideKey)==='true';onVisibilityChange();clearTimeout(undoTimer);undoTimer=null;undoPending=false;if(gridNode)paintGrid();onGridChange();}catch{}}
  globalThis.addEventListener?.('storage',visibilityChanged);

  function paintGrid(){
    const section=gridNode;section.replaceChildren();section.hidden=!api||(hidden&&!gridOptions.showHidden&&undoPending);if(section.hidden)return;
    if(hidden&&!gridOptions.showHidden){
      const note=node('p','wb-starter-recovery','Starter rooms are hidden. You can show them again in ');
      if(typeof onSettings==='function'){
        const link=node('a','wb-starter-quiet','Settings › Workrooms');link.setAttribute('href','#settings-workrooms');
        link.addEventListener('click',event=>{event?.preventDefault();if(!destroyed&&hidden)onSettings();});note.append(link,node('span','','.'));
      }else note.append(node('span','','Settings › Workrooms.'));
      section.append(note);return;
    }
    if(!hidden||gridOptions.showHidden)for(const [template,title,words,count,lead]of [['my-first-room','My first room','A room to get started. Ask the lead anything. The builder can try things for you.',2,'planner'],['my-project','My project','One project, four groups: plan it, design it, build it, test it. Talk to the lead, or go straight to a group.',11,'project-lead']]){
      const ref=references[template];if(!gridOptions.showHidden&&ref&&gridOptions.hiddenIds?.has(ref.room_id))continue;
      const card=node('article','wb-starter-card'),known=gridOptions.rooms?.find(v=>v.room?.id===ref?.room_id);
      if(known?.room?.state&&known.room.state!=='open')continue;
      card.append(node('h2','',known?.room?.name||title),node('p','',words),node('p','wb-starter-meta',summary(template,count,lead)));
      if(template==='my-project'){const chips=node('div','wb-starter-groups');for(const name of ['Plan','Design','Build','Test'])chips.append(node('span','wb-starter-chip',name));card.append(chips);}
      card.append(button('Open room',()=>perform('open',{template}),busy));
      if(openFailures.has(template)){const message=node('section','wb-starter-message');message.setAttribute('role','status');message.append(node('p','wb-starter-refusal',openFailures.get(template)));card.append(message);}
      section.append(card);}
    const hide=button('Hide starter rooms',()=>setHidden(true,true));hide.className='wb-starter-quiet';section.append(hide);
  }
  function grid(options={}){gridOptions=options;gridNode=node('section','wb-starter-grid');gridNode.setAttribute('aria-label','Starter workrooms');paintGrid();void loadPreferences();return gridNode;}

  return Object.freeze({grid,hidden:()=>hidden,setHidden:next=>setHidden(next),knownRootIds:()=>Object.values(references).map(r=>r.room_id),roomMount:()=>mount,shown,refresh,destroy(){destroyed=true;epoch++;clearTimeout(undoTimer);clearTimeout(timer);clearTimeout(checkTimer);checks.clear();missingSeats.clear();value=null;refusals.clear();openFailures.clear();gridNode=null;globalThis.removeEventListener?.('storage',visibilityChanged);mount.remove();}});
}
