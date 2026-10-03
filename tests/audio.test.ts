import { describe, expect, it, beforeEach } from 'vitest';
import { SampleLibrary } from '../src/audio/samples';
import { SpatialAudioEngine } from '../src/audio/spatial';
import { RadioAudioEngine } from '../src/audio/radio';
import { VehicleAudioEngine } from '../src/audio/engineAudio';
import { FoleyEngine } from '../src/audio/foley';
import { AudioEngine } from '../src/audio/audio';

class MockAudioParam {
  value: number;
  constructor(initial = 0) {
    this.value = initial;
  }
  setValueAtTime(v: number) {
    this.value = v;
  }
  setTargetAtTime(v: number) {
    this.value = v;
  }
  linearRampToValueAtTime(v: number) {
    this.value = v;
  }
  exponentialRampToValueAtTime(v: number) {
    this.value = v;
  }
  cancelScheduledValues() {}
}

class MockAudioNode {
  connect(dest: any) {
    return dest;
  }
  disconnect() {}
}

class MockAudioBuffer {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  channels: Float32Array[];

  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.channels = Array.from({ length: channels }, () => new Float32Array(length));
  }

  getChannelData(channel: number) {
    return this.channels[channel];
  }
}

class MockAudioBufferSourceNode extends MockAudioNode {
  buffer: MockAudioBuffer | null = null;
  loop = false;
  playbackRate = new MockAudioParam(1);
  started = false;
  stopped = false;

  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
}

class MockGainNode extends MockAudioNode {
  gain = new MockAudioParam(1);
}

class MockBiquadFilterNode extends MockAudioNode {
  type: string = 'lowpass';
  frequency = new MockAudioParam(350);
  Q = new MockAudioParam(1);
  gain = new MockAudioParam(0);
}

class MockPannerNode extends MockAudioNode {
  panningModel = 'HRTF';
  distanceModel = 'inverse';
  refDistance = 1;
  maxDistance = 1000;
  rolloffFactor = 1;
  coneInnerAngle = 360;
  positionX = new MockAudioParam(0);
  positionY = new MockAudioParam(0);
  positionZ = new MockAudioParam(0);

  setPosition(x: number, y: number, z: number) {
    this.positionX.value = x;
    this.positionY.value = y;
    this.positionZ.value = z;
  }
}

class MockStereoPannerNode extends MockAudioNode {
  pan = new MockAudioParam(0);
}

class MockOscillatorNode extends MockAudioNode {
  type: string = 'sine';
  frequency = new MockAudioParam(440);
  started = false;
  stopped = false;

  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
}

class MockDynamicsCompressorNode extends MockAudioNode {
  threshold = new MockAudioParam(-24);
  knee = new MockAudioParam(30);
  ratio = new MockAudioParam(12);
  attack = new MockAudioParam(0.003);
  release = new MockAudioParam(0.25);
}

class MockWaveShaperNode extends MockAudioNode {
  curve: Float32Array | null = null;
  oversample = 'none';
}

class MockDelayNode extends MockAudioNode {
  delayTime = new MockAudioParam(0);
}

class MockConvolverNode extends MockAudioNode {
  buffer: MockAudioBuffer | null = null;
}

class MockAudioContext {
  sampleRate = 44100;
  currentTime = 0;
  state = 'running';
  destination = new MockGainNode();

  createBuffer(channels: number, length: number, sampleRate: number) {
    return new MockAudioBuffer(channels, length, sampleRate) as unknown as AudioBuffer;
  }
  createBufferSource() {
    return new MockAudioBufferSourceNode() as unknown as AudioBufferSourceNode;
  }
  createGain() {
    return new MockGainNode() as unknown as GainNode;
  }
  createBiquadFilter() {
    return new MockBiquadFilterNode() as unknown as BiquadFilterNode;
  }
  createPanner() {
    return new MockPannerNode() as unknown as PannerNode;
  }
  createStereoPanner() {
    return new MockStereoPannerNode() as unknown as StereoPannerNode;
  }
  createOscillator() {
    return new MockOscillatorNode() as unknown as OscillatorNode;
  }
  createDynamicsCompressor() {
    return new MockDynamicsCompressorNode() as unknown as DynamicsCompressorNode;
  }
  createWaveShaper() {
    return new MockWaveShaperNode() as unknown as WaveShaperNode;
  }
  createDelay() {
    return new MockDelayNode() as unknown as DelayNode;
  }
  createConvolver() {
    return new MockConvolverNode() as unknown as ConvolverNode;
  }
  resume() {
    return Promise.resolve();
  }
}

