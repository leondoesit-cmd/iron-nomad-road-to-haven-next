import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { C } from './palette';
import type { PropKind } from '../world/layout';
import { buildLakeLandmark, LAKE_KINDS } from './lakeProps';

/**
 * Roadside landmarks for the wasteland: things tall or long enough to be seen from kilometres away.
 * Local frame as for every prop: ground at y = 0, +Z forward, metres. The far landscape draws these
 * for the whole leg, so they are never part of a streamed chunk.
 */

function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Kinds the landscape draws for the whole leg instead of the chunk streamer. */
export const LANDMARK_KINDS = new Set<PropKind>([
  'waterTower',
  'silo',
  'windTurbine',
  'mast',
  'billboard',
  'gasSign',
  'fuelTank',
  'windpump',
  'powerTower',
  'powerSpan',
  'overpass',
  'canopy',
  ...LAKE_KINDS,
]);

const PAINT = [0xb8b0a0, 0xa89880, 0x9aa0a0, 0xc2b8a0];
const FADED = [0xb86a4a, 0x5a7a8a, 0xc8a85a, 0x8a9a6a, 0x9a5a6a];

export function waterTower(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  const r = rng(seed + 3);
  const steel = S.steel(0x4a4c4c, 0.7);
  const h = 11 + r() * 3;
  const tank = S.rust(0x8a5a3a);
  for (const [lx, lz] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
    b.rod(lx * 2.6, 0, lz * 2.6, lx * 1.9, h, lz * 1.9, 0.14, steel, 6);
  }
  for (let y = 3; y < h; y += 3.6) {
    const k = 2.6 - (y / h) * 0.7;
    b.rod(-k, y, k, k, y, k, 0.05, steel, 5);
    b.rod(-k, y, -k, k, y, -k, 0.05, steel, 5);
    b.rod(k, y, -k, k, y, k, 0.05, steel, 5);
    b.rod(-k, y, -k, -k, y, k, 0.05, steel, 5);
  }
  for (let i = 0; i < 4; i++) {
    const s = i < 2 ? 1 : -1;
    const lo = 3 + (i % 2) * 3.6;
    const k0 = 2.6 - (lo / h) * 0.7;
    const k1 = 2.6 - ((lo + 3.6) / h) * 0.7;
    b.rod(-k0 * s, lo, k0, k1 * s, lo + 3.6, k1, 0.03, steel, 4);
  }
  b.cyl(0, h + 0.2, 0, 5.4, 0.4, 5.4, steel, 0, 0, 0, 16);
  b.cyl(0, h + 2.6, 0, 5.0, 4.4, 5.0, tank, 0, 0, 0, 20);
  for (const y of [h + 1.2, h + 2.6, h + 4.0]) b.torus(0, y, 0, 2.5, 0.05, steel, Math.PI / 2, 0, 0, 5, 24);
  b.add('cone12', 0, h + 5.6, 0, 5.6, 1.6, 5.6, S.rust(0x6a4630));
  b.rod(2.3, 3, 0, 2.3, h + 4, 0.2, 0.03, steel, 4);
  // Faded lettering band.
  b.cyl(0, h + 2.7, 0, 5.04, 1.1, 5.04, S.paint(PAINT[Math.floor(r() * 4)], 0.7), 0, 0, 0, 20);
  b.groundShade(0, 1, 0.3);
  return b;
}

