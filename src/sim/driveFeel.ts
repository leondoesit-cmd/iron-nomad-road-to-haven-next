import { wheelLayout, type VehicleDef } from '../data';
import { clamp } from '../core/math';
import { brakeSpec } from './drivetrain';
import { springRate } from './massModel';
import { tyreKindOf, type TyreKind } from './tyreModel';
import type { Fit, Tyres } from './parts';

/**
 * How a vehicle drives, beyond its engine: which wheels the drive goes to and how the differentials share it, where its
 * weight sits, how its tyres grip, how much its body rolls, how quick its steering is, how its brakes are balanced, and
 * which driving aids its electronics give it. Every chassis has its own (`CHASSIS_FEEL`), and the parts bolted to it
 * change it: a transfer case makes anything four-wheel drive with locked diffs, a race gearbox brings a limited-slip
 * diff, a car with its dashboard ripped out loses its ABS and traction control, a quick steering wheel sharpens it, a
 * wing pins the tail down at speed, and every tyre is its own kind on its own corner. Pure, and cached per build.
 */

export type DriveLayout = 'fwd' | 'rwd' | 'awd';
/** How an axle's differential shares the drive between its two wheels. */
export type DiffKind = 'open' | 'lsd' | 'locked';

export interface ChassisFeel {
  layout: DriveLayout;
  /** Four-wheel drive: the share of the drive sent to the steered axle(s). */
  split: number;
  diff: DiffKind;
  /** Share of the weight on the front axle, stock with a driver (engine at the front, at the back, a bed over the axle). */
  front: number;
  /** Sideways grip of its factory tyres on firm dirt: the peak friction coefficient. */
  grip: number;
  /**
   * How much a cornering force leans on the body: 1 is all of it at the contact patch (a real car's roll), 0 none of it
   * (through the centre of mass). Arcade cars sit well under 1, so a tall van corners hard without tipping on the flat.
   */
  roll: number;
  /** The same for braking and pulling (anti-dive and anti-squat): how far the nose dips and the tail squats. */
  pitch: number;
  /** How fast the front wheels follow the stick, 1/s. */
  steerRate: number;
  /** Share of the braking at the front axle. */
  bias: number;
  abs: boolean;
  tcs: boolean;
  esc: boolean;
}

/**
 * The factory feel of each chassis. A hatch is front-drive and nose-heavy (it understeers and pulls its own front wheels
 * along), a sedan and a van are rear-drive (the tail comes round under power; the sedan, the newest car about, has every
 * driving aid until its dashboard comes out), the pickup is a part-time four-by-four
 * with a light, empty bed, the buggy has its engine behind the driver and a limited-slip diff, the quad and the rickshaw
 * trike a solid rear axle.
 */
export const CHASSIS_FEEL: Record<string, ChassisFeel> = {
  moped: { layout: 'rwd', split: 0, diff: 'open', front: 0.45, grip: 1.35, roll: 0, pitch: 0.5, steerRate: 12, bias: 0.6, abs: false, tcs: false, esc: false },
  trike: { layout: 'rwd', split: 0, diff: 'locked', front: 0.42, grip: 1.25, roll: 0.32, pitch: 0.5, steerRate: 10, bias: 0.55, abs: false, tcs: false, esc: false },
  quad: { layout: 'rwd', split: 0, diff: 'locked', front: 0.45, grip: 1.35, roll: 0.42, pitch: 0.5, steerRate: 11, bias: 0.6, abs: false, tcs: false, esc: false },
  buggy: { layout: 'rwd', split: 0, diff: 'lsd', front: 0.4, grip: 1.45, roll: 0.5, pitch: 0.55, steerRate: 11, bias: 0.58, abs: false, tcs: false, esc: false },
  hatch: { layout: 'fwd', split: 1, diff: 'open', front: 0.6, grip: 1.45, roll: 0.45, pitch: 0.55, steerRate: 10, bias: 0.68, abs: true, tcs: false, esc: false },
  sedan: { layout: 'rwd', split: 0, diff: 'open', front: 0.53, grip: 1.42, roll: 0.42, pitch: 0.55, steerRate: 9.5, bias: 0.65, abs: true, tcs: true, esc: true },
  pickup: { layout: 'awd', split: 0.4, diff: 'open', front: 0.56, grip: 1.28, roll: 0.4, pitch: 0.6, steerRate: 8.5, bias: 0.66, abs: true, tcs: false, esc: false },
  van: { layout: 'rwd', split: 0, diff: 'open', front: 0.55, grip: 1.18, roll: 0.36, pitch: 0.6, steerRate: 8, bias: 0.66, abs: true, tcs: false, esc: false },
  truck: { layout: 'awd', split: 0.33, diff: 'locked', front: 0.5, grip: 1.05, roll: 0.32, pitch: 0.6, steerRate: 6, bias: 0.55, abs: false, tcs: false, esc: false },
  rig: { layout: 'awd', split: 0.34, diff: 'locked', front: 0.5, grip: 0.95, roll: 0.28, pitch: 0.65, steerRate: 5, bias: 0.5, abs: true, tcs: false, esc: false },
  raider_buggy: { layout: 'rwd', split: 0, diff: 'lsd', front: 0.42, grip: 1.4, roll: 0.5, pitch: 0.55, steerRate: 11, bias: 0.58, abs: false, tcs: false, esc: false },
  battle_wagon: { layout: 'awd', split: 0.4, diff: 'locked', front: 0.52, grip: 1.12, roll: 0.34, pitch: 0.6, steerRate: 7, bias: 0.6, abs: false, tcs: false, esc: false },
};

