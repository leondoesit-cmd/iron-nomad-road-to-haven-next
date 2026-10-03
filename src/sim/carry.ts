import { PARTS, partDef, type FuelType, type VehicleDef } from '../data';
import { RARITY_CSS, describePart, isWorn, slotsOf, type PartItem } from './parts';
import { OIL_CAN, pourOil } from './oil';
import { engineLine } from './engines';
import { fuelMismatch, planPour } from './fuel';
import { colorName } from './paint';

/**
 * Things you lift off the ground and carry in your arms: a vehicle part, a can of fuel, a can of oil.
 * Carried, they can go three places: bolted or poured straight onto one of your vehicles, stowed in the
 * trucks for later, or set back down.
 */
export type Carried =
  | { kind: 'part'; item: PartItem }
  /** Fuel in FU: a full can is 5. A can with no type is petrol. */
  | { kind: 'fuel'; amount: number; fuel?: FuelType }
  /** Oil in sumps: a full can is half of one. */
  | { kind: 'oil'; amount: number }
  /** A spray can: a colour and how many panels it has left in it. */
  | { kind: 'paint'; color: number; charges: number };

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

/** Which little model stands for a part: an engine block, a radiator core, a tyre, or the general parts crate. */
export function partModelKey(id: string): string {
  const d = partDef(id);
  const mk = Math.min(3, Math.max(1, d.stock ? 1 : d.mk));
  return d.slot === 'engine' ? `engine${mk}` : d.slot === 'cooling' ? `radiator${mk}` : d.slot === 'wheels' ? `tyre${mk}` : `part${mk}`;
}

/** Which little model stands for a carried thing, in the arms and in flight. */
export function carryModelKey(c: Carried): string {
  if (c.kind === 'part') return partModelKey(c.item.id);
  if (c.kind === 'fuel') return c.fuel === 'diesel' ? 'diesel' : 'fuel';
  if (c.kind === 'paint') return `paint:${c.color.toString(16)}`;
  return c.kind;
}

export interface InspectLine {
  text: string;
  css?: string;
}

/** The tag over a part you are looking at: name, how worn it is, and the one number that matters. */
export function partInspect(it: PartItem): InspectLine[] {
  const d = partDef(it.id);
  const lines: InspectLine[] = [{ text: d.name, css: RARITY_CSS[d.stock ? 1 : d.mk] }];
  if (isWorn(d.slot)) {
    const pct = Math.round(it.cond * 100);
    lines.push({ text: `${pct} %`, css: pct < 35 ? '#ff8a6a' : pct < 70 ? '#ffcf6a' : '#c8f0b8' });
  }
  const info = describePart(d);
  if (d.engine && !d.empty) lines.push({ text: `${engineLine(d.engine)}` });
  else if (d.cooling !== undefined && !d.empty) lines.push({ text: `Cooling - ${Math.round(d.cooling)} kW` });
  else if (info.length) lines.push({ text: info.slice(0, 2).join(' · ') });
  return lines;
}

/** The same for anything you can lift. */
export function inspectLines(c: Carried): InspectLine[] {
  switch (c.kind) {
    case 'part':
      return partInspect(c.item);
    case 'fuel':
      return [{ text: `${c.fuel === 'diesel' ? 'Diesel' : 'Petrol'} can`, css: c.fuel === 'diesel' ? '#f0d050' : '#ff9a7a' }, { text: `${c.amount.toFixed(1)} FU` }, { text: c.fuel === 'diesel' ? 'For diesel engines' : 'For petrol engines' }];
    case 'oil':
      return [{ text: 'Oil can', css: '#e6dcc0' }, { text: `${Math.round(c.amount * 200)} % full` }];
    case 'paint':
      return [{ text: 'Spray can', css: `#${c.color.toString(16).padStart(6, '0')}` }, { text: colorName(c.color) }, { text: `${c.charges} panel${c.charges === 1 ? '' : 's'} left` }];
  }
}

export function carriedName(c: Carried): string {
  switch (c.kind) {
    case 'part':
      return partDef(c.item.id).name;
    case 'fuel':
      return `${c.fuel === 'diesel' ? 'Diesel' : 'Petrol'} can (${c.amount.toFixed(1)} FU)`;
    case 'oil':
      return c.amount >= OIL_CAN - 0.01 ? 'Oil can' : `Oil can (${Math.round(c.amount * 200)}% full)`;
    case 'paint':
      return `Spray can (${colorName(c.color)}, ${c.charges} left)`;
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
    case 'paint':
      return 0.96;
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
  fitted: (slot: string) => { id: string } | undefined;
  fuel: number;
  tankMax: number;
  oil: number;
  /** What the tank holds, and what the engine in the bay burns. Both default to petrol. */
  tank?: FuelType;
  engine?: FuelType;
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
      const verb = old ? (d.stock || old && partDef(old.id).stock ? 'Swap in' : d.mk < mk ? 'Swap (downgrade) to' : 'Swap in') : 'Bolt on';
      const spec = d.engine && !d.empty ? `  ·  ${engineLine(d.engine)}` : '';
      return { ok: true, label: `${verb} ${d.name}${old ? ` (replaces ${partDef(old.id).name})` : ''}${spec}`, secs: d.slot === 'engine' ? 4 : d.slot === 'wheels' ? 3.4 : d.slot === 'cooling' ? 3 : 2.4 };
    }
    case 'fuel': {
      const kind = c.fuel ?? 'petrol';
      const tank = t.tank ?? 'petrol';
      const plan = planPour(tank, t.fuel, kind);
      if (!plan.ok) return { ok: false, label: plan.note, secs: 1 };
      // A dry tank switches to the can's fuel, so the space is the whole tank.
      const space = t.tankMax - (plan.tank === tank ? t.fuel : 0);
      if (space < 0.3) return { ok: false, label: 'Tank is full', secs: 1 };
      const wrong = fuelMismatch(t.engine ?? 'petrol', plan.tank, 1);
      const warn = wrong ? `  ·  the engine runs ${t.engine ?? 'petrol'}: it will not start` : plan.note ? `  ·  ${plan.note}` : '';
      return { ok: true, label: `Pour ${kind} into the tank (+${Math.min(space, c.amount).toFixed(1)} FU)${warn}`, secs: 3 };
    }
    case 'oil': {
      if (t.oil > 0.97) return { ok: false, label: 'Oil is already full', secs: 1 };
      const used = pourOil(t.oil, c.amount).used;
      return { ok: true, label: `Top up the oil (${Math.round((t.oil + used) * 100)}%)`, secs: 2.2 };
    }
    case 'paint':
      return { ok: true, label: 'Spray the panel', secs: 2 };
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
    case 'paint':
      return { ok: false, label: 'Spray cans stay on the road' };
  }
}

/** Fuel left in the can after pouring into a tank, and what went in. */
export function pourFuel(fuel: number, tankMax: number, amount: number): { used: number; fuel: number; left: number } {
  const used = Math.max(0, Math.min(amount, tankMax - fuel));
  return { used, fuel: fuel + used, left: amount - used };
}
