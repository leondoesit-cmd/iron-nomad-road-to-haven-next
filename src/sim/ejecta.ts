import type { SoilKind } from './soil';

/**
 * Material in the air: clumps a spinning tyre flings off its tread, the spray a round or a blast throws out of its crater,
 * the grit a round knocks off concrete or asphalt. Each piece carries its volume (m^3) and flies by its weight: the air
 * drags on it by its size and density (quadratic drag toward the wind's velocity), so fine sand slows quickly, hangs a
 * moment and drifts downwind, a storm carries it off, while a crumb of earth, a pebble or a chip of concrete flies on
 * nearly as thrown and the wind barely moves it. Where a piece of soil comes down the ground field gets it back (`land`):
 * nothing thrown is lost, and where it falls it heaps; grit off hard ground is not soil and is simply gone. Pure;
 * `render/sandSpray.ts` draws it.
 */

export type EjectaKind = SoilKind | 'grit';

export const KINDS: EjectaKind[] = ['sand', 'loam', 'mud', 'gravel', 'clay', 'rock', 'grit'];

/**
 * What a piece of each kind is made of: the grain it flies as (m), its density (kg/m^3), its drag coefficient, whether it
 * reads as a solid lump rather than a spray of grains, and whether it is soil the field takes back when it lands.
 */
export const GRAIN: Record<EjectaKind, { d: number; rho: number; cd: number; solid: boolean; soil: boolean }> = {
  sand: { d: 0.00025, rho: 2650, cd: 0.5, solid: false, soil: true },
  // Earth's spray is its fine soil in small aggregates (its crumbs fly as lumps of their own): a plume that hangs together,
  // heavier than single sand grains, drawn as grains rather than a shower of pebbles.
  loam: { d: 0.0012, rho: 1600, cd: 0.8, solid: false, soil: true },
  mud: { d: 0.012, rho: 1800, cd: 0.6, solid: true, soil: true },
  gravel: { d: 0.008, rho: 2600, cd: 0.6, solid: true, soil: true },
  // Dry crust breaks in flakes, which catch the air.
  clay: { d: 0.0014, rho: 1900, cd: 1.1, solid: false, soil: true },
  // Chips of rock are angular and fly far; what is chipped off a rock is not soil, and is gone where it falls.
  rock: { d: 0.005, rho: 2600, cd: 0.9, solid: true, soil: false },
  grit: { d: 0.003, rho: 2300, cd: 0.8, solid: true, soil: false },
};

/** Density of air, kg/m^3. */
const RHO_AIR = 1.2;
/** Longest a piece flies before it is set down where it is, s. */
const LIFE = 6;

/**
 * Quadratic drag of a grain `d` metres across, 1/m: a = -k |v - w| (v - w). Its terminal speed is sqrt(g / k): about 4 m/s
 * for fine sand, 12 for a crumb of earth, 20 or more for a pebble.
 */
export function dragOf(d: number, rho: number, cd: number): number {
  return (3 * RHO_AIR * cd) / (4 * rho * Math.max(1e-5, d));
}

export interface Throw {
  /** Called when the air is full: the piece comes down at once where it starts. */
  onFull?: (x: number, z: number, vol: number) => void;
  /** Its colour (linear-ish rgb), when it is not its soil's own (grit off asphalt, off concrete). */
  tint?: readonly [number, number, number];
  /** How coarse it is against its kind's usual grain (1). */
  coarse?: number;
}

export class Ejecta {
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly vol: Float32Array;
  readonly age: Float32Array;
  /** Its air drag, 1/m (`dragOf`). */
  readonly k: Float32Array;
  /** Index into `KINDS`. */
  readonly kind: Uint8Array;
  /** Its colour, when it was given one (`tinted` set), else its soil's. */
  readonly tint: Float32Array;
  readonly tinted: Uint8Array;
  /** A per-piece random, for the drawing (shape, turn). */
  readonly seed: Float32Array;
  /** Pieces in flight: the first `n` of every array. */
  n = 0;
  /** Volume launched and landed so far, m^3, for tests. */
  launched = 0;
  landed = 0;
  /** Volume that came down where the field takes none (water, asphalt), or was not soil, m^3. */
  lost = 0;

