import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { C } from './palette';
import { clamp, damp, lerp, wrapAngle } from '../core/math';
import { swingPose } from '../sim/weaponfx';
import { GUN_POINTS } from '../sim/weaponanim';
import type { GunModel } from '../data/gear';
import { shared } from './dispose';
import { kitMaterial } from './materials';
import {
  DEFAULT_LOOK,
  drawBody,
  drawBriefs,
  drawFace,
  drawHand,
  drawHead,
  drawHips,
  drawNeck,
  drawPack,
  drawShin,
  drawThigh,
  drawUpperArm,
  sleeveColor,
  trouserColor,
  type OutfitLook,
} from './outfit';

const mat = kitMaterial();
const basicLight = shared(new THREE.MeshBasicMaterial({ color: 0xfff6d0 }));
const flashMat = shared(new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 4.2, 1.6), transparent: true, opacity: 0.95, depthWrite: false }));
const flashGeo = shared(new THREE.IcosahedronGeometry(0.11, 1));

export type PoseKind = 'stand' | 'ride' | 'seat' | 'downed' | 'gun';

export interface Palette {
  jacket: number;
  trim: number;
  pants?: number;
  skin?: number;
  helmet?: number;
  /** Scarf / bandana colour (defaults to the trim). */
  scarf?: number;
  /** Raider look: skull mask, spiked pauldrons, no backpack. */
  mask?: boolean;
  /** What a survivor wears. Absent: the starter kit, which is how every crew member is drawn. */
  look?: OutfitLook;
  /** An armband in this colour on the left sleeve, so a survivor in borrowed clothes is still recognisably theirs. */
  band?: number;
}

type Part = 'pelvis' | 'torso' | 'head' | 'upperL' | 'upperR' | 'foreL' | 'foreR' | 'thighL' | 'thighR' | 'shinL' | 'shinR';

const partCache = new Map<string, Record<Part, THREE.BufferGeometry>>();

/** Build (once per palette) the eleven body-part meshes of a survivor or raider. Origins sit on the joints. */
function bodyParts(p: Palette): Record<Part, THREE.BufferGeometry> {
  const key = JSON.stringify(p);
  const hit = partCache.get(key);
  if (hit) return hit;
  const raider = !!p.mask;
  const look = p.look ?? DEFAULT_LOOK;
  const jacket = S.cloth(p.jacket, 0.55);
  const trim = S.cloth(p.trim, 0.5);
  const pantsColor = trouserColor(look.legs, p.pants ?? 0x3d3f3a);
  const pants = S.cloth(raider ? (p.pants ?? 0x3d3f3a) : pantsColor, 0.6);
  const skin = S.skin(p.skin ?? C.skin);
  const leather = S.leather(0x3b2a1e, 0.5);
  const boot = S.leather(0x2a211b, 0.6);
  const glove = S.leather(0x2b2622, 0.4);
  const buckle = S.metal(0x8a8478, 0.4);
  const helmet = p.mask ? S.metal(p.helmet ?? 0x111111, 0.5) : S.paint(p.helmet ?? p.trim, 0.6);
  const scarfColor = p.scarf ?? p.trim;
  const sleeve = raider ? jacket : S.cloth(sleeveColor(look.body, p.jacket), 0.55);
  const mk = (fn: (b: MeshBuilder) => void) => {
    const b = new MeshBuilder();
    b.jitter = 0.03;
    b.roundSeg = 2;
    fn(b);
    return shared(b.build());
  };
  const parts: Record<Part, THREE.BufferGeometry> = {
    pelvis: mk((b) => {
      if (!raider && look.legs.style === 'bare') drawBriefs(b);
      else b.rbox(0, -0.02, 0, 0.33, 0.2, 0.21, 0.07, pants);
      // Belt with buckle and pouches.
      b.rbox(0, 0.07, 0, 0.35, 0.055, 0.23, 0.025, leather);
      b.box(0, 0.07, 0.118, 0.06, 0.045, 0.01, buckle);
      for (const sx of [1, -1]) b.rbox(sx * 0.15, 0.03, 0.06, 0.07, 0.09, 0.06, 0.015, raider ? leather : trim);
      b.rbox(-0.1, 0.03, -0.11, 0.1, 0.09, 0.06, 0.015, leather);
      if (!raider) drawHips(b, look.body, p.jacket);
    }),
    torso: mk((b) => {
      if (raider) {
        // Abdomen and chest: a tapered jacket body.
        const jacketDark = S.cloth(new THREE.Color(p.jacket).multiplyScalar(0.62).getHex(), 0.6);
        b.limb(0, 0.06, 0, 0, 0.26, 0, 0.14, 0.16, jacket, 14);
        b.rbox(0, 0.34, 0, 0.4, 0.3, 0.24, 0.1, jacket);
        for (const sx of [1, -1]) b.sphereAt(sx * 0.19, 0.44, 0, 0.085, jacket);
        // Collar and zip.
        b.torus(0, 0.5, 0, 0.085, 0.03, jacketDark, Math.PI / 2, 0, 0, 8, 16);
        b.box(0, 0.3, 0.121, 0.012, 0.36, 0.008, buckle);
        // Leather harness, spiked pauldrons.
        b.box(0.06, 0.3, 0.125, 0.05, 0.4, 0.01, leather, 0, 0, 0.5);
        b.box(-0.06, 0.3, 0.125, 0.05, 0.4, 0.01, leather, 0, 0, -0.5);
        for (const sx of [1, -1]) {
          b.add('dome', sx * 0.2, 0.46, 0, 0.2, 0.14, 0.2, S.metal(0x2a2826, 0.6), 0, 0, -sx * 0.4);
          for (let i = 0; i < 3; i++) b.add('cone6', sx * (0.2 + i * 0.02), 0.52 + i * 0.01, -0.04 + i * 0.04, 0.035, 0.1, 0.035, S.metal(0x9a9a9a, 0.3), 0, 0, -sx * 0.5);
        }
        // Scarf wrapped at the neck.
        drawNeck(b, { style: 'bandana' }, scarfColor);
      } else {
        // The garment, the pack on the back, and the neck wrap.
        drawBody(b, look.body, p.jacket, p.trim);
        drawPack(b, look.pack);
        drawNeck(b, look.face, scarfColor);
      }
      b.capsule(0, 0.54, 0, 0, 0.62, 0, 0.05, skin, 8);
    }),
    head: mk((b) => {
      b.add('sphere16', 0, 0.1, 0.005, 0.19, 0.23, 0.21, skin);
      if (raider) {
        // Bone-white skull mask with dark sockets; spiked crest on the helmet.
        b.add('sphere16', 0, 0.09, 0.03, 0.2, 0.22, 0.2, S.paint(0xd9d2bf, 0.6));
        for (const sx of [1, -1]) b.add('sphere', sx * 0.045, 0.12, 0.122, 0.055, 0.045, 0.02, S.paint(0x0c0a08, 0.2));
        b.box(0, 0.03, 0.125, 0.08, 0.025, 0.02, S.paint(0x0c0a08, 0.2));
        b.add('dome', 0, 0.15, 0, 0.23, 0.17, 0.24, helmet);
        for (let i = 0; i < 5; i++) b.add('cone6', 0, 0.26, -0.08 + i * 0.045, 0.03, 0.09 + (i === 2 ? 0.04 : 0), 0.03, S.metal(0xa0a0a0, 0.3));
      } else {
        // Nose and ears, then whatever covers the face, then what is on top.
        b.add('cone6', 0, 0.11, 0.108, 0.035, 0.05, 0.03, skin, -0.25, 0, 0);
        for (const sx of [1, -1]) b.add('sphere', sx * 0.096, 0.1, 0.0, 0.025, 0.05, 0.035, skin);
        drawFace(b, look.face, scarfColor);
        drawHead(b, look.head, p.helmet ?? p.trim, look.face.style === 'goggles');
        // Eyes and brow under the helmet.
        for (const sx of [1, -1]) b.add('sphere', sx * 0.04, 0.115, 0.098, 0.03, 0.018, 0.012, S.skin(0x1a1410));
      }
    }),
    upperL: mk((b) => {
      upperArm(b, look, sleeve, raider);
      if (p.band) b.torus(0, -0.12, 0, 0.066, 0.018, S.cloth(p.band, 0.4), Math.PI / 2, 0, 0, 6, 12);
    }),
    upperR: mk((b) => upperArm(b, look, sleeve, raider)),
    foreL: mk((b) => (raider ? forearm(b, jacket, glove) : drawHand(b, look.hands, sleeve, skin))),
    foreR: mk((b) => (raider ? forearm(b, jacket, glove) : drawHand(b, look.hands, sleeve, skin))),
    thighL: mk((b) => thigh(b, pants, raider, look, pantsColor, skin, 1)),
    thighR: mk((b) => thigh(b, pants, raider, look, pantsColor, skin, -1)),
    shinL: mk((b) => (raider ? shin(b, pants, boot, true) : drawShin(b, look.legs, look.feet, pantsColor, skin))),
    shinR: mk((b) => (raider ? shin(b, pants, boot, true) : drawShin(b, look.legs, look.feet, pantsColor, skin))),
  };
  partCache.set(key, parts);
  return parts;
}

