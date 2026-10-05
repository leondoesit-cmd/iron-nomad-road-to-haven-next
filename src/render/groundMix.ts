import { shoreShade } from '../world/lakes';
import { courseAt, hydroShade } from '../world/hydro';
import type { TerrainDef } from '../world/terrain';

/**
 * How the ground reads by water, shared by the detailed chunks, the far landscape and the reeds so all three agree: which
 * water a point belongs to (a lake, a river or stream, a spring's bowl, a swamp), how deep it lies under it and how damp it
 * is. `mixWater` then turns that into ground weights, wetness and a tint, the way `shoreShade` always did for lake shores.
 */

export type WetKind = 'lake' | 'course' | 'spring' | 'swamp';

export interface WetGround {
  kind: WetKind;
  /** Metres under the water (0 on dry ground). */
  depth: number;
  /** 0..1, 1 at and under the waterline. */
  damp: number;
  /** Inside the channel or the bowl. */
  bed: boolean;
}

const OUT: WetGround = { kind: 'lake', depth: 0, damp: 0, bed: false };

/** The water a ground point at height `h` belongs to, or null. The object is reused: read it before the next call. */
export function wetGround(def: TerrainDef, x: number, z: number, h: number): WetGround | null {
  if (def.lakes.length) {
    const s = shoreShade(def.lakes, x, z, h);
    if (s) {
      OUT.kind = 'lake';
      OUT.depth = s.depth;
      OUT.damp = s.damp;
      OUT.bed = s.depth > 0;
      return OUT;
    }
  }
  const hy = def.hydro;
  if (!hy) return null;
  const w = hydroShade(hy, x, z, h);
  if (!w) return null;
  OUT.depth = w.depth;
  OUT.damp = w.damp;
  OUT.bed = w.bed;
  // The same order `hydroShade` asks in: a course, then a spring, then a swamp.
  const c = courseAt(hy, x, z);
  if (c && (c.d < c.half + 0.3 || h - c.level < 1.6)) OUT.kind = 'course';
  else if (hy.springs.some((sp) => Math.hypot(x - sp.x, z - sp.z) <= sp.r + 4)) OUT.kind = 'spring';
  else OUT.kind = 'swamp';
  return OUT;
}

/** Ground weights (sand, earth, rock, gravel), wetness (0..1) and a vertex tint, as the terrain builders fill them in. */
export interface GroundMix {
  sand: number;
  earth: number;
  rock: number;
  gravel: number;
  wet: number;
  tr: number;
  tg: number;
  tb: number;
}

/**
 * Colour the ground for its water: damp sand on a lake's beach and a murky green-grey floor under it (as before); dark wet
 * banks and a gravelly, murky bed under rivers and streams; a pale stone bowl under a spring's pool; dark peat under a
 * swamp's water and sodden moss on the hummocks between.
 */
export function mixWater(m: GroundMix, w: WetGround) {
  const dk = Math.min(1, w.depth / 3);
  switch (w.kind) {
    case 'lake':
      m.rock *= 1 - w.damp;
      m.sand = Math.max(m.sand, w.damp * 0.9);
      m.earth *= 1 - w.damp * 0.8;
      m.wet = Math.max(m.wet, 0.35 + w.damp * 0.5);
      if (w.depth > 0) {
        m.gravel = 0.5 + w.depth * 0.1;
        m.tr = 0.62 - 0.3 * dk;
        m.tg = 0.82 - 0.24 * dk;
        m.tb = 0.78 - 0.18 * dk;
      }
      return;
    case 'course':
      m.rock *= 1 - w.damp * 0.85;
      if (w.bed) {
        m.gravel = Math.max(m.gravel, 0.8);
        m.sand = 0.3 * (1 - dk);
        m.earth *= 0.25;
        m.wet = Math.max(m.wet, 0.82);
        m.tr = 0.74 - 0.32 * dk;
        m.tg = 0.74 - 0.26 * dk;
        m.tb = 0.6 - 0.18 * dk;
      } else {
        m.earth = Math.max(m.earth, 0.7);
        m.sand *= 1 - w.damp * 0.75;
        m.gravel *= 1 - w.damp * 0.5;
        m.wet = Math.max(m.wet, 0.2 + w.damp * 0.58);
        const k = 1 - 0.18 * w.damp;
        m.tr = k * 0.97;
        m.tg = k;
        m.tb = k * 0.94;
      }
      return;
    case 'spring':
      m.rock *= 1 - w.damp;
      if (w.bed) {
        m.gravel = 0.55;
        m.sand = 0.7;
        m.earth *= 0.15;
        m.wet = Math.max(m.wet, 0.42);
        m.tr = 1.12 - 0.22 * dk;
        m.tg = 1.12 - 0.1 * dk;
        m.tb = 1.06 - 0.02 * dk;
      } else {
        m.earth = Math.max(m.earth, 0.6);
        m.sand *= 1 - w.damp * 0.5;
        m.wet = Math.max(m.wet, 0.2 + w.damp * 0.4);
      }
      return;
    case 'swamp':
      m.rock *= 0.15;
      m.sand *= 0.15;
      m.earth = 1;
      if (w.depth > 0) {
        m.gravel = 0.1;
        m.wet = Math.max(m.wet, 0.86);
        m.tr = 0.52 - 0.18 * dk;
        m.tg = 0.47 - 0.14 * dk;
        m.tb = 0.34 - 0.1 * dk;
      } else {
        // Above the water the hummocks are sodden but green: wet enough to darken, not so wet the moss gives way to mud.
        m.gravel *= 0.3;
        m.wet = 0.3 + 0.12 * w.damp;
        m.tr = 0.82;
        m.tg = 0.8;
        m.tb = 0.7;
      }
      return;
  }
}