export function silo(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  const r = rng(seed + 11);
  const h = 13 + r() * 5;
  const wall = S.metal(0xa6a8a2, 0.75);
  b.cyl(0, h / 2, 0, 6.0, h, 6.0, wall, 0, 0, 0, 20);
  for (let y = 1.2; y < h; y += 1.35) b.torus(0, y, 0, 3.02, 0.06, S.metal(0x8a8c88, 0.8), Math.PI / 2, 0, 0, 4, 24);
  b.lathe('siloDome', [[0, 0], [1.5, 0.2], [2.6, 0.7], [3.0, 1.2]], 0, h, 0, S.metal(0x9a9c96, 0.7), Math.PI, 0, 0, 20, 1);
  b.cyl(0, h + 1.2, 0, 0.4, 1.0, 0.4, S.steel(), 0, 0, 0, 8);
  // Ladder and a rusted patch.
  b.box(3.05, h / 2, 0, 0.06, h, 0.55, S.steel(0x3a3c3c, 0.8));
  b.add('ico1', 2.9, h * 0.35, 1.2, 0.5, 2.2, 1.8, S.rust(0x7a4a2a), 0, 0.6, 0);
  b.cyl(0, 0.35, 0, 6.3, 0.7, 6.3, S.concrete(0x7a7872, 0.6), 0, 0, 0, 20);
  // Feed hopper.
  b.frustum(0, 1.2, 4.2, 0.9, 0.3, 2.4, S.metal(0x8a8c88, 0.7), 0, 0, 0, 10);
  b.groundShade(0, 1, 0.3);
  return b;
}

export function windTurbine(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  const r = rng(seed + 7);
  const h = 36 + r() * 8;
  const white = S.paint(0xcfcdc4, 0.55);
  b.frustum(0, h / 2, 0, 0.5, 1.15, h, white, 0, 0, 0, 14);
  b.cyl(0, 0.5, 0, 3.0, 1.0, 3.0, S.concrete(0x8a8882, 0.6), 0, 0, 0, 12);
  b.rbox(0, h + 0.4, 0.5, 1.7, 1.7, 4.4, 0.2, white);
  b.add('sphere16', 0, h + 0.4, 2.8, 1.5, 1.5, 1.7, white);
  const spin = r() * Math.PI * 2;
  const broken = Math.floor(r() * 4) === 0 ? Math.floor(r() * 3) : -1;
  for (let i = 0; i < 3; i++) {
    const a = spin + (i * Math.PI * 2) / 3;
    const len = i === broken ? 6 : 19;
    const dx = -Math.sin(a);
    const dy = Math.cos(a);
    const cx = dx * (len / 2 + 0.8);
    const cy = h + 0.4 + dy * (len / 2 + 0.8);
    b.rbox(cx, cy, 3.0, 0.9 - 0.35 * (len / 19), len, 0.14, 0.04, white, 0, 0, a);
  }
  b.groundShade(0, 1.2, 0.3);
  return b;
}

export function mast(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  const h = 50 + (seed % 3) * 8;
  const steel = S.steel(0x6a6c6c, 0.6);
  const red = S.paint(0xb83a2a, 0.5);
  const legs: [number, number][] = [[0, 2.4], [2.08, -1.2], [-2.08, -1.2]];
  const top = 0.3;
  const lvl = 8;
  for (let i = 0; i < lvl; i++) {
    const t0 = i / lvl;
    const t1 = (i + 1) / lvl;
    const k0 = 1 - t0 * (1 - top);
    const k1 = 1 - t1 * (1 - top);
    const y0 = t0 * h;
    const y1 = t1 * h;
    const c = i % 2 ? steel : red;
    for (let l = 0; l < 3; l++) {
      b.rod(legs[l][0] * k0, y0, legs[l][1] * k0, legs[l][0] * k1, y1, legs[l][1] * k1, 0.08, c, 5);
      const n = (l + 1) % 3;
      b.rod(legs[l][0] * k0, y0, legs[l][1] * k0, legs[n][0] * k1, y1, legs[n][1] * k1, 0.03, steel, 4);
      b.rod(legs[n][0] * k0, y0, legs[n][1] * k0, legs[l][0] * k1, y1, legs[l][1] * k1, 0.03, steel, 4);
      b.rod(legs[l][0] * k1, y1, legs[l][1] * k1, legs[n][0] * k1, y1, legs[n][1] * k1, 0.035, steel, 4);
    }
  }
  b.rod(0, h, 0.3, 0, h + 9, 0.3, 0.06, steel, 5);
  b.add('sphere', 0, h + 9.2, 0.3, 0.5, 0.5, 0.5, S.glow(0xff3a2a, 2));
  for (const y of [h * 0.55, h * 0.8]) {
    b.rod(0, y, 0.3, 2.6, y + 0.4, 1.8, 0.04, steel, 4);
    b.lathe('mastDish', [[0, 0], [0.4, 0.05], [0.75, 0.22]], 2.7, y + 0.4, 1.9, S.paint(0xd0d0c8, 0.6), Math.PI / 2 - 0.3, 0.6, 0, 14);
  }
  b.cyl(0, 0.3, 0.3, 6.5, 0.6, 6.5, S.concrete(0x7a7872, 0.6), 0, 0, 0, 3);
  b.groundShade(0, 1, 0.25);
  return b;
}

