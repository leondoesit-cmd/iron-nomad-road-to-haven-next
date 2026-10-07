import { clamp, clamp01 } from '../core/math';

/**
 * How things burn, without drawing anything: what each fuel looks like and gives off, and how a fire answers the world
 * round it. The fire system (`game/fires.ts`) runs it; the tests run it bare.
 *
 * - Wind leans a flame over by its Froude number (the wind's push against the flame's own buoyancy): a small flame lies down
 *   in a breeze a big one shrugs off. It also feeds an open fire air, and carries its smoke, its embers and its spread.
 * - Rain beats a fire down in proportion to how wet its fuel can get: grass and brush drown fast, a log fire smoulders on,
 *   burning petrol hardly notices. Under a roof it never rains.
 * - Water: a wood fire that goes under is out at once in a burst of steam. Petrol and oil float, and go on burning on the
 *   surface, drifting with the current.
 */

export type Fuel = 'wood' | 'brush' | 'grass' | 'petrol' | 'rubber' | 'flesh' | 'coals' | 'flare';

export interface FuelSpec {
  /** Flame look for the shader (`render/fireRender.FLAME_KIND`). */
  look: 'wood' | 'oil' | 'flare' | 'grass' | 'gas';
  /** Flame height at full heat, per metre across the fire, and the most it ever reaches (m). */
  tall: number;
  tallMax: number;
  /** Light colour (linear) and how bright it burns per metre of fire across at full heat (candela-like). */
  light: [number, number, number];
  glow: number;
  /** Smoke colour, how thick, and puffs a second per square metre burning. */
  smoke: [number, number, number];
  smokeAlpha: number;
  smokeRate: number;
  /** Embers a second per square metre. */
  embers: number;
  /** How hard rain beats it down (1 an open wood fire). */
  rainK: number;
  /** Floats on water and burns on it. */
  floats: boolean;
  /** Burn damage a second to someone standing in it at full heat. */
  dps: number;
  /** How readily it lights what is round it, 0..1. */
  spread: number;
  /** How much its flames flicker (0 a steady jet). */
  flick: number;
  /** Seconds a square metre of it lasts at full heat, when the fire has to live on what it has. */
  life: number;
}

export const FUELS: Record<Fuel, FuelSpec> = {
  wood: { look: 'wood', tall: 1.3, tallMax: 9, light: [1, 0.5, 0.19], glow: 30, smoke: [0.34, 0.32, 0.3], smokeAlpha: 0.32, smokeRate: 0.9, embers: 4, rainK: 1, floats: false, dps: 8, spread: 0.6, flick: 1, life: 240 },
  brush: { look: 'wood', tall: 1.3, tallMax: 4, light: [1, 0.52, 0.2], glow: 9, smoke: [0.38, 0.36, 0.33], smokeAlpha: 0.26, smokeRate: 1.0, embers: 3, rainK: 1.4, floats: false, dps: 7, spread: 0.9, flick: 1, life: 35 },
  grass: { look: 'grass', tall: 0.9, tallMax: 1.8, light: [1, 0.55, 0.22], glow: 7, smoke: [0.44, 0.41, 0.36], smokeAlpha: 0.22, smokeRate: 0.7, embers: 1.5, rainK: 1.8, floats: false, dps: 6, spread: 1, flick: 1, life: 14 },
  petrol: { look: 'oil', tall: 1.2, tallMax: 3.5, light: [1, 0.47, 0.16], glow: 18, smoke: [0.05, 0.045, 0.04], smokeAlpha: 0.55, smokeRate: 1.3, embers: 0.6, rainK: 0.22, floats: true, dps: 12, spread: 0.8, flick: 0.9, life: 12 },
  rubber: { look: 'oil', tall: 1.3, tallMax: 4, light: [1, 0.45, 0.15], glow: 16, smoke: [0.04, 0.037, 0.035], smokeAlpha: 0.62, smokeRate: 1.4, embers: 1.2, rainK: 0.4, floats: true, dps: 10, spread: 0.5, flick: 0.9, life: 90 },
  flesh: { look: 'wood', tall: 1.4, tallMax: 2.2, light: [1, 0.5, 0.18], glow: 16, smoke: [0.3, 0.27, 0.23], smokeAlpha: 0.35, smokeRate: 1.1, embers: 0.8, rainK: 0.6, floats: false, dps: 6, spread: 0.3, flick: 1, life: 40 },
  coals: { look: 'wood', tall: 0.35, tallMax: 0.4, light: [1, 0.33, 0.09], glow: 9, smoke: [0.4, 0.38, 0.36], smokeAlpha: 0.12, smokeRate: 0.2, embers: 0.5, rainK: 0.7, floats: false, dps: 4, spread: 0.15, flick: 0.6, life: 600 },
  flare: { look: 'flare', tall: 2.2, tallMax: 0.7, light: [1, 0.13, 0.09], glow: 34, smoke: [0.8, 0.62, 0.62], smokeAlpha: 0.3, smokeRate: 3, embers: 6, rainK: 0, floats: true, dps: 5, spread: 0.2, flick: 0.5, life: 28 },
};

