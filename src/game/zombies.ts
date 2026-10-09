import * as THREE from 'three';
import { ENEMIES, t, type ZombieDef, type ZombieKind } from '../data';
import { clamp, damp, dist2, lerp, wrapAngle } from '../core/math';
import type { Aabb } from '../world/layout';
import type { Animal } from './wildlife';
import { AMMO, armDamageMult, damageFraction, legSpeedMult, limbsGone, maskOf, massOf, newWounds, staggerSpeed, throughFlesh, wound, zoneOf, type AmmoSpec, type Wounds, type Zone } from '../sim/ballistics';
import { MELEE, knockFor, type MeleeFeel, type MeleeKind } from '../sim/weaponfx';
import { armsUseless, brainGone, fleshMoveMult, legsUseless, type FleshEvents, type FleshState } from '../sim/flesh';
import type { BodyPose } from '../render/fleshRender';
import { ZOMBIE_VARIANTS, zombieMotion, zombieStepPhase } from '../sim/zombieAnimation';
import type { ZombieRenderer } from '../render/zombieRender';
import type { Ctx } from './ctx';
import type { Player } from './player';
import { playerShows } from './sight';
import { SIGHT } from '../sim/enemySight';
import type { Vehicle } from './vehicle';
import { footprints, pushOutOfVehicles, type Footprint } from './vehicleFootprint';
import { Nearest } from '../core/nearest';
import { DISSOLVE_TIME } from '../render/dissolve';
import { zombieToughness } from '../sim/tuning';

/** A body drawn again within this many seconds of its last draw has not just come into sight. */
const ZOMBIE_SEEN_GAP = 1;
/** The dead stay where they fell: this many at most, for this long, before they sink away. */
const CORPSE_KEEP = 32;
const CORPSE_LIFE = 150;

/** Which round an `AmmoSpec` is, for the flesh engine's wound tables. */
const AMMO_KEY = new Map<AmmoSpec, string>(Object.entries(AMMO).map(([k, v]) => [v, k]));

/**
 * Where a swing lands on a body: the world point, the way the blade was travelling, and the part. Swing code that sweeps the
 * blade through the world passes one per body it crosses; `depth` (0..1, how far through that part the cut has got over
 * every stroke) and `through` (this stroke finished it) let it decide the cutting itself.
 */
