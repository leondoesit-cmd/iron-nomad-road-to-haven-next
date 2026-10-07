import * as THREE from 'three';
import { clamp, clamp01, smoothstep, TAU } from '../core/math';
import { FUELS, fireLight, flameHeight, flameLean, flicker, rainCooling, spreadRate, stepHeat, waterFate, windFeed, type Fuel } from '../sim/combustion';
import { fireDanger } from '../sim/climate';
import { FLAME_KIND, FireView } from '../render/fireRender';
import { FIRE_HAZE, FIRE_MAX, HAZE_MAX, clearFireLights, setFireLights, type FireLightIn } from '../render/fireLight';
import { CELL as DECAL, Decals } from '../render/decals';
import { catchChance } from './wildfire';
import type { Scene } from './scene';

/**
 * Fire, all of it: every flame in the world is a source here, whatever set it going (a campfire, a tree lightning found, a
 * thrown bottle, a burning car, a zombie that walked through any of those, the grass they lit). The engine
 *
 * - draws it (`render/fireRender.ts`): flames that lean in the wind, a bed of coals, embers and smoke that the wind carries;
 * - lights the world with it (`render/fireLight.ts`): the brightest and nearest few fires in each view become real lights on
 *   every surface, flickering as the flames do, glowing in the haze, the rain and their own smoke;
 * - lets the world answer back (`sim/combustion.ts`): rain beats fire down (not under a roof), water drowns it or, for fuel
 *   that floats, carries it burning on the current, wind fans it and leans it over, and dry ground carries it: a fire on grass
 *   spreads cell by cell, downwind fastest, into the trees, and leaves black ground behind it.
 *
 * Fires come three ways. `start` lights one the engine runs itself (a campfire, a patch of burning grass): it burns its fuel
 * down and the weather has its way with it. `hold` keeps one that something else runs (a burning tree, car or body): the
 * holder calls it every tick with where it is and how hot, and when it stops calling the fire dies down by itself.
 * `flash` is light alone, for a moment (an explosion).
 */

export type FireShape = 'pool' | 'crown' | 'point';

export interface FireOpts {
  x: number;
  y: number;
  z: number;
  /** Radius of the burning area, metres (a tree: its crown). */
  r?: number;
  fuel?: Fuel;
  /** Starting heat 0..1 (a fire catches, then grows). */
  heat?: number;
  /** Seconds of burning at full heat; Infinity keeps it going (a tended campfire). */
  burn?: number;
  shape?: FireShape;
  /** A tree: the top of its crown. */
  top?: number;
  /** Draw a bed of coals under it. Pool fires on the ground do by default. */
  bed?: boolean;
  /** Light multiplier (1 as bright as its size and fuel make it, 0 none). */
  light?: number;
  /** Burns whoever stands in it. Fires the engine runs do; held ones leave that to their holder. */
  hurts?: boolean;
  /** Lights dry ground round it. */
  spreads?: boolean;
  /** Smoke multiplier. */
  smoke?: number;
  /** Who set it, for the kill (-1 nobody). */
  owner?: number;
  /** How fast it moves through the air (m/s, x and z): its flames stream back as they would in a headwind. */
  vx?: number;
  vz?: number;
}

/** One patch of ground on the burning grid. */
interface GroundCell {
  ix: number;
  iz: number;
  fuel: number;
  src: FireSource | null;
  burnt: boolean;
  charred: boolean;
  t: number;
}

export class FireSource {
  key: unknown = null;
  x: number;
  y: number;
  z: number;
  r: number;
  fuel: Fuel;
  shape: FireShape;
  top: number;
  heat: number;
  /** The heat the fire is fed toward: the holder's word for a held fire, 1 for a free one. */
  want = 1;
  burn: number;
  bed: boolean;
  light: number;
  hurts: boolean;
  spreads: boolean;
  smoke: number;
  owner: number;
  vx = 0;
  vz = 0;
  readonly seed = Math.random();
  held = false;
  heldT = 0;
  age = 0;
  out = false;
  sheltered = false;
  /** A held fire gone under water: drawn out (it is up to its holder whether it really is). */
  drowned = 0;
  floating = false;
  flow: [number, number] | null = null;
  cell: GroundCell | null = null;
  /** How black the bed under it has burned. */
  char = 0;
  nx = 0;
  ny = 1;
  nz = 0;
  smokeAcc = 0;
  emberAcc = 0;
  steamAcc = 0;
  hurtT = 0;
  checkT = 0;
  spreadT = 1;

  constructor(o: FireOpts) {
    this.x = o.x;
    this.y = o.y;
    this.z = o.z;
    this.r = o.r ?? 0.5;
    this.fuel = o.fuel ?? 'wood';
    this.shape = o.shape ?? 'pool';
    this.top = o.top ?? o.y + 2;
    this.heat = o.heat ?? 0.2;
    this.burn = o.burn ?? FUELS[this.fuel].life * Math.max(0.3, this.r * this.r);
    this.bed = o.bed ?? (this.shape === 'pool' && this.fuel !== 'flesh' && this.fuel !== 'flare');
    this.light = o.light ?? 1;
    this.hurts = o.hurts ?? true;
    this.spreads = o.spreads ?? false;
    this.smoke = o.smoke ?? 1;
    this.owner = o.owner ?? -1;
    this.vx = o.vx ?? 0;
    this.vz = o.vz ?? 0;
  }

  /** Height of the flames now. */
  get flameH(): number {
    return flameHeight(this.fuel, this.r, this.heat);
  }
}

interface Flash {
  x: number;
  y: number;
  z: number;
  power: number;
  r: number;
  g: number;
  b: number;
  life: number;
  t: number;
}

/** A light before the views pick theirs: one fire, or several close together summed. */
interface Cand extends FireLightIn {
  power: number;
  /** Summed power of the fires in it, before crowding takes its share. */
  raw: number;
  wx: number;
  wy: number;
  wz: number;
}

