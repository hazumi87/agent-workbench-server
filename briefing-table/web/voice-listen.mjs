/* THE MIC: speech in, segments out (shared by the conversation test page and the
 * Concierge's voice, Owner [ref]).
 *
 * One getUserMedia stream through a ScriptProcessor. A frame louder than the
 * threshold starts a segment (with PRE_ROLL_MS of audio from before it, so the
 * first syllable is not clipped); a pause of `pauseMs` ends it. A segment
 * shorter than MIN_SPEECH_MS is dropped. While the page itself is speaking
 * (`muteFor`), the mic is ignored so our own voice never becomes a segment.
 *
 * The listener knows nothing about turns, STT or what a segment means: it
 * reports levels and segments, and the page decides.
 */
export const RATE = 16000;
const PRE_ROLL_MS = 250; // audio kept from before speech was detected
const MIN_SPEECH_MS = 250; // shorter blips are dropped
const MAX_SEGMENT_MS = 30000; // the engine route's cap

export function dbOf(x) {
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    sum += x[i] * x[i];
  }
  const rms = Math.sqrt(sum / Math.max(1, x.length));
  return rms > 0 ? 20 * Math.log10(rms) : -100;
}

/** Float32 chunks at `srcRate` -> a 16 kHz mono PCM16 WAV blob. */
export function encodeWav(chunks, srcRate) {
  let n = 0;
  for (const c of chunks) {
    n += c.length;
  }
  const all = new Float32Array(n);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  /* linear resample to 16 kHz */
  const ratio = srcRate / RATE;
  const len = Math.floor(all.length / ratio);
  const pcm = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    const p = i * ratio;
    const a = Math.floor(p);
    const b = Math.min(all.length - 1, a + 1);
    const v = all[a] + (all[b] - all[a]) * (p - a);
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  const bytes = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(bytes);
  const str = (off, s) => {
    for (let i = 0; i < s.length; i++) {
      dv.setUint8(off + i, s.charCodeAt(i));
    }
  };
  str(0, 'RIFF');
  dv.setUint32(4, 36 + pcm.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, RATE, true);
  dv.setUint32(28, RATE * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  str(36, 'data');
  dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(bytes, 44).set(pcm);
  return new Blob([bytes], { type: 'audio/wav' });
}

/**
 * @param {{
 *   thresholdDb: () => number,          // speech is louder than this (dBFS)
 *   pauseMs: () => number,              // a pause this long ends a segment
 *   onLevel?: (db: number, speaking: boolean) => void,
 *   onSpeechStart?: () => void,
 *   onSegment: (seg: {wav: Blob, ts: number, speechMs: number, pauseMs: number|null}) => void,
 * }} o
 */
export function createListener(o) {
  let ctx = null;
  let stream = null;
  let node = null;
  let source = null;
  let listening = false;
  let speaking = false;
  let muteUntil = 0;
  let segStartAt = 0; // wall clock: speech began
  let lastSpeechEndAt = null; // wall clock: speech last ended (the silence clock)
  let speechStarts = 0; // counts speech onsets: a clip asked for before the latest one is stale
  let quietMs = 0; // within a segment: silence since the last loud frame
  let buf = []; // Float32Array chunks of the current segment
  let pre = []; // the pre-roll ring
  let preLen = 0;

  function endSegment(endAt) {
    speaking = false;
    const chunks = buf;
    buf = [];
    const speechMs = Math.max(0, endAt - segStartAt);
    const pauseMs = lastSpeechEndAt === null ? null : Math.max(0, segStartAt - lastSpeechEndAt);
    lastSpeechEndAt = endAt;
    if (speechMs < MIN_SPEECH_MS) {
      return;
    }
    o.onSegment({ wav: encodeWav(chunks, ctx.sampleRate), ts: segStartAt, speechMs, pauseMs });
  }

  function onAudio(e) {
    const x = new Float32Array(e.inputBuffer.getChannelData(0));
    const frameMs = (x.length / ctx.sampleRate) * 1000;
    const now = Date.now();
    const db = dbOf(x);
    o.onLevel?.(db, speaking);
    if (now < muteUntil) {
      return; // our own voice must not become a segment
    }
    const loud = db > o.thresholdDb();
    if (!speaking) {
      pre.push(x);
      preLen += frameMs;
      while (preLen > PRE_ROLL_MS && pre.length > 1) {
        preLen -= (pre.shift().length / ctx.sampleRate) * 1000;
      }
      if (loud) {
        speaking = true;
        speechStarts++;
        segStartAt = now - preLen;
        buf = pre.slice();
        pre = [];
        preLen = 0;
        quietMs = 0;
        o.onSpeechStart?.();
      }
      return;
    }
    buf.push(x);
    quietMs = loud ? 0 : quietMs + frameMs;
    if (quietMs >= o.pauseMs() || now - segStartAt >= MAX_SEGMENT_MS) {
      endSegment(now - quietMs);
    }
  }

  return {
    /** Open the mic. Throws when it is not allowed (the caller says so). */
    async start() {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      ctx = ctx || new AudioContext();
      await ctx.resume();
      source = ctx.createMediaStreamSource(stream);
      node = ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = onAudio;
      source.connect(node);
      node.connect(ctx.destination); // a ScriptProcessor only runs while connected; it outputs silence
      listening = true;
      speaking = false;
      lastSpeechEndAt = null;
    },
    /** Close the mic; a segment in progress is finished first. */
    stop() {
      listening = false;
      if (speaking) {
        endSegment(Date.now());
      }
      try {
        source?.disconnect();
        node?.disconnect();
      } catch {
        /* already gone */
      }
      for (const t of stream?.getTracks() ?? []) {
        t.stop();
      }
      stream = null;
    },
    /** The page is speaking until `at` (wall clock): ignore the mic till then. */
    muteUntil(at) {
      muteUntil = at;
    },
    get muted() {
      return Date.now() < muteUntil;
    },
    get ctx() {
      return ctx;
    },
    get listening() {
      return listening;
    },
    get speaking() {
      return speaking;
    },
    get speechStarts() {
      return speechStarts;
    },
    get lastSpeechEndAt() {
      return lastSpeechEndAt;
    },
  };
}
