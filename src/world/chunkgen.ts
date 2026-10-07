import { melabesBuildingBoxes } from './melabes';
import type { LegDef } from '../data';
import {
  buildLayout,
  chunkKey,
  newAabbId,
  type Aabb,
  type LegLayoutImpl,
  type MineSpawn,
  type PickupSpawn,
  type PropSpawn,
  type SignSpawn,
  type ScavZone,
  type ZombieSpawn,
} from './layout';
import type { BuildingRole, Facing, PlannedStreet } from './cityPlan';
import { CHUNK, chunkHeightsSteps } from './terrain';
import { cityChunk } from './openWorld';
import { hash2 } from '../core/rng';
import { shopPaneBoxes } from './shopGlass';
import { plantTreesSteps, trunkBox, type TreeSpot } from './flora';

export interface BuildingSpec {
  aabb: Aabb;
  /** A recessed shop replaces the solid building volume with these colliders. */
  colliders?: Aabb[];
  /** Floors drive window rows; 'stepped' adds a smaller upper block. */
  floors: number;
  stepped: boolean;
  /** Planned legs: a fixed facade style (0 panel, 1 brick, 2 stucco, 3 curtain wall) and base colour. */
  style?: number;
  tint?: number;
  /** A landmark building: drawn with its own roof, portico or canopy. `front` is the way its main facade faces. */
  role?: BuildingRole;
  front?: Facing;
  /** A shopfront with its own drawn sign on the boulevard-facing wall. */
  shop?: string;
  /** An ordinary building dressed as an Israeli apartment block: balconies, roller shutters, solar water heaters. */
  israeli?: boolean;
}

export interface ChunkData {
  cx: number;
  cz: number;
  key: number;
  heights: Float32Array;
  /** True for a chunk of city: city ground, boulevard road, sidewalks and facades. */
  city: boolean;
  aabbs: Aabb[];
  buildings: BuildingSpec[];
  props: PropSpawn[];
  /** Drawn signs hung on this chunk's walls and canopies. */
  signs: SignSpawn[];
  pickups: PickupSpawn[];
  zombies: ZombieSpawn[];
  mines: MineSpawn[];
  zones: ScavZone[];
  /** City blocks (z ranges between cross streets) overlapping this chunk: where sidewalks run. */
  blocks: { z0: number; z1: number }[];
  /** Planned legs: paved streets, plazas and lawns overlapping this chunk. */
  patches: PlannedStreet[];
  /** The trees of the green country standing in this chunk (their trunks are among `aabbs`, kind 'tree'). */
  trees: TreeSpot[];
}

const inChunk = (cx: number, cz: number, x: number, z: number) => Math.floor(x / CHUNK) === cx && Math.floor(z / CHUNK) === cz;

/** Pure, deterministic chunk content derived from the shared leg layout. Nothing here touches three.js or Rapier. */
export class ChunkSource {
  layout: LegDefLayout;
  private cache = new Map<number, ChunkData>();
  private buildingAabbs: BuildingSpec[] = [];
  /** Panes of glass over the shopfronts of the street, each in the chunk its centre is in. */
  private shopGlass: Aabb[] = [];

  constructor(public leg: LegDef) {
    this.layout = buildLayout(leg);
    if (this.layout.lots.length || this.layout.landmarks.length) this.makeBuildings();
  }

  private makeBuildings() {
    const L = this.layout;
    for (const lot of L.lots) {
      if (lot.kind !== 'building') continue;
      const roll = hash2(lot.slot * 17 + lot.strip, lot.side + 5, L.leg.seed + 99);
      const floors = lot.floors ?? (lot.strip === 0 ? 2 + Math.floor(roll * 5) : 3 + Math.floor(roll * 11));
      const h = floors * 3.3;
      const aabb: Aabb = {
        id: newAabbId(),
        minX: lot.x0,
        maxX: lot.x1,
        minZ: lot.z0,
        maxZ: lot.z1,
        y0: 0,
        y1: h,
        kind: 'building',
        hp: 99999,
        tint: Math.floor(hash2(lot.slot, lot.strip * 3 + lot.side, 17) * 4),
      };
      const spec: BuildingSpec = { aabb, floors, stepped: roll > 0.72 && !lot.fixed, style: lot.style, tint: lot.tint, shop: lot.shop, israeli: L.plan?.vernacular === 'israeli' };
      if (lot.shop === 'malabes') spec.colliders = melabesBuildingBoxes(aabb, newAabbId);
      this.buildingAabbs.push(spec);
      this.shopGlass.push(...shopPaneBoxes(spec));
    }
    // Landmarks smaller than their lot are not lots at all: they are buildings with a forecourt.
    for (const lm of L.landmarks) {
      this.buildingAabbs.push({ aabb: lm.aabb, floors: lm.floors, stepped: false, style: lm.style, tint: lm.tint, role: lm.role, front: lm.front });
    }
  }

  /** Whether a chunk's data is already made, so `get` is free. */
  has(cx: number, cz: number): boolean {
    return this.cache.has(chunkKey(cx, cz));
  }

  /** Chunks being made a slice at a time by `step`. */
  private making = new Map<number, Generator<void, ChunkData>>();

