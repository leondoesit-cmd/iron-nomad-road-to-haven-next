import { partDef, type LegDef, type SetPiece, type Stocks, type ZombieKind } from '../data';
import { rollPartSpec } from '../sim/parts';
import type { DrugId } from '../sim/drugs';
import { OIL_CAN } from '../sim/oil';
import { Rng, hash2 } from '../core/rng';
import { makeTerrainDef, roadX, heightAt, roadSlope, keepOutZ, waterAt, type Site, type TerrainDef } from './terrain';
import { buildRoadside, buildSite, type RuralBuilding, type SiteContent } from './settlements';
import { isLakeSite, lakeAt } from './lakes';
import { delveName, delveSiteKind, type DelveSite } from './delveSites';
import { planById } from './plans';
import type { BuildingRole, CityPlan, Facing, LandmarkKind, PlannedPlace, PlannedStreet } from './cityPlan';

export type AabbKind = 'building' | 'wall' | 'car' | 'rock' | 'barricade' | 'crate' | 'pillar' | 'tower' | 'partition' | 'furniture' | 'stair' | 'floor' | 'dock';

/** Axis-aligned obstacle used by zombies, projectiles, camera and the Rapier collider builder. */
export interface Aabb {
  id: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Base and top heights above ground. */
  y0: number;
  y1: number;
  kind: AabbKind;
  breakable?: 'flimsy' | 'reinforced';
  hp: number;
  /** Visual tint index for building variety. */
  tint?: number;
  /** Collides in physics only: zombies, bullets and the camera ignore it (stairs, upper floors). */
  physOnly?: boolean;
  /** A sloped collider (stairs): centre, half extents and orientation. The min/max box is only its footprint. */
  ramp?: { x: number; y: number; z: number; hx: number; hy: number; hz: number; q: [number, number, number, number] };
  /** Ground height under the box, cached by the obstacle index so line-of-sight heights can be relative to it. */
  gy?: number;
}

export type PropKind =
  | 'rock'
  | 'cairn'
  | 'deadTree'
  | 'wreck'
  | 'pole'
  | 'barrel'
  | 'tires'
  | 'sign'
  | 'bones'
  | 'tarp'
  | 'pylon'
  | 'crateStack'
  | 'shelf'
  | 'locker'
  | 'canopy'
  | 'dumpster'
  | 'streetlight'
  | 'rubble'
  | 'banner'
  | 'chain'
  | 'pump'
  | 'container'
  | 'fence'
  | 'waterTower'
  | 'silo'
  | 'windTurbine'
  | 'mast'
  | 'billboard'
  | 'gasSign'
  | 'fuelTank'
  | 'windpump'
  | 'powerTower'
  | 'powerSpan'
  | 'overpass'
  | 'dock'
  | 'lighthouse'
  | 'shipwreck'
  | 'caveMouth'
  | 'mineAdit'
  | 'bunkerHatch'
  | 'metroEntrance'
  | 'fountain'
  | 'plaque'
  | 'bench'
  | 'parkBays'
  | 'cafeTable'
  | 'cafeChair';

export interface PropSpawn {
  kind: PropKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  seed: number;
  /** Optional marker colour index. */
  tag?: number;
  /** Power spans only: rise from one end to the other. */
  dy?: number;
}

export type PickupKind = 'fuel' | 'oil' | 'scrap' | 'parts' | 'tech' | 'rations' | 'medicine' | 'ammo' | 'fragment' | 'chassis' | 'part' | 'paint' | 'water';
export interface PickupSpawn {
  id: string;
  kind: PickupKind;
  amount: number;
  /** For kind 'part': which part, and how worn. `amount` holds its quality. */
  part?: { id: string; cond: number };
  /** For kind 'fuel': set when a can is put down; world cans get theirs from their id (see sim/fuel `pickupFuel`). */
  fuel?: 'petrol' | 'diesel';
  /** For kind 'paint': the colour in the can (`amount` holds the sprays left). Only ever put down by a player or found in a trunk. */
  color?: number;
  x: number;
  y: number;
  z: number;
}

/** A car standing in the world. Its chassis and condition come from its seed unless forced. */
export interface CarSpawn {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  seed: number;
  chassis?: string;
  status?: 'hulk' | 'rough' | 'intact';
  /** Marker for the roadside Encounter car. */
  tag?: number;
}

export interface ZombieSpawn {
  kind: ZombieKind;
  x: number;
  z: number;
  dormant: boolean;
  cluster: number;
}

export interface ScavContainer {
  id: string;
  x: number;
  z: number;
  depth: 0 | 1 | 2;
  loot: Partial<Stocks>;
  /** Drugs among the loot. Rolled apart from everything else, so adding one never reshuffles a map. */
  drugs?: Partial<Record<DrugId, number>>;
  taken: boolean;
  /** What the prompt calls it ('the fridge'); defaults to the depth name. */
  label?: string;
  /** Height of the marker; defaults to above the ground. */
  y?: number;
}

export interface ScavZone {
  id: string;
  kind: 'pharmacy' | 'depot' | 'parking' | 'hospital' | 'house' | 'store' | 'motel' | 'barn' | 'warehouse' | 'shack';
  x: number;
  z: number;
  w: number;
  d: number;
  /** Direction to the open side (towards the boulevard): +1 or -1 on x. */
  open: 1 | -1;
  containers: ScavContainer[];
  /** False for building interiors: they stay off the compass. */
  pin?: boolean;
}

export interface AmbushSpec {
  id: string;
  x: number;
  z: number;
  buggies: number;
  wagon: number;
  triggerRadius: number;
  canyon: boolean;
}

export interface EncounterSpot {
  id: string;
  encounter: string;
  x: number;
  z: number;
}

export interface TipSpot {
  id: string;
  tip: string;
  z: number;
}

export interface MineSpawn {
  x: number;
  z: number;
  id: number;
}

export interface Lot {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  side: -1 | 1;
  strip: number;
  slot: number;
  kind: 'building' | 'open' | 'zone';
  /** Planned legs: floors, facade style and tint, when the plan fixes them. */
  floors?: number;
  style?: number;
  tint?: number;
  /** Planned legs: a landmark lot. Set pieces and the metro headhouse leave it alone. */
  landmark?: LandmarkKind;
  /** Planned legs: a shopfront with its own drawn sign. */
  shop?: string;
  fixed?: boolean;
}

export interface Passage {
  /** North-south passage spanning x0..x1 on one side. */
  x0: number;
  x1: number;
  width: number;
  side: -1 | 1;
  /** Planned legs: the street this is, if it has a name. */
  street?: string;
}

export interface Slot {
  z0: number;
  z1: number;
  cross: number; // cross-street width after this block
  /** Planned legs: the cross street after this block, if it has a name. */
  street?: string;
}

/** A landmark building that is smaller than its lot (the rest of the lot is a forecourt or car park). */
export interface LandmarkBuilding {
  aabb: Aabb;
  role: BuildingRole;
  floors: number;
  style: number;
  tint?: number;
  /** The way the main facade faces. */
  front: Facing;
}

