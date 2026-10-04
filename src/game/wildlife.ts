import * as THREE from 'three';
import { WILDLIFE, t, type AnimalDef, type AnimalKind } from '../data';
import { clamp, damp, wrapAngle } from '../core/math';
import { Rng } from '../core/rng';
import { animalSpeedMult, animalZoneOf, LEGS, newAnimalWounds, PART_BIT, partsGone, woundAnimal, type AnimalPart, type AnimalWounds, type AnimalZone } from '../sim/anatomy';
import { damageFraction, staggerSpeed, type AmmoSpec } from '../sim/ballistics';
import type { AnimalPose, AnimalRenderer } from '../render/animalRender';
import type { Ctx } from './ctx';
import type { Player } from './player';
import type { Vehicle } from './vehicle';

/**
 * idle: grazing or standing about. alert: head up, frozen, watching something it does not trust yet (prey) or warning it off
 * (a bear). feed: head down over a carcass. land: a bird coming down to one.
 */
export type AState = 'idle' | 'wander' | 'alert' | 'flee' | 'chase' | 'stalk' | 'windup' | 'charge' | 'rest' | 'fly' | 'land' | 'feed';

/** Standing height of each species, for shots and the frustum test (metres, before scale). */
const HEIGHT: Record<AnimalKind, number> = { hare: 0.35, deer: 1.3, vulture: 0.4, dog: 0.7, wolf: 0.9, boar: 0.85, bear: 1.6 };

/** How far each species lowers its head to graze or to eat (radians): a deer's neck is long, a boar's head hangs low already. */
const HEAD_DOWN: Record<AnimalKind, number> = { hare: 0.6, deer: 1.3, vulture: 0, dog: 0.8, wolf: 0.8, boar: 0.5, bear: 0.75 };

let aid = 1;
const _pose: AnimalPose = {};

/** Rations on a carcass: big game that has lost legs to the shot has less on it. */
function meatOf(a: Animal) {
  const g = partsGone(a.wounds.mask).legs;
  return a.def.meat >= 4 ? Math.max(2, Math.round(a.def.meat * (1 - 0.1 * g))) : a.def.meat;
}

/** Hides and tusks fetch scrap from the big game. */
function hideScrap(a: Animal) {
  return a.def.meat >= 4 ? Math.floor(a.def.meat / 2) : 0;
}

export class Animal {
  id = aid++;
  def: AnimalDef;
  x: number;
  y = 0;
  z: number;
  yaw: number;
  vx = 0;
  vz = 0;
  hp: number;
  state: AState = 'idle';
  stateT = 0;
  homeX: number;
  homeZ: number;
  tx: number;
  tz: number;
  hasTarget = false;
  target: Player | null = null;
  targetVeh: Vehicle | null = null;
  /** Where the threat is, for fleeing prey. */
  fearX = 0;
  fearZ = 0;
  dead = false;
  deadT = 0;
  /** Seconds the body lies about: edible carcasses wait twice as long to be butchered. */
  keepFor = WILDLIFE.rules.corpseSeconds;
  butchered = false;
  fall = 0;
  phase: number;
  flap: number;
  gait = 0;
  attackCd = 0;
  stun = 0;
  burn = 0;
  aiT: number;
  lostT = 0;
  active = false;
  tint: number;
  /** Fliers: orbit centre, radius, direction and angle, plus the height above ground it flies at. */
  orbit = { cx: 0, cz: 0, r: 18, a: 0, dir: 1, alt: 14 };
  /** Charge heading, held for the whole run. */
  dirX = 0;
  dirZ = 1;
  idleFor = 2;
  /** What heavy rounds have taken off, and how fast it is bleeding for it. */
  wounds: AnimalWounds = newAnimalWounds();
  /** Share of its speed left once legs are gone. */
  moveMult = 1;
  /** Who landed the last hit, so a bleed-out is still their kill. */
  lastKiller = -1;
  bleedT = 0;
  /** Pose, eased toward what it is doing: head pitch (+ down), head turn, front lifted, wings tucked. */
  head = 0;
  look = 0;
  rear = 0;
  fold = 0;
  /** How long it stands watching before it bolts or relaxes. */
  alertFor = 2;
  /** A hare jinks: which way, and how long until it jinks the other. */
  zig = 1;
  zigT = 0;
  /** After a bite a hunter darts back and circles for this long. */
  retreatT = 0;
  packSide = 1;
  /** The carcass it is walking to or feeding on. */
  feedOn: Animal | null = null;
  feedFor = 8;
  /** The way a herd's leader is heading, radians. */
  migrate = Math.random() * 6.28;
  /** Next time to look for zombies about, and what it saw. */
  scanT = Math.random() * 0.4;
  zfear: { x: number; z: number } | null = null;
  calloutT = 0;

  constructor(
    public kind: AnimalKind,
    x: number,
    z: number,
    public herd: number,
  ) {
    this.def = WILDLIFE.species[kind];
    this.x = x;
    this.z = z;
    this.homeX = x;
    this.homeZ = z;
    this.tx = x;
    this.tz = z;
    this.hp = this.def.hp;
    this.yaw = Math.random() * Math.PI * 2;
    this.phase = Math.random() * 6.28;
    this.flap = Math.random() * 6.28;
    this.tint = 0.86 + (aid % 7) * 0.045;
    this.aiT = Math.random() * 0.1;
    this.idleFor = 1 + Math.random() * 4;
  }

  get flying() {
    return this.def.temper === 'bird';
  }
  get chasing() {
    return this.state === 'chase' || this.state === 'charge' || this.state === 'windup' || this.state === 'stalk';
  }
  get height() {
    return HEIGHT[this.kind] * this.def.size;
  }
}

interface Threat {
  x: number;
  z: number;
  d: number;
  player: Player | null;
  vehicle: Vehicle | null;
}

let herdId = 1;

export class WildlifeSystem {
  list: Animal[] = [];
  /** Set by the leg scene: can an animal stand here (not inside a building)? */
  canStand: (x: number, z: number) => boolean = () => true;
  killedByPlayer: [number, number] = [0, 0];
  killed = 0;
  private rng: Rng;
  private spawnT = 0;
  private grid: Animal[] = [];
  /** Who leads each herd (the oldest still alive): the rest graze and travel around it. */
  private lead = new Map<number, Animal>();

  constructor(private ctx: Ctx) {
    this.rng = ctx.rng.fork('wildlife');
  }

  get aliveCount() {
    let n = 0;
    for (const a of this.list) if (!a.dead) n++;
    return n;
  }

  spawn(kind: AnimalKind, x: number, z: number, herd = herdId++) {
    const a = new Animal(kind, x, z, herd);
    a.y = this.ctx.groundAt(x, z);
    if (a.flying) {
      a.orbit = { cx: x, cz: z, r: this.rng.range(12, 26), a: this.rng.range(0, 6.28), dir: this.rng.sign(), alt: (a.def.altitude ?? 14) * this.rng.range(0.8, 1.2) };
      a.state = 'fly';
    }
    this.list.push(a);
    return a;
  }

  /** A herd, flock or pack of a species around a point. */
  spawnGroup(kind: AnimalKind, x: number, z: number) {
    const def = WILDLIFE.species[kind];
    const n = this.rng.int(def.group[0], def.group[1]);
    const herd = herdId++;
    const out: Animal[] = [];
    for (let i = 0; i < n; i++) {
      const a = this.rng.range(0, 6.28);
      const r = this.rng.range(1, 3 + n);
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      if (!this.canStand(px, pz)) continue;
      const w = this.ctx.waterAt(px, pz);
      if (w && w.depth > 0.3) continue;
      out.push(this.spawn(kind, px, pz, herd));
    }
    return out;
  }

  forEachNear(x: number, z: number, r: number, fn: (a: Animal) => void) {
    const r2 = r * r;
    for (const a of this.list) if (!a.dead && (a.x - x) ** 2 + (a.z - z) ** 2 <= r2) fn(a);
  }

  // ------------------------------------------------------------------ ambient population

  private pickKind(biome: 'wasteland' | 'city', theme: string, legIndex: number): AnimalKind | null {
    const night = this.ctx.night;
    let total = 0;
    const opts: [AnimalKind, number][] = [];
    for (const k in WILDLIFE.species) {
      const d = WILDLIFE.species[k as AnimalKind];
      if (!d.biomes.includes(biome) || !d.themes.includes(theme as 'dust') || d.legs > legIndex) continue;
      let w = d.weight;
      if (d.temper === 'pack') w *= 1 + night * 1.4;
      else if (d.temper === 'prey') w *= 1 - night * 0.65;
      else if (d.temper === 'bird') w *= 1 - night * 0.9;
      // A whole region of one kind is dull, and a dozen dogs is a massacre.
      const have = this.list.filter((a) => a.kind === k && !a.dead).length;
      if (have >= d.cap) continue;
      if (w <= 0) continue;
      opts.push([k as AnimalKind, w]);
      total += w;
    }
    if (!total) return null;
    let r = this.rng.next() * total;
    for (const [k, w] of opts) {
      r -= w;
      if (r <= 0) return k;
    }
    return opts[opts.length - 1][0];
  }

