// sfx.ts — procedural WebAudio sound design for the football game. Everything is
// synthesized at runtime (oscillators + noise buffers): the repo is public, so we
// ship ZERO audio assets. Lazy singleton: the AudioContext is only created inside
// unlock() on a user gesture (autoplay policy); every method no-ops before that
// or where window.AudioContext is missing (SSR/tests must survive import).

type WhistleKind = 'kickoff' | 'foul' | 'full';

// ---- module state (populated once by unlock) --------------------------------
let ctx: AudioContext | null = null;
let master: GainNode | null = null;       // single master fader; `muted` drives it
let crowdGain: GainNode | null = null;    // ambient crowd level (setCrowd target)
let crowdFilter: BiquadFilterNode | null = null; // opens up as excitement rises
let pinkBuf: AudioBuffer | null = null;   // 4s pink-ish loop — created ONCE, reused forever
let whiteBuf: AudioBuffer | null = null;  // 1s white noise — kick snaps + goal swell
let crowdLevel = 0;                       // last setCrowd value; remembered pre-unlock
let mutedFlag = false;

const CROWD_MAX = 0.45; // ambient ceiling: crowd is a bed, never louder than events
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// Cancel pending automation and glide from the CURRENT value. Restating p.value
// first is what prevents zipper noise — a bare ramp after cancel would jump.
const ramp = (p: AudioParam, target: number, dur: number): void => {
  if (!ctx) return;
  const t = ctx.currentTime;
  p.cancelScheduledValues(t);
  p.setValueAtTime(p.value, t);
  p.linearRampToValueAtTime(target, t + dur);
};

// One referee whistle burst. A pea whistle ~= a pure tone with a fast warble:
// a triangle (adds the airy odd harmonics a sine lacks) + a 6Hz vibrato osc
// pushing frequency +-30Hz. Hard 5ms attack — a real whistle speaks instantly.
const blast = (t0: number, dur: number, freq: number): void => {
  if (!ctx || !master) return;
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, t0);
  const vib = ctx.createOscillator();
  vib.frequency.value = 6;
  const vibAmt = ctx.createGain();
  vibAmt.gain.value = 30; // +-30Hz — enough shimmer to read as "whistle" not "beep"
  vib.connect(vibAmt).connect(osc.frequency);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(0.32, t0 + 0.005);      // hard attack
  g.gain.setValueAtTime(0.32, t0 + Math.max(0.01, dur - 0.03));
  g.gain.linearRampToValueAtTime(0, t0 + dur);           // short release, no click
  osc.connect(g).connect(master);
  osc.start(t0);
  vib.start(t0);
  osc.stop(t0 + dur + 0.02);
  vib.stop(t0 + dur + 0.02);
};

// Whistle grammar per real refereeing convention: 1 long / 2 short / 3 long.
const WHISTLE: Record<WhistleKind, { dur: number; gap: number; count: number }> = {
  kickoff: { dur: 0.6, gap: 0, count: 1 },
  foul: { dur: 0.16, gap: 0.12, count: 2 },
  full: { dur: 0.45, gap: 0.2, count: 3 },
};

