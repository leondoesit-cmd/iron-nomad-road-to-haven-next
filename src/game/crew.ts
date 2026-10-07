import { MERCS, t, vehicleDef } from '../data';
import { fixOneComponent, needsRepair } from '../sim/damage';
import { performanceMult, refusesOrders, type Merc } from '../sim/loyalty';
import type { DriveInput } from '../physics/vehicle';
import type { Ctx } from './ctx';
import { Vehicle, type Pilot } from './vehicle';
import { newSteerState, steerTo } from './aiDrive';

export type CrewMode = 'follow' | 'hold' | 'spread' | 'regroup';
export type CrewCommand = 'ping' | 'hold' | 'follow' | 'spread' | 'regroup';

const MECHANIC_COLOR = 0x3ab0a0;

class CrewPilot implements Pilot {
  readonly isPlayer = false;
  readonly index = -2;
  st = newSteerState();
  constructor(
    private sys: CrewSystem,
    private unit: CrewUnit,
  ) {}
  drive(v: Vehicle, dt: number): DriveInput {
    return this.sys.driveUnit(this.unit, v, dt);
  }
}

export class CrewUnit {
  vehicle: Vehicle;
  pilot: CrewPilot;
  repairT = 0;
  componentT = 0;
  warnedCover = 0;
  said = 0;
  target: Vehicle | null = null;
  constructor(
    public merc: Merc,
    vehicle: Vehicle,
    sys: CrewSystem,
  ) {
    this.vehicle = vehicle;
    this.pilot = new CrewPilot(sys, this);
  }
}

/** The Mechanic and, later, other mercenaries. Autonomous: steered by the D-pad command wheel only. */
export class CrewSystem {
  units: CrewUnit[] = [];
  mode: CrewMode = 'follow';
  priority: Vehicle | null = null;
  private trail: { x: number; z: number }[] = [];
  private lastHead = { x: 0, z: 0 };
  /** Where crew head in camp (set by the camp scene). */
  anchor: { x: number; z: number } | null = null;
  /** Active repair beam targets for effects. */
  repairing = false;

  constructor(private ctx: Ctx) {}

  spawn(merc: Merc, x: number, z: number, yaw: number) {
    if (merc.role !== 'mechanic') return null; // other roles arrive in the Beta
    const def = vehicleDef(2);
    const v = new Vehicle(this.ctx, { def, x, z, yaw, faction: 'convoy', kind: 'crew', color: MECHANIC_COLOR, ownerIndex: -1 });
    this.ctx.vehicles.push(v);
    const u = new CrewUnit(merc, v, this);
    v.driver = u.pilot;
    v.setEngine(true);
    v.fuel = 99;
    this.units.push(u);
    return u;
  }

  clear() {
    for (const u of this.units) {
      const i = this.ctx.vehicles.indexOf(u.vehicle);
      if (i >= 0) this.ctx.vehicles.splice(i, 1);
      u.vehicle.destroy();
    }
    this.units.length = 0;
    this.trail.length = 0;
  }

  /** The lead point the convoy follows: the furthest-forward player vehicle, else the players' centroid. */
  private leader(): { x: number; z: number; speed: number; vehicle: Vehicle | null } {
    let best: Vehicle | null = null;
    for (const p of this.ctx.players) {
      if (p.state === 'driving' && p.vehicle && (!best || p.vehicle.position.z > best.position.z)) best = p.vehicle;
    }
    if (best) return { x: best.position.x, z: best.position.z, speed: best.speed, vehicle: best };
    let x = 0;
    let z = 0;
    let n = 0;
    for (const p of this.ctx.players) {
      if (!p.alive) continue;
      x += p.pos.x;
      z += p.pos.z;
      n++;
    }
    return n ? { x: x / n, z: z / n, speed: 0, vehicle: null } : { x: 0, z: 0, speed: 0, vehicle: null };
  }

