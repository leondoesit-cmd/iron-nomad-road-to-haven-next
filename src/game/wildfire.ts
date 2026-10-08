import { clamp, clamp01 } from '../core/math';
import { TREE_DIMS, TREE_SPECIES, type TreeSpot } from '../world/flora';
import type { Ctx } from './ctx';

/**
 * Fire in the trees. Lightning (or anything else that calls `ignite`) sets a tree alight; whether it takes depends on how
 * dry the land is. A burning tree flares up through its crown, burns for a minute or so and leaves a charred snag. While it
 * is at its height it throws sparks: a neighbour close by, and more often one downwind, catches in turn, so a dry wood on a
 * windy day can go up tree by tree. Rain beats the flames down and puts them out. Anyone standing in the flames burns, and
 * the dead burn like anything else.
 *
 * What burned stays burned: `burnt` holds every tree's char by its key, and the scene darkens the trees from it whenever
 * their chunk is drawn (and keeps it across the night in the world's memory).
 */

export interface Fire {
  key: string;
  tree: TreeSpot;
  /** Top of the crown, and how wide the flames spread round the trunk. */
  top: number;
  r: number;
  /** 0 just caught, 1 the full blaze; it rises, holds while there is fuel, then falls. */
  heat: number;
  /** Seconds of burning left in the tree. */
  fuel: number;
  /** How much of the tree is charred so far, 0..1. */
  char: number;
  tick: number;
  sparkT: number;
}

/** A tree's key: its trunk position to a decimetre. */
export function treeKey(t: { x: number; z: number }): string {
  return `${Math.round(t.x * 10)}:${Math.round(t.z * 10)}`;
}

/** How likely a strike or a spark sets a tree going, by how ready the land is to burn (`sim/climate.fireDanger`). */
export function catchChance(danger: number, spark = false): number {
  return clamp01((spark ? 0.05 : 0.22) + (spark ? 0.5 : 0.65) * danger * danger);
}

export interface FireHooks {
  /** Trees standing within `r` of a point (only in the ground that is loaded). */
  treesNear(x: number, z: number, r: number): TreeSpot[];
  /** Darken a tree to its char (0 green, 1 a black snag). */
  charTree(t: TreeSpot, char: number): void;
  /** Told when a fire takes, for the radio. */
  onIgnite?(f: Fire, cause: 'strike' | 'spread'): void;
}

const NO_TREES: TreeSpot[] = [];

export class Wildfire {
  fires: Fire[] = [];
  /** Every tree that has burned, by key: how charred it is. */
  burnt = new Map<string, number>();
  hooks: FireHooks = { treesNear: () => NO_TREES, charTree: () => {} };

  constructor(private ctx: Ctx) {}

  /** Try to set a tree alight. `chance` is the odds it takes (1 always does). Returns the fire if it did. */
  ignite(t: TreeSpot, chance = 1, cause: 'strike' | 'spread' = 'spread'): Fire | null {
    const key = treeKey(t);
    if (this.fires.some((f) => f.key === key)) return null;
    // A tree that has burned out has nothing left to burn.
    if ((this.burnt.get(key) ?? 0) > 0.85) return null;
    if (Math.random() >= chance) return null;
    const d = TREE_DIMS[TREE_SPECIES[t.sp]];
    const f: Fire = { key, tree: t, top: t.y + d.h * t.s, r: Math.max(2, d.crown * t.s * 0.75), heat: 0.05, fuel: 45 + Math.random() * 40, char: this.burnt.get(key) ?? 0, tick: 0, sparkT: 4 + Math.random() * 6 };
    this.fires.push(f);
    this.hooks.onIgnite?.(f, cause);
    return f;
  }

  /**
   * One fixed tick. `rain` beats the flames down, `danger` (0..1) is how ready the land is to burn and `wind` (m/s, x and
   * z) carries the sparks.
   */
  update(dt: number, rain: number, danger: number, wind: [number, number]) {
    const ctx = this.ctx;
    const wl = Math.hypot(wind[0], wind[1]);
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      const t = f.tree;
      f.fuel -= dt * (0.6 + f.heat);
      const want = f.fuel > 0 ? 1 : 0;
      // Rain beats it down, and a young fire cannot grow against a downpour at all.
      f.heat += ((want - f.heat) * (want > f.heat ? 0.12 : 0.06) - rain * 0.2 * (0.7 + f.heat)) * dt;
      f.heat = clamp(f.heat, 0, 1);
      f.char = Math.min(1, f.char + f.heat * dt * 0.022);
      if (f.heat <= 0.01 && (f.fuel <= 0 || rain > 0.15)) {
        this.burnt.set(f.key, Math.max(this.burnt.get(f.key) ?? 0, f.char));
        this.hooks.charTree(t, f.char);
        this.fires.splice(i, 1);
        continue;
      }
      // Flames climb the trunk and fill the crown, a column of smoke stands up out of it and leans downwind, embers fly, it
      // lights the wood round it, and the litter at its foot catches: the fire engine draws and runs all that (`game/fires.ts`).
      ctx.fires?.hold(f, { x: t.x, y: t.y, z: t.z, top: f.top, r: f.r, fuel: 'wood', shape: 'crown', heat: f.heat, spreads: f.heat > 0.3 });
      this.hooks.charTree(t, f.char);
      // Burn whatever stands in the flames.
      f.tick -= dt;
      if (f.tick <= 0 && f.heat > 0.25) {
        f.tick = 0.5;
        const reach = f.r * (0.5 + 0.5 * f.heat);
        for (const pl of ctx.players) {
          if (pl.state === 'foot' && pl.invuln <= 0 && Math.hypot(pl.pos.x - t.x, pl.pos.z - t.z) < reach) pl.hurt(6 * f.heat, t.x, t.z, 'fire');
        }
        ctx.zombies.burnArea(t.x, t.z, reach, 14 * f.heat, 0.5, -1);
      }
      // Sparks: a neighbour catches, downwind more often and further.
      f.sparkT -= dt * f.heat;
      if (f.sparkT <= 0 && f.heat > 0.55) {
        f.sparkT = 3 + Math.random() * 5;
        const cand = this.hooks.treesNear(t.x + wind[0] * 1.2, t.z + wind[1] * 1.2, 9 + wl * 0.6).filter((n) => {
          const k = treeKey(n);
          return k !== f.key && !this.fires.some((q) => q.key === k) && (this.burnt.get(k) ?? 0) < 0.85;
        });
        if (cand.length) this.ignite(cand[Math.floor(Math.random() * cand.length)], catchChance(danger, true) * (1 - rain));
      }
    }
  }

  /** Is anything burning within `r` of a point (for the radio and the AI)? */
  burningNear(x: number, z: number, r: number): Fire | null {
    for (const f of this.fires) if (Math.hypot(f.tree.x - x, f.tree.z - z) < r) return f;
    return null;
  }

  clear() {
    this.fires.length = 0;
  }
}
