import { buildPartModel } from './partModels';
import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { C } from './palette';
import { shared } from './dispose';
import { kitMaterial } from './materials';
import { crate, drum, jerryCan, oilCan, spareTyre, strap } from './parts';
import type { PropKind, PropSpawn } from '../world/layout';
import { partDef } from '../data';
import { engineDims } from '../sim/engineSize';

/**
 * World props, built once per (kind, variant, tag) as prototypes and appended into each chunk's merged mesh.
 * Local frame: ground at y = 0, +Z forward, metres.
 */

const protoCache = new Map<string, MeshBuilder>();

/** Tag colours for signs and markers. */
const TAG_COL: Record<number, number> = {
  1: C.chassis,
  2: C.gold,
  3: C.fragment,
  4: C.raiderFlag,
  5: 0xe0832a,
  6: 0x3fbf6a,
  7: 0xd94a4a,
  // The car trades: a garage, a dealership, a tyre shop, a warehouse, the police.
  8: 0xe05a1a,
  9: 0x3a7bd8,
  10: 0xe8c020,
  11: 0x8a8e92,
  12: 0x3a4a9a,
};

function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ------------------------------------------------------------------------------------------ nature

/** Weathered sandstone boulder: lumpy mass split by bedding planes, faceted. */
function rockProto(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  b.jitter = 0.07;
  const r = rng(seed + 3);
  const tones = [0x9a6a4e, 0x8a6248, 0xa47c5a, 0x7e5c46];
  const base = tones[seed % 4];
  b.add('ico2', 0, 0.38, 0, 1.8 + r() * 0.7, 1.15 + r() * 0.45, 1.5 + r() * 0.7, S.rock(base), 0, r() * 6, 0);
  if (r() > 0.3) b.add('ico2', 0.75, 0.22, 0.45, 0.95, 0.62, 0.85, S.rock(tones[(seed + 1) % 4]), r() * 0.3, r() * 6, 0);
  if (r() > 0.45) b.add('ico1', -0.7, 0.12, -0.5, 0.6, 0.38, 0.55, S.rock(tones[(seed + 2) % 4]), 0, r() * 6, 0);
  b.displace(0.3, 1.7, seed + 11);
  b.terrace(0.2, 1.5);
  b.flatNormals();
  return b;
}

/** Gnarled dead tree: a leaning trunk that forks two or three times into bare, broken branches. */
function deadTreeProto(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  b.jitter = 0.08;
  const r = rng(seed + 7);
  const bark = S.wood(0x5a4b3e, 0.35);
  const dead = S.wood(0x7a6a58, 0.3);
  const branch = (x: number, y: number, z: number, dx: number, dy: number, dz: number, len: number, rad: number, depth: number) => {
    const m = Math.hypot(dx, dy, dz);
    dx /= m;
    dy /= m;
    dz /= m;
    // Two-segment limb with a kink, so branches look grown rather than straight.
    const kx = x + dx * len * 0.5 + (r() - 0.5) * len * 0.15;
    const ky = y + dy * len * 0.5;
    const kz = z + dz * len * 0.5 + (r() - 0.5) * len * 0.15;
    const ex = x + dx * len;
    const ey = y + dy * len;
    const ez = z + dz * len;
    const c = depth > 1 ? dead : bark;
    b.limb(x, y, z, kx, ky, kz, rad, rad * 0.85, c, depth > 1 ? 5 : 8, true);
    b.limb(kx, ky, kz, ex, ey, ez, rad * 0.85, rad * 0.68, c, depth > 1 ? 5 : 8, true);
    if (depth >= 3 || rad < 0.02) return;
    const n = depth === 0 ? 3 : 2 + (r() > 0.6 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2;
      const spread = 0.55 + r() * 0.5;
      const ndx = dx + Math.cos(a) * spread;
      const ndy = dy * 0.7 + 0.35 + r() * 0.2;
      const ndz = dz + Math.sin(a) * spread;
      // Some limbs snapped off short.
      const snapped = depth > 0 && r() < 0.25;
      branch(ex, ey, ez, ndx, ndy, ndz, len * (snapped ? 0.3 : 0.62 + r() * 0.15), rad * 0.62, snapped ? 3 : depth + 1);
    }
  };
  b.frustum(0, 0.12, 0, 0.18, 0.3, 0.26, bark, 0, 0, 0, 9);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + r();
    b.limb(0, 0.12, 0, Math.cos(a) * 0.55, -0.05, Math.sin(a) * 0.55, 0.08, 0.03, bark, 6, true);
  }
  branch(0, 0.1, 0, (r() - 0.5) * 0.3, 1, (r() - 0.5) * 0.3, 2.1 + r() * 0.6, 0.17, 0);
  return b;
}

function cairnProto(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  const r = rng(seed);
  let y = 0;
  const sizes = [0.95, 0.72, 0.55, 0.38];
  sizes.forEach((s, i) => {
    const h = s * 0.55;
    b.add('ico1', (r() - 0.5) * 0.08, y + h * 0.45, (r() - 0.5) * 0.08, s, h, s * 0.9, S.rock(i % 2 ? C.cairn : 0xd8d2c4), 0, r() * 6, 0);
    y += h * 0.82;
  });
  b.displace(0.06, 4, seed);
  b.flatNormals();
  b.rod(0, y - 0.1, 0, 0.04, y + 0.9, 0, 0.022, S.wood(0x4a3a2a), 6);
  b.extrude('cairnRag', () => {
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.lineTo(0.32, -0.04);
    s.lineTo(0.26, -0.12);
    s.lineTo(0.34, -0.22);
    s.lineTo(0, -0.24);
    s.closePath();
    return s;
  }, 0.01, 0, 0.04, y + 0.86, 0, S.cloth(C.raiderRed, 0.6), 0, 0.3, 0);
  return b;
}

function bonesProto(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  const bone = S.skin(C.bone);
  // Skull, a rib cage half buried, scattered long bones.
  b.add('sphere16', 0.5, 0.1, 0.3, 0.2, 0.17, 0.22, bone, 0.3, 0.6, 0.4);
  b.add('sphere', 0.53, 0.1, 0.4, 0.05, 0.04, 0.03, S.skin(0x2a2018));
  b.add('sphere', 0.47, 0.1, 0.4, 0.05, 0.04, 0.03, S.skin(0x2a2018));
  for (let i = 0; i < 6; i++) b.torus(-0.1 + i * 0.09, 0.08, 0, 0.16 - Math.abs(i - 2.5) * 0.015, 0.012, bone, 0, Math.PI / 2, 0, 5, 10);
  b.rod(-0.15, 0.05, 0, 0.42, 0.05, 0, 0.018, bone, 6);
  b.capsule(-0.5, 0.04, 0.2, -0.05, 0.04, 0.5, 0.025, bone, 6);
  b.capsule(-0.3, 0.04, -0.4, 0.15, 0.04, -0.25, 0.022, bone, 6);
  return b;
}

// ------------------------------------------------------------------------------------------ cars

const CAR_PAINT = [0x8a4b2d, 0xb3a68a, 0x5d7a8a, 0x6b6e5a, 0xc8c3b6, 0x7a2e26];

