import * as THREE from 'three';
import { MeshBuilder, S, type ColorIn } from './builder';
import { C } from './palette';

/**
 * Reusable hardware for vehicles and props. Every function appends to a MeshBuilder in its local frame
 * (metres, +Z forward, +Y up), so parts can be dropped onto any model.
 */

type V3 = [number, number, number];

/** A 20 litre jerry can standing upright, facing +Z (handles on top, the X-press on the flanks). */
export function jerryCan(b: MeshBuilder, x: number, y: number, z: number, color: number, yaw = 0, lie = false) {
  const t = new MeshBuilder();
  const paint = S.paint(color, 0.75);
  t.rbox(0, 0.17, 0, 0.17, 0.34, 0.26, 0.025, paint);
  // Stamped X on each side.
  for (const sx of [1, -1]) {
    t.box(sx * 0.087, 0.17, 0, 0.012, 0.03, 0.27, paint, 0.9, 0, 0);
    t.box(sx * 0.087, 0.17, 0, 0.012, 0.03, 0.27, paint, -0.9, 0, 0);
  }
  // Three-bar handle and spout.
  t.box(0, 0.36, -0.03, 0.04, 0.03, 0.16, paint);
  for (const dz of [-0.09, -0.03, 0.03]) t.box(0, 0.345, dz, 0.035, 0.03, 0.012, paint);
  t.cyl(0, 0.36, 0.09, 0.05, 0.05, 0.05, S.steel(0x3a3c3e), 0, 0, 0, 10);
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(lie ? Math.PI / 2 : 0, yaw, 0, 'YXZ')), new THREE.Vector3(1, 1, 1));
  b.appendMatrix(t, m);
}

/** A square five-litre oil can: amber body, black label band, a handle and a capped spout. Base centre at (x, y, z). */
export function oilCan(b: MeshBuilder, x: number, y: number, z: number, yaw = 0) {
  const t = new MeshBuilder();
  const steel = S.steel(0x6a6e72, 0.6);
  t.rbox(0, 0.17, 0, 0.28, 0.34, 0.2, 0.035, S.paint(0xd8a824, 0.55));
  t.rbox(0, 0.17, 0.102, 0.24, 0.16, 0.008, 0.004, S.paint(0x1c1c1c, 0.5));
  t.box(0, 0.17, 0.108, 0.1, 0.05, 0.004, S.paint(0xe9dfc7, 0.5));
  t.cyl(0.07, 0.37, 0, 0.07, 0.07, 0.07, steel, 0, 0, 0, 10);
  t.cyl(0.07, 0.41, 0, 0.08, 0.02, 0.08, S.paint(0x2a2a2a, 0.5), 0, 0, 0, 10);
  t.rod(-0.1, 0.34, 0, -0.1, 0.43, 0, 0.014, steel, 6);
  t.rod(-0.1, 0.43, 0, 0.0, 0.43, 0, 0.014, steel, 6);
  b.appendMatrix(t, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)), new THREE.Vector3(1, 1, 1)));
}

/** Wooden crate: planked faces with metal corners. Centre at (x, y, z), size sx*sy*sz. */
export function crate(b: MeshBuilder, x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw = 0, wood = C.wood) {
  const t = new MeshBuilder();
  t.jitter = 0.08;
  const w = S.wood(wood, 0.7);
  t.box(0, 0, 0, sx * 0.96, sy * 0.96, sz * 0.96, w);
  // Planks proud of the faces.
  const planks = Math.max(2, Math.round(sy / 0.12));
  for (let i = 0; i < planks; i++) {
    const py = -sy / 2 + (i + 0.5) * (sy / planks);
    const tone = i % 2 ? wood : C.woodDark;
    t.box(0, py, sz / 2, sx * 0.98, sy / planks - 0.012, 0.012, S.wood(tone, 0.7));
    t.box(0, py, -sz / 2, sx * 0.98, sy / planks - 0.012, 0.012, S.wood(tone, 0.7));
    t.box(sx / 2, py, 0, 0.012, sy / planks - 0.012, sz * 0.98, S.wood(tone, 0.7));
    t.box(-sx / 2, py, 0, 0.012, sy / planks - 0.012, sz * 0.98, S.wood(tone, 0.7));
  }
  // Corner irons.
  const k = S.steel(0x4a4b4c, 0.8);
  for (const cx of [1, -1]) for (const cz of [1, -1]) t.box(cx * sx * 0.49, 0, cz * sz * 0.49, 0.03, sy, 0.03, k);
  t.box(0, sy * 0.5, 0, sx, 0.02, sz, S.wood(C.woodDark, 0.7));
  b.appendMatrix(t, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)), new THREE.Vector3(1, 1, 1)));
}

