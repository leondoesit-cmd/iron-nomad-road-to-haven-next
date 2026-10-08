import { clamp, smoothstep } from '../core/math';
import { corridorHalf, heightAt, roadX, waterAt, type TerrainDef } from '../world/terrain';
import { lakeColors, type WaterStyle } from '../world/lakes';
import { forestAt, lushAt, type Hydro } from '../world/hydro';
import type { LegLayout } from '../world/layout';
import { CELL as DELVE_CELL, cellX, cellZ, type DelveMap } from '../world/delve';
import type { CompassPin } from '../game/scene';
import type { PoiKind } from '../sim/navmarks';

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
  /**
   * The rows changed since a drawn copy last took them (`takeDirty`), as [dirty0, dirty1): a copy uploads only those rows
   * instead of the whole image. Empty when dirty0 >= dirty1.
   */
  dirty0: number;
  dirty1: number;
}

/** Note rows j0..j1 (exclusive) of a base as changed. */
export function markDirty(b: MapBase, j0: number, j1: number) {
  if (j1 <= j0) return;
  if (b.dirty0 >= b.dirty1) {
    b.dirty0 = j0;
    b.dirty1 = j1;
  } else {
    b.dirty0 = Math.min(b.dirty0, j0);
    b.dirty1 = Math.max(b.dirty1, j1);
  }
}

/** The rows changed since the last call, or null: whoever uploads the pixels calls this and sends only those rows. */
export function takeDirty(b: MapBase): [number, number] | null {
  if (b.dirty0 >= b.dirty1) return null;
  const out: [number, number] = [Math.max(0, b.dirty0), Math.min(b.h, b.dirty1)];
  b.dirty0 = 0;
  b.dirty1 = 0;
  return out;
}

