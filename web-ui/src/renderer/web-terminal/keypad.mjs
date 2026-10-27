import { createKeypadSender } from './keypad-input.mjs';

const PREF = 'wb.terminal.keys'; // the web build's per-person storage facade; no input is stored
const KEYS = [['escape','Esc'],['tab','Tab'],['control','Ctrl'],['left','←'],['up','↑'],['down','↓'],['right','→'],['interrupt','Ctrl+C']];
const NAMES = { left:'Left arrow', up:'Up arrow', down:'Down arrow', right:'Right arrow' };

// The renderer supplies the existing tab's identity, scope and lease checks.
// All terminals (including room viewers) use exactly the normal wb.input path.
export function createTerminalKeypad({ box, term, current, controlling, send, refit, win = window }) {
  const doc = box.ownerDocument;
  let disposed = false, frame = 0, shown = false;
  const coarse = win.matchMedia('(pointer: coarse)');
  const enabled = () => {
    try { const saved = win.localStorage.getItem(PREF); return saved === 'on' || (saved !== 'off' && coarse.matches); }
    catch { return coarse.matches; }
  };
  const visible = () => !disposed && box.isConnected && !doc.hidden && !box.closest('[hidden],[inert]') && box.getClientRects().length > 0 && current() === true;
  const ownsFocus = () => box.contains(doc.activeElement) || row.contains(doc.activeElement) || toggle === doc.activeElement;
  const ready = () => visible() && doc.hasFocus() && ownsFocus();
  const sender = createKeypadSender({ current:ready, controlling, send, applicationCursor:() => term.modes.applicationCursorKeysMode });
  const row = doc.createElement('div'); row.className = 'wb-terminal-keypad'; row.hidden = true;
  row.setAttribute('role','group'); row.setAttribute('aria-label','Terminal keys');
  const toggle = doc.createElement('button'); toggle.type = 'button'; toggle.className = 'wb-terminal-keys-toggle';
  const glyph = doc.createElement('span'); glyph.className = 'ms'; glyph.setAttribute('aria-hidden','true'); glyph.textContent = 'keyboard';
  const word = doc.createElement('span'); word.textContent = 'Keys'; toggle.append(glyph,word);
  const fallback = doc.createElement('div'); fallback.className = 'wb-terminal-keys-bar'; fallback.append(toggle); box.prepend(fallback);
  doc.body.append(row);
  const buttons = new Map();
  const paintControl = () => buttons.get('control').setAttribute('aria-pressed',String(sender.control));
  const reset = () => { sender.reset(); paintControl(); };
  // Keep the textarea focused so tapping a key does not close the phone keyboard.
  const keepFocus = (event) => { if (event.isTrusted && event.button === 0) event.preventDefault(); };
  toggle.addEventListener('pointerdown',keepFocus);
  for (const [key,label] of KEYS) {
    const button = doc.createElement('button'); button.type = 'button'; button.textContent = label; button.dataset.terminalKey = key;
    if (NAMES[key]) button.setAttribute('aria-label',NAMES[key]);
    button.addEventListener('pointerdown',keepFocus);
    button.addEventListener('click',(event) => { if (sender.press(key,event)) term.focus(); paintControl(); });
    buttons.set(key,button); row.append(button);
  }
  paintControl();
  toggle.addEventListener('click',(event) => {
    if (!event.isTrusted || !visible()) return;
    const on = !enabled();
    try { win.localStorage.setItem(PREF,on ? 'on' : 'off'); } catch { /* preference unavailable */ }
    reset(); term.focus(); refresh();
  });
  const onType = (event) => {
    if (event.target !== term.textarea) return;
    if (sender.type(event)) { event.preventDefault(); event.stopImmediatePropagation(); }
    paintControl();
  };
  box.addEventListener('keydown',onType,true);
  box.addEventListener('beforeinput',onType,true);
  box.addEventListener('paste',reset,true);
  // Refit only when the reserved row space changes, never on a key press.
  function refresh() {
    if (disposed) return;
    const header = box.closest('.pane')?.querySelector('.pane-h');
    if (header && toggle.parentElement !== header) header.append(toggle);
    if (!header && toggle.parentElement !== fallback) fallback.append(toggle);
    fallback.hidden = !!header;
    const active = ready(), permitted = active && controlling() === true;
    const next = active && enabled();
    if (!next || !permitted) reset();
    row.hidden = !next;
    toggle.setAttribute('aria-label',enabled() ? 'Hide keys' : 'Show keys');
    toggle.setAttribute('aria-expanded',String(next));
    for (const button of buttons.values()) button.disabled = !permitted;
    const vv = win.visualViewport;
    const nav = doc.querySelector('.wb-bnav');
    const navTop = nav?.getClientRects().length ? nav.getBoundingClientRect().top : win.innerHeight;
    row.style.bottom = Math.max(0,win.innerHeight - navTop,win.innerHeight - (vv ? vv.height + vv.offsetTop : win.innerHeight)) + 'px';
    row.style.left = (vv?.offsetLeft || 0) + 'px';
    row.style.width = (vv?.width || win.innerWidth) + 'px';
    if (next !== shown) {
      shown = next; box.classList.toggle('wb-terminal-has-keys',shown);
      win.requestAnimationFrame(() => { if (!disposed && box.isConnected) refit(); });
    }
  }
  const schedule = () => { if (!disposed && !frame) frame = win.requestAnimationFrame(() => { frame = 0; refresh(); }); };
  const focusChanged = () => { if (!ownsFocus()) reset(); schedule(); };
  const lostVisibility = () => { reset(); schedule(); };
  doc.addEventListener('focusin',focusChanged,true);
  doc.addEventListener('focusout',focusChanged,true);
  doc.addEventListener('visibilitychange',lostVisibility);
  win.addEventListener('blur',lostVisibility);
  win.addEventListener('focus',schedule);
  win.addEventListener('resize',schedule);
  win.visualViewport?.addEventListener('resize',schedule);
  win.visualViewport?.addEventListener('scroll',schedule);
  coarse.addEventListener('change',schedule);
  const offControl = win.wb.web.terminal?.onControl(() => { if (!controlling()) reset(); schedule(); });
  // Observe the existing ancestors only, not terminal output. Even a hide/show
  // ABA cancels Ctrl; moving the terminal to another pane rebinds this list.
  const observer = new win.MutationObserver(lostVisibility);
  let ancestors = [];
  function watchAncestors() {
    const next = []; for (let node = box.parentElement; node; node = node.parentElement) next.push(node);
    if (next.length === ancestors.length && next.every((node,i) => node === ancestors[i])) return;
    observer.disconnect(); ancestors = next;
    for (const node of ancestors) observer.observe(node,{attributes:true,attributeFilter:['hidden','inert','class','style','data-wb-surface']});
    reset();
  }
  function update() { if (!disposed) { watchAncestors(); refresh(); } }
  update();
  return {
    toggle,
    refresh:update,
    dispose() {
      if (disposed) return; disposed = true; sender.dispose();
      win.cancelAnimationFrame(frame); observer.disconnect(); offControl?.();
      box.removeEventListener('keydown',onType,true); box.removeEventListener('beforeinput',onType,true); box.removeEventListener('paste',reset,true);
      doc.removeEventListener('focusin',focusChanged,true); doc.removeEventListener('focusout',focusChanged,true); doc.removeEventListener('visibilitychange',lostVisibility);
      win.removeEventListener('focus',schedule); win.removeEventListener('blur',lostVisibility); win.removeEventListener('resize',schedule);
      win.visualViewport?.removeEventListener('resize',schedule); win.visualViewport?.removeEventListener('scroll',schedule); coarse.removeEventListener('change',schedule);
      row.remove(); toggle.remove(); fallback.remove(); box.classList.remove('wb-terminal-has-keys');
    },
  };
}
