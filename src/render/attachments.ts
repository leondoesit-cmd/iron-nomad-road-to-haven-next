import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { crate, jerryCan, plate, rivets, spareTyre, strap, heavyGun } from './parts';
import { partDef } from '../data';
import { partMeta, partTag } from './bodyParts';
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
  const armorId = look.fit.armor?.id;
  for (const sx of [1, -1]) {
    const x = sx * (m.hw + thick / 2 + 0.005);
    b.mark(partTag('slot', `armor:${sx}`), partMeta({ kind: 'slot', id: armorId, slot: 'armor', mk, side: sx as 1 | -1, pivot: [x, (m.side.y0 + m.side.y1) / 2, zc] }));
    // Door plates, split in two so they read as separate sheets.
    plate(b, x, (m.side.y0 + m.side.y1) / 2, zc + len * 0.24, len * 0.46, sideH, thick, col, 0, sx * Math.PI / 2, 0);
    plate(b, x, (m.side.y0 + m.side.y1) / 2, zc - len * 0.25, len * 0.44, sideH * 0.94, thick, mk === 1 ? rust : col, 0, sx * Math.PI / 2, 0);
    if (mk >= 3 && !m.narrow) {
      // A second ceramic course along the sill.
      plate(b, x + sx * 0.012, m.side.y0 - 0.05, zc, len * 0.9, 0.16, thick, S.paint(0x9a9e9a, 0.5), 0, sx * Math.PI / 2, 0);
    }
    b.end();
  }
  if (m.narrow) return;
  if (mk >= 2 && m.hood) {
    b.mark(partTag('slot', 'armor:hood'), partMeta({ kind: 'slot', id: armorId, slot: 'armor', mk, pivot: [0, m.hood.y, m.hood.z0] }));
    plate(b, 0, m.hood.y + 0.018, (m.hood.z0 + m.hood.z1) / 2, m.hood.hw * 1.55, m.hood.z1 - m.hood.z0 - 0.1, thick, col, -Math.PI / 2, 0, 0);
    b.end();
  }
  if (mk >= 3 && m.roof) {
    b.mark(partTag('slot', 'armor:roof'), partMeta({ kind: 'slot', id: armorId, slot: 'armor', mk, pivot: [0, m.roof.y, (m.roof.z0 + m.roof.z1) / 2] }));
    plate(b, 0, m.roof.y + 0.02, (m.roof.z0 + m.roof.z1) / 2, m.roof.hw * 1.5, m.roof.z1 - m.roof.z0 - 0.08, thick, col, -Math.PI / 2, 0, 0);
    // Slatted window armour: bars across the glass line.
    const r = rnd(look.seed + 3);
    for (let i = 0; i < 5; i++) {
      const z = m.roof.z1 - 0.1 - i * ((m.roof.z1 - m.roof.z0 - 0.2) / 5);
      for (const sx of [1, -1]) b.box(sx * (m.hw - 0.01), m.side.y1 + 0.18 + r() * 0.02, z, 0.025, 0.05, 0.22, dark());
    }
    b.end();
  }
}

/**
 * Engine visible from outside. A tuned engine shows an air-filter pod, a scoop or a supercharger. An engine too big for
 * its bay pushes up through the bonnet (more of it the more it overshoots), a swapped diesel gets an exhaust stack, and
 * on a bike or quad the motor simply hangs out where everyone can see it.
 */
function engineKit(b: MeshBuilder, m: Mounts, e: EngineLook, look: KitLook, hoodOff = false) {
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
  // With the bonnet off the whole engine is on show (see `bayKit`), so nothing needs to poke through it.
  if (hoodOff) {
    if (e.diesel && e.swapped) dieselStack(b, m);
    return;
  }
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
  if (e.diesel && e.swapped) dieselStack(b, m);
}

