import * as THREE from 'three';
import { MeshBuilder, S, valueNoise3, type Surf } from './builder';
import { partDef, wheelLayout, type VehicleDef } from '../data';
import type { Fit } from '../sim/parts';
import { addKit, type KitLook, type Mounts } from './attachments';
import { partMeta, partTag } from './bodyParts';
import { drawEngine, engineExtent } from './engineModels';
import { exhaust } from './parts';
import { paintPanels } from './paintJob';
import { shared } from './dispose';
import type { Humanoid } from './humanoid';
import { bodyMat, blank, finish, headlamp, liveRig, rider, taillight, wheelGeometry, type VehicleVisual, type WheelStyle } from './vehicleKit';
import type { VehicleLook } from './vehicleModels';

/**
 * The Rickshaw Trike (chassis `trike`): the front half of an old rust-red chopper (raked fork, laced front wheel, teardrop
 * tank, high pulled-back bars, a worn solo saddle) welded onto a rear subframe with a leaf-sprung axle and two small pressed
 * steel wheels, and on that subframe a tuk-tuk tin cab (`rr_rickshaw`): rusted ochre sheet with flaking blue paint, a rounded
 * roof, an open front, mesh in the side windows, a wooden bench across the back, a striped curtain, a can of brushes.
 *
 * Chassis frame: metres, +Z forward, +X left, +Y up, origin the chassis centre. The body sits about 0.1 m down on its springs
 * at rest, so the model is drawn round the wheels where they ride (`FA`, `RA`), with the ground at about y = -0.57.
 *
 * The front end steers the way a bike's does: the fork, the bars, the headlight and the front fender turn about the raked
 * steering axis, the fork's lower legs slide with the wheel, and the front wheel leans with them. The game turns the wheel
 * pivot about the vertical; the seat hook (called every frame with the rider) carries that over to the fork.
 */

type V3 = [number, number, number];

// ------------------------------------------------------------------------------------------------ layout (chassis frame)

/** Rake of the steering head from vertical, radians. */
const RAKE = 0.5;
const COS_R = Math.cos(RAKE);
const SIN_R = Math.sin(RAKE);
/** Front axle at ride height. The steering axis runs up through it. */
const FA: V3 = [0, -0.24, 0.98];
/** Unit vector up the steering axis. */
const AXIS = new THREE.Vector3(0, COS_R, -SIN_R);
const UP_Y = new THREE.Vector3(0, 1, 0);
/** A point `t` metres up the steering axis from the front axle, `x` to the side. */
const up = (t: number, x = 0): V3 => [x, FA[1] + t * COS_R, FA[2] - t * SIN_R];
/** Rear axle at ride height (measured settled in a scene: the small wheels sag a little more than the front), and its half track. */
const RA = { x: 0.6, y: -0.345, z: -0.8 };
/** Ground under the trike at rest. */
const GROUND = -0.57;
/** The rider's hip joint. The 'ride' pose stands the root 0.45 below it. */
const HIP: V3 = [0, 0.27, -0.16];
/** The left grip's middle with the bars straight (the right one is mirrored). */
const GRIP: V3 = [0.405, 0.643, 0.424];
/** Where the cab's own frame sits on the subframe: the middle of the cab floor's underside. */
const CAB_AT: V3 = [0, -0.23, -0.95];
/** The engine stands on its mount plates: base height and the middle of its length. */
const ENG_BASE = -0.388;
const ENG_Z = 0.38;
/** Wheel radii (they match the chassis' axles; the part models use them too). */
const R_FRONT = 0.33;
const R_REAR = 0.26;

// ------------------------------------------------------------------------------------------------ the cab (its own frame)

/** Cab: half width and half length, floor top and wall top, all in the cab's frame (origin: floor underside, middle). */
const C_HW = 0.65;
const C_HL = 0.67;
const C_FT = 0.03;
const C_WT = 1.16;
/** The roof is an arc: centre height, radius, and the half span where it meets the walls. */
const ROOF_YC = 0.23;
const ROOF_R = 1.15;
const ROOF_PHI0 = Math.acos(0.69 / ROOF_R);
/** The rear wheels in the cab's frame, and the radius of the arches over them. */
const C_WZ = RA.z - CAB_AT[2];
const C_WY = RA.y - CAB_AT[1];
const C_AR = 0.37;
/** Side window openings and the bench. */
const WIN = { z0: -0.52, z1: 0.44, y0: 0.6, y1: 1.06 };
const BENCH = { top: 0.38, z0: -0.62, z1: -0.2 };
/** Where the passenger's hips go on the bench (cab frame z): forward enough that a pack on their back clears the rear wall. */
const PASS_Z = -0.32;

/** Where parts attach on the trike. The trunk is the cab floor: what is put in the cab rides there. */
export const TRIKE_MOUNTS: Mounts = {
  hw: 0.62,
  front: { z: 1.3, y: 0.0, hw: 0.2 },
  rear: { z: -1.62, y: 0.1, hw: 0.62 },
  side: { y0: -0.2, y1: 0.35, z0: -1.5, z1: -0.35 },
  sill: -0.26,
  trunk: { y: CAB_AT[1] + C_FT, z0: CAB_AT[2] + BENCH.z1, z1: -0.45, hw: 0.45 },
  narrow: true,
  wheelR: R_FRONT,
};

// ------------------------------------------------------------------------------------------------ helpers

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const _c = new THREE.Color();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();

/** Append a finished geometry (its own colours and surfaces) to a builder under a matrix. */
function appendGeo(b: MeshBuilder, g: THREE.BufferGeometry, m: THREE.Matrix4) {
  const base = b.pos.length / 3;
  _nm.getNormalMatrix(m);
  const pa = g.attributes.position;
  const na = g.attributes.normal;
  const ca = g.attributes.color;
  const sa = g.attributes.surf;
  const ua = g.attributes.uv;
  for (let i = 0; i < pa.count; i++) {
    _v.fromBufferAttribute(pa, i).applyMatrix4(m);
    b.pos.push(_v.x, _v.y, _v.z);
    _n.fromBufferAttribute(na, i).applyMatrix3(_nm).normalize();
    b.nor.push(_n.x, _n.y, _n.z);
    b.col.push(ca.getX(i), ca.getY(i), ca.getZ(i));
    b.srf.push(sa.getX(i), sa.getY(i), sa.getZ(i), sa.getW(i));
    b.uv.push(ua ? ua.getX(i) : 0, ua ? ua.getY(i) : 0);
  }
  const ix = g.index;
  if (ix) for (let i = 0; i < ix.count; i++) b.idx.push(base + ix.getX(i));
  else for (let i = 0; i < pa.count; i++) b.idx.push(base + i);
}

/** One vertex with its own surface, written straight into a builder. */
function vert(b: MeshBuilder, p: THREE.Vector3, n: THREE.Vector3, s: Surf) {
  b.pos.push(p.x, p.y, p.z);
  b.nor.push(n.x, n.y, n.z);
  if (typeof s.c === 'number') _c.set(s.c);
  else _c.copy(s.c);
  b.col.push(_c.r, _c.g, _c.b);
  b.srf.push(s.r ?? 0.82, s.m ?? 0, s.w ?? 0.5, s.e ?? 0);
  b.uv.push(p.x + p.y, p.z + p.y);
}

/** Rods through a list of points without the ball joints `pipe` puts in: cables, chain, wire. */
function wire(b: MeshBuilder, pts: V3[], r: number, s: Surf, seg = 5) {
  for (let i = 0; i < pts.length - 1; i++) b.rod(pts[i][0], pts[i][1], pts[i][2], pts[i + 1][0], pts[i + 1][1], pts[i + 1][2], r, s, seg);
}

/**
 * A curved sheet of metal with smooth shading: an outer skin at P(u, v), an inner one `thick` behind it, and the cut edges.
 * The surface at each point comes from `surf`, so paint and rust can blotch across it. P's u-cross-v must face outward.
 */
function smoothSheet(b: MeshBuilder, us: number[], vs: number[], P: (u: number, v: number) => V3, thick: number, surf: (p: V3, outer: boolean) => Surf) {
  const nu = us.length;
  const nv = vs.length;
  const pts: THREE.Vector3[] = [];
  const nrm: THREE.Vector3[] = [];
  const e = 1e-3;
  const at = (u: number, v: number) => new THREE.Vector3(...P(u, v));
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const u = us[i];
      const v = vs[j];
      const du = at(Math.min(1, u + e), v).sub(at(Math.max(0, u - e), v));
      const dv = at(u, Math.min(1, v + e)).sub(at(u, Math.max(0, v - e)));
      pts.push(at(u, v));
      nrm.push(du.cross(dv).normalize());
    }
  }
  const base = b.pos.length / 3;
  const N = nu * nv;
  for (let k = 0; k < N; k++) vert(b, pts[k], nrm[k], surf([pts[k].x, pts[k].y, pts[k].z], true));
  const inner = pts.map((p, k) => p.clone().addScaledVector(nrm[k], -thick));
  for (let k = 0; k < N; k++) vert(b, inner[k], nrm[k].clone().negate(), surf([pts[k].x, pts[k].y, pts[k].z], false));
  for (let j = 0; j < nv - 1; j++) {
    for (let i = 0; i < nu - 1; i++) {
      const a = j * nu + i;
      const c = a + nu + 1;
      b.idx.push(base + a, base + a + 1, base + c, base + a, base + c, base + a + nu);
      b.idx.push(base + N + a, base + N + c, base + N + a + 1, base + N + a, base + N + a + nu, base + N + c);
    }
  }
  // The cut edges all round, as thin strips seen from both sides.
  const edge = (k0: number, k1: number) => {
    const s = surf([pts[k0].x, pts[k0].y, pts[k0].z], false);
    const p0: V3 = [pts[k0].x, pts[k0].y, pts[k0].z];
    const p1: V3 = [pts[k1].x, pts[k1].y, pts[k1].z];
    const q0: V3 = [inner[k0].x, inner[k0].y, inner[k0].z];
    const q1: V3 = [inner[k1].x, inner[k1].y, inner[k1].z];
    b.quad(p0, p1, q1, q0, s);
    b.quad(p0, q0, q1, p1, s);
  };
  for (let i = 0; i < nu - 1; i++) {
    edge(i, i + 1);
    edge((nv - 1) * nu + i, (nv - 1) * nu + i + 1);
  }
  for (let j = 0; j < nv - 1; j++) {
    edge(j * nu, (j + 1) * nu);
    edge(j * nu + nu - 1, (j + 1) * nu + nu - 1);
  }
}