export interface LegLayout {
  leg: LegDef;
  terrain: TerrainDef;
  slots: Slot[];
  /** Per side, the building strips (x ranges) and passages between them. */
  strips: { x0: number; x1: number; side: -1 | 1 }[];
  passages: Passage[];
  lots: Lot[];
  /** Planned city legs: the authored plan, paved streets and plazas, announced places and landmark buildings. */
  plan: CityPlan | null;
  streets: PlannedStreet[];
  places: PlannedPlace[];
  landmarks: LandmarkBuilding[];
  zones: ScavZone[];
  ambushes: AmbushSpec[];
  encounters: EncounterSpot[];
  tips: TipSpot[];
  mines: MineSpawn[];
  /** Hand-placed items by chunk key. */
  pickups: PickupSpawn[];
  props: PropSpawn[];
  /** Every abandoned car, drivable or not. Streamed as real vehicles by the car system. */
  cars: CarSpawn[];
  zombies: ZombieSpawn[];
  aabbs: Aabb[];
  /** Wasteland buildings: drawn by the far landscape, collided through their aabbs. */
  rural: RuralBuilding[];
  /** Ways underground: cave mouths, mine adits, bunker hatches and metro stairs. */
  delves: DelveSite[];
  barricades: { z: number; grade: 'flimsy' | 'reinforced' }[];
  start: { x: number; z: number; yaw: number };
  end: { x: number; z: number; radius: number };
  campSpots: { x: number; z: number }[];
  blockedAt(x: number, z: number, r: number): boolean;
}

let nextId = 1;
export const newAabbId = () => nextId++;

const PASSAGE_WIDTHS = [1.8, 2.6, 3.6, 3.6, 5.0];
export const BOULEVARD_HALF = 7;
export const SIDEWALK = 3;

function pushZombies(layout: LegLayout, rng: Rng, x: number, z: number, count: number, kinds: ZombieKind[], spread: number, dormant: boolean, cluster: number, clear = 0.8) {
  for (let i = 0; i < count; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.next()) * spread;
    const zx = x + Math.cos(a) * r;
    const zz = z + Math.sin(a) * r;
    if (layout.blockedAt(zx, zz, clear)) continue;
    layout.zombies.push({ kind: rng.pick(kinds), x: zx, z: zz, dormant, cluster });
  }
}

/** Builds everything that depends on the leg definition and is the same for every chunk. */
export function buildLayout(leg: LegDef): LegLayoutImpl {
  return new LegLayoutImpl(leg);
}

export class LegLayoutImpl implements LegLayout {
  leg: LegDef;
  terrain: TerrainDef;
  slots: Slot[] = [];
  strips: { x0: number; x1: number; side: -1 | 1 }[] = [];
  passages: Passage[] = [];
  lots: Lot[] = [];
  plan: CityPlan | null = null;
  streets: PlannedStreet[] = [];
  places: PlannedPlace[] = [];
  landmarks: LandmarkBuilding[] = [];
  zones: ScavZone[] = [];
  ambushes: AmbushSpec[] = [];
  encounters: EncounterSpot[] = [];
  tips: TipSpot[] = [];
  mines: MineSpawn[] = [];
  pickups: PickupSpawn[] = [];
  props: PropSpawn[] = [];
  cars: CarSpawn[] = [];
  zombies: ZombieSpawn[] = [];
  aabbs: Aabb[] = [];
  rural: RuralBuilding[] = [];
  delves: DelveSite[] = [];
  barricades: { z: number; grade: 'flimsy' | 'reinforced' }[] = [];
  start = { x: 0, z: 10, yaw: 0 };
  end = { x: 0, z: 0, radius: 40 };
  campSpots: { x: number; z: number }[] = [];
  private lotGrid = new Map<number, Lot[]>();
  private rng: Rng;
  private pid = 0;

  constructor(leg: LegDef) {
    this.leg = leg;
    this.terrain = makeTerrainDef(leg);
    this.rng = new Rng(leg.seed * 7919 + 13);
    if (leg.biome === 'city') {
      if (leg.plan) this.buildPlannedGrid(planById(leg.plan));
      else this.buildCityGrid();
    }
    for (const s of leg.sets) this.place(s);
    this.end = { x: roadX(this.terrain, leg.length), z: leg.length, radius: 45 };
    this.start = { x: roadX(this.terrain, 12), z: 12, yaw: Math.atan2(roadSlope(this.terrain, 12), 1) };
    this.campSpots = [
      { x: this.end.x + 26, z: leg.length + 40 },
      { x: this.end.x - 26, z: leg.length + 40 },
    ];
    if (leg.biome === 'city') {
      this.cityAmbient();
      this.roadsideKit();
      this.buildMetro();
    } else {
      this.buildSites();
      const n0 = [this.props.length, this.pickups.length, this.aabbs.length];
      this.wastelandAmbient();
      this.roadsideJams();
      this.roadsideKit();
      // The scatter of rocks and trees stays out of the settlements.
      const inSite = (x: number, z: number) => this.terrain.sites.some((s) => s.radius > 0 && Math.hypot(x - s.x, z - s.z) < s.radius * 0.95);
      this.props = this.props.filter((p, i) => i < n0[0] || !inSite(p.x, p.z));
      this.pickups = this.pickups.filter((p, i) => i < n0[1] || !inSite(p.x, p.z));
      this.aabbs = this.aabbs.filter((a, i) => i < n0[2] || !inSite((a.minX + a.maxX) / 2, (a.minZ + a.maxZ) / 2));
      this.buildLakes();
      // Nothing stands in a lake.
      this.cars = this.cars.filter((c) => !waterAt(this.terrain, c.x, c.z));
    }
    // Later passes (parked cars, rocks) may overlap earlier spawns: nothing spawns inside an obstacle.
    this.zombies = this.zombies.filter((z) => !this.blockedAt(z.x, z.z, 0.3));
    this.pickups = this.pickups.filter((p) => !this.blockedAt(p.x, p.z, 0.2) || p.kind === 'fragment' || p.kind === 'chassis');
  }

  // ---------------------------------------------------------------- roadside kit

  /**
   * Oil cans and the odd dropped car part along the road, so a convoy that keeps moving can keep its engines
   * topped up and its cars improving. Its own random stream: adding or tuning these never shifts the rest of the leg.
   */
  private roadsideKit() {
    const rng = new Rng(this.leg.seed ^ 0x0e11);
    const city = this.leg.biome === 'city';
    const T = this.terrain;
    for (let z = 90; z < this.leg.length; z += rng.range(95, 160)) {
      const rx = roadX(T, z);
      const side = rng.sign();
      const dist = city ? rng.range(8, 11) : rng.range(7, 30);
      if (rng.chance(0.55)) {
        const x = rx + side * dist;
        this.pickups.push({ id: this.id('ro'), kind: 'oil', amount: OIL_CAN, x, z, y: city ? 0 : heightAt(T, x, z) });
      }
      if (rng.chance(0.18)) {
        const x = rx - side * rng.range(city ? 8 : 8, city ? 11 : 26);
        const zz = z + rng.range(-12, 12);
        const spec = rollPartSpec(rng, { minMk: 1, maxMk: rng.chance(0.2) ? 2 : 1 });
        this.pickups.push({ id: this.id('rp'), kind: 'part', amount: partDef(spec.id).mk, part: spec, x, z: zz, y: city ? 0 : heightAt(T, x, zz) });
      }
    }
  }

  // ---------------------------------------------------------------- city grid