export function billboard(seed: number, tag: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  const r = rng(seed + 13);
  const steel = S.steel(0x4a4c4c, 0.7);
  const hgt = 8 + r() * 2;
  for (const x of [-4.5, 4.5]) b.rod(x, 0, 0, x, hgt, 0, 0.2, steel, 6);
  const c1 = FADED[(seed + tag) % FADED.length];
  const c2 = FADED[(seed * 3 + tag + 2) % FADED.length];
  b.box(0, hgt + 2.2, 0.1, 13, 4.6, 0.3, S.paint(0xcfc8b8, 0.7));
  // Sun-bleached advertisement blocks, a few panels torn away.
  b.box(-2.8, hgt + 2.2, 0.3, 6.2, 3.8, 0.05, S.paint(c1, 0.75));
  b.box(3.0, hgt + 2.5, 0.3, 5.4, 1.6, 0.05, S.paint(c2, 0.75));
  b.box(3.0, hgt + 1.0, 0.3, 5.4, 0.4, 0.05, S.paint(0x2a2a28, 0.8));
  b.add('ico1', -2.8, hgt + 2.4, 0.4, 3.0, 1.8, 0.1, S.paint(0xe8e0cc, 0.8), 0, 0, 0.2);
  b.box(0, hgt - 0.1, 0.4, 13.2, 0.12, 1.0, steel);
  for (let x = -6; x <= 6; x += 3) b.rod(x, hgt - 0.1, 0.2, x * 0.9, hgt + 0.9, 0.2, 0.025, steel, 4);
  if (r() > 0.5) b.box(-5.5, hgt + 4.8, 0.1, 2.2, 0.08, 0.1, steel, 0, 0, 0.5);
  b.groundShade(0, 1, 0.3);
  return b;
}

export function gasSign(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  const steel = S.steel(0x5a5c5c, 0.6);
  const hgt = 12 + (seed % 3);
  b.rod(0, 0, 0, 0, hgt, 0, 0.17, steel, 8);
  const c = FADED[seed % FADED.length];
  b.rbox(0, hgt + 1.2, 0, 3.4, 2.4, 0.5, 0.05, S.paint(0xd8d0bc, 0.7));
  b.box(0, hgt + 1.7, 0.27, 3.0, 0.8, 0.03, S.paint(c, 0.7));
  for (let i = 0; i < 3; i++) b.box(0, hgt + 0.9 - i * 0.28, 0.27, 2.6, 0.18, 0.03, S.paint(0x2a2a28, 0.8));
  b.box(0, hgt + 2.55, 0, 3.5, 0.1, 0.55, steel);
  b.cyl(0, 0.3, 0, 0.9, 0.6, 0.9, S.concrete(0x7a7872, 0.6), 0, 0, 0, 8);
  return b;
}

