import type { LegDef, WashSpec, XZ } from '../data';
import { Rng, noise2 } from '../core/rng';
import { clamp, lerp, smoothstep } from '../core/math';
import { sampleHydro, type Hydrograph } from '../sim/climate';
import { heightAt, type TerrainDef } from './terrain';
import { nearestRoad } from './openWorld';
import type { WaterHit } from './lakes';
import { hydroCalm } from './hydro';

/**
 * The dry washes (wadis) and clay pans (playas) of the open world's desert.
 *
 * A wash is a flat bed of gravel and sand cut a metre or three into the land, between steep banks the floods have undercut.
 * It comes out of the mountains at the edge of the map through a gorge and runs down to a clay pan or a river. It is dry
 * almost always: only rain heavier than the mountains can soak up runs off into it, and then it comes down as a flash flood,
 * a muddy wall of water that fills the bed for a few minutes and is gone, often under a blue sky, the storm that sent it
 * still standing over the mountains. What it brings ends in the pan: a dead-flat bed of pale clay that holds a sheet of
 * water for a day or so until the sun and the ground have taken it back. Nothing here ever stays as wet sand.
 *
 * Like `hydro.ts` this is planned once from the spec and the seed, so the mesh, the physics heightfield and every flood query
 * agree; the floods themselves are a function of the day's hydrograph (`sim/climate.ts`) and the clock, with no state.
 */

export const WASH_STEP = 3;
/** Cell of the wash index (metres). */
const GRID = 32;
const cellKey = (ix: number, iz: number) => (ix + 4096) * 8192 + (iz + 4096);
/** How fast a flood front runs down a wash, metres a second: faster than anyone runs. */
export const FLOOD_SPEED = 6;
/** How far a flood's surface stays under the top of the lower bank of its wash. */
const FLOOD_FREEBOARD = 0.25;
/** The deepest a full pan's sheet of water stands over its floor. */
export const PAN_POOL = 0.6;
/** Beyond this (in units of a pan's radius) a pan changes nothing. */
const PAN_OUT = 1.5;
/** The fall of a wash's bed, at the least. */
const MIN_SLOPE = 0.0035;
/** How far a wash's bed lies under the lowest land beside it, at the least (metres). */
const MIN_CUT = 0.75;

export interface Wash {
  id: number;
  key: string;
  name: string;
  n: number;
  x: Float32Array;
  z: Float32Array;
  /** Distance from the head of the gorge. */
  s: Float32Array;
  /** Level of the bed on the centre-line. Never rises downstream. */
  bed: Float32Array;
  /** Half the width of the flat bed. */
  half: Float32Array;
  /** Width of the cut bank that climbs back up to the land. */
  bank: Float32Array;
  /**
   * The most a flood may stand over the bed (metres): a freeboard under the lower of the two banks' tops, so a flood fills the
   * wash and never tops its banks; nil out on the flat floor of a pan.
   */
  cap: Float32Array;
  /** Unit direction of flow. */
  dx: Float32Array;
  dz: Float32Array;
  into: { kind: 'pan' | 'river'; ref: number };
  /** The last sample before the water it runs into. */
  end: number;
  /** How deep a big flood runs over the bed at the head. */
  flood: number;
  len: number;
}

export interface Pan {
  id: number;
  key: string;
  name: string;
  x: number;
  z: number;
  r: number;
  ax: number;
  rot: number;
  wobble: [number, number];
  /** Level of the flat clay floor. */
  floor: number;
  /** How high the low lip round the floor stands over it. */
  depth: number;
  seed: number;
  /** Bounding half-size of what the pan reshapes. */
  reach: number;
  /** Day-clock time the longest of its washes takes to bring a flood down to it. */
  travel: number;
  /** A salt flat that never holds water: the rain soaks into it and no wash runs to it. */
  dry?: boolean;
}

export interface WashNet {
  washes: Wash[];
  pans: Pan[];
  /** Wash segments by 32 m cell: flat (wash, sample) pairs. */
  grid: Map<number, number[]>;
  /** Seconds in the leg's day, to turn the flood's speed into the clock. */
  dayLength: number;
  ready: boolean;
}

// ------------------------------------------------------------------------------------------------ shapes