export const sfx = {
  /** debug/verification: AudioContext state, or 'locked' before unlock */
  get state(): string {
    return ctx ? ctx.state : 'locked';
  },

  // Call on first user gesture. Idempotent: later calls just resume a context
  // the browser may have auto-suspended (e.g. tab switch).
  unlock(): void {
    if (ctx) {
      void ctx.resume();
      return;
    }
    if (typeof window === 'undefined') return; // SSR / node test runner
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();

    master = ctx.createGain();
    master.gain.value = mutedFlag ? 0 : 0.9; // honor a mute set before unlock
    master.connect(ctx.destination);

    // Pink-ish crowd bed: white noise through a leaky integrator, plus a touch
    // of raw white. Pure white reads as "static"; the downward spectral tilt is
    // what makes a distant crowd sound like a wash.
    const sr = ctx.sampleRate;
    pinkBuf = ctx.createBuffer(1, sr * 4, sr);
    const pd = pinkBuf.getChannelData(0);
    let lp = 0;
    for (let i = 0; i < pd.length; i++) {
      const white = Math.random() * 2 - 1;
      lp = 0.97 * lp + 0.03 * white;      // heavy lowpass = the rumble body
      pd[i] = lp * 3.2 + white * 0.06;    // makeup gain + a little air on top
    }
    // White buffer for transients (kick snap, goal swell): created once so a
    // call only costs a BufferSource, never a fresh allocation.
    whiteBuf = ctx.createBuffer(1, sr, sr);
    const wd = whiteBuf.getChannelData(0);
    for (let i = 0; i < wd.length; i++) wd[i] = Math.random() * 2 - 1;

    // Crowd chain: loop -> bandpass -> breath -> level -> master. The bandpass
    // (400-1200Hz) is the "distance": it kills rumble mud and hissy top so the
    // bed sits behind gameplay, and it masks the 4s buffer's loop-seam click.
    const src = ctx.createBufferSource();
    src.buffer = pinkBuf;
    src.loop = true;
    crowdFilter = ctx.createBiquadFilter();
    crowdFilter.type = 'bandpass';
    crowdFilter.frequency.value = 400 + 800 * crowdLevel;
    crowdFilter.Q.value = 0.7; // wide skirt: we want a wash, not a resonant honk
    // "Breathing": a 0.1Hz LFO sums +-0.15 onto a unity series gain, swelling
    // the bed +-15% every ~10s — proportional at ANY crowd level, which adding
    // the LFO straight onto crowdGain would not be.
    const breath = ctx.createGain();
    breath.gain.value = 1;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.1;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.15;
    lfo.connect(lfoDepth).connect(breath.gain);
    crowdGain = ctx.createGain();
    crowdGain.gain.value = crowdLevel * CROWD_MAX; // honor pre-unlock setCrowd
    src.connect(crowdFilter).connect(breath).connect(crowdGain).connect(master);
    src.start();
    lfo.start();
    void ctx.resume();
  },

  // Ambient excitement 0..1. Level and brightness ramp over 1.5s: a crowd never
  // changes mood instantly, and the slow ramp keeps automation click-free.
  setCrowd(level: number): void {
    crowdLevel = clamp01(level);
    if (!crowdGain || !crowdFilter) return;
    ramp(crowdGain.gain, crowdLevel * CROWD_MAX, 1.5);
    ramp(crowdFilter.frequency, 400 + 800 * crowdLevel, 1.5); // excited = brighter
  },

  // Ball strike = body + snap. Body: a 55-70Hz sine (harder = deeper) with a
  // fast pitch drop — the drop is what reads as "impact"; a static sine hums.
  // Snap: ~2kHz bandpassed noise, the leather click that feels close-mic'd.
  kick(power: number = 0.7): void {
    if (!ctx || !master || !whiteBuf) return;
    const p = clamp01(power);
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(70 - 15 * p, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.35 + 0.5 * p, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12); // ~120ms thump decay
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.15);
    const snap = ctx.createBufferSource();
    snap.buffer = whiteBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400 + 1400 * p; // harder kick = brighter snap
    bp.Q.value = 1.2;
    const sg = ctx.createGain();
    const snapDur = 0.04 + 0.03 * p;
    sg.gain.setValueAtTime(0.25 + 0.25 * p, t);
    sg.gain.linearRampToValueAtTime(0, t + snapDur);
    snap.connect(bp).connect(sg).connect(master);
    snap.start(t, Math.random() * 0.9); // random read offset: no two kicks identical
    snap.stop(t + snapDur + 0.01);
  },

  whistle(kind: WhistleKind): void {
    if (!ctx) return;
    const { dur, gap, count } = WHISTLE[kind];
    const t = ctx.currentTime;
    for (let i = 0; i < count; i++) blast(t + i * (dur + gap), dur, 2100);
  },

  // Booking: one chirp, pitched above the game whistle so the ear separates
  // "card shown" from "play stopped".
  card(): void {
    if (ctx) blast(ctx.currentTime, 0.12, 2300);
  },

  // Goal roar: the ambient bed itself surges 2.5x (the crowd we already hear
  // erupting is far more convincing than an unrelated layer), plus a bright
  // highpassed swell — voices jumping to treble-heavy screaming — then all
  // eases back to the current setCrowd bed.
  goal(): void {
    if (!ctx || !master || !crowdGain || !whiteBuf) return;
    const t = ctx.currentTime;
    // Floor the base so a goal in a "quiet" stadium still lands.
    const base = crowdLevel * CROWD_MAX;
    const peak = Math.max(base, 0.12) * 2.5;
    const g = crowdGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(peak, t + 0.3); // fast surge: the eruption
    g.setValueAtTime(peak, t + 2.5);          // sustained pandemonium
    g.linearRampToValueAtTime(base, t + 4.5); // ease back to ambient over 2s
    const swell = ctx.createBufferSource();
    swell.buffer = whiteBuf;
    swell.loop = true; // 1s buffer under a 2.5s envelope
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 800; // keep only the "scream" band; lows stay in the bed
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(0.4, t + 0.9);   // crescendo
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 2.5); // long decay
    swell.connect(hp).connect(sg).connect(master);
    swell.start(t);
    swell.stop(t + 2.6);
  },

  // Accessor pair so assignment (sfx.muted = true) actually moves the fader.
  // Short 50ms ramp instead of a hard set — instant gain steps click.
  get muted(): boolean {
    return mutedFlag;
  },
  set muted(v: boolean) {
    mutedFlag = v;
    if (master) ramp(master.gain, v ? 0 : 0.9, 0.05);
  },
};
