import type { HeritageSpec, LegDef } from '../data';
import { clamp, smoothstep } from '../core/math';
import { rollLoot } from '../sim/loot';
import { coursesNear, forestAt, type Hydro, type River } from './hydro';
import { heightAt, type TerrainDef } from './terrain';
import { nearestRoad, type District } from './openWorld';
import type { Aabb, PropSpawn, ScavZone, ZombieSpawn } from './layout';

/**
 * Buildings set by hand in the open world, beside the water. The Concrete House (Beit HaBeton), the pumping station Gdaliyahu
 * Wilbushevich built on the Yarkon at Petah Tikva in 1912, the first concrete building in the country: a grey two-storey
 * block, an arcade of round arches on the ground floor, a smaller upper storey set back behind a railed terrace, a
 * crenellated parapet on top, eucalyptus all round. Downstream, out on the open meadow among the poppies, a mud hut: one
 * room of mud brick under a flat roof of reed thatch. And a few minutes' walk upstream of the house, where the river swings
 * round the Half Island, Abu Rabah mill: a long block of honey-coloured stone standing across one leg of the bend right by
 * the way in, on the arches its races run through.
 *
 * Pure and deterministic, no three.js: where each stands (on the bank toward the district it faces, its front wall a set
 * distance from the water's edge: where the river comes nearest that district, or on the most open meadow of a stretch), the
 * level pad under it, the boxes that collide, the rooms under its roofs and what can be found inside.
 * `render/heritageProps.ts` draws them from the same numbers.
 *
 * Local frame, as for every prop: y = 0 on the pad, +Z out of the front (toward the river), metres. Its yaw is a whole
 * quarter turn, so its walls are axis-aligned boxes in the world as well. The mill is the exception to the pad: it levels
 * nothing (the river runs under it), y = 0 is the water's surface, its long axis lies across the stream and the water runs
 * toward its local -x, where the bridge is.
 */

export interface Heritage {
  id: HeritageSpec['id'];
  name: string;
  /** Centre of the ground storey, and its yaw (the front faces the river). */
  x: number;
  z: number;
  yaw: number;
  /** Height of the level pad it stands on. */
  floor: number;
  /** The river it stands by (index into `Hydro.rivers`), and how far its front wall is from the water's edge. */
  river: number;
  gap: number;
}

/** The Concrete House's numbers (local frame). */
export const CH = {
  /** Ground storey: half width and half depth of the outside of its walls. */
  hw: 7,
  hd: 5.5,
  /** Wall thickness. */
  t: 0.45,
  /** Top of the plinth: the ground floor. */
  plinth: 0.45,
  /** Underside and top of the slab over the ground storey (the terrace and the upper floor). */
  g1: 4.65,
  deck: 4.95,
  /** Upper storey: half width, and its back and front faces (the back is flush with the ground storey's). */
  uhw: 4.6,
  uz0: -5.5,
  uz1: 1.9,
  /** Underside and top of the roof slab, then the parapet and its merlons. */
  u1: 9.15,
  roof: 9.45,
  parapet: 9.95,
  merlon: 10.4,
  /** The open stair up the left side wall: its outer edge, the foot and top of the flight (z), the landing's back. */
  stair: { x0: -8.25, x1: -7, zFoot: 3.6, zTop: -2.9, zBack: -4.6, steps: 25 },
  /** Columns in the hall under the upper storey's front wall. */
  columns: [-2.1, 2.1] as const,
  /** The old pump: the well head and the engine on its bed. */
  well: { x: -3.3, z: -2.4, r: 0.9, h: 0.7 },
  engine: { x: 2.7, z: -2.6, w: 2.8, d: 1.3, h: 0.6 },
  /** Things to search: the tool chest by the engine and the cabinet upstairs (x, z, level 0/1, label, loot context). */
  loot: [
    { x: 5.4, z: -4.4, level: 0, label: 'the tool chest', context: 'garage' },
    { x: -3.4, z: -4.6, level: 1, label: 'the cabinet', context: 'office' },
  ] as const,
  /** Level ground round it: the house, the stair and a yard on the right where the old logs lie. */
  pad: { x0: -10.5, x1: 14.5, z0: -8.5, z1: 7.8, edge: 4 },
  /** The yard: felled eucalyptus logs (centre, length, diameter, yaw) and a fluted stone drum. */
  logs: [
    { x: 10.4, z: 1.8, len: 3.4, d: 0.55, yaw: 0.15, pale: false },
    { x: 12.9, z: -0.2, len: 4.2, d: 0.62, yaw: -0.35, pale: true },
  ] as const,
  drum: { x: 12.2, z: 3.4, r: 0.62, h: 0.78 },
  /** The welded mesh fence: along the front from x0 to the corner, then down the right side to z1. */
  fence: { x0: -9.2, front: 7.1, side: 8.6, z1: -6.7, h: 2.0 },
};

/**
 * The fence's posts, front run then side run, and which panel (between post i and i + 1) lies flat on the ground where
 * someone pushed through.
 */
export function fencePosts(): { posts: [number, number][]; down: number } {
  const f = CH.fence;
  const posts: [number, number][] = [];
  const nF = Math.ceil((f.side - f.x0) / 2.5);
  for (let k = 0; k <= nF; k++) posts.push([f.x0 + ((f.side - f.x0) * k) / nF, f.front]);
  const nS = Math.ceil((f.front - f.z1) / 2.5);
  for (let k = 1; k <= nS; k++) posts.push([f.side, f.front - ((f.front - f.z1) * k) / nS]);
  return { posts, down: 1 };
}

/** The terrace's edges that carry a coping and a railing (x0, z0, x1, z1): everywhere but where the stair lands. */
export function terraceEdges(): [number, number, number, number][] {
  const ex = CH.hw + 0.07;
  const ez = CH.hd + 0.07;
  const s = CH.stair;
  return [
    [-ex, ez, ex, ez],
    [ex, -ez, ex, ez],
    [-ex, s.zTop + 0.05, -ex, ez],
    [-ex, -ez, -ex, s.zBack + 0.15],
    [-ex, -ez, -CH.uhw - 0.1, -ez],
    [CH.uhw + 0.1, -ez, ex, -ez],
  ];
}

