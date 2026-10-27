'use strict';
const {openAgentDialog}=require('../../src/renderer/web-agents/view.js');
const {sayServerAnswer,ROWS}=require('../lib/server-answers.js');
function mapAgentServerAnswer(result){
 const answer={status:result.status,reason:typeof result.error==='string'?result.error.slice(0,160):'',field:typeof result.field==='string'?result.field.slice(0,64):''};
 const call=answer.status===403&&answer.reason==='person_only'?'person-only':answer.status===400&&answer.reason==='disclosure-required'?'auto-approve':'generic';
 const text=sayServerAnswer(call,answer),row=ROWS.find(r=>r.call===call&&r.match(answer));
 return {text,action:row?.action||null};
}
function register(api,{browser=globalThis}={}) {
 let active=null;
 const web=()=>browser.wb.web;
 api.expose('agents',Object.freeze({open(options){
  if(active){active.focus?.();return true;}
  const scope=browser.wb.rooms.bind();
  active=openAgentDialog({
   current:()=>scope.current(),
   serverAnswer:mapAgentServerAnswer,
   readApproval:options=>web().settings.readApproval(options),
   programs:async()=>{const list=await browser.wb.programsList();return web().capabilities&&web().capabilities.bareShell()===false&&Array.isArray(list)?list.filter(p=>p&&p.id!=='shell'):list;}, // a hosted engine opens no bare shell
   list:()=>browser.wb.recipesList(),
   chooseFolder:options=>web().files.chooseFolder(options),
   checkFolder:async(path,options)=>{const result=await web().files.directoryLoader()(path,options);return result?.ok===true;},
   save:payload=>browser.wb.recipesSave(payload),
  },{document:browser.document,forRoom:options?.forRoom===true,onClose:()=>{active=null;}});
  return true;
 }}));
 const hide=()=>{active?.dispose();active=null;};browser.addEventListener('pagehide',hide);
 return ()=>{hide();browser.removeEventListener('pagehide',hide);};
}
module.exports={register,mapAgentServerAnswer};