/** A diesel in a car that left the factory on petrol: an upright exhaust stack behind the cab. */
function dieselStack(b: MeshBuilder, m: Mounts) {
  const z = m.roof ? m.roof.z0 - 0.02 : m.rear.z + 0.5;
  const top = (m.roof?.y ?? m.side.y1) + 0.12;
  const x = -(m.hw + 0.05);
  b.pipe([[x, m.sill + 0.05, z - 0.25], [x, m.sill + 0.12, z], [x, top, z]], 0.045, chromeMat(), 8);
  b.cyl(x, top + 0.04, z, 0.12, 0.05, 0.12, S.steel(0x2a2c2f), 0, 0, 0, 10);
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
  const utlId = look.fit.utility?.id;
  const tag = (sx: number, pivot: [number, number, number]) => b.mark(partTag('slot', `utility:${sx}`), partMeta({ kind: 'slot', id: utlId, slot: 'utility', mk, side: sx as -1 | 0 | 1, pivot }));
  if (m.narrow) {
    for (const sx of [1, -1]) {
      tag(sx, [sx * m.rear.hw, m.rear.y, m.rear.z + 0.55]);
      b.rbox(sx * (m.rear.hw + 0.12 + mk * 0.02), m.rear.y - 0.02, m.rear.z + 0.55, 0.18 + mk * 0.03, 0.26, 0.4, 0.04, S.leather(0x3a3228, 0.7));
      b.box(sx * (m.rear.hw + 0.12 + mk * 0.02), m.rear.y + 0.12, m.rear.z + 0.55, 0.19 + mk * 0.03, 0.02, 0.2, S.steel(0x6a6c6e));
      b.end();
    }
    return;
  }
  const z = m.rear.z + 0.42;
  for (const sx of [1, -1]) {
    const x = sx * (m.hw + 0.13);
    tag(sx, [sx * m.hw, m.sill + 0.12, z]);
    b.box(x - sx * 0.07, m.sill + 0.12, z, 0.14, 0.03, 0.34, dark());
    jerryCan(b, x, m.sill + 0.135, z, cols[Math.floor(r() * cols.length)], sx > 0 ? Math.PI / 2 : -Math.PI / 2);
    if (mk >= 3) jerryCan(b, x, m.sill + 0.135, z + 0.34, cols[Math.floor(r() * cols.length)], sx > 0 ? Math.PI / 2 : -Math.PI / 2);
    strap(b, [[x - sx * 0.1, m.sill + 0.12, z - 0.14], [x - sx * 0.1, m.sill + 0.5, z - 0.14], [x + sx * 0.1, m.sill + 0.5, z - 0.14]]);
    b.end();
  }
  if (mk >= 2) {
    // A cylindrical tank slung under the tail, with a hose up to the filler.
    const d = 0.26 + (mk - 2) * 0.08;
    tag(0, [0, m.sill, m.rear.z + 0.62]);
    b.cyl(0, m.sill - 0.02, m.rear.z + 0.62, d, m.hw * 1.5, d, S.steel(0x6a6e72, 0.55), 0, 0, Math.PI / 2, 18);
    for (const sx of [1, -1]) b.box(sx * m.hw * 0.62, m.sill + 0.08, m.rear.z + 0.62, 0.04, 0.3, 0.06, dark());
    b.pipe([[m.hw * 0.72, m.sill, m.rear.z + 0.62], [m.hw * 0.86, m.sill + 0.3, m.rear.z + 0.5], [m.hw + 0.02, m.sill + 0.5, m.rear.z + 0.42]], 0.015, S.rubber(0x1c1c1e), 6);
    b.end();
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
    b.mark(partTag('slot', `side:${sx}`), partMeta({ kind: 'slot', id, slot: 'side', mk: partDef(id).mk, side: sx as 1 | -1, pivot: [sx * m.hw, m.sill + 0.05, zc] }));
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
    b.end();
  }
}

// ---------------------------------------------------------------- body panels

