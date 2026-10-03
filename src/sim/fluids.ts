import { clamp } from '../core/math';

/**
 * What an engine drinks besides fuel. A bigger engine holds more oil and burns more of it, and runs a bigger cooling
 * system that needs more water. Oil and water are kept as a fraction of the vehicle's own sump and cooling system
 * (`comp.oil`, `comp.coolant`), and carried in the convoy as litres.
 */

/** The old reserve unit: one "sump" of oil. The reserve and loose oil cans are still counted in these. */
export const STD_SUMP_L = 3;
/** Litres in a water can, and the most the convoy can stow. */
export const WATER_CAN = 10;
export const WATER_RESERVE_MAX = 80;
/** Below this the warning starts; below CRITICAL the cooling system is as good as empty. */
export const COOLANT_LOW = 0.3;
export const COOLANT_CRITICAL = 0.12;

/** Litres of oil an engine holds. A scooter's sump is a cupful; a rig's is a bath. */
export function sumpLitres(engineLitres: number): number {
  return 0.5 + 1.15 * Math.max(0.05, engineLitres);
}

/** Litres in the cooling system: the core, the hoses, and the water jacket round a big engine. */
export function coolantLitres(coolingKw: number, engineLitres: number): number {
  return 1 + 0.045 * Math.max(0, coolingKw) + 0.8 * Math.max(0.05, engineLitres);
}

/**
 * How fast this engine burns oil against the baseline rate, as a fraction of its own sump. Litres burnt go up with the
 * engine (and more for a blown or diesel one); the sump it comes out of goes up too, but not as fast.
 */
export function oilRate(engineLitres: number, blown: boolean, diesel: boolean, sumpL: number): number {
  const perKm = Math.pow(Math.max(0.05, engineLitres) / 2, 0.6) * (blown ? 1.25 : 1) * (diesel ? 1.1 : 1);
  return (perKm * STD_SUMP_L) / Math.max(0.3, sumpL);
}

/** Cooling left to a system with this much water in it: full down to 60%, then it falls away fast. */
export function coolantFactor(coolant: number): number {
  return coolant >= 0.6 ? 1 : 0.1 + 0.9 * clamp(coolant / 0.6, 0, 1);
}

export interface CoolantIn {
  /** Engine temperature, normalised (see thermal.ts). */
  T: number;
  radiator: number;
  coolantL: number;
  running: boolean;
  dt: number;
}

/** Fraction of the system lost this tick: a little evaporates, a holed radiator leaks, and a cooking engine boils it away. */
export function coolantLoss(i: CoolantIn): number {
  let litres = i.running ? 0.00012 * i.dt : 0;
  if (i.radiator < 0.5) litres += (0.5 - i.radiator) * 0.08 * i.dt;
  if (i.T > 1) litres += 0.05 * clamp((i.T - 1) / 0.25, 0, 1.5) * i.dt;
  return litres / Math.max(0.5, i.coolantL);
}

/** Pour litres into the system: how much it took, its new level, and what is left in the can. */
export function pourWater(coolant: number, amountL: number, coolantL: number): { used: number; coolant: number; left: number } {
  const room = Math.max(0, (1 - coolant) * coolantL);
  const used = clamp(Math.min(amountL, room), 0, amountL);
  return { used, coolant: clamp(coolant + used / Math.max(0.5, coolantL), 0, 1), left: amountL - used };
}

export type CoolantState = 'ok' | 'low' | 'critical';
export function coolantState(c: number): CoolantState {
  return c < COOLANT_CRITICAL ? 'critical' : c < COOLANT_LOW ? 'low' : 'ok';
}
