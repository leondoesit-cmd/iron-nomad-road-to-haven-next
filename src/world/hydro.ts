import type { LegDef, OpenWaterSpec, WaterCourseSpec, XZ } from '../data';
import { Rng, hash2, noise2 } from '../core/rng';
import { clamp, lerp, smoothstep } from '../core/math';
import { baseHeight, duneness, heightAt, type TerrainDef } from './terrain';
import { districtMask, nearestRoad, type RoadPath } from './openWorld';
import { finishLake, fixedLake, lakeQ, nextIslandKind, type Lake, type WaterHit } from './lakes';

/**
 * The water of the open world, and the green land it makes: rivers and streams that wind from a spring or a waterfall off the
 * mountains down to a lake, a swamp or another river; spring pools; swamps; the big hand-set lakes; and a field of how lush
 * the ground is, which the ground shader, the ground cover and the woods all read.
 *
 * Everything is planned once from `OpenWaterSpec` (the anchors in `legs.json`) and the leg's seed, so the terrain mesh, the
 * physics heightfield, the water sheets and every `waterAt` query agree on where the water is. Like `lakes.ts` there is no
 * three.js here.
 *
 * A course is a centre-line sampled every `STEP` metres. Each sample has a water level (it only ever falls downstream), the
 * half-width of the water, the depth in mid-channel and the width of the bank over which the channel blends back into the
 * land. The level follows the ground it was cut into, a metre or so down; where the ground falls away steeply (the rim of
 * the map, or a step put in by hand) the level drops with it, and that is a waterfall.
 */

export const STEP = 3;
/** Cell of the course index (metres). */
const GRID = 32;
const cellKey = (ix: number, iz: number) => (ix + 4096) * 8192 + (iz + 4096);
/** Metres a ford leaves over the bed where a dirt track crosses running water. */
export const FORD_DEPTH = 0.26;
/** How steep a drop (metres of level per metre along) makes a waterfall. */
const FALL_SLOPE = 0.35;
/** Lushness raster cell (metres). */
const LUSH_CELL = 8;

export type CourseKind = 'river' | 'stream';
export type Woods = 'broadleaf' | 'pine' | 'fen' | 'riparian';
const WOODS: Woods[] = ['broadleaf', 'pine', 'fen', 'riparian'];

export interface River {
  id: number;
  key: string;
  name: string;
  kind: CourseKind;
  /** Samples along the centre-line, source first. */
  n: number;
  x: Float32Array;
  z: Float32Array;
  /** Distance from the source. */
  s: Float32Array;
  /** Water level. Never rises downstream. */
  level: Float32Array;
  /** Half the width of the water. */
  half: Float32Array;
  /** Depth of water in mid-channel. */
  depth: Float32Array;
  /** Beyond the water, the channel blends back into the land over this many metres. */
  bank: Float32Array;
  /** Unit direction of flow. */
  dx: Float32Array;
  dz: Float32Array;
  /** Surface current, metres per second. */
  speed: Float32Array;
  /** The ground the course was cut into (lowest point across the channel). */
  ground: Float32Array;
  /** Where it ends, and the first sample inside that water (draw the ribbon up to here). */
  into: { kind: 'lake' | 'swamp' | 'river'; ref: number };
  end: number;
  /** Born at a waterfall off the mountains rather than a spring. */
  rim: boolean;
  spring: number;
}

export interface Waterfall {
  id: number;
  river: number;
  name: string;
  /** The drop runs over these samples. */
  i0: number;
  i1: number;
  /** The lip. */
  x: number;
  z: number;
  top: number;
  bottom: number;
  /** Direction of flow over the lip, and half the width of the sheet. */
  dx: number;
  dz: number;
  half: number;
  /** Off the mountains at the edge of the map. */
  rim: boolean;
}

export interface Spring {
  id: number;
  key: string;
  name: string;
  x: number;
  z: number;
  r: number;
  level: number;
  depth: number;
  oasis: boolean;
  seed: number;
  /** The course it feeds, or -1. */
  feeds: number;
}

export interface Swamp {
  id: number;
  key: string;
  name: string;
  x: number;
  z: number;
  r: number;
  rot: number;
  ax: number;
  shape: [number, number, number, number, number, number];
  level: number;
  seed: number;
  /** Beyond this many metres from the centre the swamp changes nothing. */
  reach: number;
}

/** Where a road meets running water. Asphalt crosses on a causeway with a bridge over it; a dirt track fords. */
export interface Crossing {
  river: number;
  /** Sample of the river at the crossing. */
  i: number;
  road: RoadPath;
  x: number;
  z: number;
  /** Heading of the road (atan2 of its x, z direction). */
  yaw: number;
  /** How much of the road the water and its banks take up, along the road. */
  span: number;
  roadHalf: number;
  level: number;
  /** Height of the road surface. */
  y: number;
}

export interface GreenZone {
  key: string;
  x: number;
  z: number;
  r: number;
  lush: number;
  woods: Woods;
}

export interface Hydro {
  spec: OpenWaterSpec;
  rivers: River[];
  falls: Waterfall[];
  springs: Spring[];
  swamps: Swamp[];
  crossings: Crossing[];
  greens: GreenZone[];
  /** Indices into `TerrainDef.lakes` of the hand-set lakes. */
  lakes: number[];
  /** Set once the levels are worked out: until then the terrain is not carved. */
  ready: boolean;
  /** Course segments by 32 m cell: flat (river, sample) pairs. */
  grid: Map<number, number[]>;
  /** Lushness 0..255 and the kind of wood that grows, per 8 m cell over the map. */
  lush: Uint8Array | null;
  woods: Uint8Array | null;
  /** Water reach (metres to spare): how close the nearest water is, per cell. */
  wet: Float32Array | null;
  lw: number;
  lh: number;
  lx0: number;
  lz0: number;
  /** Mesas that stand aside for the water, by their cell of the mesa grid (cleared when the water changes). */
  mesaCache: Map<number, boolean>;
}

// ------------------------------------------------------------------------------------------------ shapes

export function swampQ(s: Swamp, x: number, z: number): number {
  const dx = x - s.x;
  const dz = z - s.z;
  if (Math.abs(dx) > s.reach || Math.abs(dz) > s.reach) return Infinity;
  const c = Math.cos(s.rot);
  const sn = Math.sin(s.rot);
  const u = (dx * c + dz * sn) / s.ax;
  const v = (-dx * sn + dz * c) * s.ax;
  const d = Math.hypot(u, v);
  const th = Math.atan2(v, u);
  const sh = s.shape;
  const rr = s.r * (1 + sh[0] * Math.sin(2 * th + sh[1]) + sh[2] * Math.sin(3 * th + sh[3]) + sh[4] * Math.sin(5 * th + sh[5]));
  return d / rr;
}

/** The floor of a swamp: sodden hummocks round the waterline, with open pools between them. */
export function swampBed(s: Swamp, x: number, z: number, q: number): number {
  const hum = (noise2(x / 11, z / 11, s.seed) - 0.5) * 1.5 + (noise2(x / 4.2, z / 4.2, s.seed + 1) - 0.5) * 0.45 + 0.08;
  const pool = smoothstep(0.66, 0.8, noise2(x / 23 + 5, z / 23 - 3, s.seed + 2)) * 1.1;
  const core = 1 - smoothstep(0.62, 1.0, q);
  return s.level + (hum - pool) * core + 0.45 * smoothstep(0.75, 1.0, q);
}

