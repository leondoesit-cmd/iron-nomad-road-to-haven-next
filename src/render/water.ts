import * as THREE from 'three';
import { fbm } from './proctex';
import { GLOBALS } from './materials';
import { lakeColors, lakeWater, type Lake, type WaterStyle } from '../world/lakes';
import { heightAt, type TerrainDef } from '../world/terrain';
import { swampQ, type Spring, type Swamp } from '../world/hydro';

/**
 * Standing water: lakes, swamps and spring pools. One flat sheet per body of water at its level, lit by the same PBR
 * pipeline as everything else, so it reflects the sky the player sees, throws back the sun and fades into the haze. A
 * small depth texture (metres of water over the floor) drives the colour, the transparency and the foam at the shore, so
 * the waterline is exact whatever the resolution of the terrain mesh underneath. Spring pools are small enough to carry
 * their depth per vertex instead, which lets every pool of the map share one mesh.
 *
 * Running water (rivers, streams and their falls) is `riverWater.ts`; it shares the textures and the blending trick here.
 */

const DEPTH_RES = 256;
const MAX_DEPTH = 8;

let normalTex: THREE.DataTexture | null = null;
let noiseTex: THREE.DataTexture | null = null;

/** Tileable ripple normals: slopes in RG, so a normal is (r*2-1, 1, g*2-1) before scaling. */
export function waterNormalTexture(): THREE.DataTexture {
  if (normalTex) return normalTex;
  const S = 256;
  const a = fbm(S, 5, { octaves: 5, seed: 31 });
  const b = fbm(S, 13, { octaves: 3, seed: 32 });
  const h = new Float32Array(S * S);
  for (let i = 0; i < h.length; i++) h[i] = a[i] * 0.6 + b[i] * 0.4;
  const out = new Uint8Array(S * S * 4);
  const at = (x: number, y: number) => h[((y + S) % S) * S + ((x + S) % S)];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const nx = (at(x - 1, y) - at(x + 1, y)) * 16;
      const ny = (at(x, y - 1) - at(x, y + 1)) * 16;
      const i = (y * S + x) * 4;
      out[i] = Math.round(Math.min(1, Math.max(0, 0.5 + nx * 0.5)) * 255);
      out[i + 1] = Math.round(Math.min(1, Math.max(0, 0.5 + ny * 0.5)) * 255);
      out[i + 2] = 255;
      out[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(out, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.userData.shared = true;
  t.needsUpdate = true;
  normalTex = t;
  return t;
}

/**
 * Tileable noise for foam, scum, bubbles and the streaks of falling water: three unrelated fields in R, G and B (the last
 * finer). A texture rather than hash noise in the shader because it repeats exactly, so scrolling coordinates can wrap.
 */
export function waterNoiseTexture(): THREE.DataTexture {
  if (noiseTex) return noiseTex;
  const S = 128;
  const a = fbm(S, 8, { octaves: 4, seed: 41 });
  const b = fbm(S, 8, { octaves: 4, seed: 42 });
  const c = fbm(S, 16, { octaves: 3, seed: 43 });
  const out = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    out[i * 4] = Math.round(a[i] * 255);
    out[i * 4 + 1] = Math.round(b[i] * 255);
    out[i * 4 + 2] = Math.round(c[i] * 255);
    out[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(out, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.userData.shared = true;
  t.needsUpdate = true;
  noiseTex = t;
  return t;
}

/** Half the side of the square that covers a lake's waterline. */
export function lakeHalfSize(l: Lake) {
  return l.r * 1.3 * Math.max(l.ax, 1 / l.ax) + 3;
}

/**
 * Depth rasters by the lake or swamp they were taken for. The leg scene is built again every dawn on the same terrain, and a
 * swamp's raster (a quarter of a million ground heights) is worth keeping.
 */
const depthCache = new WeakMap<object, Uint8Array>();

function depthTexture(x0: number, z0: number, half: number, res: number, maxDepth: number, depthAt: (x: number, z: number) => number, key?: object): THREE.DataTexture {
  const N = res;
  let data = key && depthCache.get(key);
  if (!data || data.length !== N * N) {
    data = new Uint8Array(N * N);
    const step = (half * 2) / N;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const d = depthAt(x0 - half + (i + 0.5) * step, z0 - half + (j + 0.5) * step);
        data[j * N + i] = d > 0 ? Math.round(Math.min(1, d / maxDepth) * 255) : 0;
      }
    }
    if (key) depthCache.set(key, data);
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

/**
 * Water writes its colour with ordinary alpha blending but alpha itself as 0, the "mirror" code the screen-space reflections
 * read (see gloss.ts). It also writes depth, so the reflection pass finds the surface and not the bed below it.
 */
export function mirrorWaterMaterial(rough = 0.05): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: rough,
    metalness: 0,
    transparent: true,
    depthWrite: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.ZeroFactor,
  });
}

const VERT_PARS = /* glsl */ `
varying vec3 vWWorld;
#ifdef W_VDEPTH
attribute vec4 aPool;
varying vec4 vPool;
#endif
`;
const VERT_MAIN = /* glsl */ `
vWWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
#ifdef W_VDEPTH
vPool = aPool;
#endif
`;

const FRAG_PARS = /* glsl */ `
varying vec3 vWWorld;
#ifdef W_VDEPTH
varying vec4 vPool;
#endif
uniform sampler2D tWDepth;
uniform sampler2D tWNorm;
uniform sampler2D tWNoise;
uniform vec4 uWBox;
uniform vec3 cWShallow;
uniform vec3 cWDeep;
uniform vec3 cWFoam;
uniform vec3 cWScum;
uniform float uWTime;
float wHash( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float wNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( wHash( i ), wHash( i + vec2( 1.0, 0.0 ) ), f.x ), mix( wHash( i + vec2( 0.0, 1.0 ) ), wHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
`;

const FRAG_LAKE = /* glsl */ `
vec2 wn1 = texture2D( tWNorm, wp * 0.11 + vec2( wT * 0.012, wT * 0.007 ) ).xy * 2.0 - 1.0;
vec2 wn2 = texture2D( tWNorm, wp * 0.27 + vec2( -wT * 0.02, wT * 0.015 ) ).xy * 2.0 - 1.0;
vec2 wn3 = texture2D( tWNorm, wp * 0.7 + vec2( wT * 0.03, -wT * 0.025 ) ).xy * 2.0 - 1.0;
// The shallows are calmer than the open water.
float wCalm = 1.0 - 0.55 * ( 1.0 - smoothstep( 0.0, 1.4, wD ) );
vec2 wn = ( wn1 * 0.55 + wn2 * 0.38 + wn3 * 0.22 ) * wCalm * 0.35;
// Slow swell on top of the ripples.
wn += vec2( cos( wp.x * 0.09 + wp.y * 0.05 + wT * 0.7 ) * 0.05 + cos( wp.x * 0.04 - wp.y * 0.08 + wT * 0.5 ) * 0.04, cos( wp.y * 0.07 - wp.x * 0.03 + wT * 0.6 ) * 0.05 ) * wCalm;
vec3 wNw = normalize( vec3( wn.x, 1.0, wn.y ) );
float wDeep = smoothstep( 0.15, 4.2, wD );
vec3 wCol = mix( cWShallow, cWDeep, wDeep );
// Light shimmering over the shallows.
float wC = wNoise( wp * 0.9 + wT * vec2( 0.3, 0.2 ) ) * wNoise( wp * 1.3 - wT * vec2( 0.2, 0.3 ) );
wCol *= 1.0 + wC * 0.6 * ( 1.0 - wDeep );
// Foam where the water meets the shore.
float wFoamN = wNoise( wp * 1.7 + vec2( wT * 0.15, 0.0 ) );
float wFoam = smoothstep( 0.45, 0.0, wD + ( wFoamN - 0.5 ) * 0.3 ) * ( 0.55 + 0.45 * sin( wT * 1.7 + wD * 11.0 ) );
wFoam = clamp( wFoam, 0.0, 1.0 );
wCol = mix( wCol, cWFoam, wFoam * 0.9 );
float wA = mix( 0.3, 0.97, smoothstep( 0.05, 3.4, wD ) ) * smoothstep( 0.02, 0.16, wD );
wA = max( wA, wFoam * 0.92 );
float wRough = mix( 0.05, 0.5, wFoam );
`;

const FRAG_SWAMP = /* glsl */ `
// Still, dark water: the faintest stir of ripples, and rafts of scum and duckweed thickest in the shallows.
vec2 wn1 = texture2D( tWNorm, wp * 0.09 + vec2( wT * 0.004, wT * 0.003 ) ).xy * 2.0 - 1.0;
vec2 wn2 = texture2D( tWNorm, wp * 0.33 + vec2( -wT * 0.006, wT * 0.005 ) ).xy * 2.0 - 1.0;
vec4 wNa = texture2D( tWNoise, wp * 0.019 );
vec4 wNb = texture2D( tWNoise, wp * 0.071 + 0.37 );
float wShal = 1.0 - smoothstep( 0.08, 0.9, wD );
float wFine = texture2D( tWNoise, wp * 0.43 ).b;
float wScum = smoothstep( 0.58, 0.64, wNa.r * 0.7 + wNb.g * 0.3 + wShal * 0.07 + ( wFine - 0.5 ) * 0.05 );
// Loose duckweed drifting off the edges of the rafts.
float wSpeck = smoothstep( 0.56, 0.7, wFine ) * smoothstep( 0.48, 0.58, wNa.r * 0.7 + wNb.g * 0.3 ) * ( 1.0 - wScum ) * 0.7;
float wCover = max( wScum, wSpeck );
vec2 wn = ( wn1 * 0.6 + wn2 * 0.4 ) * 0.1 * ( 1.0 - wCover );
vec3 wNw = normalize( vec3( wn.x, 1.0, wn.y ) );
float wDeep = smoothstep( 0.05, 1.3, wD );
vec3 wCol = mix( cWShallow, cWDeep, wDeep );
wCol = mix( wCol, cWScum * ( 0.55 + 0.45 * wNb.r + 0.4 * wFine ), wCover );
float wFoam = 0.0;
float wA = mix( 0.6, 0.97, smoothstep( 0.02, 0.7, wD ) ) * smoothstep( 0.02, 0.1, wD );
wA = max( wA, wCover * smoothstep( 0.02, 0.05, wD ) );
float wRough = mix( 0.1, 0.75, wCover );
`;

const FRAG_SPRING = /* glsl */ `
// Clear water over a pale bowl. The source boils up in the middle and sends rings out across the pool.
vec2 wn1 = texture2D( tWNorm, wp * 0.15 + vec2( wT * 0.01, wT * 0.008 ) ).xy * 2.0 - 1.0;
vec2 wn2 = texture2D( tWNorm, wp * 0.41 + vec2( -wT * 0.017, wT * 0.012 ) ).xy * 2.0 - 1.0;
vec2 wn = ( wn1 * 0.6 + wn2 * 0.4 ) * 0.16;
float wDist = length( vPool.yz );
float wR = wDist / vPool.w;
float wBoil = 1.0 - smoothstep( 0.0, 0.6, wR );
vec2 wOut = vPool.yz / max( 0.001, wDist );
wn += wOut * sin( wDist * 4.5 - wT * 3.1 ) * 0.14 * wBoil;
// Bubbles breaking over the vent.
float wBub = texture2D( tWNoise, wp * 0.8 + vec2( 0.0, wT * 0.31 ) ).b * texture2D( tWNoise, wp * 1.21 - vec2( wT * 0.23, 0.0 ) ).r;
float wFoam = smoothstep( 0.3, 0.46, wBub ) * ( 1.0 - smoothstep( 0.05, 0.28, wR ) ) * 0.85;
wFoam = max( wFoam, smoothstep( 0.22, 0.0, wD ) * 0.35 );
vec3 wNw = normalize( vec3( wn.x, 1.0, wn.y ) );
float wDeep = smoothstep( 0.2, 2.4, wD );
vec3 wCol = mix( cWShallow, cWDeep, wDeep );
float wC = wNoise( wp * 1.1 + wT * vec2( 0.3, 0.2 ) ) * wNoise( wp * 1.6 - wT * vec2( 0.2, 0.3 ) );
wCol *= 1.0 + wC * 0.7 * ( 1.0 - wDeep );
wCol = mix( wCol, cWFoam, wFoam );
float wA = mix( 0.12, 0.74, smoothstep( 0.1, 2.6, wD ) ) * smoothstep( 0.02, 0.12, wD );
wA = max( wA, wFoam * 0.9 );
float wRough = mix( 0.04, 0.4, wFoam );
`;

function fragColor(kind: FlatKind) {
  const body = kind === 'swamp' ? FRAG_SWAMP : kind === 'spring' ? FRAG_SPRING : FRAG_LAKE;
  return /* glsl */ `
#ifdef W_VDEPTH
float wD = vPool.x;
#else
vec2 wUv = ( vWWorld.xz - uWBox.xy ) / uWBox.z;
float wD = texture2D( tWDepth, wUv ).r * uWBox.w;
#endif
if ( wD < 0.02 ) discard;
vec2 wp = vWWorld.xz;
float wT = uWTime;
${body}
diffuseColor = vec4( wCol, wA );
`;
}

const FRAG_ROUGH = /* glsl */ `
float roughnessFactor = wRough;
`;

const FRAG_NORMAL = /* glsl */ `
normal = normalize( ( viewMatrix * vec4( wNw, 0.0 ) ).xyz );
`;

export type FlatKind = 'lake' | 'swamp' | 'spring';

const SCUM = 0x4a5226;

/** The flat-water material: `kind` picks the surface, `vdepth` reads the depth from an `aPool` attribute (x) instead of a texture. */
function flatMaterial(kind: FlatKind, style: WaterStyle, box: THREE.Vector4, depth: THREE.Texture | null, vdepth: boolean): THREE.MeshStandardMaterial {
  const mat = mirrorWaterMaterial();
  const col = lakeColors(style);
  const uniforms = {
    tWDepth: { value: depth },
    tWNorm: { value: waterNormalTexture() },
    tWNoise: { value: waterNoiseTexture() },
    uWBox: { value: box },
    cWShallow: { value: new THREE.Color(col.shallow) },
    cWDeep: { value: new THREE.Color(col.deep) },
    cWFoam: { value: new THREE.Color(col.foam) },
    cWScum: { value: new THREE.Color(SCUM) },
    uWTime: GLOBALS.uTime,
  };
  if (vdepth) mat.defines = { W_VDEPTH: '' };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <project_vertex>', `${VERT_MAIN}\n#include <project_vertex>`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <color_fragment>', fragColor(kind))
      .replace('#include <roughnessmap_fragment>', FRAG_ROUGH)
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL);
  };
  mat.customProgramCacheKey = () => `flatWater:${kind}:${vdepth}`;
  return mat;
}

