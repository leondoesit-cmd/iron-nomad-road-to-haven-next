import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { kitMaterial } from './materials';
import { shared } from './dispose';
import type { AnimalKind } from '../data';
import { PART_BIT } from '../sim/anatomy';

export const MAX_PER_KIND = 40;

/**
 * Wild animals: each species is one instanced body mesh plus one instanced limb mesh (legs, or wings for birds).
 * Legs are separate instances so they can swing from the hip with a plain matrix, no skinning, and a whole herd
 * stays at two draw calls per species. Models face +Z with the feet at y = 0.
 */

interface Model {
  body: THREE.BufferGeometry;
  /** One limb geometry per entry, hanging from (0,0,0): a leg, or a wing reaching along +x / -x. */
  limbs: THREE.BufferGeometry[];
  /** Where each limb instance sits in the body frame, and how it moves. */
  mounts: { x: number; y: number; z: number; limb: number; /** phase offset in radians */ off: number; kind: 'leg' | 'wing' | 'head' | 'stump'; slot?: number; /** Bit of the hidden-part mask that takes this one off. */ bit: number }[];
  /** Length of a leg, for how far a body sags when some are gone. */
  legLen?: number;
  /** Instances of the first limb mesh per animal. */
  per?: number;
  /** Pairs of legs move together (a bounding hare) instead of diagonally. */
  bound?: boolean;
  /** Radians of hip swing at a full run. */
  swing: number;
}

const fur = (c: number, w = 0.4) => S.cloth(c, w);

interface QuadSpec {
  len: number;
  h: number;
  w: number;
  leg: number;
  legR: number;
  /** Shoulder height above the back line (a hump) and its length along the spine. */
  hump?: number;
  neck: [number, number];
  head: [number, number, number];
  snout: number;
  ear: number;
  earSpread: number;
  tail: [number, number, number];
  coat: number;
  belly: number;
  mark?: number;
  bound?: boolean;
  tusks?: boolean;
  horns?: boolean;
  floppy?: boolean;
  seed: number;
}

