import * as THREE from 'three';
import { clamp, damp, dampAngle, lerp, wrapAngle } from '../core/math';

export type CamMode = 'vehicle' | 'foot' | 'gunner' | 'downed' | 'camp';

export interface CamTarget {
  x: number;
  y: number;
  z: number;
  /** Heading of the thing being followed. */
  yaw: number;
  /** Forward speed (m/s) for pull-back and FOV. */
  speed: number;
  topSpeed: number;
  /** A vehicle's body slip, rad (+ going left of its nose): the chase view swings part way toward where it is going. */
  slide?: number;
}

export interface CamParams {
  dist: number;
  height: number;
  /** Aim yaw/pitch driven by the right stick on foot and in turrets. */
  aimYaw: number;
  aimPitch: number;
  /** Free-look offset while driving (right stick). */
  lookYaw: number;
  lookPitch: number;
  shoulder: number;
  lookBack: boolean;
  zoom: number;
  /** Mouse aiming: follow the aim with almost no smoothing so the view tracks the hand. */
  crisp?: boolean;
  /**
   * First person: the world position of the player's eyes. The camera sits exactly there and looks along the aim
   * (on foot and at the gun) or along the vehicle's heading plus `lookYaw` / `lookPitch` (driving).
   */
  eye?: THREE.Vector3 | null;
  /** What a gun does to the view this frame: muzzle climb and twitch (radians), roll, and the push back (metres). */
  kick?: { pitch: number; yaw: number; roll: number; back: number };
  /** How much the driving chase view moves with the car (lag, swing, bank, bounce, rumble): 0 = locked on rails, 1 = default. */
  motion?: number;
}

/** A damped spring on one offset, pushed by an acceleration. Semi-implicit Euler in short steps so a long frame stays stable. */
class Spring {
  x = 0;
  v = 0;
  constructor(
    private w: number,
    private zeta: number,
    private lim: number,
  ) {}
  step(dt: number, push: number) {
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (push - this.w * this.w * this.x - 2 * this.zeta * this.w * this.v) * h;
      this.x += this.v * h;
      if (this.x > this.lim || this.x < -this.lim) {
        this.x = clamp(this.x, -this.lim, this.lim);
        this.v *= 0.5;
      }
    }
    return this.x;
  }
  reset() {
    this.x = this.v = 0;
  }
}

/**
 * What the driving chase view reads off the car between frames: its velocity, and from that the push of the throttle and brakes,
 * the pull of a corner, the drop and thump of a jump. All in the car's own frame, smoothed so the render interpolation's jitter
 * does not show up as acceleration.
 */
class RideFeel {
  /** 0: nothing known yet; 1: a position, no velocity; 2: running. */
  private have = 0;
  private px = 0;
  private py = 0;
  private pz = 0;
  private pyaw = 0;
  private vx = 0;
  private vy = 0;
  private vz = 0;
  /** Smoothed accelerations, m/s²: along the nose (+ speeding up), to the right (+), up (+). And the turn rate (+ left), rad/s. */
  along = 0;
  lat = 0;
  up = 0;
  yawRate = 0;
  /** How bumpy the ride is: the smoothed size of the up-and-down shove. */
  rough = 0;
  /** 0 on the ground, toward 1 the longer the car has been falling free. */
  air = 0;
  /** Camera offsets, metres in the car's frame: the lag back under power (+ forward), the swing out of a corner (+ right), the bounce. */
  surge = new Spring(4.2, 0.6, 1.6);
  sway = new Spring(3.6, 0.65, 1.3);
  heave = new Spring(7.5, 0.38, 0.9);
  /** The view leaning into a corner, radians (+ = head tilted left). */
  bank = new Spring(4.5, 0.75, 0.12);

