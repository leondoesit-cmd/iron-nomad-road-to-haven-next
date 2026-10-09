import * as THREE from 'three';
import { Nearest } from '../core/nearest';
import { WILDLIFE, t, type AnimalDef, type AnimalKind } from '../data';
import { clamp, damp, smoothstep, wrapAngle } from '../core/math';
import { Rng } from '../core/rng';
import { animalSpeedMult, animalZoneOf, LEGS, newAnimalWounds, PART_BIT, partsGone, woundAnimal, type AnimalPart, type AnimalWounds, type AnimalZone } from '../sim/anatomy';
import { damageFraction, staggerSpeed, type AmmoSpec } from '../sim/ballistics';
import type { AnimalPose, AnimalRenderer } from '../render/animalRender';
import type { Ctx } from './ctx';
import type { Player } from './player';
import type { Vehicle } from './vehicle';
import { MELEE, knockFor, type MeleeFeel } from '../sim/weaponfx';
import { forestAt, lushAt, wetReach } from '../world/hydro';
import { windAt } from '../sim/weather';
import { BED, carcassYield, hitLine, notice, SHOT, STALK, stepAwareness, torsoPart, type KillCause, type TorsoPart } from '../sim/hunting';

/**
 * How a species takes to the green country of the open world, as multipliers on its weight: on bare dust, on meadow and in
 * the woods (blended by how lush and how wooded the spot is). A `wild` one lives in the woods whatever the land's theme,
 * and only there. Read from `wildlife.json`; species without it do not care.
 */
interface LandTaste {
  bare: number;
  meadow: number;
  wood: number;
  wild?: boolean;
  /** Multiplier on its weight right by the water (rivers, lakes, springs, swamps), easing to 1 away from it. */
  water?: number;
  /** Lives only by water: never picked where there is none close. */
  needWater?: boolean;
}
const tasteOf = (d: AnimalDef) => (d as AnimalDef & { land?: LandTaste }).land;
const nerveOf = (d: AnimalDef) => d.nerve ?? 1;
/** Tempers that walk down to the water to drink. */
const DRINKERS = new Set(['prey', 'pack', 'scavenger', 'brute', 'charger']);

/**
 * idle: grazing or standing about. alert: head up, frozen, watching something it does not trust yet (prey) or warning it off
 * (a bear). feed: head down over a carcass. land: a bird coming down to one.
 */
export type AState = 'idle' | 'wander' | 'alert' | 'flee' | 'chase' | 'stalk' | 'windup' | 'charge' | 'rest' | 'fly' | 'land' | 'feed' | 'drink' | 'bed';

/**
 * Where a swept blade lands on a beast (`game/bladeSwing.ts`): the world point, the way the edge was going, the part, how
 * far through that part the cut has got over every stroke (0..1), and whether this stroke finished it.
 */
export interface AnimalStrike {
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  zone: AnimalZone;
  depth: number;
  through: boolean;
}

/** Seconds between a ground animal's thoughts (see `update`): what its awareness steps by. */
const THINK = 0.08;

/** Standing height of each species, for shots and the frustum test (metres, before scale). */
const HEIGHT: Record<AnimalKind, number> = {
  hare: 0.35,
  deer: 1.3,
  vulture: 0.4,
  dog: 0.7,
  wolf: 0.9,
  boar: 0.85,
  bear: 1.6,
  ibex: 1.05,
  camel: 2.1,
  fox: 0.45,
  jackal: 0.6,
  buffalo: 1.55,
  heron: 1.0,
  stork: 1.05,
  duck: 0.3,
  crow: 0.3,
  egret: 0.75,
};

/** How far each species lowers its head to graze or to eat (radians): a deer's neck is long, a boar's head hangs low already. */
const HEAD_DOWN: Record<AnimalKind, number> = {
  hare: 0.6,
  deer: 1.3,
  vulture: 0,
  dog: 0.8,
  wolf: 0.8,
  boar: 0.5,
  bear: 0.75,
  ibex: 1.1,
  camel: 1.0,
  fox: 0.9,
  jackal: 0.85,
  buffalo: 0.6,
  heron: 1.1,
  stork: 1.2,
  duck: 0.6,
  crow: 0.9,
  egret: 1.15,
};

let aid = 1;
const _pose: AnimalPose = {};

/** What the carcass gives up: rations by how it died and how it was shot, and hides. */
function yieldOf(a: Animal) {
  return carcassYield({ meat: a.def.meat, legsGone: partsGone(a.wounds.mask).legs, tainted: a.tainted, hits: a.hits, cause: a.cause, clean: a.clean, eaten: a.eaten }, a.kind);
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
  /** The cooldown the last attack set (`attackCd` counts down from it), so a model can play the strike through. */
  attackFor = 0;
  /** Render-only: the last flap phase seen and when, and the smoothed wing-beat rate (rad/s) for gliding. */
  rFlap = NaN;
  rT = 0;
  flapRate = 8;
  /** Render-only: seconds left of flinching from a hit, and the side it came from (+1 its left, -1 its right). */
  hitT = 0;
  hitSide = 1;
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
  /**
   * A wader or a swimmer on the wing: it flies point to point (from where it took off to where it will come down, over
   * `alt` at the top of the arc), `s` being how far along it is. `water`: it comes down on water.
   */
  air = false;
  hop = { x0: 0, z0: 0, y0: 0, tx: 0, tz: 0, y1: 0, alt: 8, len: 1, s: 0, water: false };
  /** Seconds left of a heron's stab at a fish or a fox's pounce, and of a duck up-ending to feed; `tip` is how far it is up. */
  strike = 0;
  dabble = 0;
  tip = 0;
  /** Seconds to its next call, and whether the next is part of a chorus (jackals answering their leader). */
  callT = 4 + Math.random() * 20;
  chorus = false;
  /** A foraging crow: seconds to its next hop. */
  hopT = 0;
  /** Seconds until it next wants a drink; on its way to the water; how long it drinks; the water it faces. */
  drinkT = 30 + Math.random() * 150;
  /** Seconds it keeps walking off without stopping to stare again at what it is walking away from. */
  calmT = 0;
  /**
   * Hunting (see `sim/hunting.ts`): how sure it is that someone is stalking it (0 to a little over 1), which seat, and
   * whether it has their scent. Rounds that struck it, a gut shot, what killed it and whether cleanly, and how long
   * scavengers have been eating the carcass.
   */
  aware = 0;
  awareOf = -1;
  smelled = false;
  hits = 0;
  tainted = false;
  cause: KillCause = 'shot';
  clean = false;
  eaten = 0;
  /** When the shooter was last told about a hit on it, so a burst does not fill the notes. */
  notedT = -99;
  drinking = false;
  drinkFor = 8;
  wx = 0;
  wz = 0;

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
    return this.def.temper === 'bird' || this.air;
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
  /** How fast a vehicle is coming straight at it (m/s; negative going away, 0 passing by). */
  closing: number;
}

let herdId = 1;

export class WildlifeSystem {
  private renderNearest = new Nearest<Animal>();
  private renderPoint = new THREE.Vector3();
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

  /**
   * For the HUD while stalking on foot: of the game near this player (prey within `r`), how aware the most watchful one is
   * of them and whether it has their scent; null when there is nothing near to stalk. `aware` is 0 unseen to 1 known.
   */
  stalkView(p: Player, r = 110): { aware: number; smelled: boolean; fleeing: boolean; name: string } | null {
    let best: Animal | null = null;
    let near = false;
    for (const a of this.list) {
      if (a.dead || !a.active || a.def.temper !== 'prey') continue;
      if (Math.abs(a.x - p.pos.x) > r || Math.abs(a.z - p.pos.z) > r || Math.hypot(a.x - p.pos.x, a.z - p.pos.z) > r) continue;
      near = true;
      const mine = a.awareOf === p.index ? a.aware : 0;
      if (!best || mine > (best.awareOf === p.index ? best.aware : 0)) best = a;
    }
    if (!near || !best) return null;
    const mine = best.awareOf === p.index;
    return { aware: mine ? Math.min(1, best.aware) : 0, smelled: mine && best.smelled, fleeing: mine && best.state === 'flee', name: best.def.name };
  }

  forEachNear(x: number, z: number, r: number, fn: (a: Animal) => void) {
    const r2 = r * r;
    for (const a of this.list) if (!a.dead && (a.x - x) ** 2 + (a.z - z) ** 2 <= r2) fn(a);
  }

  // ------------------------------------------------------------------ ambient population

