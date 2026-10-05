import * as THREE from 'three';
import { GLOBALS, WET_PARS } from './materials';
import { macroTexture, meadowTexture, roadTextures, terrainTextures } from './proctex';

/**
 * Ground shading: four detail materials (wind-rippled sand, cracked earth, layered rock, gravel) blended
 * per pixel by per-vertex weights sharpened with the materials' own height maps, so transitions follow
 * cracks and pebbles instead of smearing. Rock is projected triplanar so cliffs show strata, not stretching.
 * Per-vertex `tdata` carries ambient occlusion (x), wetness (y), how lush the land is (z, `lushAt`) and how wooded (w,
 * `forestAt`): lush ground turns to living grass, in drifts of fresh green, olive and yellow-green that dry to straw at the
 * edge of the green and fray into the dust along the grass's own height; under the woods it is a darker floor of leaf
 * litter and moss. Rock stays rock, gravel shoulders and tracks stay worn, dune sand stays mostly sand, standing water bare.
 */

export interface GroundLook {
  sand: number;
  earth: number;
  rockA: number;
  rockB: number;
  gravel: number;
  /** Metres per texture repeat: sand, earth, rock, gravel. */
  scale: [number, number, number, number];
}

export type GroundTheme = 'dust' | 'salt' | 'cinder';

/** Palettes for the three wasteland legs: warm dust, bleached salt, black cinder. */
const THEMES: Record<GroundTheme, Partial<GroundLook>> = {
  dust: {},
  salt: { sand: 0xe6dccb, earth: 0xc8bba6, rockA: 0xb48a76, rockB: 0xd8c2b0, gravel: 0xa89e92 },
  cinder: { sand: 0x6e6256, earth: 0x4e4640, rockA: 0x3a3230, rockB: 0x62514a, gravel: 0x403c3a },
};

export const GROUND_LOOK: Record<'wasteland' | 'city', GroundLook> = {
  wasteland: { sand: 0xd6bd93, earth: 0xae9879, rockA: 0x8a5a40, rockB: 0xb08c6c, gravel: 0x8e8478, scale: [4.5, 4.2, 9, 1.7] },
  city: { sand: 0x9a9286, earth: 0x77797a, rockA: 0x6e6f6c, rockB: 0x8c8b86, gravel: 0x6f6b66, scale: [5, 5.5, 8, 3] },
};

/** Living ground: fresh green, olive and yellow-green grass, dry straw at the edge of the green, leaf litter and moss. */
const LIVING = { grassA: 0x5d8a30, grassB: 0x6e7a38, grassC: 0x8f9c3a, straw: 0xb6a26a, litter: 0x5e4a33, moss: 0x415e27 };

const VERT_PARS = /* glsl */ `
attribute vec4 splat;
attribute vec4 tdata;
varying vec4 vSplat;
varying vec4 vTData;
varying vec3 vWPos;
varying vec3 vWNrm;
`;

const VERT_MAIN = /* glsl */ `
vSplat = splat;
vTData = tdata;
vWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vWNrm = normalize( mat3( modelMatrix ) * objectNormal );
`;

const FRAG_PARS = /* glsl */ `
varying vec4 vSplat;
varying vec4 vTData;
varying vec3 vWPos;
varying vec3 vWNrm;
uniform sampler2D tTA;
uniform sampler2D tTB;
uniform sampler2D tTAN;
uniform sampler2D tTBN;
uniform sampler2D tMacro;
uniform vec3 cSand;
uniform vec3 cEarth;
uniform vec3 cRockA;
uniform vec3 cRockB;
uniform vec3 cGravel;
uniform vec4 uTScale;
uniform sampler2D tMeadow;
uniform vec3 cGrassA;
uniform vec3 cGrassB;
uniform vec3 cGrassC;
uniform vec3 cStraw;
uniform vec3 cLitter;
uniform vec3 cMoss;
${WET_PARS}
#ifdef TERRAIN_LOD
uniform sampler2D tLoaded;
uniform vec4 uLoadedRect;
#endif
`;

