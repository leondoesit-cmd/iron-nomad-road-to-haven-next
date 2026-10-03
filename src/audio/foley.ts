import { clamp } from '../core/math';
import type { SampleLibrary } from './samples';

export interface GunshotOptions {
  vol?: number;
  indoor?: boolean;
  canyon?: boolean;
}

/**
 * Granular Multi-Layer Hybrid Sampled Foley Engine.
 * Features:
 * - 5-Layer Gunshots: high-transient mechanical clicks, explosive sub-bass body,
 *   saturated muzzle combustion, dynamic delayed brass shell casing bounces,
 *   and indoor/canyon tail reverberations.
 * - Multi-layer explosions with supersonic shockwave, sub rumble, and debris scatter.
 * - Physical modeled FM bronze bells for the Dusk Bell with beating partials.
 * - Visceral infected flesh crunches, screamer shrieks, and wet spatter.
 */
export class FoleyEngine {
  ctx: AudioContext;
  samples: SampleLibrary;
  private noiseBuf: AudioBuffer;

  private indoorConvolver: ConvolverNode | null = null;
  private canyonConvolver: ConvolverNode | null = null;

  constructor(ctx: AudioContext, samples: SampleLibrary) {
    this.ctx = ctx;
    this.samples = samples;

    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this.initConvolvers();
  }

  private initConvolvers() {
    const ctx = this.ctx;
    if (this.samples.indoorImpulse) {
      try {
        const c = ctx.createConvolver();
        c.buffer = this.samples.indoorImpulse;
        this.indoorConvolver = c;
      } catch {
        /* fallback */
      }
    }
    if (this.samples.canyonImpulse) {
      try {
        const c = ctx.createConvolver();
        c.buffer = this.samples.canyonImpulse;
        this.canyonConvolver = c;
      } catch {
        /* fallback */
      }
    }
  }

  private noise(): AudioBufferSourceNode {
    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuf;
    n.loop = true;
    return n;
  }

