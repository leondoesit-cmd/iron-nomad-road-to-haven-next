import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { kitMaterial } from './materials';
import { shared } from './dispose';
import { clamp01, lerp, smoothstep } from '../core/math';
import { HERO_LOOKS, RO_BITE, RO_LAUGH } from './heroLooks';
import { crateGeometry, plateGeometry } from './cake';
import type { Humanoid } from './humanoid';
import { warmPortrait, type PortraitSpec } from './portrait';

/**
 * A big double cheeseburger in a glossy brioche bun, a bottle of beer, and someone sat on a crate at a crate table with
 * both: Ro Karab's party piece. Two-handed bites (the burger tipped up, its top bun facing out, as in his photo), the
 * burger down on the plate, a long pull on the beer, then a laugh that rocks him over the table. Over and over; a new
 * burger when one is finished.
 *
 * Everything here is in the eater's frame: feet at the origin, facing +Z, +X to his left. The burger's own frame has its
 * bottom at y 0 and the side that gets bitten toward -Z.
 */

const mat = kitMaterial();
/** Food has no wear, grain or weave. */
const foodMat = kitMaterial({ detail: false });

/** Radius of the bun, and how many bites a burger takes. */
export const BURGER_RADIUS = 0.068;
export const BITES = 5;
/** Each bite is a round mouthful this wide, its middle this far along -Z..+Z and a little off to one side. */
const BITE_R = 0.036;
const BITE_AT: [number, number][] = [
  [0.01, -BURGER_RADIUS - 0.012],
  [-0.016, -BURGER_RADIUS + 0.016],
  [0.014, -BURGER_RADIUS + 0.044],
  [-0.008, -BURGER_RADIUS + 0.074],
  [0, -BURGER_RADIUS + 0.12],
];

interface Layer {
  y0: number;
  y1: number;
  /** Radius round the burger as a share of the bun's, by angle (frilly lettuce, cheese corners). */
  rad: (a: number) => number;
  surf: { c: number; r: number; m: number; w: number };
  /** The colour where a bite has cut through it, if not the same. */
  cut?: { c: number; r: number; m: number; w: number };
  /** Height the top domes up above `y1` in the middle (the top bun). */
  dome?: number;
}

const BUN = { c: 0xb1602a, r: 0.32, m: 0, w: 0 };
const CRUMB = { c: 0xe2c287, r: 0.9, m: 0, w: 0 };
/** Inside a patty: browner and a touch pink against its seared outside. */
const PATTY_CUT = { c: 0x6b3b2a, r: 0.85, m: 0, w: 0 };
const LAYERS: Layer[] = [
  { y0: 0, y1: 0.018, rad: () => 1, surf: BUN, cut: CRUMB },
  { y0: 0.018, y1: 0.024, rad: (a) => 1.07 + 0.035 * Math.sin(a * 9) + 0.015 * Math.sin(a * 23), surf: { c: 0x5f9230, r: 0.6, m: 0, w: 0 } },
  { y0: 0.024, y1: 0.043, rad: (a) => 1.03 + 0.012 * Math.sin(a * 5 + 1), surf: { c: 0x4a2a1a, r: 0.82, m: 0, w: 0 }, cut: PATTY_CUT },
  { y0: 0.043, y1: 0.047, rad: (a) => 1.05 + 0.05 * Math.max(0, Math.cos(a * 4)) ** 3, surf: { c: 0xeea21c, r: 0.4, m: 0, w: 0 } },
  { y0: 0.047, y1: 0.062, rad: (a) => 1.01 + 0.012 * Math.sin(a * 6), surf: { c: 0x4a2a1a, r: 0.82, m: 0, w: 0 }, cut: PATTY_CUT },
  { y0: 0.062, y1: 0.066, rad: (a) => 0.92 + 0.03 * Math.sin(a * 7), surf: { c: 0x93a046, r: 0.45, m: 0, w: 0 } },
  { y0: 0.066, y1: 0.074, rad: () => 1, surf: BUN, cut: CRUMB, dome: 0.026 },
];
export const BURGER_HEIGHT = 0.074 + 0.026;

/** Is (x, z) inside one of the first `k` bites? */
const bitten = (x: number, z: number, k: number) => {
  for (let i = 0; i < k; i++) if ((x - BITE_AT[i][0]) ** 2 + (z - BITE_AT[i][1]) ** 2 < BITE_R * BITE_R) return true;
  return false;
};