  /** Keep the road alive: herds, packs and flocks turn up out of sight, ahead of whoever is leading. */
  ambient(dt: number, biome: 'wasteland' | 'city', theme: string, legIndex: number) {
    const R = WILDLIFE.rules;
    this.spawnT -= dt;
    // Cull the far behind.
    for (const a of this.list) {
      if (a.dead) continue;
      let near = Infinity;
      for (const p of this.ctx.players) near = Math.min(near, Math.hypot(p.pos.x - a.x, p.pos.z - a.z));
      if (near > R.despawnRadius) {
        a.dead = true;
        a.deadT = 1e6;
      }
    }
    const alive = this.aliveCount;
    if (alive >= R.maxAlive) return;
    if (this.spawnT > 0 && alive >= 6) return;
    this.spawnT = R.spawnEvery * this.rng.range(0.7, 1.4);
    const players = this.ctx.players.filter((p) => p.alive);
    if (!players.length) return;
    const lead = this.rng.pick(players);
    // Ahead of a moving vehicle; anywhere around someone on foot.
    let heading = this.rng.range(0, 6.28);
    let spread = Math.PI;
    if (lead.vehicle && lead.vehicle.speed > 4) {
      const [fx, , fz] = lead.vehicle.body.forward();
      heading = Math.atan2(fz, fx);
      spread = 1.05;
    }
    for (let tries = 0; tries < 8; tries++) {
      const a = heading + this.rng.range(-spread, spread);
      const r = this.rng.range(R.spawnMin, R.spawnMax);
      const x = lead.pos.x + Math.cos(a) * r;
      const z = lead.pos.z + Math.sin(a) * r;
      if (!this.canStand(x, z)) continue;
      const w = this.ctx.waterAt(x, z);
      if (w && w.depth > 0.1) continue;
      if (this.ctx.visibleToAnyView(x, this.ctx.groundAt(x, z) + 1, z, 6)) continue;
      const kind = this.pickKind(biome, theme, legIndex);
      if (!kind) return;
      this.spawnGroup(kind, x, z);
      return;
    }
  }

  // ------------------------------------------------------------------ shots, blasts, melee

  rayTest(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxD: number): { animal: Animal; dist: number } | null {
    const dh = Math.hypot(dx, dz);
    if (dh < 1e-6) return null;
    const ux = dx / dh;
    const uz = dz / dh;
    let best: { animal: Animal; dist: number } | null = null;
    for (const a of this.list) {
      if (a.dead) continue;
      const vx = a.x - ox;
      const vz = a.z - oz;
      const t0 = vx * ux + vz * uz;
      if (t0 < 0 || t0 > maxD * dh) continue;
      const cx = ox + ux * t0;
      const cz = oz + uz * t0;
      const r = Math.max(0.24, a.def.radius * a.def.size) * 0.95 + 0.08;
      if (Math.hypot(cx - a.x, cz - a.z) > r) continue;
      const tt = t0 / dh;
      const yy = oy + dy * tt;
      const lo = a.flying ? a.y - 0.3 : a.y - 0.05;
      const hi = a.flying ? a.y + 0.4 : a.y + a.height;
      if (yy < lo || yy > hi) continue;
      if (!best || tt < best.dist) best = { animal: a, dist: tt };
    }
    return best;
  }

  damage(a: Animal, amount: number, info: { fromX: number; fromZ: number; killer?: number; fire?: boolean; explosive?: boolean }): boolean {
    if (a.dead) return false;
    a.hp -= amount;
    if (info.killer !== undefined && info.killer >= 0) a.lastKiller = info.killer;
    if (a.hp <= 0) {
      this.kill(a, info.killer ?? -1);
      return true;
    }
    const ctx = this.ctx;
    ctx.fx.blood(a.x, a.y + a.height * 0.6, a.z, 2);
    if (!info.fire) ctx.audio.play(a.def.temper === 'bird' ? 'caw' : 'yelp', a.x, a.z, 0.8);
    this.provoke(a, info.fromX, info.fromZ, info.killer ?? -1);
    return false;
  }

  /** Shove a body: it is thrown back at `speed` m/s along (dx, dz) and loses its feet for a moment, a bear barely. */
  private shove(a: Animal, dx: number, dz: number, speed: number) {
    if (a.dead || a.flying || speed <= 0) return;
    const l = Math.hypot(dx, dz) || 1;
    a.vx += (dx / l) * speed;
    a.vz += (dz / l) * speed;
    const moving = Math.hypot(a.vx, a.vz);
    if (a.def.temper !== 'brute' || moving > 3) a.stun = Math.max(a.stun, Math.min(0.5, 0.05 + moving * 0.06));
  }

  /** What it can still do on the legs it has left. */
  private refreshWounds(a: Animal) {
    const g = partsGone(a.wounds.mask);
    a.moveMult = animalSpeedMult(g.legs, a.def.hp >= 90);
  }

  /**
   * A round struck. Deals the damage, shoves the body along the shot, works out which part was hit and takes off what a round
   * that heavy can: a leg that has taken enough, a head that has taken a hard hit, a wing. Returns what happened so the
   * caller can throw the pieces.
   */
  bulletHit(
    a: Animal,
    h: { dmg: number; dx: number; dy: number; dz: number; x: number; y: number; z: number; spec: AmmoSpec; speed: number; fromX: number; fromZ: number; killer: number },
  ): { killed: boolean; zone: AnimalZone; off: AnimalPart[] } {
    // Where on the body: how far ahead of its middle, how far to its left, and how high.
    const ox = h.x - a.x;
    const oz = h.z - a.z;
    const fwd = ox * Math.sin(a.yaw) + oz * Math.cos(a.yaw);
    const lateral = ox * Math.cos(a.yaw) - oz * Math.sin(a.yaw);
    const relY = (h.y - a.y) / Math.max(0.1, a.height);
    const zone = animalZoneOf(a.kind, fwd, lateral, relY, a.def.size);
    const dmg = h.dmg * (zone === 'head' ? 1.8 : 1);
    const killed = this.damage(a, dmg, { fromX: h.fromX, fromZ: h.fromZ, killer: h.killer });
    const mass = Math.max(4, a.def.hp * 0.9 * a.def.size ** 3);
    this.shove(a, h.dx, h.dz, Math.min(5, staggerSpeed(h.spec, h.speed, mass) * damageFraction(h.speed / h.spec.speed)));
    const res = woundAnimal(a.wounds, a.kind, zone, dmg * h.spec.gore, a.def.hp, killed, this.ctx.rng.next());
    if (res.off.length) {
      this.refreshWounds(a);
      if (res.fatal && !a.dead) this.kill(a, h.killer);
    }
    return { killed: killed || a.dead, zone, off: res.off };
  }

  /** Rip one to three pieces off a body that a blast or a bumper has just killed, and throw them. */
  private tearAnimal(a: Animal, dx: number, dz: number, power: number) {
    const ctx = this.ctx;
    const pool: AnimalPart[] = a.flying ? ['wingL', 'wingR'] : [...LEGS, 'head'];
    const n = 1 + Math.min(2, Math.floor(power / 1.5));
    for (let i = 0; i < n; i++) {
      const part = pool[Math.floor(ctx.rng.next() * pool.length)];
      if (a.wounds.mask & PART_BIT[part]) continue;
      a.wounds.mask |= PART_BIT[part];
      ctx.gore?.severAnimal(a, part, dx, 0.5, dz, power);
    }
    this.refreshWounds(a);
  }

  /** Something hurt it: prey bolts, hunters turn on whoever it was. */
  private provoke(a: Animal, fromX: number, fromZ: number, killer: number) {
    const p = killer >= 0 ? this.ctx.players[killer] : null;
    const wounded = a.hp < a.def.hp * 0.3;
    const tmp = a.def.temper;
    if (tmp === 'prey' || tmp === 'bird' || wounded) {
      this.scare(a, fromX, fromZ);
      if (tmp !== 'prey' && tmp !== 'bird') a.stateT = -2;
      return;
    }
    if (a.state === 'chase' || a.state === 'windup' || a.state === 'charge' || a.state === 'rest') return;
    a.target = p && p.targetable ? p : null;
    a.tx = p ? p.pos.x : fromX;
    a.tz = p ? p.pos.z : fromZ;
    a.hasTarget = true;
    if (tmp === 'charger') this.windup(a);
    else this.startChase(a);
    // The pack answers.
    for (const o of this.list) if (o !== a && !o.dead && o.herd === a.herd && o.def.temper === 'pack' && !o.chasing) this.startChase(o, a.target, a.tx, a.tz);
  }

