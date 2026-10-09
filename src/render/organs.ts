import * as THREE from 'three';
import { valueNoise3 } from './builder';

/**
 * What comes out of a body besides its limbs: lumps of brain, organs, loops of gut, splinters of bone, pieces of skull and
 * an eye. Pooled instanced meshes, oldest recycled first. They fly, land wet (a slap, a smear, no bounce to speak of) and
 * settle a little flattened where they fell.
 */

export type OrganKind = 'brain' | 'organ' | 'gut' | 'bone' | 'skull' | 'eye';
const KINDS: OrganKind[] = ['brain', 'organ', 'gut', 'bone', 'skull', 'eye'];

export interface OrganWorld {
  /** Height of the floor under a point, searching down from `y`, or null if there is none close below. */
  floorAt(x: number, y: number, z: number): number | null;
  /** A wet landing: blood where it struck, at `speed` m/s. */
  splat(x: number, y: number, z: number, speed: number, kind: OrganKind): void;
  /** Blood dripping off it in flight. */
  trail(x: number, y: number, z: number): void;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qd = new THREE.Quaternion();
const _a = new THREE.Vector3();
const _c = new THREE.Color();

/** Push each vertex out along its normal by a little noise: wrinkles on a brain, lumps on an organ. */
function lumpy(g: THREE.BufferGeometry, amp: number, freq: number, seed: number, folds = 0) {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    let n = valueNoise3(x * freq, y * freq, z * freq, seed) - 0.5;
    if (folds) n += Math.abs(Math.sin(valueNoise3(x * folds, y * folds, z * folds, seed + 1) * 14)) * 0.5 - 0.25;
    const k = 1 + n * amp;
    p.setXYZ(i, x * k, y * k, z * k);
  }
  g.computeVertexNormals();
  return g;
}

function eyeGeometry() {
  const g = new THREE.SphereGeometry(0.013, 12, 9);
  const p = g.getAttribute('position');
  const col: number[] = [];
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i) / 0.013;
    // A clouded iris in front, the white veined toward the back, the stump of the nerve red.
    if (z > 0.86) col.push(0.12, 0.13, 0.1);
    else if (z > 0.7) col.push(0.38, 0.4, 0.3);
    else if (z < -0.82) col.push(0.45, 0.06, 0.05);
    else col.push(0.86, 0.8, 0.72 - Math.max(0, -z) * 0.2);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

function gutGeometry() {
  // A short loop of gut: a tube along a curl, closed off at both ends.
  const pts = [[-0.06, 0, 0], [-0.03, 0.02, 0.03], [0.01, 0.01, 0.035], [0.04, -0.01, 0.01], [0.05, 0, -0.03], [0.02, 0.015, -0.05]];
  const curve = new THREE.CatmullRomCurve3(pts.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
  return new THREE.TubeGeometry(curve, 20, 0.014, 7, false);
}

function boneGeometry() {
  const g = new THREE.CylinderGeometry(0.006, 0.01, 0.1, 6, 3);
  const p = g.getAttribute('position');
  // A splintered end: the top ring torn ragged.
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > 0.045) p.setY(i, p.getY(i) + (valueNoise3(p.getX(i) * 400, 0, p.getZ(i) * 400, 5) - 0.3) * 0.03);
  }
  g.computeVertexNormals();
  return g;
}

interface Pool {
  mesh: THREE.InstancedMesh;
  n: number;
  next: number;
  /** Contact radius of the shape at size 1. */
  radius: number;
  /** How flat it settles (1 keeps its shape). */
  slump: number;
  pos: Float32Array;
  vel: Float32Array;
  quat: Float32Array;
  spin: Float32Array;
  size: Float32Array;
  squash: Float32Array;
  age: Float32Array;
  trailT: Float32Array;
  rest: Uint8Array;
  used: Uint8Array;
  count: number;
}

