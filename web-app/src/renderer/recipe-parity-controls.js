import {effortChoices,slugPreview} from './recipe-parity-model.js';
// Uses the existing form's system roles/classes. No picker, persistence or launch.
export function renderParityFields({doc,state,handlers}){
 if(state.parityEnabled!==true)return null;
 const el=(tag,cls,text)=>{const n=doc.createElement(tag);n.className=cls||'';if(text!=null)n.textContent=text;return n;};
 const field=(label,id,input,help)=>{const root=el('div','ac-of'),lab=el('label','',label);lab.htmlFor=id;input.id=id;input.disabled=!!state.saving;root.append(lab,input);if(help){const note=el('div','ac-sup',help);note.id=id+'-sup';input.setAttribute('aria-describedby',note.id);root.append(note);}return root;};
 const select=(choices,value,onChange)=>{const n=el('select');for(const choice of choices){const o=el('option','',choice.label);o.value=choice.value;o.disabled=!!choice.disabled;n.append(o);}n.value=value;n.addEventListener('change',()=>{if(choices.some(c=>c.value===n.value&&!c.disabled))onChange(n.value);});return n;};
 const button=(label,fn,disabled=false)=>{const b=el('button','ac-btn tonal',label);b.type='button';b.disabled=disabled||!!state.saving;b.addEventListener('click',()=>{if(!b.disabled)fn();});return b;};
 const choices=effortChoices(state.programId);
 const effort=choices.length?field('Effort','rfParityEffort',select(choices.map(value=>({value,label:value||'Vendor default'})),state.options?.effort||'',value=>handlers.set('options',{...state.options,effort:value})),'How hard it thinks. Higher is slower and uses more.'):null;
 const worktree=field('Worktree','rfParityWorktree',select([{value:'auto',label:'Auto: a separate copy for the second agent in a project'},{value:'always',label:'Always: Not available yet',disabled:true},{value:'never',label:'Never: always the folder itself'}],state.worktree??'never',value=>handlers.set('worktree',value)));
 const slug=el('input');slug.type='text';slug.maxLength=128;slug.value=state.agent||'';slug.placeholder=slugPreview({...state,agent:''})||'';slug.addEventListener('input',()=>handlers.set('agent',slug.value));
 const identity=field('Agent slug','rfParityAgent',slug,'How this agent is found. Letters, numbers and dashes.');
 const appearance=el('div','rf-parity-appearance');appearance.append(el('div','lbl','Logo'));
 const logoRow=el('div','rf-logo-row'),plate=el('span','rf-logo-preview');plate.setAttribute('aria-hidden','true');
 if(typeof state.logo==='string'&&state.logo.startsWith('data:image/png;base64,')){
  const preview=el('img');preview.src=state.logo;preview.alt='';preview.width=28;preview.height=28;plate.append(preview);
 }else plate.append(el('span','ms','terminal'));
 const logoCopy=el('span','rf-logo-copy',state.logo?'Recipe logo':'Default logo');
 const logoActions=el('div','ac-acts start rf-logo-actions');
 logoActions.append(button('Choose logo…',()=>handlers.chooseLogo?.(),typeof handlers.chooseLogo!=='function'));
 if(state.logo||state.logoBusy)logoActions.append(button('Clear logo',()=>handlers.set('logo',null)));
 logoRow.append(plate,logoCopy,logoActions);appearance.append(logoRow);
 if(state.logoBusy){const reading=el('div','ac-sup','Reading logo…');reading.setAttribute('role','status');appearance.append(reading);}
 const font=el('input');font.type='number';font.min=8;font.max=32;font.step=1;font.placeholder='16';font.value=state.fontSize==null?'16':String(state.fontSize);font.id='rfParityFont';font.disabled=!!state.saving;
 font.addEventListener('input',()=>{if(state.saving)return;const value=font.value;handlers.set('fontSize',value===''?null:Number.isFinite(Number(value))?Math.min(32,Math.max(8,Math.round(Number(value)))):value);});
 const value=state.fontSize==null||state.fontSize===''?16:Number(state.fontSize);
 const smaller=button('A−',()=>handlers.set('fontSize',Math.max(8,value-1)),!Number.isFinite(value)||value<=8),larger=button('A+',()=>handlers.set('fontSize',Math.min(32,value+1)),!Number.isFinite(value)||value>=32);
 smaller.setAttribute('aria-label','Decrease terminal font size');larger.setAttribute('aria-label','Increase terminal font size');
 const fontField=el('div','ac-of rf-font-field'),fontLabel=el('label','','Terminal font size');fontLabel.htmlFor=font.id;
 const step=el('div','rf-font-stepper');step.append(smaller,font,larger);
 const help=el('div','ac-sup',"8 to 32. Saved with this recipe. Terminals don't use it yet.");help.id='rfParityFont-sup';font.setAttribute('aria-describedby',help.id);
 fontField.append(fontLabel,step,help,button('Use default',()=>handlers.set('fontSize',null)));
 // Live terminal font application remains a separately admitted seam.
 appearance.append(fontField);
 return {effort,worktree,identity,appearance};
}