  /** Herd mates bolt together. */
  private scare(a: Animal, fromX: number, fromZ: number) {
    for (const o of this.list) {
      if (o.dead) continue;
      if (o === a || (o.herd === a.herd && o.def.temper !== 'pack' && o.def.temper !== 'brute' && o.def.temper !== 'charger')) {
        o.fearX = fromX;
        o.fearZ = fromZ;
        o.feedOn = null;
        if (o.state !== 'flee') {
          o.state = 'flee';
          o.stateT = 0;
          o.hasTarget = false;
        }
      }
    }
  }

  kill(a: Animal, killer: number) {
    if (a.dead) return;
    a.dead = true;
    a.deadT = 0;
    a.fall = 0;
    a.vx = a.vz = 0;
    const ctx = this.ctx;
    this.killed++;
    if (killer >= 0) this.killedByPlayer[killer]++;
    ctx.fx.blood(a.x, a.y + a.height * 0.6, a.z, 6);
    ctx.audio.play(a.def.temper === 'bird' ? 'caw' : a.def.temper === 'prey' ? 'yelp' : 'growl', a.x, a.z, 0.9);
    if (a.flying) a.y = ctx.groundAt(a.x, a.z) + 0.15;
    if (a.def.meat > 0) this.leaveCarcass(a);
    if (a.def.temper === 'pack') this.morale(a, killer);
  }

  /** A pack that has lost half of itself, or its leader, breaks and runs. */
  private morale(dead: Animal, killer: number) {
    let alive = 0;
    let total = 0;
    for (const o of this.list) {
      if (o.herd !== dead.herd || o.def.temper !== 'pack') continue;
      total++;
      if (!o.dead) alive++;
    }
    if (!alive) return;
    const leader = this.lead.get(dead.herd) === dead;
    if (alive / total > 0.5 && !leader) return;
    const p = killer >= 0 ? this.ctx.players[killer] : null;
    const fx = p ? p.pos.x : dead.x;
    const fz = p ? p.pos.z : dead.z;
    for (const o of this.list) {
      if (o.dead || o.herd !== dead.herd || o.def.temper !== 'pack' || o.state === 'flee') continue;
      // Losing the leader scatters most of them; losing half scatters all.
      if (leader && alive / total > 0.5 && this.rng.next() > 0.6) continue;
      o.fearX = fx;
      o.fearZ = fz;
      o.state = 'flee';
      o.stateT = 0;
      o.hasTarget = false;
      o.feedOn = null;
      this.ctx.audio.play('yelp', o.x, o.z, 0.7);
    }
  }

  /** The nearest carcass still worth eating within a radius: dead meat that nobody has butchered. */
  carcassNear(x: number, z: number, r: number): Animal | null {
    let best: Animal | null = null;
    let bd = r;
    for (const o of this.list) {
      if (!o.dead || o.butchered || o.def.meat <= 0 || o.deadT > o.keepFor * 0.7) continue;
      const d = Math.hypot(o.x - x, o.z - z);
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    return best;
  }

  /** Scavengers eat a carcass away: it is gone sooner for whoever was going to butcher it. */
  gnaw(a: Animal, seconds: number) {
    if (a.dead && !a.butchered) a.deadT += seconds;
  }

  private butcherTime(a: Animal) {
    return 0.8 + meatOf(a) * 0.25;
  }

  /** The kill leaves a carcass to hold A on. Without an interact registry (tests) it is taken on the spot. */
  private leaveCarcass(a: Animal) {
    const ctx = this.ctx;
    if (!ctx.interact) {
      this.butcher(a, null);
      return;
    }
    a.keepFor = WILDLIFE.rules.corpseSeconds * 2;
    ctx.interact.add({
      id: `carcass:${a.id}`,
      x: a.x,
      z: a.z,
      r: 2.4,
      prompt: `Hold to butcher ${a.def.name} (${meatOf(a)} rations${hideScrap(a) ? `, ${hideScrap(a)} scrap` : ''})`,
      dur: this.butcherTime(a),
      priority: 1,
      enabled: () => a.dead && !a.butchered,
      onTick: () => {
        // The smell and the commotion carry a little.
        ctx.sig?.emit(a.x, a.z, 14, 'noise');
        return true;
      },
      run: (p) => this.butcher(a, p),
    });
  }

  private butcher(a: Animal, by: Player | null) {
    if (a.butchered) return;
    a.butchered = true;
    const ctx = this.ctx;
    ctx.interact?.remove(`carcass:${a.id}`);
    const gross: Partial<Record<'rations' | 'scrap', number>> = { rations: meatOf(a) };
    const scrap = hideScrap(a);
    if (scrap) gross.scrap = scrap;
    ctx.addLoot(gross, 'hunt');
    ctx.fx.blood(a.x, a.y + 0.3, a.z, 3);
    ctx.audio.play('pickup', a.x, a.z, 0.8);
    ctx.notify(-1, t('hunt.meat', { name: a.def.name, n: meatOf(a) }) + (scrap ? ` +${scrap} scrap from the hide.` : ''), 'good');
    if (by) a.deadT = Math.max(a.deadT, a.keepFor - 4);
  }

  blast(x: number, z: number, radius: number, damage: number, killer: number) {
    for (const a of this.list) {
      if (a.dead) continue;
      const d = Math.hypot(a.x - x, a.z - z);
      if (d > radius) continue;
      const f = 1 - (d / radius) ** 2 * 0.7;
      const killed = this.damage(a, damage * f, { fromX: x, fromZ: z, killer, explosive: true });
      const k = (1 - d / radius) * 5;
      const l = d || 1;
      a.vx += ((a.x - x) / l) * k;
      a.vz += ((a.z - z) / l) * k;
      // A blast that more than kills tears pieces off.
      if (killed && damage * f >= a.def.hp * 1.2) this.tearAnimal(a, (a.x - x) / l, (a.z - z) / l, (damage * f) / a.def.hp);
    }
  }

  burnArea(x: number, z: number, r: number, dps: number, dt: number, killer: number) {
    for (const a of this.list) {
      if (a.dead) continue;
      if (Math.hypot(a.x - x, a.z - z) <= r) {
        a.burn = 1.5;
        this.damage(a, dps * dt, { fromX: x, fromZ: z, killer, fire: true });
      }
    }
  }

  /** `cut` is how well the weapon takes limbs off (see `cutOf`): a blade takes a leg or the head, a bat only breaks. */
  meleeHit(p: Player, hx: number, hz: number, yaw: number, reach: number, dmg: number, cut = 0) {
    let hit = 0;
    for (const a of this.list) {
      if (a.dead || a.flying) continue;
      const dx = a.x - p.pos.x;
      const dz = a.z - p.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > reach + a.def.radius * a.def.size) continue;
      if (Math.abs(wrapAngle(Math.atan2(dx, dz) - yaw)) > 1.0) continue;
      const dealt = dmg * (1 - a.def.armor);
      const killed = this.damage(a, dealt, { fromX: p.pos.x, fromZ: p.pos.z, killer: p.index });
      if (cut > 0) {
        // A swing lands low or high at random: mostly a leg, now and then the head.
        const r = this.ctx.rng.next();
        const zone: AnimalZone = r < 0.15 ? 'head' : r < 0.75 ? LEGS[Math.floor(this.ctx.rng.next() * 4)] : 'torso';
        const res = woundAnimal(a.wounds, a.kind, zone, dealt * cut, a.def.hp, killed, this.ctx.rng.next());
        if (res.off.length) {
          this.refreshWounds(a);
          for (const part of res.off) this.ctx.gore?.severAnimal(a, part, dx / (d || 1), 0.3, dz / (d || 1), (dealt * cut) / a.def.hp);
          if (res.fatal && !a.dead) this.kill(a, p.index);
        }
      }
      a.vx += (dx / (d || 1)) * 3;
      a.vz += (dz / (d || 1)) * 3;
      a.stun = Math.max(a.stun, 0.25);
      hit++;
      if (hit >= 2) break;
    }
    if (hit) {
      this.ctx.fx.blood(hx, p.pos.y + 0.8, hz, 3);
      this.ctx.audio.play('thud', hx, hz, 0.6);
    }
  }

  // ------------------------------------------------------------------ vehicles

