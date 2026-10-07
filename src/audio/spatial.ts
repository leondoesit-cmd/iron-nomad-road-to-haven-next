import { clamp, lerp } from '../core/math';

export interface SpatialListener {
  x: number;
  z: number;
  yaw?: number;
  /** Listener-specific room state; split-screen players can occupy different spaces. */
  indoor?: boolean;
  enclosure?: number;
  /** 0 to 1: sitting in a running vehicle, whose own noise then drowns everything but gunfire and blasts. */
  cabin?: number;
}
export type OcclusionTester = (fromX: number, fromZ: number, toX: number, toZ: number) => number | boolean;
export interface SpatialShape { range?: number; reference?: number }
export interface SpatialRoute {
  panner: PannerNode | StereoPannerNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  attenuation: number;
  occluded: boolean;
  busIndex: number;
}

/** Recorded sources pass through continuous air absorption, obstacle filtering and listener-relative HRTF. */
export class SpatialAudioEngine {
  occlusionTester: OcclusionTester | null = null;
  solo = false;
  indoor = false;
  constructor(public ctx: AudioContext) {}
  setOcclusionTester(tester: OcclusionTester | null) { this.occlusionTester = tester; }
  setSolo(s: boolean) { this.solo = s; }
  setIndoor(indoor: boolean) { this.indoor = indoor; }

  createSpatialRoute(x: number, z: number, listener: SpatialListener, busIndex: number, dest: AudioNode,
    forcedOcclusion?: boolean | number, shape: SpatialShape = {}): SpatialRoute | null {
    if (Math.hypot(x - listener.x, z - listener.z) > (shape.range ?? 180)) return null;
    const filter = this.ctx.createBiquadFilter(); filter.type = 'lowpass';
    const gain = this.ctx.createGain();
    let panner: PannerNode | StereoPannerNode;
    try {
      const p = this.ctx.createPanner();
      p.panningModel = 'HRTF'; p.distanceModel = 'inverse';
      p.refDistance = shape.reference ?? 3.5; p.maxDistance = shape.range ?? 180;
      p.rolloffFactor = 0; p.coneInnerAngle = 360;
      panner = p;
    } catch { panner = this.ctx.createStereoPanner(); }
    filter.connect(gain).connect(panner).connect(dest);
    const route: SpatialRoute = { filter, gain, panner, attenuation: 0, occluded: false, busIndex };
    this.updateSpatialRoute(route, x, z, listener, forcedOcclusion, shape, false);
    return route;
  }

  updateSpatialRoute(route: SpatialRoute, x: number, z: number, listener: SpatialListener,
    forcedOcclusion?: boolean | number, shape: SpatialShape = {}, smooth = true) {
    const dx = x - listener.x, dz = z - listener.z;
    const dist = Math.hypot(dx, dz), range = shape.range ?? 180, ref = shape.reference ?? 3.5;
    const result = forcedOcclusion ?? this.occlusionTester?.(listener.x, listener.z, x, z) ?? 0;
    const occ = typeof result === 'boolean' ? (result ? 1 : 0) : clamp(result, 0, 1);
    const bunker = (listener.indoor ?? this.indoor) || forcedOcclusion === true || forcedOcclusion === 1;
    const air = 22000 / (1 + dist / 60);
    const floor = bunker ? 420 : lerp(2400, 520, occ);
    const cutoff = clamp(lerp(air, floor, occ), floor, 22000);
    const edge = clamp((range - dist) / (range * 0.2), 0, 1);
    const fade = edge * edge * (3 - 2 * edge);
    const falloff = shape.reference === undefined ? 24 : ref * 6.85;
    const attenuation = fade / (1 + Math.pow(Math.max(0, dist - ref) / falloff, 1.4)) / (1 + occ * (bunker ? 1.8 : 0.45));
    const set = (param: AudioParam, value: number) => smooth ? param.setTargetAtTime(value, this.ctx.currentTime, 0.06) : param.setValueAtTime(value, this.ctx.currentTime);
    set(route.filter.frequency, cutoff); route.filter.Q.value = lerp(0.7, 1.2, occ);
    if (smooth) set(route.gain.gain, attenuation); else route.gain.gain.value = attenuation;
    const yaw = listener.yaw ?? 0;
    const localX = dx * Math.cos(yaw) - dz * Math.sin(yaw);
    const localZ = -(dx * Math.sin(yaw) + dz * Math.cos(yaw));
    if ('positionX' in route.panner) {
      const p = route.panner as PannerNode;
      if (p.positionX) { set(p.positionX, localX); set(p.positionY, 0); set(p.positionZ, localZ); }
      else p.setPosition(localX, 0, localZ);
    } else set(route.panner.pan, clamp(localX / Math.max(1, dist), -1, 1));
    route.attenuation = attenuation; route.occluded = occ > 0.2;
  }
}
