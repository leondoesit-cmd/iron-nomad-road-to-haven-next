import type { LegDef } from '../data';
import { Rng, noise2 } from '../core/rng';
import { lerp, smoothstep } from '../core/math';
import { baseHeight, buttes, roadX, type Site, type TerrainDef } from './terrain';
import { districtMask, nearestRoad } from './openWorld';
import { delveName, snapYaw, type DelveSite } from './delveSites';
import { nearHydro } from './hydro';

/**
 * Lakes, islands and docks for the wasteland legs. A lake is a blobby basin carved out of the terrain with a flat
 * water level; islands rise out of it; a dock reaches into it from the shore. Everything is a pure function of the
 * leg seed, so meshes, colliders, AI and the water physics all agree on where the shore is.
 *
 * Coordinates: x/z in metres on the leg grid, y is world height. `q` is the normalised shore distance: 0 at the
 * lake centre, 1 on the waterline, above 1 on land.
 */

export type IslandKind = 'shack' | 'wreck' | 'lighthouse' | 'cave' | 'ruin';
export type LakeStyle = 'clear' | 'brine' | 'ash';

export interface Island {
  kind: IslandKind;
  x: number;
  z: number;
  /** Waterline radius. */
  r: number;
  /** Height of the summit above the water level. */
  top: number;
  seed: number;
}

/** A pier along a cardinal axis, so its deck is an exact axis-aligned box. */
export interface Dock {
  /** Unit direction from the shore out over the water (one of the four cardinal axes). */
  dx: number;
  dz: number;
  /** Deck rectangle. */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** World height of the walking surface. */
  deckY: number;
  /** Length from the shore to the tip, and width. */
  len: number;
  width: number;
  /** Where the pier meets the beach. */
  shoreX: number;
  shoreZ: number;
  /** Moorings beside the deck, in water at least a metre deep. */
  boats: { x: number; z: number; yaw: number }[];
}

export interface Lake {
  id: number;
  x: number;
  z: number;
  /** Nominal waterline radius. */
  r: number;
  rot: number;
  /** Elongation along the rotated axis (1 = round). */
  ax: number;
  level: number;
  depth: number;
  seed: number;
  /** Fourier terms of the shoreline wobble: amplitude, phase, amplitude, phase, amplitude, phase. */
  shape: [number, number, number, number, number, number];
  style: LakeStyle;
  islands: Island[];
  dock: Dock | null;
  /** Distance beyond which the lake changes nothing. */
  reach: number;
  /** Hand-set lakes have a name (`world/hydro.ts`). */
  name?: string;
}

/** A widening of the corridor so a lake and its banks fit between the cliffs. */
export interface Bay {
  z0: number;
  z1: number;
  half: number;
}

/** Beyond this q the lake no longer reshapes the ground. */
const INFLUENCE = 1.45;
/** The bank blends back into the natural terrain between q = 1 and here. */
const RIM = 1.4;
const DECK_RISE = 0.42;

export function lakeQ(l: Lake, x: number, z: number): number {
  const dx = x - l.x;
  const dz = z - l.z;
  if (Math.abs(dx) > l.reach || Math.abs(dz) > l.reach) return Infinity;
  const c = Math.cos(l.rot);
  const s = Math.sin(l.rot);
  const u = (dx * c + dz * s) / l.ax;
  const v = (-dx * s + dz * c) * l.ax;
  const d = Math.hypot(u, v);
  const th = Math.atan2(v, u);
  const sh = l.shape;
  const rr = l.r * (1 + sh[0] * Math.sin(2 * th + sh[1]) + sh[2] * Math.sin(3 * th + sh[3]) + sh[4] * Math.sin(5 * th + sh[5]));
  return d / rr;
}

/** Depth profile: a wide, gentle beach and a steady drop into the middle. */
function profile(q: number): number {
  return Math.pow(smoothstep(1.0, 0.12, q), 1.15);
}