/** Cloth as a grid of flat quads, both faces drawn: crisp stripes and checks, folds read in the facets. */
function cloth(b: MeshBuilder, nu: number, nv: number, P: (u: number, v: number) => V3, col: (i: number, j: number) => Surf) {
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = P(i / nu, j / nv);
      const c1 = P((i + 1) / nu, j / nv);
      const c2 = P((i + 1) / nu, (j + 1) / nv);
      const d = P(i / nu, (j + 1) / nv);
      const s = col(i, j);
      b.quad(a, c1, c2, d, s);
      b.quad(a, d, c2, c1, s);
    }
  }
}

/** A flake of paint or a rust stain laid flat on a panel: a rotated rectangle a hair off the surface, facing `n`. */
function flake(b: MeshBuilder, c: V3, n: V3, t: V3, w: number, h: number, ang: number, s: Surf) {
  const N = new THREE.Vector3(...n);
  const T = new THREE.Vector3(...t).applyAxisAngle(N, ang).multiplyScalar(w / 2);
  const B = new THREE.Vector3().crossVectors(N, T).normalize().multiplyScalar(h / 2);
  const C = new THREE.Vector3(...c);
  const p = (su: number, sv: number): V3 => [C.x + T.x * su + B.x * sv, C.y + T.y * su + B.y * sv, C.z + T.z * su + B.z * sv];
  b.quad(p(-1, -1), p(1, -1), p(1, 1), p(-1, 1), s);
}

function roundRect(p: THREE.Path, x0: number, y0: number, x1: number, y1: number, r: number) {
  p.moveTo(x0 + r, y0);
  p.lineTo(x1 - r, y0);
  p.quadraticCurveTo(x1, y0, x1, y0 + r);
  p.lineTo(x1, y1 - r);
  p.quadraticCurveTo(x1, y1, x1 - r, y1);
  p.lineTo(x0 + r, y1);
  p.quadraticCurveTo(x0, y1, x0, y1 - r);
  p.lineTo(x0, y0 + r);
  p.quadraticCurveTo(x0, y0, x0 + r, y0);
}

const latheCache = new Map<string, THREE.BufferGeometry>();
/** A lathe (about Y) over part of a turn, cached by key. */
function lathePart(key: string, pts: [number, number][], seg: number, phiStart = 0, phiLength = Math.PI * 2): THREE.BufferGeometry {
  let g = latheCache.get(key);
  if (!g) {
    g = new THREE.LatheGeometry(
      pts.map(([r, y]) => new THREE.Vector2(r, y)),
      seg,
      phiStart,
      phiLength,
    );
    g.computeVertexNormals();
    latheCache.set(key, g);
  }
  return g;
}

/** The teardrop tank's profile: unit length along Y (front at +0.5), fattest toward the front. */
const TANK: [number, number][] = [
  [0, -0.5],
  [0.17, -0.47],
  [0.29, -0.39],
  [0.39, -0.24],
  [0.46, -0.05],
  [0.5, 0.14],
  [0.49, 0.29],
  [0.42, 0.41],
  [0.26, 0.485],
  [0, 0.5],
];

// ------------------------------------------------------------------------------------------------ wheels

const wheelCache = new Map<string, THREE.BufferGeometry>();

/**
 * A trike wheel: the laced motorcycle wheel in front, a small pressed-steel one behind. The stock wheel models with the
 * chrome rusted off and the paint gone to grime, so they belong on this machine. Axle along X; cached and shared.
 */
export function trikeWheelGeometry(r: number, front: boolean, noBrake = false): THREE.BufferGeometry {
  const key = `${r}:${front ? 'f' : 'r'}${noBrake ? 'n' : ''}`;
  const hit = wheelCache.get(key);
  if (hit) return hit;
  const st: WheelStyle = front ? { tread: 'moto', rim: 'wire', rimColor: 0x6a4630, noBrake } : { tread: 'road', rim: 'steel', rimColor: 0xa4967c, noBrake };
  const src = wheelGeometry(r, front ? 0.11 : 0.14, st);
  const b = new MeshBuilder();
  appendGeo(b, src, new THREE.Matrix4());
  const rust = new THREE.Color(0x5e3a24);
  const c = new THREE.Color();
  for (let i = 0; i < b.srf.length / 4; i++) {
    const m = b.srf[i * 4 + 1];
    // Rubber stays rubber.
    if (m < 0.01) continue;
    if (b.srf[i * 4] < 0.15 && m > 0.95) {
      // Chrome spokes and rim: pitted brown steel now.
      c.setRGB(b.col[i * 3], b.col[i * 3 + 1], b.col[i * 3 + 2]).lerp(rust, 0.72);
      b.col[i * 3] = c.r;
      b.col[i * 3 + 1] = c.g;
      b.col[i * 3 + 2] = c.b;
      b.srf[i * 4] = 0.62;
      b.srf[i * 4 + 1] = 0.55;
    }
    b.srf[i * 4 + 2] = Math.max(b.srf[i * 4 + 2], 0.88);
  }
  const g = shared(b.build());
  wheelCache.set(key, g);
  return g;
}

/** One whole trike wheel lying flat, rim and tyre (part `tyre_trike`, or the small `tyre_trike_r`). Origin: middle of its base. */
export function drawTrikeWheel(b: MeshBuilder, rear: boolean) {
  const g = trikeWheelGeometry(rear ? R_REAR : R_FRONT, !rear);
  if (!g.boundingBox) g.computeBoundingBox();
  // Axle turned upright, the outer face up, resting on its lowest point.
  const lift = -g.boundingBox!.min.x;
  appendGeo(b, g, new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(0, lift, 0));
}

// ------------------------------------------------------------------------------------------------ suspension lift kit

/** A coil-over shock lying along a -> c: damper body, shaft, eyes, spring seats and a coil wound round it. */
function coilOver(b: MeshBuilder, a: V3, c: V3, spring: number, r = 0.042) {
  const A = new THREE.Vector3(...a);
  const C = new THREE.Vector3(...c);
  const dir = C.clone().sub(A);
  const len = dir.length();
  dir.normalize();
  const side = new THREE.Vector3(0, 1, 0);
  if (Math.abs(dir.y) > 0.9) side.set(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(dir, side).normalize();
  const w = new THREE.Vector3().crossVectors(dir, u).normalize();
  const at = (t: number): V3 => {
    const p = A.clone().addScaledVector(dir, len * t);
    return [p.x, p.y, p.z];
  };
  const body = S.steel(0x2e2c2a, 0.8);
  const shaft = S.metal(0x8a8480, 0.7);
  const [b0, b1, s1] = [at(0.06), at(0.58), at(0.94)];
  b.rod(b0[0], b0[1], b0[2], b1[0], b1[1], b1[2], r * 0.58, body, 10);
  b.rod(b1[0], b1[1], b1[2], s1[0], s1[1], s1[2], r * 0.26, shaft, 8);
  // Eyes at both ends, the hole across the shock.
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), w);
  const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
  for (const t of [0.03, 0.97]) {
    const p = at(t);
    b.torus(p[0], p[1], p[2], r * 0.5, r * 0.18, body, e.x, e.y, e.z, 6, 12);
  }
  // Spring seats: discs square to the shock.
  const qs = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const es = new THREE.Euler().setFromQuaternion(qs, 'YXZ');
  for (const t of [0.12, 0.86]) {
    const p = at(t);
    b.cyl(p[0], p[1], p[2], r * 2.5, 0.014, r * 2.5, S.steel(0x4a4642, 0.8), es.x, es.y, es.z, 12);
  }
  // The coil.
  const turns = Math.max(5, Math.round((len * 0.72) / 0.05));
  const per = 6;
  const pts: V3[] = [];
  for (let i = 0; i <= turns * per; i++) {
    const t = i / (turns * per);
    const ang = t * turns * Math.PI * 2;
    const p = A.clone()
      .addScaledVector(dir, len * (0.13 + t * 0.72))
      .addScaledVector(u, Math.cos(ang) * r)
      .addScaledVector(w, Math.sin(ang) * r);
    pts.push([p.x, p.y, p.z]);
  }
  wire(b, pts, r * 0.16, S.paint(spring, 0.75), 4);
}

