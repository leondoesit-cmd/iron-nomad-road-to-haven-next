import { clamp, clamp01 } from '../core/math';

/**
 * Bullets as physical things, as pure rules: how fast each round leaves the muzzle, how the air slows and pushes it, what
 * it can punch through, how hard it shoves what it hits and how much of a body it can take off. No engine imports, so
 * every number here is testable and tuned in one place.
 *
 * Speeds are game-scaled (a pistol round really leaves at ~360 m/s): slow enough that a long shot has real flight time,
 * drop and wind drift, fast enough that anything inside a street is still near-instant.
 */

export type AmmoKind = 'pistol' | 'magnum' | 'smg' | 'pellet' | 'rifle' | 'sniper' | 'turret' | 'raider';

export interface AmmoSpec {
  /** Muzzle velocity, m/s. */
  speed: number;
  /** Quadratic drag, 1/m: a = -drag * |v - wind| * (v - wind). It is also how hard the wind pushes the round. */
  drag: number;
  /** kg. */
  mass: number;
  /** Penetration rating. A surface with a lower `stop` than this (scaled by the energy left) lets the round through. */
  pen: number;
  /** How well it takes limbs off, per point of damage: 0 never, 1 a shotgun pellet, above 1 a rifle. */
  gore: number;
  /** Range the sights are zeroed for, m: inside it the round is aimed to land on the reticle despite the drop. */
  zero: number;
  /** Width in metres of the mark it leaves on a wall: about the size of the hole it makes plus the paint it blows off. */
  hole: number;
}

export const AMMO: Record<AmmoKind, AmmoSpec> = {
  pistol: { speed: 250, drag: 0.0024, mass: 0.008, pen: 0.28, gore: 0, zero: 35, hole: 0.09 },
  magnum: { speed: 235, drag: 0.0019, mass: 0.0102, pen: 0.4, gore: 0.7, zero: 40, hole: 0.12 },
  smg: { speed: 265, drag: 0.0026, mass: 0.0075, pen: 0.24, gore: 0, zero: 30, hole: 0.085 },
  pellet: { speed: 215, drag: 0.009, mass: 0.0035, pen: 0.09, gore: 1, zero: 18, hole: 0.055 },
  rifle: { speed: 520, drag: 0.0006, mass: 0.0097, pen: 1.15, gore: 1.6, zero: 100, hole: 0.16 },
  sniper: { speed: 540, drag: 0.0005, mass: 0.0097, pen: 0.95, gore: 1.1, zero: 90, hole: 0.18 },
  turret: { speed: 480, drag: 0.0007, mass: 0.0095, pen: 0.6, gore: 1.1, zero: 70, hole: 0.21 },
  raider: { speed: 260, drag: 0.0023, mass: 0.0085, pen: 0.3, gore: 0, zero: 45, hole: 0.09 },
};

/** The round a gun model fires. */
export function ammoForGun(model: string): AmmoKind {
  switch (model) {
    case 'revolver':
      return 'magnum';
    case 'smg':
      return 'smg';
    case 'sawn':
    case 'pump':
      return 'pellet';
    case 'rifle':
      return 'rifle';
    default:
      return 'pistol';
  }
}

export const GRAVITY = 9.81;

export interface BulletState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/** Advance one round through the air: gravity, and drag against the wind (which is how the wind pushes it). */
export function stepBullet(b: BulletState, dt: number, drag: number, windX: number, windZ: number): void {
  const rx = b.vx - windX;
  const rz = b.vz - windZ;
  const rel = Math.sqrt(rx * rx + b.vy * b.vy + rz * rz);
  const k = drag * rel;
  b.vx -= rx * k * dt;
  b.vy -= (b.vy * k + GRAVITY) * dt;
  b.vz -= rz * k * dt;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.z += b.vz * dt;
}

export const speedOf = (b: BulletState) => Math.hypot(b.vx, b.vy, b.vz);

/** Share of full damage a round still deals at a given share of its muzzle speed: it keeps most of its bite until it is spent. */
export function damageFraction(speedFrac: number): number {
  const f = clamp01(speedFrac);
  return 0.35 + 0.65 * f * f;
}

/** Seconds a round takes to cover a distance, with the drag slowing it (v falls off as e^(-k x)). */
export function flightTime(spec: AmmoSpec, dist: number): number {
  if (dist <= 0) return 0;
  const k = spec.drag;
  return k < 1e-9 ? dist / spec.speed : (Math.exp(k * dist) - 1) / (k * spec.speed);
}

/** How far a round falls over a distance, ignoring the wind. */
export function dropAt(spec: AmmoSpec, dist: number): number {
  const t = flightTime(spec, dist);
  return 0.5 * GRAVITY * t * t;
}

