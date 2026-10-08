import type { TerrainDef } from '../../src/world/terrain';
import { nearestRoad } from '../../src/world/openWorld';
import { onCauseway, type Hydro, type River } from '../../src/world/hydro';

/** Counts by name. */
export interface Tally {
  [k: string]: number;
}

export const bump = (t: Tally, k: string, n = 1) => (t[k] = (t[k] ?? 0) + n);

/**
 * Samples of a course worth scanning for how its water fits the land: clear of its ends, its falls, the road crossings (a
 * causeway over culverts, a ford) and the hand-made bits of a bend (island, landing, crossing, mill), whose shapes are their own.
 */
export function plainSample(def: TerrainDef, hy: Hydro, r: River, i: number): boolean {
  if (i < 3 || i > r.end - 4) return false;
  for (const f of hy.falls) if (f.river === r.id && i >= f.i0 - 2 && i <= f.i1 + 2) return false;
  const x = r.x[i];
  const z = r.z[i];
  const rd = nearestRoad(def.open!, x, z);
  if (rd.road && rd.edge < r.half[i] + 9) return false;
  if (r.spring >= 0) {
    const sp = hy.springs[r.spring];
    if (Math.hypot(x - sp.x, z - sp.z) < sp.r + 6) return false;
  }
  for (const lp of hy.loops) {
    if (lp.island && Math.hypot(x - lp.island.x, z - lp.island.z) < lp.island.r + 12) return false;
    if (lp.landing && Math.hypot(x - lp.landing.x, z - lp.landing.z) < lp.landing.w + 14) return false;
    if (lp.cross && Math.hypot(x - (lp.cross.x0 + lp.cross.x1) / 2, z - (lp.cross.z0 + lp.cross.z1) / 2) < lp.cross.len / 2 + 10) return false;
    if (Math.hypot(x - lp.millX, z - lp.millZ) < 22) return false;
  }
  if (onCauseway(hy, x, z)) return false;
  return true;
}
