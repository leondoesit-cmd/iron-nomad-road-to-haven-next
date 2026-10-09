import * as THREE from 'three';
import { GLOBALS, WET_PARS } from './materials';
import { GROUND_LAYERS, macroTexture, meadowTexture, roadTextures, terrainTextures } from './proctex';
import { detailTexture, flatDetail, REL } from './photoTex';
import { COPLANAR, DEPTH_UNIFORMS, PULL, coplanarOffset, depthPullGlsl } from './depth';
import { DISSOLVE_NOISE } from './dissolve';

/**
 * Ground shading from twelve photo-scanned materials (`GROUND_LAYERS`, one texture-array layer each). The four ground
 * weights per vertex (sand, earth, rock, gravel) each split into two looks that drift over the land in patches tens to
 * hundreds of metres across: wind-rippled and coarse gravelly sand; cracked hardpan and dusty stony ground (on slopes
 * mostly); layered beds and cracked boulder rock; gravel and rounded wadi pebbles (in the wet mostly). Wet earth by the
 * water turns to mud. Every material that is present is sampled once, and their weights are sharpened by the materials'
 * own height maps over a soft margin, so one gives way to the next along its stones, cracks and grains, and the edges
 * wander with a noise of their own instead of following the 2 m mesh. Rock is projected triplanar so cliffs show strata,
 * not stretching. Each scan keeps its own colour variation around a palette mean, so the themes still recolour the land.
 * Per-vertex `tdata` carries ambient occlusion (x), wetness (y), how lush the land is (z, `lushAt`) and how wooded (w,
 * `forestAt`): lush ground turns to scanned grass in drifts of fresh green, olive and yellow-green that dry to withered
 * straw at the edge of the green and fray into the dust along the grass's own height; under the woods it is leaf litter
 * with moss where it is damp. Rock stays rock, gravel shoulders and tracks stay worn, dune sand stays mostly sand, standing
 * water bare. Normal detail fades out with distance, where it would be smaller than a pixel, and so do its fetches.
 */

export interface GroundLook {
  sand: number;
  earth: number;
  rockA: number;
  rockB: number;
  gravel: number;
  /** Metres per texture repeat of each ground layer (`GROUND_LAYERS`) when it is procedural. */
  scale: number[];
  /** The same for the photo scans (`photoTex.ts`), set from their real sizes. */
  photoScale: number[];
}

export type GroundTheme = 'dust' | 'salt' | 'cinder';

/** Palettes for the three wasteland legs: warm dust, bleached salt, black cinder. */
const THEMES: Record<GroundTheme, Partial<GroundLook>> = {
  dust: {},
  salt: { sand: 0xe6dccb, earth: 0xc8bba6, rockA: 0xb48a76, rockB: 0xd8c2b0, gravel: 0xa89e92 },
  cinder: { sand: 0x6e6256, earth: 0x4e4640, rockA: 0x3a3230, rockB: 0x62514a, gravel: 0x403c3a },
};

export const GROUND_LOOK: Record<'wasteland' | 'city', GroundLook> = {
  // Photo scales, layer by layer: the beach scan is 30 m of ripples, shrunk to desert wind ripples about 20 cm apart; the
  // gravelly sand, the stony trail and the pebbles are their real 2-2.5 m; the baked ground is its real 4 m; the 1.8 m cliff
  // and 2.5 m weathered rock scans are enlarged so their beds and grain read at hillside scale; the gravel is its real 2.25 m;
  // grass, dry grass and leaves their real 2-2.3 m; the 1.3 m mud a little larger, so it repeats less.
  wasteland: {
    sand: 0xd6bd93, earth: 0xae9879, rockA: 0x8a5a40, rockB: 0xb08c6c, gravel: 0x8e8478,
    scale: [4.5, 4.5, 4.2, 4.2, 9, 9, 1.7, 1.7, 1.6, 1.6, 1.6, 3],
    photoScale: [9, 2.5, 4, 2, 6, 6.5, 2.25, 2, 2, 2, 2.3, 1.6],
  },
  city: {
    sand: 0x9a9286, earth: 0x77797a, rockA: 0x6e6f6c, rockB: 0x8c8b86, gravel: 0x6f6b66,
    scale: [5, 5, 5.5, 5.5, 8, 8, 3, 3, 1.6, 1.6, 1.6, 3],
    photoScale: [9, 2.5, 4.5, 2, 6, 6.5, 2.6, 2, 2, 2, 2.3, 1.6],
  },
};

/** Living ground: fresh green, olive and yellow-green grass, dry straw at the edge of the green, leaf litter and moss. */
const LIVING = { grassA: 0x5d8a30, grassB: 0x6e7a38, grassC: 0x8f9c3a, straw: 0xb6a26a, litter: 0x7a6446, moss: 0x4a6a2c };

const VERT_PARS = /* glsl */ `
#ifndef TERRAIN_DEFORM
attribute vec4 splat;
attribute vec4 tdata;
#endif
varying vec4 vSplat;
varying vec4 vTData;
varying vec3 vWPos;
varying vec3 vWNrm;
`;

const VERT_MAIN = /* glsl */ `
#ifdef TERRAIN_DEFORM
vSplat = dSplat;
vTData = dTData;
#else
vSplat = splat;
vTData = tdata;
#endif
vWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vWNrm = normalize( mat3( modelMatrix ) * objectNormal );
`;

/**
 * A tile of the loose ground's fine height field (`render/groundDeform.ts`), drawn in place of one 2 m cell of the ground
 * mesh. The grid is instanced: `position` is (column, skirt, row) on a 50-vertex grid, `aTile` the tile's corner and its
 * layer. The cell's own corners (heights, normals, colours, ground weights, `tdata`) come from `tDeformBase`, one row per
 * layer, and are spread over the grid on the same two triangles as the mesh, so an untouched tile is the cell exactly;
 * `tDeform` holds the field's height and turned soil per vertex, with a ring of the neighbours' for the normals.
 */