const FRAG_COLOR = /* glsl */ `
#ifdef TERRAIN_LOD
{
  // The far mesh steps aside wherever a detailed chunk is loaded.
  vec2 lc = ( vWPos.xz - uLoadedRect.xy ) / uLoadedRect.zw;
  if ( lc.x >= 0.0 && lc.y >= 0.0 && lc.x < 1.0 && lc.y < 1.0 && texture2D( tLoaded, lc ).r > 0.5 ) discard;
}
#endif
vec3 tWn = normalize( vWNrm );
vec2 tXZ = vWPos.xz;
vec4 tMac = texture2D( tMacro, tXZ * ( 1.0 / 420.0 ) );
vec4 tMac2 = texture2D( tMacro, tXZ * ( 1.0 / 73.0 ) );
vec4 tSA = texture2D( tTA, tXZ * uTScale.x );
vec4 tEA = texture2D( tTA, tXZ * uTScale.y + vec2( 0.37, 0.61 ) );
vec4 tBig = texture2D( tTA, tXZ * uTScale.y * 0.27 + vec2( 0.11, 0.83 ) );
vec4 tGA = texture2D( tTB, tXZ * uTScale.w + vec2( 0.53, 0.29 ) );
// Triplanar rock only where rock is present.
vec3 tRW = abs( tWn );
tRW = tRW * tRW * tRW;
tRW /= dot( tRW, vec3( 1.0 ) );
float tRockAlb = 0.5;
float tRockH = 0.5;
vec2 tRockNX = vec2( 0.0 );
vec2 tRockNY = vec2( 0.0 );
vec2 tRockNZ = vec2( 0.0 );
if ( vSplat.z > 0.01 ) {
  vec3 rp = vWPos * uTScale.z;
  vec4 rx = texture2D( tTB, vec2( rp.z, rp.y ) );
  vec4 ry = texture2D( tTB, rp.xz );
  vec4 rz = texture2D( tTB, vec2( rp.x, rp.y ) );
  tRockAlb = rx.r * tRW.x + ry.r * tRW.y + rz.r * tRW.z;
  tRockH = rx.g * tRW.x + ry.g * tRW.y + rz.g * tRW.z;
  tRockNX = texture2D( tTBN, vec2( rp.z, rp.y ) ).rg * 2.0 - 1.0;
  tRockNY = texture2D( tTBN, rp.xz ).rg * 2.0 - 1.0;
  tRockNZ = texture2D( tTBN, vec2( rp.x, rp.y ) ).rg * 2.0 - 1.0;
}
// Height-sharpened blend.
vec4 tH = vec4( tSA.g, tEA.a, tRockH, tGA.a );
vec4 tW = vSplat;
vec4 tT = tW + tH * 0.65 * step( 0.002, tW );
float tMx = max( max( tT.x, tT.y ), max( tT.z, tT.w ) );
vec4 tB = max( tT - tMx + 0.22, 0.0 ) * step( 0.002, tW );
tB /= max( dot( tB, vec4( 1.0 ) ), 1e-4 );
float tBand = smoothstep( 0.2, 0.8, sin( vWPos.y * 0.3 + tMac.b * 7.0 + tMac2.r * 3.0 ) * 0.5 + 0.5 ) * 0.7 + tMac2.a * 0.3;
// Fade strata contrast with distance so far slopes don't read as contour lines.
tBand = mix( tBand, 0.5 + ( tMac.g - 0.5 ) * 0.5, smoothstep( 120.0, 420.0, length( vViewPosition ) ) );
vec3 tRockC = mix( cRockA, cRockB, tBand ) * ( tRockAlb * 1.35 );
vec3 tCol = cSand * ( tSA.r * 1.12 ) * tB.x
  + cEarth * ( mix( tEA.b, tBig.r * 0.85 + 0.12, 0.3 ) * 1.18 ) * tB.y
  + tRockC * tB.z
  + cGravel * ( tGA.b * 1.3 ) * tB.w;
tCol *= 0.8 + tMac.r * 0.4;
tCol *= mix( vec3( 1.0 ), vec3( 1.07, 0.99, 0.9 ), tMac2.g );
// Living ground.
float tLive = 0.0;
float tWood = 0.0;
if ( vTData.z > 0.003 ) {
  vec4 tM1 = texture2D( tMeadow, tXZ * 0.62 );
  vec4 tM2 = texture2D( tMeadow, tXZ * 0.151 + vec2( 0.31, 0.77 ) );
  float tL = vTData.z;
  vec3 tGr = mix( cGrassA, cGrassB, smoothstep( 0.3, 0.75, tMac2.r * 0.7 + tM2.g * 0.5 ) );
  tGr = mix( tGr, cGrassC, smoothstep( 0.55, 0.85, tMac.b + ( tM2.g - 0.5 ) * 0.3 ) * 0.7 );
  tGr = mix( cStraw, tGr, smoothstep( 0.22, 0.62, tL + ( tMac2.g - 0.5 ) * 0.3 ) );
  tGr *= 0.55 + tM1.r * 0.75;
  // The wood floor: leaf litter, with moss where it is damp or hollow.
  vec3 tFl = mix( cLitter * ( 0.45 + tM1.b * 0.9 ), cMoss * ( 0.7 + tM1.r * 0.5 ), smoothstep( 0.45, 0.75, tM2.g + vTData.y * 0.5 + ( 1.0 - vTData.x ) * 0.4 ) );
  tWood = smoothstep( 0.12, 0.6, vTData.w );
  vec3 tLiv = mix( tGr, tFl, tWood );
  float tMat = tM1.a * 0.6 + tM2.a * 0.4;
  tLive = smoothstep( 0.4, 0.62, tL * 1.3 + ( tMat - 0.5 ) * 0.45 + ( tMac2.a - 0.5 ) * 0.3 );
  tLive *= ( 1.0 - tB.z ) * ( 1.0 - tB.w * 0.85 ) * ( 1.0 - tB.x * 0.55 ) * ( 1.0 - smoothstep( 0.55, 0.8, vTData.y ) );
  tCol = mix( tCol, tLiv, tLive );
}
tCol *= mix( 1.0, 0.5, vTData.y );
// Rain: the whole ground darkens, and the low spots fill with puddles. The shore stays glassy whatever the weather.
// Grass drinks the rain: few puddles stand in a meadow.
float tFlat = smoothstep( 0.88, 0.97, tWn.y ) * ( 1.0 - tB.z ) * ( 1.0 - tLive * 0.8 );
float tPud = max( puddleMask( tXZ, tFlat ), smoothstep( 0.45, 0.8, vTData.y ) * tFlat * 0.85 );
tCol *= mix( 1.0, 0.62, uWet * 0.55 );
tCol *= mix( 1.0, 0.5, tPud );
diffuseColor.rgb = tCol * vColor.rgb;
float tCavity = mix( mix( 1.0, 0.65 + 0.35 * dot( tH, tB ), 0.8 ), 0.85, tLive ) * ( 1.0 - tWood * tLive * 0.22 );
`;

