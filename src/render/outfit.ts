import * as THREE from 'three';
import { MeshBuilder, S, type Surf } from './builder';
import { PLAYER_COLORS } from './palette';
import { gearDef, hexColor, type WearSlot } from '../data/gear';
import type { Loadout } from '../sim/gear';
import { drawTropicalBody } from './tropicalShirt';
import { drawNuhatBlouse } from './nuhatClothes';

/**
 * How a survivor's worn gear looks. Each slot names a style and up to two colours; the body parts in `humanoid.ts` call the
 * drawing functions below, so one definition fits any palette. Every default reproduces the survivor exactly as the game drew
 * them before there was an inventory, which is what the starter kit wears.
 *
 * Coordinates match `bodyParts`: the head, torso, pelvis, forearm and shin builders each have their origin on a joint.
 */
export type HeadStyle = 'helmet' | 'cap' | 'hardhat' | 'hood' | 'moto' | 'riot' | 'bare';
export type FaceStyle = 'bandana' | 'goggles' | 'respirator' | 'gasmask' | 'none';
export type BodyStyle = 'jacket' | 'vest' | 'duster' | 'plate' | 'riot' | 'shirt';
export type HandStyle = 'work' | 'fingerless' | 'padded' | 'tactical' | 'bare';
export type LegStyle = 'work' | 'cargo' | 'padded' | 'greaves' | 'trousers' | 'bare';
export type FootStyle = 'boots' | 'sneakers' | 'steel' | 'runners' | 'bare';
export type PackStyle = 'ruck' | 'satchel' | 'duffel' | 'frame' | 'none';

/** Every style each slot can draw, for checking the catalogue against. */
export const STYLES: Record<'head' | 'face' | 'body' | 'hands' | 'legs' | 'feet' | 'pack', readonly string[]> = {
  head: ['helmet', 'cap', 'hardhat', 'hood', 'moto', 'riot', 'bare'],
  face: ['bandana', 'goggles', 'respirator', 'gasmask', 'none'],
  body: ['jacket', 'vest', 'duster', 'plate', 'riot', 'shirt'],
  hands: ['work', 'fingerless', 'padded', 'tactical', 'bare'],
  legs: ['work', 'cargo', 'padded', 'greaves', 'trousers', 'bare'],
  feet: ['boots', 'sneakers', 'steel', 'runners', 'bare'],
  pack: ['ruck', 'satchel', 'duffel', 'frame', 'none'],
};

/** A style plus the colours it was asked for. Missing colours fall back to the survivor's own. */
export interface Piece<T extends string> {
  style: T;
  c?: number;
  c2?: number;
}

export interface OutfitLook {
  head: Piece<HeadStyle>;
  face: Piece<FaceStyle>;
  body: Piece<BodyStyle>;
  hands: Piece<HandStyle>;
  legs: Piece<LegStyle>;
  feet: Piece<FootStyle>;
  pack: Piece<PackStyle>;
}

/** The starter kit. */
export const DEFAULT_LOOK: OutfitLook = {
  head: { style: 'helmet' },
  face: { style: 'bandana' },
  body: { style: 'jacket' },
  hands: { style: 'work', c: 0x2b2622 },
  legs: { style: 'work' },
  feet: { style: 'boots', c: 0x2a211b },
  pack: { style: 'ruck', c: 0x4a4636, c2: 0x5d5a40 },
};

/** What a slot looks like with nothing in it. */
const BARE: OutfitLook = {
  head: { style: 'bare' },
  face: { style: 'none' },
  body: { style: 'shirt' },
  hands: { style: 'bare' },
  legs: { style: 'bare' },
  feet: { style: 'bare' },
  pack: { style: 'none' },
};

/** The colours a survivor is built from, before gear changes any of them. */
export interface Identity {
  jacket: number;
  trim: number;
  helmet: number;
  scarf: number;
}

export function identityOf(index: number): Identity {
  return {
    jacket: PLAYER_COLORS[index],
    trim: 0x4a4636,
    helmet: index === 0 ? 0x3b2a1a : 0x1c2a3a,
    scarf: index === 0 ? 0x6a3a1c : 0x223448,
  };
}

/** The look for what a loadout is wearing: starter items keep the identity colours, anything else brings its own. */
export function lookOf(worn: Loadout['worn']): OutfitLook {
  const out = {} as Record<WearSlot, Piece<string>>;
  for (const slot of ['head', 'face', 'body', 'hands', 'legs', 'feet', 'back'] as const) {
    const it = worn[slot];
    const d = it ? gearDef(it.id) : null;
    const key = slot === 'back' ? 'pack' : slot;
    const bare = BARE[key] as Piece<string>;
    if (!d?.look) {
      out[slot] = bare;
      continue;
    }
    const fallback = DEFAULT_LOOK[key] as Piece<string>;
    out[slot] = {
      style: d.look.style,
      c: d.look.tint ? undefined : hexColor(d.look.c, fallback.c ?? 0x555555),
      c2: d.look.c2 ? hexColor(d.look.c2, 0x555555) : undefined,
    };
  }
  return { head: out.head, face: out.face, body: out.body, hands: out.hands, legs: out.legs, feet: out.feet, pack: out.back } as OutfitLook;
}

// ------------------------------------------------------------------------------------------- head

/** Headgear. `goggled` leaves off the goggles a helmet carries on its brow, when a pair is already over the eyes. */
export function drawHead(b: MeshBuilder, p: Piece<HeadStyle>, fallback: number, goggled = false) {
  const c = p.c ?? fallback;
  const c2 = p.c2 ?? 0x1a1a1a;
  const paint = S.paint(c, 0.6);
  switch (p.style) {
    case 'helmet':
      // Helmet with brim, goggles pushed up on it.
      b.add('dome', 0, 0.14, 0, 0.235, 0.19, 0.25, paint);
      b.cyl(0, 0.14, 0, 0.245, 0.02, 0.26, paint, 0, 0, 0, 16);
      b.torus(0, 0.19, 0, 0.115, 0.012, S.leather(0x1c1a18, 0.3), Math.PI / 2 - 0.25, 0, 0, 6, 18);
      for (const sx of goggled ? [] : [1, -1]) {
        b.cyl(sx * 0.045, 0.21, 0.105, 0.065, 0.035, 0.065, S.metal(0x2a2a2a, 0.4), Math.PI / 2 - 0.4, 0, 0, 12);
        b.cyl(sx * 0.045, 0.218, 0.122, 0.052, 0.008, 0.052, S.glass(0x2a4a58), Math.PI / 2 - 0.4, 0, 0, 12);
      }
      break;
    case 'cap':
      b.add('dome', 0, 0.145, 0, 0.225, 0.13, 0.24, S.cloth(c, 0.6));
      b.box(0, 0.152, 0.13, 0.19, 0.014, 0.1, S.cloth(c, 0.55), 0.14, 0, 0);
      b.torus(0, 0.152, 0, 0.108, 0.01, S.cloth(c2, 0.5), Math.PI / 2, 0, 0, 5, 16);
      break;
    case 'hardhat':
      b.add('dome', 0, 0.14, 0, 0.245, 0.19, 0.265, paint);
      b.cyl(0, 0.14, 0, 0.27, 0.018, 0.29, paint, 0, 0, 0, 16);
      b.box(0, 0.25, 0, 0.032, 0.024, 0.2, paint);
      b.cyl(0, 0.19, 0.125, 0.05, 0.035, 0.05, S.plastic(0xe9e2c8, 0.2), Math.PI / 2 - 0.2, 0, 0, 10);
      break;
    case 'moto': {
      b.add('sphere16', 0, 0.1, -0.005, 0.27, 0.3, 0.29, S.gloss(c, 0.35));
      // Dark visor across the eyes, chin bar below, a stripe over the crown.
      b.rbox(0, 0.115, 0.112, 0.2, 0.085, 0.05, 0.03, S.glass(0x161e26), -0.1, 0, 0);
      b.add('sphere', 0, -0.02, 0.09, 0.17, 0.09, 0.1, S.gloss(c, 0.35));
      b.box(0, 0.23, 0, 0.03, 0.01, 0.2, S.paint(c2 === 0x1a1a1a ? 0xb0a070 : c2, 0.4));
      break;
    }
    case 'riot': {
      b.add('dome', 0, 0.14, 0, 0.25, 0.2, 0.27, S.plastic(c, 0.4));
      b.rbox(0, 0.075, 0.128, 0.205, 0.2, 0.026, 0.012, S.glass(0x2c3c46), -0.06, 0, 0);
      b.rbox(0, -0.005, -0.11, 0.22, 0.11, 0.05, 0.02, S.plastic(c, 0.4));
      for (const sx of [1, -1]) b.rbox(sx * 0.115, 0.07, 0.0, 0.03, 0.17, 0.17, 0.012, S.plastic(c, 0.4));
      break;
    }
    case 'hood': {
      const wool = S.cloth(c, 0.7);
      b.add('dome', 0, 0.115, -0.02, 0.255, 0.2, 0.28, wool);
      // A rim around the face, and the cowl falling down the back of the neck.
      b.torus(0, 0.1, 0.085, 0.1, 0.03, wool, 0, 0, 0, 8, 18);
      b.add('cone6', 0, 0.0, -0.1, 0.25, 0.2, 0.12, wool, 0.35, 0, 0);
      break;
    }
    case 'bare':
      b.add('dome', 0, 0.15, -0.005, 0.205, 0.13, 0.225, S.cloth(0x2a2118, 0.7));
      break;
  }
}

