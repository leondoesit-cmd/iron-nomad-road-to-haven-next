import * as THREE from 'three';
import { ENEMIES, t, type ZombieDef, type ZombieKind } from '../data';
import { clamp, damp, dist2, lerp, wrapAngle } from '../core/math';
import type { Aabb } from '../world/layout';
import { armDamageMult, damageFraction, legSpeedMult, limbsGone, maskOf, massOf, newWounds, staggerSpeed, wound, zoneOf, type AmmoSpec, type Wounds, type Zone } from '../sim/ballistics';
import { MELEE, knockFor, type MeleeFeel } from '../sim/weaponfx';
import type { ZombieRenderer } from '../render/zombieRender';
import type { Ctx } from './ctx';
import type { Player } from './player';
import type { Vehicle } from './vehicle';

export type ZState = 'dormant' | 'wander' | 'investigate' | 'chase' | 'swarm';

let zid = 1;

export class Zombie {
  id = zid++;
  def: ZombieDef;
  x: number;
  y = 0;
  z: number;
  yaw: number;
  vx = 0;
  vz = 0;
  hp: number;
  state: ZState;
  stateT = 0;
  homeX: number;
  homeZ: number;
  tx: number;
  tz: number;
  hasTarget = false;
  targetPlayer: Player | null = null;
  lostT = 0;
  dead = false;
  fall = 0;
  deadT = 0;
  phase: number;
  stride = 4;
  chase = 0;
  attackCd = 0;
  grabbing: Player | null = null;
  stun = 0;
  aiT: number;
  slow = 1;
  burn = 0;
  shriekCd = 0;
  stuckT = 0;
  sideT = 0;
  sideDir = 1;
  lastX = 0;
  lastZ = 0;
  raid = false;
  variant: number;
  wireDps = 0;
  hesitating = false;
  active = false;
  /** Heading for a doorway because a wall is in the way. */
  routeT = 0;
  routeX = 0;
  routeZ = 0;
  routeCool = 0;
  /** What heavy rounds have taken off, and how much each limb has taken since. */
  wounds: Wounds = newWounds();
  /** 0 to 1: how far it is reeling from a hit (leans back, arms thrown up). Fades on its own. */
  stagger = 0;
  /** Share of its walking speed left once legs are gone. */
  moveMult = 1;
  /** Share of its bite and claw left once arms are gone. */
  biteMult = 1;
  /** Which way and how hard the last bullet hit: a corpse is thrown that way. */
  lastHit: { dx: number; dz: number; power: number } | null = null;

  constructor(
    public kind: ZombieKind,
    x: number,
    z: number,
    dormant: boolean,
    public cluster: number,
  ) {
    this.def = ENEMIES.zombies[kind];
    this.x = x;
    this.z = z;
    this.homeX = x;
    this.homeZ = z;
    this.tx = x;
    this.tz = z;
    this.hp = this.def.hp;
    this.state = dormant ? 'dormant' : 'wander';
    this.yaw = Math.random() * Math.PI * 2;
    this.phase = Math.random() * 6.28;
    this.variant = Math.floor(Math.random() * 5);
    this.aiT = Math.random() * 0.05;
    this.lastX = x;
    this.lastZ = z;
  }

  get chasing() {
    return this.state === 'chase' || this.state === 'swarm';
  }
}

/** A building the dead can walk into: its footprint and the doorways at ground level. */
export interface DoorBuilding {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Doorway centres and the unit normal of the wall they are in. */
  doors: { x: number; z: number; nx: number; nz: number }[];
  /** A point a stride to each side of every doorway, and distances between those that can see each other (built on first use). */
  nodes?: { x: number; z: number; door: number }[];
  adj?: number[][];
}

const NO_FURNITURE = new Set(['furniture']);

export interface SporeCloud {
  x: number;
  z: number;
  r: number;
  t: number;
}

const _spore: SporeCloud[] = [];

export class ZombieSystem {
  list: Zombie[] = [];
  spores = _spore;
  /** Hook so camp structures and barricades can take damage from attackers. */
  onObstacleHit: (a: Aabb, dmg: number, z: Zombie) => void = () => {};
  /** In camp raids, where unaware attackers head. */
  raidTarget: { x: number; z: number } | null = null;
  /** Set by the leg scene: ground-floor doorways of every building. */
  buildings: DoorBuilding[] = [];
  private cascadeT = 0;
  private cascadeTold = false;
  private grid = new Map<number, Zombie[]>();
  private grabbers = new Map<Player, Zombie[]>();
  killedByPlayer: [number, number] = [0, 0];
  private time = 0;

  constructor(private ctx: Ctx) {
    this.spores.length = 0;
  }

  spawn(kind: ZombieKind, x: number, z: number, dormant: boolean, cluster = 0) {
    const zb = new Zombie(kind, x, z, dormant, cluster);
    zb.y = this.ctx.groundAt(x, z);
    this.list.push(zb);
    return zb;
  }

  get aliveCount() {
    let n = 0;
    for (const z of this.list) if (!z.dead) n++;
    return n;
  }

  forEachNear(x: number, z: number, r: number, fn: (z: Zombie) => void) {
    const r2 = r * r;
    for (const zb of this.list) if (!zb.dead && (zb.x - x) ** 2 + (zb.z - z) ** 2 <= r2) fn(zb);
  }