/** Where a point lies against a pan: 0 at the middle, 1 at the edge of the floor's rise, `PAN_OUT` where it ends. */
export function panQ(p: Pan, x: number, z: number): number {
  const dx = x - p.x;
  const dz = z - p.z;
  if (Math.abs(dx) > p.reach || Math.abs(dz) > p.reach) return Infinity;
  const c = Math.cos(p.rot);
  const s = Math.sin(p.rot);
  const u = (dx * c + dz * s) / p.ax;
  const v = (-dx * s + dz * c) * p.ax;
  const th = Math.atan2(v, u);
  const rr = p.r * (1 + 0.07 * Math.sin(3 * th + p.wobble[0]) + 0.04 * Math.sin(5 * th + p.wobble[1]));
  return Math.hypot(u, v) / rr;
}

/** How far the clay floor rises from the middle of a pan to the foot of its rim: barely, so a drying pool shrinks to the middle. */
const PAN_DISH = 0.22;

/** The ground of a pan: an all but flat floor of clay, a gentle rise to a low lip, and back to the land. */
function panGround(p: Pan, x: number, z: number, q: number, ground: number): number {
  const u = Math.min(q, 0.72) / 0.72;
  const flat = p.floor + PAN_DISH * u * u + (noise2(x / 6, z / 6, p.seed) - 0.5) * 0.03;
  const lip = p.floor + p.depth;
  if (q < 0.72) return flat;
  if (q < 1) return lerp(flat, lip, smoothstep(0.72, 1, q));
  return lerp(Math.max(lip, Math.min(ground, lip + 0.4)), ground, smoothstep(1, PAN_OUT, q));
}

export interface WashHit {
  wash: Wash;
  i: number;
  t: number;
  /** Distance from the centre-line, and along the wash. */
  d: number;
  s: number;
  bed: number;
  half: number;
  bank: number;
}

const HITS: WashHit[] = [];
const pool: WashHit[] = [];
function poolHit(k: number): WashHit {
  let h = pool[k];
  if (!h) pool[k] = h = { wash: null as unknown as Wash, i: 0, t: 0, d: 0, s: 0, bed: 0, half: 0, bank: 0 };
  return h;
}

/** The nearest point of each wash whose bed or banks reach (x, z) (plus `pad`). The array and objects are reused. */
export function washesNear(net: WashNet, x: number, z: number, pad = 0): WashHit[] {
  HITS.length = 0;
  const cell = net.grid.get(cellKey(Math.floor(x / GRID), Math.floor(z / GRID)));
  if (!cell) return HITS;
  for (let k = 0; k < cell.length; k += 2) {
    const w = net.washes[cell[k]];
    const i = cell[k + 1];
    const ax = w.x[i];
    const az = w.z[i];
    const ex = w.x[i + 1] - ax;
    const ez = w.z[i + 1] - az;
    const l2 = ex * ex + ez * ez;
    const t = l2 > 0 ? clamp(((x - ax) * ex + (z - az) * ez) / l2, 0, 1) : 0;
    const d = Math.hypot(x - (ax + ex * t), z - (az + ez * t));
    const half = w.half[i] + (w.half[i + 1] - w.half[i]) * t;
    const bank = w.bank[i] + (w.bank[i + 1] - w.bank[i]) * t;
    if (d > half + bank + pad) continue;
    let slot = -1;
    for (let q = 0; q < HITS.length; q++) if (HITS[q].wash === w) slot = q;
    if (slot >= 0 && HITS[slot].d <= d) continue;
    const h = slot >= 0 ? HITS[slot] : poolHit(HITS.length);
    h.wash = w;
    h.i = i;
    h.t = t;
    h.d = d;
    h.s = w.s[i] + (w.s[i + 1] - w.s[i]) * t;
    h.bed = w.bed[i] + (w.bed[i + 1] - w.bed[i]) * t;
    h.half = half;
    h.bank = bank;
    if (slot < 0) HITS.push(h);
  }
  return HITS;
}

/** The nearest wash to a point within its banks (plus `pad`), or null. */
export function washAt(net: WashNet, x: number, z: number, pad = 0): WashHit | null {
  let best: WashHit | null = null;
  for (const h of washesNear(net, x, z, pad)) if (!best || h.d - h.half < best.d - best.half) best = h;
  return best;
}

/** The pan a point lies in (its floor, its rise and its lip), or null. */
export function panAt(net: WashNet, x: number, z: number, edge = 1): Pan | null {
  for (const p of net.pans) if (panQ(p, x, z) < edge) return p;
  return null;
}