function islandRadius(i: Island, th: number) {
  return i.r * (1 + 0.2 * Math.sin(2 * th + i.seed) + 0.12 * Math.sin(3 * th + i.seed * 1.7) + 0.06 * Math.sin(5 * th + i.seed * 2.3));
}

/** Height of one island at (x, z): a dome above the waterline with a long sandy skirt beneath it. */
export function islandHeight(l: Lake, i: Island, x: number, z: number): number {
  const dx = x - i.x;
  const dz = z - i.z;
  const d = Math.hypot(dx, dz);
  if (d > i.r * 4) return -Infinity;
  const ri = islandRadius(i, Math.atan2(dz, dx));
  if (d < ri) {
    const k = d / ri;
    return l.level + i.top * (1 - Math.pow(k, 1.7)) + (noise2(x / 5, z / 5, i.seed) - 0.5) * 0.5 * (1 - k);
  }
  return l.level - 0.26 * (d - ri) + (noise2(x / 6, z / 6, i.seed + 3) - 0.5) * 0.3;
}

/** Height of the lake floor (with islands) at a point inside the waterline. */
export function lakeBed(l: Lake, x: number, z: number, q: number): number {
  // A big lake shelves off as quickly as a small one: its beach is as wide in metres, not in proportion.
  const qs = l.r > 90 ? 1 - Math.min(1, (1 - q) * (l.r / 90)) : q;
  let bed = l.level - l.depth * profile(qs) + (noise2(x / 8, z / 8, l.seed) - 0.5) * 0.55 * smoothstep(1, 0.7, qs);
  for (const i of l.islands) bed = Math.max(bed, islandHeight(l, i, x, z));
  return bed;
}

/** The terrain `h` at a point, reshaped by this lake: a basin inside, a beach and bank outside. */
export function lakeAdjust(l: Lake, x: number, z: number, h: number): number {
  const q = lakeQ(l, x, z);
  if (q >= INFLUENCE) return h;
  if (q < 1) return lakeBed(l, x, z, q);
  const w = 1 - smoothstep(1.0, RIM, q);
  const rim = l.level + 0.9 * smoothstep(1.0, 1.5, q);
  const out = lerp(h, rim, w);
  // A low bank keeps the water in where the surrounding ground sits lower than the lake.
  const bank = l.level + 0.9 * smoothstep(1.0, 1.2, q) * (1 - smoothstep(1.2, INFLUENCE, q));
  return out < bank ? bank : out;
}

/** What kind of water a point is in: a lake, a river or stream (flowing), a spring pool or a swamp. */
/** `flood` is a flash flood running down a dry wash; `pool` is the sheet it leaves on a clay pan (`world/washes.ts`). */
export type WaterKind = 'lake' | 'river' | 'stream' | 'spring' | 'swamp' | 'flood' | 'pool';
/** How the water looks (and how clean it is to drink). */
export type WaterStyle = LakeStyle | 'river' | 'spring' | 'swamp' | 'flood';

export interface WaterHit {
  kind: WaterKind;
  style: WaterStyle;
  level: number;
  /** Metres of water over the floor (0 at the waterline). */
  depth: number;
  /** The lake, for lake water. */
  lake?: Lake;
  /** Which river, swamp or spring (its index in `TerrainDef.hydro`), for the other kinds. */
  ref?: number;
  /** Running water: the current, in metres per second along x and z. */
  flow?: [number, number];
  /** Its name, for the map and the radio (lakes are named only when they are hand-set). */
  name?: string;
}

/** Water at a point, or null on dry land. */
export function lakeWater(lakes: Lake[], x: number, z: number): WaterHit | null {
  for (const l of lakes) {
    const q = lakeQ(l, x, z);
    if (q >= 1) continue;
    const bed = lakeBed(l, x, z, q);
    if (bed < l.level) return { kind: 'lake', style: l.style, lake: l, level: l.level, depth: l.level - bed, name: l.name };
  }
  return null;
}

