import * as THREE from 'three';
import { uploadPrefix } from './upload';
import { MeshBuilder, S } from './builder';
import { applyKit, GLOBALS, kitMaterial } from './materials';
import { butterflyTexture } from './proctex';
import { shared } from './dispose';

/**
 * The small life of the country (`game/ambientLife.ts`), drawn cheaply: one instanced mesh per kind of body (a butterfly's
 * wing, a dragonfly, a small bird and its wing, a fish, a frog, a turtle, a lizard, a grasshopper), a glowing point layer
 * for fireflies, a dark one for gnats, flies and bees, and rings spreading on the water. Every frame the game pushes what
 * is alive and near; nothing here thinks. Models face +Z.
 */

export type LifeMesh = 'wing' | 'dragon' | 'dragonWing' | 'bird' | 'birdWing' | 'fish' | 'frog' | 'turtle' | 'lizard' | 'hopper' | 'crab' | 'skater' | 'snake' | 'coil';

const CAP: Record<LifeMesh, number> = {
  wing: 96,
  dragon: 48,
  dragonWing: 192,
  bird: 160,
  birdWing: 320,
  fish: 160,
  frog: 32,
  turtle: 16,
  lizard: 32,
  hopper: 24,
  crab: 32,
  skater: 48,
  snake: 16,
  coil: 8,
};

/** The meshes that move their own bodies in the vertex shader, by a per-instance `aWig` (phase, beats a second, amplitude). */
const WIGGLE = new Set<LifeMesh>(['fish', 'snake']);

const fur = (c: number, w = 0.3) => S.cloth(c, w);

/** A butterfly wing: a flat card reaching along +x from the hinge, its picture seen from above. */
function wingGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.5, 1, 0, -0.5, 1, 0, 0.5, 0, 0, 0.5], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(12).fill(1), 3));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  return g;
}

/** A dragonfly, 1 m long before scale (instances are ~6 cm): big-eyed head, thorax, a long thin abdomen. */
function dragonGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.jitter = 0.04;
  b.seed(801);
  const body = fur(0xffffff, 0.15);
  b.add('sphere16', 0, 0, 0.12, 0.14, 0.13, 0.2, body);
  b.limb(0, 0, 0.02, 0, -0.02, -0.62, 0.05, 0.03, body, 6, true);
  for (const sx of [1, -1]) b.sphereAt(sx * 0.05, 0.02, 0.26, 0.06, fur(0x2a3038, 0.1));
  return b.build();
}

/** One dragonfly wing: a long narrow blade along +x. */
function dragonWingGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.add('box', 0.5, 0, 0, 1, 0.005, 0.16, S.glass(0xd8e4ec));
  return b.build();
}

/** A small bird, 1 m long before scale (instances are 12 to 30 cm): pale belly, darker back, a short beak and tail. */
function birdGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.jitter = 0.05;
  b.seed(811);
  const back = fur(0xb8b8b8);
  const belly = fur(0xffffff);
  b.add('sphere16', 0, 0.02, 0, 0.42, 0.38, 0.85, back);
  b.add('sphere16', 0, -0.06, 0.05, 0.36, 0.28, 0.6, belly);
  b.add('sphere16', 0, 0.16, 0.36, 0.3, 0.3, 0.32, back);
  b.add('cone6', 0, 0.14, 0.58, 0.07, 0.18, 0.07, fur(0x2a2420), Math.PI / 2, 0, 0);
  b.add('box', 0, 0.06, -0.5, 0.2, 0.03, 0.4, back, -0.15, 0, 0);
  for (const sx of [1, -1]) b.sphereAt(sx * 0.11, 0.2, 0.44, 0.035, fur(0x101010, 0.1));
  return b.build();
}

/** A small bird's wing along +x, 1 m before scale. */
function birdWingGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.add('box', 0.45, 0, -0.05, 0.9, 0.02, 0.42, fur(0xa0a0a0));
  b.add('box', 0.8, 0, -0.12, 0.4, 0.02, 0.3, fur(0x787878), 0, -0.2, 0);
  return b.build();
}