const DEFORM_VERT_PARS = /* glsl */ `
attribute vec3 aTile;
uniform highp sampler2DArray tDeform;
uniform highp sampler2D tDeformBase;
uniform vec4 uDeformSun;
varying vec4 vDeform;
varying float vLoose;
varying float vCrack;
vec3 dPos;
vec3 dNrm;
vec3 dCol;
vec4 dSplat;
vec4 dTData;
vec4 dBase( int k, int s ) { return texelFetch( tDeformBase, ivec2( k, s ), 0 ); }
void deformTile() {
  int s = int( aTile.z + 0.5 );
  ivec2 g = ivec2( position.xz + 0.5 );
  float u = float( g.x ) * ( 1.0 / DEFORM_N );
  float v = float( g.y ) * ( 1.0 / DEFORM_N );
  // The mesh splits a cell into (a, d, e) and (a, e, b): the weights of a, b, d and e here.
  vec4 w = v > u ? vec4( 1.0 - v, 0.0, v - u, u ) : vec4( 1.0 - u, u - v, 0.0, v );
  vec4 t1 = dBase( 1, s );
  vec4 t2 = dBase( 2, s );
  vec4 t3 = dBase( 3, s );
  vec3 nb = w.x * t1.xyz + w.y * vec3( t1.w, t2.xy ) + w.z * vec3( t2.zw, t3.x ) + w.w * t3.yzw;
  vec4 t4 = dBase( 4, s );
  vec4 t5 = dBase( 5, s );
  vec4 t6 = dBase( 6, s );
  dCol = w.x * t4.xyz + w.y * vec3( t4.w, t5.xy ) + w.z * vec3( t5.zw, t6.x ) + w.w * t6.yzw;
  dSplat = w.x * dBase( 7, s ) + w.y * dBase( 8, s ) + w.z * dBase( 9, s ) + w.w * dBase( 10, s );
  dTData = w.x * dBase( 11, s ) + w.y * dBase( 12, s ) + w.z * dBase( 13, s ) + w.w * dBase( 14, s );
  ivec3 c = ivec3( g + DEFORM_HALO, s );
  vec2 here = texelFetch( tDeform, c, 0 ).rg;
  float hl = texelFetch( tDeform, c - ivec3( 1, 0, 0 ), 0 ).r;
  float hr = texelFetch( tDeform, c + ivec3( 1, 0, 0 ), 0 ).r;
  float hd = texelFetch( tDeform, c - ivec3( 0, 1, 0 ), 0 ).r;
  float hu = texelFetch( tDeform, c + ivec3( 0, 1, 0 ), 0 ).r;
  // The cell's own slope, plus the field's: an untouched tile keeps the mesh's normals exactly.
  dNrm = normalize( vec3( nb.x / nb.y - ( hr - hl ) * ( 0.5 / DEFORM_CELL ), 1.0, nb.z / nb.y - ( hu - hd ) * ( 0.5 / DEFORM_CELL ) ) );
  // Skirts hang a little under the tile's edges, so a neighbour drawn coarser never shows a crack.
  dPos = vec3( aTile.x + u * DEFORM_SIZE, dot( w, dBase( 0, s ) ) + here.r - position.y * 0.25, aTile.y + v * DEFORM_SIZE );
  // Hollows (the floor of a rut, a crater) gather shade; turned soil shows fresh, charred soil black, loose soil (a berm,
  // a spill) paler than the pressed floor of a rut, a broken crust in plates. They come packed as one whole number:
  // turned + 64 x charred + 4096 x loose + 262144 x cracked, each 0..63.
  float lap = ( hl + hr + hd + hu - 4.0 * here.r ) * ( 1.0 / ( DEFORM_CELL * DEFORM_CELL ) );
  float gv = here.g;
  float kq = floor( gv * ( 1.0 / 262144.0 ) + 1e-5 );
  gv -= kq * 262144.0;
  float lo = floor( gv * ( 1.0 / 4096.0 ) + 1e-4 );
  gv -= lo * 4096.0;
  float ch = floor( gv * ( 1.0 / 64.0 ) + 0.002 );
  // The field's own shadows: walk toward the sun over the tile's heights; a berm or a crater's rim higher than the sun
  // above this vertex shades it.
  float occ = -1.0;
  if ( uDeformSun.w > 0.0 ) {
    vec2 cf = vec2( c.xy );
    for ( int k = 1; k <= DEFORM_HALO; k ++ ) {
      ivec2 q = ivec2( floor( cf + uDeformSun.xy * float( k ) + 0.5 ) );
      float hk = texelFetch( tDeform, ivec3( q, s ), 0 ).r;
      occ = max( occ, ( hk - here.r ) / ( float( k ) * DEFORM_CELL ) - uDeformSun.z );
    }
  }
  vDeform = vec4( ( gv - ch * 64.0 ) * ( 1.0 / 63.0 ), 1.0 - clamp( lap * 0.006, 0.0, 0.4 ), ch * ( 1.0 / 63.0 ), 1.0 - uDeformSun.w * smoothstep( 0.0, 0.25, occ ) );
  vLoose = lo * ( 1.0 / 63.0 );
  vCrack = kq * ( 1.0 / 63.0 );
}
`;

const L = GROUND_LAYERS.length;