const FRAG_ROUGH = /* glsl */ `
float roughnessFactor = mix( clamp( mix( dot( tB, vec4( 0.96, 0.9, 0.82, 0.88 ) ), 0.93, tLive ) - vTData.y * 0.45 - uWet * 0.25, 0.2, 1.0 ), 0.04, tPud );
`;

const FRAG_METAL = /* glsl */ `
float metalnessFactor = 0.0;
`;

const FRAG_NORMAL = /* glsl */ `
{
  vec2 nS = texture2D( tTAN, tXZ * uTScale.x ).rg * 2.0 - 1.0;
  vec2 nE = texture2D( tTAN, tXZ * uTScale.y + vec2( 0.37, 0.61 ) ).ba * 2.0 - 1.0;
  vec2 nG = texture2D( tTBN, tXZ * uTScale.w + vec2( 0.53, 0.29 ) ).ba * 2.0 - 1.0;
  // Cracks and ripples go quiet under the grass.
  vec2 nP = ( nS * tB.x * 0.9 + nE * tB.y * 0.75 + nG * tB.w ) * ( 1.0 - tLive );
  vec3 wn = tWn + vec3( nP.x, 0.0, nP.y ) * 0.9;
  if ( tB.z > 0.001 ) {
    vec3 rpert = vec3( 0.0, tRockNX.y, tRockNX.x ) * tRW.x + vec3( tRockNY.x, 0.0, tRockNY.y ) * tRW.y + vec3( tRockNZ.x, tRockNZ.y, 0.0 ) * tRW.z;
    wn += rpert * tB.z * 1.2;
  }
  normal = normalize( ( viewMatrix * vec4( normalize( wn ), 0.0 ) ).xyz );
  // Standing water is flat.
  normal = normalize( mix( normal, nonPerturbedNormal, tPud ) );
}
`;

