import * as THREE from 'three';
import type { BrassWorld } from './brass';
import { MeshBuilder } from './builder';

/**
 * What a heavy round takes off a body: arms, legs and heads thrown clear with the blow, tumbling, bouncing, trailing blood
 * and leaving it where they land. Chunks of meat come with them. Pooled instanced meshes, oldest recycled first.
 */

export type GibKind = 'limb' | 'head' | 'animalHead' | 'chunk' | 'plank' | 'shard';

interface Pool {
  mesh: THREE.InstancedMesh;
  n: number;
  next: number;
  /** Half extents used for orientation-aware floor contact. */
  extent: THREE.Vector3;
}

export interface GibWorld extends BrassWorld {
  /** Blood trailing off a moving gib. */
  trail(x: number, y: number, z: number, vx: number, vy: number, vz: number): void;
  /** A gib hit the floor hard enough to splash. */
  splash(x: number, y: number, z: number, speed: number): void;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qd = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _a = new THREE.Vector3();
const _c = new THREE.Color();
const _target = new THREE.Quaternion();
const _flat = new THREE.Vector3();

const GRAVITY = 9.81;

/** Shared detailed silhouettes; all parts still fit in one instanced draw call per kind. */
function fleshGeometry(head: boolean, animal = false) {
  const b = new MeshBuilder();
  b.seed(head ? 812 : 417);
  b.jitter = 0.08;
  const outer = 0xffffff;
  const tissue = 0x8c211e;
  const dark = 0x35100e;
  const bone = 0xe7d8b2;
  if (head) {
    b.add('sphere16', 0, 0.02, 0, animal ? 0.18 : 0.21, animal ? 0.21 : 0.25, animal ? 0.26 : 0.22, outer);
    b.add('sphere', 0, -0.055, animal ? 0.105 : 0.035, animal ? 0.11 : 0.145, 0.11, 0.18, outer);
    b.add('sphere', 0, 0.015, animal ? 0.17 : 0.113, animal ? 0.085 : 0.035, 0.07, 0.045, animal ? dark : outer);
    for (const side of [-1, 1]) {
      b.add('sphere', side * 0.107, 0.005, 0, 0.038, 0.067, 0.033, outer);
      b.add('sphere', side * 0.048, 0.032, 0.097, 0.055, 0.033, 0.025, dark);
    }
    b.cyl(0, -0.119, 0, 0.085, 0.03, 0.077, tissue);
    b.cyl(0, -0.14, 0, 0.025, 0.028, 0.027, bone);
  } else {
    b.limb(0, 0.19, 0, 0.009, 0.01, 0, 0.07, 0.052, outer);
    b.limb(0.009, 0.01, 0, -0.015, -0.18, 0.025, 0.05, 0.032, outer);
    b.add('sphere', -0.014, -0.214, 0.031, 0.072, 0.085, 0.045, outer);
    b.cyl(0, 0.222, 0, 0.12, 0.025, 0.114, tissue);
    b.cyl(0, 0.243, 0, 0.023, 0.035, 0.022, bone);
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3;
      b.add('ico', Math.cos(a) * 0.044, 0.233 + (i % 3) * 0.006, Math.sin(a) * 0.044, 0.026, 0.04, 0.024, i % 2 ? tissue : dark);
    }
  }
  return b.build();
}

function support(extent: THREE.Vector3, q: THREE.Quaternion, size: number) {
  // The world Y row of the rotation matrix projects each local half extent onto the floor normal.
  return size * (Math.abs(2 * (q.x * q.y + q.z * q.w)) * extent.x
    + Math.abs(1 - 2 * (q.x * q.x + q.z * q.z)) * extent.y
    + Math.abs(2 * (q.y * q.z - q.x * q.w)) * extent.z);
}

class GibSet {
  readonly pool: Pool;
  pos: Float32Array;
  vel: Float32Array;
  quat: Float32Array;
  spin: Float32Array;
  size: Float32Array;
  age: Float32Array;
  rest: Uint8Array;
  used: Uint8Array;
  trailT: Float32Array;
  bloody: Uint8Array;
  count = 0;

