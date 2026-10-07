import { RAPIER, GROUPS, type PhysicsWorld, type RigidBody, type Collider } from './physics';
import { rotateByQuat, yawFromQuat, type DriveEnv, type DriveInput } from './vehicle';
import type { VehicleDef } from '../data';
import { clamp, damp } from '../core/math';

/**
 * What the Vehicle class needs from whatever carries it: a Rapier body, a pose, a speed and an update. The wheeled
 * `VehicleBody` and the floating `BoatBody` both provide it.
 */
export interface Chassis {
  body: RigidBody;
  collider: Collider;
  wheelCount: number;
  steered: boolean[];
  wheelLocal: [number, number, number][];
  steerAngle: number;
  impact: number;
  impactDirX: number;
  impactDirZ: number;
  grounded: number;
  readonly mass: number;
  readonly speed: number;
  readonly yaw: number;
  readonly position: { x: number; y: number; z: number };
  forward(): [number, number, number];
  up(): [number, number, number];
  toWorld(lx: number, ly: number, lz: number): [number, number, number];
  topSpeed(env: DriveEnv): number;
  update(input: DriveInput, env: DriveEnv, dt: number): void;
  setPose(x: number, y: number, z: number, yaw: number): void;
  shove(ix: number, iz: number): void;
  wheelSusp(i: number): number;
  destroy(): void;
}

/**
 * Water at a point: the surface height, how deep it is over the floor and which way it runs (m/s), or null on dry land.
 * `kind` tells a lake's gentle drift to shore from a river's current.
 */
export type WaterQuery = (x: number, z: number) => { level: number; depth: number; flow?: [number, number]; kind?: string } | null;

/** A lake's drift is a direction more than a speed: a boat feels only this much of it. */
const LAKE_DRIFT = 0.12;

const G = 9.81;

/**
 * Gentle surface motion, shared by the hull and the wake effects so a boat rides the same swell it seems to. The water is
 * drawn as a flat sheet (its swell is in the shading), so this stays a few centimetres: any more and a hull is seen to lift
 * clear of the sheet on a crest and settle under it in a trough.
 */
export function swell(x: number, z: number, t: number): number {
  return 0.016 * Math.sin(x * 0.33 + t * 1.25) + 0.012 * Math.sin(z * 0.47 - t * 1.6) + 0.007 * Math.sin((x + z) * 0.9 + t * 2.4);
}

/**
 * A hull that floats. Six points along the bottom each push up in proportion to how far under the surface they are
 * (so the boat finds its own trim, rolls and pitches over swell and heels when thrown about), water drag bleeds off
 * forward speed and a great deal of sideways speed, and the engine pushes along the keel at the stern: an outboard
 * only works with its propeller under water, an airboat's fan does not care. Aground it is just a box on the sand.
 * The drag is against the water, not the ground, so a boat left to itself on a river goes downstream with it, and
 * over a waterfall if nobody opens the throttle.
 */
export class BoatBody implements Chassis {
  body: RigidBody;
  collider: Collider;
  wheelCount = 0;
  steered: boolean[] = [];
  wheelLocal: [number, number, number][] = [];
  steerAngle = 0;
  impact = 0;
  impactDirX = 0;
  impactDirZ = 0;
  grounded = 0;
  readonly mass: number;
  /** 0..1: how much of the hull is in the water right now. */
  submerged = 0;
  /** True while the propeller (or fan) is biting. */
  driving = false;
  private t = 0;
  private prevVel = { x: 0, y: 0, z: 0 };
  private pts: [number, number, number][] = [];
  private flip = 0;
  private readonly hx: number;
  private readonly hy: number;
  private readonly hz: number;

