/* ============================================================================
 * VOICE — YOUR SETTINGS FOR EVERY ROOM (Owner, room interface line 1165; room voice
 * line 1167). The user's voice GLOBALS, mounted by the CLI Manager's Settings
 * page (web/settings.mjs, the room interface lead's):
 *
 *   const { mountVoiceGlobals } = await import('/voice-global-settings.mjs');
 *   mountVoiceGlobals(el, { me, save });
 *
 *   me    the latest GET /api/rooms/me; its `voice` holds the globals
 *   save  (patch) => PATCHes /api/rooms/me with {voice: patch}; resolves to
 *         the new `me`, or throws an Error carrying the server's message
 *
 * Returns {update(me)} so the page can repaint after an outside change (the
 * voice tool's live toggles write the same keys).
 *
 * GLOBAL keys: enabled (the master: off = voice off in EVERY room), wordCap,
 * idleDisconnect + idleMinutes, openMic, idOnConnect, idInRoom; inputs are
 * shown, fixed (Echo only in Crawl). The four PER-ROOM keys stay in each
 * room's Room settings (web/room-voice.mjs).
 *
 * Styling: the Settings page's pv-* classes where they exist (pv-lbl,
 * pv-note, pv-msg, pv-btn.pri, pv-in: web/settings.css); its own
 * voice-global-settings.css only for what the page has no class for (the
 * master switch, the switch rows, the paired fields). The page draws the
 * group's "Voice" title, so this module draws none. Only the keys that
 * changed are sent (per-key merge).
 * ========================================================================== */

export const GLOBAL_KEYS = ['enabled', 'wordCap', 'idleDisconnect', 'idleMinutes', 'openMic', 'idOnConnect', 'idInRoom'];
export const GLOBAL_DEFAULTS = {
  enabled: true, wordCap: 40, idleDisconnect: true, idleMinutes: 30, openMic: true, idOnConnect: true, idInRoom: true,
  inputs: { echo: true, desktop: false, browser: false },
};
const SWITCHES = [
  ['openMic', 'Open mic after each reply', 'Off: say "hey jarvis" before every answer.'],
  ['idOnConnect', 'Identify the speaker to connect', 'Off: anyone at the Dot can connect a room.'],
  ['idInRoom', 'Identify the speaker on every turn', 'Off: any voice at the Dot reaches the room; its lines are marked "voice not verified".'],
  ['idleDisconnect', 'Disconnect when idle', 'Off: a connection stays open until someone disconnects it.'],
];

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
  if (document.querySelector('link[data-vgs]')) {
    return;
  }
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = '/voice-global-settings.css';
  l.dataset.vgs = '1';
  document.head.append(l);
}

/** The user's stored globals over the defaults. */
export function voiceGlobals(me) {
  const v = me?.voice && typeof me.voice === 'object' ? me.voice : {};
  const out = { ...GLOBAL_DEFAULTS, inputs: { ...GLOBAL_DEFAULTS.inputs } };
  for (const k of GLOBAL_KEYS) {
    if (k in v) {
      out[k] = v[k];
    }
  }
  if (v.inputs && typeof v.inputs === 'object') {
    out.inputs = { ...out.inputs, ...v.inputs };
  }
  return out;
}

/**
 * @param {HTMLElement} el
 * @param {{me: object, save: (patch: object) => Promise<object>}} o
 */