function upperArm(b: MeshBuilder, look: OutfitLook, sleeve: ReturnType<typeof S.cloth>, raider: boolean) {
  if (raider) {
    b.limb(0, -0.02, 0, 0, -0.27, 0, 0.065, 0.054, sleeve, 10);
    b.box(0, -0.16, 0, 0.13, 0.04, 0.13, S.leather(0x2a1e16, 0.5));
  } else drawUpperArm(b, look.body, sleeve);
}

function forearm(b: MeshBuilder, jacket: ReturnType<typeof S.cloth>, glove: ReturnType<typeof S.leather>) {
  b.limb(0, 0, 0, 0, -0.2, 0, 0.052, 0.044, jacket, 10);
  // Rolled cuff, gloved hand with a thumb.
  b.torus(0, -0.2, 0, 0.045, 0.014, jacket, Math.PI / 2, 0, 0, 6, 12);
  b.rbox(0, -0.27, 0.005, 0.07, 0.11, 0.05, 0.02, glove);
  b.capsule(0.03, -0.24, 0.03, 0.035, -0.28, 0.045, 0.014, glove, 6);
}

function thigh(b: MeshBuilder, pants: ReturnType<typeof S.cloth>, raider: boolean, look: OutfitLook, pantsColor: number, skin: ReturnType<typeof S.skin>, side: number) {
  if (raider) {
    b.limb(0, 0, 0, 0, -0.42, 0, 0.088, 0.066, pants, 12);
    drawThigh(b, { style: 'work' }, pantsColor, side);
    return;
  }
  b.limb(0, 0, 0, 0, -0.42, 0, 0.088, 0.066, look.legs.style === 'bare' ? skin : pants, 12);
  drawThigh(b, look.legs, pantsColor, side);
}

function shin(b: MeshBuilder, pants: ReturnType<typeof S.cloth>, boot: ReturnType<typeof S.leather>, raider: boolean) {
  b.limb(0, 0, 0, 0, -0.3, 0, 0.064, 0.052, pants, 12);
  // Knee pad.
  b.rbox(0, -0.03, 0.055, 0.1, 0.11, 0.04, 0.02, raider ? S.metal(0x3a3632, 0.6) : S.plastic(0x2a2a2a, 0.6));
  // Boot: shaft, laced front, toe cap and sole.
  b.rbox(0, -0.36, 0.0, 0.11, 0.16, 0.12, 0.04, boot);
  b.rbox(0, -0.42, 0.06, 0.105, 0.08, 0.2, 0.035, boot);
  b.rbox(0, -0.465, 0.06, 0.115, 0.025, 0.23, 0.01, S.rubber(0x161412));
  for (let i = 0; i < 4; i++) b.box(0, -0.3 - i * 0.03, 0.06, 0.05, 0.006, 0.01, S.cloth(0x6a5a44, 0.3));
}

// ------------------------------------------------------------------------------------- weapons

export type Held = 'none' | 'pistol' | 'revolver' | 'smg' | 'sawn' | 'pump' | 'rifle' | 'knife' | 'bat' | 'machete' | 'axe' | 'wrench' | 'jerrycan' | 'crowbar' | 'flare';
const weaponCache = new Map<Held, THREE.BufferGeometry>();
const _ra = new THREE.Vector3();
const _fr = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();

