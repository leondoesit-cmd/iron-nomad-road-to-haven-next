import * as THREE from 'three';
import { shared } from './dispose';
import { detailNormalTexture, grungeTexture } from './proctex';

/** Uniforms every animated material shares (wind sway, flicker). */
export const GLOBALS = {
  uTime: { value: 0 },
  /** Approximate scene light for unlit-shaded effects (smoke and dust particles). */
  uLight: { value: new THREE.Color(1, 1, 1) },
  /** How wet the ground is, 0 bone dry to 1 soaked: darkens it, takes the roughness off and fills puddles. */
  uWet: { value: 0 },
};

/** Shared by the ground shaders: puddles that fill the low spots as the ground gets wetter. Needs `uWet` and a fragment `common` include. */
export const WET_PARS = /* glsl */ `
uniform float uWet;
float wpHash( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float wpNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( wpHash( i ), wpHash( i + vec2( 1.0, 0.0 ) ), f.x ), mix( wpHash( i + vec2( 0.0, 1.0 ) ), wpHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
// 1 inside a puddle. The basins are fixed in the world, so a puddle fills from its deepest point outward as uWet rises.
float puddleMask( vec2 xz, float level ) {
  float n = wpNoise( xz * 0.16 ) * 0.55 + wpNoise( xz * 0.43 + 7.3 ) * 0.3 + wpNoise( xz * 1.3 ) * 0.15;
  float thr = uWet * 0.6;
  return ( 1.0 - smoothstep( thr - 0.06, thr, n ) ) * level;
}
`;

/**
 * The "kit" material: one physically based material for every model the MeshBuilder makes.
 * Per-vertex attributes carry the surface (roughness, metalness, wear, emissive), so a whole vehicle or
 * a chunk of props stays one draw call. Wear adds grime, rust and streaks from a triplanar map in object
 * space, and a detail normal map adds dents and casting texture, so there are no UVs to author.
 */
export const KIT = {
  tGrunge: { value: null as THREE.Texture | null },
  tDetail: { value: null as THREE.Texture | null },
  /** x: grime projection (1/m), y: detail projection (1/m), z: wear multiplier, w: detail normal strength. */
  uKit: { value: new THREE.Vector4(1.25, 2.4, 1, 0.45) },
  /** Multiplier for per-vertex emissive (lit windows, lamps). Raised at night. */
  uGlow: { value: 1 },
};

const KIT_VERT_PARS = /* glsl */ `
attribute vec4 surf;
varying vec4 vSurf;
varying vec3 vKitPos;
varying vec3 vKitNrm;
varying vec3 vKitM0;
varying vec3 vKitM1;
varying vec3 vKitM2;
`;

const KIT_VERT_MAIN = /* glsl */ `
vSurf = surf;
vKitPos = transformed;
vKitNrm = objectNormal;
{
  mat3 kitNM = normalMatrix;
  #ifdef USE_INSTANCING
    kitNM = normalMatrix * mat3( instanceMatrix );
  #endif
  vKitM0 = kitNM[ 0 ];
  vKitM1 = kitNM[ 1 ];
  vKitM2 = kitNM[ 2 ];
}
`;

const KIT_FRAG_PARS = /* glsl */ `
varying vec4 vSurf;
varying vec3 vKitPos;
varying vec3 vKitNrm;
varying vec3 vKitM0;
varying vec3 vKitM1;
varying vec3 vKitM2;
uniform sampler2D tGrunge;
uniform sampler2D tDetail;
uniform vec4 uKit;
uniform float uGlow;
vec4 kitTri( sampler2D t, vec3 p, vec3 w ) {
  return texture2D( t, p.zy ) * w.x + texture2D( t, p.xz ) * w.y + texture2D( t, p.xy ) * w.z;
}
`;

const KIT_COLOR = /* glsl */ `
#include <color_fragment>
vec3 kitW = abs( normalize( vKitNrm ) );
kitW = kitW * kitW * kitW * kitW;
kitW /= dot( kitW, vec3( 1.0 ) );
vec4 kitG = kitTri( tGrunge, vKitPos * uKit.x, kitW );
float kitWear = clamp( vSurf.z * uKit.z, 0.0, 1.5 );
float kitSide = 1.0 - kitW.y;
float kitDirt = clamp( kitG.r * kitG.g * kitWear * 1.1 + kitG.a * kitSide * kitWear * 0.4, 0.0, 1.0 );
float kitRust = smoothstep( 0.45, 0.85, kitG.b * kitWear ) * step( 0.04, vSurf.y );
vec3 kitDust = vec3( 0.30, 0.25, 0.18 );
diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 0.55 + kitDust * 0.4, kitDirt * 0.8 );
vec3 kitRustCol = mix( vec3( 0.16, 0.055, 0.02 ), vec3( 0.3, 0.11, 0.04 ), kitG.g );
// Rust shows as patches on paint and bare metal; on already-rusted panels it only deepens the tone a little.
float kitAlready = smoothstep( 0.85, 1.0, vSurf.z );
diffuseColor.rgb = mix( diffuseColor.rgb, kitRustCol, kitRust * mix( 0.85, 0.3, kitAlready ) );
diffuseColor.rgb *= 0.9 + kitG.g * 0.2;
`;

