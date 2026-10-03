import { FIT_SLOTS, PARTS, chassisDef, mountsFor, partDef, type Cost, type FuelType, type PartSlot, type Stocks, type VehicleDef } from '../data';
import { clamp } from '../core/math';
import { newHealth, type VehicleHealth } from './damage';
import { OIL_CRITICAL, OIL_LOW } from './oil';
import { effectiveStats, mkOf, newPart, newUid, slotsOf, type Fit, type PartItem, type Stats, type Tyres } from './parts';
import { fuelOf, stockEngineSpec } from './engines';
import { factoryIdFor } from './drivetrain';
import { COOLANT_LOW } from './fluids';
import { fuelMismatch } from './fuel';
import type { PanelPaint } from './paint';

/** The two player colours, repeated here so the sim stays free of render imports. */
export const PLAYER_PAINT = [0xff8a1f, 0x2f9bff] as const;

export const GARAGE_MAX = 6;
export const INVENTORY_BASE = 16;

/** Condition of every damageable component, stored as plain numbers so it saves cleanly. */
export interface BuildComp {
  engine: number;
  tires: number[];
  tank: number;
  mount: number;
  plates: number;
  /** Engine oil, 0..1. */
  oil: number;
  /** Radiator condition, 0..1. A holed core sheds less heat. */
  radiator: number;
  /** Gearbox condition, 0..1. It wears when the engine makes more than it can carry. */
  gearbox: number;
  /** Water in the cooling system, 0..1 of its capacity. */
  coolant: number;
  leaking: boolean;
}

/** One specific vehicle: a chassis, what is bolted to it, how it looks and what state it is in. */
export interface VehicleBuild {
  uid: string;
  chassis: string;
  paint: number;
  /** Index into PARTS.stripes. */
  stripe: number;
  stripeColor: number;
  /** Panels sprayed a different colour from `paint`. */
  panels?: PanelPaint;
  /** Picks the body variant and the small details (dents, missing trim) so no two found cars look alike. */
  seed: number;
  fit: Fit;
  /** The tyre on each wheel. `null` is the tyre the chassis was built with; a `tyre_none` item is a bare hub. */
  tyres: Tyres;
  /** Fraction of max hit points. */
  hp: number;
  comp: BuildComp;
  /** Fraction of the tank. */
  fuel: number;
  /** What the tank holds. Swapping to an engine that burns the other fuel leaves this behind until it is drained. */
  tank: FuelType;
}

export function freshComp(def: VehicleDef): BuildComp {
  return { engine: 1, tires: new Array(def.physics.wheelCount).fill(1), tank: 1, mount: 1, plates: 1, oil: 1, radiator: 1, gearbox: 1, coolant: 1, leaking: false };
}

export function newBuild(chassis: string, o: Partial<Pick<VehicleBuild, 'paint' | 'seed' | 'stripe' | 'stripeColor' | 'fuel' | 'hp'>> = {}): VehicleBuild {
  const def = chassisDef(chassis);
  const seed = o.seed ?? Math.floor(Math.random() * 1e6);
  return {
    uid: newUid('v'),
    chassis,
    paint: o.paint ?? PARTS.paints[seed % PARTS.paints.length].c,
    stripe: o.stripe ?? 0,
    stripeColor: o.stripeColor ?? 0xe9dfc7,
    seed,
    fit: {},
    tyres: new Array(def.physics.wheelCount).fill(null),
    hp: o.hp ?? 1,
    comp: freshComp(def),
    fuel: o.fuel ?? 1,
    tank: stockEngineSpec(def).fuel,
  };
}

export function defOf(b: VehicleBuild): VehicleDef {
  return chassisDef(b.chassis);
}
export function statsOf(b: VehicleBuild): Stats {
  return effectiveStats(defOf(b), b.fit, b.tyres);
}
export function maxHpOf(b: VehicleBuild): number {
  return defOf(b).hp * statsOf(b).hpMult;
}
export function buildName(b: VehicleBuild): string {
  return defOf(b).name;
}