/** What goes over the face, and the neck wrap that goes with it. */
export function drawFace(b: MeshBuilder, p: Piece<FaceStyle>, fallback: number) {
  const c = p.c ?? fallback;
  switch (p.style) {
    case 'bandana': {
      // A bandana pulled up over the mouth.
      const scarf = S.cloth(c, 0.45);
      b.add('sphere16', 0, 0.035, 0.035, 0.198, 0.1, 0.195, scarf);
      b.add('cone6', 0, -0.02, 0.07, 0.11, 0.07, 0.05, scarf, Math.PI, 0, 0);
      break;
    }
    case 'goggles': {
      const frame = S.rubber(c);
      b.torus(0, 0.115, 0.0, 0.108, 0.012, frame, Math.PI / 2, 0, 0, 6, 18);
      for (const sx of [1, -1]) {
        b.cyl(sx * 0.045, 0.115, 0.1, 0.068, 0.03, 0.068, S.metal(0x2a2a2a, 0.4), Math.PI / 2, 0, 0, 12);
        b.cyl(sx * 0.045, 0.115, 0.118, 0.054, 0.008, 0.054, S.glass(p.c2 ?? 0xd8b04a), Math.PI / 2, 0, 0, 12);
      }
      break;
    }
    case 'respirator': {
      b.rbox(0, 0.055, 0.105, 0.13, 0.115, 0.06, 0.03, S.rubber(c));
      for (const sx of [1, -1]) b.cyl(sx * 0.062, 0.04, 0.125, 0.05, 0.065, 0.05, S.metal(p.c2 ?? 0x8a8e92, 0.4), Math.PI / 2, 0, 0, 10);
      b.torus(0, 0.04, 0.0, 0.106, 0.008, S.rubber(0x1a1a1a), Math.PI / 2, 0, 0, 5, 18);
      break;
    }
    case 'gasmask': {
      b.add('sphere16', 0, 0.07, 0.035, 0.205, 0.2, 0.2, S.rubber(c));
      for (const sx of [1, -1]) {
        b.cyl(sx * 0.052, 0.115, 0.108, 0.072, 0.03, 0.072, S.metal(0x2a2a2a, 0.4), Math.PI / 2, 0, 0, 12);
        b.cyl(sx * 0.052, 0.115, 0.125, 0.06, 0.008, 0.06, S.glass(0x1c2c28), Math.PI / 2, 0, 0, 12);
      }
      b.cyl(0, 0.0, 0.145, 0.075, 0.09, 0.075, S.metal(0x6a6e66, 0.4), Math.PI / 2, 0, 0, 12);
      break;
    }
    case 'none':
      break;
  }
}

/**
 * The neck: a scarf and its tail for a bandana, a hose for a gas mask, nothing for the rest. A `lowered` bandana has been
 * pulled down off the face and hangs in a point over the collar.
 */
export function drawNeck(b: MeshBuilder, p: Piece<FaceStyle>, fallback: number, lowered = false) {
  const c = p.c ?? fallback;
  if (p.style === 'bandana') {
    const scarf = S.cloth(c, 0.45);
    b.torus(0, 0.52, 0.01, 0.075, 0.035, scarf, Math.PI / 2, 0, 0, 8, 16);
    b.box(0.05, 0.43, -0.09, 0.07, 0.16, 0.02, scarf, 0.2, 0, 0.1);
    if (lowered) b.add('cone6', 0, 0.46, 0.08, 0.15, 0.11, 0.04, scarf, Math.PI - 0.32, 0, 0);
  } else if (p.style === 'gasmask') {
    b.pipe(
      [
        [0, 0.55, 0.09],
        [0.07, 0.48, 0.15],
        [0.1, 0.4, 0.1],
      ],
      0.012,
      S.rubber(0x1a1a1a),
      6,
    );
    b.cyl(0.1, 0.38, 0.09, 0.05, 0.07, 0.05, S.metal(0x6a6e66, 0.4), 0, 0, 0, 8);
  }
}

// ------------------------------------------------------------------------------------------- body

/** Sleeve colour for a body style, so the arms match the torso. `own` is what a hero wears under the kit. */
export function sleeveColor(p: Piece<BodyStyle>, fallback: number, own?: number): number {
  switch (p.style) {
    case 'jacket':
      return p.c ?? fallback;
    case 'vest':
    case 'plate':
      return p.c2 ?? 0x4a4636;
    case 'shirt':
      return own ?? 0x6a6a60;
    default:
      return p.c ?? fallback;
  }
}

/**
 * A hero's own clothes, worn when nothing covers the body: a T-shirt, and a knit cardigan over it when they have one. The
 * T-shirt can carry a dark print down its front, and a cord can hang round the neck.
 */
export interface OwnClothes {
  shirt: number;
  blouse?: boolean;
  over?: number;
  print?: number;
  cord?: number;
  /** A quilted down jacket, worn open over the T-shirt. */
  puffer?: number;
  hoodie?: number;
  /** The hoodie's drawstrings: this colour (orange when not given), or none with null. */
  drawstrings?: number | null;
  rolledSleeves?: boolean;
  tropical?: number;
  skin?: number;
}

/** True when the arms come out of short sleeves: a hero in just a T-shirt. */
export function shortSleeves(p: Piece<BodyStyle>, own?: OwnClothes): boolean {
  return p.style === 'shirt' && !!own && !own.blouse && own.over === undefined && own.puffer === undefined && own.hoodie === undefined && own.tropical === undefined;
}

/** True when the sleeves are a down jacket's: fat, and stitched into rolls. */
export function quiltedSleeves(p: Piece<BodyStyle>, own?: OwnClothes): boolean {
  return p.style === 'shirt' && own?.puffer !== undefined;
}

type P3 = [number, number, number];

/** The vertex attributes of a surface, as `MeshBuilder` writes them (no colour jitter: these are the clean hero garments). */
function surfOf(s: Surf) {
  const col = new THREE.Color(s.c);
  return { col, r: s.r ?? 0.82, m: s.m ?? 0, w: s.w ?? 0.5, e: s.e ?? 0 };
}

/**
 * A smooth sheet: `f(u, v)` over `nu` by `nv` cells (u and v run 0 to 1), with normals taken from the surface itself so it
 * shades round instead of faceted. The outside is the side `df/du x df/dv` points to; `wrap` joins u = 1 back onto u = 0.
 */
function sheet(b: MeshBuilder, nu: number, nv: number, f: (u: number, v: number) => P3, surf: Surf, wrap = false) {
  const s = surfOf(surf);
  const base = b.pos.length / 3;
  const cols = wrap ? nu : nu + 1;
  const e = 1e-3;
  for (let j = 0; j <= nv; j++) {
    const v = j / nv;
    for (let i = 0; i < cols; i++) {
      const u = i / nu;
      const p = f(u, v);
      const a = f(u + e, v);
      const c = f(u - e, v);
      const d = f(u, Math.min(1, v + e));
      const g = f(u, Math.max(0, v - e));
      const ux = a[0] - c[0], uy = a[1] - c[1], uz = a[2] - c[2];
      const vx = d[0] - g[0], vy = d[1] - g[1], vz = d[2] - g[2];
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      b.pos.push(p[0], p[1], p[2]);
      b.nor.push(nx, ny, nz);
      b.col.push(s.col.r, s.col.g, s.col.b);
      b.srf.push(s.r, s.m, s.w, s.e);
      b.uv.push(u, v);
    }
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const i1 = wrap ? (i + 1) % nu : i + 1;
      const q0 = base + j * cols + i;
      const q1 = base + j * cols + i1;
      const q2 = base + (j + 1) * cols + i1;
      const q3 = base + (j + 1) * cols + i;
      b.idx.push(q0, q1, q2, q0, q2, q3);
    }
  }
}

/**
 * A round tube through `pts`, `r[i]` thick at each, its rings turned along the mean of the two segments at a joint so a
 * bend stays smooth. The far end gets a rounded cap (a fingertip); the near end is left open, buried in whatever it grows out of.
 */
function tube(b: MeshBuilder, pts: P3[], r: number[], surf: Surf, radial = 6, cap = true) {
  const s = surfOf(surf);
  const n = pts.length;
  const T = new THREE.Vector3();
  const N = new THREE.Vector3();
  const B = new THREE.Vector3();
  const D = new THREE.Vector3();
  const tan = (i: number) => {
    const a = pts[Math.max(0, i - 1)];
    const c = pts[Math.min(n - 1, i + 1)];
    return new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]).normalize();
  };
  // A reference normal off the first tangent, carried along (parallel transport) so the rings do not twist.
  T.copy(tan(0));
  N.set(Math.abs(T.y) < 0.9 ? 0 : 1, Math.abs(T.y) < 0.9 ? 1 : 0, 0);
  N.addScaledVector(T, -N.dot(T)).normalize();
  const base = b.pos.length / 3;
  const ring = (p: THREE.Vector3, rad: number, nrmTilt: number) => {
    B.crossVectors(T, N);
    for (let k = 0; k < radial; k++) {
      const th = (k / radial) * Math.PI * 2;
      D.copy(N).multiplyScalar(Math.cos(th)).addScaledVector(B, Math.sin(th));
      b.pos.push(p.x + D.x * rad, p.y + D.y * rad, p.z + D.z * rad);
      const nn = D.clone().multiplyScalar(Math.cos(nrmTilt)).addScaledVector(T, Math.sin(nrmTilt));
      b.nor.push(nn.x, nn.y, nn.z);
      b.col.push(s.col.r, s.col.g, s.col.b);
      b.srf.push(s.r, s.m, s.w, s.e);
      b.uv.push(k / radial, 0);
    }
  };
  const P = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const t = tan(i);
    N.addScaledVector(t, -N.dot(t)).normalize();
    T.copy(t);
    ring(P.set(pts[i][0], pts[i][1], pts[i][2]), r[i], 0);
  }
  let rings = n;
  if (cap) {
    // A ring round the end and a point on it: a soft tip, not a cut.
    const end = P.set(pts[n - 1][0], pts[n - 1][1], pts[n - 1][2]).clone();
    const re = r[n - 1];
    ring(end.clone().addScaledVector(T, re * Math.sin(0.95)), re * Math.cos(0.95), 0.95);
    rings += 1;
    const tip = b.pos.length / 3;
    b.pos.push(end.x + T.x * re, end.y + T.y * re, end.z + T.z * re);
    b.nor.push(T.x, T.y, T.z);
    b.col.push(s.col.r, s.col.g, s.col.b);
    b.srf.push(s.r, s.m, s.w, s.e);
    b.uv.push(0.5, 1);
    const last = base + (rings - 1) * radial;
    for (let k = 0; k < radial; k++) b.idx.push(last + k, last + ((k + 1) % radial), tip);
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let k = 0; k < radial; k++) {
      const k1 = (k + 1) % radial;
      const a = base + i * radial + k;
      const c = base + i * radial + k1;
      const d = base + (i + 1) * radial + k1;
      const e = base + (i + 1) * radial + k;
      b.idx.push(a, c, d, a, d, e);
    }
  }
}