const FRAG_AO = /* glsl */ `
{
  float ambientOcclusion = vTData.x * tCavity;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
  #endif
}
`;

export interface TerrainUniforms {
  tLoaded: { value: THREE.Texture | null };
  uLoadedRect: { value: THREE.Vector4 };
}

/** Terrain material for a biome. `lod` adds the hole-punching used by the far landscape mesh. */
export function makeTerrainMaterial(biome: 'wasteland' | 'city', lod?: TerrainUniforms, theme: GroundTheme = 'dust'): THREE.MeshStandardMaterial {
  const look = { ...GROUND_LOOK[biome], ...(biome === 'wasteland' ? THEMES[theme] : {}) };
  const tex = terrainTextures();
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  const col = (hex: number) => ({ value: new THREE.Color(hex) });
  const uniforms = {
    tTA: { value: tex.a },
    tTB: { value: tex.b },
    tTAN: { value: tex.an },
    tTBN: { value: tex.bn },
    tMacro: { value: macroTexture() },
    cSand: col(look.sand),
    cEarth: col(look.earth),
    cRockA: col(look.rockA),
    cRockB: col(look.rockB),
    cGravel: col(look.gravel),
    uTScale: { value: new THREE.Vector4(1 / look.scale[0], 1 / look.scale[1], 1 / look.scale[2], 1 / look.scale[3]) },
    uWet: GLOBALS.uWet,
    tMeadow: { value: meadowTexture() },
    cGrassA: col(LIVING.grassA),
    cGrassB: col(LIVING.grassB),
    cGrassC: col(LIVING.grassC),
    cStraw: col(LIVING.straw),
    cLitter: col(LIVING.litter),
    cMoss: col(LIVING.moss),
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    if (lod) Object.assign(shader.uniforms, lod);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <project_vertex>', `${VERT_MAIN}\n#include <project_vertex>`);
    shader.fragmentShader = (lod ? '#define TERRAIN_LOD\n' : '') +
      shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
        .replace('#include <color_fragment>', FRAG_COLOR)
        .replace('#include <roughnessmap_fragment>', FRAG_ROUGH)
        .replace('#include <metalnessmap_fragment>', FRAG_METAL)
        .replace('#include <normal_fragment_maps>', FRAG_NORMAL)
        .replace('#include <aomap_fragment>', FRAG_AO);
  };
  m.customProgramCacheKey = () => `terrain:${lod ? 'lod' : 'near'}`;
  return m;
}

// ------------------------------------------------------------------------------------------ road

const ROAD_VERT_PARS = /* glsl */ `
attribute vec3 rtan;
varying vec2 vRUv;
varying vec3 vRTan;
varying vec3 vRWPos;
`;

