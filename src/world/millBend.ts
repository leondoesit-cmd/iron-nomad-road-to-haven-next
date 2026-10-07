import { Rng, noise2 } from '../core/rng';
import { clamp, smoothstep } from '../core/math';
import { courseAt, innerBank, type Loop } from './hydro';
import { heightAt, waterAt, type TerrainDef } from './terrain';
import { leanToward, TREE_SPECIES, type TreeSpot } from './flora';
import { hLocal, hWorld, OM, type Heritage } from './heritage';
import { nearestRoad } from './openWorld';
import type { Aabb, PropSpawn } from './layout';

/**
 * What stands in and round an omega bend (`hydro.ts` `Loop`): the Half Island, a few minutes' walk upstream of the Concrete
 * House, where the Yarkon swings round a near-island and Abu Rabah mill stands across the river where it comes round square
 * into the top of the left-hand leg. The way in, at the neck, is a tangle of tunnels through a thicket of giant cane
 * (`tunnels`); no cane grows on the island itself (`isle`). A second row of old gums lines the dirt road round the far side
 * (`row`). Inside: low grass, and the old eucalyptus: river red gums a century old, their feet swollen two and three metres wide, some parted low into
 * two stems, some split open down one side, the bark of the foot dark, burred and fire-scarred under the pale smooth stems.
 * Where a burl, a knot-hole and a crack fall right, the foot of one looks back at you: a face, subtle, the kind you see
 * once and then cannot stop seeing (and on liberty caps, which grow round their roots, cannot look away from). Two more
 * stand on the little island in the stream on their tangle of roots. At the muddy landing on the inner bank: a pedal boat
 * for two tied up, a fire ring with a few sticks, the stumps of felled gums.
 *
 * Pure and deterministic, no three.js. The trunk's stems and crowns are ordinary eucalyptus (`bendStems`, planted by the
 * chunks like any tree); its swollen foot with its faces is `render/faceGums.ts`'s, built from the same numbers.
 */

export interface GumStem {
  /** Foot of the stem relative to the trunk's centre, the way it leans (radians, world) and how far, its size and model. */
  dx: number;
  dz: number;
  dir: number;
  lean: number;
  s: number;
  v: number;
}

export interface GumFace {
  /** Which way it looks (radians, world: atan2 of z, x), the height of its eyes over the foot, its size, and its own seed. */
  az: number;
  h: number;
  s: number;
  seed: number;
}

export interface OldGum {
  id: number;
  x: number;
  z: number;
  /** Ground at its foot (the lowest round it, so it never stands on air). */
  y: number;
  /** Radius of the foot at a metre up, and the height its stems come out of it. */
  r: number;
  top: number;
  /** `fork`: parts into two stems; `hollow`: one stem, split open down one side (`cav`); `burl`: one stem, all knots and lumps. */
  form: 'fork' | 'hollow' | 'burl';
  stems: GumStem[];
  faces: GumFace[];
  /** The split of a hollow one: which way it opens, and from and to what height. */
  cav: { az: number; h0: number; h1: number } | null;
  /** Fire scars round the foot: which side, how high. */
  burn: { az: number; h: number };
  seed: number;
  island: boolean;
}

export interface Stump {
  x: number;
  z: number;
  y: number;
  r: number;
  h: number;
  /** Burnt out on top, a charred hollow in the cut. */
  burnt: boolean;
  seed: number;
}

export interface Bend {
  key: string;
  name: string;
  loop: Loop;
  gums: OldGum[];
  stumps: Stump[];
  /** The fire ring by the landing, the pedal boat tied up at it (stern to the mud), the willow by the mill. */
  fire: { x: number; z: number; y: number } | null;
  boat: { x: number; z: number; yaw: number } | null;
  willow: TreeSpot | null;
  /** Patches of liberty caps round the old gums' feet. */
  shrooms: { x: number; z: number; y: number }[];
  /** Radius of the open meadow inside the bulb (from the loop's centre). */
  meadow: number;
  /** The worn footpath in over the crossing: from the bank beyond the neck, down the dry strip, up onto the meadow. */
  path: [number, number][];
  /** The mill at the top of the left-hand leg, if it stands there. */
  mill: Heritage | null;
  /** The outer end of the way in (the crossing's, or the neck), where the tunnels through the cane lead to. */
  hub: [number, number];
  /** The loop's centre-line round the bulb, closed across the neck (flat x, z), and its box: inside it is the island. */
  isle: Float32Array;
  isleBox: [number, number, number, number];
  /** The same as a mask a metre to the cell over the box (1 inside), so a point is looked up rather than tested. */
  isleMask: Uint8Array;
  /** Each tunnel's box (x0, z0, x1, z1), for passing them by. */
  tunnelBox: Float32Array;
  /** The tunnels through the cane at the way in (flat x, z every couple of metres): on from the path, branching, dead-ending. */
  tunnels: number[][];
  /** The second row of old gums, along the dirt road round the far side of the bend. */
  row: TreeSpot[];
}