const FRAG_PARS = /* glsl */ `
#ifdef TERRAIN_DEFORM
varying vec4 vDeform;
varying float vLoose;
varying float vCrack;
vec2 dHash2( vec2 p ) {
  p = vec2( dot( p, vec2( 127.1, 311.7 ) ), dot( p, vec2( 269.5, 183.3 ) ) );
  return fract( sin( p ) * 43758.5453 );
}
// The plates a crust breaks into: Voronoi cells one unit across. Returns the distance to the nearest crack between plates
// (in cell units) and the plate's own random pair.
vec3 dPlates( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 mg = vec2( 0.0 );
  vec2 mr = vec2( 0.0 );
  float md = 8.0;
  for ( int y = -1; y <= 1; y ++ ) {
    for ( int x = -1; x <= 1; x ++ ) {
      vec2 g = vec2( float( x ), float( y ) );
      vec2 r = g + dHash2( i + g ) * 0.85 + 0.075 - f;
      float d = dot( r, r );
      if ( d < md ) {
        md = d;
        mr = r;
        mg = g;
      }
    }
  }
  float e = 8.0;
  for ( int y = -1; y <= 1; y ++ ) {
    for ( int x = -1; x <= 1; x ++ ) {
      vec2 g = mg + vec2( float( x ), float( y ) );
      vec2 r = g + dHash2( i + g ) * 0.85 + 0.075 - f;
      vec2 dr = r - mr;
      if ( dot( dr, dr ) > 1e-5 ) e = min( e, dot( 0.5 * ( mr + r ), normalize( dr ) ) );
    }
  }
  return vec3( e, dHash2( i + mg + 17.0 ) );
}
#endif
varying vec4 vSplat;
varying vec4 vTData;
varying vec3 vWPos;
varying vec3 vWNrm;
uniform sampler2DArray tGCol;
uniform sampler2DArray tGNrm;
uniform float uLScale[ ${L} ];
uniform vec3 uLTint[ ${L} ];
uniform sampler2D tMacro;
uniform vec3 cSand;
uniform vec3 cEarth;
uniform vec3 cRockA;
uniform vec3 cRockB;
uniform vec3 cGravel;
uniform sampler2D tMeadow;
uniform vec3 cGrassA;
uniform vec3 cGrassB;
uniform vec3 cGrassC;
uniform vec3 cStraw;
uniform vec3 cLitter;
uniform vec3 cMoss;
#define REL ${REL.toFixed(3)}
${WET_PARS}
#ifdef TERRAIN_LOD
uniform sampler2D tLoaded;
uniform vec4 uLoadedRect;
${DISSOLVE_NOISE}
#endif
// A layer's texture coordinates: world metres at its scale, its own offset (so no two scans' repeats line up), a wander.
vec2 gUv( int l, vec2 p, vec2 warp ) { return p * uLScale[ l ] + warp + vec2( float( l ) * 0.37, float( l ) * 0.61 ); }
// Triplanar (rock): the three projections by weight, skipping any that barely shows.
vec4 gTriCol( int l, vec3 w, vec2 warp, vec3 tw ) {
  float k = uLScale[ l ];
  vec2 o = vec2( float( l ) * 0.37, float( l ) * 0.61 ) + warp;
  vec4 c = vec4( 0.0 );
  float s = 0.0;
  if ( tw.x > 0.02 ) { c += texture( tGCol, vec3( w.zy * k + o, float( l ) ) ) * tw.x; s += tw.x; }
  if ( tw.y > 0.02 ) { c += texture( tGCol, vec3( w.xz * k + o, float( l ) ) ) * tw.y; s += tw.y; }
  if ( tw.z > 0.02 ) { c += texture( tGCol, vec3( w.xy * k + o, float( l ) ) ) * tw.z; s += tw.z; }
  return c / max( s, 1e-4 );
}
vec3 gTriNrm( int l, vec3 w, vec2 warp, vec3 tw ) {
  float k = uLScale[ l ];
  vec2 o = vec2( float( l ) * 0.37, float( l ) * 0.61 ) + warp;
  vec3 n = vec3( 0.0 );
  if ( tw.x > 0.02 ) {
    vec2 a = texture( tGNrm, vec3( w.zy * k + o, float( l ) ) ).rg * 2.0 - 1.0;
    n += vec3( 0.0, a.y, a.x ) * tw.x;
  }
  if ( tw.y > 0.02 ) {
    vec2 b = texture( tGNrm, vec3( w.xz * k + o, float( l ) ) ).rg * 2.0 - 1.0;
    n += vec3( b.x, 0.0, b.y ) * tw.y;
  }
  if ( tw.z > 0.02 ) {
    vec2 c = texture( tGNrm, vec3( w.xy * k + o, float( l ) ) ).rg * 2.0 - 1.0;
    n += vec3( c.x, c.y, 0.0 ) * tw.z;
  }
  return n;
}
// Two looks of one material, b's share v, sharpened by their heights: returns the mix and the share b ends up with.
vec4 gPair( vec4 a, vec4 b, float v, out float share ) {
  float ta = ( 1.0 - v ) + a.a * 0.5;
  float tb = v + b.a * 0.5;
  float m = max( ta, tb );
  float wa = max( ta - m + 0.25, 0.0 );
  float wb = max( tb - m + 0.25, 0.0 );
  share = wb / max( wa + wb, 1e-4 );
  return mix( a, b, share );
}
`;

