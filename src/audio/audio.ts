import { UserMusic } from './userMusic';
import { clamp } from '../core/math';
import { SampleLibrary } from './samples';
import { SpatialAudioEngine, type SpatialListener, type OcclusionTester } from './spatial';
import { RadioAudioEngine } from './radio';
import { VehicleAudioEngine, type EngineParams } from './engineAudio';
import { FoleyEngine } from './foley';
import { RoomAcoustics, performance, soundProfile } from './dynamics';
import type { SpatialRoute } from './spatial';

export type SoundId =
  | 'weaponHandle' | 'magOut' | 'magIn' | 'weaponRack' | 'weaponPump' | 'weaponBolt' | 'weaponClick' | 'shellInsert'
  | 'carPanel' | 'tirePuncture' | 'engineStart' | 'engineStop' | 'starterFail'
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
  | 'slash'
  | 'plunge'
  | 'gasp'
  | 'quack'
  | 'howl'
  | 'bellow'
  | 'flutter'
  | 'chirp'
  | 'hiss'
  | 'twang'
  | 'creak'
  | 'thunk'
  | 'rustle' | 'treeHit' | 'treeCreak' | 'footGrass' | 'footStone' | 'footSand' | 'footWood' | 'thunder';

/**
 * The sound of the water around the players, 0..1 each: `roar` of the nearest waterfall and how `tall` it is (a tall one is
 * deeper), the `babble` of running water close by, how far into a swamp (`marsh`), and how far gone the light is (`night`),
 * which is when the frogs start.
 */
export interface WaterAmbience {
  roar: number;
  tall: number;
  babble: number;
  marsh: number;
  night: number;
}

/**
 * The living country around the players, 0..1 each: `birds` sing by day in the woods and meadows (a few larks even over the
 * dust), `cicadas` saw in the heat of the day among trees and scrub, `crickets` chirp in the grass after dark, and `owls`
 * call from the woods at night.
 */
export interface NatureAmbience {
  birds: number;
  cicadas: number;
  crickets: number;
  owls: number;
}

export type MusicState = 'none' | 'travel' | 'stealth' | 'combat' | 'camp' | 'raid';

export type EngineState = EngineParams;

export interface PlayOptions {
  occluded?: boolean | number;
  indoor?: boolean;
  /** 0 to 1: dull the sound with a low-pass, as a suppressor does to a gunshot (1 is a thick pillow). */
  muffle?: number;
  /** Pitch multiplier, for the cues that take one (a swing: a knife is higher than an axe). */
  pitch?: number;
  /** Physical action strength, independent of master volume or weapon suppression. */
  intensity?: number;
  /** Recorded mechanism or engine family to use for this event. */
  bank?: string;
  /** Override the cue's hearing range in metres. */
  range?: number;
}

/** Recording-based positional game audio, with per-player mixing and occlusion. */
export class AudioEngine {
  userMusic = new UserMusic();
  private userMusicActive = false;
  private radioTtsEnabled = false;
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

  listeners: SpatialListener[] = [{ x: 0, z: 0 }, { x: 0, z: 0 }];
  muted = false;
  volume = 0.7;
  musicVolume = 0.55;
  gameMusicEnabled = false;
  userMusicEnabled = true;
  userMusicVolume = 0.55;
  indoor = false;
  solo = false;

  // Subsystems
  samples: SampleLibrary | null = null;
  spatial: SpatialAudioEngine | null = null;
  radio: RadioAudioEngine | null = null;
  vehicleAudio: VehicleAudioEngine | null = null;
  foley: FoleyEngine | null = null;

  private musicState: MusicState = 'none';
  private lastPlay = new Map<string, number>();
  private rooms: RoomAcoustics[] = [];
  private active = new Set<{ x: number; z: number; route: SpatialRoute; opts: PlayOptions; shape: { range: number; reference: number }; source: AudioBufferSourceNode }>();
  private environmentUpdate = -Infinity;
  /** Smoothed 0..1 per listener: how far inside a running vehicle they sit. */
  private cabin = [0, 0];
  private cabinTarget = [0, 0];
  private cabinAt = 0;