function pool(geo: THREE.BufferGeometry, n: number, slump: number, opts: { rough?: number; double?: boolean } = {}): Pool {
  const vc = geo.hasAttribute('color');
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: opts.rough ?? 0.3, metalness: 0, vertexColors: vc, side: opts.double ? THREE.DoubleSide : THREE.FrontSide });
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.count = 0;
  for (let i = 0; i < n; i++) mesh.setColorAt(i, _c.setRGB(1, 1, 1));
  geo.computeBoundingSphere();
  return {
    mesh, n, next: 0, radius: geo.boundingSphere!.radius * 0.55, slump,
    pos: new Float32Array(n * 3), vel: new Float32Array(n * 3), quat: new Float32Array(n * 4), spin: new Float32Array(n * 3),
    size: new Float32Array(n), squash: new Float32Array(n).fill(1), age: new Float32Array(n), trailT: new Float32Array(n),
    rest: new Uint8Array(n), used: new Uint8Array(n), count: 0,
  };
}

export class Organs {
  readonly group = new THREE.Group();
  private pools: Record<OrganKind, Pool>;

  constructor(private world: OrganWorld) {
    this.pools = {
      brain: pool(lumpy(new THREE.IcosahedronGeometry(0.032, 3), 0.22, 60, 3, 90), 40, 0.7),
      organ: pool(lumpy(new THREE.SphereGeometry(0.04, 12, 9).scale(1, 0.72, 0.85), 0.25, 45, 7), 48, 0.72),
      gut: pool(gutGeometry(), 40, 0.85, { rough: 0.26 }),
      bone: pool(boneGeometry(), 70, 1, { rough: 0.55 }),
      skull: pool(new THREE.SphereGeometry(0.075, 9, 6, 0, 1.15, 0.2, 0.95), 50, 1, { rough: 0.55, double: true }),
      eye: pool(eyeGeometry(), 20, 0.9, { rough: 0.18 }),
    };
    for (const k of KINDS) this.group.add(this.pools[k].mesh);
  }

  /** Throw one. Colour multiplies the shape (an eye has its own colours). */
  throw(kind: OrganKind, x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, r: number, g: number, b: number) {
    const p = this.pools[kind];
    const i = p.next;
    p.next = (p.next + 1) % p.n;
    if (!p.used[i]) p.count++;
    p.used[i] = 1;
    p.rest[i] = 0;
    p.age[i] = 0;
    p.trailT[i] = 0;
    p.size[i] = size;
    p.squash[i] = 1;
    p.pos.set([x, y, z], i * 3);
    p.vel.set([vx, vy, vz], i * 3);
    _q.setFromEuler(new THREE.Euler(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28));
    p.quat.set([_q.x, _q.y, _q.z, _q.w], i * 4);
    const w = kind === 'bone' || kind === 'skull' ? 22 : 12;
    p.spin.set([(Math.random() - 0.5) * w, (Math.random() - 0.5) * w, (Math.random() - 0.5) * w], i * 3);
    p.mesh.setColorAt(i, _c.setRGB(r, g, b));
    if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number) {
    if (dt <= 0) return;
    const elapsed = Math.min(dt, 0.25);
    for (const k of KINDS) this.step(this.pools[k], k, elapsed);
  }

