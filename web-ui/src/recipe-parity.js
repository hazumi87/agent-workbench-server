'use strict';
// Pinned engine vocabulary (<commit>). Pure recipe metadata only;
// no launch flags, permissions, path picker or terminal preferences here.
const EFFORTS=Object.freeze({
 'claude-code':Object.freeze(['low','medium','high','xhigh','max','ultracode']),
 'codex-cli':Object.freeze(['low','medium','high','xhigh','max'])
});
function normalizeAgent(value){return typeof value==='string'?(value.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64).replace(/-+$/g,'')||null):null;}
function normalizeFont(value){return Number.isInteger(value)&&value>=8&&value<=32?value:null;}
function worktreeOf(recipe){return recipe.worktree!==undefined?recipe.worktree:recipe.importWorktree==='auto'?'auto':'never';}
function validateParity(recipe){
 if(!['auto','never'].includes(worktreeOf(recipe)))return 'This worktree option is not available yet.';
 if(recipe.fontSize!=null&&normalizeFont(recipe.fontSize)===null)return 'Choose a terminal font size from 8 to 32, or use the default.';
 if(recipe.agent!=null&&typeof recipe.agent!=='string')return 'Enter an agent slug.';
 const effort=recipe.options?.effort;
 if(effort!=null&&effort!==''&&!(EFFORTS[recipe.programId]||[]).includes(effort))return 'Choose an effort supported by this program.';
 return null;
}
module.exports={EFFORTS,normalizeAgent,normalizeFont,worktreeOf,validateParity};