  constructor(
    private P: PhysicsWorld,
    public def: VehicleDef,
    x: number,
    y: number,
    z: number,
    yaw: number,
    private water: WaterQuery,
  ) {
    const p = def.physics;
    this.mass = p.mass;
    [this.hx, this.hy, this.hz] = p.halfExtents;
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
      .setLinearDamping(0.02)
      .setAngularDamping(1.0)
      .setCanSleep(false);
    this.body = P.world.createRigidBody(desc);
    this.collider = P.world.createCollider(
      RAPIER.ColliderDesc.cuboid(this.hx, this.hy, this.hz).setMass(p.mass).setFriction(0.35).setRestitution(0.05).setCollisionGroups(GROUPS.vehicle),
      this.body,
    );
    // Bottom corners, amidships and the bow and stern pair: enough points to float level on a short boat. They are on the
    // keel, so at rest the keel sits exactly `draft` under the surface (and the drawn hull with it).
    for (const sx of [-0.8, 0.8]) for (const sz of [-0.85, 0, 0.85]) this.pts.push([sx * this.hx, -this.hy, sz * this.hz]);
  }

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
  toWorld(lx: number, ly: number, lz: number): [number, number, number] {
    const t = this.body.translation();
    const [rx, ry, rz] = rotateByQuat(this.body.rotation(), lx, ly, lz);
    return [t.x + rx, t.y + ry, t.z + rz];
  }
  topSpeed(env: DriveEnv): number {
    return (this.def.topSpeedKmh / 3.6) * env.topSpeedMult * (0.55 + 0.45 * Math.min(1, env.power));
  }
  wheelSusp() {
    return 0;
  }

