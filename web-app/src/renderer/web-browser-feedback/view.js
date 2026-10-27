import {browserActionMessage} from './words.js';
// Error text is fixed copy. Clipboard text is transient DOM value only: never
// markup, a log, browser storage or an engine request. Closing wipes the value.
export function createBrowserFeedback(browser=window) {
 let dialog=null,notice=null,disposed=false;
 const mac=/Mac|iPhone|iPad/.test(browser.navigator?.platform||browser.navigator?.userAgent||'');
 const el=(tag,cls,text)=>{const n=browser.document.createElement(tag);n.className=cls;if(text!==undefined)n.textContent=text;return n;};
 function clearDialog(){if(!dialog)return;const old=dialog;dialog=null;old.input.value='';old.node.remove();if(old.focus?.isConnected)old.focus.focus();}
 function showNotice(text){
  if(disposed)return;notice?.remove();
  const box=el('div','wb-browser-notice'),line=el('p','',text),close=el('button','','Close');
  line.setAttribute('role','status');close.type='button';close.addEventListener('click',()=>{box.remove();if(notice===box)notice=null;});
  box.append(line,close);browser.document.body.append(box);notice=box;
 }
 function copyFallback(text,sentence){
  clearDialog();
  const focus=browser.document.activeElement,node=el('dialog','wb-browser-copy'),title=el('h2','','Copy'),input=el('textarea',''),line=el('p','',sentence),close=el('button','','Close');
  title.id='wb-browser-copy-title';node.setAttribute('aria-labelledby',title.id);input.setAttribute('aria-label','Text to copy');
  input.readOnly=true;input.rows=6;input.value=text;close.type='button';line.setAttribute('role','status');
  node.append(title,input,line,close);dialog={node,input,focus};
  close.addEventListener('click',clearDialog);node.addEventListener('close',clearDialog);node.addEventListener('cancel',clearDialog);
  browser.document.body.append(node);node.showModal();input.focus();input.select();
 }
 return Object.freeze({
  show(code,action,{text}={}){
   if(disposed||code==='disposed')return;
   if(action==='copy'&&typeof text!=='string')return; // no truthful selection can be offered for a programmer-only invalid payload
   const sentence=browserActionMessage(code,action,{mac});
   if(action==='copy'&&code!=='clipboard-too-large'&&typeof text==='string'&&text.length<=100000)copyFallback(text,sentence);
   else showNotice(sentence);
  },
  dispose(){disposed=true;clearDialog();notice?.remove();notice=null;},
 });
}