function swampAdjust(s: Swamp, x: number, z: number, h: number): number {
  const q = swampQ(s, x, z);
  if (q >= 1.4) return h;
  const w = 1 - smoothstep(0.95, 1.4, q);
  return lerp(h, swampBed(s, x, z, q), w);
}

/** A spring pool: a round bowl with a low rim. */
function springAdjust(sp: Spring, x: number, z: number, h: number): number {
  const d = Math.hypot(x - sp.x, z - sp.z);
  if (d > sp.r + 9) return h;
  if (d < sp.r) {
    const u = d / sp.r;
    return sp.level - sp.depth * Math.pow(1 - u * u, 0.8) + (noise2(x / 2.5, z / 2.5, sp.seed) - 0.5) * 0.15;
  }
  const t = smoothstep(0, 1, (d - sp.r) / 9);
  return lerp(sp.level + 0.3, h, t);
}

// ------------------------------------------------------------------------------------------------ course queries

export interface CourseHit {
  river: River;
  /** Segment start sample and the fraction along it. */
  i: number;
  t: number;
  /** Distance from the centre-line, and which side (+1 left of the flow, -1 right). */
  d: number;
  side: number;
  level: number;
  half: number;
  depth: number;
  bank: number;
}

const HITS: CourseHit[] = [];
const hitPool: CourseHit[] = [];
function poolHit(k: number): CourseHit {
  let h = hitPool[k];
  if (!h) hitPool[k] = h = { river: null as unknown as River, i: 0, t: 0, d: 0, side: 1, level: 0, half: 0, depth: 0, bank: 0 };
  return h;
}

/**
 * The nearest point of each course whose channel or bank reaches (x, z), at most one per course. The array and its objects
 * are reused: read them before the next call.
 */
export function coursesNear(hy: Hydro, x: number, z: number, pad = 0): CourseHit[] {
  HITS.length = 0;
  const cell = hy.grid.get(cellKey(Math.floor(x / GRID), Math.floor(z / GRID)));
  if (!cell) return HITS;
  for (let k = 0; k < cell.length; k += 2) {
    const r = hy.rivers[cell[k]];
    const i = cell[k + 1];
    const ax = r.x[i];
    const az = r.z[i];
    const ex = r.x[i + 1] - ax;
    const ez = r.z[i + 1] - az;
    const l2 = ex * ex + ez * ez;
    const t = l2 > 0 ? clamp(((x - ax) * ex + (z - az) * ez) / l2, 0, 1) : 0;
    const px = ax + ex * t;
    const pz = az + ez * t;
    const d = Math.hypot(x - px, z - pz);
    const half = r.half[i] + (r.half[i + 1] - r.half[i]) * t;
    const bank = r.bank[i] + (r.bank[i + 1] - r.bank[i]) * t;
    if (d > half + bank + pad) continue;
    let slot = -1;
    for (let q = 0; q < HITS.length; q++) if (HITS[q].river === r) slot = q;
    if (slot >= 0 && HITS[slot].d <= d) continue;
    const h = slot >= 0 ? HITS[slot] : poolHit(HITS.length);
    h.river = r;
    h.i = i;
    h.t = t;
    h.d = d;
    h.side = ex * (z - az) - ez * (x - ax) > 0 ? 1 : -1;
    h.level = r.level[i] + (r.level[i + 1] - r.level[i]) * t;
    h.half = half;
    h.depth = r.depth[i] + (r.depth[i + 1] - r.depth[i]) * t;
    h.bank = bank;
    if (slot < 0) HITS.push(h);
  }
  return HITS;
}

/** The nearest course to a point within its banks (plus `pad`), or null. */
export function courseAt(hy: Hydro, x: number, z: number, pad = 0): CourseHit | null {
  const hits = coursesNear(hy, x, z, pad);
  let best: CourseHit | null = null;
  for (const h of hits) if (!best || h.d - h.half < best.d - best.half) best = h;
  return best;
}

/** Bed of a course across its channel: a rounded trough, its waterline exactly at the half-width. */
function channelBed(h: CourseHit): number {
  const u = h.d / h.half;
  return h.level - h.depth * Math.pow(Math.max(0, 1 - u * u), 0.7);
}

/** The ground at (x, z) once a course has been cut into it. */
function courseCut(def: TerrainDef, h: CourseHit, x: number, z: number, ground: number): number {
  let out: number;
  if (h.d < h.half) out = channelBed(h);
  else {
    // A strip of flat floodplain by the water, then the valley side.
    const t = smoothstep(0.12, 1, (h.d - h.half) / Math.max(1, h.bank));
    out = lerp(h.level + 0.35 + 0.25 * Math.min(1, (h.d - h.half) / 4), ground, t);
  }
  // Roads: asphalt crosses on a causeway (the water passes under in culverts), a dirt track on a ford of gravel.
  const o = def.open;
  if (o) {
    const rd = nearestRoad(o, x, z);
    if (rd.road && rd.edge < 7) {
      if (rd.road.kind === 'track') {
        const k = 1 - smoothstep(0.5, 6, rd.edge);
        if (k > 0 && out < h.level - FORD_DEPTH) out = lerp(out, h.level - FORD_DEPTH, k);
      } else {
        const k = 1 - smoothstep(3.0, 4.4, rd.edge);
        if (k > 0) out = lerp(out, Math.max(ground, h.level + 0.6), k);
      }
    }
  }
  return out;
}

/** The terrain `h` at (x, z) with every course, spring and swamp cut into it. Called by `heightAt` after the lakes. */
export function hydroAdjust(def: TerrainDef, hy: Hydro, x: number, z: number, h: number): number {
  if (!hy.ready) return h;
  let out = h;
  for (const s of hy.swamps) if (Math.abs(x - s.x) < s.reach && Math.abs(z - s.z) < s.reach) out = swampAdjust(s, x, z, out);
  for (const sp of hy.springs) if (Math.abs(x - sp.x) < sp.r + 9 && Math.abs(z - sp.z) < sp.r + 9) out = springAdjust(sp, x, z, out);
  const hits = coursesNear(hy, x, z);
  if (hits.length) {
    const ground = out;
    let cut = Infinity;
    let mouth = false;
    for (const c of hits) {
      cut = Math.min(cut, courseCut(def, c, x, z, ground));
      if (c.i >= c.river.end - 6 || (c.river.spring >= 0 && c.i < 6)) mouth = true;
    }
    // A bank stands up out of low ground to hold the water in, except where the course runs into a lake or swamp, or out of
    // its spring: there the deeper of the two floors wins, so the mouth stays open and the pool keeps its depth.
    out = mouth ? Math.min(ground, cut) : cut;
  }
  return out;
}