/** Abandoned car, four body styles: sedan, pickup, van, hatchback. Missing wheels, broken glass, rust. */
function wreckProto(seed: number, tag: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  b.jitter = 0.03;
  const r = rng(seed + 31);
  const style = seed % 4;
  const col = CAR_PAINT[(seed + tag) % CAR_PAINT.length];
  const body = S.paint(col, 0.95);
  const rust = S.rust(C.rust);
  const trim = S.metal(0x6a6c6e, 0.9);
  const glass = S.glass(0x26323a);
  const black = S.plastic(0x161616, 0.7);
  const broken = style % 2 === 1;
  const L = style === 3 ? 3.7 : style === 2 ? 4.6 : 4.3;
  const W = style === 2 ? 1.9 : 1.76;
  const roof = style === 2 ? 1.95 : style === 3 ? 1.45 : 1.42;
  const hz = L / 2;
  const sill = 0.34;
  const belt = style === 2 ? 1.05 : 0.92;
  // Lower body shell with dark wheel wells.
  b.rbox(0, (sill + belt) / 2, 0, W, belt - sill, L, 0.13, body);
  const axle = [hz - 0.85, -hz + 0.85];
  for (const z of axle) for (const sx of [1, -1]) b.cyl(sx * (W / 2 - 0.12), 0.38, z, 0.78, 0.28, 0.78, S.metal(0x0e0e0e, 0.2), 0, 0, Math.PI / 2, 16);
  // Hood, cabin, roof and trunk per style.
  const cabF = style === 2 ? hz - 0.9 : hz - 1.55;
  const cabR = style === 1 ? -0.55 : style === 2 ? -hz + 0.15 : style === 3 ? -hz + 0.25 : -hz + 1.0;
  b.rbox(0, belt + 0.02, (hz + cabF) / 2 + 0.05, W - 0.08, 0.1, hz - cabF, 0.05, body, -0.05, 0, 0);
  const cabH = roof - belt;
  if (broken) {
    // Glass gone: frame, roof and the interior show.
    for (const sx of [1, -1]) {
      b.rod(sx * (W / 2 - 0.08), belt, cabF, sx * (W / 2 - 0.12), roof - 0.04, cabF - 0.42, 0.035, body, 6);
      b.rod(sx * (W / 2 - 0.08), belt, (cabF + cabR) / 2, sx * (W / 2 - 0.1), roof - 0.04, (cabF + cabR) / 2, 0.04, body, 6);
      b.rod(sx * (W / 2 - 0.08), belt, cabR, sx * (W / 2 - 0.12), roof - 0.04, cabR + (style === 2 ? 0 : 0.35), 0.04, body, 6);
    }
    b.rbox(0, belt + 0.08, cabF - 0.2, W - 0.3, 0.16, 0.3, 0.04, black);
    for (const sx of [1, -1]) {
      b.rbox(sx * 0.4, belt - 0.05, (cabF + cabR) / 2 + 0.25, 0.5, 0.14, 0.5, 0.05, S.leather(0x3a3228, 0.8));
      b.rbox(sx * 0.4, belt + 0.25, (cabF + cabR) / 2 - 0.05, 0.5, 0.55, 0.12, 0.05, S.leather(0x3a3228, 0.8), 0.15, 0, 0);
    }
    b.torus(0.4, belt + 0.25, cabF - 0.32, 0.17, 0.018, black, -1.0, 0, 0, 6, 14);
  } else {
    b.rbox(0, belt + cabH / 2, (cabF + cabR) / 2, W - 0.16, cabH, cabF - cabR, 0.16, glass);
    // Pillars over the glass.
    for (const sx of [1, -1]) {
      b.box(sx * (W / 2 - 0.075), belt + cabH / 2, (cabF + cabR) / 2, 0.03, cabH * 0.98, 0.1, body);
      b.box(sx * (W / 2 - 0.075), belt + cabH / 2, cabR + 0.1, 0.03, cabH * 0.98, 0.22, body);
    }
    // Spider cracks on the windscreen.
    for (let i = 0; i < 3; i++) b.box((r() - 0.5) * 0.8, belt + cabH * 0.55, cabF + 0.02, 0.4, 0.006, 0.004, S.paint(0xd0d6da, 0.1), -0.6, 0, r() * 3);
  }
  b.rbox(0, roof, (cabF + cabR) / 2 - 0.05, W - 0.22, 0.06, cabF - cabR - (style === 2 ? 0.1 : 0.45), 0.04, body);
  if (style === 1) {
    // Pickup bed with rusted sides.
    const bedLen = cabR + hz;
    b.box(0, belt - 0.05, (cabR - hz) / 2, W - 0.12, 0.05, bedLen - 0.1, rust);
    for (const sx of [1, -1]) b.rbox(sx * (W / 2 - 0.04), belt + 0.15, (cabR - hz) / 2, 0.05, 0.36, bedLen, 0.01, body);
    b.rbox(0, belt + 0.15, -hz + 0.03, W - 0.1, 0.36, 0.05, 0.01, rust);
    spareTyre(b, 0.2, belt + 0.1, (cabR - hz) / 2, 0.32, 0.18, 0, 0);
  } else if (style === 0) {
    b.rbox(0, belt + 0.03, -hz + 0.42, W - 0.1, 0.1, 0.8, 0.05, body);
  }
  // Bumpers, grille, lamps, plate, mirrors.
  b.rbox(0, 0.42, hz + 0.04, W + 0.04, 0.16, 0.12, 0.05, r() > 0.5 ? trim : rust);
  b.rbox(0, 0.42, -hz - 0.04, W + 0.04, 0.16, 0.12, 0.05, trim);
  b.rbox(0, 0.68, hz - 0.01, W * 0.5, 0.2, 0.04, 0.02, black);
  for (const sx of [1, -1]) {
    b.rbox(sx * (W / 2 - 0.25), 0.7, hz - 0.02, 0.32, 0.14, 0.05, 0.03, broken ? black : S.glass(0x8a9298));
    b.rbox(sx * (W / 2 - 0.2), 0.78, -hz + 0.01, 0.26, 0.12, 0.04, 0.02, S.plastic(0x5a1410, 0.4));
    b.rbox(sx * (W / 2 + 0.06), belt + 0.08, cabF - 0.15, 0.06, 0.1, 0.16, 0.02, black);
  }
  b.box(0, 0.62, -hz - 0.02, 0.4, 0.12, 0.01, S.paint(0xd8cf9a, 0.95));
  // Door ajar on some.
  if (r() > 0.6) {
    const dz = (cabF + cabR) / 2 + 0.3;
    b.rbox(W / 2 + 0.35, (sill + belt) / 2 + 0.15, dz + 0.3, 0.06, belt - sill + 0.25, 1.0, 0.03, body, 0, 0.75, 0);
  }
  // Wheels: rims on the ground where tyres are gone.
  for (const z of axle) {
    for (const sx of [1, -1]) {
      const k = r();
      if (k < 0.3) continue;
      const flat = k < 0.55;
      const x = sx * (W / 2 - 0.12);
      if (flat) b.cyl(x, 0.24, z, 0.45, 0.12, 0.45, S.metal(0x3a3632, 0.95), 0, 0, Math.PI / 2, 12);
      else {
        b.torus(x, 0.33, z, 0.25, 0.1, S.rubber(0x1d1d1d), 0, Math.PI / 2, 0, 8, 18);
        b.cyl(x + sx * 0.03, 0.33, z, 0.3, 0.12, 0.3, S.metal(0x5a5c5e, 0.85), 0, 0, Math.PI / 2, 12);
      }
    }
  }
  if (tag === 5) {
    // Encounter marker: bright scarf on the antenna.
    b.rod(-0.6, roof, cabR + 0.2, -0.62, roof + 1.2, cabR + 0.2, 0.01, S.metal(0x2a2a2a), 6);
    b.extrude('scarf', () => {
      const s = new THREE.Shape();
      s.moveTo(0, 0);
      s.lineTo(0.4, -0.06);
      s.lineTo(0.32, -0.16);
      s.lineTo(0, -0.18);
      s.closePath();
      return s;
    }, 0.01, 0, -0.62, roof + 1.18, cabR + 0.2, S.cloth(C.raiderFlag, 0.4), 0, 0.5, 0);
  }
  b.groundShade(0, 0.5, 0.35);
  return b;
}

// ------------------------------------------------------------------------------------------ roadside

function poleProto(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  const r = rng(seed + 5);
  const wood = S.wood(0x5c4632, 0.55);
  b.frustum(0, 3.6, 0, 0.11, 0.15, 7.2, wood, 0, 0, 0, 10);
  b.rbox(0, 6.6, 0, 2.1, 0.13, 0.12, 0.02, wood);
  for (const sx of [1, -1]) b.rod(sx * 0.65, 6.55, 0, 0, 6.05, 0, 0.022, S.steel(0x4a4846), 6);
  const ins = [-0.88, -0.32, 0.32, 0.88];
  for (const x of ins) {
    b.rod(x, 6.66, 0, x, 6.78, 0, 0.012, S.steel(), 6);
    b.frustum(x, 6.82, 0, 0.032, 0.05, 0.12, S.glass(0x4f8a6e), 0, 0, 0, 10);
  }
  // Step bolts.
  for (let i = 0; i < 6; i++) b.rod(0, 2.2 + i * 0.6, 0, (i % 2 ? 0.25 : -0.25), 2.2 + i * 0.6, 0.02, 0.01, S.steel(), 6);
  if (seed % 3 === 0) {
    b.cyl(0.32, 5.6, 0, 0.42, 0.7, 0.42, S.paint(0x6e7276, 0.8), 0, 0, 0, 14);
    b.rod(0.12, 5.6, 0, 0.12, 5.9, 0, 0.03, S.steel(), 6);
  }
  // Cut wires hanging from the insulators.
  for (const x of ins) {
    if (r() < 0.4) continue;
    const dir = r() > 0.5 ? 1 : -1;
    const len = 2 + r() * 3;
    const pts: [number, number, number][] = [];
    for (let k = 0; k <= 6; k++) {
      const t = k / 6;
      pts.push([x + (r() - 0.5) * 0.05, 6.86 - Math.sin(t * Math.PI * 0.5) * len, dir * t * 0.6]);
    }
    b.pipe(pts, 0.008, S.rubber(0x111111), 5);
  }
  return b;
}

function signProto(seed: number, tag: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  const r = rng(seed + 9);
  const c = TAG_COL[tag] ?? C.signYellow;
  const tilt = (r() - 0.5) * 0.12;
  b.rod(0, 0, 0, tilt * 0.5, 2.95, 0, 0.04, S.metal(0x8a8e90, 0.55), 10);
  const py = 2.55;
  b.rbox(tilt * 0.4, py, 0.05, 1.42, 0.98, 0.03, 0.04, S.paint(0xd8d4c8, 0.6), 0, 0, tilt);
  b.rbox(tilt * 0.4, py, 0.067, 1.3, 0.86, 0.01, 0.03, S.paint(c, 0.65), 0, 0, tilt);
  // A chevron symbol and a band of text-like blocks.
  for (let i = 0; i < 3; i++) b.box(-0.3 + i * 0.3 + tilt * 0.4, py + 0.12, 0.075, 0.08, 0.4, 0.008, S.paint(0x161616, 0.4), 0, 0, 0.55);
  for (let i = 0; i < 5; i++) b.box(-0.4 + i * 0.2 + tilt * 0.4, py - 0.26, 0.075, 0.14, 0.08, 0.008, S.paint(0x161616, 0.4));
  // Bullet holes.
  for (let i = 0; i < 7; i++) b.add('sphere', (r() - 0.5) * 1.1, py + (r() - 0.5) * 0.7, 0.08, 0.03, 0.03, 0.01, S.metal(0x2a2622, 0.9));
  b.rod(-0.4, py, 0.0, 0.0, py, 0.0, 0.018, S.steel(), 6);
  return b;
}

function pylonProto(tag: number): MeshBuilder {
  const b = new MeshBuilder();
  const c = TAG_COL[tag] ?? C.fragment;
  const steel = S.paint(0x8a8e92, 0.75);
  const H = 7.4;
  const legs: [number, number][] = [[0.7, 0.7], [-0.7, 0.7], [-0.7, -0.7], [0.7, -0.7]];
  const at = (k: number, t: number): [number, number, number] => [legs[k][0] * (1 - t * 0.8), t * H, legs[k][1] * (1 - t * 0.8)];
  for (let k = 0; k < 4; k++) b.rod(...at(k, 0), ...at(k, 1), 0.04, steel, 6);
  for (let i = 0; i < 6; i++) {
    const t0 = i / 6;
    const t1 = (i + 1) / 6;
    for (let k = 0; k < 4; k++) {
      const n = (k + 1) % 4;
      b.rod(...at(k, t0), ...at(n, t1), 0.015, steel, 5);
      b.rod(...at(n, t0), ...at(k, t1), 0.015, steel, 5);
      b.rod(...at(k, t1), ...at(n, t1), 0.018, steel, 5);
    }
  }
  b.lathe('dish', [[0.0, 0.0], [0.25, 0.04], [0.45, 0.14], [0.5, 0.2]], 0.3, 5.2, 0.2, S.paint(0xd8d8d0, 0.5), Math.PI / 2 - 0.3, 0, 0, 18);
  b.rod(0, H, 0, 0, H + 1.2, 0, 0.02, steel, 6);
  b.sphereAt(0, H + 1.25, 0, 0.12, S.glow(c, 5));
  b.rbox(0, 0.45, 0.0, 0.7, 0.9, 0.5, 0.05, S.paint(0x55605a, 0.8));
  b.rbox(0, 0.62, 0.26, 0.3, 0.2, 0.02, 0.01, S.glow(c, 1.5));
  return b;
}

