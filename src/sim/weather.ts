import { clamp01, smoothstep } from '../core/math';

/**
 * Dust storms. A storm is a window of the day, fixed by the campaign seed and the day number, so it needs no save data and
 * a reload lands in the same weather. Inside the window the level rises, holds and falls (0 clear, 1 the full wall).
 * A storm is a trade: raiders lose sight of you, but you lose sight of everything, and grit eats engine oil.
 */

/** The first day a storm can roll. Day one is for learning the road. */
export const STORM_FIRST_DAY = 2;
/** Chance that a given later day has one. */
export const STORM_CHANCE = 0.45;
/** Storms are over before the Dusk Bell (0.72) so the camp vote is never made blind. */
const LATEST_END = 0.7;

export interface StormWindow {
  /** Day-clock fractions: the first gust and the last of it. */
  start: number;
  end: number;
}

/** A small deterministic hash to a number in [0, 1). */
function hash01(a: number, b: number, salt: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + salt * 7919, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** The storm on a day, or null for a clear one. */
export function stormWindow(seed: number, day: number): StormWindow | null {
  if (day < STORM_FIRST_DAY) return null;
  if (hash01(seed, day, 1) >= STORM_CHANCE) return null;
  const len = 0.17 + hash01(seed, day, 2) * 0.1;
  const start = 0.13 + hash01(seed, day, 3) * (LATEST_END - len - 0.13);
  return { start, end: start + len };
}

/** Storm strength at a clock value: a quarter of the window rising, a quarter falling, the middle at full strength. */
export function stormLevel(t: number, w: StormWindow | null): number {
  if (!w || t <= w.start || t >= w.end) return 0;
  const span = w.end - w.start;
  const rise = smoothstep(0, 1, clamp01((t - w.start) / (span * 0.28)));
  const fall = smoothstep(0, 1, clamp01((w.end - t) / (span * 0.28)));
  return Math.min(rise, fall);
}

/** Share of its normal sight range a raider keeps in the dust. */
export function stormSight(level: number): number {
  return 1 - 0.58 * clamp01(level);
}

/** Engine oil burns faster while the air is full of grit. */
export function stormOilMult(level: number): number {
  return 1 + 1.1 * clamp01(level);
}

/** Share of its normal radius the minimap keeps: the dust hides the far ground. */
export function stormMapRadius(level: number): number {
  return 1 - 0.5 * clamp01(level);
}

/** The label for a level, for the clock line: nothing once it has cleared. */
export function stormLabel(level: number, rising: boolean): string {
  if (level < 0.05) return '';
  if (level < 0.5) return rising ? 'DUST WALL' : 'DUST CLEARING';
  return 'DUST STORM';
}

/** Fog: how much of the normal visibility is left at a level (the renderer scales near and far by this). */
export function stormFogScale(level: number): number {
  return 1 - 0.86 * clamp01(level);
}

/** Chance that a given day began after rain in the night. */
export const DAMP_CHANCE = 0.3;

/**
 * How wet the ground is at a clock value, 0 bone dry to 1 soaked. Some mornings follow a shower in the night: the ground
 * starts soaked, with puddles in the low spots, and dries out over the first half of the day. Like the storms it is fixed by
 * the seed and the day, so a reload lands on the same weather. Purely a matter of how the world looks.
 */
export function groundDamp(seed: number, day: number, t: number): number {
  if (hash01(seed, day, 5) >= DAMP_CHANCE) return 0;
  const start = 0.85 + hash01(seed, day, 6) * 0.15;
  const dry = 0.45 + hash01(seed, day, 7) * 0.2;
  return start * (1 - smoothstep(0.04, dry, t));
}

/** Where the storm wind blows at full strength, m/s (x, z). The dust streaks lean the same way. */
export const STORM_WIND: [number, number] = [18, -7];

/** The air's velocity at a moment, m/s: a faint breeze always, and the storm's wall of wind on top, gusting. */
export function windAt(storm: number, time: number): [number, number] {
  const s = clamp01(storm);
  const gust = 0.78 + 0.22 * Math.sin(time * 0.9) * Math.sin(time * 0.37 + 1.3) + 0.12 * Math.sin(time * 2.3);
  const breeze = 1.6;
  return [STORM_WIND[0] * s * gust + breeze * 0.8, STORM_WIND[1] * s * gust - breeze * 0.6];
}
