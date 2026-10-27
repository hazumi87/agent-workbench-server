// Isolated presentation model. No DOM, paths are strings only, no bridge or launch.
// Vocabulary and slug preview mirror engine <commit>. The engine's
// returned slug remains authoritative; preview is never persisted as typed input.
const efforts=Object.freeze({
 'claude-code':Object.freeze(['','low','medium','high','xhigh','max','ultracode']),
 'codex-cli':Object.freeze(['','low','medium','high','xhigh','max'])
});
const brands=new Set(['claude-code','codex-cli','gemini-cli','ollama']);
const slug=v=>typeof v==='string'?(v.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64).replace(/-+$/g,'')||null):null;
const basename=v=>typeof v==='string'?v.split(String.fromCharCode(92)).join('/').replace(/\/+$/,'').split('/').at(-1):null;
export function effortChoices(vendor){return [...(efforts[vendor]||[])];}
export function createParityDraft(recipe,{enabled=false}={}){
 if(enabled!==true)return null;
 return {programId:recipe.programId,folder:recipe.folder,name:recipe.name,
  options:{...recipe.options},agent:recipe.agent??'',fontSize:recipe.fontSize??null,
  logo:recipe.logo??null,worktree:recipe.worktree??(recipe.importWorktree==='auto'?'auto':'never')};
}
export function slugPreview(draft){
 const typed=slug(draft.agent),folder=slug(basename(draft.folder));
 const brand=brands.has(draft.programId);
 if(typed&&(brand||!folder||(typed!==folder&&typed!==slug(folder+'-cli'))))return typed;
 return brand?(folder??slug(draft.name)):null;
}
export function changeParityVendor(draft,programId){
 const choices=effortChoices(programId),effort=draft.options?.effort;
 const effortReset=!!effort&&!choices.includes(effort);
 return {draft:{...draft,programId,options:{...draft.options,...(effortReset?{effort:''}:{})}},effortReset};
}
export function parityPatch(draft){
 if(!draft)return {error:'Recipe options are not available in this build yet.'};
 if(!['auto','never'].includes(draft.worktree))return {error:'This worktree option is not available yet.'};
 const raw=draft.fontSize;
 const fontSize=raw==null||raw===''?null:typeof raw==='number'?raw:typeof raw==='string'&&/^\d+$/.test(raw)?Number(raw):NaN;
 if(fontSize!==null&&(!Number.isInteger(fontSize)||fontSize<8||fontSize>32))return {error:'Choose a terminal font size from 8 to 32, or use the default.'};
 const effort=draft.options?.effort;
 if(effort!=null&&effort!==''&&!effortChoices(draft.programId).includes(effort))return {error:'Choose an effort supported by this program.'};
 // Null is the engine's automatic-slug request. Do not freeze the preview into
 // a manual value, or later folder edits would retain the old generated slug.
 return {agent:slug(draft.agent),fontSize,logo:draft.logo??null,
  worktree:draft.worktree,options:{...draft.options}};
}