/** The part on a body slot (bonnet, a door), if it is not the factory one, and whether the mount is stripped bare. */
export function bodyPart(fit: Fit, slot: 'hood' | 'doorL' | 'doorR'): { id: string; off: boolean; stock: boolean } | null {
  const it = fit[slot];
  if (!it) return null;
  const d = partDef(it.id);
  return { id: it.id, off: !!d.empty, stock: !!d.stock };
}
export const panelOff = (fit: Fit, slot: 'hood' | 'doorL' | 'doorR') => !!bodyPart(fit, slot)?.off;
/** A door whose steel is not drawn in the body: stripped off, or replaced by canvas. */
export const doorSkipsSteel = (fit: Fit, slot: 'doorL' | 'doorR') => {
  const p = bodyPart(fit, slot);
  return !!p && (p.off || p.id === 'door_light');
};

/** The bonnet on the car: vents, a scoop, or armour plate over the paint. */
function hoodKit(b: MeshBuilder, m: Mounts, id: string, look: KitLook) {
  const h = m.hood;
  if (!h) return;
  const len = h.z1 - h.z0;
  const zc = (h.z0 + h.z1) / 2;
  const dk = S.plastic(0x0c0c0c);
  if (id === 'hood_vent') {
    for (let i = 0; i < 6; i++) for (const sx of [1, -1]) b.box(sx * h.hw * 0.42, h.y + 0.014, h.z0 + 0.12 + i * ((len - 0.3) / 5), h.hw * 0.5, 0.018, 0.035, dk, 0, 0, sx * 0.08);
  } else if (id === 'hood_scoop') {
    const body = S.paint(look.paint, Math.min(1, look.wear + 0.2));
    b.rbox(0, h.y + 0.08, zc + len * 0.08, h.hw * 0.72, 0.14, len * 0.4, 0.05, body, -0.08, 0, 0);
    b.box(0, h.y + 0.085, zc + len * 0.08 + len * 0.2, h.hw * 0.6, 0.09, 0.02, dk);
    for (let i = 0; i < 3; i++) b.box(0, h.y + 0.085, zc + len * 0.08 + len * 0.2 - 0.03 - i * 0.05, h.hw * 0.56, 0.007, 0.012, S.steel(0x2a2c2e));
  } else if (id === 'hood_armor') {
    const sheet = S.steel(0x4a4d50, 0.85);
    plate(b, 0, h.y + 0.025, zc, h.hw * 2.05, len * 0.96, 0.035, sheet, -Math.PI / 2, 0, 0);
    // A bar across the front edge and a slot for the driver to watch the road over.
    b.rbox(0, h.y + 0.06, h.z1 - 0.1, h.hw * 1.9, 0.05, 0.06, 0.015, S.steel(0x2a2c2e, 0.8));
    rivets(b, [-h.hw * 0.9, h.y + 0.05, h.z0 + 0.06], [h.hw * 0.9, h.y + 0.05, h.z0 + 0.06], 8);
  }
}

