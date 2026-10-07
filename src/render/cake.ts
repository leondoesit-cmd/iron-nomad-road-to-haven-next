import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { kitMaterial } from './materials';
import { shared } from './dispose';
import { clamp01, lerp, smoothstep } from '../core/math';
import { HERO_LOOKS, LAG_GAPE } from './heroLooks';
import type { Humanoid } from './humanoid';
import type { PortraitSpec } from './portrait';

/**
 * A huge slice of chocolate cake, a big spoon, and someone sat on a crate eating the one with the other: Lag Karab's
 * party piece, and what the opening is built round. The slice is cut in bands from its point back, so it can be eaten a
 * spoonful at a time.
 *
 * Everything here is in the eater's frame: feet at the origin, facing +Z, +X to his left.
 */

const mat = kitMaterial();
/** Cake has no wear, grain or weave: the kit's detail noise would make crumb and icing look like brick. */
const cakeMat = kitMaterial({ detail: false });

const SPONGE = 0x2a140c;
const FROSTING = 0x4e2814;
/** Crumb: matt, no wear or weave. Frosting: a soft sheen. */
const CRUMB = { c: SPONGE, r: 0.95, m: 0, w: 0 };
const ICING = { c: FROSTING, r: 0.38, m: 0, w: 0 };
/** Three layers of sponge with frosting between them and over the top, bottom to top: [thickness, colour]. */
const LAYERS: [number, number][] = [
  [0.068, SPONGE],
  [0.02, FROSTING],
  [0.068, SPONGE],
  [0.02, FROSTING],
  [0.068, SPONGE],
  [0.026, FROSTING],
];
export const CAKE_HEIGHT = LAYERS.reduce((a, [t]) => a + t, 0);
/** How far the slice runs back from its point, and its half angle: a slice of a cake 84 cm across, an eighth of it. */
export const CAKE_RADIUS = 0.42;
const CAKE_HALF_ANGLE = 0.36;
/** Where each spoonful's band starts and ends, from the point back to the round edge. */
const BANDS = [0, 0.1, 0.18, 0.26, 0.34, CAKE_RADIUS];

/** Outline of one band of the slice, between `r0` and `r1` from the point, in XY (+Y away from the point). */
function bandShape(r0: number, r1: number) {
  const s = new THREE.Shape();
  const a = CAKE_HALF_ANGLE;
  const n = 8;
  if (r0 <= 0.001) s.moveTo(0, 0.004);
  else for (let i = 0; i <= n; i++) {
    const t = -a + (2 * a * i) / n;
    i === 0 ? s.moveTo(Math.sin(t) * r0, Math.cos(t) * r0) : s.lineTo(Math.sin(t) * r0, Math.cos(t) * r0);
  }
  for (let i = n; i >= 0; i--) {
    const t = -a + (2 * a * i) / n;
    s.lineTo(Math.sin(t) * r1, Math.cos(t) * r1);
  }
  s.closePath();
  return s;
}

/**
 * One band of the slice, its point toward -Z and the band running back along +Z, bottom at y 0: the layers stacked up,
 * and on the last band the frosting over the round outer edge.
 */
function bandGeometry(i: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.jitter = 0.04;
  const r0 = BANDS[i];
  const r1 = BANDS[i + 1];
  let y = 0;
  for (const [t, c] of LAYERS) {
    // Extruded along +Z then laid flat (rx 90 deg): the outline's +Y ends up along +Z, away from the point.
    b.extrude(`cake:${i}:${t}`, () => bandShape(r0, r1), t, 0, 0, y + t / 2, 0, c === SPONGE ? CRUMB : ICING, Math.PI / 2, 0, 0);
    y += t;
  }
  if (i === BANDS.length - 2) {
    // The frosted outside of the cake, standing a few millimetres proud of the round edge.
    b.extrude(`cake:rim`, () => bandShape(r1 - 0.002, r1 + 0.008), y, 0, 0, y / 2, 0, ICING, Math.PI / 2, 0, 0);
  }
  // A swirl of frosting along the top.
  for (let k = 0; k < 3; k++) {
    const r = lerp(r0, r1, (k + 0.5) / 3);
    if (r < 0.04) continue;
    b.add('sphere16', Math.sin(k * 2.1) * r * 0.25, y + 0.004, r, 0.05, 0.016, 0.04, ICING);
  }
  return shared(b.build());
}

