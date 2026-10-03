import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { crate, jerryCan, plate, rivets, spareTyre, strap, heavyGun } from './parts';
import { partDef } from '../data';
import type { Fit } from '../sim/parts';

/**
 * How fitted parts look. Every chassis hands over a `Mounts` record (where its bumpers, roof, doors and bonnet are),
 * and each part draws itself against those numbers, so one definition fits a moped, a hatchback and a van.
 * All coordinates are in the frame the chassis model is built in.
 */
export interface Mounts {
  /** Half width of the body at door height. */
  hw: number;
  /** Front bumper face (z > 0), its centre height and half width. */
  front: { z: number; y: number; hw: number };
  /** Rear bumper face (z < 0). */
  rear: { z: number; y: number; hw: number };
  /** Top surface of the bonnet. */
  hood?: { y: number; z0: number; z1: number; hw: number };
  /** Top surface of the roof. */
  roof?: { y: number; z0: number; z1: number; hw: number };
  /** Boot lid or pickup bed floor. */
  trunk?: { y: number; z0: number; z1: number; hw: number };
  /** Door zone down the flank. */
  side: { y0: number; y1: number; z0: number; z1: number };
  /** Height of the sill under the doors. */
  sill: number;
  /** Where a fixed front gun sits, just above the bonnet. */
  gun?: { x: number; y: number; z: number };
  /** A two-wheeler or quad: parts are drawn smaller and panniers replace cans. */
  narrow?: boolean;
  /** Wheel radius, so racks and pipes can stay clear of the tyres. */
  wheelR: number;
}

/** Lamps are registered through the rig so cached shells can replay them onto each instance. */
export interface Rig {
  lamp(x: number, y: number, z: number, r: number, bucket?: boolean): void;
  tail(x: number, y: number, z: number, w?: number, h?: number, amber?: boolean): void;
  /** Where a fixed gun's muzzle flash appears. */
  muzzle(x: number, y: number, z: number): void;
}

/** What the engine in the bay looks like from outside. Derived from the build, so cached shells key off the fitted part ids. */
export interface EngineLook {
  /** Aftermarket quality 1..3, or 0 for a factory engine (even one carried over from another car). */
  mk: number;
  /** Not the engine this chassis was built with. */
  swapped: boolean;
  blown: boolean;
  diesel: boolean;
  /** Engine size class minus bay size class: how far it overshoots. */
  oversize: number;
  /** Size class of the engine itself. */
  size: number;
  /** The bay has been stripped. */
  empty: boolean;
}

export interface CoolingLook {
  /** Aftermarket quality 1..3, or 0 for the factory core. */
  mk: number;
  /** Rating in kW, to tell a big core from a small one. */
  kw: number;
  empty: boolean;
}

export interface KitLook {
  paint: number;
  stripe: number;
  stripeColor: number;
  seed: number;
  fit: Fit;
  wear: number;
  engine?: EngineLook;
  cooling?: CoolingLook;
}

const steel = (w = 0.7) => S.steel(0x565a5d, w);
const dark = () => S.steel(0x2c2f31, 0.6);
const chromeMat = () => S.chrome(0xc4c8cc);