/** Low gravel bars between the braided channels of a wash bed, a hand's height. */
function bars(w: Wash, x: number, z: number): number {
  return (noise2(x / 5.5, z / 5.5, w.id * 31 + 7) - 0.5) * 0.22 + (noise2(x / 17, z / 17, w.id * 31 + 8) - 0.5) * 0.18;
}

/** Ground across a wash: the bed, then the cut bank, steep where the floods have undercut it, then the land. */
function washCut(h: WashHit, x: number, z: number, ground: number, ramp: number): number {
  if (h.d < h.half) return h.bed + bars(h.wash, x, z) * smoothstep(0, 0.35, 1 - h.d / h.half);
  const bank = Math.max(h.bank, ramp);
  const t = (h.d - h.half) / bank;
  if (t >= 1) return ground;
  return lerp(h.bed + 0.08, ground, ramp > h.bank ? smoothstep(0, 1, t) : Math.pow(smoothstep(0, 1, t), 0.65));
}

/**
 * A road keeps an easy grade down into a wash's bed and out again: the banks lie back for a car either side of it. How far
 * they lie back at a point (metres of bank), 0 away from roads.
 */
export function roadRamp(def: TerrainDef, x: number, z: number): number {
  const o = def.open;
  if (!o) return 0;
  const rd = nearestRoad(o, x, z);
  return rd.road && rd.edge < 14 ? lerp(rd.road.kind === 'track' ? 14 : 26, 0, smoothstep(3, 14, rd.edge)) : 0;
}

/** The terrain `h` at (x, z) with every pan and wash cut into it. Called by `heightAt` last. */
export function washAdjust(def: TerrainDef, net: WashNet, x: number, z: number, h: number): number {
  if (!net.ready) return h;
  let out = h;
  for (const p of net.pans) {
    const q = panQ(p, x, z);
    if (q < PAN_OUT) out = panGround(p, x, z, q, out);
  }
  if (!net.grid.has(cellKey(Math.floor(x / GRID), Math.floor(z / GRID)))) return out;
  const ramp = roadRamp(def, x, z);
  const hits = washesNear(net, x, z, ramp);
  if (!hits.length) return out;
  const ground = out;
  let cut = Infinity;
  let mouth = false;
  for (const c of hits) {
    cut = Math.min(cut, washCut(c, x, z, ground, ramp));
    if (c.i >= c.wash.end - 5) mouth = true;
  }
  // At its mouth the deeper floor wins, so the wash runs on into its pan or river instead of damming it.
  return mouth ? Math.min(ground, cut) : cut;
}

/**
 * 1 on a wash's bed and its banks (as high as a flood can run), 0 out on the land. With `hydroCalm` it keeps the visual
 * crags of the cliffs out of the gorges the washes come down through, so a flood is never hidden under rock that is not there.
 */
export function washCalm(net: WashNet | undefined, x: number, z: number): number {
  if (!net?.ready) return 0;
  const c = washAt(net, x, z, 4);
  if (!c) return 0;
  return 1 - smoothstep(c.half + c.bank, c.half + c.bank + 3, c.d);
}

/** How calm the drawn ground must lie at a point for the water there: running water, its banks, a wash and its flood. */
export function waterCalm(def: TerrainDef, x: number, z: number): number {
  const a = def.hydro ? hydroCalm(def.hydro, x, z) : 0;
  return a >= 1 ? 1 : Math.max(a, washCalm(def.washes, x, z));
}

/** True when (x, z) is within `pad` metres of a wash's banks or a pan. For keeping trees and places out. */
export function nearWash(def: TerrainDef, x: number, z: number, pad: number): boolean {
  const net = def.washes;
  if (!net?.ready) return false;
  if (washAt(net, x, z, pad)) return true;
  for (const p of net.pans) if (Math.hypot(x - p.x, z - p.z) < p.r * Math.max(p.ax, 1 / p.ax) * 1.3 + pad) return true;
  return false;
}

// ------------------------------------------------------------------------------------------------ floods

