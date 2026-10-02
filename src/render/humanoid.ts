import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { C } from './palette';
import { shared } from './dispose';
import { kitMaterial } from './materials';

const mat = kitMaterial();
const basicLight = shared(new THREE.MeshBasicMaterial({ color: 0xfff6d0 }));
const flashMat = shared(new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 4.2, 1.6), transparent: true, opacity: 0.95, depthWrite: false }));
const flashGeo = shared(new THREE.IcosahedronGeometry(0.11, 1));

export type PoseKind = 'stand' | 'ride' | 'seat' | 'downed' | 'gun';

interface Palette {
  jacket: number;
  trim: number;
  pants?: number;
  skin?: number;
  helmet?: number;
  /** Scarf / bandana colour (defaults to the trim). */
  scarf?: number;
  /** Raider look: skull mask, spiked pauldrons, no backpack. */
  mask?: boolean;
}

type Part = 'pelvis' | 'torso' | 'head' | 'upperL' | 'upperR' | 'foreL' | 'foreR' | 'thighL' | 'thighR' | 'shinL' | 'shinR';

const partCache = new Map<string, Record<Part, THREE.BufferGeometry>>();

/** Build (once per palette) the eleven body-part meshes of a survivor or raider. Origins sit on the joints. */
function bodyParts(p: Palette): Record<Part, THREE.BufferGeometry> {
  const key = JSON.stringify(p);
  const hit = partCache.get(key);
  if (hit) return hit;
  const jacket = S.cloth(p.jacket, 0.55);
  const jacketDark = S.cloth(new THREE.Color(p.jacket).multiplyScalar(0.62).getHex(), 0.6);
  const trim = S.cloth(p.trim, 0.5);
  const pants = S.cloth(p.pants ?? 0x3d3f3a, 0.6);
  const skin = S.skin(p.skin ?? C.skin);
  const leather = S.leather(0x3b2a1e, 0.5);
  const boot = S.leather(0x2a211b, 0.6);
  const glove = S.leather(0x2b2622, 0.4);
  const buckle = S.metal(0x8a8478, 0.4);
  const helmet = p.mask ? S.metal(p.helmet ?? 0x111111, 0.5) : S.paint(p.helmet ?? p.trim, 0.6);
  const scarf = S.cloth(p.scarf ?? p.trim, 0.45);
  const raider = !!p.mask;
  const mk = (fn: (b: MeshBuilder) => void) => {
    const b = new MeshBuilder();
    b.jitter = 0.03;
    b.roundSeg = 2;
    fn(b);
    return shared(b.build());
  };
  const parts: Record<Part, THREE.BufferGeometry> = {
    pelvis: mk((b) => {
      b.rbox(0, -0.02, 0, 0.33, 0.2, 0.21, 0.07, pants);
      // Belt with buckle and pouches.
      b.rbox(0, 0.07, 0, 0.35, 0.055, 0.23, 0.025, leather);
      b.box(0, 0.07, 0.118, 0.06, 0.045, 0.01, buckle);
      for (const sx of [1, -1]) b.rbox(sx * 0.15, 0.03, 0.06, 0.07, 0.09, 0.06, 0.015, raider ? leather : trim);
      b.rbox(-0.1, 0.03, -0.11, 0.1, 0.09, 0.06, 0.015, leather);
    }),
    torso: mk((b) => {
      // Abdomen and chest: a tapered jacket body.
      b.limb(0, 0.06, 0, 0, 0.26, 0, 0.14, 0.16, jacket, 14);
      b.rbox(0, 0.34, 0, 0.4, 0.3, 0.24, 0.1, jacket);
      for (const sx of [1, -1]) b.sphereAt(sx * 0.19, 0.44, 0, 0.085, jacket);
      // Collar and zip.
      b.torus(0, 0.5, 0, 0.085, 0.03, jacketDark, Math.PI / 2, 0, 0, 8, 16);
      b.box(0, 0.3, 0.121, 0.012, 0.36, 0.008, buckle);
      if (raider) {
        // Leather harness, spiked pauldrons.
        b.box(0.06, 0.3, 0.125, 0.05, 0.4, 0.01, leather, 0, 0, 0.5);
        b.box(-0.06, 0.3, 0.125, 0.05, 0.4, 0.01, leather, 0, 0, -0.5);
        for (const sx of [1, -1]) {
          b.add('dome', sx * 0.2, 0.46, 0, 0.2, 0.14, 0.2, S.metal(0x2a2826, 0.6), 0, 0, -sx * 0.4);
          for (let i = 0; i < 3; i++) b.add('cone6', sx * (0.2 + i * 0.02), 0.52 + i * 0.01, -0.04 + i * 0.04, 0.035, 0.1, 0.035, S.metal(0x9a9a9a, 0.3), 0, 0, -sx * 0.5);
        }
      } else {
        // Chest rig with magazine pouches, shoulder straps and a backpack with a bedroll.
        b.rbox(0, 0.3, 0.115, 0.34, 0.22, 0.05, 0.015, trim);
        for (const sx of [-1, 0, 1]) b.rbox(sx * 0.1, 0.27, 0.15, 0.085, 0.12, 0.04, 0.012, S.cloth(new THREE.Color(p.trim).multiplyScalar(0.8).getHex(), 0.6));
        for (const sx of [1, -1]) b.box(sx * 0.12, 0.38, 0.0, 0.05, 0.02, 0.27, leather, 0.0, 0, 0);
        b.rbox(0, 0.32, -0.19, 0.32, 0.38, 0.16, 0.05, S.cloth(0x4a4636, 0.7));
        b.rbox(0, 0.22, -0.28, 0.22, 0.16, 0.05, 0.02, S.cloth(0x3e3a2e, 0.7));
        b.capsule(-0.16, 0.54, -0.19, 0.16, 0.54, -0.19, 0.065, S.cloth(0x5d5a40, 0.6), 10);
        for (const sx of [1, -1]) b.box(sx * 0.12, 0.54, -0.19, 0.012, 0.14, 0.14, leather);
      }
      // Scarf wrapped at the neck.
      b.torus(0, 0.52, 0.01, 0.075, 0.035, scarf, Math.PI / 2, 0, 0, 8, 16);
      b.box(0.05, 0.43, -0.09, 0.07, 0.16, 0.02, scarf, 0.2, 0, 0.1);
      b.capsule(0, 0.54, 0, 0, 0.62, 0, 0.05, skin, 8);
    }),
    head: mk((b) => {
      b.add('sphere16', 0, 0.1, 0.005, 0.19, 0.23, 0.21, skin);
      if (raider) {
        // Bone-white skull mask with dark sockets; spiked crest on the helmet.
        b.add('sphere16', 0, 0.09, 0.03, 0.2, 0.22, 0.2, S.paint(0xd9d2bf, 0.6));
        for (const sx of [1, -1]) b.add('sphere', sx * 0.045, 0.12, 0.122, 0.055, 0.045, 0.02, S.paint(0x0c0a08, 0.2));
        b.box(0, 0.03, 0.125, 0.08, 0.025, 0.02, S.paint(0x0c0a08, 0.2));
        b.add('dome', 0, 0.15, 0, 0.23, 0.17, 0.24, helmet);
        for (let i = 0; i < 5; i++) b.add('cone6', 0, 0.26, -0.08 + i * 0.045, 0.03, 0.09 + (i === 2 ? 0.04 : 0), 0.03, S.metal(0xa0a0a0, 0.3));
      } else {
        // Nose, ears and a bandana pulled up over the mouth.
        b.add('cone6', 0, 0.11, 0.108, 0.035, 0.05, 0.03, skin, -0.25, 0, 0);
        for (const sx of [1, -1]) b.add('sphere', sx * 0.096, 0.1, 0.0, 0.025, 0.05, 0.035, skin);
        b.add('sphere16', 0, 0.035, 0.035, 0.198, 0.1, 0.195, scarf);
        b.add('cone6', 0, -0.02, 0.07, 0.11, 0.07, 0.05, scarf, Math.PI, 0, 0);
        // Helmet with brim, goggles pushed up on it.
        b.add('dome', 0, 0.14, 0, 0.235, 0.19, 0.25, helmet);
        b.cyl(0, 0.14, 0, 0.245, 0.02, 0.26, helmet, 0, 0, 0, 16);
        b.torus(0, 0.19, 0, 0.115, 0.012, S.leather(0x1c1a18, 0.3), Math.PI / 2 - 0.25, 0, 0, 6, 18);
        for (const sx of [1, -1]) {
          b.cyl(sx * 0.045, 0.21, 0.105, 0.065, 0.035, 0.065, S.metal(0x2a2a2a, 0.4), Math.PI / 2 - 0.4, 0, 0, 12);
          b.cyl(sx * 0.045, 0.218, 0.122, 0.052, 0.008, 0.052, S.glass(0x2a4a58), Math.PI / 2 - 0.4, 0, 0, 12);
        }
        // Eyes and brow under the helmet.
        for (const sx of [1, -1]) b.add('sphere', sx * 0.04, 0.115, 0.098, 0.03, 0.018, 0.012, S.skin(0x1a1410));
      }
    }),
    upperL: mk((b) => upperArm(b, jacket, raider)),
    upperR: mk((b) => upperArm(b, jacket, raider)),
    foreL: mk((b) => forearm(b, jacket, glove)),
    foreR: mk((b) => forearm(b, jacket, glove)),
    thighL: mk((b) => thigh(b, pants, trim, 1)),
    thighR: mk((b) => thigh(b, pants, trim, -1)),
    shinL: mk((b) => shin(b, pants, boot, raider)),
    shinR: mk((b) => shin(b, pants, boot, raider)),
  };
  partCache.set(key, parts);
  return parts;
}

