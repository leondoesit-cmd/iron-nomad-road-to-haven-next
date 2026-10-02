import * as THREE from 'three';
import { MeshBuilder, S, type Surf } from './builder';
import { PLAYER_COLORS } from './palette';
import { gearDef, hexColor, type WearSlot } from '../data/gear';
import type { Loadout } from '../sim/gear';

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
export type LegStyle = 'work' | 'cargo' | 'padded' | 'greaves' | 'bare';
export type FootStyle = 'boots' | 'sneakers' | 'steel' | 'runners' | 'bare';
export type PackStyle = 'ruck' | 'satchel' | 'duffel' | 'frame' | 'none';

/** Every style each slot can draw, for checking the catalogue against. */
export const STYLES: Record<'head' | 'face' | 'body' | 'hands' | 'legs' | 'feet' | 'pack', readonly string[]> = {
  head: ['helmet', 'cap', 'hardhat', 'hood', 'moto', 'riot', 'bare'],
  face: ['bandana', 'goggles', 'respirator', 'gasmask', 'none'],
  body: ['jacket', 'vest', 'duster', 'plate', 'riot', 'shirt'],
  hands: ['work', 'fingerless', 'padded', 'tactical', 'bare'],
  legs: ['work', 'cargo', 'padded', 'greaves', 'bare'],
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

/** The neck: a scarf and its tail for a bandana, a hose for a gas mask, nothing for the rest. */
export function drawNeck(b: MeshBuilder, p: Piece<FaceStyle>, fallback: number) {
  const c = p.c ?? fallback;
  if (p.style === 'bandana') {
    const scarf = S.cloth(c, 0.45);
    b.torus(0, 0.52, 0.01, 0.075, 0.035, scarf, Math.PI / 2, 0, 0, 8, 16);
    b.box(0.05, 0.43, -0.09, 0.07, 0.16, 0.02, scarf, 0.2, 0, 0.1);
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

/** Sleeve colour for a body style, so the arms match the torso. */
export function sleeveColor(p: Piece<BodyStyle>, fallback: number): number {
  switch (p.style) {
    case 'jacket':
      return p.c ?? fallback;
    case 'vest':
    case 'plate':
      return p.c2 ?? 0x4a4636;
    case 'shirt':
      return 0x6a6a60;
    default:
      return p.c ?? fallback;
  }
}

/** Torso covering: the garment itself, without the neck, the pack or the arms. */
export function drawBody(b: MeshBuilder, p: Piece<BodyStyle>, fallback: number, trim: number) {
  const c = p.c ?? fallback;
  const leather = S.leather(0x3b2a1e, 0.5);
  const buckle = S.metal(0x8a8478, 0.4);
  const body = (col: number, mat: (c: number, w?: number) => Surf = S.cloth) => {
    const m = mat(col, 0.55);
    // Abdomen and chest: a tapered body with round shoulders.
    b.limb(0, 0.06, 0, 0, 0.26, 0, 0.14, 0.16, m, 14);
    b.rbox(0, 0.34, 0, 0.4, 0.3, 0.24, 0.1, m);
    for (const sx of [1, -1]) b.sphereAt(sx * 0.19, 0.44, 0, 0.085, m);
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
      body(0x6a6a60);
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

/** Upper-arm cover: the sleeve plus whatever armour sits on it. */
export function drawUpperArm(b: MeshBuilder, body: Piece<BodyStyle>, sleeve: Surf) {
  b.limb(0, -0.02, 0, 0, -0.27, 0, 0.065, 0.054, sleeve, 10);
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

export function drawHand(b: MeshBuilder, p: Piece<HandStyle>, sleeve: Surf, skin: Surf) {
  const c = p.c ?? 0x2b2622;
  const glove = S.leather(c, 0.4);
  // The cuff of the sleeve and the forearm are the same for every glove.
  b.limb(0, 0, 0, 0, -0.2, 0, 0.052, 0.044, sleeve, 10);
  b.torus(0, -0.2, 0, 0.045, 0.014, sleeve, Math.PI / 2, 0, 0, 6, 12);
  switch (p.style) {
    case 'work':
      b.rbox(0, -0.27, 0.005, 0.07, 0.11, 0.05, 0.02, glove);
      b.capsule(0.03, -0.24, 0.03, 0.035, -0.28, 0.045, 0.014, glove, 6);
      break;
    case 'fingerless':
      b.rbox(0, -0.255, 0.005, 0.07, 0.07, 0.05, 0.02, glove);
      b.rbox(0, -0.3, 0.008, 0.066, 0.05, 0.046, 0.018, skin);
      b.capsule(0.03, -0.24, 0.03, 0.035, -0.28, 0.045, 0.014, skin, 6);
      b.torus(0, -0.225, 0, 0.044, 0.012, glove, Math.PI / 2, 0, 0, 6, 12);
      break;
    case 'padded':
      b.cyl(0, -0.16, 0, 0.1, 0.1, 0.1, glove, 0, 0, 0, 10);
      b.rbox(0, -0.27, 0.005, 0.085, 0.13, 0.062, 0.03, glove);
      b.rbox(0, -0.31, 0.04, 0.08, 0.035, 0.022, 0.01, S.metal(p.c2 ?? 0x6a6e72, 0.4));
      b.capsule(0.034, -0.24, 0.032, 0.04, -0.285, 0.048, 0.018, glove, 6);
      break;
    case 'tactical':
      b.rbox(0, -0.27, 0.005, 0.068, 0.11, 0.048, 0.02, glove);
      b.rbox(0, -0.29, 0.035, 0.062, 0.035, 0.014, 0.006, S.plastic(0x2a2a2c, 0.3));
      b.capsule(0.03, -0.24, 0.03, 0.035, -0.28, 0.045, 0.013, glove, 6);
      break;
    case 'bare':
      b.rbox(0, -0.27, 0.005, 0.066, 0.11, 0.046, 0.02, skin);
      b.capsule(0.03, -0.24, 0.03, 0.035, -0.28, 0.045, 0.014, skin, 6);
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
    case 'bare':
      break;
  }
}

/** Shin cover and the shoe: pads over the knee, then boots, trainers or bare feet. */
export function drawShin(b: MeshBuilder, legs: Piece<LegStyle>, feet: Piece<FootStyle>, fallbackPants: number, skin: Surf) {
  const pants = legs.style === 'bare' ? skin : S.cloth(trouserColor(legs, fallbackPants), 0.6);
  b.limb(0, 0, 0, 0, -0.3, 0, 0.064, 0.052, pants, 12);
  // Knee protection.
  if (legs.style === 'greaves') {
    const m = S.metal(legs.c2 ?? 0x7a7e82, 0.45);
    b.rbox(0, -0.17, 0.056, 0.11, 0.26, 0.04, 0.015, m);
    b.add('sphere', 0, -0.03, 0.068, 0.125, 0.1, 0.08, m);
  } else if (legs.style === 'padded') b.rbox(0, -0.03, 0.062, 0.135, 0.15, 0.055, 0.028, S.plastic(0x222222, 0.5));
  else if (legs.style !== 'bare') b.rbox(0, -0.03, 0.055, 0.1, 0.11, 0.04, 0.02, S.plastic(0x2a2a2a, 0.6));

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
      // Ankle sock, canvas upper, white toe cap and gum sole.
      b.limb(0, -0.3, 0, 0, -0.37, 0, 0.05, 0.046, S.cloth(0xe8e4d8, 0.4), 8);
      b.rbox(0, -0.385, 0.0, 0.102, 0.09, 0.112, 0.035, boot);
      b.rbox(0, -0.425, 0.065, 0.1, 0.065, 0.2, 0.035, boot);
      const gum = S.rubber(feet.c2 ?? 0xd9d4c4);
      b.rbox(0, -0.462, 0.065, 0.11, 0.032, 0.23, 0.012, gum);
      b.rbox(0, -0.435, 0.15, 0.09, 0.05, 0.06, 0.02, gum);
      for (let i = 0; i < 3; i++) b.box(0, -0.4 - i * 0.012, 0.115 + i * 0.03, 0.05, 0.005, 0.012, lace);
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
