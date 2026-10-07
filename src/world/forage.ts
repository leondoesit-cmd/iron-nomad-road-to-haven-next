import { hash2 } from '../core/rng';
import { CELL, CELLS, CHUNK, type TerrainDef } from './terrain';
import { cityChunk, nearestRoad } from './openWorld';
import { lakeQ } from './lakes';
import { courseAt, forestAt, lushAt, swampQ } from './hydro';
import { nearWash } from './washes';
import type { Aabb, PropSpawn } from './layout';
import type { TreeSpot } from './flora';
import { FORAGE_KINDS, type ForageKind, type Shroom } from '../sim/forage';

/**
 * Where wild food and herbs grow in the open world, planted per chunk like the trees: pure and deterministic, so the same
 * chunk always has the same plants with the same ids (what was picked is remembered by id).
 *
 * - Wild figs by water: round springs and oases, along the rivers, by the lakes.
 * - Brambles on the banks of the rivers, lake shores and swamp edges, and along the edges of the woods.
 * - Prickly pear in the hedges round the old places (every village had its sabra) and here and there along the roads in
 *   dry country.
 * - Za'atar on the open dry hillsides and the grass; yarrow in the meadows.
 * - Mushrooms under the trees in the woods; and liberty caps, every day, in the grass round the old gums of a river's bend
 *   (`world/millBend.ts`).
 */

export interface ForageSpot {
  /** Stable id: `fg:<cx>:<cz>:<n>`. */
  id: string;
  kind: ForageKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Size relative to nominal. */
  s: number;
  /** A model variant (0..2), and the patch's own hash for things decided per day. */
  v: number;
  h: number;
  /** For a mushroom patch: which kind it really is. */
  shroom?: Shroom;
  /** Fruits every day, rain or not (the liberty caps round the old gums of a river's bend). */
  always?: boolean;
}

/** Sampling grid (metres). */
const STEP = 8;

export interface ForageBlock {
  heights: Float32Array;
  aabbs: Aabb[];
  props: PropSpawn[];
  trees: TreeSpot[];
}

/** The ground height of a point in a chunk from its heightfield, split the way the drawn triangles are. */
function heightIn(heights: Float32Array, x0: number, z0: number, x: number, z: number): number {
  const N1 = CELLS + 1;
  const fc = Math.min(CELLS - 1e-4, Math.max(0, (x - x0) / CELL));
  const fr = Math.min(CELLS - 1e-4, Math.max(0, (z - z0) / CELL));
  const c = Math.floor(fc);
  const r = Math.floor(fr);
  const tx = fc - c;
  const tz = fr - r;
  const a = heights[c * N1 + r];
  const b = heights[(c + 1) * N1 + r];
  const d = heights[c * N1 + r + 1];
  const e = heights[(c + 1) * N1 + r + 1];
  return tx > tz ? a + (b - a) * tx + (e - b) * tz : a + (e - d) * tx + (d - a) * tz;
}

