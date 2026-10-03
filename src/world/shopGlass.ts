import { hash2 } from '../core/rng';
import { BOULEVARD_HALF, newAabbId, type Aabb } from './layout';
import type { BuildingSpec } from './chunkgen';

/**
 * Real glass for the shopfronts of a city street. The facade shader paints the ground floor of every building as bays, each
 * a shutter or a window, chosen by a hash of the bay and the wall; these functions work out the same choice on the CPU so a
 * pane of glass can be stood over each painted window bay on the boulevard side (the side with awnings), with a collider
 * so rounds, blasts and bumpers reach it.
 */

/** Floor height of a city building and the shop band's share of a storey (the shader's `fFloor * 1.3`). */
const FLOOR_H = 3.3;
const GROUND_H = FLOOR_H * 1.3;

const f32 = Math.fround;
const fract = (x: number) => f32(x - Math.floor(x));

/** `fHash` of the facade shader, in single precision so it lands on the same side of a threshold as the GPU does. */
export function facadeHash(px: number, py: number): number {
  const x = fract(f32(f32(px) * 0.1031));
  const y = fract(f32(f32(py) * 0.1031));
  const z = x;
  const d = f32(f32(f32(x * f32(y + 33.33)) + f32(y * f32(z + 33.33))) + f32(z * f32(x + 33.33)));
  const a = f32(x + d);
  const b = f32(y + d);
  const c = f32(z + d);
  return fract(f32(f32(a + b) * c));
}

/** The facade style a building is drawn in (0 panel, 1 brick, 2 stucco, 3 curtain wall): the same choice the chunk view makes. */
export function facadeStyleOf(bs: Pick<BuildingSpec, 'aabb' | 'floors' | 'style' | 'israeli' | 'role'>): number {
  const a = bs.aabb;
  const tall = bs.floors >= 9;
  const k = hash2(Math.round(a.minX), Math.round(a.maxZ), 78);
  const il = !!bs.israeli && !bs.role;
  return bs.style ?? (il ? (tall ? (k < 0.3 ? 0 : 2) : k < 0.92 ? 2 : 0) : tall ? (k < 0.35 ? 3 : k < 0.75 ? 0 : 2) : k < 0.45 ? 1 : k < 0.75 ? 2 : 0);
}

/** The wall of a building that carries awnings and street glass: the one facing the boulevard, if it is close enough to. */
export function shopFaceOf(bs: Pick<BuildingSpec, 'aabb' | 'shop' | 'role'>): 'w' | 'e' | null {
  const a = bs.aabb;
  if (bs.shop || bs.role) return null;
  return BOULEVARD_HALF + 4 > Math.min(Math.abs(a.minX), Math.abs(a.maxX)) ? (a.minX > 0 ? 'w' : 'e') : null;
}

/** Bays of a wall: their width, and whether each is a window (not a shutter) in the shader's pick. */
export function shopBays(len: number, seed: number, wall: number, style: number): { s0: number; s1: number }[] {
  const target = style === 3 ? 1.6 : 2.6 + seed * 0.7;
  const cell = len / Math.max(1, Math.round(len / target));
  const bw = cell * 2;
  const fSeed = f32(seed * 97 + wall * 0.37);
  const out: { s0: number; s1: number }[] = [];
  for (let k = 0; k * bw < len; k++) {
    // Below 0.45 the bay is a rolling shutter.
    if (facadeHash(k, f32(fSeed * f32(3.7))) < 0.45) continue;
    const s0 = k * bw + 0.06 * bw;
    const s1 = Math.min(len, k * bw + 0.94 * bw);
    if (s1 - s0 >= 0.9) out.push({ s0, s1 });
  }
  return out;
}

/** The colliders of a building's street glass: thin boxes just off the facade, one per window bay. */
export function shopPaneBoxes(bs: BuildingSpec): Aabb[] {
  const face = shopFaceOf(bs);
  if (!face) return [];
  const a = bs.aabb;
  const seed = hash2(Math.round(a.minX * 2), Math.round(a.minZ * 2), 77);
  const style = facadeStyleOf(bs);
  // The shader's wall index: 0 north (z1), 1 east (x1), 2 south (z0), 3 west (x0).
  const wall = face === 'w' ? 3 : 1;
  const len = a.maxZ - a.minZ;
  const out: Aabb[] = [];
  const x = face === 'w' ? a.minX - 0.05 : a.maxX + 0.05;
  const n: [number, number] = face === 'w' ? [-1, 0] : [1, 0];
  for (const { s0, s1 } of shopBays(len, seed, wall, style)) {
    // West wall runs from z0 up, east wall from z1 down.
    const z0 = face === 'w' ? a.minZ + s0 : a.maxZ - s1;
    const z1 = face === 'w' ? a.minZ + s1 : a.maxZ - s0;
    out.push({ id: newAabbId(), minX: x - 0.02, maxX: x + 0.02, minZ: z0, maxZ: z1, y0: a.y0 + 0.35, y1: a.y0 + GROUND_H - 1.2, kind: 'partition', hp: 99999, mat: 'glass', pane: 'shop', paneN: n });
  }
  return out;
}