export interface WaterSheet {
  mesh: THREE.Mesh;
  dispose(): void;
}
/** The old name: a lake's sheet is a flat water sheet like any other. */
export type LakeWater = WaterSheet;

export interface FlatWaterOpts {
  /** Centre and half the side of the square the sheet covers. */
  x: number;
  z: number;
  half: number;
  level: number;
  style: WaterStyle;
  kind?: FlatKind;
  /** Metres of water over the floor at a point (0 or less on dry ground). */
  depthAt: (x: number, z: number) => number;
  /** Depth texture resolution, and the depth that maps to its top value. */
  res?: number;
  maxDepth?: number;
  /** The body of water the sheet is for: its depth raster is kept for the next sheet built for it. */
  key?: object;
}

/** One flat sheet of standing water with a depth texture. */
export function buildFlatWater(o: FlatWaterOpts): WaterSheet {
  const half = o.half;
  const maxDepth = o.maxDepth ?? MAX_DEPTH;
  const geo = new THREE.PlaneGeometry(half * 2, half * 2, 8, 8);
  geo.rotateX(-Math.PI / 2);
  const depth = depthTexture(o.x, o.z, half, o.res ?? DEPTH_RES, maxDepth, o.depthAt, o.key);
  const mat = flatMaterial(o.kind ?? 'lake', o.style, new THREE.Vector4(o.x - half, o.z - half, half * 2, maxDepth), depth, false);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(o.x, o.level, o.z);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  // Standing water draws first of everything see-through; running water, which sinks under it where they meet, comes next.
  mesh.renderOrder = -2;
  return {
    mesh,
    dispose() {
      geo.dispose();
      mat.dispose();
      depth.dispose();
      mesh.removeFromParent();
    },
  };
}

