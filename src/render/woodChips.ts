import * as THREE from 'three';
import { WIND } from './scatter';

/**
 * What a round knocks out of a tree: pale chips and splinters of wood (and twigs, the same pieces drawn long and thin),
 * curled flakes of bark, and leaves shaken out of the crown. Chips and bark tumble out on ballistic paths and bounce where
 * they land; leaves flutter down, rocking and drifting on the wind. Everything lies where it fell for half a minute or so,
 * then shrinks away.
 *
 * Three fixed pools, one instanced draw each, oldest recycled first: a burst from a machine gun into a trunk never allocates
 * and never grows past the caps. Only pieces in the air are stepped and re-uploaded.
 */

export type PieceKind = 'chip' | 'bark' | 'leaf';

/** How many of each piece there can be at once. */
export const CHIP_CAP: Record<PieceKind, number> = { chip: 400, bark: 160, leaf: 240 };

const GRAVITY = 9.81;
const FADE = 1.2;
const FREE = 0;
const FLYING = 1;
const RESTING = 2;
const FADING = 3;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qd = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _a = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

/** A splinter: a thin wedge, broad at one end and tapering to a point, its long axis on x. */
function chipGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(0.05, 0.006, 0.02, 2, 1, 1);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    if (x > 0) {
      const k = 1 - x / 0.025;
      p.setZ(i, p.getZ(i) * (0.15 + 0.85 * k));
      p.setY(i, p.getY(i) * (0.4 + 0.6 * k));
    } else if (x < -0.01) p.setZ(i, p.getZ(i) * 0.8);
  }
  g.computeVertexNormals();
  return g;
}

/** A flake of bark: a curled plate, the curl across its width. */
function barkGeometry(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(0.05, 0.034, 3, 2);
  g.rotateX(-Math.PI / 2);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i) / 0.017;
    const x = p.getX(i) / 0.025;
    p.setY(i, 0.008 * z * z + 0.002 * x * x);
  }
  g.computeVertexNormals();
  return g;
}

/** A leaf: a pointed oval on the x-z plane, folded a little along its midrib. */
function leafGeometry(): THREE.BufferGeometry {
  const pos: number[] = [0, 0, 0];
  const idx: number[] = [];
  const n = 10;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = Math.cos(a) * 0.04;
    const z = Math.sin(a) * 0.017 * (1 - 0.35 * Math.cos(a));
    pos.push(x, Math.abs(z) * 0.35, z);
  }
  for (let i = 0; i < n; i++) idx.push(0, 1 + i, 1 + ((i + 1) % n));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

class Pool {
  readonly mesh: THREE.InstancedMesh;
  readonly n: number;
  next = 0;
  /** Pieces in use. */
  live = 0;
  pos: Float32Array;
  vel: Float32Array;
  quat: Float32Array;
  /** Tumble (axis times rad/s) for chips and bark; yaw, phase and rocking rate for a leaf. */
  spin: Float32Array;
  scale: Float32Array;
  /** Height of the ground under it, and whether that has been looked up where it is about to land. */
  floor: Float32Array;
  refined: Uint8Array;
  age: Float32Array;
  life: Float32Array;
  state: Uint8Array;

  constructor(readonly kind: PieceKind, geo: THREE.BufferGeometry, n: number) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: kind === 'leaf' ? 0.7 : 0.88, metalness: 0, side: THREE.DoubleSide });
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.count = 0;
    for (let i = 0; i < n; i++) {
      this.mesh.setColorAt(i, _c.setRGB(1, 1, 1));
      this.mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
    }
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.quat = new Float32Array(n * 4);
    this.spin = new Float32Array(n * 3);
    this.scale = new Float32Array(n * 3);
    this.floor = new Float32Array(n);
    this.refined = new Uint8Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.state = new Uint8Array(n);
  }
}

export class WoodChips {
  readonly group = new THREE.Group();
  private pools: Record<PieceKind, Pool>;

  /** `ground(x, z)` is the height of the drawn ground, looked up once for each piece as it comes down to it. */
  constructor(private ground: (x: number, z: number) => number) {
    this.pools = {
      chip: new Pool('chip', chipGeometry(), CHIP_CAP.chip),
      bark: new Pool('bark', barkGeometry(), CHIP_CAP.bark),
      leaf: new Pool('leaf', leafGeometry(), CHIP_CAP.leaf),
    };
    for (const k of ['chip', 'bark', 'leaf'] as const) this.group.add(this.pools[k].mesh);
  }

