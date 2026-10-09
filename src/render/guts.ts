import * as THREE from 'three';

/**
 * Spilled gut, drawn from the rope simulation in `game/fleshFx.ts`: a tube segment between each pair of nodes and a swelling
 * at every node, so a length of it reads as the bulging, wet coil it is. Two instanced draws for all of it.
 */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _d = new THREE.Vector3();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

export class GutsRenderer {
  readonly group = new THREE.Group();
  private tubes: THREE.InstancedMesh;
  private knots: THREE.InstancedMesh;
  private nt = 0;
  private nk = 0;

  constructor(private max = 1400) {
    // Wet, a little translucent-looking pink-grey; the colour comes per instance (a rope's own, darkened with blood).
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.24, metalness: 0 });
    this.tubes = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 8, 1, true), mat, max);
    this.knots = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 7), mat, max);
    for (const m of [this.tubes, this.knots]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = true;
      m.receiveShadow = true;
      m.count = 0;
      m.setColorAt(0, _c.setRGB(1, 1, 1));
      this.group.add(m);
    }
    this.tubes.name = 'guts:tubes';
    this.knots.name = 'guts:knots';
  }

  begin() {
    this.nt = 0;
    this.nk = 0;
  }

  /** A length of tube between two points. */
  segment(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, cr: number, cg: number, cb: number) {
    if (this.nt >= this.max) return;
    _d.set(bx - ax, by - ay, bz - az);
    const len = _d.length();
    if (len < 1e-5) return;
    _q.setFromUnitVectors(UP, _d.divideScalar(len));
    _p.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    _s.set(r, len, r);
    _m.compose(_p, _q, _s);
    this.tubes.setMatrixAt(this.nt, _m);
    this.tubes.setColorAt(this.nt, _c.setRGB(cr, cg, cb));
    this.nt++;
  }

  /** A swelling of the gut at a node. */
  knot(x: number, y: number, z: number, r: number, cr: number, cg: number, cb: number) {
    if (this.nk >= this.max) return;
    _m.makeScale(r, r * 0.9, r).setPosition(x, y, z);
    this.knots.setMatrixAt(this.nk, _m);
    this.knots.setColorAt(this.nk, _c.setRGB(cr, cg, cb));
    this.nk++;
  }

  end() {
    for (const [m, n] of [[this.tubes, this.nt], [this.knots, this.nk]] as const) {
      m.count = n;
      if (n) {
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    }
  }

  dispose() {
    this.tubes.geometry.dispose();
    this.knots.geometry.dispose();
    (this.tubes.material as THREE.Material).dispose();
    this.tubes.dispose();
    this.knots.dispose();
    this.group.removeFromParent();
  }
}