/** The Suspension Lift Kit (`sus_lift`) lying on the ground: two long coil-overs, two spacer blocks and their U-bolts. */
export function drawLiftKit(b: MeshBuilder) {
  b.seed(5);
  const r = 0.042;
  coilOver(b, [0.11, r + 0.004, -0.3], [0.11, r + 0.004, 0.3], 0xc8962a, r);
  coilOver(b, [-0.11, r + 0.004, 0.31], [-0.1, r + 0.004, -0.29], 0xc8962a, r);
  // Spacer blocks for the leaf springs, with a locating pin on top.
  const blk = S.steel(0x5a5652, 0.85);
  for (const [x, z, yaw] of [
    [0.33, 0.12, 0.2],
    [0.36, -0.12, -0.15],
  ] as const) {
    b.rbox(x, 0.03, z, 0.075, 0.06, 0.15, 0.008, blk, 0, yaw, 0);
    b.cyl(x, 0.066, z, 0.024, 0.014, 0.024, S.steel(0x2a2826), 0, 0, 0, 8);
  }
  // U-bolts lying flat, threads and nuts.
  const bolt = S.steel(0x6a6660, 0.8);
  for (const [x, z] of [
    [-0.33, 0.12],
    [-0.36, -0.08],
  ] as const) {
    const pts: V3[] = [];
    for (let i = 0; i <= 6; i++) {
      const a = Math.PI + (i / 6) * Math.PI;
      pts.push([x + Math.cos(a) * 0.045, 0.01, z + 0.06 + Math.sin(a) * 0.045]);
    }
    pts.unshift([x - 0.045, 0.01, z + 0.2]);
    pts.push([x + 0.045, 0.01, z + 0.2]);
    wire(b, pts, 0.008, bolt, 6);
    for (const sx of [-1, 1]) b.cyl(x + sx * 0.045, 0.012, z + 0.21, 0.026, 0.022, 0.026, S.steel(0x3a3836), Math.PI / 2, 0, 0, 6);
  }
}

// ------------------------------------------------------------------------------------------------ the cab

function sideWallShape(): THREE.Shape {
  const s = new THREE.Shape();
  const a = Math.asin(-C_WY / C_AR);
  const dz = C_AR * Math.cos(a);
  s.moveTo(-C_HL, 0);
  s.lineTo(C_WZ - dz, 0);
  s.absarc(C_WZ, C_WY, C_AR, Math.PI - a, a, true);
  s.lineTo(C_HL, 0);
  s.lineTo(C_HL, C_WT - 0.12);
  s.quadraticCurveTo(C_HL, C_WT, C_HL - 0.1, C_WT);
  s.lineTo(-C_HL, C_WT);
  s.closePath();
  const win = new THREE.Path();
  roundRect(win, WIN.z0, WIN.y0, WIN.z1, WIN.y1, 0.07);
  s.holes.push(win);
  return s;
}

function rearWallShape(): THREE.Shape {
  const s = new THREE.Shape();
  const r = ROOF_R - 0.02;
  const top = ROOF_YC + Math.sqrt(r * r - C_HW * C_HW);
  const a0 = Math.atan2(top - ROOF_YC, C_HW);
  s.moveTo(-C_HW, 0);
  s.lineTo(C_HW, 0);
  s.lineTo(C_HW, top);
  s.absarc(0, ROOF_YC, r, a0, Math.PI - a0, false);
  s.closePath();
  return s;
}

/** The arched tunnel over a rear wheel inside the cab, open underneath. */
function wellBandShape(): THREE.Shape {
  const s = new THREE.Shape();
  const a = Math.asin((C_FT - C_WY) / (C_AR - 0.02));
  s.absarc(0, 0, C_AR, a, Math.PI - a, false);
  s.absarc(0, 0, C_AR - 0.02, Math.PI - a, a, true);
  s.closePath();
  return s;
}

function wellSideShape(): THREE.Shape {
  const s = new THREE.Shape();
  const r = C_AR - 0.01;
  const a = Math.asin((C_FT - C_WY) / r);
  s.absarc(0, 0, r, a, Math.PI - a, false);
  s.closePath();
  return s;
}

/** A point on the roof: u across (0 at the +X eave), v along (0 at the rear lip, 1 at the front lip, both rolled down). */
function roofPoint(u: number, v: number): V3 {
  const phi = ROOF_PHI0 + u * (Math.PI - 2 * ROOF_PHI0);
  const x = ROOF_R * Math.cos(phi);
  const y = ROOF_YC + ROOF_R * Math.sin(phi);
  const z0 = -C_HL + 0.03;
  const z1 = C_HL + 0.02;
  const rr = 0.08;
  const bm = 1.35;
  const L0 = rr * bm;
  const L1 = z1 - z0;
  const s = v * (2 * L0 + L1);
  let z: number;
  let dy = 0;
  if (s < L0) {
    const be = bm - s / rr;
    z = z0 - rr * Math.sin(be);
    dy = -rr * (1 - Math.cos(be));
  } else if (s > L0 + L1) {
    const be = (s - L0 - L1) / rr;
    z = z1 + rr * Math.sin(be);
    dy = -rr * (1 - Math.cos(be));
  } else z = z0 + (s - L0);
  // Dents and buckles in the tin.
  const n = valueNoise3(x * 3.3 + 1.7, z * 3.3, 0.5, 7) - 0.5;
  const n2 = valueNoise3(x * 8.1, z * 8.1 + 3.1, 1.5, 8) - 0.5;
  return [x, y + dy + n * 0.018 + n2 * 0.006, z];
}

function roofSurf(p: V3, outer: boolean): Surf {
  if (!outer) return S.rust(0x4e2c1a);
  const n1 = valueNoise3(p[0] * 3.2 + 2, p[2] * 3.2, 1.7, 21);
  const n2 = valueNoise3(p[0] * 7.3 + 3, p[2] * 7.3, 0.3, 22);
  if (n1 > 0.7) return S.paint(0x4a6688, 0.8);
  if (n1 > 0.66) return S.paint(0x7d868c, 0.85);
  if (n2 > 0.68) return S.rust(0x582a16);
  if (n2 < 0.3) return S.paint(0xa06a2a, 0.95);
  return S.paint(0x8a4e24, 0.95);
}

/**
 * Flaking paint and rust stains scattered over a flat panel. `place(margin)` picks a spot on the panel and says whether a
 * patch that far across stays on the sheet, clear of its edges and openings.
 */
function weather(b: MeshBuilder, r: () => number, n: number, place: (margin: number) => { c: V3; ok: boolean }, nrm: V3, tan: V3) {
  const paints = [0x46658a, 0x5a7896, 0x7d868c, 0x8ea0b0, 0x3a5476];
  for (let i = 0; i < n; i++) {
    if (r() < 0.3) {
      // A rust run down the sheet from a seam or a rivet: narrow across, long down.
      const w = 0.03 + r() * 0.03;
      const h = 0.14 + r() * 0.2;
      const { c, ok } = place(h / 2 + 0.01);
      if (ok) flake(b, c, nrm, tan, w, h, (r() - 0.5) * 0.15, S.rust(r() < 0.5 ? 0x4a2414 : 0x6a3016));
      continue;
    }
    const { c, ok } = place(0.16);
    if (!ok) continue;
    const col = paints[Math.floor(r() * paints.length)];
    const s = S.paint(col, 0.7 + r() * 0.2);
    const k = 1 + Math.floor(r() * 3);
    for (let j = 0; j < k; j++) {
      const off: V3 = [(r() - 0.5) * 0.08, (r() - 0.5) * 0.08, (r() - 0.5) * 0.08];
      const cc: V3 = [c[0] + off[0] * (1 - Math.abs(nrm[0])), c[1] + off[1], c[2] + off[2] * (1 - Math.abs(nrm[2]))];
      flake(b, cc, nrm, tan, 0.05 + r() * 0.12, 0.04 + r() * 0.09, r() * Math.PI, s);
    }
  }
}

/** The mesh over a side window: a welded square grid, or chain-link diamonds. */
function windowMesh(b: MeshBuilder, x: number, chain: boolean) {
  const s = S.steel(0x5e5852, 0.88);
  const z0 = WIN.z0 - 0.005;
  const z1 = WIN.z1 + 0.005;
  const y0 = WIN.y0 - 0.005;
  const y1 = WIN.y1 + 0.005;
  const r = 0.0032;
  if (!chain) {
    const st = 0.072;
    for (let z = z0 + st * 0.6; z < z1; z += st) b.rod(x, y0, z, x, y1, z, r, s, 4);
    for (let y = y0 + st * 0.6; y < y1; y += st) b.rod(x, y, z0, x, y, z1, r, s, 4);
    return;
  }
  const st = 0.075;
  const h = y1 - y0;
  for (const slope of [1, -1]) {
    for (let c = z0 - h; c < z1 + h; c += st) {
      // z = c + slope * (y - y0): clip to the opening.
      let ya = y0;
      let yb = y1;
      const zAt = (y: number) => c + slope * (y - y0);
      const yAt = (z: number) => y0 + (z - c) / slope;
      const lo = Math.min(yAt(z0), yAt(z1));
      const hi = Math.max(yAt(z0), yAt(z1));
      ya = Math.max(ya, lo);
      yb = Math.min(yb, hi);
      if (yb - ya < 0.02) continue;
      b.rod(x, ya, zAt(ya), x, yb, zAt(yb), r, s, 4);
    }
  }
}

let cabCache: MeshBuilder | null = null;

/**
 * The Rickshaw Cab (`rr_rickshaw`) in its own frame: origin the middle of the floor's underside, +Z out of the open front,
 * +X to its left. Drawn once and copied, on the trike and as the loose part alike.
 */
export function drawRickshawCab(b: MeshBuilder) {
  cabCache ??= buildCab();
  b.append(cabCache);
}