/** Running water, a spring pool or a swamp at a point, or null. Lakes are `lakeWater`'s. */
export function hydroWater(def: TerrainDef, hy: Hydro, x: number, z: number): WaterHit | null {
  if (!hy.ready) return null;
  // A spring's pool first: the stream it feeds starts in the middle of it.
  for (const sp of hy.springs) {
    if (Math.abs(x - sp.x) > sp.r + 1 || Math.abs(z - sp.z) > sp.r + 1) continue;
    const bed = heightAt(def, x, z);
    if (bed < sp.level - 0.02) return { kind: 'spring', style: 'spring', level: sp.level, depth: sp.level - bed, ref: sp.id, name: sp.name };
  }
  const c = courseAt(hy, x, z);
  if (c && c.d < c.half + 1.5) {
    // Copy out of the pooled hit: `heightAt` below runs the same query again.
    const r = c.river;
    const i = c.i;
    const level = c.level;
    const side = c.side;
    const sp = r.speed[i] + (r.speed[i + 1] - r.speed[i]) * c.t;
    const toBank = 0.18 * sp * smoothstep(0.2, 0.9, c.d / c.half);
    const depth = level - heightAt(def, x, z);
    if (depth > 0.02) {
      // Down the stream, and a little toward the nearer bank, so a swamped car fetches up against it.
      const fx = r.dx[i] * sp - r.dz[i] * side * toBank;
      const fz = r.dz[i] * sp + r.dx[i] * side * toBank;
      return { kind: r.kind, style: 'river', level, depth, ref: r.id, flow: [fx, fz], name: r.name };
    }
  }
  for (const s of hy.swamps) {
    if (swampQ(s, x, z) >= 1.05) continue;
    const bed = heightAt(def, x, z);
    if (bed < s.level - 0.02) {
      const dx = x - s.x;
      const dz = z - s.z;
      const m = Math.hypot(dx, dz) || 1;
      return { kind: 'swamp', style: 'swamp', level: s.level, depth: s.level - bed, ref: s.id, flow: [(dx / m) * 0.25, (dz / m) * 0.25], name: s.name };
    }
  }
  return null;
}

/** Wet ground: the channel and the first metre of bank, a swamp, a spring's bowl. Surface 'mud'. */
export function hydroMud(hy: Hydro, x: number, z: number): boolean {
  if (!hy.ready) return false;
  const c = courseAt(hy, x, z);
  if (c && c.d < c.half + 1.2) return true;
  for (const s of hy.swamps) if (swampQ(s, x, z) < 1.08) return true;
  for (const sp of hy.springs) if (Math.hypot(x - sp.x, z - sp.z) < sp.r + 1) return true;
  return false;
}

/**
 * How a ground point reads beside running water, a spring or a swamp: metres under water and how damp it is (0..1), and
 * whether it is a gravelly river bed. For the terrain colouring, like `shoreShade` is for lakes.
 */
export function hydroShade(hy: Hydro, x: number, z: number, h: number): { depth: number; damp: number; bed: boolean } | null {
  if (!hy.ready) return null;
  const c = courseAt(hy, x, z);
  if (c) {
    if (c.d < c.half + 0.3) return { depth: Math.max(0, c.level - h), damp: 1, bed: true };
    const up = h - c.level;
    if (up < 1.6) return { depth: 0, damp: 1 - smoothstep(0, 1.6, up), bed: false };
  }
  for (const sp of hy.springs) {
    const d = Math.hypot(x - sp.x, z - sp.z);
    if (d > sp.r + 4) continue;
    return { depth: Math.max(0, sp.level - h), damp: 1 - smoothstep(sp.r, sp.r + 4, d), bed: d < sp.r };
  }
  for (const s of hy.swamps) {
    const q = swampQ(s, x, z);
    if (q > 1.3) continue;
    return { depth: Math.max(0, s.level - h), damp: 1 - smoothstep(1.0, 1.3, q) * 0.7, bed: false };
  }
  return null;
}

/**
 * 1 where a course runs (water and banks, and a margin), 0 well clear of it. The renderers multiply the visual cliff crags by
 * `1 - calm` so a waterfall off the rim pours down a clean notch instead of through the rock.
 */
export function hydroCalm(hy: Hydro | undefined, x: number, z: number): number {
  if (!hy?.ready) return 0;
  const c = courseAt(hy, x, z, 10);
  if (!c) return 0;
  return 1 - smoothstep(c.half + 3, c.half + c.bank * 0.6 + 6, c.d);
}

/** True if (x, z) is within `pad` metres of any water of the network or its banks (hand-set lakes included). For placing things. */
export function nearHydro(def: TerrainDef, x: number, z: number, pad: number): boolean {
  const hy = def.hydro;
  if (!hy) return false;
  for (const r of hy.rivers) {
    // Courses are long: test every fourth sample, padded by the spacing.
    for (let i = 0; i < r.n; i += 4) {
      const lim = r.half[i] + (hy.ready ? r.bank[i] : 8) + pad + STEP * 2;
      const dx = x - r.x[i];
      const dz = z - r.z[i];
      if (dx * dx + dz * dz < lim * lim) return true;
    }
  }
  for (const sp of hy.springs) if (Math.hypot(x - sp.x, z - sp.z) < sp.r + 9 + pad) return true;
  for (const s of hy.swamps) if (Math.hypot(x - s.x, z - s.z) < s.reach + pad) return true;
  for (const li of hy.lakes) {
    const l = def.lakes[li];
    if (l && Math.hypot(x - l.x, z - l.z) < l.reach + pad) return true;
  }
  return false;
}

/** Whether a mesa of the open world (cell `key` of its grid, centre and radius) must stand aside for the water. Cached. */
export function mesaBlocked(def: TerrainDef, key: number, xc: number, zc: number, r: number): boolean {
  const hy = def.hydro;
  if (!hy) return false;
  let v = hy.mesaCache.get(key);
  if (v === undefined) hy.mesaCache.set(key, (v = nearHydro(def, xc, zc, r * 1.1 + 30)));
  return v;
}

// ------------------------------------------------------------------------------------------------ lushness

/** How green the land is at a point, 0 (bare dust) to 1 (meadow and wood). 0 everywhere off the open world. */
export function lushAt(def: TerrainDef, x: number, z: number): number {
  const hy = def.hydro;
  if (!hy?.lush) return 0;
  const v = sampleRaster(hy, hy.lush, x, z) / 255;
  if (v <= 0) return 0;
  return clamp(v + (noise2(x / 37 + 4, z / 37 - 9, def.seed + 331) - 0.5) * 0.18 * v, 0, 1);
}

/** Metres of reach to spare from the nearest water (rivers and lakes reach ~120 m, streams ~60 m); negative far from any. */
export function wetReach(def: TerrainDef, x: number, z: number): number {
  const hy = def.hydro;
  if (!hy?.wet) return -1e3;
  return sampleRasterF(hy, hy.wet, x, z);
}

/** The kind of wood that would grow at a point. */
export function woodsAt(def: TerrainDef, x: number, z: number): Woods {
  const hy = def.hydro;
  if (!hy?.woods) return 'broadleaf';
  const i = clamp(Math.floor((x - hy.lx0) / LUSH_CELL), 0, hy.lw - 1);
  const j = clamp(Math.floor((z - hy.lz0) / LUSH_CELL), 0, hy.lh - 1);
  return WOODS[hy.woods[j * hy.lw + i]];
}

