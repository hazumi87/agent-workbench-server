import {hwbRing,hwbRingFromChrome,hwbRingApplyContext} from '../../vendor/aurora/window-chrome/hwb-ring.js';
const STATE = Object.freeze({'needs-you':'waiting',working:'busy',background:'background',idle:'idle'});
export const ROOM_ACTIVITY_SIZE = 17;
export const TEAM_ACTIVITY_SIZE = 12;
const COUNTS = ['needs_you','working','background','idle'];
/** Validate the engine's answer; never repair it or infer it from seats/prose. */
export function roomActivity(value,name) {
  if(!value||typeof value!=='object'||Array.isArray(value)||!['none',...Object.keys(STATE)].includes(value.state))return null;
  if(!['live',...COUNTS].every(key=>Number.isSafeInteger(value[key])&&value[key]>=0))return null;
  const sum=COUNTS.reduce((n,key)=>n+value[key],0);
  if(!Number.isSafeInteger(sum)||sum!==value.live)return null;
  if(value.state==='none' ? value.live!==0 : value.live===0)return null;
  const loudest = value.needs_you ? 'needs-you' : value.working ? 'working' : value.background ? 'background' : value.idle ? 'idle' : 'none';
  if(value.state !== loudest)return null;
  const room=typeof name==='string'&&name.trim()?name.trim().slice(0,160):'Room';
  const plural=n=>n===1?'seat':'seats';
  if(value.state==='none')return Object.freeze({state:'none',label:room+': no live seats',description:null,spec:null});
  const count=value.state==='needs-you'?`${value.needs_you} ${plural(value.needs_you)} ${value.needs_you===1?'is':'are'} waiting on you`
    :value.state==='working'?`${value.working} of ${value.live} ${plural(value.live)} busy`:`${value.live} ${plural(value.live)}`;
  return Object.freeze({state:value.state,label:`${room}: ${value.state==='needs-you'?'needs you':value.state} — ${count}`,description:value.state==='idle'?null:`${value.state==='needs-you'?'needs you':value.state} — ${count}`,announcement:value.state==='needs-you'?`${room} needs you.`:null,spec:hwbRingFromChrome(STATE[value.state])});
}
/** One fresh rail plate per paint; no timers, listeners, owner state or requests. */
export function decorateRoomActivity(plate,value,name,{size=ROOM_ACTIVITY_SIZE,connected=true}={}) {
  if(!plate||!connected)return null;
  const info=roomActivity(value,name);if(!info)return null;
  plate.title=info.label;plate.removeAttribute('role');plate.setAttribute('aria-hidden','true');plate.removeAttribute('aria-label');
  if(!info.spec)return {...info,glyph:null};
  const inset=document.createElement('span');inset.className='ra-room-chip';inset.setAttribute('aria-hidden','true');
  const glyph=document.createElement('span');hwbRing(glyph,info.spec,size===TEAM_ACTIVITY_SIZE?TEAM_ACTIVITY_SIZE:ROOM_ACTIVITY_SIZE);glyph.setAttribute('aria-hidden','true');
  inset.appendChild(glyph);plate.appendChild(inset);plate.classList.add('ra-room-active');return {...info,glyph};
}
export function applyRoomActivityContext(container,items) {
  const active=items.filter(item=>item?.glyph&&item.spec);
  return hwbRingApplyContext(container,active.map(item=>item.glyph),active.map(item=>item.spec));
}
// One page's visible rollups only. This tracks transitions, never seat state.
export function createRoomActivityAnnouncements() {
  let owner=null,previous=new Map();
  const reset=()=>{owner=null;previous=new Map()};
  return Object.freeze({reset,observe({scope,shown,entries}={}){
    if(!shown||typeof scope!=='string'||!Array.isArray(entries)||entries.length>4096){reset();return {text:null,clear:true};}
    const fresh=scope!==owner,prior=fresh?new Map():previous,next=new Map(),messages=[];
    for(const entry of entries){
      const activity=entry?.activity;
      if(typeof entry?.id!=='string'||entry.id.length>512||!activity||!['none',...Object.keys(STATE)].includes(activity.state))continue;
      next.set(entry.id,activity.state);
      if(prior.has(entry.id)&&prior.get(entry.id)!=='needs-you'&&activity.state==='needs-you'&&typeof activity.announcement==='string'&&activity.announcement.length<=220)messages.push(activity.announcement);
    }
    const clear=fresh||[...prior].some(([id,state])=>state==='needs-you'&&next.get(id)!=='needs-you');
    owner=scope;previous=next;
    return {text:messages.length?messages.join(' '):null,clear};
  }});
}