/** How deep the flood runs over the bed at distance `s` down a wash, at clock `t`, from the day's hydrograph. */
export function floodStage(net: WashNet, w: Wash, s: number, t: number, hy: Hydrograph): number {
  const travel = s / (FLOOD_SPEED * net.dayLength);
  const q = sampleHydro(hy.wash, t - travel);
  if (q <= 0.002) return 0;
  // It spreads and soaks into the gravel as it goes: the far end of a wash runs lower than the gorge. It never tops the banks,
  // and it sinks into the river or the pan it runs into rather than riding over it (the flood ribbon's shader does the same).
  const f = clamp(s / WASH_STEP, 0, w.n - 1.001);
  const i = Math.floor(f);
  const cap = w.cap[i] + (w.cap[Math.min(w.n - 1, i + 1)] - w.cap[i]) * (f - i);
  return Math.min(w.flood * q * (1 - 0.35 * clamp(s / w.len, 0, 1)), cap) * floodTaper(w, s);
}

/** How much of a flood still stands in the last stretch of a wash (0..1): it sinks away into what the wash runs into. */
export function floodTaper(w: Wash, s: number): number {
  const sEnd = w.s[w.end];
  return 1 - smoothstep(sEnd - 30, sEnd - 3, s);
}

/** How full a pan is now (0..1), its flood having come down the longest of its washes. */
export function panLevel(p: Pan, fill: number): number {
  return p.floor + PAN_POOL * clamp(fill, 0, 1);
}

/**
 * Flood water at a point: a running wash or a pan's sheet, or null. `panFill` is the pan's fill (see `sim/climate.panFill`).
 * Depth is over the ground there; the flow runs down the wash, faster the higher the flood.
 */
