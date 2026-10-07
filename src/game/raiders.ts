import { ENEMIES, type RaiderDef, type RaiderKind } from '../data';
import { raiderBuggyDef, wagonDef } from '../data/raiderVehicles';
import { Humanoid } from '../render/humanoid';
import { disposeTree } from '../render/dispose';
import { C } from '../render/palette';
import { angleDiff, clamp, damp, dampAngle, wrapAngle } from '../core/math';
import type { DriveInput } from '../physics/vehicle';
import { gearDrop } from '../sim/gear';
import { rollItem, type LootSpec } from '../sim/loot';
import { grantLoot } from './lootGrant';
import { rollGunLoot } from '../sim/gunLoot';
import { FLASH_SECS, MELEE, MUZZLE, knockFor, type MeleeFeel } from '../sim/weaponfx';
import { stormSight } from '../sim/weather';
import { rainSight } from '../sim/climate';
import { FIRE, SIGHT, aimSpread, fighting, guessAt, hears, inSight, mayFire, newWatch, sightRange, sightRate, stepWatch, type Watch } from '../sim/enemySight';
import type { RigidBody } from '../physics/physics';
import type { Ctx } from './ctx';
import type { Player } from './player';
import { playerShows, vehicleShows } from './sight';
import { Vehicle, type Pilot } from './vehicle';

type RState = 'approach' | 'probe' | 'flank' | 'ram' | 'retreat' | 'flee';

interface Target {
  x: number;
  z: number;
  vx: number;
  vz: number;
  vehicle: Vehicle | null;
  player: Player | null;
  d: number;
  /** In sight right now: a vehicle with a clear line to it, a person this raider can make out (not just remembers). */
  seen: boolean;
}

/**
 * The convoy vehicle most worth going for: the nearest, occupied ones first. A vehicle is big and loud, so a raider knows
 * where one is without seeing it (it still needs a line to shoot). People on foot it has to see first: `perceive`.
 */
export function acquire(ctx: Ctx, x: number, z: number, maxD: number): Target | null {
  let best: Target | null = null;
  // Dust in the air shortens what a raider can pick out, and so does heavy rain.
  maxD *= stormSight(ctx.storm) * rainSight(ctx.rain ?? 0);
  for (const v of ctx.vehicles) {
    if (v.faction !== 'convoy' || v.wreck) continue;
    const d = Math.hypot(v.position.x - x, v.position.z - z);
    if (d > maxD) continue;
    const occupied = v.driver || v.passenger ? 0 : 25; // prefer occupied vehicles
    if (!best || d + occupied < best.d) {
      const lv = v.body.body.linvel();
      best = { x: v.position.x, z: v.position.z, vx: lv.x, vz: lv.z, vehicle: v, player: null, d: d + occupied, seen: false };
    }
  }
  return best;
}

/** People a raider will go for on foot: alive, out of a vehicle, and not already down (it moves on to whoever still fights). */
const quarry = (p: Player) => p.targetable && !p.inVehicle && p.state !== 'downed';

/**
 * One brain tick of a raider's eyes and ears on the people on foot about (`sim/enemySight.ts`). `reach` scales its sight (a
 * bored sentry's is short, a scope's long). Returns the height to aim at on whoever it makes out, or null if nobody.
 */
export function perceive(ctx: Ctx, w: Watch, ex: number, ey: number, ez: number, dt: number, reach = 1, exclude?: RigidBody): number | null {
  const weather = stormSight(ctx.storm) * rainSight(ctx.rain ?? 0);
  let seen: { who: number; x: number; z: number; rate: number } | null = null;
  let heard: { who: number; x: number; z: number; d: number } | null = null;
  let aimY: number | null = null;
  for (const p of ctx.players) {
    if (!quarry(p)) continue;
    const d = Math.hypot(p.pos.x - ex, p.pos.z - ez);
    const hunting = fighting(w) && w.who === p.index;
    const look = { speed: p.moveSpeed, crouch: p.crouch, dark: ctx.night, weather, hunting };
    if (d < SIGHT.touch || d < sightRange(look) * reach) {
      const s = playerShows(ctx, ex, ey, ez, p, exclude);
      const rate = sightRate({ ...look, d: d / reach, show: s.show });
      if (rate > 0 && (!seen || rate > seen.rate)) {
        seen = { who: p.index, x: p.pos.x, z: p.pos.z, rate };
        aimY = s.aimY;
      }
    }
    const fired = ctx.raiders.lastShot[p.index];
    const shot = !!fired && ctx.time - fired.t < 0.35;
    if (hears(d, p.footSignature(), shot, shot ? fired.quiet : 1) && (!heard || d < heard.d)) {
      const [gx, gz] = guessAt(p.pos.x, p.pos.z, d, ctx.rng.next(), ctx.rng.next());
      heard = { who: p.index, x: gx, z: gz, d };
    }
  }
  stepWatch(w, dt, seen, heard, ctx.rng.next());
  return aimY;
}

/** What a raider goes for: the vehicle `acquire` found, or the person it is watching for, whichever is nearer. */
function choose(ctx: Ctx, w: Watch, veh: Target | null, x: number, z: number): Target | null {
  let best = veh;
  // Someone it has seen and is hunting, or heard or glimpsed and is coming to look at.
  const p = w.who >= 0 && (fighting(w) || w.aware >= 0.35) ? ctx.players[w.who] : null;
  if (p && quarry(p)) {
    const now = w.spotted && w.lost === 0;
    const tx = now ? p.pos.x : w.x;
    const tz = now ? p.pos.z : w.z;
    const d = Math.hypot(tx - x, tz - z);
    if (!best || d < best.d) best = { x: tx, z: tz, vx: 0, vz: 0, vehicle: null, player: p, d, seen: inSight(w) };
  }
  return best;
}

type V3 = [number, number, number];

/**
 * Where a raider car's crew sits, in the car's own frame: a capsule from `a` to `b` of radius `r`, and the height above which
 * a hit is to the head. The buggy's driver sits up in an open frame over the body; the wagon's two are side by side in the
 * armoured cab, behind its visor slits.
 */
const CREW: Record<'raiderBuggy' | 'wagon', { a: V3; b: V3; r: number; headY: number }> = {
  raiderBuggy: { a: [0, 0.3, 0.02], b: [0, 0.95, 0.12], r: 0.28, headY: 0.85 },
  wagon: { a: [-0.45, 1.0, 0.8], b: [0.45, 1.0, 0.8], r: 0.34, headY: 1.15 },
};

