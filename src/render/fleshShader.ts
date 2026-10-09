import type * as THREE from 'three';
import { MAX_WOUNDS } from '../sim/flesh';

/**
 * The wounded body's shader pieces, composed into the zombie shader (`zombieRender.ts`) when it is built with `flesh`.
 *
 * Each instance reads one row of `tFlesh` (see `FleshRenderer.write`): the height each limb, the neck and the waist are cut
 * at, which piece of a body this instance is (0 the body itself), how each broken long bone bends, up to two dents, then its
 * wounds. In the vertex shader whatever is on the far side of a cut is squashed onto the cut (the stump's face), or out of
 * existence if it belongs to another part; dents push the skull or chest in; a broken bone bends everything below the break
 * about it, in the pose of the bone it broke in. In the fragment shader each wound eats a hole in the skin (and, as deep as
 * it goes, in the muscle and bone of the anatomy drawn inside, `innards.ts`), rims it with raw meat and fat, soaks the cloth
 * round it and runs blood down from it; a stump's face is drawn as the section through it: bone and marrow, muscle, fat.
 */

/** Texels per row: 11 header texels, then four per wound. */
export const FLESH_HEAD = 11;
export const FLESH_W = FLESH_HEAD + MAX_WOUNDS * 4;

const NOISE = /* glsl */ `
float zfHash( vec3 p ) {
  p = fract( p * 0.3183099 + 0.1 );
  p *= 17.0;
  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}
float zfNoise3( vec3 x ) {
  vec3 i = floor( x );
  vec3 f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( mix( zfHash( i ), zfHash( i + vec3( 1, 0, 0 ) ), f.x ), mix( zfHash( i + vec3( 0, 1, 0 ) ), zfHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
    mix( mix( zfHash( i + vec3( 0, 0, 1 ) ), zfHash( i + vec3( 1, 0, 1 ) ), f.x ), mix( zfHash( i + vec3( 0, 1, 1 ) ), zfHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}
// The axis of a limb (0 left arm, 1 right arm, 2 left leg, 3 right leg) at a height: x and z of it, and the skin radius.
vec3 zfAxis( int chain, float y ) {
  float sx = ( chain == 1 || chain == 3 ) ? -1.0 : 1.0;
  vec3 a0; vec3 a1; vec3 a2; vec3 a3; vec4 rr;
  if ( chain <= 1 ) {
    a0 = vec3( 0.21, 1.42, -0.01 ); a1 = vec3( 0.23, 1.14, 0.0 ); a2 = vec3( 0.23, 0.9, 0.02 ); a3 = vec3( 0.23, 0.77, 0.05 );
    rr = vec4( 0.05, 0.04, 0.03, 0.03 );
  } else {
    a0 = vec3( 0.1, 0.94, 0.0 ); a1 = vec3( 0.11, 0.52, 0.02 ); a2 = vec3( 0.11, 0.12, 0.01 ); a3 = vec3( 0.11, 0.0, 0.04 );
    rr = vec4( 0.078, 0.057, 0.045, 0.05 );
  }
  vec3 p; float r;
  if ( y >= a1.y ) { float t = clamp( ( a0.y - y ) / ( a0.y - a1.y ), 0.0, 1.0 ); p = mix( a0, a1, t ); r = mix( rr.x, rr.y, t ); }
  else if ( y >= a2.y ) { float t = ( a1.y - y ) / ( a1.y - a2.y ); p = mix( a1, a2, t ); r = mix( rr.y, rr.z, t ); }
  else { float t = clamp( ( a2.y - y ) / ( a2.y - a3.y ), 0.0, 1.0 ); p = mix( a2, a3, t ); r = mix( rr.z, rr.w, t ); }
  return vec3( p.x * sx, p.z, r );
}
// Cross-sections of the torso and the skull, as in sim/flesh.ts: half width, half depth, centre z.
const vec4 ZF_TORSO[ 11 ] = vec4[ 11 ]( vec4( 0.85, 0.11, 0.075, 0.0 ), vec4( 0.9, 0.145, 0.1, 0.0 ), vec4( 0.97, 0.145, 0.097, 0.0 ),
  vec4( 1.04, 0.13, 0.085, -0.005 ), vec4( 1.07, 0.122, 0.081, -0.01 ), vec4( 1.18, 0.14, 0.09, -0.02 ), vec4( 1.32, 0.18, 0.105, -0.02 ),
  vec4( 1.4, 0.195, 0.095, -0.02 ), vec4( 1.46, 0.145, 0.065, -0.025 ), vec4( 1.5, 0.05, 0.05, 0.005 ), vec4( 1.58, 0.045, 0.045, 0.025 ) );
const vec4 ZF_SKULL[ 8 ] = vec4[ 8 ]( vec4( 1.58, 0.05, 0.06, 0.03 ), vec4( 1.615, 0.06, 0.075, 0.03 ), vec4( 1.65, 0.08, 0.092, 0.025 ),
  vec4( 1.69, 0.095, 0.095, 0.022 ), vec4( 1.735, 0.098, 0.092, 0.014 ), vec4( 1.785, 0.08, 0.075, 0.006 ), vec4( 1.816, 0.046, 0.044, 0.0 ),
  vec4( 1.83, 0.01, 0.01, 0.0 ) );
vec3 zfTorso( float y ) {
  if ( y <= ZF_TORSO[ 0 ].x ) return ZF_TORSO[ 0 ].yzw;
  for ( int i = 0; i < 10; i++ ) {
    vec4 a = ZF_TORSO[ i ]; vec4 b = ZF_TORSO[ i + 1 ];
    if ( y <= b.x ) return mix( a.yzw, b.yzw, ( y - a.x ) / ( b.x - a.x ) );
  }
  return ZF_TORSO[ 10 ].yzw;
}
vec3 zfSkull( float y ) {
  if ( y <= ZF_SKULL[ 0 ].x ) return ZF_SKULL[ 0 ].yzw;
  for ( int i = 0; i < 7; i++ ) {
    vec4 a = ZF_SKULL[ i ]; vec4 b = ZF_SKULL[ i + 1 ];
    if ( y <= b.x ) return mix( a.yzw, b.yzw, ( y - a.x ) / ( b.x - a.x ) );
  }
  return ZF_SKULL[ 7 ].yzw;
}
`;

