// Presentation-only views. No template file parser, store, recipe settings,
// role text or engine route lives here.
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(v);
const text=(v,n)=>typeof v==='string'?v.slice(0,n):'';
const count=v=>Number.isSafeInteger(v)&&v>=0&&v<=100000;
const starters=['my-first-room','my-project'];
export function pickerChoices(rows){
 const blank={id:'blank',kind:'blank',name:'Blank room',brief:'Just a room. Add agents later.',seats:0,teams:0,createdAt:0};
 if(!Array.isArray(rows)||rows.length>500)return [blank];
 const seen=new Map();for(const row of rows)if(id(row?.id))seen.set(row.id,(seen.get(row.id)||0)+1);
 const safe=rows.filter(r=>r&&id(r.id)&&r.id!=='blank'&&seen.get(r.id)===1&&typeof r.name==='string'&&r.name.trim()&&count(r.seats)&&count(r.teams)&&
  ((r.kind==='starter'&&starters.includes(r.id))||(r.kind==='user'&&!starters.includes(r.id))))
 .map(r=>({id:r.id,kind:r.kind,name:text(r.name,120),brief:text(r.brief,1000).split(/\r?\n/)[0],seats:r.seats,teams:r.teams,createdAt:Number.isFinite(r.createdAt)?r.createdAt:0}));
 safe.sort((a,b)=>a.kind==='starter'?(b.kind==='starter'?starters.indexOf(a.id)-starters.indexOf(b.id):-1):b.kind==='starter'?1:b.createdAt-a.createdAt||a.id.localeCompare(b.id));
 return [blank,...safe];
}
export function saveSummary(source,selected){
 const invalid={ok:false,seats:0,teams:0,error:null};
 if(!source||!count(source.baseSeats)||!Array.isArray(source.teams)||source.teams.length>500||!Array.isArray(selected)||new Set(selected).size!==selected.length)return invalid;
 const ids=new Set();for(const team of source.teams){if(!team||!id(team.id)||ids.has(team.id)||!count(team.seats))return invalid;ids.add(team.id);}
 if(selected.some(key=>!ids.has(key)))return invalid;
 const seats=source.baseSeats+source.teams.filter(t=>selected.includes(t.id)).reduce((sum,t)=>sum+t.seats,0),teams=selected.length;
 const error=seats>50?`This room has ${seats} seats. A template can hold up to 50.`:teams>10?`This room has ${teams} teams. A template can hold up to 10.`:'';
 return {ok:!error,seats,teams,error};
}
export function templateFailure(result){
 if(result?.code==='unavailable')return "Couldn't check your templates. Close this and try again.";
 if(result?.code==='forbidden')return 'Only the person who made this room can save it as a template.';
 if(result?.code==='held')return 'A save is still unconfirmed. Check Your templates, then discard it to try again.';
 if(result?.code==='missing_recipe'){
  const key=v=>typeof v==='string'&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v)&&v.length<=64;
  if(key(result.recipe))return `This template needs a recipe you don't have: ${result.recipe}. Nothing was created.`;
  const list=result.recipes;
  if(Array.isArray(list)&&list.length&&list.length<=50&&list.every(key)&&new Set(list).size===list.length){
   if(list.length===1)return `This template needs a recipe you don't have: ${list[0]}. Nothing was created.`;
   return `This template needs recipes you don't have: ${list.slice(0,-1).join(', ')} and ${list.at(-1)}. Nothing was created.`;
  }
  return (globalThis.wb&&globalThis.wb.web?"A recipe this template needs isn't on this server. Nothing was created.":"A recipe this template needs isn't on this computer. Nothing was created.");
 }
 if(result?.code==='unsupported_format')return 'This template was made by a newer Workbench. Update Workbench and try again.';
 if(result?.code==='refused'&&result.unchanged===true)return "Couldn't create the room. Nothing was changed. Try again in a moment.";
 // Lost replies are not proof of rollback. The host must hold the operation;
 // no retry or success/failure copy is invented for an unapproved state.
 return null;
}
export function createdSummary(view){
 if(!view||!Array.isArray(view.notApplied)||!['existing','new','none'].includes(view.folder)||view.notApplied.some(k=>!['permission','tools','roomLead'].includes(k)))return null;
 const names=view.toolNames;
 if(view.notApplied.includes('tools')&&(!Array.isArray(names)||!names.length||names.length>128||names.some(n=>typeof n!=='string'||!n.trim()||n.length>120)))return null;
 const lines=[];
 if(view.notApplied.includes('permission'))lines.push("The permission level wasn't set. The room starts at Ask me; change it in the room's settings.");
 if(view.notApplied.includes('tools'))lines.push(`These tools aren't available here: ${names.join(', ')}. The room works without them.`);
 if(view.notApplied.includes('roomLead'))lines.push("The room has no lead yet. Choose one in the room's settings.");
 return {title:`Room created from “${text(view.templateName,120)}”. A few things weren't set up:`,lines,folder:view.folder};
}