/**
 * How far along a ray (unit direction) it first comes within `r` of segment ab, or null if it does not within `maxD`. The
 * entry point is backed off from the closest approach as if the ray met the tube square on, which is near enough for a body.
 */
export function rayCapsule(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, a: V3, b: V3, r: number, maxD: number): number | null {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const ez = b[2] - a[2];
  const wx = ox - a[0];
  const wy = oy - a[1];
  const wz = oz - a[2];
  const ee = ex * ex + ey * ey + ez * ez;
  const de = dx * ex + dy * ey + dz * ez;
  const dw = dx * wx + dy * wy + dz * wz;
  const ew = ex * wx + ey * wy + ez * wz;
  const den = ee - de * de;
  let s = den > 1e-9 ? clamp((de * ew - ee * dw) / den, 0, maxD) : 0;
  let t = ee > 1e-9 ? (de * s + ew) / ee : 0;
  if (t < 0) {
    t = 0;
    s = clamp(-dw, 0, maxD);
  } else if (t > 1) {
    t = 1;
    s = clamp(de - dw, 0, maxD);
  }
  const qx = ox + dx * s - (a[0] + ex * t);
  const qy = oy + dy * s - (a[1] + ey * t);
  const qz = oz + dz * s - (a[2] + ez * t);
  const d2 = qx * qx + qy * qy + qz * qz;
  if (d2 > r * r) return null;
  return Math.max(0, s - Math.sqrt(r * r - d2));
}

export class RaiderPilot implements Pilot {
  readonly isPlayer = false;
  readonly index = -1;
  state: RState = 'approach';
  stateT = 0;
  orbit = Math.random() < 0.5 ? 1 : -1;
  target: Target | null = null;
  private brainT = Math.random() * 0.2;
  private fireCd = 0.5;
  private stuckT = 0;
  private reverseT = 0;
  private reverseSteer = 1;
  private steerOut = 0;
  private burst = 0;
  private burstT = 0;
  despawn = false;
  isWagon: boolean;
  /** What the crew has left between them. Shoot them out of the seats and the car is left whole. */
  crewHp: number;
  /** The crew is dead or has climbed out. */
  out = false;
  /** The gunner's eyes on whoever is about on foot. */
  readonly watch: Watch = newWatch();
  private aimY = 1.1;
  private flankPoint = { x: 0, z: 0 };

  constructor(
    private ctx: Ctx,
    public def: RaiderDef,
    private v: Vehicle,
  ) {
    this.isWagon = v.kind === 'wagon';
    this.state = 'approach';
    this.crewHp = def.crewHp ?? 60;
  }

  drive(v: Vehicle, dt: number): DriveInput {
    const ctx = this.ctx;
    // The engine is shot out: nobody sits in a dead car under fire. Out they get, guns and all.
    if (v.health.comp.engine <= 0) {
      ctx.raiders.bail(v);
      return { steer: 0, throttle: 0, brake: 1, handbrake: false };
    }
    this.stateT += dt;
    this.brainT -= dt;
    this.fireCd -= dt;
    v.setEngine(true);
    v.fuel = 99;
    const p = v.position;
    if (this.brainT <= 0) {
      this.brainT = 0.2;
      this.think(v);
    }
    const tgt = this.target;
    let tx = p.x + Math.sin(v.yaw) * 20;
    let tz = p.z + Math.cos(v.yaw) * 20;
    let spd = 0.5 * v.topSpeed;
    if (tgt) {
      const lead = clamp(tgt.d / Math.max(10, v.topSpeed), 0, 2.5);
      const px = tgt.x + tgt.vx * lead * 0.5;
      const pz = tgt.z + tgt.vz * lead * 0.5;
      switch (this.state) {
        case 'approach':
          tx = px;
          tz = pz;
          spd = v.topSpeed * 0.9;
          break;
        case 'probe': {
          // Circle at standoff range, firing.
          const a = Math.atan2(p.x - tgt.x, p.z - tgt.z) + this.orbit * 0.55;
          const R = this.isWagon ? 30 : 38;
          tx = tgt.x + Math.sin(a) * R;
          tz = tgt.z + Math.cos(a) * R;
          spd = v.topSpeed * 0.75;
          break;
        }
        case 'flank': {
          tx = this.flankPoint.x + tgt.vx * 1.5;
          tz = this.flankPoint.z + tgt.vz * 1.5;
          spd = v.topSpeed * 0.95;
          break;
        }
        case 'ram': {
          // Wagons come in from the side.
          tx = px;
          tz = pz;
          spd = v.topSpeed;
          break;
        }
        case 'retreat':
        case 'flee': {
          const a = Math.atan2(p.x - tgt.x, p.z - tgt.z);
          tx = p.x + Math.sin(a) * 60;
          tz = p.z + Math.cos(a) * 60;
          spd = v.topSpeed * 0.95;
          break;
        }
      }
    }
    // Avoid walls and rocks with three whiskers.
    let avoid = 0;
    const look = 14 + Math.abs(v.speed) * 0.5;
    for (const off of [-0.45, 0, 0.45]) {
      const a = v.yaw + off;
      if (ctx.obs.segmentBlocked(p.x, p.z, p.x + Math.sin(a) * look, p.z + Math.cos(a) * look, 1)) avoid += off === 0 ? (this.orbit * 0.9) : -off * 1.6;
    }
    const desired = Math.atan2(tx - p.x, tz - p.z);
    let err = angleDiff(v.yaw, desired);
    err += avoid;
    // Reverse out when stuck.
    if (this.reverseT > 0) {
      this.reverseT -= dt;
      return { steer: this.reverseSteer, throttle: 0, brake: 1, handbrake: false };
    }
    if (Math.abs(v.speed) < 1.2 && spd > 3) {
      this.stuckT += dt;
      if (this.stuckT > 1.4) {
        this.stuckT = 0;
        this.reverseT = 1.2;
        this.reverseSteer = Math.random() < 0.5 ? 1 : -1;
      }
    } else this.stuckT = Math.max(0, this.stuckT - dt);
    this.steerOut = damp(this.steerOut, clamp(-err * 1.6, -1, 1), 10, dt);
    const slowTurn = Math.abs(err) > 1.1 ? 0.45 : 1;
    const want = spd * slowTurn;
    const throttle = clamp((want - v.speed) * 0.5, 0, 1);
    const brake = clamp((v.speed - want) * 0.25, 0, 1);

    // Gunner
    if (tgt && this.state !== 'retreat' && this.state !== 'flee') this.shoot(v, tgt, dt);
    return { steer: this.steerOut, throttle, brake, handbrake: false };
  }