const FALLBACK: ChassisFeel = { layout: 'awd', split: 0.5, diff: 'open', front: 0.5, grip: 1.3, roll: 0.45, pitch: 0.55, steerRate: 9, bias: 0.62, abs: false, tcs: false, esc: false };

export function chassisFeel(def: VehicleDef): ChassisFeel {
  return CHASSIS_FEEL[def.id] ?? FALLBACK;
}

/** Everything the physics needs to drive one build. */
export interface DriveFeel extends ChassisFeel {
  /** Share of the drive each wheel's axle sends it (wheel order), summing to 1 over the driven wheels. */
  torque: number[];
  /** The centre diff of a four-wheel drive passes this share of what one axle cannot use to the other (1 locked). */
  centre: number;
  /** Each wheel's tyre. */
  tyres: TyreKind[];
  /** Downforce at the rear axle, N per (m/s)^2, at the physics' reference scale. */
  downforce: number;
  /** What the brakes can soak up before they fade, kJ (the brake part's rating). */
  brakeKj: number;
}

/** Wheels on the steered axle(s) count as the front for the drive split; on a two-wheeler the front is the one that steers. */
function torqueShares(def: VehicleDef, layout: DriveLayout, split: number): number[] {
  const w = wheelLayout(def.physics);
  // A layout of wheels that says which are driven (the trike's axles) wins over the chassis feel.
  const explicit = !!def.physics.axles?.some((a) => a.drive !== undefined);
  const want = w.map((x): number => {
    if (explicit || w.length === 2) return x.drive ? 1 : 0;
    if (layout === 'fwd') return x.steer ? 1 : 0;
    if (layout === 'rwd') return x.steer ? 0 : 1;
    return 1;
  });
  const front = w.map((x, i) => (x.steer ? want[i] : 0)).reduce((a, b) => a + b, 0);
  const back = w.map((x, i) => (x.steer ? 0 : want[i])).reduce((a, b) => a + b, 0);
  return w.map((x, i) => {
    if (!want[i]) return 0;
    if (explicit || w.length === 2 || layout !== 'awd') return 1 / (front + back);
    // Four-wheel drive: the split between the axles, shared evenly across each one's wheels.
    return x.steer ? (front ? split / front : 0) : back ? (1 - split) / back : 0;
  });
}

const cache = new Map<string, DriveFeel>();