  /**
   * Which species turns up, weighted by the land, the day and the leg. `land` is how lush and how wooded the spot is, in the
   * open world's green country: hares and antelope crowd the meadows, wolves, hogs and bears keep to the woods, and the
   * vultures have the bare dust.
   */
  pickKind(biome: 'wasteland' | 'city', theme: string, legIndex: number, land?: { lush: number; wood: number; near?: number }): AnimalKind | null {
    const night = this.ctx.night;
    let total = 0;
    const opts: [AnimalKind, number][] = [];
    for (const k in WILDLIFE.species) {
      const d = WILDLIFE.species[k as AnimalKind];
      if (!d.biomes.includes(biome) || d.legs > legIndex) continue;
      // Ducks come with the water itself (see `ambient`), not with the land.
      if (d.temper === 'swimmer') continue;
      const taste = land ? tasteOf(d) : undefined;
      const near = land?.near ?? 0;
      if (tasteOf(d)?.needWater && near < 0.05) continue;
      const wildHere = !!taste?.wild && land!.wood > 0.25;
      if (!d.themes.includes(theme as 'dust') && !wildHere) continue;
      let w = d.weight;
      if (taste && land) {
        const open = taste.bare + (taste.meadow - taste.bare) * land.lush;
        w *= d.themes.includes(theme as 'dust') ? open + (taste.wood - open) * land.wood : taste.wood * land.wood;
        if (taste.water) w *= 1 + (taste.water - 1) * near;
      }
      if (d.nocturnal) w *= 0.35 + night * 1.6;
      else if (d.temper === 'pack') w *= 1 + night * 1.4;
      else if (d.temper === 'prey') w *= 1 - night * 0.65;
      else if (d.temper === 'bird' || d.temper === 'wader') w *= 1 - night * 0.9;
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
      if (w && w.depth > 0.1) {
        // Open water: a raft of ducks, if the water is deep and slow enough to sit on.
        const fast = w.flow ? Math.hypot(w.flow[0], w.flow[1]) > 1.3 : false;
        if (w.depth > 0.45 && !fast && this.allowed('duck', biome, theme, legIndex) && this.rng.next() < 0.55) {
          if (this.ctx.visibleToAnyView(x, w.level + 0.5, z, 6)) continue;
          this.spawnOnWater('duck', x, z);
          return;
        }
        continue;
      }
      if (this.ctx.visibleToAnyView(x, this.ctx.groundAt(x, z) + 1, z, 6)) continue;
      // In the green country the land decides what lives there, and bare dust holds less of anything.
      const T = this.ctx.terrain;
      const land = T?.hydro?.lush ? { lush: lushAt(T, x, z), wood: forestAt(T, x, z), near: smoothstep(20, 80, wetReach(T, x, z)) } : undefined;
      if (land && land.lush < 0.15 && land.near < 0.3 && this.rng.next() < 0.45 * (1 - land.lush / 0.15)) return;
      const kind = this.pickKind(biome, theme, legIndex, land);
      if (!kind) return;
      // Herons and buffalo live in the water's edge: move the spawn down to it.
      const def = WILDLIFE.species[kind];
      if (tasteOf(def)?.needWater) {
        const deep = kind === 'buffalo' ? [0.15, 0.9] : [0.05, Math.min(0.4, def.wade ?? 0.4)];
        const s = this.waterSpot(x, z, 4, 70, deep[0], deep[1]);
        if (!s || this.ctx.visibleToAnyView(s.x, s.level + 1, s.z, 6)) return;
        this.spawnGroup(kind, s.x, s.z);
        return;
      }
      this.spawnGroup(kind, x, z);
      return;
    }
  }

  /** May this species turn up here at all (its biomes, the land's theme, how far along the road)? */
  allowed(kind: AnimalKind, biome: 'wasteland' | 'city', theme: string, legIndex: number) {
    const d = WILDLIFE.species[kind];
    if (!d.biomes.includes(biome) || d.legs > legIndex || !d.themes.includes(theme as 'dust')) return false;
    let have = 0;
    for (const a of this.list) if (a.kind === kind && !a.dead) have++;
    return have < d.cap;
  }

  /**
   * A point of water `minD..maxD` deep and slow enough to sit on, `r0..r1` metres from (x, z), or null. With `away` the search
   * leans to the side away from that point (somewhere to flee to).
   */
  waterSpot(x: number, z: number, r0: number, r1: number, minD: number, maxD: number, away?: { x: number; z: number }) {
    const base = away ? Math.atan2(z - away.z, x - away.x) : 0;
    for (let k = 0; k < 18; k++) {
      const ang = away && k < 12 ? base + this.rng.range(-1.1, 1.1) : this.rng.range(0, 6.283);
      const r = this.rng.range(r0, r1);
      const px = x + Math.cos(ang) * r;
      const pz = z + Math.sin(ang) * r;
      const w = this.ctx.waterAt(px, pz);
      if (!w || w.depth < minD || w.depth > maxD) continue;
      if (w.flow && Math.hypot(w.flow[0], w.flow[1]) > 1.4) continue;
      return { x: px, z: pz, level: w.level };
    }
    return null;
  }

