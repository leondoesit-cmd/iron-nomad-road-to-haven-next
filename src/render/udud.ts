import * as THREE from 'three';
import { smoothstep } from '../core/math';
import { MeshBuilder, S } from './builder';
import { shared } from './dispose';
import type { Humanoid, PoseKind } from './humanoid';
import { kitMaterial } from './materials';
import { drawGlasses } from './spectacles';
import { UDUD, UDUD_GLASSES } from './ududLook';

let glassesGeometry: THREE.BufferGeometry | undefined;
function spectacles() {
  if (glassesGeometry) return glassesGeometry;
  const b = new MeshBuilder();
  drawGlasses(b, UDUD, UDUD_GLASSES, true);
  // The small pale hinge inserts visible in the reference.
  for (const side of [-1, 1]) b.box(side * 0.068, UDUD.shape.eyeY + 0.015, UDUD.shape.eyeZ + 0.025, 0.006, 0.002, 0.002, S.metal(0xc8bb99, 0));
  return glassesGeometry = shared(b.build());
}

/** Uneven pauses between short adjustments: reach, push the frame up, then settle the hand again. */
function adjustment(time: number) {
  const t = time % 45;
  const start = t < 20 ? 8 : t < 35 ? 23 : 40;
  return { t: t - start, lift: smoothstep(start, start + 0.7, t) * (1 - smoothstep(start + 1.3, start + 2.1, t)) };
}

/** Udud's personal seated idle and independently moving spectacles on the normal playable rig. */
export class UdudRig {
  readonly glasses = new THREE.Mesh(spectacles(), kitMaterial({ detail: false }));
  private time = 0;
  private firstPerson = false;
  private target = new THREE.Vector3();
  private pole = new THREE.Vector3();

  constructor(private h: Humanoid) {
    this.glasses.name = 'udud-prescription-glasses';
    this.glasses.castShadow = true;
    h.head.add(this.glasses);
    this.update(0, 'stand', false);
  }

  setFirstPerson(on: boolean) {
    this.firstPerson = on;
    this.glasses.visible = !on && this.compatible();
  }

  private compatible() {
    const face = this.h.worn.look?.face.style ?? 'bandana';
    return face === 'none' || face === 'bandana' || face === 'respirator';
  }

  update(dt: number, pose: PoseKind, idleAllowed: boolean) {
    const h = this.h;
    const sitting = pose === 'sit' || pose === 'seat';
    const idle = sitting && idleAllowed;
    this.time = idle ? this.time + dt : 0;
    this.glasses.visible = !this.firstPerson && this.compatible();
    this.glasses.position.set(0, 0, 0);
    this.glasses.rotation.set(0, 0, 0);
    if (!sitting) return;

    // A comfortable recline, with the head upright and a small breathing motion.
    const breath = Math.sin(this.time * 1.35) * 0.009;
    h.torso.rotation.x = -0.30 + breath;
    h.head.rotation.x = 0.27 - breath;
    h.head.rotation.y = Math.sin(this.time * 0.37) * 0.045;
    if (!idle) return;
    const ground = pose === 'sit';
    for (const side of ['L', 'R'] as const) {
      const sign = side === 'L' ? 1 : -1;
      h.reach(side, this.target.set(sign * (ground ? 0.20 : 0.31), ground ? 0.08 : 0.045, ground ? 0.42 : 0.20), this.pole.set(sign * 0.15, -0.4, -1));
    }
    if (!this.compatible()) return;
    const { t, lift } = adjustment(this.time);
    // The frame slips a few millimetres during the approach, then the finger pushes it back up.
    const slip = smoothstep(-1.2, 0.55, t) * (1 - smoothstep(0.72, 1.14, t)) * 0.0045;
    this.glasses.position.y = -slip;
    this.glasses.rotation.x = slip * 2;
    if (lift < 0.001) return;
    const s = UDUD.shape;
    this.target.set(-s.eyeX - 0.018, s.eyeY + 0.006 - slip, s.eyeZ + 0.035);
    h.head.updateMatrix();
    this.target.applyMatrix4(h.head.matrix);
    h.reach('R', this.target, this.pole.set(-0.75, -0.15, 0.4), lift);
    h.hand.rotation.z = -0.15 * lift;
  }

  dispose() {
    this.glasses.removeFromParent();
  }
}

let chairGeometry: THREE.BufferGeometry | undefined;
function chair() {
  if (chairGeometry) return chairGeometry;
  const b = new MeshBuilder();
  const frame = S.metal(0x363b3c, 0.08), fabric = S.cloth(0x6d7776, 0.08);
  // Low canvas chair with a backward-sloping backrest, rounded rails and broad armrests.
  b.rbox(0, 0.443, 0.055, 0.58, 0.055, 0.48, 0.025, fabric);
  b.rbox(0, 0.79, -0.29, 0.58, 0.65, 0.04, 0.022, fabric, -0.30, 0, 0);
  for (const sign of [-1, 1]) {
    b.capsule(sign * 0.31, 0.03, 0.32, sign * 0.31, 0.69, -0.22, 0.019, frame, 10);
    b.capsule(sign * 0.31, 0.03, -0.34, sign * 0.31, 0.69, 0.24, 0.019, frame, 10);
    b.capsule(sign * 0.31, 0.46, -0.19, sign * 0.31, 1.11, -0.40, 0.018, frame, 10);
    b.rbox(sign * 0.31, 0.70, 0.04, 0.09, 0.035, 0.45, 0.015, S.plastic(0x444b4a, 0.05));
    for (const z of [-0.34, 0.32]) b.rbox(sign * 0.31, 0.024, z, 0.06, 0.04, 0.06, 0.01, S.rubber(0x232525));
  }
  b.capsule(-0.31, 0.14, -0.25, 0.31, 0.14, -0.25, 0.013, frame, 8);
  return chairGeometry = shared(b.build());
}

/** Portrait showcase: Udud settles into his chair and occasionally corrects his glasses. */
export class UdudLounger {
  readonly group = new THREE.Group();
  constructor(readonly h: Humanoid) {
    this.group.name = 'udud-lounge';
    const seat = new THREE.Mesh(chair(), kitMaterial());
    seat.name = 'udud-lounge-chair';
    seat.castShadow = seat.receiveShadow = true;
    this.group.add(seat, h.root);
    h.setWeapon('none');
    this.update(0);
  }

  update(dt: number) {
    this.h.update(dt, 'seat', 0, 0, 0);
    // The seat supports the bottom of the pelvis; his boots meet the floor in the stock seated leg pose.
    this.h.hips.position.y = 0.59 / this.h.root.scale.y;
  }
}