/** The feel of a build: its chassis, then the parts. Tyres are per wheel, in wheel order; missing ones are the factory's. */
export function driveFeel(def: VehicleDef, fit: Fit = {}, tyres?: Tyres): DriveFeel {
  const ids = ['gearbox', 'dash', 'steer', 'seatD', 'suspension', 'brakes', 'rear'].map((s) => fit[s as keyof Fit]?.id ?? '').join(',');
  const n = def.physics.wheelCount;
  const tyreIds: string[] = [];
  for (let i = 0; i < n; i++) tyreIds.push(tyres?.[i]?.id ?? def.tyres?.[i] ?? `tyre_${def.id}`);
  const key = `${def.id}|${ids}|${tyreIds.join(',')}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (cache.size > 300) cache.clear();
  const c = chassisFeel(def);
  const f: DriveFeel = { ...c, torque: [], centre: 0.6, tyres: tyreIds.map(tyreKindOf), downforce: 0, brakeKj: 1e9 };
  const has = (slot: keyof Fit, id: string) => fit[slot]?.id === id;
  // The drivetrain.
  if (has('gearbox', 'gbx_transfer')) {
    f.layout = 'awd';
    f.split = 0.45;
    f.diff = 'locked';
    f.centre = 1;
  } else if (has('gearbox', 'gbx_race') && f.diff === 'open') f.diff = 'lsd';
  // The electronics live in the dashboard: rip it out and the ABS and traction control go with it.
  if (has('dash', 'dash_none')) f.abs = f.tcs = f.esc = false;
  else if (has('dash', 'dash_cracked')) f.tcs = f.esc = false;
  // The wheel and the seat: a small quick wheel, a chain wrapped round one, none at all; sitting on the floor.
  if (has('steer', 'steer_sport')) f.steerRate *= 1.25;
  else if (has('steer', 'steer_chain')) f.steerRate *= 0.92;
  else if (has('steer', 'steer_none')) f.steerRate *= 0.45;
  if (has('seatD', 'seat_none')) f.steerRate *= 0.78;
  else if (has('seatD', 'seat_bucket')) f.steerRate *= 1.06;
  // Springs: stiffer ones hold the body flatter; long travel and a lift kit let it lean and wallow.
  const k = springRate(def, fit);
  f.roll = clamp(c.roll * Math.pow(k, -0.4), 0, 1);
  f.pitch = clamp(c.pitch * Math.pow(k, -0.3), 0.2, 1);
  if (has('suspension', 'sus_sport')) f.roll *= 0.82;
  else if (has('suspension', 'sus_long') || has('suspension', 'sus_lift')) {
    f.roll = clamp(f.roll * 1.15, 0, 1);
    f.steerRate *= 0.95;
  } else if (has('suspension', 'sus_none')) f.roll = clamp(f.roll * 1.25, 0, 1);
  // A wing pins the tail down as the speed rises: about an eighth more on the rear tyres at 110 km/h.
  if (has('rear', 'rr_wing')) f.downforce = (0.12 * def.physics.mass * 9.81 * (1 - f.front)) / (30 * 30);
  const brk = brakeSpec(def, fit);
  f.brakeKj = brk.energy >= 1e8 ? 1e9 : Math.max(20, brk.energy);
  f.torque = torqueShares(def, f.layout, f.split);
  cache.set(key, f);
  return f;
}

/** Weight share on the driven wheels and how a pull moves weight onto them (+) or off them (-), for the garage's straight line. */
export function tractionShare(def: VehicleDef, f: DriveFeel, comHeight: number, wheelbase: number): { driven: number; transfer: number } {
  const w = wheelLayout(def.physics);
  const frontDriven = w.some((x, i) => x.steer && f.torque[i] > 0);
  const backDriven = w.some((x, i) => !x.steer && f.torque[i] > 0);
  if (frontDriven && backDriven) return { driven: 1, transfer: 0 };
  const h = (comHeight / wheelbase) * f.pitch;
  // A two-wheeler's weight is on the line between its wheels: the back carries what the front does not.
  return frontDriven ? { driven: f.front, transfer: -h } : { driven: 1 - f.front, transfer: h };
}

const LAYOUT_TEXT: Record<DriveLayout, string> = { fwd: 'front-wheel drive', rwd: 'rear-wheel drive', awd: 'four-wheel drive' };
const DIFF_TEXT: Record<DiffKind, string> = { open: 'open diff', lsd: 'limited-slip diff', locked: 'locked diffs' };

/** How it drives, in plain words: "rear-wheel drive · limited-slip diff · 40/60 · ABS". */
export function describeFeel(def: VehicleDef, f: DriveFeel): string {
  const parts: string[] = [];
  if (def.physics.wheelCount === 2) parts.push('rear-wheel drive');
  else {
    parts.push(LAYOUT_TEXT[f.layout]);
    parts.push(DIFF_TEXT[f.diff]);
  }
  parts.push(`${Math.round(f.front * 100)}/${Math.round((1 - f.front) * 100)}`);
  const aids = [f.abs && 'ABS', f.tcs && 'traction control', f.esc && 'stability control'].filter(Boolean) as string[];
  parts.push(aids.length ? aids.join(', ') : 'no driving aids');
  return parts.join(' · ');
}

const NOTES: Record<string, string> = {
  gbx_transfer: 'four-wheel drive, locked diffs: claws through mud and sand',
  gbx_race: 'limited-slip diff: puts the power down out of a bend',
  dash_none: 'no electronics: no ABS, traction or stability control',
  dash_cracked: 'flaky wiring: the ABS works, the traction control does not',
  steer_sport: 'quicker steering',
  seat_bucket: 'holds the driver: a sharper feel for the wheel',
  rr_wing: 'downforce: the tail sits down at speed',
  sus_sport: 'flatter in the bends',
  sus_long: 'leans and wallows more on tarmac',
  sus_lift: 'leans and wallows more on tarmac',
  whl_road: 'crisp on tarmac, lets go sooner',
  whl_mt: 'bites in mud, vaguer on tarmac',
  whl_bl: 'soft and forgiving: slides gently, rolls heavily on tarmac',
};

/** What a part does to the way a vehicle drives, in plain words, for its card. */
export function feelNotes(id: string): string[] {
  const n = NOTES[id];
  return n ? [n] : [];
}
