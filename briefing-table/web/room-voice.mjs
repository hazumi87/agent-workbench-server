/* ============================================================================
 * ROOM VOICE — the page's half of the Echo Dot in a workroom (W1,
 * the design notes §9–§10 and the §15 E1 wire contract; the look is
 * the design system room-voice-v1 mockup, A0 [ticket]).
 *
 * What lives here: the parts of the room page that exist only for voice and
 * know nothing about cells, the line or settings plumbing —
 *   - the STATUS the Voice cell header draws (glyph + word, never a stripe)
 *     and the phone's Apps badge
 *   - the voice-line head bits (to / re / via, the #vid) and meta notes
 *   - the Voice group in Room settings
 *
 * ONE OWNER FOR THE STATUS WORD (§9.4): Connected / Muted / Waiting are ENGINE
 * facts (the room view's top-level `voice`) and only the host's cell header
 * draws them. "Connected" is dropped once Muted or Waiting shows (it is
 * implied: the cell exists only while connected); Muted and Waiting are
 * independent and read together ("Muted · Waiting"). "Speaking" is the
 * FRAME's to draw, never the header's (A0). Colour is function: connected
 * --teal, muted --dim (a choice, not a warning), waiting --coral (the ONLY
 * coral).
 * ========================================================================== */

const NS = 'http://www.w3.org/2000/svg';

const PATHS = {
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/><path d="M8.5 21h7"/>',
  muted: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/><path d="M8.5 21h7"/><path d="M4 4l16 16"/>',
  speaker: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6"/><path d="M18 6.8a7.4 7.4 0 0 1 0 10.4"/>',
  dot: '<circle class="fill" cx="12" cy="12" r="5"/>',
  ring: '<circle cx="12" cy="12" r="8.5"/><circle class="fill" cx="12" cy="12" r="3.8"/>',
  /* The Dot puck (Owner, room line [ref]): the paths pinned at room line [ref]
     and used verbatim by voice-svc's panel too, so the two surfaces are
     identical. A flat puck at the bottom, arcs above: waves OUT (wifi arcs,
     smallest nearest) = the AGENT's voice (mute = the agent stops speaking,
     not Owner's mic); waves IN (smile arcs, largest nearest) = the open mic.
     The check sits top-right (line 1033) so it clears the puck at 28px. */
  puckOut: '<rect x="5" y="14" width="14" height="7" rx="3.5"/><path d="M9 11.5Q12 9.5 15 11.5"/><path d="M7 8.5Q12 5 17 8.5"/><path d="M5 5.5Q12 0.5 19 5.5"/>',
  puckIn: '<rect x="5" y="14" width="14" height="7" rx="3.5"/><path d="M9.5 3Q12 5 14.5 3"/><path d="M7.5 6Q12 9 16.5 6"/><path d="M5.5 9Q12 13 18.5 9"/>',
  /* the state marks, drawn over a puck: a slash (off) and a check (on) */
  slash: '<path class="vm-off" d="M4 4l16 16"/>',
  check: '<path class="vm-on" d="M16 5l2 2 4-4.5"/>',
};

/** A puck glyph with its state mark: 'off' adds the slash, 'on' the check. */
export function puckGlyph(name, mark, size = 18) {
  const svg = voiceGlyph(name, size);
  /* the room titlebar's settings icon, measured (room line [ref]): an 18px
     glyph (22px on a phone, by CSS) at stroke 1.7 — panel and host alike */
  svg.setAttribute('stroke-width', '1.7');
  svg.style.strokeWidth = '1.7';
  svg.innerHTML += mark === 'off' ? PATHS.slash : mark === 'on' ? PATHS.check : '';
  return svg;
}

/** A 24-unit stroke glyph by name (a constant from PATHS, never caller text). */
export function voiceGlyph(name, size = 14) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', `vg vg-${name}`);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = PATHS[name] ?? PATHS.mic;
  return svg;
}

/** The engine's `voice` (or null), cleaned to exactly the contract's fields. */
export function cleanVoice(v) {
  if (!v || typeof v !== 'object') {
    return null;
  }
  return {
    connected: v.connected === true,
    device: typeof v.device === 'string' ? v.device.slice(0, 80) : '',
    since: Number.isFinite(v.since) ? v.since : null,
    muted: v.muted === true,
    waiting: v.waiting === true,
    idInRoom: v.idInRoom !== false, // absent (an older engine) = on, the default
    openMic: v.openMic !== false, // absent = on, the room default (Owner, room line [ref])
  };
}

