import { clamp } from '../core/math';

/**
 * Snake venom, as pure rules. A viper's bite puts a dose into you: the health it will take if nothing is done, worked in over
 * a minute or so, faster while you run (the heart pumps it round) and slower if you keep still. A pressure bandage slows the
 * spread; a medkit draws most of what is left. Untreated, a Palestine viper's bite takes about 45 health on top of the bite
 * itself: a healthy person lives through one, but a second, or one on top of other wounds, can put you down.
 */

export type SnakeBite = 'palestine' | 'horned';

export const VENOM: Record<SnakeBite, { name: string; bite: number; dose: number; time: number }> = {
  palestine: { name: 'Palestine viper', bite: 6, dose: 45, time: 80 },
  horned: { name: 'horned viper', bite: 5, dose: 28, time: 60 },
};

/** Running makes it work this much faster; keeping still this much slower. */
export const VENOM_PACE = { run: 1.5, still: 0.6 };

export interface Venom {
  /** Health it will still take. */
  dose: number;
  /** Health a second at a walking pace. */
  rate: number;
  /** Bandaged: the spread is slowed. */
  bound: boolean;
}

export function newVenom(): Venom {
  return { dose: 0, rate: 0, bound: false };
}

/** A bite: more venom in, and the spread as fast as the worst of it. */
export function envenom(v: Venom, kind: SnakeBite) {
  const k = VENOM[kind];
  v.dose += k.dose;
  v.rate = Math.max(v.rate, v.dose / k.time);
  v.bound = false;
}

/** Health lost this tick. `pace` is how hard you are moving: 0 still, 1 walking, 2 running. */
export function tickVenom(v: Venom, dt: number, pace: number): number {
  if (v.dose <= 0) return 0;
  const p = pace <= 0 ? VENOM_PACE.still : pace >= 2 ? VENOM_PACE.run : 1;
  const loss = Math.min(v.dose, v.rate * p * (v.bound ? 0.5 : 1) * dt);
  v.dose -= loss;
  if (v.dose <= 0.01) Object.assign(v, newVenom());
  return loss;
}

/** A pressure bandage over the bite: it spreads half as fast. */
export function bindVenom(v: Venom): boolean {
  if (v.dose <= 0 || v.bound) return false;
  v.bound = true;
  return true;
}

/** A medkit draws most of it. Returns the health saved. */
export function drawVenom(v: Venom): number {
  if (v.dose <= 0) return 0;
  const saved = v.dose * 0.7;
  v.dose -= saved;
  v.rate *= 0.5;
  return saved;
}

export function cureVenom(v: Venom) {
  Object.assign(v, newVenom());
}

/** How bad it is, for the note on screen. */
export function venomLabel(v: Venom): string {
  if (v.dose <= 0) return '';
  return v.dose > 30 ? 'ENVENOMED (SEVERE)' : v.dose > 12 ? 'ENVENOMED' : 'ENVENOMED (MILD)';
}

/** Share of your walking speed left while the venom works (the bitten leg swells). */
export function venomSlow(v: Venom): number {
  return v.dose > 0 ? clamp(1 - v.dose / 200, 0.78, 1) : 1;
}