  update(dt: number, t: CamTarget) {
    if (!(dt > 0) || !Number.isFinite(t.x + t.y + t.z + t.yaw)) return;
    const dx = t.x - this.px;
    const dy = t.y - this.py;
    const dz = t.z - this.pz;
    // A first frame, or a teleport (respawn, a new scene, a towed car): start over rather than read it as a huge shove.
    if (!this.have || dx * dx + dy * dy + dz * dz > 400) {
      this.reset();
      this.have = 1;
      this.store(t);
      return;
    }
    // A frame drawn with no physics step since the last one shows the car standing still: skip it rather than read a stop.
    if (dx === 0 && dy === 0 && dz === 0 && t.speed > 0.5) return;
    // The second frame only learns how fast the car is already going: that is not a shove.
    if (this.have === 1) {
      this.vx = dx / dt;
      this.vy = dy / dt;
      this.vz = dz / dt;
      this.have = 2;
      this.store(t);
      return;
    }
    const d = Math.min(dt, 0.1);
    const k = 1 - Math.exp(-22 * d);
    const nvx = this.vx + (dx / dt - this.vx) * k;
    const nvy = this.vy + (dy / dt - this.vy) * k;
    const nvz = this.vz + (dz / dt - this.vz) * k;
    const ax = (nvx - this.vx) / dt;
    const ay = (nvy - this.vy) / dt;
    const az = (nvz - this.vz) / dt;
    this.vx = nvx;
    this.vy = nvy;
    this.vz = nvz;
    const fx = Math.sin(t.yaw);
    const fz = Math.cos(t.yaw);
    const ka = 1 - Math.exp(-9 * d);
    // Smooth first and clamp after, so an uneven frame's spike and its recovery still cancel out.
    this.along = clamp(this.along + (ax * fx + az * fz - this.along) * ka, -25, 25);
    this.lat = clamp(this.lat + (-ax * fz + az * fx - this.lat) * ka, -25, 25);
    this.up = clamp(this.up + (ay - this.up) * (1 - Math.exp(-16 * d)), -80, 80);
    this.yawRate += (clamp(wrapAngle(t.yaw - this.pyaw) / dt, -4, 4) - this.yawRate) * ka;
    this.rough += (Math.min(25, Math.abs(ay)) - this.rough) * (1 - Math.exp(-3 * d));
    // Falling free reads as about -g straight down and no push along the ground.
    this.air = clamp(this.air + (this.up < -6.5 && this.vy < -0.5 ? d * 3 : -d * 6), 0, 1);
    this.store(t);
  }

  /** Let the springs swing for this frame. `m` scales every push (the motion setting); `sf` is the speed fraction. */
  springs(d: number, m: number, sf: number) {
    const moving = clamp(sf * 4, 0, 1);
    this.surge.step(d, -this.along * 3.2 * m);
    this.sway.step(d, -this.lat * 1.6 * m * moving);
    this.heave.step(d, -this.up * 0.7 * m);
    // Lean into the corner: in a left turn the pull is to the left (lat < 0), so the head tilts left.
    this.bank.step(d, -this.lat * 0.14 * m * moving);
  }

  private store(t: CamTarget) {
    this.px = t.x;
    this.py = t.y;
    this.pz = t.z;
    this.pyaw = t.yaw;
  }

  reset() {
    this.have = 0;
    this.vx = this.vy = this.vz = 0;
    this.along = this.lat = this.up = this.yawRate = this.rough = this.air = 0;
    this.surge.reset();
    this.sway.reset();
    this.heave.reset();
    this.bank.reset();
  }

  /** Off the car (on foot, at a gun, in the eyes): let the offsets settle back without new pushes. */
  settle(d: number) {
    this.have = 0;
    this.along = this.lat = this.up = this.yawRate = this.air = 0;
    this.rough *= Math.exp(-6 * d);
    this.surge.step(d, 0);
    this.sway.step(d, 0);
    this.heave.step(d, 0);
    this.bank.step(d, 0);
  }
}

// Scratch vectors: the camera updates every frame for every player, so it must not make garbage.
const _desired = new THREE.Vector3();
const _lookAt = new THREE.Vector3();
const _from = new THREE.Vector3();
const _dir = new THREE.Vector3();

/** Seconds the camera takes to glide from a chase view into the eyes (getting out of a car, closing the inventory). */
const EYE_GLIDE = 0.38;
/** A chase camera further than this from the eyes was teleported with its player (a respawn, a new scene): cut, don't glide. */
const EYE_GLIDE_MAX = 22;

/**
 * Chase camera tuned for the short, wide strip each player gets: it sits far back and high,
 * pulls back with speed, and uses a shoulder offset on foot.
 */
