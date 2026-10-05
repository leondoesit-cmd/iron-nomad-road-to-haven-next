import { hash2 } from '../core/rng';
import { smoothstep } from '../core/math';
import { CELL, CELLS, CHUNK, type TerrainDef } from './terrain';
import { cityChunk, nearestRoad } from './openWorld';
import { lakeQ } from './lakes';
import { courseAt, forestAt, lushAt, swampQ, woodsAt } from './hydro';
import type { Aabb, PropSpawn } from './layout';

/**
 * The trees of the green country, planted per chunk from the lushness and wood fields of `world/hydro.ts`. Pure and
 * deterministic: the same chunk always gets the same trees, so the drawn trunks and their colliders agree, and nothing here
 * touches three.js or Rapier.
 *
 * Woods grow in clumps where the land is lush; lone trees stand in the meadows and acacias in the dry grass at their edge.
 * What grows depends on where: oaks and terebinths in the broadleaf country, pines in the northern woods, willows and
 * poplars along the rivers and lake shores, swamp cypress and dead snags in the swamps, date palms round an oasis.
 * Nothing is planted on a road, in water, on a steep slope, on a place's pad or against a prop, car or building.
 */

export const TREE_SPECIES = ['oak', 'pine', 'willow', 'poplar', 'palm', 'acacia', 'cypress', 'snag'] as const;
export type TreeSpecies = (typeof TREE_SPECIES)[number];

/** Nominal size of each species at scale 1: overall height, canopy radius, trunk radius and the height of the solid trunk. */
export const TREE_DIMS: Record<TreeSpecies, { h: number; crown: number; trunk: number; bole: number }> = {
  oak: { h: 9.5, crown: 4.4, trunk: 0.42, bole: 3.2 },
  pine: { h: 15, crown: 3.0, trunk: 0.34, bole: 4.5 },
  willow: { h: 9, crown: 4.6, trunk: 0.48, bole: 2.6 },
  poplar: { h: 17, crown: 2.2, trunk: 0.3, bole: 4 },
  palm: { h: 10, crown: 3.6, trunk: 0.26, bole: 6 },
  acacia: { h: 6, crown: 4.4, trunk: 0.24, bole: 2.4 },
  cypress: { h: 12, crown: 3.2, trunk: 0.5, bole: 3.5 },
  snag: { h: 8, crown: 2.0, trunk: 0.32, bole: 4 },
};

export interface TreeSpot {
  x: number;
  /** Ground height at the foot of the trunk. */
  y: number;
  z: number;
  yaw: number;
  /** Size relative to the species' nominal size. */
  s: number;
  /** Index into `TREE_SPECIES`, and a model variant (0..2). */
  sp: number;
  v: number;
  /** A slight lean, radians about x and z. */
  lean: [number, number];
}

/** Planting grid (metres): about the spacing of trunks in a closed wood. */
const STEP = CHUNK / 24;

export interface PlantBlock {
  aabbs: Aabb[];
  props: PropSpawn[];
  /** Other things trees keep clear of: cars, pickups, camps, the start. Circles. */
  keep: { x: number; z: number; r: number }[];
}

/**
 * The trees of one chunk. `heights` is the chunk's own heightfield (Rapier layout, as `chunkHeights` makes it), so the trees
 * stand exactly on the ground that is drawn and collided.
 */
export function plantTrees(def: TerrainDef, cx: number, cz: number, heights: Float32Array, block: PlantBlock): TreeSpot[] {
  const out: TreeSpot[] = [];
  const g = plantTreesSteps(def, cx, cz, heights, block, out);
  while (!g.next().done);
  return out;
}