/**
 * An opening in a wall: centred `at` along it, `w` wide, from `sill` up (0 is a doorway) to where the arch springs, with a
 * round head over that, or, `square`, cut flat there.
 */
export interface ArchOpening {
  at: number;
  w: number;
  sill: number;
  spring: number;
  square?: boolean;
}

/**
 * A straight run of wall: along x at z = c (`axis` 'x') or along z at x = c, from a0 to a1, between heights y0 and y1, with
 * its openings (heights relative to y0). `out` is the side the outside is on.
 */
export interface WallRun {
  axis: 'x' | 'z';
  c: number;
  a0: number;
  a1: number;
  y0: number;
  y1: number;
  out: 1 | -1;
  ops: ArchOpening[];
}

const T = CH.t;
const arcade = (at: number): ArchOpening => ({ at, w: 2.4, sill: 0, spring: 2.3 });
const sideWin = (at: number): ArchOpening => ({ at, w: 0.95, sill: 0.9, spring: 2.4 });

/** Every wall of the Concrete House: the ground storey's four, then the upper storey's four. */
export const CH_WALLS: WallRun[] = [
  // The arcade along the front, three round arches.
  { axis: 'x', c: CH.hd - T / 2, a0: -CH.hw, a1: CH.hw, y0: CH.plinth, y1: CH.deck, out: 1, ops: [arcade(-4.2), arcade(0), arcade(4.2)] },
  // The back: a door between two windows.
  { axis: 'x', c: -CH.hd + T / 2, a0: -CH.hw, a1: CH.hw, y0: CH.plinth, y1: CH.deck, out: -1, ops: [{ at: -4.2, w: 1.2, sill: 1.1, spring: 2.5 }, { at: 0, w: 1.6, sill: 0, spring: 2.1 }, { at: 4.2, w: 1.2, sill: 1.1, spring: 2.5 }] },
  // The right side opens like the front.
  { axis: 'z', c: CH.hw - T / 2, a0: -CH.hd + T, a1: CH.hd - T, y0: CH.plinth, y1: CH.deck, out: 1, ops: [{ at: -2.6, w: 2.0, sill: 0, spring: 2.2 }, { at: 2.0, w: 2.0, sill: 0, spring: 2.2 }] },
  // The left side carries the stair: one small window ahead of its foot.
  { axis: 'z', c: -CH.hw + T / 2, a0: -CH.hd + T, a1: CH.hd - T, y0: CH.plinth, y1: CH.deck, out: -1, ops: [{ at: 4.0, w: 1.0, sill: 1.2, spring: 2.6 }] },
  // Upper storey: two tall arches onto the terrace.
  { axis: 'x', c: CH.uz1 - T / 2, a0: -CH.uhw, a1: CH.uhw, y0: CH.deck, y1: CH.roof, out: 1, ops: [{ at: -2.2, w: 1.8, sill: 0, spring: 2.1 }, { at: 2.2, w: 1.8, sill: 0, spring: 2.1 }] },
  { axis: 'x', c: CH.uz0 + T / 2, a0: -CH.uhw, a1: CH.uhw, y0: CH.deck, y1: CH.roof, out: -1, ops: [{ at: -2.2, w: 1.1, sill: 0.95, spring: 2.3 }, { at: 2.2, w: 1.1, sill: 0.95, spring: 2.3 }] },
  { axis: 'z', c: CH.uhw - T / 2, a0: CH.uz0 + T, a1: CH.uz1 - T, y0: CH.deck, y1: CH.roof, out: 1, ops: [sideWin(-3.7), sideWin(-1.7), sideWin(0.3)] },
  { axis: 'z', c: -CH.uhw + T / 2, a0: CH.uz0 + T, a1: CH.uz1 - T, y0: CH.deck, y1: CH.roof, out: -1, ops: [sideWin(-3.7), sideWin(-1.7), sideWin(0.3)] },
];

/** Height of the stair's rise per step and its tread. */
export function stairSteps() {
  const s = CH.stair;
  const rise = CH.deck / s.steps;
  const tread = (s.zFoot - s.zTop) / (s.steps - 1);
  return { rise, tread };
}

/** The mud hut's numbers (local frame): one room of mud brick under a flat roof of reed thatch with deep eaves. */
export const MH = {
  hw: 2.5,
  hd: 2.3,
  t: 0.32,
  /** Top of the walls; the thatch's underside and top, and how far it overhangs them. */
  wall: 2.75,
  thatch0: 2.72,
  thatch1: 3.2,
  eave: 0.6,
  /** A clay oven in one corner and a bench of mud brick along the back. */
  oven: { x: 1.45, z: -1.2, r: 0.55 },
  bench: { x: -0.7, z: -1.73, w: 2.2, d: 0.42, h: 0.42 },
  /** The jar that can be searched. */
  loot: [{ x: -1.75, z: 1.35, label: 'the clay jar', context: 'kitchen' }] as const,
  pad: { x0: -5.5, x1: 5.5, z0: -5.5, z1: 5.5, edge: 3 },
};

const MT = MH.t;
const sq = (at: number, w: number, sill: number, top: number): ArchOpening => ({ at, w, sill, spring: top, square: true });

/** The mud hut's walls: two small windows toward the river, one at the back, the door on the right, a slit on the left. */
export const MH_WALLS: WallRun[] = [
  { axis: 'x', c: MH.hd - MT / 2, a0: -MH.hw, a1: MH.hw, y0: 0, y1: MH.wall, out: 1, ops: [sq(-1.3, 0.6, 1.0, 1.6), sq(1.2, 0.75, 0.95, 1.6)] },
  { axis: 'x', c: -MH.hd + MT / 2, a0: -MH.hw, a1: MH.hw, y0: 0, y1: MH.wall, out: -1, ops: [sq(0.5, 0.6, 1.05, 1.6)] },
  { axis: 'z', c: MH.hw - MT / 2, a0: -MH.hd + MT, a1: MH.hd - MT, y0: 0, y1: MH.wall, out: 1, ops: [sq(0.45, 0.95, 0, 2.0)] },
  { axis: 'z', c: -MH.hw + MT / 2, a0: -MH.hd + MT, a1: MH.hd - MT, y0: 0, y1: MH.wall, out: -1, ops: [sq(-0.3, 0.45, 1.1, 1.55)] },
];

