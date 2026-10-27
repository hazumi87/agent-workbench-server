const COPY="Couldn't copy automatically. The text is selected: press Ctrl+C.";
const PASTE="Your browser didn't allow pasting here. Click in the terminal and press Ctrl+V.";
const LINK="Couldn't open that link.";
const BLOCKED="Your browser blocked the new tab. Allow pop-ups for this site, then try again.";
const NOTIFY="Notifications are blocked for this site. Allow them in your browser's site settings, then reload.";
const HTTPS="Notifications need a secure (https) address, and this one isn't. They can't be turned on here.";
const copy=Object.freeze({copy:COPY,paste:PASTE,open:LINK,notify:NOTIFY});
export const BROWSER_ACTION_WORDS=Object.freeze({
 'clipboard-denied':copy,
 'clipboard-invalid':copy,
 'clipboard-too-large':Object.freeze({...copy,copy:"That's too much text to copy at once. Select a smaller part."}),
 'clipboard-unavailable':copy,
 'disposed':copy,
 'notification-denied':copy,
 'notification-invalid':copy,
 'notification-permission':copy,
 'notifications-unavailable':copy,
 'popup-blocked':Object.freeze({...copy,open:BLOCKED}),
 'popup-unavailable':Object.freeze({...copy,open:BLOCKED}),
 'secure-context-required':Object.freeze({...copy,notify:HTTPS}),
 'unsafe-url':copy,
 'user-gesture-required':Object.freeze({...copy,open:BLOCKED}),
});
export function browserActionMessage(code,action,{mac=false}={}) {
 if(!Object.hasOwn(BROWSER_ACTION_WORDS,code)||!Object.hasOwn(BROWSER_ACTION_WORDS[code],action))throw Error('Unmapped browser action refusal');
 const sentence=BROWSER_ACTION_WORDS[code][action];
 return mac?sentence.replace('Ctrl+C','Cmd+C').replace('Ctrl+V','Cmd+V'):sentence;
}