  /** Everything but gunfire, blasts and the vehicle's own noise gives way to a running engine the listener sits in. */
  private duckFor(id: string, i: number) {
    if (['pistol', 'shotgun', 'mg', 'sniper', 'boom', 'horn', 'crash', 'carPanel', 'glass', 'tink', 'chip', 'tirePuncture', 'ricochet', 'siren', 'alarm'].includes(id) || id.startsWith('engine') || id === 'starterFail') return 1;
    return 1 - 0.7 * (this.cabin[i] ?? 0);
  }
  /** The beds are shared by both halves, so they only give way when everyone listening sits in a running cab. */
  private bedDuck() { return 1 - 0.7 * (this.solo ? this.cabin[0] : Math.min(this.cabin[0], this.cabin[1])); }

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
    this.musicBus.gain.value = this.userMusicActive || !this.gameMusicEnabled ? 0 : this.musicVolume * 0.5;
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

    this.rooms = this.buses.map(bus => new RoomAcoustics(ctx, bus));
    this.samples = new SampleLibrary(ctx);
    void this.samples.init();

    this.spatial = new SpatialAudioEngine(ctx);
    this.spatial.setSolo(this.solo);
    // A scene built before the first click (the title demo) handed its occlusion test over already.
    this.spatial.setOcclusionTester(this.occlusion);