/** Top of a dock deck at a point, or -Infinity if the point is not on one. */
export function dockDeckAt(lakes: Lake[], x: number, z: number): number {
  for (const l of lakes) {
    const d = l.dock;
    if (!d) continue;
    if (x >= d.x0 && x <= d.x1 && z >= d.z0 && z <= d.z1) return d.deckY;
  }
  return -Infinity;
}

/** The lake whose banks cover a point (used to keep scenery out of the water). */
export function lakeAt(lakes: Lake[], x: number, z: number, qMax = INFLUENCE): Lake | null {
  for (const l of lakes) if (lakeQ(l, x, z) < qMax) return l;
  return null;
}

/** How a ground point reads next to a lake: metres under water, and how damp the beach above the waterline is (0..1). */
export function shoreShade(lakes: Lake[], x: number, z: number, h: number): { depth: number; damp: number } | null {
  for (const l of lakes) {
    const q = lakeQ(l, x, z);
    if (q >= 1.35) continue;
    if (q < 1) {
      const d = l.level - h;
      if (d > 0) return { depth: d, damp: 1 };
    }
    const up = h - l.level;
    if (up < 1.5) return { depth: 0, damp: 1 - smoothstep(0, 1.5, up) };
  }
  return null;
}

/** Unit vector away from the lake centre: a gentle current for swamped vehicles, pointing at the nearest shore. */
export function lakeCurrent(l: Lake, x: number, z: number): [number, number] {
  const dx = x - l.x;
  const dz = z - l.z;
  const m = Math.hypot(dx, dz) || 1;
  return [dx / m, dz / m];
}

export function lakeColors(style: WaterStyle): { shallow: number; deep: number; foam: number } {
  switch (style) {
    case 'brine':
      return { shallow: 0x7fd6c8, deep: 0x1f7f86, foam: 0xf4f1e6 };
    case 'ash':
      return { shallow: 0x6a7a74, deep: 0x1b2528, foam: 0xb8b2a6 };
    case 'river':
      return { shallow: 0x6cb8a4, deep: 0x1d5a62, foam: 0xf4f6f0 };
    case 'spring':
      return { shallow: 0x7fe0d0, deep: 0x1a8a98, foam: 0xf6f8f2 };
    case 'swamp':
      return { shallow: 0x6e7a46, deep: 0x26301c, foam: 0xa8a87c };
    case 'flood':
      // Flood water carries the desert with it: thick with silt, the colour of milky coffee.
      return { shallow: 0xa48a64, deep: 0x6a5134, foam: 0xd9ccb2 };
    default:
      return { shallow: 0x58c4b0, deep: 0x0f5a74, foam: 0xf2f4ee };
  }
}

// ------------------------------------------------------------------------------------------------- planning

const ISLAND_ROTATION: IslandKind[] = ['shack', 'wreck', 'lighthouse', 'ruin', 'wreck', 'shack'];

/** Where lakes go: in the wasteland, beside the road, clear of roadside places, widening the corridor as needed. */
export function planLakes(def: TerrainDef, leg: LegDef): { lakes: Lake[]; bays: Bay[] } {
  const out = { lakes: [] as Lake[], bays: [] as Bay[] };
  if (def.biome !== 'wasteland') return out;
  const rng = new Rng(leg.seed * 53 + 17);
  const want = leg.length > 3900 ? 3 : 2;
  let z = rng.range(380, 560);
  let tries = 0;
  let rot = Math.floor(rng.range(0, ISLAND_ROTATION.length));
  const nextKind = () => ISLAND_ROTATION[rot++ % ISLAND_ROTATION.length];
  while (out.lakes.length < want && z < leg.length - 380 && tries < 90) {
    tries++;
    const found = tryLake(def, leg, rng, z, out.lakes, nextKind);
    if (found) {
      out.lakes.push(found.lake);
      out.bays.push(found.bay);
      // The bay is part of the terrain from now on, so the next candidate sees the widened corridor.
      def.bays.push(found.bay);
      z = found.lake.z + rng.range(700, 1000);
    } else z += 70;
  }
  return out;
}