// ---------------------------------------------------------------- health bridge

/** Live health for a vehicle that is about to be spawned. */
export function toHealth(b: VehicleBuild): VehicleHealth {
  const def = defOf(b);
  const st = statsOf(b);
  const maxHp = def.hp * st.hpMult;
  const h = newHealth(maxHp, st.armor, def.physics.wheelCount);
  h.hp = Math.max(0.01, b.hp) * maxHp;
  h.comp = { engine: b.comp.engine, tires: [...b.comp.tires], tank: b.comp.tank, mount: b.comp.mount, plates: b.comp.plates, oil: b.comp.oil ?? 1, radiator: b.comp.radiator ?? 1, gearbox: b.comp.gearbox ?? 1, coolant: b.comp.coolant ?? 1 };
  h.leaking = b.comp.leaking;
  h.armorBonus = { front: st.armorF, side: st.armorS, rear: st.armorR };
  h.engineExposed = st.hoodOff;
  return h;
}

/** Write a vehicle's current condition back to its build. */
export function fromHealth(b: VehicleBuild, h: VehicleHealth, fuelFrac: number) {
  b.hp = clamp(h.hp / h.maxHp, 0, 1);
  b.comp = { engine: h.comp.engine, tires: [...h.comp.tires], tank: h.comp.tank, mount: h.comp.mount, plates: h.comp.plates, oil: h.comp.oil, radiator: h.comp.radiator ?? 1, gearbox: h.comp.gearbox ?? 1, coolant: h.comp.coolant ?? 1, leaking: h.leaking };
  b.fuel = clamp(fuelFrac, 0, 1);
}

// ---------------------------------------------------------------- parts

/** The part in a slot with its condition read off the vehicle, as it would come out. */
export function currentCond(b: VehicleBuild, slot: PartSlot): number {
  switch (slot) {
    case 'engine':
      return b.comp.engine;
    case 'cooling':
      return b.comp.radiator ?? 1;
    case 'gearbox':
      return b.comp.gearbox ?? 1;
    case 'wheels':
      return b.comp.tires.reduce((a, c) => a + c, 0) / Math.max(1, b.comp.tires.length);
    case 'armor':
      return b.comp.plates;
    default:
      return 1;
  }
}

function setComp(b: VehicleBuild, slot: PartSlot, cond: number) {
  if (slot === 'engine') b.comp.engine = cond;
  else if (slot === 'cooling') b.comp.radiator = cond;
  else if (slot === 'gearbox') b.comp.gearbox = cond;
  else if (slot === 'armor') b.comp.plates = cond;
}

/** The factory part a chassis was built with in a slot, if the slot has one. */
function stockPartId(def: VehicleDef, slot: PartSlot): string | undefined {
  return slot === 'engine' ? def.stockEngine : slot === 'cooling' ? def.stockRadiator : factoryIdFor(def, slot);
}

/** What the "empty" placeholder for a stripped mount is called in the catalogue. */
const EMPTY_ID: Partial<Record<PartSlot, string>> = {
  engine: 'eng_none',
  cooling: 'rad_none',
  gearbox: 'gbx_none',
  exhaust: 'exh_none',
  suspension: 'sus_none',
  brakes: 'brk_none',
  hood: 'hood_none',
  doorL: 'door_none',
  doorR: 'door_none',
};

/** Slots a part can be taken off and left empty: everything that has a factory part or a placeholder. */
export const REMOVABLE: PartSlot[] = FIT_SLOTS.filter((s) => EMPTY_ID[s]);

/**
 * The part sitting in a slot as something you could carry: what is fitted, or the factory part when nothing has been
 * swapped in. Null for an empty mount or a slot with nothing to pull. Tyres are one per wheel: see `tyreAt`.
 */
export function partInSlot(b: VehicleBuild, slot: PartSlot): PartItem | null {
  if (slot === 'wheels') return null;
  const fitted = b.fit[slot];
  if (fitted) return partDef(fitted.id).empty ? null : { ...fitted, cond: currentCond(b, slot) };
  const id = stockPartId(defOf(b), slot);
  return id ? newPart(id, currentCond(b, slot)) : null;
}

