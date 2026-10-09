import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { applyKit, kitMaterial } from './materials';
import { shared } from './dispose';
import { PLANT_SWAY_GLSL, plantUniforms, type PlantWind } from './wind';
import { FORAGE, FORAGE_KINDS, type ForageKind, type Shroom } from '../sim/forage';
import type { ForageSpot } from '../world/forage';
import type { PhysicsWorld } from '../physics/physics';
import { PLANT_MECHANICS, type VegetationMemory } from '../sim/vegetation';
import { Vegetation, type VegetationPlant } from './vegetation';

/**
 * Wild food and herbs as they stand: one instanced mesh per plant (the bush, the pads, the tuft) and one per crop (the figs,
 * the berries, the fruit on the pads, the flower heads, the caps). Picking takes the crop away a handful at a time, so a
 * stripped bramble is just green, and a mushroom patch that is not fruiting today shows nothing at all.
 */

const rnd = (seed: number) => {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

/** A point on an ellipsoid's upper skin: where fruit hangs on a shrub. */
function onCrown(r: () => number, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number): [number, number, number] {
  const a = r() * Math.PI * 2;
  const up = 0.15 + r() * 0.8;
  const h = Math.sqrt(1 - up * up);
  return [cx + Math.cos(a) * h * rx * 1.02, cy + (up - 0.25) * ry, cz + Math.sin(a) * h * rz * 1.02];
}

// ------------------------------------------------------------------------------------------ plants

function figPlant(): MeshBuilder {
  const b = new MeshBuilder();
  const r = rnd(41);
  const bark = S.wood(0x8a8478, 0.3);
  // Several smooth grey stems out of one root, the way a wild fig grows as a big shrub.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + r() * 0.5;
    const lean = 0.35 + r() * 0.35;
    b.limb(0, 0, 0, Math.cos(a) * lean, 1.1 + r() * 0.4, Math.sin(a) * lean, 0.07, 0.04, bark, 6);
  }
  const leaf = S.cloth(0x36562a, 0.25);
  const leaf2 = S.cloth(0x42622e, 0.25);
  for (let i = 0; i < 9; i++) {
    const a = r() * Math.PI * 2;
    const d = 0.25 + r() * 0.55;
    b.add('sphere', Math.cos(a) * d, 1.15 + r() * 0.65, Math.sin(a) * d, 0.9 + r() * 0.4, 0.55 + r() * 0.3, 0.9 + r() * 0.4, i % 2 ? leaf : leaf2, 0, a, 0);
  }
  b.displace(0.05, 3.2, 41, 0);
  b.groundShade(0, 0.5, 0.3);
  return b;
}

function brambleePlant(): MeshBuilder {
  const b = new MeshBuilder();
  const r = rnd(57);
  // A low mound of leaves, wider than it is tall.
  const leaf = S.cloth(0x35552a, 0.3);
  const leaf2 = S.cloth(0x47652f, 0.3);
  for (let i = 0; i < 16; i++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * 0.8;
    const h = 0.25 + (1 - d / 0.8) * 0.45 + r() * 0.12;
    b.add('sphere', Math.cos(a) * d, h, Math.sin(a) * d, 0.6 + r() * 0.3, 0.42 + r() * 0.15, 0.6 + r() * 0.3, i % 3 ? leaf : leaf2, 0, a, 0);
  }
  b.displace(0.05, 4, 57, 0);
  // A few thin canes arching out of it and back down to root at the edge, the way brambles creep.
  const cane = S.wood(0x6a3a30, 0.3);
  for (let i = 0; i < 5; i++) {
    const a = r() * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const L = 1.0 + r() * 0.3;
    b.pipe(
      [
        [ca * 0.55, 0.65, sa * 0.55],
        [ca * 0.8, 0.72, sa * 0.8],
        [ca * L, 0.45, sa * L],
        [ca * (L + 0.12), 0.05, sa * (L + 0.12)],
      ],
      0.011,
      cane,
      4,
    );
    b.add('sphere', ca * (L - 0.05), 0.42, sa * (L - 0.05), 0.2, 0.14, 0.2, leaf2, 0, a, 0);
  }
  b.groundShade(0, 0.4, 0.35);
  return b;
}

/**
 * Pads, each a flattened oval, every new one growing off the edge of an older one and turned a little from it, so the
 * clump sprawls out and up the way an old sabra hedge does. Fills `rims` with the pad tops where fruit sits.
 */
