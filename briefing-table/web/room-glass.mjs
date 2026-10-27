/* BUBBLE GLASS [bubble glass] (Owner 2026-10-05, room [ref]; the design system numbers, handoff sec 1.J,
 * the design system d40c2a5): a ROOM override that scales the bubble transparency. The defaults stay
 * (PC 25% clear + 5px blur; phone 50% clear, no blur, web/room-bubbles.css) and the room's
 * `bubble_glass` is one strength m (a percent 50-200, null = 100) that scales BOTH, so moving
 * it at the PC moves the phone too:
 *   PC     clear = min(50%, 25% x m)    blur = 5px x (2 - m), clamped 0-5px (it eases as the
 *                                       glass clears: 160% = 40% / 2px)
 *   phone  clear = min(80%, 50% x m)    no blur (the cap stops 200% erasing the phone's bubbles)
 * PC clear >= 40% sets body[data-bubble-see-through], the text lift already in room-bubbles.css
 * (desktop only). The phone's lift is unchanged (it stays on under html.phone-glass).
 *
 * THIS MODULE IS THE ONLY WRITER of --bubble-alpha / --bubble-blur / --phone-bubble-alpha and
 * of that attribute. A room with null (or 100) WRITES NOTHING: the stylesheet's defaults
 * stand, byte for byte. Integer math (g/4, g/2, (200-g)/20) so m=1.6 is exactly 40%. */
export const GLASS_MIN = 50;
export const GLASS_MAX = 200;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r1 = (v) => Math.round(v * 10) / 10;

/** The effective values for a stored magnitude (null = 100). */
export function glassValues(g) {
  const m = Number.isFinite(g) ? clamp(Math.round(g), GLASS_MIN, GLASS_MAX) : 100;
  return { m, pc: r1(Math.min(50, m / 4)), blur: r1(clamp((200 - m) / 20, 0, 5)), phone: r1(Math.min(80, m / 2)), pill: r1(Math.min(40, m / 5)) };
}

const TOP_LIFT = 40; // the see-through line, web/room-bubbles.css

/** Paint the room's magnitude (null/100 = remove everything written, the defaults stand). */
export function applyGlass(g) {
  const body = document.body;
  if (!Number.isFinite(g) || Math.round(g) === 100) {
    for (const p of ['--bubble-alpha', '--bubble-blur', '--phone-bubble-alpha', '--pill-clear']) {
      body.style.removeProperty(p);
    }
    delete body.dataset.bubbleSeeThrough;
    return;
  }
  const v = glassValues(g);
  body.style.setProperty('--bubble-alpha', `${v.pc}%`);
  body.style.setProperty('--bubble-blur', `${v.blur}px`);
  body.style.setProperty('--phone-bubble-alpha', `${v.phone}%`);
  body.style.setProperty('--pill-clear', `${v.pill}%`); // the small-text pills: 20% x m, capped at 40% (Owner 2026-10-05)
  if (v.pc >= TOP_LIFT) {
    body.dataset.bubbleSeeThrough = '';
  } else {
    delete body.dataset.bubbleSeeThrough;
  }
}

/** The readout for a magnitude, e.g. "160% . PC 40% / 2px . phone 80%". */
export function glassReadout(g) {
  const v = glassValues(g);
  return `${v.m}% \u00b7 PC ${Math.round(v.pc * 10) / 10}% / ${Math.round(v.blur * 10) / 10}px \u00b7 phone ${Math.round(v.phone * 10) / 10}%`;
}

/** The slider + readout + Reset, built into `host`. `get()` = the room's stored value,
 *  `save(g|null)` -> Promise<boolean> (room.js saveSettings {bubble_glass}). Returns {paint}.
 *  It applies live on `input` and saves on `change` (release), as the art sliders do. */
export function mountGlassSlider(host, get, save) {
  host.replaceChildren();
  host.innerHTML = '<div class="rs-row"><span>Bubble glass</span><input type="range" aria-label="Bubble glass"><output></output></div><p class="pv-note"><span class="bg-ro"></span> <a href="#" class="rs-reset">Reset</a></p>';
  const range = host.querySelector('input');
  range.min = String(GLASS_MIN);
  range.max = String(GLASS_MAX);
  range.step = '5';
  const out = host.querySelector('output');
  const ro = host.querySelector('.bg-ro');
  const reset = host.querySelector('.rs-reset');
  const show = (g) => {
    out.textContent = `${glassValues(g).m}%`;
    ro.textContent = glassReadout(g);
  };
  function paint() {
    const g = get();
    range.value = String(glassValues(g).m);
    reset.hidden = !Number.isFinite(g);
    show(g);
  }
  async function commit(g) {
    let ok = false;
    try {
      ok = await save(g);
    } catch {
      ok = false;
    }
    if (!ok) {
      applyGlass(get()); // the save said no (its message is on screen): show what is stored
    }
    paint();
  }
  range.addEventListener('input', () => {
    const g = +range.value;
    applyGlass(g); // mid-drag: the line follows, nothing saved yet
    show(g);
  });
  range.addEventListener('change', () => void commit(+range.value));
  reset.addEventListener('click', (e) => {
    e.preventDefault();
    applyGlass(null);
    void commit(null);
  });
  paint();
  return { paint };
}