/** Side of a cell of the burning-ground grid, metres. */
export const GROUND_CELL = 2.5;
/** Most patches of ground burning at once (the front stalls beyond it). */
const MAX_GROUND = 300;
/** A fire this far from every camera is not drawn. */
const DRAW_FAR = 1100;
const NEIGH: [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, 0.7],
  [1, -1, 0.7],
  [-1, 1, 0.7],
  [-1, -1, 0.7],
];
const STILL: [number, number] = [0, 0];

const _v = new THREE.Vector3();
const _t = new THREE.Vector3();

function cellKey(ix: number, iz: number): number {
  return (ix + 32768) * 65536 + (iz + 32768);
}

export class FireEngine {
  readonly view = new FireView();
  /** Black ground where grass burned. */
  readonly char = new Decals(1400);
  readonly sources: FireSource[] = [];
  private byKey = new Map<unknown, FireSource>();
  private cells = new Map<number, GroundCell>();
  private burningCells: GroundCell[] = [];
  private flashes: Flash[] = [];
  private cands: Cand[] = [];
  private nCand = 0;
  private clusterIdx = new Map<number, number>();
  private picks: FireLightIn[] = Array.from({ length: FIRE_MAX }, () => ({ x: 0, y: 0, z: 0, r: 1, cr: 0, cg: 0, cb: 0, range: 1 }));
  private order: number[] = [];
  private scores: number[] = [];
  /** What the ground holds to burn at a point, 0..1 (the leg sets it; nothing burns by default). */
  fuelAt: (x: number, z: number) => number = () => 0;
  /** Told when a patch of ground has burned out: the leg takes the grass off it. */
  onBurnt: (x: number, z: number, r: number) => void = () => {};
  /** Trees near a point, to catch from burning ground (the leg sets it). */
  treesNear: (x: number, z: number, r: number) => import('../world/flora').TreeSpot[] = () => [];
  /** Wind (m/s, x and z) and how ready the land is to burn, this tick. */
  wind: [number, number] = [0, 0];
  danger = 0;
  /** How thick the air is for the glow round the fires, this frame (1/m). */
  haze = 0.004;
  /** How much firelight shows against the day's light, 0.1 at noon to 1 at night. */
  private dim = 1;
  /** Firelight falling on the eye, eased the way an eye adapts. */
  private eye = 0;

  constructor(private sc: Scene) {
    sc.root.add(this.view.group);
    this.char.mesh.renderOrder = 1;
    sc.root.add(this.char.mesh);
  }

  // ------------------------------------------------------------------ lighting and keeping fires

  /** Light a fire the engine runs: it burns its fuel down and the weather has its way with it. */
  start(o: FireOpts): FireSource {
    const f = new FireSource(o);
    this.settle(f);
    this.sources.push(f);
    return f;
  }

  /**
   * Keep a fire something else runs. Call every tick with where it is and how hot (`heat`, 0..1); once the calls stop it dies
   * down by itself. The same `key` is the same fire.
   */
  hold(key: unknown, o: FireOpts & { heat: number }): FireSource {
    let f = this.byKey.get(key);
    if (!f || f.out) {
      f = new FireSource({ hurts: false, burn: Infinity, ...o, heat: Math.min(o.heat, 0.15) });
      f.held = true;
      f.key = key;
      this.byKey.set(key, f);
      this.settle(f);
      this.sources.push(f);
    }
    const moved = Math.abs(f.x - o.x) + Math.abs(f.z - o.z) > 0.6;
    f.x = o.x;
    f.y = o.y;
    f.z = o.z;
    if (o.r !== undefined) f.r = o.r;
    if (o.top !== undefined) f.top = o.top;
    if (o.fuel) f.fuel = o.fuel;
    if (o.light !== undefined) f.light = o.light;
    if (o.spreads !== undefined) f.spreads = o.spreads;
    f.vx = o.vx ?? 0;
    f.vz = o.vz ?? 0;
    f.want = clamp01(o.heat);
    f.heldT = 0;
    if (moved) this.settle(f);
    return f;
  }

  /** Stop keeping a held fire: it dies down. */
  release(key: unknown) {
    const f = this.byKey.get(key);
    if (f) f.heldT = 99;
  }

  /** Put a fire out at once (a bucket, a flood): steam where it was. */
  extinguish(f: FireSource) {
    if (f.out) return;
    this.steamBurst(f);
    f.out = true;
    f.heat = 0;
  }

  /** Water thrown or poured over a spot: everything there that water can drown goes out. */
  douse(x: number, z: number, r: number) {
    for (const f of this.sources) {
      if (f.held || FUELS[f.fuel].floats) continue;
      if (Math.hypot(f.x - x, f.z - z) < r + f.r * 0.5) this.extinguish(f);
    }
  }

  /** A moment of light (an explosion): `power` as a fire's, fading over `life` seconds. */
  flash(x: number, y: number, z: number, power: number, life = 0.35, color: [number, number, number] = [1, 0.62, 0.3]) {
    if (this.flashes.length > 24) this.flashes.shift();
    this.flashes.push({ x, y, z, power, r: color[0], g: color[1], b: color[2], life, t: 0 });
  }

  /** Where a fire sits: its ground's slope for the bed. */
  private settle(f: FireSource) {
    if (f.shape !== 'pool') return;
    const g = this.sc.groundAt.bind(this.sc);
    const dx = g(f.x + 0.6, f.z) - g(f.x - 0.6, f.z);
    const dz = g(f.x, f.z + 0.6) - g(f.x, f.z - 0.6);
    const l = Math.hypot(dx, 1.2, dz);
    f.nx = -dx / l;
    f.ny = 1.2 / l;
    f.nz = -dz / l;
  }

  // ------------------------------------------------------------------ the burning ground

  private cellAt(ix: number, iz: number): GroundCell {
    const k = cellKey(ix, iz);
    let c = this.cells.get(k);
    if (!c) {
      const fuel = this.fuelAt((ix + 0.5) * GROUND_CELL, (iz + 0.5) * GROUND_CELL);
      c = { ix, iz, fuel, src: null, burnt: false, charred: false, t: Math.random() * 0.3 };
      this.cells.set(k, c);
    }
    return c;
  }