export function mountVoiceGlobals(el, o) {
  ensureStyles();
  let saved = voiceGlobals(o.me);
  let draft = { ...saved };
  el.textContent = '';
  const g = mk('section', 'vgs');
  g.setAttribute('aria-label', 'Voice');

  /* the MASTER switch (the page draws the group's "Voice" title) */
  const hd = mk('div', 'vgs-hd');
  const sw = mk('button', 'vgs-switch');
  sw.type = 'button';
  sw.id = 'vgsEnabled';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-label', 'Voice on, in every room');
  sw.append(mk('span', 'vgs-knob'));
  hd.append(mk('span', 'pv-lbl vgs-master', 'Voice on, in every room'), sw);
  const lede = mk('p', 'pv-note vgs-lede');
  const rest = mk('div', 'vgs-rest');

  /* word cap + idle minutes */
  const num = (id, label, min, max, key, hint) => {
    const l = mk('label', 'vgs-field');
    const i = mk('input', 'pv-in vgs-num');
    i.type = 'number';
    i.id = id;
    i.min = String(min);
    i.max = String(max);
    i.step = '1';
    i.addEventListener('input', () => {
      const n = Math.round(Number(i.value));
      draft[key] = Number.isFinite(n) ? n : draft[key];
    });
    l.append(mk('span', 'pv-lbl', label), i, mk('p', 'pv-note', hint));
    return { l, i };
  };
  const cap = num('vgsWordCap', 'Word cap', 15, 120, 'wordCap', '15–120 words. Longer replies are summarized aloud.');
  const idle = num('vgsIdle', 'Idle disconnect', 5, 240, 'idleMinutes', '5–240 minutes.');
  const pair = mk('div', 'vgs-pair');
  pair.append(cap.l, idle.l);

  /* the switches: open mic, then security */
  const boxes = {};
  const list = mk('div', 'vgs-field vgs-list');
  for (const [k, label, hint] of SWITCHES) {
    if (k === 'idOnConnect') {
      list.append(mk('span', 'pv-lbl vgs-sub', 'Security'));
    }
    const l = mk('label', 'vgs-check');
    const b = mk('input');
    b.type = 'checkbox';
    b.id = `vgs-${k}`;
    b.addEventListener('change', () => {
      draft[k] = b.checked;
      paint();
    });
    boxes[k] = b;
    const words = mk('span', 'vgs-words');
    words.append(mk('span', '', label), mk('small', 'pv-note', hint));
    l.append(b, words);
    list.append(l);
  }

  /* inputs: Echo fixed on; the rest shown, disabled (a live-looking toggle
     that does nothing is a trap) */
  const ins = mk('div', 'vgs-field');
  ins.append(mk('span', 'pv-lbl', 'Inputs'));
  const inBoxes = {};
  for (const [k, label] of [['echo', 'Echo Dot'], ['desktop', 'Desktop mic'], ['browser', 'Browser mic']]) {
    const l = mk('label', 'vgs-check vgs-fixed');
    const b = mk('input');
    b.type = 'checkbox';
    b.disabled = true;
    inBoxes[k] = b;
    l.append(b, ` ${label}`);
    ins.append(l);
  }
  ins.append(mk('p', 'pv-note', 'Echo only in Crawl.'));

  const acts = mk('div', 'vgs-acts');
  const save = mk('button', 'pv-btn pri', 'Save voice');
  save.type = 'button';
  save.id = 'vgsSave';
  const msg = mk('p', 'pv-msg');
  msg.setAttribute('role', 'status');
  acts.append(save, msg);

  function paint() {
    const on = draft.enabled !== false;
    sw.setAttribute('aria-checked', String(on));
    lede.textContent = on
      ? 'These apply to every room. Each room also has its own on/off, character and spoken name in its Room settings.'
      : 'Voice is off in every room: rooms cannot be connected, and any connection closes.';
    /* off greys the rest (inert) but KEEPS the values: on again restores them */
    rest.classList.toggle('off', !on);
    rest.inert = !on;
    cap.i.value = String(draft.wordCap);
    idle.i.value = String(draft.idleMinutes);
    idle.i.disabled = draft.idleDisconnect === false; // the length is kept, just not used
    for (const [k] of SWITCHES) {
      boxes[k].checked = draft[k] !== false;
    }
    inBoxes.echo.checked = true;
    inBoxes.desktop.checked = draft.inputs?.desktop === true;
    inBoxes.browser.checked = draft.inputs?.browser === true;
  }
  sw.addEventListener('click', () => {
    draft.enabled = draft.enabled === false;
    paint();
  });
  save.addEventListener('click', async () => {
    const patch = {};
    for (const k of GLOBAL_KEYS) {
      if (draft[k] !== saved[k]) {
        patch[k] = draft[k];
      }
    }
    if (!Object.keys(patch).length) {
      msg.textContent = 'Nothing changed';
      msg.dataset.kind = '';
      return;
    }
    msg.textContent = 'Saving…';
    msg.dataset.kind = '';
    save.disabled = true;
    try {
      const me = await o.save(patch);
      saved = voiceGlobals(me && me.voice ? me : { voice: { ...saved, ...patch } });
      draft = { ...saved };
      msg.textContent = 'Saved';
      paint();
    } catch (e) {
      /* the page's save throws with the server's message: show it here */
      msg.textContent = `Not saved: ${e?.message ?? e}`;
      msg.dataset.kind = 'error';
    } finally {
      save.disabled = false;
    }
  });

  /* THE CONVERSATION TEST PAGE (Owner, Voice Interaction line 7967): a speech
     test box, its own page (not a Workbench tab), so it opens in a new tab.
     Outside `rest`: it works whatever the voice switch says. */
  const test = mk('div', 'vgs-field');
  const link = mk('a', 'pv-btn', 'Conversation test page ↗');
  link.id = 'vgsTestPage';
  link.href = '/voice-test.html';
  link.target = '_blank';
  link.rel = 'noopener';
  test.append(mk('span', 'pv-lbl', 'Testing'), link, mk('p', 'pv-note', 'Talk to the page and watch how it splits your speech, when it says "ok" and when it asks to send. Nothing reaches an agent.'));

  rest.append(pair, list, ins);
  g.append(hd, lede, rest, acts, test);
  el.append(g);
  paint();
  return {
    /** Repaint from a fresh `me` (e.g. the voice tool changed a toggle). */
    update(me) {
      saved = voiceGlobals(me);
      draft = { ...saved };
      paint();
    },
  };
}