function chainProto(): MeshBuilder {
  const b = new MeshBuilder();
  const steel = S.steel(0x4a4c4e, 0.8);
  for (const x of [-6, 6]) {
    b.rod(x, 0, 0, x, 1.4, 0, 0.08, S.paint(0x2c2a28, 0.8), 10);
    b.rbox(x, 0.08, 0, 0.5, 0.16, 0.5, 0.04, S.concrete(C.concreteDark));
  }
  // Sagging steel cable with red rags.
  const pts: [number, number, number][] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    pts.push([-6 + t * 12, 1.3 - Math.sin(t * Math.PI) * 0.45, 0]);
  }
  b.pipe(pts, 0.018, steel, 6);
  for (let i = -5; i <= 5; i += 2) {
    const sag = 1.3 - Math.sin(((i + 6) / 12) * Math.PI) * 0.45;
    b.box(i, sag - 0.25, 0, 0.5, 0.45, 0.02, S.cloth(C.raiderRed, 0.7), 0, 0, (i % 3) * 0.1);
  }
  // Spike strip across the lane.
  b.box(0, 0.025, 0.9, 11, 0.04, 0.18, steel);
  for (let i = 0; i < 44; i++) b.add('cone6', -5.4 + i * 0.25, 0.1, 0.9 + (i % 2 ? 0.04 : -0.04), 0.05, 0.14, 0.05, S.steel(0x9a9ea2, 0.4));
  return b;
}

function bannerProto(tag: number): MeshBuilder {
  const b = new MeshBuilder();
  const c = TAG_COL[tag] ?? C.raiderFlag;
  b.rod(0, 0, 0, 0.05, 4.2, 0, 0.05, S.wood(0x3a2a1e), 8);
  b.rod(0, 3.9, 0, 1.3, 3.95, 0, 0.025, S.wood(0x3a2a1e), 6);
  b.extrude('banner', () => {
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.lineTo(1.25, 0);
    s.lineTo(1.2, -0.6);
    s.lineTo(1.25, -1.15);
    s.lineTo(1.05, -1.0);
    s.lineTo(0.85, -1.3);
    s.lineTo(0.6, -1.05);
    s.lineTo(0.35, -1.35);
    s.lineTo(0.15, -1.08);
    s.lineTo(0, -1.25);
    s.closePath();
    return s;
  }, 0.015, 0, 0.05, 3.92, 0, S.cloth(c, 0.7));
  // Painted skull.
  b.add('sphere16', 0.62, 3.45, 0.02, 0.36, 0.34, 0.04, S.paint(0x161412, 0.4));
  b.box(0.62, 3.22, 0.02, 0.2, 0.12, 0.04, S.paint(0x161412, 0.4));
  for (const sx of [-0.09, 0.09]) b.add('sphere', 0.62 + sx, 3.48, 0.045, 0.09, 0.08, 0.02, S.cloth(c, 0.7));
  spareTyre(b, 0.3, 0.12, 0.2, 0.36, 0.2, 0, 0);
  return b;
}

// ------------------------------------------------------------------------------------------ salvage

function tiresProto(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  const r = rng(seed);
  for (let i = 0; i < 3; i++) spareTyre(b, (r() - 0.5) * 0.12, 0.12 + i * 0.25, (r() - 0.5) * 0.12, 0.45, 0.24, 0, r() * 3);
  // One leaning against the stack.
  spareTyre(b, 0.62, 0.42, 0.1, 0.42, 0.22, Math.PI / 2 - 0.25, 1.4);
  return b;
}

function barrelProto(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  const cols = [C.rust, 0x3a5f8a, 0xc8a02a, 0x4a5a3a];
  drum(b, 0, 0, 0, cols[seed % 4]);
  if (seed % 2) drum(b, 0.7, 0.3, 0.1, cols[(seed + 1) % 4], 0.88, 0.29, Math.PI / 2);
  return b;
}

function tarpProto(seed: number, tag: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  const c = tag === 1 ? C.tarp : 0x6a6a52;
  const start = b.vertexCount;
  // A vehicle shape under a draped tarp: lumpy, sagging between the high points.
  b.rbox(0, 0.62, 0, 1.75, 1.15, 3.3, 0.3, S.cloth(c, 0.55), 0, 0, 0, 4);
  b.rbox(0, 1.25, -0.3, 1.4, 0.4, 1.6, 0.2, S.cloth(c, 0.55), 0, 0, 0, 4);
  b.displace(0.12, 2.2, seed, start);
  // Ropes and stakes.
  for (const z of [-1.2, 0, 1.2]) {
    b.rod(0.9, 1.0, z, 1.4, 0.0, z, 0.01, S.cloth(0xb8a878, 0.5), 5);
    b.rod(-0.9, 1.0, z, -1.4, 0.0, z, 0.01, S.cloth(0xb8a878, 0.5), 5);
    b.rod(1.4, 0.0, z, 1.42, 0.2, z, 0.025, S.wood(0x4a3a2a), 6);
    b.rod(-1.4, 0.0, z, -1.42, 0.2, z, 0.025, S.wood(0x4a3a2a), 6);
  }
  // Wheels peeking out.
  for (const z of [-1.1, 1.1]) for (const sx of [1, -1]) b.torus(sx * 0.82, 0.34, z, 0.24, 0.1, S.rubber(), 0, Math.PI / 2, 0, 8, 16);
  return b;
}

function crateStackProto(seed: number, tag: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  crate(b, 0, 0.5, 0, 1.0, 1.0, 1.0, 0);
  crate(b, 1.05, 0.45, 0.2, 0.9, 0.9, 0.9, 0.2, C.woodDark);
  crate(b, 0.45, 1.42, 0.12, 0.85, 0.85, 0.85, 0.45);
  jerryCan(b, -0.75, 0, 0.3, C.fuel, 0.4);
  // Tag-coloured cover sheet over the top crate.
  const s0 = b.vertexCount;
  b.rbox(0.45, 1.88, 0.12, 1.0, 0.06, 1.0, 0.03, S.cloth(TAG_COL[tag] ?? C.gold, 0.4), 0, 0.45, 0, 3);
  b.displace(0.05, 5, seed, s0);
  strap(b, [[-0.05, 1.0, 0.12], [-0.05, 1.86, 0.12], [0.95, 1.86, 0.12], [0.95, 1.0, 0.12]]);
  return b;
}

function shelfProto(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  const r = rng(seed + 13);
  const frame = S.paint(0x3a4a44, 0.7);
  for (const x of [-0.24, 0.24]) for (const z of [-0.72, 0.72]) b.box(x, 0.95, z, 0.04, 1.9, 0.04, frame);
  const goods = [0xe8e0cc, 0x6ab07a, 0xd9a050, 0xc84d4d, 0x4a7ab0, 0xd8d0b0];
  for (let i = 0; i < 4; i++) {
    const y = 0.32 + i * 0.5;
    b.box(0, y, 0, 0.5, 0.03, 1.48, S.metal(0x8a8e90, 0.7));
    for (let j = 0; j < 7; j++) {
      if (r() < 0.35) continue;
      const z = -0.6 + j * 0.2;
      const g = goods[Math.floor(r() * goods.length)];
      const k = r();
      if (k < 0.4) b.cyl(0, y + 0.09, z, 0.12, 0.16, 0.12, S.metal(g, 0.4), 0, 0, 0, 10);
      else if (k < 0.7) b.rbox(0, y + 0.12, z, 0.22, 0.2, 0.14, 0.01, S.paint(g, 0.5), 0, r() * 0.5, 0);
      else b.frustum(0, y + 0.13, z, 0.03, 0.05, 0.24, S.glass(g), 0, 0, 0, 8);
    }
  }
  // A toppled box on the floor.
  b.rbox(0.35, 0.1, 0.2, 0.3, 0.2, 0.22, 0.01, S.paint(goods[seed % goods.length], 0.6), 0, 0.6, 0.3);
  return b;
}

function lockerProto(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  const paint = S.paint([0x5a6a5c, 0x6a6e72, 0x4a5a6a][seed % 3], 0.7);
  b.rbox(0, 0.9, 0, 0.65, 1.8, 1.4, 0.03, paint);
  for (const z of [-0.35, 0.35]) {
    b.box(0.33, 0.9, z, 0.02, 1.68, 0.64, paint);
    for (let i = 0; i < 4; i++) b.box(0.345, 1.55 - i * 0.05, z, 0.01, 0.02, 0.4, S.metal(0x1a1a1a, 0.6));
    b.box(0.35, 0.95, z + 0.24, 0.03, 0.14, 0.03, S.chrome(0x9a9a9a));
  }
  // One door hanging open.
  if (seed % 2) b.box(0.62, 0.9, -0.62, 0.02, 1.68, 0.64, paint, 0, -1.1, 0);
  return b;
}

function dumpsterProto(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  const paint = S.paint([0x3a5a44, 0x4a4a52, 0x7a5a2a][seed % 3], 0.85);
  b.rbox(0, 0.75, 0, 1.5, 1.2, 2.4, 0.06, paint);
  b.rbox(0, 1.38, -0.15, 1.56, 0.06, 2.1, 0.02, S.plastic(0x1e2a22, 0.6), seed % 2 ? 0.35 : 0.04, 0, 0);
  for (const z of [-1.0, 1.0]) for (const x of [-0.6, 0.6]) b.cyl(x, 0.08, z, 0.16, 0.08, 0.16, S.rubber(), 0, 0, Math.PI / 2, 10);
  for (const sx of [1, -1]) b.rbox(sx * 0.8, 0.9, 0, 0.1, 0.12, 2.0, 0.02, paint);
  // Trash bags spilling over.
  for (let i = 0; i < 3; i++) b.add('ico1', -0.4 + i * 0.4, 1.35, 0.85 + (i % 2) * 0.2, 0.5, 0.4, 0.45, S.plastic(0x1a1c1a, 0.4), 0, i, 0);
  return b;
}