  // ---------------------------------------------------------------- Gunshots
  playGunshot(
    caliber: 'pistol' | 'shotgun' | 'mg' | 'sniper',
    dest: AudioNode,
    t0: number,
    opts: GunshotOptions = {},
  ) {
    const ctx = this.ctx;
    const vol = opts.vol ?? 1;
    const isIndoor = !!opts.indoor;
    const isCanyon = opts.canyon !== false && !isIndoor;

    // Caliber scaling profiles
    const profile = {
      pistol: { clickGain: 0.9, subGain: 0.85, subIdx: 3, blastGain: 0.85, shellCount: 2, tailGain: 0.5 },
      shotgun: { clickGain: 1.15, subGain: 1.35, subIdx: 2, blastGain: 1.25, shellCount: 1, tailGain: 0.85 },
      mg: { clickGain: 0.75, subGain: 0.7, subIdx: 1, blastGain: 0.7, shellCount: 1, tailGain: 0.4 },
      sniper: { clickGain: 1.3, subGain: 1.45, subIdx: 0, blastGain: 1.35, shellCount: 2, tailGain: 1.1 },
    }[caliber];

    // Master gunshot gain
    const out = ctx.createGain();
    out.gain.setValueAtTime(clamp(vol, 0, 1.8), t0);
    out.connect(dest);

    // Layer 1: High-Transient Mechanical Click (striker, bolt slap, slide snap)
    if (this.samples.mechanicalClicks.length > 0) {
      const clickIdx = Math.floor(Math.random() * this.samples.mechanicalClicks.length);
      const clickBuf = this.samples.mechanicalClicks[clickIdx];
      const clickSrc = ctx.createBufferSource();
      clickSrc.buffer = clickBuf;
      clickSrc.playbackRate.value = 0.96 + Math.random() * 0.08;
      const clickGain = ctx.createGain();
      clickGain.gain.setValueAtTime(profile.clickGain * 1.1, t0);
      clickSrc.connect(clickGain).connect(out);
      clickSrc.start(t0);
    }

    // Layer 2: Explosive Sub-Bass Body (35-65Hz chest punch)
    if (this.samples.subBassBody.length > 0) {
      const subBuf = this.samples.subBassBody[profile.subIdx % this.samples.subBassBody.length];
      const subSrc = ctx.createBufferSource();
      subSrc.buffer = subBuf;
      subSrc.playbackRate.value = 0.98 + Math.random() * 0.04;
      const subGain = ctx.createGain();
      subGain.gain.setValueAtTime(profile.subGain * 1.2, t0);
      subSrc.connect(subGain).connect(out);
      subSrc.start(t0);
    }

    // Layer 3: Saturated Muzzle Blast Crack
    const blastNoise = this.noise();
    const blastFilt = ctx.createBiquadFilter();
    blastFilt.type = caliber === 'shotgun' || caliber === 'sniper' ? 'lowpass' : 'bandpass';
    blastFilt.frequency.setValueAtTime(caliber === 'shotgun' ? 3200 : caliber === 'sniper' ? 3600 : 2200, t0);
    blastFilt.Q.value = 0.8;
    const blastGain = ctx.createGain();
    blastGain.gain.setValueAtTime(0.0001, t0);
    blastGain.gain.linearRampToValueAtTime(profile.blastGain * 0.9, t0 + 0.002);
    blastGain.gain.exponentialRampToValueAtTime(0.0001, t0 + (caliber === 'sniper' ? 0.32 : caliber === 'shotgun' ? 0.24 : 0.1));
    blastNoise.connect(blastFilt).connect(blastGain).connect(out);
    blastNoise.start(t0);
    blastNoise.stop(t0 + 0.35);

    // Layer 4: Dynamic Delayed Brass Shell Casing Bounces
    if (this.samples.shellCasingBounces.length > 0) {
      const bCount = profile.shellCount;
      const baseDelay = 0.16 + Math.random() * 0.06;
      for (let b = 0; b < bCount; b++) {
        const bounceTime = t0 + baseDelay + b * (0.13 + Math.random() * 0.04);
        const sBuf = this.samples.shellCasingBounces[Math.floor(Math.random() * this.samples.shellCasingBounces.length)];
        const sSrc = ctx.createBufferSource();
        sSrc.buffer = sBuf;
        sSrc.playbackRate.value = 0.94 + Math.random() * 0.12;
        const sGain = ctx.createGain();
        sGain.gain.setValueAtTime((0.45 / (1 + b * 0.6)) * profile.clickGain, bounceTime);
        sSrc.connect(sGain).connect(dest);
        sSrc.start(bounceTime);
      }
    }

    // Layer 5: Indoor or Canyon Tail Reverberation
    const tailConvolver = isIndoor ? this.indoorConvolver : this.canyonConvolver;
    if (tailConvolver) {
      const tailGain = ctx.createGain();
      tailGain.gain.setValueAtTime(profile.tailGain * (isIndoor ? 0.6 : 0.85), t0);
      const tailSend = ctx.createGain();
      tailSend.gain.setValueAtTime(0.7, t0);
      out.connect(tailSend).connect(tailConvolver).connect(tailGain).connect(dest);
    } else {
      // Procedural tail delay fallback
      this.playProceduralTail(out, dest, t0, isIndoor ? 'indoor' : 'canyon', profile.tailGain);
    }
  }

  // ---------------------------------------------------------------- Explosions
  playExplosion(dest: AudioNode, t0: number, vol = 1) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = clamp(vol, 0, 1.8);
    out.connect(dest);

