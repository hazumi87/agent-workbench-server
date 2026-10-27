'use strict';
// Pure recipe-pack policy. No I/O, launch, logging or evaluation.
const {uniqueName}=require('./recipes');
const {validRaster}=require('./recipe-import-image');
const MAX_BYTES=2*1024*1024,MAX_ROWS=200;
const allowed=new Set(['id','name','target','projectDir','vendor','model','effort','vendorArgs','vendorFlags','color','logo','worktree','changes','runClaude']);
const reason='Needs a server connection, which this version does not have';
const PERMISSION_FLAGS=Object.freeze({'network':{label:'Network access in the sandbox',widensPermissions:true},'auto-review':{label:'Auto-review approvals',widensPermissions:true}});
const MODELS={'claude-code':['opus','sonnet','fable'],'codex-cli':['gpt-6-astra','gpt-6.1-sol','gpt-6-sol','gpt-6-luna','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-5.5'],'gemini-cli':['pro','flash','flash-lite']};
const EFFORTS={'claude-code':['low','medium','high','xhigh','max','ultracode'],'codex-cli':['low','medium','high','xhigh','max']};
const vendors=new Set(['cli-manager','claude-code','codex-cli','gemini-cli','ollama']);
const clean=(s,n=300)=>typeof s==='string'?s.replace(/[\u0000-\u001f]/g,'').slice(0,n):'';
function fail(){throw Error("This isn't a recipes file Agent Workbench can read.");}
function findSecrets(obj,path='',depth=0,out=[]){
 if(depth>8)fail();
 for(const [k,v]of Object.entries(obj||{})){
  const field=(path?path+'.':'')+clean(k,60);
  if(/token|password|secret|api.?key|authorization/i.test(k))out.push({field,trigger:'name'});
  if(typeof v==='string'&&/(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{12,}|(?:password|token|api[_-]?key)\s*=)/i.test(v))out.push({field,trigger:'value'});
  if(v&&typeof v==='object')findSecrets(v,field,depth+1,out);
 }
 return [...new Map(out.map(f=>[f.field+'|'+f.trigger,f])).values()].slice(0,80);
}
function secrets(obj){return [...new Set(findSecrets(obj).map(f=>f.field))].slice(0,40);}
function isLocalFolder(folder,platform=process.platform){if(!folder||folder==='~')return true;if(/^(?:\\\\|\/\/|[A-Za-z][A-Za-z0-9+.-]*:\/\/)/.test(folder))return false;return platform!=='win32'||/^[A-Za-z]:[\\/]/.test(folder);}
function args(value){if(value==null)return [];if(!Array.isArray(value)||value.length>32||value.some(x=>typeof x!=='string'||x.length>500))fail();return value.map(x=>clean(x,500));}
function parsePack(text,options){return parsePackDocument(text,options).rows;}
function parsePackDocument(text,{platform='win32',folderExists=()=>false,names=[]}={}){
 if(typeof text!=='string')fail();if(Buffer.byteLength(text)>MAX_BYTES)throw Error('This file is too large to import. The limit is 2 MB.');const json=text.startsWith("\ufeff")?text.slice(1):text;if(json.includes("\ufeff"))fail();let pack;try{pack=JSON.parse(json);}catch{fail();}
 if(pack?.version>1)throw Error('This file is from a newer version of Agent Workbench. Update, then try again.');if(!pack||pack.version!==1||!Array.isArray(pack.recipes))fail();if(pack.recipes.length>MAX_ROWS)throw Error('This file has more than 200 recipes. Split it, then try again.');
 const topFindings=findSecrets(Object.fromEntries(Object.entries(pack).filter(([k])=>k!=='recipes'))).map(f=>({...f,field:'file.'+f.field}));const topSecrets=topFindings.map(f=>f.field);
 const taken=[...names];const rows=pack.recipes.map((raw,index)=>{
  if(!raw||Array.isArray(raw)||typeof raw!=='object'||typeof raw.name!=='string'||!raw.name.trim()||!vendors.has(raw.vendor)||typeof raw.target!=='string'||raw.target.length>100)fail();
  for(const key of ['projectDir','model','effort'])if(raw[key]!=null&&typeof raw[key]!=='string')fail();
  const changes=Object.keys(raw).filter(k=>!allowed.has(k)).map(k=>'Dropped '+clean(k,60));
  if(raw.changes!=null){if(!Array.isArray(raw.changes)||raw.changes.length>80||raw.changes.some(x=>typeof x!=='string'||x.length>300))fail();changes.push(...raw.changes.map(x=>clean(x)));}
  const originalName=clean(raw.name.trim(),60),name=uniqueName(originalName,taken);taken.push(name);if(name!==originalName)changes.push('Renamed to '+name);
  const sourceTarget=clean(raw.target,100),local=sourceTarget==='local';if(!local)changes.push(reason);
  let folder=clean(raw.projectDir);if(folder&&(!isLocalFolder(folder,platform)||!folderExists(folder))){changes.push('Starting folder cleared; choose a folder or use home');folder='';}
  const vendorFlags=args(raw.vendorFlags),rawArgs=args(raw.vendorArgs),vendorArgs=raw.vendor==='cli-manager'?[]:rawArgs;if(raw.vendor==='cli-manager'&&rawArgs.length)changes.push('Dropped vendorArgs');if(vendorFlags.some(x=>raw.vendor!=='codex-cli'||!Object.hasOwn(PERMISSION_FLAGS,x)))throw Error('This recipe uses a program option this version does not support.');if(vendorFlags.some(x=>x.length>80)||vendorArgs.map(a=>JSON.stringify(a)).join(' ').length>500)fail();let logoRaw=null;
  if(raw.logo!=null){if(typeof raw.logo==='string'&&Buffer.byteLength(raw.logo)<=65536){try{const logo=JSON.parse(raw.logo);if(logo&&typeof logo==='object'&&(typeof logo.svg==='string'||typeof logo.dataUrl==='string'))logoRaw=raw.logo;else changes.push('Dropped unsupported logo');}catch{changes.push('Dropped invalid logo');}}else changes.push('Dropped oversized logo');}
  const model=(MODELS[raw.vendor]||[]).includes(raw.model)?raw.model:'';const effort=(EFFORTS[raw.vendor]||[]).includes(raw.effort)?raw.effort:'';if(raw.model&&!model)changes.push('Dropped unsupported model');if(raw.effort&&!effort)changes.push('Dropped unsupported effort');const worktree=['auto','never'].includes(raw.worktree)?raw.worktree:'never';if(raw.worktree&&!['auto','never'].includes(raw.worktree))changes.push('Dropped unsupported worktree mode');
  const fields=secrets(raw),argumentPreview=rawArgs.map((arg,i)=>fields.includes('vendorArgs.'+i)?'(hidden)':arg).join(' ');
  const launchOptions=[];if(raw.vendor==='cli-manager'&&(rawArgs.length||raw.initCmd||raw.changes?.includes('initCmd')))launchOptions.push("Not copied: program arguments, setup command. Shell recipes don't take those from a file.");else if(rawArgs.length)launchOptions.push('This recipe passes options to the program: '+argumentPreview+'. Check them before you add it.');const settings=[];if(model)settings.push('model '+model);if(effort)settings.push('effort '+effort);if(raw.worktree&&['auto','never'].includes(raw.worktree))settings.push('worktree '+(worktree==='auto'?'automatic':'never'));if(settings.length)launchOptions.push('Settings kept: '+settings.join(', ')+'.');if(vendorFlags.length)launchOptions.push('Permission options kept: '+vendorFlags.map(f=>PERMISSION_FLAGS[f].label).join(', ')+'.');
  if(raw.initCmd)changes.push('A start command written for another machine will not run on this server.');
  return {index,name,originalName,sourceTarget,folder,programId:raw.vendor==='cli-manager'?'shell':raw.vendor,programLabel:({'cli-manager':'Shell','claude-code':'Claude Code','codex-cli':'Codex','gemini-cli':'Gemini','ollama':'Ollama'})[raw.vendor],model,effort,vendorFlags,vendorArgs,logoRaw,color:typeof raw.color==='string'?clean(raw.color,40):null,worktree,changes,secretFields:[...topSecrets,...secrets(raw)],secretFindings:[...topFindings,...findSecrets(raw)],argumentPreview,launchOptions,requiresOptionsAck:rawArgs.length>0,permissionFlags:vendorFlags.filter(f=>PERMISSION_FLAGS[f]?.widensPermissions),permissionLabels:vendorFlags.filter(f=>PERMISSION_FLAGS[f]?.widensPermissions).map(f=>PERMISSION_FLAGS[f].label),selected:local&&!raw.initCmd&&!rawArgs.length};
 });
 const droppedFields=Array.isArray(pack.dropped)?pack.dropped.slice(0,80).map(x=>typeof x?.field==='string'?x.field.replace(/[\u0000-\u001f]/g,'').slice(0,60):'').filter(Boolean):[];
 return {rows,droppedFields};
}
function colorHue(hex){if(!/^#[0-9a-f]{6}$/i.test(hex||''))return 'auto';const [r,g,b]=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255),hi=Math.max(r,g,b),lo=Math.min(r,g,b),d=hi-lo;if(!d)return 0;return Math.round(((hi===r?(g-b)/d+(g<b?6:0):hi===g?(b-r)/d+2:(r-g)/d+4)*60)%360);}
function blockedReason(recipe){return recipe?.unavailableTarget?`${recipe.name||'This recipe'} needs a server connection, which this version does not have, so it can't start.`:null;}
function commitSelection(rows,selections,{folderExists=()=>false,platform=process.platform,acceptSecrets=false,acceptPermissions=false}={}){
 if(!Array.isArray(selections)||selections.length>MAX_ROWS||selections.some(s=>!s||typeof s!=='object'||Array.isArray(s)||typeof s.selected!=='boolean'||!Number.isInteger(s.index)||!rows[s.index])||new Set(selections.map(s=>s.index)).size!==selections.length)fail();const seen=new Set();
 return selections.filter(s=>s?.selected===true).map(s=>{
  if(!Number.isInteger(s.index)||!rows[s.index]||seen.has(s.index))fail();seen.add(s.index);const row=rows[s.index];
  if(row.requiresOptionsAck&&s.acceptOptions!==true)throw Error('Review the program options before importing this recipe.');
  if(row.permissionFlags.length&&!acceptPermissions)throw Error('Review the Codex permission options before importing.');
  if(row.secretFields.length&&!acceptSecrets)throw Error('Review the secret-field warning before importing.');
  if(!['local','keep'].includes(s.target))fail();const unavailableTarget=s.target==='keep'&&row.sourceTarget!=='local'?row.sourceTarget:null;
  if(unavailableTarget&&!s.acceptUnavailable)throw Error('Confirm that this server recipe will not start.');
  if(typeof s.folder!=='string'||s.folder.length>300)fail();const folder=s.folder.trim();if(folder&&folder!=='~'&&(!isLocalFolder(folder,platform)||!folderExists(folder)))throw Error('Choose an existing folder or leave it empty to use home.');
  const logo=validRaster(s.logo);
  return {name:row.name,loginId:'local',serverId:'local',where:unavailableTarget||'This computer',folder:folder||'~',programId:row.programId,programLabel:row.programLabel,command:'',options:{model:row.model,effort:row.effort,extraArgs:row.vendorArgs.map(a=>JSON.stringify(a)).join(' ')},vendorFlags:row.vendorFlags,vendorArgs:row.vendorArgs,unavailableTarget,logo,color:colorHue(row.color),importColor:row.color,importWorktree:row.worktree};
 });
}
// Mirrors the engine's typed vendor-flags catalogue; explicit extra args remain last.
function recipeArgs(r,split,includeFlags=false){const args=Array.isArray(r.vendorArgs)?r.vendorArgs.slice():split(r.options?.extraArgs||'');if(!includeFlags||r.programId!=='codex-cli')return args;const flags=[];if(r.vendorFlags?.includes('network'))flags.push('-c','sandbox_workspace_write.network_access=true');if(r.vendorFlags?.includes('auto-review'))flags.push('-c','approvals_reviewer="auto_review"');return flags.concat(args);}
module.exports={isLocalFolder,PERMISSION_FLAGS,recipeArgs,parsePack,parsePackDocument,commitSelection,blockedReason,validRaster,MAX_BYTES,MAX_ROWS};
