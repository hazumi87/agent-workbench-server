/* ============================================================================
 * GLOBAL COLOR PALETTE (hub V2, Owner 2026-10-05; handoff §1 D). Mounted by
 * web/settings.mjs like every group (contract at the top of that file).
 *
 * The app's base colors for every room and app: a palette select (20 + Customize…),
 * Dark | Light, ten swatches. Locked starters; Customize… unlocks the pickers,
 * seeded from the palette you are on. Every change APPLIES AT ONCE (web/palette.mjs
 * `remember`, which also feeds the first-paint cache every other page reads) and
 * is saved per person (PATCH /api/rooms/me {palette}). Under it: the app title-bar
 * tones summary (the same swatches live on each app's card under Apps).
 *
 * The pure helpers are exported for the source test.
 * ========================================================================== */
import { PALETTES, MODES, CUSTOM_KEYS, tokens, seed, remember } from '/palette.mjs';
import { BUILTIN_APPS } from '/app-tones.mjs';
import { toneSwatches } from '/settings-tones.mjs';

export const LABELS = { ink: 'background', surface: 'surface', text: 'text', accent: 'go accent', neutral: 'neutral', cobalt: 'cobalt', green: 'green', orchid: 'orchid', violet: 'violet', orange: 'orange' };
export const DEFAULT_PREF = { key: 'aurora', mode: 'dark' };

/** me.palette, or the design system dark when the server sent none or nonsense. */
export function prefOf(me) {
  const p = me && me.palette;
  return p && PALETTES[p.key] ? { key: p.key, mode: MODES.includes(p.mode) ? p.mode : 'dark', ...(p.custom ? { custom: p.custom } : {}) } : { ...DEFAULT_PREF };
}

/** The ten colors the swatches show for a pref (custom: its own; else generated). */
export function swatchColors(pref, cs) {
  if (PALETTES[pref.key]?.custom && pref.custom) {
    return pref.custom;
  }
  return seed(pref.key, cs, pref.mode);
}

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

function ensureStyles() {
  if (document.querySelector('link[data-settings-palette]')) {
    return;
  }
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = `/settings-palette.css${new URL(import.meta.url).search}`;
  l.dataset.settingsPalette = '1';
  document.head.append(l);
}