/** A fish, 1 m long before scale: dark back, silver belly, tail fin and a dorsal fin. Its `aWig` makes it swim. */
function fishGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.jitter = 0.04;
  b.seed(821);
  b.add('sphere16', 0, 0, 0.04, 0.2, 0.26, 0.86, fur(0x6a6c62, 0.2));
  b.add('sphere16', 0, 0.06, 0.04, 0.12, 0.14, 0.76, fur(0x3a3c36, 0.2));
  b.add('sphere16', 0, -0.04, 0.06, 0.17, 0.17, 0.7, fur(0xf0f0ea, 0.1));
  b.add('box', 0, 0, -0.48, 0.015, 0.26, 0.2, fur(0x6a6a62), 0.0, 0, 0);
  b.add('box', 0, 0.15, 0.02, 0.012, 0.1, 0.3, fur(0x5a5a52), 0.3, 0, 0);
  for (const sx of [1, -1]) b.sphereAt(sx * 0.07, 0.04, 0.33, 0.028, fur(0x101010, 0.05));
  return b.build();
}

/** A frog sitting up, 1 m before scale (instances are ~7 cm). */
function frogGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.jitter = 0.08;
  b.seed(831);
  const skin = fur(0xffffff, 0.2);
  b.add('sphere16', 0, 0.28, -0.05, 0.7, 0.5, 0.9, skin, -0.35, 0, 0);
  b.add('sphere16', 0, 0.42, 0.32, 0.55, 0.36, 0.45, skin);
  for (const sx of [1, -1]) {
    b.sphereAt(sx * 0.18, 0.56, 0.4, 0.09, fur(0xe0c040, 0.1));
    b.sphereAt(sx * 0.18, 0.58, 0.44, 0.05, fur(0x101010, 0.05));
    b.add('sphere16', sx * 0.36, 0.14, -0.2, 0.3, 0.26, 0.6, skin);
    b.limb(sx * 0.22, 0.2, 0.32, sx * 0.3, 0.02, 0.44, 0.06, 0.05, skin, 5, true);
  }
  return b.build();
}

/** A pond turtle, 1 m before scale (instances are 20 to 35 cm): domed shell, head and four flippers. */
function turtleGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.jitter = 0.08;
  b.seed(841);
  const shell = fur(0x4e5236, 0.3);
  const skin = fur(0x5a5c46, 0.2);
  b.add('dome', 0, 0.06, 0, 0.9, 0.42, 1.0, shell);
  b.add('sphere16', 0, 0.06, 0, 0.86, 0.1, 0.96, fur(0x8a7a50));
  b.add('sphere16', 0, 0.12, 0.6, 0.2, 0.18, 0.28, skin);
  for (const sx of [1, -1]) {
    b.add('sphere16', sx * 0.42, 0.06, 0.3, 0.3, 0.06, 0.16, skin, 0, sx * 0.6, 0);
    b.add('sphere16', sx * 0.4, 0.06, -0.32, 0.22, 0.06, 0.14, skin, 0, -sx * 0.5, 0);
  }
  for (let i = 0; i < 5; i++) b.add('sphere', (i - 2) * 0.12, 0.42, (i % 2) * 0.2 - 0.1, 0.14, 0.04, 0.16, fur(0x3a3e2a));
  return b.build();
}

/** A lizard, 1 m before scale (instances are 15 to 30 cm): flat body, long tapering tail, four splayed legs. */
function lizardGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.jitter = 0.08;
  b.seed(851);
  const skin = fur(0xffffff, 0.3);
  b.add('sphere16', 0, 0.06, 0.05, 0.2, 0.1, 0.42, skin);
  b.add('sphere16', 0, 0.07, 0.31, 0.13, 0.09, 0.16, fur(0xc8d0e0, 0.3));
  b.limb(0, 0.05, -0.15, 0, 0.02, -0.65, 0.05, 0.008, skin, 6, true);
  for (const sx of [1, -1]) {
    b.limb(sx * 0.07, 0.05, 0.16, sx * 0.17, 0.0, 0.22, 0.02, 0.015, skin, 4, true);
    b.limb(sx * 0.07, 0.05, -0.08, sx * 0.17, 0.0, -0.14, 0.022, 0.015, skin, 4, true);
  }
  return b.build();
}

