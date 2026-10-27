// One fixed auto-approve selector for Settings and Add an agent. No persistence.
export function createApprovalSegment({document:doc,value,label,disabled=false,onChange,current,testPrefix='web-recipe'}) {
 if(!['follow','on','off'].includes(value)||typeof onChange!=='function'||typeof current!=='function')throw TypeError('Invalid approval selector');
 const group=doc.createElement('div');group.className='wb-approval-segment';group.setAttribute('role','radiogroup');group.setAttribute('aria-label',label);
 for(const [setting,word] of [['follow','Follow default'],['on','On'],['off','Off']]){
  const button=doc.createElement('button');button.type='button';button.disabled=disabled;button.textContent=word;button.dataset.wbTest=`${testPrefix}-${setting}`;button.setAttribute('role','radio');button.setAttribute('aria-checked',String(value===setting));
  if(value===setting){const mark=doc.createElement('span');mark.textContent='✓';mark.setAttribute('aria-hidden','true');button.append(mark);}
  button.addEventListener('click',()=>{if(!disabled&&!button.disabled&&current()===true)void onChange(setting);});group.append(button);
 }
 return group;
}
