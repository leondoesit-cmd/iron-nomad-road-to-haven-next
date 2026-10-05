import { partDef, type ZombieKind } from '../data';
import { rollPartSpec } from '../sim/parts';
import { OIL_CAN } from '../sim/oil';
import type { LegDef } from '../data';
import { Rng } from '../core/rng';
import { corridorHalf, heightAt, keepOutZ, roadX, roadSlope, type Site, type TerrainDef } from './terrain';
import type { Aabb, AabbKind, PickupKind, PropKind, PropSpawn, ScavContainer, ScavZone } from './layout';
import { generatePlan, levelBase, planAabbs, type BuildingPlan, type Look } from './interiors';
import { lakeSite } from './lakeSites';

/**
 * Roadside places for the wasteland: gas stops, hamlets, a motel, a farm, a depot yard, a broken overpass, a wind
 * farm and a radio hill, plus the power lines, billboards and lone landmarks that fill the gaps between them.
 * Everything is derived from the leg seed, so a leg always has the same places in the same spots.
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
  x: number;
  z: number;
  y: number;
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

export class SiteBuilder {
  out = empty();
  rng: Rng;
  /** Direction toward the road along x. */
  tw: 1 | -1;
  cx: number;
  cz: number;

  constructor(
    private ctx: SiteCtx,
    public site: Site,
  ) {
    this.rng = new Rng(site.seed);
    this.tw = (-site.side) as 1 | -1;
    this.cx = site.x;
    this.cz = site.z;
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

  building(cx: number, cz: number, w: number, d: number, floors: number, look: Look, style: number, tint: number, roof: RuralBuilding['roof'], opts: { ridgeX?: boolean; margin?: number; door?: 1 | -1; extra?: number; wear?: number } = {}) {
    const x0 = cx - w / 2;
    const x1 = cx + w / 2;
    const z0 = cz - d / 2;
    const z1 = cz + d / 2;
    if (!this.clearRoad(x0, x1, z0, z1, 11)) return null;
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
    const rooftop = look === 'barn' || look === 'warehouse' ? 'gable' : roof;
    const extStyle = look === 'barn' ? 14 : look === 'warehouse' ? 16 : style === 1 ? 11 : style === 2 ? 12 : look === 'house' || look === 'shack' ? 14 : 10;
    const color = look === 'warehouse' ? this.rng.pick(METAL) : extStyle === 14 && look !== 'barn' ? this.rng.pick(SIDING) : tint;
    const wear = opts.wear ?? (this.site.kind === 'hamlet' ? 0.3 + this.rng.next() * 0.5 : 0.12 + this.rng.next() * 0.4);
    const seed = this.rng.int(1, 99999);
    const plan = generatePlan({ x0, x1, z0, z1, look, door, seed, floors, floorY, wear, roof: rooftop });
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

  /** Searchable furniture becomes a loot zone; some rooms hold the dead. */
  private furnish(rb: RuralBuilding, w: number, d: number) {
    const plan = rb.plan;
    const bi = this.bi++;
    const containers: ScavContainer[] = [];
    plan.furn.forEach((f, i) => {
      if (!f.loot) return;
      containers.push({ id: `${this.def.seed}:${this.site.kind}${Math.round(this.site.z)}:${bi}:${i}`, x: f.x, z: f.z, depth: f.depth ?? 0, loot: f.loot, drugs: f.drugs, taken: false, label: f.label, y: levelBase(plan, f.level) + f.h + 0.55 });
    });
    const cx = (plan.x0 + plan.x1) / 2;
    const cz = (plan.z0 + plan.z1) / 2;
    if (containers.length) {
      this.out.zones.push({ id: `${this.def.seed}:${this.site.kind}${Math.round(this.site.z)}:z${bi}`, kind: rb.look, x: cx, z: cz, w, d, open: this.tw, containers, pin: false });
    }
    // The dead who never left: more in warehouses and shops, fewer in barns and sheds.
    const odds: Record<Look, number> = { house: 0.55, store: 0.7, motel: 0.6, barn: 0.35, warehouse: 0.85, shack: 0.3 };
    if (this.rng.next() < odds[rb.look] && plan.lairs.length) {
      const rooms = this.rng.shuffle([...plan.lairs]).slice(0, rb.look === 'warehouse' || rb.look === 'motel' ? 2 : 1);
      for (const l of rooms) {
        const n = rb.look === 'warehouse' ? this.rng.int(2, 4) : this.rng.int(1, 3);
        this.out.zombies.push({ x: l.x, z: l.z, n, spread: 1.4, kinds: this.rng.chance(0.15) ? ['walker', 'runner', 'brute'] : WALKER });
      }
    }
  }

  prop(kind: PropKind, x: number, z: number, yaw: number, scale = 1, tag?: number, sink = 0) {
    const p: PropSpawn = { kind, x, y: this.g(x, z) - sink, z, yaw, scale, seed: this.rng.int(0, 9999), tag };
    this.out.props.push(p);
    return p;
  }

  pickup(kind: PickupKind, x: number, z: number, amount: number) {
    this.out.pickups.push({ kind, amount, x, z, y: this.g(x, z) });
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

  wreck(x: number, z: number) {
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
    this.partLoot();
    this.fluidLoot();
  }

  /** Oil and spare fuel for the cars: a gas stop and a yard keep the most, most other places have a can somewhere. */
  private fluidLoot() {
    if (this.site.radius <= 0) return;
    const kind = this.site.kind;
    // Its own stream, so adding cans never shifts the layout of anything else.
    const rng = new Rng(Math.floor(this.cx * 29 + this.cz * 13) ^ 0x011c);
    const oil = kind === 'gasStop' ? 3 : kind === 'depot' ? 2 : rng.chance(0.55) ? 1 : 0;
    const fuel = kind === 'gasStop' ? 1 : kind === 'depot' || kind === 'farm' ? (rng.chance(0.5) ? 1 : 0) : 0;
    const R = Math.max(8, this.site.radius * 0.55);
    const put = (what: 'oil' | 'fuel') => {
      for (let tries = 0; tries < 6; tries++) {
        const a = rng.range(0, Math.PI * 2);
        const r = Math.sqrt(rng.next()) * R;
        const x = this.cx + Math.cos(a) * r;
        const z = this.cz + Math.sin(a) * r;
        if (!this.clearRoad(x - 1, x + 1, z - 1, z + 1, 6)) continue;
        this.out.pickups.push({ kind: what, amount: what === 'oil' ? OIL_CAN : 5, x, y: this.g(x, z), z });
        return;
      }
    };
    for (let i = 0; i < oil; i++) put('oil');
    for (let i = 0; i < fuel; i++) put('fuel');
  }

  /** Vehicle parts lying around: a yard has the best of them, every other place has one worth finding. */
  private partLoot() {
    if (this.site.radius <= 0) return;
    const depot = this.site.kind === 'depot';
    const n = depot ? 2 : 1;
    const R = Math.max(8, this.site.radius * 0.55);
    // Its own stream, so adding loot never shifts the layout of anything else.
    const rng = new Rng(Math.floor(this.cx * 31 + this.cz * 17) ^ 0x7a57);
    for (let i = 0; i < n; i++) {
      const spec = rollPartSpec(rng, { minMk: 1, maxMk: depot ? 3 : 2, bias: depot ? 0.4 : 0 });
      const a = rng.range(0, Math.PI * 2);
      const r = Math.sqrt(rng.next()) * R;
      const x = this.cx + Math.cos(a) * r;
      const z = this.cz + Math.sin(a) * r;
      if (!this.clearRoad(x - 1, x + 1, z - 1, z + 1, 6)) continue;
      this.out.pickups.push({ kind: 'part', amount: partDef(spec.id).mk, part: spec, x, y: this.g(x, z), z });
    }
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
    this.building(cx - tw * 8, cz, 9, 16, 1, 'store', rng.pick([0, 2]), rng.pick(STUCCO), 'flat', { door: tw });
    this.building(cx - tw * 9, cz + 20, 5, 6, 1, 'shack', 0, rng.pick(PANEL), 'gable', { door: tw });
    this.prop('gasSign', cx + tw * 15, cz - 13, 0);
    this.solid('pillar', cx + tw * 15, cz - 13, 0.8, 0.8, 14);
    this.wreck(cx + tw * 14, cz + 9);
    this.wreck(cx - tw * 2, cz - 22);
    this.prop('dumpster', cx - tw * 14.5, cz - 6, Math.PI / 2 * tw);
    this.prop('barrel', cx - tw * 13.5, cz + 7, 0);
    this.prop('tires', cx - tw * 15, cz + 12, 1);
    this.clutter(5, ['deadTree', 'rock', 'bones', 'barrel'], 34);
    this.pickup('fuel', px + 1.5, cz + 1.5, 5);
    this.pickup('fuel', cx - tw * 3, cz + 22, 5);
    this.pickup('scrap', cx - tw * 13, cz + 2, rng.int(8, 12));
    this.pickup('parts', cx - tw * 10.5, cz - 10, rng.int(4, 8));
    if (rng.chance(0.5)) this.pickup('rations', cx - tw * 8, cz + 3, 1);
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
    this.pickup('scrap', cx + rng.range(-12, 12), cz + rng.range(-12, 12), rng.int(8, 14));
    this.pickup('scrap', cx + rng.range(-20, 20), cz + rng.range(-20, 20), rng.int(8, 14));
    this.pickup('parts', cx + rng.range(-16, 16), cz + rng.range(-16, 16), rng.int(5, 9));
    this.pickup('rations', cx - tw * 17, cz + 3, 1);
    this.pickup('medicine', cx + rng.range(-15, 15), cz + rng.range(-15, 15), 1);
    if (rng.chance(0.6)) this.pickup('fuel', cx + rng.range(-20, 20), cz + rng.range(-20, 20), 5);
    this.zombies(cx - tw * 8, cz, rng.int(4, 6), 14);
    this.zombies(cx + tw * 4, cz + 14, rng.int(2, 4), 10);
    if (this.rng.chance(0.4)) this.zombies(cx - tw * 18, cz + 6, 1, 3, ['brute']);
  }

  private motel() {
    const { cx, cz, tw, rng } = this;
    this.building(cx - tw * 4, cz + 2, 9, 34, 1, 'motel', 2, rng.pick(STUCCO), 'flat', { door: tw });
    this.building(cx - tw * 4, cz - 22, 12, 10, 1, 'store', 0, rng.pick(PANEL), 'gable', { door: tw, ridgeX: true });
    this.building(cx - tw * 4, cz + 26, 9, 14, 1, 'motel', 2, rng.pick(STUCCO), 'flat', { door: tw });
    this.prop('billboard', cx + tw * 17, cz - 8, tw * Math.PI / 2, 1, rng.int(0, 4));
    this.solid('pillar', cx + tw * 17, cz - 8, 1.2, 11, 11);
    for (let i = 0; i < 5; i++) this.wreck(cx + tw * rng.range(5, 12), cz + rng.range(-24, 28));
    this.prop('dumpster', cx - tw * 10.5, cz - 10, 0);
    this.prop('barrel', cx - tw * 10.5, cz + 8, 0);
    this.clutter(6, ['deadTree', 'rock', 'tires', 'bones'], 40);
    this.pickup('medicine', cx - tw * 8.5, cz + 4, 1);
    this.pickup('rations', cx - tw * 8.5, cz - 14, 1);
    this.pickup('scrap', cx + tw * 9, cz + 8, rng.int(8, 14));
    this.pickup('parts', cx + tw * 10, cz - 14, rng.int(5, 9));
    this.zombies(cx, cz - 4, rng.int(4, 6), 14);
  }

  private farm() {
    const { cx, cz, tw, rng } = this;
    this.building(cx - tw * 12, cz - 14, 14, 24, 1, 'barn', 0, 0x8a3a2c, 'gable', { ridgeX: false, door: tw, margin: 5 });
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
    this.wreck(cx + tw * 4, cz - 4);
    this.wreck(cx + tw * 14, cz - 24);
    this.clutter(8, ['deadTree', 'rock', 'tires', 'barrel', 'bones'], 52);
    this.pickup('fuel', cx - tw * 3, cz - 4, 5);
    this.pickup('parts', cx + tw * 12, cz + 14, rng.int(5, 9));
    this.pickup('scrap', cx - tw * 8, cz + 14, rng.int(8, 14));
    this.pickup('rations', cx + tw * 6, cz + 10, 1);
    this.zombies(cx - tw * 2, cz + 4, rng.int(2, 4), 14);
  }

  private depot() {
    const { cx, cz, tw, rng } = this;
    this.building(cx - tw * 8, cz - 18, 20, 44, 1, 'warehouse', 0, rng.pick(PANEL), 'flat', { door: tw, margin: 5 });
    this.building(cx - tw * 8, cz + 22, 18, 22, 1, 'warehouse', 0, rng.pick(PANEL), 'gable', { ridgeX: false, door: tw, margin: 5, extra: 1.4 });
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
    this.pickup('parts', cx - tw * 22, cz - 12, rng.int(9, 14));
    this.pickup('parts', cx + tw * 6, cz + 16, rng.int(6, 10));
    this.pickup('scrap', cx + tw * 3, cz - 20, rng.int(10, 16));
    this.pickup('scrap', cx - tw * 21, cz + 20, rng.int(10, 16));
    this.pickup('fuel', cx - tw * 22, cz + 4, 5);
    if (rng.chance(0.6)) this.pickup('tech', cx - tw * 18, cz - 30, rng.int(1, 2));
    this.zombies(cx - tw * 6, cz - 16, rng.int(3, 5), 16);
    this.zombies(cx + tw * 6, cz + 16, rng.int(2, 4), 12);
  }

  /**
   * A named hub: a walled compound of welded shipping containers, stacked two high, with a gate on the side that faces
   * the highway and a market, a workshop and a water tower inside. Nobody lives here who wants the convoy dead.
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
    this.building(cx - tw * (half * 0.45), cz + half * 0.4, half * 0.7, half * 0.5, 1, 'warehouse', 0, rng.pick(PANEL), 'gable', { door: tw, margin: 4 });
    if (half > 30) {
      this.building(cx + tw * (half * 0.2), cz + half * 0.55, 12, 9, 1, 'store', 2, rng.pick(STUCCO), 'flat', { door: tw, margin: 4 });
      this.building(cx + tw * (half * 0.3), cz - half * 0.55, 10, 8, 1, 'house', 2, rng.pick(STUCCO), 'gable', { door: tw, margin: 4 });
    } else this.building(cx + tw * (half * 0.3), cz - half * 0.5, 7, 6, 1, 'shack', 0, rng.pick(PANEL), 'gable', { door: tw, margin: 4 });
    const stalls = half > 30 ? 4 : 2;
    for (let i = 0; i < stalls; i++) {
      const x = cx + tw * (half * 0.5) - tw * 0;
      const z = cz - half * 0.5 + (i + 0.5) * ((half * 1.0) / stalls) + rng.range(-1, 1);
      if (!this.free(x - 3, x + 3, z - 3, z + 3, 1.5)) continue;
      this.prop('canopy', x, z, Math.PI / 2, 0.8);
      this.prop('crateStack', x + 1, z + 1.5, rng.range(0, 6), 1, 2);
    }
    this.pickup('scrap', cx, cz + 4, rng.int(14, 20));
    this.pickup('fuel', cx - tw * 6, cz - 6, 5);
    this.pickup('parts', cx + tw * 4, cz + 8, rng.int(8, 12));
    if (half > 30) this.pickup('tech', cx - tw * 10, cz + 10, rng.int(2, 3));
    void name;
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
    for (let i = 0; i < 3; i++) {
      const lx = rng.range(-9, 9);
      const lz = rng.range(-5, 5);
      this.wreck(rx + lx * cs + lz * sn + rng.sign() * 6, cz - lx * sn + lz * cs);
    }
    this.pickup('scrap', rx + 8 * cs, cz - 8 * sn, rng.int(8, 14));
    this.pickup('parts', rx - 11 * cs + 5, cz + 11 * sn, rng.int(4, 8));
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
    this.pickup('scrap', site.x, site.z, rng.int(10, 16));
  }

  private mastHill() {
    const { cx, cz, tw, rng } = this;
    this.prop('mast', cx, cz, 0);
    this.solid('tower', cx, cz, 5, 5, 12);
    this.building(cx + 9, cz - 6, 6, 6, 1, 'shack', 0, rng.pick(PANEL), 'gable', { door: tw });
    this.prop('barrel', cx + 5, cz + 7, 0);
    this.prop('barrel', cx + 6.2, cz + 7.6, 0);
    this.prop('crateStack', cx - 8, cz + 5, rng.range(0, 6), 1, 2);
    this.clutter(3, ['rock', 'deadTree'], 24);
    this.pickup('tech', cx - 8, cz + 2, rng.int(1, 3));
    this.pickup('parts', cx + 9, cz + 1, rng.int(5, 9));
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
