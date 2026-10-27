// Confirmation copy names fields, never their values or array indexes.
function plainName(field){
 const keys=field.replace(/^file\./,'').split('.').filter(k=>!/^\d+$/.test(k)),root=keys[0]||'';
 const labels={vendorArgs:'program arguments',vendorFlags:'permission options',projectDir:'starting folder',target:'server',name:'recipe name',model:'model',effort:'effort',logo:'logo',worktree:'worktree mode'};
 if(labels[root])return labels[root];const last=keys.at(-1)||'';
 if(/password/i.test(last))return 'password';if(/api.?key/i.test(last))return 'API key';if(/token/i.test(last))return 'access token';if(/authorization/i.test(last))return 'authorization';return 'additional secret field';
}
export function secretWarning(rows,picks,{onServer=false}={}){
 const location=onServer?'this server':'this computer';
 const kept=new Set(),dropped=new Set(),triggers=new Set();
 for(const r of rows){const pick=picks[r.index];if(!pick?.selected)continue;const findings=r.secretFindings||r.secretFields.map(field=>({field,trigger:'name'}));for(const f of findings){const root=f.field.split('.')[0];const saved=root==='name'||(root==='model'&&r.model)||(root==='effort'&&r.effort)||(root==='vendorArgs'&&r.programId!=='shell'&&r.vendorArgs?.length)||(root==='vendorFlags'&&r.vendorFlags?.length)||(root==='projectDir'&&pick.folder&&pick.folder===r.folder)||(root==='target'&&pick.target==='keep'&&r.sourceTarget!=='local');(saved?kept:dropped).add(plainName(f.field));triggers.add(f.trigger);}}
 const a=[...kept],b=[...dropped],all=[...new Set([...a,...b])];if(!all.length)return null;
 const prefix=triggers.has('value')?(triggers.has('name')?'Some recipes have fields named like passwords or keys, or text that looks like a password or key, in':'Some recipes have text that looks like a password or key, in'):'Some recipes have fields named like passwords or keys';
 if(a.length&&b.length)return `${prefix}: ${all.join(', ')}. Their values are hidden here. Saved on ${location}: ${a.join(', ')}. Not copied: ${b.join(', ')}. Continue?`;
 return `${prefix}: ${all.join(', ')}. Their values are hidden here. ${a.length?`They will be saved in your recipes on ${location}.`:"Those fields won't be copied."} Continue?`;
}