function buildCab(): MeshBuilder {
  const b = new MeshBuilder();
  b.jitter = 0.05;
  b.roundSeg = 1;
  b.seed(77);
  const r = rng(91);
  const sheet = S.paint(0xb07428, 0.95);
  const rustS = S.rust(0x6a3218);
  const frame = S.steel(0x4a3c32, 0.9);
  const floor = S.steel(0x5c4838, 0.95);

  // Floor: a plate between the wheel arches and strips fore and aft of them, ribbed, with a lip at the front.
  const aF = Math.asin((C_FT - C_WY) / C_AR);
  const dzF = C_AR * Math.cos(aF);
  const zA = C_WZ - dzF;
  const zB = C_WZ + dzF;
  b.box(0, C_FT / 2, 0, 0.94, C_FT, C_HL * 2, floor);
  for (const sx of [1, -1]) {
    b.box(sx * 0.56, C_FT / 2, (zB + C_HL) / 2, 0.18, C_FT, C_HL - zB, floor);
    b.box(sx * 0.56, C_FT / 2, (zA - C_HL) / 2, 0.18, C_FT, zA + C_HL, floor);
  }
  for (let i = 0; i < 6; i++) b.box(-0.35 + i * 0.14, C_FT + 0.004, 0.02, 0.022, 0.008, C_HL * 2 - 0.12, i % 2 ? rustS : frame);
  b.box(0, C_FT + 0.018, C_HL - 0.006, C_HW * 2 - 0.04, 0.036, 0.012, frame);
  // Wheel wells: an arched tunnel over each rear wheel, closed on the inboard side.
  for (const sx of [1, -1]) {
    b.extrude('rickshawWell', wellBandShape, 0.18, 0.004, sx * (C_HW - 0.09), C_WY, C_WZ, rustS, 0, -Math.PI / 2, 0);
    b.extrude('rickshawWellSide', wellSideShape, 0.012, 0.003, sx * (C_HW - 0.18), C_WY, C_WZ, S.paint(0x8a5a2a, 0.95), 0, -Math.PI / 2, 0);
  }

  // Side walls (an arch over the wheel, a big window) and the closed back.
  for (const sx of [1, -1]) b.extrude('rickshawSide', sideWallShape, 0.025, 0.005, sx * (C_HW - 0.0125), 0, 0, sheet, 0, -Math.PI / 2, 0);
  b.extrude('rickshawRear', rearWallShape, 0.025, 0.005, 0, 0, -C_HL + 0.0125, sheet);

  // The roof: one rounded sheet, overhanging and rolled down front and back, blotched with old blue paint.
  const us = Array.from({ length: 15 }, (_, i) => i / 14);
  const vs = [0, 0.02, 0.045, 0.07, ...Array.from({ length: 10 }, (_, i) => 0.1 + (i / 9) * 0.8), 0.93, 0.955, 0.98, 1];
  smoothSheet(b, us, vs, roofPoint, 0.018, roofSurf);
  // Bows under it, front and middle, following its curve.
  for (const z of [C_HL - 0.02, 0.02]) {
    const pts: V3[] = [];
    for (let k = 0; k <= 8; k++) {
      const phi = ROOF_PHI0 + 0.04 + (k / 8) * (Math.PI - 2 * ROOF_PHI0 - 0.08);
      pts.push([(ROOF_R - 0.035) * Math.cos(phi), ROOF_YC + (ROOF_R - 0.035) * Math.sin(phi), z]);
    }
    wire(b, pts, 0.014, frame, 6);
  }

  for (const sx of [1, -1]) {
    const xo = sx * (C_HW + 0.002);
    const xi = sx * (C_HW - 0.034);
    // Front pillar: a rolled edge on the open front, with a grab handle inside it.
    b.rod(sx * (C_HW - 0.008), 0.0, C_HL - 0.004, sx * (C_HW - 0.008), C_WT - 0.12, C_HL - 0.004, 0.017, frame, 8);
    b.rod(sx * (C_HW - 0.07), 0.42, C_HL - 0.06, sx * (C_HW - 0.07), 0.98, C_HL - 0.06, 0.012, S.steel(0x7a746c, 0.7), 8);
    for (const y of [0.42, 0.98]) b.rod(sx * (C_HW - 0.07), y, C_HL - 0.06, sx * (C_HW - 0.025), y, C_HL - 0.06, 0.009, frame, 6);
    // A pressed rib along the flank at the window sill, and a row of rivets along the bottom.
    b.rod(xo + sx * 0.002, WIN.y0 - 0.04, -C_HL + 0.01, xo + sx * 0.002, WIN.y0 - 0.04, C_HL - 0.01, 0.007, sheet, 6);
    for (let i = 0; i < 12; i++) {
      const z = -C_HL + 0.05 + i * ((C_HL * 2 - 0.1) / 11);
      if (Math.abs(z - C_WZ) < C_AR + 0.02) continue;
      b.add('ico', xo, 0.05, z, 0.017, 0.017, 0.017, frame);
    }
    // Window: an angle-iron frame inside the opening and the mesh across it.
    const fr = S.steel(0x3e342c, 0.9);
    b.rod(xi, WIN.y0 - 0.008, WIN.z0, xi, WIN.y0 - 0.008, WIN.z1, 0.011, fr, 6);
    b.rod(xi, WIN.y1 + 0.008, WIN.z0, xi, WIN.y1 + 0.008, WIN.z1, 0.011, fr, 6);
    b.rod(xi, WIN.y0, WIN.z0 - 0.008, xi, WIN.y1, WIN.z0 - 0.008, 0.011, fr, 6);
    b.rod(xi, WIN.y0, WIN.z1 + 0.008, xi, WIN.y1, WIN.z1 + 0.008, 0.011, fr, 6);
    windowMesh(b, xi + sx * 0.004, sx < 0);
    // Old paint flaking off the outside.
    weather(
      b,
      r,
      30,
      (mg) => {
        const z = (r() * 2 - 1) * (C_HL - mg);
        const y = mg + r() * Math.max(0, C_WT - 2 * mg);
        const inWin = z > WIN.z0 - mg && z < WIN.z1 + mg && y > WIN.y0 - mg && y < WIN.y1 + mg;
        const inArch = Math.hypot(z - C_WZ, y - C_WY) < C_AR + mg;
        return { c: [xo, y, z], ok: !inWin && !inArch };
      },
      [sx, 0, 0],
      [0, 0, 1],
    );
  }
  // The back: rear lamp housings, a faded plate, a bumper tube, weathering.
  for (const sx of [1, -1]) b.rbox(sx * 0.5, 0.2, -C_HL - 0.012, 0.15, 0.1, 0.024, 0.01, S.steel(0x2a2624, 0.7));
  b.box(0, 0.36, -C_HL - 0.006, 0.28, 0.12, 0.008, S.paint(0xd2c8a0, 0.9));
  b.box(0, 0.36, -C_HL - 0.009, 0.24, 0.02, 0.004, S.paint(0x2a2a2a, 0.6));
  b.pipe(
    [
      [-0.62, 0.08, -C_HL - 0.01],
      [-0.56, 0.03, -C_HL - 0.07],
      [0.56, 0.03, -C_HL - 0.07],
      [0.62, 0.08, -C_HL - 0.01],
    ],
    0.018,
    frame,
    8,
  );
  weather(
    b,
    r,
    20,
    (mg) => {
      const x = (r() * 2 - 1) * (C_HW - mg);
      const y = mg + r() * 1.1;
      const top = ROOF_YC + Math.sqrt((ROOF_R - 0.02) ** 2 - x * x) - mg;
      const nearLamp = Math.abs(Math.abs(x) - 0.5) < 0.08 + mg && Math.abs(y - 0.2) < 0.05 + mg;
      const nearPlate = Math.abs(x) < 0.14 + mg && Math.abs(y - 0.36) < 0.06 + mg;
      return { c: [x, y, -C_HL - 0.002], ok: y < top && !nearLamp && !nearPlate };
    },
    [0, 0, -1],
    [1, 0, 0],
  );

  // The bench across the back: ochre-painted planks on a box, a plank backrest against the rear wall.
  const ochre = S.wood(0xc8923a, 0.6);
  const ochre2 = S.wood(0xb88232, 0.65);
  const benchW = C_HW * 2 - 0.08;
  b.box(0, (C_FT + BENCH.top - 0.035) / 2, BENCH.z1 + 0.012, benchW - 0.04, BENCH.top - 0.035 - C_FT, 0.022, ochre2);
  for (const sx of [1, -1]) b.box(sx * (benchW / 2 - 0.03), (C_FT + BENCH.top - 0.035) / 2, (BENCH.z0 + BENCH.z1) / 2, 0.03, BENCH.top - 0.035 - C_FT, BENCH.z1 - BENCH.z0, ochre2);
  for (let i = 0; i < 3; i++) {
    const d = (BENCH.z1 - BENCH.z0) / 3;
    const z = BENCH.z1 - d * (i + 0.5);
    b.rbox(0, BENCH.top - 0.0175 + (r() - 0.5) * 0.004, z, benchW, 0.035, d - 0.012, 0.006, i === 1 ? ochre2 : ochre, (r() - 0.5) * 0.02, 0, (r() - 0.5) * 0.01);
  }
  for (const [y, h] of [
    [0.6, 0.13],
    [0.79, 0.12],
  ] as const) {
    b.rbox(0, y, -C_HL + 0.055 + (y - 0.6) * 0.06, benchW - 0.02, h, 0.03, 0.006, y > 0.7 ? ochre2 : ochre, -0.08, 0, 0);
  }
  for (const sx of [1, -1]) b.box(sx * 0.42, 0.68, -C_HL + 0.035, 0.05, 0.4, 0.02, ochre2, -0.08, 0, 0);

  // The striped curtain slung along the right-hand side, sagging like a hammock.
  b.rod(-0.6, 1.11, C_HL - 0.06, -0.6, 1.11, -C_HL + 0.06, 0.004, S.steel(0x6a6460), 4);
  const stripes = [0x23406c, 0xaeb8c2, 0x34588a, 0x8c9aac, 0x23406c, 0xc8ccd0, 0x2c4c7c];
  cloth(
    b,
    12,
    7,
    (u, v) => {
      const sag = 4 * u * (1 - u);
      const z = C_HL - 0.07 - u * (C_HL * 2 - 0.14);
      const top = 1.11 - 0.24 * sag;
      const y = top - v * (0.15 + 0.1 * sag);
      const x = -0.6 + 0.1 * sag * (0.35 + v) + 0.016 * Math.sin(u * Math.PI * 9 + v * 1.4) * (0.25 + v);
      return [x, y, z];
    },
    (_i, j) => S.cloth(stripes[j % stripes.length], 0.55),
  );
  // Its loose end hanging down by the front pillar.
  cloth(
    b,
    2,
    6,
    (u, v) => [-0.59 + 0.01 * Math.sin(v * 5), 1.1 - v * 0.42, C_HL - 0.07 - u * 0.1 - v * 0.03 * Math.sin(u * 3)],
    (i, j) => S.cloth(stripes[(j + i) % stripes.length], 0.55),
  );

  // A rusty can of paintbrushes hung on the inside of the right wall, ahead of the window.
  {
    const x = -(C_HW - 0.025) + 0.056;
    const y = 0.7;
    const z = 0.555;
    b.cyl(x, y, z, 0.1, 0.13, 0.1, S.paint(0xa8461f, 0.85), 0, 0, 0, 12);
    b.torus(x, y + 0.065, z, 0.05, 0.005, S.steel(0x6a5a4a), Math.PI / 2, 0, 0, 5, 14);
    b.cyl(x, y + 0.062, z, 0.094, 0.004, 0.094, S.paint(0x1e1a16, 0.5), 0, 0, 0, 12);
    wire(b, [[x - 0.05, y + 0.06, z], [-(C_HW - 0.03), y + 0.13, z], [x + 0.05, y + 0.06, z]], 0.003, S.steel(0x5a5650), 4);
    const brush = (dx: number, dz: number, lean: number, len: number, bristleUp: boolean) => {
      const bx = x + dx;
      const bz = z + dz;
      const tx = bx + Math.sin(lean) * len * 0.3;
      const ty = y + 0.04 + len;
      const tz = bz + Math.cos(lean) * len * 0.15;
      b.rod(bx, y + 0.02, bz, tx, ty, tz, 0.0085, S.wood(0xb07a40, 0.5), 6);
      if (bristleUp) {
        b.cyl(tx, ty, tz, 0.026, 0.03, 0.02, S.metal(0x9a9a92, 0.6), 0, 0, 0, 8);
        b.box(tx, ty + 0.03, tz, 0.024, 0.04, 0.012, S.paint(0x2c4a7a, 0.6));
      } else b.cyl(tx, ty, tz, 0.014, 0.012, 0.014, S.paint(0x8a2a1a, 0.6), 0, 0, 0, 6);
    };
    brush(0.018, -0.012, 0.6, 0.14, false);
    brush(-0.014, 0.016, -0.4, 0.17, false);
    brush(0.004, 0.0, 2.2, 0.12, true);
  }

  // A chequered rag hung by a corner from a nail by the back of the left window.
  {
    const nail: V3 = [C_HW - 0.035, 1.1, -0.585];
    b.cyl(nail[0] + 0.01, nail[1], nail[2], 0.008, 0.03, 0.008, S.steel(0x5a5650), 0, 0, Math.PI / 2, 5);
    cloth(
      b,
      6,
      6,
      (u, v) => {
        const s = 0.2;
        const y = nail[1] - (u + v) * s * 0.72 + 0.02 * Math.sin(u * 7);
        const z = nail[2] + (u - v) * s * 0.7;
        const x = nail[0] - 0.012 - 0.025 * Math.sin((u + v) * 2.6) * (u + v) * 0.6;
        return [x, y, z];
      },
      (i, j) => S.cloth((i + j) % 2 ? 0x1c1c1c : 0xe2ddd0, 0.6),
    );
  }
  return b;
}

