import { clamp } from '../core/math';

/**
 * Hybrid Sample Bank for the AAA Foley and Vehicle Audio Engine.
 * Generates high-fidelity PCM AudioBuffers physically modeled for:
 * - Gunshot mechanical transients (striker, bolt slap, slide click)
 * - Explosive sub-bass punch (35-65Hz saturated body)
 * - Dynamic brass shell casing bounces (resonant cylinder rings)
 * - Indoor room & canyon tail impulse responses
 * - Multi-track RPM engine loops (idle, mid, high)
 * - Turbocharger compressor spool and blow-off valve (BOV) hiss
 * - Exhaust backfire detonation pops
 * - Chassis frame creaks and suspension groans under G-force
 * - Tactical walkie-talkie PTT mic clicks and squelch tails
 */
export class SampleLibrary {
  ctx: AudioContext;

  mechanicalClicks: AudioBuffer[] = [];
  subBassBody: AudioBuffer[] = [];
  shellCasingBounces: AudioBuffer[] = [];
  indoorImpulse: AudioBuffer | null = null;
  canyonImpulse: AudioBuffer | null = null;

  engineIdle: AudioBuffer | null = null;
  engineMid: AudioBuffer | null = null;
  engineHigh: AudioBuffer | null = null;
  turboSpool: AudioBuffer | null = null;
  turboBov: AudioBuffer | null = null;

  backfirePops: AudioBuffer[] = [];
  chassisCreaks: AudioBuffer[] = [];
  micClickIn: AudioBuffer | null = null;
  micClickOut: AudioBuffer | null = null;
  fleshCrunch: AudioBuffer[] = [];

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  init() {
    const ctx = this.ctx;
    const rate = ctx.sampleRate || 44100;

    this.mechanicalClicks = [
      this.generateMechanicalClick(rate, 4800, 0.05, 0.8),
      this.generateMechanicalClick(rate, 5400, 0.06, 0.9),
      this.generateMechanicalClick(rate, 3900, 0.07, 1.0),
      this.generateMechanicalClick(rate, 6200, 0.05, 0.85),
    ];

    this.subBassBody = [
      this.generateSubBassPunch(rate, 42, 0.22, 1.2),
      this.generateSubBassPunch(rate, 50, 0.18, 1.0),
      this.generateSubBassPunch(rate, 36, 0.26, 1.3),
      this.generateSubBassPunch(rate, 58, 0.15, 0.9),
    ];

    this.shellCasingBounces = [
      this.generateShellBounce(rate, 3850, 4920, 0.14),
      this.generateShellBounce(rate, 4200, 5300, 0.12),
      this.generateShellBounce(rate, 3600, 4650, 0.15),
      this.generateShellBounce(rate, 4500, 5800, 0.11),
    ];

    this.indoorImpulse = this.generateIndoorImpulse(rate);
    this.canyonImpulse = this.generateCanyonImpulse(rate);

    this.engineIdle = this.generateEngineIdleLoop(rate);
    this.engineMid = this.generateEngineMidLoop(rate);
    this.engineHigh = this.generateEngineHighLoop(rate);
    this.turboSpool = this.generateTurboSpoolLoop(rate);
    this.turboBov = this.generateTurboBov(rate);

    this.backfirePops = [
      this.generateBackfire(rate, 180, 0.14),
      this.generateBackfire(rate, 140, 0.16),
      this.generateBackfire(rate, 220, 0.12),
      this.generateBackfire(rate, 160, 0.15),
    ];

    this.chassisCreaks = [
      this.generateChassisCreak(rate, 750, 0.35),
      this.generateChassisCreak(rate, 920, 0.28),
      this.generateChassisCreak(rate, 640, 0.42),
      this.generateChassisCreak(rate, 1100, 0.3),
    ];

    this.micClickIn = this.generateMicClickIn(rate);
    this.micClickOut = this.generateMicClickOut(rate);

    this.fleshCrunch = [
      this.generateFleshCrunch(rate, 0.18),
      this.generateFleshCrunch(rate, 0.24),
    ];
  }

