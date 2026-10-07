import { FOODS, type FoodId } from './food';
import { PARTS, isGlassSlot, isInteriorSlot, mountsFor, partDef, type FuelType, type PartSlot, type VehicleDef } from '../data';
import { RARITY_CSS, describePart, isWorn, slotsOf, type PartItem } from './parts';
import { OIL_CAN, pourOil } from './oil';
import { bayFit, bayText, engineLine, type HoodState } from './engines';
import { fuelMismatch, planPour } from './fuel';
import { colorName } from './paint';
import { pourWater, WATER_CAN } from './fluids';
import { insideRefusal, type InsideRoom } from './cargo';
import { gate, needText, workFor, type Job, type Need, type PanelOpen, type Spot } from './access';

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
  | { kind: 'paint'; color: number; charges: number }
  /** Water in litres: a full can is ten. For the radiator. */
  | { kind: 'water'; amount: number }
  /** Something to eat, carried by hand: a tin of dog food, a lizard caught on the hot ground. Eaten on the spot or stowed. */
  | { kind: 'food'; food: FoodId };

export { FOODS, type FoodId } from './food';

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

/** Which little model stands for a part: an engine block, a radiator core, a tyre, or the general parts crate. */
export function partModelKey(id: string): string {
  const d = partDef(id);
  // Every cabin part has a model of its own (`render/partModels.ts`), not one per quality.
  if (isInteriorSlot(d.slot)) return `part:${id}`;
  // Panes of glass have a model each too.
  if (isGlassSlot(d.slot)) return `part:${id}`;
  // Every engine has a model of its own, drawn from its spec (`render/engineModels.ts`).
  if (d.slot === 'engine') return `part:${id}`;
  // The trike's whole wheels and the lift kit have models of their own (`render/trikeModel.ts`).
  if (id === 'tyre_trike' || id === 'tyre_trike_r' || id === 'sus_lift' || id === 'rr_rickshaw') return `part:${id}`;
  const mk = Math.min(3, Math.max(1, d.stock ? 1 : d.mk));
  const KEY: Partial<Record<PartSlot, string>> = {
    engine: 'engine',
    cooling: 'radiator',
    wheels: 'tyre',
    gearbox: 'gear',
    suspension: 'spring',
    brakes: 'brake',
    exhaust: 'pipe',
    hood: 'hood',
    doorL: 'door',
    doorR: 'door',
  };
  return `${KEY[d.slot] ?? 'part'}${mk}`;
}

/** Which little model stands for a carried thing, in the arms and in flight. */
export function carryModelKey(c: Carried): string {
  if (c.kind === 'part') return /^part\d$/.test(partModelKey(c.item.id)) ? `part:${c.item.id}` : partModelKey(c.item.id);
  if (c.kind === 'fuel') return c.fuel === 'diesel' ? 'diesel' : 'fuel';
  if (c.kind === 'paint') return `paint:${c.color.toString(16)}`;
  if (c.kind === 'food') return `food:${c.food}`;
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
  if (isGlassSlot(d.slot) && !d.empty) lines.push({ text: it.cond >= 0.8 ? 'Whole' : it.cond >= 0.4 ? 'Cracked' : 'Crazed with cracks', css: it.cond >= 0.8 ? '#c8f0b8' : it.cond >= 0.4 ? '#ffcf6a' : '#ff8a6a' });
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
    case 'water':
      return [{ text: 'Water can', css: '#8ecbff' }, { text: `${c.amount.toFixed(1)} L` }, { text: 'For the radiator' }];
    case 'paint':
      return [{ text: 'Spray can', css: `#${c.color.toString(16).padStart(6, '0')}` }, { text: colorName(c.color) }, { text: `${c.charges} panel${c.charges === 1 ? '' : 's'} left` }];
    case 'food':
      return foodLines(c.food);
  }
}