// ------------------------------------------------------------------------------------------------ the trike

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _t = new THREE.Vector3();
const AXIS_X = new THREE.Vector3(1, 0, 0);
/** Where a seated passenger's elbows point: out and back. */
const LAP_POLE = [new THREE.Vector3(0.6, -0.2, -0.8).normalize(), new THREE.Vector3(-0.6, -0.2, -0.8).normalize()];

/**
 * Sit someone on a seat and put their feet on the floor in front of it: the hips at `hipY` over (x, z), the legs as two
 * links reaching `reach` ahead and down to `floorY`, hands resting on the thighs. Chassis frame. Call after the pose.
 */
function sitOn(h: Humanoid, floorY: number, hipY: number, z: number, reach: number) {
  const k = h.root.scale.y;
  // Along the bench wherever they were put (the middle unless someone slid them over), never through the walls.
  h.root.position.set(Math.max(-0.32, Math.min(0.32, h.root.position.x)), floorY, z);
  h.hips.position.set(0, (hipY - floorY) / k, 0);
  const lean = -0.03;
  h.torso.rotation.x = lean;
  const D = Math.max(0.12, hipY - floorY - 0.07);
  const d = Math.min(0.85 * k, Math.hypot(reach, D));
  const phi = Math.atan2(reach, D);
  const alpha = Math.acos(Math.min(1, d / (0.86 * k)));
  const thigh = phi + alpha;
  const shin = phi - alpha;
  for (const [leg, knee, sx] of [
    [h.legL, h.kneeL, 1],
    [h.legR, h.kneeR, -1],
  ] as const) {
    leg.rotation.set(-thigh, 0, sx * 0.06);
    knee.rotation.set(thigh - shin, 0, 0);
    // A hand on the thigh, just short of the knee.
    const lp = leg.position;
    _t.set(lp.x + sx * 0.02, lp.y - 0.43 * 0.78 * Math.cos(thigh) + 0.07, lp.z + 0.43 * 0.78 * Math.sin(thigh));
    // Into the torso's frame (it leans about its own origin at the hips).
    _qa.setFromAxisAngle(AXIS_X, -lean);
    _t.applyQuaternion(_qa);
    h.reach(sx > 0 ? 'L' : 'R', _t, LAP_POLE[sx > 0 ? 0 : 1]);
  }
}