function rnd(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const mkOf = (fit: Fit, slot: keyof Fit) => (fit[slot] ? partDef(fit[slot]!.id).mk : 0);

// ---------------------------------------------------------------- performance parts

/** Plates welded over the doors, bonnet and roof. More plate at each quality. */
function armorKit(b: MeshBuilder, m: Mounts, mk: number, look: KitLook) {
  const sideH = Math.max(0.2, m.side.y1 - m.side.y0);
  const zc = (m.side.z0 + m.side.z1) / 2;
  const len = m.side.z1 - m.side.z0;
  const col = mk >= 3 ? S.paint(0xaeb2ae, 0.45) : mk === 2 ? S.steel(0x4d5154, 0.75) : S.steel(0x6e7276, 0.8);
  const rust = S.rust(0x6a3a22);
  const thick = 0.02 + mk * 0.008;
  for (const sx of [1, -1]) {
    const x = sx * (m.hw + thick / 2 + 0.005);
    // Door plates, split in two so they read as separate sheets.
    plate(b, x, (m.side.y0 + m.side.y1) / 2, zc + len * 0.24, len * 0.46, sideH, thick, col, 0, sx * Math.PI / 2, 0);
    plate(b, x, (m.side.y0 + m.side.y1) / 2, zc - len * 0.25, len * 0.44, sideH * 0.94, thick, mk === 1 ? rust : col, 0, sx * Math.PI / 2, 0);
    if (mk >= 3 && !m.narrow) {
      // A second ceramic course along the sill.
      plate(b, x + sx * 0.012, m.side.y0 - 0.05, zc, len * 0.9, 0.16, thick, S.paint(0x9a9e9a, 0.5), 0, sx * Math.PI / 2, 0);
    }
  }
  if (m.narrow) return;
  if (mk >= 2 && m.hood) {
    plate(b, 0, m.hood.y + 0.018, (m.hood.z0 + m.hood.z1) / 2, m.hood.hw * 1.55, m.hood.z1 - m.hood.z0 - 0.1, thick, col, -Math.PI / 2, 0, 0);
  }
  if (mk >= 3 && m.roof) {
    plate(b, 0, m.roof.y + 0.02, (m.roof.z0 + m.roof.z1) / 2, m.roof.hw * 1.5, m.roof.z1 - m.roof.z0 - 0.08, thick, col, -Math.PI / 2, 0, 0);
    // Slatted window armour: bars across the glass line.
    const r = rnd(look.seed + 3);
    for (let i = 0; i < 5; i++) {
      const z = m.roof.z1 - 0.1 - i * ((m.roof.z1 - m.roof.z0 - 0.2) / 5);
      for (const sx of [1, -1]) b.box(sx * (m.hw - 0.01), m.side.y1 + 0.18 + r() * 0.02, z, 0.025, 0.05, 0.22, dark());
    }
  }
}

/**
 * Engine visible from outside. A tuned engine shows an air-filter pod, a scoop or a supercharger. An engine too big for
 * its bay pushes up through the bonnet (more of it the more it overshoots), a swapped diesel gets an exhaust stack, and
 * on a bike or quad the motor simply hangs out where everyone can see it.
 */
function engineKit(b: MeshBuilder, m: Mounts, e: EngineLook, look: KitLook) {
  const mk = e.mk;
  if (!m.hood) {
    // Bikes and quads: a bigger expansion chamber along the flank.
    const x = m.hw * 0.9;
    if (mk > 0) {
      b.pipe(
        [
          [x, m.sill + 0.02, m.front.z * 0.2],
          [x + 0.04, m.sill, m.rear.z * 0.3],
          [x + 0.05, m.sill + 0.04, m.rear.z * 0.8],
        ],
        0.028 + mk * 0.006,
        chromeMat(),
        8,
      );
      b.limb(x + 0.04, m.sill, m.rear.z * 0.3, x + 0.05, m.sill + 0.04, m.rear.z * 0.85, 0.06 + mk * 0.01, 0.045, chromeMat(), 12);
    }
    if (e.swapped && e.size >= 2) {
      // A car engine bolted in where a bike motor used to be: block, heads, headers and a blower, all hanging out.
      const s = 0.1 + 0.04 * e.size;
      const y = m.sill + s * 0.9;
      const z = (m.side.z0 + m.side.z1) / 2 - 0.1;
      b.rbox(0, y, z, s * 1.6, s * 1.2, s * 2.1, 0.03, S.metal(0x55595d, 0.6));
      b.rbox(0, y + s * 0.75, z, s * 1.45, s * 0.35, s * 1.95, 0.02, S.metal(0x8a8e92, 0.5));
      for (let i = 0; i < Math.min(8, e.size * 2); i++) b.cyl(-s * 0.5 + (i % 2) * s, y + s * 0.95, z - s * 0.8 + Math.floor(i / 2) * s * 0.5, 0.045, 0.09, 0.045, chromeMat(), 0, 0, 0, 8);
      for (const sx of [1, -1]) b.pipe([[sx * s * 0.8, y, z + s * 0.9], [sx * (s * 0.8 + 0.08), y - s * 0.4, z], [sx * (s * 0.8 + 0.1), y - s * 0.5, z - s * 1.4]], 0.03, S.metal(0x8a5a3a, 0.7), 8);
      if (e.blown) b.cyl(0, y + s * 1.15, z, s * 0.9, s * 0.45, s * 0.9, S.steel(0x2a2c2f), 0, 0, 0, 14);
    }
    return;
  }
  const h = m.hood;
  const zc = (h.z0 + h.z1) / 2 + (h.z1 - h.z0) * 0.12;
  if (mk === 1) {
    b.cyl(0, h.y + 0.05, zc, 0.26, 0.1, 0.26, chromeMat(), 0, 0, 0, 16);
    b.cyl(0, h.y + 0.1, zc, 0.22, 0.03, 0.22, S.steel(0x2a2a2a), 0, 0, 0, 16);
  } else if (mk === 2) {
    b.rbox(0, h.y + 0.07, zc, h.hw * 0.7, 0.12, (h.z1 - h.z0) * 0.42, 0.04, S.steel(0x3c4044, 0.6), -0.08, 0, 0);
    b.box(0, h.y + 0.06, zc + (h.z1 - h.z0) * 0.21, h.hw * 0.62, 0.07, 0.02, S.plastic(0x0c0c0c));
  } else if (mk >= 3) {
    // Blower poking through the bonnet, with eight chrome stacks and fat headers out of the wings.
    b.rbox(0, h.y + 0.13, zc, h.hw * 0.62, 0.22, (h.z1 - h.z0) * 0.4, 0.05, S.metal(0x6a6e72, 0.4));
    b.cyl(0, h.y + 0.27, zc, 0.22, 0.12, 0.34, S.steel(0x25272a), 0, 0, 0, 14);
    for (let i = 0; i < 8; i++) b.cyl(-h.hw * 0.27 + (i % 4) * h.hw * 0.18, h.y + 0.26, zc - 0.1 + Math.floor(i / 4) * 0.2, 0.05, 0.14, 0.05, chromeMat(), 0, 0, 0, 8);
    for (const sx of [1, -1]) {
      b.pipe(
        [
          [sx * (h.hw * 0.9), h.y - 0.1, h.z1 - 0.2],
          [sx * (h.hw + 0.08), h.y - 0.16, (h.z0 + h.z1) / 2],
          [sx * (h.hw + 0.1), h.y - 0.32, h.z0 + 0.15],
        ],
        0.04,
        S.metal(0x8a5a3a, 0.7),
        8,
      );
    }
  }
  // An engine bigger than the bay: the bonnet is cut and the block shows through.
  if (e.swapped && e.oversize >= 2) {
    const up = 0.05 + 0.045 * e.oversize;
    const body = S.paint(look.paint, Math.min(1, look.wear + 0.2));
    b.rbox(0, h.y + up * 0.5, zc, h.hw * (1.05 + 0.05 * e.oversize), up + 0.06, (h.z1 - h.z0) * 0.62, 0.05, body);
    b.rbox(0, h.y + up * 0.95, zc, h.hw * 0.9, 0.04, (h.z1 - h.z0) * 0.5, 0.02, S.steel(0x1c1e20, 0.6));
    if (e.oversize >= 3) {
      for (let i = 0; i < 6; i++) b.cyl(-h.hw * 0.36 + (i % 3) * h.hw * 0.36, h.y + up + 0.1, zc - 0.12 + Math.floor(i / 3) * 0.26, 0.07, 0.2, 0.07, chromeMat(), 0, 0, 0, 8);
      if (e.blown) b.cyl(0, h.y + up + 0.13, zc, 0.3, 0.2, 0.4, S.steel(0x25272a), 0, 0, 0, 14);
    }
  }
  // A diesel in a car that left the factory on petrol: an upright exhaust stack behind the cab.
  if (e.diesel && e.swapped) {
    const z = m.roof ? m.roof.z0 - 0.02 : m.rear.z + 0.5;
    const top = (m.roof?.y ?? m.side.y1) + 0.12;
    const x = -(m.hw + 0.05);
    b.pipe([[x, m.sill + 0.05, z - 0.25], [x, m.sill + 0.12, z], [x, top, z]], 0.045, chromeMat(), 8);
    b.cyl(x, top + 0.04, z, 0.12, 0.05, 0.12, S.steel(0x2a2c2f), 0, 0, 0, 10);
  }
}

/** A radiator that is not the factory one shows through the grille: a finned core, coloured tanks, fans on the big ones. */
function coolingKit(b: MeshBuilder, m: Mounts, c: CoolingLook) {
  if (c.mk <= 0 || c.empty) return;
  const F = m.front.z;
  const y = m.front.y + (m.narrow ? 0.06 : 0.16);
  const w = Math.max(0.14, m.front.hw * (m.narrow ? 1.5 : 1.3));
  const hgt = (m.narrow ? 0.14 : 0.2) + c.mk * 0.04;
  const alu = c.mk >= 3 ? S.metal(0xc4c8cc, 0.4) : c.mk === 2 ? S.metal(0xa8acb0, 0.5) : S.steel(0x3a3d40, 0.7);
  b.rbox(0, y, F - 0.025, w * 2, hgt, 0.07, 0.015, alu);
  const n = Math.max(4, Math.round(w * 11));
  for (let i = 0; i < n; i++) b.box(-w + (i + 0.5) * ((w * 2) / n), y, F + 0.012, 0.008, hgt * 0.8, 0.01, dark());
  if (c.mk >= 2) {
    // Coloured end tanks and a hose up to the engine.
    for (const sx of [1, -1]) {
      b.rbox(sx * (w + 0.015), y, F - 0.025, 0.05, hgt + 0.03, 0.08, 0.015, S.paint(c.mk >= 3 ? 0xe07a1a : 0xc23a1a, 0.4));
      b.pipe([[sx * (w + 0.03), y + hgt * 0.4, F - 0.03], [sx * (w + 0.06), y + hgt * 0.9, F - 0.2]], 0.014, S.rubber(0x1c1c1e), 6);
    }
  }
  if (c.mk >= 3 || c.kw >= 400) {
    // A second core behind the first, and twin fans showing at the sides.
    b.rbox(0, y - hgt * 0.35, F - 0.1, w * 1.9, hgt * 0.6, 0.06, 0.012, S.metal(0x6a6e72, 0.5));
    for (const sx of [1, -1]) {
      b.cyl(sx * w * 0.5, y, F - 0.07, hgt * 0.85, 0.03, hgt * 0.85, S.plastic(0x141414), Math.PI / 2, 0, 0, 14);
      b.cyl(sx * w * 0.5, y, F - 0.05, hgt * 0.2, 0.04, hgt * 0.2, S.steel(0x5a5d60), Math.PI / 2, 0, 0, 8);
    }
  }
}

/** A fixed front gun on the bonnet for chassis with a front mount: one barrel, two, or a shielded heavy. */
function weaponKit(b: MeshBuilder, rig: Rig, m: Mounts, mk: number, native: boolean) {
  const g = m.gun;
  if (!g) return;
  const stand = dark();
  const place = (x: number, scale: number, shield: boolean) => {
    const gun = new MeshBuilder();
    heavyGun(gun, 0.9, shield);
    b.appendMatrix(gun, new THREE.Matrix4().compose(new THREE.Vector3(g.x + x, g.y, g.z), new THREE.Quaternion(), new THREE.Vector3(scale, scale, scale)));
    b.box(g.x + x, g.y - 0.13 * scale, g.z, 0.07, 0.2 * scale, 0.07, stand);
  };
  if (!native) {
    // A welded post and cradle for a gun the chassis did not come with.
    b.pipe(
      [
        [-0.28, g.y - 0.18, g.z - 0.12],
        [-0.16, g.y - 0.02, g.z],
        [0.16, g.y - 0.02, g.z],
        [0.28, g.y - 0.18, g.z - 0.12],
      ],
      0.018,
      stand,
      6,
    );
  }
  if (mk <= 1) {
    place(0, 0.75, false);
  } else if (mk === 2) {
    place(-0.17, 0.7, false);
    place(0.17, 0.7, false);
  } else {
    place(0, 1.05, true);
    b.rbox(0.36, g.y - 0.05, g.z - 0.1, 0.16, 0.2, 0.3, 0.02, S.paint(0x4a5532, 0.7));
  }
  rig.muzzle(0, g.y, g.z + 0.95 * (mk >= 3 ? 1.05 : 0.75));
}

/** Fuel cans on the rear quarters, a long-range tank underneath, or panniers on a bike. */
function utilityKit(b: MeshBuilder, m: Mounts, mk: number, look: KitLook) {
  const r = rnd(look.seed + 9);
  const cols = [0x55603e, look.paint, 0xb0301e, 0xc89a2a];
  if (m.narrow) {
    for (const sx of [1, -1]) {
      b.rbox(sx * (m.rear.hw + 0.12 + mk * 0.02), m.rear.y - 0.02, m.rear.z + 0.55, 0.18 + mk * 0.03, 0.26, 0.4, 0.04, S.leather(0x3a3228, 0.7));
      b.box(sx * (m.rear.hw + 0.12 + mk * 0.02), m.rear.y + 0.12, m.rear.z + 0.55, 0.19 + mk * 0.03, 0.02, 0.2, S.steel(0x6a6c6e));
    }
    return;
  }
  const z = m.rear.z + 0.42;
  for (const sx of [1, -1]) {
    const x = sx * (m.hw + 0.13);
    b.box(x - sx * 0.07, m.sill + 0.12, z, 0.14, 0.03, 0.34, dark());
    jerryCan(b, x, m.sill + 0.135, z, cols[Math.floor(r() * cols.length)], sx > 0 ? Math.PI / 2 : -Math.PI / 2);
    if (mk >= 3) jerryCan(b, x, m.sill + 0.135, z + 0.34, cols[Math.floor(r() * cols.length)], sx > 0 ? Math.PI / 2 : -Math.PI / 2);
    strap(b, [[x - sx * 0.1, m.sill + 0.12, z - 0.14], [x - sx * 0.1, m.sill + 0.5, z - 0.14], [x + sx * 0.1, m.sill + 0.5, z - 0.14]]);
  }
  if (mk >= 2) {
    // A cylindrical tank slung under the tail, with a hose up to the filler.
    const d = 0.26 + (mk - 2) * 0.08;
    b.cyl(0, m.sill - 0.02, m.rear.z + 0.62, d, m.hw * 1.5, d, S.steel(0x6a6e72, 0.55), 0, 0, Math.PI / 2, 18);
    for (const sx of [1, -1]) b.box(sx * m.hw * 0.62, m.sill + 0.08, m.rear.z + 0.62, 0.04, 0.3, 0.06, dark());
    b.pipe([[m.hw * 0.72, m.sill, m.rear.z + 0.62], [m.hw * 0.86, m.sill + 0.3, m.rear.z + 0.5], [m.hw + 0.02, m.sill + 0.5, m.rear.z + 0.42]], 0.015, S.rubber(0x1c1c1e), 6);
  }
}

// ---------------------------------------------------------------- bolt-on mounts

function frontKit(b: MeshBuilder, m: Mounts, id: string) {
  const F = m.front.z;
  const y = m.front.y;
  const hw = m.front.hw;
  const tube = S.steel(0x34373a, 0.7);
  if (id === 'fr_bull') {
    for (const sx of [1, -1]) {
      b.pipe([[sx * hw * 0.98, y - 0.16, F - 0.05], [sx * hw, y - 0.1, F + 0.12], [sx * hw, y + 0.28, F + 0.1], [sx * hw * 0.7, y + 0.4, F - 0.02]], 0.032, tube, 8);
      b.rod(sx * hw * 0.35, y - 0.12, F + 0.1, sx * hw * 0.35, y + 0.3, F + 0.06, 0.026, tube, 8);
    }
    b.rod(-hw, y + 0.28, F + 0.1, hw, y + 0.28, F + 0.1, 0.032, tube, 8);
    b.rod(-hw, y - 0.1, F + 0.12, hw, y - 0.1, F + 0.12, 0.032, tube, 8);
    b.rod(-hw * 0.7, y + 0.4, F - 0.02, hw * 0.7, y + 0.4, F - 0.02, 0.028, tube, 8);
  } else if (id === 'fr_blade') {
    plate(b, 0, y - 0.04, F + 0.28, hw * 2.15, 0.7, 0.06, S.steel(0x6a6e72, 0.85), -0.5, 0, 0);
    for (const sx of [1, -1]) {
      b.rod(sx * hw * 0.7, y + 0.05, F - 0.1, sx * hw * 0.7, y - 0.1, F + 0.32, 0.04, S.steel(0x3a3c3e), 8);
      b.rod(sx * hw * 0.7, y - 0.2, F - 0.1, sx * hw * 0.7, y - 0.28, F + 0.3, 0.035, S.steel(0x3a3c3e), 8);
    }
    b.box(0, y + 0.22, F + 0.2, hw * 2.1, 0.07, 0.06, S.paint(0xc9a22a, 0.7));
  } else {
    b.rbox(0, y - 0.05, F + 0.1, hw * 2.05, 0.3, 0.1, 0.02, S.steel(0x5a5e60, 0.8));
    for (let i = 0; i < 7; i++) b.add('cone12', -hw * 0.9 + i * ((hw * 1.8) / 6), y - 0.05, F + 0.3, 0.08, 0.34, 0.08, S.steel(0x8a8e92, 0.5), Math.PI / 2, 0, 0);
    for (const sx of [1, -1]) b.add('cone12', sx * (hw + 0.04), y - 0.05, F - 0.1, 0.08, 0.3, 0.08, S.steel(0x8a8e92, 0.5), 0, 0, -sx * Math.PI / 2);
  }
}

function roofKit(b: MeshBuilder, rig: Rig, m: Mounts, id: string, look: KitLook) {
  const ro = m.roof;
  if (!ro) return;
  const r = rnd(look.seed + 21);
  const L = ro.z1 - ro.z0;
  const zc = (ro.z0 + ro.z1) / 2;
  const hw = ro.hw;
  if (id === 'rf_rack') {
    const rail = S.steel(0x2e3032, 0.65);
    const y = ro.y + 0.16;
    for (const sx of [1, -1]) for (const z of [ro.z0 + 0.05, ro.z1 - 0.05]) b.rod(sx * hw, ro.y, z, sx * hw, y, z, 0.016, rail, 6);
    b.pipe([[hw, y, ro.z0 + 0.05], [hw, y, ro.z1 - 0.05], [-hw, y, ro.z1 - 0.05], [-hw, y, ro.z0 + 0.05], [hw, y, ro.z0 + 0.05]], 0.016, rail, 6);
    for (let i = 0; i < 5; i++) b.rod(-hw, y - 0.02, ro.z0 + 0.05 + (i * (L - 0.1)) / 4, hw, y - 0.02, ro.z0 + 0.05 + (i * (L - 0.1)) / 4, 0.012, rail, 6);
    // A load strapped on: crate and cans, different per car.
    const k = Math.floor(r() * 3);
    if (k === 0) crate(b, 0, y + 0.17, zc - L * 0.12, hw * 1.2, 0.3, L * 0.34, 0.1);
    else if (k === 1) {
      jerryCan(b, -hw * 0.45, y - 0.01, zc, 0x55603e, 0.3);
      jerryCan(b, hw * 0.05, y - 0.01, zc + 0.1, look.paint, -0.2);
      jerryCan(b, hw * 0.5, y - 0.01, zc - 0.1, 0xb0301e, 0.1);
    } else spareTyre(b, 0, y + 0.1, zc, 0.34, 0.2, 0, 0.3);
    strap(b, [[-hw, y, zc + 0.12], [-hw, y + 0.34, zc + 0.12], [hw, y + 0.34, zc + 0.12], [hw, y, zc + 0.12]]);
  } else if (id === 'rf_light') {
    const z = ro.z1 - 0.12;
    b.rbox(0, ro.y + 0.07, z, hw * 1.7, 0.1, 0.16, 0.03, S.plastic(0x181818));
    const n = 4;
    for (let i = 0; i < n; i++) {
      const x = -hw * 0.68 + (i / (n - 1)) * hw * 1.36;
      b.cyl(x, ro.y + 0.07, z + 0.07, 0.1, 0.06, 0.1, chromeMat(), Math.PI / 2, 0, 0, 12);
      rig.lamp(x, ro.y + 0.07, z + 0.1, 0.045, false);
    }
    for (const sx of [1, -1]) b.box(sx * hw * 0.5, ro.y + 0.01, z, 0.05, 0.06, 0.1, dark());
  } else {
    // Roll cage: two hoops over the cab and rails along the roof.
    const t = S.paint(0x2a2c2e, 0.6);
    const y = ro.y + 0.12;
    for (const z of [ro.z0 + 0.1, ro.z1 - 0.1]) {
      b.pipe([[m.hw, m.side.y0 + 0.1, z], [m.hw * 0.96, m.side.y1 + 0.2, z], [hw * 0.8, y, z], [-hw * 0.8, y, z], [-m.hw * 0.96, m.side.y1 + 0.2, z], [-m.hw, m.side.y0 + 0.1, z]], 0.026, t, 8);
    }
    for (const sx of [1, -1]) b.pipe([[sx * hw * 0.8, y, ro.z0 + 0.1], [sx * hw * 0.8, y, ro.z1 - 0.1]], 0.024, t, 8);
    b.rod(-hw * 0.8, y, ro.z0 + 0.1, hw * 0.8, y, ro.z1 - 0.1, 0.02, t, 6);
  }
}

function rearKit(b: MeshBuilder, m: Mounts, id: string, look: KitLook) {
  const z = m.rear.z;
  if (id === 'rr_spare') {
    const rad = Math.max(0.28, m.wheelR * 0.95);
    b.box(0, m.rear.y + 0.2, z - 0.04, 0.2, 0.14, 0.05, dark());
    spareTyre(b, 0, m.rear.y + 0.38, z - 0.13, rad, 0.2, Math.PI / 2, 0);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      b.cyl(Math.cos(a) * 0.06, m.rear.y + 0.38 + Math.sin(a) * 0.06, z - 0.25, 0.03, 0.025, 0.03, S.steel(0x5a5d60), Math.PI / 2, 0, 0, 6);
    }
  } else if (id === 'rr_wing') {
    const base = (m.trunk?.y ?? m.rear.y + 0.45) + 0.04;
    const y = base + 0.3;
    const zz = z + 0.3;
    for (const sx of [1, -1]) {
      b.rod(sx * m.rear.hw * 0.62, base, zz, sx * m.rear.hw * 0.62, y, zz, 0.02, dark(), 6);
      b.box(sx * m.rear.hw * 0.98, y + 0.03, zz, 0.025, 0.1, 0.34, S.paint(look.paint, 0.4));
    }
    b.rbox(0, y + 0.03, zz, m.rear.hw * 1.96, 0.025, 0.32, 0.01, S.paint(look.stripe ? look.stripeColor : 0x1e1e20, 0.4), -0.12, 0, 0);
  } else {
    // Cargo box: on the boot or bed when there is one, else a carrier behind the bumper.
    const col = S.steel(0x4a4e50, 0.75);
    if (m.trunk) {
      const t = m.trunk;
      const L = (t.z1 - t.z0) * 0.9;
      b.rbox(0, t.y + 0.26, (t.z0 + t.z1) / 2, t.hw * 1.8, 0.5, L, 0.03, col);
      b.box(0, t.y + 0.52, (t.z0 + t.z1) / 2, t.hw * 1.84, 0.02, L + 0.02, dark());
      rivets(b, [-t.hw * 0.86, t.y + 0.5, t.z0 + 0.1], [t.hw * 0.86, t.y + 0.5, t.z0 + 0.1], 7);
      b.box(0, t.y + 0.3, t.z0 - 0.0, 0.14, 0.05, 0.02, S.metal(0xaaaaaa));
    } else {
      b.box(0, m.rear.y - 0.05, z - 0.2, m.rear.hw * 1.6, 0.04, 0.5, dark());
      b.rbox(0, m.rear.y + 0.18, z - 0.22, m.rear.hw * 1.5, 0.4, 0.46, 0.03, col);
      b.box(0, m.rear.y + 0.4, z - 0.22, m.rear.hw * 1.54, 0.02, 0.5, dark());
    }
  }
}

