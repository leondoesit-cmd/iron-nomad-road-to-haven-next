import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { shared } from './dispose';
import { kitMaterial } from './materials';
import { GUN_POINTS } from '../sim/weaponanim';

/**
 * The recurve bow and its arrows. The bow's frame has its origin in the middle of the grip, the limbs up and down y, the
 * arrow pointing along +z and lying on the shelf to the left of the grip (+x is the bow's left, as on the guns). The riser is
 * walnut with a leather wrap; the limbs bend back toward the archer at rest (the string is braced about 19 cm off the grip)
 * and flick forward again at the tips.
 *
 * Held, the bow is a `BowRig`: the riser, the two limbs on their own pivots so they bend further as the string comes back,
 * the string in two runs from the tips to the nock, and the arrow on the string. On the ground or a rack it is one solid.
 */

const mat = kitMaterial();

/** The arrow: 74 cm from the nock to the point. Its own frame has the point at the origin and the shaft running back down -z. */
export const ARROW_LEN = 0.74;
/** The arrow lies along x and y here on the bow, and the nock on the string is level with the shelf. */
export const ARROW_X = GUN_POINTS.bow.muzzle[0];
export const ARROW_Y = GUN_POINTS.bow.muzzle[1];
/** The string at rest, and where the limbs hold it (y, z): the string leaves each tip here. */
export const BRACE = 0.205;
const TIP: [number, number] = [0.69, -BRACE];
/** The limbs' roots in the riser's pockets (y, z), where they pivot as they bend. */
const POCKET: [number, number] = [0.25, 0.05];
/** How far the limbs turn back on their pockets at full draw, radians. */
const FLEX = 0.16;

const walnut = S.wood(0x4a2e1c, 0.45);
const wrap = S.leather(0x2a1d14, 0.5);
const limbWood = S.wood(0x7a5634, 0.35);
const limbGlass = S.plastic(0x1d1b19, 0.3);
const stringC = S.cloth(0xd8ccae, 0.4);

/** The riser: a sweep of walnut from pocket to pocket, deepest at the grip, cut away above it for the arrow to pass. */
function drawRiser(b: MeshBuilder) {
  // (y, z, width, depth): the back of the riser curves toward the archer at the grip.
  const pts: [number, number, number, number][] = [
    [-0.26, 0.05, 0.034, 0.03],
    [-0.16, 0.03, 0.03, 0.034],
    [-0.08, 0.0, 0.03, 0.04],
    [0.0, -0.012, 0.03, 0.046],
    [0.03, -0.01, 0.022, 0.042],
    [0.1, 0.012, 0.018, 0.036],
    [0.18, 0.032, 0.024, 0.032],
    [0.26, 0.05, 0.034, 0.03],
  ];
  for (let i = 0; i < pts.length - 1; i++) {
    const [y0, z0, w0, d0] = pts[i];
    const [y1, z1, w1, d1] = pts[i + 1];
    const len = Math.hypot(y1 - y0, z1 - z0);
    // Turned about x so the piece's long side runs along the segment.
    const tilt = Math.atan2(z1 - z0, y1 - y0);
    // The sight window: above the shelf the riser stands off to the right, so the arrow passes close to the middle.
    const off = (y0 + y1) / 2 > 0.03 ? -0.008 : 0;
    b.rbox(off, (y0 + y1) / 2, (z0 + z1) / 2, (w0 + w1) / 2, len + 0.006, (d0 + d1) / 2, 0.006, walnut, tilt, 0, 0);
  }
  // The grip in its leather wrap, and the shelf the arrow rests on.
  b.rbox(0, -0.02, -0.006, 0.034, 0.1, 0.05, 0.012, wrap, 0.12, 0, 0);
  b.rbox(0.006, ARROW_Y - 0.009, 0.0, 0.02, 0.006, 0.05, 0.002, wrap);
  // Brass bolts in the limb pockets.
  for (const sy of [1, -1]) b.cyl(0, sy * 0.235, 0.05, 0.009, 0.038, 0.009, S.metal(0x8a6a32, 0.4), 0, 0, Math.PI / 2, 8);
}

