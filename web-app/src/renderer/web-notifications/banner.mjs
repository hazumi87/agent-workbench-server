const SEEN='wb.web.notifications.ask.v1';
// Origin-local display marker only; no identity, permission or server setting is stored.
export function mountWorkroomsNotificationBanner({host,context,getPrefs,setPrefs,browser=globalThis,actions=browser.wb.web.browserActions}){
 const doc=browser.document;let alive=true,pending=false,dismissed=false,offered=false,generation=0,last='';
 let seen=false;try{seen=browser.localStorage.getItem(SEEN)==='shown';}catch{}
 const make=(tag,text,key)=>{const n=doc.createElement(tag);n.textContent=text;if(key)n.dataset.wbTest=key;return n;};
 const box=make('section','');box.className='wb-notification-banner';box.setAttribute('aria-label','Browser notifications');
 const mark=make('span','notifications');mark.className='ms';mark.setAttribute('aria-hidden','true');
 const words=make('div','');words.className='wb-notification-banner-text';words.append(make('b','Get a notification when an agent needs you?'),make('p',"Your browser will ask once. Notifications never include what's in a terminal."));
 const buttons=make('div','');buttons.className='wb-notification-banner-actions';
 const later=make('button','Not now','notification-later'),enable=make('button','Turn on notifications','notification-enable');later.type=enable.type='button';buttons.append(later,enable);box.append(mark,words,buttons);host.append(box);host.hidden=true;
 const state=()=>{try{return actions.notificationStatus();}catch{return 'unavailable';}};
 const scope=()=>{const s=context();return{visible:s?.visible===true&&doc.hidden!==true,key:s?.key};};
 function update(){
  if(!alive)return;const s=scope(),stamp=JSON.stringify([s.visible,s.key]);if(stamp!==last){last=stamp;generation++;}
  const show=s.visible&&s.key!=null&&!dismissed&&(!seen||offered)&&browser.isSecureContext===true&&state()==='default';
  host.hidden=!show;enable.disabled=pending;later.disabled=pending;
  if(show&&!offered){offered=true;try{browser.localStorage.setItem(SEEN,'shown');}catch{}}
 }
 async function turnOn(){
  update();if(!alive||pending||host.hidden)return;const owner=generation;pending=true;update();
  try{
   // Call synchronously inside the click's activation; do not await a read first.
   const permission=await actions.requestNotifications();update();
   if(!alive||generation!==owner||!scope().visible)return;
   dismissed=true;
   if(permission==='granted')await setPrefs({notify:{...(getPrefs()?.notify||{}),toast:true}});
  }catch{/* Existing browserActions owns the approved failure feedback. */}
  finally{pending=false;update();}
 }
 enable.addEventListener('click',turnOn);
 later.addEventListener('click',()=>{update();if(!alive||pending||host.hidden)return;dismissed=true;generation++;update();});
 const visibility=()=>{generation++;update();};doc.addEventListener('visibilitychange',visibility);
 update();
 return Object.freeze({update,destroy(){if(!alive)return;alive=false;generation++;doc.removeEventListener('visibilitychange',visibility);host.hidden=true;box.remove();}});
}
