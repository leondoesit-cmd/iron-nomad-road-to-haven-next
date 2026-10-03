import { clamp, damp } from '../core/math';
import type { SampleLibrary } from './samples';
import type { SpatialAudioEngine, SpatialListener } from './spatial';

export interface EngineParams {
  id: number;
  x: number;
  z: number;
  rpm: number;
  throttle: number;
  tier: number;
  signature: number;
  speed?: number;
  lateralG?: number;
  boost?: number;
}

interface ActiveEngineVoice {
  // Multi-track RPM sample sources & gains
  idleSrc: AudioBufferSourceNode;
  idleGain: GainNode;
  midSrc: AudioBufferSourceNode;
  midGain: GainNode;
  highSrc: AudioBufferSourceNode;
  highGain: GainNode;

  // Turbocharger circuit
  turboOsc: OscillatorNode;
  turboGain: GainNode;
  turboSpool: number; // 0..1 current spool

  // Transmission whine
  transOsc: OscillatorNode;
  transGain: GainNode;

  // Master engine mix & spatial routing
  mixGain: GainNode;
  filter: BiquadFilterNode;
  panner: PannerNode | StereoPannerNode;
  spatialGain: GainNode;

  lastSeen: number;
  lastRpm: number;
  lastThrottle: number;
  backfireCooldown: number;
  creakCooldown: number;
  smoothedOcc: number;
}

/**
 * Multi-Track RPM-Sampled Vehicle Audio Engine.
 * Features:
 * - Multi-track RPM crossfading (idle, mid, and high RPM loop tracks)
 * - Turbocharger spooling whine with blow-off valve (BOV) pressure dumps on lift-off
 * - Transmission whine pitch-locked to ground speed
 * - Explosive exhaust backfire pops on overrun/deceleration
 * - Stressed chassis frame creaks and suspension groans under lateral G-forces
 * - 3D HRTF spatialization and distance-attenuated wall occlusion
 */
export class VehicleAudioEngine {
  ctx: AudioContext;
  samples: SampleLibrary;
  spatial: SpatialAudioEngine;
  private voices = new Map<number, ActiveEngineVoice>();
  private now = 0;

  constructor(ctx: AudioContext, samples: SampleLibrary, spatial: SpatialAudioEngine) {
    this.ctx = ctx;
    this.samples = samples;
    this.spatial = spatial;
  }

  updateEngines(
    list: EngineParams[],
    dt: number,
    listeners: SpatialListener[],
    buses: GainNode[],
    muted: boolean,
  ) {
    const ctx = this.ctx;
    this.now += dt;
    const seen = new Set<number>();
    const maxVoices = 6;

    // Sort by proximity to nearest listener
    const scored = list
      .map((e) => {
        let bestDist = Infinity;
        let bestListener = listeners[0];
        let bestBus = 0;
        listeners.forEach((l, i) => {
          const d = Math.hypot(e.x - l.x, e.z - l.z);
          if (d < bestDist) {
            bestDist = d;
            bestListener = l;
            bestBus = i;
          }
        });
        return { e, dist: bestDist, listener: bestListener, bus: bestBus };
      })
      .filter((s) => s.dist < 150)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, maxVoices);

