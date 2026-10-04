import { INTERIOR_STOCK, hasPart, isInteriorSlot, partDef, type BrakeSpec, type ExhaustSpec, type GearboxSpec, type PartSlot, type SuspensionSpec, type VehicleDef } from '../data';
import { clamp } from '../core/math';
import type { EngineEffects } from './engines';
import type { Fit } from './parts';

/**
 * The rest of the machine. An engine is only the start of it: the gearbox has to carry what the engine makes, the brakes
 * have to stop what the engine speeds up, the springs have to hold up what the engine weighs, and the exhaust decides how
 * freely it breathes and how loudly. Each part has a rating, and each is judged against the vehicle it is bolted into.
 *
 * Like engines, every chassis has factory versions (`gbx_<id>`, `sus_<id>`, `brk_<id>`, `exh_<id>`) sized for its own
 * stock numbers, so a stock vehicle is exactly what `vehicles.json` says, and anything bigger loads the parts around it.
 */

/** Used for chassis with no factory parts (boats, raider rigs): nothing is ever strained. */
const NEUTRAL_GEARBOX: GearboxSpec = { rating: 1e6, gearing: 0, mass: 0 };
const NEUTRAL_SUSPENSION: SuspensionSpec = { load: 1e6, travel: 1, mass: 0 };
const NEUTRAL_BRAKES: BrakeSpec = { power: 1, energy: 1e9 };
const NEUTRAL_EXHAUST: ExhaustSpec = { flow: 0, noise: 1 };

export type FactoryPrefix = 'gbx' | 'sus' | 'brk' | 'exh';
export const factoryId = (def: VehicleDef, pre: FactoryPrefix) => `${pre}_${def.id}`;

const SLOT_PREFIX: Partial<Record<PartSlot, FactoryPrefix>> = { gearbox: 'gbx', suspension: 'sus', brakes: 'brk', exhaust: 'exh' };

/** The id of the factory part a chassis has in a slot, if it has one. */
export function factoryIdFor(def: VehicleDef, slot: PartSlot): string | undefined {
  const pre = SLOT_PREFIX[slot];
  if (pre) {
    const id = factoryId(def, pre);
    return hasPart(id) ? id : undefined;
  }
  if (slot === 'hood') return (def.slots ?? []).includes('hood') ? 'hood_std' : undefined;
  if (slot === 'doorL' || slot === 'doorR') return (def.slots ?? []).includes(slot) ? 'door_std' : undefined;
  if (isInteriorSlot(slot)) return (def.slots ?? []).includes(slot) ? INTERIOR_STOCK[slot] : undefined;
  return undefined;
}

function partIn(def: VehicleDef, fit: Fit, slot: PartSlot) {
  const fitted = fit[slot];
  if (fitted) return partDef(fitted.id);
  const id = factoryIdFor(def, slot);
  return id ? partDef(id) : null;
}

export function gearboxSpec(def: VehicleDef, fit: Fit): GearboxSpec {
  return partIn(def, fit, 'gearbox')?.gearbox ?? NEUTRAL_GEARBOX;
}
export function suspensionSpec(def: VehicleDef, fit: Fit): SuspensionSpec {
  return partIn(def, fit, 'suspension')?.suspension ?? NEUTRAL_SUSPENSION;
}
export function brakeSpec(def: VehicleDef, fit: Fit): BrakeSpec {
  return partIn(def, fit, 'brakes')?.brakes ?? NEUTRAL_BRAKES;
}
export function exhaustSpec(def: VehicleDef, fit: Fit): ExhaustSpec {
  return partIn(def, fit, 'exhaust')?.exhaust ?? NEUTRAL_EXHAUST;
}

const stockGearbox = (def: VehicleDef) => (hasPart(factoryId(def, 'gbx')) ? partDef(factoryId(def, 'gbx')).gearbox! : NEUTRAL_GEARBOX);
const stockBrakes = (def: VehicleDef) => (hasPart(factoryId(def, 'brk')) ? partDef(factoryId(def, 'brk')).brakes! : NEUTRAL_BRAKES);

/** Bonnet and doors that are off the vehicle. */
export function bodyOff(def: VehicleDef, fit: Fit): { hood: boolean; doors: number } {
  const off = (slot: PartSlot) => !!partIn(def, fit, slot)?.empty;
  return { hood: off('hood'), doors: Number(off('doorL')) + Number(off('doorR')) };
}

