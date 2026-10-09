import { clamp } from '../core/math';
import { SOILS, plateSinkage, repassSinkage, talus, type Crater, type Soil, type SoilKind } from './soil';

/**
 * The loose ground as a fine height field over the terrain: how far each point of it has been pressed down, dug out or
 * heaped up, metres, against the ground as the terrain draws it. Only ground something has touched is held, in tiles of
 * 2 m (the terrain's own cells, so a tile is drawn in place of exactly one cell of the ground mesh) with a vertex every
 * 4 cm: enough for a tyre's rut and berms, a boot print, a bullet's crater.
 *
 * Every operation keeps the soil's volume: what a load presses down is packed denser or pushed aside into berms, what a
 * spinning tyre or a crater digs out is handed back to be thrown (`dig`, `crater`) and comes down again somewhere
 * (`deposit`), and what slumps off a wall too steep for it (`relax`) lands at its foot. Each point also remembers the
 * hardest pressure it has borne, so a rut already pressed carries the next tyre of that weight without sinking much more
 * (see `sim/soil.ts`), and how much it has been turned over, which the ground shader draws as fresh, darker soil.
 *
 * Pure: no engine imports. `env.soilAt` names the soil at a point (null where the ground is rock, asphalt or concrete).
 */

/** Metres between vertices. */
export const DCELL = 0.04;
/** Vertices per side of a tile (its own; the next row belongs to the next tile). */
export const TILE_N = 50;
/** Metres per side of a tile: the terrain's cell. */
export const TILE = DCELL * TILE_N;
const N2 = TILE_N * TILE_N;
const AREA = DCELL * DCELL;
/** Deepest anything digs: craters of the biggest blasts. */
const DEEPEST = 1.2;
/** Turned-over soil, as stored (0..255). */
const TURN_MAX = 255;

export interface FieldEnv {
  /** The soil at a point, or null where the ground does not give (rock, asphalt, concrete, water). */
  soilAt(x: number, z: number): Soil | null;
}

export class GroundTile {
  /** Height against the drawn ground, m, per vertex (row-major: index = j * TILE_N + i, i along x). */
  readonly h = new Float32Array(N2);
  /** The hardest pressure each vertex has borne, Pa (its preconsolidation). */
  readonly pc: Float32Array;
  /** How turned over the soil is, 0..255. */
  readonly t = new Uint8Array(N2);
  /** How charred it is by a blast (or how damp and dark a hole's inside), 0..255. */
  readonly c = new Uint8Array(N2);
  /** How broken its dry crust is round a blow, 0..255: the drawing cracks it into plates there (where it looks crusted). */
  readonly k = new Uint8Array(N2);
  /**
   * Loose soil lying on top, m: heaped in a berm, thrown out of a crater, slumped off a wall. A tyre or a boot pushes it
   * aside rather than packing it, so soil worked over and over is never packed away to nothing.
   */
  readonly lo = new Float32Array(N2);
  /** The last pass that pressed each vertex (low byte of its id) and how many have. */
  readonly stamp = new Uint8Array(N2);
  readonly passes = new Uint8Array(N2);
  /** Bumped on every change to this tile or to the neighbours' rows it is drawn with. */
  version = 0;
  /** Field clock when it was last changed. */
  touched = 0;
  /** Holds something small and sharp (a crater): drawn at full detail farther from the camera than a rut needs. */
  fine = false;
  /** Vertices still settling (local, inclusive; empty when i0 > i1). */
  ri0 = 1;
  ri1 = 0;
  rj0 = 1;
  rj1 = 0;

  constructor(
    readonly tx: number,
    readonly tz: number,
    readonly soil: Soil,
  ) {
    this.pc = new Float32Array(N2).fill(soil.crust);
  }

  get key(): number {
    return tileKey(this.tx, this.tz);
  }

  /** World x and z of its first vertex. */
  get x0(): number {
    return this.tx * TILE;
  }
  get z0(): number {
    return this.tz * TILE;
  }
}

/**
 * How a vertex's soil looks, packed into one whole number a float holds exactly: turned + 64 x charred + 4096 x loose +
 * 262144 x cracked, each 0..63 (loose: a loose layer of 12 mm or more is 63).
 */
export function packLook(t: GroundTile, i: number): number {
  const q = (v: number) => Math.round((v * 63) / 255);
  const lo = Math.min(63, Math.round((t.lo[i] / 0.012) * 63));
  return q(t.t[i]) + 64 * q(t.c[i]) + 4096 * lo + 262144 * q(t.k[i]);
}

export function tileKey(tx: number, tz: number): number {
  return (tx + 0x8000) * 0x10000 + (tz + 0x8000);
}

/** A load pressed into the ground over one step: a tyre swept from a to b, or a sole set down (a equal to b). */
export interface Press {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Heading of the load, unit: the long axis of its footprint. */
  fx: number;
  fz: number;
  halfW: number;
  halfL: number;
  /** Pressure on the centre line, Pa. */
  p: number;
  soil: Soil;
  /** Id of this pass: one tyre's unbroken run, or one step. */
  pass: number;
  /** Share of the displaced soil pushed out to the left (+ across), 0..1; the rest goes right. */
  left?: number;
  /** Share pushed ahead (a bow wave: a tyre sinking deep, a skidding one), and behind (a boot's heel and toe). */
  ahead?: number;
  behind?: number;
  /** How much it turns the surface over, 0..1. */
  turn?: number;
}

