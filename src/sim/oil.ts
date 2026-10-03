import { clamp } from '../core/math';

/**
 * Engine oil. Every convoy engine has a sump (0..1). Driving burns it; below LOW the engine labours, and run dry it
 * eats itself. Oil comes in cans: one can fills half a sump, and the convoy keeps a reserve of loose cans.
 */

/** Sump fraction burnt per km driven at the baseline Drain setting: a full sump is good for about fourteen. */
export const OIL_PER_KM = 0.07;
/** And per idle second with the engine running. */
export const OIL_IDLE = 0.00004;
/** What one can adds. */
export const OIL_CAN = 0.5;
/** A can lying in the world is a full one; below this the warning starts. */
export const OIL_LOW = 0.25;
/** Below this the engine is being damaged. */
export const OIL_CRITICAL = 0.1;
/** Engine condition lost per second of running dry. */
export const OIL_WEAR = 0.01;

/**
 * Oil burnt over `metres` of driving and `dt` seconds with the engine on, as a fraction of the sump. A worn engine burns
 * it faster. `rate` is the engine's own appetite against the baseline, from `fluids.oilRate`: a big engine burns more.
 */
export function oilBurn(metres: number, dt: number, engine: number, drain = 1, rate = 1): number {
  const worn = 1 + clamp((0.6 - engine) / 0.6, 0, 1) * 1.5;
  return (OIL_PER_KM * (metres / 1000) + OIL_IDLE * dt) * worn * drain * rate;
}

/** Power left to an engine short of oil: untouched down to LOW, then up to 30% lost when bone dry. */
export function oilPower(oil: number): number {
  if (oil >= OIL_LOW) return 1;
  return 0.7 + 0.3 * clamp(oil / OIL_LOW, 0, 1);
}

/** Engine condition lost this tick to a sump that is nearly empty. Zero while there is enough oil. */
export function oilWear(oil: number, dt: number): number {
  if (oil >= OIL_CRITICAL) return 0;
  return OIL_WEAR * (1 - clamp(oil / OIL_CRITICAL, 0, 1) * 0.7) * dt;
}

export type OilState = 'ok' | 'low' | 'critical';
export function oilState(oil: number): OilState {
  return oil < OIL_CRITICAL ? 'critical' : oil < OIL_LOW ? 'low' : 'ok';
}

/**
 * How much of `amount` a sump at `oil` will take, and what is left over. Amounts are in standard sumps (three litres); a
 * bigger sump takes more of them to fill, a scooter's takes a sip.
 */
export function pourOil(oil: number, amount: number, sumpL = 3): { used: number; oil: number; left: number } {
  const std = Math.max(0.1, sumpL) / 3;
  const used = clamp(Math.min(amount, (1 - oil) * std), 0, amount);
  return { used, oil: clamp(oil + used / std, 0, 1), left: amount - used };
}

export function oilLabel(oil: number): string {
  return oil < OIL_CRITICAL ? 'oil dry' : oil < OIL_LOW ? 'oil low' : oil < 0.6 ? 'oil half' : 'oil ok';
}
