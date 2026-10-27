/* THE CONCIERGE ICON AND FLY-OUT (the design notes P1).
 *
 * One module every surface uses: the room header, the phone Agents sheet, the
 * Workbench header, the shell's status menu and the solo window head. The
 * fly-out is the EXISTING agent chat (agent-chat.mjs createChat) pointed at the
 * Concierge pane: a side sheet on a desktop, a bottom sheet on a phone. No new
 * chat UI.
 *
 *   hidden   when the Concierge is off, has no recipe, or this is Basic (404)
 *   says so  when pane tokens are off (the prerequisite): the chat still works,
 *            the Concierge just cannot read the Workbench, and never falls back
 *            to the shared bearer
 *   badge    its replies since you last looked (GET /api/rooms/me/unread
 *            `concierge`, polled while the page is visible); opening the
 *            fly-out marks them seen (POST /api/concierge/seen)
 *   links    wb: chips resolved by the engine as it serves the chat: a new shell
 *            tab on a desktop, this tab on a phone
 *   toggle   the fly-out header switches between the primary and the fallback
 *            (manual in P0/P1; automatic on usage limits is P2)
 * Every await in a handler is caught and shown inline.
 */
import { createChat } from '/agent-chat.mjs';
import { shown, iconTitle, linkAction, openTabMessage } from '/concierge-core.mjs';
export { shown, iconTitle } from '/concierge-core.mjs';

const PHONE = '(max-width: 600px)';
const POLL_MS = 15_000;
const SEEN_MS = 10_000;

let status = null; // GET /api/concierge, or null (off, Basic, or unreachable)
let unread = 0;
const buttons = new Set();
let polling = false;
let offForGood = false; // GET /api/concierge answered 404: Basic, no Concierge exists to be off

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const SVGNS = 'http://www.w3.org/2000/svg';
/* THE CONCIERGE ICON (the design system [ref], approved by Owner): one filled path in a 960 box, `currentColor`; the swap of the old stroked bell.
   Source: workbench-app/review/concierge-icon.svg on the share. */
const CONCIERGE_PATH = 'M440 -80Q423 -80 411.5 -91.5Q400 -103 400 -120Q400 -137 411.5 -148.5Q423 -160 440 -160H880Q897 -160 908.5 -148.5Q920 -137 920 -120Q920 -103 908.5 -91.5Q897 -80 880 -80ZM440 -200Q440 -281 491.0 -341.5Q542 -402 620 -416V-441Q620 -458 631.5 -469.5Q643 -481 660 -481Q677 -481 688.5 -469.5Q700 -458 700 -441V-416Q777 -402 828.5 -341.5Q880 -281 880 -200ZM545 -281H773Q754 -308 724.5 -324.5Q695 -341 660 -341Q624 -341 594.0 -324.5Q564 -308 545 -281ZM659 -281Q659 -281 659.0 -281.0Q659 -281 659 -281Q659 -281 659.0 -281.0Q659 -281 659 -281ZM40 -520V-800Q40 -833 63.5 -856.5Q87 -880 120 -880H200Q224 -880 248.0 -863.0Q272 -846 280 -822L537 -894Q548 -897 560.0 -897.0Q572 -897 583 -893L852 -809Q865 -805 872.5 -794.5Q880 -784 880 -771V-760Q880 -710 845.0 -675.0Q810 -640 760 -640H680V-616Q680 -591 665.5 -570.5Q651 -550 628 -541L372 -445Q365 -443 358.5 -441.5Q352 -440 344 -440H120Q87 -440 63.5 -463.5Q40 -487 40 -520ZM120 -660V-520Q120 -520 120.0 -520.0Q120 -520 120 -520H200Q200 -520 200.0 -520.0Q200 -520 200 -520V-800Q200 -800 200.0 -800.0Q200 -800 200 -800H120Q120 -800 120.0 -800.0Q120 -800 120 -800ZM280 -630V-520Q280 -520 280.0 -520.0Q280 -520 280 -520H344Q344 -520 344.0 -520.0Q344 -520 344 -520L576 -605Q587 -609 593.5 -618.5Q600 -628 600 -640Q600 -640 600.0 -640.0Q600 -640 600 -640H529L450 -614Q434 -609 419.5 -616.5Q405 -624 400 -641Q395 -657 402.0 -671.0Q409 -685 425 -690L513 -720H760Q769 -720 782.5 -726.5Q796 -733 796 -742L558 -816Q558 -816 558.0 -816.0Q558 -816 558 -816L280 -740Q280 -740 280.0 -740.0Q280 -740 280 -740Z';
function bell() {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 -960 960 960');
  s.setAttribute('class', 'cg-ico');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', CONCIERGE_PATH);
  s.append(p);
  return s;
}