function streetlightProto(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  const metal = S.paint(0x4a4e52, 0.75);
  b.rbox(0, 0.06, 0, 0.42, 0.12, 0.42, 0.03, S.concrete(C.concrete));
  b.frustum(0, 3.6, 0, 0.07, 0.12, 7.2, metal, 0, 0, 0, 12);
  b.pipe([[0, 7.1, 0], [0.3, 7.35, 0], [1.2, 7.45, 0], [1.75, 7.4, 0]], 0.05, metal, 8);
  b.rbox(1.85, 7.32, 0, 0.62, 0.14, 0.3, 0.05, metal);
  // Most heads are dead; a few still burn (they glow brighter at night).
  const live = seed % 3 === 0;
  b.rbox(1.85, 7.24, 0, 0.5, 0.03, 0.22, 0.02, live ? S.glow(0xffc070, 0.9) : S.glass(0x3a3a34));
  b.box(0, 3.0, 0.08, 0.2, 0.32, 0.02, S.paint(0xc8b860, 0.9));
  return b;
}

function rubbleProto(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  const r = rng(seed + 17);
  const s0 = b.vertexCount;
  for (let i = 0; i < 6; i++) {
    const w = 0.5 + r() * 0.8;
    b.rbox((r() - 0.5) * 1.8, 0.15 + r() * 0.35, (r() - 0.5) * 1.4, w, 0.18 + r() * 0.2, w * (0.6 + r() * 0.6), 0.04, S.concrete(r() > 0.5 ? C.concrete : C.concreteDark, 0.7), r() * 0.6, r() * 6, r() * 0.5, 1);
  }
  for (let i = 0; i < 5; i++) b.add('ico1', (r() - 0.5) * 2, 0.08, (r() - 0.5) * 1.6, 0.3, 0.2, 0.3, S.concrete(C.concreteDark), 0, r() * 6, 0);
  b.displace(0.05, 6, seed, s0);
  // Rebar sticking out, bricks.
  for (let i = 0; i < 4; i++) {
    const x = (r() - 0.5) * 1.2;
    const z = (r() - 0.5) * 1.0;
    b.pipe([[x, 0.2, z], [x + (r() - 0.5) * 0.3, 0.8 + r() * 0.5, z + (r() - 0.5) * 0.3], [x + (r() - 0.5) * 0.6, 1.0 + r() * 0.4, z + (r() - 0.5) * 0.4]], 0.012, S.rust(0x6a3a22), 5);
  }
  for (let i = 0; i < 6; i++) b.rbox((r() - 0.5) * 2.2, 0.05, (r() - 0.5) * 1.8, 0.22, 0.07, 0.1, 0.01, S.concrete(0x8a4a36, 0.6), 0, r() * 3, 0);
  return b;
}

// ------------------------------------------------------------------------------------------ settlements

function pumpProto(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  const r = rng(seed + 61);
  const body = S.paint([0xb83a2a, 0xc8a03a, 0x5a7a8a, 0xcfc8b8][seed % 4], 0.7);
  b.rbox(0, 0.06, 0, 0.9, 0.12, 0.6, 0.02, S.concrete(0x8a8882, 0.6));
  b.rbox(0, 0.78, 0, 0.55, 1.4, 0.38, 0.04, body);
  b.rbox(0, 1.25, 0.2, 0.42, 0.3, 0.03, 0.01, S.glass(0x16202a));
  b.rbox(0, 1.55, 0, 0.62, 0.14, 0.44, 0.04, S.steel(0x4a4a48, 0.7));
  if (r() > 0.35) b.pipe([[0.28, 0.8, 0], [0.5, 0.7, 0.1], [0.55, 0.3 + r() * 0.2, 0.2], [0.5, 0.05, 0.3]], 0.025, S.rubber(0x1a1a1a), 5);
  b.groundShade(0, 0.3, 0.3);
  return b;
}

const CONTAINER = [0x8a3a2c, 0x2f5a7a, 0x4a6a4a, 0xa8842c, 0x6a6a68, 0x7a4a2c];
function containerProto(seed: number, tag: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  const r = rng(seed + 71);
  const c = CONTAINER[(seed + tag) % CONTAINER.length];
  const paint = S.paint(c, 0.9);
  b.box(0, 1.35, 0, 2.44, 2.5, 6.06, paint);
  for (let z = -2.8; z <= 2.8; z += 0.35) b.box(1.23, 1.35, z, 0.05, 2.3, 0.12, paint);
  for (let z = -2.8; z <= 2.8; z += 0.35) b.box(-1.23, 1.35, z, 0.05, 2.3, 0.12, paint);
  for (const x of [-1.15, 1.15]) for (const z of [-2.95, 2.95]) b.box(x, 1.35, z, 0.16, 2.6, 0.16, S.steel(0x3a3c3c, 0.8));
  b.box(0, 0.08, 0, 2.3, 0.16, 6.0, S.steel(0x2a2a28, 0.8));
  // Doors at the back with locking bars; rust bloom on the sunny side.
  b.box(0, 1.3, 3.03, 2.3, 2.3, 0.05, S.paint(c, 0.85));
  for (const x of [-0.5, 0.5]) b.rod(x, 0.3, 3.08, x, 2.3, 3.08, 0.02, S.steel(0x7a7a78, 0.5), 5);
  b.add('ico1', r() > 0.5 ? 1.2 : -1.2, 1.2, (r() - 0.5) * 3, 0.1, 1.2, 2.2, S.rust(0x7a4a2a), 0, 0, 0);
  b.groundShade(0, 0.5, 0.25);
  return b;
}

function fenceProto(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  const r = rng(seed + 81);
  const post = S.steel(0x5a5a58, 0.7);
  for (let i = 0; i <= 4; i++) b.rod(i * 2 - 4, 0, 0, i * 2 - 4, 1.9, 0, 0.04, post, 5);
  b.rod(-4, 1.85, 0, 4, 1.85, 0, 0.025, post, 4);
  // Torn chain-link: a thin pale panel with gaps.
  for (let i = 0; i < 4; i++) {
    if (r() < 0.25) continue;
    b.box(i * 2 - 3, 0.95, 0, 1.9, 1.7, 0.012, S.metal(0x9a9c98, 0.6), 0, 0, (r() - 0.5) * 0.08);
  }
  b.groundShade(0, 0.3, 0.2);
  return b;
}


// ------------------------------------------------------------------------------------------ civic

/** A round stone fountain basin with a pedestal, standing in stagnant water. About 3.4 m radius. */
function fountainProto(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  const stone = S.concrete(0xc6c1b3, 0.18);
  const dark = S.concrete(0x9a968b, 0.3);
  b.lathe('fountainBasin', [[3.4, 0], [3.4, 0.78], [3.28, 0.95], [3.05, 0.95], [2.95, 0.8], [2.95, 0.5], [0, 0.5]], 0, 0, 0, stone, 0, 0, 0, 28);
  b.cyl(0, 0.78, 0, 5.9, 0.02, 5.9, S.glass(0x2f4a3e), 0, 0, 0, 20);
  // Pedestal, two bowls and a spout; the top bowl has cracked.
  b.frustum(0, 1.2, 0, 0.5, 0.8, 1.4, stone, 0, 0, 0, 14);
  b.lathe('fountainBowl', [[1.3, 0], [1.3, 0.12], [0.2, 0.3], [0.2, 0.55], [0, 0.55]], 0, 1.75, 0, stone, 0, 0, 0, 20);
  b.rod(0, 2.1, 0, 0, 2.9, 0, 0.09, S.metal(0x6a6e70, 0.7), 6);
  b.lathe('fountainBowlTop', [[0.7, 0], [0.7, 0.08], [0.15, 0.2], [0, 0.2]], 0, 2.8, 0, dark, 0, 0, 0, 14);
  // A green tide mark and the odd fallen chunk.
  b.lathe('fountainMoss', [[3.0, 0.5], [3.0, 0.62], [2.96, 0.62], [2.96, 0.5]], 0, 0.02, 0, S.concrete(0x4e6a34, 0.4), 0, 0, 0, 28);
  const r = rng(seed + 31);
  for (let i = 0; i < 4; i++) {
    const a = r() * 6.28;
    b.rbox(Math.cos(a) * 3.7, 0.1, Math.sin(a) * 3.7, 0.5, 0.2, 0.4, 0.04, dark, 0, r() * 3, 0);
  }
  b.groundShade(0, 0.4, 0.25);
  return b;
}

/** A marble stele with worn lines of lettering: one of the founders' plaques. Front faces +Z. */
function plaqueProto(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  const r = rng(seed + 5);
  b.rbox(0, 0.12, 0, 1.3, 0.24, 0.5, 0.03, S.concrete(0x8f8b80, 0.7));
  b.rbox(0, 1.19, 0, 1.0, 1.9, 0.16, 0.03, S.concrete(0xd9d5c9, 0.4), 0, 0, (r() - 0.5) * 0.03);
  for (let i = 0; i < 7; i++) b.box(0, 1.95 - i * 0.2, 0.085, 0.3 + r() * 0.4, 0.03, 0.01, S.paint(0x4a4740, 0.9));
  b.box(0, 0.5, 0.09, 0.9, 0.04, 0.01, S.paint(0x6a5a38, 0.6));
  return b;
}

/** A park bench: slatted seat and back on cast ends. Faces +Z. */
function benchProto(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  const wood = S.wood(seed % 2 ? 0x6a5038 : 0x7a6044, 0.8);
  const iron = S.steel(0x2e3032, 0.6);
  for (const x of [-0.8, 0.8]) {
    b.box(x, 0.22, 0, 0.06, 0.44, 0.5, iron);
    b.box(x, 0.7, -0.24, 0.06, 0.55, 0.05, iron, 0.18, 0, 0);
  }
  for (let i = 0; i < 3; i++) b.box(0, 0.46, -0.16 + i * 0.16, 1.8, 0.04, 0.12, wood);
  for (let i = 0; i < 2; i++) b.box(0, 0.62 + i * 0.2, -0.27 - i * 0.04, 1.8, 0.1, 0.03, wood, 0.18, 0, 0);
  return b;
}



// ------------------------------------------------------------------------------------------ the transport hub