function upperArm(b: MeshBuilder, jacket: ReturnType<typeof S.cloth>, raider: boolean) {
  b.limb(0, -0.02, 0, 0, -0.27, 0, 0.065, 0.054, jacket, 10);
  if (raider) b.box(0, -0.16, 0, 0.13, 0.04, 0.13, S.leather(0x2a1e16, 0.5));
}

function forearm(b: MeshBuilder, jacket: ReturnType<typeof S.cloth>, glove: ReturnType<typeof S.leather>) {
  b.limb(0, 0, 0, 0, -0.2, 0, 0.052, 0.044, jacket, 10);
  // Rolled cuff, gloved hand with a thumb.
  b.torus(0, -0.2, 0, 0.045, 0.014, jacket, Math.PI / 2, 0, 0, 6, 12);
  b.rbox(0, -0.27, 0.005, 0.07, 0.11, 0.05, 0.02, glove);
  b.capsule(0.03, -0.24, 0.03, 0.035, -0.28, 0.045, 0.014, glove, 6);
}

function thigh(b: MeshBuilder, pants: ReturnType<typeof S.cloth>, trim: ReturnType<typeof S.cloth>, side: number) {
  b.limb(0, 0, 0, 0, -0.42, 0, 0.088, 0.066, pants, 12);
  // Cargo pocket and a holster strap.
  b.rbox(side * 0.08, -0.22, 0.0, 0.03, 0.13, 0.1, 0.01, pants);
  b.torus(0, -0.3, 0, 0.074, 0.008, S.leather(0x2b2018, 0.4), Math.PI / 2, 0, 0, 6, 14);
  void trim;
}