function weaponGeometry(kind: Exclude<Held, 'none'>): THREE.BufferGeometry {
  const hit = weaponCache.get(kind);
  if (hit) return hit;
  const b = new MeshBuilder();
  b.jitter = 0.02;
  const gun = S.metal(0x232426, 0.35);
  const grip = S.plastic(0x1a1a1a, 0.3);
  const dot = S.plastic(0xe8e4d8, 0.4);
  switch (kind) {
    case 'pistol':
      b.rbox(0, 0.03, 0.12, 0.034, 0.05, 0.22, 0.008, gun);
      b.rbox(0, -0.035, 0.04, 0.03, 0.11, 0.05, 0.008, grip, -0.25, 0, 0);
      b.box(0, -0.0, 0.085, 0.012, 0.03, 0.04, gun);
      b.cyl(0, 0.035, 0.235, 0.014, 0.02, 0.014, S.metal(0x0a0a0a), Math.PI / 2, 0, 0, 8);
      // Iron sights: a rear notch (two blocks) and a front post, with a pale dot on the post to find it by.
      for (const sx of [1, -1]) b.box(sx * 0.0085, 0.063, 0.03, 0.007, 0.016, 0.012, gun);
      b.box(0, 0.064, 0.225, 0.006, 0.018, 0.01, gun);
      b.box(0, 0.0725, 0.2255, 0.004, 0.004, 0.004, dot);
      break;
    case 'revolver': {
      const wood = S.wood(0x5a3e28, 0.5);
      b.rbox(0, 0.035, 0.1, 0.036, 0.05, 0.17, 0.008, gun);
      b.cyl(0, 0.04, 0.225, 0.022, 0.15, 0.022, gun, Math.PI / 2, 0, 0, 8);
      b.cyl(0, 0.03, 0.085, 0.052, 0.07, 0.052, S.metal(0x2c2e30, 0.35), Math.PI / 2, 0, 0, 10);
      b.rbox(0, -0.04, 0.03, 0.032, 0.105, 0.048, 0.01, wood, -0.3, 0, 0);
      b.box(0, 0.068, 0.0, 0.012, 0.025, 0.03, gun);
      b.box(0, 0.07, 0.2, 0.01, 0.014, 0.18, gun);
      for (const sx of [1, -1]) b.box(sx * 0.0085, 0.075, 0.05, 0.007, 0.014, 0.012, gun);
      b.box(0, 0.085, 0.285, 0.005, 0.016, 0.01, gun);
      b.box(0, 0.0925, 0.2855, 0.004, 0.004, 0.004, dot);
      break;
    }
    case 'smg':
      b.rbox(0, 0.02, 0.15, 0.045, 0.075, 0.34, 0.01, gun);
      b.cyl(0, 0.03, 0.38, 0.02, 0.14, 0.02, S.metal(0x0a0a0a), Math.PI / 2, 0, 0, 8);
      b.rbox(0, -0.1, 0.14, 0.028, 0.17, 0.05, 0.006, gun);
      b.rbox(0, -0.05, 0.04, 0.032, 0.105, 0.046, 0.008, grip, -0.2, 0, 0);
      b.box(0, 0.065, 0.16, 0.014, 0.012, 0.3, S.metal(0x3a3c40, 0.4));
      for (const sx of [1, -1]) b.box(sx * 0.009, 0.08, 0.04, 0.006, 0.018, 0.012, gun);
      b.box(0, 0.082, 0.3, 0.006, 0.02, 0.01, gun);
      b.box(0, 0.0915, 0.3005, 0.004, 0.004, 0.004, dot);
      b.box(0, 0.02, -0.1, 0.018, 0.018, 0.2, gun);
      b.rbox(0, -0.005, -0.22, 0.03, 0.09, 0.03, 0.008, gun);
      break;
    case 'sawn': {
      const wood = S.wood(0x5a3e28, 0.5);
      for (const sx of [1, -1]) b.cyl(sx * 0.016, 0.035, 0.2, 0.027, 0.34, 0.027, gun, Math.PI / 2, 0, 0, 8);
      b.rbox(0, 0.028, 0.02, 0.06, 0.075, 0.1, 0.012, gun);
      b.rbox(0, -0.03, -0.01, 0.04, 0.1, 0.07, 0.015, wood, 0.35, 0, 0);
      b.rbox(0, 0.0, 0.14, 0.052, 0.035, 0.12, 0.012, wood);
      b.box(0, 0.059, 0.36, 0.006, 0.012, 0.006, dot);
      break;
    }
    case 'pump': {
      const wood = S.wood(0x5a3e28, 0.5);
      b.cyl(0, 0.042, 0.45, 0.026, 0.72, 0.026, gun, Math.PI / 2, 0, 0, 8);
      b.cyl(0, 0.008, 0.38, 0.022, 0.5, 0.022, gun, Math.PI / 2, 0, 0, 8);
      b.rbox(0, 0.0, 0.4, 0.042, 0.05, 0.2, 0.012, wood);
      b.rbox(0, 0.03, 0.05, 0.05, 0.08, 0.22, 0.01, gun);
      b.rbox(0, -0.01, -0.2, 0.045, 0.1, 0.3, 0.015, wood, 0.1, 0, 0);
      b.rbox(0, -0.04, 0.0, 0.03, 0.08, 0.05, 0.008, grip, -0.15, 0, 0);
      b.box(0, 0.074, 0.05, 0.012, 0.008, 0.02, gun);
      b.box(0, 0.062, 0.8, 0.006, 0.012, 0.006, dot);
      break;
    }
    case 'knife':
      b.rbox(0, 0, 0.18, 0.012, 0.038, 0.22, 0.004, S.chrome(0xc4c8cc));
      b.box(0, 0, 0.065, 0.05, 0.016, 0.014, S.metal(0x2a2a2a, 0.4));
      b.cyl(0, 0, 0.0, 0.024, 0.12, 0.024, S.wood(0x3a2a1e, 0.5), Math.PI / 2, 0, 0, 8);
      break;
    case 'bat':
      b.frustum(0, 0, 0.4, 0.04, 0.016, 0.9, S.wood(0xb98a52, 0.5), Math.PI / 2, 0, 0, 10);
      b.cyl(0, 0, 0.1, 0.034, 0.2, 0.034, S.cloth(0x1c1c1c, 0.6), Math.PI / 2, 0, 0, 8);
      break;
    case 'machete':
      b.rbox(0, 0, 0.35, 0.01, 0.07, 0.5, 0.004, S.steel(0x9aa0a4, 0.4));
      b.box(0, 0.032, 0.62, 0.012, 0.02, 0.1, S.steel(0x9aa0a4, 0.4));
      b.box(0, 0, 0.09, 0.06, 0.02, 0.014, S.metal(0x2a2a2a, 0.4));
      b.cyl(0, 0, 0.0, 0.028, 0.14, 0.028, grip, Math.PI / 2, 0, 0, 8);
      break;
    case 'axe': {
      b.cyl(0, 0, 0.36, 0.027, 0.84, 0.027, S.wood(0x8a6a3e, 0.5), Math.PI / 2, 0, 0, 8);
      b.rbox(0, 0.04, 0.72, 0.042, 0.14, 0.12, 0.01, S.paint(0xb02a1c, 0.5));
      b.rbox(0, 0.045, 0.8, 0.012, 0.22, 0.075, 0.003, S.chrome(0xc4c8cc));
      b.box(0, 0.04, 0.63, 0.026, 0.06, 0.07, S.steel(0x8a8e92, 0.4));
      break;
    }
    case 'rifle':
      b.rbox(0, 0.02, 0.25, 0.05, 0.08, 0.5, 0.01, gun);
      b.cyl(0, 0.035, 0.62, 0.024, 0.32, 0.024, gun, Math.PI / 2, 0, 0, 8);
      b.rbox(0, -0.01, -0.12, 0.045, 0.1, 0.26, 0.015, S.wood(0x5a3e28, 0.5));
      b.rbox(0, -0.06, 0.2, 0.035, 0.13, 0.05, 0.008, gun, 0.3, 0, 0);
      b.cyl(0, 0.1, 0.2, 0.04, 0.16, 0.04, S.metal(0x111111, 0.3), Math.PI / 2, 0, 0, 10);
      break;
    case 'wrench':
      b.rbox(0, 0, 0.22, 0.03, 0.045, 0.44, 0.01, S.chrome(0xa8acb0));
      b.torus(0, 0, 0.47, 0.045, 0.016, S.chrome(0xa8acb0), 0, Math.PI / 2, 0, 6, 12);
      b.box(0, 0, -0.01, 0.034, 0.07, 0.07, S.chrome(0xa8acb0));
      break;
    case 'jerrycan': {
      b.rbox(0.05, -0.12, 0.1, 0.12, 0.34, 0.26, 0.02, S.paint(C.fuel, 0.7));
      b.box(0.05, 0.06, 0.06, 0.03, 0.03, 0.12, S.paint(C.fuel, 0.7));
      break;
    }
    case 'crowbar':
      b.pipe([[0, 0, -0.05], [0, 0, 0.5], [0, 0.04, 0.58], [0, 0.1, 0.6]], 0.014, S.paint(0x3a3f46, 0.7), 8);
      break;
    case 'flare':
      b.cyl(0, 0, 0.13, 0.04, 0.26, 0.04, S.paint(0xd23a3a, 0.5), Math.PI / 2, 0, 0, 10);
      b.cyl(0, 0, 0.27, 0.042, 0.03, 0.042, S.glow(0xffd28a, 3), Math.PI / 2, 0, 0, 10);
      break;
  }
  const g = shared(b.build());
  weaponCache.set(kind, g);
  return g;
}