  /** Vehicles run animals down. Big ones fight back: a boar dents the bumper, a bear costs real speed. */
  plow(v: Vehicle) {
    const sp = v.speed;
    if (sp < 3 || v.wreck) return;
    const [fx, , fz] = v.body.forward();
    const p = v.position;
    const pl = v.stats.plow;
    const w = v.def.width / 2 + 0.3 + pl * 0.4;
    const front = v.def.length / 2;
    let slow = 1;
    for (const a of this.list) {
      if (a.dead || a.flying) continue;
      const rx = a.x - p.x;
      const rz = a.z - p.z;
      if (Math.abs(rx) > 8 || Math.abs(rz) > 8) continue;
      const lz = rx * fx + rz * fz;
      const lx = rx * fz - rz * fx;
      const rad = a.def.radius * a.def.size;
      if (lz < front - 1.1 || lz > front + 1.3 || Math.abs(lx) > w + rad) continue;
      const dmg = (30 + sp * 7.5) * (v.def.tier >= 3 ? 1.5 : v.def.tier === 2 ? 1.0 : 0.7) * (1 + pl);
      const killer = v.driver?.isPlayer ? v.driver.index : -1;
      const dealt = dmg * (1 - a.def.armor);
      const killed = this.damage(a, dealt, { fromX: p.x, fromZ: p.z, killer });
      if (killed && dealt >= a.def.hp * 1.1) this.tearAnimal(a, fx, fz, dealt / a.def.hp);
      a.vx += fx * sp * 0.7 - fz * lx * 0.3;
      a.vz += fz * sp * 0.7 + fx * lx * 0.3;
      a.stun = Math.max(a.stun, 0.6);
      this.ctx.fx.blood(a.x, a.y + 0.5, a.z, 3);
      v.bodywork.splat(clamp(0.02 + a.def.hp / 2500, 0.02, 0.09));
      const hp = a.def.hp;
      const loss = clamp(0.006 + hp / 2200, 0.006, 0.16) * (1 - Math.min(0.7, pl * 0.9));
      slow *= 1 - loss;
      if (hp >= 90) {
        v.takeHit(6 + hp * 0.04 + sp * 0.5, a.x, a.z, { ram: true, silent: true });
        if (hp >= 300) v.shove(-fx * v.mass * 0.8, -fz * v.mass * 0.8);
      }
      this.ctx.audio.play('thud', a.x, a.z, 0.8);
      if (v.driver?.isPlayer) {
        this.ctx.input.rumble(v.driver.index, 0.2, 0.3, 60);
        this.ctx.players[v.driver.index]?.cam.addShake(0.04 + Math.min(0.1, hp / 2500));
      }
    }
    if (slow < 1) {
      const lv = v.body.body.linvel();
      v.body.body.setLinvel({ x: lv.x * slow, y: lv.y, z: lv.z * slow }, true);
    }
  }

  // ------------------------------------------------------------------ main update

  update(dt: number) {
    const ctx = this.ctx;
    if (!this.list.length) return;
    const anyone = ctx.players.some((p) => p.alive);
    if (!anyone) return;
    const act = WILDLIFE.rules.activeRadius;
    // Who leads each herd: the oldest still alive.
    this.lead.clear();
    for (const a of this.list) {
      if (a.dead || a.flying) continue;
      const l = this.lead.get(a.herd);
      if (!l || a.id < l.id) this.lead.set(a.herd, a);
    }
    for (let i = this.list.length - 1; i >= 0; i--) {
      const a = this.list[i];
      if (a.dead) {
        a.deadT += dt;
        a.fall = Math.min(1, a.deadT / 0.4);
        a.vx = damp(a.vx, 0, 6, dt);
        a.vz = damp(a.vz, 0, 6, dt);
        a.x += a.vx * dt;
        a.z += a.vz * dt;
        if (a.deadT > a.keepFor) {
          ctx.interact?.remove(`carcass:${a.id}`);
          this.list[i] = this.list[this.list.length - 1];
          this.list.pop();
        }
        continue;
      }
      let near = false;
      for (const p of ctx.players) {
        if (Math.abs(p.pos.x - a.x) < act && Math.abs(p.pos.z - a.z) < act) {
          near = true;
          break;
        }
      }
      a.active = near;
      if (!near) continue;
      a.attackCd -= dt;
      if (a.stun > 0) a.stun -= dt;
      a.stateT += dt;
      if (a.burn > 0) {
        a.burn -= dt;
        if (Math.random() < 0.4) ctx.fx.fire(a.x, a.y + 0.4, a.z, 0.3);
        this.damage(a, 6 * dt, { fromX: a.x, fromZ: a.z, fire: true });
        if (a.dead) continue;
      }
      // An open wound bleeds it out, and leaves a trail to follow.
      if (a.wounds.bleed > 0) {
        a.hp -= a.wounds.bleed * dt;
        a.bleedT -= dt;
        if (a.bleedT <= 0) {
          a.bleedT = 0.4;
          ctx.fx.blood(a.x, a.y + a.height * 0.4, a.z, 1);
          ctx.gore?.drip(a.x, a.z, 0.14 + Math.random() * 0.14);
        }
        if (a.hp <= 0) {
          this.kill(a, a.lastKiller);
          continue;
        }
      }
      if (a.state === 'feed' && a.feedOn) this.gnaw(a.feedOn, dt * 1.5);
      a.aiT -= dt;
      if (a.aiT <= 0) {
        a.aiT += a.flying ? 0.2 : 0.08;
        this.think(a);
      }
      if (a.flying) this.fly(a, dt);
      else this.walk(a, dt);
      this.animate(a, dt);
    }
    // Keep ground animals from stacking.
    this.grid.length = 0;
    for (const a of this.list) if (!a.dead && a.active && !a.flying) this.grid.push(a);
  }

  // ------------------------------------------------------------------ senses

  private threat(a: Animal, foot: boolean, vehicles: boolean): Threat | null {
    const ctx = this.ctx;
    const aggro = ctx.campaign.difficulty.aggro;
    let best: Threat | null = null;
    for (const p of ctx.players) {
      if (!p.alive) continue;
      const inVeh = p.inVehicle && p.vehicle;
      if (inVeh ? !vehicles : !foot) continue;
      const px = inVeh ? p.vehicle!.position.x : p.pos.x;
      const pz = inVeh ? p.vehicle!.position.z : p.pos.z;
      const d = Math.hypot(px - a.x, pz - a.z);
      let sight = a.def.sight * aggro;
      if (inVeh) {
        const v = p.vehicle!;
        // An engine is loud: far more noticeable than a quiet idle.
        sight *= v.speed > 1.5 ? 1.3 : 0.45;
      } else if (p.crouch) sight *= 0.5;
      if (d > sight) continue;
      if (!best || d < best.d) best = { x: px, z: pz, d, player: inVeh ? null : p, vehicle: inVeh ? p.vehicle : null };
    }
    return best;
  }

  /** Nearest loud noise this animal can hear (gunfire, engines up close). */
  private heard(a: Animal, min: number) {
    const src = this.ctx.sig.loudestFor(a.x, a.z, false, 'noise');
    return src && src.level >= min ? src : null;
  }

  /** Where the dead are, if enough of them are moving within `r` to run from. Looked up a few times a second, not every think. */
  private scanZombies(a: Animal, r: number, min: number) {
    a.scanT -= 0.08;
    if (a.scanT > 0) return a.zfear;
    a.scanT = 0.35 + Math.random() * 0.2;
    a.zfear = null;
    const zs = this.ctx.zombies?.list;
    if (!zs || !zs.length) return null;
    const r2 = r * r;
    let n = 0;
    let sx = 0;
    let sz = 0;
    for (const z of zs) {
      if (z.dead || !z.active || z.state === 'dormant') continue;
      const dx = z.x - a.x;
      const dz = z.z - a.z;
      const d2 = dx * dx + dz * dz;
      // Ones that are only shuffling about must be close to matter; ones that are hunting, anywhere in range.
      if (d2 > r2 || (!z.chasing && d2 > r2 * 0.25)) continue;
      n++;
      sx += z.x;
      sz += z.z;
    }
    if (n >= min) a.zfear = { x: sx / n, z: sz / n };
    return a.zfear;
  }

  private visible(a: Animal, x: number, z: number) {
    return !this.ctx.obs.segmentBlocked(a.x, a.z, x, z, Math.max(0.4, a.height * 0.7));
  }

  // ------------------------------------------------------------------ decisions

  private think(a: Animal) {
    switch (a.def.temper) {
      case 'prey':
        return this.thinkPrey(a);
      case 'bird':
        return this.thinkBird(a);
      case 'pack':
        return this.thinkPack(a);
      case 'charger':
        return this.thinkCharger(a);
      case 'brute':
        return this.thinkBrute(a);
    }
  }

  /**
   * Graze: stand about, drift to a nearby spot, stand again. A herd goes about it together: its leader picks a heading and
   * bends it slowly, and the rest stay in a loose ring around it instead of each wandering off on its own.
   */
  private graze(a: Animal, range = 7) {
    if (a.state === 'idle') {
      if (a.stateT > a.idleFor) {
        const L = this.lead.get(a.herd);
        if (L && L !== a && !L.dead) {
          const d = Math.hypot(L.x - a.x, L.z - a.z);
          // Near enough to the leader: carry on grazing where it stands.
          if (d < 4 + (a.id % 3) * 1.5) {
            a.stateT = 0;
            a.idleFor = 1.5 + Math.random() * 4;
            return;
          }
          const ang = a.id * 2.4;
          const r = 1.5 + (a.id % 4);
          a.tx = L.x + Math.cos(ang) * r;
          a.tz = L.z + Math.sin(ang) * r;
        } else {
          a.migrate += (Math.random() - 0.5) * 1.3;
          const r = 2 + Math.random() * range * 1.2;
          a.tx = a.homeX + Math.cos(a.migrate) * r;
          a.tz = a.homeZ + Math.sin(a.migrate) * r;
        }
        a.hasTarget = true;
        a.state = 'wander';
        a.stateT = 0;
      }
    } else if (a.state === 'wander') {
      if (Math.hypot(a.tx - a.x, a.tz - a.z) < 0.8 || a.stateT > 8) {
        a.state = 'idle';
        a.stateT = 0;
        a.idleFor = 2 + Math.random() * 6;
        a.hasTarget = false;
        // Drift the home so herds do not stay put forever.
        a.homeX += (a.x - a.homeX) * 0.5;
        a.homeZ += (a.z - a.homeZ) * 0.5;
      }
    }
  }