export async function mountPaletteSettings(el, { me, save }) {
  ensureStyles();
  let pref = prefOf(me);
  let timer = 0;
  const msg = mk('p', 'pv-msg');
  msg.setAttribute('role', 'status');
  const say = (t) => {
    msg.textContent = t || '';
    msg.dataset.kind = t ? 'error' : '';
  };

  const sel = mk('select', 'pv-sel gp-sel');
  sel.setAttribute('aria-label', 'Palette');
  for (const [k, p] of Object.entries(PALETTES)) {
    const o = mk('option', '', p.custom ? p.name : `${p.name} · ${p.sub}`);
    o.value = k;
    sel.append(o);
  }
  const seg = mk('span', 'pv-seg2');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Dark or light');
  for (const m of MODES) {
    const b = mk('button', '', m === 'dark' ? 'Dark' : 'Light');
    b.type = 'button';
    b.dataset.m = m;
    seg.append(b);
  }
  const row = mk('div', 'gp-row');
  row.append(sel, seg);
  const chips = mk('div', 'gp-chips');
  const strip = mk('div', 'gp-strip');
  const customNote = mk('p', 'pv-note');
  customNote.hidden = true;
  customNote.textContent = 'Customize sets its own Dark or Light from the background color.';

  const tbList = mk('div', 'tb-list');
  const swatches = [];
  const tbMsg = mk('p', 'pv-msg');
  const tbSay = (t) => {
    tbMsg.textContent = t || '';
    tbMsg.dataset.kind = t ? 'error' : '';
  };
  const seats = mk('span', 'tb-bar', 'Seats');
  seats.style.setProperty('--c', 'var(--room-c, #5a6672)');
  tbList.append(seats, mk('span', 'pv-note gp-fixed', 'the room color, always'));
  for (const a of BUILTIN_APPS) {
    const bar = mk('span', 'tb-bar', a.name);
    bar.dataset.key = a.key;
    const sw = toneSwatches({ key: a.key, name: a.name }, me, save, tbSay, paintTones);
    swatches.push({ bar, sw, a });
    tbList.append(bar, sw);
  }
  function paintTones() {
    for (const { bar, sw, a } of swatches) {
      sw.repaint();
      const cur = sw.querySelector('[aria-pressed="true"]')?.dataset.tone ?? a.tone;
      bar.style.setProperty('--c', `var(--id-${cur})`);
    }
  }

  function paint() {
    const isC = !!PALETTES[pref.key]?.custom;
    sel.value = pref.key;
    for (const b of seg.children) {
      b.setAttribute('aria-pressed', String(b.dataset.m === pref.mode));
      b.disabled = isC;
    }
    customNote.hidden = !isC;
    const vals = swatchColors(pref, getComputedStyle(document.documentElement));
    chips.replaceChildren();
    strip.replaceChildren();
    for (const k of CUSTOM_KEYS) {
      const lab = mk('label', 'gp-chip');
      const inp = mk('input');
      inp.type = 'color';
      inp.dataset.gk = k;
      inp.value = vals[k];
      inp.disabled = !isC;
      lab.append(inp, document.createTextNode(LABELS[k]));
      chips.append(lab);
      const i = mk('i');
      i.style.background = vals[k];
      strip.append(i);
    }
    paintTones();
  }

  /* apply now (this page and, via the cache + storage event, every other), save after */
  function commit(next, wait = 0) {
    const prev = pref;
    pref = next;
    remember(document, pref);
    paint();
    clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = 0;
      try {
        say('');
        await save({ palette: pref });
      } catch (e) {
        pref = prev;
        remember(document, pref);
        paint();
        say(`Not saved: ${e?.message ?? e}`);
      }
    }, wait);
  }

  sel.addEventListener('change', () => {
    const key = sel.value;
    const next = { key, mode: pref.mode };
    if (pref.custom) {
      next.custom = pref.custom;
    }
    if (PALETTES[key]?.custom) {
      /* Customize...: unlock the pickers on a copy of the palette you are on */
      next.custom = swatchColors(pref, getComputedStyle(document.documentElement));
    }
    commit(next);
  });
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]');
    if (b && !b.disabled && b.dataset.m !== pref.mode) {
      commit({ ...pref, mode: b.dataset.m });
    }
  });
  /* a picker drag fires `input` constantly: paint locally each time, save once it settles */
  chips.addEventListener('input', (e) => {
    const k = e.target.dataset?.gk;
    if (!k || !PALETTES[pref.key]?.custom) {
      return;
    }
    const custom = { ...(pref.custom ?? swatchColors(pref, getComputedStyle(document.documentElement))), [k]: e.target.value };
    pref = { ...pref, custom };
    remember(document, pref);
    strip.children[CUSTOM_KEYS.indexOf(k)].style.background = e.target.value;
    clearTimeout(timer);
    const snap = pref;
    timer = setTimeout(() => {
      timer = 0;
      commit(snap);
    }, 500);
  });

  const h4 = mk('h4', '', 'App title bars');
  h4.style.marginTop = '16px';
  el.append(
    mk('p', 'pv-note gp-first', "The app's base colors, for every room and every app: background, surfaces, text, the go accent, and the identity tones the tools wear. Each palette has a Dark and a Light version."),
    row,
    chips,
    strip,
    customNote,
    mk('p', 'pv-note', 'Locked starters; Customize… unlocks the pickers. It applies at once and is saved with your profile, for every room and device.'),
    msg,
    h4,
    mk('p', 'pv-note gp-first', "Each app wears one tone in every room's rail (the Seats bar always takes the room color). Set it here or on the app's card under Apps."),
    tbList,
    tbMsg,
  );
  paint();
  return {
    update(next) {
      /* changed elsewhere (another tab, a refetch): repaint, unless a pick is mid-save */
      if (timer) {
        return;
      }
      const p = prefOf(next);
      if (JSON.stringify(p) !== JSON.stringify(pref)) {
        pref = p;
        remember(document, pref);
      }
      paint();
    },
  };
}
