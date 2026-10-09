import * as THREE from 'three';
import { uploadPrefix } from './upload';
import { MeshBuilder, S, type ColorIn } from './builder';
import { applyKit } from './materials';
import type { ZombieKind } from '../data';
import { ZOMBIE_ACTION, ZOMBIE_VARIANTS, type ZombieMotion } from '../sim/zombieAnimation';
import { zombieAppearance } from './zombieAppearance';
import { bakedModel, type ClipInfo } from './bakedModel';
import { DISSOLVE_NOISE } from './dissolve';
import { FLESH_BEND_NRM, FLESH_BEND_POS, FLESH_PARS_V, FLESH_PRE, fleshChunk, patchFleshFragment } from './fleshShader';

export const MAX_ZOMBIES = 600;
/** A death plays a little faster than its take, and blends out of what the body was doing over its first moments. */
const DEATH_PACE = 1.15;
const DEATH_BLEND = 0.2;

/**
 * The infected: one instanced mesh for every zombie on screen. The body is built from smooth limbs with
 * per-vertex joint ids and pivots, and the vertex shader runs a two-joint walk (hips and knees, shoulders
 * and elbows) plus head loll and action poses. Stable appearance seeds vary proportions, clothes, skin
 * and hair. Resolved travel drives the gait without phase jumps; continuous torso morphs
 * and limb bulk give the heavy infected distinct silhouettes in the same draw call.
 */

/** Material slots: 0 fixed colour, 1 shirt, 2 trousers, 3 skin, 4 hair, 5 jaw skin, 6 jaw teeth. */
const SLOT = { fixed: 0, shirt: 1, pants: 2, skin: 3, hair: 4, jaw: 5, teeth: 6 } as const;
// Optional geometry is selected per instance in the same packed attribute as the joint.
const WEAR = { common: 0, collar: 1, buttonShirt: 2, sleeve: 3, hem: 4, hood: 5,
  hoodie: 6, jacket: 7, wound: 8, cuff: 9, cargo: 10, laces: 11, boot: 12,
  tornKnee: 13, trouserFold: 14, sleeveTear: 15, shortsCuff: 16, teeNeck: 17,
  bob: 18, ponytail: 19, longHair: 20 } as const;

type Pivot = [number, number, number];

interface PartSpec {
  id: number;
  pivot: Pivot;
  parent: Pivot;
}

/** Joint layout (rest pose, metres, origin at the feet, facing +Z). */
export const J = {
  hipL: [0.1, 0.94, 0] as Pivot,
  hipR: [-0.1, 0.94, 0] as Pivot,
  kneeL: [0.11, 0.52, 0.02] as Pivot,
  kneeR: [-0.11, 0.52, 0.02] as Pivot,
  shL: [0.21, 1.42, -0.01] as Pivot,
  shR: [-0.21, 1.42, -0.01] as Pivot,
  elL: [0.23, 1.14, 0.0] as Pivot,
  elR: [-0.23, 1.14, 0.0] as Pivot,
  neck: [0, 1.54, 0.03] as Pivot,
};

/** Elliptical cross-sections give the torso and skull a continuous, sculpted silhouette.
 * The seam wraps without duplicate vertices, keeping normals smooth and the horde inexpensive. */
