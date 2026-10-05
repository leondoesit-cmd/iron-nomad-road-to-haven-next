import { legById, type LegDef, type SetPiece, type ZombieKind } from '../data';
import type { DrugId } from '../sim/drugs';
import { HOST_PROPS, pickupOf, rollItem, rollLoot, specFoot, type ItemSize, type LootContext, type LootSpec, type LootTag } from '../sim/loot';
import type { CarGrade } from '../sim/cars';
import { Rng, hash2 } from '../core/rng';
import { makeTerrainDef, roadX, heightAt, roadSlope, keepOutZ, waterAt, type Site, type TerrainDef } from './terrain';
import { SiteBuilder, buildRoadside, buildSite, type RuralBuilding, type SiteContent } from './settlements';
import { isLakeSite, lakeAt } from './lakes';
import { delveName, delveSiteKind, type DelveSite } from './delveSites';
import { planById } from './plans';
import { districtAt, nearestRoad, type District } from './openWorld';
import { GANGS } from '../data';
import { dressGangCamp, fitSpot, newCampSpec, planFreeCamps, type GangCampSpec } from './gangCamps';
import type { BuildingRole, CityPlan, Facing, LandmarkKind, PlannedPlace, PlannedStreet } from './cityPlan';
import type { Look } from './interiors';

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
  /** What it is made of, when the kind alone does not say: decides what a bullet can punch through. */
  mat?: import('../sim/ballistics').Surface;
  /** A wall piece of a building: the index of its wall in the building's plan, so a breach can find its siblings. */
  wall?: number;
  /** A pane of glass (with `mat: 'glass'`): the kind it is, which decides how much it takes. */
  pane?: import('../sim/glass').GlassKind;
  /** A pane that is not part of a building's plan (a shopfront): the way it faces, as (x, z) of its outward normal. */
  paneN?: [number, number];
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
  | 'cafeChair'
  | 'tram'
  | 'bus'
  | 'busShelter'
  | 'floodlight'
  | 'tent'
  | 'campfire';

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

/** What a drawn sign looks like: the bus station's green board, the light rail's red one, the stadium's, a shop's. */
export type SignTheme = 'bus' | 'rail' | 'stadium' | 'shop' | 'bank' | 'pharmacy' | 'cafe' | 'market';

/** A flat panel with a title (usually Hebrew) over a line of English, hung on a wall or canopy. `yaw` is the way it faces. */
export interface SignSpawn {
  x: number;
  y: number;
  z: number;
  yaw: number;
  w: number;
  h: number;
  text: string;
  sub?: string;
  theme: SignTheme;
}

/**
 * What a loose thing in the world is. Every kind is a specific, named object: there is no loose Scrap, Tech or "Parts" to
 * find (see `world/loot.ts`). `chassis` and `fragment` are the two story items, a bare frame and a radio board.
 */
export type PickupKind = 'fuel' | 'oil' | 'rations' | 'medicine' | 'medkit' | 'bandage' | 'ammo' | 'fragment' | 'chassis' | 'part' | 'paint' | 'water' | 'gear';

