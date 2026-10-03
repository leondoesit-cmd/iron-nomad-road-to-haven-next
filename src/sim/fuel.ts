import type { FuelType } from '../data';
import { FUEL_NAME } from './engines';

/**
 * Two fuels. An engine burns the one it was built for; a tank holds one kind at a time. Petrol is the convoy's
 * `stocks.fuel` (everything that already spent "Fuel" still does), diesel is a reserve of its own.
 *
 * You can put a petrol motor in a diesel van. The tank still holds diesel, so the engine will not start until you
 * drain it (the jerrycan puts it back in the reserve) and fill with the right fuel.
 */

/** A tank with less than this left takes any fuel: the dregs do not count. */
export const TANK_DREGS = 0.4;

/** The slice of the campaign that holds fuel. */
export interface FuelReserve {
  stocks: { fuel: number };
  items: { diesel: number };
}

export function reserveOf(c: FuelReserve, t: FuelType): number {
  return t === 'diesel' ? c.items.diesel : c.stocks.fuel;
}

export function addReserve(c: FuelReserve, t: FuelType, amount: number) {
  if (t === 'diesel') c.items.diesel += amount;
  else c.stocks.fuel += amount;
}

/** Take up to `amount` from the reserve of one fuel. Returns what came out. */
export function takeReserve(c: FuelReserve, t: FuelType, amount: number): number {
  const take = Math.max(0, Math.min(amount, reserveOf(c, t)));
  if (t === 'diesel') c.items.diesel -= take;
  else c.stocks.fuel -= take;
  return take;
}

/** Why an engine cannot run on what is in its tank, or '' if it can. */
export function fuelMismatch(engine: FuelType, tank: FuelType, fuel: number): string {
  if (engine === tank || fuel <= 0.02) return '';
  return `Wrong fuel: the tank holds ${tank}, the engine runs on ${engine}`;
}

export interface PourPlan {
  ok: boolean;
  /** The tank ends up holding this. */
  tank: FuelType;
  /** Why not, or a note about what pouring does. */
  note: string;
}

/** Can this fuel go in this tank? Mixing is refused: a tank with fuel in it only takes more of the same. */
export function planPour(tank: FuelType, tankFuel: number, can: FuelType): PourPlan {
  if (can === tank) return { ok: true, tank, note: '' };
  if (tankFuel < TANK_DREGS) return { ok: true, tank: can, note: `the tank is switched to ${can}` };
  return { ok: false, tank, note: `The tank holds ${tank}: drain it before adding ${can}` };
}

export interface DrainPlan {
  ok: boolean;
  amount: number;
  label: string;
}

/** Draining a tank into the reserve. Worth doing when the tank holds the wrong fuel for its engine. */
export function planDrain(tank: FuelType, tankFuel: number, engine: FuelType): DrainPlan {
  if (tankFuel < TANK_DREGS) return { ok: false, amount: 0, label: 'The tank is already empty' };
  const wrong = tank !== engine;
  return { ok: true, amount: tankFuel, label: `Drain ${tankFuel.toFixed(1)} FU of ${tank} into the reserve${wrong ? ` (the engine wants ${engine})` : ''}` };
}

/** Fuel of this kind is what a loose can or world pickup holds: a third of what is found is diesel. */
export function pickupFuel(id: string): FuelType {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100) < 34 ? 'diesel' : 'petrol';
}

export const fuelLabel = (t: FuelType) => FUEL_NAME[t].toLowerCase();
