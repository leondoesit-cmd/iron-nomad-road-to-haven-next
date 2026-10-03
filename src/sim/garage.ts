import { PARTS, chassisDef, partDef, type Cost, type PartSlot, type Stocks, type VehicleDef } from '../data';
import { clamp } from '../core/math';
import { newHealth, type VehicleHealth } from './damage';
import { OIL_CRITICAL, OIL_LOW } from './oil';
import type { BodySave } from './bodywork';
import { effectiveStats, newUid, slotsOf, type Fit, type PartItem, type Stats } from './parts';

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
  /** Picks the body variant and the small details (dents, missing trim) so no two found cars look alike. */
  seed: number;
  fit: Fit;
  /** Fraction of max hit points. */
  hp: number;
  comp: BuildComp;
  /** Fraction of the tank. */
  fuel: number;
  /** Dents, loose and missing parts, and the mud and blood on the paint. Absent on a clean, straight vehicle. */
  body?: BodySave;
}

export function freshComp(def: VehicleDef): BuildComp {
  return { engine: 1, tires: new Array(def.physics.wheelCount).fill(1), tank: 1, mount: 1, plates: 1, oil: 1, leaking: false };
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
    hp: o.hp ?? 1,
    comp: freshComp(def),
    fuel: o.fuel ?? 1,
  };
}

export function defOf(b: VehicleBuild): VehicleDef {
  return chassisDef(b.chassis);
}
export function statsOf(b: VehicleBuild): Stats {
  return effectiveStats(defOf(b), b.fit);
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
  h.comp = { engine: b.comp.engine, tires: [...b.comp.tires], tank: b.comp.tank, mount: b.comp.mount, plates: b.comp.plates, oil: b.comp.oil ?? 1 };
  h.leaking = b.comp.leaking;
  h.armorBonus = { front: st.armorF, side: st.armorS, rear: st.armorR };
  return h;
}

/** Write a vehicle's current condition back to its build. */
export function fromHealth(b: VehicleBuild, h: VehicleHealth, fuelFrac: number) {
  b.hp = clamp(h.hp / h.maxHp, 0, 1);
  b.comp = { engine: h.comp.engine, tires: [...h.comp.tires], tank: h.comp.tank, mount: h.comp.mount, plates: h.comp.plates, oil: h.comp.oil, leaking: h.leaking };
  b.fuel = clamp(fuelFrac, 0, 1);
}

// ---------------------------------------------------------------- parts

/** The part in a slot with its condition read off the vehicle, as it would come out. */
export function currentCond(b: VehicleBuild, slot: PartSlot): number {
  switch (slot) {
    case 'engine':
      return b.comp.engine;
    case 'wheels':
      return b.comp.tires.reduce((a, c) => a + c, 0) / Math.max(1, b.comp.tires.length);
    case 'armor':
      return b.comp.plates;
    default:
      return b.fit[slot]?.cond ?? 1;
  }
}

function setComp(b: VehicleBuild, slot: PartSlot, cond: number) {
  if (slot === 'engine') b.comp.engine = cond;
  else if (slot === 'wheels') b.comp.tires = b.comp.tires.map(() => (cond > 0.02 ? cond : 0));
  else if (slot === 'armor') b.comp.plates = cond;
}

export interface InstallResult {
  ok: boolean;
  reason?: string;
  /** The part that was swapped out, now carrying the wear it had on the car. */
  removed?: PartItem;
}

/** Bolt a part on. Whatever was in the slot comes back with its current wear. */
export function installPart(b: VehicleBuild, item: PartItem): InstallResult {
  const slot = partDef(item.id).slot;
  const def = defOf(b);
  if (!slotsOf(def).includes(slot)) return { ok: false, reason: `A ${def.name} has no ${PARTS.labels[slot].toLowerCase()} mount` };
  let removed: PartItem | undefined;
  const old = b.fit[slot];
  if (old) removed = { ...old, cond: currentCond(b, slot) };
  b.fit[slot] = item;
  setComp(b, slot, item.cond);
  // Armour and hull upgrades raise max HP: keep the fraction.
  return { ok: true, removed };
}

/** Pull a part off. Stock components under it are worn: they never come back better than STOCK. */
export function removePart(b: VehicleBuild, slot: PartSlot): PartItem | null {
  const old = b.fit[slot];
  if (!old) return null;
  const item: PartItem = { ...old, cond: currentCond(b, slot) };
  delete b.fit[slot];
  const stock = PARTS.stockCondition;
  if (slot === 'engine') b.comp.engine = Math.min(b.comp.engine, stock);
  else if (slot === 'wheels') b.comp.tires = b.comp.tires.map((t) => Math.min(t, stock));
  else if (slot === 'armor') b.comp.plates = Math.min(b.comp.plates, stock);
  return item;
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
  return b.hp < 0.995 || b.comp.engine < 0.999 || b.comp.mount < 0.999 || b.comp.plates < 0.999 || b.comp.oil < 0.9 || b.comp.leaking || b.comp.tires.some((t) => t < 0.999);
}

// ---------------------------------------------------------------- break down and rebuild

/** What breaking a whole vehicle down yields: its fitted parts come back worn, plus raw scrap and parts. */
export function dismantleYield(b: VehicleBuild): { stocks: Partial<Stocks>; items: PartItem[] } {
  const def = defOf(b);
  const items: PartItem[] = [];
  for (const slot of Object.keys(b.fit) as PartSlot[]) {
    const it = b.fit[slot];
    if (it) items.push({ ...it, cond: currentCond(b, slot) });
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
      spill.push({ ...it, cond: currentCond(b, slot) });
      delete b.fit[slot];
    }
  }
  b.chassis = chassis;
  b.comp = freshComp(def);
  b.hp = 1;
  b.fuel = 1;
  // Fitted parts keep their wear on the new frame.
  return spill;
}

/** Rough worth of a vehicle, for deciding which spare to break down when the yard is full. */
export function buildValue(b: VehicleBuild): number {
  const def = defOf(b);
  let v = def.hp * 0.3 + def.physics.mass * 0.02 + def.topSpeedKmh * 0.2;
  for (const slot of Object.keys(b.fit) as PartSlot[]) v += partDef(b.fit[slot]!.id).mk * 12;
  return v * (0.4 + 0.6 * b.hp);
}

/** Inventory room: a vehicle's cargo space is the convoy's too. */
export function inventoryCap(active: VehicleBuild[]): number {
  return INVENTORY_BASE + active.reduce((a, b) => a + Math.floor(statsOf(b).cargo), 0);
}

/** One line of condition for lists and HUD. */
export function conditionSummary(b: VehicleBuild): string {
  const flats = b.comp.tires.filter((t) => t <= 0.001).length;
  const bits: string[] = [];
  if (b.comp.engine < 0.15) bits.push('engine dead');
  else if (b.comp.engine < 0.6) bits.push('engine rough');
  if (flats) bits.push(`${flats} flat`);
  if (b.comp.leaking) bits.push('leaking');
  if (b.comp.oil < OIL_CRITICAL) bits.push('oil dry');
  else if (b.comp.oil < OIL_LOW) bits.push('low on oil');
  if (b.hp < 0.4) bits.push('battered');
  return bits.length ? bits.join(', ') : b.hp < 0.95 ? 'scuffed' : 'sound';
}