    // 1. Supersonic initial shockwave crack
    const n = this.noise();
    const hp = ctx.createBiquadFilter();
    hp.type = 'lowpass';
    hp.frequency.setValueAtTime(1400, t0);
    hp.frequency.exponentialRampToValueAtTime(160, t0 + 0.8);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t0);
    ng.gain.linearRampToValueAtTime(1.3, t0 + 0.004);
    ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.1);
    n.connect(hp).connect(ng).connect(out);
    n.start(t0);
    n.stop(t0 + 1.2);

    // 2. Sub-bass seismic rumble
    if (this.samples.subBassBody.length > 0) {
      const sub = ctx.createBufferSource();
      sub.buffer = this.samples.subBassBody[2];
      sub.playbackRate.value = 0.82;
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(1.5, t0);
      sub.connect(sg).connect(out);
      sub.start(t0);
    }

    // 3. Falling debris & shrapnel scatter
    for (let i = 0; i < 4; i++) {
      const debrisT = t0 + 0.22 + Math.random() * 0.45;
      const dNoise = this.noise();
      const dFilt = ctx.createBiquadFilter();
      dFilt.type = 'bandpass';
      dFilt.frequency.value = 1800 + Math.random() * 1200;
      const dg = ctx.createGain();
      dg.gain.setValueAtTime(0.0001, debrisT);
      dg.gain.linearRampToValueAtTime(0.18, debrisT + 0.005);
      dg.gain.exponentialRampToValueAtTime(0.0001, debrisT + 0.06);
      dNoise.connect(dFilt).connect(dg).connect(out);
      dNoise.start(debrisT);
      dNoise.stop(debrisT + 0.08);
    }

    // 4. Canyon rolling reverberation
    if (this.canyonConvolver) {
      const cGain = ctx.createGain();
      cGain.gain.setValueAtTime(1.1, t0);
      out.connect(this.canyonConvolver).connect(cGain).connect(dest);
    }
  }

  // ---------------------------------------------------------------- Dusk Bell (FM Physical Model)
  playDuskBell(dest: AudioNode, t0: number, vol = 1) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = vol;
    out.connect(dest);

    // 3 iconic Dusk Bell strikes
    for (let k = 0; k < 3; k++) {
      const s = t0 + k * 1.15;
      const fundamental = 330;
      // Physical beating partials of cast bronze bell
      const partials = [
        { f: fundamental, g: 0.8, decay: 2.2 },
        { f: fundamental * 2.01, g: 0.5, decay: 1.8 },
        { f: fundamental * 2.76, g: 0.42, decay: 1.4 },
        { f: fundamental * 4.12, g: 0.25, decay: 0.9 },
      ];

      for (const p of partials) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(p.f, s);
        // Beating shimmer
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 1.4 + Math.random() * 0.6;
        const lfoG = ctx.createGain();
        lfoG.gain.value = 2.5;
        lfo.connect(lfoG).connect(osc.frequency);

        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, s);
        g.gain.linearRampToValueAtTime(p.g * 0.7, s + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, s + p.decay);

        osc.connect(g).connect(out);
        osc.start(s);
        lfo.start(s);
        osc.stop(s + p.decay + 0.1);
        lfo.stop(s + p.decay + 0.1);
      }
    }
  }

  // ---------------------------------------------------------------- Zombie & Raider Foley
  playZombieDeath(dest: AudioNode, t0: number, vol = 1) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = vol;
    out.connect(dest);

    // 1. Skull fracture bone crunch & wet spatter
    if (this.samples.fleshCrunch.length > 0) {
      const src = ctx.createBufferSource();
      src.buffer = this.samples.fleshCrunch[Math.floor(Math.random() * this.samples.fleshCrunch.length)];
      src.playbackRate.value = 0.92 + Math.random() * 0.16;
      const g = ctx.createGain();
      g.gain.value = 1.0;
      src.connect(g).connect(out);
      src.start(t0);
    }

    // 2. Guttural death groan
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(140 + Math.random() * 30, t0);
    osc.frequency.exponentialRampToValueAtTime(45, t0 + 0.45);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(650, t0);
    f.frequency.exponentialRampToValueAtTime(190, t0 + 0.45);
    f.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.65, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.48);
    osc.connect(f).connect(g).connect(out);
    osc.start(t0);
    osc.stop(t0 + 0.55);
  }

  // ---------------------------------------------------------------- Procedural Tail Fallback
  private playProceduralTail(
    src: AudioNode,
    dest: AudioNode,
    t0: number,
    env: 'indoor' | 'canyon',
    gain: number,
  ) {
    const ctx = this.ctx;
    const delays = env === 'indoor' ? [0.015, 0.032, 0.055] : [0.08, 0.18, 0.34, 0.52];
    for (let i = 0; i < delays.length; i++) {
      const delay = ctx.createDelay(1.5);
      delay.delayTime.value = delays[i];
      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = env === 'indoor' ? 2400 : 1800 - i * 250;
      const g = ctx.createGain();
      g.gain.setValueAtTime((gain / (1 + i * 0.7)) * 0.35, t0);
      src.connect(delay).connect(filt).connect(g).connect(dest);
    }
  }
}