  update(input: DriveInput, env: DriveEnv, dt: number) {
    const bp = this.def.physics.boat!;
    this.t += dt;
    const pos = this.body.translation();
    const rot = this.body.rotation();
    const lv = this.body.linvel();
    const av = this.body.angvel();
    const up = this.up();
    const n = this.pts.length;
    const kPer = (this.mass * G) / (n * bp.draft);
    const mPer = this.mass / n;
    const cPer = 2 * 0.55 * Math.sqrt(kPer * mPer);
    let wet = 0;
    let stern = 0;
    // Buoyancy at each point.
    for (let i = 0; i < n; i++) {
      const [lx, ly, lz] = this.pts[i];
      const [rx, ry, rz] = rotateByQuat(rot, lx, ly, lz);
      const px = pos.x + rx;
      const py = pos.y + ry;
      const pz = pos.z + rz;
      const w = this.water(px, pz);
      if (!w) continue;
      const s = w.level + swell(px, pz, this.t) - py;
      if (s <= 0) continue;
      const sc = Math.min(s, 1.0);
      // Point velocity: the body's plus its spin about the centre.
      const vy = lv.y + (av.z * rx - av.x * rz);
      const f = Math.max(0, kPer * sc - cPer * vy);
      this.body.applyImpulseAtPoint({ x: 0, y: f * dt, z: 0 }, { x: px, y: py, z: pz }, true);
      wet += Math.min(1.5, sc / bp.draft) / n;
      if (lz < 0) stern += Math.min(1, sc / (bp.draft * 0.8)) / 2;
    }
    this.submerged = clamp(wet, 0, 1);
    const sub = this.submerged;

    // Horizontal axes of the hull.
    let fx = rotateByQuat(rot, 0, 0, 1)[0];
    let fz = rotateByQuat(rot, 0, 0, 1)[2];
    const fm = Math.hypot(fx, fz) || 1;
    fx /= fm;
    fz /= fm;
    const rxn = fz;
    const rzn = -fx;
    let vf = lv.x * fx + lv.z * fz;

    // Engine: along the keel, strongest with the throttle down and the propeller in the water.
    const on = env.engineOn;
    const vmax = this.topSpeed(env);
    // A fan pushes on air, so an airboat keeps some way on over mud and sand; a propeller needs water round it.
    const bite = bp.air ? (on ? 0.3 + 0.7 * sub : 0) : on ? clamp(stern * 2.2, 0, 1) : 0;
    this.driving = bite > 0.3 && input.throttle > 0.05;
    let force = 0;
    const taper = (s: number, m: number) => clamp(1 - Math.pow(s / m, 2.2), 0, 1);
    if (input.throttle > 0.01) {
      force = this.def.physics.engineForce * env.forceMult * env.power * input.throttle * taper(Math.max(0, vf), vmax) * bite;
    } else if (input.brake > 0.01) {
      // Brake, then reverse.
      if (vf > 0.8) force = -this.def.physics.engineForce * 0.5 * input.brake * Math.max(sub, 0.4);
      else force = -this.def.physics.engineForce * 0.42 * input.brake * taper(Math.max(0, -vf), Math.max(3, vmax * 0.3)) * bite;
    }
    if (force !== 0) this.body.applyImpulseAtPoint({ x: fx * force * dt, y: 0, z: fz * force * dt }, { x: pos.x, y: pos.y, z: pos.z }, true);
    // Beached: the crew heave her toward open water. Sand would beat the engine, so the push sets the way directly,
    // and only toward water that is close; it is a shove off the shore, not a way to cross land.
    if (sub < 0.35 && on) {
      const dir = input.throttle > 0.05 ? 1 : input.brake > 0.05 ? -1 : 0;
      if (dir !== 0 && this.water(pos.x + fx * dir * 9, pos.z + fz * dir * 9)) {
        const c2 = this.body.linvel();
        const dv = clamp(dir * 2.4 - (c2.x * fx + c2.z * fz), -12 * dt, 12 * dt);
        if (dv * dir > 0) this.body.setLinvel({ x: c2.x + fx * dv, y: c2.y, z: c2.z + fz * dv }, true);
      }
    }

    // Water drag: a little along the keel, a lot across it, against the water's own movement. Velocity is read again
    // here: the impulses above changed it.
    const cv = this.body.linvel();
    const wc = sub > 0.02 ? this.water(pos.x, pos.z) : null;
    const k = wc?.flow ? (wc.kind === 'lake' ? LAKE_DRIFT : 1) : 0;
    const ux = k ? wc!.flow![0] * k : 0;
    const uz = k ? wc!.flow![1] * k : 0;
    vf = (cv.x - ux) * fx + (cv.z - uz) * fz;
    const vl2 = (cv.x - ux) * rxn + (cv.z - uz) * rzn;
    if (sub > 0.02) {
      const nf = vf * Math.exp(-(bp.forwardDrag + bp.quadDrag * Math.abs(vf)) * dt * sub);
      const nl = vl2 * Math.exp(-bp.lateralDrag * dt * sub);
      this.body.setLinvel({ x: cv.x + (nf - vf) * fx + (nl - vl2) * rxn, y: cv.y, z: cv.z + (nf - vf) * fz + (nl - vl2) * rzn }, true);
      vf = nf;
    } else {
      // Dragged over sand and mud.
      const k = Math.exp(-1.4 * dt);
      this.body.setLinvel({ x: cv.x * k, y: cv.y, z: cv.z * k }, true);
    }

    // Steering: the rudder bites with way on or prop wash, so a boat will turn on the spot with the throttle open.
    const speedK = clamp(Math.abs(vf) / 5, 0, 1);
    const authority = clamp(0.3 + speedK * 0.85 + Math.abs(input.throttle) * 0.35, 0, 1.25) * Math.max(clamp(sub * 1.6, 0, 1), on && (input.throttle > 0.05 || input.brake > 0.05) ? 0.3 : 0) * (bp.air ? clamp(0.4 + speedK, 0, 1.1) : 1);
    const target = -input.steer * bp.yawRate * authority * (vf < -0.6 ? -1 : 1);
    this.steerAngle = damp(this.steerAngle, -input.steer * 0.5, 6, dt);
    const av2 = this.body.angvel();
    let ay = av2.y + (target - av2.y) * Math.min(1, 3.4 * dt);
    // Water damps the roll and pitch, and the yaw a little.
    const dk = Math.exp(-2.4 * dt * sub);
    ay *= Math.exp(-0.35 * dt * sub);
    this.body.setAngvel({ x: av2.x * dk, y: ay, z: av2.z * dk }, true);

    // A capsized boat rights itself after a few seconds (the crew heave it back).
    if (up[1] < 0.2) this.flip += dt;
    else this.flip = Math.max(0, this.flip - dt * 2);
    if (this.flip > 3) this.rightSelf();

    // Impact: the velocity change this step beyond what the engine explains.
    const lv2 = this.body.linvel();
    const dvx = lv2.x - this.prevVel.x;
    const dvz = lv2.z - this.prevVel.z;
    const horiz = Math.hypot(dvx, dvz);
    this.impact = horiz > 2.4 ? horiz : 0;
    if (this.impact > 0) {
      this.impactDirX = -dvx;
      this.impactDirZ = -dvz;
    }
    this.prevVel = { x: lv2.x, y: lv2.y, z: lv2.z };
  }

  rightSelf() {
    const t = this.body.translation();
    const yaw = this.yaw;
    this.body.setTranslation({ x: t.x, y: t.y + 1.0, z: t.z }, true);
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.flip = 0;
  }

  setPose(x: number, y: number, z: number, yaw: number) {
    this.body.setTranslation({ x, y, z }, true);
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.prevVel = { x: 0, y: 0, z: 0 };
  }

  shove(ix: number, iz: number) {
    this.body.applyImpulse({ x: ix, y: 0, z: iz }, true);
  }

  destroy() {
    this.P.world.removeCollider(this.collider, false);
    this.P.world.removeRigidBody(this.body);
  }
}
