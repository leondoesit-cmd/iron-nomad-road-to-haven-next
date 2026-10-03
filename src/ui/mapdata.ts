import { clamp, smoothstep } from '../core/math';
import { corridorHalf, heightAt, roadX, waterAt, type TerrainDef } from '../world/terrain';
import { lakeColors } from '../world/lakes';
import type { LegLayout } from '../world/layout';
import { CELL as DELVE_CELL, cellX, cellZ, type DelveMap } from '../world/delve';
import type { CompassPin } from '../game/scene';

/**
 * Map data with no DOM in it: a projection from world metres to screen pixels, and the baked ground image the minimap
 * and the full map both draw. Coordinates are the game's own: +Z is north (down the road) and +X is to the left of
 * someone facing north, so a map with north up has +X on its left.
 */

export interface MapRect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** Ground image in world space: pixel (i, j) covers x0 + i * cell ... and z0 + j * cell ... Transparent where nothing is known. */
export interface MapBase {
  x0: number;
  z0: number;
  cell: number;
  w: number;
  h: number;
  /** RGBA, row-major. */
  data: Uint8ClampedArray;
  /** Bumped whenever the pixels change so a drawn copy knows to refresh. */
  version: number;
  /** False while a leg's ground is still being baked a slice at a time. */
  done: boolean;
}

export interface MapBlip {
  x: number;
  z: number;
  kind: 'foe' | 'crew' | 'wild';
}

export interface MapMover {
  /** Which seat this is, so each HUD can tell itself from its partner. */
  seat: number;
  x: number;
  z: number;
  /** Direction it faces: 0 is north (+Z), positive turns toward +X. */
  yaw: number;
  color: string;
}

/** Map-only pin kinds on top of the compass ones: the places a leg is made of. */
export type MapPinKind = CompassPin['kind'] | 'site' | 'lake';
export interface MapPin {
  x: number;
  z: number;
  kind: MapPinKind;
  label?: string;
}

export interface MapRoad {
  pts: number[];
  half: number;
  kind: 'highway' | 'road' | 'track';
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** Everything a scene tells the HUD so it can draw this scene's map. Built once and refreshed in place. */
export interface MapFrame {
  mode: 'leg' | 'delve' | 'camp';
  title: string;
  base: MapBase | null;
  /** Road centre-line as a flat [x, z, x, z, ...] list, for legs. */
  road: number[] | null;
  roadHalf: number;
  /** The open world's whole road network, each with its bounds so the minimap can skip what is off screen. */
  roads: MapRoad[];
  /** Mined ground and other hatched areas, each a flat [x, z, x, z, ...] outline. */
  hazards: number[][];
  /** The whole thing, for the overview. */
  bounds: MapRect;
  /** Minimap radius in metres when standing still, and when moving fast. */
  radiusMin: number;
  radiusMax: number;
  pins: MapPin[];
  blips: MapBlip[];
  movers: MapMover[];
  /** Whether the map button has a whole-leg view to step to. */
  overview: boolean;
}

export function newFrame(mode: MapFrame['mode']): MapFrame {
  return {
    mode,
    title: '',
    base: null,
    road: null,
    roadHalf: 4,
    roads: [],
    hazards: [],
    bounds: { x0: -100, x1: 100, z0: -100, z1: 100 },
    radiusMin: 60,
    radiusMax: 120,
    pins: [],
    blips: [],
    movers: [],
    overview: false,
  };
}

// ------------------------------------------------------------------------------------------------- projection

/**
 * World to screen. `heading` is the direction that points up the screen (0 = north up, which is also how the compass
 * reads a camera yaw), and `scale` is pixels per metre.
 */
export class MapProjection {
  cx = 0;
  cz = 0;
  scale = 1;
  px = 0;
  py = 0;
  private fx = 0;
  private fz = 1;
  private lx = 1;
  private lz = 0;

  set(cx: number, cz: number, heading: number, scale: number, px: number, py: number) {
    this.cx = cx;
    this.cz = cz;
    this.scale = scale;
    this.px = px;
    this.py = py;
    this.fx = Math.sin(heading);
    this.fz = Math.cos(heading);
    this.lx = Math.cos(heading);
    this.lz = -Math.sin(heading);
    return this;
  }

