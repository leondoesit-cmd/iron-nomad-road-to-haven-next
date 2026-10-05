import { clamp, clamp01, damp } from '../core/math';

/**
 * How a person on foot moves and carries a weapon, as pure rules: the weight and inertia of the walk, the bob of the view
 * in time with the steps, the dip of a landing, how long each weapon takes to draw, how a sprint lowers the gun and a wall
 * in front of the muzzle pushes it up. No engine imports, so every number is testable and tuned in one place.
 */

// ------------------------------------------------------------------ inertia

/** Acceleration and braking on the ground, m/s². A walk is up to speed in a fifth of a second, a sprint takes most of a second. */
export const ACCEL = { walk: 16, crouch: 14, sprint: 8, brake: 24 };

/**
 * Move a velocity toward a target by at most what the legs can do in a tick: speeding up is slower than braking, and a
 * turn or a reversal has to pass through the slow part, so a body has weight instead of snapping to the stick.
 */
export function approachVelocity(vx: number, vz: number, tx: number, tz: number, dt: number, accel: number, brake: number, out: [number, number] = [0, 0]): [number, number] {
  const dx = tx - vx;
  const dz = tz - vz;
  const dl = Math.hypot(dx, dz);
  const a = (Math.hypot(tx, tz) >= Math.hypot(vx, vz) ? accel : brake) * dt;
  if (dl <= a || dl < 1e-6) {
    out[0] = tx;
    out[1] = tz;
  } else {
    out[0] = vx + (dx / dl) * a;
    out[1] = vz + (dz / dl) * a;
  }
  return out;
}

// ------------------------------------------------------------------ what is in the hands

/** Walking speed with a weapon in hand, as a share: a rifle or an axe is heavy to carry about, a knife is not. */
export const CARRY: Record<string, number> = {
  none: 1,
  pistol: 1,
  revolver: 0.99,
  smg: 0.97,
  sawn: 0.96,
  pump: 0.93,
  rifle: 0.91,
  knife: 1.02,
  bat: 0.98,
  machete: 1,
  axe: 0.94,
  wrench: 1,
  crowbar: 0.99,
  jerrycan: 1,
  flare: 1,
};
export const carryOf = (held: string) => CARRY[held] ?? 1;

/** Seconds to bring a weapon up from the belt: a pistol is out in a third of a second, a rifle takes most of a second. */
export const DRAW: Record<string, number> = {
  none: 0.25,
  pistol: 0.32,
  revolver: 0.4,
  smg: 0.45,
  sawn: 0.5,
  pump: 0.6,
  rifle: 0.72,
  knife: 0.2,
  bat: 0.35,
  machete: 0.3,
  axe: 0.45,
  wrench: 0.3,
  crowbar: 0.3,
  jerrycan: 0.4,
  flare: 0.25,
};
export const drawOf = (held: string) => DRAW[held] ?? 0.3;

/** How far a weapon reaches in front of the eye, metres: the longer it is, the sooner a wall in front of it pushes it up. */
export const REACH: Record<string, number> = { pistol: 0.7, revolver: 0.75, smg: 0.85, sawn: 0.75, pump: 1.05, rifle: 1.15 };

// ------------------------------------------------------------------ lowered and raised

/** The gun is not ready to fire while it is lowered by more than this (a sprint, a draw, a wall in the way). */
export const READY = 0.4;
/** How fast the gun drops into a sprint carry and comes back, per second. */
export const SPRINT_IN = 7;
export const SPRINT_OUT = 6;

/** Ease a blend toward a target at the rate for going up or for coming down. */
export function stepBlend(v: number, target: number, up: number, down: number, dt: number): number {
  const rate = target > v ? up : down;
  return damp(v, target, rate, dt);
}

/** How much a wall in front pushes the weapon up and in: 0 clear, 1 with the muzzle against it. `dist` is eye to wall. */
export function wallBlend(dist: number, reach: number): number {
  return clamp01((reach + 0.45 - dist) / 0.6);
}
/** With this much of the weapon up against a wall it cannot be fired: the muzzle is in the wall. */
export const WALL_BLOCK = 0.85;

/** How lowered the weapon is: the worst of the sprint carry and a draw in progress. A wall is a separate, raised pose. */
export function lowered(sprint: number, draw: number): number {
  return Math.max(sprint, draw);
}

/** Draw progress to a lowered amount: the gun starts down and comes up quickly, then settles. */
export function drawLow(t: number, dur: number): number {
  if (dur <= 0 || t <= 0) return 0;
  const k = clamp01(t / dur);
  return k * k;
}

// ------------------------------------------------------------------ the view in time with the feet