export function floodAt(def: TerrainDef, net: WashNet, x: number, z: number, t: number, hy: Hydrograph, panFill: (p: Pan) => number): WaterHit | null {
  if (!net.ready) return null;
  const ramp = roadRamp(def, x, z);
  const c = washAt(net, x, z, ramp);
  if (c && c.d < c.half + Math.max(c.bank, ramp)) {
    const stage = floodStage(net, c.wash, c.s, t, hy);
    if (stage > 0.02) {
      const level = c.bed + stage;
      const depth = level - heightAt(def, x, z);
      if (depth > 0.02) {
        const w = c.wash;
        const sp = 2.2 + 3.2 * clamp(stage / Math.max(0.3, w.flood), 0, 1.2);
        const dx = w.dx[c.i];
        const dz = w.dz[c.i];
        return { kind: 'flood', style: 'flood', level, depth, ref: w.id, flow: [dx * sp, dz * sp], name: `the flood in ${w.name}` };
      }
    }
  }
  for (const p of net.pans) {
    if (p.dry || panQ(p, x, z) >= 1.05) continue;
    const level = panLevel(p, panFill(p));
    if (level <= p.floor + 0.015) continue;
    const depth = level - heightAt(def, x, z);
    if (depth > 0.015) return { kind: 'pool', style: 'flood', level, depth, ref: p.id, name: p.name };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ planning

/**
 * Plan the washes and pans of an open-world leg. Call it last, once every place, lake and river is down: the washes were
 * laid out to keep clear of them, and nothing planned before has to move. The lushness field (`finishHydro`) runs after it,
 * so a thin line of acacia and dry grass follows each wash.
 */
export function planWashes(def: TerrainDef, leg: LegDef): WashNet | null {
  const spec = leg.open?.water;
  if (!spec?.washes?.length || !def.open) return null;
  const rng = new Rng(leg.seed * 71 + 29);
  const net: WashNet = { washes: [], pans: [], grid: new Map(), dayLength: leg.dayLength, ready: false };
  const panIds = new Map<string, number>();
  for (const ps of spec.pans ?? []) {
    const ax = ps.ax ?? 1;
    panIds.set(ps.id, net.pans.length);
    // A pan with a seed of its own (one set by hand with no wash running into it) leaves the washes' stream alone.
    const r = ps.seed !== undefined ? new Rng(ps.seed) : rng;
    net.pans.push({
      id: net.pans.length,
      key: ps.id,
      name: ps.name,
      x: ps.x,
      z: ps.z,
      r: ps.r,
      ax,
      rot: ps.rot ?? 0,
      wobble: [r.range(0, 6.28), r.range(0, 6.28)],
      floor: 0,
      depth: 1,
      seed: r.int(1, 99999),
      dry: !!ps.dry,
      reach: ps.r * 1.12 * PAN_OUT * Math.max(ax, 1 / ax) + 2,
      travel: 0,
    });
  }
  const specs: WashSpec[] = [];
  for (const ws of spec.washes) {
    const w = layWash(def, net, ws, rng, panIds);
    if (!w) continue;
    net.washes.push(w);
    specs.push(ws);
  }
  // Levels: each bed under the land it crosses, never rising; then each pan's floor under whatever arrives in it.
  const free = net.washes.map((w, k) => freeBed(def, w, specs[k]));
  for (const p of net.pans) {
    const ring: number[] = [];
    for (let a = 0; a < 32; a++) {
      const th = (a / 32) * Math.PI * 2;
      for (const k of [0.9, 1.15]) {
        const u = Math.cos(th) * p.r * k * p.ax;
        const v = (Math.sin(th) * p.r * k) / p.ax;
        ring.push(heightAt(def, p.x + u * Math.cos(p.rot) - v * Math.sin(p.rot), p.z + u * Math.sin(p.rot) + v * Math.cos(p.rot)));
      }
    }
    ring.sort((a, b) => a - b);
    let floor = ring[Math.floor(ring.length * 0.2)] - 0.9;
    net.washes.forEach((w, k) => {
      if (w.into.kind === 'pan' && w.into.ref === p.id) floor = Math.min(floor, free[k][Math.max(0, w.end - 1)] - 0.35);
    });
    p.floor = floor;
    p.depth = 1.0;
  }
  net.washes.forEach((w, k) => settleBed(def, net, w, free[k]));
  for (const w of net.washes) {
    if (w.into.kind !== 'pan') continue;
    const p = net.pans[w.into.ref];
    p.travel = Math.max(p.travel, w.s[w.end] / (FLOOD_SPEED * net.dayLength));
  }
  for (const w of net.washes) indexWash(net, w);
  net.ready = true;
  def.washes = net;
  return net;
}

function rimPoint(def: TerrainDef, from: WashSpec['from']): XZ {
  const o = def.open!;
  // Up in the mountains behind the rim, so the bed comes down through a gorge in the cliffs.
  const back = 46;
  switch (from.rim) {
    case 'east':
      return [o.x1 + back, from.at];
    case 'west':
      return [o.x0 - back, from.at];
    case 'north':
      return [from.at, o.z1 + back];
    default:
      return [from.at, o.z0 - back];
  }
}

function layWash(def: TerrainDef, net: WashNet, ws: WashSpec, rng: Rng, panIds: Map<string, number>): Wash | null {
  const src = rimPoint(def, ws.from);
  let into: Wash['into'];
  let target: XZ;
  const hy = def.hydro;
  if ('pan' in ws.to) {
    const pi = panIds.get(ws.to.pan);
    if (pi === undefined) return null;
    into = { kind: 'pan', ref: pi };
    target = [net.pans[pi].x, net.pans[pi].z];
  } else {
    const key = ws.to.river;
    const ri = hy?.rivers.findIndex((r) => r.key === key) ?? -1;
    if (!hy || ri < 0) return null;
    into = { kind: 'river', ref: ri };
    const r = hy.rivers[ri];
    const last = ws.via.length ? ws.via[ws.via.length - 1] : src;
    let best = 0;
    for (let i = 0; i < r.end; i++) if (Math.hypot(r.x[i] - last[0], r.z[i] - last[1]) < Math.hypot(r.x[best] - last[0], r.z[best] - last[1])) best = i;
    target = [r.x[best], r.z[best]];
  }
  const ctrl: XZ[] = [src, ...ws.via, target];
  const fine: number[] = [];
  for (let k = 0; k < ctrl.length - 1; k++) {
    const p0 = ctrl[Math.max(0, k - 1)];
    const p1 = ctrl[k];
    const p2 = ctrl[k + 1];
    const p3 = ctrl[Math.min(ctrl.length - 1, k + 2)];
    const m = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1])));
    for (let q = 0; q < m; q++) {
      const t = q / m;
      const t2 = t * t;
      const t3 = t2 * t;
      const cr = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      fine.push(cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1]));
    }
  }
  fine.push(target[0], target[1]);
  const base = resample(fine, WASH_STEP);
  // Meander: nil in the gorge and at the mouth, tighter and more restless than a river's.
  const amp = ws.meander ?? 14;
  const p1 = rng.range(0, 6.28);
  const p2 = rng.range(0, 6.28);
  const total = base.s[base.n - 1];
  const wavy: number[] = [];
  for (let i = 0; i < base.n; i++) {
    const s = base.s[i];
    const env = smoothstep(70, 180, s) * smoothstep(0, 110, total - s);
    const off = amp * env * (0.6 * Math.sin((s / 160) * Math.PI * 2 + p1) + 0.4 * Math.sin((s / 61) * Math.PI * 2 + p2));
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(base.n - 1, i + 1);
    const tx = base.x[i1] - base.x[i0];
    const tz = base.z[i1] - base.z[i0];
    const tl = Math.hypot(tx, tz) || 1;
    wavy.push(base.x[i] - (tz / tl) * off, base.z[i] + (tx / tl) * off);
  }
  const path = resample(wavy, WASH_STEP);
  // Cut it off inside what it runs into; `end` is where that begins.
  let n = path.n;
  let end = path.n - 1;
  const inside = (x: number, z: number, deep: boolean) => {
    if (into.kind === 'pan') return panQ(net.pans[into.ref], x, z) < (deep ? 0.55 : 0.95);
    const r = hy!.rivers[into.ref];
    let d = Infinity;
    let hf = 3;
    for (let i = 0; i < r.n; i++) {
      const dd = Math.hypot(r.x[i] - x, r.z[i] - z);
      if (dd < d) {
        d = dd;
        hf = r.half[i];
      }
    }
    return d < (deep ? hf * 0.4 : hf + 0.5);
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
  const w: Wash = {
    id: net.washes.length,
    key: ws.id,
    name: ws.name,
    n,
    x: path.x.slice(0, n),
    z: path.z.slice(0, n),
    s: path.s.slice(0, n),
    bed: mk(),
    half: mk(),
    bank: mk(),
    cap: mk(),
    dx: mk(),
    dz: mk(),
    into,
    end,
    flood: ws.flood,
    len: path.s[n - 1] || 1,
  };
  for (let i = 0; i < n; i++) {
    const u = w.s[i] / w.len;
    w.half[i] = lerp(ws.half[0], ws.half[1], Math.pow(u, 0.7));
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(n - 1, i + 1);
    const tx = w.x[i1] - w.x[i0];
    const tz = w.z[i1] - w.z[i0];
    const tl = Math.hypot(tx, tz) || 1;
    w.dx[i] = tx / tl;
    w.dz[i] = tz / tl;
  }
  return w;
}