/** The speed factor the gearing alone gives: tall gears 1.18, short gears 0.82. Needed before the rest, since braking depends on speed. */
export function gearTop(def: VehicleDef, fit: Fit): number {
  const gb = gearboxSpec(def, fit);
  return 1 - 0.18 * (gb.rating <= 0 ? 0 : gb.gearing);
}

export interface DrivetrainEffects {
  /** Multipliers on the chassis' numbers. */
  force: number;
  top: number;
  grip: number;
  travel: number;
  sig: number;
  /** Braking against the stock chassis. */
  brake: number;
  /** Total weight with the engine and gearbox it carries, kg. */
  mass: number;
  /** Weight over what the springs carry. Above 1 the vehicle sags. */
  overload: number;
  /** Engine output over what the gearbox can carry at full throttle. Above 1 the gearbox wears. */
  strain: number;
  gearboxRating: number;
  /** Energy to shed in one stop from top speed, and what the brakes can take, kJ. */
  stopDemand: number;
  stopRating: number;
  noDrive: boolean;
}

/**
 * How the gearbox, exhaust, brakes and springs change a chassis, given the engine in it. `topMult` is the speed the
 * vehicle will really reach with this engine, since faster means more to stop.
 */
export function drivetrainEffects(def: VehicleDef, fit: Fit, ef: EngineEffects, topMult: number): DrivetrainEffects {
  const gb = gearboxSpec(def, fit);
  const sus = suspensionSpec(def, fit);
  const brk = brakeSpec(def, fit);
  const exh = exhaustSpec(def, fit);
  const g = gb.rating <= 0 ? 0 : gb.gearing;
  const noDrive = gb.rating <= 0;
  // Short gears launch harder and run out of speed sooner; tall gears do the opposite. The exhaust adds breathing.
  const force = noDrive ? 0 : (1 + 0.3 * g) * (1 + exh.flow);
  const top = 1 - 0.18 * g;
  const mass = def.physics.mass + ef.massDelta + (gb.mass - stockGearbox(def).mass);
  const overload = sus.load > 0 ? mass / sus.load : 9;
  const over = Math.max(0, overload - 1);
  const travel = clamp(sus.travel * (overload > 1 ? 1 / Math.pow(overload, 0.8) : 1), 0.3, 1.8);
  const grip = overload > 1 ? clamp(1 - 0.3 * over, 0.45, 1) : 1;
  const v = (def.topSpeedKmh * topMult) / 3.6;
  const stopDemand = (0.5 * mass * v * v) / 1000;
  // How well the brakes cope with this stop, against how well the factory ones cope with the factory stop: stock is 1.
  const stockDemand = (0.5 * def.physics.mass * Math.pow(def.topSpeedKmh / 3.6, 2)) / 1000;
  const stockCope = stockDemand > 0 ? stockBrakes(def).energy / stockDemand : 1;
  const ratio = stopDemand > 0 && stockCope > 0 ? brk.energy / stopDemand / stockCope : 9;
  // A chassis with no brake data (a raider's buggy, a boat) just brakes as the table says.
  const brake = brk.energy >= 1e8 ? 1 : clamp(brk.power * Math.min(1.6, ratio), 0.2, 2.4);
  return {
    force,
    top,
    grip,
    travel,
    sig: exh.noise,
    brake,
    mass,
    overload,
    strain: noDrive ? 9 : (ef.empty ? 0 : ef.spec.kw * (1 + exh.flow)) / gb.rating,
    gearboxRating: gb.rating,
    stopDemand,
    stopRating: brk.energy,
    noDrive,
  };
}

// ---------------------------------------------------------------- wear

/** Gearbox condition lost per second at full throttle, above its rating. Nothing below it. */
export function gearboxWear(strain: number, load: number, dt: number): number {
  const over = strain * clamp(load, 0, 1) - 1;
  return over > 0 ? 0.0045 * Math.min(over, 3) * dt : 0;
}

/** Power left to a worn gearbox: all of it down to half condition, then it slips away to a third. */
export function gearboxPower(cond: number): number {
  return cond >= 0.5 ? 1 : 0.33 + 0.67 * clamp(cond / 0.5, 0, 1);
}

/** What the rating of a worn gearbox is: it carries less as it wears. */
export function gearboxRatingNow(rating: number, cond: number): number {
  return rating * (0.4 + 0.6 * clamp(cond, 0, 1));
}
