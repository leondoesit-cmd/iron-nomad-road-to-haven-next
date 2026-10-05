import { clamp } from '../core/math';
import { SampleLibrary } from './samples';
import { SpatialAudioEngine, type SpatialListener, type OcclusionTester } from './spatial';
import { RadioAudioEngine } from './radio';
import { VehicleAudioEngine, type EngineParams } from './engineAudio';
import { FoleyEngine } from './foley';

export type SoundId =
  | 'pistol'
  | 'shotgun'
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
  | 'pill'
  | 'munch'
  | 'trickle'
  | 'plop'
  | 'shell'
  | 'glass'
  | 'tink'
  | 'chip'
  | 'ricochet'
  | 'slash';

export type MusicState = 'none' | 'travel' | 'stealth' | 'combat' | 'camp' | 'raid';

export type EngineState = EngineParams;

export interface PlayOptions {
  occluded?: boolean | number;
  indoor?: boolean;
  /** Pitch multiplier, for the cues that take one (a swing: a knife is higher than an axe). */
  pitch?: number;
}

/**
 * AAA Hybrid Sample-Based Foley & Directional HRTF Audio Engine.
 * Features:
 * - Granular Multi-Layer Foley: hybrid sampled architecture for gunshots (mechanical clicks,
 *   explosive sub-bass body, dynamic shell casing bounces, indoor/canyon tail reverberations).
 * - Multi-Track RPM-Sampled Vehicle Audio: idle/mid/high loops, turbocharger spooling with blow-off
 *   valve, transmission whine, exhaust backfire pops, chassis creaks under G-force.
 * - Binaural 3D Spatial HRTF: Web Audio PannerNode with 'HRTF' panning and distance-attenuated
 *   low-pass occlusion when sound sources (infected, raiders, gunfire) are behind concrete walls.
 * - Contextual Voice Barks & Radio Chatter: authentic walkie-talkie bandpass, mic clicks,
 *   compression, squelch tails, and procedural speech cadence synthesis.
 */
export class AudioEngine {
  ctx: AudioContext | null = null;
  master!: GainNode;
  sfx!: GainNode;
  musicBus!: GainNode;
  buses: GainNode[] = [];
  private pans: StereoPannerNode[] = [];

  /** Per player: lowpass for being high, and a warbling echo. */
  private trip: {
    filt: BiquadFilterNode;
    fb: GainNode;
    wet: GainNode;
    delay: DelayNode;
    lfo: OscillatorNode;
    lfoGain: GainNode;
  }[] = [];

  private noiseBuf: AudioBuffer | null = null;
  listeners: SpatialListener[] = [{ x: 0, z: 0 }, { x: 0, z: 0 }];
  muted = false;
  volume = 0.7;
  musicVolume = 0.55;
  indoor = false;
  solo = false;

  // Subsystems
  samples: SampleLibrary | null = null;
  spatial: SpatialAudioEngine | null = null;
  radio: RadioAudioEngine | null = null;
  vehicleAudio: VehicleAudioEngine | null = null;
  foley: FoleyEngine | null = null;

  private stems: Record<string, GainNode> = {};
  private musicState: MusicState = 'none';
  private musicTimer = 0;
  private beat = 0;
  private bass?: OscillatorNode;
  private radioHiss?: GainNode;
  private wind?: { gain: GainNode; filt: BiquadFilterNode };
  private lastPlay = new Map<string, number>();

  /** Must be called from a user gesture. */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC =
      (typeof window !== 'undefined' &&
        (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)) ||
      (typeof globalThis !== 'undefined' && (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext) ||
      null;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;

    // Master bus & master compressor
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 5;
    this.master.connect(comp).connect(ctx.destination);

    // SFX bus
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 1;
    this.sfx.connect(this.master);

    // Music bus
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicVolume * 0.5;
    this.musicBus.connect(this.master);

    // Per-player buses
    for (let i = 0; i < 2; i++) {
      const g = ctx.createGain();
      const p = ctx.createStereoPanner();
      p.pan.value = this.solo ? 0 : i === 0 ? -0.35 : 0.35;

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

    // Generic noise buffer
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // Initialize AAA subsystems
    this.samples = new SampleLibrary(ctx);
    this.samples.init();

    this.spatial = new SpatialAudioEngine(ctx);
    this.spatial.setSolo(this.solo);

    this.radio = new RadioAudioEngine(ctx, this.samples);
    this.radio.setVolume(this.volume);
    this.radio.setMuted(this.muted);
    this.vehicleAudio = new VehicleAudioEngine(ctx, this.samples, this.spatial);
    this.foley = new FoleyEngine(ctx, this.samples);

    this.initMusic();
    this.initWind();
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master) this.master.gain.value = this.muted ? 0 : v;
    this.radio?.setVolume(v);
  }