function sideKit(b: MeshBuilder, m: Mounts, id: string) {
  const zc = (m.side.z0 + m.side.z1) / 2;
  const len = m.side.z1 - m.side.z0;
  for (const sx of [1, -1]) {
    const x = sx * (m.hw + 0.07);
    if (id === 'sd_skirt') {
      const t = S.steel(0x34373a, 0.7);
      b.pipe([[x, m.sill - 0.03, m.side.z0 - 0.1], [x, m.sill - 0.03, m.side.z1 + 0.1]], 0.036, t, 8);
      for (let i = 0; i < 4; i++) {
        const z = m.side.z0 + (i / 3) * len;
        b.rod(x, m.sill - 0.03, z, sx * (m.hw - 0.02), m.sill + 0.08, z, 0.018, t, 6);
      }
    } else if (id === 'sd_plate') {
      const h = Math.max(0.22, (m.side.y1 - m.side.y0) * 0.9);
      plate(b, sx * (m.hw + 0.05), (m.side.y0 + m.side.y1) / 2 - 0.02, zc + len * 0.3, len * 0.42, h, 0.03, S.steel(0x4c5154, 0.8), 0, sx * Math.PI / 2, 0);
      plate(b, sx * (m.hw + 0.05), (m.side.y0 + m.side.y1) / 2, zc - len * 0.2, len * 0.5, h * 1.05, 0.03, S.rust(0x6a3a22), 0, sx * Math.PI / 2, 0);
      plate(b, sx * (m.hw + 0.05), m.sill + 0.16, m.rear.z + 0.55, 0.7, 0.3, 0.03, S.steel(0x4c5154, 0.8), 0, sx * Math.PI / 2, 0);
    } else {
      const c = chromeMat();
      b.pipe([[x, m.sill + 0.02, m.side.z1 + 0.05], [x + sx * 0.02, m.sill - 0.02, zc], [x, m.sill + 0.02, m.side.z0 - 0.05]], 0.034, c, 8);
      b.box(x + sx * 0.02, m.sill + 0.08, zc, 0.03, 0.08, len * 0.7, S.steel(0x2a2c2e, 0.5));
      b.cyl(x, m.sill + 0.02, m.side.z0 - 0.07, 0.06, 0.03, 0.06, S.metal(0x1a1612, 0.9), Math.PI / 2, 0, 0, 10);
    }
  }
}

