// F1's one-time hint at the rail flag (the design, step 2): "Your CLIs are listed here". Not modal, the terminal keeps the
// keyboard; dismissed by Got it, the flag, Esc or Ctrl+Shift+L (remembered in config, never per window). A docked rail
// has no flag and its panel (z-index 32) would paint over the tip (z-index 31), so docking removes it WITHOUT
// remembering it: it was never really seen and may show on a later start when the rail is not docked.
export function createCoach({ document, host, canShow, remember, watchDocked }) {
  let node = null;
  function show() {
    if (node || !canShow()) return;
    node = document.createElement('div');
    node.className = 'coach';
    node.setAttribute('role', 'note');
    node.innerHTML = '<div class="t">Your CLIs are listed here</div><div class="b">Open the list any time, or press Ctrl+Shift+L.</div><div class="a"><button>Got it</button></div>';
    node.querySelector('button').addEventListener('click', () => dismiss(true));
    host.appendChild(node);
  }
  function dismiss(save = true) {
    if (!node) return false;
    node.remove();
    node = null;
    if (save) remember();
    return true;
  }
  watchDocked?.(() => dismiss(false));
  return { show, dismiss, shown: () => !!node };
}