const FRAG_COLOR = /* glsl */ `
#ifdef TERRAIN_LOD
{
  // The far mesh steps aside wherever a detailed chunk is in, dissolving out as its ground dissolves in (dissolve.ts).
  vec2 lc = ( vWPos.xz - uLoadedRect.xy ) / uLoadedRect.zw;
  if ( lc.x >= 0.0 && lc.y >= 0.0 && lc.x < 1.0 && lc.y < 1.0 && inDissolveNoise() < texture2D( tLoaded, lc ).r ) discard;
}
#endif
vec3 tWn = normalize( vWNrm );
vec2 tXZ = vWPos.xz;
float tDist = length( vViewPosition );
vec4 tMac = texture2D( tMacro, tXZ * ( 1.0 / 420.0 ) );
vec4 tMac2 = texture2D( tMacro, tXZ * ( 1.0 / 73.0 ) );
vec4 tMac3 = texture2D( tMacro, tXZ * ( 1.0 / 13.0 ) + vec2( 0.53, 0.17 ) );
// A slow wander of every layer's coordinates, so the repeats of a small scan never fall into rows. Rock wanders only over
// hundreds of metres: its larger scans would visibly swirl at the ground's rate.
vec2 tWarp = ( tMac2.ba - 0.5 ) * 0.35;
vec2 tWarpR = ( tMac.ba - 0.5 ) * 1.5;
vec3 tRW = abs( tWn );
tRW = tRW * tRW * tRW;
tRW /= dot( tRW, vec3( 1.0 ) );
// The edges between materials wander a few metres either way of where the mesh puts them.
vec4 tW = vSplat * ( 0.5 + tMac3 );
// Second looks, in drifts: coarse gravelly sand among the rippled; dusty stony ground among the cracked pans, and on
// slopes; weathered rock among the beds, in drifts and in bands up a cliff, as strata would lie; rounded wadi pebbles in
// drifts and wherever the gravel is wet.
float tVS = smoothstep( 0.4, 0.62, tMac.a * 0.6 + tMac2.b * 0.4 );
float tVE = smoothstep( 0.42, 0.6, tMac.g * 0.45 + tMac2.r * 0.55 + ( 1.0 - tWn.y ) * 1.8 );
float tVR = smoothstep( 0.4, 0.6, tMac.r * 0.3 + tMac2.a * 0.2 + ( sin( vWPos.y * 0.33 + tMac2.r * 3.0 ) * 0.5 + 0.5 ) * 0.5 );
float tVG = max( smoothstep( 0.42, 0.6, tMac.b * 0.55 + tMac2.g * 0.45 ), smoothstep( 0.3, 0.65, vTData.y ) );
// Wet earth by the water is mud.
float tMudK = smoothstep( 0.3, 0.7, vTData.y );
// Each material where it can show: its look, or its two looks height-blended by their share (a second look's colour carries
// its own cast; the shares are kept for the relief). Rock is triplanar. A look is fetched only where it can win through the
// height blend: under 1/8 of a share (gPair's margin) it never does, and a material more than 0.9 behind the strongest
// never shows over the height blend below either.
float tWx = max( max( tW.x, tW.y ), max( tW.z, tW.w ) ) - 0.9;
// Far off, where a scan's grain is under a pixel, the minor look of a pair is fetched only near an even share and stands in
// as its mean colour elsewhere: the drifts keep their colours, the fetches go.
float tFar = smoothstep( 110.0, 190.0, tDist );
float tLo = mix( 0.125, 0.4, tFar );
float tHi = mix( 0.875, 0.6, tFar );
vec4 tCS = vec4( REL, REL, REL, 0.5 );
vec4 tCE = tCS;
vec4 tCR = tCS;
vec4 tCG = tCS;
float tShS = 0.0;
float tShE = 0.0;
float tShM = 0.0;
float tShR = 0.0;
float tShG = 0.0;
if ( tW.x > max( 0.004, tWx ) ) {
  vec4 a = tCS;
  vec4 b = vec4( REL * uLTint[ 1 ], 0.5 );
  if ( tVS < tHi ) a = texture( tGCol, vec3( gUv( 0, tXZ, tWarp ), 0.0 ) );
  if ( tVS > tLo ) { b = texture( tGCol, vec3( gUv( 1, tXZ, tWarp ), 1.0 ) ); b.rgb *= uLTint[ 1 ]; }
  tCS = gPair( a, b, tVS, tShS );
}
if ( tW.y > max( 0.004, tWx ) ) {
  vec4 a = tCE;
  vec4 b = vec4( REL * uLTint[ 3 ], 0.5 );
  if ( tVE < tHi ) a = texture( tGCol, vec3( gUv( 2, tXZ, tWarp ), 2.0 ) );
  if ( tVE > tLo ) { b = texture( tGCol, vec3( gUv( 3, tXZ, tWarp ), 3.0 ) ); b.rgb *= uLTint[ 3 ]; }
  tCE = gPair( a, b, tVE, tShE );
  if ( tMudK > 0.004 ) {
    vec4 m = vec4( REL * uLTint[ 11 ], 0.5 );
    if ( tMudK > tLo ) {
      m = texture( tGCol, vec3( gUv( 11, tXZ, tWarp ), 11.0 ) );
      m.rgb *= uLTint[ 11 ];
    }
    tCE = gPair( tCE, m, tMudK, tShM );
  }
}
if ( tW.z > max( 0.004, tWx ) ) {
  vec4 a = tCR;
  vec4 b = vec4( REL * uLTint[ 5 ], 0.5 );
  if ( tVR < tHi ) a = gTriCol( 4, vWPos, tWarpR, tRW );
  if ( tVR > tLo ) { b = gTriCol( 5, vWPos, tWarpR, tRW ); b.rgb *= uLTint[ 5 ]; }
  tCR = gPair( a, b, tVR, tShR );
}
if ( tW.w > max( 0.004, tWx ) ) {
  vec4 a = tCG;
  vec4 b = vec4( REL * uLTint[ 7 ], 0.5 );
  if ( tVG < tHi ) a = texture( tGCol, vec3( gUv( 6, tXZ, tWarp ), 6.0 ) );
  if ( tVG > tLo ) { b = texture( tGCol, vec3( gUv( 7, tXZ, tWarp ), 7.0 ) ); b.rgb *= uLTint[ 7 ]; }
  tCG = gPair( a, b, tVG, tShG );
}
// The four materials sharpened by height over a soft margin, so one gives way to the next along its grains and cracks.
vec4 tH = vec4( tCS.a, tCE.a, tCR.a, tCG.a );
vec4 tT = tW + tH * 0.6 * step( max( 0.004, tWx ), tW );
float tMx = max( max( tT.x, tT.y ), max( tT.z, tT.w ) );
vec4 tB = max( tT - tMx + 0.3, 0.0 ) * step( max( 0.004, tWx ), tW );
tB /= max( dot( tB, vec4( 1.0 ) ), 1e-4 );
float tHgt = dot( tH, tB );
float tBand = smoothstep( 0.2, 0.8, sin( vWPos.y * 0.3 + tMac.b * 7.0 + tMac2.r * 3.0 ) * 0.5 + 0.5 ) * 0.7 + tMac2.a * 0.3;
// Fade strata contrast with distance so far slopes don't read as contour lines.
tBand = mix( tBand, 0.5 + ( tMac.g - 0.5 ) * 0.5, smoothstep( 120.0, 420.0, tDist ) );
vec3 tRockC = mix( cRockA, cRockB, tBand ) * 0.81;
// Palette means, the scans' variation about them.
vec3 tCol = ( cSand * 0.93 * tCS.rgb * tB.x + cEarth * 0.944 * tCE.rgb * tB.y + tRockC * tCR.rgb * tB.z + cGravel * 0.91 * tCG.rgb * tB.w ) * ( 1.0 / REL );
tCol *= 0.8 + tMac.r * 0.4;
tCol *= mix( vec3( 1.0 ), vec3( 1.07, 0.99, 0.9 ), tMac2.g );
// Living ground.
float tLive = 0.0;
float tWood = 0.0;
if ( vTData.z > 0.003 ) {
  vec4 tM2 = texture2D( tMeadow, tXZ * 0.151 + vec2( 0.31, 0.77 ) );
  vec4 tGs = texture( tGCol, vec3( gUv( 8, tXZ, tWarp ), 8.0 ) );
  vec4 tDs = texture( tGCol, vec3( gUv( 9, tXZ, tWarp ), 9.0 ) );
  float tL = vTData.z;
  vec3 tGr = mix( cGrassA, cGrassB, smoothstep( 0.3, 0.75, tMac2.r * 0.7 + tM2.g * 0.5 ) );
  tGr = mix( tGr, cGrassC, smoothstep( 0.55, 0.85, tMac.b + ( tM2.g - 0.5 ) * 0.3 ) * 0.7 );
  tGr *= tGs.rgb * ( 0.92 / REL );
  // Dry straw at the edge of the green, giving way to it along the two scans' heights.
  tGr = mix( cStraw * tDs.rgb * ( 0.95 / REL ), tGr, smoothstep( 0.22, 0.62, tL + ( tMac2.g - 0.5 ) * 0.3 + ( tGs.a - tDs.a ) * 0.15 ) );
  // The wood floor: leaf litter, with moss where it is damp or hollow. Its edge is drawn by the leaves and the grass
  // between them, wandering a few metres either way, rather than a line round the trees.
  vec4 tLs = vec4( REL, REL, REL, 0.5 );
  if ( vTData.w > 0.01 ) tLs = texture( tGCol, vec3( gUv( 10, tXZ, tWarp ), 10.0 ) );
  tWood = smoothstep( 0.08, 0.75, vTData.w + ( tLs.a - tGs.a ) * 0.3 + ( tM2.b - 0.5 ) * 0.3 ) * step( 0.01, vTData.w );
  vec3 tFl = mix( cLitter * tLs.rgb * ( 0.9 / REL ), cMoss * tGs.rgb * ( 0.95 / REL ), smoothstep( 0.45, 0.75, tM2.g + vTData.y * 0.5 + ( 1.0 - vTData.x ) * 0.4 ) );
  vec3 tLiv = mix( tGr, tFl, tWood );
  // The green frays into the dust along the grass's (or the litter's) own height.
  float tMat = mix( tGs.a, tLs.a, tWood ) * 0.6 + tM2.a * 0.4;
  tLive = smoothstep( 0.4, 0.62, tL * 1.3 + ( tMat - 0.5 ) * 0.45 + ( tMac2.a - 0.5 ) * 0.3 );
  tLive *= ( 1.0 - tB.z ) * ( 1.0 - tB.w * 0.85 ) * ( 1.0 - tB.x * 0.55 ) * ( 1.0 - smoothstep( 0.55, 0.8, vTData.y ) );
  tCol = mix( tCol, tLiv, tLive );
}
#ifdef TERRAIN_DEFORM
// Soil turned over or thrown on top: the surface's pebbles, grit and crust are buried or blown off, so the scans' grain
// gives way to the plain soil, each look at its mean colour. Fully under a millimetre or two of thrown soil (a crater's
// rim, the sprinkle round it), partly where a tyre or a boot pressed it.
float tCover = smoothstep( 0.0, 0.2, vLoose );
// Rock chipped is fresh stone through and through: it shows more of it than turned soil does.
float tPlainK = max( vDeform.x * mix( 0.45, 0.9, tB.z ), tCover ) * ( 1.0 - tLive );
if ( tPlainK > 0.003 ) {
  // Rock broken fresh is paler than its weathered face, crushed to a pale flour where the round struck.
  vec3 tFresh = mix( tRockC, vec3( dot( tRockC, vec3( 0.333 ) ) ), 0.2 ) * 1.5;
  vec3 tPlain = cSand * 0.93 * mix( vec3( 1.0 ), uLTint[ 1 ], tVS ) * tB.x
    + cEarth * 0.944 * mix( mix( vec3( 1.0 ), uLTint[ 3 ], tVE ), uLTint[ 11 ], tMudK ) * tB.y
    + tFresh * mix( vec3( 1.0 ), uLTint[ 5 ], tVR ) * tB.z
    + cGravel * 0.91 * mix( vec3( 1.0 ), uLTint[ 7 ], tVG ) * tB.w;
  tPlain *= ( 0.8 + tMac.r * 0.4 ) * mix( vec3( 1.0 ), vec3( 1.07, 0.99, 0.9 ), tMac2.g );
  tCol = mix( tCol, tPlain, tPlainK );
  tHgt = mix( tHgt, 0.5, tPlainK );
}
// A dry crust broken round a blow: shattered into small plates by the hole, fading out with the cracks running into the
// whole crust; the cracks thin and wandering, each plate knocked a little askew, and here and there one knocked out to
// the damp soil under it. Only where the earth is drawn with its crust (not its stony look), and different wherever it
// lands: the plates are the world's, not a stamp.
float tPx = length( fwidth( vWPos.xz ) );
float tCrk = vCrack * tB.y * ( 1.0 - tVE ) * ( 1.0 - tLive );
vec2 tPlate = vec2( 0.5 );
if ( tCrk > 0.05 ) {
  vec2 q = vWPos.xz * 26.0;
  q += 0.24 * vec2( sin( q.y * 1.7 + sin( q.x * 0.9 ) * 2.0 ), sin( q.x * 1.9 + sin( q.y * 1.1 ) * 2.0 ) );
  vec3 pf = dPlates( q );
  float on = smoothstep( 0.2, 0.75, tCrk );
  float ff = tPx * 26.0 * 1.3;
  float wf = 0.018 + 0.03 * on;
  float line = ( 1.0 - smoothstep( wf - ff, wf + ff, pf.x ) ) * on * min( 1.0, wf / max( ff, 1e-4 ) );
  tPlate = pf.yz;
  float gone = 1.0 - step( 0.32 * smoothstep( 0.55, 1.0, tCrk ), pf.y );
  tCol *= 1.0 + ( tPlate.x - 0.5 ) * 0.2 * on;
  tCol *= mix( 1.0, 0.6, gone );
  tCol *= 1.0 - 0.55 * line;
  tCrk = on * ( 1.0 - gone );
}
#endif
// Damp ground by standing water: only the narrow band the water laps at (see groundMix), never the open sand.
tCol *= mix( 1.0, 0.5, vTData.y );
// Rain: hard ground (rock, packed earth, clay, gravel) goes dark and glossy and its flat hollows fill with puddles. Sand
// drinks the rain as it lands and stays the colour it was; grass hides the wet and drinks the puddles.
float tWetG = uWet * ( 1.0 - tB.x * 0.92 ) * ( 1.0 - tLive * 0.6 );
float tFlat = smoothstep( 0.88, 0.97, tWn.y ) * ( 1.0 - tB.z ) * ( 1.0 - tLive * 0.8 ) * ( 1.0 - smoothstep( 0.15, 0.5, tB.x ) );
float tPud = max( puddleMask( tXZ, tFlat ), smoothstep( 0.45, 0.8, vTData.y ) * tFlat * 0.85 );
tCol *= mix( 1.0, 0.6, tWetG * 0.6 );
tCol *= mix( 1.0, 0.5, tPud );
diffuseColor.rgb = tCol * vColor.rgb;
#ifdef TERRAIN_DEFORM
// Soil a tyre or a boot has pressed: a shade darker (packed, and the damp under the crust) and plainer. Loose soil pushed
// up beside it, or thrown, dries pale.
// Crushed dry earth thrown round a hole is paler still (its dust); rock is not darkened, it is fresh.
diffuseColor.rgb *= ( 1.0 - 0.2 * vDeform.x * ( 1.0 - tCover ) * ( 1.0 - tLive * 0.5 ) * ( 1.0 - tB.z ) ) * ( 1.0 + ( 0.08 + 0.1 * tB.y + 0.05 * tB.w ) * tCover );
// Soot of a blast, in streaks.
diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.035, 0.03, 0.026 ), vDeform.z * 0.85 );
#endif
float tCavity = mix( mix( 1.0, 0.65 + 0.35 * tHgt, 0.8 ), 0.85, tLive ) * ( 1.0 - tWood * tLive * 0.12 );
`;

