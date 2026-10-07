import { FIT_SLOTS, GLASS_SLOTS, INTERIOR_SLOTS, chassisDef, hasChassis, type PartSlot } from '../data';
import { Rng } from '../core/rng';
import { EMPTY_ID, newBuild, partInSlot, tyreAt, type BuildComp, type VehicleBuild } from './garage';
import { newPart, rollPart, type Fit, type PartItem, type Tyres } from './parts';
import { gearDrop, type GearItem } from './gear';
import { rollCar } from './cars';
import { GUN_ODDS, rollItem, rollLoot, specName, type LootSpec } from './loot';
import { rollGunLoot } from './gunLoot';

/**
 * Stripping a car (crowbar, hold A) takes what is actually on it, in four stages: the tyres, the engine and what hangs off
 * it, the bodywork and running gear, then the cabin and boot. Nothing abstract comes out: no Scrap and no generic Parts,
 * only the named parts that were fitted (with the wear they had), the oil and water in the sumps, and whatever was left
 * lying in the cabin and boot (a ration tin, a spray can, a box of rounds). A car that had already lost its engine has no
 * engine to give. Whatever is not wanted is broken down for Scrap later, on purpose, in the garage.
 */

/** What is being stripped. Raiders carry better kit than a family car. */
export type SalvageKind = 'car' | 'raider' | 'wagon' | 'convoy';

export interface SalvageStageDef {
  id: 'tyres' | 'engine' | 'body' | 'trunk';
  /** Prompt while holding. */
  prompt: string;
  /** Hold time in seconds. */
  secs: number;
  /** Signature emitted when the stage completes: prying metal is loud. */
  noise: number;
}

export const SALVAGE_STAGES: SalvageStageDef[] = [
  { id: 'tyres', prompt: 'Strip the tyres', secs: 3.2, noise: 30 },
  { id: 'engine', prompt: 'Pull the engine', secs: 5, noise: 48 },
  { id: 'body', prompt: 'Cut up the bodywork', secs: 4.2, noise: 42 },
  { id: 'trunk', prompt: 'Search the cabin and trunk', secs: 2.6, noise: 16 },
];

export interface SalvageCtx {
  seed: number;
  kind: SalvageKind;
  chassis: string;
  /** Burnt out: parts come out charred and there is little left in the boot. */
  burnt: boolean;
  /** The car itself, when it has one. Without it, a found car is rolled from its seed, and a raider's vehicle from its kit. */
  build?: VehicleBuild;
  /** For a lost convoy vehicle: what was bolted to it, and how worn. */
  fit?: Fit;
  tyres?: Tyres;
  comp?: BuildComp;
  /** How far the convoy has come, 0 to 1. */
  progress?: number;
}

export interface SalvageLoot {
  /** The parts that came off, as they were. */
  items: PartItem[];
  /** Cans, tins and boxes found in the cabin or boot (fuel and oil cans, rations, medicine, rounds). */
  goods: LootSpec[];
  /** Oil drained from the sump, in sumps (a can is 0.5). */
  oil: number;
  /** A piece of personal gear in the cabin or trunk, now and then. */
  gear?: GearItem;
  /** Guns from the weapons table (`rollGunLoot`): a raider's rig often has one, a family car's glovebox now and then. */
  guns?: GearItem[];
  /** A spray can in the glovebox, now and then. */
  paint?: { color: number; charges: number };
  /** Water drained from the radiator, in litres. */
  water?: number;
}

/** The car being stripped: its own build, one made from what a convoy vehicle had on it, or the one its seed rolls. */
function buildOf(c: SalvageCtx): VehicleBuild | null {
  if (c.build) return c.build;
  if (!hasChassis(c.chassis) || c.kind === 'raider' || c.kind === 'wagon') return null;
  if (c.fit || c.tyres || c.comp) {
    const b = newBuild(c.chassis, { seed: c.seed });
    if (c.fit) b.fit = { ...c.fit };
    if (c.tyres) b.tyres = [...c.tyres];
    if (c.comp) b.comp = { ...c.comp };
    return b;
  }
  return rollCar(c.seed, { biome: 'wasteland', chassis: c.chassis, status: c.burnt ? 'hulk' : undefined, reach: c.progress }).build;
}

/** The bolt-on slots that come off with the bodywork. */
const BODY_FIT: PartSlot[] = ['hood', 'doorL', 'doorR', 'suspension', 'brakes', 'armor', 'weapon', 'utility', 'front', 'roof', 'rear', 'side'];

