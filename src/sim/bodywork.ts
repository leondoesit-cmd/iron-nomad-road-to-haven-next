import { clamp } from '../core/math';
import type { Panel } from './access';

/**
 * The rules of bodywork: how deep a crash dents a car, how much of a knock a bolted-on part takes before its joint lets
 * go, how mud, dust and blood build up on the paint, and when a tyre leaves a mark. Pure numbers, no rendering, so it
 * can be tested and tuned on its own. What the player sees (the lattice, the debris, the decals) is built on top.
 */

export type V3 = [number, number, number];
export type Surf = 'asphalt' | 'hardpan' | 'sand' | 'mud';

// ---------------------------------------------------------------- what is kept

/** One dent, as [x, y, z, pushX, pushY, pushZ, depth, radius] in the model's frame. */
export type DentSave = number[];

/** Everything about a vehicle's body that has to survive the night, the garage and the save file. */
export interface BodySave {
  dents: DentSave[];
  /** Mud, dust and blood on the paint, 0..1 each. */
  dirt: V3;
  /** Strain in each part's joint, 0..1 (1 is gone), by part tag. A part that has been knocked stays weak. */
  stress: Record<string, number>;
  /** Body parts that have come off (doors, mirrors, bumpers). Modules leave the build's `fit` instead. */
  gone: string[];
  /** Windows that are cracked (1), crazed (2) or gone (3), by pane key. */
  glass?: Record<string, number>;
  /** Panels the player has left open (bonnet, doors, boot lid). Absent when everything is shut. */
  open?: Panel[];
}

export const emptyBody = (): BodySave => ({ dents: [], dirt: [0, 0, 0], stress: {}, gone: [] });

export function packDent(e: { at: V3; push: V3; depth: number; radius: number }): DentSave {
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return [r(e.at[0]), r(e.at[1]), r(e.at[2]), r(e.push[0]), r(e.push[1]), r(e.push[2]), r(e.depth), r(e.radius)];
}

export function unpackDent(d: DentSave): { at: V3; push: V3; depth: number; radius: number } {
  return { at: [d[0], d[1], d[2]], push: [d[3], d[4], d[5]], depth: d[6], radius: d[7] };
}

// ---------------------------------------------------------------- denting

/** How far a crash drives the metal in, metres: a shunt at 4 m/s barely marks it, a wall at 20 m/s folds the nose. */
export function dentDepth(speed: number, massRatio = 0.5): number {
  if (speed < 3.4) return 0;
  const k = 0.7 + 0.6 * clamp(massRatio, 0, 1);
  return Math.min(0.8, 0.0085 * Math.pow(speed - 3, 1.45) * k);
}

/** The width of the dent: harder crashes spread wider. */
export function dentRadius(speed: number): number {
  return clamp(0.34 + 0.034 * speed, 0.3, 1.15);
}

/** A small dent from a bullet or a thrown blow. */
export function strikeDent(dmg: number): { depth: number; radius: number } {
  return { depth: clamp(0.004 + dmg * 0.0004, 0.004, 0.03), radius: 0.16 + clamp(dmg, 0, 60) * 0.002 };
}

/** The dent from an explosion `f` (0..1) of the way from its edge to its centre. */
export function blastDent(dmg: number, f: number): { depth: number; radius: number } {
  return { depth: clamp(dmg * f * 0.0045, 0.02, 0.5), radius: 0.7 + f * 0.5 };
}

/**
 * Where a crash lands on the body when the physics gave no contact point: the box surface in the direction of the
 * obstacle, at about bumper height. `toward` is the unit direction to what was hit, in the vehicle's frame.
 */
export function surfaceToward(toward: V3, half: V3, midY: number): V3 {
  const ax = Math.abs(toward[0]) / Math.max(0.001, half[0]);
  const az = Math.abs(toward[2]) / Math.max(0.001, half[2]);
  const t = 1 / Math.max(0.001, Math.max(ax, az));
  return [toward[0] * t, midY, toward[2] * t];
}

// ---------------------------------------------------------------- joints

