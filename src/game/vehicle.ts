import * as THREE from 'three';
import { VehicleBody, defaultEnv, rotateByQuat, type DriveEnv, type DriveInput } from '../physics/vehicle';
import { RAPIER } from '../physics/physics';
import { BoatBody, type Chassis } from '../physics/boat';
import { buildBoatVisual, type BoatVisual } from '../render/boatModels';
import { boatFx, waterTick } from './waterfx';
import { applyHit, collisionDamage, facingOf, newHealth, performance, repairStep, tickHazards, type DamageEvent, type HitZone, type VehicleHealth } from '../sim/damage';
import { effectiveStats, terrainDrag, terrainGrip, type PartItem, type Stats } from '../sim/parts';
import { fromHealth, toHealth, type VehicleBuild } from '../sim/garage';
import { bayFit, engineSpec, hoodState } from '../sim/engines';
import { engineCharacter } from '../audio/vehicleAcoustics';
import { heatCoolingMult, stormOilMult } from '../sim/weather';
import { oilBurn, oilState, oilWear, type OilState } from '../sim/oil';
import { gearboxPower, gearboxRatingNow, gearboxWear } from '../sim/drivetrain';
import { COOLANT_LOW, COOLANT_CRITICAL, coolantLoss, coolantState, type CoolantState } from '../sim/fluids';
import { fuelMismatch } from '../sim/fuel';
import { T_CRITICAL, T_HOT, T_OVERHEAT, overheatPower, overheatWear, steamLevel, thermalStep } from '../sim/thermal';
import { buildRaiderBuggy, buildVehicleVisual, buildWagon, defaultLook, lookOf, mountsOfChassis, type VehicleVisual } from '../render/vehicleModels';
import { CargoRig } from './cargo';
import { powertrainFor, type Powertrain } from '../sim/powertrain';
import { bodyLoadOf, massBreakdown, type MassBreakdown, type Seat } from '../sim/massModel';
import { insideMax, insideName, insideUnits, unitsUsed, type InsideRoom } from '../sim/cargo';
import { PLAYER_COLORS } from '../render/palette';
import type { Humanoid, Palette } from '../render/humanoid';
import { shared, disposeTree } from '../render/dispose';
import { clamp, damp, lerp } from '../core/math';
import { chassisDef, partDef, type FuelType, type VehicleDef } from '../data';
import { cabinLayout } from '../render/interior';
import { Bodywork } from './bodywork';
import { PANELS, effectiveOpen, panelsOf, panelStripped, type Panel, type PanelOpen } from '../sim/access';
import { CarGlass } from './carGlass';
import type { Ctx } from './ctx';

/** Neutral vehicles are abandoned cars nobody has claimed: raiders ignore them, and driving one makes it the convoy's. */
export type Faction = 'convoy' | 'raider' | 'neutral';
export type VehicleKind = 'player' | 'crew' | 'raiderBuggy' | 'wagon' | 'boat';

/** Whoever is in the driver's seat: a Player (gamepad / keyboard) or an AI. */
export interface Pilot {
  readonly isPlayer: boolean;
  readonly index: number;
  /** How the pilot looks, for the figure drawn in the seat. Absent: the seat keeps the vehicle's own rider. */
  readonly palette?: Palette;
  drive(v: Vehicle, dt: number): DriveInput;
}

export interface VehicleOpts {
  /** Required unless a build is given: the build's chassis supplies it. */
  def?: VehicleDef;
  /** The specific vehicle: parts, paint, condition and fuel. Raiders and crew have none. */
  build?: VehicleBuild;
  x: number;
  z: number;
  yaw: number;
  faction: Faction;
  kind: VehicleKind;
  ownerIndex?: number;
  hpFrac?: number;
  /** Absolute fuel in FU. A build's own fuel fraction is used when this is left out. */
  fuel?: number;
  color?: number;
  y?: number;
  /** Start as a burnt-out hulk. */
  hulk?: boolean;
}

const IDLE: DriveInput = { steer: 0, throttle: 0, brake: 0, handbrake: true };
/** Below this engine condition a convoy vehicle will not start, and one that is running stalls when it stops. */
export const SEIZED = 0.1;
let nextId = 1;
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _lv = new THREE.Vector3();

export class Vehicle {
  id = nextId++;
  def: VehicleDef;
  body: Chassis;
  visual: VehicleVisual;
  /** Crumpling, loose parts, mud and blood, tyre marks. */
  bodywork: Bodywork;
  /** The windows: what has cracked or gone, and what breaks them. */
  glass: CarGlass;
  health: VehicleHealth;
  /** The vehicle's identity and fitted parts. Null for raiders and crew. */
  build: VehicleBuild | null;
  stats: Stats;
  faction: Faction;
  kind: VehicleKind;
  ownerIndex: number;
  driver: Pilot | null = null;
  passenger: { readonly index: number; readonly palette?: Palette } | null = null;
  fuel: number;
  tankMax: number;
  /** What the tank holds. The engine runs on `stats.fuel`; if they differ it will not start. */
  fuelType: FuelType = 'petrol';
  /** Engine temperature, normalised (see sim/thermal). 1 is the redline. */
  temp = 0.2;
  /** Seconds spent past the point where an engine blows. */
  private blownT = 0;
  private tempSeen = 0;
  private steamT = 0;
  engineOn = false;
  lights = false;
  hornT = 0;
  sirenT = 0;
  wreck = false;
  /**
   * A raider car whose crew is dead or has bailed out: still whole, but nobody is fighting from it any more. It rolls to a
   * stop and is left for anyone to strip.
   */
  abandoned = false;
  /** The driver was shot dead in the seat: drawn slumped over the wheel. */
  slumped = false;
  parkedAt = 0;
  /** Set by the leg's tether: >1 = slipstream boost, <1 = leader slowed. */
  tetherPower = 1;
  tetherTop = 1;
  /** Seconds the gun has been firing recently (drives Signature). */
  firing = 0;
  private fireCd = 0;
  gunAim: { x: number; y: number; z: number } | null = null;
  lastIntent: DriveInput = IDLE;
  env: DriveEnv = defaultEnv();
  distance = 0;
  private prev = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
  private spin: number[] = [];
  private lean = 0;
  private sigT = 0;
  private fx = 0;
  private fireFx = 0;
  /** Seconds since last damage, for "under fire" checks by the Mechanic. */
  sinceHit = 99;
  burnT = 0;
  onGround = true;
  /** Convoy slot data for crew vehicles. */
  group = new THREE.Group();
  /** Salvage stages already stripped from a neutral car or a hulk. */
  salvaged = 0;
  /** World-car id, so the car system can find this vehicle again. */
  carId = '';
  /** Why the engine would not start last time, for the prompt. */
  startFail = '';
  /** A held accelerator must not stack a new cranking recording every fixed tick. */
  private starterCooldown = 0;
  /** Distance tracker for the seized-engine check. */
  private seizedWarned = false;
  /** The convoy's stowed spares as they ride on this vehicle: what is shown, and when it was last checked. */
  private loadT = 0;
  /** Last oil level the driver was warned about. */
  private oilSeen: OilState = 'ok';
  private coolantSeen: CoolantState = 'ok';
  private gearSeen = false;
  /** Panels someone has opened (bonnet, doors, boot lid). Closed by default; kept in the build's body save, so they survive streaming and saving. */
  open: Partial<Record<Panel, boolean>> = {};
  /** How far each panel is swung, 0 shut to 1 open. `Bodywork` eases it and poses the model. */
  swing: Record<Panel, number> = { hood: 0, doorL: 0, doorR: 0, trunk: 0 };
  /** The engine, gearbox and final drive turning the wheels (`sim/powertrain.ts`). Null on a boat. */
  powertrain: Powertrain | null = null;
  /**
   * What it weighs right now, item by item, and where its centre of mass is (`sim/massModel.ts`), as last put on the
   * physics body. Null for vehicles with no build (raiders, crew, boats): they run at their tuned reference weight.
   */
  massInfo: MassBreakdown | null = null;
  private massKey = '';
  private driveView = { rpm: 0, gear: 0, rpmFrac: 0, load: 0, shifting: false, limiter: false, idle: 0, redline: 0, cvt: false };
  /** Water: engine drowned (wheeled vehicles), seconds spent out of the water since, and the spray timer. */
  flooded = false;
  /** Picks a raider car's look (paint, scrap, spikes, banner) from where it was spawned, so no two in a war party match. */
  private visSeed = 0;
  dryT = 0;
  splashT = 0;