const KIT_ROUGH = /* glsl */ `
float roughnessFactor = clamp( vSurf.x + kitDirt * 0.3 + kitRust * 0.45 + ( kitG.g - 0.5 ) * 0.14, 0.04, 1.0 );
`;

const KIT_METAL = /* glsl */ `
float metalnessFactor = clamp( vSurf.y * ( 1.0 - kitRust ) * ( 1.0 - kitDirt * 0.6 ), 0.0, 1.0 );
`;

const KIT_NORMAL = /* glsl */ `
#include <normal_fragment_maps>
#ifdef KIT_DETAIL
{
  vec3 kn = normalize( vKitNrm );
  vec3 kp = vKitPos * uKit.y;
  vec2 tx = texture2D( tDetail, kp.zy ).xy * 2.0 - 1.0;
  vec2 ty = texture2D( tDetail, kp.xz ).xy * 2.0 - 1.0;
  vec2 tz = texture2D( tDetail, kp.xy ).xy * 2.0 - 1.0;
  vec3 kpert = vec3( 0.0, tx.y, tx.x ) * kitW.x + vec3( ty.x, 0.0, ty.y ) * kitW.y + vec3( tz.x, tz.y, 0.0 ) * kitW.z;
  kpert *= uKit.w * ( 0.35 + kitWear * 0.65 + kitRust );
  mat3 kitM = mat3( vKitM0, vKitM1, vKitM2 );
  vec3 kBase = normalize( kitM * kn );
  vec3 kBent = normalize( kitM * normalize( kn + kpert ) );
  normal = normalize( normal + ( kBent - kBase ) );
}
#endif
`;

const KIT_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * vSurf.w * uGlow;
`;

/** Wire the kit shader into a MeshStandardMaterial's shader. Exposed so custom materials (zombies) can compose it. */
export function applyKit(shader: THREE.WebGLProgramParametersWithUniforms, detail: boolean) {
  ensureKitTextures();
  shader.uniforms.tGrunge = KIT.tGrunge;
  shader.uniforms.tDetail = KIT.tDetail;
  shader.uniforms.uKit = KIT.uKit;
  shader.uniforms.uGlow = KIT.uGlow;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${KIT_VERT_PARS}`)
    .replace('#include <project_vertex>', `${KIT_VERT_MAIN}\n#include <project_vertex>`);
  shader.fragmentShader = (detail ? '#define KIT_DETAIL\n' : '') +
    shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${KIT_FRAG_PARS}`)
      .replace('#include <color_fragment>', KIT_COLOR)
      .replace('#include <roughnessmap_fragment>', KIT_ROUGH)
      .replace('#include <metalnessmap_fragment>', KIT_METAL)
      .replace('#include <normal_fragment_maps>', KIT_NORMAL)
      .replace('#include <emissivemap_fragment>', KIT_EMISSIVE);
}

function ensureKitTextures() {
  if (!KIT.tGrunge.value) KIT.tGrunge.value = grungeTexture();
  if (!KIT.tDetail.value) KIT.tDetail.value = detailNormalTexture();
}

export interface KitOpts {
  side?: THREE.Side;
  detail?: boolean;
  transparent?: boolean;
  opacity?: number;
}

const kitCache = new Map<string, THREE.MeshStandardMaterial>();

/** Shared kit material. All variants share the wear textures and uniforms. */
export function kitMaterial(o: KitOpts = {}): THREE.MeshStandardMaterial {
  const detail = o.detail ?? true;
  const key = `${o.side ?? THREE.FrontSide}:${detail}:${o.transparent ? o.opacity ?? 1 : 1}`;
  let m = kitCache.get(key);
  if (m) return m;
  m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, side: o.side ?? THREE.FrontSide });
  if (o.transparent) {
    m.transparent = true;
    m.opacity = o.opacity ?? 1;
    m.depthWrite = false;
  }
  m.onBeforeCompile = (shader) => applyKit(shader, detail);
  m.customProgramCacheKey = () => `kit:${detail}`;
  kitCache.set(key, shared(m));
  return m;
}

/** A plain (non vertex-coloured) PBR material, for one-off meshes. */
export function pbr(color: number, rough = 0.8, metal = 0, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
}

/** Emissive lens for lamps: dark glass when off, glowing when on. HDR emissive so bloom picks it up. */
export function lampMaterials(color = 0xfff1c8, on = 3) {
  return {
    on: shared(new THREE.MeshStandardMaterial({ color: 0x222222, emissive: color, emissiveIntensity: on, roughness: 0.2, metalness: 0 })),
    off: shared(new THREE.MeshStandardMaterial({ color: 0x8c8a80, roughness: 0.15, metalness: 0.1 })),
  };
}