function sabraPlant(rims: [number, number, number][] = []): MeshBuilder {
  const b = new MeshBuilder();
  const r = rnd(73);
  const pad = S.cloth(0x6f8a4c, 0.35);
  const pad2 = S.cloth(0x7c9658, 0.35);
  const old = S.wood(0x8a7a5a, 0.5);
  const W = 0.21;
  const H = 0.27;
  type P = { c: THREE.Vector3; yaw: number; roll: number; s: number; d: number };
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  /** A point on a pad's rim, `phi` round from its top, in the world. */
  const rim = (p: P, phi: number, out: THREE.Vector3) => {
    e.set(0, p.yaw, p.roll, 'XYZ');
    return out.set(Math.sin(phi) * W * p.s, Math.cos(phi) * H * p.s, 0).applyEuler(e).add(p.c);
  };
  // Old woody trunks at the base, three clumps of pads off them.
  const pads: P[] = [];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + r() * 0.8;
    const bx = Math.cos(a) * 0.25;
    const bz = Math.sin(a) * 0.25;
    b.limb(0, 0, 0, bx, 0.35, bz, 0.11, 0.08, old, 7);
    pads.push({ c: new THREE.Vector3(bx, 0.35 + H * 1.15, bz), yaw: a + Math.PI / 2 + (r() - 0.5) * 0.6, roll: (r() - 0.5) * 0.4, s: 1.15, d: 0 });
  }
  for (let i = 0; i < 40 && pads.length < 30; i++) {
    const p = pads[Math.floor(r() * pads.length)];
    if (p.d >= 4) continue;
    // Off the upper rim, leaning outward from where it grows.
    const phi = (r() - 0.5) * 2.2;
    const s = p.s * (0.8 + r() * 0.14);
    const at = rim(p, phi, new THREE.Vector3());
    const roll = p.roll - phi * 0.85;
    const yaw = p.yaw + (r() - 0.5) * 1.4;
    e.set(0, yaw, roll, 'XYZ');
    v.set(0, H * s * 0.92, 0).applyEuler(e);
    const c = at.clone().add(v);
    if (c.y < 0.3) continue;
    pads.push({ c, yaw, roll, s, d: p.d + 1 });
  }
  for (const p of pads) {
    b.add('sphere16', p.c.x, p.c.y, p.c.z, W * 2 * p.s, H * 2 * p.s, 0.075 * p.s, p.d % 2 ? pad : pad2, 0, p.yaw, p.roll);
    // Fruit stands on the top rim of the outer pads.
    if (p.d >= 2) for (const phi of [-0.45, 0, 0.45]) if (r() < 0.6) rims.push(rim(p, phi, v).toArray() as [number, number, number]);
  }
  b.groundShade(0, 0.5, 0.3);
  return b;
}

function zaatarPlant(): MeshBuilder {
  const b = new MeshBuilder();
  const r = rnd(91);
  const g = S.cloth(0x7d8a68, 0.3);
  const g2 = S.cloth(0x6b7a58, 0.3);
  for (let i = 0; i < 9; i++) {
    const a = r() * Math.PI * 2;
    const d = r() * 0.22;
    b.add('sphere', Math.cos(a) * d, 0.14 + r() * 0.16, Math.sin(a) * d, 0.22, 0.2 + r() * 0.1, 0.22, i % 2 ? g : g2);
  }
  for (let i = 0; i < 8; i++) {
    const a = r() * Math.PI * 2;
    b.rod(0, 0.1, 0, Math.cos(a) * 0.22, 0.38 + r() * 0.12, Math.sin(a) * 0.22, 0.008, S.wood(0x6a5a40), 4);
  }
  b.groundShade(0, 0.3, 0.3);
  return b;
}

function yarrowPlant(): MeshBuilder {
  const b = new MeshBuilder();
  const r = rnd(103);
  // Feathery leaves low down.
  const leaf = S.cloth(0x4f7a38, 0.25);
  for (let i = 0; i < 7; i++) {
    const a = r() * Math.PI * 2;
    b.add('sphere', Math.cos(a) * 0.12, 0.08, Math.sin(a) * 0.12, 0.28, 0.1, 0.12, leaf, 0, a, 0);
  }
  b.groundShade(0, 0.2, 0.3);
  return b;
}