/**
 * The old mill's numbers (local frame: y = 0 at the water, its long axis along z, the races through its base along x). It
 * stands lengthwise in the river where it comes round the top of the Half Island, its stone base in the bed with three
 * arched races through it, the water under the floor; the mill floor is over them, a hall under a low gable roof with a tall
 * lantern of grey panels over one end. Its door is in the middle of its +x side, onto steps down to the crossing beside it.
 */
export const OM = {
  hw: 4.4,
  hd: 9.8,
  t: 0.6,
  /** Foot of the walls in the bed, the mill floor (and its slab's depth), the top of the walls and the ridge. */
  base: -2.8,
  deck: 2.4,
  slab: 0.3,
  eave: 6.7,
  ridge: 8.2,
  /** The races through the base: their centres across the stream, width, and the height their arches spring from. */
  races: [-4.4, 0, 4.4] as const,
  race: { w: 2.6, spring: 0.7 },
  /** The door in the +x side (its middle along z, and width), and the steps down from it: width, how far they run out from the wall to the bank, the height of their foot. */
  door: { z: 2.2, w: 1.4 },
  steps: { w: 1.7, run: 3.0, foot: 0.95 },
  /** The lantern on the roof over the +z end: width (along x), depth (along z), how far it stands over the ridge, its middle. */
  lantern: { w: 4.4, d: 4.6, h: 3.0, z: 6.2 },
  /** Two pairs of millstones in their wooden tuns, with the hoppers over them. */
  stones: [
    { x: 1.3, z: -3.6, r: 0.85, h: 0.75 },
    { x: 1.3, z: 3.6, r: 0.85, h: 0.75 },
  ] as const,
  /** Sacks of grain against the wall, and the things to search. */
  sacks: { x: -2.9, z: 0, w: 1.4, d: 3.2, h: 0.9 },
  loot: [
    { x: -3.0, z: -7.4, label: 'the grain bin', context: 'farm' },
    { x: 2.9, z: 7.7, label: "the miller's chest", context: 'garage' },
  ] as const,
};

const OT = OM.t;
const race = (at: number): ArchOpening => ({ at, w: OM.race.w, sill: 0, spring: OM.race.spring - OM.base });
const millWin = (at: number, w: number, sill: number, top: number, square = false): ArchOpening => ({ at, w, sill: OM.deck + sill - OM.base, spring: OM.deck + top - OM.base, square });

/** The mill's walls: its two long sides with the races at the foot and windows over them (the door in the +x one), then the ends. */
export const OM_WALLS: WallRun[] = [
  {
    axis: 'z',
    c: OM.hw - OT / 2,
    a0: -OM.hd,
    a1: OM.hd,
    y0: OM.base,
    y1: OM.eave,
    out: 1,
    ops: [...OM.races.map(race), millWin(-7.5, 0.7, 1.15, 2.35), millWin(-2.2, 0.62, 1.3, 2.25, true), { at: OM.door.z, w: OM.door.w, sill: OM.deck - OM.base, spring: OM.deck + 2.0 - OM.base }, millWin(7.5, 0.7, 1.15, 2.35)],
  },
  {
    axis: 'z',
    c: -OM.hw + OT / 2,
    a0: -OM.hd,
    a1: OM.hd,
    y0: OM.base,
    y1: OM.eave,
    out: -1,
    ops: [...OM.races.map(race), millWin(-7.5, 0.62, 1.3, 2.25, true), millWin(-2.2, 0.8, 1.1, 2.4), millWin(2.2, 0.8, 1.1, 2.4), millWin(7.5, 0.62, 1.3, 2.25, true)],
  },
  { axis: 'x', c: OM.hd - OT / 2, a0: -OM.hw + OT, a1: OM.hw - OT, y0: -0.6, y1: OM.eave, out: 1, ops: [{ at: 0, w: 0.7, sill: OM.deck + 0.6 + 1.1, spring: OM.deck + 0.6 + 2.3 }, millWin(2.5, 0.55, 1.3, 2.2, true)] },
  { axis: 'x', c: -OM.hd + OT / 2, a0: -OM.hw + OT, a1: OM.hw - OT, y0: -0.6, y1: OM.eave, out: -1, ops: [{ at: 0, w: 0.7, sill: OM.deck + 0.6 + 1.1, spring: OM.deck + 0.6 + 2.3 }, millWin(-2.5, 0.55, 1.3, 2.2, true)] },
];

interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** What the planner and the ground need of each building: its walls' outside, its pad, the ground it covers, its rooms. */
interface Model {
  hw: number;
  hd: number;
  pad: Rect & { edge: number };
  /** Ground it stands on (nothing grows there), local. */
  foot: Rect[];
  /** Rooms under a roof, local, heights above the pad. */
  rooms: (Rect & { y0: number; y1: number })[];
  /** False for a building that levels no ground (the mill stands in the river). */
  level?: boolean;
}