  private buildCityGrid() {
    const rng = new Rng(this.leg.seed ^ 0x5eed);
    // Z slots (blocks along the boulevard) with cross streets between.
    let z = -220;
    const zEnd = this.leg.length + 260;
    while (z < zEnd) {
      const bl = rng.range(34, 56);
      const cross = rng.pick([1.8, 2.6, 3.6, 5, 6, 8]);
      this.slots.push({ z0: z, z1: z + bl, cross });
      z += bl + cross;
    }
    // Strips and passages per side.
    for (const side of [-1, 1] as const) {
      let x = BOULEVARD_HALF + SIDEWALK;
      let i = 0;
      while (x < 148) {
        const w = rng.range(15, 27);
        const x1 = Math.min(x + w, 150);
        const sx0 = side === 1 ? x : -x1;
        const sx1 = side === 1 ? x1 : -x;
        this.strips.push({ x0: sx0, x1: sx1, side });
        x = x1;
        if (x >= 148) break;
        // The second gap on each side is always an interior alley so small vehicles have a way through.
        const gw = i === 1 ? 1.8 : rng.pick(PASSAGE_WIDTHS);
        const px0 = side === 1 ? x : -(x + gw);
        const px1 = side === 1 ? x + gw : -x;
        this.passages.push({ x0: px0, x1: px1, width: gw, side });
        x += gw;
        i++;
      }
    }
    // Lots: each strip x each slot.
    let si = 0;
    for (const strip of this.strips) {
      si++;
      const stripIndex = this.strips.filter((s) => s.side === strip.side).indexOf(strip);
      this.slots.forEach((slot, k) => {
        const roll = hash2(k, si * 13 + stripIndex, this.leg.seed);
        const kind: Lot['kind'] = roll < 0.74 ? 'building' : 'open';
        const lot: Lot = { x0: strip.x0, x1: strip.x1, z0: slot.z0, z1: slot.z1, side: strip.side, strip: stripIndex, slot: k, kind };
        this.lots.push(lot);
        this.indexLot(lot);
      });
    }
  }

  // ---------------------------------------------------------------- planned city

  /**
   * The same skeleton as `buildCityGrid` (blocks, strips, passages, lots) read off an authored plan instead of dice,
   * then the paved streets and the landmarks that make the plan a particular place.
   */
  private buildPlannedGrid(plan: CityPlan) {
    this.plan = plan;
    let z = plan.startZ;
    for (const b of plan.blocks) {
      this.slots.push({ z0: z, z1: z + b.len, cross: b.cross, street: b.street });
      z += b.len + b.cross;
    }
    for (const side of [-1, 1] as const) {
      let x = BOULEVARD_HALF + SIDEWALK;
      for (const st of plan.sides[String(side) as '-1' | '1']) {
        const x1 = x + st.w;
        this.strips.push({ x0: side === 1 ? x : -x1, x1: side === 1 ? x1 : -x, side });
        x = x1;
        if (st.gap > 0) {
          this.passages.push({ x0: side === 1 ? x : -(x + st.gap), x1: side === 1 ? x + st.gap : -x, width: st.gap, side, street: st.street });
          x += st.gap;
        }
      }
    }
    let si = 0;
    for (const strip of this.strips) {
      si++;
      const stripIndex = this.strips.filter((q) => q.side === strip.side).indexOf(strip);
      this.slots.forEach((slot, k) => {
        const o = plan.lots.find((l) => l.side === strip.side && l.strip === stripIndex && l.block === k);
        const roll = hash2(k, si * 13 + stripIndex, this.leg.seed);
        const lot: Lot = {
          x0: strip.x0,
          x1: strip.x1,
          z0: slot.z0,
          z1: slot.z1,
          side: strip.side,
          strip: stripIndex,
          slot: k,
          kind: o?.kind ?? (roll < plan.buildingShare ? 'building' : 'open'),
        };
        if (lot.kind === 'building') {
          const [lo, hi] = stripIndex === 0 ? plan.floors.near : plan.floors.far;
          lot.floors = lo + Math.floor(hash2(k * 3 + 1, si * 7 + stripIndex, this.leg.seed + 5) * (hi - lo + 1));
        }
        if (o) {
          if (o.floors !== undefined) lot.floors = o.floors;
          lot.style = o.style;
          lot.tint = o.tint;
          lot.landmark = o.landmark;
          lot.shop = o.shop;
          lot.fixed = !!(o.landmark || o.shop);
        }
        this.lots.push(lot);
        this.indexLot(lot);
      });
    }
    this.layOutStreets(plan);
    this.dressLandmarks(plan);
    this.terrain.streets = this.streets.filter((q) => (q.kind === 'asphalt' || q.kind === 'tarmac') && !q.silent).map(({ x0, x1, z0, z1 }) => ({ x0, x1, z0, z1 }));
  }

  /** Paved cross streets and side streets, plus the named places the HUD announces. */
  private layOutStreets(plan: CityPlan) {
    const add = (kind: PlannedStreet['kind'], x0: number, x1: number, z0: number, z1: number, street?: string, silent?: boolean) =>
      this.streets.push({ id: `${plan.id}:st${this.streets.length}`, kind, x0, x1, z0, z1, street, silent });
    const outW = Math.max(...this.strips.filter((q) => q.side === -1).map((q) => -q.x0));
    const outE = Math.max(...this.strips.filter((q) => q.side === 1).map((q) => q.x1));
    const zFirst = this.slots[0].z0;
    const zLast = this.slots[this.slots.length - 1].z1;
    // The spine is drawn by the road mesh; it is only here so that driving up it names the street.
    add('asphalt', -BOULEVARD_HALF, BOULEVARD_HALF, zFirst, zLast, plan.spine, true);
    for (const slot of this.slots) {
      if (slot.cross < 5) continue;
      const zA = slot.z1;
      const zB = slot.z1 + slot.cross;
      add('asphalt', -outW, -BOULEVARD_HALF, zA, zB, slot.street);
      add('asphalt', BOULEVARD_HALF, outE, zA, zB, slot.street);
      add('asphalt', -BOULEVARD_HALF, BOULEVARD_HALF, zA, zB, slot.street, true);
    }
    for (const p of this.passages) {
      if (p.width < 5) continue;
      for (const slot of this.slots) add('asphalt', p.x0, p.x1, slot.z0, slot.z1, p.street);
    }
    for (const pl of plan.places) {
      const lot = this.lots.find((l) => l.side === pl.side && l.strip === pl.strip && l.slot === pl.block);
      if (!lot) continue;
      this.places.push({ id: pl.id, name: pl.name, sub: pl.sub, x: (lot.x0 + lot.x1) / 2, z: (lot.z0 + lot.z1) / 2, r: pl.r });
    }
  }

  private pave(kind: 'paving' | 'lawn' | 'tarmac', x0: number, x1: number, z0: number, z1: number) {
    this.streets.push({ id: `${this.plan?.id ?? 'plan'}:pv${this.streets.length}`, kind, x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0, z1 });
  }

  private plainProp(kind: PropKind, x: number, z: number, yaw: number, scale = 1, seed = 1, tag?: number) {
    this.props.push({ kind, x, y: 0, z, yaw, scale, seed, tag });
  }

