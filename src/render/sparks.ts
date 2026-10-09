import * as THREE from 'three';

/**
 * Sparks: bits of metal (or a grain of flint) torn off hot by a blow. Each is far smaller than a pixel; what the eye sees is
 * the streak it draws while the shutter is open, so each is a line from where it is back along its flight, a pixel wide
 * however near, white-hot when it leaves and cooling through yellow and orange to a dull red as it falls. A hit changes how
 * many fly and which way, never how big they look.
 */

/** Seconds of flight a streak shows: the eye's (and a camera's) shutter. */
const SHUTTER = 1 / 90;
/** Shortest streak, m: a spark nearly at rest still shows as a dot. */
const MIN_STREAK = 0.006;

export class Sparks {
  readonly lines: THREE.LineSegments;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private max: Float32Array;
  private heat: Float32Array;
  private n = 0;
  private verts: Float32Array;
  private cols: Float32Array;
  private geo = new THREE.BufferGeometry();
  budget = 1;

  constructor(readonly cap = 900) {
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.max = new Float32Array(cap);
    this.heat = new Float32Array(cap);
    this.verts = new Float32Array(cap * 6);
    this.cols = new Float32Array(cap * 6);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.verts, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.cols, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false });
    this.lines = new THREE.LineSegments(this.geo, mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 6;
    this.lines.visible = false;
    this.lines.name = 'sparks';
  }

  /** One spark at (x, y, z) flying at (vx, vy, vz) m/s, glowing for `life` seconds, `heat` 0..1 how white it starts. */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, heat = 1) {
    if (this.budget < 1 && Math.random() > this.budget) return;
    let i = this.n;
    if (i >= this.cap) i = Math.floor(Math.random() * this.cap);
    else this.n++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.life[i] = life;
    this.max[i] = life;
    this.heat[i] = heat;
  }

  /**
   * A shower off a struck surface: `n` sparks thrown about the direction (ux, uy, uz), within `spread` (radians) of it,
   * at up to `speed` m/s. A glancing blow throws a tight fan along the surface; a square one a wide splash back off it.
   */
  shower(x: number, y: number, z: number, ux: number, uy: number, uz: number, n: number, speed: number, spread: number, heat = 1) {
    const l = Math.hypot(ux, uy, uz) || 1;
    ux /= l;
    uy /= l;
    uz /= l;
    // Two axes across the direction.
    let ax = -uz;
    let ay = 0;
    let az = ux;
    if (Math.abs(uy) > 0.9) {
      ax = 1;
      az = 0;
    }
    const al = Math.hypot(ax, ay, az);
    ax /= al;
    ay /= al;
    az /= al;
    const bx = uy * az - uz * ay;
    const by = uz * ax - ux * az;
    const bz = ux * ay - uy * ax;
    for (let k = 0; k < n; k++) {
      const t = spread * Math.sqrt(Math.random());
      const p = Math.random() * Math.PI * 2;
      const c = Math.cos(t);
      const s = Math.sin(t);
      const dx = ux * c + (ax * Math.cos(p) + bx * Math.sin(p)) * s;
      const dy = uy * c + (ay * Math.cos(p) + by * Math.sin(p)) * s;
      const dz = uz * c + (az * Math.cos(p) + bz * Math.sin(p)) * s;
      // Most go fast; a few dribble off slow.
      const u = Math.random();
      const v = speed * (0.25 + 0.75 * Math.sqrt(u));
      this.emit(x, y, z, dx * v, dy * v, dz * v, 0.12 + Math.random() * 0.4, heat * (0.75 + 0.25 * Math.random()));
    }
  }

  update(dt: number) {
    if (dt <= 0 && this.n === 0) return;
    let w = 0;
    for (let i = 0; i < this.n; ) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.kill(i);
        continue;
      }
      const o = i * 3;
      // A grain of hot metal: gravity, and the air slows it a little.
      const k = Math.exp(-1.6 * dt);
      this.vel[o] *= k;
      this.vel[o + 1] = this.vel[o + 1] * k - 9.81 * dt;
      this.vel[o + 2] *= k;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      i++;
    }
    for (let i = 0; i < this.n; i++) {
      const o = i * 3;
      const vx = this.vel[o];
      const vy = this.vel[o + 1];
      const vz = this.vel[o + 2];
      const sp = Math.hypot(vx, vy, vz);
      const len = Math.max(MIN_STREAK, sp * SHUTTER);
      const f = sp > 1e-4 ? len / sp : 0;
      const q = w * 6;
      this.verts[q] = this.pos[o];
      this.verts[q + 1] = this.pos[o + 1];
      this.verts[q + 2] = this.pos[o + 2];
      this.verts[q + 3] = this.pos[o] - vx * f;
      this.verts[q + 4] = this.pos[o + 1] - vy * f - (sp < 1e-4 ? MIN_STREAK : 0);
      this.verts[q + 5] = this.pos[o + 2] - vz * f;
      // Cooling: white-hot, then yellow, orange, a dull red, gone. Brighter than white at first, for the bloom.
      const t = (this.life[i] / this.max[i]) * this.heat[i];
      const r = 1.2 + 2.2 * t;
      const g = 0.25 + 2.1 * t * t;
      const b = 0.05 + 1.1 * t * t * t;
      const fade = Math.min(1, this.life[i] / 0.08);
      this.cols[q] = r * fade;
      this.cols[q + 1] = g * fade;
      this.cols[q + 2] = b * fade;
      // The tail of the streak is where it was a moment ago: fainter.
      this.cols[q + 3] = r * fade * 0.25;
      this.cols[q + 4] = g * fade * 0.2;
      this.cols[q + 5] = b * fade * 0.15;
      w++;
    }
    if (w) {
      for (const a of [this.geo.getAttribute('position'), this.geo.getAttribute('color')] as THREE.BufferAttribute[]) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, w * 6);
        a.needsUpdate = true;
      }
    }
    this.geo.setDrawRange(0, w * 2);
    this.lines.visible = w > 0;
  }

  /** Sparks in flight. */
  get count(): number {
    return this.n;
  }

  clear() {
    this.n = 0;
    this.geo.setDrawRange(0, 0);
    this.lines.visible = false;
  }

  private kill(i: number) {
    const j = --this.n;
    if (i === j) return;
    for (let q = 0; q < 3; q++) {
      this.pos[i * 3 + q] = this.pos[j * 3 + q];
      this.vel[i * 3 + q] = this.vel[j * 3 + q];
    }
    this.life[i] = this.life[j];
    this.max[i] = this.max[j];
    this.heat[i] = this.heat[j];
  }

  dispose() {
    this.geo.dispose();
    (this.lines.material as THREE.Material).dispose();
  }
}