    for (const { e, dist, listener, bus } of scored) {
      seen.add(e.id);
      let v = this.voices.get(e.id);
      if (!v) {
        v = this.makeEngineVoice(e, buses[bus] || buses[0]);
        this.voices.set(e.id, v);
      }
      v.lastSeen = this.now;

      const t = ctx.currentTime;
      const rpm = clamp(e.rpm, 0, 1);
      const throttle = clamp(e.throttle, 0, 1);
      const speed = e.speed ?? (rpm * 20);
      const lateralG = e.lateralG ?? 0;

      // 1. Multi-Track RPM Gain Crossfading
      // Idle: 1 at 0 RPM, drops to 0 at 0.45 RPM
      const idleLoud = clamp(1 - rpm * 2.2, 0, 1);
      // Mid: peaks around 0.45 RPM, smooth bell
      const midLoud = clamp(1 - Math.abs(rpm - 0.48) * 2.4, 0, 1);
      // High: rises from 0.4 to 1.0 RPM
      const highLoud = clamp((rpm - 0.38) * 1.6, 0, 1);

      v.idleGain.gain.setTargetAtTime(idleLoud * 0.75, t, 0.08);
      v.midGain.gain.setTargetAtTime(midLoud * 0.85, t, 0.08);
      v.highGain.gain.setTargetAtTime(highLoud * 0.95, t, 0.08);

      // Organic pitch modulation of loop tracks
      const rateIdle = clamp(0.9 + rpm * 0.4, 0.8, 1.4);
      const rateMid = clamp(0.85 + rpm * 0.45, 0.8, 1.45);
      const rateHigh = clamp(0.88 + rpm * 0.42, 0.85, 1.4);
      v.idleSrc.playbackRate.setTargetAtTime(rateIdle, t, 0.08);
      v.midSrc.playbackRate.setTargetAtTime(rateMid, t, 0.08);
      v.highSrc.playbackRate.setTargetAtTime(rateHigh, t, 0.08);

      // 2. Turbocharger Spooling & Blow-Off Valve (BOV)
      const targetSpool = throttle * (0.35 + 0.65 * rpm);
      v.turboSpool = damp(v.turboSpool, targetSpool, 3.2, dt);
      const turboPitch = 2100 + v.turboSpool * 4600;
      v.turboOsc.frequency.setTargetAtTime(turboPitch, t, 0.06);
      v.turboGain.gain.setTargetAtTime(v.turboSpool * 0.18, t, 0.06);

      // Blow-Off Valve discharge on sudden throttle lift-off
      if (v.lastThrottle > 0.65 && throttle < 0.15 && v.turboSpool > 0.4 && this.samples.turboBov) {
        this.playOneShotSample(this.samples.turboBov, v.mixGain, 0.65, 0.95 + Math.random() * 0.1);
      }

      // 3. Transmission Whine
      const transPitch = clamp(190 + Math.abs(speed) * 44, 180, 2400);
      v.transOsc.frequency.setTargetAtTime(transPitch, t, 0.06);
      const transVol = clamp((Math.abs(speed) / 25) * (0.04 + throttle * 0.06), 0, 0.14);
      v.transGain.gain.setTargetAtTime(transVol, t, 0.06);

      // 4. Exhaust Backfire Pops on Overrun
      v.backfireCooldown = Math.max(0, v.backfireCooldown - dt);
      if (v.lastRpm > 0.62 && throttle < 0.12 && v.backfireCooldown <= 0 && this.samples.backfirePops.length > 0) {
        v.backfireCooldown = 0.65 + Math.random() * 0.6;
        const popCount = 1 + Math.floor(Math.random() * 3);
        for (let p = 0; p < popCount; p++) {
          const delay = p * (0.06 + Math.random() * 0.04);
          const popBuf = this.samples.backfirePops[Math.floor(Math.random() * this.samples.backfirePops.length)];
          this.playDelayedSample(popBuf, v.mixGain, delay, 0.85, 0.9 + Math.random() * 0.2);
        }
      }

      // 5. Chassis Creaks under G-force Loads
      v.creakCooldown = Math.max(0, v.creakCooldown - dt);
      if (Math.abs(lateralG) > 0.42 && v.creakCooldown <= 0 && this.samples.chassisCreaks.length > 0) {
        v.creakCooldown = 1.1 + Math.random() * 0.7;
        const creakBuf = this.samples.chassisCreaks[Math.floor(Math.random() * this.samples.chassisCreaks.length)];
        this.playOneShotSample(creakBuf, v.mixGain, 0.6, 0.9 + Math.random() * 0.2);
      }

      // 6. 3D Spatial HRTF & Continuous Acoustic Obstacle Occlusion
      let targetOcc = 0;
      if (this.spatial.occlusionTester) {
        const res = this.spatial.occlusionTester(listener.x, listener.z, e.x, e.z);
        targetOcc = typeof res === 'boolean' ? (res ? 1 : 0) : clamp(res, 0, 1);
      }

      // Smooth temporal interpolation to eliminate on/off switch artifact
      v.smoothedOcc = damp(v.smoothedOcc, targetOcc, 4.0, dt);
      const occ = v.smoothedOcc;

      // Distance attenuation + natural acoustic diffraction low-pass
      const airCutoff = 22000 / (1 + dist / 50);
      // Continuous frequency roll-off: gentle roll-off for partial diffraction, deeper for full wall
      const wallCutoff = clamp(airCutoff * Math.pow(1 - occ * 0.72, 1.8) + 420, 380, 20000);
      v.filter.frequency.setTargetAtTime(wallCutoff, t, 0.18);

      const att = 1 / (1 + Math.pow(Math.max(0, dist - 3.5) / 22, 1.4));
      // Occlusion volume attenuation: smooth -4dB max cut instead of harsh 65% drop
      const occMult = 1 / (1 + occ * 1.0);
      const signatureLoud = (0.05 + (e.signature / 100) * 0.2) * (0.55 + throttle * 0.45);
      const targetGain = muted ? 0 : signatureLoud * att * occMult;
      v.spatialGain.gain.setTargetAtTime(targetGain, t, 0.18);

      // Panner update
      const yaw = listener.yaw ?? 0;
      const dx = e.x - listener.x;
      const dz = e.z - listener.z;
      const localX = dx * Math.cos(yaw) - dz * Math.sin(yaw);
      const localZ = -(dx * Math.sin(yaw) + dz * Math.cos(yaw));

      if ('positionX' in v.panner && v.panner.positionX) {
        v.panner.positionX.setTargetAtTime(localX, t, 0.08);
        v.panner.positionY.setTargetAtTime(0, t, 0.08);
        v.panner.positionZ.setTargetAtTime(localZ, t, 0.08);
      } else if ('pan' in v.panner) {
        v.panner.pan.setTargetAtTime(clamp(localX / Math.max(1, dist), -1, 1), t, 0.08);
      }

      v.lastRpm = rpm;
      v.lastThrottle = throttle;
    }

