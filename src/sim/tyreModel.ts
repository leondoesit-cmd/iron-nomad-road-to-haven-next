import { clamp } from '../core/math';

/**
 * A tyre on the ground, as pure rules. The physics (`physics/vehicle.ts`) asks each tyre, every step, how much it can push
 * sideways at the slip angle it has and how much it can pull or brake, and the two share one budget: a tyre braking or
 * spinning hard has little left to turn with, which is what makes a handbrake turn, a power slide, a locked-up skid and a
 * trail-braked entry happen on their own instead of being scripted.
 *
 * The ground sets the shape of the grip (how soon it peaks and how much is left once sliding) and how hard the tyre rolls;
 * the tyre's build adds its own character on top: a soft crawler takes a big slip angle before it bites and slides gently,
 * a road tyre answers sharply and lets go sooner, a bare rim barely holds at all.
 */

export type TyreKind = 'road' | 'scooter' | 'allTerrain' | 'knobby' | 'mud' | 'crawler' | 'rim';
export type GroundName = 'asphalt' | 'hardpan' | 'sand' | 'mud';

export interface GroundFeel {
  /** Slip angle (rad) where a road tyre's sideways grip peaks: small on tarmac, large on loose ground that has to be pushed. */
  peak: number;
  /** Share of the peak grip left once the tyre slides well past it: tarmac lets go, dirt keeps holding, sand ploughs. */
  slide: number;
  /** Rolling resistance against the rolling resistance on tarmac. */
  roll: number;
}

export const GROUND_FEEL: Record<GroundName, GroundFeel> = {
  asphalt: { peak: 0.105, slide: 0.72, roll: 1 },
  hardpan: { peak: 0.14, slide: 0.84, roll: 1.4 },
  sand: { peak: 0.22, slide: 0.94, roll: 2 },
  mud: { peak: 0.16, slide: 0.64, roll: 2 },
};

export interface TyreFeel {
  /** The slip angle it takes to reach peak grip, against a road tyre's (a soft carcass needs more). */
  peak: number;
  /** Added to the share of grip left when sliding. */
  slide: number;
  /** How well it bites on each ground, against the other tyres on the same vehicle (see `relativeGrip`). */
  bite: Record<GroundName, number>;
  /** Rolling resistance against a road tyre's on the same ground. */
  roll: Record<GroundName, number>;
}

export const TYRE_FEEL: Record<TyreKind, TyreFeel> = {
  road: { peak: 1, slide: 0, bite: { asphalt: 1, hardpan: 0.93, sand: 0.82, mud: 0.76 }, roll: { asphalt: 1, hardpan: 1, sand: 1, mud: 1 } },
  scooter: { peak: 0.95, slide: -0.02, bite: { asphalt: 1, hardpan: 0.9, sand: 0.78, mud: 0.74 }, roll: { asphalt: 0.9, hardpan: 1, sand: 1.15, mud: 1.1 } },
  allTerrain: { peak: 1.12, slide: 0.03, bite: { asphalt: 0.97, hardpan: 1, sand: 0.92, mud: 0.9 }, roll: { asphalt: 1.15, hardpan: 1, sand: 0.95, mud: 0.95 } },
  knobby: { peak: 1.22, slide: 0.04, bite: { asphalt: 0.92, hardpan: 1.02, sand: 0.98, mud: 1.02 }, roll: { asphalt: 1.3, hardpan: 1.05, sand: 0.9, mud: 0.9 } },
  mud: { peak: 1.3, slide: 0.05, bite: { asphalt: 0.9, hardpan: 1.02, sand: 1, mud: 1.08 }, roll: { asphalt: 1.4, hardpan: 1.05, sand: 0.88, mud: 0.85 } },
  crawler: { peak: 1.45, slide: 0.06, bite: { asphalt: 0.86, hardpan: 1.03, sand: 1.05, mud: 1.1 }, roll: { asphalt: 1.6, hardpan: 1.1, sand: 0.85, mud: 0.8 } },
  rim: { peak: 0.55, slide: 0.1, bite: { asphalt: 0.35, hardpan: 0.45, sand: 0.4, mud: 0.3 }, roll: { asphalt: 5, hardpan: 4, sand: 2.5, mud: 2.5 } },
};