/** A survivor or raider. Origin at the feet, facing +Z. */
export class Humanoid {
  root = new THREE.Group();
  hips = new THREE.Group();
  torso = new THREE.Group();
  head = new THREE.Group();
  armL = new THREE.Group();
  armR = new THREE.Group();
  elbowL = new THREE.Group();
  elbowR = new THREE.Group();
  legL = new THREE.Group();
  legR = new THREE.Group();
  kneeL = new THREE.Group();
  kneeR = new THREE.Group();
  hand = new THREE.Group();
  flash = new THREE.Mesh(flashGeo, flashMat);
  private weapon: THREE.Mesh | null = null;
  private held: Held = 'none';
  /** 1 at the start of a melee swing, counting down to 0: raises the weapon arm overhead and brings it down. */
  swing = 0;
  private walkT = 0;
  /** Smoothed gait: how much of a stride the legs take (0 standing, 1 moving) and how hard it is a sprint. */
  private moveK = 0;
  private sprintK = 0;
  private idleT = Math.random() * 6;
  private workK = 0;
  private workT = 0;
  /** 0..1 while climbing into a vehicle: a step to the door, a duck under the frame and a drop into the seat. */
  enter = 0;
  /** A greeting with a friend: 0 none, else 1 high five, 2 fist bump, 3 two-handed slap. `five` is its progress 0..1. */
  fiveStyle = 0;
  five = 0;
  /**
   * Hands at work on something at `workAt` (root space: x to the left, y up from the feet, z ahead). `workAmt` is 1 while
   * the job runs; the owner sets both every frame. What is carried is held out to the spot, a tool is worked on it.
   */
  workAmt = 0;
  workAt = new THREE.Vector3(0, 0.9, 0.7);
  meshes: THREE.Mesh[] = [];
  /** Everything but the arms and what they hold: hidden from the owner's own first-person view. */
  private bodyMeshes: THREE.Mesh[] = [];

  /** One mesh per body part, so `dress` can swap a survivor's clothes without rebuilding the rig. */
  private partMesh = {} as Record<Part, THREE.Mesh>;

  constructor(pal: Palette) {
    const g = bodyParts(pal);
    const mk = (part: Part, parent: THREE.Object3D) => {
      const m = new THREE.Mesh(g[part], mat);
      m.castShadow = true;
      parent.add(m);
      this.meshes.push(m);
      this.partMesh[part] = m;
      return m;
    };
    this.root.add(this.hips);
    this.hips.position.y = 0.92;
    this.bodyMeshes.push(mk('pelvis', this.hips));
    this.hips.add(this.torso);
    this.bodyMeshes.push(mk('torso', this.torso));
    this.torso.add(this.head);
    this.head.position.y = 0.6;
    this.bodyMeshes.push(mk('head', this.head));
    for (const [arm, elbow, upper, fore, sx] of [
      [this.armL, this.elbowL, 'upperL', 'foreL', 1],
      [this.armR, this.elbowR, 'upperR', 'foreR', -1],
    ] as const) {
      this.torso.add(arm);
      arm.position.set(sx * 0.22, 0.45, 0);
      mk(upper, arm);
      arm.add(elbow);
      elbow.position.y = -0.28;
      mk(fore, elbow);
    }
    this.elbowR.add(this.hand);
    this.hand.position.set(0, -0.27, 0.02);
    for (const [leg, knee, thigh, shin, sx] of [
      [this.legL, this.kneeL, 'thighL', 'shinL', 1],
      [this.legR, this.kneeR, 'thighR', 'shinR', -1],
    ] as const) {
      this.hips.add(leg);
      leg.position.set(sx * 0.1, -0.02, 0);
      this.bodyMeshes.push(mk(thigh, leg));
      leg.add(knee);
      knee.position.y = -0.43;
      this.bodyMeshes.push(mk(shin, knee));
    }
    this.flash.visible = false;
    this.hand.add(this.flash);
    this.flash.position.set(0, 0.03, 0.32);
  }

  /** Change clothes: swap every body part for the ones this palette draws. Geometry is cached per palette, so this is cheap. */
  dress(pal: Palette) {
    const g = bodyParts(pal);
    for (const part of Object.keys(this.partMesh) as Part[]) this.partMesh[part].geometry = g[part];
  }

  /**
   * First person: hide the head, torso and legs, so the camera at the eyes sees only the arms and what they hold.
   * Applied just before the owner's view draws and undone just after, so a partner's view still sees the whole survivor.
   */
  setFirstPerson(on: boolean) {
    for (const m of this.bodyMeshes) m.visible = !on;
    // The upper arms point straight at a camera at the eyes and would fill the view: the forearms come up from below the frame.
    this.partMesh.upperL.visible = !on;
    this.partMesh.upperR.visible = !on;
    this.placeArms(on);
    // Aimed down the sights, the (hidden) torso is turned and moved so the gun's sights sit on the line of sight.
    const f = this.sightFix;
    if (on) {
      this.torso.position.set(f.x, f.y, f.z);
      this.torso.rotation.x += f.pitch;
      this.torso.rotation.y += f.yaw;
      this.fixApplied = f.pitch;
      this.fixYaw = f.yaw;
    } else {
      this.torso.rotation.x -= this.fixApplied;
      this.torso.rotation.y -= this.fixYaw;
      this.fixApplied = 0;
      this.fixYaw = 0;
      this.torso.position.set(0, 0, 0);
    }
  }

  private fixApplied = 0;
  private fixYaw = 0;

  /**
   * The arms are brought up and forward to where a camera at the eyes can see them, the gun big in the lower right of the
   * view; braced behind the sights they come up and in. Undone for anyone else's view of this survivor.
   */
  private placeArms(on: boolean) {
    const o = this.fpOffset;
    const k = on ? 1 : 0;
    const a = k * this.fpAds;
    this.armR.position.set(-0.22 + k * o.x + a * 0.05, 0.45 + k * o.y + a * o.ads, k * o.z);
    this.armL.position.set(0.22 - k * o.x - a * 0.05, 0.45 + k * o.y + a * o.ads, k * o.z);
    // The gun is drawn larger than life in the owner's view, so it reads as the thing in hand.
    this.weapon?.scale.setScalar(on ? o.gun : 1);
  }

  /**
   * The owner's eye and the way they are looking (a unit vector), and how much to line the gun's sights up with it (0 to 1):
   * set each frame by the owner while aiming in first person. See `alignSights`.
   */
  sight = { k: 0, ex: 0, ey: 0, ez: 0, fx: 0, fy: 0, fz: 1 };
  private sightFix = { pitch: 0, yaw: 0, x: 0, y: 0, z: 0 };