  constructor(
    public ctx: Ctx,
    o: VehicleOpts,
  ) {
    this.build = o.build ?? null;
    const def = o.build ? chassisDef(o.build.chassis) : o.def;
    if (!def) throw new Error('Vehicle needs a def or a build');
    this.def = def;
    this.faction = o.faction;
    this.kind = o.kind;
    this.ownerIndex = o.ownerIndex ?? -1;
    this.stats = effectiveStats(def, o.build?.fit ?? {}, o.build?.tyres);
    const base = def.physics;
    const gOff = base.suspension.rest + base.wheelRadius - base.hardY;
    const gy = o.y ?? ctx.groundAt(o.x, o.z);
    this.body = def.physics.kind === 'boat' ? new BoatBody(ctx.P, def, o.x, o.y ?? gy + def.physics.halfExtents[1] + 0.6, o.z, o.yaw, (x, z) => ctx.waterAt(x, z)) : new VehicleBody(ctx.P, def, o.x, gy + gOff + 0.25, o.z, o.yaw);
    const isRaider = o.faction === 'raider';
    const color = o.color ?? (this.ownerIndex >= 0 ? PLAYER_COLORS[this.ownerIndex] : 0x6b8a5a);
    this.visSeed = (Math.imul(Math.round(o.x * 8) | 0, 73856093) ^ Math.imul(Math.round(o.z * 8) | 0, 19349663)) >>> 0;
    this.visual = this.makeVisual(color);
    this.group.add(this.visual.root);
    this.shadowCasters(this.visual.root);
    ctx.root.add(this.group);
    if (o.build) {
      this.health = toHealth(o.build);
    } else {
      const maxHp = def.hp;
      this.health = newHealth(maxHp, this.stats.armor, this.body.wheelCount);
      this.health.hp = maxHp * (o.hpFrac ?? 1);
    }
    this.tankMax = isRaider ? 999 : this.stats.tank;
    this.fuel = o.fuel ?? (o.build ? this.tankMax * o.build.fuel : this.tankMax);
    this.fuelType = o.build?.tank ?? this.stats.fuel;
    this.spin = this.body.wheelLocal.map(() => 0);
    ctx.vehicleByCollider.set(this.body.collider.handle, this);
    this.hideSeats();
    this.snapshotPrev();
    this.bodywork = new Bodywork(this);
    this.glass = new CarGlass(this);
    this.cargoRig = new CargoRig(this);
    if (this.body instanceof VehicleBody) this.powertrain = powertrainFor(def, o.build?.fit ?? {}, o.build?.tyres);
    this.weigh();
    if (o.hulk) this.makeHulk();
    this.syncStands();
  }

  /**
   * Weigh the vehicle and put the weight on the body: its parts, its fuel and fluids, who is aboard, the spares stowed in it
   * and the load on its decks. Cheap, but only redone when something that weighs anything has changed.
   */
  weigh(force = false) {
    const b = this.build;
    if (!b || !(this.body instanceof VehicleBody)) return;
    const camp = this.ctx.campaign;
    let stowed = 0;
    if (this.faction === 'convoy') for (const it of camp.inventory) if (it.on === b.uid) stowed++;
    const c = this.health.comp;
    const key = `${Math.round(this.fuel * 8)}|${this.driver ? 1 : 0}${this.passenger ? 1 : 0}|${stowed}|${this.cargoRig.entries.length}|${Math.round(c.oil * 10)}|${Math.round((c.coolant ?? 1) * 10)}`;
    if (!force && key === this.massKey) return;
    this.massKey = key;
    const occupants: { seat: Seat }[] = [];
    if (this.driver) occupants.push({ seat: 'driver' });
    if (this.passenger) occupants.push({ seat: this.weapon === 'bedMG' || !this.def.seat ? 'gunner' : 'passenger' });
    const mb = massBreakdown(
      { chassis: b.chassis, def: this.def, fit: b.fit, tyres: b.tyres, tank: this.fuelType, comp: c, cargo: this.cargoRig.entries },
      {
        fuel: this.fuel,
        occupants,
        stowed: stowed ? camp.inventory.filter((it) => it.on === b.uid) : undefined,
        // Things dealt into a deck's grid sit where the deck puts them.
        place: (e) => {
          const w = this.cargoRig.worldOf(e);
          return this.localOf(w.x, w.y, w.z);
        },
      },
    );
    this.massInfo = mb;
    this.body.setLoad(bodyLoadOf(this.def, b.fit, mb));
  }

  /** The engine as the gauges and the sound see it: revs, the gear (-1 reverse), how hard it is working. Shared object. */
  get drive() {
    const d = this.driveView;
    const u = this.body instanceof VehicleBody ? this.body.unit : null;
    const c = this.powertrain?.curve ?? null;
    if (!u || !c) {
      d.rpm = d.rpmFrac = d.load = d.idle = d.redline = 0;
      d.gear = 0;
      d.shifting = d.limiter = d.cvt = false;
      return d;
    }
    d.rpm = u.rpm;
    d.gear = u.gear;
    d.rpmFrac = u.rpmFrac;
    d.load = u.load;
    d.shifting = u.shifting;
    d.limiter = u.limiter;
    d.idle = c.idle;
    d.redline = c.redline;
    d.cvt = this.powertrain!.gearing.cvt;
    return d;
  }

  /** Kilograms aboard and all, as last weighed (the table's mass with a driver when it has no build to weigh). */
  get massKg(): number {
    return this.massInfo?.total ?? this.def.physics.mass;
  }

  /** The model for this vehicle's chassis, paint and fitted parts. */
  private makeVisual(color: number): VehicleVisual {
    const w = this.body.wheelLocal;
    const st = this.body.steered;
    if (this.kind === 'raiderBuggy') return buildRaiderBuggy(this.def, w, st, this.visSeed);
    if (this.kind === 'wagon') return buildWagon(this.def, w, st, this.visSeed);
    if (this.def.physics.kind === 'boat') return buildBoatVisual(this.def, color);
    const look = this.build ? lookOf(this.build) : defaultLook(color);
    return buildVehicleVisual(this.def, w, st, look);
  }

  private shadowCasters(root: THREE.Object3D) {
    root.traverse((m) => {
      if ((m as THREE.Mesh).isMesh) (m as THREE.Mesh).castShadow = true;
    });
  }

  /** Mounted rider models start hidden until someone sits in them. */
  private hideSeats() {
    if (this.visual.driver && this.faction !== 'raider') this.visual.driver.root.visible = false;
    if (this.visual.passenger) {
      this.visual.inner.add(this.visual.passenger.root);
      this.visual.passenger.root.visible = false;
    }
  }

  /**
   * Rebuild the model and stats after the parts changed, keeping the physics body, condition fractions and fuel.
   * Used by the field workbench; the Ledger respawns whole vehicles instead.
   */
  refit(fromBuild = false) {
    const b = this.build;
    if (!b) return;
    const hpFrac = this.health.hp / this.health.maxHp;
    const fuelFrac = this.fuel / Math.max(0.001, this.tankMax);
    this.stats = effectiveStats(this.def, b.fit, b.tyres);
    const fresh = toHealth(b);
    if (!fromBuild) {
      fresh.comp = this.health.comp;
      fresh.leaking = this.health.leaking;
      fresh.hp = hpFrac * fresh.maxHp;
    }
    fresh.burning = this.health.burning;
    this.health = fresh;
    this.tankMax = this.stats.tank;
    this.fuel = fuelFrac * this.tankMax;
    if (fromBuild) this.fuelType = b.tank;
    // New glass in the build starts as it was carried: forget what the old panes took before the body is written back.
    this.glass.reconcile();
    const old = this.visual;
    const wasSeated = { d: old.driver?.root.visible, p: old.passenger?.root.visible };
    this.bodywork.commit();
    this.bodywork.release();
    this.group.remove(old.root);
    disposeTree(old.root);
    old.dispose();
    this.visual = this.makeVisual(PLAYER_COLORS[Math.max(0, this.ownerIndex)]);
    this.bodywork.attach();
    this.glass.bind();
    this.cargoRig.reset();
    this.group.add(this.visual.root);
    this.shadowCasters(this.visual.root);
    this.hideSeats();
    if (this.visual.driver && wasSeated.d !== undefined) this.visual.driver.root.visible = wasSeated.d;
    if (this.visual.passenger && wasSeated.p !== undefined) this.visual.passenger.root.visible = wasSeated.p;
    this.spin = this.body.wheelLocal.map(() => 0);
    if (this.wreck) this.charVisual();
    if (this.body instanceof VehicleBody) this.powertrain = powertrainFor(this.def, b.fit, b.tyres);
    this.weigh(true);
    this.syncStands();
  }