/**
 * Density of wood at a point, 0..1: woods grow in clumps on the lush ground, with clearings and meadows between them.
 * Roads, water and places are the planter's business (`world/flora.ts`), not this field's.
 */
export function forestAt(def: TerrainDef, x: number, z: number): number {
  const L = lushAt(def, x, z);
  if (L < 0.42) return 0;
  const n = noise2(x / 210 + 3, z / 210 - 7, def.seed + 301) * 0.62 + noise2(x / 64 - 2, z / 64 + 5, def.seed + 302) * 0.38;
  return smoothstep(0.44, 0.6, n + (L - 0.65) * 0.55) * smoothstep(0.42, 0.62, L);
}

function sampleRaster(hy: Hydro, r: Uint8Array, x: number, z: number): number {
  const fx = (x - hy.lx0) / LUSH_CELL - 0.5;
  const fz = (z - hy.lz0) / LUSH_CELL - 0.5;
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  if (i < 0 || j < 0 || i >= hy.lw - 1 || j >= hy.lh - 1) return 0;
  const tx = fx - i;
  const tz = fz - j;
  const k = j * hy.lw + i;
  const a = r[k];
  const b = r[k + 1];
  const c = r[k + hy.lw];
  const d = r[k + hy.lw + 1];
  return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
}

function sampleRasterF(hy: Hydro, r: Float32Array, x: number, z: number): number {
  const fx = (x - hy.lx0) / LUSH_CELL - 0.5;
  const fz = (z - hy.lz0) / LUSH_CELL - 0.5;
  const i = clamp(Math.floor(fx), 0, hy.lw - 2);
  const j = clamp(Math.floor(fz), 0, hy.lh - 2);
  const tx = clamp(fx - i, 0, 1);
  const tz = clamp(fz - j, 0, 1);
  const k = j * hy.lw + i;
  const a = r[k];
  const b = r[k + 1];
  const c = r[k + hy.lw];
  const d = r[k + hy.lw + 1];
  return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
}

// ------------------------------------------------------------------------------------------------ planning

/**
 * Plan the water network of an open-world leg: the big lakes (added to `def.lakes`), springs, swamps and courses. Call it once
 * the roads exist and before the places are planned (they keep clear of the water). The lushness field waits for every lake
 * of the leg: `finishHydro` makes it.
 */
export function planHydro(def: TerrainDef, leg: LegDef): Hydro | null {
  const spec = leg.open?.water;
  const o = def.open;
  if (!spec || !o) return null;
  const rng = new Rng(leg.seed * 61 + 23);
  const hy: Hydro = {
    spec,
    rivers: [],
    falls: [],
    springs: [],
    swamps: [],
    crossings: [],
    greens: spec.greens.map((g) => ({ key: g.id, x: g.x, z: g.z, r: g.r, lush: g.lush, woods: g.woods })),
    lakes: [],
    ready: false,
    grid: new Map(),
    lush: null,
    woods: null,
    wet: null,
    lw: 0,
    lh: 0,
    lx0: 0,
    lz0: 0,
    mesaCache: new Map(),
  };
  // The geometry goes in first, so the mesas know to keep out of the way of the water before any level is worked out.
  def.hydro = hy;
  const lakeIds = new Map<string, number>();
  for (const ls of spec.lakes) {
    const id = def.lakes.length;
    const lake = fixedLake(def, rng, ls.x, ls.z, ls.r, ls.ax ?? 1, ls.rot ?? 0, id);
    lake.name = ls.name;
    def.lakes.push(lake);
    hy.lakes.push(id);
    lakeIds.set(ls.id, id);
  }
  // The lakes' first levels were taken with mesas still standing where the water now is: take them again.
  for (const li of hy.lakes) def.lakes[li].level = ringLevel(def, def.lakes[li]);
  const springIds = new Map<string, number>();
  for (const ss of spec.springs) {
    const sp: Spring = { id: hy.springs.length, key: ss.id, name: ss.name, x: ss.x, z: ss.z, r: ss.r, level: 0, depth: 1.1 + ss.r * 0.06, oasis: !!ss.oasis, seed: rng.int(1, 99999), feeds: -1 };
    springIds.set(ss.id, sp.id);
    hy.springs.push(sp);
  }
  const swampIds = new Map<string, number>();
  for (const sw of spec.swamps) {
    const ax = sw.ax ?? 1;
    const s: Swamp = {
      id: hy.swamps.length,
      key: sw.id,
      name: sw.name,
      x: sw.x,
      z: sw.z,
      r: sw.r,
      rot: sw.rot ?? 0,
      ax,
      shape: [rng.range(0.05, 0.13), rng.range(0, 6.28), rng.range(0.04, 0.09), rng.range(0, 6.28), rng.range(0.02, 0.05), rng.range(0, 6.28)],
      level: 0,
      seed: rng.int(1, 99999),
      reach: sw.r * 1.25 * 1.4 * Math.max(ax, 1 / ax),
    };
    swampIds.set(sw.id, s.id);
    hy.swamps.push(s);
  }
  // Course centre-lines.
  const riverIds = new Map<string, number>();
  for (const cs of spec.rivers) {
    const r = layCourse(def, hy, cs, rng, lakeIds, swampIds, springIds, riverIds);
    if (!r) continue;
    riverIds.set(cs.id, r.id);
    hy.rivers.push(r);
    if (r.spring >= 0) hy.springs[r.spring].feeds = r.id;
  }
  hy.mesaCache.clear();
  // Levels, now that the mesas have stood aside.
  for (const sp of hy.springs) {
    let lo = Infinity;
    for (let a = 0; a < 12; a++) {
      const th = (a / 12) * Math.PI * 2;
      lo = Math.min(lo, baseHeight(def, sp.x + Math.cos(th) * (sp.r + 3), sp.z + Math.sin(th) * (sp.r + 3)));
    }
    sp.level = Math.min(lo, baseHeight(def, sp.x, sp.z)) - 0.35;
  }
  for (const s of hy.swamps) {
    const ring: number[] = [];
    for (let a = 0; a < 36; a++) {
      const th = (a / 36) * Math.PI * 2;
      for (const k of [1.1, 1.3]) ring.push(baseHeight(def, s.x + Math.cos(th) * s.r * k * s.ax, s.z + Math.sin(th) * (s.r * k) / s.ax));
    }
    ring.sort((p, q) => p - q);
    s.level = ring[Math.floor(ring.length * 0.3)] - 0.3;
  }
  // Free levels: each course falls from its source, a metre or so under the ground it crosses, stepping down at its falls.
  const free: Float32Array[] = [];
  const steps: { i: number; name: string }[][] = [];
  for (const r of hy.rivers) {
    let target: number;
    if (r.into.kind === 'lake') target = def.lakes[r.into.ref].level - 2.5;
    else if (r.into.kind === 'swamp') target = hy.swamps[r.into.ref].level - 2;
    else {
      const tr = hy.rivers[r.into.ref];
      const tl = free[r.into.ref];
      let best = 0;
      for (let i = 0; i < tr.n; i++) if (Math.hypot(tr.x[i] - r.x[r.n - 1], tr.z[i] - r.z[r.n - 1]) < Math.hypot(tr.x[best] - r.x[r.n - 1], tr.z[best] - r.z[r.n - 1])) best = i;
      target = tl[best];
    }
    const st: { i: number; name: string }[] = [];
    free.push(freeLevels(def, hy, r, spec.rivers.find((c) => c.id === r.key)!, target, st));
    steps.push(st);
  }
  // A lake or swamp sits as low as the courses that arrive in it (within reason), so none of them has to climb.
  for (let k = 0; k < hy.rivers.length; k++) {
    const r = hy.rivers[k];
    const lEnd = free[k][Math.max(0, r.end - 1)];
    if (r.into.kind === 'lake') {
      const l = def.lakes[r.into.ref];
      l.level = Math.min(l.level, Math.max(lEnd - 0.1, l.level - 2.5));
    } else if (r.into.kind === 'swamp') {
      const s = hy.swamps[r.into.ref];
      s.level = Math.min(s.level, Math.max(lEnd - 0.1, s.level - 2));
    }
  }
  for (let k = 0; k < hy.rivers.length; k++) settleCourse(def, hy, hy.rivers[k], free[k]);
  // The big lakes get their islands and piers at their final level.
  const kinds = nextIslandKind(rng);
  for (const li of hy.lakes) finishLake(def, def.lakes[li], rng, li === hy.lakes[0], kinds);
  for (const r of hy.rivers) indexCourse(hy, r);
  findFalls(hy, spec, steps);
  findCrossings(def, hy);
  hy.ready = true;
  hy.mesaCache.clear();
  return hy;
}

