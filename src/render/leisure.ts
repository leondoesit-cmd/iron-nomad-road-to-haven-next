import * as THREE from 'three';
import { smoothstep } from '../core/math';
import { MeshBuilder, S } from './builder';
import { shared } from './dispose';
import { HERO_LOOKS } from './heroLooks';
import type { Humanoid } from './humanoid';
import { kitMaterial } from './materials';
import { smokeTexture } from './proctex';

export type LeisurePose = 'drink' | 'smoke' | 'relax';

let bottleGeometry: THREE.BufferGeometry | undefined;
let jointGeometry: THREE.BufferGeometry | undefined;

function bottle() {
  if (bottleGeometry) return bottleGeometry;
  const b = new MeshBuilder();
  b.jitter = 0.01;
  const glass = S.gloss(0x60401c, 0.02);
  b.cyl(0, -0.092, 0, 0.082, 0.18, 0.082, glass, 0, 0, 0, 24);
  b.add('sphere16', 0, 0.002, 0, 0.081, 0.053, 0.081, glass);
  b.cyl(0, 0.061, 0, 0.025, 0.10, 0.025, glass, 0, 0, 0, 16);
  b.torus(0, 0.113, 0, 0.015, 0.003, glass, Math.PI / 2, 0, 0, 6, 16);
  b.cyl(0, 0.065, 0, 0.028, 0.037, 0.028, S.cloth(0xaa2735, 0.02), 0, 0, 0, 16);
  b.cyl(0, -0.08, 0, 0.083, 0.103, 0.083, S.cloth(0x27291d, 0.04), 0, 0, 0, 24);
  b.rbox(0, -0.078, 0.043, 0.052, 0.07, 0.002, 0.004, S.cloth(0xa33243, 0.02));
  b.add('sphere16', 0, -0.043, 0.045, 0.028, 0.028, 0.001, S.paint(0xd8ae4e, 0.02));
  return bottleGeometry = shared(b.build());
}

function joint() {
  if (jointGeometry) return jointGeometry;
  const b = new MeshBuilder();
  b.jitter = 0.015;
  // Paper cone along +Z, the filter against the lips and the glowing end facing away.
  b.limb(0, 0, -0.018, 0, 0, 0.063, 0.0038, 0.0054, S.cloth(0xe5dbc2, 0.01), 10);
  b.cyl(0, 0, -0.014, 0.008, 0.017, 0.008, S.cloth(0xbda77c, 0.01), Math.PI / 2, 0, 0, 10);
  b.cyl(0, 0, 0.064, 0.011, 0.006, 0.011, S.glow(0xe35b22, 1.6), Math.PI / 2, 0, 0, 10);
  b.cyl(0, 0, 0.069, 0.010, 0.004, 0.010, S.cloth(0x777367, 0.01), Math.PI / 2, 0, 0, 10);
  return jointGeometry = shared(b.build());
}

/** Bottle, lit joint and smoke, posed onto the same jointed body used in play. Purely visual; dosing is owned by Player. */
export class LeisureRig {
  readonly group = new THREE.Group();
  readonly bottle = new THREE.Mesh(bottle(), kitMaterial());
  readonly joint = new THREE.Mesh(joint(), kitMaterial());
  private puffs: THREE.Sprite[] = [];
  private t = 0;
  private mode: LeisurePose | null = null;
  private mouth = new THREE.Vector3();
  private target = new THREE.Vector3();
  private axis = new THREE.Vector3();
  private pole = new THREE.Vector3();
  private tip = new THREE.Vector3();
  private firstPerson = false;

