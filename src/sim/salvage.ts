import { chassisDef, hasChassis, type PartSlot, type Stocks } from '../data';
import { Rng } from '../core/rng';
import type { BuildComp } from './garage';
import { newPart, rollPart, type Fit, type PartItem } from './parts';
import { gearDrop, type GearItem } from './gear';
import { foundCan } from './paint';

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
  /** Burnt out: parts come out charred and there is little left to find. */
  burnt: boolean;
  /** For a lost convoy vehicle: what was bolted to it, and how worn. */
  fit?: Fit;
  comp?: BuildComp;
  /** How far the convoy has come, 0 to 1. */
  progress?: number;
}

export interface SalvageLoot {
  stocks: Partial<Stocks>;
  ammo: number;
  items: PartItem[];
  /** Oil drained from the sump, in sumps (a can is 0.5). */
  oil: number;
  /** A piece of personal gear in the cabin or trunk, now and then. */
  gear?: GearItem;
  /** A spray can in the glovebox, now and then. */
  paint?: { color: number; charges: number };
}

const CAR_MK = [0.72, 0.24, 0.04];
const RAIDER_MK = [0.35, 0.5, 0.15];

function rollMk(rng: Rng, probs: number[]): number {
  let r = rng.next();
  for (let i = 0; i < probs.length; i++) {
    r -= probs[i];
    if (r <= 0) return i + 1;
  }
  return 1;
}

/**
 * Loot for one stage, fixed by the car's seed so reloading a chunk cannot reroll it.
 * A lost convoy vehicle gives back its own fitted parts, battered, in the matching stage.
 */
export function salvageLoot(stage: number, c: SalvageCtx): SalvageLoot {
  const rng = new Rng((Math.imul(c.seed | 0, 2654435761) + stage * 40503 + 17) >>> 0);
  const raid = c.kind === 'raider' || c.kind === 'wagon';
  const mkProbs = raid ? RAIDER_MK : CAR_MK;
  const burn = c.burnt ? 0.5 : 1;
  const condLo = c.burnt ? 0.2 : 0.45;
  const condHi = c.burnt ? 0.55 : 0.92;
  const out: SalvageLoot = { stocks: {}, ammo: 0, items: [], oil: 0 };
  const own = (slot: PartSlot) => {
    const it = c.fit?.[slot];
    if (!it) return false;
    out.items.push({ ...it, cond: Math.min(it.cond, 0.45) });
    return true;
  };
  /** The engine or radiator the car left the factory with, if the roll lets you have it. */
  const factory = (slot: 'engine' | 'cooling', chance: number): boolean => {
    if (!hasChassis(c.chassis) || !rng.chance(chance)) return false;
    const def = chassisDef(c.chassis);
    const id = slot === 'engine' ? def.stockEngine : def.stockRadiator;
    if (!id) return false;
    // A convoy vehicle gives back what it really had; a stranger's car is whatever the road did to it.
    const live = c.comp ? (slot === 'engine' ? c.comp.engine : c.comp.radiator ?? 1) : undefined;
    out.items.push(newPart(id, live !== undefined ? Math.min(live, 0.45) : rng.range(condLo, condHi)));
    return true;
  };
  const rollOne = (slots: PartSlot[]) => {
    const mk = rollMk(rng, mkProbs);
    out.items.push(rollPart(rng, { slots, minMk: mk, maxMk: mk, condLo, condHi }));
  };
  switch (stage) {
    case 0:
      if (!own('wheels')) rollOne(['wheels']);
      if (!c.burnt) out.stocks.scrap = rng.int(2, 4);
      break;
    case 1:
      // Most cars give up their own engine, which is how a diesel van's motor ends up in a hatchback.
      if (!own('engine') && !factory('engine', raid ? 0.2 : 0.7)) rollOne(['engine']);
      // Pulling an engine drains the sump: a burnt-out one has nothing left in it.
      if (!c.burnt) out.oil = Math.round(new Rng((Math.imul(c.seed | 0, 40503) + 7) >>> 0).range(0.2, 0.5) * 100) / 100;
      out.stocks.parts = Math.max(1, Math.round(rng.int(3, 6) * burn));
      break;
    case 2: {
      out.stocks.scrap = Math.round(rng.int(8, 16) * burn);
      const hadArmor = own('armor');
      for (const s of ['weapon', 'utility', 'front', 'roof', 'rear', 'side'] as PartSlot[]) own(s);
      if (!hadArmor && rng.chance(0.5 * burn + (raid ? 0.3 : 0))) rollOne(['armor']);
      if (rng.chance(0.22 * burn + (raid ? 0.2 : 0))) rollOne(['front', 'roof', 'rear', 'side']);
      if (raid && rng.chance(0.4)) rollOne(['weapon']);
      // Drawn last, so the finds above are what they always were. The radiator is behind the grille.
      if (!own('cooling')) {
        if (!factory('cooling', burn * 0.6) && !c.burnt && rng.chance(0.12)) rollOne(['cooling']);
      }
      break;
    }
    default: {
      const van = c.chassis === 'van' ? 2 : 1;
      const r = rng.next();
      if (r < 0.28) out.stocks.rations = rng.int(1, 2) * van;
      else if (r < 0.42) out.stocks.medicine = rng.int(1, 2) * van;
      else if (r < 0.62) out.ammo = rng.int(12, 30) * van;
      else if (r < 0.74) out.stocks.tech = rng.int(1, 3) * van;
      else if (r < 0.92) out.stocks.parts = rng.int(2, 5) * van;
      else out.items.push(newPart(rng.pick(['utl_rack', 'rf_rack', 'rr_spare', 'rf_light']), 1));
      // Whatever was in a burnt-out car mostly burnt with it.
      if (c.burnt && rng.chance(0.55)) {
        out.stocks = {};
        out.ammo = 0;
        out.items = [];
      }
      // Drawn last, so the finds above are the same as they were before there was gear. Raiders' wagons are the best.
      if (c.kind !== 'convoy') {
        const g = gearDrop(rng, c.kind === 'wagon' ? 'wreck' : c.kind === 'raider' ? 'raider' : 'trunk', { progress: c.progress });
        if (g && !(c.burnt && rng.chance(0.55))) out.gear = g;
        // Drawn after the gear, so every earlier find is what it always was.
        if (!c.burnt && rng.chance(0.12)) out.paint = foundCan(() => rng.next());
      }
    }
  }
  return out;
}

/** A line for the toast: "+1 Tuned V6, +4 Parts". */
export function lootText(l: SalvageLoot, name: (it: PartItem) => string): string {
  const bits: string[] = l.items.map((it) => name(it));
  const labels: Record<string, string> = { scrap: 'Scrap', parts: 'Parts', rations: 'Rations', medicine: 'Medicine', tech: 'Tech', fuel: 'FU' };
  for (const k of Object.keys(l.stocks)) if (l.stocks[k as keyof Stocks]) bits.push(`${Math.round(l.stocks[k as keyof Stocks] as number)} ${labels[k] ?? k}`);
  if (l.ammo) bits.push(`${l.ammo} rounds`);
  if (l.oil > 0.01) bits.push(`${Math.round(l.oil * 200)}% of an oil can`);
  if (l.paint) bits.push('a spray can');
  return bits.length ? bits.join(', ') : 'Nothing worth taking';
}