/**
 * The shape of a hero's own top, hem to neck: height, half width, half depth in front and behind, and how square the
 * section is (2 an ellipse, more a rounded box). A soft chest, a waist, and shoulders that slope off the neck into the arm.
 */
const TEE: readonly (readonly [number, number, number, number, number])[] = [
  [-0.045, 0.199, 0.137, 0.133, 2.4],
  [0.04, 0.18, 0.132, 0.123, 2.35],
  [0.14, 0.168, 0.133, 0.119, 2.3],
  [0.24, 0.178, 0.137, 0.119, 2.35],
  [0.32, 0.19, 0.138, 0.12, 2.45],
  [0.39, 0.198, 0.132, 0.121, 2.5],
  [0.43, 0.2, 0.123, 0.118, 2.5],
  [0.46, 0.199, 0.112, 0.11, 2.5],
  [0.482, 0.186, 0.098, 0.1, 2.45],
  [0.5, 0.148, 0.083, 0.087, 2.3],
  [0.516, 0.1, 0.069, 0.072, 2.15],
  [0.53, 0.062, 0.058, 0.06, 2.0],
];

type Loft = readonly (readonly [number, number, number, number, number])[];

/** The section of a lofted shape at height `y` (smoothly through its table; the table runs bottom to top). */
function loftRing(T: Loft, y: number) {
  const n = T.length;
  let k = 0;
  while (k < n - 2 && y > T[k + 1][0]) k++;
  const t = Math.max(0, Math.min(1, (y - T[k][0]) / (T[k + 1][0] - T[k][0])));
  const col = (c: number) => {
    const p0 = T[Math.max(0, k - 1)][c];
    const p1 = T[k][c];
    const p2 = T[k + 1][c];
    const p3 = T[Math.min(n - 1, k + 2)][c];
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  };
  return { rx: col(1), rzf: col(2), rzb: col(3), p: col(4) };
}

/** The height at `v` (0 bottom, 1 top), spaced as the table is, so the curved parts get the most rows. */
function loftY(T: Loft, v: number) {
  const f = Math.max(0, Math.min(1, v)) * (T.length - 1);
  const k = Math.min(T.length - 2, Math.floor(f));
  return T[k][0] + (T[k + 1][0] - T[k][0]) * (f - k);
}

/** A point on a lofted shape at angle `a` round it (0 the front, toward +x at a quarter turn) and height `y`, `lift` proud of it. */
function loftAt(T: Loft, a: number, y: number, lift = 0): P3 {
  const r = loftRing(T, y);
  const s = Math.sin(a);
  const c = Math.cos(a);
  const e = 2 / r.p;
  return [(r.rx + lift) * Math.sign(s) * Math.abs(s) ** e, y, ((c >= 0 ? r.rzf : r.rzb) + lift) * Math.sign(c) * Math.abs(c) ** e];
}

const teeRing = (y: number) => loftRing(TEE, y);
const teeY = (v: number) => loftY(TEE, v);
/** A point on the top at angle `a` round the body (0 the front, toward +x at a quarter turn) and height `y`, `lift` proud of it. */
const teeAt = (a: number, y: number, lift = 0) => loftAt(TEE, a, y, lift);

/** The point on the front of the top straight ahead of (x, y). */
function teeFront(x: number, y: number, lift = 0): P3 {
  const r = teeRing(y);
  const s = Math.min(1, (Math.abs(x) / r.rx) ** (r.p / 2));
  return teeAt(Math.sign(x) * Math.asin(s), y, lift);
}

/** The outward normal of the front at (x, y). */
function teeNormal(x: number, y: number): THREE.Vector3 {
  const e = 0.002;
  const a = teeFront(x + e, y), c = teeFront(x - e, y), d = teeFront(x, y + e), g = teeFront(x, y - e);
  const u = new THREE.Vector3(a[0] - c[0], a[1] - c[1], a[2] - c[2]);
  const v = new THREE.Vector3(d[0] - g[0], d[1] - g[1], d[2] - g[2]);
  return u.cross(v).normalize();
}

/** A patch laid on the front of the top: x from `x0(v)` to `x1(v)` as y runs y0 to y1, `lift(u, v)` proud of it. */
function teePatch(b: MeshBuilder, x0: (v: number) => number, x1: (v: number) => number, y0: number, y1: number, lift: number | ((u: number, v: number) => number), surf: Surf, nu = 8, nv = 6) {
  const lf = typeof lift === 'number' ? () => lift : lift;
  sheet(b, nu, nv, (u, v) => {
    const vc = Math.max(0, Math.min(1, v));
    return teeFront(x0(vc) + (x1(vc) - x0(vc)) * u, y0 + (y1 - y0) * v, lf(u, vc));
  }, surf);
}

/** A band right round the top between two heights, `lift` proud of it (a hem, a ribbed waistband). */
function teeBand(b: MeshBuilder, y0: number, y1: number, lift: number, surf: Surf, rows = 1) {
  sheet(b, 28, rows, (u, v) => teeAt(u * Math.PI * 2, y0 + (y1 - y0) * v, lift), surf, true);
}

/**
 * A hero's own top as one smooth shell (a T-shirt, a hoodie, a cardigan): `lift` makes it looser. The hem turns in under
 * itself, and the neck is closed with a ring of skin inside the collar so nothing shows through.
 */
function drawTee(b: MeshBuilder, col: number, skin: number, lift = 0) {
  const cloth = S.cloth(col, 0.3);
  sheet(b, 28, 22, (u, v) => teeAt(u * Math.PI * 2, teeY(v), lift), cloth, true);
  // The turned-in hem, seen from below, and the neck closed inside the collar.
  const y0 = TEE[0][0];
  sheet(b, 28, 1, (u, v) => teeAt(u * Math.PI * 2, y0 + 0.012 * (1 - v), lift - 0.012 * (1 - v)), cloth, true);
  const top = TEE[TEE.length - 1][0];
  sheet(b, 28, 1, (u, v) => {
    const [x, , z] = teeAt(u * Math.PI * 2, top, lift);
    const k = 1 - v * 0.5;
    return [x * k, top + 0.004 * v, z * k];
  }, S.skin(skin), true);
  return cloth;
}

/** A colour darker (k < 1) or lighter (k > 1). */
const shade = (col: number, k: number) => new THREE.Color(col).multiplyScalar(k).getHex();

/**
 * A pullover hoodie, hood down: a looser top with a ribbed waistband, a kangaroo pocket lying flat over the belly with an
 * opening down each slanted side, the hood in a soft roll round the back of the neck (its edges meeting low on the chest)
 * and the rest of it folded on the upper back, and the drawstrings (this colour, orange when not given, none with null).
 */
function drawHoodie(b: MeshBuilder, col: number, skin: number, strings?: number | null) {
  const L = 0.008;
  const cloth = drawTee(b, col, skin, L);
  const rib = S.cloth(shade(col, 0.82), 0.3);
  teeBand(b, -0.047, -0.006, L + 0.003, rib);
  // The pocket: sewn along its top and into the waistband, open down the slanted sides; a little fuller in the middle.
  const xl = (v: number) => -0.125 + 0.04 * v;
  const xr = (v: number) => 0.125 - 0.04 * v;
  const [y0, y1] = [-0.004, 0.19];
  const lift = (u: number, v: number) => L + 0.004 + 0.004 * Math.sin(Math.PI * u) * Math.sin(Math.PI * Math.min(1, v * 1.15 + 0.05));
  teePatch(b, xl, xr, y0, y1, lift, S.cloth(shade(col, 0.97), 0.3), 10, 6);
  teePatch(b, () => -0.085, () => 0.085, y1 - 0.007, y1, L + 0.0048, rib, 8, 1);
  for (const sx of [-1, 1]) {
    // The opening: a hemmed edge on the pocket and a line of shadow just outside it.
    const edge = sx < 0 ? xl : xr;
    teePatch(b, (v) => edge(v) - (sx < 0 ? 0 : 0.007), (v) => edge(v) + (sx < 0 ? 0.007 : 0), y0 + 0.035, y1 - 0.004, L + 0.0047, rib, 1, 6);
    teePatch(b, (v) => edge(v) - (sx < 0 ? 0.005 : -0.0005), (v) => edge(v) + (sx < 0 ? -0.0005 : 0.005), y0 + 0.035, y1 - 0.004, L + 0.0012, S.cloth(shade(col, 0.42), 0.3), 1, 6);
  }
  // The hood's roll round the neck, fattest behind.
  const roll: P3[] = [];
  const rr: number[] = [];
  for (let i = 0; i <= 18; i++) {
    const th = 0.5 + (i / 18) * (Math.PI * 2 - 1.0);
    const w = (1 - Math.cos(th)) / 2;
    const c = Math.cos(th);
    roll.push([Math.sin(th) * (0.086 + 0.006 * w), 0.48 + 0.056 * Math.sin(Math.min(1, 2 * w) * (Math.PI / 2)), c * (c > 0 ? 0.114 : 0.088)]);
    rr.push(0.013 + 0.019 * w);
  }
  tube(b, roll, rr, cloth, 8, false);
  for (const sx of [-1, 1]) b.sphereAt(roll[sx < 0 ? 18 : 0][0], roll[sx < 0 ? 18 : 0][1], roll[sx < 0 ? 18 : 0][2], 0.013, cloth, false);
  // The rest of the hood, folded flat on the upper back, its point hanging down the middle.
  sheet(b, 10, 6, (u, v) => {
    const half = 0.62 * (0.45 + 0.55 * v);
    const a = Math.PI - half + 2 * half * u;
    const yb = 0.36 + 0.08 * Math.abs(2 * u - 1) ** 1.5;
    const y = yb + (0.52 - yb) * v;
    const s = Math.sin(Math.PI * Math.max(0, Math.min(1, u)));
    return teeAt(a, y, L + 0.003 + 0.018 * s ** 0.7 * (0.35 + 0.65 * v));
  }, cloth);
  if (strings !== null) {
    const cord = S.cloth(strings ?? 0xe48a32, 0.2);
    for (const sx of [-1, 1]) {
      const pts = [teeFront(sx * 0.03, 0.478, L + 0.009), teeFront(sx * 0.036, 0.42, L + 0.004), teeFront(sx * 0.041, 0.35, L + 0.004), teeFront(sx * 0.044, 0.3, L + 0.004)];
      tube(b, pts, [0.0035, 0.0035, 0.0035, 0.0035], cord, 5);
      const e = pts[3];
      b.rod(e[0], e[1] + 0.004, e[2], e[0], e[1] - 0.012, e[2], 0.0042, S.cloth(shade(strings ?? 0xe48a32, 0.7), 0.2), 6);
    }
  }
}