export function fuelTank(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  const r = rng(seed + 5);
  const h = 8 + r() * 3;
  const col = S.metal(PAINT[Math.floor(r() * 4)], 0.7);
  b.cyl(0, h / 2 + 0.6, 0, 9, h, 9, col, 0, 0, 0, 24);
  b.lathe('tankDome', [[0, 0], [2.6, 0.25], [4.2, 0.7], [4.5, 1.1]], 0, h + 0.6, 0, S.metal(0x9a9c96, 0.7), Math.PI, 0, 0, 24, 1);
  for (let y = 2; y < h; y += 2.6) b.torus(0, y + 0.6, 0, 4.52, 0.06, S.metal(0x7a7c78, 0.8), Math.PI / 2, 0, 0, 4, 28);
  b.cyl(0, 0.3, 0, 9.8, 0.6, 9.8, S.concrete(0x7a7872, 0.6), 0, 0, 0, 24);
  // Spiral stair, pipes and a rust streak.
  const pts: [number, number, number][] = [];
  for (let i = 0; i <= 18; i++) {
    const a = i * 0.5;
    pts.push([Math.cos(a) * 4.7, 0.6 + (i / 18) * h, Math.sin(a) * 4.7]);
  }
  b.pipe(pts, 0.05, S.steel(0x3a3c3c, 0.8), 4);
  b.pipe([[4.6, 0.8, 0], [6.5, 0.8, 0], [6.5, 0.3, 3]], 0.14, S.rust(0x6a3a22), 6);
  b.add('ico1', -2.6, h * 0.5, -3.8, 1.2, h * 0.7, 0.5, S.rust(0x7a4a2a), 0, 2.2, 0);
  b.groundShade(0, 1, 0.3);
  return b;
}

export function windpump(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  const r = rng(seed + 21);
  const steel = S.steel(0x5a5c5a, 0.65);
  const h = 9;
  const legs: [number, number][] = [[1.1, 1.1], [-1.1, 1.1], [-1.1, -1.1], [1.1, -1.1]];
  for (const [lx, lz] of legs) b.rod(lx, 0, lz, lx * 0.3, h, lz * 0.3, 0.06, steel, 5);
  for (let y = 1.8; y < h; y += 2.2) {
    const k = 1.1 * (1 - y / h * 0.7);
    b.rod(-k, y, k, k, y, k, 0.025, steel, 4);
    b.rod(k, y, -k, k, y, k, 0.025, steel, 4);
  }
  b.rbox(0, h + 0.1, 0, 0.5, 0.5, 1.0, 0.05, steel);
  const spin = r() * 6;
  b.cyl(0, h + 0.1, 0.65, 0.5, 0.2, 0.5, steel, Math.PI / 2, 0, 0, 8);
  for (let i = 0; i < 14; i++) {
    const a = spin + (i * Math.PI * 2) / 14;
    if (r() < 0.12) continue;
    b.box(Math.sin(a) * 1.9, h + 0.1 + Math.cos(a) * 1.9, 0.7, 0.55, 1.8, 0.04, S.metal(0x8a8c88, 0.7), 0, 0, -a + 0.35);
  }
  b.torus(0, h + 0.1, 0.7, 2.4, 0.03, steel, 0, 0, 0, 4, 24);
  b.box(0, h + 0.2, -1.8, 0.05, 1.0, 2.4, S.paint(0x9a5a3a, 0.8));
  b.rod(0, h + 0.1, -0.3, 0, h + 0.2, -1.0, 0.04, steel, 4);
  // Trough and rod.
  b.rod(0, 0, 0, 0, h, 0, 0.03, steel, 4);
  b.rbox(2.2, 0.3, 0, 2.6, 0.6, 1.0, 0.05, S.rust(0x6a4630));
  b.groundShade(0, 0.6, 0.3);
  return b;
}

export function powerTower(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  const steel = S.steel(0x7a7e7e, 0.6);
  const h = 26;
  const legs: [number, number][] = [[1.6, 1.4], [-1.6, 1.4], [-1.6, -1.4], [1.6, -1.4]];
  const levels = [0, 6, 13, 19, h];
  for (let i = 0; i < levels.length - 1; i++) {
    const k0 = 1 - (levels[i] / h) * 0.78;
    const k1 = 1 - (levels[i + 1] / h) * 0.78;
    for (let l = 0; l < 4; l++) {
      const [lx, lz] = legs[l];
      b.rod(lx * k0, levels[i], lz * k0, lx * k1, levels[i + 1], lz * k1, 0.07, steel, 4);
      const [nx, nz] = legs[(l + 1) % 4];
      b.rod(lx * k0, levels[i], lz * k0, nx * k1, levels[i + 1], nz * k1, 0.03, steel, 3);
      b.rod(nx * k0, levels[i], nz * k0, lx * k1, levels[i + 1], lz * k1, 0.03, steel, 3);
      b.rod(lx * k1, levels[i + 1], lz * k1, nx * k1, levels[i + 1], nz * k1, 0.035, steel, 3);
    }
  }
  for (const [y, w] of [[h - 1.2, 4.6], [h - 6.5, 6.2], [h - 11.5, 7.2]] as const) {
    b.rod(-w, y, 0, w, y, 0, 0.07, steel, 4);
    for (const s of [-1, 1]) {
      b.rod(s * 0.4, y + 0.1, 0, s * w, y, 0, 0.03, steel, 3);
      b.rod(s * w, y, 0, s * w, y - 0.9, 0, 0.025, S.glass(0x6e8a7a), 4);
    }
  }
  b.rod(0, h, 0, 0, h + 3, 0, 0.05, steel, 4);
  return b;
}