/** A city bus, 12 m long, white with a coloured band, in the livery of one of the three big operators; engines off for good. */
function busProto(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.jitter = 0.02;
  const band = [0x1f7a3a, 0x1c4fa0, 0x0e5a46, 0xb5232a][seed % 4];
  const body = S.paint(0xe3e2da, 0.8);
  const stripe = S.paint(band, 0.7);
  const glass = S.glass(0x0e1418);
  b.rbox(0, 1.65, 0, 2.5, 2.5, 12, 0.14, body);
  b.box(0, 0.78, 0, 2.52, 0.55, 12.02, stripe);
  b.box(0, 2.78, 0, 2.52, 0.16, 12.02, stripe);
  for (const sx of [-1.26, 1.26]) {
    for (let i = 0; i < 6; i++) b.box(sx, 2.0, -4.7 + i * 1.88, 0.06, 0.95, 1.62, glass);
    b.box(sx, 1.2, 4.4, 0.07, 1.5, 1.2, S.paint(0x2a3138, 0.6));
  }
  b.box(0, 2.0, 6.0, 2.2, 1.15, 0.06, glass, 0.06, 0, 0);
  b.box(0, 2.88, 6.02, 1.7, 0.26, 0.05, S.glow(0xff9a20, 0.5));
  b.box(0, 0.58, 6.0, 2.52, 0.3, 0.2, S.rubber(0x1a1a1c));
  b.box(0, 0.58, -6.0, 2.52, 0.3, 0.2, S.rubber(0x1a1a1c));
  b.box(0, 3.1, -1.2, 1.7, 0.34, 4.2, S.paint(0xb9bcbc, 0.7));
  b.box(0, 3.1, 3.4, 1.4, 0.22, 1.6, S.paint(0xb9bcbc, 0.7));
  for (const [z, dual] of [[3.9, false], [-2.5, true], [-3.5, true]] as const) {
    void dual;
    for (const sx of [-1.12, 1.12]) {
      b.cyl(sx, 0.5, z, 1.0, 0.3, 1.0, S.rubber(0x1b1b1d), 0, 0, Math.PI / 2, 12);
      b.cyl(sx + Math.sign(sx) * 0.1, 0.5, z, 0.55, 0.12, 0.55, S.metal(0x8a9096, 0.5), 0, 0, Math.PI / 2, 10);
    }
  }
  return b;
}

/** A bus stop shelter: a flat roof on posts, a glass back with an advertising panel, a bench. It opens towards +Z. */
function busShelterProto(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  const frame = S.steel(0x4a4e52, 0.55);
  b.box(0, 2.55, 0, 4.4, 0.1, 1.8, S.paint(seed % 2 ? 0x1f7a3a : 0x1c4fa0, 0.6));
  for (const x of [-2.0, 2.0]) for (const z of [-0.7, 0.7]) b.rod(x, 0, z, x, 2.5, z, 0.04, frame, 6);
  b.box(0, 1.25, -0.72, 4.0, 2.2, 0.04, S.glass(0x1c262c));
  b.box(1.2, 1.3, -0.68, 1.1, 1.5, 0.03, S.paint(0xd9d4c4, 0.6));
  b.box(0, 0.45, -0.4, 3.0, 0.06, 0.4, S.steel(0x3a3d40, 0.6));
  b.box(0, 0.25, -0.4, 2.9, 0.4, 0.05, S.steel(0x3a3d40, 0.6));
  return b;
}

/**
 * A Red Line tram: five articulated modules, 36 m, white with a red band and big windows, black bellows between the modules,
 * a red nose at each end, pantographs up to the wire. Dead now, and dusty. Local +Z is the direction it faces.
 */
function tramProto(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.jitter = 0.015;
  const white = S.paint(0xe6e8e6, 0.85);
  const red = S.paint(0xb9151b, 0.7);
  const glass = S.glass(0x0f171c);
  const door = S.paint(0x2a3138, 0.6);
  const dark = S.rubber(0x1a1a1c);
  const modLen = 6.6;
  const gap = 0.75;
  const n = 5;
  const total = n * modLen + (n - 1) * gap;
  for (let i = 0; i < n; i++) {
    const zc = -total / 2 + modLen / 2 + i * (modLen + gap);
    b.rbox(0, 2.0, zc, 2.65, 2.6, modLen, 0.16, white);
    b.box(0, 0.98, zc, 2.67, 0.6, modLen + 0.02, red);
    b.box(0, 3.38, zc, 2.3, 0.16, modLen - 0.4, S.paint(0xb9bcbc, 0.7));
    for (const sx of [-1.33, 1.33]) {
      b.box(sx, 1.85, zc - 1.6, 0.07, 1.95, 1.3, door);
      b.box(sx, 2.3, zc + 0.5, 0.06, 1.0, 1.9, glass);
      b.box(sx, 2.3, zc + 2.45, 0.06, 1.0, 1.2, glass);
      b.box(sx, 2.3, zc - 2.85, 0.06, 1.0, 0.7, glass);
    }
    // The bogies under the module and its wheels.
    b.box(0, 0.5, zc, 2.2, 0.5, 3.4, dark);
    for (const sx of [-1.0, 1.0]) for (const dz of [-1.2, 1.2]) b.cyl(sx, 0.4, zc + dz, 0.8, 0.22, 0.8, S.steel(0x5c6266, 0.6), 0, 0, Math.PI / 2, 12);
    if (i < n - 1) b.box(0, 2.0, zc + modLen / 2 + gap / 2, 2.35, 2.45, gap + 0.1, dark);
  }
  // Noses: a red face with a raked dark windscreen, headlights and a coupler.
  for (const end of [-1, 1]) {
    const z = end * (total / 2);
    b.box(0, 1.9, z - end * 0.05, 2.62, 2.4, 0.2, red);
    b.box(0, 2.55, z + end * 0.04, 2.2, 1.2, 0.06, glass, -end * 0.3, 0, 0);
    for (const sx of [-0.95, 0.95]) b.box(sx, 1.0, z + end * 0.08, 0.3, 0.18, 0.05, S.glow(0xfff2c8, 0.3));
    b.box(0, 0.75, z + end * 0.15, 0.5, 0.2, 0.3, dark);
  }
  // Pantographs: two, on modules two and four, folded half up.
  const pz = [-modLen - gap, modLen + gap].map((o) => o * 0.5);
  for (const z of pz) {
    b.box(0, 3.5, z, 1.6, 0.1, 1.0, S.steel(0x3a3d40, 0.6));
    b.rod(-0.5, 3.5, z - 0.4, 0, 4.4, z, 0.035, S.steel(0x2e3032, 0.6), 5);
    b.rod(0.5, 3.5, z + 0.4, 0, 4.4, z, 0.035, S.steel(0x2e3032, 0.6), 5);
    b.box(0, 4.45, z, 1.7, 0.05, 0.12, S.steel(0x2e3032, 0.6));
  }
  void seed;
  return b;
}

/** A floodlight mast: a tapering lattice tower 30 m tall, with a bank of lamps at the top facing +Z. */
function floodlightProto(): MeshBuilder {
  const b = new MeshBuilder();
  const steel = S.steel(0x7d8184, 0.55);
  const h = 30;
  for (const [lx, lz] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) b.rod(lx * 0.9, 0, lz * 0.9, lx * 0.35, h, lz * 0.35, 0.07, steel, 6);
  for (let y = 3; y < h; y += 4) {
    const k = 0.9 - (0.55 * y) / h;
    b.rod(-k, y, k, k, y, k, 0.025, steel, 4);
    b.rod(k, y, k, k, y, -k, 0.025, steel, 4);
    b.rod(k, y, -k, -k, y, -k, 0.025, steel, 4);
    b.rod(-k, y, -k, -k, y, k, 0.025, steel, 4);
  }
  b.box(0, h + 0.1, 0.1, 5.4, 0.2, 0.3, steel);
  for (let row = 0; row < 3; row++) {
    for (let i = 0; i < 6; i++) {
      b.box(-2.25 + i * 0.9, h + 0.65 + row * 0.7, 0.4, 0.78, 0.58, 0.3, S.glow(0xfff0c0, 0.7));
      b.box(-2.25 + i * 0.9, h + 0.65 + row * 0.7, 0.22, 0.84, 0.64, 0.12, S.steel(0x2e3032, 0.6));
    }
  }
  b.box(0, h + 1.6, 0.1, 5.4, 0.12, 0.3, steel);
  b.rod(0, h + 1.7, 0.1, 0, h + 3.2, 0.1, 0.03, steel, 4);
  b.sphereAt(0, h + 3.3, 0.1, 0.1, S.glow(0xff3a2a, 2));
  return b;
}

/** A row of five painted parking bays (2.6 m wide, 5 m deep), centred on x with the bays running out along +Z. */
function parkBaysProto(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  const r = rng(seed + 3);
  const paint = S.paint(0xd6d4c8, 0.95);
  for (let i = 0; i <= 5; i++) b.box((i - 2.5) * 2.6, 0.052, 2.5, 0.1, 0.02, 4.7 - r() * 0.3, paint);
  b.box(0, 0.052, 4.95, 13.1, 0.02, 0.1, paint);
  return b;
}

/** A small square café table in black with steel legs. */
function cafeTableProto(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  const top = S.paint(0x232527, 0.5);
  const leg = S.steel(0x8d9195, 0.4);
  b.rbox(0, 0.74, 0, 0.8, 0.035, 0.8, 0.01, top);
  b.box(0, 0.7, 0, 0.7, 0.03, 0.7, S.steel(0x5c6063, 0.5));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.rod(sx * 0.34, 0, sz * 0.34, sx * 0.34, 0.72, sz * 0.34, 0.017, leg, 6);
  if (seed % 2) b.cyl(0.22, 0.79, -0.18, 0.05, 0.08, 0.05, S.glass(0x20262a), 0, 0, 0, 8);
  return b;
}

/** A moulded black plastic café chair. Faces +Z, the backrest behind it. */
function cafeChairProto(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  const plastic = S.plastic(0x16171a, 0.45);
  b.rbox(0, 0.45, 0, 0.44, 0.045, 0.44, 0.02, plastic);
  b.rbox(0, 0.72, -0.2, 0.42, 0.5, 0.04, 0.02, plastic, -0.12 + (seed % 3) * 0.02, 0, 0);
  for (const sx of [-1, 1]) {
    b.rod(sx * 0.19, 0, 0.18, sx * 0.19, 0.45, 0.18, 0.018, plastic, 6);
    b.rod(sx * 0.19, 0, -0.2, sx * 0.19, 0.5, -0.2, 0.018, plastic, 6);
    b.rod(sx * 0.19, 0.45, 0.18, sx * 0.19, 0.5, -0.2, 0.014, plastic, 5);
  }
  return b;
}