/** The Rickshaw Trike. `look.fit.rear` being the cab draws the cab; a missing engine or wheel shows as a gap or a stand. */
export function buildTrike(def: VehicleDef, wheelLocal: [number, number, number][], steered: boolean[], look: VehicleLook): VehicleVisual {
  const v = blank(def);
  const b = new MeshBuilder();
  b.jitter = 0.035;
  b.roundSeg = 1;
  b.seed(66);
  const wear = Math.min(1, 0.72 + look.wear * 0.3);
  const red = S.paint(0x8e3a22, wear);
  const redFade = S.paint(0xa04e30, Math.min(1, wear + 0.05));
  const rust = S.rust(0x6a3218);
  const subSteel = S.steel(0x3e3a36, 0.9);
  const dark = S.steel(0x26231f, 0.75);
  const hasCab = look.fit.rear?.id === 'rr_rickshaw';
  const eng = look.engine && !look.engine.empty ? look.engine : null;
  const gone = (i: number) => look.tyres?.[i] === -1;

  // ---- the bike's frame: head tube, backbone, twin down tubes into a cradle, seat post and stays into the subframe.
  b.rod(...up(0.56), ...up(0.82), 0.042, red, 12);
  b.torus(...up(0.56), 0.044, 0.008, rust, -RAKE + Math.PI / 2, 0, 0, 5, 14);
  b.pipe([up(0.74), [0, 0.27, 0.3], [0, 0.17, 0.0], [0, 0.13, -0.3]], 0.03, red, 10);
  for (const sx of [1, -1]) {
    b.pipe(
      [
        up(0.6, sx * 0.03),
        [sx * 0.09, 0.02, 0.62],
        [sx * 0.14, -0.33, 0.585],
        [sx * 0.15, -0.4, 0.52],
        [sx * 0.15, -0.4, -0.04],
        [sx * 0.17, -0.36, -0.2],
        [sx * 0.32, -0.27, -0.3],
      ],
      0.024,
      red,
      10,
    );
    b.pipe([[sx * 0.03, 0.135, -0.1], [sx * 0.12, -0.1, -0.08], [sx * 0.15, -0.4, -0.04]], 0.021, red, 8);
    b.pipe([[sx * 0.03, 0.13, -0.26], [sx * 0.18, -0.04, -0.3], [sx * 0.33, -0.25, -0.31]], 0.019, redFade, 8);
    // Foot pegs where the boots land, rubber on the ends.
    b.box(sx * 0.17, -0.41, 0.12, 0.05, 0.03, 0.05, dark);
    b.rod(sx * 0.15, -0.415, 0.12, sx * 0.27, -0.415, 0.12, 0.012, dark, 8);
    b.cyl(sx * 0.235, -0.415, 0.12, 0.034, 0.08, 0.034, S.rubber(0x1e1c1a), 0, 0, Math.PI / 2, 8);
  }
  b.rod(-0.15, -0.4, -0.04, 0.15, -0.4, -0.04, 0.018, red, 8);
  b.rod(-0.15, -0.4, 0.52, 0.15, -0.4, 0.52, 0.018, red, 8);
  // Engine mount plates across the cradle, and their bolt tabs.
  for (const z of [0.27, 0.49]) {
    b.box(0, -0.395, z, 0.32, 0.014, 0.07, subSteel);
    for (const sx of [1, -1]) b.box(sx * 0.09, -0.372, z, 0.012, 0.04, 0.05, subSteel);
  }

  // ---- teardrop tank on the backbone, its filler cap, the petcock, and a stripe in the owner's colour down each side.
  const tankY = 0.36;
  const tankZ = 0.31;
  const tankRx = Math.PI / 2 - 0.14;
  b.geo(lathePart('trikeTank', TANK, 18), 0, tankY, tankZ, 0.27, 0.44, 0.22, S.paint(0x963c22, wear), tankRx, 0, 0);
  const stripeProf = TANK.slice(2, 8).map(([r, y]) => [r * 1.02, y] as [number, number]);
  for (const side of [Math.PI / 2, (Math.PI * 3) / 2]) {
    b.geo(lathePart(`trikeTankStripe:${side.toFixed(2)}`, stripeProf, 3, side - 0.09, 0.18), 0, tankY, tankZ, 0.27, 0.44, 0.22, S.paint(look.paint, 0.55), tankRx, 0, 0);
  }
  b.cyl(0.04, 0.472, 0.37, 0.065, 0.024, 0.065, S.metal(0x8a8278, 0.85), -0.14, 0, 0, 12);
  b.cyl(0.04, 0.486, 0.37, 0.03, 0.012, 0.03, S.metal(0x6a645c, 0.8), -0.14, 0, 0, 8);
  b.rbox(0.06, 0.255, 0.17, 0.03, 0.04, 0.03, 0.006, S.metal(0x7a7468, 0.8));

  // ---- the saddle: a worn solo seat, wide at the back, on a steel pan, with a taped split.
  b.box(0, 0.11, -0.14, 0.22, 0.012, 0.36, dark);
  b.extrude(
    'trikeSaddle',
    () => {
      const s = new THREE.Shape();
      s.moveTo(0, -0.07);
      s.quadraticCurveTo(0.065, -0.06, 0.075, 0.05);
      s.quadraticCurveTo(0.16, 0.15, 0.15, 0.26);
      s.quadraticCurveTo(0.13, 0.34, 0, 0.34);
      s.quadraticCurveTo(-0.13, 0.34, -0.15, 0.26);
      s.quadraticCurveTo(-0.16, 0.15, -0.075, 0.05);
      s.quadraticCurveTo(-0.065, -0.06, 0, -0.07);
      return s;
    },
    0.065,
    0.022,
    0,
    0.148,
    0,
    S.leather(0x2c231a, 0.75),
    -Math.PI / 2,
    0,
    0,
  );
  b.capsule(-0.12, 0.178, -0.31, 0.12, 0.178, -0.31, 0.022, S.leather(0x241c14, 0.8), 8);
  b.box(0.05, 0.182, -0.18, 0.09, 0.006, 0.05, S.cloth(0x6e6a5c, 0.5), 0, 0.5, 0);
  b.box(-0.06, 0.181, -0.24, 0.07, 0.006, 0.035, S.cloth(0x8a8474, 0.5), 0, -0.3, 0);

  // ---- the old rear mudguard, still on the frame behind the saddle, over the chain.
  b.extrude(
    'trikeRearGuard',
    () => {
      const s = new THREE.Shape();
      s.absarc(0, 0, 0.34, 0.9, 2.3, false);
      s.absarc(0, 0, 0.325, 2.3, 0.9, true);
      s.closePath();
      return s;
    },
    0.15,
    0.008,
    0,
    -0.36,
    -0.33,
    redFade,
    0,
    -Math.PI / 2,
    0,
  );
  b.rod(0.075, -0.06, -0.24, 0.12, -0.1, -0.1, 0.008, redFade, 6);
  b.rod(-0.075, -0.06, -0.24, -0.12, -0.1, -0.1, 0.008, redFade, 6);

  // ---- the welded-on rear subframe: two rails and four cross members, gussets where the bike meets it.
  for (const sx of [1, -1]) {
    b.rbox(sx * 0.36, -0.26, -0.94, 0.06, 0.06, 1.3, 0.008, subSteel);
    b.box(sx * 0.3, -0.27, -0.31, 0.13, 0.055, 0.06, red);
    b.box(sx * 0.33, -0.255, -0.4, 0.04, 0.03, 0.14, rust, 0, 0, sx * 0.6);
  }
  for (const z of [-0.3, -0.56, -1.06, -1.58]) b.rbox(0, -0.26, z, z === -0.3 ? 0.82 : 0.76, 0.05, 0.05, 0.008, subSteel);
  // The rear axle on leaf springs, with its chain sprocket and hubs.
  b.rod(-0.53, RA.y, RA.z, 0.53, RA.y, RA.z, 0.03, subSteel, 10);
  for (const sx of [1, -1]) b.cyl(sx * 0.505, RA.y, RA.z, 0.13, 0.035, 0.13, dark, 0, 0, Math.PI / 2, 14);
  b.cyl(-0.13, RA.y, RA.z, 0.22, 0.012, 0.22, rust, 0, 0, Math.PI / 2, 20);
  b.cyl(-0.13, RA.y, RA.z, 0.09, 0.03, 0.09, dark, 0, 0, Math.PI / 2, 10);
  const leafCol = S.steel(0x34302c, 0.85);
  // The springs hang from the rails at their eyes and sag to sit on top of the axle.
  const eye = -0.262;
  const camber = eye - (RA.y + 0.037);
  for (const sx of [1, -1]) {
    const x = sx * 0.42;
    for (let k = 0; k < 3; k++) {
      const L = 0.72 * (1 - k * 0.24);
      const segs = 4;
      for (let s = 0; s < segs; s++) {
        const y = (t: number) => eye - k * 0.012 - camber * (1 - (2 * t - 1) * (2 * t - 1));
        const t0 = s / segs;
        const t1 = (s + 1) / segs;
        const z0 = RA.z - L / 2 + L * t0;
        const z1 = RA.z - L / 2 + L * t1;
        const tt0 = 0.5 + (t0 - 0.5) * (L / 0.72);
        const tt1 = 0.5 + (t1 - 0.5) * (L / 0.72);
        const y0 = y(tt0);
        const y1 = y(tt1);
        b.box(x, (y0 + y1) / 2, (z0 + z1) / 2, 0.05, 0.011, Math.hypot(z1 - z0, y1 - y0) + 0.004, leafCol, -Math.atan2(y1 - y0, z1 - z0), 0, 0);
      }
    }
    // Hangers off the rail at each eye, and the U-bolts round the axle.
    for (const dz of [-0.36, 0.36]) {
      b.box(sx * 0.4, -0.25, RA.z + dz, 0.07, 0.035, 0.035, subSteel);
      b.cyl(x, eye, RA.z + dz, 0.035, 0.06, 0.035, dark, 0, 0, Math.PI / 2, 8);
    }
    for (const dz of [-0.035, 0.035]) b.rod(x - 0.03, -0.27, RA.z + dz, x - 0.03, RA.y - 0.035, RA.z + dz, 0.006, dark, 5);
    b.box(x, RA.y - 0.04, RA.z, 0.06, 0.014, 0.1, dark);
  }

  // ---- engine and drive, or the empty cradle.
  const exh = look.fit.exhaust ? partDef(look.fit.exhaust.id) : null;
  const stockExhaust = !exh || (!!exh.stock && !exh.empty);
  if (eng) {
    const ext = engineExtent(eng.id);
    // A swapped-in bigger lump keeps its nose behind the down tubes and hangs back under the saddle.
    const zc = Math.min(ENG_Z, 0.54 - ext.l / 2);
    const sub = new MeshBuilder();
    sub.jitter = 0.02;
    drawEngine(sub, eng.id, { wear: Math.min(1, eng.wear + 0.35) });
    b.appendMatrix(sub, new THREE.Matrix4().makeTranslation(0, ENG_BASE, zc - ext.z));
    // The gearbox output and its sprocket on the right, the chain back to the axle.
    b.rbox(-0.09, -0.31, 0.12, 0.06, 0.12, 0.22, 0.02, S.metal(0x4e4a46, 0.8));
    b.cyl(-0.13, -0.3, 0.02, 0.1, 0.012, 0.1, rust, 0, 0, Math.PI / 2, 12);
    wire(b, [[-0.13, -0.25, 0.02], [-0.13, RA.y + 0.11, RA.z]], 0.008, dark, 4);
    wire(b, [[-0.13, -0.35, 0.02], [-0.13, RA.y - 0.11, RA.z]], 0.008, dark, 4);
    // Throttle and clutch cables down from the head to the carbs, a fuel line from the tank.
    wire(b, [[0.03, 0.27, 0.66], [-0.06, 0.12, 0.55], [-0.13, -0.1, zc + 0.05]], 0.005, S.rubber(0x161616), 5);
    wire(b, [[0.06, 0.24, 0.17], [0.0, 0.1, 0.2], [-0.12, -0.12, zc - 0.04]], 0.006, S.rubber(0x3a3020), 5);
    if (stockExhaust) {
      // Two rusty pipes out of the right side of the head, past the left peg and back under the cab.
      const ex = (pts: V3[]) => exhaust(b, pts, 0.022, 0.042);
      ex([[0.14, -0.165, zc + 0.096], [0.25, -0.19, zc + 0.1], [0.33, -0.27, zc], [0.345, -0.31, 0.05], [0.34, -0.33, -0.3], [0.35, -0.31, -0.5]]);
      ex([[0.14, -0.165, zc - 0.096], [0.24, -0.21, zc - 0.1], [0.3, -0.3, zc - 0.16], [0.31, -0.36, 0.05], [0.3, -0.385, -0.3], [0.31, -0.37, -0.52]]);
      v.smoke.position.set(0.35, -0.31, -0.5);
    } else {
      // An aftermarket system (drawn with the kit) runs back along the right of the subframe to the tail.
      const m = TRIKE_MOUNTS;
      v.smoke.position.set(m.hw * 0.5, m.sill + 0.06, m.rear.z - 0.04);
    }
  } else {
    // No engine: daylight in the cradle, the chain hanging off the back sprocket into the dirt, cables and a fuel line loose.
    const g = GROUND + 0.006;
    wire(b, [[-0.13, RA.y + 0.11, RA.z], [-0.13, -0.24, -0.6], [-0.13, -0.38, -0.36], [-0.135, -0.5, -0.2], [-0.14, g + 0.01, 0.0], [-0.12, g, 0.12], [-0.06, g, 0.16]], 0.008, dark, 4);
    wire(b, [[-0.13, RA.y - 0.11, RA.z], [-0.13, g + 0.04, -0.66], [-0.13, g, -0.48], [-0.11, g, -0.4]], 0.008, dark, 4);
    wire(b, [[0.03, 0.27, 0.66], [0.02, 0.1, 0.56], [0.06, -0.06, 0.5], [0.1, -0.12, 0.44]], 0.005, S.rubber(0x161616), 5);
    wire(b, [[-0.03, 0.27, 0.66], [-0.05, 0.06, 0.58], [-0.04, -0.1, 0.55]], 0.005, S.rubber(0x161616), 5);
    wire(b, [[0.06, 0.24, 0.17], [0.07, 0.05, 0.2], [0.04, -0.06, 0.26], [0.0, -0.08, 0.32]], 0.006, S.rubber(0x3a3020), 5);
    wire(b, [[0.0, 0.25, 0.4], [0.03, 0.08, 0.42], [-0.02, -0.02, 0.38]], 0.004, S.plastic(0x8a1a12, 0.4), 4);
    v.smoke.position.set(0, -0.2, 0.3);
  }

  // ---- stands under any corner whose wheel is off.
  if (gone(0)) {
    const wood = S.wood(0x8a6a42, 0.8);
    const wood2 = S.wood(0x6e5232, 0.85);
    b.box(FA[0], -0.54, FA[2], 0.34, 0.12, 0.15, wood, 0, 0.12, 0);
    b.box(FA[0], -0.42, FA[2], 0.15, 0.12, 0.32, wood2, 0, -0.05, 0);
    b.box(FA[0], -0.325, FA[2], 0.26, 0.07, 0.12, wood, 0, 0.3, 0);
  }
  for (let i = 1; i < wheelLocal.length; i++) {
    if (!gone(i)) continue;
    const sx = Math.sign(wheelLocal[i][0]) || 1;
    const x = sx * 0.46;
    const z = wheelLocal[i][2];
    const st = S.paint(0xb4441e, 0.8);
    const top = RA.y - 0.035;
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + 0.4;
      b.rod(x + Math.cos(a) * 0.13, GROUND - 0.03, z + Math.sin(a) * 0.13, x, top - 0.12, z, 0.012, st, 6);
    }
    b.cyl(x, top - 0.08, z, 0.05, 0.1, 0.05, st, 0, 0, 0, 8);
    b.cyl(x, top - 0.02, z, 0.032, 0.05, 0.032, S.steel(0x8a8680, 0.6), 0, 0, 0, 8);
    b.box(x, top - 0.006, z, 0.05, 0.012, 0.08, st);
    // The bare hub the wheel came off: brake drum and studs.
    b.cyl(sx * 0.56, RA.y, z, 0.2, 0.05, 0.2, S.steel(0x4a4642, 0.85), 0, 0, Math.PI / 2, 16);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      b.cyl(sx * 0.6, RA.y + Math.sin(a) * 0.055, z + Math.cos(a) * 0.055, 0.016, 0.04, 0.016, S.steel(0x7a7670, 0.6), 0, 0, Math.PI / 2, 6);
    }
  }

  // ---- the cab on the subframe, or the bare subframe with its mounting tabs and a lamp on the back member.
  if (hasCab) {
    b.mark(partTag('slot', 'rear'), partMeta({ kind: 'slot', id: 'rr_rickshaw', slot: 'rear', mk: partDef('rr_rickshaw').mk, pivot: [0, CAB_AT[1], CAB_AT[2] + C_HL] }));
    const cab = new MeshBuilder();
    drawRickshawCab(cab);
    b.append(cab, CAB_AT[0], CAB_AT[1], CAB_AT[2]);
    b.end();
    for (const sx of [1, -1]) taillight(v, sx * 0.5, CAB_AT[1] + 0.2, CAB_AT[2] - C_HL - 0.026, 0.11, 0.06);
  } else {
    for (const sx of [1, -1]) {
      for (const z of [-0.42, -1.48]) {
        b.box(sx * 0.36, -0.227, z, 0.09, 0.006, 0.07, rust);
        b.cyl(sx * 0.36, -0.22, z, 0.018, 0.012, 0.018, dark, 0, 0, 0, 6);
      }
    }
    b.box(0, -0.2, -1.6, 0.16, 0.06, 0.03, dark);
    taillight(v, 0, -0.2, -1.62, 0.1, 0.05);
  }

  // ---- fitted kit (the cab and the engine are drawn above, the stripes are on the tank) and sprayed panels.
  const fit: Fit = { ...look.fit };
  if (hasCab) delete fit.rear;
  const kit: KitLook = { paint: look.paint, stripe: 0, stripeColor: look.stripeColor, seed: look.seed, fit, wear: look.wear, cooling: look.cooling };
  addKit(b, liveRig(v, b), TRIKE_MOUNTS, kit, { nativeGun: false });
  const sus = look.fit.suspension ? partDef(look.fit.suspension.id) : null;
  if (sus && sus.id === 'sus_lift') {
    // The lift kit: long coil-overs from the axle up to the rails, spacer blocks under the springs.
    for (const sx of [1, -1]) {
      coilOver(b, [sx * 0.47, RA.y - 0.02, RA.z + 0.02], [sx * 0.4, -0.235, RA.z - 0.3], 0xc8962a, 0.032);
      b.box(sx * 0.42, RA.y + 0.045, RA.z, 0.055, 0.02, 0.1, S.steel(0x5a5652, 0.85));
    }
  }
  paintPanels(b, look.paint, look.panels, TRIKE_MOUNTS);
  const bodyGeo = b.build();

  // ---- the front end: what turns with the bars (fb) and what slides with the wheel (sb), drawn in the chassis frame at
  // straight ahead and moved into the steering axis' frame.
  const fb = new MeshBuilder();
  fb.jitter = 0.03;
  fb.roundSeg = 1;
  fb.seed(67);
  const sb = new MeshBuilder();
  sb.jitter = 0.03;
  sb.seed(68);
  // Fork tubes: pitted steel above, the lower legs painted the frame's red and rusting through.
  const fork = S.metal(0x7e746a, 0.9);
  const FX = 0.095;
  for (const sx of [1, -1]) {
    fb.rod(...up(0.36, sx * FX), ...up(0.88, sx * FX), 0.021, fork, 10);
    fb.cyl(...up(0.885, sx * FX), 0.05, 0.02, 0.05, dark, -RAKE, 0, 0, 10);
    sb.rod(...up(-0.03, sx * FX), ...up(0.4, sx * FX), 0.031, red, 10);
    sb.cyl(...up(0.39, sx * FX), 0.07, 0.025, 0.07, rust, -RAKE, 0, 0, 10);
    sb.rbox(...up(0, sx * FX), 0.05, 0.075, 0.07, 0.012, dark, -RAKE, 0, 0);
  }
  // Triple clamps above and below the head tube, the stem nut on top.
  for (const t of [0.535, 0.845]) fb.rbox(...up(t), FX * 2 + 0.07, 0.045, 0.085, 0.015, red, -RAKE, 0, 0);
  fb.cyl(...up(0.875), 0.045, 0.02, 0.045, dark, -RAKE, 0, 0, 8);
  // Headlight: a round bucket on brackets off the fork, its lens a lamp of the visual.
  const hl: V3 = [0, 0.33, 0.83];
  for (const sx of [1, -1]) fb.rod(...up(0.62, sx * FX), sx * 0.07, hl[1], hl[2] - 0.04, 0.009, dark, 6);
  fb.frustum(hl[0], hl[1], hl[2] - 0.045, 0.078, 0.05, 0.09, red, Math.PI / 2, 0, 0, 16);
  fb.torus(hl[0], hl[1], hl[2], 0.074, 0.009, S.metal(0x7a7266, 0.8), 0, 0, 0, 6, 20);
  headlamp(v, fb, hl[0], hl[1], hl[2], 0.066, false);
  // Bars: up out of the clamp in a tall bend and swept back to the grips; levers, a mirror (the other snapped off), speedo.
  const half: V3[] = [
    [0.12, 0.6, 0.575],
    [0.2, 0.64, 0.57],
    [0.25, 0.73, 0.53],
    [0.3, 0.71, 0.47],
    [0.335, 0.655, 0.435],
    [0.35, 0.645, 0.427],
  ];
  const bar: V3[] = [...half.map(([x, y, z]) => [-x, y, z] as V3).reverse(), [0, 0.595, 0.57], ...half];
  const barS = S.metal(0x5e5650, 0.88);
  fb.pipe(bar, 0.0135, barS, 8);
  const clampTop = up(0.86);
  for (const sx of [1, -1]) {
    fb.rod(sx * 0.05, clampTop[1], clampTop[2], sx * 0.05, 0.6, 0.572, 0.014, barS, 8);
    fb.capsule(sx * 0.35, 0.645, 0.427, sx * 0.46, 0.64, 0.42, 0.019, S.rubber(0x1a1816), 8);
    fb.rbox(sx * 0.335, 0.652, 0.44, 0.03, 0.03, 0.035, 0.008, dark);
    fb.rod(sx * 0.345, 0.655, 0.45, sx * 0.44, 0.632, 0.492, 0.005, S.metal(0x8a8478, 0.7), 5);
    // Cables loop down in front of the head.
    wire(fb, [[sx * 0.33, 0.66, 0.45], [sx * 0.3, 0.6, 0.56], [sx * 0.18, 0.5, 0.66], [sx * 0.07, 0.4, 0.71], [sx * 0.03, 0.29, 0.69]], 0.005, S.rubber(0x161616), 5);
  }
  fb.rod(0.29, 0.7, 0.475, 0.335, 0.865, 0.455, 0.006, barS, 6);
  fb.cyl(0.338, 0.885, 0.452, 0.09, 0.014, 0.065, S.metal(0x6e6860, 0.7), Math.PI / 2 - 0.2, 0, 0, 14);
  fb.rod(-0.29, 0.7, 0.475, -0.3, 0.75, 0.47, 0.006, barS, 6);
  fb.cyl(0, 0.585, 0.635, 0.085, 0.04, 0.085, S.steel(0x1e1c1a, 0.6), -0.7, 0, 0, 14);
  fb.cyl(0, 0.598, 0.646, 0.066, 0.006, 0.066, S.paint(0xd8d0b8, 0.6), -0.7, 0, 0, 14);
  // The front fender on the fork legs, braced to them, with the axle through.
  sb.extrude(
    'trikeFrontFender',
    () => {
      const s = new THREE.Shape();
      s.absarc(0, 0, 0.4, 0.45, Math.PI - 0.6, false);
      s.absarc(0, 0, 0.385, Math.PI - 0.6, 0.45, true);
      s.closePath();
      return s;
    },
    0.13,
    0.008,
    FA[0],
    FA[1],
    FA[2],
    red,
    0,
    -Math.PI / 2,
    0,
  );
  for (const sx of [1, -1]) {
    for (const a of [0.85, Math.PI - 0.85]) sb.rod(...up(0.05, sx * FX), sx * 0.066, FA[1] + 0.392 * Math.sin(a), FA[2] + 0.392 * Math.cos(a), 0.007, dark, 6);
  }
  sb.rod(-0.12, FA[1], FA[2], 0.12, FA[1], FA[2], 0.011, S.steel(0x7a7670, 0.6), 8);

  // Into the steering axis' frame: origin at the front axle, +Y up the axis.
  const axisM = new THREE.Matrix4().compose(new THREE.Vector3(...FA), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -RAKE), new THREE.Vector3(1, 1, 1));
  const axisInv = axisM.clone().invert();
  const frontGeo = fb.build().applyMatrix4(axisInv);
  const slideGeo = sb.build().applyMatrix4(axisInv);
  const steerRoot = new THREE.Group();
  steerRoot.position.set(...FA);
  steerRoot.rotation.x = -RAKE;
  const steer = new THREE.Group();
  const slide = new THREE.Group();
  steerRoot.add(steer);
  steer.add(slide);
  // Plain meshes (any material): they take on the body's own dirt-and-scorch material once Bodywork gives it one.
  const frontMesh: THREE.Mesh = new THREE.Mesh(frontGeo, bodyMat);
  const slideMesh: THREE.Mesh = new THREE.Mesh(slideGeo, bodyMat);
  for (const m of [frontMesh, slideMesh]) {
    m.castShadow = true;
    m.receiveShadow = true;
  }
  steer.add(frontMesh);
  slide.add(slideMesh);
  v.inner.add(steerRoot);
  // The headlight lens turns with the bars.
  const lens = v.headlights[v.headlights.length - 1];
  if (lens) {
    steer.add(lens);
    lens.position.set(...hl).applyMatrix4(axisInv);
    lens.rotation.set(RAKE, 0, 0);
  }

  // ---- wheels: the laced front on the fork (it leans as the fork turns), the small steel pair on the axle.
  const layout = wheelLayout(def.physics);
  const rest = def.physics.suspension.rest;
  let tilt: THREE.Group | null = null;
  for (let i = 0; i < wheelLocal.length; i++) {
    const [x, y, z] = wheelLocal[i];
    const front = i === 0;
    const r = layout[i]?.r ?? def.physics.wheelRadius;
    const pivot = new THREE.Group();
    pivot.position.set(x, y - rest, z);
    const spin = new THREE.Group();
    if (!gone(i)) {
      const m = new THREE.Mesh(trikeWheelGeometry(r, front, look.brakeMk === -1), bodyMat);
      m.castShadow = true;
      if (x < -0.01) m.scale.x = -1;
      spin.add(m);
    }
    if (front) {
      tilt = new THREE.Group();
      tilt.add(spin);
      pivot.add(tilt);
    } else pivot.add(spin);
    v.inner.add(pivot);
    v.wheels.push({ pivot, spin, steered: steered[i] ?? front, radius: r, flatK: 0, bare: gone(i) });
  }

  // ---- rider astride the saddle; the passenger on the cab bench (or the bare back member), built when someone sits.
  const driver = rider(look.paint, look.paint);
  driver.root.position.set(HIP[0], HIP[1] - 0.45, HIP[2]);
  v.inner.add(driver.root);
  v.driver = driver;
  v.lazy = { passenger: () => rider(look.paint, look.paint) };
  const passFloor = hasCab ? CAB_AT[1] + C_FT : GROUND + 0.02;
  const passHip = hasCab ? CAB_AT[1] + BENCH.top + 0.09 : -0.12;
  const passZ = hasCab ? CAB_AT[2] + PASS_Z : -1.5;
  v.gunSeat = [0, hasCab ? passFloor : -0.23, passZ];

  // The grips in the axis frame, nudged from the grip's middle toward the shoulder (the hand lands at the wrist).
  const shoulder = new THREE.Vector3(0.22, HIP[1] + 0.395, HIP[2] + 0.216);
  const grips = [1, -1].map((sx) => {
    const g = new THREE.Vector3(sx * GRIP[0], GRIP[1], GRIP[2]);
    const toS = new THREE.Vector3(sx * shoulder.x, shoulder.y, shoulder.z).sub(g).normalize();
    return g.addScaledVector(toS, 0.045).applyMatrix4(axisInv);
  });
  const poles = [new THREE.Vector3(0.75, -0.55, -0.35).normalize(), new THREE.Vector3(-0.75, -0.55, -0.35).normalize()];
  const frontOn = !gone(0);
  const tanR = Math.tan(RAKE);

  /** Carry the game's steering and suspension over to the fork, and keep its paint the body's (dirt, scorch). */
  const steerFront = () => {
    const w0 = v.wheels[0];
    if (!w0) return;
    const delta = Math.max(-1.2, Math.min(1.2, w0.pivot.rotation.y));
    const sP = Math.atan(Math.tan(delta) / COS_R);
    steer.rotation.y = sP;
    const dy = frontOn ? w0.pivot.position.y - FA[1] : 0;
    slide.position.y = dy / COS_R;
    if (tilt) {
      _qa.setFromAxisAngle(AXIS, sP);
      _qb.setFromAxisAngle(UP_Y, -delta);
      tilt.quaternion.multiplyQuaternions(_qb, _qa);
      tilt.position.set(0, 0, -dy * tanR).applyQuaternion(_qb);
    }
    const mat = v.body.material;
    if (frontMesh.material !== mat) {
      frontMesh.material = mat;
      slideMesh.material = mat;
    }
  };
  /** Hands on the grips wherever the bars have turned. */
  const holdBars = (h: Humanoid) => {
    steerRoot.updateMatrix();
    steer.updateMatrix();
    h.root.updateMatrix();
    h.hips.updateMatrix();
    h.torso.updateMatrix();
    _m.multiplyMatrices(h.root.matrix, h.hips.matrix).multiply(h.torso.matrix).invert();
    for (let s = 0; s < 2; s++) {
      _t.copy(grips[s]).applyMatrix4(steer.matrix).applyMatrix4(steerRoot.matrix).applyMatrix4(_m);
      h.reach(s === 0 ? 'L' : 'R', _t, poles[s]);
    }
  };
  v.seat = (who, h) => {
    if (who === 'driver') {
      steerFront();
      holdBars(h);
      return;
    }
    h.update(0, 'seat', 0, 0, 0);
    sitOn(h, passFloor, passHip, passZ, hasCab ? 0.36 : 0.4);
  };

  v.muzzle.position.set(0, 0.5, 1.0);
  v.inner.add(v.muzzle);
  v.inner.add(v.smoke);
  const out = finish(v, bodyGeo);
  const disposeBody = out.dispose;
  out.dispose = () => {
    disposeBody();
    frontGeo.dispose();
    slideGeo.dispose();
  };
  return out;
}
