import { legById, type LegDef, type OpenWorldSpec } from '../data';
import { Rng } from '../core/rng';
import { clamp } from '../core/math';
import { planById } from './plans';
import { CHUNK, roadX, type TerrainDef } from './terrain';

/**
 * The open world: one big basin you can drive across in any direction, instead of one road between cliffs.
 *
 * The highway is still `roadX(z)` (it is what the authored set pieces and the roadside places hang off), but there are
 * now side roads and dirt tracks too, a city district (an authored city leg dropped in) and a rim of mountains at the
 * edge of the map. Everything here is pure data and geometry; nothing touches three.js.
 */

export type RoadKind = 'highway' | 'road' | 'track';

export interface RoadPath {
  id: string;
  kind: RoadKind;
  /** Half the carriageway width. */
  half: number;
  /** Flat [x, z, x, z, ...] centre-line, ordered. */
  pts: number[];
}

/** A city dropped into the open ground. Its rectangle is aligned to the chunk grid so a chunk is wholly in or out. */
export interface District {
  id: string;
  legId: string;
  plan: string;
  /** World z that the city leg's local z = 0 lands on. */
  dz: number;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface HubPlace {
  id: string;
  x: number;
  z: number;
}

export interface OpenWorld {
  spec: OpenWorldSpec;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  districts: District[];
  roads: RoadPath[];
  hubs: HubPlace[];
  haven: { x: number; z: number; radius: number };
  /** Spatial index of road segments: cell -> flat list of (road index, segment index). */
  grid: Map<number, number[]>;
}

const CELL = 32;
/** Roads further than this from a point are not looked for: it is the widest thing that reshapes the ground. */
export const ROAD_REACH = 22;
const cellKey = (ix: number, iz: number) => (ix + 4096) * 8192 + (iz + 4096);

/** How wide the city's ground flattens out beyond its rectangle before the desert takes over. */
export const DISTRICT_FADE = 70;

export function makeOpenWorld(def: TerrainDef, leg: LegDef): OpenWorld {
  const spec = leg.open!;
  const w: OpenWorld = {
    spec,
    x0: -spec.halfWidth,
    x1: spec.halfWidth,
    z0: spec.zMin,
    z1: spec.zMax,
    districts: [],
    roads: [],
    hubs: [],
    haven: { ...spec.haven },
    grid: new Map(),
  };
  def.open = w;
  w.hubs = spec.hubs.map((h) => ({ id: h.id, z: h.z, x: roadX(def, h.z) + h.x }));
  w.haven.x = roadX(def, spec.haven.z) + spec.haven.x;
  for (const d of spec.districts) {
    const plan = planById(legById(d.legId).plan!);
    let z = plan.startZ;
    for (const b of plan.blocks) z += b.len + b.cross;
    const wide = (side: '-1' | '1') => plan.sides[side].reduce((a, s) => a + s.w + s.gap, 0);
    const half = Math.ceil((Math.max(wide('-1'), wide('1')) + 10 + 7 + 3 + 40) / CHUNK) * CHUNK;
    w.districts.push({
      id: d.id,
      legId: d.legId,
      plan: plan.id,
      dz: d.at,
      x0: -half,
      x1: half,
      z0: Math.floor((d.at + plan.startZ - 128) / CHUNK) * CHUNK,
      z1: Math.ceil((d.at + z + 128) / CHUNK) * CHUNK,
    });
  }
  // The highway first: the rest of the code finds it through roadX, but the map and the meshes want a polyline.
  const hw: number[] = [];
  for (let z = w.z0; z <= w.z1 + 0.01; z += 12) hw.push(roadX(def, z), z);
  addRoad(w, { id: 'highway', kind: 'highway', half: 7, pts: hw });
  for (const r of planRoads(def, w, leg.seed)) addRoad(w, r);
  return w;
}

/** Side roads: two cross-country roads that meet the highway at the two hubs, and three roads out to the corners. */
function planRoads(def: TerrainDef, w: OpenWorld, seed: number): RoadPath[] {
  const rng = new Rng(seed * 97 + 41);
  const out: RoadPath[] = [];
  const edge = w.x1 - 140;
  // A winding line between two points, as a polyline. `bend` is the sideways wander in metres.
  const wander = (id: string, kind: RoadKind, half: number, a: [number, number], b: [number, number], bend: number): RoadPath => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(2, Math.ceil(len / 12));
    const p1 = rng.range(0, 6.28);
    const p2 = rng.range(0, 6.28);
    const nx = -(b[1] - a[1]) / len;
    const nz = (b[0] - a[0]) / len;
    const pts: number[] = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const env = Math.sin(Math.PI * u) ** 0.6;
      const off = env * bend * (0.7 * Math.sin(u * len / 310 + p1) + 0.3 * Math.sin(u * len / 97 + p2));
      pts.push(a[0] + (b[0] - a[0]) * u + nx * off, a[1] + (b[1] - a[1]) * u + nz * off);
    }
    return { id, kind, half, pts };
  };
  for (const h of w.hubs) {
    // The cross road through each hub runs the whole width of the map.
    const hx = roadX(def, h.z);
    out.push(wander(`${h.id}-w`, 'road', 5, [hx, h.z], [-edge, h.z + rng.range(-160, 160)], 60));
    out.push(wander(`${h.id}-e`, 'road', 5, [hx, h.z], [edge, h.z + rng.range(-160, 160)], 60));
  }
  const hv = w.haven;
  const zN = hv.z - 900;
  out.push(wander('ne', 'road', 4.5, [roadX(def, zN), zN], [edge * 0.8, hv.z - 160], 90));
  out.push(wander('nw', 'road', 4.5, [roadX(def, zN - 120), zN - 120], [-edge * 0.75, hv.z - 420], 90));
  const zS = w.z0 + 300;
  out.push(wander('se', 'road', 4.5, [roadX(def, zS), zS], [edge * 0.7, w.z0 + 140], 70));
  return out;
}