  command(cmd: CrewCommand, from: number, ping?: { x: number; z: number; vehicle: Vehicle | null }) {
    const ctx = this.ctx;
    for (const u of this.units) {
      if (refusesOrders(u.merc)) {
        ctx.radio(t('radio.crew.refuse', { name: u.merc.name }));
        return;
      }
    }
    switch (cmd) {
      case 'hold':
        this.mode = 'hold';
        ctx.notify(from, 'Crew: hold position', 'info');
        break;
      case 'follow':
        this.mode = 'follow';
        this.priority = null;
        ctx.notify(from, 'Crew: follow', 'info');
        break;
      case 'spread':
        this.mode = 'spread';
        ctx.notify(from, 'Crew: spread out', 'info');
        break;
      case 'regroup':
        this.mode = 'regroup';
        ctx.notify(from, 'Crew: regroup', 'info');
        break;
      case 'ping':
        if (ping?.vehicle && ping.vehicle.faction === 'convoy' && ping.vehicle.kind !== 'crew') {
          this.priority = ping.vehicle;
          ctx.notify(from, 'Mechanic: priority repair', 'good');
        } else {
          ctx.notify(from, 'Ping', 'info');
        }
        break;
    }
  }

  update(dt: number) {
    const ctx = this.ctx;
    const lead = this.leader();
    // Record breadcrumbs of where the leader has been.
    if (lead.vehicle) {
      const d = Math.hypot(lead.x - this.lastHead.x, lead.z - this.lastHead.z);
      if (d > 3 || !this.trail.length) {
        this.trail.push({ x: lead.x, z: lead.z });
        this.lastHead = { x: lead.x, z: lead.z };
        if (this.trail.length > 90) this.trail.shift();
      }
    }
    this.repairing = false;
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      if (u.vehicle.wreck) {
        u.merc.alive = false;
        ctx.radio(`${u.merc.name} didn't make it.`);
        this.units.splice(i, 1);
        continue;
      }
      u.vehicle.fuel = 99;
      this.repair(u, dt, lead.speed);
    }
  }

  private under(u: CrewUnit) {
    const ctx = this.ctx;
    if (u.vehicle.sinceHit < 2.5) return true;
    const p = u.vehicle.position;
    for (const v of ctx.vehicles) {
      if (v.hostile && Math.hypot(v.position.x - p.x, v.position.z - p.z) < 70) return true;
    }
    for (const r of ctx.raiders.units) if (!r.dead && Math.hypot(r.x - p.x, r.z - p.z) < 60) return true;
    return false;
  }

  private repair(u: CrewUnit, dt: number, leadSpeed: number) {
    const ctx = this.ctx;
    const v = u.vehicle;
    // Choose a target: priority ping, else the most damaged convoy vehicle in reach.
    let target: Vehicle | null = this.priority && !this.priority.wreck && needsRepair(this.priority.health) ? this.priority : null;
    if (!target) {
      let bestScore = Infinity;
      for (const o of ctx.vehicles) {
        if (o === v || o.faction !== 'convoy' || o.wreck || !needsRepair(o.health)) continue;
        const d = Math.hypot(o.position.x - v.position.x, o.position.z - v.position.z);
        if (d > 60) continue;
        const score = d - (1 - o.hpFrac) * 40;
        if (score < bestScore) {
          bestScore = score;
          target = o;
        }
      }
    }
    u.target = target;
    if (!target) {
      u.repairT = 0;
      return;
    }
    const d = Math.hypot(target.position.x - v.position.x, target.position.z - v.position.z);
    if (this.under(u)) {
      if (ctx.time - u.warnedCover > 25) {
        u.warnedCover = ctx.time;
        ctx.radio(t('radio.mechanic.cover'));
      }
      return;
    }
    if (d > 7.5) return; // still driving over
    const halted = leadSpeed < 3 && Math.abs(target.speed) < 3;
    const rate = (halted ? MERCS.roles.mechanic.repairHalted ?? 5 : MERCS.roles.mechanic.repairMoving ?? 2) * performanceMult(u.merc.loyalty) * (halted ? 1 : 0.7);
    if (u.repairT === 0 && ctx.time - u.said > 20) {
      u.said = ctx.time;
      ctx.radio(t('radio.mechanic.fix'));
    }
    u.repairT += dt;
    this.repairing = true;
    const h = target.health;
    h.hp = Math.min(h.maxHp, h.hp + rate * dt);
    h.comp.plates = Math.min(1, h.comp.plates + dt * 0.01);
    u.componentT += dt;
    if (u.componentT > 5 && halted) {
      u.componentT = 0;
      const fixed = fixOneComponent(h);
      if (fixed !== 'none') {
        for (const p of ctx.players) if (p.vehicle === target || p.ownVehicle === target) p.note(`Mechanic fixed: ${fixed}`, 'good');
        ctx.audio.play('wrench', target.position.x, target.position.z, 0.6);
      }
    }
    if (Math.random() < 0.12) ctx.fx.spark(target.position.x + (Math.random() - 0.5), target.position.y + 0.7, target.position.z + (Math.random() - 0.5), 2, 3);
  }

  /** Called by CrewPilot every tick. */
  driveUnit(u: CrewUnit, v: Vehicle, dt: number): DriveInput {
    const ctx = this.ctx;
    const lead = this.leader();
    const st = u.pilot.st;
    const pos = v.position;
    let tx = pos.x;
    let tz = pos.z;
    let speed = 0;
    if (u.target && !this.under(u)) {
      // Drive to the vehicle that needs repair and park beside it.
      const d = Math.hypot(u.target.position.x - pos.x, u.target.position.z - pos.z);
      if (d > 5.5) {
        tx = u.target.position.x;
        tz = u.target.position.z;
        speed = Math.min(14, 4 + d * 0.5);
      } else {
        return { steer: 0, throttle: 0, brake: 1, handbrake: true };
      }
      return steerTo(v, tx, tz, speed, st, ctx.obs, dt);
    }
    if (this.mode === 'hold') return { steer: 0, throttle: 0, brake: 1, handbrake: true };
    if (ctx.mode === 'camp' && this.anchor) {
      const d = Math.hypot(this.anchor.x - pos.x, this.anchor.z - pos.z);
      if (d < 3) return { steer: 0, throttle: 0, brake: 1, handbrake: true };
      return steerTo(v, this.anchor.x, this.anchor.z, Math.min(9, 2 + d * 0.4), st, ctx.obs, dt);
    }
    const gap = this.mode === 'regroup' ? 9 : this.mode === 'spread' ? 28 : 18;
    // Find the breadcrumb `gap` metres behind the leader.
    let acc = 0;
    let point = this.trail.length ? this.trail[0] : { x: lead.x, z: lead.z };
    let prev = { x: lead.x, z: lead.z };
    for (let i = this.trail.length - 1; i >= 0; i--) {
      const seg = Math.hypot(this.trail[i].x - prev.x, this.trail[i].z - prev.z);
      acc += seg;
      point = this.trail[i];
      if (acc >= gap) break;
      prev = this.trail[i];
    }
    const side = this.mode === 'spread' ? 9 : 0;
    tx = point.x + side;
    tz = point.z;
    const dLead = Math.hypot(lead.x - pos.x, lead.z - pos.z);
    // Speed governor: match the leader and close gaps.
    speed = Math.max(0, lead.speed + (dLead - gap) * 0.7);
    if (dLead < gap * 0.7 && lead.speed < 2) speed = 0;
    speed = Math.min(speed, v.topSpeed * 0.95);
    if (!lead.vehicle) speed = dLead > 10 ? Math.min(8, 2 + dLead * 0.4) : 0;
    if (lead.vehicle === null) {
      tx = lead.x + 6;
      tz = lead.z - 6;
    }
    return steerTo(v, tx, tz, speed, st, ctx.obs, dt);
  }
}