  /** How much there is to burn on the ground at a point, as the grid sees it (0 once it has burned). */
  groundFuel(x: number, z: number): number {
    const c = this.cellAt(Math.floor(x / GROUND_CELL), Math.floor(z / GROUND_CELL));
    return c.burnt ? 0 : c.fuel;
  }

  /** Is the ground at a point burning now? */
  groundBurning(x: number, z: number): boolean {
    const c = this.cells.get(cellKey(Math.floor(x / GROUND_CELL), Math.floor(z / GROUND_CELL)));
    return !!c?.src && !c.src.out;
  }

  /** Has the ground at a point burned (the flames have been over it, if it still smoulders)? */
  groundBurnt(x: number, z: number): boolean {
    const c = this.cells.get(cellKey(Math.floor(x / GROUND_CELL), Math.floor(z / GROUND_CELL)));
    return !!c && (c.burnt || c.charred);
  }

  /** Set the ground at a point alight, if it is dry enough and has anything to burn. `chance` the odds it takes. */
  igniteGround(x: number, z: number, chance = 1, owner = -1): boolean {
    if (this.danger < 0.04 || this.burningCells.length >= MAX_GROUND) return false;
    const c = this.cellAt(Math.floor(x / GROUND_CELL), Math.floor(z / GROUND_CELL));
    if (c.src || c.burnt || c.fuel < 0.05) return false;
    if (Math.random() >= chance) return false;
    this.lightCell(c, owner);
    return true;
  }

  private lightCell(c: GroundCell, owner = -1) {
    const cx = (c.ix + 0.5) * GROUND_CELL + (Math.random() - 0.5) * 0.6;
    const cz = (c.iz + 0.5) * GROUND_CELL + (Math.random() - 0.5) * 0.6;
    const thick = c.fuel > 0.7;
    c.src = this.start({
      x: cx,
      y: this.sc.groundAt(cx, cz),
      z: cz,
      r: GROUND_CELL * 0.62,
      fuel: thick ? 'brush' : 'grass',
      heat: 0.12,
      burn: FUELS.grass.life * (0.5 + c.fuel),
      hurts: true,
      light: 0.6,
      smoke: 0.7,
      owner,
    });
    c.src.cell = c;
    this.burningCells.push(c);
  }

  private tickGround(dt: number) {
    const danger = this.danger;
    const [wx, wz] = this.wind;
    for (let i = this.burningCells.length - 1; i >= 0; i--) {
      const c = this.burningCells[i];
      const f = c.src!;
      // Black ground goes down under the bed as the flames pass their height.
      // Once the flames have passed their height the grass is gone and the ground under it black, though it smoulders on.
      if (!c.charred && (f.out || (f.age > 4 && f.heat < 0.55 && f.burn < FUELS.grass.life * 0.5))) {
        c.charred = true;
        this.scorch(f.x, f.z, GROUND_CELL * 0.85);
        this.onBurnt((c.ix + 0.5) * GROUND_CELL, (c.iz + 0.5) * GROUND_CELL, GROUND_CELL * 0.75);
      }
      if (f.out) {
        c.src = null;
        c.burnt = true;
        this.burningCells.splice(i, 1);
        continue;
      }
      c.t -= dt;
      if (c.t > 0 || f.heat < 0.25 || danger < 0.03) continue;
      const step = 0.3 + Math.random() * 0.05;
      c.t = step;
      for (const [dx, dz, k] of NEIGH) {
        if (this.burningCells.length >= MAX_GROUND) break;
        const n = this.cellAt(c.ix + dx, c.iz + dz);
        if (n.src || n.burnt || n.fuel < 0.04) continue;
        const along = (dx * wx + dz * wz) / Math.hypot(dx, dz);
        if (Math.random() < spreadRate(f.heat, n.fuel, danger, along) * k * step) this.lightCell(n, f.owner);
      }
      // Into the trees standing in it.
      if (f.heat > 0.55 && Math.random() < 0.25) {
        const wf = this.sc.weather.fire;
        for (const t of this.treesNear(f.x, f.z, 3.2)) wf.ignite(t, catchChance(danger, true) * 0.6);
      }
    }
  }

  private scorch(x: number, z: number, r: number) {
    const sc = this.sc;
    const g = sc.groundAt.bind(sc);
    const dx = g(x + 0.8, z) - g(x - 0.8, z);
    const dz = g(x, z + 0.8) - g(x, z - 0.8);
    const s = r * (2.1 + Math.random() * 0.5);
    this.char.add(x, g(x, z), z, { cell: DECAL.pool, w: s, h: s * (0.85 + Math.random() * 0.3), nx: -dx, ny: 1.6, nz: -dz, r: 0.022, g: 0.02, b: 0.018, opacity: 0.95, hole: true });
  }

  // ------------------------------------------------------------------ fixed tick

