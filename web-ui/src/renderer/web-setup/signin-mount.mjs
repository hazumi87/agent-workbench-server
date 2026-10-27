import {mountSignIn} from './signin.mjs';
// This entry is included only by the web build's mounts manifest.
let mounted;
function start(){if(!mounted&&window.wb?.web&&document.body)mounted=mountSignIn({host:document.body,wb:window.wb});}
window.addEventListener('pagehide',()=>{mounted?.destroy();mounted=null;});
window.addEventListener('pageshow',start);
start();
