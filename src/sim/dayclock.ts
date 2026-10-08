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
/** A heads-up this far before the Bell, so the convoy can start looking for somewhere to camp. */
export const DUSK_WARN_AT = 0.62;
export const SUNSET_AT = 0.9;
export const NIGHT_AT = 1.0;
/**
 * Night camp off (the default): a night played out on the road ends here, and the clock turns over to the next morning
 * (t back to 0, a new day). About four minutes of full dark at the usual day length.
 */
export const DAWN_AT = 1.35;
/** The sky starts to grey this long before `DAWN_AT`, so the light at the turnover meets the next morning's without a jump. */
export const PREDAWN_AT = 1.24;

/** The Dusk Bell clock: dawn at 0, noon around 0.42, the Bell rings at 0.72, dark at 1.0 (and, played through, dawn again at 1.35). */
export class DayClock {
  elapsed = 0;
  bellRung = false;
  /** The early heads-up has been given (or skipped past). */
  warned = false;
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
  tick(dt: number): { bell: boolean; warn: boolean } {
    if (this.frozen) return { bell: false, warn: false };
    this.elapsed += dt;
    let warn = false;
    if (!this.warned && this.t >= DUSK_WARN_AT) {
      this.warned = true;
      // Only a real heads-up: a clock that jumps past the Bell in one step has nothing left to warn about.
      warn = !this.bellRung && this.t < DUSK_BELL_AT;
    }
    if (!this.bellRung && this.t >= DUSK_BELL_AT) {
      this.bellRung = true;
      return { bell: true, warn };
    }
    return { bell: false, warn };
  }
  /** Seconds of dark left until a night played out on the road turns into the next morning. */
  get secondsToDawn() {
    return Math.max(0, (DAWN_AT - this.t) * this.dayLength);
  }
  /** Jump to the Bell (used when the convoy reaches the end of the road early). */
  skipToDusk() {
    if (this.t < DUSK_BELL_AT) {
      this.elapsed = DUSK_BELL_AT * this.dayLength;
      this.warned = true;
    }
  }
  /** The next morning: first light again, with the heads-up and the Bell still to come. */
  newDay() {
    this.elapsed = 0;
    this.bellRung = false;
    this.warned = false;
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

/**
 * Lighting for a given clock value. Pure so it can be unit-tested and reused for the camp scene. Past `PREDAWN_AT` (a night
 * played out on the road) the dark greys toward the next morning's light, so the clock's turnover at `DAWN_AT` is seamless.
 */
export function lightAt(t: number, biome: 'wasteland' | 'city'): LightState {
  if (t <= PREDAWN_AT) return lightCore(t, biome);
  const k = smoothstep(PREDAWN_AT, DAWN_AT, t);
  const a = lightCore(1.12, biome);
  const b = lightCore(0, biome);
  return {
    elevation: lerp(a.elevation, b.elevation, k),
    azimuth: lerp(a.azimuth, b.azimuth, k),
    sunColor: mix(a.sunColor, b.sunColor, k),
    sunIntensity: lerp(a.sunIntensity, b.sunIntensity, k),
    hemiSky: mix(a.hemiSky, b.hemiSky, k),
    hemiGround: mix(a.hemiGround, b.hemiGround, k),
    hemiIntensity: lerp(a.hemiIntensity, b.hemiIntensity, k),
    fog: mix(a.fog, b.fog, k),
    sky: mix(a.sky, b.sky, k),
    night: lerp(a.night, b.night, k),
  };
}

function lightCore(t: number, biome: 'wasteland' | 'city'): LightState {
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

/** Lighting while crossing from the wasteland into a city (mix 0 to 1), so the sky does not jump at the district's edge. */
export function lightMix(t: number, mix: number): LightState {
  if (mix <= 0) return lightAt(t, 'wasteland');
  if (mix >= 1) return lightAt(t, 'city');
  const a = lightAt(t, 'wasteland');
  const b = lightAt(t, 'city');
  const m3 = (x: RGB, y: RGB): RGB => mix3(x, y, mix);
  return {
    elevation: lerp(a.elevation, b.elevation, mix),
    azimuth: lerp(a.azimuth, b.azimuth, mix),
    sunColor: m3(a.sunColor, b.sunColor),
    sunIntensity: lerp(a.sunIntensity, b.sunIntensity, mix),
    hemiSky: m3(a.hemiSky, b.hemiSky),
    hemiGround: m3(a.hemiGround, b.hemiGround),
    hemiIntensity: lerp(a.hemiIntensity, b.hemiIntensity, mix),
    fog: m3(a.fog, b.fog),
    sky: m3(a.sky, b.sky),
    night: lerp(a.night, b.night, mix),
  };
}
const mix3 = mix;