/**
 * The bed a wash would take with nothing at its mouth: the lowest land across it, smoothed so the dunes do not count, cut
 * down by the wash's depth and never rising. Halfway between a bed that fills every hollow and one that cuts every hump, as
 * the rivers do, so a wash neither drops into a gorge at the first dip nor rides over one on a bank.
 */
function freeBed(def: TerrainDef, w: Wash, ws: WashSpec): Float32Array {
  const n = w.n;
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const span = w.half[i] + 2;
    const nx = -w.dz[i];
    const nz = w.dx[i];
    let lo = Infinity;
    for (const k of [-1, -0.5, 0, 0.5, 1]) lo = Math.min(lo, heightAt(def, w.x[i] + nx * span * k, w.z[i] + nz * span * k));
    g[i] = lo;
  }
  const lt = new Float32Array(n);
  const cut = new Float32Array(n);
  const win: number[] = [];
  for (let i = 0; i < n; i++) {
    win.length = 0;
    for (let k = Math.max(0, i - 7); k <= Math.min(n - 1, i + 7); k++) win.push(g[k]);
    win.sort((a, b) => a - b);
    cut[i] = lerp(ws.cut[0], ws.cut[1], w.s[i] / w.len);
    lt[i] = Math.min(win[win.length >> 1], g[i] + 1.2) - cut[i];
  }
  const lf = new Float32Array(n);
  const lb = new Float32Array(n);
  lf[0] = lt[0];
  for (let i = 1; i < n; i++) lf[i] = Math.min(lf[i - 1] - MIN_SLOPE * (w.s[i] - w.s[i - 1]), lt[i]);
  lb[n - 1] = lt[n - 1];
  for (let i = n - 2; i >= 0; i--) lb[i] = Math.max(lb[i + 1] + MIN_SLOPE * (w.s[i + 1] - w.s[i]), lt[i]);
  const out = new Float32Array(n);
  // Never less than most of its depth under the land, though: a wash is a cut, not a ditch on a bank. And never less than a
  // little under the lowest land right beside it, so it always has banks to hold a flood (`Wash.cap`).
  for (let i = 0; i < n; i++) out[i] = Math.min(0.5 * (lf[i] + lb[i]), lt[i] + 0.4 * cut[i], g[i] - MIN_CUT);
  for (let i = 1; i < n; i++) out[i] = Math.min(out[i], out[i - 1] - MIN_SLOPE * (w.s[i] - w.s[i - 1]));
  return out;
}

