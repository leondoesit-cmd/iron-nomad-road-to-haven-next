import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { C } from './palette';
import { clamp, clamp01, damp, lerp, wrapAngle } from '../core/math';
import { swingPose } from '../sim/weaponfx';
import { GUN_POINTS } from '../sim/weaponanim';
import { drillPose, newDrillPose, offGrip, type Drill } from '../sim/gunDrills';
import { shared } from './dispose';
import { applyKit, kitMaterial } from './materials';
import { drawMods, muzzleAt } from './gunMods';
import { buildModel, weaponMaterial, type Lod } from './weapons';
import { parseLooks } from '../sim/gunmods';
import { GUN_MODELS, type GunModel, type MeleeModel } from '../data/gear';
import type { HeroId } from '../data/heroes';
import { HERO_LOOKS, type HeroLook } from './heroLooks';
import { drawEars, portraitGeometry, portraitMaterial, type PortraitSpec } from './portrait';
import { MuzzleFlash } from './muzzleFlash';
import { BowRig, drawBow } from './bow';
import { flashes } from '../sim/weaponfx';
import { drawTropicalArmHair, drawTropicalSleeve } from './tropicalShirt';
import { LeisureRig, type LeisurePose } from './leisure';
import { NuhatRig, type CharacterExpression } from './nuhat';
import { drawGlasses } from './spectacles';
import { UdudRig } from './udud';
import {
  DEFAULT_LOOK,
  drawBody,
  drawFace,
  drawHand,
  drawHead,
  drawHips,
  drawNeck,
  drawPack,
  drawShin,
  drawThigh,
  drawUpperArm,
  drawWaist,
  shortSleeves,
  quiltedSleeves,
  sleeveColor,
  trouserColor,
  type OutfitLook,
  type PackStyle,
} from './outfit';

const mat = kitMaterial();
/** Every weapon model is drawn with the weapon material: the kit plus wood grain, stippling, parkerizing and worn edges. */
const weaponMat = weaponMaterial();
/**
 * A hero's body: the kit material without its dents and casting texture, which made cloth and skin look like clay, and
 * without the grime map's tone shift where there is no grime (it mottled clean cloth, and changed from one body part to
 * the next, since each samples it in its own frame).
 */
const heroMat = (() => {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    applyKit(shader, false);
    shader.fragmentShader = shader.fragmentShader.replace('diffuseColor.rgb *= 0.9 + kitG.g * 0.2;', 'diffuseColor.rgb *= 1.0 + ( kitG.g - 0.5 ) * 0.2 * min( kitWear, 1.0 );');
  };
  m.customProgramCacheKey = () => 'kit:hero';
  return shared(m);
})();
/** How much of the usual grime a hero's clothes and skin carry. */
const HERO_WEAR = 0.22;
const bodyMaterial = (p: Palette) => (p.hero && !p.mask ? heroMat : mat);
const basicLight = shared(new THREE.MeshBasicMaterial({ color: 0xfff6d0 }));

/**
 * `seat` is in a vehicle's seat and `ride` astride a bike; `sit` is sat on the ground and `lie` lying on the back at rest,
 * both of them still. `downed` is lying hurt, stirring.
 */
export type PoseKind = 'stand' | 'ride' | 'seat' | 'downed' | 'gun' | 'sit' | 'lie';