  setMusicVolume(v: number) {
    this.musicVolume = v;
    if (this.musicBus) this.musicBus.gain.value = v * 0.5;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
    this.radio?.setMuted(m);
  }

  get ttsEnabled(): boolean {
    return this.radio?.ttsEnabled ?? true;
  }

  setTtsEnabled(enabled: boolean) {
    this.radio?.setTtsEnabled(enabled);
  }

  silenceRadio() {
    this.radio?.cancelActiveTransmission();
  }

  setSolo(s: boolean) {
    this.solo = s;
    if (this.spatial) this.spatial.setSolo(s);
    if (this.pans.length > 0 && s) {
      this.pans[0].pan.value = 0;
    }
  }

  setIndoor(indoor: boolean) {
    this.indoor = indoor;
    if (this.spatial) this.spatial.setIndoor(indoor);
  }

  setOcclusionTester(fn: OcclusionTester | null) {
    if (this.spatial) this.spatial.setOcclusionTester(fn);
  }

  /** How high a player is: muffle closes lowpass, echo opens delay. */
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

  setListeners(l: SpatialListener[]) {
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

  /**
   * Plays a contextual radio bark with authentic PTT key-in,
   * in-browser speech synthesis, RF carrier hiss, and squelch tail.
   */
  playRadioChatter(text: string, vol = 1) {
    if (!this.ctx || this.muted || !this.radio) return;
    // Route radio chatter through both player buses
    const out = this.ctx.createGain();
    out.gain.value = 1.0;
    out.connect(this.buses[0] || this.sfx);
    if (!this.solo && this.buses[1]) out.connect(this.buses[1]);
    const duration = this.radio.playRadioChatter(text, out, vol);
    this.duck(Math.max(1.5, duration + 0.2), 0.45);
  }

  /**
   * Play a sound effect. When `x` and `z` are provided, the sound is spatialized
   * using Web Audio PannerNode with 'HRTF' panning and distance-attenuated low-pass
   * occlusion through concrete walls.
   */
  play(id: SoundId, x?: number, z?: number, vol = 1, opts: PlayOptions = {}) {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;

    // Rate-limiting identical rapid cues
    const t0 = ctx.currentTime;
    const last = this.lastPlay.get(id) ?? 0;
    const minGap =
      id === 'mg'
        ? 0.04
        : id === 'pistol'
        ? 0.03
        : id === 'hit'
        ? 0.05
        : id === 'zdie'
        ? 0.04
        : id === 'thud'
        ? 0.04
        : id === 'shell'
        ? 0.035
        : id === 'tink' || id === 'chip'
        ? 0.045
        : id === 'ricochet'
        ? 0.08
        : id === 'slash'
        ? 0.05
        : id === 'yelp' || id === 'growl' || id === 'caw'
        ? 0.2
        : 0;
    if (t0 - last < minGap) return;
    this.lastPlay.set(id, t0);

    // 1. Non-positional UI sounds
    if (x === undefined || z === undefined) {
      for (const b of this.buses) this.voice(id, b, vol, opts);
      return;
    }

    // 2. Positional 3D HRTF with concrete wall occlusion
    if (this.spatial) {
      // Find eligible listeners within audible perimeter
      for (let i = 0; i < this.listeners.length; i++) {
        if (this.solo && i > 0) break;
        const l = this.listeners[i];
        const destBus = this.buses[i] || this.sfx;
        const route = this.spatial.createSpatialRoute(x, z, l, i, destBus, opts.occluded);
        if (route) {
          // Route voice through the occlusion filter and HRTF panner
          this.voice(id, route.filter, vol, { ...opts, indoor: opts.indoor ?? this.indoor });
        }
      }
    } else {
      // Fallback
      const n = this.nearest(x, z);
      if (n.dist > 170) return;
      const att = 1 / (1 + Math.pow(n.dist / 28, 2));
      this.voice(id, this.buses[n.bus] || this.sfx, vol * att, opts);
    }
  }

  private env(g: GainNode, t0: number, peak: number, attack: number, decay: number) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  private burst(
    dest: AudioNode,
    t0: number,
    type: BiquadFilterType,
    freq: number,
    q: number,
    peak: number,
    attack: number,
    decay: number,
  ) {
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

  private tone(
    dest: AudioNode,
    t0: number,
    type: OscillatorType,
    f0: number,
    f1: number,
    peak: number,
    attack: number,
    decay: number,
  ) {
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

  private voice(id: SoundId, dest: AudioNode, v: number, opts: PlayOptions = {}) {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = clamp(v, 0, 1.8);
    out.connect(dest);

    // Hybrid Foley Handlers
    switch (id) {
      case 'pistol':
      case 'shotgun':
      case 'mg':
      case 'sniper':
        if (this.foley) {
          this.foley.playGunshot(id, out, t0, {
            vol: 1,
            indoor: opts.indoor ?? this.indoor,
            canyon: !opts.indoor && !this.indoor,
          });
        } else {
          // Procedural fallback
          this.burst(out, t0, 'bandpass', 1900, 0.9, 0.9, 0.002, 0.11);
          this.tone(out, t0, 'triangle', 190, 55, 0.7, 0.002, 0.09);
        }
        break;

      case 'boom':
        if (this.foley) {
          this.foley.playExplosion(out, t0, 1.2);
        } else {
          this.burst(out, t0, 'lowpass', 900, 0.5, 1.2, 0.004, 1.0);
          this.tone(out, t0, 'sine', 90, 28, 1.1, 0.004, 0.9);
        }
        this.duck(0.7, 0.45);
        break;

      case 'bell':
        if (this.foley) {
          this.foley.playDuskBell(out, t0, 1.0);
        } else {
          for (let k = 0; k < 3; k++) {
            const s = t0 + k * 1.1;
            this.tone(out, s, 'sine', 330, 330, 0.7, 0.004, 1.5);
          }
        }
        this.duck(2.6, 0.35);
        break;

      case 'zdie':
        if (this.foley) {
          this.foley.playZombieDeath(out, t0, 0.85);
        } else {
          this.tone(out, t0, 'sawtooth', 140, 45, 0.5, 0.02, 0.45);
        }
        break;

      case 'crash':
        this.burst(out, t0, 'lowpass', 1400, 0.7, 1.1, 0.002, 0.35);
        this.tone(out, t0, 'square', 100, 40, 0.6, 0.002, 0.22);
        if (this.samples?.subBassBody.length) {
          const sSrc = ctx.createBufferSource();
          sSrc.buffer = this.samples.subBassBody[1];
          const sg = ctx.createGain();
          sg.gain.setValueAtTime(0.8, t0);
          sSrc.connect(sg).connect(out);
          sSrc.start(t0);
        }
        break;

      case 'hit':
        this.tone(out, t0, 'sine', 160, 60, 0.7, 0.002, 0.12);
        this.burst(out, t0, 'lowpass', 600, 0.5, 0.4, 0.002, 0.1);
        break;

      case 'thud':
        this.tone(out, t0, 'sine', 110, 45, 0.7, 0.003, 0.14);
        this.burst(out, t0, 'lowpass', 400, 0.5, 0.35, 0.002, 0.12);
        break;

      case 'swing': {
        const k = opts.pitch ?? 1;
        this.burst(out, t0, 'bandpass', 700 * k, 0.7, 0.3, 0.05, 0.12);
        // A heavy weapon drags a low rush behind the whoosh.
        if (k < 0.95) this.burst(out, t0 + 0.02, 'lowpass', 320, 0.6, 0.18, 0.06, 0.16);
        break;
      }

      case 'slash': {
        // A blade biting: a wet, bright rip over a short dull thump.
        this.burst(out, t0, 'bandpass', 1900, 0.9, 0.4, 0.001, 0.07);
        this.burst(out, t0, 'lowpass', 500, 0.5, 0.3, 0.001, 0.09);
        this.tone(out, t0, 'sine', 140, 60, 0.35, 0.002, 0.08);
        break;
      }

      case 'tink': {
        // A round striking metal: a dry slap and a short ring.
        this.burst(out, t0, 'highpass', 2400, 0.8, 0.3, 0.001, 0.04);
        const f = 1800 + Math.random() * 1400;
        this.tone(out, t0, 'triangle', f, f * 0.93, 0.18, 0.001, 0.09);
        break;
      }

      case 'chip': {
        // A round in stone, plaster or wood: a dull crack and falling grit.
        this.burst(out, t0, 'bandpass', 1100, 0.8, 0.35, 0.001, 0.06);
        this.burst(out, t0 + 0.03, 'highpass', 3500, 0.7, 0.1, 0.002, 0.12);
        break;
      }

      case 'ricochet': {
        // The whine of a round skipping off steel: a falling, wavering note.
        const f = 2600 + Math.random() * 900;
        this.tone(out, t0, 'sine', f, f * 0.42, 0.22, 0.003, 0.34);
        this.burst(out, t0, 'highpass', 3000, 0.8, 0.15, 0.001, 0.05);
        break;
      }

      case 'splash':
        this.burst(out, t0, 'bandpass', 1500, 0.8, 0.32, 0.01, 0.4);
        this.burst(out, t0, 'lowpass', 500, 0.6, 0.3, 0.005, 0.3);
        break;

      case 'drip':
        this.tone(out, t0, 'sine', 1700, 650, 0.1, 0.002, 0.09);
        break;

      case 'reload':
        // Multi-stage mechanical reload foley
        if (this.samples?.mechanicalClicks.length) {
          const c1 = ctx.createBufferSource();
          c1.buffer = this.samples.mechanicalClicks[0];
          c1.playbackRate.value = 1.1;
          const g1 = ctx.createGain();
          g1.gain.value = 0.5;
          c1.connect(g1).connect(out);
          c1.start(t0);

          const c2 = ctx.createBufferSource();
          c2.buffer = this.samples.mechanicalClicks[1];
          c2.playbackRate.value = 0.95;
          const g2 = ctx.createGain();
          g2.gain.value = 0.6;
          c2.connect(g2).connect(out);
          c2.start(t0 + 0.45);
        } else {
          this.tone(out, t0, 'square', 900, 700, 0.15, 0.002, 0.03);
          this.tone(out, t0 + 0.5, 'square', 1200, 800, 0.2, 0.002, 0.04);
        }
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

      case 'glass': {
        // A pane going: a hard crack and a spill of bright tinkles.
        this.burst(out, t0, 'highpass', 3000, 0.8, 0.5, 0.001, 0.12);
        for (let i = 0; i < 7; i++) {
          const f = 2600 + Math.random() * 3200;
          this.tone(out, t0 + 0.04 + i * 0.045 + Math.random() * 0.03, 'triangle', f, f * 0.97, 0.12, 0.001, 0.05);
        }
        break;
      }

      case 'shell': {
        // Brass ringing off a hard floor: a bright ping and a smaller one on the second hop.
        const f = 3100 + Math.random() * 1500;
        this.tone(out, t0, 'triangle', f, f * 0.96, 0.22, 0.001, 0.05);
        this.tone(out, t0 + 0.055, 'triangle', f * 1.08, f * 1.03, 0.11, 0.001, 0.035);
        this.burst(out, t0, 'highpass', 5200, 1, 0.1, 0.001, 0.015);
        break;
      }

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
        this.tone(out, t0, 'sawtooth', 130, 70, 0.4, 0.04, 0.3);
        this.burst(out, t0 + 0.28, 'lowpass', 700, 0.7, 0.35, 0.01, 0.35);
        this.tone(out, t0 + 0.55, 'sawtooth', 110, 60, 0.3, 0.03, 0.25);
        break;

      case 'laugh':
        for (let k = 0; k < 5; k++)
          this.tone(out, t0 + k * 0.12, 'sawtooth', 520 - k * 30 + Math.random() * 40, 380 - k * 25, 0.22, 0.01, 0.09);
        break;

      case 'hiccup':
        this.tone(out, t0, 'triangle', 240, 520, 0.3, 0.004, 0.07);
        this.burst(out, t0, 'bandpass', 900, 1.5, 0.12, 0.002, 0.05);
        break;

      case 'sing':
        for (const [k, f] of [[0, 330], [0.3, 392], [0.6, 349], [0.9, 294]] as const)
          this.tone(out, t0 + k, 'triangle', f * (0.96 + Math.random() * 0.08), f, 0.25, 0.04, 0.28);
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

      case 'munch':
        for (let k = 0; k < 4; k++) {
          this.burst(out, t0 + k * 0.17, 'bandpass', 1100 + Math.random() * 500, 1.2, 0.2, 0.004, 0.08);
          this.tone(out, t0 + k * 0.17, 'triangle', 160, 90, 0.08, 0.004, 0.06);
        }
        break;

      case 'trickle':
        this.burst(out, t0, 'bandpass', 2600, 0.7, 0.14, 0.15, 1.6);
        this.burst(out, t0 + 0.2, 'highpass', 4200, 0.5, 0.07, 0.2, 1.3);
        break;

      case 'plop':
        this.tone(out, t0, 'sine', 180, 60, 0.25, 0.004, 0.14);
        this.burst(out, t0, 'lowpass', 400, 0.8, 0.14, 0.004, 0.12);
        break;

      case 'radio':
        if (this.samples?.micClickIn) {
          const ptt = ctx.createBufferSource();
          ptt.buffer = this.samples.micClickIn;
          const g = ctx.createGain();
          g.gain.value = 0.8;
          ptt.connect(g).connect(out);
          ptt.start(t0);
        } else {
          this.burst(out, t0, 'bandpass', 2600, 1.2, 0.22, 0.01, 0.28);
          this.tone(out, t0 + 0.05, 'square', 740, 740, 0.06, 0.004, 0.08);
          this.tone(out, t0 + 0.2, 'square', 520, 520, 0.05, 0.004, 0.1);
        }
        break;
    }
  }

  // ---------------------------------------------------------------- Engines

  /**
   * Multi-track RPM-sampled vehicle engine audio loops with turbo spool,
   * transmission whine, backfire pops, and G-force chassis creaks.
   */
  updateEngines(list: EngineState[], dt: number) {
    if (!this.ctx) return;
    if (this.vehicleAudio) {
      this.vehicleAudio.updateEngines(list, dt, this.listeners, this.buses, this.muted);
    }
  }

  silenceEngines() {
    if (this.vehicleAudio) {
      this.vehicleAudio.silenceEngines();
    }
  }

  // ---------------------------------------------------------------- Wind

  private initWind() {
    const ctx = this.ctx!;
    const n = this.noise();
    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = 380;
    filt.Q.value = 0.7;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.17;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 140;
    lfo.connect(lfoGain).connect(filt.frequency);
    n.connect(filt).connect(gain).connect(this.sfx);
    n.start();
    lfo.start();
    this.wind = { gain, filt };
  }

  setWind(level: number) {
    const w = this.wind;
    if (!w || !this.ctx) return;
    w.gain.gain.setTargetAtTime(this.muted ? 0 : level * 0.42, this.ctx.currentTime, 0.6);
    w.filt.Q.setTargetAtTime(0.7 + level * 0.5, this.ctx.currentTime, 0.6);
  }

  // ---------------------------------------------------------------- Music

  private initMusic() {
    const ctx = this.ctx!;
    for (const name of ['drone', 'drums', 'pulse', 'harm', 'strings', 'pluck', 'hiss']) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.musicBus);
      this.stems[name] = g;
    }
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
    for (const k of Object.keys(target)) this.stems[k].gain.setTargetAtTime(target[k], t, 0.8);
  }

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