  private step(p: Pool, kind: OrganKind, dt: number) {
    let top = 0;
    let changed = false;
    const steps = Math.ceil(dt * 120);
    const h = dt / steps;
    for (let i = 0; i < p.n; i++) {
      if (!p.used[i]) continue;
      top = i + 1;
      if (p.rest[i]) continue;
      changed = true;
      const o3 = i * 3;
      p.age[i] += dt;
      const sz = p.size[i];
      _q.fromArray(p.quat, i * 4);
      // The floor once a frame: it does not move under a lump in a sixtieth of a second.
      const floor = this.world.floorAt(p.pos[o3], p.pos[o3 + 1] + 0.4, p.pos[o3 + 2]);
      for (let s = 0; s < steps && !p.rest[i]; s++) {
        _a.fromArray(p.spin, o3);
        const w = _a.length();
        if (w > 1e-4) {
          _qd.setFromAxisAngle(_a.divideScalar(w), w * h);
          _q.premultiply(_qd).normalize();
        }
        p.vel[o3 + 1] -= 9.81 * h;
        p.pos[o3] += p.vel[o3] * h;
        p.pos[o3 + 1] += p.vel[o3 + 1] * h;
        p.pos[o3 + 2] += p.vel[o3 + 2] * h;
        const rr = p.radius * sz * p.squash[i];
        if (floor !== null && p.pos[o3 + 1] - rr <= floor) {
          p.pos[o3 + 1] = floor + rr;
          const impact = -p.vel[o3 + 1];
          const hard = kind === 'bone' || kind === 'skull';
          if (impact > (hard ? 1.6 : 3)) {
            // Bone and skull clatter; meat slaps down and barely leaves the ground again.
            p.vel[o3 + 1] = impact * (hard ? 0.3 : 0.1);
            p.vel[o3] *= hard ? 0.6 : 0.35;
            p.vel[o3 + 2] *= hard ? 0.6 : 0.35;
            for (let k = 0; k < 3; k++) p.spin[o3 + k] *= hard ? 0.5 : 0.2;
            this.world.splat(p.pos[o3], floor, p.pos[o3 + 2], impact, kind);
          } else {
            p.vel[o3 + 1] = 0;
            const grip = Math.exp(-(hard ? 10 : 24) * h);
            p.vel[o3] *= grip;
            p.vel[o3 + 2] *= grip;
            for (let k = 0; k < 3; k++) p.spin[o3 + k] *= Math.exp(-(hard ? 14 : 30) * h);
            if (Math.hypot(p.vel[o3], p.vel[o3 + 2]) < 0.05 && Math.hypot(p.spin[o3], p.spin[o3 + 1], p.spin[o3 + 2]) < 0.1) {
              p.vel[o3] = p.vel[o3 + 2] = 0;
              p.rest[i] = 1;
              p.squash[i] = p.slump;
              p.pos[o3 + 1] = floor + p.radius * sz * p.slump;
            }
          }
        } else if (p.age[i] < 2.5 && kind !== 'bone') {
          p.trailT[i] -= h;
          if (p.trailT[i] <= 0) {
            p.trailT[i] = 0.09;
            this.world.trail(p.pos[o3], p.pos[o3 + 1], p.pos[o3 + 2]);
          }
        }
      }
      _q.toArray(p.quat, i * 4);
      _m.makeRotationFromQuaternion(_q).scale(_a.set(sz, sz, sz));
      // Settled meat spreads under its own weight: flattened in the world's up, not its own.
      const sq = p.squash[i];
      if (sq !== 1) {
        const e = _m.elements;
        e[1] *= sq; e[5] *= sq; e[9] *= sq;
        e[0] *= 1 + (1 - sq) * 0.5; e[8] *= 1 + (1 - sq) * 0.5; e[2] *= 1 + (1 - sq) * 0.5; e[10] *= 1 + (1 - sq) * 0.5;
      }
      _m.setPosition(p.pos[o3], p.pos[o3 + 1], p.pos[o3 + 2]);
      p.mesh.setMatrixAt(i, _m);
    }
    p.mesh.count = top;
    if (changed) p.mesh.instanceMatrix.needsUpdate = true;
  }

  counts(): Record<OrganKind, number> {
    const out = {} as Record<OrganKind, number>;
    for (const k of KINDS) out[k] = this.pools[k].count;
    return out;
  }

  clear() {
    for (const k of KINDS) {
      const p = this.pools[k];
      p.used.fill(0);
      p.count = 0;
      p.next = 0;
      p.mesh.count = 0;
    }
  }

  dispose() {
    for (const k of KINDS) {
      const m = this.pools[k].mesh;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
    this.group.removeFromParent();
  }
}