export class ChaseCamera {
  pos = new THREE.Vector3();
  look = new THREE.Vector3();
  yaw = 0;
  private shake = 0;
  private shakeT = 0;
  private dist = 5;
  private height = 2;
  private initialized = false;
  mode: CamMode = 'vehicle';
  /** Horizontal forward of the camera (for on-foot movement and aiming). */
  fwd = new THREE.Vector3(0, 0, 1);
  /** Occlusion test: returns distance along the ray before something solid, or Infinity. */
  occlude: (from: THREE.Vector3, dir: THREE.Vector3, maxDist: number) => number = () => Infinity;
  groundAt: (x: number, z: number) => number = () => 0;
  /** Degrees the chase view widens by at speed (`scene.ts` adds it to the chase field of view). */
  fovKick = 0;
  private kick: CamParams['kick'] = undefined;
  /** The last update was at the eyes. */
  private wasEye = false;
  /** An update has placed this camera at all (a fresh camera has no pose to glide from). */
  private posed = false;
  /** Glide into the eyes still to go: 1 just after a chase view handed over, 0 once there. */
  private glide = 0;
  private glideFrom = new THREE.Vector3();
  private glideLook = new THREE.Vector3();
  /** The driving view's feel of the car: lag, swing, bank, bounce. */
  readonly ride = new RideFeel();
  /** Roll of the chase view this frame, radians (+ = tilted left), and the size of the road rumble, metres. */
  private roll = 0;
  private rumble = 0;
  private rumbleT = 0;

  addShake(a: number) {
    this.shake = Math.min(1.2, this.shake + a);
  }

  snap() {
    this.initialized = false;
  }

  /**
   * How far into the eyes the view has come: 1 when it is there (or was never anywhere else), less while it is still gliding
   * in from a chase view. The owner's body and the first-person arms swap over near the end of the glide.
   */
  get eyeBlend(): number {
    return 1 - this.glide;
  }