  /** The build was edited directly (the workbench): pull its parts and condition into this live vehicle. */
  syncFromBuild() {
    this.refit(true);
  }

  /** Write condition and fuel back to the build so it survives into the next scene and the save. */
  commit() {
    const b = this.build;
    if (!b) return;
    fromHealth(b, this.health, this.fuel / Math.max(0.001, this.tankMax));
    b.tank = this.fuelType;
    if (this.wreck) b.hp = 0.02;
    this.bodywork.commit();
    this.cargoRig.save();
  }

  /** A fitted part has come off in a crash: the stats follow it. The model is left alone, it has already lost the part. */
  fitLost() {
    const b = this.build;
    if (!b) return;
    const hpFrac = this.health.hp / this.health.maxHp;
    this.stats = effectiveStats(this.def, b.fit);
    const fresh = toHealth(b);
    this.health.maxHp = fresh.maxHp;
    this.health.hp = hpFrac * fresh.maxHp;
    this.health.armor = fresh.armor;
    this.health.armorBonus = fresh.armorBonus;
    this.tankMax = this.stats.tank;
    this.fuel = Math.min(this.fuel, this.tankMax);
    if (this.body instanceof VehicleBody) this.powertrain = powertrainFor(this.def, b.fit, b.tyres);
    this.weigh(true);
  }

  // ------------------------------------------------------------------ panels

  /** What is open right now: a panel that was never there, that is stripped, or that has been torn off counts as open. */
  panelOpen(): PanelOpen {
    return effectiveOpen(this.def, this.build?.fit ?? {}, this.open, this.bodywork.gonePanels());
  }

  /**
   * How far the bonnet sits open on its own (0..1 of a full swing) because the engine under it is too big to close it over:
   * a tight engine props it a little, one that does not fit at all holds it well up until the bonnet is cut or taken off.
   * `Bodywork` poses the panel from this, so the closed state is honestly "as shut as the engine lets it be".
   */
  hoodProp(): number {
    const b = this.build;
    if (!b || this.wreck || b.fit.engine === undefined) return 0;
    if (hoodState(b.fit) !== 'closed' || !this.hasPanel('hood')) return 0;
    const bonnet = bayFit(this.def, engineSpec(this.def, b.fit)).bonnet;
    return bonnet === 'prop' ? 0.35 : bonnet === 'blocked' ? 0.6 : 0;
  }

  /** Can this panel be opened and shut: the chassis has it, and it is on the car. */
  hasPanel(p: Panel): boolean {
    return !!this.build && panelsOf(this.def).includes(p) && !panelStripped(this.def, this.build?.fit ?? {}, p) && !this.bodywork.gonePanels()[p];
  }

  /**
   * Open or shut a panel. Returns false when there is nothing to swing. It is a little noisy, and a vehicle does not shut
   * anything for you: see `update`, where a car at speed slams them.
   */
  setPanel(p: Panel, open: boolean): boolean {
    if (!this.hasPanel(p)) return false;
    if (!!this.open[p] === open) return true;
    if (open) this.open[p] = true;
    else delete this.open[p];
    const at = this.position;
    this.ctx.sig.emit(at.x, at.z, 4, 'noise');
    this.ctx.audio.play(open ? 'wrench' : 'hit', at.x, at.z, open ? 0.35 : 0.3);
    return true;
  }

  /** Slam everything shut (a door closing behind a driver, a car pulling away). */
  closePanels(): boolean {
    let any = false;
    for (const p of PANELS) if (this.open[p]) any = this.setPanel(p, false) || any;
    return any;
  }

  get neutral() {
    return this.faction === 'neutral';
  }

  /** A raider car that is still in the fight: not burnt out, and somebody aboard. */
  get hostile() {
    return this.faction === 'raider' && !this.wreck && !this.abandoned;
  }

  /** What this vehicle shoots: its own gun, or whatever a weapon part gave it. */
  get weapon(): string | null {
    return this.build ? this.stats.weapon : this.def.weapon;
  }

  /** A driver takes ownership of an abandoned car: from now on it is the convoy's. */
  claim(ownerIndex: number) {
    this.faction = 'convoy';
    this.ownerIndex = ownerIndex;
  }

  get position() {
    return this.body.position;
  }
  get yaw() {
    return this.body.yaw;
  }
  get speed() {
    return this.body.speed;
  }
  get mass() {
    return this.body.mass;
  }
  get topSpeed() {
    return this.body.topSpeed(this.env);
  }

  get hpFrac() {
    return this.health.hp / this.health.maxHp;
  }

  get occupied() {
    return !!this.driver;
  }

  /** Driven by its riders' legs: no fuel, no engine, nothing to start (a pedal boat). */
  get pedal(): boolean {
    return !!this.def.physics.boat?.pedal;
  }

  /** Where a pedal boat was tied up when the last of its riders stepped off (null while anyone is aboard). */
  moored: { x: number; z: number; yaw: number } | null = null;

  /**
   * A pedal boat is tied up wherever it is left, so the river does not carry it off: with nobody aboard its way is taken off
   * and the line draws it back to where it was left, its head as it was.
   */
  private moorTick(dt: number) {
    const b = this.body.body;
    if (this.driver || this.passenger) {
      this.moored = null;
      return;
    }
    const p = b.translation();
    if (!this.moored) this.moored = { x: p.x, z: p.z, yaw: this.yaw };
    const m = this.moored;
    const k = Math.exp(-3 * dt);
    const lv = b.linvel();
    b.setLinvel({ x: lv.x * k + (m.x - p.x) * 2.5 * dt, y: lv.y, z: lv.z * k + (m.z - p.z) * 2.5 * dt }, true);
    let dy = m.yaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    const av = b.angvel();
    b.setAngvel({ x: av.x, y: av.y * k + dy * 2.5 * dt, z: av.z }, true);
  }

  /**
   * Up on its stand: a chassis whose wheels are whole parts (`physics.wholeWheels`, the trike) with one of them off. The
   * frame rests where it is, fixed, until every wheel is back on; then it drops onto its tyres and can roll again.
   */
  onStands = false;

  /** Names the wheels that are off a whole-wheel chassis ("Front wheel", "2 wheels"). */
  missingWheels(): string {
    const b = this.build;
    if (!b) return '';
    const gone = b.tyres.map((t, i) => (t && partDef(t.id).empty ? i : -1)).filter((i) => i >= 0);
    if (gone.length > 1) return `${gone.length} wheels`;
    return gone[0] === 0 ? 'Front wheel' : 'A back wheel';
  }

  /** Put the frame on its stand or take it off, from what the build has on its hubs. Call after the parts change. */
  syncStands() {
    const b = this.build;
    const want = !!b && !!this.def.physics.wholeWheels && b.tyres.some((t) => !!t && partDef(t.id).empty);
    if (want === this.onStands || !(this.body instanceof VehicleBody)) return;
    this.onStands = want;
    const rb = this.body.body;
    if (want) {
      // Settle it level at its ride height on the ground under it, then pin it there.
      const t = rb.translation();
      const p = this.def.physics;
      const n = Math.max(1, this.body.wheelCount);
      const sag = 9.81 / (n * p.suspension.stiffness);
      const y = this.ctx.groundAt(t.x, t.z) + Math.abs(p.hardY) + p.suspension.rest + p.wheelRadius - sag;
      this.body.setPose(t.x, y, t.z, this.body.yaw);
      rb.setBodyType(RAPIER.RigidBodyType.Fixed, true);
      this.engineOn = false;
    } else {
      rb.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      rb.wakeUp();
    }
  }