  private think(v: Vehicle) {
    const ctx = this.ctx;
    const p = v.position;
    // The gunner's eyes, up on the car: who on foot it can make out past rock, wood and leaf.
    const eye = p.y + 1.6;
    const aimY = perceive(ctx, this.watch, p.x, eye, p.z, 0.2, 1, v.body.body);
    if (aimY !== null) this.aimY = aimY;
    const veh = acquire(ctx, p.x, p.z, 320);
    if (veh?.vehicle && veh.d < this.def.range + 30) veh.seen = vehicleShows(ctx, p.x, eye, p.z, veh.vehicle);
    this.target = choose(ctx, this.watch, veh, p.x, p.z);
    const tgt = this.target;
    if (v.hpFrac < 0.28 && this.state !== 'flee' && !this.isWagon) {
      this.state = 'flee';
      this.stateT = 0;
    }
    if (!tgt) {
      if (this.state === 'flee' || this.stateT > 30) this.despawn = true;
      return;
    }
    const near = tgt.d;
    switch (this.state) {
      case 'approach':
        if (this.isWagon) {
          if (near < 90) {
            this.state = 'ram';
            this.stateT = 0;
          }
        } else if (near < 52) {
          this.state = 'probe';
          this.stateT = 0;
        }
        break;
      case 'probe':
        if (this.stateT > 4.5 + (v.id % 4)) {
          const r = Math.random();
          if (r < 0.4 && tgt.vehicle && tgt.vehicle.def.tier <= 2) {
            this.state = 'ram';
          } else if (r < 0.75) {
            this.state = 'flank';
            const side = this.orbit;
            const a = Math.atan2(tgt.vx, tgt.vz) + Math.PI / 2 * side;
            this.flankPoint = { x: tgt.x + Math.sin(a) * 14, z: tgt.z + Math.cos(a) * 14 };
            this.orbit = -this.orbit;
          } else this.orbit = -this.orbit;
          this.stateT = 0;
        }
        break;
      case 'flank':
        if (this.stateT > 3.8 || near < 10) {
          this.state = 'probe';
          this.stateT = 0;
        }
        break;
      case 'ram':
        if (this.stateT > 6 || (near < 4.5 && this.stateT > 1)) {
          this.state = 'retreat';
          this.stateT = 0;
        }
        break;
      case 'retreat':
        if (this.stateT > (this.isWagon ? 4.5 : 3.2)) {
          this.state = this.isWagon ? 'approach' : 'probe';
          this.stateT = 0;
        }
        break;
      case 'flee':
        if (near > 260) this.despawn = true;
        break;
    }
    // Wagon ram damage on contact.
    if (this.isWagon || this.state === 'ram') this.ramCheck(v);
  }

  private lastRam = 0;
  private ramCheck(v: Vehicle) {
    const ctx = this.ctx;
    if (ctx.time - this.lastRam < 1.2) return;
    for (const o of ctx.vehicles) {
      if (o.faction !== 'convoy' || o.wreck) continue;
      const d = Math.hypot(o.position.x - v.position.x, o.position.z - v.position.z);
      if (d < v.def.length * 0.5 + o.def.length * 0.4 + 0.4 && Math.abs(v.speed) > 5) {
        this.lastRam = ctx.time;
        const dmg = (this.isWagon ? this.def.ramDamage ?? 90 : 22) * ctx.campaign.difficulty.damage;
        o.takeHit(dmg, v.position.x, v.position.z, { ram: true });
        const dx = o.position.x - v.position.x;
        const dz = o.position.z - v.position.z;
        const l = Math.hypot(dx, dz) || 1;
        o.shove((dx / l) * o.mass * (this.isWagon ? 2.2 : 0.9), (dz / l) * o.mass * (this.isWagon ? 2.2 : 0.9));
        ctx.audio.play('crash', o.position.x, o.position.z, 1);
        ctx.fx.spark(o.position.x, o.position.y + 0.6, o.position.z, 8, 7);
        this.state = 'retreat';
        this.stateT = 0;
        break;
      }
    }
  }

  private shoot(v: Vehicle, tgt: Target, dt: number) {
    const ctx = this.ctx;
    const range = this.def.range;
    if (tgt.d > range) return;
    // No line of sight, no shot: a vehicle needs a clear line, a person has to be in sight (or only just lost, for the end
    // of a burst where they were) and the gunner past its first beat of bringing the gun round.
    if (tgt.player ? !mayFire(this.watch) : !tgt.seen) return;
    if (this.burstT > 0) {
      this.burstT -= dt;
      if (this.fireCd > 0) return;
    } else if (this.fireCd <= 0) {
      // Short bursts with pauses so the player can dodge.
      this.burst = 4 + Math.floor(Math.random() * 4);
      this.burstT = 0.9;
    }
    if (this.fireCd > 0) return;
    this.fireCd = 0.11;
    if (this.burst > 0) this.burst--;
    else {
      this.fireCd = 0.5 + Math.random() * 0.5;
      this.burstT = 0;
      return;
    }
    const m = v.visual.muzzle;
    m.updateWorldMatrix(true, false);
    const mx = m.matrixWorld.elements[12];
    const my = m.matrixWorld.elements[13];
    const mz = m.matrixWorld.elements[14];
    const ty = tgt.vehicle ? tgt.vehicle.position.y + 0.8 : tgt.player ? this.aimY : 1;
    let dx = tgt.x - mx;
    let dy = ty - my;
    let dz = tgt.z - mz;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l;
    dy /= l;
    dz /= l;
    const dmg = this.def.dps * 0.11 * 3.4 * ctx.campaign.difficulty.damage;
    ctx.combat.shoot(mx, my, mz, dx, dy, dz, {
      side: 'raider',
      ownVehicle: v,
      damage: dmg,
      spread: (0.02 + (tgt.d / range) * 0.03) * (tgt.player ? aimSpread(this.watch, tgt.player.moveSpeed) : 1),
      range: range + 15,
      noise: 0,
      tracer: true,
    });
    ctx.fx.flash(mx, my, mz, 0.9);
    if (Math.random() < 0.5) ctx.audio.play('mg', mx, mz, 0.45);
  }
}

// ------------------------------------------------------------------------ infantry

