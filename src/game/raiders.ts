import { ENEMIES, type RaiderDef, type RaiderKind } from '../data';
import { raiderBuggyDef, wagonDef } from '../data/raiderVehicles';
import { Humanoid } from '../render/humanoid';
import { disposeTree } from '../render/dispose';
import { C } from '../render/palette';
import { angleDiff, clamp, damp, dampAngle, wrapAngle } from '../core/math';
import type { DriveInput } from '../physics/vehicle';
import type { Ctx } from './ctx';
import type { Player } from './player';
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
}

/** Closest thing worth attacking: a convoy vehicle or a player on foot. */
function acquire(ctx: Ctx, x: number, z: number, maxD: number): Target | null {
  let best: Target | null = null;
  for (const v of ctx.vehicles) {
    if (v.faction !== 'convoy' || v.wreck) continue;
    const d = Math.hypot(v.position.x - x, v.position.z - z);
    if (d > maxD) continue;
    const occupied = v.driver || v.passenger ? 0 : 25; // prefer occupied vehicles
    if (!best || d + occupied < best.d) {
      const lv = v.body.body.linvel();
      best = { x: v.position.x, z: v.position.z, vx: lv.x, vz: lv.z, vehicle: v, player: null, d: d + occupied };
    }
  }
  for (const p of ctx.players) {
    if (!p.targetable || p.inVehicle) continue;
    const d = Math.hypot(p.pos.x - x, p.pos.z - z);
    if (d > maxD) continue;
    if (!best || d < best.d) best = { x: p.pos.x, z: p.pos.z, vx: 0, vz: 0, vehicle: null, player: p, d };
  }
  return best;
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
  private flankPoint = { x: 0, z: 0 };

  constructor(
    private ctx: Ctx,
    public def: RaiderDef,
    private v: Vehicle,
  ) {
    this.isWagon = v.kind === 'wagon';
    this.state = 'approach';
  }

  drive(v: Vehicle, dt: number): DriveInput {
    const ctx = this.ctx;
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
    this.target = acquire(ctx, p.x, p.z, 320);
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
    const p = v.position;
    // No line of sight, no shot.
    if (ctx.obs.segmentBlocked(p.x, p.z, tgt.x, tgt.z, 1.4)) return;
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
    const ty = (tgt.vehicle ? tgt.vehicle.position.y + 0.8 : tgt.player ? tgt.player.pos.y + 1.1 : 1);
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
      spread: 0.02 + (tgt.d / range) * 0.03,
      range: range + 15,
      noise: 0,
      tracer: true,
    });
    ctx.fx.flash(mx, my, mz, 0.9);
    if (Math.random() < 0.5) ctx.audio.play('mg', mx, mz, 0.45);
  }
}

// ------------------------------------------------------------------------ infantry

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
  speed: number;
  strafe = Math.random() < 0.5 ? 1 : -1;
  strafeT = 0;
  telegraph = 0;
  target: Target | null = null;
  brainT = Math.random() * 0.25;
  sabotageVehicle: Vehicle | null = null;
  moveSpeed = 0;
  recent = 0;

  constructor(
    public kind: RaiderKind,
    public def: RaiderDef,
    x: number,
    z: number,
    ctx: Ctx,
  ) {
    this.x = x;
    this.z = z;
    this.hp = def.hp;
    this.speed = def.speed;
    this.human = new Humanoid({ jacket: C.raiderRed, trim: 0x151515, helmet: kind === 'sniper' ? 0x39422f : 0x111111, pants: 0x4a3a2c, mask: true });
    this.human.setWeapon(kind === 'sniper' ? 'rifle' : kind === 'saboteur' ? 'jerrycan' : 'pistol');
    ctx.root.add(this.human.root);
    this.y = ctx.groundAt(x, z);
  }
}

export class RaiderSystem {
  units: Infantry[] = [];
  pilots = new Map<Vehicle, RaiderPilot>();
  kills = 0;

  constructor(private ctx: Ctx) {}

