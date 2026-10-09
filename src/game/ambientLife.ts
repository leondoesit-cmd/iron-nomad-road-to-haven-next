import { clamp, damp, smoothstep, wrapAngle } from '../core/math';
import { QUALITY } from '../render/renderer';
import type { LifeRenderer } from '../render/lifeRender';
import { forestAt, lushAt, wetReach } from '../world/hydro';
import { lakeWater } from '../world/lakes';
import { TREE_DIMS, TREE_SPECIES, leanOffset, type TreeSpot } from '../world/flora';
import { districtMask } from '../world/openWorld';
import type { Ctx } from './ctx';

/**
 * The small life of the country: what makes the green land and the water feel lived in, and none of it gameplay. Butterflies
 * over the meadow flowers and bees working them, dragonflies hawking over the water's edge, fireflies in the dusk, gnats
 * dancing over a swamp and flies on a carcass, grasshoppers springing out of the grass ahead of your boots, flocks of
 * sparrows and bulbuls that go up as you come near (pigeons in the city), swallows over the water by day and bats by
 * night, fish schooling in the clear shallows and leaping in the lakes and rivers, frogs and turtles that drop into the
 * water when you come down the bank, and lizards that dart off the hot rocks. Under the water: crabs on the stream beds
 * that scuttle sideways and hide when you come, tadpoles wriggling in the warm shallows, bottom fish grubbing along the
 * bed, and water striders skating on the still surface. At the banks: wagtails running along the waterline, small birds and
 * doves come down to drink, damselflies on the reeds, a pied kingfisher hovering and diving for fish. Birds sit in the
 * trees and go to another tree when you come near. In the dry country: snakes (a horned viper sidewinding over the sand, a
 * viper that coils and hisses, a black whip snake that is gone in a flash) and lizards from a darting sand lizard to a
 * metre-long desert monitor.
 *
 * Everything lives within a few tens of metres of a player, is put there by what the land is (how green, how wooded, what
 * water, city or not, the hour) and leaves when nobody is near. It runs on render time with `Math.random`: it is not part
 * of the simulation and never touches it, with one exception. Snakes bite. They run on the game's fixed tick (`tick`): a
 * viper coils and hisses at someone who comes close and strikes if they stay within reach, and bites at once if stepped on;
 * a whip snake only bites when cornered. A shot, a blow or a wheel kills one. `LifeRenderer` draws it all.
 */

export type CritterKind =
  | 'butterfly'
  | 'bees'
  | 'dragonfly'
  | 'fireflies'
  | 'midges'
  | 'flies'
  | 'hopper'
  | 'songbird'
  | 'pigeon'
  | 'swallow'
  | 'bat'
  | 'fish'
  | 'leap'
  | 'frog'
  | 'turtle'
  | 'lizard'
  | 'crab'
  | 'tadpole'
  | 'skater'
  | 'perched'
  | 'wagtail'
  | 'kingfisher'
  | 'damselfly'
  | 'snake';

/** How far from a player each kind is kept (it is put there between `near` and `far`, and leaves beyond `far` * 1.25), and how many at most. */
const RANGE: Record<CritterKind, { near: number; far: number; cap: number }> = {
  butterfly: { near: 4, far: 34, cap: 18 },
  bees: { near: 4, far: 22, cap: 5 },
  dragonfly: { near: 4, far: 32, cap: 10 },
  fireflies: { near: 3, far: 42, cap: 9 },
  midges: { near: 4, far: 30, cap: 4 },
  flies: { near: 0, far: 40, cap: 4 },
  hopper: { near: 0, far: 12, cap: 10 },
  songbird: { near: 14, far: 55, cap: 40 },
  pigeon: { near: 12, far: 60, cap: 40 },
  swallow: { near: 8, far: 60, cap: 12 },
  bat: { near: 8, far: 50, cap: 10 },
  fish: { near: 3, far: 30, cap: 60 },
  leap: { near: 10, far: 65, cap: 3 },
  frog: { near: 4, far: 22, cap: 14 },
  turtle: { near: 6, far: 40, cap: 6 },
  lizard: { near: 4, far: 30, cap: 16 },
  crab: { near: 2, far: 16, cap: 16 },
  tadpole: { near: 2, far: 14, cap: 48 },
  skater: { near: 2, far: 16, cap: 24 },
  perched: { near: 10, far: 70, cap: 36 },
  wagtail: { near: 6, far: 35, cap: 6 },
  kingfisher: { near: 8, far: 55, cap: 3 },
  damselfly: { near: 2, far: 16, cap: 20 },
  snake: { near: 4, far: 28, cap: 3 },
};

/** Birds of the trees, by what they perch in: palms have doves and bulbuls, the broadleaves sparrows, bulbuls, goldfinches and starlings, pines jays and crows, dead snags and acacias crows and shrikes. */
const PERCHERS: Record<string, [number, number, number][]> = {
  palm: [
    [0.68, 0.53, 0.47],
    [0.42, 0.38, 0.34],
  ],
  broad: [
    [0.62, 0.48, 0.32],
    [0.42, 0.38, 0.34],
    [0.75, 0.62, 0.3],
    [0.2, 0.2, 0.23],
  ],
  pine: [
    [0.62, 0.53, 0.48],
    [0.45, 0.45, 0.48],
  ],
  dry: [
    [0.45, 0.45, 0.48],
    [0.62, 0.57, 0.52],
  ],
};

export interface Critter {
  kind: CritterKind;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  /** Home or the centre of its swarm, school or flock. */
  hx: number;
  hy: number;
  hz: number;
  tx: number;
  ty: number;
  tz: number;
  /** 0 at rest (sitting, perched, holding station), 1 moving, 2 fleeing or diving, 3 gone. */
  state: number;
  /** Seconds left in the state, and seconds alive. */
  timer: number;
  age: number;
  /** Seconds into a flight (a flushed flock). */
  prog: number;
  phase: number;
  size: number;
  r: number;
  g: number;
  b: number;
  /** Flock, school or swarm id. */
  flock: number;
  /** Water level for water life; the body it buzzes over for flies. */
  level: number;
  ref: number;
  seed: number;
}

interface Ring {
  x: number;
  y: number;
  z: number;
  r: number;
  age: number;
  life: number;
  k: number;
}

/** What the land is at a point, for deciding what lives there. */
interface Habitat {
  x: number;
  z: number;
  ground: number;
  water: { level: number; depth: number; flow?: [number, number]; kind?: string } | null;
  /** Water fish and frogs can live in (not a brine or ash lake, not a flood). */
  living: boolean;
  lush: number;
  forest: number;
  /** 1 right by water, 0 well away. */
  near: number;
  city: boolean;
  indoors: boolean;
}

/** Water that holds life. Anything else (brine, ash, a passing flood) does not. */
const LIVE_WATER = new Set(['river', 'stream', 'spring', 'swamp', 'lake', 'pool']);

const BUTTERFLY: [number, number, number][] = [
  [0.96, 0.95, 0.9],
  [1, 0.86, 0.28],
  [0.98, 0.56, 0.2],
  [0.48, 0.62, 1],
  [1, 0.93, 0.62],
];
const DRAGON: [number, number, number][] = [
  [0.25, 0.45, 0.95],
  [0.9, 0.22, 0.16],
  [0.3, 0.78, 0.4],
  [0.85, 0.65, 0.2],
];
/** Tilapia, carp, catfish, mullet: darker than they look out of the water, so they still read through it. */
const FISH: [number, number, number][] = [
  [0.4, 0.43, 0.36],
  [0.62, 0.45, 0.22],
  [0.22, 0.21, 0.18],
  [0.58, 0.62, 0.66],
];
/** Sparrow, bulbul, bee-eater, hoopoe, goldfinch: the colour of the bird as a whole. */
const SONGBIRD: [number, number, number][] = [
  [0.62, 0.48, 0.32],
  [0.42, 0.38, 0.34],
  [0.35, 0.68, 0.36],
  [0.88, 0.62, 0.46],
  [0.75, 0.62, 0.3],
];

let flockId = 1;

export class AmbientLife {
  list: Critter[] = [];
  rings: Ring[] = [];
  /** Who is near, worked out each frame: [x, z, radius on foot or 0, vehicle speed]. */
  private threats: number[] = [];
  private foci: { x: number; z: number; foot: boolean; speed: number; idx: number }[] = [];
  private spawnT = 0;
  private hopT = 0;
  private leapT = 2;
  private counts = new Map<CritterKind, number>();
  private time = 0;
  /** Spawning on and off (tests, a quiet title screen). */
  enabled = true;

  constructor(private ctx: Ctx) {}

  /** The ground as it is drawn, so a crab on a river bed or a lizard on a rock is not sunk into the mesh. */
  private ground(x: number, z: number) {
    const c = this.ctx;
    return c.drawnGroundAt ? c.drawnGroundAt(x, z) : c.groundAt(x, z);
  }

  /** A ring spreading on the water at (x, z) (`y` its level). For anyone: a duck coming down, a frog going in, a fish rising. */
  ripple(x: number, y: number, z: number, r = 1, k = 1) {
    if (this.rings.length >= 60) this.rings.shift();
    this.rings.push({ x, y: y + 0.015, z, r, age: 0, life: 1.2 + r * 0.35, k });
  }

  count(kind: CritterKind) {
    return this.counts.get(kind) ?? 0;
  }

  /** The nearest small lizard (not a monitor) within `r` of a point that a quick hand could still snatch, or null. */
  lizardNear(x: number, z: number, r: number): Critter | null {
    let best: Critter | null = null;
    let bd = r;
    for (const c of this.list) {
      if (c.kind !== 'lizard' || c.ref === 3 || c.state === 3) continue;
      const d = Math.hypot(c.x - x, c.z - z);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  }

  /** Snatch a lizard off the ground: it is gone from the world (into someone's hand). False if it already got away. */
  catchLizard(c: Critter): boolean {
    if (c.state === 3 || !this.list.includes(c)) return false;
    c.state = 3;
    c.timer = 0;
    return true;
  }

  /** Put a group of `kind` at (x, z) now, whatever the hour (for tests and the debug console). Some kinds need their ground: a bank, water. */
  spawnAt(kind: CritterKind, x: number, z: number) {
    this.spawnKind(kind, this.habitat(x, z));
  }

  update(dt: number) {
    if (dt <= 0) return;
    const ctx = this.ctx;
    this.time += dt;
    this.gatherFoci();
    // Leave what nobody is near, and what the hour or the weather has ended.
    const night = ctx.night;
    const storm = ctx.storm;
    const day = 1 - night;
    this.counts.clear();
    for (let i = this.list.length - 1; i >= 0; i--) {
      const c = this.list[i];
      const R = RANGE[c.kind];
      let gone = c.state === 3;
      if (!gone) {
        let d = Infinity;
        for (const f of this.foci) d = Math.min(d, Math.hypot(f.x - c.x, f.z - c.z));
        if (d > R.far * 1.25) gone = true;
      }
      if (!gone && (c.kind === 'butterfly' || c.kind === 'bees' || c.kind === 'dragonfly') && (night > 0.5 || storm > 0.5)) gone = c.state !== 2 && Math.random() < dt * 0.5;
      if (!gone && c.kind === 'fireflies' && night < 0.2) gone = Math.random() < dt * 0.3;
      if (!gone && c.kind === 'bat' && night < 0.35) gone = true;
      if (!gone && (c.kind === 'songbird' || c.kind === 'pigeon' || c.kind === 'swallow' || c.kind === 'lizard' || c.kind === 'perched' || c.kind === 'wagtail' || c.kind === 'kingfisher' || c.kind === 'damselfly') && night > 0.7 && c.state === 0) gone = Math.random() < dt * 0.2;
      if (!gone && c.kind === 'snake' && c.ref === 2 && night > 0.7 && c.state === 0) gone = Math.random() < dt * 0.2;
      if (gone) {
        this.list[i] = this.list[this.list.length - 1];
        this.list.pop();
        continue;
      }
      this.counts.set(c.kind, (this.counts.get(c.kind) ?? 0) + 1);
    }
    for (const c of this.list) this.step(c, dt);
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.age += dt;
      if (r.age >= r.life) this.rings.splice(i, 1);
    }
    if (!this.enabled || !this.foci.length) return;
    this.carrion();
    this.grasshoppers(dt, day);
    this.leaps(dt, night);
    this.spawnT -= dt;
    if (this.spawnT <= 0) {
      this.spawnT = 0.09;
      // One look close by (where the small things live), one further out.
      this.trySpawn(day, night, storm, true);
      this.trySpawn(day, night, storm, false);
    }
  }

  // ------------------------------------------------------------------ who is near

  private gatherFoci() {
    this.foci.length = 0;
    this.threats.length = 0;
    for (const p of this.ctx.players) {
      if (!p.alive) continue;
      const v = p.vehicle;
      const x = v ? v.position.x : p.pos.x;
      const z = v ? v.position.z : p.pos.z;
      const speed = v ? Math.abs(v.speed) : p.moveSpeed;
      this.foci.push({ x, z, foot: !v, speed, idx: p.index });
      // Someone creeping up crouched spooks the small life only when much closer.
      this.threats.push(x, z, v ? 0 : p.crouch ? 0.4 : 1, speed);
    }
    // A car parked or driving anywhere near counts as well (the convoy's other vehicles, a raider).
    for (const v of this.ctx.vehicles) {
      if (v.wreck || Math.abs(v.speed) < 1) continue;
      this.threats.push(v.position.x, v.position.z, 0, Math.abs(v.speed));
    }
  }