// ------------------------------------------------------------------------------------------ gang camps

/** A raider's A-frame tent, 3 m long on z, with a band of the gang's colour along the ridge. The flap faces +Z. */
function tentProto(seed: number, tag: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  const c = TAG_COL[tag] ?? C.raiderFlag;
  const canvas = [0x7a7258, 0x6a6a52, 0x8a7a5c, 0x5e6048][seed % 4];
  const cloth = S.cloth(canvas, 0.6);
  for (const sx of [-1, 1]) b.box(sx * 0.5, 0.78, 0, 0.04, 2.0, 3.0, cloth, 0, 0, sx * 0.66);
  b.box(0, 1.52, 0, 0.16, 0.12, 3.05, S.cloth(c, 0.7));
  // Closed back, open front with a bedroll and a pack.
  b.box(0, 0.7, -1.5, 1.7, 1.4, 0.04, cloth);
  b.rod(0, 0, 1.5, 0, 1.6, 1.5, 0.03, S.wood(0x3a2a1e), 6);
  b.rod(0, 0, -1.5, 0, 1.6, -1.5, 0.03, S.wood(0x3a2a1e), 6);
  b.rbox(0.3, 0.12, 0.2, 0.55, 0.16, 1.5, 0.07, S.cloth(0x4a5238, 0.5), 0, 0.05, 0);
  b.rbox(-0.35, 0.2, -0.7, 0.4, 0.34, 0.3, 0.08, S.leather(0x5a4430));
  for (const sx of [-1, 1]) for (const z of [-1, 0, 1]) b.rod(sx * 1.15, 0.0, z, sx * 1.2, 0.2, z, 0.025, S.wood(0x4a3a2a), 6);
  b.groundShade(0, 0.25, 0.3);
  return b;
}

/** A fire pit: a ring of stones, charred logs set like a wigwam, a bed of embers. The flames are particles. */
function campfireProto(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  const r = rng(seed + 12);
  b.add('cyl14', 0, 0.02, 0, 1.5, 0.04, 1.5, S.concrete(0x1c1a18, 0.2));
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + r() * 0.2;
    b.add('sphere', Math.sin(a) * 0.72, 0.12, Math.cos(a) * 0.72, 0.34 + r() * 0.1, 0.24, 0.3 + r() * 0.1, S.rock(0x6c6862), 0, a, 0);
  }
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + r() * 0.3;
    b.rod(Math.sin(a) * 0.55, 0.05, Math.cos(a) * 0.55, Math.sin(a) * 0.08, 0.7, Math.cos(a) * 0.08, 0.06, S.wood(0x2a1e16), 6);
  }
  b.add('cyl10', 0, 0.07, 0, 0.7, 0.06, 0.7, S.glow(0xff5a1a, 1.4));
  // Two log seats.
  for (const a of [0.9, 3.6]) b.rod(Math.sin(a) * 2.1 - Math.cos(a) * 0.6, 0.18, Math.cos(a) * 2.1 + Math.sin(a) * 0.6, Math.sin(a) * 2.1 + Math.cos(a) * 0.6, 0.18, Math.cos(a) * 2.1 - Math.sin(a) * 0.6, 0.17, S.wood(0x4a3a2a), 7);
  b.groundShade(0, 0.2, 0.35);
  return b;
}

// ------------------------------------------------------------------------------------------ registry

function build(kind: PropKind, seed: number, tag: number): MeshBuilder {
  switch (kind) {
    case 'rock':
      return rockProto(seed);
    case 'cairn':
      return cairnProto(seed);
    case 'deadTree':
      return deadTreeProto(seed);
    case 'wreck':
      return wreckProto(seed, tag);
    case 'pole':
      return poleProto(seed);
    case 'barrel':
      return barrelProto(seed);
    case 'tires':
      return tiresProto(seed);
    case 'sign':
      return signProto(seed, tag);
    case 'bones':
      return bonesProto(seed);
    case 'tarp':
      return tarpProto(seed, tag);
    case 'pylon':
      return pylonProto(tag);
    case 'crateStack':
      return crateStackProto(seed, tag);
    case 'shelf':
      return shelfProto(seed);
    case 'locker':
      return lockerProto(seed);
    case 'dumpster':
      return dumpsterProto(seed);
    case 'streetlight':
      return streetlightProto(seed);
    case 'rubble':
      return rubbleProto(seed);
    case 'banner':
      return bannerProto(tag);
    case 'chain':
      return chainProto();
    case 'pump':
      return pumpProto(seed);
    case 'container':
      return containerProto(seed, tag);
    case 'fence':
      return fenceProto(seed);
    case 'fountain':
      return fountainProto(seed);
    case 'plaque':
      return plaqueProto(seed);
    case 'bench':
      return benchProto(seed);
    case 'parkBays':
      return parkBaysProto(seed);
    case 'cafeTable':
      return cafeTableProto(seed);
    case 'cafeChair':
      return cafeChairProto(seed);
    case 'bus':
      return busProto(seed);
    case 'busShelter':
      return busShelterProto(seed);
    case 'tram':
      return tramProto(seed);
    case 'floodlight':
      return floodlightProto();
    case 'tent':
      return tentProto(seed, tag);
    case 'campfire':
      return campfireProto(seed);
    default:
      return new MeshBuilder();
  }
}

/** Cached prototypes: 4 variants per kind. Appending copies vertices with yaw, scale and offset. */
export function propProto(kind: PropKind, seed: number, tag = 0): MeshBuilder {
  const v = Math.abs(seed) % 4;
  const key = `${kind}:${v}:${tag}`;
  let p = protoCache.get(key);
  if (!p) {
    p = build(kind, v + 1 + (tag || 0) * 7, tag);
    protoCache.set(key, p);
  }
  return p;
}

export function appendProp(target: MeshBuilder, p: PropSpawn) {
  target.append(propProto(p.kind, p.seed, p.tag ?? 0), p.x, p.y, p.z, p.yaw, p.scale);
}

// ------------------------------------------------------------------- pickups

export interface PickupModel {
  group: THREE.Group;
}

const glowTex = (() => {
  let t: THREE.Texture | null = null;
  return () => {
    if (t) return t;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,0.95)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    t = shared(new THREE.CanvasTexture(c));
    return t;
  };
})();
export const glowTexture = glowTex;

const pickupGeo = new Map<string, THREE.BufferGeometry>();
const pickupMat = kitMaterial();