/** A lake's level from the ground round it (the same rule `lakes.ts` uses). */
function ringLevel(def: TerrainDef, l: Lake): number {
  const ring: number[] = [];
  const c = Math.cos(l.rot);
  const s = Math.sin(l.rot);
  for (let a = 0; a < 32; a++) {
    const th = (a / 32) * Math.PI * 2;
    for (const k of [1.08, 1.3]) {
      const u = Math.cos(th) * l.r * k * l.ax;
      const v = (Math.sin(th) * l.r * k) / l.ax;
      ring.push(baseHeight(def, l.x + u * c - v * s, l.z + u * s + v * c));
    }
  }
  ring.sort((p, q) => p - q);
  return ring[Math.floor(ring.length * 0.22)] - 0.15;
}

/** The centre-line of a course: a smooth curve through its anchors, a meander laid over it, cut off inside what it runs into. */
function layCourse(
  def: TerrainDef,
  hy: Hydro,
  cs: WaterCourseSpec,
  rng: Rng,
  lakeIds: Map<string, number>,
  swampIds: Map<string, number>,
  springIds: Map<string, number>,
  riverIds: Map<string, number>,
): River | null {
  const o = def.open!;
  let src: XZ;
  let rim = false;
  let spring = -1;
  if ('spring' in cs.from) {
    spring = springIds.get(cs.from.spring) ?? -1;
    if (spring < 0) return null;
    src = [hy.springs[spring].x, hy.springs[spring].z];
  } else {
    rim = true;
    const at = cs.from.at;
    // On the mountain shoulder above the cliff, so the water comes over the lip.
    src = cs.from.rim === 'west' ? [o.x0 - 26, at] : cs.from.rim === 'east' ? [o.x1 + 26, at] : [at, o.z1 + 30];
  }
  let into: River['into'];
  let target: XZ;
  if ('lake' in cs.to) {
    const li = lakeIds.get(cs.to.lake);
    if (li === undefined) return null;
    into = { kind: 'lake', ref: li };
    target = [def.lakes[li].x, def.lakes[li].z];
  } else if ('swamp' in cs.to) {
    const si = swampIds.get(cs.to.swamp);
    if (si === undefined) return null;
    into = { kind: 'swamp', ref: si };
    target = [hy.swamps[si].x, hy.swamps[si].z];
  } else {
    const ri = riverIds.get(cs.to.river);
    if (ri === undefined) return null;
    into = { kind: 'river', ref: ri };
    const tr = hy.rivers[ri];
    const last = cs.via.length ? cs.via[cs.via.length - 1] : src;
    let best = 0;
    for (let i = 0; i < tr.end; i++) if (Math.hypot(tr.x[i] - last[0], tr.z[i] - last[1]) < Math.hypot(tr.x[best] - last[0], tr.z[best] - last[1])) best = i;
    target = [tr.x[best], tr.z[best]];
  }
  const ctrl: XZ[] = [src, ...cs.via, target];
  // Catmull-Rom through the anchors, finely.
  const fine: number[] = [];
  for (let k = 0; k < ctrl.length - 1; k++) {
    const p0 = ctrl[Math.max(0, k - 1)];
    const p1 = ctrl[k];
    const p2 = ctrl[k + 1];
    const p3 = ctrl[Math.min(ctrl.length - 1, k + 2)];
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const m = Math.max(2, Math.ceil(len));
    for (let q = 0; q < m; q++) {
      const t = q / m;
      const t2 = t * t;
      const t3 = t2 * t;
      const cr = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      fine.push(cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1]));
    }
  }
  fine.push(target[0], target[1]);
  const base = resample(fine, STEP);
  // Meander: a sideways wander that is nil at the source (a waterfall pours straight off the rim) and at the mouth.
  const amp = cs.meander ?? 20;
  const p1 = rng.range(0, 6.28);
  const p2 = rng.range(0, 6.28);
  const total = base.s[base.n - 1];
  const wavy: number[] = [];
  for (let i = 0; i < base.n; i++) {
    const s = base.s[i];
    const env = smoothstep(rim ? 60 : 10, rim ? 200 : 90, s) * smoothstep(0, 140, total - s);
    const off = amp * env * (0.62 * Math.sin((s / 230) * Math.PI * 2 + p1) + 0.38 * Math.sin((s / 87) * Math.PI * 2 + p2));
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(base.n - 1, i + 1);
    const tx = base.x[i1] - base.x[i0];
    const tz = base.z[i1] - base.z[i0];
    const tl = Math.hypot(tx, tz) || 1;
    wavy.push(base.x[i] - (tz / tl) * off, base.z[i] + (tx / tl) * off);
  }
  const path = resample(wavy, STEP);
  // Cut it off a little way inside the water it runs into; `end` is where that water begins.
  let n = path.n;
  let end = path.n - 1;
  const inside = (x: number, z: number, deep: boolean) => {
    if (into.kind === 'lake') return lakeQ(def.lakes[into.ref], x, z) < (deep ? 0.82 : 1.0);
    if (into.kind === 'swamp') return swampQ(hy.swamps[into.ref], x, z) < (deep ? 0.6 : 0.92);
    const tr = hy.rivers[into.ref];
    let d = Infinity;
    let hf = 1;
    for (let i = 0; i < tr.n; i += 1) {
      const dd = Math.hypot(tr.x[i] - x, tr.z[i] - z);
      if (dd < d) {
        d = dd;
        hf = tr.half[i] || 4;
      }
    }
    return d < (deep ? hf * 0.35 : hf + 0.5);
  };
  for (let i = 0; i < path.n; i++) {
    if (end === path.n - 1 && inside(path.x[i], path.z[i], false)) end = i;
    if (inside(path.x[i], path.z[i], true)) {
      n = i + 1;
      break;
    }
  }
  end = Math.min(end, n - 1);
  const mk = () => new Float32Array(n);
  const r: River = {
    id: hy.rivers.length,
    key: cs.id,
    name: cs.name,
    kind: cs.kind,
    n,
    x: path.x.slice(0, n),
    z: path.z.slice(0, n),
    s: path.s.slice(0, n),
    level: mk(),
    half: mk(),
    depth: mk(),
    bank: mk(),
    dx: mk(),
    dz: mk(),
    speed: mk(),
    ground: mk(),
    into,
    end,
    rim,
    spring,
  };
  const S = r.s[n - 1] || 1;
  for (let i = 0; i < n; i++) {
    const u = r.s[i] / S;
    r.half[i] = lerp(cs.half[0], cs.half[1], Math.pow(u, 0.8));
    r.depth[i] = lerp(cs.depth[0], cs.depth[1], u);
    r.bank[i] = cs.kind === 'river' ? 8 : 4;
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(n - 1, i + 1);
    const tx = r.x[i1] - r.x[i0];
    const tz = r.z[i1] - r.z[i0];
    const tl = Math.hypot(tx, tz) || 1;
    r.dx[i] = tx / tl;
    r.dz[i] = tz / tl;
  }
  return r;
}