/** Half the width of the footpath over a bend's crossing, and of a tunnel through the cane. */
const PATH_HALF = 1.3;
const TUNNEL_HALF = 0.9;
/** How far round the outer end of the way in the cane stands thick, and round the neck (no way in there) (metres). */
const THICKET_R = 58;
const NECK_CANE = 34;
/** How far from the outer end of the way in its path and tunnels can reach. */
const REACH = 140;
/** How far past the causeway's edge its culverts' faces stand, and so how far their cap reaches back over the earth. */
export const CULVERT_OUT = 2.2;

/** Whether a point is on a mill's building or its steps, with `pad` to spare. */
function onMill(mill: Heritage | null, x: number, z: number, pad: number): boolean {
  if (!mill) return false;
  const [a, c] = hLocal(mill, x, z);
  if (Math.abs(a) < OM.hw + pad && Math.abs(c) < OM.hd + pad) return true;
  return Math.abs(a) < OM.steps.w / 2 + pad && Math.abs(c) < OM.hd + OM.steps.run + pad;
}

/**
 * The footpath in, every couple of metres, smoothed: along the crossing from its outer end, past the mill's door and over
 * the causeway onto the strip by the pond, then on in toward the middle of the bend. (Where there is no crossing, in over the
 * neck: the middle of the dry strip there from 25 m outside it to 30 m inside.)
 */
function crossingPath(def: TerrainDef, lp: Loop, mill: Heritage | null): [number, number][] {
  const c = lp.cross;
  if (c) {
    const pts: [number, number][] = [];
    for (let s = 0; s <= c.len + 0.01; s += 2) pts.push([c.x0 + c.ax * s, c.z0 + c.az * s]);
    const dl = Math.hypot(lp.x - c.x1, lp.z - c.z1) || 1;
    const dx = (lp.x - c.x1) / dl;
    const dz = (lp.z - c.z1) / dl;
    for (let s = 2; s <= 30; s += 2) pts.push([c.x1 + dx * s, c.z1 + dz * s]);
    for (let it = 0; it < 2; it++) for (let k = 1; k + 1 < pts.length; k++) pts[k] = [(pts[k - 1][0] + 2 * pts[k][0] + pts[k + 1][0]) / 4, (pts[k - 1][1] + 2 * pts[k][1] + pts[k + 1][1]) / 4];
    return pts;
  }
  const ux0 = lp.x - lp.nx;
  const uz0 = lp.z - lp.nz;
  const ul = Math.hypot(ux0, uz0) || 1;
  const ux = ux0 / ul;
  const uz = uz0 / ul;
  const lx = uz;
  const lz = -ux;
  const wet = (x: number, z: number) => !!waterAt(def, x, z) || onMill(mill, x, z, 1.0);
  const out: [number, number][] = [];
  let off = 0;
  for (let a = -25; a <= 30; a += 2) {
    const cx = lp.nx + ux * a;
    const cz = lp.nz + uz * a;
    // The dry run across here nearest where the path was last.
    let best = off;
    let bd = Infinity;
    let start = NaN;
    let prev = true;
    for (let s = -30; s <= 30.01; s += 0.25) {
      const w = wet(cx + lx * s, cz + lz * s) || s >= 30;
      if (!w && prev) start = s;
      if (w && !prev && !Number.isNaN(start)) {
        const mid = (start + s) / 2;
        const d = Math.abs(mid - off);
        if (d < bd) {
          bd = d;
          best = Math.max(start + PATH_HALF + 0.4, Math.min(s - PATH_HALF - 0.4, off));
          if (s - start < 2 * PATH_HALF + 2) best = mid;
        }
      }
      prev = w;
    }
    off = best;
    out.push([cx + lx * off, cz + lz * off]);
  }
  for (let it = 0; it < 3; it++) for (let k = 1; k + 1 < out.length; k++) out[k] = [(out[k - 1][0] + 2 * out[k][0] + out[k + 1][0]) / 4, (out[k - 1][1] + 2 * out[k][1] + out[k + 1][1]) / 4];
  return out;
}

/** True within `m` metres of a bend's footpath over its crossing. */
export function nearPath(def: TerrainDef, x: number, z: number, m: number): boolean {
  for (const b of def.bends ?? []) if (Math.hypot(x - b.hub[0], z - b.hub[1]) < REACH && pathDist(b, x, z) < m) return true;
  return false;
}

/** How far a point is from a bend's footpath (metres). */
function pathDist(b: Bend, x: number, z: number): number {
  let d = Infinity;
  const p = b.path;
  for (let k = 0; k + 1 < p.length; k++) {
    const ax = p[k][0];
    const az = p[k][1];
    const ex = p[k + 1][0] - ax;
    const ez = p[k + 1][1] - az;
    const l2 = ex * ex + ez * ez || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2));
    d = Math.min(d, Math.hypot(x - ax - ex * t, z - az - ez * t));
  }
  return d;
}

const GUMS_ON_MEADOW = 7;
/** Bare earth under an old gum, out to this many times its foot's radius plus a few metres: its own fallen leaves. */
const BARE = 1.35;

/** The lowest ground round a circle: a trunk stands on it. */
function footGround(def: TerrainDef, x: number, z: number, r: number): number {
  let lo = heightAt(def, x, z);
  for (let a = 0; a < 8; a++) {
    const th = (a / 8) * Math.PI * 2;
    lo = Math.min(lo, heightAt(def, x + Math.cos(th) * r, z + Math.sin(th) * r));
  }
  return lo;
}