/**
 * A chunky knit cardigan, zipped, its ribs running down the front, a ribbed collar round the back of the neck and down the
 * edges of the V; the T-shirt shows in the V.
 */
function drawCardigan(b: MeshBuilder, col: number, shirt: number, skin: number) {
  const L = 0.006;
  drawTee(b, col, skin, L);
  const band = S.cloth(shade(col, 0.82), 0.35);
  const rib = S.cloth(shade(col, 1.35), 0.35);
  teeBand(b, -0.047, -0.008, L + 0.002, band);
  for (const sx of [-1, 1]) for (const [x, top] of [[0.045, 0.37], [0.1, 0.45], [0.15, 0.44]]) {
    teePatch(b, () => sx * x - 0.005, () => sx * x + 0.005, -0.004, top, L + 0.0012, rib, 1, 8);
  }
  const V = 0.38;
  teePatch(b, (v) => -0.058 * v, (v) => 0.058 * v, V, 0.527, L + 0.0022, S.cloth(shirt, 0.3), 4, 6);
  for (const sx of [-1, 1]) teePatch(b, (v) => sx * 0.058 * v - (sx < 0 ? 0.012 : -0.001), (v) => sx * 0.058 * v + (sx < 0 ? -0.001 : 0.012), V, 0.527, L + 0.003, band, 1, 6);
  // The collar behind the neck, between the tops of the V.
  const collar: P3[] = [];
  for (let i = 0; i <= 14; i++) {
    const th = 0.75 + (i / 14) * (Math.PI * 2 - 1.5);
    collar.push(teeAt(th, 0.523, L + 0.006));
  }
  tube(b, collar, collar.map(() => 0.012), band, 6, false);
  for (const e of [collar[0], collar[14]]) b.sphereAt(e[0], e[1], e[2], 0.012, band, false);
  teePatch(b, () => -0.0035, () => 0.0035, -0.045, V + 0.004, L + 0.0035, S.metal(0x2a2a2a, 0.3), 1, 10);
}

/** Torso covering: the garment itself, without the neck, the pack or the arms. */
export function drawBody(b: MeshBuilder, p: Piece<BodyStyle>, fallback: number, trim: number, own?: OwnClothes) {
  const c = p.c ?? fallback;
  const leather = S.leather(0x3b2a1e, 0.5);
  const buckle = S.metal(0x8a8478, 0.4);
  const body = (col: number, mat: (c: number, w?: number) => Surf = S.cloth) => {
    const m = mat(col, 0.55);
    // Abdomen and chest: a tapered body, the shoulders sloping off it into the arms.
    b.limb(0, 0.06, 0, 0, 0.26, 0, 0.14, 0.16, m, 14);
    b.rbox(0, 0.34, 0, 0.4, 0.3, 0.24, 0.1, m);
    for (const sx of [1, -1]) b.add('sphere16', sx * 0.19, 0.437, 0, 0.16, 0.115, 0.2, m, 0, 0, -sx * 0.4);
    b.torus(0, 0.5, 0, 0.085, 0.03, mat(new THREE.Color(col).multiplyScalar(0.62).getHex(), 0.6), Math.PI / 2, 0, 0, 8, 16);
    return m;
  };
  switch (p.style) {
    case 'jacket': {
      body(c);
      b.box(0, 0.3, 0.121, 0.012, 0.36, 0.008, buckle);
      // Chest rig with magazine pouches and shoulder straps.
      const rig = S.cloth(trim, 0.5);
      b.rbox(0, 0.3, 0.115, 0.34, 0.22, 0.05, 0.015, rig);
      for (const sx of [-1, 0, 1]) b.rbox(sx * 0.1, 0.27, 0.15, 0.085, 0.12, 0.04, 0.012, S.cloth(new THREE.Color(trim).multiplyScalar(0.8).getHex(), 0.6));
      for (const sx of [1, -1]) b.box(sx * 0.12, 0.38, 0.0, 0.05, 0.02, 0.27, leather);
      break;
    }
    case 'shirt':
      if (own?.blouse) {
        drawNuhatBlouse(b, own.skin ?? 0xa46e50, own.shirt);
      } else if (own?.tropical !== undefined) {
        drawTropicalBody(b, own.skin ?? 0xc89c7c, own.tropical);
      } else if (own?.hoodie !== undefined) {
        drawHoodie(b, own.hoodie, own.skin ?? 0xc8a07c, own.drawstrings);
      } else if (own?.puffer !== undefined) {
        drawPuffer(b, own.puffer, own.shirt, own.skin);
      } else if (own?.over !== undefined) {
        drawCardigan(b, own.over, own.shirt, own.skin ?? 0xc8a07c);
      } else {
        // A plain T-shirt: a ribbed crew neck and the stitched line of the hem.
        const col = own?.shirt ?? 0x6a6a60;
        drawTee(b, col, own?.skin ?? 0xc8a07c);
        b.torus(0, 0.527, 0.0, 0.061, 0.0095, S.cloth(shade(col, 0.84), 0.3), Math.PI / 2, 0, 0, 6, 22);
        teeBand(b, -0.031, -0.027, 0.0012, S.cloth(shade(col, 0.8), 0.3));
      }
      if (own?.print !== undefined && own.over === undefined) drawPrint(b, own.print);
      if (own?.cord !== undefined) {
        // A dark cord round the neck: behind, round its base; in front, falling from the sides of the neck in a U on the chest.
        const pts: P3[] = [];
        for (let i = 0; i <= 10; i++) pts.push(teeAt(Math.PI / 2 + (i / 10) * Math.PI, 0.524, 0.006));
        for (let i = 1; i <= 16; i++) {
          const t = -1 + (i / 16) * 2;
          const r = teeRing(0.524).rx;
          pts.push(teeFront(r * Math.sin((t * Math.PI) / 2), 0.524 - 0.074 * Math.cos((t * Math.PI) / 2) ** 1.5, 0.006));
        }
        tube(b, pts, pts.map(() => 0.0042), S.leather(own.cord, 0.3), 5, false);
      }
      break;
    case 'vest': {
      body(p.c2 ?? 0x4a4636);
      const quilt = S.cloth(c, 0.6);
      b.rbox(0, 0.33, 0.0, 0.43, 0.27, 0.26, 0.08, quilt);
      for (let i = 0; i < 4; i++) b.box(0, 0.23 + i * 0.07, 0.132, 0.4, 0.008, 0.008, S.cloth(new THREE.Color(c).multiplyScalar(0.6).getHex(), 0.7));
      for (const sx of [1, -1]) b.rbox(sx * 0.12, 0.2, 0.14, 0.1, 0.09, 0.04, 0.015, S.cloth(new THREE.Color(c).multiplyScalar(0.8).getHex(), 0.6));
      b.box(0, 0.32, 0.134, 0.012, 0.3, 0.008, buckle);
      break;
    }
    case 'duster': {
      body(c, S.leather);
      const coat = S.leather(c, 0.6);
      // Popped collar, a belt, and the long front flaps that hang over the hips.
      for (const sx of [1, -1]) b.add('cone6', sx * 0.06, 0.55, -0.02, 0.07, 0.1, 0.05, coat, 0.2, 0, -sx * 0.2);
      b.box(0, 0.12, 0.0, 0.34, 0.045, 0.23, S.leather(p.c2 ?? 0x2b1f16, 0.5));
      b.box(0, 0.12, 0.118, 0.05, 0.04, 0.01, buckle);
      for (const sx of [1, -1]) b.rbox(sx * 0.1, 0.02, 0.1, 0.16, 0.32, 0.03, 0.012, coat, -0.04, 0, sx * 0.05);
      b.box(0, 0.34, 0.123, 0.02, 0.34, 0.008, S.leather(p.c2 ?? 0x2b1f16, 0.5));
      break;
    }
    case 'plate': {
      body(p.c2 ?? 0x2a2d26);
      const shell = S.paint(c, 0.6);
      b.rbox(0, 0.36, 0.14, 0.3, 0.3, 0.07, 0.035, shell);
      b.rbox(0, 0.35, -0.14, 0.3, 0.3, 0.07, 0.035, shell);
      b.rbox(0, 0.17, 0.0, 0.37, 0.12, 0.26, 0.04, S.cloth(c, 0.6));
      for (const sx of [-1, 0, 1]) b.rbox(sx * 0.09, 0.15, 0.15, 0.075, 0.1, 0.04, 0.012, S.cloth(p.c2 ?? 0x2a2d26, 0.6));
      for (const sx of [1, -1]) {
        b.box(sx * 0.12, 0.45, 0.0, 0.07, 0.03, 0.3, S.cloth(c, 0.6));
        b.rbox(sx * 0.21, 0.46, 0.0, 0.07, 0.07, 0.15, 0.025, shell);
      }
      break;
    }
    case 'riot': {
      body(p.c2 ?? 0x14171a);
      const shell = S.plastic(c, 0.4);
      b.rbox(0, 0.37, 0.0, 0.45, 0.34, 0.3, 0.09, shell);
      for (let i = 0; i < 3; i++) b.rbox(0, 0.2 - i * 0.06 + 0.05, 0.0, 0.37 - i * 0.03, 0.06, 0.26, 0.02, shell);
      for (const sx of [1, -1]) {
        b.add('dome', sx * 0.235, 0.46, 0, 0.19, 0.12, 0.2, shell, 0, 0, -sx * 0.5);
        b.rbox(sx * 0.2, 0.5, 0.0, 0.1, 0.05, 0.2, 0.02, shell);
      }
      b.rbox(0, 0.52, 0.01, 0.2, 0.08, 0.2, 0.03, shell);
      break;
    }
  }
}