/** A spoonful: a lump of sponge and frosting, sat in the bowl. */
function chunkGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.jitter = 0.05;
  b.rbox(0, 0.018, 0, 0.07, 0.034, 0.06, 0.012, CRUMB);
  b.rbox(0, 0.04, 0, 0.066, 0.012, 0.058, 0.005, ICING);
  b.rbox(0.006, 0.055, -0.004, 0.06, 0.022, 0.05, 0.01, CRUMB);
  b.rbox(0.006, 0.07, -0.004, 0.058, 0.01, 0.048, 0.004, ICING);
  return shared(b.build());
}

/** Where the middle of the bowl is on a spoon `len` long, from the grip. */
export function spoonBowl(len: number) {
  return new THREE.Vector3(0, len * 0.04, len * 0.7);
}

/**
 * A big serving spoon `len` long, gripped at the origin, the handle running along +Z to the bowl, the bowl's hollow up
 * (+Y): a broad flat end to the handle, a narrow neck, and a deep bowl nearly half the spoon's length.
 */
export function spoonGeometry(len: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.jitter = 0;
  const steel = { c: 0xd4d7db, r: 0.14, m: 1, w: 0.08 };
  const L = len;
  b.add('sphere16', 0, -L * 0.004, -L * 0.15, L * 0.1, L * 0.02, L * 0.2, steel);
  b.limb(0, 0, -L * 0.12, 0, L * 0.022, L * 0.47, L * 0.026, L * 0.013, steel, 10);
  const c = spoonBowl(L);
  // The bowl: an outer shell, and a darker, shallower hollow in its top so it reads as a spoon and not a paddle.
  b.add('sphere16', 0, c.y, c.z, L * 0.3, L * 0.07, L * 0.44, steel);
  b.add('sphere16', 0, c.y + L * 0.022, c.z, L * 0.26, L * 0.03, L * 0.39, { c: 0x8e939a, r: 0.12, m: 1, w: 0.08 });
  return shared(b.build());
}

/** A wooden crate, `w` by `d` and `h` tall, standing on y 0: boards round the sides, battens at the corners. */
export function crateGeometry(w: number, h: number, d: number, seed: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.jitter = 0.08;
  b.seed(seed);
  const wood = S.wood(0x8a6a48, 0.7);
  const dark = S.wood(0x5e4630, 0.8);
  b.rbox(0, h / 2, 0, w - 0.02, h - 0.02, d - 0.02, 0.01, dark);
  const boards = Math.max(2, Math.round(h / 0.11));
  for (let i = 0; i < boards; i++) {
    const y = ((i + 0.5) / boards) * h;
    const bh = (h / boards) * 0.88;
    b.box(0, y, d / 2 - 0.006, w, bh, 0.014, wood);
    b.box(0, y, -d / 2 + 0.006, w, bh, 0.014, wood);
    b.box(w / 2 - 0.006, y, 0, 0.014, bh, d, wood);
    b.box(-w / 2 + 0.006, y, 0, 0.014, bh, d, wood);
  }
  for (const sx of [1, -1]) for (const sz of [1, -1]) b.box(sx * (w / 2 - 0.02), h / 2, sz * (d / 2 - 0.002), 0.04, h, 0.02, dark);
  for (let i = 0; i < 4; i++) b.box(0, h - 0.006, -d / 2 + ((i + 0.5) / 4) * d, w - 0.01, 0.014, (d / 4) * 0.9, wood);
  return shared(b.build());
}

/** A big enamel plate. */
export function plateGeometry(r: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.jitter = 0;
  b.lathe('cake-plate', [
    [0, 0],
    [0.62, 0],
    [0.7, 0.012],
    [0.95, 0.03],
    [1, 0.042],
    [0.98, 0.046],
    [0.7, 0.02],
    [0, 0.018],
  ], 0, 0, 0, { c: 0xe8e2d4, r: 0.22, m: 0, w: 0.25 }, 0, 0, 0, 32, r);
  return shared(b.build());
}