    this.radio = new RadioAudioEngine(ctx, this.samples);
    this.radio.setVolume(this.volume);
    this.radio.setMuted(this.muted);
    this.radio.setTtsEnabled(this.radioTtsEnabled);
    this.vehicleAudio = new VehicleAudioEngine(ctx, this.samples, this.spatial);
    this.foley = new FoleyEngine(ctx, this.samples);


  }

  updateUserMusic(inVehicle: boolean) {
    this.userMusic.update(inVehicle && this.userMusicEnabled, this.radio?.speechActive ?? false, this.volume * this.userMusicVolume, this.muted);
    const active = inVehicle && this.userMusicEnabled && this.userMusic.available;
    if (active !== this.userMusicActive) {
      this.userMusicActive = active;
      if (this.musicBus) this.musicBus.gain.value = active || !this.gameMusicEnabled ? 0 : this.musicVolume * 0.5;
    }
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master) this.master.gain.value = this.muted ? 0 : v;
    this.radio?.setVolume(v);
  }

  setMusicVolume(v: number) {
    this.musicVolume = v;
    if (this.musicBus) this.musicBus.gain.value = this.userMusicActive || !this.gameMusicEnabled ? 0 : v * 0.5;
  }

  setGameMusicEnabled(enabled: boolean) {
    this.gameMusicEnabled = enabled;
    if (this.musicBus) this.musicBus.gain.value = !enabled || this.userMusicActive ? 0 : this.musicVolume * 0.5;
  }

  setUserMusicEnabled(enabled: boolean) {
    this.userMusicEnabled = enabled;
    if (!enabled) this.updateUserMusic(false);
  }

  setUserMusicVolume(v: number) {
    this.userMusicVolume = clamp(v, 0, 1);
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
    this.radio?.setMuted(m);
  }

  get ttsEnabled(): boolean {
    return this.radioTtsEnabled;
  }

  setTtsEnabled(enabled: boolean) {
    this.radioTtsEnabled = enabled;
    this.radio?.setTtsEnabled(enabled);
  }

  silenceRadio() {
    this.radio?.cancelActiveTransmission();
  }

  setSolo(s: boolean) {
    this.solo = s;
    if (this.spatial) this.spatial.setSolo(s);
    this.pans.forEach((pan, i) => { pan.pan.value = s ? 0 : i === 0 ? -0.35 : 0.35; });
  }

  setIndoor(indoor: boolean) {
    this.indoor = indoor;
    if (this.spatial) this.spatial.setIndoor(indoor);
  }

  /** The live scene's occlusion test, kept even before the audio context exists. */
  occlusion: OcclusionTester | null = null;
  setOcclusionTester(fn: OcclusionTester | null) {
    this.occlusion = fn;
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
    l.forEach((x, i) => { this.cabinTarget[i] = clamp(x.cabin ?? 0, 0, 1); });
    if (this.ctx) {
      const dt = clamp(this.ctx.currentTime - this.cabinAt, 0, 0.25); this.cabinAt = this.ctx.currentTime;
      for (let i = 0; i < 2; i++) this.cabin[i] += (this.cabinTarget[i] - this.cabin[i]) * (1 - Math.exp(-dt * 3));
      this.vehicleAudio && (this.vehicleAudio.cabin = this.cabin);
    }
    if (!this.ctx) return;
    if (this.ctx.currentTime - this.environmentUpdate > 0.25) {
      this.environmentUpdate = this.ctx.currentTime;
      l.forEach((listener, i) => {
        let enclosure = listener.enclosure ?? ((listener.indoor ?? this.indoor) ? 1 : 0);
        if (listener.enclosure === undefined && !(listener.indoor ?? this.indoor) && this.spatial?.occlusionTester) {
          let walls = 0;
          for (const [dx, dz] of [[14,0],[-14,0],[0,14],[0,-14]]) {
            const occ = this.spatial.occlusionTester(listener.x, listener.z, listener.x + dx, listener.z + dz);
            walls += typeof occ === 'boolean' ? Number(occ) : clamp(occ, 0, 1);
          }
          enclosure = walls / 4 * 0.65;
        }
        this.rooms[i]?.update(enclosure);
      });
    }
    for (const voice of this.active) {
      const listener = l[voice.route.busIndex];
      if (listener) this.spatial?.updateSpatialRoute(voice.route, voice.x, voice.z, listener, voice.opts.occluded, voice.shape);
    }
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
    setTimeout(() => out.disconnect(), (duration + 0.5) * 1000);
    this.duck(Math.max(1.5, duration + 0.2), 0.45);
  }

  /**
   * Play a sound effect. When `x` and `z` are provided, the sound is spatialized
   * using Web Audio PannerNode with 'HRTF' panning and distance-attenuated low-pass
   * occlusion through concrete walls.
   */
  play(id: SoundId, x?: number, z?: number, vol = 1, opts: PlayOptions = {}) {
    const ctx = this.ctx;
    if (!ctx || this.muted || !this.samples) return;
    const bank = opts.bank && this.samples.all(opts.bank).length ? opts.bank : id;
    const emitterKey = x === undefined || z === undefined ? id : `${id}:${Math.round(x / 4)}:${Math.round(z / 4)}`;
    if (!this.samples.all(bank).length) {
      // Recordings load by priority after the first click. A cue asked for before its bank has arrived jumps the queue
      // and plays when it lands, if that is soon enough still to belong to the moment (a menu click may come late; a
      // gunshot may not). Repeats while it loads collapse into one.
      const asked = ctx.currentTime;
      const late = x === undefined || z === undefined ? 0.8 : 0.35;
      this.samples.whenReady(bank, emitterKey, () => {
        if (this.ctx && this.ctx.currentTime - asked <= late) this.play(id, x, z, vol, opts);
      });
      return;
    }

    // Rate-limiting identical rapid cues
    const t0 = ctx.currentTime;
    const last = this.lastPlay.get(emitterKey) ?? -Infinity;
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
        : id === 'quack' || id === 'flutter' || id === 'chirp' || id === 'bellow' || id === 'hiss'
        ? 0.12
        : id === 'howl'
        ? 0.25
        : id === 'thunk'
        ? 0.03
        : 0;
    if (t0 - last < minGap) return;
    this.lastPlay.set(emitterKey, t0);
    if (this.lastPlay.size > 512) for (const [key, time] of this.lastPlay) if (t0 - time > 5) this.lastPlay.delete(key);
    // Select once per physical event: both listeners hear the same recorded performance.
    const buffer = this.samples.get(bank)!;
    const variation = performance(id, opts.intensity ?? clamp(vol, 0, 1), opts.pitch ?? 1);
    const eventOpts = { ...opts, pitch: variation.pitch };
    // A wing-clap in the leaves is a rustle, not a bang: the take is recorded loud.
    const eventVolume = vol * variation.gain * (id === 'flutter' ? 0.22 : 1);

    // 1. Non-positional UI sounds
    if (x === undefined || z === undefined) {
      this.voice(id, this.sfx, eventVolume, eventOpts, buffer, variation.cutoff);
      return;
    }

    // 2. Positional 3D HRTF with concrete wall occlusion
    if (this.spatial) {
      // Find eligible listeners within audible perimeter
      const profile = soundProfile(id);
      const shape = { range: opts.range ?? profile.range, reference: profile.reference };
      for (let i = 0; i < this.listeners.length; i++) {
        if (this.solo && i > 0) break;
        const l = this.listeners[i];
        const destBus = this.rooms[i]?.input || this.buses[i] || this.sfx;
        const route = this.spatial.createSpatialRoute(x, z, l, i, destBus, opts.occluded, shape);
        if (route) {
          const source = this.voice(id, route.filter, eventVolume * this.duckFor(id, i), eventOpts, buffer, variation.cutoff);
          if (!source) continue;
          const voice = { x, z, route, opts, shape, source };
          this.active.add(voice);
          const cleanup = source.onended;
          source.onended = event => {
            cleanup?.call(source, event);
            this.active.delete(voice);
            route.filter.disconnect(); route.panner.disconnect(); route.gain.disconnect();
          };
          // Bound simultaneous voices; evict oldest effects during dense action.
          if (this.active.size > 64) {
            const oldest = this.active.values().next().value!;
            oldest.route.gain.gain.setTargetAtTime(0, t0, 0.015);
            oldest.source.stop(t0 + 0.06);
            this.active.delete(oldest);
          }
        }
      }
    } else {
      // Fallback
      const n = this.nearest(x, z);
      if (n.dist > 170) return;
      const att = 1 / (1 + Math.pow(n.dist / 28, 2));
      this.voice(id, this.buses[n.bus] || this.sfx, eventVolume * att, eventOpts, buffer, variation.cutoff);
    }
  }

  private voice(id: SoundId, dest: AudioNode, v: number, opts: PlayOptions = {}, buffer?: AudioBuffer, cutoff = 22000) {
    const ctx = this.ctx!;
    const take = buffer ?? this.samples?.get(id);
    if (!take || !this.samples) return null;
    const out = ctx.createGain();
    out.gain.value = clamp(v, 0, 1.8);
    // A casing on the ground is a dry tick, not a struck bell: the metal recording's ring is chopped off after a few ms.
    if (id === 'shell') {
      const t = ctx.currentTime, g = clamp(v, 0, 1.8);
      out.gain.setValueAtTime(g, t);
      out.gain.exponentialRampToValueAtTime(Math.max(0.0005, g * 0.02), t + 0.07);
      out.gain.linearRampToValueAtTime(0, t + 0.1);
    }
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.value = Math.min(id === 'shell' ? 4200 : cutoff, opts.muffle ? 6500 - 5600 * clamp(opts.muffle, 0, 1) : 22000);
    out.connect(lp).connect(dest);
    const source = this.samples.playBuffer(take, out, ctx.currentTime, 1, opts.pitch ?? 1);
    const cleanup = source.onended;
    source.onended = event => { cleanup?.call(source, event); out.disconnect(); lp.disconnect(); };
    return source;
  }

  updateEngines(list: EngineState[], dt: number) {
    if (!this.ctx) return;
    if (this.vehicleAudio) {
      this.vehicleAudio.updateEngines(list, dt, this.listeners, this.rooms.length ? this.rooms.map(room => room.input) : this.buses, this.muted);
    }
  }

  silenceEngines() {
    for (const voice of this.active) voice.source.stop();
    this.active.clear();
    for (const id of this.ambience.keys()) this.setRecordedAmbience(id, 0);
    if (this.vehicleAudio) {
      this.vehicleAudio.silenceEngines();
    }
  }

  private ambience = new Map<string, {
    gain: GainNode; filter: BiquadFilterNode; nextAt: number; phase: number;
    layers: Set<{ source: AudioBufferSourceNode; envelope: GainNode; retiring: boolean }>;
  }>();
  /** Slow changes and overlapping recorded takes avoid an endlessly identical loop. */
  setRecordedAmbience(id: string, level: number, cutoff = 20000) {
    const ctx = this.ctx;
    if (!ctx || !this.samples) return;
    const target = clamp(level, 0, 1) * this.bedDuck(), now = ctx.currentTime;
    let bed = this.ambience.get(id);
    if (target < 0.001) {
      if (bed) {
        bed.gain.gain.setTargetAtTime(0, now, 0.12);
        for (const layer of bed.layers) if (!layer.retiring) { layer.retiring = true; layer.source.stop(now + 0.6); }
        this.ambience.delete(id);
      }
      return;
    }
    if (!bed) {
      if (!this.samples.all(id).length) return;
      const gain = ctx.createGain(); gain.gain.value = 0;
      const filter = ctx.createBiquadFilter(); filter.type = 'lowpass';
      filter.connect(gain).connect(this.sfx);
      bed = { gain, filter, nextAt: now, phase: Math.random() * Math.PI * 2, layers: new Set() };
      this.ambience.set(id, bed);
    }
    if (now >= bed.nextAt) {
      const buffer = this.samples.get(id);
      if (buffer) {
        const fade = Math.min(1.8, Math.max(0.25, buffer.duration * 0.15));
        for (const layer of bed.layers) if (!layer.retiring) {
          layer.retiring = true;
          layer.envelope.gain.setTargetAtTime(0, now, fade / 4);
          layer.source.stop(now + fade);
        }
        const source = ctx.createBufferSource(); source.buffer = buffer; source.loop = true;
        // Keep field-recorded animal pitch essentially intact.
        source.playbackRate.value = 0.996 + Math.random() * 0.008;
        const envelope = ctx.createGain(); envelope.gain.value = 0;
        source.connect(envelope).connect(bed.filter);
        envelope.gain.setTargetAtTime(1, now, fade / 4);
        const layer = { source, envelope, retiring: false };
        const owner = bed;
        owner.layers.add(layer);
        source.onended = () => {
          source.disconnect(); envelope.disconnect(); owner.layers.delete(layer);
          if (!owner.layers.size) { owner.filter.disconnect(); owner.gain.disconnect(); }
        };
        source.start(now, Math.random() * buffer.duration);
        bed.nextAt = now + Math.max(4, Math.min(20, buffer.duration * 0.85));
      }
    }
    const swell = 0.94 + 0.06 * Math.sin(now * 0.17 + bed.phase);
    bed.gain.gain.setTargetAtTime(target * swell, now, 0.4);
    bed.filter.frequency.setTargetAtTime(cutoff, now, 0.3);
  }
  setWind(level: number) { this.setRecordedAmbience('wind', 0.15 * clamp(level, 0, 1)); }
  setVegetationAmbience(trees: number, grass: number, wind: number) {
    this.setRecordedAmbience('vegetation', trees * (0.035 + wind * 0.22));
    this.setRecordedAmbience('grassWind', grass * (0.025 + wind * 0.12));
  }
  setWaterAmbience(a: WaterAmbience) {
    this.setRecordedAmbience('waterfall', a.roar * 0.45, 15000 - a.tall * 5000);
    this.setRecordedAmbience('stream', a.babble * 0.22);
    this.setRecordedAmbience('frogs', a.marsh * a.night * 0.12);
  }
  setNatureAmbience(a: NatureAmbience) {
    this.setRecordedAmbience('birds', a.birds * 0.12);
    this.setRecordedAmbience('cicadas', a.cicadas * 0.09);
    this.setRecordedAmbience('crickets', a.crickets * 0.1);
    this.setRecordedAmbience('owl', a.owls * 0.08);
  }
  // Procedural score removed. Player-selected recordings continue through UserMusic.
  setMusic(state: MusicState) { this.musicState = state; }
  updateMusic(_dt: number) {}
}