/** A door that is not steel: a roll-up canvas flap, or a plated or armoured door over the paint. */
function doorKit(b: MeshBuilder, m: Mounts, sx: 1 | -1, id: string, look: KitLook) {
  if (m.narrow) return;
  const x = sx * (m.hw - 0.01);
  const y = (m.side.y0 + m.side.y1) / 2;
  const h = m.side.y1 - m.side.y0;
  const len = m.side.z1 - m.side.z0;
  const zc = (m.side.z0 + m.side.z1) / 2;
  if (id === 'door_light') {
    const canvas = S.cloth(0x8a7a52, 0.9);
    b.rbox(x + sx * 0.02, y - 0.02, zc, 0.03, h * 0.9, len * 0.94, 0.015, canvas);
    // Rolled up at the top, tied off with a strap, grommets down the edges.
    b.capsule(x + sx * 0.04, y + h * 0.5, zc - len * 0.46, x + sx * 0.04, y + h * 0.5, zc + len * 0.46, 0.035, canvas, 8);
    for (const dz of [-0.28, 0.28]) b.torus(x + sx * 0.045, y + h * 0.5, zc + dz * len, 0.04, 0.008, S.cloth(0xd6a21e, 0.6), 0, Math.PI / 2, 0, 5, 10);
    for (let i = 0; i < 5; i++) b.cyl(x + sx * 0.04, y - h * 0.38, zc - len * 0.42 + i * len * 0.21, 0.02, 0.012, 0.02, S.steel(0x2a2c2e), 0, 0, Math.PI / 2, 6);
    b.box(x + sx * 0.04, y - 0.04, zc + len * 0.36, 0.014, 0.02, 0.14, S.steel(0x2a2c2e));
  } else if (id === 'door_plate') {
    const sheet = S.steel(0x5a5d60, 0.8);
    plate(b, x + sx * 0.03, y - 0.02, zc, len * 0.84, h * 0.82, 0.025, sheet, 0, sx * (Math.PI / 2), 0);
    rivets(b, [x + sx * 0.05, y + h * 0.3, zc - len * 0.36], [x + sx * 0.05, y + h * 0.3, zc + len * 0.36], 6);
    rivets(b, [x + sx * 0.05, y - h * 0.3, zc - len * 0.36], [x + sx * 0.05, y - h * 0.3, zc + len * 0.36], 6);
  } else if (id === 'door_armor') {
    const sheet = S.steel(0x3a3d40, 0.85);
    plate(b, x + sx * 0.04, y, zc, len * 0.92, h * 1.05, 0.045, sheet, 0, sx * (Math.PI / 2), 0);
    b.box(x + sx * 0.075, y + h * 0.22, zc, 0.01, 0.045, len * 0.62, S.glass(0x10181c));
    b.box(x + sx * 0.075, y - h * 0.05, zc + len * 0.34, 0.016, 0.03, 0.14, S.steel(0x9a9ea2));
    rivets(b, [x + sx * 0.07, y + h * 0.42, zc - len * 0.4], [x + sx * 0.07, y + h * 0.42, zc + len * 0.4], 7);
    rivets(b, [x + sx * 0.07, y - h * 0.42, zc - len * 0.4], [x + sx * 0.07, y - h * 0.42, zc + len * 0.4], 7);
  }
  void look;
}

/** The gap where a door was: a sill rail, the jamb posts, and the seat edge showing through. */
function doorOffKit(b: MeshBuilder, m: Mounts, sx: 1 | -1) {
  if (m.narrow) return;
  const x = sx * (m.hw - 0.07);
  const len = m.side.z1 - m.side.z0;
  const zc = (m.side.z0 + m.side.z1) / 2;
  const h = m.side.y1 - m.side.y0;
  const y = (m.side.y0 + m.side.y1) / 2;
  const steelDark = S.steel(0x2a2c2e, 0.85);
  b.rbox(x, m.side.y0 + 0.02, zc, 0.15, 0.07, len, 0.02, steelDark);
  for (const z of [m.side.z0 + 0.03, m.side.z1 - 0.03]) b.rbox(x, y, z, 0.12, h, 0.06, 0.015, steelDark);
  // The hinges are still on the post, with nothing hanging off them.
  for (const dy of [0.28, -0.28]) b.cyl(x + sx * 0.05, y + dy * h, m.side.z1 - 0.03, 0.04, 0.09, 0.04, S.steel(0x7a7e82, 0.5), 0, 0, 0, 8);
  // The edge of the seat cushion.
  b.rbox(sx * (m.hw - 0.4), m.side.y0 + 0.13, zc + 0.05, 0.5, 0.17, 0.5, 0.05, S.leather(0x3a3228, 0.8));
}

/**
 * The engine bay with the bonnet off: the whole engine on show, sized for what it is. A big V8 stands up tall, a diesel
 * has its injector lines, a blown engine its supercharger, and a stripped bay is empty rails.
 */