  /** The nearest threat to (x, z) within `foot` metres of someone on foot or `veh` of a moving vehicle, or null. */
  private threat(x: number, z: number, foot: number, veh: number): { x: number; z: number } | null {
    const t = this.threats;
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < t.length; i += 4) {
      const d = Math.hypot(t[i] - x, t[i + 1] - z);
      const lim = t[i + 2] ? foot * t[i + 2] : t[i + 3] > 1.5 ? veh : foot * 1.5;
      if (d < lim && d < bd) {
        bd = d;
        best = i;
      }
    }
    return best >= 0 ? { x: t[best], z: t[best + 1] } : null;
  }

  private habitat(x: number, z: number): Habitat {
    const ctx = this.ctx;
    const T = ctx.terrain;
    const water = ctx.waterAt(x, z);
    let living = !!water && LIVE_WATER.has(water.kind ?? 'lake');
    if (living && water && (water.kind ?? 'lake') === 'lake' && T) {
      const style = lakeWater(T.lakes, x, z)?.lake?.style;
      if (style === 'brine' || style === 'ash') living = false;
    }
    const green = !!T?.hydro?.lush;
    const ground = this.ground(x, z);
    return {
      x,
      z,
      ground,
      water,
      living,
      lush: green && T ? lushAt(T, x, z) : 0,
      forest: green && T ? forestAt(T, x, z) : 0,
      // Without the green country's water raster (the old legs, tests) a bank within a few metres counts as near.
      near: green && T ? smoothstep(30, 100, wetReach(T, x, z)) : water ? 1 : this.bankTo(x, z, 3) !== null ? 0.8 : 0,
      city: T?.open ? districtMask(T.open, x, z) > 0.5 : ctx.biome === 'city',
      indoors: !!ctx.interiorAt?.(x, z, ground + 0.5),
    };
  }

  /** The way to water within a couple of metres of a dry point, as an angle, or null if there is none (a bank to sit on). */
  private bankTo(x: number, z: number, r = 1.6): number | null {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const w = this.ctx.waterAt(x + Math.cos(a) * r, z + Math.sin(a) * r);
      if (w && w.depth > 0.12 && LIVE_WATER.has(w.kind ?? 'lake')) return a;
    }
    return null;
  }

  // ------------------------------------------------------------------ spawning

  private density() {
    const R = this.ctx.R;
    const q = R ? QUALITY[R.quality]?.scatter ?? 0.65 : 0.65;
    return 0.45 + 0.55 * q;
  }

  private room(kind: CritterKind, n = 1) {
    return this.count(kind) + n <= Math.ceil(RANGE[kind].cap * this.density());
  }

  private add(kind: CritterKind, x: number, y: number, z: number, init: Partial<Critter> = {}): Critter {
    const c: Critter = {
      kind,
      x,
      y,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: Math.random() * Math.PI * 2,
      hx: x,
      hy: y,
      hz: z,
      tx: x,
      ty: y,
      tz: z,
      state: 0,
      timer: Math.random() * 2,
      age: 0,
      prog: 0,
      phase: Math.random() * 6.28,
      size: 1,
      r: 1,
      g: 1,
      b: 1,
      flock: 0,
      level: 0,
      ref: -1,
      seed: Math.random(),
      ...init,
    };
    this.list.push(c);
    this.counts.set(kind, this.count(kind) + 1);
    return c;
  }

  /** Look at one random spot near a player and put there whatever lives on such ground at this hour, if there is room. */
  private trySpawn(day: number, night: number, storm: number, close: boolean) {
    const f = this.foci[Math.floor(Math.random() * this.foci.length)];
    const ang = Math.random() * Math.PI * 2;
    const dist = close ? 2 + Math.sqrt(Math.random()) * 16 : 3 + Math.sqrt(Math.random()) * 60;
    const x = f.x + Math.cos(ang) * dist;
    const z = f.z + Math.sin(ang) * dist;
    // Never pop in right in front of anyone: small things close by, big things only further out or out of view.
    const h = this.habitat(x, z);
    if (h.indoors) return;
    const calm = storm < 0.45;
    const dusk = smoothstep(0.1, 0.4, night) * (1 - smoothstep(0.7, 0.95, night));
    const opts: [CritterKind, number][] = [];
    const fits = (k: CritterKind) => dist >= RANGE[k].near && dist <= RANGE[k].far && this.room(k);
    const w = h.water;
    if (w && w.depth > 0.05) {
      const slow = !w.flow || Math.hypot(w.flow[0], w.flow[1]) < 0.25;
      const wk = w.kind ?? 'lake';
      if (h.living && w.depth > 0.5 && fits('fish')) opts.push(['fish', 3]);
      // The bed and the surface of shallow water.
      if (h.living && w.depth < 0.75 && (wk === 'stream' || wk === 'river' || wk === 'spring') && fits('crab')) opts.push(['crab', 2 + night * 2]);
      if (h.living && w.depth < 0.55 && slow && wk !== 'river' && fits('tadpole')) opts.push(['tadpole', wk === 'lake' ? 0.6 : 2]);
      if (h.living && slow && day > 0.4 && calm && fits('skater')) opts.push(['skater', wk === 'lake' || wk === 'stream' ? 0.8 : 2]);
      if (h.living && w.depth > 0.4 && wk !== 'spring' && day > 0.5 && calm && fits('kingfisher')) opts.push(['kingfisher', 0.7]);
      if (h.living && w.depth < 0.5 && slow && day > 0.45 && calm && fits('damselfly')) opts.push(['damselfly', 1.4]);
      if (h.living && day > 0.4 && calm && w.depth < 1.6 && fits('dragonfly')) opts.push(['dragonfly', 2]);
      if (h.living && fits('swallow') && day > 0.3 && calm) opts.push(['swallow', 0.6 + dusk]);
      if (night > 0.55 && fits('bat')) opts.push(['bat', 1.5]);
      if ((w.kind === 'swamp' || dusk > 0.3) && fits('midges') && calm) opts.push(['midges', w.kind === 'swamp' ? 1.5 : 0.6]);
      if (night > 0.35 && w.kind === 'swamp' && fits('fireflies')) opts.push(['fireflies', 1.2]);
    } else if (!h.city) {
      const bank = h.near > 0.6 ? this.bankTo(x, z) : null;
      if (bank !== null) {
        if (fits('frog')) opts.push(['frog', 2 + night * 2]);
        if (fits('crab')) opts.push(['crab', 1.6 + night * 1.5]);
        if (day > 0.5 && fits('wagtail')) opts.push(['wagtail', 1.4]);
        // Small birds and doves come down to drink at the edge.
        if (day > 0.5 && fits('songbird')) opts.push(['songbird', 1.2]);
        if (day > 0.45 && calm && fits('damselfly')) opts.push(['damselfly', 2]);
        if (day > 0.5 && fits('turtle')) opts.push(['turtle', 0.8]);
        if (day > 0.4 && calm && fits('dragonfly')) opts.push(['dragonfly', 1.2]);
      }
      if (day > 0.5 && calm && h.lush > 0.45 && h.forest < 0.7 && fits('butterfly')) opts.push(['butterfly', 3 * h.lush]);
      if (day > 0.5 && calm && h.lush > 0.55 && h.forest < 0.5 && fits('bees')) opts.push(['bees', 1.2 * h.lush]);
      if (night > 0.35 && (h.lush > 0.3 || h.near > 0.4) && fits('fireflies')) opts.push(['fireflies', 1.6 * Math.max(h.lush, h.near)]);
      if (day > 0.5 && fits('songbird')) opts.push(['songbird', 0.4 + h.lush * 1.6 + h.forest * 0.6]);
      if (day > 0.4 && calm && h.near > 0.5 && fits('swallow')) opts.push(['swallow', 0.5 + dusk]);
      if (night > 0.55 && (h.forest > 0.2 || h.near > 0.4) && fits('bat')) opts.push(['bat', 1]);
      if (day > 0.6 && h.lush < 0.35 && fits('lizard')) opts.push(['lizard', 2 * (1 - h.lush) * (0.6 + this.ctx.heat * 0.8)]);
      // Snakes: vipers in the dry country (and out at night, as they are), whip snakes by day anywhere warm. A viper is
      // at home in the fields and scrub of the green country too, but fewer there.
      if ((day > 0.6 || night > 0.5) && fits('snake')) opts.push(['snake', (h.lush < 0.4 ? 0.7 : h.forest < 0.3 ? 0.15 : 0.04) * (0.6 + this.ctx.heat * 0.8) * (night > 0.5 ? 1.3 : 1)]);
      // Birds in the trees: any tree near the spot.
      if (day > 0.45 && fits('perched') && this.ctx.treesNear && this.ctx.treesNear(x, z, 10).length) opts.push(['perched', 2.6]);
      if (dusk > 0.2 && h.forest > 0.3 && calm && fits('midges')) opts.push(['midges', 0.6]);
    } else {
      if (day > 0.45 && fits('pigeon')) opts.push(['pigeon', 3]);
      if (night > 0.55 && fits('bat')) opts.push(['bat', 0.8]);
      if (day > 0.6 && fits('lizard')) opts.push(['lizard', 0.4]);
    }
    if (!opts.length) return;
    let sum = 0;
    for (const o of opts) sum += o[1];
    let r = Math.random() * sum;
    let kind = opts[0][0];
    for (const o of opts) {
      r -= o[1];
      if (r <= 0) {
        kind = o[0];
        break;
      }
    }
    // Things big enough to notice appear out of view.
    const big = kind === 'songbird' || kind === 'pigeon' || kind === 'turtle' || kind === 'swallow' || kind === 'bat' || kind === 'kingfisher' || kind === 'wagtail' || kind === 'perched' || kind === 'snake';
    if (big && dist < 30 && this.ctx.visibleToAnyView(x, h.ground + 1, z, 4)) return;
    this.spawnKind(kind, h);
  }

  private spawnKind(kind: CritterKind, h: Habitat) {
    const { x, z } = h;
    const fl = flockId++;
    const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
    switch (kind) {
      case 'butterfly': {
        const n = 1 + Math.floor(Math.random() * 3);
        const c = pick(BUTTERFLY);
        for (let i = 0; i < n && this.room(kind); i++) {
          const px = x + (Math.random() - 0.5) * 4;
          const pz = z + (Math.random() - 0.5) * 4;
          const y = this.ground(px, pz) + 0.4 + Math.random();
          this.add(kind, px, y, pz, { size: 0.03 + Math.random() * 0.018, r: c[0], g: c[1], b: c[2], flock: fl, state: 1 });
        }
        return;
      }
      case 'bees':
        this.add(kind, x, h.ground, z, { size: 4 + Math.floor(Math.random() * 5), flock: fl });
        return;
      case 'dragonfly': {
        const c = pick(DRAGON);
        const base = h.water ? h.water.level : h.ground;
        this.add(kind, x, base + 0.5 + Math.random() * 0.6, z, { size: 0.06 + Math.random() * 0.025, r: c[0], g: c[1], b: c[2], level: base, timer: Math.random() });
        return;
      }
      case 'fireflies': {
        const n = 6 + Math.floor(Math.random() * 10);
        const base = h.water ? h.water.level : h.ground;
        for (let i = 0; i < n; i++) {
          const px = x + (Math.random() - 0.5) * 14;
          const pz = z + (Math.random() - 0.5) * 14;
          const g = this.ctx.waterAt(px, pz)?.level ?? this.ground(px, pz);
          this.add(kind, px, g + 0.3 + Math.random() * 2, pz, { flock: fl, level: base, size: 2 + Math.random() * 2.5, phase: Math.random() * 10 });
        }
        return;
      }
      case 'midges': {
        const base = h.water ? h.water.level : h.ground;
        this.add(kind, x, base + 1.3 + Math.random() * 1.2, z, { size: 16 + Math.floor(Math.random() * 14), level: base });
        return;
      }
      case 'songbird': {
        // At the water's edge: a party come down to drink, doves among them, keeping to the edge.
        const atBank = h.near > 0.5 && this.bankTo(x, z) !== null;
        const n = atBank ? 3 + Math.floor(Math.random() * 6) : 4 + Math.floor(Math.random() * 8);
        if (!this.room(kind, n)) return;
        if (atBank) {
          const dove = Math.random() < 0.4;
          for (let i = 0; i < n; i++) {
            const px = x + (Math.random() - 0.5) * 4;
            const pz = z + (Math.random() - 0.5) * 4;
            if (this.ctx.waterAt(px, pz) || this.bankTo(px, pz, 1.5) === null) continue;
            const c = dove ? ([0.68, 0.53, 0.47] as const) : pick(SONGBIRD.slice(0, 3));
            const v = 0.85 + Math.random() * 0.3;
            this.add(kind, px, this.ground(px, pz), pz, { size: (dove ? 0.2 : 0.12 + Math.random() * 0.03) * 1, r: c[0] * v, g: c[1] * v, b: c[2] * v, flock: fl, timer: Math.random() * 2, ref: 3 });
          }
          return;
        }
        // What kind of bird by the ground: bee-eaters by water, hoopoes on the bare edge of the green, sparrows and bulbuls
        // anywhere, goldfinches in the flowers.
        const c = h.near > 0.6 && Math.random() < 0.5 ? SONGBIRD[2] : h.lush < 0.35 && Math.random() < 0.5 ? SONGBIRD[3] : h.lush > 0.6 && Math.random() < 0.3 ? SONGBIRD[4] : pick(SONGBIRD.slice(0, 2));
        const big = c === SONGBIRD[3] ? 1.5 : c === SONGBIRD[2] ? 1.25 : 1;
        for (let i = 0; i < n; i++) {
          const px = x + (Math.random() - 0.5) * 7;
          const pz = z + (Math.random() - 0.5) * 7;
          if (this.ctx.waterAt(px, pz)) continue;
          const v = 0.85 + Math.random() * 0.3;
          this.add(kind, px, this.ground(px, pz), pz, { size: (0.12 + Math.random() * 0.03) * big, r: c[0] * v, g: c[1] * v, b: c[2] * v, flock: fl, timer: Math.random() * 2 });
        }
        return;
      }
      case 'pigeon': {
        const n = 6 + Math.floor(Math.random() * 9);
        if (!this.room(kind, n)) return;
        for (let i = 0; i < n; i++) {
          const px = x + (Math.random() - 0.5) * 9;
          const pz = z + (Math.random() - 0.5) * 9;
          const gy = this.ground(px, pz);
          if (this.ctx.interiorAt?.(px, pz, gy + 0.5)) continue;
          const tone = Math.random();
          // Mostly blue-grey, some darker or chequered, the odd white or brown one.
          const c: [number, number, number] = tone < 0.08 ? [0.92, 0.9, 0.86] : tone < 0.16 ? [0.55, 0.42, 0.34] : tone < 0.4 ? [0.38, 0.4, 0.44] : [0.58, 0.6, 0.66];
          this.add(kind, px, gy, pz, { size: 0.3 + Math.random() * 0.04, r: c[0], g: c[1], b: c[2], flock: fl, timer: Math.random() * 3 });
        }
        return;
      }
      case 'swallow': {
        const n = 3 + Math.floor(Math.random() * 4);
        const base = h.water ? h.water.level : h.ground;
        for (let i = 0; i < n && this.room(kind); i++)
          this.add(kind, x, base + 2, z, { size: 0.16, r: 0.2, g: 0.22, b: 0.34, flock: fl, level: base, phase: Math.random() * 6.28, seed: Math.random(), state: 1 });
        return;
      }
      case 'bat': {
        const n = 2 + Math.floor(Math.random() * 4);
        const base = h.water ? h.water.level : h.ground;
        for (let i = 0; i < n && this.room(kind); i++) this.add(kind, x, base + 4, z, { size: 0.13, r: 0.2, g: 0.16, b: 0.14, flock: fl, level: base, state: 1 });
        return;
      }
      case 'fish': {
        const w = h.water!;
        const spring = w.kind === 'spring';
        const n = spring ? 6 + Math.floor(Math.random() * 8) : 3 + Math.floor(Math.random() * 6);
        if (!this.room(kind, n)) return;
        const c = spring ? ([0.3, 0.38, 0.4] as [number, number, number]) : pick(FISH);
        const len = spring ? 0.09 + Math.random() * 0.07 : 0.16 + Math.random() * 0.3;
        // Catfish and carp grub along the bed; the rest swim up in the water.
        const bottom = !spring && (c === FISH[2] || Math.random() < 0.25) ? 1 : 0;
        for (let i = 0; i < n; i++) {
          const v = 0.9 + Math.random() * 0.2;
          const f = this.add(kind, x + (Math.random() - 0.5) * 2, w.level - this.swimDepth(w.depth), z + (Math.random() - 0.5) * 2, {
            size: len * (0.85 + Math.random() * 0.3),
            r: c[0] * v,
            g: c[1] * v,
            b: c[2] * v,
            flock: fl,
            level: w.level,
            hx: x,
            hz: z,
            ref: bottom,
          });
          f.ty = w.depth;
        }
        return;
      }
      case 'tadpole': {
        const w = h.water!;
        const n = 8 + Math.floor(Math.random() * 13);
        if (!this.room(kind, n)) return;
        for (let i = 0; i < n; i++) {
          const px = x + (Math.random() - 0.5) * 1.6;
          const pz = z + (Math.random() - 0.5) * 1.6;
          const pw = this.ctx.waterAt(px, pz);
          if (!pw || pw.depth < 0.05) continue;
          const t = this.add(kind, px, pw.level - pw.depth + 0.05, pz, { size: 0.026 + Math.random() * 0.014, r: 0.16, g: 0.14, b: 0.11, flock: fl, level: pw.level, hx: x, hz: z });
          t.ty = pw.depth;
        }
        void w;
        return;
      }
      case 'crab': {
        const n = 1 + (Math.random() < 0.35 ? 1 : 0);
        for (let i = 0; i < n && this.room(kind); i++) {
          const px = x + (Math.random() - 0.5) * 2;
          const pz = z + (Math.random() - 0.5) * 2;
          const pw = this.ctx.waterAt(px, pz);
          // On the bed of shallow running water, or on the bank right by it.
          if (pw ? pw.depth > 0.8 : this.bankTo(px, pz, 1.2) === null) continue;
          // Olive-brown, or the rust-red ones.
          const red = Math.random() < 0.35;
          this.add(kind, px, this.ground(px, pz), pz, { size: 0.065 + Math.random() * 0.04, r: red ? 0.5 : 0.38, g: red ? 0.24 : 0.32, b: red ? 0.13 : 0.18, timer: 1 + Math.random() * 3 });
        }
        return;
      }
      case 'skater': {
        const n = 3 + Math.floor(Math.random() * 6);
        if (!this.room(kind, n)) return;
        for (let i = 0; i < n; i++) {
          const px = x + (Math.random() - 0.5) * 3;
          const pz = z + (Math.random() - 0.5) * 3;
          const pw = this.ctx.waterAt(px, pz);
          if (!pw || pw.depth < 0.03 || (pw.flow && Math.hypot(pw.flow[0], pw.flow[1]) > 0.3)) continue;
          this.add(kind, px, pw.level + 0.004, pz, { size: 0.017 + Math.random() * 0.006, flock: fl, level: pw.level, timer: Math.random() * 1.5 });
        }
        return;
      }
      case 'frog':
      case 'turtle': {
        const toWater = this.bankTo(x, z);
        if (toWater === null) return;
        const n = kind === 'frog' ? 1 + Math.floor(Math.random() * 3) : 1 + (Math.random() < 0.3 ? 1 : 0);
        for (let i = 0; i < n && this.room(kind); i++) {
          let px = x + (Math.random() - 0.5) * (kind === 'frog' ? 3 : 2);
          let pz = z + (Math.random() - 0.5) * (kind === 'frog' ? 3 : 2);
          if (this.ctx.waterAt(px, pz)) {
            // In the water: step back up the bank.
            px -= Math.cos(toWater) * 1.2;
            pz -= Math.sin(toWater) * 1.2;
            if (this.ctx.waterAt(px, pz)) continue;
          }
          // Right at the edge, or not at all: one jump and it is in.
          const a = this.bankTo(px, pz);
          if (a === null) continue;
          const tone = Math.random();
          const col: [number, number, number] = kind === 'frog' ? (tone < 0.6 ? [0.38, 0.58, 0.22] : [0.5, 0.44, 0.26]) : [0.95, 0.95, 0.9];
          this.add(kind, px, this.ground(px, pz), pz, {
            size: kind === 'frog' ? 0.06 + Math.random() * 0.025 : 0.2 + Math.random() * 0.13,
            yaw: Math.atan2(Math.cos(a), Math.sin(a)),
            r: col[0],
            g: col[1],
            b: col[2],
            // The way to the water, for when it goes.
            tx: Math.cos(a),
            tz: Math.sin(a),
          });
        }
        return;
      }
      case 'lizard': {
        // Which lizard: a fringe-toed lizard on the sand, otherwise an agama on the rocks, now and then a spiny-tailed lizard
        // by its burrow, and rarely a desert monitor, a metre of it.
        const sand = this.ctx.surfaceAt?.(x, z).name === 'sand';
        const roll = Math.random();
        const sp = sand && roll < 0.7 ? 1 : h.lush < 0.15 && roll < 0.12 ? 3 : h.lush < 0.25 && roll < 0.32 ? 2 : 0;
        const look: [number, number, number, number, number][] = [
          [0.52, 0.47, 0.4, 0.22, 0.1],
          [0.86, 0.76, 0.56, 0.16, 0.05],
          [0.78, 0.64, 0.36, 0.45, 0.12],
          [0.64, 0.56, 0.4, 0.95, 0.3],
        ];
        const [r, g, b, s0, sv] = look[sp];
        this.add(kind, x, h.ground, z, { size: s0 + Math.random() * sv, r, g, b, timer: 1 + Math.random() * 3, ref: sp });
        return;
      }
      case 'snake': {
        // Horned viper on the sand, a viper on the stony ground, a whip snake anywhere (and the only one in the green).
        const sand = this.ctx.surfaceAt?.(x, z).name === 'sand';
        const dark = this.ctx.night > 0.5;
        // Night is the vipers'; the whip snake hunts by day.
        const sp = sand ? 0 : dark ? 1 : h.lush > 0.4 ? (Math.random() < 0.5 ? 1 : 2) : Math.random() < 0.6 ? 1 : 2;
        const look: [number, number, number, number, number, number][] = [
          [0.84, 0.74, 0.56, 0.55, 0.15, 1.5],
          [0.6, 0.5, 0.35, 0.8, 0.3, 1.7],
          [0.1, 0.1, 0.11, 1.4, 0.5, 1.15],
        ];
        const [r, g, b, l0, lv, thick] = look[sp];
        this.add(kind, x, h.ground, z, { size: l0 + Math.random() * lv, r, g, b, ref: sp, level: thick, timer: 2 + Math.random() * 6 });
        return;
      }
      case 'wagtail': {
        const n = 1 + (Math.random() < 0.4 ? 1 : 0);
        const yellow = Math.random() < 0.3;
        for (let i = 0; i < n; i++) {
          const px = x + (Math.random() - 0.5) * 3;
          const pz = z + (Math.random() - 0.5) * 3;
          if (this.ctx.waterAt(px, pz) || this.bankTo(px, pz, 1.5) === null) continue;
          this.add(kind, px, this.ground(px, pz), pz, { size: 0.13, r: yellow ? 0.85 : 0.6, g: yellow ? 0.78 : 0.61, b: yellow ? 0.35 : 0.63, flock: fl, timer: Math.random(), ref: 4 });
        }
        return;
      }
      case 'kingfisher': {
        const w = h.water!;
        this.add(kind, x, w.level + 4, z, { size: 0.17, r: 0.72, g: 0.72, b: 0.74, level: w.level, hy: w.level + 3.5 + Math.random() * 2, timer: 2 + Math.random() * 3 });
        return;
      }
      case 'damselfly': {
        const n = 2 + Math.floor(Math.random() * 4);
        const col = pick<[number, number, number]>([
          [0.25, 0.5, 1],
          [0.2, 0.78, 0.55],
          [0.85, 0.2, 0.2],
        ]);
        for (let i = 0; i < n && this.room(kind); i++) {
          const px = x + (Math.random() - 0.5) * 3;
          const pz = z + (Math.random() - 0.5) * 3;
          const pw = this.ctx.waterAt(px, pz);
          const base = pw ? pw.level : this.ground(px, pz);
          this.add(kind, px, base + 0.35 + Math.random() * 0.5, pz, { size: 0.045 + Math.random() * 0.01, r: col[0], g: col[1], b: col[2], level: base, timer: Math.random() * 4 });
        }
        return;
      }
      case 'perched': {
        const trees = this.ctx.treesNear?.(x, z, 12) ?? [];
        if (!trees.length) return;
        const t = pick(trees);
        const sp = TREE_SPECIES[t.sp];
        const group = sp === 'palm' ? 'palm' : sp === 'pine' ? 'pine' : sp === 'snag' || sp === 'acacia' ? 'dry' : 'broad';
        const c = pick(PERCHERS[group]);
        const crow = c[0] < 0.5 && c[2] > 0.45;
        const n = crow ? 1 + Math.floor(Math.random() * 3) : 2 + Math.floor(Math.random() * 5);
        if (!this.room(kind, n)) return;
        for (let i = 0; i < n; i++) {
          const p = this.perchOn(t);
          const v = 0.85 + Math.random() * 0.3;
          this.add(kind, p.x, p.y, p.z, { size: crow ? 0.36 : c === PERCHERS.palm[0] ? 0.22 : 0.13 + Math.random() * 0.03, r: c[0] * v, g: c[1] * v, b: c[2] * v, flock: fl, timer: 1 + Math.random() * 4 });
        }
        return;
      }
    }
  }

  /**
   * A place to sit on a tree, on the outside of its crown where a bird would be seen: the upper half of a broadleaf's dome
   * (a poplar's or a cypress's column is a tall narrow one), the flank of a pine's cone, out along a palm's fronds, the flat
   * top of an acacia, a dead snag's bare branches.
   */
  private perchOn(t: TreeSpot): { x: number; y: number; z: number } {
    const sp = TREE_SPECIES[t.sp];
    const dim = TREE_DIMS[sp];
    const H = dim.h * t.s;
    const R = dim.crown * t.s;
    const bole = dim.bole * t.s;
    const a = Math.random() * Math.PI * 2;
    let r: number;
    let y: number;
    if (sp === 'palm') {
      r = R * (0.3 + Math.random() * 0.35);
      y = H * 0.92 - (r / R) * 0.6;
    } else if (sp === 'snag') {
      r = 0.3 + Math.random() * 0.7;
      y = bole + (H - bole) * (0.3 + Math.random() * 0.6);
    } else if (sp === 'acacia') {
      r = Math.random() * R * 0.8;
      y = H * 1.0;
    } else if (sp === 'pine') {
      const yy = bole + (H - bole) * (0.45 + Math.random() * 0.5);
      r = (R * (H - yy)) / Math.max(1, H - bole) + 0.1;
      y = yy;
    } else {
      const cy = bole + (H - bole) * 0.5;
      const ry = (H - bole) * 0.5;
      const el = Math.random() * 1.25;
      r = R * Math.cos(el) * 1.02;
      y = cy + ry * Math.sin(el) * 1.02;
    }
    // A tree leaning out over a river carries its crown with it.
    const [lx, lz] = leanOffset(t, y);
    return { x: t.x + lx + Math.cos(a) * r, y: t.y + y, z: t.z + lz + Math.sin(a) * r };
  }

  /**
   * A bird flying from (hx, hy, hz) to (tx, ty, tz): a bowed line with a rise in the middle (`arc` metres) and, for a finch,
   * a dipping flight. `prog` is the seconds into it. Returns true on arrival.
   */
  private flight(c: Critter, dt: number, speed: number, arc: number, dip: number) {
    c.prog += dt;
    const len = Math.max(1, Math.hypot(c.tx - c.hx, c.tz - c.hz));
    const s = clamp((c.prog * speed) / len, 0, 1);
    const ux = (c.tx - c.hx) / len;
    const uz = (c.tz - c.hz) / len;
    const bow = Math.sin(s * Math.PI) * len * 0.12 * (c.flock % 2 ? 1 : -1);
    const nx = c.hx + (c.tx - c.hx) * s - uz * bow;
    const nz = c.hz + (c.tz - c.hz) * s + ux * bow;
    c.vx = (nx - c.x) / dt;
    c.vz = (nz - c.z) / dt;
    c.x = nx;
    c.z = nz;
    const d = dip ? Math.abs(Math.sin(c.prog * 5 + c.seed * 6)) * dip * Math.sin(s * Math.PI) : 0;
    c.y = Math.max(this.ground(c.x, c.z) + 0.05, c.hy + (c.ty - c.hy) * s + Math.pow(Math.sin(s * Math.PI), 0.6) * arc - d);
    if (Math.hypot(c.vx, c.vz) > 0.3) c.yaw += wrapAngle(Math.atan2(c.vx, c.vz) - c.yaw) * Math.min(1, dt * 8);
    return s >= 1;
  }

  /** How far under the surface a fish keeps in water this deep. */
  private swimDepth(depth: number) {
    return clamp(depth * 0.4, 0.15, Math.min(0.9, depth - 0.12));
  }

  /** Flies find every fresh carcass near a player. */
  private carrion() {
    const W = this.ctx.wildlife;
    if (!W) return;
    for (const a of W.list) {
      if (!a.dead || a.butchered || a.deadT < 3) continue;
      if (this.list.some((c) => c.kind === 'flies' && c.ref === a.id)) continue;
      if (!this.foci.some((f) => Math.hypot(f.x - a.x, f.z - a.z) < RANGE.flies.far)) continue;
      if (!this.room('flies')) return;
      this.add('flies', a.x, a.y + 0.2, a.z, { ref: a.id, size: 8 + Math.floor(Math.random() * 6) });
    }
  }

  /** Grasshoppers spring out of the grass ahead of anyone walking through it by day. */
  private grasshoppers(dt: number, day: number) {
    this.hopT -= dt;
    if (this.hopT > 0 || day < 0.5) return;
    this.hopT = 0.35 + Math.random() * 0.6;
    for (const f of this.foci) {
      if (!f.foot || f.speed < 0.8 || !this.room('hopper')) continue;
      const p = this.ctx.players.find((q) => q.index === f.idx);
      if (!p) continue;
      const h = this.habitat(f.x, f.z);
      if (h.city || h.water || h.indoors) continue;
      const grass = h.lush > 0.2 ? 1 : 0.35;
      if (Math.random() > grass) continue;
      const a = p.yaw + (Math.random() - 0.5) * 2.4;
      const d = 0.8 + Math.random() * 1.6;
      const x = f.x + Math.sin(a) * d;
      const z = f.z + Math.cos(a) * d;
      const out = a + (Math.random() - 0.5) * 1.6;
      const green = h.lush > 0.4 && Math.random() < 0.7;
      const c = this.add('hopper', x, this.ground(x, z), z, { size: 0.035 + Math.random() * 0.02, r: green ? 0.45 : 0.72, g: green ? 0.6 : 0.6, b: green ? 0.24 : 0.36, yaw: out });
      this.jump(c, 1.6 + Math.random() * 1.2, 2 + Math.random());
    }
  }

  /** Now and then a fish jumps clear of a lake or a river and drops back with a plop and a ring. More of them at dusk. */
  private leaps(dt: number, night: number) {
    this.leapT -= dt * (1 + smoothstep(0.1, 0.5, night) * (1 - smoothstep(0.75, 1, night)) * 2);
    if (this.leapT > 0) return;
    this.leapT = 2 + Math.random() * 6;
    if (!this.room('leap')) return;
    const f = this.foci[Math.floor(Math.random() * this.foci.length)];
    for (let k = 0; k < 6; k++) {
      const a = Math.random() * Math.PI * 2;
      const d = RANGE.leap.near + Math.random() * (RANGE.leap.far - RANGE.leap.near);
      const x = f.x + Math.cos(a) * d;
      const z = f.z + Math.sin(a) * d;
      const w = this.ctx.waterAt(x, z);
      if (!w || w.depth < 0.8 || (w.kind !== 'lake' && w.kind !== 'river' && w.kind !== 'swamp')) continue;
      const h = this.habitat(x, z);
      if (!h.living) continue;
      const c = this.pickFish();
      this.add('leap', x, w.level - 0.1, z, { size: 0.2 + Math.random() * 0.25, yaw: Math.random() * Math.PI * 2, level: w.level, r: c[0], g: c[1], b: c[2], timer: 0.5 + Math.random() * 0.25, state: 1 });
      this.ripple(x, w.level, z, 0.6);
      return;
    }
  }

  private pickFish() {
    return FISH[Math.floor(Math.random() * FISH.length)];
  }

  /** Throw a small thing into the air along its yaw: `speed` forward, `up` upward. */
  private jump(c: Critter, speed: number, up: number) {
    c.vx = Math.sin(c.yaw) * speed;
    c.vz = Math.cos(c.yaw) * speed;
    c.vy = up;
    c.state = 1;
  }

  // ------------------------------------------------------------------ behaviour

  private step(c: Critter, dt: number) {
    // Snakes are the game's: `tick` moves them.
    if (c.kind === 'snake') return;
    c.age += dt;
    c.timer -= dt;
    switch (c.kind) {
      case 'butterfly':
        return this.stepButterfly(c, dt);
      case 'dragonfly':
        return this.stepDragonfly(c, dt);
      case 'fireflies':
        return this.stepFirefly(c, dt);
      case 'hopper':
        return this.stepHopper(c, dt);
      case 'songbird':
      case 'pigeon':
        return this.stepGroundBird(c, dt);
      case 'swallow':
      case 'bat':
        return this.stepHawker(c, dt);
      case 'fish':
      case 'tadpole':
        return this.stepFish(c, dt);
      case 'crab':
        return this.stepCrab(c, dt);
      case 'perched':
        return this.stepPerched(c, dt);
      case 'wagtail':
        return this.stepGroundBird(c, dt);
      case 'kingfisher':
        return this.stepKingfisher(c, dt);
      case 'damselfly':
        return this.stepDamselfly(c, dt);

      case 'skater':
        return this.stepSkater(c, dt);
      case 'leap':
        return this.stepLeap(c, dt);
      case 'frog':
      case 'turtle':
        return this.stepBank(c, dt);
      case 'lizard':
        return this.stepLizard(c, dt);
      case 'flies': {
        const W = this.ctx.wildlife;
        const a = W?.list.find((o) => o.id === c.ref);
        if (!a || a.butchered || !a.dead) c.state = 3;
        else {
          c.x = a.x;
          c.z = a.z;
          c.y = a.y + 0.15;
        }
        return;
      }
      default:
        return;
    }
  }

  private stepButterfly(c: Critter, dt: number) {
    const ctx = this.ctx;
    const th = this.threat(c.x, c.z, 2.5, 7);
    if (th && c.state !== 2) {
      c.state = 2;
      c.timer = 1.5;
      const a = Math.atan2(c.z - th.z, c.x - th.x);
      c.tx = c.x + Math.cos(a) * 5;
      c.tz = c.z + Math.sin(a) * 5;
      c.ty = this.ground(c.tx, c.tz) + 1.5 + Math.random();
    }
    if (c.state === 0) {
      // Settled on a flower: wings opening and closing slowly.
      c.phase += dt * 1.5;
      if (c.timer <= 0) {
        c.state = 1;
        c.timer = 0;
      }
      return;
    }
    if (c.timer <= 0) {
      if (c.state === 1 && Math.random() < 0.35 && c.y - this.ground(c.x, c.z) < 0.9) {
        c.state = 0;
        c.timer = 2 + Math.random() * 5;
        c.y = this.ground(c.x, c.z) + 0.32 + Math.random() * 0.15;
        return;
      }
      c.state = 1;
      c.timer = 1 + Math.random() * 2.5;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 6;
      c.tx = c.hx + Math.cos(a) * r;
      c.tz = c.hz + Math.sin(a) * r;
      c.ty = this.ground(c.tx, c.tz) + 0.3 + Math.random() * 1.4;
    }
    // Fluttering: toward the target, never straight, bobbing with each beat.
    const dx = c.tx - c.x;
    const dy = c.ty - c.y;
    const dz = c.tz - c.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    const sp = c.state === 2 ? 3 : 1.4;
    const wob = Math.sin(this.time * 3.1 + c.seed * 40) * 0.9;
    c.vx = damp(c.vx, (dx / d) * sp + Math.cos(c.seed * 9 + this.time * 2.3) * wob, 3, dt);
    c.vz = damp(c.vz, (dz / d) * sp + Math.sin(c.seed * 7 + this.time * 2.7) * wob, 3, dt);
    c.vy = damp(c.vy, (dy / d) * sp * 0.6 + Math.sin(this.time * 9 + c.seed * 20) * 0.6, 4, dt);
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    c.z += c.vz * dt;
    c.y = Math.max(c.y, this.ground(c.x, c.z) + 0.15);
    if (Math.hypot(c.vx, c.vz) > 0.2) c.yaw += wrapAngle(Math.atan2(c.vx, c.vz) - c.yaw) * Math.min(1, dt * 5);
    c.phase += dt * 2 * Math.PI * 8;
  }

  private stepDragonfly(c: Critter, dt: number) {
    const ctx = this.ctx;
    const th = this.threat(c.x, c.z, 2, 6);
    if (c.timer <= 0 || (th && c.state === 0)) {
      // Dart: somewhere else over the water within a few metres, faster still when startled.
      c.state = 1;
      c.timer = 0.5 + Math.random() * 2;
      let a = Math.random() * Math.PI * 2;
      if (th) a = Math.atan2(c.z - th.z, c.x - th.x) + (Math.random() - 0.5);
      const r = th ? 6 : 1 + Math.random() * 4;
      let tx = c.hx + Math.cos(a) * r * 0.5 + (c.x - c.hx) * 0.5 + Math.cos(a) * r * 0.5;
      let tz = c.hz + Math.sin(a) * r * 0.5 + (c.z - c.hz) * 0.5 + Math.sin(a) * r * 0.5;
      if (Math.hypot(tx - c.hx, tz - c.hz) > 9) {
        tx = c.hx;
        tz = c.hz;
      }
      const w = ctx.waterAt(tx, tz);
      c.tx = tx;
      c.tz = tz;
      c.ty = (w ? w.level : this.ground(tx, tz)) + 0.35 + Math.random() * 0.9;
    }
    const dx = c.tx - c.x;
    const dy = c.ty - c.y;
    const dz = c.tz - c.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > 0.05) {
      const sp = Math.min(d * 6, 7);
      c.x += (dx / d) * sp * dt;
      c.y += (dy / d) * sp * dt;
      c.z += (dz / d) * sp * dt;
      if (Math.hypot(dx, dz) > 0.2) c.yaw += wrapAngle(Math.atan2(dx, dz) - c.yaw) * Math.min(1, dt * 12);
    } else c.state = 0;
    c.phase += dt * 2 * Math.PI * 28;
  }

  private stepFirefly(c: Critter, dt: number) {
    // A slow drift, wandering about the swarm's middle.
    c.vx = damp(c.vx, Math.sin(this.time * 0.37 + c.seed * 31) * 0.35 + (c.hx - c.x) * 0.05, 1, dt);
    c.vz = damp(c.vz, Math.cos(this.time * 0.41 + c.seed * 17) * 0.35 + (c.hz - c.z) * 0.05, 1, dt);
    c.vy = damp(c.vy, Math.sin(this.time * 0.6 + c.seed * 11) * 0.15 + (c.hy - c.y) * 0.1, 1, dt);
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    c.z += c.vz * dt;
  }

  private stepHopper(c: Critter, dt: number) {
    const g = this.ground(c.x, c.z);
    if (c.state === 1) {
      c.vy -= 9.8 * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.z += c.vz * dt;
      if (c.y <= g && c.vy < 0) {
        c.y = g;
        c.state = 0;
        c.timer = 0.6 + Math.random() * 1.6;
      }
      return;
    }
    if (c.timer <= 0) {
      // Once more, or into the grass and gone.
      if (c.age < 3 && Math.random() < 0.5) {
        c.yaw += (Math.random() - 0.5) * 1.5;
        this.jump(c, 1.4 + Math.random(), 1.8 + Math.random());
      } else c.state = 3;
    }
  }

  /** Sparrows and pigeons: hop and peck about on the ground together; when someone comes close the whole flock goes up, flies off a way and comes down again. */
  private stepGroundBird(c: Critter, dt: number) {
    const ctx = this.ctx;
    const pigeon = c.kind === 'pigeon';
    const wag = c.kind === 'wagtail';
    // Drinkers and wagtails keep to the water's edge.
    const edge = wag || c.ref === 3;
    if (c.state === 0) {
      const th = this.threat(c.x, c.z, pigeon ? 5 : wag ? 7 : 10, pigeon ? 14 : wag ? 12 : 16);
      if (th) {
        this.flush(c, th.x, th.z);
        return;
      }
      // A hop (a pigeon's walk, a wagtail's run along the waterline), a peck or a sip, a look round.
      if (c.timer <= 0) {
        c.timer = (wag ? 0.3 : 0.4) + Math.random() * (pigeon ? 2 : 1.4);
        const a = c.yaw + (Math.random() - 0.5) * (wag ? 1.4 : 2.2);
        const r = pigeon ? 0.25 + Math.random() * 0.6 : wag ? 0.4 + Math.random() * 1.1 : 0.15 + Math.random() * 0.35;
        const tx = c.x + Math.sin(a) * r;
        const tz = c.z + Math.cos(a) * r;
        if (!ctx.waterAt(tx, tz) && (!edge || this.bankTo(tx, tz, 1.4) !== null)) {
          c.tx = tx;
          c.tz = tz;
        } else if (wag) c.yaw += Math.PI * (0.6 + Math.random() * 0.8);
      }
      const dx = c.tx - c.x;
      const dz = c.tz - c.z;
      const d = Math.hypot(dx, dz);
      if (d <= 0.03 && edge) {
        // Stopped at the edge: face the water to drink.
        const b = this.bankTo(c.x, c.z, 1.4);
        if (b !== null) c.yaw += wrapAngle(Math.atan2(Math.cos(b), Math.sin(b)) - c.yaw) * Math.min(1, dt * 6);
      }
      if (d > 0.03) {
        const sp = pigeon ? 0.8 : wag ? 2.4 : 1.6;
        c.x += (dx / d) * Math.min(d, sp * dt);
        c.z += (dz / d) * Math.min(d, sp * dt);
        c.yaw += wrapAngle(Math.atan2(dx, dz) - c.yaw) * Math.min(1, dt * 12);
        c.phase += dt * (pigeon ? 10 : 18);
        c.vy = 1;
      } else c.vy = 0;
      c.y = this.ground(c.x, c.z);
      return;
    }
    if (c.state === 2) {
      // Up and away: a flight bowed like a thrown stone, a finch's dipping or a pigeon's loop, down at the far end.
      c.prog += dt;
      const len = Math.max(1, Math.hypot(c.tx - c.hx, c.tz - c.hz));
      const s = clamp((c.prog * (pigeon ? 7 : 8)) / len, 0, 1);
      const ux = (c.tx - c.hx) / len;
      const uz = (c.tz - c.hz) / len;
      const bow = Math.sin(s * Math.PI) * len * (pigeon ? 0.35 : 0.12) * (c.flock % 2 ? 1 : -1);
      const nx = c.hx + (c.tx - c.hx) * s - uz * bow;
      const nz = c.hz + (c.tz - c.hz) * s + ux * bow;
      c.vx = (nx - c.x) / dt;
      c.vz = (nz - c.z) / dt;
      c.x = nx;
      c.z = nz;
      const g0 = c.hy;
      const g1 = c.ty;
      const dip = pigeon ? 0 : Math.abs(Math.sin(c.prog * 5 + c.seed * 6)) * 0.6;
      c.y = Math.max(this.ground(c.x, c.z) + 0.05, g0 + (g1 - g0) * s + Math.pow(Math.sin(s * Math.PI), 0.6) * (pigeon ? 9 : 4) - dip);
      if (Math.hypot(c.vx, c.vz) > 0.3) c.yaw += wrapAngle(Math.atan2(c.vx, c.vz) - c.yaw) * Math.min(1, dt * 8);
      c.phase += dt * (pigeon ? 22 : 30);
      if (s >= 1) {
        c.state = 0;
        c.timer = 1 + Math.random() * 2;
        c.y = this.ground(c.x, c.z);
        c.tx = c.x;
        c.tz = c.z;
      }
    }
  }

  /** The whole flock goes up at once, each on its own line to a spot on the far side. */
  private flush(c: Critter, fx: number, fz: number) {
    const ctx = this.ctx;
    const pigeon = c.kind === 'pigeon';
    const edge = c.kind === 'wagtail' || c.ref === 3;
    const base = Math.atan2(c.z - fz, c.x - fx);
    const r = pigeon ? 10 + Math.random() * 14 : edge ? 10 + Math.random() * 18 : 22 + Math.random() * 30;
    // A pigeon flock loops round and comes back down close to where it was.
    const a = pigeon ? base + Math.PI * (0.6 + Math.random() * 0.8) * (Math.random() < 0.5 ? 1 : -1) : base + (Math.random() - 0.5) * 0.8;
    let lx = c.x + Math.cos(a) * r;
    let lz = c.z + Math.sin(a) * r;
    if (edge) {
      // Along the bank to another stretch of edge, or off over the land if there is none.
      for (let k = 0; k < 10; k++) {
        const aa = base + (Math.random() - 0.5) * 2.4;
        const px = c.x + Math.cos(aa) * r;
        const pz = c.z + Math.sin(aa) * r;
        if (!ctx.waterAt(px, pz) && this.bankTo(px, pz, 1.4) !== null) {
          lx = px;
          lz = pz;
          break;
        }
      }
    }
    if (ctx.waterAt(lx, lz) || ctx.interiorAt?.(lx, lz, this.ground(lx, lz) + 0.5)) {
      lx = c.x + Math.cos(base) * r;
      lz = c.z + Math.sin(base) * r;
    }
    let n = 0;
    for (const o of this.list) {
      if (o.flock !== c.flock || o.state !== 0) continue;
      o.state = 2;
      o.prog = -Math.random() * 0.25;
      o.hx = o.x;
      o.hz = o.z;
      o.hy = o.y;
      o.tx = lx + (o.x - c.x) + (Math.random() - 0.5) * 2;
      o.tz = lz + (o.z - c.z) + (Math.random() - 0.5) * 2;
      o.ty = this.ground(o.tx, o.tz);
      n++;
    }
    ctx.audio.play('flutter', c.x, c.z, Math.min(1, 0.35 + n * 0.06));
    if (!pigeon) ctx.audio.play('chirp', c.x, c.z, 0.5);
  }

  /** Swallows sweep in long loops low over the water and the meadow; bats jink about in the dark. */
  private stepHawker(c: Critter, dt: number) {
    const bat = c.kind === 'bat';
    const t = this.time * (bat ? 1.1 : 0.62) + c.seed * 20;
    const R = bat ? 7 : 13;
    const x = c.hx + Math.sin(t) * R + Math.sin(t * 2.3 + c.seed * 5) * R * 0.35;
    const z = c.hz + Math.sin(t * 1.6 + c.seed * 3) * R * 0.8;
    let y = c.level + (bat ? 3 + Math.sin(t * 1.7) * 1.8 : 0.6 + (0.5 + 0.5 * Math.sin(t * 0.7 + c.seed)) * 4);
    if (bat) y += (Math.random() - 0.5) * 0.15;
    y = Math.max(y, this.ground(x, z) + 0.4);
    c.vx = (x - c.x) / dt;
    c.vz = (z - c.z) / dt;
    c.x = x;
    c.y = y;
    c.z = z;
    if (Math.hypot(c.vx, c.vz) > 0.3) c.yaw = Math.atan2(c.vx, c.vz);
    c.phase += dt * (bat ? 55 : 24);
  }

  /** Fish and tadpoles: a school about a middle that wanders, scattering from anyone wading in or a boat. */
  private stepFish(c: Critter, dt: number) {
    const ctx = this.ctx;
    const tad = c.kind === 'tadpole';
    // Somebody in the water or a boat close by: the school scatters.
    const th = this.threat(c.x, c.z, tad ? 2.5 : 5, tad ? 5 : 9);
    if (th && c.state !== 2) {
      for (const o of this.list) {
        if (o.flock !== c.flock || o.kind !== c.kind) continue;
        o.state = 2;
        o.timer = 1.2 + Math.random() * 0.8;
        const a = Math.atan2(o.z - th.z, o.x - th.x) + (Math.random() - 0.5) * 0.8;
        o.tx = o.x + Math.cos(a) * (tad ? 1.5 : 6);
        o.tz = o.z + Math.sin(a) * (tad ? 1.5 : 6);
      }
      c.hx += (c.x - th.x) * 0.5;
      c.hz += (c.z - th.z) * 0.5;
    }
    if (c.state === 2 && c.timer <= 0) {
      c.state = 0;
      c.timer = 0;
    }
    if (c.state !== 2 && c.timer <= 0) {
      // A new place in the school.
      c.timer = (tad ? 0.4 : 1) + Math.random() * 2.5;
      const a = Math.random() * Math.PI * 2;
      const r = tad ? 0.1 + Math.random() * 0.7 : 0.4 + Math.random() * 2.2;
      c.tx = c.hx + Math.cos(a) * r;
      c.tz = c.hz + Math.sin(a) * r;
      // The school as a whole wanders slowly.
      if (Math.random() < 0.15) {
        c.hx += (Math.random() - 0.5) * (tad ? 0.6 : 3);
        c.hz += (Math.random() - 0.5) * (tad ? 0.6 : 3);
      }
    }
    const w = ctx.waterAt(c.x, c.z);
    const fx = w?.flow?.[0] ?? 0;
    const fz = w?.flow?.[1] ?? 0;
    const dx = c.tx - c.x;
    const dz = c.tz - c.z;
    const d = Math.hypot(dx, dz) || 1;
    const sp = c.state === 2 ? (tad ? 1 : 2.6) : Math.min(tad ? 0.25 : c.ref ? 0.35 : 0.7, d * 0.6);
    c.vx = damp(c.vx, (dx / d) * sp, c.state === 2 ? 6 : 2, dt);
    c.vz = damp(c.vz, (dz / d) * sp, c.state === 2 ? 6 : 2, dt);
    const nx = c.x + c.vx * dt;
    const nz = c.z + c.vz * dt;
    const nw = ctx.waterAt(nx, nz);
    const minDepth = tad ? 0.04 : 0.32;
    if (nw && nw.depth > minDepth) {
      c.x = nx;
      c.z = nz;
      c.level = nw.level;
      c.ty = nw.depth;
    } else {
      // Shallow or the bank: turn back toward the middle of the school.
      c.vx *= -0.5;
      c.vz *= -0.5;
      c.tx = c.hx;
      c.tz = c.hz;
      if (!w || w.depth < minDepth * 0.75) c.state = 3;
    }
    // Tadpoles and bottom fish keep to the bed (a tadpole now and then wriggles up for air); the rest swim mid-water.
    const bed = Math.max(c.level - c.ty, this.ground(c.x, c.z));
    const want = tad ? bed + 0.03 + Math.max(0, Math.sin(this.time * 0.7 + c.seed * 30) - 0.85) * 4 * (c.ty - 0.06) : c.ref ? bed + c.size * 0.22 : c.level - this.swimDepth(c.ty);
    c.y = damp(c.y, Math.min(want, c.level - 0.02), tad ? 4 : 2, dt);
    // In running water a fish faces into the current and holds there; in still water it faces the way it swims.
    const flowing = Math.hypot(fx, fz) > 0.15;
    const head = flowing && c.state !== 2 ? Math.atan2(-fx, -fz) : Math.atan2(c.vx, c.vz);
    if (flowing || Math.hypot(c.vx, c.vz) > 0.05) c.yaw += wrapAngle(head - c.yaw) * Math.min(1, dt * (c.state === 2 ? 10 : 3));
    c.phase += dt * 6.28 * (tad ? 4 : c.state === 2 ? 3.2 : 1.1 + Math.hypot(c.vx, c.vz));
  }

  /**
   * A crab on the bed: still a while, then a few sideways steps, the claws held up. When someone comes close it scuttles off
   * sideways at a run and is gone under a stone.
   */
  private stepCrab(c: Critter, dt: number) {
    const ctx = this.ctx;
    if (c.state === 0) {
      const th = this.threat(c.x, c.z, 3, 6);
      if (th) {
        // Turned side-on to the danger, and away.
        c.state = 2;
        c.timer = 0.6 + Math.random() * 0.5;
        const a = Math.atan2(c.x - th.x, c.z - th.z);
        c.yaw = a - Math.PI / 2;
        c.tx = 1;
        return;
      }
      if (c.timer <= 0) {
        c.state = 1;
        c.timer = 0.4 + Math.random() * 0.9;
        c.tx = Math.random() < 0.5 ? 1 : -1;
        c.yaw += (Math.random() - 0.5) * 0.8;
      }
      return;
    }
    // Sideways: along the body's x.
    const sp = c.state === 2 ? 1.3 : 0.35;
    const sx = Math.cos(c.yaw) * c.tx;
    const sz = -Math.sin(c.yaw) * c.tx;
    const nx = c.x + sx * sp * dt;
    const nz = c.z + sz * sp * dt;
    const w = ctx.waterAt(nx, nz);
    if (w && w.depth > 0.9) c.tx = -c.tx;
    else {
      c.x = nx;
      c.z = nz;
    }
    c.y = this.ground(c.x, c.z);
    c.phase += dt * (c.state === 2 ? 40 : 18);
    if (c.timer <= 0) {
      if (c.state === 2) c.state = 3;
      else {
        c.state = 0;
        c.timer = 1 + Math.random() * 4;
      }
    }
  }

  /** Water striders: still on the film, then a quick glide; a ring where each one stops. They skate off from anyone close. */
  private stepSkater(c: Critter, dt: number) {
    const ctx = this.ctx;
    const th = this.threat(c.x, c.z, 2.5, 6);
    if (c.state === 0 && (c.timer <= 0 || th)) {
      c.state = 1;
      c.timer = 0.25 + Math.random() * 0.2;
      let a = Math.random() * Math.PI * 2;
      if (th) a = Math.atan2(c.z - th.z, c.x - th.x) + (Math.random() - 0.5);
      // Drift back toward the group's patch if wandering off.
      else if (Math.hypot(c.x - c.hx, c.z - c.hz) > 2.5) a = Math.atan2(c.hz - c.z, c.hx - c.x);
      const sp = th ? 2.8 : 1.4 + Math.random() * 1.2;
      c.vx = Math.cos(a) * sp;
      c.vz = Math.sin(a) * sp;
      c.yaw = Math.atan2(c.vx, c.vz);
    }
    if (c.state === 1) {
      c.vx = damp(c.vx, 0, 5, dt);
      c.vz = damp(c.vz, 0, 5, dt);
      const nx = c.x + c.vx * dt;
      const nz = c.z + c.vz * dt;
      const w = ctx.waterAt(nx, nz);
      if (w && w.depth > 0.03) {
        c.x = nx;
        c.z = nz;
        c.level = w.level;
      } else {
        c.vx = -c.vx;
        c.vz = -c.vz;
      }
      if (c.timer <= 0) {
        c.state = 0;
        c.timer = 0.4 + Math.random() * 2.2;
        this.ripple(c.x, c.level, c.z, 0.12, 0.6);
      }
    }
    c.y = c.level + 0.004;
  }

  private stepLeap(c: Critter, dt: number) {
    if (c.state !== 1) return;
    // timer counts down the flight; the arc is a parabola from the surface and back.
    const total = 0.6;
    const s = clamp(1 - c.timer / total, 0, 1);
    c.x += Math.sin(c.yaw) * 1.8 * dt;
    c.z += Math.cos(c.yaw) * 1.8 * dt;
    c.y = c.level - 0.1 + Math.sin(s * Math.PI) * (0.35 + c.size * 1.2);
    c.phase = (s - 0.5) * 1.6;
    if (c.timer <= 0) {
      c.state = 3;
      this.ripple(c.x, c.level, c.z, 0.8 + c.size * 2);
      this.splashDrops(c.x, c.level, c.z, 0.5);
      this.ctx.audio.play('plop', c.x, c.z, 0.45);
    }
  }

  /** Frogs and turtles on the bank: when someone comes too close they go into the water and are gone. */
  private stepBank(c: Critter, dt: number) {
    const ctx = this.ctx;
    const frog = c.kind === 'frog';
    if (c.state === 0) {
      const th = this.threat(c.x, c.z, frog ? 3.5 : 10, frog ? 9 : 18);
      if (th) {
        c.state = frog ? 1 : 2;
        c.yaw = Math.atan2(c.tx, c.tz);
        if (frog) this.jump(c, 1.6 + Math.random() * 0.6, 2.2);
        c.timer = 3;
      } else if (frog && c.timer <= 0) {
        // Throat pulsing, the odd shuffle round.
        c.timer = 2 + Math.random() * 5;
        c.yaw += (Math.random() - 0.5) * 0.6;
      }
      return;
    }
    if (frog && c.state === 1) {
      c.vy -= 9.8 * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.z += c.vz * dt;
      const w = ctx.waterAt(c.x, c.z);
      const floor = w ? w.level : this.ground(c.x, c.z);
      if (c.y <= floor && c.vy < 0) {
        if (w) {
          c.state = 3;
          this.ripple(c.x, w.level, c.z, 0.7);
          ctx.audio.play('plop', c.x, c.z, 0.5);
        } else {
          // Landed short of the water: another hop.
          c.y = floor;
          this.jump(c, 1.6, 2);
        }
      }
      return;
    }
    // A turtle slides down into the water and under.
    c.x += c.tx * 0.9 * dt;
    c.z += c.tz * 0.9 * dt;
    const w = ctx.waterAt(c.x, c.z);
    if (w && w.depth > 0.12) {
      c.y -= dt * 0.5;
      if (c.y < w.level - 0.25) {
        c.state = 3;
        this.ripple(c.x, w.level, c.z, 1);
        ctx.audio.play('plop', c.x, c.z, 0.6);
      }
    } else c.y = this.ground(c.x, c.z);
    if (c.timer <= 0) c.state = 3;
  }

  /** Birds in a tree: sitting, turning, the odd note; all of them off to another tree when someone comes near. */
  private stepPerched(c: Critter, dt: number) {
    if (c.state === 0) {
      const th = this.threat(c.x, c.z, 14, 18);
      if (th) {
        this.flushTrees(c, th.x, th.z);
        return;
      }
      if (c.timer <= 0) {
        c.timer = 1 + Math.random() * 4;
        c.yaw += (Math.random() - 0.5) * 1.6;
        if (Math.random() < 0.06) this.ctx.audio.play('chirp', c.x, c.z, 0.25);
      }
      return;
    }
    if (c.state === 2) {
      c.phase += dt * 30;
      if (this.flight(c, dt, 8, 3, c.size < 0.2 ? 0.5 : 0)) {
        c.x = c.tx;
        c.y = c.ty;
        c.z = c.tz;
        c.state = c.ref === -2 ? 3 : 0;
        c.timer = 1 + Math.random() * 3;
      }
    }
  }

  /** Off to the tree furthest on the far side within reach (each bird its own place in it), or away over the land if none. */
  private flushTrees(c: Critter, fx: number, fz: number) {
    const trees = this.ctx.treesNear?.(c.x, c.z, 60) ?? [];
    const base = Math.atan2(c.z - fz, c.x - fx);
    let best: TreeSpot | null = null;
    let bs = -Infinity;
    for (const t of trees) {
      const d = Math.hypot(t.x - c.x, t.z - c.z);
      if (d < 12) continue;
      const sc = Math.cos(Math.atan2(t.z - c.z, t.x - c.x) - base) * 2 + Math.random();
      if (sc > bs) {
        bs = sc;
        best = t;
      }
    }
    let n = 0;
    for (const o of this.list) {
      if (o.flock !== c.flock || o.state !== 0) continue;
      o.state = 2;
      o.prog = -Math.random() * 0.3;
      o.hx = o.x;
      o.hy = o.y;
      o.hz = o.z;
      if (best) {
        const p = this.perchOn(best);
        o.tx = p.x;
        o.ty = p.y;
        o.tz = p.z;
        o.ref = 0;
      } else {
        o.tx = o.x + Math.cos(base) * 50;
        o.tz = o.z + Math.sin(base) * 50;
        o.ty = o.y + 8;
        o.ref = -2;
      }
      n++;
    }
    this.ctx.audio.play('flutter', c.x, c.z, Math.min(1, 0.3 + n * 0.08));
  }

  /**
   * A pied kingfisher fishing: hovering on fast wings a few metres over the water, then folding up and dropping straight in,
   * up again with a shake, a few hovers further along, and off along the water when anyone comes close.
   */
  private stepKingfisher(c: Critter, dt: number) {
    const ctx = this.ctx;
    const th = this.threat(c.x, c.z, 9, 14);
    if (th && c.state !== 4) {
      const s = this.waterNear(c.x, c.z, 30, 60, Math.atan2(c.z - th.z, c.x - th.x));
      c.state = 4;
      c.prog = 0;
      c.hx = c.x;
      c.hy = c.y;
      c.hz = c.z;
      c.tx = s ? s.x : c.x + (c.x - th.x);
      c.tz = s ? s.z : c.z + (c.z - th.z);
      c.ty = (s ? s.level : c.level) + 3.5 + Math.random() * 1.5;
      ctx.audio.play('chirp', c.x, c.z, 0.5);
    }
    switch (c.state) {
      case 0:
        // Hovering: held in the air, wings a blur.
        c.y = damp(c.y, c.hy + Math.sin(this.time * 3 + c.seed * 10) * 0.08, 3, dt);
        c.phase += dt * 60;
        if (c.timer <= 0) {
          if (Math.random() < 0.55) {
            c.state = 1;
          } else {
            const s = this.waterNear(c.x, c.z, 4, 12, Math.random() * Math.PI * 2);
            if (s) {
              c.state = 4;
              c.prog = 0;
              c.hx = c.x;
              c.hy = c.y;
              c.hz = c.z;
              c.tx = s.x;
              c.tz = s.z;
              c.ty = s.level + 3.5 + Math.random() * 1.5;
            } else c.timer = 2;
          }
        }
        break;
      case 1:
        // The dive.
        c.y -= dt * 12;
        if (c.y <= c.level) {
          c.y = c.level;
          this.ripple(c.x, c.level, c.z, 0.9);
          this.splashDrops(c.x, c.level, c.z, 0.4);
          ctx.audio.play('plop', c.x, c.z, 0.5);
          c.state = 2;
        }
        break;
      case 2:
        c.y = damp(c.y, c.hy, 2.5, dt);
        c.phase += dt * 50;
        if (Math.abs(c.y - c.hy) < 0.3) {
          c.state = 0;
          c.timer = 1.5 + Math.random() * 3;
        }
        break;
      case 4:
        c.phase += dt * 45;
        if (this.flight(c, dt, 9, 1.5, 0)) {
          c.state = 0;
          c.hy = c.y;
          c.level = this.ctx.waterAt(c.x, c.z)?.level ?? c.level;
          c.timer = 1 + Math.random() * 3;
        }
        break;
    }
  }

  /** A point on living water `r0..r1` from (x, z), leaning toward `ang`. */
  private waterNear(x: number, z: number, r0: number, r1: number, ang: number) {
    for (let k = 0; k < 12; k++) {
      const a = ang + (Math.random() - 0.5) * (k < 6 ? 1.2 : 6.28);
      const r = r0 + Math.random() * (r1 - r0);
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      const w = this.ctx.waterAt(px, pz);
      if (w && w.depth > 0.3 && LIVE_WATER.has(w.kind ?? 'lake')) return { x: px, z: pz, level: w.level };
    }
    return null;
  }

  /** A damselfly: settled on a reed stem with its wings closed, then a short weak flight to another. */
  private stepDamselfly(c: Critter, dt: number) {
    const th = this.threat(c.x, c.z, 1.6, 4);
    if (c.state === 0) {
      if (c.timer <= 0 || th) {
        c.state = 1;
        c.timer = 0.6 + Math.random();
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * 1.5;
        c.tx = c.hx + Math.cos(a) * r;
        c.tz = c.hz + Math.sin(a) * r;
        c.ty = c.level + 0.3 + Math.random() * 0.6;
      }
      return;
    }
    const dx = c.tx - c.x;
    const dy = c.ty - c.y;
    const dz = c.tz - c.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > 0.04) {
      const sp = Math.min(1.3, d * 4);
      c.x += (dx / d) * sp * dt;
      c.y += (dy / d) * sp * dt + Math.sin(this.time * 20 + c.seed * 9) * 0.004;
      c.z += (dz / d) * sp * dt;
      if (Math.hypot(dx, dz) > 0.05) c.yaw += wrapAngle(Math.atan2(dx, dz) - c.yaw) * Math.min(1, dt * 8);
    }
    c.phase += dt * 2 * Math.PI * 22;
    if (d <= 0.04 || c.timer <= 0) {
      c.state = 0;
      c.timer = 2 + Math.random() * 6;
    }
  }

  /** The snakes, on the game's fixed tick: they move, warn, strike and bite here. */
  tick(dt: number) {
    if (dt <= 0) return;
    for (const c of this.list) {
      if (c.kind !== 'snake' || c.state === 3) continue;
      c.age += dt;
      c.timer -= dt;
      c.vy -= dt;
      this.stepSnake(c, dt);
    }
  }

  /**
   * A snake, as defensive as a real one. It feels footsteps through the ground (a runner from further off, someone creeping
   * from much closer). A whip snake is off into cover; a viper holds its ground: it coils, faces you and hisses, and if you
   * stay within reach of its head it strikes, again and again while you are there; give it room and it slides away. Step on
   * one before it knows you are there and it bites at once. A horned viper lies half in the sand and warns from closer. Any
   * of them gets out of the way of an engine, and one that does not is run over.
   */
  private stepSnake(c: Critter, dt: number) {
    const ctx = this.ctx;
    if (c.state === 6) {
      // Dead: it lies there a while.
      if (c.timer <= 0) c.state = 3;
      return;
    }
    const whip = c.ref === 2;
    const horned = c.ref === 0;
    for (const v of ctx.vehicles) {
      if (v.wreck || Math.abs(v.speed) < 2) continue;
      const d = Math.hypot(v.position.x - c.x, v.position.z - c.z);
      if (d < (v.def?.length ?? 4) * 0.5) return this.killSnake(c);
      if (d < 9 && c.state !== 2) {
        c.state = 2;
        c.timer = 2;
        c.yaw = Math.atan2(c.x - v.position.x, c.z - v.position.z);
      }
    }
    // Whoever on foot is nearest the head.
    const hx = c.x + Math.sin(c.yaw) * c.size * 0.4;
    const hz = c.z + Math.cos(c.yaw) * c.size * 0.4;
    let near: (typeof ctx.players)[number] | null = null;
    let nd = Infinity;
    for (const p of ctx.players) {
      if (!p.alive || p.inVehicle || p.state !== 'foot') continue;
      const d = Math.hypot(p.pos.x - hx, p.pos.z - hz);
      if (d < nd) {
        nd = d;
        near = p;
      }
    }
    const reach = 0.35 + c.size * 0.45;
    const feel = near ? (horned ? 2 : whip ? 5 : 3) * (near.moveSpeed > 3.5 ? 1.4 : near.crouch ? 0.6 : 1) : 0;
    switch (c.state) {
      case 0:
      case 1: {
        // Stepped on before it knew: it bites at once.
        if (near && nd < 0.45 && near.moveSpeed > 0.8) {
          this.bite(c, near);
          c.state = whip ? 2 : 4;
          c.timer = whip ? 2.5 : 3;
          return;
        }
        if (near && nd < feel) {
          if (whip) {
            c.state = 2;
            c.timer = 2.5;
            c.yaw = Math.atan2(c.x - near.pos.x, c.z - near.pos.z) + (Math.random() - 0.5) * 0.6;
          } else {
            c.state = 4;
            c.timer = 3;
            c.prog = 0;
            c.yaw = Math.atan2(near.pos.x - c.x, near.pos.z - c.z);
            ctx.audio.play('hiss', c.x, c.z, 0.8);
          }
          return;
        }
        if (c.state === 0 && c.timer <= 0) {
          c.state = 1;
          c.timer = 2 + Math.random() * 4;
          c.yaw += (Math.random() - 0.5) * 1.5;
        } else if (c.state === 1 && c.timer <= 0) {
          c.state = 0;
          c.timer = 3 + Math.random() * 8;
        }
        if (c.state === 1) this.slither(c, dt, whip ? 0.6 : 0.25);
        break;
      }
      case 4: {
        // On guard: facing the trouble, hissing every couple of seconds, striking at anything within reach.
        if (near && nd < feel * 1.6) {
          c.timer = 3;
          c.yaw += wrapAngle(Math.atan2(near.pos.x - c.x, near.pos.z - c.z) - c.yaw) * Math.min(1, dt * 6);
          c.prog += dt;
          if (c.prog > 1.8) {
            c.prog = 0;
            ctx.audio.play('hiss', c.x, c.z, 0.7);
          }
          if (nd < reach && c.vy <= 0) {
            c.state = 5;
            c.timer = 0.32;
            c.tx = near.pos.x;
            c.tz = near.pos.z;
            c.ty = 0;
          }
        } else if (c.timer <= 0) {
          // Left alone: it slides off into cover.
          c.state = 2;
          c.timer = 3;
          c.yaw += Math.PI;
        }
        break;
      }
      case 5: {
        // The strike: a lunge at whoever was there; it bites if they still are when it lands.
        if (c.ty === 0 && c.timer < 0.2) {
          c.ty = 1;
          if (near && nd < reach + 0.3) this.bite(c, near);
          c.vy = 1.2;
        }
        if (c.timer <= 0) {
          c.state = 4;
          c.timer = 2.5;
        }
        break;
      }
      case 2: {
        // Away. A whip snake cornered on the way bites as it goes.
        if (whip && near && nd < 0.6 && c.vy <= 0) this.bite(c, near);
        this.slither(c, dt, whip ? 3 : horned ? 1 : 0.6);
        if (c.timer <= 0) c.state = 3;
        break;
      }
    }
    c.y = this.ground(c.x, c.z);
  }

  /** Move along: a sidewinder travels slanting across its own body; the rest follow their heads. */
  private slither(c: Critter, dt: number, sp: number) {
    const dir = c.yaw + (c.ref === 0 ? 1.1 : 0);
    const nx = c.x + Math.sin(dir) * sp * dt;
    const nz = c.z + Math.cos(dir) * sp * dt;
    if (this.ctx.waterAt(nx, nz)) c.yaw += 1.2;
    else {
      c.x = nx;
      c.z = nz;
    }
    c.phase += dt * sp * 9;
  }

  private bite(c: Critter, p: (typeof this.ctx.players)[number]) {
    c.vy = 1.2;
    const kind = c.ref === 0 ? 'horned' : c.ref === 1 ? 'palestine' : 'whip';
    p.snakeBite?.(kind, c.x, c.z);
  }

  private killSnake(c: Critter) {
    if (c.state === 6 || c.state === 3) return;
    c.state = 6;
    c.timer = 25;
    this.ctx.fx?.blood?.(c.x, c.y + 0.05, c.z, 2);
  }

  /** A blow (a boot, a blade, a club) at (hx, hz) kills any snake within reach. Returns how many. */
  meleeHit(hx: number, hz: number, reach: number): number {
    let n = 0;
    for (const c of this.list) {
      if (c.kind !== 'snake' || c.state === 6 || c.state === 3) continue;
      if (Math.hypot(c.x - hx, c.z - hz) > reach * 0.6 + c.size * 0.5) continue;
      this.killSnake(c);
      n++;
    }
    return n;
  }

  /**
   * A round along (ox, oy, oz) + t·(dx, dy, dz), t up to `maxD` (a unit direction): any snake it passes over close enough to
   * hit is killed. The round goes on (into the ground, or whatever it was going to hit): a snake does not stop it.
   */
  shootThrough(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxD: number) {
    for (const c of this.list) {
      if (c.kind !== 'snake' || c.state === 6 || c.state === 3) continue;
      // Quick reject: is the snake anywhere near the segment?
      const mx = ox + dx * maxD * 0.5 - c.x;
      const mz = oz + dz * maxD * 0.5 - c.z;
      if (mx * mx + mz * mz > (maxD * 0.5 + c.size) ** 2) continue;
      const hx = Math.sin(c.yaw) * c.size * 0.5;
      const hz = Math.cos(c.yaw) * c.size * 0.5;
      const d = segDist(ox, oy, oz, ox + dx * (maxD + 0.3), oy + dy * (maxD + 0.3), oz + dz * (maxD + 0.3), c.x - hx, c.y + 0.03, c.z - hz, c.x + hx, c.y + 0.03, c.z + hz);
      if (d < 0.07 + c.level * 0.025) this.killSnake(c);
    }
  }

  /**
   * Lizards. An agama does its push-ups on the warm ground and darts off; a fringe-toed lizard runs over the sand faster than
   * the eye; a spiny-tailed lizard runs for its burrow and is gone; a desert monitor walks slowly, swinging its tail, and
   * makes off at a heavy run.
   */
  private stepLizard(c: Critter, dt: number) {
    const ctx = this.ctx;
    const monitor = c.ref === 3;
    const th = this.threat(c.x, c.z, monitor ? 7 : 3, monitor ? 12 : 7);
    if (c.state === 0) {
      if (th) {
        c.state = 1;
        const a = Math.atan2(c.x - th.x, c.z - th.z) + (Math.random() - 0.5) * 1.4;
        c.yaw = a;
        c.timer = monitor ? 2.5 : c.ref === 1 ? 0.3 + Math.random() * 0.3 : 0.4 + Math.random() * 0.5;
        return;
      }
      if (monitor) {
        // A slow walk, nosing about.
        if (c.timer <= 0) {
          c.timer = 2 + Math.random() * 4;
          c.yaw += (Math.random() - 0.5) * 1.2;
        }
        const nx = c.x + Math.sin(c.yaw) * 0.35 * dt;
        const nz = c.z + Math.cos(c.yaw) * 0.35 * dt;
        if (!ctx.waterAt(nx, nz)) {
          c.x = nx;
          c.z = nz;
        } else c.yaw += 1;
        c.phase += dt * 4;
      } else {
        // Push-ups on the warm ground.
        c.phase += dt * (c.timer < 0.6 ? 14 : 0);
        if (c.timer <= 0) c.timer = 2 + Math.random() * 4;
      }
      c.y = this.ground(c.x, c.z);
      return;
    }
    const sp = monitor ? 2.6 : c.ref === 1 ? 6.5 : c.ref === 2 ? 3 : 4.5;
    const nx = c.x + Math.sin(c.yaw) * sp * dt;
    const nz = c.z + Math.cos(c.yaw) * sp * dt;
    if (!ctx.waterAt(nx, nz)) {
      c.x = nx;
      c.z = nz;
    }
    c.y = this.ground(c.x, c.z);
    c.phase += dt * (monitor ? 14 : 40);
    if (c.timer <= 0) {
      // A spiny-tail is down its burrow; the rest stop and freeze.
      if (c.ref === 2) c.state = 3;
      else {
        c.state = 0;
        c.timer = 1 + Math.random() * 2;
        c.yaw += (Math.random() - 0.5) * 2;
      }
    }
  }

  /** A few drops thrown up where something broke the surface. */
  private splashDrops(x: number, y: number, z: number, size: number) {
    const sm = this.ctx.fx?.smoke;
    if (!sm) return;
    for (let i = 0; i < 3 + size * 5; i++) sm.emit(x, y + 0.03, z, (Math.random() - 0.5) * 1.2, 0.8 + Math.random() * 1.2, (Math.random() - 0.5) * 1.2, 0.5, 0.1, 0.35, 0.9, 0.94, 0.96, 0.4, 7, 0.3);
  }

  // ------------------------------------------------------------------ drawing

  render(lr: LifeRenderer) {
    lr.begin();
    const t = this.time;
    for (const c of this.list) {
      switch (c.kind) {
        case 'butterfly': {
          const sitting = c.state === 0;
          // On the wing each has its own rhythm: bursts of beats, then a glide on wings held open, a little wobble in it.
          const burst = Math.sin(t * (0.7 + c.seed * 0.9) + c.seed * 20) > -0.35;
          const open = sitting ? 0.25 + Math.abs(Math.sin(c.phase)) * 1.15
            : burst ? 0.15 + (0.5 + 0.5 * Math.sin(c.phase)) * 1.25 : 1.3 + Math.sin(t * 9 + c.seed * 7) * 0.08;
          const flap = Math.PI * 0.5 - open;
          for (const side of [1, -1]) lr.putChild('wing', c.x, c.y, c.z, c.yaw, sitting ? 0 : -0.2, 0, 0, 0, 0, side * flap, 0, side * c.size, 1, c.size * 1.1, c.r, c.g, c.b);
          break;
        }
        case 'bees':
          for (let i = 0; i < c.size; i++) {
            const a = t * (1.3 + i * 0.37) + i * 2.1;
            lr.dots.add(c.x + Math.sin(a) * (0.5 + (i % 3) * 0.4) + Math.sin(a * 3.1) * 0.15, c.y + 0.25 + Math.abs(Math.sin(a * 1.7)) * 0.45, c.z + Math.cos(a * 0.9) * (0.5 + (i % 2) * 0.5), 0.014, 0.85, 0.62, 0.1, 1);
          }
          break;
        case 'dragonfly': {
          // Fore and hind pairs beat out of step, each from its own hinge at its own sweep. Darting it beats hardest, nose
          // down; holding station it bobs and tilts, and now and then glides a moment on still wings.
          const glideK = c.state === 0 ? Math.min(1, Math.max(0, Math.sin(t * 0.9 + c.seed * 13) - 0.75) * 4) : 0;
          const fl = Math.sin(c.phase) * (c.state === 1 ? 0.42 : 0.33) * (1 - glideK);
          const s = c.size;
          const pitch = c.state === 1 ? 0.18 : Math.sin(t * 1.7 + c.seed * 5) * 0.06;
          const y = c.y + (c.state === 0 ? Math.sin(t * 2.3 + c.seed * 9) * 0.012 : 0);
          lr.put('dragon', c.x, y, c.z, c.yaw, pitch, 0, s, s, s, c.r, c.g, c.b);
          const wings = lr.dragonflyWings();
          for (const side of [1, -1]) {
            for (const [m, beat] of [[wings.fore, fl], [wings.hind, -fl]] as const) {
              lr.putChild('dragonWing', c.x, y, c.z, c.yaw, pitch, 0, side * m[0] * s, m[1] * s, m[2] * s, side * (beat + m[5] * 0.4 + glideK * 0.08), side * m[4], side * m[3] * s, 1, m[3] * s, 1, 1, 1);
            }
          }
          break;
        }
        case 'fireflies': {
          const cyc = (t + c.phase) % c.size;
          const on = cyc < 0.35 ? Math.sin((cyc / 0.35) * Math.PI) : 0;
          if (on > 0.02) lr.glow.add(c.x, c.y, c.z, 0.06, 2.4 * on, 3 * on, 0.7 * on, 1);
          break;
        }
        case 'midges':
        case 'flies': {
          const fly = c.kind === 'flies';
          const R = fly ? 0.45 : 0.5;
          for (let i = 0; i < c.size; i++) {
            const k = i * 1.618;
            const ox = Math.sin(t * (fly ? 5.3 : 2.1) + k * 3.1) * R + Math.sin(t * 7.9 + k) * 0.1;
            const oy = Math.sin(t * (fly ? 4.1 : 1.3) + k * 2.3) * (fly ? 0.25 : 0.7);
            const oz = Math.cos(t * (fly ? 6.1 : 1.7) + k * 1.7) * R + Math.cos(t * 8.3 + k) * 0.1;
            lr.dots.add(c.x + ox, c.y + oy + (fly ? 0.2 : 0), c.z + oz, fly ? 0.011 : 0.007, 0.08, 0.08, 0.07, 0.85);
          }
          break;
        }
        case 'hopper':
          lr.put('hopper', c.x, c.y, c.z, c.yaw, c.state === 1 ? -0.4 : 0, 0, c.size, c.size, c.size, c.r, c.g, c.b);
          break;
        case 'songbird':
        case 'pigeon':
        case 'swallow':
        case 'bat':
        case 'perched':
        case 'wagtail':
        case 'kingfisher': {
          const king = c.kind === 'kingfisher';
          const flying = king || c.state !== 0;
          const s = c.size;
          // Hops lift a sparrow off the ground a moment; a pigeon's head bobs (the whole bird, at this size).
          const hop = !flying && c.vy > 0 ? Math.abs(Math.sin(c.phase)) * s * (c.kind === 'pigeon' ? 0.05 : 0.4) : 0;
          const peck = !flying && c.vy === 0 && Math.sin(t * 2.3 + c.seed * 20) > 0.6 ? 0.5 : 0;
          // A wagtail's tail bobs; a kingfisher hangs head-up on the hover and folds nose-down to dive.
          const bob = c.kind === 'wagtail' && !flying ? Math.sin(t * 9 + c.seed * 20) * 0.15 : 0;
          const pitch = king ? (c.state === 1 ? 1.3 : c.state === 4 ? -0.08 : -0.55) : flying ? -0.08 : peck + bob;
          // From the models where loaded: wings beating on the bird's phase, gliding between a finch's bursts and on a
          // swallow's long swoops, folded on a kingfisher's dive; standing, it glances about and pecks.
          const own = t + c.seed * 20;
          const burst = Math.sin(t * 5 + c.seed * 6);
          const glide = !flying ? 0 : king ? (c.state === 1 ? 1 : 0) : c.kind === 'swallow' ? 0.35 + 0.35 * Math.sin(t * 1.3 + c.seed * 4)
            : c.kind === 'songbird' || c.kind === 'perched' || c.kind === 'wagtail' ? 1 - Math.min(1, Math.max(0, (burst + 0.35) * 4)) : 0;
          const peckK = !flying && c.vy === 0 ? Math.min(1, Math.max(0, (Math.sin(t * 2.3 + c.seed * 20) - 0.45) * 4)) : 0;
          if (lr.putBird(c.kind, c.x, c.y + hop + (flying ? s * 0.05 : 0), c.z, c.yaw, flying ? pitch : bob, 0, s, c.r, c.g, c.b, { fly: flying, beat: c.phase, glide, peck: peckK, time: own, seed: Math.floor(c.seed * 997) })) break;
          const y = c.y + s * 0.2 + hop;
          lr.put('bird', c.x, y, c.z, c.yaw, pitch, 0, s, s, s, c.r, c.g, c.b);
          // A finch beats in bursts and closes its wings between them; swallows and bats beat and sweep back.
          let flap: number;
          let sweep: number;
          if (!flying || (king && c.state === 1)) {
            flap = -0.15;
            sweep = 1.25;
          } else if (c.kind === 'songbird' || c.kind === 'perched' || c.kind === 'wagtail') {
            const burst = Math.sin(t * 5 + c.seed * 6) > -0.2;
            flap = burst ? Math.sin(c.phase) * 1.1 : -0.1;
            sweep = burst ? 0 : 0.9;
          } else if (c.kind === 'swallow') {
            flap = Math.sin(c.phase) * 0.6;
            sweep = 0.55 + Math.sin(t * 1.3 + c.seed * 4) * 0.25;
          } else {
            flap = Math.sin(c.phase) * 1.0;
            sweep = c.kind === 'bat' ? 0.1 : 0;
          }
          const span = c.kind === 'swallow' ? 1.5 : c.kind === 'bat' ? 1.6 : 1.2;
          for (const side of [1, -1]) lr.putChild('birdWing', c.x, y, c.z, c.yaw, pitch, 0, side * s * 0.18, s * 0.12, s * 0.05, side * flap, side * sweep, side * s * span * 0.55, s, s * 0.6, c.r * 0.85, c.g * 0.85, c.b * 0.85);
          break;
        }
        case 'fish': {
          const flee = c.state === 2;
          // A bottom fish noses down into the silt.
          lr.putFish(c.x, c.y, c.z, c.yaw, c.ref && !flee ? 0.18 : 0, c.size, c.r, c.g, c.b, c.phase, flee ? 3 : 1.1, flee ? 1.8 : 0.9);
          break;
        }
        case 'leap':
          lr.putFish(c.x, c.y, c.z, c.yaw, c.phase, c.size, c.r, c.g, c.b, t * 6, 2.5, 2);
          break;
        case 'tadpole':
          lr.putFish(c.x, c.y, c.z, c.yaw, 0, c.size, c.r, c.g, c.b, c.phase, c.state === 2 ? 6 : 4, 2.6);
          break;
        case 'crab': {
          // A scuttle rocks the body; at rest the claws (the whole front) lift now and then.
          const rock = c.state ? Math.sin(c.phase) * 0.08 : 0;
          const lift = c.state === 0 ? Math.max(0, Math.sin(t * 1.3 + c.seed * 20) - 0.7) * 0.5 : 0;
          lr.putLimbed('crab', c.x, c.y, c.z, c.yaw, -lift, rock, c.size, c.size, c.size, c.r, c.g, c.b, c.phase * 2, 0, c.state ? 1 : 0, c.seed * 10);
          break;
        }
        case 'skater':
          lr.put('skater', c.x, c.y, c.z, c.yaw, 0, 0, c.size, c.size, c.size, 1, 1, 1);
          break;
        case 'damselfly': {
          // A thin body; settled, the wings lie closed along it; flying, they flicker.
          const s = c.size;
          lr.put('dragon', c.x, c.y, c.z, c.yaw, 0, 0, s * 0.45, s * 0.45, s, c.r, c.g, c.b);
          const fly = c.state === 1;
          const fl = fly ? Math.sin(c.phase) * 0.6 : 0;
          const wings = lr.dragonflyWings();
          for (const side of [1, -1]) {
            for (const [m, beat] of [[wings.fore, fl], [wings.hind, -fl]] as const) {
              lr.putChild('dragonWing', c.x, c.y, c.z, c.yaw, 0, 0, side * m[0] * s * 0.45, m[1] * s * 0.45, m[2] * s, side * (fly ? beat : 0.25), side * (fly ? m[4] : 1.45), side * m[3] * s * 0.85, 1, m[3] * s * 0.6, 0.9, 0.95, 1);
            }
          }
          break;
        }
        case 'snake': {
          if (c.state === 4) lr.put('coil', c.x, c.y, c.z, c.yaw, 0, 0, c.size, c.size, c.size, c.r, c.g, c.b);
          else if (c.state === 5) {
            // The strike: the coil thrown forward at the leg.
            const lunge = Math.sin(Math.PI * clamp(1 - c.timer / 0.32, 0, 1)) * (0.35 + c.size * 0.45) * 0.7;
            lr.put('coil', c.x + Math.sin(c.yaw) * lunge, c.y, c.z + Math.cos(c.yaw) * lunge, c.yaw, -0.25, 0, c.size, c.size, c.size, c.r, c.g, c.b);
          } else if (c.state === 6) lr.putSnake(c.x, c.y, c.z, c.yaw, c.size, c.level, c.r * 0.85, c.g * 0.85, c.b * 0.85, c.seed * 6, 0, c.size * 0.03);
          else {
            const moving = c.state === 1 || c.state === 2;
            const rate = moving ? (c.state === 2 ? 2.2 : 0.9) : 0;
            lr.putSnake(c.x, c.y, c.z, c.yaw, c.size, c.level, c.r, c.g, c.b, moving ? 0 : c.seed * 6, rate, c.size * (moving ? 0.07 : 0.05));
          }
          break;
        }
        case 'frog': {
          const breathe = c.state === 0 ? Math.sin(t * 3 + c.seed * 9) * 0.04 : 0;
          lr.putLimbed('frog', c.x, c.y, c.z, c.yaw, c.state === 1 ? -0.5 : 0, 0, c.size, c.size * (1 + breathe), c.size, c.r, c.g, c.b, 0, 0, c.state === 1 ? 1 : 0, c.seed * 10);
          break;
        }
        case 'turtle':
          lr.putLimbed('turtle', c.x, c.y, c.z, c.yaw, c.state === 2 ? 0.15 : 0, 0, c.size, c.size, c.size, c.r, c.g, c.b, t * 2.2, 0, c.state !== 0 ? 1 : 0, c.seed * 10);
          break;
        case 'lizard': {
          const monitor = c.ref === 3;
          const push = c.state === 0 && !monitor ? Math.max(0, Math.sin(c.phase)) * 0.012 * (c.size / 0.25) : 0;
          // A monitor's walk swings its whole body; a running lizard wriggles.
          const swing = monitor || c.state === 1 ? Math.sin(c.phase) * (monitor ? 0.12 : 0.18) : 0;
          lr.putLimbed('lizard', c.x, c.y + push, c.z, c.yaw + swing, -push * 8, 0, c.size, c.size, c.size, c.r, c.g, c.b, c.phase, 0, monitor ? 0.7 : c.state === 1 ? 1 : 0, c.seed * 10);
          break;
        }
      }
    }
    for (const r of this.rings) lr.ring(r.x, r.y, r.z, r.r, r.age / r.life, r.k);
    lr.end();
  }
}