export interface InfantryLook {
  jacket: number;
  trim: number;
  helmet: number;
}

/** Where a camp sentry stands, which camp it answers to, and how far it will wander and chase. */
export interface GuardPost {
  camp: string;
  x: number;
  z: number;
  patrol: number;
}

/** A sentry gives up the chase this far from its post. */
const LEASH = 150;

export class Infantry {
  x: number;
  y = 0;
  z: number;
  yaw = 0;
  hp: number;
  dead = false;
  deadT = 0;
  human: Humanoid;
  state: 'approach' | 'fire' | 'sabotage' | 'flee' | 'snipe' = 'approach';
  stateT = 0;
  fireCd = 1;
  /** Seconds left of the flame at the muzzle after a shot. */
  flashT = 0;
  speed: number;
  strafe = Math.random() < 0.5 ? 1 : -1;
  strafeT = 0;
  telegraph = 0;
  target: Target | null = null;
  brainT = Math.random() * 0.25;
  sabotageVehicle: Vehicle | null = null;
  moveSpeed = 0;
  recent = 0;
  /** A gang camp sentry: holds its post until it notices someone, then fights and goes back when it loses them. */
  post: GuardPost | null = null;
  alerted = false;
  lostT = 0;
  idleT = 0;
  idleX = 0;
  idleZ = 0;
  scanPhase = Math.random() * 6.28;
  /** Its eyes and ears on the people about on foot (`sim/enemySight.ts`), and where on them it aims. */
  watch: Watch = newWatch();
  aimY = 1.1;
  /** Rounds left in the gun, and seconds of a reload. */
  mag = FIRE.mag;
  reloadT = 0;
  /** Lost them: the place it is searching round, where it is looking now, and for how long before it tries elsewhere. */
  anchorX = NaN;
  anchorZ = 0;
  searchX = 0;
  searchZ = 0;
  searchT = 0;
  /** A clear line to the vehicle it is after, as of the last brain tick. */
  clear = false;

  constructor(
    public kind: RaiderKind,
    public def: RaiderDef,
    x: number,
    z: number,
    ctx: Ctx,
    look?: InfantryLook,
  ) {
    this.x = x;
    this.z = z;
    this.hp = def.hp;
    this.speed = def.speed;
    this.human = new Humanoid({ jacket: look?.jacket ?? C.raiderRed, trim: look?.trim ?? 0x151515, helmet: look?.helmet ?? (kind === 'sniper' ? 0x39422f : 0x111111), pants: 0x4a3a2c, mask: true });
    this.human.setWeapon(kind === 'sniper' ? 'rifle' : kind === 'saboteur' ? 'jerrycan' : 'pistol');
    ctx.root.add(this.human.root);
    this.y = ctx.groundAt(x, z);
  }
}

export class RaiderSystem {
  units: Infantry[] = [];
  pilots = new Map<Vehicle, RaiderPilot>();
  kills = 0;
  /** Raiders each player put down on foot, by player index. */
  killedByPlayer: [number, number] = [0, 0];
  /** When each player last fired, and how loud the gun was (a muzzle flash is too brief for a brain that thinks 4 times a second). */
  readonly lastShot: { t: number; quiet: number }[] = [{ t: -99, quiet: 1 }, { t: -99, quiet: 1 }];

  constructor(private ctx: Ctx) {}

  get vehiclesAlive() {
    let n = 0;
    for (const v of this.ctx.vehicles) if (v.hostile) n++;
    return n;
  }
  get infantryAlive() {
    return this.units.filter((u) => !u.dead).length;
  }
  get totalAlive() {
    return this.vehiclesAlive + this.infantryAlive;
  }

  spawnBuggy(x: number, z: number, yaw: number): Vehicle {
    const v = new Vehicle(this.ctx, { def: raiderBuggyDef(), x, z, yaw, faction: 'raider', kind: 'raiderBuggy' });
    this.ctx.vehicles.push(v);
    const pilot = new RaiderPilot(this.ctx, ENEMIES.raiders.buggy, v);
    v.driver = pilot;
    v.health.hp = ENEMIES.raiders.buggy.hp;
    v.health.maxHp = ENEMIES.raiders.buggy.hp;
    if (v.visual.driver) v.visual.driver.root.visible = true;
    v.setEngine(true);
    this.pilots.set(v, pilot);
    return v;
  }

  spawnWagon(x: number, z: number, yaw: number): Vehicle {
    const v = new Vehicle(this.ctx, { def: wagonDef(), x, z, yaw, faction: 'raider', kind: 'wagon' });
    this.ctx.vehicles.push(v);
    const pilot = new RaiderPilot(this.ctx, ENEMIES.raiders.wagon, v);
    v.driver = pilot;
    v.health.hp = ENEMIES.raiders.wagon.hp;
    v.health.maxHp = ENEMIES.raiders.wagon.hp;
    v.setEngine(true);
    this.pilots.set(v, pilot);
    return v;
  }

  /** Called once when a camp's sentries first raise the alarm. */
  onAlarm: ((camp: string) => void) | null = null;

  spawnInfantry(kind: 'gunman' | 'sniper' | 'saboteur', x: number, z: number, opts?: { post?: GuardPost; look?: InfantryLook }) {
    const u = new Infantry(kind, ENEMIES.raiders[kind], x, z, this.ctx, opts?.look);
    if (kind === 'sniper') u.state = 'snipe';
    if (opts?.post) {
      u.post = opts.post;
      u.idleX = x;
      u.idleZ = z;
    }
    this.units.push(u);
    return u;
  }

  forEachTarget(x: number, z: number, r: number, fn: (x: number, y: number, z: number) => void) {
    const r2 = r * r;
    for (const u of this.units) if (!u.dead && (u.x - x) ** 2 + (u.z - z) ** 2 < r2) fn(u.x, u.y + 1.2, u.z);
    for (const v of this.ctx.vehicles) {
      if (!v.hostile) continue;
      if ((v.position.x - x) ** 2 + (v.position.z - z) ** 2 < r2) fn(v.position.x, v.position.y + 0.7, v.position.z);
    }
  }