  /** Why this vehicle cannot start right now, or '' if it can. */
  cantStart(): string {
    if (this.wreck) return 'Burnt out';
    if (this.pedal) return '';
    // Missing parts first: an empty tank is the least of a frame's worries.
    if (this.convoyEngine && this.stats.noEngine) return 'No engine in the bay';
    if (this.onStands) return `${this.missingWheels()} missing: it is up on its stand`;
    if (this.fuel <= 0.001) return 'Out of fuel';
    if (this.flooded) return 'Engine flooded: get it out of the water';
    // Raiders limp on whatever state their engine is in; a convoy engine that is gone has to be rebuilt.
    if (this.faction !== 'raider' && this.health.comp.engine < SEIZED) return 'Engine seized: needs a rebuild';
    if (this.convoyEngine) {
      if (this.stats.noDrive) return 'No gearbox: nothing turns the wheels';
      const wrong = fuelMismatch(this.stats.fuel, this.fuelType, this.fuel);
      if (wrong) return `${wrong}: drain it with the jerrycan`;
      if (this.temp > T_HOT) return 'Engine too hot: let it cool down';
    }
    return '';
  }

  /** True for a vehicle whose engine is simulated in full: heat, fuel type and a bay that can be empty. */
  get convoyEngine(): boolean {
    return !!this.build && this.faction !== 'raider' && this.def.physics.kind !== 'boat';
  }

  setEngine(on: boolean) {
    if (on && this.engineOn) return;
    // Legs need no starter: the pedals are simply there to push.
    if (this.pedal) {
      this.engineOn = on && !this.wreck;
      return;
    }
    const spec = engineSpec(this.def, this.build?.fit ?? {});
    const character = engineCharacter({id:this.id,x:0,z:0,rpm:0,throttle:0,tier:this.def.tier,signature:0,litres:spec.litres,fuel:spec.fuel,layout:spec.layout});
    const family = character.family;
    if (!on) {
      if (this.engineOn) this.ctx.audio.play('engineStop',this.position.x,this.position.z,.45*character.body,{bank:`engineStop-${family}`,pitch:character.pitch});
      this.engineOn = false;
      return;
    }
    this.startFail = this.cantStart();
    this.engineOn = !this.startFail;
    // Recheck the tank and parts on every attempt so refuelling can start it immediately,
    // but let a failed crank finish before another attempt can make a sound.
    if (this.startFail && this.starterCooldown > 0) return;
    this.starterCooldown = this.startFail ? 2.5 : 0;
    this.ctx.audio.play(this.startFail ? 'starterFail' : 'engineStart',this.position.x,this.position.z,.5*character.body,{bank:this.startFail ? undefined : `engineStart-${family}`,pitch:character.pitch});
  }

  /** The load on the outside (roof, bed, racks): what rides there, what is secure, and what falls off when driven. See `game/cargo.ts`. */
  cargoRig!: CargoRig;

  /** Redraw the outside load now rather than at the next half-second tick: used when something was just taken off or put on. */
  refreshLoadNow() {
    this.cargoRig.refreshNow();
  }

  /** Spare parts the convoy has stowed inside this vehicle (secure at any speed). Parts with no vehicle of their own (old saves) count as being in every boot. */
  stowedParts(): PartItem[] {
    const b = this.build;
    if (!b || this.faction !== 'convoy') return [];
    const own = new Set(this.ctx.campaign.garage.map((g) => g.uid));
    return this.ctx.campaign.inventory.filter((it) => it.on === b.uid || !it.on || !own.has(it.on));
  }

  /** Room inside: footprint units free, the biggest single item, and what the place is called. */
  insideRoom(): InsideRoom {
    const b = this.build;
    const used = b ? unitsUsed(this.ctx.campaign.inventory.filter((it) => it.on === b.uid)) : 0;
    const total = b ? insideUnits(this.def, this.stats.cargo, b.fit) : 0;
    return { free: Math.max(0, total - used), max: insideMax(this.def), name: insideName(this.def) };
  }

  /** Everything inside that could be taken out by hand, with where it comes out of in the world. */
  deckSpots(): { kind: 'part' | 'fuel' | 'oil' | 'crate'; uid?: string; id?: string; world: THREE.Vector3 }[] {
    if (this.faction !== 'convoy' || !this.build) return [];
    const [x, y, z] = this.body.toWorld(0, 0.8, -this.def.length * 0.42);
    const at = () => new THREE.Vector3(x, y, z);
    const camp = this.ctx.campaign;
    const out: { kind: 'part' | 'fuel' | 'oil' | 'crate'; uid?: string; id?: string; world: THREE.Vector3 }[] = this.stowedParts().map((it) => ({ kind: 'part' as const, uid: it.uid, id: it.id, world: at() }));
    if (camp.stocks.fuel >= 1) out.push({ kind: 'fuel', world: at() });
    if (camp.items.oil > 0.05) out.push({ kind: 'oil', world: at() });
    return out;
  }

  /**
   * Heat: the engine makes it, the radiator sheds it. Past the redline power drops and the engine wears, steam rolls out
   * from under the bonnet, and left to cook it blows. A swap that leaves the wrong fuel in the tank stops the engine.
   */
  private engineHeat(dt: number) {
    const st = this.stats;
    const mismatch = this.engineOn && fuelMismatch(st.fuel, this.fuelType, this.fuel);
    if (this.engineOn && (st.noEngine || mismatch)) {
      this.engineOn = false;
      if (this.driver?.isPlayer) this.ctx.notify(this.driver.index, st.noEngine ? 'No engine in the bay' : `${mismatch}: it will not run`, 'bad');
    }
    const speed = Math.abs(this.speed);
    const top = Math.max(8, this.topSpeed);
    const thr = Math.max(0, this.lastIntent.throttle);
    const load = this.engineOn ? clamp(0.12 + 0.62 * thr + 0.26 * clamp(speed / top, 0, 1) * (thr > 0.1 ? 1 : 0.4), 0, 1) : 0;
    const comp = this.health.comp;
    this.temp = thermalStep(this.temp, { heat: st.heat, cooling: st.coolKw, radiator: comp.radiator ?? 1, airflow: st.airflow, load, speed, running: this.engineOn, coolant: comp.coolant ?? 1, ambient: heatCoolingMult(this.ctx.heat) * (1 + 0.15 * (this.ctx.rain ?? 0)) }, dt);
    const T = this.temp;
    // Water: a little evaporates, a holed radiator leaks, a cooking engine boils it away.
    comp.coolant = Math.max(0, (comp.coolant ?? 1) - coolantLoss({ T, radiator: comp.radiator ?? 1, coolantL: st.coolantL, running: this.engineOn, dt }));
    this.coolantWatch();
    // The gearbox wears when the engine makes more than it can carry, harder the harder you push.
    if (this.engineOn && !st.noDrive) {
      const rating = gearboxRatingNow(st.gearboxRating, comp.gearbox ?? 1);
      const strain = rating > 0 ? (st.strain * st.gearboxRating) / rating : 9;
      const w = gearboxWear(strain, load, dt);
      if (w > 0) comp.gearbox = Math.max(0, (comp.gearbox ?? 1) - w);
      const slipping = (comp.gearbox ?? 1) < 0.5;
      if (slipping && !this.gearSeen && this.driver?.isPlayer) this.ctx.notify(this.driver.index, 'The gearbox is slipping: the engine is too much for it', 'warn');
      this.gearSeen = slipping;
    }
    if (this.engineOn) {
      const wear = overheatWear(T, dt);
      if (wear > 0) this.health.comp.engine = Math.max(0, this.health.comp.engine - wear);
    }
    // Warnings: once going up through each line, again after it has cooled and climbed back.
    const level = T >= T_OVERHEAT ? 2 : T >= T_HOT ? 1 : 0;
    if (level > this.tempSeen && this.driver?.isPlayer && this.faction === 'convoy') {
      this.ctx.notify(this.driver.index, level === 2 ? 'ENGINE OVERHEATING: ease off or stop!' : 'Engine running hot', level === 2 ? 'bad' : 'warn');
    }
    if (level < this.tempSeen && T < T_HOT - 0.12) this.tempSeen = 0;
    else this.tempSeen = Math.max(this.tempSeen, level);
    // Steam from under the bonnet.
    const steam = steamLevel(T);
    if (steam > 0 && !this.wreck && (this.steamT -= dt) <= 0) {
      this.steamT = 0.14 - 0.1 * steam;
      const [x, y, z] = this.body.toWorld((Math.random() - 0.5) * 0.4, 0.95, this.def.length * 0.36);
      this.ctx.fx.puff(x, y, z, 0.9, 0.92, 0.95, 0.5 + steam * 0.9, 0.9);
    }
    // Left to cook, the engine blows: a hole in the block, power gone until it has cooled.
    if (T >= T_CRITICAL && this.engineOn) {
      this.blownT += dt;
      if (this.blownT > 5) {
        this.blownT = 0;
        this.engineOn = false;
        this.health.comp.engine = Math.max(0, this.health.comp.engine - 0.3);
        this.health.comp.oil = Math.max(0, this.health.comp.oil - 0.3);
        this.temp = T_OVERHEAT + 0.1;
        if (this.driver?.isPlayer) this.ctx.notify(this.driver.index, 'The engine blew its gasket: let it cool, then rebuild it', 'bad');
        this.ctx.audio.play('crash', this.position.x, this.position.z, 0.5);
        this.ctx.fx.explosion(this.position.x, this.position.y + 0.9, this.position.z, 0.35);
      }
    } else this.blownT = Math.max(0, this.blownT - dt * 2);
  }