/** Extra plates on the pelvis for the heavy body styles, a skirt for the long coat. */
export function drawHips(b: MeshBuilder, body: Piece<BodyStyle>, fallback: number) {
  const c = body.c ?? fallback;
  if (body.style === 'duster') {
    for (const sx of [1, -1]) b.rbox(sx * 0.1, -0.2, 0.0, 0.17, 0.4, 0.24, 0.05, S.leather(c, 0.6), 0, 0, sx * 0.07);
  } else if (body.style === 'riot') {
    const shell = S.plastic(c, 0.4);
    for (const sx of [1, -1]) b.rbox(sx * 0.19, -0.04, 0.0, 0.05, 0.16, 0.2, 0.02, shell);
    b.rbox(0, -0.06, 0.12, 0.2, 0.18, 0.03, 0.015, shell);
  }
}

/**
 * A down jacket worn open: a smooth, full shell stitched into bands all the way round (the stitching is what reads as
 * quilting at a distance), a rolled collar round the back and sides of the neck, the T-shirt showing down the open front
 * between the zip tapes, and a zipped pocket on each side low on the front.
 */
function drawPuffer(b: MeshBuilder, col: number, shirt: number, skin = 0xc8a07c) {
  // Nylon: a little sheen along the tops of the puffs.
  const shell = { ...S.cloth(col, 0.3), r: 0.6 };
  const seam = S.cloth(shade(col, 0.45), 0.3);
  const tape = S.cloth(shade(col, 0.62), 0.3);
  const tee = S.cloth(shirt, 0.3);
  // The shell stands this far off the T-shirt's shape, drawn in at every stitched line and puffed out between them.
  const L = 0.022;
  const puff = (y: number) => L - 0.008 * (1 - Math.abs(Math.sin((Math.PI * (y - 0.03)) / 0.07))) ** 2;
  // Half the width of the open front.
  const OPEN = 0.088;
  const edgeA = (y: number, lift: number) => {
    const r = teeRing(y);
    return Math.asin(Math.min(1, (OPEN / (r.rx + lift)) ** (r.p / 2)));
  };
  const [Y0, Y1] = [-0.06, 0.525];
  // The shell, round the back and sides from one front edge to the other.
  const round = (y0: number, y1: number, extra: number, surf: Surf, rows: number) =>
    sheet(b, 26, rows, (u, v) => {
      const y = y0 + (y1 - y0) * v;
      const l = puff(y) + extra;
      const a0 = edgeA(y, l);
      return teeAt(a0 + u * (Math.PI * 2 - 2 * a0), y, l);
    }, surf);
  round(Y0, Y1, 0, shell, 50);
  // The stitched lines.
  for (let y = 0.03; y < 0.47; y += 0.07) round(y - 0.002, y + 0.002, 0.0007, seam, 1);
  // The front edges: the zip tapes, turning in from the shell to the T-shirt.
  for (const sx of [-1, 1]) {
    sheet(b, 2, 24, (u, v) => {
      const y = Y0 + 0.004 + (Y1 - 0.01 - Y0) * v;
      const l = puff(y);
      const k = sx > 0 ? 1 - u : u;
      const outer = teeAt(sx * edgeA(y, l), y, l);
      const inner = teeAt(sx * edgeA(y, 0.003), y, 0.003);
      return [outer[0] + (inner[0] - outer[0]) * k, y, outer[2] + (inner[2] - outer[2]) * k];
    }, tape);
  }
  // The T-shirt down the open front, its crew neck, and its neck closed inside.
  teePatch(b, () => -OPEN, () => OPEN, -0.04, 0.515, 0.003, tee, 8, 18);
  b.torus(0, 0.527, 0.0, 0.061, 0.0095, S.cloth(shade(shirt, 0.84), 0.3), Math.PI / 2, 0, 0, 6, 22);
  const top = TEE[TEE.length - 1][0];
  sheet(b, 28, 1, (u, v) => {
    const [x, , z] = teeAt(u * Math.PI * 2, top, 0.003);
    const k = 1 - v * 0.5;
    return [x * k, top + 0.004 * v, z * k];
  }, S.skin(skin), true);
  // The turned-in hem.
  sheet(b, 26, 1, (u, v) => {
    const l = puff(Y0) - 0.012 * (1 - v);
    const a0 = edgeA(Y0, l);
    return teeAt(a0 + u * (Math.PI * 2 - 2 * a0), Y0 + 0.012 * (1 - v), l);
  }, shell);
  // Pockets: a zipped slit on each side, low on the front, slanting out toward the top.
  for (const sx of [-1, 1]) {
    sheet(b, 1, 6, (u, v) => {
      const y = 0.08 + 0.11 * v;
      const x = sx * (0.108 + 0.038 * v) + (u - 0.5) * 0.007;
      const r = teeRing(y);
      const l = puff(y) + 0.0012;
      const a = Math.sign(x) * Math.asin(Math.min(1, (Math.abs(x) / (r.rx + l)) ** (r.p / 2)));
      return teeAt(a, y, l);
    }, seam);
  }
  // The collar: a fat roll round the back and sides of the neck, open at the front.
  const collar: P3[] = [];
  const cr: number[] = [];
  for (let i = 0; i <= 16; i++) {
    const a = 1.0 + (i / 16) * (Math.PI * 2 - 2.0);
    const c = Math.cos(a);
    const w = (1 - c) / 2;
    // Fullest behind the neck, slimming and widening toward the front, where its ends run into the jacket's front edges.
    collar.push([Math.sin(a) * (0.086 + 0.03 * (1 - w)), 0.5 + 0.036 * Math.sqrt(w), c * (c > 0 ? 0.104 : 0.088)]);
    cr.push(0.012 + 0.01 * Math.sqrt(w));
  }
  tube(b, collar, cr, shell, 8, false);
}

/**
 * A big dark graphic printed on the right of a T-shirt's front: a bold ring with a stroke through it, a wave running off
 * toward the hem, and a band slanting down across the chest. Each stroke lies flat on the cloth, a hair proud of it (the
 * front of the T-shirt is `teeFront`).
 */
function drawPrint(b: MeshBuilder, col: number) {
  const ink = S.cloth(col, 0.3);
  const stroke = (x: number, y: number, len: number, w: number, ang: number) => {
    const p = teeFront(x, y, 0.0026);
    const n = teeNormal(x, y);
    b.box(p[0], p[1], p[2], len, w, 0.004, ink, Math.asin(Math.max(-1, Math.min(1, -n.y))), Math.atan2(n.x, n.z), ang);
  };
  const [cx, cy, R] = [-0.065, 0.16, 0.042];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    stroke(cx + R * Math.cos(a), cy + R * Math.sin(a), ((Math.PI * 2 * R) / 16) * 1.2, 0.011, a + Math.PI / 2);
  }
  for (let i = -2; i <= 2; i++) stroke(cx + i * 0.013, cy + i * 0.016, 0.022, 0.012, 0.9);
  for (let i = 0; i < 6; i++) stroke(-0.12 + i * 0.02, 0.085 + Math.sin(i * 1.3) * 0.014, 0.026, 0.012, Math.cos(i * 1.3) * 0.6);
  for (let i = 0; i < 7; i++) stroke(-0.105 + i * 0.016, 0.36 - i * 0.017, 0.026, 0.013, -0.8);
}

/**
 * Upper-arm cover: the sleeve plus whatever armour sits on it. A short sleeve (`skin` given) stops `cuff` down the arm:
 * halfway for a T-shirt, just above the elbow for a sleeve pushed up.
 */
