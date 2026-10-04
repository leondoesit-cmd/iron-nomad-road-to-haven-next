import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { crate, heavyGun, jerryCan, plate, rivets, spareTyre, strap } from './parts';
import { isInteriorSlot, partDef } from '../data';
import { cabinPartModel } from './cabinModels';
import { drawEngine } from './engineModels';
import { holderPartModel, isHolderModel } from './cargoParts';

/**
 * What a vehicle part looks like off the car: the thing you lift, carry, hover over its mount and bolt on. One shape per
 * part, so an engine is an engine block and tyres are tyres rather than every part being the same crate. Model origin is
 * the middle of the base, +Z forward, and each is about half a metre to a metre across so it reads in the arms.
 */

const steel = (c = 0x6a6e72, w = 0.6) => S.steel(c, w);
const dark = () => S.steel(0x2c2f31, 0.6);
const brass = () => S.metal(0xb89a52, 0.45);

function wheels(b: MeshBuilder, mk: number) {
  // A pair of tyres, one standing and one leant against it. The better the set, the fatter and knobblier.
  const r = 0.34 + mk * 0.02;
  const w = 0.22 + mk * 0.05;
  spareTyre(b, 0, r, 0, r, w, 0, Math.PI / 2);
  spareTyre(b, -0.04, r * 0.9 + 0.2, -0.34, r * 0.95, w, -0.35, Math.PI / 2);
  if (mk >= 3) {
    // Beadlock ring bolts around the rim.
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      b.cyl(w * 0.5 + 0.03, r + Math.sin(a) * r * 0.62, Math.cos(a) * r * 0.62, 0.035, 0.03, 0.035, S.chrome(), 0, 0, Math.PI / 2, 6);
    }
  } else if (mk === 2) {
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      b.rod(w * 0.5 + 0.02, r, 0, w * 0.5 + 0.02, r + Math.sin(a) * r * 0.62, Math.cos(a) * r * 0.62, 0.016, steel(0x2a2a2a), 6);
    }
  }
}

function armour(b: MeshBuilder, mk: number) {
  const col = mk >= 3 ? S.paint(0xaeb2ae, 0.45) : mk === 2 ? S.steel(0x4d5154, 0.75) : S.steel(0x6e7276, 0.8);
  const rust = S.rust(0x6a3a22);
  // A stack of plates leaning together, with the hardware to hold them.
  plate(b, 0, 0.36, 0.0, 0.8, 0.55, 0.03 + mk * 0.008, col, -0.18, 0, 0);
  plate(b, 0.02, 0.34, -0.06, 0.74, 0.5, 0.03 + mk * 0.008, mk === 1 ? rust : col, -0.12, 0.05, 0);
  if (mk >= 2) plate(b, 0, 0.32, -0.12, 0.7, 0.46, 0.03 + mk * 0.008, col, -0.07, -0.04, 0);
  for (const sx of [1, -1]) b.rod(sx * 0.3, 0.02, -0.16, sx * 0.3, 0.02, 0.1, 0.02, dark(), 6);
  if (mk >= 3) b.box(0, 0.66, 0.1, 0.5, 0.04, 0.04, S.paint(0x9a9e9a, 0.5));
}

function weapon(b: MeshBuilder, mk: number) {
  b.box(0, 0.03, 0, 0.5, 0.06, 0.5, dark());
  b.box(0, 0.2, 0, 0.07, 0.34, 0.07, dark());
  const place = (x: number, scale: number, shield: boolean) => {
    const gun = new MeshBuilder();
    heavyGun(gun, 0.9, shield);
    b.appendMatrix(gun, new THREE.Matrix4().compose(new THREE.Vector3(x, 0.4, -0.2), new THREE.Quaternion(), new THREE.Vector3(scale, scale, scale)));
  };
  if (mk <= 1) place(0, 0.75, false);
  else if (mk === 2) {
    place(-0.17, 0.7, false);
    place(0.17, 0.7, false);
  } else place(0, 1.0, true);
}

