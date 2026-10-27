import {serverFolder} from './policy.mjs';
const invalid=()=>{throw {code:'settings-unconfirmed'};};
const text=v=>typeof v==='string'&&v.length>0&&v.length<=200&&!/[\x00-\x1f]/.test(v);
const vendors=new Set(['claude-code','codex-cli','gemini-cli']);
function setup(value){
 if(!value||(value.completedAt!==null&&!(Number.isFinite(value.completedAt)&&value.completedAt>=0))||(value.defaultFolder!==null&&!serverFolder(value.defaultFolder)))invalid();
 return {completedAt:value.completedAt,defaultFolder:value.defaultFolder};
}
// owner.key is a router-owned authenticated VIEW generation, NOT an account id or
// authorization proof. It is never persisted or sent. The engine enforces person-only
// admission; /rooms/me supplies display text only. Name/handle never identify an owner.
export function createOnboardingAPI({settings,owner,pickFolder,launchRecipe}){
 function scope(options={}){
  const captured=owner();if(captured?.signedIn!==true||!text(captured.key))invalid();
  const current=()=>!options.signal?.aborted&&(!options.current||options.current()===true)&&owner()?.signedIn===true&&owner()?.key===captured.key;
  const check=()=>{if(!current())invalid();};check();return {key:captured.key,check,options:{...options,current}};
 }
 return Object.freeze({
  async readSetup(options){const s=scope(options);const raw=await settings.readSetup(s.options);s.check();const view=setup(raw);const me=await settings.readPersonDisplay(s.options);s.check();if(!me||typeof me!=='object'||Array.isArray(me)||(me.name!=null&&!text(me.name)))invalid();const name=text(me.name)?me.name:text(me.handle)?me.handle:null;return {person:{id:s.key,name},completed:view.completedAt!==null,defaultFolder:view.defaultFolder};},
  async readApproval(options){const s=scope(options);const reply=await settings.readApproval(s.options);s.check();return reply;},
  async writeApproval(body,options){const s=scope(options);const reply=await settings.writeApproval(body,s.options);s.check();return reply;},
  async readAgents(options){const s=scope(options);const reply=await settings.readAgents(s.options);s.check();if(!Array.isArray(reply?.vendors)||reply.vendors.length>3)invalid();const seen=new Set();return reply.vendors.map(row=>{if(!vendors.has(row?.id)||seen.has(row.id)||!text(row.label)||![true,false,null].includes(row.installed))invalid();seen.add(row.id);return {id:row.id,label:row.label,installed:row.installed};});},
  async pickFolder(options){const s=scope(options);const path=await pickFolder(s.options);s.check();if(path===null)return null;if(!serverFolder(path))invalid();return {path};},
  async writeDefaultFolder({path},options){const s=scope(options);if(!serverFolder(path))invalid();const reply=setup(await settings.writeSetup({defaultFolder:path},s.options));s.check();if(reply.defaultFolder!==path)invalid();return {path:reply.defaultFolder};},
  async completeSetup(options){const s=scope(options);const reply=setup(await settings.writeSetup({complete:true},s.options));s.check();if(reply.completedAt===null)invalid();return {completed:true,person:{id:s.key}};},
  async openAgentSignIn(vendor,options){const s=scope(options);if(!vendors.has(vendor))invalid();const reply=await settings.prepareAgentSignIn(vendor,s.options);s.check();if(reply?.recipeId!==`signin-${vendor}`)invalid();
   // No command, initCmd or session input crosses this seam. Existing launch owns the pane.
   const result=await launchRecipe(reply.recipeId,s.options);s.check();if(result?.opened!==true)invalid();return {opened:true};},
 });
}