/** A grasshopper, 1 m before scale (instances are ~4 cm): a long body and the big folded hind legs. */
function hopperGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.jitter = 0.08;
  b.seed(861);
  const skin = fur(0xffffff, 0.3);
  b.add('sphere16', 0, 0.12, 0, 0.16, 0.18, 0.8, skin);
  b.add('sphere16', 0, 0.16, 0.36, 0.16, 0.2, 0.2, skin);
  for (const sx of [1, -1]) {
    b.limb(sx * 0.08, 0.14, -0.05, sx * 0.12, 0.3, -0.3, 0.03, 0.02, skin, 4, true);
    b.limb(sx * 0.12, 0.3, -0.3, sx * 0.1, 0.0, -0.45, 0.02, 0.01, skin, 4, true);
  }
  return b.build();
}

/**
 * A freshwater crab, 1 m across the shell before scale (instances are 5 to 9 cm): a flat rounded carapace, two claws held
 * forward, eight jointed legs splayed to the sides. It faces +Z; it walks sideways, along x.
 */
function crabGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.jitter = 0.08;
  b.seed(871);
  const shell = fur(0xffffff, 0.35);
  const leg = fur(0xc09a70, 0.3);
  b.add('sphere16', 0, 0.22, 0, 1.0, 0.34, 0.82, shell);
  b.add('sphere16', 0, 0.3, 0.02, 0.7, 0.16, 0.56, shell);
  for (const sx of [1, -1]) {
    b.sphereAt(sx * 0.14, 0.38, 0.38, 0.05, fur(0x201810, 0.1));
    // Claw: arm, then the pincer.
    b.limb(sx * 0.32, 0.18, 0.3, sx * 0.48, 0.2, 0.62, 0.07, 0.07, leg, 5, true);
    b.add('sphere16', sx * 0.46, 0.22, 0.78, 0.26, 0.17, 0.34, shell, 0, sx * 0.3, 0);
    for (let k = 0; k < 4; k++) {
      const z = 0.18 - k * 0.16;
      const kx = sx * (0.5 + k * 0.02);
      b.limb(sx * 0.42, 0.18, z, kx + sx * 0.18, 0.3, z - 0.05, 0.04, 0.035, leg, 4, true);
      b.limb(kx + sx * 0.18, 0.3, z - 0.05, kx + sx * 0.42, 0.0, z - 0.12, 0.035, 0.02, leg, 4, true);
    }
  }
  return b.build();
}

/** A water strider, 1 m long before scale (instances are ~1.5 cm of body): a thin body and four long legs spread on the film. */
function skaterGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.jitter = 0.05;
  b.seed(881);
  const dark = fur(0x2a2622, 0.2);
  b.add('sphere16', 0, 0.12, 0, 0.18, 0.12, 1.0, dark);
  for (const sx of [1, -1]) {
    b.rod(sx * 0.05, 0.12, 0.25, sx * 0.4, 0.0, 0.7, 0.025, dark, 4);
    b.rod(sx * 0.05, 0.12, -0.05, sx * 0.9, 0.0, 0.35, 0.025, dark, 4);
    b.rod(sx * 0.05, 0.12, -0.15, sx * 0.85, 0.0, -0.95, 0.025, dark, 4);
  }
  return b.build();
}

/**
 * A snake, 1 m long and about 5 cm thick before scale, lying along +z with its head at +z: a long body tapering to the tail,
 * a broad flat head, and a blotched back (the instance colours it). Scaled per species: length on z, thickness on x and y.
 */
function snakeGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.jitter = 0.05;
  b.seed(891);
  const N = 18;
  const rad = (t: number) => (t < 0.12 ? 0.004 + (t / 0.12) * 0.018 : t > 0.86 ? 0.02 - (t - 0.86) * 0.03 : 0.022);
  for (let i = 0; i < N; i++) {
    const t0 = i / N;
    const t1 = (i + 1) / N;
    // Blotches down the back: every other stretch a shade darker.
    const tone = i % 3 === 1 ? 0.62 : i % 3 === 2 ? 0.85 : 1;
    const c = S.skin(new THREE.Color(tone, tone, tone).getHex());
    b.limb(0, rad(t0), t0 - 0.5, 0, rad(t1), t1 - 0.5, rad(t0), rad(t1), c, 6, true);
  }
  b.add('sphere16', 0, 0.022, 0.52, 0.05, 0.034, 0.07, S.skin(0xe8e8e8));
  for (const sx of [1, -1]) b.sphereAt(sx * 0.018, 0.032, 0.54, 0.006, S.glow(0x101010, 0.1));
  return b.build();
}

/** A snake coiled on guard: two turns round itself and the head raised in the middle, 1 m of snake before scale. */
function coilGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.jitter = 0.05;
  b.seed(893);
  const skin = S.skin(0xffffff);
  const pts: [number, number, number][] = [];
  for (let k = 0; k <= 28; k++) {
    const t = k / 28;
    const a = t * Math.PI * 4;
    const r = 0.13 - t * 0.07;
    pts.push([Math.cos(a) * r, 0.02 + t * 0.03, Math.sin(a) * r]);
  }
  for (let k = 0; k < pts.length - 1; k++) {
    const t = k / (pts.length - 1);
    const r = t < 0.08 ? 0.006 + t * 0.2 : 0.022;
    b.limb(...pts[k], ...pts[k + 1], r, r, k % 3 === 1 ? S.skin(0x9e9e9e) : skin, 6, true);
  }
  // The neck rising out of the middle in an S, the head held level, looking out (+z).
  const e = pts[pts.length - 1];
  b.limb(e[0], e[1], e[2], 0, 0.1, 0.0, 0.02, 0.018, skin, 6, true);
  b.limb(0, 0.1, 0.0, 0, 0.13, 0.05, 0.018, 0.017, skin, 6, true);
  b.add('sphere16', 0, 0.135, 0.08, 0.05, 0.032, 0.07, S.skin(0xe8e8e8));
  for (const sx of [1, -1]) b.sphereAt(sx * 0.018, 0.145, 0.095, 0.006, S.glow(0x101010, 0.1));
  return b.build();
}

/**
 * Opaque critters share the kit material; the fish and the snakes get their own, which bends the body side to side down
 * its length: a fish's tail beat (growing toward the tail), a snake's travelling S (all along it).
 */