/** The tag over something to eat: its name, then what it does for hunger and health. */
export function foodLines(food: FoodId): InspectLine[] {
  const f = FOODS[food];
  return [{ text: f.name, css: '#f0e2c0' }, { text: `Hunger -${f.hunger}`, css: '#ffd27a' }, { text: `Health +${f.health}`, css: '#c8f0b8' }];
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
    case 'water':
      return c.amount >= WATER_CAN - 0.05 ? 'Water can' : `Water can (${c.amount.toFixed(1)} L)`;
    case 'food':
      return FOODS[c.food].name;
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
    case 'water':
      return 0.8;
    case 'food':
      return 0.98;
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
  /** The part at the very mount the player is standing at (one wheel, one door), when that is known: null for a bare mount. */
  current?: { id: string } | null;
  fuel: number;
  tankMax: number;
  oil: number;
  /** What the tank holds, and what the engine in the bay burns. Both default to petrol. */
  tank?: FuelType;
  engine?: FuelType;
  /** The cooling system: water in it (0..1) and its size in litres, and the sump size in litres. */
  coolant?: number;
  coolantL?: number;
  sumpL?: number;
  /**
   * Where the player stands and what is open (see `sim/access.ts`). With it a job that has to be done somewhere else, or
   * behind a panel that is shut, is refused with the reason in `need`. Left out, a job is allowed anywhere.
   */
  access?: { at: Spot | null; open: PanelOpen; /** The mount a part is going into (a door fits either side). */ mount?: PartSlot };
}

export interface FitPlan {
  ok: boolean;
  /** The prompt for the hold. */
  label: string;
  secs: number;
  /** Why it cannot be done yet: go somewhere, open something, take the old part off. */
  need?: Need;
}

/** The job as a mechanic would say it, for "Go to the engine bay to ...". */
function verbOf(c: Carried): string {
  switch (c.kind) {
    case 'part':
      return `fit ${partDef(c.item.id).name}`;
    case 'fuel':
      return 'pour the fuel in';
    case 'oil':
      return 'top up the oil';
    case 'water':
      return 'top up the radiator';
    case 'paint':
      return 'spray it';
    case 'food':
      return 'eat it';
  }
}