function pickupGeometry(kind: string): THREE.BufferGeometry {
  let g = pickupGeo.get(kind);
  if (g) return g;
  const b = new MeshBuilder();
  b.jitter = 0.03;
  const steel = S.steel(0x6a6e72, 0.6);
  if (kind.startsWith('part:')) {
    buildPartModel(b, kind.slice(5));
    g = shared(b.build());
    pickupGeo.set(kind, g);
    return g;
  }
  if (kind.startsWith('paint:')) {
    // A spray can standing on the ground: black body, a cap in the paint's colour, a nozzle and a label band.
    const col = parseInt(kind.slice(6), 16) || 0xffffff;
    b.cyl(0, 0.17, 0, 0.11, 0.34, 0.11, S.metal(0x2a2c2f, 0.5), 0, 0, 0, 14);
    b.cyl(0, 0.17, 0, 0.115, 0.14, 0.115, S.paint(col, 0.3), 0, 0, 0, 14);
    b.cyl(0, 0.36, 0, 0.08, 0.06, 0.08, S.paint(col, 0.3), 0, 0, 0, 12);
    b.cyl(0, 0.4, 0, 0.035, 0.04, 0.035, S.plastic(0xe6e0d0), 0, 0, 0, 8);
    b.box(0, 0.25, 0.058, 0.05, 0.1, 0.004, S.glow(0xe8c020, 0.8));
    g = shared(b.build());
    pickupGeo.set(kind, g);
    return g;
  }
  switch (kind) {
    case 'fuel':
      jerryCan(b, 0, 0, 0, C.fuel, 0.3);
      break;
    case 'diesel':
      jerryCan(b, 0, 0, 0, C.diesel, 0.3);
      break;
    case 'water':
      jerryCan(b, 0, 0, 0, 0x3a7ac0, 0.3);
      break;
    case 'oil':
      oilCan(b, 0, 0, 0);
      break;
    case 'rations':
      b.rbox(0, 0.17, 0, 0.5, 0.34, 0.38, 0.015, S.paint(0xc8a878, 0.6));
      b.box(0, 0.345, 0, 0.5, 0.01, 0.06, S.cloth(0xb04a3a, 0.5));
      for (let i = 0; i < 3; i++) b.cyl(-0.15 + i * 0.15, 0.4, 0.05, 0.1, 0.12, 0.1, S.metal(0xb8b0a0, 0.4), 0, 0, 0, 10);
      break;
    case 'medicine':
      // A bottle of pills: amber glass, a white child-proof cap and a printed label, lying where it was left.
      b.cyl(0, 0.08, 0, 0.09, 0.16, 0.09, S.glass(0x8a4a14), 0, 0, 0, 12);
      b.cyl(0, 0.175, 0, 0.1, 0.035, 0.1, S.plastic(0xeeeeea, 0.4), 0, 0, 0, 12);
      b.box(0, 0.08, 0.047, 0.08, 0.08, 0.004, S.paint(0xe8e4d4, 0.5));
      b.box(0, 0.1, 0.05, 0.05, 0.015, 0.004, S.paint(0xd23a3a, 0.4));
      break;
    case 'medkit':
      // A first-aid box: white case, a red cross, a clasp.
      b.rbox(0, 0.16, 0, 0.46, 0.3, 0.32, 0.04, S.plastic(0xeeeeea, 0.4));
      b.box(0, 0.17, 0.163, 0.2, 0.06, 0.01, S.plastic(0xd23a3a, 0.3));
      b.box(0, 0.17, 0.163, 0.06, 0.2, 0.01, S.plastic(0xd23a3a, 0.3));
      b.rbox(0, 0.33, 0, 0.16, 0.04, 0.04, 0.01, S.plastic(0x2a2a2a));
      break;
    case 'bandage':
      // A roll of bandage on its side, a red band round the middle, a strip trailing.
      b.cyl(0, 0.05, 0, 0.1, 0.1, 0.1, S.cloth(0xe8e4d8, 0.8), Math.PI / 2, 0, 0, 14);
      b.cyl(0, 0.05, 0, 0.102, 0.03, 0.102, S.cloth(0xc83a3a, 0.7), Math.PI / 2, 0, 0, 14);
      b.box(0.1, 0.012, 0.05, 0.16, 0.012, 0.06, S.cloth(0xe8e4d8, 0.8), 0, 0.4, 0);
      break;
    case 'ammo':
      b.rbox(0, 0.13, 0, 0.42, 0.24, 0.2, 0.015, S.paint(0x4e5a34, 0.6));
      b.box(0, 0.27, 0, 0.3, 0.03, 0.06, S.metal(0x2a2a2a));
      b.box(0.1, 0.14, 0.101, 0.14, 0.05, 0.005, S.paint(0xd8c050, 0.5));
      break;
    case 'engine1':
    case 'engine2':
    case 'engine3': {
      // An engine block on a shipping stand: heads, intake, pulley and exhaust manifold. Better engines show brass and chrome.
      const mk = Number(kind.slice(6));
      b.rbox(0, 0.05, 0, 0.7, 0.07, 0.44, 0.015, S.steel(0x2e3134, 0.7));
      for (const sx of [1, -1]) b.box(sx * 0.3, 0.14, 0, 0.05, 0.14, 0.4, S.steel(0x3a3d40, 0.7));
      b.rbox(0, 0.28, 0, 0.52, 0.28, 0.34, 0.03, S.metal(0x5a5e62, 0.6));
      b.rbox(0, 0.46, 0, 0.5, 0.1, 0.32, 0.02, S.metal(mk >= 3 ? 0xb89a52 : 0x8a8e92, 0.5));
      for (let i = 0; i < 4; i++) b.cyl(-0.18 + i * 0.12, 0.55, 0, 0.065, 0.1, 0.065, mk >= 2 ? S.chrome() : S.steel(0x5a5d60), 0, 0, 0, 8);
      b.cyl(0.3, 0.28, 0, 0.2, 0.06, 0.2, S.steel(0x2a2c2e), 0, 0, Math.PI / 2, 14);
      b.cyl(0.33, 0.28, 0, 0.1, 0.04, 0.1, S.chrome(), 0, 0, Math.PI / 2, 10);
      b.rod(-0.22, 0.22, 0.18, 0.22, 0.22, 0.18, 0.028, S.metal(0x7a4a2a, 0.7), 8);
      b.rbox(-0.1, 0.17, -0.19, 0.3, 0.1, 0.05, 0.01, S.steel(0x2e3134, 0.6));
      if (mk >= 3) b.cyl(0, 0.62, 0, 0.26, 0.12, 0.3, S.steel(0x25272a), 0, 0, 0, 14);
      if (mk >= 2) b.box(-0.06, 0.5, -0.17, 0.2, 0.02, 0.04, S.glow(mk >= 3 ? 0xffb454 : 0x7ddc7a, 2));
      break;
    }
    case 'radiator1':
    case 'radiator2':
    case 'radiator3': {
      // A finned core between two end tanks, hoses sticking out; the big ones carry a fan shroud.
      const mk = Number(kind.slice(8));
      const alu = mk >= 3 ? S.metal(0xc4c8cc, 0.4) : mk === 2 ? S.metal(0xa8acb0, 0.5) : S.steel(0x3a3d40, 0.7);
      b.rbox(0, 0.3, 0, 0.62, 0.42, 0.07, 0.012, alu);
      for (let i = 0; i < 15; i++) b.box(-0.29 + i * 0.0415, 0.3, 0.04, 0.011, 0.38, 0.01, S.steel(0x1c1d1f, 0.6));
      for (const y of [0.54, 0.06]) b.rbox(0, y, 0, 0.66, 0.08, 0.1, 0.015, mk >= 2 ? S.paint(mk >= 3 ? 0xe07a1a : 0xc23a1a, 0.4) : S.steel(0x4a4d50, 0.7));
      b.cyl(-0.26, 0.6, 0, 0.07, 0.1, 0.07, S.metal(0xb8b0a0, 0.4), 0, 0, 0, 10);
      b.cyl(0.33, 0.52, 0, 0.06, 0.14, 0.06, S.rubber(0x1c1c1e), 0, 0, Math.PI / 2, 8);
      if (mk >= 2) b.cyl(0, 0.3, -0.06, 0.44, 0.04, 0.44, S.plastic(0x141414), Math.PI / 2, 0, 0, 16);
      break;
    }
    case 'tyre1':
    case 'tyre2':
    case 'tyre3': {
      // A tyre on its rim, standing on its tread. Rougher quality tyres have blocks; the best have beadlock bolts.
      const mk = Number(kind.slice(4));
      b.torus(0, 0.3, 0, 0.23, 0.095, S.rubber(0x161618), 0, 0, 0, 10, 28);
      b.cyl(0, 0.3, 0, 0.3, 0.13, 0.3, mk >= 3 ? S.metal(0x3a3c40, 0.5) : S.metal(0x8a8e92, 0.5), Math.PI / 2, 0, 0, 16);
      b.cyl(0, 0.3, 0.02, 0.1, 0.16, 0.1, S.steel(0x5a5d60), Math.PI / 2, 0, 0, 8);
      if (mk >= 2) for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        b.box(Math.cos(a) * 0.3, 0.3 + Math.sin(a) * 0.3, 0, 0.06, 0.06, 0.16, S.rubber(0x1c1c1e), 0, 0, a);
      }
      if (mk >= 3) for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        b.cyl(Math.cos(a) * 0.19, 0.3 + Math.sin(a) * 0.19, 0.075, 0.025, 0.02, 0.025, S.chrome(), Math.PI / 2, 0, 0, 6);
      }
      break;
    }
    case 'part1':
    case 'part2':
    case 'part3': {
      // A parts crate: steel cradle with an engine block, a gear and a wrench laid on it. Better quality shows brass and chrome.
      const mk = Number(kind.slice(4));
      b.rbox(0, 0.08, 0, 0.62, 0.1, 0.42, 0.02, S.steel(0x3a3d40, 0.7));
      for (const sx of [1, -1]) b.box(sx * 0.27, 0.16, 0, 0.04, 0.12, 0.4, S.steel(0x4a4d50, 0.7));
      b.rbox(-0.06, 0.25, 0, 0.34, 0.2, 0.26, 0.03, S.metal(mk >= 3 ? 0xb89a52 : 0x7a7e82, 0.5));
      for (let i = 0; i < 3; i++) b.cyl(-0.14 + i * 0.08, 0.38, 0.04, 0.06, 0.1, 0.06, mk >= 2 ? S.chrome() : S.steel(0x5a5d60), 0, 0, 0, 8);
      b.cyl(0.2, 0.22, 0.08, 0.24, 0.05, 0.24, S.metal(0x9a9ea2, 0.4), Math.PI / 2, 0, 0.2, 14);
      b.rbox(0.05, 0.4, -0.1, 0.34, 0.028, 0.045, 0.01, S.chrome(0xa8acb0), 0, 0.5, 0);
      if (mk >= 2) b.box(-0.06, 0.37, -0.18, 0.18, 0.02, 0.05, S.glow(mk >= 3 ? 0xffb454 : 0x7ddc7a, 2));
      break;
    }
    case 'gear1':
    case 'gear2':
    case 'gear3': {
      // A gearbox on a stand: bell housing, cast case with ribs, an output shaft and a mounting plate. Better ones are alloy.
      const mk = Number(kind.slice(4));
      const casing = mk >= 3 ? S.metal(0xb4b8bc, 0.4) : mk === 2 ? S.metal(0x8a8e92, 0.5) : S.steel(0x4a4d50, 0.7);
      b.rbox(0, 0.05, 0, 0.62, 0.07, 0.34, 0.015, S.steel(0x2e3134, 0.7));
      b.cyl(-0.2, 0.26, 0, 0.36, 0.34, 0.36, casing, 0, 0, Math.PI / 2, 16);
      b.rbox(0.1, 0.25, 0, 0.36, 0.3, 0.3, 0.04, casing);
      for (let i = 0; i < 4; i++) b.box(0.02 + i * 0.09, 0.42, 0, 0.025, 0.05, 0.28, S.steel(0x3a3d40, 0.7));
      b.cyl(0.38, 0.25, 0, 0.09, 0.2, 0.09, S.chrome(0xb8bcc0), 0, 0, Math.PI / 2, 10);
      b.cyl(0.46, 0.25, 0, 0.14, 0.03, 0.14, S.steel(0x2a2c2e), 0, 0, Math.PI / 2, 10);
      b.rod(0.1, 0.4, 0.05, 0.1, 0.62, -0.02, 0.018, S.metal(0x2a2c2e), 6);
      b.sphereAt(0.1, 0.64, -0.02, 0.04, S.plastic(0x1c1c1c, 0.5));
      if (mk >= 2) b.box(0.1, 0.3, 0.155, 0.2, 0.05, 0.01, S.glow(mk >= 3 ? 0xffb454 : 0x7ddc7a, 2));
      break;
    }
    case 'spring1':
    case 'spring2':
    case 'spring3': {
      // A coil-over: damper tube, a coil spring round it, mounting eyes. The best have a reservoir.
      const mk = Number(kind.slice(6));
      const col = mk >= 3 ? 0xe07a1a : mk === 2 ? 0x2a7a3a : 0x3a6ab8;
      for (const dx of [-0.16, 0.16]) {
        b.cyl(dx, 0.34, 0, 0.07, 0.62, 0.07, S.metal(0x8a8e92, 0.4), 0, 0, 0, 10);
        for (let i = 0; i < 9; i++) b.torus(dx, 0.14 + i * 0.058, 0, 0.1, 0.014, S.paint(col, 0.4), Math.PI / 2, 0, 0, 5, 14);
        for (const y of [0.04, 0.66]) b.torus(dx, y, 0, 0.045, 0.018, S.steel(0x2a2c2e), 0, Math.PI / 2, 0, 6, 10);
        if (mk >= 2) b.cyl(dx + 0.1, 0.4, 0, 0.06, 0.26, 0.06, S.paint(col, 0.4), 0, 0, 0, 10);
      }
      break;
    }
    case 'brake1':
    case 'brake2':
    case 'brake3': {
      // A disc with a caliper: drilled and bigger at the better grades, red calipers on the best.
      const mk = Number(kind.slice(5));
      const R = 0.17 + mk * 0.03;
      b.cyl(0, 0.3, 0, R * 2, 0.035, R * 2, S.metal(0x8a8e92, 0.45), Math.PI / 2, 0, 0, 24);
      b.cyl(0, 0.3, 0, R * 0.7, 0.07, R * 0.7, S.steel(0x3a3d40, 0.7), Math.PI / 2, 0, 0, 14);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        b.cyl(Math.cos(a) * R * 0.38, 0.3 + Math.sin(a) * R * 0.38, 0, 0.022, 0.08, 0.022, S.chrome(), Math.PI / 2, 0, 0, 6);
      }
      if (mk >= 2) for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        b.cyl(Math.cos(a) * R * 0.82, 0.3 + Math.sin(a) * R * 0.82, 0, 0.018, 0.045, 0.018, S.plastic(0x101010), Math.PI / 2, 0, 0, 6);
      }
      b.rbox(R * 0.78, 0.3 + R * 0.32, 0, 0.1, 0.18, 0.16, 0.02, S.paint(mk >= 3 ? 0xd62a1a : mk === 2 ? 0xe0a01a : 0x5a5d60, 0.35), 0, 0, 0.5);
      break;
    }
    case 'pipe1':
    case 'pipe2':
    case 'pipe3': {
      // An exhaust run: header collector, a muffler and a tip. The quiet ones have a fat can, the race ones bare tubes.
      const mk = Number(kind.slice(4));
      const tube = mk >= 2 ? S.chrome(0xc4c8cc) : S.steel(0x5a4a3a, 0.8);
      b.pipe([[-0.3, 0.34, 0], [-0.12, 0.14, 0.02], [0.1, 0.14, 0.02]], 0.035, tube, 8);
      if (mk >= 2) {
        b.pipe([[-0.3, 0.46, 0.06], [-0.14, 0.2, -0.02], [0.1, 0.14, 0]], 0.035, tube, 8);
        b.pipe([[-0.3, 0.4, -0.06], [-0.12, 0.17, 0.04], [0.1, 0.14, 0.04]], 0.035, tube, 8);
      }
      b.cyl(0.18, 0.14, 0.02, mk === 1 ? 0.2 : 0.13, 0.4, mk === 1 ? 0.2 : 0.13, S.steel(0x6a6c70, 0.6), 0, 0, Math.PI / 2, 16);
      b.pipe([[0.36, 0.14, 0.02], [0.46, 0.16, 0.02]], 0.04, S.chrome(0xdadee2), 10);
      b.cyl(-0.3, 0.4, 0, 0.12, 0.05, 0.12, S.steel(0x3a3d40, 0.7), 0, 0, 0, 10);
      break;
    }
    case 'hood1':
    case 'hood2':
    case 'hood3': {
      // A bonnet lying face up: hinge tabs, a pressed crease, and a vent or scoop at the better grades.
      const mk = Number(kind.slice(4));
      const pan = mk >= 3 ? S.steel(0x4a4d50, 0.8) : S.paint(0x7a8a98, 0.6);
      b.rbox(0, 0.14, 0, 0.8, 0.05, 0.56, 0.02, pan, 0, 0, 0);
      b.rbox(0, 0.17, 0, 0.5, 0.02, 0.38, 0.01, pan);
      for (const sx of [1, -1]) b.box(sx * 0.3, 0.14, -0.3, 0.1, 0.06, 0.06, S.steel(0x2a2c2e));
      if (mk === 2) {
        b.rbox(0, 0.23, 0.05, 0.26, 0.1, 0.22, 0.03, pan);
        b.box(0, 0.23, 0.17, 0.2, 0.07, 0.02, S.plastic(0x0c0c0c));
      } else {
        for (let i = 0; i < 4; i++) b.box(0, 0.18, -0.02 + i * 0.07, 0.3, 0.012, 0.03, S.plastic(0x0c0c0c));
      }
      if (mk >= 3) for (let i = 0; i < 8; i++) b.cyl(-0.34 + (i % 4) * 0.22, 0.175, i < 4 ? 0.2 : -0.16, 0.025, 0.012, 0.025, S.steel(0x2a2c2e), 0, 0, 0, 6);
      break;
    }
    case 'door1':
    case 'door2':
    case 'door3': {
      // A door leaning on its hinge edge: frame, glass or canvas, handle, plated at the better grades.
      const mk = Number(kind.slice(4));
      const pan = mk === 1 ? S.cloth(0x8a7a52, 0.8) : S.paint(0x7a8a98, 0.6);
      b.rbox(0, 0.36, 0, 0.1, 0.62, 0.78, 0.02, pan);
      b.box(0.03, 0.64, 0.02, 0.06, 0.2, 0.62, S.glass(0x1a262e));
      b.box(0.06, 0.4, 0.28, 0.04, 0.03, 0.14, S.chrome(0xb4b8bc));
      if (mk >= 2) {
        b.rbox(0.05, 0.28, 0, 0.04, 0.42, 0.7, 0.012, S.steel(mk >= 3 ? 0x3a3d40 : 0x5a5d60, 0.75));
        for (let i = 0; i < 6; i++) b.cyl(0.075, 0.12 + (i % 2) * 0.32, -0.28 + Math.floor(i / 2) * 0.28, 0.025, 0.012, 0.025, S.steel(0x2a2c2e), 0, 0, Math.PI / 2, 6);
      }
      break;
    }
    case 'fragment':
      b.rbox(0, 0.22, 0, 0.5, 0.36, 0.3, 0.03, S.paint(0x2a2e33, 0.5));
      b.rbox(-0.05, 0.25, 0.155, 0.26, 0.16, 0.01, 0.01, S.glow(C.fragment, 2.5));
      for (const x of [0.15, 0.2]) b.cyl(x, 0.25, 0.155, 0.05, 0.02, 0.05, S.metal(0x8a8a8a), Math.PI / 2, 0, 0, 10);
      b.rod(0.18, 0.4, -0.05, 0.3, 1.1, -0.1, 0.012, S.chrome(), 6);
      b.sphereAt(0.3, 1.1, -0.1, 0.025, S.glow(C.fragment, 4));
      break;
    case 'chassis':
      // A bare ladder frame with axles, marked in blue.
      for (const sx of [1, -1]) b.rbox(sx * 0.4, 0.3, 0, 0.12, 0.16, 2.0, 0.02, S.paint(C.chassis, 0.6));
      for (const z of [-0.8, -0.2, 0.4, 0.9]) b.box(0, 0.3, z, 0.8, 0.1, 0.08, S.paint(C.chassis, 0.6));
      for (const z of [-0.7, 0.75]) {
        b.rod(-0.7, 0.3, z, 0.7, 0.3, z, 0.04, S.steel(), 8);
        for (const sx of [1, -1]) b.cyl(sx * 0.72, 0.3, z, 0.3, 0.06, 0.3, S.steel(0x3a3c3e), 0, 0, Math.PI / 2, 12);
      }
      break;
    default:
      b.rbox(0, 0.2, 0, 0.4, 0.4, 0.4, 0.04, S.paint(C.gold, 0.5));
  }
  g = shared(b.build());
  pickupGeo.set(kind, g);
  return g;
}