    // Cleanup faded voices
    for (const [id, v] of this.voices) {
      if (!seen.has(id)) {
        v.spatialGain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
        if (this.now - v.lastSeen > 1.2) {
          this.destroyEngineVoice(v);
          this.voices.delete(id);
        }
      }
    }
  }

  private makeEngineVoice(e: EngineParams, dest: AudioNode): ActiveEngineVoice {
    const ctx = this.ctx;
    const t0 = ctx.currentTime;

    // Multi-track RPM sample sources
    const idleSrc = ctx.createBufferSource();
    idleSrc.buffer = this.samples.engineIdle;
    idleSrc.loop = true;
    const idleGain = ctx.createGain();
    idleGain.gain.value = 0.001;
    idleSrc.connect(idleGain);

    const midSrc = ctx.createBufferSource();
    midSrc.buffer = this.samples.engineMid;
    midSrc.loop = true;
    const midGain = ctx.createGain();
    midGain.gain.value = 0.001;
    midSrc.connect(midGain);

    const highSrc = ctx.createBufferSource();
    highSrc.buffer = this.samples.engineHigh;
    highSrc.loop = true;
    const highGain = ctx.createGain();
    highGain.gain.value = 0.001;
    highSrc.connect(highGain);

    // Turbocharger circuit
    const turboOsc = ctx.createOscillator();
    turboOsc.type = 'sine';
    turboOsc.frequency.value = 2200;
    const turboGain = ctx.createGain();
    turboGain.gain.value = 0;
    turboOsc.connect(turboGain);

    // Transmission whine
    const transOsc = ctx.createOscillator();
    transOsc.type = 'triangle';
    transOsc.frequency.value = 200;
    const transGain = ctx.createGain();
    transGain.gain.value = 0;
    transOsc.connect(transGain);

    // Master voice bus
    const mixGain = ctx.createGain();
    mixGain.gain.value = 1.0;

    idleGain.connect(mixGain);
    midGain.connect(mixGain);
    highGain.connect(mixGain);
    turboGain.connect(mixGain);
    transGain.connect(mixGain);

    // Spatial filter & panner
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 20000;

    const spatialGain = ctx.createGain();
    spatialGain.gain.value = 0.001;

    let panner: PannerNode | StereoPannerNode;
    try {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = 3.5;
      p.maxDistance = 150;
      panner = p;
    } catch {
      panner = ctx.createStereoPanner();
    }

    mixGain.connect(filter).connect(spatialGain).connect(panner).connect(dest);

    idleSrc.start(t0);
    midSrc.start(t0);
    highSrc.start(t0);
    turboOsc.start(t0);
    transOsc.start(t0);

    return {
      idleSrc,
      idleGain,
      midSrc,
      midGain,
      highSrc,
      highGain,
      turboOsc,
      turboGain,
      turboSpool: 0,
      transOsc,
      transGain,
      mixGain,
      filter,
      panner,
      spatialGain,
      lastSeen: this.now,
      lastRpm: e.rpm,
      lastThrottle: e.throttle,
      backfireCooldown: 0,
      creakCooldown: 0,
      smoothedOcc: 0,
    };
  }

  private playOneShotSample(buf: AudioBuffer, dest: AudioNode, vol = 1, rate = 1) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(g).connect(dest);
    src.start();
  }

  private playDelayedSample(buf: AudioBuffer, dest: AudioNode, delaySec: number, vol = 1, rate = 1) {
    const ctx = this.ctx;
    const t = ctx.currentTime + delaySec;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(g).connect(dest);
    src.start(t);
  }

  private destroyEngineVoice(v: ActiveEngineVoice) {
    try {
      v.idleSrc.stop();
      v.midSrc.stop();
      v.highSrc.stop();
      v.turboOsc.stop();
      v.transOsc.stop();
      v.spatialGain.disconnect();
    } catch {
      // Already stopped
    }
  }

  silenceEngines() {
    for (const [, v] of this.voices) {
      this.destroyEngineVoice(v);
    }
    this.voices.clear();
  }
}