/** The header's parts, in reading order: [{key, word, glyph}]. */
export function statusParts(voice) {
  if (!voice || !voice.connected) {
    return [{ key: 'off', word: 'Not connected', glyph: 'mic' }];
  }
  const out = [];
  if (voice.muted) {
    out.push({ key: 'muted', word: 'Muted', glyph: 'muted' });
  }
  if (voice.waiting) {
    out.push({ key: 'waiting', word: 'Waiting', glyph: 'ring' });
  }
  const parts = out.length ? out : [{ key: 'connected', word: 'Connected', glyph: 'dot' }];
  if (voice.idInRoom === false) {
    /* a setting, not a warning: dim, never coral (Owner, room line [ref]) */
    parts.push({ key: 'idoff', word: 'ID off', glyph: null });
  }
  return parts;
}

/** Fill `el` (the cell header's status slot): glyph + word, joined " · ". */
export function paintStatus(el, voice) {
  el.textContent = '';
  const parts = statusParts(voice);
  parts.forEach((p, i) => {
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'vs-sep';
      sep.textContent = '·';
      el.append(sep);
    }
    const s = document.createElement('span');
    s.className = 'vs-part';
    s.dataset.state = p.key;
    if (p.glyph) {
      s.append(voiceGlyph(p.glyph, 12));
    }
    s.append(p.word);
    el.append(s);
  });
  el.title = `Voice: ${parts.map((p) => p.word).join(' · ')}${voice?.device ? ` · ${voice.device}` : ''}`;
}

/** PHONE badge on Apps (A0 §2): glyph only. Waiting (a coral dot, coral
 *  hairline) > Muted (the muted mic, --dim) > Connected (a teal dot).
 *  Muted AND waiting = coral, also carrying the muted mic. No connection =
 *  no badge. */
export function paintBadge(el, voice) {
  el.textContent = '';
  if (!voice || !voice.connected) {
    el.hidden = true;
    delete el.dataset.state;
    el.removeAttribute('title');
    return;
  }
  el.hidden = false;
  const state = voice.waiting ? 'waiting' : voice.muted ? 'muted' : 'connected';
  el.dataset.state = state;
  if (state !== 'muted') {
    const d = document.createElement('span');
    d.className = 'vb-dot';
    el.append(d);
  }
  if (voice.muted) {
    el.append(voiceGlyph('muted', 11));
  }
  el.title = `Voice: ${statusParts(voice).map((p) => p.word).join(' · ')}`;
}

/* ------------------------------------------------------------- the line ---- */

/** A line's parsed meta, or {} (the engine's opaque JSON). */
export function metaOf(e) {
  try {
    const m = typeof e.meta === 'string' ? JSON.parse(e.meta) : e.meta;
    return m && typeof m === 'object' ? m : {};
  } catch {
    return {};
  }
}

const VID_RE = /^v[0-9a-z]{1,12}$/;
const REASON_WORDS = {
  'not-connected': 'not connected',
  muted: 'muted',
  device_busy: 'busy',
  busy: 'busy',
};

/** The dim notes under a voice line (A0 §3): over cap, fallback to the lead,
 *  not spoken. [] when none apply. */
export function voiceNotes(e) {
  const m = metaOf(e);
  const notes = [];
  if (m.dir === 'in' && m.speakerVerified === false) {
    notes.push('voice not verified'); // Owner's idInRoom off: the engine skipped its speaker allowlist
  }
  if (m.overCap === true) {
    notes.push('summarized aloud · full text here');
  }
  if (m.resolved === 'fallback-lead') {
    const heard = typeof m.route?.to === 'string' && m.route.to !== 'lead' ? m.route.to.slice(0, 60) : '';
    notes.push(heard ? `heard '${heard}', no seat matched` : 'no seat matched, passed to the lead');
  }
  if (m.spoken === false && m.reason === 'sending') {
    notes.push('speaking…'); // the voice service has not answered yet; the outcome replaces this
  } else if (m.spoken === false) {
    const r = typeof m.reason === 'string' ? (REASON_WORDS[m.reason] ?? m.reason.replace(/^device_/, '').replace(/[_-]/g, ' ')) : '';
    notes.push(r ? `not spoken · ${r}` : 'not spoken');
  }
  return notes;
}

/** A node holding the notes, or null. */
export function voiceNotesNode(e) {
  const notes = voiceNotes(e);
  if (!notes.length) {
    return null;
  }
  const p = document.createElement('div');
  p.className = 'entry-vnotes';
  p.textContent = notes.join(' · ');
  return p;
}