function shin(b: MeshBuilder, pants: ReturnType<typeof S.cloth>, boot: ReturnType<typeof S.leather>, raider: boolean) {
  b.limb(0, 0, 0, 0, -0.3, 0, 0.064, 0.052, pants, 12);
  // Knee pad.
  b.rbox(0, -0.03, 0.055, 0.1, 0.11, 0.04, 0.02, raider ? S.metal(0x3a3632, 0.6) : S.plastic(0x2a2a2a, 0.6));
  // Boot: shaft, laced front, toe cap and sole.
  b.rbox(0, -0.36, 0.0, 0.11, 0.16, 0.12, 0.04, boot);
  b.rbox(0, -0.42, 0.06, 0.105, 0.08, 0.2, 0.035, boot);
  b.rbox(0, -0.465, 0.06, 0.115, 0.025, 0.23, 0.01, S.rubber(0x161412));
  for (let i = 0; i < 4; i++) b.box(0, -0.3 - i * 0.03, 0.06, 0.05, 0.006, 0.01, S.cloth(0x6a5a44, 0.3));
}

// ------------------------------------------------------------------------------------- weapons

type Held = 'none' | 'pistol' | 'rifle' | 'wrench' | 'jerrycan' | 'crowbar' | 'flare';
const weaponCache = new Map<Held, THREE.BufferGeometry>();