/** A point inside what is left after `k` bites, that every edge of it can be seen from: what the outline is drawn round. */
function centreAfter(k: number): [number, number] {
  if (k === 0) return [0, 0];
  const [, bz] = BITE_AT[k - 1];
  return [0, Math.min(BURGER_RADIUS * 0.9, (bz + BITE_R + BURGER_RADIUS) / 2)];
}

const ROUND = 56;

/**
 * The outline of one layer after `k` bites, round the point `c`: a point per angle, and whether it is on a bite (a cut
 * face) or the burger's own edge.
 */
function outline(layer: Layer, k: number, c: [number, number]) {
  const pts: { x: number; z: number; cut: boolean }[] = [];
  for (let i = 0; i < ROUND; i++) {
    const a = (i / ROUND) * Math.PI * 2;
    const dx = Math.sin(a);
    const dz = -Math.cos(a);
    // Out along the ray to the edge of the layer (its radius depends on the angle round the burger's middle, so iterate).
    let t = BURGER_RADIUS;
    for (let n = 0; n < 4; n++) {
      const x = c[0] + dx * t;
      const z = c[1] + dz * t;
      const want = BURGER_RADIUS * layer.rad(Math.atan2(x, -z));
      // Solve |c + d t| = want for t.
      const b = c[0] * dx + c[1] * dz;
      const q = c[0] * c[0] + c[1] * c[1] - want * want;
      t = -b + Math.sqrt(Math.max(0, b * b - q));
    }
    // Then back in to the first bite on the way.
    let cut = false;
    const step = t / 40;
    for (let s = step; s <= t; s += step) {
      if (bitten(c[0] + dx * s, c[1] + dz * s, k)) {
        t = s - step * 0.5;
        cut = true;
        break;
      }
    }
    pts.push({ x: c[0] + dx * t, z: c[1] + dz * t, cut });
  }
  return pts;
}

/** Height of a layer's top at (x, z). */
const topAt = (l: Layer, x: number, z: number) => {
  if (!l.dome) return l.y1;
  const r = Math.hypot(x, z) / BURGER_RADIUS;
  return l.y1 + l.dome * Math.pow(clamp01(1 - r * r), 0.6);
};

/** Raw triangles with their own normals, to hand to a MeshBuilder as one coloured piece. */
class Tris {
  pos: number[] = [];
  nor: number[] = [];
  idx: number[] = [];
  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number) {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    return this.pos.length / 3 - 1;
  }
  geometry(smooth: boolean) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setIndex(this.idx);
    if (smooth) g.computeVertexNormals();
    return g;
  }
}

/** One layer after `k` bites: its top (domed or flat), its underside, its own edge and the faces the bites cut. */
function addLayer(b: MeshBuilder, l: Layer, k: number) {
  const c = centreAfter(k);
  const pts = outline(l, k, c);
  const top = new Tris();
  const RINGS = l.dome ? 6 : 1;
  // The top in rings from the centre out to the outline.
  const centre = top.vert(c[0], topAt(l, c[0], c[1]), c[1], 0, 1, 0);
  const ring: number[][] = [];
  for (let j = 1; j <= RINGS; j++) {
    const f = j / RINGS;
    ring.push(pts.map((p) => {
      const x = lerp(c[0], p.x, f);
      const z = lerp(c[1], p.z, f);
      return top.vert(x, topAt(l, x, z), z, 0, 1, 0);
    }));
  }
  for (let i = 0; i < ROUND; i++) {
    const n = (i + 1) % ROUND;
    top.idx.push(centre, ring[0][n], ring[0][i]);
    for (let j = 1; j < RINGS; j++) top.idx.push(ring[j - 1][i], ring[j - 1][n], ring[j][n], ring[j - 1][i], ring[j][n], ring[j][i]);
  }
  // The underside: a flat fan.
  const under = top.vert(c[0], l.y0, c[1], 0, -1, 0);
  const rim = pts.map((p) => top.vert(p.x, l.y0, p.z, 0, -1, 0));
  for (let i = 0; i < ROUND; i++) top.idx.push(under, rim[i], rim[(i + 1) % ROUND]);
  b.geo(top.geometry(!!l.dome), 0, 0, 0, 1, 1, 1, l.surf);

  // The sides, normals out across the outline; the bun's edge and the cut faces in their own colours.
  for (const cut of [false, true]) {
    const side = new Tris();
    for (let i = 0; i < ROUND; i++) {
      const n = (i + 1) % ROUND;
      const p = pts[i];
      const q = pts[n];
      if ((p.cut || q.cut) !== cut) continue;
      const nx = q.z - p.z;
      const nz = -(q.x - p.x);
      const m = Math.hypot(nx, nz) || 1;
      const a0 = side.vert(p.x, l.y0, p.z, nx / m, 0, nz / m);
      const a1 = side.vert(q.x, l.y0, q.z, nx / m, 0, nz / m);
      const b1 = side.vert(q.x, topAt(l, q.x, q.z), q.z, nx / m, 0, nz / m);
      const b0 = side.vert(p.x, topAt(l, p.x, p.z), p.z, nx / m, 0, nz / m);
      side.idx.push(a0, b1, a1, a0, b0, b1);
    }
    if (side.idx.length) b.geo(side.geometry(false), 0, 0, 0, 1, 1, 1, cut ? l.cut ?? l.surf : l.surf);
  }
}

