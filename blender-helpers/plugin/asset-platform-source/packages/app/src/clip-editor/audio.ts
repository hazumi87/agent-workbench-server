// Clip editor — decoded audio: peaks, zero-crossings, clipped samples, and playback.
// Everything reads one AudioBuffer decoded at the SOURCE sample rate, so a sample on
// screen is a sample in the file (Live-TV lesson: <audio> can't do exact slices).

const LEVELS = [16, 256, 4096]; // samples per bucket for the min/max mipmap

export class Peaks {
  readonly sr: number; readonly len: number; readonly ch: Float32Array[];
  private mip: { spp: number; min: Float32Array[]; max: Float32Array[] }[] = [];
  readonly clipped: Uint32Array; // sample indices with |s| ≥ 0.999 (any channel)

  constructor(buf: AudioBuffer) {
    this.sr = buf.sampleRate; this.len = buf.length;
    this.ch = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => buf.getChannelData(c));
    for (const spp of LEVELS) {
      const n = Math.ceil(this.len / spp);
      const min = this.ch.map(() => new Float32Array(n)); const max = this.ch.map(() => new Float32Array(n));
      this.ch.forEach((d, c) => {
        for (let b = 0; b < n; b++) {
          let lo = 1, hi = -1; const e = Math.min(this.len, (b + 1) * spp);
          for (let i = b * spp; i < e; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
          min[c][b] = lo; max[c][b] = hi;
        }
      });
      this.mip.push({ spp, min, max });
    }
    const clip: number[] = [];
    for (let i = 0; i < this.len && clip.length < 100000; i++) {
      for (const d of this.ch) if (Math.abs(d[i]) >= 0.999) { clip.push(i); break; }
    }
    this.clipped = Uint32Array.from(clip);
  }

  get stereo() { return this.ch.length > 1; }
  get duration() { return this.len / this.sr; }

  // min/max of channel c over samples [s0, s1)
  range(c: number, s0: number, s1: number): [number, number] {
    s0 = Math.max(0, Math.floor(s0)); s1 = Math.min(this.len, Math.ceil(s1));
    if (s1 <= s0) return [0, 0];
    let lvl = null;
    for (const m of this.mip) if ((s1 - s0) >= m.spp * 4) lvl = m;
    let lo = 1, hi = -1;
    if (!lvl) {
      const d = this.ch[c];
      for (let i = s0; i < s1; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      return [lo, hi];
    }
    const b0 = Math.floor(s0 / lvl.spp), b1 = Math.ceil(s1 / lvl.spp);
    for (let b = b0; b < b1; b++) { if (lvl.min[c][b] < lo) lo = lvl.min[c][b]; if (lvl.max[c][b] > hi) hi = lvl.max[c][b]; }
    return [lo, hi];
  }

  sample(c: number, i: number) { return this.ch[c][i] ?? 0; }

  peakDb(): number {
    let p = 0; for (const m of this.mip.slice(-1)) m.max.forEach((a, c) => a.forEach((v, b) => { p = Math.max(p, v, -m.min[c][b]); }));
    return p > 0 ? 20 * Math.log10(p) : -Infinity;
  }

  // Nearest zero crossing of the mono sum within ±radius seconds, else t unchanged.
  zeroCross(t: number, radius = 0.002): number {
    const c = Math.round(t * this.sr), r = Math.round(radius * this.sr);
    const mono = (i: number) => this.ch.reduce((a, d) => a + (d[i] ?? 0), 0);
    for (let k = 0; k <= r; k++) {
      for (const i of [c - k, c + k]) {
        if (i <= 0 || i >= this.len) continue;
        const a = mono(i - 1), b = mono(i);
        if (a === 0 || (a < 0) !== (b < 0)) return i / this.sr;
      }
    }
    return t;
  }
}

// Scheduled playback of source ranges with equal-power crossfades at the joins —
// the same shape Create clip renders, so what you hear is what you get.
export class Player {
  readonly ctx: AudioContext; readonly buf: AudioBuffer;
  private nodes: AudioScheduledSourceNode[] = [];
  private plan: { ct: number; t0: number; t1: number }[] = [];
  private loop: { ct: number; a: number; b: number } | null = null;
  onEnded: (() => void) | null = null;
  private endTimer = 0;

