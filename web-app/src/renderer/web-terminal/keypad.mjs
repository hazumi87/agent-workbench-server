import { createKeypadSender, cleanPaste } from './keypad-input.mjs';

const PREF = 'wb.terminal.keys'; // the web build's per-person storage facade; no input is stored
// Pages (the design s14): what a person reaches for most first. The glyphs are briefing-table's (solo.js buildTouchKeypad); Ctrl and Ctrl+C are ours.
const KEYS = [['up','↑',1],['down','↓',1],['enter','⏎',1],['newline','⏎+',1],['paste','',1],['escape','Esc',2],['tab','Tab',2],['control','Ctrl',2],['left','←',2],['right','→',2],['interrupt','Ctrl+C',3],['backtick','`',3]];
const PAGES = 3;
const NAMES = { up:'Up', down:'Down', enter:'Enter', newline:'New line', paste:'Paste', left:'Left', right:'Right', backtick:'Backtick' };
const SAYS = { empty:'Nothing to paste.', long:'That is too long to paste.', denied:"Couldn't paste. Use the keyboard's paste." };

// The renderer supplies the existing tab's identity, scope and lease checks.
// All terminals (including room viewers) use exactly the normal wb.input path.
export function createTerminalKeypad({ box, term, current, controlling, send, refit, layer, win = window }) {
  const doc = box.ownerDocument;
  let disposed = false, frame = 0, shown = false;
  const coarse = win.matchMedia('(pointer: coarse)');
  const enabled = () => {
    try { const saved = win.localStorage.getItem(PREF); return saved === 'on' || (saved !== 'off' && coarse.matches); }
    catch { return coarse.matches; }
  };
  const visible = () => !disposed && box.isConnected && !doc.hidden && !box.closest('[hidden],[inert]') && box.getClientRects().length > 0 && current() === true;
  const ownsFocus = () => box.contains(doc.activeElement) || row.contains(doc.activeElement) || toggle === doc.activeElement;
  const ready = () => visible() && doc.hasFocus() && (ownsFocus() || layer?.() === true); // in a phone's terminal layer the terminal is the only place a key can go
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
  const pages = new Map();
  for (const [key,label,page] of KEYS) {
    const button = doc.createElement('button'); button.type = 'button'; button.dataset.terminalKey = key; button.dataset.page = String(page);
    if (key === 'paste') { const g = doc.createElement('span'); g.className = 'ms'; g.setAttribute('aria-hidden','true'); g.textContent = 'content_paste'; button.append(g); }
    else button.textContent = label;
    button.setAttribute('aria-label',NAMES[key] || label);
    button.addEventListener('pointerdown',keepFocus);
    button.addEventListener('click',(event) => { if (key === 'paste') { void pasteClipboard(event); return; } if (sender.press(key,event)) term.focus(); paintControl(); });
    buttons.set(key,button); pages.set(page,[...(pages.get(page) || []),button]); row.append(button);
  }
  // the pager only turns the page: it sends nothing, and it works while watching too
  let page = 1;
  const pager = doc.createElement('button'); pager.type = 'button'; pager.dataset.terminalPager = '1'; pager.className = 'wb-terminal-pager';
  const paintPage = () => {
    for (const [n,list] of pages) for (const b of list) b.hidden = n !== page;
    pager.textContent = page + '/' + PAGES; pager.setAttribute('aria-label','More keys, page ' + page + ' of ' + PAGES);
  };
  pager.addEventListener('pointerdown',keepFocus);
  pager.addEventListener('click',(event) => { if (event.isTrusted !== true) return; page = page % PAGES + 1; paintPage(); });
  row.append(pager); paintPage();
  // one status line above the row: the paste sentences (3 s)
  const say = doc.createElement('div'); say.className = 'wb-terminal-keysay'; say.setAttribute('role','status'); say.hidden = true; doc.body.append(say);
  let sayTimer = 0;
  const tell = (words) => { say.textContent = words; say.hidden = false; win.clearTimeout?.(sayTimer); sayTimer = win.setTimeout?.(() => { say.hidden = true; },3000); };
  // PASTE reads the clipboard only at a trusted click on this button (never on focus, load, a timer, a key or a message); the text is not kept or
  // logged; it is cleaned (cleanPaste) and handed to the terminal's OWN paste, which takes the same input path, lease check and gates as typing.
  async function pasteClipboard(event) {
    if (event?.isTrusted !== true || event.type !== 'click' || event.repeat === true) return;
    if (!ready() || controlling() !== true) { sender.reset(); paintControl(); return; }
    sender.reset(); paintControl();
    let text;
    try { text = await win.navigator.clipboard.readText(); } catch { tell(SAYS.denied); return; }
    const clean = cleanPaste(text);
    if (clean === null) { tell(SAYS.long); return; }
    if (!clean) { tell(SAYS.empty); return; }
    if (disposed || !ready() || controlling() !== true) return; // control moved while the browser asked: nothing is sent
    term.paste(clean); term.focus();
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
    // a phone's full-screen terminal layer shows the row from the moment it opens (greyed until you control it); elsewhere it waits for focus
    const active = ready(), permitted = active && controlling() === true;
    const next = (active || (visible() && layer?.() === true)) && enabled();
    if (!next || !permitted) reset();
    row.hidden = !next;
    toggle.setAttribute('aria-label',enabled() ? 'Hide keys' : 'Show keys');
    toggle.setAttribute('aria-expanded',String(next));
    for (const [key,button] of buttons) {
      button.disabled = !permitted;
      const name = NAMES[key] || KEYS.find(([k]) => k === key)[1];
      button.setAttribute('aria-label',permitted ? name : name + ', unavailable while you are watching');
    }
    const vv = win.visualViewport;
    const nav = doc.querySelector('.wb-bnav');
    const navTop = nav?.getClientRects().length ? nav.getBoundingClientRect().top : win.innerHeight;
    row.style.bottom = Math.max(0,win.innerHeight - navTop,win.innerHeight - (vv ? vv.height + vv.offsetTop : win.innerHeight)) + 'px';
    row.style.left = (vv?.offsetLeft || 0) + 'px';
    say.style.bottom = (parseFloat(row.style.bottom) || 0) + (next ? 57 : 0) + 'px'; say.style.left = row.style.left;
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
  // a phone's terminal layer shows the row from its first frame: the page's layer attributes and the box's own size are the cue, not focus or a timer
  const layerWatch = new win.MutationObserver(schedule); layerWatch.observe(doc.documentElement,{attributes:true,attributeFilter:['data-wb-toollayer','data-tphone']});
  const sizeWatch = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(schedule) : null; sizeWatch?.observe(box);
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
      win.cancelAnimationFrame(frame); win.clearTimeout?.(sayTimer); say.remove?.(); observer.disconnect(); layerWatch.disconnect(); sizeWatch?.disconnect(); offControl?.();
      box.removeEventListener('keydown',onType,true); box.removeEventListener('beforeinput',onType,true); box.removeEventListener('paste',reset,true);
      doc.removeEventListener('focusin',focusChanged,true); doc.removeEventListener('focusout',focusChanged,true); doc.removeEventListener('visibilitychange',lostVisibility);
      win.removeEventListener('focus',schedule); win.removeEventListener('blur',lostVisibility); win.removeEventListener('resize',schedule);
      win.visualViewport?.removeEventListener('resize',schedule); win.visualViewport?.removeEventListener('scroll',schedule); coarse.removeEventListener('change',schedule);
      row.remove(); toggle.remove(); fallback.remove(); box.classList.remove('wb-terminal-has-keys');
    },
  };
}