function weaponGeometry(kind: Exclude<Held, 'none'>): THREE.BufferGeometry {
  const hit = weaponCache.get(kind);
  if (hit) return hit;
  const b = new MeshBuilder();
  b.jitter = 0.02;
  const gun = S.metal(0x232426, 0.35);
  const grip = S.plastic(0x1a1a1a, 0.3);
  switch (kind) {
    case 'pistol':
      b.rbox(0, 0.03, 0.12, 0.034, 0.05, 0.22, 0.008, gun);
      b.rbox(0, -0.035, 0.04, 0.03, 0.11, 0.05, 0.008, grip, -0.25, 0, 0);
      b.box(0, -0.0, 0.085, 0.012, 0.03, 0.04, gun);
      b.cyl(0, 0.035, 0.235, 0.014, 0.02, 0.014, S.metal(0x0a0a0a), Math.PI / 2, 0, 0, 8);
      break;
    case 'rifle':
      b.rbox(0, 0.02, 0.25, 0.05, 0.08, 0.5, 0.01, gun);
      b.cyl(0, 0.035, 0.62, 0.024, 0.32, 0.024, gun, Math.PI / 2, 0, 0, 8);
      b.rbox(0, -0.01, -0.12, 0.045, 0.1, 0.26, 0.015, S.wood(0x5a3e28, 0.5));
      b.rbox(0, -0.06, 0.2, 0.035, 0.13, 0.05, 0.008, gun, 0.3, 0, 0);
      b.cyl(0, 0.1, 0.2, 0.04, 0.16, 0.04, S.metal(0x111111, 0.3), Math.PI / 2, 0, 0, 10);
      break;
    case 'wrench':
      b.rbox(0, 0, 0.22, 0.03, 0.045, 0.44, 0.01, S.chrome(0xa8acb0));
      b.torus(0, 0, 0.47, 0.045, 0.016, S.chrome(0xa8acb0), 0, Math.PI / 2, 0, 6, 12);
      b.box(0, 0, -0.01, 0.034, 0.07, 0.07, S.chrome(0xa8acb0));
      break;
    case 'jerrycan': {
      b.rbox(0.05, -0.12, 0.1, 0.12, 0.34, 0.26, 0.02, S.paint(C.fuel, 0.7));
      b.box(0.05, 0.06, 0.06, 0.03, 0.03, 0.12, S.paint(C.fuel, 0.7));
      break;
    }
    case 'crowbar':
      b.pipe([[0, 0, -0.05], [0, 0, 0.5], [0, 0.04, 0.58], [0, 0.1, 0.6]], 0.014, S.paint(0x3a3f46, 0.7), 8);
      break;
    case 'flare':
      b.cyl(0, 0, 0.13, 0.04, 0.26, 0.04, S.paint(0xd23a3a, 0.5), Math.PI / 2, 0, 0, 10);
      b.cyl(0, 0, 0.27, 0.042, 0.03, 0.042, S.glow(0xffd28a, 3), Math.PI / 2, 0, 0, 10);
      break;
  }
  const g = shared(b.build());
  weaponCache.set(kind, g);
  return g;
}

/** A survivor or raider. Origin at the feet, facing +Z. */
export class Humanoid {
  root = new THREE.Group();
  hips = new THREE.Group();
  torso = new THREE.Group();
  head = new THREE.Group();
  armL = new THREE.Group();
  armR = new THREE.Group();
  elbowL = new THREE.Group();
  elbowR = new THREE.Group();
  legL = new THREE.Group();
  legR = new THREE.Group();
  kneeL = new THREE.Group();
  kneeR = new THREE.Group();
  hand = new THREE.Group();
  flash = new THREE.Mesh(flashGeo, flashMat);
  private weapon: THREE.Mesh | null = null;
  private held: Held = 'none';
  private walkT = 0;
  meshes: THREE.Mesh[] = [];
  /** Everything but the arms and what they hold: hidden from the owner's own first-person view. */
  private bodyMeshes: THREE.Mesh[] = [];

