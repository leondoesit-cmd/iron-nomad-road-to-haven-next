import { clamp01, smoothstep } from '../core/math';
import { noise2 } from '../core/rng';
import { forestAt, lushAt } from './hydro';
import { districtMask, nearestRoad } from './openWorld';
import { surfaceAt, waterAt, type TerrainDef } from './terrain';

/**
 * What there is on the ground to burn at a point, 0 bare to 1 thick: the same grass the scatter grows (the clumps of the
 * desert, the meadows of the green country), leaf litter under the woods, nothing on the road, the asphalt, the city's
 * paving or in the water. Sand holds little; the dune seas none.
 */
export function groundFuel(def: TerrainDef, x: number, z: number): number {
  if (def.biome === 'city') return 0;
  if (def.lakes.length && waterAt(def, x, z)) return 0;
  const surf = surfaceAt(def, x, z);
  if (surf === 'asphalt') return 0;
  if (def.open) {
    if (nearestRoad(def.open, x, z).edge < 1.2) return 0;
    const town = districtMask(def.open, x, z);
    if (town > 0.95) return 0;
  }
  // The clumps the scatter grows grass on (same noise, same seed).
  const clump = noise2(x / 19 + 7, z / 19 - 3, def.seed * 7 + 3 + 5);
  let g = smoothstep(0.3, 0.72, clump) * 0.8;
  if (def.hydro?.lush) {
    const L = lushAt(def, x, z);
    if (L > 0) {
      const meadow = 0.55 + 0.4 * smoothstep(0.3, 0.7, clump);
      const F = L > 0.42 ? forestAt(def, x, z) : 0;
      g = g + (meadow - g) * smoothstep(0.15, 0.55, L);
      // Under the trees the grass thins but the floor is deep in dead leaves and twigs.
      g = g * (1 - F * 0.4) + F * 0.45;
    }
    if (surf === 'sand') g *= 0.3 + 0.7 * smoothstep(0.3, 0.6, L);
  } else if (surf === 'sand') g *= 0.3;
  if (def.open) g *= 1 - districtMask(def.open, x, z);
  return clamp01(g);
}