const FRAG_ROUGH = /* glsl */ `
float roughnessFactor = mix( clamp( mix( dot( tB, vec4( 0.96, 0.9, 0.82, 0.88 ) ) - tB.y * tShM * 0.15, 0.93, tLive ) - vTData.y * 0.45 - tWetG * 0.4, 0.2, 1.0 ), 0.04, tPud );
`;

const FRAG_METAL = /* glsl */ `
float metalnessFactor = 0.0;
`;

const FRAG_NORMAL = /* glsl */ `
{
  vec3 wn = tWn;
  // Relief fades out by 220 m, where it is under a pixel, and its fetches with it.
  float tNK = 1.0 - smoothstep( 110.0, 220.0, tDist );
  if ( tNK > 0.0 ) {
    // Only the materials and looks that show (a sliver of one at the edge of another adds no relief worth its fetches),
    // mixed by the same shares as their colours.
    vec2 nP = vec2( 0.0 );
    vec3 rP = vec3( 0.0 );
    if ( tB.x > 0.06 ) {
      vec2 n = vec2( 0.0 );
      if ( tShS < 0.97 ) n += ( texture( tGNrm, vec3( gUv( 0, tXZ, tWarp ), 0.0 ) ).rg * 2.0 - 1.0 ) * ( 1.0 - tShS );
      if ( tShS > 0.03 ) n += ( texture( tGNrm, vec3( gUv( 1, tXZ, tWarp ), 1.0 ) ).rg * 2.0 - 1.0 ) * tShS;
      nP += n * ( tB.x * 0.8 );
    }
    if ( tB.y > 0.06 ) {
      vec2 n = vec2( 0.0 );
      float kA = ( 1.0 - tShE ) * ( 1.0 - tShM );
      float kB = tShE * ( 1.0 - tShM );
      if ( kA > 0.03 ) n += ( texture( tGNrm, vec3( gUv( 2, tXZ, tWarp ), 2.0 ) ).rg * 2.0 - 1.0 ) * ( kA * 0.9 );
      if ( kB > 0.03 ) n += ( texture( tGNrm, vec3( gUv( 3, tXZ, tWarp ), 3.0 ) ).rg * 2.0 - 1.0 ) * kB;
      if ( tShM > 0.03 ) n += ( texture( tGNrm, vec3( gUv( 11, tXZ, tWarp ), 11.0 ) ).rg * 2.0 - 1.0 ) * tShM;
      nP += n * ( tB.y * 0.8 );
    }
    if ( tB.z > 0.06 ) {
      if ( tShR < 0.97 ) rP += gTriNrm( 4, vWPos, tWarpR, tRW ) * ( 1.0 - tShR );
      if ( tShR > 0.03 ) rP += gTriNrm( 5, vWPos, tWarpR, tRW ) * tShR;
      rP *= tB.z * 1.2;
    }
    if ( tB.w > 0.06 ) {
      vec2 n = vec2( 0.0 );
      if ( tShG < 0.97 ) n += ( texture( tGNrm, vec3( gUv( 6, tXZ, tWarp ), 6.0 ) ).rg * 2.0 - 1.0 ) * ( 1.0 - tShG );
      if ( tShG > 0.03 ) n += ( texture( tGNrm, vec3( gUv( 7, tXZ, tWarp ), 7.0 ) ).rg * 2.0 - 1.0 ) * tShG;
      nP += n * ( tB.w * 0.9 );
    }
    // Under the grass the ground's relief goes quiet and the grass's (or the litter's) takes over.
    nP *= 1.0 - tLive;
    #ifdef TERRAIN_DEFORM
    // A tyre or a boot wipes out the wind ripples and the grain it rolls over; thrown soil buries them.
    nP *= 1.0 - 0.8 * max( vDeform.x * 0.875, tCover );
    // The plates of a broken crust each lie at their own tilt.
    nP += ( tPlate - 0.5 ) * 0.45 * tCrk;
    #endif
    if ( tLive > 0.02 ) {
      int lv = tWood > 0.5 ? 10 : 8;
      nP += ( texture( tGNrm, vec3( gUv( lv, tXZ, tWarp ), float( lv ) ) ).rg * 2.0 - 1.0 ) * ( tLive * 0.7 );
    }
    wn += ( vec3( nP.x, 0.0, nP.y ) * 0.9 + rP ) * tNK;
  }
  normal = normalize( ( viewMatrix * vec4( normalize( wn ), 0.0 ) ).xyz );
  // Standing water is flat.
  normal = normalize( mix( normal, nonPerturbedNormal, tPud ) );
}
`;