/** Six sagging conductors along +Z, 1 m long. The caller stretches z to the real span, so x and y stay in metres. */
export function powerSpan(): MeshBuilder {
  const b = new MeshBuilder();
  b.jitter = 0;
  const wire = S.rubber(0x161616);
  const xs = [-4.6, 4.6, -6.2, 6.2, -7.2, 7.2];
  const ys = [23.9, 23.9, 18.6, 18.6, 13.6, 13.6];
  for (let i = 0; i < 6; i++) {
    const pts: [number, number, number][] = [];
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      pts.push([xs[i], ys[i] - Math.sin(t * Math.PI) * 1.3, t]);
    }
    b.pipe(pts, 0.03, wire, 3);
  }
  return b;
}

export function canopy(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  const r = rng(seed + 31);
  const roof = S.paint(0xcfc8b8, 0.6);
  const hgt = 5.0;
  b.rbox(0, hgt + 0.3, 0, 15, 0.6, 9.5, 0.06, roof);
  b.box(0, hgt + 0.3, 4.8, 15.2, 0.7, 0.18, S.paint(FADED[seed % FADED.length], 0.65));
  b.box(0, hgt + 0.3, -4.8, 15.2, 0.7, 0.18, S.paint(FADED[seed % FADED.length], 0.65));
  for (const x of [-6, 6]) for (const z of [-3, 3]) {
    b.rbox(x, hgt / 2, z, 0.55, hgt, 0.55, 0.05, S.concrete(0xa8a49a, 0.6));
  }
  // Collapsed corner on some canopies.
  if (r() > 0.55) b.rbox(6.5, hgt - 0.2, 3.2, 3.4, 0.4, 3.4, 0.04, roof, 0.15, 0.2, -0.3);
  b.box(0, hgt - 0.12, 0, 14, 0.1, 8.6, S.paint(0x4a4a46, 0.8));
  for (const x of [-4, 0, 4]) b.cyl(x, hgt - 0.2, 0, 0.3, 0.05, 0.3, S.glow(0xe8e0b0, 0.2), 0, 0, 0, 6);
  return b;
}