/** A convoy vehicle that was lost gives its parts back battered; a stranger's car gives them as the road left them. */
const worn = (it: PartItem, c: SalvageCtx): PartItem => (c.kind === 'convoy' ? { ...it, cond: Math.min(it.cond, 0.45) } : it);

/** A raider's rig has no catalogue entry for what is in it, so what is under its panels is rolled. */
function raiderLoot(stage: number, c: SalvageCtx, rng: Rng): SalvageLoot {
  const out: SalvageLoot = { items: [], goods: [], oil: 0 };
  const wagon = c.kind === 'wagon';
  const prog = c.progress ?? 0.3;
  const opts = { progress: Math.min(1, prog + 0.25), depth: (wagon ? 1 : 0) as 0 | 1 };
  switch (stage) {
    case 0: {
      for (let i = 0; i < (wagon ? 4 : 2); i++) {
        const s = rollItem('raider', rng, { ...opts, only: ['tyre'] }) ?? rollItem('wreck', rng, { ...opts, only: ['tyre'] });
        if (s?.kind === 'part') out.items.push(newPart(s.id, s.cond * 0.8));
      }
      break;
    }
    case 1:
      out.items.push(rollPart(rng, { slots: ['engine'], minMk: 1, maxMk: wagon ? 3 : 2, bias: 0.4, condLo: 0.3, condHi: 0.7 }));
      if (rng.chance(0.4)) out.items.push(rollPart(rng, { slots: ['gearbox'], minMk: 1, maxMk: 2, condLo: 0.3, condHi: 0.7 }));
      if (rng.chance(0.3)) out.items.push(rollPart(rng, { slots: ['exhaust'], minMk: 1, maxMk: 2 }));
      if (!c.burnt) out.oil = Math.round(rng.range(0.2, 0.5) * 100) / 100;
      break;
    case 2:
      if (rng.chance(0.7)) out.items.push(rollPart(rng, { slots: ['armor'], minMk: 1, maxMk: wagon ? 3 : 2, condLo: 0.4, condHi: 0.9 }));
      if (rng.chance(0.45)) out.items.push(rollPart(rng, { slots: ['weapon'], minMk: 1, maxMk: wagon ? 3 : 2 }));
      if (rng.chance(0.3)) out.items.push(rollPart(rng, { slots: ['front', 'roof', 'rear', 'side'], minMk: 1, maxMk: 2 }));
      if (rng.chance(0.4)) out.items.push(rollPart(rng, { slots: ['cooling'], minMk: 1, maxMk: 2, condLo: 0.3, condHi: 0.7 }));
      if (!c.burnt) out.water = Math.round(rng.range(2, 6) * 10) / 10;
      break;
    default: {
      for (const s of rollLoot('raider', c.seed, wagon ? 1 : 0, { progress: opts.progress })) out.goods.push(s);
      const g = gearDrop(rng, wagon ? 'wreck' : 'raider', { progress: c.progress });
      if (g) out.gear = g;
      if (rng.chance(wagon ? 0.6 : 0.3)) out.guns = rollGunLoot(wagon ? 'raider' : 'wreck', c.seed, wagon ? 1 : 0);
    }
  }
  return out;
}

/**
 * What one stage of stripping hands over, fixed by the car's seed and by what is on it, so reloading a chunk cannot reroll
 * it and the same car always gives the same things. `stripBuild` is what it costs the car.
 */