const burgerGeos: THREE.BufferGeometry[] = [];
/** The burger after `k` bites (0 is a whole one). */
export function burgerGeometry(k: number): THREE.BufferGeometry {
  if (burgerGeos[k]) return burgerGeos[k];
  const b = new MeshBuilder();
  b.jitter = 0.04;
  for (const l of LAYERS) addLayer(b, l, k);
  return (burgerGeos[k] = shared(b.build()));
}

/** Where a bite goes in: the middle of the front of what is left after `k` bites, half way up (burger frame). */
export function bitePoint(k: number, out = new THREE.Vector3()) {
  const [bx, bz] = BITE_AT[Math.min(k, BITES - 1)];
  return out.set(bx * 0.6, 0.05, k === 0 ? -BURGER_RADIUS : Math.max(bz - BITE_R, BITE_AT[k - 1][1] + BITE_R - 0.004));
}

/** Bottle height, and where its mouth is from its base. */
export const BOTTLE_H = 0.235;
let bottleGeo: THREE.BufferGeometry | undefined;
/** A brown longneck beer bottle, standing on its base at the origin: a cream label round the body, the cap off. */
export function beerBottleGeometry(): THREE.BufferGeometry {
  if (bottleGeo) return bottleGeo;
  const b = new MeshBuilder();
  b.jitter = 0;
  const glass = { c: 0x3a1c08, r: 0.06, m: 0.1, w: 0.05 };
  b.lathe('beer-bottle', [
    [0, 0],
    [0.029, 0.001],
    [0.031, 0.006],
    [0.031, 0.13],
    [0.028, 0.15],
    [0.016, 0.178],
    [0.0125, 0.2],
    [0.0125, 0.226],
    [0.0145, 0.229],
    [0.0145, BOTTLE_H - 0.002],
    [0.011, BOTTLE_H],
    [0.009, BOTTLE_H - 0.004],
  ], 0, 0, 0, glass, 0, 0, 0, 24);
  b.lathe('beer-label', [
    [0.0318, 0.035],
    [0.0318, 0.105],
  ], 0, 0, 0, { c: 0xe8dcb8, r: 0.6, m: 0, w: 0.15 }, 0, 0, 0, 24);
  b.lathe('beer-neck-label', [
    [0.0132, 0.188],
    [0.0132, 0.208],
  ], 0, 0, 0, { c: 0x2f6b3a, r: 0.5, m: 0.2, w: 0.1 }, 0, 0, 0, 16);
  // The brand: a red oval across the front of the label.
  b.add('sphere16', 0, 0.07, 0.0316, 0.022, 0.016, 0.003, { c: 0xa8262c, r: 0.5, m: 0, w: 0 });
  return (bottleGeo = shared(b.build()));
}

/** The loop, in seconds: a bite, the burger down, a drink, a laugh, and the burger picked up again. */
export const LOOP = 12.5;
/** When the teeth meet (a bite gone), the bite face is on, the beer is at the lips, and the laugh is on. */
const BITE_T = 1.55;
const BITE_FACE: [number, number] = [1.05, 1.95];
const DRINK: [number, number] = [4.9, 6.3];
const LAUGH: [number, number] = [7.3, 11.2];

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _mouth = new THREE.Vector3();
const _face = new THREE.Vector3();
const _ahead = new THREE.Vector3();
const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

