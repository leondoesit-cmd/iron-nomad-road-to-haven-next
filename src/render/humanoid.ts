import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { C } from './palette';
import { clamp01, lerp } from '../core/math';
import { shared } from './dispose';
import { kitMaterial } from './materials';
import { drawMods, muzzleAt } from './gunMods';
import { parseLooks } from '../sim/gunmods';
import { GUN_MODELS, type GunModel, type MeleeModel } from '../data/gear';
import type { HeroId } from '../data/heroes';
import { HERO_LOOKS, type HeroLook } from './heroLooks';
import { drawEars, portraitGeometry, portraitMaterial } from './portrait';
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
  shortSleeves,
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
  /** One of the two heroes: their own face, hair, height, build and clothes instead of the stock survivor's. */
  hero?: HeroId;
}

type Part = 'pelvis' | 'torso' | 'head' | 'upperL' | 'upperR' | 'foreL' | 'foreR' | 'thighL' | 'thighR' | 'shinL' | 'shinR';

const partCache = new Map<string, Record<Part, THREE.BufferGeometry>>();

/** Build (once per palette) the eleven body-part meshes of a survivor or raider. Origins sit on the joints. */
function bodyParts(p: Palette): Record<Part, THREE.BufferGeometry> {
  const key = JSON.stringify(p);
  const hit = partCache.get(key);
  if (hit) return hit;
  const raider = !!p.mask;
  const hero = !raider && p.hero ? HERO_LOOKS[p.hero] : null;
  const look = p.look ?? DEFAULT_LOOK;
  const jacket = S.cloth(p.jacket, 0.55);
  const trim = S.cloth(p.trim, 0.5);
  const pantsColor = trouserColor(look.legs, p.pants ?? 0x3d3f3a);
  const pants = S.cloth(raider ? (p.pants ?? 0x3d3f3a) : pantsColor, 0.6);
  const skin = S.skin(hero?.skin ?? p.skin ?? C.skin);
  const leather = S.leather(0x3b2a1e, 0.5);
  const boot = S.leather(0x2a211b, 0.6);
  const glove = S.leather(0x2b2622, 0.4);
  const buckle = S.metal(0x8a8478, 0.4);
  const helmet = p.mask ? S.metal(p.helmet ?? 0x111111, 0.5) : S.paint(p.helmet ?? p.trim, 0.6);
  const scarfColor = p.scarf ?? p.trim;
  const sleeve = raider ? jacket : S.cloth(sleeveColor(look.body, p.jacket, hero?.over ?? hero?.shirt), 0.55);
  // In nothing but a T-shirt the forearms are bare.
  const short = !raider && shortSleeves(look.body, hero ?? undefined);
  // A hero's build: torso and pelvis as broad as their weight makes them, limbs a little less so.
  const girth = hero?.girth ?? 1;
  const limb = 1 + (girth - 1) * 0.9;
  const mk = (fn: (b: MeshBuilder) => void, gx = 1, belly = 0) => {
    const b = new MeshBuilder();
    b.jitter = 0.03;
    b.roundSeg = 2;
    fn(b);
    if (gx !== 1 || belly > 0) fitBuild(b, gx, belly);
    return shared(b.build());
  };
  const parts: Record<Part, THREE.BufferGeometry> = {
    pelvis: mk(
      (b) => {
        if (!raider && look.legs.style === 'bare') drawBriefs(b);
        else b.rbox(0, -0.02, 0, 0.33, 0.2, 0.21, 0.07, pants);
        // Belt with buckle and pouches.
        b.rbox(0, 0.07, 0, 0.35, 0.055, 0.23, 0.025, leather);
        b.box(0, 0.07, 0.118, 0.06, 0.045, 0.01, buckle);
        for (const sx of [1, -1]) b.rbox(sx * 0.15, 0.03, 0.06, 0.07, 0.09, 0.06, 0.015, raider ? leather : trim);
        b.rbox(-0.1, 0.03, -0.11, 0.1, 0.09, 0.06, 0.015, leather);
        if (!raider) drawHips(b, look.body, p.jacket);
      },
      girth,
      (hero?.belly ?? 0) * 0.4,
    ),
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
        // The garment (a hero's own clothes when nothing is worn over them), the pack on the back, and the neck wrap.
        drawBody(b, look.body, p.jacket, p.trim, hero ?? undefined);
        drawPack(b, look.pack);
        // A hero wears the bandana down round the neck, so the face stays seen.
        drawNeck(b, look.face, scarfColor, !!hero);
      }
      // A hero's head brings its own neck; this one only fills in under it, so it stays thin enough to keep inside.
      b.capsule(0, 0.54, 0, 0, 0.62, 0, hero ? 0.034 : 0.05, skin, 8);
    }, girth, hero?.belly ?? 0),
    head: mk((b) => {
      if (hero) {
        heroHead(b, hero, look, p, scarfColor);
        return;
      }
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
      upperArm(b, look, sleeve, raider, short ? skin : undefined);
      if (p.band) b.torus(0, -0.12, 0, 0.066, 0.018, S.cloth(p.band, 0.4), Math.PI / 2, 0, 0, 6, 12);
    }, limb),
    upperR: mk((b) => upperArm(b, look, sleeve, raider, short ? skin : undefined), limb),
    foreL: mk((b) => (raider ? forearm(b, jacket, glove) : drawHand(b, look.hands, sleeve, skin, short)), limb),
    foreR: mk((b) => (raider ? forearm(b, jacket, glove) : drawHand(b, look.hands, sleeve, skin, short)), limb),
    thighL: mk((b) => thigh(b, pants, raider, look, pantsColor, skin, 1), limb),
    thighR: mk((b) => thigh(b, pants, raider, look, pantsColor, skin, -1), limb),
    shinL: mk((b) => (raider ? shin(b, pants, boot, true) : drawShin(b, look.legs, look.feet, pantsColor, skin)), limb),
    shinR: mk((b) => (raider ? shin(b, pants, boot, true) : drawShin(b, look.legs, look.feet, pantsColor, skin)), limb),
  };
  partCache.set(key, parts);
  return parts;
}

