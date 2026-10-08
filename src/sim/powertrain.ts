import { FIT_SLOTS, partDef, wheelLayout, type EngineSpec, type VehicleDef } from '../data';
import { clamp } from '../core/math';
import { cylindersOf } from './engineSize';
import { bayEmpty, engineEffects, engineSpec } from './engines';
import { exhaustSpec, gearboxSpec, gearTop } from './drivetrain';
import { cabinStatCounts } from './cabin';
import type { Fit, Tyres } from './parts';

/**
 * The powertrain: an engine with a real torque curve, a gearbox with real ratios and an automatic that shifts it, a final
 * drive, and the tyres it all ends at. Drive force is torque(rpm) x gear x final x efficiency / wheel radius, the revs come
 * from the wheels (with the clutch or converter slipping at a launch), and top speed is where that force meets the air,
 * the rolling resistance and the rev limiter. Everything here is pure: the physics steps a `DriveUnit`, and the garage
 * runs the same unit on a straight line to forecast a build before a bolt is turned.
 *
 * The game drives faster than real life (a stock hatchback pulls like a hot hatch), so each chassis has an arcade GAIN:
 * the factor on every engine's torque that makes the stock one drive exactly as `vehicles.json` says (its launch to 60% of
 * top speed and its top speed match the old tuning). Anything bolted in differs from stock by the real ratios: a V8 pulls
 * by its torque, a heavy load pulls by its weight, a hill takes its share of gravity.
 */

const TAU = Math.PI * 2;
const G = 9.81;
/** The rev limiter in top gear sits this far above the top speed the chassis was tuned to. */
export const REV_MARGIN = 1.03;
/** What a reverse gear gets of the forward drive. */
const REVERSE_K = 0.6;
/** Rolling resistance of a tyre on a hard road. */
export const ROLL = 0.015;
/** Linear damping set on every vehicle body (see `physics/vehicle.ts`): part of what the engine pushes against. */
export const BODY_DAMPING = 0.04;

// ------------------------------------------------------------------------------------------------ the engine

export type CurveShape = 'petrol' | 'petrolBlown' | 'diesel' | 'dieselBlown' | 'twoStroke' | 'small';

export interface EngineCurve {
  shape: CurveShape;
  /** rpm: idle, peak torque, peak power, and the redline where the limiter cuts the fuel. */
  idle: number;
  peakTqRpm: number;
  peakPwRpm: number;
  redline: number;
  /** Peak torque, Nm, and the output it makes at its power peak, kW. */
  peakNm: number;
  kw: number;
  /** rpm a full-throttle launch holds against the slipping clutch or converter. */
  launch: number;
  /** Engine braking (pumping and friction), Nm at idle and at the redline. */
  dragLo: number;
  dragHi: number;
  /** Seconds the revs take to settle when nothing holds them (free-revving, a shift): bigger engines are slower. */
  lag: number;
  /** The curve as torque fractions at rpm knots, with monotone cubic slopes. */
  xs: number[];
  ys: number[];
  ms: number[];
}

/** What kind of curve an engine has: a diesel's flat shove, a petrol's climb to the top end, a blower's plateau, a scooter's narrow band. */
export function curveShape(spec: EngineSpec): CurveShape {
  if (spec.fuel === 'diesel') return spec.blown ? 'dieselBlown' : 'diesel';
  if (spec.litres <= 0.08) return 'twoStroke';
  if (spec.litres < 0.7) return 'small';
  return spec.blown ? 'petrolBlown' : 'petrol';
}

/** Fritsch-Carlson slopes for a monotone cubic through the knots: no overshoot, so a plateau stays flat. */
function pchipSlopes(xs: number[], ys: number[]): number[] {
  const n = xs.length;
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m = new Array<number>(n).fill(0);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * (xs[i + 1] - xs[i]) + (xs[i] - xs[i - 1]);
      const w2 = (xs[i + 1] - xs[i]) + 2 * (xs[i] - xs[i - 1]);
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return m;
}

