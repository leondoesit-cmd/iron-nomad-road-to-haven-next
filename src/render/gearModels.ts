import * as THREE from 'three';
import { gearDef, type GearDef } from '../data/gear';
import type { GearItem } from '../sim/gear';
import { lookKey } from '../sim/gunmods';
import { MeshBuilder, S } from './builder';
import { shared } from './dispose';
import { kitMaterial } from './materials';
import { weaponMesh, type Held } from './humanoid';
import { drawBody, drawFace, drawHead, drawPack, type BodyStyle, type FaceStyle, type HeadStyle, type PackStyle, type Piece } from './outfit';

/**
 * Gear as a thing lying in the world: the real gun model (with the add-ons fitted, as in the hand), a blade or tool, an armour
 * or clothing piece as a simple folded or laid-out shape, an add-on as a small solid. `gearModel` returns a group whose origin is
 * on the surface it rests on (lowest point at y = 0, centred in x and z) and whose heading is zero: the caller sets one fixed yaw
 * and a position, and the thing never moves again. A gun lies on its side on the ground (`flat`) or belly down on a rack or bench.
 */

export type LieKind = 'gun' | 'melee' | 'tool' | 'wear' | 'mod';

export interface GearModel {
  group: THREE.Group;
  /** What it is, for tests and for the name tag's height. */
  kind: LieKind;
  /** Height of its highest point over the surface. */
  top: number;
  /** Footprint (x, z) after it is laid down. */
  size: [number, number];
}

const mat = kitMaterial();
const hex = (s: string | undefined, d: number) => (s ? parseInt(s.replace('#', ''), 16) : d);

const wearGeo = new Map<string, { geo: THREE.BufferGeometry; rot: [number, number, number] }>();
const modGeo = new Map<string, THREE.BufferGeometry>();

/** Armour and clothing as simple lying shapes. */
function wearPiece(d: GearDef): { geo: THREE.BufferGeometry; rot: [number, number, number] } {
  const hit = wearGeo.get(d.id);
  if (hit) return hit;
  const L = d.look!;
  const c = hex(L.c, 0x6a6a5a);
  const c2 = hex(L.c2, 0x2a2a2a);
  const b = new MeshBuilder();
  b.jitter = 0.015;
  let rot: [number, number, number] = [0, 0, 0];
  switch (d.slot) {
    case 'head':
      drawHead(b, { style: L.style as HeadStyle, c: L.tint ? undefined : c, c2: L.c2 ? c2 : undefined } as Piece<HeadStyle>, c);
      break;
    case 'face':
      drawFace(b, { style: L.style as FaceStyle, c: L.tint ? undefined : c, c2: L.c2 ? c2 : undefined } as Piece<FaceStyle>, c);
      rot = [-Math.PI / 2, 0, 0];
      break;
    case 'body':
      drawBody(b, { style: L.style as BodyStyle, c: L.tint ? undefined : c, c2: L.c2 ? c2 : undefined } as Piece<BodyStyle>, c, c2);
      rot = [-Math.PI / 2, 0, 0];
      break;
    case 'back':
      drawPack(b, { style: L.style as PackStyle, c, c2: L.c2 ? c2 : undefined } as Piece<PackStyle>);
      rot = [-Math.PI / 2, 0, 0];
      break;
    case 'hands':
      // A pair of gloves, one on top of the other's cuff.
      for (const s of [-1, 1]) {
        b.rbox(s * 0.07, 0.02, 0, 0.09, 0.04, 0.1, 0.012, S.leather(c, 0.5), 0, s * 0.12, 0);
        b.rbox(s * 0.07, 0.02, 0.1, 0.085, 0.032, 0.09, 0.01, S.leather(c, 0.5), 0, s * 0.12, 0);
        b.rbox(s * 0.07, 0.022, -0.075, 0.1, 0.044, 0.05, 0.01, S.cloth(L.style === 'tactical' ? 0x2a2c2e : c, 0.6), 0, s * 0.12, 0);
        if (L.style === 'padded' || L.style === 'tactical') b.rbox(s * 0.07, 0.045, 0.02, 0.07, 0.014, 0.07, 0.006, S.rubber(0x1a1a1c), 0, s * 0.12, 0);
        b.rbox(s * (0.07 + 0.055), 0.02, 0.03, 0.03, 0.025, 0.07, 0.01, S.leather(c, 0.5), 0, s * 0.5, 0);
      }
      break;
    case 'legs':
      // Two trouser legs laid out side by side, a little apart at the cuffs.
      for (const s of [-1, 1]) {
        b.rbox(s * 0.1, 0.045, 0, 0.14, 0.09, 0.86, 0.03, S.cloth(c, 0.55), 0, s * 0.05, 0);
        if (L.style === 'cargo') b.rbox(s * 0.1 + s * 0.015, 0.1, -0.05, 0.12, 0.03, 0.16, 0.01, S.cloth(c, 0.6), 0, s * 0.05, 0);
        if (L.style === 'padded' || L.style === 'greaves') {
          b.rbox(s * 0.1, 0.1, 0.12, 0.14, 0.035, 0.2, 0.015, L.style === 'greaves' ? S.metal(c2, 0.4) : S.rubber(0x1c1d1f), 0, s * 0.05, 0);
          if (L.style === 'greaves') b.rbox(s * 0.1, 0.1, -0.2, 0.14, 0.035, 0.26, 0.015, S.metal(c2, 0.4), 0, s * 0.05, 0);
        }
      }
      b.rbox(0, 0.05, -0.45, 0.4, 0.09, 0.1, 0.02, S.cloth(c, 0.55));
      break;
    case 'feet':
      // A pair of shoes, one toe-in, one on its side.
      for (const s of [-1, 1]) {
        const sole = L.style === 'sneakers' ? c2 : L.style === 'runners' ? c2 : 0x141414;
        b.rbox(s * 0.075, 0.02, 0.0, 0.1, 0.04, 0.3, 0.012, S.rubber(sole), 0, s * 0.1, 0);
        b.rbox(s * 0.075, 0.07, 0.0, 0.095, 0.07, 0.29, 0.03, S.leather(c, 0.5), 0, s * 0.1, 0);
        if (L.style === 'boots' || L.style === 'steel') b.rbox(s * 0.075, 0.16, -0.08, 0.09, 0.14, 0.12, 0.02, S.leather(c, 0.5), 0, s * 0.1, 0);
        if (L.style === 'steel') b.rbox(s * 0.075, 0.075, 0.125, 0.1, 0.06, 0.07, 0.02, S.metal(c2, 0.4), 0, s * 0.1, 0);
      }
      break;
    default:
      b.rbox(0, 0.05, 0, 0.3, 0.1, 0.3, 0.03, S.cloth(c, 0.55));
  }
  const out = { geo: shared(b.build()), rot };
  wearGeo.set(d.id, out);
  return out;
}