  constructor(pal: Palette) {
    const g = bodyParts(pal);
    const mk = (geo: THREE.BufferGeometry, parent: THREE.Object3D) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      parent.add(m);
      this.meshes.push(m);
      return m;
    };
    this.root.add(this.hips);
    this.hips.position.y = 0.92;
    this.bodyMeshes.push(mk(g.pelvis, this.hips));
    this.hips.add(this.torso);
    this.bodyMeshes.push(mk(g.torso, this.torso));
    this.torso.add(this.head);
    this.head.position.y = 0.6;
    this.bodyMeshes.push(mk(g.head, this.head));
    for (const [arm, elbow, upper, fore, sx] of [
      [this.armL, this.elbowL, g.upperL, g.foreL, 1],
      [this.armR, this.elbowR, g.upperR, g.foreR, -1],
    ] as const) {
      this.torso.add(arm);
      arm.position.set(sx * 0.22, 0.45, 0);
      mk(upper, arm);
      arm.add(elbow);
      elbow.position.y = -0.28;
      mk(fore, elbow);
    }
    this.elbowR.add(this.hand);
    this.hand.position.set(0, -0.27, 0.02);
    for (const [leg, knee, thigh, shin, sx] of [
      [this.legL, this.kneeL, g.thighL, g.shinL, 1],
      [this.legR, this.kneeR, g.thighR, g.shinR, -1],
    ] as const) {
      this.hips.add(leg);
      leg.position.set(sx * 0.1, -0.02, 0);
      this.bodyMeshes.push(mk(thigh, leg));
      leg.add(knee);
      knee.position.y = -0.43;
      this.bodyMeshes.push(mk(shin, knee));
    }
    this.flash.visible = false;
    this.hand.add(this.flash);
    this.flash.position.set(0, 0.03, 0.32);
  }

  /**
   * First person: hide the head, torso and legs, so the camera at the eyes sees only the arms and what they hold.
   * Applied just before the owner's view draws and undone just after, so a partner's view still sees the whole survivor.
   */
  setFirstPerson(on: boolean) {
    for (const m of this.bodyMeshes) m.visible = !on;
  }

  /** Swap the item in the right hand. Cheap to call every frame: geometry is cached per item. */
  setWeapon(kind: Held) {
    if (kind === this.held) return;
    this.held = kind;
    if (this.weapon) {
      this.hand.remove(this.weapon);
      this.weapon = null;
    }
    if (kind === 'none') return;
    const m = new THREE.Mesh(weaponGeometry(kind), mat);
    m.castShadow = true;
    this.hand.add(m);
    this.weapon = m;
  }

  private carried: THREE.Object3D | null = null;

  /** Hold something in both arms in front of the chest (null to let go). The caller owns the object's geometry. */
  setCarry(obj: THREE.Object3D | null) {
    if (obj === this.carried) return;
    if (this.carried) this.torso.remove(this.carried);
    this.carried = obj;
    if (obj) {
      obj.position.set(0, 0.1, 0.42);
      this.torso.add(obj);
    }
  }

  /** Show the muzzle flash for one frame. */
  muzzle(on: boolean) {
    this.flash.visible = on;
    if (on) this.flash.rotation.set(Math.random() * 6, Math.random() * 6, 0);
  }

  /**
   * Pose the rig. `speed` is horizontal speed in m/s for walk cycles; `aim` raises the weapon arm;
   * `crouch` 0..1 lowers the stance, `air` 0..1 tucks the legs for a jump or a fall.
   */
  update(dt: number, pose: PoseKind, speed: number, aim: number, crouch: number, lookPitch = 0, air = 0) {
    this.walkT += dt * (1.5 + speed * 1.1);
    const run = Math.min(1, speed / 3.5) * (1 - air);
    const sw = Math.sin(this.walkT * 2) * run;
    const bob = Math.abs(Math.cos(this.walkT * 2)) * run;
    const r = this.root;
    const h = this.hips;
    r.rotation.x = 0;
    // The owner places the root (feet height, saddle offset); the pose must not touch its position.
    h.position.z = 0;
    this.torso.rotation.set(0, 0, 0);
    this.head.rotation.set(0, 0, 0);
    this.armL.rotation.set(0, 0, 0);
    this.armR.rotation.set(0, 0, 0);
    this.elbowL.rotation.set(0, 0, 0);
    this.elbowR.rotation.set(0, 0, 0);
    if (pose === 'stand' || pose === 'gun') {
      h.position.y = 0.92 - crouch * 0.32 + bob * 0.03;
      const bend = crouch * 1.1;
      this.legL.rotation.x = sw * 0.75 - bend * 0.4;
      this.legR.rotation.x = -sw * 0.75 - bend * 0.4;
      this.kneeL.rotation.x = Math.max(0, -sw) * 0.9 + bend + run * 0.15;
      this.kneeR.rotation.x = Math.max(0, sw) * 0.9 + bend + run * 0.15;
      this.torso.rotation.x = crouch * 0.35 + (speed > 5 ? 0.18 : 0.04);
      this.torso.rotation.y = sw * 0.12 * (1 - aim);
      this.armL.rotation.x = -sw * 0.65 * (1 - aim);
      this.armR.rotation.x = aim > 0.1 ? -1.4 * aim + lookPitch * 0.5 : sw * 0.65;
      this.armL.rotation.z = 0.08;
      this.armR.rotation.z = -0.08;
      this.elbowL.rotation.x = -0.25 - run * 0.5;
      this.elbowR.rotation.x = aim > 0.1 ? -0.1 : -0.25 - run * 0.5;
      if (aim > 0.1) {
        // Support hand comes across to the grip.
        this.armL.rotation.x = -1.2 * aim + lookPitch * 0.45;
        this.armL.rotation.z = -0.45 * aim;
        this.elbowL.rotation.x = -0.55 * aim;
      }
      this.head.rotation.x = lookPitch * 0.4 - this.torso.rotation.x * 0.6;
      if (air > 0) {
        // Off the ground: knees drawn up, one foot ahead of the other, arms out for balance.
        this.legL.rotation.x += (-0.55 - this.legL.rotation.x) * air;
        this.legR.rotation.x += (0.15 - this.legR.rotation.x) * air;
        this.kneeL.rotation.x += (1.1 - this.kneeL.rotation.x) * air;
        this.kneeR.rotation.x += (0.7 - this.kneeR.rotation.x) * air;
        if (aim <= 0.1) {
          this.armL.rotation.z += (0.55 - this.armL.rotation.z) * air;
          this.armR.rotation.z += (-0.55 - this.armR.rotation.z) * air;
        }
      }
      if (this.carried) {
        // Both arms cradle the load, elbows in, leaning back a touch against the weight.
        this.armL.rotation.set(-1.05, 0, -0.28);
        this.armR.rotation.set(-1.05, 0, 0.28);
        this.elbowL.rotation.x = -0.65;
        this.elbowR.rotation.x = -0.65;
        this.torso.rotation.x -= 0.06;
        this.torso.rotation.y = 0;
      }
    } else if (pose === 'ride') {
      // Astride a moped: hips down, knees bent, arms out to the bars.
      h.position.y = 0.45;
      this.legL.rotation.x = -1.15;
      this.legR.rotation.x = -1.15;
      this.legL.rotation.z = 0.12;
      this.legR.rotation.z = -0.12;
      this.kneeL.rotation.x = 1.45;
      this.kneeR.rotation.x = 1.45;
      this.torso.rotation.x = 0.5;
      this.armL.rotation.x = -0.95;
      this.armR.rotation.x = -0.95;
      this.armL.rotation.z = 0.25;
      this.armR.rotation.z = -0.25;
      this.elbowL.rotation.x = -0.55;
      this.elbowR.rotation.x = -0.55;
      this.head.rotation.x = -0.45;
    } else if (pose === 'seat') {
      h.position.y = 0.4;
      this.legL.rotation.x = -1.4;
      this.legR.rotation.x = -1.4;
      this.kneeL.rotation.x = 1.5;
      this.kneeR.rotation.x = 1.5;
      this.torso.rotation.x = 0.1;
      this.armL.rotation.x = -0.75;
      this.armR.rotation.x = -0.75;
      this.armL.rotation.z = 0.15;
      this.armR.rotation.z = -0.15;
      this.elbowL.rotation.x = -0.7;
      this.elbowR.rotation.x = -0.7;
      this.head.rotation.x = -0.05;
    } else if (pose === 'downed') {
      r.rotation.x = -Math.PI / 2;
      h.position.z = 0.2; // local +z is world up once the body lies on its back
      h.position.y = 0.92;
      this.legL.rotation.x = 0.2 + Math.sin(this.walkT) * 0.1;
      this.legR.rotation.x = -0.1;
      this.kneeL.rotation.x = 0.4;
      this.kneeR.rotation.x = 0.3;
      this.armL.rotation.x = -0.4 + Math.sin(this.walkT * 0.7) * 0.15;
      this.armR.rotation.x = 0.3;
      this.elbowL.rotation.x = -0.6;
      this.elbowR.rotation.x = -0.3;
      this.torso.rotation.x = 0;
      this.head.rotation.x = -0.5;
    }
  }

  dispose() {
    // Geometry is shared per palette and per weapon; nothing to free per instance.
  }
}

export { basicLight };
