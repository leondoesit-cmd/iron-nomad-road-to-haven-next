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
 * - A fire makes its own wind. The hot gas rises as a plume that draws air in along the ground from all round: next to
 *   nothing for a campfire, a steady inflow of a metre or two a second toward a big grass fire, which bends the flames of
 *   the fires round it in toward it and pulls the smoke into one rising column.
 * - Grass fire spreads at the speed measured in real grassland (the CSIRO grassfire model): a few centimetres a second in
 *   still air, a fraction of a metre a second at the head in a breeze, metres a second only in a gale; the flanks and the
 *   back creep.
 */

export type Fuel = 'wood' | 'brush' | 'grass' | 'petrol' | 'rubber' | 'flesh' | 'coals' | 'flare';

export interface FuelSpec {
  /** Flame look for the shader (`render/fireRender.FLAME_KIND`). */
  look: 'wood' | 'oil' | 'flare' | 'grass' | 'gas' | 'ember' | 'fat';
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
  /** Heat it gives off per square metre burning at full heat, kW (a log fire about 400, a petrol pool 2000). */
  hrr: number;
}

export const FUELS: Record<Fuel, FuelSpec> = {
  wood: { look: 'wood', tall: 1.3, tallMax: 9, light: [1, 0.5, 0.19], glow: 30, smoke: [0.34, 0.32, 0.3], smokeAlpha: 0.32, smokeRate: 0.9, embers: 4, rainK: 1, floats: false, dps: 8, spread: 0.6, flick: 1, life: 240, hrr: 400 },
  brush: { look: 'wood', tall: 1.3, tallMax: 4, light: [1, 0.52, 0.2], glow: 9, smoke: [0.38, 0.36, 0.33], smokeAlpha: 0.26, smokeRate: 1.0, embers: 3, rainK: 1.4, floats: false, dps: 7, spread: 0.9, flick: 1, life: 35, hrr: 500 },
  grass: { look: 'grass', tall: 0.9, tallMax: 1.8, light: [1, 0.55, 0.22], glow: 7, smoke: [0.44, 0.41, 0.36], smokeAlpha: 0.22, smokeRate: 0.7, embers: 1.5, rainK: 1.8, floats: false, dps: 6, spread: 1, flick: 1, life: 14, hrr: 300 },
  petrol: { look: 'oil', tall: 1.2, tallMax: 3.5, light: [1, 0.47, 0.16], glow: 18, smoke: [0.05, 0.045, 0.04], smokeAlpha: 0.55, smokeRate: 1.3, embers: 0.6, rainK: 0.22, floats: true, dps: 12, spread: 0.8, flick: 0.9, life: 12, hrr: 2000 },
  rubber: { look: 'oil', tall: 1.3, tallMax: 4, light: [1, 0.45, 0.15], glow: 16, smoke: [0.04, 0.037, 0.035], smokeAlpha: 0.62, smokeRate: 1.4, embers: 1.2, rainK: 0.4, floats: true, dps: 10, spread: 0.5, flick: 0.9, life: 90, hrr: 900 },
  flesh: { look: 'fat', tall: 1.4, tallMax: 2.2, light: [1, 0.5, 0.18], glow: 16, smoke: [0.3, 0.27, 0.23], smokeAlpha: 0.35, smokeRate: 1.1, embers: 0.8, rainK: 0.6, floats: false, dps: 6, spread: 0.3, flick: 1, life: 40, hrr: 300 },
  coals: { look: 'ember', tall: 0.35, tallMax: 0.4, light: [1, 0.33, 0.09], glow: 9, smoke: [0.4, 0.38, 0.36], smokeAlpha: 0.12, smokeRate: 0.2, embers: 0.5, rainK: 0.7, floats: false, dps: 4, spread: 0.15, flick: 0.6, life: 600, hrr: 150 },
  flare: { look: 'flare', tall: 2.2, tallMax: 0.7, light: [1, 0.13, 0.09], glow: 34, smoke: [0.8, 0.62, 0.62], smokeAlpha: 0.3, smokeRate: 3, embers: 6, rainK: 0, floats: true, dps: 5, spread: 0.2, flick: 0.5, life: 28, hrr: 60 },
};

/** Heat a fire gives off, kW: its fuel's burning rate over the area burning. A tree's crown burns as its wood, thick. */
export function heatRelease(fuel: Fuel, r: number, heat: number, crown = false): number {
  return FUELS[fuel].hrr * Math.PI * r * r * (crown ? 0.9 : 1) * clamp01(heat);
}

/**
 * The air a fire draws in along the ground, m/s toward it, at `d` metres from the middle of a fire of `q` kW and radius
 * `r`. A fire's buoyant gas moves at about (g Q / (rho cp T D))^(1/3), and the air drawn in at its edge at about a third of
 * that: half a metre a second at a campfire's stones, a metre or two at the edge of a big grass or petrol fire. Further out
 * the same air comes in through a wider ring, so it slows as r / d; inside the fire it comes from every side and cancels
 * toward the middle.
 */