export function drawUpperArm(b: MeshBuilder, body: Piece<BodyStyle>, sleeve: Surf, skin?: Surf, quilted = false, cuff = 0.14) {
  if (quilted) {
    // A down jacket's sleeve: fat, in rolls.
    b.limb(0, -0.02, 0, 0, -0.27, 0, 0.074, 0.063, sleeve, 12);
    const stitch = S.cloth(new THREE.Color(typeof sleeve.c === 'number' ? sleeve.c : 0x222222).multiplyScalar(0.45).getHex(), 0.5);
    for (const y of [-0.08, -0.15, -0.22]) b.torus(0, y, 0, 0.0715 + (y + 0.02) * 0.044, 0.0025, stitch, Math.PI / 2, 0, 0, 4, 16);
    return;
  }
  if (skin) {
    // A T-shirt's short sleeve: round over the shoulder, open and a little loose at the hem, with the hem's stitched edge.
    // The arm starts inside the sleeve and ends a little inside the elbow's round, so neither shows through the other.
    b.limb(0, -0.05, 0, 0, -0.28, 0, 0.058, 0.0485, skin, 16);
    b.sphereAt(0, -0.034, 0, 0.066, sleeve);
    const rb = 0.066 - (cuff - 0.034) * 0.04;
    b.frustum(0, -(0.034 + cuff) / 2, 0, 0.066, rb, cuff - 0.034, sleeve, 0, 0, 0, 14);
    if (cuff < 0.2) {
      const c = typeof sleeve.c === 'number' ? sleeve.c : 0x6a6a60;
      b.torus(0, -cuff + 0.001, 0, rb - 0.0005, 0.0035, S.cloth(new THREE.Color(c).multiplyScalar(0.8).getHex(), 0.3), Math.PI / 2, 0, 0, 4, 18);
    }
    return;
  }
  b.limb(0, -0.02, 0, 0, -0.27, 0, 0.065, 0.054, sleeve, 16);
  if (body.style === 'riot') b.rbox(0, -0.15, 0, 0.13, 0.17, 0.13, 0.04, S.plastic(body.c ?? 0x262b30, 0.4));
}

// ------------------------------------------------------------------------------------------- pack

/** Everything carried on the back and hip. */
export function drawPack(b: MeshBuilder, p: Piece<PackStyle>) {
  const c = p.c ?? 0x4a4636;
  const leather = S.leather(0x3b2a1e, 0.5);
  switch (p.style) {
    case 'ruck': {
      // A backpack with a bedroll lashed on top.
      b.rbox(0, 0.32, -0.19, 0.32, 0.38, 0.16, 0.05, S.cloth(c, 0.7));
      b.rbox(0, 0.22, -0.28, 0.22, 0.16, 0.05, 0.02, S.cloth(new THREE.Color(c).multiplyScalar(0.85).getHex(), 0.7));
      b.capsule(-0.16, 0.54, -0.19, 0.16, 0.54, -0.19, 0.065, S.cloth(p.c2 ?? 0x5d5a40, 0.6), 10);
      for (const sx of [1, -1]) b.box(sx * 0.12, 0.54, -0.19, 0.012, 0.14, 0.14, leather);
      break;
    }
    case 'satchel': {
      // A bag on the hip and the strap across the chest that holds it.
      b.rbox(-0.17, 0.1, -0.1, 0.1, 0.2, 0.26, 0.04, S.leather(c, 0.5));
      b.rbox(-0.17, 0.2, -0.1, 0.11, 0.04, 0.27, 0.015, S.leather(new THREE.Color(c).multiplyScalar(0.75).getHex(), 0.5));
      b.box(0.02, 0.34, 0.13, 0.045, 0.56, 0.012, leather, 0, 0, 0.5);
      b.box(0.02, 0.34, -0.13, 0.045, 0.56, 0.012, leather, 0, 0, 0.5);
      break;
    }
    case 'duffel': {
      const cloth = S.cloth(c, 0.65);
      b.cyl(0, 0.36, -0.2, 0.26, 0.66, 0.26, cloth, 0, 0, Math.PI / 2, 12);
      for (const sx of [1, -1]) b.cyl(sx * 0.33, 0.36, -0.2, 0.26, 0.012, 0.26, S.cloth(p.c2 ?? 0x2e3322, 0.6), 0, 0, Math.PI / 2, 12);
      for (const sx of [1, -1]) b.box(sx * 0.12, 0.36, -0.2, 0.04, 0.28, 0.27, leather);
      b.box(0, 0.36, -0.2, 0.2, 0.025, 0.28, S.cloth(p.c2 ?? 0x2e3322, 0.6));
      break;
    }
    case 'frame': {
      const alloy = S.metal(p.c2 ?? 0x8a8e92, 0.4);
      for (const sx of [1, -1]) b.rod(sx * 0.13, 0.04, -0.16, sx * 0.13, 0.66, -0.16, 0.012, alloy, 6);
      for (const y of [0.12, 0.38, 0.62]) b.rod(-0.13, y, -0.16, 0.13, y, -0.16, 0.01, alloy, 6);
      b.rbox(0, 0.4, -0.26, 0.34, 0.46, 0.18, 0.05, S.cloth(c, 0.7));
      b.rbox(0, 0.17, -0.3, 0.3, 0.14, 0.12, 0.04, S.cloth(new THREE.Color(c).multiplyScalar(0.8).getHex(), 0.7));
      b.capsule(-0.17, 0.68, -0.22, 0.17, 0.68, -0.22, 0.07, S.cloth(0x3e5a6a, 0.6), 10);
      b.cyl(0.17, 0.1, -0.34, 0.1, 0.09, 0.1, S.metal(0x9a9a9a, 0.4), 0, 0, 0, 10);
      break;
    }
    case 'none':
      break;
  }
}

// ------------------------------------------------------------------------------------------- hands

/**
 * The forearm and hand as one smooth shape, elbow to knuckles (rows bottom to top): height, half thickness (across the
 * palm, x), half width (z, front and back alike), squareness. Round at the elbow (its top is the round the elbow turns
 * on), flattening through the wrist into the palm.
 */
const ARM: Loft = [
  [-0.292, 0.006, 0.024, 0.024, 2.2],
  [-0.286, 0.0132, 0.038, 0.038, 2.6],
  [-0.265, 0.0162, 0.0415, 0.0415, 2.8],
  [-0.24, 0.0185, 0.04, 0.04, 2.6],
  [-0.218, 0.021, 0.035, 0.035, 2.3],
  [-0.2, 0.025, 0.035, 0.035, 2.2],
  [-0.15, 0.034, 0.04, 0.04, 2.1],
  [-0.07, 0.044, 0.047, 0.047, 2.0],
  [0.0, 0.047, 0.047, 0.047, 2.0],
  [0.024, 0.04, 0.04, 0.04, 2.0],
  [0.04, 0.024, 0.024, 0.024, 2.0],
  [0.047, 0.003, 0.003, 0.003, 2.0],
];

/**
 * A hand on the end of the forearm (origin on the elbow, the wrist at y -0.2): the palm turned in toward the body, four
 * fingers in a relaxed curl toward it (two segments each, the curl deepening from the index to the little finger) and the
 * thumb down the front beside the index. `side` 1 is the left hand (on the body's +x), -1 the right. Whatever it holds
 * still sits where it always did, at (0, -0.27, 0.02), in the palm. `arm` draws the bare forearm in that surface too;
 * `thick` fattens it all for a glove.
 */
function drawFingers(b: MeshBuilder, side: number, palm: Surf, fingers: Surf, thick = 0, arm?: Surf) {
  // m runs toward the palm side (the body's middle), which is -x for the left hand. The palm sits a little to the outside.
  const X = (m: number) => -side * m;
  const cx = (y: number) => side * 0.006 * Math.max(0, Math.min(1, (-0.19 - y) / 0.04));
  const shape = (y0: number, y1: number, rows: number, lift: number, surf: Surf) =>
    sheet(b, 16, rows, (u, v) => {
      const y = y0 + (y1 - y0) * v;
      const p = loftAt(ARM, u * Math.PI * 2, y, lift);
      return [p[0] + cx(y), y, p[2]];
    }, surf, true);
  if (arm) shape(-0.205, 0.047, 12, 0, arm);
  shape(-0.292, -0.19, 10, thick, palm);
  // z at the knuckle, knuckle height, radius, the two segment lengths, the curl at the knuckle and at the middle joint.
  const F = [
    [0.027, -0.283, 0.0086, 0.04, 0.042, 0.3, 0.85],
    [0.0095, -0.287, 0.009, 0.044, 0.045, 0.38, 0.98],
    [-0.0085, -0.285, 0.0084, 0.041, 0.042, 0.46, 1.1],
    [-0.025, -0.279, 0.0074, 0.032, 0.033, 0.55, 1.22],
  ];
  const m0 = -0.006;
  for (const [z, ky, r, l1, l2, a1, a2] of F) {
    const m1 = m0 + l1 * Math.sin(a1);
    const y1 = ky - l1 * Math.cos(a1);
    const pts: P3[] = [
      [X(m0), ky + 0.02, z],
      [X(m0), ky, z],
      [X(m1), y1, z * 0.94],
      [X(m1 + l2 * Math.sin(a2)), y1 - l2 * Math.cos(a2), z * 0.88],
    ];
    tube(b, pts, [r, r, r * 0.93, r * 0.82].map((v) => v + thick), fingers, 6);
  }
  const thumb: P3[] = [
    [X(0.0), -0.222, 0.022],
    [X(0.014), -0.244, 0.041],
    [X(0.022), -0.265, 0.046],
    [X(0.027), -0.283, 0.043],
  ];
  tube(b, thumb, [0.0125, 0.011, 0.0096, 0.0086].map((v) => v + thick), fingers, 6);
}

/**
 * Forearm and hand. A `bare` forearm comes out of a short sleeve: skin to the wrist and no cuff. `side` 1 is the left
 * arm, -1 the right, so the thumbs are on the right sides.
 */