/** `plantTrees` in slices, for a chunk being made a few rows at a time. Fills `out`. */
export function* plantTreesSteps(def: TerrainDef, cx: number, cz: number, heights: Float32Array, block: PlantBlock, out: TreeSpot[]): Generator<void> {
  const hy = def.hydro;
  if (!hy?.lush || !def.open || cityChunk(def.open, cx, cz)) return;
  const x0 = cx * CHUNK;
  const z0 = cz * CHUNK;
  const N1 = CELLS + 1;
  const H = (x: number, z: number) => {
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
    // The same diagonal split as the heightfield's triangles.
    return tx > tz ? a + (b - a) * tx + (e - b) * tz : a + (e - d) * tx + (d - a) * tz;
  };
  const seed = def.seed * 13 + 71;
  const n = Math.round(CHUNK / STEP);
  // Things to keep clear of, gathered once for the chunk.
  const pad = 6;
  const boxes = block.aabbs.filter((a) => a.maxX > x0 - pad && a.minX < x0 + CHUNK + pad && a.maxZ > z0 - pad && a.minZ < z0 + CHUNK + pad);
  const props = block.props.filter((p) => p.x > x0 - pad && p.x < x0 + CHUNK + pad && p.z > z0 - pad && p.z < z0 + CHUNK + pad);
  const keep = block.keep.filter((k) => k.x + k.r > x0 && k.x - k.r < x0 + CHUNK && k.z + k.r > z0 && k.z - k.r < z0 + CHUNK);
  const sites = def.sites.filter((s) => Math.abs(s.x - (x0 + CHUNK / 2)) < CHUNK + Math.max(s.radius, 30) && Math.abs(s.z - (z0 + CHUNK / 2)) < CHUNK + Math.max(s.radius, 30));
  const lakes = def.lakes.filter((l) => Math.abs(l.x - (x0 + CHUNK / 2)) < CHUNK + l.reach && Math.abs(l.z - (z0 + CHUNK / 2)) < CHUNK + l.reach);
  const swamps = hy.swamps.filter((s) => Math.abs(s.x - (x0 + CHUNK / 2)) < CHUNK + s.reach && Math.abs(s.z - (z0 + CHUNK / 2)) < CHUNK + s.reach);
  const oases = hy.springs.filter((s) => Math.abs(s.x - (x0 + CHUNK / 2)) < CHUNK + 60 && Math.abs(s.z - (z0 + CHUNK / 2)) < CHUNK + 60);
  const crossings = hy.crossings.filter((c) => Math.abs(c.x - (x0 + CHUNK / 2)) < CHUNK + 40 && Math.abs(c.z - (z0 + CHUNK / 2)) < CHUNK + 40);
  for (let gz = 0; gz < n; gz++) {
    if (gz % 6 === 5) yield;
    for (let gx = 0; gx < n; gx++) {
      const ix = cx * n + gx;
      const iz = cz * n + gz;
      const x = x0 + (gx + 0.2 + hash2(ix, iz, seed) * 0.6) * STEP;
      const z = z0 + (gz + 0.2 + hash2(ix, iz, seed + 1) * 0.6) * STEP;
      const L = lushAt(def, x, z);
      if (L < 0.22) continue;
      const F = forestAt(def, x, z);
      // A closed wood, lone trees in the meadows, acacias out in the dry grass.
      const pWood = F * 0.66;
      const pLone = L > 0.4 ? 0.018 * L : 0;
      const pAcacia = L < 0.55 ? 0.014 * smoothstep(0.22, 0.38, L) : 0;
      const roll = hash2(ix, iz, seed + 2);
      if (roll > pWood + pLone + pAcacia) continue;
      // Roads, with room for a car on the verge.
      const rd = nearestRoad(def.open, x, z);
      if (rd.road && rd.edge < (rd.road.kind === 'highway' ? 9 : rd.road.kind === 'road' ? 6 : 3.5)) continue;
      // Ground: not steep.
      const y = H(x, z);
      const sx = H(x + 1.5, z) - H(x - 1.5, z);
      const sz = H(x, z + 1.5) - H(x, z - 1.5);
      if (Math.hypot(sx, sz) / 3 > 0.6) continue;
      // Water: lakes and rivers keep their edges clear; swamp trees may stand in the shallows.
      let wet = false;
      for (const l of lakes) if (lakeQ(l, x, z) < 1.04) wet = true;
      if (wet) continue;
      const c = courseAt(hy, x, z);
      if (c && c.d < c.half + 2.2) continue;
      let swamp = false;
      for (const s of swamps) {
        const q = swampQ(s, x, z);
        if (q < 1.15) swamp = true;
        if (q < 1 && y < s.level - 0.3) wet = true;
      }
      if (wet) continue;
      let oasis = false;
      let spring = false;
      for (const s of oases) {
        const d = Math.hypot(x - s.x, z - s.z);
        if (d < s.r + 2.5) spring = true;
        if (s.oasis && d < s.r + 38) oasis = true;
      }
      if (spring) continue;
      // Places, crossings and whatever else keeps a clearing.
      if (sites.some((s) => Math.hypot(x - s.x, z - s.z) < (s.radius > 0 ? s.radius * 0.95 + 4 : 16))) continue;
      if (crossings.some((q) => Math.hypot(x - q.x, z - q.z) < q.span * 0.5 + q.roadHalf + 16)) continue;
      if (keep.some((k) => Math.hypot(x - k.x, z - k.z) < k.r)) continue;
      if (boxes.some((a) => x > a.minX - 2.5 && x < a.maxX + 2.5 && z > a.minZ - 2.5 && z < a.maxZ + 2.5)) continue;
      if (props.some((p) => Math.hypot(x - p.x, z - p.z) < 2.6 + (p.kind === 'rock' ? 1.6 * p.scale : 0))) continue;
      // What grows here.
      const k = hash2(ix, iz, seed + 3);
      const woods = woodsAt(def, x, z);
      let sp: TreeSpecies;
      if (oasis) sp = 'palm';
      else if (swamp || woods === 'fen') sp = k < 0.7 ? 'cypress' : 'snag';
      else if (woods === 'riparian') sp = k < 0.55 ? 'willow' : 'poplar';
      else if (roll > pWood + pLone) sp = 'acacia';
      else if (woods === 'pine') sp = k < 0.85 ? 'pine' : 'oak';
      else sp = F < 0.05 && L < 0.5 ? (k < 0.6 ? 'acacia' : 'oak') : k < 0.82 ? 'oak' : k < 0.92 ? 'pine' : 'poplar';
      const kk = hash2(ix, iz, seed + 4);
      out.push({
        x,
        y: y - 0.12,
        z,
        yaw: kk * Math.PI * 2,
        s: 0.72 + hash2(ix, iz, seed + 5) * 0.55,
        sp: TREE_SPECIES.indexOf(sp),
        v: Math.floor(hash2(ix, iz, seed + 6) * 3),
        lean: [(hash2(ix, iz, seed + 7) - 0.5) * 0.1, (hash2(ix, iz, seed + 8) - 0.5) * 0.1],
      });
    }
  }
}

/** The solid part of a tree: its trunk as an obstacle box (zombies, bullets and the physics all use it). */
export function trunkBox(t: TreeSpot, id: number): Aabb {
  const d = TREE_DIMS[TREE_SPECIES[t.sp]];
  const r = Math.max(0.2, d.trunk * t.s);
  return { id, minX: t.x - r, maxX: t.x + r, minZ: t.z - r, maxZ: t.z + r, y0: t.y - 0.5, y1: t.y + d.bole * t.s, kind: 'tree', hp: 99999, mat: 'wood' };
}