/** The forage of one chunk. Empty outside the open world's green-and-dry country (cities, corridor legs). */
export function plantForage(def: TerrainDef, cx: number, cz: number, b: ForageBlock): ForageSpot[] {
  const out: ForageSpot[] = [];
  const hy = def.hydro;
  if (!hy?.lush || !def.open || cityChunk(def.open, cx, cz)) return out;
  const x0 = cx * CHUNK;
  const z0 = cz * CHUNK;
  const mid = { x: x0 + CHUNK / 2, z: z0 + CHUNK / 2 };
  const near = <T extends { x: number; z: number }>(list: T[], reach: (t: T) => number) => list.filter((t) => Math.abs(t.x - mid.x) < CHUNK + reach(t) && Math.abs(t.z - mid.z) < CHUNK + reach(t));
  const lakes = near(def.lakes, (l) => l.reach);
  const swamps = near(hy.swamps, (s) => s.reach);
  const springs = near(hy.springs, () => 60);
  const sites = near(def.sites, (s) => s.radius + 50);
  const crossings = near(hy.crossings, () => 40);
  const seed = def.seed * 31 + 907;
  const n = CHUNK / STEP;
  let k = 0;
  for (let gz = 0; gz < n; gz++) {
    for (let gx = 0; gx < n; gx++) {
      const ix = cx * n + gx;
      const iz = cz * n + gz;
      const roll = hash2(ix, iz, seed);
      // Most cells grow nothing worth picking: a cheap early out before the fields are sampled.
      if (roll > 0.24) continue;
      const x = x0 + (gx + 0.15 + hash2(ix, iz, seed + 1) * 0.7) * STEP;
      const z = z0 + (gz + 0.15 + hash2(ix, iz, seed + 2) * 0.7) * STEP;
      const L = lushAt(def, x, z);
      const F = L >= 0.42 ? forestAt(def, x, z) : 0;
      // Water: nothing grows in it.
      let wet = false;
      let shore = false;
      for (const l of lakes) {
        const q = lakeQ(l, x, z);
        if (q < 1.05) wet = true;
        else if (q < 1.45) shore = true;
      }
      if (wet) continue;
      const c = courseAt(hy, x, z);
      if (c && c.d < c.half + 2.2) continue;
      const bank = !!c && c.d < c.half + 14;
      const byRiver = !!c && c.d < c.half + 30;
      let fen = false;
      for (const s of swamps) {
        const q = swampQ(s, x, z);
        if (q < 1.05) wet = true;
        else if (q < 1.4) fen = true;
      }
      if (wet) continue;
      let spring = false;
      let oasis = false;
      for (const s of springs) {
        const d = Math.hypot(x - s.x, z - s.z);
        if (d < s.r + 1.5) wet = true;
        else if (d < s.r + 40) spring = true;
        if (s.oasis && d < s.r + 45) oasis = true;
      }
      if (wet) continue;
      if (def.washes && nearWash(def, x, z, 1.5)) continue;
      // Roads, with their verges.
      const rd = nearestRoad(def.open, x, z);
      const edge = rd.road ? rd.edge : Infinity;
      if (edge < (rd.road?.kind === 'highway' ? 6 : 3.2)) continue;
      // The old places: inside one, nothing; round its edge, the sabra hedge.
      let inSite = false;
      let hedge = false;
      for (const s of sites) {
        const d = Math.hypot(x - s.x, z - s.z);
        const r = s.radius > 0 ? s.radius : 14;
        if (d < r * 0.95 + 2) inSite = true;
        else if (d < r + 36) hedge = true;
      }
      if (inSite) continue;
      if (crossings.some((q) => Math.hypot(x - q.x, z - q.z) < q.span * 0.5 + q.roadHalf + 10)) continue;
      // What grows here, and how likely: each kind gets its own slice of the roll.
      const odds: [ForageKind, number][] = [
        ['fig', L > 0.28 && (spring || oasis || byRiver || shore) ? 0.05 : L > 0.32 && L < 0.65 && F < 0.1 ? 0.003 : 0],
        ['bramble', L > 0.35 && (bank || shore || fen) ? 0.06 : L > 0.45 && F > 0.04 && F < 0.35 ? 0.012 : 0],
        ['sabra', hedge ? 0.05 : L < 0.5 && edge < 14 ? 0.008 : 0],
        ['zaatar', L > 0.08 && L < 0.58 && F < 0.05 ? 0.012 : 0],
        ['yarrow', L > 0.4 && L < 0.85 && F < 0.12 ? 0.014 : 0],
        ['mushroom', F > 0.35 ? 0.035 : 0],
      ];
      let acc = 0;
      let kind: ForageKind | null = null;
      for (const [kk, p] of odds) {
        acc += p;
        if (roll < acc) {
          kind = kk;
          break;
        }
      }
      if (!kind) continue;
      // Ground: not steep.
      const y = heightIn(b.heights, x0, z0, x, z);
      const sx = heightIn(b.heights, x0, z0, x + 1.2, z) - heightIn(b.heights, x0, z0, x - 1.2, z);
      const sz = heightIn(b.heights, x0, z0, x, z + 1.2) - heightIn(b.heights, x0, z0, x, z - 1.2);
      if (Math.hypot(sx, sz) / 2.4 > (kind === 'zaatar' ? 0.75 : 0.55)) continue;
      // Clear of anything solid; mushrooms want a tree close by, everything else some room from the trunks.
      if (b.aabbs.some((a) => a.kind !== 'tree' && x > a.minX - 1.6 && x < a.maxX + 1.6 && z > a.minZ - 1.6 && z < a.maxZ + 1.6)) continue;
      if (b.props.some((p) => Math.hypot(x - p.x, z - p.z) < 1.8 + (p.kind === 'rock' ? 1.6 * p.scale : 0))) continue;
      let tree = Infinity;
      for (const t of b.trees) tree = Math.min(tree, Math.hypot(x - t.x, z - t.z));
      if (kind === 'mushroom' ? tree < 1.3 || tree > 7 : tree < (kind === 'fig' ? 3.5 : 1.8)) continue;
      const h = hash2(ix, iz, seed + 3);
      const spot: ForageSpot = {
        id: `fg:${cx}:${cz}:${k++}`,
        kind,
        x,
        y,
        z,
        yaw: hash2(ix, iz, seed + 4) * Math.PI * 2,
        s: 0.8 + hash2(ix, iz, seed + 5) * 0.45,
        v: Math.floor(hash2(ix, iz, seed + 6) * 3),
        h,
      };
      if (kind === 'mushroom') spot.shroom = h < 0.48 ? 'field' : h < 0.68 ? 'liberty' : 'deathcap';
      out.push(spot);
    }
  }
  // Liberty caps round the old gums of a river's bend.
  for (const bend of def.bends ?? []) {
    bend.shrooms.forEach((s, n) => {
      if (s.x < x0 || s.x >= x0 + CHUNK || s.z < z0 || s.z >= z0 + CHUNK) return;
      const hh = hash2(n, bend.shrooms.length, seed + 11);
      out.push({ id: `fg:${bend.key}:${n}`, kind: 'mushroom', x: s.x, y: heightIn(b.heights, x0, z0, s.x, s.z), z: s.z, yaw: hh * Math.PI * 2, s: 0.85 + hh * 0.35, v: n % 3, h: hh, shroom: 'liberty', always: true });
    });
  }
  return out;
}

/** How many of each kind, for tests and tuning. */
export function forageCounts(spots: ForageSpot[]): Record<ForageKind, number> {
  const c = Object.fromEntries(FORAGE_KINDS.map((k) => [k, 0])) as Record<ForageKind, number>;
  for (const s of spots) c[s.kind]++;
  return c;
}
