import { ENEMIES, STRUCTURES, type RaiderKind, type ZombieKind } from '../data';
import { Rng } from '../core/rng';
import { clamp } from '../core/math';

/**
 * Threat T for the night: the leg's base threat scaled by the camp's Signature S (0..100) and Notoriety N (0..100).
 * Convoy Power never changes how much threat you face, only what it is made of.
 */
export function raidThreat(base: number, signature: number, notoriety: number): number {
  const s = clamp(signature, 0, 100);
  const n = clamp(notoriety, 0, 100);
  return Math.round(base * (1 + 0.8 * (s / 100)) * (1 + n / 200) * 10) / 10;
}

/** A rough measure of how armed the convoy is. 1 per tier plus module levels and crew. */
export function convoyPower(vehicles: { tier: number; moduleLevels: number }[], crewCount: number, turrets = 0): number {
  return vehicles.reduce((a, v) => a + v.tier + v.moduleLevels * 0.25, 0) + crewCount * 0.5 + turrets * 0.75;
}

/** Elite share rises with Convoy Power, capped. */
export function eliteShare(power: number) {
  return clamp((power - 3) / 14, 0, 0.55);
}

export interface WaveSpec {
  name: string;
  /** Threat budget for this wave. */
  budget: number;
  sectors: number[];
  zombies: ZombieKind[];
  raiders: RaiderKind[];
}

export const WAVE_SHARE = [0.25, 0.4, 0.35];
/** Converts threat points into unit weight. Tuned so a two-player convoy with pistols and a couple of turrets can hold the first night. */
export const WAVE_SCALE = 1.7;

export type RaidKind = 'infected' | 'marauders' | 'both';

export function pickRaidKind(biome: 'wasteland' | 'city', signature: number, rng: Rng): RaidKind {
  if (signature >= 85 && rng.chance(0.25)) return 'both';
  return biome === 'city' ? 'infected' : 'marauders';
}

const COMMON_Z: ZombieKind[] = ['walker', 'runner'];
const ELITE_Z: ZombieKind[] = ['brute', 'bloater', 'stalker'];

/** Spend a budget on units. Total weight tracks the budget; elites are fewer but heavier. */
export function spendBudget(budget: number, kind: RaidKind, elite: number, wave: number, rng: Rng) {
  return spendBudgetLeft(budget, kind, elite, wave, rng).spec;
}

/** As `spendBudget`, but also returns the weight that went unspent (a unit too heavy for the remainder stops the spend). */
export function spendBudgetLeft(budget: number, kind: RaidKind, elite: number, wave: number, rng: Rng) {
  const zombies: ZombieKind[] = [];
  const raiders: RaiderKind[] = [];
  const split = kind === 'both' ? 0.5 : kind === 'infected' ? 1 : 0;
  let zb = budget * split;
  let rb = budget * (1 - split);
  let guard = 400;
  while (zb > 0.8 && guard-- > 0) {
    let k: ZombieKind;
    if (wave === 2 && rng.chance(0.18)) k = 'screamer';
    else if (rng.chance(elite)) k = rng.pick(ELITE_Z);
    else k = rng.pick(COMMON_Z);
    const w = ENEMIES.zombies[k].weight;
    if (w > zb && zombies.length) break;
    zombies.push(k);
    zb -= w;
  }
  if (rb > 0) {
    // The Climax wave sends the Battle-wagon.
    // The Climax wave only sends the Battle-wagon once the night is dangerous enough.
    if (wave === 2 && rb >= ENEMIES.raiders.wagon.weight * 1.6) {
      raiders.push('wagon');
      rb -= ENEMIES.raiders.wagon.weight;
    }
    while (rb > 1 && guard-- > 0) {
      let k: RaiderKind;
      const roll = rng.next();
      if (roll < 0.35) k = 'gunman';
      else if (roll < 0.7) k = 'buggy';
      else if (roll < 0.85 && wave >= 1) k = 'sniper';
      else k = wave >= 1 ? 'saboteur' : 'gunman';
      const w = ENEMIES.raiders[k].weight;
      if (w > rb && raiders.length) break;
      raiders.push(k);
      rb -= w;
    }
  }
  return { spec: { zombies, raiders }, left: Math.max(0, zb) * (split > 0 ? 1 : 0) + Math.max(0, rb) * (split < 1 ? 1 : 0) };
}

export function planRaid(opts: {
  base: number;
  signature: number;
  notoriety: number;
  power: number;
  kind: RaidKind;
  seed: number;
}): { threat: number; waves: WaveSpec[] } {
  const rng = new Rng(opts.seed);
  const T = raidThreat(opts.base, opts.signature, opts.notoriety);
  const elite = eliteShare(opts.power);
  // What a wave cannot spend (the next unit is too heavy for the remainder) rolls into the next one, so the night's total
  // tracks the threat instead of quietly shrinking.
  let carry = 0;
  const waves: WaveSpec[] = STRUCTURES.raids.waves.map((name, i) => {
    const budget = T * WAVE_SHARE[i] * WAVE_SCALE + carry;
    const { spec, left } = spendBudgetLeft(budget, opts.kind, elite, i, rng);
    carry = left;
    const { zombies, raiders } = spec;
    const nSectors = i === 0 ? 1 : i === 1 ? 2 : 3;
    const sectors: number[] = [];
    const used = new Set<number>();
    while (sectors.length < nSectors) {
      const s = rng.int(0, STRUCTURES.sectors - 1);
      if (!used.has(s)) {
        used.add(s);
        sectors.push(s);
      }
    }
    return { name, budget, sectors, zombies, raiders };
  });
  return { threat: T, waves };
}