/** What holding A does with this in hand at that vehicle: bolt it on, pour it in, top the sump up. */
export function planFit(c: Carried, t: FitTarget): FitPlan {
  if (c.kind === 'part') {
    const d = partDef(c.item.id);
    if (!mountsFor(d.slot).some((m) => slotsOf(t.def).includes(m))) return { ok: false, label: `A ${t.def.name} has no ${PARTS.labels[d.slot].toLowerCase()} mount`, secs: 1 };
  }
  if (c.kind === 'food') return { ok: false, label: `${FOODS[c.food].name} does not go on a ${t.def.name}: put it in, or eat it`, secs: 1 };
  if (t.access && c.kind !== 'paint') {
    const job: Job = c.kind === 'part' ? t.access.mount ?? partDef(c.item.id).slot : c.kind;
    const g = gate(t.def, job, t.access.at, t.access.open);
    if (!g.ok && g.need) return { ok: false, label: needText(t.def, g.need, verbOf(c)), secs: 1, need: g.need };
  }
  switch (c.kind) {
    case 'part': {
      const d = partDef(c.item.id);
      // A door's window goes in a door that is on and has a window to put it in.
      const glassMount = t.access?.mount ?? d.slot;
      if ((glassMount === 'glassL' || glassMount === 'glassR') && !d.empty) {
        const door = glassMount === 'glassL' ? 'doorL' : 'doorR';
        const dd = slotsOf(t.def).includes(door) ? t.fitted(door) : undefined;
        if (slotsOf(t.def).includes(door) && (!dd || partDef(dd.id).empty || partDef(dd.id).window === false)) {
          return { ok: false, label: `The ${glassMount === 'glassL' ? 'left' : 'right'} door has no window frame: fit a door with a window first`, secs: 1 };
        }
      }
      const old = t.current === undefined ? t.fitted(d.slot) : t.current ?? undefined;
      // A panel (the bonnet, a door) is not swapped in place: the old one comes off first.
      const mount = t.access?.mount ?? d.slot;
      if (old && !partDef(old.id).empty && workFor(t.def, mount)?.swap === false && (mount === 'hood' || mount === 'doorL' || mount === 'doorR')) {
        const need: Need = { kind: 'free', panel: mount };
        return { ok: false, label: needText(t.def, need), secs: 1, need };
      }
      const mk = old ? partDef(old.id).mk : 0;
      const verb = old ? (d.stock || old && partDef(old.id).stock ? 'Swap in' : d.mk < mk ? 'Swap (downgrade) to' : 'Swap in') : 'Bolt on';
      let spec = d.engine && !d.empty ? `  ·  ${engineLine(d.engine)}` : '';
      if (d.engine && !d.empty) {
        // Say honestly whether it goes under the bonnet.
        const hid = t.fitted('hood')?.id;
        const hood: HoodState = hid === 'hood_cut' ? 'cut' : hid && partDef(hid).empty ? 'off' : 'closed';
        const bay = bayFit(t.def, d.engine, hood);
        if (!bay.fitsClosed && slotsOf(t.def).includes('hood') && hood !== 'off') spec += `  ·  ${bayText(bay.label, hood)}`;
        else if (!bay.fitsClosed && !slotsOf(t.def).includes('hood')) spec += '  ·  Too big for the frame: it hangs out in the open';
      }
      return { ok: true, label: `${verb} ${d.name}${old ? ` (replaces ${partDef(old.id).name})` : ''}${spec}`, secs: d.slot === 'engine' ? 4 : d.slot === 'wheels' ? 2.6 : d.slot === 'gearbox' ? 3.6 : d.slot === 'cooling' ? 3 : 2.4 };
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
      const std = (t.sumpL ?? 3) / 3;
      const used = pourOil(t.oil, c.amount, t.sumpL).used;
      return { ok: true, label: `Top up the oil (${Math.round((t.oil + used / std) * 100)}%)`, secs: 2.2 };
    }
    case 'water': {
      const have = t.coolant ?? 1;
      if (have > 0.97) return { ok: false, label: 'The cooling system is full', secs: 1 };
      const r = pourWater(have, c.amount, t.coolantL ?? 6);
      return { ok: true, label: `Top up the radiator (${Math.round(have * 100)}% → ${Math.round(r.coolant * 100)}%)`, secs: 2.6 };
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
  /** Reserve water room, in litres. */
  water?: number;
  /** Room inside the vehicle being stowed into (`sim/cargo.ts`): a part has to fit its footprint. Left out, only the convoy total counts. */
  inside?: InsideRoom;
}

export interface StowPlan {
  ok: boolean;
  label: string;
  /** Why it cannot be stowed here yet: the boot is shut, or you are not at it. */
  need?: Need;
}

/**
 * Whether the trucks will take it: parts need a free slot, fuel is always welcome, oil has a reserve limit. With `access` it
 * also has to be put in at the boot with the lid open, or through an open door at the back seat.
 */
export function planStow(c: Carried, room: StowRoom, access?: { def: VehicleDef; at: Spot | null; open: PanelOpen }): StowPlan {
  if (access && c.kind !== 'paint') {
    const g = gate(access.def, 'stow', access.at, access.open);
    if (!g.ok && g.need) return { ok: false, label: needText(access.def, g.need, 'stow it'), need: g.need };
  }
  switch (c.kind) {
    case 'part': {
      if (room.inside && access) {
        const why = insideRefusal(c, room.inside, access.def);
        if (why) return { ok: false, label: why };
      }
      if (room.parts <= 0) return { ok: false, label: 'Trunk is full' };
      const where = room.inside ? `in the ${room.inside.name}` : 'in the trunk';
      return { ok: true, label: room.inside ? `Stow ${where}: secure at any speed (${room.inside.free} units free)` : `Stow in the trunk (${room.parts} free)` };
    }
    case 'fuel':
      return { ok: true, label: 'Add to the reserve cans' };
    case 'oil':
      return room.oil > 0.02 ? { ok: true, label: 'Stow the oil' } : { ok: false, label: 'No room for more oil' };
    case 'water':
      return (room.water ?? 0) > 0.5 ? { ok: true, label: 'Stow the water' } : { ok: false, label: 'No room for more water' };
    case 'paint':
      return { ok: false, label: 'Spray cans stay on the road' };
    case 'food':
      return { ok: true, label: `Stow ${FOODS[c.food].name.toLowerCase()} with the rations` };
  }
}

/** Fuel left in the can after pouring into a tank, and what went in. */
export function pourFuel(fuel: number, tankMax: number, amount: number): { used: number; fuel: number; left: number } {
  const used = Math.max(0, Math.min(amount, tankMax - fuel));
  return { used, fuel: fuel + used, left: amount - used };
}