  // ---------------------------------------------------------------- Gunshot Mechanical
  private generateMechanicalClick(rate: number, resFreq: number, dur: number, intensity: number): AudioBuffer {
    const len = Math.floor(rate * dur);
    const buf = this.ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);

    for (let i = 0; i < len; i++) {
      const t = i / rate;
      // High-speed striker impulse (0-2ms)
      const impulse = t < 0.002 ? (Math.random() * 2 - 1) * Math.exp(-t * 2000) * 1.5 : 0;
      // Resonant metallic ring of receiver / bolt carrier
      const ring1 = Math.sin(2 * Math.PI * resFreq * t) * Math.exp(-t * 320);
      const ring2 = Math.sin(2 * Math.PI * (resFreq * 1.48) * t) * Math.exp(-t * 450) * 0.5;
      // Slide rattle micro-transient at 6ms
      const slide = t > 0.005 && t < 0.02 ? (Math.random() * 2 - 1) * Math.exp(-(t - 0.005) * 400) * 0.4 : 0;

      d[i] = clamp((impulse + (ring1 + ring2) * 0.7 + slide) * intensity, -1, 1);
    }
    return buf;
  }

  // ---------------------------------------------------------------- Sub-Bass Body
  private generateSubBassPunch(rate: number, f0: number, dur: number, gain: number): AudioBuffer {
    const len = Math.floor(rate * dur);
    const buf = this.ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);

    let phase = 0;
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      // Fast downward pitch sweep simulating high-pressure gas expansion
      const freq = f0 * (1 + 2.5 * Math.exp(-t * 60));
      phase += 2 * Math.PI * (freq / rate);

      // Saturated sine with 2nd and 3rd harmonics for punchy chest feel
      const raw = Math.sin(phase) + 0.35 * Math.sin(phase * 2) + 0.15 * Math.sin(phase * 3);
      const saturated = Math.tanh(raw * 2.2);

      // Punch envelope: 4ms rise, deep exponential decay
      const attack = t < 0.004 ? t / 0.004 : 1;
      const decay = Math.exp(-t * 18);

      d[i] = clamp(saturated * attack * decay * gain, -1, 1);
    }
    return buf;
  }

  // ---------------------------------------------------------------- Shell Casing Bounce
  private generateShellBounce(rate: number, f1: number, f2: number, dur: number): AudioBuffer {
    const len = Math.floor(rate * dur);
    const buf = this.ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);

    const secondaryDelay = 0.055 + Math.random() * 0.02;
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      // Initial impact click
      const imp1 = t < 0.002 ? (Math.random() * 2 - 1) * Math.exp(-t * 1500) : 0;
      // Brass cylinder resonant ringing
      const ring1 = (Math.sin(2 * Math.PI * f1 * t) + 0.6 * Math.sin(2 * Math.PI * f2 * t)) * Math.exp(-t * 90);

      // Second bounce click & ringing
      let imp2 = 0;
      let ring2 = 0;
      if (t > secondaryDelay) {
        const t2 = t - secondaryDelay;
        imp2 = t2 < 0.002 ? (Math.random() * 2 - 1) * Math.exp(-t2 * 1800) * 0.45 : 0;
        ring2 = (Math.sin(2 * Math.PI * (f1 * 1.05) * t2) + 0.5 * Math.sin(2 * Math.PI * (f2 * 1.03) * t2)) * Math.exp(-t2 * 110) * 0.4;
      }

      d[i] = clamp((imp1 * 0.6 + ring1 * 0.7 + imp2 * 0.4 + ring2 * 0.5), -1, 1);
    }
    return buf;
  }

  // ---------------------------------------------------------------- Tail Reverberation Impulses
  private generateIndoorImpulse(rate: number): AudioBuffer {
    const dur = 0.45;
    const len = Math.floor(rate * dur);
    const buf = this.ctx.createBuffer(2, len, rate);
    const left = buf.getChannelData(0);
    const right = buf.getChannelData(1);

    // Discrete early reflections (drywall / concrete / metal fixtures)
    const early = [
      { t: 0.006, gL: 0.7, gR: 0.4 },
      { t: 0.014, gL: 0.5, gR: 0.65 },
      { t: 0.023, gL: 0.45, gR: 0.35 },
      { t: 0.038, gL: 0.3, gR: 0.4 },
      { t: 0.052, gL: 0.25, gR: 0.22 },
    ];

    let lState = 0;
    let rState = 0;
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      let sL = (Math.random() * 2 - 1) * Math.exp(-t * 12);
      let sR = (Math.random() * 2 - 1) * Math.exp(-t * 12);

      // Lowpass filter diffuse tail (~2600Hz) to simulate indoor wall absorption
      lState += (sL - lState) * 0.32;
      rState += (sR - rState) * 0.32;

      for (const e of early) {
        const idx = Math.floor(e.t * rate);
        if (i === idx) {
          lState += e.gL;
          rState += e.gR;
        }
      }

      left[i] = clamp(lState * 0.7, -1, 1);
      right[i] = clamp(rState * 0.7, -1, 1);
    }
    return buf;
  }

  private generateCanyonImpulse(rate: number): AudioBuffer {
    const dur = 1.3;
    const len = Math.floor(rate * dur);
    const buf = this.ctx.createBuffer(2, len, rate);
    const left = buf.getChannelData(0);
    const right = buf.getChannelData(1);

    // Canyon slapback echoes (sound bouncing across valley canyon walls)
    const slaps = [
      { t: 0.075, gL: 0.65, gR: 0.2 },
      { t: 0.165, gL: 0.25, gR: 0.55 },
      { t: 0.29, gL: 0.4, gR: 0.25 },
      { t: 0.48, gL: 0.2, gR: 0.3 },
      { t: 0.72, gL: 0.12, gR: 0.15 },
    ];

    let lState = 0;
    let rState = 0;
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      // Long diffuse desert wind flutter decay
      const diffuseEnv = Math.exp(-t * 3.8);
      let sL = (Math.random() * 2 - 1) * diffuseEnv * 0.3;
      let sR = (Math.random() * 2 - 1) * diffuseEnv * 0.3;

      // Distance air damping (highs roll off progressively as t increases)
      const filterCoef = Math.max(0.04, 0.25 * Math.exp(-t * 1.5));
      lState += (sL - lState) * filterCoef;
      rState += (sR - rState) * filterCoef;

      for (const s of slaps) {
        const idx = Math.floor(s.t * rate);
        if (i >= idx && i < idx + 4) {
          lState += s.gL * (1 - (i - idx) / 4);
          rState += s.gR * (1 - (i - idx) / 4);
        }
      }

      left[i] = clamp(lState * 0.8, -1, 1);
      right[i] = clamp(rState * 0.8, -1, 1);
    }
    return buf;
  }

  // ---------------------------------------------------------------- Engine Loops
  private makeLoopSeamless(d: Float32Array, crossfadeSamples: number) {
    const len = d.length;
    for (let i = 0; i < crossfadeSamples; i++) {
      const t = i / crossfadeSamples;
      const head = d[i];
      const tail = d[len - crossfadeSamples + i];
      d[i] = head * t + tail * (1 - t);
      d[len - crossfadeSamples + i] = d[i];
    }
  }

  private generateEngineIdleLoop(rate: number): AudioBuffer {
    const dur = 1.0;
    const len = Math.floor(rate * dur);
    const buf = this.ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);

    const firingFreq = 28.5; // ~850 RPM uneven firing
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      // Cylinder firing stroke pulses with subtle organic jitter
      const jitter = Math.sin(t * 12) * 0.05;
      const phase = (t * (firingFreq + jitter)) % 1;
      const cylinderPulse = Math.exp(-phase * 12) * Math.sin(phase * Math.PI * 4);

      // Valve train mechanical ticking
      const valvePhase = (t * firingFreq * 2) % 1;
      const valveTick = valvePhase < 0.08 ? (Math.random() * 2 - 1) * Math.exp(-valvePhase * 80) * 0.25 : 0;

      // Low exhaust pipe drone
      const drone = Math.sin(2 * Math.PI * firingFreq * t) * 0.4 + Math.sin(4 * Math.PI * firingFreq * t) * 0.25;

      d[i] = clamp(cylinderPulse * 0.5 + drone * 0.35 + valveTick, -1, 1);
    }

    this.makeLoopSeamless(d, Math.floor(rate * 0.06));
    return buf;
  }

  private generateEngineMidLoop(rate: number): AudioBuffer {
    const dur = 0.75;
    const len = Math.floor(rate * dur);
    const buf = this.ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);

    const firingFreq = 84; // ~2500 RPM
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      const phase = (t * firingFreq) % 1;
      const combustion = Math.exp(-phase * 8) * Math.sin(phase * Math.PI * 3.5);

      // Intake runner raspy growl
      const intake = (Math.random() * 2 - 1) * 0.15 * Math.sin(2 * Math.PI * firingFreq * 2 * t);
      // Manifold resonance
      const resonance = Math.sin(2 * Math.PI * 220 * t) * 0.22 + Math.sin(2 * Math.PI * 440 * t) * 0.14;

      d[i] = clamp(combustion * 0.55 + resonance * 0.35 + intake, -1, 1);
    }

    this.makeLoopSeamless(d, Math.floor(rate * 0.05));
    return buf;
  }

  private generateEngineHighLoop(rate: number): AudioBuffer {
    const dur = 0.55;
    const len = Math.floor(rate * dur);
    const buf = this.ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);

    const firingFreq = 175; // ~5200 RPM
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      const phase = (t * firingFreq) % 1;
      const combustion = Math.exp(-phase * 6) * Math.sin(phase * Math.PI * 2.8);

      // Header screeching harmonics
      const header = Math.sin(2 * Math.PI * firingFreq * 2 * t) * 0.3 + Math.sin(2 * Math.PI * firingFreq * 4 * t) * 0.2;
      // High-flow air suction rush
      const suction = (Math.random() * 2 - 1) * 0.18;

      d[i] = clamp(combustion * 0.5 + header * 0.4 + suction, -1, 1);
    }

    this.makeLoopSeamless(d, Math.floor(rate * 0.04));
    return buf;
  }

  private generateTurboSpoolLoop(rate: number): AudioBuffer {
    const dur = 0.8;
    const len = Math.floor(rate * dur);
    const buf = this.ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);

    for (let i = 0; i < len; i++) {
      const t = i / rate;
      // Ceramic turbine whistle: dual sine carrier with flutter
      const flutter = 1 + 0.04 * Math.sin(2 * Math.PI * 18 * t);
      const whistle1 = Math.sin(2 * Math.PI * 3400 * flutter * t);
      const whistle2 = Math.sin(2 * Math.PI * 6800 * flutter * t) * 0.35;
      // Compressor wheel air turbulence
      const airRush = (Math.random() * 2 - 1) * 0.12;

      d[i] = clamp((whistle1 * 0.6 + whistle2 + airRush) * 0.6, -1, 1);
    }

    this.makeLoopSeamless(d, Math.floor(rate * 0.05));
    return buf;
  }

  private generateTurboBov(rate: number): AudioBuffer {
    const dur = 0.32;
    const len = Math.floor(rate * dur);
    const buf = this.ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);

    let state = 0;
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      // Sudden pneumatic pressure blow-off with flutter chirp ("pssh-t-t-t")
      const env = Math.exp(-t * 14) * (1 + 0.35 * Math.sin(2 * Math.PI * 28 * t));
      const white = Math.random() * 2 - 1;
      // Bandpass around 2800Hz
      state += (white - state) * 0.28;

      d[i] = clamp(state * env * 1.4, -1, 1);
    }
    return buf;
  }

  // ---------------------------------------------------------------- Backfire Detonation
  private generateBackfire(rate: number, toneFreq: number, dur: number): AudioBuffer {
    const len = Math.floor(rate * dur);
    const buf = this.ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);

    for (let i = 0; i < len; i++) {
      const t = i / rate;
      // Explosive initial pressure spike (0.5ms)
      const snap = t < 0.001 ? (Math.random() * 2 - 1) * 1.5 : 0;
      // Exhaust pipe resonance
      const pipe = Math.sin(2 * Math.PI * toneFreq * t) * Math.exp(-t * 26) * 0.8;
      const crackle = (Math.random() * 2 - 1) * Math.exp(-t * 40) * 0.5;

      d[i] = clamp(Math.tanh((snap + pipe + crackle) * 1.8), -1, 1);
    }
    return buf;
  }

  // ---------------------------------------------------------------- Chassis Creaks
  private generateChassisCreak(rate: number, baseFreq: number, dur: number): AudioBuffer {
    const len = Math.floor(rate * dur);
    const buf = this.ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);

    let stickSlip = 0;
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      // Stick-slip friction events (suspension leaf springs / chassis frame torsional stress)
      if (Math.random() < 0.06) stickSlip += (Math.random() * 2 - 1) * 0.6;
      stickSlip *= 0.88;

      // Resonant frame groan
      const groan = Math.sin(2 * Math.PI * (baseFreq + 120 * Math.sin(t * 30)) * t) * Math.exp(-t * 6);
      const env = Math.sin((t / dur) * Math.PI); // Arc envelope

      d[i] = clamp((groan * 0.5 + stickSlip) * env * 0.7, -1, 1);
    }
    return buf;
  }

  // ---------------------------------------------------------------- Radio PTT SFX
  private generateMicClickIn(rate: number): AudioBuffer {
    const dur = 0.055;
    const len = Math.floor(rate * dur);
    const buf = this.ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);

    for (let i = 0; i < len; i++) {
      const t = i / rate;
      // Mechanical tactile micro-switch click
      const click = t < 0.003 ? (Math.random() * 2 - 1) * Math.exp(-t * 2200) * 1.2 : 0;
      // Squelch gate opening hiss burst (2.4kHz bandpassed noise)
      const squelch = t > 0.004 && t < 0.035 ? (Math.random() * 2 - 1) * 0.45 : 0;
      // CTCSS pilot sub-tone chirp
      const tone = t > 0.015 && t < 0.045 ? Math.sin(2 * Math.PI * 1200 * t) * 0.25 : 0;

      d[i] = clamp(click + squelch + tone, -1, 1);
    }
    return buf;
  }

  private generateMicClickOut(rate: number): AudioBuffer {
    const dur = 0.085;
    const len = Math.floor(rate * dur);
    const buf = this.ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);

    for (let i = 0; i < len; i++) {
      const t = i / rate;
      // Roger beep tone
      const roger = t < 0.045 ? Math.sin(2 * Math.PI * 1050 * t) * 0.35 : 0;
      // Squelch tail burst
      const squelch = t > 0.04 && t < 0.075 ? (Math.random() * 2 - 1) * Math.exp(-(t - 0.04) * 80) * 0.6 : 0;
      // Switch release mechanical snap
      const release = t > 0.075 && t < 0.08 ? (Math.random() * 2 - 1) * 0.7 : 0;

      d[i] = clamp(roger + squelch + release, -1, 1);
    }
    return buf;
  }

  // ---------------------------------------------------------------- Flesh & Bone
  private generateFleshCrunch(rate: number, dur: number): AudioBuffer {
    const len = Math.floor(rate * dur);
    const buf = this.ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);

    let lowp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      const boneCrack = t < 0.01 ? (Math.random() * 2 - 1) * Math.exp(-t * 500) * 1.2 : 0;
      const wetNoise = (Math.random() * 2 - 1) * Math.exp(-t * 22) * 0.6;
      lowp += (wetNoise - lowp) * 0.15; // Muffled gore squelch

      d[i] = clamp(boneCrack + lowp, -1, 1);
    }
    return buf;
  }
}