function makeGum(def: TerrainDef, rng: Rng, id: number, x: number, z: number, form: OldGum['form'], island: boolean): OldGum {
  const r = island ? rng.range(0.78, 0.9) : rng.range(1.2, 1.45);
  const top = island ? rng.range(1.6, 2.0) : form === 'fork' ? rng.range(2.3, 2.8) : rng.range(2.6, 3.3);
  // One stem out of the foot: the eucalyptus's own V (variant 2) for a forked one, the broad old red gum (variant 0) else.
  const stems: GumStem[] = [{ dx: 0, dz: 0, dir: rng.range(0, Math.PI * 2), lean: rng.range(0.02, 0.05), s: island ? rng.range(1.0, 1.1) : form === 'fork' ? rng.range(1.3, 1.42) : rng.range(1.12, 1.28), v: form === 'fork' || island ? 2 : 0 }];
  const faces: GumFace[] = [];
  const a0 = rng.range(0, Math.PI * 2);
  const nF = island || form === 'hollow' ? 1 : rng.next() < 0.6 ? 2 : 1;
  for (let k = 0; k < nF; k++) faces.push({ az: a0 + k * rng.range(2.3, 3.5), h: island ? rng.range(1.0, 1.25) : rng.range(1.2, 1.75), s: rng.range(0.85, 1.2) * (island ? 0.85 : 1), seed: rng.int(1, 99999) });
  const cav = form === 'hollow' ? { az: a0 + rng.range(1.2, 1.9) * (rng.next() < 0.5 ? 1 : -1), h0: rng.range(0.25, 0.5), h1: top - rng.range(0.3, 0.6) } : null;
  return {
    id,
    x,
    z,
    y: footGround(def, x, z, r * 1.2),
    r,
    top,
    form,
    stems,
    faces,
    cav,
    burn: { az: rng.range(0, Math.PI * 2), h: rng.range(0.6, 1.6) },
    seed: rng.int(1, 999999),
    island,
  };
}

/**
 * What stands in each bend. Run in `makeTerrainDef` once the heritage is planned (the mill is one of them), so the
 * grove keeps clear of it.
 */
