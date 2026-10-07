import { clamp, clamp01 } from '../core/math';
import type { Surface } from './ballistics';

/**
 * The bow, as pure rules: how the string comes back while the trigger is held, how hard an arrow flies for the draw it is
 * loosed at, what a long hold at full draw costs the arm, which arrows survive the landing to be shot again, and the quiver
 * that comes with a found bow. No engine imports, so every number is tested and tuned here.
 */

export const ARCHERY = {
  /** Below this much draw, letting go eases the string back down instead of loosing. */
  minLoose: 0.2,
  /** Share of full draw a second the string eases back down when the trigger is let go short of `minLoose`. */
  letDown: 3.5,
  /** Seconds a full draw can be held steady before the arm starts to shake. */
  holdFree: 1.8,
  /** Stamina a second spent holding past that. Run out and the string has to come down. */
  holdDrain: 12,
  /** Barrel wander at full draw held too long: this much more per second past `holdFree`, up to `shakeMax` times. */
  shakeRate: 1.6,
  shakeMax: 4,
  /** Arrows in the quiver that comes with a found bow. */
  quiver: 8,
  /** Arrows lying about or stuck in things at once in a scene; the oldest go first. */
  maxStuck: 48,
  /** How near (m) you have to come to an arrow to pull it out of what it is in, or pick it up. */
  reach: 1.3,
  /** Seconds an arrow can ride in a living body before it is given up as lost (the body wandered out of the world). */
  bodyLife: 120,
} as const;

/** The string: how far back it is (0 slack, 1 full draw) and how long it has been held at full draw. */
export interface Draw {
  k: number;
  held: number;
}

export const newDraw = (): Draw => ({ k: 0, held: 0 });

/**
 * One tick of the string. Held, it comes back at an even rate and reaches full draw after `secs`; let go, it eases back
 * down. Loosing is the caller's business: it reads `k` on the release and calls `slack`.
 */
export function stepDraw(d: Draw, pulling: boolean, secs: number, dt: number): void {
  if (pulling) {
    d.k = Math.min(1, d.k + dt / Math.max(0.05, secs));
    d.held = d.k >= 1 ? d.held + dt : 0;
  } else {
    d.k = Math.max(0, d.k - dt * ARCHERY.letDown);
    d.held = 0;
  }
}

/** The string goes slack at once: the arrow has gone, or the draw was given up. */
export function slack(d: Draw): void {
  d.k = 0;
  d.held = 0;
}

/** Whether letting go now sends the arrow, or only eases the string down. */
export const canLoose = (k: number) => k >= ARCHERY.minLoose;

/**
 * What an arrow carries for the draw it was loosed at: its speed as a share of a full draw's (the bow stores energy with
 * the square of the draw, so the speed rises with the draw itself) and its damage as a share of the bow's. A snapped-off
 * quarter draw is a nuisance; a full one drops a walker.
 */
export function loosePower(k: number): { vel: number; dmg: number } {
  const d = clamp01(k);
  return { vel: 0.35 + 0.65 * d, dmg: 0.4 + 0.6 * d };
}

/** How much more the bow wanders than its own sway, from how long full draw has been held. */
export function holdShake(held: number): number {
  return clamp(1 + Math.max(0, held - ARCHERY.holdFree) * ARCHERY.shakeRate, 1, ARCHERY.shakeMax);
}

/** Stamina a tick of holding full draw costs: nothing until the arm starts to tire. */
export function holdCost(held: number, dt: number): number {
  return held > ARCHERY.holdFree ? ARCHERY.holdDrain * dt : 0;
}

/**
 * Chance an arrow is spoilt by what it lands in: a shaft snapped on stone or steel, a point bent on concrete. Earth, wood
 * and flesh mostly give them back whole.
 */
export const BREAK: Record<Surface | 'flesh', number> = {
  flesh: 0.12,
  dirt: 0.08,
  wood: 0.1,
  plaster: 0.15,
  glass: 0.35,
  sheet: 0.4,
  car: 0.5,
  concrete: 0.55,
  stone: 0.6,
  steel: 0.75,
};

/** Whether an arrow survives landing on a surface, given a roll in [0, 1). A slow arrow is kinder to itself. */
export function arrowSurvives(surface: Surface | 'flesh', speedShare: number, roll: number): boolean {
  const p = BREAK[surface] * (0.5 + 0.5 * clamp01(speedShare));
  return roll >= p;
}

/**
 * How far into a surface an arrow buries its point (m), by how hard it arrives: deep in earth and flesh, a few centimetres
 * into wood or plaster, and only just into anything hard (it hangs off it at the end of its point).
 */
export function embedDepth(surface: Surface | 'flesh', speedShare: number): number {
  const s = clamp01(speedShare);
  switch (surface) {
    case 'flesh':
      return 0.12 + 0.14 * s;
    case 'dirt':
      return 0.1 + 0.22 * s;
    case 'wood':
      return 0.03 + 0.06 * s;
    case 'plaster':
      return 0.03 + 0.04 * s;
    default:
      return 0.015;
  }
}

/** Whether an arrow that strikes this surface stays in it, or glances off and falls. Glass breaks and lets it on through. */
export function sticks(surface: Surface | 'flesh'): boolean {
  return surface === 'flesh' || surface === 'dirt' || surface === 'wood' || surface === 'plaster';
}
