// Shared native-radio picker. Palettes are scoped to individual swatch faces.
const mounted = new Set();
let serial = 0;
export function createColorSwatches({choices, value, label, paint, choose, current = () => true}) {
  if (!Array.isArray(choices) || choices.length < 1 || choices.length > 12 ||
      new Set(choices.map(c => c?.value)).size !== choices.length ||
      choices.some(c => typeof c?.value !== 'string' || !c.value || c.value.length > 80 ||
        typeof c.label !== 'string' || !c.label || c.label.length > 100 || !/^#[a-f0-9]{6}$/i.test(c.seed)) ||
      typeof paint !== 'function' || typeof choose !== 'function') throw new Error('Invalid swatch choices');
  const entries = choices.map(c => ({...c}));
  const el = document.createElement('div'); el.className = 'color-swatches';
  el.setAttribute('role', 'radiogroup'); el.setAttribute('aria-label', label);
  const name = 'color-swatches-' + ++serial, controls = [];
  let selected = value, busy = false, alive = true;
  function marks() {
    for (const c of controls) { c.input.checked = c.choice.value === selected; c.face.dataset.current = String(c.input.checked); }
    el.setAttribute('aria-busy', String(busy));
  }
  async function activate(candidate) {
    if (!alive || busy || !current() || candidate === selected) { marks(); return; }
    busy = true; marks();
    try { if (await choose(candidate) !== false && alive && current()) selected = candidate; }
    catch { /* The owner reports the failure; retain the last acknowledged mark. */ }
    finally { busy = false; if (alive) marks(); }
  }
  for (const choice of entries) {
    const face = document.createElement('label'); face.className = 'color-swatch'; face.title = choice.label;
    const input = document.createElement('input'); input.type = 'radio'; input.name = name; input.value = choice.value;
    input.setAttribute('aria-label', choice.label); input.title = choice.label;
    const check = document.createElement('span'); check.className = 'color-swatch-check'; check.textContent = '✓'; check.setAttribute('aria-hidden', 'true');
    input.addEventListener('change', () => input.checked ? activate(choice.value) : undefined);
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); return activate(choice.value); } });
    face.append(input, check); el.append(face); controls.push({input, face, choice});
  }
  const api = {
    el,
    focus() { if (alive && current()) (controls.find(c => c.choice.value === selected) || controls[0]).input.focus(); },
    setValue(next) { if (alive && entries.some(c => c.value === next)) { selected = next; marks(); } },
    repaint() { if (alive && current()) for (const c of controls) paint(c.face, c.choice); },
    dispose() { alive = false; mounted.delete(api); el.remove(); },
  };
  mounted.add(api); marks(); api.repaint(); return api;
}
export function refreshColorSwatches() { for (const picker of mounted) picker.repaint(); }