export function plumeInflow(q: number, d: number, r: number): number {
  if (q <= 0) return 0;
  const rr = Math.max(0.3, r);
  const edge = 0.3 * Math.cbrt((0.0273 * q) / (2 * rr));
  return d >= rr ? (edge * rr) / d : (edge * d) / rr;
}

/** How fast the smoke leaves the top of a fire of `q` kW, m/s: the plume's own updraft, a few metres a second. */
export function plumeRise(q: number): number {
  return clamp(0.6 + 0.3 * Math.cbrt(Math.max(0, q)), 0.8, 7);
}

/** Flame height for a fire `r` metres in radius at `heat` (0..1). */
export function flameHeight(fuel: Fuel, r: number, heat: number): number {
  const f = FUELS[fuel];
  // A fire wider than a couple of metres burns as many flames side by side, not one taller one.
  const across = Math.min(2 * Math.max(0.15, r), 2 + 0.5 * r);
  return Math.min(f.tallMax, f.tall * across * (0.25 + 0.75 * heat)) * (0.35 + 0.65 * Math.sqrt(heat));
}

/**
 * The wind a flame feels. The weather's wind is the open-field wind ten metres up; down where a fire burns the ground slows
 * it (a log profile: about half at half a metre, three-quarters at a few metres), so the breeze that sways the treetops
 * barely tips a campfire, and only a real blow lays one over. `h` is the flame's height; the wind is taken at its middle.
 */
export function flameWind(windX: number, windZ: number, h: number): [number, number] {
  const k = clamp(Math.log(Math.max(0.15, h * 0.5) / 0.03) / Math.log(10 / 0.03), 0.3, 1);
  return [windX * k, windZ * k];
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

/**
 * A flame's flicker at time `t` (about 1): a slow swell, a waver and a light quiver, never twice the same. The light of a
 * fire swells and sinks over a few seconds; anything quicker reads as a strobe, not a flame.
 */
export function flicker(t: number, seed: number, amount = 1): number {
  const s = seed * 12.9898;
  const v = 0.12 * Math.sin(t * 0.22 + s) + 0.09 * Math.sin(t * 0.5 + s * 1.3) * Math.sin(t * 0.12 + s * 0.7) + 0.05 * Math.sin(t * 1.04 + s * 2.1) + 0.025 * Math.sin(t * 1.64 + s * 3.7);
  return 1 + v * amount;
}

/**
 * How fast a grass fire's edge moves, m/s, in a direction at an angle to the wind whose cosine is `cos`. `fuel` is what the
 * ground holds (0 bare, 1 thick dry grass), `danger` how dry the land is (`sim/climate.fireDanger`), `wind` the open-field
 * wind ten metres up, m/s.
 *
 * The head runs at the CSIRO grassland model's rate (Cheney, Gould & Catchpole 1998): 0.054 + 0.269 U km/h below 5 km/h of
 * wind, 1.4 + 0.838 (U - 5)^0.844 above, for fully cured grass; damper grass and thinner cover run slower. The game
 * takes 40% of that (`SPREAD_PACE`): under a centimetre a second in still air, about a fifth of a metre a second at the
 * head in a light breeze, a metre and a half in a gale. The rest of the edge follows the ellipse a wind-driven grass fire burns out, longer the stronger the wind (length
 * to breadth 1.1 U^0.464): the flanks widen at a tenth of the head's pace, the back creeps into the wind.
 */
/** The game's grass fires run at 40% of the measured pace: a fire you can watch take the hillside, not race it. */
export const SPREAD_PACE = 0.4;

export function spreadSpeed(fuel: number, danger: number, wind: number, cos: number): number {
  if (fuel <= 0.02 || danger <= 0.02) return 0;
  const u = Math.max(0, wind) * 3.6;
  const headKmh = u < 5 ? 0.054 + 0.269 * u : 1.4 + 0.838 * Math.pow(u - 5, 0.844);
  const head = (headKmh / 3.6) * danger * danger * (0.3 + 0.7 * Math.min(1, fuel));
  const lb = clamp(1.1 * Math.pow(Math.max(u, 1e-3), 0.464), 1, 6);
  const e = Math.sqrt(1 - 1 / (lb * lb));
  return (SPREAD_PACE * head * (1 - e)) / (1 - e * clamp(cos, -1, 1));
}

/**
 * Odds a second that a burning patch of ground lights a neighbour `dist` metres off in a direction at an angle to the wind
 * whose cosine is `cos`: the edge's speed that way over the distance, once the patch burns hot enough to carry it.
 */
export function spreadRate(heat: number, fuel: number, danger: number, wind: number, cos: number, dist: number): number {
  if (heat <= 0.2) return 0;
  return (spreadSpeed(fuel, danger, wind, cos) / Math.max(0.1, dist)) * clamp01((heat - 0.2) / 0.4);
}