/** The limb's line from its pocket out to the tip (y, z), at rest. The recurve: back toward the archer, then forward again. */
const LIMB: [number, number][] = [
  [0.25, 0.05],
  [0.36, 0.02],
  [0.47, -0.04],
  [0.57, -0.12],
  [0.65, -0.185],
  [0.7, -0.205],
  [0.74, -0.19],
  [0.765, -0.16],
];

/** One limb, laminated and tapering, along `LIMB`; `sy` -1 draws the lower one. In the bow's frame less (`oy`, `oz`). */
function drawLimb(b: MeshBuilder, sy: number, oy = 0, oz = 0) {
  for (let i = 0; i < LIMB.length - 1; i++) {
    const [y0, z0] = LIMB[i];
    const [y1, z1] = LIMB[i + 1];
    const t = i / (LIMB.length - 2);
    const w = 0.036 - 0.02 * t;
    const len = Math.hypot(y1 - y0, z1 - z0);
    const tilt = Math.atan2(z1 - z0, y1 - y0);
    const y = (sy * (y0 + y1)) / 2 - oy;
    const z = (z0 + z1) / 2 - oz;
    b.rbox(0, y, z, w, len + 0.004, 0.009, 0.003, limbWood, sy * tilt, 0, 0);
    // The dark glass facing on the belly (the archer's side), laid along the limb.
    const by = (0.005 * (z1 - z0)) / len;
    const bz = (-0.005 * (y1 - y0)) / len;
    b.box(0, y + sy * by, z + bz, w * 0.92, len + 0.002, 0.002, limbGlass, sy * tilt, 0, 0);
  }
  // A string nock cut in the tip.
  const [ty, tz] = LIMB[LIMB.length - 1];
  b.sphereAt(0, sy * ty - oy, tz - oz, 0.008, limbGlass);
}

/** A string run from `a` to `b` (bow frame), drawn as a thin cord. */
function drawCord(b: MeshBuilder, ay: number, az: number, by: number, bz: number) {
  b.rod(0, ay, az, 0, by, bz, 0.0018, stringC, 5);
}

/** The whole bow as one solid, the string at rest: for the ground, a rack and the icons. */
export function drawBow(b: MeshBuilder) {
  drawRiser(b);
  drawLimb(b, 1);
  drawLimb(b, -1);
  drawCord(b, TIP[0], TIP[1], -TIP[0], TIP[1]);
}

/** An arrow with its point at the origin and the shaft back down -z: a steel field point, a cedar shaft, three vanes and the nock. */
function drawArrow(b: MeshBuilder) {
  const shaft = S.wood(0x9a7448, 0.4);
  b.cyl(0, 0, -ARROW_LEN / 2, 0.0042, ARROW_LEN - 0.05, 0.0042, shaft, Math.PI / 2, 0, 0, 6);
  b.frustum(0, 0, -0.025, 0.0006, 0.0055, 0.05, S.steel(0x6a6e72, 0.4), Math.PI / 2, 0, 0, 6);
  // Cresting bands just ahead of the fletching, so a stuck arrow reads from across a street.
  b.cyl(0, 0, -ARROW_LEN + 0.17, 0.0046, 0.025, 0.0046, S.paint(0xb8322a, 0.4), Math.PI / 2, 0, 0, 6);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const vane = i === 0 ? S.plastic(0xd8b03a, 0.3) : S.plastic(0xe8e2d4, 0.3);
    // Each vane stands out from the shaft along its own spoke.
    b.box(Math.cos(a) * 0.009, Math.sin(a) * 0.009, -ARROW_LEN + 0.075, 0.0008, 0.011, 0.1, vane, 0, 0, a - Math.PI / 2);
  }
  b.cyl(0, 0, -ARROW_LEN + 0.008, 0.005, 0.016, 0.005, S.plastic(0x2a2a2a, 0.3), Math.PI / 2, 0, 0, 6);
}