/** A polyline resampled at an even spacing. */
function resample(flat: number[], step: number): { n: number; x: Float32Array; z: Float32Array; s: Float32Array } {
  const xs: number[] = [flat[0]];
  const zs: number[] = [flat[1]];
  const ss: number[] = [0];
  let acc = 0;
  let want = step;
  for (let k = 2; k < flat.length; k += 2) {
    const ax = flat[k - 2];
    const az = flat[k - 1];
    const bx = flat[k];
    const bz = flat[k + 1];
    const seg = Math.hypot(bx - ax, bz - az);
    if (seg <= 0) continue;
    while (acc + seg >= want) {
      const t = (want - acc) / seg;
      xs.push(ax + (bx - ax) * t);
      zs.push(az + (bz - az) * t);
      ss.push(want);
      want += step;
    }
    acc += seg;
  }
  const lx = flat[flat.length - 2];
  const lz = flat[flat.length - 1];
  if (Math.hypot(lx - xs[xs.length - 1], lz - zs[zs.length - 1]) > step * 0.3) {
    xs.push(lx);
    zs.push(lz);
    ss.push(acc);
  }
  return { n: xs.length, x: Float32Array.from(xs), z: Float32Array.from(zs), s: Float32Array.from(ss) };
}

/**
 * The level a course would take with nothing at its mouth to meet. The ground along it is taken at its lowest across the
 * channel and smoothed with a running median (which keeps a cliff a cliff but irons out the dunes). The water then sits a
 * metre or so under it, halfway between the highest level that never rises downstream (it fills every hollow) and the lowest
 * (it cuts through every hump): so a course neither sinks into a gorge at the first dip nor rides an embankment over it.
 * The hand-set falls go where the land itself steps down most, near where the spec asks for them.
 */
function freeLevels(def: TerrainDef, hy: Hydro, r: River, cs: WaterCourseSpec, target: number, steps: { i: number; name: string }[]): Float32Array {
  const n = r.n;
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // The lowest ground across the channel and a little beyond, so neither bank is lower than the water.
    const w = r.half[i] + 3;
    const nx = -r.dz[i];
    const nz = r.dx[i];
    let lo = Infinity;
    for (const k of [-1, -0.5, 0, 0.5, 1]) lo = Math.min(lo, baseHeight(def, r.x[i] + nx * w * k, r.z[i] + nz * w * k));
    g[i] = lo;
    r.ground[i] = baseHeight(def, r.x[i], r.z[i]);
  }
  const med = new Float32Array(n);
  const win: number[] = [];
  for (let i = 0; i < n; i++) {
    win.length = 0;
    for (let k = Math.max(0, i - 6); k <= Math.min(n - 1, i + 6); k++) win.push(g[k]);
    win.sort((p, q) => p - q);
    med[i] = Math.min(win[win.length >> 1], g[i] + 1.5);
  }
  const cut = r.kind === 'river' ? 1.1 : 0.6;
  const slope = r.kind === 'river' ? 0.0009 : 0.0022;
  const Lt = new Float32Array(n);
  for (let i = 0; i < n; i++) Lt[i] = med[i] - cut;
  if (r.spring >= 0) Lt[0] = hy.springs[r.spring].level;
  const Lf = new Float32Array(n);
  const Lb = new Float32Array(n);
  Lf[0] = Lt[0];
  for (let i = 1; i < n; i++) Lf[i] = Math.min(Lf[i - 1] - slope * (r.s[i] - r.s[i - 1]), Lt[i]);
  Lb[n - 1] = Lt[n - 1];
  for (let i = n - 2; i >= 0; i--) Lb[i] = Math.max(Lb[i + 1] + slope * (r.s[i + 1] - r.s[i]), Lt[i]);
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = 0.5 * (Lf[i] + Lb[i]);
  // A spring's course starts at the pool's own level.
  if (r.spring >= 0) {
    L[0] = Math.min(L[0], Lt[0]);
    for (let i = 1; i < n; i++) L[i] = Math.min(L[i], L[i - 1]);
  }
  // The water may not run out lower than what it runs into.
  const sEnd = r.s[Math.max(0, r.end - 1)];
  const floor = (i: number) => target + slope * Math.max(0, sEnd - r.s[i]);
  // Keep the steps off the natural drops (a step on the rim would only make the rim falls taller) and a few metres apart.
  const busy = new Uint8Array(n);
  for (let i = 0; i + 1 < n; i++) {
    if ((L[i] - L[i + 1]) / Math.max(0.5, r.s[i + 1] - r.s[i]) <= FALL_SLOPE) continue;
    for (let k = Math.max(0, i - 12); k <= Math.min(n - 1, i + 12); k++) busy[k] = 1;
  }
  for (const f of cs.falls ?? []) {
    const want = Math.round(f.at * (n - 1));
    const span = Math.max(6, Math.round(n * 0.04));
    let best = -1;
    let bestScore = -Infinity;
    for (let i = Math.max(4, want - span); i <= Math.min(r.end - 30, want + span); i++) {
      if (busy[i]) continue;
      // Where the land falls most over the next 150 m, so the gorge below the step is short.
      const j = Math.min(n - 1, i + 50);
      const score = L[i] - L[j] - Math.abs(i - want) * 0.05;
      if (L[i] - f.h > floor(i) + 0.5 && score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) continue;
    const h = Math.min(f.h, L[best] - floor(best) - 0.5);
    if (h < 0.8) continue;
    const top = L[best - 1];
    for (let i = best; i < n; i++) L[i] = Math.min(L[i], top - h - slope * (r.s[i] - r.s[best]));
    for (let k = Math.max(0, best - 3); k <= Math.min(n - 1, best + 3); k++) busy[k] = 1;
    steps.push({ i: best - 1, name: f.name ?? '' });
  }
  return L;
}