/** Which part sits in a slot (fitted, or the factory one), without making an item of it. Null for an empty mount. */
export function idInSlot(b: VehicleBuild, slot: PartSlot): string | null {
  if (slot === 'wheels') return tyreIdAt(b, 0);
  const fitted = b.fit[slot];
  if (fitted) return partDef(fitted.id).empty ? null : fitted.id;
  return stockPartId(defOf(b), slot) ?? null;
}

// ---------------------------------------------------------------- tyres

const tyreNone = () => newPart('tyre_none', 1);

/** Which tyre is on a wheel: fitted, or the factory one. Null for a bare hub. */
export function tyreIdAt(b: VehicleBuild, i: number): string | null {
  const t = b.tyres[i];
  if (t) return partDef(t.id).empty ? null : t.id;
  return `tyre_${b.chassis}`;
}

/** The tyre on a wheel as something you could carry, wearing what it wears now. */
export function tyreAt(b: VehicleBuild, i: number): PartItem | null {
  const id = tyreIdAt(b, i);
  if (!id) return null;
  const cond = b.comp.tires[i] ?? 1;
  const t = b.tyres[i];
  return t ? { ...t, cond } : newPart(id, cond);
}

export interface InstallResult {
  ok: boolean;
  reason?: string;
  /** The part that was swapped out, now carrying the wear it had on the car. */
  removed?: PartItem;
  /** Something worth saying about the result: the bay is cramped, the tank has the wrong fuel in it. */
  note?: string;
}

/** Fit a tyre to one wheel. The tyre that was there comes back with its wear. */
export function installTyre(b: VehicleBuild, i: number, item: PartItem): InstallResult {
  const d = partDef(item.id);
  if (d.slot !== 'wheels' || d.empty) return { ok: false, reason: 'That is not a tyre' };
  if (i < 0 || i >= b.tyres.length) return { ok: false, reason: 'No such wheel' };
  const removed = tyreAt(b, i) ?? undefined;
  b.tyres[i] = item;
  b.comp.tires[i] = item.cond > 0.02 ? item.cond : 0;
  return { ok: true, removed };
}

/** Take a tyre off a wheel, leaving a bare hub. A worn factory tyre never comes off better than it was. */
export function removeTyre(b: VehicleBuild, i: number): PartItem | null {
  const out = tyreAt(b, i);
  if (!out) return null;
  b.tyres[i] = tyreNone();
  b.comp.tires[i] = 0;
  return out;
}

// ---------------------------------------------------------------- fitting

/**
 * Bolt a part on. Whatever was in the mount comes back with its current wear. Say which mount when there is a choice:
 * a wheel number for a tyre, `doorL` or `doorR` for a door. A tyre with no wheel named goes on every wheel (a set).
 */
export function installPart(b: VehicleBuild, item: PartItem, at?: PartSlot | number): InstallResult {
  const d = partDef(item.id);
  const cat = d.slot;
  const def = defOf(b);
  if (d.empty) return { ok: false, reason: 'That is a gap, not a part' };
  if (cat === 'wheels') {
    if (!slotsOf(def).includes('wheels')) return { ok: false, reason: `A ${def.name} has no wheels to fit` };
    if (typeof at === 'number') return installTyre(b, at, item);
    let removed: PartItem | undefined;
    b.tyres.forEach((_, i) => {
      const r = installTyre(b, i, i === 0 ? item : { ...item, uid: newUid('p') });
      if (i === 0) removed = r.removed;
    });
    return { ok: true, removed };
  }
  const options = mountsFor(cat).filter((m) => slotsOf(def).includes(m));
  if (!options.length) return { ok: false, reason: `A ${def.name} has no ${PARTS.labels[cat].toLowerCase()} mount` };
  const slot = typeof at === 'string' && options.includes(at) ? at : options.find((m) => !idInSlot(b, m)) ?? options[0];
  const removed = partInSlot(b, slot) ?? undefined;
  b.fit[slot] = item;
  setComp(b, slot, item.cond);
  let note: string | undefined;
  if (slot === 'engine') {
    const mismatch = fuelMismatch(fuelOf(def, b.fit), b.tank, b.fuel);
    if (mismatch) note = `${mismatch}. Drain the tank with the jerrycan.`;
  }
  return { ok: true, removed, note };
}

