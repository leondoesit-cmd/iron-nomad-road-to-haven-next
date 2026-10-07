import * as THREE from 'three';

/**
 * Lightning bolts. A strike is a jagged channel from the cloud base to the ground with a few forks off it, drawn as two
 * crossed ribbons so it reads from any side, far brighter than anything else so the bloom makes it glare. It flickers as a
 * real one does: a leader, a blinding return stroke and one or two more strokes down the same channel, all in a third of
 * a second. The scene takes what `update` returns for the sky and the ambient light, which is what lights the land: the
 * whole cloud glows, so there is no point light to add (and no shader to recompile the first time one strikes). A far one,
 * out over the mountains, is a thread on the horizon (`far`).
 */

interface Bolt {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  age: number;
  life: number;
  /** Return strokes, seconds after the start. */
  strokes: number[];
  far: boolean;
  x: number;
  y: number;
  z: number;
}

const POOL = 4;
const COLOR = new THREE.Color(0.78, 0.84, 1.0);

/** Brightness of a bolt at an age: a faint leader, then sharp strokes that each die in a few hundredths of a second. */
function strokeLight(age: number, strokes: number[]): number {
  let k = age < strokes[0] ? 0.15 * (age / strokes[0]) : 0;
  for (const s of strokes) if (age >= s) k = Math.max(k, Math.exp(-(age - s) / 0.035));
  return k;
}

export class LightningFx {
  readonly group = new THREE.Group();
  private bolts: Bolt[] = [];
  private rnd = Math.random;

  constructor() {
    this.group.name = 'lightning';
    for (let i = 0; i < POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: COLOR, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 8;
      this.group.add(mesh);
      this.bolts.push({ mesh, mat, age: 99, life: 0, strokes: [0], far: false, x: 0, y: 0, z: 0 });
    }
  }

  /**
   * A strike to the ground at (x, y, z), from a cloud base `top` metres up. `far` makes it a thread on the horizon: thicker
   * so it shows at a distance, no light on the ground.
   */
  strike(x: number, y: number, z: number, top: number, far = false) {
    const b = this.bolts.reduce((a, c) => (c.age - c.life > a.age - a.life ? c : a));
    b.age = 0;
    b.far = far;
    b.x = x;
    b.y = y;
    b.z = z;
    const n = 1 + Math.floor(this.rnd() * 2.6);
    b.strokes = [0.045 + this.rnd() * 0.03];
    for (let k = 1; k < n; k++) b.strokes.push(b.strokes[k - 1] + 0.05 + this.rnd() * 0.07);
    b.life = b.strokes[b.strokes.length - 1] + 0.18;
    b.mesh.geometry.dispose();
    b.mesh.geometry = this.channel(x, y, z, top, far ? 7 : 0.55);
    b.mesh.visible = true;
  }

  /** The jagged channel and its forks, as crossed ribbons. */
  private channel(x: number, y: number, z: number, top: number, width: number): THREE.BufferGeometry {
    const pos: number[] = [];
    const ribbon = (pts: THREE.Vector3[], w0: number) => {
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i];
        const c = pts[i + 1];
        const w = w0 * (1 - (i / pts.length) * 0.5);
        for (const [dx, dz] of [
          [w, 0],
          [0, w],
        ]) {
          pos.push(a.x - dx, a.y, a.z - dz, a.x + dx, a.y, a.z + dz, c.x + dx, c.y, c.z + dz);
          pos.push(a.x - dx, a.y, a.z - dz, c.x + dx, c.y, c.z + dz, c.x - dx, c.y, c.z - dz);
        }
      }
    };
    // From the cloud down, wandering in short kinks that are larger near the top.
    const main: THREE.Vector3[] = [];
    const steps = 26;
    let px = x + (this.rnd() - 0.5) * top * 0.4;
    let pz = z + (this.rnd() - 0.5) * top * 0.4;
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const py = y + top * (1 - u);
      // Pull toward the strike point as it nears the ground.
      px += (x - px) * u * 0.35 + (this.rnd() - 0.5) * top * 0.07 * (1 - u * 0.7);
      pz += (z - pz) * u * 0.35 + (this.rnd() - 0.5) * top * 0.07 * (1 - u * 0.7);
      main.push(new THREE.Vector3(i === steps ? x : px, py, i === steps ? z : pz));
    }
    ribbon(main, width);
    // Forks off the upper part that die out in the air.
    const forks = 2 + Math.floor(this.rnd() * 3);
    for (let f = 0; f < forks; f++) {
      const from = main[2 + Math.floor(this.rnd() * (steps * 0.6))];
      const br: THREE.Vector3[] = [from.clone()];
      const ang = this.rnd() * Math.PI * 2;
      let bx = from.x;
      let by = from.y;
      let bz = from.z;
      const len = 4 + Math.floor(this.rnd() * 6);
      for (let i = 0; i < len; i++) {
        bx += Math.cos(ang) * top * 0.035 + (this.rnd() - 0.5) * top * 0.03;
        bz += Math.sin(ang) * top * 0.035 + (this.rnd() - 0.5) * top * 0.03;
        by -= top * (0.02 + this.rnd() * 0.03);
        br.push(new THREE.Vector3(bx, by, bz));
      }
      ribbon(br, width * 0.45);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return g;
  }

  /** Step the flicker. Returns how hard near strikes and far ones are lighting things now (0..1 each). */
  update(dt: number): { near: number; far: number } {
    let near = 0;
    let far = 0;
    for (const b of this.bolts) {
      if (!b.mesh.visible) continue;
      b.age += dt;
      if (b.age >= b.life) {
        b.mesh.visible = false;
        continue;
      }
      const k = strokeLight(b.age, b.strokes);
      // HDR white: the bloom spreads it into a glare.
      b.mat.color.copy(COLOR).multiplyScalar(b.far ? 4 + 10 * k : 6 + 26 * k);
      b.mat.opacity = Math.min(1, 0.25 + k);
      if (b.far) far = Math.max(far, k);
      else near = Math.max(near, k);
    }
    return { near, far };
  }

  dispose() {
    for (const b of this.bolts) {
      b.mesh.geometry.dispose();
      b.mat.dispose();
    }
    this.group.removeFromParent();
  }
}
