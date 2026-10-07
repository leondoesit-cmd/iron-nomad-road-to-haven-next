import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { kitMaterial } from './materials';
import { drawEars, portraitGeometry, portraitMaterial, type PortraitSpec } from './portrait';
import { melabesPose } from '../world/melabes';

/** Appearance sculpted from the user's frontal and three-quarter worker references. */
export const MELABES_WORKER_LOOK: PortraitSpec = {
  id: 'melabes-worker',
  shape: {
    eyeY: 0.108, eyeX: 0.033, eyeZ: 0.092, eyeW: 0.0155, eyeOpen: 0.006,
    eyeTilt: -0.0018, eyeSmile: 0.0005, irisY: 0.0004, irisR: 0.0058,
    top: 0.233, halfW: 0.086, back: -0.109, brow: 0.013,
    cheekbone: [0.060, -0.014, -0.012, 0.030], cheek: [0.048, -0.044, 0.002, 0.032],
    jowl: [0.048, -0.088, -0.025, 0.023], eyeBag: 0.0055, underChin: 0.024,
    nose: { tipY: -0.042, tipZ: 0.038, tipR: 0.0155, baseY: -0.055, halfW: 0.0205, bridge: 0.011, bridgeR: 0.0078 },
    mouth: { y: -0.081, halfW: 0.031, z: 0.015, upper: 0.0055, lower: 0.0095, lift: [-0.0007, 0.0008], open: 0.0038, hollow: 0.0025 },
    jaw: [0.061, -0.084, -0.087], chin: { y: -0.124, z: -0.004, halfW: 0.035, r: 0.019 },
    neck: { r: 0.068, z: -0.016 }, ear: { top: 0.011, h: 0.070, w: 0.033, z: -0.090, flare: 0.46 },
  },
  hair: {
    line: [[0, 0.083], [35, 0.092], [55, 0.092], [70, 0.050], [80, 0.008], [95, 0.002], [115, -0.028], [180, -0.049]],
    top: 0.0018, side: 0.004, back: 0.004, taper: 0.010, groove: 0.0004,
    crownDensity: 0.075, sweep: 0.12, strand: 0.45, color: 0xb9b5ae, tip: 0xe4ded3, rough: 0.76,
  },
  beard: { line: [[0, -0.08], [90, -0.07]], color: 0xa69c8c, tip: 0xd3cec2, depth: 0, chin: 0, jaw: 0, cheek: 0, grey: 1 },
  paint: {
    skin: 0xb98561, flush: 0xb87d64, rosy: 0.28, shade: 0x88614e, lip: 0xa97669, iris: 0x37291e,
    brow: { color: 0x403931, head: [0.012, 0.013], peak: [0.034, 0.0165], tail: [0.059, 0.010], thick: [0.009, 0.0075, 0.0035] },
    crease: 0.0045, lash: 0.55, forehead: 0.8, crows: 0.95, folds: 0.65,
    age: 0.85, skinRoughness: 0.48, lipRoughness: 0.62, scalpGloss: 0.19,
  },
};

const UP = new THREE.Vector3(0, 1, 0);

/** A shop worker walks around both spits, carves each stack, then offers portions at the counter. */
export class MelabesWorker {
  readonly root = new THREE.Group();
  readonly head = new THREE.Group();
  readonly knife = new THREE.Group();
  readonly plate = new THREE.Group();
  readonly rightHand = new THREE.Group();
  readonly leftHand = new THREE.Group();
  private arms: [THREE.Mesh, THREE.Mesh][] = [];
  private geos: THREE.BufferGeometry[] = [];
  private shavings: THREE.Mesh[] = [];
  private meat: THREE.Mesh;
  private legs: THREE.Group[] = [];
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private shoulder = new THREE.Vector3();
  private reach = new THREE.Vector3();
  private bend = new THREE.Vector3();

