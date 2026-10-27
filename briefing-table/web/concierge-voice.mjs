/* THE CONCIERGE'S VOICE (Owner, Voice Interaction [ref] / [ref]).
 *
 * The conversation test page's Sonnet turn, without the debug: you talk, the
 * mic cuts segments (voice-listen.mjs), the engine transcribes them
 * (POST /api/voice/test/stt), and the no-tools Sonnet sandbox decides each turn
 * (POST /api/voice/test/brain) in a MODE: conversation, note (you dictate, she
 * edits when addressed by name) or asking (she needs a detail, e.g. where the
 * note goes). Her line is spoken (POST /api/voice/test/tts, the browser's own
 * voice when that is down).
 *
 * TEST ONLY (Owner [ref], the recommendation in [ref]): nothing is sent and the
 * live Concierge session never sees these turns. A finished task is reported as
 * what she WOULD do. The UI (concierge.mjs) draws what this module reports
 * through `on(event)`:
 *   {type:'state', state}           off | listening | hearing | thinking | speaking
 *   {type:'level', db}              the mic level (for the speaking indicator)
 *   {type:'heard', text, mode}      a transcribed line, and the mode it was heard in
 *   {type:'olivia', text, mode}     her line (also spoken)
 *   {type:'scene', scene}           {mode, note, task} after every turn
 *   {type:'error', text}            something did not work; the turn changed nothing
 */
import { createListener } from '/voice-listen.mjs';
import { nameRule, parseSend } from '/voice-test-names.mjs';

const KEY = 'wb.concierge.voice';
const TAIL_MUTE_MS = 250; // after she speaks, before the mic listens again
export const VOICE_DEFAULTS = { thresholdDb: -45, pauseMs: 700, character: '', speak: true };
const UNDO_PHRASES = ['undo', 'undo that', 'undo it', 'undo the change', 'undo the edit', 'put it back', 'change it back'];
const HISTORY_MAX = 16; // turns sent with each line

export function loadVoiceSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { ...VOICE_DEFAULTS, ...(s && typeof s === 'object' ? s : {}) };
  } catch {
    return { ...VOICE_DEFAULTS };
  }
}
export function saveVoiceSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private window: the settings last this page only */
  }
}

/**
 * @param {{ name: () => {displayName: string, handle: string}, on: (ev: object) => void }} o
 */