/** The head bits after the author and the speaker glyph (A0 §3):
 *   you, in:          "to @the design system" | "to the lead" | "to the voice agent", #vid
 *   a seat's reply:   "re #v4k7", #vid
 *   the voice agent:  "via voice agent", "re #…", #vid
 *  The target comes from the line's own fields (the engine resolved it),
 *  never from the words. */
export function voiceHeadNodes(e, { byVoiceAgent, leadHandle }) {
  const m = metaOf(e);
  const out = [];
  const span = (cls, text) => {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  };
  if (byVoiceAgent) {
    out.push(span('entry-vdir', 'via voice agent'));
  } else if (m.dir === 'in') {
    const to = !e.target ? 'to the voice agent' : e.target === 'lead' || (leadHandle && e.target === leadHandle && m.route?.to === 'lead') ? 'to the lead' : `to @${e.target}`;
    out.push(span('entry-vdir', to));
  }
  const re = (Array.isArray(m.re) ? m.re : typeof m.re === 'string' ? [m.re] : []).filter((v) => typeof v === 'string' && VID_RE.test(v));
  if (re.length) {
    out.push(span('entry-vdir', `re ${re.map((v) => `#${v}`).join(' ')}`));
  }
  if (typeof m.vid === 'string' && VID_RE.test(m.vid)) {
    out.push(span('entry-vid', `#${m.vid}`));
  }
  return out;
}

/* ------------------------------------------------------------- settings ---- */

/* THE SPLIT (Owner, room interface line 1165; room line [ref]): the voice settings
 * are the USER's globals (every room) plus four PER-ROOM keys. Room settings
 * edits only ROOM_KEYS (room.voice); the user's globals live in
 * web/voice-global-settings.mjs (/api/rooms/me voice). Global off = voice
 * off everywhere; global on = the room's own `enabled` decides. */
export const ROOM_KEYS = ['enabled', 'character', 'paraphrase', 'spokenName'];
export const VOICE_DEFAULTS = { enabled: true, character: null, paraphrase: 'off', spokenName: null };
const PARAPHRASE = [['off', 'Off'], ['subtle', 'Subtle'], ['full', 'Full']];

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

/** The room's stored voice keys over the defaults. */
export function voiceSettings(room) {
  const v = room?.voice && typeof room.voice === 'object' ? room.voice : {};
  const out = { ...VOICE_DEFAULTS };
  for (const k of ROOM_KEYS) {
    if (k in v) {
      out[k] = v[k];
    }
  }
  return out;
}

/** The keys of `draft` that differ from `saved`: only those are sent
 *  (per-key merge; null is a value, never "keep"). */
export function changedKeys(saved, draft, keys = ROOM_KEYS) {
  const out = {};
  for (const k of keys) {
    if (draft[k] !== saved[k]) {
      out[k] = draft[k];
    }
  }
  return out;
}

/**
 * The Voice group for Room settings: the four PER-ROOM keys. Greyed, with
 * "Voice is off in your global settings", while the user's global switch is
 * off (the room's own values are kept and shown, just not in force).
 * @param {{room: object, voiceGlobal?: {enabled: boolean} | null,
 *          save: (patch: object, msg: HTMLElement) => Promise<boolean>,
 *          characters: () => Promise<{ok: boolean, list?: {id,name,description?}[], error?: string}>}} o
 */
export function voiceSettingsGroup(o) {
  const g = mk('div', 'pv-grp pv-voice');
  let saved = voiceSettings(o.room);
  const draft = { ...saved };
  let catalogue = 'loading'; // loading | up | down
  const globalOff = o.voiceGlobal?.enabled === false;

  /* the header: VOICE, and this room's Enabled as its switch */
  const hd = mk('div', 'pv-vhd');
  const sw = mk('button', 'pv-switch');
  sw.type = 'button';
  sw.id = 'voiceEnabled';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-label', 'Voice can connect to this room');
  sw.append(mk('span', 'pv-knob'));
  hd.append(mk('h4', '', 'Voice'), sw);
  const off = mk('p', 'pv-hint pv-goff', 'Voice is off in your global settings');
  off.id = 'voiceGlobalOff';
  off.hidden = !globalOff;
  const body = mk('div', 'pv-vbody'); // everything the global switch greys
  const rest = mk('div', 'pv-vrest'); // everything this room's switch greys

  /* character: "Room default" stands in for null; three outcomes */
  const chLabel = mk('label', 'pv-field');
  chLabel.append(mk('span', 'pv-flabel', 'Character'));
  const ch = mk('select', 'pv-sel');
  ch.id = 'voiceCharacter';
  chLabel.append(ch);
  const chNote = mk('p', 'pv-hint');
  chNote.hidden = true;
  chLabel.append(chNote);
  const fillCharacters = (list) => {
    ch.textContent = '';
    const def = mk('option', '', 'Room default');
    def.value = '';
    ch.append(def);
    for (const c of list) {
      const op = mk('option', '', c.name || c.id);
      op.value = c.id;
      if (c.description) {
        op.title = c.description;
      }
      ch.append(op);
    }
    if (draft.character && !list.some((c) => c.id === draft.character)) {
      const op = mk('option', '', `${draft.character} (not in the catalog)`);
      op.value = draft.character;
      ch.append(op);
    }
    ch.value = draft.character ?? '';
  };
  fillCharacters([]);
  void o.characters().then((r) => {
    if (r.ok) {
      catalogue = 'up';
      fillCharacters(r.list ?? []);
    } else {
      /* down: keep the stored id, show it, never save it away */
      catalogue = 'down';
      ch.textContent = '';
      const op = mk('option', '', `${draft.character ?? 'Room default'} · catalog unavailable`);
      op.value = draft.character ?? '';
      ch.append(op);
      chNote.hidden = false;
      chNote.textContent = `The characters list didn't load${r.error ? ` (${r.error})` : ''}. Your choice is kept.`;
    }
    ch.dataset.catalogue = catalogue;
    paint();
  });
  ch.addEventListener('change', () => { draft.character = ch.value || null; });

  /* paraphrase: segmented */
  const pp = mk('div', 'pv-seg');
  pp.setAttribute('role', 'group');
  pp.setAttribute('aria-label', 'Paraphrase');
  for (const [v, label] of PARAPHRASE) {
    const b = mk('button', 'pv-segb', label);
    b.type = 'button';
    b.dataset.v = v;
    b.addEventListener('click', () => {
      draft.paraphrase = v;
      paint();
    });
    pp.append(b);
  }
  const ppLabel = mk('div', 'pv-field');
  ppLabel.append(mk('span', 'pv-flabel', 'Paraphrase'), pp, mk('p', 'pv-hint', 'How freely the character restyles replies.'));

  const snLabel = mk('label', 'pv-field');
  const sn = mk('input', 'pv-text');
  sn.type = 'text';
  sn.id = 'voiceSpokenName';
  sn.maxLength = 60;
  sn.placeholder = o.room?.name ?? '';
  sn.addEventListener('input', () => {
    const t = sn.value.trim();
    draft.spokenName = t ? t : null;
  });
  snLabel.append(mk('span', 'pv-flabel', 'Spoken name'), sn, mk('p', 'pv-hint', 'What you say to reach this room. Up to 60 characters.'));

  const acts = mk('div', 'pv-acts');
  const save = mk('button', 'pv-btn pri', 'Save voice');
  save.type = 'button';
  save.id = 'voiceSave';
  const msg = mk('p', 'pv-msg');
  msg.setAttribute('role', 'status');
  acts.append(save);
  const more = mk('p', 'pv-hint pv-gmore', 'Word cap, idle disconnect, open mic and voice ID apply to every room: Workbench → Settings.');

  function paint() {
    const on = draft.enabled !== false;
    sw.setAttribute('aria-checked', String(on));
    /* off greys the rest (inert) but KEEPS the values: on again restores them */
    rest.classList.toggle('off', !on);
    rest.inert = !on;
    body.classList.toggle('off', globalOff);
    body.inert = globalOff;
    sw.disabled = globalOff;
    for (const b of pp.children) {
      b.setAttribute('aria-pressed', String(b.dataset.v === draft.paraphrase));
    }
    ch.disabled = catalogue !== 'up';
    sn.value = draft.spokenName ?? '';
  }
  sw.addEventListener('click', () => {
    draft.enabled = draft.enabled === false;
    paint();
  });
  save.addEventListener('click', async () => {
    const patch = changedKeys(saved, draft);
    if (catalogue !== 'up') {
      delete patch.character; // never save a stored id away while the catalog is down
    }
    if (!Object.keys(patch).length) {
      msg.textContent = 'Nothing changed';
      msg.dataset.kind = '';
      return;
    }
    if (await o.save({ voice: patch }, msg)) {
      saved = { ...saved, ...patch };
    }
  });

  rest.append(chLabel, ppLabel, snLabel);
  body.append(rest, acts, msg);
  g.append(hd, off, body, more);
  paint();
  return g;
}