/** The water sheet for one lake. */
export function buildLakeWater(l: Lake): WaterSheet {
  return buildFlatWater({ x: l.x, z: l.z, half: lakeHalfSize(l), level: l.level, style: l.style, depthAt: (x, z) => lakeWater([l], x, z)?.depth ?? 0, key: l });
}

/** Half the side of the square that covers a swamp's water (its outline wobbles up to a quarter past `r`, stretched by `ax`). */
export function swampHalfSize(s: Swamp) {
  return s.r * 1.32 * Math.max(s.ax, 1 / s.ax) + 4;
}

/** A swamp's open water: shallow pools between the hummocks, one sheet at its level. */
export function buildSwampWater(def: TerrainDef, s: Swamp): WaterSheet {
  const half = swampHalfSize(s);
  const w = buildFlatWater({
    x: s.x,
    z: s.z,
    half,
    level: s.level,
    style: 'swamp',
    kind: 'swamp',
    // Pools a metre or two deep at most: a finer step of depth, and texels about a metre across for the hummocks.
    res: 512,
    maxDepth: 3,
    depthAt: (x, z) => (swampQ(s, x, z) < 1.08 ? s.level - heightAt(def, x, z) : 0),
    key: s,
  });
  // A swamp is small beside the map: let the views that cannot see it skip it.
  w.mesh.frustumCulled = true;
  w.mesh.geometry.computeBoundingSphere();
  return w;
}