  constructor() {
    this.root.name = 'melabes-worker';
    const skin = S.skin(MELABES_WORKER_LOOK.paint.skin);
    const navy = S.cloth(0x172034, 0.18);
    const white = S.cloth(0xecebe3, 0.16);
    const body = new MeshBuilder();
    body.jitter = 0.02;
    // Dark blazer and open white collar from the reference photograph.
    body.rbox(0, 1.15, 0, 0.48, 0.58, 0.26, 0.09, navy);
    body.rbox(0, 1.2, 0.14, 0.24, 0.48, 0.04, 0.025, white);
    for (const side of [-1, 1]) {
      body.box(side * 0.077, 1.43, 0.16, 0.10, 0.12, 0.025, white, 0, 0, side * 0.4);
      body.box(side * 0.14, 1.27, 0.167, 0.075, 0.32, 0.025, navy, 0, 0, -side * 0.22);
      const leg = new THREE.Group();
      leg.position.set(side * 0.12, 0.91, 0);
      const trousers = new MeshBuilder();
      trousers.capsule(0, -0.73, 0, 0, 0, 0, 0.085, S.cloth(0x242832, 0.2));
      trousers.rbox(0, -0.825, 0.04, 0.16, 0.13, 0.29, 0.035, S.leather(0x22211f));
      leg.add(this.mesh(trousers));
      this.legs.push(leg);
      this.root.add(leg);
    }
    this.root.add(this.mesh(body));
    this.head.position.set(0, 1.51, 0);
    this.head.scale.setScalar(1.13);
    const face = new THREE.Mesh(portraitGeometry(MELABES_WORKER_LOOK, 'full'), portraitMaterial(MELABES_WORKER_LOOK));
    face.castShadow = true;
    this.head.add(face);
    const ears = new MeshBuilder();
    drawEars(ears, MELABES_WORKER_LOOK);
    this.head.add(this.mesh(ears));
    this.root.add(this.head);
    for (const hand of [this.rightHand, this.leftHand]) {
      const palm = new MeshBuilder();
      palm.rbox(0, 0, 0, 0.07, 0.085, 0.045, 0.018, skin);
      palm.capsule(0.032, -0.005, 0, 0.045, -0.033, 0.02, 0.011, skin);
      hand.add(this.mesh(palm));
      this.root.add(hand);
      const upper = new MeshBuilder();
      upper.cyl(0, 0, 0, 0.115, 1, 0.115, navy, 0, 0, 0, 10);
      const fore = new MeshBuilder();
      fore.cyl(0, 0, 0, 0.085, 1, 0.085, navy, 0, 0, 0, 10);
      fore.cyl(0, 0.45, 0, 0.088, 0.1, 0.088, white, 0, 0, 0, 10);
      const parts: [THREE.Mesh, THREE.Mesh] = [this.mesh(upper), this.mesh(fore)];
      parts[0].name = 'worker-upper-arm';
      parts[1].name = 'worker-forearm';
      this.arms.push(parts);
      this.root.add(...parts);
    }
    const blade = new MeshBuilder();
    blade.rbox(0, 0, 0, 0.035, 0.11, 0.035, 0.01, S.plastic(0x26231f));
    blade.box(0, -0.19, 0, 0.045, 0.28, 0.006, S.chrome());
    this.knife.add(this.mesh(blade));
    this.rightHand.add(this.knife);
    const dish = new MeshBuilder();
    dish.cyl(0, 0.035, 0, 0.28, 0.018, 0.28, S.plastic(0xeee9dd), 0, 0, 0, 20);
    dish.torus(0, 0.049, 0, 0.132, 0.009, S.plastic(0xf7f3e8), Math.PI / 2, 0, 0, 6, 20);
    this.plate.add(this.mesh(dish));
    this.plate.position.x = -0.18;
    const portion = new MeshBuilder();
    for (let i = 0; i < 16; i++) portion.box(Math.sin(i * 2.4) * 0.07, 0.065 + (i % 4) * 0.012, Math.cos(i * 2.4) * 0.07, 0.075, 0.016, 0.025, S.plastic(i % 2 ? 0xa97042 : 0xc38d55), 0, i * 0.5, 0);
    this.meat = this.mesh(portion);
    this.plate.add(this.meat);
    this.leftHand.add(this.plate);
    for (let i = 0; i < 4; i++) {
      const shaving = new MeshBuilder();
      shaving.box(0, 0, 0, 0.055, 0.012, 0.024, S.plastic(0xb7804c));
      const flake = this.mesh(shaving);
      this.shavings.push(flake);
      this.root.add(flake);
    }
    this.update(0);
  }