function bayKit(b: MeshBuilder, m: Mounts, look: KitLook, floor: number) {
  const h = m.hood;
  if (!h) return;
  const e = look.engine;
  const c = look.cooling;
  const zc = (h.z0 + h.z1) / 2;
  const len = h.z1 - h.z0;
  const hw = h.hw;
  const tray = S.steel(0x1c1e20, 0.8);
  b.rbox(0, floor, zc, hw * 2, 0.04, len, 0.01, tray);
  for (const sx of [1, -1]) {
    b.rbox(sx * (hw - 0.04), floor + 0.1, zc, 0.07, 0.16, len, 0.02, S.steel(0x34383b, 0.8));
    b.cyl(sx * (hw - 0.12), floor + 0.2, h.z1 - 0.28, 0.14, 0.2, 0.14, S.steel(0x2a2c2e, 0.8), 0, 0, 0, 10);
  }
  // Radiator support and the factory core (an aftermarket one is drawn by `coolingKit`, in the grille).
  b.rbox(0, floor + 0.18, h.z1 - 0.05, hw * 1.7, 0.32, 0.05, 0.015, S.steel(0x34383b, 0.8));
  if (c && !c.empty && c.mk <= 0) {
    b.rbox(0, floor + 0.18, h.z1 - 0.09, hw * 1.5, 0.28, 0.06, 0.012, S.steel(0x3a3d40, 0.7));
    for (let i = 0; i < 12; i++) b.box(-hw * 0.7 + i * ((hw * 1.4) / 11), floor + 0.18, h.z1 - 0.12, 0.01, 0.25, 0.01, S.steel(0x1c1d1f, 0.6));
  }
  if (!e || e.empty) {
    // Empty mounts: two cross-members and the bolts where it sat.
    for (const dz of [-0.2, 0.2]) b.box(0, floor + 0.07, zc + dz * len, hw * 1.7, 0.05, 0.06, S.steel(0x4a4d50, 0.8));
    return;
  }
  const sz = Math.max(0, e.size);
  const bw = Math.min(hw * 0.88, 0.16 + 0.045 * sz);
  const bl = Math.min(len * 0.8, 0.34 + 0.11 * sz);
  const bh = 0.13 + 0.035 * sz;
  const ze = zc - len * 0.03;
  const y0 = floor + 0.1;
  const block = S.metal(e.blown ? 0x3a3d40 : 0x4a4e52, 0.6);
  b.rbox(0, y0 + bh / 2, ze, bw * 1.5, bh, bl, 0.03, block);
  const cover = e.mk >= 3 ? S.paint(0xd62a1a, 0.4) : e.mk === 2 ? S.paint(0x2a7a3a, 0.4) : S.metal(0x8a8e92, 0.5);
  if (sz >= 3) {
    // Two banks of cylinders in a V.
    for (const sx of [1, -1]) {
      b.rbox(sx * bw * 0.42, y0 + bh + 0.03, ze, bw * 0.62, 0.08, bl * 0.92, 0.02, cover, 0, 0, -sx * 0.32);
      for (let i = 0; i < Math.min(4, sz); i++) b.cyl(sx * bw * 0.46, y0 + bh + 0.1, ze - bl * 0.34 + i * (bl * 0.68) / Math.max(1, Math.min(4, sz) - 1), 0.04, 0.05, 0.04, S.chrome(), 0, 0, 0, 6);
    }
  } else {
    b.rbox(0, y0 + bh + 0.03, ze, bw * 1.3, 0.08, bl * 0.9, 0.02, cover);
    for (let i = 0; i < 4; i++) b.cyl(-bw * 0.4 + (i % 2) * bw * 0.8, y0 + bh + 0.09, ze - bl * 0.25 + Math.floor(i / 2) * bl * 0.5, 0.04, 0.05, 0.04, S.chrome(), 0, 0, 0, 6);
  }
  const topY = y0 + bh + 0.12;
  if (e.diesel) {
    // Injector pump on the side, a line to each cylinder, and a turbo on the exhaust.
    b.rbox(-bw * 0.8, y0 + bh * 0.55, ze + bl * 0.1, bw * 0.34, bh * 0.45, bl * 0.28, 0.02, S.metal(0xb89a52, 0.5));
    for (let i = 0; i < 4; i++) b.rod(-bw * 0.8, y0 + bh * 0.8, ze - bl * 0.3 + i * bl * 0.2, -bw * 0.2, y0 + bh + 0.1, ze - bl * 0.3 + i * bl * 0.2, 0.008, S.metal(0xd0d4d8, 0.4), 5);
    b.cyl(bw * 0.95, y0 + bh * 0.6, ze - bl * 0.1, 0.12, 0.11, 0.12, S.steel(0x5a4a3a, 0.8), 0, 0, Math.PI / 2, 12);
    b.cyl(bw * 1.05, y0 + bh * 0.6, ze - bl * 0.1, 0.07, 0.1, 0.07, S.steel(0x2a2c2e, 0.8), 0, 0, Math.PI / 2, 10);
  } else {
    // Air cleaner pot, or carb stacks on a tuned engine.
    if (e.mk >= 2) for (let i = 0; i < 3; i++) b.cyl(-0.07 + i * 0.07, topY + 0.02, ze, 0.065, 0.1, 0.065, S.chrome(), 0, 0, 0, 10);
    else b.cyl(0, topY, ze, bw * 0.9, 0.09, bw * 0.9, S.steel(0x3a3d40, 0.7), 0, 0, 0, 14);
  }
  if (e.blown) {
    b.rbox(0, topY + 0.05, ze, bw * 0.9, 0.14, bl * 0.5, 0.04, S.steel(0x25272a, 0.6));
    b.cyl(0, topY + 0.14, ze + bl * 0.1, bw * 0.55, 0.1, bw * 0.55, S.steel(0x15171a, 0.6), 0, 0, 0, 14);
    b.cyl(0, y0 + bh * 0.5, ze + bl * 0.5 + 0.02, 0.12, 0.04, 0.12, S.steel(0x2a2c2e, 0.6), Math.PI / 2, 0, 0, 12);
  }
  // Headers out of each side, a fan and the belt at the front.
  for (const sx of [1, -1]) b.pipe([[sx * bw * 0.7, y0 + bh * 0.5, ze + bl * 0.3], [sx * (bw + 0.07), y0 + bh * 0.1, ze], [sx * (bw + 0.09), y0 - 0.02, ze - bl * 0.7]], 0.028, S.metal(0x8a5a3a, 0.7), 8);
  const fz = ze + bl / 2 + 0.05;
  b.cyl(0, y0 + bh * 0.5, fz, Math.min(0.34, bw * 1.8), 0.02, Math.min(0.34, bw * 1.8), S.plastic(0x141414, 0.5), Math.PI / 2, 0, 0, 14);
  b.cyl(0, y0 + bh * 0.5, fz - 0.03, 0.06, 0.04, 0.06, S.steel(0x7a7e82, 0.5), Math.PI / 2, 0, 0, 8);
  // Hoses from the radiator, and the battery in the corner.
  b.pipe([[hw * 0.3, floor + 0.3, h.z1 - 0.12], [hw * 0.2, y0 + bh, ze + bl * 0.35]], 0.026, S.rubber(0x1c1c1e), 6);
  b.pipe([[-hw * 0.3, floor + 0.1, h.z1 - 0.12], [-hw * 0.2, y0 + bh * 0.3, ze + bl * 0.35]], 0.026, S.rubber(0x1c1c1e), 6);
  b.rbox(-hw + 0.2, floor + 0.12, h.z0 + 0.2, 0.2, 0.18, 0.28, 0.02, S.plastic(0x1a2a1a, 0.4));
}

