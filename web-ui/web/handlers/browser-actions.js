'use strict';
const {createBrowserActions}=require('../../src/renderer/web/browser-actions.js');
const {createBrowserFeedback}=require('../../src/renderer/web-browser-feedback/view.js');

// Delegated from platform.js as one ownership move. No network, credentials,
// native powers or automatic permission prompts. Legacy copy is boolean; the
// web-only API preserves typed failures for the renderer's fallback UI.
function register(api,{browser=globalThis,makeFeedback=createBrowserFeedback}={}) {
  let actions=createBrowserActions(browser),feedback=makeFeedback(browser),disposed=false;
  const methods={};
  const operation={copyText:'copy',readText:'paste',openTab:'open',openExternal:'open',requestNotifications:'notify'};
  for(const [name,action] of Object.entries(operation)) {
    methods[name]=(...args)=>{
      const refused=error=>{feedback.show(error.code,action,{text:args[0]});throw error;};
      try {
        const result=actions[name](...args);
        if(result&&typeof result.then==='function')return result.then(value=>{
          if(name==='requestNotifications'&&value==='denied')feedback.show('notification-permission','notify');
          return value;
        },refused);
        return result;
      }catch(error){return refused(error);}
    };
  }
  methods.notificationStatus=()=>actions.notificationStatus();
  // P01 (the design s12): "{room name} needs you" / "@{seat} is waiting for your OK." Only a room's name and a seat's handle are
  // accepted here, never terminal or line content.
  methods.notifyNeedsYou=({room,seat,tag='',onClick}={})=>{
    try {
    if(typeof room!=='string'||!room||room.length>120||/[\u0000-\u001f]/.test(room)||typeof seat!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(seat))throw Object.assign(new Error('notification-invalid'),{code:'notification-invalid'});
    return actions.notify(room+' needs you',{body:'@'+seat+' is waiting for your OK.',tag,onClick});
    } catch(error) {feedback.show(error.code,'notify');throw error;}
  };
  api.expose('browserActions',Object.freeze(methods));
  api.handle('clipboard:write',async([text])=>{
    try{return await methods.copyText(text);}catch{return false;}
  });
  api.handle('shell:open-external',([url])=>{try{return methods.openExternal(url);}catch{return false;}});
  const hide=()=>{actions.dispose();feedback.dispose();};
  const show=event=>{if(!disposed&&event.persisted){actions=createBrowserActions(browser);feedback=makeFeedback(browser);}};
  browser.addEventListener('pagehide',hide);
  browser.addEventListener('pageshow',show);
  return ()=>{disposed=true;actions.dispose();feedback.dispose();browser.removeEventListener('pagehide',hide);browser.removeEventListener('pageshow',show);};
}
module.exports={register};
