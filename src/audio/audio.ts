import { clamp } from '../core/math';

export type SoundId =
  | 'pistol'
  | 'mg'
  | 'sniper'
  | 'boom'
  | 'crash'
  | 'hit'
  | 'thud'
  | 'splash'
  | 'drip'
  | 'swing'
  | 'reload'
  | 'horn'
  | 'wrench'
  | 'zdie'
  | 'yelp'
  | 'growl'
  | 'caw'
  | 'scream'
  | 'beep'
  | 'bell'
  | 'pickup'
  | 'loot'
  | 'click'
  | 'confirm'
  | 'deny'
  | 'radio'
  | 'build'
  | 'alarm'
  | 'siren'
  | 'retch'
  | 'laugh'
  | 'hiccup'
  | 'sing'
  | 'whisper'
  | 'gulp'
  | 'toke'
  | 'pill';

export type MusicState = 'none' | 'travel' | 'stealth' | 'combat' | 'camp' | 'raid';

interface EngineVoice {
  osc1: OscillatorNode;
  osc2: OscillatorNode;
  noise: AudioBufferSourceNode;
  filt: BiquadFilterNode;
  gain: GainNode;
  pan: StereoPannerNode;
  lastSeen: number;
}

export interface EngineState {
  id: number;
  x: number;
  z: number;
  /** 0..1 of top speed. */
  rpm: number;
  throttle: number;
  tier: number;
  /** Loudness tied to Signature: 0..100. */
  signature: number;
}

/**
 * Procedural audio. Every sound is mixed relative to the nearest player and sent to that player's bus,
 * panned 0.35 left for Player 1 and 0.35 right for Player 2. High-priority cues duck the rest.
 */
export class AudioEngine {
  ctx: AudioContext | null = null;
  master!: GainNode;
  sfx!: GainNode;
  musicBus!: GainNode;
  buses: GainNode[] = [];
  private pans: StereoPannerNode[] = [];
  /** Per player: a low-pass for the cotton-wool of being high, and a warbling echo for the rest. */
  private trip: { filt: BiquadFilterNode; fb: GainNode; wet: GainNode; delay: DelayNode; lfo: OscillatorNode; lfoGain: GainNode }[] = [];
  private noiseBuf: AudioBuffer | null = null;
  listeners: { x: number; z: number }[] = [{ x: 0, z: 0 }, { x: 0, z: 0 }];
  muted = false;
  volume = 0.7;
  musicVolume = 0.55;
  private engines = new Map<number, EngineVoice>();
  private now = 0;
  private duckT = 0;
  private stems: Record<string, GainNode> = {};
  private musicState: MusicState = 'none';
  private musicTimer = 0;
  private beat = 0;
  private bass?: OscillatorNode;
  private radioHiss?: GainNode;
  private lastPlay = new Map<string, number>();