/** Pull a part off. Stock components under it are worn: they never come back better than STOCK. */
export function removePart(b: VehicleBuild, slot: PartSlot): PartItem | null {
  const out = partInSlot(b, slot);
  if (!out) return null;
  const empty = EMPTY_ID[slot];
  if (empty) b.fit[slot] = newPart(empty, 1);
  else delete b.fit[slot];
  const stock = PARTS.stockCondition;
  if (slot === 'engine') b.comp.engine = Math.min(b.comp.engine, stock);
  else if (slot === 'cooling') b.comp.radiator = Math.min(b.comp.radiator ?? 1, stock);
  else if (slot === 'gearbox') b.comp.gearbox = Math.min(b.comp.gearbox ?? 1, stock);
  else if (slot === 'armor') b.comp.plates = Math.min(b.comp.plates, stock);
  return out;
}

// ---------------------------------------------------------------- servicing

/** Cost of a full workshop service: every component and the hull. */
export function serviceCost(b: VehicleBuild): Cost {
  const def = defOf(b);
  const missing = 1 - b.hp;
  let scrap = Math.ceil(missing * (10 + 10 * def.tier + def.hp / 40));
  let parts = 0;
  if (b.comp.engine < 0.999) parts += Math.ceil((1 - b.comp.engine) * 6);
  if (b.comp.mount < 0.999) parts += 2;
  scrap += b.comp.tires.filter((t) => t < 0.999).length * 2;
  if (b.comp.leaking) scrap += 1;
  // A service is an oil change too.
  if (b.comp.oil < 0.9) scrap += Math.ceil((1 - b.comp.oil) * 2);
  if (b.comp.plates < 0.999) scrap += Math.ceil((1 - b.comp.plates) * 4);
  if ((b.comp.radiator ?? 1) < 0.999) scrap += Math.ceil((1 - b.comp.radiator) * 5);
  if ((b.comp.gearbox ?? 1) < 0.999) parts += Math.ceil((1 - b.comp.gearbox) * 5);
  // Topping up the coolant is part of a service too.
  if ((b.comp.coolant ?? 1) < 0.9) scrap += 1;
  const c: Cost = {};
  if (scrap) c.scrap = scrap;
  if (parts) c.parts = parts;
  return c;
}

export function serviceBuild(b: VehicleBuild) {
  b.hp = 1;
  b.comp = freshComp(defOf(b));
  // Keep any worn part's own limit: a service restores components, not the parts' history.
}

export function needsService(b: VehicleBuild): boolean {
  return b.hp < 0.995 || b.comp.engine < 0.999 || b.comp.mount < 0.999 || b.comp.plates < 0.999 || (b.comp.radiator ?? 1) < 0.999 || (b.comp.gearbox ?? 1) < 0.999 || (b.comp.coolant ?? 1) < 0.9 || b.comp.oil < 0.9 || b.comp.leaking || b.comp.tires.some((t) => t < 0.999);
}

// ---------------------------------------------------------------- break down and rebuild

/** What breaking a whole vehicle down yields: its fitted parts come back worn, plus raw scrap and parts. */
export function dismantleYield(b: VehicleBuild): { stocks: Partial<Stocks>; items: PartItem[] } {
  const def = defOf(b);
  const items: PartItem[] = [];
  // Fitted parts come back worn, and so do the factory ones: engine, radiator, gearbox, tyres and the rest are real parts.
  for (const slot of FIT_SLOTS) {
    const it = partInSlot(b, slot);
    if (it) items.push(it);
  }
  for (let i = 0; i < b.tyres.length; i++) {
    const t = tyreAt(b, i);
    if (t) items.push(t);
  }
  const frac = 0.55 + 0.45 * b.hp;
  return { stocks: { scrap: Math.round((6 + def.hp / 14 + def.tier * 4) * frac), parts: Math.round((2 + def.physics.mass / 260) * frac) }, items };
}