export function planBends(def: TerrainDef): Bend[] {
  const hy = def.hydro;
  const out: Bend[] = [];
  if (!hy?.ready) return out;
  for (const lp of hy.loops) {
    const r = hy.rivers[lp.river];
    const rng = new Rng(def.seed * 97 + 4111 + out.length * 31);
    const mill: Heritage | null = def.heritage?.find((h) => h.id === 'oldMill' && Math.hypot(h.x - r.x[lp.mill], h.z - r.z[lp.mill]) < 6) ?? null;
    const isle = new Float32Array((lp.i1 - lp.i0 + 1) * 2);
    const isleBox: Bend['isleBox'] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = lp.i0; i <= lp.i1; i++) {
      const k = (i - lp.i0) * 2;
      isle[k] = r.x[i];
      isle[k + 1] = r.z[i];
      isleBox[0] = Math.min(isleBox[0], r.x[i]);
      isleBox[1] = Math.min(isleBox[1], r.z[i]);
      isleBox[2] = Math.max(isleBox[2], r.x[i]);
      isleBox[3] = Math.max(isleBox[3], r.z[i]);
    }
    let half = 0;
    for (let i = lp.i0; i <= lp.i1; i++) half += r.half[i] / (lp.i1 - lp.i0 + 1);
    const meadow = lp.r - half - 2;
    const inner = meadow - 7;
    const gums: OldGum[] = [];
    const L = lp.landing;
    const clearOf = (x: number, z: number) => {
      if (Math.hypot(x - lp.x, z - lp.z) > inner) return false;
      const c = courseAt(hy, x, z, 4);
      if (c && c.d < c.half + 8) return false;
      if (mill && Math.hypot(x - mill.x, z - mill.z) < 25) return false;
      if (L && Math.hypot(x - L.x, z - L.z) < 14) return false;
      return true;
    };
    // The old gums stand wide apart about the meadow, a few toward the middle and the rest round it.
    const forms: OldGum['form'][] = ['fork', 'hollow', 'burl', 'fork', 'burl', 'hollow', 'fork'];
    for (let tries = 0; gums.length < GUMS_ON_MEADOW && tries < 600; tries++) {
      const a = rng.range(0, Math.PI * 2);
      const d = inner * Math.sqrt(rng.range(0.04, 1));
      const x = lp.x + Math.cos(a) * d;
      const z = lp.z + Math.sin(a) * d;
      if (!clearOf(x, z) || gums.some((g) => Math.hypot(g.x - x, g.z - z) < 17)) continue;
      gums.push(makeGum(def, rng, gums.length, x, z, forms[gums.length % forms.length], false));
    }
    // Two on the island, close together on one tangle of roots, leaning apart.
    if (lp.island) {
      const is = lp.island;
      const axis = rng.range(0, Math.PI);
      for (const s of [-1, 1]) {
        const x = is.x + Math.cos(axis) * 1.15 * s;
        const z = is.z + Math.sin(axis) * 1.15 * s;
        const g = makeGum(def, rng, gums.length, x, z, 'burl', true);
        g.stems[0].dir = axis + (s > 0 ? 0 : Math.PI);
        g.stems[0].lean = rng.range(0.09, 0.14);
        gums.push(g);
      }
    }
    // The landing: a fire ring up the mud, stumps of felled gums round it, the boat pulled up with its bow on the mud.
    const stumps: Stump[] = [];
    let fire: Bend['fire'] = null;
    let boat: Bend['boat'] = null;
    if (L) {
      const tx = -L.nz;
      const tz = L.nx;
      const at = (v: number, u: number): [number, number] => [L.x + L.nx * v + tx * u, L.z + L.nz * v + tz * u];
      const [fx, fz] = at(6.2, -2.4);
      fire = { x: fx, z: fz, y: heightAt(def, fx, fz) };
      // Tied up stern to the mud, its bow to the open water: step aboard and pedal away.
      const [bx, bz] = at(-1.8, 1.2);
      boat = { x: bx, z: bz, yaw: Math.atan2(-L.nx, -L.nz) };
      const spots: [number, number, boolean][] = [
        [8.5, -6.5, true],
        [10.2, 1.5, false],
        [7.4, 6.8, true],
        [11.5, -1.8, false],
      ];
      for (const [v, u, burnt] of spots) {
        const [x, z] = at(v + rng.range(-0.6, 0.6), u + rng.range(-0.6, 0.6));
        const rr = rng.range(0.5, 0.85);
        stumps.push({ x, z, y: footGround(def, x, z, rr), r: rr, h: rng.range(0.32, 0.62), burnt, seed: rng.int(1, 99999) });
      }
    }
    // Two more out on the meadow.
    for (let tries = 0, n = 0; n < 2 && tries < 200; tries++) {
      const a = rng.range(0, Math.PI * 2);
      const d = inner * Math.sqrt(rng.range(0.1, 1));
      const x = lp.x + Math.cos(a) * d;
      const z = lp.z + Math.sin(a) * d;
      if (!clearOf(x, z) || gums.some((g) => Math.hypot(g.x - x, g.z - z) < g.r * BARE + 6) || stumps.some((s) => Math.hypot(s.x - x, s.z - z) < 8)) continue;
      const rr = rng.range(0.55, 0.9);
      stumps.push({ x, z, y: footGround(def, x, z, rr), r: rr, h: rng.range(0.3, 0.55), burnt: rng.next() < 0.5, seed: rng.int(1, 99999) });
      n++;
    }
    // A weeping willow on the meadow's bank by the mill, hanging over the water in front of its wall.
    let willow: TreeSpot | null = null;
    if (mill) {
      const [wx, wz] = hWorld(mill, -(OM.hw + 3.6), OM.hd - 3);
      willow = { x: wx, y: heightAt(def, wx, wz) - 0.12, z: wz, yaw: rng.range(0, Math.PI * 2), s: 1.05, sp: TREE_SPECIES.indexOf('willow'), v: 0, lean: [0, 0] };
      willow.lean = leanToward(willow.yaw, mill.x - wx, mill.z - wz, 0.16);
    }
    // Liberty caps in the grass round the old gums' feet, two or three patches to a tree.
    const shrooms: Bend['shrooms'] = [];
    for (const g of gums) {
      if (g.island) continue;
      const n = 2 + (g.seed % 2);
      for (let k = 0; k < n; k++) {
        const a = rng.range(0, Math.PI * 2);
        const d = g.r * 1.45 + rng.range(0.5, 2.2);
        const x = g.x + Math.cos(a) * d;
        const z = g.z + Math.sin(a) * d;
        shrooms.push({ x, z, y: heightAt(def, x, z) });
      }
    }
    const path = crossingPath(def, lp, mill);
    const hub: [number, number] = lp.cross ? [lp.cross.x0, lp.cross.z0] : [lp.nx, lp.nz];
    const b: Bend = { key: lp.key, name: lp.name, loop: lp, gums, stumps, fire, boat, willow, shrooms, meadow, path, mill, hub, isle, isleBox, isleMask: new Uint8Array(0), tunnelBox: new Float32Array(0), tunnels: [], row: [] };
    const mw = Math.ceil(isleBox[2] - isleBox[0]) + 1;
    const mh = Math.ceil(isleBox[3] - isleBox[1]) + 1;
    b.isleMask = new Uint8Array(mw * mh);
    for (let j = 0; j < mh; j++) for (let i = 0; i < mw; i++) b.isleMask[j * mw + i] = inPolygon(isle, isleBox[0] + i + 0.5, isleBox[1] + j + 0.5) ? 1 : 0;
    const rng2 = new Rng(def.seed * 131 + 977 + out.length * 17);
    b.tunnels = caneTunnels(def, b, rng2);
    b.tunnelBox = new Float32Array(b.tunnels.length * 4);
    b.tunnels.forEach((p, k) => {
      let x0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let z1 = -Infinity;
      for (let q = 0; q + 1 < p.length; q += 2) {
        x0 = Math.min(x0, p[q]);
        x1 = Math.max(x1, p[q]);
        z0 = Math.min(z0, p[q + 1]);
        z1 = Math.max(z1, p[q + 1]);
      }
      b.tunnelBox.set([x0, z0, x1, z1], k * 4);
    });
    b.row = roadRow(def, b, rng2);
    out.push(b);
  }
  return out;
}