function quadruped(sp: QuadSpec): Model {
  const b = new MeshBuilder();
  b.jitter = 0.09;
  b.seed(sp.seed);
  const coat = fur(sp.coat);
  const belly = fur(sp.belly, 0.3);
  const mark = fur(sp.mark ?? sp.coat);
  const dark = S.skin(0x1a1412);
  const cy = sp.leg + sp.h * 0.5 - 0.03; // body centre height
  const topY = cy + sp.h * 0.5;
  const fz = sp.len * 0.5;
  // Barrel torso: a stretched ellipsoid with a lighter belly and a rump patch.
  b.add('sphere16', 0, cy, 0, sp.w * 2, sp.h * 1.05, sp.len * 1.05, coat);
  b.add('sphere16', 0, cy - sp.h * 0.2, 0, sp.w * 1.6, sp.h * 0.7, sp.len * 0.8, belly);
  if (sp.mark !== undefined) b.add('sphere16', 0, cy + sp.h * 0.05, -fz * 0.82, sp.w * 1.5, sp.h * 0.8, sp.len * 0.28, mark);
  // Shoulder hump (boar, bear) and a bristle ridge along the spine.
  if (sp.hump) {
    b.add('sphere16', 0, topY - 0.03, fz * 0.38, sp.w * 1.8, sp.h * 0.5 + sp.hump, sp.len * 0.42, coat);
  }
  // Neck and head: their own mesh, hinged at the base of the neck, so the head can graze, snap up and be shot off.
  const hb = new MeshBuilder();
  hb.jitter = 0.09;
  hb.seed(sp.seed + 3);
  const pivot: [number, number, number] = [0, topY - sp.h * 0.25, fz * 0.62];
  const nx = sp.neck[0];
  const ny = sp.neck[1];
  const hx = 0;
  const hy = topY + ny;
  const hz = fz * 0.9 + nx;
  hb.limb(0, topY - sp.h * 0.25, fz * 0.62, hx, hy - 0.02, hz - 0.04, sp.h * 0.42, sp.head[0] * 0.55, coat, 10);
  hb.add('sphere16', hx, hy, hz, sp.head[0] * 2, sp.head[1] * 2, sp.head[2] * 2, coat);
  // Muzzle, nose, eyes.
  const mz = hz + sp.head[2] * 0.6 + sp.snout * 0.5;
  hb.limb(hx, hy - sp.head[1] * 0.1, hz + sp.head[2] * 0.4, hx, hy - sp.head[1] * 0.25, mz, sp.head[0] * 0.62, sp.head[0] * 0.4, sp.belly === sp.coat ? coat : belly, 8, true);
  hb.sphereAt(hx, hy - sp.head[1] * 0.2, mz + sp.head[0] * 0.25, sp.head[0] * 0.22, dark);
  for (const sx of [1, -1]) hb.sphereAt(sx * sp.head[0] * 0.78, hy + sp.head[1] * 0.25, hz + sp.head[2] * 0.35, sp.head[0] * 0.14, S.glow(0xe8c070, 0.35));
  // Ears.
  for (const sx of [1, -1]) {
    if (sp.floppy) hb.add('sphere', sx * sp.head[0] * 0.95, hy + sp.head[1] * 0.1, hz - sp.head[2] * 0.2, sp.ear * 0.5, sp.ear * 1.1, sp.ear * 0.5, mark, 0, 0, sx * 0.5);
    else hb.add('cone6', sx * sp.earSpread, hy + sp.head[1] * 0.8 + sp.ear * 0.4, hz - sp.head[2] * 0.25, sp.ear * 0.55, sp.ear * 1.2, sp.ear * 0.3, coat, -0.15, 0, sx * -0.25);
  }
  if (sp.tusks) {
    for (const sx of [1, -1]) hb.limb(sx * sp.head[0] * 0.55, hy - sp.head[1] * 0.45, mz - 0.04, sx * sp.head[0] * 0.75, hy + sp.head[1] * 0.1, mz + 0.06, 0.016, 0.006, S.rock(0xe6dcc0), 6, true);
  }
  if (sp.horns) {
    for (const sx of [1, -1]) {
      hb.limb(sx * 0.05, hy + sp.head[1] * 0.8, hz - 0.04, sx * 0.1, hy + sp.head[1] * 0.8 + 0.2, hz - 0.1, 0.018, 0.012, S.rock(0x5a4a3a), 6, true);
      hb.limb(sx * 0.1, hy + sp.head[1] * 0.8 + 0.2, hz - 0.1, sx * 0.07, hy + sp.head[1] * 0.8 + 0.34, hz - 0.03, 0.012, 0.006, S.rock(0x5a4a3a), 6, true);
    }
  }
  // What shows at the shoulder when the head is gone: raw neck. Its own part, drawn only once the head has come off.
  const sb = new MeshBuilder();
  sb.jitter = 0.06;
  sb.seed(sp.seed + 5);
  sb.sphereAt(0, sp.h * 0.12, sp.h * 0.12, sp.h * 0.34, S.skin(0x5a0c0a));
  // Tail.
  const [tl, tr, tu] = sp.tail;
  b.limb(0, cy + sp.h * 0.25, -fz * 0.95, 0, cy + sp.h * 0.25 + tu, -fz * 0.95 - tl, tr, tr * 0.6, coat, 8, true);
  if (sp.bound) b.sphereAt(0, cy + sp.h * 0.3 + tu, -fz * 0.95 - tl, tr * 1.2, belly);
  // One leg, hanging from the hip: thigh, shin, hoof or paw.
  const lb = new MeshBuilder();
  lb.jitter = 0.07;
  lb.seed(sp.seed + 11);
  const L = sp.leg + 0.03;
  lb.limb(0, 0, 0, 0, -L * 0.5, 0.012, sp.legR * 1.5, sp.legR * 1.05, coat, 8, true);
  lb.limb(0, -L * 0.5, 0.012, 0, -L + sp.legR * 0.8, 0, sp.legR * 1.0, sp.legR * 0.8, coat, 8, true);
  lb.rbox(0, -L + sp.legR * 0.55, sp.legR * 0.5, sp.legR * 1.9, sp.legR * 1.2, sp.legR * 3.2, sp.legR * 0.4, sp.tusks || sp.horns ? S.leather(0x241c18, 0.6) : dark);
  const lx = sp.w * 0.62;
  const ly = sp.leg + 0.02;
  const lz = fz * 0.66;
  const hg = hb.build();
  hg.translate(-pivot[0], -pivot[1], -pivot[2]);
  return {
    body: b.build(),
    limbs: [lb.build(), hg, sb.build()],
    mounts: [
      { x: lx, y: ly, z: lz, limb: 0, off: 0, kind: 'leg', bit: PART_BIT.legLF },
      { x: -lx, y: ly, z: lz, limb: 0, off: sp.bound ? 0.5 : Math.PI, kind: 'leg', bit: PART_BIT.legRF },
      { x: lx, y: ly, z: -lz, limb: 0, off: sp.bound ? Math.PI + 0.5 : Math.PI, kind: 'leg', bit: PART_BIT.legLB },
      { x: -lx, y: ly, z: -lz, limb: 0, off: sp.bound ? Math.PI : 0, kind: 'leg', bit: PART_BIT.legRB },
      { x: pivot[0], y: pivot[1], z: pivot[2], limb: 1, off: 0, kind: 'head', bit: PART_BIT.head },
      { x: pivot[0], y: pivot[1], z: pivot[2], limb: 2, off: 0, kind: 'stump', bit: PART_BIT.head },
    ],
    legLen: L,
    bound: sp.bound,
    swing: sp.bound ? 0.9 : 0.7,
  };
}