  update(dt: number, t: CamTarget, mode: CamMode, p: CamParams) {
    this.mode = mode;
    this.kick = p.kick;
    if (p.eye) {
      // Coming from a chase view, ease into the eyes instead of cutting, unless the camera was somewhere else entirely.
      if (!this.wasEye && this.posed && this.pos.distanceTo(p.eye) < EYE_GLIDE_MAX) {
        this.glide = 1;
        this.glideFrom.copy(this.pos);
        this.glideLook.copy(this.look);
      } else if (!this.wasEye) this.glide = 0;
      this.wasEye = true;
      this.posed = true;
      this.ride.settle(Math.min(dt, 0.1));
      this.roll = 0;
      this.rumble = 0;
      this.updateFirst(dt, t, mode, p, p.eye);
      return;
    }
    this.wasEye = false;
    this.posed = true;
    this.glide = 0;
    const speedFrac = clamp(t.speed / Math.max(1, t.topSpeed), 0, 1);
    const driving = mode === 'vehicle';
    const m = driving ? clamp(p.motion ?? 1, 0, 2) : 0;
    const d = Math.min(dt, 0.1);
    const ride = this.ride;
    if (driving && this.initialized) {
      ride.update(dt, t);
      ride.springs(d, m, speedFrac);
    } else ride.settle(d);
    // At speed the view drops a little and falls further back, so the ground rushes; in the air it lifts and draws back.
    const targetDist = (p.dist ?? 5) * (1 + (0.25 + 0.1 * m) * speedFrac + 0.18 * m * ride.air);
    const targetHeight = (p.height ?? 2) * (1 - 0.1 * m * speedFrac + 0.12 * m * ride.air);
    const k = this.initialized ? 1 : 100;
    this.dist = damp(this.dist || 5, targetDist, 3.5 * k, dt);
    this.height = damp(this.height || 2, targetHeight, 3.5 * k, dt);
    let camYaw: number;
    let pitch = 0;
    const desired = _desired;
    const lookAt = _lookAt;
    if (mode === 'vehicle' || mode === 'camp') {
      // Chase the heading with a little lag so corners read; the right stick looks around. In a slide the view swings part
      // way round toward where the car is going, so a drift is driven by looking down the road and not at the bonnet.
      const slide = mode === 'vehicle' ? clamp(t.slide ?? 0, -0.8, 0.8) * 0.55 * clamp((t.speed - 3) / 6, 0, 1) : 0;
      const base = t.yaw + (p.lookBack ? Math.PI : slide) + p.lookYaw;
      // A touch lazier with more motion, so the car swings across the frame in a corner before the view catches up.
      const follow = lerp(3.0, 6.5, speedFrac) * (1 - 0.18 * Math.min(1, m));
      // And the view widens as the speed builds, kicks wider under power and in the air, and tightens a little under the brakes.
      const punch = clamp(ride.along * 0.5, -3, 4) * m * clamp(t.speed / 4, 0, 1);
      const wantFov = driving ? 7 * speedFrac * speedFrac * (1 + 0.25 * m) + punch + 5 * m * ride.air : 0;
      this.fovKick = damp(this.fovKick, wantFov, wantFov > this.fovKick ? 4 : 2, dt);
      this.yaw = dampAngle(this.yaw, base, follow * k, dt);
      camYaw = this.yaw;
      pitch = p.lookPitch * 0.25;
      const sx = Math.sin(camYaw);
      const cz = Math.cos(camYaw);
      // The spring offsets in the view's frame: surge along it, sway to its right (-cos, sin), heave up.
      const fwdOff = ride.surge.x;
      const rightOff = ride.sway.x;
      desired.set(
        t.x - sx * (this.dist - fwdOff) - cz * rightOff,
        t.y + this.height + pitch * this.dist + ride.heave.x,
        t.z - cz * (this.dist - fwdOff) + sx * rightOff,
      );
      // Aim a little into the corner the car is turning through (yaw rate + = left), so the view looks out to the exit.
      const lead = p.lookBack ? 0 : clamp(ride.yawRate * 0.16, -0.22, 0.22) * m * clamp((t.speed - 2) / 8, 0, 1);
      const reach = 2 + speedFrac * 6;
      lookAt.set(t.x + Math.sin(camYaw + lead) * reach, t.y + this.height * 0.28 + ride.heave.x * 0.35, t.z + Math.cos(camYaw + lead) * reach);
    } else if (mode === 'foot' || mode === 'gunner') {
      // Orbit the head along the aim direction: pitch up drops the camera so the reticle stays honest.
      camYaw = p.aimYaw;
      this.yaw = camYaw;
      pitch = p.aimPitch;
      const sh = p.shoulder;
      const rx = -Math.cos(camYaw) * sh;
      const rz = Math.sin(camYaw) * sh;
      const dist = mode === 'gunner' ? this.dist : this.dist * (1 - 0.35 * p.zoom);
      const dx = Math.sin(camYaw) * Math.cos(pitch);
      const dy = Math.sin(pitch);
      const dz = Math.cos(camYaw) * Math.cos(pitch);
      const hy = t.y + this.height * 0.95;
      desired.set(t.x - dx * dist + rx, hy - dy * dist + 0.25, t.z - dz * dist + rz);
      lookAt.set(t.x + dx * 25 + rx, hy + dy * 25, t.z + dz * 25 + rz);
    } else {
      // Downed: low and close.
      camYaw = this.yaw;
      desired.set(t.x - Math.sin(camYaw) * 3.2, t.y + 1.3, t.z - Math.cos(camYaw) * 3.2);
      lookAt.set(t.x, t.y + 0.2, t.z);
    }

    // Keep out of walls: pull the camera in along the ray from the target.
    const from = _from.set(t.x, t.y + Math.min(this.height, 1.6), t.z);
    const dir = _dir.copy(desired).sub(from);
    const len = dir.length();
    if (len > 0.01) {
      dir.divideScalar(len);
      const hit = this.occlude(from, dir, len);
      if (hit < len) desired.copy(from).addScaledVector(dir, Math.max(1.0, hit - 0.35));
    }
    const gy = this.groundAt(desired.x, desired.z) + 0.7;
    if (Number.isFinite(gy) && desired.y < gy) desired.y = gy;

    if (!Number.isFinite(desired.x) || !Number.isFinite(desired.y) || !Number.isFinite(desired.z)) {
      desired.set(t.x || 0, (t.y || 0) + 3, (t.z || 0) - 6);
    }
    if (!Number.isFinite(lookAt.x) || !Number.isFinite(lookAt.y) || !Number.isFinite(lookAt.z)) {
      lookAt.set(t.x || 0, (t.y || 0) + 1, (t.z || 0) + 10);
    }

    const posK = mode === 'foot' || mode === 'gunner' ? (p.crisp ? 45 : 22) : 14;
    const lookK = p.crisp ? 90 : 18;
    if (!this.initialized || !Number.isFinite(this.pos.x)) {
      this.pos.copy(desired);
      this.look.copy(lookAt);
      this.initialized = true;
    } else {
      this.pos.x = damp(this.pos.x, desired.x, posK, dt);
      this.pos.y = damp(this.pos.y, desired.y, posK, dt);
      this.pos.z = damp(this.pos.z, desired.z, posK, dt);
      this.look.x = damp(this.look.x, lookAt.x, lookK, dt);
      this.look.y = damp(this.look.y, lookAt.y, lookK, dt);
      this.look.z = damp(this.look.z, lookAt.z, lookK, dt);
    }
    // Looking straight down leaves no horizontal run: keep the last heading rather than collapse to zero.
    const fx = this.look.x - this.pos.x;
    const fz = this.look.z - this.pos.z;
    if (fx * fx + fz * fz > 1e-10) this.fwd.set(fx, 0, fz).normalize();

    // The bank and the road rumble: a fine hum that grows with speed, more on broken ground, and a jolt with every bump.
    this.roll = driving ? ride.bank.x : damp(this.roll, 0, 6, dt);
    this.rumble = driving ? (1 - ride.air) * m * (0.012 * speedFrac * speedFrac + Math.min(0.05, ride.rough * 0.0022 * clamp(t.speed / 5, 0.3, 1))) : 0;
    this.rumbleT += dt;

    // Shake
    this.shakeT += dt * 38;
    this.shake = Math.max(0, this.shake - dt * 2.4);
  }