/** How far a body lying on its back is propped up by what is on it, radians: the pack under it is a backrest. */
const PACK_RECLINE: Record<PackStyle, number> = { none: 0, satchel: 0.1, ruck: 0.72, duffel: 0.8, frame: 0.95 };

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
  const pantsColor = trouserColor(look.legs, p.pants ?? hero?.pants ?? 0x3d3f3a);
  const pants = S.cloth(raider ? (p.pants ?? 0x3d3f3a) : pantsColor, 0.6);
  const skin = S.skin(hero?.skin ?? p.skin ?? C.skin);
  const leather = S.leather(0x3b2a1e, 0.5);
  const boot = S.leather(0x2a211b, 0.6);
  const glove = S.leather(0x2b2622, 0.4);
  const buckle = S.metal(0x8a8478, 0.4);
  const helmet = p.mask ? S.metal(p.helmet ?? 0x111111, 0.5) : S.paint(p.helmet ?? p.trim, 0.6);
  const scarfColor = p.scarf ?? p.trim;
  const sleeve = raider ? jacket : S.cloth(sleeveColor(look.body, p.jacket, hero?.puffer ?? hero?.over ?? hero?.shirt), 0.55);
  // In nothing but a T-shirt the forearms are bare.
  const short = !raider && shortSleeves(look.body, hero ?? undefined);
  const rolled = !raider && look.body.style === 'shirt' && !!hero?.rolledSleeves;
  const tropical = !raider && look.body.style === 'shirt' ? hero?.tropical : undefined;
  const quilted = !raider && quiltedSleeves(look.body, hero ?? undefined);
  // A hero's build: torso and pelvis as broad as their weight makes them, limbs a little less so.
  const girth = hero?.girth ?? 1;
  const limb = 1 + (girth - 1) * 0.9;
  // A hero's clothes and skin are kept clean: hardly any grime and no colour mottling (what is worn on the head keeps its wear).
  const mk = (fn: (b: MeshBuilder) => void, gx = 1, belly = 0, clean = !!hero) => {
    const b = new MeshBuilder();
    b.jitter = hero ? 0.008 : 0.03;
    b.roundSeg = 2;
    fn(b);
    if (clean) for (let i = 2; i < b.srf.length; i += 4) b.srf[i] *= HERO_WEAR;
    if (gx !== 1 || belly > 0) fitBuild(b, gx, belly);
    return shared(b.build());
  };
  // Plain trousers (or none) have a plain belt, not the survival belt with its pouches.
  const casual = !raider && (look.legs.style === 'trousers' || look.legs.style === 'bare');
  const parts: Record<Part, THREE.BufferGeometry> = {
    pelvis: mk(
      (b) => {
        if (casual) drawWaist(b, look.legs, pantsColor);
        else {
          b.rbox(0, -0.02, 0, 0.33, 0.2, 0.21, 0.07, pants);
          // Belt with buckle and pouches.
          b.rbox(0, 0.07, 0, 0.35, 0.055, 0.23, 0.025, leather);
          b.box(0, 0.07, 0.118, 0.06, 0.045, 0.01, buckle);
          for (const sx of [1, -1]) b.rbox(sx * 0.15, 0.03, 0.06, 0.07, 0.09, 0.06, 0.015, raider ? leather : trim);
          b.rbox(-0.1, 0.03, -0.11, 0.1, 0.09, 0.06, 0.015, leather);
        }
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
    }, 1, 0, false),
    upperL: mk((b) => {
      if (tropical !== undefined) drawTropicalSleeve(b, tropical);
      else upperArm(b, look, sleeve, raider, short || rolled ? skin : undefined, quilted, rolled && !short ? 0.245 : 0.14);
      if (rolled) b.torus(0, -0.25, 0, 0.056, 0.017, sleeve, Math.PI / 2, 0, 0, 6, 16);
      if (p.band) b.torus(0, -0.12, 0, 0.066, 0.018, S.cloth(p.band, 0.4), Math.PI / 2, 0, 0, 6, 12);
    }, limb),
    upperR: mk((b) => {
      if (tropical !== undefined) drawTropicalSleeve(b, tropical);
      else upperArm(b, look, sleeve, raider, short || rolled ? skin : undefined, quilted, rolled && !short ? 0.245 : 0.14);
      if (rolled) b.torus(0, -0.25, 0, 0.056, 0.017, sleeve, Math.PI / 2, 0, 0, 6, 16);
    }, limb),
    foreL: mk((b) => {
      if (raider) forearm(b, jacket, glove);
      else {
        drawHand(b, look.hands, sleeve, skin, short || rolled, 1);
        if (tropical !== undefined) drawTropicalArmHair(b);
      }
    }, limb),
    foreR: mk((b) => {
      if (raider) forearm(b, jacket, glove);
      else {
        drawHand(b, look.hands, sleeve, skin, short || rolled, -1);
        if (tropical !== undefined) drawTropicalArmHair(b);
      }
    }, limb),
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
  if (hero.shades !== undefined && (look.face.style === 'bandana' || look.face.style === 'none')) drawShades(b, hero.portrait, hero.shades);
  if (p.hero !== 'udud' && hero.glasses !== undefined && (look.face.style === 'bandana' || look.face.style === 'none' || look.face.style === 'respirator')) drawGlasses(b, hero.portrait, hero.glasses);
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

/**
 * Wraparound sunglasses in the head's frame: two dark mirror lenses curved round the eyes and on round the sides of the
 * face, a bar along their tops under the brows, a bridge over the nose, and the arms back to the ears.
 */
function drawShades(b: MeshBuilder, spec: PortraitSpec, frame: number) {
  const s = spec.shape;
  const E = s.eyeY + 0.003;
  // The shield follows a flattened ellipse round the face: across the front clear of the brow and the bridge of the
  // nose, then back round the temples.
  const front = s.eyeZ + Math.max(0.024, s.brow + 0.01);
  const A = s.halfW + 0.007;
  const B = 0.1;
  const lens = S.glass(0x0a0c10);
  const rim = S.plastic(frame, 0.3);
  const n = 40;
  const end = 1.3;
  type P = [number, number, number];
  const top: P[] = [];
  const bot: P[] = [];
  const out: P[] = [];
  for (let i = 0; i <= n; i++) {
    const a = -end + (i / n) * end * 2;
    const c = Math.cos(a);
    const x = Math.sin(a) * A;
    const z = front - B + B * Math.sign(c) * Math.sqrt(Math.abs(c));
    // Deep over each eye, pinched over the nose, tapering to the temples; the top edge curves down a little at the sides.
    const ax = Math.abs(x);
    const eye = Math.exp(-(((ax - s.eyeX - 0.004) / 0.026) ** 2));
    const h = 0.012 + 0.03 * eye + 0.008 * smooth(0.03, 0.07, ax) * (1 - eye);
    const yt = E + 0.014 - 0.006 * (ax / A) ** 2;
    top.push([x, yt, z]);
    bot.push([x, yt - h * smooth(0, 0.012, ax + 0.004), z - 0.004 * eye]);
    // Outward along the ellipse's normal, for the frame's lip.
    const nx = Math.sin(a) * B;
    const nz = c * A;
    const l = Math.hypot(nx, nz);
    out.push([nx / l, 0, nz / l]);
  }
  for (let i = 0; i < n; i++) {
    b.quad(bot[i], bot[i + 1], top[i + 1], top[i], lens);
    // The inside face, a hair behind.
    const k = (p: P, o: P): P => [p[0] - o[0] * 0.0015, p[1], p[2] - o[2] * 0.0015];
    b.quad(k(top[i], out[i]), k(top[i + 1], out[i + 1]), k(bot[i + 1], out[i + 1]), k(bot[i], out[i]), lens);
  }
  // The frame: a thin bar along the top edge, then the arms back to the ears.
  b.pipe(top.map((p, i) => [p[0] + out[i][0] * 0.001, p[1] + 0.001, p[2] + out[i][2] * 0.001] as P), 0.0026, rim, 6);
  for (const i of [0, n]) b.capsule(top[i][0], top[i][1] - 0.004, top[i][2], Math.sign(top[i][0]) * (s.halfW + 0.004), E + 0.012, s.eyeZ + s.ear.z + 0.004, 0.0028, rim, 6);
}

/** A hero's textured face and hair, or null for anyone else. */
function faceGeometry(p: Palette): THREE.BufferGeometry | null {
  if (!p.hero || p.mask) return null;
  const look = p.look ?? DEFAULT_LOOK;
  return portraitGeometry(HERO_LOOKS[p.hero].portrait, look.head.style === 'bare' ? 'full' : 'covered');
}

function upperArm(b: MeshBuilder, look: OutfitLook, sleeve: ReturnType<typeof S.cloth>, raider: boolean, bare?: ReturnType<typeof S.skin>, quilted = false, cuff = 0.14) {
  if (raider) {
    b.limb(0, -0.02, 0, 0, -0.27, 0, 0.065, 0.054, sleeve, 10);
    b.box(0, -0.16, 0, 0.13, 0.04, 0.13, S.leather(0x2a1e16, 0.5));
  } else drawUpperArm(b, look.body, sleeve, bare, quilted, cuff);
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
  // Plain trousers and bare legs end round the knee itself, a hair rounder than the shin turning inside it, so the knee
  // reads as one smooth joint instead of two rounds cutting through each other.
  if (look.legs.style === 'trousers' || look.legs.style === 'bare') b.limb(0, 0, 0, 0, -0.43, 0, 0.088, 0.0625, look.legs.style === 'bare' ? skin : pants, 16);
  else b.limb(0, 0, 0, 0, -0.42, 0, 0.088, 0.066, pants, 16);
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
const _ra = new THREE.Vector3();
const [_bv, _bv2, _bv3, _bv4, _bv5] = [0, 0, 0, 0, 0].map(() => new THREE.Vector3());
const [_rv, _rv2, _rv3, _rv4, _rv5, _rv6, _rv7, _rv8] = [0, 0, 0, 0, 0, 0, 0, 0].map(() => new THREE.Vector3());
const [_bq, _bq2, _bq3, _bq4] = [0, 0, 0, 0].map(() => new THREE.Quaternion());
const _bm = new THREE.Matrix4();
const _be = new THREE.Euler();
const _dp = newDrillPose();

/**
 * A weapon's solids. `mods` is the fitted add-ons' look key (`lookKey` in `sim/gunmods.ts`), empty for a bare gun; each
 * different set is its own cached geometry. `lod` 'hi' is the close-up model for the first-person view, 'lo' the light one
 * for a gun in someone's hands or lying in the street (see `render/weapons`).
 */
export function weaponGeometry(kind: Exclude<Held, 'none'>, mods = '', lod: Lod = 'lo'): THREE.BufferGeometry {
  const ck = `${kind}|${mods}|${lod}`;
  const hit = weaponCache.get(ck);
  if (hit) return hit;
  const looks = parseLooks(mods);
  const wb = buildModel(kind, lod);
  if (wb) {
    if (mods) wb.raw({ c: 0xffffff, f: 0 }, (mb) => drawMods(mb, kind as GunModel, looks));
    const g = shared(wb.build());
    weaponCache.set(ck, g);
    return g;
  }
  const b = new MeshBuilder();
  b.jitter = 0.02;
  const gun = S.metal(0x232426, 0.35);
  const grip = S.plastic(0x1a1a1a, 0.3);
  const HALF = Math.PI / 2;
  const dark = S.metal(0x0a0a0a);
  const rail = S.metal(0x3a3c40, 0.4);
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
      // The bolt's handle, out to the right where the firing hand works it.
      b.rod(-0.025, 0.035, 0.1, -0.07, 0.0, 0.08, 0.005, gun, 5);
      b.sphereAt(-0.072, -0.004, 0.08, 0.01, gun);
      // The worn scope it comes with: taken off when a better optic goes on the rail.
      if (!looks.optic) {
        // Scope: an open tube, so the view goes through it behind the sights, with a fine crosshair in the front lens.
        b.lathe('scope', [[0.0165, -0.08], [0.021, -0.08], [0.021, 0.08], [0.0165, 0.08], [0.0165, -0.08]], 0, 0.1, 0.2, S.metal(0x111111, 0.3), Math.PI / 2, 0, 0, 14);
        b.box(0, 0.1, 0.275, 0.0012, 0.033, 0.001, S.metal(0x050505, 0.3));
        b.box(0, 0.1, 0.275, 0.033, 0.0012, 0.001, S.metal(0x050505, 0.3));
      }
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
      // The bolt's handle, out to the right where the firing hand works it.
      b.rod(-0.03, 0.04, 0.1, -0.075, 0.0, 0.08, 0.005, gun, 5);
      b.sphereAt(-0.077, -0.004, 0.08, 0.01, gun);
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
    case 'bow':
      drawBow(b);
      break;
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
  /** The left hand's hold: only a bow is carried in it (the bow arm is the left). */
  handL = new THREE.Group();
  /** The bow in hand, its string drawn as far as `bowDraw` says. Null for anything else. */
  private bow: BowRig | null = null;
  /** How far the string is drawn, 0 to 1, and whether an arrow is on it: set by the owner each frame. */
  bowDraw = 0;
  nocked = true;
  /** Cosmetic leisure animation, set by the owner; it never consumes stock or doses the simulation. */
  leisure: LeisurePose | null = null;
  /** The 'lie' pose laid out flat: back on the ground, legs straight, arms at the sides, the head rolled a little to one side. */
  lieFlat = false;
  private leisureRig: LeisureRig | null = null;
  /** Face expression independent of standing, walking or sitting; supported by Nuhat's portrait. */
  expression: CharacterExpression = 'neutral';
  private nuhatRig: NuhatRig | null = null;
  private ududRig: UdudRig | null = null;
  /** The flame at the muzzle of the gun in hand. */
  readonly flash = new MuzzleFlash();
  private weapon: THREE.Mesh | null = null;
  private held: Held = 'none';
  private heldMods = '';
  /** Muzzle flash size, 1 for a bare gun: a suppressor or flash hider shrinks it, a compensator or brake flares it. */
  flashK = 1;
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
  /**
   * Afloat, 0..1 (set by the owner each frame): upright and treading water when still, flat and face down in a front crawl
   * when moving. `swimDive` is how far under the surface the swimmer has gone and `swimPitch` the extra nose-down (radians)
   * of a dive that is heading down.
   */
  swim = 0;
  swimDive = 0;
  swimPitch = 0;
  private swimK = 0;
  /** Where the swimmer is in the stroke, 0..1: one arm's full cycle, the other half a cycle behind. */
  private strokeT = 0;
  /** The climb-in ends astride a bike (the 'ride' pose) rather than in a cab seat: no ducking under a roof, the near leg swings over the saddle. */
  enterRide = false;
  /** A greeting with a friend: 0 none, else 1 high five, 2 fist bump, 3 two-handed slap. `five` is its progress 0..1. */
  fiveStyle = 0;
  five = 0;
  /**
   * Afloat. Standing in the water the body is upright, the arms scull in front and the legs tread; moving, it lies face down
   * and swims a front crawl: each arm enters ahead, pulls back under the chest and comes out over the water with a high elbow,
   * the shoulders rolling into it, the legs fluttering, the head turning now and again for air. A dive points the nose down.
   */
  private swimPose(k: number, speed: number) {
    const tau = Math.PI * 2;
    const lie = clamp(this.moveK * 1.1, 0, 1);
    const dive = this.swimDive;
    const p = this.strokeT;
    const effort = clamp(speed / 3, 0.55, 1);
    const to = (cur: number, v: number) => lerp(cur, v, k);
    // The body: tall in the water treading, the hips up at the surface and horizontal in a crawl, nose down diving.
    const pitch = lerp(0.12, 1.4, lie) + this.swimPitch * lie;
    const h = this.hips;
    h.rotation.x = to(h.rotation.x, pitch);
    h.rotation.y = to(h.rotation.y, 0);
    h.rotation.z = to(h.rotation.z, 0);
    h.position.y = to(h.position.y, lerp(lerp(0.72, 1.12, lie), 0.95, dive));
    const t = this.torso;
    t.rotation.x = to(t.rotation.x, lerp(0, -0.18, lie));
    t.rotation.y = to(t.rotation.y, -Math.sin(tau * p) * 0.5 * lie * effort);
    t.rotation.z = to(t.rotation.z, 0);
    this.head.rotation.x = to(this.head.rotation.x, -(pitch - 0.18 * lie) * 0.85);
    this.head.rotation.y = to(this.head.rotation.y, Math.sin(tau * p) * 0.4 * lie * (1 - dive));
    this.head.rotation.z = to(this.head.rotation.z, 0);
    // The arms: a full turn each, the right half a cycle behind. Past the hip (q 0.5) the hand leaves the water, elbow high.
    for (const [arm, elbow, off, sx] of [
      [this.armL, this.elbowL, 0, 1],
      [this.armR, this.elbowR, 0.5, -1],
    ] as const) {
      const q = (p + off) % 1;
      const out = q > 0.5 ? Math.sin((q - 0.5) * tau) : 0;
      const pull = q <= 0.5 ? Math.sin(q * tau) : 0;
      const stroke = -Math.PI + tau * q;
      const scull = -0.75 + Math.sin(tau * (p * 2 + off)) * 0.3;
      arm.rotation.x = to(arm.rotation.x, lerp(scull, stroke, lie));
      arm.rotation.y = to(arm.rotation.y, 0);
      arm.rotation.z = to(arm.rotation.z, sx * lerp(0.5, 0.12 + 0.4 * out, lie));
      elbow.rotation.x = to(elbow.rotation.x, lerp(-1.0, -(0.25 + 1.1 * out + 0.55 * pull), lie));
    }
    this.hand.rotation.x = to(this.hand.rotation.x, 0);
    // The legs: flutter kick flat out (six beats to a stroke), an eggbeater treading.
    const kick = Math.sin(tau * 3 * p) * 0.4 * effort;
    const egg = Math.sin(tau * (p * 2)) * 0.45;
    this.legL.rotation.x = to(this.legL.rotation.x, lerp(-0.6 + egg, kick, lie));
    this.legR.rotation.x = to(this.legR.rotation.x, lerp(-0.6 - egg, -kick, lie));
    this.legL.rotation.z = to(this.legL.rotation.z, lerp(0.1, 0, lie));
    this.legR.rotation.z = to(this.legR.rotation.z, lerp(-0.1, 0, lie));
    this.kneeL.rotation.x = to(this.kneeL.rotation.x, lerp(0.95 + egg * 0.4, 0.18 + Math.max(0, -kick) * 0.6, lie));
    this.kneeR.rotation.x = to(this.kneeR.rotation.x, lerp(0.95 - egg * 0.4, 0.18 + Math.max(0, kick) * 0.6, lie));
  }

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
  /** A hero's textured face and hair, on the head. */
  private face: THREE.Mesh | null = null;
  /** The palette last dressed in, so an owner can tell whether there is anything to change. */
  worn: Palette;

  constructor(pal: Palette) {
    this.worn = pal;
    // The owner turns the root to face (y) and a lying pose tips it over (x): turn first, then tip, so a body on its back
    // lies along the way it faced instead of rolling onto its side.
    this.root.rotation.order = 'YXZ';
    const g = bodyParts(pal);
    const mk = (part: Part, parent: THREE.Object3D) => {
      const m = new THREE.Mesh(g[part], bodyMaterial(pal));
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
    this.elbowL.add(this.handL);
    this.handL.position.set(0, -0.27, 0.02);
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
    this.fit(pal);
  }

  /** Change clothes: swap every body part for the ones this palette draws. Geometry is cached per palette, so this is cheap. */
  dress(pal: Palette) {
    this.leisureRig?.hide();
    this.leisure = null;
    this.worn = pal;
    const g = bodyParts(pal);
    for (const part of Object.keys(this.partMesh) as Part[]) {
      this.partMesh[part].geometry = g[part];
      this.partMesh[part].material = bodyMaterial(pal);
    }
    this.fit(pal);
  }

  /**
   * Put another head of the same hero on for a moment (an expression: a mouth open for a bite), or the hero's own back
   * with null. Does nothing on a rig without a portrait face.
   */
  showFace(spec: PortraitSpec | null) {
    const f = this.face;
    const hero = this.worn.hero;
    if (!f || !hero) return;
    const use = spec ?? HERO_LOOKS[hero].portrait;
    const look = this.worn.look ?? DEFAULT_LOOK;
    f.geometry = portraitGeometry(use, look.head.style === 'bare' ? 'full' : 'covered');
    f.material = portraitMaterial(use);
  }

  /**
   * Put a hand on `target` in the torso's frame (x to the body's left, y up from the hips, z ahead), the elbow out toward
   * `pole`, over whatever pose the arm has by `k`. Call after `update`.
   */
  reach(side: 'L' | 'R', target: THREE.Vector3, pole: THREE.Vector3, k = 1) {
    if (side === 'L') this.reachTo(this.armL, this.elbowL, target, pole, k);
    else this.reachTo(this.armR, this.elbowR, target, pole, k);
  }

  /** A hero's face on the head, and the rig at their height and build; the stock survivor's otherwise. */
  private fit(pal: Palette) {
    this.nuhatRig?.dispose();
    this.nuhatRig = null;
    this.ududRig?.dispose();
    this.ududRig = null;
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
    if (pal.hero === 'nuhat' && this.face) {
      const look = pal.look ?? DEFAULT_LOOK;
      this.nuhatRig = new NuhatRig(this, this.face, look.head.style === 'bare' ? 'full' : 'covered');
    }
    if (pal.hero === 'udud' && this.face) this.ududRig = new UdudRig(this);
  }

  /**
   * First person: hide what the camera at the eyes sits inside. With the first-person arms drawn (`viewArms`, see
   * `ViewModel`) that is the whole survivor and what is in hand. Without them (a load in the arms, hands at work on a car,
   * a greeting) the forearms and what they hold stay, brought up and forward and turned with the view so the camera sees
   * them. Applied just before the owner's view draws and undone just after, so a partner's view still sees the whole survivor.
   */
  setFirstPerson(on: boolean, viewArms = false) {
    this.nuhatRig?.setFirstPerson(on);
    this.ududRig?.setFirstPerson(on);
    this.leisureRig?.setFirstPerson(on);
    for (const m of this.bodyMeshes) m.visible = !on;
    // The upper arms point straight at a camera at the eyes and would fill the view: the forearms come up from below the frame.
    // Swimming is the exception: the strokes pass down the sides and below the eyes, and want their whole arm.
    const swimming = this.swimK > 0.3;
    this.partMesh.upperL.visible = !on || swimming;
    this.partMesh.upperR.visible = !on || swimming;
    // Empty hands hang at the body's pitch, not the camera's, so they only read from one angle: the forearms show only when
    // they hold, carry or work on something.
    const busy = !viewArms && (!!this.weapon || !!this.carried || this.workAmt > 0 || this.five > 0 || swimming);
    this.partMesh.foreL.visible = !on || busy;
    this.partMesh.foreR.visible = !on || busy;
    this.hand.visible = !on || !viewArms;
    this.handL.visible = !on || !viewArms;
    this.placeArms(on && busy, swimming);
    if (on && busy && !swimming) {
      // The arms follow the view's pitch, turning about the shoulders, so what they hold sits in the same place on screen
      // looking up, level or down.
      const free = this.viewPitch;
      this.torso.rotation.x -= free;
      this.torso.position.set(0, 0.6 * (1 - Math.cos(free)), 0.6 * Math.sin(free));
      this.freePitch = free;
    } else if (!on) {
      this.torso.rotation.x += this.freePitch;
      this.freePitch = 0;
      this.torso.position.set(0, 0, 0);
    }
  }

  /** The view's pitch (radians, up positive), set each frame by the owner. */
  viewPitch = 0;
  private freePitch = 0;

  /** The arms are brought up and forward to where a camera at the eyes can see them. Undone for anyone else's view. */
  private placeArms(on: boolean, swimming = false) {
    const o = this.fpOffset;
    const k = on ? 1 : 0;
    // Swimming only brings the shoulders in toward the view's centre: the body is flat, so up and forward would be down and out.
    const ky = swimming ? 0 : k;
    this.armR.position.set(-0.22 + k * o.x, 0.45 + ky * o.y, ky * o.z);
    this.armL.position.set(0.22 - k * o.x, 0.45 + ky * o.y, ky * o.z);
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

  /** How far the forearms are moved for the owner's own first-person view without the first-person arms: toward the view's centre (x), up (y) and forward (z), metres. */
  fpOffset = { x: 0.12, y: 0.05, z: 0.32 };

  /** Swap the item in the right hand. Cheap to call every frame: geometry is cached per item. */
  setWeapon(kind: Held, mods = '') {
    if (kind === this.held && mods === this.heldMods) return;
    this.held = kind;
    this.heldMods = mods;
    if (this.weapon) {
      this.weapon.removeFromParent();
      this.weapon = null;
    }
    if (this.bow) {
      this.bow.group.removeFromParent();
      this.bow = null;
    }
    this.flash.setGun(null);
    this.flash.group.removeFromParent();
    if (kind === 'none') return;
    if (kind === 'bow') {
      // A bow is held in the left hand, its limbs and string a rig of their own that the draw bends.
      this.bow = new BowRig();
      this.handL.add(this.bow.group);
      this.weapon = this.bow.riser;
      return;
    }
    // The flash comes out of the muzzle of a gun, with its barrel and muzzle device counted in.
    if (GUN_MODELS.includes(kind as GunModel)) {
      const tip = muzzleAt(kind as GunModel, parseLooks(mods));
      this.flash.group.position.set(0, tip.y, tip.z + 0.02);
    } else this.flash.group.position.set(0, 0.03, 0.32);
    const m = new THREE.Mesh(weaponGeometry(kind, mods), weaponMat);
    m.castShadow = true;
    this.hand.add(m);
    this.weapon = m;
    if (this.gunHeld && flashes(kind as GunModel)) {
      this.flash.setGun(kind as GunModel);
      m.add(this.flash.group);
    }
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

  /** The muzzle flash: how much of it is left this frame, 1 at the instant of a shot, 0 for none. */
  muzzle(k: number) {
    this.flash.set(this.gunHeld && flashes(this.held as GunModel) ? k : 0);
  }

  /** What is in the right hand. */
  get heldKind(): Held {
    return this.held;
  }

  /** Whether the thing in hand is a firearm (or a bow, which is handled like one). */
  private get gunHeld() {
    return GUN_MODELS.includes(this.held as GunModel);
  }

  /**
   * A bow in the left hand. Raised (`k` 1), the bow arm reaches straight out along the aim with the bow canted a little in
   * it, and the draw hand is on the string wherever the draw has brought it, back to the jaw at full draw; reaching for the
   * next arrow (`gunPose.down`) it goes to the hip. Lowered, the bow is carried tipped forward at the side. Both arms are
   * solved onto those points and blended over the pose the body already has by `k`.
   */
  private bowPose(k: number, pitch: number) {
    const rig = this.bow!;
    rig.set(this.bowDraw, this.nocked);
    const up = clamp01((k - 0.05) / 0.5);
    if (up <= 0) {
      this.handL.rotation.set(1.2, 0, 0);
      return;
    }
    const t = this.torso;
    t.updateWorldMatrix(true, false);
    // Directions in the torso's frame: along the aim, and the bow's up, canted a little to the right.
    const q = _bq.copy(this.root.quaternion);
    const tq = t.getWorldQuaternion(_bq2).invert();
    const parentQ = this.root.parent ? this.root.parent.getWorldQuaternion(_bq3) : _bq3.identity();
    q.premultiply(parentQ).premultiply(tq);
    const aim = _bv.set(0, Math.sin(pitch), Math.cos(pitch)).applyQuaternion(q).normalize();
    const bowUp = _bv2.set(0, Math.cos(pitch), -Math.sin(pitch)).applyQuaternion(q).normalize();
    bowUp.applyAxisAngle(aim, -0.18).normalize();
    // The bow hand straight out from the middle of the chest along the aim.
    const grip = _bv3.set(0.06, 0.42, 0.05).addScaledVector(aim, 0.6);
    this.reachTo(this.armL, this.elbowL, grip, _bv4.set(0.6, -0.8, -0.2).normalize(), up);
    // The bow in that hand, pointing down the aim. The hand's frame is turned to make it so.
    const want = _bq4.setFromRotationMatrix(_bm.makeBasis(_bv5.copy(bowUp).cross(aim).normalize(), bowUp, aim));
    this.elbowL.updateWorldMatrix(true, false);
    const elbowQ = this.elbowL.getWorldQuaternion(_bq2).premultiply(t.getWorldQuaternion(_bq3).invert()).invert();
    const relaxed = _bq3.setFromEuler(_be.set(1.2, 0, 0));
    this.handL.quaternion.copy(relaxed).slerp(elbowQ.multiply(want), up);
    // The draw hand on the nock, or off to the hip for the next arrow.
    this.handL.updateWorldMatrix(true, true);
    const nock = rig.group.localToWorld(_bv5.copy(rig.nock));
    t.worldToLocal(nock);
    const down = clamp01(this.gunPose.down);
    if (down > 0) nock.lerp(_bv3.set(-0.2, -0.02, -0.06), down);
    this.reachTo(this.armR, this.elbowR, nock, _bv4.set(-0.9, 0.15, -0.5).normalize(), up);
  }

  /**
   * Bend an arm so its hand lands on `target` (in the torso's frame), the elbow toward `pole`: the shoulder turns the upper
   * arm onto the elbow and the elbow folds the forearm onto the target. Past arm's reach the arm goes straight toward it.
   * Blended over the arm's current pose by `k`.
   */
  private reachTo(arm: THREE.Group, elbow: THREE.Group, target: THREE.Vector3, pole: THREE.Vector3, k: number) {
    const U = -elbow.position.y;
    const F = 0.27;
    const s = arm.position;
    const d = _rv.copy(target).sub(s);
    let dist = d.length();
    d.divideScalar(Math.max(1e-6, dist));
    dist = clamp(dist, Math.abs(U - F) + 0.02, U + F - 0.002);
    const along = (U * U - F * F + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, U * U - along * along));
    const side = _rv2.copy(pole).addScaledVector(d, -pole.dot(d)).normalize();
    const e = _rv3.copy(s).addScaledVector(d, along).addScaledVector(side, h);
    const wrist = _rv4.copy(s).addScaledVector(d, dist);
    // The upper arm hangs down its own -y: +y runs from the elbow back up to the shoulder.
    const y = _rv5.copy(s).sub(e).normalize();
    const f = _rv6.copy(wrist).sub(e).normalize();
    const z = _rv7.copy(f).addScaledVector(y, -f.dot(y));
    if (z.lengthSq() < 1e-8) z.copy(side).negate();
    z.normalize();
    const x = _rv8.copy(y).cross(z);
    const q = _bq4.setFromRotationMatrix(_bm.makeBasis(x, y, z));
    arm.quaternion.slerp(q, k);
    // The forearm, folded about the elbow's x: (0, -cos, -sin) of the fold in the upper arm's frame.
    const fold = Math.atan2(-f.dot(z), -f.dot(y));
    elbow.rotation.set(lerp(elbow.rotation.x, fold, k), elbow.rotation.y * (1 - k), elbow.rotation.z * (1 - k));
  }

  /** Lay the way the gun is being handled over the pose: low ready, high ready, a reload, a rack. */
  private applyGunPose() {
    const gp = this.gunPose;
    this.hand.position.z = 0.02 - (this.gunHeld && !this.carried ? clamp(this.gunKick, 0, 1.6) * 0.04 : 0);
    if (!this.gunHeld || this.carried || this.bow) return;
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

  /** The drill's turn of the weapon in the hand, and the support arm leaving the gun for its work. */
  private applyDrill() {
    const d = this.drill;
    if (!d.r || d.w <= 0 || this.carried || this.held === 'none') return;
    const p = drillPose(d.r, d.t, _dp);
    const w = d.w;
    this.hand.rotation.x -= p.rx * w;
    this.hand.rotation.y += p.ry * w;
    this.hand.rotation.z += p.rz * w;
    // Brought in to the chest to work on it.
    this.elbowR.rotation.x -= Math.max(0, p.z) * 3 * w;
    const off = offGrip(d.r, p.l) * w;
    if (off > 0.001 && this.gunHeld && !this.bow) {
      // Half of the reach to the belt reads as the hand at the magazine, the slide or the port.
      this.armL.rotation.x = lerp(this.armL.rotation.x, -0.7, off * 0.5);
      this.armL.rotation.z = lerp(this.armL.rotation.z, 0.1, off * 0.5);
      this.elbowL.rotation.x = lerp(this.elbowL.rotation.x, -1.4, off * 0.5);
    }
    const offR = offGrip(d.r, p.r) * w;
    // The firing hand off to a bolt or a handle turns up off the grip.
    if (offR > 0.001) this.hand.rotation.z += offR * 0.5;
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
  /**
   * A drill of the hands on the weapon (see `sim/gunDrills`), set by the owner each frame: a re-grip at rest, or a jam being
   * cleared. `t` is how far through it, `w` how much of it shows. The owner's first-person arms play it in full; this rig,
   * what a partner sees, turns the weapon with it and lets the support arm come off the gun.
   */
  drill: { r: Drill | null; t: number; w: number } = { r: null, t: 0, w: 0 };
  /** How far the body leans into a sidestep or a turn (radians, positive to its left), set by the owner each frame. */
  lean = 0;

  update(dt: number, pose: PoseKind, speed: number, aim: number, crouch: number, lookPitch = 0, air = 0) {
    const enter = this.enter;
    if (enter > 0) speed = 2.4 * (1 - smooth(0.35, 0.55, enter));
    this.walkT += dt * (1.5 + speed * 1.1);
    this.idleT += dt;
    this.swimK = damp(this.swimK, this.swim, 9, dt);
    if (this.swimK > 0.002) this.strokeT = (this.strokeT + dt * (0.5 + speed * 0.28)) % 1;
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
    this.handL.rotation.set(0, 0, 0);
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
      // Leaning into a sidestep or a turn: the hips go over and the shoulders further.
      h.rotation.z -= this.lean * 0.5;
      this.torso.rotation.z -= this.lean * 0.9;
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
      this.applyDrill();
      if (this.bow && !this.carried) this.bowPose(aim, lookPitch);
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
      if (this.swimK > 0.002 && !this.carried) this.swimPose(this.swimK, speed);
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
    } else if (pose === 'sit') {
      // Sat on the ground: the seat of the trousers on it, knees up and a little apart, heels out in front, leaning forward
      // with the elbows on the knees and the forearms folded in front of the shins, the hands crossed at the wrists.
      const br = Math.sin(this.idleT * 1.7);
      h.position.y = 0.13;
      this.legL.rotation.set(-2.3, 0, 0.2);
      this.legR.rotation.set(-2.3, 0, -0.2);
      this.kneeL.rotation.x = 1.72;
      this.kneeR.rotation.x = 1.72;
      // Solved for the elbow on the front of the knee and the upper arm turned in, so the elbow folds the forearm across
      // toward the other hand instead of up into the air.
      this.torso.rotation.x = 0.32 + br * 0.012;
      this.armL.rotation.set(2.015, -0.9165, -2.767);
      this.armR.rotation.set(2.015, 0.9165, 2.767);
      this.elbowL.rotation.x = -0.84;
      this.elbowR.rotation.x = -0.84;
      this.head.rotation.x = -0.22;
      this.head.rotation.y = Math.sin(this.idleT * 0.43) * 0.05;
    } else if (pose === 'lie' && this.lieFlat) {
      // Laid out flat on the back: no pack under the shoulders, both legs out straight, the arms down the sides, the head
      // rolled a little to one side. Only the slow rise and fall of the chest says he is breathing.
      const br = Math.sin(this.idleT * 0.9);
      r.rotation.x = -Math.PI / 2;
      h.position.y = 0.92;
      h.position.z = 0.17;
      this.torso.rotation.x = br * 0.012;
      this.legL.rotation.set(0.04, 0, 0.07);
      this.kneeL.rotation.x = 0.05;
      this.legR.rotation.set(0.04, 0, -0.07);
      this.kneeR.rotation.x = 0.03;
      this.armL.rotation.set(0.06, 0, 0.1);
      this.armR.rotation.set(0.06, 0, -0.1);
      this.elbowL.rotation.x = -0.12;
      this.elbowR.rotation.x = -0.08;
      this.head.rotation.x = -0.08;
      this.head.rotation.y = 0.35;
    } else if (pose === 'lie') {
      // Lying on the back at rest: propped up on the pack if one is worn, one knee up with the foot flat, the other leg out
      // straight, the hands folded on the belly, the chin tucked a little to look along the body.
      const br = Math.sin(this.idleT * 1.1);
      const look = this.worn.look ?? DEFAULT_LOOK;
      const recline = this.worn.mask ? 0 : PACK_RECLINE[look.pack.style];
      r.rotation.x = -Math.PI / 2;
      h.position.y = 0.92;
      h.position.z = 0.175; // local +z is world up once the body lies on its back: the back of the ribs on the ground
      this.torso.rotation.x = recline + br * 0.01;
      this.legL.rotation.set(-0.75, 0, 0.1);
      this.kneeL.rotation.x = 1.8;
      this.legR.rotation.set(0.12, 0, -0.1);
      this.kneeR.rotation.x = 0.04;
      // Upper arms down the sides with the elbows on the ground, turned in so the bent forearms come up onto the belly.
      this.armL.rotation.set(0.305, -0.56, 0);
      this.armR.rotation.set(0.305, 0.56, 0);
      this.elbowL.rotation.x = -1.57;
      this.elbowR.rotation.x = -1.57;
      this.head.rotation.x = -0.32 + recline * 0.4;
    }
    if (this.leisure && pose === 'stand' && !this.carried && this.swimK < 0.01 && enter <= 0) {
      (this.leisureRig ??= new LeisureRig(this)).update(dt, this.leisure);
    } else this.leisureRig?.hide();
    this.nuhatRig?.update(dt, pose === 'downed' ? 'neutral' : this.expression, speed,
      (pose === 'stand' || pose === 'sit' || pose === 'seat') && speed < 0.2 && aim < 0.1 && !this.carried && !this.leisure && this.workK < 0.01 && this.swimK < 0.01 && enter <= 0);
    this.ududRig?.update(dt, pose,
      speed < 0.2 && aim < 0.1 && this.held === 'none' && !this.carried && !this.leisure && this.workK < 0.01 && this.swimK < 0.01 && enter <= 0 && this.five <= 0);
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
    const ride = this.enterRide;
    const seat = smooth(0.4, 1, k);
    // Under a roof the head ducks; astride a bike the body stays upright and the near leg swings up and over the saddle.
    const duck = ride ? 0 : Math.sin(Math.PI * clamp((k - 0.3) / 0.6, 0, 1));
    const step = Math.sin(Math.PI * clamp((k - 0.32) / 0.4, 0, 1));
    const reach = Math.sin(Math.PI * clamp(k / 0.4, 0, 1));
    const h = this.hips;
    // Seated targets: exactly what the occupant's own pose ('ride' or 'seat') holds, so the hand-over at the end does not jump.
    const hipY = ride ? 0.45 / this.root.scale.y : 0.4 / this.root.scale.y;
    const legX = ride ? -1.15 : -1.4;
    const kneeX = ride ? 1.45 : 1.5;
    const torsoX = ride ? 0.5 : 0.1;
    const armX = ride ? -0.95 : -0.75;
    const elbowX = ride ? -0.55 : -0.7;
    const armZ = ride ? 0.25 : 0.15;
    const headX = ride ? -0.45 : -0.05;
    h.position.y = lerp(h.position.y, hipY, seat) - duck * 0.07 + (ride ? step * 0.06 : 0);
    // Near leg lifts over the sill (or the saddle) while the other takes the weight.
    this.legL.rotation.x = lerp(lerp(this.legL.rotation.x, ride ? -1.5 : -1.0, step), legX, seat);
    this.kneeL.rotation.x = lerp(lerp(this.kneeL.rotation.x, ride ? 1.0 : 1.2, step), kneeX, seat);
    this.legR.rotation.x = lerp(this.legR.rotation.x, legX, seat);
    this.kneeR.rotation.x = lerp(this.kneeR.rotation.x, kneeX, seat);
    if (ride) {
      this.legL.rotation.z = lerp(this.legL.rotation.z, 0.12, seat) + step * (1 - seat) * 0.5;
      this.legR.rotation.z = lerp(this.legR.rotation.z, -0.12, seat);
    }
    this.torso.rotation.y *= 1 - seat;
    this.torso.rotation.x = lerp(this.torso.rotation.x, torsoX, seat) + duck * 0.5;
    this.head.rotation.x = lerp(this.head.rotation.x, headX, seat) - duck * 0.45;
    // The far hand reaches for the door, the grab handle or the bars, then both come to the wheel.
    this.armR.rotation.x = lerp(lerp(this.armR.rotation.x, -1.15, reach), armX, seat);
    this.elbowR.rotation.x = lerp(lerp(this.elbowR.rotation.x, -0.5, reach), elbowX, seat);
    this.armL.rotation.x = lerp(this.armL.rotation.x, armX, seat);
    this.elbowL.rotation.x = lerp(this.elbowL.rotation.x, elbowX, seat);
    this.armL.rotation.z = lerp(this.armL.rotation.z, armZ, seat);
    this.armR.rotation.z = lerp(this.armR.rotation.z, -armZ, seat);
  }

  dispose() {
    this.nuhatRig?.dispose();
    this.ududRig?.dispose();
    this.leisureRig?.dispose();
    // Geometry is shared per palette and per weapon; nothing to free per instance.
  }
}

/** A weapon or tool as its own mesh, as held in the hand, for models that lie about the world (`render/gearModels.ts`). Geometry is shared and cached. */
export function weaponMesh(kind: Exclude<Held, 'none'>, mods = '', lod: Lod = 'lo'): THREE.Mesh {
  const m = new THREE.Mesh(weaponGeometry(kind, mods, lod), weaponMat);
  m.castShadow = true;
  return m;
}

function smooth(a: number, b: number, x: number) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

export { basicLight };
