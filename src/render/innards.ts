import * as THREE from 'three';
import { MeshBuilder, S, type ColorIn } from './builder';
import { J } from './zombieRender';

/**
 * What is under a zombie's skin, built in the same rest pose and rigged to the same joints as the body (`zombieRender.ts`),
 * so it walks, reels and falls with it. It is never seen whole: the wound shader (`fleshShader.ts`) only shows it through
 * the holes it eats in the skin, and in each of these layers only as deep as the wound went.
 *
 * Layers (`aZ.w` = 100 + layer): 1 muscle, a shell just inside the skin; 2 bone, the skull, ribs, spine, pelvis and the long
 * bones; 3 organs, which are never cut away: lungs, heart, liver, stomach, the gut coiled in the belly, the brain.
 */

type P3 = [number, number, number];

const MUSCLE = 1;
const BONE = 2;
const ORGAN = 3;

const muscle = (shade = 1): ColorIn => ({ c: new THREE.Color(0x7c1a14).multiplyScalar(shade), r: 0.5, m: 0, w: 0.1 });
const bone = (shade = 1): ColorIn => ({ c: new THREE.Color(0xd8cbb0).multiplyScalar(shade), r: 0.55, m: 0, w: 0.15 });
const organ = (hex: number): ColorIn => S.skin(hex);