/** What lets a loose thing lie where it does: the furniture it is on, or the thing it is beside. */
export interface PickupHost {
  /** A furniture kind ('workbench', 'shelf', 'rack', 'enginestand'...), a prop kind ('pump', 'tires', 'container'...), 'car', 'building', 'tarp'... */
  kind: string;
  /** `on`: lying on a surface of the host (inside a building, on its furniture). `beside`: on the ground within a few metres of it. */
  mode: 'on' | 'beside';
  /** The context the item was generated from (`LootContext`), for tests and for tuning. */
  context?: string;
}

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
  /** For kind 'gear': a gun (or add-on) on display, the `index`th of `rollGunLoot(context, seed, depth)`. It lies belly down on its rack or counter; taking it is remembered under this pickup's id. */
  gun?: { context: import('../sim/loot').GunStash['context']; seed: number; depth: 0 | 1 | 2; index: number };
  x: number;
  y: number;
  z: number;
  /** How it lies: a fixed heading and a natural tilt (a radiator leaned on a wall). It never moves or turns after that. Missing means a heading hashed from the id. */
  yaw?: number;
  tilt?: [number, number];
  /** Why it is here. Every item the world generates has one; items a player puts down do not. */
  host?: PickupHost;
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
  /** What the car's condition is rolled from (`sim/cars.ts`): where it stands says what shape it is in. Missing means an ordinary roadside car. */
  grade?: import('../sim/cars').CarGrade;
  /** How far from the start of the map, 0 to 1: better kit stays on cars the further out they are. */
  reach?: number;
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
  /** The named things inside (`world/loot.ts`). Searching hands them over; nothing abstract. */
  items: import('../sim/loot').LootSpec[];
  /** Guns in it, rolled from `rollGunLoot` when it is searched. */
  guns?: import('../sim/loot').GunStash;
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
  kind: 'pharmacy' | 'depot' | 'parking' | 'hospital' | 'house' | 'store' | 'motel' | 'barn' | 'warehouse' | 'shack' | 'garage' | 'dealership' | 'tyreshop' | 'police';
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
  /** A gang camp's id: the ambush is the camp's reinforcements, called out when its sentries raise the alarm. */
  camp?: string;
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
  /** Raider gang camps in the open world: banners, tents, a stash and sentries. */
  gangCamps: GangCampSpec[];
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
  gangCamps: GangCampSpec[] = [];
  encounters: EncounterSpot[] = [];
  tips: TipSpot[] = [];
  mines: MineSpawn[] = [];
  pickups: PickupSpawn[] = [];
  props: PropSpawn[] = [];
  signs: SignSpawn[] = [];
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
  /** What lies where gets its own stream: tuning the loot never shifts a street. */
  private lootRng: Rng;
  private pid = 0;

  constructor(leg: LegDef) {
    this.leg = leg;
    this.terrain = makeTerrainDef(leg);
    this.rng = new Rng(leg.seed * 7919 + 13);
    this.lootRng = new Rng((leg.seed ^ 0x100f77) >>> 0);
    if (leg.open) {
      this.buildOpen();
      return;
    }
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
      this.buildMetro();
      if (this.plan?.vernacular === 'israeli') this.shopSigns();
    } else {
      this.buildSites();
      const n0 = [this.props.length, this.pickups.length, this.aabbs.length];
      this.wastelandAmbient();
      this.roadsideJams();
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
    this.pickups = this.pickups.filter((p) => this.pickupOk(p));
    // Nor does a car: one that overlaps a wall is shoved out by the physics and lands tilted against it.
    this.cars = this.cars.filter((c) => !this.carClips(c));
  }

  /** A loose thing may lie on a surface inside a building (it is on furniture, which is a collider), or in clear ground; the two story items stand where they were put. */
  private pickupOk(p: PickupSpawn) {
    return p.host?.mode === 'on' || p.kind === 'fragment' || p.kind === 'chassis' || !this.blockedAt(p.x, p.z, 0.2);
  }

  /** Would a car placed here sink into a wall, a barricade or a building? Its length is sampled as three circles. */
  private carClips(c: CarSpawn): boolean {
    for (const o of [-1.8, 0, 1.8]) {
      const px = c.x + Math.sin(c.yaw) * o;
      const pz = c.z + Math.cos(c.yaw) * o;
      for (const a of this.aabbs) {
        if (a.kind === 'car' || a.kind === 'floor' || a.kind === 'stair' || a.kind === 'rock') continue;
        if (px > a.minX - 0.9 && px < a.maxX + 0.9 && pz > a.minZ - 0.9 && pz < a.maxZ + 0.9 && a.y1 > c.y + 0.3 && a.y0 < c.y + 1.5) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- the open world

  /**
   * The open-world leg: the wasteland machinery along the highway, content spread over the whole map, and each city
   * district built as its own city leg and dropped in at its place.
   */
  private buildOpen() {
    const leg = this.leg;
    const T = this.terrain;
    const o = T.open!;
    for (const s of leg.sets) this.place(s);
    this.end = { x: o.haven.x, z: o.haven.z, radius: o.haven.radius };
    this.start = { x: roadX(T, 12), z: 12, yaw: Math.atan2(roadSlope(T, 12), 1) };
    this.campSpots = [
      { x: this.end.x + 26, z: leg.length + 40 },
      { x: this.end.x - 26, z: leg.length + 40 },
    ];
    this.buildSites();
    this.raiderCamps();
    const n0 = [this.props.length, this.pickups.length, this.aabbs.length];
    this.wastelandAmbient();
    this.openAmbient();
    this.roadsideJams();
    this.sideRoadKit();
    // Nor does the scatter of rocks, cars and the dead stand in a gang camp.
    const inCamp = (x: number, z: number) => this.gangCamps.some((c) => Math.hypot(x - c.x, z - c.z) < c.radius + 6);
    const inSite = (x: number, z: number) => inCamp(x, z) || T.sites.some((s) => s.radius > 0 && Math.hypot(x - s.x, z - s.z) < s.radius * 0.95);
    this.props = this.props.filter((p, i) => i < n0[0] || !inSite(p.x, p.z));
    this.pickups = this.pickups.filter((p, i) => i < n0[1] || !inSite(p.x, p.z));
    this.aabbs = this.aabbs.filter((a, i) => i < n0[2] || !inSite((a.minX + a.maxX) / 2, (a.minZ + a.maxZ) / 2));
    this.zombies = this.zombies.filter((q) => !inCamp(q.x, q.z));
    this.buildLakes();
    this.cars = this.cars.filter((c) => !waterAt(T, c.x, c.z) && !inCamp(c.x, c.z));
    // Nothing of the desert stands inside a city.
    const outside = (x: number, z: number) => !districtAt(o, x, z);
    this.props = this.props.filter((p) => outside(p.x, p.z));
    this.pickups = this.pickups.filter((p) => outside(p.x, p.z));
    this.zombies = this.zombies.filter((q) => outside(q.x, q.z));
    this.cars = this.cars.filter((c) => outside(c.x, c.z));
    this.aabbs = this.aabbs.filter((a) => outside((a.minX + a.maxX) / 2, (a.minZ + a.maxZ) / 2));
    this.rural = this.rural.filter((b) => outside((b.aabb.minX + b.aabb.maxX) / 2, (b.aabb.minZ + b.aabb.maxZ) / 2));
    this.mines = this.mines.filter((m) => outside(m.x, m.z));
    for (const d of o.districts) this.absorbDistrict(d);
    this.zombies = this.zombies.filter((z) => !this.blockedAt(z.x, z.z, 0.3));
    this.pickups = this.pickups.filter((p) => this.pickupOk(p));
    this.cars = this.cars.filter((c) => !this.carClips(c));
  }

  /** Builds a district's city leg on its own, slides it north to its place, and merges it into this layout. */
  private absorbDistrict(d: District) {
    const sub = new LegLayoutImpl(legById(d.legId));
    sub.shiftZ(d.dz);
    this.plan = sub.plan;
    this.slots.push(...sub.slots);
    this.strips.push(...sub.strips);
    this.passages.push(...sub.passages);
    this.streets.push(...sub.streets);
    this.places.push(...sub.places);
    this.landmarks.push(...sub.landmarks);
    this.zones.push(...sub.zones);
    this.ambushes.push(...sub.ambushes);
    this.gangCamps.push(...sub.gangCamps);
    this.encounters.push(...sub.encounters);
    this.tips.push(...sub.tips);
    this.mines.push(...sub.mines);
    this.pickups.push(...sub.pickups);
    this.props.push(...sub.props);
    this.signs.push(...sub.signs);
    this.cars.push(...sub.cars);
    this.rural.push(...sub.rural);
    this.zombies.push(...sub.zombies);
    this.aabbs.push(...sub.aabbs);
    this.delves.push(...sub.delves);
    this.barricades.push(...sub.barricades);
    this.terrain.delves.push(...sub.terrain.delves);
    this.terrain.streets = [...(this.terrain.streets ?? []), ...(sub.terrain.streets ?? [])];
    for (const lot of sub.lots) {
      this.lots.push(lot);
      this.indexLot(lot);
    }
  }

  /** Slides everything in a built layout north by dz. Used once, on a city leg that is about to join the open world. */
  shiftZ(dz: number) {
    const seen = new Set<object>();
    const once = <T extends object>(o: T, fn: (o: T) => void) => {
      if (seen.has(o)) return;
      seen.add(o);
      fn(o);
    };
    for (const s of this.slots) s.z0 += dz, (s.z1 += dz);
    for (const l of this.lots) l.z0 += dz, (l.z1 += dz);
    for (const s of this.streets) s.z0 += dz, (s.z1 += dz);
    for (const p of this.places) p.z += dz;
    for (const lm of this.landmarks) once(lm.aabb, (a) => this.shiftAabb(a, dz));
    for (const a of this.aabbs) once(a, (q) => this.shiftAabb(q, dz));
    for (const z of this.zones) {
      z.z += dz;
      for (const c of z.containers) c.z += dz;
    }
    // City buildings: the plan, its colliders (already in `aabbs`), the loose things on its furniture and its floor.
    for (const b of this.rural) {
      once(b.aabb, (a) => this.shiftAabb(a, dz));
      once(b.plan, (pl) => this.shiftPlan(pl as RuralBuilding['plan'], dz));
    }
    for (const a of this.ambushes) a.z += dz;
    for (const e of this.encounters) e.z += dz;
    for (const t of this.tips) t.z += dz;
    for (const m of this.mines) m.z += dz;
    for (const p of this.pickups) p.z += dz;
    for (const p of this.props) p.z += dz;
    for (const g of this.signs) g.z += dz;
    for (const c of this.cars) c.z += dz;
    for (const q of this.zombies) (q.z += dz), (q.cluster += 100000);
    for (const b of this.barricades) b.z += dz;
    for (const d of this.delves) d.z += dz;
    for (const d of this.terrain.delves) once(d, (q) => (q.z += dz));
    for (const st of this.terrain.streets ?? []) st.z0 += dz, (st.z1 += dz);
    this.lotGrid.clear();
    for (const l of this.lots) this.indexLot(l);
  }

  private shiftAabb(a: Aabb, dz: number) {
    a.minZ += dz;
    a.maxZ += dz;
    if (a.ramp) a.ramp.z += dz;
  }

  /** Slide a building plan north by dz: walls, rooms, furniture, stairs, wells, debris, the loose items and the car bays. */
  private shiftPlan(pl: RuralBuilding['plan'], dz: number) {
    pl.z0 += dz;
    pl.z1 += dz;
    for (const w of pl.walls) {
      if (w.axis === 'x') w.c += dz;
      else (w.a += dz), (w.b += dz);
      if (w.axis === 'z') for (const op of w.ops) (op.a += dz), (op.b += dz);
    }
    for (const r of pl.rooms) (r.z0 += dz), (r.z1 += dz);
    for (const f of pl.furn) f.z += dz;
    for (const st of pl.stairs) st.z += dz;
    for (const q of pl.wells) (q.z0 += dz), (q.z1 += dz);
    for (const q of pl.debris) q.z += dz;
    for (const l of pl.lairs) l.z += dz;
    for (const it of pl.items) it.z += dz;
    for (const g of pl.guns) g.z += dz;
    for (const bay of pl.bays) bay.z += dz;
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
          lot.fixed = !!(o.landmark || o.shop || o.fixed);
        }
        this.lots.push(lot);
        this.indexLot(lot);
      });
    }
    this.layOutStreets(plan);
    this.dressLandmarks(plan);
    this.layRail(plan);
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


  // ---------------------------------------------------------------- the light rail

  /**
   * The light-rail line down one east-west street: a concrete slab with two tracks, an island platform at each station
   * with a canopy and a name board, and a tram or two standing where the plan says. The masts and overhead wire are drawn
   * with the slab, from the same rectangle.
   */
  private layRail(plan: CityPlan) {
    const r = plan.rail;
    if (!r) return;
    const slot = this.slots[r.block];
    const zc = slot.z1 + r.centre;
    const edge = BOULEVARD_HALF + SIDEWALK;
    const xs = (d: number) => r.side * (edge + d);
    const span = (a: number, b: number): [number, number] => [Math.min(xs(a), xs(b)), Math.max(xs(a), xs(b))];
    const push = (kind: 'rail' | 'platform', x0: number, x1: number, z0: number, z1: number) =>
      this.streets.push({ id: `${plan.id}:${kind}${this.streets.length}`, kind, x0, x1, z0, z1 });
    const [sx0, sx1] = span(r.from, r.to);
    push('rail', sx0, sx1, zc - r.width / 2, zc + r.width / 2);
    for (const st of r.stations) {
      const [x0, x1] = span(st.from, st.to);
      push('platform', x0, x1, zc - 1.6, zc + 1.6);
      this.places.push({ id: st.id, name: st.name, sub: st.sub, x: (x0 + x1) / 2, z: zc, r: 30 });
      // The name board hangs from the canopy's fascia on both long sides, so the road and the tracks each see one.
      for (const face of [-1, 1]) {
        this.signs.push({ x: (x0 + x1) / 2, y: 3.5, z: zc + face * 2.3, yaw: face > 0 ? 0 : Math.PI, w: 7.2, h: 1.3, text: st.he, sub: st.name.replace(' STATION', ''), theme: 'rail' });
      }
      for (let i = 0; i < 3; i++) this.plainProp('bench', x0 + ((i + 0.7) * (x1 - x0)) / 3.4, zc + (i % 2 ? 0.9 : -0.9), i % 2 ? Math.PI : 0, 1, i + 1);
    }
    for (const t of r.trams) {
      const x = xs(t.at);
      const z = zc + t.track * 3.9;
      const heading = t.dir * r.side;
      this.plainProp('tram', x, z, heading > 0 ? Math.PI / 2 : -Math.PI / 2, 1, 1 + this.props.length);
      this.aabbs.push({ id: newAabbId(), minX: x - 18, maxX: x + 18, minZ: z - 1.4, maxZ: z + 1.4, y0: 0, y1: 3.7, kind: 'pillar', hp: 99999 });
    }
  }

  /** Shop signs over the ground floors that face Haim Ozer, in Hebrew over English, the way the real street has them. */
  private shopSigns() {
    const names: [string, string, SignTheme][] = [
      ['פלאפל', 'FALAFEL', 'cafe'],
      ['סופר', 'SUPERMARKET', 'market'],
      ['בית מרקחת', 'PHARMACY', 'pharmacy'],
      ['בנק', 'BANK', 'bank'],
      ['קפה', 'CAFÉ', 'cafe'],
      ['פיצה', 'PIZZA', 'cafe'],
      ['מספרה', 'BARBER', 'shop'],
      ['סלולר', 'CELLULAR', 'shop'],
      ['נעליים', 'SHOES', 'shop'],
      ['פרחים', 'FLOWERS', 'shop'],
      ['צילום', 'PHOTO', 'shop'],
      ['קיוסק', 'KIOSK', 'market'],
      ['שווארמה', 'SHAWARMA', 'cafe'],
      ['ספרים', 'BOOKS', 'shop'],
      ['תכשיטים', 'JEWELLERY', 'shop'],
      ['מכולת', 'GROCERY', 'market'],
    ];
    for (const lot of this.lots) {
      if (lot.kind !== 'building' || lot.fixed || lot.strip !== 0) continue;
      const len = lot.z1 - lot.z0;
      const n = len > 52 ? 3 : 2;
      for (let i = 0; i < n; i++) {
        const h = hash2(Math.round(lot.z0) + i * 7, lot.side * 3 + i, 4411);
        const [he, en, theme] = names[Math.floor(h * names.length) % names.length];
        const z = lot.z0 + ((i + 0.5) * len) / n;
        // The wall that faces the boulevard: -x for a lot on the left, +x for one on the right.
        this.signs.push({ x: lot.side === 1 ? lot.x0 - 0.16 : lot.x1 + 0.16, y: 3.72, z, yaw: lot.side === 1 ? -Math.PI / 2 : Math.PI / 2, w: 4.4 + h * 1.6, h: 0.95, text: he, sub: en, theme });
      }
    }
  }

  private pave(kind: 'paving' | 'lawn' | 'tarmac' | 'pitch', x0: number, x1: number, z0: number, z1: number) {
    this.streets.push({ id: `${this.plan?.id ?? 'plan'}:pv${this.streets.length}`, kind, x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0, z1 });
  }

  private plainProp(kind: PropKind, x: number, z: number, yaw: number, scale = 1, seed = 1, tag?: number) {
    this.props.push({ kind, x, y: 0, z, yaw, scale, seed, tag });
  }

  /** Landmark footprints, forecourts, and everything standing in them. */
  private dressLandmarks(plan: CityPlan) {
    const rng = new Rng(this.leg.seed ^ 0x7e11);
    const faceYaw = (dx: number, dz: number) => Math.atan2(dx, dz);
    const depthZ = (l: Lot) => l.z1 - l.z0;
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
          // What was left on the benches: a tin of food and a bottle of pills, each beside the bench it was put down by.
          const benches = this.props.filter((q) => q.kind === 'bench' && Math.hypot(q.x - fx, q.z - cz) < 8);
          if (benches[0]) this.besideProp(benches[0], 'house', { only: ['food'] });
          if (benches[2]) this.besideProp(benches[2], 'house', { only: ['med'] });
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
          // The staff's own cars: what their owners had out when it started, beside them.
          const cars = this.cars.filter((c) => c.x > lx && c.x < lot.x1 && c.z > lot.z0 && c.z < lot.z1);
          this.lootRng.shuffle(cars).slice(0, 4).forEach((c, i) => this.besideCar(c, 1, i === 0 ? 'trunk' : 'wreck', i === 0 ? { only: ['med', 'food'] } : {}));
          // The staff who never went home.
          pushZombies(this, rng, lx + 6, lot.z0 + 38, 6, ['walker', 'walker', 'runner'], 8, true, cluster++);
          pushZombies(this, rng, lx + 3, lot.z0 + 50, 1, ['screamer'], 2, true, cluster++);
          break;
        }
        case 'busStation': {
          // The forecourt between Haim Ozer and the terminal hall: dark tarmac, the buses that never left, shelters for the
          // people who were waiting for them, and the big sign over the doors. The commuters are still here.
          const hallFront = 13;
          this.pave('tarmac', lot.x0, xAt(hallFront), lot.z0 + 2, lot.z1 - 2);
          for (let k = 0; k < 5; k++) {
            const bz = lot.z0 + 14 + k * 21;
            const south = k % 2 === 1;
            this.plainProp('bus', xAt(4.6), bz, south ? Math.PI : 0, 1, 11 + k);
            this.aabbs.push({ id: newAabbId(), minX: xAt(4.6) - 1.4, maxX: xAt(4.6) + 1.4, minZ: bz - 6.2, maxZ: bz + 6.2, y0: 0, y1: 3.2, kind: 'pillar', hp: 99999 });
            this.plainProp('busShelter', xAt(9.2), bz + 4, faceYaw(-out, 0), 1, 21 + k);
          }
          lamp(xAt(hallFront - 1.4), lot.z0 + 6, xAt(0));
          lamp(xAt(hallFront - 1.4), lot.z1 - 6, xAt(0));
          // Signs: the hall's name along its roof line, and one on the glass tower beside it.
          this.signs.push({ x: xAt(hallFront) - out * 0.2, y: 13.9, z: cz, yaw: faceYaw(-out, 0), w: 26, h: 3.2, text: 'תחנה מרכזית פתח תקווה', sub: 'PETAH TIKVA CENTRAL BUS STATION', theme: 'bus' });
          this.signs.push({ x: xAt(hallFront) - out * 0.2, y: 3.5, z: cz, yaw: faceYaw(-out, 0), w: 12, h: 0.9, text: 'כרטיסים · יציאות', sub: 'TICKETS · DEPARTURES', theme: 'bus' });
          // Left luggage: what the waiting passengers set down, beside the buses and the shelters.
          for (const bus of this.props.filter((q) => q.kind === 'bus' && q.z > lot.z0 && q.z < lot.z1).slice(0, 4)) this.besideProp(bus, 'trunk', { only: ['food', 'med', 'water'] });
          pushZombies(this, rng, xAt(8), cz - 18, 9, ['walker', 'walker', 'walker', 'runner'], 12, true, cluster++);
          pushZombies(this, rng, xAt(8), cz + 22, 5, ['walker', 'runner'], 9, true, cluster++);
          pushZombies(this, rng, xAt(20), cz, 1, ['brute'], 3, true, cluster++);
          break;
        }
        case 'stadium': {
          // The pitch: striped grass between the stands, goals at both ends. The two corners left open are the way in.
          this.pave('pitch', lot.x0 + 17, lot.x0 + 73, lot.z0 + 7, lot.z1 - 7);
          for (const [fx, fz] of [[8.5, 3], [81.5, 3], [8.5, depthZ(lot) - 3], [81.5, depthZ(lot) - 3]] as const) {
            // Each mast's lamps face the middle of the pitch.
            this.plainProp('floodlight', lot.x0 + fx, lot.z0 + fz, faceYaw(cx - (lot.x0 + fx), cz - (lot.z0 + fz)), 1, 1);
          }
          this.signs.push({ x: lot.x0 - 0.2, y: 8.6, z: cz, yaw: faceYaw(-out, 0), w: 26, h: 3.4, text: 'אצטדיון המושבה', sub: 'HAMOSHAVA STADIUM', theme: 'stadium' });
          // The gate on the forecourt side: a ticket kiosk and some turnstile-shaped debris, and the supporters who never left.
          // The groundsmen's stores at the floodlight masts: fuel and oil for the generators, a tin of food.
          for (const mast of this.props.filter((q) => q.kind === 'floodlight' && q.z > lot.z0 && q.z < lot.z1).slice(0, 3)) this.besideProp(mast, 'garage', { only: ['fuel', 'oil'] });
          const mast0 = this.props.find((q) => q.kind === 'floodlight' && q.z > lot.z0 && q.z < lot.z1);
          if (mast0) this.besideProp(mast0, 'house', { only: ['food', 'ammo'] });
          pushZombies(this, rng, lot.x0 + 45, cz, 12, ['walker', 'walker', 'walker', 'runner'], 22, true, cluster++);
          pushZombies(this, rng, lot.x0 + 45, cz - 30, 2, ['brute'], 6, true, cluster++);
          pushZombies(this, rng, lot.x0 + 45, cz + 34, 1, ['screamer'], 3, true, cluster++);
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
      // Something to eat, left on the tables outside.
      for (const t of this.props.filter((q) => q.kind === 'cafeTable' && q.x === out * 8.75 && Math.abs(q.z - cz) < 7).slice(0, 2)) this.besideProp(t, 'kitchen', { only: ['food'] });
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
    if (this.lotGrid.size) {
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

  /** How far from the start of the map a point is, 0 to 1: better kit lies further out. */
  private reachAt(x: number, z: number) {
    return Math.min(1, Math.hypot(x, z - 12) / 3600);
  }

  /** A named thing set on the ground at (x, z), at a fixed heading, because of a host. */
  private putAt(spec: LootSpec, x: number, z: number, host: PickupSpawn['host'], o: { y?: number; yaw?: number; tilt?: [number, number] } = {}) {
    const k = pickupOf(spec);
    if (!k) return;
    const y = o.y ?? (this.leg.biome === 'city' && !this.leg.open ? 0 : heightAt(this.terrain, x, z));
    this.pickups.push({ id: this.id('lp'), ...k, x, z, y, yaw: o.yaw ?? hash2(Math.round(x * 10), Math.round(z * 10), this.leg.seed) * Math.PI * 2, tilt: o.tilt, host });
  }

  /**
   * A thing from `context` lying on the ground just beside a host (a car, a bench, a bus, a drum): a metre or two from its
   * edge, on clear ground. Nothing in this world lies in open ground by itself. False if there was no room.
   */
  besideAt(hostKind: string, hx: number, hz: number, hr: number, context: LootContext, o: { only?: LootTag[]; cap?: ItemSize; progress?: number } = {}): boolean {
    const spec = rollItem(context, this.lootRng, { progress: o.progress ?? this.reachAt(hx, hz), only: o.only, cap: o.cap });
    if (!spec) return false;
    const foot = specFoot(spec);
    const half = Math.max(foot.w, foot.d) / 2 + 0.1;
    for (let t = 0; t < 12; t++) {
      const a = this.lootRng.range(0, Math.PI * 2);
      const r = hr + half + this.lootRng.range(0.25, 1.4);
      const x = hx + Math.cos(a) * r;
      const z = hz + Math.sin(a) * r;
      if (this.blockedAt(x, z, half)) continue;
      this.putAt(spec, x, z, { kind: hostKind, mode: 'beside', context });
      return true;
    }
    return false;
  }

  /** A thing beside a car (maybe: `chance`), for a part or a can that its last owner had out. */
  private besideCar(car: CarSpawn, chance: number, context: LootContext = 'wreck', o: { only?: LootTag[] } = {}) {
    if (!this.lootRng.chance(chance)) return;
    this.besideAt('car', car.x, car.z, 1.6, context, o);
  }

  /** A thing beside a prop already placed: its kind says what hosts it. */
  private besideProp(p: PropSpawn, context: LootContext, o: { only?: LootTag[]; progress?: number } = {}) {
    return this.besideAt(p.kind, p.x, p.z, (HOST_PROPS[p.kind] ?? 1) * p.scale, context, o);
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
        // A stash by a dead car: drums at its tail and the cans stood beside them and beside the car.
        const n = (s.count as number) ?? 2;
        const wx = rxAt(s.at) + rng.sign() * 9;
        const car = this.addCar(wx, s.at, rng.range(0, 6), rng.int(0, 9999), { grade: 'donor' });
        // The drums stand on the far side of the car from the road.
        const out = Math.sign(wx - rxAt(s.at)) || 1;
        const dx = wx + out * 4.5;
        const dy = heightAt(T, dx, s.at - 5);
        const drum = { kind: 'barrel' as const, x: dx, y: dy, z: s.at - 5, yaw: 0, scale: 1, seed: 3 };
        this.props.push(drum, { ...drum, x: dx + out * 0.9, z: s.at - 4.6, seed: 5 });
        this.aabbs.push({ id: newAabbId(), minX: Math.min(dx, dx + out * 0.9) - 0.4, maxX: Math.max(dx, dx + out * 0.9) + 0.4, minZ: s.at - 5.4, maxZ: s.at - 4.2, y0: dy - 0.5, y1: dy + 1, kind: 'crate', hp: 9999 });
        for (let i = 0; i < n; i++) {
          if (i % 2) this.besideAt('car', car.x, car.z, 1.6, 'cache', { only: ['fuel'] });
          else this.besideAt('barrel', dx + out * 0.45, s.at - 4.8, 1.3, 'cache', { only: ['fuel'] });
        }
        break;
      }
      case 'scrapPile': {
        // A tyre dump by the road: stacks of old tyres, and a good one or a can of oil beside them.
        const n = (s.count as number) ?? 3;
        for (let i = 0; i < n; i++) {
          const z = s.at + i * 18 + rng.range(-8, 8);
          const x = rxAt(z) + rng.sign() * rng.range(9, 28);
          const y = heightAt(T, x, z);
          const pile: PropSpawn = { kind: 'tires', x, y, z, yaw: rng.range(0, 6), scale: 1.2, seed: rng.int(0, 9999) };
          this.props.push(pile, { kind: 'tires', x: x + 1.9, y: heightAt(T, x + 1.9, z + 1.1), z: z + 1.1, yaw: rng.range(0, 6), scale: 1, seed: rng.int(0, 9999) });
          this.besideProp(pile, 'garage', { only: ['tyre', 'oil'] });
          if (rng.chance(0.4)) this.besideProp(pile, 'garage', { only: ['tyre'] });
        }
        break;
      }
      case 'partsWreck': {
        // A pile-up of cars somebody has been through, most of them donors with their good kit still on, a part beside each.
        const n = (s.count as number) ?? 3;
        for (let i = 0; i < n; i++) {
          const z = s.at + i * 22 + rng.range(-8, 8);
          const x = rxAt(z) + rng.sign() * rng.range(10, 34);
          const carSeed = rng.int(0, 9999);
          const car = this.addCar(x, z, rng.range(0, 6), carSeed, { grade: carSeed % 5 < 2 ? 'donor' : carSeed % 5 < 4 ? 'hulk' : undefined });
          this.besideAt('car', car.x, car.z, 1.6, 'wreck', { only: ['radiator', 'gearbox', 'tyre', 'brake', 'exhaust', 'spring', 'panel', 'engine', 'mount'] });
          if (carSeed % 4 === 0) this.besideAt('car', car.x, car.z, 1.6, 'wreck', { only: ['fuel', 'oil', 'food', 'med'] });
        }
        break;
      }
      case 'radioFragment': {
        const side = rng.sign();
        const x = rxAt(s.at) + side * (city ? 11 : 16);
        const y = heightAt(T, x, s.at);
        this.props.push({ kind: 'pylon', x, y, z: s.at, yaw: 0, scale: 1, seed: 1, tag: 3 });
        this.pickups.push({ id: this.id('r'), kind: 'fragment', amount: (s.n as number) ?? 1, x, z: s.at + 2, y, yaw: 0.6, host: { kind: 'pylon', mode: 'beside', context: 'quest' } });
        break;
      }
      case 'chassisWreck': {
        const side = rng.sign();
        const x = rxAt(s.at) + side * (city ? 12 : 15);
        const y = heightAt(T, x, s.at);
        this.props.push({ kind: 'tarp', x, y, z: s.at, yaw: rng.range(-0.5, 0.5), scale: 1, seed: 7, tag: 1 });
        this.pickups.push({ id: this.id('c'), kind: 'chassis', amount: 1, x, z: s.at + 3, y, yaw: 0.4, host: { kind: 'tarp', mode: 'beside', context: 'quest' } });
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
          const stack: PropSpawn = { kind: 'crateStack', x: xc, y: cy, z: cz, yaw: 0, scale: 1.2, seed: 3, tag: 2 };
          this.props.push(stack);
          // The ramp's prize: the best of what a warehouse holds, stood by the crates at the top.
          for (const only of [['engine', 'radiator'], ['gearbox', 'spring', 'mount'], ['radiator', 'gearbox', 'mount', 'panel']] as LootTag[][]) this.besideProp(stack, 'warehouse', { only, progress: 0.85 });
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

  /**
   * A city lot set aside as a place worth a trip: a pharmacy, a clinic, a depot, and the car trades (a garage with engines on
   * stands and parts shelving, a dealership with its showroom cars, a tyre shop, a warehouse with pallet racking). Each is a
   * real building with a floor plan, furniture and loose things lying on it, built through the same `SiteBuilder` as the
   * roadside places, with its yard of cars beside it. A car park is an open lot of cars.
   */
  private addZone(s: SetPiece) {
    const kind = (s.kind as keyof typeof TRADE | 'parking') ?? 'depot';
    const side = ((s.side as number) ?? 1) as 1 | -1;
    const slot = this.slotNear(s.at);
    // Use the boulevard-facing strip lot in this slot as the zone footprint.
    const lot = this.lots.find((l) => l.slot === this.slots.indexOf(slot) && l.side === side && l.strip === 0);
    if (!lot || lot.fixed || lot.kind === 'zone') return;
    lot.kind = 'zone';
    const cx = (lot.x0 + lot.x1) / 2;
    const cz = (lot.z0 + lot.z1) / 2;
    const open = (side === 1 ? -1 : 1) as 1 | -1; // open face looks at the boulevard
    const rng = new Rng(this.leg.seed + Math.floor(s.at));
    const zr = new Rng(this.leg.seed * 31 + Math.floor(s.at));
    const kinds: ZombieKind[] = ['walker', 'walker', 'runner'];
    const sign = (tag: number) => this.props.push({ kind: 'sign', x: side === 1 ? lot.x0 + 1 : lot.x1 - 1, y: 0, z: lot.z0 + 2, yaw: 0, scale: 1.3, seed: 1, tag });
    if (kind === 'parking') {
      // A car park: two back-to-back rows of cars nobody came back for, a part or a can beside a few of them.
      sign(5);
      for (const [row, off] of [[0, 4], [1, 9]] as const) {
        const x = side === 1 ? lot.x0 + off : lot.x1 - off;
        for (let z = lot.z0 + 4; z < lot.z1 - 3; z += 2.7) {
          if (!rng.chance(0.62)) continue;
          const seed = rng.int(0, 9999);
          const car = this.addCar(x + rng.range(-0.25, 0.25), z, (row === 0 ? -Math.PI / 2 : Math.PI / 2) + rng.range(-0.08, 0.08), seed, { y: 0 });
          this.besideCar(car, 0.3, 'trunk');
        }
      }
      pushZombies(this, zr, cx, cz, 3 + this.leg.index, kinds, Math.min(lot.x1 - lot.x0, lot.z1 - lot.z0) * 0.4, true, 2000 + Math.floor(s.at));
      return;
    }
    const cfg = TRADE[kind];
    if (!cfg) return;
    const bw = Math.min(cfg.w, lot.x1 - lot.x0 - 3);
    const bd = Math.min(cfg.d, lot.z1 - lot.z0 - 6);
    const bx = side === 1 ? lot.x0 + 1.5 + bw / 2 : lot.x1 - 1.5 - bw / 2;
    const site: Site = { kind: 'cityLot', z: cz, side, off: 0, radius: 0, seed: this.leg.seed * 131 + Math.floor(s.at) + 7, x: cx };
    const sb = new SiteBuilder({ def: this.terrain, newId: newAabbId }, site);
    const style = rng.pick([0, 1, 2]);
    const rb = sb.building(bx, cz, bw, bd, 1, cfg.look, style, rng.pick([0xd2c6a8, 0xb8b6ae, 0xc8b8a0, 0x9ea4a6]), 'flat', { city: true, door: open, use: cfg.use, cars: cfg.cars, margin: 1, wear: 0.15 + rng.next() * 0.3 });
    sign(cfg.tag);
    // The yard behind and beside the building: its own cars (a dealership's stock out on the lot, a garage's customers) and the odd drum.
    const yardX0 = side === 1 ? lot.x0 + 1.5 + bw + 2.5 : Math.max(lot.x0 + 2, -38);
    const yardX1 = side === 1 ? Math.min(lot.x1 - 2, 38) : lot.x1 - 1.5 - bw - 2.5;
    const nYard = kind === 'dealership' ? 4 : kind === 'garage' || kind === 'tyreshop' ? 3 : 2;
    for (let i = 0; i < nYard && yardX1 - yardX0 > 3.2; i++) {
      const x = rng.range(yardX0 + 1.4, yardX1 - 1.4);
      const z = rng.range(lot.z0 + 3, lot.z1 - 3);
      if (!sb.free(x - 1.2, x + 1.2, z - 2.4, z + 2.4, 0.6)) continue;
      sb.out.cars.push({ x, y: 0, z, yaw: rng.range(0, 6.28), seed: rng.int(0, 9999), grade: kind === 'dealership' ? 'complete' : kind === 'garage' ? 'donor' : undefined, reach: sb.reach });
    }
    if (kind === 'garage' || kind === 'tyreshop') {
      const x = rng.range(yardX0 + 1, Math.max(yardX0 + 1.2, yardX1 - 1));
      const z = rng.range(lot.z0 + 3, lot.z1 - 3);
      if (sb.free(x - 1.5, x + 1.5, z - 1.5, z + 1.5, 0.5)) {
        sb.prop('tires', x, z, rng.range(0, 6), 1.1, 1);
        sb.besideProp('tires', 'garage', { only: ['tyre', 'oil'] });
      }
    }
    this.mergeSite(sb.out);
    pushZombies(this, zr, cx, cz, 2 + this.leg.index, kinds, Math.min(lot.x1 - lot.x0, lot.z1 - lot.z0) * 0.3, true, 2000 + Math.floor(s.at));
    if (kind === 'hospital') {
      pushZombies(this, zr, cx, cz, 1, ['brute'], 3, true, 2999);
      pushZombies(this, zr, cx, cz, 1, ['bloater'], 3, true, 2998);
    }
    void rb;
  }

  // ---------------------------------------------------------------- roadside places

  /** A car by the road: a real vehicle once the convoy gets near. `seed` fixes its make and condition. */
  private addCar(x: number, z: number, yaw: number, seed: number, o: Partial<CarSpawn> = {}): CarSpawn {
    const car: CarSpawn = { id: this.id('car'), x, y: heightAt(this.terrain, x, z), z, yaw, seed: seed * 131 + this.cars.length * 7 + 11, reach: this.reachAt(x, z), ...o };
    this.cars.push(car);
    return car;
  }

  private mergeSite(c: SiteContent) {
    for (const car of c.cars) this.cars.push({ id: this.id('car'), ...car, seed: car.seed * 131 + this.cars.length * 7 + 11 });
    this.rural.push(...c.buildings);
    this.aabbs.push(...c.aabbs);
    this.props.push(...c.props);
    this.zones.push(...c.zones);
    for (const p of c.pickups) this.pickups.push({ id: this.id('sp'), ...p });
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
        const car = this.addCar(x, z, yaw, rng.int(0, 9999));
        // Boxes and cans the drivers had out when they gave up, beside the cars.
        this.besideCar(car, 0.3);
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
   * Raider gangs hold camps: beside some of the places off the highway and out on their own in the open country. Each
   * is a ring of tents and fence under the gang's banners, with a stash and sentries (`game/gangCamps.ts`). When the
   * sentries raise the alarm the camp's ambush rolls out: the same buggies the old hidden ambushes sent, stronger the
   * further from the start.
   */
  private raiderCamps() {
    const rng = new Rng(this.leg.seed ^ 0x2a1d);
    const T = this.terrain;
    const spots: { x: number; z: number }[] = [];
    for (const s of T.sites) {
      if (!(s.kind === 'depot' || s.kind === 'gasStop' || s.kind === 'motel' || s.kind === 'mastHill' || s.kind === 'farm')) continue;
      if (Math.abs(s.x - roadX(T, s.z)) < 250 || !rng.chance(0.5)) continue;
      // Beside the place, on the side away from the road, clear of its pad.
      const away = Math.sign(s.x - roadX(T, s.z)) || 1;
      const x = s.x + away * (s.radius + 34);
      const z = s.z + rng.range(-12, 12);
      if (fitSpot(T, x, z)) spots.push({ x, z });
    }
    const free = planFreeCamps(T, this.leg.seed, 6, spots);
    for (const p of [...spots, ...free]) {
      const spec = newCampSpec(this.leg.seed, this.id('gang'), p.x, p.z, rng);
      this.gangCamps.push(spec);
      dressGangCamp(T, spec, GANGS[spec.gang].tag, { props: this.props, pickups: this.pickups, aabbs: this.aabbs, id: (k) => this.id(k), aabbId: newAabbId });
      const reach = Math.hypot(p.x, p.z - 12);
      this.ambushes.push({
        id: this.id('a'),
        x: p.x,
        z: p.z,
        buggies: Math.min(5, 2 + Math.floor(reach / 1200)),
        wagon: reach > 1800 && rng.chance(0.5) ? 1 : 0,
        triggerRadius: 0,
        canyon: false,
        camp: spec.id,
      });
    }
  }

  /**
   * The rest of the map: rocks, dead trees, bones and wandering dead, one roll per 60 m square,
   * leaving the strip along the highway to `wastelandAmbient`. Its own random stream.
   */
  private openAmbient() {
    const rng = new Rng(this.leg.seed ^ 0x09e1);
    const T = this.terrain;
    const o = T.open!;
    const CELL = 60;
    for (let i = Math.floor(o.x0 / CELL) + 1; i < Math.floor(o.x1 / CELL) - 1; i++) {
      for (let j = Math.floor(o.z0 / CELL) + 1; j < Math.floor(o.z1 / CELL) - 1; j++) {
        const x = (i + rng.next()) * CELL;
        const z = (j + rng.next()) * CELL;
        // A roll per kind, always made, so a change in one never shifts the others.
        const rRock = rng.next();
        const rBig = rng.next();
        const rTree = rng.next();
        const rBones = rng.next();
        const rDead = rng.next();
        const ox = rng.range(-20, 20);
        const oz = rng.range(-20, 20);
        if (Math.abs(x - roadX(T, z)) < 130) continue;
        if (nearestRoad(o, x, z).edge < 8) continue;
        const y = heightAt(T, x, z);
        if (rRock < 0.5) {
          const big = rBig < 0.12;
          this.props.push({ kind: 'rock', x, y, z, yaw: rng.range(0, 6.28), scale: big ? rng.range(2.4, 4.2) : rng.range(0.6, 1.6), seed: rng.int(0, 9999) });
          if (big) {
            const r = 1.4 * 3;
            this.aabbs.push({ id: newAabbId(), minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r, y0: y - 1, y1: y + 4, kind: 'rock', hp: 9999 });
          }
        }
        if (rTree < 0.14) this.props.push({ kind: 'deadTree', x: x + ox, y: heightAt(T, x + ox, z + oz), z: z + oz, yaw: rng.range(0, 6.28), scale: rng.range(0.8, 1.5), seed: rng.int(0, 99) });
        if (rBones < 0.04) this.props.push({ kind: 'bones', x: x - ox, y: heightAt(T, x - ox, z - oz), z: z - oz, yaw: rng.range(0, 6.28), scale: 1, seed: rng.int(0, 99) });
        if (rDead < 0.014) pushZombies(this, rng, x, z, rng.int(2, 4), ['walker'], 10, false, 3000 + i * 57 + j);
      }
    }
  }

  /** Cars left along the side roads, with what their drivers had out beside them: cans, and the odd part. */
  private sideRoadKit() {
    const rng = new Rng(this.leg.seed ^ 0x51de);
    const T = this.terrain;
    for (const road of T.open!.roads) {
      if (road.kind !== 'road') continue;
      const p = road.pts;
      let acc = rng.range(0, 140);
      for (let k = 2; k < p.length; k += 2) {
        acc += Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
        if (acc < 140) continue;
        acc = rng.range(0, 60);
        const side = rng.sign();
        const z = p[k + 1] + rng.range(-8, 8);
        if (Math.abs(p[k] - roadX(T, z)) < 60) continue;
        if (rng.chance(0.45)) {
          const car = this.addCar(p[k] + side * rng.range(5.6, 8.4), z, rng.range(0, 6.28), rng.int(0, 9999));
          this.besideCar(car, 0.55);
        }
      }
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
      !this.zones.some((q) => Math.abs(q.z - (l.z0 + l.z1) / 2) < 40) &&
      // The story items (the frame under its tarp, the radio board at its pylon) are never cleared away for a headhouse.
      !leg.sets.some((q) => (q.type === 'chassisWreck' || q.type === 'radioFragment') && q.at > l.z0 - 20 && q.at < l.z1 + 20);
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
        const car = this.addCar(x, z, yaw, rng.int(0, 9999), { y: 0 });
        this.besideCar(car, 0.2, 'trunk');
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
    // A few dumpsters and debris piles.
    for (let z = 25; z < this.leg.length + 60; z += 41) {
      const x = rng.sign() * rng.range(7.5, 9.5);
      const prop: PropSpawn = { kind: rng.pick(['dumpster', 'rubble', 'barrel']), x, y: 0, z, yaw: rng.range(0, 6), scale: 1, seed: rng.int(0, 99) };
      this.props.push(prop);
      // What was thrown out, and what was left in the drums: a tin or a can beside the odd one.
      if (prop.kind !== 'rubble' && this.lootRng.chance(0.3)) this.besideProp(prop, prop.kind === 'barrel' ? 'garage' : 'house', { only: prop.kind === 'barrel' ? ['fuel', 'oil', 'water'] : ['food', 'med'] });
    }
  }
}

/** The city lots a `scavengeZone` can turn into: what building stands there, what it is for, how big and which sign stands out front. */
const TRADE: Record<string, { look: Look; use: LootContext; w: number; d: number; tag: number; cars?: number }> = {
  pharmacy: { look: 'store', use: 'pharmacy', w: 14, d: 18, tag: 6 },
  hospital: { look: 'store', use: 'clinic', w: 18, d: 28, tag: 7 },
  police: { look: 'store', use: 'police', w: 14, d: 18, tag: 12 },
  gunshop: { look: 'store', use: 'gun_shop', w: 14, d: 16, tag: 12 },
  depot: { look: 'warehouse', use: 'depot', w: 26, d: 40, tag: 5 },
  warehouse: { look: 'warehouse', use: 'warehouse', w: 26, d: 40, tag: 11 },
  garage: { look: 'garage', use: 'garage', w: 16, d: 18, tag: 8 },
  dealership: { look: 'dealership', use: 'dealership', w: 22, d: 22, tag: 9, cars: 3 },
  tyreshop: { look: 'tyreshop', use: 'tyreshop', w: 14, d: 15, tag: 10 },
};

export function chunkKey(cx: number, cz: number) {
  return cx * 4096 + cz;
}