const FRAG_AO = /* glsl */ `
{
  float ambientOcclusion = vTData.x * tCavity;
  #ifdef TERRAIN_DEFORM
  ambientOcclusion *= vDeform.y;
  // In the shadow of its own berm or rim, the sun does not reach it.
  reflectedLight.directDiffuse *= vDeform.w;
  reflectedLight.directSpecular *= vDeform.w;
  #endif
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

/** The fine height field's tiles drawn with the ground's material (`render/groundDeform.ts`). */
export interface DeformUniforms {
  tDeform: { value: THREE.Texture };
  tDeformBase: { value: THREE.Texture };
  /** Toward the sun for the field's own shadows: a texel step (x, z), its height as a slope, and its weight. */
  sun: { value: THREE.Vector4 };
  /** Vertices per tile side less one, metres between them, metres per tile, neighbours' vertices round a layer. */
  n: number;
  cell: number;
  size: number;
  halo: number;
}

/**
 * The ground's palette for a biome and theme, as linear rgb: what sand, earth, rock and gravel are drawn in before the
 * scans' grain and the mesh's tint (for things that take the colour of the ground: clods, chips, dust).
 */
export function terrainPalette(biome: 'wasteland' | 'city', theme: GroundTheme = 'dust') {
  const look = { ...GROUND_LOOK[biome], ...(biome === 'wasteland' ? THEMES[theme] : {}) };
  const c = (hex: number) => {
    const k = new THREE.Color(hex);
    return [k.r, k.g, k.b] as [number, number, number];
  };
  const a = c(look.rockA);
  const b = c(look.rockB);
  // The shader's rock: its two bands half and half, a shade down (`tRockC`).
  const rock: [number, number, number] = [(a[0] + b[0]) * 0.405, (a[1] + b[1]) * 0.405, (a[2] + b[2]) * 0.405];
  const sand = c(look.sand);
  const earth = c(look.earth);
  const gravel = c(look.gravel);
  return {
    sand: [sand[0] * 0.93, sand[1] * 0.93, sand[2] * 0.93] as [number, number, number],
    earth: [earth[0] * 0.944, earth[1] * 0.944, earth[2] * 0.944] as [number, number, number],
    rock,
    gravel: [gravel[0] * 0.91, gravel[1] * 0.91, gravel[2] * 0.91] as [number, number, number],
  };
}

/**
 * Terrain material for a biome. `lod` adds the hole-punching used by the far landscape mesh; `deform` makes the variant the
 * loose ground's deformed tiles are drawn with (same look, its geometry from the field).
 */
export function makeTerrainMaterial(biome: 'wasteland' | 'city', lod?: TerrainUniforms, theme: GroundTheme = 'dust', deform?: DeformUniforms): THREE.MeshStandardMaterial {
  const look = { ...GROUND_LOOK[biome], ...(biome === 'wasteland' ? THEMES[theme] : {}) };
  const tex = terrainTextures();
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  m.userData.terrain = { biome, theme };
  const col = (hex: number) => ({ value: new THREE.Color(hex) });
  const uniforms = {
    tGCol: { value: tex.col },
    tGNrm: { value: tex.nrm },
    uLScale: { value: GROUND_LAYERS.map((_, i) => 1 / (tex.photoLayer[i] ? look.photoScale[i] : look.scale[i])) },
    uLTint: { value: tex.tint },
    tMacro: { value: macroTexture() },
    cSand: col(look.sand),
    cEarth: col(look.earth),
    cRockA: col(look.rockA),
    cRockB: col(look.rockB),
    cGravel: col(look.gravel),
    uWet: GLOBALS.uWet,
    uPuddle: GLOBALS.uPuddle,
    tMeadow: { value: meadowTexture() },
    cGrassA: col(LIVING.grassA),
    cGrassB: col(LIVING.grassB),
    cGrassC: col(LIVING.grassC),
    cStraw: col(LIVING.straw),
    cLitter: col(LIVING.litter),
    cMoss: col(LIVING.moss),
  };
  if (deform) {
    m.defines = { TERRAIN_DEFORM: '', DEFORM_N: deform.n.toFixed(1), DEFORM_CELL: deform.cell.toFixed(4), DEFORM_SIZE: deform.size.toFixed(3), DEFORM_HALO: String(deform.halo) };
  }
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    if (lod) Object.assign(shader.uniforms, lod);
    if (deform) {
      shader.uniforms.tDeform = deform.tDeform;
      shader.uniforms.tDeformBase = deform.tDeformBase;
      shader.uniforms.uDeformSun = deform.sun;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${DEFORM_VERT_PARS}`)
        .replace('#include <uv_vertex>', 'deformTile();\n#include <uv_vertex>')
        .replace('#include <color_vertex>', '#include <color_vertex>\nvColor.rgb = dCol;')
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = dNrm;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = dPos;');
    }
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
  m.customProgramCacheKey = () => `terrain:${lod ? 'lod' : deform ? 'deform' : 'near'}`;
  return m;
}