  /** Screen x of a world point. Left of the heading is screen-left. */
  x(x: number, z: number) {
    return this.px - this.scale * (this.lx * (x - this.cx) + this.lz * (z - this.cz));
  }
  y(x: number, z: number) {
    return this.py - this.scale * (this.fx * (x - this.cx) + this.fz * (z - this.cz));
  }

  /** Canvas transform for a surface whose axes are world x and z, with its origin at world (ox, oz) and `unit` metres per step. */
  matrix(ox = 0, oz = 0, unit = 1): [number, number, number, number, number, number] {
    const s = this.scale;
    const a = -s * this.lx * unit;
    const b = -s * this.fx * unit;
    const c = -s * this.lz * unit;
    const d = -s * this.fz * unit;
    return [a, b, c, d, this.x(ox, oz), this.y(ox, oz)];
  }

  /** How far a world point is from the centre, in metres. */
  dist(x: number, z: number) {
    return Math.hypot(x - this.cx, z - this.cz);
  }
}

/** The scale that fits a world rectangle (turned to `heading`) inside w x h pixels, and where its middle is. */
export function fitRect(r: MapRect, heading: number, w: number, h: number, pad = 0) {
  const fx = Math.sin(heading);
  const fz = Math.cos(heading);
  const lx = Math.cos(heading);
  const lz = -Math.sin(heading);
  let minA = Infinity;
  let maxA = -Infinity;
  let minB = Infinity;
  let maxB = -Infinity;
  for (const [x, z] of [[r.x0, r.z0], [r.x1, r.z0], [r.x0, r.z1], [r.x1, r.z1]]) {
    const a = x * fx + z * fz;
    const b = x * lx + z * lz;
    minA = Math.min(minA, a);
    maxA = Math.max(maxA, a);
    minB = Math.min(minB, b);
    maxB = Math.max(maxB, b);
  }
  const scale = Math.min((w - pad * 2) / Math.max(1, maxB - minB), (h - pad * 2) / Math.max(1, maxA - minA));
  return { scale, cx: (r.x0 + r.x1) / 2, cz: (r.z0 + r.z1) / 2 };
}

/** North up, or turned so north points right: whichever lets the leg be drawn larger in this panel. */
export function headingFor(r: MapRect, w: number, h: number) {
  return fitRect(r, Math.PI / 2, w, h).scale > fitRect(r, 0, w, h).scale * 1.05 ? Math.PI / 2 : 0;
}

// ------------------------------------------------------------------------------------------------- terrain colours

type Rgb = [number, number, number];
const PALETTE: Record<NonNullable<TerrainDef['theme']>, { lo: Rgb; hi: Rgb }> = {
  dust: { lo: [128, 104, 70], hi: [206, 178, 128] },
  salt: { lo: [168, 166, 156], hi: [236, 234, 224] },
  cinder: { lo: [66, 58, 56], hi: [140, 110, 96] },
};
const CITY_GROUND: Rgb = [36, 33, 30];
const CITY_BLOCK: Rgb = [92, 84, 74];
const CITY_ZONE: Rgb = [128, 104, 58];
const ROOF: Rgb = [62, 50, 40];

const hex = (n: number): Rgb => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function put(base: MapBase, i: number, j: number, c: Rgb, a = 255) {
  if (i < 0 || j < 0 || i >= base.w || j >= base.h) return;
  const o = (j * base.w + i) * 4;
  base.data[o] = c[0];
  base.data[o + 1] = c[1];
  base.data[o + 2] = c[2];
  base.data[o + 3] = a;
}

function fillRect(base: MapBase, r: MapRect, c: Rgb) {
  const i0 = Math.max(0, Math.floor((r.x0 - base.x0) / base.cell));
  const i1 = Math.min(base.w - 1, Math.floor((r.x1 - base.x0) / base.cell));
  const j0 = Math.max(0, Math.floor((r.z0 - base.z0) / base.cell));
  const j1 = Math.min(base.h - 1, Math.floor((r.z1 - base.z0) / base.cell));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) put(base, i, j, c);
}

// ------------------------------------------------------------------------------------------------- legs