  get(cx: number, cz: number): ChunkData {
    const key = chunkKey(cx, cz);
    const c = this.cache.get(key);
    if (c) return c;
    // Finish whatever a stepped build has done already, or build it all at once.
    const g = this.making.get(key) ?? this.make(cx, cz);
    this.making.delete(key);
    for (;;) {
      const r = g.next();
      if (r.done) {
        this.cache.set(key, r.value);
        return r.value;
      }
    }
  }

  /** Do one slice of the work of making a chunk. Returns true once it is made and `get` is free. */
  step(cx: number, cz: number): boolean {
    const key = chunkKey(cx, cz);
    if (this.cache.has(key)) return true;
    let g = this.making.get(key);
    if (!g) this.making.set(key, (g = this.make(cx, cz)));
    const r = g.next();
    if (!r.done) return false;
    this.making.delete(key);
    this.cache.set(key, r.value);
    return true;
  }

  private *make(cx: number, cz: number): Generator<void, ChunkData> {
    const key = chunkKey(cx, cz);
    const L = this.layout;
    const heights = yield* chunkHeightsSteps(L.terrain, cx, cz);
    const buildings = this.buildingAabbs.filter((b) => inChunk(cx, cz, (b.aabb.minX + b.aabb.maxX) / 2, (b.aabb.minZ + b.aabb.maxZ) / 2));
    const aabbs = L.aabbs.filter((a) => inChunk(cx, cz, (a.minX + a.maxX) / 2, (a.minZ + a.maxZ) / 2));
    const trees: TreeSpot[] = [];
    if (L.terrain.hydro) {
      yield* plantTreesSteps(L.terrain, cx, cz, heights, { aabbs: L.aabbs, props: L.props, keep: this.keepClear() }, trees);
      for (const t of trees) aabbs.push(trunkBox(t, newAabbId()));
    }
    return {
      cx,
      cz,
      key,
      heights,
      city: L.terrain.biome === 'city' || cityChunk(L.terrain.open, cx, cz),
      aabbs: [...buildings.flatMap((b) => b.colliders ?? [b.aabb]), ...this.shopGlass.filter((a) => inChunk(cx, cz, (a.minX + a.maxX) / 2, (a.minZ + a.maxZ) / 2)), ...aabbs],
      buildings,
      props: L.props.filter((p) => inChunk(cx, cz, p.x, p.z)),
      signs: L.signs.filter((p) => inChunk(cx, cz, p.x, p.z)),
      pickups: L.pickups.filter((p) => inChunk(cx, cz, p.x, p.z)),
      zombies: L.zombies.filter((p) => inChunk(cx, cz, p.x, p.z)),
      mines: L.mines.filter((p) => inChunk(cx, cz, p.x, p.z)),
      zones: L.zones.filter((p) => inChunk(cx, cz, p.x, p.z)),
      blocks: L.slots.filter((s) => s.z1 > cz * CHUNK && s.z0 < (cz + 1) * CHUNK).map((s) => ({ z0: s.z0, z1: s.z1 })),
      patches: L.streets.filter((s) => !s.silent && s.x1 > cx * CHUNK && s.x0 < (cx + 1) * CHUNK && s.z1 > cz * CHUNK && s.z0 < (cz + 1) * CHUNK),
      trees,
    };
  }

  private keep: { x: number; z: number; r: number }[] | null = null;
  /** What the woods leave room around: parked cars, things lying about, camps, encounters, ways underground and the start. */
  private keepClear() {
    if (this.keep) return this.keep;
    const L = this.layout;
    const k: { x: number; z: number; r: number }[] = [];
    for (const c of L.cars) k.push({ x: c.x, z: c.z, r: 5.5 });
    for (const p of L.pickups) k.push({ x: p.x, z: p.z, r: 2.2 });
    for (const g of L.gangCamps) k.push({ x: g.x, z: g.z, r: g.radius + 10 });
    for (const e of L.encounters) k.push({ x: e.x, z: e.z, r: 14 });
    for (const d of L.delves) k.push({ x: d.x, z: d.z, r: 16 });
    for (const zn of L.zones) k.push({ x: zn.x, z: zn.z, r: 10 });
    k.push({ x: L.start.x, z: L.start.z, r: 70 });
    for (const l of L.terrain.lakes) if (l.dock) k.push({ x: (l.dock.x0 + l.dock.x1) / 2, z: (l.dock.z0 + l.dock.z1) / 2, r: Math.max(l.dock.x1 - l.dock.x0, l.dock.z1 - l.dock.z0) / 2 + 12 });
    return (this.keep = k);
  }

  /** Every city building, for the far view of a district. */
  cityBuildings(): BuildingSpec[] {
    return this.buildingAabbs;
  }

  /** All obstacle boxes, used by AI and projectiles. */
  allAabbs(): Aabb[] {
    return [...this.buildingAabbs.flatMap((b) => b.colliders ?? [b.aabb]), ...this.layout.aabbs];
  }

  evict(cx: number, cz: number) {
    this.cache.delete(chunkKey(cx, cz));
  }
}

export type LegDefLayout = LegLayoutImpl;
