import { RAPIER, GROUPS, type PhysicsWorld, type RigidBody, type Collider } from './physics';
import { wheelLayout, type VehicleDef } from '../data';
import { clamp, damp, smoothstep } from '../core/math';
import { BODY_DAMPING, DriveUnit, ROLL, stockPowertrain, topSpeed, type Powertrain } from '../sim/powertrain';
import { driveFeel, type DriveFeel } from '../sim/driveFeel';
import { GROUND_FEEL, groundName, lateralCurve, looseDrag, patchOf, saturation, setBite, TYRE_FEEL, type GroundName, type Patch } from '../sim/tyreModel';

export interface DriveInput {
  /** -1 (left) .. 1 (right). */
  steer: number;
  throttle: number;
  brake: number;
  handbrake: boolean;
  /**
   * How much the driving assists help, 0 (pro: the car's own electronics and nothing more) to 1 (arcade: the hands catch a
   * slide, the throttle and brakes are eased at the limit). Missing: 1, which is what the AI drives with.
   */
  assist?: number;
}

export interface DriveEnv {
  /** Engine power multiplier from damage, tether and crew (1 = full). */
  power: number;
  /** Grip multiplier from damage (flat tires) and modules. */
  grip: number;
  topSpeedMult: number;
  forceMult: number;
  travelMult: number;
  /** Braking strength against the chassis' own (1 is stock): bigger brakes, or an engine that outruns small ones. */
  brakeMult: number;
  /** Steering lock against the chassis' own (1 is stock): a quick wheel, or none on the column at all. */
  steerMult?: number;
  /** Per-wheel flat flags. */
  flats?: boolean[];
  engineOn: boolean;
  /** Surface lookup under a wheel contact: its grip, its drag (sand, mud) and what it is ('asphalt', 'sand'...). */
  surface?: (x: number, z: number) => { grip: number; drag: number; name?: string };
  /** How the build drives (`sim/driveFeel.ts`): drive layout, diffs, aids, tyres. Missing: the chassis' factory feel. */
  feel?: DriveFeel;
  /** Each tyre's condition, 0 (worn smooth) to 1. Missing: new. */
  wear?: number[];
  /**
   * Loose ground under wheel `i` at (x, z), heading (fx, fz): how far its surface lies above (+) or below (-) the collider
   * the wheel is cast against (a rut, a crater, a berm, and what this tyre is pressing in now), and its slope. Missing: the
   * collider is the ground.
   */
  ground?: (i: number, x: number, z: number, fx: number, fz: number, out: { h: number; gx: number; gz: number }) => void;
  /**
   * The engine, gearbox and final drive turning the wheels (`sim/powertrain.ts`). Missing: the chassis' factory one. With
   * it, `forceMult` is only an extra on its torque and `topSpeedMult` a governor below 1 (the tether slowing a leader).
   */
  drive?: Powertrain;
}

/**
 * How heavy the vehicle is against the reference it was tuned at (stock, a driver, full tank), where its centre of mass
 * has moved to, and how stiff its springs are against the factory ones. See `sim/massModel.ts`.
 */
export interface BodyLoad {
  /** Total mass over the reference mass. */
  scale: number;
  /** Centre of mass, chassis frame, against the reference. */
  com: { x: number; y: number; z: number };
  /** Spring rate against the factory springs (heavy-duty springs squat less under the same load). */
  spring?: number;
  /** Extra rotational inertia from the payload (roof and bed loads), kg m^2, already at the physics' scale (like `scale`). */
  inertia?: { x: number; y: number; z: number };
}

/** Tyre load sensitivity: grip per unit load falls as the load on a tyre rises (exponent on load over reference). */
const LOAD_SENS = -0.15;
/**
 * Below this speed (m/s) a tyre's slip angle is measured against it instead of the rolling speed, so a car at a crawl does
 * not read a sideways creep as a ninety-degree slide.
 */
const SLIP_V0 = 3;
/** Share of a wheel's sideways (or rolling) way a tyre can take off in one step: under 1, so four tyres never overshoot. */
const RELAX = 0.85;
const NO_GROUND = { grip: 1, drag: 0, name: undefined as string | undefined };

/** One tyre's working for a step (see `VehicleBody.tyreStep`). */
interface TyreScratch {
  on: boolean;
  /** Rolling direction and left on the ground's plane, the patch (world) and it from the centre of mass. */
  fx: number;
  fy: number;
  fz: number;
  lx: number;
  ly: number;
  lz: number;
  px: number;
  py: number;
  pz: number;
  rx: number;
  ry: number;
  rz: number;
  /** Rolling speed of the patch, its load (N), its grip across and along (N), and the sideways force it wants (N). */
  vL: number;
  load: number;
  capY: number;
  capX0: number;
  wantY: number;
  /** The mass whose weight it holds on a slope (its share of the load), kg. */
  hold: number;
  slide: number;
  roll: number;
  /** Loose ground's drag on it, N. */
  loose: number;
}

/** A point where something presses on the chassis, in the vehicle's frame. */
export interface Contact {
  x: number;
  y: number;
  z: number;
  /** Unit normal, pointing out of the chassis toward what it touches. */
  nx: number;
  ny: number;
  nz: number;
  impulse: number;
  /** Rapier handle of the collider that was hit. */
  other: number;
}

export const defaultEnv = (): DriveEnv => ({ power: 1, grip: 1, topSpeedMult: 1, forceMult: 1, travelMult: 1, brakeMult: 1, engineOn: true });