export function createConciergeVoice(o) {
  let settings = loadVoiceSettings();
  const scene = { mode: 'conversation', note: '', history: [], prevNote: null, task: '' };
  let state = 'off';
  let chain = Promise.resolve(); // one line at a time, in the order heard
  let inFlight = 0; // lines at STT or with Sonnet
  let saying = 0;

  const setState = () => {
    const next = !mic.listening ? 'off' : saying ? 'speaking' : mic.speaking ? 'hearing' : inFlight ? 'thinking' : 'listening';
    if (next !== state) {
      state = next;
      o.on({ type: 'state', state });
    }
  };
  const pair = () => {
    const p = o.name() || {};
    return { displayName: p.displayName || 'Olivia', handle: p.handle || '' };
  };

  const mic = createListener({
    thresholdDb: () => settings.thresholdDb,
    pauseMs: () => settings.pauseMs,
    onLevel: (db) => {
      o.on({ type: 'level', db });
      setState();
    },
    onSpeechStart: setState,
    onSegment: (seg) => {
      inFlight++;
      setState();
      const t = chain.then(() => line(seg.wav));
      chain = t.catch(() => {});
      void t.finally(() => {
        inFlight--;
        setState();
      });
    },
  });

  async function stt(wav) {
    const hint = pair().displayName;
    const r = await fetch(`/api/voice/test/stt?hint=${encodeURIComponent(hint)}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav });
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      throw new Error(j?.error ?? `HTTP ${r.status}`);
    }
    return String(j?.text ?? '').trim();
  }

  async function line(wav) {
    let text;
    try {
      text = await stt(wav);
    } catch (e) {
      o.on({ type: 'error', text: `I could not hear that (${e?.message ?? e}).` });
      return;
    }
    if (!text) {
      return;
    }
    o.on({ type: 'heard', text, mode: scene.mode });
    const rule = nameRule(pair());
    const un = parseSend(text, { sendPhrases: UNDO_PHRASES, rule });
    scene.history.push({ who: 'user', text });
    if (un.hit && !un.content && scene.prevNote !== null) {
      scene.note = scene.prevNote; // "undo that": the page holds the last note, Sonnet is not asked
      scene.prevNote = null;
      await finish({ mode: scene.mode, note: scene.note, say: 'Put it back.', task: '' });
      return;
    }
    let r;
    try {
      const res = await fetch('/api/voice/test/brain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: scene.mode, note: scene.note, history: scene.history.slice(-HISTORY_MAX - 1, -1), utterance: text, name: pair().displayName }),
      });
      r = await res.json().catch(() => null);
      if (!res.ok || !r || typeof r.mode !== 'string') {
        throw new Error(r?.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      o.on({ type: 'error', text: `She did not answer (${e?.message ?? e}). Nothing changed.` });
      return;
    }
    if (typeof r.note === 'string' && r.note !== scene.note) {
      scene.prevNote = scene.note;
      scene.note = r.note;
    }
    await finish(r);
  }

  async function finish(r) {
    scene.mode = ['conversation', 'note', 'asking'].includes(r.mode) ? r.mode : scene.mode;
    scene.task = r.task && scene.mode === 'conversation' ? String(r.task) : '';
    const say = String(r.say ?? '').trim();
    if (say) {
      scene.history.push({ who: 'olivia', text: say });
      o.on({ type: 'olivia', text: say, mode: scene.mode }); // before the scene: her words come before what she would do
    }
    o.on({ type: 'scene', scene: { mode: scene.mode, note: scene.note, task: scene.task } });
    if (scene.task) {
      scene.note = ''; // the note went with the task; the next one starts empty
      scene.prevNote = null;
    }
    if (say && settings.speak) {
      await speak(say);
    }
  }

  async function speak(text) {
    saying++;
    setState();
    try {
      const r = await fetch('/api/voice/test/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, ...(settings.character ? { character: settings.character } : {}) }),
      });
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}`);
      }
      const url = URL.createObjectURL(await r.blob());
      const a = new Audio(url);
      await new Promise((resolve) => {
        a.addEventListener('loadedmetadata', () => mic.muteUntil(Date.now() + Math.round((a.duration || 1) * 1000) + TAIL_MUTE_MS), { once: true });
        a.addEventListener('ended', resolve, { once: true });
        a.addEventListener('error', resolve, { once: true });
        mic.muteUntil(Date.now() + 3000);
        a.play().catch(resolve);
      });
      URL.revokeObjectURL(url);
    } catch {
      await new Promise((resolve) => {
        if (!('speechSynthesis' in window)) {
          resolve();
          return;
        }
        const u = new SpeechSynthesisUtterance(text);
        u.onend = resolve;
        u.onerror = resolve;
        mic.muteUntil(Date.now() + 4000);
        speechSynthesis.speak(u);
      });
      mic.muteUntil(Date.now() + TAIL_MUTE_MS);
    } finally {
      saying--;
      setState();
    }
  }

  return {
    async start() {
      try {
        await mic.start();
      } catch (e) {
        o.on({ type: 'error', text: `The microphone was not allowed: ${e?.message ?? e}` });
      }
      setState();
    },
    stop() {
      mic.stop();
      setState();
    },
    get listening() {
      return mic.listening;
    },
    get state() {
      return state;
    },
    get scene() {
      return { mode: scene.mode, note: scene.note, task: scene.task };
    },
    get settings() {
      return { ...settings };
    },
    setSettings(patch) {
      settings = { ...settings, ...patch };
      saveVoiceSettings(settings);
    },
    /** Close the note without sending it (the ✕ on the note card). */
    discardNote() {
      Object.assign(scene, { mode: 'conversation', note: '', prevNote: null, task: '' });
      scene.history.push({ who: 'user', text: '(closed the note without sending it)' });
      o.on({ type: 'scene', scene: { mode: scene.mode, note: scene.note, task: scene.task } });
    },
  };
}