export interface PressResult {
  /** Volume pressed down, m^3. */
  volume: number;
  /** Sinkage made in fresh ground at the front of the load, m: what it has to keep pushing through. */
  fresh: number;
}

export interface GroundSnapshot {
  tiles: { tx: number; tz: number; soil: SoilKind; h: Int16Array; pc: Uint16Array; t: Uint8Array; c: Uint8Array; k?: Uint8Array; passes: Uint8Array }[];
}

/** Height resolution of a snapshot, m. */
const SNAP_H = 0.00025;
/** Pressure resolution of a snapshot, Pa. */
const SNAP_P = 100;

/** What lies under a footprint (`GroundField.under`). */
export interface Under {
  /** Mean height over the footprint, m. */
  h: number;
  /** Highest point of it, m. */
  hi: number;
  /** Slope of the field there, dh/dx and dh/dz. */
  gx: number;
  gz: number;
}

/** Where one vertex of the field lies: its tile and its index in it. */
interface VRef {
  tile: GroundTile | undefined;
  i: number;
}

export class GroundField {
  readonly tiles = new Map<number, GroundTile>();
  /** Tiles with vertices still settling. */
  private restless = new Set<GroundTile>();
  /** Field clock, s. */
  time = 0;
  /** Volume packed away (pressed denser), m^3, for tests. */
  packed = 0;
  /** Tiles made so far: the drawing picks a new one up the frame it appears rather than at its next look round. */
  made = 0;
  private lastKey = NaN;
  private lastTile: GroundTile | undefined;
  private ref: VRef = { tile: undefined, i: 0 };

  constructor(private env: FieldEnv) {}

  // ---------------------------------------------------------------- access

  tile(tx: number, tz: number): GroundTile | undefined {
    const k = tileKey(tx, tz);
    if (k === this.lastKey) return this.lastTile;
    const t = this.tiles.get(k);
    this.lastKey = k;
    this.lastTile = t;
    return t;
  }

  private make(tx: number, tz: number, soil: Soil): GroundTile {
    const k = tileKey(tx, tz);
    let t = this.tiles.get(k);
    if (!t) {
      t = new GroundTile(tx, tz, soil);
      t.touched = this.time;
      this.tiles.set(k, t);
      this.made++;
      if (k === this.lastKey) this.lastTile = t;
    }
    return t;
  }

  /** The tile and index of a vertex, made if `soil` is given and it does not exist yet. */
  private vertex(ix: number, iz: number, soil?: Soil): VRef {
    const tx = Math.floor(ix / TILE_N);
    const tz = Math.floor(iz / TILE_N);
    let t = this.tile(tx, tz);
    if (!t && soil) t = this.make(tx, tz, soil);
    this.ref.tile = t;
    this.ref.i = (iz - tz * TILE_N) * TILE_N + (ix - tx * TILE_N);
    return this.ref;
  }

  /** Height of one vertex, m (0 where the field holds nothing). */
  hAt(ix: number, iz: number): number {
    const v = this.vertex(ix, iz);
    return v.tile ? v.tile.h[v.i] : 0;
  }

  /** How turned over one vertex's soil is, 0..1. */
  turnAt(ix: number, iz: number): number {
    const v = this.vertex(ix, iz);
    return v.tile ? v.tile.t[v.i] / TURN_MAX : 0;
  }

  /** Turned, charred and loose of one vertex packed as the renderer sends them (`packLook`). */
  lookAt(ix: number, iz: number): number {
    const v = this.vertex(ix, iz);
    return v.tile ? packLook(v.tile, v.i) : 0;
  }

  /** Height of the field at a point, m: bilinear between the four vertices round it. */
  heightAt(x: number, z: number): number {
    const fx = x / DCELL;
    const fz = z / DCELL;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = Math.floor(ix / TILE_N);
    const tz = Math.floor(iz / TILE_N);
    const li = ix - tx * TILE_N;
    const lj = iz - tz * TILE_N;
    const t = this.tile(tx, tz);
    if (li < TILE_N - 1 && lj < TILE_N - 1) {
      // All four in one tile (most points): no lookups.
      if (!t) return 0;
      const i = lj * TILE_N + li;
      const ux = fx - ix;
      const uz = fz - iz;
      const h = t.h;
      return (h[i] * (1 - ux) + h[i + 1] * ux) * (1 - uz) + (h[i + TILE_N] * (1 - ux) + h[i + TILE_N + 1] * ux) * uz;
    }
    const ux = fx - ix;
    const uz = fz - iz;
    const a = this.hAt(ix, iz);
    const b = this.hAt(ix + 1, iz);
    const c = this.hAt(ix, iz + 1);
    const d = this.hAt(ix + 1, iz + 1);
    return (a * (1 - ux) + b * ux) * (1 - uz) + (c * (1 - ux) + d * ux) * uz;
  }

  /** The hardest pressure the ground at a point has borne, Pa, or null where the field holds nothing there. */
  pcAt(x: number, z: number): number | null {
    const v = this.vertex(Math.round(x / DCELL), Math.round(z / DCELL));
    return v.tile ? v.tile.pc[v.i] : null;
  }