  /** A raft of swimmers on open water around (x, z): each sits at the surface. */
  spawnOnWater(kind: AnimalKind, x: number, z: number) {
    const def = WILDLIFE.species[kind];
    const n = this.rng.int(def.group[0], def.group[1]);
    const herd = herdId++;
    const out: Animal[] = [];
    for (let i = 0; i < n; i++) {
      const a = this.rng.range(0, 6.28);
      const r = this.rng.range(0.6, 2 + n * 0.6);
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      const w = this.ctx.waterAt(px, pz);
      if (!w || w.depth < 0.3) continue;
      const d = this.spawn(kind, px, pz, herd);
      d.y = w.level;
      out.push(d);
    }
    return out;
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
      // Bedded down it is half its standing height.
      const hi = a.flying ? a.y + 0.4 : a.y + a.height * (a.state === 'bed' ? 0.55 : 1);
      if (yy < lo || yy > hi) continue;
      if (!best || tt < best.dist) best = { animal: a, dist: tt };
    }
    return best;
  }

  damage(a: Animal, amount: number, info: { fromX: number; fromZ: number; killer?: number; fire?: boolean; explosive?: boolean; vehicle?: boolean; blade?: boolean }): boolean {
    if (a.dead) return false;
    a.hp -= amount;
    a.hitT = 0.6;
    // Its left is +x of its own frame (it faces +z at yaw 0).
    a.hitSide = Math.cos(a.yaw) * (info.fromX - a.x) - Math.sin(a.yaw) * (info.fromZ - a.z) >= 0 ? 1 : -1;
    if (info.killer !== undefined && info.killer >= 0) a.lastKiller = info.killer;
    if (a.hp <= 0) {
      a.cause = info.explosive ? 'blast' : info.fire ? 'fire' : info.vehicle ? 'vehicle' : info.blade ? 'blade' : 'shot';
      this.kill(a, info.killer ?? -1);
      return true;
    }
    const ctx = this.ctx;
    if (!info.fire) {
      ctx.fx.blood(a.x, a.y + a.height * 0.6, a.z, 2);
      ctx.audio.play(this.cry(a), a.x, a.z, 0.8);
    }
    this.provoke(a, info.fromX, info.fromZ, info.killer ?? -1);
    return false;
  }

  /** The sound it makes when it is hurt. */
  private cry(a: Animal): 'caw' | 'yelp' | 'quack' | 'bellow' {
    const t = a.def.temper;
    if (t === 'bird' || t === 'wader') return 'caw';
    if (t === 'swimmer') return 'quack';
    if (a.kind === 'buffalo' || a.kind === 'camel') return 'bellow';
    return 'yelp';
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
    // Where in the body it went: the heart and lungs drop it, the gut is a long track and spoiled meat.
    const part: TorsoPart | 'head' | 'leg' = zone === 'torso' ? torsoPart(a.kind, fwd, relY, a.def.size) : zone === 'head' ? 'head' : 'leg';
    const shot = SHOT[part];
    const dmg = h.dmg * shot.mul;
    a.hits++;
    if (shot.taint) a.tainted = true;
    // Dropped where it stood by a head or heart-lung shot (set before the kill, which writes the carcass's prompt).
    a.clean = (part === 'head' || part === 'vitals') && a.hits <= 2 && a.hp - dmg <= 0;
    const killed = this.damage(a, dmg, { fromX: h.fromX, fromZ: h.fromZ, killer: h.killer });
    if (!killed && !a.flying) {
      // It runs on with a hole in it, bleeding, and leaves a trail to follow.
      a.wounds.bleed += a.def.hp * shot.bleed * Math.min(1.5, dmg / Math.max(1, a.def.hp * 0.4));
      if (h.killer >= 0 && this.ctx.time - a.notedT > 2.5) {
        a.notedT = this.ctx.time;
        this.ctx.notify(h.killer, hitLine(part, a.def.name), 'info');
      }
    }
    const mass = Math.max(4, a.def.hp * 0.9 * a.def.size ** 3);
    this.shove(a, h.dx, h.dz, Math.min(5, staggerSpeed(h.spec, h.speed, mass) * damageFraction(h.speed / h.spec.speed)));
    const res = woundAnimal(a.wounds, a.kind, zone, dmg * h.spec.gore, a.def.hp, killed, this.ctx.rng.next());
    if (res.off.length) {
      this.refreshWounds(a);
      if (res.fatal && !a.dead) {
        a.clean = part === 'head' && a.hits <= 2;
        this.kill(a, h.killer);
      }
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
    const timid = tmp === 'prey' || tmp === 'bird' || tmp === 'wader' || tmp === 'swimmer' || tmp === 'scavenger';
    if (timid || wounded) {
      this.scare(a, fromX, fromZ);
      if (!timid) a.stateT = -2;
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
    const cry = this.cry(a);
    ctx.audio.play(cry === 'yelp' && a.def.temper !== 'prey' && a.def.temper !== 'scavenger' ? 'growl' : cry, a.x, a.z, 0.9);
    if (a.flying) {
      // Shot out of the air: it falls to the ground, or floats where it falls on water.
      const w = ctx.waterAt(a.x, a.z);
      a.y = w ? w.level - 0.04 : ctx.groundAt(a.x, a.z) + (a.kind === 'vulture' ? 0.15 : 0);
      a.air = false;
    }
    if (a.def.meat > 0) this.leaveCarcass(a);
    if (a.def.temper === 'pack') this.morale(a, killer);
    // A quiet kill does not send the herd off: they throw their heads up and stare toward the shooter, and a patient hunter
    // who stays still can take another.
    if (a.def.temper === 'prey' && killer >= 0) {
      const p = this.ctx.players[killer];
      for (const o of this.list) {
        if (o.dead || o.herd !== a.herd || o.state === 'flee') continue;
        o.aware = Math.max(o.aware, 0.55);
        o.awareOf = killer;
        if (p) this.alertHerd(o, p.pos.x, p.pos.z);
      }
    }
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

  /** Scavengers eat a carcass away: it is gone sooner for whoever was going to butcher it, and there is less on it. */
  gnaw(a: Animal, seconds: number) {
    if (a.dead && !a.butchered) {
      a.deadT += seconds;
      a.eaten += seconds;
    }
  }

  private butcherTime(a: Animal) {
    const y = yieldOf(a);
    return 0.8 + y.rations * 0.25 + y.hides * 0.6;
  }

  /** What the knife will get off it, for the prompt. */
  private carcassPrompt(a: Animal) {
    const y = yieldOf(a);
    const hide = y.hides ? `, ${y.hides} hide${y.hides > 1 ? 's' : ''}` : '';
    return `Hold to butcher ${a.def.name} (${y.rations} rations${hide})`;
  }

  /** The kill leaves a carcass to hold A on. Without an interact registry (tests) it is taken on the spot. */
  private leaveCarcass(a: Animal) {
    const ctx = this.ctx;
    if (!ctx.interact) {
      this.butcher(a, null);
      return;
    }
    a.keepFor = WILDLIFE.rules.corpseSeconds * 2;
    const ix = ctx.interact.add({
      id: `carcass:${a.id}`,
      x: a.x,
      z: a.z,
      r: 2.4,
      prompt: this.carcassPrompt(a),
      dur: this.butcherTime(a),
      priority: 1,
      enabled: () => {
        // Scavengers at it change what is left, so the prompt is read fresh.
        ix.prompt = this.carcassPrompt(a);
        return a.dead && !a.butchered;
      },
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
    // Meat is food and nothing else: no abstract Scrap comes off a carcass. Hides go in the convoy's stores for the Ledger.
    const y = yieldOf(a);
    if (y.rations) ctx.addLoot({ rations: y.rations }, 'hunt');
    const items = ctx.campaign.items as { hides?: number } | undefined;
    if (y.hides && items) items.hides = (items.hides ?? 0) + y.hides;
    ctx.fx.blood(a.x, a.y + 0.3, a.z, 3);
    ctx.audio.play('pickup', a.x, a.z, 0.8);
    const extra = (y.hides ? t('hunt.hides', { n: y.hides, s: y.hides > 1 ? 's' : '' }) : '') + (y.notes.length ? ` (${y.notes.join(', ')})` : '');
    ctx.notify(-1, t('hunt.meat', { name: a.def.name, n: y.rations }) + extra, y.rations ? 'good' : 'info');
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

  /**
   * `cut` is how well the weapon takes limbs off (see `cutOf`): a blade takes a leg or the head, a bat only breaks. A swing
   * swept through the world (`strikeOf`, see `game/bladeSwing.ts`) says which beasts the edge crossed, the part it landed
   * on and how far through that part the cut has got; one that finishes the cut takes the part off.
   */
  meleeHit(p: Player, hx: number, hz: number, yaw: number, reach: number, dmg: number, feel: MeleeFeel = MELEE.fist, cut = 0, strikeOf?: (a: Animal) => AnimalStrike | null): number {
    let hit = 0;
    for (const a of this.list) {
      if (a.dead || a.flying) continue;
      const dx = a.x - p.pos.x;
      const dz = a.z - p.pos.z;
      const d = Math.hypot(dx, dz);
      const strike = strikeOf ? strikeOf(a) : null;
      if (strikeOf && !strike) continue;
      if (!strike) {
        if (d > reach + a.def.radius * a.def.size) continue;
        if (Math.abs(wrapAngle(Math.atan2(dx, dz) - yaw)) > 1.0) continue;
      }
      const dealt = dmg * (1 - a.def.armor);
      a.hits++;
      const killed = this.damage(a, dealt, { fromX: p.pos.x, fromZ: p.pos.z, killer: p.index, blade: true });
      // A blade opens it up; finishing a bedded animal with the knife is quiet and spoils nothing.
      if (!killed && cut > 0) a.wounds.bleed += a.def.hp * 0.02 * cut * (strike ? 0.4 + strike.depth : 1);
      if (strike) {
        // The edge went right through a leg, a wing or the neck: it comes off where the cut is.
        if (strike.through && strike.zone !== 'torso' && !(a.wounds.mask & PART_BIT[strike.zone])) {
          const res = woundAnimal(a.wounds, a.kind, strike.zone, a.def.hp * 4, a.def.hp, killed, this.ctx.rng.next());
          if (res.off.length) {
            this.refreshWounds(a);
            for (const part of res.off) this.ctx.gore?.severAnimal(a, part, strike.dx, 0.3 + Math.max(0, strike.dy), strike.dz, Math.max(1, (dealt * cut) / a.def.hp));
            if (res.fatal && !a.dead) this.kill(a, p.index);
          }
        }
      } else if (cut > 0) {
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
      // A beast is shoved by what it weighs: hp stands in for its mass.
      const push = knockFor(feel, Math.max(20, a.def.hp * 0.8)) * 0.8;
      a.vx += (dx / (d || 1)) * push;
      a.vz += (dz / (d || 1)) * push;
      a.stun = Math.max(a.stun, feel.stun * 0.8);
      hit++;
      if (hit >= feel.cleave) break;
    }
    if (hit) {
      this.ctx.fx.blood(hx, p.pos.y + 0.8, hz, 3);
      this.ctx.audio.play('thud', hx, hz, 0.6);
    }
    return hit;
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
      const killed = this.damage(a, dealt, { fromX: p.x, fromZ: p.z, killer, vehicle: true });
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
      // Anything on the wing finishes its flight, however far it takes it.
      a.active = near || a.air;
      if (!a.active) continue;
      a.attackCd -= dt;
      if (a.stun > 0) a.stun -= dt;
      a.stateT += dt;
      if (a.hitT > 0) a.hitT -= dt;
      a.drinkT -= dt;
      if (a.calmT > 0) a.calmT -= dt;
      if (a.burn > 0) {
        a.burn -= dt;
        if (ctx.fires) ctx.fires.hold(a, { x: a.x, y: a.y + a.height * 0.2, z: a.z, r: Math.max(0.14, a.height * 0.3), fuel: 'flesh', heat: Math.min(1, a.burn / 0.8), bed: false, light: 0.6, spreads: true });
        else if (Math.random() < 0.4) ctx.fx.fire(a.x, a.y + 0.4, a.z, 0.3);
        // Burning, it bolts: away from whatever it already runs from, else straight on (never "away" from its own feet,
        // which left it standing still in the flames).
        const fx = a.state === 'flee' ? a.fearX : a.x - Math.sin(a.yaw) * 10;
        const fz = a.state === 'flee' ? a.fearZ : a.z - Math.cos(a.yaw) * 10;
        this.damage(a, 6 * dt, { fromX: fx, fromZ: fz, fire: true, killer: a.lastKiller });
        if (a.dead) continue;
      }
      // An open wound bleeds it out, and leaves a trail to follow.
      if (a.wounds.bleed > 0) {
        // Lying still it bleeds slower. The harder it bleeds, the thicker the trail.
        a.hp -= a.wounds.bleed * dt * (a.state === 'bed' ? BED.bleed : 1);
        a.bleedT -= dt;
        if (a.bleedT <= 0) {
          const heavy = clamp(a.wounds.bleed / Math.max(1, a.def.hp * 0.05), 0, 1);
          a.bleedT = a.state === 'bed' ? 1.5 : 0.55 - heavy * 0.35;
          ctx.fx.blood(a.x, a.y + a.height * 0.4, a.z, 1);
          ctx.gore?.drip(a.x, a.z, (0.14 + Math.random() * 0.14) * (1 + heavy * 0.6));
        }
        if (a.hp <= 0) {
          a.cause = 'bleed';
          this.kill(a, a.lastKiller);
          // Something that ran off to die takes finding: it lies longer.
          a.keepFor = Math.max(a.keepFor, WILDLIFE.rules.corpseSeconds * 5);
          continue;
        }
      }
      if (a.state === 'feed' && a.feedOn) this.gnaw(a.feedOn, dt * 1.5);
      a.aiT -= dt;
      if (a.aiT <= 0) {
        a.aiT += a.flying ? 0.2 : 0.08;
        this.think(a);
      }
      if (a.air) this.flyTo(a, dt);
      else if (a.flying) this.fly(a, dt);
      else if (a.def.temper === 'swimmer') this.swim(a, dt);
      else this.walk(a, dt);
      if (a.def.call) this.callOut(a, dt);
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
      let closing = 0;
      if (inVeh) {
        const v = p.vehicle!;
        // A running engine is noticed out to its full sight, a quiet idle much nearer.
        sight *= v.speed > 1.5 ? 1 : 0.45;
        if (d > 0.5 && v.speed > 0.5) {
          const [fx, , fz] = v.body.forward();
          closing = (Math.abs(v.speed) * (fx * (a.x - px) + fz * (a.z - pz))) / d;
        }
      } else if (p.crouch) sight *= 0.5;
      if (d > sight) continue;
      if (!best || d < best.d) best = { x: px, z: pz, d, player: inVeh ? null : p, vehicle: inVeh ? p.vehicle : null, closing };
    }
    return best;
  }

  /** Nearest loud noise this animal can hear (gunfire, engines up close). */
  private heard(a: Animal, min: number) {
    const src = this.ctx.sig.loudestFor(a.x, a.z, false, 'noise');
    return src && src.level >= min ? src : null;
  }

  /** Where the dead are, if enough of them are moving within `r` to run from. Looked up a few times a second, not every think. */
  private scanZombies(a: Animal, r: number, min: number, huntingOnly = false) {
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
      const hunting = z.chasing || z.prey === a;
      if (d2 > r2 || (!hunting && (huntingOnly || d2 > r2 * 0.25))) continue;
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
      case 'scavenger':
        return this.thinkScavenger(a);
      case 'wader':
        return this.thinkWader(a);
      case 'swimmer':
        return this.thinkSwimmer(a);
    }
  }

  /**
   * Graze: stand about, drift to a nearby spot, stand again. A herd goes about it together: its leader picks a heading and
   * bends it slowly, and the rest stay in a loose ring around it instead of each wandering off on its own.
   */
  private graze(a: Animal, range = 7) {
    if (a.state === 'drink') {
      if (a.stateT > a.drinkFor) {
        a.state = 'idle';
        a.stateT = 0;
        a.idleFor = 1 + Math.random() * 3;
        a.drinking = false;
        a.drinkT = 90 + Math.random() * 200;
      }
      return;
    }
    if (a.state === 'idle') {
      if (a.stateT > a.idleFor && this.goDrink(a)) return;
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
        } else if (!this.wetTarget(a)) {
          a.migrate += (Math.random() - 0.5) * 1.3;
          // Grazers in dry country work their way toward water, a little at every move.
          const toWater = a.def.temper === 'prey' ? this.waterWay(a) : null;
          if (toWater !== null && Math.random() < 0.5) a.migrate += wrapAngle(toWater - a.migrate) * 0.5;
          const r = 2 + Math.random() * range * 1.2;
          a.tx = a.homeX + Math.cos(a.migrate) * r;
          a.tz = a.homeZ + Math.sin(a.migrate) * r;
        }
        a.hasTarget = true;
        a.state = 'wander';
        a.stateT = 0;
      }
    } else if (a.state === 'wander') {
      if (a.drinking) {
        // On the way down to the water: a long walk is allowed; there, it drinks.
        const d = Math.hypot(a.tx - a.x, a.tz - a.z);
        if (d < 1 || (a.stateT > 50 && d < 4)) {
          a.state = 'drink';
          a.stateT = 0;
          a.drinkFor = 5 + Math.random() * 9;
          a.hasTarget = false;
        } else if (a.stateT > 60) {
          a.drinking = false;
          a.state = 'idle';
          a.stateT = 0;
          a.drinkT = 40 + Math.random() * 80;
        }
        return;
      }
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
   * Animals of the water's edge choose where to go next by the water: a heron steps to another patch of shallows to fish, a
   * buffalo now and then goes down into the water to wallow. Sets the target and returns true, or false to graze as usual.
   */
  private wetTarget(a: Animal): boolean {
    let s: { x: number; z: number } | null = null;
    let strayed = false;
    if (a.kind === 'heron' && Math.random() < 0.8) s = this.waterSpot(a.homeX, a.homeZ, 2, 9, 0.04, 0.42) ?? this.waterSpot(a.x, a.z, 2, 30, 0.04, 0.42);
    else if (a.kind === 'buffalo') {
      // Strayed from the water: back toward it. By it: now and then down into it to wallow.
      strayed = !this.waterSpot(a.x, a.z, 0, 10, 0.02, 5);
      if (strayed) s = this.waterSpot(a.x, a.z, 5, 80, 0.3, 1.1);
      else if (Math.random() < 0.4) s = this.waterSpot(a.x, a.z, 3, 22, 0.3, 1.1);
    }
    if (!s) return false;
    // Far from the water, a herd drifts back down to it a few paces at a time.
    const d = Math.hypot(s.x - a.x, s.z - a.z);
    const k = strayed ? Math.min(1, 7 / Math.max(d, 1e-3)) : 1;
    a.tx = a.x + (s.x - a.x) * k;
    a.tz = a.z + (s.z - a.z) * k;
    return true;
  }

  /**
   * The way to the nearest water for an animal out on the dry land of the open world (as an angle for `migrate`), or null
   * where there is none to find or it is already close: uphill on the field of how near the water is.
   */
  private waterWay(a: Animal): number | null {
    const T = this.ctx.terrain;
    if (!T?.hydro?.wet) return null;
    const here = wetReach(T, a.x, a.z);
    if (here > 70 || here < -400) return null;
    const gx = wetReach(T, a.x + 12, a.z) - wetReach(T, a.x - 12, a.z);
    const gz = wetReach(T, a.x, a.z + 12) - wetReach(T, a.x, a.z - 12);
    if (Math.abs(gx) + Math.abs(gz) < 1e-3) return null;
    return Math.atan2(gz, gx);
  }

  /**
   * Prey does not just run. It grazes with its head down, and when something it does not trust comes into sight it stops and
   * stares (the whole herd goes still and lifts its heads) before deciding: bolt, if the thing keeps coming, or settle again.
   * A hare freezes far longer than a deer, and only bolts when it is nearly stepped on.
   */
  /**
   * Someone on foot, as this animal makes them out (see `sim/hunting.ts`): steps its awareness by what it sees, hears and
   * smells of the person it notices most, and says who that is and where. Null when no one is near enough to matter.
   */
  private stalk(a: Animal): { x: number; z: number; d: number; player: Player; seen: boolean; smelled: boolean } | null {
    const ctx = this.ctx;
    const sight = a.def.sight * ctx.campaign.difficulty.aggro;
    const [wx, wz] = windAt(ctx.storm ?? 0, ctx.time);
    const rain = ctx.rain ?? 0;
    // Head down in the grass it sees little; that is the moment to move.
    const grazing = (a.state === 'idle' || a.state === 'drink' || a.state === 'feed') && a.head > HEAD_DOWN[a.kind] * 0.5;
    const staring = a.state === 'alert' || a.state === 'bed';
    const farthest = sight * STALK.run * STALK.staring;
    const T = ctx.terrain;
    let best: { x: number; z: number; d: number; player: Player; seen: boolean; smelled: boolean } | null = null;
    let bestRate = -1;
    for (const p of ctx.players) {
      if (!p.alive || p.inVehicle || (p.state !== 'foot' && p.state !== 'downed')) continue;
      const dx = p.pos.x - a.x;
      const dz = p.pos.z - a.z;
      const d = Math.hypot(dx, dz);
      if (d > Math.max(farthest, STALK.scentMax)) continue;
      const speed = p.moveSpeed ?? 0;
      const crouch = !!p.crouch;
      // Walls, rocks and wrecks hide you outright; woods and, crouched, tall grass hide you in part.
      let cover = 0;
      if (d < farthest) {
        if (d > 2 && !this.visible(a, p.pos.x, p.pos.z)) cover = 1;
        else if (T?.hydro?.lush) cover = Math.min(0.85, forestAt(T, p.pos.x, p.pos.z) * 0.6 + (crouch ? lushAt(T, p.pos.x, p.pos.z) * 0.3 : 0));
      }
      const noise = typeof p.footSignature === 'function' ? p.footSignature() : speed > 4.5 ? 20 : speed > 0.5 ? (crouch ? 3 : 8) : crouch ? 2 : 3;
      const n = notice({ dx, dz, sight, speed, crouch, cover, dark: ctx.night, nightEyes: !!a.def.nocturnal, grazing, staring, windX: wx, windZ: wz, noise, rain });
      // The one it notices most; failing that, the nearest.
      if (n.rate > bestRate || (n.rate === bestRate && best && d < best.d)) {
        bestRate = n.rate;
        best = { x: p.pos.x, z: p.pos.z, d, player: p, seen: n.seen, smelled: n.smelled };
      }
    }
    a.aware = stepAwareness(a.aware, Math.max(0, bestRate), THINK);
    a.smelled = !!best?.smelled;
    if (best && bestRate > 0) a.awareOf = best.player.index;
    else if (a.aware <= 0) a.awareOf = -1;
    return best;
  }

  private thinkPrey(a: Animal) {
    // Vehicles are seen and heard as before; people on foot have to be noticed (see `stalk`).
    const th = this.threat(a, false, true);
    const st = this.stalk(a);
    const noise = this.heard(a, 38);
    const sight = a.def.sight;
    const nerve = nerveOf(a.def);
    const zf = this.scanZombies(a, sight * 0.45, 1);
    if (a.state === 'flee') {
      // Far enough off, or only a car going by on its own business.
      const quiet = (!th || (th.vehicle ? th.d > sight * 0.5 * nerve && th.closing < 3 : th.d > sight * 1.1)) && !zf && a.aware < STALK.alert;
      if (!zf && !th && this.bedDown(a, st)) {
        return;
        // Settles once nothing is after it; a wounded one runs on further first.
      } else if (a.stateT > (a.wounds.bleed > 0 ? BED.afterRun + 3 : 3) && quiet && !noise) {
        a.state = 'idle';
        a.stateT = 0;
        a.homeX = a.x;
        a.homeZ = a.z;
        a.hasTarget = false;
      } else if (st && a.aware >= STALK.alert) {
        a.fearX = st.x;
        a.fearZ = st.z;
      } else if (th) {
        a.fearX = th.x;
        a.fearZ = th.z;
      } else if (zf) {
        a.fearX = zf.x;
        a.fearZ = zf.z;
      }
      return;
    }
    if (a.state === 'bed') {
      // Lying up with its wound, head up and listening: it is off again the moment it notices you.
      if (zf || (st && a.aware >= STALK.alert) || (th && this.runsFrom(a, th)) || (noise && noise.level >= 45)) {
        const src = zf ?? (st && a.aware >= STALK.alert ? st : (th ?? noise!));
        this.scare(a, src.x, src.z);
        a.aware = Math.max(a.aware, 1);
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
    if (th && this.runsFrom(a, th)) {
      this.scare(a, th.x, th.z);
      return;
    }
    // Someone it has noticed. Inside its flight distance, or with their scent on the wind, it goes at once. Further off it
    // stares first, and once it is sure it acts: most game bolts, steady beasts walk off, a hare sits tight and a fox
    // sits down to watch.
    if (st && a.aware >= STALK.alert) {
      const bolt = a.kind === 'hare' ? 0.4 : a.kind === 'fox' ? 0.3 : 0.75;
      const sitsTight = a.kind === 'hare' || a.kind === 'fox';
      if (a.smelled || st.d < sight * bolt * nerve) {
        this.scare(a, st.x, st.z);
        return;
      }
      if (a.aware >= 1) {
        if (a.calmT > 0) return; // already walking off
        a.fearX = st.x;
        a.fearZ = st.z;
        if (a.state !== 'alert') {
          this.alertHerd(a, st.x, st.z);
          return;
        }
        if (sitsTight) {
          if (a.kind === 'fox' && a.stateT > a.alertFor) {
            // Now and then it trots a few paces to the side to see better.
            a.stateT = 0;
            a.alertFor = 4 + Math.random() * 6;
            if (Math.random() < 0.4) {
              const side = Math.atan2(a.z - st.z, a.x - st.x) + (Math.random() < 0.5 ? 1.2 : -1.2);
              a.tx = a.x + Math.cos(side) * 4;
              a.tz = a.z + Math.sin(side) * 4;
              a.hasTarget = true;
              a.state = 'wander';
              a.calmT = 4;
            }
          }
          return;
        }
        if (a.stateT < STALK.stare) return;
        if (nerve >= 0.75) {
          this.scare(a, st.x, st.z);
          return;
        }
        // Steady beasts just move off at a walk.
        const away = Math.atan2(a.z - st.z, a.x - st.x) + (Math.random() - 0.5) * 0.8;
        a.tx = a.x + Math.cos(away) * 15;
        a.tz = a.z + Math.sin(away) * 15;
        a.homeX = a.tx;
        a.homeZ = a.tz;
        a.hasTarget = true;
        a.state = 'wander';
        a.stateT = 0;
        a.calmT = 10;
        return;
      }
    }
    if (noise && noise.level >= 60 + (1 - nerve) * 30) {
      this.scare(a, noise.x, noise.z);
      return;
    }
    if (a.state === 'alert') {
      const uneasy = !!st && a.aware >= STALK.calm;
      if (uneasy) {
        a.fearX = st!.x;
        a.fearZ = st!.z;
      } else if (th) {
        a.fearX = th.x;
        a.fearZ = th.z;
      }
      if (a.stateT > a.alertFor && !uneasy) {
        if (!th) {
          a.state = 'idle';
          a.stateT = 0;
          a.idleFor = 1 + Math.random() * 2;
        } else if (a.kind === 'fox' || a.kind === 'hare') {
          a.stateT = 0;
        } else {
          // Anything watching a car just moves off at a walk.
          const away = Math.atan2(a.z - th.z, a.x - th.x) + (Math.random() - 0.5) * 0.8;
          a.tx = a.x + Math.cos(away) * 15;
          a.tz = a.z + Math.sin(away) * 15;
          a.homeX = a.tx;
          a.homeZ = a.tz;
          a.hasTarget = true;
          a.state = 'wander';
          a.stateT = 0;
          a.calmT = 10;
        }
      }
      return;
    }
    if (a.calmT <= 0 && ((st && a.aware >= STALK.alert) || th || noise)) {
      const src = st && a.aware >= STALK.alert ? st : (th ?? noise!);
      this.alertHerd(a, src.x, src.z);
      return;
    }
    this.graze(a);
  }

  /**
   * A badly hit animal that has run out of sight of everyone lies down with its wound. True when it just did. It bleeds
   * slower lying still, and is off again the moment it notices someone coming (see `thinkPrey`).
   */
  private bedDown(a: Animal, st: { x: number; z: number; d: number; seen: boolean } | null): boolean {
    if (a.wounds.bleed <= 0 || a.hp > a.def.hp * BED.hpShare || a.stateT < BED.afterRun) return false;
    if (st && (st.d < BED.clear || (st.seen && st.d < BED.clear * 2))) return false;
    a.state = 'bed';
    a.stateT = 0;
    a.hasTarget = false;
    a.vx = a.vz = 0;
    a.aware = Math.min(a.aware, STALK.calm);
    // It lies watching its back trail.
    a.fearX = st ? st.x : a.x - Math.sin(a.yaw) * 10;
    a.fearZ = st ? st.z : a.z - Math.cos(a.yaw) * 10;
    return true;
  }

  /**
   * Whether a threat is close enough to run from. Someone on foot: within its flight distance (a hare sits tight, a camel is
   * steady, a fox lets you come closer still). A vehicle: only when it is near, or coming straight at it fast; one passing
   * by at a distance is watched, not fled.
   */
  private runsFrom(a: Animal, th: Threat): boolean {
    const sight = a.def.sight;
    const nerve = nerveOf(a.def);
    if (th.vehicle) {
      const near = th.d < sight * 0.4 * nerve;
      const charging = th.vehicle.speed > 1.5 && th.closing > 5 && th.d < sight * 0.85 * nerve;
      return near || charging;
    }
    const bolt = a.kind === 'hare' ? 0.4 : a.kind === 'fox' ? 0.3 : 0.75;
    return th.d < sight * bolt * nerve;
  }

  /**
   * Thirsty and the water is near: walk down to its edge to drink, and have the herd come too. False when there is no water
   * within reach (it tries again later).
   */
  private goDrink(a: Animal): boolean {
    if (!DRINKERS.has(a.def.temper) || a.drinkT > 0) return false;
    // A buffalo wades in to drink; the rest drink from the edge.
    const deep = a.kind === 'buffalo' ? [0.3, 0.9] : [0.02, 0.22];
    let s = this.waterSpot(a.x, a.z, 1.5, 40, deep[0], deep[1]);
    if (!s) {
      // Any water in reach, then back along the line toward it to where it begins: the edge.
      const w = this.waterSpot(a.x, a.z, 2, 45, 0.02, 50);
      if (w) s = this.edgeToward(a.x, a.z, w.x, w.z);
    }
    if (!s) {
      a.drinkT = 25 + Math.random() * 50;
      return false;
    }
    // Face the deeper water from the edge.
    const face = this.waterSpot(s.x, s.z, 0.6, 2.5, 0.15, 50);
    a.wx = face ? face.x : s.x + (s.x - a.x) * 0.2;
    a.wz = face ? face.z : s.z + (s.z - a.z) * 0.2;
    a.tx = s.x;
    a.tz = s.z;
    a.hasTarget = true;
    a.drinking = true;
    a.state = 'wander';
    a.stateT = 0;
    if (this.lead.get(a.herd) === a) for (const o of this.list) if (o !== a && !o.dead && o.herd === a.herd) o.drinkT = Math.min(o.drinkT, Math.random() * 5);
    return true;
  }

  /** Walking from (x, z) toward water at (wx, wz), the first point where the water is underfoot (a little way in), or null. */
  private edgeToward(x: number, z: number, wx: number, wz: number): { x: number; z: number; level: number } | null {
    const d = Math.hypot(wx - x, wz - z);
    if (d < 0.5) return null;
    const ux = (wx - x) / d;
    const uz = (wz - z) / d;
    for (let s = 0; s <= d; s += 0.5) {
      const px = x + ux * s;
      const pz = z + uz * s;
      const w = this.ctx.waterAt(px, pz);
      if (w && w.depth > 0.02) return w.depth < 0.3 ? { x: px, z: pz, level: w.level } : { x: px - ux * 0.5, z: pz - uz * 0.5, level: w.level };
    }
    return null;
  }

  /** A hunting animal (a pack in full cry, a bear after something) close enough to be run from. */
  private hunterNear(a: Animal, r: number): { x: number; z: number } | null {
    for (const o of this.list) {
      if (o.dead || o === a || !o.chasing || o.def.temper === 'prey' || o.def.temper === 'bird' || o.def.temper === 'scavenger') continue;
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
      if (o.state !== 'idle' && o.state !== 'wander' && o.state !== 'drink') continue;
      if (o !== a && Math.random() > 0.7) continue;
      o.drinking = false;
      o.state = 'alert';
      o.stateT = 0;
      o.hasTarget = false;
      o.fearX = x;
      o.fearZ = z;
      o.alertFor = (hare ? 3.5 : o.kind === 'fox' ? 5 : 1.8) + Math.random() * (hare || o.kind === 'fox' ? 3 : 2);
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
      // A crow down to forage stays until it has had its fill; one at a carcass until the carcass is gone.
      const done = a.def.forage && !c ? a.state === 'feed' && a.stateT > a.feedFor : !c || !c.dead || c.butchered || (a.state === 'feed' && a.stateT > a.feedFor);
      if (done) {
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
      if (a.def.forage && a.state === 'fly' && a.stateT > 6 && Math.random() < 0.012) {
        this.forageLand(a);
        return;
      }
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
   * A jackal lives off what others kill. It keeps its distance from people (less of it after dark, when it is bolder), runs
   * from engines and the dead, and comes in to a carcass once nobody is near it. The pack howls together at night.
   */
  private thinkScavenger(a: Animal) {
    const th = this.threat(a, true, true);
    const noise = this.heard(a, 45);
    const sight = a.def.sight;
    const zf = this.scanZombies(a, sight * 0.5, 1);
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
      }
      return;
    }
    if (zf) {
      this.scare(a, zf.x, zf.z);
      return;
    }
    const bold = (0.7 - 0.3 * this.ctx.night) * nerveOf(a.def);
    const runs = th && (th.vehicle ? th.d < sight * 0.4 * bold || (th.closing > 4 && th.d < sight * 0.8 * bold) : th.d < sight * bold);
    if (th && runs) {
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
        a.state = 'idle';
        a.stateT = 0;
        a.idleFor = 1 + Math.random() * 2;
      }
      return;
    }
    if (th && a.state !== 'feed') {
      this.alertHerd(a, th.x, th.z);
      return;
    }
    const c = a.feedOn;
    if (a.state === 'feed') {
      if (!c || !c.dead || c.butchered || a.stateT > a.feedFor) {
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
        a.feedFor = 8 + Math.random() * 10;
        a.hasTarget = false;
      }
      return;
    }
    if (a.state === 'idle' && this.scavenge(a)) return;
    this.graze(a, 12);
  }

  /**
   * A heron stands in the shallows like a post and stabs at fish now and then; a stork walks the meadow pecking. Both watch
   * anything that comes into sight and go up when it comes too close, flying off along the water (a stork to other open
   * ground) to come down again somewhere quieter.
   */
  private thinkWader(a: Animal) {
    if (a.air) return;
    const th = this.threat(a, true, true);
    const noise = this.heard(a, 50);
    const zf = this.scanZombies(a, 18, 1);
    const sight = a.def.sight;
    const nerve = nerveOf(a.def);
    // A car coming at it puts it up from further off than one going by.
    const flushAt = (t: Threat) => (t.vehicle ? (t.closing > 3 ? sight * 0.8 : sight * 0.4) : sight * 0.6) * nerve;
    let from: { x: number; z: number } | null = null;
    if (a.state === 'flee') from = { x: a.fearX, z: a.fearZ };
    else if (zf) from = zf;
    else if (th && th.d < flushAt(th)) from = th;
    else if (noise && noise.level >= 50 && Math.hypot(noise.x - a.x, noise.z - a.z) < 70) from = noise;
    if (from) {
      this.takeOff(a, from.x, from.z);
      return;
    }
    if (th) {
      if (a.state !== 'alert') {
        a.state = 'alert';
        a.stateT = 0;
        a.hasTarget = false;
        a.alertFor = 3 + Math.random() * 4;
      }
      a.fearX = th.x;
      a.fearZ = th.z;
      return;
    }
    if (a.state === 'alert') {
      if (a.stateT < a.alertFor) return;
      a.state = 'idle';
      a.stateT = 0;
      a.idleFor = 2 + Math.random() * 3;
    }
    if (a.state === 'idle' && a.strike <= 0 && Math.random() < (a.kind === 'heron' ? 0.012 : 0.03)) a.strike = 0.45;
    // A heron barely moves between strikes; a stork keeps walking.
    if (a.kind === 'heron' && a.state === 'idle') a.idleFor = Math.max(a.idleFor, 6);
    this.graze(a, a.kind === 'heron' ? 5 : 9);
  }

  /**
   * Ducks paddle about where they came down, up-ending to feed, and chatter. Something coming into sight sends them swimming
   * away; anything close, an engine or a shot sends the whole raft up and off to other water.
   */
  private thinkSwimmer(a: Animal) {
    if (a.air) return;
    const th = this.threat(a, true, true);
    const noise = this.heard(a, 45);
    const zf = this.scanZombies(a, 14, 1);
    const flushAt = (t: Threat) => (t.vehicle ? (t.closing > 3 ? 24 : 12) : t.player?.crouch ? 6 : 12) * nerveOf(a.def);
    let from: { x: number; z: number } | null = null;
    if (a.state === 'flee' && Math.hypot(a.fearX - a.x, a.fearZ - a.z) < 30) from = { x: a.fearX, z: a.fearZ };
    else if (zf) from = zf;
    else if (th && th.d < flushAt(th)) from = th;
    else if (noise && noise.level >= 55 && Math.hypot(noise.x - a.x, noise.z - a.z) < 80) from = noise;
    if (from) {
      this.takeOff(a, from.x, from.z);
      return;
    }
    if (th) {
      // Not close yet: swim off the other way, the raft together.
      if (a.state !== 'flee') this.scare(a, th.x, th.z);
      a.fearX = th.x;
      a.fearZ = th.z;
      return;
    }
    if (a.state === 'flee') {
      if (a.stateT > 4) {
        a.state = 'idle';
        a.stateT = 0;
        a.homeX = a.x;
        a.homeZ = a.z;
      }
      return;
    }
    if (a.state === 'idle') {
      if (a.dabble <= 0 && Math.random() < 0.02) a.dabble = 1.5 + Math.random() * 2.5;
      if (a.stateT > a.idleFor && a.dabble <= 0) {
        const s = this.waterSpot(a.homeX, a.homeZ, 1, 7, 0.3, 50);
        if (s) {
          a.tx = s.x;
          a.tz = s.z;
          a.hasTarget = true;
          a.state = 'wander';
          a.stateT = 0;
        } else a.stateT = 0;
      }
    } else if (a.state === 'wander' && (Math.hypot(a.tx - a.x, a.tz - a.z) < 0.5 || a.stateT > 12)) {
      a.state = 'idle';
      a.stateT = 0;
      a.idleFor = 2 + Math.random() * 6;
      a.hasTarget = false;
    }
  }

  /** Up and off, the whole flock or raft with it: to other water (other open ground for a stork), away from the fright. */
  private takeOff(a: Animal, fromX: number, fromZ: number) {
    const dest = this.refuge(a, fromX, fromZ);
    let n = 0;
    for (const o of this.list) {
      if (o.dead || o.air || o.herd !== a.herd || o.def.temper !== a.def.temper) continue;
      if (o !== a && Math.hypot(o.x - a.x, o.z - a.z) > 40) continue;
      let tx = dest.x + (o === a ? 0 : (Math.random() - 0.5) * 7);
      let tz = dest.z + (o === a ? 0 : (Math.random() - 0.5) * 7);
      if (dest.water && o !== a) {
        const s = this.waterSpot(tx, tz, 0, 3, 0.3, 50);
        if (s) {
          tx = s.x;
          tz = s.z;
        } else {
          tx = dest.x;
          tz = dest.z;
        }
      }
      this.launch(o, tx, tz, dest.water, n++ * 0.04);
    }
    const ctx = this.ctx;
    if (a.def.call) ctx.audio.play(a.def.call, a.x, a.z, 0.9);
    ctx.audio.play('flutter', a.x, a.z, Math.min(1, 0.5 + n * 0.1));
    if (a.def.temper === 'swimmer') this.splash(a.x, a.y, a.z, 0.6 + n * 0.1);
  }

  /** Where a flushed bird goes: water a fair way off on the far side from the fright, or open ground for a stork. */
  private refuge(a: Animal, fromX: number, fromZ: number): { x: number; z: number; water: boolean } {
    const away = { x: fromX, z: fromZ };
    if (a.def.temper === 'swimmer') {
      const s = this.waterSpot(a.x, a.z, 60, 200, 0.45, 50, away) ?? this.waterSpot(a.x, a.z, 25, 60, 0.4, 50, away);
      if (s) return { x: s.x, z: s.z, water: true };
      // No other water in reach (a lone pond with someone on its bank): they leave it for open ground well away, rather than
      // landing back on the spot they rose from and taking off again every few frames.
      const ang = Math.atan2(a.z - fromZ, a.x - fromX) + this.rng.range(-0.6, 0.6);
      const r = this.rng.range(90, 150);
      return { x: a.x + Math.cos(ang) * r, z: a.z + Math.sin(ang) * r, water: false };
    }
    if (a.kind === 'heron') {
      const s = this.waterSpot(a.x, a.z, 45, 140, 0.04, 0.4, away);
      if (s) return { x: s.x, z: s.z, water: false };
    }
    const base = Math.atan2(a.z - fromZ, a.x - fromX);
    const T = this.ctx.terrain;
    let best: { x: number; z: number; water: boolean } | null = null;
    let bestL = -1;
    for (let k = 0; k < 10; k++) {
      const ang = base + this.rng.range(-1, 1);
      const r = this.rng.range(60, 160);
      const x = a.x + Math.cos(ang) * r;
      const z = a.z + Math.sin(ang) * r;
      if (!this.canStand(x, z)) continue;
      const w = this.ctx.waterAt(x, z);
      if (w && w.depth > (a.def.wade ?? 0.3)) continue;
      const L = T?.hydro?.lush ? lushAt(T, x, z) : 0.5;
      if (L > bestL) {
        bestL = L;
        best = { x, z, water: false };
      }
    }
    return best ?? { x: a.x + Math.cos(base) * 80, z: a.z + Math.sin(base) * 80, water: false };
  }

  /** Set a wader or a swimmer flying from where it is to (tx, tz). `lag` holds it back a moment so a flock goes up ragged. */
  private launch(a: Animal, tx: number, tz: number, water: boolean, lag = 0) {
    const ctx = this.ctx;
    const w = water ? ctx.waterAt(tx, tz) : null;
    const len = Math.max(1, Math.hypot(tx - a.x, tz - a.z));
    a.air = true;
    a.state = 'fly';
    a.stateT = 0;
    a.hasTarget = false;
    a.feedOn = null;
    a.dabble = 0;
    a.strike = 0;
    const alt = (a.def.altitude ?? 8) * this.rng.range(0.8, 1.2) * Math.min(1, 0.4 + len / 120);
    a.hop = { x0: a.x, z0: a.z, y0: a.y, tx, tz, y1: w ? w.level : ctx.groundAt(tx, tz), alt, len, s: -lag * (a.def.run / len), water: !!w };
  }

  /**
   * A flight from one spot to another: a hard-beating climb, a steady stretch (a stork glides it), and a long descent to come
   * down on its feet, or skidding onto the water in a burst of spray for a duck.
   */
  private flyTo(a: Animal, dt: number) {
    const ctx = this.ctx;
    const h = a.hop;
    const s0 = Math.max(0, h.s);
    const pace = s0 < 0.15 ? 0.5 + s0 * 3.3 : s0 > 0.82 ? 0.45 + (1 - s0) * 3 : 1;
    h.s = Math.min(1, h.s + (a.def.run * pace * dt) / h.len);
    if (h.s <= 0) return;
    const s = h.s;
    const ux = (h.tx - h.x0) / h.len;
    const uz = (h.tz - h.z0) / h.len;
    // Bowed a little to one side, so a flight is not a ruled line.
    const bow = Math.sin(s * Math.PI) * h.len * 0.07 * (a.id % 2 ? 1 : -1);
    const nx = h.x0 + (h.tx - h.x0) * s - uz * bow;
    const nz = h.z0 + (h.tz - h.z0) * s + ux * bow;
    a.vx = (nx - a.x) / Math.max(dt, 1e-3);
    a.vz = (nz - a.z) / Math.max(dt, 1e-3);
    a.x = nx;
    a.z = nz;
    let y = h.y0 + (h.y1 - h.y0) * s + Math.pow(Math.sin(s * Math.PI), 0.55) * h.alt;
    if (s > 0.1 && s < 0.9) y = Math.max(y, ctx.groundAt(a.x, a.z) + 1.5);
    a.y = y;
    if (Math.hypot(a.vx, a.vz) > 0.3) a.yaw += wrapAngle(Math.atan2(a.vx, a.vz) - a.yaw) * Math.min(1, dt * 6);
    const climbing = s < 0.28;
    const landing = s > 0.8;
    const rate = a.def.temper === 'swimmer' ? 26 : a.kind === 'stork' ? (climbing || landing ? 10 : Math.sin(ctx.time * 0.4 + a.id) > 0.5 ? 6 : 0.8) : 11;
    a.flap += dt * rate;
    a.gait = 0.6;
    if (h.s >= 1) {
      a.air = false;
      a.state = 'idle';
      a.stateT = 0;
      a.idleFor = 2 + Math.random() * 3;
      a.homeX = a.x;
      a.homeZ = a.z;
      a.vx = a.vz = 0;
      a.hasTarget = false;
      if (h.water) this.splash(a.x, h.y1, a.z, 0.5);
    }
  }

  /** Paddling on the water: the current carries it, and it paddles against most of it to stay where it means to be. */
  private swim(a: Animal, dt: number) {
    const ctx = this.ctx;
    const def = a.def;
    const w = ctx.waterAt(a.x, a.z);
    let wx = 0;
    let wz = 0;
    let speed = 0;
    if (a.stun <= 0) {
      if (a.state === 'wander' && a.hasTarget) {
        const dx = a.tx - a.x;
        const dz = a.tz - a.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.2) {
          wx = dx / d;
          wz = dz / d;
          speed = def.walk;
        }
      } else if (a.state === 'flee') {
        const dx = a.x - a.fearX;
        const dz = a.z - a.fearZ;
        const d = Math.hypot(dx, dz) || 1;
        const wob = Math.sin(a.stateT * 1.3 + a.id) * 0.3;
        wx = dx / d - (dz / d) * wob;
        wz = dz / d + (dx / d) * wob;
        speed = def.walk * 3.2;
      }
      if (!w || w.depth < 0.15) {
        // Washed up or drifted ashore: back toward home water.
        const dx = a.homeX - a.x;
        const dz = a.homeZ - a.z;
        const d = Math.hypot(dx, dz) || 1;
        wx = dx / d;
        wz = dz / d;
        speed = def.walk;
      }
    }
    const l = Math.hypot(wx, wz) || 1;
    const fx = (w?.flow?.[0] ?? 0) * 0.35;
    const fz = (w?.flow?.[1] ?? 0) * 0.35;
    a.vx = damp(a.vx, (wx / l) * speed + fx, 4, dt);
    a.vz = damp(a.vz, (wz / l) * speed + fz, 4, dt);
    const nx = a.x + a.vx * dt;
    const nz = a.z + a.vz * dt;
    const nw = ctx.waterAt(nx, nz);
    if ((nw && nw.depth >= 0.2) || !w || w.depth < 0.2) {
      a.x = nx;
      a.z = nz;
    } else {
      // That way is the shore: stop, and turn round if it was going there on purpose.
      a.vx *= -0.3;
      a.vz *= -0.3;
      if (a.state === 'wander') {
        a.state = 'idle';
        a.stateT = 0;
        a.hasTarget = false;
      }
    }
    const here = nw ?? w;
    a.y = (here ? here.level : ctx.groundAt(a.x, a.z)) + Math.sin(ctx.time * 2.1 + a.id) * 0.01;
    const rel = Math.hypot(a.vx - fx, a.vz - fz);
    if (rel > 0.12) a.yaw += wrapAngle(Math.atan2(a.vx - fx, a.vz - fz) - a.yaw) * Math.min(1, dt * 3);
    else a.yaw += Math.sin(ctx.time * 0.3 + a.id * 1.7) * dt * 0.25;
    a.gait = 0;
    if (a.dabble > 0) a.dabble -= dt;
  }

  /**
   * The odd call while it goes about its business: ducks chatter on the water, crows caw, buffalo and camels low, and after
   * dark a jackal pack's leader starts up and the rest answer it.
   */
  private callOut(a: Animal, dt: number) {
    a.callT -= dt;
    if (a.callT > 0) return;
    const ctx = this.ctx;
    const call = a.def.call!;
    if (a.def.temper === 'wader') {
      // A heron calls when it is put up, not otherwise.
      a.callT = 1e9;
      return;
    }
    if (call === 'howl') {
      a.callT = 25 + Math.random() * 50;
      const chorus = a.chorus;
      a.chorus = false;
      if (!chorus && (ctx.night < 0.35 || this.lead.get(a.herd) !== a || a.state === 'flee')) return;
      ctx.audio.play('howl', a.x, a.z, chorus ? 0.75 : 0.9);
      if (!chorus) {
        for (const o of this.list) {
          if (o === a || o.dead || o.herd !== a.herd) continue;
          o.chorus = true;
          o.callT = 0.4 + Math.random() * 1.6;
        }
      }
      return;
    }
    if (call === 'quack') {
      a.callT = a.air ? 1.5 + Math.random() * 2 : 4 + Math.random() * 14;
      ctx.audio.play('quack', a.x, a.z, a.air ? 0.8 : 0.45);
      return;
    }
    if (call === 'caw') {
      a.callT = 6 + Math.random() * 16;
      ctx.audio.play('caw', a.x, a.z, 0.5);
      return;
    }
    a.callT = 30 + Math.random() * 60;
    if (a.state === 'idle' || a.state === 'wander' || a.state === 'alert') ctx.audio.play(call, a.x, a.z, 0.7);
  }

  /** Spray and rings where something meets the water. */
  private splash(x: number, y: number, z: number, size: number) {
    const ctx = this.ctx;
    const sm = ctx.fx?.smoke;
    if (sm) for (let i = 0; i < 4 + size * 6; i++) sm.emit(x + (Math.random() - 0.5) * 0.4, y + 0.05, z + (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 1.6, 1 + Math.random() * 1.5 * size, (Math.random() - 0.5) * 1.6, 0.6, 0.15, 0.5, 0.9, 0.93, 0.95, 0.45, 6, 0.4);
    ctx.life?.ripple(x, y, z, 0.8 + size);
    ctx.audio.play(size > 0.7 ? 'splash' : 'plop', x, z, 0.35 + size * 0.3);
  }

  /** A crow flock comes down to walk and peck over open ground for a while. */
  private forageLand(a: Animal) {
    const o = a.orbit;
    const ang = Math.random() * 6.28;
    const r = Math.random() * o.r;
    const x = o.cx + Math.cos(ang) * r;
    const z = o.cz + Math.sin(ang) * r;
    if (!this.canStand(x, z) || this.ctx.waterAt(x, z)) return;
    const feedFor = 12 + Math.random() * 20;
    for (const b of this.list) {
      if (b.dead || b.herd !== a.herd || b.state !== 'fly') continue;
      const sx = x + (Math.random() - 0.5) * 6;
      const sz = z + (Math.random() - 0.5) * 6;
      if (!this.canStand(sx, sz) || this.ctx.waterAt(sx, sz)) continue;
      b.feedOn = null;
      b.state = 'land';
      b.stateT = 0;
      b.feedFor = feedFor + Math.random() * 6;
      b.tx = sx;
      b.tz = sz;
    }
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
    // Only a big pack of the dead that is actually hunting is worth running from, and not with a target already in its teeth.
    const horde = this.scanZombies(a, 16, 6, true);
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
    if ((a.chasing && (a.hp < def.hp * 0.25 || a.moveMult < 0.4)) || (horde && !(th && th.d < 15))) {
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
    a.y = ctx.groundAt(a.x, a.z) + (ctx.ground?.heightAt(a.x, a.z) ?? 0);
    if (a.kind === 'fox') this.mousing(a, dt);
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
          if (a.hasTarget && toward(a.tx, a.tz) > 0) speed = def.walk * ((a.def.temper === 'pack' && (a.stateT < 1.5 || a.feedOn)) || (a.def.temper === 'scavenger' && a.feedOn) ? 2.2 : 1);
          break;
        case 'alert':
        case 'drink':
        case 'feed': {
          // Standing its ground: turn to face what it is watching, the body it is eating or the water it drinks from.
          const fx = a.state === 'feed' && a.feedOn ? a.feedOn.x : a.state === 'drink' ? a.wx : a.fearX;
          const fz = a.state === 'feed' && a.feedOn ? a.feedOn.z : a.state === 'drink' ? a.wz : a.fearZ;
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
    const deep = def.wade ?? 0.6;
    const wet = ctx.waterAt(a.x + wx * 0.8, a.z + wz * 0.8);
    if (wet && wet.depth > deep) {
      speed = 0;
      if (a.state === 'flee') {
        // Turn along the shore.
        const sw = wx;
        wx = -wz;
        wz = sw;
      }
    } else if (wet && wet.depth > deep * 0.42) speed *= 0.6;
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

  /** A fox hunting mice in the grass: now and then, standing still, it springs up and dives nose-first a metre on. */
  private mousing(a: Animal, dt: number) {
    if (a.strike > 0) {
      a.strike -= dt;
      const k = clamp(1 - a.strike / 0.7, 0, 1);
      a.y += Math.sin(k * Math.PI) * 0.5;
      a.x += Math.sin(a.yaw) * 1.6 * dt;
      a.z += Math.cos(a.yaw) * 1.6 * dt;
    } else if (a.state === 'idle' && Math.random() < dt * 0.12) a.strike = 0.7;
  }

  private fly(a: Animal, dt: number) {
    const ctx = this.ctx;
    const o = a.orbit;
    const speed = (a.def.walk / Math.max(8, o.r)) * o.dir;
    if (a.state === 'land' || a.state === 'feed') {
      const ground = ctx.groundAt(a.x, a.z);
      // A vulture's model has no legs: it sits a little up. The rest stand on their feet.
      const perch = a.kind === 'vulture' ? 0.15 : 0;
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
        a.y += (ground + perch + Math.min(o.alt, d * 0.5) - a.y) * Math.min(1, dt * 2.2);
        a.flap += dt * (d > 4 ? 6 : 11);
        a.gait = 0.6;
        a.vx = a.vz = 0;
        if (d < 0.6 && a.y < ground + 0.6) {
          a.state = 'feed';
          a.stateT = 0;
        }
        return;
      }
      if (a.def.forage && !a.feedOn) {
        // Foraging: a hop or two, a look about, a peck.
        a.hopT -= dt;
        if (a.hopT <= 0) {
          a.hopT = 0.6 + Math.random() * 2.2;
          const ang = Math.random() * 6.28;
          const tx = a.x + Math.cos(ang) * (0.4 + Math.random());
          const tz = a.z + Math.sin(ang) * (0.4 + Math.random());
          if (this.canStand(tx, tz) && !ctx.waterAt(tx, tz)) {
            a.tx = tx;
            a.tz = tz;
          }
        }
        const dx = a.tx - a.x;
        const dz = a.tz - a.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.08) {
          const step = Math.min(d, 1.4 * dt);
          a.x += (dx / d) * step;
          a.z += (dz / d) * step;
          a.yaw += wrapAngle(Math.atan2(dx, dz) - a.yaw) * Math.min(1, dt * 10);
          a.gait = 1;
          a.phase += dt * 16;
        } else a.gait = 0;
        a.y = ctx.groundAt(a.x, a.z) + (ctx.ground?.heightAt(a.x, a.z) ?? 0);
        a.vx = a.vz = 0;
        return;
      }
      // Down: hop about and peck, facing the body.
      a.y += (ground + perch - a.y) * Math.min(1, dt * 8);
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
    const wading = a.def.temper === 'wader' || a.def.temper === 'swimmer';
    if (a.flying) {
      fold = a.state === 'feed' ? 1 : a.state === 'land' ? 0.35 : 0;
      // A crow foraging on the ground pecks between hops.
      if (a.state === 'feed' && a.def.forage && !a.feedOn) head = Math.sin(t * 3.1 + a.id * 1.3) > 0.45 && a.gait < 0.2 ? HEAD_DOWN[a.kind] : -0.1;
      if (a.air) head = a.kind === 'heron' ? -0.5 : 0;
    } else if (wading) {
      fold = 1;
      const scan = Math.sin(t * 0.6 + a.id * 2.1);
      switch (a.state) {
        case 'idle':
          if (a.def.temper === 'swimmer') head = a.dabble > 0 ? 0.9 : 0.05 + scan * 0.05;
          else if (a.strike > 0) head = HEAD_DOWN[a.kind] * 1.25;
          else if (a.kind === 'stork') head = (t * 0.45 + a.id * 0.31) % 1 < 0.55 ? HEAD_DOWN[a.kind] * 0.8 : -0.1;
          else head = 0.25 + scan * 0.05;
          look = scan * 0.5;
          break;
        case 'wander':
          head = a.kind === 'stork' ? 0.5 + Math.sin(a.phase) * 0.2 : 0.3;
          break;
        case 'alert':
          head = -0.35;
          look = clamp(wrapAngle(Math.atan2(a.fearX - a.x, a.fearZ - a.z) - a.yaw) * 0.6, -0.8, 0.8);
          break;
        default:
          head = -0.15;
      }
      if (a.strike > 0) {
        a.strike -= dt;
        // A heron's stab sometimes comes up with something.
        if (a.strike <= 0 && a.kind === 'heron' && Math.random() < 0.35) {
          const w = this.ctx.waterAt(a.x, a.z);
          if (w) this.splash(a.x + Math.sin(a.yaw) * 0.6, w.level, a.z + Math.cos(a.yaw) * 0.6, 0.15);
        }
      }
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
        case 'drink':
          head = down * 1.15 + Math.sin(t * 3.3 + a.id) * 0.05;
          break;
        case 'alert':
          head = a.kind === 'bear' ? -0.15 : a.kind === 'deer' ? -0.2 : -0.5;
          // A bear rears to warn; a fox sits down on its haunches to watch.
          rear = a.kind === 'bear' ? 0.85 : a.kind === 'fox' && a.stateT > 1.5 ? 0.35 : 0;
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
        case 'bed':
          // Lying up with its wound, head raised, turning now and then to its back trail.
          head = -0.05 + Math.sin(t * 0.7 + a.id) * 0.06;
          look = clamp(wrapAngle(Math.atan2(a.fearX - a.x, a.fearZ - a.z) - a.yaw) * 0.6, -0.9, 0.9) * (0.5 + 0.5 * Math.max(0, scan));
          break;
        case 'feed':
          head = HEAD_DOWN[a.kind] * 1.1 + Math.sin(t * 5 + a.id) * 0.12;
          break;
      }
    }
    const k = Math.min(1, dt * (a.state === 'alert' || a.state === 'flee' || a.strike > 0 ? 9 : 4));
    a.head += (head - a.head) * k;
    a.tip += ((a.dabble > 0 ? 1.35 : 0) - a.tip) * Math.min(1, dt * 5);
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
        a.attackFor = cd;
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
        a.attackFor = a.attackCd;
        v.takeHit(def.vehicleDamage ?? 15, a.x, a.z, { ram: true, smash: true });
        const dx = v.position.x - a.x;
        const dz = v.position.z - a.z;
        const l = Math.hypot(dx, dz) || 1;
        v.shove((dx / l) * v.mass * (t === 'brute' ? 0.5 : 0.35), (dz / l) * v.mass * (t === 'brute' ? 0.5 : 0.35));
        ctx.audio.play('crash', a.x, a.z, 0.7);
        if (t === 'charger') {
          // Speed either way hurts it: a car backing into a boar is no tonic.
          this.damage(a, 6 + Math.abs(v.speed), { fromX: v.position.x, fromZ: v.position.z });
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
    const sp = this.renderPoint;
    const budget = maxPerView;
    const nearest = this.renderNearest;
    nearest.begin(Math.ceil(budget));
    for (let order = 0; order < this.list.length; order++) {
      const a = this.list[order];
      if (!a.active && !a.dead) continue;
      let distance = Infinity;
      for (const c of camPos) distance = Math.min(distance, (c.x - a.x) ** 2 + (c.z - a.z) ** 2);
      if (!nearest.accepts(distance, order)) continue;
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
      nearest.offer(a, distance, order);
    }
    for (const { value: a } of nearest.finish()) {
      const sink = a.dead ? Math.max(0, a.deadT - (a.keepFor - 3)) * 0.2 : 0;
      const roll = a.dead ? a.fall * (Math.PI / 2) * (a.id % 2 ? 1 : -1) * 0.95 : 0;
      // Lying on its side puts the body a little off the ground, not through it.
      const lift = a.dead && !a.flying ? a.fall * 0.04 : 0;
      const bank = a.flying && !a.dead && !a.air && a.state !== 'feed' ? a.orbit.dir * -0.35 : 0;
      _pose.mask = a.wounds.mask;
      _pose.head = a.dead ? 0.15 : a.head;
      _pose.look = a.dead ? 0 : a.look;
      _pose.rear = a.dead ? 0 : a.rear;
      _pose.fold = a.dead ? 0 : a.fold;
      // On the wing the legs trail behind; an up-ended duck has its tail to the sky.
      _pose.legs = !a.dead && (a.air || (a.flying && a.state !== 'feed')) ? 1.3 : undefined;
      _pose.pitch = a.dead ? 0 : a.tip;
      _pose.lie = !a.dead && a.state === 'bed' ? Math.min(1, a.stateT * 1.5) : 0;
      // For the rigged models: the strike played through over its first 0.7 s, gliding when the wings barely beat, a duck
      // paddling on its water, and how far through falling dead it is.
      _pose.attack = !a.dead && a.attackFor > 0 && a.attackCd > a.attackFor - 0.7 ? Math.min(1, Math.max(0.01, (a.attackFor - a.attackCd) / 0.7)) : 0;
      const now = performance.now() / 1000;
      if (Number.isFinite(a.rFlap) && now > a.rT) a.flapRate += ((a.flap - a.rFlap) / Math.max(1e-3, now - a.rT) - a.flapRate) * 0.15;
      a.rFlap = a.flap;
      a.rT = now;
      _pose.glide = Math.min(1, Math.max(0, (4 - a.flapRate) / 2.5));
      _pose.swim = a.kind === 'duck' && !a.air ? 1 : 0;
      _pose.dying = a.dead ? Math.max(0.02, a.fall) : 0;
      // Which of its takes it plays (its own, kept), and a flinch from a hit, toward the side it came from.
      _pose.seed = a.id;
      _pose.hit = !a.dead && a.hitT > 0 ? (1 - a.hitT / 0.6) * a.hitSide : 0;
      ar.push(a.kind, a.def.size, a.x, a.y - sink + lift, a.z, a.yaw, a.phase, a.dead ? 0 : a.gait, roll, a.dead ? 0.2 : a.flap, bank, a.tint, _pose);
    }
    ar.end();
  }
}
