// The file never leaves the page: the controller sends selected recipes only.
export async function chooseRecipeFile(browser=window,{signal}={}) {
  if(signal?.aborted)return null;
  if(browser.navigator?.userActivation?.isActive!==true)throw Object.assign(new Error('user-gesture-required'),{code:'user-gesture-required'});
  return new Promise((resolve,reject)=>{
    const input=browser.document.createElement('input');
    input.type='file';input.accept='.json,application/json';input.multiple=false;input.hidden=true;
    let settled=false;
    const finish=(value,error)=>{
      if(settled)return;settled=true;
      input.removeEventListener('change',changed);input.removeEventListener('cancel',cancelled);
      signal?.removeEventListener('abort',cancelled);input.remove();
      if(error)reject(error);else resolve(value);
    };
    const changed=()=>finish(input.files?.[0]||null),cancelled=()=>finish(null);
    input.addEventListener('change',changed);input.addEventListener('cancel',cancelled);
    signal?.addEventListener('abort',cancelled,{once:true});
    try{browser.document.body.append(input);input.click();}catch{finish(null,Object.assign(new Error('file-picker-unavailable'),{code:'file-picker-unavailable'}));}
  });
}