const MODELS: Record<HeritageSpec['id'], Model> = {
  concreteHouse: {
    hw: CH.hw,
    hd: CH.hd,
    pad: CH.pad,
    foot: [
      { x0: -CH.hw - 0.15, x1: CH.hw + 0.15, z0: -CH.hd - 0.15, z1: CH.hd + 0.15 },
      { x0: CH.stair.x0, x1: CH.stair.x1, z0: CH.stair.zBack, z1: CH.stair.zFoot },
    ],
    rooms: [
      { x0: -CH.hw + CH.t, x1: CH.hw - CH.t, z0: -CH.hd + CH.t, z1: CH.hd - CH.t, y0: -1, y1: CH.g1 },
      { x0: -CH.uhw + CH.t, x1: CH.uhw - CH.t, z0: CH.uz0 + CH.t, z1: CH.uz1 - CH.t, y0: CH.deck - 0.6, y1: CH.u1 },
    ],
  },
  mudHut: {
    hw: MH.hw,
    hd: MH.hd,
    pad: MH.pad,
    foot: [{ x0: -MH.hw - 0.1, x1: MH.hw + 0.1, z0: -MH.hd - 0.1, z1: MH.hd + 0.1 }],
    rooms: [{ x0: -MH.hw + MT, x1: MH.hw - MT, z0: -MH.hd + MT, z1: MH.hd - MT, y0: -1, y1: MH.wall }],
  },
  oldMill: {
    hw: OM.hw,
    hd: OM.hd,
    pad: { x0: -OM.hw - 3, x1: OM.hw + OM.steps.run + 3, z0: -OM.hd - 3, z1: OM.hd + 3, edge: 0 },
    foot: [{ x0: -OM.hw - 0.3, x1: OM.hw + OM.steps.run + 0.3, z0: -OM.hd - 0.3, z1: OM.hd + 0.3 }],
    rooms: [{ x0: -OM.hw + OT, x1: OM.hw - OT, z0: -OM.hd + OT, z1: OM.hd - OT, y0: OM.deck - 0.6, y1: OM.eave }],
    level: false,
  },
};

const model = (h: Heritage) => MODELS[h.id];

// ------------------------------------------------------------------------------------------------ frames

/** World (x, z) of a local point: the same turn `MeshBuilder.append` draws the prop with. */
export function hWorld(h: Heritage, lx: number, lz: number): [number, number] {
  const cs = Math.cos(h.yaw);
  const sn = Math.sin(h.yaw);
  return [h.x + lx * cs + lz * sn, h.z - lx * sn + lz * cs];
}

/** Local (x, z) of a world point. */
export function hLocal(h: Heritage, x: number, z: number): [number, number] {
  const cs = Math.cos(h.yaw);
  const sn = Math.sin(h.yaw);
  const dx = x - h.x;
  const dz = z - h.z;
  return [dx * cs - dz * sn, dx * sn + dz * cs];
}

/** A local rectangle as a world box (exact: the yaw is a quarter turn). */
function worldRect(h: Heritage, x0: number, x1: number, z0: number, z1: number) {
  const a = hWorld(h, x0, z0);
  const b = hWorld(h, x1, z1);
  return { minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minZ: Math.min(a[1], b[1]), maxZ: Math.max(a[1], b[1]) };
}

/** How far outside a local rectangle a local point is (0 inside). */
const outside = (lx: number, lz: number, x0: number, x1: number, z0: number, z1: number) => Math.hypot(Math.max(x0 - lx, 0, lx - x1), Math.max(z0 - lz, 0, lz - z1));

// ------------------------------------------------------------------------------------------------ planning

/** The nearest distance from the front wall's face to the water of river `ri`, sampled along it. */
function frontGap(hy: Hydro, ri: number, h: Heritage): number {
  const m = model(h);
  let g = Infinity;
  for (let lx = -m.hw; lx <= m.hw + 1e-6; lx += 0.5) {
    const [x, z] = hWorld(h, lx, m.hd);
    for (const c of coursesNear(hy, x, z, 40)) if (c.river.id === ri) g = Math.min(g, c.d - c.half);
  }
  return g;
}

/**
 * Where each hand-set building stands. Run once the water is planned (`makeTerrainDef`, after `finishHydro`), before
 * `TerrainDef.heritage` is set, so the ground it levels is the ground as it was.
 */
export function planHeritage(def: TerrainDef, leg: LegDef): Heritage[] {
  const hy = def.hydro;
  const o = def.open;
  const out: Heritage[] = [];
  if (!hy?.ready || !o) return out;
  for (const s of leg.open?.heritage ?? []) {
    const r = hy.rivers.find((q) => q.key === s.river);
    const d = o.districts.find((q) => q.id === s.facing);
    if (!r || !d) continue;
    const m = MODELS[s.id];
    // Lengthwise in the river where it comes round the top of a bend: its long axis (local z) with the water, its door side
    // (+x) toward the outer bank, away from the bend's middle.
    if (s.loop) {
      const lp = hy.loops.find((q) => q.key === s.loop && q.river === r.id);
      if (!lp) continue;
      const i = lp.mill;
      let yaw = 0;
      let bv = -Infinity;
      for (let q = 0; q < 4; q++) {
        const y = (q * Math.PI) / 2;
        const ax = Math.cos(y);
        const az = -Math.sin(y);
        const v = Math.abs(ax * r.dx[i] + az * r.dz[i]) < 0.5 ? ax * (r.x[i] - lp.x) + az * (r.z[i] - lp.z) : -Infinity;
        if (v > bv) {
          bv = v;
          yaw = y;
        }
      }
      out.push({ id: s.id, name: s.name, x: r.x[i], z: r.z[i], yaw, floor: Math.round(r.level[i] * 100) / 100, river: r.id, gap: 0 });
      continue;
    }
    // Where the river comes nearest the district, or the most open meadow of the stretch asked for.
    let best = 0;
    if (s.open) best = meadowSample(def, r, d, s.open, s.gap + m.hd, out);
    else {
      let bd = Infinity;
      for (let i = 0; i < r.end; i++) {
        const dd = Math.hypot(r.x[i] - clamp(r.x[i], d.x0, d.x1), r.z[i] - clamp(r.z[i], d.z0, d.z1));
        if (dd < bd) {
          bd = dd;
          best = i;
        }
      }
    }
    // The bank toward the district, and the front turned to face the water across it.
    const [nx, nz] = bankToward(r, best, d);
    const yaw = Math.round(Math.atan2(-nx, -nz) / (Math.PI / 2)) * (Math.PI / 2);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    // Back off from the water until the front wall stands exactly `gap` from its edge at the nearest point.
    let c = r.half[best] + s.gap + m.hd;
    const h: Heritage = { id: s.id, name: s.name, x: 0, z: 0, yaw, floor: 0, river: r.id, gap: s.gap };
    for (let k = 0; k < 40; k++) {
      h.x = r.x[best] - fx * c;
      h.z = r.z[best] - fz * c;
      const g = frontGap(hy, r.id, h);
      if (!Number.isFinite(g)) break;
      if (Math.abs(g - s.gap) < 0.02) break;
      c += s.gap - g;
    }
    // Level it a little above most of the ground under it: the river side is built up rather than the back dug out.
    const hs: number[] = [];
    for (let lx = -m.hw; lx <= m.hw; lx += 1) {
      for (let lz = -m.hd; lz <= m.hd; lz += 1) {
        const [x, z] = hWorld(h, lx, lz);
        hs.push(heightAt(def, x, z));
      }
    }
    hs.sort((a, b) => a - b);
    h.floor = Math.round(hs[Math.floor(hs.length * 0.75)] * 100) / 100;
    out.push(h);
  }
  return out;
}