function vulture(): Model {
  const b = new MeshBuilder();
  b.jitter = 0.08;
  b.seed(401);
  const dark = fur(0x2b2622, 0.5);
  const ruff = fur(0xd8d0c0, 0.4);
  const skin = S.skin(0xb06a5a);
  b.add('sphere16', 0, 0, 0, 0.34, 0.3, 0.7, dark);
  b.limb(0, 0.04, 0.22, 0, 0.12, 0.42, 0.06, 0.04, skin, 8, true);
  b.add('sphere16', 0, 0.14, 0.45, 0.13, 0.13, 0.17, skin);
  b.add('cone6', 0, 0.11, 0.56, 0.05, 0.12, 0.05, S.rock(0x6a5c48), Math.PI / 2 + 0.3, 0, 0);
  b.add('sphere16', 0, 0.06, 0.34, 0.2, 0.1, 0.12, ruff);
  b.add('box', 0, -0.02, -0.46, 0.26, 0.02, 0.32, dark);
  for (const sx of [1, -1]) b.limb(sx * 0.07, -0.1, -0.05, sx * 0.07, -0.26, 0.0, 0.015, 0.012, skin, 6, true);
  const wing = (sign: number, seed: number) => {
    const w = new MeshBuilder();
    w.jitter = 0.08;
    w.seed(seed);
    // A shoulder, a forearm and a fan of long primaries trailing behind.
    w.limb(0, 0, 0.05, sign * 0.55, 0.04, 0.02, 0.05, 0.035, dark, 6, true);
    w.add('box', sign * 0.5, 0.0, -0.1, 1.0, 0.014, 0.34, dark);
    for (let i = 0; i < 5; i++) {
      const x = sign * (0.95 + i * 0.12);
      w.add('box', x, 0.0, -0.1 - i * 0.03, 0.2, 0.012, 0.3 - i * 0.03, dark);
    }
    w.add('box', sign * 0.4, 0.0, 0.1, 0.8, 0.012, 0.12, ruff);
    return w.build();
  };
  return {
    body: b.build(),
    limbs: [wing(1, 402), wing(-1, 403)],
    mounts: [
      { x: 0.12, y: 0.06, z: 0.05, limb: 0, off: 0, kind: 'wing', bit: PART_BIT.wingL },
      { x: -0.12, y: 0.06, z: 0.05, limb: 1, off: 0, kind: 'wing', bit: PART_BIT.wingR },
    ],
    swing: 0,
  };
}