/**
 * Every spring pool of the map in one mesh: a disc per pool at its level, its depth (level minus the ground) per vertex in
 * `aPool.x`, and the offset from the vent and the pool's radius in `aPool.yzw` for the rings.
 */
export function springGeometry(def: TerrainDef, springs: Spring[]): THREE.BufferGeometry | null {
  if (!springs.length) return null;
  const RINGS = 9;
  const SEG = 32;
  const pos: number[] = [];
  const pool: number[] = [];
  const idx: number[] = [];
  for (const sp of springs) {
    const R = sp.r + 1.2;
    const b = pos.length / 3;
    pos.push(sp.x, sp.level, sp.z);
    pool.push(sp.level - heightAt(def, sp.x, sp.z), 0, 0, sp.r);
    for (let k = 1; k <= RINGS; k++) {
      // Rings crowd toward the waterline, where the depth changes fastest.
      const rr = R * Math.sqrt(k / RINGS) * (0.55 + 0.45 * (k / RINGS));
      for (let a = 0; a < SEG; a++) {
        const th = (a / SEG) * Math.PI * 2;
        const dx = Math.cos(th) * rr;
        const dz = Math.sin(th) * rr;
        pos.push(sp.x + dx, sp.level, sp.z + dz);
        pool.push(sp.level - heightAt(def, sp.x + dx, sp.z + dz), dx, dz, sp.r);
      }
    }
    for (let a = 0; a < SEG; a++) idx.push(b, b + 1 + ((a + 1) % SEG), b + 1 + a);
    for (let k = 1; k < RINGS; k++) {
      const r0 = b + 1 + (k - 1) * SEG;
      const r1 = b + 1 + k * SEG;
      for (let a = 0; a < SEG; a++) {
        const a1 = (a + 1) % SEG;
        idx.push(r0 + a, r0 + a1, r1 + a, r0 + a1, r1 + a1, r1 + a);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const nrm = new Float32Array(pos.length);
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('aPool', new THREE.Float32BufferAttribute(pool, 4));
  g.setIndex(idx);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** All the spring pools of the map: one draw call. */
export function buildSpringWater(def: TerrainDef, springs: Spring[]): WaterSheet | null {
  const geo = springGeometry(def, springs);
  if (!geo) return null;
  const mat = flatMaterial('spring', 'spring', new THREE.Vector4(0, 0, 1, 1), null, true);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.renderOrder = -2;
  return {
    mesh,
    dispose() {
      geo.dispose();
      mat.dispose();
      mesh.removeFromParent();
    },
  };
}