/**
 * Broaden (or slim) a finished part about its own vertical axis, and push the belly out in front. Normals follow the
 * inverse of the stretch so the shading stays right.
 */
function fitBuild(b: MeshBuilder, g: number, belly: number) {
  const P = b.pos;
  const Nn = b.nor;
  for (let i = 0; i < P.length; i += 3) {
    let gz = g;
    if (belly > 0 && P[i + 2] > 0) gz *= 1 + belly * Math.max(0, Math.sin(Math.PI * clamp01((P[i + 1] + 0.02) / 0.34)));
    P[i] *= g;
    P[i + 2] *= gz;
    const nx = Nn[i] / g;
    const ny = Nn[i + 1];
    const nz = Nn[i + 2] / gz;
    const l = Math.hypot(nx, ny, nz) || 1;
    Nn[i] = nx / l;
    Nn[i + 1] = ny / l;
    Nn[i + 2] = nz / l;
  }
}

/** The stock head's centre: head gear was drawn round it, so it is what gear is scaled about to fit a hero's skull. */
const STOCK_HEAD = new THREE.Vector3(0, 0.1, 0.005);

/** Ears, then whatever is worn on the head and over the face, moved from the stock head onto this hero's. */
function heroHead(b: MeshBuilder, hero: HeroLook, look: OutfitLook, p: Palette, scarf: number) {
  drawEars(b, hero.portrait);
  if (look.head.style !== 'bare') {
    const g = new MeshBuilder();
    g.jitter = 0.03;
    g.roundSeg = 2;
    drawHead(g, look.head, p.helmet ?? p.trim, look.face.style === 'goggles');
    const { y, z, s } = hero.hat;
    const m = new THREE.Matrix4()
      .makeTranslation(STOCK_HEAD.x, STOCK_HEAD.y + y, STOCK_HEAD.z + z)
      .multiply(new THREE.Matrix4().makeScale(s, s, s))
      .multiply(new THREE.Matrix4().makeTranslation(-STOCK_HEAD.x, -STOCK_HEAD.y, -STOCK_HEAD.z));
    b.appendMatrix(g, m);
  }
  // The bandana is drawn round the neck instead (see the torso); goggles and masks go over the eyes and mouth.
  if (look.face.style !== 'bandana' && look.face.style !== 'none') {
    const g = new MeshBuilder();
    g.jitter = 0.03;
    g.roundSeg = 2;
    drawFace(g, look.face, scarf);
    b.appendMatrix(g, new THREE.Matrix4().makeTranslation(0, hero.mask.y, hero.mask.z));
  }
}

/** A hero's textured face and hair, or null for anyone else. */
function faceGeometry(p: Palette): THREE.BufferGeometry | null {
  if (!p.hero || p.mask) return null;
  const look = p.look ?? DEFAULT_LOOK;
  return portraitGeometry(HERO_LOOKS[p.hero].portrait, look.head.style === 'bare' ? 'full' : 'covered');
}

