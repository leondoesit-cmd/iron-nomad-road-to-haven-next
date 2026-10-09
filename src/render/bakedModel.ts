import * as THREE from 'three';
import { shared } from './dispose';

/**
 * Rigged, animated models baked offline (`scripts/bake-models.mjs`) from licensed glTF sources (`public/models/sources.json`).
 * A model is one merged skinned geometry plus a texture of skinning matrices: every bone, every frame of every clip, as
 * three rows of half floats. The vertex shader reads them by instance: each instance names one or two clips and where it
 * is in each, so a whole herd or horde is one instanced draw (and one for its shadow) with no per-bone CPU work.
 *
 * Per instance (`HerdMesh.set`): clip A and its phase, clip B, its phase and blend weight, a part mask (parts gone fold to
 * the joint they hung from, and the cut is drawn raw) and a tint.
 */

export interface ClipInfo {
  start: number;
  frames: number;
  dur: number;
  loop: boolean;
}

export interface BakedModelData {
  name: string;
  verts: number;
  bones: number;
  frames: number;
  clips: Record<string, ClipInfo>;
  bounds: [number[], number[]];
  material: { roughness?: number; metalness?: number; sheen?: number };
  texture: string | null;
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array | null;
  color: Uint8Array;
  skinIndex: Uint8Array;
  skinWeight: Uint8Array;
  /** Per vertex: the mask of the part it belongs to and every part above it. */
  part: Uint16Array;
  pivot: Float32Array;
  index: Uint16Array | Uint32Array;
  anim: Uint16Array;
  /** An animation bank for a body the game builds itself: its bones in texture order and their rest positions. */
  boneNames?: string[];
  joints?: Record<string, number[]>;
  /** An insect's wings (the game hangs and beats them): per wing, hinge x, y, z, span (body lengths), sweep back and tilt up. */
  mounts?: Record<string, number[]>;
}

const ARR = { Float32Array, Uint8Array, Uint16Array, Uint32Array } as const;

/** Read a baked model file. */
export function parseBakedModel(buf: ArrayBuffer): BakedModelData {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'INMB') throw new Error('not a baked model');
  const hlen = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hlen)));
  const base = 8 + hlen;
  const get = (key: string) => {
    const a = header.attrs[key];
    if (!a) return null;
    const [off, type, len] = a as [number, keyof typeof ARR, number];
    const T = ARR[type];
    return new T(buf, base + off, len);
  };
  return {
    name: header.name,
    verts: header.verts,
    bones: header.bones,
    frames: header.frames,
    clips: header.clips,
    bounds: header.bounds,
    material: header.material ?? {},
    texture: header.texture,
    position: get('position') as Float32Array,
    normal: get('normal') as Float32Array,
    uv: get('uv') as Float32Array | null,
    color: get('color') as Uint8Array,
    skinIndex: get('skinIndex') as Uint8Array,
    skinWeight: get('skinWeight') as Uint8Array,
    part: get('part') as Uint16Array,
    pivot: get('pivot') as Float32Array,
    index: get('index') as Uint16Array | Uint32Array,
    anim: get('anim') as Uint16Array,
    boneNames: header.boneNames,
    joints: header.joints,
    mounts: header.mounts,
  };
}

/** The bind-pose geometry with the attributes the herd shader reads (no per-instance ones yet). */
export function bakedGeometry(d: BakedModelData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(d.normal, 3));
  if (d.uv) g.setAttribute('uv', new THREE.BufferAttribute(d.uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(d.color, 3, true));
  // Skinned models only (a still critter has none of these).
  if (d.skinIndex) g.setAttribute('aJoint', new THREE.BufferAttribute(d.skinIndex, 4));
  if (d.skinWeight) g.setAttribute('aWeight', new THREE.BufferAttribute(d.skinWeight, 4, true));
  if (d.part) g.setAttribute('aPart', new THREE.BufferAttribute(d.part, 1));
  if (d.pivot) g.setAttribute('aPivot', new THREE.BufferAttribute(d.pivot, 3));
  g.setIndex(new THREE.BufferAttribute(d.index, 1));
  const [mn, mx] = d.bounds;
  g.boundingBox = new THREE.Box3(new THREE.Vector3(...mn), new THREE.Vector3(...mx));
  g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
  return g;
}

