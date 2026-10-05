import { clamp } from '../core/math';
import { coolantFactor } from './fluids';

/**
 * Engine temperature. A motor sheds waste heat in proportion to its output and load; the radiator rejects it in
 * proportion to its rating, condition, how well the bay lets air through, and how fast the vehicle is moving. The
 * balance sets a target temperature and the engine drifts toward it.
 *
 * Temperature is normalised: 0 cold, about 0.4 for a stock motor working, 1.0 where it starts to cook, 1.25 where it
 * blows. That is what makes a big engine in a small car a real project: it needs a radiator to match.
 */

export const T_COLD = 0.04;
export const T_WARM = 0.72;
export const T_HOT = 0.9;
export const T_OVERHEAT = 1.0;
export const T_CRITICAL = 1.25;
export const T_MAX = 1.6;

export interface ThermalIn {
  /** Waste heat at full load, kW. */
  heat: number;
  /** Radiator rating, kW. */
  cooling: number;
  /** Radiator condition, 0..1. */
  radiator: number;
  /** Share of airflow left by the bay (1 = clear). */
  airflow: number;
  /** Engine load, 0..1. */
  load: number;
  /** Ground speed, m/s. */
  speed: number;
  running: boolean;
  /** Water in the cooling system, 0..1. Missing means full. */
  coolant?: number;
  /** Share of the radiator's normal cooling left by the weather (a heat wave lowers it). Missing means 1. */
  ambient?: number;
}

/** The temperature an engine settles at if the conditions hold. */
export function steadyTemp(i: ThermalIn): number {
  if (!i.running || i.heat <= 0) return T_COLD;
  const gen = i.heat * (0.12 + 0.88 * clamp(i.load, 0, 1));
  // A fan keeps half the airflow at a standstill; the rest comes with speed.
  const flow = 0.5 + 0.5 * clamp(i.speed / 14, 0, 1);
  const shed = i.cooling * (0.25 + 0.75 * clamp(i.radiator, 0, 1)) * coolantFactor(i.coolant ?? 1) * clamp(i.airflow, 0.3, 1.5) * flow * clamp(i.ambient ?? 1, 0.5, 1.2) + i.heat * 0.05;
  return clamp(0.5 * (gen / shed), T_COLD, 2.2);
}

const HEAT_UP = 14;
const COOL_DOWN = 24;

/** One tick toward the steady temperature. Heating is quicker than cooling. */
export function thermalStep(T: number, i: ThermalIn, dt: number): number {
  const target = steadyTemp(i);
  const tau = target > T ? HEAT_UP : COOL_DOWN;
  return clamp(T + (target - T) * (1 - Math.exp(-dt / tau)), 0, T_MAX);
}

/** Power left to a cooking engine: nothing lost up to the redline, then up to 55% gone. */
export function overheatPower(T: number): number {
  return 1 - 0.55 * clamp((T - T_OVERHEAT) / (T_CRITICAL - T_OVERHEAT), 0, 1);
}

/** Engine condition lost per second above the redline. Zero while it is cool enough. */
export function overheatWear(T: number, dt: number): number {
  if (T <= T_OVERHEAT) return 0;
  return 0.006 * clamp((T - T_OVERHEAT) / (T_CRITICAL - T_OVERHEAT), 0, 1.5) * dt;
}

export type TempState = 'cold' | 'ok' | 'warm' | 'hot' | 'overheating';

export function tempState(T: number): TempState {
  return T >= T_OVERHEAT ? 'overheating' : T >= T_HOT ? 'hot' : T >= T_WARM ? 'warm' : T < 0.12 ? 'cold' : 'ok';
}

/** Steam from under the bonnet: none until it is hot, thick when it cooks. 0..1. */
export function steamLevel(T: number): number {
  return clamp((T - T_HOT) / (T_CRITICAL - T_HOT), 0, 1);
}

export interface ThermalForecast {
  /** Settling temperature cruising at 20 m/s on half throttle. */
  cruise: number;
  /** Settling temperature flat out at top speed. */
  flatOut: number;
  verdict: 'cool' | 'warm' | 'hot' | 'overheats';
}

/** What a build will do on a long drive, for the garage to warn about before the bolts go in. */
export function thermalForecast(heat: number, cooling: number, airflow: number, topSpeed: number, radiator = 1): ThermalForecast {
  const base = { heat, cooling, radiator, airflow, running: true };
  const cruise = steadyTemp({ ...base, load: 0.5, speed: 20 });
  const flatOut = steadyTemp({ ...base, load: 1, speed: Math.max(20, topSpeed) });
  const worst = Math.max(cruise, flatOut * 0.92);
  return { cruise, flatOut, verdict: worst >= T_OVERHEAT ? 'overheats' : worst >= T_HOT ? 'hot' : worst >= T_WARM ? 'warm' : 'cool' };
}

export const VERDICT_TEXT: Record<ThermalForecast['verdict'], string> = {
  cool: 'Runs cool',
  warm: 'Runs warm',
  hot: 'Runs hot on long climbs',
  overheats: 'WILL OVERHEAT: fit a bigger radiator',
};
