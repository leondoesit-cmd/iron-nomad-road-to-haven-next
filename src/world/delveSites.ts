import type { LegDef } from '../data';
import { Rng } from '../core/rng';
import { nearHydro } from './hydro';
import { corridorHalf, roadX, type Site, type SiteKind, type TerrainDef } from './terrain';
import type { PropKind } from './layout';

/**
 * Ways underground. Each one is a place on the surface (a cave mouth, a mine adit, a bunker hatch, a metro stair)
 * that leads to a generated delve: see world/delve.ts for what is down there.
 */

export type DelveTheme = 'cave' | 'mine' | 'bunker' | 'metro';

export interface DelveSite {
  /** Stable within a leg: the delve's saved state (cleared, loot taken) hangs off it. */
  id: string;
  theme: DelveTheme;
  /** The mouth: where a player stands to go in. */
  x: number;
  z: number;
  /** Which way the entrance faces (a cardinal direction), so its colliders are axis-aligned boxes. */
  yaw: number;
  seed: number;
  name: string;
  /** 1 to 3: scales the dead, the loot and the size of the place. */
  tier: number;
  /** True for a cave on a lake island: reachable only by water. */
  island: boolean;
}

export const DELVE_NAMES: Record<DelveTheme, string[]> = {
  cave: ['The Hollow', 'Whisper Cavern', 'Gullet Cave', 'The Sump', 'Smuggler’s Cave', 'Bat Cathedral'],
  mine: ['Dry Gulch Mine', 'The Old Diggings', 'Copperhead Adit', 'Number Nine Shaft', 'Widow’s Seam'],
  bunker: ['Shelter 14', 'The Silo Annex', 'Civil Defence Post', 'Bunker Delta', 'The Cold Store'],
  metro: ['Halstead Station', 'Pier Street Metro', 'Central Exchange', 'Canal Junction', 'The Undercroft'],
};

/** The prop that marks each theme's way in. */
export const ENTRANCE_PROP: Record<DelveTheme, PropKind> = {
  cave: 'caveMouth',
  mine: 'mineAdit',
  bunker: 'bunkerHatch',
  metro: 'metroEntrance',
};

export function delveName(theme: DelveTheme, seed: number) {
  const list = DELVE_NAMES[theme];
  return list[Math.abs(seed) % list.length];
}

/** Snap an angle to the nearest cardinal direction. */
export function snapYaw(yaw: number) {
  return Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2);
}

export const delveSiteKind = (theme: DelveTheme): SiteKind => (theme === 'mine' ? 'delveMine' : theme === 'bunker' ? 'delveBunker' : 'delveCave');

/**
 * One mainland entrance per wasteland leg, in the open country beside the road and clear of everything else.
 * The ground under it is levelled by a pad `Site` that the caller adds to the terrain.
 */
export function planMainlandDelve(def: TerrainDef, leg: LegDef): { delve: DelveSite; site: Site } | null {
  if (def.biome !== 'wasteland') return null;
  const rng = new Rng(leg.seed * 71 + 29);
  const theme: DelveTheme = def.theme === 'salt' ? 'bunker' : def.theme === 'cinder' ? 'cave' : 'mine';
  const free = (z: number) => !def.canyons.some((c) => z > c.z0 - 80 && z < c.z1 + 80);
  let z = leg.length * rng.range(0.38, 0.5);
  for (let t = 0; t < 60; t++, z += 70) {
    if (z > leg.length - 300) z = 700 + rng.range(0, 200);
    if (!free(z)) continue;
    const side = rng.sign();
    const ch = corridorHalf(def, z);
    const off = rng.range(52, 86);
    if (ch < off + 90) continue;
    const x = roadX(def, z) + side * off;
    // Keep clear of roadside places, lakes and the road itself.
    if (def.sites.some((s) => Math.hypot(s.x - x, s.z - z) < s.radius + 48 + (s.kind === 'windfarm' ? 120 : 0))) continue;
    if (def.lakes.some((l) => Math.hypot(l.x - x, l.z - z) < l.reach + 50)) continue;
    if (nearHydro(def, x, z, 50)) continue;
    if (def.ramps.some((r) => Math.abs(r.z0 - z) < 160) || def.minefields.some((m) => z > m.z0 - 80 && z < m.z1 + 80)) continue;
    // The mouth faces the road.
    const yaw = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    const seed = rng.int(1, 99999);
    const id = `${leg.id}:d0`;
    const delve: DelveSite = { id, theme, x, z, yaw, seed, name: delveName(theme, seed), tier: Math.min(3, leg.index), island: false };
    const site: Site = { kind: delveSiteKind(theme), z, side: side as -1 | 1, off, radius: 26, seed, x, delve: id };
    return { delve, site };
  }
  return null;
}