  /** Tell the driver as the cooling system runs dry. */
  private coolantWatch() {
    const st = coolantState(this.health.comp.coolant ?? 1);
    if (st === this.coolantSeen) return;
    const worse = st === 'critical' || (st === 'low' && this.coolantSeen === 'ok');
    this.coolantSeen = st;
    if (!worse || !this.driver?.isPlayer || this.faction !== 'convoy') return;
    if (st === 'low') this.ctx.notify(this.driver.index, 'Coolant is low: top up with water', 'warn');
    else this.ctx.notify(this.driver.index, 'The cooling system is dry: it will cook!', 'bad');
  }

  /** Tell the driver as the sump runs down, once per threshold, and again if it is topped up and falls back. */
  private oilWatch() {
    const st = oilState(this.health.comp.oil);
    if (st === this.oilSeen) return;
    const worse = st === 'critical' || (st === 'low' && this.oilSeen === 'ok');
    this.oilSeen = st;
    if (!worse || !this.driver?.isPlayer || this.faction !== 'convoy') return;
    if (st === 'low') this.ctx.notify(this.driver.index, 'Oil is low: top up with a can', 'warn');
    else {
      this.ctx.notify(this.driver.index, 'Out of oil: the engine is wrecking itself!', 'bad');
      this.ctx.radio("Engine sumps dry, we're seizing up!");
    }
  }

  /** Current Signature: engines are Noise in cities and Dust on the open road. */
  signature(): number {
    if (this.wreck) return this.burnT > 0 ? 25 : 0;
    const sig = this.def.signature;
    let s = !this.engineOn ? 0 : Math.abs(this.speed) > 1.5 ? sig.moving : sig.idle;
    if (this.def.tier === 1 && this.engineOn && Math.abs(this.speed) < 1.5) s = sig.idle;
    if (this.firing > 0) s += 60;
    if (this.hornT > 0 || this.sirenT > 0) s = 100;
    if (this.lights && this.ctx.night > 0.4 && this.faction === 'convoy') s *= 2;
    return clamp(s * this.ctx.signatureMult * this.stats.sigMult, 0, 100);
  }

  /** Dust plume level for wastelands: grows with speed. */
  dust(): number {
    if (!this.engineOn) return 0;
    const f = clamp(Math.abs(this.speed) / Math.max(8, this.topSpeed), 0, 1);
    const ground = this.ctx.groundDust?.(this.position.x, this.position.z) ?? 1;
    return clamp(this.signature() * (0.35 + 0.9 * f) * ground, 0, 100);
  }

  snapshotPrev() {
    const t = this.body.body.translation();
    const r = this.body.body.rotation();
    this.prev.x = t.x;
    this.prev.y = t.y;
    this.prev.z = t.z;
    this.prev.qx = r.x;
    this.prev.qy = r.y;
    this.prev.qz = r.z;
    this.prev.qw = r.w;
  }