/** The skinning matrices of every frame: width bones x 3 texels (rows of a 3x4 matrix), one line per frame. */
export function animTexture(d: BakedModelData): THREE.DataTexture {
  const t = new THREE.DataTexture(d.anim, d.bones * 3, d.frames, THREE.RGBAFormat, THREE.HalfFloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return shared(t);
}

const VERT_PARS = /* glsl */ `
uniform highp sampler2D tAnim;
attribute vec4 aJoint;
attribute vec4 aWeight;
attribute float aPart;
attribute vec3 aPivot;
// Clip A: first frame line, frame count, phase 0..1, looping (1) or held at the end (0).
attribute vec4 iClipA;
// Clip B the same, with its blend weight in place of the loop flag (B always loops; a held B uses a phase of 1).
attribute vec4 iClipB;
// x: mask of parts gone, y: B holds at its end (1) or loops (0).
attribute vec2 iGore;
mat4 bakedBone( int line, float bone ) {
  int x = int( bone ) * 3;
  vec4 r0 = texelFetch( tAnim, ivec2( x, line ), 0 );
  vec4 r1 = texelFetch( tAnim, ivec2( x + 1, line ), 0 );
  vec4 r2 = texelFetch( tAnim, ivec2( x + 2, line ), 0 );
  return mat4( r0.x, r1.x, r2.x, 0.0, r0.y, r1.y, r2.y, 0.0, r0.z, r1.z, r2.z, 0.0, r0.w, r1.w, r2.w, 1.0 );
}
// Two frame lines of a clip and the blend between them.
void bakedFrames( vec4 c, bool loop, out int l0, out int l1, out float f ) {
  float n = max( c.y, 1.0 );
  float p = loop ? fract( c.z ) * n : clamp( c.z, 0.0, 1.0 ) * ( n - 1.0 );
  float i0 = floor( p );
  f = p - i0;
  float i1 = loop ? mod( i0 + 1.0, n ) : min( i0 + 1.0, n - 1.0 );
  l0 = int( c.x + i0 );
  l1 = int( c.x + i1 );
}
mat4 bakedSkin() {
  int a0; int a1; float af;
  bakedFrames( iClipA, iClipA.w > 0.5, a0, a1, af );
  float wb = iClipB.w;
  int b0 = 0; int b1 = 0; float bf = 0.0;
  if ( wb > 0.001 ) bakedFrames( vec4( iClipB.xyz, 0.0 ), iGore.y < 0.5, b0, b1, bf );
  mat4 m = mat4( 0.0 );
  for ( int k = 0; k < 4; k++ ) {
    float w = aWeight[ k ];
    if ( w < 0.002 ) continue;
    float j = aJoint[ k ];
    mat4 bm = bakedBone( a0, j ) * ( 1.0 - af ) + bakedBone( a1, j ) * af;
    if ( wb > 0.001 ) bm = bm * ( 1.0 - wb ) + ( bakedBone( b0, j ) * ( 1.0 - bf ) + bakedBone( b1, j ) * bf ) * wb;
    m += bm * w;
  }
  return m;
}
`;

const SKIN = /* glsl */ `
#ifndef BAKED_SKIN
#define BAKED_SKIN
mat4 bSkin = bakedSkin();
// A part that is gone (or hung from one that is) folds to the joint it hung from.
bool bGone = ( int( iGore.x + 0.5 ) & int( aPart + 0.5 ) ) != 0;
#endif
`;

const NORMAL = /* glsl */ `
${SKIN}
vec3 objectNormal = normalize( mat3( bSkin ) * normal );
#ifdef USE_TANGENT
  vec3 objectTangent = vec3( tangent.xyz );
#endif
`;

const BEGIN = /* glsl */ `
${SKIN}
vec3 transformed = ( bSkin * vec4( position, 1.0 ) ).xyz;
if ( bGone ) transformed = ( bSkin * vec4( aPivot, 1.0 ) ).xyz;
`;

function patch(shader: THREE.WebGLProgramParametersWithUniforms, uniforms: Record<string, THREE.IUniform>) {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
    .replace('#include <beginnormal_vertex>', NORMAL)
    .replace('#include <begin_vertex>', BEGIN);
}

export interface HerdOpts {
  /** Most instances at once. */
  max: number;
  /** A colour map for the model (sRGB), or none for vertex colours alone. */
  map?: THREE.Texture | null;
  side?: THREE.Side;
  roughness?: number;
  castShadow?: boolean;
}

/**
 * One baked model drawn instanced. Fill it each frame with `begin`, `set` per instance and `end`.
 */
export class HerdMesh {
  readonly mesh: THREE.InstancedMesh;
  readonly data: BakedModelData;
  private clipA: Float32Array;
  private clipB: Float32Array;
  private gore: Float32Array;
  private aA: THREE.InstancedBufferAttribute;
  private aB: THREE.InstancedBufferAttribute;
  private aG: THREE.InstancedBufferAttribute;
  private max: number;
  count = 0;

  constructor(data: BakedModelData, anim: THREE.DataTexture, o: HerdOpts) {
    this.data = data;
    this.max = o.max;
    const geo = bakedGeometry(data);
    this.clipA = new Float32Array(o.max * 4);
    this.clipB = new Float32Array(o.max * 4);
    this.gore = new Float32Array(o.max * 2);
    this.aA = new THREE.InstancedBufferAttribute(this.clipA, 4).setUsage(THREE.DynamicDrawUsage);
    this.aB = new THREE.InstancedBufferAttribute(this.clipB, 4).setUsage(THREE.DynamicDrawUsage);
    this.aG = new THREE.InstancedBufferAttribute(this.gore, 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iClipA', this.aA);
    geo.setAttribute('iClipB', this.aB);
    geo.setAttribute('iGore', this.aG);
    const uniforms = { tAnim: { value: anim } };
    const mat = new THREE.MeshStandardMaterial({
      map: o.map ?? null,
      vertexColors: true,
      roughness: o.roughness ?? data.material.roughness ?? 0.85,
      metalness: data.material.metalness ?? 0,
      side: o.side ?? THREE.FrontSide,
    });
    mat.onBeforeCompile = (s) => patch(s, uniforms);
    mat.customProgramCacheKey = () => 'baked';
    this.mesh = new THREE.InstancedMesh(geo, mat, o.max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.castShadow = o.castShadow ?? true;
    this.mesh.receiveShadow = true;
    // Shadows animate with the body.
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    depth.onBeforeCompile = (s) => patch(s, uniforms);
    depth.customProgramCacheKey = () => 'bakedDepth';
    const dist = new THREE.MeshDistanceMaterial();
    dist.onBeforeCompile = (s) => patch(s, uniforms);
    dist.customProgramCacheKey = () => 'bakedDist';
    this.mesh.customDepthMaterial = depth;
    this.mesh.customDistanceMaterial = dist;
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
  }

  clip(role: string): ClipInfo | null {
    return this.data.clips[role] ?? null;
  }

  begin() {
    this.count = 0;
  }

  /**
   * One instance: its world matrix, clip A at `pa` (0..1 of the clip; looping clips wrap), clip B at `pb` with weight `wb`,
   * the mask of parts gone and a tint. A non-looping clip holds its last frame at a phase of 1.
   */
  set(matrix: THREE.Matrix4, a: ClipInfo, pa: number, b: ClipInfo | null, pb: number, wb: number, mask: number, tint: THREE.Color): number {
    if (this.count >= this.max) return -1;
    const i = this.count++;
    this.mesh.setMatrixAt(i, matrix);
    this.mesh.setColorAt(i, tint);
    const A = this.clipA;
    A[i * 4] = a.start;
    A[i * 4 + 1] = a.frames;
    A[i * 4 + 2] = pa;
    A[i * 4 + 3] = a.loop ? 1 : 0;
    const B = this.clipB;
    if (b && wb > 0.001) {
      B[i * 4] = b.start;
      B[i * 4 + 1] = b.frames;
      B[i * 4 + 2] = pb;
      B[i * 4 + 3] = wb;
    } else B[i * 4 + 3] = 0;
    this.gore[i * 2] = mask;
    this.gore[i * 2 + 1] = b && !b.loop ? 1 : 0;
    return i;
  }

  end() {
    const n = this.count;
    this.mesh.count = n;
    const upload = (attr: THREE.BufferAttribute, item: number) => {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * item);
      attr.needsUpdate = true;
    };
    upload(this.mesh.instanceMatrix, 16);
    if (this.mesh.instanceColor) upload(this.mesh.instanceColor, 3);
    upload(this.aA, 4);
    upload(this.aB, 4);
    upload(this.aG, 2);
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.customDepthMaterial?.dispose();
    this.mesh.customDistanceMaterial?.dispose();
    this.mesh.dispose();
  }
}

// ------------------------------------------------------------------------------------------ loading

export interface LoadedModel {
  data: BakedModelData;
  anim: THREE.DataTexture;
  map: THREE.Texture | null;
}

const models = new Map<string, LoadedModel>();

export function bakedModel(name: string): LoadedModel | null {
  return models.get(name) ?? null;
}

/** Tests and tools: register a model from bytes. */
export function registerBakedModel(name: string, buf: ArrayBuffer, map: THREE.Texture | null = null): LoadedModel {
  const data = parseBakedModel(buf);
  const m = { data, anim: animTexture(data), map };
  models.set(name, m);
  return m;
}

async function loadImageTexture(url: string): Promise<THREE.Texture> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const t = new THREE.Texture(bmp);
  t.flipY = false;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return shared(t);
}

/** Fetch and parse every listed model and its texture. A model that fails stays procedural. */
export async function loadBakedModels(names: readonly string[]): Promise<void> {
  if (typeof fetch === 'undefined' || typeof createImageBitmap === 'undefined') return;
  const base = `${import.meta.env.BASE_URL}models/`;
  await Promise.all(names.map(async (name) => {
    try {
      const res = await fetch(`${base}${name}.bin`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const data = parseBakedModel(buf);
      const map = data.texture ? await loadImageTexture(`${base}${data.texture}`) : null;
      models.set(name, { data, anim: animTexture(data), map });
    } catch (e) {
      console.warn(`Model ${name} unavailable`, e);
    }
  }));
}