  /** Ray vs cylinder. Heads are the top 20% of the body. */
  rayTest(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxD: number): { zombie: Zombie; dist: number; head: boolean } | null {
    let best: { zombie: Zombie; dist: number; head: boolean } | null = null;
    const dh = Math.hypot(dx, dz);
    if (dh < 1e-6) return null;
    const ux = dx / dh;
    const uz = dz / dh;
    for (const zb of this.list) {
      if (zb.dead) continue;
      const vx = zb.x - ox;
      const vz = zb.z - oz;
      const t0 = vx * ux + vz * uz;
      if (t0 < 0 || t0 > maxD * dh) continue;
      const cx = ox + ux * t0;
      const cz = oz + uz * t0;
      const r = zb.def.radius * 0.95 + 0.08;
      if (Math.hypot(cx - zb.x, cz - zb.z) > r) continue;
      const tt = t0 / dh; // parameter along the 3D ray (unit)
      const yy = oy + dy * tt;
      const h = 1.8 * zb.def.scale;
      if (yy < zb.y - 0.1 || yy > zb.y + h) continue;
      if (!best || tt < best.dist) best = { zombie: zb, dist: tt, head: yy > zb.y + h * 0.8 };
    }
    return best;
  }

  /** Apply damage; returns true if the zombie died. */
  damage(zb: Zombie, amount: number, info: { fromX: number; fromZ: number; head?: boolean; killer?: number; explosive?: boolean; fire?: boolean }): boolean {
    if (zb.dead) return false;
    zb.hp -= amount;
    zb.stun = Math.max(zb.stun, zb.kind === 'brute' ? 0 : 0.12);
    // Hit zombies know where it came from.
    if (!zb.chasing && !zb.dead) this.alert(zb, info.fromX, info.fromZ, info.killer ?? -1);
    if (zb.hp <= 0) {
      this.kill(zb, info.killer ?? -1, info.explosive);
      return true;
    }
    return false;
  }

  private alert(zb: Zombie, x: number, z: number, killer: number) {
    const p = killer >= 0 ? this.ctx.players[killer] : null;
    zb.state = 'chase';
    zb.chase = Math.max(zb.chase, 0.3);
    zb.tx = x;
    zb.tz = z;
    zb.hasTarget = true;
    if (p && p.targetable) zb.targetPlayer = p;
  }

  kill(zb: Zombie, killer: number, explosive = false) {
    if (zb.dead) return;
    zb.dead = true;
    zb.deadT = 0;
    zb.fall = 0;
    this.release(zb);
    const ctx = this.ctx;
    ctx.campaign.stats.zombiesKilled++;
    if (killer >= 0) this.killedByPlayer[killer]++;
    ctx.fx.blood(zb.x, zb.y + 1, zb.z, 6);
    ctx.gore.corpse(zb.x, zb.y, zb.z, zb.def.scale, zb.lastHit?.power ?? (explosive ? 2 : 0.5), zb.lastHit?.dx ?? 0, zb.lastHit?.dz ?? 0);
    ctx.audio.play('zdie', zb.x, zb.z, 0.5);
    if (zb.kind === 'bloater') {
      const d = zb.def;
      this.spores.push({ x: zb.x, z: zb.z, r: d.sporeRadius ?? 5, t: d.sporeTime ?? 6 });
      ctx.radio('Bloater burst: stay out of the spores!');
    }
    if (explosive) ctx.fx.blood(zb.x, zb.y + 1, zb.z, 8);
  }

  private release(zb: Zombie) {
    if (zb.grabbing) {
      const arr = this.grabbers.get(zb.grabbing);
      if (arr) this.grabbers.set(zb.grabbing, arr.filter((q) => q !== zb));
      zb.grabbing.pinned = Math.max(0, (this.grabbers.get(zb.grabbing)?.length ?? 0));
      zb.grabbing = null;
    }
  }

  /** Rip one to three pieces off a body that a blast has just killed, and throw them. */
  private tear(zb: Zombie, dx: number, dz: number, power: number) {
    const ctx = this.ctx;
    const pool = ['armL', 'armR', 'legL', 'legR', 'head'] as const;
    const n = 1 + Math.min(2, Math.floor(power / 1.5));
    for (let i = 0; i < n; i++) {
      const zone = pool[Math.floor(ctx.rng.next() * pool.length)];
      const m = maskOf(zone);
      if ((zb.wounds.mask & m) === m) continue;
      zb.wounds.mask |= m;
      ctx.gore.sever(zb, zone, dx, 0.5, dz, power);
    }
    this.refreshWounds(zb);
  }

  /** Shove a body: it reels back at `speed` m/s along (dx, dz) and loses its footing for a moment, a heavy one barely. */
  knock(zb: Zombie, dx: number, dz: number, speed: number) {
    if (zb.dead || speed <= 0) return;
    const l = Math.hypot(dx, dz) || 1;
    zb.vx += (dx / l) * speed;
    zb.vz += (dz / l) * speed;
    zb.stagger = Math.min(1, zb.stagger + speed / 5);
    // It cannot walk while it is being thrown: stunned for as long as the shove (all of a blast's pellets together) lasts.
    // Brutes shrug off a small shove; anything that really moves them stuns them for a beat.
    const moving = Math.hypot(zb.vx, zb.vz);
    if (zb.kind !== 'brute' || moving > 3) zb.stun = Math.max(zb.stun, Math.min(0.6, 0.08 + moving * 0.075));
  }

  /** What a body is missing, and what that does to how it moves and bites. */
  private refreshWounds(zb: Zombie) {
    const g = limbsGone(zb.wounds.mask);
    zb.moveMult = legSpeedMult(g.legs);
    zb.biteMult = armDamageMult(g.arms);
  }