export interface Gait {
  /** Step phase: a full cycle is two steps. */
  phase: number;
  /** How much of a full bob the view has right now, eased. */
  amp: number;
  /** Landing dip: displacement of the eye (m, negative is down) and its velocity. */
  dip: number;
  dipV: number;
}

export const newGait = (): Gait => ({ phase: 0, amp: 0, dip: 0, dipV: 0 });

export interface GaitOut {
  /** Eye offset: sideways (positive to the right of where the view faces) and up, metres. */
  x: number;
  y: number;
  /** View roll, radians. */
  roll: number;
  /** Weapon bob, radians: the arms rocking up and down and side to side with the steps. */
  armY: number;
  armX: number;
}

export const newGaitOut = (): GaitOut => ({ x: 0, y: 0, roll: 0, armY: 0, armX: 0 });

/** Steps a second at a walking pace. */
export function stepRate(speed: number): number {
  return 1.5 + speed * 0.45;
}

/** How much of a full bob each state gives: braced behind the sights it almost stops, crouched it is small, a sprint is wide. */
export function bobScale(sprinting: boolean, crouch: boolean, ads: number): number {
  return (sprinting ? 1.5 : 1) * (crouch ? 0.6 : 1) * (1 - 0.75 * clamp01(ads));
}

/**
 * Step the gait. `speed` is how fast the feet are really going (m/s), `grounded` whether they are on the floor: in the air
 * there is no step. Returns the view's offsets for this moment, into `out`.
 */
export function stepGait(g: Gait, dt: number, speed: number, sprinting: boolean, crouch: boolean, ads: number, grounded: boolean, out: GaitOut = newGaitOut()): GaitOut {
  const moving = grounded && speed > 0.2;
  const want = moving ? clamp(speed / 3.4, 0, 1.8) * bobScale(sprinting, crouch, ads) : 0;
  g.amp = damp(g.amp, want, moving ? 8 : 12, dt);
  if (moving) g.phase += dt * stepRate(speed) * Math.PI;
  // The eye drops as each foot lands and rises between; it sways across and rolls over a pair of steps.
  const a = g.amp;
  out.y = Math.cos(g.phase * 2) * 0.016 * a - 0.008 * a;
  out.x = Math.sin(g.phase) * 0.014 * a;
  out.roll = Math.sin(g.phase) * 0.0075 * a;
  out.armY = Math.cos(g.phase * 2) * 0.012 * a;
  out.armX = Math.sin(g.phase) * 0.014 * a;
  // The landing dip is a damped spring: it goes down at once and comes back up with a little overshoot.
  g.dipV += (-180 * g.dip - 16 * g.dipV) * dt;
  g.dip += g.dipV * dt;
  out.y += g.dip;
  return out;
}

/** A landing: the eye goes down, further the harder it came down. `fallSpeed` is the downward speed (m/s, positive). */
export function landGait(g: Gait, fallSpeed: number): void {
  if (fallSpeed < 3) return;
  g.dipV -= clamp((fallSpeed - 3) / 14, 0, 1) * 2.4 + 0.3;
}

// ------------------------------------------------------------------ the body leans with the moves

/** The body's lean, as the view's roll (radians, positive to the left) and how fast it is changing. */
export interface Lean {
  roll: number;
  v: number;
}

export const newLean = (): Lean => ({ roll: 0, v: 0 });

/** The most the body leans, radians: a hard sidestep in a sprint while whipping the view round. */
export const LEAN_MAX = 0.08;

/**
 * How far the body wants to lean: into a sidestep (`strafe`, m/s to the right), into a turn of the view (`turn`, rad/s,
 * positive to the left), more for a turn on the move, like running a curve, and in a sprint; braced behind the sights
 * hardly at all. Positive is a lean to the left.
 */
export function leanTarget(strafe: number, turn: number, speed: number, sprinting: boolean, ads: number): number {
  const moving = clamp(speed / 3.4, 0, 1.5);
  const side = clamp(-strafe * 0.012, -0.05, 0.05);
  const curve = clamp(turn * (0.004 + 0.009 * moving), -0.045, 0.045);
  return clamp((side + curve) * (sprinting ? 1.25 : 1) * (1 - 0.65 * clamp01(ads)), -LEAN_MAX, LEAN_MAX);
}

/** Step the lean toward its target: a spring a little under critical, so it swings into a move and settles with a hair of overshoot. */
export function stepLean(l: Lean, target: number, dt: number): void {
  const w = 9;
  l.v += (w * w * (target - l.roll) - 2 * 0.72 * w * l.v) * dt;
  l.roll += l.v * dt;
}
