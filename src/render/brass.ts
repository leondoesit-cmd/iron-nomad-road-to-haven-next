import * as THREE from 'three';

/**
 * Spent brass and shotgun hulls: thrown clear of the ejection port with spin, falling under gravity, bouncing off the
 * floor with a ring, rolling to a stop and staying where they land. One instanced mesh for all of them.
 */

export type ShellKind = 'pistol' | 'rifle' | 'hull';
/** The empty magazines a gun drops when it is reloaded. */
export type MagKind = 'pistol' | 'smg';

interface Spec {
  /** Scale of the unit shape along each axis, metres (the long axis is y). Drawn a little over life size so a case still reads from the camera. */
  sx: number;
  sy: number;
  sz: number;
  /** How high its centre rests above the floor. */
  rest: number;
  color: [number, number, number];
}

const cyl = (r: number, len: number, color: [number, number, number]): Spec => ({ sx: r, sy: len, sz: r, rest: r, color });

const SHELLS: Spec[] = [cyl(0.0085, 0.032, [0.86, 0.62, 0.26]), cyl(0.0095, 0.062, [0.82, 0.58, 0.24]), cyl(0.0145, 0.075, [0.62, 0.09, 0.07])];
const MAGS: Spec[] = [
  { sx: 0.036, sy: 0.12, sz: 0.024, rest: 0.012, color: [0.16, 0.16, 0.18] },
  { sx: 0.04, sy: 0.22, sz: 0.027, rest: 0.0135, color: [0.17, 0.17, 0.19] },
];

/** Resting things sit a little above the collider's floor, so they are not lost in the relief of rough ground. */
const LIFT = 0.018;
const GRAVITY = 9.81;
const REST_BOUNCE = 0.42;
/** Seconds a shell lies before it starts to shrink away, and how long the shrinking takes. */
const LIFE = 45;
const FADE = 3;

export interface BrassWorld {
  /** Height of the floor under a point, searching down from `y`, or null if there is none close below. */
  floorAt(x: number, y: number, z: number): number | null;
  /** A shell rang off the floor. */
  ring(x: number, y: number, z: number, loud: number): void;
  /** An empty magazine hit the floor. */
  clunk?(x: number, y: number, z: number, loud: number): void;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qd = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

/** One pool of thrown things sharing a shape: each tumbles, bounces off the floor, rolls to a stop and stays. One instanced mesh. */
class Pool {
  readonly mesh: THREE.InstancedMesh;
  private n: number;
  private pos: Float32Array;
  private vel: Float32Array;
  private quat: Float32Array;
  private spin: Float32Array;
  private age: Float32Array;
  private rest: Uint8Array;
  private bounces: Uint8Array;
  private kind: Uint8Array;
  private used: Uint8Array;
  private next = 0;
  /** Shells in the world right now. */
  count = 0;

  constructor(
    private world: BrassWorld,
    private specs: Spec[],
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    n: number,
    /** How loudly a bounce rings, on the world's scale. */
    private ringScale = 1,
    private onRing?: (x: number, y: number, z: number, loud: number) => void,
  ) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.quat = new Float32Array(n * 4);
    this.spin = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.rest = new Uint8Array(n);
    this.bounces = new Uint8Array(n);
    this.kind = new Uint8Array(n);
    this.used = new Uint8Array(n);
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.count = 0;
    for (let i = 0; i < n; i++) this.mesh.setColorAt(i, _c.setRGB(1, 1, 1));
  }