  /**
   * A round struck. Deals the damage, shoves the body along the bullet's path, works out which part was hit, and takes
   * off what a round that heavy can. Returns what happened, so the caller can throw the pieces.
   */
  bulletHit(
    zb: Zombie,
    h: { dmg: number; dx: number; dy: number; dz: number; x: number; y: number; z: number; head: boolean; spec: AmmoSpec; speed: number; fromX: number; fromZ: number; killer: number },
  ): { killed: boolean; zone: Zone; off: ('head' | 'armL' | 'armR' | 'legL' | 'legR')[] } {
    const sc = zb.def.scale;
    // Where on the body: height as a share of it, and which side (the model's +x is the body's left).
    const rx = Math.cos(zb.yaw);
    const rz = -Math.sin(zb.yaw);
    const lateral = (h.x - zb.x) * rx + (h.z - zb.z) * rz;
    const relY = (h.y - zb.y) / (1.8 * sc);
    let zone = zoneOf(relY, lateral, sc);
    if (h.head) zone = 'head';
    zb.lastHit = { dx: h.dx, dz: h.dz, power: (h.dmg * Math.max(0.2, h.spec.gore)) / zb.def.hp };
    const killed = this.damage(zb, h.dmg, { fromX: h.fromX, fromZ: h.fromZ, head: h.head, killer: h.killer });
    this.knock(zb, h.dx, h.dz, staggerSpeed(h.spec, h.speed, massOf(sc)) * damageFraction(h.speed / h.spec.speed));
    const res = wound(zb.wounds, zone, h.dmg, h.spec.gore, zb.def.hp, killed, this.ctx.rng.next());
    if (res.off.length) {
      this.refreshWounds(zb);
      if (res.off.includes('head') && !zb.dead) this.kill(zb, h.killer);
    }
    if (killed || zb.dead) {
      // It drops where the round was heading: turn it so it topples along the shot.
      zb.yaw = Math.atan2(-h.dx, -h.dz);
    }
    return { killed: killed || zb.dead, zone, off: res.off };
  }

  /** Area damage with a quadratic falloff. */
  blast(x: number, z: number, radius: number, damage: number, killer: number) {
    for (const zb of this.list) {
      if (zb.dead) continue;
      const d = Math.hypot(zb.x - x, zb.z - z);
      if (d > radius) continue;
      const f = 1 - (d / radius) ** 2 * 0.7;
      const l = d || 1;
      zb.lastHit = { dx: (zb.x - x) / l, dz: (zb.z - z) / l, power: (damage * f) / zb.def.hp };
      const killed = this.damage(zb, damage * f, { fromX: x, fromZ: z, killer, explosive: true });
      const k = (1 - d / radius) * 6;
      zb.vx += ((zb.x - x) / l) * k;
      zb.vz += ((zb.z - z) / l) * k;
      // A blast that more than kills tears pieces off.
      if (killed && damage * f >= zb.def.hp * 1.2) this.tear(zb, (zb.x - x) / l, (zb.z - z) / l, (damage * f) / zb.def.hp);
    }
  }

  /** Fire damage over time at a point. */
  burnArea(x: number, z: number, r: number, dps: number, dt: number, killer: number) {
    for (const zb of this.list) {
      if (zb.dead) continue;
      if (Math.hypot(zb.x - x, zb.z - z) <= r) {
        zb.burn = 1.5;
        this.damage(zb, dps * dt, { fromX: x, fromZ: z, killer, fire: true });
      }
    }
  }

  /** Wake every sleeping zombie near a point. */
  hordeAlert(x: number, z: number, r: number, toX = x, toZ = z) {
    let n = 0;
    for (const zb of this.list) {
      if (zb.dead || zb.chasing) continue;
      if (Math.hypot(zb.x - x, zb.z - z) <= r) {
        zb.state = 'swarm';
        zb.tx = toX;
        zb.tz = toZ;
        zb.hasTarget = true;
        n++;
      }
    }
    return n;
  }

  // ------------------------------------------------------------------ melee & takedown

  takedownTarget(p: Player): Zombie | null {
    let best: Zombie | null = null;
    let bd = 1.5;
    for (const zb of this.list) {
      if (zb.dead || (zb.state !== 'dormant' && zb.state !== 'wander')) continue;
      if (zb.kind === 'brute' || zb.kind === 'bloater') continue;
      const dx = p.pos.x - zb.x;
      const dz = p.pos.z - zb.z;
      const d = Math.hypot(dx, dz);
      if (d > bd) continue;
      // The player must be behind: facing roughly the same way as the zombie.
      const fx = Math.sin(zb.yaw);
      const fz = Math.cos(zb.yaw);
      if ((dx * fx + dz * fz) / (d || 1) > -0.25) continue;
      bd = d;
      best = zb;
    }
    return best;
  }

  takedown(zb: Zombie, killer: number) {
    this.kill(zb, killer);
  }

