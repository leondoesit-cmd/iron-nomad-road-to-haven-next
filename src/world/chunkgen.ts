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
  type ScavZone,
  type ZombieSpawn,
} from './layout';
import type { BuildingRole, Facing, PlannedStreet } from './cityPlan';
import { CHUNK, chunkHeights } from './terrain';
import { hash2 } from '../core/rng';

export interface BuildingSpec {
  aabb: Aabb;
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
}

export interface ChunkData {
  cx: number;
  cz: number;
  key: number;
  heights: Float32Array;
  aabbs: Aabb[];
  buildings: BuildingSpec[];
  props: PropSpawn[];
  pickups: PickupSpawn[];
  zombies: ZombieSpawn[];
  mines: MineSpawn[];
  zones: ScavZone[];
  /** City blocks (z ranges between cross streets) overlapping this chunk: where sidewalks run. */
  blocks: { z0: number; z1: number }[];
  /** Planned legs: paved streets, plazas and lawns overlapping this chunk. */
  patches: PlannedStreet[];
}

const inChunk = (cx: number, cz: number, x: number, z: number) => Math.floor(x / CHUNK) === cx && Math.floor(z / CHUNK) === cz;

/** Pure, deterministic chunk content derived from the shared leg layout. Nothing here touches three.js or Rapier. */
export class ChunkSource {
  layout: LegDefLayout;
  private cache = new Map<number, ChunkData>();
  private buildingAabbs: BuildingSpec[] = [];

  constructor(public leg: LegDef) {
    this.layout = buildLayout(leg);
    if (leg.biome === 'city') this.makeBuildings();
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
      this.buildingAabbs.push({ aabb, floors, stepped: roll > 0.72 && !lot.fixed, style: lot.style, tint: lot.tint, shop: lot.shop });
    }
    // Landmarks smaller than their lot are not lots at all: they are buildings with a forecourt.
    for (const lm of L.landmarks) {
      this.buildingAabbs.push({ aabb: lm.aabb, floors: lm.floors, stepped: false, style: lm.style, tint: lm.tint, role: lm.role, front: lm.front });
    }
  }

  get(cx: number, cz: number): ChunkData {
    const key = chunkKey(cx, cz);
    let c = this.cache.get(key);
    if (c) return c;
    const L = this.layout;
    const buildings = this.buildingAabbs.filter((b) => inChunk(cx, cz, (b.aabb.minX + b.aabb.maxX) / 2, (b.aabb.minZ + b.aabb.maxZ) / 2));
    const aabbs = L.aabbs.filter((a) => inChunk(cx, cz, (a.minX + a.maxX) / 2, (a.minZ + a.maxZ) / 2));
    c = {
      cx,
      cz,
      key,
      heights: chunkHeights(L.terrain, cx, cz),
      aabbs: [...buildings.map((b) => b.aabb), ...aabbs],
      buildings,
      props: L.props.filter((p) => inChunk(cx, cz, p.x, p.z)),
      pickups: L.pickups.filter((p) => inChunk(cx, cz, p.x, p.z)),
      zombies: L.zombies.filter((p) => inChunk(cx, cz, p.x, p.z)),
      mines: L.mines.filter((p) => inChunk(cx, cz, p.x, p.z)),
      zones: L.zones.filter((p) => inChunk(cx, cz, p.x, p.z)),
      blocks: L.slots.filter((s) => s.z1 > cz * CHUNK && s.z0 < (cz + 1) * CHUNK).map((s) => ({ z0: s.z0, z1: s.z1 })),
      patches: L.streets.filter((s) => !s.silent && s.x1 > cx * CHUNK && s.x0 < (cx + 1) * CHUNK && s.z1 > cz * CHUNK && s.z0 < (cz + 1) * CHUNK),
    };
    this.cache.set(key, c);
    return c;
  }

  /** All obstacle boxes, used by AI and projectiles. */
  allAabbs(): Aabb[] {
    return [...this.buildingAabbs.map((b) => b.aabb), ...this.layout.aabbs];
  }

  evict(cx: number, cz: number) {
    this.cache.delete(chunkKey(cx, cz));
  }
}

export type LegDefLayout = LegLayoutImpl;