/** `a` at 0, `b` at 1, eased between `t0` and `t1`. */
const ease = (t0: number, t1: number, t: number) => smoothstep(0, 1, (t - t0) / (t1 - t0));

/**
 * Someone sat on a crate at a crate table, a burger on a plate and a beer beside it: a two-handed bite, the burger down,
 * a pull on the beer, a big laugh, and again. A hero with bite and laugh faces (Ro Karab) pulls them as he goes.
 *
 * Add `group` to a scene and call `update(dt)` every frame; the eater's rig is posed inside it.
 */
export class BurgerEater {
  readonly group = new THREE.Group();
  readonly burger: THREE.Mesh;
  readonly bottle: THREE.Mesh;
  /** Seconds into the loop, and how many bites are gone from this burger. */
  t = 0;
  eaten = 0;
  private bite: PortraitSpec | null;
  private laugh: PortraitSpec | null;
  private shown: PortraitSpec | null = null;
  /** The plate's middle (on its top) and where the bottle stands, and the table top's front edge. */
  readonly plateAt = new THREE.Vector3();
  readonly bottleAt = new THREE.Vector3();
  private tableTop = 0;

  /** The height he sits at, when it is someone else's chair rather than his own crate. */
  private seatTop: number | undefined;

  /**
   * `furniture: false` leaves out the crates (he sits on someone else's chair, at someone else's table at `tableH`), `seatTop`
   * sits him at that height, and `plateZ` puts the plate (and the beer beside it) that far out in front of him.
   */
  constructor(readonly h: Humanoid, opts: { bite?: PortraitSpec | null; laugh?: PortraitSpec | null; furniture?: boolean; tableH?: number; seatTop?: number; plateZ?: number } = {}) {
    const ro = h.worn.hero === 'ro';
    this.bite = opts.bite !== undefined ? opts.bite : ro ? RO_BITE : null;
    this.laugh = opts.laugh !== undefined ? opts.laugh : ro ? RO_LAUGH : null;
    for (const f of [this.bite, this.laugh]) if (f) warmPortrait(f);
    const g = this.group;
    g.add(h.root);
    h.root.position.set(0, 0, 0);
    h.root.rotation.set(0, 0, 0);
    this.seatTop = opts.seatTop;
    h.update(0.016, 'seat', 0, 0, 0);
    this.sit();
    h.root.updateMatrixWorld(true);
    const s = h.root.scale.y;
    const seatTop = opts.seatTop ?? h.hips.position.y * s - 0.09 * s;
    const seat = new THREE.Mesh(crateGeometry(0.46, seatTop, 0.42, 5), mat);
    seat.position.set(0, 0, -0.06);
    const tableH = opts.tableH ?? seatTop + 0.14;
    this.tableTop = tableH;
    const table = new THREE.Mesh(crateGeometry(0.62, tableH, 0.56, 11), mat);
    table.position.set(0, 0, 0.9);
    const plate = new THREE.Mesh(plateGeometry(0.13), foodMat);
    const pz = opts.plateZ ?? 0.72;
    plate.position.set(0.03, tableH, pz);
    this.plateAt.set(0.03, tableH + 0.02, pz);
    this.bottleAt.set(-0.19, tableH, pz - 0.02);
    this.burger = new THREE.Mesh(burgerGeometry(0), foodMat);
    this.burger.name = 'burger';
    this.bottle = new THREE.Mesh(beerBottleGeometry(), mat);
    this.bottle.name = 'beer-bottle';
    g.add(plate, this.burger, this.bottle);
    if (opts.furniture !== false) g.add(seat, table);
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.update(0);
  }

  /** On someone else's chair: the seat of his trousers at its height. */
  private sit() {
    if (this.seatTop === undefined) return;
    const s = this.h.root.scale.y;
    this.h.hips.position.y = (this.seatTop + 0.09 * s) / s;
  }

  /** The face on show now: biting, laughing, or his own. */
  get face(): PortraitSpec | null {
    return this.shown;
  }

  /** Burger on the plate, its bitten side toward him. */
  private burgerOnPlate(pos: THREE.Vector3, q: THREE.Quaternion) {
    pos.copy(this.plateAt);
    q.identity();
  }