interface Key {
  /** Seconds into the bite. */
  t: number;
  /** Where the middle of the bowl goes. */
  at: 'rest' | 'over' | 'in' | 'out' | 'lips' | 'mouth';
}

/** One spoonful, start to finish: down into the cake, out with a lump, up to the open mouth, in, out, and back. */
const BITE: Key[] = [
  { t: 0, at: 'rest' },
  { t: 0.7, at: 'over' },
  { t: 1.0, at: 'in' },
  { t: 1.35, at: 'out' },
  { t: 2.0, at: 'lips' },
  { t: 2.3, at: 'mouth' },
  { t: 2.6, at: 'lips' },
  { t: 3.4, at: 'rest' },
];
const BITE_LEN = 4.3;
/** When in the bite the spoon comes up full, the lump is gone into the mouth, and the mouth is open. */
const SCOOP_T = 1.15;
const SWALLOW_T = 2.3;
const OPEN: [number, number] = [1.7, 2.5];

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Someone sat on a crate at a crate table, eating a huge slice of cake with a big spoon in the right hand, the left
 * hand on the knee. One spoonful every few seconds, a band of the slice gone with each; when the slice is finished a new
 * one is cut. A hero with a mouth-open face (Lag Karab) opens wide for each bite.
 *
 * Add `group` to a scene and call `update(dt)` every frame; the eater's rig is posed inside it.
 */
export class CakeEater {
  readonly group = new THREE.Group();
  readonly spoon: THREE.Mesh;
  readonly spoonLen: number;
  private bands: THREE.Mesh[] = [];
  private chunk: THREE.Mesh;
  /** Seconds into the current bite, and how many bands of the slice are eaten. */
  private t = 0;
  eaten = 0;
  /**
   * How big the spoon is, and the cake, against how they were made (1, 1): grow them and he still brings the bowl to the
   * cake and his mouth, his hand sliding back along the longer handle (and his arm only reaching so far).
   */
  spoonScale = 1;
  cakeScale = 1;
  /** The band this spoonful comes out of, and whether there is a lump on the spoon. */
  private band = 0;
  private loaded = false;
  private gaping = false;
  private gape: PortraitSpec | null;
  /** Where the slice's point is, and the top of the cake. */
  private cakeAt = new THREE.Vector3();
  private cakeTop = 0;

  /** The height he sits at, when it is someone else's seat (a sofa, a garden chair) rather than his own crate. */
  private seatTop: number | undefined;

  /**
   * `furniture: false` leaves out the crate seat and the crate table (he sits on someone else's chair, at someone else's
   * table), `seatTop` sits him at that height, and `tableH` / `plateZ` put the plate at that height and that far out in front
   * (on his knees, say) instead of on the crate table.
   */
  constructor(readonly h: Humanoid, opts: { spoon?: number; gape?: PortraitSpec | null; furniture?: boolean; tableH?: number; seatTop?: number; plateZ?: number } = {}) {
    this.spoonLen = opts.spoon ?? 0.5;
    this.gape = opts.gape !== undefined ? opts.gape : h.worn.hero === 'lag' ? LAG_GAPE : null;
    const g = this.group;
    g.add(h.root);
    h.root.position.set(0, 0, 0);
    h.root.rotation.set(0, 0, 0);
    this.seatTop = opts.seatTop;
    h.update(0.016, 'seat', 0, 0, 0);
    this.sit();
    h.root.updateMatrixWorld(true);
    // The seat under him: a crate whose top is just under the seat of his trousers.
    const s = h.root.scale.y;
    const seatTop = opts.seatTop ?? h.hips.position.y * s - 0.09 * s;
    const seat = new THREE.Mesh(crateGeometry(0.44, seatTop, 0.4, 3), mat);
    seat.position.set(0, 0, -0.06);
    // The table: a taller crate out in front of his knees, a plate on it and the slice on that, its point toward him.
    const tableH = opts.tableH ?? seatTop + 0.14;
    const table = new THREE.Mesh(crateGeometry(0.6, tableH, 0.56, 7), mat);
    table.position.set(0, 0, 0.9);
    const plate = new THREE.Mesh(plateGeometry(0.3), cakeMat);
    const pz = opts.plateZ ?? 0.86;
    plate.position.set(0, tableH, pz);
    this.cakeAt.set(0, tableH + 0.02, pz - 0.22);
    this.cakeTop = this.cakeAt.y + CAKE_HEIGHT;
    for (let i = 0; i < BANDS.length - 1; i++) {
      const m = new THREE.Mesh(bandGeometry(i), cakeMat);
      m.position.copy(this.cakeAt);
      this.bands.push(m);
      g.add(m);
    }
    this.spoon = new THREE.Mesh(spoonGeometry(this.spoonLen), mat);
    this.chunk = new THREE.Mesh(chunkGeometry(), cakeMat);
    this.chunk.position.copy(spoonBowl(this.spoonLen)).add(_v.set(0, this.spoonLen * 0.01, 0));
    this.chunk.scale.setScalar(this.spoonLen / 0.62);
    this.chunk.visible = false;
    this.spoon.add(this.chunk);
    g.add(plate, this.spoon);
    if (opts.furniture !== false) g.add(seat, table);
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.update(0);
  }

