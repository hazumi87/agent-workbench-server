import {createAppToneSettings} from './app-tone-state.js';
import {APP_TONE_CHOICES} from './app-tone-palette.js';
import {createColorSwatches} from './color-swatches.js';
const node=(tag,cls,text)=>{const el=document.createElement(tag);el.className=cls;if(text!==undefined)el.textContent=text;return el};
export function createAppsSettings({host,api,paintTone}) {
  const root=node('section','at-settings');root.hidden=true;
  const title=node('h2','','Apps'),subtitle=node('p','at-subtitle','Each app keeps its color in every room.');
  const loadError=node('p','at-error');loadError.setAttribute('role','alert');
  const list=node('div','at-list');root.append(title,subtitle,loadError,list);host.append(root);
  const rows=new Map();let model,popup=null,disposed=false;
  const toneChoice=tone=>APP_TONE_CHOICES.find(c=>c.value===tone);
  function closePicker(restore=true) {
    if(!popup)return;const old=popup;popup=null;const owns=old.overlay.contains(document.activeElement);
    old.picker.dispose();old.overlay.remove();if(restore&&owns&&model.state().visible)old.returnTo.focus();
  }
  function showPicker(key) {
    if(disposed||!model.state().canChange)return;closePicker(false);
    const row=model.state().apps.find(a=>a.key===key),belongs=model.fence();
    const overlay=node('div','at-backdrop'),sheet=node('section','at-picker');sheet.setAttribute('role','dialog');sheet.setAttribute('aria-modal','true');sheet.setAttribute('aria-label','Color for '+row.name);
    const heading=node('h3','','Color for '+row.name),close=node('button','at-close','Close');close.type='button';close.addEventListener('click',()=>closePicker());
    const picker=createColorSwatches({choices:APP_TONE_CHOICES,value:row.tone,label:'Color for '+row.name,paint:paintTone,current:belongs,choose:async tone=>{
      if(!belongs())return false;const ok=await model.change(key,tone);if(belongs())closePicker();return ok;
    }});
    sheet.append(heading,picker.el,close);overlay.append(sheet);root.append(overlay);popup={key,overlay,picker,returnTo:rows.get(key).change};
    overlay.addEventListener('click',event=>{if(event.target===overlay)closePicker()});
    sheet.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation?.();closePicker();return}
      if(event.key==='Tab'){
        if(event.shiftKey&&picker.el.contains(document.activeElement)){event.preventDefault();close.focus()}
        else if(!event.shiftKey&&document.activeElement===close){event.preventDefault();picker.focus()}
      }
    });picker.focus();
  }
  function render() {
    if(disposed||!model)return;const state=model.state();root.hidden=!state.visible;
    if(!state.visible)closePicker(false);
    loadError.textContent=state.loadError?"Couldn't load your app colors.":'';loadError.hidden=!state.loadError;
    for(const app of state.apps){
      let item=rows.get(app.key);
      if(!item){
        const el=node('article','at-row'),sample=node('div','at-sample'),glyph=node('span','ms',app.icon);glyph.setAttribute('aria-hidden','true');sample.append(glyph);
        const info=node('div','at-info'),name=node('h3','',app.name),tone=node('p','at-tone');info.append(name,tone);
        const actions=node('div','at-actions'),change=node('button','at-change','Change color'),reset=node('button','at-reset','Use default');
        change.type=reset.type='button';change.setAttribute('aria-label','Change '+app.name+' color');reset.setAttribute('aria-label','Use default '+app.name+' color');
        change.addEventListener('click',()=>showPicker(app.key));reset.addEventListener('click',()=>model.reset(app.key));actions.append(change,reset);
        const error=node('p','at-error');error.setAttribute('role','alert');el.append(sample,info,actions,error);list.append(el);
        item={el,sample,tone,change,reset,error};rows.set(app.key,item);
      }
      const choice=toneChoice(app.tone);paintTone(item.sample,choice);
      item.tone.textContent=choice.label+(app.changed?' (changed)':'');
      item.reset.hidden=!app.changed;item.change.disabled=item.reset.disabled=!state.loaded||state.loading||state.loadError;
      item.change.setAttribute('aria-disabled',String(!state.canChange));item.reset.setAttribute('aria-disabled',String(!state.canChange));
      item.error.textContent=app.error?`Couldn't change ${app.name}'s color. Try again.`:'';item.error.hidden=!app.error;
    }
    if(popup){const row=state.apps.find(a=>a.key===popup.key);if(row)popup.picker.setValue(row.tone)}
  }
  model=createAppToneSettings({api,changed:render});render();
  return Object.freeze({
    open:()=>model.open(),close(){closePicker(false);model.close()},receive:status=>model.receive(status),
    accountChanged(){closePicker(false);model.accountChanged()},
    themeChanged(){render();popup?.picker.repaint()},
    dispose(){if(disposed)return;closePicker(false);disposed=true;model.dispose();root.remove()},
  });
}
