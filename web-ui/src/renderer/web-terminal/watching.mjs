// The web build's "watching" strip (the design's page 4b-2). One tab types at a time (the engine's keyboard lease); a tab that is
// not typing is WATCHING: it shows the output, ignores the keyboard, and says so in a strip above the terminal with one button.
//   watching  "Another tab is typing in this terminal. You're watching."   [Take control here]
//   took it   the strip goes; the tab that LOST it shows once: "Another tab took control of this terminal." then the strip
//   failed    "Couldn't take control. Try again." (the strip stays; nothing types in two places)
// The lost-connection line ("Typing is paused until the server is back.") stays the renderer's own. State comes from window.wb.web.terminal
// (web/handlers/session.js); terminals come from the renderer's 'terminal-tab' / 'terminal-closed' events.
const WATCHING = "Another tab is typing in this terminal. You're watching.";
const LOST = 'Another tab took control of this terminal.';
const FAILED = "Couldn't take control. Try again.";
const BUTTON = 'Take control here';
const SNACK_MS = 6000;

export function mountWatching({ web = globalThis.wb && globalThis.wb.web, doc = globalThis.document, tabs = globalThis.__wbWebTabs } = {}) {
  if (!web || !web.terminal || !web.events) return null;
  const boxes = new Map(); // sid -> box
  const strips = new Map(); // sid -> {el, msg, btn}

  const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

  function stripFor(sid) {
    if (strips.has(sid)) return strips.get(sid);
    const box = boxes.get(sid);
    if (!box) return null;
    const root = el('div', 'wb-watch');
    root.setAttribute('role', 'status');
    root.setAttribute('data-wb-test', 'web-terminal-watching');
    const icon = el('span', 'wb-watch-ic ms', 'visibility');
    icon.setAttribute('aria-hidden', 'true');
    const tx = el('div', 'wb-watch-tx', WATCHING);
    const btn = el('button', 'wb-watch-btn', BUTTON);
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      let ok = false;
      try { ok = await web.terminal.takeControl(sid); } catch (e) { ok = false; }
      btn.disabled = false;
      if (!ok) { tx.textContent = FAILED; tx.setAttribute('data-wb-test', 'web-terminal-take-failed'); } // the strip stays
    });
    root.append(icon, tx, btn);
    box.insertBefore(root, box.firstChild);
    box.classList.add('wb-has-watch');
    refit();
    const s = { el: root, tx, btn };
    strips.set(sid, s);
    return s;
  }
  // the renderer refits terminals when the window resizes: the strip changes the pane's height, so say so
  const refit = () => { try { (doc.defaultView || globalThis).dispatchEvent(new Event('resize')); } catch (e) { /* no window */ } };
  function drop(sid) { const s = strips.get(sid); if (s) { s.el.remove(); strips.delete(sid); const box = boxes.get(sid); if (box) box.classList.remove('wb-has-watch'); refit(); } }

  function snack(sid) {
    const box = boxes.get(sid);
    if (!box) return;
    const n = el('div', 'wb-watch-snack', LOST);
    n.setAttribute('role', 'status');
    n.setAttribute('data-wb-test', 'web-terminal-lost');
    box.appendChild(n);
    setTimeout(() => n.remove(), SNACK_MS);
  }

  function onControl(m) {
    if (!m || !boxes.has(m.sid)) return;
    if (m.state === 'watching') {
      const s = stripFor(m.sid);
      if (s) { s.tx.textContent = WATCHING; s.tx.removeAttribute('data-wb-test'); }
      if (m.lost) snack(m.sid);
    } else drop(m.sid); // typing: the strip goes; away: the renderer's own connection line speaks
  }

  web.events.on('terminal-tab', ({ sid, box }) => { boxes.set(sid, box); const st = web.terminal.state(sid); if (st === 'watching') onControl({ sid, state: st }); });
  web.events.on('terminal-closed', ({ sid }) => { drop(sid); boxes.delete(sid); });
  for (const [sid, box] of (tabs || [])) boxes.set(sid, box); // terminals opened before this script ran
  web.terminal.onControl(onControl);
  return { strips, boxes };
}

if (typeof window !== 'undefined' && window.wb && window.wb.web && !window.__wbWatchingTest) mountWatching();