const geoCache = new Map<string, THREE.BufferGeometry>();
function cached(key: string, fn: (b: MeshBuilder) => void): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) {
    const b = new MeshBuilder();
    b.jitter = 0.015;
    fn(b);
    g = shared(b.build());
    geoCache.set(key, g);
  }
  return g;
}

export const arrowGeometry = () => cached('arrow', drawArrow);

/** The limbs are drawn about their own pocket, so each can be turned on it. */
const limbGeometry = (sy: number) => cached(`limb${sy}`, (b) => drawLimb(b, sy, sy * POCKET[0], POCKET[1]));

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _tips = [new THREE.Vector3(), new THREE.Vector3()];
const _up = new THREE.Vector3(0, 1, 0);

/**
 * A bow in someone's hand: its limbs bend and its string comes back with the draw, and the arrow sits on the string until
 * it is loosed. `riser` is the bow's own frame (the gun points read off it); the rest hangs off the same group.
 */
export class BowRig {
  readonly group = new THREE.Group();
  readonly riser: THREE.Mesh;
  private limbs: THREE.Mesh[] = [];
  private cords: THREE.Mesh[] = [];
  private arrow: THREE.Mesh;
  /** Where the nock is on the string right now, in the bow's frame. */
  readonly nock = new THREE.Vector3(ARROW_X, ARROW_Y, -BRACE);
  /** How far the string comes back at full draw from where it rests, metres. Shortened in the first-person view, so the draw hand stays in front of the eye. */
  drawLen = 0.46;
  /** The arrow's length as a share of a real one: shortened with the draw in the first-person view, so its point still rests just past the shelf at full draw. */
  arrowScale = 1;

  constructor() {
    const mk = (g: THREE.BufferGeometry) => {
      const m = new THREE.Mesh(g, mat);
      m.castShadow = true;
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    };
    this.riser = mk(cached('riser', drawRiser));
    for (const sy of [1, -1]) {
      const l = mk(limbGeometry(sy));
      l.position.set(0, sy * POCKET[0], POCKET[1]);
      this.limbs.push(l);
    }
    const cord = cached('cord', (b) => b.cyl(0, 0.5, 0, 0.0018, 1, 0.0018, stringC, 0, 0, 0, 5));
    for (let i = 0; i < 2; i++) this.cords.push(mk(cord));
    this.arrow = mk(arrowGeometry());
    this.set(0, true);
  }

  /** Pose for a draw (0 slack to 1 full) with or without an arrow on the string. */
  set(draw: number, nocked: boolean) {
    const k = Math.max(0, Math.min(1, draw));
    const nz = -BRACE - k * this.drawLen;
    this.nock.set(ARROW_X, ARROW_Y, nz);
    const tips = _tips;
    for (let i = 0; i < 2; i++) {
      const sy = i === 0 ? 1 : -1;
      const l = this.limbs[i];
      // The limb turns back on its pocket, the tip coming toward the archer and in.
      l.rotation.x = -sy * FLEX * k * (0.6 + 0.4 * k);
      l.updateMatrix();
      tips[i].set(0, sy * (TIP[0] - POCKET[0]), TIP[1] - POCKET[1]).applyMatrix4(l.matrix);
    }
    for (let i = 0; i < 2; i++) {
      // Each run of string from its tip to the nock: a unit cord along +y, stretched and turned to fit.
      const c = this.cords[i];
      const from = tips[i];
      _a.set(0, ARROW_Y, nz).sub(from);
      const len = _a.length();
      c.position.copy(from);
      c.quaternion.setFromUnitVectors(_up, _b.copy(_a).divideScalar(len));
      c.scale.set(1, len, 1);
    }
    this.arrow.visible = nocked;
    this.arrow.position.set(ARROW_X, ARROW_Y, nz + ARROW_LEN * this.arrowScale);
    this.arrow.scale.set(1, 1, this.arrowScale);
  }
}