  /** Landmark footprints, forecourts, and everything standing in them. */
  private dressLandmarks(plan: CityPlan) {
    const rng = new Rng(this.leg.seed ^ 0x7e11);
    const faceYaw = (dx: number, dz: number) => Math.atan2(dx, dz);
    const ground = (id: string, kind: PickupKind, amount: number, x: number, z: number) => this.pickups.push({ id: this.id(id), kind, amount, x, z, y: 0 });
    const lamp = (x: number, z: number, towardX: number) => this.plainProp('streetlight', x, z, x < towardX ? 0 : Math.PI, 1, 1 + this.props.length);
    let cluster = 6100;

    for (const lot of this.lots) {
      if (!lot.landmark) continue;
      const o = plan.lots.find((l) => l.side === lot.side && l.strip === lot.strip && l.block === lot.slot);
      const out = lot.side;
      const spineEdge = out === 1 ? lot.x0 : lot.x1;
      const cx = (lot.x0 + lot.x1) / 2;
      const cz = (lot.z0 + lot.z1) / 2;
      const depth = lot.x1 - lot.x0;
      /** x at distance d from the spine edge of the lot, going away from the spine. */
      const xAt = (d: number) => spineEdge + out * d;

      // The buildings, when the landmark does not fill its lot.
      for (const bd of o?.buildings ?? []) {
        this.landmarks.push({
          aabb: { id: newAabbId(), minX: lot.x0 + bd.rect[0], maxX: lot.x0 + bd.rect[1], minZ: lot.z0 + bd.rect[2], maxZ: lot.z0 + bd.rect[3], y0: 0, y1: bd.floors * 3.3, kind: 'building', hp: 99999, tint: 0 },
          role: bd.role,
          floors: bd.floors,
          style: bd.style,
          tint: bd.tint,
          front: bd.front,
        });
      }

      switch (lot.landmark) {
        case 'foundersSquare': {
          // Two levels, as the real square has: the paved street level beside Haim Ozer and a raised lawn behind it,
          // with the fountain where the first well was dug and five plaques for the founders.
          this.pave('paving', lot.x0, lot.x1, lot.z0, lot.z1);
          const fx = xAt(9);
          this.pave('lawn', xAt(18), xAt(depth - 3), lot.z0 + 6, lot.z1 - 6);
          this.plainProp('fountain', fx, cz, 0, 1, 1);
          // An invisible solid: the fountain prop draws the basin.
          const r = 3.4;
          this.aabbs.push({ id: newAabbId(), minX: fx - r, maxX: fx + r, minZ: cz - r, maxZ: cz + r, y0: 0, y1: 0.95, kind: 'pillar', hp: 9999 });
          for (let i = 0; i < 5; i++) this.plainProp('plaque', xAt(16.6), cz + (i - 2) * 8.2, faceYaw(-out, 0), 1, i + 1);
          for (let k = 0; k < 4; k++) {
            const a = Math.PI / 4 + (k * Math.PI) / 2;
            const bx = fx + Math.cos(a) * 6;
            const bz = cz + Math.sin(a) * 6;
            this.plainProp('bench', bx, bz, faceYaw(fx - bx, cz - bz), 1, k + 1);
          }
          const trees: [number, number][] = [[22, -21], [28, -12], [34, -5], [25, 9], [31, 15], [36, 22]];
          trees.forEach(([d, dz], i) => this.plainProp('deadTree', xAt(Math.min(d, depth - 3)), cz + dz, rng.range(0, 6), rng.range(0.8, 1.2), i + 3));
          const half = (lot.z1 - lot.z0) / 2 - 3;
          for (const dz of [-half, half]) {
            lamp(xAt(1.4), cz + dz, cx);
            lamp(xAt(depth - 1.4), cz + dz, cx);
          }
          for (let i = 0; i < 3; i++) this.plainProp('rubble', xAt(rng.range(4, depth - 4)), cz + rng.range(-24, 24), rng.range(0, 6), 1, rng.int(0, 99));
          ground('sq', 'scrap', 12, fx + 4.2, cz - 2.5);
          ground('sq', 'scrap', 9, fx - 4.5, cz + 3.5);
          ground('sq', 'rations', 1, xAt(20), cz + 6);
          ground('sq', 'medicine', 1, xAt(24), cz - 7);
          ground('sq', 'fuel', 5, xAt(depth - 4), lot.z0 + 5);
          // The square is where everyone went, and some of them are still there.
          pushZombies(this, rng, fx, cz, 9, ['walker', 'walker', 'walker', 'runner'], 11, true, cluster++);
          pushZombies(this, rng, xAt(26), cz, 1, ['brute'], 2, true, cluster++);
          pushZombies(this, rng, xAt(22), cz - 14, 1, ['screamer'], 2, true, cluster++);
          break;
        }
        case 'greatSynagogue': {
          // The forecourt between Hovevei Zion Street and the front steps.
          this.pave('paving', lot.x0, lot.x1, lot.z0, lot.z1);
          for (const dz of [-1, 1]) {
            lamp(xAt(1.5), cz + dz * 26, cx);
            this.plainProp('deadTree', xAt(3.2), cz + dz * 13, rng.range(0, 6), 1, 2 + dz);
          }
          this.plainProp('bench', xAt(2.6), cz + 6, faceYaw(out, 0), 1, 1);
          this.plainProp('bench', xAt(2.6), cz - 6, faceYaw(out, 0), 1, 2);
          ground('sy', 'oil', OIL_CAN, xAt(4), lot.z0 + 3);
          break;
        }
        case 'cityHall': {
          // The car park the three buildings enclose, open to the street: tarmac, two back-to-back rows of painted bays,
          // and the cars nobody came back for. The wing and the tower sit against the far edge of the lot.
          const lx = lot.x0 + 11;
          this.pave('tarmac', lx, lot.x1, lot.z0 + 11, lot.z1);
          const zBay = lot.z0 + 14;
          for (const [row, x0] of [[0, lx + 0.5], [1, lx + 5.5]] as const) {
            for (let k = 0; k < 3; k++) this.plainProp('parkBays', x0, zBay + 6.5 + k * 13, Math.PI / 2, 1, 1);
            for (let i = 0; i < 15; i++) {
              if (!rng.chance(0.4)) continue;
              const carSeed = rng.int(0, 9999);
              const jitter = rng.range(-0.25, 0.25);
              this.addCar(x0 + 2.5 + rng.range(-0.3, 0.3), zBay + 1.3 + i * 2.6, (row === 0 ? -Math.PI / 2 : Math.PI / 2) + jitter * 0.1, carSeed, carSeed % 3 === 0 ? { status: 'hulk' } : {});
            }
          }
          lamp(lot.x1 - 1.4, lot.z0 + 14, lx);
          lamp(lot.x1 - 1.4, lot.z1 - 3, lx);
          ground('ch', 'tech', 2, lx + 2, lot.z0 + 40);
          ground('ch', 'scrap', 14, lx + 3, lot.z0 + 22);
          ground('ch', 'medicine', 1, lx + 1.5, lot.z0 + 30);
          // The staff who never went home.
          pushZombies(this, rng, lx + 6, lot.z0 + 38, 6, ['walker', 'walker', 'runner'], 8, true, cluster++);
          pushZombies(this, rng, lx + 3, lot.z0 + 50, 1, ['screamer'], 2, true, cluster++);
          break;
        }
      }
    }
    // Shopfronts with a drawn sign: tables and chairs out on the sidewalk, and something to eat inside.
    for (const lot of this.lots) {
      if (!lot.shop) continue;
      const out = lot.side;
      const cz = (lot.z0 + lot.z1) / 2;
      for (const dz of [-5, 0.5, 6]) {
        this.plainProp('cafeTable', out * 8.75, cz + dz, 0, 1, 1);
        this.plainProp('cafeChair', out * 7.85, cz + dz + 0.1, Math.PI / 2, 1, 1 + Math.round(dz));
        this.plainProp('cafeChair', out * 9.65, cz + dz - 0.1, -Math.PI / 2, 1, 2 + Math.round(dz));
      }
      ground('sh', 'rations', 2, out * 9.1, cz - 2.5);
      ground('sh', 'rations', 1, out * 9.1, cz + 3);
    }
  }