// ---------------------------------------------------------------- drivetrain

/**
 * The visible parts of the rest of the machine. Exhaust: a quiet one has a fat can, a free-flow one a chrome tip, race
 * headers run down the sill, and straight-pipe stacks stand behind the cab. Springs: coil-overs in the arches, in a
 * colour for the grade. Gearbox: a bigger driveshaft and transfer case under the floor.
 */
function exhaustKit(b: MeshBuilder, m: Mounts, id: string, off: boolean) {
  const x = m.hw * 0.5;
  const rz = m.rear.z;
  const y = m.sill + 0.04;
  if (off) {
    // The exhaust is gone: an open stub hanging off the manifold.
    b.cyl(x, y + 0.04, rz + 0.3, 0.07, 0.12, 0.07, S.metal(0x3a2a1a, 0.9), Math.PI / 2, 0, 0, 8);
    return;
  }
  const chrome = chromeMat();
  const narrow = !!m.narrow;
  if (id === 'exh_free') {
    b.pipe([[x, y + 0.03, rz + 0.8], [x, y + 0.02, rz - 0.02]], 0.03, S.metal(0x6e5a4a, 0.8), 8);
    b.cyl(x, y + 0.02, rz - 0.04, 0.09, 0.14, 0.09, chrome, Math.PI / 2, 0, 0, 12);
  } else if (id === 'exh_quiet') {
    b.cyl(x, y + 0.02, rz + 0.45, narrow ? 0.12 : 0.2, 0.7, narrow ? 0.12 : 0.2, S.steel(0x4a4d50, 0.8), Math.PI / 2, 0, 0, 14);
    b.pipe([[x, y + 0.02, rz + 0.1], [x, y + 0.02, rz - 0.02]], 0.022, S.metal(0x6e5a4a, 0.8), 8);
  } else if (id === 'exh_race') {
    // Side-exit pipes along the sill, ending behind the front wheel.
    for (const sx of narrow ? [1] : [1, -1]) {
      const px = sx * (m.hw + 0.03);
      b.pipe([[px * 0.9, m.sill + 0.12, m.side.z1 - 0.1], [px, m.sill + 0.02, m.side.z1 - 0.3], [px, m.sill + 0.02, m.side.z0 + 0.15]], 0.04, chrome, 8);
      b.cyl(px, m.sill + 0.02, m.side.z0 + 0.12, 0.1, 0.05, 0.1, S.steel(0x2a2c2e), Math.PI / 2, 0, 0, 10);
    }
  } else if (id === 'exh_stack') {
    const top = (m.roof?.y ?? m.side.y1 + 0.5) + 0.28;
    const z = m.roof ? m.roof.z0 - 0.02 : rz + 0.55;
    for (const sx of narrow ? [1] : [1, -1]) {
      const px = sx * (m.hw + 0.06);
      b.pipe([[sx * x, y, z - 0.3], [px, m.sill + 0.12, z], [px, top, z]], 0.05, chrome, 8);
      b.cyl(px, top + 0.04, z, 0.13, 0.05, 0.13, S.steel(0x2a2c2f), 0, 0, 0, 10);
    }
  }
}

