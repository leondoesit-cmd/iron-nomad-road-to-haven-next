import { STOCK_IDS, VEHICLES, type Cost, type StockId, type Stocks } from '../data';
import type { DrugId } from './drugs';

export function newStocks(init?: Partial<Stocks>): Stocks {
  return { fuel: 0, rations: 0, scrap: 0, parts: 0, tech: 0, medicine: 0, ...init };
}

/** Costs may use the doc's "fu" shorthand for fuel. */
function normalize(cost: Cost): Partial<Stocks> {
  const out: Partial<Stocks> = {};
  for (const k in cost) {
    const v = (cost as Record<string, number>)[k];
    if (!v) continue;
    const id = (k === 'fu' ? 'fuel' : k) as StockId;
    out[id] = (out[id] ?? 0) + v;
  }
  return out;
}

export function canAfford(s: Stocks, cost: Cost): boolean {
  const c = normalize(cost);
  for (const id of STOCK_IDS) if ((c[id] ?? 0) > s[id] + 1e-6) return false;
  return true;
}

/** Atomic: either the whole cost is paid or nothing changes. */
export function spend(s: Stocks, cost: Cost): boolean {
  if (!canAfford(s, cost)) return false;
  const c = normalize(cost);
  for (const id of STOCK_IDS) s[id] = Math.max(0, s[id] - (c[id] ?? 0));
  return true;
}

export function gain(s: Stocks, delta: Partial<Stocks>) {
  for (const id of STOCK_IDS) if (delta[id]) s[id] = Math.max(0, s[id] + (delta[id] as number));
}

export function whole(v: number) {
  return Math.floor(v + 1e-6);
}

export function costText(cost: Cost): string {
  const c = normalize(cost);
  const parts: string[] = [];
  for (const id of STOCK_IDS) if (c[id]) parts.push(`${c[id]} ${LABEL[id]}`);
  return parts.join(' · ') || 'Free';
}

export const LABEL: Record<StockId, string> = {
  fuel: 'Fuel',
  rations: 'Rations',
  scrap: 'Scrap',
  parts: 'Parts',
  tech: 'Tech',
  medicine: 'Medicine',
};

export interface CrewCut {
  id: string;
  cut: number;
}

/** Net loot = gross × (1 − Σ crew cuts). The withheld share is held in escrow for each crew member. */
export function splitLoot(gross: Partial<Stocks>, crew: CrewCut[]) {
  const raw = crew.reduce((a, c) => a + c.cut, 0);
  const total = Math.min(0.9, raw);
  const scale = raw > 0.9 ? 0.9 / raw : 1; // never let the crew take more than 90%
  const net: Partial<Stocks> = {};
  const owed: Record<string, Partial<Stocks>> = {};
  for (const c of crew) owed[c.id] = {};
  for (const id of STOCK_IDS) {
    const g = gross[id];
    if (!g) continue;
    net[id] = g * (1 - total);
    for (const c of crew) (owed[c.id] as Partial<Stocks>)[id] = g * c.cut * scale;
  }
  return { net, owed, total };
}

export function totalCuts(crew: CrewCut[]) {
  return crew.reduce((a, c) => a + c.cut, 0);
}

// ---------------------------------------------------------------- upgrades

export interface UpgradeCheck {
  ok: boolean;
  reason?: string;
  cost: Cost;
}

/** The `upgrade` block on tier N holds the cost to rebuild N into N+1. */
export function tierUpCost(fromTier: number) {
  const cur = VEHICLES.tiers[fromTier - 1];
  const next = VEHICLES.tiers[fromTier];
  if (!cur || !next) return null;
  const u = cur.upgrade;
  const cost: Cost = {};
  if (u.parts) cost.parts = u.parts;
  if (u.scrap) cost.scrap = u.scrap;
  if (u.tech) cost.tech = u.tech;
  return { cost, chassis: u.chassis, needsGarage: !!u.needsGarage, beta: !!next.beta, target: next };
}

export function checkTierUp(stocks: Stocks, fromTier: number, chassis: number, atGarage: boolean, maxTier = 3): UpgradeCheck {
  const info = tierUpCost(fromTier);
  if (!info) return { ok: false, reason: 'Already at the top tier', cost: {} };
  if (info.target.tier > maxTier || info.beta) return { ok: false, reason: 'Arrives in the Beta', cost: info.cost };
  if (info.needsGarage && !atGarage) return { ok: false, reason: 'Needs a Waypoint garage', cost: info.cost };
  if (info.chassis > chassis) return { ok: false, reason: `Needs a salvaged chassis (${chassis}/${info.chassis})`, cost: info.cost };
  if (!canAfford(stocks, info.cost)) return { ok: false, reason: 'Not enough stock', cost: info.cost };
  return { ok: true, cost: info.cost };
}

// ---------------------------------------------------------------- crafting

export interface Recipe {
  id: string;
  name: string;
  cost: Cost;
  yields: { ammo?: number; medkit?: number; molotov?: number; flare?: number; charge?: number } & Partial<Record<DrugId, number>>;
}
export const RECIPES: Recipe[] = [
  { id: 'ammo', name: 'Ammo (30 rounds)', cost: { scrap: 5 }, yields: { ammo: 30 } },
  { id: 'medkit', name: 'Medkit', cost: { medicine: 2 }, yields: { medkit: 1 } },
  { id: 'molotov', name: 'Molotov', cost: { fuel: 1 }, yields: { molotov: 1 } },
  { id: 'flare', name: 'Flare', cost: { tech: 1 }, yields: { flare: 2 } },
  { id: 'stim', name: 'Stim', cost: { medicine: 1, tech: 1 }, yields: { stim: 1 } },
  { id: 'painkiller', name: 'Painkillers (2)', cost: { medicine: 1 }, yields: { painkiller: 2 } },
  { id: 'adrenaline', name: 'Adrenaline', cost: { medicine: 2, tech: 1 }, yields: { adrenaline: 1 } },
  { id: 'haze', name: 'Spore haze (2)', cost: { medicine: 1, scrap: 3 }, yields: { haze: 2 } },
  { id: 'alcohol', name: 'Moonshine (2)', cost: { rations: 1, scrap: 2 }, yields: { alcohol: 2 } },
  { id: 'weed', name: 'Weed (3)', cost: { rations: 1, scrap: 3 }, yields: { weed: 3 } },
  { id: 'mushrooms', name: 'Mushrooms (2)', cost: { rations: 2 }, yields: { mushrooms: 2 } },
  { id: 'lsd', name: 'LSD (2)', cost: { medicine: 2, tech: 2 }, yields: { lsd: 2 } },
  { id: 'ayahuasca', name: 'Ayahuasca', cost: { rations: 2, medicine: 2, tech: 1 }, yields: { ayahuasca: 1 } },
  { id: 'charge', name: 'Breaching charge', cost: { tech: 5, scrap: 4 }, yields: { charge: 1 } },
];