/** Adds a road and indexes its segments. */
export function addRoad(w: OpenWorld, road: RoadPath) {
  const ri = w.roads.length;
  w.roads.push(road);
  const p = road.pts;
  const pad = ROAD_REACH + road.half;
  for (let s = 0; s + 3 < p.length; s += 2) {
    const i0 = Math.floor((Math.min(p[s], p[s + 2]) - pad) / CELL);
    const i1 = Math.floor((Math.max(p[s], p[s + 2]) + pad) / CELL);
    const j0 = Math.floor((Math.min(p[s + 1], p[s + 3]) - pad) / CELL);
    const j1 = Math.floor((Math.max(p[s + 1], p[s + 3]) + pad) / CELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = cellKey(i, j);
        let a = w.grid.get(k);
        if (!a) w.grid.set(k, (a = []));
        a.push(ri, s);
      }
    }
  }
}

export interface RoadHit {
  /** Distance to the centre-line, or Infinity when no road is within reach. */
  d: number;
  road: RoadPath | null;
  /** Distance past the carriageway edge, negative on the road. */
  edge: number;
  /** The nearest point on that road's centre-line. */
  px: number;
  pz: number;
}
const HIT: RoadHit = { d: Infinity, road: null, edge: Infinity, px: 0, pz: 0 };

/**
 * The nearest road to a point, measured to the carriageway edge so a wide highway wins over a thin track at the same
 * centre distance. The returned object is reused: read it before the next call.
 */
export function nearestRoad(w: OpenWorld, x: number, z: number): RoadHit {
  HIT.d = Infinity;
  HIT.road = null;
  HIT.edge = Infinity;
  const cell = w.grid.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
  if (!cell) return HIT;
  for (let k = 0; k < cell.length; k += 2) {
    const r = w.roads[cell[k]];
    const p = r.pts;
    const s = cell[k + 1];
    const ax = p[s];
    const az = p[s + 1];
    const dx = p[s + 2] - ax;
    const dz = p[s + 3] - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1) : 0;
    const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
    const edge = d - r.half;
    if (edge < HIT.edge) {
      HIT.edge = edge;
      HIT.d = d;
      HIT.road = r;
      HIT.px = ax + dx * t;
      HIT.pz = az + dz * t;
    }
  }
  return HIT;
}