/** Vertex declarations, after the zombie's own (`PARS`). */
export const FLESH_PARS_V = /* glsl */ `
uniform highp sampler2D tFlesh;
flat varying int vZfRow;
varying vec3 vZfRest;
varying vec3 vZfRestN;
varying float vZfCap;
flat varying int vZfCapChain;
varying float vZfLayer;
${NOISE}
mat3 zfRotation( vec3 axis, float angle ) {
  float c = cos( angle ); float s = sin( angle ); float t = 1.0 - c;
  vec3 a = axis;
  return mat3( t * a.x * a.x + c, t * a.x * a.y + s * a.z, t * a.x * a.z - s * a.y,
    t * a.x * a.y - s * a.z, t * a.y * a.y + c, t * a.y * a.z + s * a.x,
    t * a.x * a.z + s * a.y, t * a.y * a.z - s * a.x, t * a.z * a.z + c );
}
#ifdef Z_BAKED
// One bone's pose this frame, blended exactly as the skin is (clip A, then B over it by its weight).
mat4 zfBone( int bone ) {
  int a0; int a1; float af;
  zBakedFrames( aAnim.x, aAnim.y, aAnim.z, a0, a1, af );
  mat4 m = zBakedBone( a0, bone ) * ( 1.0 - af ) + zBakedBone( a1, bone ) * af;
  if ( aAnim.w > 0.001 ) {
    int b0; int b1; float bf;
    zBakedFrames( aMotion.x, aMotion.y, aMotion.z, b0, b1, bf );
    m = m * ( 1.0 - aAnim.w ) + ( zBakedBone( b0, bone ) * ( 1.0 - bf ) + zBakedBone( b1, bone ) * bf ) * aAnim.w;
  }
  return m;
}
#endif
`;

/**
 * Start of the vertex main, before the zombie's own: decides what of this vertex is left after the cuts and moves it there
 * (`zfPos`, `zfNrm`, `zfPart`, `zfPivot`, `zfPivot2` stand in for the attributes in the zombie chunks), dents it, and works
 * out the bend of a broken bone above it.
 */