/** Rebuild a build onto a different chassis (the Tier chain). Parts that do not fit are returned. */
export function rebuildOnto(b: VehicleBuild, chassis: string): PartItem[] {
  const def = chassisDef(chassis);
  const spill: PartItem[] = [];
  for (const slot of Object.keys(b.fit) as PartSlot[]) {
    const it = b.fit[slot];
    if (!it) continue;
    if (!slotsOf(def).includes(slot)) {
      if (!partDef(it.id).empty) spill.push({ ...it, cond: currentCond(b, slot) });
      delete b.fit[slot];
    }
  }
  // Tyres that were fitted come off; the new frame starts on its own.
  b.tyres.forEach((t, i) => {
    if (t && !partDef(t.id).empty) spill.push({ ...t, cond: b.comp.tires[i] ?? 1 });
  });
  b.tyres = new Array(def.physics.wheelCount).fill(null);
  b.chassis = chassis;
  b.comp = freshComp(def);
  b.hp = 1;
  b.fuel = 1;
  // The new frame comes with a full tank of whatever its engine burns.
  b.tank = fuelOf(def, b.fit);
  // Fitted parts keep their wear on the new frame.
  return spill;
}

/** Rough worth of a vehicle, for deciding which spare to break down when the yard is full. */
export function buildValue(b: VehicleBuild): number {
  const def = defOf(b);
  let v = def.hp * 0.3 + def.physics.mass * 0.02 + def.topSpeedKmh * 0.2;
  for (const slot of Object.keys(b.fit) as PartSlot[]) v += mkOf(b.fit, slot) * 12;
  return v * (0.4 + 0.6 * b.hp);
}

/** Inventory room: a vehicle's cargo space is the convoy's too. */
export function inventoryCap(active: VehicleBuild[]): number {
  return INVENTORY_BASE + active.reduce((a, b) => a + Math.floor(statsOf(b).cargo), 0);
}

/** One line of condition for lists and HUD. */
export function conditionSummary(b: VehicleBuild): string {
  const flats = b.comp.tires.filter((t, i) => t <= 0.001 && !(b.tyres[i] && partDef(b.tyres[i]!.id).empty)).length;
  const bits: string[] = [];
  if (b.comp.engine < 0.15) bits.push('engine dead');
  else if (b.comp.engine < 0.6) bits.push('engine rough');
  if (flats) bits.push(`${flats} flat`);
  if (b.comp.leaking) bits.push('leaking');
  if (statsOf(b).noEngine) bits.push('no engine');
  const wrong = fuelMismatch(fuelOf(defOf(b), b.fit), b.tank, b.fuel);
  if (wrong) bits.push(`wrong fuel (${b.tank})`);
  if ((b.comp.radiator ?? 1) < 0.3) bits.push('radiator shot');
  if ((b.comp.coolant ?? 1) < COOLANT_LOW) bits.push('low on water');
  if ((b.comp.gearbox ?? 1) < 0.4) bits.push('gearbox slipping');
  const st = statsOf(b);
  if (st.noDrive) bits.push('no gearbox');
  if (st.hoodOff) bits.push('no bonnet');
  if (st.doorsOff) bits.push(st.doorsOff === 2 ? 'no doors' : 'a door off');
  if (st.tyresGone) bits.push(`${st.tyresGone} wheel${st.tyresGone > 1 ? 's' : ''} bare`);
  if (b.comp.oil < OIL_CRITICAL) bits.push('oil dry');
  else if (b.comp.oil < OIL_LOW) bits.push('low on oil');
  if (b.hp < 0.4) bits.push('battered');
  return bits.length ? bits.join(', ') : b.hp < 0.95 ? 'scuffed' : 'sound';
}