  /** Must be called from a user gesture. */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 5;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 1;
    this.sfx.connect(this.master);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicVolume * 0.5;
    this.musicBus.connect(this.master);
    for (let i = 0; i < 2; i++) {
      const g = ctx.createGain();
      const p = ctx.createStereoPanner();
      p.pan.value = i === 0 ? -0.35 : 0.35;
      // bus -> low-pass -> pan, with a feedback echo hanging off the low-pass for the psychedelics.
      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 22000;
      const delay = ctx.createDelay(1);
      delay.delayTime.value = 0.27;
      const fb = ctx.createGain();
      fb.gain.value = 0;
      const wet = ctx.createGain();
      wet.gain.value = 0;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.31 + i * 0.07;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0;
      lfo.connect(lfoGain).connect(delay.delayTime);
      lfo.start();
      g.connect(filt).connect(p).connect(this.sfx);
      filt.connect(delay);
      delay.connect(fb).connect(delay);
      delay.connect(wet).connect(p);
      this.buses.push(g);
      this.pans.push(p);
      this.trip.push({ filt, fb, wet, delay, lfo, lfoGain });
    }
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.initMusic();
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master) this.master.gain.value = this.muted ? 0 : v;
  }
  setMusicVolume(v: number) {
    this.musicVolume = v;
    if (this.musicBus) this.musicBus.gain.value = v * 0.5;
  }
  setMuted(m: boolean) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
  }

  /** How high a player is, as the ears hear it: `muffle` closes the low-pass, `echo` opens the warbling delay. Both 0..1. */
  setTrip(i: number, muffle: number, echo: number) {
    const ctx = this.ctx;
    const t = this.trip[i];
    if (!ctx || !t) return;
    const m = clamp(muffle, 0, 1);
    const e = clamp(echo, 0, 1);
    const now = ctx.currentTime;
    t.filt.frequency.setTargetAtTime(22000 * Math.pow(1 - m, 2.2) + 500, now, 0.25);
    t.fb.gain.setTargetAtTime(e * 0.5, now, 0.25);
    t.wet.gain.setTargetAtTime(e * 0.5, now, 0.25);
    t.lfoGain.gain.setTargetAtTime(e * 0.012, now, 0.25);
  }

  setListeners(l: { x: number; z: number }[]) {
    this.listeners = l;
  }

  private nearest(x: number, z: number) {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < this.listeners.length; i++) {
      const d = Math.hypot(this.listeners[i].x - x, this.listeners[i].z - z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return { bus: best, dist: bd };
  }

  private noise(): AudioBufferSourceNode {
    const n = this.ctx!.createBufferSource();
    n.buffer = this.noiseBuf!;
    n.loop = true;
    return n;
  }

  /** Duck everything except the cue, for high-priority alerts. */
  duck(seconds = 0.8, depth = 0.45) {
    if (!this.ctx) return;
    const g = this.sfx.gain;
    g.cancelScheduledValues(this.ctx.currentTime);
    g.setTargetAtTime(depth, this.ctx.currentTime, 0.03);
    g.setTargetAtTime(1, this.ctx.currentTime + seconds, 0.25);
  }

  /** Play a one-shot. `x`/`z` position it in the world; omit for UI sounds heard by both players. */
  play(id: SoundId, x?: number, z?: number, vol = 1) {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    // Rate-limit identical sounds so machine guns don't flood the graph.
    const t0 = ctx.currentTime;
    const last = this.lastPlay.get(id) ?? 0;
    const minGap = id === 'mg' ? 0.045 : id === 'pistol' ? 0.03 : id === 'hit' ? 0.06 : id === 'zdie' ? 0.05 : id === 'thud' ? 0.05 : id === 'yelp' || id === 'growl' || id === 'caw' ? 0.25 : 0;
    if (t0 - last < minGap) return;
    this.lastPlay.set(id, t0);
    let targets: { bus: number; gain: number }[];
    if (x === undefined || z === undefined) {
      targets = [{ bus: 0, gain: 1 }, { bus: 1, gain: 1 }];
    } else {
      const n = this.nearest(x, z);
      if (n.dist > 170) return;
      const att = 1 / (1 + (n.dist / 28) ** 2);
      targets = [{ bus: n.bus, gain: att }];
    }
    for (const tg of targets) this.voice(id, this.buses[tg.bus], vol * tg.gain);
  }

  private env(g: GainNode, t0: number, peak: number, attack: number, decay: number) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  private burst(dest: AudioNode, t0: number, type: BiquadFilterType, freq: number, q: number, peak: number, attack: number, decay: number) {
    const ctx = this.ctx!;
    const n = this.noise();
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    this.env(g, t0, peak, attack, decay);
    n.connect(f).connect(g).connect(dest);
    n.start(t0, Math.random());
    n.stop(t0 + attack + decay + 0.05);
  }

  private tone(dest: AudioNode, t0: number, type: OscillatorType, f0: number, f1: number, peak: number, attack: number, decay: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + attack + decay);
    const g = ctx.createGain();
    this.env(g, t0, peak, attack, decay);
    o.connect(g).connect(dest);
    o.start(t0);
    o.stop(t0 + attack + decay + 0.05);
  }

  private voice(id: SoundId, dest: AudioNode, v: number) {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = clamp(v, 0, 1.5);
    out.connect(dest);
    switch (id) {
      case 'pistol':
        this.burst(out, t0, 'bandpass', 1900, 0.9, 0.9, 0.002, 0.11);
        this.tone(out, t0, 'triangle', 190, 55, 0.7, 0.002, 0.09);
        break;
      case 'mg':
        this.burst(out, t0, 'bandpass', 1500, 0.8, 0.55, 0.002, 0.07);
        this.tone(out, t0, 'triangle', 150, 60, 0.45, 0.002, 0.06);
        break;
      case 'sniper':
        this.burst(out, t0, 'lowpass', 3000, 0.6, 1.0, 0.002, 0.35);
        this.tone(out, t0, 'sawtooth', 120, 35, 0.8, 0.002, 0.3);
        break;
      case 'boom':
        this.burst(out, t0, 'lowpass', 900, 0.5, 1.2, 0.004, 1.0);
        this.tone(out, t0, 'sine', 90, 28, 1.1, 0.004, 0.9);
        this.duck(0.6, 0.55);
        break;
      case 'crash':
        this.burst(out, t0, 'lowpass', 1400, 0.7, 0.9, 0.002, 0.35);
        this.tone(out, t0, 'square', 100, 40, 0.5, 0.002, 0.2);
        break;
      case 'hit':
        this.tone(out, t0, 'sine', 160, 60, 0.7, 0.002, 0.12);
        this.burst(out, t0, 'lowpass', 600, 0.5, 0.4, 0.002, 0.1);
        break;
      case 'thud':
        this.tone(out, t0, 'sine', 110, 45, 0.7, 0.003, 0.14);
        this.burst(out, t0, 'lowpass', 400, 0.5, 0.35, 0.002, 0.12);
        break;
      case 'swing':
        this.burst(out, t0, 'bandpass', 700, 0.7, 0.3, 0.05, 0.12);
        break;
      case 'splash':
        this.burst(out, t0, 'bandpass', 1500, 0.8, 0.32, 0.01, 0.4);
        this.burst(out, t0, 'lowpass', 500, 0.6, 0.3, 0.005, 0.3);
        break;
      case 'drip':
        this.tone(out, t0, 'sine', 1700, 650, 0.1, 0.002, 0.09);
        break;
      case 'reload':
        this.tone(out, t0, 'square', 900, 700, 0.15, 0.002, 0.03);
        this.tone(out, t0 + 0.5, 'square', 1200, 800, 0.2, 0.002, 0.04);
        break;
      case 'horn':
        for (const f of [233, 294]) this.tone(out, t0, 'square', f, f * 0.98, 0.35, 0.02, 0.55);
        break;
      case 'siren':
        this.tone(out, t0, 'sawtooth', 600, 900, 0.3, 0.1, 0.4);
        break;
      case 'wrench':
        for (let i = 0; i < 3; i++) this.tone(out, t0 + i * 0.07, 'square', 1500 - i * 200, 900, 0.1, 0.001, 0.025);
        break;
      case 'yelp':
        this.tone(out, t0, 'sawtooth', 900 + Math.random() * 300, 380, 0.3, 0.01, 0.16);
        this.tone(out, t0 + 0.12, 'triangle', 700, 300, 0.2, 0.01, 0.12);
        break;
      case 'growl': {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(70 + Math.random() * 20, t0);
        o.frequency.linearRampToValueAtTime(55, t0 + 0.7);
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 26;
        const lg = ctx.createGain();
        lg.gain.value = 18;
        lfo.connect(lg).connect(o.frequency);
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 420;
        const g = ctx.createGain();
        this.env(g, t0, 0.45, 0.08, 0.6);
        o.connect(f).connect(g).connect(out);
        o.start(t0);
        lfo.start(t0);
        o.stop(t0 + 0.8);
        lfo.stop(t0 + 0.8);
        break;
      }
      case 'caw':
        this.tone(out, t0, 'sawtooth', 520, 340, 0.22, 0.02, 0.14);
        this.tone(out, t0 + 0.2, 'sawtooth', 480, 300, 0.2, 0.02, 0.16);
        break;
      case 'zdie': {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(140 + Math.random() * 40, t0);
        o.frequency.exponentialRampToValueAtTime(45, t0 + 0.45);
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.setValueAtTime(700, t0);
        f.frequency.exponentialRampToValueAtTime(200, t0 + 0.45);
        f.Q.value = 3;
        const g = ctx.createGain();
        this.env(g, t0, 0.5, 0.02, 0.45);
        o.connect(f).connect(g).connect(out);
        o.start(t0);
        o.stop(t0 + 0.55);
        break;
      }
      case 'scream': {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(800, t0);
        o.frequency.linearRampToValueAtTime(1500, t0 + 0.25);
        o.frequency.linearRampToValueAtTime(1100, t0 + 0.9);
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 28;
        const lg = ctx.createGain();
        lg.gain.value = 90;
        lfo.connect(lg).connect(o.frequency);
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 1400;
        f.Q.value = 2;
        const g = ctx.createGain();
        this.env(g, t0, 0.6, 0.03, 0.9);
        o.connect(f).connect(g).connect(out);
        lfo.start(t0);
        o.start(t0);
        o.stop(t0 + 1);
        lfo.stop(t0 + 1);
        this.duck(0.8, 0.5);
        break;
      }
      case 'beep':
        this.tone(out, t0, 'sine', 1000, 1000, 0.3, 0.002, 0.07);
        break;
      case 'bell': {
        // FM bell struck three times: the Dusk Bell.
        for (let k = 0; k < 3; k++) {
          const s = t0 + k * 1.1;
          const car = ctx.createOscillator();
          const mod = ctx.createOscillator();
          const mg = ctx.createGain();
          car.frequency.value = 330;
          mod.frequency.value = 330 * 2.76;
          mg.gain.setValueAtTime(380, s);
          mg.gain.exponentialRampToValueAtTime(5, s + 1.6);
          mod.connect(mg).connect(car.frequency);
          const g = ctx.createGain();
          this.env(g, s, 0.7, 0.004, 1.5);
          car.connect(g).connect(out);
          car.start(s);
          mod.start(s);
          car.stop(s + 1.7);
          mod.stop(s + 1.7);
        }
        this.duck(2.5, 0.35);
        break;
      }
      case 'pickup':
        this.tone(out, t0, 'triangle', 520, 780, 0.35, 0.005, 0.12);
        this.tone(out, t0 + 0.08, 'triangle', 780, 1040, 0.3, 0.005, 0.14);
        break;
      case 'loot':
        this.tone(out, t0, 'triangle', 400, 520, 0.3, 0.003, 0.1);
        this.burst(out, t0, 'bandpass', 2500, 1, 0.12, 0.002, 0.06);
        break;
      case 'click':
        this.tone(out, t0, 'square', 1200, 900, 0.12, 0.001, 0.025);
        break;
      case 'confirm':
        this.tone(out, t0, 'triangle', 600, 900, 0.25, 0.004, 0.1);
        this.tone(out, t0 + 0.07, 'triangle', 900, 1200, 0.2, 0.004, 0.12);
        break;
      case 'deny':
        this.tone(out, t0, 'square', 180, 120, 0.2, 0.004, 0.14);
        break;
      case 'build':
        this.tone(out, t0, 'square', 300, 240, 0.2, 0.002, 0.07);
        this.burst(out, t0, 'lowpass', 900, 0.6, 0.3, 0.002, 0.1);
        break;
      case 'alarm':
        for (let k = 0; k < 4; k++) this.tone(out, t0 + k * 0.28, 'sawtooth', 520, 520, 0.22, 0.01, 0.2);
        this.duck(1.4, 0.55);
        break;
      case 'retch':
        // A heave and a splatter.
        this.tone(out, t0, 'sawtooth', 130, 70, 0.4, 0.04, 0.3);
        this.burst(out, t0 + 0.28, 'lowpass', 700, 0.7, 0.35, 0.01, 0.35);
        this.tone(out, t0 + 0.55, 'sawtooth', 110, 60, 0.3, 0.03, 0.25);
        break;
      case 'laugh':
        for (let k = 0; k < 5; k++) this.tone(out, t0 + k * 0.12, 'sawtooth', 520 - k * 30 + Math.random() * 40, 380 - k * 25, 0.22, 0.01, 0.09);
        break;
      case 'hiccup':
        this.tone(out, t0, 'triangle', 240, 520, 0.3, 0.004, 0.07);
        this.burst(out, t0, 'bandpass', 900, 1.5, 0.12, 0.002, 0.05);
        break;
      case 'sing':
        for (const [k, f] of [[0, 330], [0.3, 392], [0.6, 349], [0.9, 294]] as const) this.tone(out, t0 + k, 'triangle', f * (0.96 + Math.random() * 0.08), f, 0.25, 0.04, 0.28);
        break;
      case 'whisper':
        this.burst(out, t0, 'bandpass', 3200, 2.5, 0.18, 0.25, 0.7);
        this.burst(out, t0 + 0.2, 'bandpass', 2400, 3, 0.12, 0.2, 0.6);
        break;
      case 'gulp':
        this.tone(out, t0, 'sine', 220, 120, 0.3, 0.01, 0.09);
        this.tone(out, t0 + 0.14, 'sine', 200, 110, 0.25, 0.01, 0.09);
        this.burst(out, t0, 'lowpass', 500, 0.6, 0.12, 0.01, 0.2);
        break;
      case 'toke':
        this.burst(out, t0, 'bandpass', 1400, 0.8, 0.25, 0.25, 0.4);
        this.tone(out, t0 + 0.55, 'sine', 90, 70, 0.1, 0.01, 0.2);
        break;
      case 'pill':
        this.tone(out, t0, 'square', 1500, 1100, 0.15, 0.001, 0.03);
        this.burst(out, t0 + 0.05, 'bandpass', 2200, 1, 0.1, 0.002, 0.06);
        break;
      case 'radio': {
        this.burst(out, t0, 'bandpass', 2600, 1.2, 0.22, 0.01, 0.28);
        this.tone(out, t0 + 0.05, 'square', 740, 740, 0.06, 0.004, 0.08);
        this.tone(out, t0 + 0.2, 'square', 520, 520, 0.05, 0.004, 0.1);
        break;
      }
    }
  }

  // ------------------------------------------------------------------ engines

  /** Engine loops crossfade with RPM; loudness follows Signature so players learn the Noise rules by ear. */
  updateEngines(list: EngineState[], dt: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.now += dt;
    const seen = new Set<number>();
    const maxVoices = 7;
    // Loudest/nearest first.
    const scored = list
      .map((e) => ({ e, n: this.nearest(e.x, e.z) }))
      .filter((s) => s.n.dist < 130)
      .sort((a, b) => a.n.dist - b.n.dist)
      .slice(0, maxVoices);
    for (const { e, n } of scored) {
      seen.add(e.id);
      let v = this.engines.get(e.id);
      if (!v) {
        v = this.makeEngine();
        this.engines.set(e.id, v);
      }
      v.lastSeen = this.now;
      const base = e.tier === 1 ? 62 : e.tier === 2 ? 48 : 34;
      const f = base * (1 + e.rpm * 2.6 + e.throttle * 0.35);
      const t = ctx.currentTime;
      v.osc1.frequency.setTargetAtTime(f, t, 0.08);
      v.osc2.frequency.setTargetAtTime(f * (e.tier === 1 ? 2.01 : 1.5), t, 0.08);
      v.filt.frequency.setTargetAtTime(380 + e.rpm * 1400 + e.throttle * 600, t, 0.1);
      const att = 1 / (1 + (n.dist / 22) ** 2);
      const loud = (0.04 + (e.signature / 100) * 0.16) * att * (0.6 + e.throttle * 0.5);
      v.gain.gain.setTargetAtTime(this.muted ? 0 : loud, t, 0.1);
      v.pan.pan.setTargetAtTime(n.bus === 0 ? -0.35 : 0.35, t, 0.1);
    }
    for (const [id, v] of this.engines) {
      if (!seen.has(id)) {
        v.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
        if (this.now - v.lastSeen > 1.5) {
          v.osc1.stop();
          v.osc2.stop();
          v.noise.stop();
          v.gain.disconnect();
          this.engines.delete(id);
        }
      }
    }
  }

  private makeEngine(): EngineVoice {
    const ctx = this.ctx!;
    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    const noise = this.noise();
    const ng = ctx.createGain();
    ng.gain.value = 0.18;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.Q.value = 2.5;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const pan = ctx.createStereoPanner();
    const mix = ctx.createGain();
    mix.gain.value = 0.5;
    osc1.connect(mix);
    osc2.connect(mix);
    noise.connect(ng).connect(mix);
    mix.connect(filt).connect(gain).connect(pan).connect(this.sfx);
    osc1.start();
    osc2.start();
    noise.start();
    return { osc1, osc2, noise, filt, gain, pan, lastSeen: this.now };
  }

  silenceEngines() {
    for (const [, v] of this.engines) {
      try {
        v.osc1.stop();
        v.osc2.stop();
        v.noise.stop();
        v.gain.disconnect();
      } catch {
        /* already stopped */
      }
    }
    this.engines.clear();
  }

  // ------------------------------------------------------------------ music

  private initMusic() {
    const ctx = this.ctx!;
    for (const name of ['drone', 'drums', 'pulse', 'harm', 'strings', 'pluck', 'hiss']) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.musicBus);
      this.stems[name] = g;
    }
    // Always-on bass drone
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = 41.2;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 180;
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = 41.4;
    o.connect(lp).connect(this.stems.drone);
    o2.connect(this.stems.drone);
    o.start();
    o2.start();
    this.bass = o;
    // Radio hiss for camp and calm
    const n = this.noise();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3500;
    const hg = ctx.createGain();
    hg.gain.value = 0.05;
    n.connect(hp).connect(hg).connect(this.stems.hiss);
    n.start();
    this.radioHiss = hg;
  }

  setMusic(state: MusicState) {
    if (!this.ctx || state === this.musicState) return;
    this.musicState = state;
    const target: Record<string, number> = { drone: 0, drums: 0, pulse: 0, harm: 0, strings: 0, pluck: 0, hiss: 0 };
    switch (state) {
      case 'travel':
        target.drone = 0.8;
        target.drums = 0.5;
        break;
      case 'stealth':
        target.drone = 0.7;
        target.pulse = 0.6;
        break;
      case 'combat':
        target.drone = 0.9;
        target.drums = 1;
        target.harm = 0.7;
        break;
      case 'camp':
        target.drone = 0.35;
        target.pluck = 0.7;
        target.hiss = 0.8;
        break;
      case 'raid':
        target.drone = 0.9;
        target.drums = 0.9;
        target.strings = 0.8;
        break;
      default:
        break;
    }
    const t = this.ctx.currentTime;
    for (const k of Object.keys(target)) this.stems[k].gain.setTargetAtTime(target[k], t, 0.8); // ~2 s crossfade
  }

  /** Called every frame: drives the stem sequencer. */
  updateMusic(dt: number) {
    const ctx = this.ctx;
    if (!ctx || this.musicState === 'none') return;
    this.musicTimer -= dt;
    if (this.musicTimer > 0) return;
    const state = this.musicState;
    const bpm = state === 'combat' ? 128 : state === 'raid' ? 110 : state === 'travel' ? 84 : state === 'stealth' ? 70 : 60;
    const step = 60 / bpm / 2;
    this.musicTimer = step;
    const t0 = ctx.currentTime + 0.05;
    const b = this.beat++;
    const root = [41.2, 41.2, 49, 36.7][Math.floor(b / 16) % 4];
    if (this.bass) this.bass.frequency.setTargetAtTime(root, t0, 0.3);
    // drums
    if (state === 'travel' || state === 'combat' || state === 'raid') {
      const g = this.stems.drums;
      if (b % 4 === 0 || (state !== 'travel' && b % 8 === 6)) this.drum(g, t0, 'kick');
      if (b % 4 === 2) this.drum(g, t0, 'snare');
      if (state !== 'travel' && b % 2 === 1) this.drum(g, t0, 'hat');
    }
    if (state === 'stealth' && b % 4 === 0) {
      this.tone(this.stems.pulse, t0, 'sine', root * 2, root * 2, 0.5, 0.01, 0.35);
      if (b % 16 === 8) this.tone(this.stems.pulse, t0, 'sine', root * 3, root * 3, 0.3, 0.01, 0.5);
    }
    if (state === 'combat' && b % 8 === 0) {
      for (const m of [1, 1.5, 2]) this.tone(this.stems.harm, t0, 'sawtooth', root * 2 * m, root * 2 * m, 0.14, 0.005, 0.5);
    }
    if (state === 'raid' && b % 16 === 0) {
      for (const m of [2, 3, 3.02, 4]) this.tone(this.stems.strings, t0, 'sawtooth', root * m, root * m, 0.12, 0.6, 2.4);
    }
    if (state === 'camp' && b % 2 === 0) {
      const scale = [1, 1.2, 1.5, 1.8, 2, 2.4];
      const m = scale[(b * 7 + Math.floor(b / 8)) % scale.length];
      this.tone(this.stems.pluck, t0, 'triangle', root * 4 * m, root * 4 * m * 0.99, 0.28, 0.003, 0.9);
    }
  }

  private drum(dest: AudioNode, t0: number, kind: 'kick' | 'snare' | 'hat') {
    if (kind === 'kick') {
      this.tone(dest, t0, 'sine', 120, 38, 0.9, 0.003, 0.22);
    } else if (kind === 'snare') {
      this.burst(dest, t0, 'bandpass', 1800, 0.7, 0.45, 0.002, 0.14);
      this.tone(dest, t0, 'triangle', 220, 120, 0.3, 0.002, 0.08);
    } else {
      this.burst(dest, t0, 'highpass', 7000, 0.7, 0.16, 0.001, 0.04);
    }
  }
}