/** Metres per pixel of the baked ground. Fine enough that a road bend and a lake read, coarse enough to bake in a blink. */
const WASTE_CELL = 8;
const CITY_CELL = 3;
/** The open world is a whole map: coarser ground, so it bakes in seconds. */
const OPEN_CELL = 12;
/** How far past the corridor edge the ground is still drawn. */
const EDGE = 24;

/** The outline of mined ground: the road's own bends followed on both sides, so the hatching sits where the mines do. */
export function minefieldOutline(def: TerrainDef, z0: number, z1: number, halfWidth: number, step = 20): number[] {
  const out: number[] = [];
  const zs: number[] = [];
  for (let z = z0; z < z1; z += step) zs.push(z);
  zs.push(z1);
  for (const z of zs) out.push(roadX(def, z) + halfWidth, z);
  for (let i = zs.length - 1; i >= 0; i--) out.push(roadX(def, zs[i]) - halfWidth, zs[i]);
  return out;
}

/** The open world's roads as map lines (the highway is one of them), each with its bounding box. */
export function openRoadLines(def: TerrainDef): MapRoad[] {
  return def.open!.roads.map((r) => {
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < r.pts.length; i += 2) {
      x0 = Math.min(x0, r.pts[i]);
      x1 = Math.max(x1, r.pts[i]);
      z0 = Math.min(z0, r.pts[i + 1]);
      z1 = Math.max(z1, r.pts[i + 1]);
    }
    return { pts: r.pts, half: r.half, kind: r.kind, x0, x1, z0, z1 };
  });
}

/** Walks the road at a steady step so a map has a centre-line to draw. */
export function roadLine(def: TerrainDef, step = 24): number[] {
  const out: number[] = [];
  for (let z = -40; z < def.length + 80; z += step) out.push(roadX(def, z), z);
  out.push(roadX(def, def.length + 80), def.length + 80);
  return out;
}

/**
 * Bakes a leg's ground into an image a slice at a time, so the first frame of a leg does not stall on it. Wasteland is
 * shaded relief with water and buildings; a city is its blocks, lots and streets.
 */
export class LegMapBaker {
  readonly base: MapBase;
  readonly bounds: MapRect;
  private heights: Float32Array | null = null;
  private water: Uint8Array | null = null;
  private row = 0;
  private stage: 'sample' | 'shade' | 'done' = 'sample';
  private hMin = Infinity;
  private hMax = -Infinity;
  private shadeRow = 0;

  constructor(
    private def: TerrainDef,
    private layout: Pick<LegLayout, 'lots' | 'rural' | 'slots'>,
  ) {
    const city = def.biome === 'city';
    const open = def.open;
    const cell = city ? CITY_CELL : open ? OPEN_CELL : WASTE_CELL;
    let x0 = Infinity;
    let x1 = -Infinity;
    const z0 = open ? open.z0 : city ? -60 : -80;
    const z1 = open ? open.z1 : def.length + (city ? 120 : 140);
    if (open) {
      x0 = open.x0;
      x1 = open.x1;
    } else if (city) {
      x0 = -152;
      x1 = 152;
    } else {
      for (let z = z0; z <= z1; z += 20) {
        const half = corridorHalf(def, z) + EDGE;
        x0 = Math.min(x0, roadX(def, z) - half);
        x1 = Math.max(x1, roadX(def, z) + half);
      }
    }
    this.bounds = { x0, x1, z0, z1 };
    const w = Math.ceil((x1 - x0) / cell);
    const h = Math.ceil((z1 - z0) / cell);
    this.base = { x0, z0, cell, w, h, data: new Uint8ClampedArray(w * h * 4), version: 0, done: false };
    if (city) this.bakeCity();
    else {
      this.heights = new Float32Array(w * h).fill(NaN);
      this.water = new Uint8Array(w * h);
    }
  }

  get progress() {
    if (this.base.done) return 1;
    return this.stage === 'sample' ? (this.row / this.base.h) * 0.7 : 0.7 + (this.shadeRow / this.base.h) * 0.3;
  }