/** Flame height for a fire `r` metres in radius at `heat` (0..1). */
export function flameHeight(fuel: Fuel, r: number, heat: number): number {
  const f = FUELS[fuel];
  // A fire wider than a couple of metres burns as many flames side by side, not one taller one.
  const across = Math.min(2 * Math.max(0.15, r), 2 + 0.5 * r);
  return Math.min(f.tallMax, f.tall * across * (0.25 + 0.75 * heat)) * (0.35 + 0.65 * Math.sqrt(heat));
}

/**
 * How far wind pushes a flame's tip, per metre of its height. The Froude number U / sqrt(g H) sets the tilt: a metre-tall
 * flame in a 5 m/s wind leans over by about fifty degrees, a ten-metre crown fire much less.
 */
export function flameLean(windX: number, windZ: number, h: number): [number, number] {
  const u = Math.hypot(windX, windZ);
  if (u < 1e-3) return [0, 0];
  const lean = clamp((0.85 * u) / Math.sqrt(9.81 * Math.max(0.3, h)), 0, 1.9);
  return [(windX / u) * lean, (windZ / u) * lean];
}

/** How much a breeze fans an open fire (more air, more heat), 1 still air. */
export function windFeed(wind: number): number {
  return 1 + 0.18 * clamp01(wind / 8) - 0.25 * clamp01((wind - 14) / 10);
}

/** How fast rain takes heat out of a fire, per second. Nothing under a roof. */
export function rainCooling(fuel: Fuel, rain: number, heat: number, sheltered: boolean): number {
  if (sheltered || rain <= 0) return 0;
  return rain * 0.22 * FUELS[fuel].rainK * (0.6 + heat);
}

/**
 * One step of a fire's heat toward what its fuel can give: up fast while there is fuel, slower down as it dies, held under
 * by rain. `want` is the heat the fire would reach (0 when its fuel is spent).
 */
export function stepHeat(heat: number, want: number, cooling: number, dt: number): number {
  const rate = want > heat ? 0.55 : 0.35;
  return clamp(heat + ((want - heat) * rate - cooling) * dt, 0, 1);
}

/** What water does to a fire on it: out (sinks), burns on (floats), or nothing (dry). */
export function waterFate(fuel: Fuel, depth: number): 'dry' | 'out' | 'floats' {
  if (depth <= 0.06) return 'dry';
  return FUELS[fuel].floats ? 'floats' : 'out';
}

/**
 * Light a fire gives: colour times intensity, and how far it reaches. Bigger fires are brighter by the area of flame they
 * show (radius to the power 1.5: the flames grow taller as well as wider), flickering by `flicker` (about 1).
 */
export function fireLight(fuel: Fuel, r: number, heat: number, flicker: number): { r: number; g: number; b: number; range: number; power: number } {
  const f = FUELS[fuel];
  const power = f.glow * heat * Math.pow(Math.max(0.25, r * 2), 1.5) * flicker;
  return { r: f.light[0] * power, g: f.light[1] * power, b: f.light[2] * power, range: clamp(Math.sqrt(power / 0.025), 4, 110), power };
}

/** A flame's flicker at time `t` (about 1): a slow swell, a quicker waver and a fast shimmer, never twice the same. */
export function flicker(t: number, seed: number, amount = 1): number {
  const s = seed * 12.9898;
  const v = 0.11 * Math.sin(t * 1.7 + s) + 0.08 * Math.sin(t * 4.3 + s * 1.3) * Math.sin(t * 0.9 + s * 0.7) + 0.06 * Math.sin(t * 11.7 + s * 2.1) + 0.04 * Math.sin(t * 23.3 + s * 3.7);
  return 1 + v * amount;
}

/**
 * Odds a second that a burning patch of ground lights its neighbour. `heat` of the burning one, `fuel` of the neighbour
 * (0 bare, 1 thick dry grass), `danger` how dry the land is (`sim/climate.fireDanger`), and `along` how much the step to the
 * neighbour runs with the wind (the dot of the step's direction with the wind's, times its speed in m/s): a grass fire runs
 * downwind and creeps back against it.
 */
export function spreadRate(heat: number, fuel: number, danger: number, along: number): number {
  if (fuel <= 0.02 || danger <= 0.02 || heat <= 0.2) return 0;
  const wind = along >= 0 ? 1 + along * 0.45 : Math.max(0.12, 1 + along * 0.18);
  return 0.55 * heat * fuel * danger * danger * wind;
}