/** Oil drum (centre of base at x, y, z), with rolled hoops and a bung. */
export function drum(b: MeshBuilder, x: number, y: number, z: number, color: number, h = 0.88, r = 0.29, tipped = 0) {
  const t = new MeshBuilder();
  const p = S.paint(color, 0.85);
  t.cyl(0, h / 2, 0, r * 2, h, r * 2, p, 0, 0, 0, 20);
  for (const hy of [0.02, h / 3, (2 * h) / 3, h - 0.02]) t.torus(0, hy, 0, r, 0.012, p, Math.PI / 2, 0, 0, 6, 24);
  t.cyl(r * 0.5, h + 0.005, 0, 0.06, 0.02, 0.06, S.steel(), 0, 0, 0, 10);
  b.appendMatrix(t, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(tipped, 0, 0)), new THREE.Vector3(1, 1, 1)));
}

/**
 * A row of rivet heads from a to b. Each head is an icosahedron (20 triangles): at a centimetre across it reads as a dome,
 * and an armoured truck carries hundreds of them, so a smooth sphere (80) would be most of its triangle budget.
 */
export function rivets(b: MeshBuilder, a: V3, c: V3, n: number, r = 0.012, color: ColorIn = S.steel(0x5a5d60, 0.7)) {
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    b.add('ico', a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t, r * 2, r * 2, r * 2, color);
  }
}

/**
 * Welded armour plate in the plane facing +Z (or rotated), chamfered corners, rivets round the edge.
 * Width w, height h, thickness t, centred at (x, y, z), rotated by Euler (rx, ry, rz).
 */
export function plate(b: MeshBuilder, x: number, y: number, z: number, w: number, h: number, t: number, color: ColorIn, rx = 0, ry = 0, rz = 0, rivetEdge = true) {
  const p = new MeshBuilder();
  const cut = Math.min(w, h) * 0.18;
  const key = `plate:${w.toFixed(3)}:${h.toFixed(3)}`;
  p.extrude(key, () => {
    const s = new THREE.Shape();
    s.moveTo(-w / 2 + cut, -h / 2);
    s.lineTo(w / 2 - cut, -h / 2);
    s.lineTo(w / 2, -h / 2 + cut);
    s.lineTo(w / 2, h / 2 - cut * 0.5);
    s.lineTo(w / 2 - cut * 0.5, h / 2);
    s.lineTo(-w / 2 + cut * 0.5, h / 2);
    s.lineTo(-w / 2, h / 2 - cut * 0.5);
    s.lineTo(-w / 2, -h / 2 + cut);
    s.closePath();
    return s;
  }, t, Math.min(0.012, t * 0.3), 0, 0, 0, color);
  if (rivetEdge) {
    const n = Math.max(2, Math.round(w / 0.16));
    const m = Math.max(2, Math.round(h / 0.16));
    const ix = w / 2 - 0.04;
    const iy = h / 2 - 0.04;
    rivets(p, [-ix + cut * 0.5, iy, t / 2], [ix - cut * 0.5, iy, t / 2], n);
    rivets(p, [-ix + cut, -iy, t / 2], [ix - cut, -iy, t / 2], n);
    rivets(p, [ix, -iy + cut, t / 2], [ix, iy - cut, t / 2], m);
    rivets(p, [-ix, -iy + cut, t / 2], [-ix, iy - cut, t / 2], m);
  }
  b.appendMatrix(p, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(1, 1, 1)));
}