  /** Does up to `ms` of baking. Returns true once the ground is finished. */
  step(ms: number): boolean {
    if (this.base.done) return true;
    const end = performance.now() + ms;
    const b = this.base;
    const def = this.def;
    while (performance.now() < end && this.stage !== 'done') {
      if (this.stage === 'sample') {
        const j = this.row++;
        const z = b.z0 + (j + 0.5) * b.cell;
        const rx = roadX(def, z);
        const half = corridorHalf(def, z) + EDGE;
        const i0 = def.open ? 0 : Math.max(0, Math.floor((rx - half - b.x0) / b.cell));
        const i1 = def.open ? b.w - 1 : Math.min(b.w - 1, Math.ceil((rx + half - b.x0) / b.cell));
        for (let i = i0; i <= i1; i++) {
          const x = b.x0 + (i + 0.5) * b.cell;
          const h = heightAt(def, x, z);
          this.heights![j * b.w + i] = h;
          if (waterAt(def, x, z)) this.water![j * b.w + i] = 1;
          if (h < this.hMin) this.hMin = h;
          if (h > this.hMax) this.hMax = h;
        }
        if (this.row >= b.h) this.stage = 'shade';
      } else {
        this.shadeRow = Math.min(b.h, this.shadeRow + 8);
        this.shadeRows(this.shadeRow - 8, this.shadeRow);
        if (this.shadeRow >= b.h) {
          this.finishWaste();
          this.stage = 'done';
        }
      }
    }
    b.version++;
    return b.done;
  }

  /** Bakes everything at once: for tests and for scenes that cannot wait. */
  finish() {
    while (!this.step(50));
    return this.base;
  }

  // Wasteland: relief shading with a low sun in the north-west, tinted by height.
  private shadeRows(j0: number, j1: number) {
    const b = this.base;
    const hs = this.heights!;
    const pal = PALETTE[this.def.theme ?? 'dust'];
    const span = Math.max(1, this.hMax - this.hMin);
    const [sx, sy, sz] = [0.45, 0.75, -0.48];
    const sl = Math.hypot(sx, sy, sz);
    for (let j = j0; j < j1; j++) {
      for (let i = 0; i < b.w; i++) {
        const h = hs[j * b.w + i];
        if (Number.isNaN(h)) continue;
        const at = (ii: number, jj: number) => {
          const v = hs[clamp(jj, 0, b.h - 1) * b.w + clamp(ii, 0, b.w - 1)];
          return Number.isNaN(v) ? h : v;
        };
        const dx = (at(i + 1, j) - at(i - 1, j)) / (2 * b.cell);
        const dz = (at(i, j + 1) - at(i, j - 1)) / (2 * b.cell);
        const nl = Math.hypot(dx, 1, dz);
        const lit = clamp(((-dx * sx + sy - dz * sz) / (nl * sl)) * 1.1, 0, 1.2);
        const tone = mix(pal.lo, pal.hi, smoothstep(0, 1, (h - this.hMin) / span));
        const k = 0.5 + 0.62 * lit;
        put(b, i, j, [tone[0] * k, tone[1] * k, tone[2] * k]);
      }
    }
  }

  private finishWaste() {
    const b = this.base;
    const ws = this.water!;
    const hs = this.heights!;
    // Water, shaded by how much sits over the bed.
    const lakes = this.def.lakes;
    for (let j = 0; j < b.h; j++) {
      for (let i = 0; i < b.w; i++) {
        if (!ws[j * b.w + i]) continue;
        const x = b.x0 + (i + 0.5) * b.cell;
        const z = b.z0 + (j + 0.5) * b.cell;
        const hit = waterAt(this.def, x, z);
        const lake = hit?.lake ?? lakes[0];
        const col = lakeColors(lake.style);
        const depth = hit ? clamp(hit.depth / 4, 0, 1) : 0.5;
        put(b, i, j, mix(hex(col.shallow), hex(col.deep), depth));
      }
    }
    for (const r of this.layout.rural) fillRect(b, { x0: r.aabb.minX, x1: r.aabb.maxX, z0: r.aabb.minZ, z1: r.aabb.maxZ }, ROOF);
    // A city district of the open world: its ground, blocks and zones, drawn as a city leg's map is.
    if (this.def.open) {
      for (const d of this.def.open.districts) fillRect(b, { x0: d.x0, x1: d.x1, z0: d.z0, z1: d.z1 }, CITY_GROUND);
      for (const lot of this.layout.lots) if (lot.kind !== 'open') fillRect(b, lot, lot.kind === 'zone' ? CITY_ZONE : CITY_BLOCK);
    }
    this.heights = null;
    this.water = null;
    void hs;
    b.done = true;
    b.version++;
  }

