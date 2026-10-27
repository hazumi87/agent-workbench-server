const owners=new WeakMap();
const BLOCKED="Notifications are blocked for this site. Allow them in your browser's site settings, then reload.";
const HTTPS="Notifications need a secure (https) address, and this one isn't. They can't be turned on here.";
export function notificationSummary(notify={},status='granted') {
 const toast=notify.toast===true&&status==='granted';
 return toast?'Notification':'Off';
}
export function renderBrowserNotifications(sec,prefs,setPrefs,{browser=globalThis,actions=browser.wb.web.browserActions}={}) {
 const token={};owners.set(sec,token);sec.textContent='';
 const n={flash:true,toast:false,...prefs.notify};let pending=false;
 const current=()=>owners.get(sec)===token&&browser.document.hidden!==true&&sec.isConnected&&!sec.closest?.('[hidden]');
 const el=(tag,cls,text)=>{const node=browser.document.createElement(tag);node.className=cls||'';if(text!==undefined)node.textContent=text;return node;};
 const state=()=>{try{return actions.notificationStatus();}catch{return 'unavailable';}};
 const row=(key,label,hint)=>{
  const r=el('div','pg-row'),tx=el('span','pg-tx');tx.append(el('b','',label));if(hint)tx.append(el('small','',hint));
  const button=el('button','pg-sw'+(n[key]?' on':''));button.type='button';button.id='notify-'+key;button.setAttribute('role','switch');button.setAttribute('aria-label',label);button.setAttribute('aria-checked',String(n[key]));r.append(tx,button);sec.append(r);return button;
 };
 sec.append(el('div','pg-sub',"When an agent or terminal needs you and this tab isn't in front"));
 const toast=row('toast','Show a browser notification',"One per CLI, with its name and where it runs. Never what's in the terminal.");
 const message=el('p','wb-notification-message');message.setAttribute('role','status');sec.append(message);
 const ask=el('section','wb-notification-ask');ask.setAttribute('aria-label','Browser notifications');ask.append(el('b','','Get a notification when an agent needs you?'),el('p','',"Your browser will ask once. Notifications never include what's in a terminal."));
 const later=el('button','wb-notification-dismiss','Not now'),enable=el('button','wb-notification-enable','Turn on notifications');later.type=enable.type='button';ask.append(later,enable);sec.append(ask);
 function paint(){const status=state(),secure=browser.isSecureContext===true;const on=status==='granted'&&n.toast===true;
  toast.setAttribute('aria-checked',String(on));toast.classList.toggle('on',on);toast.disabled=pending||!secure||status==='denied'||status==='unavailable';
  enable.disabled=pending;ask.hidden=!secure||status!=='default';
  message.textContent=!secure?HTTPS:status==='denied'?BLOCKED:status==='unavailable'?"Notifications aren't available in this browser.":'';message.hidden=!message.textContent;
 }
 async function turnOn(){
  if(pending||!current()||browser.isSecureContext!==true||!['default','granted'].includes(state()))return;
  pending=true;paint();
  try{const status=state()==='granted'?'granted':await actions.requestNotifications();if(!current())return;if(status==='granted')await setPrefs({notify:{...n,toast:true}});}
  catch{/* the browser action handler already displayed the approved refusal */}
  finally{if(current()){pending=false;paint();}}
 }
 toast.addEventListener('click',()=>{if(!current()||toast.disabled)return;if(n.toast&&state()==='granted')void setPrefs({notify:{...n,toast:false}});else void turnOn();});
 enable.addEventListener('click',turnOn);later.addEventListener('click',()=>{ask.hidden=true;});paint();
 return {dispose(){if(owners.get(sec)===token)owners.delete(sec);}};
}