  /** First person: no orbit, no occlusion, no smoothing on foot. The eye is inside the capsule, clear of walls. */
  private updateFirst(dt: number, t: CamTarget, mode: CamMode, p: CamParams, eye: THREE.Vector3) {
    let yaw: number;
    let pitch: number;
    if (mode === 'vehicle' || mode === 'camp') {
      // Chassis heading, with a little filtering so suspension judder does not shake the view; the stick or mouse looks around.
      const base = t.yaw + (p.lookBack ? Math.PI : 0) + p.lookYaw;
      this.yaw = this.initialized ? dampAngle(this.yaw, base, 30, dt) : base;
      yaw = this.yaw;
      pitch = p.lookPitch;
    } else {
      yaw = this.yaw = p.aimYaw;
      pitch = p.aimPitch;
    }
    const cp = Math.cos(pitch);
    this.pos.copy(eye);
    this.look.set(eye.x + Math.sin(yaw) * cp * 25, eye.y + Math.sin(pitch) * 25, eye.z + Math.cos(yaw) * cp * 25);
    if (this.glide > 0) {
      // Smootherstep from where the chase view was to the eyes, position and aim point alike: the move starts and lands softly.
      this.glide = Math.max(0, this.glide - dt / EYE_GLIDE);
      const x = 1 - this.glide;
      const w = x * x * x * (x * (x * 6 - 15) + 10);
      this.pos.lerpVectors(this.glideFrom, this.pos, w);
      this.look.lerpVectors(this.glideLook, this.look, w);
    }
    this.initialized = true;
    this.fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
    // Keep the orbit distances warm so leaving first person eases out instead of jumping.
    this.dist = damp(this.dist, p.dist, 3.5, dt);
    this.height = damp(this.height, p.height, 3.5, dt);
    this.shakeT += dt * 38;
    this.shake = Math.max(0, this.shake - dt * 2.4);
  }

  apply(cam: THREE.PerspectiveCamera) {
    if (!Number.isFinite(this.pos.x) || !Number.isFinite(this.pos.y) || !Number.isFinite(this.pos.z)) {
      this.pos.set(0, 3, -6);
    }
    if (!Number.isFinite(this.look.x) || !Number.isFinite(this.look.y) || !Number.isFinite(this.look.z)) {
      this.look.set(0, 1, 10);
    }
    cam.position.copy(this.pos);
    if (this.shake > 0.001) {
      cam.position.x += Math.sin(this.shakeT * 1.7) * this.shake * 0.12;
      cam.position.y += Math.cos(this.shakeT * 2.3) * this.shake * 0.1;
    }
    if (this.rumble > 1e-4) {
      // Three unrelated frequencies so the hum never settles into a visible wobble.
      const r = this.rumbleT;
      cam.position.y += (Math.sin(r * 71) * 0.6 + Math.sin(r * 43.7 + 1.3) * 0.4) * this.rumble;
      cam.position.x += Math.sin(r * 57.3 + 0.7) * this.rumble * 0.45;
    }
    cam.lookAt(this.look);
    const roll = this.roll + (this.rumble > 1e-4 ? Math.sin(this.rumbleT * 37.9 + 2.1) * this.rumble * 0.06 : 0);
    if (Math.abs(roll) > 1e-5) cam.rotateZ(roll);
    const k = this.kick;
    if (k && (k.pitch || k.yaw || k.roll || k.back)) {
      cam.translateZ(k.back);
      cam.rotateX(k.pitch);
      cam.rotateY(k.yaw);
      cam.rotateZ(k.roll);
    }
  }
}