/** Shortest distance between segments PQ and RS in 3D. */
function segDist(px: number, py: number, pz: number, qx: number, qy: number, qz: number, rx: number, ry: number, rz: number, sx: number, sy: number, sz: number): number {
  const ux = qx - px;
  const uy = qy - py;
  const uz = qz - pz;
  const vx = sx - rx;
  const vy = sy - ry;
  const vz = sz - rz;
  const wx = px - rx;
  const wy = py - ry;
  const wz = pz - rz;
  const a = ux * ux + uy * uy + uz * uz;
  const b = ux * vx + uy * vy + uz * vz;
  const c = vx * vx + vy * vy + vz * vz;
  const d = ux * wx + uy * wy + uz * wz;
  const e = vx * wx + vy * wy + vz * wz;
  const den = a * c - b * b;
  let s = den > 1e-9 ? clamp((b * e - c * d) / den, 0, 1) : 0;
  let t = c > 1e-9 ? (b * s + e) / c : 0;
  if (t < 0) {
    t = 0;
    s = a > 1e-9 ? clamp(-d / a, 0, 1) : 0;
  } else if (t > 1) {
    t = 1;
    s = a > 1e-9 ? clamp((b - d) / a, 0, 1) : 0;
  }
  const ex = wx + ux * s - vx * t;
  const ey = wy + uy * s - vy * t;
  const ez = wz + uz * s - vz * t;
  return Math.hypot(ex, ey, ez);
}