  // City: dark ground, lighter blocks, with the lots that hold something worth the trip picked out.
  private bakeCity() {
    const b = this.base;
    for (let k = 0; k < b.w * b.h; k++) {
      const o = k * 4;
      b.data[o] = CITY_GROUND[0];
      b.data[o + 1] = CITY_GROUND[1];
      b.data[o + 2] = CITY_GROUND[2];
      b.data[o + 3] = 255;
    }
    for (const lot of this.layout.lots) {
      if (lot.kind === 'open') continue;
      fillRect(b, lot, lot.kind === 'zone' ? CITY_ZONE : CITY_BLOCK);
    }
    this.stage = 'done';
    b.done = true;
    b.version++;
  }
}

// ------------------------------------------------------------------------------------------------- delves

/** A delve's map: nothing is drawn until someone has been near it. */
export function newDelveBase(m: DelveMap): MapBase {
  const x0 = cellX(m, 0);
  const z0 = cellZ(m, 0);
  return { x0, z0, cell: DELVE_CELL, w: m.w, h: m.h, data: new Uint8ClampedArray(m.w * m.h * 4), version: 0, done: true };
}

export const delveBounds = (m: DelveMap): MapRect => ({ x0: cellX(m, 0), x1: cellX(m, m.w), z0: cellZ(m, 0), z1: cellZ(m, m.h) });

const FLOOR: Rgb = [140, 124, 98];
const WALL: Rgb = [44, 38, 32];

/** Uncovers the floor within `r` metres of a point, and the rock face beside it. Returns whether anything changed. */
export function revealDelve(base: MapBase, m: DelveMap, x: number, z: number, r: number): boolean {
  const ci = Math.floor((x - base.x0) / base.cell);
  const cj = Math.floor((z - base.z0) / base.cell);
  const n = Math.ceil(r / base.cell);
  let changed = false;
  for (let j = Math.max(0, cj - n); j <= Math.min(base.h - 1, cj + n); j++) {
    for (let i = Math.max(0, ci - n); i <= Math.min(base.w - 1, ci + n); i++) {
      if (Math.hypot(i - ci, j - cj) * base.cell > r) continue;
      const o = (j * base.w + i) * 4;
      if (base.data[o + 3] !== 0) continue;
      const floor = m.grid[j * m.w + i] === 1;
      if (!floor) {
        // Rock only shows where it borders floor, so a cave reads as an outline rather than a black slab.
        let edge = false;
        for (let dj = -1; dj <= 1 && !edge; dj++) for (let di = -1; di <= 1; di++) if (m.grid[clamp(j + dj, 0, m.h - 1) * m.w + clamp(i + di, 0, m.w - 1)] === 1) edge = true;
        if (!edge) continue;
      }
      put(base, i, j, floor ? FLOOR : WALL);
      changed = true;
    }
  }
  if (changed) base.version++;
  return changed;
}

/** True once a pixel of the base has been uncovered or baked. */
export function known(base: MapBase, x: number, z: number): boolean {
  const i = Math.floor((x - base.x0) / base.cell);
  const j = Math.floor((z - base.z0) / base.cell);
  if (i < 0 || j < 0 || i >= base.w || j >= base.h) return false;
  return base.data[(j * base.w + i) * 4 + 3] !== 0;
}

// ------------------------------------------------------------------------------------------------- labels

export const SITE_LABEL: Record<string, string> = {
  gasStop: 'GAS',
  hamlet: 'HAMLET',
  motel: 'MOTEL',
  farm: 'FARM',
  depot: 'DEPOT',
  overpass: 'BRIDGE',
  windfarm: 'WIND',
  mastHill: 'MAST',
  hubDustwell: 'DUSTWELL',
  hubRustgate: 'RUSTGATE',
  hubHaven: 'HAVEN',
};

/** The minimap radius for how fast a vehicle goes: tight when crawling, wide when the horizon is coming at you. */
export function radiusFor(f: MapFrame, speed: number) {
  return f.radiusMin + (f.radiusMax - f.radiusMin) * clamp(speed / 28, 0, 1);
}