/** A highway section that crosses the road: columns clear of the carriageway, a deck above, one end snapped off. */
export function overpass(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  b.jitter = 0.05;
  const r = rng(seed + 41);
  const conc = S.concrete(0xa8a49a, 0.55);
  const dark = S.concrete(0x7c7a74, 0.6);
  const y0 = 6.0;
  const snap = r() > 0.5 ? 1 : -1;
  const xa = snap > 0 ? -34 : -26;
  const xb = snap > 0 ? 26 : 34;
  b.box((xa + xb) / 2, y0 + 0.5, 0, xb - xa, 1.0, 12, conc);
  for (const z of [-5, -1.7, 1.7, 5]) b.box((xa + xb) / 2, y0 - 0.45, z, xb - xa, 0.9, 0.5, dark);
  b.box((xa + xb) / 2, y0 + 1.4, 5.8, xb - xa, 0.8, 0.4, conc);
  b.box((xa + xb) / 2, y0 + 1.4, -5.8, xb - xa, 0.8, 0.4, conc);
  // Dashes along the deck and a missing rail section.
  for (let x = xa + 2; x < xb - 2; x += 5) b.box(x, y0 + 1.01, 0, 2.4, 0.02, 0.2, S.paint(0xe0d8a0, 0.8));
  b.box((xa + xb) / 2 + 6, y0 + 1.4, 5.8, 8, 0.9, 0.5, S.concrete(0x8a867c, 0.6));
  // Column bents.
  for (const x of [-15, 15]) {
    b.box(x, y0 - 1.1, 0, 2.2, 0.9, 12.4, conc);
    for (const z of [-4, 0, 4]) b.rbox(x, (y0 - 1.5) / 2, z, 1.6, y0 - 1.5, 1.6, 0.08, conc);
    b.box(x, 0.2, 0, 2.6, 0.4, 12.8, dark);
  }
  // Snapped end: tilted slab, rebar and rubble.
  const ex = snap > 0 ? xb : xa;
  b.rbox(ex - snap * 2.4, y0 - 1.3, 0, 5, 0.9, 11.6, 0.05, conc, 0, 0, -snap * 0.5);
  for (let i = 0; i < 9; i++) {
    const z = -5.2 + i * 1.3;
    b.pipe([[ex, y0 + 0.3, z], [ex + snap * (1.2 + r()), y0 - 0.2, z + (r() - 0.5) * 0.4], [ex + snap * (1.6 + r()), y0 - 1.6, z]], 0.018, S.rust(0x6a3a22), 4);
  }
  for (let i = 0; i < 7; i++) b.add('ico1', ex - snap * (3 + r() * 6), 0.4, (r() - 0.5) * 10, 1.5 + r() * 2, 0.8 + r() * 1.4, 1.2 + r() * 1.6, dark, 0, r() * 6, 0);
  b.groundShade(0, 1, 0.25);
  return b;
}

export function buildLandmark(kind: PropKind, seed: number, tag: number): MeshBuilder | null {
  switch (kind) {
    case 'waterTower':
      return waterTower(seed);
    case 'silo':
      return silo(seed);
    case 'windTurbine':
      return windTurbine(seed);
    case 'mast':
      return mast(seed);
    case 'billboard':
      return billboard(seed, tag);
    case 'gasSign':
      return gasSign(seed);
    case 'fuelTank':
      return fuelTank(seed);
    case 'windpump':
      return windpump(seed);
    case 'powerTower':
      return powerTower(seed);
    case 'powerSpan':
      return powerSpan();
    case 'overpass':
      return overpass(seed);
    case 'canopy':
      return canopy(seed);
    default:
      return buildLakeLandmark(kind, seed, tag);
  }
}

void C;

const cache = new Map<string, MeshBuilder | null>();
const _m = new THREE.Matrix4();
const _sh = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** The cached prototype for a landmark kind (4 variants by seed), or null when the kind draws nothing. */
export function landmarkProto(kind: PropKind, seed: number, tag = 0): MeshBuilder | null {
  const v = Math.abs(seed) % 4;
  const key = `${kind}:${v}:${tag}`;
  let proto = cache.get(key);
  if (proto === undefined) {
    proto = buildLandmark(kind, v + 1 + tag * 7, tag);
    cache.set(key, proto);
  }
  return proto;
}

/** Append one landmark prop into a merged builder. A power span's `scale` is its length in metres. */
export function appendLandmark(target: MeshBuilder, p: { kind: PropKind; x: number; y: number; z: number; yaw: number; scale: number; seed: number; tag?: number; dy?: number }) {
  const proto = landmarkProto(p.kind, p.seed, p.tag ?? 0);
  if (!proto) return;
  if (p.kind === 'powerSpan') {
    _p.set(p.x, p.y, p.z);
    _q.setFromAxisAngle(UP, p.yaw);
    _s.set(1, 1, 1);
    _m.compose(_p, _q, _s).multiply(_sh.set(1, 0, 0, 0, 0, 1, p.dy ?? 0, 0, 0, 0, p.scale, 0, 0, 0, 0, 1));
    target.appendMatrix(proto, _m);
  } else target.append(proto, p.x, p.y, p.z, p.yaw, p.scale);
}