  /**
   * Throw a piece from (x, y, z) at (vx, vy, vz). (sx, sy, sz) scales the piece's model (a twig is a chip drawn long and
   * thin); `floor` is a first guess at the ground under it. The oldest piece of the kind gives way if the pool is full.
   */
  throw(kind: PieceKind, x: number, y: number, z: number, vx: number, vy: number, vz: number, sx: number, sy: number, sz: number, r: number, g: number, b: number, floor: number) {
    const pl = this.pools[kind];
    const i = pl.next;
    pl.next = (pl.next + 1) % pl.n;
    if (pl.state[i] === FREE) pl.live++;
    pl.state[i] = FLYING;
    pl.age[i] = 0;
    pl.life[i] = (kind === 'leaf' ? 22 : 30) + Math.random() * 20;
    pl.floor[i] = floor;
    pl.refined[i] = 0;
    const o = i * 3;
    pl.pos[o] = x; pl.pos[o + 1] = y; pl.pos[o + 2] = z;
    pl.vel[o] = vx; pl.vel[o + 1] = vy; pl.vel[o + 2] = vz;
    pl.scale[o] = sx; pl.scale[o + 1] = sy; pl.scale[o + 2] = sz;
    if (kind === 'leaf') {
      pl.spin[o] = Math.random() * Math.PI * 2;
      pl.spin[o + 1] = Math.random() * Math.PI * 2;
      pl.spin[o + 2] = 2.2 + Math.random() * 2.4;
    } else {
      const w = kind === 'chip' ? 24 : 14;
      pl.spin[o] = (Math.random() - 0.5) * w;
      pl.spin[o + 1] = (Math.random() - 0.5) * w;
      pl.spin[o + 2] = (Math.random() - 0.5) * w;
    }
    _q.setFromEuler(_e.set(Math.random() * 6.283, Math.random() * 6.283, Math.random() * 6.283));
    _q.toArray(pl.quat, i * 4);
    pl.mesh.setColorAt(i, _c.setRGB(r, g, b));
    pl.mesh.instanceColor!.addUpdateRange(i * 3, 3);
    pl.mesh.instanceColor!.needsUpdate = true;
    if (i + 1 > pl.mesh.count) pl.mesh.count = i + 1;
  }

  /** Pieces of a kind in the world now. */
  count(kind: PieceKind): number {
    return this.pools[kind].live;
  }

  /** Pieces of a kind still in the air. */
  flying(kind: PieceKind): number {
    const pl = this.pools[kind];
    let n = 0;
    for (let i = 0; i < pl.mesh.count; i++) if (pl.state[i] === FLYING) n++;
    return n;
  }

  update(dt: number) {
    if (dt <= 0) return;
    const step = Math.min(dt, 0.05);
    const wind = WIND.uWind.value;
    const wx = wind.x * wind.w * 0.9;
    const wz = wind.z * wind.w * 0.9;
    for (const k of ['chip', 'bark', 'leaf'] as const) this.stepPool(this.pools[k], step, wx, wz);
  }