/**
 * Lakes of the open world, beyond the highway's own: one candidate per 760 m square of the map, kept clear of roads,
 * roadside places, mesas, the city and each other. No bay is cut: the map has no walls to stand back.
 */
export function planOpenLakes(def: TerrainDef, leg: LegDef, existing: Lake[]): Lake[] {
  const o = def.open!;
  const rng = new Rng(leg.seed * 131 + 7);
  const out: Lake[] = [];
  const all = [...existing];
  let rot = Math.floor(rng.range(0, ISLAND_ROTATION.length));
  const nextKind = () => ISLAND_ROTATION[rot++ % ISLAND_ROTATION.length];
  const STEP = 760;
  for (let i = Math.floor((o.x0 + 300) / STEP); i <= Math.floor((o.x1 - 300) / STEP); i++) {
    for (let j = Math.floor((o.z0 + 300) / STEP); j <= Math.floor((o.z1 - 500) / STEP); j++) {
      if (rng.next() > 0.3) continue;
      const cx = (i + rng.range(0.2, 0.8)) * STEP;
      const cz = (j + rng.range(0.2, 0.8)) * STEP;
      const r = rng.range(56, 96);
      const ax = rng.range(0.85, 1.25);
      const ext = extentOf(r, ax);
      if (districtMask(o, cx, cz) > 0 || Math.hypot(cx, cz - 12) < 420) continue;
      // Clear of the mountains at the edge of the map.
      if (Math.abs(cx) + ext > o.x1 - 40 || cz - ext < o.z0 + 40 || cz + ext > o.z1 - 40) continue;
      if (Math.abs(cx - roadX(def, cz)) < ext + 90) continue;
      if (nearestRoad(o, cx, cz).d < ext + 40) continue;
      if (o.haven.z - cz < 400 && Math.abs(cx - o.haven.x) < 500) continue;
      if (def.sites.some((s) => Math.hypot(s.x - cx, s.z - cz) < ext + s.radius + 60)) continue;
      if (all.some((q) => Math.hypot(q.x - cx, q.z - cz) < q.reach + ext + 80)) continue;
      if (nearHydro(def, cx, cz, ext + 60)) continue;
      let bad = false;
      for (let a = 0; a < 36 && !bad; a++) {
        const rr = ext * Math.sqrt(((a % 6) + 0.5) / 6);
        const th = (a / 36) * Math.PI * 2;
        if (buttes(def, cx + Math.cos(th) * rr, cz + Math.sin(th) * rr) > 0.5) bad = true;
      }
      if (bad) continue;
      const lake = makeLake(def, rng, cx, cz, r, ax, ext, all, nextKind);
      lake.id = all.length;
      out.push(lake);
      all.push(lake);
    }
  }
  return out;
}

function extentOf(r: number, ax: number) {
  return r * 1.25 * INFLUENCE * Math.max(ax, 1 / ax);
}