/** Leaf litter under a mushroom patch: a dark, flat ring of old leaves and a fallen twig. */
function litterPlant(): MeshBuilder {
  const b = new MeshBuilder();
  const r = rnd(117);
  for (let i = 0; i < 6; i++) {
    const a = r() * Math.PI * 2;
    const d = r() * 0.35;
    b.add('cyl10', Math.cos(a) * d, 0.01, Math.sin(a) * d, 0.24 + r() * 0.14, 0.02, 0.2 + r() * 0.14, S.cloth(i % 2 ? 0x4a3c2a : 0x55462f, 0.2));
  }
  b.rod(-0.4, 0.03, -0.1, 0.35, 0.04, 0.2, 0.02, S.wood(0x4a3a2a), 5);
  return b;
}

// ------------------------------------------------------------------------------------------ crops

/** Which share of a crop to build: item `i` belongs to handful `i % of`. */
type Keep = (i: number) => boolean;

function figCrop(keep: Keep): MeshBuilder {
  const b = new MeshBuilder();
  const r = rnd(43);
  for (let i = 0; i < 18; i++) {
    const [x, y, z] = onCrown(r, 0, 1.45, 0, 0.95, 0.65, 0.95);
    if (keep(i)) b.add('sphere', x, y, z, 0.08, 0.1, 0.08, S.plastic(i % 3 ? 0x5a2a4a : 0x7a6a3a, 0.2));
  }
  return b;
}

function brambleCrop(keep: Keep): MeshBuilder {
  const b = new MeshBuilder();
  const r = rnd(59);
  for (let i = 0; i < 34; i++) {
    const [x, y, z] = onCrown(r, 0, 0.55, 0, 0.85, 0.5, 0.85);
    if (keep(i)) b.add('sphere', x, y, z, 0.055, 0.06, 0.055, S.gloss(i % 4 === 0 ? 0x8a1a22 : 0x1a0e1a, 0.1));
  }
  return b;
}

function sabraCrop(keep: Keep): MeshBuilder {
  const b = new MeshBuilder();
  const rims: [number, number, number][] = [];
  sabraPlant(rims);
  const r = rnd(77);
  rims.forEach(([x, y, z], j) => {
    const c = r() < 0.5 ? 0xc0402a : 0xd88a2a;
    if (keep(j)) b.add('sphere16', x, y + 0.035, z, 0.075, 0.1, 0.075, S.plastic(c, 0.25));
  });
  return b;
}

function zaatarCrop(keep: Keep): MeshBuilder {
  const b = new MeshBuilder();
  const r = rnd(93);
  for (let i = 0; i < 14; i++) {
    const a = r() * Math.PI * 2;
    const d = 0.05 + r() * 0.2;
    const h = r();
    if (keep(i)) b.add('sphere', Math.cos(a) * d, 0.34 + h * 0.14, Math.sin(a) * d, 0.05, 0.07, 0.05, S.cloth(i % 3 ? 0xe8e2ee : 0xd8b8d8, 0.1));
  }
  return b;
}

function yarrowCrop(keep: Keep): MeshBuilder {
  const b = new MeshBuilder();
  const r = rnd(107);
  for (let i = 0; i < 5; i++) {
    const a = r() * Math.PI * 2;
    const d = 0.05 + r() * 0.12;
    const h = 0.5 + r() * 0.2;
    if (!keep(i)) continue;
    b.rod(0, 0.05, 0, Math.cos(a) * d, h, Math.sin(a) * d, 0.009, S.cloth(0x5a7a40), 4);
    b.add('cyl10', Math.cos(a) * d, h + 0.02, Math.sin(a) * d, 0.16, 0.04, 0.16, S.cloth(0xf0eee2, 0.1));
  }
  return b;
}

/** A liberty cap's profile (radius, height), unit size: in from the gills' centre, out to the margin, up to the nipple. */
const LIBERTY_CAP: [number, number][] = [
  [0.0, 0.3],
  [0.22, 0.22],
  [0.44, 0.06],
  [0.5, 0.0],
  [0.47, 0.14],
  [0.4, 0.36],
  [0.3, 0.58],
  [0.18, 0.76],
  [0.1, 0.86],
  [0.085, 0.95],
  [0.05, 1.04],
  [0.0, 1.08],
];