/** The unit normal of a course at sample `i` that points across the bank toward a district. */
function bankToward(r: River, i: number, d: District): [number, number] {
  let nx = -r.dz[i];
  let nz = r.dx[i];
  if (nx * (clamp(r.x[i], d.x0, d.x1) - r.x[i]) + nz * (clamp(r.z[i], d.z0, d.z1) - r.z[i]) < 0) {
    nx = -nx;
    nz = -nz;
  }
  return [nx, nz];
}

/**
 * The sample of a stretch of river (`span`, 0 source to 1 mouth) whose bank toward the district is the most open, level
 * meadow `back` metres from the water, standing above the river: away from roads, crossings, riffles and the buildings
 * already placed.
 */
function meadowSample(def: TerrainDef, r: River, d: District, span: [number, number], back: number, placed: Heritage[]): number {
  const hy = def.hydro!;
  let best = Math.round(((span[0] + span[1]) / 2) * r.end);
  let bs = Infinity;
  for (let i = Math.max(10, Math.round(span[0] * r.end)); i < Math.min(r.end - 10, Math.round(span[1] * r.end)); i += 3) {
    const [nx, nz] = bankToward(r, i, d);
    const x = r.x[i] + nx * (r.half[i] + back);
    const z = r.z[i] + nz * (r.half[i] + back);
    const rd = nearestRoad(def.open!, x, z);
    if (rd.road && rd.edge < 18) continue;
    if (hy.crossings.some((q) => Math.hypot(q.x - x, q.z - z) < 90)) continue;
    if (hy.riffles.some((q) => Math.hypot(q.x - x, q.z - z) < 40)) continue;
    if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < 150)) continue;
    if (hy.loops.some((q) => Math.hypot(q.x - x, q.z - z) < q.r + 120)) continue;
    let wood = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let a = 0; a < 9; a++) {
      const rr = a === 0 ? 0 : a < 5 ? 7 : 14;
      const th = a * 1.7;
      const px = x + Math.cos(th) * rr;
      const pz = z + Math.sin(th) * rr;
      wood += forestAt(def, px, pz) / 9;
      const g = heightAt(def, px, pz);
      lo = Math.min(lo, g);
      hi = Math.max(hi, g);
    }
    // Never in a hollow lower than the river beside it: the first flood would have it.
    if (lo < r.level[i] + 0.6) continue;
    const score = wood * 3 + (hi - lo) * 0.6;
    if (score < bs) {
      bs = score;
      best = i;
    }
  }
  return best;
}

// ------------------------------------------------------------------------------------------------ ground

/** The ground with each building's pad levelled into it (called last by `heightAt`). */
export function heritageGround(list: Heritage[], x: number, z: number, h: number): number {
  for (const b of list) {
    if (Math.abs(x - b.x) > 24 || Math.abs(z - b.z) > 24) continue;
    if (model(b).level === false) continue;
    const P = model(b).pad;
    const [lx, lz] = hLocal(b, x, z);
    const k = 1 - smoothstep(0, P.edge, outside(lx, lz, P.x0, P.x1, P.z0, P.z1));
    if (k > 0) h += (b.floor - h) * k;
  }
  return h;
}

/** True on a building's level pad (plus `pad` metres): the woods leave it clear. */
export function heritageClear(list: Heritage[] | undefined, x: number, z: number, pad = 0): boolean {
  if (!list) return false;
  for (const b of list) {
    if (Math.abs(x - b.x) > 24 + pad || Math.abs(z - b.z) > 24 + pad) continue;
    const P = model(b).pad;
    const [lx, lz] = hLocal(b, x, z);
    if (outside(lx, lz, P.x0, P.x1, P.z0, P.z1) < pad) return true;
  }
  return false;
}

/** True under a building's walls and stair (plus `pad`): nothing grows on its floors. */
export function heritageFoot(list: Heritage[] | undefined, x: number, z: number, pad = 0): boolean {
  if (!list) return false;
  for (const b of list) {
    if (Math.abs(x - b.x) > 18 + pad || Math.abs(z - b.z) > 18 + pad) continue;
    const [lx, lz] = hLocal(b, x, z);
    for (const f of model(b).foot) if (outside(lx, lz, f.x0, f.x1, f.z0, f.z1) < pad) return true;
  }
  return false;
}

/** True in a room under a roof (`y` absolute): the camera closes in and the rain stays off. */
export function heritageRoofAt(list: Heritage[] | undefined, x: number, z: number, y: number): boolean {
  if (!list) return false;
  for (const b of list) {
    if (Math.abs(x - b.x) > 12 || Math.abs(z - b.z) > 12) continue;
    const [lx, lz] = hLocal(b, x, z);
    const ly = y - b.floor;
    for (const q of model(b).rooms) if (lx > q.x0 && lx < q.x1 && lz > q.z0 && lz < q.z1 && ly > q.y0 && ly < q.y1) return true;
  }
  return false;
}

// ------------------------------------------------------------------------------------------------ what it is made of

/** The building as a placed prop (drawn by the landscape for the whole map; it collides as `heritageAabbs`). */
export function heritageProps(h: Heritage): PropSpawn[] {
  return [{ kind: h.id, x: h.x, y: h.floor, z: h.z, yaw: h.yaw, scale: 1, seed: 1 }];
}