  /**
   * The nearest raider crew a round passes through: the driver up in a buggy's open frame, or the pair in a wagon's cab.
   * `only` limits it to one car (a round that has just holed its panel), `skip` leaves one out (a crew it has gone through).
   */
  crewRayTest(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxD: number, only?: Vehicle | null, skip?: Vehicle | null): { vehicle: Vehicle; dist: number; head: boolean } | null {
    let best: { vehicle: Vehicle; dist: number; head: boolean } | null = null;
    for (const [v, pilot] of this.pilots) {
      if (pilot.out || v.wreck || v === skip || (only && v !== only)) continue;
      const seat = CREW[v.kind as keyof typeof CREW];
      if (!seat) continue;
      // Too far off the line to matter.
      const px = v.position.x - ox;
      const py = v.position.y - oy;
      const pz = v.position.z - oz;
      const along = px * dx + py * dy + pz * dz;
      if (along < -3 || along > maxD + 3 || px * px + py * py + pz * pz - along * along > 9) continue;
      const [lx, ly, lz] = v.localOf(ox, oy, oz);
      const [ex, ey, ez] = v.localOf(ox + dx, oy + dy, oz + dz);
      const ldy = ey - ly;
      const t = rayCapsule(lx, ly, lz, ex - lx, ldy, ez - lz, seat.a, seat.b, seat.r, best ? best.dist : maxD);
      if (t === null) continue;
      best = { vehicle: v, dist: t, head: ly + ldy * t > seat.headY };
    }
    return best;
  }

  /** A round found a raider car's crew. Returns true if it finished them; the car is left as it was. */
  hurtCrew(v: Vehicle, amount: number, killer: number): boolean {
    const pilot = this.pilots.get(v);
    if (!pilot || pilot.out || v.wreck) return false;
    pilot.crewHp -= amount * (1 - (pilot.def.crewCover ?? 0));
    if (pilot.crewHp > 0) return false;
    const ctx = this.ctx;
    this.leave(v, pilot);
    // Dead at the wheel: the car runs on with nobody steering, slows and stops.
    v.slumped = !!v.visual.driver;
    ctx.campaign.stats.raidersKilled++;
    this.kills++;
    if (killer >= 0) this.killedByPlayer[killer]++;
    ctx.audio.play('zdie', v.position.x, v.position.z, 0.6);
    this.kit(v.position.x, v.position.z, v.kind === 'wagon' ? 2 : 1);
    return true;
  }

  /** A car shot to pieces under its crew: they climb out and carry on the fight on foot, and the car stays where it stopped. */
  bail(v: Vehicle) {
    const pilot = this.pilots.get(v);
    if (!pilot || pilot.out || v.wreck) return;
    this.leave(v, pilot);
    if (v.visual.driver) v.visual.driver.root.visible = false;
    const n = v.kind === 'wagon' ? 2 : 1;
    const gun = ENEMIES.raiders.gunman;
    for (let i = 0; i < n; i++) {
      const side = i === 0 ? 1 : -1;
      const [x, , z] = v.doorPos(side);
      const u = this.spawnInfantry('gunman', x, z);
      u.hp = clamp(pilot.crewHp / n, 12, gun.hp);
      u.state = 'fire';
    }
  }

  /** The crew is gone from the car, one way or the other: nobody drives it or fires its gun again. */
  private leave(v: Vehicle, pilot: RaiderPilot) {
    pilot.out = true;
    v.driver = null;
    v.abandoned = true;
    v.setEngine(false);
  }

  infantryRayTest(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxD: number): { unit: Infantry; dist: number; head: boolean } | null {
    let best: { unit: Infantry; dist: number; head: boolean } | null = null;
    const dh = Math.hypot(dx, dz);
    if (dh < 1e-6) return null;
    const ux = dx / dh;
    const uz = dz / dh;
    for (const u of this.units) {
      if (u.dead) continue;
      const vx = u.x - ox;
      const vz = u.z - oz;
      const t0 = vx * ux + vz * uz;
      if (t0 < 0 || t0 > maxD * dh) continue;
      if (Math.hypot(ox + ux * t0 - u.x, oz + uz * t0 - u.z) > 0.45) continue;
      const tt = t0 / dh;
      const yy = oy + dy * tt;
      if (yy < u.y - 0.1 || yy > u.y + 1.85) continue;
      if (!best || tt < best.dist) best = { unit: u, dist: tt, head: yy > u.y + 1.5 };
    }
    return best;
  }

  /** A raider's own kit, rolled from the raider table: rounds, fuel, food, the odd part. Rounds are banked, cans lie beside the body. */
  private kit(x: number, z: number, n: number) {
    const ctx = this.ctx;
    const specs: LootSpec[] = [];
    for (let i = 0; i < n; i++) {
      const s = rollItem('raider', ctx.rng, { progress: Math.min(1, 0.2 + ctx.gearProgress) });
      if (s) specs.push(s);
    }
    if (specs.length) grantLoot(ctx, specs, { x, z });
  }

  /** A raider's kit can survive them: it lies where they fell, for anyone to take. */
  private dropGear(x: number, z: number, src: 'raider' | 'wreck') {
    const ctx = this.ctx;
    const find = gearDrop(ctx.rng, src, { progress: ctx.gearProgress });
    if (find) ctx.dropGear(find, x, z);
  }

  /** The whole camp turns on whoever is there, and its reinforcements are called out. */
  alertCamp(camp: string, word?: { who: number; x: number; z: number }) {
    let fresh = false;
    for (const q of this.units) {
      if (q.dead || q.post?.camp !== camp) continue;
      if (!q.alerted) fresh = true;
      q.alerted = true;
      q.lostT = 0;
      if (q.state === 'approach') q.state = q.kind === 'sniper' ? 'snipe' : 'fire';
      // The shout says where: they all come, but each has to see them for itself before it shoots.
      if (word) this.tell(q, word.who, word.x, word.z);
    }
    if (fresh) this.onAlarm?.(camp);
  }

  /** Word of where someone is (a shout, a round from that way): it turns and comes to look, but does not yet see them. */
  private tell(q: Infantry, who: number, x: number, z: number) {
    const w = q.watch;
    if (w.who === who ? inSight(w) : fighting(w)) return;
    if (w.who !== who) w.spotted = false;
    w.who = who;
    w.x = x;
    w.z = z;
    w.aware = Math.max(w.aware, SIGHT.heardAware);
  }