/** Strain at which a part starts to rattle and hang, and at which it lets go. */
export const LOOSE_AT = 0.55;
export const SNAP_AT = 1;
/** A sudden speed change under this (m/s) is ordinary rough driving: no joint feels it. */
export const FREE_SPEED = 2.2;

/** A joint's own strength: the part's rating, spread a little so no two cars fail the same way. */
export function jointTol(base: number, seed: number, tag: string): number {
  let h = (seed | 0) ^ 0x9e3779b9;
  for (let i = 0; i < tag.length; i++) h = Math.imul(h ^ tag.charCodeAt(i), 0x01000193);
  h ^= h >>> 15;
  return base * (0.86 + 0.28 * ((h >>> 0) / 4294967296));
}

/** The sudden speed change at a point of a rigid body: the body's own plus what its spin adds out at the end of the arm. */
export function shockLoad(dv: V3, dw: V3, at: V3): number {
  const x = dv[0] + dw[1] * at[2] - dw[2] * at[1];
  const y = dv[1] + dw[2] * at[0] - dw[0] * at[2];
  const z = dv[2] + dw[0] * at[1] - dw[1] * at[0];
  return Math.hypot(x, y, z);
}

/**
 * Strain added by one sudden knock. A part that took the hit itself takes a good deal more of it; a part on the far side
 * of the car is carried along by the body and only feels what the body passes on.
 */
export function stressFromShock(load: number, tol: number, direct: boolean): number {
  if (load < FREE_SPEED) return 0;
  const l = load * (direct ? 1.35 : 0.35);
  return Math.max(0, l - FREE_SPEED) / tol;
}

/**
 * Strain added over `dt` seconds by being whirled: a roll, a spin-out or a tumble pulls a roof rack outward with
 * the centripetal acceleration, which a joint holds for a while and then does not.
 */
export function stressFromSpin(w: V3, at: V3, tol: number, dt: number): number {
  const wr = [w[1] * at[2] - w[2] * at[1], w[2] * at[0] - w[0] * at[2], w[0] * at[1] - w[1] * at[0]];
  const ax = w[1] * wr[2] - w[2] * wr[1];
  const ay = w[2] * wr[0] - w[0] * wr[2];
  const az = w[0] * wr[1] - w[1] * wr[0];
  const a = Math.hypot(ax, ay, az);
  const limit = tol * 4;
  return a > limit ? (0.35 * (a - limit) * dt) / limit : 0;
}

export type JointState = 'fixed' | 'loose' | 'gone';
export const stateOf = (stress: number): JointState => (stress >= SNAP_AT ? 'gone' : stress >= LOOSE_AT ? 'loose' : 'fixed');

/** What is left of a part's condition when it tears off. */
export function condAfterBreak(cond: number, stress: number): number {
  return clamp(cond * (0.7 - 0.2 * clamp(stress - 1, 0, 1)), 0.12, 1);
}

// ---------------------------------------------------------------- dirt

export interface Dirt {
  mud: number;
  dust: number;
  blood: number;
}

export interface DirtIn {
  dt: number;
  speed: number;
  surface: Surf;
  /** How wet the ground is, 0..1. */
  wet: number;
  /** 0..1: how much of the wheels is under water. */
  wading: number;
  /** Dust storm strength. */
  storm: number;
  grounded: boolean;
}

/** Mud, dust and blood build up with the miles and wash off in water. */
export function dirtStep(d: Dirt, o: DirtIn) {
  const run = clamp(Math.abs(o.speed) / 14, 0, 1.6);
  if (o.grounded) {
    const dust = o.surface === 'sand' ? 0.011 : o.surface === 'hardpan' ? 0.006 : 0.0008;
    d.dust += dust * run * o.dt;
    // Wet ground turns the dirt road to mud under the tyres.
    const mud = o.surface === 'mud' ? 0.036 : o.surface === 'hardpan' ? 0.012 * o.wet : o.surface === 'asphalt' ? 0.0025 * o.wet : o.surface === 'sand' ? 0.006 * o.wet : 0;
    d.mud += mud * Math.max(0.15, run) * o.dt;
    // A fresh coat of mud hides the dust beneath it.
    d.dust -= d.dust * mud * 0.8 * o.dt;
  }
  d.dust += 0.016 * o.storm * o.dt;
  // Rain rinses dust and a little blood; water washes the lot.
  d.dust -= 0.004 * o.wet * o.dt;
  d.blood -= 0.0012 * o.wet * o.dt;
  // Mud dries and crumbles to dust over a long time.
  const dry = 0.0012 * (1 - o.wet) * o.dt;
  d.mud -= dry;
  d.dust += dry * 0.4;
  if (o.wading > 0) {
    d.mud -= 0.3 * o.wading * o.dt;
    d.dust -= 0.5 * o.wading * o.dt;
    d.blood -= 0.22 * o.wading * o.dt;
  }
  d.mud = clamp(d.mud, 0, 1);
  d.dust = clamp(d.dust, 0, 1);
  d.blood = clamp(d.blood, 0, 1);
}