  private stepPool(pl: Pool, dt: number, wx: number, wz: number) {
    if (!pl.live) return;
    let changed = false;
    const leaf = pl.kind === 'leaf';
    const drag = pl.kind === 'chip' ? 0.35 : 1.6;
    for (let i = 0; i < pl.mesh.count; i++) {
      const st = pl.state[i];
      if (st === FREE) continue;
      const o = i * 3;
      if (st === RESTING) {
        pl.age[i] += dt;
        if (pl.age[i] > pl.life[i]) {
          pl.state[i] = FADING;
          pl.age[i] = 0;
        }
        continue;
      }
      let shrink = 1;
      if (st === FADING) {
        pl.age[i] += dt;
        shrink = 1 - pl.age[i] / FADE;
        if (shrink <= 0) {
          pl.state[i] = FREE;
          pl.live--;
          pl.mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
          changed = true;
          continue;
        }
        _q.fromArray(pl.quat, i * 4);
      } else {
        pl.age[i] += dt;
        _q.fromArray(pl.quat, i * 4);
        if (leaf) {
          // A leaf sinks at a gentle terminal speed, sliding to and fro and rocking as it goes, carried by the wind.
          const ph = (pl.spin[o + 1] += dt * pl.spin[o + 2]);
          pl.vel[o + 1] += (-1.05 - pl.vel[o + 1]) * Math.min(1, dt * 2.5);
          pl.vel[o] += (wx - pl.vel[o]) * Math.min(1, dt * 1.4);
          pl.vel[o + 2] += (wz - pl.vel[o + 2]) * Math.min(1, dt * 1.4);
          const sway = 0.55 * Math.cos(ph);
          pl.pos[o] += (pl.vel[o] + sway * Math.cos(pl.spin[o])) * dt;
          pl.pos[o + 1] += pl.vel[o + 1] * dt * (1 + 0.35 * Math.abs(Math.sin(ph)));
          pl.pos[o + 2] += (pl.vel[o + 2] + sway * Math.sin(pl.spin[o])) * dt;
          _q.setFromEuler(_e.set(Math.sin(ph) * 0.7, pl.spin[o] + Math.sin(ph * 0.5) * 0.4, Math.cos(ph) * 0.35, 'YXZ'));
        } else {
          // Chips and bark tumble on ballistic paths, bark slowed a little more by the air.
          pl.vel[o + 1] -= GRAVITY * dt;
          const k = Math.exp(-drag * dt);
          pl.vel[o] *= k;
          pl.vel[o + 1] *= k;
          pl.vel[o + 2] *= k;
          pl.pos[o] += pl.vel[o] * dt;
          pl.pos[o + 1] += pl.vel[o + 1] * dt;
          pl.pos[o + 2] += pl.vel[o + 2] * dt;
          _a.set(pl.spin[o], pl.spin[o + 1], pl.spin[o + 2]);
          const w = _a.length();
          if (w > 1e-4) {
            _qd.setFromAxisAngle(_a.divideScalar(w), w * dt);
            _q.premultiply(_qd).normalize();
          }
        }
        // Coming down to the ground: find exactly where it is under the piece, once.
        if (!pl.refined[i] && pl.vel[o + 1] < 0 && pl.pos[o + 1] < pl.floor[i] + 1.5) {
          pl.floor[i] = this.ground(pl.pos[o], pl.pos[o + 2]);
          pl.refined[i] = 1;
        }
        const lie = pl.floor[i] + 0.004 + pl.scale[o + 1] * 0.004;
        if (pl.pos[o + 1] <= lie) {
          pl.pos[o + 1] = lie;
          const impact = -pl.vel[o + 1];
          if (!leaf && impact > 1.4) {
            pl.vel[o + 1] = impact * (pl.kind === 'chip' ? 0.3 : 0.15);
            pl.vel[o] *= 0.5;
            pl.vel[o + 2] *= 0.5;
            for (let j = 0; j < 3; j++) pl.spin[o + j] *= 0.5;
          } else {
            // At rest, lying flat on the ground, turned which way it fell.
            const yaw = leaf ? pl.spin[o] : Math.atan2(pl.vel[o], pl.vel[o + 2]) + i * 1.7;
            _q.setFromAxisAngle(UP, yaw);
            if (Math.random() < 0.5 && !leaf) _q.multiply(_qd.setFromAxisAngle(_a.set(1, 0, 0), Math.PI));
            pl.state[i] = RESTING;
            pl.age[i] = 0;
            pl.vel[o] = pl.vel[o + 1] = pl.vel[o + 2] = 0;
          }
        }
        _q.toArray(pl.quat, i * 4);
      }
      _p.set(pl.pos[o], pl.pos[o + 1], pl.pos[o + 2]);
      _s.set(pl.scale[o] * shrink, pl.scale[o + 1] * shrink, pl.scale[o + 2] * shrink);
      pl.mesh.setMatrixAt(i, _m.compose(_p, _q, _s));
      changed = true;
    }
    if (changed) pl.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    for (const k of ['chip', 'bark', 'leaf'] as const) {
      const pl = this.pools[k];
      pl.state.fill(FREE);
      pl.live = 0;
      pl.next = 0;
      pl.mesh.count = 0;
    }
  }

  dispose() {
    for (const k of ['chip', 'bark', 'leaf'] as const) {
      const m = this.pools[k].mesh;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
    this.group.removeFromParent();
  }
}