/** Final bed: it meets what it runs into, then the banks follow from how deep it lies. */
function settleBed(def: TerrainDef, net: WashNet, w: Wash, bed: Float32Array) {
  const n = w.n;
  let target: number;
  if (w.into.kind === 'pan') target = net.pans[w.into.ref].floor + 0.05;
  else {
    const r = def.hydro!.rivers[w.into.ref];
    let best = 0;
    for (let i = 0; i < r.n; i++) if (Math.hypot(r.x[i] - w.x[n - 1], r.z[i] - w.z[n - 1]) < Math.hypot(r.x[best] - w.x[n - 1], r.z[best] - w.z[n - 1])) best = i;
    // A dry bed meets a river at its water's edge.
    target = r.level[best] - 0.1;
  }
  const sEnd = w.s[w.end];
  for (let i = 0; i < n; i++) {
    if (i >= w.end) bed[i] = target;
    else bed[i] = Math.max(bed[i], target + MIN_SLOPE * (sEnd - w.s[i]));
  }
  for (let i = 1; i < n; i++) bed[i] = Math.min(bed[i], bed[i - 1]);
  w.bed.set(bed);
  for (let i = 0; i < n; i++) {
    const nx = -w.dz[i];
    const nz = w.dx[i];
    const side = Math.max(heightAt(def, w.x[i] + nx * (w.half[i] + 3), w.z[i] + nz * (w.half[i] + 3)), heightAt(def, w.x[i] - nx * (w.half[i] + 3), w.z[i] - nz * (w.half[i] + 3)));
    const cut = Math.max(0, side - bed[i]);
    // A bank of sand and gravel stands steep while it is low; a deep cut lies back, and the gorge walls are rock.
    w.bank[i] = clamp(1.6 + cut * 0.75, 1.6, i < 30 ? 12 : 26);
  }
  const b = Float32Array.from(w.bank);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    let k = 0;
    for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) {
      acc += b[j];
      k++;
    }
    w.bank[i] = Math.max(b[i] * 0.7, acc / k);
  }
  // The deepest a flood may run: a freeboard under the land at the top of the lower bank, where the cut ends (the land the
  // wash is cut into: the washes are not carved yet), the least of it over a few samples either way. A road ramping down
  // into the bed stands the bank back, and the flood runs out over the dip in the road as far as that.
  const top = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const nx = -w.dz[i];
    const nz = w.dx[i];
    const reach = w.half[i] + Math.max(w.bank[i], roadRamp(def, w.x[i], w.z[i]));
    let lo = Infinity;
    for (const side of [-1, 1]) lo = Math.min(lo, heightAt(def, w.x[i] + nx * reach * side, w.z[i] + nz * reach * side));
    top[i] = Math.max(0, lo - bed[i] - FLOOD_FREEBOARD);
  }
  for (let i = 0; i < n; i++) {
    let m = top[i];
    for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) m = Math.min(m, top[j]);
    w.cap[i] = m;
  }
}

function indexWash(net: WashNet, w: Wash) {
  for (let i = 0; i + 1 < w.n; i++) {
    // Room for the banks, and for a road's ramps where one crosses.
    const pad = Math.max(w.half[i] + w.bank[i], w.half[i + 1] + w.bank[i + 1]) + 30;
    const i0 = Math.floor((Math.min(w.x[i], w.x[i + 1]) - pad) / GRID);
    const i1 = Math.floor((Math.max(w.x[i], w.x[i + 1]) + pad) / GRID);
    const j0 = Math.floor((Math.min(w.z[i], w.z[i + 1]) - pad) / GRID);
    const j1 = Math.floor((Math.max(w.z[i], w.z[i + 1]) + pad) / GRID);
    for (let a = i0; a <= i1; a++) {
      for (let b = j0; b <= j1; b++) {
        const k = cellKey(a, b);
        let arr = net.grid.get(k);
        if (!arr) net.grid.set(k, (arr = []));
        arr.push(w.id, i);
      }
    }
  }
}

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
  return { n: xs.length, x: Float32Array.from(xs), z: Float32Array.from(zs), s: Float32Array.from(ss) };
}