  /** Called once per fixed tick, before the world step. */
  update(dt: number) {
    const ctx = this.ctx;
    this.starterCooldown = Math.max(0, this.starterCooldown - dt);
    this.sinceHit += dt;
    if (this.hornT > 0) this.hornT -= dt;
    if (this.sirenT > 0) this.sirenT -= dt;
    if (this.firing > 0) this.firing -= dt;
    if (this.fireCd > 0) this.fireCd -= dt;
    let input: DriveInput = IDLE;
    if (this.wreck) {
      this.env.engineOn = false;
    } else {
      if (this.driver) input = this.driver.drive(this, dt);
      else input = { steer: 0, throttle: 0, brake: 0, handbrake: Math.abs(this.speed) < 3 };
      this.lastIntent = input;
      const perf = performance(this.health);
      const e = this.env;
      e.engineOn = this.engineOn && (this.pedal || this.fuel > 0.001);
      if (!e.engineOn && this.engineOn) this.engineOn = false;
      e.power = perf.power * this.tetherPower * (this.convoyEngine ? overheatPower(this.temp) * gearboxPower(this.health.comp.gearbox ?? 1) : 1);
      e.grip = perf.grip * this.stats.gripMult;
      // A wheeled vehicle drives through its powertrain, which already carries the engine, the gears and the bolt-ons:
      // the tether is left as a governor on it. A boat keeps the table's multipliers.
      e.drive = this.powertrain ?? undefined;
      e.forceMult = this.powertrain ? 1 : this.stats.forceMult;
      e.topSpeedMult = (this.powertrain ? 1 : this.stats.topSpeedMult) * this.tetherTop;
      e.travelMult = this.stats.travelMult;
      e.brakeMult = this.stats.brakeMult;
      e.steerMult = this.stats.steerMult;
      e.flats = this.health.comp.tires.map((t) => t <= 0);
      const off = this.stats.offroad;
      e.surface = (x, z) => {
        const sf = ctx.surfaceAt(x, z);
        return { grip: terrainGrip(sf.grip, off), drag: terrainDrag(sf.drag, off) };
      };
    }
    this.body.update(this.wreck ? { steer: 0, throttle: 0, brake: 0, handbrake: true } : input, this.env, dt);
    if (this.pedal && !this.wreck) this.moorTick(dt);
    this.onGround = this.body.grounded > 0;
    waterTick(this, dt);

    // A convoy engine that has been shot to pieces runs on, weakly, until it is stopped; then it won't restart.
    if (this.engineOn && this.faction !== 'raider' && this.health.comp.engine < SEIZED && Math.abs(this.speed) < 1.5) {
      this.engineOn = false;
      if (!this.seizedWarned && this.driver?.isPlayer) ctx.notify(this.driver.index, 'Engine seized: rebuild it with the wrench', 'bad');
      this.seizedWarned = true;
    }
    if (this.health.comp.engine >= SEIZED) this.seizedWarned = false;
    if (this.convoyEngine && !this.wreck) this.engineHeat(dt);

    // Fuel burn per km driven, scaled by the Drain slider. Raiders never run dry, and legs run on rations.
    if (this.faction === 'convoy' && this.engineOn && !this.wreck && !this.pedal) {
      const d = Math.abs(this.speed) * dt;
      this.distance += d;
      this.fuel = Math.max(0, this.fuel - (this.def.burn / 1000) * this.stats.burnMult * d * ctx.campaign.difficulty.drain - 0.0006 * this.stats.burnMult * dt);
      if (this.fuel <= 0.001) {
        this.engineOn = false;
        if (this.driver?.isPlayer) ctx.notify(this.driver.index, 'Out of fuel', 'bad');
      }
    }

    // Oil: burnt by the miles. Short of it the engine labours; run dry and it grinds itself to pieces.
    if (this.faction === 'convoy' && this.engineOn && !this.wreck && this.def.physics.kind !== 'boat') {
      const c = this.health.comp;
      const rate = (this.convoyEngine ? this.stats.oilRate : 1) * stormOilMult(ctx.storm);
      c.oil = Math.max(0, c.oil - oilBurn(Math.abs(this.speed) * dt, dt, c.engine, ctx.campaign.difficulty.drain, rate));
      const wear = oilWear(c.oil, dt) * (Math.abs(this.speed) > 1 ? 1 : 0.4);
      if (wear > 0) c.engine = Math.max(0, c.engine - wear);
    }
    this.oilWatch();
    if ((this.loadT -= dt) <= 0) {
      this.loadT = 0.5;
      this.cargoRig.refresh();
      this.weigh();
    }
    this.cargoRig.step(dt);

    const hz = tickHazards(this.health, dt);
    if (hz.fuelLeak > 0) this.fuel = Math.max(0, this.fuel - hz.fuelLeak);
    if (this.health.destroyed && !this.wreck) this.destroyNow();

    // Collisions: damage by relative speed and mass ratio.
    if (this.body.impact > 0 && !this.wreck) {
      const dmg = collisionDamage(this.body.impact, this.mass, 3500);
      this.glass.crash(this.body.impact, this.body.impactDirX, this.body.impactDirZ);
      if (dmg > 0.5) {
        this.takeHit(dmg, this.position.x + this.body.impactDirX, this.position.z + this.body.impactDirZ, { ram: true, silent: true });
        if (this.stats.ram > 0 && this.faction === 'convoy') this.rammedOthers(dmg);
        if (this.driver?.isPlayer) {
          ctx.input.rumble(this.driver.index, clamp(this.body.impact / 14, 0.2, 1), 0.6, 160);
          const pl = ctx.players[this.driver.index];
          pl?.cam.addShake(clamp(this.body.impact / 18, 0.1, 0.9));
        }
        ctx.audio.play('crash', this.position.x, this.position.z, clamp(this.body.impact / 14, 0.3, 1), { intensity: clamp(this.body.impact / 14, 0, 1), pitch: clamp(1.1-this.mass/12000,.72,1.1) });
        ctx.audio.play('carPanel', this.position.x, this.position.z, clamp(this.body.impact / 18,.15,.7), {intensity:clamp(this.body.impact/18,0,1)});
        ctx.fx.spark(this.position.x, this.position.y, this.position.z, 5, 5);
      }
    }

    this.bodywork.tick(dt);
    // Nobody drives with the bonnet up: a car at speed slams every panel it has open.
    if (Math.abs(this.speed) > SLAM_SPEED && (this.open.hood || this.open.doorL || this.open.doorR || this.open.trunk)) this.closePanels();

    // Signature at 3 Hz.
    this.sigT -= dt;
    if (this.sigT <= 0) {
      this.sigT = 1 / 3;
      const s = this.signature();
      if (s > 0 && this.faction === 'convoy') {
        ctx.sig.emit(this.position.x, this.position.z, s, 'noise');
        ctx.sig.emit(this.position.x, this.position.z, this.dust(), 'dust');
      }
    }

    // Effects
    this.fx += dt;
    const p = this.position;
    if (this.onGround && !this.wreck && ctx.biome === 'wasteland' && Math.abs(this.speed) > 5 && this.fx > 0.04) {
      this.fx = 0;
      const [bx, , bz] = this.body.toWorld(0, 0, -this.def.length * 0.45);
      const surf = ctx.surfaceAt(bx, bz);
      const tint: [number, number, number] = surf.name === 'sand' ? [0.85, 0.72, 0.5] : surf.name === 'mud' ? [0.35, 0.28, 0.2] : surf.name === 'asphalt' ? [0.55, 0.52, 0.48] : [0.72, 0.6, 0.42];
      const k = clamp(Math.abs(this.speed) / 24, 0.3, 1.6) * (surf.name === 'asphalt' ? 0.5 : 1) * (ctx.groundDust?.(bx, bz) ?? 1);
      ctx.fx.dust(bx, ctx.groundAt(bx, bz), bz, -Math.sin(this.yaw) * this.speed, -Math.cos(this.yaw) * this.speed, k, tint);
    }
    if (this.health.burning || (this.wreck && this.burnT > 0)) {
      // A running fire is in the engine bay; a wreck burns from end to end and dies down over its last seconds. The fire
      // engine draws it (flames streaming back as it drives, oily black smoke, its light) and lets it light the grass.
      if (ctx.fires) {
        const [bx, by, bz] = this.wreck ? [p.x, p.y + 0.1, p.z] : this.body.toWorld(0, 0.35, this.def.length * 0.3);
        ctx.fires.hold(this, {
          x: bx,
          y: by,
          z: bz,
          r: this.wreck ? Math.min(1.8, this.def.length * 0.32) : 0.55,
          fuel: 'rubber',
          heat: this.wreck ? Math.min(1, this.burnT / 8) : 0.85,
          bed: false,
          spreads: true,
          vx: Math.sin(this.yaw) * this.speed,
          vz: Math.cos(this.yaw) * this.speed,
        });
      } else {
        ctx.fx.fire(p.x, p.y + 0.6, p.z, this.wreck ? 1.4 : 0.7);
        if (Math.random() < 0.5) ctx.fx.blackSmoke(p.x, p.y + 1.0, p.z);
      }
    } else if (this.hpFrac < 0.4 && !this.wreck && Math.random() < 0.3) {
      ctx.fx.blackSmoke(p.x, p.y + 0.9, p.z);
    }
    if (this.wreck) this.burnT = Math.max(0, this.burnT - dt);
    boatFx(this, dt);
  }

  /** A spiked ram hurts what it hits: raiders in front of the nose take a share of the impact on top of their own. */
  private rammedOthers(dmg: number) {
    const [fx, , fz] = this.body.forward();
    for (const o of this.ctx.vehicles) {
      if (o === this || o.faction !== 'raider' || o.wreck) continue;
      const dx = o.position.x - this.position.x;
      const dz = o.position.z - this.position.z;
      const d = Math.hypot(dx, dz);
      if (d > this.def.length / 2 + o.def.length / 2 + 0.8 || (dx * fx + dz * fz) / (d || 1) < 0.4) continue;
      o.takeHit(dmg * this.stats.ram * 2.2, this.position.x, this.position.z, { ram: true, silent: true });
    }
  }

  /** Fire the vehicle's mounted gun. Direction is explicit for aimed guns, else along the nose. */
  fireGun(dt: number, aim?: [number, number, number]): boolean {
    if (this.wreck || this.fireCd > 0 || !this.weapon) return false;
    const ctx = this.ctx;
    const camp = ctx.campaign;
    const isT2 = this.def.id === 'quad';
    const front = this.weapon === 'frontLMG';
    if (this.faction === 'convoy') {
      if (camp.ammo <= 0) {
        if (this.driver?.isPlayer && this.fx > 0.5) ctx.notify(this.driver.index, 'Out of ammo: craft more at camp', 'warn');
        return false;
      }
      camp.ammo--;
    }
    const rate = (isT2 ? 11 : front ? 10 : this.def.tier === 3 ? 9 : 8) * this.stats.rateMult;
    this.fireCd = 1 / rate;
    this.firing = 0.4;
    let ox: number;
    let oy: number;
    let oz: number;
    let dx: number;
    let dy: number;
    let dz: number;
    if (this.visual.gun && aim) {
      const m = this.visual.muzzle;
      m.updateWorldMatrix(true, false);
      const wp = new THREE.Vector3().setFromMatrixPosition(m.matrixWorld);
      ox = wp.x;
      oy = wp.y;
      oz = wp.z;
      [dx, dy, dz] = aim;
    } else {
      [ox, oy, oz] = this.body.toWorld(0, 0.5, this.def.length * 0.5 + 0.2);
      [dx, dy, dz] = this.body.forward();
    }
    const dmgMult = this.stats.damageMult * (0.5 + 0.5 * this.health.comp.mount);
    const base = isT2 ? 14 : front ? 15 : 18;
    ctx.combat.shoot(ox, oy, oz, dx, dy, dz, {
      side: this.faction === 'raider' ? 'raider' : 'convoy',
      ammo: this.faction === 'raider' ? 'raider' : 'turret',
      ownVehicle: this,
      damage: base * dmgMult,
      spread: isT2 ? 0.03 : front ? 0.026 : 0.022,
      tracer: true,
      assist: this.driver?.isPlayer || this.passenger ? 0.6 * (ctx.input.intents[this.driver?.index ?? this.passenger?.index ?? 0].aimAssist) : 0,
      noise: 60,
      range: 85,
      headshots: true,
      owner: ctx.players[this.driver?.index ?? this.passenger?.index ?? 0] ?? null,
    });
    ctx.fx.flash(ox, oy, oz, 1.1);
    ctx.audio.play('mg', ox, oz, 0.7);
    // Belt-fed brass spills over the side of a convoy gun.
    if (this.faction !== 'raider' && Math.random() < 0.6) ctx.gore.eject('rifle', ox - dx * 0.4, oy - 0.1, oz - dz * 0.4, Math.atan2(dx, dz), this.body.body.linvel().x, this.body.body.linvel().z);
    return true;
  }