  /**
   * Work out how to turn and move the torso so the rear and front sights sit on the line from the eye along the view. Done
   * with the pose as the owner's view will see it (arms brought forward, gun enlarged), before the gun's own wander and
   * kick are added, so those still move the sights off the line. The result is applied in `setFirstPerson`.
   */
  private alignSights() {
    const f = this.sightFix;
    f.pitch = f.yaw = f.x = f.y = f.z = 0;
    const s = this.sight;
    if (s.k < 0.01 || !this.weapon || !this.gunHeld || this.carried) return;
    const pts = GUN_POINTS[this.held as GunModel];
    this.torso.position.set(0, 0, 0);
    this.placeArms(true);
    const x0 = this.torso.rotation.x;
    const y0 = this.torso.rotation.y;
    _fwd.set(s.fx, s.fy, s.fz);
    const wantYaw = Math.atan2(s.fx, s.fz);
    const wantPitch = Math.asin(clamp(s.fy, -1, 1));
    // Turn the gun until its sight line points along the view: a couple of passes, since pitch and yaw share the one rotation.
    for (let pass = 0; pass < 2; pass++) {
      this.root.updateMatrixWorld(true);
      this.weapon.localToWorld(_ra.set(pts.rear[0], pts.rear[1], pts.rear[2]));
      this.weapon.localToWorld(_fr.set(pts.front[0], pts.front[1], pts.front[2]));
      _dir.copy(_fr).sub(_ra).normalize();
      this.torso.rotation.x -= wantPitch - Math.asin(clamp(_dir.y, -1, 1));
      this.torso.rotation.y += wrapAngle(wantYaw - Math.atan2(_dir.x, _dir.z));
    }
    // Then slide it, side to side and up and down, until the rear sight is on the line (keeping its distance along it).
    this.root.updateMatrixWorld(true);
    this.weapon.localToWorld(_ra.set(pts.rear[0], pts.rear[1], pts.rear[2]));
    _eye.set(s.ex, s.ey, s.ez);
    const along = _w.copy(_ra).sub(_eye).dot(_fwd);
    _w.copy(_eye).addScaledVector(_fwd, along).sub(_ra);
    this.hips.getWorldQuaternion(_q).invert();
    _w.applyQuaternion(_q);
    // How much of all that to apply is how far the sights are up.
    f.pitch = (this.torso.rotation.x - x0) * s.k;
    f.yaw = (this.torso.rotation.y - y0) * s.k;
    f.x = _w.x * s.k;
    f.y = _w.y * s.k;
    f.z = _w.z * s.k;
    this.torso.rotation.x = x0;
    this.torso.rotation.y = y0;
    this.torso.position.set(0, 0, 0);
    this.placeArms(false);
  }