/**
 * How many steps up a paved road is drawn, so that where two cross or meet the later one lies on top of the earlier without
 * the two fighting: 0 for a road that touches no earlier one, else one more than the highest earlier road it touches. A road
 * that crosses nothing lies flat on the ground instead of standing a step up for every road planned before it. Tracks have no
 * mesh and stay 0. Worked out once per network (again only if a road is added).
 */
export function roadLayer(w: OpenWorld, ri: number): number {
  let c = LAYERS.get(w);
  if (!c || c.n !== w.roads.length) LAYERS.set(w, (c = { n: w.roads.length, layer: planLayers(w) }));
  return c.layer[ri] ?? 0;
}
const LAYERS = new WeakMap<OpenWorld, { n: number; layer: number[] }>();

function planLayers(w: OpenWorld): number[] {
  const layer = w.roads.map(() => 0);
  w.roads.forEach((r, i) => {
    if (r.kind === 'track') return;
    const p = r.pts;
    const n = p.length / 2;
    const under = new Set<number>();
    // Every point of this road and every midpoint between, against the earlier paved roads' segments near it. Two ribbons
    // overlap when their centre-lines come within both half widths and both shoulders (plus a little).
    for (let q = 0; q < n * 2 - 1; q++) {
      const a = (q >> 1) * 2;
      const x = q & 1 ? (p[a] + p[a + 2]) / 2 : p[a];
      const z = q & 1 ? (p[a + 1] + p[a + 3]) / 2 : p[a + 1];
      const cell = w.grid.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
      if (!cell) continue;
      for (let k = 0; k < cell.length; k += 2) {
        const j = cell[k];
        const o = w.roads[j];
        if (j >= i || under.has(j) || o.kind === 'track') continue;
        const s = cell[k + 1];
        const ax = o.pts[s];
        const az = o.pts[s + 1];
        const dx = o.pts[s + 2] - ax;
        const dz = o.pts[s + 3] - az;
        const l2 = dx * dx + dz * dz;
        const t = l2 > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1) : 0;
        if (Math.hypot(x - (ax + dx * t), z - (az + dz * t)) < r.half + o.half + 2) under.add(j);
      }
    }
    for (const j of under) layer[i] = Math.max(layer[i], layer[j] + 1);
  });
  return layer;
}

/** The district a point is inside (its chunk-aligned rectangle), or null in the open country. */
export function districtAt(w: OpenWorld | undefined, x: number, z: number): District | null {
  if (!w) return null;
  for (const d of w.districts) if (x >= d.x0 && x < d.x1 && z >= d.z0 && z < d.z1) return d;
  return null;
}

/** 1 inside a district's rectangle, falling to 0 over `DISTRICT_FADE` metres outside it. */
export function districtMask(w: OpenWorld | undefined, x: number, z: number): number {
  if (!w || !w.districts.length) return 0;
  let m = 0;
  for (const d of w.districts) {
    const dx = Math.max(d.x0 - x, 0, x - d.x1);
    const dz = Math.max(d.z0 - z, 0, z - d.z1);
    const t = 1 - Math.min(1, Math.hypot(dx, dz) / DISTRICT_FADE);
    m = Math.max(m, t * t * (3 - 2 * t));
  }
  return m;
}

/** True for a chunk that lies wholly inside a district. */
export function cityChunk(w: OpenWorld | undefined, cx: number, cz: number): boolean {
  return !!districtAt(w, (cx + 0.5) * CHUNK, (cz + 0.5) * CHUNK);
}

/** Nearest point on any road at any distance (a full scan: for planning, never per frame). */
export function nearestRoadAny(w: OpenWorld, x: number, z: number): { d: number; px: number; pz: number; road: RoadPath | null } {
  const out = { d: Infinity, px: 0, pz: 0, road: null as RoadPath | null };
  for (const r of w.roads) {
    const p = r.pts;
    for (let s = 0; s + 3 < p.length; s += 2) {
      const ax = p[s];
      const az = p[s + 1];
      const dx = p[s + 2] - ax;
      const dz = p[s + 3] - az;
      const l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1) : 0;
      const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
      if (d < out.d) {
        out.d = d;
        out.px = ax + dx * t;
        out.pz = az + dz * t;
        out.road = r;
      }
    }
  }
  return out;
}