/** Everything the renderer needs per species, built on first use. */
const RAW: Record<AnimalKind, () => Model> = {
  hare: () =>
    quadruped({ len: 0.4, h: 0.2, w: 0.1, leg: 0.17, legR: 0.03, neck: [0.04, 0.08], head: [0.05, 0.055, 0.07], snout: 0.05, ear: 0.2, earSpread: 0.04, tail: [0.07, 0.04, 0.02], coat: 0x9a8460, belly: 0xd8ccb0, mark: 0xb89a6a, bound: true, seed: 101 }),
  deer: () =>
    quadruped({ len: 0.95, h: 0.4, w: 0.15, leg: 0.8, legR: 0.04, neck: [0.28, 0.4], head: [0.09, 0.1, 0.18], snout: 0.16, ear: 0.17, earSpread: 0.1, tail: [0.12, 0.04, 0.0], coat: 0xa87e50, belly: 0xe2d4b6, mark: 0xece2cc, horns: true, seed: 102 }),
  dog: () =>
    quadruped({ len: 0.68, h: 0.26, w: 0.1, leg: 0.42, legR: 0.04, neck: [0.14, 0.14], head: [0.085, 0.09, 0.15], snout: 0.16, ear: 0.13, earSpread: 0.06, tail: [0.3, 0.025, 0.16], coat: 0x6a5846, belly: 0x948468, mark: 0x3e342c, seed: 103 }),
  wolf: () =>
    quadruped({ len: 0.78, h: 0.3, w: 0.12, leg: 0.5, legR: 0.045, neck: [0.17, 0.12], head: [0.095, 0.1, 0.17], snout: 0.19, ear: 0.13, earSpread: 0.07, tail: [0.36, 0.035, -0.04], coat: 0x6e7174, belly: 0xa8a49a, mark: 0x3a3c40, seed: 104 }),
  boar: () =>
    quadruped({ len: 1.0, h: 0.5, w: 0.22, leg: 0.36, legR: 0.045, hump: 0.12, neck: [0.14, 0.0], head: [0.15, 0.15, 0.2], snout: 0.17, ear: 0.12, earSpread: 0.12, tail: [0.12, 0.02, 0.02], coat: 0x54443a, belly: 0x6e5c4c, mark: 0x3a2f28, tusks: true, seed: 105 }),
  bear: () =>
    quadruped({ len: 1.45, h: 0.8, w: 0.36, leg: 0.62, legR: 0.1, hump: 0.2, neck: [0.2, -0.04], head: [0.2, 0.19, 0.27], snout: 0.18, ear: 0.1, earSpread: 0.17, tail: [0.06, 0.05, 0.0], coat: 0x4c443e, belly: 0x5e554c, mark: 0x7a7066, floppy: true, seed: 106 }),
  vulture,
};

function finish(m: Model): Model {
  const seen: number[] = [];
  for (const mt of m.mounts) {
    seen[mt.limb] = (seen[mt.limb] ?? 0) + 1;
    mt.slot = seen[mt.limb] - 1;
  }
  m.per = seen[0] ?? 0;
  return m;
}

interface Batch {
  model: Model;
  body: THREE.InstancedMesh;
  limbs: THREE.InstancedMesh[];
  count: number;
}

const _m = new THREE.Matrix4();
const _b = new THREE.Matrix4();
const _l = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();
const _qa = new THREE.Quaternion();

/** What a body is doing besides walking; see `AnimalRenderer.push`. */
export interface AnimalPose {
  mask?: number;
  head?: number;
  look?: number;
  rear?: number;
  fold?: number;
}
const NO_POSE: AnimalPose = {};

export class AnimalRenderer {
  readonly group = new THREE.Group();
  private batches = new Map<AnimalKind, Batch>();

  private batch(kind: AnimalKind): Batch {
    let b = this.batches.get(kind);
    if (b) return b;
    const model = finish(RAW[kind]());
    const mat = kitMaterial({ detail: false, side: kind === 'vulture' ? THREE.DoubleSide : THREE.FrontSide });
    const mk = (g: THREE.BufferGeometry, n: number) => {
      shared(g);
      const m = new THREE.InstancedMesh(g, mat, n);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.count = 0;
      m.setColorAt(0, _c.set(1, 1, 1));
      this.group.add(m);
      return m;
    };
    const perLimb = model.per ?? 1;
    b = { model, body: mk(model.body, MAX_PER_KIND), limbs: model.limbs.map((g) => mk(g, MAX_PER_KIND * perLimb)), count: 0 };
    this.batches.set(kind, b);
    return b;
  }

  begin() {
    for (const b of this.batches.values()) b.count = 0;
  }