export interface MapBlip {
  x: number;
  z: number;
  kind: 'foe' | 'crew' | 'wild' | 'folk';
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

/** Map-only pin kinds on top of the compass ones: the places a leg is made of, and its named water. */
export type MapPinKind = CompassPin['kind'] | 'site' | 'lake' | 'falls' | 'spring' | 'swamp' | 'river' | 'heritage';
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

/** A river or stream as a map line: its centre-line as [x, z, x, z, ...], its half-width, and its bounds. */
export interface MapWater {
  pts: number[];
  half: number;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/**
 * A place name set in the map's own type rather than beside a pin: a city district, a hub, a street or a square. Shown only
 * between two zoom levels (pixels per metre), so a street name never crowds the whole-leg view.
 */
export interface MapLabel {
  x: number;
  z: number;
  text: string;
  kind: 'district' | 'hub' | 'place' | 'town';
  min: number;
  max: number;
}

/** Building footprints as boxes (minX, minZ, maxX, maxZ, ...) with a grid of box indices for culling. */
export interface MapBuildings {
  boxes: Float32Array;
  cell: number;
  grid: Map<number, number[]>;
}

export const buildingKey = (ix: number, iz: number) => (ix + 4096) * 8192 + (iz + 4096);

export function mapBuildings(boxes: { minX: number; minZ: number; maxX: number; maxZ: number }[], cell = 128): MapBuildings {
  const out = new Float32Array(boxes.length * 4);
  const grid = new Map<number, number[]>();
  boxes.forEach((b, i) => {
    out[i * 4] = b.minX;
    out[i * 4 + 1] = b.minZ;
    out[i * 4 + 2] = b.maxX;
    out[i * 4 + 3] = b.maxZ;
    for (let ix = Math.floor(b.minX / cell); ix <= Math.floor(b.maxX / cell); ix++) {
      for (let iz = Math.floor(b.minZ / cell); iz <= Math.floor(b.maxZ / cell); iz++) {
        const k = buildingKey(ix, iz);
        const list = grid.get(k);
        if (list) list.push(i);
        else grid.set(k, [i]);
      }
    }
  });
  return { boxes: out, cell, grid };
}

/** A finer bake of the ground near where someone is looking (`ui/mapTiles.ts`): squares drawn over the base when zoomed in. */
export interface MapTile {
  x0: number;
  z0: number;
  /** Metres per pixel, and pixels per side of the part that is the tile's own (the image has a pixel of overlap all round). */
  cell: number;
  size: number;
  canvas: HTMLCanvasElement | null;
}

export interface TileSource {
  /** Bumped when a tile finishes, so a cached picture of the map knows to redraw. */
  version: number;
  /** Pixels per metre above which tiles are worth asking for. */
  minScale: number;
  /** Ask for the tiles covering a world rectangle (called by whoever draws the map, every time it draws). */
  want(r: MapRect): void;
  /** Every finished tile overlapping a world rectangle. */
  forEach(r: MapRect, cb: (t: MapTile) => void): void;
}

/** The waypoints, routes and marks every map draws (`game/navigation.ts` fills it). */
export interface NavLayer {
  waypoints: { seat: number; x: number; z: number; color: string }[];
  routes: { seat: number; pts: number[]; color: string; length: number; direct: boolean }[];
  pois: { id: number; x: number; z: number; kind: PoiKind; label: string; pin: boolean; color: string }[];
  /** Bumped when a mark or a waypoint changes, so the list beside the map is rebuilt. */
  version: number;
}

export const newNavLayer = (): NavLayer => ({ waypoints: [], routes: [], pois: [], version: 0 });

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
  /** Running water drawn as lines over the ground, so a stream too narrow for the baked pixels still shows. */
  waters: MapWater[];
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
  /** Place names set in the map's type. */
  labels: MapLabel[];
  /** Building footprints, drawn as outlines once zoomed in close enough to tell one from the next. */
  buildings: MapBuildings | null;
  /** The finer ground near the view, where the scene bakes one. */
  tiles: TileSource | null;
  /** Waypoints, routes and the players' own marks. */
  nav: NavLayer;
  /** Bumped when anything drawn into a cached picture of the map changes (roads, labels, buildings, hazards). */
  staticVersion: number;
}

export function newFrame(mode: MapFrame['mode']): MapFrame {
  return {
    mode,
    title: '',
    base: null,
    road: null,
    roadHalf: 4,
    roads: [],
    waters: [],
    hazards: [],
    bounds: { x0: -100, x1: 100, z0: -100, z1: 100 },
    radiusMin: 60,
    radiusMax: 120,
    pins: [],
    blips: [],
    movers: [],
    overview: false,
    labels: [],
    buildings: null,
    tiles: null,
    nav: newNavLayer(),
    staticVersion: 0,
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
  heading = 0;
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
    this.heading = heading;
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

  /** The world point under a screen point: the inverse of `x` and `y`. */
  worldX(sx: number, sy: number) {
    const a = (this.px - sx) / this.scale;
    const b = (this.py - sy) / this.scale;
    return this.cx + this.lx * a + this.fx * b;
  }
  worldZ(sx: number, sy: number) {
    const a = (this.px - sx) / this.scale;
    const b = (this.py - sy) / this.scale;
    return this.cz + this.lz * a + this.fz * b;
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

  /** The world box a screen rectangle covers (whatever the heading), for culling. */
  worldBox(sx0: number, sy0: number, sx1: number, sy1: number, out: MapRect): MapRect {
    out.x0 = Infinity;
    out.x1 = -Infinity;
    out.z0 = Infinity;
    out.z1 = -Infinity;
    for (let k = 0; k < 4; k++) {
      const sx = k & 1 ? sx1 : sx0;
      const sy = k & 2 ? sy1 : sy0;
      const x = this.worldX(sx, sy);
      const z = this.worldZ(sx, sy);
      if (x < out.x0) out.x0 = x;
      if (x > out.x1) out.x1 = x;
      if (z < out.z0) out.z0 = z;
      if (z > out.z1) out.z1 = z;
    }
    return out;
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
/** The green country of the open world: grass and meadow, and the darker woods. */
const MEADOW: Rgb = [112, 132, 70];
const WOOD: Rgb = [50, 76, 42];
const CITY_GROUND: Rgb = [36, 33, 30];
const CITY_BLOCK: Rgb = [92, 84, 74];
const CITY_ZONE: Rgb = [128, 104, 58];
const ROOF: Rgb = [62, 50, 40];

const hex = (n: number): Rgb => [(n >> 16) & 255, (n >> 8) & 255, n & 255];

function put(base: MapBase, i: number, j: number, c: Rgb, a = 255) {
  if (i < 0 || j < 0 || i >= base.w || j >= base.h) return;
  const o = (j * base.w + i) * 4;
  base.data[o] = c[0];
  base.data[o + 1] = c[1];
  base.data[o + 2] = c[2];
  base.data[o + 3] = a;
}

/** Fill the part of a world rectangle that falls on row j of a base (whole cells, as the rectangle's own edges round). */
function fillRow(base: MapBase, r: MapRect, j: number, c: Rgb) {
  const j0 = Math.floor((r.z0 - base.z0) / base.cell);
  const j1 = Math.floor((r.z1 - base.z0) / base.cell);
  if (j < j0 || j > j1) return;
  const i0 = Math.max(0, Math.floor((r.x0 - base.x0) / base.cell));
  const i1 = Math.min(base.w - 1, Math.floor((r.x1 - base.x0) / base.cell));
  for (let i = i0; i <= i1; i++) put(base, i, j, c);
}

/**
 * How the ground is coloured, shared by the whole-leg bake and the finer tiles so the two meet without a seam: a tint by
 * height, green where the land is, three lights from the upper left (north-west, west and north) so no slope goes flat
 * whichever way it faces, contour lines every `interval` metres (every fifth a little darker), and the woods mottled.
 */
export interface GroundShade {
  def: TerrainDef;
  lo: Rgb;
  hi: Rgb;
  hMin: number;
  span: number;
  green: boolean;
  /** Metres between contour lines; 0 draws none. */
  interval: number;
}

export function groundShade(def: TerrainDef, hMin: number, hMax: number): GroundShade {
  const pal = PALETTE[def.theme ?? 'dust'];
  const span = Math.max(1, hMax - hMin);
  return { def, lo: pal.lo, hi: pal.hi, hMin, span, green: !!def.hydro?.lush, interval: span < 40 ? 4 : span < 140 ? 10 : 20 };
}

// Unit vectors toward the three lights: up is +y, the map's upper left is +x (west) and +z (north).
const L1 = [0.5, 0.7071, 0.5];
const L2 = [0.766, 0.6428, 0];
const L3 = [0, 0.6428, 0.766];

/** A small stable hash of a cell, 0..1: the mottling of the canopy. */
const cellHash = (i: number, j: number) => ((((i * 73856093) ^ (j * 19349663)) >>> 0) % 1021) / 1021;

/**
 * Colours one ground pixel into `o` at `off`. `h` is its height, `hl`/`hr` its neighbours west and east along x (minus and
 * plus), `hd`/`hu` along z, all `cell` metres apart. A pixel under water passes its depth (>= 0) and colour style.
 */
export function shadeGround(o: Uint8ClampedArray, off: number, s: GroundShade, h: number, hl: number, hr: number, hd: number, hu: number, cell: number, x: number, z: number, depth: number, style: WaterStyle | null) {
  if (depth >= 0 && style) {
    const col = lakeColors(style);
    // Water by depth: the shallows pale over the bed, the deep water dark.
    const t = Math.sqrt(smoothstep(0, 6, depth));
    const sh = col.shallow;
    const dp = col.deep;
    o[off] = ((sh >> 16) & 255) + ((((dp >> 16) & 255) - ((sh >> 16) & 255)) * t);
    o[off + 1] = ((sh >> 8) & 255) + ((((dp >> 8) & 255) - ((sh >> 8) & 255)) * t);
    o[off + 2] = (sh & 255) + (((dp & 255) - (sh & 255)) * t);
    o[off + 3] = 255;
    return;
  }
  const gx = (hr - hl) / (2 * cell);
  const gz = (hu - hd) / (2 * cell);
  const nl = Math.sqrt(gx * gx + 1 + gz * gz);
  // The normal is (-gx, 1, -gz) / nl.
  const d1 = Math.max(0, (-gx * L1[0] + L1[1] - gz * L1[2]) / nl);
  const d2 = Math.max(0, (-gx * L2[0] + L2[1] - gz * L2[2]) / nl);
  const d3 = Math.max(0, (-gx * L3[0] + L3[1] - gz * L3[2]) / nl);
  const lit = d1 * 0.5 + d2 * 0.3 + d3 * 0.2;
  const tt = smoothstep(0, 1, (h - s.hMin) / s.span);
  let r = s.lo[0] + (s.hi[0] - s.lo[0]) * tt;
  let g = s.lo[1] + (s.hi[1] - s.lo[1]) * tt;
  let b = s.lo[2] + (s.hi[2] - s.lo[2]) * tt;
  let k = 0.46 + 0.68 * lit;
  if (s.green) {
    const L = lushAt(s.def, x, z);
    if (L > 0.02) {
      const m = L * 0.8;
      r += (MEADOW[0] - r) * m;
      g += (MEADOW[1] - g) * m;
      b += (MEADOW[2] - b) * m;
      const F = forestAt(s.def, x, z);
      if (F > 0) {
        const f = F * 0.85;
        r += (WOOD[0] - r) * f;
        g += (WOOD[1] - g) * f;
        b += (WOOD[2] - b) * f;
        // Tree crowns: the canopy is never one flat green.
        k *= 1 - F * 0.26 * cellHash(Math.floor(x / cell), Math.floor(z / cell));
      }
    }
  }
  // Contours: a line where the next pixel east or north lies across a level.
  if (s.interval > 0) {
    const I = s.interval;
    const c0 = Math.floor(h / I);
    const ce = Math.floor(hr / I);
    const cn = Math.floor(hu / I);
    if (ce !== c0 || cn !== c0) {
      const lvl = Math.max(c0, ce, cn);
      k *= lvl % 5 === 0 ? 0.8 : 0.9;
    }
  }
  o[off] = r * k;
  o[off + 1] = g * k;
  o[off + 2] = b * k;
  o[off + 3] = 255;
}

// ------------------------------------------------------------------------------------------------- legs

/** Metres per pixel of the baked ground. Fine enough that a road bend and a lake read, coarse enough to bake in a blink. */
const WASTE_CELL = 8;
const CITY_CELL = 3;
/** The open world is a whole map: coarser ground, so it bakes in seconds (the tiles fill in the detail near the view). */
const OPEN_CELL = 12;
/** How far past the corridor edge the ground is still drawn. */
const EDGE = 24;
/** The quick first pass samples at most about this many points, so a usable picture is there within a frame or two. */
const COARSE_SAMPLES = 3600;
/** Rows per band of the fine pass: bands nearest the convoy are baked first. */
const BAND = 8;
/** Columns sampled or shaded between looks at the clock. */
const CHUNK = 64;

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

/** The open world's rivers and streams as map lines, from the source to just inside whatever they run into. */
export function waterLines(hy: Hydro): MapWater[] {
  return hy.rivers.map((r) => {
    const pts: number[] = [];
    let half = 0;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    const last = Math.min(r.n - 1, r.end + 1);
    for (let i = 0; ; i = Math.min(last, i + 2)) {
      pts.push(r.x[i], r.z[i]);
      half = Math.max(half, r.half[i]);
      x0 = Math.min(x0, r.x[i]);
      x1 = Math.max(x1, r.x[i]);
      z0 = Math.min(z0, r.z[i]);
      z1 = Math.max(z1, r.z[i]);
      if (i === last) break;
    }
    // Most of a course runs at its middling width: draw it so, not at the widest pool by its mouth.
    return { pts, half: Math.min(half, r.kind === 'river' ? 7 : 2.5), x0, x1, z0, z1 };
  });
}

/** Walks the road at a steady step so a map has a centre-line to draw. */
export function roadLine(def: TerrainDef, step = 24): number[] {
  const out: number[] = [];
  for (let z = -40; z < def.length + 80; z += step) out.push(roadX(def, z), z);
  out.push(roadX(def, def.length + 80), def.length + 80);
  return out;
}

type BakeLayout = Pick<LegLayout, 'lots' | 'rural' | 'slots'>;

/**
 * Bakes a leg's ground into an image without stalling a frame. First a quick coarse pass (a few thousand samples, blended
 * up to full size) so the map is usable at once, then the full-detail pass a band of rows at a time, nearest the convoy
 * first, each band overwriting the coarse picture under it. Every change marks its rows dirty so a drawn copy uploads only
 * those. Wasteland is shaded relief with water and buildings; a city is its blocks, lots and streets.
 */
export class LegMapBaker {
  readonly base: MapBase;
  readonly bounds: MapRect;
  /** Height range and colouring, fixed by the coarse pass so the bands agree whichever order they are baked in. */
  shade: GroundShade | null = null;
  private def: TerrainDef | null;
  private layout: BakeLayout | null;
  private stage: 'coarse' | 'paint' | 'fine' | 'done' = 'coarse';
  // Coarse pass: one sample per K x K cells.
  private K = 1;
  private cw = 0;
  private ch = 0;
  private cRow = 0;
  private cH: Float32Array | null = null;
  private cDepth: Float32Array | null = null;
  private cStyle: (WaterStyle | null)[] = [];
  private cRgb: Float32Array | null = null;
  private paintRow = 0;
  // Fine pass.
  private heights: Float32Array | null = null;
  private depth: Float32Array | null = null;
  private styles: (WaterStyle | null)[] = [];
  private sampled: Uint8Array | null = null;
  private bandDone: Uint8Array;
  private bandsLeft: number;
  private band = -1;
  private row = 0;
  private col = 0;
  private sampleRow = -1;
  private focusRow = 0;
  private hMin = Infinity;
  private hMax = -Infinity;

  constructor(def: TerrainDef, layout: BakeLayout) {
    this.def = def;
    this.layout = layout;
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
    this.base = { x0, z0, cell, w, h, data: new Uint8ClampedArray(w * h * 4), version: 0, done: false, dirty0: 0, dirty1: 0 };
    this.bandDone = new Uint8Array(Math.ceil(h / BAND));
    this.bandsLeft = this.bandDone.length;
    this.focusRow = clamp(Math.floor((0 - z0) / cell), 0, h - 1);
    if (city) {
      this.bakeCity();
      return;
    }
    // Wasteland corridors leave most of the box blank: only the rows' corridor spans count toward the sample budget.
    let cells = 0;
    for (let j = 0; j < h; j += 4) {
      const [i0, i1] = this.span(j);
      cells += Math.max(0, i1 - i0 + 1) * 4;
    }
    this.K = Math.max(2, Math.ceil(Math.sqrt(cells / COARSE_SAMPLES)));
    this.cw = Math.ceil(w / this.K);
    this.ch = Math.ceil(h / this.K);
    this.cH = new Float32Array(this.cw * this.ch).fill(NaN);
    this.cDepth = new Float32Array(this.cw * this.ch).fill(-1);
    this.cStyle = new Array(this.cw * this.ch).fill(null);
  }

  /** The columns of row j that hold ground (all of them in the open world; the corridor and its edge in a wasteland leg). */
  private span(j: number): [number, number] {
    const b = this.base;
    const def = this.def!;
    if (def.open) return [0, b.w - 1];
    const z = b.z0 + (j + 0.5) * b.cell;
    const rx = roadX(def, z);
    const half = corridorHalf(def, z) + EDGE;
    return [Math.max(0, Math.floor((rx - half - b.x0) / b.cell)), Math.min(b.w - 1, Math.ceil((rx + half - b.x0) / b.cell))];
  }

  get progress() {
    if (this.base.done) return 1;
    if (this.stage === 'coarse') return (this.cRow / Math.max(1, this.ch)) * 0.06;
    if (this.stage === 'paint') return 0.06 + (this.paintRow / this.base.h) * 0.04;
    return 0.1 + (1 - this.bandsLeft / this.bandDone.length) * 0.9;
  }

  /** True once the quick coarse picture is in (or the whole bake is done). */
  get usable() {
    return this.base.done || this.stage === 'fine';
  }

  /** Bake the bands nearest this point next. */
  focus(z: number) {
    this.focusRow = clamp(Math.floor((z - this.base.z0) / this.base.cell), 0, this.base.h - 1);
  }

  /** Does up to `ms` of baking. Returns true once the ground is finished. */
  step(ms: number): boolean {
    const b = this.base;
    if (b.done) return true;
    const end = performance.now() + ms;
    do {
      if (this.stage === 'coarse') this.coarseRow();
      else if (this.stage === 'paint') this.coarsePaint();
      else if (this.stage === 'fine') this.fineChunk();
      else break;
    } while (performance.now() < end && !b.done);
    return b.done;
  }

  /** Bakes everything at once: for tests and for scenes that cannot wait. */
  finish() {
    while (!this.step(50));
    return this.base;
  }

  // ---------------------------------------------------------------- coarse pass

  private coarseRow() {
    const b = this.base;
    const def = this.def!;
    const K = this.K;
    const cj = this.cRow++;
    const j = Math.min(b.h - 1, cj * K + (K >> 1));
    const z = b.z0 + (j + 0.5) * b.cell;
    const [i0, i1] = this.span(j);
    for (let ci = 0; ci < this.cw; ci++) {
      const i = Math.min(b.w - 1, ci * K + (K >> 1));
      if (i < i0 - K || i > i1 + K) continue;
      const x = b.x0 + (i + 0.5) * b.cell;
      const h = heightAt(def, x, z);
      this.cH![cj * this.cw + ci] = h;
      if (h < this.hMin) this.hMin = h;
      if (h > this.hMax) this.hMax = h;
      const wt = waterAt(def, x, z);
      if (wt) {
        this.cDepth![cj * this.cw + ci] = wt.depth;
        this.cStyle[cj * this.cw + ci] = wt.style;
      }
    }
    if (this.cRow >= this.ch) this.coarseShade();
  }

  /** Colour each coarse sample, then blend the colours up to full size, row by row. */
  private coarseShade() {
    // A little headroom: the fine pass finds peaks and hollows the coarse one stepped over.
    const pad = (this.hMax - this.hMin) * 0.04 + 0.5;
    this.shade = groundShade(this.def!, this.hMin - pad, this.hMax + pad);
    const s = { ...this.shade, interval: 0 };
    const cw = this.cw;
    const ch = this.ch;
    const H = this.cH!;
    const cell = this.base.cell * this.K;
    const rgb = (this.cRgb = new Float32Array(cw * ch * 4));
    const px = new Uint8ClampedArray(4);
    const at = (ci: number, cj: number, h: number) => {
      const v = H[clamp(cj, 0, ch - 1) * cw + clamp(ci, 0, cw - 1)];
      return Number.isNaN(v) ? h : v;
    };
    for (let cj = 0; cj < ch; cj++) {
      for (let ci = 0; ci < cw; ci++) {
        const k = cj * cw + ci;
        const h = H[k];
        if (Number.isNaN(h)) continue;
        const i = Math.min(this.base.w - 1, ci * this.K + (this.K >> 1));
        const j = Math.min(this.base.h - 1, cj * this.K + (this.K >> 1));
        const x = this.base.x0 + (i + 0.5) * this.base.cell;
        const z = this.base.z0 + (j + 0.5) * this.base.cell;
        shadeGround(px, 0, s, h, at(ci - 1, cj, h), at(ci + 1, cj, h), at(ci, cj - 1, h), at(ci, cj + 1, h), cell, x, z, this.cDepth![k], this.cStyle[k]);
        rgb[k * 4] = px[0];
        rgb[k * 4 + 1] = px[1];
        rgb[k * 4 + 2] = px[2];
        rgb[k * 4 + 3] = 1;
      }
    }
    this.stage = 'paint';
  }

  private coarsePaint() {
    const b = this.base;
    const j = this.paintRow++;
    const K = this.K;
    const cw = this.cw;
    const ch = this.ch;
    const rgb = this.cRgb!;
    const [i0, i1] = this.span(j);
    const v = (j + 0.5) / K - 0.5;
    const cj0 = clamp(Math.floor(v), 0, ch - 1);
    const cj1 = Math.min(ch - 1, cj0 + 1);
    const tv = clamp(v - cj0, 0, 1);
    for (let i = i0; i <= i1; i++) {
      const u = (i + 0.5) / K - 0.5;
      const ci0 = clamp(Math.floor(u), 0, cw - 1);
      const ci1 = Math.min(cw - 1, ci0 + 1);
      const tu = clamp(u - ci0, 0, 1);
      let r = 0;
      let g = 0;
      let bl = 0;
      let wsum = 0;
      for (let q = 0; q < 4; q++) {
        const ci = q & 1 ? ci1 : ci0;
        const cj = q & 2 ? cj1 : cj0;
        const k = (cj * cw + ci) * 4;
        if (!rgb[k + 3]) continue;
        const w = (q & 1 ? tu : 1 - tu) * (q & 2 ? tv : 1 - tv) + 1e-4;
        r += rgb[k] * w;
        g += rgb[k + 1] * w;
        bl += rgb[k + 2] * w;
        wsum += w;
      }
      if (wsum <= 0) continue;
      const o = (j * b.w + i) * 4;
      b.data[o] = r / wsum;
      b.data[o + 1] = g / wsum;
      b.data[o + 2] = bl / wsum;
      b.data[o + 3] = 255;
    }
    this.overlays(j);
    markDirty(b, j, j + 1);
    b.version++;
    if (this.paintRow >= b.h) {
      this.cH = null;
      this.cDepth = null;
      this.cStyle = [];
      this.cRgb = null;
      this.heights = new Float32Array(b.w * b.h).fill(NaN);
      this.depth = new Float32Array(b.w * b.h).fill(-1);
      this.styles = new Array(b.w * b.h).fill(null);
      this.sampled = new Uint8Array(b.h);
      this.stage = 'fine';
    }
  }

  // ---------------------------------------------------------------- fine pass

  /** The unbaked band nearest the focus. */
  private nextBand(): number {
    let best = -1;
    let bd = Infinity;
    for (let k = 0; k < this.bandDone.length; k++) {
      if (this.bandDone[k]) continue;
      const d = Math.abs(k * BAND + BAND / 2 - this.focusRow);
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    return best;
  }

  /** One chunk of work: sample part of a row the current row needs, or shade part of the current row. */
  private fineChunk() {
    const b = this.base;
    if (this.band < 0) {
      this.band = this.nextBand();
      if (this.band < 0) {
        this.finishFine();
        return;
      }
      this.row = this.band * BAND;
      this.col = 0;
      this.sampleRow = -1;
    }
    const j = this.row;
    // Its neighbours above and below must be sampled before a row can be shaded.
    for (const r of [j - 1, j, j + 1]) {
      if (r < 0 || r >= b.h || this.sampled![r]) continue;
      if (this.sampleRow !== r) {
        this.sampleRow = r;
        this.col = 0;
      }
      this.sampleChunk(r);
      return;
    }
    if (this.sampleRow !== -2) {
      this.sampleRow = -2;
      this.col = 0;
    }
    this.shadeChunk(j);
  }

  private sampleChunk(j: number) {
    const b = this.base;
    const def = this.def!;
    const [i0, i1] = this.span(j);
    const z = b.z0 + (j + 0.5) * b.cell;
    const start = Math.max(this.col, i0);
    const stop = Math.min(i1, start + CHUNK - 1);
    for (let i = start; i <= stop; i++) {
      const x = b.x0 + (i + 0.5) * b.cell;
      const k = j * b.w + i;
      this.heights![k] = heightAt(def, x, z);
      const wt = waterAt(def, x, z);
      if (wt) {
        this.depth![k] = wt.depth;
        this.styles[k] = wt.style;
      }
    }
    this.col = stop + 1;
    if (this.col > i1) {
      this.sampled![j] = 1;
      this.col = 0;
      this.sampleRow = -1;
    }
  }

  private shadeChunk(j: number) {
    const b = this.base;
    const s = this.shade!;
    const hs = this.heights!;
    const [i0, i1] = this.span(j);
    const z = b.z0 + (j + 0.5) * b.cell;
    const start = Math.max(this.col, i0);
    const stop = Math.min(i1, start + CHUNK - 1);
    const w = b.w;
    const at = (i: number, jj: number, h: number) => {
      const v = hs[clamp(jj, 0, b.h - 1) * w + clamp(i, 0, w - 1)];
      return Number.isNaN(v) ? h : v;
    };
    for (let i = start; i <= stop; i++) {
      const k = j * w + i;
      const h = hs[k];
      if (Number.isNaN(h)) continue;
      const x = b.x0 + (i + 0.5) * b.cell;
      shadeGround(b.data, k * 4, s, h, at(i - 1, j, h), at(i + 1, j, h), at(i, j - 1, h), at(i, j + 1, h), b.cell, x, z, this.depth![k], this.styles[k]);
    }
    this.col = stop + 1;
    if (this.col > i1) {
      this.overlays(j);
      markDirty(b, j, j + 1);
      b.version++;
      this.col = 0;
      this.row++;
      if (this.row >= Math.min(b.h, (this.band + 1) * BAND)) {
        this.bandDone[this.band] = 1;
        this.bandsLeft--;
        this.band = -1;
      }
    }
  }

  /** What sits on the ground in row j: buildings, and a city district's ground, blocks and zones. */
  private overlays(j: number) {
    const b = this.base;
    const L = this.layout!;
    for (const r of L.rural) fillRow(b, { x0: r.aabb.minX, x1: r.aabb.maxX, z0: r.aabb.minZ, z1: r.aabb.maxZ }, j, ROOF);
    // A city district of the open world: its ground, blocks and zones, drawn as a city leg's map is.
    if (this.def!.open) {
      for (const d of this.def!.open.districts) fillRow(b, d, j, CITY_GROUND);
      for (const lot of L.lots) if (lot.kind !== 'open') fillRow(b, lot, j, lot.kind === 'zone' ? CITY_ZONE : CITY_BLOCK);
    }
  }

  private finishFine() {
    this.heights = null;
    this.depth = null;
    this.styles = [];
    this.sampled = null;
    this.def = null;
    this.layout = null;
    this.stage = 'done';
    this.base.done = true;
    this.base.version++;
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
    for (const lot of this.layout!.lots) {
      if (lot.kind === 'open') continue;
      const c = lot.kind === 'zone' ? CITY_ZONE : CITY_BLOCK;
      const j0 = Math.max(0, Math.floor((lot.z0 - b.z0) / b.cell));
      const j1 = Math.min(b.h - 1, Math.floor((lot.z1 - b.z0) / b.cell));
      for (let j = j0; j <= j1; j++) fillRow(b, lot, j, c);
    }
    this.stage = 'done';
    this.def = null;
    this.layout = null;
    b.done = true;
    markDirty(b, 0, b.h);
    b.version++;
  }
}

/**
 * Finished and half-finished bakes, kept across scenes: a leg's ground depends only on the leg (its id and seed), so the
 * next day on the same open world, a return from a delve, or the game after the title demo drove leg W, all find the map
 * already baked. A few are kept, the oldest dropped.
 */
const BAKES = new Map<string, LegMapBaker>();
const BAKES_KEPT = 3;

export function legBaker(key: string, def: TerrainDef, layout: BakeLayout): LegMapBaker {
  const had = BAKES.get(key);
  if (had) {
    BAKES.delete(key);
    BAKES.set(key, had);
    return had;
  }
  const b = new LegMapBaker(def, layout);
  BAKES.set(key, b);
  while (BAKES.size > BAKES_KEPT) BAKES.delete(BAKES.keys().next().value!);
  return b;
}

/** For tests: forget every kept bake. */
export function clearBakes() {
  BAKES.clear();
}

// ------------------------------------------------------------------------------------------------- delves

/** A delve's map: nothing is drawn until someone has been near it. */
export function newDelveBase(m: DelveMap): MapBase {
  const x0 = cellX(m, 0);
  const z0 = cellZ(m, 0);
  return { x0, z0, cell: DELVE_CELL, w: m.w, h: m.h, data: new Uint8ClampedArray(m.w * m.h * 4), version: 0, done: true, dirty0: 0, dirty1: 0 };
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
  let j0 = Infinity;
  let j1 = -Infinity;
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
      if (j < j0) j0 = j;
      if (j > j1) j1 = j;
    }
  }
  if (changed) {
    markDirty(base, j0, j1 + 1);
    base.version++;
  }
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

void hex;