export function salvageLoot(stage: number, c: SalvageCtx): SalvageLoot {
  const rng = new Rng((Math.imul(c.seed | 0, 2654435761) + stage * 40503 + 17) >>> 0);
  const b = buildOf(c);
  if (!b) return raiderLoot(stage, c, rng);
  const out: SalvageLoot = { items: [], goods: [], oil: 0 };
  const take = (slot: PartSlot) => {
    const it = partInSlot(b, slot);
    if (it) out.items.push(worn(it, c));
  };
  switch (stage) {
    case 0:
      // Every tyre that is on a wheel, with the wear it has: a bare rim gives nothing.
      for (let i = 0; i < b.tyres.length; i++) {
        const t = tyreAt(b, i);
        if (t) out.items.push(worn(t, c));
      }
      break;
    case 1:
      // The engine, the box behind it and the pipe off it; whatever is not there does not come out.
      for (const slot of ['engine', 'gearbox', 'exhaust'] as PartSlot[]) take(slot);
      // Pulling an engine drains the sump: a burnt-out one has nothing left in it.
      if (!c.burnt) out.oil = Math.round(Math.min(OIL_DRAIN_MAX, Math.max(0, b.comp.oil) * 0.6) * 100) / 100;
      break;
    case 2:
      for (const slot of BODY_FIT) take(slot);
      // The glass is cut out of its frames with the rest of the bodywork: a pane that has gone is nothing to take.
      for (const slot of GLASS_SLOTS) take(slot);
      take('cooling');
      // And the water in the radiator runs out onto the road, for anyone with a can.
      if (!c.burnt) out.water = Math.round(Math.max(0, b.comp.coolant ?? 0) * 6 * 10) / 10;
      break;
    default: {
      // The cabin: the seats, the wheel and the dash that are fitted come out with the search.
      for (const slot of INTERIOR_SLOTS) take(slot);
      if (c.kind === 'convoy') break;
      const cabinParts = out.items;
      out.items = [];
      // What the last owner left in the cabin and boot: a few named things, seeded by the car, and burnt with it if it burnt.
      const van = c.chassis === 'van' ? 1 : 0;
      for (const s of rollLoot('trunk', c.seed, van ? 1 : 0, { progress: c.progress ?? 0.3 })) {
        if (s.kind === 'paint') out.paint = { color: s.color, charges: s.charges };
        else if (s.kind === 'part') out.items.push(newPart(s.id, s.cond));
        else out.goods.push(s);
      }
      // A can of paint does not survive a fire, and whatever else was in a burnt-out car mostly burnt with it.
      if (c.burnt) out.paint = undefined;
      if (c.burnt && rng.chance(0.55)) {
        out.goods = [];
        out.items = [];
        out.paint = undefined;
      }
      out.items.unshift(...cabinParts);
      // Drawn last, so the finds above are what they always were. Raiders' wagons are the best.
      const g = gearDrop(rng, 'trunk', { progress: c.progress });
      if (g && !(c.burnt && rng.chance(0.55))) out.gear = g;
      if (!c.burnt && rng.chance(GUN_ODDS.wreck ?? 0.15)) out.guns = rollGunLoot('wreck', c.seed, 0);
    }
  }
  return out;
}

/** The most oil a stage can drain: a can and a half of a sump. */
const OIL_DRAIN_MAX = 0.5;

/**
 * What a stage costs the car: exactly what `salvageLoot` took is gone from it, its mounts left empty, nothing more. Only the
 * slots the car really has are touched, so a chassis without doors does not grow an empty one.
 */
export function stripBuild(stage: number, b: VehicleBuild) {
  const have = new Set(chassisDef(b.chassis).slots ?? FIT_SLOTS);
  const empty = (slot: PartSlot) => {
    const none = EMPTY_ID[slot];
    if (none && have.has(slot)) b.fit[slot] = newPart(none, 1);
    else delete b.fit[slot];
  };
  switch (stage) {
    case 0:
      b.tyres = b.tyres.map(() => newPart('tyre_none', 1));
      b.comp.tires = b.comp.tires.map(() => 0);
      break;
    case 1:
      for (const slot of ['engine', 'gearbox', 'exhaust'] as PartSlot[]) empty(slot);
      b.comp.engine = 0;
      b.comp.gearbox = 0;
      b.comp.oil = 0;
      break;
    case 2:
      for (const slot of BODY_FIT) if (partInSlot(b, slot)) empty(slot);
      // Every window frame is left bare, a shattered pane included.
      for (const slot of GLASS_SLOTS) if (have.has(slot)) empty(slot);
      for (const k of ['ws', 'rw', 'sL0', 'sL1', 'sR0', 'sR1']) if (b.body?.glass) delete b.body.glass[k];
      empty('cooling');
      b.comp.radiator = 0;
      b.comp.coolant = 0;
      b.comp.plates = Math.min(b.comp.plates, 0.1);
      b.hp = Math.min(b.hp, 0.12);
      break;
    default:
      // The cabin: the seats, the wheel and the dash come out, the mounts stay.
      for (const slot of INTERIOR_SLOTS) if (partInSlot(b, slot)) empty(slot);
      break;
  }
}

/** A line for the toast: "+1 Tuned V6, Oil can, Ration tin". */
export function lootText(l: SalvageLoot, name: (it: PartItem) => string): string {
  const bits: string[] = l.items.map((it) => name(it));
  for (const g of l.goods) bits.push(specName(g));
  if (l.oil > 0.01) bits.push(`${Math.round(l.oil * 200)}% of an oil can`);
  if (l.paint) bits.push('a spray can');
  if (l.water && l.water >= 0.5) bits.push(`${l.water.toFixed(0)} L of water`);
  return bits.length ? bits.join(', ') : 'Nothing worth taking';
}