function utility(b: MeshBuilder, mk: number) {
  if (mk === 1) {
    // Rack of cans with a strap.
    b.box(0, 0.03, 0, 0.7, 0.04, 0.34, dark());
    jerryCan(b, -0.2, 0.05, 0, 0x55603e, 0.2);
    jerryCan(b, 0.2, 0.05, 0, 0xb0301e, -0.2);
    strap(b, [[-0.34, 0.05, 0.14], [-0.34, 0.42, 0.14], [0.34, 0.42, 0.14], [0.34, 0.05, 0.14]]);
  } else {
    // A cylindrical tank on straps, a second bank beside it at the top end.
    const n = mk >= 3 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const z = (i - (n - 1) / 2) * 0.34;
      b.cyl(0, 0.2, z, 0.3, 0.7, 0.3, steel(0x6a6e72, 0.55), 0, 0, Math.PI / 2, 18);
      b.cyl(0.36, 0.2, z, 0.22, 0.04, 0.22, steel(0x3a3c3e), 0, 0, Math.PI / 2, 12);
      for (const x of [-0.2, 0.2]) b.box(x, 0.2, z, 0.04, 0.34, 0.06, dark());
    }
    b.pipe([[-0.25, 0.4, 0], [-0.1, 0.55, 0.1], [0.2, 0.5, 0.05]], 0.015, S.rubber(0x1c1c1e), 6);
  }
}

function front(b: MeshBuilder, id: string) {
  const tube = steel(0x34373a, 0.7);
  if (id === 'fr_bull') {
    for (const sx of [1, -1]) {
      b.pipe([[sx * 0.4, 0.04, -0.12], [sx * 0.42, 0.12, 0.08], [sx * 0.42, 0.52, 0.06], [sx * 0.28, 0.66, -0.06]], 0.032, tube, 8);
      b.rod(sx * 0.14, 0.12, 0.08, sx * 0.14, 0.52, 0.04, 0.026, tube, 8);
    }
    b.rod(-0.42, 0.5, 0.06, 0.42, 0.5, 0.06, 0.032, tube, 8);
    b.rod(-0.42, 0.14, 0.08, 0.42, 0.14, 0.08, 0.032, tube, 8);
    b.rod(-0.28, 0.66, -0.06, 0.28, 0.66, -0.06, 0.028, tube, 8);
  } else if (id === 'fr_blade') {
    plate(b, 0, 0.36, 0.1, 0.9, 0.7, 0.06, steel(0x6a6e72, 0.85), -0.35, 0, 0);
    for (const sx of [1, -1]) b.rod(sx * 0.3, 0.1, -0.2, sx * 0.3, 0.3, 0.16, 0.04, steel(0x3a3c3e), 8);
    b.box(0, 0.7, 0.0, 0.88, 0.07, 0.06, S.paint(0xc9a22a, 0.7));
  } else {
    b.rbox(0, 0.2, 0, 0.9, 0.3, 0.1, 0.02, steel(0x5a5e60, 0.8));
    for (let i = 0; i < 7; i++) b.add('cone12', -0.38 + i * 0.127, 0.2, 0.2, 0.08, 0.34, 0.08, steel(0x8a8e92, 0.5), Math.PI / 2, 0, 0);
  }
}

function roof(b: MeshBuilder, id: string) {
  if (id === 'rf_rack') {
    const rail = steel(0x2e3032, 0.65);
    b.pipe([[0.4, 0.1, 0.4], [0.4, 0.1, -0.4], [-0.4, 0.1, -0.4], [-0.4, 0.1, 0.4], [0.4, 0.1, 0.4]], 0.018, rail, 6);
    for (let i = 0; i < 5; i++) b.rod(-0.4, 0.09, -0.4 + i * 0.2, 0.4, 0.09, -0.4 + i * 0.2, 0.012, rail, 6);
    for (const sx of [1, -1]) for (const z of [-0.4, 0.4]) b.rod(sx * 0.4, 0, z, sx * 0.4, 0.1, z, 0.018, rail, 6);
  } else if (id === 'rf_light') {
    b.rbox(0, 0.1, 0, 0.9, 0.1, 0.16, 0.03, S.plastic(0x181818));
    for (let i = 0; i < 4; i++) {
      const x = -0.32 + i * 0.213;
      b.cyl(x, 0.1, 0.08, 0.1, 0.06, 0.1, S.chrome(), Math.PI / 2, 0, 0, 12);
      b.sphereAt(x, 0.1, 0.12, 0.04, S.glow(0xfff2c0, 2.5));
    }
    for (const sx of [1, -1]) b.box(sx * 0.3, 0.02, 0, 0.05, 0.06, 0.1, dark());
  } else {
    const t = S.paint(0x2a2c2e, 0.6);
    for (const z of [-0.3, 0.3]) b.pipe([[-0.4, 0, z], [-0.38, 0.5, z], [-0.28, 0.66, z], [0.28, 0.66, z], [0.38, 0.5, z], [0.4, 0, z]], 0.028, t, 8);
    for (const sx of [1, -1]) b.pipe([[sx * 0.28, 0.66, -0.3], [sx * 0.28, 0.66, 0.3]], 0.026, t, 8);
    b.rod(-0.28, 0.66, -0.3, 0.28, 0.66, 0.3, 0.02, t, 6);
  }
}

