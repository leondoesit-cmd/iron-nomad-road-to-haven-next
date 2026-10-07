import type { ZombieKind } from '../data';
import { fitsSlot, furnSlots, generatePlan, levelBase, planAabbs, slotWorld, type BuildingPlan, type Look } from './interiors';
import type { LegDef } from '../data';
import { Rng, hash2 } from '../core/rng';
import { corridorHalf, heightAt, keepOutZ, roadX, roadSlope, type Site, type TerrainDef } from './terrain';
import type { Aabb, AabbKind, PickupHost, PickupKind, PickupSpawn, PropKind, PropSpawn, ScavContainer, ScavZone } from './layout';
import { lakeSite } from './lakeSites';
import { HOST_PROPS, pickupOf, rollItem, specFoot, type ItemSize, type LootContext, type LootSpec, type LootTag } from '../sim/loot';
import type { CarGrade } from '../sim/cars';

/**
 * Roadside places for the wasteland: gas stops, hamlets, a motel, a farm, a depot yard, a broken overpass, a wind
 * farm and a radio hill, plus the power lines, billboards and lone water towers and windpumps that fill the gaps between them.
 * Everything is derived from the leg seed, so a leg always has the same places in the same spots.
 *
 * What lies in them follows what they are (`sim/loot.ts`): a gas stop has fuel at the pumps and oil on the shop shelves, a
 * garage has engines on their stands and parts on the bench, a depot has its racks and the yard beside its containers, a
 * wreck has a part or a can beside it. Loose things are put on the furniture inside a building, or on the ground right
 * beside the host that justifies them (`PickupHost`): nothing lies in open ground by itself.
 */

export interface RuralBuilding {
  /** Footprint, for placement and culling. Not a collider: the plan's walls are. */
  aabb: Aabb;
  plan: BuildingPlan;
  /** Exterior facade style (see render/facade.ts) and colour. */
  extStyle: number;
  tint: number;
  roof: 'gable' | 'shed' | 'flat' | 'none';
  ridgeX: boolean;
  seed: number;
  look: Look;
  /** Direction (along x) the door faces. */
  door: 1 | -1;
}

export interface SitePickup {
  kind: PickupKind;
  amount: number;
  part?: { id: string; cond: number };
  fuel?: 'petrol' | 'diesel';
  color?: number;
  gun?: PickupSpawn['gun'];
  x: number;
  z: number;
  y: number;
  yaw?: number;
  tilt?: [number, number];
  host: PickupHost;
}

export interface ZombieGroup {
  x: number;
  z: number;
  n: number;
  spread: number;
  kinds: ZombieKind[];
}

export interface SiteContent {
  buildings: RuralBuilding[];
  aabbs: Aabb[];
  props: PropSpawn[];
  pickups: SitePickup[];
  /** Abandoned cars, placed without an id: the layout assigns one. */
  cars: SiteCar[];
  zombies: ZombieGroup[];
  zones: ScavZone[];
}

export interface SiteCar {
  x: number;
  y: number;
  z: number;
  yaw: number;
  seed: number;
  grade?: CarGrade;
  reach?: number;
}

export interface SiteCtx {
  def: TerrainDef;
  newId: () => number;
}

const empty = (): SiteContent => ({ buildings: [], aabbs: [], props: [], pickups: [], cars: [], zombies: [], zones: [] });

const STUCCO = [0xd2c6a8, 0xc8b8a0, 0xb8b0a0, 0xd8cbb8, 0xc4b090];
const BRICK = [0x9a5a44, 0x8a4c3a, 0xa86a50];
const PANEL = [0xb8b6ae, 0xa8a8a2, 0x9ea4a6];
const WALKER: ZombieKind[] = ['walker', 'walker', 'runner'];
const SIDING = [0xc8c0a8, 0x9aa8a0, 0xb8a888, 0xa8b0b8, 0xb89a80, 0x8a9a8a];
const METAL = [0x9aa0a0, 0x8a9088, 0xa8a090, 0x7a8a90];
const TAU = Math.PI * 2;

/** Options for `SiteBuilder.building`. */
export interface BuildingOpts {
  ridgeX?: boolean;
  margin?: number;
  door?: 1 | -1;
  extra?: number;
  wear?: number;
  /** What the place is for, when the look does not say. */
  use?: LootContext;
  /** Cars standing inside (a dealership's showroom). */
  cars?: number;
  /** A city lot: no highway to keep clear of, and the ground is already level. */
  city?: boolean;
}

export class SiteBuilder {
  out = empty();
  rng: Rng;
  /** What lies where gets its own stream, so loot never shifts the layout of a place. */
  loot: Rng;
  /** How far from the start of the map this place is, 0 to 1: better kit lies further out. */
  reach: number;
  /** Direction toward the road along x. */
  tw: 1 | -1;
  cx: number;
  cz: number;
  /** Props that can host a loose thing beside them. */
  private hosts: { kind: string; x: number; z: number; r: number }[] = [];

  constructor(
    private ctx: SiteCtx,
    public site: Site,
  ) {
    this.rng = new Rng(site.seed);
    this.loot = new Rng((site.seed ^ 0x5a17f00d) >>> 0);
    this.tw = (-site.side) as 1 | -1;
    this.cx = site.x;
    this.cz = site.z;
    this.reach = Math.min(1, Math.hypot(site.x, site.z - 12) / 3600);
  }

  get def() {
    return this.ctx.def;
  }

  g(x: number, z: number) {
    return heightAt(this.def, x, z);
  }

  /** True if the box keeps `m` metres clear of the carriageway along its whole length. */
  clearRoad(x0: number, x1: number, z0: number, z1: number, m: number) {
    for (let z = z0; z <= z1 + 3; z += 3) {
      const rx = roadX(this.def, Math.min(z, z1));
      if (x1 > rx - m && x0 < rx + m) return false;
    }
    return true;
  }

  /** Footprints of the buildings placed so far. */
  rects: { x0: number; x1: number; z0: number; z1: number }[] = [];
  private bi = 0;