const C_LIB_WET = new THREE.Color(0x6e4826);
const C_LIB_TAN = new THREE.Color(0xa9773f);
const C_LIB_DRY = new THREE.Color(0xd8c08e);
const C_LIB_GILL = new THREE.Color(0x3a2c26);
const _lc = new THREE.Color();

/**
 * A troop of liberty caps: little bell-shaped caps drawn up into a nipple, chestnut and wet at the striate margin, drying to
 * tan and cream toward the top (some caps paler than others), dark gills under them, on long thin wavy stems with a blue
 * bruise at the foot, standing in a loose cluster or two in the grass. Somewhat larger than life so they can be found.
 */
function libertyTroop(b: MeshBuilder, r: () => number, keep: Keep) {
  const n = 12;
  // Two or three knots of them, as they come up in a lawn.
  const knots: [number, number][] = [];
  for (let k = 0; k < 3; k++) knots.push([(r() - 0.5) * 0.55, (r() - 0.5) * 0.55]);
  for (let i = 0; i < n; i++) {
    const [kx, kz] = knots[i % knots.length];
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * 0.13;
    const x = kx + Math.cos(a) * d;
    const z = kz + Math.sin(a) * d;
    const s = 0.75 + r() * 0.5;
    const dry = r();
    const lean = (r() - 0.5) * 0.5;
    const yaw = r() * Math.PI * 2;
    const h = (0.085 + r() * 0.06) * s;
    if (!keep(i)) continue;
    // The stem: slender, wavy, pale, leaning a little and curving back up under the cap.
    const lx = Math.cos(yaw) * Math.sin(lean);
    const lz = Math.sin(yaw) * Math.sin(lean);
    const wob = (r() - 0.5) * 0.02;
    const pts: [number, number, number][] = [
      [x, 0, z],
      [x + lx * h * 0.3 + wob, h * 0.34, z + lz * h * 0.3 - wob],
      [x + lx * h * 0.75 - wob, h * 0.7, z + lz * h * 0.75 + wob],
      [x + lx * h * 0.95, h, z + lz * h * 0.95],
    ];
    const sr = 0.0034 * (0.85 + s * 0.3);
    b.rod(pts[0][0], -0.01, pts[0][2], pts[1][0], pts[1][1], pts[1][2], sr * 1.15, S.cloth(0x9fa9b0, 0.05), 5);
    b.rod(pts[1][0], pts[1][1], pts[1][2], pts[2][0], pts[2][1], pts[2][2], sr, S.cloth(0xe2d6b8, 0.05), 5);
    b.rod(pts[2][0], pts[2][1], pts[2][2], pts[3][0], pts[3][1], pts[3][2], sr * 0.9, S.cloth(0xe8dcc0, 0.05), 5);
    // The cap: the margin dark and wet, drying to tan and cream toward the nipple, a damp sheen all over.
    // Half its width (the profile is a unit across), and its height: a bell about as tall as it is wide.
    const cw = (0.021 + r() * 0.009) * s;
    const ch = cw * 2 * (0.8 + r() * 0.3);
    const v0 = b.vertexCount;
    const capGeo = libertyCapGeometry();
    b.geo(capGeo, pts[3][0], pts[3][1] - ch * 0.12, pts[3][2], cw * 2, ch, cw * 2, { c: 0xffffff, r: 0.32, m: 0, w: 0.04 }, lean * 0.7, Math.PI / 2 - yaw, 0);
    const top = _lt.copy(C_LIB_TAN).lerp(C_LIB_DRY, dry * dry);
    const np = LIBERTY_CAP.length;
    for (let v = v0; v < b.vertexCount; v++) {
      // The lathe lays its vertices out a profile at a time, so the profile point says where on the cap this one is.
      const j = (v - v0) % np;
      const t = LIBERTY_CAP[j][1] / 1.08;
      if (j < 3) _lc.copy(C_LIB_GILL);
      else if (t < 0.45) _lc.copy(C_LIB_WET).lerp(top, t / 0.45);
      else if (t < 0.84) _lc.copy(top);
      else _lc.copy(top).lerp(C_LIB_WET, 0.4);
      const o = v * 3;
      b.col[o] = _lc.r;
      b.col[o + 1] = _lc.g;
      b.col[o + 2] = _lc.b;
    }
  }
}