  /**
   * Apply damage from a source at (srcX, srcZ). Returns true if this killed the vehicle. `bullet` marks a round from a gun,
   * with how hard it is on sheet metal: it holes the car where it lands (`at`) and cannot finish it off on its own.
   */
  takeHit(raw: number, srcX: number, srcZ: number, o: { incendiary?: boolean; ram?: boolean; pierce?: number; silent?: boolean; wheel?: number; at?: [number, number, number]; blast?: number; smash?: boolean; bullet?: number } = {}): boolean {
    if (this.wreck) return false;
    const ctx = this.ctx;
    const dir = Math.atan2(srcX - this.position.x, srcZ - this.position.z);
    const facing = facingOf(dir, this.yaw);
    const h = this.health;
    const savedArmor = h.armor;
    if (o.pierce) h.armor = h.armor * (1 - o.pierce);
    const spot = o.bullet !== undefined && o.at ? this.zoneAt(o.at) : null;
    const res = applyHit(h, raw, { facing, roll: () => ctx.rng.next(), incendiary: o.incendiary, ram: o.ram, wheel: spot?.wheel ?? o.wheel, bullet: o.bullet, zone: spot?.zone });
    h.armor = savedArmor;
    this.sinceHit = 0;
    if (!o.silent && res.dealt>0) ctx.audio.play('carPanel',this.position.x,this.position.z,clamp(res.dealt/90,.08,.65),{intensity:clamp(res.dealt/70,0,1)});
    // Crashes dent the body where the physics found the contact; everything else is shaped here.
    if (!o.ram || o.blast !== undefined || o.smash) this.bodywork.hit({ dmg: res.dealt, srcX, srcZ, at: o.at, blast: o.blast, smash: o.smash });
    if (o.blast !== undefined) this.glass.blast(o.blast);
    this.report(res.events);
    if (this.driver?.isPlayer && !o.silent) ctx.input.rumble(this.driver.index, 0.4, 0.5, 90);
    if (this.passenger && !o.silent) ctx.input.rumble(this.passenger.index, 0.25, 0.4, 70);
    if (res.dealt > 0 && this.driver?.isPlayer) ctx.players[this.driver.index]?.cam.addShake(Math.min(0.5, res.dealt / 80));
    return h.destroyed;
  }

  /** A world point in this vehicle's own frame (x right, y up, z forward). */
  localOf(x: number, y: number, z: number): [number, number, number] {
    const t = this.body.body.translation();
    const r = this.body.body.rotation();
    _q.set(r.x, r.y, r.z, r.w).invert();
    _lv.set(x - t.x, y - t.y, z - t.z).applyQuaternion(_q);
    return [_lv.x, _lv.y, _lv.z];
  }

  /**
   * What a round that struck this world point hit: a wheel, the engine bay, the tank, or only panel. The engine is in the
   * nose, the tank low in the tail; a raider buggy carries its engine behind the seats.
   */
  zoneAt(at: [number, number, number]): { zone: HitZone; wheel?: number } {
    const [x, y, z] = this.localOf(at[0], at[1], at[2]);
    const wl = this.body.wheelLocal;
    const r = this.def.physics.wheelRadius + 0.12;
    for (let i = 0; i < wl.length; i++) {
      const [wx, wy, wz] = wl[i];
      if (Math.abs(x - wx) < 0.45 && Math.hypot(y - (wy - this.body.wheelSusp(i)), z - wz) < r) return { zone: 'wheel', wheel: i };
    }
    const half = this.def.length / 2;
    const rearEngine = this.kind === 'raiderBuggy';
    if (rearEngine ? z < -half * 0.4 : z > half * 0.4) return { zone: 'engine' };
    if (!rearEngine && z < -half * 0.45 && y < 0.05) return { zone: 'tank' };
    return { zone: 'body' };
  }

  private report(events: DamageEvent[]) {
    const ctx = this.ctx;
    const who = this.driver?.isPlayer ? this.driver.index : this.passenger ? this.passenger.index : -1;
    for (const e of events) {
      let msg = '';
      let kind: 'warn' | 'bad' = 'warn';
      if (e.kind === 'tire') {
        msg = 'Tire blown';
        const w = this.body.wheelLocal[e.wheel];
        const point = w ? this.body.toWorld(...w) : [this.position.x,0,this.position.z];
        ctx.audio.play('tirePuncture',point[0],point[2],.45);
      }
      else if (e.kind === 'engine') msg = 'Engine damaged';
      else if (e.kind === 'leak') msg = 'Fuel leak!';
      else if (e.kind === 'fire') {
        msg = 'ON FIRE: repair to put it out';
        kind = 'bad';
      } else if (e.kind === 'mount') msg = 'Weapon mount damaged';
      if (msg && who >= 0) ctx.notify(who, msg, kind);
      if (msg && this.faction === 'raider') ctx.fx.spark(this.position.x, this.position.y + 0.6, this.position.z, 4, 4);
    }
  }

  /** Field repair step used by wrench and Mechanic. */
  repair(): string {
    const r = repairStep(this.health);
    return r;
  }

  private destroyNow() {
    // Whatever rode on the roof or in the bed is thrown clear of the blast.
    this.cargoRig.spillAll(1.8);
    this.glass.shatterAll();
    this.bodywork.wreck();
    this.makeHulk();
    this.burnT = 30;
    const p = this.position;
    this.ctx.fx.explosion(p.x, p.y + 0.6, p.z, this.mass > 1500 ? 1.4 : 0.9);
    this.ctx.fires?.flash(p.x, p.y + 1, p.z, this.mass > 1500 ? 1800 : 1000, 0.55);
    this.ctx.audio.play('boom', p.x, p.z, 1);
    this.body.body.applyImpulse({ x: 0, y: this.mass * 3.2, z: 0 }, true);
    this.ctx.onVehicleDestroyed(this);
  }

  /** The body and the cabin under it go black. */
  private charVisual() {
    this.visual.body.material = charMat;
    if (this.visual.interior) this.visual.interior.material = charMat;
    if (this.visual.steerWheel instanceof THREE.Mesh) this.visual.steerWheel.material = charMat;
  }

  /** Burnt out: charred, dead, and good for nothing but parts. */
  makeHulk() {
    this.glass.shatterAll(true);
    this.wreck = true;
    this.engineOn = false;
    this.health.destroyed = true;
    this.health.hp = 0;
    this.body.body.setLinearDamping(1.5);
    this.body.body.setAngularDamping(3);
    this.visual.setHeadlights(false);
    this.charVisual();
    for (const w of this.visual.wheels) w.pivot.visible = true;
    if (this.visual.driver) this.visual.driver.root.visible = false;
    if (this.visual.passenger) this.visual.passenger.root.visible = false;
  }

  /** World point of a seat's door, used for enter/exit proximity. */
  doorPos(side: 1 | -1): [number, number, number] {
    const seat = this.def.seat?.driver[2] ?? (this.def.tier === 3 ? 0.1 : -0.1);
    return this.body.toWorld(side * (this.def.width / 2 + 0.55), 0, seat);
  }
  /** Where the second seat is: the gun post in a bed, or the passenger seat in a cab. */
  gunnerPos(): [number, number, number] {
    if (this.weapon === 'bedMG' || !this.def.seat) {
      const g = this.def.gunner ?? [0, 0.2, -0.95];
      return this.body.toWorld(g[0], g[1], g[2]);
    }
    const [x, y, z] = this.def.seat.passenger;
    return this.body.toWorld(x, y, z);
  }

  /**
   * World point under a seated rider's feet, exactly where the cabin sits them (`seatOccupant`), or null where the vehicle has
   * no cab seat for them (a moped, a bed gun post): the caller falls back to a guess.
   */
  seatFeet(who: 'driver' | 'gunner'): [number, number, number] | null {
    if (!this.def.seat || (who === 'gunner' && (this.weapon === 'bedMG' || this.visual.gun))) return null;
    const L = cabinLayout(this.def);
    const spot = L && (who === 'driver' ? L.seats.seatD : L.seats.seatP);
    return spot ? this.body.toWorld(spot.x, L.floor - L.g0, spot.z) : null;
  }