function curveFrac(c: Pick<EngineCurve, 'xs' | 'ys' | 'ms'>, rpm: number): number {
  const { xs, ys, ms } = c;
  const n = xs.length;
  if (rpm <= xs[0]) return Math.max(0, ys[0] * (rpm / xs[0]));
  if (rpm >= xs[n - 1]) return 0;
  let i = 0;
  while (rpm > xs[i + 1]) i++;
  const h = xs[i + 1] - xs[i];
  const t = (rpm - xs[i]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * ms[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * ms[i + 1];
}

const curveCache = new WeakMap<EngineSpec, EngineCurve>();

/**
 * An engine's torque curve, derived from what the catalogue says it is: output, displacement, cylinders, fuel and blower.
 * Small cylinders rev higher (the piston speed limit), diesels make their torque low and run out early, a blower holds a
 * plateau, a scooter's two-stroke only really pulls in a narrow band near the top. The peak torque is whatever makes the
 * power peak equal the engine's rated kilowatts.
 */
export function engineCurve(spec: EngineSpec): EngineCurve | null {
  if (spec.kw <= 0) return null;
  const hit = curveCache.get(spec);
  if (hit) return hit;
  const shape = curveShape(spec);
  const vc = Math.max(0.03, spec.litres / cylindersOf(spec));
  let idle: number;
  let red: number;
  let pw: number;
  let tq: number;
  let knots: [number, number][];
  switch (shape) {
    case 'twoStroke':
      idle = 1800;
      red = 8800;
      pw = 7400;
      tq = 6400;
      knots = [[idle * 0.6, 0.15], [idle, 0.35], [pw * 0.62, 0.62], [tq, 1], [pw, 0.9], [red, 0.6], [red * 1.08, 0.25]];
      break;
    case 'small':
      idle = 1300;
      red = clamp(7000 * Math.pow(0.5 / vc, 0.2), 6000, 10500);
      pw = red * 0.9;
      tq = pw * 0.72;
      knots = [[idle * 0.5, 0.25], [idle, 0.6], [tq, 1], [pw, 0.9], [red, 0.74], [red * 1.1, 0.4]];
      break;
    case 'petrolBlown':
      idle = 800;
      red = clamp(6500 * Math.pow(0.5 / vc, 0.2), 5200, 9000) * 0.97;
      pw = red * 0.9;
      tq = pw * 0.42;
      knots = [[idle * 0.45, 0.2], [idle, 0.55], [tq, 1], [pw * 0.72, 1], [pw, 0.9], [red, 0.78], [red * 1.1, 0.45]];
      break;
    case 'diesel':
    case 'dieselBlown':
      idle = spec.litres > 8 ? 600 : 750;
      red = clamp(4400 * Math.pow(0.5 / vc, 0.45), 1900, 5000);
      pw = red * 0.87;
      tq = pw * (shape === 'diesel' ? 0.55 : 0.42);
      knots =
        shape === 'diesel'
          ? [[idle * 0.5, 0.3], [idle, 0.72], [tq, 1], [pw, 0.82], [red, 0.62], [red * 1.08, 0.2]]
          : [[idle * 0.5, 0.3], [idle, 0.55], [tq, 1], [pw * 0.7, 1], [pw, 0.85], [red, 0.62], [red * 1.08, 0.2]];
      break;
    default:
      idle = 800;
      red = clamp(6500 * Math.pow(0.5 / vc, 0.2), 5200, 9000);
      pw = red * 0.9;
      tq = pw * 0.62;
      knots = [[idle * 0.45, 0.2], [idle, 0.68], [tq, 1], [pw, 0.86], [red, 0.72], [red * 1.1, 0.4]];
  }
  const xs = knots.map((k) => k[0]);
  const ys = knots.map((k) => k[1]);
  const ms = pchipSlopes(xs, ys);
  // Scale the curve so the power peak is the engine's rating.
  let best = 0;
  let bestRpm = pw;
  for (let i = 0; i <= 120; i++) {
    const rpm = idle + ((red - idle) * i) / 120;
    const p = curveFrac({ xs, ys, ms }, rpm) * rpm;
    if (p > best) {
      best = p;
      bestRpm = rpm;
    }
  }
  const peakNm = (spec.kw * 1000) / ((best * TAU) / 60);
  const diesel = shape === 'diesel' || shape === 'dieselBlown';
  const tiny = shape === 'twoStroke' || shape === 'small';
  const launch = tiny ? pw * 0.75 : diesel ? tq * 0.95 : shape === 'petrolBlown' ? tq : clamp(tq * 0.75, idle * 2.2, tq);
  const c: EngineCurve = {
    shape,
    idle,
    peakTqRpm: tq,
    peakPwRpm: bestRpm,
    redline: red,
    peakNm,
    kw: spec.kw,
    launch,
    dragLo: peakNm * (diesel ? 0.06 : tiny ? 0.03 : 0.04),
    dragHi: peakNm * (diesel ? 0.2 : tiny ? 0.11 : 0.15),
    lag: 0.06 + 0.012 * spec.litres,
    xs,
    ys,
    ms,
  };
  curveCache.set(spec, c);
  return c;
}

/** Full-throttle torque at an rpm, Nm. Nothing below a stall or past the limiter. */
export function torqueAt(engine: EngineSpec | EngineCurve, rpm: number): number {
  const c = 'xs' in engine ? engine : engineCurve(engine);
  if (!c) return 0;
  return c.peakNm * curveFrac(c, rpm);
}

/** Output at an rpm, kW. */
export const powerAt = (engine: EngineSpec | EngineCurve, rpm: number): number => (torqueAt(engine, rpm) * rpm * TAU) / 60 / 1000;

/** Engine braking at an rpm, Nm (a positive number: it holds the wheels back). */
export function engineDrag(c: EngineCurve, rpm: number): number {
  return c.dragLo + (c.dragHi - c.dragLo) * clamp(rpm / c.redline, 0, 1.2);
}

// ------------------------------------------------------------------------------------------------ the gearbox

/** Used where a chassis has no gearbox data (a boat, a raider's rig): an ordinary five-speed. */
const DEFAULT_RATIOS = [3.4, 2.0, 1.35, 1.0, 0.8];

export interface Gearing {
  /** Forward ratios, first gear first. A CVT has its lowest and highest. */
  ratios: number[];
  reverse: number;
  cvt: boolean;
  /** Seconds a shift takes, and how much drive is lost meanwhile (0..1). */
  shift: number;
  cut: number;
  /** Final drive, matched to the engine so the limiter in top gear sits just past what it can reach. */
  final: number;
  /** Rolling radius of the driven wheels, m. */
  wheelR: number;
  /** Mechanical efficiency from flywheel to tyre. */
  eff: number;
  /** Speed at the redline in top gear, m/s. */
  vRev: number;
}

/** Rolling radius of the driven wheels (a rickshaw's small back wheels, a moped's back one). */
export function drivenRadius(def: VehicleDef): number {
  const w = wheelLayout(def.physics).filter((x) => x.drive);
  return w.length ? w.reduce((a, x) => a + x.r, 0) / w.length : def.physics.wheelRadius;
}

/** Height of the centre of mass over the road, m (the chassis centre at its ride height). */
export function comHeight(def: VehicleDef): number {
  const p = def.physics;
  return p.wheelRadius + p.suspension.rest - p.hardY;
}

/** Distance between the front and rear axles, m. */
export function wheelbaseOf(def: VehicleDef): number {
  const zs = wheelLayout(def.physics).map((w) => w.z);
  return zs.length ? Math.max(1.2, Math.max(...zs) - Math.min(...zs)) : 2.5;
}

/** Share of the wheels that are driven. */
export function drivenShare(def: VehicleDef): number {
  const all = wheelLayout(def.physics);
  return all.length ? all.filter((x) => x.drive).length / all.length : 1;
}

/**
 * The gears a build turns its wheels through. The gearbox part sets how many there are and how they are spaced; the final
 * drive is matched to the engine and the chassis (as a mechanic swapping a motor matches the diff to it): top gear runs out
 * of revs just past the speed the chassis was tuned to, scaled by what the engine is good for and by the gearbox's own
 * gearing (short gears sooner, tall gears later). Whether it gets there is up to the power, the weight and the road.
 */
export function gearing(def: VehicleDef, fit: Fit, spread = calibrate(def).spread): Gearing {
  const gb = gearboxSpec(def, fit);
  const raw = gb.ratios?.length ? gb.ratios : DEFAULT_RATIOS;
  // The game's roads run slower than real ones, so a box's steps are pulled in toward top gear by the chassis' spread:
  // first gear still launches the way the chassis always has, and every gear covers a useful stretch of the speed range.
  const tall = raw[raw.length - 1];
  const ratios = raw.map((r) => tall * Math.pow(r / tall, spread));
  const cvt = !!gb.cvt;
  const shift = gb.shift ?? 0.3;
  const wheelR = drivenRadius(def);
  const spec = engineSpec(def, fit);
  const curve = engineCurve(spec);
  const ef = engineEffects(def, fit);
  const vRev = baseTop(def) * (ef.empty ? 1 : ef.top) * gearTop(def, fit) * REV_MARGIN;
  const red = curve?.redline ?? 6000;
  const top = ratios[ratios.length - 1];
  const final = ((red * TAU) / 60) * wheelR / (vRev * top);
  return {
    ratios,
    reverse: ratios[0] * 0.95,
    cvt,
    shift,
    // A quick sequential box barely interrupts the drive; a slow truck box loses half of it while it shifts.
    cut: shift <= 0.1 ? 0.3 : 0.5,
    final,
    wheelR,
    eff: cvt ? 0.84 : ratios.length >= 8 ? 0.88 : 0.9,
    vRev,
  };
}

// ------------------------------------------------------------------------------------------------ the whole drive

export interface Powertrain {
  curve: EngineCurve | null;
  gearing: Gearing;
  /** Nothing reaches the wheels (no gearbox). */
  noDrive: boolean;
  /** The chassis' arcade gain on torque, and the bolt-ons' (exhaust, pipes, a scoop) share on top. */
  gain: number;
  boost: number;
  /** Engine braking against the curve's own (calibrated so a stock vehicle coasts as it always did). */
  brakeGain: number;
  /** Air resistance, N per (m/s)^2, and rolling resistance, at the chassis' reference scale. */
  air: number;
  roll: number;
  /**
   * Tyre grip for drive and braking (a friction coefficient), the share of the weight on the driven wheels, and how much
   * weight a pull squats back onto them (centre-of-mass height over wheelbase).
   */
  mu: number;
  driven: number;
  transfer: number;
  /** Flat-ground top speed at the reference weight, m/s. */
  vTop: number;
}

export interface ChassisCal {
  gain: number;
  air: number;
  brakeGain: number;
  /** How far the gearbox's steps are spread (1 as the part says, less pulls them toward top gear). */
  spread: number;
}

/** Bolt-on stat summed over the fitted parts (pipes, a scoop, a wing), the cabin's own rules applied. */
function fitSum(fit: Fit, k: 'force' | 'top'): number {
  let t = 0;
  for (const slot of FIT_SLOTS) {
    const it = fit[slot];
    if (it && cabinStatCounts(slot, k)) t += partDef(it.id).stats[k] ?? 0;
  }
  return t;
}

function goneTyres(tyres: Tyres | undefined, n: number): number {
  let k = 0;
  for (let i = 0; i < n; i++) if (tyres?.[i] && partDef(tyres[i]!.id).empty) k++;
  return k;
}

function assemble(def: VehicleDef, fit: Fit, tyres: Tyres | undefined, cal: ChassisCal): Powertrain {
  const spec = engineSpec(def, fit);
  const empty = bayEmpty(def, fit);
  const gb = gearboxSpec(def, fit);
  const exh = exhaustSpec(def, fit);
  const g = gearing(def, fit, cal.spread);
  const topSum = fitSum(fit, 'top');
  const gone = goneTyres(tyres, def.physics.wheelCount);
  const pt: Powertrain = {
    curve: empty ? null : engineCurve(spec),
    gearing: g,
    noDrive: gb.rating <= 0,
    gain: cal.gain,
    boost: (1 + exh.flow) * Math.max(0.4, 1 + fitSum(fit, 'force')),
    brakeGain: cal.brakeGain,
    // Bolt-ons that cut through the air (or catch it) move the top speed by the cube root of the drag.
    air: cal.air * Math.pow(clamp(1 + topSum, 0.5, 1.5), -3),
    roll: ROLL * (1 + 1.5 * gone),
    mu: 0.45 * def.physics.frictionSlip,
    driven: drivenShare(def),
    transfer: comHeight(def) / wheelbaseOf(def),
    vTop: 0,
  };
  pt.vTop = topSpeed(pt, def.physics.mass);
  return pt;
}

/** The limiter's trim: full fuel up to 98% of the redline, none at it. */
const soft = (c: EngineCurve, rpm: number) => clamp((c.redline - rpm) / (c.redline * 0.02), 0, 1);

/** The pull at the wheels in the best gear at a speed, full throttle, N (no shift in progress, no wheelspin). */
export function maxPull(pt: Powertrain, v: number): number {
  const c = pt.curve;
  const g = pt.gearing;
  if (!c || pt.noDrive) return 0;
  const wheelRpm = (Math.abs(v) * 60) / (TAU * g.wheelR);
  const k = (g.eff / g.wheelR) * pt.gain * pt.boost;
  if (g.cvt) {
    const lo = g.ratios[0];
    const hi = g.ratios[g.ratios.length - 1];
    const ratio = clamp(c.peakPwRpm / Math.max(1, wheelRpm * g.final), hi, lo);
    const rpm = Math.max(wheelRpm * ratio * g.final, c.launch);
    return torqueAt(c, rpm) * soft(c, rpm) * ratio * g.final * k;
  }
  let best = 0;
  for (const r of g.ratios) {
    const rpm = Math.max(wheelRpm * r * g.final, c.launch);
    best = Math.max(best, torqueAt(c, rpm) * soft(c, rpm) * r * g.final * k);
  }
  return best;
}

/** What holds a vehicle back at a speed on a grade, N (`m` at the reference scale). */
export function resistance(pt: Powertrain, m: number, v: number, grade = 0): number {
  const th = Math.atan(grade);
  return pt.air * v * v + pt.roll * m * G * Math.cos(th) + m * G * Math.sin(th) + BODY_DAMPING * m * v;
}

/** Steady top speed: where the best pull meets the resistance, never past the limiter in top gear. m/s. */
export function topSpeed(pt: Powertrain, m: number, grade = 0): number {
  const vMax = pt.gearing.vRev * 1.02;
  let last = 0;
  for (let v = 0.25; v <= vMax; v += 0.25) {
    if (maxPull(pt, v) >= resistance(pt, m, v, grade)) last = v;
    else if (v > last + 3) break;
  }
  return last;
}

// ------------------------------------------------------------------------------------------------ the automatic

/**
 * The engine and its automatic gearbox, stepped once per physics tick. It keeps the revs, the gear, the clutch and the
 * shifts: up when the next gear pulls harder (flat out) or once the revs are past where a light foot would change, down
 * when the revs sag under the load (a hill, a heavy trailer of cargo) or on a kickdown, never into a gear that would
 * over-rev or straight back again. A shift cuts the drive for a moment and the revs fall to the new gear. Reverse is its
 * own gear. A CVT has no steps: it holds the engine near its power peak under a full throttle and lets the speed climb.
 */
export class DriveUnit {
  /** Engine speed, rpm. */
  rpm = 0;
  /** Gear: 1 is first, -1 reverse. A CVT is always in 1 (or reverse). */
  gear = 1;
  /** Clutch or converter slip, 0 locked to 1 open. */
  slip = 1;
  /** Wheelspin of the driven tyres: how far the revs run ahead of the road, as a share. */
  spin = 0;
  /** How hard the engine is working, 0..1: the share of its torque being asked for. */
  load = 0;
  /** The limiter is cutting in. */
  limiter = false;
  /** Seconds left of the shift in progress. */
  shiftT = 0;
  /** Seconds since the last shift, which keeps it from hunting. */
  private holdT = 9;
  private lastThr = 0;
  private cvtRatio = 0;

  constructor(public pt: Powertrain) {
    this.cvtRatio = pt.gearing.ratios[0];
  }

  /** A new powertrain (a part swapped): keep the revs and a gear that exists. */
  setPowertrain(pt: Powertrain) {
    this.pt = pt;
    const n = pt.gearing.cvt ? 1 : pt.gearing.ratios.length;
    if (this.gear > n) this.gear = n;
    this.cvtRatio = clamp(this.cvtRatio, pt.gearing.ratios[pt.gearing.ratios.length - 1], pt.gearing.ratios[0]);
  }

  get shifting(): boolean {
    return this.shiftT > 0;
  }

  /** Revs as a share of the band from idle to the redline, for gauges and the sound. */
  get rpmFrac(): number {
    const c = this.pt.curve;
    return c ? clamp((this.rpm - c.idle) / (c.redline - c.idle), 0, 1.05) : 0;
  }

  private ratio(): number {
    const g = this.pt.gearing;
    if (this.gear < 0) return g.reverse;
    if (g.cvt) return this.cvtRatio;
    return g.ratios[Math.max(0, Math.min(g.ratios.length - 1, this.gear - 1))];
  }

  /**
   * One step. `v` is the forward speed (m/s, signed), `thr` the accelerator (0..1), `dir` where the driver wants to go
   * (1 forward, -1 reverse, 0 nowhere in particular), `running` whether the engine is on, `gain` what damage, heat and
   * the tether leave of its power. Returns the drive force at the driven wheels, N, positive forward: before the tyres
   * have had their say (see `tyres`).
   */
  step(dt: number, v: number, thr: number, dir: number, running: boolean, gain = 1): number {
    const pt = this.pt;
    const c = pt.curve;
    const g = pt.gearing;
    this.holdT += dt;
    this.limiter = false;
    if (!c || !running) {
      this.rpm = Math.max(0, this.rpm - dt * 2500);
      this.load = 0;
      this.slip = 1;
      this.shiftT = 0;
      this.lastThr = thr;
      return 0;
    }
    thr = clamp(thr, 0, 1);
    const wheelRpm = (Math.abs(v) * 60) / (TAU * g.wheelR);
    if (pt.noDrive) {
      this.rpm += (c.idle + thr * (c.redline * 0.85 - c.idle) - this.rpm) * (1 - Math.exp(-dt / c.lag));
      this.load = thr * 0.3;
      this.slip = 1;
      this.lastThr = thr;
      return 0;
    }
    // Reverse is a gear of its own; selecting it, or coming back out of it, takes a moment.
    if (dir < 0 && this.gear !== -1) {
      this.gear = -1;
      this.shiftT = 0.3;
      this.holdT = 0;
    } else if (dir > 0 && this.gear === -1) {
      this.gear = 1;
      this.shiftT = 0.3;
      this.holdT = 0;
    }
    if (g.cvt && this.gear > 0) {
      const want = c.idle + (c.peakPwRpm * 0.97 - c.idle) * Math.pow(thr, 0.75);
      this.cvtRatio = clamp(want / Math.max(1, wheelRpm * g.final), g.ratios[g.ratios.length - 1], g.ratios[0]);
    }
    const overall = this.ratio() * g.final;
    const locked = wheelRpm * overall;
    // The clutch (or converter, or a scooter's centrifugal clutch) slips until the wheels can carry the engine's revs.
    const engage = g.cvt ? Math.min(c.launch, c.idle + (c.peakPwRpm * 0.97 - c.idle) * Math.pow(thr, 0.75)) : c.idle + (c.launch - c.idle) * Math.pow(thr, 0.8);
    let target: number;
    if (thr > 0.01 && locked < engage) {
      target = engage;
      this.slip = 1 - locked / Math.max(1, engage);
    } else if (locked < c.idle) {
      target = c.idle;
      this.slip = 1;
    } else {
      // Wheelspin lets the revs run ahead of the road (up to just under the limiter); the tyre still puts down all the
      // grip it has, so the pull is worked out at the road's revs below.
      target = locked < c.redline ? Math.min(locked * (1 + this.spin), c.redline * 0.985) : locked;
      this.slip = 0;
    }
    const shifting = this.shiftT > 0;
    if (shifting) this.shiftT = Math.max(0, this.shiftT - dt);
    const tau = shifting ? Math.max(0.04, g.shift * 0.4) : this.slip > 0 ? c.lag * 1.6 : 0.035;
    this.rpm += (target - this.rpm) * (1 - Math.exp(-dt / tau));
    // Torque comes from the engine's own revs while the clutch slips, otherwise from the gear it is locked in (the new one,
    // during a shift). A soft limiter trims the fuel over the last two percent of the band, then cuts it.
    const at = this.slip > 0 && thr > 0.01 ? this.rpm : Math.max(locked, c.idle);
    this.limiter = at >= c.redline * 0.995 || this.rpm >= c.redline * 0.995;
    const full = torqueAt(c, at) * soft(c, at);
    let T: number;
    if (thr > 0.01) T = thr * full;
    else if (this.slip === 0 && Math.abs(v) > 1 && dir >= 0 === this.gear > 0) T = -engineDrag(c, at) * pt.brakeGain;
    else T = 0;
    this.load = clamp(thr > 0.01 ? (thr * full) / c.peakNm : 0, 0, 1);
    const sign = this.gear < 0 ? -REVERSE_K : 1;
    const cut = shifting ? 1 - g.cut : 1;
    const F = T * overall * (g.eff / g.wheelR) * pt.gain * pt.boost * (T > 0 ? gain : 1) * cut * sign;
    if (!shifting && this.gear > 0 && !g.cvt && dir >= 0) this.autoShift(wheelRpm, thr);
    this.lastThr = thr;
    return F;
  }

  /** How much of the drive the tyres put down: the rest spins them, and the revs run ahead of the road. */
  tyres(demanded: number, applied: number, dt: number) {
    const want = Math.abs(demanded) > 1 && Math.abs(applied) < Math.abs(demanded) ? clamp((1 - Math.abs(applied) / Math.abs(demanded)) * 0.9, 0, 0.6) : 0;
    this.spin += (want - this.spin) * (1 - Math.exp(-dt / 0.15));
  }

  private shiftTo(gear: number) {
    this.gear = gear;
    this.shiftT = this.pt.gearing.shift;
    this.holdT = 0;
  }

  private autoShift(wheelRpm: number, thr: number) {
    const c = this.pt.curve!;
    const g = this.pt.gearing;
    const n = g.ratios.length;
    const rpmIn = (gear: number) => wheelRpm * g.ratios[gear - 1] * g.final;
    const pull = (gear: number) => {
      const rpm = rpmIn(gear);
      return rpm >= c.redline ? 0 : torqueAt(c, Math.max(rpm, c.idle)) * g.ratios[gear - 1];
    };
    const flat = thr > 0.8;
    const cur = this.gear;
    const rpm = rpmIn(cur);
    // Where a light foot changes up: early and quiet, rising toward the power peak as the foot goes down.
    const upAt = c.idle + (c.peakPwRpm - c.idle) * (0.28 + 0.62 * Math.pow(thr, 1.3));
    // Up at the limiter as soon as the last shift is done; otherwise only once it has settled, so it never hunts.
    const atLimit = rpm >= c.redline * 0.97;
    if (cur < n && this.slip === 0 && this.holdT > g.shift + (atLimit ? 0.05 : 0.15)) {
      const next = rpmIn(cur + 1);
      const lug = next < c.idle * 1.35;
      if (!lug && (atLimit || (flat ? pull(cur + 1) >= pull(cur) : rpm > upAt))) {
        // Skip a gear that would still be at the limiter (a light truck running away from a heavy box's low gears).
        let to = cur + 1;
        while (to < n && rpmIn(to) > c.redline * 0.95) to++;
        this.shiftTo(to);
        return;
      }
    }
    if (cur > 1 && this.holdT > g.shift + 0.25) {
      // A stab of the throttle: drop to the lowest gear that keeps the revs well under the redline.
      if (thr > 0.9 && this.lastThr < 0.6) {
        for (let k = 1; k < cur; k++) {
          if (rpmIn(k) < c.redline * 0.88) {
            this.shiftTo(k);
            return;
          }
        }
      }
      const below = rpmIn(cur - 1);
      if (below > c.redline * 0.9) return;
      if (flat) {
        // Under full throttle it changes down as soon as the gear below pulls clearly harder.
        if (pull(cur - 1) > pull(cur) * 1.12) this.shiftTo(cur - 1);
        return;
      }
      const downAt = thr > 0.05 ? c.idle * 1.25 + (c.peakTqRpm - c.idle * 1.25) * thr * 0.85 : c.idle * 1.12;
      if (rpm < downAt && below < upAt * 0.95) this.shiftTo(cur - 1);
    }
  }
}

// ------------------------------------------------------------------------------------------------ a straight line

export interface RunResult {
  /** Seconds to reach each target speed (Infinity if it never did). */
  times: number[];
  /** Highest speed reached, m/s. */
  vMax: number;
}

/**
 * The powertrain on a straight line: flat out from rest for `seconds`, with the tyres' grip, the air, the rolling
 * resistance, the body's damping and a grade. Masses are at the reference scale. Used for the garage's figures and to
 * calibrate each chassis.
 */
export function straightRun(pt: Powertrain, m: number, targets: number[], seconds = 40, grade = 0, toEnd = false): RunResult {
  const u = new DriveUnit(pt);
  const dt = 1 / 30;
  let v = 0;
  let vMax = 0;
  let a = 0;
  const times = targets.map(() => Infinity);
  const th = Math.atan(grade);
  let left = targets.length;
  for (let t = 0; t < seconds; t += dt) {
    // The driven wheels' share of the weight, plus what the pull squats onto them when only the back ones drive.
    const grip = pt.mu * m * (G * Math.cos(th) * pt.driven + (pt.driven < 1 ? Math.max(0, a) * pt.transfer : 0));
    const want = u.step(dt, v, 1, 1, true, 1);
    const got = clamp(want, -grip, grip);
    u.tyres(want, got, dt);
    a = (got - pt.air * v * v * Math.sign(v) - (v > 0.05 ? pt.roll * m * G * Math.cos(th) : 0) - m * G * Math.sin(th)) / m - BODY_DAMPING * v;
    v = Math.max(grade > 0 ? -50 : 0, v + a * dt);
    vMax = Math.max(vMax, v);
    for (let i = 0; i < targets.length; i++) {
      if (times[i] === Infinity && v >= targets[i]) {
        times[i] = t + dt;
        left--;
      }
    }
    if (left === 0 && !toEnd) break;
  }
  return { times, vMax };
}

/** The old arcade model's time to a speed: the table's force, tapered to nothing at the table's top speed. */
function arcadeTime(def: VehicleDef, target: number): number {
  const m = def.physics.mass;
  const vm = def.topSpeedKmh / 3.6;
  const F0 = def.physics.engineForce;
  let v = 0;
  const dt = 1 / 60;
  for (let t = 0; t < 60; t += dt) {
    const a = (F0 / m) * clamp(1 - Math.pow(v / vm, 2.2), 0, 1) - BODY_DAMPING * v;
    v += a * dt;
    if (v >= target) return t + dt;
  }
  return 60;
}

const topCache = new Map<string, number>();

/**
 * The top speed a chassis was tuned to, m/s: where the old arcade model's tapered force met the body's damping (a little
 * under the table's figure, which was the taper's end point). The gearing of every build on the chassis is matched to it.
 */
export function baseTop(def: VehicleDef): number {
  const key = `${def.id}:${def.physics.mass}:${def.physics.engineForce}:${def.topSpeedKmh}`;
  const hit = topCache.get(key);
  if (hit !== undefined) return hit;
  const m = def.physics.mass;
  const vm = def.topSpeedKmh / 3.6;
  const F0 = def.physics.engineForce;
  let lo = 0;
  let hi = vm;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (F0 * (1 - Math.pow(mid / vm, 2.2)) > BODY_DAMPING * m * mid) lo = mid;
    else hi = mid;
  }
  topCache.set(key, lo);
  return lo;
}

const calCache = new Map<string, ChassisCal>();

/**
 * Fit a chassis' arcade gain, gear spread, air resistance and engine braking so that its stock powertrain drives like the
 * table: the same launch (time to a quarter of its top speed), the same pull (time to 60% of it), and the same coasting
 * when the foot comes off (the old model shed 0.8 m/s^2 on top of the body's damping): engine braking through the gear it
 * cruises in, the tyres rolling, and the air making up the rest. Cached per chassis.
 */
export function calibrate(def: VehicleDef): ChassisCal {
  const p = def.physics;
  const key = `${def.id}:${p.mass}:${p.engineForce}:${def.topSpeedKmh}:${p.wheelRadius}:${def.stockEngine ?? ''}`;
  const hit = calCache.get(key);
  if (hit) return hit;
  const m = p.mass;
  const vm = def.topSpeedKmh / 3.6;
  const t25 = arcadeTime(def, vm * 0.25);
  const t60 = arcadeTime(def, vm * 0.6);
  // A floor on the air: a body pushes some of it whatever else is going on.
  const airMin = 0.22 * def.width;
  const cal: ChassisCal = { gain: 1, air: airMin, brakeGain: 1, spread: 1 };
  // The gain that makes the 60% time, for a given spread.
  const fitGain = () => {
    let lo = 0.05;
    let hi = 60;
    for (let i = 0; i < 24; i++) {
      const mid = Math.sqrt(lo * hi);
      cal.gain = mid;
      const t = straightRun(assemble(def, {}, undefined, cal), m, [vm * 0.6], 30).times[0];
      if (t > t60) lo = mid;
      else hi = mid;
    }
    cal.gain = Math.sqrt(lo * hi);
  };
  for (let pass = 0; pass < 2; pass++) {
    // A wider spread (a shorter first gear) launches harder for the same pull further up.
    let lo = 0.2;
    let hi = 1.2;
    for (let i = 0; i < 14; i++) {
      cal.spread = (lo + hi) / 2;
      fitGain();
      const t = straightRun(assemble(def, {}, undefined, cal), m, [vm * 0.25], 30).times[0];
      if (t > t25) lo = cal.spread;
      else hi = cal.spread;
    }
    cal.spread = (lo + hi) / 2;
    fitGain();
    // Coast from 60% of top speed in the gear a light foot would have it in.
    const v = vm * 0.6;
    const u = new DriveUnit(assemble(def, {}, undefined, { ...cal, brakeGain: 1 }));
    for (let i = 0; i < 120; i++) u.step(1 / 30, v, 0.3, 1, true, 1);
    for (let i = 0; i < 20; i++) u.step(1 / 30, v, 0, 1, true, 1);
    const eb = Math.max(0, -u.step(1 / 30, v, 0, 1, true, 1));
    const need = 0.8 * m - ROLL * m * G;
    if (need - eb >= airMin * v * v) {
      cal.brakeGain = 1;
      cal.air = (need - eb) / (v * v);
    } else {
      cal.air = airMin;
      cal.brakeGain = eb > 1 ? clamp((need - airMin * v * v) / eb, 0, 1) : 0;
    }
  }
  calCache.set(key, cal);
  return cal;
}

const ptCache = new Map<string, Powertrain>();

/**
 * The powertrain of a build: its engine, gearbox, exhaust and bolt-ons on its chassis, calibrated to that chassis.
 * Cached by what goes into it, so calling it every refit costs nothing.
 */
export function powertrainFor(def: VehicleDef, fit: Fit, tyres?: Tyres): Powertrain {
  const cal = calibrate(def);
  const ids = FIT_SLOTS.map((s) => fit[s]?.id ?? '').join(',');
  const key = `${def.id}:${cal.gain.toFixed(4)}:${ids}:${goneTyres(tyres, def.physics.wheelCount)}`;
  const hit = ptCache.get(key);
  if (hit) return hit;
  if (ptCache.size > 400) ptCache.clear();
  const pt = assemble(def, fit, tyres, cal);
  ptCache.set(key, pt);
  return pt;
}

/** A chassis exactly as it left the factory. */
export const stockPowertrain = (def: VehicleDef): Powertrain => powertrainFor(def, {});

/** Kilowatts per tonne. */
export const powerToWeight = (kw: number, kg: number): number => (kg > 0 ? (kw * 1000) / kg : 0);