// ---------------------------------------------------------------- paint

/** Stripes on the bonnet, roof and boot, or hazard bars along the flanks. */
function paintDetails(b: MeshBuilder, m: Mounts, look: KitLook) {
  if (look.stripe === 1) {
    const col = S.paint(look.stripeColor, 0.5);
    for (const [top, zs] of [[m.hood, 0], [m.roof, 0], [m.trunk, 0]] as const) {
      if (!top) continue;
      void zs;
      for (const sx of [1, -1]) b.box(sx * 0.13, top.y + 0.006, (top.z0 + top.z1) / 2, 0.12, 0.004, top.z1 - top.z0 - 0.04, col);
    }
  } else if (look.stripe === 3) {
    const col = S.paint(look.stripeColor, 0.5);
    const len = m.side.z1 - m.side.z0;
    const n = Math.max(3, Math.round(len / 0.34));
    for (const sx of [1, -1]) {
      for (let i = 0; i < n; i++) {
        const z = m.side.z0 + 0.1 + (i / (n - 1)) * (len - 0.2);
        b.box(sx * (m.hw + 0.004), m.side.y0 + 0.12, z, 0.004, 0.1, 0.14, col, 0, 0, 0.0);
      }
    }
  }
}

/** Everything a vehicle's fitted parts and paint add to its shell. */
export function addKit(b: MeshBuilder, rig: Rig, m: Mounts, look: KitLook, o: { nativeGun: boolean }) {
  const fit = look.fit;
  paintDetails(b, m, look);
  const arm = mkOf(fit, 'armor');
  if (arm) armorKit(b, m, arm, look);
  if (look.engine && !look.engine.empty) engineKit(b, m, look.engine, look);
  if (look.cooling) coolingKit(b, m, look.cooling);
  const wpn = mkOf(fit, 'weapon');
  if (wpn || o.nativeGun) weaponKit(b, rig, m, wpn, o.nativeGun);
  const utl = mkOf(fit, 'utility');
  if (utl) utilityKit(b, m, utl, look);
  if (fit.front) frontKit(b, m, fit.front.id);
  if (fit.roof) roofKit(b, rig, m, fit.roof.id, look);
  if (fit.rear) rearKit(b, m, fit.rear.id, look);
  if (fit.side) sideKit(b, m, fit.side.id);
}

/** A stable string for the parts fitted, used in shell cache keys. */
export function fitSignature(fit: Fit): string {
  return Object.keys(fit)
    .sort()
    .map((k) => `${k}:${fit[k as keyof Fit]!.id}`)
    .join(',');
}