  constructor(ctx: AudioContext, buf: AudioBuffer) { this.ctx = ctx; this.buf = buf; }

  get playing() { return this.nodes.length > 0; }

  stop() {
    this.nodes.forEach(n => { try { n.stop(); } catch { /* already stopped */ } });
    this.nodes = []; this.plan = []; this.loop = null;
    clearTimeout(this.endTimer);
  }

  private voice(when: number, t0: number, dur: number, fin: number, fout: number) {
    const src = this.ctx.createBufferSource(); src.buffer = this.buf;
    const g = this.ctx.createGain();
    const curve = (up: boolean) => Float32Array.from({ length: 32 }, (_, i) => Math.sin(((up ? i : 31 - i) / 31) * Math.PI / 2));
    // curves must not overlap each other or any other event (Web Audio throws)
    fin = Math.min(fin, dur / 2.2); fout = Math.min(fout, dur / 2.2);
    if (fin > 0) g.gain.setValueCurveAtTime(curve(true), when, fin); else g.gain.setValueAtTime(1, when);
    if (fout > 0) g.gain.setValueCurveAtTime(curve(false), when + dur - fout, fout);
    src.connect(g).connect(this.ctx.destination);
    src.start(when, t0, dur);
    this.nodes.push(src);
  }

  // ranges: source [a,b] in play order; fades[i] (s) joins ranges[i] → ranges[i+1]; pads[i] (s) of
  // silence before ranges[i] (the previous range fades out into it, as in the render).
  play(ranges: [number, number][], fades: number[], pads: number[] = []) {
    this.stop();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    let when = this.ctx.currentTime + 0.03;
    ranges.forEach(([a, b], i) => {
      when += pads[i] ?? 0;
      const last = i === ranges.length - 1, join = last ? 0 : fades[i];
      this.voice(when, a, b - a, i > 0 ? fades[i - 1] : 0.004, last ? 0.004 : join);
      this.plan.push({ ct: when, t0: a, t1: b });
      when += b - a - join;
    });
    this.endTimer = window.setTimeout(() => { this.stop(); this.onEnded?.(); }, (when - this.ctx.currentTime) * 1000 + 30);
  }

  playLoop(a: number, b: number) {
    this.stop();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const src = this.ctx.createBufferSource(); src.buffer = this.buf;
    src.loop = true; src.loopStart = a; src.loopEnd = b;
    src.connect(this.ctx.destination);
    const ct = this.ctx.currentTime + 0.02;
    src.start(ct, a); this.nodes.push(src); this.loop = { ct, a, b };
  }

  // Short jog slice with 5 ms fades (scrub audio).
  slice(t: number, dur = 0.06) {
    if (this.playing) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const src = this.ctx.createBufferSource(); src.buffer = this.buf;
    const g = this.ctx.createGain(); const now = this.ctx.currentTime + 0.005; const f = Math.min(0.005, dur / 4);
    g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(1, now + f);
    g.gain.setValueAtTime(1, now + dur - f); g.gain.linearRampToValueAtTime(0, now + dur);
    src.connect(g).connect(this.ctx.destination);
    src.start(now, Math.max(0, t), dur); src.stop(now + dur + 0.02);
  }

  // Current source time, or null when stopped.
  now(): number | null {
    const ct = this.ctx.currentTime;
    if (this.loop) { const { a, b } = this.loop; return a + (((ct - this.loop.ct) % (b - a)) + (b - a)) % (b - a); }
    if (!this.plan.length) return null;
    let p = this.plan[0];
    for (const e of this.plan) if (e.ct <= ct) p = e;
    return Math.min(p.t1, p.t0 + Math.max(0, ct - p.ct));
  }
}