/** Whether a point lies inside a bend's loop (the island, and the inner half of the stream round it), to a metre. */
function inIsle(b: Bend, x: number, z: number): boolean {
  const [x0, z0, x1, z1] = b.isleBox;
  if (x < x0 || x > x1 || z < z0 || z > z1) return false;
  if (!b.isleMask.length) return inPolygon(b.isle, x, z);
  const mw = Math.ceil(x1 - x0) + 1;
  return b.isleMask[Math.floor(z - z0) * mw + Math.floor(x - x0)] === 1;
}

/** Whether a point lies inside a closed polygon (flat x, z). */
function inPolygon(p: Float32Array, x: number, z: number): boolean {
  const n = p.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2];
    const zi = p[i * 2 + 1];
    const xj = p[j * 2];
    const zj = p[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The tunnels through the cane at the way in: the path on out from the neck to the edge of the thicket, wandering; side ways
 * off it that wander away and end where they end (one branching again); and a short way from the mill's outer door to the
 * dirt road.
 */
function caneTunnels(def: TerrainDef, b: Bend, rng: Rng): number[][] {
  const lp = b.loop;
  const out: number[][] = [];
  const free = (x: number, z: number, far: number) => {
    const w = waterAt(def, x, z);
    if (w && w.depth > 0.12) return false;
    if (inIsle(b, x, z) || onMill(b.mill, x, z, 0.6)) return false;
    return Math.hypot(x - b.hub[0], z - b.hub[1]) < far;
  };
  // Two metres a step on a heading (radians: atan2 of x, z), wandering about it but never far off it, round the water.
  const wander = (x: number, z: number, hd: number, len: number) => {
    const pts = [x, z];
    let h = hd;
    for (let s = 0; s < len; s += 2) {
      let moved = false;
      for (const turn of [0, 0.45, -0.45, 0.9, -0.9]) {
        const hc = hd + clamp(h + turn + (turn ? 0 : rng.range(-0.28, 0.28)) - hd, -0.75, 0.75);
        const nx = x + Math.sin(hc) * 2;
        const nz = z + Math.cos(hc) * 2;
        if (!free(nx, nz, THICKET_R + 4)) continue;
        x = nx;
        z = nz;
        h = hc;
        moved = true;
        break;
      }
      if (!moved) break;
      pts.push(x, z);
    }
    return pts;
  };
  // Straight-ish to a point two metres a step, round the water (turning out from it where the straight way is wet).
  const toward = (x: number, z: number, tx: number, tz: number) => {
    const pts = [x, z];
    const dry = (px: number, pz: number) => {
      const w = waterAt(def, px, pz);
      return (!w || w.depth < 0.05) && !inIsle(b, px, pz) && !onMill(b.mill, px, pz, 0.6);
    };
    for (let k = 0; k < 40 && Math.hypot(tx - x, tz - z) > 2.5; k++) {
      const h0 = Math.atan2(tx - x, tz - z) + rng.range(-0.15, 0.15);
      let moved = false;
      for (const turn of [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.6, -1.6]) {
        const nx = x + Math.sin(h0 + turn) * 2;
        const nz = z + Math.cos(h0 + turn) * 2;
        if (!dry(nx, nz) || !dry(nx + Math.sin(h0 + turn) * 1.5, nz + Math.cos(h0 + turn) * 1.5)) continue;
        x = nx;
        z = nz;
        moved = true;
        break;
      }
      if (!moved) break;
      pts.push(x, z);
    }
    return pts;
  };
  // Away from the way in: on along the crossing's line outward, or out from the neck.
  const c = lp.cross;
  const away = c ? Math.atan2(-c.ax, -c.az) : Math.atan2(-lp.ux, -lp.uz);
  const p0 = b.path[0];
  const main = wander(p0[0], p0[1], away, c ? THICKET_R - 8 : THICKET_R - 25 + 6);
  out.push(main);
  const at = (pts: number[], f: number): [number, number] => {
    const k = Math.min(pts.length / 2 - 1, Math.max(0, Math.round((pts.length / 2 - 1) * f)));
    return [pts[k * 2], pts[k * 2 + 1]];
  };
  const pIn = c ? p0 : b.path[Math.min(b.path.length - 1, 8)];
  const branches: [[number, number], number, number][] = [
    [pIn, away + rng.range(1.05, 1.4), rng.range(18, 26)],
    [pIn, away - rng.range(1.05, 1.4), rng.range(14, 22)],
    [at(main, 0.4), away - rng.range(0.85, 1.25), rng.range(16, 26)],
    [at(main, 0.75), away + rng.range(0.85, 1.25), rng.range(12, 20)],
  ];
  for (const [[x, z], hd, len] of branches) {
    const br = wander(x, z, hd, len);
    if (br.length >= 6) out.push(br);
  }
  // A dead end off the first branch.
  if (out.length > 1) {
    const [x, z] = at(out[1], 0.55);
    const br = wander(x, z, away + rng.range(-0.3, 0.3), rng.range(8, 14));
    if (br.length >= 6) out.push(br);
  }
  // From the outer end of the way in to the nearest of the dirt road round the bend, unless it ends right there.
  const ring = lp.road;
  let best: [number, number, number] = [0, 0, Infinity];
  for (let k = 0; k + 1 < ring.length; k += 2) {
    const d = pathDist(b, ring[k], ring[k + 1]);
    if (d < best[2]) best = [ring[k], ring[k + 1], d];
  }
  if (best[2] > 5 && Math.hypot(best[0] - p0[0], best[1] - p0[1]) < 45) out.push(toward(p0[0], p0[1], best[0], best[1]));
  return out;
}

/** The second row of old gums: every dozen metres or so along the dirt road round the far half of the bend, just outside it. */
function roadRow(def: TerrainDef, b: Bend, rng: Rng): TreeSpot[] {
  const lp = b.loop;
  const out: TreeSpot[] = [];
  const sp = TREE_SPECIES.indexOf('eucalyptus');
  const p = lp.road;
  const tFar = Math.hypot(lp.x - lp.nx, lp.z - lp.nz) * 0.8;
  let acc = 0;
  let next = rng.range(3, 8);
  for (let k = 2; k + 1 < p.length; k += 2) {
    const ax = p[k - 2];
    const az = p[k - 1];
    const bx = p[k];
    const bz = p[k + 1];
    const seg = Math.hypot(bx - ax, bz - az) || 1;
    acc += seg;
    if (acc < next) continue;
    next = acc + rng.range(10, 14);
    if ((bx - lp.nx) * lp.ux + (bz - lp.nz) * lp.uz < tFar) continue;
    // Out from the road, away from the bulb.
    let nx = -(bz - az) / seg;
    let nz = (bx - ax) / seg;
    if (nx * (bx - lp.x) + nz * (bz - lp.z) < 0) {
      nx = -nx;
      nz = -nz;
    }
    const off = 2.6 + rng.range(3.0, 4.6);
    const x = bx + nx * off;
    const z = bz + nz * off;
    const gap = rng.next();
    const yaw = rng.range(0, Math.PI * 2);
    const s = rng.range(1.3, 1.62);
    const v = rng.next() < 0.55 ? 0 : 2;
    const lean = rng.range(0.02, 0.06);
    if (gap < 0.12 || waterAt(def, x, z)) continue;
    if (def.open && nearestRoad(def.open, x, z).edge < 1.8) continue;
    out.push({ x, y: heightAt(def, x, z) - 0.25, z, yaw, s, sp, v, lean: leanToward(yaw, nx, nz, lean) });
  }
  return out;
}

/** Distance from a bend's tunnels through the cane (metres), and the nearest point on them. */
function tunnelHit(b: Bend, x: number, z: number): { d: number; x: number; z: number } {
  const hit = { d: Infinity, x: 0, z: 0 };
  // (Only ever asked how near within a few metres: farther than eight from a stone's throw of a tunnel is far enough.)
  const bx = b.tunnelBox;
  for (let t = 0; t < b.tunnels.length; t++) {
    const p = b.tunnels[t];
    if (bx.length && (x < bx[t * 4] - 8 || z < bx[t * 4 + 1] - 8 || x > bx[t * 4 + 2] + 8 || z > bx[t * 4 + 3] + 8)) continue;
    for (let k = 0; k + 3 < p.length; k += 2) {
      const ax = p[k];
      const az = p[k + 1];
      if (Math.abs(x - ax) > 8 || Math.abs(z - az) > 8) continue;
      const ex = p[k + 2] - ax;
      const ez = p[k + 3] - az;
      const l2 = ex * ex + ez * ez || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2));
      const px = ax + ex * t;
      const pz = az + ez * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < hit.d) {
        hit.d = d;
        hit.x = px;
        hit.z = pz;
      }
    }
  }
  return hit;
}