  constructor(geo: THREE.BufferGeometry, n: number, glassy = false) {
    // Glass is bright and clear: a little of the sky in it, and none of the matte of meat and splinters.
    const mat = glassy
      ? new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.72, envMapIntensity: 1.6 })
      : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: geo.hasAttribute('color') ? 0.48 : 0.8, metalness: 0, vertexColors: geo.hasAttribute('color') });
    if (geo.hasAttribute('color')) {
      mat.onBeforeCompile = shader => {
        shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>', `#include <color_vertex>
          // Keep exposed flesh red regardless of the body's skin or clothing tint.
          #ifdef USE_INSTANCING_COLOR
            if ( color.r > color.g * 2.0 ) vColor.rgb = color;
          #endif
        `);
      };
      mat.customProgramCacheKey = () => 'gib-flesh-v1';
    }
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.count = 0;
    for (let i = 0; i < n; i++) mesh.setColorAt(i, _c.setRGB(1, 1, 1));
    geo.computeBoundingBox();
    const bounds = geo.boundingBox!;
    const extent = new THREE.Vector3(Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x)), Math.max(Math.abs(bounds.min.y), Math.abs(bounds.max.y)), Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z)));
    this.pool = { mesh, n, next: 0, extent };
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.quat = new Float32Array(n * 4);
    this.spin = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.age = new Float32Array(n);
    this.rest = new Uint8Array(n);
    this.used = new Uint8Array(n);
    this.trailT = new Float32Array(n);
    this.bloody = new Uint8Array(n);
  }
}

export class Gibs {
  readonly group = new THREE.Group();
  private sets: Record<GibKind, GibSet>;

  constructor(private world: GibWorld) {
    // Limbs lie along Y; the head is a rounded lump; chunks are small and ragged.
    const limb = fleshGeometry(false);
    const head = fleshGeometry(true);
    const chunk = new THREE.IcosahedronGeometry(0.05, 0);
    const plank = new THREE.BoxGeometry(0.07, 0.6, 0.12);
    // A shard of glass is a flat three-sided sliver.
    const shard = new THREE.CylinderGeometry(0, 0.05, 0.004, 3);
    chunk.scale(1.2, 0.75, 1);
    this.sets = { limb: new GibSet(limb, 56), head: new GibSet(head, 24), chunk: new GibSet(chunk, 220), plank: new GibSet(plank, 60), shard: new GibSet(shard, 320, true), animalHead: new GibSet(fleshGeometry(true, true), 24) };
    for (const k of Object.keys(this.sets) as GibKind[]) this.group.add(this.sets[k].pool.mesh);
  }

  /** Throw a gib. `bloody` distinguishes organic fragments from rubble sharing the chunk pool. */
  throw(kind: GibKind, x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, r: number, g: number, b: number, bloody = kind === 'limb' || kind === 'head' || kind === 'animalHead') {
    const set = this.sets[kind];
    const pl = set.pool;
    const i = pl.next;
    pl.next = (pl.next + 1) % pl.n;
    if (!set.used[i]) set.count++;
    set.used[i] = 1;
    set.rest[i] = 0;
    set.age[i] = 0;
    set.trailT[i] = 0;
    set.bloody[i] = bloody ? 1 : 0;
    set.size[i] = size;
    set.pos.set([x, y, z], i * 3);
    set.vel.set([vx, vy, vz], i * 3);
    _q.setFromEuler(new THREE.Euler(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28));
    set.quat.set([_q.x, _q.y, _q.z, _q.w], i * 4);
    const w = kind === 'chunk' ? 26 : kind === 'shard' ? 34 : kind === 'plank' ? 16 : 12;
    set.spin.set([(Math.random() - 0.5) * w, (Math.random() - 0.5) * w, (Math.random() - 0.5) * w], i * 3);
    pl.mesh.setColorAt(i, _c.setRGB(r, g, b));
    if (pl.mesh.instanceColor) pl.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number) {
    if (dt <= 0) return;
    // Small steps keep bounce and rolling stable when a frame takes longer than usual.
    const elapsed = Math.min(dt, 0.25);
    const steps = Math.ceil(elapsed * 120);
    for (let i = 0; i < steps; i++) {
      for (const kind of Object.keys(this.sets) as GibKind[]) this.step(this.sets[kind], kind, elapsed / steps);
    }
  }

  private step(set: GibSet, kind: GibKind, dt: number) {
    const pl = set.pool;
    let top = 0;
    let changed = false;
    for (let i = 0; i < pl.n; i++) {
      if (!set.used[i]) continue;
      top = i + 1;
      // Sleeping debris keeps its matrix; long fights should not re-upload settled parts every frame.
      if (set.rest[i]) continue;
      changed = true;
      set.age[i] += dt;
      const o3 = i * 3;
      const sz = set.size[i];
      if (!set.rest[i]) {
        _q.fromArray(set.quat, i * 4);
        _a.fromArray(set.spin, o3);
        const w = _a.length();
        if (w > 1e-4) {
          _qd.setFromAxisAngle(_a.divideScalar(w), w * dt);
          _q.premultiply(_qd).normalize();
        }
        set.vel[o3 + 1] -= GRAVITY * dt;
        const nx = set.pos[o3] + set.vel[o3] * dt;
        let ny = set.pos[o3 + 1] + set.vel[o3 + 1] * dt;
        const nz = set.pos[o3 + 2] + set.vel[o3 + 2] * dt;
        const speed = Math.hypot(set.vel[o3], set.vel[o3 + 1], set.vel[o3 + 2]);
        // A trail of blood while it is flying.
        if (speed > 2 && set.bloody[i] && set.age[i] < 2) {
          set.trailT[i] -= dt;
          if (set.trailT[i] <= 0) {
            set.trailT[i] += kind === 'chunk' ? 0.10 : 0.065;
            this.world.trail(nx, ny, nz, set.vel[o3], set.vel[o3 + 1], set.vel[o3 + 2]);
          }
        }
        const floor = set.vel[o3 + 1] <= 0 ? this.world.floorAt(nx, Math.max(set.pos[o3 + 1], ny) + 0.4, nz) : null;
        let rr = support(pl.extent, _q, sz);
        if (floor !== null && ny - rr <= floor) {
          ny = floor + rr;
          const impact = -set.vel[o3 + 1];
          if (impact > 1.4) {
            set.vel[o3 + 1] = impact * (set.bloody[i] ? 0.22 : 0.32);
            set.vel[o3] *= 0.65;
            set.vel[o3 + 2] *= 0.65;
            for (let k = 0; k < 3; k++) set.spin[o3 + k] *= 0.5;
            // Only flesh splashes; wood, masonry and glass keep their own debris behavior.
            if (set.bloody[i]) {
              this.world.splash(nx, floor, nz, impact);
              this.world.ring(nx, floor, nz, 0);
            }
          } else {
            set.vel[o3 + 1] = 0;
            const friction = Math.exp(-9 * dt);
            set.vel[o3] *= friction;
            set.vel[o3 + 2] *= friction;
            for (let k = 0; k < 3; k++) set.spin[o3 + k] *= Math.exp(-12 * dt);
            if (kind === 'limb' || kind === 'plank') {
              _a.set(0, 1, 0).applyQuaternion(_q);
              _flat.set(_a.x, 0, _a.z);
              if (_flat.lengthSq() < 0.0001) _flat.set(1, 0, 0);
              _qd.setFromUnitVectors(_a, _flat.normalize());
              _target.copy(_q).premultiply(_qd);
              _q.slerp(_target, 1 - Math.exp(-10 * dt));
              rr = support(pl.extent, _q, sz);
              ny = floor + rr;
            }
            const flatEnough = kind !== 'limb' && kind !== 'plank' || Math.abs(_a.y) < 0.025;
            if (Math.hypot(set.vel[o3], set.vel[o3 + 2]) < 0.12 && Math.hypot(set.spin[o3], set.spin[o3 + 1], set.spin[o3 + 2]) < 0.15 && flatEnough) {
              set.vel[o3] = set.vel[o3 + 2] = 0;
              set.rest[i] = 1;
            }
          }
        }
        set.pos[o3] = nx;
        set.pos[o3 + 1] = ny;
        set.pos[o3 + 2] = nz;
        _q.toArray(set.quat, i * 4);
      }
      _q.set(set.quat[i * 4], set.quat[i * 4 + 1], set.quat[i * 4 + 2], set.quat[i * 4 + 3]);
      _p.set(set.pos[o3], set.pos[o3 + 1], set.pos[o3 + 2]);
      _s.set(sz, sz, sz);
      _m.compose(_p, _q, _s);
      pl.mesh.setMatrixAt(i, _m);
    }
    pl.mesh.count = top;
    if (changed) pl.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Gibs in the world, by kind. */
  counts(): Record<GibKind, number> {
    return { limb: this.sets.limb.count, head: this.sets.head.count, animalHead: this.sets.animalHead.count, chunk: this.sets.chunk.count, plank: this.sets.plank.count, shard: this.sets.shard.count };
  }

  clear() {
    for (const k of Object.keys(this.sets) as GibKind[]) {
      const s = this.sets[k];
      s.used.fill(0);
      s.count = 0;
      s.pool.next = 0;
      s.pool.mesh.count = 0;
    }
  }

  dispose() {
    for (const k of Object.keys(this.sets) as GibKind[]) {
      const m = this.sets[k].pool.mesh;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
    this.group.removeFromParent();
  }
}
