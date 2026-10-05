import * as THREE from 'three';
import { fbm } from './proctex';
import { GLOBALS } from './materials';
import { lakeColors, lakeWater, type Lake } from '../world/lakes';

/**
 * Lake water. One flat sheet per lake at the lake's level, lit by the same PBR pipeline as everything else, so it
 * reflects the sky the player sees, throws back the sun and fades into the haze. A small depth texture (metres of
 * water over the floor) drives the colour, the transparency and the foam at the shore, so the waterline is exact
 * whatever the resolution of the terrain mesh underneath.
 */

const DEPTH_RES = 256;
const MAX_DEPTH = 8;

let normalTex: THREE.DataTexture | null = null;

/** Tileable ripple normals: slopes in RG, so a normal is (r*2-1, 1, g*2-1) before scaling. */
function waterNormalTexture(): THREE.DataTexture {
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

/** Half the side of the square that covers a lake's waterline. */
export function lakeHalfSize(l: Lake) {
  return l.r * 1.3 * Math.max(l.ax, 1 / l.ax) + 3;
}

function depthTexture(l: Lake, half: number): THREE.DataTexture {
  const N = DEPTH_RES;
  const data = new Uint8Array(N * N);
  const step = (half * 2) / N;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = l.x - half + (i + 0.5) * step;
      const z = l.z - half + (j + 0.5) * step;
      const w = lakeWater([l], x, z);
      data[j * N + i] = w ? Math.round(Math.min(1, w.depth / MAX_DEPTH) * 255) : 0;
    }
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

const VERT_PARS = /* glsl */ `
varying vec3 vWWorld;
`;
const VERT_MAIN = /* glsl */ `
vWWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;

const FRAG_PARS = /* glsl */ `
varying vec3 vWWorld;
uniform sampler2D tWDepth;
uniform sampler2D tWNorm;
uniform vec4 uWBox;
uniform vec3 cWShallow;
uniform vec3 cWDeep;
uniform vec3 cWFoam;
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

const FRAG_COLOR = /* glsl */ `
vec2 wUv = ( vWWorld.xz - uWBox.xy ) / uWBox.z;
float wD = texture2D( tWDepth, wUv ).r * uWBox.w;
if ( wD < 0.02 ) discard;
vec2 wp = vWWorld.xz;
float wT = uWTime;
vec2 wn1 = texture2D( tWNorm, wp * 0.11 + vec2( wT * 0.012, wT * 0.007 ) ).xy * 2.0 - 1.0;
vec2 wn2 = texture2D( tWNorm, wp * 0.27 + vec2( -wT * 0.02, wT * 0.015 ) ).xy * 2.0 - 1.0;
vec2 wn3 = texture2D( tWNorm, wp * 0.7 + vec2( wT * 0.03, -wT * 0.025 ) ).xy * 2.0 - 1.0;
// The shallows are calmer than the open water.
float wCalm = 1.0 - 0.55 * ( 1.0 - smoothstep( 0.0, 1.4, wD ) );
// Far off, and seen at a glancing angle, the ripples are finer than a pixel: each one would flip the mirror between the sky
// and the ground and the water would show stripes. They calm down with distance and toward the horizon, as a real lake
// does to the eye.
vec3 wV = normalize( cameraPosition - vWWorld );
float wGlance = smoothstep( 0.015, 0.3, abs( wV.y ) );
float wFine = ( 1.0 - 0.75 * smoothstep( 5.0, 40.0, length( vViewPosition ) ) ) * mix( 0.2, 1.0, wGlance );
vec2 wn = ( wn1 * 0.55 + wn2 * 0.38 + wn3 * 0.22 ) * wCalm * 0.35 * wFine;
// Slow swell on top of the ripples.
wn += vec2( cos( wp.x * 0.09 + wp.y * 0.05 + wT * 0.7 ) * 0.05 + cos( wp.x * 0.04 - wp.y * 0.08 + wT * 0.5 ) * 0.04, cos( wp.y * 0.07 - wp.x * 0.03 + wT * 0.6 ) * 0.05 ) * wCalm * mix( 0.4, 1.0, wGlance );
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
diffuseColor = vec4( wCol, wA );
`;

const FRAG_ROUGH = /* glsl */ `
// Where the surface still turns faster than a pixel can show, blur the reflection instead of letting it sparkle and band.
float roughnessFactor = max( mix( 0.05, 0.5, wFoam ), clamp( length( fwidth( wNw ) ) * 2.5, 0.0, 0.35 ) );
`;

const FRAG_NORMAL = /* glsl */ `
normal = normalize( ( viewMatrix * vec4( wNw, 0.0 ) ).xyz );
`;

export interface LakeWater {
  mesh: THREE.Mesh;
  dispose(): void;
}

/** The water sheet for one lake. */
export function buildLakeWater(l: Lake): LakeWater {
  const half = lakeHalfSize(l);
  const geo = new THREE.PlaneGeometry(half * 2, half * 2, 8, 8);
  geo.rotateX(-Math.PI / 2);
  const depth = depthTexture(l, half);
  const col = lakeColors(l.style);
  // Normal alpha blending for the colour, but alpha itself is written as 0, the "mirror" code the screen-space reflections read
  // (see gloss.ts). The sheet also writes depth, so the reflection pass finds the surface and not the lake bed below it.
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.05,
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
  const uniforms = {
    tWDepth: { value: depth },
    tWNorm: { value: waterNormalTexture() },
    uWBox: { value: new THREE.Vector4(l.x - half, l.z - half, half * 2, MAX_DEPTH) },
    cWShallow: { value: new THREE.Color(col.shallow) },
    cWDeep: { value: new THREE.Color(col.deep) },
    cWFoam: { value: new THREE.Color(col.foam) },
    uWTime: GLOBALS.uTime,
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <project_vertex>', `${VERT_MAIN}\n#include <project_vertex>`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <color_fragment>', FRAG_COLOR)
      .replace('#include <roughnessmap_fragment>', FRAG_ROUGH)
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL);
  };
  mat.customProgramCacheKey = () => 'lakeWater';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(l.x, l.level, l.z);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
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