  /** On someone else's seat: the seat of his trousers at its height. */
  private sit() {
    if (this.seatTop === undefined) return;
    const s = this.h.root.scale.y;
    this.h.hips.position.y = (this.seatTop + 0.09 * s) / s;
  }

  /** The middle of the top of the band to be eaten next (in the group's frame). */
  private scoopPoint(out: THREE.Vector3) {
    const i = Math.min(this.band, BANDS.length - 2);
    return out.set(0, this.cakeTop - 0.03, this.cakeAt.z + (BANDS[i] + BANDS[i + 1]) / 2);
  }

  /** How far forward he has to lean for the next band: 0 at the point of the slice, 1 at the back. */
  private get reachK() {
    return clamp01(this.band / (BANDS.length - 2));
  }

  /** Where the bowl goes for a keyframe and which way the spoon points there (group frame). */
  private place(at: Key['at'], mouth: THREE.Vector3, face: THREE.Vector3, pos: THREE.Vector3, dir: THREE.Vector3) {
    const sc = this.scoopPoint(_v3);
    switch (at) {
      case 'rest':
        pos.set(-0.05, this.cakeTop + 0.08, this.cakeAt.z - 0.06);
        dir.set(0.2, -0.2, 0.95);
        break;
      case 'over':
        pos.copy(sc).add(_v2.set(0, 0.08, -0.03));
        dir.set(0.12, -0.38, 0.9);
        break;
      case 'in':
        pos.copy(sc).add(_v2.set(0, -0.02, 0.02));
        dir.set(0.1, -0.42, 0.88);
        break;
      case 'out':
        pos.copy(sc).add(_v2.set(0, 0.1, -0.05));
        dir.set(0.2, 0, 0.98);
        break;
      case 'lips':
        // Held up in front of the mouth, the fist low and off to his right: the spoon comes up and across into the face,
        // as in the photo of him doing it. The bowl sits a little under the lips so the lump in it is level with them.
        pos.copy(mouth).addScaledVector(face, 0.07).add(_v2.set(0, -0.03, 0));
        dir.set(0.5, 0.3, -0.8);
        break;
      case 'mouth':
        pos.copy(mouth).addScaledVector(face, 0.0).add(_v2.set(0, -0.03, 0));
        dir.set(0.48, 0.34, -0.8);
        break;
    }
    dir.normalize();
  }

