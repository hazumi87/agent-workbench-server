// Per-person display preference only; no room, seed or launch API.
export function renderStarterVisibilitySettings(host,{available=false,hidden=false,setHidden,current=()=>true}={}){
  host.replaceChildren();host.hidden=!available;if(!available)return;
  const el=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls;if(text)n.textContent=text;return n;};
  host.append(el('div','lbl sp1','Workrooms'));
  const row=el('div','pg-row'),label=el('span','pg-tx'),button=el('button','pg-sw');let value=hidden;
  label.append(el('b','','Show starter rooms'),el('small','','Your two starter rooms, My first room and My project. Hiding them never deletes them.'));button.type='button';button.setAttribute('role','switch');button.setAttribute('aria-label','Show starter rooms');
  function paint(){button.className='pg-sw'+(!value?' on':'');button.setAttribute('aria-checked',String(!value));}
  button.addEventListener('click',()=>{if(!current()||typeof setHidden!=='function')return;if(setHidden(!value)===true){value=!value;paint();}});
  paint();row.append(label,button);host.append(row);
}

// The shortcut opens the existing switch; it never changes the preference.
export async function openStarterVisibilitySettings({load,show,host,current=()=>false}={}){
  try{
    if(!current())return false;
    await load();if(!current())return false;
    // Showing Settings intentionally hides the room page and consumes its
    // opening operation. No async boundary remains before focus.
    show();
    const section=host(),control=section?.querySelector('[role="switch"]');
    if(!section||section.hidden||!control)return false;
    section.scrollIntoView?.({block:'center'});control.focus?.({preventScroll:true});return true;
  }catch{return false;}
}