/** Final levels: meet whatever the course runs into, then everything that hangs off the level (banks, depth, current). */
function settleCourse(def: TerrainDef, hy: Hydro, r: River, L: Float32Array) {
  const n = r.n;
  let target: number;
  if (r.into.kind === 'lake') target = def.lakes[r.into.ref].level;
  else if (r.into.kind === 'swamp') target = hy.swamps[r.into.ref].level;
  else {
    const tr = hy.rivers[r.into.ref];
    let best = 0;
    for (let i = 0; i < tr.n; i++) if (Math.hypot(tr.x[i] - r.x[n - 1], tr.z[i] - r.z[n - 1]) < Math.hypot(tr.x[best] - r.x[n - 1], tr.z[best] - r.z[n - 1])) best = i;
    target = tr.level[best];
  }
  const slope = r.kind === 'river' ? 0.0009 : 0.0022;
  const sEnd = r.s[r.end];
  for (let i = 0; i < n; i++) {
    if (i >= r.end) L[i] = target;
    else L[i] = Math.max(L[i], target + slope * (sEnd - r.s[i]));
  }
  for (let i = 1; i < n; i++) L[i] = Math.min(L[i], L[i - 1]);
  r.level.set(L);
  const base = r.kind === 'river' ? 0.75 : 0.55;
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(n - 1, i + 1);
    const sl = (L[i0] - L[i1]) / Math.max(1, r.s[i1] - r.s[i0]);
    // Faster where it falls, slow and wide at the mouth.
    r.speed[i] = (base + clamp(sl * 70, 0, 2.6)) * (i >= r.end ? 0.35 : 1);
    // The banks stand back as far as the cut is deep, so a gorge has slopes, not walls (a rim notch is the exception).
    // A cut stands its banks back as far as it is deep, so a gorge has slopes, not walls (a rim notch is the exception); a fill
    // spreads into a low embankment.
    const cut = r.ground[i] - L[i];
    const b0 = r.kind === 'river' ? 7 : 3.5;
    r.bank[i] = clamp(b0 + Math.max(0, cut) * 3.2 + Math.max(0, -cut) * 2.6, b0, r.rim && i < 25 ? 18 : 64);
  }
  // Smooth the banks along the course.
  const b = Float32Array.from(r.bank);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    let w = 0;
    for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) {
      acc += b[k];
      w++;
    }
    r.bank[i] = Math.max(b[i] * 0.6, acc / w);
  }
  // Shallow and quick over a lip, a deep plunge pool under it.
  for (let i = 1; i < n - 1; i++) {
    const drop = (L[i] - L[i + 1]) / Math.max(0.5, r.s[i + 1] - r.s[i]);
    if (drop > FALL_SLOPE) {
      r.depth[i] = Math.min(r.depth[i], 0.5);
      for (let k = 1; k <= 4 && i + k < n; k++) r.depth[i + k] = Math.max(r.depth[i + k], r.depth[i + k] + 1.4 * (1 - k / 5));
    }
  }
}

function indexCourse(hy: Hydro, r: River) {
  for (let i = 0; i + 1 < r.n; i++) {
    const pad = Math.max(r.half[i] + r.bank[i], r.half[i + 1] + r.bank[i + 1]) + 12;
    const i0 = Math.floor((Math.min(r.x[i], r.x[i + 1]) - pad) / GRID);
    const i1 = Math.floor((Math.max(r.x[i], r.x[i + 1]) + pad) / GRID);
    const j0 = Math.floor((Math.min(r.z[i], r.z[i + 1]) - pad) / GRID);
    const j1 = Math.floor((Math.max(r.z[i], r.z[i + 1]) + pad) / GRID);
    for (let a = i0; a <= i1; a++) {
      for (let b = j0; b <= j1; b++) {
        const k = cellKey(a, b);
        let arr = hy.grid.get(k);
        if (!arr) hy.grid.set(k, (arr = []));
        arr.push(r.id, i);
      }
    }
  }
}

/** Runs of samples where the level drops steeply are waterfalls. The hand-set ones take their names from the spec. */
function findFalls(hy: Hydro, spec: OpenWaterSpec, steps: { i: number; name: string }[][]) {
  for (const r of hy.rivers) {
    const cs = spec.rivers.find((c) => c.id === r.key)!;
    let i = 0;
    while (i < r.end) {
      const drop = (r.level[i] - r.level[i + 1]) / Math.max(0.5, r.s[i + 1] - r.s[i]);
      if (drop <= FALL_SLOPE) {
        i++;
        continue;
      }
      const i0 = i;
      while (i < r.end && (r.level[i] - r.level[i + 1]) / Math.max(0.5, r.s[i + 1] - r.s[i]) > FALL_SLOPE * 0.6) i++;
      const i1 = Math.min(i, r.n - 1);
      const top = r.level[i0];
      const bottom = r.level[i1];
      if (top - bottom < 1.2) continue;
      let name = '';
      const rimFall = r.rim && i0 < 15 && top - bottom > 10;
      if (rimFall && !('spring' in cs.from)) name = cs.from.name;
      else {
        const st = steps[r.id].find((q) => q.i >= i0 - 2 && q.i <= i1 + 1);
        name = st?.name ?? '';
        // A run of steps shares the first one's name.
        const prev = hy.falls[hy.falls.length - 1];
        if (!name && st && prev && prev.river === r.id && i0 - prev.i1 < 60 && steps[r.id].some((q) => q.i >= prev.i0 - 2 && q.i <= prev.i1 + 1)) name = prev.name;
      }
      hy.falls.push({ id: hy.falls.length, river: r.id, name: name || `${r.name.replace(/^the /, '')} Falls`, i0, i1, x: r.x[i0], z: r.z[i0], top, bottom, dx: r.dx[i0], dz: r.dz[i0], half: r.half[i0], rim: rimFall });
    }
  }
}