/** An engine is drawn at its real size; in the arms a big one is shrunk until it can be held in front of you at all. */
function engineCarryScale(id: string): number {
  const spec = partDef(id).engine;
  const d = spec ? engineDims(spec) : null;
  return d ? Math.min(1, 0.7 / Math.max(d.l, d.w * 1.2, 0.1)) : 1;
}

/** The model of a ground item as held in the arms: the same mesh, no glow, no bobbing. */
export function makeCarryModel(kind: string): THREE.Group {
  const g = new THREE.Group();
  const m = new THREE.Mesh(pickupGeometry(kind), pickupMat);
  m.castShadow = true;
  m.scale.setScalar(/^(part|engine|radiator|tyre|gear|spring|brake|pipe|hood|door)\d$/.test(kind) ? 0.9 : kind.startsWith('part:eng_') ? engineCarryScale(kind.slice(5)) : 1.1);
  g.add(m);
  return g;
}

const GLOW: Record<string, number> = {
  fuel: 0xff5a3a,
  diesel: 0xe8c020,
  water: 0x6ab4ff,
  oil: 0xe0b030,
  rations: 0xf0d090,
  medicine: 0xffffff,
  medkit: 0xffffff,
  bandage: 0xe8e4d8,
  ammo: 0xd8c050,
  fragment: 0x3ad0ff,
  chassis: 0x3aa0ff,
  // Vehicle parts glow by quality: common, uncommon, rare.
  part1: 0xe6dcc0,
  part2: 0x7ddc7a,
  part3: 0xffb454,
  engine1: 0xe6dcc0,
  engine2: 0x7ddc7a,
  engine3: 0xffb454,
  radiator1: 0xe6dcc0,
  radiator2: 0x7ddc7a,
  radiator3: 0xffb454,
  tyre1: 0xe6dcc0,
  tyre2: 0x7ddc7a,
  tyre3: 0xffb454,
};
for (const k of ['gear', 'spring', 'brake', 'pipe', 'hood', 'door']) {
  GLOW[`${k}1`] = 0xe6dcc0;
  GLOW[`${k}2`] = 0x7ddc7a;
  GLOW[`${k}3`] = 0xffb454;
}
export function makePickup(kind: string): PickupModel {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(pickupGeometry(kind), pickupMat);
  mesh.castShadow = true;
  group.add(mesh);
  return { group };
}

/** A tall thin beam, for the markers of delve chests and keys. */
export function makeBeam(color: number, height = 14): THREE.Mesh {
  const g = new THREE.CylinderGeometry(0.06, 0.12, height, 8, 1, true);
  const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.6), transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false });
  const mesh = new THREE.Mesh(g, m);
  mesh.position.y = height / 2;
  return mesh;
}