export const FLESH_PRE = /* glsl */ `
vZfRow = gl_InstanceID;
int zfPart0 = int( aZ.x + 0.5 );
vZfLayer = aZ.w > 99.5 ? aZ.w - 100.0 : 0.0;
vec4 zfC0 = texelFetch( tFlesh, ivec2( 0, vZfRow ), 0 );
vec4 zfC1 = texelFetch( tFlesh, ivec2( 1, vZfRow ), 0 );
int zfMode = int( zfC1.z + 0.5 );
bool zfPiece = zfMode != 0;
int zfRag = int( zfC1.w + 0.5 );
int zfChain = ( zfPart0 == 5 || zfPart0 == 7 ) ? 0 : ( zfPart0 == 6 || zfPart0 == 8 ) ? 1 : ( zfPart0 == 1 || zfPart0 == 3 ) ? 2 : ( zfPart0 == 2 || zfPart0 == 4 ) ? 3 : -1;
float zfLimbCut = zfChain == 0 ? zfC0.x : zfChain == 1 ? zfC0.y : zfChain == 2 ? zfC0.z : zfChain == 3 ? zfC0.w : 0.0;
bool zfRmLimb = zfLimbCut > 0.0 && position.y < zfLimbCut;
// A head taken off at the neck goes whole; a burst or sliced skull loses what is above the cut and keeps the jaw.
bool zfRmNeck = zfC1.x > 0.0 && ( ( zfPart0 == 9 && ( zfC1.x < 1.6 || position.y > zfC1.x ) ) || ( zfPart0 == 0 && position.y > zfC1.x ) );
bool zfRmWaist = zfC1.y > 0.0 && ( ( zfPart0 == 0 && position.y < zfC1.y ) || ( zfPart0 >= 1 && zfPart0 <= 4 ) );
int zfCapBy = -1;
bool zfVanish = false;
if ( !zfPiece ) {
  if ( zfRmWaist ) { if ( zfPart0 == 0 ) zfCapBy = 5; else zfVanish = true; }
  else if ( zfRmNeck ) { if ( zfPart0 == 9 && zfC1.x < 1.6 ) zfVanish = true; else zfCapBy = 4; }
  else if ( zfRmLimb ) zfCapBy = zfChain;
} else {
  int pc = zfMode - 1;
  bool mine = pc == 4 ? zfRmNeck : pc == 5 ? ( zfRmWaist && !zfRmLimb ) : ( zfRmLimb && zfChain == pc );
  if ( !mine ) {
    // The body side of the piece's own cut closes it; a leg already gone from a lower half closes at its old cut.
    bool domain = pc == 4 ? ( zfPart0 == 9 || ( zfPart0 == 0 && zfC1.x < 1.6 ) ) : pc == 5 ? zfPart0 == 0 : zfChain == pc;
    if ( pc == 5 && zfRmWaist && zfRmLimb ) zfCapBy = zfChain;
    else if ( domain ) zfCapBy = pc;
    else zfVanish = true;
  }
}
vec3 zfPos = position;
vec3 zfNrm = normal;
int zfPart = zfPart0;
vec3 zfPivot = aPivot;
vec3 zfPivot2 = aPivot2;
vZfCap = 0.0;
vZfCapChain = -1;
if ( zfVanish ) {
  // Every triangle of it shrinks to one point inside the body: nothing is drawn.
  zfPos = vec3( 0.0, zfPiece ? 0.5 : 1.0, 0.0 );
  zfNrm = vec3( 0.0, 1.0, 0.0 );
} else if ( zfCapBy >= 0 ) {
  float cy = zfCapBy == 0 ? zfC0.x : zfCapBy == 1 ? zfC0.y : zfCapBy == 2 ? zfC0.z : zfCapBy == 3 ? zfC0.w : zfCapBy == 4 ? zfC1.x : zfC1.y;
  vec2 c; vec2 rad;
  if ( zfCapBy < 4 ) { vec3 a = zfAxis( zfCapBy, cy ); c = a.xy; rad = vec2( a.z ); }
  else { vec3 s = ( zfCapBy == 4 && cy >= 1.6 ) ? zfSkull( cy ) : zfTorso( cy ); c = vec2( 0.0, s.z ); rad = s.xy; }
  vec2 d = ( position.xz - c ) / rad;
  float l = length( d );
  if ( l > 0.97 ) d *= 0.97 / l;
  bool ragged = ( ( zfRag >> zfCapBy ) & 1 ) == 1;
  float bump = ragged ? ( zfNoise3( vec3( d * 5.0, cy * 13.0 ) ) - 0.5 ) * 0.04 * ( 1.0 - l * 0.4 ) : 0.0;
  zfPos = vec3( c.x + d.x * rad.x, cy + bump, c.y + d.y * rad.y );
  // The face looks away from what it was cut from: down off a stump, up off a neck, and the other way on the piece.
  float up = zfCapBy == 4 ? 1.0 : -1.0;
  if ( zfPiece ) up = -up;
  zfNrm = vec3( 0.0, up, 0.0 );
  vZfCap = 1.0;
  vZfCapChain = zfCapBy;
  if ( !zfPiece ) {
    // It rides the bone of the part the cut runs through, not the one that came off.
    if ( zfCapBy <= 1 ) zfPart = cy > 1.14 ? 5 + zfCapBy : 7 + zfCapBy;
    else if ( zfCapBy <= 3 ) zfPart = cy > 0.52 ? zfCapBy - 1 : zfCapBy + 1;
    else if ( zfCapBy == 4 ) zfPart = cy < 1.6 ? 0 : 9;
    else zfPart = 0;
  }
  // Pivots of the part it now rides.
  bool zfL = zfPart == 1 || zfPart == 3 || zfPart == 5 || zfPart == 7;
  float zfS = zfL ? 1.0 : -1.0;
  if ( zfPart == 0 ) { zfPivot = vec3( 0.0 ); zfPivot2 = vec3( 0.0 ); }
  else if ( zfPart == 9 ) { zfPivot = vec3( 0.0, 1.54, 0.03 ); zfPivot2 = zfPivot; }
  else if ( zfPart == 1 || zfPart == 2 ) { zfPivot = vec3( 0.1 * zfS, 0.94, 0.0 ); zfPivot2 = zfPivot; }
  else if ( zfPart == 3 || zfPart == 4 ) { zfPivot = vec3( 0.11 * zfS, 0.52, 0.02 ); zfPivot2 = vec3( 0.1 * zfS, 0.94, 0.0 ); }
  else if ( zfPart == 5 || zfPart == 6 ) { zfPivot = vec3( 0.21 * zfS, 1.42, -0.01 ); zfPivot2 = zfPivot; }
  else { zfPivot = vec3( 0.23 * zfS, 1.14, 0.0 ); zfPivot2 = vec3( 0.21 * zfS, 1.42, -0.01 ); }
}
// Dents: a caved-in skull moves only the head, a stove-in chest only the torso.
if ( !zfVanish && ( zfPart0 == 0 || zfPart0 == 9 ) ) {
  for ( int i = 0; i < 2; i++ ) {
    vec4 d0 = texelFetch( tFlesh, ivec2( 6 + i * 2, vZfRow ), 0 );
    vec4 d1 = texelFetch( tFlesh, ivec2( 7 + i * 2, vZfRow ), 0 );
    if ( d0.w <= 0.0 || d1.w <= 0.0 ) continue;
    if ( ( d0.y > 1.55 ) != ( zfPart0 == 9 ) ) continue;
    float k = 1.0 - clamp( length( zfPos - d0.xyz ) / d0.w, 0.0, 1.0 );
    float s = k * k * ( 3.0 - 2.0 * k );
    zfPos -= d1.xyz * d1.w * s;
    // The skin round a dent folds: its normal tips toward the middle.
    zfNrm = normalize( zfNrm + ( zfPos - d0.xyz ) * s * 6.0 * d1.w / max( d0.w, 0.01 ) );
  }
}
vZfRest = zfPos;
vZfRestN = zfNrm;
// A broken long bone: everything of the limb below the break swings about it. The upper bone of the limb wins.
bool zfBent = false;
vec3 zfBP = vec3( 0.0 );
mat3 zfBR = mat3( 1.0 );
if ( zfChain >= 0 && !zfVanish ) {
  vec4 zfB0 = texelFetch( tFlesh, ivec2( 2, vZfRow ), 0 );
  vec4 zfB1 = texelFetch( tFlesh, ivec2( 3, vZfRow ), 0 );
  vec4 zfD0 = texelFetch( tFlesh, ivec2( 4, vZfRow ), 0 );
  vec4 zfD1 = texelFetch( tFlesh, ivec2( 5, vZfRow ), 0 );
  bool arm = zfChain <= 1;
  int side = zfChain == 0 || zfChain == 2 ? 0 : 1;
  float upA = arm ? ( side == 0 ? zfB0.x : zfB0.y ) : ( side == 0 ? zfB1.x : zfB1.y );
  float loA = arm ? ( side == 0 ? zfB0.z : zfB0.w ) : ( side == 0 ? zfB1.z : zfB1.w );
  float upD = arm ? ( side == 0 ? zfD0.x : zfD0.y ) : ( side == 0 ? zfD1.x : zfD1.y );
  float loD = arm ? ( side == 0 ? zfD0.z : zfD0.w ) : ( side == 0 ? zfD1.z : zfD1.w );
  bool upper = upA != 0.0;
  float ang = upper ? upA : loA;
  float at = arm ? ( upper ? 1.28 : 1.02 ) : ( upper ? 0.73 : 0.32 );
  if ( ang != 0.0 && zfPos.y < at ) {
    vec3 ax = zfAxis( zfChain, at );
    vec3 p = vec3( ax.x, at, ax.y );
    vec3 hi = zfAxis( zfChain, at + 0.05 );
    vec3 lo = zfAxis( zfChain, at - 0.05 );
    vec3 bone = normalize( vec3( hi.x - lo.x, 0.1, hi.y - lo.y ) );
    float dir = upper ? upD : loD;
    vec3 swing = vec3( sin( dir ), 0.0, cos( dir ) );
    vec3 axis = normalize( cross( swing, bone ) );
    mat3 r = zfRotation( axis, ang );
    // The bone's segment: which mesh part (and baked bone) the break sits in.
    int part = arm ? ( upper ? 5 + side : 7 + side ) : ( upper ? 1 + side : 3 + side );
    #ifdef Z_BAKED
    if ( !zfPiece ) {
      int bi = part == 1 ? 3 : part == 2 ? 5 : part == 3 ? 4 : part == 4 ? 6 : part == 5 ? 7 : part == 6 ? 9 : part == 7 ? 8 : 10;
      mat4 m = zfBone( bi );
      mat3 m3 = mat3( m );
      zfBP = ( m * vec4( p, 1.0 ) ).xyz;
      zfBR = m3 * r * transpose( m3 );
      zfBent = true;
    } else
    #endif
    {
      // Not skinned (a piece, or the procedural walk): bend it where it lies.
      zfPos = p + r * ( zfPos - p );
      zfNrm = r * zfNrm;
    }
  }
}
`;