/** A closed shell through elliptic rings (height, half width, half depth, centre z). */
function shell(rings: readonly P3[] | readonly [number, number, number, number][], sides = 14): THREE.BufferGeometry {
  const r4 = rings as readonly [number, number, number, number][];
  const positions: number[] = [];
  const indices: number[] = [];
  for (const [y, w, d, z] of r4) {
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      positions.push(Math.sin(a) * w, y, z + Math.cos(a) * d);
    }
  }
  for (let r = 0; r < r4.length - 1; r++) {
    for (let i = 0; i < sides; i++) {
      const a = r * sides + i;
      const b = r * sides + ((i + 1) % sides);
      indices.push(a, b, a + sides, b, b + sides, a + sides);
    }
  }
  for (const r of [0, r4.length - 1]) {
    const centre = positions.length / 3;
    positions.push(0, r4[r][0], r4[r][3]);
    for (let i = 0; i < sides; i++) {
      const a = r * sides + i;
      const b = r * sides + ((i + 1) % sides);
      indices.push(...(r === 0 ? [centre, b, a] : [centre, a, b]));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

/** A smooth tube through points (no joint balls): ribs and gut, cheap enough for every wounded body on screen. */
function tube(b: MeshBuilder, pts: P3[], r: number, color: ColorIn, radial = 5, per = 3) {
  const curve = new THREE.CatmullRomCurve3(pts.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
  const g = new THREE.TubeGeometry(curve, Math.max(2, (pts.length - 1) * per), r, radial, false);
  b.geo(g, 0, 0, 0, 1, 1, 1, color);
  g.dispose();
}

/** Inner wall of the trunk: the torso's cross-sections pulled in by the thickness of the skin and cloth. */
const TRUNK: [number, number, number, number][] = [
  [0.87, 0.1, 0.066, 0], [0.9, 0.13, 0.085, 0], [0.97, 0.13, 0.082, 0], [1.04, 0.115, 0.07, -0.005], [1.07, 0.107, 0.066, -0.01],
  [1.18, 0.125, 0.075, -0.02], [1.32, 0.164, 0.089, -0.02], [1.4, 0.178, 0.08, -0.02], [1.46, 0.128, 0.05, -0.022],
  [1.5, 0.038, 0.038, 0.008], [1.57, 0.034, 0.034, 0.022],
];
/** Inside of the skull. */
const SKULL: [number, number, number, number][] = [
  [1.63, 0.048, 0.052, 0.008], [1.65, 0.07, 0.073, 0.012], [1.69, 0.086, 0.077, 0.014], [1.735, 0.09, 0.08, 0.012],
  [1.785, 0.072, 0.065, 0.006], [1.808, 0.04, 0.036, 0], [1.82, 0.005, 0.005, 0],
];

function trunkAt(y: number): { w: number; d: number; z: number } {
  for (let i = 0; i < TRUNK.length - 1; i++) {
    const a = TRUNK[i];
    const b = TRUNK[i + 1];
    if (y <= b[0]) {
      const t = Math.max(0, (y - a[0]) / (b[0] - a[0]));
      return { w: a[1] + (b[1] - a[1]) * t, d: a[2] + (b[2] - a[2]) * t, z: a[3] + (b[3] - a[3]) * t };
    }
  }
  const l = TRUNK[TRUNK.length - 1];
  return { w: l[1], d: l[2], z: l[3] };
}

interface Part {
  id: number;
  pivot: P3;
  parent: P3;
}

/** The anatomy, as one geometry with the zombie mesh's attributes (`aZ`, `aPivot`, `aPivot2`). */
export function innardsGeometry(): THREE.BufferGeometry {
  const merged = new MeshBuilder();
  const part: number[] = [];
  const pivot: number[] = [];
  const pivot2: number[] = [];
  const layer: number[] = [];
  const add = (spec: Part, fn: (b: MeshBuilder, tag: (l: number) => void) => void) => {
    const b = new MeshBuilder();
    b.jitter = 0.1;
    b.seed(spec.id * 53 + 11);
    const tags: [number, number][] = [];
    fn(b, (l) => tags.push([b.vertexCount, l]));
    tags.push([b.vertexCount, 0]);
    merged.append(b);
    let from = 0;
    for (let t = 0; t < tags.length - 1; t++) {
      const to = tags[t + 1][0];
      for (let i = from; i < to; i++) {
        part.push(spec.id);
        pivot.push(...spec.pivot);
        pivot2.push(...spec.parent);
        layer.push(tags[t][1]);
      }
      from = to;
    }
  };

  // The trunk: a wall of muscle, the ribcage and spine, the pelvis, and what they hold.
  add({ id: 0, pivot: [0, 0, 0], parent: [0, 0, 0] }, (b, tag) => {
    tag(MUSCLE);
    const wall = shell(TRUNK, 16);
    b.geo(wall, 0, 0, 0, 1, 1, 1, muscle());
    wall.dispose();
    tag(BONE);
    // The spine runs up the back, a stack of vertebrae with their spines pointing back.
    for (let y = 0.92; y < 1.6; y += 0.031) {
      const t = trunkAt(y);
      const neck = y > 1.47;
      const z = neck ? t.z - 0.014 : t.z - t.d + 0.032;
      const r = neck ? 0.0095 : 0.014;
      b.cyl(0, y, z, r * 2, 0.022, r * 2, bone(), 0, 0, 0, 6);
      if (!neck) b.box(0, y - 0.004, z - r - 0.008, 0.008, 0.018, 0.016, bone(0.92), -0.4);
    }
    // Nine pairs of ribs from the spine round the sides to the breastbone, drooping toward the front; each point of a rib
    // follows the wall at its own height, so the lowest do not stand out of the narrowing waist.
    for (let i = 0; i < 9; i++) {
      const y = 1.42 - i * 0.025;
      const end = i < 6 ? 0.22 : 0.6 + (i - 6) * 0.3;
      for (const sx of [1, -1]) {
        const pts: P3[] = [];
        for (let k = 0; k <= 7; k++) {
          const u = k / 7;
          const a = Math.PI * (1 - u * (1 - end / Math.PI));
          const py = y - u * 0.035;
          const t = trunkAt(py);
          pts.push([sx * Math.sin(a) * (t.w - 0.012), py, t.z + Math.cos(a) * (t.d - 0.012)]);
        }
        tube(b, pts, 0.005, bone(), 4, 2);
      }
    }
    b.rbox(0, 1.31, trunkAt(1.31).z + trunkAt(1.31).d - 0.014, 0.026, 0.19, 0.012, 0.004, bone());
    // The pelvis: two wings of the hip bone, the sacrum between them, the pubic arch in front.
    for (const sx of [1, -1]) {
      b.add('sphere16', sx * 0.082, 0.955, -0.012, 0.05, 0.09, 0.1, bone(), 0.1, 0, sx * 0.35);
      b.rod(sx * 0.07, 0.9, 0.0, sx * 0.03, 0.875, 0.055, 0.009, bone(), 6);
    }
    b.rbox(0, 0.935, -0.05, 0.06, 0.08, 0.025, 0.01, bone(0.95), 0.3);
    tag(ORGAN);
    // Lungs either side of the heart, the liver under the right lung, the stomach under the left: all packed a couple of
    // centimetres inside the wall, so nothing shows through skin that has not been opened.
    for (const sx of [1, -1]) b.add('sphere16', sx * 0.07, 1.33, -0.022, 0.1, 0.19, 0.105, organ(0xc27a72));
    b.add('sphere16', 0.02, 1.27, 0.015, 0.06, 0.075, 0.055, organ(0x6a0f0e), 0, 0, -0.35);
    b.add('sphere16', -0.045, 1.185, -0.008, 0.12, 0.055, 0.075, organ(0x561410), 0, 0, 0.2);
    b.add('sphere16', 0.05, 1.17, -0.004, 0.075, 0.055, 0.06, organ(0xc0907e), 0, 0, -0.3);
    for (const sx of [1, -1]) b.add('sphere', sx * 0.055, 1.1, -0.05, 0.03, 0.055, 0.026, organ(0x5a1714));
    // The gut, coiled to fill the belly: the small intestine in rows, the large one framing it.
    for (let row = 0; row < 4; row++) {
      const y = 0.975 + row * 0.033;
      const pts: P3[] = [];
      for (let x = -0.07; x <= 0.0701; x += 0.014) pts.push([x, y + Math.sin(x * 70 + row) * 0.006, 0.008 + Math.sin(x * 55 + row * 1.7) * 0.016]);
      tube(b, pts, 0.013, organ(row % 2 ? 0xc99484 : 0xd3a090), 6, 2);
    }
    tube(b, [[-0.07, 0.96, 0.0], [-0.076, 1.04, 0.008], [-0.066, 1.105, 0.012], [0, 1.115, 0.016], [0.066, 1.105, 0.012], [0.076, 1.04, 0.008], [0.058, 0.96, 0.0]], 0.017, organ(0xae7f70), 6, 3);
    // The windpipe up the front of the neck.
    b.rod(0, 1.42, 0.01, 0, 1.58, 0.03, 0.0075, organ(0xd6b6a6), 8);
  });

  // The head: skull, brain, tongue.
  add({ id: 9, pivot: J.neck, parent: J.neck }, (b, tag) => {
    tag(BONE);
    const skull = shell(SKULL, 16);
    b.geo(skull, 0, 0, 0, 1, 1, 1, bone());
    skull.dispose();
    tag(ORGAN);
    b.add('sphere16', 0, 1.735, 0.006, 0.158, 0.118, 0.148, organ(0xc69c98));
    b.add('sphere', 0, 1.695, -0.026, 0.065, 0.045, 0.05, organ(0xb88c88));
    b.rod(0, 1.64, -0.005, 0, 1.7, 0.0, 0.014, organ(0xb08884), 8);
    b.add('sphere', 0, 1.6, 0.06, 0.07, 0.024, 0.08, organ(0x8a3a40));
  });

  // Arms: muscle round the upper arm and forearm, the humerus, and the two bones of the forearm.
  for (const [idU, idF, sh, el, sx] of [[5, 7, J.shL, J.elL, 1], [6, 8, J.shR, J.elR, -1]] as const) {
    const wr: P3 = [el[0], el[1] - 0.24, el[2] + 0.02];
    add({ id: idU, pivot: sh, parent: sh }, (b, tag) => {
      tag(MUSCLE);
      b.limb(sh[0], sh[1] - 0.01, sh[2], el[0], el[1], el[2], 0.037, 0.028, muscle(), 10, true);
      tag(BONE);
      b.rod(sh[0], sh[1] - 0.02, sh[2], el[0], el[1], el[2], 0.0095, bone(), 8);
      b.add('sphere', sh[0] - sx * 0.006, sh[1] - 0.02, sh[2], 0.03, 0.03, 0.03, bone());
      b.add('sphere', el[0], el[1], el[2], 0.03, 0.022, 0.026, bone());
    });
    add({ id: idF, pivot: el, parent: sh }, (b, tag) => {
      tag(MUSCLE);
      b.limb(el[0], el[1], el[2], wr[0], wr[1], wr[2], 0.033, 0.019, muscle(0.95), 10, true);
      tag(BONE);
      for (const o of [-0.008, 0.008]) b.rod(el[0] + o, el[1] - 0.01, el[2], wr[0] + o * 0.8, wr[1], wr[2], 0.0055, bone(), 6);
    });
  }

  // Legs: thigh and calf muscle, the femur with its head in the hip, the tibia and fibula.
  for (const [idT, idS, hip, knee] of [[1, 3, J.hipL, J.kneeL], [2, 4, J.hipR, J.kneeR]] as const) {
    const sx = Math.sign(hip[0]);
    const ankle: P3 = [knee[0], 0.12, knee[2] - 0.01];
    add({ id: idT, pivot: hip, parent: hip }, (b, tag) => {
      tag(MUSCLE);
      b.limb(hip[0], hip[1] - 0.03, hip[2], knee[0], knee[1], knee[2], 0.064, 0.046, muscle(), 10, true);
      tag(BONE);
      b.rod(hip[0], hip[1] - 0.02, hip[2], knee[0], knee[1] + 0.02, knee[2], 0.013, bone(), 8);
      b.add('sphere', hip[0] - sx * 0.012, hip[1] - 0.005, hip[2], 0.038, 0.038, 0.038, bone());
      b.add('sphere', knee[0], knee[1] + 0.012, knee[2], 0.045, 0.034, 0.036, bone());
    });
    add({ id: idS, pivot: knee, parent: hip }, (b, tag) => {
      tag(MUSCLE);
      b.limb(knee[0], knee[1] - 0.02, knee[2] - 0.008, ankle[0], ankle[1], ankle[2], 0.046, 0.029, muscle(0.95), 10, true);
      tag(BONE);
      b.rod(knee[0], knee[1] - 0.01, knee[2], ankle[0], ankle[1], ankle[2], 0.011, bone(), 8);
      b.rod(knee[0] + sx * 0.017, knee[1] - 0.03, knee[2] - 0.006, ankle[0] + sx * 0.016, ankle[1] + 0.01, ankle[2] - 0.004, 0.0048, bone(0.95), 6);
      b.add('sphere', knee[0], knee[1] + 0.005, knee[2] + 0.034, 0.028, 0.03, 0.014, bone());
    });
  }

  const g = merged.build();
  const zdat: number[] = [];
  for (let i = 0; i < part.length; i++) zdat.push(part[i], 0, 0, 100 + layer[i]);
  g.setAttribute('aZ', new THREE.Float32BufferAttribute(zdat, 4));
  g.setAttribute('aPivot', new THREE.Float32BufferAttribute(pivot, 3));
  g.setAttribute('aPivot2', new THREE.Float32BufferAttribute(pivot2, 3));
  g.deleteAttribute('uv');
  return g;
}