function tryLake(def: TerrainDef, leg: LegDef, rng: Rng, cz: number, others: Lake[], nextKind: () => IslandKind): { lake: Lake; bay: Bay } | null {
  const side = rng.sign();
  const r = rng.range(60, 98);
  const ax = rng.range(0.85, 1.25);
  const ext = extentOf(r, ax);
  // Push the lake outward until every part of it keeps clear of the carriageway and the power lines beside it.
  let off = 54 + ext + rng.range(0, 30);
  for (let k = 0; k < 8; k++) {
    const lx = roadX(def, cz) + side * off;
    let worst = 0;
    for (let zz = cz - ext - 20; zz <= cz + ext + 20; zz += 20) worst = Math.max(worst, 54 - (Math.hypot(lx - roadX(def, zz), cz - zz) - ext));
    if (worst <= 0) break;
    off += worst + 4;
  }
  const cx = roadX(def, cz) + side * off;
  const z0 = cz - ext - 90;
  const z1 = cz + ext + 90;
  if (z0 < 120 || z1 > leg.length - 150) return null;
  if (def.open?.districts.some((d) => z1 > d.z0 - 120 && z0 < d.z1 + 120)) return null;
  // Canyons squeeze the corridor, so a lake cannot share their stretch of road.
  for (const c of def.canyons) if (z1 > c.z0 - 90 && z0 < c.z1 + 90) return null;
  // The bay has to reach the far bank.
  let half = 0;
  for (let zz = cz - ext; zz <= cz + ext; zz += 25) half = Math.max(half, Math.abs(cx - roadX(def, zz)) + ext + 45);
  if (half > 660) return null;
  for (const s of def.sites) {
    if (s.radius > 0 && Math.hypot(s.x - cx, s.z - cz) < ext + s.radius + 30) return null;
    if (s.kind === 'windfarm' && s.side === side && Math.abs(s.z - cz) < ext + 200) return null;
  }
  for (const o of [...others, ...def.lakes]) if (Math.hypot(o.x - cx, o.z - cz) < o.reach + ext + 60) return null;
  // The rivers, springs and swamps of the open world have their own ground.
  if (nearHydro(def, cx, cz, ext + 60)) return null;
  // Mesas, ramps and minefields do not mix with water.
  for (let a = 0; a < 36; a++) {
    const rr = ext * Math.sqrt(((a % 6) + 0.5) / 6);
    const th = (a / 36) * Math.PI * 2;
    if (buttes(def, cx + Math.cos(th) * rr, cz + Math.sin(th) * rr) > 0.5) return null;
  }
  for (const rp of def.ramps) if (Math.abs(rp.z0 - cz) < ext + 140) return null;
  for (const m of def.minefields) if (m.z1 > z0 && m.z0 < z1) return null;

  return { lake: makeLake(def, rng, cx, cz, r, ax, ext, others, nextKind), bay: { z0, z1, half } };
}

/** The lake itself, once its place is settled: shape, level, islands and pier. */
function makeLake(def: TerrainDef, rng: Rng, cx: number, cz: number, r: number, ax: number, ext: number, others: Lake[], nextKind: () => IslandKind): Lake {
  const lake = lakeShape(def, rng, cx, cz, r, ax, ext, others.length, rng.range(0, Math.PI));
  finishLake(def, lake, rng, others.length === 0, nextKind);
  return lake;
}

/**
 * A big lake at a hand-set place (`world/hydro.ts`): only its shape and a first level. The rivers that run into it may
 * lower the level before `finishLake` sets its islands and pier.
 */
export function fixedLake(def: TerrainDef, rng: Rng, cx: number, cz: number, r: number, ax: number, rot: number, id: number): Lake {
  return lakeShape(def, rng, cx, cz, r, ax, extentOf(r, ax), id, rot);
}

/** Islands and the pier, once the level is final. */
export function finishLake(def: TerrainDef, lake: Lake, rng: Rng, forceCave: boolean, nextKind: () => IslandKind) {
  placeIslands(lake, rng, forceCave, nextKind);
  placeDock(def, lake, rng);
}

export const nextIslandKind = (rng: Rng) => {
  let rot = Math.floor(rng.range(0, ISLAND_ROTATION.length));
  return () => ISLAND_ROTATION[rot++ % ISLAND_ROTATION.length];
};