export function drawHand(b: MeshBuilder, p: Piece<HandStyle>, sleeve: Surf, skin: Surf, bare = false, side = 1) {
  const c = p.c ?? 0x2b2622;
  const glove = S.leather(c, 0.4);
  // A sleeve and its cuff are the same for every glove; a bare forearm is part of the hand's shape (see `drawFingers`). The
  // forearm starts a little slimmer than the end of the upper arm, so it turns inside it at the elbow.
  if (!bare) {
    b.limb(0, 0, 0, 0, -0.2, 0, 0.047, 0.043, sleeve, 16);
    b.torus(0, -0.2, 0, 0.045, 0.014, sleeve, Math.PI / 2, 0, 0, 6, 12);
  } else if (p.style === 'padded') b.limb(0, 0, 0, 0, -0.2, 0, 0.047, 0.043, skin, 16);
  const arm = bare ? skin : undefined;
  switch (p.style) {
    case 'work':
      drawFingers(b, side, glove, glove, 0.0015, arm);
      break;
    case 'fingerless':
      drawFingers(b, side, glove, skin, 0, arm);
      b.torus(0, -0.225, 0, 0.044, 0.012, glove, Math.PI / 2, 0, 0, 6, 12);
      break;
    case 'padded':
      b.cyl(0, -0.16, 0, 0.1, 0.1, 0.1, glove, 0, 0, 0, 10);
      b.rbox(0, -0.27, 0.005, 0.085, 0.13, 0.062, 0.03, glove);
      b.rbox(0, -0.31, 0.04, 0.08, 0.035, 0.022, 0.01, S.metal(p.c2 ?? 0x6a6e72, 0.4));
      b.capsule(0.034, -0.24, 0.032, 0.04, -0.285, 0.048, 0.018, glove, 6);
      break;
    case 'tactical':
      // A hard plate over the knuckles, on the back of the hand.
      drawFingers(b, side, glove, glove, 0.0013, arm);
      b.rbox(side * 0.025, -0.276, 0.002, 0.008, 0.026, 0.07, 0.003, S.plastic(0x2a2a2c, 0.3));
      break;
    case 'bare':
      drawFingers(b, side, skin, skin, 0, arm);
      break;
  }
}

// ------------------------------------------------------------------------------------------- legs and feet

/** Trouser colour for a leg style. */
export function trouserColor(p: Piece<LegStyle>, fallback: number): number {
  return p.c ?? fallback;
}

/** Thigh decoration: pockets, pads and plates over the trouser leg. */
export function drawThigh(b: MeshBuilder, p: Piece<LegStyle>, fallback: number, side: number) {
  const c = trouserColor(p, fallback);
  const pants = S.cloth(c, 0.6);
  switch (p.style) {
    case 'work':
      // Cargo pocket and a holster strap.
      b.rbox(side * 0.08, -0.22, 0.0, 0.03, 0.13, 0.1, 0.01, pants);
      b.torus(0, -0.3, 0, 0.074, 0.008, S.leather(0x2b2018, 0.4), Math.PI / 2, 0, 0, 6, 14);
      break;
    case 'cargo': {
      const flap = S.cloth(new THREE.Color(c).multiplyScalar(0.82).getHex(), 0.65);
      b.rbox(side * 0.085, -0.2, 0.0, 0.04, 0.17, 0.13, 0.012, pants);
      b.rbox(side * 0.095, -0.15, 0.0, 0.03, 0.05, 0.135, 0.01, flap);
      b.rbox(0, -0.2, 0.082, 0.1, 0.1, 0.03, 0.01, pants);
      break;
    }
    case 'padded':
      b.rbox(0, -0.15, 0.088, 0.12, 0.17, 0.03, 0.015, S.plastic(0x222222, 0.5));
      b.torus(0, -0.3, 0, 0.074, 0.008, S.leather(0x2b2018, 0.4), Math.PI / 2, 0, 0, 6, 14);
      break;
    case 'greaves':
      b.rbox(0, -0.2, 0.085, 0.13, 0.28, 0.04, 0.015, S.metal(p.c2 ?? 0x7a7e82, 0.45));
      b.torus(0, -0.35, 0, 0.074, 0.008, S.leather(0x2b2018, 0.4), Math.PI / 2, 0, 0, 6, 14);
      break;
    case 'trousers': {
      // Plain trousers or jeans: the outer seam down the leg, a shade darker (the leg tapers 0.088 to 0.066 over 0.42).
      const seam = S.cloth(shade(c, 0.72), 0.3);
      b.box(side * 0.0772, -0.21, 0.0, 0.0024, 0.4, 0.0045, seam, 0, 0, -side * 0.052);
      break;
    }
    case 'bare':
      break;
  }
}

/**
 * Hips in plain trousers or jeans, origin at the hips (the legs hang from (+-0.1, -0.02)): rounder than the kit's box, full
 * in the seat, closed at the crotch, and small enough to stay inside an untucked top.
 */
const HIPS: Loft = [
  [-0.136, 0.012, 0.008, 0.01, 2.0],
  [-0.13, 0.065, 0.035, 0.06, 2.0],
  [-0.115, 0.12, 0.056, 0.094, 2.2],
  [-0.09, 0.154, 0.078, 0.11, 2.4],
  [-0.045, 0.165, 0.099, 0.114, 2.5],
  [0.0, 0.165, 0.105, 0.107, 2.55],
  [0.05, 0.16, 0.102, 0.103, 2.6],
  [0.088, 0.152, 0.096, 0.097, 2.6],
];

/**
 * The pelvis in plain trousers or jeans (or bare legs in briefs), instead of the kit's box and survival belt: rounded hips,
 * a narrow leather belt with a brass buckle and loops, the fly, and two patch pockets on the seat. Briefs get an elastic
 * waistband instead.
 */
export function drawWaist(b: MeshBuilder, legs: Piece<LegStyle>, fallback: number) {
  const bare = legs.style === 'bare';
  const c = bare ? 0x7a7a72 : trouserColor(legs, fallback);
  const pants = S.cloth(c, 0.3);
  const at = (a: number, y: number, lift = 0) => loftAt(HIPS, a, y, lift);
  // The angle round the hips at which a point is x across, on the front (a near 0) or the back (a near pi).
  const across = (x: number, y: number, back = false) => {
    const r = loftRing(HIPS, y);
    const a = Math.sign(x) * Math.asin(Math.min(1, (Math.abs(x) / r.rx) ** (r.p / 2)));
    return back ? Math.PI - a : a;
  };
  sheet(b, 24, 14, (u, v) => at(u * Math.PI * 2, loftY(HIPS, v)), pants, true);
  // Close the top inside, under the shirt.
  const top = HIPS[HIPS.length - 1][0];
  sheet(b, 24, 1, (u, v) => {
    const [x, , z] = at(u * Math.PI * 2, top);
    return [x * (1 - v * 0.8), top + 0.004 * v, z * (1 - v * 0.8)];
  }, pants, true);
  const band = (y0: number, y1: number, lift: number, surf: Surf) => {
    sheet(b, 24, 1, (u, v) => at(u * Math.PI * 2, y0 + (y1 - y0) * v, lift), surf, true);
    // Its top and bottom edges, so it has a thickness.
    sheet(b, 24, 1, (u, v) => at(u * Math.PI * 2, y1, lift * (1 - v)), surf, true);
    sheet(b, 24, 1, (u, v) => at(u * Math.PI * 2, y0, lift * v), surf, true);
  };
  if (bare) {
    band(0.05, 0.08, 0.003, S.cloth(0x55554f, 0.3));
    return;
  }
  const seam = S.cloth(shade(c, 0.7), 0.3);
  const leather = S.leather(0x2a1d14, 0.25);
  const brass = S.metal(0xa48c5c, 0.2);
  const [b0, b1] = [0.05, 0.082];
  band(b0, b1, 0.0045, leather);
  // The buckle: a brass frame on the front, the strap showing through it, the tongue across.
  const front = at(0, (b0 + b1) / 2, 0.0045);
  b.rbox(0, front[1], front[2] + 0.002, 0.044, 0.036, 0.005, 0.004, brass);
  b.rbox(0, front[1], front[2] + 0.004, 0.03, 0.022, 0.004, 0.002, leather);
  b.box(0.003, front[1], front[2] + 0.0062, 0.024, 0.003, 0.003, brass);
  // Belt loops in the trouser cloth, standing on the belt.
  for (const [x, back] of [[0.075, false], [-0.075, false], [0.06, true], [-0.06, true]] as const) {
    const a = across(x, b1, back);
    sheet(b, 1, 3, (u, v) => {
      const aa = a + (u - 0.5) * 0.09;
      return at(aa, b0 - 0.004 + (b1 - b0 + 0.008) * v, 0.0062);
    }, pants);
  }
  for (const sx of [-1, 1]) sheet(b, 1, 3, (u, v) => at(sx * Math.PI / 2 + (u - 0.5) * 0.12, b0 - 0.004 + (b1 - b0 + 0.008) * v, 0.0062), pants);
  // The fly, stitched in a J down the front.
  sheet(b, 1, 5, (u, v) => {
    const y = -0.07 + 0.115 * v;
    const curl = Math.max(0, 1 - v * 4);
    return at(across(0.012 - 0.012 * curl * curl + (u - 0.5) * 0.0024, y), y - 0.006 * curl, 0.0012);
  }, seam);
  // Patch pockets on the seat, pointed at the bottom, and a stitched line across the top of each.
  for (const sx of [-1, 1]) {
    const [x0, x1] = sx > 0 ? [0.125, 0.03] : [-0.03, -0.125];
    const pocket = (u: number, v: number, lift: number) => {
      const x = x0 + (x1 - x0) * u;
      const y = -0.105 + 0.075 * v + 0.022 * Math.abs(u - 0.5) * (1 - v);
      return at(across(x, y, true), y, lift);
    };
    sheet(b, 4, 4, (u, v) => pocket(u, v, 0.0016), S.cloth(shade(c, 0.82), 0.3));
    sheet(b, 4, 1, (u, v) => pocket(u, 0.94 + 0.06 * v, 0.0022), seam);
    // The stitched arcs across the pocket, in a lighter thread.
    sheet(b, 8, 1, (u, v) => pocket(u, 0.5 + 0.18 * Math.abs(2 * u - 1) ** 1.3 + 0.035 * v, 0.0022), S.cloth(shade(c, 1.45), 0.3));
  }
}