/** Solid pieces of a wall run: the piers between its openings, the wall over each arch and under each window. */
export function wallPieces(w: WallRun): { a0: number; a1: number; y0: number; y1: number }[] {
  const out: { a0: number; a1: number; y0: number; y1: number }[] = [];
  let a = w.a0;
  for (const op of [...w.ops].sort((p, q) => p.at - q.at)) {
    const l = op.at - op.w / 2;
    const r = op.at + op.w / 2;
    if (l > a + 0.01) out.push({ a0: a, a1: l, y0: w.y0, y1: w.y1 });
    const crown = w.y0 + op.spring + (op.square ? 0 : op.w / 2);
    if (crown < w.y1 - 0.05) out.push({ a0: l, a1: r, y0: crown, y1: w.y1 });
    if (op.sill > 0) out.push({ a0: l, a1: r, y0: w.y0, y1: w.y0 + op.sill });
    a = r;
  }
  if (w.a1 > a + 0.01) out.push({ a0: a, a1: w.a1, y0: w.y0, y1: w.y1 });
  return out;
}

/**
 * The boxes the house collides as (its drawn mesh has no collider of its own): every solid piece of every wall (they stop
 * zombies, bullets and the camera too), the floors, the terrace's railings and the fence (physics only), the columns, the
 * well, the engine bed, the chest, the cabinet, the logs and the drum, the masonry under the stair, and the stair itself as
 * one slope a capsule can walk up with its rail beside it.
 */
export function heritageAabbs(h: Heritage, newId: () => number): Aabb[] {
  return h.id === 'mudHut' ? hutAabbs(h, newId) : h.id === 'oldMill' ? millAabbs(h, newId) : houseAabbs(h, newId);
}

/**
 * A walkable slope: a thin slab from (a0, ya) to (a1, yb) along local z, `x0..x1` wide, as the interiors' ramps take it (the
 * world box round it, the slab's centre and its tilt). `kind` 'stair' for steps, 'furniture' for a rail riding the same line.
 */
function slope(h: Heritage, newId: () => number, x0: number, x1: number, za: number, ya: number, zb: number, yb: number, kind: Aabb['kind'], thick = 0.12, lift = 0): Aabb {
  const F = h.floor;
  const run = zb - za;
  const dir = Math.sign(run) || 1;
  const theta = Math.atan2(yb - ya, Math.abs(run));
  const len = Math.hypot(run, yb - ya);
  // The slab's top face rides the line from (za, ya) to (zb, yb): its centre sits half its thickness under it.
  const zm = (za + zb) / 2 + dir * Math.sin(theta) * (thick / 2);
  const ym = (ya + yb) / 2 - Math.cos(theta) * (thick / 2) + lift;
  // The slab climbs toward local z = zb: its heading in the world.
  const [dx, dz] = hWorld(h, 0, dir);
  const yaw = Math.atan2(dx - h.x, dz - h.z);
  const sx = Math.sin(-theta / 2);
  const cx = Math.cos(theta / 2);
  const sy = Math.sin(yaw / 2);
  const cy = Math.cos(yaw / 2);
  const [rx, rz] = hWorld(h, (x0 + x1) / 2, zm);
  return {
    id: newId(),
    ...worldRect(h, x0, x1, Math.min(za, zb), Math.max(za, zb)),
    y0: F + Math.min(ya, yb) - 0.6,
    y1: F + Math.max(ya, yb) + (kind === 'stair' ? 0 : 1.1),
    kind,
    hp: 99999,
    physOnly: true,
    ramp: { x: rx, y: F + ym, z: rz, hx: (x1 - x0) / 2, hy: thick / 2, hz: len / 2, q: [cy * sx, sy * cx, -sy * sx, cy * cx] },
  };
}

/**
 * The mill's boxes: every solid piece of its stone walls (the races are tunnels a swimmer can get through), the piers between
 * the races and the solid base at each end, the mill floor, the tuns, the sacks, the bin and the chest; the steps from each
 * door.
 */
function millAabbs(h: Heritage, newId: () => number): Aabb[] {
  const out: Aabb[] = [];
  const box = (x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, kind: Aabb['kind'], extra: Partial<Aabb> = {}) => {
    out.push({ id: newId(), ...worldRect(h, x0, x1, z0, z1), y0: h.floor + y0, y1: h.floor + y1, kind, hp: 99999, ...extra });
  };
  for (const w of OM_WALLS) {
    for (const p of wallPieces(w)) {
      if (w.axis === 'x') box(p.a0, p.a1, w.c - OT / 2, w.c + OT / 2, p.y0, p.y1, 'partition', { mat: 'stone' });
      else box(w.c - OT / 2, w.c + OT / 2, p.a0, p.a1, p.y0, p.y1, 'partition', { mat: 'stone' });
    }
  }
  const under = OM.deck - OM.slab;
  const rw = OM.race.w / 2;
  const inner = OM.hw - OT;
  // Between the races, and the solid base out to each end wall.
  for (let k = 0; k + 1 < OM.races.length; k++) box(-inner, inner, OM.races[k] + rw, OM.races[k + 1] - rw, OM.base, under, 'pillar', { mat: 'stone' });
  box(-inner, inner, OM.races[OM.races.length - 1] + rw, OM.hd - OT, OM.base, under, 'pillar', { mat: 'stone' });
  box(-inner, inner, -OM.hd + OT, OM.races[0] - rw, OM.base, under, 'pillar', { mat: 'stone' });
  // The floor.
  box(-inner, inner, -OM.hd + OT, OM.hd - OT, under, OM.deck, 'floor', { physOnly: true });
  // Inside: the tuns, the sacks, the bin and the chest.
  for (const s of OM.stones) box(s.x - s.r, s.x + s.r, s.z - s.r, s.z + s.r, OM.deck, OM.deck + s.h, 'furniture');
  const sk = OM.sacks;
  box(sk.x - sk.w / 2, sk.x + sk.w / 2, sk.z - sk.d / 2, sk.z + sk.d / 2, OM.deck, OM.deck + sk.h, 'furniture');
  const [bin, chest] = OM.loot;
  box(bin.x - 0.55, bin.x + 0.55, bin.z - 0.5, bin.z + 0.5, OM.deck, OM.deck + 1.0, 'furniture');
  box(chest.x - 0.5, chest.x + 0.5, chest.z - 0.3, chest.z + 0.3, OM.deck, OM.deck + 0.62, 'furniture');
  // Steps down from the door in the +x side: the masonry under them, then the slope a capsule walks (in a frame turned a
  // quarter, whose z is this one's x).
  const st = OM.steps;
  const dz = OM.door.z;
  box(OM.hw, OM.hw + st.run * 0.45, dz - st.w / 2, dz + st.w / 2, -1.0, OM.deck - 0.75, 'pillar', { mat: 'stone' });
  const hq: Heritage = { ...h, yaw: h.yaw + Math.PI / 2 };
  out.push(slope(hq, newId, -dz - st.w / 2, -dz + st.w / 2, OM.hw + st.run, st.foot, OM.hw, OM.deck + 0.02, 'stair'));
  return out;
}