function springKit(b: MeshBuilder, m: Mounts, id: string, wheels: [number, number][]) {
  if (m.narrow) return;
  const col = id === 'sus_air' ? 0x1c1c1e : id === 'sus_long' ? 0x2a7a3a : id === 'sus_heavy' ? 0xe0a01a : 0x3a6ab8;
  const R = m.wheelR;
  for (const [wx, wz] of wheels) {
    const sx = Math.sign(wx) || 1;
    const x = wx - sx * 0.2;
    const y0 = R * 1.3;
    const y1 = R * 2 + 0.15;
    b.cyl(x, (y0 + y1) / 2, wz, 0.06, y1 - y0, 0.06, S.metal(0x8a8e92, 0.4), 0, 0, 0, 8);
    if (id === 'sus_air') {
      b.cyl(x, (y0 + y1) / 2, wz, 0.2, (y1 - y0) * 0.8, 0.2, S.rubber(col), 0, 0, 0, 12);
      for (const t of [0.12, 0.88]) b.torus(x, y0 + (y1 - y0) * t, wz, 0.1, 0.014, S.steel(0x3a3d40), Math.PI / 2, 0, 0, 5, 12);
    } else {
      const n = id === 'sus_long' ? 8 : 6;
      for (let i = 0; i < n; i++) b.torus(x, y0 + 0.03 + i * ((y1 - y0 - 0.06) / (n - 1)), wz, 0.09, 0.013, S.paint(col, 0.35), Math.PI / 2, 0, 0, 5, 12);
      if (id === 'sus_long') b.cyl(x + sx * 0.1, (y0 + y1) / 2, wz, 0.05, (y1 - y0) * 0.6, 0.05, S.paint(col, 0.35), 0, 0, 0, 8);
    }
  }
}