/**
 * The upward angle (radians) that makes a round cross the line of sight at the zeroed range. Added to every shot, so up to
 * that range it lands on the reticle and past it the drop starts to show. Never more than the aimed distance asks for.
 */
export function zeroPitch(spec: AmmoSpec, aimedDist: number): number {
  const r = Math.max(4, Math.min(spec.zero, aimedDist));
  return dropAt(spec, r) / r;
}

/** Wind, as the lateral push a round feels, summed over a flight: how far it drifts (m) at a distance in a steady crosswind. */
export function driftAt(spec: AmmoSpec, dist: number, windSpeed: number): number {
  const t = flightTime(spec, dist);
  const v = dist / Math.max(1e-6, t);
  return 0.5 * spec.drag * v * windSpeed * t * t;
}

// ------------------------------------------------------------------ what a round goes through

export type Surface = 'dirt' | 'stone' | 'concrete' | 'wood' | 'plaster' | 'glass' | 'sheet' | 'car' | 'steel';

export interface SurfaceSpec {
  /** Penetration rating needed to get through at the reference thickness. Above 9 nothing gets through. */
  stop: number;
  /** Thickness (m) the rating is for. A thicker slab asks for more, a thinner one for less. */
  ref: number;
  /** Chips and sparks thrown off: 0 none. */
  spark: number;
  /** Dust or splinter colour. */
  tint: [number, number, number];
  /** Does a hit leave a hole? */
  hole: boolean;
}

export const SURFACES: Record<Surface, SurfaceSpec> = {
  dirt: { stop: 99, ref: 1, spark: 0, tint: [0.55, 0.45, 0.33], hole: false },
  stone: { stop: 99, ref: 1, spark: 2, tint: [0.6, 0.57, 0.52], hole: true },
  concrete: { stop: 1.5, ref: 0.25, spark: 2, tint: [0.62, 0.6, 0.57], hole: true },
  wood: { stop: 0.18, ref: 0.08, spark: 0, tint: [0.55, 0.4, 0.24], hole: true },
  plaster: { stop: 0.13, ref: 0.1, spark: 0, tint: [0.78, 0.76, 0.7], hole: true },
  glass: { stop: 0.04, ref: 0.01, spark: 0, tint: [0.8, 0.9, 0.95], hole: false },
  sheet: { stop: 0.25, ref: 0.002, spark: 4, tint: [0.62, 0.6, 0.55], hole: true },
  car: { stop: 0.42, ref: 0.4, spark: 4, tint: [0.5, 0.48, 0.45], hole: true },
  steel: { stop: 1.4, ref: 0.02, spark: 6, tint: [0.7, 0.68, 0.62], hole: true },
};

/** What a box of the world is made of, from what kind of box it is and how thick. A box thinner than 3 cm is a sheet. */
export function surfaceOfBox(kind: string, thickness: number, mat?: Surface): Surface {
  if (mat) return mat;
  switch (kind) {
    case 'car':
      return 'car';
    case 'crate':
    case 'furniture':
    case 'dock':
      return 'wood';
    case 'partition':
      return 'wood';
    case 'barricade':
      return thickness < 0.5 ? 'wood' : 'steel';
    case 'wall':
      return 'concrete';
    case 'building':
    case 'pillar':
    case 'tower':
      return 'concrete';
    case 'rock':
      return 'stone';
    case 'floor':
    case 'stair':
      return 'concrete';
    default:
      return 'concrete';
  }
}

/**
 * Whether a round gets through a slab, and how fast it leaves the far side (0 if it stops). Its energy decides: a round
 * that arrives slow has less bite than one fresh from the muzzle.
 */
export function throughSlab(spec: AmmoSpec, speed: number, surface: Surface, thickness: number): number {
  const s = SURFACES[surface];
  const cap = spec.pen * (speed / spec.speed) ** 2;
  const need = s.stop * clamp(thickness / s.ref, 0.6, 2);
  if (cap <= need) return 0;
  return speed * Math.sqrt(1 - need / cap);
}

/** What a body costs a round that goes through it. Only the heavy rounds come out the other side. */
export const FLESH_STOP = 0.45;
export function throughFlesh(spec: AmmoSpec, speed: number): number {
  const cap = spec.pen * (speed / spec.speed) ** 2;
  if (cap <= FLESH_STOP) return 0;
  return speed * Math.sqrt(1 - FLESH_STOP / cap);
}

// ------------------------------------------------------------------ what it does to a body

/** Momentum to speed: how many m/s a victim loses to one round, per kg of round times m/s. Tuned so a blast of pellets or one rifle round throws a walker back about a metre. */
export const KNOCK = 90;

/** Metres per second a body is shoved back by one round. */
export function staggerSpeed(spec: AmmoSpec, speed: number, victimMass: number): number {
  return (spec.mass * speed * KNOCK) / Math.max(20, victimMass);
}