/** Where the highway and the side roads cross running water: a causeway and a bridge go there. */
function findCrossings(def: TerrainDef, hy: Hydro) {
  const o = def.open!;
  const seen = new Set<string>();
  for (const r of hy.rivers) {
    for (let i = 0; i + 1 < r.end; i++) {
      const cell = o.grid.get(cellKey(Math.floor(r.x[i] / GRID), Math.floor(r.z[i] / GRID)));
      if (!cell) continue;
      for (let k = 0; k < cell.length; k += 2) {
        const road = o.roads[cell[k]];
        if (road.kind === 'track') continue;
        const s = cell[k + 1];
        const p = road.pts;
        const hit = segX(r.x[i], r.z[i], r.x[i + 1], r.z[i + 1], p[s], p[s + 1], p[s + 2], p[s + 3]);
        if (!hit) continue;
        const key = `${r.id}:${road.id}:${Math.round(hit[0] / 20)}:${Math.round(hit[1] / 20)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const rdx = p[s + 2] - p[s];
        const rdz = p[s + 3] - p[s + 1];
        const rl = Math.hypot(rdx, rdz) || 1;
        const sin = Math.abs((rdx / rl) * r.dz[i] - (rdz / rl) * r.dx[i]);
        const span = Math.min(r.half[i] * 3 + 12, (2 * (r.half[i] + 2.5)) / Math.max(0.35, sin));
        hy.crossings.push({ river: r.id, i, road, x: hit[0], z: hit[1], yaw: Math.atan2(rdx, rdz), span, roadHalf: road.half, level: r.level[i], y: baseHeight(def, hit[0], hit[1]) });
      }
    }
  }
}

function segX(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): [number, number] | null {
  const rx = bx - ax;
  const rz = bz - az;
  const sx = dx - cx;
  const sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * sz - (cz - az) * sx) / den;
  const u = ((cx - ax) * rz - (cz - az) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [ax + rx * t, az + rz * t];
}

/**
 * The lushness field, once every lake of the leg is planned: water greens the land round it (rivers and big lakes far, streams
 * and springs a little), the green zones of the spec green whole regions, and dune seas and the city stay bare.
 */
export function finishHydro(def: TerrainDef) {
  const hy = def.hydro;
  const o = def.open;
  if (!hy || !o) return;
  const C = LUSH_CELL;
  hy.lx0 = o.x0 - 160;
  hy.lz0 = o.z0 - 160;
  hy.lw = Math.ceil((o.x1 + 160 - hy.lx0) / C) + 1;
  hy.lh = Math.ceil((o.z1 + 160 - hy.lz0) / C) + 1;
  const W = hy.lw;
  const H = hy.lh;
  const P = new Float32Array(W * H).fill(-1e4);
  const kind = new Uint8Array(W * H);
  const stamp = (x: number, z: number, rad: number, v: number) => {
    const i0 = Math.max(0, Math.floor((x - rad - hy.lx0) / C));
    const i1 = Math.min(W - 1, Math.ceil((x + rad - hy.lx0) / C));
    const j0 = Math.max(0, Math.floor((z - rad - hy.lz0) / C));
    const j1 = Math.min(H - 1, Math.ceil((z + rad - hy.lz0) / C));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cx = hy.lx0 + (i + 0.5) * C;
        const cz = hy.lz0 + (j + 0.5) * C;
        if (Math.hypot(cx - x, cz - z) <= rad && P[j * W + i] < v) P[j * W + i] = v;
      }
    }
  };
  for (const r of hy.rivers) {
    const reach = r.kind === 'river' ? 120 : 60;
    for (let i = 0; i < r.end; i += 2) stamp(r.x[i], r.z[i], r.half[i] + 2, reach);
  }
  for (const sp of hy.springs) stamp(sp.x, sp.z, sp.r + 3, sp.oasis ? 70 : 45);
  for (let li = 0; li < def.lakes.length; li++) {
    const l = def.lakes[li];
    const big = hy.lakes.includes(li);
    const reach = big ? 140 : 55;
    const ext = l.reach;
    const i0 = Math.max(0, Math.floor((l.x - ext - hy.lx0) / C));
    const i1 = Math.min(W - 1, Math.ceil((l.x + ext - hy.lx0) / C));
    const j0 = Math.max(0, Math.floor((l.z - ext - hy.lz0) / C));
    const j1 = Math.min(H - 1, Math.ceil((l.z + ext - hy.lz0) / C));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (lakeQ(l, hy.lx0 + (i + 0.5) * C, hy.lz0 + (j + 0.5) * C) < 1 && P[j * W + i] < reach) P[j * W + i] = reach;
      }
    }
  }
  for (const s of hy.swamps) {
    const ext = s.reach;
    const i0 = Math.max(0, Math.floor((s.x - ext - hy.lx0) / C));
    const i1 = Math.min(W - 1, Math.ceil((s.x + ext - hy.lx0) / C));
    const j0 = Math.max(0, Math.floor((s.z - ext - hy.lz0) / C));
    const j1 = Math.min(H - 1, Math.ceil((s.z + ext - hy.lz0) / C));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const q = swampQ(s, hy.lx0 + (i + 0.5) * C, hy.lz0 + (j + 0.5) * C);
        if (q < 1.15) {
          if (P[j * W + i] < 140) P[j * W + i] = 140;
          kind[j * W + i] = 2;
        }
      }
    }
  }
  // Spread: each cell keeps the most reach left over from any water (a chamfer pass each way).
  const D1 = C;
  const D2 = C * Math.SQRT2;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      let v = P[k];
      if (i > 0) v = Math.max(v, P[k - 1] - D1);
      if (j > 0) {
        v = Math.max(v, P[k - W] - D1);
        if (i > 0) v = Math.max(v, P[k - W - 1] - D2);
        if (i < W - 1) v = Math.max(v, P[k - W + 1] - D2);
      }
      P[k] = v;
    }
  }
  for (let j = H - 1; j >= 0; j--) {
    for (let i = W - 1; i >= 0; i--) {
      const k = j * W + i;
      let v = P[k];
      if (i < W - 1) v = Math.max(v, P[k + 1] - D1);
      if (j < H - 1) {
        v = Math.max(v, P[k + W] - D1);
        if (i < W - 1) v = Math.max(v, P[k + W + 1] - D2);
        if (i > 0) v = Math.max(v, P[k + W - 1] - D2);
      }
      P[k] = v;
    }
  }
  const lush = new Uint8Array(W * H);
  const woods = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) {
    const z = hy.lz0 + (j + 0.5) * C;
    for (let i = 0; i < W; i++) {
      const x = hy.lx0 + (i + 0.5) * C;
      const k = j * W + i;
      const wl = smoothstep(0, 70, P[k]);
      let gl = 0;
      let gw: Woods = 'broadleaf';
      for (const g of hy.greens) {
        const dd = Math.hypot(x - g.x, z - g.z) + (noise2(x / 260 + g.x * 0.01, z / 260, def.seed + 341) - 0.5) * g.r * 0.55;
        const v = g.lush * (1 - smoothstep(g.r * 0.55, g.r, dd));
        if (v > gl) {
          gl = v;
          gw = g.woods;
        }
      }
      gl *= 1 - 0.3 * duneness(def, z, x);
      let v = Math.max(wl * 0.95, gl);
      v *= 0.86 + 0.28 * noise2(x / 150 - 3, z / 150 + 8, def.seed + 342);
      v *= 1 - districtMask(o, x, z);
      // Bare rock and scree up the mountains at the edge.
      const edge = Math.min(x - o.x0, o.x1 - x, z - o.z0, o.z1 - z);
      v *= smoothstep(-10, 30, edge);
      lush[k] = Math.round(clamp(v, 0, 1) * 255);
      // Swamp trees in the swamps; near the big rivers and lakes the water's own (willows, poplars); else the region's.
      woods[k] = kind[k] === 2 ? 2 : P[k] > 95 ? 3 : WOODS.indexOf(gw);
    }
  }
  hy.lush = lush;
  hy.woods = woods;
  hy.wet = P;
}

/** A bridge prop's `tag`: its span along the road, how far the river bed lies under the road, and the road's half-width. */
export const bridgeTag = (span: number, drop: number, half: number) => Math.round(span * 2) * 10000 + Math.min(999, Math.max(0, Math.round(drop * 10))) * 10 + Math.min(9, Math.round(half));
export const readBridgeTag = (tag: number) => ({ span: Math.floor(tag / 10000) / 2, drop: (Math.floor(tag / 10) % 1000) / 10, half: tag % 10 });

/** A tiny deterministic pick for things that hang off a cell of the map (exported for the planter). */
export const cellRoll = (x: number, z: number, salt: number) => hash2(Math.floor(x), Math.floor(z), salt);
