// Room colors are personal automatic choices, separate from the shared room.color.
// The pushed engine has no roomColors field: runtime uses the local backend. The
// optional engine backend is injected and tested without enabling unpushed routes.
import { Hct, argbFromHex } from '../../vendor/m3/mcu-0.4.0.js';

export const ROOM_SWATCHES = Object.freeze(['#2E7D32', '#2B7A8C', '#2A5DA8', '#6B4EA2', '#A23B4F', '#C2185B', '#E8692C', '#C98A10', '#5B7B2E', '#00796B', '#5D4037', '#546E7A']);
const TOOL_SEEDS = ['#428DF0', '#45D379', '#E967E9', '#A96CEF', '#FA9338'];
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const own = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
const validSeed = s => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);
const validMap = value => {
  const out={};
  if (!value || typeof value!=='object' || Array.isArray(value)) return out;
  for(const [id,index] of Object.entries(value)) if(ID.test(id) && id!=='__proto__' && Number.isInteger(index) && index>=0 && index<ROOM_SWATCHES.length) out[id]=index;
  return out;
};
const hue = seed => Hct.fromInt(argbFromHex(seed)).hue;
const distance = (a,b) => Math.min(Math.abs(a-b),360-Math.abs(a-b));
// Leave a perceptible hue neighborhood for the five tool identities. Explicit
// person-picked colors are never constrained by this automatic-choice policy.
const eligible = ROOM_SWATCHES.filter(seed=>TOOL_SEEDS.every(tool=>distance(hue(seed),hue(tool))>=18));
export const eligibleRoomSwatches = () => [...eligible];

export function createLocalRoomColorStore({storage=globalThis.localStorage,accountId=null}={}) {
  const key='wb.roomcolors.v1:'+encodeURIComponent(accountId||'local');
  let memory={};
  const read=()=>{try{memory={...memory,...validMap(JSON.parse(storage?.getItem(key)||'{}'))};}catch{}return memory;};
  const save=()=>{try{storage?.setItem(key,JSON.stringify(memory));}catch{}};
  return Object.freeze({read:()=>({...read()}),assignMissing(values){read();for(const [id,index]of Object.entries(validMap(values)))if(!own(memory,id))memory[id]=index;save();return {...memory};},
    adopt(values){read();Object.assign(memory,validMap(values));save();return {...memory};}});
}
export function createRoomColors(options={}) {
  const local=createLocalRoomColorStore(options);
  return Object.freeze({
    seed(room,used=[]){
      if(validSeed(room?.color))return room.color;
      const id=room?.id;
      if(typeof id!=='string'||!ID.test(id)||id==='__proto__')return eligible[0];
      const map=local.read();
      if(own(map,id))return ROOM_SWATCHES[map[id]];
      const currentSeeds=used.map(value=>{
        if(validSeed(value))return value;
        const visible=value?.room||value;
        return validSeed(visible?.color)?visible.color:own(map,visible?.id)?ROOM_SWATCHES[map[visible.id]]:null;
      });
      const usedSeeds=new Set(currentSeeds.filter(validSeed).map(s=>s.toUpperCase()));
      const seed=eligible.find(s=>!usedSeeds.has(s.toUpperCase()))||eligible[0];
      // Re-read at the write boundary: another window may have assigned this key.
      const final=local.assignMissing({[id]:ROOM_SWATCHES.indexOf(seed)});
      return ROOM_SWATCHES[final[id]];
    },
    read:local.read,
    async sync(backend){const authoritative=await backend.assignMissing(local.read());if(authoritative!==null)local.adopt(authoritative);return local.read();},
  });
}

// Identity fallbacks are personal preferences, separate from room assignments.
export function seatSeedForHandle(handle) {
  let hash=0;
  for(const ch of String(handle||'').replace(/^@/,'').toLowerCase())hash=(hash*31+ch.charCodeAt(0))>>>0;
  return ROOM_SWATCHES[hash%ROOM_SWATCHES.length];
}
export function createPersonColors({storage=globalThis.localStorage,accountId=null}={}) {
  const key='wb.personcolor.v1:'+encodeURIComponent(accountId||'local');let index=null;
  return Object.freeze({seed(explicit,used=[]){
    if(validSeed(explicit))return explicit;
    try{const value=JSON.parse(storage?.getItem(key)||'null');if(Number.isInteger(value)&&value>=0&&value<ROOM_SWATCHES.length)index=value;}catch{}
    if(index===null){const taken=new Set(used.filter(validSeed).map(c=>c.toUpperCase()));index=ROOM_SWATCHES.findIndex(c=>!taken.has(c.toUpperCase()));if(index<0)index=0;try{storage?.setItem(key,JSON.stringify(index));}catch{}}
    return ROOM_SWATCHES[index];
  }});
}

// A room is one pane; the host explicitly pins system controls and message
// content to their own palettes. Menus/dialogs use the window palette snapshot.
// Every identity seed follows the person's live Style and Contrast.
export function createRoomPainter(m3) {
  const people=new Map();
  return Object.freeze({
    seedForHandle: seatSeedForHandle,
    seedForHue: hue=>m3.seedOfHue(hue),
    defaultSeed(accountId,used=[]){const key=accountId||'local';if(!people.has(key))people.set(key,createPersonColors({accountId}));return people.get(key).seed(null,used);},
    apply(el,seed){if(!el||!validSeed(seed))return;el.dataset.roomPalette='true';el.dataset.roomSeed=seed;m3.applyTo(el,seed,m3.get().style);},
    system(el){if(!el)return;delete el.dataset.roomPalette;delete el.dataset.roomSeed;const s=m3.get();m3.applyTo(el,s.color,m3.windowStyleFor(s.color,s.style));},
  });
}

/** Future engine backend, bound by its caller to one account/engine generation.
 * Read/assign-only-missing/PATCH-only-those/re-read: the final engine value wins.
 * No runtime caller enables it until the engine contract is in a pushed build.
 */
export function createEngineRoomColorStore({read,patch,current=()=>false}) {
  async function readMap(){
    if(!current())return null;
    try{const r=await read();if(!current()||!r||!own(r,'roomColors')||!r.roomColors||typeof r.roomColors!=='object'||Array.isArray(r.roomColors))return null;return validMap(r.roomColors);}catch{return null;}
  }
  return Object.freeze({
    read:readMap,
    async assignMissing(values){
      const existing=await readMap();if(existing===null||!current())return null;
      const additions={};
      for(const [id,value]of Object.entries(validMap(values)))if(!own(existing,id)&&Object.keys(existing).length+Object.keys(additions).length<200)additions[id]=value;
      if(Object.keys(additions).length){try{await patch({roomColors:additions});}catch{return null;}if(!current())return null;}
      return readMap();
    },
  });
}