  constructor(private h: Humanoid) {
    this.group.name = 'leisure-props';
    this.bottle.name = 'drink-bottle';
    this.joint.name = 'cannabis-joint';
    this.bottle.castShadow = this.joint.castShadow = true;
    this.group.add(this.bottle, this.joint);
    for (let i = 0; i < 28; i++) {
      const puff = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTexture(), color: 0xdce1dc, transparent: true, opacity: 0, depthWrite: false }));
      puff.name = 'joint-smoke';
      this.puffs.push(puff);
      this.group.add(puff);
    }
    h.torso.add(this.group);
    this.hide();
  }

  hide() {
    this.group.visible = false;
    this.mode = null;
    this.t = 0;
  }

  setFirstPerson(on: boolean) {
    this.firstPerson = on;
    this.group.visible = !on && this.mode !== null;
  }

  update(dt: number, mode: LeisurePose) {
    if (mode !== this.mode) this.t = 0;
    this.mode = mode;
    this.t += dt;
    this.group.visible = !this.firstPerson;
    const cycle = this.t % 14;
    const sipping = mode === 'drink' || (mode === 'relax' && cycle < 5);
    const smoking = mode === 'smoke' || (mode === 'relax' && !sipping);
    const t = mode === 'relax' ? (sipping ? cycle : cycle - 5) : this.t % (sipping ? 5 : 9);
    const lift = smoothstep(0.2, 1.2, t) * (1 - smoothstep(sipping ? 2.7 : 3.5, sipping ? 3.6 : 4.4, t));
    const h = this.h;
    h.head.rotation.x = -0.34 * lift * Number(sipping);
    h.head.rotation.y *= 0.25;
    h.root.updateMatrixWorld(true);
    const shape = h.worn.hero ? HERO_LOOKS[h.worn.hero].portrait.shape : null;
    this.mouth.set(0, shape ? shape.eyeY + shape.mouth.y : 0.04, shape ? shape.eyeZ + shape.mouth.z + 0.005 : 0.11);
    h.head.localToWorld(this.mouth);
    h.torso.worldToLocal(this.mouth);

    this.bottle.visible = mode !== 'smoke';
    this.joint.visible = mode !== 'drink';
    if (this.bottle.visible) {
      this.axis.set(-0.12, 1, 0.12).lerp(this.target.set(0.35, -0.75, -0.55), sipping ? lift : 0).normalize();
      this.bottle.quaternion.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, this.axis);
      this.target.copy(this.mouth).addScaledVector(this.axis, -0.115);
      this.bottle.position.set(-0.25, 0.13, 0.19).lerp(this.target, sipping ? lift : 0);
      h.reach('R', this.target.copy(this.bottle.position).add(this.pole.set(0, 0, -0.02)), this.pole.set(-1, 0.5, 0.35));
    }
    if (this.joint.visible) {
      this.joint.position.set(0.25, 0.20, 0.22).lerp(this.target.copy(this.mouth).add(this.pole.set(0.004, 0, 0.027)), smoking ? lift : 0);
      this.joint.rotation.set(-0.15 + lift * 0.15, -0.15, -0.15);
      h.reach('L', this.target.copy(this.joint.position).add(this.pole.set(0, 0, -0.02)), this.pole.set(1, -0.35, 0.4));
    }
    this.tip.set(0, 0, 0.069).applyQuaternion(this.joint.quaternion).add(this.joint.position);
    // A generous exhale expands outward from the lips, then rises and hangs around the shoulders.
    const exhale = smoking ? smoothstep(3.4, 4.2, t) * (1 - smoothstep(6.8, 8.8, t)) : 0;
    const exhaleAge = Math.max(0, t - 3.4);
    for (let i = 0; i < this.puffs.length; i++) {
      const puff = this.puffs[i];
      const plume = i >= 8;
      const age = (this.t * 0.27 + (i % 8) / 8) % 1;
      puff.visible = this.joint.visible && (!plume || exhale > 0);
      if (plume) {
        const layer = (i - 8) / 20;
        const drift = Math.min(1.2, exhaleAge * 0.24) + layer * 0.12;
        const spread = 0.05 + drift * 0.20;
        puff.position.copy(this.mouth).add(this.target.set(
          Math.sin(i * 2.399 + this.t * 0.35) * spread + drift * 0.07,
          Math.cos(i * 1.73) * spread * 0.5 + drift * 0.32,
          0.08 + drift * 0.40 + layer * 0.08,
        ));
        puff.scale.setScalar(0.16 + drift * 0.58 + layer * 0.12);
        (puff.material as THREE.SpriteMaterial).opacity = exhale * (0.23 + 0.06 * Math.sin(i * 1.7));
      } else {
        puff.position.copy(this.tip).add(this.target.set(Math.sin(age * 8 + i) * 0.07 + age * 0.08, 0.02 + age * 0.50, age * 0.12));
        puff.scale.setScalar(0.028 + age * 0.19);
        (puff.material as THREE.SpriteMaterial).opacity = Math.sin(Math.PI * age) * 0.27;
      }
    }
  }

  dispose() {
    for (const puff of this.puffs) (puff.material as THREE.SpriteMaterial).dispose();
    this.group.removeFromParent();
  }
}
