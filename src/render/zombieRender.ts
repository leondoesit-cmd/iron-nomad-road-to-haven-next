import * as THREE from 'three';
import { MeshBuilder, S, type ColorIn } from './builder';
import { applyKit } from './materials';
import type { ZombieKind } from '../data';

export const MAX_ZOMBIES = 600;

/**
 * The infected: one instanced mesh for every zombie on screen. The body is built from smooth limbs with
 * per-vertex joint ids and pivots, and the vertex shader runs a two-joint walk (hips and knees, shoulders
 * and elbows) plus head loll. Clothes and skin come from palettes picked per instance, and brutes and
 * bloaters inflate along the normals, so one draw call covers a varied horde.
 */

/** Material slots: 0 fixed colour, 1 shirt, 2 trousers, 3 skin, 4 hair. */
const SLOT = { fixed: 0, shirt: 1, pants: 2, skin: 3, hair: 4 } as const;

type Pivot = [number, number, number];

interface PartSpec {
  id: number;
  pivot: Pivot;
  parent: Pivot;
}

/** Joint layout (rest pose, metres, origin at the feet, facing +Z). */
const J = {
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

function zombieGeometry(): THREE.BufferGeometry {
  const merged = new MeshBuilder();
  const part: number[] = [];
  const pivot: number[] = [];
  const pivot2: number[] = [];
  const slot: number[] = [];
  const bulk: number[] = [];
  const add = (spec: PartSpec, fn: (b: MeshBuilder, tag: (s: number, bm: number, bb: number) => void) => void) => {
    const b = new MeshBuilder();
    b.jitter = 0.08;
    b.seed(spec.id * 31 + 5);
    const tags: [number, number, number, number][] = [];
    const tag = (s: number, bm: number, bb: number) => tags.push([b.vertexCount, s, bm, bb]);
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
  const paletted = (s: number): ColorIn => ({ c: new THREE.Color(W, W, W), r: s === SLOT.skin ? 0.55 : 0.95, m: 0, w: s === SLOT.skin ? 0.7 : 0.9 });
  const shirt = paletted(SLOT.shirt);
  const pants = paletted(SLOT.pants);
  const skin = paletted(SLOT.skin);
  const hair = paletted(SLOT.hair);
  const wound = S.skin(0x4a0f0c);
  const bone = S.skin(0xc9bea0);
  const shoe = S.leather(0x2a2420, 0.7);
  // Body: pelvis, gaunt torso with a torn shirt, exposed ribs, a slumped neck.
  add({ id: 0, pivot: [0, 0, 0], parent: [0, 0, 0] }, (b, tag) => {
    tag(SLOT.pants, 0.3, 0.2);
    b.rbox(0, 0.95, 0, 0.32, 0.2, 0.2, 0.07, pants);
    tag(SLOT.shirt, 0.6, 1);
    b.limb(0, 1.0, 0, 0, 1.3, -0.01, 0.135, 0.15, shirt, 12);
    tag(SLOT.shirt, 1, 0.25);
    b.rbox(0, 1.34, -0.01, 0.36, 0.24, 0.2, 0.08, shirt);
    for (const sx of [1, -1]) b.sphereAt(sx * 0.18, 1.41, -0.01, 0.075, shirt);
    // Ragged hem.
    for (let i = 0; i < 7; i++) b.add('cone6', -0.15 + i * 0.05, 0.98 - (i % 2) * 0.03, 0.12 - Math.abs(i - 3) * 0.012, 0.05, 0.08, 0.02, shirt, Math.PI, 0, 0);
    tag(SLOT.fixed, 0, 0);
    // Torn open on the left: a wound with ribs.
    b.rbox(0.08, 1.24, 0.13, 0.13, 0.16, 0.03, 0.02, wound);
    for (let i = 0; i < 3; i++) b.capsule(0.03, 1.19 + i * 0.045, 0.145, 0.13, 1.2 + i * 0.045, 0.13, 0.009, bone, 6);
    tag(SLOT.skin, 0, 0);
    b.limb(0, 1.46, 0.0, 0, 1.56, 0.03, 0.05, 0.045, skin, 8);
  });
  // Head: skull, open jaw with teeth, sunken sockets, patchy hair.
  add({ id: 9, pivot: J.neck, parent: J.neck }, (b, tag) => {
    tag(SLOT.skin, 0, 0);
    b.add('sphere16', 0, 1.67, 0.02, 0.18, 0.21, 0.2, skin);
    // Brow ridge, gaunt cheekbones, nose stub and a slack lower jaw.
    b.add('sphere16', 0, 1.705, 0.085, 0.16, 0.045, 0.06, skin);
    for (const sx of [1, -1]) b.add('sphere16', sx * 0.055, 1.635, 0.085, 0.05, 0.035, 0.05, skin);
    b.add('cone6', 0, 1.66, 0.118, 0.035, 0.05, 0.03, skin, -0.3, 0, 0);
    b.rbox(0, 1.565, 0.06, 0.1, 0.04, 0.09, 0.018, skin, 0.4, 0, 0);
    for (const sx of [1, -1]) b.add('sphere', sx * 0.088, 1.665, 0.01, 0.025, 0.05, 0.03, skin);
    tag(SLOT.fixed, 0, 0);
    for (const sx of [1, -1]) {
      b.add('sphere', sx * 0.04, 1.682, 0.098, 0.045, 0.032, 0.025, S.skin(0x0b0807));
      b.add('sphere', sx * 0.04, 1.682, 0.106, 0.012, 0.01, 0.01, S.glow(0xb8c4a0, 0.15));
    }
    b.rbox(0, 1.6, 0.098, 0.075, 0.045, 0.03, 0.012, S.skin(0x1c0605));
    for (let i = 0; i < 4; i++) b.box(-0.024 + i * 0.016, 1.618, 0.112, 0.01, 0.012, 0.008, bone);
    for (let i = 0; i < 3; i++) b.box(-0.016 + i * 0.016, 1.582, 0.1, 0.01, 0.01, 0.008, bone);
    tag(SLOT.hair, 0, 0);
    b.add('dome', 0.01, 1.7, 0.0, 0.17, 0.11, 0.18, hair, -0.15, 0.4, 0.1);
  });
  // Arms: torn sleeve over a thin upper arm; forearm and clawed hand.
  for (const [idU, idF, sh, el, sx] of [[5, 7, J.shL, J.elL, 1], [6, 8, J.shR, J.elR, -1]] as const) {
    add({ id: idU, pivot: sh, parent: sh }, (b, tag) => {
      tag(SLOT.shirt, 0.9, 0);
      b.limb(sh[0], sh[1] - 0.02, sh[2], sh[0] + sx * 0.008, sh[1] - 0.14, sh[2], 0.06, 0.056, shirt, 10);
      tag(SLOT.skin, 0.9, 0);
      b.limb(sh[0] + sx * 0.008, sh[1] - 0.12, sh[2], el[0], el[1], el[2], 0.047, 0.04, skin, 10);
    });
    add({ id: idF, pivot: el, parent: sh }, (b, tag) => {
      tag(SLOT.skin, 0.7, 0);
      b.limb(el[0], el[1], el[2], el[0], el[1] - 0.24, el[2] + 0.02, 0.04, 0.032, skin, 10);
      b.rbox(el[0], el[1] - 0.29, el[2] + 0.025, 0.055, 0.09, 0.035, 0.015, skin);
      tag(SLOT.fixed, 0, 0);
      for (let f = 0; f < 3; f++) b.capsule(el[0] - 0.018 + f * 0.018, el[1] - 0.33, el[2] + 0.03, el[0] - 0.02 + f * 0.02, el[1] - 0.39, el[2] + 0.06, 0.007, S.skin(0x3a3226), 5);
    });
  }
  // Legs: trousers, one bare shin on some variants handled by palette, worn shoes.
  for (const [idT, idS, hip, knee] of [[1, 3, J.hipL, J.kneeL], [2, 4, J.hipR, J.kneeR]] as const) {
    add({ id: idT, pivot: hip, parent: hip }, (b, tag) => {
      tag(SLOT.pants, 0.5, 0.15);
      b.limb(hip[0], hip[1], hip[2], knee[0], knee[1], knee[2], 0.078, 0.06, pants, 10);
    });
    add({ id: idS, pivot: knee, parent: hip }, (b, tag) => {
      tag(SLOT.pants, 0.4, 0);
      b.limb(knee[0], knee[1], knee[2], knee[0], 0.12, knee[2] - 0.01, 0.058, 0.044, pants, 10);
      tag(SLOT.fixed, 0, 0);
      b.rbox(knee[0], 0.05, 0.04, 0.1, 0.1, 0.24, 0.035, shoe);
    });
  }
  const g = merged.build();
  // Packed to stay under WebGL's 16 vertex attributes: (joint id, material slot, muscle bulk, belly bulk).
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
attribute vec4 aZ; // joint id, material slot, muscle bulk, belly bulk
attribute vec3 aPivot;
attribute vec3 aPivot2;
attribute vec4 aAnim; // phase, stride rad/s, chase 0..1, fall
attribute vec4 aKind; // kind id, variant 0..1, brightness, spare
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
vec3 zRotZ( vec3 v, vec3 p, float a ) {
  vec3 d = v - p;
  float c = cos( a );
  float s = sin( a );
  return p + vec3( d.x * c - d.y * s, d.x * s + d.y * c, d.z );
}
`;

/** Joint angles: own rotation (x), parent rotation (y), head tilt (z), body lean (w). */
const ANGLES = /* glsl */ `
float zt = uTime * aAnim.y + aAnim.x;
float zs = sin( zt );
float zc2 = aAnim.z;
float zKind = aKind.x;
float zCrouch = zKind > 4.5 ? 0.35 : 0.0;
float zArmsUp = zKind > 1.5 && zKind < 2.5 ? 0.6 : 0.0;
float zOwn = 0.0;
float zPar = 0.0;
int zp = int( aZ.x + 0.5 );
float zThighL = zs * 0.6 - zCrouch;
float zThighR = -zs * 0.6 - zCrouch;
float zArmBase = -0.35 - zc2 * 1.15 - zArmsUp;
if ( zp == 1 ) zOwn = zThighL;
else if ( zp == 2 ) zOwn = zThighR;
else if ( zp == 3 ) { zOwn = max( 0.0, -zs ) * 0.9 + 0.12 + zCrouch * 1.6; zPar = zThighL; }
else if ( zp == 4 ) { zOwn = max( 0.0, zs ) * 0.9 + 0.12 + zCrouch * 1.6; zPar = zThighR; }
else if ( zp == 5 ) zOwn = zArmBase - zs * 0.32 * ( 1.0 - zc2 );
else if ( zp == 6 ) zOwn = zArmBase + zs * 0.32 * ( 1.0 - zc2 );
else if ( zp == 7 ) { zOwn = -0.35 - zc2 * 0.25 + sin( zt * 1.3 ) * 0.12; zPar = zArmBase - zs * 0.32 * ( 1.0 - zc2 ); }
else if ( zp == 8 ) { zOwn = -0.35 - zc2 * 0.25 + cos( zt * 1.1 ) * 0.12; zPar = zArmBase + zs * 0.32 * ( 1.0 - zc2 ); }
else if ( zp == 9 ) zOwn = 0.25 + sin( zt * 0.5 ) * 0.12 - zc2 * 0.2;
float zTilt = zp == 9 ? sin( zt * 0.37 + aAnim.x ) * 0.25 : 0.0;
float zLean = 0.16 + zc2 * 0.3 + zCrouch * 0.5;
`;

const NORMAL = /* glsl */ `
${ANGLES}
#define Z_ANGLES
vec3 objectNormal = vec3( normal );
objectNormal = zRotXn( objectNormal, zOwn );
if ( zp == 3 || zp == 4 || zp == 7 || zp == 8 ) objectNormal = zRotXn( objectNormal, zPar );
#ifdef USE_TANGENT
  vec3 objectTangent = vec3( tangent.xyz );
#endif
`;

const BEGIN = /* glsl */ `
#ifndef Z_ANGLES
${ANGLES}
#endif
vec3 transformed = vec3( position );
// Brutes bulk up through the chest and arms; bloaters swell at the belly.
float zMus = zKind > 3.5 && zKind < 4.5 ? 0.055 : 0.0;
float zBel = zKind > 2.5 && zKind < 3.5 ? 0.16 : 0.0;
transformed += normal * ( aZ.z * zMus + aZ.w * zBel );
if ( zp == 9 ) transformed = zRotZ( transformed, aPivot, zTilt );
transformed = zRotX( transformed, aPivot, zOwn );
if ( zp == 3 || zp == 4 || zp == 7 || zp == 8 ) transformed = zRotX( transformed, aPivot2, zPar );
// Whole-body hunch about the hips, a crouch for stalkers and a drunken sway.
float zl = smoothstep( 0.9, 1.5, transformed.y );
transformed.z += zLean * zl * ( transformed.y - 0.9 );
transformed.y -= zCrouch * 0.18 * smoothstep( 0.3, 0.95, transformed.y );
transformed.x += sin( zt * 0.5 ) * 0.05 * zl;
`;

const COLOR = /* glsl */ `
#include <color_vertex>
{
  int zs8 = int( mod( floor( aKind.y * 8.0 + aAnim.x * 3.0 ), 8.0 ) );
  int zp6 = int( mod( floor( aKind.y * 6.0 + aAnim.x * 5.0 ), 6.0 ) );
  int zk6 = int( aKind.x + 0.5 );
  vec3 zSkin = uSkin[ zk6 ];
  vec3 zHair = vec3( 0.06, 0.05, 0.045 );
  int zSlot = int( aZ.y + 0.5 );
  vColor.rgb *= aKind.z;
  if ( zSlot == 1 ) vColor.rgb *= uShirt[ zs8 ];
  else if ( zSlot == 2 ) vColor.rgb *= uPants[ zp6 ];
  else if ( zSlot == 3 ) vColor.rgb *= zSkin;
  else if ( zSlot == 4 ) vColor.rgb *= zHair;
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
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${PARS}${ghost ? GHOST_VERT_PARS : ''}`)
    .replace('#include <beginnormal_vertex>', NORMAL)
    .replace('#include <begin_vertex>', BEGIN + (ghost ? GHOST_VERT_MAIN : ''));
  if (shader.vertexShader.includes('#include <color_vertex>')) shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>', COLOR);
}

const linear = (hex: number) => new THREE.Color(hex);

export interface ZombieRendererOpts {
  /** Draw as translucent shimmering phantoms: no shadows, per-instance fade, drifting colour. */
  ghost?: boolean;
  /** Most instances at once. */
  max?: number;
}

export class ZombieRenderer {
  mesh: THREE.InstancedMesh;
  private max: number;
  private anim: Float32Array;
  private kind: Float32Array;
  private animAttr: THREE.InstancedBufferAttribute;
  private kindAttr: THREE.InstancedBufferAttribute;
  private uniforms: Record<string, THREE.IUniform> = {
    uTime: { value: 0 },
    uShirt: { value: [0x5a5446, 0x3e4a58, 0x6a3a32, 0x7a7262, 0x2e3a2c, 0x8a8478, 0x4a3a52, 0x9a8a5a].map(linear) },
    uPants: { value: [0x2e3036, 0x3a3a2e, 0x4a4238, 0x252830, 0x5a5040, 0x30343a].map(linear) },
    // Per kind: walker, runner, screamer, bloater, brute, stalker.
    uSkin: { value: [0x6f7660, 0x7a7660, 0x8e889a, 0x87904e, 0x7a5a4c, 0x5c6670].map(linear) },
  };
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
    this.uniforms.uGhostTint = { value: 1 };
    const geo = zombieGeometry();
    this.animAttr = new THREE.InstancedBufferAttribute(this.anim, 4);
    this.animAttr.setUsage(THREE.DynamicDrawUsage);
    this.kindAttr = new THREE.InstancedBufferAttribute(this.kind, 4);
    this.kindAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAnim', this.animAttr);
    geo.setAttribute('aKind', this.kindAttr);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    if (ghost) {
      mat.transparent = true;
      mat.depthWrite = false;
    }
    mat.onBeforeCompile = (shader) => {
      patchVertex(shader, this.uniforms, ghost);
      applyKit(shader, false);
      if (ghost) {
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${GHOST_FRAG_PARS}`).replace('#include <opaque_fragment>', GHOST_FRAG);
      }
    };
    mat.customProgramCacheKey = () => (ghost ? 'zombieGhost' : 'zombie');
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
      depth.customProgramCacheKey = () => 'zombieDepth';
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
   * Add one instance. `fall` runs 0..1 for the death animation (topples backwards and sinks).
   */
  push(kind: ZombieKind, scale: number, x: number, y: number, z: number, yaw: number, phase: number, stride: number, chase: number, fall: number, variant: number, alpha = 1) {
    if (this.count >= this.max) return;
    const i = this.count++;
    this.p.set(x, y, z);
    this.e.set(-fall * (Math.PI / 2) * 0.95, yaw, 0, 'YXZ');
    this.q.setFromEuler(this.e);
    this.s.set(scale, scale, scale);
    this.m.compose(this.p, this.q, this.s);
    this.mesh.setMatrixAt(i, this.m);
    this.anim[i * 4] = phase;
    this.anim[i * 4 + 1] = stride;
    this.anim[i * 4 + 2] = chase;
    this.anim[i * 4 + 3] = fall;
    this.kind[i * 4] = KIND_ID[kind];
    this.kind[i * 4 + 1] = (variant % 5) / 5 + 0.1;
    this.kind[i * 4 + 2] = 0.86 + (variant % 5) * 0.05;
    this.kind[i * 4 + 3] = alpha;
  }

  /** Ghosts only: how much of the colour is rainbow (1 is plainly unreal, 0 is nearly the real thing). */
  setGhostTint(v: number) {
    this.uniforms.uGhostTint.value = v;
  }

  end(time: number) {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.animAttr.needsUpdate = true;
    this.kindAttr.needsUpdate = true;
    this.uniforms.uTime.value = time;
  }
}