  private indexLot(lot: Lot) {
    for (let gz = Math.floor(lot.z0 / 16); gz <= Math.floor(lot.z1 / 16); gz++) {
      const key = gz;
      let arr = this.lotGrid.get(key);
      if (!arr) this.lotGrid.set(key, (arr = []));
      arr.push(lot);
    }
  }

  /** True if a point (with radius) falls inside a solid building lot or an authored obstacle. */
  blockedAt(x: number, z: number, r: number): boolean {
    if (this.leg.biome === 'city') {
      const arr = this.lotGrid.get(Math.floor(z / 16));
      if (arr) {
        for (const l of arr) {
          if (l.kind !== 'building') continue;
          if (x > l.x0 - r && x < l.x1 + r && z > l.z0 - r && z < l.z1 + r) return true;
        }
      }
    }
    for (const lm of this.landmarks) {
      const a = lm.aabb;
      if (x > a.minX - r && x < a.maxX + r && z > a.minZ - r && z < a.maxZ + r) return true;
    }
    for (const a of this.aabbs) {
      if (x > a.minX - r && x < a.maxX + r && z > a.minZ - r && z < a.maxZ + r) return true;
    }
    for (const c of this.cars) {
      if (Math.abs(c.z - z) > 3.2 + r) continue;
      if (Math.hypot(c.x - x, c.z - z) < 1.7 + r) return true;
    }
    return false;
  }