export function rotateByQuat(q: { x: number; y: number; z: number; w: number }, vx: number, vy: number, vz: number): [number, number, number] {
  const { x, y, z, w } = q;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

export function yawFromQuat(q: { x: number; y: number; z: number; w: number }): number {
  const [fx, , fz] = rotateByQuat(q, 0, 0, 1);
  return Math.atan2(fx, fz);
}

/** One Rapier raycast vehicle whose parameters come from the data table. Forward is local +Z; +X is left. */
export class VehicleBody {
  body: RigidBody;
  collider: Collider;
  ctl: RAPIER.DynamicRayCastVehicleController;
  wheelCount: number;
  steered: boolean[] = [];
  driven: boolean[] = [];
  rear: boolean[] = [];
  wheelLocal: [number, number, number][] = [];
  /** Each wheel's radius (a trike's small back wheels are smaller than its front one). */
  radii: number[] = [];
  steerAngle = 0;
  /** Impact this step (m/s change), read once per tick by the damage system. */
  impact = 0;
  impactDirX = 0;
  impactDirZ = 0;
  private prevVel = { x: 0, y: 0, z: 0 };
  private prevSpin = { x: 0, y: 0, z: 0 };
  /** This step's change of velocity (world, m/s) then of spin (world, rad/s): what the bolted-on parts feel. */
  shock = [0, 0, 0, 0, 0, 0];
  /** Spin right now (world, rad/s). */
  spin: [number, number, number] = [0, 0, 0];
  grounded = 0;
  flipTimer = 0;
  private tmpV = { x: 0, y: 0, z: 0 };
  /** Mass the body runs at right now (the table's mass at the reference load, scaled by `setLoad`). */
  mass: number;
  readonly maxSteer: number;
  /** Distance between the front and rear axles, used for speed-sensitive steering and the yaw assist. */
  wheelbase = 1.5;
  private yawTarget = 0;
  /** The engine and its gearbox: revs, gear, clutch, shifts. */
  unit: DriveUnit;
  /** Load against the reference, and the spring rate, as last set. */
  load: Required<Pick<BodyLoad, 'scale' | 'spring'>> & { com: { x: number; y: number; z: number } } = { scale: 1, spring: 1, com: { x: 0, y: 0, z: 0 } };
  /** Static load on one wheel at the reference weight, N: what the tyres' load sensitivity is measured against. */
  private fzRef: number;
  /** Flat-ground top speed with the present powertrain and load, m/s (recomputed when either changes). */
  private vTopNow = 0;
  /** Roll inertia the payload adds (a pillion, a loaded rack), for the two-wheeler's balance. */
  private rollExtra = 0;
  private vTopFor: Powertrain | null = null;
  /** Each wheel's load, smoothed over a few steps, N. */
  private fzS: Float64Array;
  /** Drive force asked for and put down this step, N, for tests and the HUD. */
  driveAsked = 0;
  drivePut = 0;
  /** Each wheel's suspension rest length as the load set it (`setLoad`), before the loose ground's say. */
  private restBase: Float64Array;
  /**
   * How far each wheel's ground lies above the collider it is cast against, m (negative in a rut or a crater): its
   * suspension's rest length is moved by it, so the chassis rides the ground that is drawn and the wheel is drawn in it.
   */
  readonly sink: Float64Array;
  private slopeX: Float64Array;
  private slopeZ: Float64Array;
  private soft = { h: 0, gx: 0, gz: 0 };
  /** The chassis' factory feel, used when the env brings none, and the one in use now. */
  private feel0: DriveFeel;
  private feelNow: DriveFeel | null = null;
  /** The tyres' average bite on each ground, for the feel in use. */
  private bite: Record<GroundName, number> = { asphalt: 1, hardpan: 1, sand: 1, mud: 1 };
  /** Where the bare chassis' weight sits along its length (chassis frame, m) and each wheel's static share of it. */
  private comZ0 = 0;
  private share0: Float64Array;
  /** Axles: the wheels on each, front first. */
  private axles: number[][] = [];
  /**
   * How far (m, along the chassis) each wheel's slip is read from its own axle: on a tandem or a rig's run of axles the
   * whole group is read at its middle, as if the axles self-steered, so they turn together instead of scrubbing each
   * other to a standstill. 0 on a car.
   */
  private groupDz: Float64Array;
  /** Each wheel's tyre this step: load (N), how much of its grip it uses, and the scratch the solver keeps. */
  readonly wheelLoad: Float64Array;
  readonly gripUse: Float64Array;
  /** Sideways sliding speed past the tyre's peak, m/s: what squeals, smokes and lays a skid mark. */
  readonly slipSide: Float64Array;
  /** Tyre surface speed over the ground speed, m/s: + wheelspin, - a wheel locked under braking. */
  readonly slipSpin: Float64Array;
  /** Each wheel's spin, rad/s: from the road, plus wheelspin, less a lock. */
  readonly wheelSpeed: Float64Array;
  /** Body slip: the angle between where it points and where it is going, rad (+ going left of its nose). */
  slide = 0;
  /** How hot the brakes are against what they can take before fading (fade starts near 1). */
  brakeHeat = 0;
  /** Driving aids working this step, 0..1: anti-lock, traction control, stability control (and the arcade hands). */
  readonly aids = { abs: 0, tcs: 0, esc: 0 };
  /** Grip the front tyres have here (a friction coefficient) and the slip angles where front and back tyres peak. */
  private muFront = 1.1;
  private peakFront = 0.11;
  private peakRear = 0.11;
  private airT = 0;
  /** Grip left along each wheel once it pushes sideways, N, and the drive each is asked for, N (scratch for `tyreStep`). */
  private capX: Float64Array;
  private wantD: Float64Array;
  private patch: Patch = { peak: 0.1, slide: 0.8, roll: 1 };
  private ws: TyreScratch[];

  constructor(
    private P: PhysicsWorld,
    public def: VehicleDef,
    x: number,
    y: number,
    z: number,
    yaw: number,
  ) {
    const p = def.physics;
    this.mass = p.mass;
    this.maxSteer = (p.maxSteerDeg * Math.PI) / 180;
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
      .setLinearDamping(BODY_DAMPING)
      .setAngularDamping(p.wheelCount === 2 ? 2.0 : 1.2)
      .setCanSleep(false);
    this.body = P.world.createRigidBody(desc);
    const [hx, hy, hz] = p.halfExtents;
    this.collider = P.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz).setMass(p.mass).setFriction(0.3).setRestitution(0.05).setCollisionGroups(GROUPS.vehicle),
      this.body,
    );
    this.ctl = P.world.createVehicleController(this.body);

    // Wheel layout: one axle per entry of wheelsZ, two wheels per axle unless wheelsX is [0], or the chassis' own axles.
    const layout = wheelLayout(p);
    for (const w of layout) {
      this.wheelLocal.push([w.x, w.y, w.z]);
      this.radii.push(w.r);
      this.steered.push(w.steer);
      this.driven.push(w.drive);
      this.rear.push(w.rear);
    }
    this.wheelCount = this.wheelLocal.length;
    const zs = this.wheelLocal.map((w) => w[2]);
    this.wheelbase = Math.max(1.2, Math.max(...zs) - Math.min(...zs));
    for (let i = 0; i < this.wheelCount; i++) {
      const [wx, wy, wz] = this.wheelLocal[i];
      this.ctl.addWheel({ x: wx, y: wy, z: wz }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, p.suspension.rest, this.radii[i]);
      this.ctl.setWheelSuspensionStiffness(i, p.suspension.stiffness);
      this.ctl.setWheelMaxSuspensionTravel(i, p.suspension.travel);
      // The tyres are this class's own (see `tyreStep`): Rapier only casts the wheels and works the springs.
      this.ctl.setWheelFrictionSlip(i, p.frictionSlip);
      this.ctl.setWheelSideFrictionStiffness(i, 0);
      const crit = 2 * Math.sqrt(p.suspension.stiffness);
      this.ctl.setWheelSuspensionCompression(i, 0.83 * crit);
      this.ctl.setWheelSuspensionRelaxation(i, 0.88 * crit);
      this.ctl.setWheelMaxSuspensionForce(i, p.mass * 40);
    }
    const n = this.wheelCount;
    this.fzRef = (p.mass * 9.81) / Math.max(1, n);
    this.fzS = new Float64Array(n).fill(this.fzRef);
    this.restBase = new Float64Array(n).fill(p.suspension.rest);
    this.sink = new Float64Array(n);
    this.slopeX = new Float64Array(n);
    this.slopeZ = new Float64Array(n);
    this.wheelLoad = new Float64Array(n);
    this.gripUse = new Float64Array(n);
    this.slipSide = new Float64Array(n);
    this.slipSpin = new Float64Array(n);
    this.wheelSpeed = new Float64Array(n);
    this.capX = new Float64Array(n);
    this.wantD = new Float64Array(n);
    this.ws = Array.from({ length: n }, (): TyreScratch => ({ on: false, fx: 0, fy: 0, fz: 1, lx: 1, ly: 0, lz: 0, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, vL: 0, load: 0, capY: 0, capX0: 0, wantY: 0, hold: 0, slide: 0.8, roll: 1, loose: 0 }));
    this.share0 = new Float64Array(n).fill(1 / Math.max(1, n));
    this.unit = new DriveUnit(stockPowertrain(def));
    this.feel0 = driveFeel(def);
    this.useFeel(this.feel0);
    // Axles by where the wheels sit along the chassis, front first.
    const axleZ = [...new Set(this.wheelLocal.map((w) => Math.round(w[2] * 100)))].sort((a, b) => b - a);
    this.axles = axleZ.map((z) => this.wheelLocal.flatMap((w, i) => (Math.round(w[2] * 100) === z ? [i] : [])));
    this.groupDz = new Float64Array(n);
    for (const steer of [true, false]) {
      const group = this.wheelLocal.flatMap((w, i) => (this.steered[i] === steer ? [i] : []));
      const zMid = group.reduce((a, i) => a + this.wheelLocal[i][2], 0) / Math.max(1, group.length);
      for (const i of group) this.groupDz[i] = zMid - this.wheelLocal[i][2];
    }
    // Where the weight sits: a two-axle chassis carries the share its feel says on the front axle (a nose-heavy hatch, a
    // rear-engined buggy), and each spring is preloaded for its share so it still sits level. Longer chassis stay centred.
    if (this.axles.length === 2) {
      const [fa, ra] = this.axles;
      const zf = this.wheelLocal[fa[0]][2];
      const zr = this.wheelLocal[ra[0]][2];
      const front = this.feel0.front;
      this.comZ0 = zr + front * (zf - zr);
      for (const i of fa) this.share0[i] = front / fa.length;
      for (const i of ra) this.share0[i] = (1 - front) / ra.length;
    }
    this.setLoad({ scale: 1, com: { x: 0, y: 0, z: 0 } });
  }

  /** A new feel (parts changed): which wheels are driven, and the tyres' average bite on each ground. */
  private useFeel(f: DriveFeel) {
    this.feelNow = f;
    for (let i = 0; i < this.wheelCount; i++) this.driven[i] = (f.torque[i] ?? 0) > 0;
    for (const g of Object.keys(GROUND_FEEL) as GroundName[]) this.bite[g] = setBite(f.tyres, g);
  }

  /**
   * Put the vehicle's real weight on the body: its mass (the table's, scaled by the load), where its centre of mass sits, and
   * springs that carry it as real springs would. Rapier's suspension pushes per unit of chassis mass, so the stiffness and
   * damping are scaled down as the mass goes up: a loaded car squats, wallows and rolls more, an empty one rides a little
   * high. Heavier-rated springs are preloaded to keep the factory ride height and squat less. Call it when the load changes
   * (it is cheap, but not every frame).
   */
  setLoad(l: BodyLoad) {
    const p = this.def.physics;
    const scale = clamp(l.scale, 0.2, 6);
    const spring = clamp(l.spring ?? 1, 0.5, 2);
    this.load.scale = scale;
    this.load.spring = spring;
    this.load.com.x = l.com.x;
    this.load.com.y = l.com.y;
    this.load.com.z = l.com.z;
    const m = p.mass * scale;
    this.mass = m;
    const [hx, hy, hz] = p.halfExtents;
    const ex = l.inertia ?? { x: 0, y: 0, z: 0 };
    this.rollExtra = ex.z;
    // The box's own inertia about its centre at this mass, with what the payload adds out on the roof or in the bed.
    const ix = (m * (hy * hy + hz * hz)) / 3 + ex.x;
    const iy = (m * (hx * hx + hz * hz)) / 3 + ex.y;
    const iz = (m * (hx * hx + hy * hy)) / 3 + ex.z;
    // The chassis' own weight distribution (`comZ0`) under whatever the load moves.
    const com = { x: l.com.x, y: l.com.y, z: l.com.z + this.comZ0 };
    if (Math.abs(scale - 1) < 0.002 && Math.abs(com.x) + Math.abs(com.y) + Math.abs(com.z) < 0.003 && !(ex.x + ex.y + ex.z)) this.collider.setMass(p.mass);
    else this.collider.setMassProperties(m, com, { x: ix, y: iy, z: iz }, { x: 0, y: 0, z: 0, w: 1 });
    // Real springs: the same rate in N/m whatever the load, so Rapier's per-unit-mass stiffness falls as the mass rises.
    const k = (p.suspension.stiffness * spring) / scale;
    const crit = 2 * Math.sqrt(p.suspension.stiffness);
    // Preload: at the reference weight a stiffer spring still sits at the factory ride height, and each spring is wound up
    // for its own share of the chassis' weight, so a nose-heavy car sits level (a load added later still squats it).
    const n = Math.max(1, this.wheelCount);
    const sag = 9.81 / (n * p.suspension.stiffness);
    // The dampers are tuned per wheel as a car's four are: past four they add up to more than a step can take (a rig's
    // twelve chattered off the ground at rest), so they share out what four would do.
    const many = Math.sqrt(4 / Math.max(4, n));
    for (let i = 0; i < this.wheelCount; i++) {
      const rest = p.suspension.rest - sag + (this.share0[i] * n * sag) / spring;
      this.restBase[i] = rest;
      this.ctl.setWheelSuspensionStiffness(i, k);
      this.ctl.setWheelSuspensionCompression(i, (0.83 * crit * many * Math.sqrt(spring)) / scale);
      this.ctl.setWheelSuspensionRelaxation(i, (0.88 * crit * many * Math.sqrt(spring)) / scale);
      this.ctl.setWheelSuspensionRestLength(i, rest + this.sink[i]);
      this.ctl.setWheelMaxSuspensionForce(i, m * 40);
    }
    this.body.wakeUp();
    this.vTopFor = null;
  }

  /** Signed forward speed in m/s. Computed from velocity: the controller's own value flips sign on two-wheelers. */
  get speed(): number {
    const lv = this.body.linvel();
    const f = this.forward();
    return lv.x * f[0] + lv.y * f[1] + lv.z * f[2];
  }

  get position() {
    return this.body.translation();
  }

  get yaw(): number {
    return yawFromQuat(this.body.rotation());
  }

  forward(): [number, number, number] {
    return rotateByQuat(this.body.rotation(), 0, 0, 1);
  }

  up(): [number, number, number] {
    return rotateByQuat(this.body.rotation(), 0, 1, 0);
  }

  /** World point from a local offset. */
  toWorld(lx: number, ly: number, lz: number): [number, number, number] {
    const t = this.body.translation();
    const [rx, ry, rz] = rotateByQuat(this.body.rotation(), lx, ly, lz);
    return [t.x + rx, t.y + ry, t.z + rz];
  }

  /** What it will do on the flat with this powertrain and this load (for the AI, the camera and the sound), m/s. */
  topSpeed(env: DriveEnv): number {
    return this.flatTop(env.drive ?? this.unit.pt) * Math.min(1, env.topSpeedMult) * (0.55 + 0.45 * Math.min(1, env.power));
  }

  private flatTop(pt: Powertrain): number {
    if (this.vTopFor !== pt) {
      this.vTopFor = pt;
      this.vTopNow = Math.max(4, topSpeed(pt, this.mass));
    }
    return this.vTopNow;
  }

  /** Apply driver intent and step the wheel model. Call once per fixed tick before the world step. */
  update(input: DriveInput, env: DriveEnv, dt: number) {
    const p = this.def.physics;
    const v = this.speed;
    const av = Math.abs(v);
    const on = env.engineOn;
    const pt = env.drive ?? this.unit.pt;
    if (this.unit.pt !== pt) this.unit.setPowertrain(pt);
    const feel = env.feel ?? this.feel0;
    if (feel !== this.feelNow) this.useFeel(feel);
    const assist = clamp(input.assist ?? 1, 0, 1);
    const bike = p.wheelCount === 2;
    this.slide = this.bodySlip();

    // Steering. Full stick asks the front tyres for the turn the speed allows on this ground plus about their peak slip
    // angle, and no more: full lock at speed only ploughs on (or spins a light car). Without the assist there is more to
    // play with past the peak, for whoever wants to steer the slide themselves.
    const lockMax = this.maxSteer * (env.steerMult ?? 1);
    const aLim = Math.max(2.5, this.muFront * 9.81);
    const kin = Math.atan((this.wheelbase * aLim) / Math.max(av * av, 1));
    const lock = Math.min(lockMax, kin + this.peakFront * (1.05 + 0.7 * (1 - assist)));
    const asked = -input.steer * lock;
    let target = asked;
    // Catching a slide: the hands steer toward where the car is going. A little for anyone, a lot with the arcade assist.
    if (av > 3) {
      const dz = Math.max(0.05, this.peakRear * 0.7);
      const over = Math.sign(this.slide) * Math.max(0, Math.abs(this.slide) - dz);
      target += over * (0.3 + 0.6 * assist) * smoothstep(3, 8, av);
    }
    target = clamp(target, -lockMax, lockMax);
    // The wheel comes back to centre faster than it goes over, so a tap on the stick is a nudge and not a lurch. How quick
    // it is at all is the chassis' and its steering wheel's.
    const returning = Math.abs(target) < Math.abs(this.steerAngle) || target * this.steerAngle < 0;
    this.steerAngle = damp(this.steerAngle, target, feel.steerRate * (returning ? 1.5 : 1), dt);
    // The turn the driver's own hands ask for (the assists' share left out), for stability control.
    this.yawTarget = clamp((v * Math.tan(asked)) / this.wheelbase, -aLim / Math.max(av, 1), aLim / Math.max(av, 1));

    // What the driver's feet ask of the engine and the brakes. The accelerator drives forward, or brakes while still rolling
    // back; the brake pedal brakes, or backs up once all but stopped.
    let thr = 0;
    let dir = 0;
    let pedal = 0;
    if (input.throttle > 0.01) {
      if (v < -1.2) pedal = input.throttle;
      else {
        thr = input.throttle;
        dir = 1;
      }
    } else if (input.brake > 0.01) {
      if (v > 1.2) pedal = input.brake;
      else {
        thr = input.brake;
        dir = -1;
      }
    }
    // A governor below 1 (the tether holding a leader back) eases off the throttle as it nears its share of top speed.
    if (dir > 0 && env.topSpeedMult < 1) {
      const vGov = this.flatTop(pt) * env.topSpeedMult;
      thr *= clamp((vGov - v) / (0.06 * vGov + 0.5), 0, 1);
    }
    const force = this.unit.step(dt, v, thr, dir, on, env.power * env.forceMult);
    // With nothing pressed it rolls to a stop: stalled in gear with the engine dead, held by the drag of the drivetrain at a
    // crawl with it running (above a crawl, engine braking, the tyres and the air do it). m/s^2.
    const crawl = thr <= 0 && pedal <= 0 ? (!on ? 2.2 : av < 2 ? 0.8 : 0) : 0;
    // The brakes: what the calipers can squeeze (sized for the reference weight: a heavier load stops slower), less as they
    // overheat. The tyres decide how much of it reaches the road.
    const fade = 1 - 0.45 * smoothstep(0.9, 2, this.brakeHeat);
    const brakeN = pedal > 0 ? p.brake * env.brakeMult * p.mass * pedal * fade : 0;

    for (let i = 0; i < this.wheelCount; i++) {
      this.ctl.setWheelSteering(i, this.steered[i] ? this.steerAngle : 0);
      this.ctl.setWheelMaxSuspensionTravel(i, p.suspension.travel * env.travelMult);
    }

    // Count grounded wheels and gather the average contact normal for the upright assist.
    let g = 0;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < this.wheelCount; i++) {
      if (this.ctl.wheelIsInContact(i)) {
        g++;
        const n = this.ctl.wheelContactNormal(i);
        if (n) {
          nx += n.x;
          ny += n.y;
          nz += n.z;
        }
      }
    }
    this.grounded = g;
    this.rideLoose(env);
    this.ctl.updateVehicle(dt, undefined, GROUPS.wheelRays);
    this.leanLoose(env, dt);
    this.tyreStep(input, env, feel, pt, force, brakeN, crawl, assist, dt);
    this.steady(input, feel, assist, av, dt);

    // The air pushes back on the speed squared, whatever the load (the tyres roll against their own loads in `tyreStep`).
    {
      const lv = this.body.linvel();
      const s2 = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z;
      if (s2 > 0.01) {
        const s = Math.sqrt(s2);
        // Never more than the speed it has: a resistance slows, it does not reverse.
        const dv = Math.min(s, ((pt.air * s2) / this.mass) * dt);
        const k = (-dv * this.mass) / s;
        this.body.applyImpulse({ x: lv.x * k, y: lv.y * k, z: lv.z * k }, true);
      }
      // A wing presses the back down as the speed rises.
      if (feel.downforce > 0 && g > 0) {
        const vf = this.speed;
        const back = this.axles[this.axles.length - 1];
        const lz = this.wheelLocal[back[0]][2];
        const dn = feel.downforce * vf * vf * dt;
        const up = this.up();
        this.body.applyImpulseAtPoint({ x: -up[0] * dn, y: -up[1] * dn, z: -up[2] * dn }, this.vec(...this.toWorld(0, 0, lz)), true);
      }
    }
    if (!bike) this.airControl(input, assist, g, dt);

    // Moped: upright PD torque about the roll axis keeps a two-wheeler balanced. Pitch stays free for jumps.
    if (p.uprightGain > 0) {
      const up = this.up();
      let tx = 0;
      let ty = 1;
      let tz = 0;
      if (g > 0) {
        const m = Math.hypot(nx, ny, nz) || 1;
        tx = nx / m;
        ty = ny / m;
        tz = nz / m;
        // Stay mostly vertical so slopes don't tip the rider.
        tx *= 0.5;
        tz *= 0.5;
        const mm = Math.hypot(tx, ty, tz) || 1;
        tx /= mm;
        ty /= mm;
        tz /= mm;
      }
      const f = this.forward();
      // rotation axis that carries `up` onto the target up, projected on the forward (roll) axis
      const cx = up[1] * tz - up[2] * ty;
      const cy = up[2] * tx - up[0] * tz;
      const cz = up[0] * ty - up[1] * tx;
      const rollErr = cx * f[0] + cy * f[1] + cz * f[2];
      const av3 = this.body.angvel();
      const rollRate = av3.x * f[0] + av3.y * f[1] + av3.z * f[2];
      const [hx, hy] = p.halfExtents;
      const inertia = (this.mass * ((2 * hx) ** 2 + (2 * hy) ** 2)) / 12 + this.rollExtra;
      const w2 = p.uprightGain;
      const kd = 2 * 0.9 * Math.sqrt(w2);
      const tq = inertia * (w2 * rollErr - kd * rollRate) * dt;
      this.body.applyTorqueImpulse({ x: f[0] * tq, y: f[1] * tq, z: f[2] * tq }, true);
    }

    // Flip recovery: after a few seconds on its roof, the crew rights the vehicle.
    const upY = this.up()[1];
    if (upY < 0.25 && av < 3) this.flipTimer += dt;
    else this.flipTimer = Math.max(0, this.flipTimer - dt * 2);
    if (this.flipTimer > 3) this.rightSelf();

    // Impact measurement: the velocity change this step beyond what engines can explain.
    const lv = this.body.linvel();
    const dvx = lv.x - this.prevVel.x;
    const dvy = lv.y - this.prevVel.y;
    const dvz = lv.z - this.prevVel.z;
    const horiz = Math.hypot(dvx, dvz);
    const vert = Math.abs(dvy) > 4 ? Math.abs(dvy) * 0.5 : 0;
    const dv = Math.max(horiz, vert);
    this.impact = dv > 2.2 ? dv : 0;
    if (this.impact > 0) {
      this.impactDirX = -dvx;
      this.impactDirZ = -dvz;
    }
    this.prevVel.x = lv.x;
    this.prevVel.y = lv.y;
    this.prevVel.z = lv.z;
    const w = this.body.angvel();
    this.shock[0] = dvx;
    this.shock[1] = dvy;
    this.shock[2] = dvz;
    this.shock[3] = w.x - this.prevSpin.x;
    this.shock[4] = w.y - this.prevSpin.y;
    this.shock[5] = w.z - this.prevSpin.z;
    this.prevSpin.x = w.x;
    this.prevSpin.y = w.y;
    this.prevSpin.z = w.z;
    this.spin[0] = w.x;
    this.spin[1] = w.y;
    this.spin[2] = w.z;
  }

  private vec(x: number, y: number, z: number) {
    const t = this.tmpV;
    t.x = x;
    t.y = y;
    t.z = z;
    return t;
  }

  /** Body slip from the velocity now: the angle from where it points to where it is going, + to the left. 0 at a crawl. */
  private bodySlip(): number {
    const lv = this.body.linvel();
    const f = this.forward();
    const up = this.up();
    const vf = lv.x * f[0] + lv.y * f[1] + lv.z * f[2];
    // Left is up x forward.
    const vl = lv.x * (up[1] * f[2] - up[2] * f[1]) + lv.y * (up[2] * f[0] - up[0] * f[2]) + lv.z * (up[0] * f[1] - up[1] * f[0]);
    if (vf * vf + vl * vl < 2.25) return 0;
    return Math.atan2(vl, Math.abs(vf));
  }

  /**
   * The tyres, once the springs have had their step. Each wheel on the ground: where it points on the ground's plane, how
   * fast its contact patch moves along and across that, the load its spring puts on it, and the ground and tyre it has.
   * It wants a sideways force from its slip angle (`lateralCurve`, the ground's and the tyre's shape) and a force along it
   * from the drive (shared out by the differentials), the brakes and rolling, and both come out of one budget of grip
   * (`saturation`): a wheel spinning or locked has little left to steer with, which is what makes a handbrake turn, a power
   * slide or a locked-up skid. A tyre never takes off more of its way in a step than it has, so it holds the car still on a
   * camber and never shakes at a crawl. The forces go in at the patch, raised toward the centre of mass by the chassis'
   * roll and pitch feel, so the body leans and dives as much as an arcade car should and no more.
   */
  private tyreStep(input: DriveInput, env: DriveEnv, feel: DriveFeel, pt: Powertrain, force: number, brakeN: number, crawl: number, assist: number, dt: number) {
    const n = this.wheelCount;
    const ctl = this.ctl;
    const q = this.body.rotation();
    const lv = this.body.linvel();
    const w = this.body.angvel();
    const com = this.body.worldCom();
    const [ux, uy, uz] = rotateByQuat(q, 0, 1, 0);
    const [cx, cy, cz] = rotateByQuat(q, 0, 0, 1);
    // The patches move with the body and its yaw. Its roll and pitch are the springs' business: each tyre's push below the
    // centre of mass kicks a little roll the springs take back the next step, and read here it would hide a slow slide.
    const yr = w.x * ux + w.y * uy + w.z * uz;
    const wx = ux * yr;
    const wy = uy * yr;
    const wz = uz * yr;
    let contacts = 0;
    let loads = 0;
    for (let i = 0; i < n; i++) {
      if (!ctl.wheelIsInContact(i)) continue;
      contacts++;
      loads += Math.max(0, ctl.wheelSuspensionForce(i) ?? 0);
    }
    const share = this.mass / Math.max(1, contacts);
    const kz = 1 - Math.exp(-dt / 0.05);
    const ks = 1 - Math.exp(-dt / 0.1);
    const sv = this.speed;
    // The electronics, and the arcade's softer feet: traction control keeps a tyre from spinning up (not while the driver
    // is sliding it on purpose), anti-lock keeps a braking tyre at its peak so it still steers.
    const tcArcade = input.handbrake ? 0 : assist * (1 - smoothstep(0.1, 0.25, Math.abs(this.slide)));
    const tc = Math.max(feel.tcs && !input.handbrake ? 1 : 0, tcArcade);
    const tcLim = 1.04 + 1.6 * (1 - tc);
    const absLim = 0.97 + 1.3 * (1 - (feel.abs ? 1 : assist * 0.85));

    // Pass 1: each tyre's geometry, load, ground and grip, and the sideways force its slip angle wants.
    let muF = 0;
    let nF = 0;
    let pkF = 0;
    let pkR = 0;
    let nR = 0;
    let looseSum = 0;
    let drivenCap = 0;
    for (let i = 0; i < n; i++) {
      const W = this.ws[i];
      W.on = false;
      this.gripUse[i] = 0;
      this.slipSide[i] = 0;
      this.wantD[i] = 0;
      const cp = ctl.wheelIsInContact(i) ? ctl.wheelContactPoint(i) : null;
      if (!cp) {
        this.fzS[i] -= this.fzS[i] * kz;
        this.wheelLoad[i] = 0;
        this.capX[i] = 0;
        continue;
      }
      W.on = true;
      const nr = ctl.wheelContactNormal(i) ?? { x: ux, y: uy, z: uz };
      const st = this.steered[i] ? this.steerAngle : 0;
      let [fx, fy, fz] = rotateByQuat(q, Math.sin(st), 0, Math.cos(st));
      const d = fx * nr.x + fy * nr.y + fz * nr.z;
      fx -= nr.x * d;
      fy -= nr.y * d;
      fz -= nr.z * d;
      const fm = Math.hypot(fx, fy, fz) || 1;
      fx /= fm;
      fy /= fm;
      fz /= fm;
      W.fx = fx;
      W.fy = fy;
      W.fz = fz;
      // Left is the ground's normal x forward.
      W.lx = nr.y * fz - nr.z * fy;
      W.ly = nr.z * fx - nr.x * fz;
      W.lz = nr.x * fy - nr.y * fx;
      W.px = cp.x;
      W.py = cp.y;
      W.pz = cp.z;
      const rx = cp.x - com.x;
      const ry = cp.y - com.y;
      const rz = cp.z - com.z;
      W.rx = rx;
      W.ry = ry;
      W.rz = rz;
      let vx = lv.x + wy * rz - wz * ry;
      let vy = lv.y + wz * rx - wx * rz;
      let vz = lv.z + wx * ry - wy * rx;
      W.vL = vx * fx + vy * fy + vz * fz;
      // A group of axles slips as one, read at its middle (see `groupDz`).
      const gd = this.groupDz[i];
      if (gd) {
        vx += (wy * cz - wz * cy) * gd;
        vy += (wz * cx - wx * cz) * gd;
        vz += (wx * cy - wy * cx) * gd;
      }
      const vS = vx * W.lx + vy * W.ly + vz * W.lz;
      // The load, smoothed over a few steps: a wheel skipping over a bump should not throw the grip about.
      const raw = Math.max(0, ctl.wheelSuspensionForce(i) ?? 0);
      const Fz = (this.fzS[i] += (raw - this.fzS[i]) * kz);
      this.wheelLoad[i] = Fz;
      W.load = Fz;
      const sf = env.surface ? env.surface(cp.x, cp.z) : NO_GROUND;
      const gname = groundName(sf.name);
      const kind = feel.tyres[i] ?? 'road';
      const flat = env.flats?.[i] ?? false;
      const pa = patchOf(kind, gname, flat, this.patch);
      // A tyre pressed harder grips more in all but less for each kilogram on it (against its own share at rest), so the
      // loaded outside wheels in a bend and an overloaded car grip a bit less than their weight would say.
      const ref = this.fzRef * n * this.share0[i];
      const ls = Fz > 1 ? clamp(Math.pow(Fz / ref, LOAD_SENS), 0.85, 1.12) : 1;
      const wear = 0.86 + 0.14 * clamp(env.wear?.[i] ?? 1, 0, 1);
      const k = sf.grip * env.grip * ls * wear * (flat ? 0.45 : 1) * (TYRE_FEEL[kind].bite[gname] / (this.bite[gname] || 1));
      W.capY = feel.grip * k * Fz;
      W.capX0 = pt.mu * k * Fz;
      W.slide = pa.slide;
      W.roll = pa.roll;
      W.loose = looseDrag(sf.drag, W.vL) * Fz;
      looseSum += W.loose;
      if ((feel.torque[i] ?? 0) > 0) drivenCap += W.capX0;
      // Sideways: what the slip angle asks for, never more than takes all the sideways way off this step (plus what gravity
      // adds along the camber). At a crawl the whole grip holds it, as static friction does.
      const vRef = Math.max(Math.abs(W.vL), SLIP_V0);
      const s = Math.abs(Math.atan(vS / vRef)) / pa.peak;
      const still = 1 - smoothstep(0.5, 3, Math.abs(W.vL) + Math.abs(vS));
      const lim = W.capY * Math.max(lateralCurve(s, pa.slide), still);
      // Gravity along a camber is held by each tyre in the share of the weight it carries, so the hold pulls through the
      // centre of mass and does not slowly turn a nose-heavy car where it stands.
      W.hold = loads > 1 ? (this.mass * raw) / loads : share;
      W.wantY = clamp(-share * ((RELAX * vS) / dt) + W.hold * 9.81 * W.ly, -lim, lim);
      this.slipSide[i] = Math.max(0, Math.abs(vS) - Math.tan(pa.peak) * vRef);
      // What is left of its grip along the wheel once it is pushing sideways.
      const used = W.capY > 0 ? Math.abs(W.wantY) / W.capY : 0;
      this.capX[i] = W.capX0 * Math.sqrt(Math.max(0.12, 1 - used * used));
      if (this.steered[i]) {
        muF += feel.grip * k;
        pkF += pa.peak;
        nF++;
      } else {
        pkR += pa.peak;
        nR++;
      }
    }
    if (nF) {
      this.muFront = muF / nF;
      this.peakFront = pkF / nF;
    }
    if (nR) this.peakRear = pkR / nR;

    // Pass 2: the drive, shared out by the differentials. An open diff gives both wheels of an axle the same, so the one
    // with less grip (lifted in a bend, on the sand) spins and the other only gets as much; a limited-slip diff sends the
    // gripping wheel a few times more; locked, each takes what it can hold. A four-wheel drive's centre passes what one axle
    // cannot use to the other. Traction control trims what any tyre is asked for to about what it holds.
    const sgn = force >= 0 ? 1 : -1;
    const absF = Math.abs(force);
    let tcCut = 0;
    if (absF > 0) {
      for (const ax of this.axles) {
        let ta = 0;
        for (const i of ax) ta += feel.torque[i] ?? 0;
        if (ta <= 0) continue;
        const fa = absF * ta;
        if (ax.length === 1) {
          this.wantD[ax[0]] = fa;
          continue;
        }
        if (ax.length === 2 && feel.diff !== 'locked') {
          const [i, j] = ax;
          const weak = this.capX[i] <= this.capX[j] ? i : j;
          const strong = weak === i ? j : i;
          const cw = this.capX[weak];
          if (feel.diff === 'lsd') {
            const dw = Math.min(fa / 2, cw);
            const ds = Math.min(fa - dw, Math.max(dw * 2.5, 0.3 * fa), Math.max(this.capX[strong], dw));
            this.wantD[strong] = ds;
            this.wantD[weak] = fa - ds;
          } else if (this.capX[strong] - cw < 0.03 * this.capX[strong] || cw >= fa / 2) {
            // Both alike (a straight launch), or enough grip for both: the same to each, and both spin together.
            this.wantD[i] = this.wantD[j] = fa / 2;
          } else {
            // The same torque to each side, so the wheel with grip only gets what the spinning one pushes back with.
            this.wantD[weak] = fa / 2;
            this.wantD[strong] = Math.min(fa / 2, cw * saturation(fa / 2 / Math.max(1, cw), this.ws[weak].slide));
          }
          continue;
        }
        let tot = 0;
        for (const i of ax) tot += this.capX[i];
        for (const i of ax) this.wantD[i] = tot > 0 ? (fa * this.capX[i]) / tot : fa / ax.length;
      }
      if (feel.layout === 'awd' && this.axles.length > 1) {
        let excess = 0;
        let spare = 0;
        for (let i = 0; i < n; i++) {
          if (!(feel.torque[i] > 0)) continue;
          excess += Math.max(0, this.wantD[i] - this.capX[i]);
          spare += Math.max(0, this.capX[i] - this.wantD[i]);
        }
        const mv = Math.min(excess * feel.centre, spare);
        if (mv > 0) {
          for (let i = 0; i < n; i++) {
            if (!(feel.torque[i] > 0)) continue;
            const ex = Math.max(0, this.wantD[i] - this.capX[i]);
            const sp = Math.max(0, this.capX[i] - this.wantD[i]);
            this.wantD[i] += (sp / spare) * mv - (excess > 0 ? (ex / excess) * mv : 0);
          }
        }
      }
      // Pulling (forward or in reverse), not engine braking.
      if (sgn * sv >= -0.5) {
        for (let i = 0; i < n; i++) {
          const lim = this.capX[i] * tcLim;
          if (this.ws[i].on && this.wantD[i] > lim) {
            tcCut += this.wantD[i] - lim;
            this.wantD[i] = lim;
          }
        }
      }
    }

    // Never quite bogged: however deep the sand, a crawling vehicle can always claw at it a little (there is no winch).
    const bog = looseSum > 0.8 * drivenCap && drivenCap > 0 ? (0.8 * drivenCap) / looseSum : 1;

    // Pass 3: brakes and rolling, the shared budget, and the push on the body.
    let nSteer = 0;
    for (let i = 0; i < n; i++) if (this.steered[i]) nSteer++;
    const nBack = n - nSteer;
    let jx = 0;
    let jy = 0;
    let jz = 0;
    let tx = 0;
    let ty = 0;
    let tz = 0;
    let put = 0;
    let heat = 0;
    let absCut = 0;
    let brakeAsk = 0;
    for (let i = 0; i < n; i++) {
      const W = this.ws[i];
      if (!W.on) {
        // In the air: a driven wheel spins up under the throttle, a braked one stops, the rest roll on.
        const want = input.handbrake && this.rear[i] ? -sv : brakeN > 0 ? -sv : this.driven[i] && absF > 0 ? sgn * 12 : 0;
        this.slipSpin[i] += (want - this.slipSpin[i]) * ks;
        this.wheelSpeed[i] = (sv + this.slipSpin[i]) / this.radii[i];
        continue;
      }
      const drive = sgn * this.wantD[i];
      let brk = 0;
      if (brakeN > 0) {
        brk = brakeN * (nBack === 0 ? 1 / n : this.steered[i] ? feel.bias / Math.max(1, nSteer) : (1 - feel.bias) / nBack);
        brakeAsk += brk;
        const lim = this.capX[i] * absLim;
        if (brk > lim) {
          absCut += brk - lim;
          brk = lim;
        }
      }
      // The handbrake locks the back wheels, past any anti-lock (a two-wheeler's back brake only drags its wheel to the edge).
      if (input.handbrake && this.rear[i]) brk += (n === 2 ? 0.8 : 1.8) * W.capX0;
      // Rolling, loose ground and the drivetrain's drag at a crawl resist the way it rolls; with the brakes they hold it on a
      // slope (never more than stops it: they slow, they do not reverse).
      const resist = (ROLL * W.roll + crawl / 9.81) * W.load + W.loose * bog + brk;
      const hold = -share * ((RELAX * W.vL) / dt) + W.hold * 9.81 * W.fy;
      let fxw = drive + clamp(hold, -resist, resist);
      let fyw = W.wantY;
      const u = Math.hypot(fxw / Math.max(1e-3, W.capX0), fyw / Math.max(1e-3, W.capY));
      let kk = 1;
      if (u > 1) {
        kk = saturation(u, W.slide) / u;
        fxw *= kk;
        fyw *= kk;
      }
      this.gripUse[i] = u;
      put += drive * kk;
      heat += brk * kk * Math.abs(W.vL);
      // How the wheel turns: with the road, faster when it spins up, slower to a stop when it locks.
      let spinT = 0;
      if (u > 1.02) {
        if (Math.abs(drive) >= brk) spinT = Math.sign(drive) * Math.min(30, 1 + (u - 1) * 14);
        else if (brk > 0 && Math.abs(W.vL) > 0.5) spinT = -W.vL * clamp((u - 1) * 2.5, 0, 1);
      }
      this.slipSpin[i] += (spinT - this.slipSpin[i]) * ks;
      this.wheelSpeed[i] = (W.vL + this.slipSpin[i]) / this.radii[i];
      const ax = W.fx * fxw * dt;
      const ay = W.fy * fxw * dt;
      const az = W.fz * fxw * dt;
      const bx = W.lx * fyw * dt;
      const by = W.ly * fyw * dt;
      const bz = W.lz * fyw * dt;
      jx += ax + bx;
      jy += ay + by;
      jz += az + bz;
      // Each force goes in at the patch, raised toward the centre of mass: sideways by the roll feel, along by the pitch.
      const h = W.rx * ux + W.ry * uy + W.rz * uz;
      const hl = h * (1 - feel.roll);
      const hp = h * (1 - feel.pitch);
      const lrx = W.rx - ux * hl;
      const lry = W.ry - uy * hl;
      const lrz = W.rz - uz * hl;
      const prx = W.rx - ux * hp;
      const pry = W.ry - uy * hp;
      const prz = W.rz - uz * hp;
      tx += lry * bz - lrz * by + pry * az - prz * ay;
      ty += lrz * bx - lrx * bz + prz * ax - prx * az;
      tz += lrx * by - lry * bx + prx * ay - pry * ax;
      // Whatever loose thing it stands on (a panel, a door, debris) is pushed the other way.
      const gb = ctl.wheelGroundObject(i)?.parent();
      if (gb && gb.isDynamic()) gb.applyImpulseAtPoint(this.vec(-(ax + bx), -(ay + by), -(az + bz)), { x: W.px, y: W.py, z: W.pz }, true);
    }
    // As forces rather than impulses: Rapier spreads them over the step as it spreads gravity, so a tyre holding a car on a
    // camber holds it where it is instead of a step ahead of gravity (a slow creep). Set afresh every step.
    this.body.resetForces(false);
    this.body.resetTorques(false);
    this.body.addForce(this.vec(jx / dt, jy / dt, jz / dt), true);
    this.body.addTorque(this.vec(tx / dt, ty / dt, tz / dt), true);
    const asked = force - sgn * tcCut;
    this.driveAsked = force;
    this.drivePut = put;
    this.unit.tyres(asked, put, dt);
    this.aids.tcs += ((absF > 1 && tcCut > 0.04 * absF ? 1 : 0) - this.aids.tcs) * ks;
    this.aids.abs += ((brakeAsk > 1 && absCut > 0.04 * brakeAsk ? 1 : 0) - this.aids.abs) * ks;
    // The brakes warm with every stop and cool as the air goes over them.
    this.brakeHeat += (heat * dt) / (feel.brakeKj * 1000);
    this.brakeHeat *= Math.exp(-dt * (0.025 + 0.003 * Math.abs(sv)));
  }

  /**
   * Keeping a slide a slide. Past a body slip the assist allows (more for a pro, more again under the handbrake) the
   * rotation that would carry it further is checked, so a spin is something the driver has to work at; and a car with
   * stability control brakes the tail back into line whenever it comes round faster than the steering asked.
   */
  private steady(input: DriveInput, feel: DriveFeel, assist: number, av: number, dt: number) {
    this.aids.esc = 0;
    if (this.grounded < 2 || av < 4) return;
    const b = this.bodySlip();
    const w = this.body.angvel();
    const up = this.up();
    const r = w.x * up[0] + w.y * up[1] + w.z * up[2];
    // Turning the nose further from where it is going.
    if (b * r >= 0) return;
    // A two-wheeler has far less slide in it before it goes down.
    const bMax = (this.wheelCount === 2 ? 0.3 : 0.55) + 0.6 * (1 - assist) + (input.handbrake ? 0.12 : 0);
    let k = 7 * smoothstep(0.6 * bMax, bMax, Math.abs(b));
    if (feel.esc && !input.handbrake && Math.abs(b) > 0.05) {
      const over = Math.abs(r) - (Math.abs(this.yawTarget) * 1.1 + 0.12);
      if (over > 0) {
        this.aids.esc = clamp(over * 3, 0, 1);
        k = Math.max(k, this.aids.esc * 5);
      }
    }
    if (k <= 0) return;
    const d = -r * Math.min(1, k * dt);
    this.body.setAngvel({ x: w.x + up[0] * d, y: w.y + up[1] * d, z: w.z + up[2] * d }, true);
  }

  /**
   * In the air: the throttle lifts the nose and the brake drops it (the wheels' spin kicks the body the other way), the
   * stick turns it a little, and it eases level on its roll. Enough to land a jump square, not to fly.
   */
  private airControl(input: DriveInput, assist: number, g: number, dt: number) {
    if (g > 0) {
      this.airT = 0;
      return;
    }
    this.airT += dt;
    if (this.airT < 0.15) return;
    const q = this.body.rotation();
    const left = rotateByQuat(q, 1, 0, 0);
    const up = rotateByQuat(q, 0, 1, 0);
    const fwd = rotateByQuat(q, 0, 0, 1);
    const w = this.body.angvel();
    const k = Math.min(1, 2.5 * dt) * (0.4 + 0.6 * assist);
    const dp = (-(input.throttle - input.brake) * 1.1 - (w.x * left[0] + w.y * left[1] + w.z * left[2])) * k;
    const dy = (-input.steer * 1.3 - (w.x * up[0] + w.y * up[1] + w.z * up[2])) * k;
    const dr = (-left[1] * 2.5 - (w.x * fwd[0] + w.y * fwd[1] + w.z * fwd[2])) * k;
    this.body.setAngvel(
      { x: w.x + left[0] * dp + up[0] * dy + fwd[0] * dr, y: w.y + left[1] * dp + up[1] * dy + fwd[1] * dr, z: w.z + left[2] * dp + up[2] * dy + fwd[2] * dr },
      true,
    );
  }

  /**
   * Loose ground: each wheel on it is cast against the collider under it, but rides the field's surface, which lies in a rut
   * or a crater below it and on a berm above it. Its suspension's rest length moves by the difference, so the spring holds
   * the chassis as high over the field as it would over firm ground, and the wheel is drawn down in the rut. Eased a couple
   * of centimetres a step, so a wheel dropping into a hole does not slam.
   */
  private rideLoose(env: DriveEnv) {
    const ground = env.ground;
    let yaw = 0;
    if (ground) yaw = this.yaw;
    for (let i = 0; i < this.wheelCount; i++) {
      let target = 0;
      this.slopeX[i] = this.slopeZ[i] = 0;
      if (ground) {
        // Where the tyre touches; in the air, under its hub (so a wheel over a hole keeps reaching for its floor).
        let x: number;
        let z: number;
        const cp = this.ctl.wheelIsInContact(i) ? this.ctl.wheelContactPoint(i) : null;
        if (cp) {
          x = cp.x;
          z = cp.z;
        } else {
          const [lx, ly, lz] = this.wheelLocal[i];
          [x, , z] = this.toWorld(lx, ly, lz);
        }
        const wy = yaw + (this.steered[i] ? this.steerAngle : 0);
        ground(i, x, z, Math.sin(wy), Math.cos(wy), this.soft);
        target = clamp(this.soft.h, -0.6 * this.radii[i], 0.25);
        if (cp) {
          this.slopeX[i] = clamp(this.soft.gx, -0.6, 0.6);
          this.slopeZ[i] = clamp(this.soft.gz, -0.6, 0.6);
        }
      }
      const was = this.sink[i];
      const now = was + clamp(target - was, -0.02, 0.02);
      if (now === was) continue;
      this.sink[i] = now;
      this.ctl.setWheelSuspensionRestLength(i, this.restBase[i] + now);
    }
  }

  /** The walls of a rut or a hole lean on a wheel standing against them: its load, pushed down the field's slope. */
  private leanLoose(env: DriveEnv, dt: number) {
    if (!env.ground) return;
    for (let i = 0; i < this.wheelCount; i++) {
      const gx = this.slopeX[i];
      const gz = this.slopeZ[i];
      if ((gx === 0 && gz === 0) || !this.ctl.wheelIsInContact(i)) continue;
      const W = Math.max(0, this.ctl.wheelSuspensionForce(i) ?? 0);
      const cp = this.ctl.wheelContactPoint(i);
      if (!cp || W <= 0) continue;
      this.body.applyImpulseAtPoint({ x: -W * gx * dt, y: 0, z: -W * gz * dt }, cp, true);
    }
  }

  /** How far the loose ground has moved wheel `i` down (+) into a rut or a crater, m. */
  wheelSink(i: number): number {
    return -this.sink[i];
  }

  /**
   * Where the chassis is being pressed right now, from Rapier's narrow phase: the real contact points, in the vehicle's
   * frame, with the impulse at each. Contacts under the car (the ground carrying it) are left out.
   */
  contacts(out: Contact[] = []): Contact[] {
    out.length = 0;
    const w = this.P.world;
    const mine = this.collider.handle;
    w.narrowPhase.contactPairsWith(mine, (h2) => {
      w.narrowPhase.contactPair(mine, h2, w.bodies, (m, flipped) => {
        const n = flipped ? m.localNormal2() : m.localNormal1();
        // The normal points from shape 1 to shape 2: flipped data describes the pair the other way round.
        const sgn = flipped ? -1 : 1;
        if (n.y * sgn < -0.65) return;
        for (let i = 0; i < m.numContacts(); i++) {
          if (m.contactDist(i) > 0.03) continue;
          const p = flipped ? m.localContactPoint2(i) : m.localContactPoint1(i);
          if (!p) continue;
          out.push({ x: p.x, y: p.y, z: p.z, nx: n.x * sgn, ny: n.y * sgn, nz: n.z * sgn, impulse: m.contactImpulse(i), other: h2 });
        }
      });
    });
    return out;
  }

  /** Forget the loose ground under the wheels (a teleport, a recovery): they find it again on the next steps. */
  private clearSink() {
    for (let i = 0; i < this.wheelCount; i++) {
      if (this.sink[i] === 0) continue;
      this.sink[i] = 0;
      this.ctl.setWheelSuspensionRestLength(i, this.restBase[i]);
    }
  }

  rightSelf() {
    this.clearSink();
    this.body.resetForces(false);
    this.body.resetTorques(false);
    const t = this.body.translation();
    const yaw = this.yaw;
    this.body.setTranslation({ x: t.x, y: t.y + 1.4, z: t.z }, true);
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.prevVel = { x: 0, y: 0, z: 0 };
    this.prevSpin = { x: 0, y: 0, z: 0 };
    this.flipTimer = 0;
  }

  setPose(x: number, y: number, z: number, yaw: number) {
    this.clearSink();
    this.body.resetForces(false);
    this.body.resetTorques(false);
    this.body.setTranslation({ x, y, z }, true);
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.prevVel = { x: 0, y: 0, z: 0 };
    this.prevSpin = { x: 0, y: 0, z: 0 };
  }

  /** Push horizontally (knockback, ram). */
  shove(ix: number, iz: number) {
    this.body.applyImpulse({ x: ix, y: 0, z: iz }, true);
  }

  /** Suspension length as drawn: down to the loose ground's surface (in its rut, up on a berm), not the collider under it. */
  wheelSusp(i: number) {
    return (this.ctl.wheelSuspensionLength(i) ?? this.restBase[i]) - this.sink[i];
  }

  destroy() {
    this.P.world.removeCollider(this.collider, false);
    this.P.world.removeRigidBody(this.body);
  }
}
