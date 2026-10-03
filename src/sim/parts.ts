import { PARTS, PART_SLOTS, partDef, type FuelType, type ModuleSlot, type PartDef, type PartSlot, type PartStats, type VehicleDef } from '../data';
import { clamp } from '../core/math';
import type { Rng } from '../core/rng';
import { coolingKw, engineEffects, engineLine, type BayLabel } from './engines';

/**
 * A part you can carry: a catalogue entry plus how worn it is. Condition only matters for the parts that replace a
 * damaged component (engine, radiator, tyres, armour); everything else is always 1.
 */
export interface PartItem {
  uid: string;
  id: string;
  cond: number;
}

/** What is bolted onto a vehicle, by slot. */
export type Fit = Partial<Record<PartSlot, PartItem>>;

let uidCounter = 1;
/** Unique within a save. Saves reseed the counter on load so new ids never collide with stored ones. */
export function newUid(prefix = 'i'): string {
  return `${prefix}${uidCounter++}`;
}
export function seedUids(used: Iterable<string>) {
  let max = 0;
  for (const u of used) {
    const n = parseInt(u.replace(/^\D+/, ''), 10);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  uidCounter = Math.max(uidCounter, max + 1);
}

export function newPart(id: string, cond = 1): PartItem {
  return { uid: newUid('p'), id, cond: clamp(cond, 0, 1) };
}

export const CORE_SLOTS: PartSlot[] = ['engine', 'wheels', 'armor', 'weapon', 'utility'];

/** Slots whose part wears out with use: its condition is the vehicle's own component condition. */
export const WORN_SLOTS: PartSlot[] = ['engine', 'cooling', 'wheels', 'armor'];
export const isWorn = (slot: PartSlot): boolean => WORN_SLOTS.includes(slot);

/** Slots a chassis accepts parts in. */
export function slotsOf(def: VehicleDef): PartSlot[] {
  return def.slots ?? PART_SLOTS;
}

/** Quality of the aftermarket part in a slot. A factory fitting (even one carried over from another car) counts as none. */
export function mkOf(fit: Fit, slot: PartSlot): number {
  const it = fit[slot];
  if (!it) return 0;
  const d = partDef(it.id);
  return d.stock ? 0 : d.mk;
}

/** The old five-slot Mk levels, for the raid threat estimate. */
export function modsOf(fit: Fit): Record<ModuleSlot, number> {
  return { engine: mkOf(fit, 'engine'), armor: mkOf(fit, 'armor'), wheels: mkOf(fit, 'wheels'), weapon: mkOf(fit, 'weapon'), utility: mkOf(fit, 'utility') };
}

export type WeaponKind = 'frontLMG' | 'bedMG' | 'topTurret' | 'autocannons' | 'mg';

/** Native weapon, or whatever a weapon part grants this chassis. */
export function weaponKind(def: VehicleDef, fit: Fit): WeaponKind | null {
  if (def.weapon) return def.weapon as WeaponKind;
  if (!fit.weapon) return null;
  const m = def.weaponMount ?? 'none';
  return m === 'bed' ? 'bedMG' : m === 'front' ? 'frontLMG' : null;
}

export const BASE_OFFROAD = 0.45;

export interface Stats {
  forceMult: number;
  topSpeedMult: number;
  armor: number;
  /** Extra armour for hits from the front, side and rear. */
  armorF: number;
  armorS: number;
  armorR: number;
  gripMult: number;
  travelMult: number;
  offroad: number;
  damageMult: number;
  rateMult: number;
  tank: number;
  cargo: number;
  hpMult: number;
  burnMult: number;
  sigMult: number;
  plow: number;
  ram: number;
  light: number;
  spare: boolean;
  weapon: WeaponKind | null;
  /** The engine in the bay: output (kW), what it burns, how much heat it makes and how well the radiator copes. */
  power: number;
  fuel: FuelType;
  heat: number;
  coolKw: number;
  /** Share of the radiator's airflow left by the engine crowding the bay. */
  airflow: number;
  bayLabel: BayLabel;
  /** Kilograms heavier than the factory engine. */
  massDelta: number;
  noEngine: boolean;
}

const sum = (fit: Fit, k: keyof PartStats): number => {
  let t = 0;
  for (const slot of PART_SLOTS) {
    const it = fit[slot];
    if (it) t += partDef(it.id).stats[k] ?? 0;
  }
  return t;
};

/** Stats a chassis gets from its fitted parts. Pure, so it can be tested. */
export function effectiveStats(def: VehicleDef, fit: Fit): Stats {
  const ef = engineEffects(def, fit);
  return {
    forceMult: Math.max(0.4, 1 + sum(fit, 'force')) * ef.force,
    topSpeedMult: clamp(Math.max(0.5, 1 + sum(fit, 'top')) * ef.top, 0.25, 1.6),
    armor: clamp(def.armor + sum(fit, 'armor'), 0, 0.9),
    armorF: sum(fit, 'armorF'),
    armorS: sum(fit, 'armorS'),
    armorR: sum(fit, 'armorR'),
    gripMult: (1 + sum(fit, 'grip')) * ef.grip,
    travelMult: (1 + sum(fit, 'travel')) * ef.travel,
    offroad: clamp((def.offroad ?? BASE_OFFROAD) + sum(fit, 'offroad'), 0, 1),
    damageMult: 1 + sum(fit, 'dmg'),
    rateMult: 1 + sum(fit, 'rate'),
    tank: def.tank * (1 + sum(fit, 'tank')),
    cargo: def.cargo + sum(fit, 'cargo'),
    hpMult: 1 + sum(fit, 'hp'),
    burnMult: Math.max(0.5, 1 + sum(fit, 'burn')) * ef.burn,
    sigMult: Math.max(0.5, 1 + sum(fit, 'sig')) * ef.sig,
    plow: sum(fit, 'plow'),
    ram: sum(fit, 'ram'),
    light: sum(fit, 'light'),
    spare: sum(fit, 'spare') > 0,
    weapon: weaponKind(def, fit),
    power: ef.spec.kw,
    fuel: ef.fuel,
    heat: ef.heat,
    coolKw: coolingKw(def, fit),
    airflow: ef.bay.airflow,
    bayLabel: ef.bay.label,
    massDelta: ef.massDelta,
    noEngine: ef.empty,
  };
}

/** Sand and mud grip for a chassis: wide off-road tyres shrink the penalty, a road car doubles down on it. */
export function terrainGrip(surfaceGrip: number, offroad: number): number {
  const penalty = (1 - surfaceGrip) * clamp(1 + (BASE_OFFROAD - offroad) * 1.6, 0.35, 1.9);
  return clamp(1 - penalty, 0.2, 1.1);
}
export function terrainDrag(surfaceDrag: number, offroad: number): number {
  return surfaceDrag * clamp(1 + (BASE_OFFROAD - offroad) * 1.0, 0.4, 1.6);
}

// ---------------------------------------------------------------- naming and rarity

export const RARITY_NAMES = ['', 'Common', 'Uncommon', 'Rare'];
export const RARITY_CSS = ['', '#cfc4a8', '#7ddc7a', '#ffb454'];

export function partName(it: PartItem | PartDef): string {
  return 'name' in it ? it.name : partDef(it.id).name;
}

export function conditionLabel(cond: number): string {
  return cond >= 0.9 ? 'Like new' : cond >= 0.65 ? 'Good' : cond >= 0.4 ? 'Worn' : cond > 0.05 ? 'Barely holding' : 'Dead';
}

/** True if the part is built for a slot this chassis has. */
export function fitsChassis(def: VehicleDef, it: PartItem): boolean {
  return slotsOf(def).includes(partDef(it.id).slot);
}

// ---------------------------------------------------------------- loot

export interface RollOpts {
  /** Only these slots. */
  slots?: PartSlot[];
  minMk?: number;
  maxMk?: number;
  /** Bias toward better quality: each point multiplies the weight of Mk n by (1 + bias * (n - 1)). */
  bias?: number;
  condLo?: number;
  condHi?: number;
}

/** A part lying in the world: id and wear only, so the world stays deterministic. */
export interface PartSpec {
  id: string;
  cond: number;
}

/** One random part from the catalogue by weight, as an id and a wear value. */
export function rollPartSpec(rng: Rng, o: RollOpts = {}): PartSpec {
  const loot = PARTS.parts.filter((p) => !p.stock);
  const pool = loot.filter((p) => (!o.slots || o.slots.includes(p.slot)) && p.mk >= (o.minMk ?? 1) && p.mk <= (o.maxMk ?? 3));
  const list = pool.length ? pool : loot;
  const w = list.map((p) => p.weight * (1 + (o.bias ?? 0) * (p.mk - 1)));
  const total = w.reduce((a, b) => a + b, 0);
  let r = rng.next() * total;
  let pick = list[list.length - 1];
  for (let i = 0; i < list.length; i++) {
    r -= w[i];
    if (r <= 0) {
      pick = list[i];
      break;
    }
  }
  const cond = isWorn(pick.slot) ? rng.range(o.condLo ?? 0.5, o.condHi ?? 0.95) : 1;
  return { id: pick.id, cond };
}

/** One random part from the catalogue by weight. */
export function rollPart(rng: Rng, o: RollOpts = {}): PartItem {
  const s = rollPartSpec(rng, o);
  return newPart(s.id, s.cond);
}

/** Worth in Scrap when a part is broken down. */
export function scrapValue(it: PartItem): number {
  const d = partDef(it.id);
  return Math.round(((d.cost.scrap ?? 0) * 0.4 + (d.cost.parts ?? 0) * 0.3) * (0.5 + 0.5 * it.cond));
}

// ---------------------------------------------------------------- descriptions

const pct = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`;

/** What a part is, in plain words: an engine's size, output and fuel, a radiator's rating, otherwise its stat changes. */
export function describePart(d: PartDef): string[] {
  if (d.engine) return d.empty ? ['no engine: the vehicle will not run'] : [engineLine(d.engine), `${Math.round(d.engine.mass)} kg · size ${d.engine.size}`];
  if (d.cooling !== undefined) return d.empty ? ['no cooling: it will overheat fast'] : [`cooling ${Math.round(d.cooling)} kW`];
  return describeStats(d.stats);
}

/** A part's effects in plain words, best news first: "+17% power · +8% top speed · +10% fuel burn". */
export function describeStats(st: PartStats): string[] {
  const out: string[] = [];
  const add = (v: number | undefined, label: string) => {
    if (v) out.push(`${pct(v)} ${label}`);
  };
  add(st.force, 'power');
  add(st.top, 'top speed');
  add(st.armor, 'armour');
  add(st.armorF, 'front armour');
  add(st.armorS, 'side armour');
  add(st.armorR, 'rear armour');
  add(st.hp, 'hull');
  add(st.grip, 'grip');
  add(st.travel, 'suspension');
  add(st.offroad, 'off-road');
  add(st.dmg, 'gun damage');
  add(st.rate, 'fire rate');
  add(st.tank, 'fuel capacity');
  if (st.cargo) out.push(`+${st.cargo} cargo`);
  add(st.plow, 'zombie plough');
  add(st.ram, 'ram damage');
  add(st.light, 'headlight');
  if (st.spare) out.push('free tyre swaps');
  add(st.burn, 'fuel burn');
  add(st.sig, 'noise');
  return out;
}
