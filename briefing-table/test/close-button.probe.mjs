/* Closing a session WINDOW leaves the CLI running (Owner, 2026-09-12; v21 update below).
 * The thing that must be true is not "no dialog appeared" but "the session is
 * still alive afterwards" — a silent kill would also show no dialog.
 * Real Edge, live :7420. Not in `npm test`. */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE='http://127.0.0.1:7420';
const TOKEN=readFileSync('secrets/engine.token','utf8').trim();
const RECIPE=process.env.PROBE_RECIPE || 'eeeeeeee-0000-4000-8000-0000000000e1';
const PANE=`recipe:${RECIPE}`;
let failures=0;
const ok=(c,m)=>{console.log(`${c?'  ok  ':' FAIL '} ${m}`); if(!c) failures++;};
const state=async()=>{
  const t=await (await fetch(`${BASE}/api/table`,{headers:{authorization:`Bearer ${TOKEN}`}})).json();
  return ((t.sessions??t).find(r=>r.paneid===PANE)||{});
};

const b=await chromium.launch({channel:'msedge',headless:false});
const ctx=await b.newContext({viewport:{width:1000,height:700}});
const p=await ctx.newPage();
await p.goto(`${BASE}/login`);
await p.evaluate(t=>{const f=document.querySelector('form');(f.querySelector('input[name=token]')||f.querySelector('input')).value=t;},TOKEN);
await Promise.all([p.waitForNavigation().catch(()=>{}),p.click('form button:visible')]);
const l=await (await fetch(`${BASE}/api/recipes/${RECIPE}/launch`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${TOKEN}`},body:JSON.stringify({target:'tab',surface:'browser'})})).json();
await p.goto(`${BASE}${l.path}`,{waitUntil:'domcontentloaded'});
await p.waitForTimeout(3500);

ok((await state()).state==='live','the session is live before we close the window');
ok(await p.$('#closeModal')===null,'the kill/hide choice dialog is gone from the page');
/* v21 (2026-09-19): the page has NO ✕ of its own any more — the session bar
   carries no close (ruling 1d). Closing a view is the SHELL's tab ✕ -> the
   bundle's popover -> close-view -> {hwbClose} -> this page's park; that path is
   exercised by test/v21-ui.probe.mjs (timeout closes the tab, session stays
   live). What remains to check here: nothing on the page can kill, and closing
   the browser tab still leaves the CLI running and reopenable. */
ok(await p.$('#killBtn')===null,'no ✕ on the page (v21: the bar has no close)');
ok(await p.$('#sbar [data-close], #sbar .tclose')===null,'and none in the session bar');
ok(await p.$('.close-modal:not([hidden])') === null, 'and no dialog on screen');

await p.close(); // stand in for the close the browser refuses to let script do
await new Promise(r=>setTimeout(r,1500));
const after=await state();
ok(after.state==='live',`the CLI is STILL RUNNING in the broker (state=${after.state})`);
ok(after.attached===false,`with no window attached to it (attached=${after.attached})`);

// and it must be reopenable — a parked session you cannot get back is a kill
const p2=await ctx.newPage();
const l2=await (await fetch(`${BASE}/api/recipes/${RECIPE}/launch`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${TOKEN}`},body:JSON.stringify({target:'tab',surface:'browser'})})).json();
await p2.goto(`${BASE}${l2.path}`,{waitUntil:'domcontentloaded'});
await p2.waitForTimeout(3000);
const back=await state();
ok(back.state==='live'&&back.attached===true,`and reopens from the manager (state=${back.state} attached=${back.attached})`);
await b.close();
console.log(failures?`\n${failures} FAILED`:'\nall passed');
process.exit(failures?1:0);