  /**
   * Prey does not just run. It grazes with its head down, and when something it does not trust comes into sight it stops and
   * stares (the whole herd goes still and lifts its heads) before deciding: bolt, if the thing keeps coming, or settle again.
   * A hare freezes far longer than a deer, and only bolts when it is nearly stepped on.
   */
  private thinkPrey(a: Animal) {
    const th = this.threat(a, true, true);
    const noise = this.heard(a, 38);
    const sight = a.def.sight;
    const zf = this.scanZombies(a, sight * 0.45, 1);
    if (a.state === 'flee') {
      const quiet = (!th || th.d > sight * 1.1) && !zf;
      if (a.stateT > 3 && quiet && !noise) {
        a.state = 'idle';
        a.stateT = 0;
        a.homeX = a.x;
        a.homeZ = a.z;
        a.hasTarget = false;
      } else if (th) {
        a.fearX = th.x;
        a.fearZ = th.z;
      } else if (zf) {
        a.fearX = zf.x;
        a.fearZ = zf.z;
      }
      return;
    }
    // The dead are always a reason to go, and a hunting pack too.
    if (zf) {
      this.scare(a, zf.x, zf.z);
      return;
    }
    const hunter = this.hunterNear(a, 20);
    if (hunter) {
      this.scare(a, hunter.x, hunter.z);
      return;
    }
    const bolt = a.kind === 'hare' ? 0.4 : 0.75;
    const fast = !!th && !!th.vehicle && th.vehicle.speed > 1.5;
    if (th && (fast || th.d < sight * bolt)) {
      this.scare(a, th.x, th.z);
      return;
    }
    if (noise && noise.level >= 60) {
      this.scare(a, noise.x, noise.z);
      return;
    }
    if (a.state === 'alert') {
      if (th) {
        a.fearX = th.x;
        a.fearZ = th.z;
      }
      if (a.stateT > a.alertFor) {
        if (th) this.scare(a, th.x, th.z);
        else {
          a.state = 'idle';
          a.stateT = 0;
          a.idleFor = 1 + Math.random() * 2;
        }
      }
      return;
    }
    if (th || noise) {
      const src = th ?? noise!;
      this.alertHerd(a, src.x, src.z);
      return;
    }
    this.graze(a);
  }

  /** A hunting animal (a pack in full cry, a bear after something) close enough to be run from. */
  private hunterNear(a: Animal, r: number): { x: number; z: number } | null {
    for (const o of this.list) {
      if (o.dead || o === a || !o.chasing || o.def.temper === 'prey' || o.def.temper === 'bird') continue;
      if (Math.hypot(o.x - a.x, o.z - a.z) < r) return o;
    }
    return null;
  }

  /** Something is not right: it and the herd mates near it freeze and look. */
  private alertHerd(a: Animal, x: number, z: number) {
    const hare = a.kind === 'hare';
    for (const o of this.list) {
      if (o.dead || o.flying) continue;
      if (o !== a && (o.herd !== a.herd || o.def.temper !== a.def.temper)) continue;
      if (o.state !== 'idle' && o.state !== 'wander') continue;
      if (o !== a && Math.random() > 0.7) continue;
      o.state = 'alert';
      o.stateT = 0;
      o.hasTarget = false;
      o.fearX = x;
      o.fearZ = z;
      o.alertFor = (hare ? 3.5 : 1.8) + Math.random() * (hare ? 3 : 2);
    }
  }

  private thinkBird(a: Animal) {
    const th = this.threat(a, true, false);
    const noise = this.heard(a, 50);
    if (a.state === 'flee') {
      if (a.stateT > 5) {
        a.state = 'fly';
        a.stateT = 0;
        a.orbit.cx = a.x;
        a.orbit.cz = a.z;
      }
      return;
    }
    // A bird on the ground is warier than one overhead.
    const near = a.state === 'feed' || a.state === 'land' ? 14 : 9;
    if ((th && th.d < near) || (noise && Math.hypot(noise.x - a.x, noise.z - a.z) < 45)) {
      a.feedOn = null;
      this.scare(a, th ? th.x : noise!.x, th ? th.z : noise!.z);
      this.ctx.audio.play('caw', a.x, a.z, 0.8);
      return;
    }
    if (a.state === 'feed' || a.state === 'land') {
      const c = a.feedOn;
      if (!c || !c.dead || c.butchered || (a.state === 'feed' && a.stateT > a.feedFor)) {
        // Done, or beaten to it: back up into the air.
        a.feedOn = null;
        a.state = 'flee';
        a.stateT = 0;
        a.fearX = a.x + (Math.random() - 0.5) * 4;
        a.fearZ = a.z + (Math.random() - 0.5) * 4;
      }
      return;
    }
    // Wheel over the freshest carcass nearby, else drift with the herd.
    let carcass: Animal | null = null;
    let bd = 90;
    for (const o of this.list) {
      if (!o.dead || o.flying || o.deadT > 25) continue;
      const d = Math.hypot(o.x - a.orbit.cx, o.z - a.orbit.cz);
      if (d < bd) {
        bd = d;
        carcass = o;
      }
    }
    const baseAlt = a.def.altitude ?? 14;
    if (carcass) {
      a.orbit.cx += (carcass.x - a.orbit.cx) * 0.06;
      a.orbit.cz += (carcass.z - a.orbit.cz) * 0.06;
      a.orbit.alt += (baseAlt * 0.45 - a.orbit.alt) * 0.04;
      // Once the body has lain quiet a few seconds, a couple of them come down to it.
      if (carcass.deadT > 6 && !carcass.butchered && bd < 45 && Math.random() < 0.05) this.land(a, carcass);
    } else {
      a.orbit.alt += (baseAlt - a.orbit.alt) * 0.02;
      // Slowly follow whoever is closest so the sky is not empty behind the convoy.
      let near: Player | null = null;
      let nd = Infinity;
      for (const p of this.ctx.players) {
        const d = Math.hypot(p.pos.x - a.orbit.cx, p.pos.z - a.orbit.cz);
        if (d < nd) {
          nd = d;
          near = p;
        }
      }
      if (near && nd > 140) {
        a.orbit.cx += (near.pos.x + Math.sin(a.id) * 60 - a.orbit.cx) * 0.02;
        a.orbit.cz += (near.pos.z + Math.cos(a.id) * 60 - a.orbit.cz) * 0.02;
      }
    }
  }

  /** A bird comes down to a carcass, if there is room for it: three at a body is a crowd. */
  private land(a: Animal, c: Animal) {
    let there = 0;
    for (const o of this.list) if (o !== a && !o.dead && o.feedOn === c && (o.state === 'land' || o.state === 'feed')) there++;
    if (there >= 3) return;
    const ang = Math.random() * 6.28;
    a.feedOn = c;
    a.state = 'land';
    a.stateT = 0;
    a.feedFor = 10 + Math.random() * 14;
    a.tx = c.x + Math.cos(ang) * (1.3 + Math.random() * 1.2);
    a.tz = c.z + Math.sin(ang) * (1.3 + Math.random() * 1.2);
  }