/** True on a bend's island (inside its loop, or on the little island in its pond). */
function isleOf(b: Bend, x: number, z: number): boolean {
  const is = b.loop.island;
  return inIsle(b, x, z) || (!!is && Math.hypot(x - is.x, z - is.z) < is.r + 3);
}

/** True on a bend's island (inside its loop, or on the little island in its pond), where no cane grows. */
export function onIsland(def: TerrainDef, x: number, z: number): boolean {
  for (const b of def.bends ?? []) if (isleOf(b, x, z)) return true;
  return false;
}

/** True within `pad` of a bend's mill and its steps. */
export function nearMill(def: TerrainDef, x: number, z: number, pad: number): boolean {
  for (const b of def.bends ?? []) if (b.mill && Math.abs(x - b.mill.x) < 40 && Math.abs(z - b.mill.z) < 40 && onMill(b.mill, x, z, pad)) return true;
  return false;
}

/**
 * How thick the giant cane stands at a point round a bend's way in (0..1): solid out from the neck, ragged at its edge, and
 * thinning out right at the neck, so that the tunnels come out into the open at the way in.
 */
export function caneThicket(def: TerrainDef, x: number, z: number): number {
  for (const b of def.bends ?? []) {
    const d = Math.hypot(x - b.hub[0], z - b.hub[1]);
    const dn = Math.hypot(x - b.loop.nx, z - b.loop.nz);
    if (d > THICKET_R + 8 && dn > NECK_CANE + 8) continue;
    const ragged = (noise2(x / 14 + 3, z / 14 - 7, def.seed + 515) - 0.5) * 16;
    const e = THICKET_R + ragged;
    const en = NECK_CANE + ragged * 0.6;
    const v = Math.max(1 - smoothstep(e - 12, e, d), 1 - smoothstep(en - 8, en, dn));
    return v > 0 && !isleOf(b, x, z) ? v : 0;
  }
  return 0;
}