  slotNear(z: number): Slot {
    let best = this.slots[0];
    let bd = Infinity;
    for (const s of this.slots) {
      const c = (s.z0 + s.z1) / 2;
      const d = Math.abs(c - z);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }

  private id(prefix: string) {
    return `${this.leg.id}:${prefix}${this.pid++}`;
  }

  // ---------------------------------------------------------------- authored set pieces

  private place(s: SetPiece) {
    const T = this.terrain;
    const rng = this.rng;
    const rxAt = (z: number) => roadX(T, z);
    const city = this.leg.biome === 'city';
    switch (s.type) {
      case 'tip':
        this.tips.push({ id: this.id('tip'), tip: String(s.id), z: s.at });
        break;
      case 'fuelCache': {
        const n = (s.count as number) ?? 2;
        for (let i = 0; i < n; i++) {
          const z = s.at + i * 14 + rng.range(-5, 5);
          const side = rng.sign();
          const x = rxAt(z) + side * rng.range(city ? 8 : 6, city ? 12 : 14);
          this.pickups.push({ id: this.id('f'), kind: 'fuel', amount: 5, x, z, y: heightAt(T, x, z) });
        }
        const wx = rxAt(s.at) + rng.sign() * 9;
        this.addCar(wx, s.at, rng.range(0, 6), rng.int(0, 9999));
        break;
      }
      case 'scrapPile': {
        const n = (s.count as number) ?? 3;
        for (let i = 0; i < n; i++) {
          const z = s.at + i * 18 + rng.range(-8, 8);
          const x = rxAt(z) + rng.sign() * rng.range(9, 28);
          const y = heightAt(T, x, z);
          this.pickups.push({ id: this.id('s'), kind: 'scrap', amount: rng.int(14, 22), x, z, y });
          this.props.push({ kind: 'tires', x: x + 1.2, y, z: z + 0.8, yaw: rng.range(0, 6), scale: 1, seed: rng.int(0, 9999) });
        }
        break;
      }
      case 'partsWreck': {
        const n = (s.count as number) ?? 3;
        for (let i = 0; i < n; i++) {
          const z = s.at + i * 22 + rng.range(-8, 8);
          const x = rxAt(z) + rng.sign() * rng.range(10, 34);
          const y = heightAt(T, x, z);
          const carSeed = rng.int(0, 9999);
          this.addCar(x, z, rng.range(0, 6), carSeed, carSeed % 5 < 3 ? { status: 'hulk' } : {});
          if (carSeed % 4 === 0) {
            const spec = rollPartSpec(new Rng(carSeed * 7 + 5), { minMk: 1, maxMk: 2 });
            this.pickups.push({ id: this.id('pp'), kind: 'part', amount: partDef(spec.id).mk, part: spec, x: x - 2.4, z: z - 1.6, y });
          }
          this.pickups.push({ id: this.id('p'), kind: 'parts', amount: rng.int(9, 14), x: x + 2.2, z: z + 1.4, y });
          if (rng.chance(0.3)) this.pickups.push({ id: this.id('t'), kind: 'tech', amount: rng.int(1, 3), x: x - 2, z: z + 1, y });
        }
        break;
      }
      case 'radioFragment': {
        const side = rng.sign();
        const x = rxAt(s.at) + side * (city ? 11 : 16);
        const y = heightAt(T, x, s.at);
        this.props.push({ kind: 'pylon', x, y, z: s.at, yaw: 0, scale: 1, seed: 1, tag: 3 });
        this.pickups.push({ id: this.id('r'), kind: 'fragment', amount: (s.n as number) ?? 1, x, z: s.at + 2, y });
        break;
      }
      case 'chassisWreck': {
        const side = rng.sign();
        const x = rxAt(s.at) + side * (city ? 12 : 15);
        const y = heightAt(T, x, s.at);
        this.props.push({ kind: 'tarp', x, y, z: s.at, yaw: rng.range(-0.5, 0.5), scale: 1, seed: 7, tag: 1 });
        this.pickups.push({ id: this.id('c'), kind: 'chassis', amount: 1, x, z: s.at + 3, y });
        break;
      }
      case 'ambush':
      case 'canyonAmbush': {
        const canyon = s.type === 'canyonAmbush';
        const z = s.at;
        const x = rxAt(z);
        this.ambushes.push({
          id: this.id('a'),
          x,
          z,
          buggies: (s.buggies as number) ?? 2,
          wagon: (s.wagon as number) ?? 0,
          triggerRadius: canyon ? 170 : 150,
          canyon,
        });
        if (canyon) {
          // A spike strip across the road marks the choke.
          this.props.push({ kind: 'chain', x, y: heightAt(T, x, z), z, yaw: 0, scale: 1, seed: 2 });
        }
        if (typeof s.tip === 'string') this.tips.push({ id: this.id('tip'), tip: s.tip, z: s.at - 260 });
        break;
      }
      case 'minefield': {
        const len = s.length as number;
        const z0 = s.at;
        // Cairns mark the edges. Mines are scattered with room for a moped to thread through.
        let id = 0;
        for (let z = z0; z <= z0 + len; z += 5.5) {
          for (let k = 0; k < 2; k++) {
            const x = rxAt(z) + rng.range(-14, 14);
            if (rng.chance(0.55)) this.mines.push({ x, z: z + rng.range(-1.5, 1.5), id: id++ });
          }
        }
        for (let z = z0 - 18; z <= z0 + len + 18; z += 26) {
          for (const sgn of [-1, 1]) {
            const x = rxAt(z) + sgn * 20;
            this.props.push({ kind: 'cairn', x, y: heightAt(T, x, z), z, yaw: rng.range(0, 6), scale: 1, seed: rng.int(0, 999) });
          }
        }
        break;
      }
      case 'rampCache': {
        const r = this.terrain.ramps.find((q) => q.z0 === s.at);
        if (r) {
          const xc = rxAt(r.z0 + r.len) + r.xOff;
          const cz = r.z0 + r.len + r.gap + r.plateauLen * 0.5;
          const cy = heightAt(T, xc, cz);
          this.props.push({ kind: 'crateStack', x: xc, y: cy, z: cz, yaw: 0, scale: 1.2, seed: 3, tag: 2 });
          this.pickups.push({ id: this.id('rc'), kind: 'scrap', amount: 34, x: xc - 1.5, z: cz, y: cy });
          this.pickups.push({ id: this.id('rc'), kind: 'parts', amount: 16, x: xc + 1.5, z: cz, y: cy });
          this.pickups.push({ id: this.id('rc'), kind: 'tech', amount: 4, x: xc, z: cz + 1.5, y: cy });
          this.props.push({ kind: 'sign', x: xc, y: heightAt(T, xc, r.z0 - 10), z: r.z0 - 10, yaw: 0, scale: 1, seed: 9, tag: 2 });
        }
        break;
      }
      case 'encounter': {
        const side = (s.side as number | undefined) ?? rng.sign();
        const x = rxAt(s.at) + side * (city ? 9.5 : 7.5);
        const y = heightAt(T, x, s.at);
        this.encounters.push({ id: this.id('e'), encounter: String(s.id), x, z: s.at });
        this.addCar(x + side * 2.5, s.at, 1.5, rng.int(0, 99) + 300);
        this.props.push({ kind: 'banner', x, y, z: s.at - 4, yaw: 0, scale: 1, seed: 1, tag: 4 });
        break;
      }
      case 'barricade': {
        const grade = (s.grade as 'flimsy' | 'reinforced') ?? 'flimsy';
        const slot = this.slotNear(s.at);
        const zc = (slot.z0 + slot.z1) / 2;
        this.barricades.push({ z: zc, grade });
        this.addBarricade(zc, grade);
        break;
      }
      case 'hordeStreet': {
        const z = s.at;
        const kinds: ZombieKind[] = ['walker', 'walker', 'runner'];
        for (let i = 0; i < 6; i++) pushZombies(this, rng, rxAt(z + i * 14) + rng.range(-3, 3), z + i * 14, rng.int(5, 8), kinds, 7, true, 1000 + (s.at as number) + i);
        pushZombies(this, rng, rxAt(z + 50), z + 50, 1, ['brute'], 2, true, 1099);
        pushZombies(this, rng, rxAt(z + 30), z + 30, 2, ['screamer'], 3, true, 1098);
        break;
      }
      case 'scavengeZone': {
        this.addZone(s);
        break;
      }
      default:
        break;
    }
  }

  private addBarricade(zc: number, grade: 'flimsy' | 'reinforced') {
    const T = this.terrain;
    const tint = grade === 'flimsy' ? 0 : 1;
    const t = 1.6; // slab thickness along z
    const span = (x0: number, x1: number) => {
      this.aabbs.push({
        id: newAabbId(),
        minX: x0,
        maxX: x1,
        minZ: zc - t / 2,
        maxZ: zc + t / 2,
        y0: 0,
        y1: grade === 'flimsy' ? 2.0 : 3.0,
        kind: 'barricade',
        breakable: grade,
        hp: grade === 'flimsy' ? 90 : 600,
        tint,
      });
    };
    if (T.biome === 'city') {
      span(-BOULEVARD_HALF - SIDEWALK, BOULEVARD_HALF + SIDEWALK);
      if (grade === 'reinforced') {
        // Welded steel also plugs every passage wide enough for a car. Only alleys stay open.
        for (const p of this.passages) {
          if (p.width >= 2.6 && Math.abs((p.x0 + p.x1) / 2) < 60) span(p.x0, p.x1);
        }
      } else {
        // Flimsy: just the boulevard and its service lanes.
        for (const p of this.passages) if (p.width >= 3.6 && Math.abs((p.x0 + p.x1) / 2) < 22 && Math.abs(p.x0) < 22) span(p.x0, p.x1);
      }
    } else {
      const rx = roadX(T, zc);
      span(rx - 14, rx + 14);
    }
  }

  private addZone(s: SetPiece) {
    const kind = (s.kind as 'pharmacy' | 'depot' | 'parking' | 'hospital') ?? 'depot';
    const side = ((s.side as number) ?? 1) as 1 | -1;
    const slot = this.slotNear(s.at);
    // Use the boulevard-facing strip lot in this slot as the zone footprint.
    const lot = this.lots.find((l) => l.slot === this.slots.indexOf(slot) && l.side === side && l.strip === 0);
    if (!lot || lot.fixed) return;
    lot.kind = 'zone';
    const w = lot.x1 - lot.x0;
    const d = lot.z1 - lot.z0;
    const cx = (lot.x0 + lot.x1) / 2;
    const cz = (lot.z0 + lot.z1) / 2;
    const rng = new Rng(this.leg.seed + Math.floor(s.at));
    const open = (side === 1 ? -1 : 1) as 1 | -1; // open face looks at the boulevard
    const zone: ScavZone = { id: this.id('z'), kind, x: cx, z: cz, w, d, open, containers: [] };
    const table: Record<'pharmacy' | 'depot' | 'parking' | 'hospital', (depth: number, r: Rng) => Partial<Stocks>> = {
      pharmacy: (d0, r) => ({ medicine: [1, 2, 3][d0] + (r.chance(0.3) ? 1 : 0), rations: d0 === 0 ? 1 : 0, tech: d0 === 2 && r.chance(0.5) ? 1 : 0 }),
      depot: (d0) => ({ scrap: [8, 14, 22][d0], parts: [2, 5, 9][d0], fuel: d0 === 2 ? 5 : 0 }),
      parking: (d0, r) => ({ parts: [4, 8, 14][d0], scrap: [4, 8, 12][d0], fuel: d0 === 1 && r.chance(0.6) ? 5 : 0, rations: d0 === 0 && r.chance(0.5) ? 1 : 0 }),
      hospital: (d0) => ({ medicine: [2, 4, 6][d0], tech: [1, 3, 5][d0], rations: d0 === 0 ? 2 : 0 }),
    };
    const nCont = 7 + rng.int(0, 2);
    for (let i = 0; i < nCont; i++) {
      const depth = (i < 2 ? 0 : i < 5 ? 1 : 2) as 0 | 1 | 2;
      // Depth runs from the open face inward along x.
      const frac = depth === 0 ? rng.range(0.1, 0.3) : depth === 1 ? rng.range(0.4, 0.6) : rng.range(0.7, 0.9);
      const px = side === 1 ? lot.x0 + frac * w : lot.x1 - frac * w;
      const pz = cz + rng.range(-0.38, 0.38) * d;
      zone.containers.push({ id: this.id('lc'), x: px, z: pz, depth, loot: table[kind](depth, rng), taken: false });
    }
    // Pharmacies and hospitals keep pills; depots keep a bottle or two somewhere.
    const dr = new Rng(this.leg.seed * 977 + Math.floor(s.at) + 5);
    for (const c of zone.containers) {
      const give = (id: DrugId, p: number, n = 1) => {
        if (dr.chance(p)) c.drugs = { ...c.drugs, [id]: (c.drugs?.[id] ?? 0) + n };
      };
      if (kind === 'pharmacy' || kind === 'hospital') {
        give('painkiller', 0.4, c.depth === 0 ? 1 : 2);
        if (c.depth >= 1) give('stim', 0.3);
        if (c.depth === 2) give('adrenaline', 0.4);
      } else if (kind === 'depot' && c.depth >= 1) give('alcohol', 0.35, 2);
    }
    this.zones.push(zone);
    // Ruined walls on three sides (back and two flanks). The open face looks at the boulevard.
    const th = 0.6;
    const hgt = 4.2;
    const backX = side === 1 ? lot.x1 - th / 2 : lot.x0 + th / 2;
    const wall = (minX: number, maxX: number, minZ: number, maxZ: number, y1 = hgt) =>
      this.aabbs.push({ id: newAabbId(), minX, maxX, minZ, maxZ, y0: 0, y1, kind: 'wall', hp: 9999, tint: 2 });
    wall(backX - th / 2, backX + th / 2, lot.z0, lot.z1);
    // Flanks leave a gap so a person can slip in from the side streets.
    wall(lot.x0, lot.x1, lot.z0, lot.z0 + th);
    wall(lot.x0, lot.x1, lot.z1 - th, lot.z1);
    // A sign and a few shelves set the scene.
    const sx = side === 1 ? lot.x0 + 1 : lot.x1 - 1;
    this.props.push({ kind: 'sign', x: sx, y: 0, z: lot.z0 + 2, yaw: 0, scale: 1.3, seed: 1, tag: kind === 'pharmacy' ? 6 : kind === 'hospital' ? 7 : 5 });
    for (const c of zone.containers) {
      this.props.push({ kind: kind === 'pharmacy' || kind === 'hospital' ? 'shelf' : 'locker', x: c.x, y: 0, z: c.z, yaw: side === 1 ? Math.PI / 2 : -Math.PI / 2, scale: 1, seed: c.depth, tag: c.depth });
    }
    // Zombies lurk deeper in.
    const zr = new Rng(this.leg.seed * 31 + Math.floor(s.at));
    const kinds: ZombieKind[] = ['walker', 'walker', 'runner'];
    pushZombies(this, zr, cx, cz, 3 + this.leg.index, kinds, Math.min(w, d) * 0.4, true, 2000 + Math.floor(s.at));
    if (kind === 'hospital') {
      pushZombies(this, zr, cx, cz, 1, ['brute'], 3, true, 2999);
      pushZombies(this, zr, cx, cz, 1, ['bloater'], 3, true, 2998);
    }
  }

  // ---------------------------------------------------------------- roadside places

  /** A car by the road: a real vehicle once the convoy gets near. `seed` fixes its make and condition. */
  private addCar(x: number, z: number, yaw: number, seed: number, o: Partial<CarSpawn> = {}) {
    this.cars.push({ id: this.id('car'), x, y: heightAt(this.terrain, x, z), z, yaw, seed: seed * 131 + this.cars.length * 7 + 11, ...o });
  }

  private mergeSite(c: SiteContent) {
    for (const car of c.cars) this.cars.push({ id: this.id('car'), ...car, seed: car.seed * 131 + this.cars.length * 7 + 11 });
    this.rural.push(...c.buildings);
    this.aabbs.push(...c.aabbs);
    this.props.push(...c.props);
    this.zones.push(...c.zones);
    for (const p of c.pickups) this.pickups.push({ id: this.id('sp'), kind: p.kind, amount: p.amount, part: p.part, x: p.x, y: p.y, z: p.z });
    for (const z of c.zombies) pushZombies(this, this.rng, z.x, z.z, z.n, z.kinds, z.spread, true, 4000 + this.pid, z.spread < 3 ? 0.4 : 0.8);
  }

  private buildSites() {
    const ctx = { def: this.terrain, newId: newAabbId };
    this.delves = [...this.terrain.delves];
    for (const site of this.terrain.sites) if (!isLakeSite(site)) this.mergeSite(buildSite(ctx, site));
    this.mergeSite(buildRoadside(ctx, this.leg));
  }

  /**
   * Lakes: first clear away anything the scatter or the roadside pass dropped into the water or onto its banks, then
   * build the lake places (pier, boathouse, islands), which are allowed to stand there.
   */
  private buildLakes() {
    const lakes = this.terrain.lakes;
    if (!lakes.length) return;
    const wet = (x: number, z: number) => !!lakeAt(lakes, x, z, 1.25);
    this.props = this.props.filter((p) => !wet(p.x, p.z));
    this.pickups = this.pickups.filter((p) => !wet(p.x, p.z));
    this.zombies = this.zombies.filter((z) => !wet(z.x, z.z));
    this.aabbs = this.aabbs.filter((a) => !wet((a.minX + a.maxX) / 2, (a.minZ + a.maxZ) / 2));
    this.rural = this.rural.filter((b) => !wet((b.aabb.minX + b.aabb.maxX) / 2, (b.aabb.minZ + b.aabb.maxZ) / 2));
    const ctx = { def: this.terrain, newId: newAabbId };
    for (const site of this.terrain.sites) if (isLakeSite(site)) this.mergeSite(buildSite(ctx, site));
  }

  // ---------------------------------------------------------------- ambient content

  /**
   * Stalled traffic: every few hundred metres a string of cars is pulled over on the shoulder, as if a convoy
   * broke down together. Each is a real car, so a jam is a good place to pick through for parts or a ride.
   */
  private roadsideJams() {
    const rng = new Rng(this.leg.seed ^ 0xca75);
    const T = this.terrain;
    const free = keepOutZ(T, this.leg);
    const inSite = (x: number, z: number) => T.sites.some((s) => s.radius > 0 && Math.hypot(x - s.x, z - s.z) < s.radius + 8);
    for (let z0 = rng.range(300, 520); z0 < this.leg.length - 150; z0 += rng.range(420, 700)) {
      const n = rng.int(3, 6);
      let z = z0;
      const side0 = rng.sign();
      for (let i = 0; i < n; i++) {
        z += rng.range(9, 19);
        if (!free(z)) continue;
        const side = rng.chance(0.3) ? -side0 : side0;
        const x = roadX(T, z) + side * rng.range(5.8, 8.6);
        if (inSite(x, z)) continue;
        const along = Math.atan2(roadSlope(T, z), 1);
        const yaw = along + (rng.chance(0.5) ? 0 : Math.PI) + (rng.chance(0.25) ? rng.range(-0.9, 0.9) : rng.range(-0.1, 0.1));
        this.addCar(x, z, yaw, rng.int(0, 9999));
      }
    }
  }

  private wastelandAmbient() {
    const rng = new Rng(this.leg.seed ^ 0xa11);
    const T = this.terrain;
    for (let z = 20; z < this.leg.length + 150; z += 11) {
      const rx = roadX(T, z);
      if (rng.chance(0.55)) {
        const x = rx + rng.sign() * rng.range(7, 120);
        const y = heightAt(T, x, z);
        const big = rng.chance(0.12);
        this.props.push({ kind: 'rock', x, y, z: z + rng.range(-5, 5), yaw: rng.range(0, 6.28), scale: big ? rng.range(2.4, 4.2) : rng.range(0.6, 1.6), seed: rng.int(0, 9999) });
        if (big) {
          const r = 1.4 * 3;
          this.aabbs.push({ id: newAabbId(), minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r, y0: y - 1, y1: y + 4, kind: 'rock', hp: 9999 });
        }
      }
      if (rng.chance(0.12)) {
        const x = rx + rng.sign() * rng.range(8, 90);
        this.props.push({ kind: 'deadTree', x, y: heightAt(T, x, z), z, yaw: rng.range(0, 6.28), scale: rng.range(0.8, 1.5), seed: rng.int(0, 99) });
      }
      if (rng.chance(0.05)) {
        const x = rx + rng.sign() * rng.range(8, 70);
        this.props.push({ kind: 'bones', x, y: heightAt(T, x, z), z, yaw: rng.range(0, 6.28), scale: 1, seed: rng.int(0, 99) });
      }
      // Scrap shards on the roadside: low value, keeps the road rewarding to explore.
      if (rng.chance(0.09)) {
        const x = rx + rng.sign() * rng.range(7, 40);
        const y = heightAt(T, x, z);
        this.pickups.push({ id: this.id('rs'), kind: 'scrap', amount: rng.int(4, 8), x, z, y });
      }
      if (rng.chance(0.015)) {
        const x = rx + rng.sign() * rng.range(8, 36);
        this.pickups.push({ id: this.id('rf'), kind: 'fuel', amount: 5, x, z, y: heightAt(T, x, z) });
      }
    }
    // Roadside poles along the road.
    for (let z = 30; z < this.leg.length + 100; z += 60) {
      const x = roadX(T, z) + (Math.floor(z / 60) % 2 ? 6 : -6);
      this.props.push({ kind: 'pole', x, y: heightAt(T, x, z), z, yaw: rng.range(-0.1, 0.1), scale: 1, seed: 1 });
    }
    // A handful of wandering dead.
    for (let z = 300; z < this.leg.length; z += 340) {
      const rx = roadX(T, z);
      pushZombies(this, rng, rx + rng.range(-30, 30), z, rng.int(2, 4), ['walker'], 8, false, 3000 + z);
    }
  }

  /**
   * One metro station in the middle of the leg: a headhouse standing in a boulevard-front lot (a building lot is
   * cleared for it if no open one is near) and the delve down the stairs inside it.
   */
  private buildMetro() {
    const leg = this.leg;
    const rng = new Rng(leg.seed * 53 + 17);
    const target = leg.length * rng.range(0.42, 0.55);
    const fits = (l: Lot) =>
      l.strip === 0 &&
      !l.fixed &&
      l.kind !== 'zone' &&
      l.z1 - l.z0 >= 28 &&
      l.z0 > 240 &&
      l.z1 < leg.length - 240 &&
      !this.barricades.some((b) => b.z > l.z0 - 18 && b.z < l.z1 + 18) &&
      !this.zones.some((q) => Math.abs(q.z - (l.z0 + l.z1) / 2) < 40);
    let lot: Lot | null = null;
    for (const l of this.lots) if (fits(l) && (!lot || Math.abs((l.z0 + l.z1) / 2 - target) < Math.abs((lot.z0 + lot.z1) / 2 - target))) lot = l;
    if (!lot) return;
    lot.kind = 'open';
    const side = lot.side;
    const zc = (lot.z0 + lot.z1) / 2;
    // The mouth is on the sidewalk, facing the boulevard; the headhouse stands back in the lot.
    const x = side > 0 ? lot.x0 - 2 : lot.x1 + 2;
    const seed = rng.int(1, 99999);
    const delve: DelveSite = { id: `${leg.id}:d0`, theme: 'metro', x, z: zc, yaw: side > 0 ? -Math.PI / 2 : Math.PI / 2, seed, name: delveName('metro', seed), tier: Math.min(3, leg.index), island: false };
    this.terrain.delves.push(delve);
    this.delves.push(delve);
    // Whatever the street dressing dropped in its footprint goes.
    const x0 = side > 0 ? 6.5 : -17.5;
    const x1 = side > 0 ? 17.5 : -6.5;
    const inside = (px: number, pz: number) => px > x0 && px < x1 && Math.abs(pz - zc) < 7;
    this.props = this.props.filter((p) => !inside(p.x, p.z));
    this.pickups = this.pickups.filter((p) => !inside(p.x, p.z));
    const site: Site = { kind: delveSiteKind('metro'), z: zc, side, off: 0, radius: 0, seed, x, delve: delve.id };
    this.mergeSite(buildSite({ def: this.terrain, newId: newAabbId }, site));
  }

  private cityAmbient() {
    const rng = new Rng(this.leg.seed ^ 0xc17);
    const kinds: ZombieKind[] = ['walker', 'walker', 'walker', 'runner'];
    const index = this.leg.index;
    // Stalled cars along the boulevard form a slalom.
    for (let z = 30; z < this.leg.length + 120; z += 19) {
      if (rng.chance(0.45)) {
        const x = rng.range(-5.2, 5.2);
        const yaw = rng.range(-0.6, 0.6) + (rng.chance(0.5) ? Math.PI : 0);
        this.addCar(x, z, yaw, rng.int(0, 9999), { y: 0 });
      }
      if (rng.chance(0.2)) {
        const x = rng.sign() * (BOULEVARD_HALF + 1.6);
        this.props.push({ kind: 'streetlight', x, y: 0, z, yaw: x > 0 ? Math.PI : 0, scale: 1, seed: 1 });
      }
    }
    // Dormant clusters.
    let cluster = 5000;
    for (let z = 90; z < this.leg.length + 20; z += rng.range(36, 70)) {
      if (this.zones.some((q) => Math.abs(q.z - z) < 30)) continue;
      const x = rng.range(-6, 6) + (rng.chance(0.4) ? rng.sign() * rng.range(12, 40) : 0);
      const n = rng.int(3, 6) + index;
      pushZombies(this, rng, x, z, n, kinds, 6, true, cluster++);
      if (rng.chance(0.15 + index * 0.05)) pushZombies(this, rng, x, z, 1, ['screamer'], 3, true, cluster);
      if (rng.chance(0.12 + index * 0.04)) pushZombies(this, rng, x + 8, z, 1, ['bloater'], 3, true, cluster);
      if (rng.chance(0.08 + index * 0.03)) pushZombies(this, rng, x - 8, z, 1, ['brute'], 3, true, cluster);
      if (index >= 2 && rng.chance(0.15)) pushZombies(this, rng, x, z + 10, 1, ['stalker'], 2, false, cluster);
    }
    // Wanderers shuffling in the open.
    for (let z = 140; z < this.leg.length; z += 90) {
      pushZombies(this, rng, rng.range(-6, 6), z, rng.int(2, 3), kinds, 5, false, cluster++);
    }
    // Loose city loot on the sidewalks.
    for (let z = 40; z < this.leg.length; z += 33) {
      if (!rng.chance(0.5)) continue;
      const x = rng.sign() * rng.range(8, 11);
      const kind: PickupKind = rng.pick(['scrap', 'scrap', 'parts', 'rations', 'medicine']);
      const amount = kind === 'scrap' ? rng.int(5, 10) : kind === 'parts' ? rng.int(3, 6) : 1;
      this.pickups.push({ id: this.id('cl'), kind, amount, x, z, y: 0 });
    }
    // A few dumpsters and debris piles.
    for (let z = 25; z < this.leg.length + 60; z += 41) {
      const x = rng.sign() * rng.range(7.5, 9.5);
      this.props.push({ kind: rng.pick(['dumpster', 'rubble', 'barrel']), x, y: 0, z, yaw: rng.range(0, 6), scale: 1, seed: rng.int(0, 99) });
    }
    // Fuel and rations are rare in cities; a couple of canisters sit in side streets.
    for (let z = 200; z < this.leg.length; z += 380) {
      this.pickups.push({ id: this.id('cf'), kind: 'fuel', amount: 5, x: rng.sign() * rng.range(8, 10), z, y: 0 });
    }
  }
}

export function chunkKey(cx: number, cz: number) {
  return cx * 4096 + cz;
}