  /** Where the muzzle, the ejection port and the magazine well are in the world right now, and which way the barrel points. Fresh only after `capturePoints`. */
  readonly points = { valid: false, muzzle: new THREE.Vector3(), port: new THREE.Vector3(), well: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1) };

  /** Read the gun's points off the rig as it is posed now (call after the pose, and again once the owner's first-person pose is applied). */
  capturePoints() {
    const pts = this.points;
    pts.valid = false;
    if (!this.weapon || !this.gunHeld) return;
    const g = GUN_POINTS[this.held as GunModel];
    this.weapon.updateWorldMatrix(true, false);
    this.weapon.localToWorld(pts.muzzle.set(g.muzzle[0], g.muzzle[1], g.muzzle[2]));
    this.weapon.localToWorld(pts.port.set(g.port[0], g.port[1], g.port[2]));
    this.weapon.localToWorld(pts.well.set(g.well[0], g.well[1], g.well[2]));
    this.weapon.localToWorld(_ra.set(g.rear[0], g.rear[1], g.rear[2]));
    pts.dir.copy(pts.muzzle).sub(_ra).normalize();
    pts.valid = true;
  }

  /** How far the arms are moved for the owner's own first-person view: toward the view's centre (x), up (y) and forward (z), metres. */
  fpOffset = { x: 0.12, y: 0.05, z: 0.32, ads: 0.1, gun: 1.6 };
  /** How far the owner has the sights up (0 to 1), for the first-person arms. */
  fpAds = 0;

  /** Swap the item in the right hand. Cheap to call every frame: geometry is cached per item. */
  setWeapon(kind: Held) {
    if (kind === this.held) return;
    this.held = kind;
    if (this.weapon) {
      this.hand.remove(this.weapon);
      this.weapon = null;
    }
    if (kind === 'none') return;
    const m = new THREE.Mesh(weaponGeometry(kind), mat);
    m.castShadow = true;
    this.hand.add(m);
    this.weapon = m;
  }

  private carried: THREE.Object3D | null = null;

  /** Where the load in the arms is right now, in world space (null when empty-handed). */
  carryWorld(out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.carried) return null;
    this.carried.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.carried.matrixWorld);
  }

  /** Hold something in both arms in front of the chest (null to let go). The caller owns the object's geometry. */
  setCarry(obj: THREE.Object3D | null) {
    if (obj === this.carried) return;
    if (this.carried) this.torso.remove(this.carried);
    this.carried = obj;
    if (obj) {
      obj.position.set(0, 0.1, 0.42);
      this.torso.add(obj);
    }
  }

  /** Show the muzzle flash for one frame. */
  muzzle(on: boolean) {
    this.flash.visible = on;
    if (on) this.flash.rotation.set(Math.random() * 6, Math.random() * 6, 0);
  }

  /** Whether the thing in the right hand is a firearm. */
  private get gunHeld() {
    return this.held === 'pistol' || this.held === 'revolver' || this.held === 'smg' || this.held === 'sawn' || this.held === 'pump' || this.held === 'rifle';
  }

  /** Lay the way the gun is being handled over the pose: low ready, high ready, a reload, a rack. */
  private applyGunPose() {
    const gp = this.gunPose;
    this.hand.position.z = 0.02 - (this.gunHeld && !this.carried ? clamp(this.gunKick, 0, 1.6) * 0.04 : 0);
    if (!this.gunHeld || this.carried) return;
    if (gp.low > 0.001) {
      // Low ready: the gun across the chest with its muzzle down and ahead, the support hand under it.
      const k = gp.low;
      this.armR.rotation.x = lerp(this.armR.rotation.x, -0.55, k);
      this.elbowR.rotation.x = lerp(this.elbowR.rotation.x, -0.95, k);
      this.hand.rotation.x = lerp(this.hand.rotation.x, 1.8, k);
      this.armL.rotation.x = lerp(this.armL.rotation.x, -0.8, k);
      this.armL.rotation.z = lerp(this.armL.rotation.z, -0.5, k);
      this.elbowL.rotation.x = lerp(this.elbowL.rotation.x, -0.95, k);
      this.torso.rotation.x += 0.1 * k;
    }
    if (gp.high > 0.001) {
      // High ready: a wall is in the way, so the muzzle comes up and the gun is pulled in to the chest.
      const k = gp.high;
      this.armR.rotation.x = lerp(this.armR.rotation.x, -1.95, k);
      this.elbowR.rotation.x = lerp(this.elbowR.rotation.x, -0.5, k);
      this.hand.rotation.x = lerp(this.hand.rotation.x, 1.55, k);
      this.armL.rotation.x = lerp(this.armL.rotation.x, -1.8, k);
      this.armL.rotation.z = lerp(this.armL.rotation.z, -0.5, k);
      this.elbowL.rotation.x = lerp(this.elbowL.rotation.x, -0.6, k);
    }
    // Canted about the barrel and with the muzzle moved: a reload tips the gun for the magazine well or the port.
    this.hand.rotation.z += gp.tilt;
    this.hand.rotation.x += gp.pitch;
    if (gp.down > 0.001) {
      // The support hand leaves the gun for the belt or the pouch.
      const k = gp.down;
      this.armL.rotation.x = lerp(this.armL.rotation.x, -0.15, k);
      this.armL.rotation.z = lerp(this.armL.rotation.z, 0.35, k);
      this.elbowL.rotation.x = lerp(this.elbowL.rotation.x, -1.2, k);
    }
    if (gp.rack > 0.001) {
      if (gp.bolt) {
        // A bolt: the right hand turns up, draws back and runs home.
        this.hand.rotation.z += gp.rack * 0.9;
        this.armR.rotation.x += gp.rack * 0.12;
        this.elbowR.rotation.x -= gp.rack * 0.45;
      } else {
        // A slide or a pump: the support hand draws back along the gun and goes forward again.
        this.armL.rotation.x += gp.rack * 0.3;
        this.elbowL.rotation.x -= gp.rack * 0.55;
      }
    }
  }

  /**
   * Pose the rig. `speed` is horizontal speed in m/s for walk cycles; `aim` raises the weapon arm;
   * `crouch` 0..1 lowers the stance, `air` 0..1 tucks the legs for a jump or a fall.
   */
  /** Barrel wander (yaw, pitch, radians) and how hard the last shot is still kicking, set by the owner each frame. */
  gunSway: [number, number] = [0, 0];
  gunKick = 0;
  /**
   * How the gun is being handled, set by the owner each frame: carried low across the chest (a sprint, or being drawn), pushed
   * up and in against a wall, and what a reload or the working of a pump or bolt does: the gun canted, its muzzle moved, the
   * support hand off to the belt, the slide or bolt travelling back. `bolt` makes the rack a bolt thrown by the right hand
   * instead of a slide or pump worked by the left.
   */
  gunPose = { low: 0, high: 0, tilt: 0, pitch: 0, down: 0, rack: 0, bolt: false };

  update(dt: number, pose: PoseKind, speed: number, aim: number, crouch: number, lookPitch = 0, air = 0) {
    const enter = this.enter;
    if (enter > 0) speed = 2.4 * (1 - smooth(0.35, 0.55, enter));
    this.walkT += dt * (1.5 + speed * 1.1);
    this.idleT += dt;
    // Gait eases in and out, so starting, stopping and breaking into a sprint never snap the legs.
    this.moveK = damp(this.moveK, clamp(speed / 1.2, 0, 1) * (1 - air), 12, dt);
    this.sprintK = damp(this.sprintK, clamp((speed - 3.8) / 2, 0, 1) * (1 - air), 8, dt);
    this.workK = damp(this.workK, this.workAmt, 9, dt);
    if (this.workAmt > 0) this.workT += dt;
    const mv = this.moveK;
    const sp = this.sprintK;
    // Stride grows with speed: short steps at a stroll, long driving ones at a sprint.
    const amp = mv * clamp(0.4 + speed * 0.12, 0, 1.15) * (1 - crouch * 0.35);
    const ph = this.walkT * 2;
    const s = Math.sin(ph);
    const c = Math.cos(ph);
    const sw = s * amp;
    const r = this.root;
    const h = this.hips;
    r.rotation.x = 0;
    // The owner places the root (feet height, saddle offset); the pose must not touch its position.
    h.position.z = 0;
    h.rotation.set(0, 0, 0);
    this.torso.rotation.set(0, 0, 0);
    this.head.rotation.set(0, 0, 0);
    this.armL.rotation.set(0, 0, 0);
    this.armR.rotation.set(0, 0, 0);
    this.elbowL.rotation.set(0, 0, 0);
    this.elbowR.rotation.set(0, 0, 0);
    this.hand.rotation.set(0, 0, 0);
    this.legL.rotation.set(0, 0, 0);
    this.legR.rotation.set(0, 0, 0);
    this.kneeL.rotation.set(0, 0, 0);
    this.kneeR.rotation.set(0, 0, 0);
    if (pose === 'stand' || pose === 'gun') {
      const wk = this.workK;
      // Working low on a car (a wheel, a sill) squats; the body goes down rather than bending at the waist alone.
      const low = wk * clamp((0.35 - this.workAt.y) / 0.9, 0, 1) * 1.0;
      const cr = Math.max(crouch, low);
      // Lowest at double support, up as the legs pass under the body; a sprint bounces more.
      h.position.y = 0.92 - cr * 0.32 - Math.abs(s) * amp * (0.03 + sp * 0.03);
      const bend = cr * 1.1;
      const stride = 0.8 + sp * 0.35;
      this.legL.rotation.x = sw * stride - bend * 0.4;
      this.legR.rotation.x = -sw * stride - bend * 0.4;
      // The knee folds as the leg swings forward under the body, the heel kicking up harder when running.
      const flex = 0.55 + sp * 0.95;
      this.kneeL.rotation.x = Math.max(0, -c) * flex * amp + 0.12 * amp + bend;
      this.kneeR.rotation.x = Math.max(0, c) * flex * amp + 0.12 * amp + bend;
      // Hips roll over the standing leg and turn with the stride; the shoulders turn against them.
      const hipYaw = s * 0.1 * amp * (1 - aim);
      h.rotation.y = hipYaw;
      h.rotation.z = c * 0.035 * amp;
      this.torso.rotation.z = -c * 0.03 * amp;
      this.torso.rotation.x = cr * 0.35 + 0.03 + sp * 0.2 + mv * 0.03;
      this.torso.rotation.y = -hipYaw * 2.2 + s * 0.1 * amp * (1 - aim);
      this.armL.rotation.x = -sw * (0.55 + sp * 0.45) * (1 - aim);
      this.armR.rotation.x = aim > 0.1 ? -1.4 * aim + lookPitch * 0.5 : sw * (0.55 + sp * 0.45);
      this.armL.rotation.z = 0.08 + sp * 0.05;
      this.armR.rotation.z = -0.08 - sp * 0.05;
      this.elbowL.rotation.x = -0.2 - mv * 0.25 - sp * 0.9 - Math.max(0, sw) * 0.2;
      this.elbowR.rotation.x = aim > 0.1 ? -0.1 : -0.2 - mv * 0.25 - sp * 0.9 - Math.max(0, -sw) * 0.2;
      // Standing still the chest breathes and the arms hang with a little life.
      const idle = 1 - mv;
      if (idle > 0.01) {
        const br = Math.sin(this.idleT * 1.7);
        this.torso.rotation.x += br * 0.012 * idle;
        this.armL.rotation.z += br * 0.015 * idle;
        this.armR.rotation.z -= br * 0.015 * idle;
        this.head.rotation.y = Math.sin(this.idleT * 0.43) * 0.04 * idle;
      }
      // Raised, the forearm points down the sights; the hand turns back so the weapon points the same way instead of at the sky.
      if (aim > 0.1) this.hand.rotation.x = 1.4 * aim + 0.1;
      if (aim > 0.1) {
        // Support hand comes across to the grip.
        this.armL.rotation.x = -1.2 * aim + lookPitch * 0.45;
        this.armL.rotation.z = -0.45 * aim;
        this.elbowL.rotation.x = -0.55 * aim;
      }
      this.alignSights();
      if (aim > 0.1 && !this.carried) {
        // The gun wanders in the hands and bucks back with each shot: arms rock up, elbows give, the shoulders take it.
        this.armR.rotation.x += this.gunSway[1] * 2.2 * aim - this.gunKick * 0.28;
        this.armR.rotation.y += this.gunSway[0] * 2.2 * aim;
        this.armL.rotation.x += this.gunSway[1] * 2.2 * aim - this.gunKick * 0.26;
        this.armL.rotation.y += this.gunSway[0] * 2.2 * aim;
        this.elbowR.rotation.x -= this.gunKick * 0.2;
        this.torso.rotation.x -= this.gunKick * 0.07;
      }
      this.applyGunPose();
      this.head.rotation.x = lookPitch * 0.4 - this.torso.rotation.x * 0.6;
      this.head.rotation.y -= this.torso.rotation.y * 0.5;
      if (this.swing > 0 && !this.carried) {
        // Wind up overhead, then chop down across the body.
        const e = 1 - this.swing;
        const sp = swingPose(e);
        this.armR.rotation.x = sp.arm;
        this.elbowR.rotation.x = sp.elbow;
        this.torso.rotation.y = sp.yaw;
        // The wrist leads: the weapon comes over the top and chops down in front, not held up behind the head.
        this.hand.rotation.x = sp.blade - (sp.arm + sp.elbow);
      }
      if (air > 0) {
        // Off the ground: knees drawn up, one foot ahead of the other, arms out for balance.
        this.legL.rotation.x += (-0.55 - this.legL.rotation.x) * air;
        this.legR.rotation.x += (0.15 - this.legR.rotation.x) * air;
        this.kneeL.rotation.x += (1.1 - this.kneeL.rotation.x) * air;
        this.kneeR.rotation.x += (0.7 - this.kneeR.rotation.x) * air;
        if (aim <= 0.1) {
          this.armL.rotation.z += (0.55 - this.armL.rotation.z) * air;
          this.armR.rotation.z += (-0.55 - this.armR.rotation.z) * air;
        }
      }
      if (this.carried) {
        // Both arms cradle the load, elbows in, leaning back a touch against the weight.
        this.armL.rotation.set(-1.05, 0, -0.28);
        this.armR.rotation.set(-1.05, 0, 0.28);
        this.elbowL.rotation.x = -0.65;
        this.elbowR.rotation.x = -0.65;
        this.torso.rotation.x -= 0.06;
        this.torso.rotation.y = 0;
        this.carried.position.set(0, 0.1, 0.42);
        this.carried.rotation.set(0, 0, 0);
      }
      if (wk > 0.01 && air < 0.5) this.workPose(wk, aim);
      if (this.fiveStyle > 0 && !this.carried && air < 0.5) this.fivePose(this.fiveStyle, this.five);
      if (enter > 0) this.enterPose(enter);
    } else if (pose === 'ride') {
      // Astride a moped: hips down, knees bent, arms out to the bars.
      h.position.y = 0.45;
      this.legL.rotation.x = -1.15;
      this.legR.rotation.x = -1.15;
      this.legL.rotation.z = 0.12;
      this.legR.rotation.z = -0.12;
      this.kneeL.rotation.x = 1.45;
      this.kneeR.rotation.x = 1.45;
      this.torso.rotation.x = 0.5;
      this.armL.rotation.x = -0.95;
      this.armR.rotation.x = -0.95;
      this.armL.rotation.z = 0.25;
      this.armR.rotation.z = -0.25;
      this.elbowL.rotation.x = -0.55;
      this.elbowR.rotation.x = -0.55;
      this.head.rotation.x = -0.45;
    } else if (pose === 'seat') {
      h.position.y = 0.4;
      this.legL.rotation.x = -1.4;
      this.legR.rotation.x = -1.4;
      this.kneeL.rotation.x = 1.5;
      this.kneeR.rotation.x = 1.5;
      this.torso.rotation.x = 0.1;
      this.armL.rotation.x = -0.75;
      this.armR.rotation.x = -0.75;
      this.armL.rotation.z = 0.15;
      this.armR.rotation.z = -0.15;
      this.elbowL.rotation.x = -0.7;
      this.elbowR.rotation.x = -0.7;
      this.head.rotation.x = -0.05;
    } else if (pose === 'downed') {
      r.rotation.x = -Math.PI / 2;
      h.position.z = 0.2; // local +z is world up once the body lies on its back
      h.position.y = 0.92;
      this.legL.rotation.x = 0.2 + Math.sin(this.walkT) * 0.1;
      this.legR.rotation.x = -0.1;
      this.kneeL.rotation.x = 0.4;
      this.kneeR.rotation.x = 0.3;
      this.armL.rotation.x = -0.4 + Math.sin(this.walkT * 0.7) * 0.15;
      this.armR.rotation.x = 0.3;
      this.elbowL.rotation.x = -0.6;
      this.elbowR.rotation.x = -0.3;
      this.torso.rotation.x = 0;
      this.head.rotation.x = -0.5;
    }
  }

  /**
   * Hands on a job at `workAt`: the body squares up to the spot, the arms reach for it and whatever is in them goes out
   * there. A load is held against the spot and worked into place; a tool turns on it; bare hands tug at it.
   */
  private workPose(k: number, aim: number) {
    const t = this.workAt;
    const t0 = this.workT;
    // Where the spot is from the shoulders: ahead, to the side, and how far up or down.
    const dx = t.x;
    const dz = Math.max(0.25, t.z);
    const dy = t.y - (this.hips.position.y + 0.42);
    const fwd = Math.hypot(dx, dz);
    const elev = clamp(Math.atan2(dy, fwd), -1.0, 1.0);
    const face = clamp(Math.atan2(dx, dz), -0.9, 0.9);
    this.torso.rotation.y = lerp(this.torso.rotation.y, face * 0.8, k);
    this.torso.rotation.x += k * (0.18 + Math.max(0, -dy) * 0.25);
    this.head.rotation.y = lerp(this.head.rotation.y, face * 0.2, k);
    this.head.rotation.x = lerp(this.head.rotation.x, 0.15 + Math.max(0, -elev) * 0.35 - this.torso.rotation.x * 0.5, k);
    // A planted step toward the work, the other foot back.
    this.legL.rotation.x = lerp(this.legL.rotation.x, this.legL.rotation.x - 0.18, k);
    this.legR.rotation.x = lerp(this.legR.rotation.x, this.legR.rotation.x + 0.14, k);
    const reachX = -(Math.PI / 2 + elev * 0.85);
    const out = clamp((fwd - 0.2) / 0.7, 0, 1);
    if (this.carried) {
      const tug = Math.sin(t0 * 11) * 0.025 + Math.sin(t0 * 5.3) * 0.012;
      // The load goes out toward the spot, but never past arm's reach.
      const reach = Math.min(0.62, 0.34 + fwd * 0.3);
      const px = clamp(dx, -0.45, 0.45) * 0.55;
      const pz = Math.min(dz, reach) + tug;
      const py = clamp(dy + 0.12, -0.55, 0.5);
      this.carried.position.set(lerp(0, px, k), lerp(0.1, py, k), lerp(0.42, pz, k));
      // Rocked into place: it turns a little as the bolts catch.
      this.carried.rotation.set(Math.sin(t0 * 7) * 0.08 * k, Math.sin(t0 * 5) * 0.12 * k, 0);
      const arms = reachX * 0.9 - 0.12 * out;
      this.armL.rotation.set(lerp(-1.05, arms, k), 0, lerp(-0.28, -0.14, k));
      this.armR.rotation.set(lerp(-1.05, arms, k), 0, lerp(0.28, 0.14, k));
      this.elbowL.rotation.x = lerp(-0.65, -0.55 + out * 0.4 + tug * 6, k);
      this.elbowR.rotation.x = lerp(-0.65, -0.55 + out * 0.4 - tug * 6, k);
    } else if (this.held !== 'none') {
      // Tool in the right hand turning on the spot, ratcheting; the left hand steadies against the work.
      const turn = Math.sin(t0 * 9);
      this.armR.rotation.x = lerp(this.armR.rotation.x, reachX + 0.05, k);
      this.armR.rotation.y = lerp(this.armR.rotation.y, -0.1, k);
      this.armR.rotation.z = lerp(this.armR.rotation.z, -0.08, k);
      this.elbowR.rotation.x = lerp(this.elbowR.rotation.x, -0.4 + out * 0.3 + turn * 0.12, k);
      this.hand.rotation.x = lerp(this.hand.rotation.x, 1.2, k);
      this.hand.rotation.z = lerp(this.hand.rotation.z, turn * 0.5, k);
      this.armL.rotation.x = lerp(this.armL.rotation.x, reachX * 0.85, k);
      this.armL.rotation.z = lerp(this.armL.rotation.z, -0.2, k);
      this.elbowL.rotation.x = lerp(this.elbowL.rotation.x, -0.6 + out * 0.3, k);
    } else {
      // Bare hands: both reach the spot and heave on it.
      const tug = Math.sin(t0 * 8) * 0.07;
      this.armL.rotation.x = lerp(this.armL.rotation.x, reachX + tug, k);
      this.armR.rotation.x = lerp(this.armR.rotation.x, reachX - tug, k);
      this.armL.rotation.z = lerp(this.armL.rotation.z, -0.1, k);
      this.armR.rotation.z = lerp(this.armR.rotation.z, 0.1, k);
      this.elbowL.rotation.x = lerp(this.elbowL.rotation.x, -0.45 + out * 0.3, k);
      this.elbowR.rotation.x = lerp(this.elbowR.rotation.x, -0.45 + out * 0.3, k);
    }
    void aim;
  }

  /**
   * Meeting a friend's hand. The arm comes up (overhead for a high five, chest high for a fist bump, both for a double slap),
   * lands at contact halfway through, then rides the recoil and drops. The hand angles in toward the other person's.
   */
  private fivePose(style: number, p: number) {
    const raise = smooth(0.0, 0.42, p) * (1 - smooth(0.72, 1, p));
    // The contact jolt: a quick shove back at the moment the hands meet.
    const hit = Math.exp(-Math.pow((p - 0.5) / 0.05, 2));
    const hop = style === 2 ? 0 : Math.sin(Math.PI * clamp((p - 0.28) / 0.42, 0, 1)) * (style === 3 ? 0.1 : 0.05);
    this.hips.position.y += hop;
    this.torso.rotation.x += raise * 0.1 - hit * 0.05;
    this.torso.rotation.y = lerp(this.torso.rotation.y, 0, raise);
    this.head.rotation.x = lerp(this.head.rotation.x, -0.1, raise);
    this.head.rotation.y = 0;
    this.armR.rotation.y = 0;
    if (style === 1 || style === 3) {
      const up = style === 3 ? -2.05 : -2.2;
      this.armR.rotation.x = lerp(this.armR.rotation.x, up + hit * 0.18, raise);
      this.armR.rotation.z = lerp(this.armR.rotation.z, 0.38, raise);
      this.elbowR.rotation.x = lerp(this.elbowR.rotation.x, -0.2 - hit * 0.2, raise);
    }
    if (style === 3) {
      this.armL.rotation.x = lerp(this.armL.rotation.x, -2.05 + hit * 0.18, raise);
      this.armL.rotation.z = lerp(this.armL.rotation.z, -0.38, raise);
      this.elbowL.rotation.x = lerp(this.elbowL.rotation.x, -0.2 - hit * 0.2, raise);
    }
    if (style === 2) {
      // Fist out at chest height, the other hand tucked in.
      this.armR.rotation.x = lerp(this.armR.rotation.x, -1.35 + hit * 0.12, raise);
      this.armR.rotation.z = lerp(this.armR.rotation.z, 0.3, raise);
      this.elbowR.rotation.x = lerp(this.elbowR.rotation.x, -0.55 - hit * 0.15, raise);
      this.hand.rotation.x = lerp(this.hand.rotation.x, 0.2, raise);
    }
  }

  /**
   * Climbing into a car, `k` 0..1: reach for the handle, step up with the near foot, duck the head under the frame and drop
   * into the seat. Blends the standing pose into the seated one so it ends exactly where the driver model begins.
   */
  private enterPose(k: number) {
    const seat = smooth(0.4, 1, k);
    const duck = Math.sin(Math.PI * clamp((k - 0.3) / 0.6, 0, 1));
    const step = Math.sin(Math.PI * clamp((k - 0.32) / 0.4, 0, 1));
    const reach = Math.sin(Math.PI * clamp(k / 0.4, 0, 1));
    const h = this.hips;
    h.position.y = lerp(h.position.y, 0.4, seat) - duck * 0.07;
    // Near leg lifts over the sill while the other takes the weight.
    this.legL.rotation.x = lerp(lerp(this.legL.rotation.x, -1.0, step), -1.4, seat);
    this.kneeL.rotation.x = lerp(lerp(this.kneeL.rotation.x, 1.2, step), 1.5, seat);
    this.legR.rotation.x = lerp(this.legR.rotation.x, -1.4, seat);
    this.kneeR.rotation.x = lerp(this.kneeR.rotation.x, 1.5, seat);
    this.torso.rotation.y *= 1 - seat;
    this.torso.rotation.x = lerp(this.torso.rotation.x, 0.1, seat) + duck * 0.5;
    this.head.rotation.x = lerp(this.head.rotation.x, -0.05, seat) - duck * 0.45;
    // The far hand reaches for the door or the grab handle, then both come to the wheel.
    this.armR.rotation.x = lerp(lerp(this.armR.rotation.x, -1.15, reach), -0.75, seat);
    this.elbowR.rotation.x = lerp(lerp(this.elbowR.rotation.x, -0.5, reach), -0.7, seat);
    this.armL.rotation.x = lerp(this.armL.rotation.x, -0.75, seat);
    this.elbowL.rotation.x = lerp(this.elbowL.rotation.x, -0.7, seat);
    this.armL.rotation.z = lerp(this.armL.rotation.z, 0.15, seat);
    this.armR.rotation.z = lerp(this.armR.rotation.z, -0.15, seat);
  }

  dispose() {
    // Geometry is shared per palette and per weapon; nothing to free per instance.
  }
}

function smooth(a: number, b: number, x: number) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

export { basicLight };