  private mesh(b: MeshBuilder) {
    const geometry = b.build();
    this.geos.push(geometry);
    const mesh = new THREE.Mesh(geometry, kitMaterial());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  private segment(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3) {
    mesh.position.copy(from).add(to).multiplyScalar(0.5);
    mesh.scale.y = from.distanceTo(to);
    this.b.copy(to).sub(from).normalize();
    mesh.quaternion.setFromUnitVectors(UP, this.b);
  }

  update(time: number, remaining = 2) {
    const pose = melabesPose(time);
    const { serving, carving, stroke } = pose;
    this.root.position.set(pose.x, pose.walk ? Math.abs(Math.sin(time * 7)) * 0.012 : 0, pose.z);
    this.root.rotation.y = pose.yaw;
    this.legs.forEach((leg, i) => leg.rotation.x = pose.walk * Math.sin(time * 7 + i * Math.PI) * 0.28);
    if (carving) {
      this.rightHand.position.set(-0.53, 1.67 - stroke * 0.34, 0.31);
      this.leftHand.position.set(-0.22, 1.18, 0.33);
    } else if (serving) {
      this.rightHand.position.set(-0.18, 1.25, 0.18);
      this.leftHand.position.set(0.15, 1.19, 0.59);
    } else {
      this.rightHand.position.set(-0.3, 1.06, 0.18);
      this.leftHand.position.set(0.12, 1.16, 0.37);
    }
    this.knife.rotation.z = carving ? -0.30 : 0.4;
    this.knife.visible = !serving;
    this.plate.rotation.x = -0.03 * Math.sin(time * 2);
    this.meat.visible = !serving || remaining > 0;
    this.meat.scale.setScalar(pose.portion * (serving && remaining === 1 ? 0.65 : 1));
    this.head.rotation.y = carving ? -0.28 : 0;
    this.head.rotation.x = carving ? 0.08 : 0;
    for (let i = 0; i < 2; i++) {
      const hand = i ? this.leftHand : this.rightHand;
      const side = i ? 1 : -1;
      const shoulder = this.shoulder.set(side * 0.225, 1.41, 0);
      const reach = this.reach.copy(hand.position).sub(shoulder);
      const distance = reach.length();
      reach.normalize();
      // Two equal 32 cm segments: bend the elbow without stretching either sleeve.
      const bend = this.bend.set(side * 0.4, -1, 0);
      bend.addScaledVector(reach, -bend.dot(reach)).normalize();
      const elbow = this.a.copy(shoulder).addScaledVector(reach, distance / 2)
        .addScaledVector(bend, Math.sqrt(Math.max(0, 0.32 ** 2 - (distance / 2) ** 2)));
      this.segment(this.arms[i][0], shoulder, elbow);
      this.segment(this.arms[i][1], elbow, hand.position);
    }
    this.shavings.forEach((flake, i) => {
      const fall = (stroke + i * 0.23) % 1;
      flake.visible = carving;
      flake.position.set(-0.53 + Math.sin(i * 2) * 0.05, 1.51 - fall * 0.37, 0.38 + fall * 0.06);
      flake.rotation.set(fall * 3, i, fall * 4);
    });
  }

  dispose() {
    for (const geometry of this.geos) geometry.dispose();
    this.geos.length = 0;
    this.root.removeFromParent();
    // Portrait geometry/material and the kit material belong to their shared caches.
  }
}