/** After the zombie's skin transform (baked) puts the vertex in its pose: the break's bend, in that pose. */
export const FLESH_BEND_POS = /* glsl */ `
if ( zfBent ) transformed = zfBP + zfBR * ( transformed - zfBP );
`;
export const FLESH_BEND_NRM = /* glsl */ `
if ( zfBent ) objectNormal = zfBR * objectNormal;
`;

/** Fragment declarations. */
export const FLESH_PARS_F = /* glsl */ `
uniform highp sampler2D tFlesh;
uniform float uFleshTime;
flat varying int vZfRow;
varying vec3 vZfRest;
varying vec3 vZfRestN;
varying float vZfCap;
flat varying int vZfCapChain;
varying float vZfLayer;
${NOISE}
`;

/**
 * Fragment shading, once the kit has made the surface colour and roughness: the stump faces, the inside of the body seen
 * through a hole, and every wound on this part of it.
 */
export const FLESH_FRAG = /* glsl */ `
{
  vec3 zfP = vZfRest;
  vec3 zfN = normalize( vZfRestN );
  int zfLayer = int( vZfLayer + 0.5 );
  vec3 zfBlood = vec3( 0.2, 0.012, 0.01 );
  float zfWet = 0.0;
  vec3 zfMeat = mix( vec3( 0.38, 0.045, 0.035 ), vec3( 0.58, 0.13, 0.1 ), zfNoise3( zfP * 180.0 ) );
  vec3 zfBone = vec3( 0.86, 0.8, 0.66 ) * ( 0.85 + 0.15 * zfNoise3( zfP * 300.0 ) );
  vec3 zfMarrow = vec3( 0.36, 0.07, 0.05 );
  vec3 zfFat = vec3( 0.72, 0.6, 0.34 );
  if ( vZfCap > 0.5 ) {
    // The face of a cut: what the body is made of, in section.
    int c = vZfCapChain;
    vec4 c0 = texelFetch( tFlesh, ivec2( 0, vZfRow ), 0 );
    vec4 c1 = texelFetch( tFlesh, ivec2( 1, vZfRow ), 0 );
    float cy = c == 0 ? c0.x : c == 1 ? c0.y : c == 2 ? c0.z : c == 3 ? c0.w : c == 4 ? c1.x : c1.y;
    bool ragged = ( ( int( c1.w + 0.5 ) >> c ) & 1 ) == 1;
    float n = zfNoise3( zfP * 70.0 ) - 0.5;
    vec3 col = zfMeat;
    if ( c < 4 ) {
      vec3 a = zfAxis( c, cy );
      float rho = length( zfP.xz - a.xy ) / a.z + ( ragged ? n * 0.3 : n * 0.05 );
      float boneR = c <= 1 ? 0.32 : 0.28;
      // Muscle bundles in section: darker seams between them.
      float seam = smoothstep( 0.02, 0.0, abs( zfNoise3( zfP * 140.0 ) - 0.5 ) );
      vec3 muscle = zfMeat * ( 1.0 - seam * 0.45 );
      col = rho < boneR * 0.5 ? zfMarrow : rho < boneR ? zfBone : rho < 0.84 ? muscle : rho < 0.94 ? zfFat : diffuseColor.rgb;
      if ( ragged && rho < boneR * 1.3 && rho > boneR * 0.8 ) col = mix( col, zfBone, 0.6 );
    } else if ( c == 4 && cy < 1.6 ) {
      // The neck: the spine at the back, the windpipe in front, muscle round them.
      vec2 q = zfP.xz - vec2( 0.0, 0.012 );
      float spine = length( q - vec2( 0.0, -0.014 ) );
      float pipe = length( q - vec2( 0.0, 0.02 ) );
      float rho = length( q ) / 0.046 + n * 0.08;
      col = spine < 0.008 ? zfMarrow : spine < 0.017 ? zfBone : pipe < 0.006 ? vec3( 0.04, 0.008, 0.008 ) : pipe < 0.011 ? vec3( 0.78, 0.62, 0.56 ) : rho < 0.9 ? zfMeat : rho < 0.97 ? zfFat : diffuseColor.rgb;
    } else if ( c == 4 ) {
      // An open skull: a rim of bone round the brain.
      vec3 s = zfSkull( cy );
      float rho = length( ( zfP.xz - vec2( 0.0, s.z ) ) / s.xy ) + ( ragged ? n * 0.35 : 0.0 );
      vec3 brain = mix( vec3( 0.64, 0.44, 0.44 ), vec3( 0.46, 0.22, 0.24 ), zfNoise3( zfP * 120.0 ) );
      brain *= 0.72 + 0.28 * abs( sin( zfNoise3( zfP * 45.0 ) * 15.0 ) );
      col = rho < 0.83 ? brain : rho < 0.95 ? zfBone : diffuseColor.rgb;
    } else {
      // Through the waist: the spine at the back, the gut packed in front, a ring of muscle.
      vec3 s = zfTorso( cy );
      vec2 q = ( zfP.xz - vec2( 0.0, s.z ) ) / s.xy;
      float rho = length( q ) + n * ( ragged ? 0.2 : 0.04 );
      float spine = length( vec2( zfP.x, zfP.z - ( s.z - s.y + 0.032 ) ) );
      float coil = sin( zfP.x * 140.0 + sin( zfP.z * 120.0 ) * 2.0 ) * sin( zfP.z * 150.0 + zfP.x * 40.0 );
      vec3 gut = mix( vec3( 0.74, 0.5, 0.44 ), vec3( 0.4, 0.17, 0.15 ), smoothstep( -0.3, 0.6, coil ) );
      col = spine < 0.011 ? zfMarrow : spine < 0.023 ? zfBone : rho < 0.8 ? ( q.y > -0.4 ? gut : zfMeat ) : rho < 0.9 ? zfMeat : rho < 0.97 ? zfFat : diffuseColor.rgb;
    }
    col = mix( col, zfBlood, ( ragged ? 0.5 : 0.2 ) * smoothstep( 0.35, 0.75, zfNoise3( zfP * 55.0 ) ) );
    diffuseColor.rgb = col;
    zfWet = ragged ? 0.75 : 0.6;
  } else if ( !gl_FrontFacing ) {
    // Inside the body, seen through a hole: dark wet meat.
    diffuseColor.rgb = mix( vec3( 0.07, 0.006, 0.005 ), vec3( 0.2, 0.025, 0.02 ), zfNoise3( zfP * 60.0 ) );
    zfWet = 0.8;
  } else {
    if ( zfLayer == 1 ) {
      // Muscle: long fibres down the limb.
      diffuseColor.rgb *= 0.78 + 0.32 * zfNoise3( vec3( zfP.x * 50.0, zfP.y * 500.0, zfP.z * 50.0 ) );
      zfWet = 0.6;
    } else if ( zfLayer == 2 ) {
      zfWet = 0.3;
    } else if ( zfLayer == 3 ) {
      // Organs are wet; the brain is folded.
      if ( zfP.y > 1.62 ) diffuseColor.rgb *= 0.7 + 0.3 * abs( sin( zfNoise3( zfP * 55.0 ) * 14.0 ) );
      zfWet = 0.95;
    }
    vec4 zfH = texelFetch( tFlesh, ivec2( 10, vZfRow ), 0 );
    int zfCount = int( zfH.x + 0.5 );
    for ( int i = 0; i < ${MAX_WOUNDS}; i++ ) {
      if ( i >= zfCount ) break;
      int x = ${FLESH_HEAD} + i * 4;
      vec4 w0 = texelFetch( tFlesh, ivec2( x, vZfRow ), 0 );
      vec4 w1 = texelFetch( tFlesh, ivec2( x + 1, vZfRow ), 0 );
      vec3 d = zfP - w0.xyz;
      float r = w0.w;
      // Out of reach of it: past its soaked ring and the run of blood below it.
      if ( dot( d, d ) > r * r * 30.0 + ( d.y < 0.0 ? 0.11 : 0.0 ) ) continue;
      if ( dot( zfN, w1.xyz ) < -0.25 ) continue;
      vec4 w2 = texelFetch( tFlesh, ivec2( x + 2, vZfRow ), 0 );
      vec4 w3 = texelFetch( tFlesh, ivec2( x + 3, vZfRow ), 0 );
      int k = int( w1.w + 0.5 );
      float dn = dot( d, w1.xyz );
      vec3 dt = d - w1.xyz * dn;
      float width = r;
      if ( w2.w > 0.0 ) {
        // A cut: distance to the line of it, tapering to its ends.
        float along = clamp( dot( dt, w2.xyz ), -w2.w, w2.w );
        dt -= w2.xyz * along;
        float u = along / w2.w;
        width = r * ( 1.0 - u * u * 0.8 );
      }
      float dist = length( dt ) + abs( dn ) * 0.35;
      float rag = zfNoise3( zfP * 150.0 + w3.z * 31.0 ) - 0.5;
      float rr = width * ( 1.0 + rag * ( k == 2 || k == 3 ? 0.75 : 0.3 ) );
      float depth = w3.x;
      float age = max( 0.0, uFleshTime - w3.y );
      if ( k == 7 ) {
        // A bruise: purple going green at the edges, grazed where the blow scraped.
        float b = smoothstep( rr, rr * 0.25, dist );
        vec3 bruise = mix( vec3( 0.14, 0.05, 0.1 ), vec3( 0.2, 0.15, 0.05 ), smoothstep( 0.3, 0.9, dist / rr ) );
        diffuseColor.rgb = mix( diffuseColor.rgb, bruise, b * 0.8 );
        diffuseColor.rgb = mix( diffuseColor.rgb, zfBlood * 1.7, smoothstep( 0.55, 0.8, zfNoise3( zfP * 90.0 ) ) * b * 0.65 );
        zfWet = max( zfWet, b * 0.3 );
        continue;
      }
      if ( k == 8 ) {
        // Burnt: charred black, crazed and dry.
        float b = smoothstep( rr, rr * 0.3, dist );
        diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.03, 0.022, 0.018 ) * ( 0.6 + zfNoise3( zfP * 120.0 ) ), b * 0.88 );
        continue;
      }
      float core = k == 1 ? 0.55 : k == 2 ? 0.75 : k == 3 ? 0.85 : k == 4 ? 0.55 : k == 5 ? 0.8 : 0.7;
      // As deep as it goes: through the skin, the muscle under it, and the bone under that.
      float cut = zfLayer == 0 ? ( depth > 0.12 ? core : 0.0 ) : zfLayer == 1 ? ( depth > 0.45 ? core * 0.8 : 0.0 ) : zfLayer == 2 ? ( depth > 0.62 ? core * 0.6 : 0.0 ) : 0.0;
      if ( dist < rr * cut ) discard;
      if ( zfLayer == 0 ) {
        // The torn edge: raw meat, a line of yellow fat where a blade went through.
        float lip = smoothstep( rr * ( core + 0.5 ), rr * core, dist );
        float fat = smoothstep( 0.05, 0.35, lip ) * ( 1.0 - smoothstep( 0.4, 0.75, lip ) );
        diffuseColor.rgb = mix( diffuseColor.rgb, mix( zfMeat, zfFat, fat * ( k >= 4 ? 0.65 : 0.25 ) ), lip );
        zfWet = max( zfWet, lip );
      } else if ( zfLayer == 2 && depth > 0.62 ) {
        // Splintered bone round the hole in it.
        float chip = smoothstep( rr * cut * 1.6, rr * cut, dist );
        diffuseColor.rgb = mix( diffuseColor.rgb, zfBlood * 1.4, chip * 0.6 );
      }
      // Blood: soaked round it, and running down from it further the longer it has been open. The edge of the soak
      // wanders slowly; only the torn edge of the hole itself is fine-grained.
      float rs = width * ( 1.0 + ( zfNoise3( zfP * 34.0 + w3.z * 17.0 ) - 0.5 ) * 0.7 );
      float soak = smoothstep( rs * ( 2.3 + depth * 1.5 ), rs * 0.8, dist );
      float fresh = smoothstep( rs * 1.7, rs * 0.7, dist );
      float run = 0.0;
      if ( d.y < 0.0 && depth > 0.05 ) {
        float L = min( 0.34, r * 2.5 + age * 0.06 ) * ( 0.45 + depth );
        float fall = -d.y / max( L, 0.001 );
        vec2 h = d.xz - w1.xz * dot( d.xz, w1.xz );
        float wob = ( zfNoise3( vec3( zfP.y * 28.0, w3.z * 9.0, 0.0 ) ) - 0.5 ) * r * 1.4;
        float wdt = r * ( 0.6 - 0.4 * fall ) * ( 0.7 + 0.6 * zfNoise3( vec3( w3.z * 7.0, zfP.y * 45.0, 1.0 ) ) );
        run = ( 1.0 - smoothstep( wdt * 0.5, wdt, abs( length( h ) + wob * 0.3 ) ) ) * ( 1.0 - smoothstep( 0.6, 1.0, fall ) );
      }
      float blood = max( soak, run ) * ( zfLayer == 0 ? 1.0 : 0.65 );
      // Out at the edge of it the cloth or skin is stained dark with it; near the wound and down the run it is wet blood.
      vec3 stain = diffuseColor.rgb * vec3( 0.4, 0.07, 0.06 ) + vec3( 0.05, 0.0, 0.0 );
      vec3 wet = zfBlood * ( 0.8 + 0.35 * zfNoise3( zfP * 30.0 ) );
      diffuseColor.rgb = mix( diffuseColor.rgb, mix( stain, wet, max( fresh, run ) ), blood * 0.95 );
      zfWet = max( zfWet, max( fresh, run ) * blood );
      // The dark mouth of the hole.
      float mouth = smoothstep( rr * ( core + 0.14 ), rr * core * 0.92, dist ) * step( 0.12, depth );
      diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.05, 0.004, 0.004 ), mouth * 0.75 );
    }
  }
  roughnessFactor = mix( roughnessFactor, 0.2, zfWet * 0.85 );
}
`;

/** Wire the wounded body into a zombie material's shader (called from `ZombieRenderer` when built with `flesh`). */
export function patchFleshFragment(shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${FLESH_PARS_F}`)
    .replace('#include <metalnessmap_fragment>', `${FLESH_FRAG}\n#include <metalnessmap_fragment>`)
    // A cut face is flat to its own normal whichever way its squashed triangles happen to wind.
    .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nif ( vZfCap > 0.5 ) normal = normalize( vNormal );');
}

/** Rename the attributes the zombie chunks read to the flesh stand-ins `FLESH_PRE` computes. */
export function fleshChunk(glsl: string): string {
  return glsl
    .replace('int zp = int( aZ.x + 0.5 );', 'int zp = zfPart;')
    .replace(/\bposition\b/g, 'zfPos')
    .replace(/\bnormal\b/g, 'zfNrm')
    .replace(/\baPivot2\b/g, 'zfPivot2')
    .replace(/\baPivot\b/g, 'zfPivot');
}