const _lt = new THREE.Color();
let libertyCapGeo: THREE.BufferGeometry | null = null;

function libertyCapGeometry(): THREE.BufferGeometry {
  return (libertyCapGeo ??= new THREE.LatheGeometry(LIBERTY_CAP.map(([x, y]) => new THREE.Vector2(x, y)), 9));
}

/** Short grass round a troop of liberty caps: they grow in the turf, not on bare litter. */
function libertyTurf(): MeshBuilder {
  const b = new MeshBuilder();
  const r = rnd(133);
  const greens = [0x5d7c3c, 0x6e8a44, 0x7f8e4c, 0x8e8a52];
  for (let i = 0; i < 26; i++) {
    const a = r() * Math.PI * 2;
    const d = 0.08 + Math.sqrt(r()) * 0.42;
    const h = 0.07 + r() * 0.08;
    const tilt = 0.15 + r() * 0.45;
    // A blade: a thin flattened cone leaning out from the troop.
    b.add('cone6', Math.cos(a) * d, h * 0.5, Math.sin(a) * d, 0.014, h, 0.004, S.cloth(greens[i % greens.length], 0.1), tilt, a + Math.PI / 2, 0);
  }
  // A little moss at the foot.
  for (let i = 0; i < 4; i++) {
    const a = r() * Math.PI * 2;
    const d = r() * 0.3;
    b.add('sphere', Math.cos(a) * d, 0.0, Math.sin(a) * d, 0.16 + r() * 0.12, 0.025, 0.14 + r() * 0.1, S.cloth(i % 2 ? 0x4e6a30 : 0x5a6e36, 0.15));
  }
  return b;
}

function shroomCrop(sp: Shroom, keep: Keep): MeshBuilder {
  const b = new MeshBuilder();
  const r = rnd(sp === 'field' ? 121 : sp === 'liberty' ? 131 : 141);
  if (sp === 'liberty') {
    libertyTroop(b, r, keep);
    return b;
  }
  const n = 6;
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2;
    const d = 0.05 + r() * 0.32;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const s = 0.7 + r() * 0.5;
    const t = r();
    r();
    if (!keep(i)) continue;
    if (sp === 'field') {
      // Squat white-to-buff caps, pinkish-brown underneath.
      b.add('cyl8', x, 0.04 * s, z, 0.035 * s, 0.08 * s, 0.035 * s, S.cloth(0xf0ebe0));
      b.add('sphere16', x, 0.09 * s, z, 0.13 * s, 0.07 * s, 0.13 * s, S.cloth(t < 0.5 ? 0xece4d4 : 0xd8c8a8, 0.15));
    } else {
      // Tall, pale olive-green caps on white stems with a skirt, out of a white cup at the foot.
      b.add('sphere', x, 0.015 * s, z, 0.06 * s, 0.04 * s, 0.06 * s, S.cloth(0xf2f0e6));
      b.add('cyl8', x, 0.07 * s, z, 0.035 * s, 0.14 * s, 0.035 * s, S.cloth(0xf4f2ea));
      b.add('cyl10', x, 0.11 * s, z, 0.07 * s, 0.012 * s, 0.07 * s, S.cloth(0xf0eee4));
      b.add('sphere16', x, 0.15 * s, z, 0.15 * s, 0.07 * s, 0.15 * s, S.cloth(t < 0.5 ? 0xb8c098 : 0xc8cca8, 0.1));
    }
  }
  return b;
}

// ------------------------------------------------------------------------------------------ the instanced set

type CropKind = Exclude<ForageKind, 'mushroom'> | `mushroom:${Shroom}`;
const CROP_KINDS: CropKind[] = ['fig', 'bramble', 'sabra', 'zaatar', 'yarrow', 'mushroom:field', 'mushroom:liberty', 'mushroom:deathcap'];
const handfulsOf = (k: CropKind): number => FORAGE[k.startsWith('mushroom') ? 'mushroom' : (k as ForageKind)].handfuls;

/** What stands under a crop: the plant itself, or for liberty caps the turf they come up through. */
type PlantKey = ForageKind | 'turf';
const PLANT_KEYS: PlantKey[] = [...FORAGE_KINDS, 'turf'];
const plantOf = (s: ForageSpot): PlantKey => (s.kind === 'mushroom' && s.shroom === 'liberty' ? 'turf' : s.kind);