/** Coil-over shock between two points: damper body, chrome shaft and a coil spring. */
export function shock(b: MeshBuilder, a: V3, c: V3, springColor: number, r = 0.045) {
  const dx = c[0] - a[0];
  const dy = c[1] - a[1];
  const dz = c[2] - a[2];
  const len = Math.hypot(dx, dy, dz);
  const dir = new THREE.Vector3(dx / len, dy / len, dz / len);
  const mid: V3 = [a[0] + dx * 0.55, a[1] + dy * 0.55, a[2] + dz * 0.55];
  b.rod(a[0], a[1], a[2], mid[0], mid[1], mid[2], r * 0.55, S.steel(0x2c2e30), 10);
  b.rod(mid[0], mid[1], mid[2], c[0], c[1], c[2], r * 0.28, S.chrome(), 8);
  // Helix around the axis.
  const up = Math.abs(dir.y) < 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(dir, up).normalize();
  const v = new THREE.Vector3().crossVectors(dir, u).normalize();
  const turns = Math.max(4, Math.round(len / 0.045));
  const seg = turns * 6;
  // The coil as short rods end to end: the joints are hidden by the overlap, so no ball at each (a pipe's joints would
  // cost a sphere per segment, sixty of them per spring).
  const coil = S.paint(springColor, 0.4);
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const ang = t * turns * Math.PI * 2;
    q.copy(p);
    p.set(a[0], a[1], a[2]).addScaledVector(dir, len * (0.08 + t * 0.84)).addScaledVector(u, Math.cos(ang) * r).addScaledVector(v, Math.sin(ang) * r);
    if (i > 0) b.rod(q.x, q.y, q.z, p.x, p.y, p.z, r * 0.16, coil, 5);
  }
  b.cyl(a[0] + dx * 0.06, a[1] + dy * 0.06, a[2] + dz * 0.06, r * 2.6, 0.02, r * 2.6, S.steel(), 0, 0, 0, 10);
}

/** A spare tyre lying flat (or standing, `stand` radians about X). */
export function spareTyre(b: MeshBuilder, x: number, y: number, z: number, radius: number, width: number, stand = 0, yaw = 0) {
  const t = new MeshBuilder();
  t.torus(0, 0, 0, radius - width * 0.45, width * 0.5, S.rubber(0x1d1d1f), Math.PI / 2, 0, 0, 10, 28);
  t.cyl(0, 0, 0, radius * 1.2, width * 0.55, radius * 1.2, S.steel(0x55585b, 0.7), 0, 0, 0, 20);
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    t.box(Math.cos(a) * radius * 0.97, 0, Math.sin(a) * radius * 0.97, 0.05, width * 0.8, 0.06, S.rubber(0x161618), 0, -a, 0);
  }
  b.appendMatrix(t, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(stand, yaw, 0, 'YXZ')), new THREE.Vector3(1, 1, 1)));
}

/** Ratchet strap over a load: a flat band following the given corner points. */
export function strap(b: MeshBuilder, pts: V3[], color = 0xd6a21e) {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const c = pts[i + 1];
    b.rod(a[0], a[1], a[2], c[0], c[1], c[2], 0.012, S.cloth(color, 0.6), 6);
  }
  const m = pts[Math.floor(pts.length / 2)];
  b.box(m[0], m[1], m[2], 0.06, 0.04, 0.05, S.steel(0x6a6c6e));
}