  constructor(readonly max = 4096) {
    this.px = new Float32Array(max);
    this.py = new Float32Array(max);
    this.pz = new Float32Array(max);
    this.vx = new Float32Array(max);
    this.vy = new Float32Array(max);
    this.vz = new Float32Array(max);
    this.vol = new Float32Array(max);
    this.age = new Float32Array(max);
    this.k = new Float32Array(max);
    this.kind = new Uint8Array(max);
    this.tint = new Float32Array(max * 3);
    this.tinted = new Uint8Array(max);
    this.seed = new Float32Array(max);
  }

  /**
   * Throw a piece. When the air is full, it lands at once where it starts: the field still gets its soil (`o.onFull`, which
   * the caller points at its deposit).
   */
  launch(x: number, y: number, z: number, vx: number, vy: number, vz: number, vol: number, kind: EjectaKind, o: Throw = {}) {
    if (vol <= 0) return;
    this.launched += vol;
    if (this.n >= this.max) {
      this.landed += vol;
      o.onFull?.(x, z, vol);
      return;
    }
    const i = this.n++;
    const g = GRAIN[kind];
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.vol[i] = vol;
    this.age[i] = 0;
    // Grains vary: the coarse ones fly on, the fine ones hang and drift.
    this.k[i] = dragOf(g.d * (o.coarse ?? 1) * (0.5 + 1.3 * Math.random()), g.rho, g.cd);
    this.kind[i] = KINDS.indexOf(kind);
    this.tinted[i] = o.tint ? 1 : 0;
    if (o.tint) {
      this.tint[i * 3] = o.tint[0];
      this.tint[i * 3 + 1] = o.tint[1];
      this.tint[i * 3 + 2] = o.tint[2];
    }
    this.seed[i] = Math.random();
  }

  /**
   * Fly every piece one step through air moving at (wx, wz) m/s. `ground` is the height of the surface under a point (null:
   * nowhere to land, as over open water); a piece under it comes down, and `land` is told where, how much and how fast it
   * was going (false from `land` means the ground took none of it).
   */
  step(dt: number, wx: number, wz: number, ground: (x: number, z: number) => number | null, land: (x: number, z: number, vol: number, kind: EjectaKind, vx: number, vy: number, vz: number) => boolean) {
    for (let i = 0; i < this.n; ) {
      // Drag on the velocity through the air, taken implicitly so the finest grain never overshoots the wind.
      const rx = this.vx[i] - wx;
      const ry = this.vy[i];
      const rz = this.vz[i] - wz;
      const f = 1 / (1 + this.k[i] * Math.sqrt(rx * rx + ry * ry + rz * rz) * dt);
      this.vx[i] = wx + rx * f;
      this.vz[i] = wz + rz * f;
      this.vy[i] = ry * f - 9.81 * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      this.age[i] += dt;
      const g = this.vy[i] < 0 || this.age[i] > LIFE ? ground(this.px[i], this.pz[i]) : undefined;
      if (g === null || (g !== undefined && (this.py[i] <= g || this.age[i] > LIFE))) {
        const v = this.vol[i];
        const kind = KINDS[this.kind[i]];
        if (g !== null && GRAIN[kind].soil && land(this.px[i], this.pz[i], v, kind, this.vx[i], this.vy[i], this.vz[i])) this.landed += v;
        else this.lost += v;
        this.remove(i);
        continue;
      }
      i++;
    }
  }

  private remove(i: number) {
    const j = --this.n;
    if (i === j) return;
    this.px[i] = this.px[j];
    this.py[i] = this.py[j];
    this.pz[i] = this.pz[j];
    this.vx[i] = this.vx[j];
    this.vy[i] = this.vy[j];
    this.vz[i] = this.vz[j];
    this.vol[i] = this.vol[j];
    this.age[i] = this.age[j];
    this.k[i] = this.k[j];
    this.kind[i] = this.kind[j];
    this.tinted[i] = this.tinted[j];
    this.tint[i * 3] = this.tint[j * 3];
    this.tint[i * 3 + 1] = this.tint[j * 3 + 1];
    this.tint[i * 3 + 2] = this.tint[j * 3 + 2];
    this.seed[i] = this.seed[j];
  }

  clear() {
    this.n = 0;
  }
}