  /**
   * The field under a tyre or a foot: its mean height over the inner footprint (a 3 x 3 sample at six tenths of its half
   * sizes), the highest of those points (what a stiff tyre bridging a narrow rut rests on), and the slope of the field there
   * (dh/dx, dh/dz), which is what pushes a wheel down into a rut or back from the wall of a hole.
   */
  under(x: number, z: number, fx: number, fz: number, halfW: number, halfL: number, out: Under): Under {
    const lx = fz;
    const lz = -fx;
    const sl = 0.6 * halfL;
    const sw = 0.6 * halfW;
    let sum = 0;
    let hi = -Infinity;
    let front = 0;
    let back = 0;
    let left = 0;
    let right = 0;
    for (let a = -1; a <= 1; a++) {
      for (let c = -1; c <= 1; c++) {
        const h = this.heightAt(x + fx * a * sl + lx * c * sw, z + fz * a * sl + lz * c * sw);
        sum += h;
        if (h > hi) hi = h;
        if (a > 0) front += h;
        else if (a < 0) back += h;
        if (c > 0) left += h;
        else if (c < 0) right += h;
      }
    }
    out.h = sum / 9;
    out.hi = hi;
    const sa = (front - back) / (3 * 2 * Math.max(sl, DCELL));
    const sc = (left - right) / (3 * 2 * Math.max(sw, DCELL));
    out.gx = sa * fx + sc * lx;
    out.gz = sa * fz + sc * lz;
    return out;
  }

  // ---------------------------------------------------------------- bookkeeping

