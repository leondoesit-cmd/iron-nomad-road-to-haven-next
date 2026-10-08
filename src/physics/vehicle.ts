import { RAPIER, GROUPS, type PhysicsWorld, type RigidBody, type Collider } from './physics';
import { wheelLayout, type VehicleDef } from '../data';
import { clamp, damp } from '../core/math';
import { BODY_DAMPING, DriveUnit, stockPowertrain, topSpeed, type Powertrain } from '../sim/powertrain';

export interface DriveInput {
  /** -1 (left) .. 1 (right). */
  steer: number;
  throttle: number;
  brake: number;
  handbrake: boolean;
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
  /** Surface lookup under a wheel contact. */
  surface?: (x: number, z: number) => { grip: number; drag: number };
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

/** The brakes are sized with this much in hand over what the tyres can use at the reference weight. */
const BRAKE_HEADROOM = 1.25;
/** Tyre load sensitivity: grip per unit load falls as the load on a tyre rises (exponent on load over reference). */
const LOAD_SENS = -0.15;

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
  /** The sideways push (m/s per step) that keeps a stopped vehicle from sliding down a camber, learnt while it stands. */
  private holdLat = 0;
  /** This step's change of velocity (world, m/s) then of spin (world, rad/s): what the bolted-on parts feel. */
  shock = [0, 0, 0, 0, 0, 0];
  /** Spin right now (world, rad/s). */
  spin: [number, number, number] = [0, 0, 0];
  grounded = 0;
  flipTimer = 0;
  private tmpV = { x: 0, y: 0, z: 0 };
  private baseSlip: number;
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
  /** Each wheel's load (smoothed, N) and what its tyre can put down this step (N). */
  private fzS: Float64Array;
  private capW: Float64Array;
  /** Drive force asked for and put down this step, N, for tests and the HUD. */
  driveAsked = 0;
  drivePut = 0;

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
    this.baseSlip = p.frictionSlip;

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
      this.ctl.setWheelFrictionSlip(i, p.frictionSlip);
      this.ctl.setWheelSideFrictionStiffness(i, p.sideFriction);
      const crit = 2 * Math.sqrt(p.suspension.stiffness);
      this.ctl.setWheelSuspensionCompression(i, 0.83 * crit);
      this.ctl.setWheelSuspensionRelaxation(i, 0.88 * crit);
      this.ctl.setWheelMaxSuspensionForce(i, p.mass * 40);
    }
    this.fzRef = (p.mass * 9.81) / Math.max(1, this.wheelCount);
    this.fzS = new Float64Array(this.wheelCount).fill(this.fzRef);
    this.capW = new Float64Array(this.wheelCount);
    this.unit = new DriveUnit(stockPowertrain(def));
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
    if (Math.abs(scale - 1) < 0.002 && Math.abs(l.com.x) + Math.abs(l.com.y) + Math.abs(l.com.z) < 0.003 && !(ex.x + ex.y + ex.z)) this.collider.setMass(p.mass);
    else this.collider.setMassProperties(m, l.com, { x: ix, y: iy, z: iz }, { x: 0, y: 0, z: 0, w: 1 });
    // Real springs: the same rate in N/m whatever the load, so Rapier's per-unit-mass stiffness falls as the mass rises.
    const k = (p.suspension.stiffness * spring) / scale;
    const crit = 2 * Math.sqrt(p.suspension.stiffness);
    // Preload: at the reference weight a stiffer spring still sits at the factory ride height.
    const sag = 9.81 / (Math.max(1, this.wheelCount) * p.suspension.stiffness);
    const rest = p.suspension.rest - sag + sag / spring;
    for (let i = 0; i < this.wheelCount; i++) {
      this.ctl.setWheelSuspensionStiffness(i, k);
      this.ctl.setWheelSuspensionCompression(i, (0.83 * crit * Math.sqrt(spring)) / scale);
      this.ctl.setWheelSuspensionRelaxation(i, (0.88 * crit * Math.sqrt(spring)) / scale);
      this.ctl.setWheelSuspensionRestLength(i, rest);
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

    // Speed-sensitive steering: the lock is capped so the requested lateral acceleration stays inside what the
    // tyres can hold. Full lock at speed is what spins a vehicle out.
    const aLat = (p.wheelCount === 2 ? 17 : 14.5) * clamp(env.grip, 0.4, 1.2);
    const gripLock = Math.atan((this.wheelbase * aLat) / Math.max(av * av, 9));
    const lock = Math.min(this.maxSteer * (env.steerMult ?? 1), gripLock);
    const target = -input.steer * lock;
    // The wheel comes back to centre faster than it goes over, so a tap on the stick is a nudge and not a lurch.
    const returning = Math.abs(target) < Math.abs(this.steerAngle) || target * this.steerAngle < 0;
    this.steerAngle = damp(this.steerAngle, target, (p.wheelCount === 2 ? 11 : 9) * (returning ? 1.5 : 1), dt);
    // Positive wheel angle turns left (yaw increases), so the target yaw rate has the same sign.
    this.yawTarget = (this.speed * Math.tan(this.steerAngle)) / this.wheelbase;
    // Handbrake with the wheel over: the stability assist is told to want a much tighter turn, so the tail comes round
    // quickly and the yaw cap below is what keeps it a slide rather than a spin.
    if (input.handbrake && p.wheelCount !== 2) this.yawTarget *= 2.1;

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
    // crawl with it running (above a crawl, engine braking, the tyres and the air do it).
    let decel = thr <= 0 && pedal <= 0 ? (!on ? 2.2 : av < 2 ? 0.8 : 0) : 0;
    const handbrake = input.handbrake;
    if (handbrake) decel += 5;

    let gripSum = 0;
    let gripN = 0;
    let capSum = 0;
    const kz = 1 - Math.exp(-dt / 0.08);
    for (let i = 0; i < this.wheelCount; i++) {
      const flat = env.flats?.[i] ?? false;
      const contact = this.ctl.wheelIsInContact(i);
      this.ctl.setWheelSteering(i, this.steered[i] ? this.steerAngle : 0);
      this.ctl.setWheelBrake(i, 0);

      // Per-wheel surface grip from the previous contact point, and the tyre's load sensitivity: a tyre pressed harder
      // grips more in all, but less for each kilogram on it, so a loaded car (and the outside wheels in a bend) grip a bit less.
      // The load is smoothed over a few steps: a wheel skipping over a bump should not throw the drive about.
      let sg = 1;
      if (env.surface && contact) {
        const cp = this.ctl.wheelContactPoint(i);
        if (cp) sg = env.surface(cp.x, cp.z).grip;
      }
      const raw = contact ? Math.max(0, this.ctl.wheelSuspensionForce(i) ?? 0) : 0;
      const fz = (this.fzS[i] += (raw - this.fzS[i]) * kz);
      const ls = fz > 1 ? clamp(Math.pow(fz / this.fzRef, LOAD_SENS), 0.85, 1.12) : 1;
      const tyre = sg * ls * (flat ? 0.45 : 1);
      if (contact) {
        gripSum += Math.min(1, sg) * ls * (flat ? 0.45 : 1);
        gripN++;
      }
      // What this wheel's tyre can put down: nothing in the air.
      const cap = this.driven[i] && contact ? pt.mu * env.grip * tyre * fz : 0;
      this.capW[i] = cap;
      capSum += cap;
      let slip = this.baseSlip * env.grip * tyre;
      if (handbrake && this.rear[i]) slip *= 0.55; // lets the tail step out
      this.ctl.setWheelFrictionSlip(i, slip);
      this.ctl.setWheelMaxSuspensionTravel(i, p.suspension.travel * env.travelMult);
    }
    // The drive goes where the grip is (the diffs and the driver's foot see to that): each driven wheel takes its share of
    // what the tyres can hold, and whatever is asked beyond that spins them.
    const put = clamp(force, -capSum, capSum);
    for (let i = 0; i < this.wheelCount; i++) this.ctl.setWheelEngineForce(i, capSum > 0 ? (put * this.capW[i]) / capSum : 0);
    this.driveAsked = force;
    this.drivePut = put;
    this.unit.tyres(force, put, dt);
    // Brakes: a force the calipers can make (sized for the reference weight), and no more than the tyres can hold. Heavier,
    // the same brakes slow it less; on loose ground, or on a flat, the tyres give up first.
    if (pedal > 0) {
      const tyre = gripN ? gripSum / gripN : 1;
      const caliper = (p.brake * env.brakeMult * BRAKE_HEADROOM * p.mass) / this.mass;
      const hold = p.brake * clamp(env.grip, 0.3, 1.25) * tyre;
      decel += Math.min(caliper, hold) * pedal;
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
    this.ctl.updateVehicle(dt, undefined, GROUPS.wheelRays);

    // Stability assist: nudge the yaw rate toward what the steering asked for, so a slide is caught rather than amplified.
    if (g >= 2 && av > 4 && p.wheelCount !== 2) {
      const w = this.body.angvel();
      const up = this.up();
      const yawRate = w.x * up[0] + w.y * up[1] + w.z * up[2];
      const k = clamp(this.yawTarget - yawRate, -3, 3) * Math.min(1, 5 * dt) * 0.55;
      this.body.setAngvel({ x: w.x + up[0] * k, y: w.y + up[1] * k, z: w.z + up[2] * k }, true);
    }

    // Drift control. The handbrake lets the tail step out, but a slide should be something the driver steers, not a
    // spin that happens to them: the yaw rate is capped, sideways speed bleeds off (slowly under the handbrake, quickly
    // once it is released) and the car swings back to where it is going.
    if (g >= 2 && av > 2) {
      const f = this.forward();
      const up = this.up();
      const lv0 = this.body.linvel();
      // Sideways direction on the ground: up x forward.
      const sx = up[1] * f[2] - up[2] * f[1];
      const sy = up[2] * f[0] - up[0] * f[2];
      const sz = up[0] * f[1] - up[1] * f[0];
      const lat = lv0.x * sx + lv0.y * sy + lv0.z * sz;
      const k = (input.handbrake ? 0.5 : 3.2) * (g / this.wheelCount);
      const dLat = lat * (Math.exp(-k * dt) - 1);
      this.body.applyImpulse({ x: sx * dLat * this.mass, y: sy * dLat * this.mass, z: sz * dLat * this.mass }, true);
      const w = this.body.angvel();
      const yawRate = w.x * up[0] + w.y * up[1] + w.z * up[2];
      const cap = Math.max((p.wheelCount === 2 ? 1.9 : 1.7) * (input.handbrake ? 1 : 0.8), Math.abs(this.yawTarget) * 1.1);
      if (Math.abs(yawRate) > cap) {
        const d = (Math.sign(yawRate) * cap - yawRate) * Math.min(1, 40 * dt);
        this.body.setAngvel({ x: w.x + up[0] * d, y: w.y + up[1] * d, z: w.z + up[2] * d }, true);
      }
    }

    // Standing still, a tyre grips sideways (static friction) on any slope it can hold: the wheel model alone lets a stopped
    // vehicle slide slowly down the crown of a road or a gentle slope, a few millimetres a second. So the sideways way it
    // has is taken off, plus a hold that learns, step by step, the push that keeps it from coming back. Only when it is all
    // but stopped, not turning and barely sliding, so slow manoeuvres keep their feel and a real shove still moves it.
    let holding = false;
    if (g >= 2 && av < 0.5) {
      const up = this.up();
      const w = this.body.angvel();
      const f = this.forward();
      const lv0 = this.body.linvel();
      const sx = up[1] * f[2] - up[2] * f[1];
      const sy = up[2] * f[0] - up[0] * f[2];
      const sz = up[0] * f[1] - up[1] * f[0];
      const lat = lv0.x * sx + lv0.y * sy + lv0.z * sz;
      if (Math.abs(lat) < 0.15 && Math.abs(up[1]) > 0.94 && Math.abs(w.x * up[0] + w.y * up[1] + w.z * up[2]) < 0.05) {
        this.holdLat = clamp(this.holdLat - lat, -0.05, 0.05);
        const dLat = -lat + this.holdLat;
        this.body.applyImpulse({ x: sx * dLat * this.mass, y: sy * dLat * this.mass, z: sz * dLat * this.mass }, true);
        holding = true;
      }
    }
    if (!holding) this.holdLat = 0;

    // Braking is a controlled deceleration along the direction of travel, scaled by how many wheels are down.
    if (decel > 0 && g > 0) {
      const vf = this.speed;
      const dv = Math.min(Math.abs(vf), decel * dt * (g / this.wheelCount));
      if (dv > 0) {
        const f = this.forward();
        const k = -Math.sign(vf) * dv * this.mass;
        this.body.applyImpulse({ x: f[0] * k, y: f[1] * k, z: f[2] * k }, true);
      }
    }

    // The air pushes back on the speed squared, whatever the load; the tyres roll against a share of the weight they carry.
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
      const vf = this.speed;
      if (g > 0 && Math.abs(vf) > 0.3) {
        const dv = Math.min(Math.abs(vf), pt.roll * 9.81 * dt * (g / this.wheelCount));
        const f = this.forward();
        const k = -Math.sign(vf) * dv * this.mass;
        this.body.applyImpulse({ x: f[0] * k, y: f[1] * k, z: f[2] * k }, true);
      }
    }

    // Drag from soft surfaces (sand, mud) slows the whole body.
    if (env.surface && g > 0) {
      const t = this.body.translation();
      const s = env.surface(t.x, t.z);
      if (s.drag > 0) {
        const lv = this.body.linvel();
        const k = Math.exp(-s.drag * dt * 1.2);
        this.body.setLinvel({ x: lv.x * k, y: lv.y, z: lv.z * k }, true);
      }
    }

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

  rightSelf() {
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

  wheelSusp(i: number) {
    return this.ctl.wheelSuspensionLength(i) ?? this.def.physics.suspension.rest;
  }

  destroy() {
    this.P.world.removeCollider(this.collider, false);
    this.P.world.removeRigidBody(this.body);
  }
}