const wiggleMats = new Map<'fish' | 'snake', THREE.MeshStandardMaterial>();
function wiggleMaterial(kind: 'fish' | 'snake'): THREE.MeshStandardMaterial {
  // One per kind for the whole game: every scene's renderer shares it, so it is never rebuilt (or leaked) per scene.
  const had = wiggleMats.get(kind);
  if (had) return had;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: kind === 'fish' ? 0.45 : 0.6, metalness: kind === 'fish' ? 0.15 : 0.05 });
  const wave =
    kind === 'fish'
      ? /* glsl */ `
  // A wave runs from the head to the tail, growing toward the tail: phase, beats a second, how hard it swims.
  float fTail = smoothstep( 0.25, -0.55, transformed.z );
  transformed.x += sin( uTime * aWig.y * 6.2832 + aWig.x - transformed.z * 5.0 ) * aWig.z * ( 0.03 + 0.17 * fTail );`
      : /* glsl */ `
  // Two waves along the body travelling tailward; the head swings least. aWig.z is the swing in model units.
  float sHead = 1.0 - 0.6 * smoothstep( 0.2, 0.5, transformed.z );
  transformed.x += sin( uTime * aWig.y * 6.2832 + aWig.x + transformed.z * 13.0 ) * aWig.z * sHead;`;
  m.onBeforeCompile = (shader) => {
    applyKit(shader, false);
    shader.uniforms.uTime = GLOBALS.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nattribute vec3 aWig;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>${wave}`);
  };
  m.customProgramCacheKey = () => `lifeWiggle:${kind}`;
  wiggleMats.set(kind, shared(m));
  return m;
}

let wingMat: THREE.MeshStandardMaterial | null = null;

interface Batch {
  mesh: THREE.InstancedMesh;
  n: number;
}

const POINT_VERT = /* glsl */ `
attribute vec4 aColor;
attribute float aSize;
varying vec4 vColor;
uniform float uScale;
#include <fog_pars_vertex>
void main() {
  vColor = aColor;
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = max( 1.5, aSize * uScale / max( 0.1, -mvPosition.z ) );
  #include <fog_vertex>
}`;
const POINT_FRAG = /* glsl */ `
varying vec4 vColor;
uniform float uSoft;
#include <fog_pars_fragment>
void main() {
  float d = length( gl_PointCoord - 0.5 ) * 2.0;
  float a = vColor.a * ( 1.0 - smoothstep( uSoft, 1.0, d ) );
  if ( a < 0.01 ) discard;
  gl_FragColor = vec4( vColor.rgb, a );
  #include <fog_fragment>
}`;

/** A pool of points written fresh each frame: a soft round dot each, sized in metres. */
class PointLayer {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private geo = new THREE.BufferGeometry();
  n = 0;

  constructor(
    readonly cap: number,
    additive: boolean,
    soft: number,
  ) {
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 4);
    this.size = new Float32Array(cap);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: 600 }, uSoft: { value: soft } }]),
      transparent: true,
      depthWrite: false,
      fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
  }

  add(x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.col[i * 4] = r;
    this.col[i * 4 + 1] = g;
    this.col[i * 4 + 2] = b;
    this.col[i * 4 + 3] = a;
    this.size[i] = size;
  }

  flush() {
    this.geo.setDrawRange(0, this.n);
    for (const k of ['position', 'aColor', 'aSize']) {
      const at = this.geo.getAttribute(k) as THREE.BufferAttribute;
      uploadPrefix(at, this.n);
    }
  }

  setScale(viewHeightPx: number, fovDeg: number) {
    (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = viewHeightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  dispose() {
    this.geo.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

const RING_VERT = /* glsl */ `
attribute vec2 aRing;
varying vec2 vUv;
varying vec2 vRing;
#include <fog_pars_vertex>
void main() {
  vUv = uv - 0.5;
  vRing = aRing;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const RING_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec2 vRing;
#include <fog_pars_fragment>
void main() {
  // vRing.x is how far the ring has spread (0..1), vRing.y how strong it is.
  float d = length( vUv ) * 2.0;
  float r = mix( 0.15, 0.95, vRing.x );
  float w = mix( 0.06, 0.03, vRing.x );
  float ring = smoothstep( w, 0.0, abs( d - r ) ) + 0.6 * smoothstep( w, 0.0, abs( d - r * 0.62 ) ) * ( 1.0 - vRing.x );
  float a = ring * vRing.y * ( 1.0 - vRing.x );
  if ( a < 0.01 ) discard;
  gl_FragColor = vec4( vec3( 0.86, 0.92, 0.95 ), a * 0.55 );
  #include <fog_fragment>
}`;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

export class LifeRenderer {
  readonly group = new THREE.Group();
  private batches = new Map<LifeMesh, Batch>();
  /** Fireflies. */
  readonly glow = new PointLayer(160, true, 0.15);
  /** Gnats, carrion flies and bees. */
  readonly dots = new PointLayer(320, false, 0.55);
  private rings: THREE.InstancedMesh;
  private ringAt: THREE.InstancedBufferAttribute;
  private ringN = 0;
  private wigAt = new Map<LifeMesh, THREE.InstancedBufferAttribute>();

  constructor() {
    this.group.add(this.glow.points, this.dots.points);
    const rg = new THREE.PlaneGeometry(1, 1);
    rg.rotateX(-Math.PI / 2);
    this.ringAt = new THREE.InstancedBufferAttribute(new Float32Array(64 * 2), 2);
    this.ringAt.setUsage(THREE.DynamicDrawUsage);
    rg.setAttribute('aRing', this.ringAt);
    const rm = new THREE.ShaderMaterial({
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
      transparent: true,
      depthWrite: false,
      fog: true,
      // Colour blends over the water; its alpha (the reflection pass's mirror mark) is left as the water wrote it.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.rings = new THREE.InstancedMesh(rg, rm, 64);
    this.rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 5;
    this.rings.count = 0;
    this.group.add(this.rings);
  }

  private batch(kind: LifeMesh): Batch {
    let b = this.batches.get(kind);
    if (b) return b;
    const cap = CAP[kind];
    let geo: THREE.BufferGeometry;
    let mat: THREE.Material;
    switch (kind) {
      case 'wing': {
        geo = wingGeometry();
        mat = wingMat ??= shared(new THREE.MeshStandardMaterial({ map: butterflyTexture(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8, vertexColors: true }));
        break;
      }
      case 'dragonWing':
        geo = dragonWingGeometry();
        mat = kitMaterial({ detail: false, side: THREE.DoubleSide, transparent: true, opacity: 0.32 });
        break;
      case 'fish':
        geo = fishGeometry();
        mat = wiggleMaterial('fish');
        break;
      case 'snake':
        geo = snakeGeometry();
        mat = wiggleMaterial('snake');
        break;
      default:
        geo = { dragon: dragonGeometry, bird: birdGeometry, birdWing: birdWingGeometry, frog: frogGeometry, turtle: turtleGeometry, lizard: lizardGeometry, hopper: hopperGeometry, crab: crabGeometry, skater: skaterGeometry, coil: coilGeometry }[kind]();
        mat = kitMaterial({ detail: false, side: kind === 'birdWing' ? THREE.DoubleSide : THREE.FrontSide });
    }
    shared(geo);
    if (WIGGLE.has(kind)) {
      const at = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      at.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aWig', at);
      this.wigAt.set(kind, at);
    }
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = kind === 'bird' || kind === 'turtle' || kind === 'snake' || kind === 'coil' || kind === 'lizard';
    mesh.receiveShadow = kind !== 'dragonWing';
    mesh.count = 0;
    mesh.setColorAt(0, _c.set(1, 1, 1));
    this.group.add(mesh);
    b = { mesh, n: 0 };
    this.batches.set(kind, b);
    return b;
  }

  begin() {
    for (const b of this.batches.values()) b.n = 0;
    this.glow.n = 0;
    this.dots.n = 0;
    this.ringN = 0;
  }

  /**
   * One body: position, yaw (about y, 0 faces +z), pitch (nose down +), roll, scale per axis and a colour (sRGB, as picked by
   * eye; it is converted to the renderer's linear space). Returns false when full.
   */
  put(kind: LifeMesh, x: number, y: number, z: number, yaw: number, pitch: number, roll: number, sx: number, sy: number, sz: number, r: number, g: number, b: number): boolean {
    const bt = this.batch(kind);
    if (bt.n >= CAP[kind]) return false;
    _e.set(pitch, yaw, roll, 'YXZ');
    _q.setFromEuler(_e);
    _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
    bt.mesh.setMatrixAt(bt.n, _m);
    bt.mesh.setColorAt(bt.n, _c.setRGB(r, g, b, THREE.SRGBColorSpace));
    bt.n++;
    return true;
  }

  /**
   * A body hinged to a parent pose (a wing on a bird): the parent's position and yaw/pitch/roll, then the part's offset in the
   * parent's frame, its own rotation (roll about the parent's long axis, then a sweep back) and its scale.
   */
  putChild(kind: LifeMesh, px: number, py: number, pz: number, yaw: number, pitch: number, roll: number, ox: number, oy: number, oz: number, flap: number, sweep: number, sx: number, sy: number, sz: number, r: number, g: number, b: number) {
    const bt = this.batch(kind);
    if (bt.n >= CAP[kind]) return;
    _e.set(pitch, yaw, roll, 'YXZ');
    _q.setFromEuler(_e);
    _p.set(ox, oy, oz).applyQuaternion(_q);
    _p.x += px;
    _p.y += py;
    _p.z += pz;
    _q.multiply(_q2.setFromEuler(_e.set(0, sweep, flap, 'YXZ')));
    _m.compose(_p, _q, _s.set(sx, sy, sz));
    bt.mesh.setMatrixAt(bt.n, _m);
    bt.mesh.setColorAt(bt.n, _c.setRGB(r, g, b, THREE.SRGBColorSpace));
    bt.n++;
  }

  /** A fish: how far through its tail beat it is, beats a second and how hard it swims, for the wiggle. */
  putFish(x: number, y: number, z: number, yaw: number, pitch: number, len: number, r: number, g: number, b: number, phase: number, rate: number, amp: number) {
    const bt = this.batch('fish');
    const i = bt.n;
    if (!this.put('fish', x, y, z, yaw, pitch, 0, len, len, len, r, g, b)) return;
    this.wigAt.get('fish')!.setXYZ(i, phase, rate, amp);
  }

  /** A snake `len` long and `thick` times the model's thickness, rippling: `swing` is how far its body swings to each side (m). */
  putSnake(x: number, y: number, z: number, yaw: number, len: number, thick: number, r: number, g: number, b: number, phase: number, rate: number, swing: number) {
    const bt = this.batch('snake');
    const i = bt.n;
    if (!this.put('snake', x, y, z, yaw, 0, 0, thick, thick, len, r, g, b)) return;
    this.wigAt.get('snake')!.setXYZ(i, phase, rate, swing / Math.max(0.1, thick));
  }

  ring(x: number, y: number, z: number, radius: number, age: number, strength: number) {
    if (this.ringN >= 64) return;
    const i = this.ringN++;
    _m.compose(_p.set(x, y, z), _q.identity(), _s.set(radius * 2, 1, radius * 2));
    this.rings.setMatrixAt(i, _m);
    this.ringAt.setXY(i, age, strength);
  }

  end() {
    for (const b of this.batches.values()) {
      b.mesh.count = b.n;
      uploadPrefix(b.mesh.instanceMatrix, b.n);
      if (b.mesh.instanceColor) uploadPrefix(b.mesh.instanceColor, b.n);
    }
    for (const [kind, at] of this.wigAt) uploadPrefix(at, this.batches.get(kind)!.n);
    this.rings.count = this.ringN;
    uploadPrefix(this.rings.instanceMatrix, this.ringN);
    uploadPrefix(this.ringAt, this.ringN);
    this.glow.flush();
    this.dots.flush();
  }

  setViewScale(viewHeightPx: number, fovDeg: number) {
    this.glow.setScale(viewHeightPx, fovDeg);
    this.dots.setScale(viewHeightPx, fovDeg);
  }

  dispose() {
    // The geometries are this renderer's own (each carries its own instanced wiggle buffer); materials are shared.
    for (const b of this.batches.values()) {
      b.mesh.geometry.dispose();
      b.mesh.dispose();
    }
    this.batches.clear();
    this.glow.dispose();
    this.dots.dispose();
    this.rings.geometry.dispose();
    (this.rings.material as THREE.Material).dispose();
    this.rings.dispose();
  }
}