  get vehiclesAlive() {
    let n = 0;
    for (const v of this.ctx.vehicles) if (v.faction === 'raider' && !v.wreck) n++;
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

  spawnInfantry(kind: 'gunman' | 'sniper' | 'saboteur', x: number, z: number) {
    const u = new Infantry(kind, ENEMIES.raiders[kind], x, z, this.ctx);
    if (kind === 'sniper') u.state = 'snipe';
    this.units.push(u);
    return u;
  }

  forEachTarget(x: number, z: number, r: number, fn: (x: number, y: number, z: number) => void) {
    const r2 = r * r;
    for (const u of this.units) if (!u.dead && (u.x - x) ** 2 + (u.z - z) ** 2 < r2) fn(u.x, u.y + 1.2, u.z);
    for (const v of this.ctx.vehicles) {
      if (v.faction !== 'raider' || v.wreck) continue;
      if ((v.position.x - x) ** 2 + (v.position.z - z) ** 2 < r2) fn(v.position.x, v.position.y + 0.7, v.position.z);
    }
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

  damageInfantry(u: Infantry, amount: number, killer: number): boolean {
    if (u.dead) return false;
    u.hp -= amount * (1 - u.def.armor);
    u.recent = 0.2;
    if (u.hp <= 0) {
      u.dead = true;
      u.deadT = 0;
      this.ctx.campaign.stats.raidersKilled++;
      this.kills++;
      this.ctx.fx.blood(u.x, u.y + 1, u.z, 8);
      this.ctx.audio.play('zdie', u.x, u.z, 0.6);
      if (Math.random() < 0.5) this.ctx.addLoot({ scrap: 4 + Math.floor(Math.random() * 5) }, 'raider');
      if (Math.random() < 0.2) this.ctx.addLoot({ parts: 1 + Math.floor(Math.random() * 2) }, 'raider');
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

  meleeHit(p: Player, hx: number, hz: number, yaw: number, reach: number, dmg: number) {
    for (const u of this.units) {
      if (u.dead) continue;
      const dx = u.x - p.pos.x;
      const dz = u.z - p.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > reach + 0.4) continue;
      if (Math.abs(wrapAngle(Math.atan2(dx, dz) - yaw)) > 1.0) continue;
      this.damageInfantry(u, dmg, p.index);
      break;
    }
    void hx;
    void hz;
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
    this.ctx.campaign.stats.raidersKilled++;
    this.kills++;
    const wagon = v.kind === 'wagon';
    this.ctx.addLoot({ scrap: wagon ? 40 : 14 + Math.floor(Math.random() * 10), parts: wagon ? 10 : 2 }, 'wreck');
    const pilot = this.pilots.get(v);
    if (pilot) pilot.despawn = false;
  }

  private stepInfantry(u: Infantry, dt: number) {
    const ctx = this.ctx;
    u.stateT += dt;
    u.brainT -= dt;
    u.fireCd -= dt;
    if (u.recent > 0) u.recent -= dt;
    if (u.brainT <= 0) {
      u.brainT = 0.25;
      u.target = acquire(ctx, u.x, u.z, 160);
    }
    const tgt = u.target;
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
      if (u.kind === 'saboteur') {
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
        if (d < 130 && !ctx.obs.segmentBlocked(u.x, u.z, tgt.x, tgt.z, 1.4) && u.fireCd <= 0) {
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
        if (d < u.def.range && u.fireCd <= 0 && !ctx.obs.segmentBlocked(u.x, u.z, tgt.x, tgt.z, 1.4)) {
          u.fireCd = 0.35 + Math.random() * 0.25;
          if (Math.random() < 0.18) u.fireCd += 1.3;
          this.shootAt(u, tgt, d, u.def.dps * 0.7);
        }
      }
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
    u.human.muzzle(false);
  }

  private shootAt(u: Infantry, tgt: Target, d: number, dmg: number) {
    const ctx = this.ctx;
    const ox = u.x + Math.sin(u.yaw) * 0.5;
    const oy = u.y + 1.4;
    const oz = u.z + Math.cos(u.yaw) * 0.5;
    const ty = tgt.vehicle ? tgt.vehicle.position.y + 0.8 : tgt.player ? tgt.player.pos.y + 1.1 : 1;
    let dx = tgt.x - ox;
    let dy = ty - oy;
    let dz = tgt.z - oz;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l;
    dy /= l;
    dz /= l;
    ctx.combat.shoot(ox, oy, oz, dx, dy, dz, {
      side: 'raider',
      damage: dmg * ctx.campaign.difficulty.damage,
      spread: u.kind === 'sniper' ? 0.006 : 0.025 + d * 0.0009,
      range: u.def.range + 10,
      tracer: true,
    });
    ctx.fx.flash(ox, oy, oz, 0.8);
    ctx.audio.play(u.kind === 'sniper' ? 'sniper' : 'pistol', ox, oz, 0.5);
  }
}