// ------------------------------------------------------------------------------------------ road

const ROAD_VERT_PARS = /* glsl */ `
attribute vec3 rtan;
// Open-world roads: how many roads this one crosses over (see roadLayer). Missing elsewhere: 0 by the material's default.
attribute float rlayer;
uniform float uPullStep;
varying vec2 vRUv;
varying vec3 vRTan;
varying vec3 vRWPos;
`;

const ROAD_VERT_MAIN = /* glsl */ `
vRUv = uv;
vRTan = rtan;
vRWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;

/**
 * After project_vertex: the road is drawn a hair nearer the eye than it lies, and each road crossing over others nearer
 * again, in proportion to the distance (see depth.ts): the ground and the roads under it never show through, however far.
 */
const ROAD_VERT_PULL = depthPullGlsl(`${PULL.road.toFixed(1)} + rlayer`);

/**
 * A value for an attribute a geometry does not carry. Left unset, a missing attribute reads whatever another program last
 * left in that slot (three only fills in defaults it is given).
 */
function setDefaultAttribute(m: THREE.Material, name: string, v: number) {
  const d = m as THREE.Material & { defaultAttributeValues?: Record<string, number[]> };
  d.defaultAttributeValues = { ...d.defaultAttributeValues, [name]: [v] };
}

/** Hook the road's own vertex code into a standard material's shader. */
function roadVertex(shader: { vertexShader: string; uniforms: Record<string, THREE.IUniform> }) {
  shader.uniforms.uPullStep = DEPTH_UNIFORMS.uPullStep;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${ROAD_VERT_PARS}`)
    .replace('#include <project_vertex>', `${ROAD_VERT_MAIN}\n#include <project_vertex>\n${ROAD_VERT_PULL}`);
}