  /**
   * Note a change over vertices [ix0, ix1] x [iz0, iz1]: the tiles drawn with any of them (a tile is drawn with a row of
   * its neighbours' on each side) move on a version, and the ground there may need to settle.
   */
  private touch(ix0: number, iz0: number, ix1: number, iz1: number, settle = true, redraw = true) {
    const tx0 = Math.floor((ix0 - 2) / TILE_N);
    const tx1 = Math.floor((ix1 + 2) / TILE_N);
    const tz0 = Math.floor((iz0 - 2) / TILE_N);
    const tz1 = Math.floor((iz1 + 2) / TILE_N);
    for (let tz = tz0; tz <= tz1; tz++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = this.tile(tx, tz);
        if (!t) continue;
        if (redraw) t.version++;
        t.touched = this.time;
        if (!settle) continue;
        const bx = tx * TILE_N;
        const bz = tz * TILE_N;
        const i0 = Math.max(0, ix0 - 1 - bx);
        const i1 = Math.min(TILE_N - 1, ix1 + 1 - bx);
        const j0 = Math.max(0, iz0 - 1 - bz);
        const j1 = Math.min(TILE_N - 1, iz1 + 1 - bz);
        if (i0 > i1 || j0 > j1) continue;
        if (t.ri0 > t.ri1) {
          t.ri0 = i0;
          t.ri1 = i1;
          t.rj0 = j0;
          t.rj1 = j1;
        } else {
          t.ri0 = Math.min(t.ri0, i0);
          t.ri1 = Math.max(t.ri1, i1);
          t.rj0 = Math.min(t.rj0, j0);
          t.rj1 = Math.max(t.rj1, j1);
        }
        this.restless.add(t);
      }
    }
  }

  /** Make every tile over a rectangle of vertices, so an operation never has to stop for one. */
  private cover(ix0: number, iz0: number, ix1: number, iz1: number, soil: Soil) {
    for (let tz = Math.floor(iz0 / TILE_N); tz <= Math.floor(iz1 / TILE_N); tz++) {
      for (let tx = Math.floor(ix0 / TILE_N); tx <= Math.floor(ix1 / TILE_N); tx++) if (!this.tile(tx, tz)) this.make(tx, tz, soil);
    }
  }

  /** Loose soil coming down on a vertex: a loose layer over the ground there, turned over. */
  private heap(t: GroundTile, i: number, dh: number, turn: number) {
    t.h[i] += dh;
    t.lo[i] += dh;
    // A sprinkle does not turn the ground over: the look comes in with the first couple of millimetres.
    const tt = Math.round(turn * TURN_MAX * Math.min(1, dh / 0.002));
    if (t.t[i] < tt) t.t[i] = tt;
  }

  /** Take `d` off a vertex's height, from its loose layer first. */
  private lower(t: GroundTile, i: number, d: number) {
    t.h[i] -= d;
    t.lo[i] = Math.max(0, t.lo[i] - d);
  }

  // ---------------------------------------------------------------- loads

  /**
   * A tyre or a sole pressing on the ground for one step. Each vertex under it sinks by what its pressure adds to the
   * hardest it has borne; a later pass of the same weight settles it only a little more. The share of the pressed volume
   * that the soil pushes aside is heaped in berms just outside the footprint (left and right, a little ahead), the rest is
   * packed denser.
   */
  press(o: Press): PressResult {
    const s = o.soil;
    const b = 2 * o.halfW;
    const ex = o.bx - o.ax;
    const ez = o.bz - o.az;
    const seg2 = ex * ex + ez * ez;
    // Berms at least three vertices wide: soil pushed out of a tread spreads, it does not stand in a row of spikes.
    const band = Math.max(DCELL * 3, o.halfW * 1.2);
    const reach = Math.max(o.halfW, o.halfL) + band + DCELL;
    const ix0 = Math.floor((Math.min(o.ax, o.bx) - reach) / DCELL);
    const ix1 = Math.ceil((Math.max(o.ax, o.bx) + reach) / DCELL);
    const iz0 = Math.floor((Math.min(o.az, o.bz) - reach) / DCELL);
    const iz1 = Math.ceil((Math.max(o.az, o.bz) + reach) / DCELL);
    this.cover(ix0, iz0, ix1, iz1, s);
    const lx = o.fz;
    const lz = -o.fx;
    const stamp = (o.pass & 0xff) || 1;
    const turn = o.turn ?? 0.6;
    const left = o.left ?? 0.5;
    const ahead = o.ahead ?? 0.06;
    const behind = o.behind ?? 0;
    const sides = Math.max(0, 1 - ahead - behind);
    // Weights of the berm bands: left, right, ahead, behind.
    let wL = 0;
    let wR = 0;
    let wA = 0;
    let wB = 0;
    let vol = 0;
    let disp = 0;
    const floor = -s.floor;
    const fresh = this.freshAt(o, b, stamp);
    for (let iz = iz0; iz <= iz1; iz++) {
      const z = iz * DCELL;
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = ix * DCELL;
        // Nearest point of the swept segment, then the vertex in the load's own frame there.
        let tt = seg2 > 1e-10 ? ((x - o.ax) * ex + (z - o.az) * ez) / seg2 : 0;
        tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
        const dx = x - (o.ax + ex * tt);
        const dz = z - (o.az + ez * tt);
        const al = dx * o.fx + dz * o.fz;
        const ac = dx * lx + dz * lz;
        const aal = Math.abs(al);
        const aac = Math.abs(ac);
        if (aal <= o.halfL && aac <= o.halfW) {
          const v = this.vertex(ix, iz);
          const t = v.tile!;
          const i = v.i;
          // Loose soil on top (a berm, a spill) is pushed aside, not packed.
          const loose = t.lo[i];
          if (loose > 0) {
            t.h[i] -= loose;
            t.lo[i] = 0;
            vol += loose * AREA;
            disp += loose * AREA;
          }
          // Rounded shoulders: the pressure falls off toward the edges of the tread or the sole.
          const u = aac / o.halfW;
          const w = 1 - 0.45 * u * u * u * u;
          const pv = o.p * w;
          const pc = t.pc[i];
          let dz2 = 0;
          const fresh = t.stamp[i] !== stamp;
          if (pv > pc) {
            dz2 = plateSinkage(s, pv, b) - plateSinkage(s, pc, b);
            t.pc[i] = pv;
          } else if (fresh && pv > 0.6 * pc) dz2 = repassSinkage(plateSinkage(s, pv, b), t.passes[i]);
          if (fresh) {
            t.stamp[i] = stamp;
            if (t.passes[i] < 255) t.passes[i]++;
          }
          const h = t.h[i];
          if (h - dz2 < floor) dz2 = Math.max(0, h - floor);
          if (dz2 > 0) {
            t.h[i] = h - dz2;
            const dv = dz2 * AREA;
            vol += dv;
            disp += dv * s.displace;
            const tt2 = Math.round(turn * TURN_MAX * Math.min(1, dz2 / 0.004 + 0.3));
            if (t.t[i] < tt2) t.t[i] = tt2;
          }
          continue;
        }
        // Outside the footprint: which berm band, if any, and how much of it.
        if (aal <= o.halfL && aac <= o.halfW + band) {
          const k = bandWeight((aac - o.halfW) / band);
          if (ac > 0) wL += k;
          else wR += k;
        } else if (aac <= o.halfW && aal <= o.halfL + band) {
          const k = bandWeight((aal - o.halfL) / band);
          if (al > 0 && tt >= 1) wA += k;
          else if (al < 0 && tt <= 0) wB += k;
        }
      }
    }
    this.packed += vol - disp;
    if (disp > 0) {
      // Each band's share of what was pushed aside; a band with no vertex in it (a load narrower than a cell) hands its
      // share to the others.
      const sL = wL ? sides * left : 0;
      const sR = wR ? sides * (1 - left) : 0;
      const sA = wA ? ahead : 0;
      const sB = wB ? behind : 0;
      const sum = sL + sR + sA + sB;
      if (sum <= 0) this.packed += disp;
      else {
        const kL = wL ? (disp * sL) / sum / (wL * AREA) : 0;
        const kR = wR ? (disp * sR) / sum / (wR * AREA) : 0;
        const kA = wA ? (disp * sA) / sum / (wA * AREA) : 0;
        const kB = wB ? (disp * sB) / sum / (wB * AREA) : 0;
        for (let iz = iz0; iz <= iz1; iz++) {
          const z = iz * DCELL;
          for (let ix = ix0; ix <= ix1; ix++) {
            const x = ix * DCELL;
            let tt = seg2 > 1e-10 ? ((x - o.ax) * ex + (z - o.az) * ez) / seg2 : 0;
            tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
            const dx = x - (o.ax + ex * tt);
            const dz = z - (o.az + ez * tt);
            const al = dx * o.fx + dz * o.fz;
            const ac = dx * lx + dz * lz;
            const aal = Math.abs(al);
            const aac = Math.abs(ac);
            if (aal <= o.halfL && aac <= o.halfW) continue;
            let dh = 0;
            if (aal <= o.halfL && aac <= o.halfW + band) dh = bandWeight((aac - o.halfW) / band) * (ac > 0 ? kL : kR);
            else if (aac <= o.halfW && aal <= o.halfL + band) {
              const k = bandWeight((aal - o.halfL) / band);
              if (al > 0 && tt >= 1) dh = k * kA;
              else if (al < 0 && tt <= 0) dh = k * kB;
            }
            if (dh <= 0) continue;
            const v = this.vertex(ix, iz);
            this.heap(v.tile!, v.i, dh, turn * 0.8);
          }
        }
      }
    }
    this.touch(ix0, iz0, ix1, iz1);
    return { volume: vol, fresh };
  }

  /**
   * Sinkage this load makes in ground it has not pressed before, just ahead of where it is moving, m: in fresh ground all of
   * its sinkage, in a rut a lighter load pressed only what this one adds, in its own or a like load's rut only what a repeat
   * settles. A load standing still is cutting nothing.
   */
  private freshAt(o: Press, b: number, stamp: number): number {
    const ex = o.bx - o.ax;
    const ez = o.bz - o.az;
    const l = Math.hypot(ex, ez);
    if (l < DCELL * 0.25) return 0;
    const z = plateSinkage(o.soil, o.p, b);
    const reach = o.halfL + DCELL;
    const v = this.vertex(Math.round((o.bx + (ex / l) * reach) / DCELL), Math.round((o.bz + (ez / l) * reach) / DCELL));
    const t = v.tile;
    if (!t) return z;
    if (t.stamp[v.i] === stamp) return 0;
    const before = t.passes[v.i];
    return Math.max(0, z - plateSinkage(o.soil, t.pc[v.i], b)) + (before ? repassSinkage(z, before) : 0);
  }

  /**
   * Dig `volume` out of a footprint (a tyre spinning, a blade): taken most from under its middle, never below the soil's
   * floor. Returns what was actually dug, m^3, for the caller to throw.
   */
  dig(x: number, z: number, fx: number, fz: number, halfW: number, halfL: number, volume: number, soil: Soil): number {
    if (volume <= 0) return 0;
    const lx = fz;
    const lz = -fx;
    const reach = Math.max(halfW, halfL) + DCELL;
    const ix0 = Math.floor((x - reach) / DCELL);
    const ix1 = Math.ceil((x + reach) / DCELL);
    const iz0 = Math.floor((z - reach) / DCELL);
    const iz1 = Math.ceil((z + reach) / DCELL);
    this.cover(ix0, iz0, ix1, iz1, soil);
    let wsum = 0;
    for (let pass = 0; pass < 2; pass++) {
      const k = pass ? volume / (wsum * AREA) : 0;
      let got = 0;
      for (let iz = iz0; iz <= iz1; iz++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const dx = ix * DCELL - x;
          const dz = iz * DCELL - z;
          const al = Math.abs(dx * fx + dz * fz) / Math.max(halfL, DCELL * 0.5);
          const ac = Math.abs(dx * lx + dz * lz) / Math.max(halfW, DCELL * 0.5);
          if (al > 1 || ac > 1) continue;
          const w = (1 - ac * ac) * (1 - 0.5 * al * al);
          if (!pass) {
            wsum += w;
            continue;
          }
          const v = this.vertex(ix, iz);
          const t = v.tile!;
          const room = Math.max(0, t.h[v.i] + soil.floor);
          const d = Math.min(room, w * k);
          this.lower(t, v.i, d);
          t.t[v.i] = TURN_MAX;
          got += d * AREA;
        }
      }
      if (pass) {
        this.touch(ix0, iz0, ix1, iz1);
        return got;
      }
      if (wsum <= 0) return 0;
    }
    return 0;
  }

  /**
   * Push `volume` of soil out of a footprint toward (dx, dz) (unit): a tyre sliding sideways bulldozes a heap ahead of its
   * leading edge, a locked one skidding forward pushes one in front of it.
   */
  shove(x: number, z: number, fx: number, fz: number, halfW: number, halfL: number, dx: number, dz: number, volume: number, soil: Soil): number {
    const got = this.dig(x, z, fx, fz, halfW, halfL, volume, soil);
    if (got <= 0) return 0;
    // Where the footprint ends in that direction, and the band just beyond it.
    const lx = fz;
    const lz = -fx;
    const reach = Math.abs(dx * fx + dz * fz) * halfL + Math.abs(dx * lx + dz * lz) * halfW;
    const r = Math.max(DCELL * 1.5, Math.min(halfW, halfL) * 0.7);
    // Spread along the edge: lay it as a short row of heaps.
    const ex = Math.abs(dx * fx + dz * fz) > 0.7 ? lx : fx;
    const ez = Math.abs(dx * fx + dz * fz) > 0.7 ? lz : fz;
    const span = Math.abs(dx * fx + dz * fz) > 0.7 ? halfW : halfL;
    const n = Math.max(1, Math.round((2 * span) / r));
    for (let k = 0; k < n; k++) {
      const s = n === 1 ? 0 : (k / (n - 1) - 0.5) * 2 * span * 0.8;
      this.deposit(x + dx * (reach + r) + ex * s, z + dz * (reach + r) + ez * s, got / n, r, soil, 0.9);
    }
    return got;
  }

  /** Soil coming down at a point: a heap of `volume` (m^3) spread over about `r` metres. */
  deposit(x: number, z: number, volume: number, r: number, soil?: Soil, turn = 0.7) {
    if (volume <= 0) return;
    const s = soil ?? this.env.soilAt(x, z);
    if (!s) return;
    if (r < DCELL * 0.75) {
      const v = this.vertex(Math.round(x / DCELL), Math.round(z / DCELL), s);
      this.heap(v.tile!, v.i, volume / AREA, turn);
      const ix = Math.round(x / DCELL);
      const iz = Math.round(z / DCELL);
      this.touch(ix, iz, ix, iz);
      return;
    }
    const reach = 2 * r;
    const ix0 = Math.floor((x - reach) / DCELL);
    const ix1 = Math.ceil((x + reach) / DCELL);
    const iz0 = Math.floor((z - reach) / DCELL);
    const iz1 = Math.ceil((z + reach) / DCELL);
    this.cover(ix0, iz0, ix1, iz1, s);
    const inv = 1 / (r * r);
    let wsum = 0;
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const d2 = ((ix * DCELL - x) ** 2 + (iz * DCELL - z) ** 2) * inv;
        if (d2 < 4) wsum += Math.exp(-d2) - 0.0183;
      }
    }
    if (wsum <= 0) return;
    const k = volume / (wsum * AREA);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const d2 = ((ix * DCELL - x) ** 2 + (iz * DCELL - z) ** 2) * inv;
        if (d2 >= 4) continue;
        const dh = (Math.exp(-d2) - 0.0183) * k;
        const v = this.vertex(ix, iz);
        this.heap(v.tile!, v.i, dh, turn);
      }
    }
    this.touch(ix0, iz0, ix1, iz1);
  }

  /**
   * A crater dug at (x, z) by something travelling along (dx, dz) (unit, horizontal; any direction for a blast straight
   * down): the bowl is taken out, part of it heaped on the rim (more downrange for a glancing hit) and the rest left to the
   * caller to throw (returned, m^3) or packed into the floor.
   */
  crater(x: number, z: number, dx: number, dz: number, c: Crater, soil: Soil): number {
    if (c.volume <= 0) return 0;
    const l = Math.hypot(dx, dz);
    const ax = l > 1e-6 ? dx / l : 1;
    const az = l > 1e-6 ? dz / l : 0;
    const bx = -az;
    const bz = ax;
    const cx = x + ax * c.shift;
    const cz = z + az * c.shift;
    const A = Math.max(c.along, DCELL * 0.5);
    const B = Math.max(c.across, DCELL * 0.5);
    const RIM = 2.5;
    const tail = 1 / (RIM * RIM * RIM);
    const reach = Math.max(A, B) * RIM + DCELL;
    const ix0 = Math.floor((cx - reach) / DCELL);
    const ix1 = Math.ceil((cx + reach) / DCELL);
    const iz0 = Math.floor((cz - reach) / DCELL);
    const iz1 = Math.ceil((cz + reach) / DCELL);
    this.cover(ix0, iz0, ix1, iz1, soil);
    let wb = 0;
    let wr = 0;
    // Each crater breaks its own way.
    const seed = (Math.floor(x * 731) ^ Math.floor(z * 977)) & 0xffff;
    for (let pass = 0; pass < 2; pass++) {
      const kb = pass ? c.volume / (wb * AREA) : 0;
      const kr = pass && wr > 0 ? (c.volume * c.rim) / (wr * AREA) : 0;
      for (let iz = iz0; iz <= iz1; iz++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const ox = ix * DCELL - cx;
          const oz = iz * DCELL - cz;
          const ea = (ox * ax + oz * az) / A;
          const eb = (ox * bx + oz * bz) / B;
          const r = Math.sqrt(ea * ea + eb * eb);
          if (r >= RIM) continue;
          let bowl = 0;
          let rim = 0;
          // A glancing round digs in as it goes: the bowl deepens downrange. Cohesive ground breaks in lumps: ragged walls,
          // a lip of clods.
          const n = c.lumpy > 0 ? hashUnit(ix, iz, seed) - 0.5 : 0;
          if (r < 1) bowl = (1 - r * r) * Math.max(0, 1 + c.asym * ea) * Math.max(0, 1 + c.lumpy * 0.9 * n);
          else rim = (1 / (r * r * r) - tail) * (1 + c.skew * (ea / r)) * Math.max(0, 1 + c.lumpy * 1.6 * n);
          if (!pass) {
            wb += bowl;
            wr += rim;
            continue;
          }
          const dh = rim * kr - bowl * kb;
          if (dh === 0) continue;
          const v = this.vertex(ix, iz);
          const t = v.tile!;
          if (dh > 0) this.heap(t, v.i, dh, 1);
          else this.lower(t, v.i, Math.min(-dh, t.h[v.i] + DEEPEST));
          // Broken up to past the bowl's edge, fading out over the rim (a hard edge reads as the grid's steps).
          if (r < 1.7) t.t[v.i] = Math.max(t.t[v.i], Math.round(TURN_MAX * Math.min(1, (1.7 - r) / 0.6)));
          // Packed ground broken open is a shade damp and dark deep inside the hole, not round it (drawn through the same
          // darkening a blast's soot uses).
          if (r < 0.8 && soil.damp > 0) {
            const dark = Math.round(TURN_MAX * soil.damp * (1 - (r * r) / 0.64));
            if (t.c[v.i] < dark) t.c[v.i] = dark;
          }
          t.fine = true;
        }
      }
      if (!pass && wb <= 0) {
        // Smaller than a cell: the nearest vertex takes the bowl, the rim goes round it.
        const v = this.vertex(Math.round(cx / DCELL), Math.round(cz / DCELL), soil);
        this.lower(v.tile!, v.i, c.volume / AREA);
        v.tile!.t[v.i] = TURN_MAX;
        this.touch(ix0, iz0, ix1, iz1);
        this.deposit(cx, cz, c.volume * c.rim, Math.max(A, B) * 1.6, soil, 1);
        this.packed += c.volume * (1 - c.rim - c.eject);
        return c.volume * c.eject;
      }
    }
    if (wr <= 0) this.deposit(cx, cz, c.volume * c.rim, Math.max(A, B) * 1.6, soil, 1);
    this.packed += c.volume * (1 - c.rim - c.eject);
    this.touch(ix0, iz0, ix1, iz1);
    return c.volume * c.eject;
  }

  /**
   * A dry crust broken round a blow at (x, z): cracked through near the hole, a few long cracks farther out, to `r` metres
   * along (ax, az) and `r * B / A` across. Only marks the ground: the drawing breaks it into plates where it looks crusted.
   */
  crack(x: number, z: number, ax: number, az: number, r: number, across: number, soil: Soil) {
    if (r <= 0) return;
    const bx = -az;
    const bz = ax;
    const reach = Math.max(r, across) + DCELL;
    const ix0 = Math.floor((x - reach) / DCELL);
    const ix1 = Math.ceil((x + reach) / DCELL);
    const iz0 = Math.floor((z - reach) / DCELL);
    const iz1 = Math.ceil((z + reach) / DCELL);
    this.cover(ix0, iz0, ix1, iz1, soil);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const ox = ix * DCELL - x;
        const oz = iz * DCELL - z;
        const ea = (ox * ax + oz * az) / r;
        const eb = (ox * bx + oz * bz) / Math.max(DCELL, across);
        const d = Math.sqrt(ea * ea + eb * eb);
        if (d >= 1) continue;
        const v = this.vertex(ix, iz);
        const k = Math.round(TURN_MAX * Math.pow(1 - d, 0.6));
        if (v.tile!.k[v.i] < k) v.tile!.k[v.i] = k;
      }
    }
    this.touch(ix0, iz0, ix1, iz1);
  }

  /** Char the ground round a blast: black at its heart, fading out to `r` metres. Only where the field already holds or can hold soil. */
  char(x: number, z: number, r: number, amount: number, soil: Soil) {
    if (r <= 0 || amount <= 0) return;
    const ix0 = Math.floor((x - r) / DCELL);
    const ix1 = Math.ceil((x + r) / DCELL);
    const iz0 = Math.floor((z - r) / DCELL);
    const iz1 = Math.ceil((z + r) / DCELL);
    this.cover(ix0, iz0, ix1, iz1, soil);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const d = Math.hypot(ix * DCELL - x, iz * DCELL - z) / r;
        if (d >= 1) continue;
        // Ragged at the edge: soot thrown in streaks.
        const n = Math.sin(ix * 12.9898 + iz * 78.233) * 43758.5453;
        const k = amount * (1 - d * d) * (0.75 + 0.25 * (n - Math.floor(n)));
        const v = this.vertex(ix, iz);
        const c = Math.round(clamp(k, 0, 1) * TURN_MAX);
        if (v.tile!.c[v.i] < c) v.tile!.c[v.i] = c;
      }
    }
    this.touch(ix0, iz0, ix1, iz1, false);
  }

  // ---------------------------------------------------------------- settling

  /**
   * Let walls steeper than their soil's angle of repose slump, for up to `budget` vertex visits. Each pass moves soil
   * between neighbouring vertices whose difference is over the soil's limit, by just enough that a lone peak ends at it.
   * Returns the vertices visited.
   */
  relax(budget = 6000): number {
    let used = 0;
    for (const t of this.restless) {
      if (used >= budget) break;
      this.restless.delete(t);
      if (t.ri0 > t.ri1 || this.tiles.get(t.key) !== t) continue;
      used += this.relaxTile(t);
    }
    return used;
  }

  /** Vertices still settling. */
  get settling(): number {
    return this.restless.size;
  }

  private sh = new Float32Array(0);
  private sd = new Float32Array(0);

  private relaxTile(t: GroundTile): number {
    const bx = t.tx * TILE_N;
    const bz = t.tz * TILE_N;
    // The settling rectangle and the vertices one beyond it (whose flows into it count too), in world vertex coordinates.
    const X0 = bx + t.ri0 - 1;
    const X1 = bx + t.ri1 + 1;
    const Z0 = bz + t.rj0 - 1;
    const Z1 = bz + t.rj1 + 1;
    t.ri0 = 1;
    t.ri1 = 0;
    const W = X1 - X0 + 1;
    const D = Z1 - Z0 + 1;
    if (this.sh.length < W * D) {
      this.sh = new Float32Array(W * D * 2);
      this.sd = new Float32Array(W * D * 2);
    }
    const H = this.sh;
    const dl = this.sd;
    for (let j = 0; j < D; j++) {
      for (let i = 0; i < W; i++) {
        H[j * W + i] = this.hAt(X0 + i, Z0 + j);
        dl[j * W + i] = 0;
      }
    }
    const T = talus(t.soil, DCELL);
    let moved = 0;
    let mi0 = W;
    let mi1 = -1;
    let mj0 = D;
    let mj1 = -1;
    const edge = (a: number, b: number) => {
      const d = H[a] - H[b];
      const ex = Math.abs(d) - T;
      if (ex <= 0) return 0;
      const f = 0.2 * ex * Math.sign(d);
      dl[a] -= f;
      dl[b] += f;
      return Math.abs(f);
    };
    for (let j = 0; j < D; j++) {
      for (let i = 0; i < W; i++) {
        const a = j * W + i;
        let f = 0;
        if (i + 1 < W) f += edge(a, a + 1);
        if (j + 1 < D) f += edge(a, a + W);
        if (f > 2e-5) {
          moved = Math.max(moved, f);
          if (i < mi0) mi0 = i;
          if (i + 1 > mi1) mi1 = i + 1;
          if (j < mj0) mj0 = j;
          if (j + 1 > mj1) mj1 = j + 1;
        }
      }
    }
    if (moved <= 0) return W * D;
    for (let j = 0; j < D; j++) {
      for (let i = 0; i < W; i++) {
        const d = dl[j * W + i];
        if (d === 0) continue;
        const v = this.vertex(X0 + i, Z0 + j, t.soil);
        // What slumps is loose wherever it ends up.
        if (d > 0) this.heap(v.tile!, v.i, d, 0.47);
        else this.lower(v.tile!, v.i, -d);
      }
    }
    // Keep settling where soil moved this pass (and one vertex round it); the last fractions of a millimetre are not worth
    // drawing again.
    this.touch(X0 + mi0, Z0 + mj0, X0 + mi1, Z0 + mj1, true, moved > 6e-5);
    return W * D;
  }

  // ---------------------------------------------------------------- housekeeping

  /** Drop tiles that hold nothing worth drawing any more, and the farthest from `focus` beyond `keep` metres past `max`. */
  trim(focus: { x: number; z: number }[], max: number, keep = 160) {
    if (this.tiles.size <= max) return;
    const list: { t: GroundTile; d: number }[] = [];
    for (const t of this.tiles.values()) {
      const cx = t.x0 + TILE / 2;
      const cz = t.z0 + TILE / 2;
      let d = Infinity;
      for (const f of focus) d = Math.min(d, Math.hypot(f.x - cx, f.z - cz));
      list.push({ t, d });
    }
    list.sort((a, b) => b.d - a.d);
    let n = this.tiles.size - max;
    for (const e of list) {
      if (n <= 0 || e.d < keep) break;
      this.remove(e.t);
      n--;
    }
  }

  remove(t: GroundTile) {
    this.tiles.delete(t.key);
    this.restless.delete(t);
    if (this.lastTile === t) {
      this.lastKey = NaN;
      this.lastTile = undefined;
    }
  }

  clear() {
    this.tiles.clear();
    this.restless.clear();
    this.lastKey = NaN;
    this.lastTile = undefined;
  }

  /** Total height of the field times the cell area, m^3 (what conservation is checked against). */
  volume(): number {
    let v = 0;
    for (const t of this.tiles.values()) for (let i = 0; i < N2; i++) v += t.h[i];
    return v * AREA;
  }

  /** A compact copy, kept from one day to the next. */
  snapshot(): GroundSnapshot {
    const tiles: GroundSnapshot['tiles'] = [];
    for (const t of this.tiles.values()) {
      const h = new Int16Array(N2);
      const pc = new Uint16Array(N2);
      let any = false;
      for (let i = 0; i < N2; i++) {
        const q = Math.round(t.h[i] / SNAP_H);
        h[i] = clamp(q, -32767, 32767);
        if (h[i] !== 0 || t.c[i] > 8 || t.k[i] > 8) any = true;
        pc[i] = clamp(Math.round(t.pc[i] / SNAP_P), 0, 65535);
      }
      if (!any) continue;
      tiles.push({ tx: t.tx, tz: t.tz, soil: t.soil.kind, h, pc, t: t.t.slice(), c: t.c.slice(), k: t.k.slice(), passes: t.passes.slice() });
    }
    return { tiles };
  }

  /**
   * Lay a snapshot back down, `nights` later: the wind fills tracks and craters in a little each night and the turned soil
   * weathers back to the colour of the ground round it.
   */
  restore(s: GroundSnapshot, nights = 0) {
    this.clear();
    const fill = Math.pow(0.75, nights);
    const fade = Math.pow(0.5, nights);
    for (const e of s.tiles) {
      const t = this.make(e.tx, e.tz, SOILS[e.soil]);
      for (let i = 0; i < N2; i++) {
        t.h[i] = e.h[i] * SNAP_H * fill;
        t.pc[i] = Math.max(t.soil.crust, e.pc[i] * SNAP_P);
        t.t[i] = Math.round(e.t[i] * fade);
        t.c[i] = Math.round(e.c[i] * Math.sqrt(fade));
        // A broken crust stays broken; the wind only dusts its cracks over.
        t.k[i] = e.k ? Math.round(e.k[i] * Math.sqrt(fade)) : 0;
        t.passes[i] = e.passes[i];
      }
      t.version++;
    }
  }
}

/** A repeatable random in [0, 1) for a vertex. */
function hashUnit(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Profile of a berm across its band, u 0 (at the footprint's edge) to 1 (the band's outer edge): heaped near the edge. */
function bandWeight(u: number): number {
  if (u <= 0 || u >= 1) return 0;
  // Rises fast from the edge, peaks a quarter of the way out, tails off.
  return u < 0.25 ? u / 0.25 : (1 - u) / 0.75;
}