/**
 * The nearest tunnel through the cane within `m` metres (or the footpath out where it runs through the cane): how far, and
 * the unit way toward it. Null if none is that near.
 */
export function caneTunnelNear(def: TerrainDef, x: number, z: number, m: number): { d: number; half: number; dx: number; dz: number } | null {
  for (const b of def.bends ?? []) {
    if (Math.hypot(x - b.hub[0], z - b.hub[1]) > REACH) continue;
    const t = tunnelHit(b, x, z);
    let best = { d: t.d, half: TUNNEL_HALF, x: t.x, z: t.z };
    // The footpath, where it runs out through the cane short of the neck.
    for (let k = 0; k + 1 < b.path.length; k++) {
      const [ax, az] = b.path[k];
      if (isleOf(b, ax, az)) break;
      const ex = b.path[k + 1][0] - ax;
      const ez = b.path[k + 1][1] - az;
      const l2 = ex * ex + ez * ez || 1;
      const u = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2));
      const d = Math.hypot(x - ax - ex * u, z - az - ez * u);
      if (d - PATH_HALF < best.d - best.half) best = { d, half: PATH_HALF, x: ax + ex * u, z: az + ez * u };
    }
    if (best.d - best.half > m) continue;
    const l = best.d || 1;
    return { d: best.d, half: best.half, dx: (best.x - x) / l, dz: (best.z - z) / l };
  }
  return null;
}

/** The bend a point lies in (inside its bulb, plus `pad`), or null. */
export function bendAt(def: TerrainDef, x: number, z: number, pad = 0): Bend | null {
  for (const b of def.bends ?? []) if (Math.hypot(x - b.loop.x, z - b.loop.z) < b.loop.r + pad) return b;
  return null;
}

/** The old gums' stems, the row along the far road and the mill's willow whose feet lie in a rectangle: planted with a chunk's trees. */
export function bendStems(def: TerrainDef, x0: number, z0: number, x1: number, z1: number): TreeSpot[] {
  const out: TreeSpot[] = [];
  const sp = TREE_SPECIES.indexOf('eucalyptus');
  for (const b of def.bends ?? []) {
    for (const g of b.gums) {
      g.stems.forEach((s, k) => {
        const x = g.x + s.dx;
        const z = g.z + s.dz;
        if (x < x0 || x >= x1 || z < z0 || z >= z1) return;
        const yaw = ((g.seed + k * 977) % 6283) / 1000;
        // Sunk a little, so its own roots hump out of the ground round the foot rather than lie on it.
        out.push({ x, y: g.y - 0.45, z, yaw, s: s.s, sp, v: s.v, lean: leanToward(yaw, Math.cos(s.dir), Math.sin(s.dir), s.lean), aspect: [1, 1] });
      });
    }
    for (const t of b.row) if (t.x >= x0 && t.x < x1 && t.z >= z0 && t.z < z1) out.push({ ...t, lean: [...t.lean] as [number, number] });
    const w = b.willow;
    if (w && w.x >= x0 && w.x < x1 && w.z >= z0 && w.z < z1) out.push({ ...w, lean: [...w.lean] as [number, number] });
  }
  return out;
}

/**
 * True where no ordinary tree or bush grows: the grass of the meadow inside a bend, and its island (the old gums are set by
 * hand), the footpath and the tunnels through the cane, and round the mill. The strip of muddy bank between the
 * grass and the water keeps its own gums, leaning out over the water on their roots.
 */
export function bendClear(def: TerrainDef, x: number, z: number): boolean {
  for (const b of def.bends ?? []) {
    if (Math.hypot(x - b.loop.x, z - b.loop.z) < b.meadow - 7) return true;
    const dh = Math.hypot(x - b.hub[0], z - b.hub[1]);
    if (dh < REACH && (pathDist(b, x, z) < PATH_HALF + 2.5 || tunnelHit(b, x, z).d < TUNNEL_HALF + 1.6 || onMill(b.mill, x, z, 2))) return true;
    const is = b.loop.island;
    if (is && Math.hypot(x - is.x, z - is.z) < is.r + 2) return true;
  }
  return false;
}

/**
 * How the ground of a bend reads at a point: `lawn` (0..1) the short-grazed grass of the meadow, `bare` (0..1) the earth
 * under an old gum strewn with its leaves (and under the cane round the way in, strewn with its dead canes), `mud` (0..1)
 * the landing, `path` (0..1) the footpath and the tunnels through the cane. Null outside every bend.
 */