/** Shape and level of a lake: a little under the lowest quarter of the ground round it. */
function lakeShape(def: TerrainDef, rng: Rng, cx: number, cz: number, r: number, ax: number, ext: number, id: number, rot: number): Lake {
  const lake: Lake = {
    id,
    x: cx,
    z: cz,
    r,
    rot,
    ax,
    level: 0,
    depth: 3.4 + r * 0.05,
    seed: rng.int(1, 99999),
    shape: [rng.range(0.04, 0.12), rng.range(0, 6.28), rng.range(0.03, 0.08), rng.range(0, 6.28), rng.range(0.01, 0.05), rng.range(0, 6.28)],
    style: def.theme === 'salt' ? 'brine' : def.theme === 'cinder' ? 'ash' : 'clear',
    islands: [],
    dock: null,
    reach: ext,
  };
  // Level: a little under the lowest quarter of the surrounding ground, so most of the shore is a bank, not a berm.
  const ring: number[] = [];
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  for (let a = 0; a < 32; a++) {
    const th = (a / 32) * Math.PI * 2;
    for (const k of [1.08, 1.3]) {
      const u = Math.cos(th) * r * k * ax;
      const v = (Math.sin(th) * r * k) / ax;
      ring.push(baseHeight(def, cx + u * c - v * s, cz + u * s + v * c));
    }
  }
  ring.sort((p, q) => p - q);
  lake.level = ring[Math.floor(ring.length * 0.22)] - 0.15;
  return lake;
}

function placeIslands(lake: Lake, rng: Rng, forceCave: boolean, nextKind: () => IslandKind) {
  const n = lake.r > 80 ? rng.int(2, 3) : lake.r > 62 ? 2 : 1;
  for (let k = 0; k < n; k++) {
    for (let t = 0; t < 60; t++) {
      const a = rng.range(0, Math.PI * 2);
      const rad = rng.range(0.05, 0.38) * lake.r;
      const ri = rng.range(9, 13) + (lake.r - 46) * 0.12;
      const x = lake.x + Math.cos(a) * rad;
      const z = lake.z + Math.sin(a) * rad;
      if (lake.islands.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + ri + 18)) continue;
      // Open water all round, so a boat can reach every side.
      let ok = lakeQ(lake, x, z) < 0.55;
      for (let d = 0; d < 8 && ok; d++) {
        const th = (d / 8) * Math.PI * 2;
        if (lakeQ(lake, x + Math.cos(th) * ri * 2.0, z + Math.sin(th) * ri * 2.0) > 0.88) ok = false;
      }
      if (!ok) continue;
      const kind: IslandKind = k === 0 && forceCave ? 'cave' : nextKind();
      lake.islands.push({ kind, x, z, r: ri, top: kind === 'lighthouse' ? rng.range(2.8, 3.6) : rng.range(1.8, 3.2), seed: rng.int(1, 9999) });
      break;
    }
  }
}

/** Snap a direction to the nearest cardinal axis. */
function cardinal(dx: number, dz: number): [number, number] {
  return Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dz) || 1];
}