/** Heavy machine gun along +Z: receiver, perforated barrel jacket, spade grips and an ammo can. Muzzle at z = len. */
export function heavyGun(b: MeshBuilder, len = 1.15, shield = true) {
  const dark = S.steel(0x2a2c2e, 0.45);
  const black = S.metal(0x1d1e20, 0.4);
  b.rbox(0, 0, 0, 0.17, 0.2, 0.5, 0.02, dark);
  b.box(0, 0.11, 0.02, 0.12, 0.03, 0.42, black);
  b.cyl(0, 0, 0.25 + (len - 0.3) / 2, 0.075, len - 0.3, 0.075, black, Math.PI / 2, 0, 0, 14);
  // Jacket with cooling holes suggested by rings.
  for (let i = 0; i < 6; i++) b.cyl(0, 0, 0.32 + i * 0.07, 0.095, 0.03, 0.095, dark, Math.PI / 2, 0, 0, 14);
  b.cyl(0, 0, len - 0.03, 0.06, 0.08, 0.06, black, Math.PI / 2, 0, 0, 10);
  // Spade grips and trigger.
  for (const sx of [1, -1]) b.capsule(sx * 0.06, -0.02, -0.3, sx * 0.06, -0.08, -0.36, 0.022, S.rubber(0x202020));
  b.box(0, -0.02, -0.27, 0.14, 0.03, 0.04, dark);
  // Ammo can with a belt feeding in.
  b.rbox(-0.18, -0.06, 0.02, 0.13, 0.18, 0.28, 0.01, S.paint(0x4a5532, 0.7));
  for (let i = 0; i < 5; i++) b.box(-0.11 + i * 0.022, 0.06 - i * 0.01, 0.02, 0.016, 0.03, 0.06, S.metal(0xb08a3a, 0.3));
  // Pintle and cradle.
  b.box(0, -0.15, 0, 0.08, 0.12, 0.16, dark);
  if (shield) {
    plate(b, 0, 0.06, 0.32, 0.62, 0.42, 0.025, S.paint(0x4b5340, 0.8), 0, 0, 0);
    b.box(0, 0.02, 0.33, 0.12, 0.08, 0.04, dark);
  }
}

/** Road sign repurposed as armour: painted face with a reflective border, in the XY plane facing +Z. */
export function signPlate(b: MeshBuilder, x: number, y: number, z: number, w: number, h: number, face: number, rx = 0, ry = 0, rz = 0) {
  const p = new MeshBuilder();
  p.rbox(0, 0, 0, w, h, 0.02, 0.01, S.paint(0xc9c6bb, 0.8));
  p.box(0, 0, 0.012, w * 0.9, h * 0.84, 0.006, S.paint(face, 0.75));
  // Chevron stripes.
  const n = Math.max(2, Math.round(w / 0.22));
  for (let i = 0; i < n; i++) {
    const cx = -w * 0.38 + (i / (n - 1 || 1)) * w * 0.76;
    p.box(cx, 0, 0.017, w * 0.05, h * 0.62, 0.004, S.paint(0x1a1a1a, 0.6), 0, 0, 0.6);
  }
  b.appendMatrix(p, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(1, 1, 1)));
}

/** Exhaust: pipe through points ending in a muffler can along the last segment. */
export function exhaust(b: MeshBuilder, pts: V3[], r = 0.03, muffler = 0.07) {
  b.pipe(pts, r, S.metal(0x6e5a4a, 0.85), 8);
  const a = pts[pts.length - 2];
  const c = pts[pts.length - 1];
  b.limb(a[0] + (c[0] - a[0]) * 0.15, a[1] + (c[1] - a[1]) * 0.15, a[2] + (c[2] - a[2]) * 0.15, c[0], c[1], c[2], muffler, muffler * 0.85, S.metal(0x4e4a46, 0.9), 12);
  b.cyl(c[0], c[1], c[2], r * 1.5, 0.02, r * 1.5, S.metal(0x1a1612, 0.9), Math.PI / 2, 0, 0, 8);
}

/** Bundle of rolled bedding / tarp lying along X. */
export function bedroll(b: MeshBuilder, x: number, y: number, z: number, len: number, r: number, color: number) {
  b.capsule(x - len / 2, y, z, x + len / 2, y, z, r, S.cloth(color, 0.7), 12);
  for (const dx of [-len * 0.3, len * 0.3]) b.torus(x + dx, y, z, r * 1.02, 0.012, S.leather(0x3a2a1c), 0, Math.PI / 2, 0, 6, 16);
}
