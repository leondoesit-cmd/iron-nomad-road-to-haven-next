import * as THREE from 'three';
import { glowTexture } from './props';

/**
 * What a light on a gun's rail shows in the world: a laser puts a small bright dot (and a faint line to it) where the barrel
 * points, and a torch throws a soft cone of light down the aim. Both are cosmetic meshes, so they cost no real lights (which would
 * recompile every material in the scene when they came and went). One per player, added to the scene and shown only while it is lit.
 */

const dotGeo = new THREE.SphereGeometry(0.5, 8, 6);
const dotMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 0.15, 0.08), fog: false, depthWrite: false });
const lineGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 4, 1, true);
const lineMat = new THREE.MeshBasicMaterial({ color: 0xff3a22, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
const coneGeo = new THREE.ConeGeometry(1, 1, 14, 1, true);
const coneMat = new THREE.MeshBasicMaterial({ color: 0xfff0c8, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });

// The pool of light a torch throws on what it hits, and the halo round a laser dot: flat additive glows (no real lights, so no shader recompiles).
const spotGeo = new THREE.PlaneGeometry(1, 1);
const spotMat = new THREE.MeshBasicMaterial({ color: 0xfff0c8, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
const haloMat = new THREE.SpriteMaterial({ color: 0xff3a22, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const Y = new THREE.Vector3(0, 1, 0);

export class GunBeam {
  readonly root = new THREE.Group();
  private dot = new THREE.Mesh(dotGeo, dotMat);
  private line = new THREE.Mesh(lineGeo, lineMat);
  private cone = new THREE.Mesh(coneGeo, coneMat);
  private spot = new THREE.Mesh(spotGeo, spotMat);
  private halo = new THREE.Sprite(haloMat);

  constructor(parent: THREE.Object3D) {
    this.spot.material = spotMat.clone();
    (this.spot.material as THREE.MeshBasicMaterial).map = glowTexture();
    haloMat.map ??= glowTexture();
    for (const m of [this.dot, this.line, this.cone, this.spot, this.halo]) {
      m.visible = false;
      m.frustumCulled = false;
      m.castShadow = false;
      m.renderOrder = 8;
      this.root.add(m);
    }
    parent.add(this.root);
  }

  /** Laser: a dot at `to` and a line back to the muzzle at `from`. */
  laser(on: boolean, from?: THREE.Vector3, to?: THREE.Vector3) {
    this.dot.visible = this.line.visible = this.halo.visible = on && !!from && !!to;
    if (!this.dot.visible || !from || !to) return;
    const d = from.distanceTo(to);
    // The dot grows with distance so it still reads far off, and shrinks to a pin-prick up close.
    this.dot.position.copy(to);
    this.dot.scale.setScalar(0.02 + d * 0.0035);
    this.halo.position.copy(to);
    this.halo.scale.setScalar(0.1 + d * 0.012);
    this.line.position.copy(_a.copy(from).add(to).multiplyScalar(0.5));
    this.line.scale.set(0.006 + d * 0.0006, d, 0.006 + d * 0.0006);
    _b.copy(to).sub(from).normalize();
    this.line.quaternion.copy(_q.setFromUnitVectors(Y, _b));
  }

  /**
   * Torch: a cone of light opening out from `from` along `dir`, `strength` 0 to 1 (more by night), and where the beam lands (`to`)
   * a pool of light: lying flat when the beam meets the ground, standing square to the beam on a wall.
   */
  torch(on: boolean, from?: THREE.Vector3, dir?: THREE.Vector3, strength = 1, to?: THREE.Vector3) {
    this.cone.visible = on && !!from && !!dir && strength > 0.01;
    this.spot.visible = this.cone.visible && !!to;
    if (!this.cone.visible || !from || !dir) return;
    if (this.spot.visible && to) {
      const d = Math.min(16, from.distanceTo(to));
      const down = dir.y < -0.12;
      this.spot.position.copy(to).addScaledVector(down ? Y : _b.copy(dir).negate(), 0.04);
      this.spot.quaternion.copy(down ? _q.setFromAxisAngle(_a.set(1, 0, 0), -Math.PI / 2) : _q.setFromUnitVectors(_a.set(0, 0, 1), _b.copy(dir).negate()));
      // The pool stretches along the ground away from the lamp when the beam comes in low.
      const r = 0.5 + d * 0.5;
      this.spot.scale.set(r, down ? r * (1 + Math.min(1.5, 0.4 / Math.max(0.15, -dir.y))) : r, 1);
      if (down) this.spot.rotation.z = Math.atan2(dir.x, dir.z) + Math.PI;
      (this.spot.material as THREE.MeshBasicMaterial).opacity = 0.04 + 0.4 * strength;
    }
    const len = 16;
    const r = 4.2;
    // A cone's axis is +Y with the apex up; put the apex at the lamp and turn the axis down the aim.
    this.cone.scale.set(r, len, r);
    this.cone.position.copy(from).addScaledVector(dir, len / 2);
    this.cone.quaternion.copy(_q.setFromUnitVectors(Y, _b.copy(dir).negate()));
    coneMat.opacity = 0.012 + 0.11 * strength;
  }

  hide() {
    this.dot.visible = this.line.visible = this.cone.visible = this.spot.visible = this.halo.visible = false;
  }

  dispose() {
    this.root.removeFromParent();
    (this.spot.material as THREE.Material).dispose();
  }
}
