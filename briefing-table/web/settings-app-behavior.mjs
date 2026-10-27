/* APP BEHAVIOR [room switch] (Owner 2026-10-08): the Global settings section for how the right-hand column's app behaves. One setting today:
 * "When I switch room or workgroup, the app on the right": Stays as it is (default) | Reopens for the new room. Mounted by web/settings.mjs like the
 * other groups; stored per device (web/app-behavior-pref.mjs). */
import { SWITCH_MODES, getSwitchMode, setSwitchMode } from '/app-behavior-pref.mjs';

const MODE_TEXT = {
  stay: ['Stays as it is', 'The app keeps its place, scroll and state while the chat and the rooms change around it.'],
  reopen: ['Reopens for the new room', 'The app closes and the same app opens again for the room you switched to.'],
};

function mk(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) {
    n.className = cls;
  }
  if (text !== undefined) {
    n.textContent = text;
  }
  return n;
}

export function mountAppBehaviorSettings(body) {
  body.append(mk('p', 'pv-lbl', 'When I switch room or workgroup, the app on the right'));
  const chips = mk('div', 'pv-chips');
  chips.setAttribute('role', 'radiogroup');
  chips.setAttribute('aria-label', 'When I switch room or workgroup, the app on the right');
  const note = mk('p', 'pv-note');
  const msg = mk('p', 'pv-msg');
  const paint = () => {
    const cur = getSwitchMode();
    for (const b of chips.children) {
      const on = b.dataset.mode === cur;
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-checked', String(on));
    }
    note.textContent = MODE_TEXT[cur][1];
  };
  for (const m of SWITCH_MODES) {
    const b = mk('button', 'pv-chip', MODE_TEXT[m][0]);
    b.type = 'button';
    b.dataset.mode = m;
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => {
      setSwitchMode(m);
      paint();
      msg.textContent = 'Saved on this device.';
    });
    chips.append(b);
  }
  body.append(chips, note, msg);
  paint();
  return { update() { paint(); } };
}