const ROAD_FRAG_PARS = /* glsl */ `
varying vec2 vRUv;
varying vec3 vRTan;
varying vec3 vRWPos;
uniform sampler2D tRoad;
uniform sampler2D tRoadS;
uniform sampler2D tMacroR;
uniform vec3 cDust;
uniform float uDust;
// Close-up photo detail (photoTex.detailTexture): R albedo around 0.5, B/A normal x/y, sampled in world metres.
uniform sampler2D tDet;
uniform float uDetS;
uniform float uDetK;
${WET_PARS}
#ifdef TERRAIN_LOD
uniform sampler2D tLoaded;
uniform vec4 uLoadedRect;
${DISSOLVE_NOISE}
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
// Rain lays the dust and runs it off the lanes into the verge.
rDust = clamp( rDust * uDust * ( 0.55 + rFine.g * 0.6 ) * ( 1.0 - uWet * 0.75 ), 0.0, 1.0 );
diffuseColor.rgb = mix( rAlb.rgb * ( 0.92 + rMac.r * 0.16 ), cDust * ( 0.8 + rFine.b * 0.35 ), rDust );
vec4 rDet = texture2D( tDet, vRWPos.xz * uDetS );
float rDetK = uDetK * ( 1.0 - rDust * 0.8 );
diffuseColor.rgb *= mix( 1.0, rDet.r * 2.0, rDetK );
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
  vec2 rdn = ( rDet.ba * 2.0 - 1.0 ) * rDetK;
  vec3 rdv = ( viewMatrix * vec4( rdn.x, 0.0, rdn.y, 0.0 ) ).xyz;
  normal = normalize( mix( rN + rT * rn.x * 1.1 - rB * rn.y * 1.1 + rdv, nonPerturbedNormal, rPud ) );
}
`;

const ROAD_AO = /* glsl */ `
{
  float ambientOcclusion = 0.7 + 0.3 * rCav;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
}
`;

/** The far road ribbons (see farDetail) step aside wherever a detailed chunk is fully built, dissolving as it comes in. */
const ROAD_LOD = /* glsl */ `
#ifdef TERRAIN_LOD
{
  vec2 lc = ( vRWPos.xz - uLoadedRect.xy ) / uLoadedRect.zw;
  if ( lc.x >= 0.0 && lc.y >= 0.0 && lc.x < 1.0 && lc.y < 1.0 && inDissolveNoise() < texture2D( tLoaded, lc ).g ) discard;
}
#endif
`;

/** Road material for a biome. `lod` makes the far variant, which is cut away over chunks drawn in detail. */
/** The asphalt and concrete scans, packed once for every road and sidewalk. */
let asphaltDetail: THREE.Texture | null = null;
let concreteDetail: THREE.Texture | null = null;
/** Pack the road and sidewalk scans ahead of the first road (a warm-up step). */
export function warmGroundDetail() {
  asphaltDetail ??= detailTexture('asphalt');
  concreteDetail ??= detailTexture('concrete');
}
const detailUniforms = (set: 'asphalt' | 'concrete', metres: number, k: number) => {
  const tex = set === 'asphalt' ? (asphaltDetail ??= detailTexture('asphalt')) : (concreteDetail ??= detailTexture('concrete'));
  return { tDet: { value: tex ?? flatDetail() }, uDetS: { value: 1 / metres }, uDetK: { value: tex ? k : 0 } };
};

export function makeRoadMaterial(biome: 'wasteland' | 'city', lod?: TerrainUniforms): THREE.MeshStandardMaterial {
  const rt = roadTextures(biome);
  const m = coplanarOffset(new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 }), COPLANAR.ground);
  const uniforms = {
    // The 2.08 m asphalt scan: aggregate, binder and wear the 3 cm road strip cannot hold.
    ...detailUniforms('asphalt', 2.08, 0.75),
    tRoad: { value: rt.map },
    tRoadS: { value: rt.surface },
    tMacroR: { value: macroTexture() },
    cDust: { value: new THREE.Color(biome === 'city' ? 0x6f6a62 : 0xc4a57c) },
    uDust: { value: biome === 'city' ? 0.45 : 1 },
    uWet: GLOBALS.uWet,
    uPuddle: GLOBALS.uPuddle,
  };
  setDefaultAttribute(m, 'rlayer', 0);
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    if (lod) Object.assign(shader.uniforms, lod);
    roadVertex(shader);
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
// Half a worn-concrete scan per slab, from a different spot on each slab so neighbours differ.
vec4 rDet = texture2D( tDet, pF * 0.5 + fract( pI * vec2( 0.37, 0.61 ) ) );
float rDetK = uDetK;
vec3 pCol = vec3( 0.48, 0.47, 0.44 ) * ( 0.86 + pTone * 0.18 ) * ( 1.0 - pJ * 0.45 );
pCol *= mix( 1.0, rDet.r * 2.0, rDetK );
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
  const m = coplanarOffset(new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 }), COPLANAR.ground);
  const uniforms = {
    ...detailUniforms('concrete', 3, 0.8),
    tRoad: { value: rt.surface },
    tRoadS: { value: rt.surface },
    tMacroR: { value: macroTexture() },
    cDust: { value: new THREE.Color(0x6f6a62) },
    uDust: { value: 0 },
    uWet: GLOBALS.uWet,
    uPuddle: GLOBALS.uPuddle,
  };
  setDefaultAttribute(m, 'rlayer', 0);
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    roadVertex(shader);
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
  vec2 rdn = ( rDet.ba * 2.0 - 1.0 ) * rDetK;
  normal = normalize( normal + ( viewMatrix * vec4( rdn.x, 0.0, rdn.y, 0.0 ) ).xyz );
}`)
      .replace('#include <aomap_fragment>', ROAD_AO);
  };
  m.customProgramCacheKey = () => 'paving';
  return m;
}