const plantGeo = new Map<PlantKey, THREE.BufferGeometry>();
const cropGeo = new Map<string, THREE.BufferGeometry>();

function plantGeometry(k: PlantKey): THREE.BufferGeometry {
  let g = plantGeo.get(k);
  if (!g) {
    const b = k === 'fig' ? figPlant() : k === 'bramble' ? brambleePlant() : k === 'sabra' ? sabraPlant() : k === 'zaatar' ? zaatarPlant() : k === 'yarrow' ? yarrowPlant() : k === 'turf' ? libertyTurf() : litterPlant();
    plantGeo.set(k, (g = b.build()));
  }
  return g;
}

/** The share of a crop that is handful `part` of `of`: picking a handful takes exactly that share off the plant. */
function cropGeometry(k: CropKind, part: number, of: number): THREE.BufferGeometry {
  const key = `${k}#${part}`;
  let g = cropGeo.get(key);
  if (!g) {
    const keep: Keep = (i) => i % of === part;
    const b =
      k === 'fig' ? figCrop(keep) : k === 'bramble' ? brambleCrop(keep) : k === 'sabra' ? sabraCrop(keep) : k === 'zaatar' ? zaatarCrop(keep) : k === 'yarrow' ? yarrowCrop(keep) : shroomCrop(k.slice(9) as Shroom, keep);
    cropGeo.set(key, (g = b.build()));
  }
  return g;
}

/** A plant as the renderer needs to know it: where, and how many handfuls are on it now. */
export interface ForageView {
  spot: ForageSpot;
  left: number;
}

const CAP = 512;

/**
 * How each wild plant takes the wind (`plantSway`), with its height (m) to bend over: the fig and the bramble are woody and
 * stiff, the old sabra's pads hardly stir, za'atar and yarrow are herbs that lean and shiver in any breeze. The crop rides
 * its plant (same material, same instance), so the fruit stays on the branch. Mushrooms and turf keep still.
 */
const FORAGE_WIND: Partial<Record<PlantKey, PlantWind & { h: number }>> = {
  fig: { h: 2.0, lean: 0.14, rate: PLANT_MECHANICS.fig.frequency, leaf: 0.05, leafHz: 2.2 },
  bramble: { h: 0.85, lean: 0.18, rate: PLANT_MECHANICS.bramble.frequency, leaf: 0.035, leafHz: 2.6 },
  sabra: { h: 1.6, lean: 0.035, rate: PLANT_MECHANICS.sabra.frequency, leaf: 0.006, leafHz: 1.4 },
  zaatar: { h: 0.5, lean: 0.5, rate: PLANT_MECHANICS.zaatar.frequency, leaf: 0.025, leafHz: 3.0 },
  yarrow: { h: 0.6, lean: 0.6, rate: PLANT_MECHANICS.yarrow.frequency, leaf: 0.03, leafHz: 2.6 },
};