  /**
   * Dogs and wolves: hunt people on foot, trail engines for a while, break when hurt (or when the pack is) and run from a
   * horde of the dead. Left alone they scavenge: a carcass draws them in to feed, and what they eat is gone for the hunter.
   */
  private thinkPack(a: Animal) {
    const ctx = this.ctx;
    const def = a.def;
    // People on foot first; a passing engine only draws them when it is close, and they drop it quickly.
    let th = this.threat(a, true, false);
    if (!th) {
      const tv = this.threat(a, false, true);
      if (tv && (tv.d < 22 || (a.chasing && tv.d < 45))) th = tv;
    }
    const noise = this.heard(a, 60);
    const wolf = a.kind === 'wolf';
    const horde = this.scanZombies(a, 20, 3);
    if (a.state === 'flee') {
      if (a.stateT > 6) {
        a.state = 'idle';
        a.stateT = 0;
        a.hasTarget = false;
        a.homeX = a.x;
        a.homeZ = a.z;
      }
      return;
    }
    // Badly hurt, crippled, or faced with a horde: it is not worth it.
    if ((a.chasing && (a.hp < def.hp * 0.25 || a.moveMult < 0.4)) || horde) {
      a.fearX = horde ? horde.x : a.tx;
      a.fearZ = horde ? horde.z : a.tz;
      a.state = 'flee';
      a.stateT = 0;
      a.feedOn = null;
      ctx.audio.play('yelp', a.x, a.z, 0.8);
      return;
    }
    if (a.chasing) {
      // Keep the nearest valid target; give up after a while or when out-run.
      if (th && (this.visible(a, th.x, th.z) || th.d < 20)) {
        a.tx = th.x;
        a.tz = th.z;
        a.target = th.player;
        a.targetVeh = th.vehicle;
        a.lostT = 0;
        if (a.state === 'stalk' && (a.stateT > 2 || th.d < 5)) {
          a.state = 'chase';
          a.stateT = 0;
          ctx.audio.play('growl', a.x, a.z, 0.8);
        }
      } else a.lostT += 0.08;
      if (a.lostT > 6 || (a.target && !a.target.targetable && a.state !== 'chase')) {
        a.state = 'idle';
        a.stateT = 0;
        a.hasTarget = false;
        a.target = null;
      }
      return;
    }
    const seen = th && this.visible(a, th.x, th.z);
    if (seen && th) {
      this.huntAlert(a, th);
      return;
    }
    // Feeding, or on the way to it.
    const c = a.feedOn;
    if (a.state === 'feed') {
      if (noise && noise.level >= 75) {
        a.feedOn = null;
        a.state = 'wander';
        a.tx = noise.x;
        a.tz = noise.z;
        a.hasTarget = true;
        a.stateT = 0;
      } else if (!c || !c.dead || c.butchered || a.stateT > a.feedFor) {
        a.feedOn = null;
        a.state = 'idle';
        a.stateT = 0;
        a.idleFor = 1 + Math.random() * 3;
      }
      return;
    }
    if (c && a.state === 'wander') {
      if (!c.dead || c.butchered || a.stateT > 25) {
        a.feedOn = null;
        a.state = 'idle';
        a.stateT = 0;
      } else if (Math.hypot(a.tx - a.x, a.tz - a.z) < 1.4) {
        a.state = 'feed';
        a.stateT = 0;
        a.feedFor = 7 + Math.random() * 9;
        a.hasTarget = false;
      }
      return;
    }
    if (noise && a.state !== 'wander') {
      a.state = 'wander';
      a.tx = noise.x;
      a.tz = noise.z;
      a.hasTarget = true;
      a.stateT = 0;
      return;
    }
    if (a.state === 'idle' && this.scavenge(a)) return;
    // Packs roam a little further than grazers.
    this.graze(a, wolf ? 14 : 10);
  }

  /** Idle and a body lying within a long sniff: go and eat it. */
  private scavenge(a: Animal): boolean {
    if (a.stateT < a.idleFor * 0.5 || Math.random() > 0.35) return false;
    const c = this.carcassNear(a.x, a.z, 55);
    if (!c || c.herd === a.herd) return false;
    const ang = Math.random() * 6.28;
    a.feedOn = c;
    a.tx = c.x + Math.cos(ang) * 1.1;
    a.tz = c.z + Math.sin(ang) * 1.1;
    a.hasTarget = true;
    a.state = 'wander';
    a.stateT = 0;
    return true;
  }

  private huntAlert(a: Animal, th: Threat) {
    const start = (o: Animal) => {
      this.startChase(o, th.player, th.x, th.z);
      if (o.kind === 'wolf' && th.d > 9) o.state = 'stalk';
      o.targetVeh = th.vehicle;
    };
    start(a);
    this.ctx.audio.play('growl', a.x, a.z, 0.9);
    for (const o of this.list) if (o !== a && !o.dead && o.herd === a.herd && !o.chasing && o.state !== 'flee') start(o);
  }

  private startChase(a: Animal, target: Player | null = null, x = a.tx, z = a.tz) {
    a.feedOn = null;
    a.state = 'chase';
    a.stateT = 0;
    a.lostT = 0;
    a.target = target;
    a.tx = x;
    a.tz = z;
    a.hasTarget = true;
  }

  private windup(a: Animal) {
    a.state = 'windup';
    a.stateT = 0;
    a.feedOn = null;
    this.ctx.audio.play('growl', a.x, a.z, 0.8);
    // A sounder backs its own: kin that are near square up too, a beat behind.
    if (a.def.temper !== 'charger') return;
    for (const o of this.list) {
      if (o === a || o.dead || o.herd !== a.herd || o.def.temper !== 'charger') continue;
      if (o.state !== 'idle' && o.state !== 'wander') continue;
      if (Math.hypot(o.x - a.x, o.z - a.z) > 25 || Math.random() > 0.7) continue;
      o.state = 'windup';
      o.stateT = -Math.random() * 0.4;
      o.tx = a.tx;
      o.tz = a.tz;
      o.hasTarget = true;
    }
  }

  private thinkCharger(a: Animal) {
    const th = this.threat(a, true, true);
    if (a.state === 'windup' || a.state === 'charge' || a.state === 'rest') {
      // Lock the line for the charge once the windup ends; steer only a little.
      if (a.state === 'charge' && th) {
        a.tx = th.x;
        a.tz = th.z;
      }
      if (a.state === 'rest' && a.stateT > 1.6) {
        a.state = 'idle';
        a.stateT = 0;
        a.idleFor = 1;
        a.hasTarget = false;
      }
      return;
    }
    if (a.state === 'flee') {
      if (a.stateT > 4) {
        a.state = 'idle';
        a.stateT = 0;
        a.hasTarget = false;
      }
      return;
    }
    if (th && th.d < a.def.sight && this.visible(a, th.x, th.z) && (th.player || (th.vehicle && th.vehicle.speed < 14))) {
      a.tx = th.x;
      a.tz = th.z;
      a.hasTarget = true;
      a.target = th.player;
      this.windup(a);
      return;
    }
    this.graze(a, 6);
  }

  /**
   * A bear leaves you alone until you walk into its space, but it says so first: it rises on its hind legs and growls,
   * turning to face you, and only charges if you keep coming (or have already hurt it).
   */
  private thinkBrute(a: Animal) {
    const th = this.threat(a, true, true);
    a.calloutT -= 0.08;
    if (a.state === 'chase') {
      if (th && (this.visible(a, th.x, th.z) || th.d < 20) && th.d < 70) {
        a.tx = th.x;
        a.tz = th.z;
        a.target = th.player;
        a.targetVeh = th.vehicle;
        a.lostT = 0;
      } else a.lostT += 0.08;
      if (a.lostT > 7 || (th && th.d > 70)) {
        a.state = 'idle';
        a.stateT = 0;
        a.hasTarget = false;
        a.target = null;
      }
      return;
    }
    const close = th && (th.player ? th.d < (th.player.crouch ? 6 : 11) : th.d < 9);
    if (close && th && this.visible(a, th.x, th.z)) {
      a.target = th.player;
      this.startChase(a, th.player, th.x, th.z);
      this.ctx.audio.play('growl', a.x, a.z, 1);
      return;
    }
    // Inside its warning range but not yet in its space.
    const warn = !!th && (th.player ? th.d < (th.player.crouch ? 9 : 20) : th.d < 14) && this.visible(a, th.x, th.z);
    if (a.state === 'alert') {
      if (!warn || a.stateT > 6) {
        a.state = 'idle';
        a.stateT = 0;
        a.idleFor = 1.5;
      } else {
        a.fearX = th!.x;
        a.fearZ = th!.z;
      }
      return;
    }
    if (warn && th) {
      a.state = 'alert';
      a.stateT = 0;
      a.hasTarget = false;
      a.fearX = th.x;
      a.fearZ = th.z;
      if (a.calloutT <= 0) {
        a.calloutT = 6;
        this.ctx.audio.play('growl', a.x, a.z, 0.9);
      }
      return;
    }
    this.graze(a, 8);
  }

  // ------------------------------------------------------------------ movement

