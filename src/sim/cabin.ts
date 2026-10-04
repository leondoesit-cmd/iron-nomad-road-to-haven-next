import { INTERIOR_SLOTS, PARTS, partDef, type PartDef, type PartSlot, type PartStats, type VehicleDef } from '../data';
import { factoryIdFor } from './drivetrain';
import type { Fit } from './parts';

/**
 * The cabin: driver, passenger and rear seats, the steering wheel and the dashboard. They are parts like the doors and
 * the bonnet: each has a factory version, aftermarket versions, and an empty placeholder (`seat_none`, `bench_none`,
 * `steer_none`, `dash_none`) for a mount that has been stripped. A car that is missing one really is: it shows the gap and
 * behaves worse (the rules are in `parts.json` `interior`).
 */

/** The part in a cabin mount: what is fitted, else the factory part. Null when the chassis has no such mount. */
export function cabinPart(def: VehicleDef, fit: Fit, slot: PartSlot): PartDef | null {
  const fitted = fit[slot];
  if (fitted) return partDef(fitted.id);
  const id = factoryIdFor(def, slot);
  return id ? partDef(id) : null;
}

/** True when the chassis has this mount and nothing is in it. */
export const cabinGap = (def: VehicleDef, fit: Fit, slot: PartSlot): boolean => !!cabinPart(def, fit, slot)?.empty;

export interface CabinGaps {
  steer: boolean;
  seatD: boolean;
  seatP: boolean;
  seatR: boolean;
  dash: boolean;
}

export function cabinGaps(def: VehicleDef, fit: Fit): CabinGaps {
  return { steer: cabinGap(def, fit, 'steer'), seatD: cabinGap(def, fit, 'seatD'), seatP: cabinGap(def, fit, 'seatP'), seatR: cabinGap(def, fit, 'seatR'), dash: cabinGap(def, fit, 'dash') };
}

/** How many of the cabin's mounts are empty. */
export const gapCount = (g: CabinGaps): number => Number(g.steer) + Number(g.seatD) + Number(g.seatP) + Number(g.seatR) + Number(g.dash);

/** Stat keys a seat contributes. The driver's seat gives everything but cargo; the passenger's and rear seats only armour and room. */
const SEAT_KEYS: Partial<Record<PartSlot, (k: keyof PartStats) => boolean>> = {
  seatD: (k) => k !== 'cargo',
  seatP: (k) => k === 'cargo' || k === 'armor' || k === 'armorS' || k === 'armorR' || k === 'armorF',
  seatR: (k) => k === 'cargo' || k === 'armor' || k === 'armorS' || k === 'armorR' || k === 'armorF',
};

/** Does a part in this cabin slot contribute this stat? (Everything outside the cabin does.) */
export function cabinStatCounts(slot: PartSlot, k: keyof PartStats): boolean {
  const f = SEAT_KEYS[slot];
  return f ? f(k) : true;
}

export interface CabinEffects {
  /** Steering lock multiplier: 1 stock, tiny with no wheel, a bit more with a quick one. */
  steerMult: number;
  /** Grip multiplier from sitting on the floor (1 stock). */
  seatGrip: number;
  /** Gun spread multiplier for whoever shoots from the driver's seat (1 stock). */
  spread: number;
  /** How far the driver sits lower than a seat would put them, metres. */
  drop: number;
}

/** What the cabin does to the vehicle's driving. */
export function cabinEffects(def: VehicleDef, fit: Fit, steerStat: number): CabinEffects {
  const g = cabinGaps(def, fit);
  const r = PARTS.interior;
  return {
    steerMult: g.steer ? r.noSteerLock : Math.max(0.5, 1 + steerStat),
    seatGrip: g.seatD ? r.noSeatGrip : 1,
    spread: g.seatD ? r.noSeatSpread : 1,
    drop: g.seatD ? r.noSeatDrop : 0,
  };
}

/** Can a second person ride beside the driver? A bed gun has its own post; a cab needs a passenger seat in the mount. */
export function canRidePassenger(def: VehicleDef, fit: Fit, bedGun: boolean): boolean {
  if (bedGun || !def.seat) return true;
  return !cabinGap(def, fit, 'seatP');
}

export { INTERIOR_SLOTS };