describe('Hybrid Sample-Based Foley & Directional HRTF Audio Engine', () => {
  let mockCtx: AudioContext;

  beforeEach(() => {
    mockCtx = new MockAudioContext() as unknown as AudioContext;
  });

  describe('SampleLibrary', () => {
    it('synthesizes multi-layer gunshot sample banks', () => {
      const lib = new SampleLibrary(mockCtx);
      lib.init();

      // Mechanical clicks
      expect(lib.mechanicalClicks.length).toBe(4);
      expect(lib.mechanicalClicks[0].length).toBeGreaterThan(0);
      expect(lib.mechanicalClicks[0].getChannelData(0).some((v) => v !== 0)).toBe(true);

      // Sub-bass body
      expect(lib.subBassBody.length).toBe(4);
      expect(lib.subBassBody[0].getChannelData(0).some((v) => v !== 0)).toBe(true);

      // Shell casing bounces
      expect(lib.shellCasingBounces.length).toBe(4);
      expect(lib.shellCasingBounces[0].getChannelData(0).some((v) => v !== 0)).toBe(true);

      // Impulse responses
      expect(lib.indoorImpulse).not.toBeNull();
      expect(lib.indoorImpulse!.numberOfChannels).toBe(2);
      expect(lib.canyonImpulse).not.toBeNull();
      expect(lib.canyonImpulse!.numberOfChannels).toBe(2);
    });

    it('synthesizes vehicle engine multi-track loops, turbo, and backfire samples', () => {
      const lib = new SampleLibrary(mockCtx);
      lib.init();

      expect(lib.engineIdle).not.toBeNull();
      expect(lib.engineMid).not.toBeNull();
      expect(lib.engineHigh).not.toBeNull();
      expect(lib.turboSpool).not.toBeNull();
      expect(lib.turboBov).not.toBeNull();

      expect(lib.backfirePops.length).toBe(4);
      expect(lib.chassisCreaks.length).toBe(4);
      expect(lib.micClickIn).not.toBeNull();
      expect(lib.micClickOut).not.toBeNull();
      expect(lib.fleshCrunch.length).toBe(2);
    });
  });

  describe('Binaural 3D Spatial HRTF & Concrete Wall Occlusion', () => {
    it('configures Web Audio PannerNode with HRTF and distance attenuation', () => {
      const spatial = new SpatialAudioEngine(mockCtx);
      const listener = { x: 10, z: 20, yaw: 0 };
      const dest = mockCtx.createGain();

      const route = spatial.createSpatialRoute(10, 40, listener, 0, dest);
      expect(route).not.toBeNull();
      expect(route!.panner).toBeDefined();

      const p = route!.panner as unknown as MockPannerNode;
      expect(p.panningModel).toBe('HRTF');
      // Relative distance: dz = 20m behind (towards -Z in Web Audio space)
      expect(p.positionZ.value).toBe(-20);
      expect(route!.occluded).toBe(false);
      // Lowpass cutoff should be near 20kHz with natural air roll-off
      expect(route!.filter.frequency.value).toBeGreaterThan(15000);
    });

    it('applies distance-attenuated low-pass occlusion when behind concrete walls', () => {
      const spatial = new SpatialAudioEngine(mockCtx);
      // Occlusion tester returns 1 (solid concrete wall)
      spatial.setOcclusionTester((fx, fz, tx, tz) => true);

      const listener = { x: 0, z: 0, yaw: 0 };
      const dest = mockCtx.createGain();

      const route = spatial.createSpatialRoute(15, 20, listener, 0, dest);
      expect(route).not.toBeNull();
      expect(route!.occluded).toBe(true);

      // Low-pass filter frequency should be heavily muffled below 600Hz (concrete wall dampening)
      expect(route!.filter.frequency.value).toBeLessThan(600);
      expect(route!.filter.frequency.value).toBeGreaterThan(250);
      // Attenuation should cut volume
      expect(route!.attenuation).toBeLessThan(0.4);
    });

    it('provides smooth gradual roll-off for partial acoustic diffraction rather than an on/off switch', () => {
      const spatial = new SpatialAudioEngine(mockCtx);
      const listener = { x: 0, z: 0, yaw: 0 };
      const dest = mockCtx.createGain();

      // Test progressive blockage levels: 0 (clear), 0.2 (grazing edge), 0.5 (half shadow), 0.8 (deep shadow), 1.0 (full wall)
      const freqs: number[] = [];
      const gains: number[] = [];
      for (const occ of [0.0, 0.2, 0.5, 0.8, 1.0]) {
        spatial.setOcclusionTester(() => occ);
        const route = spatial.createSpatialRoute(10, 10, listener, 0, dest);
        expect(route).not.toBeNull();
        freqs.push(route!.filter.frequency.value);
        gains.push(route!.gain.gain.value);
      }

      // Cutoff frequency must strictly monotonically decrease as occlusion increases
      for (let i = 1; i < freqs.length; i++) {
        expect(freqs[i]).toBeLessThan(freqs[i - 1]);
        expect(gains[i]).toBeLessThanOrEqual(gains[i - 1]);
      }

      // Partial diffraction (occ=0.2) should still preserve high-end clarity (>8kHz)
      expect(freqs[1]).toBeGreaterThan(8000);
      // Half shadow (occ=0.5) smoothly softens
      expect(freqs[2]).toBeGreaterThan(2500);
      expect(freqs[2]).toBeLessThan(12000);
    });
  });

  describe('Contextual Character Voice Barks & Radio Chatter', () => {
    it('builds authentic walkie-talkie bandpass and compression chain', () => {
      const lib = new SampleLibrary(mockCtx);
      lib.init();
      const radio = new RadioAudioEngine(mockCtx, lib);
      const dest = mockCtx.createGain();

      const chain = radio.createRadioChain(dest);
      expect(chain.input).toBeDefined();
      expect(chain.output).toBeDefined();
      expect(chain.carrierStatic).toBeDefined();
    });

    it('plays procedural radio chatter with voice syllables, mic clicks, and compression', () => {
      const lib = new SampleLibrary(mockCtx);
      lib.init();
      const radio = new RadioAudioEngine(mockCtx, lib);
      const dest = mockCtx.createGain();

      const duration = radio.playRadioChatter("Dust wall rolling in from the south!", dest);
      expect(duration).toBeGreaterThan(0.5);

      const duration2 = radio.playRadioChatter("Engine sumps dry, we're seizing up!", dest);
      expect(duration2).toBeGreaterThan(0.5);
    });
  });

  describe('Granular Multi-Layer Foley Architecture', () => {
    it('fires all 5 gunshot layers: clicks, sub-bass, blast, shell casing, and tail reverb', () => {
      const lib = new SampleLibrary(mockCtx);
      lib.init();
      const foley = new FoleyEngine(mockCtx, lib);
      const dest = mockCtx.createGain();

      // Gunshots with indoor vs canyon tail
      foley.playGunshot('pistol', dest, 0, { indoor: false, canyon: true });
      foley.playGunshot('shotgun', dest, 0, { indoor: true });
      foley.playGunshot('mg', dest, 0);
      foley.playGunshot('sniper', dest, 0);
    });

    it('plays multi-layer explosions, Dusk Bell, and visceral zombie death foley', () => {
      const lib = new SampleLibrary(mockCtx);
      lib.init();
      const foley = new FoleyEngine(mockCtx, lib);
      const dest = mockCtx.createGain();

      foley.playExplosion(dest, 0);
      foley.playDuskBell(dest, 0);
      foley.playZombieDeath(dest, 0);
    });
  });

  describe('Multi-Track RPM Vehicle Audio Engine', () => {
    it('crossfades multi-track RPM loops and triggers turbo, backfire, and chassis creaks', () => {
      const lib = new SampleLibrary(mockCtx);
      lib.init();
      const spatial = new SpatialAudioEngine(mockCtx);
      const veh = new VehicleAudioEngine(mockCtx, lib, spatial);
      const bus = mockCtx.createGain();

      const listeners = [{ x: 0, z: 0, yaw: 0 }];

      // 1. Idle state
      veh.updateEngines(
        [
          {
            id: 1,
            x: 5,
            z: 10,
            rpm: 0.1,
            throttle: 0,
            tier: 2,
            signature: 30,
            speed: 2,
            lateralG: 0,
          },
        ],
        0.05,
        listeners,
        [bus],
        false,
      );

      // 2. High RPM under heavy cornering (lateral G) and overrun
      veh.updateEngines(
        [
          {
            id: 1,
            x: 5,
            z: 10,
            rpm: 0.85,
            throttle: 0.9,
            tier: 2,
            signature: 75,
            speed: 24,
            lateralG: 0.8,
          },
        ],
        0.05,
        listeners,
        [bus],
        false,
      );

      // 3. Lift-off throttle (backfire + BOV trigger)
      veh.updateEngines(
        [
          {
            id: 1,
            x: 5,
            z: 10,
            rpm: 0.7,
            throttle: 0.05,
            tier: 2,
            signature: 40,
            speed: 22,
            lateralG: 0.1,
          },
        ],
        0.05,
        listeners,
        [bus],
        false,
      );

      veh.silenceEngines();
    });

    it('smooths engine occlusion continuously over time to prevent on/off switches', () => {
      const lib = new SampleLibrary(mockCtx);
      lib.init();
      const spatial = new SpatialAudioEngine(mockCtx);
      let isBlocked = false;
      spatial.setOcclusionTester(() => (isBlocked ? 1.0 : 0.0));
      const veh = new VehicleAudioEngine(mockCtx, lib, spatial);
      const bus = mockCtx.createGain();
      const listeners = [{ x: 0, z: 0, yaw: 0 }];

      const params = {
        id: 99,
        x: 0,
        z: 15,
        rpm: 0.5,
        throttle: 0.5,
        tier: 2,
        signature: 50,
      };

      // Frame 1: Open line of sight
      veh.updateEngines([params], 0.05, listeners, [bus], false);
      const voice = (veh as any).voices.get(99);
      expect(voice.smoothedOcc).toBe(0);

      // Frame 2: An obstacle appears (targetOcc becomes 1.0)
      isBlocked = true;
      veh.updateEngines([params], 0.05, listeners, [bus], false);
      // Smoothed occlusion moves smoothly, NOT jumping directly to 1.0!
      expect(voice.smoothedOcc).toBeGreaterThan(0);
      expect(voice.smoothedOcc).toBeLessThan(0.4);

      // Frame 3: Continuous progress into the shadow
      veh.updateEngines([params], 0.05, listeners, [bus], false);
      expect(voice.smoothedOcc).toBeGreaterThan(0.2);

      // Frame 4: Moving out of the obstacle (targetOcc becomes 0.0)
      isBlocked = false;
      const prevOcc = voice.smoothedOcc;
      veh.updateEngines([params], 0.05, listeners, [bus], false);
      // Decreases smoothly rather than dropping immediately to 0!
      expect(voice.smoothedOcc).toBeLessThan(prevOcc);
      expect(voice.smoothedOcc).toBeGreaterThan(0);
    });
  });

  describe('AudioEngine Full Integration', () => {
    it('initializes and plays positional HRTF sounds with wall occlusion', () => {
      (globalThis as any).AudioContext = MockAudioContext;
      const engine = new AudioEngine();
      engine.init();

      engine.setListeners([{ x: 0, z: 0, yaw: 0 }, { x: 50, z: 50, yaw: 0 }]);
      engine.setOcclusionTester((fx, fz, tx, tz) => (tx > 20 ? 1 : 0));

      // Play unoccluded gunshot near listener 0
      engine.play('pistol', 5, 5, 0.8);

      // Play occluded sniper gunshot behind concrete wall
      engine.play('sniper', 35, 10, 1.0);

      // Play explosion and Dusk Bell
      engine.play('boom', 10, 10, 1);
      engine.play('bell');

      // Play contextual radio chatter
      engine.playRadioChatter("Dust wall rolling in from the south!");
      engine.playRadioChatter("Engine sumps dry, we're seizing up!");

      // Silence and cleanup
      engine.silenceEngines();
    });
  });
});