  update(dt: number) {
    const h = this.h;
    this.t += dt;
    if (this.t >= BITE_LEN) {
      this.t -= BITE_LEN;
      // A new slice when this one is finished.
      if (this.eaten >= BANDS.length - 1) this.eaten = 0;
      this.band = this.eaten;
    }
    const t = this.t;
    // The band goes from the cake as the spoon comes up out of it, and the lump from the spoon into the mouth.
    if (t >= SCOOP_T && t - dt < SCOOP_T && this.eaten < BANDS.length - 1) {
      this.eaten++;
      this.loaded = true;
    }
    if (t >= SWALLOW_T || t < SCOOP_T) this.loaded = false;
    for (let i = 0; i < this.bands.length; i++) {
      this.bands[i].visible = i >= this.eaten;
      this.bands[i].scale.setScalar(this.cakeScale);
    }
    this.spoon.scale.setScalar(this.spoonScale);
    this.chunk.visible = this.loaded;

    h.update(dt, 'seat', 0, 0, 0);
    this.sit();
    // Lean in over the table as the slice gets further away, and back up straight for the bite.
    const toCake = 1 - smoothstep(1.3, 1.9, t) + smoothstep(3.0, 4.0, t);
    h.torso.rotation.x = 0.12 + (0.16 + 0.22 * this.reachK) * clamp01(toCake);
    // Eyes on the cake while scooping; chin up a touch for the bite, a chew after it.
    const chew = t > 2.5 && t < 3.9 ? Math.sin((t - 2.5) * 13) * 0.035 * smoothstep(3.9, 3.4, t) : 0;
    h.head.rotation.x = lerp(0.42, -0.12, smoothstep(1.4, 2.0, t) * (1 - smoothstep(2.6, 3.4, t))) + chew;
    h.head.rotation.y = -0.05;
    h.root.updateMatrixWorld(true);

    // The mouth, and the way the face looks, in the group's frame.
    const look = h.worn.hero ? HERO_LOOKS[h.worn.hero].portrait.shape : null;
    const mouth = _mouth.set(0, look ? look.eyeY + look.mouth.y : 0.04, look ? look.eyeZ + look.mouth.z + 0.005 : 0.1);
    h.head.localToWorld(mouth);
    this.group.worldToLocal(mouth);
    const face = _face.set(0, 0, 1).transformDirection(h.head.matrixWorld);
    _q.copy(this.group.getWorldQuaternion(_q2)).invert();
    face.applyQuaternion(_q).normalize();

    // Between keyframes, eased.
    let k = BITE.length - 1;
    for (let i = 0; i < BITE.length - 1; i++) if (t < BITE[i + 1].t) {
      k = i;
      break;
    }
    const a = BITE[k];
    const b = BITE[Math.min(k + 1, BITE.length - 1)];
    const u = b === a ? 0 : smoothstep(0, 1, (t - a.t) / (b.t - a.t));
    this.place(a.at, mouth, face, _pa, _da);
    this.place(b.at, mouth, face, _pb, _db);
    const bowl = _pa.lerp(_pb, u);
    const dir = _da.lerp(_db, u).normalize();
    // The grip is back along the handle from the bowl: that is where the hand goes.
    const grip = _grip.copy(bowl).addScaledVector(dir, -spoonBowl(this.spoonLen).length() * this.spoonScale);
    this.group.localToWorld(_v.copy(grip));
    h.torso.worldToLocal(_v);
    h.reach('R', _v, _v2.set(-0.85, -0.45, -0.1).normalize());
    // The left hand on the left knee.
    h.kneeL.getWorldPosition(_v);
    h.legL.getWorldPosition(_v3);
    _v.lerp(_v3, 0.35).add(_v2.set(0, 0.07, 0));
    h.torso.worldToLocal(_v);
    h.reach('L', _v, _v2.set(0.8, -0.5, -0.2).normalize());
    h.root.updateMatrixWorld(true);

    // The spoon in the fist: at the hand, along the way it points, the bowl's hollow up.
    h.hand.getWorldPosition(_v);
    this.group.worldToLocal(_v);
    this.spoon.position.copy(_v);
    const x = _v2.copy(UP).cross(dir);
    if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
    x.normalize();
    const y = _v3.copy(dir).cross(x).normalize();
    this.spoon.quaternion.setFromRotationMatrix(_m.makeBasis(x, y, dir));

    // Wide open for the bite.
    const open = t > OPEN[0] && t < OPEN[1] && !!this.gape;
    if (open !== this.gaping) {
      this.gaping = open;
      h.showFace(open ? this.gape : null);
    }
  }
}

const _mouth = new THREE.Vector3();
const _face = new THREE.Vector3();
const _q2 = new THREE.Quaternion();
const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();
const _da = new THREE.Vector3();
const _db = new THREE.Vector3();
const _grip = new THREE.Vector3();