  /**
   * Burger held up in both hands, tipped back so its top faces out and the bitten side comes up toward him: `lift` 0 low
   * in front of the chest, 1 with the next bite's spot at the lips.
   */
  private burgerHeld(lift: number, mouth: THREE.Vector3, face: THREE.Vector3, pos: THREE.Vector3, q: THREE.Quaternion) {
    q.setFromEuler(_e.set(lerp(0.55, 0.95, lift), 0, 0));
    const at = bitePoint(this.eaten, _v).applyQuaternion(q);
    // The mouth, or a hand's width down and out from it.
    pos.copy(mouth).addScaledVector(face, lerp(0.17, 0.004, lift)).add(_v2.set(0, lerp(-0.2, -0.004, lift), 0)).sub(at);
  }

  /** Bottle on the table, or up: `lift` 0 to 1 raises it to the chest, `tip` 0 to 1 takes it from the chest to the lips and tips it up. */
  private bottlePlace(lift: number, tip: number, mouth: THREE.Vector3, face: THREE.Vector3, pos: THREE.Vector3, q: THREE.Quaternion) {
    // Raised: upright in front of the chest, off to his right.
    _pa.copy(mouth).addScaledVector(face, 0.2).add(_v2.set(-0.09, -0.32, 0));
    pos.copy(this.bottleAt).lerp(_pa, lift);
    q.identity();
    if (tip <= 0) return;
    // At the lips: the mouth of the bottle on them, the base up and out, steeper as he drinks.
    const pull = clamp01((this.t - DRINK[0] - 0.3) / (DRINK[1] - DRINK[0] - 0.6));
    const up = lerp(0.2, 0.75, Math.sin(pull * Math.PI) * 0.4 + pull * 0.6);
    // Base to mouth: in toward the face and down, coming across from his right.
    const axis = _v3.copy(face).multiplyScalar(-Math.cos(up)).add(_v2.set(0.12, -Math.sin(up), 0)).normalize();
    _qb.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, axis);
    _pb.copy(mouth).addScaledVector(face, 0.004).addScaledVector(axis, -BOTTLE_H + 0.004);
    pos.lerp(_pb, tip);
    q.slerp(_qb, tip);
  }

  /** A hand on the knee: a little up the thigh from it, on top (group frame). */
  private kneeRest(knee: THREE.Object3D, hip: THREE.Object3D, out: THREE.Vector3) {
    knee.getWorldPosition(out);
    hip.getWorldPosition(_v2);
    out.lerp(_v2, 0.3);
    this.group.worldToLocal(out);
    return out.add(_v2.set(0, 0.08, 0));
  }

  update(dt: number) {
    const h = this.h;
    this.t += dt;
    if (this.t >= LOOP) {
      this.t -= LOOP;
      // A new burger when this one is finished.
      if (this.eaten >= BITES) this.eaten = 0;
    }
    const t = this.t;
    if (t >= BITE_T && t - dt < BITE_T && this.eaten < BITES) this.eaten++;
    this.burger.visible = this.eaten < BITES;
    this.burger.geometry = burgerGeometry(Math.min(this.eaten, BITES - 1));

    h.update(dt, 'seat', 0, 0, 0);
    this.sit();
    // How much the burger is in his hands (1), how far up toward the mouth it is, and the bottle's lift and tip.
    const holding = 1 - ease(2.9, 3.2, t) + ease(11.6, 11.9, t);
    const up = ease(0.15, 0.85, t) * (1 - ease(1.95, 2.9, t));
    const toMouth = ease(0.85, BITE_T - 0.1, t) * (1 - ease(BITE_T + 0.15, 1.95, t));
    const bLift = ease(3.95, 4.5, t) * (1 - ease(6.3, 6.95, t));
    const bTip = ease(4.5, DRINK[0], t) * (1 - ease(DRINK[1], 6.6, t));
    const laughK = ease(LAUGH[0], LAUGH[0] + 0.3, t) * (1 - ease(LAUGH[1] - 0.4, LAUGH[1], t));
    const shake = laughK * Math.sin((t - LAUGH[0]) * 15) * (0.6 + 0.4 * Math.sin((t - LAUGH[0]) * 2.1));

    // Lean in over the table while the hands are down at it, sit up to eat and drink, and rock with the laugh: back
    // first, then folded forward over the table.
    const low = (1 - Math.max(up, bLift)) * (1 - laughK);
    const fold = ease(LAUGH[0] + 0.7, LAUGH[0] + 1.4, t) * (1 - ease(LAUGH[1] - 0.8, LAUGH[1], t));
    h.torso.rotation.x = 0.12 + 0.34 * low + 0.08 * up - 0.12 * laughK * (1 - fold) + 0.32 * fold + 0.035 * shake;
    h.torso.rotation.z = 0.03 * laughK * Math.sin((t - LAUGH[0]) * 3.1);
    // Eyes down on the plate, up for the bite, head back for the beer and for the laugh, a chew after each bite.
    const chew = t > 1.95 && t < 4.2 ? Math.sin((t - 1.95) * 12) * 0.03 * smoothstep(4.2, 3.6, t) : 0;
    h.head.rotation.x = 0.35 * low + 0.12 * up - 0.06 * toMouth + chew - 0.42 * bTip - 0.32 * laughK * (1 - fold) - 0.05 * fold + 0.04 * shake;
    h.head.rotation.y = -0.04 + 0.12 * laughK * Math.sin((t - LAUGH[0]) * 1.3);
    h.root.updateMatrixWorld(true);

    // The mouth, and the way the face looks, in the group's frame.
    const look = h.worn.hero ? HERO_LOOKS[h.worn.hero].portrait.shape : null;
    const mouth = _mouth.set(0, look ? look.eyeY + look.mouth.y : 0.04, look ? look.eyeZ + look.mouth.z + 0.005 : 0.1);
    h.head.localToWorld(mouth);
    this.group.worldToLocal(mouth);
    const face = _face.set(0, 0, 1).transformDirection(h.head.matrixWorld);
    _q.copy(this.group.getWorldQuaternion(_q2)).invert();
    face.applyQuaternion(_q).normalize();
    // Level the face direction for placing things in front of it: the head tips, the way to the mouth does not.
    const ahead = _ahead.set(face.x, 0, face.z).normalize();

    // The burger: on the plate, or in his hands on the way up to the mouth.
    this.burgerOnPlate(_pa, _qa);
    this.burgerHeld(Math.max(toMouth, 0), mouth, ahead, _pb, _qb);
    const held = clamp01(up);
    this.burger.position.copy(_pa).lerp(_pb, held);
    this.burger.quaternion.copy(_qa).slerp(_qb, held);

    // The bottle.
    this.bottlePlace(bLift, bTip, mouth, ahead, this.bottle.position, this.bottle.quaternion);
    this.burger.updateMatrixWorld(true);
    this.bottle.updateMatrixWorld(true);

    // Hands. On the burger: a wrist to each side of the bun, a little back, the fingers over its top. Free hands rest on
    // the table's edge while he leans over it (the right fist pounding it in the laugh), on the knees while he sits up.
    const R = BURGER_RADIUS;
    const onTable = clamp01(Math.max(low, fold) * 1.6);
    const pound = Math.max(0, Math.sin((t - LAUGH[0] - 0.9) * 7.5)) * fold;
    const restL = this.kneeRest(h.kneeL, h.legL, _pa).lerp(_v.set(0.16, this.tableTop + 0.05, 0.6), onTable);
    const restR = this.kneeRest(h.kneeR, h.legR, _pb).lerp(_v.set(-0.13, this.tableTop + 0.05 + 0.1 * pound, 0.62), onTable);
    for (const side of ['L', 'R'] as const) {
      const sx = side === 'L' ? 1 : -1;
      const grip = this.burger.localToWorld(_v.set(sx * (R + 0.03), 0.045, 0.035));
      this.group.worldToLocal(grip);
      const rest = side === 'L' ? restL : restR;
      let target = _v2.copy(rest).lerp(grip, clamp01(holding));
      if (side === 'R' && holding < 1) {
        // The right hand to the bottle and back: the wrist behind its body, on his side of it.
        const onBottle = ease(3.4, 3.95, t) * (1 - ease(6.95, 7.3, t));
        const g2 = this.bottle.localToWorld(_v.set(0, 0.075, -0.045));
        this.group.worldToLocal(g2);
        target = target.lerp(g2, onBottle * (1 - holding));
      }
      this.group.localToWorld(target);
      h.torso.worldToLocal(target);
      h.reach(side, target, _v.set(sx * 0.85, -0.5, -0.15).normalize());
    }
    h.root.updateMatrixWorld(true);

    // Biting, laughing, or his own face.
    const want = t > BITE_FACE[0] && t < BITE_FACE[1] ? this.bite : t > LAUGH[0] && t < LAUGH[1] ? this.laugh : null;
    if (want !== this.shown) {
      this.shown = want;
      h.showFace(want);
    }
  }
}