/** A wild plant's vertex work in the wind, in its colour (after the kit's, which keeps its rest pose) and its shadow. */
function forageSway(shader: THREE.WebGLProgramParametersWithUniforms, w: PlantWind & { h: number }, at: string) {
  plantUniforms(shader, w);
  shader.uniforms.uPlantTop = { value: w.h };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${PLANT_SWAY_GLSL}\nuniform float uPlantTop;`)
    .replace(at, `transformed = plantSway( transformed, transformed.y / uPlantTop );\n${at}`);
}

const swayMats = new Map<PlantKey, { colour: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial }>();
/** The kit material, swaying as plant `k` does, and its shadow; null for a plant that keeps still. */
function swayMaterials(k: PlantKey) {
  const w = FORAGE_WIND[k];
  if (!w) return null;
  let hit = swayMats.get(k);
  if (!hit) {
    const colour = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    colour.onBeforeCompile = (shader) => {
      applyKit(shader, true);
      forageSway(shader, w, '#include <project_vertex>');
    };
    colour.customProgramCacheKey = () => 'kit:true|plant';
    const depth = new THREE.MeshDepthMaterial();
    depth.onBeforeCompile = (shader) => forageSway(shader, w, '#include <project_vertex>');
    depth.customProgramCacheKey = () => 'plant-depth';
    swayMats.set(k, (hit = { colour: shared(colour), depth: shared(depth) }));
  }
  return hit;
}

export class ForageRender {
  readonly group = new THREE.Group();
  private plants = new Map<PlantKey, THREE.InstancedMesh>();
  /** Per crop kind, one mesh per handful. */
  private crops = new Map<CropKind, THREE.InstancedMesh[]>();
  private vegetation?: Vegetation;

  constructor(private physics?: PhysicsWorld, private vegetationMemory?: VegetationMemory) {
    this.group.name = 'forage';
    const mat = kitMaterial();
    for (const k of PLANT_KEYS) {
      const sway = swayMaterials(k);
      const m = new THREE.InstancedMesh(plantGeometry(k), sway?.colour ?? mat, CAP);
      if (sway) m.customDepthMaterial = sway.depth;
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = k === 'fig' || k === 'bramble' || k === 'sabra';
      m.receiveShadow = true;
      this.plants.set(k, m);
      this.group.add(m);
    }
    for (const k of CROP_KINDS) {
      const n = handfulsOf(k);
      const list: THREE.InstancedMesh[] = [];
      for (let part = 0; part < n; part++) {
        const m = new THREE.InstancedMesh(cropGeometry(k, part, n), (k.startsWith('mushroom') ? null : swayMaterials(k as ForageKind)?.colour) ?? mat, CAP);
        m.count = 0;
        m.frustumCulled = false;
        m.receiveShadow = true;
        list.push(m);
        this.group.add(m);
      }
      this.crops.set(k, list);
    }
  }

  /** How much of a sight line the bramble, prickly pear and fig thickets let through (see `Vegetation.seeThrough`). */
  seeThrough(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
    return this.vegetation?.seeThrough(ax, ay, az, bx, by, bz) ?? 1;
  }

  private all(): THREE.InstancedMesh[] {
    return [...this.plants.values(), ...[...this.crops.values()].flat()];
  }

  /** Lay out every plant in `views` (all that are loaded). Cheap enough to call whenever any of them changes. */
  set(views: ForageView[]) {
    this.vegetation?.dispose();
    this.vegetation = this.physics ? new Vegetation(this.physics, this.vegetationMemory) : undefined;
    const keys = new Map<THREE.InstancedMesh, string[]>();
    const keyOf = (mesh: THREE.InstancedMesh, key: string) => {
      const list = keys.get(mesh) ?? [];
      list.push(key);
      keys.set(mesh, list);
    };
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    for (const m of this.all()) m.count = 0;
    for (const { spot, left } of views) {
      q.setFromAxisAngle(up, spot.yaw);
      p.set(spot.x, spot.y, spot.z);
      s.setScalar(spot.s);
      m4.compose(p, q, s);
      const pm = this.plants.get(plantOf(spot))!;
      if (pm.count < CAP) {
        keyOf(pm, `forage:${spot.id}`);
        pm.setMatrixAt(pm.count++, m4);
      }
      const key: CropKind = spot.kind === 'mushroom' ? `mushroom:${spot.shroom ?? 'field'}` : spot.kind;
      const parts = this.crops.get(key)!;
      for (let i = 0; i < Math.min(left, parts.length); i++) if (parts[i].count < CAP) {
        keyOf(parts[i], `forage:${spot.id}`);
        parts[i].setMatrixAt(parts[i].count++, m4);
      }
    }
    for (const m of this.all()) m.instanceMatrix.needsUpdate = true;
    if (this.vegetation) {
      const plants = new Map<string, VegetationPlant>();
      for (const [kind, mesh] of this.plants) {
        // Mushroom litter and turf are flat; use the visible caps as their contact mesh below.
        if (kind === 'mushroom' || kind === 'turf') continue;
        for (const p of this.vegetation.addInstances(mesh, kind, keys.get(mesh))) plants.set(p.key, p);
      }
      for (const [kind, meshes] of this.crops) for (const mesh of meshes) {
        const list = keys.get(mesh) ?? [];
        if (kind.startsWith('mushroom') && meshes[0] === mesh) {
          for (const p of this.vegetation.addInstances(mesh, 'mushroom', list)) plants.set(p.key, p);
        } else list.forEach((key, index) => {
          const p = plants.get(key);
          if (p) this.vegetation!.bindCompanion(p, mesh, index);
        });
      }
    }
  }

  dispose() {
    this.vegetation?.dispose();
    for (const m of this.all()) m.dispose();
    this.group.removeFromParent();
  }
}