/** Whatever the front end hit. */
export function bloodSplat(d: Dirt, amount: number) {
  d.blood = clamp(d.blood + amount, 0, 1);
}

// ---------------------------------------------------------------- marks

export interface SkidIn {
  /** Sideways speed, m/s. */
  lateral: number;
  speed: number;
  throttle: number;
  brake: number;
  handbrake: boolean;
  /** Is this a rear wheel? */
  rear: boolean;
}

/** How hard a tyre is being scrubbed across the ground, 0 (rolling) to 1 (locked or sliding): what makes rubber marks. */
export function skidAmount(o: SkidIn): number {
  const sp = Math.abs(o.speed);
  let s = 0;
  if (o.brake > 0.85 && sp > 9) s = Math.max(s, 0.45 + (sp - 9) / 30);
  if (o.handbrake && o.rear && sp > 5) s = Math.max(s, 0.75);
  if (Math.abs(o.lateral) > 2.2) s = Math.max(s, (Math.abs(o.lateral) - 2.2) / 5);
  return clamp(s, 0, 1);
}

export interface MarkStyle {
  kind: 'groove' | 'skid';
  /** Peak opacity of the mark, 0..1. */
  alpha: number;
  /** Colour of the mark in linear-ish rgb: the floor of a groove, or the rubber. */
  tone: V3;
  /** The raised edges of a groove, a little lighter than the ground they were pushed up from. */
  berm: V3;
  /** How deep the groove is cut, metres. */
  depth: number;
}

/**
 * What a rolling or sliding tyre leaves on a surface, or null. Asphalt only takes rubber marks and only from a
 * scrubbing tyre; sand, hard earth and mud take a groove from any tyre that is rolling along.
 */
export function markStyle(surface: Surf, skid: number, speed: number, wet: number): MarkStyle | null {
  const sp = Math.abs(speed);
  if (surface === 'asphalt') {
    if (skid < 0.12) return null;
    return { kind: 'skid', alpha: clamp(0.25 + skid * 0.7, 0, 0.92) * (1 - wet * 0.35), tone: [0.035, 0.035, 0.038], berm: [0.035, 0.035, 0.038], depth: 0 };
  }
  if (sp < 0.6) return null;
  const scrub = 0.25 * skid;
  switch (surface) {
    case 'sand':
      return { kind: 'groove', alpha: clamp(0.55 + scrub + wet * 0.15, 0, 0.92), tone: [0.2, 0.14, 0.08], berm: [0.62, 0.5, 0.34], depth: 0.024 + 0.012 * skid };
    case 'mud':
      return { kind: 'groove', alpha: clamp(0.85 + scrub, 0, 0.97), tone: [0.04, 0.03, 0.02], berm: [0.34, 0.26, 0.18], depth: 0.032 + 0.012 * skid };
    default:
      return { kind: 'groove', alpha: clamp(0.5 + scrub + wet * 0.3, 0, 0.85), tone: [0.12, 0.085, 0.055], berm: [0.58, 0.46, 0.33], depth: 0.012 + 0.008 * skid };
  }
}

// ---------------------------------------------------------------- repair

/** Share of the dents a bodywork job hammers out. */
export const STRAIGHTEN = 0.5;
/** Below this overall bend the body counts as straight. */
export const STRAIGHT = 0.06;
