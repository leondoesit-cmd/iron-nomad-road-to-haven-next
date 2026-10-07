import { hash2 } from '../core/rng';
import { smoothstep } from '../core/math';
import { CELL, CELLS, CHUNK, type TerrainDef } from './terrain';
import { cityChunk, nearestRoad } from './openWorld';
import { lakeQ } from './lakes';
import { courseAt, forestAt, lushAt, swampQ, woodsAt, type Woods } from './hydro';
import { nearWash } from './washes';
import { heritageClear } from './heritage';
import { bendClear, bendStems } from './millBend';
import type { Aabb, PropSpawn } from './layout';

/**
 * The trees of the green country, planted per chunk from the lushness and wood fields of `world/hydro.ts`. Pure and
 * deterministic: the same chunk always gets the same trees, so the drawn trunks and their colliders agree, and nothing here
 * touches three.js or Rapier.
 *
 * Woods grow in clumps where the land is lush; lone trees stand in the meadows and acacias in the dry grass at their edge.
 * What grows depends on where: oaks and terebinths in the broadleaf country, pines in the northern woods, willows and
 * poplars along the rivers and lake shores, eucalyptus groves along a river planted with them (the Yarkon), swamp cypress
 * and dead snags in the swamps, date palms round an oasis.
 * Nothing is planted on a road, in water, on a steep slope, on a place's pad or against a prop, car or building.
 */

export const TREE_SPECIES = ['oak', 'pine', 'willow', 'poplar', 'palm', 'acacia', 'cypress', 'snag', 'eucalyptus'] as const;
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
  eucalyptus: { h: 22, crown: 5.2, trunk: 0.46, bole: 9 },
};

/**
 * What a wood of the given kind is made of, for a tree that is neither a swamp's, an oasis's nor an acacia at the dry edge.
 * `k` is the tree's own 0..1 roll, `L` and `F` the lushness and wood density where it stands.
 */
export function woodSpecies(woods: Woods, k: number, L: number, F: number): TreeSpecies {
  switch (woods) {
    case 'fen':
      return k < 0.7 ? 'cypress' : 'snag';
    case 'riparian':
      return k < 0.55 ? 'willow' : 'poplar';
    case 'gum':
      // A planted river: mostly tall pale eucalyptus, a few willows and poplars between them and the odd oak.
      return k < 0.8 ? 'eucalyptus' : k < 0.9 ? 'willow' : k < 0.95 ? 'poplar' : 'oak';
    case 'pine':
      return k < 0.85 ? 'pine' : 'oak';
    default:
      return F < 0.05 && L < 0.5 ? (k < 0.6 ? 'acacia' : 'oak') : k < 0.82 ? 'oak' : k < 0.92 ? 'pine' : 'poplar';
  }
}

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
  /** Stretch of the crown across and up (1, 1 is the model as built); left out, each tree takes its own from where it stands. */
  aspect?: [number, number];
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
      // A tree may stand on the very lip of a river's bank (and lean out over it, below).
      const c = courseAt(hy, x, z);
      if (c && c.d < c.half + 1.3) continue;
      // Nothing roots in a wash bed (the floods take it) or on a pan's clay.
      if (def.washes && nearWash(def, x, z, 1.5)) continue;
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
      if (heritageClear(def.heritage, x, z, 1)) continue;
      if (bendClear(def, x, z)) continue;
      if (boxes.some((a) => x > a.minX - 2.5 && x < a.maxX + 2.5 && z > a.minZ - 2.5 && z < a.maxZ + 2.5)) continue;
      if (props.some((p) => Math.hypot(x - p.x, z - p.z) < 2.6 + (p.kind === 'rock' ? 1.6 * p.scale : 0))) continue;
      // What grows here.
      const k = hash2(ix, iz, seed + 3);
      const woods = woodsAt(def, x, z);
      let sp: TreeSpecies;
      if (oasis) sp = 'palm';
      else if (swamp) sp = woodSpecies('fen', k, L, F);
      else if (woods === 'fen' || woods === 'riparian' || woods === 'gum') sp = woodSpecies(woods, k, L, F);
      else if (roll > pWood + pLone) sp = 'acacia';
      else sp = woodSpecies(woods, k, L, F);
      const kk = hash2(ix, iz, seed + 4);
      const yaw = kk * Math.PI * 2;
      let lean: [number, number] = [(hash2(ix, iz, seed + 7) - 0.5) * 0.1, (hash2(ix, iz, seed + 8) - 0.5) * 0.1];
      // On a river's bank willows and gums lean out over the water toward the light, the nearer the edge the further.
      if (c && (sp === 'willow' || sp === 'eucalyptus' || sp === 'oak')) {
        const near = 1 - smoothstep(1.3, 8, c.d - c.half);
        const kl = hash2(ix, iz, seed + 9);
        const th = near * (sp === 'willow' ? 0.22 + 0.32 * kl : sp === 'eucalyptus' ? 0.1 + 0.22 * kl : 0.08 + 0.14 * kl);
        if (th > 0.02) {
          const r = c.river;
          const j = Math.min(r.n - 1, c.i + 1);
          const wx = r.x[c.i] + (r.x[j] - r.x[c.i]) * c.t - x;
          const wz = r.z[c.i] + (r.z[j] - r.z[c.i]) * c.t - z;
          const wl = Math.hypot(wx, wz) || 1;
          lean = leanToward(yaw, wx / wl, wz / wl, th);
        }
      }
      out.push({
        x,
        y: y - 0.12,
        z,
        yaw,
        s: 0.72 + hash2(ix, iz, seed + 5) * 0.55,
        sp: TREE_SPECIES.indexOf(sp),
        v: Math.floor(hash2(ix, iz, seed + 6) * 3),
        lean,
      });
    }
  }
  // The old gums of a river's bend are set by hand (`world/millBend.ts`): their stems stand on the chunk's own ground.
  for (const t of bendStems(def, x0, z0, x0 + CHUNK, z0 + CHUNK)) out.push({ ...t, y: Math.min(t.y, H(t.x, t.z) - 0.12) });
}

/**
 * A tree's `lean` (rotations about its own x and z, after its yaw, as `treeInstances` composes them) that tips it `th`
 * radians toward the world direction (wx, wz).
 */
export function leanToward(yaw: number, wx: number, wz: number, th: number): [number, number] {
  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const tx = th * (wx * cs - wz * sn);
  const tz = th * (wx * sn + wz * cs);
  return [tz, -tx];
}

/** How far a tree's leaning stem carries a point `h` metres up it, in the world (x, z). */
export function leanOffset(t: TreeSpot, h: number): [number, number] {
  const tx = -Math.sin(t.lean[1]);
  const tz = Math.sin(t.lean[0]);
  const cs = Math.cos(t.yaw);
  const sn = Math.sin(t.yaw);
  return [(tx * cs + tz * sn) * h, (-tx * sn + tz * cs) * h];
}

/** The solid part of a tree: its trunk as an obstacle box (zombies, bullets and the physics all use it). */
export function trunkBox(t: TreeSpot, id: number): Aabb {
  const d = TREE_DIMS[TREE_SPECIES[t.sp]];
  const r = Math.max(0.2, d.trunk * t.s);
  return { id, minX: t.x - r, maxX: t.x + r, minZ: t.z - r, maxZ: t.z + r, y0: t.y - 0.5, y1: t.y + d.bole * t.s, kind: 'tree', hp: 99999, mat: 'wood' };
}