function placeDock(def: TerrainDef, lake: Lake, rng: Rng) {
  // The pier starts on the shore nearest the carriageway and runs away from it, out over the water.
  const [dx, dz] = cardinal(lake.x - roadX(def, lake.z) + rng.range(-6, 6), rng.range(-0.5, 0.5));
  const px = -dz;
  const pz = dx;
  const slide = rng.range(-lake.r * 0.2, lake.r * 0.2);
  const baseX = lake.x + px * slide;
  const baseZ = lake.z + pz * slide;
  // Walk out from the middle toward the road-side shore to find the waterline.
  let ts = lake.r * 0.3;
  for (; ts < lake.reach; ts += 0.5) if (lakeQ(lake, baseX - dx * ts, baseZ - dz * ts) >= 1) break;
  const shoreX = baseX - dx * ts;
  const shoreZ = baseZ - dz * ts;
  const width = 2.6;
  // Long enough to reach a metre and a half of water.
  let len = 8;
  for (; len < 40; len += 1) {
    const tx = shoreX + dx * len;
    const tz = shoreZ + dz * len;
    const q = lakeQ(lake, tx, tz);
    if (q < 1 && lake.level - lakeBed(lake, tx, tz, q) > 1.5) break;
  }
  len += 1.5;
  const back = 3.5;
  const hw = width / 2;
  const ax = shoreX - dx * back;
  const az = shoreZ - dz * back;
  const bx = shoreX + dx * len;
  const bz = shoreZ + dz * len;
  const x0 = Math.min(ax, bx) - (dx === 0 ? hw : 0);
  const x1 = Math.max(ax, bx) + (dx === 0 ? hw : 0);
  const z0 = Math.min(az, bz) - (dz === 0 ? hw : 0);
  const z1 = Math.max(az, bz) + (dz === 0 ? hw : 0);
  const yaw = Math.atan2(dx, dz);
  // Boats tie up on one side, near the tip and again further in if the water is deep enough there.
  const boats: Dock['boats'] = [];
  const s = rng.sign();
  for (const back2 of [2.2, 7.5]) {
    const x = shoreX + dx * (len - back2) + px * s * (hw + 1.5);
    const z = shoreZ + dz * (len - back2) + pz * s * (hw + 1.5);
    const q = lakeQ(lake, x, z);
    if (q < 1 && lake.level - lakeBed(lake, x, z, q) > 0.9) boats.push({ x, z, yaw });
  }
  lake.dock = { dx, dz, x0, x1, z0, z1, deckY: lake.level + DECK_RISE, len, width, shoreX, shoreZ, boats };
}

// ------------------------------------------------------------------------------------------- places on the shore

const ISLAND_SITE = {
  shack: 'islandShack',
  wreck: 'islandWreck',
  lighthouse: 'islandLighthouse',
  ruin: 'islandRuin',
  cave: 'islandCave',
} as const;

/** The places around each lake that get built: the pier with its boathouse, and one site per island. */
export function planLakeSites(def: TerrainDef, leg: LegDef): { sites: Site[]; delves: DelveSite[] } {
  const out = { sites: [] as Site[], delves: [] as DelveSite[] };
  const rng = new Rng(leg.seed * 97 + 41);
  for (const l of def.lakes) {
    const d = l.dock;
    if (d) {
      out.sites.push({ kind: 'lakeDock', z: d.shoreZ, side: l.x > roadX(def, l.z) ? 1 : -1, off: Math.abs(d.shoreX - roadX(def, d.shoreZ)), radius: 0, seed: rng.int(1, 99999), x: d.shoreX, lake: l.id });
    }
    l.islands.forEach((isl, k) => {
      const site: Site = { kind: ISLAND_SITE[isl.kind], z: isl.z, side: l.x > roadX(def, l.z) ? 1 : -1, off: Math.abs(isl.x - roadX(def, isl.z)), radius: 0, seed: rng.int(1, 99999), x: isl.x, lake: l.id, island: k };
      if (isl.kind === 'cave') {
        // The mouth faces the pier, so the way in is the way the boat arrives.
        const tx = d ? d.shoreX + d.dx * d.len : l.x;
        const tz = d ? d.shoreZ + d.dz * d.len : l.z;
        const yaw = snapYaw(Math.atan2(tx - isl.x, tz - isl.z));
        const fx = Math.sin(yaw);
        const fz = Math.cos(yaw);
        const id = `${leg.id}:i${l.id}`;
        out.delves.push({ id, theme: 'cave', x: isl.x + fx * 5.5, z: isl.z + fz * 5.5, yaw, seed: site.seed, name: delveName('cave', site.seed), tier: Math.min(3, leg.index), island: true });
        site.delve = id;
      }
      out.sites.push(site);
    });
  }
  return out;
}

/** Lake places are built after the ground-cover pass, so their scenery is never cleared away with the dunes. */
export const isLakeSite = (s: Site) => s.kind === 'lakeDock' || s.kind.startsWith('island');