export interface MeleeStrike {
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  zone: Zone;
  depth?: number;
  through?: boolean;
}
/** Closer than this (metres) a body comes into sight at once: it was round a corner, not arriving at the edge of things. */
const ZOMBIE_FADE_NEAR = 40;

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
  /**
   * Full health: the kind's hit points times the toughness setting (`sim/tuning.ts`). Wounds, broken bones and lost limbs
   * still count against the kind's own hit points, so a tougher body comes apart further before it drops.
   */
  maxHp: number;
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
  /** How it goes down: which of its deaths (0..1), onto its back or its face (undefined: either), and the slope it lies on. */
  deathSeed = 0;
  fallsBack: boolean | undefined = undefined;
  lieSlope: { x: number; z: number; pitch: number; roll: number } | null = null;
  phase: number;
  stride = 4;
  /** Continuous distance-driven gait phase; phase remains the stable personality seed. */
  walkPhase = 0;
  locomotion = 0;
  screamT = 0;
  smashT = 0;
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
  /** Something living it is hunting (an animal or a raider on foot), and how long it has been feeding on the kill. */
  prey: { x: number; z: number; dead: boolean } | null = null;
  preyKind: 'animal' | 'raider' | null = null;
  preyCd = 0;
  eatT = 0;
  /** Heading for a doorway because a wall is in the way. */
  routeT = 0;
  routeX = 0;
  routeZ = 0;
  routeCool = 0;
  /** What heavy rounds have taken off, and how much each limb has taken since. */
  wounds: Wounds = newWounds();
  /** What has been done to it under the skin: wounds, breaks, cuts, the gut (`sim/flesh.ts`). Null until it is first hurt. */
  flesh: FleshState | null = null;
  /** Seconds dead at which the body starts to sink away (set once it is laid among the dead that stay). */
  rotAt = Infinity;
  /** Sunk away and gone from the world: anything hanging from it lets go. */
  gone = false;
  /** Where a settled body lies (head, middle, feet in the world), for rounds and blades to find it (`FleshFx.lie`). */
  lie: Float32Array | null = null;
  /** 0 to 1: how far it is reeling from a hit (leans back, arms thrown up). Fades on its own. */
  stagger = 0;
  /** Share of its walking speed left once legs are gone. */
  moveMult = 1;
  /** Share of its bite and claw left once arms are gone. */
  biteMult = 1;
  /** Which way and how hard the last bullet hit: a corpse is thrown that way. */
  lastHit: { dx: number; dz: number; power: number } | null = null;
  /** Standing still, looking about, for this long before it moves on; and how long before it may stop again. */
  idleT = 0;
  restCd = 0;
  /** Places it will still go and check after losing someone. */
  search = 0;
  /** Which side it likes to come in on when hunting, -1 to 1, so a crowd fans out instead of queueing. */
  flank: number;
  /** Brutes: winding up for a charge, charging, and the pause before the next one. A charge holds the heading it started on. */
  charge: 'none' | 'wind' | 'run' = 'none';
  chargeT = 0;
  chargeCd = 2 + Math.random() * 3;
  cx = 0;
  cz = 1;
  /** A burst of speed: a runner's lunge, a stalker pouncing when it is no longer watched. */
  burstT = 0;
  leapCd = 0;
  /** A stalker that is being looked straight at. */
  watched = false;
  /** The carcass it is walking to or eating, and for how much longer. */
  feed: Animal | null = null;
  feedT = 0;

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
    this.hp = this.maxHp = this.def.hp * zombieToughness();
    this.state = dormant ? 'dormant' : 'wander';
    this.yaw = Math.random() * Math.PI * 2;
    this.phase = Math.random() * 6.28;
    this.walkPhase = this.phase;
    this.variant = Math.floor(Math.random() * ZOMBIE_VARIANTS);
    this.flank = (Math.floor(Math.random() * 5) - 2) / 2;
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
  /** The dead that stay lying where they fell, out of the living list (`layOut`). */
  corpses: Zombie[] = [];
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
  private gridPool: Zombie[][] = [];
  private renderNearest = new Nearest<Zombie>();
  private renderPoint = new THREE.Vector3();
  private grabbers = new Map<Player, Zombie[]>();
  /** Every vehicle's footprint this tick: the dead walk around cars, not through them. */
  private cars: Footprint[] = [];
  private carN = { x: 0, z: 0 };
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
    // The dead lying where they fell: a round can still find them, and still tear them.
    const fl = this.ctx.gore?.anatomy;
    if (fl) {
      const lying = (zb: Zombie) => {
        if (!this.hackable(zb)) return;
        if (Math.abs(zb.x - ox) > maxD + 2 || Math.abs(zb.z - oz) > maxD + 2) return;
        const l = fl.lie(zb);
        const sc = zb.def.scale;
        for (let k = 0; k < 2; k++) {
          const a = k * 3;
          const t = raySegment(ox, oy, oz, dx, dy, dz, l[a], l[a + 1], l[a + 2], l[a + 3], l[a + 4], l[a + 5], (k === 0 ? 0.17 : 0.13) * sc);
          if (t !== null && t <= maxD && (!best || t < best.dist)) best = { zombie: zb, dist: t, head: false };
        }
      };
      for (const zb of this.list) lying(zb);
      for (const zb of this.corpses) lying(zb);
    }
    return best;
  }

  /** Apply damage; returns true if the zombie died. */
  damage(zb: Zombie, amount: number, info: { fromX: number; fromZ: number; head?: boolean; killer?: number; explosive?: boolean; fire?: boolean; dot?: boolean }): boolean {
    if (zb.dead) return false;
    zb.hp -= amount;
    // A hit makes them flinch. Burning or wire, which hurt a little every tick, would keep them flinching for good.
    if (!info.fire && !info.dot) zb.stun = Math.max(zb.stun, zb.kind === 'brute' ? 0 : 0.12);
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
    zb.idleT = 0;
    zb.feed = null;
    zb.feedT = 0;
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
    // Knocked back by a blow from the front it goes down on its back, from behind on its face; a blast or a glancing blow
    // either way.
    zb.deathSeed = ctx.rng.next();
    const push = explosive || !zb.lastHit ? 0 : zb.lastHit.dx * Math.sin(zb.yaw) + zb.lastHit.dz * Math.cos(zb.yaw);
    zb.fallsBack = push < -0.35 ? true : push > 0.35 ? false : undefined;
    zb.lieSlope = null;
    zb.lie = null;
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
    // A broken leg is a limp as much as a missing one; a broken arm grabs as badly.
    if (zb.flesh) {
      zb.moveMult = Math.min(zb.moveMult, fleshMoveMult(zb.flesh));
      zb.biteMult = Math.min(zb.biteMult, armDamageMult(armsUseless(zb.flesh)));
    }
  }

  /** What the flesh engine did to a body changes what it can do: its legs, its arms, its brain, a body cut in two. */
  private afterFlesh(zb: Zombie, ev: FleshEvents, killed: boolean, killer: number) {
    const f = zb.flesh;
    if (!f) return;
    if (ev.bisect) zb.wounds.mask |= maskOf('legL') | maskOf('legR');
    if (f.head === 'burst' || f.head === 'split' || f.head === 'sliced' || f.head === 'off') zb.wounds.mask |= maskOf('head');
    this.refreshWounds(zb);
    // A leg snapping under it drops it.
    if (!zb.dead && ev.broke.some((b) => b.startsWith('femur') || b.startsWith('shin'))) {
      zb.stun = Math.max(zb.stun, 1.1);
      zb.stagger = 1;
    }
    // Nothing walks on without its brain.
    if (brainGone(f) && !zb.dead) this.kill(zb, killer);
    // Cut in two, the top half does not always know it is dead.
    if (ev.bisect && killed && zb.dead && !brainGone(f) && zb.kind !== 'bloater' && this.ctx.rng.next() < 0.65) this.reviveHalf(zb, killer);
  }

  /** The top half of a body cut in two keeps coming, slowly, on its hands. */
  private reviveHalf(zb: Zombie, killer: number) {
    const ctx = this.ctx;
    zb.dead = false;
    zb.deadT = 0;
    zb.fall = 0;
    zb.hp = Math.max(1, zb.maxHp * 0.3);
    ctx.campaign.stats.zombiesKilled = Math.max(0, ctx.campaign.stats.zombiesKilled - 1);
    if (killer >= 0 && this.killedByPlayer[killer] > 0) this.killedByPlayer[killer]--;
    zb.stun = 1.2;
    zb.state = 'chase';
    zb.chase = Math.max(zb.chase, 0.5);
    this.refreshWounds(zb);
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
    // A body already down is found by its parts where they lie, not by height.
    const wasDead = zb.dead;
    const at = wasDead ? this.ctx.gore?.anatomy?.locate(zb, h.x, h.y, h.z, h.dx, h.dy, h.dz) ?? null : null;
    // Where on the body: height as a share of it, and which side (the model's +x is the body's left).
    const rx = Math.cos(zb.yaw);
    const rz = -Math.sin(zb.yaw);
    const lateral = (h.x - zb.x) * rx + (h.z - zb.z) * rz;
    // A body dragging itself along lies lower than it stands: its chest is near the ground.
    const relY = (h.y - zb.y + (zb.y - this.poseOf(zb).y)) / (1.8 * sc);
    let zone = at ? at.zone : zoneOf(relY, lateral, sc);
    if (h.head && !at) zone = 'head';
    zb.lastHit = { dx: h.dx, dz: h.dz, power: (h.dmg * Math.max(0.2, h.spec.gore)) / zb.def.hp };
    const killed = this.damage(zb, h.dmg, { fromX: h.fromX, fromZ: h.fromZ, head: h.head, killer: h.killer });
    this.knock(zb, h.dx, h.dz, staggerSpeed(h.spec, h.speed, massOf(sc)) * damageFraction(h.speed / h.spec.speed));
    const res = wound(zb.wounds, zone, h.dmg, h.spec.gore, zb.def.hp, killed, this.ctx.rng.next(), zb.maxHp);
    // Under the skin: the hole, the crater out the back, the bone, the gut, where a limb is cut (sim/flesh.ts).
    const fl = this.ctx.gore?.anatomy;
    if (fl) {
      const ev = fl.hit(zb, { key: AMMO_KEY.get(h.spec) ?? 'pistol', power: h.dmg / zb.def.hp, zone, x: h.x, y: h.y, z: h.z, dx: h.dx, dy: h.dy, dz: h.dz, through: throughFlesh(h.spec, h.speed) > 0, killed, off: res.off, rest: at ?? undefined });
      this.afterFlesh(zb, ev, killed, h.killer);
    }
    if (res.off.length) {
      this.refreshWounds(zb);
      if (res.off.includes('head') && !zb.dead) this.kill(zb, h.killer);
    }
    if (!wasDead && (killed || zb.dead)) {
      // It drops where the round was heading: turn it so it topples along the shot.
      zb.yaw = Math.atan2(-h.dx, -h.dz);
    }
    return { killed: zb.dead, zone, off: res.off };
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
      // Burnt and blown open on the side that faced it; close enough, torn in half.
      const fl = this.ctx.gore?.anatomy;
      if (fl) {
        const ux = (zb.x - x) / l;
        const uz = (zb.z - z) / l;
        const ev = fl.hit(zb, { key: 'blast', power: (damage * f) / zb.def.hp, zone: 'torso', x: zb.x - ux * 0.3, y: zb.y + 1.05 * zb.def.scale, z: zb.z - uz * 0.3, dx: ux, dy: 0.2, dz: uz, killed, off: [] });
        this.afterFlesh(zb, ev, killed, killer);
      }
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
        zb.idleT = 0;
        zb.feed = null;
        zb.feedT = 0;
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
   * through. Each body is shoved back (a heavy one moves less) and staggered. `cut` is how well the weapon takes limbs off (see `cutOf`). Returns how many it landed on.
   */
  meleeHit(p: Player, hx: number, hz: number, yaw: number, reach: number, dmg: number, feel: MeleeFeel = MELEE.fist, cut = 0, model?: MeleeKind, strikeOf?: (zb: Zombie) => MeleeStrike | null): number {
    const ctx = this.ctx;
    // The weapon, for its wounds: named, or known by its feel (each hand weapon has its own).
    const weapon = model ?? (Object.keys(MELEE) as MeleeKind[]).find((k) => MELEE[k] === feel) ?? 'fist';
    let hit = 0;
    for (const zb of this.list) {
      if (zb.dead) continue;
      const dx = zb.x - p.pos.x;
      const dz = zb.z - p.pos.z;
      const d = Math.hypot(dx, dz);
      let strike: MeleeStrike | null;
      if (strikeOf) {
        // The swing was swept through the world: it says which bodies the blade crossed, and where.
        strike = strikeOf(zb);
        if (!strike) continue;
      } else {
        if (d > reach + zb.def.radius) continue;
        const ang = Math.abs(wrapAngle(Math.atan2(dx, dz) - yaw));
        if (ang > 1.0) continue;
        strike = this.blowAt(p, zb, yaw, d);
      }
      const k = zb.def.armor > 0 ? 1 - zb.def.armor : 1;
      const ux = dx / (d || 1);
      const uz = dz / (d || 1);
      const dealt = dmg * k;
      zb.lastHit = { dx: ux, dz: uz, power: (dealt * Math.max(0.3, cut)) / zb.def.hp };
      const killed = this.damage(zb, dealt, { fromX: p.pos.x, fromZ: p.pos.z, killer: p.index });
      // A blade takes off what it cuts through, where it lands: by the damage rules, or by the swing's own reckoning of
      // how far through the part it has got.
      let off: Exclude<Zone, 'torso'>[] = [];
      if (strike.through !== undefined) {
        if (strike.through && strike.zone !== 'torso') {
          const m = maskOf(strike.zone);
          if ((zb.wounds.mask & m) !== m) {
            zb.wounds.mask |= m;
            off = [strike.zone];
          }
        }
      } else if (cut > 0) off = wound(zb.wounds, strike.zone, dealt, cut, zb.def.hp, killed, ctx.rng.next(), zb.maxHp).off;
      const fl = ctx.gore?.anatomy;
      if (fl) {
        const ev = fl.hit(zb, { key: weapon, power: dealt / zb.def.hp, zone: strike.zone, x: strike.x, y: strike.y, z: strike.z, dx: strike.dx, dy: strike.dy, dz: strike.dz, killed, off, cutDepth: strike.depth, cutThrough: strike.through });
        this.afterFlesh(zb, ev, killed, p.index);
      }
      if (off.length) {
        this.refreshWounds(zb);
        const power = (dealt * Math.max(0.5, cut)) / zb.def.hp;
        for (const part of off) ctx.gore.sever(zb, part, ux, 0.3, uz, power);
        if (off.includes('head') && !zb.dead) this.kill(zb, p.index);
      }
      const push = knockFor(feel, massOf(zb.def.scale));
      zb.vx += ux * push;
      zb.vz += uz * push;
      zb.stun = Math.max(zb.stun, feel.stun);
      hit++;
      if (hit >= feel.cleave) break;
    }
    // Looking down at one of the dead in reach: the blow lands on what lies there.
    if (!strikeOf && hit < feel.cleave && p.aimPitch < -0.3) hit += this.hackCorpse(p, yaw, reach, dmg, cut, weapon);
    if (hit) {
      this.ctx.fx.blood(hx, p.pos.y + 1.1, hz, 4);
      this.ctx.audio.play('thud', hx, hz, 0.7);
    }
    return hit;
  }

  /** A blow brought down on a body lying on the ground: it opens, breaks and cuts it like any other. */
  private hackCorpse(p: Player, yaw: number, reach: number, dmg: number, cut: number, weapon: MeleeKind): number {
    const ctx = this.ctx;
    const fl = ctx.gore?.anatomy;
    if (!fl) return 0;
    // Where the look meets the ground, in reach.
    const down = Math.tan(-clamp(p.aimPitch, -1.4, -0.05));
    const r = clamp(1.45 / down, 0.5, reach);
    const gx = p.pos.x + Math.sin(yaw) * r;
    const gz = p.pos.z + Math.cos(yaw) * r;
    let best: Zombie | null = null;
    let bd = 0.45;
    let bx = 0;
    let by = 0;
    let bz = 0;
    const consider = (zb: Zombie) => {
      if (!this.hackable(zb)) return;
      if (Math.abs(zb.x - gx) > 2.5 || Math.abs(zb.z - gz) > 2.5) return;
      const l = fl.lie(zb);
      for (let k = 0; k < 2; k++) {
        const a = k * 3;
        const ux = l[a + 3] - l[a];
        const uz = l[a + 5] - l[a + 2];
        const t = clamp(((gx - l[a]) * ux + (gz - l[a + 2]) * uz) / Math.max(1e-6, ux * ux + uz * uz), 0, 1);
        const px = l[a] + ux * t;
        const pz = l[a + 2] + uz * t;
        const d = Math.hypot(px - gx, pz - gz);
        if (d < bd) {
          bd = d;
          best = zb;
          bx = px;
          by = l[a + 1] + (l[a + 4] - l[a + 1]) * t + 0.05;
          bz = pz;
        }
      }
    };
    for (const zb of this.list) consider(zb);
    for (const zb of this.corpses) consider(zb);
    const zb = best as Zombie | null;
    if (!zb) return 0;
    const dx = Math.sin(yaw) * 0.5;
    const dz = Math.cos(yaw) * 0.5;
    this.hackAt(p, zb, { x: bx, y: by, z: bz, dx, dy: -0.85, dz, zone: 'torso' }, dmg, cut, weapon);
    return 1;
  }

  /** One of the dead that a blade or a club can still get at: settled, and not yet sinking away. */
  hackable(zb: Zombie): boolean {
    // Its death plays out over up to 2.3 seconds (`zombieRender.ts` DEATH_PACE); where it lies is only known after.
    return zb.dead && !zb.gone && zb.deadT >= 2.3 && zb.rotAt > zb.deadT;
  }

  /**
   * Every body lying where it fell that can still be cut, with where it lies: `segs` is head, middle (hips) and feet as
   * world points (9 numbers, `FleshFx.lie`), two segments for a swing to be swept against.
   */
  *lyingBodies(): Generator<{ zb: Zombie; segs: Float32Array }> {
    const fl = this.ctx.gore?.anatomy;
    if (!fl) return;
    for (const zb of this.list) if (this.hackable(zb)) yield { zb, segs: fl.lie(zb) };
    for (const zb of this.corpses) if (this.hackable(zb)) yield { zb, segs: fl.lie(zb) };
  }

  /**
   * A blow on a body lying on the ground at a point of it (`s.x, y, z`), the blade going `s.dx, dy, dz`. The part is found
   * where it really lies (`FleshFx.locate`; `s.zone` is not used). A swept swing's `through` takes the part off there
   * (`false` only opens it, `depth` deep); without it the damage rules decide, as for the living.
   */
  hackAt(p: Player, zb: Zombie, s: MeleeStrike, dmg: number, cut: number, weapon: MeleeKind) {
    const ctx = this.ctx;
    const fl = ctx.gore?.anatomy;
    if (!fl || !zb.dead || zb.gone) return;
    void p;
    const at = fl.locate(zb, s.x, s.y, s.z, s.dx, s.dy, s.dz);
    let off: Exclude<Zone, 'torso'>[] = [];
    if (s.through !== undefined) {
      if (s.through && at.zone !== 'torso') {
        const m = maskOf(at.zone);
        if ((zb.wounds.mask & m) !== m) {
          zb.wounds.mask |= m;
          off = [at.zone];
        }
      }
    } else if (cut > 0) off = wound(zb.wounds, at.zone, dmg, cut, zb.def.hp, false, ctx.rng.next(), zb.maxHp).off;
    fl.hit(zb, { key: weapon, power: dmg / zb.def.hp, zone: at.zone, x: s.x, y: s.y, z: s.z, dx: s.dx, dy: s.dy, dz: s.dz, killed: false, off, rest: at, cutDepth: s.depth, cutThrough: s.through });
    if (zb.flesh?.cut[5]) zb.wounds.mask |= maskOf('legL') | maskOf('legR');
    const l = Math.hypot(s.dx, s.dz) || 1;
    for (const part of off) ctx.gore.sever(zb, part, s.dx / l, 0.3, s.dz / l, (dmg * Math.max(0.5, cut)) / zb.def.hp);
  }

  /**
   * Where a swing lands on a body that nothing swept for: as high on it as the swinger is looking, coming down and across
   * from the swinging arm's side.
   */
  private blowAt(p: Player, zb: Zombie, yaw: number, d: number): MeleeStrike {
    const sc = zb.def.scale;
    const lift = zb.dead ? 0 : zb.y - this.poseOf(zb).y;
    const reach = Math.max(0.3, d - zb.def.radius * 0.5);
    const look = p.pos.y + 1.6 + Math.tan(clamp(p.aimPitch, -1.2, 1.2)) * reach;
    const y = clamp(look + (this.ctx.rng.next() - 0.5) * 0.12, zb.y + 0.12 * sc - lift, zb.y + 1.78 * sc - lift);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const x = p.pos.x + fx * reach;
    const z = p.pos.z + fz * reach;
    const lateral = (x - zb.x) * Math.cos(zb.yaw) - (z - zb.z) * Math.sin(zb.yaw);
    const zone = zoneOf((y - zb.y + lift) / (1.8 * sc), lateral, sc);
    // From the right shoulder down and across to the left.
    return { x, y, z, dx: fx * 0.5 + Math.cos(yaw) * 0.6, dy: -0.5, dz: fz * 0.5 - Math.sin(yaw) * 0.6, zone };
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
      // The bumper takes it at the knees, a fast one in the body: bones break, and hard enough it comes apart.
      const fl = this.ctx.gore?.anatomy;
      if (fl) {
        const high = sp > 13 && this.ctx.rng.next() < 0.5;
        const zone: Zone = high ? 'torso' : this.ctx.rng.next() < 0.5 ? 'legL' : 'legR';
        const ev = fl.hit(zb, { key: 'vehicle', power: (dmg * res) / zb.def.hp, zone, x: zb.x - fx * 0.25, y: zb.y + (high ? 1.05 : 0.5) * zb.def.scale, z: zb.z - fz * 0.25, dx: fx, dy: 0, dz: fz, killed, off: [] });
        this.afterFlesh(zb, ev, killed, v.driver?.isPlayer ? v.driver.index : -1);
      }
      // Hit hard enough, a body comes apart on the bumper.
      if (killed && dmg * res >= zb.def.hp * 1.1) this.tear(zb, fx, fz, (dmg * res) / zb.def.hp);
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
    // The kept dead lie still, and the oldest sink away.
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.deadT += dt;
      if (c.deadT > c.rotAt + 1.6) {
        c.gone = true;
        this.corpses.splice(i, 1);
      }
    }
    // Remove corpses and build the spatial grid for separation.
    for (const bucket of this.grid.values()) { bucket.length = 0; this.gridPool.push(bucket); }
    this.grid.clear();
    let chasers = 0;
    let anyPlayerActive = false;
    for (const p of ctx.players) if (p.alive) anyPlayerActive = true;
    if (!anyPlayerActive) return;
    footprints(ctx.vehicles, this.cars);
    const act = 150;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const zb = this.list[i];
      if (zb.dead) {
        zb.deadT += dt;
        zb.fall = Math.min(1, zb.deadT / 0.55);
        // A body thrown by the round that killed it slides on and settles.
        if (Math.abs(zb.vx) + Math.abs(zb.vz) > 0.05) {
          const p = { x: zb.x + zb.vx * dt, z: zb.z + zb.vz * dt };
          pushOutOfVehicles(this.cars, p, 0.3, zb.y);
          ctx.obs.resolveCircle(p, 0.3, undefined, zb.y);
          zb.x = p.x;
          zb.z = p.z;
          const k = Math.exp(-5 * dt);
          zb.vx *= k;
          zb.vz *= k;
          zb.y = ctx.groundAt(zb.x, zb.z) + (ctx.ground?.heightAt(zb.x, zb.z) ?? 0);
        }
        zb.stagger = Math.max(0, zb.stagger - dt * 3);
        if (zb.deadT > 3.2) {
          this.list[i] = this.list[this.list.length - 1];
          this.list.pop();
          this.layOut(zb);
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
      zb.y = ctx.groundAt(zb.x, zb.z) + (ctx.ground?.heightAt(zb.x, zb.z) ?? 0);
      const k = (Math.floor(zb.x / 3) + 1000) * 4096 + Math.floor(zb.z / 3);
      let c = this.grid.get(k);
      if (!c) this.grid.set(k, (c = this.gridPool.pop() ?? []));
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
    zb.screamT = Math.max(0, zb.screamT - dt);
    zb.smashT = Math.max(0, zb.smashT - dt);
    zb.shriekCd -= dt;
    zb.restCd -= dt;
    zb.chargeCd -= dt;
    zb.leapCd -= dt;
    if (zb.burstT > 0) zb.burstT -= dt;
    if (zb.idleT > 0) zb.idleT -= dt;
    if (zb.stun > 0) zb.stun -= dt;
    if (zb.stagger > 0) zb.stagger = Math.max(0, zb.stagger - dt * 2.4);
    if (zb.burn > 0) {
      zb.burn -= dt;
      // Alight from the legs up; it lights the ground it staggers over, and the dry grass under it.
      if (ctx.fires) ctx.fires.hold(zb, { x: zb.x, y: zb.y + 0.4, z: zb.z, r: 0.3 * def.scale, fuel: 'flesh', heat: Math.min(1, zb.burn / 0.8), bed: false, light: 0.7, spreads: true });
      else if (Math.random() < 0.4) ctx.fx.fire(zb.x, zb.y + 1.0, zb.z, 0.4);
    }
    // Shot or shoved out of a charge, a brute loses it.
    if (zb.charge === 'run' && zb.stun > 0.3) {
      zb.charge = 'none';
      zb.chargeCd = 4;
    }

    // ---- decisions at 20 Hz
    zb.aiT -= dt;
    if (zb.aiT <= 0) {
      zb.aiT += 0.05;
      this.think(zb);
    }

    // ---- eating: it stands over the body with its head down, and what it eats is gone for the hunter
    let eating = false;
    if (zb.feedT > 0 && zb.feed && !zb.feed.butchered && !zb.chasing) {
      zb.feedT -= dt;
      eating = true;
      ctx.wildlife?.gnaw(zb.feed, dt * 0.8);
      zb.yaw += wrapAngle(Math.atan2(zb.feed.x - zb.x, zb.feed.z - zb.z) - zb.yaw) * Math.min(1, dt * 3);
      if (zb.feedT <= 0) zb.feed = null;
    } else if (zb.feedT > 0) zb.feedT = 0;

    // ---- movement
    let speed = 0;
    let wantX = 0;
    let wantZ = 0;
    const grabbed = zb.grabbing !== null;
    if (zb.stun <= 0 && !grabbed) {
      switch (zb.state) {
        case 'dormant':
          // Not asleep, just unaware: they shuffle about their patch rather than stand like statues.
          speed = def.wander * 0.55;
          break;
        case 'wander':
          speed = def.wander * 1.1;
          if (zb.prey && !zb.prey.dead) speed = def.chase * 0.65;
          else if (zb.eatT > 0) speed = 0;
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
      // Standing about, looking round or eating: not walking. The hunt does not wait.
      if ((zb.idleT > 0 && !zb.chasing) || eating) speed = 0;
      // The dead do not walk evenly: a walker lurches and drags, a runner surges.
      speed *= this.gait(zb);
      // A stalker that is looked at creeps; the moment it is not, it pounces.
      if (zb.watched) speed *= 0.1;
      if (zb.burstT > 0) speed *= zb.kind === 'stalker' ? 1.5 : 1.8;
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
        let dx = aimX - zb.x;
        let dz = aimZ - zb.z;
        let d = Math.hypot(dx, dz);
        // Hunters spread across the target's front instead of queueing up on one line.
        if (zb.chasing && !zb.raid && zb.routeT <= 0 && zb.flank !== 0 && d > 6 && zb.kind !== 'brute' && zb.kind !== 'bloater') {
          const off = zb.flank * Math.min(4.5, d * 0.25);
          aimX += (-dz / d) * off;
          aimZ += (dx / d) * off;
          dx = aimX - zb.x;
          dz = aimZ - zb.z;
          d = Math.hypot(dx, dz);
        }
        if (d > 0.4) {
          wantX = dx / d;
          wantZ = dz / d;
        } else speed = 0;
        // A screamer keeps its distance: it is there to call the rest, not to fight.
        if (zb.kind === 'screamer' && zb.chasing && zb.routeT <= 0) {
          const dt2 = Math.hypot(zb.tx - zb.x, zb.tz - zb.z);
          if (dt2 < 8) {
            wantX = -wantX;
            wantZ = -wantZ;
            speed *= 0.85;
          } else if (dt2 < 12) speed = 0;
        }
        // A runner closing on someone throws itself the last few metres.
        if (zb.kind === 'runner' && zb.chasing && zb.leapCd <= 0 && zb.burstT <= 0 && !zb.hesitating) {
          const dt2 = Math.hypot(zb.tx - zb.x, zb.tz - zb.z);
          if (dt2 > 2.2 && dt2 < 4.4) {
            zb.burstT = 0.3;
            zb.leapCd = 3.5;
            zb.vx += wantX * 4;
            zb.vz += wantZ * 4;
          }
        }
      }
      // A brute winds up (it stops and roars, head down), then runs flat out along a line it has locked.
      if (zb.charge !== 'none') {
        zb.chargeT -= dt;
        if (zb.charge === 'wind') {
          speed = 0;
          wantX = wantZ = 0;
          zb.yaw += wrapAngle(Math.atan2(zb.tx - zb.x, zb.tz - zb.z) - zb.yaw) * Math.min(1, dt * 6);
          if (zb.chargeT <= 0) {
            zb.charge = 'run';
            zb.chargeT = 1.5;
            const l = Math.hypot(zb.tx - zb.x, zb.tz - zb.z) || 1;
            zb.cx = (zb.tx - zb.x) / l;
            zb.cz = (zb.tz - zb.z) / l;
          }
        } else {
          const l = Math.hypot(zb.tx - zb.x, zb.tz - zb.z) || 1;
          zb.cx += ((zb.tx - zb.x) / l - zb.cx) * dt * 0.8;
          zb.cz += ((zb.tz - zb.z) / l - zb.cz) * dt * 0.8;
          const n = Math.hypot(zb.cx, zb.cz) || 1;
          wantX = zb.cx / n;
          wantZ = zb.cz / n;
          speed = def.chase * 2.1;
          if (zb.chargeT <= 0) {
            zb.charge = 'none';
            zb.chargeCd = 6 + Math.random() * 3;
          }
        }
      }
    }
    if (zb.sideT > 0) {
      zb.sideT -= dt;
      const sx = -wantZ * zb.sideDir;
      const sz = wantX * zb.sideDir;
      wantX = wantX * 0.3 + sx;
      wantZ = wantZ * 0.3 + sz;
    }
    // Looking about: standing, it turns its head and shoulders slowly one way and the other.
    if (zb.idleT > 0 && !zb.chasing && !eating) zb.yaw += Math.sin(this.time * 1.1 + zb.phase * 4) * dt * 1.1;
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
    zb.vx = damp(zb.vx, wantX * sp, zb.charge === 'run' ? 3 : 8, dt);
    zb.vz = damp(zb.vz, wantZ * sp, zb.charge === 'run' ? 3 : 8, dt);
    // knockback decays naturally via damping above.
    const p = { x: zb.x + zb.vx * dt + sepX * 0.5, z: zb.z + zb.vz * dt + sepZ * 0.5 };
    // The dead do not swim: deep water stops them at the shore, shallows slow them.
    const wet = ctx.waterAt(p.x, p.z);
    if (wet) {
      // A flood that rose round one can still be walked out of: only a step into deeper water is refused.
      if (wet.depth > 1.0 && wet.depth >= (ctx.waterAt(zb.x, zb.z)?.depth ?? 0) - 0.02) {
        p.x = zb.x;
        p.z = zb.z;
        zb.vx *= 0.3;
        zb.vz *= 0.3;
      } else if (wet.depth > 0.25) {
        zb.vx *= 0.9;
        zb.vz *= 0.9;
      }
    }
    // Cars are solid: the dead crowd against the doors instead of walking into the seats. Walls get the last word.
    const n = this.carN;
    const car = pushOutOfVehicles(this.cars, p, def.radius, zb.y, n);
    const hit = ctx.obs.resolveCircle(p, def.radius, undefined, ctx.groundAt(zb.x, zb.z));
    zb.x = p.x;
    zb.z = p.z;
    zb.slow = 1;
    if (hit && hit.breakable && zb.hasTarget && speed > 0) this.onObstacleHit(hit, def.damage * dt * (zb.kind === 'brute' ? 3 : 0.6), zb);
    // A charge that meets a wall ends in a dazed brute (and, if the wall is a barricade, a broken one). A car takes the blow.
    if ((hit || car) && zb.charge === 'run' && Math.hypot(zb.vx, zb.vz) > 3) {
      if (car && !car.v.wreck) {
        car.v.takeHit((def.vehicleDamage ?? 28) * 1.5, zb.x, zb.z, { ram: true, smash: true });
        car.v.shove(-n.x * car.v.mass * 1.2, -n.z * car.v.mass * 1.2);
      }
      zb.charge = 'none';
      zb.chargeCd = 7;
      zb.stun = 1.1;
      zb.vx = zb.vz = 0;
      if (hit?.breakable) this.onObstacleHit(hit, def.damage * 2.5, zb);
      ctx.audio.play('crash', zb.x, zb.z, 0.8);
    }
    // Whatever was carrying it into the car is spent on the panel.
    if (car) {
      const vn = zb.vx * n.x + zb.vz * n.z;
      if (vn < 0) {
        zb.vx -= vn * n.x;
        zb.vz -= vn * n.z;
      }
    }
    // Facing.
    const spd = Math.hypot(zb.vx, zb.vz);
    if (spd > 0.15 && zb.charge !== 'wind') {
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
    // Measure resolved travel, so feet stop cycling against walls and while holding a victim.
    const travel = Math.hypot(zb.x - zb.lastX, zb.z - zb.lastZ);
    const walking = zb.stun <= 0 && !grabbed && !eating && zb.charge !== 'wind' && speed > 0;
    if (walking) zb.walkPhase = (zb.walkPhase + zombieStepPhase(zb.kind, zb.variant, travel, zb.def.scale)) % (Math.PI * 2);
    zb.locomotion = damp(zb.locomotion, walking ? clamp(travel / Math.max(dt, 0.001) / 0.8, 0, 1) : 0, 10, dt);
    zb.lastX = zb.x;
    zb.lastZ = zb.z;
    // Animation drivers.
    zb.stride = spd < 0.2 ? 0.6 : lerp(3, 11, clamp(spd / 4, 0, 1));
    zb.chase = damp(zb.chase, zb.chasing ? 1 : 0, 4, dt);

    if (zb.state === 'wander') this.feed(zb, dt);

    // ---- attack
    if (zb.chasing && zb.stun <= 0) this.attack(zb, dt);
  }

  /** How evenly it walks. Averages out to 1, so none of this changes how long a crowd takes to arrive. */
  private gait(zb: Zombie): number {
    const t = this.time;
    switch (zb.kind) {
      case 'walker':
      case 'bloater':
        return 1 + 0.38 * Math.sin(t * 2.3 + zb.phase * 2);
      case 'runner':
        return 1 + 0.2 * Math.sin(t * 4.1 + zb.phase);
      default:
        return 1;
    }
  }

  private think(zb: Zombie) {
    const ctx = this.ctx;
    const def = zb.def;
    const aggro = ctx.campaign.difficulty.aggro;
    const heard = this.hear(zb);
    const tgt = this.pickTarget(zb);
    // Head down over a meal it notices less.
    const sight = (zb.kind === 'stalker' ? 40 : 28) * aggro * (zb.feedT > 0 ? 0.6 : 1);
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
    // Someone on foot has to show: behind a rock or down in a bush they are not seen (heard, and smelt close in, still).
    const inRange = !!tgt && tgt.d < sight * notice * (tgt.vehicle ? 1.4 : tgt.player && tgt.player.crouch ? 0.5 : 1);
    const seesTarget = inRange && (tgt!.player && !tgt!.player.inVehicle
      ? tgt!.d < SIGHT.touch || playerShows(ctx, zb.x, zb.y + 1.5, zb.z, tgt!.player).show >= SIGHT.minShow
      : !ctx.obs.segmentBlocked(zb.x, zb.z, tgt!.x, tgt!.z, 1.1));
    // A stalker that someone is looking straight at holds back, and the instant they look away it is on them.
    if (zb.kind === 'stalker') {
      const was = zb.watched;
      zb.watched = false;
      if (zb.chasing && tgt?.player && tgt.d > 6.5 && tgt.d < 40) {
        const tx = (zb.x - tgt.x) / tgt.d;
        const tz = (zb.z - tgt.z) / tgt.d;
        zb.watched = Math.sin(tgt.player.aimYaw) * tx + Math.cos(tgt.player.aimYaw) * tz > 0.86 && !ctx.obs.segmentBlocked(zb.x, zb.z, tgt.x, tgt.z, 1.1);
      }
      if (was && !zb.watched && zb.burstT <= 0 && tgt && tgt.d < 28) zb.burstT = 0.8;
    }
    switch (zb.state) {
      case 'dormant':
        if (zb.idleT <= 0 && (!zb.hasTarget || zb.stateT > 6 + (zb.id % 5) || dist2(zb.x, zb.z, zb.tx, zb.tz) < 0.6)) {
          if (Math.random() < 0.4) {
            zb.idleT = 1 + Math.random() * 3;
            zb.hasTarget = false;
          } else {
            const a = Math.random() * 6.28;
            const r = 1.5 + Math.random() * 4.5;
            zb.tx = zb.homeX + Math.cos(a) * r;
            zb.tz = zb.homeZ + Math.sin(a) * r;
            zb.hasTarget = true;
          }
          zb.stateT = 0;
        }
        if (seesTarget && tgt && tgt.d < 12) this.startChase(zb, tgt);
        else if (heard && heard.level * aggro >= 45) {
          zb.state = 'investigate';
          zb.tx = heard.x;
          zb.tz = heard.z;
          zb.hasTarget = true;
          zb.stateT = 0;
          zb.search = 1;
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
          zb.search = 1;
          zb.feed = null;
          zb.feedT = 0;
        } else if (this.findPrey(zb, 0.05)) {
          // Hunting something living.
        } else if (zb.eatT > 0) {
          // Feeding on something it killed.
        } else if (zb.feed) {
          // Walking to a body, or eating one.
          const c = zb.feed;
          if (!c.dead || c.butchered || zb.stateT > 25) {
            zb.feed = null;
            zb.feedT = 0;
            zb.hasTarget = false;
          } else if (zb.feedT <= 0 && dist2(zb.x, zb.z, c.x, c.z) < 2.25) {
            zb.feedT = 6 + Math.random() * 8;
            zb.stateT = 0;
          }
        } else if (zb.idleT <= 0 && (!zb.hasTarget || zb.stateT > 4 + (zb.id % 5) || dist2(zb.x, zb.z, zb.tx, zb.tz) < 1)) {
          // Between places it often just stands for a while, swaying and looking about.
          if (zb.restCd <= 0 && zb.kind !== 'stalker' && Math.random() < 0.5) {
            zb.idleT = 1.5 + Math.random() * 3.5;
            zb.restCd = 6;
            zb.stateT = 0;
            zb.hasTarget = false;
            break;
          }
          // A body lying near draws the plodding kinds in to eat.
          const c = zb.kind === 'stalker' || zb.kind === 'screamer' ? null : ctx.wildlife?.carcassNear(zb.x, zb.z, 30);
          if (c && Math.random() < 0.5) {
            const a = Math.random() * 6.28;
            zb.feed = c;
            zb.tx = c.x + Math.cos(a) * 0.9;
            zb.tz = c.z + Math.sin(a) * 0.9;
            zb.hasTarget = true;
            zb.stateT = 0;
            break;
          }
          const a = Math.random() * 6.28;
          const r = 8 + Math.random() * 22;
          zb.tx = zb.homeX + Math.cos(a) * r;
          zb.tz = zb.homeZ + Math.sin(a) * r;
          // The home drifts with them, so a group slowly roams the streets instead of milling in one spot.
          if (Math.random() < 0.5) {
            zb.homeX = zb.x;
            zb.homeZ = zb.z;
          }
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
          if (zb.idleT <= 0 && dist2(zb.x, zb.z, zb.tx, zb.tz) < 2 && zb.stateT > 1.5) {
            if (zb.search > 0) {
              // Nothing here: stand and look, then check a little further on.
              zb.search--;
              zb.idleT = 1.2 + Math.random() * 1.8;
              const a = Math.random() * 6.28;
              const r = 5 + Math.random() * 5;
              zb.tx = zb.x + Math.cos(a) * r;
              zb.tz = zb.z + Math.sin(a) * r;
              zb.stateT = 0;
            } else {
              zb.state = 'wander';
              zb.hasTarget = false;
              zb.homeX = zb.x;
              zb.homeZ = zb.z;
            }
          }
          if (zb.stateT > 20) zb.state = 'wander';
        }
        break;
      case 'chase':
      case 'swarm': {
        // Keep the closest valid target; lose interest after a while.
        let visible = false;
        if (tgt && (tgt.d < 45 * aggro || (zb.targetPlayer && tgt.player === zb.targetPlayer))) {
          visible = !ctx.obs.segmentBlocked(zb.x, zb.z, tgt.x, tgt.z, 1.1);
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
        // A screamer keeps calling as long as it can see someone.
        if (zb.kind === 'screamer' && visible && tgt && zb.shriekCd <= 0) this.shriek(zb, tgt.x, tgt.z, false);
        // A brute that has someone in the open stops, roars and runs them down.
        if (zb.kind === 'brute' && visible && tgt && zb.charge === 'none' && zb.chargeCd <= 0 && zb.stun <= 0 && tgt.d > 5 && tgt.d < 16 && !zb.grabbing) {
          zb.charge = 'wind';
          zb.chargeT = 0.75;
          ctx.audio.play('growl', zb.x, zb.z, 1);
          ctx.fx.puff(zb.x, zb.y + 1.2, zb.z, 0.6, 0.55, 0.5, 1.4, 0.5);
        }
        if (zb.lostT > 8) {
          // Lost them. Go to where they were last seen and look around there.
          zb.state = 'investigate';
          zb.stateT = 0;
          zb.search = 2;
          zb.charge = 'none';
          zb.watched = false;
        }
        break;
      }
    }
  }

  /** Idle dead go after animals and raiders on foot nearby. Returns true while it has live prey. */
  private findPrey(zb: Zombie, dt: number): boolean {
    const ctx = this.ctx;
    if (zb.prey?.dead) {
      this.preyMeal(zb);
      return false;
    }
    if (zb.feed || zb.eatT > 0) return false;
    if (zb.prey && !zb.prey.dead) {
      zb.tx = zb.prey.x;
      zb.tz = zb.prey.z;
      zb.hasTarget = true;
      if (Math.hypot(zb.prey.x - zb.x, zb.prey.z - zb.z) > 40 || (zb.preyKind === 'animal' && (zb.prey as Animal).flying)) {
        zb.prey = null;
        zb.preyKind = null;
        zb.hasTarget = false;
      }
      else return true;
    }
    zb.preyCd -= dt;
    if (zb.preyCd > 0 || zb.eatT > 0) return false;
    zb.preyCd = 1 + Math.random();
    let best: { x: number; z: number; dead: boolean } | null = null;
    let kind: 'animal' | 'raider' = 'animal';
    let bd = 22 * 22;
    // A passing opportunity, rather than every grazer becoming a permanent target.
    const animals = ctx.wildlife?.list ?? [];
    if (ctx.rng.chance(0.18)) for (const a of animals) {
      if (a.dead || a.flying) continue;
      const d = (a.x - zb.x) ** 2 + (a.z - zb.z) ** 2;
      if (d >= bd) continue;
      const injured = a.hp < a.def.hp * 0.65 || a.moveMult < 0.8;
      const together = !injured && animals.some((other) => other !== a && !other.dead && other.herd === a.herd && dist2(a.x, a.z, other.x, other.z) < 14);
      if (together || ctx.obs.segmentBlocked(zb.x, zb.z, a.x, a.z, Math.max(0.3, a.height * 0.6))) continue;
      bd = d;
      best = a;
      kind = 'animal';
    }
    for (const u of ctx.raiders?.units ?? []) {
      if (u.dead) continue;
      const d = (u.x - zb.x) ** 2 + (u.z - zb.z) ** 2;
      if (d < bd) { bd = d; best = u; kind = 'raider'; }
    }
    if (!best) return false;
    zb.prey = best;
    zb.preyKind = kind;
    zb.idleT = 0;
    zb.tx = best.x;
    zb.tz = best.z;
    zb.hasTarget = true;
    return true;
  }

  /** Bite whatever it has reached; once it drops, stay and feed for a while. */
  private feed(zb: Zombie, dt: number) {
    const ctx = this.ctx;
    const pr = zb.prey;
    if (pr && !pr.dead) {
      if (Math.hypot(pr.x - zb.x, pr.z - zb.z) < zb.def.radius + 0.8) {
        const dmg = zb.def.damage * zb.biteMult * dt;
        if (zb.preyKind === 'animal') ctx.wildlife.damage(pr as never, dmg, { fromX: zb.x, fromZ: zb.z });
        else ctx.raiders.damageInfantry(pr as never, dmg, -1);
        zb.vx *= 0.3;
        zb.vz *= 0.3;
        if (pr.dead) this.preyMeal(zb);
      }
    } else if (pr) {
      this.preyMeal(zb);
    }
    if (zb.eatT > 0) {
      zb.eatT -= dt;
      if (zb.eatT <= 0) zb.hasTarget = false;
    }
  }

  /** Keep the actual kill as the meal, so feeding consumes it and uses the feeding pose. */
  private preyMeal(zb: Zombie) {
    const pr = zb.prey;
    if (!pr) return;
    const duration = 6 + this.ctx.rng.range(0, 6);
    if (zb.preyKind === 'animal' && !(pr as Animal).butchered) {
      zb.feed = pr as Animal;
      zb.feedT = dist2(zb.x, zb.z, pr.x, pr.z) < 1.5 ? duration : 0;
      zb.eatT = 0;
      zb.tx = pr.x;
      zb.tz = pr.z;
      zb.stateT = 0;
    } else if (zb.preyKind === 'raider') zb.eatT = duration;
    else zb.hasTarget = false;
    zb.prey = null;
    zb.preyKind = null;
    zb.vx = zb.vz = 0;
    zb.idleT = 0;
  }

  private startChase(zb: Zombie, tgt: { x: number; z: number; player: Player | null }) {
    const was = zb.chasing;
    zb.state = 'chase';
    zb.tx = tgt.x;
    zb.tz = tgt.z;
    zb.hasTarget = true;
    zb.targetPlayer = tgt.player;
    zb.prey = null;
    zb.preyKind = null;
    zb.eatT = 0;
    zb.lostT = 0;
    zb.stateT = 0;
    zb.idleT = 0;
    zb.feed = null;
    zb.feedT = 0;
    if (zb.kind === 'screamer' && !was && zb.shriekCd <= 0) this.shriek(zb, tgt.x, tgt.z, true);
    // The ones around it have seen it turn: they look, and then they come.
    if (!was) this.rally(zb, tgt.x, tgt.z);
  }

  /** Shriek: triples the alert radius. Everything within 60 m wakes and converges. */
  private shriek(zb: Zombie, x: number, z: number, first: boolean) {
    const ctx = this.ctx;
    zb.shriekCd = first ? 12 : 9;
    zb.screamT = 1.3;
    ctx.sig.emit(zb.x, zb.z, 100, 'noise');
    const n = this.hordeAlert(zb.x, zb.z, (ENEMIES.zombies.screamer.shriek ?? 3) * 20, x, z);
    ctx.audio.play('scream', zb.x, zb.z, 1);
    ctx.fx.puff(zb.x, zb.y + 1.5, zb.z, 0.8, 0.8, 1, 3, 0.8);
    if (n > 2) ctx.radio(t('radio.horde'));
    if (first) for (const p of ctx.players) p.note('A Screamer spotted you!', 'warn');
  }

  /** One of them has found someone: those within a few strides turn toward it, each after a moment of its own, and follow. */
  private rally(zb: Zombie, x: number, z: number) {
    for (const o of this.list) {
      if (o === zb || o.dead || !o.active || o.chasing) continue;
      const d2 = (o.x - zb.x) ** 2 + (o.z - zb.z) ** 2;
      if (d2 > 81 || (o.state === 'dormant' && d2 > 25)) continue;
      o.state = 'investigate';
      o.tx = x;
      o.tz = z;
      o.hasTarget = true;
      o.stateT = 0;
      o.idleT = 0.15 + Math.random() * 0.7;
      o.search = 1;
      o.feed = null;
      o.feedT = 0;
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
        zb.yaw += wrapAngle(Math.atan2(p.pos.x - zb.x, p.pos.z - zb.z) - zb.yaw) * Math.min(1, dt * 8);
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
          zb.smashT = 0.65;
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

  /** A body done falling is laid among the dead that stay. Past `CORPSE_KEEP` of them, the oldest starts to sink. */
  private layOut(zb: Zombie) {
    zb.rotAt = zb.deadT + CORPSE_LIFE;
    this.corpses.push(zb);
    let lying = 0;
    for (const c of this.corpses) if (c.rotAt > c.deadT) lying++;
    for (let i = 0; i < this.corpses.length && lying > CORPSE_KEEP; i++) {
      const c = this.corpses[i];
      if (c.rotAt > c.deadT) {
        c.rotAt = c.deadT;
        lying--;
      }
    }
  }

  /** Let every body go: the living and the dead lying about. */
  clearBodies() {
    for (const c of this.corpses) c.gone = true;
    for (const z of this.list) z.gone = true;
    this.list.length = 0;
    this.corpses.length = 0;
  }

  // ------------------------------------------------------------------ rendering

  /** Where and how a body is drawn this frame (and where the flesh engine finds its parts on it). */
  poseOf(zb: Zombie): BodyPose {
    const sc = zb.def.scale;
    const sink = zb.dead ? Math.max(0, zb.deadT - zb.rotAt) * 0.8 : 0;
    let mask = zb.wounds.mask;
    let legs = limbsGone(mask).legs;
    // Legs that are there but broken drag behind it like gone ones.
    if (zb.flesh && !zb.dead) {
      const u = legsUseless(zb.flesh);
      if (u >= 2 && legs < 2) {
        legs = 2;
        mask |= maskOf('legL') | maskOf('legR');
      } else if (u > legs) legs = u;
    }
    // Without legs a body drops to the ground and drags itself; with one it lists to the side.
    const drop = zb.dead ? 0 : legs >= 2 ? 0.78 * sc : legs === 1 ? 0.06 * sc : 0;
    let motion = zombieMotion(zb);
    if (zb.dead) {
      const slope = this.slopeUnder(zb);
      // Tipped to the ground as it comes down onto it.
      const k = Math.min(1, zb.deadT / 1.2);
      motion = { ...motion, deadT: zb.deadT, death: zb.deathSeed, back: zb.fallsBack, pitch: slope.pitch * k, roll: slope.roll * k };
    }
    return {
      kind: zb.kind, scale: sc, x: zb.x, y: zb.y - sink + (zb.dead ? 0.1 : 0) - drop, z: zb.z, yaw: zb.yaw, phase: zb.walkPhase, stride: 0,
      chase: zb.dead ? 0 : zb.chase, fall: zb.dead ? zb.fall : 0, variant: zb.variant, mask, reel: zb.stagger,
      lean: (legs >= 2 ? 0.75 : legs === 1 ? 0.12 : 0) + (zb.charge !== 'none' ? 0.35 : 0) + (zb.feedT > 0 || zb.eatT > 0 ? 0.55 : 0), motion,
    };
  }

  /**
   * The ground's slope under a body lying where it fell, along it and across it (a step or kerb under one end is not a
   * slope: it lies level there). Kept until the body is moved.
   */
  private slopeUnder(zb: Zombie) {
    const c = zb.lieSlope;
    if (c && c.x === zb.x && c.z === zb.z) return c;
    const ctx = this.ctx;
    const at = (x: number, z: number) => ctx.groundAt(x, z) + (ctx.ground?.heightAt(x, z) ?? 0);
    const fx = Math.sin(zb.yaw), fz = Math.cos(zb.yaw);
    const L = 0.7 * zb.def.scale, W = 0.3 * zb.def.scale;
    const along = at(zb.x - fx * L, zb.z - fz * L) - at(zb.x + fx * L, zb.z + fz * L);
    const across = at(zb.x + fz * W, zb.z - fx * W) - at(zb.x - fz * W, zb.z + fx * W);
    const pitch = Math.abs(along) > 0.45 ? 0 : clamp(Math.atan2(along, 2 * L), -0.4, 0.4);
    const roll = Math.abs(across) > 0.25 ? 0 : clamp(Math.atan2(across, 2 * W), -0.4, 0.4);
    return (zb.lieSlope = { x: zb.x, z: zb.z, pitch, roll });
  }

  /** When each body last came into sight and when it was last drawn (`render`). */
  private seenSince = new WeakMap<Zombie, { since: number; last: number }>();

  render(zr: ZombieRenderer, time: number, frustums: THREE.Frustum[], maxPerView: number, camPos: THREE.Vector3[]) {
    zr.begin();
    const sp = this.renderPoint;
    const budget = maxPerView * 2;
    const nearest = this.renderNearest;
    nearest.begin(Math.ceil(budget));
    const fl = this.ctx.gore?.anatomy;
    fl?.renderer.begin();
    const living = this.list.length;
    for (let order = 0; order < living + this.corpses.length; order++) {
      const zb = order < living ? this.list[order] : this.corpses[order - living];
      if (!zb.active && !zb.dead) continue;
      const distance = minDist(zb, camPos);
      if (!nearest.accepts(distance, order)) continue;
      sp.set(zb.x, zb.y + 0.9, zb.z);
      let seen = false;
      for (const f of frustums) {
        if (f.containsPoint(sp) || frustumNear(f, sp)) {
          seen = true;
          break;
        }
      }
      if (!seen) continue;
      nearest.offer(zb, distance, order);
    }
    for (const { value: zb } of nearest.finish()) {
      // A body that comes into sight away from everyone dissolves in; one seen within the last moment stays in.
      let seen = this.seenSince.get(zb);
      if (!seen || time - seen.last > ZOMBIE_SEEN_GAP) {
        seen = { since: minDist(zb, camPos) > ZOMBIE_FADE_NEAR ? time : -Infinity, last: time };
        this.seenSince.set(zb, seen);
      }
      seen.last = time;
      const shown = Math.min(1, (time - seen.since) / DISSOLVE_TIME);
      const q = this.poseOf(zb);
      // A hurt body is drawn with its wounds, cuts and breaks (and what is inside it); the rest stay in the horde mesh.
      if (!fl?.pushBody(zb, q, shown)) zr.push(q.kind, q.scale, q.x, q.y, q.z, q.yaw, q.phase, q.stride, q.chase, q.fall, q.variant, shown, q.mask, q.reel, q.lean, q.motion);
    }
    zr.end(time);
    if (fl) {
      fl.render();
      fl.renderer.end(time);
    }
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

/**
 * Where a ray (unit direction) first comes within `r` of a segment, as a distance along the ray, or null if it never does.
 * Good enough for a body lying on the ground: a capsule from its head to its middle and its middle to its feet.
 */
function raySegment(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number): number | null {
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const wx = ox - ax;
  const wy = oy - ay;
  const wz = oz - az;
  const b = dx * ux + dy * uy + dz * uz;
  const c = ux * ux + uy * uy + uz * uz;
  const d = dx * wx + dy * wy + dz * wz;
  const e = ux * wx + uy * wy + uz * wz;
  const den = c - b * b;
  let t = den > 1e-8 ? (e - b * d) / den : 0;
  t = Math.min(1, Math.max(0, t));
  const s = b * t - d;
  if (s < 0) return null;
  const px = ox + dx * s - (ax + ux * t);
  const py = oy + dy * s - (ay + uy * t);
  const pz = oz + dz * s - (az + uz * t);
  const dist = Math.hypot(px, py, pz);
  if (dist > r) return null;
  return Math.max(0, s - Math.sqrt(r * r - dist * dist));
}