export function bendGround(def: TerrainDef, x: number, z: number): { lawn: number; bare: number; mud: number; path: number } | null {
  for (const b of def.bends ?? []) {
    const lp = b.loop;
    const d = Math.hypot(x - lp.x, z - lp.z);
    // The footpath in over the crossing and the tunnels through the cane reach out past the bulb.
    const dh = Math.hypot(x - b.hub[0], z - b.hub[1]);
    let path = dh < REACH ? 1 - smoothstep(PATH_HALF - 0.4, PATH_HALF + 0.8, pathDist(b, x, z)) : 0;
    if (dh < REACH) path = Math.max(path, 1 - smoothstep(TUNNEL_HALF - 0.3, TUNNEL_HALF + 0.6, tunnelHit(b, x, z).d));
    const cane = dh < THICKET_R + 8 || Math.hypot(x - lp.nx, z - lp.nz) < NECK_CANE + 8 ? caneThicket(def, x, z) * 0.85 : 0;
    if (d > lp.r + 12) {
      if (path > 0 || cane > 0) return { lawn: 0, bare: cane, mud: 0, path };
      continue;
    }
    const lawn = 1 - smoothstep(b.meadow - 4, b.meadow + 3, d);
    let bare = 0;
    for (const g of b.gums) {
      const dd = Math.hypot(x - g.x, z - g.z);
      const rr = g.r * BARE + 1.8;
      if (dd < rr + 4) {
        // A ragged edge, the grass coming in in tongues.
        const a = Math.atan2(z - g.z, x - g.x);
        const wob = (noise2(Math.cos(a) * 1.7 + g.seed * 0.01, Math.sin(a) * 1.7, g.seed) - 0.5) * 2.6 + (noise2(x * 0.7, z * 0.7, g.seed + 3) - 0.5) * 1.4;
        bare = Math.max(bare, 1 - smoothstep(rr * 0.55, rr + 2, dd + wob));
      }
    }
    for (const s of b.stumps) {
      const dd = Math.hypot(x - s.x, z - s.z);
      if (dd < s.r + 2.5) bare = Math.max(bare, 1 - smoothstep(s.r + 0.4, s.r + 2.5, dd));
    }
    let mud = 0;
    // The mud of the inner bank, all round between the grass and the water.
    const c = def.hydro ? courseAt(def.hydro, x, z, 4) : null;
    if (c && c.river.id === lp.river) mud = innerBank(lp, x, z, c.d - c.half);
    const L = lp.landing;
    if (L) {
      const dx = x - L.x;
      const dz = z - L.z;
      const v = dx * L.nx + dz * L.nz;
      const u = Math.abs(dx * -L.nz + dz * L.nx);
      mud = Math.max(mud, (1 - smoothstep(L.w - 1, L.w + 3, u)) * (1 - smoothstep(6, 10, v)) * (v > -3 ? 1 : 0));
      if (b.fire) mud = Math.max(mud, 1 - smoothstep(1.5, 3.5, Math.hypot(x - b.fire.x, z - b.fire.z)));
    }
    return { lawn, bare: Math.max(bare, cane), mud, path };
  }
  return null;
}

/**
 * The boxes the bend collides as: each old gum's foot (a little off its centre, so it is never taken for the stem's own trunk
 * box) and each stump.
 */
export function bendAabbs(b: Bend, newId: () => number): Aabb[] {
  const out: Aabb[] = [];
  for (const g of b.gums) {
    const k = g.r * 0.92;
    out.push({ id: newId(), minX: g.x - k + 0.02, maxX: g.x + k + 0.02, minZ: g.z - k, maxZ: g.z + k, y0: g.y - 0.5, y1: g.y + g.top + 0.4, kind: 'tree', hp: 99999, mat: 'wood' });
  }
  for (const s of b.stumps) out.push({ id: newId(), minX: s.x - s.r * 0.9, maxX: s.x + s.r * 0.9, minZ: s.z - s.r * 0.9, maxZ: s.z + s.r * 0.9, y0: s.y - 0.3, y1: s.y + s.h, kind: 'furniture', hp: 99999, mat: 'wood' });
  return out;
}

/** The fire ring by the landing, and the concrete faces of the culverts either side of the causeway, as placed props. */
export function bendProps(b: Bend): PropSpawn[] {
  const out: PropSpawn[] = [];
  if (b.fire) out.push({ kind: 'campfire', x: b.fire.x, y: b.fire.y, z: b.fire.z, yaw: 0.7, scale: 0.85, seed: 77 });
  const c = b.loop.cross;
  if (c) {
    const m = (c.s0 + c.s1) / 2;
    const len = c.s1 - c.s0 - 0.4;
    for (const g of [1, -1]) {
      // Facing out over the water: across the crossing (its +z), `g` either side.
      const nx = -c.az * g;
      const nz = c.ax * g;
      // (Out at the foot of the causeway's earth, which the ground's two-metre grid slopes over; its cap reaches back to the top.)
      const q = c.w / 2 + CULVERT_OUT;
      out.push({ kind: 'culvert', x: c.x0 + c.ax * m + nx * q, y: c.level, z: c.z0 + c.az * m + nz * q, yaw: Math.atan2(nx, nz), scale: 1, seed: 3 + g, tag: Math.round(len * 4) });
    }
  }
  return out;
}

/** Whether a placed thing at (x, z) would stand in a bend's way: on its footpath or a tunnel through the cane. */
export function bendBlocks(b: Bend, x: number, z: number, pad: number): boolean {
  if (Math.hypot(x - b.hub[0], z - b.hub[1]) > REACH) return false;
  return pathDist(b, x, z) < PATH_HALF + pad || tunnelHit(b, x, z).d < TUNNEL_HALF + pad;
}