/** A sneaker's upper along the foot, heel to toe: z, half width, height of the top. */
const SHOE: readonly (readonly [number, number, number])[] = [
  [-0.058, 0.04, -0.382],
  [-0.04, 0.046, -0.373],
  [0.0, 0.049, -0.373],
  [0.04, 0.05, -0.397],
  [0.09, 0.052, -0.417],
  [0.13, 0.05, -0.43],
  [0.155, 0.045, -0.437],
];

/**
 * A sneaker in the shin's frame (the sole on the ground at y -0.478): a smooth upper rounded at heel and toe, high at the
 * ankle and sloping down over the instep, on a rubber sole that follows the outline of the foot, with laces up the front.
 */
function drawSneaker(b: MeshBuilder, upper: Surf, sole: Surf, lace: Surf) {
  const YB = -0.452;
  const n = SHOE.length;
  const [z0, z1] = [SHOE[0][0], SHOE[n - 1][0]];
  const [r0, r1] = [0.02, 0.018];
  const at = (z: number) => {
    const c = Math.max(z0, Math.min(z1, z));
    let k = 0;
    while (k < n - 2 && c > SHOE[k + 1][0]) k++;
    const t = (c - SHOE[k][0]) / (SHOE[k + 1][0] - SHOE[k][0]);
    const s = t * t * (3 - 2 * t);
    const w = SHOE[k][1] + (SHOE[k + 1][1] - SHOE[k][1]) * s;
    const top = SHOE[k][2] + (SHOE[k + 1][2] - SHOE[k][2]) * s;
    // Past either end the section shrinks round to the sole: the rounded heel and toe.
    const d = z < z0 ? (z0 - z) / r0 : z > z1 ? (z - z1) / r1 : 0;
    const sc = Math.sqrt(Math.max(0, 1 - d * d));
    return { w: w * Math.sqrt(sc), top: YB + (top - YB) * sc ** 0.6 };
  };
  sheet(b, 14, 16, (u, v) => {
    const z = z0 - r0 + (z1 + r1 - z0 + r0) * Math.max(0, Math.min(1, v));
    const { w, top } = at(z);
    const th = u * Math.PI * 2;
    const cs = Math.cos(th);
    const sn = Math.sin(th);
    const hh = (top - YB) / 2;
    return [w * Math.sign(cs) * Math.abs(cs) ** 0.8, YB + hh + hh * Math.sign(sn) * Math.abs(sn) ** 0.8, z];
  }, upper, true);
  // The sole: the outline of the foot, a little wider than the upper, from the ground up to its top edge.
  const outline = (th: number, grow: number): [number, number] => {
    const s = Math.sin(th);
    const c = Math.cos(th);
    const w = (c < 0 ? 0.05 : 0.057) + grow;
    return [w * Math.sign(s) * Math.abs(s) ** 0.55, 0.052 + (0.128 + grow) * Math.sign(c) * Math.abs(c) ** 0.8];
  };
  const [g0, g1] = [-0.478, YB + 0.006];
  sheet(b, 24, 2, (u, v) => {
    const [x, z] = outline(u * Math.PI * 2, 0.002 * Math.sin(v * Math.PI));
    return [x, g0 + (g1 - g0) * v, z];
  }, sole, true);
  sheet(b, 24, 1, (u, v) => {
    const [x, z] = outline(u * Math.PI * 2, 0);
    return [x * (1 - v), g1, 0.052 + (z - 0.052) * (1 - v)];
  }, sole, true);
  sheet(b, 24, 1, (u, v) => {
    const [x, z] = outline(u * Math.PI * 2, 0);
    return [x * v, g0, 0.052 + (z - 0.052) * v];
  }, sole, true);
  // Laces across the instep, lying on its slope.
  for (let i = 0; i < 4; i++) {
    const z = 0.035 + i * 0.019;
    b.box(0, at(z).top + 0.0018, z, 0.042 - i * 0.002, 0.0035, 0.0075, lace, 0.42, 0, 0);
  }
}

/** Shin cover and the shoe: pads over the knee, then boots, trainers or bare feet. */
export function drawShin(b: MeshBuilder, legs: Piece<LegStyle>, feet: Piece<FootStyle>, fallbackPants: number, skin: Surf) {
  const pants = legs.style === 'bare' ? skin : S.cloth(trouserColor(legs, fallbackPants), 0.6);
  // Plain trousers over low shoes come down over the ankle to a hem resting on the shoe.
  const long = legs.style === 'trousers' && feet.style !== 'boots' && feet.style !== 'steel';
  // The top a little slimmer than the end of the thigh, so the knee turns inside it.
  if (long) {
    // An open leg, a touch flared, its stitched hem just above the shoe.
    b.sphereAt(0, 0, 0, 0.06, pants);
    b.frustum(0, -0.186, 0, 0.06, 0.057, 0.372, pants, 0, 0, 0, 16);
    b.torus(0, -0.368, 0, 0.0565, 0.0045, S.cloth(shade(trouserColor(legs, fallbackPants), 0.85), 0.3), Math.PI / 2, 0, 0, 5, 18);
  } else b.limb(0, 0, 0, 0, -0.3, 0, 0.06, 0.052, pants, 16);
  // Knee protection.
  if (legs.style === 'greaves') {
    const m = S.metal(legs.c2 ?? 0x7a7e82, 0.45);
    b.rbox(0, -0.17, 0.056, 0.11, 0.26, 0.04, 0.015, m);
    b.add('sphere', 0, -0.03, 0.068, 0.125, 0.1, 0.08, m);
  } else if (legs.style === 'padded') b.rbox(0, -0.03, 0.062, 0.135, 0.15, 0.055, 0.028, S.plastic(0x222222, 0.5));
  else if (legs.style !== 'bare' && legs.style !== 'trousers') b.rbox(0, -0.03, 0.055, 0.1, 0.11, 0.04, 0.02, S.plastic(0x2a2a2a, 0.6));

  const c = feet.c ?? 0x2a211b;
  const boot = S.leather(c, 0.6);
  const lace = S.cloth(0x6a5a44, 0.3);
  switch (feet.style) {
    case 'boots':
      // Shaft, laced front, toe cap and sole.
      b.rbox(0, -0.36, 0.0, 0.11, 0.16, 0.12, 0.04, boot);
      b.rbox(0, -0.42, 0.06, 0.105, 0.08, 0.2, 0.035, boot);
      b.rbox(0, -0.465, 0.06, 0.115, 0.025, 0.23, 0.01, S.rubber(0x161412));
      for (let i = 0; i < 4; i++) b.box(0, -0.3 - i * 0.03, 0.06, 0.05, 0.006, 0.01, lace);
      break;
    case 'steel': {
      const steel = S.metal(feet.c2 ?? 0x8a8e92, 0.4);
      b.rbox(0, -0.34, 0.0, 0.118, 0.22, 0.128, 0.04, boot);
      b.rbox(0, -0.42, 0.06, 0.108, 0.08, 0.2, 0.035, boot);
      b.rbox(0, -0.435, 0.145, 0.104, 0.062, 0.07, 0.025, steel);
      b.rbox(0, -0.468, 0.06, 0.12, 0.03, 0.24, 0.01, S.rubber(0x161412));
      for (const y of [-0.31, -0.37]) b.box(0, y, 0.066, 0.1, 0.018, 0.01, steel);
      break;
    }
    case 'sneakers': {
      // Ankle sock (under long trousers it is out of sight), a shaped canvas upper on a rubber sole, and the laces.
      if (!long) b.limb(0, -0.3, 0, 0, -0.37, 0, 0.05, 0.046, S.cloth(0xe8e4d8, 0.4), 8);
      // Under long trousers, the ankle and the tongue of the shoe fill the gap over the instep.
      else b.limb(0, -0.34, 0, 0, -0.41, 0.012, 0.045, 0.043, { ...boot, w: 0.3 }, 8, true);
      drawSneaker(b, { ...boot, w: 0.3 }, S.rubber(feet.c2 ?? 0xd9d4c4), S.cloth(feet.c2 ?? 0xe8e4d8, 0.3));
      break;
    }
    case 'runners': {
      b.limb(0, -0.3, 0, 0, -0.37, 0, 0.05, 0.046, S.cloth(0x2a2a28, 0.4), 8);
      b.rbox(0, -0.385, 0.0, 0.1, 0.09, 0.11, 0.035, boot);
      b.rbox(0, -0.425, 0.065, 0.098, 0.062, 0.2, 0.035, boot);
      const accent = S.cloth(feet.c2 ?? 0xd9c6a0, 0.4);
      for (const sx of [1, -1]) b.box(sx * 0.052, -0.43, 0.06, 0.006, 0.03, 0.12, accent);
      b.rbox(0, -0.462, 0.065, 0.108, 0.032, 0.23, 0.012, S.rubber(feet.c2 ?? 0xd9c6a0));
      break;
    }
    case 'bare':
      b.rbox(0, -0.4, 0.06, 0.1, 0.075, 0.2, 0.035, skin);
      b.rbox(0, -0.37, 0.0, 0.09, 0.08, 0.1, 0.03, skin);
      break;
  }
}

/** Underwear for bare legs, so a stripped survivor is not see-through. */
export function drawBriefs(b: MeshBuilder) {
  b.rbox(0, -0.02, 0, 0.33, 0.2, 0.21, 0.07, S.cloth(0x7a7a72, 0.6));
}