  /** Like `seatFeet`, but also for a bike or quad: where the visual sits its rider. Null for a boat or a gun post. */
  riderFeet(who: 'driver' | 'gunner'): [number, number, number] | null {
    const cab = this.seatFeet(who);
    if (cab || who !== 'driver' || this.def.seat || this.def.physics.kind === 'boat') return cab;
    const d = this.visual.driver?.root.position;
    return d ? this.body.toWorld(d.x, d.y, d.z) : null;
  }

  /** Where a player ends up after bailing or exiting: a free side, or on top. */
  exitSpot(): { x: number; z: number } {
    for (const side of [1, -1] as const) {
      const [x, , z] = this.doorPos(side);
      if (!this.ctx.obs.pointInside(x, z, 1)) return { x, z };
    }
    const [x, , z] = this.doorPos(1);
    return { x, z };
  }

  shove(ix: number, iz: number) {
    this.body.shove(ix, iz);
  }

  /** Pose the Three.js group from the interpolated physics state. */
  syncVisual(alpha: number, dt: number) {
    const t = this.body.body.translation();
    const r = this.body.body.rotation();
    const p = this.prev;
    this.visual.root.position.set(lerp(p.x, t.x, alpha), lerp(p.y, t.y, alpha), lerp(p.z, t.z, alpha));
    _q.set(p.qx, p.qy, p.qz, p.qw);
    _q2.set(r.x, r.y, r.z, r.w);
    _q.slerp(_q2, alpha);
    this.visual.root.quaternion.copy(_q);
    const v = this.visual;
    const sp = this.speed;
    // Wheels: suspension travel, steering, spin.
    for (let i = 0; i < v.wheels.length; i++) {
      const w = v.wheels[i];
      const susp = this.body.wheelSusp(i);
      // A flat tyre sits squashed on its rim; a wheel with no tyre has nothing to squash.
      const flat = !w.bare && this.health.comp.tires[i] <= 0.001;
      w.flatK = damp(w.flatK, flat ? 1 : 0, 10, dt);
      w.pivot.scale.y = 1 - 0.22 * w.flatK;
      w.pivot.position.y = (this.body.wheelLocal[i]?.[1] ?? this.def.physics.hardY) - susp - w.radius * 0.22 * w.flatK - (v.rideLift ?? 0);
      w.pivot.rotation.y = w.steered ? this.body.steerAngle : 0;
      this.spin[i] += (sp * dt) / w.radius;
      w.spin.rotation.x = this.spin[i];
    }
    if (this.def.physics.lean) {
      const target = clamp(-this.body.steerAngle * Math.min(1, Math.abs(sp) / 8) * 1.1, -0.45, 0.45);
      this.lean = damp(this.lean, target, 8, dt);
      v.lean.rotation.z = this.lean;
    }
    // Seat occupants. Found cars build theirs the first time someone sits down.
    if (!v.driver && this.driver && v.lazy?.driver) {
      v.driver = v.lazy.driver();
      v.inner.add(v.driver.root);
      this.shadowCasters(v.driver.root);
    }
    if (!v.passenger && this.passenger && v.lazy?.passenger) {
      v.passenger = v.lazy.passenger();
      v.inner.add(v.passenger.root);
      this.shadowCasters(v.passenger.root);
    }
    if (v.driver && this.faction !== 'raider') v.driver.root.visible = !!this.driver && !this.wreck;
    if (v.passenger) v.passenger.root.visible = !!this.passenger && !this.wreck;
    // A player in a seat is drawn as themselves: their face, their build, what they are wearing.
    if (v.driver) seatAs(v.driver, this.driver);
    if (v.passenger) seatAs(v.passenger, this.passenger);
    if (v.driver) v.driver.update(dt, this.def.tier === 1 ? 'ride' : 'seat', 0, 0, 0);
    // Sit them in the seat the cabin really has (or on the floor where it has none).
    if (v.driver && v.seat) v.seat('driver', v.driver, this.stats.seatDrop);
    if (v.driver && this.slumped) {
      // Shot dead at the wheel: folded forward over it, head down, arms hanging.
      const d = v.driver;
      d.torso.rotation.x = 0.75;
      d.head.rotation.x = 0.7;
      d.head.rotation.z = 0.35;
      d.armL.rotation.x = -0.15;
      d.armR.rotation.x = -0.3;
      d.armL.rotation.z = 0.05;
      d.armR.rotation.z = -0.1;
      d.elbowL.rotation.x = -0.1;
      d.elbowR.rotation.x = -0.2;
    }
    if (v.passenger) {
      v.passenger.setWeapon('none');
      v.passenger.update(dt, 'gun', 0, 1, 0);
      if (v.seat && !v.gun) v.seat('passenger', v.passenger, 0);
    }
    // Past the reach of anyone's eyes the cabin is not worth drawing: a street of cars would draw a street of seats.
    if (v.interior) {
      const rp = v.root.position;
      v.interior.visible = !!this.driver || !!this.passenger || this.ctx.players.some((pl) => pl.cam.pos.distanceToSquared(rp) < CABIN_LOD * CABIN_LOD);
      if (v.steerWheel) v.steerWheel.visible = v.interior.visible;
    }
    // Far from every camera the wheels drop their tread blocks and bolts (see `addWheelSet`).
    if (v.setDetail) {
      const rp = v.root.position;
      let d2 = Infinity;
      for (const pl of this.ctx.players) d2 = Math.min(d2, pl.cam.pos.distanceToSquared(rp));
      v.setDetail(d2);
    }
    // The wheel turns with the steering, a good deal more than the road wheels do.
    if (v.steerWheel) v.steerWheel.rotation.z = clamp(this.body.steerAngle * -6, -3.2, 3.2);
    if (this.firing > 0) {
      this.fireFx += dt;
    }
    v.setHeadlights(this.lights && !this.wreck);
    this.bodywork.frame(dt);
    this.glass.followPanels();
    // Under a lifted bonnet (or one that has been torn off) the engine shows.
    if (v.bay) v.bay.visible = !!v.bayAlways || this.swing.hood > 0.12 || (!!this.bodywork.gonePanels().hood && !this.wreck);
    (v as BoatVisual).animate?.(dt, this.engineOn ? this.lastIntent.throttle : 0, sp);
    // Gun pivot follows the aim point.
    if (v.gun && this.gunAim) {
      const g = v.gun;
      const wp = new THREE.Vector3();
      g.updateWorldMatrix(true, false);
      wp.setFromMatrixPosition(g.matrixWorld);
      const dx = this.gunAim.x - wp.x;
      const dy = this.gunAim.y - wp.y;
      const dz = this.gunAim.z - wp.z;
      // convert world dir to vehicle-local yaw/pitch
      const inv = new THREE.Quaternion().copy(_q).invert();
      const ld = new THREE.Vector3(dx, dy, dz).applyQuaternion(inv);
      g.rotation.set(-Math.atan2(ld.y, Math.hypot(ld.x, ld.z)), Math.atan2(ld.x, ld.z), 0, 'YXZ');
      const gs = v.gunSeat;
      this.visual.passenger?.root.position.set(gs[0], gs[1], gs[2]);
    }
  }

  destroy() {
    this.bodywork.dispose();
    this.ctx.vehicleByCollider.delete(this.body.collider.handle);
    this.body.destroy();
    disposeTree(this.group);
    this.group.removeFromParent();
    this.visual.dispose();
  }
}

/** Dress a seat's figure as whoever sits in it, when they carry a look of their own; cheap when nothing changed. */
function seatAs(h: Humanoid, who: { readonly palette?: Palette } | null) {
  const pal = who?.palette;
  if (pal && h.worn !== pal) h.dress(pal);
}

/** Above this speed (m/s) a panel that was left open slams shut. */
export const SLAM_SPEED = 5;

/** How near (m) a camera must be for a car's seats, wheel and dash to be drawn. */
const CABIN_LOD = 48;

const charMat = shared(new THREE.MeshStandardMaterial({ color: 0x15130f, roughness: 0.95, metalness: 0.2 }));
void rotateByQuat;
void COOLANT_LOW;
void COOLANT_CRITICAL;