  tick(dt: number) {
    const sc = this.sc;
    const w = sc.weather;
    const outdoors = w.active;
    this.wind = outdoors ? w.wind : STILL;
    const rain = outdoors ? w.rain : 0;
    // Dew settles at night and a grass fire slows to a creep; it runs again in the heat of the day.
    this.danger = outdoors && sc.mode === 'leg' ? fireDanger(w.wet, w.rain, sc.heat) * (1 - 0.4 * sc.night) : 0;
    const wl = Math.hypot(this.wind[0], this.wind[1]);
    // Smoke and embers share the particle pools with everything else: a big fire thins its own out.
    const load = clamp(70 / Math.max(1, this.sources.length), 0.18, 1);
    for (let i = this.sources.length - 1; i >= 0; i--) {
      const f = this.sources[i];
      if (f.out) {
        this.drop(i);
        continue;
      }
      f.age += dt;
      f.checkT -= dt;
      if (f.checkT <= 0) {
        f.checkT = 0.3 + Math.random() * 0.15;
        this.surroundings(f, rain);
        if (f.out) {
          this.drop(i);
          continue;
        }
      }
      if (f.floating && f.flow) {
        f.x += f.flow[0] * dt * 0.8;
        f.z += f.flow[1] * dt * 0.8;
      }
      if (f.held) {
        f.heldT += dt;
        const want = f.heldT > 0.35 ? 0 : f.want;
        f.heat += (want - f.heat) * Math.min(1, dt * (want > f.heat ? 2.5 : 2));
        if (f.heldT > 0.35 && f.heat < 0.01) {
          f.out = true;
          this.drop(i);
          continue;
        }
      } else {
        const want = f.burn > 0 ? Math.min(1.1, f.want * windFeed(wl)) : 0;
        f.heat = stepHeat(f.heat, want, rainCooling(f.fuel, rain, f.heat, f.sheltered), dt);
        if (f.burn !== Infinity) f.burn -= dt * (0.35 + f.heat);
        if (f.heat < 0.012 && (f.burn <= 0 || f.age > 1.5)) {
          f.out = true;
          this.drop(i);
          continue;
        }
      }
      f.char = Math.min(1, f.char + dt * f.heat * 0.12);
      this.emit(f, dt, rain, load);
      if (f.hurts && f.heat > 0.2) this.burnAround(f, dt);
      // Dry ground round it catches: a bottle's pool, the litter under a burning tree, a car on the grass.
      if (f.spreads && f.heat > 0.3 && this.danger > 0.04) {
        f.spreadT -= dt;
        if (f.spreadT <= 0) {
          f.spreadT = 0.35 + Math.random() * 0.3;
          const a = Math.random() * TAU;
          const rr = f.r * (0.4 + 0.75 * Math.random());
          this.igniteGround(f.x + Math.cos(a) * rr, f.z + Math.sin(a) * rr, FUELS[f.fuel].spread * this.danger * f.heat, f.owner);
          // A crown fire throws burning brands downwind: spot fires out ahead of it.
          if (f.shape === 'crown' && f.heat > 0.6 && wl > 2 && Math.random() < 0.25) {
            const k = 4 + Math.random() * (6 + wl * 2.5);
            this.igniteGround(f.x + (this.wind[0] / wl) * k + (Math.random() - 0.5) * 6, f.z + (this.wind[1] / wl) * k + (Math.random() - 0.5) * 6, 0.5 * this.danger, f.owner);
          }
        }
      }
    }
    this.tickGround(dt);
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const fl = this.flashes[i];
      fl.t += dt;
      if (fl.t >= fl.life) this.flashes.splice(i, 1);
    }
  }

  private drop(i: number) {
    const f = this.sources[i];
    this.sources.splice(i, 1);
    if (f.key !== null && this.byKey.get(f.key) === f) this.byKey.delete(f.key);
  }

  /** Under a roof or on the water? Checked a few times a second. */
  private surroundings(f: FireSource, rain: number) {
    const sc = this.sc;
    if (rain > 0.02 && f.shape !== 'crown' && !f.cell) {
      const io = sc as unknown as { interiorAt?: (x: number, z: number, y: number) => boolean };
      f.sheltered = !!io.interiorAt?.(f.x, f.z, f.y + 1.2);
    }
    if (f.shape === 'crown') return;
    const w = sc.waterAt(f.x, f.z);
    const depth = w ? w.level - f.y : 0;
    if (f.held) {
      // A held fire that has gone under (a burning car in a lake) shows none, and boils.
      const drowned = depth > Math.max(0.3, f.flameH * 0.5) ? 1 : 0;
      if (drowned && !f.drowned && f.heat > 0.1) this.steamBurst(f);
      f.drowned = drowned;
      return;
    }
    const fate = waterFate(f.fuel, depth);
    if (fate === 'out') this.extinguish(f);
    else if (fate === 'floats' && w) {
      f.y = w.level + 0.02;
      f.floating = true;
      f.flow = w.flow ?? null;
      f.bed = false;
    }
  }

  private steamBurst(f: FireSource) {
    const fx = this.sc.fx;
    const n = 3 + Math.round(f.r * 4 * Math.max(0.3, f.heat));
    for (let k = 0; k < n; k++) {
      const a = Math.random() * TAU;
      const rr = Math.sqrt(Math.random()) * f.r;
      fx.smoke.emit(f.x + Math.cos(a) * rr, f.y + 0.2, f.z + Math.sin(a) * rr, (Math.random() - 0.5) * 0.8, 1.6 + Math.random() * 1.6, (Math.random() - 0.5) * 0.8, 1.6 + Math.random() * 1.4, 0.4 + f.r * 0.4, 1.8 + f.r * 1.5, 0.86, 0.87, 0.9, 0.42, -0.5, 0.6);
    }
  }

  /** Smoke off the top, embers lifting away, steam where the rain hits. */
  private emit(f: FireSource, dt: number, rain: number, load: number) {
    if (f.heat < 0.03 || f.drowned) return;
    const fx = this.sc.fx;
    const spec = FUELS[f.fuel];
    const H = f.flameH;
    const crown = f.shape === 'crown';
    const area = crown ? Math.PI * f.r * f.r * 0.6 : Math.PI * Math.max(0.05, f.r * f.r);
    const size = Math.pow(Math.min(area, 40), 0.75);
    const [wx, wz] = this.wind;
    const [lx, lz] = flameLean(wx, wz, H);
    const baseY = crown ? f.y + (f.top - f.y) * 0.75 : f.y;
    f.smokeAcc += dt * spec.smokeRate * f.smoke * f.heat * (1 + size * 0.8) * load;
    let n = 0;
    while (f.smokeAcc >= 1 && n++ < 4) {
      f.smokeAcc -= 1;
      const a = Math.random() * TAU;
      const rr = Math.sqrt(Math.random()) * f.r * 0.5;
      const y = crown ? f.top - 0.5 : f.y + H * 0.85;
      const s0 = 0.3 + f.r * 0.45 + H * 0.12;
      const g = 0.9 + Math.random() * 0.2;
      fx.smoke.emit(f.x + Math.cos(a) * rr + lx * H * 0.7, y, f.z + Math.sin(a) * rr + lz * H * 0.7, wx * 0.55 + (Math.random() - 0.5) * 0.4, 0.9 + f.heat * 1.4 + Math.sqrt(H) * 0.5, wz * 0.55 + (Math.random() - 0.5) * 0.4, 4.2 + Math.random() * 2.6 + H * 0.25, s0, s0 * 2.6 + 1.8 + f.r * 1.2, spec.smoke[0] * g, spec.smoke[1] * g, spec.smoke[2] * g, spec.smokeAlpha, -0.28, 0.16);
    }
    if (n >= 4) f.smokeAcc = 0;
    f.emberAcc += dt * spec.embers * f.heat * (0.5 + size * 0.6) * (1 + Math.hypot(wx, wz) * 0.05) * load;
    n = 0;
    while (f.emberAcc >= 1 && n++ < 6) {
      f.emberAcc -= 1;
      const a = Math.random() * TAU;
      const rr = Math.sqrt(Math.random()) * f.r * 0.7;
      const y = crown ? baseY + (f.top - baseY) * Math.random() : f.y + H * (0.2 + 0.5 * Math.random());
      const hot = 0.55 + Math.random() * 0.45;
      fx.glow.emit(f.x + Math.cos(a) * rr, y, f.z + Math.sin(a) * rr, wx * 0.4 + (Math.random() - 0.5) * 1.4, 1.4 + Math.random() * 2.6 + f.heat * 1.4, wz * 0.4 + (Math.random() - 0.5) * 1.4, 1.1 + Math.random() * 2.2, 0.045 + Math.random() * 0.05, 0.012, 3.2 * hot, 1.15 * hot, 0.22 * hot, 1, -0.35, 0.55);
    }
    if (n >= 6) f.emberAcc = 0;
    // Wood pops.
    if (spec.look === 'wood' && f.heat > 0.4 && Math.random() < dt * 0.25 * f.heat * load) fx.spark(f.x, f.y + H * 0.3, f.z, 3, 3.5);
    // Rain on the fire: it steams.
    if (rain > 0.05 && !f.sheltered) {
      f.steamAcc += dt * rain * 2.2 * (0.5 + size * 0.3) * load;
      if (f.steamAcc >= 1) {
        f.steamAcc -= 1;
        const a = Math.random() * TAU;
        const rr = Math.sqrt(Math.random()) * f.r;
        fx.smoke.emit(f.x + Math.cos(a) * rr, (crown ? baseY : f.y) + H * 0.4, f.z + Math.sin(a) * rr, wx * 0.3, 1.1 + Math.random() * 0.8, wz * 0.3, 1.4 + Math.random(), 0.25 + f.r * 0.25, 1.2 + f.r * 0.8, 0.84, 0.86, 0.88, 0.24, -0.4, 0.5);
      }
    }
  }

  /** Burn what stands in the flames: people, the dead, animals, cars. */
  private burnAround(f: FireSource, dt: number) {
    f.hurtT += dt;
    if (f.hurtT < 0.5) return;
    const step = f.hurtT;
    f.hurtT = 0;
    const sc = this.sc;
    const reach = f.r * (0.55 + 0.45 * f.heat) + 0.2;
    const dps = FUELS[f.fuel].dps * f.heat;
    for (const pl of sc.players) {
      if (pl.state === 'foot' && pl.invuln <= 0 && Math.hypot(pl.pos.x - f.x, pl.pos.z - f.z) < reach && Math.abs(pl.pos.y - f.y) < 2.2) pl.hurt(dps * step, f.x, f.z, 'fire');
    }
    sc.zombies.burnArea(f.x, f.z, reach, dps * 2.2, step, f.owner);
    sc.wildlife.burnArea(f.x, f.z, reach, dps * 2.2, step, f.owner);
    sc.raiders.burnArea(f.x, f.z, reach, dps * 1.5, step);
    sc.travellers.burnArea(f.x, f.z, reach, dps * 1.5, step, f.owner);
    for (const v of sc.vehicles) {
      if (v.wreck || Math.hypot(v.position.x - f.x, v.position.z - f.z) > reach + v.def.width * 0.5) continue;
      // A car driven through a grass fire comes out scorched; one left standing in it catches.
      const parked = Math.abs(v.speed) < 1.5;
      if (v.faction === 'convoy' && !parked) continue;
      v.takeHit(dps * step * 0.6, f.x, f.z, { incendiary: v.faction !== 'convoy' || Math.random() < 0.08, silent: true });
    }
  }

  // ------------------------------------------------------------------ the picture

  /** Lay out every flame and bed for this frame, and gather the light they give. */
  frame(dt: number) {
    const sc = this.sc;
    const t = sc.time;
    const view = this.view;
    view.begin();
    this.nCand = 0;
    this.clusterIdx.clear();
    const cams = this.cameras();
    // By day the sun swamps firelight: a campfire lights nothing much at noon and the whole camp at midnight.
    this.dim = sc.mode === 'delve' ? 1 : 0.1 + 0.9 * smoothstep(0, 0.85, sc.night);
    for (const f of this.sources) {
      const heat = f.heat * (1 - f.drowned);
      if (heat < 0.008) continue;
      const d = this.nearCam(cams, f.x, f.z);
      if (d > DRAW_FAR) continue;
      this.layout(f, heat, t, d);
      this.lightOf(f, heat, t, d);
    }
    for (const fl of this.flashes) {
      const k = Math.exp(-fl.t / (fl.life * 0.35)) * (1 - fl.t / fl.life);
      const p = fl.power * k;
      if (p > 0.5) this.addCand(fl.x, fl.y, fl.z, 0.8, fl.r * p, fl.g * p, fl.b * p, p, this.nearCam(cams, fl.x, fl.z));
    }
    view.end();
    this.char.time = sc.time;
    // The air the glow hangs in: thicker at night (the haze settles), much thicker in rain or a dust storm.
    const w = sc.weather;
    const rain = w.active ? w.rain : 0;
    this.haze = (0.0025 + 0.004 * sc.night + 0.016 * rain + 0.02 * sc.storm) * (sc.mode === 'delve' ? 2 : 1);
    // The eye adapts: by a big fire at night the dark beyond it goes darker.
    let lit = 0;
    for (const c of cams) {
      let e = 0;
      for (let i = 0; i < this.nCand; i++) {
        const q = this.cands[i];
        const d2 = (q.x - c.x) ** 2 + (q.y - c.y) ** 2 + (q.z - c.z) ** 2;
        e += q.power / (d2 + q.r * q.r);
      }
      lit = Math.max(lit, e);
    }
    this.eye += (lit - this.eye) * Math.min(1, dt * (lit > this.eye ? 2 : 0.7));
  }

  private cameras(): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    const R = this.sc.R;
    for (let i = 0; i < 2; i++) if (R.views[i]?.active !== false && this.sc.players[i]) out.push(R.views[i].camera.position);
    if (!out.length) out.push(R.views[0].camera.position);
    return out;
  }

  private nearCam(cams: THREE.Vector3[], x: number, z: number): number {
    let d = Infinity;
    for (const c of cams) d = Math.min(d, Math.hypot(c.x - x, c.z - z));
    return d;
  }

  /** The tongues of one fire, its bed, its lean in the wind. */
  private layout(f: FireSource, heat: number, t: number, dist: number) {
    const view = this.view;
    const spec = FUELS[f.fuel];
    const kind = FLAME_KIND[spec.look];
    const H = flameHeight(f.fuel, f.r, heat);
    // Gusts come and go: the lean swings with them.
    const gust = 1 + 0.3 * Math.sin(t * 0.63 + f.seed * 40) * Math.sin(t * 1.37 + f.seed * 13);
    // The air it burns in moves past it with the wind, and against it as it moves.
    const wx = this.wind[0] - f.vx;
    const wz = this.wind[1] - f.vz;
    const alpha = clamp01(heat * 4);
    // Far away a fire is a few big flames; close up, many.
    const detail = dist > 250 ? 0.4 : dist > 90 ? 0.7 : 1;
    if (f.shape === 'crown') {
      const h = f.top - f.y;
      const [lx, lz] = flameLean(wx * gust, wz * gust, h * 0.4);
      const climb = Math.min(1, 0.25 + heat * 1.1);
      const n = Math.max(4, Math.round((6 + heat * 18) * detail));
      for (let k = 0; k < n && view.flameRoom > 0; k++) {
        const hk = hashK(f.seed, k);
        const hk2 = hashK(f.seed + 0.37, k);
        const up = hk2 * climb;
        const y = f.y + h * (0.08 + 0.85 * up);
        const rr = (0.15 + up * 0.85) * f.r * Math.sqrt(hashK(f.seed + 0.71, k)) * Math.min(1, heat * 1.6);
        const a = k * 2.39996 + f.seed * 31;
        const life = 0.5 + 0.5 * Math.sin(t * (0.6 + hk * 0.8) + hk * 50);
        const th = Math.min(h * 0.55, (1.2 + 3.8 * heat) * (0.55 + 0.6 * hk) * (0.75 + 0.35 * life) * (0.6 + 0.4 * h / 10));
        view.flame({ x: f.x + Math.cos(a) * rr, y, z: f.z + Math.sin(a) * rr, seed: hk * 97 + k * 0.13, w: th * 0.62, h: th, heat: heat * (0.8 + 0.2 * life), kind, lx, lz, flick: spec.flick, alpha: alpha * (0.7 + 0.3 * life) });
      }
      return;
    }
    const [lx, lz] = flameLean(wx * gust, wz * gust, H);
    const point = f.shape === 'point';
    const grass = f.cell !== null;
    // A dying patch of grass is embers with the odd flame, not a carpet of little ones.
    const n = point ? 2 : grass ? Math.round((2.5 + f.r * 1.2) * detail * smoothstep(0.08, 0.5, heat)) : Math.max(3, Math.min(24, Math.round((4 + f.r * 4.5 * (0.4 + 0.6 * heat)) * detail)));
    for (let k = 0; k < n && view.flameRoom > 0; k++) {
      const hk = hashK(f.seed, k);
      const u = (k + 0.5) / n;
      const rr = point ? 0 : f.r * 0.78 * Math.sqrt(u) * (0.8 + 0.4 * hashK(f.seed + 0.5, k));
      const a = k * 2.39996 + f.seed * 31;
      // Each tongue lives its own life: grows, shrinks, comes back.
      const life = 0.5 + 0.5 * Math.sin(t * (0.7 + hk * 0.9) + hk * 60);
      const centre = 1 - 0.5 * (rr / Math.max(f.r, 0.01));
      const th = H * centre * (0.7 + 0.45 * hk) * (0.72 + 0.38 * life);
      const tw = point ? Math.max(0.08, f.r * 2.2) : Math.min(th * 0.72, f.r * 1.4 + 0.15) * (0.8 + 0.4 * hashK(f.seed + 0.9, k));
      view.flame({ x: f.x + Math.cos(a) * rr, y: f.y - 0.04, z: f.z + Math.sin(a) * rr, seed: hk * 97 + k * 0.13, w: tw, h: th, heat: heat * (0.82 + 0.18 * life), kind, lx, lz, flick: spec.flick, alpha: alpha * (0.8 + 0.2 * life) });
    }
    if (f.bed && dist < 400) view.bed(f.x, f.y, f.z, f.r * 1.12, f.nx, f.ny, f.nz, Math.max(f.char, 0.4), heat, f.seed * 13, kind);
  }

  /** The light one fire gives, merged with its neighbours into one light where they crowd together. */
  private lightOf(f: FireSource, heat: number, t: number, dist: number) {
    if (f.light <= 0) return;
    const spec = FUELS[f.fuel];
    const fl = flicker(t, f.seed * 7, spec.flick);
    const crown = f.shape === 'crown';
    const L = fireLight(f.fuel, crown ? f.r * 0.8 : f.r, heat, fl * f.light);
    if (L.power < 0.3) return;
    const H = crown ? (f.top - f.y) * 0.6 : flameHeight(f.fuel, f.r, heat);
    const [lx, lz] = flameLean(this.wind[0] - f.vx, this.wind[1] - f.vz, Math.max(H, 0.3));
    // The light's centre wanders with the flames, so the shadows they throw move.
    const j = 0.12 * f.r * spec.flick;
    const x = f.x + lx * H * 0.3 + j * Math.sin(t * 7.3 + f.seed * 50);
    const z = f.z + lz * H * 0.3 + j * Math.sin(t * 6.1 + f.seed * 70);
    const y = crown ? f.y + (f.top - f.y) * 0.55 : f.y + Math.max(0.25, H * 0.42);
    const k = this.dim;
    // The glowing body is the whole flame, not a point: close by, the light falls off as from something that size.
    this.addCand(x, y, z, Math.max(0.3, crown ? f.r * 0.7 : f.r * 0.6 + H * 0.45), L.r * k, L.g * k, L.b * k, L.power * k, dist);
  }

  private addCand(x: number, y: number, z: number, r: number, cr: number, cg: number, cb: number, power: number, dist: number) {
    // Near fires keep their own lights a few metres apart; far ones are lumped coarsely.
    const cs = dist < 110 ? 7 : 40;
    const key = cellKey(Math.floor(x / cs), Math.floor(z / cs)) + (cs === 7 ? 0 : 0.5);
    const at = this.clusterIdx.get(key);
    if (at !== undefined) {
      const c = this.cands[at];
      const p = c.power + power;
      c.wx = (c.wx * c.power + x * power) / p;
      c.wy = (c.wy * c.power + y * power) / p;
      c.wz = (c.wz * c.power + z * power) / p;
      c.r = Math.max(c.r, r, Math.hypot(c.x - x, c.z - z) * 0.5);
      // Many fires crowded together light their surroundings less than their sum: they shade each other, and the eye
      // takes in a wall of flame as bright, not as a hundred campfires.
      const raw = c.raw + power;
      const k = raw / (1 + raw / 900) / Math.max(1e-6, c.power);
      c.cr = (c.cr + cr) * k;
      c.cg = (c.cg + cg) * k;
      c.cb = (c.cb + cb) * k;
      c.raw = raw;
      c.power = raw / (1 + raw / 900);
      c.x = c.wx;
      c.y = c.wy;
      c.z = c.wz;
      c.range = clamp(Math.sqrt(p / 0.025), 4, 120);
      return;
    }
    let c = this.cands[this.nCand];
    if (!c) {
      c = { x: 0, y: 0, z: 0, r: 1, cr: 0, cg: 0, cb: 0, range: 1, power: 0, raw: 0, wx: 0, wy: 0, wz: 0 };
      this.cands.push(c);
    }
    c.x = c.wx = x;
    c.y = c.wy = y;
    c.z = c.wz = z;
    c.r = r;
    c.cr = cr;
    c.cg = cg;
    c.cb = cb;
    c.power = power;
    c.raw = power;
    c.range = clamp(Math.sqrt(power / 0.025), 4, 120);
    this.clusterIdx.set(key, this.nCand++);
  }

  /**
   * Each view's lights: the fires that light most of what it sees (bright and near). Where there are more than it can carry,
   * the last few fade by how close they are to losing their place, so nothing pops as the camera moves.
   */
  beforeView = (i: number, cam: THREE.Camera) => {
    this.haze4(i, cam);
    const n = this.nCand;
    if (!n) {
      clearFireLights();
      return;
    }
    const p = cam.position;
    const order = this.order;
    const scores = this.scores;
    order.length = 0;
    scores.length = 0;
    for (let k = 0; k < n; k++) {
      const c = this.cands[k];
      const d2 = (c.x - p.x) ** 2 + (c.y - p.y) ** 2 + (c.z - p.z) ** 2;
      // A fire far off still lights the ground round itself for anyone looking at it, so only the fog's end rules one out.
      if (d2 > 640000) continue;
      const s = c.power / (d2 + 9);
      // Insertion into the few best.
      let at = order.length;
      while (at > 0 && scores[at - 1] < s) at--;
      if (at > FIRE_MAX) continue;
      order.splice(at, 0, k);
      scores.splice(at, 0, s);
      if (order.length > FIRE_MAX + 1) {
        order.length = FIRE_MAX + 1;
        scores.length = FIRE_MAX + 1;
      }
    }
    const m = Math.min(FIRE_MAX, order.length);
    const next = order.length > FIRE_MAX ? scores[FIRE_MAX] : 0;
    for (let k = 0; k < m; k++) {
      const c = this.cands[order[k]];
      const w = next > 0 ? clamp01((scores[k] - next) / (0.35 * scores[k])) : 1;
      const o = this.picks[k];
      o.x = c.x;
      o.y = c.y;
      o.z = c.z;
      o.r = c.r;
      o.cr = c.cr * w;
      o.cg = c.cg * w;
      o.cb = c.cb * w;
      o.range = c.range;
    }
    setFireLights(this.picks, m, this.haze);
  };

  /**
   * The hot air over the fires that fill most of this view: where it stands on the screen, for the composite to bend what
   * lies behind it.
   */
  private haze4(i: number, cam: THREE.Camera) {
    const base = (i & 1) * HAZE_MAX * 8;
    FIRE_HAZE.fill(0, base, base + HAZE_MAX * 8);
    if (!this.sources.length || !(cam as THREE.PerspectiveCamera).isPerspectiveCamera) return;
    const P = cam.projectionMatrix.elements;
    const best = this.hazeBest;
    best.length = 0;
    for (const f of this.sources) {
      const heat = f.heat * (1 - f.drowned);
      if (heat < 0.15) continue;
      const crown = f.shape === 'crown';
      const H = crown ? f.top - f.y : f.flameH;
      const plume = H * 1.8 + 0.5;
      _v.set(f.x, crown ? f.y + H * 0.4 : f.y, f.z).applyMatrix4(cam.matrixWorldInverse);
      const depth = -_v.z;
      if (depth < 0.5 || depth > 220) continue;
      _v.applyMatrix4(cam.projectionMatrix);
      _t.set(f.x, (crown ? f.y + H * 0.4 : f.y) + plume, f.z).project(cam);
      const hw = ((Math.max(f.r, H * 0.35) * 1.3) / depth) * P[0] * 0.5;
      const hh = (_t.y - _v.y) * 0.5;
      const cx = _v.x * 0.5 + 0.5;
      const by = _v.y * 0.5 + 0.5;
      if (hh < 0.004 || cx + hw < 0 || cx - hw > 1 || by > 1 || by + hh < 0) continue;
      const score = heat * hw * hh;
      let at = best.length;
      while (at > 0 && best[at - 1].score < score) at--;
      if (at >= HAZE_MAX) continue;
      best.splice(at, 0, { score, cx, by, hw, hh, k: heat * (f.cell ? 0.7 : 1), depth });
      if (best.length > HAZE_MAX) best.length = HAZE_MAX;
    }
    for (let k = 0; k < best.length; k++) {
      const b = best[k];
      const o = base + k * 8;
      FIRE_HAZE[o] = b.cx;
      FIRE_HAZE[o + 1] = b.by;
      FIRE_HAZE[o + 2] = b.hw;
      FIRE_HAZE[o + 3] = b.hh;
      FIRE_HAZE[o + 4] = b.k;
      FIRE_HAZE[o + 5] = b.depth;
    }
  }

  private hazeBest: { score: number; cx: number; by: number; hw: number; hh: number; k: number; depth: number }[] = [];

  /** How far the eye has stopped down for the fires it is looking at, as a factor on the exposure (1 none). */
  get exposure(): number {
    return 1 / (1 + 0.09 * this.eye);
  }

  // ------------------------------------------------------------------ asking about it

  /** How hard the nearest fire roars at a point (for the sound), 0..1. */
  loudness(x: number, z: number): number {
    let best = 0;
    for (const f of this.sources) {
      if (f.heat < 0.05 || f.drowned) continue;
      const size = clamp01(0.35 + f.r * 0.25 + (f.shape === 'crown' ? 0.4 : 0));
      const d = Math.hypot(f.x - x, f.z - z);
      best = Math.max(best, f.heat * size * (1 - smoothstep(4 + f.r * 2, 60 + f.r * 25, d)));
    }
    return best;
  }

  /** The fire burning nearest a point within `r`, or null. */
  nearest(x: number, z: number, r: number): FireSource | null {
    let best: FireSource | null = null;
    let bd = r;
    for (const f of this.sources) {
      if (f.heat < 0.1) continue;
      const d = Math.hypot(f.x - x, f.z - z) - f.r;
      if (d < bd) {
        bd = d;
        best = f;
      }
    }
    return best;
  }

  /** Lights, flames and black ground, all gone (a new day). */
  clear() {
    this.sources.length = 0;
    this.byKey.clear();
    this.cells.clear();
    this.burningCells.length = 0;
    this.flashes.length = 0;
    this.nCand = 0;
    this.char.clear();
  }

  dispose() {
    this.clear();
    clearFireLights();
    FIRE_HAZE.fill(0);
    this.view.group.removeFromParent();
    this.char.mesh.removeFromParent();
    this.view.dispose();
    this.char.dispose();
  }

  /** Every patch of ground that has burned (or is burning: by tomorrow it will have), by grid cell. */
  scorchedCells(): number[] {
    const out: number[] = [];
    for (const [k, c] of this.cells) if (c.burnt || c.src) out.push(k);
    return out;
  }

  /** Lay down ground that burned on an earlier day: black, and with nothing left on it to burn. */
  restoreScorched(keys: readonly number[]) {
    for (const k of keys) {
      const ix = Math.floor(k / 65536) - 32768;
      const iz = (k % 65536) - 32768;
      if (this.cells.get(k)?.burnt) continue;
      this.cells.set(k, { ix, iz, fuel: 0, src: null, burnt: true, charred: true, t: 0 });
      this.scorch((ix + 0.5) * GROUND_CELL, (iz + 0.5) * GROUND_CELL, GROUND_CELL * 0.85);
    }
  }

  /** Call `fn` with the centre of every patch of burnt ground in a box (a chunk being drawn takes its grass off them). */
  forBurntIn(x0: number, z0: number, x1: number, z1: number, fn: (x: number, z: number, r: number) => void) {
    if (!this.cells.size) return;
    for (let ix = Math.floor(x0 / GROUND_CELL); ix <= Math.floor(x1 / GROUND_CELL); ix++) {
      for (let iz = Math.floor(z0 / GROUND_CELL); iz <= Math.floor(z1 / GROUND_CELL); iz++) {
        const c = this.cells.get(cellKey(ix, iz));
        if (c && (c.burnt || c.charred)) fn((ix + 0.5) * GROUND_CELL, (iz + 0.5) * GROUND_CELL, GROUND_CELL * 0.75);
      }
    }
  }

  /** Night falls on whatever is still burning: by morning it has burned out. */
  burnOutGround() {
    for (const c of this.burningCells) this.onBurnt((c.ix + 0.5) * GROUND_CELL, (c.iz + 0.5) * GROUND_CELL, GROUND_CELL * 0.75);
  }

  /** For the tests and the curious: how many patches of ground are burning, and have burned. */
  groundStats(): { burning: number; burnt: number } {
    let burnt = 0;
    for (const c of this.cells.values()) if (c.burnt) burnt++;
    return { burning: this.burningCells.length, burnt };
  }
}

/** A steady pseudo-random 0..1 per fire and tongue, so a fire's shape holds from frame to frame. */
function hashK(seed: number, k: number): number {
  const s = Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453;
  return s - Math.floor(s);
}
