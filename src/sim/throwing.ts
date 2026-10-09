import { CHASSIS } from '../data';
import { clamp } from '../core/math';
import { carriedKg } from './massModel';
import type { Carried } from './carry';

/**
 * Throwing what you carry: a can, a wheel, a door, even an engine (barely). It is there to gather things up and pile them by
 * the car, so it is generous rather than true, but it still answers to two things: how heavy the thing is, and what shape
 * you are in. Hold the throw button to wind up (a heavier thing takes longer), let go to throw; a tap is a soft toss.
 *
 * Pure rules: the hands-on side is `game/grab.ts`.
 */

export const THROW = {
  /** Launch speed of something weightless at a full wind-up in good shape, m/s. */
  vMax: 15,
  /** Weight at which a throw has lost about a third of its speed, kg. */
  kgHalf: 12,
  /** Share of the full speed a tap (no wind-up) still gets. */
  tap: 0.45,
  /** Seconds to a full wind-up: this much, plus a second for every `windPerKg` kg, up to `windMax`. */
  wind: 0.35,
  windPerKg: 70,
  windMax: 1.5,
  /** Winded, you cannot wind up past this much. */
  windedCharge: 0.5,
  /** Stamina for a full throw of something weightless, and how much more for every kg, up to `costMax`. */
  cost: 4,
  costPerKg: 0.45,
  costMax: 32,
  /** How far above the line of sight it leaves the hand, radians: aimed level, it still goes up in an arc. */
  loft: 0.32,
} as const;

/** What a body brings to a throw. Every share is 0 to 1 unless said otherwise. */
export interface Thrower {
  /** Stamina, and whether you are winded. */
  stamina: number;
  winded: boolean;
  /** Health. */
  hp: number;
  /** Open wounds (0 to 3). */
  wounds: number;
  /** Everything else that slows the legs (hunger, thirst, drugs, venom, a bad night): 1 is normal, a stim is more. */
  pace: number;
  crouch: boolean;
  /** Water depth at the legs, m. */
  wading: number;
}

/** Weight of something carried by hand, kg, weighed against an ordinary hatchback where the part's size depends on the car. */
export function throwKg(c: Carried): number {
  return carriedKg(c, CHASSIS.hatch ?? Object.values(CHASSIS)[0]);
}

/** Seconds of holding to a full wind-up for something this heavy. */
export function windTime(kg: number): number {
  return Math.min(THROW.windMax, THROW.wind + kg / THROW.windPerKg);
}

/** How far wound up after holding `held` seconds, 0 to 1. */
export function throwCharge(held: number, kg: number, winded: boolean): number {
  return clamp(held / windTime(kg), 0, winded ? THROW.windedCharge : 1);
}

/** What shape you are in for a throw: about 1 rested and whole, down to a quarter when beaten up and out of breath. */
export function throwBody(b: Thrower): number {
  let k = (0.6 + 0.4 * clamp(b.stamina, 0, 1)) * (b.winded ? 0.75 : 1);
  k *= 0.55 + 0.45 * clamp(b.hp, 0, 1);
  k *= 1 - 0.08 * clamp(b.wounds, 0, 3);
  k *= clamp(b.pace, 0.7, 1.2);
  if (b.crouch) k *= 0.85;
  k *= 1 - 0.35 * clamp((b.wading - 0.3) / 0.6, 0, 1);
  return clamp(k, 0.25, 1.2);
}

/** Launch speed, m/s. */
export function throwSpeed(kg: number, charge: number, body: number): number {
  const heft = 1 / Math.sqrt(1 + Math.max(0, kg) / THROW.kgHalf);
  return THROW.vMax * heft * (THROW.tap + (1 - THROW.tap) * clamp(charge, 0, 1)) * body;
}

/** Stamina a throw takes. */
export function throwCost(kg: number, charge: number): number {
  return Math.min(THROW.costMax, (THROW.cost + kg * THROW.costPerKg) * (0.35 + 0.65 * clamp(charge, 0, 1)));
}

/** The angle it leaves the hand at, from the aim's pitch: always a little up, never straight up or into your feet. */
export function launchPitch(aimPitch: number): number {
  return clamp(aimPitch + THROW.loft, -0.35, 1.2);
}

/** How far it carries over flat ground before it first lands, m, from `h` metres up. Ignores air and the bounce. */
export function throwRange(speed: number, pitch: number, h: number, g = 9.81): number {
  const vx = speed * Math.cos(pitch);
  const vy = speed * Math.sin(pitch);
  const t = (vy + Math.sqrt(vy * vy + 2 * g * Math.max(0, h))) / g;
  return vx * t;
}