/** A zombie's mass in kg, from its size. */
export const massOf = (scale: number) => 70 * scale * scale * scale;

export type Zone = 'head' | 'torso' | 'armL' | 'armR' | 'legL' | 'legR';

/** Order of the dismemberment accumulators. */
export const ZONES: Zone[] = ['head', 'torso', 'armL', 'armR', 'legL', 'legR'];

/**
 * Which part of a standing body a point is in. `relY` is the height as a share of the body (0 feet, 1 crown), `lateral` the
 * sideways offset in metres (positive toward the body's left, +x in the model), `scale` the body's size.
 */
export function zoneOf(relY: number, lateral: number, scale: number): Zone {
  if (relY > 0.82) return 'head';
  const side = lateral >= 0 ? 'L' : 'R';
  if (relY < 0.5) return side === 'L' ? 'legL' : 'legR';
  if (Math.abs(lateral) / scale > 0.17 && relY < 0.8) return side === 'L' ? 'armL' : 'armR';
  return 'torso';
}

/** Hit points a limb has before it comes off, as a share of the body's. */
export const LIMB_HP = 0.3;
/** The head comes off in one blow that carries this share of the body's hit points. */
export const HEAD_HP = 0.55;
/** A blow this many times the body's hit points tears more than the part it hit. */
export const OVERKILL = 1.5;

/** Bits of the hidden-part mask, by the id of each part in the zombie mesh (0 body, 1/2 thighs, 3/4 shins, 5/6 arms, 7/8 forearms, 9 head). */
export const PART_BIT = (id: number) => 1 << id;
export const LIMB_PARTS: Record<Exclude<Zone, 'torso'>, number[]> = {
  head: [9],
  armL: [5, 7],
  armR: [6, 8],
  legL: [1, 3],
  legR: [2, 4],
};

export function maskOf(zone: Exclude<Zone, 'torso'>): number {
  let m = 0;
  for (const id of LIMB_PARTS[zone]) m |= PART_BIT(id);
  return m;
}

/** Wounds a body carries: what has come off, and how much damage each limb has taken since. */
export interface Wounds {
  mask: number;
  acc: [number, number, number, number, number, number];
}

export const newWounds = (): Wounds => ({ mask: 0, acc: [0, 0, 0, 0, 0, 0] });

export interface SeverResult {
  /** Zones that came off in this blow. */
  off: Exclude<Zone, 'torso'>[];
}

/**
 * Take a blow to a zone. `dealt` is the damage that landed, `gore` the round's limb-taking, `hp` the body's full hit points.
 * `pick` chooses among the arms when a blow is large enough to tear one off a hit to the body.
 */
export function wound(w: Wounds, zone: Zone, dealt: number, gore: number, hp: number, killed: boolean, pick: number): SeverResult {
  const off: Exclude<Zone, 'torso'>[] = [];
  const power = dealt * gore;
  if (power <= 0) return { off };
  const take = (z: Exclude<Zone, 'torso'>) => {
    const m = maskOf(z);
    if ((w.mask & m) === m) return;
    w.mask |= m;
    off.push(z);
  };
  const i = ZONES.indexOf(zone);
  w.acc[i] += power;
  if (zone === 'head') {
    if (w.acc[i] >= hp * HEAD_HP || (killed && power >= hp * 0.4)) take('head');
  } else if (zone === 'torso') {
    // A big enough blow to the body takes an arm with it.
    if (power >= hp * OVERKILL) take(pick < 0.5 ? 'armL' : 'armR');
  } else if (w.acc[i] >= hp * LIMB_HP) take(zone);
  // A blow far beyond what it takes to kill also costs the matching limb on the other side.
  if (power >= hp * OVERKILL * 3 && zone !== 'head') take(zone === 'legL' ? 'legR' : zone === 'legR' ? 'legL' : zone === 'armL' ? 'armR' : zone === 'armR' ? 'armL' : pick < 0.5 ? 'legL' : 'legR');
  return { off };
}

/** How many legs and arms are gone. */
export function limbsGone(mask: number): { legs: number; arms: number; head: boolean } {
  const has = (z: Exclude<Zone, 'torso'>) => (mask & maskOf(z)) === maskOf(z);
  return { legs: (has('legL') ? 1 : 0) + (has('legR') ? 1 : 0), arms: (has('armL') ? 1 : 0) + (has('armR') ? 1 : 0), head: has('head') };
}

/** Speed of a body with legs gone: one leg is a limp, none is a crawl. */
export function legSpeedMult(legsGone: number): number {
  return legsGone >= 2 ? 0.2 : legsGone === 1 ? 0.55 : 1;
}

/** Reach-and-bite damage of a body with arms gone. */
export function armDamageMult(armsGone: number): number {
  return armsGone >= 2 ? 0.45 : armsGone === 1 ? 0.75 : 1;
}