function rear(b: MeshBuilder, id: string, mk: number) {
  if (id === 'rr_spare') {
    b.box(0, 0.12, 0, 0.22, 0.2, 0.06, dark());
    spareTyre(b, 0, 0.42, -0.1, 0.34, 0.2, Math.PI / 2, 0);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      b.cyl(Math.cos(a) * 0.06, 0.42 + Math.sin(a) * 0.06, -0.21, 0.03, 0.025, 0.03, steel(0x5a5d60), Math.PI / 2, 0, 0, 6);
    }
  } else if (id === 'rr_wing') {
    for (const sx of [1, -1]) {
      b.rod(sx * 0.3, 0, 0, sx * 0.3, 0.3, 0, 0.02, dark(), 6);
      b.box(sx * 0.48, 0.34, 0, 0.025, 0.12, 0.34, S.paint(0xb0301e, 0.4));
    }
    b.rbox(0, 0.33, 0, 0.98, 0.025, 0.32, 0.01, S.paint(0x1e1e20, 0.4), -0.12, 0, 0);
  } else {
    const col = steel(0x4a4e50, 0.75);
    b.rbox(0, 0.26, 0, 0.82, 0.5, 0.6, 0.03, col);
    b.box(0, 0.52, 0, 0.86, 0.02, 0.62, dark());
    rivets(b, [-0.36, 0.5, 0.26], [0.36, 0.5, 0.26], 7);
    b.box(0, 0.3, 0.31, 0.14, 0.05, 0.02, S.metal(0xaaaaaa));
    void mk;
  }
}

function side(b: MeshBuilder, id: string) {
  if (id === 'sd_skirt') {
    const t = steel(0x34373a, 0.7);
    b.pipe([[0, 0.1, -0.5], [0, 0.1, 0.5]], 0.04, t, 8);
    for (let i = 0; i < 4; i++) b.rod(0, 0.1, -0.42 + i * 0.28, 0, 0.3, -0.42 + i * 0.28, 0.02, t, 6);
  } else if (id === 'sd_plate') {
    plate(b, 0, 0.28, 0.2, 0.5, 0.4, 0.03, steel(0x4c5154, 0.8), 0, Math.PI / 2, 0);
    plate(b, 0.02, 0.26, -0.28, 0.6, 0.42, 0.03, S.rust(0x6a3a22), 0, Math.PI / 2, 0);
  } else {
    const c = S.chrome(0xc4c8cc);
    b.pipe([[0, 0.12, 0.5], [0.02, 0.08, 0], [0, 0.12, -0.5]], 0.036, c, 8);
    b.box(0.02, 0.2, 0, 0.03, 0.08, 0.7, steel(0x2a2c2e, 0.5));
    b.cyl(0, 0.12, -0.52, 0.06, 0.03, 0.06, S.metal(0x1a1612, 0.9), Math.PI / 2, 0, 0, 10);
  }
}

/** Fill `b` with the model of part `id`. */
export function buildPartModel(b: MeshBuilder, id: string) {
  const d = partDef(id);
  b.jitter = 0.03;
  if (isInteriorSlot(d.slot)) return cabinPartModel(b, id);
  // Cargo holders (roof baskets, the net rack, rear cages, bed kits) are drawn by render/cargoParts.ts.
  if (isHolderModel(id)) return holderPartModel(b, id);
  switch (d.slot) {
    case 'engine': return void drawEngine(b, id);
    case 'wheels': return wheels(b, d.mk);
    case 'armor': return armour(b, d.mk);
    case 'weapon': return weapon(b, d.mk);
    case 'utility': return utility(b, d.mk);
    case 'front': return front(b, id);
    case 'roof': return roof(b, id);
    case 'rear': return rear(b, id, d.mk);
    case 'side': return side(b, id);
  }
  crate(b, 0, 0.15, 0, 0.5, 0.3, 0.4);
}