/** The mud hut's boxes: its walls (mud brick stops a bullet like plaster), the oven, the bench and the jar. */
function hutAabbs(h: Heritage, newId: () => number): Aabb[] {
  const out: Aabb[] = [];
  const box = (x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, kind: Aabb['kind'], extra: Partial<Aabb> = {}) => {
    out.push({ id: newId(), ...worldRect(h, x0, x1, z0, z1), y0: h.floor + y0, y1: h.floor + y1, kind, hp: 99999, ...extra });
  };
  for (const w of MH_WALLS) {
    for (const p of wallPieces(w)) {
      if (w.axis === 'x') box(p.a0, p.a1, w.c - MT / 2, w.c + MT / 2, p.y0, p.y1, 'partition', { mat: 'plaster' });
      else box(w.c - MT / 2, w.c + MT / 2, p.a0, p.a1, p.y0, p.y1, 'partition', { mat: 'plaster' });
    }
  }
  const ov = MH.oven;
  box(ov.x - ov.r, ov.x + ov.r, ov.z - ov.r, ov.z + ov.r, 0, 0.75, 'furniture');
  const be = MH.bench;
  box(be.x - be.w / 2, be.x + be.w / 2, be.z - be.d / 2, be.z + be.d / 2, 0, be.h, 'furniture');
  const jar = MH.loot[0];
  box(jar.x - 0.3, jar.x + 0.3, jar.z - 0.3, jar.z + 0.3, 0, 0.75, 'furniture');
  return out;
}

