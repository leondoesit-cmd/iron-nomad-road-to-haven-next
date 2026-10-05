import { clamp, lerp } from '../core/math';

export interface SpatialListener {
  x: number;
  z: number;
  yaw?: number;
}

export type OcclusionTester = (fromX: number, fromZ: number, toX: number, toZ: number) => number | boolean;

export interface SpatialRoute {
  panner: PannerNode | StereoPannerNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  attenuation: number;
  occluded: boolean;
  busIndex: number;
}

/**
 * Binaural 3D Spatial HRTF Audio Engine.
 * Implements Web Audio PannerNode with 'HRTF' panning model, listener orientation transforms,
 * distance attenuation, and distance-attenuated low-pass wall occlusion when infected,
 * raiders, or gunshots are behind concrete walls.
 */
export class SpatialAudioEngine {
  ctx: AudioContext;
  occlusionTester: OcclusionTester | null = null;
  solo = false;
  indoor = false;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  setOcclusionTester(tester: OcclusionTester | null) {
    this.occlusionTester = tester;
  }

  setSolo(s: boolean) {
    this.solo = s;
  }

  setIndoor(indoor: boolean) {
    this.indoor = indoor;
  }

  /**
   * Evaluates the spatial route from a world source (x, z) to a listener.
   * Returns a configured Web Audio chain:
   * Source -> Occlusion Low-Pass Filter -> HRTF PannerNode -> Output Gain
   */
  createSpatialRoute(
    x: number,
    z: number,
    listener: SpatialListener,
    busIndex: number,
    dest: AudioNode,
    forcedOcclusion?: boolean | number,
  ): SpatialRoute | null {
    const ctx = this.ctx;
    const dx = x - listener.x;
    const dz = z - listener.z;
    const dist = Math.hypot(dx, dz);

    if (dist > 180) return null; // Outside audible perimeter

    // 1. Concrete wall occlusion test
    let occ = 0;
    if (forcedOcclusion !== undefined) {
      occ = typeof forcedOcclusion === 'boolean' ? (forcedOcclusion ? 1 : 0) : clamp(forcedOcclusion, 0, 1);
    } else if (this.occlusionTester) {
      const res = this.occlusionTester(listener.x, listener.z, x, z);
      occ = typeof res === 'boolean' ? (res ? 1 : 0) : clamp(res, 0, 1);
    }

    // 2. Distance-attenuated low-pass filter calculation:
    // Natural air absorption: higher frequencies roll off with distance.
    const airCutoff = 22000 / (1 + dist / 60);
    // Concrete wall occlusion: steep lowpass down to 350-550 Hz for bunker walls,
    // and gentle acoustic diffraction softening (2400Hz) for outdoor barriers.
    // Bunker-ness is a property of the environment, never of how blocked the ray is: deriving it from `occ`
    // created a hard step (gain x0.7 -> x0.37, floor 520 -> 420 Hz) at a threshold.
    const isBunker = this.indoor || forcedOcclusion === true || (typeof forcedOcclusion === 'number' && forcedOcclusion >= 1.0);
    const targetFloor = isBunker ? 420 : lerp(2400, 520, occ);
    const occludedCutoff = clamp(lerp(airCutoff, targetFloor, occ), targetFloor, 22000);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(occludedCutoff, ctx.currentTime);
    filter.Q.value = lerp(0.7, 1.2, occ);

    // 3. Occlusion volume attenuation: subtle -3dB outdoors, -6dB in sealed bunker
    const occGainMult = 1 / (1 + occ * (isBunker ? 1.8 : 0.45));
    // Inverse distance attenuation curve
    const refDist = 3.5;
    const distAtt = 1 / (1 + Math.pow(Math.max(0, dist - refDist) / 24, 1.4));
    const totalAtt = distAtt * occGainMult;

    const gain = ctx.createGain();
    gain.gain.value = totalAtt;

    // 4. Transform world delta into listener's local head coordinate frame
    const yaw = listener.yaw ?? 0;
    // Game heading convention: yaw 0 faces +Z, positive turns toward +X
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const localX = dx * cosY - dz * sinY;
    const localZ = -(dx * sinY + dz * cosY); // Web Audio: listener looks towards -Z

    // 5. Binaural HRTF PannerNode
    let panner: PannerNode | StereoPannerNode;
    try {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = refDist;
      p.maxDistance = 180;
      // Distance falloff is already applied by the gain node above; a second inverse-distance curve in the panner
      // made everything past a few metres vanish, so the panner only supplies direction.
      p.rolloffFactor = 0;
      p.coneInnerAngle = 360;

      const t0 = ctx.currentTime;
      if (p.positionX) {
        p.positionX.setValueAtTime(localX, t0);
        p.positionY.setValueAtTime(0, t0);
        p.positionZ.setValueAtTime(localZ, t0);
      } else {
        (p as unknown as { setPosition: (x: number, y: number, z: number) => void }).setPosition(localX, 0, localZ);
      }
      panner = p;
    } catch {
      // Fallback for environments lacking full HRTF Panner support
      const sp = ctx.createStereoPanner();
      const panVal = clamp(localX / Math.max(1, dist), -1, 1);
      sp.pan.setValueAtTime(this.solo ? panVal : (busIndex === 0 ? -0.35 : 0.35), ctx.currentTime);
      panner = sp;
    }

    // Connect: filter -> gain -> panner -> dest
    filter.connect(gain).connect(panner).connect(dest);

    return {
      panner,
      filter,
      gain,
      attenuation: totalAtt,
      occluded: occ > 0.2,
      busIndex,
    };
  }
}