  /** Footprints of the wrecks placed so far, so a building raised later keeps its walls and levelled pad off them. */
  private carRects: { x0: number; x1: number; z0: number; z1: number }[] = [];

  free(x0: number, x1: number, z0: number, z1: number, m = 2.5) {
    for (const r of this.carRects) {
      if (x1 + m > r.x0 && x0 - m < r.x1 && z1 + m > r.z0 && z0 - m < r.z1) return false;
    }
    for (const r of this.rects) {
      if (x1 + m > r.x0 && x0 - m < r.x1 && z1 + m > r.z0 && z0 - m < r.z1) return false;
    }
    for (const a of this.out.aabbs) {
      if (x1 + m > a.minX && x0 - m < a.maxX && z1 + m > a.minZ && z0 - m < a.maxZ) return false;
    }
    return true;
  }

  solid(kind: AabbKind, x: number, z: number, w: number, d: number, h: number, y0 = -1.2) {
    const base = this.g(x, z);
    const a: Aabb = { id: this.ctx.newId(), minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, y0: base + y0, y1: base + h, kind, hp: 99999 };
    this.out.aabbs.push(a);
    return a;
  }

  building(cx: number, cz: number, w: number, d: number, floors: number, look: Look, style: number, tint: number, roof: RuralBuilding['roof'], opts: BuildingOpts = {}) {
    const x0 = cx - w / 2;
    const x1 = cx + w / 2;
    const z0 = cz - d / 2;
    const z1 = cz + d / 2;
    if (!opts.city && !this.clearRoad(x0, x1, z0, z1, 11)) return null;
    if (!this.free(x0, x1, z0, z1, (opts.margin ?? 3) + 2)) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1], [cx, cz]]) {
      const h = this.g(x, z);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    // The ground under a building is levelled, so a moderate slope is fine.
    if (hi - lo > 1.8) return null;
    const floorY = Math.round(this.g(cx, cz) * 100) / 100;
    const door = opts.door ?? this.tw;
    const metal = look === 'warehouse' || look === 'garage' || look === 'tyreshop';
    const rooftop = look === 'barn' || metal ? 'gable' : roof;
    const extStyle = look === 'barn' ? 14 : metal ? 16 : style === 1 ? 11 : style === 2 ? 12 : look === 'house' || look === 'shack' ? 14 : 10;
    const color = metal ? this.rng.pick(METAL) : extStyle === 14 && look !== 'barn' ? this.rng.pick(SIDING) : tint;
    const wear = opts.wear ?? (this.site.kind === 'hamlet' ? 0.3 + this.rng.next() * 0.5 : 0.12 + this.rng.next() * 0.4);
    const seed = this.rng.int(1, 99999);
    const plan = generatePlan({ x0, x1, z0, z1, look, door, seed, floors, floorY, wear, roof: rooftop, use: opts.use, reach: this.reach, cars: opts.cars });
    const aabb: Aabb = { id: this.ctx.newId(), minX: x0, maxX: x1, minZ: z0, maxZ: z1, y0: floorY - 1, y1: floorY + plan.levels * plan.levelH, kind: 'building', hp: 99999, physOnly: true };
    this.rects.push({ x0, x1, z0, z1 });
    this.out.aabbs.push(...planAabbs(plan, this.ctx.newId));
    this.def.foundations.push({ x0: x0 - 2.5, x1: x1 + 2.5, z0: z0 - 2.5, z1: z1 + 2.5, h: floorY });
    const rb: RuralBuilding = {
      aabb,
      plan,
      extStyle,
      tint: color,
      roof: rooftop,
      ridgeX: opts.ridgeX ?? w > d,
      seed,
      look,
      door,
    };
    this.out.buildings.push(rb);
    this.furnish(rb, w, d);
    return rb;
  }

  /** Searchable furniture becomes a loot zone, the loose things on the furniture become pickups, a bay holds a car; some rooms hold the dead. */
  private furnish(rb: RuralBuilding, w: number, d: number) {
    const plan = rb.plan;
    const bi = this.bi++;
    const containers: ScavContainer[] = [];
    plan.furn.forEach((f, i) => {
      if (!f.items?.length && !f.drugs && !f.guns) return;
      containers.push({ id: `${this.def.seed}:${this.site.kind}${Math.round(this.site.z)}:${bi}:${i}`, x: f.x, z: f.z, depth: f.depth ?? 0, items: f.items ?? [], guns: f.guns, drugs: f.drugs, taken: false, label: f.label, y: levelBase(plan, f.level) + f.h + 0.55 });
    });
    const cx = (plan.x0 + plan.x1) / 2;
    const cz = (plan.z0 + plan.z1) / 2;
    if (containers.length) {
      this.out.zones.push({ id: `${this.def.seed}:${this.site.kind}${Math.round(this.site.z)}:z${bi}`, kind: rb.look, x: cx, z: cz, w, d, open: this.tw, containers, pin: false });
    }
    // The loose things on the benches, shelves and stands, each lying where the plan set it.
    for (const it of plan.items) {
      const k = pickupOf(it.spec);
      if (!k) continue;
      this.out.pickups.push({ ...k, x: it.x, z: it.z, y: levelBase(plan, it.level) + it.y, yaw: it.yaw, tilt: it.tilt, host: { kind: plan.furn[it.furn].kind, mode: it.mode, context: it.context } });
    }
    // The guns on the racks and the till counter of an armed place, each lying belly down where the plan put it.
    for (const g of plan.guns) {
      this.out.pickups.push({ kind: 'gear', amount: 1, gun: { context: g.context, seed: g.seed, depth: g.depth, index: g.index }, x: g.x, z: g.z, y: levelBase(plan, g.level) + g.y, yaw: g.yaw, host: { kind: plan.furn[g.furn].kind, mode: 'on', context: g.context } });
    }
    // Cars inside: the one on the garage floor is half taken apart, a showroom's stand clean.
    plan.bays.forEach((bay, i) => {
      const seed = Math.floor(hash2(Math.round(bay.x * 3), Math.round(bay.z * 3), this.site.seed + i) * 9999);
      this.out.cars.push({ x: bay.x, y: plan.floorY, z: bay.z, yaw: bay.yaw, seed, grade: rb.look === 'dealership' ? 'showroom' : 'workshop', reach: this.reach });
    });
    // The dead who never left: more in warehouses and shops, fewer in barns and sheds.
    const odds: Record<Look, number> = { house: 0.55, store: 0.7, motel: 0.6, barn: 0.35, warehouse: 0.85, shack: 0.3, garage: 0.6, dealership: 0.5, tyreshop: 0.5, mall: 1 };
    if (this.rng.next() < odds[rb.look] && plan.lairs.length) {
      const rooms = this.rng.shuffle([...plan.lairs]).slice(0, rb.look === 'mall' ? 7 : rb.look === 'warehouse' || rb.look === 'motel' ? 2 : 1);
      for (const l of rooms) {
        const n = rb.look === 'warehouse' ? this.rng.int(2, 4) : this.rng.int(1, 3);
        this.out.zombies.push({ x: l.x, z: l.z, n, spread: 1.4, kinds: this.rng.chance(0.15) ? ['walker', 'runner', 'brute'] : WALKER });
      }
    }
  }

  prop(kind: PropKind, x: number, z: number, yaw: number, scale = 1, tag?: number, sink = 0) {
    const p: PropSpawn = { kind, x, y: this.g(x, z) - sink, z, yaw, scale, seed: this.rng.int(0, 9999), tag };
    this.out.props.push(p);
    const r = HOST_PROPS[kind];
    if (r !== undefined) this.hosts.push({ kind, x, z, r: r * scale });
    return p;
  }

  // ------------------------------------------------------------------ what lies on the ground

  /** A named thing set down at (x, z): on the ground, or at height `y` on something. It lies at a fixed heading and never moves. */
  put(spec: LootSpec, x: number, z: number, host: PickupHost, o: { y?: number; yaw?: number; tilt?: [number, number] } = {}) {
    const k = pickupOf(spec);
    if (!k) return;
    this.out.pickups.push({ ...k, x, z, y: o.y ?? this.g(x, z), yaw: o.yaw ?? hash2(Math.round(x * 10), Math.round(z * 10), this.site.seed) * TAU, tilt: o.tilt, host });
  }

  /**
   * A thing from `context` on the ground beside a host (a pump, a car, a drum, a wall): within a couple of metres of its
   * edge, on clear ground off the road. False if there was no room.
   */
  beside(hostKind: string, hx: number, hz: number, hr: number, context: LootContext, o: { only?: LootTag[]; cap?: ItemSize; spec?: LootSpec | null; y?: number; within?: { x0: number; x1: number; z0: number; z1: number } } = {}): boolean {
    const spec = o.spec !== undefined ? o.spec : rollItem(context, this.loot, { progress: this.reach, only: o.only, cap: o.cap });
    if (!spec) return false;
    const foot = specFoot(spec);
    const half = Math.max(foot.w, foot.d) / 2 + 0.1;
    for (let t = 0; t < 10; t++) {
      const a = this.loot.range(0, TAU);
      const r = hr + half + this.loot.range(0.25, 1.4);
      const x = hx + Math.cos(a) * r;
      const z = hz + Math.sin(a) * r;
      // On a deck or another raised floor the spot must be on it; the ground rules (road, other solids) are for ground.
      if (o.within) {
        const w = o.within;
        if (x - half < w.x0 + 0.1 || x + half > w.x1 - 0.1 || z - half < w.z0 + 0.1 || z + half > w.z1 - 0.1) continue;
      } else if (!this.clearRoad(x - half, x + half, z - half, z + half, 5) || !this.free(x - half, x + half, z - half, z + half, 0.1)) continue;
      this.put(spec, x, z, { kind: hostKind, mode: 'beside', context }, { y: o.y });
      return true;
    }
    return false;
  }

  /** A thing beside one of the props of this kind placed so far (picked at random). */
  besideProp(kind: PropKind, context: LootContext, o: { only?: LootTag[]; cap?: ItemSize; y?: number } = {}): boolean {
    const hs = this.hosts.filter((h) => h.kind === kind);
    if (!hs.length) return false;
    const h = hs[Math.floor(this.loot.next() * hs.length) % hs.length];
    return this.beside(kind, h.x, h.z, h.r, context, o);
  }

  /** A thing on the ground against the outside wall of a building: stood beside the wall, a metre or so out. */
  besideBuilding(rb: RuralBuilding, context: LootContext, o: { only?: LootTag[]; cap?: ItemSize } = {}): boolean {
    const spec = rollItem(context, this.loot, { progress: this.reach, only: o.only, cap: o.cap });
    if (!spec) return false;
    const foot = specFoot(spec);
    const half = Math.max(foot.w, foot.d) / 2 + 0.1;
    const a = rb.aabb;
    for (let t = 0; t < 10; t++) {
      // A side of the footprint, a point along it, a step out from the wall.
      const side = this.loot.int(0, 3);
      const out = half + this.loot.range(0.45, 1.3);
      const u = this.loot.range(0.15, 0.85);
      const x = side < 2 ? (side === 0 ? a.minX - out : a.maxX + out) : a.minX + (a.maxX - a.minX) * u;
      const z = side < 2 ? a.minZ + (a.maxZ - a.minZ) * u : side === 2 ? a.minZ - out : a.maxZ + out;
      if (!this.clearRoad(x - half, x + half, z - half, z + half, 5) || !this.free(x - half - 0.1, x + half + 0.1, z - half - 0.1, z + half + 0.1, 0.1)) continue;
      this.put(spec, x, z, { kind: 'building', mode: 'beside', context });
      return true;
    }
    return false;
  }

  zombies(x: number, z: number, n: number, spread: number, kinds: ZombieKind[] = WALKER) {
    this.out.zombies.push({ x, z, n, spread, kinds });
  }

  /** A scattering of dead trees and debris inside the pad. */
  clutter(n: number, kinds: PropKind[], radius: number) {
    for (let i = 0; i < n; i++) {
      const a = this.rng.range(0, Math.PI * 2);
      const r = Math.sqrt(this.rng.next()) * radius;
      const x = this.cx + Math.cos(a) * r;
      const z = this.cz + Math.sin(a) * r;
      if (!this.clearRoad(x - 1.5, x + 1.5, z - 1.5, z + 1.5, 7) || !this.free(x - 1, x + 1, z - 1, z + 1, 1.2)) continue;
      this.prop(this.rng.pick(kinds), x, z, this.rng.range(0, 6.28), this.rng.range(0.85, 1.25));
    }
  }

  /** A car left standing: its condition comes from its seed and `grade`, and a part or a can may lie beside it. */
  wreck(x: number, z: number, grade?: CarGrade, loot = 0.4) {
    // The longest car is 5.3 m by 2 m; leave room for its mirrors and for the suspension to settle.
    const HL = 2.8;
    const HW = 1.2;
    const yaw0 = this.rng.range(0, 6.28);
    const seed = this.rng.int(0, 9999);
    // A car lying at an angle covers more ground than a box lying along z, and a wall it clips shoves it over on its side:
    // try the drawn yaw, then the ones square to it, and give up on the spot if none of them is clear.
    for (const yaw of [yaw0, yaw0 + Math.PI / 2, Math.round(yaw0 / (Math.PI / 2)) * (Math.PI / 2), Math.round(yaw0 / (Math.PI / 2)) * (Math.PI / 2) + Math.PI / 2]) {
      const s = Math.abs(Math.sin(yaw));
      const c = Math.abs(Math.cos(yaw));
      const hx = s * HL + c * HW;
      const hz = c * HL + s * HW;
      if (!this.clearRoad(x - hx, x + hx, z - hz, z + hz, 6) || !this.free(x - hx, x + hx, z - hz, z + hz, 0.5)) continue;
      this.carRects.push({ x0: x - hx, x1: x + hx, z0: z - hz, z1: z + hz });
      this.out.cars.push({ x, y: this.g(x, z), z, yaw, seed });
      return;
    }
  }

  run() {
    this.runSite();
  }

  private runSite() {
    switch (this.site.kind) {
      case 'gasStop':
        return this.gasStop();
      case 'hamlet':
        return this.hamlet();
      case 'motel':
        return this.motel();
      case 'farm':
        return this.farm();
      case 'depot':
        return this.depot();
      case 'overpass':
        return this.overpass();
      case 'windfarm':
        return this.windfarm();
      case 'mastHill':
        return this.mastHill();
      case 'hubDustwell':
        return this.hub(22, 6, 'Dustwell');
      case 'hubRustgate':
        return this.hub(36, 12, 'Rustgate');
      case 'hubHaven':
        return this.hub(44, 14, 'Haven');
      default:
        // Lakeside places and the ways underground live in lakeSites.ts.
        return lakeSite(this);
    }
  }

  // ------------------------------------------------------------------ places

  private gasStop() {
    const { cx, cz, tw, rng } = this;
    const px = cx + tw * 5;
    this.prop('canopy', px, cz, Math.PI / 2);
    for (const dx of [-3, 3]) for (const dz of [-6, 6]) this.solid('pillar', px + dx, cz + dz, 0.8, 0.8, 5.4);
    for (const dx of [-1.5, 1.5]) for (const dz of [-3.5, 3.5]) {
      this.prop('pump', px + dx, cz + dz, tw > 0 ? Math.PI / 2 : -Math.PI / 2);
      this.solid('crate', px + dx, cz + dz, 0.7, 0.7, 1.6);
    }
    const shop = this.building(cx - tw * 8, cz, 9, 16, 1, 'store', rng.pick([0, 2]), rng.pick(STUCCO), 'flat', { door: tw, use: 'gas_station' });
    // The forecourt workshop: a bay, a bench, engines on stands. Where there is no room, a lock-up shed.
    const bay = this.building(cx - tw * 11, cz + 22, 12, 12.5, 1, 'garage', 0, rng.pick(PANEL), 'gable', { door: tw, use: 'garage', margin: 3 });
    if (!bay) this.building(cx - tw * 9, cz + 20, 5, 6, 1, 'shack', 0, rng.pick(PANEL), 'gable', { door: tw });
    this.prop('gasSign', cx + tw * 15, cz - 13, 0);
    this.solid('pillar', cx + tw * 15, cz - 13, 0.8, 0.8, 14);
    this.wreck(cx + tw * 14, cz + 9);
    this.wreck(cx - tw * 2, cz - 22);
    this.prop('dumpster', cx - tw * 14.5, cz - 6, Math.PI / 2 * tw);
    this.prop('barrel', cx - tw * 13.5, cz + 7, 0);
    this.prop('tires', cx - tw * 15, cz + 12, 1);
    this.clutter(5, ['deadTree', 'rock', 'bones', 'barrel'], 34);
    // Fuel at the pumps (cans stood on the island), oil and a spare tyre by the shop wall and the tyre pile.
    this.besideProp('pump', 'gas_station', { only: ['fuel'] });
    this.besideProp('pump', 'gas_station', { only: ['fuel'] });
    if (rng.chance(0.5)) this.besideProp('pump', 'gas_station', { only: ['fuel'] });
    this.besideProp('barrel', 'gas_station', { only: ['fuel', 'oil'] });
    this.besideProp('tires', 'gas_station', { only: ['tyre'] });
    if (shop) {
      this.besideBuilding(shop, 'gas_station', { only: ['oil'] });
      if (rng.chance(0.6)) this.besideBuilding(shop, 'gas_station', { only: ['water', 'food'] });
    }
    this.besideProp('dumpster', 'house', { only: ['food'] });
    this.zombies(cx - tw * 6, cz, rng.int(3, 5), 8);
  }

  private hamlet() {
    const { cx, cz, tw, rng } = this;
    const R = this.site.radius * 0.8;
    let placed = 0;
    let twoStorey = false;
    // A street of houses either side of a spur, with the hall at the far end.
    const hall = this.building(cx - tw * 20, cz + 6, 11, 22, 1, 'store', 1, rng.pick(BRICK), 'gable', { ridgeX: false, door: tw, extra: 1.5 });
    if (hall) placed++;
    // The village garage, if it has one: a bay with an engine on a stand, a bench, shelves of parts.
    if (rng.chance(0.6)) {
      for (let i = 0; i < 20; i++) {
        const a = rng.range(0, Math.PI * 2);
        const r = Math.sqrt(rng.next()) * R;
        const g = this.building(cx + Math.cos(a) * r, cz + Math.sin(a) * r, 12, 13, 1, 'garage', 0, rng.pick(PANEL), 'gable', { door: rng.chance(0.7) ? this.tw : (-this.tw as 1 | -1), use: 'garage', margin: 5 });
        if (g) {
          placed++;
          break;
        }
      }
    }
    for (let i = 0; i < 40 && placed < 9; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = Math.sqrt(rng.next()) * R;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      const w = rng.range(7, 11);
      const d = rng.range(7, 10);
      const style = rng.pick([2, 2, 1, 0]);
      const tint = style === 2 ? rng.pick(STUCCO) : style === 1 ? rng.pick(BRICK) : rng.pick(PANEL);
      const roof = rng.pick(['gable', 'gable', 'gable', 'shed', 'none', 'none'] as const);
      // Every hamlet has at least one two-storey house.
      const b = this.building(x, z, Math.max(w, 8.5), Math.max(d, 8.5), twoStorey ? (rng.chance(0.35) ? 2 : 1) : 2, 'house', style, tint, roof, { door: rng.chance(0.7) ? this.tw : (-this.tw as 1 | -1), margin: 5 });
      if (b) {
        placed++;
        if (b.plan.levels > 1) twoStorey = true;
      }
    }
    for (const b of this.out.buildings) {
      const a = b.aabb;
      const mx = (a.minX + a.maxX) / 2;
      const mz = (a.minZ + a.maxZ) / 2;
      if (b.roof === 'none') this.prop('rubble', mx + (rng.next() - 0.5) * 3, mz + (rng.next() - 0.5) * 3, rng.range(0, 6));
      if (rng.chance(0.35)) this.prop('barrel', a.maxX + 1.2, mz + rng.range(-2, 2), 0);
    }
    this.prop('waterTower', cx + tw * -3, cz - R * 0.85, 0);
    this.solid('tower', cx - tw * 3, cz - R * 0.85, 6, 6, 14);
    this.prop('windpump', cx + tw * 14, cz + R * 0.8, rng.range(0, 6));
    this.solid('pillar', cx + tw * 14, cz + R * 0.8, 2.4, 2.4, 9);
    for (let i = 0; i < 3; i++) this.wreck(cx + rng.range(-R, R), cz + rng.range(-R, R));
    this.clutter(10, ['deadTree', 'deadTree', 'rock', 'bones', 'tires'], this.site.radius);
    // Cans stood by the drums behind the houses, and by the tyre piles.
    this.besideProp('barrel', 'house', { only: ['water', 'oil', 'fuel'] });
    this.besideProp('barrel', 'house', { only: ['water', 'oil', 'fuel'] });
    this.besideProp('tires', 'wreck', { only: ['tyre', 'oil'] });
    this.zombies(cx - tw * 8, cz, rng.int(4, 6), 14);
    this.zombies(cx + tw * 4, cz + 14, rng.int(2, 4), 10);
    if (this.rng.chance(0.4)) this.zombies(cx - tw * 18, cz + 6, 1, 3, ['brute']);
  }

  private motel() {
    const { cx, cz, tw, rng } = this;
    this.building(cx - tw * 4, cz + 2, 9, 34, 1, 'motel', 2, rng.pick(STUCCO), 'flat', { door: tw });
    this.building(cx - tw * 4, cz - 22, 12, 10, 1, 'store', 0, rng.pick(PANEL), 'gable', { door: tw, ridgeX: true, use: 'shop' });
    this.building(cx - tw * 4, cz + 26, 9, 14, 1, 'motel', 2, rng.pick(STUCCO), 'flat', { door: tw });
    this.prop('billboard', cx + tw * 17, cz - 8, tw * Math.PI / 2, 1, rng.int(0, 4));
    this.solid('pillar', cx + tw * 17, cz - 8, 1.2, 11, 11);
    // The car park: guests' cars, left where they were.
    for (let i = 0; i < 5; i++) this.wreck(cx + tw * rng.range(5, 12), cz + rng.range(-24, 28));
    this.prop('dumpster', cx - tw * 10.5, cz - 10, 0);
    this.prop('barrel', cx - tw * 10.5, cz + 8, 0);
    this.clutter(6, ['deadTree', 'rock', 'tires', 'bones'], 40);
    this.besideProp('dumpster', 'house', { only: ['food', 'med'] });
    this.besideProp('barrel', 'house', { only: ['water', 'oil', 'fuel'] });
    this.zombies(cx, cz - 4, rng.int(4, 6), 14);
  }

  private farm() {
    const { cx, cz, tw, rng } = this;
    this.building(cx - tw * 12, cz - 14, 14, 24, 1, 'barn', 0, 0x8a3a2c, 'gable', { ridgeX: false, door: tw, margin: 5, use: 'farm' });
    this.building(cx + tw * 6, cz + 14, 10, 9, 1, 'house', 2, rng.pick(STUCCO), 'gable', { door: tw, margin: 5 });
    this.building(cx - tw * 10, cz + 22, 6, 6, 1, 'shack', 0, rng.pick(PANEL), 'shed', { margin: 4 });
    for (const dz of [10, 18]) {
      if (!this.free(cx - tw * 20 - 3.5, cx - tw * 20 + 3.5, cz + dz - 3.5, cz + dz + 3.5, 2)) continue;
      this.prop('silo', cx - tw * 20, cz + dz, 0);
      this.solid('tower', cx - tw * 20, cz + dz, 6.4, 6.4, 14);
    }
    this.prop('windpump', cx + tw * 20, cz - 8, rng.range(0, 6));
    this.solid('pillar', cx + tw * 20, cz - 8, 2.4, 2.4, 9);
    this.prop('fence', cx + tw * 14, cz + 30, 0, 2);
    // The farm's own dead machines: a pickup, and a van that went to market.
    this.wreck(cx + tw * 4, cz - 4, 'donor');
    this.wreck(cx + tw * 14, cz - 24);
    this.prop('barrel', cx - tw * 22, cz - 10, 0);
    this.prop('barrel', cx - tw * 22.8, cz - 9, 0);
    this.prop('tires', cx + tw * 9, cz - 12, 2);
    this.clutter(8, ['deadTree', 'rock', 'tires', 'barrel', 'bones'], 52);
    // Diesel and oil by the drums behind the barn, a tyre by the pile.
    this.besideProp('barrel', 'farm', { only: ['fuel', 'oil'] });
    this.besideProp('barrel', 'farm', { only: ['fuel', 'water'] });
    this.besideProp('tires', 'farm', { only: ['tyre'] });
    this.zombies(cx - tw * 2, cz + 4, rng.int(2, 4), 14);
  }

  private depot() {
    const { cx, cz, tw, rng } = this;
    this.building(cx - tw * 8, cz - 18, 20, 44, 1, 'warehouse', 0, rng.pick(PANEL), 'flat', { door: tw, margin: 5, use: 'depot' });
    this.building(cx - tw * 8, cz + 22, 18, 22, 1, 'warehouse', 0, rng.pick(PANEL), 'gable', { ridgeX: false, door: tw, margin: 5, extra: 1.4, use: 'depot' });
    // Container yard.
    for (let i = 0; i < 12; i++) {
      const x = cx + tw * rng.range(8, 24);
      const z = cz + rng.range(-34, 34);
      const sideways = rng.chance(0.5);
      const w = sideways ? 2.5 : 6.1;
      const d = sideways ? 6.1 : 2.5;
      if (!this.clearRoad(x - w / 2, x + w / 2, z - d / 2, z + d / 2, 10) || !this.free(x - w / 2, x + w / 2, z - d / 2, z + d / 2, 1)) continue;
      const stack = rng.chance(0.35);
      this.prop('container', x, z, sideways ? 0 : Math.PI / 2, 1, rng.int(0, 5));
      this.solid('crate', x, z, w, d, stack ? 5.3 : 2.65).mat = 'sheet';
      if (stack) this.prop('container', x, z, sideways ? 0 : Math.PI / 2, 1, rng.int(0, 5), -2.65);
    }
    this.prop('fuelTank', cx - tw * 30, cz - 4, 0);
    this.solid('tower', cx - tw * 30, cz - 4, 9.6, 9.6, 9);
    this.prop('fuelTank', cx - tw * 30, cz + 12, 1);
    this.solid('tower', cx - tw * 30, cz + 12, 9.6, 9.6, 9);
    this.clutter(6, ['deadTree', 'rock', 'barrel', 'tires', 'crateStack'], 56);
    // The yard: what came off the containers is stood beside them, fuel by the tanks, a tyre by the pile.
    for (let i = 0; i < 3; i++) this.besideProp('container', 'container');
    this.besideProp('fuelTank', 'depot', { only: ['fuel'] });
    this.besideProp('fuelTank', 'depot', { only: ['fuel', 'oil'] });
    this.besideProp('crateStack', 'depot');
    this.besideProp('tires', 'depot', { only: ['tyre'] });
    this.zombies(cx - tw * 6, cz - 16, rng.int(3, 5), 16);
    this.zombies(cx + tw * 6, cz + 16, rng.int(2, 4), 12);
  }

  /**
   * A named hub: a walled compound of welded shipping containers, stacked two high, with a gate on the side that faces
   * the highway and a market, a workshop and a water tower inside. Nobody lives here who wants the convoy dead. The workshop is
   * a real garage (the Mechanic's), with the spare engines and tyres a convoy needs to get going.
   */
  private hub(half: number, perSide: number, name: string) {
    const { cx, cz, tw, rng } = this;
    const gate = 5;
    const boxAt = (x: number, z: number, sideways: boolean, stack: boolean) => {
      const w = sideways ? 2.5 : 6.1;
      const d = sideways ? 6.1 : 2.5;
      this.prop('container', x, z, sideways ? 0 : Math.PI / 2, 1, rng.int(0, 5));
      this.solid('crate', x, z, w, d, stack ? 5.3 : 2.65).mat = 'sheet';
      if (stack) this.prop('container', x, z, sideways ? 0 : Math.PI / 2, 1, rng.int(0, 5), -2.65);
    };
    const step = (half * 2) / perSide;
    for (let i = 0; i <= perSide; i++) {
      const t = -half + i * step;
      // North and south walls run along x; east and west run along z. The gate is in the wall facing the road.
      for (const sz of [-1, 1]) boxAt(cx + t, cz + sz * half, false, rng.chance(0.7));
      for (const sx of [-1, 1]) {
        if (sx === tw && Math.abs(t) < gate + 2) continue;
        boxAt(cx + sx * half, cz + t, true, rng.chance(0.7));
      }
    }
    // The gate: a banner over it and a pair of barrels either side.
    this.prop('banner', cx + tw * half, cz, tw > 0 ? Math.PI / 2 : -Math.PI / 2, 1.6, 4);
    for (const dz of [-gate - 1, gate + 1]) this.prop('barrel', cx + tw * (half + 2), cz + dz, 0);
    // A water tower in the middle, a workshop, a stall or two and stores.
    this.prop('waterTower', cx - tw * (half * 0.35), cz - half * 0.3, 0);
    this.solid('tower', cx - tw * (half * 0.35), cz - half * 0.3, 6.4, 6.4, 12);
    const workshop = this.building(cx - tw * (half * 0.25), cz + half * 0.42, Math.min(half * 0.62, 17), Math.max(10.5, half * 0.46), 1, 'garage', 0, rng.pick(PANEL), 'gable', { door: tw, margin: 1, use: 'garage' });
    if (workshop) this.starterKit(workshop);
    if (half > 30) {
      this.building(cx + tw * (half * 0.2), cz + half * 0.55, 12, 9, 1, 'store', 2, rng.pick(STUCCO), 'flat', { door: tw, margin: 4, use: 'shop' });
      this.building(cx + tw * (half * 0.3), cz - half * 0.55, 10, 8, 1, 'tyreshop', 0, rng.pick(PANEL), 'gable', { door: tw, margin: 4, use: 'tyreshop' });
    } else this.building(cx + tw * (half * 0.3), cz - half * 0.5, 7, 6, 1, 'shack', 0, rng.pick(PANEL), 'gable', { door: tw, margin: 4 });
    const stalls = half > 30 ? 4 : 2;
    for (let i = 0; i < stalls; i++) {
      const x = cx + tw * (half * 0.5) - tw * 0;
      const z = cz - half * 0.5 + (i + 0.5) * ((half * 1.0) / stalls) + rng.range(-1, 1);
      if (!this.free(x - 3, x + 3, z - 3, z + 3, 1.5)) continue;
      this.prop('canopy', x, z, Math.PI / 2, 0.8);
      this.prop('crateStack', x + 1, z + 1.5, rng.range(0, 6), 1, 2);
    }
    // The market: goods stood by the stalls' crates, a can by the gate drums.
    this.besideProp('crateStack', 'shop');
    this.besideProp('crateStack', 'shop', { only: ['food', 'water', 'med'] });
    this.besideProp('barrel', 'gas_station', { only: ['fuel'] });
    void name;
  }

  /**
   * The workshop of a named hub keeps what a convoy that has only mopeds needs to get a runner on the road: an engine on a
   * stand, a radiator and a gearbox on the bench, and tyres on the rack. Put on the furniture there is, so nothing floats.
   */
  private starterKit(rb: RuralBuilding) {
    const plan = rb.plan;
    const want: LootTag[] = ['engine', 'radiator', 'gearbox', 'tyre', 'tyre'];
    const rng = new Rng(this.site.seed ^ 0x57a77);
    for (const tag of want) {
      // A free surface that suits the part: the stand for an engine, the rack for tyres, else the bench or the shelving.
      const kinds = tag === 'engine' ? ['enginestand', 'workbench'] : tag === 'tyre' ? ['tyrerack', 'tyrestack', 'partsshelf'] : ['workbench', 'partsshelf', 'pallet'];
      let done = false;
      for (const kind of kinds) {
        for (let fi = 0; fi < plan.furn.length && !done; fi++) {
          const f = plan.furn[fi];
          if (f.kind !== kind) continue;
          const spec = rollItem('garage', rng, { progress: 0, depth: 0, only: [tag] });
          if (!spec || spec.kind !== 'part') continue;
          const slots = furnSlots(f);
          const si = slots.findIndex((s, i) => !f.used?.includes(i) && !s.floor && (!s.only || s.only.includes(tag)) && fitsSlot(spec, s));
          if (si < 0) continue;
          const sl = slots[si];
          const { x, z } = slotWorld(f, sl);
          this.out.pickups.push({ ...pickupOf(spec)!, x, z, y: levelBase(plan, f.level) + sl.y, yaw: f.yaw + (rng.chance(0.5) ? 0 : Math.PI), host: { kind: f.kind, mode: 'on', context: 'garage' } });
          (f.used ??= []).push(si);
          done = true;
        }
        if (done) break;
      }
    }
  }

  private overpass() {
    const { def, cz, rng } = this;
    const rx = roadX(def, cz);
    const yaw = Math.atan(roadSlope(def, cz));
    const cs = Math.cos(yaw);
    const sn = Math.sin(yaw);
    this.out.props.push({ kind: 'overpass', x: rx, y: heightAt(def, rx, cz), z: cz, yaw, scale: 1, seed: this.site.seed });
    for (const lx of [-15, 15]) for (const lz of [-4, 0, 4]) {
      const x = rx + lx * cs + lz * sn;
      const z = cz - lx * sn + lz * cs;
      this.solid('pillar', x, z, 2.1, 2.1, 6.2);
    }
    // The pile-up under the bridge: wrecks and donors, with what the drivers had in their boots beside them.
    for (let i = 0; i < 3; i++) {
      const lx = rng.range(-9, 9);
      const lz = rng.range(-5, 5);
      this.wreck(rx + lx * cs + lz * sn + rng.sign() * 6, cz - lx * sn + lz * cs, i === 0 ? 'donor' : undefined, 0.6);
    }
    this.zombies(rx + 12, cz + 8, rng.int(2, 3), 8);
  }

  private windfarm() {
    const { def, site, rng } = this;
    const n = rng.int(6, 8);
    const span = 340;
    for (let i = 0; i < n; i++) {
      const z = site.z - span / 2 + (i / (n - 1)) * span + rng.range(-14, 14);
      const ch = corridorHalf(def, z);
      if (ch < 150) continue;
      const off = Math.min(site.off + rng.range(-14, 14) + (i % 2) * 22, ch - 32);
      const x = roadX(def, z) + site.side * off;
      if (def.sites.some((s) => s !== site && s.radius > 0 && Math.hypot(s.x - x, s.z - z) < s.radius + 14)) continue;
      this.prop('windTurbine', x, z, rng.range(0, 0.4), 1, undefined, 0.5);
      this.solid('tower', x, z, 3, 3, 8);
    }
    // The maintenance hut at the middle of the farm, with the crew's tools and a spare part or two.
    this.building(site.x, site.z, 6.5, 6, 1, 'shack', 0, rng.pick(PANEL), 'gable', { door: this.tw, margin: 2, use: 'garage' });
  }

  private mastHill() {
    const { cx, cz, tw, rng } = this;
    this.prop('mast', cx, cz, 0);
    this.solid('tower', cx, cz, 5, 5, 12);
    this.building(cx + 9, cz - 6, 6, 6, 1, 'shack', 0, rng.pick(PANEL), 'gable', { door: tw, use: 'garage' });
    this.prop('barrel', cx + 5, cz + 7, 0);
    this.prop('barrel', cx + 6.2, cz + 7.6, 0);
    this.prop('crateStack', cx - 8, cz + 5, rng.range(0, 6), 1, 2);
    this.clutter(3, ['rock', 'deadTree'], 24);
    // The engineers' supplies: a generator's fuel by the drums, spares by the crates.
    this.besideProp('barrel', 'cache', { only: ['fuel', 'oil'] });
    this.besideProp('crateStack', 'cache');
    this.zombies(cx + 4, cz, rng.int(2, 3), 8);
  }
}