/** The Concrete House's boxes. */
function houseAabbs(h: Heritage, newId: () => number): Aabb[] {
  const out: Aabb[] = [];
  const F = h.floor;
  const box = (x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, kind: Aabb['kind'], extra: Partial<Aabb> = {}) => {
    out.push({ id: newId(), ...worldRect(h, x0, x1, z0, z1), y0: F + y0, y1: F + y1, kind, hp: 99999, ...extra });
  };
  for (const w of CH_WALLS) {
    for (const p of wallPieces(w)) {
      if (w.axis === 'x') box(p.a0, p.a1, w.c - T / 2, w.c + T / 2, p.y0, p.y1, 'partition', { mat: 'concrete' });
      else box(w.c - T / 2, w.c + T / 2, p.a0, p.a1, p.y0, p.y1, 'partition', { mat: 'concrete' });
    }
  }
  // What people stand on: the plinth (the hall's floor) with the step round its foot, and the slab over the hall (the
  // terrace and the upper floor). Physics only, like the interiors' floors.
  const solid = { physOnly: true };
  box(-CH.hw - 0.1, CH.hw + 0.1, -CH.hd - 0.1, CH.hd + 0.1, -1.8, CH.plinth, 'floor', solid);
  box(-CH.hw - 0.45, CH.hw + 0.45, -CH.hd - 0.45, CH.hd + 0.45, -0.5, 0.22, 'floor', solid);
  box(-CH.hw, CH.hw, -CH.hd, CH.hd, CH.g1, CH.deck, 'floor', solid);
  // The coping and railing round the terrace, and the fence (wire: bullets and the dead see through it).
  for (const [x0, z0, x1, z1] of terraceEdges()) box(Math.min(x0, x1) - 0.15, Math.max(x0, x1) + 0.15, Math.min(z0, z1) - 0.15, Math.max(z0, z1) + 0.15, CH.deck, CH.deck + 1.2, 'furniture', solid);
  const fp = fencePosts();
  for (let i = 0; i + 1 < fp.posts.length; i++) {
    if (i === fp.down) continue;
    const [ax, az] = fp.posts[i];
    const [bx, bz] = fp.posts[i + 1];
    box(Math.min(ax, bx) - 0.04, Math.max(ax, bx) + 0.04, Math.min(az, bz) - 0.04, Math.max(az, bz) + 0.04, 0, CH.fence.h, 'furniture', solid);
  }
  // The logs and the drum in the yard, the tool chest and the cabinet.
  for (const l of CH.logs) {
    const hx = (Math.abs(Math.sin(l.yaw)) * l.len) / 2 + l.d / 2;
    const hz = (Math.abs(Math.cos(l.yaw)) * l.len) / 2 + l.d / 2;
    box(l.x - hx, l.x + hx, l.z - hz, l.z + hz, 0, l.d, 'furniture');
  }
  const dr = CH.drum;
  box(dr.x - dr.r, dr.x + dr.r, dr.z - dr.r, dr.z + dr.r, 0, dr.h, 'furniture');
  const [chest, cabinet] = CH.loot;
  box(chest.x - 0.48, chest.x + 0.48, chest.z - 0.28, chest.z + 0.28, CH.plinth, CH.plinth + 0.6, 'furniture');
  box(cabinet.x - 0.45, cabinet.x + 0.45, cabinet.z - 0.38, cabinet.z + 0.08, CH.deck, CH.deck + 1.8, 'furniture');
  // The hall's columns, under the upper storey's front wall.
  for (const cx of CH.columns) box(cx - 0.25, cx + 0.25, CH.uz1 - T / 2 - 0.25, CH.uz1 - T / 2 + 0.25, CH.plinth, CH.g1, 'pillar');
  const wl = CH.well;
  box(wl.x - wl.r, wl.x + wl.r, wl.z - wl.r, wl.z + wl.r, CH.plinth, CH.plinth + wl.h, 'furniture');
  const en = CH.engine;
  box(en.x - en.w / 2, en.x + en.w / 2, en.z - en.d / 2, en.z + en.d / 2, CH.plinth, CH.plinth + en.h + 0.9, 'furniture');
  // The stair: the masonry under it in three blocks that stay under the treads, the landing's pier, then the walkable slope.
  const s = CH.stair;
  const { rise, tread } = stairSteps();
  const run = s.zFoot - s.zTop;
  for (let k = 0; k < 3; k++) {
    const za = s.zFoot - (run * k) / 3;
    const zb = s.zFoot - (run * (k + 1)) / 3;
    const top = ((s.zFoot - za) / tread) * rise - 0.08;
    if (top > 0.3) box(s.x0, s.x1, zb, za, 0, top, 'pillar');
  }
  box(s.x0, s.x1, s.zBack, s.zTop, 0, CH.deck, 'pillar');
  // The rails round the landing: along its open side and across its back.
  box(s.x0, s.x0 + 0.1, s.zBack, s.zTop, CH.deck, CH.deck + 1.05, 'furniture', solid);
  box(s.x0, s.x1, s.zBack, s.zBack + 0.1, CH.deck, CH.deck + 1.05, 'furniture', solid);
  // Along the flight, u from the foot's outer edge: tread i spans [i, i + 1] treads with its top at (i + 1) rises, so the
  // line over the nosings is y = rise (u / tread + 1). The slope follows it from the ground to the landing, a hair above.
  const u0 = -tread;
  const u1 = (s.steps - 1) * tread;
  const y0 = rise * (u0 / tread + 1) + 0.03;
  const y1 = rise * (u1 / tread + 1) + 0.03;
  const theta = Math.atan2(y1 - y0, u1 - u0);
  const len = Math.hypot(u1 - u0, y1 - y0);
  const thick = 0.12;
  const um = (u0 + u1) / 2 + Math.sin(theta) * (thick / 2);
  const ym = (y0 + y1) / 2 - Math.cos(theta) * (thick / 2);
  // The flight climbs toward local -z; its heading in the world, as the interiors' ramps take it.
  const [dx, dz] = hWorld(h, 0, -1);
  const yaw = Math.atan2(dx - h.x, dz - h.z);
  const sx = Math.sin(-theta / 2);
  const cx = Math.cos(theta / 2);
  const sy = Math.sin(yaw / 2);
  const cy = Math.cos(yaw / 2);
  const xm = (s.x0 + s.x1) / 2;
  const [rx, rz] = hWorld(h, xm, s.zFoot - um);
  out.push({
    id: newId(),
    ...worldRect(h, s.x0, s.x1, s.zTop, s.zFoot),
    y0: F,
    y1: F + CH.deck,
    kind: 'stair',
    hp: 99999,
    physOnly: true,
    ramp: { x: rx, y: F + ym, z: rz, hx: (s.x1 - s.x0) / 2, hy: thick / 2, hz: len / 2, q: [cy * sx, sy * cx, -sy * sx, cy * cx] },
  });
  // The rail up the open side of the flight: the same slope, a metre tall over it.
  const [lx, lz] = hWorld(h, s.x0 + 0.06, s.zFoot - um);
  out.push({
    id: newId(),
    ...worldRect(h, s.x0, s.x0 + 0.12, s.zTop, s.zFoot),
    y0: F,
    y1: F + CH.deck + 1,
    kind: 'furniture',
    hp: 99999,
    physOnly: true,
    ramp: { x: lx, y: F + ym + 0.55, z: lz, hx: 0.05, hy: 0.5, hz: len / 2, q: [cy * sx, sy * cx, -sy * sx, cy * cx] },
  });
  return out;
}

/** What can be searched inside: the house's tool chest in the hall and cabinet upstairs, the hut's clay jar. */
export function heritageZone(h: Heritage, seed: number, progress: number): ScavZone {
  const id = `${seed}:heritage:${h.id}`;
  const m = model(h);
  const spots: { x: number; z: number; y: number; label: string; context: 'garage' | 'office' | 'kitchen' | 'farm' }[] =
    h.id === 'mudHut'
      ? MH.loot.map((c) => ({ ...c, y: 1.2 }))
      : h.id === 'oldMill'
        ? OM.loot.map((c) => ({ ...c, y: OM.deck + 1.0 }))
        : CH.loot.map((c) => ({ ...c, y: (c.level ? CH.deck : CH.plinth) + 1.1 }));
  return {
    id,
    kind: h.id === 'mudHut' ? 'shack' : h.id === 'oldMill' ? 'barn' : 'warehouse',
    x: h.x,
    z: h.z,
    w: m.hw * 2,
    d: m.hd * 2,
    open: 1,
    pin: false,
    containers: spots.map((c, i) => {
      const [x, z] = hWorld(h, c.x, c.z);
      return { id: `${id}:${i}`, x, z, depth: 1, items: rollLoot(c.context, seed * 31 + i * 977 + 13, 1, { progress }), taken: false, label: c.label, y: h.floor + c.y };
    }),
  };
}

/** A couple of the dead who never left: one by the fence, one among the logs in the yard. */
export function heritageZombies(h: Heritage): ZombieSpawn[] {
  if (h.id !== 'concreteHouse') return [];
  const [ax, az] = hWorld(h, -2.5, 8.6);
  const [bx, bz] = hWorld(h, 11.6, -2.6);
  return [
    { kind: 'walker', x: ax, z: az, dormant: true, cluster: 9100 },
    { kind: 'walker', x: bx, z: bz, dormant: true, cluster: 9100 },
  ];
}