function ensureStyles() {
  for (const href of ['/agent-chat.css', '/concierge.css']) {
    if (!document.querySelector(`link[href="${href}"]`)) {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      document.head.append(l);
    }
  }
}

async function getJson(url, init) {
  const res = await fetch(url, init);
  const j = await res.json().catch(() => null);
  if (!res.ok) {
    const e = new Error((j && j.error) || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return j;
}

function paint(btn) {
  const on = shown(status);
  const muted = !on && btn.dataset.always === '1' && !offForGood;
  btn.hidden = !on && !muted;
  btn.classList.toggle('cg-muted', muted);
  if (muted) {
    btn.title = 'Concierge is off. Turn it on in Settings.';
    btn.setAttribute('aria-label', 'Concierge');
    btn.querySelector('.cg-badge').hidden = true;
    return;
  }
  if (!on) return;
  const t = iconTitle(status, unread);
  btn.title = t;
  btn.setAttribute('aria-label', t);
  btn.classList.toggle('cg-off', !status.prerequisite?.paneTokens);
  const b = btn.querySelector('.cg-badge');
  b.hidden = !(unread > 0);
  b.textContent = unread > 9 ? '9+' : String(unread);
}
function paintAll() {
  for (const b of buttons) paint(b);
}

export async function refresh() {
  try {
    status = await getJson('/api/concierge');
    offForGood = false;
  } catch (e) {
    offForGood = e?.status === 404;
    status = null; // off in Basic (404), or the engine is away: no icon rather than a broken one
  }
  if (shown(status)) {
    try {
      const u = await getJson('/api/rooms/me/unread');
      unread = u?.concierge?.unread ?? 0;
    } catch {
      /* not a person's window: no badge */
    }
  }
  paintAll();
  return status;
}

/** Let a page that already reads /api/rooms/me/unread hand the field over. */
export function setUnread(c) {
  unread = c && typeof c.unread === 'number' ? c.unread : 0;
  paintAll();
}

function startPolling() {
  if (polling) return;
  polling = true;
  setInterval(() => {
    if (document.visibilityState === 'visible') void refresh();
  }, POLL_MS);
}

/** A header button for a surface. `cls` = the surface's own icon-button class. */
export function conciergeButton(cls = '', opts = {}) {
  ensureStyles();
  const b = el('button', `cg-btn ${cls}`.trim());
  b.type = 'button';
  b.hidden = true;
  if (opts.always) b.dataset.always = '1'; // stay visible, muted, when the Concierge is off
  b.append(bell(), el('span', 'cg-badge'));
  b.querySelector('.cg-badge').hidden = true;
  b.addEventListener('click', () => openConcierge());
  buttons.add(b);
  paint(b);
  if (!status) void refresh();
  startPolling();
  return b;
}

/* ------------------------------------------------------------------ the sheet ---- */

let sheet = null;
let chat = null;
let seenTimer = 0;
let voice = null; // the voice session while the fly-out is open (concierge-voice.mjs)

function defaultOnLink(l) {
  const how = linkAction({ embedded: !!window.parent && window.parent !== window, phone: matchMedia(PHONE).matches });
  if (how === 'shell-tab') {
    window.parent.postMessage(openTabMessage(l), '*');
  } else if (how === 'navigate') {
    location.href = l.url;
  } else {
    window.open(l.url, '_blank', 'noopener');
  }
}

export function closeConcierge() {
  voice?.stop();
  voice = null;
  if (chat) chat.setVisible(false);
  chat = null;
  clearInterval(seenTimer);
  seenTimer = 0;
  sheet?.remove();
  sheet = null;
}

async function markSeen() {
  try {
    await getJson('/api/concierge/seen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ts: Date.now() }) });
    unread = 0;
    paintAll();
  } catch {
    /* a bearer page cannot mark it; the badge simply stays */
  }
}

/** Open the fly-out. `onLink` overrides how a wb: chip opens (the shell passes its own addTab). */
export async function openConcierge(opts = {}) {
  ensureStyles();
  closeConcierge();
  const scrim = el('div', 'cg-scrim');
  const box = el('aside', `cg-sheet${matchMedia(PHONE).matches ? ' is-phone' : ''}`);
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Concierge');
  const head = el('header', 'cg-head');
  const title = el('strong', 'cg-title', 'Concierge');
  const who = el('span', 'cg-who');
  const swap = el('button', 'cg-swap');
  swap.type = 'button';
  swap.hidden = true;
  const x = el('button', 'cg-x', String.fromCharCode(0x2715));
  x.type = 'button';
  x.setAttribute('aria-label', 'Close the Concierge');
  head.append(title, who, swap, x);
  const note = el('p', 'cg-note');
  note.hidden = true;
  const body = el('div', 'cg-body');
  box.append(head, note, body);
  scrim.append(box);
  document.body.append(scrim);
  sheet = scrim;
  scrim.addEventListener('click', (ev) => {
    if (ev.target === scrim) closeConcierge();
  });
  x.addEventListener('click', closeConcierge);
  scrim.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeConcierge();
  });
  x.focus();

  const fill = async () => {
    body.textContent = '';
    note.hidden = true;
    let st;
    try {
      st = await refresh();
    } catch (e) {
      st = null;
    }
    if (!shown(st)) {
      body.append(el('p', 'cg-empty', 'The Concierge is off. Turn it on in Settings > Concierge.'));
      return;
    }
    who.textContent = `${st.active.name} (${st.active.vendor})`;
    const other = st.settings.active === 'fallback' ? st.primary : st.fallback;
    swap.hidden = !other;
    if (other) {
      swap.textContent = `Use ${other.name}`;
      swap.onclick = async () => {
        swap.disabled = true;
        try {
          await getJson('/api/concierge', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ active: st.settings.active === 'fallback' ? 'primary' : 'fallback' }) });
          await fill();
        } catch (e) {
          note.hidden = false;
          note.textContent = `Could not switch: ${e?.message ?? e}`;
        } finally {
          swap.disabled = false;
        }
      };
    }
    if (!st.prerequisite?.paneTokens) {
      note.hidden = false;
      note.textContent = st.prerequisite?.message || 'Pane tokens are off on this engine: the Concierge cannot see the Workbench yet.';
    }
    if (!st.live) {
      const p = el('div', 'cg-empty');
      p.append(el('p', '', `${st.active.name} is not running.`));
      const start = el('button', 'cg-start', 'Start the Concierge');
      start.type = 'button';
      const msg = el('p', 'cg-msg');
      start.addEventListener('click', async () => {
        start.disabled = true;
        msg.textContent = 'Starting…';
        try {
          const r = await getJson(`/api/recipes/${encodeURIComponent(st.active.id)}/launch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'tab', surface: 'browser' }) });
          (opts.onLink || defaultOnLink)({ url: r.path || r.url, label: st.active.name });
          msg.textContent = 'Its window is opening; come back here to chat.';
        } catch (e) {
          msg.textContent = `Could not start it: ${e?.message ?? e}`;
        } finally {
          start.disabled = false;
        }
      });
      p.append(start, msg);
      body.append(p);
      return;
    }
    chat = createChat({
      paneid: st.pane,
      agentName: () => 'Concierge',
      agentGlyph: () => {
        const g = el('span', 'cg-glyph');
        g.append(bell());
        return g;
      },
      onLink: opts.onLink || defaultOnLink,
    });
    body.append(chat.el);
    chat.setVisible(true);
    void mountVoice({ head, x, body, chat, name: () => ({ displayName: st.settings?.displayName || '', handle: st.settings?.handle || '' }) });
    void markSeen();
    seenTimer = setInterval(() => void markSeen(), SEEN_MS);
  };
  await fill();
}

/* ------------------------------------------------------------------ her voice ---- *
 * Owner [ref] / [ref]: the conversation test page's mic, speaking indicator and
 * Sonnet turn, inside the fly-out. Shown only when your voice switch is on
 * (Settings > Voice; GET /api/rooms/me `voice.enabled`, on by default).
 *   header   the mic, a speaking indicator with its word, and a gear
 *   gear     a fly-out over the box: sensitivity, pause, her voice, speak replies
 *   chat     your spoken lines and hers as bubbles marked "voice" + "test"
 *   note     while you dictate, a note card over the chat fills in; "Olivia,
 *            change…" edits it; "send the note" ends it, and she asks where to
 *            when it is not clear. A finished send is what she WOULD do: TEST
 *            ONLY, nothing reaches an agent (Owner [ref], recommendation [ref]).
 * Everything else about the fly-out is unchanged. */
const MIC_SVG = '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/><path d="M8.5 21h7"/>';
const GEAR_SVG = '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>';
const STATE_WORD = { off: '', listening: 'Listening', hearing: 'Hearing you', thinking: 'Thinking…', speaking: 'Speaking' };
const MODE_WORD = { note: 'Taking a note', asking: 'Asking you' };

function icon(paths) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = paths; // a constant
  return s;
}

async function voiceOn() {
  try {
    const me = await getJson('/api/rooms/me');
    return me?.voice?.enabled !== false;
  } catch {
    return false; // not a person's window: the test routes would refuse it anyway
  }
}

async function mountVoice({ head, x, body, chat: c, name }) {
  if (!(await voiceOn()) || chat !== c) return; // off, or the fly-out was closed meanwhile
  const { createConciergeVoice } = await import('/concierge-voice.mjs');
  if (chat !== c) return;

  const mic = el('button', 'cg-mic');
  mic.type = 'button';
  mic.setAttribute('aria-pressed', 'false');
  mic.setAttribute('aria-label', 'Talk to her');
  mic.title = 'Talk to her (test: nothing is sent)';
  mic.append(icon(MIC_SVG));
  const ind = el('span', 'cg-ind');
  ind.dataset.state = 'off';
  ind.setAttribute('role', 'status');
  const dot = el('i', 'cg-ind-dot');
  const word = el('span', 'cg-ind-word');
  ind.append(dot, word);
  const gear = el('button', 'cg-gear');
  gear.type = 'button';
  gear.setAttribute('aria-label', 'Voice settings');
  gear.setAttribute('aria-expanded', 'false');
  gear.title = 'Voice settings';
  gear.append(icon(GEAR_SVG));
  head.insertBefore(mic, x);
  head.insertBefore(ind, x);
  head.insertBefore(gear, x);

  /* the note card, over the chat */
  const card = el('section', 'cg-notecard');
  card.hidden = true;
  card.setAttribute('aria-label', 'Note');
  const cHead = el('div', 'cg-nc-head');
  const cMode = el('b', 'cg-nc-mode');
  const cX = el('button', 'cg-nc-x', String.fromCharCode(0x2715));
  cX.type = 'button';
  cX.setAttribute('aria-label', 'Close the note without sending it');
  cX.title = 'Close the note without sending it';
  cHead.append(el('strong', 'cg-nc-title', 'Note'), cMode, cX);
  const cText = el('p', 'cg-nc-text');
  const cSaid = el('p', 'cg-nc-said');
  cSaid.hidden = true;
  const cHint = el('p', 'cg-nc-hint');
  card.append(cHead, cText, cSaid, cHint);

  /* the settings fly-out, over the box */
  const set = el('div', 'cg-set');
  set.hidden = true;
  set.setAttribute('role', 'dialog');
  set.setAttribute('aria-label', 'Voice settings');
  body.append(card, set);

  const v = createConciergeVoice({
    name,
    on(ev) {
      if (ev.type === 'state') {
        ind.dataset.state = ev.state;
        word.textContent = STATE_WORD[ev.state] ?? '';
        mic.setAttribute('aria-pressed', String(ev.state !== 'off'));
        mic.classList.toggle('is-on', ev.state !== 'off');
      } else if (ev.type === 'level') {
        dot.style.setProperty('--lvl', String(Math.max(0, Math.min(1, (ev.db + 70) / 50))));
      } else if (ev.type === 'heard') {
        if (ev.mode === 'conversation') {
          c.addLocal({ role: 'user', text: ev.text, meta: { via: 'voice', test: true } });
        } else {
          cSaid.hidden = false;
          cSaid.textContent = ev.text;
          cSaid.dataset.who = 'you';
        }
      } else if (ev.type === 'olivia') {
        if (ev.mode === 'conversation') {
          c.addLocal({ role: 'assistant', text: ev.text, meta: { via: 'voice', test: true } });
        } else {
          cSaid.hidden = false;
          cSaid.textContent = ev.text;
          cSaid.dataset.who = 'her';
        }
      } else if (ev.type === 'scene') {
        paintCard(ev.scene);
      } else if (ev.type === 'error') {
        c.addLocal({ role: 'assistant', text: ev.text, meta: { test: true } });
      }
    },
  });
  voice = v;

  let lastNote = '';
  function paintCard(sc) {
    if (sc.task) {
      /* the note is done: what she WOULD do, as her bubble; the card closes */
      c.addLocal({ role: 'assistant', text: `Would do: ${sc.task}${lastNote ? `\n\n${lastNote}` : ''}\n\n(Test: nothing was sent.)`, meta: { test: true } });
      lastNote = '';
    }
    const open = sc.mode === 'note' || sc.mode === 'asking';
    card.hidden = !open;
    card.dataset.mode = sc.mode;
    cMode.textContent = MODE_WORD[sc.mode] ?? '';
    cText.textContent = sc.note || 'Start talking: what you say fills in here.';
    cText.dataset.empty = sc.note ? '0' : '1';
    cHint.textContent = sc.mode === 'asking' ? 'Answer her, e.g. "send it to the Workrooms lead".' : `Say "${name().displayName || 'Olivia'}, change…" to edit, "send the note" when it is done.`;
    if (open) lastNote = sc.note;
    else cSaid.hidden = true;
  }
  cX.addEventListener('click', () => {
    lastNote = '';
    v.discardNote();
  });

  mic.addEventListener('click', () => void (v.listening ? v.stop() : v.start()));

  const fillSet = () => {
    const s = v.settings;
    set.replaceChildren();
    const h = el('div', 'cg-set-head');
    const close = el('button', 'cg-nc-x', String.fromCharCode(0x2715));
    close.type = 'button';
    close.setAttribute('aria-label', 'Close voice settings');
    close.addEventListener('click', () => toggleSet(false));
    h.append(el('strong', '', 'Voice'), close);
    const row = (label, input, out) => {
      const l = el('label', 'cg-set-row');
      l.append(el('span', 'cg-set-lbl', label), input);
      if (out) l.append(out);
      return l;
    };
    const sens = el('input');
    Object.assign(sens, { type: 'range', min: '-70', max: '-20', step: '1', value: String(s.thresholdDb) });
    const sensOut = el('span', 'cg-set-out', `${s.thresholdDb} dB`);
    sens.addEventListener('input', () => {
      sensOut.textContent = `${sens.value} dB`;
      v.setSettings({ thresholdDb: Number(sens.value) });
    });
    const pause = el('input');
    Object.assign(pause, { type: 'range', min: '400', max: '2500', step: '100', value: String(s.pauseMs) });
    const pauseOut = el('span', 'cg-set-out', `${(s.pauseMs / 1000).toFixed(1)} s`);
    pause.addEventListener('input', () => {
      pauseOut.textContent = `${(Number(pause.value) / 1000).toFixed(1)} s`;
      v.setSettings({ pauseMs: Number(pause.value) });
    });
    const who = el('select');
    who.append(Object.assign(el('option', '', 'Default voice'), { value: '' }));
    who.addEventListener('change', () => v.setSettings({ character: who.value }));
    void getJson('/api/voice/characters').then((out) => {
      for (const ch of out?.characters ?? []) who.append(Object.assign(el('option', '', ch.name || ch.id), { value: ch.id }));
      who.value = v.settings.character;
    }).catch(() => {});
    const speak = el('input');
    Object.assign(speak, { type: 'checkbox', checked: !!s.speak });
    speak.addEventListener('change', () => v.setSettings({ speak: speak.checked }));
    const lab = el('a', 'cg-set-lab', 'Conversation test page (debug view)');
    Object.assign(lab, { href: '/voice-test.html', target: '_blank', rel: 'noopener' });
    set.append(
      h,
      row('Mic sensitivity', sens, sensOut),
      row('Pause before her turn', pause, pauseOut),
      row('Her voice', who),
      row('Speak her replies', speak),
      el('p', 'cg-set-note', 'Test mode: she shows what she would do; nothing is sent. Saved in this browser.'),
      lab,
    );
  };
  function toggleSet(open) {
    if (open) fillSet();
    set.hidden = !open;
    gear.setAttribute('aria-expanded', String(open));
  }
  gear.addEventListener('click', () => toggleSet(set.hidden));
}
