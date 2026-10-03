import { PARTS, partDef, type VehicleDef } from '../data';
import { slotsOf, type PartItem } from './parts';
import { OIL_CAN, pourOil } from './oil';

/**
 * Things you lift off the ground and carry in your arms: a vehicle part, a can of fuel, a can of oil.
 * Carried, they can go three places: bolted or poured straight onto one of your vehicles, stowed in the
 * trucks for later, or set back down.
 */
export type Carried =
  | { kind: 'part'; item: PartItem }
  /** Fuel in FU: a full can is 5. */
  | { kind: 'fuel'; amount: number }
  /** Oil in sumps: a full can is half of one. */
  | { kind: 'oil'; amount: number };

/** What a full fuel can holds. */
export const FUEL_CAN = 5;

/** Something lying in the world that can be lifted. */
export interface Loose {
  id: string;
  carried: Carried;
  x: number;
  y: number;
  z: number;
}

/** Something lying in the world that is picked up straight into the stockpile: scrap, rations, ammo and the like. */
export interface Goods {
  id: string;
  label: string;
  x: number;
  y: number;
  z: number;
}

export function carriedName(c: Carried): string {
  switch (c.kind) {
    case 'part':
      return partDef(c.item.id).name;
    case 'fuel':
      return `Fuel can (${c.amount.toFixed(1)} FU)`;
    case 'oil':
      return c.amount >= OIL_CAN - 0.01 ? 'Oil can' : `Oil can (${Math.round(c.amount * 200)}% full)`;
  }
}

/** Walking speed multiplier while holding it. Engines are heavy; a tyre is awkward; cans are easy. */
export function carrySlow(c: Carried): number {
  switch (c.kind) {
    case 'part':
      return partDef(c.item.id).slot === 'engine' ? 0.7 : 0.8;
    case 'fuel':
      return 0.84;
    case 'oil':
      return 0.9;
  }
}

/** Seconds to lift something off the floor. */
export function liftSecs(c: Carried): number {
  return c.kind === 'part' ? 0.9 : 0.55;
}

/** The slice of a live vehicle that deciding a fit needs. */
export interface FitTarget {
  def: VehicleDef;
  /** The part now in the slot, if any (its name, for the prompt). */
  fitted: (slot: string) => PartItem | undefined;
  fuel: number;
  tankMax: number;
  oil: number;
}

export interface FitPlan {
  ok: boolean;
  /** The prompt for the hold. */
  label: string;
  secs: number;
}

/** What holding A does with this in hand at that vehicle: bolt it on, pour it in, top the sump up. */
export function planFit(c: Carried, t: FitTarget): FitPlan {
  switch (c.kind) {
    case 'part': {
      const d = partDef(c.item.id);
      if (!slotsOf(t.def).includes(d.slot)) return { ok: false, label: `A ${t.def.name} has no ${PARTS.labels[d.slot].toLowerCase()} mount`, secs: 1 };
      const old = t.fitted(d.slot);
      const mk = old ? partDef(old.id).mk : 0;
      const verb = old ? (d.mk < mk ? 'Swap (downgrade) to' : 'Swap in') : 'Bolt on';
      return { ok: true, label: `${verb} ${d.name}${old ? ` (replaces ${partDef(old.id).name})` : ''}`, secs: d.slot === 'engine' ? 4 : d.slot === 'wheels' ? 3.4 : 2.4 };
    }
    case 'fuel': {
      const space = t.tankMax - t.fuel;
      if (space < 0.3) return { ok: false, label: 'Tank is full', secs: 1 };
      return { ok: true, label: `Pour into the tank (+${Math.min(space, c.amount).toFixed(1)} FU)`, secs: 3 };
    }
    case 'oil': {
      if (t.oil > 0.97) return { ok: false, label: 'Oil is already full', secs: 1 };
      const used = pourOil(t.oil, c.amount).used;
      return { ok: true, label: `Top up the oil (${Math.round((t.oil + used) * 100)}%)`, secs: 2.2 };
    }
  }
}

export interface StowRoom {
  /** Spare-part slots free in the trucks. */
  parts: number;
  /** Reserve oil room, in sumps. */
  oil: number;
}

export interface StowPlan {
  ok: boolean;
  label: string;
}

/** Whether the trucks will take it: parts need a free slot, fuel is always welcome, oil has a reserve limit. */
export function planStow(c: Carried, room: StowRoom): StowPlan {
  switch (c.kind) {
    case 'part':
      return room.parts > 0 ? { ok: true, label: `Stow in the trunk (${room.parts} free)` } : { ok: false, label: 'Trunk is full' };
    case 'fuel':
      return { ok: true, label: 'Add to the reserve cans' };
    case 'oil':
      return room.oil > 0.02 ? { ok: true, label: 'Stow the oil' } : { ok: false, label: 'No room for more oil' };
  }
}

/** Fuel left in the can after pouring into a tank, and what went in. */
export function pourFuel(fuel: number, tankMax: number, amount: number): { used: number; fuel: number; left: number } {
  const used = Math.max(0, Math.min(amount, tankMax - fuel));
  return { used, fuel: fuel + used, left: amount - used };
}
