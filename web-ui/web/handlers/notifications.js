'use strict';
const {renderBrowserNotifications,notificationSummary}=require('../../src/renderer/web-notifications/view.js');
function register(api,{browser=globalThis}={}) {
 api.expose('notifications',Object.freeze({
  render:(sec,prefs,setPrefs)=>renderBrowserNotifications(sec,prefs,setPrefs,{browser}),
  summary:notify=>{let status='unavailable';try{status=browser.wb.web.browserActions.notificationStatus();}catch{}return notificationSummary(notify,status);},
 }));
}
module.exports={register};