  /**
   * One animal. `gait` is 0 standing to 1 flat out, `roll` lays it on its side (dead), `flap` drives the wings,
   * `bank` leans a flier into its turn, and `tint` multiplies the coat. `pose` is everything a living body does besides walk:
   * `mask` the parts that are gone, `head` how far the head is lowered (+) or raised (-), `look` how far it is turned,
   * `rear` how far the front is lifted (a bear on its hind legs), `fold` how far a bird's wings are tucked in.
   */
  push(kind: AnimalKind, scale: number, x: number, y: number, z: number, yaw: number, phase: number, gait: number, roll: number, flap: number, bank: number, tint: number, pose: AnimalPose = NO_POSE) {
    const b = this.batch(kind);
    if (b.count >= MAX_PER_KIND) return;
    const i = b.count++;
    const mdl = b.model;
    const mask = pose.mask ?? 0;
    // Legs gone: the body sags toward the side that is missing them and the legs that are left shorten to meet the ground.
    let gone = 0;
    let front = 0;
    let side = 0;
    if (mdl.legLen) {
      for (const m of mdl.mounts) {
        if (m.kind !== 'leg' || !(mask & m.bit)) continue;
        gone++;
        front += m.z > 0 ? 1 : -1;
        side += m.x > 0 ? 1 : -1;
      }
    }
    const sag = gone >= 3 ? 0.8 : gone === 2 ? 0.42 : gone === 1 ? 0.14 : 0;
    // A hare bounds, a deer stots (all four feet off the ground at once, high and springy), the rest bob.
    const bounce = kind === 'hare' ? Math.abs(Math.sin(phase)) * 0.16 * gait : kind === 'deer' ? Math.abs(Math.sin(phase * 0.6)) * 0.3 * gait * gait * scale : Math.abs(Math.sin(phase)) * 0.04 * gait * scale;
    const pitch = (kind === 'hare' ? Math.sin(phase) * 0.25 * gait : 0) + front * 0.1 * Math.min(1, gone) - (pose.rear ?? 0) * 0.55;
    _e.set(pitch, yaw, roll + bank - side * 0.09 * Math.min(1, gone), 'YXZ');
    _q.setFromEuler(_e);
    _p.set(x, y + bounce - sag * (mdl.legLen ?? 0) * scale + (pose.rear ?? 0) * 0.3 * scale, z);
    _s.set(scale, scale, scale);
    _b.compose(_p, _q, _s);
    b.body.setMatrixAt(i, _b);
    b.body.setColorAt(i, _c.setScalar(tint));
    const per = mdl.per ?? 1;
    for (let k = 0; k < mdl.mounts.length; k++) {
      const m = mdl.mounts[k];
      let ang = 0;
      let sy = 1;
      let sx = 1;
      let yawL = 0;
      const off = (mask & m.bit) !== 0;
      if (m.kind === 'leg') {
        ang = Math.sin(phase + m.off) * mdl.swing * gait * (off ? 0.3 : 1);
        // A stump hangs short; the legs that are left shorten with the sag.
        sy = off ? 0.26 : 1 - sag * 0.7;
      } else if (m.kind === 'head') {
        ang = pose.head ?? 0;
        yawL = pose.look ?? 0;
        if (off) sx = sy = 0;
      } else if (m.kind === 'stump') {
        if (!off) sx = sy = 0;
      } else {
        const fold = pose.fold ?? 0;
        ang = (Math.sin(flap + m.off) * 0.7 * (1 - fold) - fold * 1.3) * (m.x > 0 ? 1 : -1) + (m.x > 0 ? 0.08 : -0.08);
        sx = 1 - fold * 0.4;
        if (off) sx = sy = 0;
      }
      _p.set(m.x, m.y, m.z);
      if (m.kind === 'leg') _e.set(ang, 0, 0);
      else if (m.kind === 'head') _e.set(ang, yawL, 0, 'YXZ');
      else if (m.kind === 'stump') _e.set(0, 0, 0);
      else _e.set(0, 0, ang);
      _qa.setFromEuler(_e);
      _l.compose(_p, _qa, _s.set(sx, sy, sx));
      _m.multiplyMatrices(_b, _l);
      const idx = m.limb === 0 ? i * per + (m.slot ?? 0) : i;
      b.limbs[m.limb].setMatrixAt(idx, _m);
      b.limbs[m.limb].setColorAt(idx, _c.setScalar(tint));
    }
  }

  end() {
    for (const b of this.batches.values()) {
      const per = b.model.per ?? 1;
      b.body.count = b.count;
      b.body.instanceMatrix.needsUpdate = true;
      if (b.body.instanceColor) b.body.instanceColor.needsUpdate = true;
      b.limbs.forEach((l, i) => {
        l.count = b.count * (i === 0 ? per : 1);
        l.instanceMatrix.needsUpdate = true;
        if (l.instanceColor) l.instanceColor.needsUpdate = true;
      });
    }
  }

  dispose() {
    for (const b of this.batches.values()) {
      b.body.dispose();
      b.limbs.forEach((l) => l.dispose());
      b.model.body.dispose();
      b.model.limbs.forEach((g) => g.dispose());
    }
    this.batches.clear();
  }
}