function profileGeometry(rings: readonly (readonly [y: number, width: number, depth: number, z: number])[], sides = 16): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const [y, width, depth, z] of rings) {
    for (let i = 0; i < sides; i++) {
      const angle = i / sides * Math.PI * 2;
      positions.push(Math.sin(angle) * width, y, z + Math.cos(angle) * depth);
    }
  }
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < sides; i++) {
      const a = r * sides + i, b = r * sides + (i + 1) % sides;
      indices.push(a, b, a + sides, b, b + sides, a + sides);
    }
  }
  // Small end rings terminate in centre fans rather than leaving open necks or hems.
  for (const r of [0, rings.length - 1]) {
    const centre = positions.length / 3;
    positions.push(0, rings[r][0], rings[r][3]);
    for (let i = 0; i < sides; i++) {
      const a = r * sides + i, b = r * sides + (i + 1) % sides;
      indices.push(...(r === 0 ? [centre, b, a] : [centre, a, b]));
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** One continuous tapered limb replaces a cylinder plus two overlapping sphere meshes. */
function infectedLimb(b: MeshBuilder, a: Pivot, end: Pivot, ra: number, rb: number, surface: ColorIn) {
  const direction = new THREE.Vector3(...end).sub(new THREE.Vector3(...a));
  const length = direction.length();
  const geo = new THREE.LatheGeometry([
    new THREE.Vector2(0, -ra), new THREE.Vector2(ra * 0.72, -ra * 0.7),
    new THREE.Vector2(ra, 0), new THREE.Vector2(rb, length),
    new THREE.Vector2(rb * 0.72, length + rb * 0.7), new THREE.Vector2(0, length + rb),
  ], 8);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
  b.geo(geo, ...a, 1, 1, 1, surface, e.x, e.y, e.z);
  geo.dispose();
}

function zombieGeometry(): THREE.BufferGeometry {
  const merged = new MeshBuilder();
  const part: number[] = [];
  const pivot: number[] = [];
  const pivot2: number[] = [];
  const slot: number[] = [];
  const bulk: number[] = [];
  const add = (spec: PartSpec, fn: (b: MeshBuilder, tag: (s: number, bm: number, feature?: number) => void) => void) => {
    const b = new MeshBuilder();
    b.jitter = 0.08;
    b.seed(spec.id * 31 + 5);
    const tags: [number, number, number, number][] = [];
    const tag = (s: number, bm: number, feature: number = WEAR.common) => tags.push([b.vertexCount, s, bm, feature]);
    fn(b, tag);
    tags.push([b.vertexCount, 0, 0, 0]);
    merged.append(b);
    // Each tag marks the slot and bulk for the vertices added since the previous tag.
    let from = 0;
    for (let t = 0; t < tags.length - 1; t++) {
      const to = tags[t + 1][0];
      for (let i = from; i < to; i++) {
        part.push(spec.id);
        pivot.push(...spec.pivot);
        pivot2.push(...spec.parent);
        slot.push(tags[t][1]);
        bulk.push(tags[t][2], tags[t][3]);
      }
      from = to;
    }
  };
  const W = 0.86;
  const paletted = (s: number, shade = 1): ColorIn => ({ c: new THREE.Color(W * shade, W * shade, W * shade), r: s === SLOT.skin ? 0.65 : 0.95, m: 0, w: s === SLOT.skin ? 0.35 : 0.7 });
  const shirt = paletted(SLOT.shirt);
  const pants = paletted(SLOT.pants);
  const skin = paletted(SLOT.skin);
  const hair = paletted(SLOT.hair);
  const shirtFold = paletted(SLOT.shirt, 0.68);
  const pantsFold = paletted(SLOT.pants, 0.65);
  const wound = S.skin(0x4a0f0c);
  const bone = S.skin(0xc9bea0);
  const shoe = S.leather(0x2a2420, 0.7);
  // A narrow waist, rib cage and sloping shoulders, with clothing sitting on the anatomy.
  add({ id: 0, pivot: [0, 0, 0], parent: [0, 0, 0] }, (b, tag) => {
    tag(SLOT.pants, 0.3);
    const pelvis = profileGeometry([
      [0.85, 0.11, 0.075, 0], [0.9, 0.145, 0.1, 0],
      [0.97, 0.145, 0.095, 0], [1.04, 0.127, 0.083, -0.005],
    ]);
    b.geo(pelvis, 0, 0, 0, 1, 1, 1, pants); pelvis.dispose();
    tag(SLOT.shirt, 0.6);
    const torso = profileGeometry([
      [0.98, 0.145, 0.095, 0], [1.07, 0.12, 0.08, -0.01],
      [1.18, 0.14, 0.09, -0.02], [1.32, 0.18, 0.105, -0.02],
      [1.4, 0.195, 0.095, -0.02], [1.46, 0.145, 0.065, -0.025],
      [1.485, 0.06, 0.045, -0.015],
    ]);
    b.geo(torso, 0, 0, 0, 1, 1, 1, shirt); torso.dispose();
    // A split collar, placket and chest pocket break up the large cloth surface.
    tag(SLOT.shirt, 0, WEAR.collar);
    for (const sx of [1, -1]) b.box(sx * 0.04, 1.451, 0.045, 0.045, 0.065, 0.012, shirtFold, 0.25, 0, sx * 0.35);
    tag(SLOT.shirt, 0, WEAR.buttonShirt);
    b.box(-0.012, 1.295, 0.09, 0.015, 0.25, 0.01, shirtFold, -0.08);
    b.box(-0.1, 1.365, 0.072, 0.065, 0.066, 0.014, shirtFold, 0, -0.25, -0.06);
    for (let i = 0; i < 4; i++) b.box(-0.012, 1.39 - i * 0.06, 0.1, 0.009, 0.009, 0.008, S.plastic(0x423c32));
    tag(SLOT.shirt, 0, WEAR.teeNeck);
    b.torus(0, 1.481, -0.012, 0.053, 0.006, shirtFold, Math.PI / 2, 0, 0, 4, 12);
    tag(SLOT.shirt, 0, WEAR.hoodie);
    b.rbox(0, 1.08, 0.085, 0.15, 0.075, 0.02, 0.012, shirtFold);
    for (const sx of [1, -1]) b.rod(sx * 0.04, 1.475, 0.064, sx * 0.035, 1.325, 0.11, 0.004, S.cloth(0xa59e89), 5);
    tag(SLOT.shirt, 0, WEAR.jacket);
    for (const sx of [1, -1]) {
      b.box(sx * 0.06, 1.372, 0.09, 0.055, 0.15, 0.017, shirtFold, 0, 0, sx * 0.23);
      b.rbox(sx * 0.105, 1.19, 0.074, 0.066, 0.095, 0.023, 0.009, shirtFold, 0, sx * 0.3);
    }
    b.box(0, 1.258, 0.091, 0.014, 0.34, 0.012, S.metal(0x65645a, 0.8));
    tag(SLOT.shirt, 0.6);
    for (const sx of [1, -1]) {
      b.rod(sx * 0.055, 1.4, -0.086, sx * 0.15, 1.34, -0.105, 0.006, shirtFold, 5);
      b.rod(sx * 0.07, 1.1, 0.065, sx * 0.12, 1.045, 0.065, 0.004, shirtFold, 5);
    }
    // Ragged hem.
    tag(SLOT.shirt, 0, WEAR.hem);
    for (let i = 0; i < 7; i++) b.add('cone6', -0.13 + i * 0.043, 0.985 - (i % 3) * 0.018, 0.084 - Math.abs(i - 3) * 0.008, 0.043, 0.065, 0.012, shirt, Math.PI, 0, (i % 2 - 0.5) * 0.2);
    tag(SLOT.fixed, 0, WEAR.wound);
    // Torn open on the left: a wound with ribs.
    b.add('sphere', 0.082, 1.245, 0.072, 0.115, 0.165, 0.036, wound, 0, 0, -0.16);
    for (let i = 0; i < 4; i++) b.rod(0.038, 1.19 + i * 0.035, 0.093, 0.12, 1.2 + i * 0.035, 0.075, 0.007, bone, 6);
    for (let i = 0; i < 4; i++) b.add('sphere', 0.06 + i * 0.014, 1.15 - i * 0.036, 0.08, 0.016, 0.05, 0.008, wound);
    tag(SLOT.fixed, 0);
    const belt = profileGeometry([[0.958, 0.148, 0.099, 0], [0.98, 0.145, 0.096, 0]]);
    b.geo(belt, 0, 0, 0, 1, 1, 1, S.leather(0x302b23)); belt.dispose();
    b.box(-0.025, 0.973, 0.11, 0.035, 0.024, 0.009, S.steel(0x6c6557));
    tag(SLOT.skin, 0, 0);
    b.limb(0, 1.46, 0.0, 0, 1.58, 0.025, 0.05, 0.045, skin, 8, true);
    for (const sx of [1, -1]) b.rod(sx * 0.03, 1.48, 0.035, sx * 0.038, 1.58, 0.05, 0.008, paletted(SLOT.skin, 0.72), 5);
  });
  // Head: skull, open jaw with teeth, sunken sockets, patchy hair.
  add({ id: 9, pivot: J.neck, parent: J.neck }, (b, tag) => {
    tag(SLOT.skin, 0, 0);
    const skull = profileGeometry([
      [1.615, 0.055, 0.06, 0.005], [1.65, 0.077, 0.08, 0.012],
      [1.69, 0.093, 0.084, 0.014], [1.735, 0.098, 0.087, 0.012],
      [1.785, 0.08, 0.073, 0.006], [1.816, 0.045, 0.042, 0],
      [1.829, 0.006, 0.006, 0],
    ]);
    b.geo(skull, 0, 0, 0, 1, 1, 1, skin); skull.dispose();
    // Brow ridge, gaunt cheekbones, nose stub and a slack lower jaw.
    for (const sx of [1, -1]) {
      b.add('sphere', sx * 0.045, 1.732, 0.088, 0.075, 0.028, 0.038, skin, 0, 0, sx * 0.14);
      b.add('ico1', sx * 0.061, 1.67, 0.086, 0.056, 0.044, 0.035, skin);
      b.add('sphere', sx * 0.06, 1.642, 0.063, 0.045, 0.038, 0.026, paletted(SLOT.skin, 0.62));
    }
    b.add('sphere', 0, 1.691, 0.1, 0.028, 0.072, 0.043, skin, -0.13);
    b.add('ico1', 0, 1.665, 0.119, 0.036, 0.027, 0.03, skin);
    tag(SLOT.jaw, 0, 0);
    b.rbox(0, 1.593, 0.073, 0.11, 0.04, 0.075, 0.018, skin, 0.18, 0, -0.055);
    for (const sx of [1, -1]) b.rod(sx * 0.06, 1.638, 0.024, sx * 0.047, 1.595, 0.081, 0.015, skin, 6);
    tag(SLOT.skin, 0, 0);
    for (const sx of [1, -1]) b.add('sphere', sx * 0.097, 1.694, 0.01, 0.029, 0.05, 0.035, skin, 0, 0, sx * 0.2);
    tag(SLOT.fixed, 0, 0);
    for (const sx of [1, -1]) {
      b.add('sphere', sx * 0.045, 1.707, 0.095, 0.057, 0.035, 0.026, S.skin(0x221e1b));
      b.add('sphere', sx * 0.045, 1.707, 0.109, 0.016, 0.012, 0.01, S.skin(0xa5af96));
      b.add('sphere', sx * 0.045, 1.707, 0.114, 0.005, 0.007, 0.003, S.skin(0x424637));
      b.add('sphere', sx * 0.01, 1.66, 0.131, 0.009, 0.007, 0.004, wound);
    }
    b.rbox(0, 1.628, 0.083, 0.084, 0.053, 0.044, 0.012, S.skin(0x210b09));
    b.add('ico1', 0.079, 1.664, 0.084, 0.024, 0.061, 0.013, wound, 0, 0, -0.2);
    for (let i = 0; i < 5; i++) b.box(-0.03 + i * 0.015, 1.648, 0.111, 0.009, 0.012 - (i % 2) * 0.003, 0.008, bone);
    tag(SLOT.teeth, 0, 0);
    for (let i = 0; i < 4; i++) b.box(-0.025 + i * 0.016, 1.607, 0.11, 0.009, 0.01, 0.008, bone);
    tag(SLOT.hair, 0, 0);
    b.add('dome', 0, 1.754, 0, 0.19, 0.155, 0.174, hair, -0.1, 0.1, 0.08);
    for (const sx of [1, -1]) b.add('sphere', sx * 0.082, 1.747, -0.019, 0.029, 0.07, 0.07, hair);
    // Hair is attached to the skull joint, so it follows head loll and disappears with the head.
    const hairBack = new THREE.CylinderGeometry(0.5, 0.49, 1, 12, 3, true, Math.PI * 0.3, Math.PI * 1.4);
    tag(SLOT.hair, 0, WEAR.bob);
    b.geo(hairBack, 0, 1.693, -0.015, 0.234, 0.18, 0.225, hair);
    for (const sx of [1, -1]) b.add('sphere', sx * 0.091, 1.67, 0.005, 0.035, 0.12, 0.074, hair, 0, 0, sx * 0.1);
    tag(SLOT.hair, 0, WEAR.ponytail);
    b.add('sphere', 0, 1.76, -0.104, 0.055, 0.056, 0.062, hair);
    b.rod(0, 1.76, -0.115, 0.012, 1.7, -0.165, 0.03, hair, 8);
    b.rod(0.012, 1.7, -0.165, 0.025, 1.6, -0.175, 0.026, hair, 8);
    b.add('cone6', 0.029, 1.55, -0.164, 0.045, 0.11, 0.04, hair, Math.PI, 0, -0.12);
    tag(SLOT.hair, 0, WEAR.longHair);
    b.geo(hairBack, 0, 1.606, -0.019, 0.246, 0.348, 0.237, hair);
    for (const sx of [1, -1]) {
      b.rod(sx * 0.09, 1.725, 0.022, sx * 0.112, 1.55, 0.03, 0.022, hair, 6);
      b.add('cone6', sx * 0.115, 1.477, 0.027, 0.04, 0.16, 0.035, hair, Math.PI, 0, sx * 0.08);
    }
    hairBack.dispose();
    tag(SLOT.shirt, 0, WEAR.hood);
    // Open at the face: the hood wraps the crown and back, not a solid sphere over the eyes.
    const hood = new THREE.SphereGeometry(0.5, 12, 8, Math.PI * 0.8, Math.PI * 1.4, 0, Math.PI * 0.88);
    b.geo(hood, 0, 1.72, -0.027, 0.238, 0.3, 0.25, shirt);
    // The darker inner lining is visible through the opening.
    const inner = hood.clone();
    const n = inner.getAttribute('normal');
    for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
    const idx = inner.index!;
    for (let i = 0; i < idx.count; i += 3) { const a = idx.getX(i); idx.setX(i, idx.getX(i + 1)); idx.setX(i + 1, a); }
    b.geo(inner, 0, 1.72, -0.027, 0.234, 0.296, 0.246, shirtFold);
    hood.dispose(); inner.dispose();
  });
  // Arms: torn sleeve over a thin upper arm; forearm and clawed hand.
  for (const [idU, idF, sh, el, sx] of [[5, 7, J.shL, J.elL, 1], [6, 8, J.shR, J.elR, -1]] as const) {
    add({ id: idU, pivot: sh, parent: sh }, (b, tag) => {
      tag(SLOT.shirt, 0.9, WEAR.sleeve);
      b.limb(sh[0], sh[1] - 0.02, sh[2], sh[0] + sx * 0.008, sh[1] - 0.14, sh[2], 0.065, 0.054, shirt, 10, true);
      b.rod(sh[0] - sx * 0.042, sh[1] - 0.08, 0.025, sh[0] + sx * 0.035, sh[1] - 0.135, 0.028, 0.006, shirtFold, 5);
      tag(SLOT.shirt, 0.9, WEAR.sleeveTear);
      for (let i = 0; i < 3; i++) b.add('cone6', sh[0] + (i - 1) * 0.027, sh[1] - 0.158 - (i % 2) * 0.015, 0.035, 0.024, 0.046, 0.015, shirt, Math.PI);
      tag(SLOT.skin, 0.9, 0);
      infectedLimb(b, [...sh], [...el], 0.047, 0.035, skin);
    });
    add({ id: idF, pivot: el, parent: sh }, (b, tag) => {
      tag(SLOT.skin, 0.7, 0);
      infectedLimb(b, [...el], [el[0], el[1] - 0.24, el[2] + 0.02], 0.043, 0.026, skin);
      tag(SLOT.shirt, 0.7, WEAR.cuff);
      b.cyl(el[0], el[1] - 0.212, 0.017, 0.075, 0.029, 0.075, shirtFold, 0, 0, 0, 8);
      tag(SLOT.skin, 0.18, 0);
      b.rbox(el[0], el[1] - 0.285, el[2] + 0.025, 0.062, 0.085, 0.035, 0.015, skin);
      tag(SLOT.skin, 0.02, 0);
      // Four curled fingers and an opposed thumb, rather than a mitten with three spikes.
      for (let f = 0; f < 4; f++) {
        const x = el[0] - 0.023 + f * 0.015;
        const tip = el[1] - 0.375 + Math.abs(f - 1.5) * 0.009;
        b.rod(x, el[1] - 0.318, 0.03, x + sx * 0.004, tip, 0.04, 0.007, skin, 5);
        b.rod(x + sx * 0.004, tip, 0.04, x + sx * 0.007, tip + 0.01, 0.063, 0.0055, skin, 5);
      }
      b.rod(el[0] - sx * 0.031, el[1] - 0.27, 0.03, el[0] - sx * 0.051, el[1] - 0.304, 0.042, 0.009, skin, 5);
      b.rod(el[0] - sx * 0.051, el[1] - 0.304, 0.042, el[0] - sx * 0.044, el[1] - 0.326, 0.06, 0.007, skin, 5);
      tag(SLOT.fixed, 0, 0);
      for (let f = 0; f < 4; f++) b.box(el[0] - 0.023 + f * 0.015 + sx * 0.007, el[1] - 0.362 + Math.abs(f - 1.5) * 0.009, 0.062, 0.008, 0.014, 0.004, S.skin(0x494237), 0.35);
      tag(SLOT.fixed, 0, WEAR.wound);
      b.add('sphere', el[0] + sx * 0.012, el[1] - 0.115, 0.036, 0.024, 0.077, 0.012, wound, 0, 0, sx * 0.24);
    });
  }
  // Legs: trousers, one bare shin on some variants handled by palette, worn shoes.
  for (const [idT, idS, hip, knee] of [[1, 3, J.hipL, J.kneeL], [2, 4, J.hipR, J.kneeR]] as const) {
    add({ id: idT, pivot: hip, parent: hip }, (b, tag) => {
      tag(SLOT.pants, 0.5);
      infectedLimb(b, [...hip], [...knee], 0.078, 0.057, pants);
      b.box(hip[0], 0.842, -0.071, 0.063, 0.074, 0.009, pantsFold, -0.12);
      b.rod(hip[0] + Math.sign(hip[0]) * 0.061, 0.88, 0.018, knee[0] + Math.sign(hip[0]) * 0.052, 0.59, 0.03, 0.004, pantsFold, 5);
      tag(SLOT.pants, 0.4, WEAR.cargo);
      b.rbox(hip[0] + Math.sign(hip[0]) * 0.072, 0.72, 0.006, 0.035, 0.11, 0.085, 0.01, pantsFold);
      tag(SLOT.pants, 0.4, WEAR.shortsCuff);
      b.cyl(knee[0], 0.61, 0.015, 0.127, 0.035, 0.127, pantsFold, 0, 0, 0, 8);
    });
    add({ id: idS, pivot: knee, parent: hip }, (b, tag) => {
      tag(SLOT.pants, 0.4, 0);
      infectedLimb(b, [...knee], [knee[0], 0.12, knee[2] - 0.01], 0.058, 0.039, pants);
      tag(SLOT.pants, 0.4, WEAR.trouserFold);
      b.rod(knee[0] - 0.037, 0.22, 0.03, knee[0] + 0.03, 0.19, 0.035, 0.006, pantsFold, 5);
      b.rod(knee[0] - 0.038, 0.47, 0.057, knee[0] + 0.035, 0.454, 0.058, 0.006, pantsFold, 5);
      tag(SLOT.skin, 0.4, WEAR.tornKnee);
      b.add('sphere', knee[0], 0.51, 0.071, 0.063, 0.06, 0.024, skin);
      tag(SLOT.fixed, 0, 0);
      b.rbox(knee[0], 0.05, 0.04, 0.1, 0.1, 0.24, 0.035, shoe);
      b.box(knee[0], 0.014, 0.046, 0.104, 0.024, 0.235, S.rubber(0x181b19));
      tag(SLOT.fixed, 0, WEAR.laces);
      for (let i = 0; i < 3; i++) b.box(knee[0], 0.098 - i * 0.007, 0.026 + i * 0.023, 0.05, 0.007, 0.008, S.cloth(0x6b6351));
      tag(SLOT.fixed, 0, WEAR.boot);
      b.cyl(knee[0], 0.158, 0.012, 0.102, 0.19, 0.102, S.leather(0x332a23), 0, 0, 0, 10);
      b.box(knee[0], 0.115, 0.08, 0.026, 0.11, 0.019, S.leather(0x27221e));
    });
  }
  const g = merged.build();
  // Packed to stay under WebGL's 16 vertex attributes: joint, material, muscle bulk, clothing feature.
  const zdat: number[] = [];
  for (let i = 0; i < part.length; i++) zdat.push(part[i], slot[i], bulk[i * 2], bulk[i * 2 + 1]);
  g.setAttribute('aZ', new THREE.Float32BufferAttribute(zdat, 4));
  g.setAttribute('aPivot', new THREE.Float32BufferAttribute(pivot, 3));
  g.setAttribute('aPivot2', new THREE.Float32BufferAttribute(pivot2, 3));
  g.deleteAttribute('uv');
  return g;
}

const KIND_ID: Record<ZombieKind, number> = { walker: 0, runner: 1, screamer: 2, bloater: 3, brute: 4, stalker: 5 };

const PARS = /* glsl */ `
attribute vec4 aZ; // joint id, material slot, muscle bulk, clothing feature
attribute vec3 aPivot;
attribute vec3 aPivot2;
attribute vec4 aAnim; // phase, stride rad/s, chase 0..1, fall
attribute vec4 aKind; // kind id, variant 0..1, brightness, spare
attribute vec4 aGore; // hidden-part mask, reeling, lean, bottoms + footwear * 4 + hairstyle * 16
attribute vec4 aMotion; // locomotion blend, action id, action weight, outfit + female * 8
uniform float uTime;
uniform vec3 uShirt[8];
uniform vec3 uPants[6];
uniform vec3 uSkin[6];
vec3 zRotX( vec3 v, vec3 p, float a ) {
  vec3 d = v - p;
  float c = cos( a );
  float s = sin( a );
  return p + vec3( d.x, d.y * c - d.z * s, d.y * s + d.z * c );
}
vec3 zRotXn( vec3 n, float a ) {
  float c = cos( a );
  float s = sin( a );
  return vec3( n.x, n.y * c - n.z * s, n.y * s + n.z * c );
}
vec3 zRotZn( vec3 n, float a ) {
  float c = cos( a );
  float s = sin( a );
  return vec3( n.x * c - n.y * s, n.x * s + n.y * c, n.z );
}
float zHash( float salt ) { return fract( sin( aKind.y * 173.31 + salt * 31.17 ) * 43758.5453 ); }
bool zKeepWear( int feature, int outfit, int bottoms, int footwear ) {
  int hairstyle = int( aGore.w + 0.5 ) / 16;
  if ( feature == ${WEAR.bob} ) return hairstyle == 1 && outfit != 2;
  if ( feature == ${WEAR.ponytail} ) return hairstyle == 2 && outfit != 2;
  if ( feature == ${WEAR.longHair} ) return hairstyle == 3 && outfit != 2;
  if ( feature == ${WEAR.collar} ) return outfit == 1 || outfit == 3;
  if ( feature == ${WEAR.buttonShirt} ) return outfit == 1;
  if ( feature == ${WEAR.sleeve} ) return outfit < 4;
  if ( feature == ${WEAR.hem} ) return outfit < 2 || outfit >= 4;
  if ( feature == ${WEAR.hood} || feature == ${WEAR.hoodie} ) return outfit == 2;
  if ( feature == ${WEAR.jacket} ) return outfit == 3;
  if ( feature == ${WEAR.wound} ) return outfit != 2 && outfit != 3 && ( outfit == 5 || zHash( 21.0 + aZ.x ) > 0.7 );
  if ( feature == ${WEAR.cuff} ) return outfit == 2 || outfit == 3;
  if ( feature == ${WEAR.cargo} ) return bottoms == 2;
  if ( feature == ${WEAR.laces} ) return footwear != 2;
  if ( feature == ${WEAR.boot} ) return footwear == 2;
  if ( feature == ${WEAR.tornKnee} ) return bottoms != 1 && zHash( 25.0 + aZ.x ) > 0.45;
  if ( feature == ${WEAR.trouserFold} ) return bottoms != 1;
  if ( feature == ${WEAR.sleeveTear} ) return outfit < 2;
  if ( feature == ${WEAR.shortsCuff} ) return bottoms == 1;
  if ( feature == ${WEAR.teeNeck} ) return outfit == 0 || outfit >= 4;
  return true;
}
vec3 zRotZ( vec3 v, vec3 p, float a ) {
  vec3 d = v - p;
  float c = cos( a );
  float s = sin( a );
  return p + vec3( d.x * c - d.y * s, d.x * s + d.y * c, d.z );
}
#ifdef Z_BAKED
// Motion-library clips retargeted onto this body (zombie-anims.bin): eleven bones, three texels (a 3x4 matrix) each per
// frame line. Clip A is aAnim (first line, frames (negative: held at its end), phase, B's weight), clip B is aMotion.xyz.
uniform highp sampler2D tZAnim;
mat4 zBakedBone( int line, int bone ) {
  int x = bone * 3;
  vec4 r0 = texelFetch( tZAnim, ivec2( x, line ), 0 );
  vec4 r1 = texelFetch( tZAnim, ivec2( x + 1, line ), 0 );
  vec4 r2 = texelFetch( tZAnim, ivec2( x + 2, line ), 0 );
  return mat4( r0.x, r1.x, r2.x, 0.0, r0.y, r1.y, r2.y, 0.0, r0.z, r1.z, r2.z, 0.0, r0.w, r1.w, r2.w, 1.0 );
}
void zBakedFrames( float start, float frames, float phase, out int l0, out int l1, out float f ) {
  float n = max( abs( frames ), 1.0 );
  bool loop = frames > 0.0;
  float p = loop ? fract( phase ) * n : clamp( phase, 0.0, 1.0 ) * ( n - 1.0 );
  float i0 = floor( p );
  f = p - i0;
  float i1 = loop ? mod( i0 + 1.0, n ) : min( i0 + 1.0, n - 1.0 );
  l0 = int( start + i0 );
  l1 = int( start + i1 );
}
#endif
`;

/** Shared by colour, skeleton and depth shaders, before any shader chunks consume it. */
const WARDROBE = /* glsl */ `
int zp = int( aZ.x + 0.5 );
int zOutfit = int( aMotion.w + 0.5 ) % 8;
float zFemale = float( int( aMotion.w + 0.5 ) / 8 );
int zBottoms = int( aGore.w + 0.5 ) % 4;
int zFootwear = ( int( aGore.w + 0.5 ) % 16 ) / 4;
int zHairstyle = int( aGore.w + 0.5 ) / 16;
int zWear = int( aZ.w + 0.5 );
bool zLongSleeve = zOutfit == 2 || zOutfit == 3;
bool zSleeveCloth = zLongSleeve && int( aZ.y + 0.5 ) == 3 &&
  ( zp == 5 || zp == 6 || ( ( zp == 7 || zp == 8 ) && position.y > 0.938 ) );
bool zBareLeg = zBottoms == 1 && int( aZ.y + 0.5 ) == 2 && zp >= 1 && zp <= 4 && position.y < 0.6;
float zClothBulk = zOutfit == 2 ? 0.012 : ( zOutfit == 3 ? 0.018 : 0.0 );
`;

/** Joint angles: own rotation (x), parent rotation (y), head tilt (z), body lean (w). */
const ANGLES = /* glsl */ `
#ifdef Z_BAKED
// aAnim and aMotion carry clips here: the procedural joint angles below rest (alive, standing still, no action).
vec4 zAnimV = vec4( 0.0 );
vec4 zMotionV = vec4( 0.0, 0.0, 0.0, aMotion.w );
#else
vec4 zAnimV = aAnim;
vec4 zMotionV = aMotion;
#endif
float zt = uTime * zAnimV.y + zAnimV.x;
float zLife = 1.0 - step( 0.001, zAnimV.w );
float zMove = zMotionV.x * zLife;
float zIdle = uTime * ( 0.85 + zHash( 1.0 ) * 0.4 ) + aKind.y * 29.0;
float zKind = aKind.x;
float zRunner = step( 0.5, zKind ) * ( 1.0 - step( 1.5, zKind ) );
float zBloater = step( 2.5, zKind ) * ( 1.0 - step( 3.5, zKind ) );
float zScreamer = step( 1.5, zKind ) * ( 1.0 - step( 2.5, zKind ) );
float zBrute = step( 3.5, zKind ) * ( 1.0 - step( 4.5, zKind ) );
float zStalker = step( 4.5, zKind );
float zAct = zMotionV.y;
float zWeight = zMotionV.z * zLife;
float zGrab = ( 1.0 - step( 0.5, abs( zAct - 1.0 ) ) ) * zWeight;
float zFeed = ( 1.0 - step( 0.5, abs( zAct - 2.0 ) ) ) * zWeight;
float zScream = ( 1.0 - step( 0.5, abs( zAct - 3.0 ) ) ) * zWeight;
float zWind = ( 1.0 - step( 0.5, abs( zAct - 4.0 ) ) ) * zWeight;
float zBurst = ( 1.0 - step( 0.5, abs( zAct - 5.0 ) ) ) * zWeight;
float zSmash = ( 1.0 - step( 0.5, abs( zAct - 6.0 ) ) ) * zLife;
// A planted heavy step, a sprint, or an uneven dragging shuffle.
float zLimp = ( 0.08 + zHash( 2.0 ) * 0.25 ) * ( 1.0 - zRunner ) * ( 1.0 - zStalker );
float zs = sin( zt );
float zr = sin( zt + 3.14159 + zLimp );
float zc2 = zAnimV.z;
float zCrouch = zStalker * 0.35 + zWind * 0.12 + zFeed * 0.15;
float zAmp = ( 0.40 + zRunner * 0.45 + zStalker * 0.2 - zBloater * 0.16 + zBurst * 0.15 ) * zMove;
float zOwn = 0.0;
float zPar = 0.0;
float zThighL = zs * zAmp - zCrouch;
float zThighR = zr * zAmp * ( 1.0 - zLimp ) - zCrouch;
float zReach = max( zGrab, zBurst * ( 1.0 - zBrute ) );
float zArmBase = -0.18 - zc2 * 0.65 - zReach * 0.65 - zScream * 1.6 + zWind * 0.55 + aGore.y * 1.5;
float zSwing = ( 0.22 + zRunner * 0.6 - zBloater * 0.12 ) * zMove * ( 1.0 - zGrab ) * ( 1.0 - zScream );
float zClaw = sin( zIdle * 5.0 ) * zGrab * 0.13;
float zSmashArm = zSmash * ( -2.1 * smoothstep( 0.25, 0.8, zWeight ) + 0.3 * ( 1.0 - smoothstep( 0.0, 0.25, zWeight ) ) );
float zArmL = zArmBase - zs * zSwing + zClaw + zSmashArm;
float zArmR = zArmBase - zr * zSwing - zClaw + zSmashArm + ( zHash( 3.0 ) - 0.5 ) * 0.22;
float zHead = 0.20 + sin( zIdle * 0.7 ) * 0.1 * zLife - zc2 * 0.15 + zFeed * ( 0.55 + sin( zIdle * 6.0 ) * 0.1 ) - zScream * 0.65;
if ( zp == 1 ) zOwn = zThighL;
else if ( zp == 2 ) zOwn = zThighR;
else if ( zp == 3 ) { zOwn = max( 0.0, -zs ) * zMove * ( 0.7 + zRunner * 0.5 ) + 0.08 + zCrouch * 1.6; zPar = zThighL; }
else if ( zp == 4 ) { zOwn = max( 0.0, -zr ) * zMove * ( 0.7 + zRunner * 0.5 ) + 0.08 + zCrouch * 1.6; zPar = zThighR; }
else if ( zp == 5 ) zOwn = zArmL;
else if ( zp == 6 ) zOwn = zArmR;
else if ( zp == 7 ) { zOwn = -0.25 - zRunner * zMove * 0.7 - zFeed * 0.8 + sin( zIdle * 1.3 ) * 0.08 * zLife; zPar = zArmL; }
else if ( zp == 8 ) { zOwn = -0.3 - zRunner * zMove * 0.7 - zFeed * 0.8 + cos( zIdle * 1.1 ) * 0.08 * zLife; zPar = zArmR; }
else if ( zp == 9 ) zOwn = zHead;
float zTilt = zp == 9 ? ( ( zHash( 4.0 ) - 0.5 ) * 0.35 + sin( zIdle * 0.37 ) * 0.12 * zLife ) * ( 1.0 - zScream ) : 0.0;
float zLean = 0.12 + zHash( 5.0 ) * 0.14 + zc2 * ( 0.20 + zRunner * 0.14 ) + zCrouch * 0.5 + zBurst * 0.15 - zScream * 0.16;
float zRoll = ( sin( zt ) * ( 0.025 + zBloater * 0.06 + zLimp * 0.08 ) * zMove + sin( zIdle * 0.6 ) * 0.012 * zLife );
float zWidth = 0.90 + zHash( 6.0 ) * 0.2 + zBrute * 0.08 - zStalker * 0.1 - zRunner * 0.04;
float zDepth = 0.9 + zHash( 7.0 ) * 0.2;
float zHeadSize = 0.94 + zHash( 8.0 ) * 0.12 + zBrute * 0.1 - zFemale * 0.025;
float zFaceWidth = zp == 9 ? 1.0 - zFemale * 0.1 * ( 1.0 - smoothstep( 1.62, 1.79, position.y ) ) : 1.0;
float zJaw = ( aZ.y > 4.5 && zp == 9 ) ? ( 0.04 + zScreamer * 0.2 + zGrab * ( 0.15 + sin( zIdle * 7.0 ) * 0.12 ) + zFeed * ( 0.12 + sin( zIdle * 8.0 ) * 0.1 ) + zScream * 0.5 ) * zLife : 0.0;
// Deform the whole torso cross-section, including its collar, wounds and ribs.
// Swelling each primitive along its own normal used to bury details and split the body.
float zBellyY = ( position.y - 1.12 ) / 0.23;
float zBelly = exp( -zBellyY * zBellyY );
float zChest = smoothstep( 1.04, 1.4, position.y ) * ( 1.0 - smoothstep( 1.44, 1.55, position.y ) );
float zTorsoX = zp == 0 ? 1.0 + zBloater * zBelly * 1.45 + zBrute * zChest * 0.48 - zStalker * zChest * 0.12 : 1.0;
float zTorsoZ = zp == 0 ? 1.0 + zBloater * zBelly * 2.0 + zBrute * zChest * 0.4 : 1.0;
// Female bodies have a different pelvis, waist, shoulder line and chest profile.
// Morph the clothing and wounds with the anatomy, rather than adding separate body primitives.
float zHipY = ( position.y - 0.96 ) / 0.12;
float zWaistY = ( position.y - 1.11 ) / 0.105;
if ( zp == 0 ) {
  zTorsoX *= 1.0 + zFemale * ( 0.18 * exp( -zHipY * zHipY ) - 0.1 * exp( -zWaistY * zWaistY ) - 0.14 * zChest );
  zTorsoZ *= 1.0 + zFemale * zChest * 0.11;
}
float zShoulderOffset = ( zBrute * 0.065 + zBloater * 0.035 ) * sign( position.x );

#ifdef Z_BAKED
// The bone this vertex rides: its part's, with the torso blending pelvis to chest up the spine and chest to head at the neck.
mat4 zSkin;
{
  int a0; int a1; float af;
  zBakedFrames( aAnim.x, aAnim.y, aAnim.z, a0, a1, af );
  float wb = aAnim.w;
  int b0 = 0; int b1 = 0; float bf = 0.0;
  if ( wb > 0.001 ) zBakedFrames( aMotion.x, aMotion.y, aMotion.z, b0, b1, bf );
  int bones[ 3 ];
  float ws[ 3 ];
  bones[ 0 ] = zp == 0 ? 0 : zp == 1 ? 3 : zp == 2 ? 5 : zp == 3 ? 4 : zp == 4 ? 6 : zp == 5 ? 7 : zp == 6 ? 9 : zp == 7 ? 8 : zp == 8 ? 10 : 2;
  bones[ 1 ] = 1; bones[ 2 ] = 2;
  ws[ 0 ] = 1.0; ws[ 1 ] = 0.0; ws[ 2 ] = 0.0;
  if ( zp == 0 ) {
    float wc = smoothstep( 1.02, 1.28, position.y );
    float wh = smoothstep( 1.5, 1.6, position.y );
    ws[ 0 ] = 1.0 - wc; ws[ 1 ] = wc * ( 1.0 - wh ); ws[ 2 ] = wc * wh;
  }
  zSkin = mat4( 0.0 );
  for ( int k = 0; k < 3; k++ ) {
    if ( ws[ k ] < 0.001 ) continue;
    mat4 m = zBakedBone( a0, bones[ k ] ) * ( 1.0 - af ) + zBakedBone( a1, bones[ k ] ) * af;
    if ( wb > 0.001 ) m = m * ( 1.0 - wb ) + ( zBakedBone( b0, bones[ k ] ) * ( 1.0 - bf ) + zBakedBone( b1, bones[ k ] ) * bf ) * wb;
    zSkin += m * ws[ k ];
  }
}
#endif
`;

const NORMAL = /* glsl */ `
${ANGLES}
#define Z_ANGLES
vec3 objectNormal = vec3( normal );
objectNormal.x /= zTorsoX;
objectNormal.x /= zFaceWidth;
objectNormal.z /= zTorsoZ;
objectNormal = zRotXn( objectNormal, zJaw );
objectNormal = zRotZn( objectNormal, zTilt );
#ifdef Z_BAKED
objectNormal = normalize( mat3( zSkin ) * objectNormal );
objectNormal.y -= objectNormal.z * ( aGore.z - aGore.y * 0.9 ) * smoothstep( 0.9, 1.5, position.y );
#else
objectNormal = zRotXn( objectNormal, zOwn );
if ( zp == 3 || zp == 4 || zp == 7 || zp == 8 ) objectNormal = zRotXn( objectNormal, zPar );
// Approximate the inverse transpose of the upper-body hunch shear.
objectNormal.y -= objectNormal.z * ( zLean + aGore.z - aGore.y * 0.9 ) * smoothstep( 0.9, 1.5, position.y );
objectNormal = zRotZn( objectNormal, zRoll );
#endif
objectNormal.x /= zWidth;
objectNormal.z /= zDepth;
#ifdef USE_TANGENT
  vec3 objectTangent = vec3( tangent.xyz );
#endif
`;

const BEGIN = /* glsl */ `
#ifndef Z_ANGLES
${ANGLES}
#endif
vec3 transformed = vec3( position );
vec3 zPivot = aPivot;
vec3 zParent = aPivot2;
// Long sleeves and outerwear have volume; bare arms and shorts retain the underlying anatomy.
if ( zWear == 0 && ( int( aZ.y + 0.5 ) == 1 || zSleeveCloth ) ) transformed += normal * zClothBulk;
if ( zBareLeg ) transformed -= normal * 0.008;
// Parts a heavy round has taken off: a limb keeps a short stump at its joint, capped flat, and the rest folds away.
// Integer bit tests avoid exp2/division rounding hiding neighbouring intact joints.
bool zHidden = ( int( aGore.x + 0.5 ) & ( 1 << zp ) ) != 0;
if ( zHidden ) {
  bool zHasStump = zp == 1 || zp == 2 || zp == 5 || zp == 6;
  float zAlong = aPivot.y - position.y;
  if ( zHasStump && zAlong < 0.07 ) {
    transformed = position;
  } else if ( zHasStump ) {
    transformed = vec3( position.x, aPivot.y - 0.07, position.z );
  } else {
    transformed = aPivot;
  }
}
// Brutes bulk up through the limbs. The continuous torso morph keeps clothes and wounds attached.
float zMus = zKind > 3.5 && zKind < 4.5 ? 0.055 : 0.0;
if ( zp != 0 && !zHidden ) transformed += normal * aZ.z * zMus;
transformed.x *= zTorsoX;
transformed.z = -0.015 + ( transformed.z + 0.015 ) * zTorsoZ;
if ( zp == 0 ) {
  float zChestY = ( position.y - 1.345 ) / 0.075;
  float zChestX = ( abs( position.x ) - 0.067 ) / 0.065;
  transformed.z += zFemale * 0.028 * exp( -zChestY * zChestY - zChestX * zChestX ) * smoothstep( -0.01, 0.06, position.z );
}
// Move the joints with the body shape, keeping sleeves, limbs and the hip sockets connected.
if ( zp >= 1 && zp <= 4 ) {
  transformed.x += sign( transformed.x ) * zFemale * mix( 0.005, 0.013, smoothstep( 0.52, 0.94, transformed.y ) );
  zPivot.x += sign( zPivot.x ) * zFemale * mix( 0.005, 0.013, smoothstep( 0.52, 0.94, zPivot.y ) );
  zParent.x += sign( zParent.x ) * zFemale * mix( 0.005, 0.013, smoothstep( 0.52, 0.94, zParent.y ) );
}
if ( zp >= 5 && zp <= 8 ) {
  transformed.x -= sign( transformed.x ) * zFemale * 0.025;
  zPivot.x -= sign( zPivot.x ) * zFemale * 0.025;
  zParent.x -= sign( zParent.x ) * zFemale * 0.025;
}
// Hair silhouettes: bald, cropped and patchy, with different skull proportions.
if ( zp == 9 ) {
  if ( int( aZ.y + 0.5 ) == 4 ) {
    float zHairSize = zOutfit == 2 ? 0.0 : 1.0;
    if ( zHairstyle == 0 ) zHairSize = zHash( 9.0 ) < 0.28 || zOutfit == 2 ? 0.0 : 0.65 + zHash( 10.0 ) * 0.4;
    transformed = vec3( 0.0, 1.77, -0.005 ) + ( transformed - vec3( 0.0, 1.77, -0.005 ) ) * zHairSize;
  }
  transformed = zRotX( transformed, vec3( 0.0, 1.635, 0.025 ), zJaw );
  transformed.x *= zFaceWidth;
  transformed = aPivot + ( transformed - aPivot ) * zHeadSize;
  transformed = zRotZ( transformed, aPivot, zTilt );
}
#ifdef Z_BAKED
if ( zp >= 5 && zp <= 8 ) transformed.x += zShoulderOffset;
// Clothing this look does not wear folds to its joint before the body moves, so it rides along hidden.
if ( !zKeepWear( zWear, zOutfit, zBottoms, zFootwear ) ) transformed = aPivot;
transformed = ( zSkin * vec4( transformed, 1.0 ) ).xyz;
{
  // The game's own lean (a legless body dragging itself) and a hit's reel ride on top of the clip.
  float zl = smoothstep( 0.9, 1.5, transformed.y );
  transformed.z += aGore.z * zl * ( transformed.y - 0.9 );
  transformed.z -= aGore.y * 0.9 * zl * ( transformed.y - 0.9 );
}
transformed.x *= zWidth;
transformed.z *= zDepth;
#else
transformed = zRotX( transformed, zPivot, zOwn );
if ( zp == 3 || zp == 4 || zp == 7 || zp == 8 ) transformed = zRotX( transformed, zParent, zPar );
if ( zp >= 5 && zp <= 8 ) transformed.x += zShoulderOffset;
// Whole-body hunch about the hips, a crouch for stalkers and a drunken sway.
float zl = smoothstep( 0.9, 1.5, transformed.y );
transformed.z += ( zLean + aGore.z ) * zl * ( transformed.y - 0.9 );
// Reeling from a hit: the chest arches back and the head snaps up.
transformed.z -= aGore.y * 0.9 * zl * ( transformed.y - 0.9 );
transformed.y -= zCrouch * 0.18 * smoothstep( 0.3, 0.95, transformed.y );
transformed = zRotZ( transformed, vec3( 0.0, 0.94, 0.0 ), zRoll );
// Small weight transfers, breathing and heavy belly heave; feet stay on the ground at rest.
transformed.y += sin( zIdle * 1.6 ) * 0.008 * zl * zLife;
transformed.y += ( 1.0 - cos( zt * 2.0 ) ) * 0.012 * zMove;
transformed.x *= zWidth;
transformed.z *= zDepth;
// Each optional piece collapses to a point, so hidden clothing casts no shadow either.
if ( !zKeepWear( zWear, zOutfit, zBottoms, zFootwear ) ) transformed = aPivot;
#endif
`;

const COLOR = /* glsl */ `
#include <color_vertex>
{
  int zs8 = int( floor( zHash( 11.0 ) * 8.0 ) );
  int zp6 = int( floor( zHash( 12.0 ) * 6.0 ) );
  int zk6 = int( aKind.x + 0.5 );
  vec3 zSkin = uSkin[ zk6 ] * ( 0.82 + zHash( 13.0 ) * 0.35 );
  vec3 zHair = mix( vec3( 0.035, 0.028, 0.024 ), vec3( 0.28, 0.25, 0.21 ), zHash( 14.0 ) );
  int zSlot = int( aZ.y + 0.5 );
  vec3 zCloth = uShirt[ zs8 ];
  if ( zOutfit == 3 ) zCloth = mix( zCloth, vec3( 0.10, 0.075, 0.045 ), 0.5 );
  vec3 zTrouser = uPants[ zp6 ];
  if ( zBottoms == 0 ) zTrouser = mix( zTrouser, vec3( 0.045, 0.085, 0.15 ), 0.75 );
  if ( zBottoms == 2 ) zTrouser = mix( zTrouser, vec3( 0.13, 0.14, 0.075 ), 0.65 );
  vColor.rgb *= aKind.z;
  if ( zSlot == 1 || zSleeveCloth ) vColor.rgb *= zCloth;
  else if ( zSlot == 2 ) vColor.rgb *= zTrouser;
  else if ( zSlot == 3 || zSlot == 5 ) vColor.rgb *= zSkin;
  else if ( zSlot == 4 ) vColor.rgb *= zHair;
  // Only some tees are striped. Collared shirts, hoodies and jackets have their own construction.
  if ( zSlot == 1 && zOutfit == 0 && zHash( 15.0 ) > 0.5 ) {
    float stripe = step( 0.55, fract( position.y * 18.0 ) );
    vColor.rgb *= mix( 0.70, 1.08, stripe );
  }
  bool zBareShoulder = zSlot == 1 && zp == 0 && zOutfit >= 4 && position.y > 1.37 &&
    ( abs( position.x ) > 0.115 || ( position.z > 0.0 && abs( position.x ) < 0.045 && position.y > 1.415 ) );
  bool zRagGap = zSlot == 1 && zp == 0 && zOutfit == 5 &&
    position.y < 1.36 && sin( position.y * 31.0 + position.x * 22.0 ) > 0.25;
  if ( zBareLeg || zBareShoulder || zRagGap ) vColor.rgb = zSkin * aKind.z * 0.86;
  if ( ( zSlot == 3 && !zSleeveCloth ) || zBareLeg || zBareShoulder || zRagGap ) {
    float mottled = sin( position.y * 37.0 + aKind.y * 40.0 ) * sin( position.x * 53.0 + position.z * 41.0 );
    vColor.rgb = mix( vColor.rgb, vec3( 0.16, 0.045, 0.025 ), smoothstep( 0.4, 0.85, mottled ) * 0.5 );
  }
  // The bloater's shirt has ridden above its distended abdomen; the neck of a screamer is bruised.
  if ( zSlot == 1 && zk6 == 3 && aZ.x < 0.5 && position.y < 1.22 ) {
    float zHem = smoothstep( 1.19, 1.23, position.y + sin( position.x * 55.0 ) * 0.015 );
    vColor.rgb = mix( zSkin * aKind.z * 0.78, vColor.rgb, zHem );
  }
  if ( zSlot == 3 && zk6 == 2 && aZ.x < 0.5 ) vColor.rgb *= vec3( 0.8, 0.55, 0.65 );
  if ( zSlot == 0 && zp >= 3 && zp <= 4 && zWear == 0 && position.y < 0.105 && zFootwear == 1 )
    vColor.rgb = mix( vColor.rgb, vec3( 0.18, 0.20, 0.17 ) * aKind.z, 0.65 );
  // Raw flesh where something has been torn off: the cut end of a limb, and the neck once the head is gone.
  int zpc = int( aZ.x + 0.5 );
  bool zHid = ( int( aGore.x + 0.5 ) & ( 1 << zpc ) ) != 0;
  bool zCut = zHid && ( zpc == 1 || zpc == 2 || zpc == 5 || zpc == 6 ) && ( aPivot.y - position.y ) > 0.0;
  bool zNeck = zpc == 0 && position.y > 1.505 && ( int( aGore.x + 0.5 ) & 512 ) != 0;
  if ( zCut || zNeck ) vColor.rgb = vec3( 0.34, 0.02, 0.02 );
}
`;

/** Phantoms are drawn with the same body, as translucent shimmering ghosts. These carry the per-instance fade and colour seed. */
const GHOST_VERT_PARS = /* glsl */ `
varying float vGhost;
varying float vGhostSeed;
`;
const GHOST_VERT_MAIN = /* glsl */ `
vGhost = aKind.w;
vGhostSeed = aKind.y;
`;
const GHOST_FRAG_PARS = /* glsl */ `
varying float vGhost;
varying float vGhostSeed;
uniform float uTime;
uniform float uGhostTint;
`;
/** After the lit colour is made: swap a share of it for a drifting rainbow and apply the fade. */
const GHOST_FRAG = /* glsl */ `
#include <opaque_fragment>
{
  vec3 rainbow = 0.5 + 0.5 * cos( 6.2831 * ( vec3( 0.0, 0.33, 0.67 ) + uTime * 0.2 + vGhostSeed ) );
  float rim = 0.35 + 0.65 * pow( 1.0 - abs( dot( normalize( vNormal ), normalize( vViewPosition ) ) ), 1.5 );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, rainbow * ( 0.5 + rim ) + gl_FragColor.rgb * 0.25, 0.65 * uGhostTint );
  gl_FragColor.a *= vGhost * mix( 0.55, 1.0, rim );
}
`;

function patchVertex(shader: THREE.WebGLProgramParametersWithUniforms, uniforms: Record<string, THREE.IUniform>, ghost = false) {
  Object.assign(shader.uniforms, uniforms);
  // A wounded body (`fleshShader.ts`) reads its cuts and breaks first, and the chunks below read what is left of it.
  const flesh = !!uniforms.tFlesh;
  const f = (glsl: string) => (flesh ? fleshChunk(glsl) : glsl);
  let normal = f(NORMAL);
  let begin = f(BEGIN);
  if (flesh) {
    normal = normal.replace('objectNormal = normalize( mat3( zSkin ) * objectNormal );', `if ( !zfPiece ) objectNormal = normalize( mat3( zSkin ) * objectNormal );\n${FLESH_BEND_NRM}`);
    begin = begin.replace('transformed = ( zSkin * vec4( transformed, 1.0 ) ).xyz;', `if ( !zfPiece ) transformed = ( zSkin * vec4( transformed, 1.0 ) ).xyz;\n${FLESH_BEND_POS}`);
  }
  shader.vertexShader = (uniforms.tZAnim ? '#define Z_BAKED\n' : '') + shader.vertexShader
    .replace('#include <common>', `#include <common>\n${PARS}${flesh ? FLESH_PARS_V : ''}${ghost ? GHOST_VERT_PARS : ''}`)
    .replace('void main() {', `void main() {\n${flesh ? FLESH_PRE : ''}${f(WARDROBE)}`)
    .replace('#include <beginnormal_vertex>', normal)
    .replace('#include <begin_vertex>', begin + (ghost ? GHOST_VERT_MAIN : ''));
  if (shader.vertexShader.includes('#include <color_vertex>')) shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>', f(COLOR));
}

const linear = (hex: number) => new THREE.Color(hex);

export interface ZombieRendererOpts {
  /** Draw as translucent shimmering phantoms: no shadows, per-instance fade, drifting colour. */
  ghost?: boolean;
  /** Most instances at once. */
  max?: number;
  /** Keep the procedural walk even when the motion library is loaded. */
  procedural?: boolean;
  /** Draw wounded bodies: cuts, breaks and wounds read per instance from `tFlesh` (see `FleshRenderer`). Both sides are drawn. */
  flesh?: boolean;
}

export class ZombieRenderer {
  mesh: THREE.InstancedMesh;
  protected max: number;
  protected anim: Float32Array;
  protected kind: Float32Array;
  protected animAttr: THREE.InstancedBufferAttribute;
  protected kindAttr: THREE.InstancedBufferAttribute;
  protected gore: Float32Array;
  protected goreAttr: THREE.InstancedBufferAttribute;
  protected motion: Float32Array;
  protected motionAttr: THREE.InstancedBufferAttribute;
  protected uniforms: Record<string, THREE.IUniform> = {
    uTime: { value: 0 },
    uShirt: { value: [0x5a5446, 0x3e4a58, 0x6a3a32, 0x7a7262, 0x2e3a2c, 0x8a8478, 0x4a3a52, 0x9a8a5a].map(linear) },
    uPants: { value: [0x2e3036, 0x3a3a2e, 0x4a4238, 0x252830, 0x5a5040, 0x30343a].map(linear) },
    // Per kind: walker, runner, screamer, bloater, brute, stalker.
    uSkin: { value: [0x6f7660, 0x7a7660, 0x8e889a, 0x87904e, 0x7a5a4c, 0x5c6670].map(linear) },
  };
  /** The motion library's clips by role, when it drives the bodies (see `pushBaked`). */
  protected clips: Record<string, ClipInfo> | null = null;
  /** Every take of each move (`walk`, `walk.1` ...): a body keeps its own, chosen by its looks. */
  private takes: Record<string, ClipInfo[]> = {};
  /** The deaths by the way they go down. */
  private deaths: { back: ClipInfo[]; front: ClipInfo[] } = { back: [], front: [] };
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  count = 0;

  constructor(opts: ZombieRendererOpts = {}) {
    const ghost = !!opts.ghost;
    this.max = opts.max ?? MAX_ZOMBIES;
    this.anim = new Float32Array(this.max * 4);
    this.kind = new Float32Array(this.max * 4);
    this.gore = new Float32Array(this.max * 4);
    this.motion = new Float32Array(this.max * 4);
    this.uniforms.uGhostTint = { value: 1 };
    const flesh = !!opts.flesh;
    if (flesh) {
      this.uniforms.tFlesh = { value: null };
      this.uniforms.uFleshTime = { value: 0 };
    }
    // Moves from the motion library, when its bank is loaded (`zombie-anims.bin`); the procedural walk otherwise.
    const bank = opts.procedural ? null : bakedModel('zombie-anims');
    if (bank) {
      this.clips = bank.data.clips;
      this.uniforms.tZAnim = { value: bank.anim };
      for (const [name, c] of Object.entries(bank.data.clips)) (this.takes[name.split('.')[0]] ??= []).push(c);
      // Which way each death goes down: its head ends behind the hips (on its back) or ahead of them (on its face).
      const d = bank.data;
      const rowZ = (line: number, bone: number, j: readonly number[]) => {
        const o = (line * d.bones * 3 + bone * 3 + 2) * 4;
        const h = (k: number) => THREE.DataUtils.fromHalfFloat(d.anim[o + k]);
        return h(0) * j[0] + h(1) * j[1] + h(2) * j[2] + h(3);
      };
      for (const c of this.takes.death ?? []) {
        const last = c.start + c.frames - 1;
        (rowZ(last, 2, J.neck) < rowZ(last, 0, [0, 0.94, 0]) ? this.deaths.back : this.deaths.front).push(c);
      }
    }
    const geo = zombieGeometry();
    this.animAttr = new THREE.InstancedBufferAttribute(this.anim, 4);
    this.animAttr.setUsage(THREE.DynamicDrawUsage);
    this.kindAttr = new THREE.InstancedBufferAttribute(this.kind, 4);
    this.kindAttr.setUsage(THREE.DynamicDrawUsage);
    this.goreAttr = new THREE.InstancedBufferAttribute(this.gore, 4);
    this.goreAttr.setUsage(THREE.DynamicDrawUsage);
    this.motionAttr = new THREE.InstancedBufferAttribute(this.motion, 4);
    this.motionAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aMotion', this.motionAttr);
    geo.setAttribute('aGore', this.goreAttr);
    geo.setAttribute('aAnim', this.animAttr);
    geo.setAttribute('aKind', this.kindAttr);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    if (ghost) {
      mat.transparent = true;
      mat.depthWrite = false;
    }
    // Through a hole in the skin the inside of the body shows, so a wounded body draws both sides.
    if (flesh) mat.side = THREE.DoubleSide;
    mat.onBeforeCompile = (shader) => {
      patchVertex(shader, this.uniforms, ghost);
      if (flesh) patchFleshFragment(shader);
      applyKit(shader, false);
      shader.vertexShader = shader.vertexShader.replace('vSurf = surf;',
        'vSurf = surf;\nif ( zSleeveCloth ) { vSurf.x = 0.95; vSurf.z = 0.7; }');
      if (ghost) {
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${GHOST_FRAG_PARS}`).replace('#include <opaque_fragment>', GHOST_FRAG);
      } else {
        // A body that has just come into sight dissolves in (`push`'s alpha, see dissolve.ts) rather than popping.
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying float vZFade;')
          .replace('vSurf = surf;', 'vSurf = surf;\nvZFade = aKind.w;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\nvarying float vZFade;\n${DISSOLVE_NOISE}`)
          .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif ( vZFade < 1.0 && inDissolveNoise() >= vZFade ) discard;');
      }
    };
    mat.customProgramCacheKey = () => (ghost ? 'zombieGhost' : 'zombie') + (flesh ? 'Flesh' : '') + (bank ? 'Baked' : '');
    this.mesh = new THREE.InstancedMesh(geo, mat, this.max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (ghost) {
      // Nothing casts a shadow for a thing that is not there.
      this.mesh.castShadow = false;
      this.mesh.receiveShadow = false;
      this.mesh.renderOrder = 4;
    } else {
      // Shadows use the same skeleton animation.
      const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
      depth.onBeforeCompile = (shader) => patchVertex(shader, this.uniforms);
      depth.customProgramCacheKey = () => (flesh ? 'zombieDepthFlesh' : 'zombieDepth') + (bank ? 'Baked' : '');
      this.mesh.customDepthMaterial = depth;
      this.mesh.castShadow = true;
      this.mesh.receiveShadow = true;
    }
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  begin() {
    this.count = 0;
  }

  /**
   * Add one instance. `fall` runs 0..1 for the death animation (topples backwards and sinks). `alpha` is a phantom's fade,
   * and for a real body how far it has dissolved into sight.
   */
  push(kind: ZombieKind, scale: number, x: number, y: number, z: number, yaw: number, phase: number, stride: number, chase: number, fall: number, variant: number, alpha = 1, goneMask = 0, reel = 0, lean = 0, motion?: ZombieMotion) {
    if (this.count >= this.max) return;
    const i = this.count++;
    // A death clip lies the body down itself, on the ground the whole way: no topple, no lift to keep a toppled body off
    // the ground, only the slope it lies on.
    this.p.set(x, y - (this.clips && fall > 0 ? 0.1 : 0), z);
    this.e.set(this.clips ? (motion?.pitch ?? 0) : -fall * (Math.PI / 2) * 0.95, yaw, this.clips ? (motion?.roll ?? 0) : 0, 'YXZ');
    this.q.setFromEuler(this.e);
    this.s.set(scale, scale, scale);
    this.m.compose(this.p, this.q, this.s);
    this.mesh.setMatrixAt(i, this.m);
    this.anim[i * 4] = phase;
    this.anim[i * 4 + 1] = stride;
    this.anim[i * 4 + 2] = chase;
    this.anim[i * 4 + 3] = fall;
    this.kind[i * 4] = KIND_ID[kind];
    const { look, outfit, bottoms, footwear, female, hairstyle } = zombieAppearance(variant);
    this.kind[i * 4 + 1] = (look + 0.5) / ZOMBIE_VARIANTS;
    this.kind[i * 4 + 2] = 0.87 + (look % 6) * 0.025;
    this.kind[i * 4 + 3] = alpha;
    this.gore[i * 4] = goneMask;
    this.gore[i * 4 + 1] = reel;
    this.gore[i * 4 + 2] = lean;
    this.gore[i * 4 + 3] = bottoms + footwear * 4 + hairstyle * 16;
    // Legacy/phantom callers retain time-driven movement. Real infected provide integrated phase.
    this.motion[i * 4] = motion?.move ?? Math.min(1, Math.max(0, (stride - 0.6) / 2));
    this.motion[i * 4 + 1] = motion?.action ?? 0;
    this.motion[i * 4 + 2] = motion?.weight ?? 0;
    this.motion[i * 4 + 3] = outfit + (female ? 8 : 0);
    if (this.clips) this.pushBaked(i, kind, phase, stride, fall, look, goneMask, motion, reel);
  }

  /** This body's own take of a move: the same one every frame, different from most of its neighbours'. */
  private take(move: string, look: number): ClipInfo {
    const list = this.takes[move];
    // A different stride through the takes per move, so the looks that share a walk do not all share a death too.
    const salt = move.length * 7 + move.charCodeAt(0);
    return list[(look * 5 + salt + Math.floor(look / list.length)) % list.length];
  }

  /**
   * Its own death, of those that go down the way the blow sends it (onto its back when hit from the front): picked by the
   * seed it died with, or by its looks.
   */
  private death(look: number, motion?: ZombieMotion): ClipInfo {
    const way = motion?.back === undefined ? null : motion.back ? this.deaths.back : this.deaths.front;
    const list = way?.length ? way : this.takes.death;
    if (motion?.death === undefined) return this.take('death', look);
    return list[Math.min(list.length - 1, Math.floor(motion.death * list.length))];
  }

  /**
   * Clips for one body from what it is doing: the gait its kind moves in (a shamble, a runner's jog, a stalker's crouch, a
   * sprint when it bursts, a crawl on its arms with both legs gone), each in one of several takes the body keeps, blended
   * up from its idle by how fast it goes and kept on its legs' own phase so the feet do not slide; then what it does with
   * its arms and body over that (clawing at what it holds, kneeling to feed, screaming, a smashing blow and its wind-up) or,
   * just hit, its flinch; its own death as it falls. Packed into aAnim (clip A, B's weight) and aMotion.xyz (B).
   */
  protected pushBaked(i: number, kind: ZombieKind, phase: number, stride: number, fall: number, look: number, goneMask: number, motion?: ZombieMotion, reel = 0) {
    const C = this.clips!;
    const t = this.uniforms.uTime.value as number;
    const off = look * 0.137;
    const legsGone = ((goneMask & 10) === 10 ? 1 : 0) + ((goneMask & 20) === 20 ? 1 : 0);
    const crawling = legsGone >= 2 && !!C.crawl;
    let A: ClipInfo = crawling ? C.crawl : this.take('idle', look);
    let pa = t / A.dur + off;
    let B: ClipInfo | null = null;
    let pb = 0;
    let wb = 0;
    if (fall > 0) {
      A = this.death(look, motion);
      // At its own pace when the time it has been dead is known; the first moments blend out of what it was doing.
      const dt = motion?.deadT;
      pa = dt === undefined ? Math.min(1, fall) : Math.min(1, (dt * DEATH_PACE) / A.dur);
      if (dt !== undefined && dt < DEATH_BLEND) {
        B = this.take('idle', look);
        pb = t / B.dur + off;
        wb = 1 - dt / DEATH_BLEND;
      }
    } else {
      const act = motion?.action ?? 0;
      const w = motion?.weight ?? 0;
      const move = motion ? motion.move : Math.min(1, Math.max(0, (stride - 0.6) / 2));
      // Phantoms move by time; the infected pass the phase their legs have travelled.
      const legs = (motion ? phase : phase + stride * t) / (Math.PI * 2);
      const gait = crawling ? C.crawl : act === ZOMBIE_ACTION.burst ? C.sprint : kind === 'runner' ? this.take('jog', look)
        : kind === 'stalker' ? this.take('crouch', look) : this.take('walk', look);
      // Lying on its arms it holds the crawl still between pulls.
      if (crawling) pa = 0.1;
      if (move > 0.5) {
        A = gait;
        pa = legs;
      } else if (move > 0.02) {
        B = gait;
        pb = legs;
        wb = move / 0.5;
      }
      const action = act === ZOMBIE_ACTION.grab ? C.scratch : act === ZOMBIE_ACTION.feed ? C.kneel : act === ZOMBIE_ACTION.scream ? this.take('scream', look)
        : act === ZOMBIE_ACTION.wind || act === ZOMBIE_ACTION.smash ? this.take('punch', look) : null;
      if (action) {
        B = action;
        if (act === ZOMBIE_ACTION.wind) { pb = 0.3 * w; wb = Math.max(0.2, w); }
        else if (act === ZOMBIE_ACTION.smash) { pb = 1 - w; wb = 1; }
        // Kneeling holds on the knees: the clip's first quarter is getting down.
        else if (act === ZOMBIE_ACTION.feed) { pb = 0.25 + 0.7 * ((t / (action.dur * 0.7) + off) % 1); wb = Math.max(0.6, w); }
        else { pb = t / action.dur + off; wb = Math.max(0.6, w); }
      } else if (reel > 0.03 && this.takes.hit) {
        // Just hit: its flinch, from the blow on, fading as the reel does.
        B = this.take('hit', look + Math.floor(t * 0.37));
        pb = Math.min(1, (1 - reel) * 1.15);
        wb = Math.min(1, reel * 2.5);
      }
    }
    this.anim[i * 4] = A.start;
    this.anim[i * 4 + 1] = A.loop ? A.frames : -A.frames;
    this.anim[i * 4 + 2] = pa;
    this.anim[i * 4 + 3] = B ? Math.min(1, wb) : 0;
    this.motion[i * 4] = B?.start ?? 0;
    this.motion[i * 4 + 1] = B ? (B.loop ? B.frames : -B.frames) : 1;
    this.motion[i * 4 + 2] = pb;
    // The clips carry charging, feeding and crawling postures; a body on one leg still leans by hand, and the flinch takes
    // most of a hit's reel.
    this.gore[i * 4 + 2] = crawling ? 0 : legsGone >= 2 ? 0.75 : legsGone === 1 ? 0.12 : 0;
    if (reel > 0.03 && this.takes.hit) this.gore[i * 4 + 1] = reel * 0.45;
  }

  /** Ghosts only: how much of the colour is rainbow (1 is plainly unreal, 0 is nearly the real thing). */
  setGhostTint(v: number) {
    this.uniforms.uGhostTint.value = v;
  }

  end(time: number) {
    this.mesh.count = this.count;
    uploadPrefix(this.mesh.instanceMatrix, this.count);
    uploadPrefix(this.animAttr, this.count);
    uploadPrefix(this.kindAttr, this.count);
    uploadPrefix(this.goreAttr, this.count);
    uploadPrefix(this.motionAttr, this.count);
    this.uniforms.uTime.value = time;
  }
}