  damageInfantry(u: Infantry, amount: number, killer: number, silent = false): boolean {
    if (u.dead) return false;
    u.hp -= amount * (1 - u.def.armor);
    u.recent = 0.2;
    // Hit, it knows roughly which way it came from; the shout carries that to the rest of the camp.
    const by = killer >= 0 ? this.ctx.players[killer] : null;
    let word: { who: number; x: number; z: number } | undefined;
    if (by && !silent) {
      const [gx, gz] = guessAt(by.pos.x, by.pos.z, Math.hypot(by.pos.x - u.x, by.pos.z - u.z), this.ctx.rng.next(), this.ctx.rng.next());
      word = { who: killer, x: gx, z: gz };
      this.tell(u, killer, gx, gz);
    }
    // A hit raises the alarm; a clean takedown with the blade does not.
    if (u.post && !(silent && u.hp <= 0)) this.alertCamp(u.post.camp, word);
    if (u.hp <= 0) {
      u.dead = true;
      u.deadT = 0;
      this.ctx.campaign.stats.raidersKilled++;
      this.kills++;
      if (killer >= 0) this.killedByPlayer[killer]++;
      this.ctx.fx.blood(u.x, u.y + 1, u.z, 8);
      this.ctx.audio.play('zdie', u.x, u.z, 0.6);
      // What a raider carried: a box of rounds, a can, a tin; named things, taken off the body.
      if (Math.random() < 0.45) this.kit(u.x, u.z, 1);
      if (Math.random() < 0.18) rollGunLoot('raider', Math.floor(Math.random() * 1e9), 0).forEach((g, i) => this.ctx.dropGear(g, u.x + 0.6 * i, u.z + 0.5));
      this.dropGear(u.x, u.z, 'raider');
      return true;
    }
    if (u.state === 'approach') u.state = u.kind === 'sniper' ? 'snipe' : 'fire';
    return false;
  }

  blast(x: number, z: number, r: number, dmg: number, killer: number, friendly: boolean) {
    for (const u of this.units) {
      if (u.dead) continue;
      const d = Math.hypot(u.x - x, u.z - z);
      if (d < r) this.damageInfantry(u, dmg * (1 - (d / r) * 0.6), killer);
    }
    void friendly;
  }

  burnArea(x: number, z: number, r: number, dps: number, dt: number) {
    for (const u of this.units) if (!u.dead && Math.hypot(u.x - x, u.z - z) < r) this.damageInfantry(u, dps * dt, -1);
  }

