import { clamp01, lerp, smoothstep } from '../core/math';

export type RGB = [number, number, number];

export interface LightState {
  /** Sun height: 1 overhead, 0 on the horizon, negative below. */
  elevation: number;
  /** Compass-ish azimuth for the sun, radians. */
  azimuth: number;
  sunColor: RGB;
  sunIntensity: number;
  hemiSky: RGB;
  hemiGround: RGB;
  hemiIntensity: number;
  fog: RGB;
  sky: RGB;
  /** 0 by day, 1 deep night. Drives window glow, headlights, Signature doubling. */
  night: number;
}

export const DUSK_BELL_AT = 0.72;
export const SUNSET_AT = 0.9;
export const NIGHT_AT = 1.0;

/** The Dusk Bell clock: dawn at 0, noon around 0.42, the Bell rings at 0.72, dark at 1.0. */
export class DayClock {
  elapsed = 0;
  bellRung = false;
  frozen = false;
  constructor(public dayLength: number, start = 0.1) {
    this.elapsed = start * dayLength;
  }
  get t() {
    return this.elapsed / this.dayLength;
  }
  get dusk() {
    return this.t >= DUSK_BELL_AT;
  }
  get night() {
    return this.t >= NIGHT_AT;
  }
  /** Seconds until the sun is gone. */
  get secondsToDark() {
    return Math.max(0, (NIGHT_AT - this.t) * this.dayLength);
  }
  tick(dt: number): { bell: boolean } {
    if (this.frozen) return { bell: false };
    this.elapsed += dt;
    if (!this.bellRung && this.t >= DUSK_BELL_AT) {
      this.bellRung = true;
      return { bell: true };
    }
    return { bell: false };
  }
  /** Jump to the Bell (used when the convoy reaches the end of the road early). */
  skipToDusk() {
    if (this.t < DUSK_BELL_AT) this.elapsed = DUSK_BELL_AT * this.dayLength;
  }
}

const mix = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

const PAL = {
  wasteland: {
    dawnSky: [0.95, 0.72, 0.55] as RGB,
    daySky: [0.82, 0.78, 0.7] as RGB,
    duskSky: [0.9, 0.45, 0.3] as RGB,
    nightSky: [0.06, 0.09, 0.17] as RGB,
    sun: [1.0, 0.86, 0.68] as RGB,
    sunLow: [1.0, 0.55, 0.3] as RGB,
    moon: [0.4, 0.5, 0.8] as RGB,
  },
  city: {
    dawnSky: [0.7, 0.72, 0.68] as RGB,
    daySky: [0.62, 0.68, 0.64] as RGB,
    duskSky: [0.75, 0.5, 0.32] as RGB,
    nightSky: [0.05, 0.08, 0.14] as RGB,
    sun: [0.95, 0.92, 0.8] as RGB,
    sunLow: [1.0, 0.6, 0.35] as RGB,
    moon: [0.35, 0.45, 0.7] as RGB,
  },
};

/** Lighting for a given clock value. Pure so it can be unit-tested and reused for the camp scene. */
export function lightAt(t: number, biome: 'wasteland' | 'city'): LightState {
  const p = PAL[biome];
  // Sun arc: rises 0..0.08, high mid-day, sets around 0.9.
  const arc = Math.sin(clamp01((t - 0.0) / 0.95) * Math.PI);
  const elevation = arc * 1.0 - 0.08 + (t > 0.95 ? -(t - 0.95) * 2 : 0);
  const night = smoothstep(0.86, 1.04, t);
  const dawn = 1 - smoothstep(0.0, 0.2, t);
  const dusk = smoothstep(0.6, 0.88, t) * (1 - night);
  let sky = mix(p.daySky, p.dawnSky, dawn);
  sky = mix(sky, p.duskSky, dusk);
  sky = mix(sky, p.nightSky, night);
  const sunLowness = Math.max(dawn, dusk);
  const sunColor = mix(mix(p.sun, p.sunLow, sunLowness), p.moon, night);
  const sunIntensity = lerp(3.4, 1.2, night) * lerp(1, 0.8, sunLowness);
  const hemiIntensity = lerp(1.7, 1.0, night);
  const fog = mix(sky, [0.02, 0.03, 0.06], night * 0.35);
  return {
    elevation: lerp(Math.max(0.34, elevation), 0.55, night),
    azimuth: lerp(-0.6, 1.2, clamp01(t)),
    sunColor,
    sunIntensity,
    hemiSky: mix(sky, [0.35, 0.45, 0.7], night * 0.7),
    hemiGround: mix([0.35, 0.28, 0.2], [0.08, 0.1, 0.15], night),
    hemiIntensity,
    fog,
    sky,
    night,
  };
}