function upperArm(b: MeshBuilder, look: OutfitLook, sleeve: ReturnType<typeof S.cloth>, raider: boolean, bare?: ReturnType<typeof S.skin>) {
  if (raider) {
    b.limb(0, -0.02, 0, 0, -0.27, 0, 0.065, 0.054, sleeve, 10);
    b.box(0, -0.16, 0, 0.13, 0.04, 0.13, S.leather(0x2a1e16, 0.5));
  } else drawUpperArm(b, look.body, sleeve, bare);
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

export type Held = 'none' | GunModel | MeleeModel | 'wrench' | 'jerrycan' | 'crowbar' | 'flare';
const weaponCache = new Map<string, THREE.BufferGeometry>();

/** A weapon's solids. `mods` is the fitted add-ons' look key (`lookKey` in `sim/gunmods.ts`), empty for a bare gun; each different set is its own cached geometry. */
function weaponGeometry(kind: Exclude<Held, 'none'>, mods = ''): THREE.BufferGeometry {
  const ck = mods ? `${kind}|${mods}` : kind;
  const hit = weaponCache.get(ck);
  if (hit) return hit;
  const looks = parseLooks(mods);
  const b = new MeshBuilder();
  b.jitter = 0.02;
  const gun = S.metal(0x232426, 0.35);
  const grip = S.plastic(0x1a1a1a, 0.3);
  const HALF = Math.PI / 2;
  const dark = S.metal(0x0a0a0a);
  const rail = S.metal(0x3a3c40, 0.4);
  switch (kind) {
    case 'pistol':
      b.rbox(0, 0.03, 0.12, 0.034, 0.05, 0.22, 0.008, gun);
      b.rbox(0, -0.035, 0.04, 0.03, 0.11, 0.05, 0.008, grip, -0.25, 0, 0);
      b.box(0, -0.0, 0.085, 0.012, 0.03, 0.04, gun);
      b.cyl(0, 0.035, 0.235, 0.014, 0.02, 0.014, S.metal(0x0a0a0a), Math.PI / 2, 0, 0, 8);
      break;
    case 'revolver': {
      const wood = S.wood(0x5a3e28, 0.5);
      b.rbox(0, 0.035, 0.1, 0.036, 0.05, 0.17, 0.008, gun);
      b.cyl(0, 0.04, 0.225, 0.022, 0.15, 0.022, gun, Math.PI / 2, 0, 0, 8);
      b.cyl(0, 0.03, 0.085, 0.052, 0.07, 0.052, S.metal(0x2c2e30, 0.35), Math.PI / 2, 0, 0, 10);
      b.rbox(0, -0.04, 0.03, 0.032, 0.105, 0.048, 0.01, wood, -0.3, 0, 0);
      b.box(0, 0.068, 0.0, 0.012, 0.025, 0.03, gun);
      b.box(0, 0.07, 0.2, 0.01, 0.014, 0.18, gun);
      break;
    }
    case 'smg':
      b.rbox(0, 0.02, 0.15, 0.045, 0.075, 0.34, 0.01, gun);
      b.cyl(0, 0.03, 0.38, 0.02, 0.14, 0.02, S.metal(0x0a0a0a), Math.PI / 2, 0, 0, 8);
      b.rbox(0, -0.1, 0.14, 0.028, 0.17, 0.05, 0.006, gun);
      b.rbox(0, -0.05, 0.04, 0.032, 0.105, 0.046, 0.008, grip, -0.2, 0, 0);
      b.box(0, 0.065, 0.16, 0.014, 0.012, 0.3, S.metal(0x3a3c40, 0.4));
      b.box(0, 0.02, -0.1, 0.018, 0.018, 0.2, gun);
      b.rbox(0, -0.005, -0.22, 0.03, 0.09, 0.03, 0.008, gun);
      break;
    case 'sawn': {
      const wood = S.wood(0x5a3e28, 0.5);
      for (const sx of [1, -1]) b.cyl(sx * 0.016, 0.035, 0.2, 0.027, 0.34, 0.027, gun, Math.PI / 2, 0, 0, 8);
      b.rbox(0, 0.028, 0.02, 0.06, 0.075, 0.1, 0.012, gun);
      b.rbox(0, -0.03, -0.01, 0.04, 0.1, 0.07, 0.015, wood, 0.35, 0, 0);
      b.rbox(0, 0.0, 0.14, 0.052, 0.035, 0.12, 0.012, wood);
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
      // The worn scope it comes with: taken off when a better optic goes on the rail.
      if (!looks.optic) b.cyl(0, 0.1, 0.2, 0.04, 0.16, 0.04, S.metal(0x111111, 0.3), Math.PI / 2, 0, 0, 10);
      break;
    case 'compact':
      b.rbox(0, 0.028, 0.1, 0.032, 0.046, 0.17, 0.008, gun);
      b.rbox(0, -0.03, 0.035, 0.028, 0.095, 0.045, 0.008, grip, -0.2, 0, 0);
      b.box(0, 0.0, 0.075, 0.01, 0.025, 0.035, gun);
      b.cyl(0, 0.032, 0.195, 0.012, 0.025, 0.012, dark, HALF, 0, 0, 8);
      break;
    case 'cannon': {
      const wood = S.wood(0x4a3220, 0.5);
      b.rbox(0, 0.04, 0.1, 0.04, 0.06, 0.2, 0.01, gun);
      b.cyl(0, 0.045, 0.28, 0.032, 0.22, 0.032, gun, HALF, 0, 0, 8);
      b.cyl(0, 0.035, 0.085, 0.058, 0.08, 0.058, S.metal(0x2c2e30, 0.35), HALF, 0, 0, 10);
      b.rbox(0, -0.045, 0.03, 0.034, 0.11, 0.05, 0.01, wood, -0.3, 0, 0);
      b.box(0, 0.08, 0.0, 0.012, 0.025, 0.03, gun);
      b.box(0, 0.082, 0.24, 0.012, 0.012, 0.26, rail);
      break;
    }
    case 'mp':
      b.rbox(0, 0.03, 0.1, 0.04, 0.07, 0.26, 0.01, gun);
      b.cyl(0, 0.035, 0.25, 0.016, 0.05, 0.016, dark, HALF, 0, 0, 8);
      b.rbox(0, -0.1, 0.08, 0.026, 0.18, 0.044, 0.006, gun);
      b.rbox(0, -0.04, 0.0, 0.03, 0.1, 0.046, 0.008, grip, -0.2, 0, 0);
      b.box(0, 0.068, 0.1, 0.012, 0.01, 0.2, rail);
      break;
    case 'smg2':
      b.rbox(0, 0.02, 0.13, 0.046, 0.08, 0.3, 0.01, gun);
      b.cyl(0, 0.03, 0.34, 0.026, 0.12, 0.026, gun, HALF, 0, 0, 8);
      b.cyl(0, 0.03, 0.42, 0.014, 0.04, 0.014, dark, HALF, 0, 0, 8);
      b.rbox(0, -0.1, 0.12, 0.028, 0.17, 0.05, 0.006, gun);
      b.rbox(0, -0.05, 0.03, 0.032, 0.1, 0.046, 0.008, grip, -0.2, 0, 0);
      b.box(0, 0.065, 0.14, 0.014, 0.012, 0.26, rail);
      for (const sx of [1, -1]) b.rod(sx * 0.015, 0.025, -0.02, sx * 0.015, 0.0, -0.24, 0.006, gun, 5);
      b.rbox(0, -0.005, -0.25, 0.03, 0.09, 0.02, 0.006, gun);
      break;
    case 'carbine': {
      const wood = S.wood(0x5a3e28, 0.5);
      b.rbox(0, 0.02, 0.2, 0.045, 0.08, 0.42, 0.01, gun);
      b.cyl(0, 0.032, 0.5, 0.022, 0.26, 0.022, gun, HALF, 0, 0, 8);
      b.rbox(0, 0.015, 0.42, 0.052, 0.062, 0.2, 0.012, wood);
      b.rbox(0, -0.005, -0.12, 0.042, 0.095, 0.26, 0.014, wood, 0.08, 0, 0);
      b.rbox(0, -0.1, 0.16, 0.03, 0.16, 0.05, 0.006, gun, 0.18, 0, 0);
      b.rbox(0, -0.05, 0.04, 0.032, 0.1, 0.046, 0.008, grip, -0.3, 0, 0);
      b.box(0, 0.066, 0.2, 0.016, 0.012, 0.3, rail);
      break;
    }
    case 'ar':
      b.rbox(0, 0.02, 0.22, 0.05, 0.085, 0.46, 0.01, gun);
      b.rbox(0, 0.02, 0.58, 0.056, 0.066, 0.26, 0.012, gun);
      b.cyl(0, 0.034, 0.8, 0.018, 0.2, 0.018, dark, HALF, 0, 0, 8);
      b.box(0, 0.07, 0.3, 0.018, 0.014, 0.4, rail);
      b.rbox(0, 0.0, -0.16, 0.04, 0.09, 0.3, 0.012, gun, 0.05, 0, 0);
      b.rbox(0, -0.105, 0.2, 0.03, 0.16, 0.052, 0.006, gun, 0.2, 0, 0);
      b.rbox(0, -0.06, 0.05, 0.032, 0.11, 0.046, 0.008, grip, -0.3, 0, 0);
      break;
    case 'br': {
      const wood = S.wood(0x5a3e28, 0.5);
      b.rbox(0, 0.02, 0.24, 0.052, 0.09, 0.5, 0.01, gun);
      b.rbox(0, 0.015, 0.62, 0.058, 0.07, 0.28, 0.014, wood);
      b.cyl(0, 0.032, 0.85, 0.02, 0.16, 0.02, dark, HALF, 0, 0, 8);
      b.rbox(0, -0.005, -0.18, 0.046, 0.105, 0.34, 0.014, wood, 0.08, 0, 0);
      b.rbox(0, -0.11, 0.22, 0.034, 0.17, 0.06, 0.006, gun);
      b.rbox(0, -0.06, 0.05, 0.032, 0.11, 0.046, 0.008, grip, -0.3, 0, 0);
      b.box(0, 0.07, 0.26, 0.018, 0.014, 0.36, rail);
      break;
    }
    case 'dmr': {
      const poly = S.plastic(0x2a2c2e, 0.3);
      b.rbox(0, 0.02, 0.26, 0.05, 0.085, 0.5, 0.01, gun);
      b.rbox(0, 0.02, 0.62, 0.056, 0.06, 0.3, 0.012, gun);
      b.cyl(0, 0.034, 0.95, 0.026, 0.3, 0.026, gun, HALF, 0, 0, 8);
      b.rbox(0, 0.0, -0.18, 0.045, 0.11, 0.36, 0.014, poly, 0.05, 0, 0);
      b.rbox(0, 0.06, -0.14, 0.036, 0.03, 0.2, 0.01, poly);
      b.rbox(0, -0.11, 0.24, 0.032, 0.17, 0.056, 0.006, gun);
      b.rbox(0, -0.06, 0.05, 0.032, 0.11, 0.046, 0.008, grip, -0.3, 0, 0);
      b.box(0, 0.068, 0.3, 0.018, 0.014, 0.42, rail);
      break;
    }
    case 'sniper':
      b.rbox(0, 0.02, 0.3, 0.052, 0.09, 0.6, 0.01, gun);
      b.cyl(0, 0.034, 0.9, 0.03, 0.62, 0.03, gun, HALF, 0, 0, 10);
      b.rbox(0, -0.01, -0.2, 0.05, 0.12, 0.4, 0.016, S.plastic(0x2c3028, 0.35), 0.04, 0, 0);
      b.rod(0.03, 0.04, 0.1, 0.075, 0.0, 0.08, 0.005, gun, 5);
      b.sphereAt(0.077, -0.004, 0.08, 0.01, gun);
      b.rbox(0, -0.07, 0.3, 0.03, 0.07, 0.05, 0.006, gun);
      b.box(0, 0.068, 0.3, 0.018, 0.014, 0.5, rail);
      break;
    case 'lever': {
      const wood = S.wood(0x6a4a2c, 0.5);
      const brass = S.metal(0x6a5632, 0.5);
      b.rbox(0, 0.02, 0.22, 0.045, 0.075, 0.4, 0.01, brass);
      b.cyl(0, 0.04, 0.6, 0.024, 0.5, 0.024, gun, HALF, 0, 0, 8);
      b.cyl(0, 0.008, 0.6, 0.018, 0.48, 0.018, gun, HALF, 0, 0, 8);
      b.rbox(0, 0.0, 0.55, 0.05, 0.04, 0.24, 0.012, wood);
      b.rbox(0, -0.01, -0.12, 0.045, 0.1, 0.28, 0.015, wood, 0.1, 0, 0);
      b.rbox(0, -0.06, 0.15, 0.01, 0.07, 0.1, 0.004, brass);
      b.box(0, 0.062, 0.1, 0.012, 0.014, 0.04, gun);
      break;
    }
    case 'crossbow': {
      const wood = S.wood(0x5a3e28, 0.5);
      b.rbox(0, 0.0, 0.2, 0.04, 0.07, 0.7, 0.012, wood);
      for (const sx of [1, -1]) b.rbox(sx * 0.17, 0.035, 0.5, 0.36, 0.014, 0.03, 0.005, gun, 0, -sx * 0.35, 0);
      b.rod(-0.31, 0.035, 0.4, 0.31, 0.035, 0.4, 0.003, S.cloth(0xd8d0b0, 0.5), 5);
      b.torus(0, 0.03, 0.58, 0.03, 0.008, gun, 0, 0, 0, 5, 12);
      b.box(0, 0.04, 0.25, 0.012, 0.01, 0.5, rail);
      b.rbox(0, -0.06, 0.0, 0.03, 0.1, 0.045, 0.01, grip, -0.25, 0, 0);
      b.rod(0, 0.05, 0.15, 0, 0.05, 0.55, 0.005, S.steel(0x8a8e92, 0.4), 5);
      b.cyl(0, 0.05, 0.57, 0.012, 0.03, 0.012, S.chrome(0xc4c8cc), HALF, 0, 0, 5);
      break;
    }
    case 'combat':
      b.rbox(0, 0.03, 0.08, 0.052, 0.085, 0.26, 0.012, gun);
      b.cyl(0, 0.042, 0.52, 0.026, 0.58, 0.026, gun, HALF, 0, 0, 8);
      b.cyl(0, 0.01, 0.46, 0.022, 0.48, 0.022, gun, HALF, 0, 0, 8);
      b.rbox(0, 0.0, 0.45, 0.05, 0.05, 0.2, 0.012, grip);
      b.rbox(0, -0.01, -0.2, 0.045, 0.1, 0.3, 0.015, grip, 0.08, 0, 0);
      b.rbox(0, -0.04, 0.0, 0.03, 0.08, 0.05, 0.008, grip, -0.15, 0, 0);
      b.box(0, 0.075, 0.08, 0.016, 0.012, 0.24, rail);
      break;
    case 'coach': {
      const wood = S.wood(0x5a3e28, 0.5);
      for (const sx of [1, -1]) b.cyl(sx * 0.016, 0.035, 0.4, 0.027, 0.64, 0.027, gun, HALF, 0, 0, 8);
      b.rbox(0, 0.028, 0.04, 0.06, 0.075, 0.1, 0.012, gun);
      b.rbox(0, 0.0, 0.3, 0.052, 0.035, 0.16, 0.012, wood);
      b.rbox(0, -0.03, -0.1, 0.042, 0.1, 0.28, 0.015, wood, 0.25, 0, 0);
      for (const sx of [1, -1]) b.box(sx * 0.02, 0.07, -0.01, 0.01, 0.022, 0.02, gun);
      break;
    }
    case 'lmg':
      b.rbox(0, 0.02, 0.2, 0.06, 0.1, 0.5, 0.012, gun);
      b.rbox(0, 0.04, 0.55, 0.05, 0.065, 0.22, 0.012, S.metal(0x2a2c2e, 0.4));
      b.cyl(0, 0.04, 0.68, 0.026, 0.3, 0.026, dark, HALF, 0, 0, 8);
      b.rbox(0, -0.1, 0.18, 0.1, 0.12, 0.12, 0.012, S.paint(0x4a5236, 0.5));
      b.rbox(0, 0.09, 0.4, 0.016, 0.02, 0.2, 0.005, gun);
      b.rbox(0, 0.0, -0.2, 0.05, 0.11, 0.36, 0.014, gun, 0.04, 0, 0);
      b.rbox(0, -0.06, 0.05, 0.034, 0.11, 0.05, 0.008, grip, -0.25, 0, 0);
      b.box(0, 0.082, 0.22, 0.018, 0.012, 0.3, rail);
      break;
    case 'pipe':
      b.cyl(0, 0, 0.36, 0.034, 0.72, 0.034, S.metal(0x6a6e72, 0.6), HALF, 0, 0, 10);
      b.cyl(0, 0, 0.04, 0.04, 0.16, 0.04, S.cloth(0x1c1c1c, 0.6), HALF, 0, 0, 8);
      b.cyl(0, 0, 0.73, 0.04, 0.02, 0.04, S.steel(0x5c6266), HALF, 0, 0, 10);
      break;
    case 'sledge':
      b.cyl(0, 0, 0.38, 0.03, 0.8, 0.03, S.wood(0x8a6a3e, 0.5), HALF, 0, 0, 8);
      b.rbox(0, 0, 0.82, 0.2, 0.1, 0.1, 0.012, S.steel(0x7a7e82, 0.5));
      b.rbox(0, 0, 0.82, 0.215, 0.08, 0.075, 0.006, S.chrome(0xa8acb0));
      b.cyl(0, 0, 0.04, 0.036, 0.16, 0.036, S.cloth(0x1c1c1c, 0.6), HALF, 0, 0, 8);
      break;
    case 'katana':
      b.rbox(0, 0, 0.47, 0.008, 0.032, 0.66, 0.003, S.chrome(0xc4c8cc));
      b.cyl(0, 0, 0.13, 0.062, 0.01, 0.062, S.metal(0x2a2a2a, 0.4), HALF, 0, 0, 12);
      b.cyl(0, 0, 0.0, 0.028, 0.22, 0.028, S.cloth(0x1c1c20, 0.6), HALF, 0, 0, 8);
      b.torus(0, 0, 0.0, 0.016, 0.003, S.cloth(0x8a2a2a, 0.5), 0, HALF, 0, 4, 10);
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
  if (mods) drawMods(b, kind as GunModel, looks);
  const g = shared(b.build());
  weaponCache.set(ck, g);
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
  private heldMods = '';
  /** Muzzle flash size, 1 for a bare gun: a suppressor or flash hider shrinks it, a compensator or brake flares it. */
  flashK = 1;
  /** 1 at the start of a melee swing, counting down to 0: raises the weapon arm overhead and brings it down. */
  swing = 0;
  private walkT = 0;
  meshes: THREE.Mesh[] = [];
  /** Everything but the arms and what they hold: hidden from the owner's own first-person view. */
  private bodyMeshes: THREE.Mesh[] = [];

  /** One mesh per body part, so `dress` can swap a survivor's clothes without rebuilding the rig. */
  private partMesh = {} as Record<Part, THREE.Mesh>;
  /** A hero's textured face and hair, on the head. */
  private face: THREE.Mesh | null = null;
  /** The palette last dressed in, so an owner can tell whether there is anything to change. */
  worn: Palette;

  constructor(pal: Palette) {
    this.worn = pal;
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
    this.fit(pal);
  }

  /** Change clothes: swap every body part for the ones this palette draws. Geometry is cached per palette, so this is cheap. */
  dress(pal: Palette) {
    this.worn = pal;
    const g = bodyParts(pal);
    for (const part of Object.keys(this.partMesh) as Part[]) this.partMesh[part].geometry = g[part];
    this.fit(pal);
  }

  /** A hero's face on the head, and the rig at their height and build; the stock survivor's otherwise. */
  private fit(pal: Palette) {
    const geo = faceGeometry(pal);
    const hero = geo && pal.hero ? HERO_LOOKS[pal.hero] : null;
    if (geo && hero) {
      if (!this.face) {
        this.face = new THREE.Mesh(geo, portraitMaterial(hero.portrait));
        this.face.castShadow = true;
        this.head.add(this.face);
        this.meshes.push(this.face);
        this.bodyMeshes.push(this.face);
      }
      this.face.geometry = geo;
      this.face.material = portraitMaterial(hero.portrait);
    } else if (this.face) {
      const f = this.face;
      this.head.remove(f);
      this.meshes = this.meshes.filter((m) => m !== f);
      this.bodyMeshes = this.bodyMeshes.filter((m) => m !== f);
      this.face = null;
    }
    const girth = hero?.girth ?? 1;
    this.root.scale.setScalar(hero?.scale ?? 1);
    this.head.scale.setScalar(hero?.head ?? 1);
    this.head.position.y = 0.6 - (hero?.neck ?? 0);
    this.armL.position.x = 0.22 * girth;
    this.armR.position.x = -0.22 * girth;
    this.legL.position.x = 0.1 * girth;
    this.legR.position.x = -0.1 * girth;
  }

  /**
   * First person: hide the head, torso and legs, so the camera at the eyes sees only the arms and what they hold.
   * Applied just before the owner's view draws and undone just after, so a partner's view still sees the whole survivor.
   */
  setFirstPerson(on: boolean) {
    for (const m of this.bodyMeshes) m.visible = !on;
  }

  /** Swap the item in the right hand. Cheap to call every frame: geometry is cached per item. */
  setWeapon(kind: Held, mods = '') {
    if (kind === this.held && mods === this.heldMods) return;
    this.held = kind;
    this.heldMods = mods;
    if (this.weapon) {
      this.hand.remove(this.weapon);
      this.weapon = null;
    }
    if (kind === 'none') return;
    // The flash comes out of the muzzle of a gun, with its barrel and muzzle device counted in.
    if (GUN_MODELS.includes(kind as GunModel)) {
      const tip = muzzleAt(kind as GunModel, parseLooks(mods));
      this.flash.position.set(0, tip.y, tip.z + 0.02);
    } else this.flash.position.set(0, 0.03, 0.32);
    const m = new THREE.Mesh(weaponGeometry(kind, mods), mat);
    m.castShadow = true;
    this.hand.add(m);
    this.weapon = m;
  }

  private carried: THREE.Object3D | null = null;

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
    if (on) {
      this.flash.rotation.set(Math.random() * 6, Math.random() * 6, 0);
      this.flash.scale.setScalar(this.flashK);
    }
  }

  /**
   * Pose the rig. `speed` is horizontal speed in m/s for walk cycles; `aim` raises the weapon arm;
   * `crouch` 0..1 lowers the stance, `air` 0..1 tucks the legs for a jump or a fall.
   */
  /** Barrel wander (yaw, pitch, radians) and how hard the last shot is still kicking, set by the owner each frame. */
  gunSway: [number, number] = [0, 0];
  gunKick = 0;

  update(dt: number, pose: PoseKind, speed: number, aim: number, crouch: number, lookPitch = 0, air = 0) {
    this.walkT += dt * (1.5 + speed * 1.1);
    const run = Math.min(1, speed / 3.5) * (1 - air);
    const sw = Math.sin(this.walkT * 2) * run;
    const bob = Math.abs(Math.cos(this.walkT * 2)) * run;
    const r = this.root;
    const h = this.hips;
    r.rotation.x = 0;
    // The owner places the root (feet height, saddle offset); the pose must not touch its position.
    h.position.z = 0;
    this.torso.rotation.set(0, 0, 0);
    this.head.rotation.set(0, 0, 0);
    this.armL.rotation.set(0, 0, 0);
    this.armR.rotation.set(0, 0, 0);
    this.elbowL.rotation.set(0, 0, 0);
    this.elbowR.rotation.set(0, 0, 0);
    this.hand.rotation.set(0, 0, 0);
    if (pose === 'stand' || pose === 'gun') {
      h.position.y = 0.92 - crouch * 0.32 + bob * 0.03;
      const bend = crouch * 1.1;
      this.legL.rotation.x = sw * 0.75 - bend * 0.4;
      this.legR.rotation.x = -sw * 0.75 - bend * 0.4;
      this.kneeL.rotation.x = Math.max(0, -sw) * 0.9 + bend + run * 0.15;
      this.kneeR.rotation.x = Math.max(0, sw) * 0.9 + bend + run * 0.15;
      this.torso.rotation.x = crouch * 0.35 + (speed > 5 ? 0.18 : 0.04);
      this.torso.rotation.y = sw * 0.12 * (1 - aim);
      this.armL.rotation.x = -sw * 0.65 * (1 - aim);
      this.armR.rotation.x = aim > 0.1 ? -1.4 * aim + lookPitch * 0.5 : sw * 0.65;
      this.armL.rotation.z = 0.08;
      this.armR.rotation.z = -0.08;
      this.elbowL.rotation.x = -0.25 - run * 0.5;
      this.elbowR.rotation.x = aim > 0.1 ? -0.1 : -0.25 - run * 0.5;
      // Raised, the forearm points down the sights; the hand turns back so the weapon points the same way instead of at the sky.
      if (aim > 0.1) this.hand.rotation.x = 1.4 * aim + 0.1;
      if (aim > 0.1) {
        // Support hand comes across to the grip.
        this.armL.rotation.x = -1.2 * aim + lookPitch * 0.45;
        this.armL.rotation.z = -0.45 * aim;
        this.elbowL.rotation.x = -0.55 * aim;
      }
      if (aim > 0.1 && !this.carried) {
        // The gun wanders in the hands and bucks back with each shot: arms rock up, elbows give, the shoulders take it.
        this.armR.rotation.x += this.gunSway[1] * 2.2 * aim - this.gunKick * 0.28;
        this.armR.rotation.y += this.gunSway[0] * 2.2 * aim;
        this.armL.rotation.x += this.gunSway[1] * 2.2 * aim - this.gunKick * 0.26;
        this.armL.rotation.y += this.gunSway[0] * 2.2 * aim;
        this.elbowR.rotation.x -= this.gunKick * 0.2;
        this.torso.rotation.x -= this.gunKick * 0.07;
      }
      this.head.rotation.x = lookPitch * 0.4 - this.torso.rotation.x * 0.6;
      if (this.swing > 0 && !this.carried) {
        // Wind up overhead, then chop down across the body.
        const e = 1 - this.swing;
        this.armR.rotation.x = lerp(-2.7, -0.5, e * e);
        this.elbowR.rotation.x = lerp(-0.2, -0.9, e);
        this.torso.rotation.y = lerp(0.45, -0.4, e);
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
      }
    } else if (pose === 'ride') {
      // Astride a moped: hips down, knees bent, arms out to the bars. The saddle is where it is, however tall the rider.
      h.position.y = 0.45 / r.scale.y;
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
      h.position.y = 0.4 / r.scale.y;
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

  dispose() {
    // Geometry is shared per palette and per weapon; nothing to free per instance.
  }
}

/** A weapon or tool as its own mesh, as held in the hand, for models that lie about the world (`render/gearModels.ts`). Geometry is shared and cached. */
export function weaponMesh(kind: Exclude<Held, 'none'>, mods = ''): THREE.Mesh {
  const m = new THREE.Mesh(weaponGeometry(kind, mods), mat);
  m.castShadow = true;
  return m;
}

export { basicLight };