/** An add-on loose: a small solid of the right shape for its slot, in the gun's own steel. */
function modPiece(d: GearDef): THREE.BufferGeometry {
  const hit = modGeo.get(d.id);
  if (hit) return hit;
  const m = d.mod!;
  const b = new MeshBuilder();
  b.jitter = 0.01;
  const steel = S.metal(0x2a2c30, 0.4);
  const dark = S.plastic(0x16171a, 0.3);
  const HALF = Math.PI / 2;
  const big = m.look.includes('8') || m.look.includes('_l') || m.look.includes('long') ? 1.25 : 1;
  switch (m.slot) {
    case 'optic':
      b.cyl(0, 0.03, 0, 0.05, 0.2 * big, 0.05, steel, HALF, 0, 0, 12);
      b.cyl(0, 0.03, 0.1 * big, 0.065, 0.03, 0.065, dark, HALF, 0, 0, 12);
      b.box(0, 0.005, 0, 0.03, 0.02, 0.08, steel);
      break;
    case 'muzzle':
      b.cyl(0, 0.03, 0, 0.055, m.look.includes('can') || m.look.includes('supp') ? 0.24 : 0.09, 0.055, steel, HALF, 0, 0, 12);
      break;
    case 'barrel':
      b.cyl(0, 0.02, 0, 0.03, 0.5, 0.03, steel, HALF, 0, 0, 10);
      b.box(0, 0.02, -0.2, 0.06, 0.04, 0.07, steel);
      break;
    case 'under':
      b.rbox(0, 0.06, 0, 0.04, 0.12, 0.05, 0.01, dark, -0.15, 0, 0);
      b.box(0, 0.01, 0, 0.05, 0.02, 0.1, steel);
      break;
    case 'mag':
      if (m.look.includes('drum')) b.cyl(0, 0.05, 0, 0.17, 0.08, 0.17, steel, 0, 0, 0, 14);
      else b.rbox(0, 0.05, 0, 0.04, 0.17, 0.07, 0.008, steel, 0.12, 0, 0);
      break;
    case 'stock':
      b.rbox(0, 0.04, 0, 0.045, 0.08, 0.3, 0.012, dark, -0.1, 0, 0);
      b.rbox(0, 0.04, -0.15, 0.05, 0.12, 0.03, 0.008, S.rubber(0x1a1a1c), -0.1, 0, 0);
      break;
    default:
      b.rbox(0, 0.025, 0, 0.05, 0.05, 0.12, 0.01, steel);
      b.cyl(0, 0.03, 0.07, 0.045, 0.02, 0.045, S.glow(0xfff0b0, 2), HALF, 0, 0, 10);
  }
  const g = shared(b.build());
  modGeo.set(d.id, g);
  return g;
}

/** The solid for any gear item, before it is laid down, and how it is turned to lie. */
function solid(item: GearItem, flat: boolean): { mesh: THREE.Mesh; kind: LieKind } {
  const d = gearDef(item.id);
  if (d.gun) {
    const m = weaponMesh(d.gun.model as Exclude<Held, 'none'>, lookKey(item.att));
    // A gun on the ground lies on its flank, a gun on a rack or counter stays belly down.
    if (flat) m.rotation.z = Math.PI / 2;
    return { mesh: m, kind: 'gun' };
  }
  if (d.melee) {
    const m = weaponMesh(d.melee.model);
    m.rotation.z = Math.PI / 2;
    return { mesh: m, kind: 'melee' };
  }
  if (d.tool) {
    const m = weaponMesh(d.tool);
    m.rotation.z = d.tool === 'jerrycan' ? 0 : Math.PI / 2;
    return { mesh: m, kind: 'tool' };
  }
  if (d.mod) return { mesh: new THREE.Mesh(modPiece(d), mat), kind: 'mod' };
  const w = wearPiece(d);
  const m = new THREE.Mesh(w.geo, mat);
  m.rotation.set(...w.rot);
  return { mesh: m, kind: 'wear' };
}

/** The model of an item lying down, resting on y = 0. */
export function gearModel(item: GearItem, opts: { flat?: boolean } = {}): GearModel {
  const { mesh, kind } = solid(item, opts.flat ?? true);
  const group = new THREE.Group();
  group.add(mesh);
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  mesh.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  group.updateMatrixWorld(true);
  return { group, kind, top: box.max.y - box.min.y, size: [box.max.x - box.min.x, box.max.z - box.min.z] };
}