const ROAD_VERT_MAIN = /* glsl */ `
vRUv = uv;
vRTan = rtan;
vRWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;

const ROAD_FRAG_PARS = /* glsl */ `
varying vec2 vRUv;
varying vec3 vRTan;
varying vec3 vRWPos;
uniform sampler2D tRoad;
uniform sampler2D tRoadS;
uniform sampler2D tMacroR;
uniform vec3 cDust;
uniform float uDust;
${WET_PARS}
#ifdef TERRAIN_LOD
uniform sampler2D tLoaded;
uniform vec4 uLoadedRect;
#endif
`;

const ROAD_COLOR = /* glsl */ `
vec4 rMac = texture2D( tMacroR, vRWPos.xz * ( 1.0 / 61.0 ) );
vec4 rFine = texture2D( tMacroR, vRWPos.xz * ( 1.0 / 3.1 ) );
// Crumbling edges: the strip runs a little past the paint and breaks up into the shoulder.
float rEdge = min( vRUv.x, 1.0 - vRUv.x );
if ( rEdge < ( rFine.g - 0.62 ) * 0.09 + ( rMac.a - 0.5 ) * 0.03 ) discard;
vec2 rUv = vec2( clamp( vRUv.x, 0.003, 0.997 ), vRUv.y );
vec4 rAlb = texture2D( tRoad, rUv );
vec4 rSrf = texture2D( tRoadS, rUv );
// Wind-blown dust: heavier at the edges and in drifts across the lanes.
float rDust = smoothstep( 0.1, 0.0, rEdge ) * 0.9 + smoothstep( 0.62, 0.86, rMac.b + rFine.r * 0.25 ) * 0.75;
rDust = clamp( rDust * uDust * ( 0.55 + rFine.g * 0.6 ), 0.0, 1.0 );
diffuseColor.rgb = mix( rAlb.rgb * ( 0.92 + rMac.r * 0.16 ), cDust * ( 0.8 + rFine.b * 0.35 ), rDust );
float rCav = rSrf.a;
float rPud = puddleMask( vRWPos.xz, 1.0 - rDust * 0.6 );
diffuseColor.rgb *= mix( 1.0, 0.62, uWet * 0.55 ) * mix( 1.0, 0.5, rPud );
`;

const ROAD_ROUGH = /* glsl */ `
float roughnessFactor = mix( clamp( mix( rSrf.b, 0.97, rDust ) - uWet * 0.3, 0.25, 1.0 ), 0.04, rPud );
`;

const ROAD_NORMAL = /* glsl */ `
{
  vec3 rN = normal;
  vec3 rT = normalize( ( viewMatrix * vec4( vRTan, 0.0 ) ).xyz );
  vec3 rB = normalize( cross( rN, rT ) );
  vec2 rn = ( rSrf.rg * 2.0 - 1.0 ) * ( 1.0 - rDust * 0.7 );
  normal = normalize( mix( rN + rT * rn.x * 1.1 - rB * rn.y * 1.1, nonPerturbedNormal, rPud ) );
}
`;

const ROAD_AO = /* glsl */ `
{
  float ambientOcclusion = 0.7 + 0.3 * rCav;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
}
`;

/** The far road ribbons (see farDetail) step aside wherever a detailed chunk is fully built. */
const ROAD_LOD = /* glsl */ `
#ifdef TERRAIN_LOD
{
  vec2 lc = ( vRWPos.xz - uLoadedRect.xy ) / uLoadedRect.zw;
  if ( lc.x >= 0.0 && lc.y >= 0.0 && lc.x < 1.0 && lc.y < 1.0 && texture2D( tLoaded, lc ).g > 0.5 ) discard;
}
#endif
`;

/** Road material for a biome. `lod` makes the far variant, which is cut away over chunks drawn in detail. */
export function makeRoadMaterial(biome: 'wasteland' | 'city', lod?: TerrainUniforms): THREE.MeshStandardMaterial {
  const rt = roadTextures(biome);
  const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  const uniforms = {
    tRoad: { value: rt.map },
    tRoadS: { value: rt.surface },
    tMacroR: { value: macroTexture() },
    cDust: { value: new THREE.Color(biome === 'city' ? 0x6f6a62 : 0xc4a57c) },
    uDust: { value: biome === 'city' ? 0.45 : 1 },
    uWet: GLOBALS.uWet,
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    if (lod) Object.assign(shader.uniforms, lod);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${ROAD_VERT_PARS}`)
      .replace('#include <project_vertex>', `${ROAD_VERT_MAIN}\n#include <project_vertex>`);
    shader.fragmentShader = (lod ? '#define TERRAIN_LOD\n' : '') +
      shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${ROAD_FRAG_PARS}`)
        .replace('#include <color_fragment>', ROAD_LOD + ROAD_COLOR)
        .replace('#include <roughnessmap_fragment>', ROAD_ROUGH)
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
        .replace('#include <normal_fragment_maps>', ROAD_NORMAL)
        .replace('#include <aomap_fragment>', ROAD_AO);
  };
  m.customProgramCacheKey = () => (lod ? 'road:lod' : 'road');
  return m;
}

/** Metres covered by one repeat of the road texture along the road. */
export const ROAD_REPEAT = 32;

// ------------------------------------------------------------------------------------------ paving

const PAVE_FRAG = /* glsl */ `
vec2 pP = vRWPos.xz / 1.5;
vec2 pF = fract( pP );
vec2 pI = floor( pP );
float pJ = 1.0 - smoothstep( 0.0, 0.022, min( min( pF.x, 1.0 - pF.x ), min( pF.y, 1.0 - pF.y ) ) );
vec3 p3 = fract( vec3( pI.xyx ) * 0.1031 );
p3 += dot( p3, p3.yzx + 33.33 );
float pTone = fract( ( p3.x + p3.y ) * p3.z );
vec4 pMac = texture2D( tMacroR, vRWPos.xz * ( 1.0 / 23.0 ) );
float pCrack = 1.0 - texture2D( tRoad, vRWPos.xz * vec2( 0.08, 0.02 ) ).r * 2.5;
vec3 pCol = vec3( 0.48, 0.47, 0.44 ) * ( 0.86 + pTone * 0.18 ) * ( 1.0 - pJ * 0.45 );
pCol *= 0.8 + pMac.r * 0.35;
pCol = mix( pCol, pCol * 0.55, smoothstep( 0.62, 0.8, pMac.b ) * 0.6 );
diffuseColor.rgb = pCol;
float rCav = 1.0 - pJ;
float rDust = 0.0;
float rPud = puddleMask( vRWPos.xz, 1.0 );
diffuseColor.rgb *= mix( 1.0, 0.62, uWet * 0.55 ) * mix( 1.0, 0.5, rPud );
vec4 rSrf = vec4( 0.5, 0.5, 0.88 - pJ * 0.1 - smoothstep( 0.7, 0.85, pMac.b ) * 0.4, 1.0 );
`;

/** Concrete sidewalk slabs (1.5 m), with joints, per-slab tone, grime and damp patches. */
export function makePavingMaterial(): THREE.MeshStandardMaterial {
  const rt = roadTextures('city');
  const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  const uniforms = {
    tRoad: { value: rt.surface },
    tRoadS: { value: rt.surface },
    tMacroR: { value: macroTexture() },
    cDust: { value: new THREE.Color(0x6f6a62) },
    uDust: { value: 0 },
    uWet: GLOBALS.uWet,
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${ROAD_VERT_PARS}`)
      .replace('#include <project_vertex>', `${ROAD_VERT_MAIN}\n#include <project_vertex>`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${ROAD_FRAG_PARS}`)
      .replace('#include <color_fragment>', PAVE_FRAG)
      .replace('#include <roughnessmap_fragment>', ROAD_ROUGH)
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
      .replace('#include <normal_fragment_maps>', `{
  vec3 dpdx = dFdx( - vViewPosition );
  vec3 dpdy = dFdy( - vViewPosition );
  float hh = -pJ * 0.01;
  float dhx = dFdx( hh );
  float dhy = dFdy( hh );
  vec3 r1 = cross( dpdy, normal );
  vec3 r2 = cross( normal, dpdx );
  float det = dot( dpdx, r1 );
  normal = normalize( abs( det ) * normal - sign( det ) * ( dhx * r1 + dhy * r2 ) );
}`)
      .replace('#include <aomap_fragment>', ROAD_AO);
  };
  m.customProgramCacheKey = () => 'paving';
  return m;
}