  meleeHit(p: Player, hx: number, hz: number, yaw: number, reach: number, dmg: number, feel: MeleeFeel = MELEE.fist): number {
    let hit = 0;
    for (const u of this.units) {
      if (u.dead) continue;
      const dx = u.x - p.pos.x;
      const dz = u.z - p.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > reach + 0.4) continue;
      if (Math.abs(wrapAngle(Math.atan2(dx, dz) - yaw)) > 1.0) continue;
      this.damageInfantry(u, dmg, p.index, true);
      hit++;
      // A raider is a person, not a crowd: a wide weapon can catch two, never more.
      if (hit >= Math.min(2, Math.max(1, feel.cleave - 1))) break;
    }
    void hx;
    void hz;
    return hit;
  }

  clearAll() {
    for (const u of this.units) {
      disposeTree(u.human.root);
      u.human.root.removeFromParent();
    }
    this.units.length = 0;
    for (const v of this.ctx.vehicles.slice()) {
      if (v.faction === 'raider') {
        v.destroy();
        this.ctx.vehicles.splice(this.ctx.vehicles.indexOf(v), 1);
      }
    }
    this.pilots.clear();
  }

  update(dt: number) {
    const ctx = this.ctx;
    for (const p of ctx.players) {
      if (p.muzzleT <= 0 || !this.lastShot[p.index]) continue;
      this.lastShot[p.index] = { t: ctx.time, quiet: p.equip === 'gun' ? p.kit().quiet : 1 };
    }
    // Vehicle cleanup: fled, far away, or wrecked for a while.
    for (const [v, pilot] of this.pilots) {
      if (v.wreck && !pilot.despawn) {
        pilot.despawn = false;
      }
      let far = true;
      for (const p of ctx.players) if (Math.hypot(p.pos.x - v.position.x, p.pos.z - v.position.z) < 380) far = false;
      if (pilot.despawn || (far && ctx.mode === 'leg')) {
        this.removeVehicle(v);
      } else if (v.wreck && v.burnT <= 0) {
        // keep wrecks as scenery until they are far away
      }
    }
    // Infantry AI
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      if (u.dead) {
        u.deadT += dt;
        u.human.update(dt, 'downed', 0, 0, 0);
        if (u.deadT > 6) {
          disposeTree(u.human.root);
          u.human.root.removeFromParent();
          this.units.splice(i, 1);
        }
        continue;
      }
      this.stepInfantry(u, dt);
    }
  }

  private removeVehicle(v: Vehicle) {
    this.pilots.delete(v);
    const i = this.ctx.vehicles.indexOf(v);
    if (i >= 0) this.ctx.vehicles.splice(i, 1);
    v.destroy();
  }

  onVehicleDestroyed(v: Vehicle) {
    if (v.faction !== 'raider') return;
    const wagon = v.kind === 'wagon';
    // A car whose crew was already shot or had climbed out was counted then: blowing it up now kills nobody.
    if (v.abandoned) {
      if (wagon) this.dropGear(v.position.x, v.position.z, 'wreck');
      return;
    }
    this.ctx.campaign.stats.raidersKilled++;
    this.kills++;
    // The wreck itself is what is worth stripping (its engine, its plates, its gun mount); the crew's own kit is on the ground by it.
    this.kit(v.position.x, v.position.z, wagon ? 3 : Math.random() < 0.5 ? 1 : 0);
    if (wagon) this.dropGear(v.position.x, v.position.z, 'wreck');
    const pilot = this.pilots.get(v);
    if (pilot) pilot.despawn = false;
  }

  private stepInfantry(u: Infantry, dt: number) {
    const ctx = this.ctx;
    u.stateT += dt;
    u.brainT -= dt;
    u.fireCd -= dt;
    if (u.recent > 0) u.recent -= dt;
    if (u.reloadT > 0 && (u.reloadT -= dt) <= 0) u.mag = FIRE.mag;
    if (u.brainT <= 0) {
      u.brainT = 0.25;
      // Eyes and ears. A bored sentry looks about half as hard as one that knows there is trouble; a scope reaches further.
      const eye = u.y + 1.55;
      const aimY = perceive(ctx, u.watch, u.x, eye, u.z, 0.25, (u.post && !u.alerted ? 0.5 : 1) * (u.kind === 'sniper' ? 1.4 : 1));
      if (aimY !== null) u.aimY = aimY;
      if (u.post && !u.alerted) {
        u.target = null;
        if (this.guardNotices(u)) this.alertCamp(u.post.camp, inSight(u.watch) ? { who: u.watch.who, x: u.watch.x, z: u.watch.z } : undefined);
      } else {
        const veh = acquire(ctx, u.x, u.z, 160);
        if (veh?.vehicle && veh.d < 140) veh.seen = vehicleShows(ctx, u.x, eye, u.z, veh.vehicle);
        u.target = choose(ctx, u.watch, veh, u.x, u.z);
      }
      // Lost them with the gun half empty: a moment to fill it.
      if (u.reloadT <= 0 && u.mag < FIRE.mag / 2 && !inSight(u.watch)) u.reloadT = FIRE.reload[0];
    }
    let tgt = u.target;
    if (u.post && u.alerted) {
      // Past the leash a sentry lets go and walks home; with nobody in sight for a while it stands down.
      if (tgt && Math.hypot(tgt.x - u.post.x, tgt.z - u.post.z) > LEASH) tgt = null;
      u.lostT = tgt?.seen ? 0 : u.lostT + dt;
      if (u.lostT > 14) u.alerted = false;
    }
    let wantX = 0;
    let wantZ = 0;
    let spd = 0;
    if (tgt) {
      const dx = tgt.x - u.x;
      const dz = tgt.z - u.z;
      const d = Math.hypot(dx, dz) || 1;
      const nx = dx / d;
      const nz = dz / d;
      const standoff = u.kind === 'sniper' ? 80 : 26;
      // Someone it remembers or only heard, not someone it sees: no shooting at shadows. It goes to look (a sniper holds
      // its ground and watches the place).
      const hunting = !!tgt.player && !tgt.seen && u.kind !== 'saboteur';
      if (hunting) {
        u.telegraph = 0;
        if (u.kind !== 'sniper') {
          const s = this.search(u, dt);
          wantX = s.x;
          wantZ = s.z;
          spd = s.spd;
        }
      } else if (u.kind === 'saboteur') {
        // Run at the nearest vehicle, then torch it.
        let bestV: Vehicle | null = null;
        let bd = Infinity;
        for (const v of ctx.vehicles) {
          if (v.faction !== 'convoy' || v.wreck) continue;
          const dd = Math.hypot(v.position.x - u.x, v.position.z - u.z);
          if (dd < bd) {
            bd = dd;
            bestV = v;
          }
        }
        if (bestV) {
          u.sabotageVehicle = bestV;
          const vx = bestV.position.x - u.x;
          const vz = bestV.position.z - u.z;
          const vd = Math.hypot(vx, vz) || 1;
          if (u.state === 'flee') {
            wantX = -vx / vd;
            wantZ = -vz / vd;
            spd = u.speed * 1.1;
            if (u.stateT > 5) u.state = 'approach';
          } else if (vd > bestV.def.length * 0.5 + 1.2) {
            wantX = vx / vd;
            wantZ = vz / vd;
            spd = u.speed;
          } else {
            u.state = 'sabotage';
            u.moveSpeed = 0;
            if (u.stateT > 3) {
              u.stateT = 0;
              u.state = 'flee';
              const steal = Math.min(6, ctx.campaign.stocks.fuel);
              ctx.campaign.stocks.fuel -= steal;
              bestV.takeHit(30, u.x, u.z, { incendiary: true });
              bestV.health.burning = true;
              for (const p of ctx.players) p.note('Saboteur torched a vehicle and stole fuel!', 'bad');
            } else if (Math.random() < 0.1) ctx.fx.spark(u.x, u.y + 0.9, u.z, 2, 3);
          }
        }
      } else if (u.kind === 'sniper') {
        u.state = 'snipe';
        if (d > standoff + 15) {
          wantX = nx;
          wantZ = nz;
          spd = u.speed;
        } else if (d < standoff - 25) {
          wantX = -nx;
          wantZ = -nz;
          spd = u.speed * 0.8;
        }
        const clear = tgt.player ? mayFire(u.watch) && u.watch.lost === 0 : tgt.seen;
        if (d < 130 && clear && u.fireCd <= 0) {
          // Telegraphed shot: a red glint for 0.9 s so watchers get a chance to react.
          u.telegraph += dt;
          ctx.fx.glow.emit(u.x + Math.sin(u.yaw) * 0.6, u.y + 1.4, u.z + Math.cos(u.yaw) * 0.6, 0, 0, 0, 0.1, 0.35, 0.2, 1, 0.1, 0.05, 0.9, 0, 0);
          if (u.telegraph >= 0.9) {
            u.telegraph = 0;
            u.fireCd = 2.4 + Math.random();
            this.shootAt(u, tgt, d, 22);
          }
        } else u.telegraph = 0;
      } else {
        // Gunman: close to standoff range, strafe, fire in bursts.
        if (d > standoff + 4) {
          wantX = nx;
          wantZ = nz;
          spd = u.speed;
        } else if (d < standoff - 8) {
          wantX = -nx;
          wantZ = -nz;
          spd = u.speed * 0.7;
        } else {
          u.strafeT -= dt;
          if (u.strafeT <= 0) {
            u.strafeT = 1 + Math.random() * 1.6;
            u.strafe = -u.strafe;
          }
          wantX = -nz * u.strafe;
          wantZ = nx * u.strafe;
          spd = u.speed * 0.6;
        }
        const clear = tgt.player ? mayFire(u.watch) : tgt.seen;
        if (d < u.def.range && u.fireCd <= 0 && u.reloadT <= 0 && clear) this.pull(u, tgt, d);
      }
    } else if (u.post) {
      const g = this.guardStep(u, dt);
      wantX = g.x;
      wantZ = g.z;
      spd = g.spd;
    }
    u.moveSpeed = damp(u.moveSpeed, spd, 10, dt);
    const p = { x: u.x + wantX * u.moveSpeed * dt, z: u.z + wantZ * u.moveSpeed * dt };
    ctx.obs.resolveCircle(p, 0.4);
    u.x = p.x;
    u.z = p.z;
    u.y = ctx.groundAt(u.x, u.z);
    if (tgt) {
      const want = Math.atan2(tgt.x - u.x, tgt.z - u.z);
      u.yaw = dampAngle(u.yaw, spd > 0.3 && u.kind === 'saboteur' ? Math.atan2(wantX, wantZ) : want, 10, dt);
    }
    u.human.root.position.set(u.x, u.y, u.z);
    u.human.root.rotation.y = u.yaw;
    u.human.update(dt, 'stand', u.moveSpeed, u.kind === 'saboteur' ? 0 : u.fireCd < 0.2 ? 1 : 0.6, 0);
    u.human.muzzle(u.flashT / FLASH_SECS);
    u.flashT = Math.max(0, u.flashT - dt);
  }

  /**
   * Does a sentry notice someone? Someone on foot only once its watch has picked them out (see `perceive`: behind a rock
   * or down in a bush they can pass). A vehicle by its engine and bulk: engines carry far, shots and horns further.
   */
  private guardNotices(u: Infantry): boolean {
    const ctx = this.ctx;
    if (inSight(u.watch)) return true;
    const sight = stormSight(ctx.storm) * rainSight(ctx.rain ?? 0);
    for (const p of ctx.players) {
      const v = p.vehicle;
      if (!p.alive || !v) continue;
      const d = Math.hypot(v.position.x - u.x, v.position.z - u.z);
      let range = Math.abs(v.speed) > 2 ? 120 : 55;
      range *= 0.75 + clamp(p.signatureShown / 50, 0, 1) * 0.6;
      if (p.signatureShown >= 55) range = Math.max(range, 100);
      if (d > range * sight) continue;
      if (d < 14 || vehicleShows(ctx, u.x, u.y + 1.55, u.z, v)) return true;
    }
    return false;
  }

  /** Lost them, or only heard them: go to where they were, then cast about round it, warily. */
  private search(u: Infantry, dt: number): { x: number; z: number; spd: number } {
    const w = u.watch;
    u.searchT -= dt;
    if (!(Math.hypot(w.x - u.anchorX, w.z - u.anchorZ) < 3)) {
      // Fresh word of them: straight to the place.
      u.anchorX = u.searchX = w.x;
      u.anchorZ = u.searchZ = w.z;
      u.searchT = 15;
    } else if (u.searchT <= 0 || Math.hypot(u.searchX - u.x, u.searchZ - u.z) < 1.5) {
      const a = Math.random() * Math.PI * 2;
      const r = 3 + Math.random() * 9;
      u.searchX = u.anchorX + Math.sin(a) * r;
      u.searchZ = u.anchorZ + Math.cos(a) * r;
      u.searchT = 5;
    }
    const dx = u.searchX - u.x;
    const dz = u.searchZ - u.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.8) return { x: 0, z: 0, spd: 0 };
    return { x: dx / d, z: dz / d, spd: u.speed * 0.7 };
  }

  /** One pull of a gunman's trigger, and the reload when the gun runs dry. */
  private pull(u: Infantry, tgt: Target, d: number) {
    u.fireCd = FIRE.cadence[0] + Math.random() * (FIRE.cadence[1] - FIRE.cadence[0]);
    this.shootAt(u, tgt, d, u.def.dps * 0.7);
    if (--u.mag <= 0) u.reloadT = FIRE.reload[0] + Math.random() * (FIRE.reload[1] - FIRE.reload[0]);
  }

  /** What a sentry does with no one to shoot at: wander near its post (or stand and scan), or walk back to it. */
  private guardStep(u: Infantry, dt: number): { x: number; z: number; spd: number } {
    const post = u.post!;
    u.idleT -= dt;
    const w = u.watch;
    if (u.alerted) {
      u.idleX = post.x;
      u.idleZ = post.z;
    } else if (w.who >= 0 && w.aware >= 0.35 && Math.hypot(w.x - post.x, w.z - post.z) < LEASH * 0.5) {
      // Heard something, or half saw it: wander over and look, slowly.
      u.idleX = w.x;
      u.idleZ = w.z;
      u.idleT = 2;
    } else if (u.idleT <= 0) {
      u.idleT = 3 + Math.random() * 5;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * post.patrol;
      u.idleX = post.x + Math.sin(a) * r;
      u.idleZ = post.z + Math.cos(a) * r;
    }
    const dx = u.idleX - u.x;
    const dz = u.idleZ - u.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.8) {
      u.yaw = dampAngle(u.yaw, Math.atan2(dx, dz), 6, dt);
      return { x: dx / d, z: dz / d, spd: u.alerted ? u.speed : u.speed * 0.3 };
    }
    // Standing: a slow sweep of the horizon.
    u.yaw = wrapAngle(u.yaw + Math.sin(this.ctx.time * 0.5 + u.scanPhase) * 0.5 * dt);
    return { x: 0, z: 0, spd: 0 };
  }

  private shootAt(u: Infantry, tgt: Target, d: number, dmg: number) {
    const ctx = this.ctx;
    const ox = u.x + Math.sin(u.yaw) * 0.5;
    const oy = u.y + 1.4;
    const oz = u.z + Math.cos(u.yaw) * 0.5;
    // At a person: whatever of them shows (a head over a rock), and wide until its aim has settled on them.
    const ty = tgt.vehicle ? tgt.vehicle.position.y + 0.8 : tgt.player ? u.aimY : 1;
    let dx = tgt.x - ox;
    let dy = ty - oy;
    let dz = tgt.z - oz;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l;
    dy /= l;
    dz /= l;
    const aim = tgt.player ? aimSpread(u.watch, tgt.player.moveSpeed) : 1;
    ctx.combat.shoot(ox, oy, oz, dx, dy, dz, {
      side: 'raider',
      ammo: u.kind === 'sniper' ? 'sniper' : 'raider',
      damage: dmg,
      spread: (u.kind === 'sniper' ? 0.006 : 0.025 + d * 0.0009) * aim,
      range: u.def.range + 10,
      tracer: true,
    });
    const m = MUZZLE[u.kind === 'sniper' ? 'rifle' : 'pistol'];
    // The flame, the smoke and the light come from the gun in the raider's hands as it was last drawn.
    u.human.capturePoints();
    const mp = u.human.points.valid ? u.human.points.muzzle : null;
    const [fx, fy, fz] = mp ? [mp.x, mp.y, mp.z] : [ox, oy, oz];
    ctx.fx.muzzle(fx, fy, fz, dx, dy, dz, m);
    ctx.combat.muzzleLight(fx, fy, fz, m.light * 0.8, dx, dy, dz);
    u.flashT = FLASH_SECS;
    ctx.audio.play(u.kind === 'sniper' ? 'sniper' : 'pistol', ox, oz, 0.5);
  }
}