  /**
   * A swing of a weapon: everything in front of the player and within reach takes the blow, up to what the weapon can cleave
   * through. Each body is shoved back (a heavy one moves less) and staggered. Returns how many it landed on.
   */
  meleeHit(p: Player, hx: number, hz: number, yaw: number, reach: number, dmg: number, feel: MeleeFeel = MELEE.fist): number {
    let hit = 0;
    for (const zb of this.list) {
      if (zb.dead) continue;
      const dx = zb.x - p.pos.x;
      const dz = zb.z - p.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > reach + zb.def.radius) continue;
      const ang = Math.abs(wrapAngle(Math.atan2(dx, dz) - yaw));
      if (ang > 1.0) continue;
      const k = zb.def.armor > 0 ? 1 - zb.def.armor : 1;
      this.damage(zb, dmg * k, { fromX: p.pos.x, fromZ: p.pos.z, killer: p.index });
      const push = knockFor(feel, massOf(zb.def.scale));
      zb.vx += (dx / (d || 1)) * push;
      zb.vz += (dz / (d || 1)) * push;
      zb.stun = Math.max(zb.stun, feel.stun);
      hit++;
      if (hit >= feel.cleave) break;
    }
    if (hit) {
      this.ctx.fx.blood(hx, p.pos.y + 1.1, hz, 4);
      this.ctx.audio.play('thud', hx, hz, 0.7);
    }
    return hit;
  }

  /** Free a pinned player: grabbers are knocked back and stunned. */
  breakGrab(p: Player) {
    const arr = this.grabbers.get(p) ?? [];
    for (const zb of arr) {
      const dx = zb.x - p.pos.x;
      const dz = zb.z - p.pos.z;
      const l = Math.hypot(dx, dz) || 1;
      zb.vx = (dx / l) * 7;
      zb.vz = (dz / l) * 7;
      zb.stun = 1.4;
      zb.grabbing = null;
    }
    this.grabbers.set(p, []);
    p.pinned = 0;
  }

  // ------------------------------------------------------------------ vehicle plow

  /** Vehicles plow zombies through a volume in front of the chassis. Each contact costs about 3% speed. */
  plow(v: Vehicle, dt: number) {
    const sp = v.speed;
    if (sp < 3.2 || v.wreck) return;
    const [fx, , fz] = v.body.forward();
    const p = v.position;
    // A bull bar or dozer blade sweeps wider, hits harder and costs far less speed per zombie.
    const pl = v.stats.plow;
    const w = v.def.width / 2 + 0.45 + pl * 0.5;
    const front = v.def.length / 2;
    const loss = ENEMIES.zombieRules.tierSpeedLoss[Math.min(4, v.def.tier - 1)] * (1 - Math.min(0.7, pl * 0.9));
    let hits = 0;
    for (const zb of this.list) {
      if (zb.dead) continue;
      const rx = zb.x - p.x;
      const rz = zb.z - p.z;
      if (Math.abs(rx) > 8 || Math.abs(rz) > 8) continue;
      const lz = rx * fx + rz * fz;
      const lx = rx * fz - rz * fx;
      if (lz < front - 1.1 || lz > front + 1.5 || Math.abs(lx) > w + zb.def.radius) continue;
      const dmg = (22 + sp * 6.5) * (v.def.tier >= 3 ? 1.5 : v.def.tier === 2 ? 1.0 : 0.65) * (1 + pl);
      const res = zb.def.armor > 0 ? 1 - zb.def.armor : 1;
      const killed = this.damage(zb, dmg * res, { fromX: p.x, fromZ: p.z, killer: v.driver?.isPlayer ? v.driver.index : -1, explosive: false });
      zb.vx += fx * sp * 0.6 - fz * lx * 0.3;
      zb.vz += fz * sp * 0.6 + fx * lx * 0.3;
      zb.stun = 0.5;
      hits++;
      this.ctx.fx.blood(zb.x, zb.y + 1, zb.z, 4);
      // Whatever the nose hits stays on the paint.
      v.bodywork.splat(zb.kind === 'brute' ? 0.07 : 0.04);
      if (!killed && zb.kind === 'brute') {
        // Brutes shrug off a moped.
        v.takeHit(10 + sp, zb.x, zb.z, { ram: true, silent: true, smash: true });
        v.shove(-fx * v.mass * 1.2, -fz * v.mass * 1.2);
      }
      if (v.def.tier === 1 && Math.random() < 0.25) v.takeHit(3, zb.x, zb.z, { ram: true, silent: true });
    }
    if (hits) {
      const k = Math.pow(1 - loss, hits);
      const lv = v.body.body.linvel();
      v.body.body.setLinvel({ x: lv.x * k, y: lv.y, z: lv.z * k }, true);
      this.ctx.audio.play('thud', p.x, p.z, 0.8);
      if (v.driver?.isPlayer) {
        this.ctx.input.rumble(v.driver.index, 0.3, 0.4, 70);
        this.ctx.players[v.driver.index]?.cam.addShake(0.06 * Math.min(4, hits));
      }
    }
    void dt;
  }

  // ------------------------------------------------------------------ main update

  update(dt: number) {
    const ctx = this.ctx;
    this.time += dt;
    // Remove corpses and build the spatial grid for separation.
    this.grid.clear();
    let chasers = 0;
    let anyPlayerActive = false;
    for (const p of ctx.players) if (p.alive) anyPlayerActive = true;
    if (!anyPlayerActive) return;
    const act = 150;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const zb = this.list[i];
      if (zb.dead) {
        zb.deadT += dt;
        zb.fall = Math.min(1, zb.deadT / 0.55);
        // A body thrown by the round that killed it slides on and settles.
        if (Math.abs(zb.vx) + Math.abs(zb.vz) > 0.05) {
          const p = { x: zb.x + zb.vx * dt, z: zb.z + zb.vz * dt };
          ctx.obs.resolveCircle(p, 0.3, undefined, zb.y);
          zb.x = p.x;
          zb.z = p.z;
          const k = Math.exp(-5 * dt);
          zb.vx *= k;
          zb.vz *= k;
          zb.y = ctx.groundAt(zb.x, zb.z);
        }
        zb.stagger = Math.max(0, zb.stagger - dt * 3);
        if (zb.deadT > 3.2) {
          this.list[i] = this.list[this.list.length - 1];
          this.list.pop();
        }
        continue;
      }
      // Activity gating: far zombies freeze.
      let near = false;
      for (const p of ctx.players) {
        if (Math.abs(p.pos.x - zb.x) < act && Math.abs(p.pos.z - zb.z) < act) {
          near = true;
          break;
        }
      }
      zb.active = near;
      if (!near) continue;
      zb.y = ctx.groundAt(zb.x, zb.z);
      const k = (Math.floor(zb.x / 3) + 1000) * 4096 + Math.floor(zb.z / 3);
      let c = this.grid.get(k);
      if (!c) this.grid.set(k, (c = []));
      c.push(zb);
      if (zb.chasing) chasers++;
    }
    // Horde cascade: five or more chasing wakes dormant zombies within 30 m.
    this.cascadeT -= dt;
    if (chasers >= ENEMIES.zombieRules.cascadeChasers && this.cascadeT <= 0) {
      this.cascadeT = 1.2;
      let woke = 0;
      for (const zb of this.list) {
        if (!zb.chasing || zb.dead) continue;
        woke += this.hordeAlert(zb.x, zb.z, ENEMIES.zombieRules.cascadeRadius, zb.tx, zb.tz);
      }
      if (woke > 3 && !this.cascadeTold) {
        this.cascadeTold = true;
        ctx.radio(t('radio.horde'));
      }
    }
    if (chasers === 0) this.cascadeTold = false;

    this.grabbers.clear();
    for (const zb of this.list) {
      if (zb.dead || !zb.active) continue;
      this.step(zb, dt);
    }
    // Pin and damage on foot players.
    for (const p of ctx.players) {
      const arr = this.grabbers.get(p) ?? [];
      p.pinned = arr.length;
      if (arr.length && (p.state === 'foot' || p.state === 'downed')) {
        const rules = ENEMIES.zombieRules;
        if (arr.length >= rules.pinAt) {
          p.hurt(rules.pinDps * dt, arr[0].x, arr[0].z, 'bite');
        } else {
          let dmg = 0;
          for (const z of arr) dmg += (z.def.damage * z.biteMult) / (z.kind === 'brute' ? 1.1 : 1);
          p.hurt(dmg * dt, arr[0].x, arr[0].z, 'bite');
        }
      }
    }
    // Spore clouds.
    for (let i = this.spores.length - 1; i >= 0; i--) {
      const s = this.spores[i];
      s.t -= dt;
      if (Math.random() < 0.5) ctx.fx.puff(s.x + (Math.random() - 0.5) * s.r, 0.5 + ctx.groundAt(s.x, s.z), s.z + (Math.random() - 0.5) * s.r, 0.5, 0.6, 0.2, 2.4, 1.4);
      for (const p of ctx.players) {
        if ((p.state === 'foot' || p.state === 'downed') && Math.hypot(p.pos.x - s.x, p.pos.z - s.z) < s.r) p.hurt(ENEMIES.zombies.bloater.sporeDps! * dt, s.x, s.z, 'spore');
      }
      if (s.t <= 0) this.spores.splice(i, 1);
    }
  }

  private pickTarget(zb: Zombie): { x: number; z: number; player: Player | null; vehicle: Vehicle | null; d: number } | null {
    const ctx = this.ctx;
    let best: { x: number; z: number; player: Player | null; vehicle: Vehicle | null; d: number } | null = null;
    for (const p of ctx.players) {
      if (!p.alive) continue;
      const inVeh = p.inVehicle && p.vehicle;
      if (zb.kind === 'stalker' && inVeh) continue; // Stalkers ignore engines and hunt people on foot
      if (inVeh && zb.chasing === false && false) continue;
      const d = Math.hypot(p.pos.x - zb.x, p.pos.z - zb.z);
      if (!best || d < best.d) best = { x: p.pos.x, z: p.pos.z, player: inVeh ? null : p, vehicle: inVeh ? p.vehicle : null, d };
    }
    return best;
  }

  /** Hearing: grid lookup of the loudest Noise this zombie can hear, halved when walls are in the way. */
  private hear(zb: Zombie) {
    const ctx = this.ctx;
    let src = ctx.sig.loudestFor(zb.x, zb.z, false, 'noise');
    if (src && ctx.obs.segmentBlocked(zb.x, zb.z, src.x, src.z, 1.2)) {
      src = ctx.sig.loudestFor(zb.x, zb.z, true, 'noise');
    }
    return src;
  }

  /**
   * Walls stop a straight walk. When one is in the way, search the building's doorways (they can see each other
   * through the plan) for the shortest way to the target and head for the first of them, then ask again from there.
   */
  private route(zb: Zombie, dt: number) {
    const ctx = this.ctx;
    if (zb.routeT > 0) {
      zb.routeT -= dt;
      if (Math.hypot(zb.routeX - zb.x, zb.routeZ - zb.z) < 0.4) {
        // Arrived: pick the next hop at once, not after a stretch of walking straight into the wall.
        zb.routeT = 0;
        zb.routeCool = 0;
      } else return;
    }
    zb.routeCool -= dt;
    if (zb.routeCool > 0) return;
    zb.routeCool = 0.3 + Math.random() * 0.15;
    const ax = zb.x;
    const az = zb.z;
    const bx = zb.tx;
    const bz = zb.tz;
    const mx = Math.min(ax, bx) - 3;
    const Mx = Math.max(ax, bx) + 3;
    const mz = Math.min(az, bz) - 3;
    const Mz = Math.max(az, bz) + 3;
    // Furniture slows the dead down but doesn't set their course; walls do.
    const blocked = (x0: number, z0: number, x1: number, z1: number) => ctx.obs.segmentBlocked(x0, z0, x1, z1, 0.5, NO_FURNITURE);
    let direct: boolean | null = null;
    let best: { x: number; z: number } | null = null;
    let bestCost = Infinity;
    for (const b of this.buildings) {
      if (b.x1 < mx || b.x0 > Mx || b.z1 < mz || b.z0 > Mz) continue;
      if (direct === null) direct = !blocked(ax, az, bx, bz);
      if (direct) return;
      if (!b.doors.length) continue;
      if (!b.nodes || !b.adj) {
        const nodes: { x: number; z: number; door: number }[] = [];
        b.doors.forEach((d, k) => {
          nodes.push({ x: d.x - d.nx * 0.75, z: d.z - d.nz * 0.75, door: k }, { x: d.x + d.nx * 0.75, z: d.z + d.nz * 0.75, door: k });
        });
        b.nodes = nodes;
        b.adj = nodes.map((p, i) =>
          nodes.map((q, j) => {
            if (i === j) return 0;
            // The two sides of one doorway are joined by walking through it.
            if (p.door === q.door) return 1.5;
            return !blocked(p.x, p.z, q.x, q.z) ? Math.hypot(p.x - q.x, p.z - q.z) : Infinity;
          }),
        );
      }
      const nodes = b.nodes;
      const n = nodes.length;
      const dist = new Array<number>(n).fill(Infinity);
      const first = new Array<number>(n).fill(-1);
      for (let i = 0; i < n; i++) {
        const d = nodes[i];
        // Not the point already underfoot.
        if (Math.hypot(d.x - ax, d.z - az) < 0.5) continue;
        if (!blocked(ax, az, d.x, d.z)) {
          dist[i] = Math.hypot(d.x - ax, d.z - az);
          first[i] = i;
        }
      }
      for (let pass = 0; pass < n; pass++) {
        let changed = false;
        for (let i = 0; i < n; i++) {
          if (dist[i] === Infinity) continue;
          for (let j = 0; j < n; j++) {
            const w = b.adj[i][j];
            if (w === Infinity || i === j) continue;
            if (dist[i] + w < dist[j] - 1e-6) {
              dist[j] = dist[i] + w;
              first[j] = first[i];
              changed = true;
            }
          }
        }
        if (!changed) break;
      }
      for (let i = 0; i < n; i++) {
        if (dist[i] === Infinity) continue;
        const d = nodes[i];
        if (blocked(d.x, d.z, bx, bz)) continue;
        const cost = dist[i] + Math.hypot(bx - d.x, bz - d.z);
        if (cost < bestCost) {
          bestCost = cost;
          best = nodes[first[i]];
        }
      }
    }
    if (best) {
      zb.routeX = best.x;
      zb.routeZ = best.z;
      zb.routeT = 6;
    }
  }

  private step(zb: Zombie, dt: number) {
    const ctx = this.ctx;
    const def = zb.def;
    zb.stateT += dt;
    zb.attackCd -= dt;
    zb.shriekCd -= dt;
    if (zb.stun > 0) zb.stun -= dt;
    if (zb.stagger > 0) zb.stagger = Math.max(0, zb.stagger - dt * 2.4);
    if (zb.burn > 0) {
      zb.burn -= dt;
      if (Math.random() < 0.4) ctx.fx.fire(zb.x, zb.y + 1.0, zb.z, 0.4);
    }

    // ---- decisions at 20 Hz
    zb.aiT -= dt;
    if (zb.aiT <= 0) {
      zb.aiT += 0.05;
      this.think(zb);
    }

    // ---- movement
    let speed = 0;
    let wantX = 0;
    let wantZ = 0;
    const grabbed = zb.grabbing !== null;
    if (zb.stun <= 0 && !grabbed) {
      switch (zb.state) {
        case 'dormant':
          speed = 0;
          break;
        case 'wander':
          speed = def.wander * 0.7;
          break;
        case 'investigate':
          speed = lerp(def.wander, def.chase, 0.45);
          break;
        case 'chase':
          speed = def.chase;
          break;
        case 'swarm':
          speed = def.chase * 1.08;
          break;
      }
      if (zb.hesitating) speed *= 0.12;
      speed *= zb.moveMult;
      if (zb.hasTarget && speed > 0) {
        let aimX = zb.tx;
        let aimZ = zb.tz;
        if (this.buildings.length) {
          this.route(zb, dt);
          if (zb.routeT > 0) {
            aimX = zb.routeX;
            aimZ = zb.routeZ;
          }
        }
        const dx = aimX - zb.x;
        const dz = aimZ - zb.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.4) {
          wantX = dx / d;
          wantZ = dz / d;
        } else speed = 0;
      }
    }
    if (zb.sideT > 0) {
      zb.sideT -= dt;
      const sx = -wantZ * zb.sideDir;
      const sz = wantX * zb.sideDir;
      wantX = wantX * 0.3 + sx;
      wantZ = wantZ * 0.3 + sz;
    }
    // Separation from neighbours.
    let sepX = 0;
    let sepZ = 0;
    const gx = Math.floor(zb.x / 3);
    const gz = Math.floor(zb.z / 3);
    for (let ax = -1; ax <= 1; ax++) {
      for (let az = -1; az <= 1; az++) {
        const arr = this.grid.get((gx + ax + 1000) * 4096 + gz + az);
        if (!arr) continue;
        for (const o of arr) {
          if (o === zb || o.dead) continue;
          const dx = zb.x - o.x;
          const dz = zb.z - o.z;
          const d2 = dx * dx + dz * dz;
          const rr = (def.radius + o.def.radius) * 1.05;
          if (d2 < rr * rr && d2 > 1e-6) {
            const d = Math.sqrt(d2);
            sepX += (dx / d) * (rr - d);
            sepZ += (dz / d) * (rr - d);
          }
        }
      }
    }
    // Wire and slow zones.
    const slow = zb.slow;
    const sp = speed * slow;
    zb.vx = damp(zb.vx, wantX * sp, 8, dt);
    zb.vz = damp(zb.vz, wantZ * sp, 8, dt);
    // knockback decays naturally via damping above.
    const p = { x: zb.x + zb.vx * dt + sepX * 0.5, z: zb.z + zb.vz * dt + sepZ * 0.5 };
    // The dead do not swim: deep water stops them at the shore, shallows slow them.
    const wet = ctx.waterAt(p.x, p.z);
    if (wet) {
      if (wet.depth > 1.0) {
        p.x = zb.x;
        p.z = zb.z;
        zb.vx *= 0.3;
        zb.vz *= 0.3;
      } else if (wet.depth > 0.25) {
        zb.vx *= 0.9;
        zb.vz *= 0.9;
      }
    }
    const hit = ctx.obs.resolveCircle(p, def.radius, undefined, ctx.groundAt(zb.x, zb.z));
    zb.x = p.x;
    zb.z = p.z;
    zb.slow = 1;
    if (hit && hit.breakable && zb.hasTarget && speed > 0) this.onObstacleHit(hit, (def.damage * dt * (zb.kind === 'brute' ? 3 : 0.6)), zb);
    // Facing.
    const spd = Math.hypot(zb.vx, zb.vz);
    if (spd > 0.15) {
      const want = Math.atan2(zb.vx, zb.vz);
      zb.yaw += wrapAngle(want - zb.yaw) * Math.min(1, dt * 8);
    }
    // Stuck handling: slide around obstacles for a moment.
    if (zb.hasTarget && speed > 0.5) {
      const moved = Math.hypot(zb.x - zb.lastX, zb.z - zb.lastZ);
      if (moved < speed * dt * 0.25) {
        zb.stuckT += dt;
        if (zb.stuckT > 0.35) {
          zb.stuckT = 0;
          zb.sideT = 0.9;
          zb.sideDir = Math.random() < 0.5 ? 1 : -1;
        }
      } else zb.stuckT = 0;
    }
    zb.lastX = zb.x;
    zb.lastZ = zb.z;
    // Animation drivers.
    zb.stride = lerp(2.2, 11, clamp(spd / 5, 0, 1)) + (zb.state === 'dormant' ? -1.5 : 0);
    zb.chase = damp(zb.chase, zb.chasing ? 1 : 0, 4, dt);

    // ---- attack
    if (zb.chasing && zb.stun <= 0) this.attack(zb, dt);
  }

  private think(zb: Zombie) {
    const ctx = this.ctx;
    const def = zb.def;
    const aggro = ctx.campaign.difficulty.aggro;
    const heard = this.hear(zb);
    const tgt = this.pickTarget(zb);
    const sight = (zb.kind === 'stalker' ? 30 : 13) * aggro;
    // Friendly fire-support ring: stalkers hesitate within an armed, crewed vehicle's cover.
    zb.hesitating = false;
    if (zb.kind === 'stalker') {
      const ring = def.hesitateRadius ?? 40;
      for (const v of ctx.vehicles) {
        if (v.faction !== 'convoy' || v.wreck || !v.def.weapon) continue;
        if (!v.driver && !v.passenger) continue;
        if (Math.hypot(v.position.x - zb.x, v.position.z - zb.z) < ring) {
          zb.hesitating = !(tgt && tgt.d < 6);
          break;
        }
      }
    }
    // The stoned are easy to miss; the drunk are easy to find.
    const notice = tgt?.player ? tgt.player.drugs.mods().aggro : 1;
    const seesTarget = !!tgt && tgt.d < sight * notice * (tgt.vehicle ? 1.4 : tgt.player && tgt.player.crouch ? 0.5 : 1) && !ctx.obs.segmentBlocked(zb.x, zb.z, tgt.x, tgt.z, 1.1);
    switch (zb.state) {
      case 'dormant':
        if (seesTarget && tgt && tgt.d < 4.5) this.startChase(zb, tgt);
        else if (heard && heard.level * aggro >= 45) {
          zb.state = 'investigate';
          zb.tx = heard.x;
          zb.tz = heard.z;
          zb.hasTarget = true;
          zb.stateT = 0;
        }
        break;
      case 'wander':
        if (seesTarget && tgt) this.startChase(zb, tgt);
        else if (heard && zb.kind !== 'stalker') {
          zb.state = heard.level * aggro > 70 ? 'chase' : 'investigate';
          zb.tx = heard.x;
          zb.tz = heard.z;
          zb.hasTarget = true;
          zb.stateT = 0;
        } else if (!zb.hasTarget || zb.stateT > 4 + (zb.id % 5) || dist2(zb.x, zb.z, zb.tx, zb.tz) < 1) {
          const a = Math.random() * 6.28;
          const r = 3 + Math.random() * 10;
          zb.tx = zb.homeX + Math.cos(a) * r;
          zb.tz = zb.homeZ + Math.sin(a) * r;
          zb.hasTarget = true;
          zb.stateT = 0;
          // Stalkers prowl toward people on foot even when unaware.
          if (zb.kind === 'stalker' && tgt && tgt.player && tgt.d < 90) {
            zb.tx = tgt.x;
            zb.tz = tgt.z;
          }
        }
        break;
      case 'investigate':
        if (seesTarget && tgt) this.startChase(zb, tgt);
        else {
          if (heard && heard.level * aggro >= 30 && zb.kind !== 'stalker') {
            zb.tx = heard.x;
            zb.tz = heard.z;
            if (heard.level * aggro > 80) zb.state = 'chase';
          }
          if (dist2(zb.x, zb.z, zb.tx, zb.tz) < 2 && zb.stateT > 1.5) {
            zb.state = 'wander';
            zb.hasTarget = false;
            zb.homeX = zb.x;
            zb.homeZ = zb.z;
          }
          if (zb.stateT > 20) zb.state = 'wander';
        }
        break;
      case 'chase':
      case 'swarm': {
        // Keep the closest valid target; lose interest after a while.
        if (tgt && (tgt.d < 45 * aggro || (zb.targetPlayer && tgt.player === zb.targetPlayer))) {
          const visible = !ctx.obs.segmentBlocked(zb.x, zb.z, tgt.x, tgt.z, 1.1);
          if (visible || tgt.d < 25) {
            zb.tx = tgt.x;
            zb.tz = tgt.z;
            zb.hasTarget = true;
            zb.lostT = 0;
            zb.targetPlayer = tgt.player;
          } else zb.lostT += 0.05;
        } else zb.lostT += 0.05;
        if (heard && heard.level > 60 && zb.lostT > 1) {
          zb.tx = heard.x;
          zb.tz = heard.z;
          zb.lostT = 0.5;
        }
        // Raids head for the camp core until something distracts them.
        if (zb.raid && this.raidTarget && (!tgt || tgt.d > 30)) {
          zb.tx = this.raidTarget.x;
          zb.tz = this.raidTarget.z;
          zb.hasTarget = true;
          zb.lostT = 0;
        }
        if (zb.lostT > 8) {
          zb.state = 'investigate';
          zb.stateT = 0;
        }
        break;
      }
    }
  }

  private startChase(zb: Zombie, tgt: { x: number; z: number; player: Player | null }) {
    const ctx = this.ctx;
    const was = zb.chasing;
    zb.state = 'chase';
    zb.tx = tgt.x;
    zb.tz = tgt.z;
    zb.hasTarget = true;
    zb.targetPlayer = tgt.player;
    zb.lostT = 0;
    zb.stateT = 0;
    if (zb.kind === 'screamer' && !was && zb.shriekCd <= 0) {
      zb.shriekCd = 12;
      // Shriek: triples the alert radius. Everything within 60 m wakes and converges.
      ctx.sig.emit(zb.x, zb.z, 100, 'noise');
      const n = this.hordeAlert(zb.x, zb.z, (ENEMIES.zombies.screamer.shriek ?? 3) * 20, tgt.x, tgt.z);
      ctx.audio.play('scream', zb.x, zb.z, 1);
      ctx.fx.puff(zb.x, zb.y + 1.5, zb.z, 0.8, 0.8, 1, 3, 0.8);
      if (n > 2) ctx.radio(t('radio.horde'));
      for (const p of ctx.players) p.note('A Screamer spotted you!', 'warn');
    }
  }

  private attack(zb: Zombie, dt: number) {
    const ctx = this.ctx;
    const def = zb.def;
    // Targets in reach: players on foot.
    for (const p of ctx.players) {
      if (p.state !== 'foot' && p.state !== 'downed') continue;
      if (p.invuln > 0) continue;
      const d = Math.hypot(p.pos.x - zb.x, p.pos.z - zb.z);
      if (d < def.radius + 0.62) {
        if (zb.grabbing !== p) {
          this.release(zb);
          zb.grabbing = p;
        }
        let arr = this.grabbers.get(p);
        if (!arr) this.grabbers.set(p, (arr = []));
        arr.push(zb);
        zb.vx *= 0.3;
        zb.vz *= 0.3;
        return;
      }
    }
    if (zb.grabbing) this.release(zb);
    // Brutes smash vehicles.
    if (zb.kind === 'brute' && zb.attackCd <= 0) {
      for (const v of ctx.vehicles) {
        if (v.wreck) continue;
        const d = Math.hypot(v.position.x - zb.x, v.position.z - zb.z);
        if (d < v.def.length * 0.5 + def.radius + 0.8) {
          zb.attackCd = 1.4;
          v.takeHit(def.vehicleDamage ?? 28, zb.x, zb.z, { ram: true, smash: true });
          const dx = v.position.x - zb.x;
          const dz = v.position.z - zb.z;
          const l = Math.hypot(dx, dz) || 1;
          v.shove((dx / l) * v.mass * 0.7, (dz / l) * v.mass * 0.7);
          ctx.audio.play('crash', zb.x, zb.z, 0.7);
          break;
        }
      }
    }
    void dt;
  }

  // ------------------------------------------------------------------ rendering

  render(zr: ZombieRenderer, time: number, frustums: THREE.Frustum[], maxPerView: number, camPos: THREE.Vector3[]) {
    zr.begin();
    const sp = new THREE.Vector3();
    let drawn = 0;
    const budget = maxPerView * 2;
    // Nearest first so the budget cuts distant ones.
    const live = this.list.filter((z) => z.active || z.dead);
    live.sort((a, b) => minDist(a, camPos) - minDist(b, camPos));
    for (const zb of live) {
      if (drawn >= budget) break;
      sp.set(zb.x, zb.y + 0.9, zb.z);
      let seen = false;
      for (const f of frustums) {
        if (f.containsPoint(sp) || frustumNear(f, sp)) {
          seen = true;
          break;
        }
      }
      if (!seen) continue;
      drawn++;
      const sc = zb.def.scale;
      const tilt = zb.dead ? zb.fall : 0;
      const sink = zb.dead ? Math.max(0, zb.deadT - 2.2) * 0.8 : 0;
      const legs = limbsGone(zb.wounds.mask).legs;
      // Without legs a body drops to the ground and drags itself; with one it lists to the side.
      const drop = zb.dead ? 0 : legs >= 2 ? 0.78 * sc : legs === 1 ? 0.06 * sc : 0;
      zr.push(zb.kind, sc, zb.x, zb.y - sink + (zb.dead ? 0.1 : 0) - drop, zb.z, zb.yaw, zb.phase, zb.dead ? 0 : zb.stride, zb.dead ? 0 : zb.chase, tilt, zb.variant, 1, zb.wounds.mask, zb.stagger, legs >= 2 ? 0.75 : legs === 1 ? 0.12 : 0);
    }
    zr.end(time);
  }
}

function minDist(z: Zombie, cams: THREE.Vector3[]) {
  let m = Infinity;
  for (const c of cams) m = Math.min(m, (c.x - z.x) ** 2 + (c.z - z.z) ** 2);
  return m;
}

function frustumNear(f: THREE.Frustum, p: THREE.Vector3) {
  // Zombies are 2 m tall: also test their head and feet so edge-of-screen ones don't pop.
  const y = p.y;
  p.y = y + 1.0;
  const a = f.containsPoint(p);
  p.y = y - 0.9;
  const b = f.containsPoint(p);
  p.y = y;
  return a || b;
}