  private walk(a: Animal, dt: number) {
    const ctx = this.ctx;
    const def = a.def;
    a.y = ctx.groundAt(a.x, a.z);
    let speed = 0;
    let wx = 0;
    let wz = 0;
    const toward = (x: number, z: number) => {
      const dx = x - a.x;
      const dz = z - a.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.3) {
        wx = dx / d;
        wz = dz / d;
        return d;
      }
      return 0;
    };
    if (a.stun <= 0) {
      switch (a.state) {
        case 'idle':
          break;
        case 'wander':
          if (a.hasTarget && toward(a.tx, a.tz) > 0) speed = def.walk * (a.def.temper === 'pack' && (a.stateT < 1.5 || a.feedOn) ? 2.2 : 1);
          break;
        case 'alert':
        case 'feed': {
          // Standing its ground: turn to face what it is watching, or the body it is eating.
          const fx = a.state === 'feed' && a.feedOn ? a.feedOn.x : a.fearX;
          const fz = a.state === 'feed' && a.feedOn ? a.feedOn.z : a.fearZ;
          if (Math.hypot(fx - a.x, fz - a.z) > 0.3) a.yaw += wrapAngle(Math.atan2(fx - a.x, fz - a.z) - a.yaw) * Math.min(1, dt * 4);
          break;
        }
        case 'flee': {
          // Away from the fear, bent toward the herd's home so a flock does not scatter to the horizon. A hare jinks hard from
          // side to side; the rest weave a little.
          const dx = a.x - a.fearX;
          const dz = a.z - a.fearZ;
          const d = Math.hypot(dx, dz) || 1;
          if (a.kind === 'hare') {
            a.zigT -= dt;
            if (a.zigT <= 0) {
              a.zigT = 0.3 + Math.random() * 0.5;
              a.zig = -a.zig;
            }
          }
          const wob = a.kind === 'hare' ? a.zig * 0.95 : Math.sin(a.stateT * 1.7 + a.id) * 0.35;
          wx = dx / d + -dz / d * wob;
          wz = dz / d + (dx / d) * wob;
          const l = Math.hypot(wx, wz) || 1;
          wx /= l;
          wz /= l;
          speed = def.run * (a.def.temper === 'pack' ? 0.9 : 1);
          break;
        }
        case 'chase':
          if (a.hasTarget && toward(a.tx, a.tz) > 0) {
            speed = def.run;
            const d = Math.hypot(a.tx - a.x, a.tz - a.z);
            const ux = (a.tx - a.x) / d;
            const uz = (a.tz - a.z) / d;
            if (a.retreatT > 0) {
              // Just bitten: dart back and circle, so a pack worries at you instead of sitting on you.
              a.retreatT -= dt;
              wx = -ux * 0.45 - uz * a.packSide * 0.9;
              wz = -uz * 0.45 + ux * a.packSide * 0.9;
              const l = Math.hypot(wx, wz) || 1;
              wx /= l;
              wz /= l;
              speed = def.run * 0.8;
            } else if (def.temper === 'pack' && d > 4) {
              // Surround: each comes in on its own line, to one side or the other, not single file down the same track.
              const off = ((a.id % 3) - 1) * Math.min(5, d * 0.35);
              toward(a.tx - uz * off, a.tz + ux * off);
            }
            // A dog slows to bite range; a bear charges to the end.
            if (d < 1.2) speed = 0;
          }
          break;
        case 'stalk': {
          // Circle at about nine metres, closing slowly, until the pack springs.
          const dx = a.x - a.tx;
          const dz = a.z - a.tz;
          const d = Math.hypot(dx, dz) || 1;
          const side = a.id % 2 ? 1 : -1;
          wx = (-dz / d) * side * 0.9 + (dx / d) * (d > 9 ? -0.7 : 0.25);
          wz = (dx / d) * side * 0.9 + (dz / d) * (d > 9 ? -0.7 : 0.25);
          const l = Math.hypot(wx, wz) || 1;
          wx /= l;
          wz /= l;
          speed = def.walk * 2.4;
          break;
        }
        case 'windup': {
          const d = toward(a.tx, a.tz);
          wx = wz = 0;
          if (d) a.yaw += wrapAngle(Math.atan2(a.tx - a.x, a.tz - a.z) - a.yaw) * Math.min(1, dt * 7);
          if (a.stateT > 0.75) {
            a.state = 'charge';
            a.stateT = 0;
            const l = Math.hypot(a.tx - a.x, a.tz - a.z) || 1;
            a.dirX = (a.tx - a.x) / l;
            a.dirZ = (a.tz - a.z) / l;
          }
          break;
        }
        case 'charge': {
          // Mostly straight; a little steering toward a moving target.
          const l = Math.hypot(a.tx - a.x, a.tz - a.z) || 1;
          a.dirX += ((a.tx - a.x) / l - a.dirX) * dt * 0.9;
          a.dirZ += ((a.tz - a.z) / l - a.dirZ) * dt * 0.9;
          const n = Math.hypot(a.dirX, a.dirZ) || 1;
          wx = a.dirX / n;
          wz = a.dirZ / n;
          speed = def.run;
          if (a.stateT > 2.4) {
            a.state = 'rest';
            a.stateT = 0;
          }
          break;
        }
        case 'rest':
          break;
        default:
          break;
      }
    }
    speed *= a.moveMult;
    // Separation from its own kind.
    let sx = 0;
    let sz = 0;
    for (const o of this.grid) {
      if (o === a) continue;
      const dx = a.x - o.x;
      const dz = a.z - o.z;
      const rr = (def.radius * def.size + o.def.radius * o.def.size) * 1.1;
      const d2 = dx * dx + dz * dz;
      if (d2 < rr * rr && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        sx += (dx / d) * (rr - d);
        sz += (dz / d) * (rr - d);
      }
    }
    const wet = ctx.waterAt(a.x + wx * 0.8, a.z + wz * 0.8);
    if (wet && wet.depth > 0.6) {
      speed = 0;
      if (a.state === 'flee') {
        // Turn along the shore.
        const sw = wx;
        wx = -wz;
        wz = sw;
      }
    } else if (wet && wet.depth > 0.25) speed *= 0.6;
    a.vx = damp(a.vx, wx * speed, a.state === 'charge' ? 3 : 9, dt);
    a.vz = damp(a.vz, wz * speed, a.state === 'charge' ? 3 : 9, dt);
    const p = { x: a.x + a.vx * dt + sx * 0.4, z: a.z + a.vz * dt + sz * 0.4 };
    const hit = ctx.obs.resolveCircle(p, def.radius * def.size, undefined, a.y);
    // A charge that meets a wall is a stunned boar.
    if (hit && a.state === 'charge' && Math.hypot(a.vx, a.vz) > 3) {
      a.state = 'rest';
      a.stateT = 0;
      a.vx = a.vz = 0;
      ctx.audio.play('thud', a.x, a.z, 0.7);
    }
    a.x = p.x;
    a.z = p.z;
    const spd = Math.hypot(a.vx, a.vz);
    if (spd > 0.25 && a.state !== 'windup') a.yaw += wrapAngle(Math.atan2(a.vx, a.vz) - a.yaw) * Math.min(1, dt * (a.state === 'charge' ? 4 : 9));
    a.gait = damp(a.gait, clamp(spd / def.run, 0, 1), 10, dt);
    a.phase += dt * (spd > 0.2 ? 2.6 + spd * 1.5 : 0);
    if (a.state === 'windup') a.phase += dt * 14;
    this.attack(a, dt);
  }

  private fly(a: Animal, dt: number) {
    const ctx = this.ctx;
    const o = a.orbit;
    const speed = (a.def.walk / Math.max(8, o.r)) * o.dir;
    if (a.state === 'land' || a.state === 'feed') {
      const ground = ctx.groundAt(a.x, a.z);
      if (a.state === 'land') {
        // Spiral in: close on the spot beside the carcass and let the height go as the distance does.
        const dx = a.tx - a.x;
        const dz = a.tz - a.z;
        const d = Math.hypot(dx, dz);
        const step = a.def.run * 0.9 * dt;
        if (d > step) {
          a.x += (dx / d) * step;
          a.z += (dz / d) * step;
          a.yaw += wrapAngle(Math.atan2(dx, dz) - a.yaw) * Math.min(1, dt * 5);
        } else {
          a.x = a.tx;
          a.z = a.tz;
        }
        a.y += (ground + 0.15 + Math.min(o.alt, d * 0.5) - a.y) * Math.min(1, dt * 2.2);
        a.flap += dt * (d > 4 ? 6 : 11);
        a.gait = 0.6;
        a.vx = a.vz = 0;
        if (d < 0.6 && a.y < ground + 0.6) {
          a.state = 'feed';
          a.stateT = 0;
        }
        return;
      }
      // Down: hop about and peck, facing the body.
      a.y += (ground + 0.15 - a.y) * Math.min(1, dt * 8);
      if (a.feedOn) a.yaw += wrapAngle(Math.atan2(a.feedOn.x - a.x, a.feedOn.z - a.z) - a.yaw) * Math.min(1, dt * 3);
      a.vx = a.vz = 0;
      a.gait = 0;
      return;
    }
    if (a.state === 'flee') {
      // Beat away from the fright, climbing.
      const dx = a.x - a.fearX;
      const dz = a.z - a.fearZ;
      const d = Math.hypot(dx, dz) || 1;
      a.vx = damp(a.vx, (dx / d) * a.def.run, 3, dt);
      a.vz = damp(a.vz, (dz / d) * a.def.run, 3, dt);
      a.x += a.vx * dt;
      a.z += a.vz * dt;
      a.yaw += wrapAngle(Math.atan2(a.vx, a.vz) - a.yaw) * Math.min(1, dt * 4);
      a.y += (ctx.groundAt(a.x, a.z) + o.alt + 8 - a.y) * Math.min(1, dt * 0.8);
      a.flap += dt * 11;
      a.gait = 1;
      return;
    }
    o.a += speed * dt;
    const tx = o.cx + Math.cos(o.a) * o.r;
    const tz = o.cz + Math.sin(o.a) * o.r;
    // Ease onto the circle so a bird that has just been spooked does not snap back to it.
    const dx = tx - a.x;
    const dz = tz - a.z;
    const d = Math.hypot(dx, dz);
    const step = a.def.run * 1.4 * dt;
    const ox = a.x;
    const oz = a.z;
    if (d > step) {
      a.x += (dx / d) * step;
      a.z += (dz / d) * step;
    } else {
      a.x = tx;
      a.z = tz;
    }
    a.vx = (a.x - ox) / Math.max(dt, 1e-3);
    a.vz = (a.z - oz) / Math.max(dt, 1e-3);
    if (Math.hypot(a.vx, a.vz) > 0.5) a.yaw += wrapAngle(Math.atan2(a.vx, a.vz) - a.yaw) * Math.min(1, dt * 5);
    const wantY = ctx.groundAt(a.x, a.z) + o.alt + Math.sin(a.id + ctx.time * 0.7) * 1.2;
    a.y += (wantY - a.y) * Math.min(1, dt * 1.5);
    // Mostly gliding, with the odd few flaps.
    const flapping = Math.sin(ctx.time * 0.35 + a.id * 1.7) > 0.55;
    a.flap += dt * (flapping ? 7 : 1.2);
    a.gait = 0.5;
  }

  // ------------------------------------------------------------------ body language

  /** Ease the pose toward what it is doing: head down to graze, up to watch, low to charge, the front lifted to warn. */
  private animate(a: Animal, dt: number) {
    const t = this.ctx.time;
    let head = 0;
    let look = 0;
    let rear = 0;
    let fold = 0;
    if (a.flying) {
      fold = a.state === 'feed' ? 1 : a.state === 'land' ? 0.35 : 0;
    } else {
      const scan = Math.sin(t * 0.8 + a.id * 2.1);
      const down = HEAD_DOWN[a.kind];
      switch (a.state) {
        case 'idle': {
          // Head down for most of a cycle, up now and then to look about.
          const cyc = (t * 0.2 + a.id * 0.37) % 1;
          if (cyc < 0.72) head = down;
          else {
            head = -0.22;
            look = scan * 0.8;
          }
          break;
        }
        case 'wander':
          head = 0.1 + Math.sin(a.phase * 0.5) * 0.08;
          look = scan * 0.15;
          break;
        case 'alert':
          head = a.kind === 'bear' ? -0.15 : a.kind === 'deer' ? -0.2 : -0.5;
          rear = a.kind === 'bear' ? 0.85 : 0;
          look = clamp(wrapAngle(Math.atan2(a.fearX - a.x, a.fearZ - a.z) - a.yaw) * 0.6, -0.8, 0.8);
          break;
        case 'flee':
          head = a.kind === 'deer' ? -0.12 : 0.12;
          break;
        case 'chase':
          head = a.kind === 'bear' ? 0.25 : 0.05;
          break;
        case 'stalk':
          head = 0.5;
          look = scan * 0.1;
          break;
        case 'windup':
          // Lowering the tusks and pawing the ground.
          head = 0.6 + Math.sin(a.stateT * 18) * 0.08;
          break;
        case 'charge':
          head = 0.5;
          break;
        case 'rest':
          head = 0.3;
          break;
        case 'feed':
          head = HEAD_DOWN[a.kind] * 1.1 + Math.sin(t * 5 + a.id) * 0.12;
          break;
      }
    }
    const k = Math.min(1, dt * (a.state === 'alert' || a.state === 'flee' ? 9 : 4));
    a.head += (head - a.head) * k;
    a.look += (look - a.look) * k;
    a.rear += (rear - a.rear) * Math.min(1, dt * 3);
    a.fold += (fold - a.fold) * Math.min(1, dt * 4);
  }

  // ------------------------------------------------------------------ attacks

  private attack(a: Animal, dt: number) {
    const ctx = this.ctx;
    const def = a.def;
    const dmg = def.damage;
    if (!dmg) return;
    const t = def.temper;
    const hunting = a.state === 'chase' || a.state === 'charge';
    if (!hunting || a.stun > 0) return;
    const reach = def.radius * def.size + 0.7;
    // People on foot.
    if (a.attackCd <= 0) {
      for (const p of ctx.players) {
        if (p.state !== 'foot' && p.state !== 'downed') continue;
        if (p.invuln > 0) continue;
        if (Math.hypot(p.pos.x - a.x, p.pos.z - a.z) > reach) continue;
        const [cd, k] = t === 'brute' ? [1.3, 1] : t === 'charger' ? [1.2, 1] : [1.0, 1];
        a.attackCd = cd;
        p.hurt(dmg * k, a.x, a.z, t === 'charger' ? 'ram' : 'bite');
        ctx.fx.blood(p.pos.x, p.pos.y + 1, p.pos.z, 3);
        ctx.audio.play(t === 'pack' ? 'yelp' : 'thud', a.x, a.z, 0.7);
        p.cam.addShake(0.12);
        ctx.input.rumble(p.index, 0.3, 0.4, 80);
        if (t === 'charger') {
          // A hit knocks the boar back on its heels.
          a.state = 'rest';
          a.stateT = 0;
          a.vx *= -0.2;
          a.vz *= -0.2;
        } else if (t === 'pack') {
          // Bite and dart back, so a pack worries at you instead of sitting on you.
          const l = Math.hypot(a.x - p.pos.x, a.z - p.pos.z) || 1;
          a.vx += ((a.x - p.pos.x) / l) * 3;
          a.vz += ((a.z - p.pos.z) / l) * 3;
          a.retreatT = 0.5 + Math.random() * 0.5;
          a.packSide = Math.random() < 0.5 ? 1 : -1;
        }
        return;
      }
    }
    // Vehicles: boars ram them, bears maul them. Dogs only bark.
    if ((t === 'charger' || t === 'brute') && a.attackCd <= 0) {
      for (const v of ctx.vehicles) {
        if (v.wreck) continue;
        const d = Math.hypot(v.position.x - a.x, v.position.z - a.z);
        if (d > v.def.length * 0.5 + def.radius * def.size + 0.5) continue;
        a.attackCd = t === 'brute' ? 1.6 : 1.5;
        v.takeHit(def.vehicleDamage ?? 15, a.x, a.z, { ram: true, smash: true });
        const dx = v.position.x - a.x;
        const dz = v.position.z - a.z;
        const l = Math.hypot(dx, dz) || 1;
        v.shove((dx / l) * v.mass * (t === 'brute' ? 0.5 : 0.35), (dz / l) * v.mass * (t === 'brute' ? 0.5 : 0.35));
        ctx.audio.play('crash', a.x, a.z, 0.7);
        if (t === 'charger') {
          this.damage(a, 6 + v.speed, { fromX: v.position.x, fromZ: v.position.z });
          a.state = 'rest';
          a.stateT = 0;
        }
        break;
      }
    }
    void dt;
  }

  // ------------------------------------------------------------------ rendering

  render(ar: AnimalRenderer, frustums: THREE.Frustum[], maxPerView: number, camPos: THREE.Vector3[]) {
    ar.begin();
    const sp = new THREE.Vector3();
    const budget = maxPerView;
    let drawn = 0;
    const live = this.list.filter((a) => a.active || a.dead);
    const dist = (a: Animal) => {
      let m = Infinity;
      for (const c of camPos) m = Math.min(m, (c.x - a.x) ** 2 + (c.z - a.z) ** 2);
      return m;
    };
    live.sort((a, b) => dist(a) - dist(b));
    for (const a of live) {
      if (drawn >= budget) break;
      sp.set(a.x, a.y + a.height * 0.5, a.z);
      let seen = false;
      for (const f of frustums) {
        if (f.containsPoint(sp)) {
          seen = true;
          break;
        }
        sp.y = a.y + a.height;
        if (f.containsPoint(sp)) {
          seen = true;
          break;
        }
        sp.y = a.y;
        if (f.containsPoint(sp)) {
          seen = true;
          break;
        }
        sp.y = a.y + a.height * 0.5;
      }
      if (!seen) continue;
      drawn++;
      const sink = a.dead ? Math.max(0, a.deadT - (a.keepFor - 3)) * 0.2 : 0;
      const roll = a.dead ? a.fall * (Math.PI / 2) * (a.id % 2 ? 1 : -1) * 0.95 : 0;
      // Lying on its side puts the body a little off the ground, not through it.
      const lift = a.dead && !a.flying ? a.fall * 0.04 : 0;
      const bank = a.flying && !a.dead ? a.orbit.dir * -0.35 : 0;
      _pose.mask = a.wounds.mask;
      _pose.head = a.dead ? 0.15 : a.head;
      _pose.look = a.dead ? 0 : a.look;
      _pose.rear = a.dead ? 0 : a.rear;
      _pose.fold = a.dead ? 0 : a.fold;
      ar.push(a.kind, a.def.size, a.x, a.y - sink + lift, a.z, a.yaw, a.phase, a.dead ? 0 : a.gait, roll, a.dead ? 0.2 : a.flap, bank, a.tint, _pose);
    }
    ar.end();
  }
}