/** The tyre a part id stands for. Factory tyres are what the chassis came on. */
export function tyreKindOf(id: string | undefined): TyreKind {
  switch (id) {
    case 'tyre_none':
      return 'rim';
    case 'whl_mt':
      return 'mud';
    case 'whl_bl':
      return 'crawler';
    case 'tyre_pickup':
    case 'tyre_truck':
      return 'allTerrain';
    case 'tyre_quad':
    case 'tyre_buggy':
      return 'knobby';
    case 'tyre_moped':
    case 'tyre_trike':
    case 'tyre_trike_r':
      return 'scooter';
    default:
      return 'road';
  }
}

export const groundName = (name: string | undefined): GroundName =>
  name === 'hardpan' || name === 'sand' || name === 'mud' ? name : 'asphalt';

/** One tyre's patch on one ground: the shape of its grip and how it rolls. */
export interface Patch {
  peak: number;
  slide: number;
  /** Rolling resistance against a road tyre on tarmac. */
  roll: number;
}

/** A flat tyre squirms (a huge slip angle before it holds anything) and drags like a brake. */
const FLAT = { peak: 2, slide: -0.1, roll: 8 };

export function patchOf(kind: TyreKind, ground: GroundName, flat: boolean, out: Patch): Patch {
  const g = GROUND_FEEL[ground];
  const t = TYRE_FEEL[kind];
  out.peak = g.peak * t.peak * (flat ? FLAT.peak : 1);
  out.slide = clamp(g.slide + t.slide + (flat ? FLAT.slide : 0), 0.35, 0.98);
  out.roll = g.roll * t.roll[ground] * (flat ? FLAT.roll : 1);
  return out;
}

/**
 * How well tyre `kind` bites on this ground against the vehicle's set as a whole. The set's average is already in the
 * vehicle's grip (its tyres' grip and off-road ratings, `sim/parts.ts`), so only the difference between corners is left
 * here: mud tyres on the back and road tyres on the front grip at the back in the mud and at the front on the tarmac.
 */
export function relativeGrip(kind: TyreKind, ground: GroundName, setMean: number): number {
  return setMean > 0 ? TYRE_FEEL[kind].bite[ground] / setMean : 1;
}

/** The average bite of a set of tyres on a ground. */
export function setBite(kinds: readonly TyreKind[], ground: GroundName): number {
  if (!kinds.length) return 1;
  let s = 0;
  for (const k of kinds) s += TYRE_FEEL[k].bite[ground];
  return s / kinds.length;
}

/**
 * Sideways grip against the slip angle, as a share of the peak (`s` is the slip angle over the peak's): a quick, rounded
 * rise to the peak, then it slides away toward `slide` by three times the peak angle.
 */
export function lateralCurve(s: number, slide: number): number {
  if (s <= 1) return Math.sin((s * Math.PI) / 2);
  const t = clamp((s - 1) / 2, 0, 1);
  return 1 - (1 - slide) * t * t * (3 - 2 * t);
}

/**
 * What a tyre asked for more than it has still gives (`u` is the demand over the grip, both directions together): all of it
 * up to the limit, then less as it breaks loose into wheelspin, a locked skid or a slide, down to `slide`.
 */
export function saturation(u: number, slide: number): number {
  if (u <= 1) return 1;
  const t = clamp((u - 1) / 0.8, 0, 1);
  return 1 - (1 - slide) * t * t * (3 - 2 * t);
}

/**
 * The extra drag of loose ground under one tyre, as a share of its load: deepest at a crawl (the tyre sits in its own hole
 * and has to climb out), easing as it starts to skim over the top, then rising again as it shoves a bow wave of sand ahead
 * of it. So a vehicle that keeps its speed up carries it across sand that would bog it from a standstill, and lifting off
 * slows it, but not dead. `drag` is the ground's drag rating (sand 0.35, mud 0.2) after the vehicle's own off-road
 * ability and the ruts have had their say.
 */
export function looseDrag(drag: number, speed: number): number {
  if (drag <= 0) return 0;
  const v = Math.abs(speed);
  return drag * (0.25 + 0.25 / (1 + v / 3) + 0.012 * v);
}

/**
 * How hard a tyre is being scrubbed across the ground, 0 (rolling) to 1: sliding sideways past its peak, spinning up, or
 * locked under the brakes. What lays rubber, smokes, roosts dirt, squeals and shakes the pad. A tyre held at its peak by
 * anti-lock or traction control barely scrubs at all.
 */
export function tyreScrub(slipSide: number, slipSpin: number): number {
  return clamp(clamp((slipSide - 0.6) / 4, 0, 1) + clamp((Math.abs(slipSpin) - 1.5) / 8, 0, 1), 0, 1);
}