export function buildSite(ctx: SiteCtx, site: Site): SiteContent {
  const sb = new SiteBuilder(ctx, site);
  sb.run();
  return sb.out;
}

/**
 * The things that fill the road between places: power lines, billboards, lone water towers and windpumps.
 * All of them are landmarks, visible from far down the road.
 */
export function buildRoadside(ctx: SiteCtx, leg: LegDef): SiteContent {
  const out = empty();
  const def = ctx.def;
  const rng = new Rng(leg.seed * 17 + 3);
  const free = keepOutZ(def, leg);
  const nearSite = (x: number, z: number, pad = 10) => def.sites.some((s) => Math.hypot(s.x - x, s.z - z) < Math.max(s.radius, s.kind === 'windfarm' ? 40 : 0) + pad + (s.kind === 'windfarm' ? 120 : 0));
  const overpass = (z: number) => def.sites.some((s) => s.kind === 'overpass' && Math.abs(s.z - z) < 40);
  const g = (x: number, z: number) => heightAt(def, x, z);
  const aabb = (kind: AabbKind, x: number, z: number, w: number, d: number, h: number) => {
    const base = g(x, z);
    out.aabbs.push({ id: ctx.newId(), minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, y0: base - 1, y1: base + h, kind, hp: 99999 });
  };
  // Power lines: two or three runs per leg, 36 to 44 m off the road.
  const runs = leg.length > 3700 ? 3 : 2;
  for (let r = 0; r < runs; r++) {
    const z0 = 240 + (r + rng.range(0.1, 0.7)) * ((leg.length - 700) / runs);
    const len = rng.range(560, 900);
    const side = rng.sign();
    const off = rng.range(36, 44);
    const pts: { x: number; z: number }[] = [];
    for (let z = z0; z < z0 + len && z < leg.length - 150; z += 60) {
      if (!free(z) || overpass(z)) {
        if (pts.length > 1) break;
        pts.length = 0;
        continue;
      }
      const x = roadX(def, z) + side * off;
      if (nearSite(x, z, 12) || corridorHalf(def, z) < off + 40) {
        if (pts.length > 1) break;
        pts.length = 0;
        continue;
      }
      pts.push({ x, z });
    }
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const nxt = pts[i + 1] ?? { x: p.x + (p.x - (pts[i - 1]?.x ?? p.x)), z: p.z + 60 };
      const prv = pts[i - 1] ?? { x: p.x - (nxt.x - p.x), z: p.z - (nxt.z - p.z) };
      // Face the tower across the line (arms perpendicular to the wires).
      const yawLine = Math.atan2(nxt.x - prv.x, nxt.z - prv.z);
      out.props.push({ kind: 'powerTower', x: p.x, y: g(p.x, p.z) - 0.3, z: p.z, yaw: yawLine, scale: 1, seed: i });
      aabb('pillar', p.x, p.z, 1.6, 1.6, 26);
      if (pts[i + 1]) {
        const q = pts[i + 1];
        const dx = q.x - p.x;
        const dz = q.z - p.z;
        out.props.push({ kind: 'powerSpan', x: p.x, y: g(p.x, p.z) - 0.3, z: p.z, yaw: Math.atan2(dx, dz), scale: Math.hypot(dx, dz), seed: 0, dy: g(q.x, q.z) - g(p.x, p.z) });
      }
    }
  }
  // Billboards facing the road.
  const nb = Math.floor(leg.length / 1100);
  for (let i = 0; i < nb; i++) {
    for (let t = 0; t < 12; t++) {
      const z = 380 + (i + rng.range(0.1, 0.9)) * ((leg.length - 700) / nb);
      const side = rng.sign();
      const x = roadX(def, z) + side * rng.range(17, 23);
      if (!free(z) || nearSite(x, z, 16) || overpass(z)) continue;
      out.props.push({ kind: 'billboard', x, y: g(x, z), z, yaw: -side * (Math.PI / 2), scale: 1, seed: rng.int(0, 99), tag: rng.int(0, 4) });
      aabb('pillar', x, z, 1.2, 11, 11);
      break;
    }
  }
  // Lone landmarks out in the open: windpumps, water towers, a wrecked radio mast.
  const kinds: PropKind[] = ['windpump', 'waterTower', 'windpump', 'mast', 'silo'];
  const nl = Math.floor(leg.length / 650);
  for (let i = 0; i < nl; i++) {
    for (let t = 0; t < 12; t++) {
      const z = 300 + (i + rng.range(0.1, 0.9)) * ((leg.length - 600) / nl);
      const side = rng.sign();
      const ch = corridorHalf(def, z);
      const off = rng.range(45, Math.max(60, Math.min(130, ch - 50)));
      const x = roadX(def, z) + side * off;
      if (!free(z) || nearSite(x, z, 30) || ch < 190) continue;
      const kind = rng.pick(kinds);
      out.props.push({ kind, x, y: g(x, z), z, yaw: rng.range(0, 6.28), scale: 1, seed: rng.int(0, 99) });
      aabb('tower', x, z, kind === 'windpump' ? 2.4 : kind === 'mast' ? 5 : 6.4, kind === 'windpump' ? 2.4 : kind === 'mast' ? 5 : 6.4, 12);
      if (rng.chance(0.5)) out.props.push({ kind: 'deadTree', x: x + 6, y: g(x + 6, z), z: z + 3, yaw: rng.range(0, 6), scale: 1.2, seed: rng.int(0, 99) });
      break;
    }
  }
  return out;
}