  /** Throw a shell out of the gun. The velocity is the ejection throw; the carrier's own motion should already be in it. */
  eject(x: number, y: number, z: number, vx: number, vy: number, vz: number, kind: number) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    if (!this.used[i]) this.count++;
    this.used[i] = 1;
    this.rest[i] = 0;
    this.bounces[i] = 0;
    this.age[i] = 0;
    this.kind[i] = kind;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    _q.setFromEuler(new THREE.Euler(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28));
    this.quat[i * 4] = _q.x;
    this.quat[i * 4 + 1] = _q.y;
    this.quat[i * 4 + 2] = _q.z;
    this.quat[i * 4 + 3] = _q.w;
    const w = 14 + Math.random() * 22;
    this.spin[i * 3] = (Math.random() - 0.5) * w;
    this.spin[i * 3 + 1] = (Math.random() - 0.5) * w;
    this.spin[i * 3 + 2] = (Math.random() - 0.5) * w;
    const col = this.specs[kind].color;
    this.mesh.setColorAt(i, _c.setRGB(col[0], col[1], col[2]));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number) {
    let top = 0;
    for (let i = 0; i < this.n; i++) {
      if (!this.used[i]) continue;
      top = i + 1;
      this.age[i] += dt;
      const sp = this.specs[this.kind[i]];
      let fade = 1;
      if (this.age[i] > LIFE) {
        fade = 1 - (this.age[i] - LIFE) / FADE;
        if (fade <= 0) {
          this.used[i] = 0;
          this.count--;
          this.writeHidden(i);
          continue;
        }
      }
      const o3 = i * 3;
      if (!this.rest[i]) {
        this.vel[o3 + 1] -= GRAVITY * dt;
        // The air drags a light case a little; spin dies slowly.
        const drag = Math.exp(-0.5 * dt);
        this.vel[o3] *= drag;
        this.vel[o3 + 2] *= drag;
        const px = this.pos[o3];
        const py = this.pos[o3 + 1];
        const pz = this.pos[o3 + 2];
        let ny = py + this.vel[o3 + 1] * dt;
        const nx = px + this.vel[o3] * dt;
        const nz = pz + this.vel[o3 + 2] * dt;
        const floor = this.vel[o3 + 1] <= 0 ? this.world.floorAt(nx, Math.max(py, ny) + 0.25, nz) : null;
        const rest = sp.rest + LIFT;
        if (floor !== null && ny - rest <= floor) {
          ny = floor + rest;
          const impact = -this.vel[o3 + 1];
          if (impact > 0.9) {
            this.vel[o3 + 1] = impact * REST_BOUNCE;
            // Skidding off the floor loses a good share of the sideways speed.
            this.vel[o3] *= 0.62;
            this.vel[o3 + 2] *= 0.62;
            this.spin[o3] = (Math.random() - 0.5) * 30;
            this.spin[o3 + 1] = (Math.random() - 0.5) * 30;
            this.spin[o3 + 2] = (Math.random() - 0.5) * 30;
            if (this.bounces[i] < 255) this.bounces[i]++;
            const loud = Math.min(1, impact / 4) * (this.bounces[i] > 2 ? 0.5 : 1) * this.ringScale;
            if (this.onRing) this.onRing(nx, ny, nz, loud);
            else this.world.ring(nx, ny, nz, loud);
          } else {
            this.vel[o3 + 1] = 0;
            this.vel[o3] *= 0.8;
            this.vel[o3 + 2] *= 0.8;
            const h = Math.hypot(this.vel[o3], this.vel[o3 + 2]);
            if (h < 0.25) {
              this.vel[o3] = this.vel[o3 + 2] = 0;
              this.rest[i] = 1;
              this.layFlat(i);
            }
          }
        }
        this.pos[o3] = nx;
        this.pos[o3 + 1] = ny;
        this.pos[o3 + 2] = nz;
        if (!this.rest[i]) {
          _q.set(this.quat[i * 4], this.quat[i * 4 + 1], this.quat[i * 4 + 2], this.quat[i * 4 + 3]);
          _axis.set(this.spin[o3], this.spin[o3 + 1], this.spin[o3 + 2]);
          const w = _axis.length();
          if (w > 1e-4) {
            _qd.setFromAxisAngle(_axis.divideScalar(w), w * dt);
            _q.premultiply(_qd).normalize();
            this.quat[i * 4] = _q.x;
            this.quat[i * 4 + 1] = _q.y;
            this.quat[i * 4 + 2] = _q.z;
            this.quat[i * 4 + 3] = _q.w;
          }
        }
      }
      _q.set(this.quat[i * 4], this.quat[i * 4 + 1], this.quat[i * 4 + 2], this.quat[i * 4 + 3]);
      _p.set(this.pos[o3], this.pos[o3 + 1], this.pos[o3 + 2]);
      _s.set(sp.sx * fade, sp.sy * fade, sp.sz * fade);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.count = top;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Lying on its side: the long axis horizontal, turned however it happened to fall. */
  private layFlat(i: number) {
    _q.set(this.quat[i * 4], this.quat[i * 4 + 1], this.quat[i * 4 + 2], this.quat[i * 4 + 3]);
    // Where the case's long axis points now, flattened; then turn the cylinder (Y) onto that heading.
    _axis.copy(UP).applyQuaternion(_q);
    const yaw = Math.atan2(_axis.x, _axis.z);
    _qd.setFromAxisAngle(UP, yaw);
    _q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2).premultiply(_qd);
    this.quat[i * 4] = _q.x;
    this.quat[i * 4 + 1] = _q.y;
    this.quat[i * 4 + 2] = _q.z;
    this.quat[i * 4 + 3] = _q.w;
  }

  private writeHidden(i: number) {
    _m.makeScale(0, 0, 0);
    this.mesh.setMatrixAt(i, _m);
  }

  clear() {
    this.used.fill(0);
    this.count = 0;
    this.next = 0;
    this.mesh.count = 0;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}

/**
 * Spent brass and shotgun hulls, and the empty magazines a gun drops at a reload: two pools, one cylinder and one box, each
 * one instanced mesh.
 */
export class Brass {
  private shells: Pool;
  private mags: Pool;

  constructor(world: BrassWorld, n = 140, nMags = 36) {
    this.shells = new Pool(world, SHELLS, new THREE.CylinderGeometry(1, 1, 1, 8, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.28, metalness: 0.85 }), n);
    this.mags = new Pool(world, MAGS, new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.6 }), nMags, 1, (x, y, z, loud) => world.clunk?.(x, y, z, loud));
  }

  /** The meshes to add to a scene. */
  get meshes(): THREE.InstancedMesh[] {
    return [this.shells.mesh, this.mags.mesh];
  }

  /** The shell mesh. */
  get mesh(): THREE.InstancedMesh {
    return this.shells.mesh;
  }

  /** Shells in the world right now. */
  get count(): number {
    return this.shells.count;
  }

  /** Magazines in the world right now. */
  get magCount(): number {
    return this.mags.count;
  }

  /** Throw a shell out of the gun. The velocity is the ejection throw; the carrier's own motion should already be in it. */
  eject(x: number, y: number, z: number, vx: number, vy: number, vz: number, kind: ShellKind) {
    this.shells.eject(x, y, z, vx, vy, vz, kind === 'pistol' ? 0 : kind === 'rifle' ? 1 : 2);
  }

  /** An empty magazine leaves the gun. */
  dropMag(x: number, y: number, z: number, vx: number, vy: number, vz: number, kind: MagKind) {
    this.mags.eject(x, y, z, vx, vy, vz, kind === 'pistol' ? 0 : 1);
  }

  update(dt: number) {
    this.shells.update(dt);
    this.mags.update(dt);
  }

  clear() {
    this.shells.clear();
    this.mags.clear();
  }

  dispose() {
    this.shells.dispose();
    this.mags.dispose();
  }
}