function gearboxKit(b: MeshBuilder, m: Mounts, mk: number) {
  const y = m.sill - 0.02;
  const z0 = m.side.z0;
  const z1 = m.side.z1;
  const col = mk >= 3 ? S.metal(0xb89a52, 0.5) : S.metal(0x6a6e72, 0.6);
  b.cyl(0, y, (z0 + z1) / 2, 0.08, z1 - z0, 0.08, S.steel(0x3a3d40, 0.8), Math.PI / 2, 0, 0, 8);
  b.rbox(0, y + 0.01, (z0 + z1) / 2 + 0.2, 0.28, 0.18, 0.36, 0.03, col);
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
export function addKit(b: MeshBuilder, rig: Rig, m: Mounts, look: KitLook, o: { nativeGun: boolean; wheels?: [number, number][]; bayFloor?: number }) {
  const fit = look.fit;
  paintDetails(b, m, look);
  const arm = mkOf(fit, 'armor');
  if (arm) armorKit(b, m, arm, look);
  const hood = bodyPart(fit, 'hood');
  if (look.engine && !look.engine.empty) engineKit(b, m, look.engine, look, !!hood?.off);
  if (look.cooling) coolingKit(b, m, look.cooling);
  if (m.hood) {
    if (hood?.off) bayKit(b, m, look, o.bayFloor ?? m.hood.y - 0.14);
    else if (hood && !hood.stock) hoodKit(b, m, hood.id, look);
  }
  for (const [slot, sx] of [['doorL', 1], ['doorR', -1]] as const) {
    const d = bodyPart(fit, slot);
    if (!d) continue;
    if (d.off) doorOffKit(b, m, sx);
    else if (!d.stock) doorKit(b, m, sx, d.id, look);
  }
  const exh = fit.exhaust ? partDef(fit.exhaust.id) : null;
  if (exh && !exh.stock) exhaustKit(b, m, exh.id, !!exh.empty);
  const sus = fit.suspension ? partDef(fit.suspension.id) : null;
  if (sus && !sus.stock && !sus.empty && o.wheels) springKit(b, m, sus.id, o.wheels);
  const gbx = fit.gearbox ? partDef(fit.gearbox.id) : null;
  if (gbx && !gbx.stock && !gbx.empty && gbx.mk >= 2) gearboxKit(b, m, gbx.mk);
  const wpn = mkOf(fit, 'weapon');
  if (wpn || o.nativeGun) weaponKit(b, rig, m, wpn, o.nativeGun);
  const utl = mkOf(fit, 'utility');
  if (utl) utilityKit(b, m, utl, look);
  // Bolt-on modules are marked, so a hard enough knock can tear them off the merged body.
  const one = (slot: 'front' | 'roof' | 'rear', pivot: [number, number, number], draw: (id: string) => void) => {
    const it = fit[slot];
    if (!it) return;
    b.mark(partTag('slot', slot), partMeta({ kind: 'slot', id: it.id, slot, mk: partDef(it.id).mk, pivot }));
    draw(it.id);
    b.end();
  };
  one('front', [0, m.front.y, m.front.z - 0.05], (id) => frontKit(b, m, id));
  one('roof', [0, m.roof?.y ?? 1, m.roof ? (m.roof.z0 + m.roof.z1) / 2 : 0], (id) => roofKit(b, rig, m, id, look));
  one('rear', [0, m.rear.y + 0.25, m.rear.z], (id) => rearKit(b, m, id, look));
  if (fit.side) sideKit(b, m, fit.side.id);
}

/** A stable string for the parts fitted, used in shell cache keys. */
export function fitSignature(fit: Fit): string {
  return Object.keys(fit)
    .sort()
    .map((k) => `${k}:${fit[k as keyof Fit]!.id}`)
    .join(',');
}
